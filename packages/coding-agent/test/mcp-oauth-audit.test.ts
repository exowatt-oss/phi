import { execFile } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AUTH_LOG_ENV_VAR,
	AUTH_LOG_MAX_BYTES,
	auditLogPath,
	DEFAULT_AUTH_LOG_NAME,
	fingerprint,
	readOAuthEvents,
	recordOAuthEvent,
	safeUrl,
} from "../src/extensions/mcp/oauth/audit.ts";

let dir: string;
let logPath: string;
const saved: Record<string, string | undefined> = {};

const ENV_KEYS = [AUTH_LOG_ENV_VAR, "PHI_MCP_AUTH_DIR", "MCP_REMOTE_CONFIG_DIR"];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "phi-mcp-audit-"));
	logPath = join(dir, "events.jsonl");
	for (const key of ENV_KEYS) saved[key] = process.env[key];
	for (const key of ENV_KEYS) delete process.env[key];
	process.env[AUTH_LOG_ENV_VAR] = logPath;
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (saved[key] === undefined) delete process.env[key];
		else process.env[key] = saved[key];
	}
	rmSync(dir, { recursive: true, force: true });
});

/**
 * Fingerprint the same secret from `count` genuinely separate processes started
 * together, all pointed at `logPath`. Returns what each one produced.
 */
async function fingerprintFromProcesses(count: number, logPath: string): Promise<string[]> {
	const auditModule = join(dirname(fileURLToPath(import.meta.url)), "../src/extensions/mcp/oauth/audit.ts");
	const script = join(dirname(logPath), "fingerprint-probe.ts");
	writeFileSync(
		script,
		`import { fingerprint } from ${JSON.stringify(auditModule)};\n` +
			`process.stdout.write(String(fingerprint("shared-secret")));\n`,
	);
	// Launched together, so they contend for publication rather than politely
	// queueing: one writes the key and the rest must adopt it.
	// `allSettled` plus an explicit timeout: one child failing must not leave its
	// siblings running past the end of the test, and a wedged child must not hang
	// CI waiting for the suite timeout to notice.
	const runs = await Promise.allSettled(
		Array.from({ length: count }, () =>
			promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", script], {
				env: { ...process.env, [AUTH_LOG_ENV_VAR]: logPath },
				encoding: "utf8",
				timeout: 30_000,
				killSignal: "SIGKILL",
			}),
		),
	);
	const failed = runs.find((run) => run.status === "rejected");
	if (failed?.status === "rejected") throw failed.reason;
	return runs.map((run) => (run.status === "fulfilled" ? run.value.stdout.trim() : ""));
}

