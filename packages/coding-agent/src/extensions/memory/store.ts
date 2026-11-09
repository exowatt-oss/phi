import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MEMORY_INDEX_FILE = "MEMORY.md";
/** Hard cap on how much of MEMORY.md gets injected into the system prompt. */
export const MAX_INDEX_BYTES = 8192;

export const SEED_INDEX = `# Project memory index

One line per memory: \`- [Title](file.md) — one-line hook.\`

(No memories saved yet.)
`;

/** Create the memory dir and seed MEMORY.md if missing. Never overwrites. */
export function ensureMemoryDir(memoryDir: string): void {
	mkdirSync(memoryDir, { recursive: true });
	const indexPath = join(memoryDir, MEMORY_INDEX_FILE);
	if (!existsSync(indexPath)) writeFileSync(indexPath, SEED_INDEX, "utf-8");
}

/** Read MEMORY.md, truncated to MAX_INDEX_BYTES on a line boundary. */
export function readIndex(memoryDir: string): { content: string; truncated: boolean } {
	let raw: string;
	try {
		raw = readFileSync(join(memoryDir, MEMORY_INDEX_FILE), "utf-8");
	} catch {
		return { content: "(index unreadable)", truncated: false };
	}
	if (Buffer.byteLength(raw, "utf-8") <= MAX_INDEX_BYTES) {
		return { content: raw, truncated: false };
	}
	const lines = raw.split("\n");
	let out = "";
	for (const line of lines) {
		if (Buffer.byteLength(`${out}${line}\n`, "utf-8") > MAX_INDEX_BYTES) break;
		out += `${line}\n`;
	}
	return { content: out, truncated: true };
}

/** Count `- [` index lines, for /memory status. */
export function countIndexEntries(indexContent: string): number {
	return indexContent.split("\n").filter((l) => l.trimStart().startsWith("- [")).length;
}
