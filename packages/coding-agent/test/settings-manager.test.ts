import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, MAX_STREAM_IDLE_TIMEOUT_MS } from "@earendil-works/pi-ai";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS } from "../src/core/http-dispatcher.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";

describe("SettingsManager", () => {
	const testDir = join(process.cwd(), "test-settings-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		// Clean up and create fresh directories
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) {
			rmSync(testDir, { recursive: true });
		}
	});

	describe("preserves externally added settings", () => {
		it("should preserve enabledModels when changing thinking level", async () => {
			// Create initial settings file
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					defaultModel: "claude-sonnet",
				}),
			);

			// Create SettingsManager (simulates pi starting up)
			const manager = SettingsManager.create(projectDir, agentDir);

			// Simulate user editing settings.json externally to add enabledModels
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.enabledModels = ["claude-opus-4-5", "gpt-5.2-codex"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes thinking level via Shift+Tab
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// Verify enabledModels is preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.enabledModels).toEqual(["claude-opus-4-5", "gpt-5.2-codex"]);
			expect(savedSettings.defaultThinkingLevel).toBe("high");
			expect(savedSettings.theme).toBe("dark");
			expect(savedSettings.defaultModel).toBe("claude-sonnet");
		});

		it("should preserve custom settings when changing theme", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					defaultModel: "claude-sonnet",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User adds custom settings externally
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.shellPath = "/bin/zsh";
			currentSettings.extensions = ["/path/to/extension.ts"];
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// User changes theme
			manager.setTheme("light");
			await manager.flush();

			// Verify all settings preserved
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellPath).toBe("/bin/zsh");
			expect(savedSettings.extensions).toEqual(["/path/to/extension.ts"]);
			expect(savedSettings.theme).toBe("light");
		});

		it("should let in-memory changes override file changes for same key", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			// User externally sets thinking level to "low"
			const currentSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			currentSettings.defaultThinkingLevel = "low";
			writeFileSync(settingsPath, JSON.stringify(currentSettings, null, 2));

			// But then changes it via UI to "high"
			manager.setDefaultThinkingLevel("high");
			await manager.flush();

			// In-memory change should win
			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.defaultThinkingLevel).toBe("high");
		});
	});

	describe("deviceId", () => {
		it("creates one global device ID and reuses it in later processes", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ deviceId: "project-device" }));
			const first = SettingsManager.create(projectDir, agentDir);

			const deviceId = first.getOrCreateDeviceId();
			await first.flush();

			expect(deviceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
			expect(first.getOrCreateDeviceId()).toBe(deviceId);
			expect(SettingsManager.create(projectDir, agentDir).getOrCreateDeviceId()).toBe(deviceId);
			expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark", deviceId });
		});
	});

	describe("packages migration", () => {
		it("should keep local-only extensions in extensions array", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					extensions: ["/local/ext.ts", "./relative/ext.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getPackages()).toEqual([]);
			expect(manager.getExtensionPaths()).toEqual(["/local/ext.ts", "./relative/ext.ts"]);
		});

		it("should handle packages with filtering objects", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					packages: [
						"npm:simple-pkg",
						{
							source: "npm:shitty-extensions",
							extensions: ["extensions/oracle.ts"],
							skills: [],
						},
					],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			const packages = manager.getPackages();
			expect(packages).toHaveLength(2);
			expect(packages[0]).toBe("npm:simple-pkg");
			expect(packages[1]).toEqual({
				source: "npm:shitty-extensions",
				extensions: ["extensions/oracle.ts"],
				skills: [],
			});
		});
	});

	describe("reload", () => {
		it("should reload global settings from disk", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "dark",
					extensions: ["/before.ts"],
				}),
			);

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(
				settingsPath,
				JSON.stringify({
					theme: "light",
					extensions: ["/after.ts"],
					defaultModel: "claude-sonnet",
				}),
			);

			await manager.reload();

			expect(manager.getTheme()).toBe("light");
			expect(manager.getExtensionPaths()).toEqual(["/after.ts"]);
			expect(manager.getDefaultModel()).toBe("claude-sonnet");
		});

		it("should keep previous settings and report the file path when the file is invalid", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			writeFileSync(settingsPath, "{ invalid json");
			await manager.reload();

			expect(manager.getTheme()).toBe("dark");
			expect(manager.drainErrors()).toMatchObject([{ scope: "global", path: settingsPath }]);
		});
	});

	describe("theme setting", () => {
		it("stores slash-separated automatic theme settings separately from fixed theme names", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "light/dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTheme()).toBeUndefined();
			expect(manager.getThemeSetting()).toBe("light/dark");

			manager.setTheme("solarized-light/tokyo-night");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.theme).toBe("solarized-light/tokyo-night");
		});
	});

	describe("error tracking", () => {
		it("should collect and clear load errors via drainErrors", () => {
			const globalSettingsPath = join(agentDir, "settings.json");
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(globalSettingsPath, "{ invalid global json");
			writeFileSync(projectSettingsPath, "{ invalid project json");

			const manager = SettingsManager.create(projectDir, agentDir);
			const errors = manager.drainErrors();

			expect(errors).toHaveLength(2);
			expect(errors).toMatchObject([
				{ scope: "global", path: globalSettingsPath },
				{ scope: "project", path: projectSettingsPath },
			]);
			expect(manager.drainErrors()).toEqual([]);
		});
	});

	describe("project trust", () => {
		it("should skip project settings when project is not trusted", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: "project" }));

			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(manager.isProjectTrusted()).toBe(false);
			expect(manager.getTheme()).toBe("global");
			expect(manager.getProjectSettings()).toEqual({});
		});

		it("should reload project settings after trust changes to true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "global" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ theme: "project" }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			manager.setProjectTrusted(true);

			expect(manager.isProjectTrusted()).toBe(true);
			expect(manager.getTheme()).toBe("project");
		});

		it("should fail project settings writes when project is not trusted", async () => {
			const projectSettingsPath = join(projectDir, ".pi", "settings.json");
			writeFileSync(projectSettingsPath, JSON.stringify({ packages: ["npm:existing"] }));
			const manager = SettingsManager.create(projectDir, agentDir, { projectTrusted: false });

			expect(() => manager.setProjectPackages(["npm:new"])).toThrow(
				"Project is not trusted; refusing to write project settings",
			);
			await manager.flush();

			expect(manager.getProjectSettings()).toEqual({});
			expect(JSON.parse(readFileSync(projectSettingsPath, "utf-8"))).toEqual({ packages: ["npm:existing"] });
		});

		it("should read default project trust from global settings only", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "always" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultProjectTrust: "never" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("always");
		});

		it("should default invalid project trust settings to ask", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProjectTrust: "sometimes" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getDefaultProjectTrust()).toBe("ask");
		});
	});

	describe("project settings directory creation", () => {
		it("should not create .pi folder when only reading project settings", () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			// Create SettingsManager (reads both global and project settings)
			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT have been created just from reading
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Settings should still be loaded from global
			expect(manager.getTheme()).toBe("dark");
		});

		it("should create .pi folder when writing project settings", async () => {
			// Create agent dir with global settings, but NO .pi folder in project
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			// Delete the .pi folder that beforeEach created
			rmSync(join(projectDir, ".pi"), { recursive: true });

			const manager = SettingsManager.create(projectDir, agentDir);

			// .pi folder should NOT exist yet
			expect(existsSync(join(projectDir, ".pi"))).toBe(false);

			// Write a project-specific setting
			manager.setProjectPackages([{ source: "npm:test-pkg" }]);
			await manager.flush();

			// Now .pi folder should exist
			expect(existsSync(join(projectDir, ".pi"))).toBe(true);

			// And settings file should be created
			expect(existsSync(join(projectDir, ".pi", "settings.json"))).toBe(true);
		});
	});

	describe("terminal capability overrides", () => {
		it("maps explicit values and omits auto values", () => {
			const getOverrides = (terminal: NonNullable<Settings["terminal"]>) =>
				SettingsManager.inMemory({ terminal }).getTerminalCapabilityOverrides();

			expect(getOverrides({ images: false, trueColor: false, hyperlinks: false })).toEqual({
				images: null,
				trueColor: false,
				hyperlinks: false,
			});
			expect(getOverrides({ images: "kitty", trueColor: true, hyperlinks: true })).toEqual({
				images: "kitty",
				trueColor: true,
				hyperlinks: true,
			});
			expect(getOverrides({ images: "auto", trueColor: "auto", hyperlinks: "auto" })).toEqual({});
		});
	});

	describe("retry settings", () => {
		it("defaults and overrides agent retry delay cap", () => {
			expect(SettingsManager.inMemory().getRetrySettings()).toEqual({
				enabled: true,
				maxRetries: 3,
				baseDelayMs: 2000,
				maxAgentDelayMs: 60000,
			});
			expect(
				SettingsManager.inMemory({
					retry: { enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 },
				}).getRetrySettings(),
			).toEqual({ enabled: true, maxRetries: 10, baseDelayMs: 500, maxAgentDelayMs: 5000 });
		});
	});

	describe("httpIdleTimeoutMs", () => {
		it("should default to 5 minutes", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getHttpIdleTimeoutMs()).toBe(DEFAULT_HTTP_IDLE_TIMEOUT_MS);
		});

		it("should use merged global and project settings", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 300000 }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ httpIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getHttpIdleTimeoutMs()).toBe(0);
		});

		it("should reject invalid timeout values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ httpIdleTimeoutMs: -1 }));
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(() => manager.getHttpIdleTimeoutMs()).toThrow("Invalid httpIdleTimeoutMs setting");
		});
	});

	describe("streamIdleTimeoutMs", () => {
		it("defaults to 420 seconds", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getStreamIdleTimeoutMs()).toBe(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
		});

		it("supports project overrides and zero to disable", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ streamIdleTimeoutMs: 240000 }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ streamIdleTimeoutMs: 0 }));

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getStreamIdleTimeoutMs()).toBe(0);
		});

		it("rejects invalid values and timer-overflow values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ streamIdleTimeoutMs: -1 }));
			let manager = SettingsManager.create(projectDir, agentDir);
			expect(() => manager.getStreamIdleTimeoutMs()).toThrow("Invalid streamIdleTimeoutMs setting");

			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ streamIdleTimeoutMs: MAX_STREAM_IDLE_TIMEOUT_MS + 1 }),
			);
			manager = SettingsManager.create(projectDir, agentDir);
			expect(() => manager.getStreamIdleTimeoutMs()).toThrow(`exceeds maximum ${MAX_STREAM_IDLE_TIMEOUT_MS}`);
		});
	});

	describe("cacheWarming", () => {
		it("defaults to streaming and ignores project settings", () => {
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("streaming");

			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("streaming");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "idle" }));
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("idle");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ cacheWarming: "bogus" }));
			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("streaming");
		});

		it("persists the mode globally", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setCacheWarmingMode("off");
			await manager.flush();

			expect(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode()).toBe("off");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toEqual({ cacheWarming: "off" });
		});
	});

	describe("externalEditor", () => {
		const originalVisual = process.env.VISUAL;
		const originalEditor = process.env.EDITOR;
		const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

		function setEditorEnv(visual?: string, editor?: string): void {
			if (visual === undefined) delete process.env.VISUAL;
			else process.env.VISUAL = visual;
			if (editor === undefined) delete process.env.EDITOR;
			else process.env.EDITOR = editor;
		}

		afterEach(() => {
			setEditorEnv(originalVisual, originalEditor);
			if (originalPlatform) {
				Object.defineProperty(process, "platform", originalPlatform);
			}
		});

		it("should resolve editor commands by precedence", () => {
			setEditorEnv("vim", "nano");
			expect(SettingsManager.inMemory({ externalEditor: "code --wait" }).getExternalEditorCommand()).toBe(
				"code --wait",
			);
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("vim");

			setEditorEnv(undefined, "emacs");
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("emacs");
		});

		it("should fall back to platform defaults", () => {
			setEditorEnv();
			Object.defineProperty(process, "platform", { value: "win32" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("notepad");

			Object.defineProperty(process, "platform", { value: "darwin" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");

			Object.defineProperty(process, "platform", { value: "linux" });
			expect(SettingsManager.inMemory().getExternalEditorCommand()).toBe("nano");
		});
	});

	describe("serviceTier", () => {
		it("defaults to standard processing and persists valid tiers", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getServiceTier()).toBe("default");

			manager.setServiceTier("fast");
			await manager.flush();

			expect(manager.getServiceTier()).toBe("fast");
			expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).serviceTier).toBe("fast");
		});

		it("persists an explicit ultrafast tier", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setServiceTier("ultrafast");
			await manager.flush();

			expect(SettingsManager.create(projectDir, agentDir).getServiceTier()).toBe("ultrafast");
		});

		it("falls back to default for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ serviceTier: "priority" }));
			expect(SettingsManager.create(projectDir, agentDir).getServiceTier()).toBe("default");
		});

		it("keeps explicit fast aliases fast when the default tier is standard", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getServiceTierForModel("example-medium-fast")).toBe("fast");
			expect(manager.getServiceTierForModel("example-medium")).toBe("default");
		});
	});

	describe("compaction model", () => {
		let previousTuiMode: string | undefined;
		let previousContextBudget: string | undefined;

		beforeEach(() => {
			previousTuiMode = process.env.PI_TUI_MODE;
			previousContextBudget = process.env.PI_CONTEXT_BUDGET;
			process.env.PI_TUI_MODE = "1";
			delete process.env.PI_CONTEXT_BUDGET;
		});

		afterEach(() => {
			if (previousTuiMode === undefined) delete process.env.PI_TUI_MODE;
			else process.env.PI_TUI_MODE = previousTuiMode;
			if (previousContextBudget === undefined) delete process.env.PI_CONTEXT_BUDGET;
			else process.env.PI_CONTEXT_BUDGET = previousContextBudget;
		});

		it("prefers an explicit model", () => {
			const manager = SettingsManager.inMemory({ compaction: { model: "openai/gpt-5:low" } });

			expect(manager.getCompactionModel("anthropic")).toBe("openai/gpt-5:low");
		});

		it("defaults to Anthropic Sonnet 5 at low thinking in TUI mode", () => {
			const manager = SettingsManager.inMemory();

			expect(manager.getCompactionModel("anthropic")).toBe("anthropic/claude-sonnet-5:low");
		});

		it("defaults to gateway Sonnet at low thinking for other providers in TUI mode", () => {
			const manager = SettingsManager.inMemory();

			expect(manager.getCompactionModel("openai")).toBeUndefined();
		});

		it("keeps the unset model undefined when context-aware compaction is off", () => {
			delete process.env.PI_TUI_MODE;
			delete process.env.PI_CONTEXT_BUDGET;
			const manager = SettingsManager.inMemory();

			expect(manager.getCompactionModel("anthropic")).toBeUndefined();
		});
	});

	describe("TUI mode", () => {
		it("defaults to fullscreen and persists regular mode", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("fullscreen");

			manager.setTuiMode("regular");
			await manager.flush();

			expect(manager.getTuiMode()).toBe("regular");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.tuiMode).toBe("regular");
		});

		it("falls back to fullscreen for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ tuiMode: "other" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getTuiMode()).toBe("fullscreen");
		});

		it("reads the legacy uiMode setting as a fallback (phi)", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ uiMode: "regular" }));
			expect(SettingsManager.create(projectDir, agentDir).getTuiMode()).toBe("regular");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ uiMode: "fullscreen" }));
			expect(SettingsManager.create(projectDir, agentDir).getTuiMode()).toBe("fullscreen");

			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ uiMode: "regular", tuiMode: "fullscreen" }));
			expect(SettingsManager.create(projectDir, agentDir).getTuiMode()).toBe("fullscreen");
		});
	});

	it("validates and persists fullscreen settings", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreenExitOutput()).toBe("transcript");
		expect(manager.getFullscreenScrollbar()).toBe("auto");
		expect(manager.getFullscreenCopyOnSelect()).toBe(true);

		manager.setFullscreenExitOutput("resume-hint");
		manager.setFullscreenScrollbar("hidden");
		manager.setFullscreenCopyOnSelect(false);
		await manager.flush();
		const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(savedSettings.fullscreenExitOutput).toBe("resume-hint");
		expect(savedSettings.fullscreenScrollbar).toBe("hidden");
		expect(savedSettings.fullscreenCopyOnSelect).toBe(false);

		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ fullscreenExitOutput: "nothing", fullscreenScrollbar: "sometimes" }),
		);
		const reloadedManager = SettingsManager.create(projectDir, agentDir);
		expect(reloadedManager.getFullscreenExitOutput()).toBe("transcript");
		expect(reloadedManager.getFullscreenScrollbar()).toBe("auto");
		expect(reloadedManager.getFullscreenCopyOnSelect()).toBe(true);
	});

	// #9758: wheel scrolling defaults to auto, persists line counts, and ignores invalid values.
	it("persists fullscreen wheel scroll lines", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getFullscreenWheelScrollLines()).toBe("auto");

		manager.setFullscreenWheelScrollLines(3);
		await manager.flush();
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).fullscreenWheelScrollLines).toBe(3);

		// The setter clamps before persisting (phi: the /settings row writes through it).
		manager.setFullscreenWheelScrollLines(0);
		await manager.flush();
		expect(manager.getFullscreenWheelScrollLines()).toBe(1);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).fullscreenWheelScrollLines).toBe(1);

		manager.setFullscreenWheelScrollLines(250.9);
		await manager.flush();
		expect(manager.getFullscreenWheelScrollLines()).toBe(100);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8")).fullscreenWheelScrollLines).toBe(100);

		for (const [value, expected] of [
			[7.9, 7],
			[0, 1],
			[1000, 100],
			["fast", "auto"],
			[null, "auto"],
		] as const) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ fullscreenWheelScrollLines: value }));
			expect(SettingsManager.create(projectDir, agentDir).getFullscreenWheelScrollLines()).toBe(expected);
		}
	});

	describe("outputPad", () => {
		it("should default to 1 and persist binary values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOutputPad()).toBe(1);

			manager.setOutputPad(0);
			await manager.flush();

			expect(manager.getOutputPad()).toBe(0);
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.outputPad).toBe(0);
		});

		it("should treat unsupported outputPad values as default padding", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ outputPad: 2 }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getOutputPad()).toBe(1);
		});
	});

	describe("markdown.mermaid", () => {
		it("defaults to streaming and persists rendering modes", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getMermaidRenderingMode()).toBe("streaming");

			manager.setMermaidRenderingMode("final");
			await manager.flush();

			expect(manager.getMermaidRenderingMode()).toBe("final");
			const savedSettings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(savedSettings.markdown.mermaid).toBe("final");
		});

		it("falls back to streaming for unsupported values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ markdown: { mermaid: "sometimes" } }));

			expect(SettingsManager.create(projectDir, agentDir).getMermaidRenderingMode()).toBe("streaming");
		});
	});

	describe("shellCommandPrefix", () => {
		it("should load shellCommandPrefix from settings", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBe("shopt -s expand_aliases");
		});

		it("should return undefined when shellCommandPrefix is not set", () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

			const manager = SettingsManager.create(projectDir, agentDir);

			expect(manager.getShellCommandPrefix()).toBeUndefined();
		});

		it("should preserve shellCommandPrefix when saving unrelated settings", async () => {
			const settingsPath = join(agentDir, "settings.json");
			writeFileSync(settingsPath, JSON.stringify({ shellCommandPrefix: "shopt -s expand_aliases" }));

			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setTheme("light");
			await manager.flush();

			const savedSettings = JSON.parse(readFileSync(settingsPath, "utf-8"));
			expect(savedSettings.shellCommandPrefix).toBe("shopt -s expand_aliases");
			expect(savedSettings.theme).toBe("light");
		});
	});

	describe("defaultTools", () => {
		it("loads global defaults and lets project settings replace them", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read", "bash"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["read", "bash"]);

			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["grep"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual(["grep"]);
		});

		it("preserves an empty tool list", () => {
			expect(SettingsManager.inMemory({ defaultTools: [] }).getDefaultTools()).toEqual([]);
			expect(SettingsManager.inMemory().getDefaultTools()).toBeUndefined();
		});

		it("applies +name and -name to the default selection", () => {
			expect(SettingsManager.inMemory({ defaultTools: ["+codemode", "-write"] }).getDefaultTools()).toEqual([
				"read",
				"bash",
				"edit",
				"codemode",
			]);
			expect(SettingsManager.inMemory({ defaultTools: ["read", "+grep", "+read"] }).getDefaultTools()).toEqual([
				"read",
				"grep",
			]);
		});

		it("layers project modifiers on top of the global selection", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultTools: ["read", "bash", "+codemode"] }),
			);
			writeFileSync(
				join(projectDir, ".pi", "settings.json"),
				JSON.stringify({ defaultTools: ["-codemode", "+tool_search"] }),
			);

			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getDefaultTools()).toEqual(["read", "bash", "tool_search"]);

			manager.applyOverrides({ defaultTools: ["+codemode"] });
			expect(manager.getDefaultTools()).toEqual(["read", "bash", "tool_search", "codemode"]);
		});

		it("applies project modifiers to the built-in defaults without a global setting", () => {
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));

			expect(SettingsManager.create(projectDir, agentDir).getDefaultTools()).toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"codemode",
			]);
		});
	});

	describe("getSessionDir", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBeUndefined();
		});

		it("should return global sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/tmp/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("/tmp/sessions");
		});

		it("should return project sessionDir, overriding global", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "/global/sessions" }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ sessionDir: "./sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe("./sessions");
		});

		it("should expand ~ in sessionDir", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ sessionDir: "~/sessions" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getSessionDir()).toBe(join(homedir(), "sessions"));
		});
	});

	describe("getShellPath", () => {
		it("should return undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBeUndefined();
		});

		it("should return an absolute shellPath unchanged", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "/bin/zsh" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe("/bin/zsh");
		});

		it("should expand ~ in shellPath", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ shellPath: "~/.local/bin/agent-shell-sandbox" }),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(join(homedir(), ".local/bin/agent-shell-sandbox"));
		});

		it("should expand a bare ~ in shellPath", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ shellPath: "~" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getShellPath()).toBe(homedir());
		});
	});

	describe("btw settings", () => {
		it("getBtwModel returns undefined when not set", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwModel()).toBeUndefined();
		});

		it("getBtwModel returns the configured model ref", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ btw: { model: "gateway/example-medium" } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwModel()).toBe("gateway/example-medium");
		});

		it("getBtwPersist defaults to true", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwPersist()).toBe(true);
		});

		it("getBtwPersist returns false when explicitly disabled", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ btw: { persist: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwPersist()).toBe(false);
		});

		it("getBtwMaxHistory defaults to 20", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwMaxHistory()).toBe(20);
		});

		it("getBtwMaxHistory returns configured value", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ btw: { maxHistory: 5 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwMaxHistory()).toBe(5);
		});

		it("getBtwMaxHistory clamps to 1 at minimum", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ btw: { maxHistory: 0 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwMaxHistory()).toBe(1);
		});

		it("getBtwMaxHistory clamps to 100 at maximum", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ btw: { maxHistory: 999 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getBtwMaxHistory()).toBe(100);
		});

		it("setBtwModel persists to settings file", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ theme: "dark" }));
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setBtwModel("gateway/example-medium:medium");
			await manager.flush();
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.btw.model).toBe("gateway/example-medium:medium");
			expect(saved.theme).toBe("dark"); // preserved
		});

		it("setBtwPersist persists to settings file", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setBtwPersist(false);
			await manager.flush();
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.btw.persist).toBe(false);
		});

		it("setBtwMaxHistory clamps and persists", async () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({}));
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setBtwMaxHistory(50);
			await manager.flush();
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.btw.maxHistory).toBe(50);
		});

		it("btw settings merge with project overrides", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ btw: { model: "anthropic/claude-opus", persist: true } }),
			);
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ btw: { persist: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			// Project overrides persist, global model is preserved
			expect(manager.getBtwPersist()).toBe(false);
			expect(manager.getBtwModel()).toBe("anthropic/claude-opus");
		});
	});

	describe("loop settings", () => {
		it("returns defaults when unset", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getLoopMaxIterations()).toBe(12);
			expect(manager.getLoopMaxWallTimeMs()).toBe(7_200_000);
			expect(manager.getLoopMaxCostUsd()).toBeUndefined();
			expect(manager.getLoopCheckTimeoutMs()).toBe(600_000);
			expect(manager.getLoopEvaluatorModel()).toBeUndefined();
			expect(manager.getLoopEvaluatorConfidence()).toBe(0.85);
			expect(manager.getLoopMaxCheckOutputBytes()).toBe(65_536);
		});

		it("respects explicit values", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					loop: {
						maxIterations: 8,
						maxWallTimeMs: 30_000,
						maxCostUsd: 2.5,
						checkTimeoutMs: 15_000,
						evaluatorModel: "openai/gpt-5",
						evaluatorConfidence: 0.9,
						maxCheckOutputBytes: 32_768,
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getLoopMaxIterations()).toBe(8);
			expect(manager.getLoopMaxWallTimeMs()).toBe(30_000);
			expect(manager.getLoopMaxCostUsd()).toBe(2.5);
			expect(manager.getLoopCheckTimeoutMs()).toBe(15_000);
			expect(manager.getLoopEvaluatorModel()).toBe("openai/gpt-5");
			expect(manager.getLoopEvaluatorConfidence()).toBe(0.9);
			expect(manager.getLoopMaxCheckOutputBytes()).toBe(32_768);
		});

		it("clamps iteration and wall-time values while leaving cost uncapped", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					loop: {
						maxIterations: 500,
						maxWallTimeMs: 100_000_000,
						maxCostUsd: 1000,
						checkTimeoutMs: 100_000_000,
						evaluatorConfidence: 2,
						maxCheckOutputBytes: 2_000_000,
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getLoopMaxIterations()).toBe(100);
			expect(manager.getLoopMaxWallTimeMs()).toBe(86_400_000);
			expect(manager.getLoopMaxCostUsd()).toBe(1000);
			expect(manager.getLoopCheckTimeoutMs()).toBe(86_400_000);
			expect(manager.getLoopEvaluatorConfidence()).toBe(1);
			expect(manager.getLoopMaxCheckOutputBytes()).toBe(1_048_576);
		});

		it("falls back to defaults for invalid types", () => {
			writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({
					loop: {
						maxIterations: "many",
						maxWallTimeMs: null,
						maxCostUsd: "ten",
						checkTimeoutMs: {},
						evaluatorModel: 42,
						evaluatorConfidence: false,
						maxCheckOutputBytes: [],
					},
				}),
			);
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getLoopMaxIterations()).toBe(12);
			expect(manager.getLoopMaxWallTimeMs()).toBe(7_200_000);
			expect(manager.getLoopMaxCostUsd()).toBeUndefined();
			expect(manager.getLoopCheckTimeoutMs()).toBe(600_000);
			expect(manager.getLoopEvaluatorModel()).toBeUndefined();
			expect(manager.getLoopEvaluatorConfidence()).toBe(0.85);
			expect(manager.getLoopMaxCheckOutputBytes()).toBe(65_536);
		});

		it("merges project values over global values", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ loop: { maxIterations: 20, maxCostUsd: 5 } }));
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ loop: { maxIterations: 4 } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getLoopMaxIterations()).toBe(4);
			expect(manager.getLoopMaxCostUsd()).toBe(5);
		});

		it("persists setter values", async () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setLoopMaxIterations(7);
			manager.setLoopEvaluatorModel("openai/gpt-5");
			await manager.flush();
			const saved = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
			expect(saved.loop.maxIterations).toBe(7);
			expect(saved.loop.evaluatorModel).toBe("openai/gpt-5");
		});
	});

	describe("errorFallback", () => {
		it("defaults to enabled and non-sticky", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			const settings = manager.getErrorFallbackSettings();
			expect(settings.enabled).toBe(false);
			expect(settings.sticky).toBe(false);
			expect(settings.chain).toEqual([]);
		});

		it("honours an explicit sticky", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ errorFallback: { sticky: true } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getErrorFallbackSettings().sticky).toBe(true);
		});

		it("is off by default when a host UI owns model selection", () => {
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setHostManagedModelSelection(true);
			expect(manager.getErrorFallbackSettings().enabled).toBe(false);
		});

		it("stays on for a host UI when settings enable it explicitly", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ errorFallback: { enabled: true } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setHostManagedModelSelection(true);
			expect(manager.getErrorFallbackSettings().enabled).toBe(true);
		});

		it("stays off for a host UI when settings disable it explicitly", () => {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ errorFallback: { enabled: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setHostManagedModelSelection(true);
			expect(manager.getErrorFallbackSettings().enabled).toBe(false);
		});

		describe("PI_ERROR_FALLBACK_CHAIN", () => {
			afterEach(() => {
				delete process.env.PI_ERROR_FALLBACK_CHAIN;
			});

			it("turns rerouting on for a host UI when the env names rungs", () => {
				// The same variable spells "off", so naming rungs is an explicit request.
				// It used to be parsed and then ignored in RPC mode, where the default is off.
				process.env.PI_ERROR_FALLBACK_CHAIN = "anthropic/claude-opus-5, anthropic/claude-sonnet-4-5";
				const manager = SettingsManager.create(projectDir, agentDir);
				manager.setHostManagedModelSelection(true);
				const settings = manager.getErrorFallbackSettings();
				expect(settings.enabled).toBe(true);
				expect(settings.chain).toEqual(["anthropic/claude-opus-5", "anthropic/claude-sonnet-4-5"]);
			});

			it("does not override an explicit settings disable", () => {
				writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ errorFallback: { enabled: false } }));
				process.env.PI_ERROR_FALLBACK_CHAIN = "anthropic/claude-opus-5";
				const manager = SettingsManager.create(projectDir, agentDir);
				expect(manager.getErrorFallbackSettings().enabled).toBe(false);
			});

			it("leaves the host-managed default alone when the env is empty", () => {
				process.env.PI_ERROR_FALLBACK_CHAIN = "  ,  ";
				const manager = SettingsManager.create(projectDir, agentDir);
				manager.setHostManagedModelSelection(true);
				expect(manager.getErrorFallbackSettings().enabled).toBe(false);
			});
		});

		it("lets a project settings.json enable rerouting for a host UI", () => {
			// Project settings out-rank the agent-level file, and "explicit" has to mean
			// explicit at whichever layer won — otherwise a repo that opts in gets the
			// host-managed default (off) because the agent-level file said nothing.
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ errorFallback: { enabled: true } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			manager.setHostManagedModelSelection(true);
			expect(manager.getErrorFallbackSettings().enabled).toBe(true);
		});

		it("lets a project settings.json disable rerouting outside a host UI", () => {
			writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({ errorFallback: { enabled: false } }));
			const manager = SettingsManager.create(projectDir, agentDir);
			expect(manager.getErrorFallbackSettings().enabled).toBe(false);
		});
	});
});
