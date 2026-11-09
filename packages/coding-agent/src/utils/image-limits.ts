/**
 * Keep every image in an outgoing request within provider limits.
 *
 * Images are fitted to Claude's native resolution when they enter the session,
 * but that alone cannot protect a session: history recorded by older builds,
 * tool and extension images, and limits that depend on the whole request (image
 * count, total payload) are only knowable when the request is built. The
 * session is replayed on every turn, so a single oversized image would fail
 * every request after it. The guard fixes violations in the outgoing copy only;
 * the session keeps the originals.
 *
 * The limits are the strictest common ones (Anthropic on Bedrock and Vertex) and
 * apply to every provider. They are hard limits, so they hold even when
 * `images.autoResize` is off; images within them are never touched.
 */

import { createHash } from "node:crypto";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { processImage } from "./image-process.ts";
import { resizeImage } from "./image-resize.ts";
import { CLAUDE_NATIVE_IMAGE_LIMITS, DEFAULT_MAX_IMAGE_BYTES } from "./image-resize-core.ts";

export interface ImageRequestLimits {
	/** Largest base64 payload per image. */
	maxImageBytes: number;
	/** Hard per-image pixel limit. */
	maxDimension: number;
	/** Past this many images in one request, every image must fit manyImageMaxDimension. */
	manyImageThreshold: number;
	manyImageMaxDimension: number;
	/** Most images one request may carry; older ones beyond it are dropped. */
	maxImagesPerRequest: number;
	/** Most images one provider message may carry (a run of user and tool-result messages between assistant turns); older ones are dropped. */
	maxImagesPerMessage: number;
	/** Total base64 image payload per request. */
	requestImageBudgetBytes: number;
}

export const DEFAULT_IMAGE_REQUEST_LIMITS: ImageRequestLimits = {
	maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
	maxDimension: 8000,
	manyImageThreshold: 20,
	manyImageMaxDimension: 2000,
	// Anthropic allows 100 images per request on 200K-context models and 600 on the rest.
	maxImagesPerRequest: 100,
	// Bedrock Converse accepts at most 20 images in one message's content.
	maxImagesPerMessage: 20,
	// Bedrock caps the whole InvokeModel body at 25,000,000 bytes; leave room for text, tools, and JSON.
	requestImageBudgetBytes: 16 * 1024 * 1024,
};

/** Over the payload budget, the newest images stay as they are; older lossless ones are re-encoded as JPEG. */
const UNTOUCHED_NEWEST_IMAGES = 3;
const COMPACT_JPEG_QUALITY = 85;
/** Enough base64 to reach the dimensions in any PNG, GIF, or WebP header and in most JPEGs. */
const HEADER_SCAN_CHARS = 256 * 1024;
/** Upper bound on the fitted and compacted images kept for reuse across requests. */
const VARIANT_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** Images fitted at once; each fit runs in its own worker thread. */
const FIT_CONCURRENCY = 4;

// Placeholders are copied at each use so no two content arrays share a block object.
const OMITTED_OVERSIZED: TextContent = {
	type: "text",
	text: "[Image omitted from this request: it exceeds provider image limits and could not be reduced.]",
};
const OMITTED_EARLIER: TextContent = {
	type: "text",
	text: "[Earlier image omitted from this request to stay within the provider's request limits.]",
};

type RequestImage = ImageContent | TextContent;

interface ImageRef {
	messageIndex: number;
	blockIndex: number;
	image: ImageContent;
}

interface CachedVariant {
	promise: Promise<RequestImage>;
	bytes: number;
}

// Keyed by content, not object identity: the extension runner hands convertToLlm a structured clone of
// the context on every call. Reuse makes repeat requests cheap and keeps their bytes identical for
// prompt caching. Map order is least recently used first.
const variantCache = new Map<string, CachedVariant>();
let variantCacheBytes = 0;

function contentKey(image: ImageContent): string {
	return `${image.mimeType}:${createHash("sha1").update(image.data).digest("base64")}`;
}

function payloadBytes(image: RequestImage): number {
	return image.type === "image" ? image.data.length : 0;
}

