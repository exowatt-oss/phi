import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { loadBridgeConfig, serverConfigFingerprint } from "../src/extensions/mcp/config.ts";
import {
	enablementConfigKey,
	enablementPath,
	loadEnablementRecords,
	MCP_ENABLEMENT_VERSION,
	readEnablement,
	writeEnablement,
} from "../src/extensions/mcp/enablement.ts";
import { McpManager } from "../src/extensions/mcp/index.ts";

let agentDir: string;
let configPath: string;
let previousConfigPath: string | undefined;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "phi-mcp-enablement-"));
	configPath = join(agentDir, "mcp.json");
	previousConfigPath = process.env.PHI_MCP_CONFIG;
	process.env.PHI_MCP_CONFIG = configPath;
});

afterEach(() => {
	if (previousConfigPath === undefined) delete process.env.PHI_MCP_CONFIG;
	else process.env.PHI_MCP_CONFIG = previousConfigPath;
	try {
		chmodSync(agentDir, 0o755);
	} catch {
		// The temporary directory may already have been removed by a failed test.
	}
	rmSync(agentDir, { recursive: true, force: true });
});

function writeConfig(servers: Record<string, unknown>): string {
	const raw = `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`;
	writeFileSync(configPath, raw, { encoding: "utf8", mode: 0o600 });
	return raw;
}

function fingerprint(name: string, entry: Record<string, unknown>): string {
	return serverConfigFingerprint(name, entry);
}

