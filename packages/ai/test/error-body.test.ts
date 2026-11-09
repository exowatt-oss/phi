// Unit tests for the shared provider error-body normalizer.
//
// See issues/provider-error-body-passthrough. These cover one synthesized error
// object per SDK shape (Mistral, openai APIError, @google/genai ApiError, AWS
// Bedrock ServiceException), plus the non-Error fallback, truncation, the empty
// parsed-body edge case, and the formatProviderError compose helper.

import { describe, expect, it } from "vitest";
import {
	attributeProviderError,
	extractOpenAICompatibleGatewayError,
	extractResponseModelFromError,
	formatActionableGatewayError,
	formatProviderError,
	MAX_PROVIDER_ERROR_BODY_CHARS,
	normalizeProviderError,
} from "../src/utils/error-body.ts";

describe("normalizeProviderError", () => {
	it("extracts status and body from a Mistral-shaped error", () => {
		const error = Object.assign(new Error("Mistral request failed"), {
			statusCode: 403,
			body: '{"error":"blocked by gateway WAF"}',
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"error":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("reads the parsed body off an openai APIError when the message is opaque", () => {
		// makeMessage(status, error, message) yields "<status> status code (no body)"
		// when the parsed body is unparsed, while the body stays on error.error.
		const error = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: { error: "blocked by gateway WAF" },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"error":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("preserves the message when @google/genai already folds the body into it", () => {
		const body = { error: { code: 403, message: "Permission denied" } };
		const error = Object.assign(new Error(JSON.stringify(body)), {
			status: 403,
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.messageCarriesBody).toBe(true);
		expect(norm.message).toBe(JSON.stringify(body));
	});

	it("extracts status and body from a Bedrock-shaped ServiceException", () => {
		const error = Object.assign(new Error("UnknownError"), {
			name: "UnknownError",
			$metadata: { httpStatusCode: 403 },
			$response: { statusCode: 403, body: '{"message":"blocked by gateway WAF"}' },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(403);
		expect(norm.body).toBe('{"message":"blocked by gateway WAF"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("ignores a Bedrock response stream instead of serializing its internals", () => {
		const error = Object.assign(
			new Error("Invocation of model ID anthropic.claude-opus-5 with on-demand throughput isn't supported."),
			{
				name: "ValidationException",
				$metadata: { httpStatusCode: 400 },
				$response: {
					statusCode: 400,
					body: { pipe: () => undefined, _events: { close: [null, null] } },
				},
			},
		);

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(400);
		expect(norm.body).toBeUndefined();
		expect(norm.message).toContain("on-demand throughput isn't supported");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("ignores a class-instance response body without a pipe method instead of serializing it", () => {
		// Not every SDK response wrapper is a node stream: web ReadableStreams
		// and SDK-specific wrapper classes have no `pipe`, but serializing them
		// still yields internals-noise that would replace the real message.
		class SdkHttpResponseBody {
			locked = false;
			state = { storedError: undefined };
		}
		const error = Object.assign(new Error("Input is too long for requested model."), {
			name: "ValidationException",
			$metadata: { httpStatusCode: 400 },
			$response: { statusCode: 400, body: new SdkHttpResponseBody() },
		});

		const norm = normalizeProviderError(error);

		expect(norm.status).toBe(400);
		expect(norm.body).toBeUndefined();
		expect(norm.message).toContain("Input is too long");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("ignores a class-instance `error` field instead of serializing it", () => {
		class SdkInnerError {
			code = "EPROTO";
			internalState = {};
		}
		const error = Object.assign(new Error("TLS handshake failed"), {
			status: 502,
			error: new SdkInnerError(),
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBeUndefined();
		expect(norm.message).toBe("TLS handshake failed");
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("still surfaces a plain parsed JSON body object", () => {
		const error = Object.assign(new Error("400 status code (no body)"), {
			status: 400,
			error: { message: "schema validation failed", field: "tools[0]" },
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBe('{"message":"schema validation failed","field":"tools[0]"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("JSON-stringifies a non-Error thrown value", () => {
		const norm = normalizeProviderError({ reason: "boom" });

		expect(norm.status).toBeUndefined();
		expect(norm.body).toBeUndefined();
		expect(norm.message).toBe('{"reason":"boom"}');
		expect(norm.messageCarriesBody).toBe(false);
	});

	it("treats an empty parsed body object as no body", () => {
		const error = Object.assign(new Error("403 status code (no body)"), {
			status: 403,
			error: {},
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toBeUndefined();
		expect(norm.messageCarriesBody).toBe(true);
	});

	it("truncates the body at the cap", () => {
		const longBody = "x".repeat(MAX_PROVIDER_ERROR_BODY_CHARS + 50);
		const error = Object.assign(new Error("failed"), {
			statusCode: 500,
			body: longBody,
		});

		const norm = normalizeProviderError(error);

		expect(norm.body).toContain("... [truncated 50 chars]");
		expect(norm.body?.length).toBeLessThan(longBody.length);
	});

	it("sets messageCarriesBody when the message already contains the extracted body", () => {
		const error = Object.assign(new Error("500: upstream exploded"), {
			statusCode: 500,
			body: "upstream exploded",
		});

		const norm = normalizeProviderError(error);

		expect(norm.messageCarriesBody).toBe(true);
	});
});

describe("OpenAI-compatible gateway errors", () => {
	it.each([502, " 502 "])("uses an OpenAI error code when the SDK has no HTTP status", (code) => {
		const error = Object.assign(new Error("upstream failed"), {
			code,
			headers: new Headers({ "x-litellm-call-id": "call-1" }),
		});

		expect(normalizeProviderError(error).status).toBe(502);
		expect(extractOpenAICompatibleGatewayError(error)).toMatchObject({ status: 502, callId: "call-1" });
	});

	it("does not treat non-HTTP numeric strings as statuses", () => {
		const error = Object.assign(new Error("upstream failed"), { code: " 399 " });
		expect(normalizeProviderError(error).status).toBeUndefined();
	});

	it("extracts LiteLLM routing and attempt headers without inventing fallback counts", () => {
		const error = Object.assign(new Error("upstream failed"), {
			status: undefined,
			headers: new Headers({
				"x-litellm-call-id": "call-2",
				"x-request-id": "request-2",
				"x-litellm-model-id": "deployment-2",
				"x-litellm-model-name": "bedrock/anthropic.claude-sonnet",
				"x-litellm-model-region": "us",
				"x-litellm-attempted-retries": "2",
				"x-litellm-max-retries": "3",
			}),
		});

		expect(extractOpenAICompatibleGatewayError(error)).toEqual({
			callId: "call-2",
			requestId: "request-2",
			upstreamDeployment: "deployment-2",
			upstreamModel: "bedrock/anthropic.claude-sonnet",
			allowedRegion: "us",
			attemptedRetries: 2,
			maxRetries: 3,
		});
	});

	it("formats a one-line actionable headline from available metadata", () => {
		const headline = formatActionableGatewayError(
			{
				status: 503,
				callId: "call-3",
				upstreamDeployment: "deployment-3",
				upstreamModel: "bedrock/anthropic.claude-sonnet",
				allowedRegion: "eu",
				attemptedRetries: 2,
				maxRetries: 2,
			},
			{ provider: "gateway", id: "example-large" },
		);

		expect(headline).toContain("gateway/example-large");
		expect(headline).toContain("upstream status 503");
		expect(headline).toContain("deployment deployment-3");
		expect(headline).toContain("model bedrock/anthropic.claude-sonnet");
		expect(headline).toContain("allowed region eu");
		expect(headline).toContain("initial route");
		expect(headline).not.toContain(" at deployment");
		expect(headline).toContain("retry attempts 2/2");
		expect(headline).toContain("retry the request or choose another model");
		expect(headline).toContain("call ID call-3");
		expect(headline).not.toContain("gateway dashboard");
		expect(headline).not.toContain("fallback");
		expect(headline).not.toContain("\n");
	});
});

describe("formatProviderError", () => {
	it("surfaces status and body without a prefix", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("403 status code (no body)"), {
				status: 403,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		const formatted = formatProviderError(norm);

		expect(formatted).toContain("403");
		expect(formatted).toContain("blocked by gateway WAF");
		expect(formatted).not.toBe("403 status code (no body)");
	});

	it("applies a provider prefix with status and body", () => {
		const norm = normalizeProviderError(
			Object.assign(new Error("403 status code (no body)"), {
				status: 403,
				error: { error: "blocked by gateway WAF" },
			}),
		);

		expect(formatProviderError(norm, "OpenAI API error")).toBe(
			'OpenAI API error (403): {"error":"blocked by gateway WAF"}',
		);
	});

	it("preserves the message (with prefix + status) when it already carries the body", () => {
		const body = JSON.stringify({ error: { message: "Permission denied" } });
		const norm = normalizeProviderError(Object.assign(new Error(body), { status: 403 }));

		expect(formatProviderError(norm, "OpenAI API error")).toBe(`OpenAI API error (403): ${body}`);
	});

	it("returns the bare message for a non-Error value", () => {
		const norm = normalizeProviderError({ reason: "boom" });

		expect(formatProviderError(norm)).toBe('{"reason":"boom"}');
	});
});

describe("attributeProviderError", () => {
	const model = { provider: "gateway", id: "example-small" };
	const body = '400: {"error":{"type":"invalid_request_error","message":"Invalid effort level"}}';

	it("names the requested model and keeps the provider body intact", () => {
		expect(attributeProviderError(body, model)).toBe(`gateway/example-small: ${body}`);
	});

	it("names the serving model too when the gateway re-routed the request", () => {
		// The failure that motivated this: the body named `claude-fable-5`, the
		// session had selected `gateway/example-small`, and the message read as though a
		// model the user never picked had rejected the turn.
		expect(attributeProviderError(body, model, "claude-fable-5")).toBe(
			`gateway/example-small (gateway served claude-fable-5): ${body}`,
		);
	});

	it("ignores a serving model equal to the requested one", () => {
		expect(attributeProviderError(body, model, "example-small")).toBe(`gateway/example-small: ${body}`);
	});

	it("does not stack prefixes when a message is attributed twice", () => {
		const once = attributeProviderError(body, model);
		expect(attributeProviderError(once, model)).toBe(once);
		const withServed = attributeProviderError(body, model, "claude-fable-5");
		expect(attributeProviderError(withServed, model, "claude-fable-5")).toBe(withServed);
	});
});

describe("extractResponseModelFromError", () => {
	it("reads the serving model out of an OpenAI-shaped error envelope", () => {
		const error = Object.assign(new Error("400 Invalid effort level"), {
			error: { type: "invalid_request_error", message: "Invalid effort level", model: "claude-fable-5" },
		});

		expect(extractResponseModelFromError(error, "example-small")).toBe("claude-fable-5");
	});

	it("reads a top-level model field", () => {
		expect(extractResponseModelFromError({ model: "claude-fable-5" }, "example-small")).toBe("claude-fable-5");
	});

	it("returns undefined for a body that names nothing, the same model, or a non-string", () => {
		expect(extractResponseModelFromError(new Error("boom"), "example-small")).toBeUndefined();
		expect(extractResponseModelFromError({ model: "example-small" }, "example-small")).toBeUndefined();
		expect(extractResponseModelFromError({ model: 42 }, "example-small")).toBeUndefined();
		expect(extractResponseModelFromError(undefined, "example-small")).toBeUndefined();
	});
});
