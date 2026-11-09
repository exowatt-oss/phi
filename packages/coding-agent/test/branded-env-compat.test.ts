// Exowatt fork test: the display rename to "phi" must not orphan the upstream
// PI_* environment variables. Forca (managed extensions, per-pane overlays,
// session scanning) sets PI_CODING_AGENT_DIR / PI_CODING_AGENT_SESSION_DIR, so
// both spellings have to resolve, with the branded PHI_* spelling winning.
import { homedir } from "os";
import { join } from "path";
import { afterEach, describe, expect, test } from "vitest";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	ENV_AGENT_DIR,
	ENV_SESSION_DIR,
	getAgentDir,
	getEnvAgentDir,
	getEnvSessionDir,
} from "../src/config.ts";

const MANAGED_VARS = [
	"PHI_CODING_AGENT_DIR",
	"PI_CODING_AGENT_DIR",
	"PHI_CODING_AGENT_SESSION_DIR",
	"PI_CODING_AGENT_SESSION_DIR",
] as const;

const originalEnv = new Map(MANAGED_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const [name, value] of originalEnv) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

function clearManagedVars(): void {
	for (const name of MANAGED_VARS) {
		delete process.env[name];
	}
}

describe("branding", () => {
	test("app name is phi while the config dir stays pi-shaped", () => {
		expect(APP_NAME).toBe("phi");
		expect(CONFIG_DIR_NAME).toBe(".pi");
	});

	test("env var names are derived from the branded app name", () => {
		expect(ENV_AGENT_DIR).toBe("PHI_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("PHI_CODING_AGENT_SESSION_DIR");
	});
});

describe("PI_* environment compatibility", () => {
	test("agent dir falls back to the upstream PI_ spelling", () => {
		clearManagedVars();
		process.env.PI_CODING_AGENT_DIR = "/tmp/compat-agent-dir";
		expect(getEnvAgentDir()).toBe("/tmp/compat-agent-dir");
		expect(getAgentDir()).toBe("/tmp/compat-agent-dir");
	});

	test("session dir falls back to the upstream PI_ spelling", () => {
		clearManagedVars();
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/compat-session-dir";
		expect(getEnvSessionDir()).toBe("/tmp/compat-session-dir");
	});

	test("branded PHI_ spelling wins when both are set", () => {
		clearManagedVars();
		process.env.PI_CODING_AGENT_DIR = "/tmp/compat-agent-dir";
		process.env.PHI_CODING_AGENT_DIR = "/tmp/branded-agent-dir";
		process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/compat-session-dir";
		process.env.PHI_CODING_AGENT_SESSION_DIR = "/tmp/branded-session-dir";
		expect(getEnvAgentDir()).toBe("/tmp/branded-agent-dir");
		expect(getEnvSessionDir()).toBe("/tmp/branded-session-dir");
	});

	test("neither set resolves to the default ~/.pi/agent", () => {
		clearManagedVars();
		expect(getEnvAgentDir()).toBeUndefined();
		expect(getEnvSessionDir()).toBeUndefined();
		expect(getAgentDir()).toBe(join(homedir(), CONFIG_DIR_NAME, "agent"));
	});
});
