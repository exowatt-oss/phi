// Exowatt fork test: the built-in `hub` extension is the client side of the
// phi hub contract (example-org/phi-hub, docs/contract.md). These cover the
// pure logic the no-muddling invariant rests on — path safety, single-entry
// settings linking, state transitions, never-auto-applied settings fragments,
// the secret guard, and residue-free instruction injection.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { FileSettingsStorage } from "../src/core/settings-manager.ts";
import { HubClient, HubError } from "../src/extensions/hub/client.ts";
import { DEFAULT_HUB_URL, isHubToken, normalizeHubUrl, resolveHubUrl } from "../src/extensions/hub/hub-config.ts";
import hubExtension from "../src/extensions/hub/index.ts";
import { InstructionsProvider, renderInstructionsBlock } from "../src/extensions/hub/instructions.ts";
import { enabledModelBundlePaths } from "../src/extensions/hub/model-bundles.ts";
import { findModelsConfigViolations } from "../src/extensions/hub/models-guard.ts";
import { bundleVersionDir, createHubPaths } from "../src/extensions/hub/paths.ts";
import { bundleKey, formatBundleRef, isSafeRefSegment, parseBundleRef } from "../src/extensions/hub/refs.ts";
import { assertNoSecrets, findSecretViolation, isForbiddenBundleFileName } from "../src/extensions/hub/secrets.ts";
import {
	DEFAULT_HUB_AUTO_UPDATE,
	deepMergeJson,
	type HubAutoUpdateMode,
	linkPackage,
	readHubAutoUpdateMode,
	readLinkedPackagePaths,
	relinkPackage,
	unlinkPackage,
} from "../src/extensions/hub/settings-file.ts";
import {
	applyFragment,
	diffFragment,
	findLatestBackup,
	readBundleFragment,
	revertLatestBackup,
} from "../src/extensions/hub/settings-fragment.ts";
import {
	type HubBundleState,
	type HubState,
	LEGACY_TRACK,
	readHubState,
	readHubStateFile,
	recordUpdateCheck,
	shouldCheckForUpdates,
	UPDATE_CHECK_INTERVAL_MS,
	withEnabled,
	withImported,
	withRemoved,
	writeHubState,
	writeHubStateFile,
} from "../src/extensions/hub/state.ts";
import {
	BUNDLE_KINDS,
	detectBundleKinds,
	HUB_ONLY_BUNDLE_KINDS,
	hasLoadableBundleKinds,
	LOADABLE_BUNDLE_KINDS,
	validateBundleFilePath,
} from "../src/extensions/hub/store.ts";
import {
	formatStartupStatus,
	type StartupCheckOutcome,
	shouldAutoUpdate,
	trackedBundles,
} from "../src/extensions/hub/updates.ts";

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "phi-hub-test-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function storage(): FileSettingsStorage {
	return new FileSettingsStorage(projectDir, agentDir);
}

function readSettings(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
}

describe("hub extension registration", () => {
	it("registers the /hub command, the agent tools, and the instruction hook", async () => {
		const extension = await loadExtensionFromFactory(
			hubExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:hub>",
		);

		expect(extension.commands.get("hub")?.description).toBe(
			"Share and install phi configuration through the phi hub",
		);
		expect([...extension.tools.keys()].sort()).toEqual([
			"hub_import",
			"hub_install",
			"hub_publish",
			"hub_search",
			"hub_status",
			"hub_toggle",
			"hub_update",
		]);
		expect(extension.handlers.has("before_agent_start")).toBe(true);
		expect(extension.handlers.has("session_start")).toBe(true);
	});
});

