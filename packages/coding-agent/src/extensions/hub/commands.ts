import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionCommandContext } from "../../core/extensions/types.ts";
import { openBrowser } from "../../utils/open-browser.ts";
import { discoverExportCandidates, type ExportCandidate, inferBundleKind } from "./export.ts";
import type { HubEnvironment } from "./operations.ts";
import {
	commitSettingsApply,
	formatSearchResults,
	formatStatus,
	formatSyncRows,
	hubStatus,
	type ImportResult,
	importBundle,
	installBundle,
	loginWithDeviceFlow,
	loginWithToken,
	planSettingsApply,
	publishBundle,
	removeBundle,
	revertSettings,
	searchBundles,
	setBundleEnabled,
	syncBundles,
	whoami,
} from "./operations.ts";
import { bundleKey, parseBundleRef } from "./refs.ts";
import { formatDiffEntry } from "./settings-fragment.ts";
import { readHubState } from "./state.ts";
import { formatUpdateResult, updateBundles } from "./updates.ts";

const SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "login", description: "Sign in through the browser, or paste a phk_ token" },
	{ name: "whoami", description: "Show the signed-in hub profile" },
	{ name: "search", description: "Search hub bundles" },
	{ name: "install", description: "Install owner/slug and follow new versions" },
	{ name: "import", description: "Import owner/slug[@v]; pinned when a version is given" },
	{ name: "update", description: "Update every bundle tracking the latest version" },
	{ name: "push", description: "Publish local resources as a bundle" },
	{ name: "enable", description: "Turn an imported bundle back on" },
	{ name: "disable", description: "Turn a bundle off, keeping its files" },
	{ name: "remove", description: "Turn a bundle off and delete it" },
	{ name: "apply-settings", description: "Review and merge a bundle settings fragment" },
	{ name: "revert-settings", description: "Restore the newest settings backup" },
	{ name: "sync", description: "Reconcile local bundles with the hub" },
];

const RELOAD_HINT = "Restart phi or run /reload to pick up the change.";

/**
 * Said whenever an enabled bundle deliberately has no `packages` entry, so "no
 * link" never reads as a failed import.
 */
const UNLINKED_HINT =
	"It ships no skills/extensions/prompts/themes, so it loads through hub state rather than a packages entry.";

