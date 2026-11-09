import assert from "node:assert/strict";
import { test } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Terminal } from "../src/terminal.ts";
import { Container } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

// Regression: keyboard input renders through TuiBase.requestImmediateRender(), which
// bypassed TuiAltScreen.requestRender() and so never dropped the persistent layout
// render cache. In fullscreen mode every keystroke frame reused the editor's stale
// lines and typed text stayed invisible until something else requested a render.
test("fullscreen editor shows each typed character without any other render request", async () => {
	const terminal = new VirtualTerminal(60, 12);
	const tui = new TuiAltScreen(terminal as Terminal, undefined, undefined, { jumpToBottom: { enabled: false } });
	const transcript = new Container();
	transcript.addChild(new Text("transcript line", 0, 0));
	const editor = new Editor(tui, defaultEditorTheme);
	tui.setLayoutRoot(
		new VStack([
			{
				component: new ScrollView(transcript, { follow: "end", primary: true }),
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 1,
			},
			{ component: editor, basis: "auto", grow: 0, shrink: 1, minSize: 3 },
		]),
	);
	tui.setFocus(editor);
	tui.start();
	try {
		await terminal.waitForRender();

		const typed = "hello world";
		for (let index = 0; index < typed.length; index++) {
			terminal.sendInput(typed[index]!);
			await terminal.waitForRender();
			const expected = typed.slice(0, index + 1);
			const screen = terminal.getViewport().join("\n");
			assert.ok(
				screen.includes(expected),
				`after typing ${JSON.stringify(expected)} the screen should show it:\n${screen}`,
			);
		}
	} finally {
		tui.stop();
	}
});