describe("safe models bundle guard", () => {
	it("lets a models.json through only at the canonical models/ path", () => {
		// A bare or misplaced models.json still holds credentials by convention.
		expect(isForbiddenBundleFileName("models.json")).toBe(true);
		expect(isForbiddenBundleFileName("extensions/models.json")).toBe(true);
		expect(isForbiddenBundleFileName("settings/models.json")).toBe(true);
		// The one deliberate exception: the models bundle kind.
		expect(isForbiddenBundleFileName("models/models.json")).toBe(false);
		// The other credential files stay forbidden regardless.
		for (const name of ["auth.json", "hub.json", "mcp.json", "models/auth.json", "credentials", ".env"]) {
			expect(isForbiddenBundleFileName(name), name).toBe(true);
		}
	});

	it("rejects literal apiKey and literal auth headers with a JSON field path", () => {
		const config = {
			providers: {
				gateway: {
					apiKey: "live-secret-key-value",
					headers: { Authorization: "Bearer live-token", "X-Api-Key": "literal" },
					models: [{ id: "m", headers: { "x-observatory-token": "literal-token" } }],
					modelOverrides: { m: { headers: { "api-key": "literal" } } },
				},
			},
		};
		const violations = findModelsConfigViolations(config);
		expect(violations).toContain(
			"providers.gateway.apiKey is a literal apiKey; use an $ENV reference or !command instead of a baked-in secret",
		);
		expect(violations.some((v) => v.startsWith("providers.gateway.headers.Authorization"))).toBe(true);
		expect(violations.some((v) => v.startsWith("providers.gateway.headers.X-Api-Key"))).toBe(true);
		expect(violations.some((v) => v.startsWith("providers.gateway.models[0].headers.x-observatory-token"))).toBe(
			true,
		);
		expect(violations.some((v) => v.startsWith("providers.gateway.modelOverrides.m.headers.api-key"))).toBe(true);
	});

	it("permits env-var and command indirection for credential fields", () => {
		const config = {
			providers: {
				a: { apiKey: "$OPENAI_API_KEY" },
				// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference is exactly what is under test
				b: { apiKey: "${GATEWAY_KEY}", headers: { Authorization: "Bearer ${GATEWAY_KEY}" } },
				c: { apiKey: "!op read op://vault/key" },
				// A non-credential header with a literal value is fine.
				d: { baseUrl: "https://gw.example.com", headers: { "X-Trace": "on", Accept: "application/json" } },
			},
		};
		expect(findModelsConfigViolations(config)).toEqual([]);
	});

	it("ignores non-provider shapes without throwing", () => {
		expect(findModelsConfigViolations(null)).toEqual([]);
		expect(findModelsConfigViolations({})).toEqual([]);
		expect(findModelsConfigViolations({ providers: "nope" })).toEqual([]);
		expect(findModelsConfigViolations({ providers: { a: 5 } })).toEqual([]);
	});

	it("assertNoSecrets refuses a models bundle with a baked-in key and accepts an env-referenced one", () => {
		expect(() =>
			assertNoSecrets([
				{
					path: "models/models.json",
					content: JSON.stringify({ providers: { g: { apiKey: "literal-key-here" } } }),
				},
			]),
		).toThrow(/baked-in credentials[\s\S]*providers\.g\.apiKey/);
		expect(() =>
			assertNoSecrets([
				{ path: "models/models.json", content: JSON.stringify({ providers: { g: { apiKey: "$G_KEY" } } }) },
			]),
		).not.toThrow();
	});

	it("still applies the generic credential scan to the models file", () => {
		// A known credential pattern is caught by the generic scan even inside the
		// models file, before the schema-aware check runs.
		expect(
			findSecretViolation("models/models.json", JSON.stringify({ providers: { g: { apiKey: "sk-ant-api03-x" } } })),
		).toBeDefined();
	});
});

describe("enabled model bundle resolution", () => {
	function writeModelsBundle(key: string, version: number, body: unknown): string {
		const [owner, slug] = key.split("/");
		const paths = createHubPaths(agentDir);
		const versionDir = bundleVersionDir(paths, owner, slug, version);
		mkdirSync(join(versionDir, "models"), { recursive: true });
		writeFileSync(join(versionDir, "models", "models.json"), JSON.stringify(body));
		return versionDir;
	}

	it("lists only enabled models bundles, sorted by key, skipping missing files", async () => {
		const paths = createHubPaths(agentDir);
		const bDir = writeModelsBundle("tester/b-models", 1, { providers: { b: {} } });
		const aDir = writeModelsBundle("tester/a-models", 2, { providers: { a: {} } });
		await writeHubState(paths.statePath, {
			"tester/b-models": { version: 1, enabled: true, path: bDir, kinds: ["models"], track: "latest" },
			"tester/a-models": { version: 2, enabled: true, path: aDir, kinds: ["models"], track: "latest" },
			// Disabled: excluded.
			"tester/off": { version: 1, enabled: false, path: aDir, kinds: ["models"], track: "latest" },
			// Enabled but not a models bundle: excluded.
			"tester/skill": { version: 1, enabled: true, path: aDir, kinds: ["skills"], track: "latest" },
			// Enabled models bundle whose file is missing on disk: skipped, not an error.
			"tester/gone": {
				version: 1,
				enabled: true,
				path: join(paths.bundlesDir, "tester", "gone", "v1"),
				kinds: ["models"],
				track: "latest",
			},
		});

		// Sorted by key: a-models before b-models.
		expect(await enabledModelBundlePaths(agentDir)).toEqual([
			join(aDir, "models", "models.json"),
			join(bDir, "models", "models.json"),
		]);
	});

	it("returns nothing when no state file exists", async () => {
		await expect(enabledModelBundlePaths(agentDir)).resolves.toEqual([]);
	});
});

