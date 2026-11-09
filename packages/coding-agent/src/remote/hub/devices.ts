/**
 * Paired devices (`devices.json`, 0600). Device tokens are 32 random bytes (base64url) handed to
 * the phone once at pairing; only their SHA-256 is stored, and verification compares hashes with
 * `timingSafeEqual`.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { devicesJsonPath } from "../paths.ts";
import { readJsonFile, writeJsonFile } from "./files.ts";

export interface PushRegistration {
	apnsToken: string;
	env: "sandbox" | "production";
	bundleId: string;
}

export interface DeviceRecord {
	id: string;
	name: string;
	platform: string;
	/** Hex SHA-256 of the device token. */
	tokenSha256: string;
	createdAt: number;
	lastSeenAt?: number;
	push?: PushRegistration;
}

export function hashToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("hex");
}

export function newDeviceToken(): string {
	return randomBytes(32).toString("base64url");
}

function newDeviceId(): string {
	return `dev_${randomBytes(6).toString("hex")}`;
}

function isDeviceRecord(value: unknown): value is DeviceRecord {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.id === "string" && typeof v.tokenSha256 === "string" && /^[0-9a-f]{64}$/.test(v.tokenSha256);
}

export class DeviceStore {
	readonly path: string;
	private devices: DeviceRecord[];

	constructor(path = devicesJsonPath()) {
		this.path = path;
		const raw = readJsonFile<unknown>(path);
		this.devices = Array.isArray(raw) ? raw.filter(isDeviceRecord) : [];
	}

	list(): DeviceRecord[] {
		return [...this.devices];
	}

	get(id: string): DeviceRecord | undefined {
		return this.devices.find((d) => d.id === id);
	}

	/** Create a device and return it with its plaintext token (shown to the phone once). */
	add(name: string, platform: string, now = Date.now()): { device: DeviceRecord; token: string } {
		const token = newDeviceToken();
		const device: DeviceRecord = {
			id: newDeviceId(),
			name: name.slice(0, 80) || "device",
			platform: platform.slice(0, 20) || "unknown",
			tokenSha256: hashToken(token),
			createdAt: now,
			lastSeenAt: now,
		};
		this.devices.push(device);
		this.save();
		return { device, token };
	}

	/** Device owning `token`, compared in constant time per candidate. */
	verify(token: unknown): DeviceRecord | undefined {
		if (typeof token !== "string" || token.length === 0 || token.length > 512) return undefined;
		const presented = Buffer.from(hashToken(token), "hex");
		let match: DeviceRecord | undefined;
		for (const device of this.devices) {
			const stored = Buffer.from(device.tokenSha256, "hex");
			if (stored.length === presented.length && timingSafeEqual(stored, presented)) match = device;
		}
		return match;
	}

	remove(id: string): boolean {
		const before = this.devices.length;
		this.devices = this.devices.filter((d) => d.id !== id);
		if (this.devices.length === before) return false;
		this.save();
		return true;
	}

	update(id: string, patch: (device: DeviceRecord) => void): boolean {
		const device = this.get(id);
		if (!device) return false;
		patch(device);
		this.save();
		return true;
	}

	save(): void {
		writeJsonFile(this.path, this.devices);
	}
}
