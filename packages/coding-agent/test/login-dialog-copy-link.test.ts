import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { LoginDialogComponent } from "../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import { copyToClipboard } from "../src/utils/clipboard.ts";
import { openBrowser } from "../src/utils/open-browser.ts";

vi.mock("../src/utils/open-browser.ts", () => ({ openBrowser: vi.fn() }));
vi.mock("../src/utils/clipboard.ts", () => ({ copyToClipboard: vi.fn(async () => {}) }));

const AUTO_URL = "https://claude.ai/oauth/authorize?redirect_uri=http://localhost:53692/callback";
const COPY_URL = "https://claude.ai/oauth/authorize?redirect_uri=https://platform.claude.com/oauth/code/callback";

function createDialog(): LoginDialogComponent {
	return new LoginDialogComponent({ requestRender: vi.fn() } as unknown as TUI, "anthropic", () => {}, "Anthropic");
}

describe("LoginDialogComponent copy link", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
		vi.mocked(copyToClipboard).mockClear();
	});

	test("opens the auto URL, shows the copy URL, and c copies it while the code field is empty", async () => {
		const dialog = createDialog();
		dialog.showAuth(AUTO_URL, undefined, COPY_URL);
		const code = dialog.showManualInput("Paste the authorization code here:");

		expect(openBrowser).toHaveBeenCalledWith(AUTO_URL);
		expect(stripAnsi(dialog.render(400).join("\n"))).toContain(COPY_URL);

		dialog.handleInput("c");
		expect(copyToClipboard).toHaveBeenCalledWith(COPY_URL);
		await vi.waitFor(() => expect(stripAnsi(dialog.render(200).join("\n"))).toContain("Link copied"));

		// Once a code is being typed, "c" is just a character.
		dialog.handleInput("x");
		dialog.handleInput("c");
		dialog.handleInput("\n");
		await expect(code).resolves.toBe("xc");
		expect(copyToClipboard).toHaveBeenCalledOnce();
	});
});
