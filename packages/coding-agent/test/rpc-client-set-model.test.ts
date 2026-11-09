import { describe, expect, it, vi } from "vitest";
import { RpcClient } from "../src/modes/rpc/rpc-client.ts";

type SetModelCommand = {
	type: "set_model";
	provider: string;
	modelId: string;
	persist?: boolean;
};

type RpcClientPrivate = {
	send: (command: SetModelCommand) => Promise<unknown>;
	getData: <T>(response: unknown) => T;
};

function createClientWithSendSpy(): {
	client: RpcClient;
	send: ReturnType<typeof vi.fn<(command: SetModelCommand) => Promise<unknown>>>;
} {
	const client = new RpcClient();
	const privateClient = client as unknown as RpcClientPrivate;
	const send = vi.fn(async () => ({
		type: "response",
		command: "set_model",
		success: true,
		data: { provider: "faux", id: "faux-2" },
	}));
	privateClient.send = send;
	privateClient.getData = <T>(response: unknown): T => {
		return (response as { data: T }).data;
	};
	return { client, send };
}

describe("RpcClient setModel", () => {
	it("omits persist by default", async () => {
		const { client, send } = createClientWithSendSpy();

		await client.setModel("faux", "faux-2");

		expect(send).toHaveBeenCalledWith({ type: "set_model", provider: "faux", modelId: "faux-2" });
	});

	it("serializes persist false", async () => {
		const { client, send } = createClientWithSendSpy();

		await client.setModel("faux", "faux-2", false);

		expect(send).toHaveBeenCalledWith({
			type: "set_model",
			provider: "faux",
			modelId: "faux-2",
			persist: false,
		});
	});
});
