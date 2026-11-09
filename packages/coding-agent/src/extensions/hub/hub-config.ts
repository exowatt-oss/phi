import { chmod, mkdir, readFile, writeFile } from "fs/promises";
import { dirname } from "path";
import { asRecord, readString } from "./json.ts";

export const DEFAULT_HUB_URL = "http://127.0.0.1:8787";
export const HUB_URL_ENV = "PHI_HUB_URL";

/** `hub.json` — the client's url + credential + cached identity. */
export interface HubConfig {
	url: string;
	token?: string;
	handle?: string;
	email?: string;
}

/** Hub tokens are `phk_` + 40 hex characters (see the hub contract, "Identity"). */
export function isHubToken(value: string): boolean {
	return /^phk_[0-9a-f]{40}$/i.test(value.trim());
}

export function normalizeHubUrl(url: string): string {
	return url.trim().replace(/\/+$/, "");
}

/** `PHI_HUB_URL` beats the stored url, which beats the default deployment. */
export function resolveHubUrl(storedUrl?: string): string {
	const override = process.env[HUB_URL_ENV];
	if (override?.trim()) return normalizeHubUrl(override);
	if (storedUrl?.trim()) return normalizeHubUrl(storedUrl);
	return DEFAULT_HUB_URL;
}

export async function readHubConfig(configPath: string): Promise<HubConfig> {
	let raw: string;
	try {
		raw = await readFile(configPath, "utf-8");
	} catch {
		return { url: resolveHubUrl() };
	}

	let stored: Record<string, unknown> | undefined;
	try {
		stored = asRecord(JSON.parse(raw));
	} catch {
		throw new Error(`${configPath} is not valid JSON. Fix or delete it, then run /hub login.`);
	}

	return {
		url: resolveHubUrl(readString(stored, "url")),
		token: readString(stored, "token"),
		handle: readString(stored, "handle"),
		email: readString(stored, "email"),
	};
}

/** Persist `hub.json` with owner-only permissions; it holds a bearer token. */
export async function writeHubConfig(configPath: string, config: HubConfig): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	await chmod(configPath, 0o600);
}
