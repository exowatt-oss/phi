import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../config.ts";

/** Where the Feads bearer token came from. `file` is `<agentDir>/phi.env`. */
export type FeadsCredentialSource = "canonical" | "legacy" | "file" | "none";

export interface FeadsCredential {
	token: string | undefined;
	source: FeadsCredentialSource;
}

export const FEADS_TOKEN_FILE_NAME = "phi.env";

type FeadsCredentialEnvironment = Partial<Pick<NodeJS.ProcessEnv, "FEADS_AGENT_TOKEN" | "FEADS_TOKEN">>;

export interface ResolveFeadsCredentialOptions {
	env?: FeadsCredentialEnvironment;
	/** Read the fallback file; defaults to `<agentDir>/phi.env`. Tests inject their own. */
	readTokenFile?: () => FeadsTokenFileValues;
	/**
	 * Accept `FEADS_TOKEN` (env or file). Presence keeps the published compatibility
	 * fallback; delegation and flares stay canonical-only.
	 */
	includeLegacy?: boolean;
}

export interface FeadsTokenFileValues {
	canonical: string | undefined;
	legacy: string | undefined;
}

const ASSIGNMENT = /^(?:export\s+)?(FEADS_AGENT_TOKEN|FEADS_TOKEN)=(.*)$/u;

function usableToken(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const token = value.trim();
	return token.length > 0 ? token : undefined;
}

function unquote(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		if ((first === '"' || first === "'") && value[value.length - 1] === first) return value.slice(1, -1);
	}
	return value;
}

/**
 * A file value is used only when it is a literal agent token. Anything that needs
 * shell evaluation or a secret-manager lookup (`$VAR`, backticks, `op://` refs) is
 * the unrendered `phi.env.op` template, not a credential.
 */
function literalFileToken(raw: string): string | undefined {
	const value = unquote(raw);
	if (value.length === 0 || /[$`\s]/u.test(value) || value.includes("op://")) return undefined;
	return value.startsWith("fdsa_") ? value : undefined;
}

/** Parse `phi.env` content. The last assignment of each variable wins, as when sourced. */
export function parseFeadsTokenFile(content: string): FeadsTokenFileValues {
	const last: Record<"FEADS_AGENT_TOKEN" | "FEADS_TOKEN", string | undefined> = {
		FEADS_AGENT_TOKEN: undefined,
		FEADS_TOKEN: undefined,
	};
	for (const line of content.split(/\r?\n/u)) {
		const match = ASSIGNMENT.exec(line.trim());
		if (!match) continue;
		last[match[1] as keyof typeof last] = match[2];
	}
	return {
		canonical: last.FEADS_AGENT_TOKEN === undefined ? undefined : literalFileToken(last.FEADS_AGENT_TOKEN),
		legacy: last.FEADS_TOKEN === undefined ? undefined : literalFileToken(last.FEADS_TOKEN),
	};
}

export function feadsTokenFilePath(): string {
	return join(getAgentDir(), FEADS_TOKEN_FILE_NAME);
}

/** Synchronous, read-only; a missing or unreadable file yields no token. */
export function readFeadsTokenFile(path: string = feadsTokenFilePath()): FeadsTokenFileValues {
	try {
		return parseFeadsTokenFile(readFileSync(path, "utf8"));
	} catch {
		return { canonical: undefined, legacy: undefined };
	}
}

/**
 * The one Feads credential resolver: `FEADS_AGENT_TOKEN`, then (when allowed) `FEADS_TOKEN`
 * from the process environment, then the same pair from `<agentDir>/phi.env`. The file is
 * read only when the environment has no usable value, so a login shell that sourced it
 * behaves exactly as before. Environment values stay opaque (server-validated); file
 * values must be literal `fdsa_` tokens.
 */
export function resolveFeadsCredential(options: ResolveFeadsCredentialOptions = {}): FeadsCredential {
	const env = options.env ?? process.env;
	const includeLegacy = options.includeLegacy ?? true;
	const canonical = usableToken(env.FEADS_AGENT_TOKEN);
	if (canonical) return { token: canonical, source: "canonical" };
	if (includeLegacy) {
		const legacy = usableToken(env.FEADS_TOKEN);
		if (legacy) return { token: legacy, source: "legacy" };
	}
	const file = (options.readTokenFile ?? readFeadsTokenFile)();
	const fromFile = file.canonical ?? (includeLegacy ? file.legacy : undefined);
	if (fromFile) return { token: fromFile, source: "file" };
	return { token: undefined, source: "none" };
}
