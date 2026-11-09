// Exowatt fork test: the hub client's import lifecycle against a stub hub.
// The invariant under test is "no muddling": an imported bundle lives in its own
// store and is linked by exactly one absolute-path entry in global settings, so
// disable/enable/remove are single reversible operations with zero residue.
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { writeHubConfig } from "../src/extensions/hub/hub-config.ts";
import { repairHubPackageLinks } from "../src/extensions/hub/link-repair.ts";
import { enabledModelBundlePaths } from "../src/extensions/hub/model-bundles.ts";
import {
	createHubEnvironment,
	formatStatus,
	type HubEnvironment,
	hubStatus,
	importBundle,
	installBundle,
	publishBundle,
	removeBundle,
	setBundleEnabled,
	syncBundles,
} from "../src/extensions/hub/operations.ts";
import { readLinkedPackagePaths } from "../src/extensions/hub/settings-file.ts";
import { readHubState, readHubStateFile, recordUpdateCheck, writeHubState } from "../src/extensions/hub/state.ts";
import { readProvenance } from "../src/extensions/hub/store.ts";
import {
	formatStartupNotice,
	formatUpdateResult,
	runStartupUpdateCheck,
	type StartupCheckOutcome,
	updateBundles,
} from "../src/extensions/hub/updates.ts";

const TOKEN = `phk_${"a".repeat(40)}`;

interface StubHub {
	url: string;
	latestVersion: number;
	filesByVersion: Map<number, Array<{ path: string; content: string | Buffer }>>;
	events: Array<{ path: string; action: string; version?: number }>;
	published: Array<{ path: string; body: Record<string, unknown> }>;
	/** Every `POST /api/bundles` body, so the org owner is assertable. */
	created: Array<Record<string, unknown>>;
	/** Every `POST /api/updates/check` payload, so "one round trip" is assertable. */
	updateChecks: Array<Array<{ ref: string; version: number }>>;
	/** Refs the hub reports as gone. */
	missingRefs: Set<string>;
	/** Whether tester is an org profile. Undefined means this hub never says. */
	ownerIsOrg?: boolean;
	/** Whether org ownership rides on the check response or only on bundle metadata. */
	orgInCheckResponse: boolean;
}

const servers: Server[] = [];
let root: string;
let agentDir: string;
let projectDir: string;
let hub: StubHub;
let env: HubEnvironment;

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	const text = Buffer.concat(chunks).toString("utf-8");
	return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function sendJson(response: ServerResponse, value: unknown, status = 200): void {
	response.writeHead(status, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

async function startStubHub(): Promise<StubHub> {
	const state: StubHub = {
		url: "",
		latestVersion: 1,
		filesByVersion: new Map([[1, [{ path: "skills/routing/SKILL.md", content: "# Routing\nv1 skill\n" }]]]),
		events: [],
		published: [],
		created: [],
		updateChecks: [],
		missingRefs: new Set(),
		orgInCheckResponse: true,
	};

	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? "/", "http://localhost");
			const path = url.pathname;

			if (path === "/api/me") return sendJson(response, { handle: "tester", email: "tester@example.invalid" });
			if (path === "/api/bundles" && request.method === "POST") {
				state.created.push(await readBody(request));
				return sendJson(response, { slug: "mine" }, 201);
			}
			if (path === "/api/bundles/tester/routing" && request.method === "GET") {
				return sendJson(response, {
					owner: "tester",
					slug: "routing",
					title: "Routing skill",
					kind: "skill",
					latest_version: state.latestVersion,
					versions: [...state.filesByVersion.keys()].map((version) => ({ version })),
					owner_profile:
						state.ownerIsOrg === undefined
							? { handle: "tester" }
							: { handle: "tester", is_org: state.ownerIsOrg },
				});
			}
			if (path === "/api/updates/check" && request.method === "POST") {
				const body = await readBody(request);
				const installed = Array.isArray(body.installed)
					? (body.installed as Array<{ ref: string; version: number }>)
					: [];
				state.updateChecks.push(installed);
				const updates: Array<Record<string, unknown>> = [];
				const missing: string[] = [];
				for (const entry of installed) {
					if (state.missingRefs.has(entry.ref)) {
						missing.push(entry.ref);
						continue;
					}
					if (entry.ref !== "tester/routing" || state.latestVersion <= entry.version) continue;
					const row: Record<string, unknown> = {
						ref: entry.ref,
						latest_version: state.latestVersion,
						kind: "skill",
						title: "Routing skill",
						changelog: `v${state.latestVersion}`,
					};
					if (state.orgInCheckResponse && state.ownerIsOrg !== undefined) row.owner_is_org = state.ownerIsOrg;
					updates.push(row);
				}
				return sendJson(response, { updates, missing });
			}
			const filesMatch = /^\/api\/bundles\/tester\/routing\/versions\/([^/]+)\/files$/.exec(path);
			if (filesMatch) {
				const requested = filesMatch[1] === "latest" ? state.latestVersion : Number.parseInt(filesMatch[1], 10);
				const files = state.filesByVersion.get(requested);
				if (!files) return sendJson(response, { detail: "no such version" }, 404);
				return sendJson(
					response,
					files.map((file) => ({ path: file.path, content_b64: Buffer.from(file.content).toString("base64") })),
				);
			}
			const eventsMatch = /^\/api\/bundles\/([^/]+)\/([^/]+)\/events$/.exec(path);
			if (eventsMatch && request.method === "POST") {
				const body = await readBody(request);
				state.events.push({
					path: `${eventsMatch[1]}/${eventsMatch[2]}`,
					action: String(body.action),
					version: typeof body.version === "number" ? body.version : undefined,
				});
				response.writeHead(204);
				return response.end();
			}
			const versionsMatch = /^\/api\/bundles\/([^/]+)\/([^/]+)\/versions$/.exec(path);
			if (versionsMatch && request.method === "POST") {
				const body = await readBody(request);
				state.published.push({ path: `${versionsMatch[1]}/${versionsMatch[2]}`, body });
				return sendJson(response, { version: 1 }, 201);
			}
			return sendJson(response, { detail: `unhandled ${request.method} ${path}` }, 404);
		})();
	});

	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return state;
}

