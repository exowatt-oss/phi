import { getAgentDir } from "../../config.ts";
import { loadBridgeConfig, type ManifestAuthMode, type ServerEntry, type ServerManifestEntry } from "./config.ts";
import { writeEnablement } from "./enablement.ts";
import { McpManager, type McpProbeResult } from "./index.ts";
import { errorMessage } from "./json.ts";
import { auditLogPath, type RecordedEvent, readOAuthEvents } from "./oauth/audit.ts";
import { isLoginInProgress } from "./oauth/lock.ts";
import { CredentialStore, type OAuthTokens } from "./oauth/store.ts";

export type McpCredentialStatus = "valid" | "expired" | "absent" | "n/a";

export interface McpCliProbeStatus {
	status: "ready" | "failed";
	toolCount: number;
	error: string | null;
}

export interface McpCliServerStatus {
	name: string;
	transport: "http" | "stdio";
	enabled: boolean;
	authMode: ManifestAuthMode;
	credential: McpCredentialStatus;
	expiresAt?: string;
	needsLogin: boolean;
	loginInProgress: boolean;
	/** Sanitized load-time failure (parse or `$VAR` interpolation); phi dropped the server. Null when the entry loaded. */
	configError: string | null;
	/** Every unset environment variable the entry references; empty when none. Names only. */
	missingEnv: string[];
	probe?: McpCliProbeStatus;
}

export interface McpStatusEnvelope {
	schema: 1;
	capabilities: { enablement: true };
	servers: McpCliServerStatus[];
}

export interface McpLoginEnvelope {
	schema: 1;
	server: string;
	status: "ready";
	credential: Exclude<McpCredentialStatus, "n/a">;
}

export interface McpLogoutEnvelope {
	schema: 1;
	server: string;
	loggedOut: true;
}

export interface McpEnablementEnvelope {
	schema: 1;
	server: string;
	enabled: boolean;
}

export interface McpEventsEnvelope {
	schema: 1;
	/** Null when logging is switched off, which is itself the answer to "why is it empty". */
	logPath: string | null;
	events: RecordedEvent[];
}

interface StatusOptions {
	probe?: boolean;
	timeoutMs?: number;
	now?: () => number;
}

interface ParsedOptions {
	json: boolean;
	probe: boolean;
	timeoutMs?: number;
	limit?: number;
	sinceMs?: number;
	positionals: string[];
}

type McpCommand =
	| { kind: "help"; json: false }
	| { kind: "status"; json: boolean; probe: boolean; timeoutMs?: number }
	| { kind: "login"; json: boolean; server: string; timeoutMs?: number }
	| { kind: "logout"; json: boolean; server: string }
	| { kind: "enablement"; json: boolean; server: string; enabled: boolean }
	| { kind: "events"; json: boolean; server?: string; limit: number; sinceMs?: number };

const MCP_CLI_USAGE = [
	"Usage:",
	"  phi mcp status [--json] [--probe] [--timeout-ms N]",
	"  phi mcp login <server> [--json] [--timeout-ms N]",
	"  phi mcp logout <server> [--json]",
	"  phi mcp enable <server> [--json]",
	"  phi mcp disable <server> [--json]",
	"  phi mcp events [<server>] [--json] [--limit N] [--since 24h|2026-09-13T09:00:00Z]",
].join("\n");

const DEFAULT_EVENT_LIMIT = 50;

