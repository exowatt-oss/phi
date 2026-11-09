import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { lock } from "proper-lockfile";
import { asRecord, safeJsonParse } from "./json.ts";

/** Bump this when the private enablement representation changes incompatibly. */
export const MCP_ENABLEMENT_VERSION = 1;
export const MCP_ENABLEMENT_FILE_NAME = "mcp-enablement-v1.json";

export interface McpEnablementRecord {
	configKey: string;
	serverName: string;
	fingerprint: string;
	enabled: boolean;
}

interface EnablementDocument {
	version: number;
	entries: McpEnablementRecord[];
}

export function enablementPath(agentDir: string): string {
	return join(agentDir, MCP_ENABLEMENT_FILE_NAME);
}

/**
 * The path is deliberately only an input to this hash. It is never persisted
 * in the sidecar, which keeps alternate config locations private.
 */
export function enablementConfigKey(configPath: string, serverName: string, fingerprint: string): string {
	return createHash("sha256")
		.update(`${resolve(configPath)}\u0000${serverName}\u0000${fingerprint}`)
		.digest("hex");
}

/** Read valid state only; absent, malformed, or unreadable state means no overrides. */
export async function loadEnablementRecords(agentDir: string): Promise<readonly McpEnablementRecord[]> {
	try {
		const raw = await readFile(enablementPath(agentDir), "utf8");
		const document = parseDocument(safeJsonParse(raw));
		return document?.entries ?? [];
	} catch {
		return [];
	}
}

export async function readEnablement(
	agentDir: string,
	configPath: string,
	serverName: string,
	fingerprint: string,
): Promise<boolean | undefined> {
	const key = enablementConfigKey(configPath, serverName, fingerprint);
	const record = (await loadEnablementRecords(agentDir)).find(
		(entry) => entry.configKey === key && entry.serverName === serverName && entry.fingerprint === fingerprint,
	);
	return record?.enabled;
}

/**
 * Commit one override while holding a cross-process lock. The state file is
 * replaced atomically in its own directory, so readers never observe a partial
 * JSON document and concurrent writers cannot lose each other's changes.
 */
export async function writeEnablement(
	agentDir: string,
	configPath: string,
	serverName: string,
	fingerprint: string,
	enabled: boolean,
): Promise<void> {
	const path = enablementPath(agentDir);
	await mkdir(agentDir, { recursive: true, mode: 0o700 });
	await ensureStateFile(path);
	const release = await lock(path, {
		realpath: false,
		stale: 10_000,
		retries: { retries: 5, minTimeout: 10, maxTimeout: 100 },
	});
	try {
		const current = await readDocument(path);
		const key = enablementConfigKey(configPath, serverName, fingerprint);
		const entries = current?.entries ? [...current.entries] : [];
		const replacement: McpEnablementRecord = { configKey: key, serverName, fingerprint, enabled };
		const index = entries.findIndex((entry) => entry.configKey === key);
		if (index >= 0) entries[index] = replacement;
		else entries.push(replacement);
		entries.sort((left, right) => left.configKey.localeCompare(right.configKey));
		await atomicWrite(path, { version: MCP_ENABLEMENT_VERSION, entries });
	} finally {
		await release();
	}
}

function parseDocument(value: unknown): EnablementDocument | undefined {
	const record = asRecord(value);
	if (
		!record ||
		record.version !== MCP_ENABLEMENT_VERSION ||
		!Array.isArray(record.entries) ||
		!hasExactly(Object.keys(record), ["entries", "version"])
	)
		return undefined;
	const entries: McpEnablementRecord[] = [];
	for (const value of record.entries) {
		const entry = asRecord(value);
		if (
			!entry ||
			!hasExactly(Object.keys(entry), ["configKey", "enabled", "fingerprint", "serverName"]) ||
			typeof entry.configKey !== "string" ||
			!entry.configKey ||
			typeof entry.serverName !== "string" ||
			!entry.serverName ||
			typeof entry.fingerprint !== "string" ||
			!entry.fingerprint ||
			typeof entry.enabled !== "boolean"
		) {
			return undefined;
		}
		entries.push({
			configKey: entry.configKey,
			serverName: entry.serverName,
			fingerprint: entry.fingerprint,
			enabled: entry.enabled,
		});
	}
	return { version: MCP_ENABLEMENT_VERSION, entries };
}

function hasExactly(keys: string[], expected: string[]): boolean {
	const actual = [...keys].sort();
	const wanted = [...expected].sort();
	return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

async function readDocument(path: string): Promise<EnablementDocument | undefined> {
	try {
		return parseDocument(safeJsonParse(await readFile(path, "utf8")));
	} catch {
		return undefined;
	}
}

async function ensureStateFile(path: string): Promise<void> {
	try {
		await writeFile(path, `${JSON.stringify({ version: MCP_ENABLEMENT_VERSION, entries: [] })}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
	}
	await chmod(path, 0o600);
}

async function atomicWrite(path: string, document: EnablementDocument): Promise<void> {
	const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	try {
		await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
			encoding: "utf8",
			mode: 0o600,
			flag: "wx",
		});
		await chmod(temporary, 0o600);
		await rename(temporary, path);
		await chmod(path, 0o600);
	} catch (error) {
		try {
			await rename(temporary, `${temporary}.failed`);
		} catch {
			// The original error is more useful than cleanup failures.
		}
		throw error;
	}
}