beforeEach(async () => {
	vi.stubEnv("PHI_HUB_URL", "");
	root = mkdtempSync(join(tmpdir(), "phi-hub-import-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	hub = await startStubHub();
	await writeHubConfig(join(agentDir, "hub.json"), { url: hub.url, token: TOKEN, handle: "tester" });
	env = createHubEnvironment(projectDir, agentDir);
});

afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
	rmSync(root, { recursive: true, force: true });
});

function readSettings(): Record<string, unknown> {
	const path = join(agentDir, "settings.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
}

describe("hub import lifecycle", () => {
	it("materializes into the store and links exactly one packages entry", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:pi-skills"] }));

		const result = await importBundle(env, "tester/routing");

		expect(result.version).toBe(1);
		expect(result.kinds).toEqual(["skills"]);
		expect(readFileSync(join(result.path, "skills/routing/SKILL.md"), "utf-8")).toContain("v1 skill");
		expect(await readProvenance(result.path)).toEqual({ owner: "tester", slug: "routing", version: 1 });

		const settings = readSettings();
		expect(settings.packages).toEqual(["npm:pi-skills", result.path]);
		expect(settings.theme).toBe("dark");

		const state = await readHubState(env.paths.statePath);
		expect(state["tester/routing"]).toMatchObject({
			version: 1,
			enabled: true,
			path: result.path,
			kinds: ["skills"],
		});
		expect(hub.events.at(-1)).toEqual({ path: "tester/routing", action: "imported", version: 1 });
	});

	it("disable removes only the link, enable puts it back", async () => {
		const result = await importBundle(env, "tester/routing");

		await setBundleEnabled(env, "tester/routing", false);
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
		expect(existsSync(join(result.path, "skills/routing/SKILL.md"))).toBe(true);
		expect((await readHubState(env.paths.statePath))["tester/routing"].enabled).toBe(false);
		expect(hub.events.at(-1)?.action).toBe("disabled");

		await setBundleEnabled(env, "tester/routing", true);
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);
		expect((await readHubState(env.paths.statePath))["tester/routing"].enabled).toBe(true);
		expect(hub.events.at(-1)?.action).toBe("enabled");
	});

	it("re-import repoints the entry and deletes the superseded version dir", async () => {
		const first = await importBundle(env, "tester/routing");

		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "# Routing\nv2 skill\n" }]);
		const second = await importBundle(env, "tester/routing");

		expect(second.version).toBe(2);
		expect(second.previousVersion).toBe(1);
		expect(existsSync(first.path)).toBe(false);
		expect(readLinkedPackagePaths(env.storage)).toEqual([second.path]);
		expect(readFileSync(join(second.path, "skills/routing/SKILL.md"), "utf-8")).toContain("v2 skill");
	});

	it("re-import of a disabled bundle stays disabled and unlinked", async () => {
		await importBundle(env, "tester/routing");
		await setBundleEnabled(env, "tester/routing", false);

		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "v2" }]);
		const second = await importBundle(env, "tester/routing");

		expect(second.enabled).toBe(false);
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
	});

	it("honours a pinned version", async () => {
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "v2" }]);
		const result = await importBundle(env, "tester/routing@1");
		expect(result.version).toBe(1);
		expect(readFileSync(join(result.path, "skills/routing/SKILL.md"), "utf-8")).toContain("v1 skill");
	});

	it("remove unlinks, deletes the store, and drops the state row", async () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-skills"] }));
		const result = await importBundle(env, "tester/routing");

		await removeBundle(env, "tester/routing");

		expect(existsSync(result.path)).toBe(false);
		expect(existsSync(join(env.paths.bundlesDir, "tester"))).toBe(false);
		expect(readSettings().packages).toEqual(["npm:pi-skills"]);
		expect(await readHubState(env.paths.statePath)).toEqual({});
		expect(hub.events.at(-1)?.action).toBe("removed");
	});

	it("rejects bundle files that try to escape the store", async () => {
		hub.filesByVersion.set(1, [{ path: "../../escape.md", content: "nope" }]);
		await expect(importBundle(env, "tester/routing")).rejects.toThrow(/escapes the bundle store/);
	});

	it("writes binary assets byte-for-byte instead of mangling them as UTF-8", async () => {
		// A PNG header plus bytes that are not valid UTF-8: decoding this as text
		// replaces them with U+FFFD and inflates the file, which silently corrupted
		// every logo/font/template shipped in a bundle.
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.from([0xff, 0xfe, 0xc0, 0x80, 0x81, 0xed, 0xa0, 0x80]),
		]);
		hub.filesByVersion.set(1, [
			{ path: "skills/routing/SKILL.md", content: "# Routing\nv1 skill\n" },
			{ path: "skills/routing/assets/logo.png", content: png },
		]);

		const result = await importBundle(env, "tester/routing");

		const written = readFileSync(join(result.path, "skills/routing/assets/logo.png"));
		expect(written.equals(png)).toBe(true);
	});

	it("sync repairs link drift and reports newer versions", async () => {
		const result = await importBundle(env, "tester/routing");
		// Simulate the user hand-editing settings.json and dropping the entry.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "v2" }]);

		const rows = await syncBundles(env);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ key: "tester/routing", version: 1, latestVersion: 2, updateAvailable: true });
		expect(rows[0].repaired).toEqual(["relinked"]);
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);
	});
});

