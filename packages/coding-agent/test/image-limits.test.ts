import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_IMAGE_REQUEST_LIMITS,
	fitImagesToProviderLimits,
	fitSuppliedImages,
	type ImageRequestLimits,
} from "../src/utils/image-limits.ts";
import { loadPhoton } from "../src/utils/photon.ts";

async function makeImage(width: number, height: number, kind: "bands" | "noise", seed = 1): Promise<ImageContent> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon failed to load");
	const pixels = new Uint8Array(width * height * 4);
	let state = seed >>> 0 || 1;
	for (let i = 0; i < width * height; i++) {
		if (kind === "noise") {
			state = (state * 1664525 + 1013904223) >>> 0;
			pixels[i * 4] = state & 0xff;
			pixels[i * 4 + 1] = (state >>> 8) & 0xff;
			pixels[i * 4 + 2] = (state >>> 16) & 0xff;
		} else {
			pixels[i * 4 + (Math.floor((i % width) / 20) % 3)] = 200;
		}
		pixels[i * 4 + 3] = 255;
	}
	const image = new photon.PhotonImage(pixels, width, height);
	try {
		return { type: "image", data: Buffer.from(image.get_bytes()).toString("base64"), mimeType: "image/png" };
	} finally {
		image.free();
	}
}

function user(...content: (TextContent | ImageContent)[]): Message {
	return { role: "user", content, timestamp: 0 };
}

function toolResult(...content: (TextContent | ImageContent)[]): Message {
	return { role: "toolResult", toolCallId: "call-1", toolName: "read", content, isError: false, timestamp: 0 };
}

function imagesOf(messages: Message[]): (TextContent | ImageContent)[] {
	return messages.flatMap((message) =>
		Array.isArray(message.content)
			? (message.content as (TextContent | ImageContent)[]).filter(
					(block) =>
						block.type === "image" || block.text.startsWith("[Image") || block.text.startsWith("[Earlier"),
				)
			: [],
	);
}

function limits(overrides: Partial<ImageRequestLimits>): ImageRequestLimits {
	return { ...DEFAULT_IMAGE_REQUEST_LIMITS, ...overrides };
}

