import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { projectDirName } from "../src/core/project-dir-name.ts";
import { getDefaultSessionDir } from "../src/core/session-manager.ts";
import memoryExtension from "../src/extensions/memory/index.ts";
import { getMemoryDir } from "../src/extensions/memory/paths.ts";
import { countIndexEntries, MAX_INDEX_BYTES, MEMORY_INDEX_FILE, SEED_INDEX } from "../src/extensions/memory/store.ts";
import { resolvePath } from "../src/utils/paths.ts";

type LoadedExtension = Awaited<ReturnType<typeof loadExtensionFromFactory>>;

// A fixed project cwd. The memory dir is derived from this via projectDirName and
// lives under the temp agent dir, so this path itself need not exist on disk.
const PROJECT_CWD = "/Users/test/phi-memory-project";

let agentDir: string;
let runtime: ReturnType<typeof createExtensionRuntime>;
let notify: ReturnType<typeof vi.fn>;
let ctx: never;

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "PHI_CODING_AGENT_DIR", "PHI_MEMORY", "PI_MEMORY"];

async function loadMemory(): Promise<LoadedExtension> {
	runtime = createExtensionRuntime();
	return loadExtensionFromFactory(memoryExtension, PROJECT_CWD, createEventBus(), runtime, "<inline:memory>");
}

/** Invoke every handler registered for `name`, returning the last defined result. */
async function dispatch(ext: LoadedExtension, name: string, event: unknown): Promise<unknown> {
	const handlers = (ext.handlers as Map<string, Array<(e: unknown, c: unknown) => unknown>>).get(name) ?? [];
	let result: unknown;
	for (const handler of handlers) {
		const r = await handler(event, ctx);
		if (r !== undefined) result = r;
	}
	return result;
}

function sessionStart(ext: LoadedExtension): Promise<unknown> {
	return dispatch(ext, "session_start", { type: "session_start", reason: "startup" });
}

function beforeAgentStart(ext: LoadedExtension, systemPrompt: string): Promise<unknown> {
	return dispatch(ext, "before_agent_start", {
		type: "before_agent_start",
		prompt: "",
		systemPrompt,
		systemPromptOptions: {},
	});
}

async function runMemoryCommand(ext: LoadedExtension, args: string): Promise<void> {
	const command = ext.commands.get("memory");
	if (!command) throw new Error("memory command not registered");
	await command.handler(args, ctx as never);
}

/** Pull the injected MEMORY.md body out of the <memory_index> block. */
function extractIndexBlock(section: string): string {
	const match = section.match(/<memory_index[^>]*>\n([\s\S]*)\n<\/memory_index>/);
	if (!match) throw new Error("no <memory_index> block in section");
	return match[1];
}

beforeEach(() => {
	for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
	agentDir = mkdtempSync(join(tmpdir(), "phi-memory-"));
	// The extension resolves the agent dir via PHI_CODING_AGENT_DIR first, then the
	// PI_* compat spelling. Clear the branded name so the PI_* override wins, per task.
	delete process.env.PHI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PHI_MEMORY;
	delete process.env.PI_MEMORY;
	notify = vi.fn();
	ctx = { cwd: PROJECT_CWD, ui: { notify }, sessionManager: { getSessionId: () => "s" } } as never;
});

afterEach(() => {
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	try {
		chmodSync(agentDir, 0o755);
	} catch {
		// best-effort: dir may not exist or already be writable
	}
	rmSync(agentDir, { recursive: true, force: true });
});