/** Handle the one-shot `phi mcp` control surface before normal session startup. */
export async function handleMcpCommand(args: string[]): Promise<boolean> {
	if (args[0] !== "mcp") return false;
	const jsonRequested = args.includes("--json");
	try {
		const command = parseMcpCommand(args.slice(1));
		if (command.kind === "help") {
			process.stdout.write(`${MCP_CLI_USAGE}\n`);
			return true;
		}

		const agentDir = getAgentDir();
		if (command.kind === "status") {
			const envelope = await collectMcpStatus(agentDir, command);
			writeResult(envelope, command.json, formatHumanStatus(envelope));
		} else if (command.kind === "login") {
			const envelope = await loginMcpServer(agentDir, command.server, command.timeoutMs);
			writeResult(
				envelope,
				command.json,
				`MCP server ${envelope.server} is ready (credential: ${envelope.credential}).`,
			);
		} else if (command.kind === "events") {
			const envelope = await collectMcpEvents(command);
			writeResult(envelope, command.json, formatHumanEvents(envelope));
		} else if (command.kind === "logout") {
			const envelope = await logoutMcpServer(agentDir, command.server);
			writeResult(envelope, command.json, `Logged out of MCP server ${envelope.server}.`);
		} else {
			const envelope = await setMcpServerEnabled(agentDir, command.server, command.enabled);
			writeResult(
				envelope,
				command.json,
				`MCP server ${envelope.server} is ${envelope.enabled ? "enabled" : "disabled"}.`,
			);
		}
		process.exitCode = 0;
	} catch (error) {
		const message = errorMessage(error);
		process.exitCode = 1;
		if (jsonRequested) process.stdout.write(`${JSON.stringify({ error: message })}\n`);
		else process.stderr.write(`Error: ${message}\n`);
	}
	return true;
}

/** Fast status reads only config, credential files, and the login lock unless probe is requested. */
export async function collectMcpStatus(agentDir: string, options: StatusOptions = {}): Promise<McpStatusEnvelope> {
	const config = await loadBridgeConfig(agentDir);
	let probes = new Map<string, McpProbeResult>();
	if (options.probe && config.servers.length > 0) {
		const manager = new McpManager(undefined, agentDir);
		probes = new Map((await manager.probe(config.servers, options.timeoutMs)).map((result) => [result.name, result]));
	}

	const servers: McpCliServerStatus[] = [];
	for (const manifest of config.manifest) {
		if (manifest.transport === "unknown") continue;
		const credential = await credentialState(manifest, options.now ?? Date.now);
		const status: McpCliServerStatus = {
			name: manifest.name,
			transport: manifest.transport,
			enabled: manifest.enabled,
			authMode: manifest.authMode,
			credential: credential.status,
			...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
			needsLogin: manifest.enabled && credential.needsLogin,
			loginInProgress: credential.loginInProgress,
			configError: manifest.error ?? null,
			missingEnv: manifest.missingEnv ?? [],
		};
		if (options.probe) status.probe = probeStatus(manifest, probes.get(manifest.name));
		servers.push(status);
	}
	return { schema: 1, capabilities: { enablement: true }, servers };
}

export async function loginMcpServer(
	agentDir: string,
	serverName: string,
	timeoutMs?: number,
): Promise<McpLoginEnvelope> {
	const config = await loadBridgeConfig(agentDir);
	const manifest = findServer(config.manifest, serverName);
	const entry = runnableOAuthEntry(manifest);
	if (entry.config.type !== "http") throw new Error(`MCP server "${manifest.name}" does not use OAuth.`);
	const httpConfig = entry.config;
	if (httpConfig.auth.mode !== "oauth") throw new Error(`MCP server "${manifest.name}" does not use OAuth.`);
	const auth = httpConfig.auth;

	const forcedEntry: ServerEntry = {
		...entry,
		config: {
			...httpConfig,
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			auth: {
				...auth,
				browser: true,
				...(timeoutMs === undefined ? {} : { browserTimeoutMs: timeoutMs, lockWaitTimeoutMs: timeoutMs }),
			},
		},
	};
	const manager = new McpManager(undefined, agentDir);
	const result = (await manager.probe([forcedEntry], timeoutMs))[0];
	if (!result || result.status !== "ready") {
		throw new Error(result?.error ?? `MCP server "${manifest.name}" login failed.`);
	}
	const state = await credentialState(manifest, Date.now);
	if (state.status === "n/a") throw new Error(`MCP server "${manifest.name}" does not use OAuth.`);
	return { schema: 1, server: manifest.name, status: "ready", credential: state.status };
}