describe("bundle refs", () => {
	it("parses plain, pinned, and latest references", () => {
		expect(parseBundleRef("tester/routing")).toEqual({ owner: "tester", slug: "routing" });
		expect(parseBundleRef(" tester/routing@3 ")).toEqual({ owner: "tester", slug: "routing", version: 3 });
		expect(parseBundleRef("tester/routing@v12")).toEqual({ owner: "tester", slug: "routing", version: 12 });
		expect(parseBundleRef("tester/routing@latest")).toEqual({ owner: "tester", slug: "routing" });
	});

	it("rejects references that could escape the store", () => {
		expect(() => parseBundleRef("../../etc/passwd")).toThrow(/Invalid bundle/);
		expect(() => parseBundleRef("tester/..")).toThrow(/Invalid bundle slug/);
		expect(() => parseBundleRef("tester")).toThrow(/Use owner\/slug/);
		expect(() => parseBundleRef("a/b/c")).toThrow(/Use owner\/slug/);
		expect(() => parseBundleRef("tester/routing@0")).toThrow(/Versions start at 1/);
		expect(() => parseBundleRef("tester/routing@next")).toThrow(/Invalid bundle version/);
		expect(isSafeRefSegment("..")).toBe(false);
		expect(isSafeRefSegment("with/slash")).toBe(false);
		expect(isSafeRefSegment("ok-name_1.2")).toBe(true);
	});

	it("formats refs back", () => {
		expect(bundleKey({ owner: "tester", slug: "routing" })).toBe("tester/routing");
		expect(formatBundleRef({ owner: "tester", slug: "routing", version: 4 })).toBe("tester/routing@v4");
		expect(formatBundleRef({ owner: "tester", slug: "routing" })).toBe("tester/routing");
	});
});

describe("bundle path safety", () => {
	it("accepts ordinary relative bundle paths", () => {
		expect(validateBundleFilePath("skills/review/SKILL.md")).toBe("skills/review/SKILL.md");
		expect(validateBundleFilePath("themes/demo-org.json")).toBe("themes/demo-org.json");
	});

	it("rejects traversal, absolute, git, and control-character paths", () => {
		for (const bad of [
			"../escape.md",
			"skills/../../escape.md",
			"/etc/passwd",
			"C:/Windows/system32",
			"skills\\review\\SKILL.md",
			".git/config",
			"skills/.git/config",
			"skills//double.md",
			"./relative.md",
			" leading-space.md",
		]) {
			expect(() => validateBundleFilePath(bad), bad).toThrow(/Invalid bundle path/);
		}
		expect(() => validateBundleFilePath("skills/null\u0000.md")).toThrow(/control characters/);
	});

	it("detects the bundle kinds present in a file list", () => {
		expect(detectBundleKinds(["skills/a/SKILL.md", "instructions/AGENTS.md", "README.md"])).toEqual([
			"instructions",
			"skills",
		]);
		expect(detectBundleKinds(["models/models.json"])).toEqual(["models"]);
		expect(detectBundleKinds(["README.md"])).toEqual([]);
	});
});

describe("loadable bundle kinds", () => {
	it("splits the kinds pi's package loader can resolve from the hub-only ones", () => {
		expect([...LOADABLE_BUNDLE_KINDS]).toEqual(["skills", "extensions", "prompts", "themes"]);
		expect([...HUB_ONLY_BUNDLE_KINDS]).toEqual(["instructions", "settings", "models"]);
		// Every known kind is on exactly one side of the line.
		expect([...BUNDLE_KINDS]).toEqual([...LOADABLE_BUNDLE_KINDS, ...HUB_ONLY_BUNDLE_KINDS]);
	});

	it("only a loadable kind earns a packages entry", () => {
		for (const kind of LOADABLE_BUNDLE_KINDS) {
			expect(hasLoadableBundleKinds([kind]), kind).toBe(true);
		}
		for (const kind of HUB_ONLY_BUNDLE_KINDS) {
			expect(hasLoadableBundleKinds([kind]), kind).toBe(false);
		}
		// The whole set of hub-only kinds together is still not loadable.
		expect(hasLoadableBundleKinds([...HUB_ONLY_BUNDLE_KINDS])).toBe(false);
		// A mixed bundle links on the strength of its one loadable kind.
		expect(hasLoadableBundleKinds(["models", "skills"])).toBe(true);
		expect(hasLoadableBundleKinds(["instructions", "themes"])).toBe(true);
		// A bundle whose files matched no known kind has nothing to load either.
		expect(hasLoadableBundleKinds([])).toBe(false);
		expect(hasLoadableBundleKinds(["docs"])).toBe(false);
	});
});

