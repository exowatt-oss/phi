import { randomBytes } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { asRecord, safeJsonParse } from "./json.ts";
import type { McpServerIdentity, McpToolInfo } from "./protocol.ts";

/** Bump this when the on-disk representation changes incompatibly. */
export const CATALOG_CACHE_VERSION = 1;
export const CATALOG_CACHE_FILE_NAME = "mcp-catalog-v1.json";
/** A catalogue is useful across restarts, but never trusted indefinitely. */
export const DEFAULT_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const CATALOG_CACHE_TTL_MS = DEFAULT_CATALOG_CACHE_TTL_MS;
const STALE_TEMP_AGE_MS = 60 * 60 * 1000;

export interface CachedCatalog {
	serverName: string;
	fingerprint: string;
	timestamp: number;
	identity?: McpServerIdentity;
	tools: McpToolInfo[];
}

interface CacheDocument {
	version: number;
	servers: CachedCatalog[];
}

export function catalogCachePath(agentDir: string): string {
	return join(agentDir, "cache", CATALOG_CACHE_FILE_NAME);
}

/**
 * Read only the deliberately narrow catalogue shape. Unknown fields are
 * ignored, so even a hand-edited cache cannot turn into a config source.
 */
export async function loadCatalogCache(
	agentDir: string,
	now = Date.now(),
	ttlMs = DEFAULT_CATALOG_CACHE_TTL_MS,
): Promise<Map<string, CachedCatalog>> {
	try {
		const raw = await readFile(catalogCachePath(agentDir), "utf8");
		const document = asRecord(safeJsonParse(raw));
		if (document?.version !== CATALOG_CACHE_VERSION || !Array.isArray(document.servers)) return new Map();

		const result = new Map<string, CachedCatalog>();
		for (const value of document.servers) {
			const entry = parseCachedCatalog(value, now, ttlMs);
			if (entry) result.set(entry.serverName, entry);
		}
		return result;
	} catch {
		return new Map();
	}
}

export class CatalogCache {
	private readonly entries: Map<string, CachedCatalog>;
	private readonly agentDir: string;
	private readonly ttlMs: number;
	private writeChain: Promise<void> = Promise.resolve();
	private pendingWrite: Promise<void> | undefined;

	private constructor(agentDir: string, entries: Map<string, CachedCatalog>, ttlMs: number) {
		this.agentDir = agentDir;
		this.entries = entries;
		this.ttlMs = ttlMs;
	}

	static async open(agentDir: string, now = Date.now(), ttlMs = DEFAULT_CATALOG_CACHE_TTL_MS): Promise<CatalogCache> {
		const entries = await loadCatalogCache(agentDir, now, ttlMs);
		await cleanupStaleTemps(join(agentDir, "cache"), now);
		return new CatalogCache(agentDir, entries, ttlMs);
	}

	get(serverName: string, fingerprint: string): CachedCatalog | undefined {
		const entry = this.entries.get(serverName);
		return entry?.fingerprint === fingerprint ? cloneCatalog(entry) : undefined;
	}

	async put(entry: CachedCatalog): Promise<void> {
		const current = this.entries.get(entry.serverName);
		if (
			current?.fingerprint === entry.fingerprint &&
			isDeepStrictEqual(current.identity, entry.identity) &&
			isDeepStrictEqual(current.tools, entry.tools) &&
			entry.timestamp - current.timestamp < this.ttlMs / 2
		)
			return;
		this.entries.set(entry.serverName, cloneCatalog(entry));
		await this.schedulePersist();
	}

	async remove(serverName: string): Promise<void> {
		if (!this.entries.delete(serverName)) return;
		await this.schedulePersist();
	}

	/** Wait for the scheduled write and any already queued atomic write. */
	async flush(): Promise<void> {
		await this.pendingWrite;
		await this.writeChain;
	}

