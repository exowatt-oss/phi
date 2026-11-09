import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerHubCommands } from "./commands.ts";
import { createHubEnvironment, type HubEnvironment } from "./operations.ts";
import { registerHubTools } from "./tools.ts";
import { announceStartupUpdateCheck } from "./updates.ts";

/**
 * Built-in `hub` extension: the client side of the phi hub
 * (`example-org/phi-hub`, `docs/contract.md`).
 *
 * Bundles of agent configuration are imported into an isolated store under the
 * agent dir. A bundle carrying skills, extensions, prompts, or themes is linked
 * with exactly one absolute-path entry in the global `packages` array, so
 * enable/disable/remove stay single reversible operations that never touch the
 * user's own resource directories or settings values. A bundle carrying only
 * hub-only kinds (models, instructions, settings) is never linked: those load
 * from `hub/state.json` through their own loaders. A `packages` entry an older
 * client left behind for such a bundle is dropped by a synchronous startup
 * migration (`link-repair.ts`), which has to run before resource discovery to
 * prevent the extension-load error rather than merely report it.
 *
 * No network or filesystem work happens here at load time — every call is
 * inside a command, a tool, or a session event.
 */
export default function hubExtension(pi: ExtensionAPI): void {
	let environment: HubEnvironment | undefined;

	const getEnvironment = (cwd: string): HubEnvironment => {
		environment ??= createHubEnvironment(cwd, getAgentDir());
		return environment;
	};

	registerHubCommands(pi, getEnvironment);
	registerHubTools(pi, getEnvironment);

	pi.on("session_start", (_event, ctx) => {
		// Re-read hub state for this session rather than trusting a cache from the previous one.
		const env = getEnvironment(ctx.cwd);
		env.instructions.invalidate();

		// Update check: deliberately not returned or awaited, so session start
		// never waits on the network. It is throttled to once every six hours and
		// silent on every failure path (see updates.ts).
		void announceStartupUpdateCheck(env, ctx);
	});

	// `instructions/*.md` from enabled bundles are appended to the system prompt
	// for this turn only. Nothing is persisted into the session, so disabling a
	// bundle removes its instructions from the very next turn with zero residue.
	pi.on("before_agent_start", async (event, ctx) => {
		const block = await getEnvironment(ctx.cwd).instructions.getBlock();
		if (!block) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
	});
}