describe("hub publish", () => {
	it("uploads the selected resources as base64 files", async () => {
		mkdirSync(join(agentDir, "skills", "review"), { recursive: true });
		writeFileSync(join(agentDir, "skills", "review", "SKILL.md"), "# Review\nBe strict.\n");

		const result = await publishBundle(env, {
			slug: "mine",
			title: "My review skill",
			description: "Review checklist",
			candidates: [
				{
					id: "skills/review",
					label: "skills/review",
					kind: "skills",
					target: "skills/review",
					sourcePath: join(agentDir, "skills", "review"),
				},
			],
		});

		expect(result).toMatchObject({ key: "tester/mine", version: 1, fileCount: 1, kind: "skill" });
		const files = hub.published.at(-1)?.body.files as Array<{ path: string; content_b64: string }>;
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("skills/review/SKILL.md");
		expect(Buffer.from(files[0].content_b64, "base64").toString("utf-8")).toContain("Be strict.");
	});

	it("uploads binary assets byte-for-byte and sizes them by raw bytes", async () => {
		// Bytes that are not valid UTF-8 round-trip unchanged, and the per-file cap
		// is measured on them directly: a UTF-8 decode both corrupts the payload and
		// inflates it past the limit.
		const png = Buffer.concat([
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			Buffer.alloc(64, 0xff),
		]);
		mkdirSync(join(agentDir, "skills", "branded", "assets"), { recursive: true });
		writeFileSync(join(agentDir, "skills", "branded", "SKILL.md"), "# Branded\nUse the logo.\n");
		writeFileSync(join(agentDir, "skills", "branded", "assets", "logo.png"), png);

		await publishBundle(env, {
			slug: "branded",
			title: "Branded skill",
			description: "Ships a logo",
			candidates: [
				{
					id: "skills/branded",
					label: "skills/branded",
					kind: "skills",
					target: "skills/branded",
					sourcePath: join(agentDir, "skills", "branded"),
				},
			],
		});

		const files = hub.published.at(-1)?.body.files as Array<{ path: string; content_b64: string }>;
		const uploaded = files.find((file) => file.path === "skills/branded/assets/logo.png");
		expect(uploaded).toBeDefined();
		expect(Buffer.from(uploaded?.content_b64 ?? "", "base64").equals(png)).toBe(true);
	});

	it("refuses to upload credential-shaped content", async () => {
		mkdirSync(join(agentDir, "skills", "leaky"), { recursive: true });
		writeFileSync(join(agentDir, "skills", "leaky", "SKILL.md"), "export KEY=sk-ant-api03-live\n");

		await expect(
			publishBundle(env, {
				slug: "leaky",
				title: "Leaky",
				description: "nope",
				candidates: [
					{
						id: "skills/leaky",
						label: "skills/leaky",
						kind: "skills",
						target: "skills/leaky",
						sourcePath: join(agentDir, "skills", "leaky"),
					},
				],
			}),
		).rejects.toThrow(/Refusing to publish/);
		expect(hub.published).toHaveLength(0);
	});
});

