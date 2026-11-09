import type { Api, CredentialInfo, Model } from "@earendil-works/pi-ai";
import { APP_NAME } from "../config.ts";
import { resolveCliModel, resolveModelReference } from "../core/model-resolver.ts";
import type { ModelRuntime } from "../core/model-runtime.ts";
import type { Args } from "./args.ts";
import { AuthCommandError, type AuthCommandKind, getAuthCredential, validateAuthCommandArgs } from "./auth-command.ts";

const DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS = 30 * 60_000;

type CredentialPrintKind = Exclude<AuthCommandKind, "check">;

/**
 * phi's `auth` help: upstream's auth-command surface (print-*, check) plus phi's
 * `auth token` gateway-key export, with the display name taken from APP_NAME.
 */
export function printCredentialPrintHelp(): void {
	console.log(`Usage:
  ${APP_NAME} auth token [--json] [--force]
  ${APP_NAME} auth print-api-key [--provider <provider>] [--model <model>]
  ${APP_NAME} auth print-bearer-token [--provider <provider>] [--model <model>] [--min-expiry <duration>]
  ${APP_NAME} auth check [--provider <provider>] [--model <model>] [--json] [--credentials] [--no-refresh]

"auth token" exports the configured gateway key without starting phi; its detailed
help is available with "${APP_NAME} auth token --help". The print and check
commands require at least one of --provider or --model; provider inference uses
configured credentials. Bearer tokens have a 30-minute minimum expiry by default;
--min-expiry accepts ms, s, m, or h (for example, 30m). Checks refresh expired
OAuth credentials by default; --no-refresh prevents this. --credentials emits the
credential, or includes it in JSON output.

Use "${APP_NAME} auth --help" to show this help without starting phi.`);
}

/**
 * Resolve one configured provider credential.
 *
 * This intentionally calls ModelRuntime.getAuth(), which refreshes and persists
 * OAuth credentials with less than five minutes remaining through the normal request-auth path.
 */
export async function resolveCredentialForPrint(
	args: Args,
	modelRuntime: ModelRuntime,
	kind: CredentialPrintKind,
	minExpiryMs?: number,
	signal?: AbortSignal,
): Promise<string> {
	const { provider: cliProvider, model: cliModel } = validateAuthCommandArgs(args, kind);
	const credentialTypes = new Map<string, CredentialInfo["type"]>(
		(await modelRuntime.listCredentials({ signal })).map((credential) => [credential.providerId, credential.type]),
	);
	const providers: Array<{ id: string; model?: Model<Api> }> = [];
	if (cliProvider) {
		const provider = modelRuntime.getProvider(cliProvider);
		if (!provider) {
			throw new AuthCommandError(`Unknown provider "${cliProvider}". Use --list-models to see available providers.`);
		}
		if (cliModel) {
			const resolved = resolveCliModel({ cliProvider: provider.id, cliModel, modelRuntime });
			if (resolved.error || !resolved.model) {
				throw new AuthCommandError(resolved.error ?? "Unable to resolve the requested provider/model");
			}
			providers.push({ id: provider.id, model: resolved.model });
		} else {
			providers.push({ id: provider.id });
		}
	} else {
		const models = modelRuntime.getModels();
		for (const provider of modelRuntime.getProviders()) {
			if (!credentialTypes.has(provider.id)) continue;
			const resolved = resolveModelReference(
				{ text: cliModel!, provider: provider.id, thinkingSuffix: "strict", fuzzy: true },
				models,
				() => true,
			);
			if (resolved.status === "resolved") providers.push({ id: provider.id, model: resolved.model });
		}
		if (providers.length === 0) {
			throw new AuthCommandError(`Model "${cliModel}" not found. Use --list-models to see available models.`);
		}
	}

	const credentials: Array<{ providerId: string; value: string }> = [];
	for (const provider of providers) {
		const type = credentialTypes.get(provider.id);
		if (kind === "api_key" && type === "oauth") continue;
		if (kind === "bearer_token" && type !== "oauth") continue;
		const authOptions = {
			...(kind === "bearer_token" ? { minOAuthValidityMs: minExpiryMs ?? DEFAULT_BEARER_TOKEN_MIN_EXPIRY_MS } : {}),
			signal,
		};
		const auth = provider.model
			? await modelRuntime.getAuth(provider.model, authOptions)
			: await modelRuntime.getAuth(provider.id, authOptions);
		const value = getAuthCredential(auth);
		if (value) credentials.push({ providerId: provider.id, value });
	}

	if (credentials.length === 1) return credentials[0].value;
	if (credentials.length === 0) {
		const providerId = providers[0]?.id;
		const type = providerId ? credentialTypes.get(providerId) : undefined;
		if (cliProvider && kind === "api_key" && type === "oauth") {
			throw new AuthCommandError(`Provider "${providerId}" is configured with OAuth, not an API key`);
		}
		if (cliProvider && kind === "bearer_token" && type !== "oauth") {
			throw new AuthCommandError(`Provider "${providerId}" is not configured with an OAuth bearer token`);
		}
		throw new AuthCommandError(`No usable ${kind === "api_key" ? "API key" : "OAuth bearer token"} is configured`);
	}
	throw new AuthCommandError(
		`Multiple configured providers matched (${credentials.map(({ providerId }) => providerId).join(", ")}). Specify --provider.`,
	);
}
