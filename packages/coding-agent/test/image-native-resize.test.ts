import { describe, expect, it } from "vitest";
import { resizeImage } from "../src/utils/image-resize.ts";
import { CLAUDE_NATIVE_IMAGE_LIMITS, countVisualTokens, fitImageDimensions } from "../src/utils/image-resize-core.ts";
import { loadPhoton } from "../src/utils/photon.ts";

const STANDARD_TIER = { maxWidth: 1568, maxHeight: 1568, maxVisualTokens: 1568 };

async function photon() {
	const module = await loadPhoton();
	if (!module) throw new Error("Photon failed to load");
	return module;
}

/** Deterministic PNG: flat bands (compresses well) or seeded noise (does not). */
async function makePng(width: number, height: number, kind: "bands" | "noise"): Promise<Uint8Array> {
	const p = await photon();
	const pixels = new Uint8Array(width * height * 4);
	let seed = 0x9e3779b9;
	for (let i = 0; i < width * height; i++) {
		if (kind === "noise") {
			seed = (seed * 1664525 + 1013904223) >>> 0;
			pixels[i * 4] = seed & 0xff;
			pixels[i * 4 + 1] = (seed >>> 8) & 0xff;
			pixels[i * 4 + 2] = (seed >>> 16) & 0xff;
		} else {
			const band = Math.floor((i % width) / 40) % 3;
			pixels[i * 4 + band] = 200;
		}
		pixels[i * 4 + 3] = 255;
	}
	const image = new p.PhotonImage(pixels, width, height);
	try {
		return image.get_bytes();
	} finally {
		image.free();
	}
}

describe("fitImageDimensions", () => {
	it("matches Anthropic's reference resize implementation on the standard tier", () => {
		expect(fitImageDimensions(1075, 1520, STANDARD_TIER)).toEqual({ width: 924, height: 1307 });
		expect(fitImageDimensions(1920, 1080, STANDARD_TIER)).toEqual({ width: 1456, height: 819 });
		// The docs' size table prints 1269x952; their reference implementation (the stated source of truth) gives 1270.
		expect(fitImageDimensions(2000, 1500, STANDARD_TIER)).toEqual({ width: 1270, height: 952 });
		expect(fitImageDimensions(3840, 2160, STANDARD_TIER)).toEqual({ width: 1456, height: 819 });
	});

	it("matches Anthropic's reference resize implementation on the high-resolution tier", () => {
		expect(fitImageDimensions(1920, 1080, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 1920, height: 1080 });
		expect(fitImageDimensions(2000, 1500, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 2000, height: 1500 });
		expect(fitImageDimensions(3840, 2160, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 2576, height: 1449 });
		expect(fitImageDimensions(1075, 1520, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 1075, height: 1520 });
	});

	it("keeps more of a Retina screenshot than the old 2000px cap", () => {
		// The 3376x1788 screenshot that broke a P3 thread, and a full-screen 16" MacBook Pro capture.
		expect(fitImageDimensions(3376, 1788, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 2576, height: 1364 });
		expect(fitImageDimensions(3456, 2234, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 2383, height: 1540 });
		expect(fitImageDimensions(1788, 3376, CLAUDE_NATIVE_IMAGE_LIMITS)).toEqual({ width: 1364, height: 2576 });
		expect(countVisualTokens(2576, 1364)).toBeLessThanOrEqual(CLAUDE_NATIVE_IMAGE_LIMITS.maxVisualTokens);
	});

	it("fits a box without the patch rounding when the limits are not Claude's", () => {
		expect(fitImageDimensions(2576, 1364, { maxWidth: 2000, maxHeight: 2000, maxVisualTokens: 4784 })).toEqual({
			width: 2000,
			height: 1059,
		});
	});

	it("counts one visual token per 28x28 patch", () => {
		expect(countVisualTokens(1000, 1000)).toBe(1296);
		expect(countVisualTokens(200, 200)).toBe(64);
	});
});

describe("resizeImage defaults", () => {
	it("downscales only to Claude's native view and keeps the pixels lossless", async () => {
		const p = await photon();
		const source = await makePng(3000, 1500, "bands");
		const result = await resizeImage(source, "image/png");

		expect(result).not.toBeNull();
		expect({ width: result!.width, height: result!.height }).toEqual(
			fitImageDimensions(3000, 1500, CLAUDE_NATIVE_IMAGE_LIMITS),
		);
		expect(result!.wasResized).toBe(true);
		expect(result!.mimeType).toBe("image/png");

		// Lossless: the output decodes to exactly the resampled pixels.
		const original = p.PhotonImage.new_from_byteslice(source);
		const expected = p.resize(original, result!.width, result!.height, p.SamplingFilter.Lanczos3);
		const actual = p.PhotonImage.new_from_byteslice(Buffer.from(result!.data, "base64"));
		try {
			expect(Buffer.from(actual.get_raw_pixels()).equals(Buffer.from(expected.get_raw_pixels()))).toBe(true);
		} finally {
			original.free();
			expected.free();
			actual.free();
		}
	});

	it("uses high-quality JPEG at full size when lossless output would be too heavy", async () => {
		const source = await makePng(400, 300, "noise");
		const inputBase64Size = Math.ceil(source.byteLength / 3) * 4;
		const result = await resizeImage(source, "image/png", {
			maxBytes: inputBase64Size,
			preferLosslessBelowBytes: 1,
		});

		expect(result).not.toBeNull();
		expect(result!.mimeType).toBe("image/jpeg");
		expect(result!.width).toBe(400);
		expect(result!.height).toBe(300);
		expect(result!.wasResized).toBe(false);
		expect(result!.data.length).toBeLessThan(inputBase64Size);
	});

	it("passes an image that already fits through untouched", async () => {
		const source = await makePng(1920, 1080, "bands");
		const result = await resizeImage(source, "image/png");

		expect(result).not.toBeNull();
		expect(result!.wasResized).toBe(false);
		expect(result!.data).toBe(Buffer.from(source).toString("base64"));
	});
});