describe("hub publish: models bundle", () => {
	function modelsCandidate() {
		return {
			id: "models/models.json",
			label: "models/models.json",
			kind: "models" as const,
			target: "models/models.json",
			sourcePath: join(agentDir, "models.json"),
		};
	}

	it("publishes a models.json whose credentials are $ENV/!command references", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					gateway: {
						baseUrl: "http://127.0.0.1:8787",
						apiKey: "$GATEWAY_API_KEY",
						headers: { Authorization: "Bearer $GATEWAY_API_KEY" },
					},
				},
			}),
		);

		const result = await publishBundle(env, {
			slug: "gateway-models",
			title: "Gateway models",
			description: "Shared model catalog; bring your own key",
			candidates: [modelsCandidate()],
		});

		expect(result).toMatchObject({ key: "tester/gateway-models", version: 1, fileCount: 1, kind: "models" });
		const files = hub.published.at(-1)?.body.files as Array<{ path: string; content_b64: string }>;
		expect(files[0].path).toBe("models/models.json");
		expect(Buffer.from(files[0].content_b64, "base64").toString("utf-8")).toContain("$GATEWAY_API_KEY");
	});

	it("refuses a models.json with a literal apiKey, naming the JSON field", async () => {
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({ providers: { gateway: { apiKey: "literal-gateway-secret" } } }),
		);

		await expect(
			publishBundle(env, {
				slug: "leaky-models",
				title: "Leaky models",
				description: "nope",
				candidates: [modelsCandidate()],
			}),
		).rejects.toThrow(/providers\.gateway\.apiKey/);
		expect(hub.published).toHaveLength(0);
	});

	it("imports a models bundle and marks its kind", async () => {
		hub.filesByVersion.set(1, [
			{
				path: "models/models.json",
				content: JSON.stringify({ providers: { gateway: { baseUrl: "https://g", apiKey: "$K" } } }),
			},
		]);

		const result = await importBundle(env, "tester/routing");
		expect(result.kinds).toEqual(["models"]);
		expect(readFileSync(join(result.path, "models/models.json"), "utf-8")).toContain("$K");
	});
});

/**
 * A `packages` entry points at the bundle root, and pi resolves it by looking for
 * `skills/`, `extensions/`, `prompts/`, or `themes/` beneath it. A root with none
 * of those is resolved as an extension instead, and the extension loader then
 * fails to import a directory. So a bundle carrying only hub-only kinds must
 * never be linked — it is enabled through `hub/state.json` alone.
 */
