/**
 * Client-side secret guard. Mirrors the hub's server-side publish validation so
 * credentials never leave the machine in the first place — the server rejecting
 * them is the second line of defence, not the first.
 */

import { assertSafeModelsConfig, MODELS_BUNDLE_PATH } from "./models-guard.ts";

// `mcp.json` holds live credentials for every bridged MCP server (env blocks,
// Authorization headers), so it is never publishable. A bundle that documents
// its MCP wiring ships an `mcp.json.example` using $ENV references instead.
//
// `models.json` is a special case: a bare `models.json` is still credential-
// bearing by convention and refused, but a deliberately placed
// `models/models.json` (the `models` bundle kind) IS publishable once its
// credential fields are proven to be $ENV/!command indirection rather than
// literals — see `models-guard.ts` and `isForbiddenBundleFileName`.
const FORBIDDEN_FILE_NAMES = new Set(["models.json", "auth.json", "hub.json", "mcp.json"]);
const FORBIDDEN_FILE_PREFIXES = ["credentials", ".env"];

const CREDENTIAL_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
	{ label: "Anthropic API key", pattern: /sk-ant-/ },
	{ label: "OpenAI project key", pattern: /sk-proj-/ },
	{ label: "AWS access key id", pattern: /AKIA[0-9A-Z]{16}/ },
	{ label: "private key block", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
	{ label: "Slack token", pattern: /xox[bap]-/ },
	{ label: "GitHub token", pattern: /ghp_/ },
	{ label: "phi hub token", pattern: /phk_/ },
	{ label: "Grafana service account token", pattern: /glsa_/ },
	// A literal bearer token wired into a JSON config. Placeholders are allowed
	// through on purpose — `$TOKEN`, `${TOKEN}`, `<token>` and `{{ env.TOKEN }}`
	// are env references, not secrets.
	{
		label: "bearer token in JSON",
		pattern: /"[Aa]uthorization"\s*:\s*"\s*[Bb]earer\s+(?![$<{])[^"\s]{8,}/,
	},
];

export function isForbiddenBundleFileName(path: string): boolean {
	// The one exception: a `models.json` at the canonical models-bundle path is
	// allowed through the filename ban and validated schema-aware instead.
	if (path === MODELS_BUNDLE_PATH) return false;
	const name = (path.split("/").pop() ?? "").toLowerCase();
	if (FORBIDDEN_FILE_NAMES.has(name)) return true;
	return FORBIDDEN_FILE_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Returns a human-readable reason when the file must not be published. */
export function findSecretViolation(path: string, content: string): string | undefined {
	if (isForbiddenBundleFileName(path)) {
		return `${path} holds credentials by convention and is never publishable`;
	}
	for (const { label, pattern } of CREDENTIAL_PATTERNS) {
		if (pattern.test(content)) {
			return `${path} looks like it contains a ${label}`;
		}
	}
	return undefined;
}

export function assertNoSecrets(files: Array<{ path: string; content: Buffer | string }>): void {
	for (const file of files) {
		// Bundle files are raw bytes; scan a lossy UTF-8 view of them. Binary
		// assets simply never match the credential patterns.
		const text = typeof file.content === "string" ? file.content : file.content.toString("utf-8");
		const violation = findSecretViolation(file.path, text);
		if (violation) {
			throw new Error(`Refusing to publish: ${violation}. Remove it and try again.`);
		}
		// The generic scan above still sees the models file; this adds the
		// schema-aware check that literal apiKeys and auth headers are refused
		// while $ENV/!command indirection is allowed.
		assertSafeModelsConfig(file.path, text);
	}
}
