/**
 * Terminal QR codes for `phi remote pair` and the in-session `/remote` command.
 *
 * Each output character covers one module horizontally and two modules vertically, using the
 * half-block glyphs `▀ ▄ █` and space, so a version-10 code (57 modules + quiet zone) fits in
 * ~61 columns × ~31 rows.
 *
 * Polarity: a terminal draws glyphs in its foreground color and spaces in its background color.
 * By default (`background: "dark"`) the LIGHT modules and the quiet zone are drawn as glyphs and
 * the DARK modules are left as spaces. Printed on a dark terminal (light text on a dark
 * background — the common case) that is a normal dark-on-light QR code that any camera reads.
 * On a light terminal the same lines come out inverted; either pass `background: "light"`, or
 * wrap the lines with `colorizeQrLines()`, which pins an explicit light-on-black color pair so
 * the code scans whatever the terminal theme is. `phi remote pair` does the latter on a TTY.
 */

import { QrCode, type QrEcc } from "./qrcodegen.ts";

export interface QrRenderOptions {
	/** Background the lines will be printed on. Default `"dark"` (see module comment). */
	background?: "dark" | "light";
	/** Light margin around the code, in modules. Default 2 (enough for phone cameras). */
	quietZone?: number;
	/** Error correction level (raised automatically when it costs no extra size). Default `"M"`. */
	ecc?: QrEcc;
}

/** Render `text` (UTF-8, byte mode) as terminal lines of half-block characters. */
export function renderQrLines(text: string, options: QrRenderOptions = {}): string[] {
	const qr = QrCode.encodeText(text, options.ecc ?? "M");
	const quiet = Math.max(0, Math.floor(options.quietZone ?? 2));
	const drawLight = (options.background ?? "dark") === "dark";
	const total = qr.size + quiet * 2;

	// Whether module (x, y) in quiet-zone coordinates is drawn as a glyph. Rows past the bottom
	// edge (odd total) are never drawn so the last line keeps only its upper half.
	const ink = (x: number, y: number): boolean => {
		if (y >= total) return false;
		const dark = qr.getModule(x - quiet, y - quiet);
		return drawLight ? !dark : dark;
	};

	const lines: string[] = [];
	for (let y = 0; y < total; y += 2) {
		let line = "";
		for (let x = 0; x < total; x++) {
			const top = ink(x, y);
			const bottom = ink(x, y + 1);
			line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
		}
		lines.push(line);
	}
	return lines;
}

/**
 * Pin explicit colors so the code scans on any terminal theme: bright white glyphs on a black
 * background for `"dark"` polarity lines (the default), black on bright white for `"light"`.
 */
export function colorizeQrLines(lines: readonly string[], background: "dark" | "light" = "dark"): string[] {
	const on = background === "dark" ? "\x1b[97;40m" : "\x1b[30;107m";
	return lines.map((line) => `${on}${line}\x1b[0m`);
}
