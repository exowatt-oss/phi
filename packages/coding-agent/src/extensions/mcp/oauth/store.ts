/**
 * On-disk OAuth credential store for MCP servers.
 *
 * The layout is deliberately `mcp-remote`'s, not a new one:
 * `~/.mcp-auth/mcp-remote-<version>/<md5-of-server-url>_{client_info,tokens}.json`.
 * Reusing it means an existing `npx mcp-remote` login carries straight over to
 * the native transport — nobody is forced through a browser again — and a phi
 * login keeps working if someone falls back to mcp-remote.
 *
 * Everything here is per-user secret material: files are written mode 0600
 * through a temp file and rename, and no value is ever put in a log line, an
 * error message, or a thrown stack.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { asRecord, readNumber, readString, safeJsonParse } from "../json.ts";

/** Point the whole store somewhere else. Used by tests; also an escape hatch. */
export const MCP_AUTH_DIR_ENV_VAR = "PHI_MCP_AUTH_DIR";

/** mcp-remote's own override, honoured so a customised layout keeps working. */
export const MCP_REMOTE_CONFIG_DIR_ENV_VAR = "MCP_REMOTE_CONFIG_DIR";

/**
 * Where a brand-new login is written when no `mcp-remote-*` directory exists
 * yet. Version-named to stay inside mcp-remote's namespace rather than forking
 * a second store; the number is only a directory name.
 */
export const DEFAULT_MCP_AUTH_VERSION_DIR = "mcp-remote-0.1.37";

const VERSION_DIR_PREFIX = "mcp-remote-";

export interface OAuthTokens {
	access_token: string;
	token_type?: string;
	refresh_token?: string;
	/** Lifetime in seconds as returned by the server. */
	expires_in?: number;
	/**
	 * Absolute expiry in epoch milliseconds. Our own addition: mcp-remote records
	 * only `expires_in`, which cannot be aged. Unknown keys are ignored by both
	 * readers, so writing it stays compatible.
	 */
	expires_at?: number;
	scope?: string;
}

export interface OAuthClientInfo {
	client_id: string;
	client_secret?: string;
	redirect_uris?: string[];
	scope?: string;
}

/** mcp-remote keys a server by the md5 of the exact URL string it was given. */
export function serverKey(serverUrl: string): string {
	return createHash("md5").update(serverUrl).digest("hex");
}

export interface CredentialPaths {
	dir: string;
	key: string;
	clientInfo: string;
	tokens: string;
	lock: string;
}

export function credentialPaths(dir: string, key: string): CredentialPaths {
	return {
		dir,
		key,
		clientInfo: join(dir, `${key}_client_info.json`),
		tokens: join(dir, `${key}_tokens.json`),
		lock: join(dir, `${key}_lock.json`),
	};
}

/**
 * Resolve the directory this server's credentials live in.
 *
 * Several `mcp-remote-*` directories can coexist (one per version ever run), so
 * prefer whichever already holds this server's files, newest first. Only when
 * the server is unknown to every one of them does a fresh directory get picked.
 */
export async function resolveCredentialPaths(serverUrl: string): Promise<CredentialPaths> {
	const key = serverKey(serverUrl);
	const explicit = process.env[MCP_AUTH_DIR_ENV_VAR];
	if (explicit) return credentialPaths(explicit, key);

	const base = process.env[MCP_REMOTE_CONFIG_DIR_ENV_VAR] ?? join(homedir(), ".mcp-auth");
	const candidates = (await readdir(base).catch(() => [] as string[]))
		.filter((name) => name.startsWith(VERSION_DIR_PREFIX))
		.sort(byVersionDesc);

	for (const name of candidates) {
		const paths = credentialPaths(join(base, name), key);
		if ((await fileExists(paths.tokens)) || (await fileExists(paths.clientInfo))) return paths;
	}
	return credentialPaths(join(base, candidates[0] ?? DEFAULT_MCP_AUTH_VERSION_DIR), key);
}

