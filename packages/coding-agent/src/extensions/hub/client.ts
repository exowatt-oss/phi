import { asRecord, readBoolean, readList, readNumber, readString, readStringArray } from "./json.ts";
import type { BundleRef } from "./refs.ts";
import { bundleKey } from "./refs.ts";
import type { BundleFile } from "./store.ts";

/**
 * REST client for the phi hub (`phi-hub/docs/contract.md`). Plain `fetch` with
 * a `phk_` bearer token; no network work ever happens at extension load, only
 * inside commands and tools.
 */

export interface HubProfile {
	handle: string;
	displayName?: string;
	email?: string;
}

export interface HubBundleSummary {
	owner: string;
	slug: string;
	title?: string;
	description?: string;
	kind?: string;
	tags: string[];
	latestVersion?: number;
	installCount?: number;
	updatedAt?: string;
	/** Whether the owner is an org profile; undefined when the hub does not say. */
	ownerIsOrg?: boolean;
}

export interface HubBundleDetail extends HubBundleSummary {
	versions: number[];
}

/** One installed bundle as sent to `POST /api/updates/check`. */
export interface InstalledBundleVersion {
	/** `owner/slug`. */
	ref: string;
	version: number;
}

/** A bundle the hub reports as having a version newer than the installed one. */
export interface HubUpdateRow {
	/** `owner/slug`. */
	key: string;
	latestVersion: number;
	kind?: string;
	title?: string;
	changelog?: string;
	/**
	 * Whether the owner is an org profile. Undefined when this hub does not say;
	 * callers must treat unknown as personal rather than guessing.
	 */
	ownerIsOrg?: boolean;
}

export interface HubUpdateCheck {
	updates: HubUpdateRow[];
	/** Refs the hub no longer knows about (deleted or renamed). Never auto-removed. */
	missing: string[];
}

export type HubEventAction = "imported" | "enabled" | "disabled" | "removed" | "applied";

export interface DeviceFlowStart {
	deviceCode: string;
	userCode: string;
	verifyUrl: string;
	intervalSeconds: number;
	expiresInSeconds: number;
}

export type DeviceFlowPoll =
	| { status: "pending" }
	| { status: "denied" }
	| { status: "expired" }
	| { status: "approved"; token: string; profile?: HubProfile };

export interface PublishVersionInput {
	changelog?: string;
	piManifest?: Record<string, unknown>;
	files: BundleFile[];
}

export interface CreateBundleInput {
	slug: string;
	title: string;
	description: string;
	kind: string;
	tags?: string[];
	/** Org handle to publish under. Omitted means "my own profile". */
	owner?: string;
}

/**
 * A hub response the caller can act on: 401 means "log in", 403 means "get the
 * permission" (the token is fine), other 4xx mean "fix the request".
 */
export class HubError extends Error {
	status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "HubError";
		this.status = status;
	}
}

function parseProfile(payload: unknown): HubProfile | undefined {
	const record = asRecord(payload);
	const nested = asRecord(record?.profile) ?? record;
	const handle = readString(nested, "handle");
	if (!handle) return undefined;
	return {
		handle,
		displayName: readString(nested, "display_name", "displayName"),
		email: readString(nested, "email"),
	};
}

/**
 * Org ownership, wherever this hub happens to put it: on the row itself, or on
 * the owner profile it embeds. Undefined when nothing says — a hub that predates
 * Marketplace v2 reports nothing, and unknown must never read as "org".
 */
function parseOwnerIsOrg(record: Record<string, unknown> | undefined): boolean | undefined {
	const direct = readBoolean(record, "owner_is_org", "ownerIsOrg", "is_org", "isOrg");
	if (direct !== undefined) return direct;
	const profile = asRecord(record?.owner_profile) ?? asRecord(record?.ownerProfile);
	return readBoolean(profile, "is_org", "isOrg");
}

function parseSummary(payload: unknown, fallback?: BundleRef): HubBundleSummary | undefined {
	const record = asRecord(payload);
	const owner = readString(record, "owner", "owner_handle", "ownerHandle") ?? fallback?.owner;
	const slug = readString(record, "slug") ?? fallback?.slug;
	if (!owner || !slug) return undefined;
	return {
		owner,
		slug,
		title: readString(record, "title"),
		description: readString(record, "description"),
		kind: readString(record, "kind"),
		tags: readStringArray(record, "tags") ?? [],
		latestVersion: readNumber(record, "latest_version", "latestVersion", "version"),
		installCount: readNumber(record, "install_count", "installCount"),
		updatedAt: readString(record, "updated_at", "updatedAt"),
		ownerIsOrg: parseOwnerIsOrg(record),
	};
}

function parseVersions(payload: unknown): number[] {
	const versions = readList(asRecord(payload)?.versions, "items");
	const numbers: number[] = [];
	for (const entry of versions) {
		if (typeof entry === "number" && Number.isFinite(entry)) {
			numbers.push(entry);
			continue;
		}
		const version = readNumber(asRecord(entry), "version", "number");
		if (version !== undefined) numbers.push(version);
	}
	return numbers.sort((left, right) => left - right);
}