function splitArgs(args: string): { subcommand: string; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { subcommand: "", rest: "" };
	const space = trimmed.indexOf(" ");
	if (space < 0) return { subcommand: trimmed, rest: "" };
	return { subcommand: trimmed.slice(0, space), rest: trimmed.slice(space + 1).trim() };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function formatImportResult(result: ImportResult): string {
	return [
		`Imported ${result.key} v${result.version} (${result.fileCount} files) into ${result.path}.`,
		result.kinds.length > 0 ? `Kinds: ${result.kinds.join(", ")}.` : "",
		result.track === "latest"
			? "Tracking the latest version; /hub update moves it forward."
			: `Pinned to v${result.version}; /hub update leaves it alone.`,
		result.enabled ? RELOAD_HINT : "The bundle stays disabled; enable it with /hub enable.",
		result.enabled && !result.linked ? UNLINKED_HINT : "",
		result.hasSettingsFragment ? `Settings fragment available: /hub apply-settings ${result.key}` : "",
	]
		.filter(Boolean)
		.join("\n");
}

async function requireRef(
	ctx: ExtensionCommandContext,
	env: HubEnvironment,
	rest: string,
): Promise<string | undefined> {
	if (rest) return rest;
	const state = await readHubState(env.paths.statePath);
	const keys = Object.keys(state).sort();
	if (keys.length === 0) {
		ctx.ui.notify("No bundles imported yet. Run /hub import <owner>/<slug>.", "warning");
		return undefined;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Pass a bundle reference, for example /hub disable owner/slug.", "warning");
		return undefined;
	}
	return ctx.ui.select("Which bundle?", keys);
}

async function runLogin(ctx: ExtensionCommandContext, env: HubEnvironment, rest: string): Promise<void> {
	if (rest) {
		const profile = await loginWithToken(env, rest);
		ctx.ui.notify(`Signed in to the phi hub as ${profile.handle}.`, "info");
		return;
	}

	const profile = await loginWithDeviceFlow(env, {
		onStart: (start) => {
			ctx.ui.setStatus("hub", `hub code ${start.userCode}`);
			ctx.ui.notify(`Approve this device at ${start.verifyUrl}\nCode: ${start.userCode}`, "info");
			openBrowser(start.verifyUrl);
		},
	}).finally(() => ctx.ui.setStatus("hub", undefined));
	ctx.ui.notify(`Signed in to the phi hub as ${profile.handle}.`, "info");
}

async function manageBundles(ctx: ExtensionCommandContext, env: HubEnvironment): Promise<void> {
	while (true) {
		const status = await hubStatus(env);
		ctx.ui.notify(formatStatus(status), "info");
		if (!ctx.hasUI || status.rows.length === 0) return;

		const labels = status.rows.map((row) => `${row.key}@v${row.version} — ${row.enabled ? "enabled" : "disabled"}`);
		const choice = await ctx.ui.select("Manage bundles", [...labels, "Close"]);
		if (!choice || choice === "Close") return;

		const row = status.rows[labels.indexOf(choice)];
		if (!row) return;

		const actions = [row.enabled ? "Disable" : "Enable", "Remove", "Back"];
		if (row.kinds.includes("settings")) actions.splice(2, 0, "Apply settings fragment");
		const action = await ctx.ui.select(`${row.key}@v${row.version}`, actions);
		if (!action || action === "Back") continue;

		if (action === "Remove") {
			if (!(await ctx.ui.confirm("Remove bundle?", `${row.key} files and state will be deleted.`))) continue;
			await removeBundle(env, row.key);
			ctx.ui.notify(`Removed ${row.key}. ${RELOAD_HINT}`, "info");
			continue;
		}
		if (action === "Apply settings fragment") {
			await runApplySettings(ctx, env, row.key);
			continue;
		}
		const enable = action === "Enable";
		const toggled = await setBundleEnabled(env, row.key, enable);
		const hint = enable && !toggled.linkable ? `\n${UNLINKED_HINT}` : "";
		ctx.ui.notify(`${enable ? "Enabled" : "Disabled"} ${row.key}. ${RELOAD_HINT}${hint}`, "info");
	}
}

async function runApplySettings(ctx: ExtensionCommandContext, env: HubEnvironment, ref: string): Promise<void> {
	const plan = await planSettingsApply(env, ref);
	if (plan.diff.length === 0) {
		ctx.ui.notify(`${plan.key}: the settings fragment already matches your configuration.`, "info");
		return;
	}
	const diff = plan.diff.map(formatDiffEntry).join("\n");
	if (ctx.hasUI) {
		const ok = await ctx.ui.confirm(`Apply settings from ${plan.key}?`, diff);
		if (!ok) {
			ctx.ui.notify("Settings fragment not applied.", "info");
			return;
		}
	}
	const backups = await commitSettingsApply(env, plan);
	ctx.ui.notify(
		`Applied ${plan.key} settings.\nBackup: ${backups.join(", ")}\nRevert with /hub revert-settings.`,
		"info",
	);
}

async function pickCandidates(
	ctx: ExtensionCommandContext,
	candidates: ExportCandidate[],
): Promise<ExportCandidate[] | undefined> {
	const selected = new Set<string>();
	while (true) {
		const labels = candidates.map((candidate) => `${selected.has(candidate.id) ? "[x]" : "[ ]"} ${candidate.label}`);
		const choice = await ctx.ui.select(`Select what to publish (${selected.size} selected)`, [
			...labels,
			"Done",
			"Cancel",
		]);
		if (!choice || choice === "Cancel") return undefined;
		if (choice === "Done") {
			if (selected.size === 0) {
				ctx.ui.notify("Select at least one item.", "warning");
				continue;
			}
			return candidates.filter((candidate) => selected.has(candidate.id));
		}
		const candidate = candidates[labels.indexOf(choice)];
		if (!candidate) continue;
		if (selected.has(candidate.id)) selected.delete(candidate.id);
		else selected.add(candidate.id);
	}
}

async function runPush(ctx: ExtensionCommandContext, env: HubEnvironment): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(
			"/hub push needs interactive mode. Use the hub_publish tool for non-interactive publishing.",
			"warning",
		);
		return;
	}
	const candidates = await discoverExportCandidates(env.paths, env.storage);
	if (candidates.length === 0) {
		ctx.ui.notify(
			"Nothing to export: no global extensions, skills, prompts, themes, AGENTS.md, or settings.",
			"warning",
		);
		return;
	}
	const picked = await pickCandidates(ctx, candidates);
	if (!picked) return;

	const slug = await ctx.ui.input("Bundle slug (a-z0-9-)", "my-bundle");
	if (!slug) return;
	const title = await ctx.ui.input("Title", slug);
	if (!title) return;
	const description = (await ctx.ui.input("Description", "What this bundle gives you")) ?? "";
	const tagsInput = (await ctx.ui.input("Tags (comma separated, optional)", "")) ?? "";
	const changelog = (await ctx.ui.input("Changelog for this version (optional)", "")) ?? "";
	const owner = (await ctx.ui.input("Publish under (blank = you, or an org handle)", "")) ?? "";

	const kind = inferBundleKind(picked);
	const summary = [
		`slug: ${slug}`,
		`kind: ${kind}`,
		`owner: ${owner.trim() || "you"}`,
		`items: ${picked.length}`,
		...picked.map((c) => `  ${c.target}`),
	];
	if (!(await ctx.ui.confirm("Publish to the phi hub?", summary.join("\n")))) return;

	const result = await publishBundle(env, {
		slug,
		title,
		description,
		kind,
		tags: tagsInput
			.split(",")
			.map((tag) => tag.trim())
			.filter(Boolean),
		changelog: changelog || undefined,
		candidates: picked,
		owner: owner.trim() || undefined,
	});
	ctx.ui.notify(
		`Published ${result.key} v${result.version} (${result.fileCount} files).${result.publishedToOrg ? " Org bundles auto-update for anyone tracking latest." : ""}`,
		"info",
	);
}

