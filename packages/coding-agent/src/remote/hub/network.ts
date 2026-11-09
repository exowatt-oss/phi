/**
 * Address discovery for the hub: Tailscale IPv4s (100.64.0.0/10) from the local interfaces, other
 * LAN IPv4s (for `--bind 0.0.0.0`), and the machine's MagicDNS name via `tailscale status --json`
 * (best effort, 2 s timeout, never fatal).
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { hostname, type NetworkInterfaceInfo, networkInterfaces } from "node:os";

export function isTailscaleIPv4(address: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
	if (!m) return false;
	const a = Number(m[1]);
	const b = Number(m[2]);
	return a === 100 && b >= 64 && b <= 127;
}

type Interfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

function ipv4s(ifaces: Interfaces): NetworkInterfaceInfo[] {
	const out: NetworkInterfaceInfo[] = [];
	for (const list of Object.values(ifaces)) {
		for (const info of list ?? []) {
			// Node <18 reported family as the number 4.
			if (info.family === "IPv4" || (info.family as unknown) === 4) out.push(info);
		}
	}
	return out;
}

/** Local Tailscale IPv4 addresses, sorted. */
export function tailscaleIPv4s(ifaces: Interfaces = networkInterfaces()): string[] {
	return [...new Set(ipv4s(ifaces).map((i) => i.address))].filter(isTailscaleIPv4).sort();
}

/** Non-internal, non-Tailscale IPv4 addresses (LAN), sorted. */
export function lanIPv4s(ifaces: Interfaces = networkInterfaces()): string[] {
	return [
		...new Set(
			ipv4s(ifaces)
				.filter((i) => !i.internal && !isTailscaleIPv4(i.address) && !i.address.startsWith("169.254."))
				.map((i) => i.address),
		),
	].sort();
}

/** Short host name for display (`demo-laptop.local` → `demo-laptop`). */
export function displayHostname(name = hostname()): string {
	return name.replace(/\.local\.?$/i, "") || "phi";
}

const TAILSCALE_CANDIDATES = ["tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];

function runTailscaleStatus(bin: string, timeoutMs: number): Promise<string | undefined> {
	return new Promise((resolve) => {
		try {
			execFile(bin, ["status", "--json"], { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
				resolve(error ? undefined : stdout);
			});
		} catch {
			resolve(undefined);
		}
	});
}

/** Parse `Self.DNSName` from `tailscale status --json` output (trailing dot removed). */
export function parseMagicDnsName(statusJson: string): string | undefined {
	try {
		const status = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
		const name = status.Self?.DNSName;
		if (typeof name !== "string") return undefined;
		const trimmed = name.replace(/\.$/, "");
		return /^[A-Za-z0-9.-]+$/.test(trimmed) && trimmed.includes(".") ? trimmed : undefined;
	} catch {
		return undefined;
	}
}

/** MagicDNS name of this machine, or undefined (no Tailscale CLI, logged out, timeout, ...). */
export async function lookupMagicDnsName(timeoutMs = 2000): Promise<string | undefined> {
	for (const bin of TAILSCALE_CANDIDATES) {
		if (bin.startsWith("/") && !existsSync(bin)) continue;
		const out = await runTailscaleStatus(bin, timeoutMs);
		if (out) return parseMagicDnsName(out);
	}
	return undefined;
}

/**
 * Pairing URLs in the order the app should try them (contract clarification 13): the MagicDNS
 * name, then Tailscale IPs, then other bound non-loopback addresses (LAN). Loopback only when the
 * hub was explicitly bound to loopback alone (iOS Simulator / development on the same Mac).
 */
export function pairingUrls(options: {
	port: number;
	binds: readonly string[];
	magicDns?: string;
	/** True when `--bind` was given (rather than the automatic loopback + Tailscale set). */
	explicitBinds?: boolean;
	ifaces?: Interfaces;
}): string[] {
	const { port, binds, magicDns } = options;
	const ifaces = options.ifaces ?? networkInterfaces();
	const wildcard = binds.includes("0.0.0.0");
	const hosts: string[] = [];
	const add = (host: string) => {
		if (!hosts.includes(host)) hosts.push(host);
	};
	const tsBound = wildcard ? tailscaleIPv4s(ifaces) : binds.filter(isTailscaleIPv4);
	if (magicDns && tsBound.length > 0) add(magicDns);
	for (const ip of tsBound) add(ip);
	const others = wildcard ? lanIPv4s(ifaces) : binds.filter((b) => !isTailscaleIPv4(b) && !isLoopback(b));
	for (const ip of others) add(ip);
	const loopbackOnly = options.explicitBinds === true && binds.length > 0 && binds.every(isLoopback);
	if (loopbackOnly) for (const b of binds) add(b);
	return hosts.map((host) => `http://${host.includes(":") ? `[${host}]` : host}:${port}`);
}

function isLoopback(address: string): boolean {
	return address === "localhost" || address === "::1" || address.startsWith("127.");
}
