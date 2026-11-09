import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton } from "./photon.ts";

export interface ImageResizeOptions {
	maxWidth?: number; // Default: 2576 (Claude's high-resolution long-edge limit)
	maxHeight?: number; // Default: 2576
	/** Visual-token budget, one token per 28x28 pixel patch. Default: 4784 (Claude's high-resolution tier) */
	maxVisualTokens?: number;
	maxBytes?: number; // Default: 4.5MB of base64 payload (below the 5MB per-image limit on Bedrock and Vertex)
	/**
	 * Lossless PNG is used when it encodes below this size; heavier images, typically photographic ones,
	 * use high-quality JPEG instead. Default: 2MB of base64
	 */
	preferLosslessBelowBytes?: number;
	jpegQuality?: number; // Default: 92
}

export interface ResizedImage {
	data: string; // base64
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

export interface ImageDimensionLimits {
	maxWidth: number;
	maxHeight: number;
	maxVisualTokens: number;
}

/**
 * The most an image is worth sending to Claude: the high-resolution tier (Claude 4.7 and later) downscales
 * anything larger to fit both limits before looking at it. 2576 is a multiple of the 28px patch, so the
 * plain pixel check below equals Claude's padded-edge check.
 */
export const CLAUDE_NATIVE_IMAGE_LIMITS: ImageDimensionLimits = {
	maxWidth: 2576,
	maxHeight: 2576,
	maxVisualTokens: 4784,
};

/**
 * Tag on image resize worker replies. Node can post its own messages on the worker channel
 * (for example `{ "watch:require": [...] }` under `node --watch`), so replies must be identifiable.
 */
export const IMAGE_RESIZE_WORKER_RESPONSE_TYPE = "pi:image-resize-response";

export type ResizeImageWorkerResponse =
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; result: ResizedImage | null }
	| { type: typeof IMAGE_RESIZE_WORKER_RESPONSE_TYPE; error: string };

// 4.5MB of base64 payload. Headroom below the 5MB per-image limit (3.75MB decoded on Bedrock Converse).
export const DEFAULT_MAX_IMAGE_BYTES = 4.5 * 1024 * 1024;

const VISUAL_PATCH_PX = 28;

const DEFAULT_OPTIONS: Required<ImageResizeOptions> = {
	...CLAUDE_NATIVE_IMAGE_LIMITS,
	maxBytes: DEFAULT_MAX_IMAGE_BYTES,
	preferLosslessBelowBytes: 2 * 1024 * 1024,
	jpegQuality: 92,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return {
		data,
		encodedSize: Buffer.byteLength(data, "utf-8"),
		mimeType,
	};
}

/** Visual tokens an image costs Claude: one per 28x28 pixel patch. */
export function countVisualTokens(width: number, height: number): number {
	return Math.ceil(width / VISUAL_PATCH_PX) * Math.ceil(height / VISUAL_PATCH_PX);
}

/** Round half to even, as Claude's server-side resize does at exact .5 ties. */
function roundHalfToEven(value: number): number {
	const floor = Math.floor(value);
	if (value - floor !== 0.5) return Math.round(value);
	return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * The largest aspect-preserving size within the limits, or the original size when it already fits.
 * With CLAUDE_NATIVE_IMAGE_LIMITS this is Anthropic's reference resize rule (binary search along the long
 * edge), so an image resized here is exactly what Claude sees: no second resize server-side, and
 * coordinates the model returns map 1:1 onto it.
 */