async function runSubcommand(ctx: ExtensionCommandContext, env: HubEnvironment, args: string): Promise<void> {
	const { subcommand, rest } = splitArgs(args);

	switch (subcommand) {
		case "":
			await manageBundles(ctx, env);
			return;
		case "login":
			await runLogin(ctx, env, rest);
			return;
		case "whoami": {
			const profile = await whoami(env);
			ctx.ui.notify(`${profile.handle}${profile.email ? ` <${profile.email}>` : ""}`, "info");
			return;
		}
		case "search": {
			const results = await searchBundles(env, { q: rest || undefined });
			ctx.ui.notify(formatSearchResults(results), "info");
			return;
		}
		case "install":
		case "import": {
			if (!rest) {
				ctx.ui.notify(
					subcommand === "install"
						? "Usage: /hub install <owner>/<slug>"
						: "Usage: /hub import <owner>/<slug>[@v]",
					"warning",
				);
				return;
			}
			const result = subcommand === "install" ? await installBundle(env, rest) : await importBundle(env, rest);
			ctx.ui.notify(formatImportResult(result), "info");
			return;
		}
		case "update": {
			const onlyKeys = rest ? [bundleKey(parseBundleRef(rest))] : undefined;
			const result = await updateBundles(env, { onlyKeys });
			ctx.ui.setStatus("hub", undefined);
			const problems = result.missing.length > 0 || result.applied.some((entry) => !entry.ok);
			ctx.ui.notify(formatUpdateResult(result), problems ? "warning" : "info");
			return;
		}
		case "push":
			await runPush(ctx, env);
			return;
		case "enable":
		case "disable": {
			const ref = await requireRef(ctx, env, rest);
			if (!ref) return;
			const enable = subcommand === "enable";
			const result = await setBundleEnabled(env, ref, enable);
			const hint = enable && !result.linkable ? UNLINKED_HINT : "";
			ctx.ui.notify(
				`${enable ? "Enabled" : "Disabled"} ${result.key}. ${RELOAD_HINT}${hint ? `\n${hint}` : ""}`,
				"info",
			);
			return;
		}
		case "remove": {
			const ref = await requireRef(ctx, env, rest);
			if (!ref) return;
			if (ctx.hasUI && !(await ctx.ui.confirm("Remove bundle?", `${ref} files and state will be deleted.`))) return;
			const result = await removeBundle(env, ref);
			ctx.ui.notify(`Removed ${result.key}. ${RELOAD_HINT}`, "info");
			return;
		}
		case "apply-settings": {
			const ref = await requireRef(ctx, env, rest);
			if (!ref) return;
			await runApplySettings(ctx, env, ref);
			return;
		}
		case "revert-settings": {
			const result = await revertSettings(env);
			ctx.ui.notify(
				`Restored ${result.restored.join(" and ")} from backup ${result.timestamp}. ${RELOAD_HINT}`,
				"info",
			);
			return;
		}
		case "sync": {
			const rows = await syncBundles(env);
			ctx.ui.notify(formatSyncRows(rows), "info");
			return;
		}
		default:
			ctx.ui.notify(
				`Unknown subcommand "${subcommand}".\n${SUBCOMMANDS.map((entry) => `/hub ${entry.name} — ${entry.description}`).join("\n")}`,
				"warning",
			);
	}
}

export function registerHubCommands(pi: ExtensionAPI, getEnvironment: (cwd: string) => HubEnvironment): void {
	pi.registerCommand("hub", {
		description: "Share and install phi configuration through the phi hub",
		getArgumentCompletions: async (prefix: string): Promise<AutocompleteItem[] | null> => {
			const { subcommand, rest } = splitArgs(prefix);
			const wantsRef =
				prefix.includes(" ") &&
				["enable", "disable", "remove", "apply-settings", "import", "update"].includes(subcommand);
			if (wantsRef) {
				const env = getEnvironment(process.cwd());
				const state = await readHubState(env.paths.statePath);
				const items = Object.keys(state)
					.sort()
					.filter((key) => key.startsWith(rest))
					.map((key) => ({ value: `${subcommand} ${key}`, label: key }));
				return items.length > 0 ? items : null;
			}
			const items = SUBCOMMANDS.filter((entry) => entry.name.startsWith(subcommand)).map((entry) => ({
				value: entry.name,
				label: entry.name,
				description: entry.description,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			try {
				await runSubcommand(ctx, getEnvironment(ctx.cwd), args);
			} catch (error) {
				ctx.ui.notify(errorMessage(error), "error");
			}
		},
	});
}
