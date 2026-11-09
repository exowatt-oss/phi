import { afterEach, describe, expect, it } from "vitest";
import {
	CONTEXT_BUDGET_ENV,
	contextAwareCompactionEnabled,
	SOFT_CEILING_ENV,
	softCeilingTokensFromEnv,
} from "../src/core/context-aware-compaction.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { TUI_MODE_ENV } from "../src/core/tui-mode.ts";

describe("contextAwareCompactionEnabled", () => {
	it("stays off for embedders that set neither flag", () => {
		expect(contextAwareCompactionEnabled({})).toBe(false);
	});

	it("follows PI_TUI_MODE when PI_CONTEXT_BUDGET is unset", () => {
		expect(contextAwareCompactionEnabled({ [TUI_MODE_ENV]: "1" })).toBe(true);
	});

	it("lets an embedder opt in with PI_CONTEXT_BUDGET alone", () => {
		for (const value of ["1", "true", "on", "yes", " ON "]) {
			expect(contextAwareCompactionEnabled({ [CONTEXT_BUDGET_ENV]: value })).toBe(true);
		}
	});

	it("lets PI_CONTEXT_BUDGET opt a TUI session out", () => {
		for (const value of ["0", "false", "off"]) {
			expect(contextAwareCompactionEnabled({ [TUI_MODE_ENV]: "1", [CONTEXT_BUDGET_ENV]: value })).toBe(false);
		}
	});

	it("ignores unrecognized PI_CONTEXT_BUDGET values", () => {
		expect(contextAwareCompactionEnabled({ [CONTEXT_BUDGET_ENV]: "maybe" })).toBe(false);
		expect(contextAwareCompactionEnabled({ [TUI_MODE_ENV]: "1", [CONTEXT_BUDGET_ENV]: "maybe" })).toBe(true);
	});
});

describe("PI_COMPACTION_SOFT_CEILING_TOKENS", () => {
	const previous = process.env[SOFT_CEILING_ENV];
	afterEach(() => {
		if (previous === undefined) delete process.env[SOFT_CEILING_ENV];
		else process.env[SOFT_CEILING_ENV] = previous;
	});

	it("parses non-negative integers and ignores anything else", () => {
		expect(softCeilingTokensFromEnv({ [SOFT_CEILING_ENV]: "500000" })).toBe(500_000);
		expect(softCeilingTokensFromEnv({ [SOFT_CEILING_ENV]: "0" })).toBe(0);
		expect(softCeilingTokensFromEnv({})).toBeUndefined();
		for (const value of ["", "-1", "5e5", "500k", "1.5"]) {
			expect(softCeilingTokensFromEnv({ [SOFT_CEILING_ENV]: value })).toBeUndefined();
		}
	});

	it("is the default ceiling when settings do not set one", () => {
		process.env[SOFT_CEILING_ENV] = "500000";
		expect(SettingsManager.inMemory().getCompactionSoftCeilingTokens()).toBe(500_000);
		delete process.env[SOFT_CEILING_ENV];
		expect(SettingsManager.inMemory().getCompactionSoftCeilingTokens()).toBe(300_000);
	});

	it("yields to an explicit settings value", () => {
		process.env[SOFT_CEILING_ENV] = "500000";
		const settings = SettingsManager.inMemory({ compaction: { softCeilingTokens: 0 } });
		expect(settings.getCompactionSoftCeilingTokens()).toBe(0);
	});
});
