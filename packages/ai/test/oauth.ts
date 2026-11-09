/**
 * Test helper for resolving configured provider credentials.
 *
 * OAuth refreshes use the production Models/AuthStorage path so concurrent
 * Vitest workers share the same singleflight and cross-process lock instead of
 * refreshing outside a lock and rewriting stale whole-file snapshots.
 */

import { AuthStorage } from "../../coding-agent/src/core/auth-storage.ts";
import { createModels } from "../src/models.ts";
import { builtinProviders } from "../src/providers/all.ts";

/**
 * Resolve an API key or OAuth access token from the normal auth store.
 * Returns undefined when auth is absent or refresh fails so live tests skip.
 */
export async function resolveApiKey(providerId: string): Promise<string | undefined> {
	const provider = builtinProviders().find((candidate) => candidate.id === providerId);
	if (!provider) return undefined;
	const models = createModels({ credentials: AuthStorage.create() });
	models.setProvider(provider);
	try {
		const resolution = await models.getAuth(providerId);
		const authorization = Object.entries(resolution?.auth.headers ?? {}).find(
			([name]) => name.toLowerCase() === "authorization",
		)?.[1];
		return resolution?.auth.apiKey ?? (/^Bearer\s+(.+)$/iu.exec(authorization ?? "")?.[1] || undefined);
	} catch {
		return undefined;
	}
}