export class HubClient {
	readonly url: string;
	private token: string | undefined;

	constructor(url: string, token?: string) {
		this.url = url.replace(/\/+$/, "");
		this.token = token;
	}

	get hasToken(): boolean {
		return Boolean(this.token);
	}

	private async request(
		path: string,
		options: { method?: string; body?: unknown; anonymous?: boolean; signal?: AbortSignal } = {},
	): Promise<unknown> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (options.body !== undefined) headers["Content-Type"] = "application/json";
		if (!options.anonymous) {
			if (!this.token) {
				throw new HubError("Not signed in to the phi hub. Run /hub login.", 401);
			}
			headers.Authorization = `Bearer ${this.token}`;
		}

		let response: Response;
		try {
			response = await fetch(`${this.url}${path}`, {
				method: options.method ?? "GET",
				headers,
				body: options.body === undefined ? undefined : JSON.stringify(options.body),
				signal: options.signal,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new HubError(
				`Could not reach the phi hub at ${this.url} (${detail}). Check your network or VPN connection.`,
			);
		}

		if (!response.ok) {
			// One read for every failure branch: the hub's own `detail` is the
			// actionable half of an auth error ("You are not a publisher for
			// 'demo-org'. An existing publisher can add you at /p/demo-org."), and a
			// Response body can only be consumed once.
			const text = await response.text().catch(() => "");
			const detail = readString(asRecord(safeJsonParse(text)), "detail", "message");
			const prefix = `phi hub ${response.status} on ${path}`;
			// 401 is genuinely a credential problem — absent, unknown, or revoked
			// token — so re-authenticating is the fix.
			if (response.status === 401) {
				throw new HubError(
					`${prefix}: ${asSentence(detail ?? "the hub rejected your token")} Run /hub login to sign in again.`,
					response.status,
				);
			}
			// 403 means the token is fine and the grant is missing, so never point at
			// /hub login: signing in again cannot add a permission the account lacks.
			if (response.status === 403) {
				throw new HubError(
					`${prefix}: ${asSentence(detail ?? "your account is not allowed to do this")} Your token is valid, so this is a permissions problem: signing in again will not fix it.`,
					response.status,
				);
			}
			const summary = detail ?? text.slice(0, 300);
			throw new HubError(`${prefix}${summary ? `: ${summary}` : ""}`, response.status);
		}
		if (response.status === 204) return undefined;
		const text = await response.text();
		return text ? safeJsonParse(text) : undefined;
	}

	setToken(token: string | undefined): void {
		this.token = token;
	}

	async whoami(signal?: AbortSignal): Promise<HubProfile> {
		const profile = parseProfile(await this.request("/api/me", { signal }));
		if (!profile) throw new HubError("The phi hub returned a profile without a handle.");
		return profile;
	}

	async searchBundles(
		query: { q?: string; kind?: string; owner?: string; sort?: string },
		signal?: AbortSignal,
	): Promise<HubBundleSummary[]> {
		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query)) {
			if (value) params.set(key, value);
		}
		const suffix = params.size > 0 ? `?${params.toString()}` : "";
		const payload = await this.request(`/api/bundles${suffix}`, { signal });
		return readList(payload, "items", "bundles", "results")
			.map((entry) => parseSummary(entry))
			.filter((entry): entry is HubBundleSummary => entry !== undefined);
	}

	async getBundle(ref: BundleRef, signal?: AbortSignal): Promise<HubBundleDetail> {
		const payload = await this.request(`/api/bundles/${ref.owner}/${ref.slug}`, { signal });
		const summary = parseSummary(payload, ref);
		if (!summary) throw new HubError(`The phi hub returned no metadata for ${bundleKey(ref)}.`);
		const versions = parseVersions(payload);
		const latestVersion = summary.latestVersion ?? versions[versions.length - 1];
		// The detail envelope nests the bundle metadata, so org ownership can sit
		// either at the top level (owner_profile) or inside `bundle`.
		const ownerIsOrg = summary.ownerIsOrg ?? parseOwnerIsOrg(asRecord(asRecord(payload)?.bundle));
		return { ...summary, latestVersion, versions, ownerIsOrg };
	}

	/**
	 * One round trip for every installed bundle (hub contract, "Update
	 * checking"). Returns the bundles with a newer version plus the refs the hub
	 * no longer knows about.
	 */
	async checkUpdates(installed: InstalledBundleVersion[], signal?: AbortSignal): Promise<HubUpdateCheck> {
		if (installed.length === 0) return { updates: [], missing: [] };

		let payload: unknown;
		try {
			payload = await this.request("/api/updates/check", {
				method: "POST",
				body: { installed: installed.map((entry) => ({ ref: entry.ref, version: entry.version })) },
				signal,
			});
		} catch (error) {
			if (error instanceof HubError && error.status === 404) {
				throw new HubError(
					`The phi hub at ${this.url} has no /api/updates/check endpoint; it predates the marketplace. Use /hub sync instead.`,
					404,
				);
			}
			throw error;
		}

		const record = asRecord(payload);
		const updates: HubUpdateRow[] = [];
		for (const entry of readList(record?.updates, "items")) {
			const row = asRecord(entry);
			const owner = readString(row, "owner", "owner_handle", "ownerHandle");
			const slug = readString(row, "slug");
			const key = readString(row, "ref") ?? (owner && slug ? `${owner}/${slug}` : undefined);
			const latestVersion = readNumber(row, "latest_version", "latestVersion", "version");
			if (!key || latestVersion === undefined) continue;
			updates.push({
				key,
				latestVersion,
				kind: readString(row, "kind"),
				title: readString(row, "title"),
				changelog: readString(row, "changelog"),
				ownerIsOrg: parseOwnerIsOrg(row),
			});
		}

		const missing: string[] = [];
		for (const entry of readList(record?.missing)) {
			if (typeof entry === "string") {
				missing.push(entry);
				continue;
			}
			const ref = readString(asRecord(entry), "ref");
			if (ref) missing.push(ref);
		}

		return { updates, missing };
	}

	async getVersionFiles(ref: BundleRef, signal?: AbortSignal): Promise<BundleFile[]> {
		const version = ref.version === undefined ? "latest" : String(ref.version);
		const payload = await this.request(`/api/bundles/${ref.owner}/${ref.slug}/versions/${version}/files`, { signal });
		const files: BundleFile[] = [];
		for (const entry of readList(payload, "files", "items")) {
			const record = asRecord(entry);
			const path = readString(record, "path");
			const encoded = readString(record, "content_b64", "contentB64");
			if (!path || encoded === undefined) continue;
			files.push({ path, content: Buffer.from(encoded, "base64") });
		}
		if (files.length === 0) {
			throw new HubError(`Version ${version} of ${bundleKey(ref)} has no files.`);
		}
		return files;
	}

	/** Create is idempotent from the caller's point of view: an existing slug is fine. */
	async createBundle(input: CreateBundleInput, signal?: AbortSignal): Promise<void> {
		try {
			await this.request("/api/bundles", { method: "POST", body: input, signal });
		} catch (error) {
			if (error instanceof HubError && error.status === 409) return;
			throw error;
		}
	}

	async publishVersion(ref: BundleRef, input: PublishVersionInput, signal?: AbortSignal): Promise<number> {
		const body: Record<string, unknown> = {
			files: input.files.map((file) => ({
				path: file.path,
				content_b64: file.content.toString("base64"),
			})),
		};
		if (input.changelog) body.changelog = input.changelog;
		if (input.piManifest) body.pi_manifest = input.piManifest;
		const payload = await this.request(`/api/bundles/${ref.owner}/${ref.slug}/versions`, {
			method: "POST",
			body,
			signal,
		});
		// The publish response nests version metadata: {version: {version: N, ...}}.
		const record = asRecord(payload);
		return (
			readNumber(asRecord(record?.version), "version") ??
			readNumber(record, "version", "latest_version", "latestVersion") ??
			0
		);
	}

	/** Import telemetry. Never fatal: a failed event must not undo a good local operation. */
	async recordEvent(ref: BundleRef, action: HubEventAction, version?: number): Promise<void> {
		const body: Record<string, unknown> = { action };
		if (version !== undefined) body.version = version;
		try {
			await this.request(`/api/bundles/${ref.owner}/${ref.slug}/events`, { method: "POST", body });
		} catch {
			// Telemetry is best effort.
		}
	}

	async startDeviceFlow(deviceName: string, signal?: AbortSignal): Promise<DeviceFlowStart> {
		const payload = asRecord(
			await this.request("/api/auth/device/start", {
				method: "POST",
				body: { device_name: deviceName },
				anonymous: true,
				signal,
			}),
		);
		const deviceCode = readString(payload, "device_code", "deviceCode");
		const userCode = readString(payload, "user_code", "userCode");
		const verifyUrl = readString(payload, "verify_url", "verifyUrl");
		if (!deviceCode || !userCode || !verifyUrl) {
			throw new HubError("The phi hub returned an incomplete device-flow response.");
		}
		return {
			deviceCode,
			userCode,
			verifyUrl,
			intervalSeconds: readNumber(payload, "interval") ?? 5,
			expiresInSeconds: readNumber(payload, "expires_in", "expiresIn") ?? 900,
		};
	}

	async pollDeviceFlow(deviceCode: string, signal?: AbortSignal): Promise<DeviceFlowPoll> {
		const payload = asRecord(
			await this.request("/api/auth/device/poll", {
				method: "POST",
				body: { device_code: deviceCode },
				anonymous: true,
				signal,
			}),
		);
		const status = readString(payload, "status") ?? "pending";
		if (status === "approved") {
			const token = readString(payload, "token");
			if (!token) throw new HubError("The phi hub approved the device but returned no token.");
			return { status: "approved", token, profile: parseProfile(payload) };
		}
		if (status === "denied" || status === "expired") return { status };
		return { status: "pending" };
	}
}

/** The hub's own wording as a sentence, so advice appended after it is punctuated once. */
function asSentence(text: string): string {
	const trimmed = text.trim();
	return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}
