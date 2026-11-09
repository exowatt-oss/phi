/**
 * Apple Push Notification service, direct (no third party), token-based auth.
 *
 * - `apns.json` (0600): `{ teamId, keyId, keyPath, bundleId }`; `keyPath` points at a copied
 *   `AuthKey_<keyId>.p8` (0600). No config → pushes are silently off.
 * - Provider JWT: ES256 over `{ alg, kid }.{ iss, iat }`, signed with node:crypto
 *   (`dsaEncoding: "ieee-p1363"` gives the raw r||s signature JOSE wants), reused for ~50 min
 *   (APNs rejects tokens older than an hour and throttles refreshes more often than every 20).
 * - Transport: node:http2 to api.push.apple.com / api.sandbox.push.apple.com.
 * - 410, `BadDeviceToken`, `Unregistered` → the caller drops that device's registration.
 */

import { createPrivateKey, type KeyObject, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { type ClientHttp2Session, connect } from "node:http2";
import { join } from "node:path";
import { apnsJsonPath, apnsKeyDir } from "../paths.ts";
import type { PushRegistration } from "./devices.ts";
import { readJsonFile, secureRemoteDir, writeJsonFile, writePrivateFile } from "./files.ts";

export interface ApnsConfig {
	teamId: string;
	keyId: string;
	keyPath: string;
	bundleId: string;
}

export interface PushAlert {
	title: string;
	body: string;
}

export interface PushResult {
	ok: boolean;
	status?: number;
	reason?: string;
	/** True when APNs says the device token is dead; drop the registration. */
	drop: boolean;
}

/** Anything that can deliver an alert to one registration (the hub injects fakes in tests). */
export type PushSender = (
	registration: PushRegistration,
	alert: PushAlert,
	payload: Record<string, unknown>,
) => Promise<PushResult>;

const JWT_TTL_MS = 50 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 10_000;
const APNS_HOSTS = {
	production: "https://api.push.apple.com",
	sandbox: "https://api.sandbox.push.apple.com",
} as const;

export function loadApnsConfig(path = apnsJsonPath()): ApnsConfig | undefined {
	const raw = readJsonFile<Partial<ApnsConfig>>(path);
	if (!raw || typeof raw !== "object") return undefined;
	const { teamId, keyId, keyPath, bundleId } = raw;
	if (![teamId, keyId, keyPath, bundleId].every((v) => typeof v === "string" && v.length > 0)) return undefined;
	return raw as ApnsConfig;
}

/** Load an APNs `.p8` signing key and check it is an EC P-256 private key. */
export function loadApnsKey(pem: string | Buffer): KeyObject {
	const key = createPrivateKey(pem);
	if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
		throw new Error("APNs auth key must be an EC P-256 (.p8) private key");
	}
	return key;
}

/** ES256 provider token: header `{ alg: "ES256", kid }`, claims `{ iss: teamId, iat }`. */
export function createApnsJwt(teamId: string, keyId: string, key: KeyObject, nowMs = Date.now()): string {
	const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId })).toString("base64url");
	const claims = Buffer.from(JSON.stringify({ iss: teamId, iat: Math.floor(nowMs / 1000) })).toString("base64url");
	const signingInput = `${header}.${claims}`;
	const signature = sign("sha256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
	return `${signingInput}.${signature.toString("base64url")}`;
}

export function shouldDropRegistration(status: number | undefined, reason: string | undefined): boolean {
	return status === 410 || reason === "BadDeviceToken" || reason === "Unregistered";
}

export function buildPushBody(alert: PushAlert, payload: Record<string, unknown>): Record<string, unknown> {
	const threadId = typeof payload.sessionId === "string" ? payload.sessionId : undefined;
	return {
		aps: {
			alert: { title: alert.title, body: alert.body },
			sound: "default",
			...(threadId ? { "thread-id": threadId } : {}),
		},
		...payload,
	};
}

/**
 * Validate and install an APNs key: copies it to `<remoteDir>/apns/AuthKey_<keyId>.p8` (0600)
 * and writes `apns.json`.
 */
export function setupApns(options: { keyFile: string; keyId: string; teamId: string; bundleId: string }): ApnsConfig {
	const keyId = options.keyId.trim().toUpperCase();
	const teamId = options.teamId.trim().toUpperCase();
	const bundleId = options.bundleId.trim();
	if (!/^[A-Z0-9]{10}$/.test(keyId)) throw new Error("--key-id must be the 10-character APNs key id");
	if (!/^[A-Z0-9]{10}$/.test(teamId)) throw new Error("--team-id must be the 10-character Apple team id");
	if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId)) throw new Error("--bundle-id must be a bundle id");
	const pem = readFileSync(options.keyFile);
	loadApnsKey(pem);
	secureRemoteDir();
	mkdirSync(apnsKeyDir(), { recursive: true, mode: 0o700 });
	chmodSync(apnsKeyDir(), 0o700);
	const keyPath = join(apnsKeyDir(), `AuthKey_${keyId}.p8`);
	writePrivateFile(keyPath, pem.toString("utf8"));
	const config: ApnsConfig = { teamId, keyId, keyPath, bundleId };
	writeJsonFile(apnsJsonPath(), config);
	return config;
}

