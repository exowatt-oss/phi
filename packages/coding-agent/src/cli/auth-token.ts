import { readFileSync } from "node:fs";
import lockfile from "proper-lockfile";
import { APP_NAME, getAuthPath } from "../config.ts";

export const AUTH_TOKEN_PROVIDER_ID = process.env.PHI_AUTH_TOKEN_PROVIDER ?? "gateway";
export const AUTH_TOKEN_BASE_URL = process.env.PHI_AUTH_TOKEN_BASE_URL ?? "http://127.0.0.1:8790";

export interface AuthTokenCommand {
	help: boolean;
	json: boolean;
	force: boolean;
}

export class AuthTokenUsageError extends Error {}

export type AuthTokenResolution =
	| { status: "success"; token: string }
	| { status: "not_logged_in" }
	| { status: "malformed" };

type Environment = Record<string, string | undefined>;
type ReadAuthFile = (path: string) => string;
type CheckAuthFileLock = (path: string) => boolean;

export interface AuthTokenResolutionOptions {
	authPath?: string;
	env?: Environment;
	readFile?: ReadAuthFile;
	checkLock?: CheckAuthFileLock;
}

export interface AuthTokenCommandIo extends AuthTokenResolutionOptions {
	stdoutIsTTY: boolean;
	writeStdout?: (output: string) => void;
	writeStderr?: (output: string) => void;
}

const AUTH_FILE_STABILITY_TIMEOUT_MS = 1_000;
const AUTH_FILE_STABILITY_RETRY_DELAY_MS = 20;
const AUTH_FILE_STABILITY_SLEEP = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
// Match the longest stale threshold used by AuthStorage's writers so a crashed
// writer cannot permanently block this read-only command.
const AUTH_FILE_LOCK_STALE_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Environment {
	return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string" || entry === undefined);
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

const DEFAULT_CHECK_AUTH_FILE_LOCK: CheckAuthFileLock = (path) => {
	try {
		// Sync auth writes lock the configured path directly; async writes use
		// proper-lockfile's realpath default. Check both so symlinked agent dirs
		// cannot bypass snapshot coordination.
		return (
			lockfile.checkSync(path, { realpath: false, stale: AUTH_FILE_LOCK_STALE_MS }) ||
			lockfile.checkSync(path, { realpath: true, stale: AUTH_FILE_LOCK_STALE_MS })
		);
	} catch (error) {
		if (isMissingFileError(error)) return false;
		throw error;
	}
};

function sleepSync(delayMs: number): void {
	// Keep the pre-startup command path synchronous without burning CPU while a
	// concurrent auth-store writer finishes its in-place update.
	Atomics.wait(AUTH_FILE_STABILITY_SLEEP, 0, 0, delayMs);
}

type ReadAuthDataResult = { status: "ok"; data: unknown } | AuthTokenResolution;
type ReadAuthSnapshotResult = { status: "ok"; content: string } | AuthTokenResolution;

function retryUntilStable(deadline: number): boolean {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return false;
	sleepSync(Math.min(AUTH_FILE_STABILITY_RETRY_DELAY_MS, remaining));
	return true;
}

function readAuthSnapshot(
	authPath: string,
	readFile: ReadAuthFile,
	checkLock: CheckAuthFileLock,
): ReadAuthSnapshotResult {
	const deadline = Date.now() + AUTH_FILE_STABILITY_TIMEOUT_MS;

	for (;;) {
		let locked: boolean;
		try {
			locked = checkLock(authPath);
		} catch {
			return { status: "malformed" };
		}
		if (locked) {
			if (!retryUntilStable(deadline)) return { status: "malformed" };
			continue;
		}

		let first: string;
		try {
			first = readFile(authPath);
		} catch (error) {
			try {
				locked = checkLock(authPath);
			} catch {
				return { status: "malformed" };
			}
			if (locked) {
				if (!retryUntilStable(deadline)) return { status: "malformed" };
				continue;
			}
			return isMissingFileError(error) ? { status: "not_logged_in" } : { status: "malformed" };
		}

		try {
			locked = checkLock(authPath);
		} catch {
			return { status: "malformed" };
		}
		if (locked) {
			if (!retryUntilStable(deadline)) return { status: "malformed" };
			continue;
		}

		let second: string;
		try {
			second = readFile(authPath);
		} catch (error) {
			try {
				locked = checkLock(authPath);
			} catch {
				return { status: "malformed" };
			}
			if (locked) {
				if (!retryUntilStable(deadline)) return { status: "malformed" };
				continue;
			}
			return isMissingFileError(error) ? { status: "not_logged_in" } : { status: "malformed" };
		}

		try {
			locked = checkLock(authPath);
		} catch {
			return { status: "malformed" };
		}
		if (locked || first !== second) {
			if (!retryUntilStable(deadline)) return { status: "malformed" };
			continue;
		}

		return { status: "ok", content: second };
	}
}

function readAuthData(authPath: string, readFile: ReadAuthFile, checkLock: CheckAuthFileLock): ReadAuthDataResult {
	const snapshot = readAuthSnapshot(authPath, readFile, checkLock);
	if (snapshot.status !== "ok") return snapshot;
	try {
		return { status: "ok", data: JSON.parse(snapshot.content) as unknown };
	} catch {
		return { status: "malformed" };
	}
}

function resolveConfiguredApiKey(
	config: string,
	scopedEnv: Environment | undefined,
	ambientEnv: Environment,
): string | undefined {
	if (config.startsWith("!")) return undefined;

	let result = "";
	for (let index = 0; index < config.length; index++) {
		const character = config[index];
		if (character !== "$") {
			result += character;
			continue;
		}

		const next = config[index + 1];
		if (next === "$" || next === "!") {
			result += next;
			index++;
			continue;
		}

		if (next === "{") {
			const end = config.indexOf("}", index + 2);
			if (end >= 0) {
				const name = config.slice(index + 2, end);
				if (/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
					const value = scopedEnv?.[name] || ambientEnv[name];
					if (value === undefined || value === "") return undefined;
					result += value;
					index = end;
					continue;
				}
			}
			result += "$";
			continue;
		}

		const nameMatch = config.slice(index + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/u);
		if (!nameMatch) {
			result += "$";
			continue;
		}
		const name = nameMatch[0];
		const value = scopedEnv?.[name] || ambientEnv[name];
		if (value === undefined || value === "") return undefined;
		result += value;
		index += name.length;
	}

	return result || undefined;
}

export function parseAuthTokenCommand(args: string[]): AuthTokenCommand | undefined {
	if (args[0] !== "auth" || args[1] !== "token") return undefined;

	let help = false;
	let json = false;
	let force = false;
	for (const arg of args.slice(2)) {
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--json") {
			if (json) throw new AuthTokenUsageError("--json may only be specified once");
			json = true;
		} else if (arg === "--force") {
			if (force) throw new AuthTokenUsageError("--force may only be specified once");
			force = true;
		} else {
			throw new AuthTokenUsageError(`Unknown option for auth token: ${arg}`);
		}
	}

	return { help, json, force };
}