export async function logoutMcpServer(agentDir: string, serverName: string): Promise<McpLogoutEnvelope> {
	const config = await loadBridgeConfig(agentDir);
	const manifest = findServer(config.manifest, serverName);
	const entry = runnableOAuthEntry(manifest);
	if (entry.config.type !== "http" || entry.config.auth.mode !== "oauth") {
		throw new Error(`MCP server "${manifest.name}" does not use OAuth.`);
	}
	const store = await CredentialStore.open(entry.config.url);
	await store.discardTokens();
	return { schema: 1, server: manifest.name, loggedOut: true };
}

/** Persist effective enablement through Phi's locked sidecar, never by mutating mcp.json. */
export async function setMcpServerEnabled(
	agentDir: string,
	serverName: string,
	enabled: boolean,
): Promise<McpEnablementEnvelope> {
	const config = await loadBridgeConfig(agentDir);
	const manifest = findServer(config.manifest, serverName);
	await writeEnablement(agentDir, config.path, manifest.name, manifest.fingerprint, enabled);

	const updated = findServer((await loadBridgeConfig(agentDir)).manifest, manifest.name);
	if (updated.enabled !== enabled) {
		throw new Error(`MCP server "${manifest.name}" could not be ${enabled ? "enabled" : "disabled"}.`);
	}
	// Enablement and configuration validity are separate state. The override has
	// committed successfully even when the newly enabled entry is invalid; status
	// reports its sanitized configError. Never report a failed toggle after
	// persisting it (or attempt an unsafe second-lock rollback).
	return { schema: 1, server: updated.name, enabled: updated.enabled };
}

function parseMcpCommand(args: string[]): McpCommand {
	if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
		return { kind: "help", json: false };
	}
	const verb = args[0];
	const options = parseOptions(args.slice(1));
	// `--limit` / `--since` belong to `events` alone; silently ignoring them
	// elsewhere would make `phi mcp status --limit 1` look like it did something.
	if (verb !== "events" && (options.limit !== undefined || options.sinceMs !== undefined)) {
		throw new Error(MCP_CLI_USAGE);
	}
	if (verb === "status") {
		if (options.positionals.length > 0) throw new Error(MCP_CLI_USAGE);
		return { kind: "status", json: options.json, probe: options.probe, timeoutMs: options.timeoutMs };
	}
	if (verb === "login") {
		if (options.probe || options.positionals.length !== 1) throw new Error(MCP_CLI_USAGE);
		return {
			kind: "login",
			json: options.json,
			server: options.positionals[0] as string,
			timeoutMs: options.timeoutMs,
		};
	}
	if (verb === "logout") {
		if (options.probe || options.timeoutMs !== undefined || options.positionals.length !== 1) {
			throw new Error(MCP_CLI_USAGE);
		}
		return { kind: "logout", json: options.json, server: options.positionals[0] as string };
	}
	if (verb === "events") {
		if (options.probe || options.timeoutMs !== undefined || options.positionals.length > 1) {
			throw new Error(MCP_CLI_USAGE);
		}
		return {
			kind: "events",
			json: options.json,
			server: options.positionals[0],
			limit: options.limit ?? DEFAULT_EVENT_LIMIT,
			sinceMs: options.sinceMs,
		};
	}
	if (verb === "enable" || verb === "disable") {
		if (options.probe || options.timeoutMs !== undefined || options.positionals.length !== 1) {
			throw new Error(MCP_CLI_USAGE);
		}
		return {
			kind: "enablement",
			json: options.json,
			server: options.positionals[0] as string,
			enabled: verb === "enable",
		};
	}
	throw new Error(MCP_CLI_USAGE);
}

