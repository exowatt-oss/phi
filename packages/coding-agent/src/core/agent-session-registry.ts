import { EventEmitter } from "node:events";
import type { AgentSession } from "./agent-session.ts";

/**
 * Process-wide roster of AgentSessions. Extensions that embed child sessions
 * in-process (workflow runners and the like) never spawn a `phi` child, so no
 * env var or socket marks them as subagents; the superview feed subscribes
 * here to publish them as such.
 */
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export const agentSessionRegistry = {
	created(session: AgentSession): void {
		emitter.emit("created", session);
	},
	disposed(session: AgentSession): void {
		emitter.emit("disposed", session);
	},
	onCreated(listener: (session: AgentSession) => void): () => void {
		emitter.on("created", listener);
		return () => emitter.off("created", listener);
	},
	onDisposed(listener: (session: AgentSession) => void): () => void {
		emitter.on("disposed", listener);
		return () => emitter.off("disposed", listener);
	},
};