export function fitImageDimensions(
	width: number,
	height: number,
	limits: ImageDimensionLimits,
): { width: number; height: number } {
	const fits = (w: number, h: number) =>
		w <= limits.maxWidth && h <= limits.maxHeight && countVisualTokens(w, h) <= limits.maxVisualTokens;
	if (fits(width, height)) return { width, height };

	const landscape = width >= height;
	const longEdge = landscape ? width : height;
	const aspectRatio = landscape ? width / height : height / width;
	const sizeForLongEdge = (edge: number) => {
		const shortEdge = Math.max(roundHalfToEven(edge / aspectRatio), 1);
		return landscape ? { width: edge, height: shortEdge } : { width: shortEdge, height: edge };
	};

	let lo = 1; // always fits
	let hi = longEdge; // never fits
	while (lo + 1 < hi) {
		const mid = Math.floor((lo + hi) / 2);
		const size = sizeForLongEdge(mid);
		if (fits(size.width, size.height)) {
			lo = mid;
		} else {
			hi = mid;
		}
	}
	return sizeForLongEdge(lo);
}

/**
 * Resize an image to fit within the specified dimensions, visual-token budget, and encoded file size.
 * Returns null if the image cannot be resized below maxBytes.
 *
 * Uses Photon (Rust/WASM) for image processing. If Photon is not available,
 * returns null.
 *
 * Images already within every limit are returned untouched. Otherwise, to keep as much of the image as
 * the model can see:
 * 1. Downscale only to the dimension and visual-token limits (Claude's native view by default)
 * 2. Encode as PNG when that stays below preferLosslessBelowBytes
 * 3. Otherwise use high-quality JPEG (stepping down from jpegQuality to 75), or PNG if it fits and is smaller
 * 4. If still too large, progressively reduce dimensions until 1x1
 *
 * Output is PNG or JPEG only: some providers (xAI, llama.cpp) cannot decode WebP, and a stored image
 * a provider rejects would fail every later request in the session.
 */
export async function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = await loadPhoton();
	if (!photon) {
		return null;
	}

	let image: ReturnType<typeof photon.PhotonImage.new_from_byteslice> | undefined;
	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(inputBytes);
		image = applyExifOrientation(photon, rawImage, inputBytes);
		if (image !== rawImage) rawImage.free();

		const originalWidth = image.get_width();
		const originalHeight = image.get_height();
		const format = mimeType.split("/")[1] ?? "png";
		const target = fitImageDimensions(originalWidth, originalHeight, opts);

		// Check if already within all limits (dimensions, visual tokens AND encoded size)
		if (target.width === originalWidth && target.height === originalHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType: mimeType || `image/${format}`,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		const jpegQualities = Array.from(new Set([opts.jpegQuality, 85, 75]))
			.filter((quality) => quality <= opts.jpegQuality)
			.sort((a, b) => b - a);

		function encodeWithinLimits(width: number, height: number): EncodedCandidate | undefined {
			const resized =
				width === originalWidth && height === originalHeight
					? undefined
					: photon!.resize(image!, width, height, photon!.SamplingFilter.Lanczos3);
			const source = resized ?? image!;

			try {
				const lossless = encodeCandidate(source.get_bytes(), "image/png");
				if (lossless.encodedSize < Math.min(opts.maxBytes, opts.preferLosslessBelowBytes)) {
					return lossless;
				}

				for (const quality of jpegQualities) {
					const jpeg = encodeCandidate(source.get_bytes_jpeg(quality), "image/jpeg");
					const best =
						lossless.encodedSize < opts.maxBytes && lossless.encodedSize <= jpeg.encodedSize ? lossless : jpeg;
					if (best.encodedSize < opts.maxBytes) {
						return best;
					}
				}
				return undefined;
			} finally {
				resized?.free();
			}
		}

		let currentWidth = target.width;
		let currentHeight = target.height;

		while (true) {
			const encoded = encodeWithinLimits(currentWidth, currentHeight);
			if (encoded) {
				return {
					data: encoded.data,
					mimeType: encoded.mimeType,
					originalWidth,
					originalHeight,
					width: currentWidth,
					height: currentHeight,
					wasResized: currentWidth !== originalWidth || currentHeight !== originalHeight,
				};
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.85));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.85));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		if (image) {
			image.free();
		}
	}
}
