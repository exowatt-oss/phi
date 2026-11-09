import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

/**
 * Point the agent dir at an empty temp dir so the Feads credential resolver never
 * reads the developer's real `~/.pi/agent/phi.env` (or `mcp.json`). Call in
 * `beforeEach`; vitest's `unstubEnvs` restores the environment after each test.
 */
export function isolateFeadsAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "phi-feads-test-"));
	vi.stubEnv(ENV_AGENT_DIR, dir);
	vi.stubEnv("PI_CODING_AGENT_DIR", dir);
	vi.stubEnv("PHI_MCP_CONFIG", undefined);
	return dir;
}
