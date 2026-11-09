import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { collectImageAttachmentsFromText, extractImagePathCandidates } from "../src/utils/image-path-attach.ts";

const ONE_BY_ONE_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);
const OTHER_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
	"base64",
);

describe("extractImagePathCandidates", () => {
	test("finds a bare pasted path", () => {
		const path = "/var/folders/54/T/orca-paste-1787197857140-56da470c.png";
		expect(extractImagePathCandidates(path)).toEqual([path]);
	});

	test("finds a path embedded in a sentence", () => {
		const candidates = extractImagePathCandidates(
			"wait but it shows good here look /tmp/orca-paste-1-a.png did it work",
		);
		expect(candidates).toEqual(["/tmp/orca-paste-1-a.png"]);
	});

	test("finds multiple distinct paths and dedupes repeats", () => {
		const candidates = extractImagePathCandidates("/tmp/a.png then /tmp/b.jpeg then /tmp/a.png again");
		expect(candidates).toEqual(["/tmp/a.png", "/tmp/b.jpeg"]);
	});

	test("finds a whole-line path containing spaces", () => {
		const path = "/Users/me/Desktop/Screenshot 2026-08-19 at 1.02.11 PM.png";
		expect(extractImagePathCandidates(`look:\n${path}\nok?`)).toContain(path);
	});

	test("finds tilde and relative paths", () => {
		const candidates = extractImagePathCandidates("see ~/shots/a.png and ./b.webp and ../c.gif");
		expect(candidates).toEqual(["~/shots/a.png", "./b.webp", "../c.gif"]);
	});

	test("ignores non-image extensions and non-path text", () => {
		expect(extractImagePathCandidates("read /tmp/notes.txt and src/main.ts, no images.png here")).toEqual([]);
	});
});

describe("collectImageAttachmentsFromText", () => {
	let dir: string;
	let realPng: string;
	let fakePng: string;

	beforeAll(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-image-attach-"));
		realPng = join(dir, "orca-paste-1787197857140-56da470c.png");
		fakePng = join(dir, "not-actually-an-image.png");
		await writeFile(realPng, ONE_BY_ONE_PNG);
		await writeFile(fakePng, "just some text pretending to be a png");
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("attaches a real png referenced by bare path", async () => {
		const result = await collectImageAttachmentsFromText(realPng, dir);
		expect(result.attachedPaths).toEqual([realPng]);
		expect(result.images).toHaveLength(1);
		expect(result.images[0]).toMatchObject({ type: "image", mimeType: "image/png" });
		expect(result.images[0]?.data.length).toBeGreaterThan(0);
	});

	test("attaches when the path is embedded in a sentence", async () => {
		const result = await collectImageAttachmentsFromText(
			`i kicked it out and reconnected it\n${realPng}\ndid it work`,
			dir,
		);
		expect(result.attachedPaths).toEqual([realPng]);
	});

	test("rejects a text file masquerading as .png (magic-byte sniff)", async () => {
		const result = await collectImageAttachmentsFromText(fakePng, dir);
		expect(result.images).toEqual([]);
	});

	test("skips nonexistent paths without failing", async () => {
		const result = await collectImageAttachmentsFromText("/tmp/definitely-missing-9099fa.png", dir);
		expect(result.images).toEqual([]);
	});

	test("attaches a repeated path only once", async () => {
		const result = await collectImageAttachmentsFromText(`${realPng} and again ${realPng}`, dir);
		expect(result.attachedPaths).toEqual([realPng]);
	});

	test("skips a referenced file byte-identical to an image the caller already supplies", async () => {
		const supplied = [{ type: "image" as const, data: ONE_BY_ONE_PNG.toString("base64"), mimeType: "image/png" }];
		const result = await collectImageAttachmentsFromText(
			`[Attached image "orca-paste.png" is saved at: ${realPng}]`,
			dir,
			{ skipIdenticalTo: supplied },
		);
		expect(result.images).toEqual([]);
	});

	test("still attaches a referenced file that differs from the supplied images", async () => {
		const other = join(dir, "other.png");
		await writeFile(other, OTHER_PNG);
		const supplied = [{ type: "image" as const, data: ONE_BY_ONE_PNG.toString("base64"), mimeType: "image/png" }];
		const result = await collectImageAttachmentsFromText(`${realPng} and ${other}`, dir, {
			skipIdenticalTo: supplied,
		});
		expect(result.attachedPaths).toEqual([other]);
	});

	test("caps the number of attachments", async () => {
		const paths: string[] = [];
		for (let i = 0; i < 3; i++) {
			const p = join(dir, `cap-${i}.png`);
			await writeFile(p, ONE_BY_ONE_PNG);
			paths.push(p);
		}
		const result = await collectImageAttachmentsFromText(paths.join("\n"), dir, { maxImages: 2 });
		expect(result.attachedPaths).toEqual(paths.slice(0, 2));
	});
});
