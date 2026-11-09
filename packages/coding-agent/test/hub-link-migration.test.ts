// Exowatt fork test: the synchronous startup migration that drops `packages`
// entries pointing at a hub bundle root pi cannot load as a package.
//
// The reason this is a migration and not a session event: pi resolves `packages`
// during startup, and a root with no skills/extensions/prompts/themes under it is
// resolved as an *extension file*, which the extension loader then fails to
// import. A repair that runs after resolution reports the problem; only one that
// runs before it prevents the problem. Every assertion below is therefore ordered
// against `DefaultPackageManager.resolve()`.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runMigrations } from "../src/migrations.ts";

let root: string;
let agentDir: string;
let projectDir: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "phi-hub-link-migration-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(join(agentDir, "hub"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });
	// runMigrations resolves the agent dir through getAgentDir(), the same way
	// startup does, so the env override is what makes this a real startup test.
	vi.stubEnv(ENV_AGENT_DIR, agentDir);
});

afterEach(() => {
	vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

/** Materialize a bundle version dir with the given top-level kind dirs. */
function writeBundle(owner: string, slug: string, version: number, kinds: string[]): string {
	const path = join(agentDir, "hub", "bundles", owner, slug, `v${version}`);
	mkdirSync(path, { recursive: true });
	for (const kind of kinds) {
		mkdirSync(join(path, kind), { recursive: true });
		if (kind === "models") writeFileSync(join(path, kind, "models.json"), JSON.stringify({ providers: {} }));
		if (kind === "instructions") writeFileSync(join(path, kind, "AGENTS.md"), "# Rules\n");
		if (kind === "settings") writeFileSync(join(path, kind, "settings.json"), JSON.stringify({ theme: "gateway" }));
		if (kind === "skills") {
			mkdirSync(join(path, kind, "routing"), { recursive: true });
			writeFileSync(join(path, kind, "routing", "SKILL.md"), "# Routing\n");
		}
		if (kind === "extensions") writeFileSync(join(path, kind, "thing.ts"), "export default () => {};\n");
		if (kind === "prompts") writeFileSync(join(path, kind, "review.md"), "Review it.\n");
		if (kind === "themes") writeFileSync(join(path, kind, "demo-org.json"), "{}\n");
	}
	return path;
}

function writeState(
	rows: Record<string, { path: string; kinds: string[]; enabled?: boolean; version?: number }>,
): void {
	const bundles: Record<string, unknown> = {};
	for (const [key, row] of Object.entries(rows)) {
		bundles[key] = {
			version: row.version ?? 1,
			enabled: row.enabled ?? true,
			path: row.path,
			kinds: row.kinds,
			track: "latest",
		};
	}
	writeFileSync(join(agentDir, "hub", "state.json"), `${JSON.stringify({ bundles }, null, 2)}\n`);
}

function writeSettings(document: Record<string, unknown>): void {
	writeFileSync(join(agentDir, "settings.json"), `${JSON.stringify(document, null, 2)}\n`);
}

function readSettings(): Record<string, unknown> {
	const path = join(agentDir, "settings.json");
	return existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : {};
}

function readPackages(): unknown[] {
	const packages = readSettings().packages;
	return Array.isArray(packages) ? packages : [];
}

/** What pi's package manager makes of the current `packages` array. */
async function resolvePackages() {
	const settingsManager = SettingsManager.create(projectDir, agentDir);
	const manager = new DefaultPackageManager({ cwd: projectDir, agentDir, settingsManager });
	return await manager.resolve(async () => "skip");
}

describe("startup migration: stale hub packages links", () => {
	it("drops a models-only link before the package manager ever resolves it", async () => {
		const bundlePath = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({ "example/gateway-models": { path: bundlePath, kinds: ["models"] } });
		writeSettings({ packages: [bundlePath] });

		// Establish the failure first, so the ordering claim is not taken on faith:
		// with the entry still present the root is resolved as an extension file.
		const before = await resolvePackages();
		expect(before.extensions.map((resource) => resource.path)).toEqual([bundlePath]);

		const { unlinkedHubBundles } = runMigrations(projectDir);

		expect(unlinkedHubBundles).toEqual(["example/gateway-models"]);
		expect(readPackages()).toEqual([]);
		// The state row is untouched: the bundle is still enabled and its own loader
		// still reads it. Only the packages entry was wrong.
		const state = JSON.parse(readFileSync(join(agentDir, "hub", "state.json"), "utf-8"));
		expect(state.bundles["example/gateway-models"]).toMatchObject({ enabled: true, kinds: ["models"] });
		expect(existsSync(join(bundlePath, "models", "models.json"))).toBe(true);

		// And now there is nothing for the extension loader to choke on.
		const after = await resolvePackages();
		expect(after.extensions).toEqual([]);
	});

	it.each([
		["instructions-only", ["instructions"]],
		["settings-only", ["settings"]],
		["every hub-only kind at once", ["instructions", "models", "settings"]],
		["no recognized kind at all", []],
	])("drops a %s link", async (_label, kinds) => {
		const bundlePath = writeBundle("tester", "shared", 1, kinds);
		writeState({ "tester/shared": { path: bundlePath, kinds } });
		writeSettings({ packages: [bundlePath] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual(["tester/shared"]);
		expect(readPackages()).toEqual([]);
		expect((await resolvePackages()).extensions).toEqual([]);
	});

	it("drops a disabled hub-only link too, but does not call it a stale-link fix", () => {
		const bundlePath = writeBundle("tester", "shared", 1, ["models"]);
		writeState({ "tester/shared": { path: bundlePath, kinds: ["models"], enabled: false } });
		writeSettings({ packages: [bundlePath] });

		// Reported list is only the enabled case, which is the one that broke
		// startup; a disabled bundle losing its entry is ordinary drift, not news.
		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual([]);
	});

	it.each([
		["skills", join("skills", "routing", "SKILL.md")],
		["extensions", join("extensions", "thing.ts")],
		["prompts", join("prompts", "review.md")],
		["themes", join("themes", "demo-org.json")],
	])("keeps a %s bundle linked and resolvable", async (kind, resourceRelPath) => {
		const bundlePath = writeBundle("tester", "routing", 1, [kind]);
		writeState({ "tester/routing": { path: bundlePath, kinds: [kind] } });
		writeSettings({ packages: [bundlePath] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual([bundlePath]);

		// Resolved as a package: the resource *inside* the bundle, and never the
		// bundle root itself (which is the shape of the bug).
		const resolved = await resolvePackages();
		const paths = [...resolved.skills, ...resolved.extensions, ...resolved.prompts, ...resolved.themes].map(
			(resource) => resource.path,
		);
		expect(paths).toContain(join(bundlePath, resourceRelPath));
		expect(paths).not.toContain(bundlePath);
	});

	it("keeps a mixed bundle linked and its skill resolvable", async () => {
		const kinds = ["models", "instructions", "settings", "skills"];
		const bundlePath = writeBundle("gateway", "mixed", 1, kinds);
		writeState({ "gateway/mixed": { path: bundlePath, kinds } });
		writeSettings({ packages: [bundlePath] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual([bundlePath]);

		const resolved = await resolvePackages();
		expect(resolved.extensions).toEqual([]);
		expect(resolved.skills.map((resource) => resource.path)).toContain(
			join(bundlePath, "skills", "routing", "SKILL.md"),
		);
	});

	it("preserves every unrelated packages entry, including object forms", () => {
		const stale = writeBundle("gateway", "gateway-models", 1, ["models"]);
		const keep = writeBundle("tester", "routing", 1, ["skills"]);
		writeState({
			"example/gateway-models": { path: stale, kinds: ["models"] },
			"tester/routing": { path: keep, kinds: ["skills"] },
		});
		const localPackage = join(root, "my-own-package");
		mkdirSync(join(localPackage, "skills"), { recursive: true });
		writeSettings({
			theme: "dark",
			packages: [
				"npm:pi-skills",
				{ source: localPackage, autoload: false },
				stale,
				{ source: keep, skills: ["routing"] },
				"github:someone/their-package",
			],
		});

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual(["example/gateway-models"]);
		// Order, object forms, and their extra fields all survive; only the one
		// stale string entry is gone.
		expect(readPackages()).toEqual([
			"npm:pi-skills",
			{ source: localPackage, autoload: false },
			{ source: keep, skills: ["routing"] },
			"github:someone/their-package",
		]);
		// And no other settings key is touched.
		expect(readSettings().theme).toBe("dark");
	});

	it("removes an object-form entry whose source is the stale bundle root", () => {
		const stale = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({ "example/gateway-models": { path: stale, kinds: ["models"] } });
		writeSettings({ packages: ["npm:pi-skills", { source: stale, autoload: true }] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual(["example/gateway-models"]);
		expect(readPackages()).toEqual(["npm:pi-skills"]);
	});

	it("is idempotent: a second run changes nothing and reports nothing", () => {
		const stale = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({ "example/gateway-models": { path: stale, kinds: ["models"] } });
		writeSettings({ packages: ["npm:pi-skills", stale] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual(["example/gateway-models"]);
		const afterFirst = readFileSync(join(agentDir, "settings.json"), "utf-8");

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		// Byte-identical: the no-change path must not even rewrite the file.
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(afterFirst);
	});

	it("trusts the directory over an empty kinds array from a pre-kinds state row", () => {
		// Rows written before `kinds` existed record []. Unlinking a working skills
		// bundle on the strength of that alone would be worse than the bug being
		// fixed, so the migration also looks at what is actually on disk.
		const loadable = writeBundle("tester", "routing", 1, ["skills"]);
		const hubOnly = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({
			"tester/routing": { path: loadable, kinds: [] },
			"example/gateway-models": { path: hubOnly, kinds: [] },
		});
		writeSettings({ packages: [loadable, hubOnly] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual(["example/gateway-models"]);
		expect(readPackages()).toEqual([loadable]);
	});

	it("leaves an entry alone when the store dir is gone", () => {
		const missing = join(agentDir, "hub", "bundles", "gateway", "gone", "v1");
		writeState({ "gateway/gone": { path: missing, kinds: ["models"] } });
		writeSettings({ packages: [missing] });

		// Nothing on disk to inspect, and the resolver already skips a dead path, so
		// the migration does not guess. Re-import or /hub sync is the fix.
		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual([missing]);
	});
});

describe("startup migration: hostile inputs never break startup", () => {
	it("no hub state at all", () => {
		writeSettings({ packages: ["npm:pi-skills"] });
		rmSync(join(agentDir, "hub"), { recursive: true, force: true });

		expect(() => runMigrations(projectDir)).not.toThrow();
		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual(["npm:pi-skills"]);
	});

	it.each([
		["truncated JSON", '{\n  "bundles": {\n'],
		["empty file", ""],
		["a JSON array", "[]"],
		["a JSON scalar", '"nope"'],
		["rows missing version and path", JSON.stringify({ bundles: { "tester/x": { enabled: true } } })],
		["a row whose path is not a string", JSON.stringify({ bundles: { "tester/x": { version: 1, path: 7 } } })],
		[
			"kinds that are not strings",
			JSON.stringify({ bundles: { "tester/x": { version: 1, path: "/tmp/x", kinds: 3 } } }),
		],
	])("malformed hub state: %s", (_label, content) => {
		writeFileSync(join(agentDir, "hub", "state.json"), content);
		writeSettings({ packages: ["npm:pi-skills"] });

		expect(() => runMigrations(projectDir)).not.toThrow();
		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		// A settings file it could not reason about is left exactly as it was.
		expect(readPackages()).toEqual(["npm:pi-skills"]);
	});

	it("no settings.json at all", () => {
		const bundlePath = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({ "example/gateway-models": { path: bundlePath, kinds: ["models"] } });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		// Nothing was linked, so nothing is written — a fresh install must not gain
		// a settings.json from a migration that had nothing to do.
		expect(existsSync(join(agentDir, "settings.json"))).toBe(false);
	});

	it.each([
		["malformed settings.json", "{ not json"],
		["settings.json holding an array", "[]"],
	])("%s leaves the file untouched", (_label, content) => {
		const bundlePath = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({ "example/gateway-models": { path: bundlePath, kinds: ["models"] } });
		writeFileSync(join(agentDir, "settings.json"), content);

		expect(() => runMigrations(projectDir)).not.toThrow();
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(content);
	});

	it("a packages value that is not an array", () => {
		const bundlePath = writeBundle("gateway", "gateway-models", 1, ["models"]);
		writeState({ "example/gateway-models": { path: bundlePath, kinds: ["models"] } });
		writeSettings({ packages: "npm:pi-skills" });

		expect(() => runMigrations(projectDir)).not.toThrow();
		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
	});
});

describe("startup migration: malformed rows never lose a working link", () => {
	it.each([
		["a missing enabled field", undefined],
		["enabled recorded as a string", "yes"],
		["enabled recorded as a number", 1],
	])("%s leaves a loadable bundle linked", (_label, enabled) => {
		const bundlePath = writeBundle("tester", "shared", 1, ["skills"]);
		const row: Record<string, unknown> = { version: 1, path: bundlePath, kinds: ["skills"], track: "latest" };
		if (enabled !== undefined) row.enabled = enabled;
		writeFileSync(join(agentDir, "hub", "state.json"), JSON.stringify({ bundles: { "tester/shared": row } }));
		writeSettings({ packages: [bundlePath] });

		// `enabled` is read as false so the client keeps working, but that fallback
		// must not be mistaken for the user having disabled the bundle: unlinking is
		// the destructive direction, so an unreadable row gets left alone.
		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual([bundlePath]);
	});

	it("keeps the malformed marker out of the state file when the row is rewritten", async () => {
		const bundlePath = writeBundle("tester", "shared", 1, ["skills"]);
		writeFileSync(
			join(agentDir, "hub", "state.json"),
			JSON.stringify({ bundles: { "tester/shared": { version: 1, path: bundlePath, kinds: ["skills"] } } }),
		);

		const { readHubStateFile, withEnabled, writeHubState } = await import("../src/extensions/hub/state.ts");
		const statePath = join(agentDir, "hub", "state.json");
		const before = await readHubStateFile(statePath);
		expect(before.bundles["tester/shared"].enabledUnknown).toBe(true);

		await writeHubState(statePath, withEnabled(before.bundles, "tester/shared", true));

		const raw = JSON.parse(readFileSync(statePath, "utf-8"));
		expect(raw.bundles["tester/shared"].enabled).toBe(true);
		expect("enabledUnknown" in raw.bundles["tester/shared"]).toBe(false);
	});
});

describe("startup migration: reconciliation is one atomic settings write", () => {
	it("drops several stale entries under a single lock", async () => {
		const models = writeBundle("gateway", "gateway-models", 1, ["models"]);
		const instructions = writeBundle("gateway", "house-rules", 1, ["instructions"]);
		const loadable = writeBundle("tester", "shared", 1, ["skills"]);
		writeState({
			"example/gateway-models": { path: models, kinds: ["models"] },
			"gateway/house-rules": { path: instructions, kinds: ["instructions"] },
			"tester/shared": { path: loadable, kinds: ["skills"] },
		});
		writeSettings({ packages: [models, "npm:pi-skills", instructions, loadable] });

		const { repairHubPackageLinks } = await import("../src/extensions/hub/link-repair.ts");
		const { FileSettingsStorage } = await import("../src/core/settings-manager.ts");
		const storage = new FileSettingsStorage(projectDir, agentDir);
		const withLock = vi.spyOn(storage, "withLock");

		const repairs = repairHubPackageLinks(storage, {
			"example/gateway-models": {
				version: 1,
				enabled: true,
				path: models,
				kinds: ["models"],
				track: "latest",
			},
			"gateway/house-rules": {
				version: 1,
				enabled: true,
				path: instructions,
				kinds: ["instructions"],
				track: "latest",
			},
			"tester/shared": { version: 1, enabled: true, path: loadable, kinds: ["skills"], track: "latest" },
		});

		// Two stale entries, one write: a snapshot taken outside the lock and a write
		// per bundle would leave a window where `packages` is half-reconciled.
		expect(withLock).toHaveBeenCalledTimes(1);
		expect(repairs.map((repair) => repair.key)).toEqual(["example/gateway-models", "gateway/house-rules"]);
		expect(repairs.every((repair) => repair.action === "unlinked" && repair.stale)).toBe(true);
		// Order and unrelated entries survive.
		expect(readPackages()).toEqual(["npm:pi-skills", loadable]);
	});

	it("writes nothing when there is nothing to reconcile", async () => {
		const loadable = writeBundle("tester", "shared", 1, ["skills"]);
		writeSettings({ packages: [loadable] });
		const before = readFileSync(join(agentDir, "settings.json"), "utf-8");

		const { repairHubPackageLinks } = await import("../src/extensions/hub/link-repair.ts");
		const { FileSettingsStorage } = await import("../src/core/settings-manager.ts");
		const storage = new FileSettingsStorage(projectDir, agentDir);

		expect(
			repairHubPackageLinks(storage, {
				"tester/shared": { version: 1, enabled: true, path: loadable, kinds: ["skills"], track: "latest" },
			}),
		).toEqual([]);
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(before);
	});
});

describe("legacy rows that record no kinds resolve the same way everywhere", () => {
	it("the disk answer, not the empty array, decides link intent", async () => {
		const loadable = writeBundle("tester", "shared", 1, ["skills"]);
		const hubOnly = writeBundle("gateway", "gateway-models", 1, ["models"]);
		const { isBundleLinkable, resolveBundleLinkIntent } = await import("../src/extensions/hub/link-repair.ts");

		// A row written before `kinds` was recorded says nothing about what it ships.
		expect(isBundleLinkable({ kinds: [], path: loadable })).toBe(true);
		expect(isBundleLinkable({ kinds: [], path: hubOnly })).toBe(false);
		// A row that does record kinds is taken at its word — no disk access needed.
		expect(isBundleLinkable({ kinds: ["skills"], path: hubOnly })).toBe(true);

		const row = { version: 1, enabled: true, path: loadable, kinds: [], track: "latest" as const };
		expect(resolveBundleLinkIntent(row)).toBe(true);
		expect(resolveBundleLinkIntent({ ...row, enabled: false })).toBe(false);
		expect(resolveBundleLinkIntent({ ...row, enabledUnknown: true })).toBeUndefined();
	});

	it("startup keeps the link of an empty-kinds bundle that ships skills", () => {
		const loadable = writeBundle("tester", "shared", 1, ["skills"]);
		writeState({ "tester/shared": { path: loadable, kinds: [] } });
		writeSettings({ packages: [loadable] });

		expect(runMigrations(projectDir).unlinkedHubBundles).toEqual([]);
		expect(readPackages()).toEqual([loadable]);
	});
});
