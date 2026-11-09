// Regression test: the hub link repair has to beat *every* path that resolves
// `packages`, not just the interactive one.
//
// `pi list` (and `pi config`) build a package manager of their own and return
// before the normal migration phase is reached, so a repair that lived only in
// `runMigrations` would let those commands resolve the stale hub-only entry —
// reporting the broken extension while trying to help fix it. This asserts the
// ordering through `main()`, which is where the guarantee actually lives.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { main } from "../src/main.ts";
import { allowNetwork } from "./test-network-env.ts";

let root: string;
let agentDir: string;
let projectDir: string;
let originalCwd: string;
let bundlePath: string;
let output: string[];

beforeEach(() => {
	allowNetwork();
	root = mkdtempSync(join(tmpdir(), "phi-hub-cli-order-"));
	agentDir = join(root, "agent");
	projectDir = join(root, "project");
	mkdirSync(join(agentDir, "hub"), { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	// A models-only bundle: enabled, loaded from hub state, and linked by a
	// pre-fix client into `packages` where the resolver treats the root itself as
	// an extension file.
	bundlePath = join(agentDir, "hub", "bundles", "gateway", "gateway-models", "v1");
	mkdirSync(join(bundlePath, "models"), { recursive: true });
	writeFileSync(join(bundlePath, "models", "models.json"), JSON.stringify({ providers: {} }));
	writeFileSync(
		join(agentDir, "hub", "state.json"),
		JSON.stringify({
			bundles: {
				"example/gateway-models": {
					version: 1,
					enabled: true,
					path: bundlePath,
					kinds: ["models"],
					track: "latest",
				},
			},
		}),
	);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [bundlePath] }, null, 2));

	originalCwd = process.cwd();
	process.env[ENV_AGENT_DIR] = agentDir;
	process.chdir(projectDir);

	output = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		output.push(args.join(" "));
	});
	vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		output.push(args.join(" "));
	});
	vi.spyOn(process, "exit").mockImplementation((() => undefined as never) as typeof process.exit);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.chdir(originalCwd);
	delete process.env[ENV_AGENT_DIR];
	rmSync(root, { recursive: true, force: true });
});

function linkedPackages(): unknown[] {
	const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
	return Array.isArray(raw.packages) ? raw.packages : [];
}

describe("hub link repair runs before package-resolving CLI commands", () => {
	it("`pi list` heals the stale entry instead of reporting it", async () => {
		await main(["list"]);

		expect(linkedPackages()).toEqual([]);
		// The bundle is still imported and still enabled; only the packages entry went.
		const state = JSON.parse(readFileSync(join(agentDir, "hub", "state.json"), "utf-8"));
		expect(state.bundles["example/gateway-models"]).toMatchObject({ enabled: true, path: bundlePath });
		expect(existsSync(bundlePath)).toBe(true);
		expect(output.join("\n")).not.toContain("Failed to load extension");
	});

	it("is idempotent across two invocations and leaves unrelated entries alone", async () => {
		const unrelatedPath = join(root, "unrelated-package");
		mkdirSync(unrelatedPath);
		writeFileSync(
			join(unrelatedPath, "package.json"),
			JSON.stringify({ name: "unrelated-package", version: "1.0.0" }),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ packages: [unrelatedPath, bundlePath] }, null, 2),
		);

		await main(["list"]);
		const afterFirst = readFileSync(join(agentDir, "settings.json"), "utf-8");
		expect(linkedPackages()).toEqual([unrelatedPath]);

		await main(["list"]);
		// Second run finds nothing stale, so it must not rewrite the file at all.
		expect(readFileSync(join(agentDir, "settings.json"), "utf-8")).toBe(afterFirst);
	});
});
