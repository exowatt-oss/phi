import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { getImageDimensions } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { loadPhoton } from "../../src/utils/photon.ts";
import { createHarness, getUserTexts, type Harness } from "./harness.ts";

async function makePng(width: number, height: number, band = 0): Promise<Buffer> {
	const photon = await loadPhoton();
	if (!photon) throw new Error("Photon failed to load");
	const pixels = new Uint8Array(width * height * 4);
	for (let i = 0; i < width * height; i++) {
		pixels[i * 4 + ((Math.floor((i % width) / 30) + band) % 3)] = 200;
		pixels[i * 4 + 3] = 255;
	}
	const image = new photon.PhotonImage(pixels, width, height);
	try {
		return Buffer.from(image.get_bytes());
	} finally {
		image.free();
	}
}

function userImages(harness: Harness): ImageContent[] {
	const userMessage = harness.session.messages.find((message) => message.role === "user");
	if (!userMessage || !Array.isArray(userMessage.content)) return [];
	return userMessage.content.filter((block): block is ImageContent => block.type === "image");
}

describe("AgentSession image attachments", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("sends a pasted image once when the host supplies its bytes and also names its saved path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seen")]);
		const bytes = await makePng(120, 80);
		const savedPath = join(harness.tempDir, "0acbceb2-attachment.png");
		writeFileSync(savedPath, bytes);

		// The shape P3 Code sends: the bytes in `images`, the saved path in the text.
		await harness.session.prompt(
			`what is this?\n\n[Attached image "Screenshot 2026-09-30 at 10.14.46 AM.png" is saved at: ${savedPath}]`,
			{ images: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }] },
		);

		expect(userImages(harness)).toHaveLength(1);
	});

	it("sends a Retina-size pasted image once, fitted, when the host also names its saved path", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seen")]);
		const bytes = await makePng(3376, 1788);
		const savedPath = join(harness.tempDir, "0acbceb2-retina.png");
		writeFileSync(savedPath, bytes);

		await harness.session.prompt(`what is this?\n\n[Attached image "Screenshot.png" is saved at: ${savedPath}]`, {
			images: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
		});

		const images = userImages(harness);
		expect(images).toHaveLength(1);
		expect(getImageDimensions(images[0].data, images[0].mimeType)).toEqual({ widthPx: 2576, heightPx: 1364 });
	});

	it("keeps steering order when an earlier steer carries images still being fitted", async () => {
		let releaseTool = () => {};
		const toolRelease = new Promise<void>((resolve) => {
			releaseTool = resolve;
		});
		const waitTool: AgentTool = {
			name: "wait",
			label: "Wait",
			description: "Wait for release",
			parameters: Type.Object({}),
			execute: async () => {
				await toolRelease;
				return { content: [{ type: "text", text: "released" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [waitTool] });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("handled A"),
			fauxAssistantMessage("handled B"),
		]);
		const toolStarted = new Promise<void>((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type === "tool_execution_start") {
					unsubscribe();
					resolve();
				}
			});
		});
		const promptPromise = harness.session.prompt("start");
		await toolStarted;
		const image = await makePng(2600, 100);

		// Issued back to back, as concurrent RPC lines are.
		const steerA = harness.session.steer("A with image", [
			{ type: "image", data: image.toString("base64"), mimeType: "image/png" },
		]);
		const steerB = harness.session.steer("B text only");
		await Promise.all([steerA, steerB]);
		releaseTool();
		await promptPromise;

		expect(getUserTexts(harness)).toEqual(["start", "A with image", "B text only"]);
	});

	it("steers a prompt sent while an earlier image prompt is still starting into that run", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("handled A"), fauxAssistantMessage("handled B")]);
		const image = await makePng(2600, 100);

		// Back to back, as P3 sends a quick second message while the first image is still being fitted.
		const promptA = harness.session.prompt("A with image", {
			images: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
		});
		const promptB = harness.session.prompt("B text only", { streamingBehavior: "steer" });
		await Promise.all([promptA, promptB]);

		expect(getUserTexts(harness)).toEqual(["A with image", "B text only"]);
	});

	it("leaves nothing stranded when a starting image prompt fails its auth check", async () => {
		const harness = await createHarness({ withConfiguredAuth: false });
		harnesses.push(harness);
		const image = await makePng(2600, 100);

		const promptA = harness.session.prompt("A with image", {
			images: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }],
		});
		const promptB = harness.session.prompt("B text only", { streamingBehavior: "steer" });
		const [resultA, resultB] = await Promise.allSettled([promptA, promptB]);

		expect(resultA.status).toBe("rejected");
		expect(resultB.status).toBe("rejected");
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("attaches a pasted path at full size when auto-resize is off", async () => {
		const harness = await createHarness({ settings: { images: { autoResize: false } } });
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seen")]);
		const imagePath = join(harness.tempDir, "big.png");
		writeFileSync(imagePath, await makePng(3000, 1500));

		await harness.session.prompt(`look at ${imagePath}`);

		const [image] = userImages(harness);
		expect(getImageDimensions(image.data, image.mimeType)).toEqual({ widthPx: 3000, heightPx: 1500 });
	});

	it("fits an oversized supplied image to Claude's native view", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seen")]);
		const bytes = await makePng(3376, 1788);

		await harness.session.prompt("what is this?", {
			images: [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }],
		});

		const [image] = userImages(harness);
		expect(getImageDimensions(image.data, image.mimeType)).toEqual({ widthPx: 2576, heightPx: 1364 });
	});

	it("still attaches a referenced file that differs from the supplied images", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("seen")]);
		const supplied = await makePng(60, 40);
		const otherPath = join(harness.tempDir, "other.png");
		writeFileSync(otherPath, await makePng(60, 40, 1));

		await harness.session.prompt(`compare with ${otherPath}`, {
			images: [{ type: "image", data: supplied.toString("base64"), mimeType: "image/png" }],
		});

		expect(userImages(harness)).toHaveLength(2);
	});
});