describe("oauth audit log", () => {
	it("appends events as JSON lines with a timestamp and pid", async () => {
		recordOAuthEvent({ event: "refresh.start", server: "monday", refreshToken: fingerprint("secret-refresh") });
		recordOAuthEvent({ event: "refresh.ok", server: "monday", rotated: true });

		const events = await readOAuthEvents();
		expect(events.map((event) => event.event)).toEqual(["refresh.start", "refresh.ok"]);
		expect(events[0]?.pid).toBe(process.pid);
		expect(Number.isNaN(Date.parse(events[0]?.ts ?? ""))).toBe(false);
		expect(events[1]?.rotated).toBe(true);
	});

	it("never writes a raw secret, only a short one-way fingerprint", async () => {
		recordOAuthEvent({
			event: "refresh.ok",
			server: "gws",
			refreshToken: fingerprint("super-secret-refresh-token"),
			newRefreshToken: fingerprint("rotated-refresh-token"),
		});

		const raw = readFileSync(logPath, "utf8");
		expect(raw).not.toContain("super-secret-refresh-token");
		expect(raw).not.toContain("rotated-refresh-token");
		const events = await readOAuthEvents();
		expect(events[0]?.refreshToken).toHaveLength(12);
		expect(events[0]?.refreshToken).toBe(fingerprint("super-secret-refresh-token"));
		expect(events[0]?.refreshToken).not.toBe(events[0]?.newRefreshToken);
	});

	it("writes the log readable only by its owner", () => {
		recordOAuthEvent({ event: "login.ok", server: "serval" });
		expect(statSync(logPath).mode & 0o077).toBe(0);
	});

	it("filters by server, and keeps the newest events rather than the oldest", async () => {
		recordOAuthEvent({ event: "login.ok", server: "monday" });
		recordOAuthEvent({ event: "login.ok", server: "serval" });
		recordOAuthEvent({ event: "refresh.ok", server: "serval" });

		expect((await readOAuthEvents({ server: "SERVAL" })).map((event) => event.event)).toEqual([
			"login.ok",
			"refresh.ok",
		]);
		// A limit keeps the most recent, which is the end of the file: returning the
		// oldest would pass a bare length check while showing the wrong evidence.
		const limited = await readOAuthEvents({ limit: 1 });
		expect(limited).toHaveLength(1);
		expect(limited[0]?.event).toBe("refresh.ok");
		expect(limited[0]?.server).toBe("serval");
	});

	it("drops events older than the cutoff and keeps newer ones", async () => {
		writeFileSync(
			logPath,
			`{"ts":"2026-09-01T00:00:00.000Z","pid":1,"event":"login.ok","server":"old"}\n` +
				`{"ts":"2026-09-30T00:00:00.000Z","pid":1,"event":"refresh.ok","server":"new"}\n`,
			"utf8",
		);

		const cutoff = Date.parse("2026-09-15T00:00:00.000Z");
		expect((await readOAuthEvents({ since: cutoff })).map((event) => event.server)).toEqual(["new"]);
		expect((await readOAuthEvents({ since: Date.parse("2026-08-01T00:00:00.000Z") })).map((e) => e.server)).toEqual([
			"old",
			"new",
		]);
	});

	it("skips a corrupt line rather than losing the whole trail", async () => {
		recordOAuthEvent({ event: "login.ok", server: "monday" });
		writeFileSync(logPath, `${readFileSync(logPath, "utf8")}{"ts":"broken\n`, "utf8");
		recordOAuthEvent({ event: "refresh.ok", server: "monday" });

		expect((await readOAuthEvents()).map((event) => event.event)).toEqual(["login.ok", "refresh.ok"]);
	});

	it("reads the rotated generation as well as the current one", async () => {
		writeFileSync(`${logPath}.1`, `{"ts":"2026-09-01T00:00:00.000Z","pid":1,"event":"login.ok","server":"old"}\n`);
		recordOAuthEvent({ event: "refresh.ok", server: "new" });

		expect((await readOAuthEvents()).map((event) => event.server)).toEqual(["old", "new"]);
	});

	it("records nothing when logging is switched off", async () => {
		process.env[AUTH_LOG_ENV_VAR] = "off";
		recordOAuthEvent({ event: "login.ok", server: "monday" });
		expect(auditLogPath()).toBeUndefined();

		// Read with logging back on: asserting emptiness while reads are also
		// disabled would pass even if the event had been written.
		process.env[AUTH_LOG_ENV_VAR] = logPath;
		expect(existsSync(logPath)).toBe(false);
		expect(await readOAuthEvents()).toEqual([]);
	});

	it("tightens the permissions of a log that already existed world-readable", () => {
		writeFileSync(logPath, "", { mode: 0o644 });
		chmodSync(logPath, 0o644);
		recordOAuthEvent({ event: "login.ok", server: "monday" });

		expect(statSync(logPath).mode & 0o077).toBe(0);
	});

	it("gives genuinely separate processes the same key, even racing from nothing", async () => {
		// Correlating events *across* processes is the whole point of the key, so
		// this is the one property worth real processes to check: a same-process
		// assertion cannot observe a publication race at all.
		expect(new Set(await fingerprintFromProcesses(8, logPath)).size).toBe(1);
		expect(readFileSync(`${logPath}.key`).length).toBe(32);
		// No staging file survives a clean run.
		expect(readdirSync(dir).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
	});

	it("repairs a truncated key rather than leaving every process on its own", async () => {
		// An unusable key file used to send each process off with a private key,
		// silently ending cross-process correlation with nothing reported anywhere.
		writeFileSync(`${logPath}.key`, randomBytes(1), { mode: 0o600 });

		expect(new Set(await fingerprintFromProcesses(6, logPath)).size).toBe(1);
		expect(readFileSync(`${logPath}.key`).length).toBe(32);
	});

	it("never falls back to a known key when the key file is empty or half-written", () => {
		// A racing creator can leave a zero-length or short file behind. Adopting it
		// would make every fingerprint an HMAC under a key the reader can guess,
		// which is the offline verifier the key was introduced to remove.
		for (const partial of [Buffer.alloc(0), randomBytes(1), randomBytes(31)]) {
			// A distinct path per case: the key is cached per path, so reusing one
			// would mean only the first case ever reached a file at all.
			const scoped = join(dir, `partial-${partial.length}.jsonl`);
			process.env[AUTH_LOG_ENV_VAR] = scoped;
			writeFileSync(`${scoped}.key`, partial, { mode: 0o600 });
			const produced = fingerprint(`123456-${partial.length}`);
			expect(produced).not.toBe(
				createHmac("sha256", partial).update(`123456-${partial.length}`).digest("hex").slice(0, 12),
			);
			expect(produced).not.toBe(createHash("sha256").update(`123456-${partial.length}`).digest("hex").slice(0, 12));
		}
	});

	it("adopts a key another process published instead of overwriting it", () => {
		// Overwriting would leave the two processes fingerprinting under different
		// keys, which silently destroys the cross-process correlation the log is for.
		const published = randomBytes(32);
		writeFileSync(`${logPath}.key`, published, { mode: 0o600 });

		expect(fingerprint("seeded-refresh")).toBe(
			createHmac("sha256", published).update("seeded-refresh").digest("hex").slice(0, 12),
		);
		expect(readFileSync(`${logPath}.key`).equals(published)).toBe(true);
	});

	it("rotates an oversized log, leaving the previous generation readable and private", async () => {
		// One 4MB+ line: rotation is decided on size, and this keeps the fixture to a
		// single event that must survive into the rotated generation.
		const filler = "x".repeat(AUTH_LOG_MAX_BYTES);
		writeFileSync(logPath, `{"ts":"2026-09-01T00:00:00.000Z","pid":1,"event":"login.ok","server":"${filler}"}\n`, {
			mode: 0o600,
		});
		recordOAuthEvent({ event: "refresh.ok", server: "after-rotation" });

		expect(existsSync(`${logPath}.1`)).toBe(true);
		expect(statSync(`${logPath}.1`).mode & 0o077).toBe(0);
		// The current file holds only the new event, and the guard is handed back.
		expect(statSync(logPath).size).toBeLessThan(AUTH_LOG_MAX_BYTES);
		expect(existsSync(`${logPath}.rotating`)).toBe(false);
		// And both generations are still readable, newest last.
		expect((await readOAuthEvents()).map((event) => event.event)).toEqual(["login.ok", "refresh.ok"]);
	});

	it("leaves rotation to whoever holds the guard, and steals only a stale one", () => {
		const filler = "x".repeat(AUTH_LOG_MAX_BYTES);
		writeFileSync(logPath, `{"event":"login.ok","server":"${filler}"}\n`, { mode: 0o600 });
		// A peer is mid-rotation: this writer must append, not rename its file away.
		writeFileSync(`${logPath}.rotating`, "", { mode: 0o600 });
		recordOAuthEvent({ event: "refresh.ok", server: "monday" });
		expect(existsSync(`${logPath}.1`)).toBe(false);

		// A guard left by a process that died must not wedge rotation forever.
		const stale = Date.now() - 10 * 60_000;
		utimesSync(`${logPath}.rotating`, new Date(stale), new Date(stale));
		recordOAuthEvent({ event: "refresh.ok", server: "monday" });
		expect(existsSync(`${logPath}.1`)).toBe(true);
	});

	it("writes no key file at all when recording is switched off", () => {
		// Otherwise a `.key` lands in whatever the process's working directory is.
		const cwdKey = join(process.cwd(), ".key");
		process.env[AUTH_LOG_ENV_VAR] = "off";
		expect(fingerprint("123456")).toBeDefined();
		expect(existsSync(cwdKey)).toBe(false);
	});

	it("keeps a truncated rotated generation from swallowing the next file's first event", async () => {
		// Generations are parsed separately: joined, a partial last line would glue
		// itself onto a good one and take a real event down with it.
		writeFileSync(
			`${logPath}.1`,
			`{"ts":"2026-09-01T00:00:00.000Z","pid":1,"event":"login.ok","server":"old"}\n{"ts":"2026`,
		);
		writeFileSync(logPath, `{"ts":"2026-09-02T00:00:00.000Z","pid":1,"event":"refresh.ok","server":"new"}\n`);

		expect((await readOAuthEvents()).map((event) => event.server)).toEqual(["old", "new"]);
	});

	it("keys fingerprints with a machine-local secret, so they are not an offline verifier", async () => {
		// A bare hash of a low-entropy credential could be brute-forced by anyone
		// holding the log; with a key file they cannot even check a guess.
		const lowEntropy = "123456";
		expect(fingerprint(lowEntropy)).not.toBe(createHash("sha256").update(lowEntropy).digest("hex").slice(0, 12));
		expect(existsSync(`${logPath}.key`)).toBe(true);
		expect(statSync(`${logPath}.key`).mode & 0o077).toBe(0);
		// Stable within the machine, which is what cross-process correlation needs.
		expect(fingerprint(lowEntropy)).toBe(fingerprint(lowEntropy));
	});

	it("defaults into the credential store directory", () => {
		delete process.env[AUTH_LOG_ENV_VAR];
		process.env.PHI_MCP_AUTH_DIR = dir;
		expect(auditLogPath()).toBe(join(dir, DEFAULT_AUTH_LOG_NAME));
	});

	it("records only the origin, because a token can sit in the path too", () => {
		expect(safeUrl("https://example.com/mcp?code=abc#state=xyz")).toBe("https://example.com");
		expect(safeUrl("https://example.com/mcp/sk-live-SECRET")).toBe("https://example.com");
		expect(safeUrl("not a url")).toBeUndefined();
	});

	it("survives an unwritable log without throwing", () => {
		process.env[AUTH_LOG_ENV_VAR] = join(dir, "missing-dir\0bad", "events.jsonl");
		expect(() => recordOAuthEvent({ event: "login.ok", server: "monday" })).not.toThrow();
	});
});
