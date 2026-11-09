/**
 * `/remote` output: the pairing card (QR + code + URLs) and the paired-device list. A plain panel
 * in place of the editor; any key closes it. In RPC mode, a one-line notification instead.
 */

import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { DeviceInfo, PairInfo } from "../../remote/protocol.ts";

type Line = string | { qr: string };

class Panel implements Component {
	private readonly lines: (width: number) => Line[];
	private readonly close: () => void;

	constructor(lines: (width: number) => Line[], close: () => void) {
		this.lines = lines;
		this.close = close;
	}

	render(width: number): string[] {
		const out: string[] = [""];
		for (const line of this.lines(width)) {
			// QR rows are never truncated (a clipped code does not scan); lines() only emits them when they fit.
			out.push(typeof line === "string" ? truncateToWidth(` ${line}`, width, "") : ` ${line.qr}`);
		}
		out.push("");
		return out;
	}

	handleInput(): void {
		this.close();
	}

	invalidate(): void {}
}

async function qrLines(text: string): Promise<string[] | undefined> {
	try {
		const module = await import("../../remote/qr.ts");
		const lines = module.renderQrLines(text);
		if (!Array.isArray(lines) || lines.length === 0) return undefined;
		// Explicit colors, so the code scans on light and dark terminal themes alike.
		return typeof module.colorizeQrLines === "function" ? module.colorizeQrLines(lines) : lines;
	} catch {
		return undefined;
	}
}

function clock(ms: number): string {
	return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function ago(ms: number): string {
	const minutes = Math.max(0, Math.round((Date.now() - ms) / 60_000));
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} h ago`;
	return `${Math.round(hours / 24)} d ago`;
}

export async function showPairing(ctx: ExtensionCommandContext, info: PairInfo): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(`phi remote pairing code ${info.code} (expires ${clock(info.expiresAt)}): ${info.link}`, "info");
		return;
	}
	const qr = await qrLines(info.link);
	await ctx.ui.custom<void>((_tui, theme: Theme, _keybindings, done) => {
		let closed = false;
		const close = () => {
			if (closed) return;
			closed = true;
			clearTimeout(expiry);
			done();
		};
		// The code is single use with a short TTL; the card goes away when it can no longer work.
		const expiry = setTimeout(close, Math.max(0, info.expiresAt - Date.now()));
		expiry.unref?.();
		const label = (text: string) => theme.fg("dim", text.padEnd(9));
		const lines = (columns: number): Line[] => {
			const minutes = Math.max(0, Math.ceil((info.expiresAt - Date.now()) / 60_000));
			const rows: Line[] = [theme.fg("accent", "phi remote · pair a phone"), ""];
			if (qr) {
				const width = Math.max(...qr.map((row) => visibleWidth(row)));
				if (width + 1 <= columns) {
					for (const row of qr) rows.push({ qr: row });
				} else {
					rows.push(theme.fg("dim", "(widen the terminal to show the QR code)"));
				}
				rows.push("");
			}
			rows.push(`${label("Code")}${theme.bold(info.code)}`);
			rows.push(`${label("Expires")}${clock(info.expiresAt)} (${minutes} min)`);
			rows.push(`${label("Host")}${info.name}`);
			info.urls.forEach((url, index) => {
				rows.push(`${label(index === 0 ? "URL" : "")}${url}`);
			});
			rows.push("");
			rows.push(
				theme.fg(
					"dim",
					qr
						? "Scan with the phi app, or enter the code by hand. Any key closes."
						: `Open ${info.link} on the phone, or enter the code by hand. Any key closes.`,
				),
			);
			return rows;
		};
		return new Panel(lines, close);
	});
}

export async function showDevices(ctx: ExtensionCommandContext, devices: DeviceInfo[]): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			devices.length === 0
				? "phi remote: no paired devices"
				: `phi remote devices: ${devices.map((device) => `${device.name}${device.connected ? " (connected)" : ""}`).join(", ")}`,
			"info",
		);
		return;
	}
	await ctx.ui.custom<void>((_tui, theme: Theme, _keybindings, done) => {
		const nameWidth = Math.min(32, Math.max(8, ...devices.map((device) => device.name.length)));
		const lines = (): Line[] => {
			const rows: Line[] = [theme.fg("accent", "phi remote · paired devices"), ""];
			if (devices.length === 0) rows.push(theme.fg("dim", "No paired devices. /remote pairs one."));
			for (const device of devices) {
				const state = device.connected
					? theme.fg("success", "connected")
					: device.lastSeenAt
						? `last seen ${ago(device.lastSeenAt)}`
						: "never connected";
				const push = device.push ? theme.fg("dim", " · push") : "";
				rows.push(`${device.name.padEnd(nameWidth)}  ${device.platform.padEnd(8)}${state}${push}`);
			}
			rows.push("");
			rows.push(theme.fg("dim", "Any key closes."));
			return rows;
		};
		return new Panel(lines, () => done());
	});
}
