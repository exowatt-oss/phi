/**
 * Encode a resolved cwd into a safe directory-name segment.
 *
 * Extracted from session-manager so that sessions/ and memory/ share one
 * encoding: both derive their per-project subdirectory from the same rule.
 */
export function projectDirName(resolvedCwd: string): string {
	return `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}
