#!/usr/bin/env node
/**
 * Usage: node scripts/compaction-stats.mjs <sessions-dir> [--days 30]
 * Summarize recent, persisted context compactions from JSONL session files.
 */

import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const DAY_MS = 24 * 60 * 60 * 1000;
const RE_READ_TURNS = 15;

function isRecord(value) {
	return value !== null && typeof value === "object";
}

function expandHome(value) {
	if (value === "~") return homedir();
	if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
	return value;
}

function parseArgs(argv) {
	let sessionsDir = DEFAULT_SESSIONS_DIR;
	let days = 30;
	let positionalSeen = false;

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			console.log("Usage: node scripts/compaction-stats.mjs <sessions-dir> [--days 30]");
			process.exit(0);
		}
		if (arg === "--days") {
			const value = argv[++index];
			if (value === undefined) throw new Error("--days requires a number");
			days = Number(value);
			continue;
		}
		if (arg.startsWith("--days=")) {
			days = Number(arg.slice("--days=".length));
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`);
		if (positionalSeen) throw new Error(`Unexpected argument: ${arg}`);
		sessionsDir = expandHome(arg);
		positionalSeen = true;
	}

	if (!Number.isFinite(days) || days < 0) throw new Error("--days must be a non-negative number");
	return { sessionsDir: expandHome(sessionsDir), days };
}

async function* walkJsonlFiles(directory) {
	let entries;
	try {
		entries = await readdir(directory, { withFileTypes: true });
	} catch {
		return;
	}

	entries.sort((left, right) => left.name.localeCompare(right.name));
	for (const entry of entries) {
		const fullPath = path.join(directory, entry.name);
		if (entry.isDirectory()) yield* walkJsonlFiles(fullPath);
		else if (entry.isFile() && entry.name.endsWith(".jsonl")) yield fullPath;
	}
}

async function readSessionEntries(filePath) {
	const entries = [];
	let malformedLines = 0;
	let input;
	try {
		input = createReadStream(filePath, { encoding: "utf8" });
		const lines = createInterface({ input, crlfDelay: Infinity });
		for await (const line of lines) {
			if (!line.trim()) continue;
			try {
				const entry = JSON.parse(line);
				if (isRecord(entry)) entries.push(entry);
				else malformedLines++;
			} catch {
				malformedLines++;
			}
		}
	} catch {
		return { entries: [], malformedLines: malformedLines + 1 };
	}
	return { entries, malformedLines };
}

function finiteNumber(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	return null;
}

function formatInteger(value) {
	return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "-";
}

function formatMedian(value) {
	return Number.isFinite(value) ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : "-";
}

function formatCost(usage) {
	if (!isRecord(usage)) return "-";
	const cost = usage.cost;
	const total = finiteNumber(cost) ?? (isRecord(cost) ? finiteNumber(cost.total) : null);
	return total === null ? "-" : `$${total.toFixed(4)}`;
}

function formatTrigger(value) {
	if (typeof value === "string" && value.length > 0) return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "-";
}

function isSummaryCompaction(entry) {
	if (entry.type !== "compaction" || entry.mode === "prune") return false;
	return typeof entry.summary === "string" && entry.summary.trim().length > 0;
}

function isExtensionCompaction(entry) {
	return entry.fromExtension === true || entry.fromHook === true;
}

function entryMessage(entry) {
	if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return null;
	return entry.message;
}

function classifyPosition(entries, compactionIndex) {
	// Non-message entries (custom state, labels, etc.) do not have a turn role;
	// walk back to the preceding persisted message when necessary.
	for (let index = compactionIndex - 1; index >= 0; index--) {
		const previous = entryMessage(entries[index]);
		if (!previous) continue;
		if (previous.role === "user" || previous.role === "toolResult") return "mid-run";
		if (previous.role === "assistant") {
			const stopReason = previous.stopReason ?? previous.stop_reason;
			if (stopReason === "stop" || stopReason === "end_turn") return "run-end";
		}
		return "-";
	}
	return "-";
}

function postCompactionContext(entries, compactionIndex) {
	for (let index = compactionIndex + 1; index < entries.length; index++) {
		const message = entryMessage(entries[index]);
		if (!message || message.role !== "assistant") continue;
		if (!isRecord(message.usage)) return null;
		const fields = [message.usage.input, message.usage.cacheRead, message.usage.cacheWrite];
		const numbers = fields.map(finiteNumber).filter((value) => value !== null);
		return numbers.length > 0 ? numbers.reduce((sum, value) => sum + value, 0) : null;
	}
	return null;
}

function normalizedPath(value) {
	return typeof value === "string" ? path.normalize(value) : null;
}

function samePath(left, right) {
	if (left === right) return true;
	const normalizedLeft = normalizedPath(left);
	const normalizedRight = normalizedPath(right);
	return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

function readFilePaths(entry) {
	if (!isRecord(entry.details) || !Array.isArray(entry.details.readFiles)) return [];
	return entry.details.readFiles.filter((value) => typeof value === "string" && value.length > 0);
}

function toolCallPaths(message) {
	if (!Array.isArray(message.content)) return [];
	const calls = [];
	for (const block of message.content) {
		if (!isRecord(block) || block.type !== "toolCall") continue;
		const name = typeof block.name === "string" ? block.name.toLowerCase() : "";
		if (name !== "read" || !isRecord(block.arguments)) continue;
		const candidate = block.arguments.path ?? block.arguments.filePath ?? block.arguments.file_path;
		if (typeof candidate === "string" && candidate.length > 0) {
			calls.push({ id: typeof block.id === "string" ? block.id : null, path: candidate });
		}
	}
	return calls;
}

function reReadCount(entries, compactionIndex, readFiles) {
	if (readFiles.length === 0) return 0;
	const matchedFiles = new Set();
	const pendingReadCalls = new Map();
	let assistantTurns = 0;

	for (let index = compactionIndex + 1; index < entries.length; index++) {
		const message = entryMessage(entries[index]);
		if (!message) continue;
		if (message.role === "assistant") {
			if (assistantTurns >= RE_READ_TURNS) break;
			assistantTurns++;
			for (const call of toolCallPaths(message)) {
				if (call.id) pendingReadCalls.set(call.id, call.path);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const toolName = typeof message.toolName === "string" ? message.toolName.toLowerCase() : "";
		if (toolName !== "read") continue;
		const callPath = typeof message.toolCallId === "string" ? pendingReadCalls.get(message.toolCallId) : undefined;
		const resultPath =
			callPath ??
			(isRecord(message.details) && typeof message.details.path === "string" ? message.details.path : null);
		if (!resultPath) continue;
		for (const readFile of readFiles) {
			if (samePath(resultPath, readFile)) matchedFiles.add(readFile);
		}
	}
	return matchedFiles.size;
}

function median(values) {
	const sorted = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
	if (sorted.length === 0) return null;
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function padCell(value, width, rightAlign = false) {
	return rightAlign ? value.padStart(width) : value.padEnd(width);
}

function printReport(rows) {
	const headers = ["session", "timestamp", "tokensBefore", "trigger", "position", "postCtx", "cost", "reRead"];
	const values = rows.map((row) => [
		row.session,
		row.timestamp,
		formatInteger(row.tokensBefore),
		row.trigger,
		row.position,
		formatInteger(row.postContext),
		formatCost(row.usage),
		String(row.reReads),
	]);
	const widths = headers.map((header, index) => Math.max(header.length, ...values.map((row) => row[index].length)));
	const rightAligned = new Set([2, 5, 6, 7]);
	const render = (row) => row.map((value, index) => padCell(value, widths[index], rightAligned.has(index))).join("  ");

	console.log(render(headers));
	console.log(widths.map((width) => "-".repeat(width)).join("  "));
	for (const row of values) console.log(render(row));

	const tokens = rows.map((row) => row.tokensBefore).filter((value) => Number.isFinite(value));
	const midRunCount = rows.filter((row) => row.position === "mid-run").length;
	const triggerHistogram = new Map();
	for (const row of rows) triggerHistogram.set(row.trigger, (triggerHistogram.get(row.trigger) ?? 0) + 1);
	const histogram = [...triggerHistogram.entries()]
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([trigger, count]) => `${trigger}: ${count}`)
		.join(", ");
	const meanReReads = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.reReads, 0) / rows.length;

	console.log("");
	console.log("Footer");
	console.log(`count: ${rows.length}`);
	console.log(`median tokensBefore: ${formatMedian(median(tokens))}`);
	console.log(`share mid-run: ${rows.length === 0 ? "0.0" : ((midRunCount / rows.length) * 100).toFixed(1)}%`);
	console.log(`trigger histogram: ${histogram || "-"}`);
	console.log(`mean re-read count: ${meanReReads.toFixed(2)}`);
}

async function main() {
	const { sessionsDir, days } = parseArgs(process.argv.slice(2));
	const now = Date.now();
	const cutoff = now - days * DAY_MS;
	const rows = [];

	for await (const filePath of walkJsonlFiles(sessionsDir)) {
		const { entries } = await readSessionEntries(filePath);
		for (let index = 0; index < entries.length; index++) {
			const entry = entries[index];
			if (!isSummaryCompaction(entry) || (isExtensionCompaction(entry) && !entry.summary.trim())) continue;
			const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
			const timestampMs = Date.parse(timestamp);
			if (!Number.isFinite(timestampMs) || timestampMs < cutoff || timestampMs > now) continue;

			rows.push({
				session: path.basename(filePath),
				timestamp,
				tokensBefore: finiteNumber(entry.tokensBefore),
				trigger: formatTrigger(entry.trigger),
				position: classifyPosition(entries, index),
				postContext: postCompactionContext(entries, index),
				usage: entry.usage,
				reReads: reReadCount(entries, index, readFilePaths(entry)),
			});
		}
	}

	rows.sort(
		(left, right) => left.timestamp.localeCompare(right.timestamp) || left.session.localeCompare(right.session),
	);
	printReport(rows);
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