function parseOptions(args: string[]): ParsedOptions {
	const parsed: ParsedOptions = { json: false, probe: false, positionals: [] };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		if (arg === "--json") {
			parsed.json = true;
			continue;
		}
		if (arg === "--probe") {
			parsed.probe = true;
			continue;
		}
		if (arg === "--timeout-ms") {
			const value = args[++index];
			if (value === undefined) throw new Error("--timeout-ms requires a positive integer.");
			parsed.timeoutMs = parseTimeout(value);
			continue;
		}
		if (arg.startsWith("--timeout-ms=")) {
			parsed.timeoutMs = parseTimeout(arg.slice("--timeout-ms=".length));
			continue;
		}
		if (arg === "--limit" || arg.startsWith("--limit=")) {
			const value = arg.startsWith("--limit=") ? arg.slice("--limit=".length) : args[++index];
			if (value === undefined) throw new Error("--limit requires a positive integer.");
			parsed.limit = parseLimit(value);
			continue;
		}
		if (arg === "--since" || arg.startsWith("--since=")) {
			const value = arg.startsWith("--since=") ? arg.slice("--since=".length) : args[++index];
			if (value === undefined) throw new Error("--since requires a duration or an ISO timestamp.");
			parsed.sinceMs = parseSince(value);
			continue;
		}
		if (arg.startsWith("-")) throw new Error(`Unknown mcp option: ${arg}`);
		parsed.positionals.push(arg);
	}
	return parsed;
}

function parseTimeout(value: string): number {
	const timeout = Number(value);
	if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647) {
		throw new Error("--timeout-ms requires a positive integer no greater than 2147483647.");
	}
	return timeout;
}

function parseLimit(value: string): number {
	const limit = Number(value);
	if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("--limit requires a positive integer.");
	return limit;
}

const SINCE_USAGE = "--since requires a duration (90m, 24h, 7d) or an ISO 8601 timestamp.";

/**
 * Accepts `90m`, `24h`, `7d`, or an absolute ISO 8601 timestamp — and nothing
 * else. `Date.parse` alone would also accept locale-dependent forms like
 * `09/13/2026`, whose meaning differs by platform, which is not a good property
 * for the input that decides which evidence you are shown.
 */
function parseSince(value: string): number {
	const trimmed = value.trim();
	const duration = /^(\d{1,9})([mhd])$/.exec(trimmed);
	if (duration) {
		const amount = Number(duration[1]);
		const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[duration[2] as "m" | "h" | "d"];
		const since = Date.now() - amount * unit;
		if (!Number.isFinite(since)) throw new Error(SINCE_USAGE);
		return since;
	}
	const extended = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
	// ISO 8601 basic form, which `Date.parse` does not accept on its own.
	const basic = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z|[+-]\d{2}:?\d{2})?$/.exec(trimmed);
	if (!basic && !extended.test(trimmed)) throw new Error(SINCE_USAGE);
	const normalized = basic
		? `${basic[1]}-${basic[2]}-${basic[3]}T${basic[4]}:${basic[5]}:${basic[6]}${basic[7] ?? ""}`
		: trimmed;
	const parsed = Date.parse(normalized);
	if (Number.isNaN(parsed)) throw new Error(SINCE_USAGE);
	return parsed;
}

function findServer(manifest: readonly ServerManifestEntry[], serverName: string): ServerManifestEntry {
	const server = manifest.find((entry) => entry.name.toLowerCase() === serverName.toLowerCase());
	if (!server) throw new Error(`No configured MCP server named "${serverName}".`);
	return server;
}

function runnableOAuthEntry(manifest: ServerManifestEntry): ServerEntry {
	if (!manifest.enabled) throw new Error(`MCP server "${manifest.name}" is disabled.`);
	if (manifest.error) throw new Error(`MCP server "${manifest.name}" is invalid: ${manifest.error}`);
	if (!manifest.entry) throw new Error(`MCP server "${manifest.name}" is not runnable.`);
	if (manifest.entry.config.type !== "http" || manifest.entry.config.auth.mode !== "oauth") {
		throw new Error(`MCP server "${manifest.name}" does not use OAuth.`);
	}
	return manifest.entry;
}