describe("secret guard", () => {
	it("refuses credential-shaped filenames", () => {
		expect(isForbiddenBundleFileName("extensions/models.json")).toBe(true);
		expect(isForbiddenBundleFileName("auth.json")).toBe(true);
		expect(isForbiddenBundleFileName("hub.json")).toBe(true);
		expect(isForbiddenBundleFileName("credentials.yaml")).toBe(true);
		expect(isForbiddenBundleFileName(".env.local")).toBe(true);
		expect(isForbiddenBundleFileName("mcp.json")).toBe(true);
		expect(isForbiddenBundleFileName("settings/mcp.json")).toBe(true);
		// The documented example ships a different basename, so it stays publishable.
		expect(isForbiddenBundleFileName("mcp.json.example")).toBe(false);
		expect(isForbiddenBundleFileName("skills/review/SKILL.md")).toBe(false);
	});

	it("refuses credential-shaped content", () => {
		const cases: Array<[string, string]> = [
			["a.md", "key = sk-ant-api03-abc"],
			["b.md", "OPENAI=sk-proj-abcdef"],
			["c.md", "AKIAIOSFODNN7EXAMPLE"],
			["d.md", "-----BEGIN OPENSSH " + "PRIVATE KEY-----"],
			["e.md", "xoxb-1234-5678"],
			["f.md", "ghp_0123456789"],
			["g.md", "phk_deadbeef"],
			["h.md", `GRAFANA_TOKEN=glsa_${"A".repeat(32)}`],
			["i.json", '{"headers": {"Authorization": "Bearer eyJhbGciOiJIUzI1NiJ9.abc"}}'],
			["j.json", '{"authorization": "bearer 0123456789abcdef"}'],
		];
		for (const [path, content] of cases) {
			expect(findSecretViolation(path, content), content).toBeDefined();
		}
		expect(findSecretViolation("skills/review/SKILL.md", "Review carefully.")).toBeUndefined();
	});

	it("lets $ENV bearer references through", () => {
		// A bundle documenting its MCP wiring must still be publishable; only a
		// literal token is a secret.
		const allowed = [
			'{"headers": {"Authorization": "Bearer $FEADS_TOKEN"}}',
			// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} placeholder is exactly what is under test
			'{"headers": {"Authorization": "Bearer ${FEADS_TOKEN}"}}',
			'{"headers": {"Authorization": "Bearer <token>"}}',
			'{"headers": {"Authorization": "Bearer {{ env.TOKEN }}"}}',
			"Send it as `Authorization: Bearer <token>` over HTTP.",
		];
		for (const content of allowed) {
			expect(findSecretViolation("mcp.json.example", content), content).toBeUndefined();
		}
	});
});

describe("settings linking", () => {
	it("adds exactly one entry and is idempotent", () => {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", packages: ["npm:pi-skills"] }));
		const store = storage();
		const bundlePath = join(agentDir, "hub", "bundles", "tester", "routing", "v1");

		expect(linkPackage(store, bundlePath)).toBe(true);
		expect(linkPackage(store, bundlePath)).toBe(false);
		expect(readLinkedPackagePaths(store)).toEqual(["npm:pi-skills", bundlePath]);
		expect(readSettings().theme).toBe("dark");
	});

	it("removes only its own entry and is idempotent", () => {
		const store = storage();
		const bundlePath = join(agentDir, "hub", "bundles", "tester", "routing", "v1");
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				theme: "dark",
				enabledModels: ["claude-*"],
				packages: ["npm:pi-skills", bundlePath, { source: "git:github.com/user/repo", skills: [] }],
			}),
		);

		expect(unlinkPackage(store, bundlePath)).toBe(true);
		expect(unlinkPackage(store, bundlePath)).toBe(false);

		const settings = readSettings();
		expect(settings.packages).toEqual(["npm:pi-skills", { source: "git:github.com/user/repo", skills: [] }]);
		expect(settings.theme).toBe("dark");
		expect(settings.enabledModels).toEqual(["claude-*"]);
	});

	it("creates the packages array when settings.json has none", () => {
		const store = storage();
		const bundlePath = join(agentDir, "hub", "bundles", "tester", "routing", "v1");
		expect(linkPackage(store, bundlePath)).toBe(true);
		expect(readSettings()).toEqual({ packages: [bundlePath] });
	});

	it("repoints an upgraded bundle without leaving both versions linked", () => {
		const store = storage();
		const v1 = join(agentDir, "hub", "bundles", "tester", "routing", "v1");
		const v2 = join(agentDir, "hub", "bundles", "tester", "routing", "v2");
		linkPackage(store, v1);
		relinkPackage(store, v1, v2);
		expect(readLinkedPackagePaths(store)).toEqual([v2]);
	});

	it("refuses to touch a settings file that is not valid JSON", () => {
		writeFileSync(join(agentDir, "settings.json"), "{ not json");
		expect(() => linkPackage(storage(), "/tmp/whatever")).toThrow(/not valid JSON/);
	});
});

describe("state transitions", () => {
	const row: HubBundleState = {
		version: 2,
		enabled: true,
		path: "/store/tester/routing/v2",
		kinds: ["skills"],
		track: "latest",
	};

	it("imports, toggles, and removes", () => {
		const imported = withImported({}, "tester/routing", row);
		expect(imported["tester/routing"].enabled).toBe(true);

		const disabled = withEnabled(imported, "tester/routing", false);
		expect(disabled["tester/routing"].enabled).toBe(false);
		// Disable keeps files and state; only the link goes away.
		expect(disabled["tester/routing"].path).toBe(row.path);
		expect(imported["tester/routing"].enabled).toBe(true);

		expect(withRemoved(disabled, "tester/routing")).toEqual({});
		expect(withRemoved({}, "missing")).toEqual({});
	});

	it("refuses to toggle a bundle that was never imported", () => {
		expect(() => withEnabled({}, "tester/routing", true)).toThrow(/is not imported/);
	});
});

