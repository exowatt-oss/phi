import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveHostIdentity, getHostIdentity } from "../src/extensions/superview-host-identity.ts";

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

const hostname = () => "phi-host";

describe("superview host identity", () => {
	afterEach(() => {
		execFileMock.mockReset();
		vi.useRealTimers();
	});

	it("reads tmux session and pane from explicit environment signals", () => {
		const tmuxSession = vi.fn(() => "work");
		const identity = deriveHostIdentity(
			{ TMUX: "/tmp/tmux,123,0", TMUX_PANE: "%7", PI_TMUX_SESSION_NAME: "work" },
			{ hostname, tmuxSession },
		);

		expect(identity).toEqual({ hostname: "phi-host", tmuxSession: "work", tmuxPane: "%7" });
		expect(tmuxSession).not.toHaveBeenCalled();
	});

	it("does not probe tmux when the environment is not inside tmux", () => {
		const tmuxSession = vi.fn(() => "unexpected");
		const identity = deriveHostIdentity({}, { hostname, tmuxSession });

		expect(identity).toEqual({ hostname: "phi-host" });
		expect(tmuxSession).not.toHaveBeenCalled();
	});

	it("swallows an os.hostname failure without affecting telemetry", () => {
		expect(() =>
			deriveHostIdentity(
				{},
				{
					hostname: () => {
						throw new Error("hostname unavailable");
					},
				},
			),
		).not.toThrow();
		expect(
			deriveHostIdentity(
				{},
				{
					hostname: () => {
						throw new Error("hostname unavailable");
					},
				},
			),
		).toBeUndefined();
	});

	it("omits an undiscoverable tmux session without throwing", () => {
		const identity = deriveHostIdentity(
			{ TMUX: "/tmp/tmux,123,0", TMUX_PANE: "%7" },
			{ hostname, tmuxSession: () => undefined },
		);

		expect(identity).toEqual({ hostname: "phi-host", tmuxPane: "%7" });
	});

	it("derives an unambiguous devbox profile from the tmux session name", () => {
		const identity = deriveHostIdentity({ TMUX_SESSION_NAME: "devbox-roam-3-dbfix" }, { hostname });

		expect(identity).toEqual({ hostname: "phi-host", tmuxSession: "devbox-roam-3-dbfix", devboxProfileId: "roam" });
	});

	it("omits an ambiguous devbox session name", () => {
		const identity = deriveHostIdentity({ TMUX_SESSION_NAME: "devbox-roam-3-4" }, { hostname });

		expect(identity).toEqual({ hostname: "phi-host", tmuxSession: "devbox-roam-3-4" });
	});

	it("swallows a synchronous tmux process launch failure", () => {
		execFileMock.mockImplementationOnce(() => {
			throw new Error("tmux unavailable");
		});

		let identity: ReturnType<typeof deriveHostIdentity> | undefined;
		expect(() => {
			identity = deriveHostIdentity({ TMUX: "/tmp/tmux,123,0" }, { hostname });
		}).not.toThrow();
		expect(identity).toEqual({ hostname: "phi-host" });
	});

	it("unrefs the tmux child and deadline timer without using execFile's referenced timeout", async () => {
		const child = { kill: vi.fn(), once: vi.fn(), unref: vi.fn() };
		execFileMock.mockImplementationOnce((...args: unknown[]) => {
			const options = args[2] as { timeout?: number };
			expect(options.timeout).toBeUndefined();
			const callback = args[3] as (error: Error | null, stdout: string) => void;
			queueMicrotask(() => callback(null, "work\n"));
			return child;
		});
		const timers: ReturnType<typeof setTimeout>[] = [];
		const realSetTimeout = globalThis.setTimeout;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			handler: (...args: unknown[]) => void,
			delay: number,
			...args: unknown[]
		) => {
			const timer = realSetTimeout(handler, delay, ...args);
			timers.push(timer);
			return timer;
		}) as typeof setTimeout);
		try {
			const identity = deriveHostIdentity({ TMUX: "/tmp/tmux,123,0" }, { hostname });
			await new Promise<void>((resolve) => realSetTimeout(resolve, 1));
			expect(execFileMock).toHaveBeenCalledOnce();
			expect(identity).toEqual({ hostname: "phi-host", tmuxSession: "work" });
			expect(child.unref).toHaveBeenCalledOnce();
			expect(timers.length).toBeGreaterThan(0);
			expect(timers.every((timer) => timer.hasRef() === false)).toBe(true);
		} finally {
			for (const timer of timers) clearTimeout(timer);
			setTimeoutSpy.mockRestore();
		}
	});

	it("swallows a synchronously throwing lookup while retaining known fields", () => {
		expect(() =>
			deriveHostIdentity(
				{ TMUX: "/tmp/tmux,123,0" },
				{
					hostname,
					tmuxSession: () => {
						throw new Error("tmux unavailable");
					},
				},
			),
		).not.toThrow();
	});

	it("swallows an asynchronously rejected lookup without an unhandled rejection", async () => {
		let rejectLookup!: (reason?: unknown) => void;
		const rejectedLookup = new Promise<string | undefined>((_resolve, reject) => {
			rejectLookup = reject;
		});
		const unhandledRejection = vi.fn();
		process.on("unhandledRejection", unhandledRejection);
		try {
			const identity = deriveHostIdentity(
				{ TMUX: "/tmp/tmux,123,0" },
				{ hostname, tmuxSession: () => rejectedLookup },
			);
			rejectLookup(new Error("tmux unavailable"));
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(identity).toEqual({ hostname: "phi-host" });
			expect(unhandledRejection).not.toHaveBeenCalled();
		} finally {
			process.removeListener("unhandledRejection", unhandledRejection);
		}
	});

	it("bounds a hanging lookup and ignores a result after the deadline", async () => {
		vi.useFakeTimers();
		let resolveLookup!: (session: string | undefined) => void;
		const identity = deriveHostIdentity(
			{ TMUX: "/tmp/tmux,123,0" },
			{
				hostname,
				tmuxSession: () =>
					new Promise<string | undefined>((resolve) => {
						resolveLookup = resolve;
					}),
			},
		);

		expect(identity).toEqual({ hostname: "phi-host" });
		await vi.advanceTimersByTimeAsync(75);
		resolveLookup("late-session");
		await vi.runAllTicks();
		expect(identity).toEqual({ hostname: "phi-host" });
	});

	it("caches the process result and invokes hooks only once", () => {
		const tmuxSession = vi.fn(() => "cached");
		const first = getHostIdentity({ TMUX: "/tmp/tmux,123,0" }, { hostname, tmuxSession });
		const second = getHostIdentity(
			{ TMUX: "/tmp/tmux,456,0" },
			{ hostname: vi.fn(() => "different"), tmuxSession: vi.fn(() => "different") },
		);

		expect(first).toEqual({ hostname: "phi-host", tmuxSession: "cached" });
		expect(second).toBe(first);
		expect(tmuxSession).toHaveBeenCalledOnce();
	});
});
