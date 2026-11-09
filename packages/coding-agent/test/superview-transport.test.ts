import { access, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperviewTransport } from "../src/extensions/superview-transport.ts";

const pause = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
const waitForFile = async (path: string): Promise<void> => {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			await access(path);
			return;
		} catch {
			await pause();
		}
	}
	throw new Error(`Timed out waiting for ${path}`);
};
const temp = async () => mkdtemp(join(tmpdir(), "superview-"));

describe("SuperviewTransport", () => {
	const transports: SuperviewTransport[] = [];
	afterEach(() => {
		for (const transport of transports.splice(0)) transport.dispose();
	});

	it("spools when the socket is absent and rotates at 5 MiB", async () => {
		const dir = await temp();
		const spool = join(dir, "feed.jsonl");
		const transport = new SuperviewTransport({ socketPath: join(dir, "missing.sock"), spoolPath: spool });
		transports.push(transport);
		transport.publish({ event: "one" });
		await waitForFile(spool);
		expect(JSON.parse((await readFile(spool, "utf8")).trim())).toEqual({ event: "one" });
		await writeFile(spool, "x".repeat(5 * 1024 * 1024));
		transport.publish({ event: "rotated" });
		await waitForFile(`${spool}.1`);
		expect((await stat(`${spool}.1`)).size).toBe(5 * 1024 * 1024);
		expect((await readFile(spool, "utf8")).trim()).toBe(JSON.stringify({ event: "rotated" }));
	});

	it("does not reject when the spool path is unwritable", async () => {
		const dir = await temp();
		const transport = new SuperviewTransport({
			socketPath: join(dir, "missing.sock"),
			spoolPath: join(dir, "no", "feed"),
		});
		transports.push(transport);
		await expect(Promise.resolve(transport.publish({ event: "ignored" }))).resolves.toBeUndefined();
		await pause();
	});

	it("tees after accepting local publication and isolates Feads failures", async () => {
		const dir = await temp();
		const spool = join(dir, "feed.jsonl");
		const publish = vi.fn(() => {
			throw new Error("remote unavailable");
		});
		const transport = new SuperviewTransport({
			socketPath: join(dir, "missing.sock"),
			spoolPath: spool,
			feadsPublisher: { publish, dispose: vi.fn() },
		});
		transports.push(transport);
		const event = { v: 1, event: "agent_register", agent: { activity: { argsPreview: "secret" } } };
		transport.publish(event);
		await pause();
		expect(publish).toHaveBeenCalledWith(event);
		expect(JSON.parse((await readFile(spool, "utf8")).trim())).toEqual(event);
	});

	it("delivers valid NDJSON to a listening unix socket", async () => {
		const dir = await temp();
		const socketPath = join(dir, "feed.sock");
		const lines: string[] = [];
		const server = createServer((socket) => {
			socket.setEncoding("utf8");
			socket.on("data", (chunk) => lines.push(...chunk.toString("utf8").split("\n").filter(Boolean)));
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		try {
			const transport = new SuperviewTransport({ socketPath, spoolPath: join(dir, "feed.jsonl") });
			transports.push(transport);
			transport.publish({ v: 1, event: "heartbeat", agents: ["a"] });
			for (let i = 0; i < 20 && lines.length === 0; i++) await pause(25);
			expect(JSON.parse(lines[0])).toEqual({ v: 1, event: "heartbeat", agents: ["a"] });
			transport.dispose();
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
		}
	});
});