describe("fitImagesToProviderLimits", () => {
	it("returns the same array when nothing needs fixing", async () => {
		const textOnly = [user({ type: "text", text: "hi" })];
		expect(await fitImagesToProviderLimits(textOnly)).toBe(textOnly);

		const compliant = [user({ type: "text", text: "look" }, await makeImage(64, 64, "bands"))];
		expect(await fitImagesToProviderLimits(compliant)).toBe(compliant);
	});

	it("reduces an image over the per-image size limit without mutating the session's message", async () => {
		const big = await makeImage(200, 150, "noise");
		const small = await makeImage(32, 32, "bands");
		const first = user({ type: "text", text: "old" }, small);
		const second = toolResult({ type: "text", text: "Read image file" }, big);
		const messages = [first, second];
		const maxImageBytes = Math.floor(big.data.length / 2);

		const fitted = await fitImagesToProviderLimits(messages, limits({ maxImageBytes }));

		expect(fitted).not.toBe(messages);
		expect(fitted[0]).toBe(first);
		const replaced = (fitted[1].content as (TextContent | ImageContent)[])[1];
		expect(replaced.type).toBe("image");
		expect((replaced as ImageContent).data.length).toBeLessThan(maxImageBytes);
		expect((second.content as (TextContent | ImageContent)[])[1]).toBe(big);
	});

	it("applies the many-image dimension limit once a request carries more images than the threshold", async () => {
		const wide = await makeImage(300, 40, "bands");
		const a = await makeImage(40, 40, "bands");
		const b = await makeImage(40, 40, "bands", 2);
		const messages = [user(a), user(b), user(wide)];

		const fitted = await fitImagesToProviderLimits(
			messages,
			limits({ manyImageThreshold: 2, manyImageMaxDimension: 100 }),
		);

		expect(fitted[0]).toBe(messages[0]);
		expect(fitted[1]).toBe(messages[1]);
		const resized = (fitted[2].content as ImageContent[])[0];
		const dimensions = getImageDimensions(resized.data, resized.mimeType);
		expect(dimensions).not.toBeNull();
		expect(Math.max(dimensions!.widthPx, dimensions!.heightPx)).toBeLessThanOrEqual(100);

		// Under the threshold the same wide image is left alone.
		const few = [user(a), user(wide)];
		expect(await fitImagesToProviderLimits(few, limits({ manyImageThreshold: 2, manyImageMaxDimension: 100 }))).toBe(
			few,
		);
	});

	it("replaces an oversized image it cannot decode with a note instead of failing the request", async () => {
		const garbage: ImageContent = {
			type: "image",
			data: Buffer.alloc(4096, 7).toString("base64"),
			mimeType: "image/png",
		};
		const fitted = await fitImagesToProviderLimits([user(garbage)], limits({ maxImageBytes: 1024 }));

		const block = (fitted[0].content as (TextContent | ImageContent)[])[0];
		expect(block.type).toBe("text");
		expect((block as TextContent).text).toContain("Image omitted");
	});

	it("compacts older lossless images to JPEG over the payload budget and leaves the newest three alone", async () => {
		const images = await Promise.all([1, 2, 3, 4, 5].map((seed) => makeImage(160, 120, "noise", seed)));
		const messages = images.map((image) => user(image));
		const total = images.reduce((sum, image) => sum + image.data.length, 0);
		const newestThree = images.slice(2).reduce((sum, image) => sum + image.data.length, 0);
		const requestImageBudgetBytes = Math.floor(newestThree + (total - newestThree) / 2);

		const fitted = await fitImagesToProviderLimits(messages, limits({ requestImageBudgetBytes }));
		const blocks = imagesOf(fitted) as ImageContent[];

		expect(blocks.slice(0, 2).map((block) => block.mimeType)).toEqual(["image/jpeg", "image/jpeg"]);
		expect(blocks.slice(2)).toEqual(images.slice(2));
		expect(fitted.slice(2)).toEqual(messages.slice(2));
		expect(blocks.reduce((sum, block) => sum + block.data.length, 0)).toBeLessThanOrEqual(requestImageBudgetBytes);

		// Production hands the guard a structured clone on every request (the extension runner's context
		// pass), so reuse must survive new objects: the cached replacements come back, and the prompt cache holds.
		const again = imagesOf(
			await fitImagesToProviderLimits(structuredClone(messages), limits({ requestImageBudgetBytes })),
		);
		expect(again[0]).toBe(blocks[0]);
		expect(again[1]).toBe(blocks[1]);
	});

	it("reuses a fitted oversized image across cloned requests", async () => {
		const big = await makeImage(200, 150, "noise", 9);
		const messages = [user(big)];
		const maxImageBytes = Math.floor(big.data.length / 2);

		const first = await fitImagesToProviderLimits(structuredClone(messages), limits({ maxImageBytes }));
		const second = await fitImagesToProviderLimits(structuredClone(messages), limits({ maxImageBytes }));

		expect((second[0].content as ImageContent[])[0]).toBe((first[0].content as ImageContent[])[0]);
	});

	it("never shrinks an image to meet the payload budget; it drops the oldest instead", async () => {
		// Flat bands encode far smaller as PNG than as JPEG, so no same-size re-encode helps.
		const images = await Promise.all([1, 2, 3, 4].map((seed) => makeImage(400, 300, "bands", seed)));
		const total = images.reduce((sum, image) => sum + image.data.length, 0);
		const fitted = await fitImagesToProviderLimits(
			images.map((image) => user(image)),
			limits({ requestImageBudgetBytes: total - 1 }),
		);
		const blocks = imagesOf(fitted);

		expect(blocks[0].type).toBe("text");
		expect(blocks.slice(1)).toEqual(images.slice(1));
	});

	it("drops the oldest images beyond the per-request image count", async () => {
		const images = await Promise.all([1, 2, 3].map((seed) => makeImage(32, 32, "bands", seed)));
		const fitted = await fitImagesToProviderLimits(
			images.map((image) => user(image)),
			limits({ maxImagesPerRequest: 2 }),
		);
		const blocks = imagesOf(fitted);

		expect(blocks[0].type).toBe("text");
		expect(blocks.slice(1)).toEqual(images.slice(1));
	});

	it("drops the oldest images in a message beyond the per-message image count", async () => {
		const images = await Promise.all([1, 2, 3].map((seed) => makeImage(32, 32, "noise", seed)));
		const other = await makeImage(32, 32, "noise", 4);
		// An assistant turn keeps the two user messages separate provider messages.
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
		} as unknown as Message;
		const fitted = await fitImagesToProviderLimits(
			[user(other), assistant, user(...images)],
			limits({ maxImagesPerMessage: 2 }),
		);
		const crowded = fitted[2].content as (TextContent | ImageContent)[];

		expect(fitted[0].content).toEqual([other]);
		expect(crowded[0].type).toBe("text");
		expect(crowded.slice(1)).toEqual(images.slice(1));
	});

	it("counts consecutive tool results as one provider message for the per-message cap", async () => {
		const images = await Promise.all([1, 2, 3, 4].map((seed) => makeImage(32, 32, "noise", seed)));
		const merged = [toolResult(images[0], images[1]), toolResult(images[2], images[3])];

		const blocks = imagesOf(await fitImagesToProviderLimits(merged, limits({ maxImagesPerMessage: 3 })));

		expect(blocks[0].type).toBe("text");
		expect(blocks.slice(1)).toEqual(images.slice(1));

		// An assistant turn in between starts a new provider message.
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			timestamp: 0,
		} as unknown as Message;
		const separated = [toolResult(images[0], images[1]), assistant, toolResult(images[2], images[3])];
		expect(await fitImagesToProviderLimits(separated, limits({ maxImagesPerMessage: 3 }))).toBe(separated);
	});

	it("replaces a small image it cannot read with a note instead of sending it as is", async () => {
		const corrupt: ImageContent = {
			type: "image",
			data: Buffer.alloc(64, 7).toString("base64"),
			mimeType: "image/png",
		};
		const fitted = await fitImagesToProviderLimits([user(corrupt)]);
		const block = (fitted[0].content as (TextContent | ImageContent)[])[0];

		expect(block.type).toBe("text");
		expect((block as TextContent).text).toContain("Image omitted");
	});

	it("fits an image past the 8000px hard limit even in a small request", async () => {
		const tall = await makeImage(8100, 8, "bands");
		const fitted = await fitImagesToProviderLimits([user(tall)]);
		const block = (fitted[0].content as ImageContent[])[0];
		const dimensions = getImageDimensions(block.data, block.mimeType);

		expect(dimensions).not.toBeNull();
		expect(Math.max(dimensions!.widthPx, dimensions!.heightPx)).toBeLessThanOrEqual(8000);
	});

	it("returns the messages unchanged instead of throwing on malformed content", async () => {
		const malformed = [{ role: "user", content: [null], timestamp: 0 }] as unknown as Message[];
		await expect(fitImagesToProviderLimits(malformed)).resolves.toBe(malformed);
	});

	it("drops the oldest images when compaction alone cannot meet the payload budget", async () => {
		const images = await Promise.all([1, 2, 3, 4].map((seed) => makeImage(160, 120, "noise", seed)));
		const newest = images[3];
		const fitted = await fitImagesToProviderLimits(
			images.map((image) => user(image)),
			limits({ requestImageBudgetBytes: newest.data.length }),
		);
		const blocks = imagesOf(fitted);

		expect(blocks.slice(0, 3).every((block) => block.type === "text")).toBe(true);
		expect(blocks[3]).toBe(newest);
	});
});

describe("fitSuppliedImages", () => {
	it("fits an oversized supplied image to Claude's native view and passes small ones through", async () => {
		const large = await makeImage(3000, 1500, "bands");
		const small = await makeImage(64, 64, "bands");

		const [fittedLarge, fittedSmall] = await fitSuppliedImages([large, small]);

		const dimensions = getImageDimensions(fittedLarge.data, fittedLarge.mimeType);
		expect(dimensions).toEqual({ widthPx: 2576, heightPx: 1288 });
		expect(["image/png", "image/jpeg"]).toContain(fittedLarge.mimeType);
		expect(fittedSmall).toBe(small);
	});

	it("leaves images untouched when auto-resize is off", async () => {
		const large = await makeImage(3000, 1500, "bands");
		const [fitted] = await fitSuppliedImages([large], { autoResizeImages: false });
		expect(fitted).toBe(large);
	});
});