function cachedVariant(key: string, make: () => Promise<RequestImage>): Promise<RequestImage> {
	const hit = variantCache.get(key);
	if (hit) {
		variantCache.delete(key);
		variantCache.set(key, hit);
		return hit.promise;
	}
	const entry: CachedVariant = { promise: make(), bytes: 0 };
	variantCache.set(key, entry);
	void entry.promise.then(
		(image) => {
			if (variantCache.get(key) !== entry) return;
			entry.bytes = payloadBytes(image);
			variantCacheBytes += entry.bytes;
			for (const [oldKey, old] of variantCache) {
				if (variantCacheBytes <= VARIANT_CACHE_MAX_BYTES || old === entry) break;
				variantCache.delete(oldKey);
				variantCacheBytes -= old.bytes;
			}
		},
		() => {
			if (variantCache.get(key) === entry) variantCache.delete(key);
		},
	);
	return entry.promise;
}

async function forEachConcurrently(indices: number[], run: (index: number) => Promise<void>): Promise<void> {
	let next = 0;
	const worker = async () => {
		while (next < indices.length) await run(indices[next++]);
	};
	await Promise.all(Array.from({ length: Math.min(FIT_CONCURRENCY, indices.length) }, worker));
}

function imageDimensions(image: ImageContent): { width: number; height: number } | null {
	const parsed =
		getImageDimensions(image.data.slice(0, HEADER_SCAN_CHARS), image.mimeType) ??
		(image.data.length > HEADER_SCAN_CHARS ? getImageDimensions(image.data, image.mimeType) : null);
	return parsed ? { width: parsed.widthPx, height: parsed.heightPx } : null;
}

async function fitToHardLimits(image: ImageContent, maxDimension: number, maxBytes: number): Promise<RequestImage> {
	try {
		const result = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
			resizeOptions: {
				maxWidth: Math.min(maxDimension, CLAUDE_NATIVE_IMAGE_LIMITS.maxWidth),
				maxHeight: Math.min(maxDimension, CLAUDE_NATIVE_IMAGE_LIMITS.maxHeight),
				maxBytes,
			},
		});
		return result.ok ? { type: "image", data: result.data, mimeType: result.mimeType } : { ...OMITTED_OVERSIZED };
	} catch {
		return { ...OMITTED_OVERSIZED };
	}
}

/** Re-encode a lossless image as JPEG at its current size; returns the image unchanged when that saves nothing. */
async function compactImage(image: ImageContent): Promise<RequestImage> {
	if (image.mimeType === "image/jpeg") return image;
	try {
		const dimensions = imageDimensions(image);
		if (!dimensions) return image;
		const result = await resizeImage(Buffer.from(image.data, "base64"), image.mimeType, {
			maxWidth: dimensions.width,
			maxHeight: dimensions.height,
			maxVisualTokens: Number.POSITIVE_INFINITY,
			// A cap equal to the current size forces a re-encode of an image that already fits.
			maxBytes: image.data.length,
			preferLosslessBelowBytes: 0,
			jpegQuality: COMPACT_JPEG_QUALITY,
		});
		// Only a same-size re-encode counts; resizeImage shrinks dimensions when no encoding is smaller.
		return result && !result.wasResized && result.data.length < image.data.length
			? { type: "image", data: result.data, mimeType: result.mimeType }
			: image;
	} catch {
		return image;
	}
}

/**
 * Return `messages` with every image inside provider limits for one request: per-image
 * size and dimensions, the stricter dimension limit for many-image requests, image count
 * caps per request and per message, and a total payload budget. Only violations and
 * images whose dimensions cannot be read are touched; the input is never mutated, and
 * when nothing needs fixing the same array is returned.
 */
