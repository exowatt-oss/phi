export type OAuthTokenErrorCode = "invalid_grant" | (string & {});

export interface AuthRequiredDetails {
	provider: string;
	reason: "invalid_grant";
	loginCommand: "phi";
	interactiveCommand: string;
	credentialInvalidated: boolean;
}

/** Structured OAuth token-endpoint failure; never includes token response bodies. */
export class OAuthTokenError extends Error {
	readonly oauthErrorCode: OAuthTokenErrorCode;
	readonly status: number;
	readonly endpoint?: string;

	constructor(oauthErrorCode: OAuthTokenErrorCode, status: number, endpoint?: string) {
		super(
			`OAuth token request failed. status=${status}${endpoint ? `; url=${endpoint}` : ""}; error=${oauthErrorCode}`,
		);
		this.name = "OAuthTokenError";
		this.oauthErrorCode = oauthErrorCode;
		this.status = status;
		this.endpoint = endpoint;
	}
}

/**
 * Terminal refresh failure that requires an interactive login rather than retry.
 *
 * The structural branch supports errors crossing module/realm boundaries, but the
 * explicit `oauthErrorCode` field is mandatory: untrusted message text must never
 * authorize credential deletion.
 */
export function isInvalidGrantError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	try {
		// OAuthTokenError assigns this as an own data property. Reading the
		// descriptor also supports cross-realm copies without invoking an
		// untrusted getter; hostile proxy traps are treated as unstructured.
		const descriptor = Object.getOwnPropertyDescriptor(error, "oauthErrorCode");
		return descriptor !== undefined && "value" in descriptor && descriptor.value === "invalid_grant";
	} catch {
		return false;
	}
}