describe("hub config", () => {
	it("resolves the url from the environment, then storage, then the default", () => {
		vi.stubEnv("PHI_HUB_URL", "");
		expect(resolveHubUrl()).toBe(DEFAULT_HUB_URL);
		expect(resolveHubUrl("https://hub.example.com/")).toBe("https://hub.example.com");
		vi.stubEnv("PHI_HUB_URL", "https://override.example.com/");
		expect(resolveHubUrl("https://hub.example.com")).toBe("https://override.example.com");
		vi.unstubAllEnvs();
	});

	it("recognizes hub tokens", () => {
		expect(isHubToken(`phk_${"a".repeat(40)}`)).toBe(true);
		expect(isHubToken("phk_short")).toBe(false);
		expect(isHubToken("sk-ant-whatever")).toBe(false);
		expect(normalizeHubUrl("https://x.test///")).toBe("https://x.test");
	});
});

describe("settings fragments", () => {
	it("deep merges without dropping sibling keys", () => {
		expect(
			deepMergeJson(
				{ compaction: { enabled: true, reserveTokens: 16384 }, theme: "dark" },
				{
					compaction: { reserveTokens: 8192 },
				},
			),
		).toEqual({ compaction: { enabled: true, reserveTokens: 8192 }, theme: "dark" });
	});

	it("diffs key by key, backs up, applies, and reverts", async () => {
		const paths = createHubPaths(agentDir);
		const store = storage();
		writeFileSync(
			paths.settingsPath,
			JSON.stringify({ theme: "dark", compaction: { enabled: true, reserveTokens: 16384 } }, null, 2),
		);
		writeFileSync(paths.keybindingsPath, JSON.stringify({ "app.tools.expand": "ctrl+t" }, null, 2));

		const versionDir = bundleVersionDir(paths, "tester", "routing", 1);
		mkdirSync(join(versionDir, "settings"), { recursive: true });
		writeFileSync(
			join(versionDir, "settings", "settings.json"),
			JSON.stringify({ theme: "gateway", compaction: { reserveTokens: 8192 } }),
		);
		writeFileSync(
			join(versionDir, "settings", "keybindings.json"),
			JSON.stringify({ "app.session.rename": "ctrl+r" }),
		);

		const fragment = await readBundleFragment(versionDir);
		const diff = await diffFragment(store, paths.keybindingsPath, fragment);
		expect(diff).toEqual([
			{ target: "settings.json", key: "theme", before: "dark", after: "gateway" },
			{ target: "settings.json", key: "compaction.reserveTokens", before: 16384, after: 8192 },
			{ target: "keybindings.json", key: "app.session.rename", before: undefined, after: "ctrl+r" },
		]);

		// Nothing is applied until the caller commits.
		expect(readSettings().theme).toBe("dark");

		const applied = await applyFragment(store, paths, fragment, diff);
		expect(applied.backups).toHaveLength(2);
		expect(readSettings()).toEqual({ theme: "gateway", compaction: { enabled: true, reserveTokens: 8192 } });
		expect(JSON.parse(readFileSync(paths.keybindingsPath, "utf-8"))).toEqual({
			"app.tools.expand": "ctrl+t",
			"app.session.rename": "ctrl+r",
		});

		expect((await findLatestBackup(paths.backupsDir))?.timestamp).toBe(applied.timestamp);

		const reverted = await revertLatestBackup(store, paths);
		expect(reverted?.restored).toEqual(["settings.json", "keybindings.json"]);
		expect(readSettings()).toEqual({ theme: "dark", compaction: { enabled: true, reserveTokens: 16384 } });
		expect(JSON.parse(readFileSync(paths.keybindingsPath, "utf-8"))).toEqual({ "app.tools.expand": "ctrl+t" });
	});

	it("reports no backup to revert before anything is applied", async () => {
		const paths = createHubPaths(agentDir);
		expect(await revertLatestBackup(storage(), paths)).toBeUndefined();
	});
});