describe("only bundles with loadable resources are linked", () => {
	const MODELS_FILE = {
		path: "models/models.json",
		content: JSON.stringify({ providers: { gateway: { baseUrl: "https://g", apiKey: "$K" } } }),
	};
	const INSTRUCTIONS_FILE = { path: "instructions/AGENTS.md", content: "# Rules\nBe careful.\n" };
	const SETTINGS_FILE = { path: "settings/settings.json", content: JSON.stringify({ theme: "gateway" }) };
	const SKILL_FILE = { path: "skills/routing/SKILL.md", content: "# Routing\nv1 skill\n" };

	it.each([
		["models-only", [MODELS_FILE], ["models"]],
		["instructions-only", [INSTRUCTIONS_FILE], ["instructions"]],
		["settings-only", [SETTINGS_FILE], ["settings"]],
		[
			"every hub-only kind at once",
			[MODELS_FILE, INSTRUCTIONS_FILE, SETTINGS_FILE],
			["instructions", "models", "settings"],
		],
	])("a %s bundle imports enabled but unlinked", async (_label, files, kinds) => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-skills"] }));
		hub.filesByVersion.set(1, files);

		const result = await importBundle(env, "tester/routing");

		expect(result.kinds).toEqual(kinds);
		// Enabled is the state that matters: the dedicated loaders read it from hub state.
		expect(result.enabled).toBe(true);
		expect(result.linked).toBe(false);
		// The unrelated entry the user already had is untouched.
		expect(readSettings().packages).toEqual(["npm:pi-skills"]);
		expect((await readHubState(env.paths.statePath))["tester/routing"].enabled).toBe(true);
	});

	it.each([
		["skills", [SKILL_FILE]],
		["extensions", [{ path: "extensions/thing/index.ts", content: "export default () => {};\n" }]],
		["prompts", [{ path: "prompts/review.md", content: "Review it.\n" }]],
		["themes", [{ path: "themes/demo-org.json", content: "{}\n" }]],
	])("a %s bundle still gets exactly one packages entry", async (_kind, files) => {
		hub.filesByVersion.set(1, files);

		const result = await importBundle(env, "tester/routing");

		expect(result.linked).toBe(true);
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);
	});

	it("a mixed bundle links on the strength of its one loadable kind", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE, INSTRUCTIONS_FILE, SETTINGS_FILE, SKILL_FILE]);

		const result = await importBundle(env, "tester/routing");

		expect(result.kinds).toEqual(["instructions", "models", "settings", "skills"]);
		expect(result.linked).toBe(true);
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);
	});

	it("enable and disable of a hub-only bundle never adds a packages entry", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE]);
		await importBundle(env, "tester/routing");

		const disabled = await setBundleEnabled(env, "tester/routing", false);
		expect(disabled).toMatchObject({ linked: false, linkable: false });
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);

		const enabled = await setBundleEnabled(env, "tester/routing", true);
		// Enabled in state — which is what the model runtime reads — but still unlinked.
		expect(enabled).toMatchObject({ linked: false, linkable: false });
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
		expect((await readHubState(env.paths.statePath))["tester/routing"].enabled).toBe(true);
	});

	it("an update that drops the last loadable kind removes the stale entry", async () => {
		const first = await importBundle(env, "tester/routing");
		expect(readLinkedPackagePaths(env.storage)).toEqual([first.path]);

		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [MODELS_FILE]);
		const second = await importBundle(env, "tester/routing");

		expect(second.linked).toBe(false);
		// Neither the superseded nor the new version dir may be left in `packages`.
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
		expect(existsSync(first.path)).toBe(false);
	});

	it("an update that gains a loadable kind links the new version", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE]);
		const first = await importBundle(env, "tester/routing");
		expect(first.linked).toBe(false);

		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [MODELS_FILE, SKILL_FILE]);
		const second = await importBundle(env, "tester/routing");

		expect(second.linked).toBe(true);
		expect(readLinkedPackagePaths(env.storage)).toEqual([second.path]);
	});

	it("re-importing a hub-only bundle linked by an older client drops that entry", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE]);
		const first = await importBundle(env, "tester/routing");
		// Simulate the pre-fix client, which linked every bundle root unconditionally.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-skills", first.path] }));

		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [MODELS_FILE]);
		const second = await importBundle(env, "tester/routing");

		expect(second.linked).toBe(false);
		expect(readSettings().packages).toEqual(["npm:pi-skills"]);
	});

	/**
	 * The version dir is derived from owner/slug/version, so a stale entry for the
	 * *same* version can outlive its state row — remove the bundle by hand-editing
	 * `hub/state.json`, or import at a version that was linked before, and there is
	 * no `previous` row to clean up from. A fresh import must still not leave one.
	 */
	it("a fresh import clears a stale entry for its own version dir", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE]);
		const first = await importBundle(env, "tester/routing");
		// The entry an older client left, with the state row gone: nothing links the
		// two, so only unlinking this version dir unconditionally can catch it.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-skills", first.path] }));
		await writeHubState(env.paths.statePath, {});

		const reimported = await importBundle(env, "tester/routing");

		expect(reimported.path).toBe(first.path);
		expect(reimported.linked).toBe(false);
		expect(readSettings().packages).toEqual(["npm:pi-skills"]);
	});

	it("sync and repair unlink a hub-only bundle an older client linked", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE]);
		const result = await importBundle(env, "tester/routing");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-skills", result.path] }));

		// The shared reconciler, which is also what the startup migration runs.
		const state = await readHubState(env.paths.statePath);
		expect(repairHubPackageLinks(env.storage, state)).toEqual([
			{ key: "tester/routing", path: result.path, action: "unlinked", stale: true },
		]);
		expect(readSettings().packages).toEqual(["npm:pi-skills"]);
		// Idempotent: a second pass finds nothing left to fix.
		expect(repairHubPackageLinks(env.storage, state)).toEqual([]);

		// /hub sync reports the same repair through the hub-aware path.
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [result.path] }));
		const rows = await syncBundles(env);
		expect(rows[0].repaired).toEqual(["unlinked (no loadable resources)"]);
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
	});

	it("only /hub sync relinks a loadable bundle whose entry was hand-deleted", async () => {
		const result = await importBundle(env, "tester/routing");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
		const state = await readHubState(env.paths.statePath);

		// The startup migration is deliberately subtractive: a missing link cannot
		// break startup, so it does not second-guess a hand-deleted entry.
		expect(repairHubPackageLinks(env.storage, state)).toEqual([]);
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);

		expect(repairHubPackageLinks(env.storage, state, { relink: true })).toEqual([
			{ key: "tester/routing", path: result.path, action: "linked", stale: false },
		]);
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);
	});

	it("repair leaves a missing store dir alone rather than linking a dead path", async () => {
		const result = await importBundle(env, "tester/routing");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));
		rmSync(result.path, { recursive: true, force: true });

		const state = await readHubState(env.paths.statePath);
		expect(repairHubPackageLinks(env.storage, state, { relink: true })).toEqual([]);
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
	});

	it("status calls an unlinked hub-only bundle correct, and a linked one drift", async () => {
		hub.filesByVersion.set(1, [MODELS_FILE]);
		const result = await importBundle(env, "tester/routing");

		const clean = await hubStatus(env);
		expect(clean.rows[0]).toMatchObject({ enabled: true, linked: false, linkable: false });
		expect(formatStatus(clean)).toContain("no packages link needed");
		// Enabled-but-unlinked is the correct state here, so it must not read as drift.
		expect(formatStatus(clean)).not.toContain("link drift");

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [result.path] }));
		expect(formatStatus(await hubStatus(env))).toContain("link drift: still linked");
	});

	it("enable, status, and sync agree about a legacy row that records no kinds", async () => {
		const result = await importBundle(env, "tester/routing");
		// A row written by a client that predates `kinds`: the array says nothing,
		// while the bundle on disk genuinely ships skills.
		const file = JSON.parse(readFileSync(env.paths.statePath, "utf-8"));
		file.bundles["tester/routing"].kinds = [];
		writeFileSync(env.paths.statePath, JSON.stringify(file, null, 2));

		// Enable must not read the empty array as "ships nothing" and drop the link.
		const toggled = await setBundleEnabled(env, "tester/routing", true);
		expect(toggled).toMatchObject({ linked: true, linkable: true });
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);

		// Status agrees, so it cannot advertise drift that sync then declines to fix.
		const status = await hubStatus(env);
		expect(status.rows[0]).toMatchObject({ linked: true, linkable: true, expectedLink: true });
		expect(formatStatus(status)).not.toContain("link drift");
		expect(formatStatus(status)).not.toContain("no packages link needed");

		const state = await readHubState(env.paths.statePath);
		expect(repairHubPackageLinks(env.storage, state, { relink: true })).toEqual([]);
		expect(readLinkedPackagePaths(env.storage)).toEqual([result.path]);

		// And disable still clears it, so the safety net is not a one-way door.
		await setBundleEnabled(env, "tester/routing", false);
		expect(readLinkedPackagePaths(env.storage)).toEqual([]);
	});

	it("status reports a linkable bundle that lost its entry as drift", async () => {
		await importBundle(env, "tester/routing");
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [] }));

		const status = await hubStatus(env);
		expect(status.rows[0]).toMatchObject({ enabled: true, linked: false, linkable: true });
		expect(formatStatus(status)).toContain("link drift: not linked");
	});

	/**
	 * The end of the causal chain, asserted against pi's own package manager and
	 * extension loader rather than restated: this is the failure the linking rule
	 * exists to prevent.
	 */
	describe("against pi's package loader", () => {
		async function resolvedExtensionPaths(): Promise<string[]> {
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
			return (await manager.resolve(async () => "skip")).extensions.map((resource) => resource.path);
		}

		it("a linked models-only root is resolved as an extension and fails to load", async () => {
			hub.filesByVersion.set(1, [MODELS_FILE]);
			const result = await importBundle(env, "tester/routing");
			// The pre-fix state: the bundle root itself sits in `packages`.
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [result.path] }));

			// With no skills/extensions/prompts/themes under it, the resolver falls
			// back to treating the root as an extension file.
			expect(await resolvedExtensionPaths()).toEqual([result.path]);
			const loaded = await loadExtensions([result.path], projectDir);
			expect(loaded.extensions).toEqual([]);
			expect(loaded.errors).toHaveLength(1);
			expect(loaded.errors[0].path).toBe(result.path);
		});

		it("the same bundle imported by this client is never handed to the loader", async () => {
			hub.filesByVersion.set(1, [MODELS_FILE]);
			const result = await importBundle(env, "tester/routing");

			expect(result.linked).toBe(false);
			expect(await resolvedExtensionPaths()).toEqual([]);
			// The models file is still on disk and still enabled in hub state — the
			// model runtime, not the package loader, is what reads it.
			expect(await enabledModelBundlePaths(agentDir)).toEqual([join(result.path, "models", "models.json")]);
		});

		it("a skills bundle is still resolved from its linked root", async () => {
			const result = await importBundle(env, "tester/routing");

			expect(result.linked).toBe(true);
			// Resolved as a package: its skill, and no bogus extension entry.
			expect(await resolvedExtensionPaths()).toEqual([]);
			const settingsManager = SettingsManager.create(projectDir, agentDir);
			const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
			const resolved = await manager.resolve(async () => "skip");
			expect(resolved.skills.map((resource) => resource.path)).toContain(
				join(result.path, "skills", "routing", "SKILL.md"),
			);
		});
	});
});

