import { asArray, asRecord, readNumber, readString } from "./json.ts";
import { McpError } from "./protocol.ts";

export interface McpElicitationUi {
	readonly hasUI: boolean;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
}

export type McpElicitationResult =
	| { action: "accept"; content: Record<string, string | number | boolean> }
	| { action: "decline" | "cancel" };

/** Handle MCP 2025-06-18 form-mode elicitation without exposing transport details to the UI layer. */
export async function elicitForm(
	params: Record<string, unknown>,
	ui: McpElicitationUi | undefined,
): Promise<McpElicitationResult> {
	if (!ui?.hasUI) {
		ui?.notify("An MCP server requested input, but this session has no interactive UI.", "warning");
		return { action: "cancel" };
	}
	if (params.mode === "url") throw invalidParams("URL-mode elicitation is not supported.");

	const message = readString(params, "message");
	const schema = asRecord(params.requestedSchema);
	const properties = asRecord(schema?.properties);
	if (!message || schema?.type !== "object" || !properties) {
		throw invalidParams("elicitation/create requires a message and an object requestedSchema.");
	}
	const required = new Set(
		(asArray(schema.required) ?? []).filter((value): value is string => typeof value === "string"),
	);
	const content: Record<string, string | number | boolean> = {};

	for (const [name, rawProperty] of Object.entries(properties)) {
		const property = asRecord(rawProperty);
		if (!property) throw invalidParams(`Invalid schema for field ${name}.`);
		const value = await promptProperty(ui, message, name, property, required.has(name));
		if (value === CANCEL) return { action: "cancel" };
		if (value !== OMIT) content[name] = value;
	}

	const decision = await ui.select(`${message}\n\nSubmit this response?`, ["Accept", "Decline"]);
	if (decision === undefined) return { action: "cancel" };
	if (decision === "Decline") return { action: "decline" };
	return { action: "accept", content };
}

const CANCEL = Symbol("cancel");
const OMIT = Symbol("omit");
type PromptResult = string | number | boolean | typeof CANCEL | typeof OMIT;

async function promptProperty(
	ui: McpElicitationUi,
	message: string,
	name: string,
	property: Record<string, unknown>,
	required: boolean,
): Promise<PromptResult> {
	const type = readString(property, "type");
	const title = readString(property, "title") ?? name;
	const description = readString(property, "description");
	const prompt = `${message}\n\n${title}${required ? " (required)" : ""}${description ? ` — ${description}` : ""}`;
	const enumValues = asArray(property.enum);

	if (enumValues) {
		if (!enumValues.every((value) => typeof value === "string"))
			throw invalidParams(`${name} has a non-string enum.`);
		const enumNames = asArray(property.enumNames);
		const labels = enumValues.map((value, index) =>
			typeof enumNames?.[index] === "string" ? String(enumNames[index]) : String(value),
		);
		if (!required) labels.push("Skip");
		const selected = await ui.select(prompt, labels);
		if (selected === undefined) return CANCEL;
		if (!required && selected === "Skip") return OMIT;
		return String(enumValues[labels.indexOf(selected)]);
	}

	if (type === "boolean") {
		const labels = required ? ["Yes", "No"] : ["Yes", "No", "Skip"];
		const selected = await ui.select(prompt, labels);
		if (selected === undefined) return CANCEL;
		if (selected === "Skip") return OMIT;
		return selected === "Yes";
	}

	if (type !== "string" && type !== "number" && type !== "integer") {
		throw invalidParams(`${name} has unsupported type ${type ?? "unknown"}.`);
	}

	const placeholder = inputPlaceholder(property, required);
	for (;;) {
		const raw = await ui.input(prompt, placeholder);
		if (raw === undefined) return CANCEL;
		if (raw === "" && !required) return OMIT;
		const validated = validateInput(name, raw, type, property);
		if (validated.ok) return validated.value;
		ui.notify(validated.message, "warning");
	}
}

function inputPlaceholder(property: Record<string, unknown>, required: boolean): string {
	const defaultValue = property.default;
	if (typeof defaultValue === "string" || typeof defaultValue === "number") return String(defaultValue);
	const format = readString(property, "format");
	return format
		? `Enter ${format}${required ? "" : " (blank to skip)"}`
		: required
			? "Enter a value"
			: "Blank to skip";
}

type Validation = { ok: true; value: string | number } | { ok: false; message: string };

function validateInput(
	name: string,
	raw: string,
	type: "string" | "number" | "integer",
	property: Record<string, unknown>,
): Validation {
	if (type === "string") {
		const minLength = readNumber(property, "minLength");
		const maxLength = readNumber(property, "maxLength");
		if (minLength !== undefined && raw.length < minLength)
			return invalid(`${name} must be at least ${minLength} characters.`);
		if (maxLength !== undefined && raw.length > maxLength)
			return invalid(`${name} must be at most ${maxLength} characters.`);
		const format = readString(property, "format");
		if (format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw))
			return invalid(`${name} must be an email address.`);
		if (format === "uri") {
			try {
				new URL(raw);
			} catch {
				return invalid(`${name} must be a URI.`);
			}
		}
		if (format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return invalid(`${name} must be a date (YYYY-MM-DD).`);
		if (format === "date-time" && Number.isNaN(Date.parse(raw))) return invalid(`${name} must be a date and time.`);
		return { ok: true, value: raw };
	}

	const value = Number(raw);
	if (!Number.isFinite(value) || (type === "integer" && !Number.isInteger(value))) {
		return invalid(`${name} must be ${type === "integer" ? "an integer" : "a number"}.`);
	}
	const minimum = readNumber(property, "minimum");
	const maximum = readNumber(property, "maximum");
	if (minimum !== undefined && value < minimum) return invalid(`${name} must be at least ${minimum}.`);
	if (maximum !== undefined && value > maximum) return invalid(`${name} must be at most ${maximum}.`);
	return { ok: true, value };
}

function invalid(message: string): Validation {
	return { ok: false, message };
}

function invalidParams(message: string): McpError {
	return new McpError(message, -32602);
}