describe("instruction injection", () => {
	function writeInstructions(version: number, text: string): string {
		const paths = createHubPaths(agentDir);
		const versionDir = bundleVersionDir(paths, "tester", "rules", version);
		mkdirSync(join(versionDir, "instructions"), { recursive: true });
		writeFileSync(join(versionDir, "instructions", "AGENTS.md"), text);
		return versionDir;
	}

	it("renders only enabled bundles", async () => {
		const versionDir = writeInstructions(1, "Always cite the runbook.");
		const enabled: HubState = {
			"tester/rules": { version: 1, enabled: true, path: versionDir, kinds: ["instructions"], track: "latest" },
		};

		const block = await renderInstructionsBlock(enabled);
		expect(block).toContain("Always cite the runbook.");
		expect(block).toContain("tester/rules — instructions/AGENTS.md");

		const disabled = { "tester/rules": { ...enabled["tester/rules"], enabled: false } };
		expect(await renderInstructionsBlock(disabled)).toBe("");
	});

	it("re-reads when hub state changes", async () => {
		const paths = createHubPaths(agentDir);
		const versionDir = writeInstructions(1, "Prefer small diffs.");
		const provider = new InstructionsProvider(paths);
		expect(await provider.getBlock()).toBe("");

		await writeHubState(paths.statePath, {
			"tester/rules": { version: 1, enabled: true, path: versionDir, kinds: ["instructions"], track: "latest" },
		});
		expect(await provider.getBlock()).toContain("Prefer small diffs.");

		await writeHubState(paths.statePath, {
			"tester/rules": { version: 1, enabled: false, path: versionDir, kinds: ["instructions"], track: "latest" },
		});
		expect(await provider.getBlock()).toBe("");
	});

	it("appends to the turn's system prompt and leaves nothing behind once disabled", async () => {
		vi.stubEnv("PHI_CODING_AGENT_DIR", agentDir);
		const paths = createHubPaths(agentDir);
		const versionDir = writeInstructions(1, "Never deploy on Friday.");
		await writeHubState(paths.statePath, {
			"tester/rules": { version: 1, enabled: true, path: versionDir, kinds: ["instructions"], track: "latest" },
		});

		const extension = await loadExtensionFromFactory(
			hubExtension,
			projectDir,
			createEventBus(),
			createExtensionRuntime(),
			"<inline:hub>",
		);
		const handler = extension.handlers.get("before_agent_start")?.[0];
		expect(handler).toBeDefined();

		const enabledResult = (await handler?.({ systemPrompt: "BASE PROMPT" }, { cwd: projectDir })) as
			| { systemPrompt?: string }
			| undefined;
		expect(enabledResult?.systemPrompt).toContain("BASE PROMPT");
		expect(enabledResult?.systemPrompt).toContain("Never deploy on Friday.");

		await writeHubState(paths.statePath, {
			"tester/rules": { version: 1, enabled: false, path: versionDir, kinds: ["instructions"], track: "latest" },
		});
		expect(await handler?.({ systemPrompt: "BASE PROMPT" }, { cwd: projectDir })).toBeUndefined();
		vi.unstubAllEnvs();
	});
});

describe("HubClient.publishVersion response parsing", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	async function publishAgainst(payload: unknown): Promise<number> {
		globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as typeof fetch;
		const client = new HubClient("https://hub.example", "phk_0123456789abcdef0123456789abcdef01234567");
		return client.publishVersion(
			{ owner: "example", slug: "demo" },
			{ files: [{ path: "skills/demo.md", content: Buffer.from("hi", "utf-8") }] },
		);
	}

	it("reads the nested version object the hub returns", async () => {
		await expect(
			publishAgainst({ ref: "example/demo", version: { version: 3, changelog: "x" }, files: [] }),
		).resolves.toBe(3);
	});

	it("falls back to a flat version number", async () => {
		await expect(publishAgainst({ ref: "example/demo", version: 2 })).resolves.toBe(2);
	});
});

describe("HubClient auth failures", () => {
	// 401 and 403 are different problems with different fixes. Collapsing them into
	// "the hub rejected your token, run /hub login" sent a user with a perfectly
	// valid token off to re-authenticate, which cannot grant a missing org publish
	// right, while the hub's own actionable `detail` was thrown away unread.
	const originalFetch = globalThis.fetch;
	const path = "/api/bundles/gateway/branding/versions";

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	async function publishFailure(status: number, body: string): Promise<HubError> {
		globalThis.fetch = vi.fn(async () => new Response(body, { status })) as typeof fetch;
		const client = new HubClient("https://hub.example", "phk_0123456789abcdef0123456789abcdef01234567");
		const reason = await client
			.publishVersion(
				{ owner: "gateway", slug: "branding" },
				{ files: [{ path: "skills/branding/SKILL.md", content: Buffer.from("hi", "utf-8") }] },
			)
			.then<unknown, unknown>(
				(value) => value,
				(error) => error,
			);
		if (!(reason instanceof HubError)) throw new Error(`expected a HubError, got ${String(reason)}`);
		return reason;
	}

	it("keeps the re-auth advice on 401 and appends what the hub said", async () => {
		const withDetail = await publishFailure(401, JSON.stringify({ detail: "Invalid or revoked API token" }));
		expect(withDetail.message).toBe(
			`phi hub 401 on ${path}: Invalid or revoked API token. Run /hub login to sign in again.`,
		);
		expect(withDetail.status).toBe(401);

		const bare = await publishFailure(401, "");
		expect(bare.message).toBe(
			`phi hub 401 on ${path}: the hub rejected your token. Run /hub login to sign in again.`,
		);
		expect(bare.status).toBe(401);
	});

	it("surfaces the hub's 403 detail and never sends the user to /hub login", async () => {
		const error = await publishFailure(
			403,
			JSON.stringify({
				detail: "You are not a publisher for 'demo-org'. An existing publisher can add you at /p/demo-org.",
			}),
		);
		expect(error.message).toBe(
			`phi hub 403 on ${path}: You are not a publisher for 'demo-org'. An existing publisher can add you at /p/demo-org.` +
				" Your token is valid, so this is a permissions problem: signing in again will not fix it.",
		);
		expect(error.message).not.toContain("/hub login");
		expect(error.status).toBe(403);
	});

	it("falls back to a permission message when a 403 body is empty or unparseable", async () => {
		for (const body of ["", "<html><body>403 Forbidden</body></html>"]) {
			const error = await publishFailure(403, body);
			expect(error.message).toBe(
				`phi hub 403 on ${path}: your account is not allowed to do this.` +
					" Your token is valid, so this is a permissions problem: signing in again will not fix it.",
			);
			expect(error.message).not.toContain("/hub login");
			expect(error.status).toBe(403);
		}
	});

	it("leaves other failures on the generic status/detail shape", async () => {
		const json = await publishFailure(422, JSON.stringify({ detail: "files: too large" }));
		expect(json.message).toBe(`phi hub 422 on ${path}: files: too large`);
		expect(json.status).toBe(422);

		const raw = await publishFailure(500, "upstream exploded");
		expect(raw.message).toBe(`phi hub 500 on ${path}: upstream exploded`);
		expect(raw.status).toBe(500);
	});
});

