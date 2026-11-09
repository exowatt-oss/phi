import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { getMemoryDir } from "./paths.ts";
import { buildMemorySection } from "./prompt-section.ts";
import { countIndexEntries, ensureMemoryDir, readIndex } from "./store.ts";

export default function memoryExtension(pi: ExtensionAPI): void {
	let section: string | undefined;
	let memoryDir: string | undefined;
	let entryCount = 0;

	pi.registerFlag("no-memory", {
		description: "Disable persistent agent memory for this run",
		type: "boolean",
		default: false,
	});

	const disabled = (): boolean => {
		const env = process.env.PHI_MEMORY ?? process.env.PI_MEMORY;
		if (env === "0" || env === "false") return true;
		return pi.getFlag("no-memory") === true;
	};

	const load = (cwd: string, notify?: (message: string, type?: "info" | "warning" | "error") => void): void => {
		memoryDir = getMemoryDir(cwd);
		try {
			ensureMemoryDir(memoryDir);
			const { content, truncated } = readIndex(memoryDir);
			entryCount = countIndexEntries(content);
			section = buildMemorySection(memoryDir, content, truncated);
		} catch (error) {
			section = undefined;
			entryCount = 0;
			notify?.(`Memory unavailable: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		if (disabled()) {
			section = undefined;
			return;
		}
		load(ctx.cwd, ctx.ui.notify);
	});

	pi.on("before_agent_start", async (event) => {
		if (!section || disabled()) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${section}` };
	});

	pi.registerCommand("memory", {
		description: "Persistent project memory: status | path | reload",
		getArgumentCompletions: (prefix) =>
			["reload", "path"].filter((s) => s.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (disabled()) {
				ctx.ui.notify("Memory is disabled (--no-memory / PHI_MEMORY=0)", "info");
				return;
			}
			const arg = (args ?? "").trim();
			if (arg === "reload") {
				load(ctx.cwd, ctx.ui.notify);
				ctx.ui.notify(`Memory reloaded: ${entryCount} entries from ${memoryDir}`, "info");
				return;
			}
			if (!memoryDir) load(ctx.cwd, ctx.ui.notify);
			if (arg === "path") {
				ctx.ui.notify(String(memoryDir), "info");
				return;
			}
			ctx.ui.notify(`${entryCount} memories · ${memoryDir} · edit files there or ask me to remember things`, "info");
		},
	});
}