async function credentialState(
	manifest: ServerManifestEntry,
	now: () => number,
): Promise<{
	status: McpCredentialStatus;
	expiresAt?: string;
	needsLogin: boolean;
	loginInProgress: boolean;
}> {
	if (manifest.authMode !== "oauth") {
		return { status: "n/a", needsLogin: false, loginInProgress: false };
	}
	const config = manifest.entry?.config;
	if (config?.type !== "http") {
		return { status: "absent", needsLogin: false, loginInProgress: false };
	}
	const store = await CredentialStore.open(config.url);
	const tokens = await store.readTokens();
	const expired = tokens?.expires_at !== undefined && tokens.expires_at <= now();
	const status: McpCredentialStatus = !tokens ? "absent" : expired ? "expired" : "valid";
	const expiresAt = tokens?.expires_at === undefined ? undefined : formatExpiry(tokens.expires_at);
	return {
		status,
		...(expiresAt ? { expiresAt } : {}),
		needsLogin: tokens === undefined || (expired && !hasRefreshToken(tokens)),
		loginInProgress: await isLoginInProgress(store.paths),
	};
}

function hasRefreshToken(tokens: OAuthTokens): boolean {
	return typeof tokens.refresh_token === "string" && tokens.refresh_token.length > 0;
}

function formatExpiry(expiresAt: number): string | undefined {
	const date = new Date(expiresAt);
	if (Number.isNaN(date.getTime())) return undefined;
	return date.toISOString().replace(".000Z", "Z");
}

function probeStatus(manifest: ServerManifestEntry, result: McpProbeResult | undefined): McpCliProbeStatus {
	if (!manifest.enabled) return { status: "failed", toolCount: 0, error: "Server is disabled." };
	if (manifest.error) return { status: "failed", toolCount: 0, error: manifest.error };
	return result ?? { status: "failed", toolCount: 0, error: "Server was not probed." };
}

function writeResult(value: object, json: boolean, human: string): void {
	process.stdout.write(`${json ? JSON.stringify(value) : human}\n`);
}

/** Read the OAuth audit trail. Pure disk read: it never contacts a server. */
export async function collectMcpEvents(options: {
	server?: string;
	limit: number;
	sinceMs?: number;
}): Promise<McpEventsEnvelope> {
	return {
		schema: 1,
		logPath: auditLogPath() ?? null,
		events: await readOAuthEvents({ server: options.server, limit: options.limit, since: options.sinceMs }),
	};
}

export function formatHumanEvents(envelope: McpEventsEnvelope): string {
	if (envelope.logPath === null) {
		return `OAuth event logging is disabled; unset $PHI_MCP_AUTH_LOG to re-enable it.`;
	}
	if (envelope.events.length === 0) return `No OAuth events recorded yet (${envelope.logPath}).`;
	return envelope.events
		.map((event) => {
			const facts = [
				event.mode,
				event.accessToken ? `access ${event.accessToken}` : undefined,
				event.refreshToken ? `refresh ${event.refreshToken}` : undefined,
				event.rotated === true ? `rotated -> ${event.newRefreshToken ?? "none"}` : undefined,
				event.expiresAt ? `expires ${event.expiresAt}` : undefined,
				event.errorCode,
				event.status === undefined ? undefined : `HTTP ${event.status}`,
				event.detail,
			]
				.filter((part) => part !== undefined)
				.join(", ");
			return `${event.ts} pid ${event.pid} ${event.server} ${event.event}${facts ? ` (${facts})` : ""}`;
		})
		.join("\n");
}

export function formatHumanStatus(envelope: McpStatusEnvelope): string {
	if (envelope.servers.length === 0) return "No MCP servers configured.";
	return envelope.servers
		.map((server) => {
			const login = server.configError
				? server.missingEnv.length > 0
					? `config error: missing ${server.missingEnv.map((name) => `$${name}`).join(", ")}`
					: `config error: ${server.configError}`
				: server.needsLogin
					? server.loginInProgress
						? "login in progress"
						: "needs login"
					: "ready";
			const probe = server.probe
				? `; probe ${server.probe.status}${server.probe.status === "ready" ? ` (${server.probe.toolCount} tools)` : `: ${server.probe.error ?? "unknown error"}`}`
				: "";
			return `${server.name}: ${server.transport}, ${server.enabled ? "enabled" : "disabled"}, ${server.authMode}, credential ${server.credential}, ${login}${probe}`;
		})
		.join("\n");
}