describe("bundle tracking", () => {
	const statePath = (): string => createHubPaths(agentDir).statePath;

	it("reads a legacy state row as pinned and an explicit track as written", async () => {
		mkdirSync(join(agentDir, "hub"), { recursive: true });
		// The bare map is the pre-tracking file format, written before `track` existed.
		writeFileSync(
			statePath(),
			JSON.stringify({
				"tester/legacy": { version: 1, enabled: true, path: "/store/tester/legacy/v1", kinds: ["skills"] },
				"tester/followed": {
					version: 2,
					enabled: true,
					path: "/store/tester/followed/v2",
					kinds: ["skills"],
					track: "latest",
				},
				"tester/held": { version: 3, enabled: false, path: "/store/tester/held/v3", kinds: [], track: "pinned" },
			}),
		);

		const state = await readHubState(statePath());
		expect(LEGACY_TRACK).toBe("pinned");
		expect(state["tester/legacy"].track).toBe("pinned");
		expect(state["tester/followed"].track).toBe("latest");
		expect(state["tester/held"].track).toBe("pinned");
		// A legacy row is never a silent auto-upgrade candidate.
		expect(trackedBundles(state).map((entry) => entry.key)).toEqual(["tester/followed"]);
	});

	it("only tracks latest rows, and honours a key filter", () => {
		const state: HubState = {
			"tester/a": { version: 1, enabled: true, path: "/a", kinds: [], track: "latest" },
			"tester/b": { version: 2, enabled: true, path: "/b", kinds: [], track: "pinned" },
			"tester/c": { version: 3, enabled: false, path: "/c", kinds: [], track: "latest" },
		};
		expect(trackedBundles(state)).toEqual([
			{ key: "tester/a", version: 1 },
			{ key: "tester/c", version: 3 },
		]);
		expect(trackedBundles(state, ["tester/c"])).toEqual([{ key: "tester/c", version: 3 }]);
		expect(trackedBundles(state, ["tester/b"])).toEqual([]);
	});

	it("keeps lastUpdateCheck across bundle writes and reads back the envelope", async () => {
		const row: HubBundleState = { version: 1, enabled: true, path: "/store/v1", kinds: ["skills"], track: "latest" };
		await writeHubStateFile(statePath(), {
			bundles: { "tester/routing": row },
			lastUpdateCheck: "2026-08-01T00:00:00.000Z",
		});

		expect(await readHubStateFile(statePath())).toEqual({
			bundles: { "tester/routing": row },
			lastUpdateCheck: "2026-08-01T00:00:00.000Z",
		});

		// A bundle mutation must not drop the client-wide field next to it.
		await writeHubState(statePath(), { "tester/routing": { ...row, version: 2 } });
		const afterWrite = await readHubStateFile(statePath());
		expect(afterWrite.lastUpdateCheck).toBe("2026-08-01T00:00:00.000Z");
		expect(afterWrite.bundles["tester/routing"].version).toBe(2);

		await recordUpdateCheck(statePath(), "2026-08-02T06:00:00.000Z");
		const afterCheck = await readHubStateFile(statePath());
		expect(afterCheck.lastUpdateCheck).toBe("2026-08-02T06:00:00.000Z");
		expect(afterCheck.bundles["tester/routing"].version).toBe(2);
	});
});