describe("install versus import", () => {
	it("install follows the latest version", async () => {
		const result = await installBundle(env, "tester/routing");

		expect(result).toMatchObject({ version: 1, track: "latest" });
		expect((await readHubState(env.paths.statePath))["tester/routing"].track).toBe("latest");
	});

	it("install refuses a pinned ref and points at import", async () => {
		await expect(installBundle(env, "tester/routing@1")).rejects.toThrow(
			/always tracks the latest version.*\/hub import tester\/routing@1/s,
		);
		expect(await readHubState(env.paths.statePath)).toEqual({});
	});

	it("import pins only when the ref carries a version", async () => {
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "v2" }]);

		expect((await importBundle(env, "tester/routing")).track).toBe("latest");
		expect((await importBundle(env, "tester/routing@1")).track).toBe("pinned");
		expect((await readHubState(env.paths.statePath))["tester/routing"].track).toBe("pinned");
		expect((await importBundle(env, "tester/routing@latest")).track).toBe("latest");
	});
});

describe("hub update", () => {
	it("checks once, re-imports, and repoints the single packages entry", async () => {
		const first = await importBundle(env, "tester/routing");
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "# Routing\nv2 skill\n" }]);

		const result = await updateBundles(env);

		expect(hub.updateChecks).toEqual([[{ ref: "tester/routing", version: 1 }]]);
		expect(result.applied).toEqual([{ key: "tester/routing", fromVersion: 1, toVersion: 2, ok: true }]);

		const state = await readHubState(env.paths.statePath);
		expect(state["tester/routing"]).toMatchObject({ version: 2, track: "latest", enabled: true });
		expect(readLinkedPackagePaths(env.storage)).toEqual([state["tester/routing"].path]);
		expect(existsSync(first.path)).toBe(false);
		expect(readFileSync(join(state["tester/routing"].path, "skills/routing/SKILL.md"), "utf-8")).toContain(
			"v2 skill",
		);
		expect(formatUpdateResult(result)).toContain("tester/routing v1 → v2");
		// A successful check arms the startup throttle.
		expect((await readHubStateFile(env.paths.statePath)).lastUpdateCheck).toBeDefined();
	});

	it("reports an up-to-date tracked bundle without touching it", async () => {
		const imported = await importBundle(env, "tester/routing");

		const result = await updateBundles(env);

		expect(result.available).toEqual([]);
		expect(result.applied).toEqual([]);
		expect(existsSync(imported.path)).toBe(true);
		expect(formatUpdateResult(result)).toContain("tester/routing@v1 — up to date");
	});

	it("never asks about pinned bundles and leaves them where they are", async () => {
		await importBundle(env, "tester/routing@1");
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "v2" }]);

		const result = await updateBundles(env);

		expect(hub.updateChecks).toEqual([]);
		expect(result.tracked).toEqual([]);
		expect(result.pinned).toEqual(["tester/routing"]);
		expect((await readHubState(env.paths.statePath))["tester/routing"].version).toBe(1);
		expect(formatUpdateResult(result)).toContain("Pinned: tester/routing");
	});

	it("warns about a ref the hub dropped and never removes it", async () => {
		await importBundle(env, "tester/routing");
		const state = await readHubState(env.paths.statePath);
		await writeHubState(env.paths.statePath, {
			...state,
			"tester/gone": {
				version: 2,
				enabled: true,
				path: join(env.paths.bundlesDir, "tester", "gone", "v2"),
				kinds: ["skills"],
				track: "latest",
			},
		});
		hub.missingRefs.add("tester/gone");

		const result = await updateBundles(env);

		expect(result.missing).toEqual(["tester/gone"]);
		expect((await readHubState(env.paths.statePath))["tester/gone"]).toBeDefined();
		expect(readLinkedPackagePaths(env.storage)).not.toContain(join(env.paths.bundlesDir, "tester", "gone", "v2"));
		expect(formatUpdateResult(result)).toContain("tester/gone — no longer on the hub");
	});
});

