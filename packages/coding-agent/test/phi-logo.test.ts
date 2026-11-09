import { describe, expect, it } from "vitest";
import { phiLogoLines } from "../src/modes/interactive/components/pi-logo.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

/** Expands each half-block cell back into its two square pixels. */
function pixels(lines: string[]): string[] {
	const rows: string[] = [];
	for (const line of lines) {
		const cells = Array.from(stripAnsi(line));
		rows.push(cells.map((c) => (c === "█" || c === "▀" ? "X" : ".")).join(""));
		rows.push(cells.map((c) => (c === "█" || c === "▄" ? "X" : ".")).join(""));
	}
	return rows;
}

describe("phiLogoLines", () => {
	it("draws the 5x6 block phi in half blocks", () => {
		initTheme("dark");
		expect(pixels(phiLogoLines())).toEqual(["..X..", ".XXX.", "X.X.X", "X.X.X", ".XXX.", "..X.."]);
	});

	it("uses near-white pixels on dark themes and near-black on light ones", () => {
		initTheme("dark");
		const dark = phiLogoLines()[0];
		initTheme("light");
		const light = phiLogoLines()[0];
		expect(dark).not.toEqual(light);
		expect(stripAnsi(dark)).toEqual(stripAnsi(light));
	});
});