export function formatAuthTokenHelp(): string {
	return `Usage:
  ${APP_NAME} auth token [--json] [--force]

Prints the configured gateway API key to stdout without starting phi.
The command reads only the configured gateway in the global auth.json credential store;
it never reads provider/model configuration. --json emits the schemaVersion 1
response. Output to a TTY is refused unless --force is supplied.
`;
}

/**
 * Resolve only the configured gateway key from phi's global auth.json contract.
 *
 * Provider/model configuration is intentionally not consulted: project-local
 * configuration is untrusted input, and this export must not turn it into a
 * credential source. Command-backed `!` references are likewise ineligible.
 */
export function resolveAuthToken(options: AuthTokenResolutionOptions = {}): AuthTokenResolution {
	const authPath = options.authPath ?? getAuthPath();
	const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
	const checkLock = options.checkLock ?? DEFAULT_CHECK_AUTH_FILE_LOCK;
	const ambientEnv = options.env ?? process.env;

	const readResult = readAuthData(authPath, readFile, checkLock);
	if (readResult.status !== "ok") return readResult;
	const data = readResult.data;

	if (!isRecord(data)) return { status: "malformed" };
	const rawCredential = data[AUTH_TOKEN_PROVIDER_ID];
	if (rawCredential === undefined) return { status: "not_logged_in" };
	if (!isRecord(rawCredential)) return { status: "malformed" };

	// OAuth credentials are deliberately not eligible for this command. In particular,
	// never pass them through ModelRuntime, whose request path may refresh and persist them.
	if (rawCredential.type === "oauth") return { status: "not_logged_in" };
	if (rawCredential.type !== "api_key") return { status: "malformed" };
	if (rawCredential.key !== undefined && typeof rawCredential.key !== "string") {
		return { status: "malformed" };
	}
	if (rawCredential.env !== undefined && !isStringRecord(rawCredential.env)) {
		return { status: "malformed" };
	}

	const key = typeof rawCredential.key === "string" ? rawCredential.key : undefined;
	// Never execute command-backed credential references in a read-only export.
	if (key === undefined || key.startsWith("!")) return { status: "not_logged_in" };
	const token = resolveConfiguredApiKey(key, rawCredential.env, ambientEnv);
	return token === undefined ? { status: "not_logged_in" } : { status: "success", token };
}

export function formatAuthTokenOutput(token: string, json: boolean): string {
	if (!json) return `${token}\n`;
	return `${JSON.stringify({
		schemaVersion: 1,
		token,
		provider: AUTH_TOKEN_PROVIDER_ID,
		baseUrl: AUTH_TOKEN_BASE_URL,
		expiresAt: null,
	})}\n`;
}

export function runAuthTokenCommand(args: string[], io: AuthTokenCommandIo): number | undefined {
	let command: AuthTokenCommand | undefined;
	const writeStderr = io.writeStderr ?? ((output: string) => process.stderr.write(output));
	const writeStdout = io.writeStdout ?? ((output: string) => process.stdout.write(output));

	try {
		command = parseAuthTokenCommand(args);
	} catch (error) {
		const message = error instanceof AuthTokenUsageError ? error.message : "Invalid auth token usage";
		writeStderr(`Error: ${message}\n`);
		return 1;
	}
	if (!command) return undefined;
	if (command.help) {
		writeStdout(formatAuthTokenHelp());
		return 0;
	}

	if (io.stdoutIsTTY && !command.force) {
		writeStderr("Error: refusing to print an auth token to a TTY; use --force to override\n");
		return 4;
	}

	const resolution = resolveAuthToken(io);
	if (resolution.status === "malformed") {
		writeStderr("Error: auth store is malformed or unreadable\n");
		return 3;
	}
	if (resolution.status === "not_logged_in") {
		writeStderr("Error: no usable gateway API key is configured\n");
		return 2;
	}

	writeStdout(formatAuthTokenOutput(resolution.token, command.json));
	return 0;
}