describe("startup update check", () => {
	const hoursAgo = (hours: number): string => new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();

	async function startupAfterNewVersion(options: {
		mode?: string;
		ownerIsOrg?: boolean;
		orgInCheckResponse?: boolean;
	}): Promise<StartupCheckOutcome> {
		if (options.mode) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hubAutoUpdate: options.mode }));
		}
		hub.ownerIsOrg = options.ownerIsOrg;
		hub.orgInCheckResponse = options.orgInCheckResponse ?? true;
		await importBundle(env, "tester/routing");
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "# Routing\nv2 skill\n" }]);
		return runStartupUpdateCheck(env);
	}

	it("checks at most once every six hours", async () => {
		await importBundle(env, "tester/routing");
		hub.latestVersion = 2;
		hub.filesByVersion.set(2, [{ path: "skills/routing/SKILL.md", content: "v2" }]);

		await recordUpdateCheck(env.paths.statePath, hoursAgo(1));
		expect(await runStartupUpdateCheck(env)).toMatchObject({ ran: false, skipped: "throttled" });
		expect(hub.updateChecks).toEqual([]);

		await recordUpdateCheck(env.paths.statePath, hoursAgo(7));
		expect(await runStartupUpdateCheck(env)).toMatchObject({ ran: true });
		expect(hub.updateChecks).toHaveLength(1);
	});

	it("skips silently with nothing tracked, signed out, or off the network", async () => {
		await importBundle(env, "tester/routing@1");
		expect(await runStartupUpdateCheck(env)).toMatchObject({ ran: false, skipped: "no-tracked-bundles" });

		await importBundle(env, "tester/routing");
		await writeHubConfig(join(agentDir, "hub.json"), { url: hub.url });
		expect(await runStartupUpdateCheck(env)).toMatchObject({ ran: false, skipped: "signed-out" });

		await writeHubConfig(join(agentDir, "hub.json"), { url: "http://127.0.0.1:1", token: TOKEN });
		expect(await runStartupUpdateCheck(env)).toMatchObject({ ran: false, skipped: "unreachable" });
		expect(hub.updateChecks).toEqual([]);
	});

	it("auto-updates an org bundle under the default org mode", async () => {
		const outcome = await startupAfterNewVersion({ ownerIsOrg: true });

		expect(outcome).toMatchObject({ ran: true, mode: "org", deferred: [] });
		expect(outcome.applied).toEqual([{ key: "tester/routing", fromVersion: 1, toVersion: 2, ok: true }]);
		expect((await readHubState(env.paths.statePath))["tester/routing"]).toMatchObject({
			version: 2,
			track: "latest",
		});
		expect(formatStartupNotice(outcome)).toContain("take effect in your next session");
	});

	it("falls back to bundle metadata when the check response omits ownership", async () => {
		const outcome = await startupAfterNewVersion({ ownerIsOrg: true, orgInCheckResponse: false });

		expect(outcome.applied).toEqual([{ key: "tester/routing", fromVersion: 1, toVersion: 2, ok: true }]);
	});

	it("only notifies for a personal bundle, or when ownership is unknown", async () => {
		const personal = await startupAfterNewVersion({ ownerIsOrg: false });
		expect(personal.applied).toEqual([]);
		expect(personal.deferred.map((row) => row.key)).toEqual(["tester/routing"]);
		expect((await readHubState(env.paths.statePath))["tester/routing"].version).toBe(1);
		expect(formatStartupNotice(personal)).toContain("/hub update");

		// A hub that reports no ownership at all is treated as personal.
		hub.ownerIsOrg = undefined;
		await recordUpdateCheck(env.paths.statePath, hoursAgo(7));
		expect((await runStartupUpdateCheck(env)).applied).toEqual([]);
	});

	it("auto-updates a personal bundle under all, and nothing under off", async () => {
		const all = await startupAfterNewVersion({ mode: "all", ownerIsOrg: false });
		expect(all).toMatchObject({ mode: "all", deferred: [] });
		expect(all.applied).toEqual([{ key: "tester/routing", fromVersion: 1, toVersion: 2, ok: true }]);
	});

	it("never auto-updates when the setting is off", async () => {
		const off = await startupAfterNewVersion({ mode: "off", ownerIsOrg: true });

		expect(off).toMatchObject({ mode: "off", applied: [] });
		expect(off.deferred.map((row) => row.key)).toEqual(["tester/routing"]);
		expect((await readHubState(env.paths.statePath))["tester/routing"].version).toBe(1);
	});
});

