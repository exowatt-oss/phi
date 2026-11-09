/**
 * Auto-attach images referenced by file path in submitted user text.
 *
 * Terminal hosts (Forca/orca image paste, drag-and-drop, phi's own Ctrl+V
 * clipboard paste) deliver a pasted screenshot as a temp-file *path* typed into
 * the input, not as image bytes. Without deterministic attachment the image
 * only reaches the model if it volunteers a read-tool call on the path — when
 * it skips that, it answers about a screenshot it never saw.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { ImageContent } from "@earendil-works/pi-ai";
import { resolveReadPath } from "../core/tools/path-utils.ts";
import { processImage } from "./image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "./mime.ts";

/** POSIX path-like tokens ending in an image extension: /abs, ~/home, ./rel, ../rel */
const IMAGE_PATH_TOKEN_PATTERN = /(?:~|\.{1,2})?\/[^\s"'`<>|;]*\.(?:png|jpe?g|gif|webp|bmp)\b/gi;
const IMAGE_EXTENSION_AT_END_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp)$/i;
const PATH_LIKE_LINE_PATTERN = /^(?:~|\.{1,2})?\//;

const MAX_AUTO_ATTACHED_IMAGES = 8;
/** Larger sources are skipped outright rather than read into memory. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/**
 * Cheap synchronous pre-check. Callers on timing-sensitive paths (steer/followUp
 * must enqueue synchronously) use this to skip the async attach entirely.
 */
export function hasImagePathCandidates(text: string): boolean {
	return extractImagePathCandidates(text).length > 0;
}

export interface AutoAttachedImages {
	images: ImageContent[];
	/** Resolved absolute paths of the attached images, in attachment order. */
	attachedPaths: string[];
}

/**
 * Extract candidate image paths from message text: path-shaped tokens ending in
 * an image extension, plus whole lines that look like a single path (covers
 * filenames with spaces, e.g. macOS "Screenshot 2026-08-19 at 1.02.11 PM.png").
 * Candidates are unverified — callers must check existence and content type.
 */
export function extractImagePathCandidates(text: string): string[] {
	const candidates: string[] = [];
	const seen = new Set<string>();
	const push = (candidate: string) => {
		const trimmed = candidate.trim();
		if (trimmed && !seen.has(trimmed)) {
			seen.add(trimmed);
			candidates.push(trimmed);
		}
	};

	for (const match of text.matchAll(IMAGE_PATH_TOKEN_PATTERN)) {
		push(match[0]);
	}

	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (PATH_LIKE_LINE_PATTERN.test(trimmed) && IMAGE_EXTENSION_AT_END_PATTERN.test(trimmed)) {
			push(trimmed);
		}
	}

	return candidates;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Digests of the supplied images' decoded bytes, keyed by byte length so non-matching files are never hashed. */
function indexSuppliedImages(images: readonly ImageContent[]): Map<number, Set<string>> {
	const index = new Map<number, Set<string>>();
	for (const image of images) {
		const bytes = Buffer.from(image.data, "base64");
		const digests = index.get(bytes.byteLength) ?? new Set<string>();
		digests.add(sha256(bytes));
		index.set(bytes.byteLength, digests);
	}
	return index;
}

/**
 * Load the images referenced by path in `text` as attachments. Best-effort:
 * candidates that don't exist, aren't actually images (magic-byte sniff, never
 * the extension alone), or fail processing are silently skipped — this must
 * never block or fail a prompt.
 *
 * `skipIdenticalTo` names images the caller already sends with the message. A
 * referenced file byte-identical to one of them is not attached again: hosts
 * such as P3 Code send an attachment's bytes and also name its saved path in the
 * text, which otherwise put every pasted image in the request twice.
 */
export async function collectImageAttachmentsFromText(
	text: string,
	cwd: string,
	options?: { autoResizeImages?: boolean; maxImages?: number; skipIdenticalTo?: readonly ImageContent[] },
): Promise<AutoAttachedImages> {
	const maxImages = options?.maxImages ?? MAX_AUTO_ATTACHED_IMAGES;
	const images: ImageContent[] = [];
	const attachedPaths: string[] = [];
	const visited = new Set<string>();
	const supplied = options?.skipIdenticalTo?.length ? indexSuppliedImages(options.skipIdenticalTo) : undefined;

	for (const candidate of extractImagePathCandidates(text)) {
		if (images.length >= maxImages) break;
		try {
			const absolutePath = resolveReadPath(candidate, cwd);
			if (visited.has(absolutePath)) continue;
			visited.add(absolutePath);

			const stats = await stat(absolutePath);
			if (!stats.isFile() || stats.size === 0 || stats.size > MAX_SOURCE_BYTES) continue;

			const mimeType = await detectSupportedImageMimeTypeFromFile(absolutePath);
			if (!mimeType) continue;

			const bytes = await readFile(absolutePath);
			if (supplied?.get(bytes.byteLength)?.has(sha256(bytes))) continue;

			const processed = await processImage(bytes, mimeType, {
				autoResizeImages: options?.autoResizeImages ?? true,
			});
			if (!processed.ok) continue;

			images.push({ type: "image", mimeType: processed.mimeType, data: processed.data });
			attachedPaths.push(absolutePath);
		} catch {
			// Best-effort by contract: skip unreadable candidates.
		}
	}

	return { images, attachedPaths };
}
