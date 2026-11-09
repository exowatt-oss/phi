import { describe, expect, it } from "vitest";
import { getModelCatalogBaseUrl, isSessionShareEnabled, isVersionCheckEnabled } from "../src/core/exowatt-hardening.ts";

// Every switch is read from an explicit env object so these assert the policy
// rather than whatever the machine running the suite happens to export.

describe("version check default", () => {
	it("is off with nothing set", () => {
		expect(isVersionCheckEnabled({})).toBe(false);
	});

	it("opts in with either spelling", () => {
		expect(isVersionCheckEnabled({ PHI_ENABLE_VERSION_CHECK: "1" })).toBe(true);
		expect(isVersionCheckEnabled({ PI_ENABLE_VERSION_CHECK: "true" })).toBe(true);
		expect(isVersionCheckEnabled({ PHI_ENABLE_VERSION_CHECK: "yes" })).toBe(true);
	});

	it("treats a non-flag value as off", () => {
		expect(isVersionCheckEnabled({ PHI_ENABLE_VERSION_CHECK: "0" })).toBe(false);
		expect(isVersionCheckEnabled({ PHI_ENABLE_VERSION_CHECK: "" })).toBe(false);
	});

	it("lets an explicit skip win over an opt-in", () => {
		expect(isVersionCheckEnabled({ PHI_ENABLE_VERSION_CHECK: "1", PI_SKIP_VERSION_CHECK: "1" })).toBe(false);
		expect(isVersionCheckEnabled({ PHI_ENABLE_VERSION_CHECK: "1", PHI_SKIP_VERSION_CHECK: "1" })).toBe(false);
	});
});

describe("model catalog base url", () => {
	it("is unset by default, so no overlay is attached", () => {
		expect(getModelCatalogBaseUrl({})).toBeUndefined();
	});

	it("prefers the branded spelling and falls back to the compat one", () => {
		expect(getModelCatalogBaseUrl({ PHI_MODEL_CATALOG_URL: "http://127.0.0.1:8787" })).toBe("http://127.0.0.1:8787");
		expect(getModelCatalogBaseUrl({ PI_MODEL_CATALOG_URL: "http://127.0.0.1:8787" })).toBe("http://127.0.0.1:8787");
		expect(
			getModelCatalogBaseUrl({
				PHI_MODEL_CATALOG_URL: "http://127.0.0.1:8787",
				PI_MODEL_CATALOG_URL: "http://127.0.0.1:8787",
			}),
		).toBe("http://127.0.0.1:8787");
	});
});

describe("session share", () => {
	it("is off by default", () => {
		expect(isSessionShareEnabled({})).toBe(false);
	});

	it("can be enabled deliberately", () => {
		expect(isSessionShareEnabled({ PHI_ENABLE_SHARE: "1" })).toBe(true);
		expect(isSessionShareEnabled({ PI_ENABLE_SHARE: "yes" })).toBe(true);
	});

	it("stays off for a falsy value", () => {
		expect(isSessionShareEnabled({ PHI_ENABLE_SHARE: "0" })).toBe(false);
		expect(isSessionShareEnabled({ PHI_ENABLE_SHARE: "false" })).toBe(false);
	});
});
