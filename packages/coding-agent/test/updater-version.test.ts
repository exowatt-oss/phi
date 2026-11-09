import { describe, expect, it } from "vitest";
import { isDifferentRelease, type PhiRelease } from "../src/extensions/updater/version.ts";

function release(releaseId: string, version = releaseId.slice(0, releaseId.indexOf("+"))): PhiRelease {
	const sha = /\+([0-9a-f]{12})/i.exec(releaseId)?.[1] ?? "a".repeat(12);
	return {
		version,
		releaseId,
		commit: `${sha}${"0".repeat(28)}`,
		publishedAt: "2026-08-03T00:00:00Z",
		installer: "phi-install.sh",
	};
}

describe("isDifferentRelease", () => {
	it("orders fork releases after their upstream base version", () => {
		expect(
			isDifferentRelease(release("0.83.0+aaaaaaaaaaaa.r100.1"), release("0.83.0-exo.1+bbbbbbbbbbbb.r101.1")),
		).toBe(true);
		expect(
			isDifferentRelease(release("0.83.0-exo.1+aaaaaaaaaaaa.r101.1"), release("0.83.0+bbbbbbbbbbbb.r100.1")),
		).toBe(false);
		expect(
			isDifferentRelease(release("0.83.0-exo.1+aaaaaaaaaaaa.r100.1"), release("0.83.0-exo.2+bbbbbbbbbbbb.r101.1")),
		).toBe(true);
	});

	it("preserves SemVer ordering for other prereleases", () => {
		expect(
			isDifferentRelease(
				release("0.84.0-beta.2+aaaaaaaaaaaa.r100.1"),
				release("0.84.0-beta.10+bbbbbbbbbbbb.r101.1"),
			),
		).toBe(true);
		expect(
			isDifferentRelease(
				release("0.84.0-beta.10+aaaaaaaaaaaa.r101.1"),
				release("0.84.0-beta.2+bbbbbbbbbbbb.r100.1"),
			),
		).toBe(false);
	});

	it("rejects an older package version", () => {
		expect(
			isDifferentRelease(release("0.84.0-exo.1+aaaaaaaaaaaa.r101.1"), release("0.83.0-exo.1+bbbbbbbbbbbb.r100.1")),
		).toBe(false);
	});

	it("orders same-version builds by workflow run and attempt", () => {
		const current = release("0.83.0-exo.1+aaaaaaaaaaaa.r100.1");
		expect(isDifferentRelease(current, release("0.83.0-exo.1+bbbbbbbbbbbb.r101.1"))).toBe(true);
		expect(isDifferentRelease(current, release("0.83.0-exo.1+bbbbbbbbbbbb.r99.1"))).toBe(false);
		expect(isDifferentRelease(current, release("0.83.0-exo.1+bbbbbbbbbbbb.r100.2"))).toBe(true);
		expect(isDifferentRelease(current, release("0.83.0-exo.1+bbbbbbbbbbbb.r100.0"))).toBe(false);
	});

	it("rejects contradictory version and workflow chronology", () => {
		expect(
			isDifferentRelease(release("0.83.0-exo.1+aaaaaaaaaaaa.r101.1"), release("0.84.0+bbbbbbbbbbbb.r100.1")),
		).toBe(false);
	});

	it("does not treat the same or ambiguously ordered release as newer", () => {
		const current = release("0.83.0-exo.1+aaaaaaaaaaaa.r100.1");
		expect(isDifferentRelease(current, current)).toBe(false);
		expect(isDifferentRelease(undefined, current)).toBe(false);
		expect(isDifferentRelease(current, release("0.83.0-exo.1+bbbbbbbbbbbb.r100.1"))).toBe(false);
	});

	it("supports safe migration from legacy release IDs", () => {
		expect(isDifferentRelease(release("0.83.0+aaaaaaaaaaaa"), release("0.83.0-exo.1+bbbbbbbbbbbb.r101.1"))).toBe(
			true,
		);
		expect(
			isDifferentRelease(release("0.83.0-exo.1+aaaaaaaaaaaa"), release("0.83.0-exo.1+bbbbbbbbbbbb.r101.1")),
		).toBe(false);
		expect(isDifferentRelease(release("0.83.0-exo.1+aaaaaaaaaaaa.r100.1"), release("0.84.0+bbbbbbbbbbbb"))).toBe(
			false,
		);
	});

	it.each([
		["using a non-semver version", "0.83-exo.1+aaaaaaaaaaaa.r101.1"],
		["using a short SHA", "0.83.0-exo.1+aaaaaaaaaaa.r101.1"],
		["using a non-hex SHA", "0.83.0-exo.1+not-a-sha12.r101.1"],
		["using a non-numeric run", "0.83.0-exo.1+aaaaaaaaaaaa.rone.1"],
		["using a non-numeric attempt", "0.83.0-exo.1+aaaaaaaaaaaa.r101.one"],
	] as const)("rejects a release ID $0", (_label, malformedReleaseId) => {
		const current = release("0.83.0-exo.1+aaaaaaaaaaaa.r100.1");
		expect(isDifferentRelease(current, release(malformedReleaseId))).toBe(false);
	});

	it("rejects inconsistent version and commit metadata", () => {
		const current = release("0.83.0-exo.1+aaaaaaaaaaaa.r100.1");
		expect(isDifferentRelease(current, release("0.84.0-exo.1+bbbbbbbbbbbb.r101.1", "0.83.0-exo.1"))).toBe(false);
		expect(
			isDifferentRelease({ ...current, version: "not-semver" }, release("0.84.0-exo.1+bbbbbbbbbbbb.r101.1")),
		).toBe(false);
		expect(
			isDifferentRelease(current, { ...release("0.84.0-exo.1+bbbbbbbbbbbb.r101.1"), commit: "c".repeat(40) }),
		).toBe(false);
	});
});
