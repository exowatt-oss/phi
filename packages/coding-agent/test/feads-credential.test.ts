import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	feadsTokenFilePath,
	parseFeadsTokenFile,
	readFeadsTokenFile,
	resolveFeadsCredential,
} from "../src/extensions/feads-agent/credential.ts";
import {
	FeadsPresencePublisher,
	formatFeadsPresenceStatus,
	getFeadsPresenceStatus,
} from "../src/extensions/feads-agent/presence-publisher.ts";
import { feadsSessionState } from "../src/extensions/feads-agent/session-state.ts";
import { isolateFeadsAgentDir } from "./feads-test-env.ts";

const FILE_TOKEN = "fdsa_example";
const FILE_LEGACY = "fdsa_example";

let agentDir: string;

beforeEach(() => {
	agentDir = isolateFeadsAgentDir();
	vi.stubEnv("FEADS_AGENT_TOKEN", undefined);
	vi.stubEnv("FEADS_TOKEN", undefined);
});

const writeTokenFile = (content: string) => writeFileSync(join(agentDir, "phi.env"), content, { mode: 0o600 });

describe("Feads credential resolver", () => {
	it("prefers FEADS_AGENT_TOKEN, then FEADS_TOKEN, before reading phi.env", () => {
		const readTokenFile = vi.fn(() => ({ canonical: FILE_TOKEN, legacy: undefined }));
		expect(
			resolveFeadsCredential({ env: { FEADS_AGENT_TOKEN: " env ", FEADS_TOKEN: "old" }, readTokenFile }),
		).toEqual({ token: "env", source: "canonical" });
		expect(resolveFeadsCredential({ env: { FEADS_AGENT_TOKEN: " ", FEADS_TOKEN: "old" }, readTokenFile })).toEqual({
			token: "old",
			source: "legacy",
		});
		expect(readTokenFile).not.toHaveBeenCalled();
		expect(resolveFeadsCredential({ env: { FEADS_AGENT_TOKEN: "", FEADS_TOKEN: "\t" }, readTokenFile })).toEqual({
			token: FILE_TOKEN,
			source: "file",
		});
	});

	it("keeps delegation canonical-only across env and file", () => {
		const readTokenFile = () => ({ canonical: undefined, legacy: FILE_LEGACY });
		expect(resolveFeadsCredential({ env: { FEADS_TOKEN: "old" }, readTokenFile, includeLegacy: false })).toEqual({
			token: undefined,
			source: "none",
		});
		expect(resolveFeadsCredential({ env: {}, readTokenFile, includeLegacy: true })).toEqual({
			token: FILE_LEGACY,
			source: "file",
		});
		expect(
			resolveFeadsCredential({
				env: { FEADS_TOKEN: "old" },
				readTokenFile: () => ({ canonical: FILE_TOKEN, legacy: undefined }),
				includeLegacy: false,
			}),
		).toEqual({ token: FILE_TOKEN, source: "file" });
	});

	it("parses plain, export, and quoted assignments; canonical wins; last assignment wins", () => {
		expect(parseFeadsTokenFile(`FEADS_AGENT_TOKEN=${FILE_TOKEN}\n`).canonical).toBe(FILE_TOKEN);
		expect(parseFeadsTokenFile(`export FEADS_AGENT_TOKEN="${FILE_TOKEN}"`).canonical).toBe(FILE_TOKEN);
		expect(parseFeadsTokenFile(`  export FEADS_AGENT_TOKEN='${FILE_TOKEN}'  \r\n`).canonical).toBe(FILE_TOKEN);
		expect(parseFeadsTokenFile(`FEADS_TOKEN=${FILE_LEGACY}`)).toEqual({ canonical: undefined, legacy: FILE_LEGACY });
		expect(parseFeadsTokenFile(`FEADS_AGENT_TOKEN=fdsa_old\nFEADS_AGENT_TOKEN=${FILE_TOKEN}`).canonical).toBe(
			FILE_TOKEN,
		);
		expect(
			resolveFeadsCredential({
				env: {},
				readTokenFile: () => parseFeadsTokenFile(`FEADS_TOKEN=${FILE_LEGACY}\nFEADS_AGENT_TOKEN=${FILE_TOKEN}`),
			}).token,
		).toBe(FILE_TOKEN);
	});

	it("rejects references, templates, and anything that is not a literal fdsa_ token", () => {
		for (const value of [
			'"op://Private/Feads/token"',
			"op://Private/Feads/token",
			"$FEADS_TOKEN",
			"$" + "{FEADS_AGENT_TOKEN}",
			"`op read op://x`",
			"$(op read x)",
			`"${FILE_TOKEN} trailing"`,
			`${FILE_TOKEN} # comment`,
			"fdsi_0123456789abcdef0123456789abcdef",
			"Bearer fdsa_0123",
			`"${FILE_TOKEN}'`,
			"",
			'""',
		]) {
			expect(parseFeadsTokenFile(`FEADS_AGENT_TOKEN=${value}`).canonical, value).toBeUndefined();
		}
		// Not an assignment of the variable itself.
		expect(parseFeadsTokenFile(`# FEADS_AGENT_TOKEN=${FILE_TOKEN}`).canonical).toBeUndefined();
		expect(parseFeadsTokenFile(`MY_FEADS_AGENT_TOKEN=${FILE_TOKEN}`).canonical).toBeUndefined();
		expect(parseFeadsTokenFile(`FEADS_AGENT_TOKEN = ${FILE_TOKEN}`).canonical).toBeUndefined();
	});

	it("reads <agentDir>/phi.env and treats a missing file as no token", () => {
		expect(feadsTokenFilePath()).toBe(join(agentDir, "phi.env"));
		expect(readFeadsTokenFile()).toEqual({ canonical: undefined, legacy: undefined });
		expect(resolveFeadsCredential()).toEqual({ token: undefined, source: "none" });
		expect(readFeadsTokenFile(join(agentDir, "missing", "phi.env"))).toEqual({
			canonical: undefined,
			legacy: undefined,
		});
		writeTokenFile(`GRAFANA_URL=https://grafana.example\nexport FEADS_AGENT_TOKEN="${FILE_TOKEN}"\n`);
		expect(resolveFeadsCredential()).toEqual({ token: FILE_TOKEN, source: "file" });
	});

	it("drives presence from phi.env and shows the source without the value", async () => {
		vi.useFakeTimers();
		try {
			writeTokenFile(`FEADS_AGENT_TOKEN=${FILE_TOKEN}\n`);
			const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
			vi.stubGlobal("fetch", fetchMock);
			vi.stubEnv("FEADS_URL", "http://feads.test");
			feadsSessionState.startSession(`file-${Math.random()}`);
			const publisher = new FeadsPresencePublisher({ debounceMs: 1 });
			publisher.publish({ v: 1, event: "subagent_update", agent: { kind: "main", status: "working" } });
			await vi.advanceTimersByTimeAsync(1);
			expect((fetchMock.mock.calls[0]?.[1] as RequestInit).headers).toEqual(
				expect.objectContaining({ Authorization: `Bearer ${FILE_TOKEN}` }),
			);
			const rendered = formatFeadsPresenceStatus(getFeadsPresenceStatus());
			expect(rendered).toContain("credential source: file (phi.env)");
			expect(rendered).not.toContain(FILE_TOKEN);
			publisher.dispose();
		} finally {
			vi.unstubAllGlobals();
			vi.useRealTimers();
		}
	});
});
