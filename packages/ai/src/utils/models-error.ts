import type { AuthRequiredDetails } from "../auth/errors.ts";
import { formatThrownValue } from "./diagnostics.ts";

export type ModelsErrorCode =
	| "model_source"
	| "model_validation"
	| "provider"
	| "stream"
	| "auth"
	| "oauth"
	| "auth_required";

export class ModelsError extends Error {
	readonly code: ModelsErrorCode;
	readonly authRequired?: AuthRequiredDetails;

	constructor(
		code: ModelsErrorCode,
		message: string,
		options?: { cause?: unknown; authRequired?: AuthRequiredDetails; includeCauseInMessage?: boolean },
	) {
		super(options?.includeCauseInMessage === false ? message : withCauseDetail(message, options?.cause), options);
		this.name = "ModelsError";
		this.code = code;
		this.authRequired = options?.authRequired;
	}
}

/** Callers surface `error.message` only, so keep the underlying reason in it. */
function withCauseDetail(message: string, cause: unknown): string {
	if (cause === undefined || cause === null) return message;
	const detail = formatThrownValue(cause).trim();
	if (!detail || message.includes(detail)) return message;
	return `${message}: ${detail}`;
}
