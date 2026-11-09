import type { AgentToolCallOutcome } from "@earendil-works/pi-agent-core";
import type { ExtensionContext, ExtensionToolContext } from "../src/core/extensions/types.ts";

/**
 * Widen an extension or command context into the `ExtensionToolContext` a tool's `execute()` gets in a
 * session, for tests that call `execute()` directly. No tools are callable: `executeTool()` reports every
 * call as an unknown tool, the way the session does. Property descriptors are copied, so getters on the
 * source context stay live and its prototype is kept.
 */
export function toolContext<T extends ExtensionContext>(
	ctx: T,
	overrides: Partial<Pick<ExtensionToolContext, "tools" | "executeTool">> = {},
): T & ExtensionToolContext {
	let calls = 0;
	return Object.create(Object.getPrototypeOf(ctx), {
		...Object.getOwnPropertyDescriptors(ctx),
		tools: { value: overrides.tools ?? [], enumerable: true },
		executeTool: {
			value:
				overrides.executeTool ??
				(async (name: string): Promise<AgentToolCallOutcome> => ({
					toolCall: { type: "toolCall", id: `test-tool-context/${++calls}`, name, arguments: {} },
					result: { content: [{ type: "text", text: `Tool ${name} not found` }], details: undefined },
					isError: true,
				})),
			enumerable: true,
		},
	}) as T & ExtensionToolContext;
}
