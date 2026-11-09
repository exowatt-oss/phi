import { execFile } from "node:child_process";
import { hostname as osHostname } from "node:os";

export interface HostIdentity {
	hostname?: string;
	tmuxSession?: string;
	tmuxPane?: string;
	devboxProfileId?: string;
	sshConnection?: true;
}

export type HostIdentityEnv = Readonly<Record<string, string | undefined>>;
export type TmuxSessionLookup = () => string | undefined | PromiseLike<string | undefined>;

export interface HostIdentityHooks {
	hostname?: () => string | undefined;
	tmuxSession?: TmuxSessionLookup;
}

const MAX_VALUE_LENGTH = 128;
const TMUX_LOOKUP_TIMEOUT_MS = 75;
const UNSET = Symbol("host identity cache unset");
const DEVBOX_SESSION_NAME = /^devbox-([A-Za-z0-9_]+)-[0-9]+(?:-[A-Za-z_][A-Za-z0-9_]*)?$/u;
const DEVBOX_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

let cachedHostIdentity: HostIdentity | undefined | typeof UNSET = UNSET;

function cleanValue(value: string | undefined): string | undefined {
	if (typeof value !== "string" || !value || CONTROL_CHARACTERS.test(value)) return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 && trimmed.length <= MAX_VALUE_LENGTH ? trimmed : undefined;
}

function firstEnvValue(env: HostIdentityEnv, names: string[]): string | undefined {
	for (const name of names) {
		const value = cleanValue(env[name]);
		if (value) return value;
	}
	return undefined;
}

function devboxProfileFromSession(session: string | undefined): string | undefined {
	const match = session?.match(DEVBOX_SESSION_NAME);
	return match?.[1] && DEVBOX_PROFILE_ID.test(match[1]) ? match[1] : undefined;
}

function applyTmuxSession(identity: HostIdentity, session: string | undefined): void {
	const tmuxSession = cleanValue(session);
	if (!tmuxSession) return;
	identity.tmuxSession = tmuxSession;
	if (!identity.devboxProfileId) {
		const devboxProfileId = devboxProfileFromSession(tmuxSession);
		if (devboxProfileId) identity.devboxProfileId = devboxProfileId;
	}
}

function discoverTmuxSession(env: HostIdentityEnv): Promise<string | undefined> {
	return new Promise((resolve) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const finish = (value: string | undefined): void => {
			if (settled) return;
			settled = true;
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			resolve(value);
		};

		try {
			const args = ["display-message", "-p"];
			const tmuxPane = cleanValue(env.TMUX_PANE);
			if (tmuxPane) args.push("-t", tmuxPane);
			args.push("#S");
			const child = execFile(
				"tmux",
				args,
				{ encoding: "utf8", maxBuffer: 256, windowsHide: true },
				(error, stdout) => finish(error ? undefined : stdout.trim()),
			);
			child.once("error", () => finish(undefined));
			timeout = setTimeout(() => {
				try {
					child.kill();
				} catch {
					/* The best-effort probe may already be gone. */
				}
				finish(undefined);
			}, TMUX_LOOKUP_TIMEOUT_MS);
			timeout.unref?.();
			child.unref();
			if (settled && timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
		} catch {
			finish(undefined);
		}
	});
}

function attachTmuxLookup(identity: HostIdentity, lookup: TmuxSessionLookup): void {
	let result: ReturnType<TmuxSessionLookup>;
	try {
		result = lookup();
	} catch {
		return;
	}

	if (typeof result === "string" || result === undefined) {
		applyTmuxSession(identity, result);
		return;
	}

	const timeout = new Promise<undefined>((resolve) => {
		const timer = setTimeout(() => resolve(undefined), TMUX_LOOKUP_TIMEOUT_MS);
		timer.unref?.();
	});
	void Promise.race([Promise.resolve(result), timeout])
		.then((session) => applyTmuxSession(identity, session))
		.catch(() => undefined);
}

/** Derive host metadata without requiring a process-global environment. */
export function deriveHostIdentity(env: HostIdentityEnv, hooks: HostIdentityHooks = {}): HostIdentity | undefined {
	const identity: HostIdentity = {};
	try {
		const hostname = cleanValue((hooks.hostname ?? osHostname)());
		if (hostname) identity.hostname = hostname;
	} catch {
		/* Hostname is optional telemetry. */
	}

	const explicitTmuxSession = firstEnvValue(env, [
		"PI_TMUX_SESSION_NAME",
		"TMUX_SESSION_NAME",
		"PI_TMUX_SESSION",
		"TMUX_SESSION",
	]);
	if (explicitTmuxSession) {
		applyTmuxSession(identity, explicitTmuxSession);
	} else if (cleanValue(env.TMUX)) {
		attachTmuxLookup(identity, hooks.tmuxSession ?? (() => discoverTmuxSession(env)));
	}

	const tmuxPane = cleanValue(env.TMUX_PANE);
	if (tmuxPane) identity.tmuxPane = tmuxPane;

	const explicitDevboxProfile = firstEnvValue(env, [
		"PI_DEVBOX_PROFILE_ID",
		"DEVBOX_PROFILE_ID",
		"PI_DEVBOX_PROFILE",
		"DEVBOX_PROFILE",
	]);
	if (explicitDevboxProfile && DEVBOX_PROFILE_ID.test(explicitDevboxProfile)) {
		identity.devboxProfileId = explicitDevboxProfile;
	}

	if (cleanValue(env.SSH_CONNECTION)) identity.sshConnection = true;
	return Object.keys(identity).length > 0 ? identity : undefined;
}

/**
 * Get this process's host metadata. The first result is cached; asynchronous tmux
 * discovery may enrich that same object later without delaying the caller.
 */
export function getHostIdentity(
	env: HostIdentityEnv = process.env,
	hooks: HostIdentityHooks = {},
): HostIdentity | undefined {
	if (cachedHostIdentity !== UNSET) return cachedHostIdentity;
	try {
		cachedHostIdentity = deriveHostIdentity(env, hooks);
	} catch {
		cachedHostIdentity = undefined;
	}
	return cachedHostIdentity;
}
