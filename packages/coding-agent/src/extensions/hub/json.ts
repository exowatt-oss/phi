/** Narrowing helpers for untyped JSON coming off the wire or off disk. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

/** First key that holds a non-empty string. Accepts snake_case and camelCase spellings. */
export function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

export function readNumber(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value === "string" && /^\d+$/.test(value)) return Number.parseInt(value, 10);
	}
	return undefined;
}

export function readBoolean(record: Record<string, unknown> | undefined, ...keys: string[]): boolean | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

export function readStringArray(record: Record<string, unknown> | undefined, ...keys: string[]): string[] | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = asArray(record[key]);
		if (value) return value.filter((entry): entry is string => typeof entry === "string");
	}
	return undefined;
}

/**
 * List payloads from the hub arrive either bare or wrapped. Accept both so the
 * client does not break on an envelope change.
 */
export function readList(payload: unknown, ...keys: string[]): unknown[] {
	const bare = asArray(payload);
	if (bare) return bare;
	const record = asRecord(payload);
	for (const key of keys) {
		const value = asArray(record?.[key]);
		if (value) return value;
	}
	return [];
}