	private schedulePersist(): Promise<void> {
		if (this.pendingWrite) return this.pendingWrite;
		// Let all connections completing in this event-loop turn share one snapshot.
		const pending = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => {
			this.pendingWrite = undefined;
			return this.persist();
		});
		this.pendingWrite = pending;
		return pending;
	}

	/** Best effort: cache failure must never turn a working MCP connection into an error. */
	private async persist(): Promise<void> {
		const document: CacheDocument = {
			version: CATALOG_CACHE_VERSION,
			servers: [...this.entries.values()].sort((a, b) => a.serverName.localeCompare(b.serverName)),
		};
		const serialized = `${JSON.stringify(document)}\n`;
		const cachePath = catalogCachePath(this.agentDir);
		const cacheDir = join(this.agentDir, "cache");
		const tempPath = `${cachePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;

		const write = async (): Promise<void> => {
			try {
				await mkdir(cacheDir, { recursive: true, mode: 0o700 });
				await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
				await chmod(tempPath, 0o600);
				await rename(tempPath, cachePath);
				await chmod(cachePath, 0o600);
			} catch {
				try {
					await rename(tempPath, `${tempPath}.failed`);
				} catch {
					// Ignore cleanup failures. The cache is opportunistic.
				}
			}
		};

		const next = this.writeChain.then(write, write);
		this.writeChain = next.catch(() => undefined);
		await next;
	}
}

async function cleanupStaleTemps(cacheDir: string, now: number): Promise<void> {
	try {
		const files = await readdir(cacheDir);
		await Promise.all(
			files
				.filter((name) => /^mcp-catalog-v1\.json\.tmp-\d+-[0-9a-f]+(?:\.failed)?$/.test(name))
				.map(async (name) => {
					try {
						const path = join(cacheDir, name);
						if (now - (await stat(path)).mtimeMs > STALE_TEMP_AGE_MS) await unlink(path);
					} catch {
						// Concurrent writers or permissions must not block cache reads.
					}
				}),
		);
	} catch {
		// The cache directory may not exist yet.
	}
}

function parseCachedCatalog(value: unknown, now: number, ttlMs: number): CachedCatalog | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const serverName = typeof record.serverName === "string" ? record.serverName : undefined;
	const fingerprint = typeof record.fingerprint === "string" ? record.fingerprint : undefined;
	const timestamp = typeof record.timestamp === "number" ? record.timestamp : undefined;
	if (!serverName || !fingerprint || timestamp === undefined || !Number.isFinite(timestamp)) return undefined;
	if (timestamp > now || now - timestamp > ttlMs) return undefined;
	if (!Array.isArray(record.tools)) return undefined;

	const tools: McpToolInfo[] = [];
	for (const value of record.tools) {
		const tool = parseCachedTool(value);
		if (tool) tools.push(tool);
	}
	if (tools.length !== record.tools.length) return undefined;

	const identity = parseIdentity(record.identity);
	return { serverName, fingerprint, timestamp, identity, tools };
}

function parseCachedTool(value: unknown): McpToolInfo | undefined {
	const record = asRecord(value);
	if (typeof record?.name !== "string" || !record.name) return undefined;
	if (typeof record.inputSchema !== "object" || record.inputSchema === null || Array.isArray(record.inputSchema)) {
		return undefined;
	}
	const inputSchema = { ...(record.inputSchema as Record<string, unknown>) };
	inputSchema.type = "object";
	if (!asRecord(inputSchema.properties)) inputSchema.properties = {};
	if (!Array.isArray(inputSchema.required)) inputSchema.required = [];
	return {
		name: record.name,
		title: typeof record.title === "string" ? record.title : undefined,
		description: typeof record.description === "string" ? record.description : undefined,
		inputSchema,
	};
}

function parseIdentity(value: unknown): McpServerIdentity | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	const protocolVersion = typeof record.protocolVersion === "string" ? record.protocolVersion : undefined;
	if (!protocolVersion) return undefined;
	return {
		protocolVersion,
		serverName: typeof record.serverName === "string" ? record.serverName : undefined,
		serverVersion: typeof record.serverVersion === "string" ? record.serverVersion : undefined,
		instructions: typeof record.instructions === "string" ? record.instructions : undefined,
	};
}

function cloneCatalog(entry: CachedCatalog): CachedCatalog {
	return {
		serverName: entry.serverName,
		fingerprint: entry.fingerprint,
		timestamp: entry.timestamp,
		identity: entry.identity ? { ...entry.identity } : undefined,
		tools: entry.tools.map((tool) => ({
			...tool,
			inputSchema: structuredClone(tool.inputSchema),
		})),
	};
}