describe("publishing on behalf of an org", () => {
	function candidate(): { id: string; label: string; kind: "skills"; target: string; sourcePath: string } {
		mkdirSync(join(agentDir, "skills", "review"), { recursive: true });
		writeFileSync(join(agentDir, "skills", "review", "SKILL.md"), "# Review\nBe strict.\n");
		return {
			id: "skills/review",
			label: "skills/review",
			kind: "skills",
			target: "skills/review",
			sourcePath: join(agentDir, "skills", "review"),
		};
	}

	it("passes the org handle to bundle create and publishes under it", async () => {
		const result = await publishBundle(env, {
			slug: "mine",
			title: "Shared review",
			description: "Org review checklist",
			candidates: [candidate()],
			owner: "example",
		});

		expect(hub.created.at(-1)).toMatchObject({ slug: "mine", owner: "example" });
		expect(hub.published.at(-1)?.path).toBe("example/mine");
		expect(result).toMatchObject({ key: "example/mine", publishedToOrg: true });
	});

	it("omits the owner when publishing to your own profile", async () => {
		const result = await publishBundle(env, {
			slug: "mine",
			title: "My review skill",
			description: "Review checklist",
			candidates: [candidate()],
		});

		expect(hub.created.at(-1)).not.toHaveProperty("owner");
		expect(hub.published.at(-1)?.path).toBe("tester/mine");
		expect(result).toMatchObject({ key: "tester/mine", publishedToOrg: false });
	});
});
