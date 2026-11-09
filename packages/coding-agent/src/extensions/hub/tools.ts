import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "../../core/extensions/types.ts";
import { discoverExportCandidates } from "./export.ts";
import type { HubEnvironment } from "./operations.ts";
import {
	formatSearchResults,
	formatStatus,
	hubStatus,
	type ImportResult,
	importBundle,
	installBundle,
	publishBundle,
	removeBundle,
	searchBundles,
	setBundleEnabled,
} from "./operations.ts";
import { bundleKey, parseBundleRef } from "./refs.ts";
import { formatUpdateResult, updateBundles } from "./updates.ts";

const RELOAD_HINT = "The change applies after the user restarts phi or runs /reload.";

function describeImport(result: ImportResult): string {
	return [
		`Imported ${result.key} v${result.version} (${result.fileCount} files) to ${result.path}.`,
		result.kinds.length > 0 ? `Contains: ${result.kinds.join(", ")}.` : "",
		result.previousVersion !== undefined ? `Replaced v${result.previousVersion}.` : "",
		result.track === "latest"
			? "It tracks the latest version, so hub_update or /hub update will move it forward."
			: `It is pinned to v${result.version} and updates will leave it alone.`,
		result.enabled
			? `The bundle is enabled and its resources load after a reload. ${RELOAD_HINT}`
			: "The bundle was previously disabled and stays disabled; use hub_toggle with action=enable.",
		result.enabled && !result.linked
			? "It ships no skills/extensions/prompts/themes, so it deliberately gets no packages entry in settings.json; its loaders read hub state directly. This is correct, not a failed import."
			: "",
		result.hasSettingsFragment
			? "It also ships a settings fragment. Settings are never auto-applied; tell the user to run /hub apply-settings to review the diff."
			: "",
		result.kinds.includes("models")
			? "It ships a models.json (models/models.json), layered beneath the user's own ~/.pi/agent/models.json after a reload. The recipient supplies their own credentials via auth.json/env/local config; the bundle carries none."
			: "",
	]
		.filter(Boolean)
		.join("\n");
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
	return { content: [{ type: "text", text }], details };
}

/**
 * Agent-facing wrappers over the same core the `/hub` command uses. Results are
 * written so the model can act on them without a second lookup.
 */
