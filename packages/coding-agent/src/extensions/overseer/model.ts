/**
 * Model references for threads: `provider/id` or `provider/id:thinking`, validated against the
 * overseer's model registry before anything is launched.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { isValidThinkingLevel } from "../../cli/args.ts";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface ModelLookup {
	find(provider: string, modelId: string): Model<Api> | undefined;
	getAll(): Model<Api>[];
}

export interface ParsedModelRef {
	/** Undefined for a bare id. */
	provider?: string;
	modelId: string;
	/** `:level` suffix, when the text had a valid one. */
	thinking?: string;
	/** The text before any `:level` suffix was split off (`provider/id:level` → `provider/id:level`). */
	raw: string;
}

export interface ResolvedModelRef {
	provider: string;
	modelId: string;
	thinking?: string;
	/** `provider/id`. */
	label: string;
}

/** Throws unless `level` is one of phi's thinking levels. */
export function validateThinking(level: string): string {
	const value = level.trim();
	if (!isValidThinkingLevel(value)) {
		throw new Error(`Invalid thinking level "${level}". Valid: ${THINKING_LEVELS.join(", ")}.`);
	}
	return value;
}

/** Syntax only: split provider, id and a valid `:thinking` suffix. */
export function parseModelRef(text: string): ParsedModelRef {
	const raw = text.trim();
	if (!raw) throw new Error('Empty model. Use "provider/id" or "provider/id:thinking".');
	if (/\s/.test(raw)) throw new Error(`Invalid model "${text}": no spaces allowed.`);
	let body = raw;
	let thinking: string | undefined;
	const colon = raw.lastIndexOf(":");
	if (colon > 0 && isValidThinkingLevel(raw.slice(colon + 1))) {
		body = raw.slice(0, colon);
		thinking = raw.slice(colon + 1);
	}
	const slash = body.indexOf("/");
	if (slash === 0 || slash === body.length - 1) throw new Error(`Invalid model "${text}". Use "provider/id".`);
	if (slash === -1) return { modelId: body, thinking, raw };
	return { provider: body.slice(0, slash), modelId: body.slice(slash + 1), thinking, raw };
}

function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	const previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diagonal = previous[0];
		previous[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const above = previous[j];
			previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
			diagonal = above;
		}
	}
	return previous[b.length];
}

/** Up to `limit` `provider/id` labels close to `text` (substring matches first, then edit distance). */
export function nearModelMatches(text: string, models: readonly Model<Api>[], limit = 5): string[] {
	const query = text.toLowerCase();
	const idPart = query.includes("/") ? query.slice(query.indexOf("/") + 1) : query;
	const scored = models.map((model) => {
		const label = `${model.provider}/${model.id}`;
		const lower = label.toLowerCase();
		const id = model.id.toLowerCase();
		const contains = lower.includes(query) || (idPart.length >= 3 && (id.includes(idPart) || idPart.includes(id)));
		return { label, score: (contains ? 0 : 1000) + Math.min(editDistance(query, lower), editDistance(idPart, id)) };
	});
	scored.sort((a, b) => a.score - b.score || a.label.localeCompare(b.label));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const entry of scored) {
		if (seen.has(entry.label)) continue;
		seen.add(entry.label);
		out.push(entry.label);
		if (out.length >= limit) break;
	}
	return out;
}

function notFound(text: string, registry: ModelLookup): Error {
	const near = nearModelMatches(text.replace(/:[a-z]+$/, ""), registry.getAll());
	return new Error(
		`Unknown model "${text}".${near.length ? ` Close matches: ${near.join(", ")}.` : ""} Use "provider/id" or "provider/id:thinking" from /model.`,
	);
}

/**
 * Resolve a model reference against the registry. A `thinking` argument overrides a `:level`
 * suffix. A bare id is accepted when exactly one provider has it.
 */
export function resolveModelRef(text: string, registry: ModelLookup, thinking?: string): ResolvedModelRef {
	const parsed = parseModelRef(text);
	const override = thinking !== undefined && thinking.trim() !== "" ? validateThinking(thinking) : undefined;
	const level = override ?? parsed.thinking;
	if (parsed.provider) {
		let modelId = parsed.modelId;
		let found = registry.find(parsed.provider, modelId);
		let suffixLevel = parsed.thinking;
		// An id that itself ends in ":<level>" (rare) wins over the suffix reading.
		if (parsed.thinking && !found) {
			const whole = parsed.raw.slice(parsed.provider.length + 1);
			const withSuffix = registry.find(parsed.provider, whole);
			if (withSuffix) {
				found = withSuffix;
				modelId = whole;
				suffixLevel = undefined;
			}
		}
		if (!found) throw notFound(text, registry);
		const effective = override ?? suffixLevel;
		return {
			provider: found.provider,
			modelId: found.id,
			...(effective ? { thinking: effective } : {}),
			label: `${found.provider}/${found.id}`,
		};
	}
	const all = registry.getAll();
	let matches = all.filter((model) => model.id === parsed.modelId);
	if (matches.length === 0) matches = all.filter((model) => model.id.toLowerCase() === parsed.modelId.toLowerCase());
	if (matches.length === 1) {
		const found = matches[0];
		return {
			provider: found.provider,
			modelId: found.id,
			...(level ? { thinking: level } : {}),
			label: `${found.provider}/${found.id}`,
		};
	}
	if (matches.length > 1) {
		throw new Error(
			`Model "${text}" exists for several providers: ${matches.map((m) => `${m.provider}/${m.id}`).join(", ")}. Use "provider/id".`,
		);
	}
	throw notFound(text, registry);
}

/** `provider/id[:thinking]` label for display. */
export function modelLabel(model: string | undefined, thinking: string | undefined): string {
	if (!model) return "-";
	return thinking ? `${model}:${thinking}` : model;
}
