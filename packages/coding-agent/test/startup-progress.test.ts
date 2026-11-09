import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	StartupProgressComponent,
	type StartupProgressStage,
} from "../src/modes/interactive/components/startup-progress.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("StartupProgressComponent", () => {
	const components = new Set<StartupProgressComponent>();

	beforeEach(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const component of components) component.dispose();
		components.clear();
		vi.useRealTimers();
	});

	function createComponent(stage: StartupProgressStage = { current: 1, total: 4, message: "Loading models" }) {
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const component = new StartupProgressComponent(tui, stage);
		components.add(component);
		return { component, tui };
	}

	it("renders the title, animated spinner, stage message, and textual progress", () => {
		const { component } = createComponent({ current: 2, total: 4, message: "Loading models" });

		const output = stripAnsi(component.render(80).join("\n"));

		expect(output).toContain("Starting phi");
		expect(output).toContain("Loading models");
		expect(output).toContain("2/4");
		expect(output).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
	});

	it("updates the message and count when the stage changes", () => {
		const { component } = createComponent();

		component.setStage({ current: 3, total: 5, message: "Reading project files" });
		const output = stripAnsi(component.render(80).join("\n"));

		expect(output).toContain("Reading project files");
		expect(output).toContain("3/5");
		expect(output).not.toContain("Loading models");
	});

	it("shows completed work in the bar while the count names the active stage", () => {
		const { component } = createComponent({ current: 6, total: 6, message: "Finishing" });
		const progressLine = stripAnsi(component.render(20).at(-1) ?? "");

		expect(progressLine).toMatch(/^\[━{11}─{3}\] 6\/6$/);
	});

	it.each([1, 2, 3, 8, 24, 80])("keeps every line within a %d-column terminal", (width) => {
		const { component } = createComponent({
			current: 7,
			total: 12,
			message: "Loading a particularly long stage message",
		});

		const lines = component.render(width);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});

	it("defensively clamps malformed stage counts", () => {
		const { component } = createComponent();

		component.setStage({ current: -10, total: 0, message: "Recovering" });
		expect(stripAnsi(component.render(40).join("\n"))).toContain("0/1");

		component.setStage({ current: 99, total: 3, message: "Finishing" });
		expect(stripAnsi(component.render(40).join("\n"))).toContain("3/3");

		component.setStage({ current: Number.NaN, total: Number.POSITIVE_INFINITY, message: "Retrying" });
		expect(stripAnsi(component.render(40).join("\n"))).toContain("0/1");
	});

	it("ignores ordinary input and calls onCancel for literal Ctrl+C", () => {
		setKeybindings(new KeybindingsManager({ "tui.input.copy": "ctrl+x" }));
		const onCancel = vi.fn();
		const tui = { requestRender: vi.fn() } as unknown as TUI;
		const component = new StartupProgressComponent(tui, { current: 1, total: 2, message: "Starting" }, onCancel);
		components.add(component);

		component.handleInput("a");
		component.handleInput("@");
		component.handleInput("\x18");
		expect(onCancel).not.toHaveBeenCalled();

		component.handleInput("\x03");
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it("stops spinner timer on dispose", () => {
		vi.useFakeTimers();
		const { component, tui } = createComponent();
		const callsBeforeDispose = (tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length;

		component.dispose();
		component.dispose();
		vi.advanceTimersByTime(500);

		expect((tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBeforeDispose);
	});
});
