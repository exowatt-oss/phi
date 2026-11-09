import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CachedCatalog,
	CatalogCache,
	catalogCachePath,
	DEFAULT_CATALOG_CACHE_TTL_MS,
	loadCatalogCache,
} from "../src/extensions/mcp/cache.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof fsPromises>();
	return { ...actual, rename: vi.fn(actual.rename) };
});

let agentDir: string;
const entry = (serverName = "demo", timestamp = Date.now()): CachedCatalog => ({
	serverName,
	fingerprint: "fingerprint",
	timestamp,
	identity: { protocolVersion: "2025-06-18", serverName: "server" },
	tools: [{ name: "ping", inputSchema: { type: "object", properties: { x: { type: "string" } } } }],
});

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-mcp-cache-"));
	vi.mocked(fsPromises.rename).mockClear();
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("MCP catalog cache writes", () => {
	it("skips an identical entry without rewriting or refreshing its timestamp", async () => {
		const cache = await CatalogCache.open(agentDir);
		const first = entry("demo", Date.now() - 1000);
		await cache.put(first);
		const path = catalogCachePath(agentDir);
		const original = readFileSync(path, "utf8");
		const markedTime = new Date(Date.now() - 10_000);
		utimesSync(path, markedTime, markedTime);
		const originalMtime = statSync(path).mtimeMs;
		vi.mocked(fsPromises.rename).mockClear();

		const identical = entry("demo", Date.now());
		identical.tools[0].inputSchema = { properties: { x: { type: "string" } }, type: "object" };
		await cache.put(identical);
		await cache.flush();
		expect(fsPromises.rename).not.toHaveBeenCalled();
		expect(statSync(path).mtimeMs).toBe(originalMtime);
		expect(readFileSync(path, "utf8")).toBe(original);
		expect(cache.get("demo", "fingerprint")?.timestamp).toBe(first.timestamp);
	});

	it("writes a changed entry once, with compact JSON", async () => {
		const cache = await CatalogCache.open(agentDir);
		await cache.put(entry());
		vi.mocked(fsPromises.rename).mockClear();
		const changed = entry();
		changed.identity = { protocolVersion: "2025-06-18", serverName: "new-server" };
		await cache.put(changed);
		expect(fsPromises.rename).toHaveBeenCalledTimes(1);
		const raw = readFileSync(catalogCachePath(agentDir), "utf8");
		expect(raw).not.toContain("\n  ");
		expect(JSON.parse(raw).servers[0].identity.serverName).toBe("new-server");
	});

	it("coalesces simultaneous puts into one atomic write", async () => {
		const cache = await CatalogCache.open(agentDir);
		await Promise.all([cache.put(entry("one")), cache.put(entry("two")), cache.put(entry("three"))]);
		expect(fsPromises.rename).toHaveBeenCalledTimes(1);
		expect((await loadCatalogCache(agentDir)).size).toBe(3);
	});

	it("flush waits for a scheduled write even when callers do not await put", async () => {
		const cache = await CatalogCache.open(agentDir);
		const put = cache.put(entry());
		expect(existsSync(catalogCachePath(agentDir))).toBe(false);
		await cache.flush();
		expect(fsPromises.rename).toHaveBeenCalledTimes(1);
		expect((await loadCatalogCache(agentDir)).has("demo")).toBe(true);
		await put;
	});

	it("refreshes identical entries by half the TTL so they do not expire", async () => {
		const now = Date.now();
		const cache = await CatalogCache.open(agentDir, now);
		await cache.put(entry("demo", now - DEFAULT_CATALOG_CACHE_TTL_MS / 2 + 1000));
		vi.mocked(fsPromises.rename).mockClear();
		await cache.put(entry("demo", now));
		expect(fsPromises.rename).not.toHaveBeenCalled();
		await cache.put(entry("demo", now + 1001));
		expect(fsPromises.rename).toHaveBeenCalledTimes(1);
		expect((await loadCatalogCache(agentDir, now + DEFAULT_CATALOG_CACHE_TTL_MS)).has("demo")).toBe(true);
		expect((await loadCatalogCache(agentDir, now + DEFAULT_CATALOG_CACHE_TTL_MS + 1002)).has("demo")).toBe(false);
	});

	it("removes only stale cache temp and failed siblings on open", async () => {
		const path = catalogCachePath(agentDir);
		await fsPromises.mkdir(dirname(path));
		const stale = `${path}.tmp-123-deadbeef`;
		const failed = `${path}.tmp-456-aabbcc.failed`;
		const fresh = `${path}.tmp-789-feedface`;
		const other = `${path}.tmp-not-a-writer`;
		for (const file of [stale, failed, fresh, other, path]) writeFileSync(file, "keep", "utf8");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		for (const file of [stale, failed, other]) utimesSync(file, old, old);
		await CatalogCache.open(agentDir);
		expect(existsSync(stale)).toBe(false);
		expect(existsSync(failed)).toBe(false);
		expect(existsSync(fresh)).toBe(true);
		expect(existsSync(other)).toBe(true);
		expect(existsSync(path)).toBe(true);
	});
});
