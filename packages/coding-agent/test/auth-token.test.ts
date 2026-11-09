import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import lockfile from "proper-lockfile";
import { afterEach, describe, expect, test } from "vitest";
import {
	AUTH_TOKEN_BASE_URL,
	type AuthTokenCommandIo,
	formatAuthTokenOutput,
	resolveAuthToken,
	runAuthTokenCommand,
} from "../src/cli/auth-token.ts";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const sourceResolverUrl = pathToFileURL(resolve(__dirname, "../src/experimental/source-resolver.ts")).href;
const subprocessTempDirs: string[] = [];

afterEach(() => {
	for (const directory of subprocessTempDirs.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function snapshotTree(root: string): string[] {
	const entries: string[] = [];
	const visit = (directory: string, relativeDirectory: string): void => {
		entries.push(`directory:${relativeDirectory}`);
		for (const name of readdirSync(directory).sort()) {
			const path = join(directory, name);
			const relativePath = join(relativeDirectory, name);
			if (statSync(path).isDirectory()) {
				visit(path, relativePath);
			} else {
				entries.push(`file:${relativePath}:${readFileSync(path).toString("base64")}`);
			}
		}
	};
	visit(root, ".");
	return entries;
}

async function runRealCli(options: {
	args: string[];
	auth?: string;
	models?: string;
}): Promise<{ code: number | null; stdout: string; stderr: string; filesUnchanged: boolean; root: string }> {
	const root = mkdtempSync(join(tmpdir(), "phi-auth-token-"));
	subprocessTempDirs.push(root);
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	if (options.auth !== undefined) writeFileSync(join(agentDir, "auth.json"), options.auth, "utf8");
	if (options.models !== undefined) writeFileSync(join(agentDir, "models.json"), options.models, "utf8");
	const before = snapshotTree(root);
	const env = {
		...process.env,
		[ENV_AGENT_DIR]: agentDir,
	};
	delete env.PI_CODING_AGENT_DIR;

	return await new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", sourceResolverUrl, cliPath, ...options.args], {
			cwd: root,
			env,
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({
				code,
				stdout,
				stderr,
				filesUnchanged: JSON.stringify(snapshotTree(root)) === JSON.stringify(before),
				root,
			});
		});
		child.stdin.end();
	});
}

function runCommand(
	args: string[],
	options: Omit<AuthTokenCommandIo, "writeStdout" | "writeStderr"> & {
		content?: string;
	},
): { exitCode: number | undefined; stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	const { content, ...io } = options;
	const exitCode = runAuthTokenCommand(args, {
		...io,
		readFile: io.readFile ?? (() => content ?? "{}"),
		writeStdout: (output) => {
			stdout += output;
		},
		writeStderr: (output) => {
			stderr += output;
		},
	});
	return { exitCode, stdout, stderr };
}