describe("update-check throttle", () => {
	const now = Date.parse("2026-08-02T12:00:00.000Z");
	const ago = (ms: number): string => new Date(now - ms).toISOString();

	it("checks at most once every six hours", () => {
		expect(UPDATE_CHECK_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
		expect(shouldCheckForUpdates(undefined, now)).toBe(true);
		expect(shouldCheckForUpdates(ago(5 * 60 * 60 * 1000), now)).toBe(false);
		expect(shouldCheckForUpdates(ago(UPDATE_CHECK_INTERVAL_MS - 1), now)).toBe(false);
		expect(shouldCheckForUpdates(ago(UPDATE_CHECK_INTERVAL_MS), now)).toBe(true);
		expect(shouldCheckForUpdates(ago(7 * 60 * 60 * 1000), now)).toBe(true);
	});

	it("does not wedge on a corrupt or future timestamp", () => {
		expect(shouldCheckForUpdates("not a date", now)).toBe(true);
		expect(shouldCheckForUpdates(new Date(now + 60 * 60 * 1000).toISOString(), now)).toBe(true);
	});
});

describe("auto-update mode", () => {
	it("defaults to org and ignores an unrecognized value", () => {
		expect(DEFAULT_HUB_AUTO_UPDATE).toBe("org");
		expect(readHubAutoUpdateMode(storage())).toBe("org");

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark", hubAutoUpdate: "all" }));
		expect(readHubAutoUpdateMode(storage())).toBe("all");

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hubAutoUpdate: "off" }));
		expect(readHubAutoUpdateMode(storage())).toBe("off");

		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ hubAutoUpdate: "sometimes" }));
		expect(readHubAutoUpdateMode(storage())).toBe("org");
	});

	it("auto-updates org bundles under org, everything under all, nothing under off", () => {
		const matrix: Array<[HubAutoUpdateMode, boolean | undefined, boolean]> = [
			["org", true, true],
			["org", false, false],
			// Unknown ownership is personal: an auto-update is never granted on a guess.
			["org", undefined, false],
			["all", true, true],
			["all", false, true],
			["all", undefined, true],
			["off", true, false],
			["off", false, false],
			["off", undefined, false],
		];
		for (const [mode, ownerIsOrg, expected] of matrix) {
			expect(shouldAutoUpdate(mode, ownerIsOrg), `${mode}/${String(ownerIsOrg)}`).toBe(expected);
		}
	});
});

describe("startup check reporting", () => {
	function outcome(partial: Partial<StartupCheckOutcome>): StartupCheckOutcome {
		return { ran: true, mode: "org", available: [], applied: [], deferred: [], missing: [], ...partial };
	}

	it("reports what was updated, what is waiting, and nothing when idle", () => {
		expect(
			formatStartupStatus(outcome({ applied: [{ key: "example/rules", fromVersion: 1, toVersion: 2, ok: true }] })),
		).toBe("hub: updated 1 bundle(s)");

		expect(formatStartupStatus(outcome({ deferred: [{ key: "tester/routing", latestVersion: 4 }] }))).toBe(
			"hub: 1 update(s) available — /hub update",
		);

		expect(
			formatStartupStatus(
				outcome({
					applied: [{ key: "example/rules", fromVersion: 1, toVersion: 2, ok: true }],
					deferred: [{ key: "tester/routing", latestVersion: 4 }],
				}),
			),
		).toBe("hub: updated 1 bundle(s), 1 more — /hub update");

		// A failed auto-update still leaves work for the user.
		expect(
			formatStartupStatus(
				outcome({ applied: [{ key: "example/rules", fromVersion: 1, toVersion: 2, ok: false, error: "boom" }] }),
			),
		).toBe("hub: 1 update(s) available — /hub update");

		expect(formatStartupStatus(outcome({}))).toBeUndefined();
	});
});

describe("HubClient.checkUpdates", () => {
	const originalFetch = globalThis.fetch;

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function client(): HubClient {
		return new HubClient("https://hub.example", "phk_0123456789abcdef0123456789abcdef01234567");
	}

	it("sends one round trip and reads refs, versions, and org ownership", async () => {
		const calls: Array<{ url: string; body: unknown }> = [];
		globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return new Response(
				JSON.stringify({
					updates: [
						{ ref: "example/rules", latest_version: 5, kind: "instructions", title: "Rules", owner_is_org: true },
						{ owner: "tester", slug: "routing", latest_version: 3 },
					],
					missing: ["tester/gone", { ref: "tester/renamed" }],
				}),
				{ status: 200 },
			);
		}) as unknown as typeof fetch;

		const result = await client().checkUpdates([
			{ ref: "example/rules", version: 4 },
			{ ref: "tester/routing", version: 1 },
		]);

		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe("https://hub.example/api/updates/check");
		expect(calls[0].body).toEqual({
			installed: [
				{ ref: "example/rules", version: 4 },
				{ ref: "tester/routing", version: 1 },
			],
		});
		expect(result.updates).toEqual([
			{
				key: "example/rules",
				latestVersion: 5,
				kind: "instructions",
				title: "Rules",
				changelog: undefined,
				ownerIsOrg: true,
			},
			{
				key: "tester/routing",
				latestVersion: 3,
				kind: undefined,
				title: undefined,
				changelog: undefined,
				ownerIsOrg: undefined,
			},
		]);
		expect(result.missing).toEqual(["tester/gone", "tester/renamed"]);
	});

	it("skips the round trip when nothing is installed", async () => {
		globalThis.fetch = vi.fn(async () => new Response("{}", { status: 200 })) as typeof fetch;
		expect(await client().checkUpdates([])).toEqual({ updates: [], missing: [] });
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("explains a hub that predates the marketplace endpoint", async () => {
		globalThis.fetch = vi.fn(
			async () => new Response(JSON.stringify({ detail: "Not Found" }), { status: 404 }),
		) as typeof fetch;
		await expect(client().checkUpdates([{ ref: "tester/routing", version: 1 }])).rejects.toThrow(
			/no \/api\/updates\/check endpoint/,
		);
	});
});
