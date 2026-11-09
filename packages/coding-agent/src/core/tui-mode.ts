/**
 * `PI_TUI_MODE` — the human reads phi's own terminal UI, not an embedding chat UI.
 *
 * The `loop_control` tool description defaults to embedding chat UIs (such as P3 Code),
 * which fold assistant text written before the last tool call. In terminal mode its
 * description instead tells the model to put the iteration result in its final message.
 * Workspace-state classification also uses this flag to render an awaiting-human question
 * as a visible `Waiting on you: …` line in phi's TUI.
 *
 * Off by default so embedders keep their current behavior. A terminal user
 * (Forca pane, plain shell) sets `PI_TUI_MODE=1`. The loop tool reads the flag at
 * registration; workspace state reads it when rendering a settled turn.
 */
export const TUI_MODE_ENV = "PI_TUI_MODE";

const ENABLED_VALUES = new Set(["1", "true", "on", "yes"]);

export function isTuiMode(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[TUI_MODE_ENV];
	if (raw === undefined) return false;
	return ENABLED_VALUES.has(raw.trim().toLowerCase());
}
