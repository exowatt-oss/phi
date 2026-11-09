import { describe, expect, it } from "vitest";
import { describeJsonShape } from "../src/core/tools/render-utils.ts";

describe("describeJsonShape", () => {
	it("summarizes an object by its top-level keys", () => {
		expect(describeJsonShape('{"a":1,"b":2}')).toBe("{a, b}");
	});

	it("calls out the first top-level array and its length", () => {
		const payload = JSON.stringify({ registry_path: "/var/lib/x.db", candidates: [1, 2, 3], count: 3 });
		expect(describeJsonShape(payload)).toBe("{registry_path, candidates, count} · candidates[3]");
	});

	it("caps the key list and reports the overflow", () => {
		const payload = JSON.stringify({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
		expect(describeJsonShape(payload)).toBe("{a, b, c, d, +2}");
	});

	it("counts a top-level array", () => {
		expect(describeJsonShape("[1,2,3]")).toBe("3 items");
		expect(describeJsonShape("[1]")).toBe("1 item");
	});

	it("handles an empty object", () => {
		expect(describeJsonShape("{}")).toBe("{}");
	});

	it("tolerates surrounding whitespace", () => {
		expect(describeJsonShape('\n  {"a":1}\n')).toBe("{a}");
	});

	it("returns undefined for anything that is not JSON", () => {
		expect(describeJsonShape("bd version 1.1.0")).toBeUndefined();
		// Prose that merely starts with a brace must not be parsed as a payload.
		expect(describeJsonShape("{not json at all")).toBeUndefined();
		expect(describeJsonShape("")).toBeUndefined();
		// A bare JSON scalar carries no shape worth summarizing.
		expect(describeJsonShape('"a string"')).toBeUndefined();
		expect(describeJsonShape("42")).toBeUndefined();
	});
});