describe("memory extension", () => {
	it("1. encoding parity: memory and session dirs share projectDirName", async () => {
		const expected = projectDirName(resolvePath(PROJECT_CWD));
		expect(basename(getMemoryDir(PROJECT_CWD))).toBe(expected);
		// getDefaultSessionDir mkdirs under the temp agent dir; the trailing segment
		// must match, pinning the extracted-encoding refactor.
		expect(basename(getDefaultSessionDir(PROJECT_CWD))).toBe(expected);
		expect(basename(getMemoryDir(PROJECT_CWD))).toBe(basename(getDefaultSessionDir(PROJECT_CWD)));
	});

	it("2. seeding: session_start creates dir + seeds MEMORY.md, never overwrites", async () => {
		const ext = await loadMemory();
		const memoryDir = getMemoryDir(PROJECT_CWD);
		const indexPath = join(memoryDir, MEMORY_INDEX_FILE);

		await sessionStart(ext);
		expect(existsSync(memoryDir)).toBe(true);
		expect(readFileSync(indexPath, "utf-8")).toBe(SEED_INDEX);

		writeFileSync(indexPath, "# edited by user\n", "utf-8");
		await sessionStart(ext);
		expect(readFileSync(indexPath, "utf-8")).toBe("# edited by user\n");
	});

	it("3. injection: before_agent_start prepends memory section", async () => {
		const ext = await loadMemory();
		await sessionStart(ext);
		const result = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };

		expect(result.systemPrompt.startsWith("BASE")).toBe(true);
		expect(result.systemPrompt).toContain("<agent_memory>");
		expect(result.systemPrompt).toContain(getMemoryDir(PROJECT_CWD));
		expect(result.systemPrompt).toContain("One line per memory");
	});

	it("4. stability: consecutive before_agent_start calls are byte-identical", async () => {
		const ext = await loadMemory();
		await sessionStart(ext);
		const a = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };
		const b = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };
		expect(a.systemPrompt).toBe(b.systemPrompt);
	});

	it("5. staleness: edits ignored until /memory reload", async () => {
		const ext = await loadMemory();
		await sessionStart(ext);
		const indexPath = join(getMemoryDir(PROJECT_CWD), MEMORY_INDEX_FILE);

		const before = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };
		writeFileSync(indexPath, "- [Fresh](fresh.md) — a new memory line.\n", "utf-8");

		const stale = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };
		expect(stale.systemPrompt).toBe(before.systemPrompt);
		expect(stale.systemPrompt).not.toContain("Fresh");

		await runMemoryCommand(ext, "reload");
		const fresh = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };
		expect(fresh.systemPrompt).toContain("[Fresh](fresh.md)");
	});

	it("6. truncation: oversize index truncated on a line boundary with NOTE", async () => {
		const ext = await loadMemory();
		await sessionStart(ext);
		const indexPath = join(getMemoryDir(PROJECT_CWD), MEMORY_INDEX_FILE);

		const lines: string[] = ["- [MARKER_FIRST](first.md) — the very first entry."];
		let i = 0;
		while (Buffer.byteLength(lines.join("\n"), "utf-8") < MAX_INDEX_BYTES + 4000) {
			lines.push(`- [Entry ${i}](entry-${i}.md) — ${"padding ".repeat(6)}hook.`);
			i++;
		}
		lines.push("- [MARKER_LAST](last.md) — the very last entry.");
		writeFileSync(indexPath, `${lines.join("\n")}\n`, "utf-8");

		await runMemoryCommand(ext, "reload");
		const result = (await beforeAgentStart(ext, "BASE")) as { systemPrompt: string };

		expect(result.systemPrompt).toContain("MARKER_FIRST");
		expect(result.systemPrompt).not.toContain("MARKER_LAST");
		expect(result.systemPrompt).toContain("NOTE: the index above was truncated");

		const block = extractIndexBlock(result.systemPrompt);
		expect(Buffer.byteLength(block, "utf-8")).toBeLessThanOrEqual(MAX_INDEX_BYTES);
		// Truncation happens on a whole-line boundary: the kept content ends with a
		// newline and the last non-empty line is a complete entry (ends with ".").
		expect(block.endsWith("\n")).toBe(true);
		const keptLines = block.split("\n").filter((l) => l.length > 0);
		expect(keptLines.at(-1)?.endsWith(".")).toBe(true);
	});

	it("7. off-switches: PHI_MEMORY=0, PI_MEMORY=0, and --no-memory flag", async () => {
		process.env.PHI_MEMORY = "0";
		let ext = await loadMemory();
		await sessionStart(ext);
		expect(existsSync(getMemoryDir(PROJECT_CWD))).toBe(false);
		expect(await beforeAgentStart(ext, "BASE")).toBeUndefined();

		delete process.env.PHI_MEMORY;
		process.env.PI_MEMORY = "0";
		ext = await loadMemory();
		await sessionStart(ext);
		expect(existsSync(getMemoryDir(PROJECT_CWD))).toBe(false);
		expect(await beforeAgentStart(ext, "BASE")).toBeUndefined();

		// Optional flag case: the harness can flip the registered flag directly.
		delete process.env.PI_MEMORY;
		ext = await loadMemory();
		runtime.flagValues.set("no-memory", true);
		await sessionStart(ext);
		expect(existsSync(getMemoryDir(PROJECT_CWD))).toBe(false);
		expect(await beforeAgentStart(ext, "BASE")).toBeUndefined();
	});

	it("8. /memory command: status, path, and entry count", async () => {
		const ext = await loadMemory();
		await sessionStart(ext);
		const memoryDir = getMemoryDir(PROJECT_CWD);
		const indexPath = join(memoryDir, MEMORY_INDEX_FILE);

		const index = [
			"# Project memory index",
			"",
			"- [User](user.md) — who the user is.",
			"- [Feedback](feedback.md) — a correction.",
			"- [Project](project.md) — a gotcha.",
			"",
		].join("\n");
		writeFileSync(indexPath, index, "utf-8");
		expect(countIndexEntries(index)).toBe(3);

		await runMemoryCommand(ext, "reload");
		notify.mockClear();

		await runMemoryCommand(ext, "");
		const bare = notify.mock.calls.at(-1)?.[0] as string;
		expect(bare).toContain("3 memories");
		expect(bare).toContain(memoryDir);

		notify.mockClear();
		await runMemoryCommand(ext, "path");
		expect(notify.mock.calls.at(-1)?.[0]).toBe(memoryDir);
	});

	it("9. FS failure: session_start does not throw, injection off, warning emitted", async () => {
		// Point the agent dir at a path under a read-only parent so mkdir of memory/ fails.
		const roParent = mkdtempSync(join(tmpdir(), "phi-memory-ro-"));
		process.env.PI_CODING_AGENT_DIR = join(roParent, "agent");
		chmodSync(roParent, 0o555);
		try {
			const ext = await loadMemory();
			await expect(sessionStart(ext)).resolves.not.toThrow();
			expect(await beforeAgentStart(ext, "BASE")).toBeUndefined();
			const warned = notify.mock.calls.some(
				(call) => call[1] === "warning" && String(call[0]).includes("Memory unavailable"),
			);
			expect(warned).toBe(true);
		} finally {
			chmodSync(roParent, 0o755);
			rmSync(roParent, { recursive: true, force: true });
		}
	});
});
