import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { readPipedStdin } from "../src/cli/piped-stdin.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("readPipedStdin", () => {
	test("returns undefined for a TTY without reading", async () => {
		const stdin = Object.assign(new PassThrough(), { isTTY: true });
		await expect(readPipedStdin(stdin, { firstDataTimeoutMs: 10 })).resolves.toBeUndefined();
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("reads piped content to EOF", async () => {
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin, { firstDataTimeoutMs: 1000 });
		stdin.write("hello ");
		stdin.end("world\n");
		await expect(result).resolves.toBe("hello world");
	});

	test("gives up on an open stdin that never writes or closes", async () => {
		vi.useFakeTimers();
		const stdin = new PassThrough();
		const onTimeout = vi.fn();
		const result = readPipedStdin(stdin, { firstDataTimeoutMs: 3000, onTimeout });
		await vi.advanceTimersByTimeAsync(3000);
		await expect(result).resolves.toBeUndefined();
		expect(onTimeout).toHaveBeenCalledOnce();
		expect(stdin.isPaused()).toBe(true);
		expect(stdin.listenerCount("data")).toBe(0);
	});

	test("keeps reading slow input once the first chunk arrived in time", async () => {
		vi.useFakeTimers();
		const stdin = new PassThrough();
		const onTimeout = vi.fn();
		const result = readPipedStdin(stdin, { firstDataTimeoutMs: 3000, onTimeout });
		await vi.advanceTimersByTimeAsync(1000);
		stdin.write("first ");
		await vi.advanceTimersByTimeAsync(10_000);
		stdin.end("second");
		await expect(result).resolves.toBe("first second");
		expect(onTimeout).not.toHaveBeenCalled();
	});

	test("waits for EOF indefinitely when no timeout is set", async () => {
		vi.useFakeTimers();
		const stdin = new PassThrough();
		const result = readPipedStdin(stdin);
		await vi.advanceTimersByTimeAsync(60_000);
		stdin.end("late prompt");
		await expect(result).resolves.toBe("late prompt");
	});
});