export function registerHubTools(pi: ExtensionAPI, getEnvironment: (cwd: string) => HubEnvironment): void {
	pi.registerTool({
		name: "hub_status",
		label: "Hub Status",
		description:
			"Show the phi hub connection and every bundle imported on this machine, with version, enabled state, and link health.",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			const status = await hubStatus(getEnvironment(ctx.cwd));
			return textResult(formatStatus(status), status);
		},
	});

	pi.registerTool({
		name: "hub_search",
		label: "Hub Search",
		description:
			"Search the phi hub for shareable bundles of agent configuration (skills, extensions, prompts, themes, instructions, settings, models).",
		parameters: Type.Object({
			query: Type.Optional(Type.String({ description: "Free-text search over titles, descriptions, and tags" })),
			kind: Type.Optional(Type.String({ description: "Filter by bundle kind, e.g. skill, extension, theme" })),
			owner: Type.Optional(Type.String({ description: "Filter by owner handle" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const results = await searchBundles(
				getEnvironment(ctx.cwd),
				{ q: params.query, kind: params.kind, owner: params.owner },
				signal,
			);
			const text =
				results.length === 0
					? "No bundles matched. Try a broader query or omit the kind/owner filters."
					: `${formatSearchResults(results)}\n\nImport one with hub_import using its owner/slug reference.`;
			return textResult(text, { results });
		},
	});

	pi.registerTool({
		name: "hub_install",
		label: "Hub Install",
		description:
			"Install a phi hub bundle and keep it on the latest version. Use this by default; use hub_import only when the user explicitly wants a specific version pinned.",
		parameters: Type.Object({
			ref: Type.String({ description: 'Bundle reference: "owner/slug". A pinned "@3" ref is rejected here.' }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await installBundle(getEnvironment(ctx.cwd), params.ref, { signal });
			return textResult(describeImport(result), result);
		},
	});

	pi.registerTool({
		name: "hub_import",
		label: "Hub Import",
		description:
			"Import a phi hub bundle into the isolated bundle store. A bundle shipping skills/extensions/prompts/themes is linked with a single packages entry in global settings; a models/instructions/settings-only bundle is enabled through hub state and gets no packages entry. Never writes into the user's own skills/extensions directories. A bare ref tracks the latest version; an @N ref pins it.",
		parameters: Type.Object({
			ref: Type.String({ description: 'Bundle reference: "owner/slug", optionally pinned as "owner/slug@3"' }),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const result = await importBundle(getEnvironment(ctx.cwd), params.ref, { signal });
			return textResult(describeImport(result), result);
		},
	});

	pi.registerTool({
		name: "hub_update",
		label: "Hub Update",
		description:
			"Check the hub once for every bundle tracking the latest version and re-import the ones with a newer version. Pinned bundles are never touched, and bundles that vanished from the hub are reported, never removed.",
		parameters: Type.Object({
			ref: Type.Optional(
				Type.String({ description: 'Limit the update to one imported bundle, "owner/slug". Omit for all.' }),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const onlyKeys = params.ref ? [bundleKey(parseBundleRef(params.ref))] : undefined;
			const result = await updateBundles(getEnvironment(ctx.cwd), { onlyKeys, signal });
			return textResult(formatUpdateResult(result), result);
		},
	});

	pi.registerTool({
		name: "hub_toggle",
		label: "Hub Toggle",
		description:
			"Enable, disable, or remove an imported phi hub bundle. Disable only removes the settings link; files and state stay so it can be re-enabled.",
		parameters: Type.Object({
			ref: Type.String({ description: 'Imported bundle reference, "owner/slug"' }),
			action: StringEnum(["enable", "disable", "remove"] as const, { description: "What to do with the bundle" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const env = getEnvironment(ctx.cwd);
			if (params.action === "remove") {
				const removed = await removeBundle(env, params.ref);
				return textResult(
					`Removed ${removed.key} (was v${removed.version}): unlinked, store directory deleted, state row dropped. ${RELOAD_HINT}`,
					removed,
				);
			}
			const enable = params.action === "enable";
			const result = await setBundleEnabled(env, params.ref, enable);
			const enabledDetail = result.linkable
				? "its resources load from the isolated store"
				: "it ships no skills/extensions/prompts/themes, so it loads through hub state and gets no packages entry";
			const disabledDetail = result.linkable
				? "its packages entry was removed; files and state are untouched"
				: "it stopped loading through hub state; files and state are untouched";
			const detail = enable ? enabledDetail : disabledDetail;
			return textResult(`${enable ? "Enabled" : "Disabled"} ${result.key} — ${detail}. ${RELOAD_HINT}`, result);
		},
	});

	pi.registerTool({
		name: "hub_publish",
		label: "Hub Publish",
		description:
			"Publish local phi configuration to the hub as a bundle version. Call hub_status first if unsure what exists; the exportable item ids are listed in the error when an unknown id is passed. Credentials are refused before upload.",
		parameters: Type.Object({
			slug: Type.String({ description: "Bundle slug, lowercase letters, digits, and dashes" }),
			title: Type.String({ description: "Human-readable bundle title" }),
			description: Type.String({ description: "One or two sentences on what the bundle gives you" }),
			items: Type.Array(Type.String(), {
				description:
					'Exportable item ids to include, e.g. "skills/my-skill", "settings/settings.json", or "models/models.json"',
			}),
			kind: Type.Optional(Type.String({ description: "Override the inferred bundle kind" })),
			tags: Type.Optional(Type.Array(Type.String())),
			changelog: Type.Optional(Type.String({ description: "Changelog for this version" })),
			owner: Type.Optional(
				Type.String({
					description:
						'Org handle to publish under, e.g. "gateway". Only works if the user is a publisher of that org. Omit to publish to the user\'s own profile.',
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const env = getEnvironment(ctx.cwd);
			const candidates = await discoverExportCandidates(env.paths, env.storage);
			const available = candidates.map((candidate) => candidate.id);
			const unknown = params.items.filter((item) => !available.includes(item));
			if (unknown.length > 0) {
				throw new Error(
					`Unknown exportable items: ${unknown.join(", ")}. Available items: ${available.join(", ") || "(none)"}`,
				);
			}
			const picked = candidates.filter((candidate) => params.items.includes(candidate.id));
			const result = await publishBundle(
				env,
				{
					slug: params.slug,
					title: params.title,
					description: params.description,
					kind: params.kind,
					tags: params.tags,
					changelog: params.changelog,
					candidates: picked,
					owner: params.owner,
				},
				signal,
			);
			return textResult(
				`Published ${result.key} v${result.version} (${result.fileCount} files, kind ${result.kind}). Others install it with: /hub install ${result.key}${result.publishedToOrg ? ". As an org bundle it auto-updates for anyone tracking latest." : ""}`,
				result,
			);
		},
	});
}