describe("MCP enablement sidecar", () => {
	it("writes only redacted state with mode 0600 and leaves mcp.json byte-for-byte unchanged", async () => {
		const entry = {
			type: "stdio",
			command: "mcp-server",
			args: ["serve", "literal-secret"],
			env: { API_TOKEN: "resolved-secret" },
		};
		const original = writeConfig({ demo: entry });
		const fp = fingerprint("demo", entry);

		await writeEnablement(agentDir, configPath, "demo", fp, false);

		expect(readFileSync(configPath, "utf8")).toBe(original);
		const sidecar = readFileSync(enablementPath(agentDir), "utf8");
		expect(statSync(enablementPath(agentDir)).mode & 0o777).toBe(0o600);
		expect(sidecar).toContain(`"version": ${MCP_ENABLEMENT_VERSION}`);
		expect(sidecar).not.toContain(configPath);
		expect(sidecar).not.toContain("mcp-server");
		expect(sidecar).not.toContain("literal-secret");
		expect(sidecar).not.toContain("resolved-secret");
		expect(await readEnablement(agentDir, configPath, "demo", fp)).toBe(false);
	});

	it("serializes concurrent updates without losing records", async () => {
		const first = { type: "http", url: "https://one.example.test/mcp" };
		const second = { type: "http", url: "https://two.example.test/mcp" };
		writeConfig({ first, second });
		await Promise.all([
			writeEnablement(agentDir, configPath, "first", fingerprint("first", first), false),
			writeEnablement(agentDir, configPath, "second", fingerprint("second", second), true),
		]);

		const records = await loadEnablementRecords(agentDir);
		expect(records).toHaveLength(2);
		expect(records.map((record) => record.serverName).sort()).toEqual(["first", "second"]);
	});

	it("enables raw-disabled entries only through a matching override and avoids missing-env interpolation while disabled", async () => {
		const entry = { type: "stdio", command: "$MCP_MISSING_COMMAND" };
		writeConfig({ demo: { ...entry, disabled: true } });
		const fp = fingerprint("demo", entry);

		const disabled = await loadBridgeConfig(agentDir);
		expect(disabled.servers).toEqual([]);
		expect(disabled.manifest).toMatchObject([
			{ name: "demo", enabled: false, rawDisabled: true, transport: "stdio" },
		]);
		expect(disabled.manifest[0]?.error).toBeUndefined();

		await writeEnablement(agentDir, configPath, "demo", fp, true);
		const enabled = await loadBridgeConfig(agentDir);
		expect(enabled.servers).toEqual([]);
		expect(enabled.manifest[0]).toMatchObject({ name: "demo", enabled: true, rawDisabled: true });
		expect(enabled.manifest[0]?.error).toContain("MCP_MISSING_COMMAND");

		await writeEnablement(agentDir, configPath, "demo", fp, false);
		const disabledAgain = await loadBridgeConfig(agentDir);
		expect(disabledAgain.manifest[0]).toMatchObject({ name: "demo", enabled: false, rawDisabled: true });
		expect(disabledAgain.manifest[0]?.error).toBeUndefined();
	});

	it("supports default-enabled disable, ignores structural fingerprint changes, and preserves secret rotation", async () => {
		const original = {
			type: "http",
			url: "https://mcp.example.test/mcp?token=first",
			headers: { Authorization: "Bearer first-secret" },
			args: ["-pfirst-password", "--token=first-token", "first-positional-secret"],
		};
		writeConfig({ demo: original });
		const originalFingerprint = fingerprint("demo", original);
		await writeEnablement(agentDir, configPath, "demo", originalFingerprint, false);
		expect((await loadBridgeConfig(agentDir)).servers).toEqual([]);

		const rotated = {
			...original,
			url: "https://mcp.example.test/mcp?token=rotated",
			headers: { Authorization: "Bearer rotated-secret" },
			args: ["-protated-password", "--token=rotated-token", "rotated-positional-secret"],
		};
		writeConfig({ demo: rotated });
		const rotatedConfig = await loadBridgeConfig(agentDir);
		expect(fingerprint("demo", rotated)).toBe(originalFingerprint);
		expect(rotatedConfig.servers).toEqual([]);

		const changed = { ...rotated, url: "https://other.example.test/mcp" };
		writeConfig({ demo: changed });
		const changedConfig = await loadBridgeConfig(agentDir);
		expect(changedConfig.servers).toHaveLength(1);
		expect(changedConfig.manifest[0]?.enabled).toBe(true);
	});

	it("fails safely when the sidecar is malformed", async () => {
		const entry = { type: "http", url: "https://mcp.example.test/mcp" };
		writeConfig({ demo: entry });
		writeFileSync(enablementPath(agentDir), "not json", { encoding: "utf8", mode: 0o600 });
		const config = await loadBridgeConfig(agentDir);
		expect(config.servers).toHaveLength(1);
		expect(config.manifest[0]?.enabled).toBe(true);
	});

	it("uses the resolved alternate config path only in the hash", async () => {
		const alternate = join(agentDir, "alternate-mcp.json");
		const entry = { type: "http", url: "https://mcp.example.test/mcp" };
		const raw = `${JSON.stringify({ mcpServers: { demo: entry } })}\n`;
		writeFileSync(alternate, raw, { encoding: "utf8", mode: 0o600 });
		process.env.PHI_MCP_CONFIG = alternate;
		const fp = fingerprint("demo", entry);
		await writeEnablement(agentDir, alternate, "demo", fp, false);

		expect(await readEnablement(agentDir, alternate, "demo", fp)).toBe(false);
		expect(readFileSync(alternate, "utf8")).toBe(raw);
		expect(readFileSync(enablementPath(agentDir), "utf8")).not.toContain(alternate);
		expect(enablementConfigKey(alternate, "demo", fp)).toMatch(/^[a-f0-9]{64}$/);
	});

	it("applies a trusted project overlay after the global sidecar, without changing either file", async () => {
		const first = { type: "http", url: "https://one.example.test/mcp" };
		const second = { type: "stdio", command: "$MISSING_PROJECT_MCP_COMMAND", disabled: true };
		const original = writeConfig({ first, second });
		const cwd = join(agentDir, "project");
		const projectDir = join(cwd, ".pi");
		const projectPath = join(projectDir, "mcp.json");
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(projectPath, JSON.stringify({ mcpServers: { first: false, second: true } }));
		await writeEnablement(agentDir, configPath, "first", fingerprint("first", first), true);
		const originalSidecar = readFileSync(enablementPath(agentDir), "utf8");

		const untrusted = await loadBridgeConfig(agentDir, { cwd, trusted: false });
		expect(untrusted.servers.map((entry) => entry.name)).toEqual(["first"]);
		const trusted = await loadBridgeConfig(agentDir, { cwd, trusted: true });
		expect(trusted.servers).toEqual([]);
		expect(trusted.projectOverrides).toEqual(["first", "second"]);
		expect(trusted.manifest).toMatchObject([
			{ name: "first", enabled: false },
			{ name: "second", enabled: true, missingEnv: ["MISSING_PROJECT_MCP_COMMAND"] },
		]);
		expect(readFileSync(configPath, "utf8")).toBe(original);
		expect(readFileSync(enablementPath(agentDir), "utf8")).toBe(originalSidecar);
	});

	it("refuses a manager toggle over an explicit project choice before writing the sidecar", async () => {
		writeConfig({ demo: { type: "http", url: "https://one.example.test/mcp", disabled: true } });
		const cwd = join(agentDir, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { demo: false } }));
		const context = {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
			ui: { setStatus: () => undefined },
		} as unknown as ExtensionContext;
		const manager = new McpManager(undefined, agentDir);
		await manager.beginSession(await loadBridgeConfig(agentDir, { cwd, trusted: true }), context);
		await expect(manager.setEnabled("demo", true)).rejects.toThrow("edit that file instead");
		expect(await loadEnablementRecords(agentDir)).toEqual([]);
		await manager.stop();
	});

	it("refuses a toggle if the project adds a selection after session start", async () => {
		writeConfig({ demo: { type: "http", url: "https://one.example.test/mcp", disabled: true } });
		const cwd = join(agentDir, "project");
		const context = {
			cwd,
			isProjectTrusted: () => true,
			sessionManager: { getBranch: () => [] },
			ui: { setStatus: () => undefined },
		} as unknown as ExtensionContext;
		const manager = new McpManager(undefined, agentDir);
		await manager.beginSession(await loadBridgeConfig(agentDir, { cwd, trusted: true }), context);
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { demo: false } }));
		await expect(manager.setEnabled("demo", true)).rejects.toThrow("edit that file instead");
		expect(await loadEnablementRecords(agentDir)).toEqual([]);
		await manager.stop();
	});

	it("rejects an unknown or malformed project overlay atomically", async () => {
		writeConfig({ first: { type: "http", url: "https://one.example.test/mcp" } });
		const cwd = join(agentDir, "project");
		const projectDir = join(cwd, ".pi");
		mkdirSync(projectDir, { recursive: true });
		const path = join(projectDir, "mcp.json");
		for (const payload of [
			{ mcpServers: { first: false, unknown: true } },
			{ mcpServers: { first: "false" } },
			{ mcpServers: { first: false }, toolMode: "eager" },
			'{"mcpServers":',
		]) {
			writeFileSync(path, typeof payload === "string" ? payload : JSON.stringify(payload));
			const result = await loadBridgeConfig(agentDir, { cwd, trusted: true });
			expect(result.servers.map((entry) => entry.name)).toEqual(["first"]);
			expect(result.projectOverrides).toEqual([]);
			expect(result.warnings).toHaveLength(1);
		}
	});

	it("warns about project selections if no global server config exists", async () => {
		const cwd = join(agentDir, "project");
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(cwd, ".pi", "mcp.json"), JSON.stringify({ mcpServers: { unknown: true } }));
		const trusted = await loadBridgeConfig(agentDir, { cwd, trusted: true });
		expect(trusted.present).toBe(false);
		expect(trusted.warnings).toHaveLength(1);
		expect(trusted.warnings[0]).toContain('unknown server or non-boolean entry "unknown"');
		expect((await loadBridgeConfig(agentDir, { cwd, trusted: false })).warnings).toEqual([]);
	});
});
