/** Narrowing helpers for untyped JSON coming off the wire or off disk. */

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

/** First key that holds a non-empty string. */
export function readString(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "string" && value.length > 0) return value;
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

export function readNumber(record: Record<string, unknown> | undefined, ...keys: string[]): number | undefined {
	if (!record) return undefined;
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

export function readStringMap(
	record: Record<string, unknown> | undefined,
	key: string,
): Record<string, string> | undefined {
	const nested = asRecord(record?.[key]);
	if (!nested) return undefined;
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(nested)) {
		if (typeof value === "string") out[name] = value;
	}
	return out;
}

export function safeJsonParse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Message for an unknown throwable, without leaking a stack into tool output. */
export function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}
