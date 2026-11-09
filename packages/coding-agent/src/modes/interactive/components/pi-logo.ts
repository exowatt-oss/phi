import { backgroundAnsi, foregroundAnsi, isAppleTerminalSession, rgbColor } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

const CORAL = rgbColor(228, 138, 122);
const BLUE = rgbColor(79, 142, 179);
const YELLOW = rgbColor(234, 182, 93);
const RESET = "\x1b[0m";

/**
 * The pi logo: 4 cells wide and 2 lines tall. Each cell shows two square pixels with half blocks:
 *
 *   coral coral coral .
 *   blue  .     coral .
 *   blue  blue  .     yellow
 *   blue  .     .     yellow
 *
 * The brand colors stay fixed across themes; they follow the terminal's color mode.
 */
export function piLogoLines(): [string, string] {
	const mode = theme.getColorMode();
	const fg = (color: typeof CORAL) => foregroundAnsi(color, mode);
	// The fourth cell of the top line is empty, so it is padded to the same width as the bottom line.
	const top = `${fg(CORAL)}${backgroundAnsi(BLUE, mode)}▀${RESET}${fg(CORAL)}▀█${RESET} `;
	const bottom = `${fg(BLUE)}█▀${RESET} ${fg(YELLOW)}█${RESET}`;
	return [top, bottom];
}

// phi logo, a Greek phi from the same square pixels, 5 cells wide and 3 lines tall:
//
//   . . X . .
//   . X X X .
//   X . X . X
//   X . X . X
//   . X X X .
//   . . X . .
//
// Plain near-white on dark terminals and near-black on light ones, like the P3 icon; no brand colors.
const PHI_LOGO = [" ▄█▄ ", "█ █ █", " ▀█▀ "] as const;
const PHI_LIGHT = rgbColor(245, 245, 245);
const PHI_DARK = rgbColor(15, 15, 15);

export function phiLogoLines(): [string, string, string] {
	const color = theme.appearance === "light" ? PHI_DARK : PHI_LIGHT;
	const fg = foregroundAnsi(color, theme.getColorMode());
	const [top, middle, bottom] = PHI_LOGO;
	return [`${fg}${top}${RESET}`, `${fg}${middle}${RESET}`, `${fg}${bottom}${RESET}`];
}

/**
 * Whether the terminal renders the half-block logo correctly. Apple Terminal draws gaps between rows and
 * misaligns the half blocks, so it gets the text wordmark instead.
 */
export function supportsPiLogo(): boolean {
	return !isAppleTerminalSession();
}

/** Text fallback for the logo: "Pi" with the logo's coral and yellow. */
export function piWordmark(): string {
	const mode = theme.getColorMode();
	return `${foregroundAnsi(CORAL, mode)}P${RESET}${foregroundAnsi(YELLOW, mode)}i${RESET}`;
}
