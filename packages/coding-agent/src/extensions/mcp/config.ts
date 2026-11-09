/**
 * `mcp.json` — the list of MCP servers to bridge.
 *
 * The shape is deliberately the same as Claude Code's `mcpServers` block so a
 * working server entry can be copied across without translation. Secrets may be
 * written literally or as `$ENV_VAR` / `${ENV_VAR}` references; references are
 * resolved at session start, and a missing variable names itself in the error
 * without ever echoing a value.
 *
 * Two keys are ours rather than Claude Code's, and both may be set once at the
 * top level and overridden per server: `toolMode` decides whether a server's
 * tools are active from the first turn or discovered on demand, and
 * `injectInstructions` decides whether its `initialize` instructions reach the
 * system prompt. A server in lazy mode may also list `eagerTools`: the MCP tool
 * names that are active from the first turn while the rest stay discoverable.
 *
 * A third, `auth`, is per server and only meaningful for HTTP: it tunes or turns
 * off the OAuth login the transport performs when a server answers 401. It needs
 * no value in the common case, so an existing config keeps working unchanged.
 */

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { enablementConfigKey, loadEnablementRecords } from "./enablement.ts";
import {
	asArray,
	asRecord,
	errorMessage,
	readBoolean,
	readNumber,
	readString,
	readStringMap,
	safeJsonParse,
} from "./json.ts";

export const CONFIG_FILE_NAME = "mcp.json";

/** Set to point the bridge at a different config file, mainly for testing. */
export const CONFIG_PATH_ENV_VAR = "PHI_MCP_CONFIG";

/** A desktop host sets this when it can present phi's local browser OAuth flow. */
export const MCP_BROWSER_AUTH_ENV_VAR = "PHI_MCP_BROWSER_AUTH";

/**
 * Browser auth remains opt-in outside the TUI; only the established true spellings count.
 * The opt-in only holds where this process can show a browser: a desktop host's
 * server on a headless Linux box (P3 on a VM) has no display for xdg-open, so a
 * login there would hold the callback socket and login lock until it timed out.
 */