/**
 * APNs sender bound to `apns.json`. Re-reads the config (by mtime) on every send so
 * `phi remote push setup` takes effect without restarting the hub.
 */
export class ApnsClient {
	private readonly configPath: string;
	private cached: { mtimeMs: number; config: ApnsConfig; key: KeyObject } | undefined;
	private jwt: { value: string; issuedAt: number; keyId: string; teamId: string } | undefined;
	private readonly sessions = new Map<string, ClientHttp2Session>();

	constructor(configPath = apnsJsonPath()) {
		this.configPath = configPath;
	}

	/** Current config, or undefined when push is not configured (or the key is unreadable). */
	config(): ApnsConfig | undefined {
		return this.load()?.config;
	}

	readonly send: PushSender = async (registration, alert, payload) => {
		const loaded = this.load();
		if (!loaded) return { ok: false, reason: "not_configured", drop: false };
		const { config, key } = loaded;
		const host = APNS_HOSTS[registration.env === "sandbox" ? "sandbox" : "production"];
		const topic = registration.bundleId || config.bundleId;
		const token = this.token(config, key);
		const body = JSON.stringify(buildPushBody(alert, payload));
		try {
			const { status, responseBody } = await this.post(host, `/3/device/${registration.apnsToken}`, body, {
				authorization: `bearer ${token}`,
				"apns-push-type": "alert",
				"apns-topic": topic,
				"apns-priority": "10",
				"content-type": "application/json",
			});
			let reason: string | undefined;
			try {
				reason = responseBody ? (JSON.parse(responseBody) as { reason?: string }).reason : undefined;
			} catch {
				reason = undefined;
			}
			if (reason === "ExpiredProviderToken" || reason === "InvalidProviderToken") this.jwt = undefined;
			return { ok: status === 200, status, reason, drop: shouldDropRegistration(status, reason) };
		} catch (error) {
			return { ok: false, reason: error instanceof Error ? error.message : String(error), drop: false };
		}
	};

	close(): void {
		for (const session of this.sessions.values()) session.close();
		this.sessions.clear();
	}

	private load(): { config: ApnsConfig; key: KeyObject } | undefined {
		let mtimeMs: number;
		try {
			mtimeMs = statSync(this.configPath).mtimeMs;
		} catch {
			this.cached = undefined;
			return undefined;
		}
		if (this.cached && this.cached.mtimeMs === mtimeMs) return this.cached;
		const config = loadApnsConfig(this.configPath);
		if (!config) return undefined;
		try {
			const key = loadApnsKey(readFileSync(config.keyPath));
			this.cached = { mtimeMs, config, key };
			this.jwt = undefined;
			return this.cached;
		} catch {
			return undefined;
		}
	}

	private token(config: ApnsConfig, key: KeyObject): string {
		const now = Date.now();
		const jwt = this.jwt;
		if (jwt && jwt.keyId === config.keyId && jwt.teamId === config.teamId && now - jwt.issuedAt < JWT_TTL_MS) {
			return jwt.value;
		}
		const value = createApnsJwt(config.teamId, config.keyId, key, now);
		this.jwt = { value, issuedAt: now, keyId: config.keyId, teamId: config.teamId };
		return value;
	}

	private session(origin: string): ClientHttp2Session {
		const existing = this.sessions.get(origin);
		if (existing && !existing.closed && !existing.destroyed) return existing;
		const session = connect(origin);
		session.unref();
		const drop = () => {
			if (this.sessions.get(origin) === session) this.sessions.delete(origin);
		};
		session.on("error", drop);
		session.on("goaway", drop);
		session.on("close", drop);
		session.setTimeout(5 * 60 * 1000, () => session.close());
		this.sessions.set(origin, session);
		return session;
	}

	private post(
		origin: string,
		path: string,
		body: string,
		headers: Record<string, string>,
	): Promise<{ status: number; responseBody: string }> {
		return new Promise((resolve, reject) => {
			const session = this.session(origin);
			const req = session.request({ ":method": "POST", ":path": path, ...headers });
			let status = 0;
			let responseBody = "";
			const timer = setTimeout(() => {
				req.close();
				reject(new Error("APNs request timed out"));
			}, REQUEST_TIMEOUT_MS);
			req.setEncoding("utf8");
			req.on("response", (h) => {
				status = Number(h[":status"] ?? 0);
			});
			req.on("data", (chunk: string) => {
				responseBody += chunk;
			});
			req.on("end", () => {
				clearTimeout(timer);
				resolve({ status, responseBody });
			});
			req.on("error", (error) => {
				clearTimeout(timer);
				reject(error);
			});
			req.end(body);
		});
	}
}