describe("auth token command", () => {
	test("returns the configured gateway API key as text", () => {
		const result = runCommand(["auth", "token"], {
			stdoutIsTTY: false,
			content: JSON.stringify({ gateway: { type: "api_key", key: "gateway-api-key" } }),
		});

		expect(result).toEqual({ exitCode: 0, stdout: "gateway-api-key\n", stderr: "" });
	});

	test("returns only the expected JSON schema", () => {
		const result = runCommand(["auth", "token", "--json"], {
			stdoutIsTTY: false,
			content: JSON.stringify({ gateway: { type: "api_key", key: "gateway-api-key" } }),
		});

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(JSON.parse(result.stdout)).toEqual({
			schemaVersion: 1,
			token: "gateway-api-key",
			provider: "gateway",
			baseUrl: AUTH_TOKEN_BASE_URL,
			expiresAt: null,
		});
	});

	test("resolves environment templates without writing or exporting anything", () => {
		let reads = 0;
		const resolution = resolveAuthToken({
			env: {},
			readFile: () => {
				reads++;
				return JSON.stringify({ gateway: { type: "api_key", key: "prefix-$GATEWAY_KEY" } });
			},
		});

		expect(resolution).toEqual({ status: "not_logged_in" });
		expect(reads).toBe(2);

		expect(
			resolveAuthToken({
				env: { GATEWAY_KEY: "from-environment" },
				readFile: () => JSON.stringify({ gateway: { type: "api_key", key: "prefix-$GATEWAY_KEY" } }),
			}),
		).toEqual({ status: "success", token: "prefix-from-environment" });
	});

	test("treats a missing auth store as not logged in", () => {
		const result = runCommand(["auth", "token"], {
			stdoutIsTTY: false,
			readFile: () => {
				const error = Object.assign(new Error("missing"), { code: "ENOENT" });
				throw error;
			},
		});

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("no usable gateway API key");
	});

	test("reports malformed and unreadable auth stores distinctly", () => {
		expect(
			runCommand(["auth", "token"], {
				stdoutIsTTY: false,
				content: "{not-json",
			}),
		).toMatchObject({ exitCode: 3, stdout: "" });

		const unreadable = runCommand(["auth", "token"], {
			stdoutIsTTY: false,
			readFile: () => {
				const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
				throw error;
			},
		});
		expect(unreadable.exitCode).toBe(3);
		expect(unreadable.stdout).toBe("");
	});

	test("retries a transient partial auth-store read before reporting malformed", () => {
		let reads = 0;
		const resolution = resolveAuthToken({
			readFile: () => {
				reads++;
				return reads === 1
					? '{"gateway":{"type":"api_key","key":"gateway-api-key"'
					: '{"gateway":{"type":"api_key","key":"gateway-api-key"}}';
			},
		});

		expect(resolution).toEqual({ status: "success", token: "gateway-api-key" });
		expect(reads).toBe(4);
	});

	test("does not read while the auth store is locked", () => {
		let checks = 0;
		let reads = 0;
		const resolution = resolveAuthToken({
			authPath: "/tmp/auth-token-test/auth.json",
			checkLock: () => {
				checks++;
				return checks === 1;
			},
			readFile: () => {
				reads++;
				return JSON.stringify({ gateway: { type: "api_key", key: "gateway-api-key" } });
			},
		});

		expect(resolution).toEqual({ status: "success", token: "gateway-api-key" });
		expect(reads).toBe(2);
	});

	test("retries until two stable reads agree", () => {
		let reads = 0;
		const snapshots = [
			JSON.stringify({ gateway: { type: "api_key", key: "old-key" } }),
			JSON.stringify({ gateway: { type: "api_key", key: "new-key" } }),
			JSON.stringify({ gateway: { type: "api_key", key: "new-key" } }),
			JSON.stringify({ gateway: { type: "api_key", key: "new-key" } }),
		];
		const resolution = resolveAuthToken({
			checkLock: () => false,
			readFile: () => snapshots[reads++] ?? snapshots[snapshots.length - 1],
		});

		expect(resolution).toEqual({ status: "success", token: "new-key" });
		expect(reads).toBe(4);
	});

	test("never accepts a partial snapshot observed while a writer holds the lock", () => {
		let checks = 0;
		let reads = 0;
		const partial = '{"gateway":{"type":"api_key","key":"partial"';
		const complete = JSON.stringify({ gateway: { type: "api_key", key: "complete-key" } });
		const resolution = resolveAuthToken({
			checkLock: () => {
				checks++;
				return checks === 2;
			},
			readFile: () => {
				reads++;
				return reads === 1 ? partial : complete;
			},
		});

		expect(resolution).toEqual({ status: "success", token: "complete-key" });
		expect(reads).toBe(3);
	});

	test("returns malformed without output when the auth store stays locked", () => {
		let reads = 0;
		const result = runCommand(["auth", "token"], {
			stdoutIsTTY: false,
			checkLock: () => true,
			readFile: () => {
				reads++;
				return JSON.stringify({ gateway: { type: "api_key", key: "must-not-print" } });
			},
		});

		expect(result).toEqual({
			exitCode: 3,
			stdout: "",
			stderr: "Error: auth store is malformed or unreadable\n",
		});
		expect(reads).toBe(0);
	});

	test("honors the real auth writer lock without creating or changing files", () => {
		const agentDir = mkdtempSync(join(tmpdir(), "phi-auth-token-lock-"));
		subprocessTempDirs.push(agentDir);
		const authPath = join(agentDir, "auth.json");
		writeFileSync(authPath, JSON.stringify({ gateway: { type: "api_key", key: "must-not-print" } }));
		const release = lockfile.lockSync(authPath, { realpath: false });
		const before = readFileSync(authPath, "utf8");

		try {
			expect(resolveAuthToken({ authPath })).toEqual({ status: "malformed" });
			expect(readFileSync(authPath, "utf8")).toBe(before);
		} finally {
			release();
		}
	});

	test.skipIf(process.platform === "win32")("honors realpath locks through a symlinked agent directory", () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "phi-auth-token-symlink-lock-"));
		subprocessTempDirs.push(tempRoot);
		const realAgentDir = join(tempRoot, "real-agent");
		const linkedAgentDir = join(tempRoot, "linked-agent");
		mkdirSync(realAgentDir);
		symlinkSync(realAgentDir, linkedAgentDir, "dir");
		const realAuthPath = join(realAgentDir, "auth.json");
		const linkedAuthPath = join(linkedAgentDir, "auth.json");
		writeFileSync(realAuthPath, JSON.stringify({ gateway: { type: "api_key", key: "must-not-print" } }));
		const release = lockfile.lockSync(linkedAuthPath);

		try {
			expect(resolveAuthToken({ authPath: linkedAuthPath })).toEqual({ status: "malformed" });
		} finally {
			release();
		}
	});

	test("refuses to print to a TTY without exposing the token", () => {
		let read = false;
		const result = runCommand(["auth", "token"], {
			stdoutIsTTY: true,
			readFile: () => {
				read = true;
				return JSON.stringify({ gateway: { type: "api_key", key: "do-not-print" } });
			},
		});

		expect(result.exitCode).toBe(4);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("do-not-print");
		expect(read).toBe(false);
	});

	test("allows TTY output only with --force", () => {
		const result = runCommand(["auth", "token", "--force"], {
			stdoutIsTTY: true,
			content: JSON.stringify({ gateway: { type: "api_key", key: "forced-token" } }),
		});

		expect(result).toEqual({ exitCode: 0, stdout: "forced-token\n", stderr: "" });
	});

	test("does not expose OAuth credentials or refresh them", () => {
		const oauth = {
			type: "oauth",
			access: "oauth-access-must-not-print",
			refresh: "oauth-refresh-must-not-print",
			expires: 0,
		};
		const result = runCommand(["auth", "token", "--json"], {
			stdoutIsTTY: false,
			content: JSON.stringify({ gateway: oauth }),
		});

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain(oauth.access);
		expect(result.stderr).not.toContain(oauth.refresh);
	});

	test("does not execute command-backed API-key references", () => {
		const result = runCommand(["auth", "token"], {
			stdoutIsTTY: false,
			content: JSON.stringify({ gateway: { type: "api_key", key: "!printf should-not-run" } }),
		});

		expect(result.exitCode).toBe(2);
		expect(result.stdout).toBe("");
		expect(result.stderr).not.toContain("should-not-run");
	});

	test("rejects invalid options with exit code 1", () => {
		const result = runCommand(["auth", "token", "--bogus"], {
			stdoutIsTTY: false,
			readFile: () => {
				throw new Error("must not read on invalid usage");
			},
		});

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("Unknown option");
	});

	test("reports missing or wrong gateway credentials as not logged in", () => {
		expect(
			runCommand(["auth", "token"], {
				stdoutIsTTY: false,
				content: JSON.stringify({ openai: { type: "api_key", key: "other-provider-key" } }),
			}),
		).toMatchObject({ exitCode: 2, stdout: "" });

		expect(
			runCommand(["auth", "token"], {
				stdoutIsTTY: false,
				content: JSON.stringify({ gateway: { type: "api_key" } }),
			}),
		).toMatchObject({ exitCode: 2, stdout: "" });
	});

	test("supports help without reading the auth store or refusing a TTY", () => {
		const result = runCommand(["auth", "token", "--help"], {
			stdoutIsTTY: true,
			readFile: () => {
				throw new Error("help must not read the auth store");
			},
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("Usage:\n  phi auth token [--json] [--force]");
		expect(result.stderr).toBe("");
	});

	test("subprocess prints exact text output and leaves the agent directory unchanged", async () => {
		const result = await runRealCli({
			args: ["auth", "token"],
			auth: JSON.stringify({ gateway: { type: "api_key", key: "gateway-api-key" } }),
		});

		expect(result).toMatchObject({ code: 0, stdout: "gateway-api-key\n", stderr: "", filesUnchanged: true });
	});

	test("subprocess prints the fixed schemaVersion 1 JSON contract", async () => {
		const result = await runRealCli({
			args: ["auth", "token", "--json"],
			auth: JSON.stringify({ gateway: { type: "api_key", key: "gateway-api-key" } }),
		});

		expect(result).toMatchObject({
			code: 0,
			stdout: `{"schemaVersion":1,"token":"gateway-api-key","provider":"gateway","baseUrl":"${AUTH_TOKEN_BASE_URL}","expiresAt":null}\n`,
			stderr: "",
			filesUnchanged: true,
		});
	});

	test("subprocess handles help, missing, malformed, and OAuth stores without startup writes", async () => {
		const help = await runRealCli({ args: ["auth", "token", "--help"] });
		expect(help).toMatchObject({ code: 0, stderr: "", filesUnchanged: true });
		expect(help.stdout).toContain("Usage:\n  phi auth token [--json] [--force]");

		const authHelp = await runRealCli({ args: ["auth", "--help"] });
		expect(authHelp).toMatchObject({ code: 0, stderr: "", filesUnchanged: true });
		expect(authHelp.stdout).toContain("phi auth token [--json] [--force]");

		const globalHelp = await runRealCli({ args: ["--help"] });
		expect(globalHelp).toMatchObject({ code: 0, stderr: "" });
		expect(globalHelp.stdout).toContain("phi auth token [options]");

		const missing = await runRealCli({ args: ["auth", "token"] });
		expect(missing).toMatchObject({
			code: 2,
			stdout: "",
			stderr: "Error: no usable gateway API key is configured\n",
			filesUnchanged: true,
		});

		const malformed = await runRealCli({ args: ["auth", "token"], auth: "{not-json" });
		expect(malformed).toMatchObject({
			code: 3,
			stdout: "",
			stderr: "Error: auth store is malformed or unreadable\n",
			filesUnchanged: true,
		});

		const oauth = await runRealCli({
			args: ["auth", "token"],
			auth: JSON.stringify({ gateway: { type: "oauth", access: "must-not-print", refresh: "must-not-print" } }),
		});
		expect(oauth).toMatchObject({
			code: 2,
			stdout: "",
			stderr: "Error: no usable gateway API key is configured\n",
			filesUnchanged: true,
		});
	});

	test("subprocess ignores provider/model-only credentials", async () => {
		const result = await runRealCli({
			args: ["auth", "token"],
			models: JSON.stringify({ providers: { gateway: { apiKey: "model-config-only" } } }),
		});

		expect(result).toMatchObject({
			code: 2,
			stdout: "",
			stderr: "Error: no usable gateway API key is configured\n",
			filesUnchanged: true,
		});
	});

	test("subprocess does not execute a command-backed key reference", async () => {
		const sentinelRoot = mkdtempSync(join(tmpdir(), "phi-auth-token-sentinel-"));
		subprocessTempDirs.push(sentinelRoot);
		const sentinel = join(sentinelRoot, "sentinel");
		const result = await runRealCli({
			args: ["auth", "token"],
			auth: JSON.stringify({ gateway: { type: "api_key", key: `!touch ${sentinel}` } }),
		});

		expect(result).toMatchObject({
			code: 2,
			stdout: "",
			stderr: "Error: no usable gateway API key is configured\n",
			filesUnchanged: true,
		});
		expect(existsSync(sentinel)).toBe(false);
	});

	test("formats text and JSON output with one trailing newline", () => {
		expect(formatAuthTokenOutput("token", false)).toBe("token\n");
		expect(formatAuthTokenOutput("token", true).endsWith("\n")).toBe(true);
	});
});