export function mcpBrowserAuthAllowed(): boolean {
	const value = process.env[MCP_BROWSER_AUTH_ENV_VAR];
	if (!value) return false;
	if (!(value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes")) return false;
	return (
		process.platform === "darwin" ||
		process.platform === "win32" ||
		!!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
	);
}

/**
 * How an HTTP server is authenticated. `oauth` is the default because it costs
 * nothing until the server actually answers 401: discovery only starts once a
 * request is refused, so no configuration change is needed to adopt it and a
 * server that never challenges never sees an OAuth code path.
 *
 * `none` is the opt-out, and it is also the default for an entry that already
 * carries an `Authorization` header: an explicitly configured credential is a
 * deliberate choice, and phi must not silently replace it with an OAuth login.
 */
export type HttpAuthConfig =
	| { mode: "none" }
	| {
			mode: "oauth";
			/** Overrides the scope from a registered client or from server metadata. */
			scope?: string;
			/** Set for a pre-registered client on a server without dynamic registration. */
			clientId?: string;
			clientSecret?: string;
			/** Skip discovery and use this authorization server (issuer or metadata URL). */
			authorizationServer?: string;
			/**
			 * False keeps the session silent: renew a stored login, never open a browser.
			 * Undefined defers to the run mode — a browser login needs a human, and a
			 * headless run has none, so only an explicit setting here pins the behaviour.
			 */
			browser?: boolean;
			/**
			 * How long a browser login may stay unfinished before the flow gives up.
			 * Unset keeps the built-in thirty-minute human-authorization window; a short
			 * value suits a server whose login the user usually ignores, so startup does not
			 * appear hung.
			 */
			browserTimeoutMs?: number;
			/** Upper bound on waiting for another session's browser login to finish. */
			lockWaitTimeoutMs?: number;
	  };

export interface HttpServerConfig {
	type: "http";
	url: string;
	headers?: Record<string, string>;
	/** Always resolved, so the transport never re-derives the default. */
	auth: HttpAuthConfig;
	timeoutMs?: number;
	callTimeoutMs?: number;
}

export interface StdioServerConfig {
	type: "stdio";
	command: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	timeoutMs?: number;
	callTimeoutMs?: number;
}

export type ServerConfig = HttpServerConfig | StdioServerConfig;

/**
 * `eager` puts every tool of a server in the active set from the first turn, as
 * the bridge always did. `lazy` registers them but leaves them inactive until
 * the discovery tool activates the ones a task actually needs, which keeps a
 * 100-tool catalogue out of every request.
 */
export type ToolMode = "lazy" | "eager";

export const TOOL_MODES: readonly ToolMode[] = ["lazy", "eager"];

/** Lazy by default: a large catalogue costs context on every turn, and most of it goes unused. */
export const DEFAULT_TOOL_MODE: ToolMode = "lazy";

/** Instructions are usage contract for some servers (feads ships its session protocol there). */
export const DEFAULT_INJECT_INSTRUCTIONS = true;

export interface ServerEntry {
	name: string;
	config: ServerConfig;
	/** Stable hash of the redacted transport shape; never includes resolved credentials. */
	fingerprint: string;
	toolMode: ToolMode;
	/** MCP tool names active from the first turn in lazy mode; always empty in eager mode. */
	eagerTools: readonly string[];
	injectInstructions: boolean;
}

/** The mode one tool actually gets: eager for an eager server or a tool on its `eagerTools` list. */
export function effectiveToolMode(entry: Pick<ServerEntry, "toolMode" | "eagerTools">, mcpName: string): ToolMode {
	return entry.toolMode === "eager" || entry.eagerTools.includes(mcpName) ? "eager" : "lazy";
}

export type ManifestTransport = "http" | "stdio" | "unknown";
export type ManifestAuthMode = "oauth" | "none" | "static";

/** Safe, non-runnable projection of every configured server name. */
export interface ServerManifestEntry {
	name: string;
	/** Effective enablement after the raw config and matching sidecar override. */
	enabled: boolean;
	rawDisabled: boolean;
	fingerprint: string;
	transport: ManifestTransport;
	/** Safe auth projection used by status surfaces, including for disabled entries. */
	authMode: ManifestAuthMode;
	toolMode: ToolMode;
	eagerTools: readonly string[];
	injectInstructions: boolean;
	/** Present only when the entry parsed successfully and is enabled. */
	entry?: ServerEntry;
	/** Sanitized parser/interpolation failure; never resolved secret material. */
	error?: string;
	/** Every `$VAR` the entry references that is unset; present only alongside `error`. Names only. */
	missingEnv?: string[];
}

export interface BridgeConfig {
	path: string;
	/** False when no config file exists, which is the normal state for someone not using MCP. */
	present: boolean;
	/** Effective enabled runnable entries only. */
	servers: ServerEntry[];
	/** All configured names, including disabled and invalid entries. */
	manifest: ServerManifestEntry[];
	/** Names explicitly selected by the trusted project's overlay. */
	projectOverrides: string[];
	/** Top-level defaults, after applying the built-in ones. */
	defaults: { toolMode: ToolMode; injectInstructions: boolean };
	/** Non-fatal problems: a malformed entry, or a file readable by other users. */
	warnings: string[];
}

export function resolveConfigPath(agentDir: string): string {
	return process.env[CONFIG_PATH_ENV_VAR] ?? join(agentDir, CONFIG_FILE_NAME);
}

export async function loadBridgeConfig(
	agentDir: string,
	project?: { cwd: string; trusted: boolean },
): Promise<BridgeConfig> {
	const path = resolveConfigPath(agentDir);
	const warnings: string[] = [];

	const builtInDefaults = { toolMode: DEFAULT_TOOL_MODE, injectInstructions: DEFAULT_INJECT_INSTRUCTIONS };

	let raw: string;
	try {
		raw = await readFile(path, "utf-8");
	} catch {
		if (project?.trusted) await loadProjectEnablement(project.cwd, [], warnings);
		return {
			path,
			present: false,
			servers: [],
			manifest: [],
			projectOverrides: [],
			defaults: builtInDefaults,
			warnings,
		};
	}

	await checkPermissions(path, warnings);

	const payload = asRecord(safeJsonParse(raw));
	if (!payload) {
		throw new Error(`${path} is not a JSON object. Expected {"mcpServers": { ... }}.`);
	}

	const defaults = {
		toolMode: parseToolMode(payload, "top-level", DEFAULT_TOOL_MODE, warnings),
		injectInstructions: readBoolean(payload, "injectInstructions") ?? DEFAULT_INJECT_INSTRUCTIONS,
	};

	const servers = asRecord(payload.mcpServers) ?? asRecord(payload.servers);
	if (!servers) {
		return {
			path,
			present: true,
			servers: [],
			manifest: [],
			projectOverrides: [],
			defaults,
			warnings: [...warnings, `${path} has no "mcpServers" object.`],
		};
	}

	const entries: ServerEntry[] = [];
	const manifest: ServerManifestEntry[] = [];
	const overrides = await loadEnablementRecords(agentDir);
	const projectOverrides = project?.trusted
		? await loadProjectEnablement(project.cwd, Object.keys(servers), warnings)
		: new Map<string, boolean>();
	for (const [name, value] of Object.entries(servers)) {
		const record = asRecord(value);
		const fingerprint = serverConfigFingerprint(name, record ?? {});
		const rawDisabled = record?.disabled === true;
		const toolMode = parseToolMode(record ?? {}, `Server "${name}"`, defaults.toolMode, warnings);
		const eagerTools = parseEagerTools(record ?? {}, `Server "${name}"`, toolMode, warnings);
		const injectInstructions = readBoolean(record, "injectInstructions") ?? defaults.injectInstructions;
		const transport = record ? manifestTransport(record) : "unknown";
		const authMode = manifestAuthMode(record, transport);
		const override = overrides.find(
			(entry) =>
				entry.configKey === enablementConfigKey(path, name, fingerprint) &&
				entry.serverName === name &&
				entry.fingerprint === fingerprint,
		);
		const enabled = projectOverrides.get(name) ?? override?.enabled ?? !rawDisabled;

		if (!record) {
			if (!enabled) {
				manifest.push({
					name,
					enabled: false,
					rawDisabled,
					fingerprint,
					transport,
					authMode,
					toolMode,
					eagerTools,
					injectInstructions,
				});
				continue;
			}
			const error = `Server "${name}" is not an object.`;
			warnings.push(error);
			manifest.push({
				name,
				enabled: true,
				rawDisabled,
				fingerprint,
				transport,
				authMode,
				toolMode,
				eagerTools,
				injectInstructions,
				error,
			});
			continue;
		}

		if (!enabled) {
			manifest.push({
				name,
				enabled: false,
				rawDisabled,
				fingerprint,
				transport,
				authMode,
				toolMode,
				eagerTools,
				injectInstructions,
			});
			continue;
		}

		try {
			const entry: ServerEntry = {
				name,
				config: parseServer(name, record, warnings),
				fingerprint,
				toolMode,
				eagerTools,
				injectInstructions,
			};
			entries.push(entry);
			manifest.push({
				name,
				enabled: true,
				rawDisabled,
				fingerprint,
				transport,
				authMode,
				toolMode,
				eagerTools,
				injectInstructions,
				entry,
			});
		} catch (error) {
			const sanitized = sanitizeConfigError(error);
			warnings.push(sanitized);
			manifest.push({
				name,
				enabled: true,
				rawDisabled,
				fingerprint,
				transport,
				authMode,
				toolMode,
				eagerTools,
				injectInstructions,
				error: sanitized,
				missingEnv: collectMissingEnv(record),
			});
		}
	}

	return {
		path,
		present: true,
		servers: entries,
		manifest,
		projectOverrides: [...projectOverrides.keys()],
		defaults,
		warnings,
	};
}

/* A trusted project may select only names already defined in the global configuration.
 * Reject the whole overlay on malformed data, rather than partly enabling servers. */
async function loadProjectEnablement(
	cwd: string,
	serverNames: string[],
	warnings: string[],
): Promise<Map<string, boolean>> {
	const path = join(cwd, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return new Map();
		warnings.push(`Cannot read project MCP enablement at ${path}; using global enablement.`);
		return new Map();
	}
	const payload = asRecord(safeJsonParse(raw));
	const servers = asRecord(payload?.mcpServers);
	if (!payload || Object.keys(payload).some((key) => key !== "mcpServers") || !servers) {
		warnings.push(
			`Invalid project MCP enablement at ${path}; expected {"mcpServers":{"name":true|false}}. Using global enablement.`,
		);
		return new Map();
	}
	const selected = new Map<string, boolean>();
	for (const [name, value] of Object.entries(servers)) {
		if (!serverNames.includes(name) || typeof value !== "boolean") {
			warnings.push(
				`Invalid project MCP enablement at ${path}: unknown server or non-boolean entry "${name}". Using global enablement.`,
			);
			return new Map();
		}
		selected.set(name, value);
	}
	return selected;
}

function manifestTransport(record: Record<string, unknown>): ManifestTransport {
	const declared = readString(record, "type", "transport");
	const kind = declared ?? (readString(record, "command") ? "stdio" : readString(record, "url") ? "http" : undefined);
	if (kind === "stdio") return "stdio";
	if (kind === "http" || kind === "streamable-http" || kind === "sse") return "http";
	return "unknown";
}

function manifestAuthMode(record: Record<string, unknown> | undefined, transport: ManifestTransport): ManifestAuthMode {
	if (transport !== "http" || !record) return "none";
	const headers = asRecord(record.headers);
	if (headers && Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) return "static";
	const auth = record.auth;
	if (auth === false) return "none";
	if (typeof auth === "string" && readAuthMode(auth) === "none") return "none";
	const nested = asRecord(auth);
	if (nested) {
		const declared = readString(nested, "type", "mode");
		if (declared !== undefined && readAuthMode(declared) === "none") return "none";
	}
	return "oauth";
}

function sanitizeConfigError(error: unknown): string {
	return errorMessage(error)
		.replace(/https?:\/\/[^\s'"]+/gi, "[endpoint]")
		.replace(/(Bearer|Basic)\s+[^\s]+/gi, "$1 [redacted]")
		.slice(0, 300);
}

/** An unrecognised mode is a typo, not a reason to refuse the whole config; warn and fall back. */
function parseToolMode(
	record: Record<string, unknown>,
	where: string,
	fallback: ToolMode,
	warnings: string[],
): ToolMode {
	const declared = readString(record, "toolMode");
	if (declared === undefined) return fallback;
	if (isToolMode(declared)) return declared;
	warnings.push(`${where} "toolMode" is "${declared}"; expected ${TOOL_MODES.join(" or ")}. Using "${fallback}".`);
	return fallback;
}

function isToolMode(value: string): value is ToolMode {
	return (TOOL_MODES as readonly string[]).includes(value);
}

/**
 * `eagerTools` refines lazy mode only: an eager server already loads every tool,
 * so a list there is ignored with a warning rather than silently meaning nothing.
 * Non-string items are dropped the same way an unknown `toolMode` falls back.
 */
function parseEagerTools(
	record: Record<string, unknown>,
	where: string,
	toolMode: ToolMode,
	warnings: string[],
): readonly string[] {
	const value = record.eagerTools;
	if (value === undefined) return [];
	const list = asArray(value);
	if (!list) {
		warnings.push(`${where} "eagerTools" is not an array of tool names; ignoring it.`);
		return [];
	}
	const names = list.filter((item): item is string => typeof item === "string" && item.length > 0);
	if (names.length !== list.length) warnings.push(`${where} "eagerTools" has non-string entries; ignoring them.`);
	if (toolMode === "eager" && names.length > 0) {
		warnings.push(`${where} "eagerTools" only applies when "toolMode" is "lazy"; ignoring it.`);
		return [];
	}
	return [...new Set(names)];
}

/** `mcp.json` holds bearer tokens, so flag it if anyone but the owner can read it. */
async function checkPermissions(path: string, warnings: string[]): Promise<void> {
	try {
		const info = await stat(path);
		if ((info.mode & 0o077) !== 0) {
			warnings.push(`${path} is readable by other users. Run: chmod 600 ${path}`);
		}
	} catch {
		// Permission reporting is advisory; a stat failure must not block loading.
	}
}

/**
 * Fingerprint only the transport's redacted shape. In particular, resolved
 * environment values, header values, and token-like arguments never affect the
 * cache identity. This is deliberately computed from the raw JSON record,
 * before interpolation.
 */
export function serverConfigFingerprint(name: string, record: Record<string, unknown>): string {
	const transportKeys = new Set([
		"type",
		"transport",
		"url",
		"headers",
		"auth",
		"command",
		"args",
		"env",
		"cwd",
		"timeoutMs",
		"callTimeoutMs",
	]);
	const shape: Record<string, unknown> = { name };
	for (const key of [...transportKeys].sort()) {
		if (!(key in record)) continue;
		const value = record[key];
		if (key === "headers" || key === "env") {
			const map = asRecord(value);
			shape[key] = map
				? Object.fromEntries(
						Object.keys(map)
							.sort()
							.map((entry) => [entry, "<secret>"]),
					)
				: "<invalid>";
		} else if (key === "auth") {
			shape[key] = redactAuth(value);
		} else if (key === "args" && Array.isArray(value)) {
			// Command arguments are an unrestricted credential channel: positional
			// tokens do not necessarily have a revealing --token prefix. Preserve
			// only flag names and argument shape, never literal or resolved values.
			shape[key] = value.map(redactArgument);
		} else if (key === "url" && typeof value === "string") {
			shape[key] = redactUrl(value);
		} else if (typeof value === "string") {
			shape[key] = interpolateMarker(value);
		} else {
			shape[key] = value;
		}
	}
	return createHash("sha256").update(stableJson(shape)).digest("hex");
}

/** Keep the auth shape in the fingerprint, but never a client secret. */
function redactAuth(value: unknown): unknown {
	const record = asRecord(value);
	if (!record) return typeof value === "string" ? interpolateMarker(value) : value;
	const shape: Record<string, unknown> = {};
	for (const key of Object.keys(record).sort()) {
		const entry = record[key];
		if (/secret/i.test(key)) shape[key] = "<secret>";
		else if (typeof entry === "string") shape[key] = interpolateMarker(entry);
		else shape[key] = entry;
	}
	return shape;
}

function redactArgument(value: unknown): string {
	if (typeof value !== "string") return "<invalid>";
	const longFlag = value.match(/^(--[A-Za-z][A-Za-z0-9_-]*)(?:=.*)?$/);
	if (longFlag?.[1]) return value.includes("=") ? `${longFlag[1]}=<value>` : longFlag[1];
	const shortFlag = value.match(/^-([A-Za-z])(.*)$/);
	if (shortFlag?.[1]) return shortFlag[2] ? `-${shortFlag[1]}=<value>` : `-${shortFlag[1]}`;
	return "<arg>";
}

function interpolateMarker(value: string): string {
	return value.replace(ENV_REFERENCE, "<env>");
}

function redactUrl(value: string): string {
	const marked = interpolateMarker(value);
	try {
		const parsed = new URL(marked);
		parsed.username = "";
		parsed.password = "";
		parsed.search = "";
		parsed.hash = "";
		return parsed.toString().replace(/\/$/, "");
	} catch {
		return marked.split(/[?#]/, 1)[0] ?? marked;
	}
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function parseServer(name: string, record: Record<string, unknown>, warnings: string[]): ServerConfig {
	const declared = readString(record, "type", "transport");
	const url = readString(record, "url");
	const command = readString(record, "command");
	const kind = declared ?? (command ? "stdio" : url ? "http" : undefined);

	const timeoutMs = readNumber(record, "timeoutMs");
	const callTimeoutMs = readNumber(record, "callTimeoutMs");

	if (kind === "http" || kind === "streamable-http" || kind === "sse") {
		if (!url) throw new Error(`Server "${name}" is type ${kind} but has no "url".`);
		const headers = interpolateMap(readStringMap(record, "headers"), `${name}.headers`);
		return {
			type: "http",
			url: interpolate(url, `${name}.url`),
			headers,
			auth: parseHttpAuth(name, record, headers, warnings),
			timeoutMs,
			callTimeoutMs,
		};
	}

	if (kind === "stdio") {
		if (!command) throw new Error(`Server "${name}" is type stdio but has no "command".`);
		const args = (asArray(record.args) ?? []).filter((entry): entry is string => typeof entry === "string");
		const cwd = readString(record, "cwd");
		return {
			type: "stdio",
			command: interpolate(command, `${name}.command`),
			args: args.map((arg, index) => interpolate(arg, `${name}.args[${index}]`)),
			env: interpolateMap(readStringMap(record, "env"), `${name}.env`),
			cwd: cwd === undefined ? undefined : interpolate(cwd, `${name}.cwd`),
			timeoutMs,
			callTimeoutMs,
		};
	}

	throw new Error(`Server "${name}" has no usable transport. Set "url" for http or "command" for stdio.`);
}

/**
 * `"auth": "oauth"` / `"auth": "none"` covers the common cases; the object form
 * adds the fields a non-discoverable or non-interactive server needs. An
 * unrecognised value warns and falls back rather than dropping the server.
 */
function parseHttpAuth(
	name: string,
	record: Record<string, unknown>,
	headers: Record<string, string> | undefined,
	warnings: string[],
): HttpAuthConfig {
	const value = record.auth;
	if (value === undefined) return defaultHttpAuth(headers);
	if (typeof value === "boolean") return value ? { mode: "oauth" } : { mode: "none" };

	if (typeof value === "string") {
		const mode = readAuthMode(value);
		if (mode) return mode === "none" ? { mode: "none" } : { mode: "oauth" };
		warnings.push(`Server "${name}" "auth" is "${value}"; expected "oauth" or "none". Using the default.`);
		return defaultHttpAuth(headers);
	}

	const nested = asRecord(value);
	if (!nested) {
		warnings.push(`Server "${name}" "auth" is not a string or object; using the default.`);
		return defaultHttpAuth(headers);
	}
	const declared = readString(nested, "type", "mode");
	const mode = declared === undefined ? "oauth" : readAuthMode(declared);
	if (!mode) {
		warnings.push(`Server "${name}" "auth.type" is "${declared}"; expected "oauth" or "none". Using the default.`);
		return defaultHttpAuth(headers);
	}
	if (mode === "none") return { mode: "none" };

	const clientId = readString(nested, "clientId", "client_id");
	const clientSecret = readString(nested, "clientSecret", "client_secret");
	const authorizationServer = readString(nested, "authorizationServer", "authorization_server", "issuer");
	const scope = readString(nested, "scope");
	const browserTimeoutMs = readPositiveTimeout(name, nested, warnings, "browserTimeoutMs", "browser_timeout_ms");
	const lockWaitTimeoutMs = readPositiveTimeout(name, nested, warnings, "lockWaitTimeoutMs", "lock_wait_timeout_ms");
	return {
		mode: "oauth",
		scope: scope === undefined ? undefined : interpolate(scope, `${name}.auth.scope`),
		clientId: clientId === undefined ? undefined : interpolate(clientId, `${name}.auth.clientId`),
		clientSecret: clientSecret === undefined ? undefined : interpolate(clientSecret, `${name}.auth.clientSecret`),
		authorizationServer:
			authorizationServer === undefined
				? undefined
				: interpolate(authorizationServer, `${name}.auth.authorizationServer`),
		browser: readBoolean(nested, "browser", "interactive"),
		browserTimeoutMs,
		lockWaitTimeoutMs,
	};
}

/**
 * A zero or negative timeout would make the wait expire before it began, so it is
 * rejected with a warning and the built-in default is kept instead.
 */
function readPositiveTimeout(
	name: string,
	record: Record<string, unknown>,
	warnings: string[],
	...keys: string[]
): number | undefined {
	const value = readNumber(record, ...keys);
	if (value === undefined) return undefined;
	if (value <= 0) {
		warnings.push(`Server "${name}" "auth.${keys[0]}" is ${value}; expected a positive number. Using the default.`);
		return undefined;
	}
	return value;
}

function readAuthMode(value: string): "oauth" | "none" | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "oauth") return "oauth";
	if (normalized === "none" || normalized === "off") return "none";
	return undefined;
}

/** A hand-configured `Authorization` header wins: that path must behave exactly as before. */
function defaultHttpAuth(headers: Record<string, string> | undefined): HttpAuthConfig {
	const configured = Object.keys(headers ?? {}).some((key) => key.toLowerCase() === "authorization");
	return configured ? { mode: "none" } : { mode: "oauth" };
}

function interpolateMap(map: Record<string, string> | undefined, where: string): Record<string, string> | undefined {
	if (!map) return undefined;
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(map)) {
		out[key] = interpolate(value, `${where}.${key}`);
	}
	return out;
}

const ENV_REFERENCE = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/**
 * Every environment variable a raw server record references in an interpolated
 * field (`url`, `headers`, `command`, `args`, `env`, `cwd`, and the string `auth`
 * fields) that is unset, sorted and deduplicated. `interpolate` stops at the first
 * missing name; status surfaces want all of them so one relaunch fixes the whole
 * entry. Reads names only, never values, so the result is safe to print.
 */
function collectMissingEnv(record: Record<string, unknown>): string[] {
	const missing = new Set<string>();
	const visit = (node: unknown): void => {
		if (typeof node === "string") {
			for (const match of node.matchAll(ENV_REFERENCE)) {
				const name = match[2] ?? match[3];
				if (name && process.env[name] === undefined) missing.add(name);
			}
		} else if (Array.isArray(node)) {
			node.forEach(visit);
		} else if (node && typeof node === "object") {
			Object.values(node).forEach(visit);
		}
	};
	for (const key of ["url", "headers", "command", "args", "env", "cwd"]) visit(record[key]);
	const auth = asRecord(record.auth);
	if (auth) {
		for (const key of Object.keys(auth)) {
			if (/^(scope|client_?id|client_?secret|authorization_?server|issuer)$/i.test(key)) visit(auth[key]);
		}
	}
	return [...missing].sort();
}

/**
 * Replace `$NAME` and `${NAME}` with the environment value; `$$` is a literal `$`.
 * Errors name the variable and the field, never the resolved value.
 */
export function interpolate(value: string, where: string): string {
	return value.replace(ENV_REFERENCE, (match, escaped: string, braced?: string, bare?: string) => {
		if (escaped === "$") return "$";
		const name = braced ?? bare;
		if (!name) return match;
		const resolved = process.env[name];
		if (resolved === undefined) {
			throw new Error(`${where} references $${name}, which is not set in the environment.`);
		}
		return resolved;
	});
}