export async function fitImagesToProviderLimits(
	messages: Message[],
	limits: ImageRequestLimits = DEFAULT_IMAGE_REQUEST_LIMITS,
): Promise<Message[]> {
	try {
		const refs: ImageRef[] = [];
		messages.forEach((message, messageIndex) => {
			if ((message.role !== "user" && message.role !== "toolResult") || !Array.isArray(message.content)) return;
			message.content.forEach((block, blockIndex) => {
				if (block?.type === "image") refs.push({ messageIndex, blockIndex, image: block });
			});
		});
		if (refs.length === 0) return messages;

		// The oldest images past the per-request cap, then past the per-message cap, are dropped. Providers
		// merge consecutive tool results (and, through the gateway, adjacent user turns) into one message, so
		// the per-message cap counts each run of messages between assistant turns as one.
		const dropped = new Set<number>();
		for (let index = 0; index < refs.length - limits.maxImagesPerRequest; index++) dropped.add(index);
		const providerMessageOf: number[] = [];
		let providerMessage = 0;
		messages.forEach((message, messageIndex) => {
			if (message.role === "assistant") providerMessage++;
			providerMessageOf[messageIndex] = providerMessage;
		});
		const keptByProviderMessage = new Map<number, number[]>();
		refs.forEach((ref, index) => {
			if (dropped.has(index)) return;
			const key = providerMessageOf[ref.messageIndex];
			keptByProviderMessage.set(key, [...(keptByProviderMessage.get(key) ?? []), index]);
		});
		for (const indices of keptByProviderMessage.values()) {
			for (const index of indices.slice(0, Math.max(0, indices.length - limits.maxImagesPerMessage)))
				dropped.add(index);
		}

		const maxDimension =
			refs.length - dropped.size > limits.manyImageThreshold ? limits.manyImageMaxDimension : limits.maxDimension;
		const fitted: RequestImage[] = refs.map(({ image }, index) =>
			dropped.has(index) ? { ...OMITTED_EARLIER } : image,
		);
		// An image whose dimensions cannot be read (corrupt data or an unsupported format) is fitted too:
		// that converts what it can and replaces the rest with a note instead of sending it as is.
		const oversized = refs.flatMap(({ image }, index) => {
			if (dropped.has(index)) return [];
			const dimensions = imageDimensions(image);
			return dimensions === null ||
				image.data.length >= limits.maxImageBytes ||
				Math.max(dimensions.width, dimensions.height) > maxDimension
				? [index]
				: [];
		});
		await forEachConcurrently(oversized, async (index) => {
			const image = refs[index].image;
			fitted[index] = await cachedVariant(`fit:${maxDimension}:${limits.maxImageBytes}:${contentKey(image)}`, () =>
				fitToHardLimits(image, maxDimension, limits.maxImageBytes),
			);
		});

		// Decided on the uncompacted total, so the choice only changes when images enter or leave the
		// context. Compacting everything but the newest few keeps later changes near the end of the
		// request, where they invalidate the least of the prompt cache.
		let total = fitted.reduce((sum, image) => sum + payloadBytes(image), 0);
		if (total > limits.requestImageBudgetBytes) {
			const compactable = fitted.flatMap((image, index) =>
				index < fitted.length - UNTOUCHED_NEWEST_IMAGES && image.type === "image" && image.mimeType !== "image/jpeg"
					? [index]
					: [],
			);
			await forEachConcurrently(compactable, async (index) => {
				const image = fitted[index] as ImageContent;
				fitted[index] = await cachedVariant(`compact:${contentKey(image)}`, () => compactImage(image));
			});
			total = fitted.reduce((sum, image) => sum + payloadBytes(image), 0);
			for (let i = 0; i < fitted.length && total > limits.requestImageBudgetBytes; i++) {
				if (fitted[i].type !== "image") continue;
				total -= payloadBytes(fitted[i]);
				fitted[i] = { ...OMITTED_EARLIER };
			}
		}

		if (fitted.every((image, i) => image === refs[i].image)) return messages;

		const output = messages.slice();
		const contents = new Map<number, (TextContent | ImageContent)[]>();
		refs.forEach((ref, i) => {
			if (fitted[i] === ref.image) return;
			let content = contents.get(ref.messageIndex);
			if (!content) {
				content = [...(messages[ref.messageIndex].content as (TextContent | ImageContent)[])];
				contents.set(ref.messageIndex, content);
			}
			content[ref.blockIndex] = fitted[i];
		});
		for (const [messageIndex, content] of contents) {
			output[messageIndex] = { ...messages[messageIndex], content } as Message;
		}
		return output;
	} catch {
		// Never fail a request here: without the guard it is sent exactly as before.
		return messages;
	}
}

/**
 * Fit images a caller supplies with a prompt (RPC and SDK `images`) the same way
 * images read from disk are fitted. An image that cannot be processed is passed
 * through unchanged; the request-time guard still bounds it.
 */
export async function fitSuppliedImages(
	images: readonly ImageContent[],
	options?: { autoResizeImages?: boolean },
): Promise<ImageContent[]> {
	const fitted: ImageContent[] = [];
	for (const image of images) {
		try {
			const result = await processImage(Buffer.from(image.data, "base64"), image.mimeType, {
				autoResizeImages: options?.autoResizeImages ?? true,
			});
			fitted.push(
				result.ok && (result.data !== image.data || result.mimeType !== image.mimeType)
					? { type: "image", data: result.data, mimeType: result.mimeType }
					: image,
			);
		} catch {
			fitted.push(image);
		}
	}
	return fitted;
}
