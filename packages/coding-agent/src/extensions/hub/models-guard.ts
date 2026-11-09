/**
 * Schema-aware safe-models validation for the one bundle kind that is allowed to
 * carry `models.json`: a `models/models.json` file.
 *
 * The plain filename `models.json` still holds credentials by convention and is
 * refused everywhere (see `secrets.ts`). What is publishable is a deliberately
 * placed `models/models.json` whose credential-bearing fields are **indirection,
 * not secrets**: `$ENV` / `${ENV}` references or a `!command`. A literal `apiKey`
 * or a literal auth-header value is refused, with the JSON field path in the
 * message so the author knows exactly which field to fix.
 *
 * This runs in addition to — never instead of — the generic credential scan in
 * `secrets.ts`, which still sees every file including this one.
 */

import { getConfigValueEnvVarNames, isCommandConfigValue } from "../../core/resolve-config-value.ts";
import { stripJsonComments } from "../../utils/json.ts";

/** The single bundle-relative path a shareable models.json may live at. */
export const MODELS_BUNDLE_PATH = "models/models.json";

/**
 * Header names whose value is a credential and therefore must be an indirection.
 * Matched case-insensitively, by exact name or by a telltale substring, so a
 * provider-specific header (`x-goog-api-key`, `x-observatory-token`) is caught
 * without an exhaustive list.
 */
const AUTH_HEADER_NAMES = new Set(["authorization", "proxy-authorization", "cookie", "x-api-key", "api-key"]);
const AUTH_HEADER_SUBSTRINGS = ["api-key", "apikey", "token", "secret", "auth", "password"];

function isAuthHeaderName(name: string): boolean {
	const lower = name.toLowerCase();
	if (AUTH_HEADER_NAMES.has(lower)) return true;
	return AUTH_HEADER_SUBSTRINGS.some((needle) => lower.includes(needle));
}

/**
 * A credential-bearing value is safe only when it resolves through the machine's
 * own environment or a command — never when it is a literal baked into the file.
 * `$ENV` / `${ENV}` templates and `!command` values are indirection; anything
 * else is a literal secret.
 */
function isSafeIndirection(value: string): boolean {
	if (isCommandConfigValue(value)) return true;
	return getConfigValueEnvVarNames(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Collect literal-secret violations inside a `headers` object at `basePath`. */
function collectHeaderViolations(headers: unknown, basePath: string, violations: string[]): void {
	if (!isRecord(headers)) return;
	for (const [name, value] of Object.entries(headers)) {
		if (typeof value !== "string" || !isAuthHeaderName(name)) continue;
		if (!isSafeIndirection(value)) {
			violations.push(
				`${basePath}.${name} is a literal auth header; use an $ENV reference or !command instead of a baked-in value`,
			);
		}
	}
}

/** Collect literal-secret violations for an `apiKey` string at `path`. */
function collectApiKeyViolation(value: unknown, path: string, violations: string[]): void {
	if (typeof value !== "string") return;
	if (!isSafeIndirection(value)) {
		violations.push(`${path} is a literal apiKey; use an $ENV reference or !command instead of a baked-in secret`);
	}
}

/**
 * Structurally inspect a parsed models.json and return every literal-credential
 * violation with its JSON field path. An empty array means the file carries no
 * baked-in credentials — only environment/command indirection, which is safe to
 * share because the recipient supplies their own credentials.
 */
export function findModelsConfigViolations(parsed: unknown): string[] {
	const violations: string[] = [];
	if (!isRecord(parsed)) return violations;
	const providers = parsed.providers;
	if (!isRecord(providers)) return violations;

	for (const [providerId, provider] of Object.entries(providers)) {
		if (!isRecord(provider)) continue;
		const base = `providers.${providerId}`;
		collectApiKeyViolation(provider.apiKey, `${base}.apiKey`, violations);
		collectHeaderViolations(provider.headers, `${base}.headers`, violations);

		if (Array.isArray(provider.models)) {
			provider.models.forEach((model, index) => {
				if (isRecord(model)) collectHeaderViolations(model.headers, `${base}.models[${index}].headers`, violations);
			});
		}
		if (isRecord(provider.modelOverrides)) {
			for (const [modelId, override] of Object.entries(provider.modelOverrides)) {
				if (isRecord(override)) {
					collectHeaderViolations(override.headers, `${base}.modelOverrides.${modelId}.headers`, violations);
				}
			}
		}
	}
	return violations;
}

/**
 * Validate a bundle-relative file that is a `models/models.json`. Parses it and
 * throws on either malformed JSON or a literal-credential field, naming the JSON
 * path. Files that are not `models/models.json` are ignored here (they are the
 * concern of the generic guard and the filename ban).
 */
export function assertSafeModelsConfig(path: string, content: string): void {
	if (path !== MODELS_BUNDLE_PATH) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(content));
	} catch (error) {
		throw new Error(
			`Refusing to publish: ${path} is not valid JSON (${error instanceof Error ? error.message : String(error)}). Fix it and try again.`,
		);
	}
	const violations = findModelsConfigViolations(parsed);
	if (violations.length > 0) {
		throw new Error(
			`Refusing to publish: ${path} contains baked-in credentials:\n${violations
				.map((violation) => `  - ${violation}`)
				.join("\n")}\nReplace them with $ENV references or a !command and try again.`,
		);
	}
}