/** Newest version directory first, so a stale one never shadows a current login. */
function byVersionDesc(a: string, b: string): number {
	const left = versionParts(a);
	const right = versionParts(b);
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (right[index] ?? 0) - (left[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return b.localeCompare(a);
}

function versionParts(name: string): number[] {
	return name
		.slice(VERSION_DIR_PREFIX.length)
		.split(".")
		.map((part) => Number.parseInt(part, 10))
		.map((part) => (Number.isFinite(part) ? part : 0));
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Read/write access to one server's credentials. Reads are tolerant: a
 * hand-edited or half-written file reads as "nothing cached" so the caller falls
 * back to a real login instead of failing the session.
 */
export class CredentialStore {
	readonly paths: CredentialPaths;

	constructor(paths: CredentialPaths) {
		this.paths = paths;
	}

	static async open(serverUrl: string): Promise<CredentialStore> {
		return new CredentialStore(await resolveCredentialPaths(serverUrl));
	}

	async readTokens(): Promise<OAuthTokens | undefined> {
		const record = await this.readJson(this.paths.tokens);
		const accessToken = readString(record, "access_token");
		if (!accessToken) return undefined;
		return {
			access_token: accessToken,
			token_type: readString(record, "token_type"),
			refresh_token: readString(record, "refresh_token"),
			expires_in: readNumber(record, "expires_in"),
			expires_at: readNumber(record, "expires_at"),
			scope: readString(record, "scope"),
		};
	}

	async writeTokens(tokens: OAuthTokens): Promise<void> {
		await this.writeJson(this.paths.tokens, tokens);
	}

	async readClientInfo(): Promise<OAuthClientInfo | undefined> {
		const record = await this.readJson(this.paths.clientInfo);
		const clientId = readString(record, "client_id");
		if (!clientId) return undefined;
		const redirectUris = Array.isArray(record?.redirect_uris)
			? record.redirect_uris.filter((entry): entry is string => typeof entry === "string")
			: undefined;
		return {
			client_id: clientId,
			client_secret: readString(record, "client_secret"),
			redirect_uris: redirectUris,
			scope: readString(record, "scope"),
		};
	}

	async writeClientInfo(client: OAuthClientInfo): Promise<void> {
		await this.writeJson(this.paths.clientInfo, client);
	}

	/** A rejected refresh token is worse than none: it costs a round trip every session. */
	/**
	 * Delete the stored tokens.
	 *
	 * `expectedAccessToken` makes it a compare-and-delete: the file is removed only
	 * if it still holds the credential the caller decided was dead. Several phi
	 * processes share this file, so an unconditional delete can destroy tokens a
	 * peer wrote between the caller's read and this call — and the peer's tokens
	 * are, by construction, the working ones.
	 */
	async discardTokens(expectedAccessToken?: string): Promise<void> {
		if (expectedAccessToken === undefined) {
			await rm(this.paths.tokens, { force: true }).catch(() => undefined);
			return;
		}
		// Reading and then deleting would leave a window in which a peer's write
		// lands and is deleted anyway. Take the file out of the way by name first —
		// rename is atomic — and then decide about the object actually taken. Anything
		// a peer writes afterwards is a different file this call never touches.
		const quarantine = `${this.paths.tokens}.${process.pid}.${randomBytes(6).toString("hex")}.old`;
		try {
			await rename(this.paths.tokens, quarantine);
		} catch {
			return; // Already gone.
		}
		try {
			const taken = asRecord(safeJsonParse(await readFile(quarantine, "utf8")));
			if (taken && taken.access_token !== expectedAccessToken) {
				// Not the credential this caller condemned, so it must go back. If that
				// cannot be done, the file stays in quarantine rather than being deleted:
				// the costs are not symmetric — keeping a dead token costs one failed
				// request, deleting a live one costs everybody a browser login.
				if (!(await this.restoreTokens(quarantine, taken))) return;
			}
		} catch {
			// Unreadable or malformed: it was not usable anyway, so let it go.
		}
		await rm(quarantine, { force: true }).catch(() => undefined);
	}

	/** Put a quarantined credential back, keeping whichever copy is fresher. */
	private async restoreTokens(quarantine: string, taken: Record<string, unknown>): Promise<boolean> {
		try {
			// `link` refuses to replace, so it only succeeds when the slot is free.
			await link(quarantine, this.paths.tokens);
			return true;
		} catch {
			// Something is there now. Usually a peer published a newer credential and
			// theirs should stand — but another discarder may also have put back an
			// *older* one, so compare rather than assume.
			const current = await this.readTokens();
			if (!current) return false;
			const mine = readNumber(taken, "expires_at");
			if (mine !== undefined && (current.expires_at ?? 0) < mine) {
				await rename(quarantine, this.paths.tokens).catch(() => undefined);
			}
			return true;
		}
	}

	private async readJson(path: string): Promise<Record<string, unknown> | undefined> {
		try {
			return asRecord(safeJsonParse(await readFile(path, "utf8")));
		} catch {
			return undefined;
		}
	}

	private async writeJson(path: string, value: unknown): Promise<void> {
		await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
	}
}

/**
 * Create or replace a file that only the owner may read, without ever exposing a
 * readable-by-others window: the temp file is created 0600 and renamed into
 * place, and the directory itself is 0700.
 */
export async function writePrivateFile(path: string, contents: string): Promise<void> {
	const directory = path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || ".";
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temp = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
	try {
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(contents, "utf8");
		} finally {
			await handle.close();
		}
		await chmod(temp, 0o600);
		await rename(temp, path);
		await chmod(path, 0o600);
	} catch (error) {
		await unlink(temp).catch(() => undefined);
		throw error;
	}
}
