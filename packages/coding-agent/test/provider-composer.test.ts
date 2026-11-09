import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

function writeModels(root: string, model: unknown): string {
	const path = join(root, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				gateway: {
					baseUrl: "https://gateway.example.com",
					api: "openai-completions",
					apiKey: "test-key",
					models: [model],
				},
			},
		}),
	);
	return path;
}

describe("models.json model composition", () => {
	it("carries a valid compaction soft ceiling onto the resolved Model", async () => {
		const root = mkdtempSync(join(tmpdir(), "phi-provider-composer-"));
		try {
			const config = await ModelConfig.load(
				writeModels(root, { id: "configured", compaction: { softCeilingTokens: 300_000 } }),
			);
			const provider = composeModelProvider("gateway", undefined, config, undefined);

			expect(provider.getModels()[0]?.compaction).toEqual({ softCeilingTokens: 300_000 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each([-1, 1.5, "300000"])("drops an invalid compaction soft ceiling (%s)", async (softCeilingTokens) => {
		const root = mkdtempSync(join(tmpdir(), "phi-provider-composer-"));
		try {
			const config = await ModelConfig.load(
				writeModels(root, { id: "configured", compaction: { softCeilingTokens } }),
			);
			const provider = composeModelProvider("gateway", undefined, config, undefined);

			expect(provider.getModels()[0]?.compaction).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
