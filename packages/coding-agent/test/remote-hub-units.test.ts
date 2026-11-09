import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseRemoteArgs } from "../src/remote/cli.ts";
import {
	buildPushBody,
	createApnsJwt,
	loadApnsConfig,
	loadApnsKey,
	setupApns,
	shouldDropRegistration,
} from "../src/remote/hub/apns.ts";
import { DeviceStore, hashToken } from "../src/remote/hub/devices.ts";
import { buildPairLink } from "../src/remote/hub/hub.ts";
import { attachNdjsonReader } from "../src/remote/hub/ndjson.ts";
import { isTailscaleIPv4, pairingUrls, parseMagicDnsName, tailscaleIPv4s } from "../src/remote/hub/network.ts";
import { CROCKFORD_ALPHABET, normalizePairCode, PairCodes, RateLimiter } from "../src/remote/hub/pairing.ts";
import { mergeRecentCwds, readRecentSessionCwds } from "../src/remote/hub/recent-cwds.ts";
import {
	buildLaunchdPlist,
	buildSystemdUnit,
	LAUNCHD_LABEL,
	serviceEnvironment,
	systemdQuote,
} from "../src/remote/hub/service.ts";
import {
	buildSpawnArgs,
	cleanChildEnv,
	isSafeModelArg,
	isSpawnThinkingLevel,
	resolvePhiInvocation,
	rpcAutoResponse,
	validateSpawnCwd,
} from "../src/remote/hub/spawn.ts";
import { hubSocketPath, remoteDir } from "../src/remote/paths.ts";
import { colorizeQrLines, renderQrLines } from "../src/remote/qr.ts";
import { QrCode } from "../src/remote/qrcodegen.ts";

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "phi-remote-units-"));
	vi.stubEnv("PI_REMOTE_DIR", tmp);
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

describe("paths", () => {
	it("honors PI_REMOTE_DIR", () => {
		expect(remoteDir()).toBe(tmp);
		expect(hubSocketPath()).toBe(join(tmp, "hub.sock"));
	});
});

describe("pairing codes", () => {
	it("generates 8-char Crockford codes without I/L/O/U", () => {
		const codes = new PairCodes();
		for (let i = 0; i < 50; i++) {
			const { code } = codes.create();
			expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
			for (const ch of code) expect(CROCKFORD_ALPHABET).toContain(ch);
		}
	});

	it("normalises case, spaces, dashes and Crockford look-alikes", () => {
		expect(normalizePairCode(" k7q2-m9xd ")).toBe("K7Q2M9XD");
		expect(normalizePairCode("O0Il1abc")).toBe("00111ABC");
		expect(normalizePairCode("SHORT")).toBeUndefined();
		expect(normalizePairCode("ABCDEFGU")).toBeUndefined(); // U is not in the alphabet
		expect(normalizePairCode(42)).toBeUndefined();
	});

	it("redeems a good code once; rejects bad, reused and expired codes", () => {
		const codes = new PairCodes(1000);
		const { code } = codes.create(0);
		expect(codes.redeem("ZZZZZZZZ", 10)).toBe(false);
		expect(codes.redeem(code.toLowerCase(), 10)).toBe(true);
		expect(codes.redeem(code, 20)).toBe(false); // single use
		const { code: late } = codes.create(0);
		expect(codes.redeem(late, 1000)).toBe(false); // expired at TTL
	});

	it("rate-limits per key in a sliding window", () => {
		const limiter = new RateLimiter(5, 60_000);
		for (let i = 0; i < 5; i++) expect(limiter.take("1.2.3.4", i)).toBe(true);
		expect(limiter.take("1.2.3.4", 10)).toBe(false);
		expect(limiter.take("5.6.7.8", 10)).toBe(true);
		expect(limiter.take("1.2.3.4", 60_001)).toBe(true);
	});
});

describe("device store", () => {
	it("stores only token hashes (0600) and verifies tokens", () => {
		const store = new DeviceStore(join(tmp, "devices.json"));
		const { device, token } = store.add("demo phone", "ios");
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
		const raw = readFileSync(join(tmp, "devices.json"), "utf8");
		expect(raw).not.toContain(token);
		expect(raw).toContain(hashToken(token));
		expect(statSync(join(tmp, "devices.json")).mode & 0o777).toBe(0o600);
		expect(store.verify(token)?.id).toBe(device.id);
		expect(store.verify(`${token}x`)).toBeUndefined();
		expect(store.verify(undefined)).toBeUndefined();
		const reloaded = new DeviceStore(join(tmp, "devices.json"));
		expect(reloaded.verify(token)?.name).toBe("demo phone");
		expect(reloaded.remove(device.id)).toBe(true);
		expect(reloaded.verify(token)).toBeUndefined();
	});
});

describe("QR rendering", () => {
	it("encodes in the smallest version at ECC >= M", () => {
		const qr = QrCode.encodeText("hello", "M");
		expect(qr.version).toBe(1);
		expect(qr.size).toBe(21);
		expect(["M", "Q", "H"]).toContain(qr.errorCorrectionLevel);
		const link =
			"phiremote://pair?v=1&code=K7Q2M9XD&name=demo-laptop&hubId=0123456789abcdef&url=http%3A%2F%2F100.127.0.1%3A7717";
		expect(QrCode.encodeText(link, "M").version).toBeGreaterThan(5);
	});

	it("draws finder patterns at three corners", () => {
		const qr = QrCode.encodeText("phi remote");
		for (const [x0, y0] of [
			[0, 0],
			[qr.size - 7, 0],
			[0, qr.size - 7],
		]) {
			for (let i = 0; i < 7; i++) {
				expect(qr.getModule(x0 + i, y0)).toBe(true); // top edge of the finder
				expect(qr.getModule(x0, y0 + i)).toBe(true);
			}
			expect(qr.getModule(x0 + 1, y0 + 1)).toBe(false); // light ring
			expect(qr.getModule(x0 + 3, y0 + 3)).toBe(true); // dark center
		}
	});

	it("renders half-block lines with a light quiet zone for dark terminals", () => {
		const qr = QrCode.encodeText("phi");
		const lines = renderQrLines("phi");
		const total = qr.size + 4;
		expect(lines.length).toBe(Math.ceil(total / 2));
		for (const line of lines) {
			expect([...line].length).toBe(total);
			expect(line).toMatch(/^[ ▀▄█]+$/);
		}
		// Quiet zone is light, drawn as glyphs on a dark background.
		expect(lines[0]).toBe("█".repeat(total));
		// Top-left finder corner is dark → space, starting after the 2-module margin.
		expect([...lines[1]][2]).toBe(" ");
		const light = renderQrLines("phi", { background: "light" });
		expect(light[0]).toBe(" ".repeat(total));
		expect(colorizeQrLines(["ab"])[0]).toBe("\x1b[97;40mab\x1b[0m");
	});

	it("builds the deep link with repeated, encoded url parameters", () => {
		expect(
			buildPairLink({
				code: "K7Q2M9XD",
				name: "demo-laptop",
				hubId: "abc",
				urls: ["http://demo-laptop.tail.ts.net:7717", "http://100.127.0.1:7717"],
			}),
		).toBe(
			"phiremote://pair?v=1&code=K7Q2M9XD&name=demo-laptop&hubId=abc&url=http%3A%2F%2Fdemo-laptop.tail.ts.net%3A7717&url=http%3A%2F%2F100.127.0.1%3A7717",
		);
	});
});

describe("network", () => {
	const ifaces = {
		lo0: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
		utun4: [{ address: "100.127.0.1", family: "IPv4", internal: false }],
		en0: [
			{ address: "192.0.2.20", family: "IPv4", internal: false },
			{ address: "fe80::1", family: "IPv6", internal: false },
		],
	} as never;

	it("detects Tailscale CGNAT addresses", () => {
		expect(isTailscaleIPv4("100.64.0.1")).toBe(true);
		expect(isTailscaleIPv4("100.127.255.254")).toBe(true);
		expect(isTailscaleIPv4("100.128.0.1")).toBe(false);
		expect(isTailscaleIPv4("100.63.0.1")).toBe(false);
		expect(isTailscaleIPv4("192.0.2.1")).toBe(false);
		expect(tailscaleIPv4s(ifaces)).toEqual(["100.127.0.1"]);
	});

	it("orders pairing URLs: MagicDNS, Tailscale, LAN; loopback only when explicitly loopback-only", () => {
		expect(
			pairingUrls({ port: 7717, binds: ["127.0.0.1", "100.127.0.1"], magicDns: "demo-laptop.tail.ts.net", ifaces }),
		).toEqual(["http://demo-laptop.tail.ts.net:7717", "http://100.127.0.1:7717"]);
		expect(pairingUrls({ port: 7717, binds: ["0.0.0.0"], ifaces })).toEqual([
			"http://100.127.0.1:7717",
			"http://192.0.2.20:7717",
		]);
		expect(pairingUrls({ port: 7717, binds: ["127.0.0.1"], ifaces })).toEqual([]);
		expect(pairingUrls({ port: 7717, binds: ["127.0.0.1"], explicitBinds: true, ifaces })).toEqual([
			"http://127.0.0.1:7717",
		]);
	});

	it("parses Self.DNSName from tailscale status --json", () => {
		expect(parseMagicDnsName(JSON.stringify({ Self: { DNSName: "demo-laptop.tail1234.ts.net." } }))).toBe(
			"demo-laptop.tail1234.ts.net",
		);
		expect(parseMagicDnsName(JSON.stringify({ Self: {} }))).toBeUndefined();
		expect(parseMagicDnsName("not json")).toBeUndefined();
	});
});

describe("headless spawn", () => {
	it("re-runs node + cli.js/cli.ts (keeping loaders) and a compiled binary as itself", () => {
		expect(
			resolvePhiInvocation({
				execPath: "/usr/bin/node",
				argv: ["/usr/bin/node", "/opt/phi/dist/cli.js"],
				execArgv: [],
			}),
		).toEqual({ command: "/usr/bin/node", args: ["/opt/phi/dist/cli.js"] });
		expect(
			resolvePhiInvocation({
				execPath: "/usr/bin/node",
				argv: ["/usr/bin/node", "/src/phi/packages/coding-agent/src/cli.ts"],
				execArgv: ["--import", "tsx", "--inspect=9229"],
			}),
		).toEqual({ command: "/usr/bin/node", args: ["--import", "tsx", "/src/phi/packages/coding-agent/src/cli.ts"] });
		expect(
			resolvePhiInvocation({
				execPath: "/Users/me/.local/bin/phi",
				argv: ["bun", "/$bunfs/root/cli.js"],
				execArgv: [],
			}),
		).toEqual({ command: "/Users/me/.local/bin/phi", args: [] });
		expect(
			resolvePhiInvocation({
				execPath: "/Users/me/.local/bin/phi",
				argv: ["/Users/me/.local/bin/phi", "remote"],
				execArgv: [],
			}),
		).toEqual({ command: "/Users/me/.local/bin/phi", args: [] });
	});

	it("builds --mode rpc arguments with an optional model", () => {
		const base = { command: "node", args: ["/x/cli.js"] };
		expect(buildSpawnArgs(base)).toEqual(["/x/cli.js", "--mode", "rpc"]);
		expect(buildSpawnArgs(base, { provider: "anthropic", modelId: "claude-opus-5-5" })).toEqual([
			"/x/cli.js",
			"--mode",
			"rpc",
			"--model",
			"anthropic/claude-opus-5-5",
		]);
		expect(buildSpawnArgs({ command: "/bin/phi", args: [] }, { modelId: "example-medium" })).toEqual([
			"--mode",
			"rpc",
			"--model",
			"example-medium",
		]);
		expect(buildSpawnArgs(base, { provider: "openai" })).toEqual([
			"/x/cli.js",
			"--mode",
			"rpc",
			"--provider",
			"openai",
		]);
		expect(
			buildSpawnArgs(base, { provider: "anthropic", modelId: "claude-opus-5-5", thinkingLevel: "high" }),
		).toEqual(["/x/cli.js", "--mode", "rpc", "--model", "anthropic/claude-opus-5-5", "--thinking", "high"]);
		expect(buildSpawnArgs({ command: "/bin/phi", args: [] }, { thinkingLevel: "max" })).toEqual([
			"--mode",
			"rpc",
			"--thinking",
			"max",
		]);
		// session.resume: the file, then the folder to run it in; never without the file, never relative.
		expect(
			buildSpawnArgs({ command: "/bin/phi", args: [] }, { sessionFile: "/s/a.jsonl", sessionCwd: "/home/u/x" }),
		).toEqual(["--mode", "rpc", "--session", "/s/a.jsonl", "--session-cwd", "/home/u/x"]);
		expect(buildSpawnArgs({ command: "/bin/phi", args: [] }, { sessionCwd: "/home/u/x" })).toEqual(["--mode", "rpc"]);
		expect(
			buildSpawnArgs({ command: "/bin/phi", args: [] }, { sessionFile: "/s/a.jsonl", sessionCwd: "rel" }),
		).toEqual(["--mode", "rpc", "--session", "/s/a.jsonl"]);
		// Never passed on unless it is one of phi's levels.
		expect(buildSpawnArgs({ command: "/bin/phi", args: [] }, { thinkingLevel: "--help" })).toEqual(["--mode", "rpc"]);
		expect(buildSpawnArgs({ command: "/bin/phi", args: [] }, { thinkingLevel: "bogus" })).toEqual(["--mode", "rpc"]);
		for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
			expect(isSpawnThinkingLevel(level)).toBe(true);
		}
		for (const level of ["bogus", "", "HIGH", " high", "high ", "--thinking", 3, null, undefined, ["high"]]) {
			expect(isSpawnThinkingLevel(level)).toBe(false);
		}
		expect(isSafeModelArg("claude-opus-5-5:high")).toBe(true);
		expect(isSafeModelArg("--help")).toBe(false);
		expect(isSafeModelArg("a b")).toBe(false);
	});

	it("validates the working directory against the allowed roots", () => {
		const home = join(tmp, "home");
		const project = join(home, "project");
		const outside = join(tmp, "outside");
		mkdirSync(project, { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(home, "file.txt"), "x");
		symlinkSync(outside, join(home, "escape"));
		// The child starts in the real path (no symlink swap between check and spawn).
		expect(validateSpawnCwd(project, [home], home)).toEqual({ cwd: realpathSync(project) });
		expect(validateSpawnCwd("~/project", [home], home)).toEqual({ cwd: realpathSync(project) });
		expect(validateSpawnCwd(outside, [home], home)).toMatchObject({ error: { code: "forbidden" } });
		expect(validateSpawnCwd(join(home, "escape"), [home], home)).toMatchObject({ error: { code: "forbidden" } });
		expect(validateSpawnCwd(outside, [home, outside], home)).toEqual({ cwd: realpathSync(outside) });
		expect(validateSpawnCwd(join(home, "missing"), [home], home)).toMatchObject({ error: { code: "bad_request" } });
		expect(validateSpawnCwd(join(home, "file.txt"), [home], home)).toMatchObject({ error: { code: "bad_request" } });
		expect(validateSpawnCwd("relative/path", [home], home)).toMatchObject({ error: { code: "bad_request" } });
		expect(validateSpawnCwd(undefined, [home], home)).toMatchObject({ error: { code: "bad_request" } });
	});

	it("scrubs inherited session metadata from a child's environment", () => {
		const env = cleanChildEnv(
			{
				PATH: "/bin",
				HOME: "/h",
				PI_REMOTE_DIR: "/r",
				PI_SESSION_ID: "s",
				PI_MODEL: "m",
				PI_SUBAGENT_ID: "x",
				PI_SUBAGENT_PARENT_PID: "1",
				PHI_REMOTE_SPAWN_ID: "old",
			},
			"new",
		);
		expect(env).toEqual({ PATH: "/bin", HOME: "/h", PI_REMOTE_DIR: "/r", PHI_REMOTE_SPAWN_ID: "new" });
		expect(cleanChildEnv({ PHI_REMOTE_SPAWN_ID: "old", A: "1" })).toEqual({ A: "1" });
	});

	it("cancels blocking extension UI requests and ignores fire-and-forget ones", () => {
		expect(rpcAutoResponse({ type: "extension_ui_request", id: "u1", method: "confirm" })).toEqual({
			type: "extension_ui_response",
			id: "u1",
			cancelled: true,
		});
		expect(rpcAutoResponse({ type: "extension_ui_request", id: "u2", method: "select" })).toMatchObject({
			cancelled: true,
		});
		expect(rpcAutoResponse({ type: "extension_ui_request", id: "u3", method: "notify" })).toBeUndefined();
		expect(rpcAutoResponse({ type: "extension_ui_request", id: "u4", method: "setStatus" })).toBeUndefined();
		expect(rpcAutoResponse({ type: "agent_start" })).toBeUndefined();
	});
});

describe("service definitions", () => {
	const spec = {
		programArgs: ["/usr/local/bin/node", "/opt/phi & co/cli.js", "remote", "serve", "--port", "7717"],
		env: { PHI_REMOTE_SERVICE: "1", PATH: "/usr/bin:/bin" },
		logPath: "/Users/me/.pi/agent/remote/hub.log",
		workingDirectory: "/Users/me",
	};

	it("builds a launchd agent with RunAtLoad, crash-only KeepAlive and escaped arguments", () => {
		const plist = buildLaunchdPlist(spec);
		expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
		expect(plist).toContain("<string>/opt/phi &amp; co/cli.js</string>");
		expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
		expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
		expect(plist).toContain("<key>PATH</key>\n\t\t<string>/usr/bin:/bin</string>");
		expect(plist).toContain("<key>StandardErrorPath</key>\n\t<string>/Users/me/.pi/agent/remote/hub.log</string>");
		expect(plist.indexOf("<string>/usr/local/bin/node</string>")).toBeLessThan(
			plist.indexOf("<string>serve</string>"),
		);
	});

	it("builds a systemd user unit with quoted arguments", () => {
		const unit = buildSystemdUnit(spec);
		expect(unit).toContain('ExecStart="/usr/local/bin/node" "/opt/phi & co/cli.js" "remote" "serve" "--port" "7717"');
		expect(unit).toContain('Environment="PHI_REMOTE_SERVICE=1"');
		expect(unit).toContain("Restart=on-failure");
		expect(unit).toContain("WantedBy=default.target");
		expect(systemdQuote('a"b$c%d\\e')).toBe('"a\\"b$$c%%d\\\\e"');
	});

	it("captures PATH and the remote dir for the service", () => {
		const env = serviceEnvironment({ PATH: "/a:/b", PI_REMOTE_DIR: "/x", SECRET_TOKEN: "nope" });
		expect(env).toEqual({ PHI_REMOTE_SERVICE: "1", PATH: "/a:/b", PI_REMOTE_DIR: "/x" });
	});
});

describe("APNs", () => {
	it("signs an ES256 provider token that verifies with the public key", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const pem = privateKey.export({ type: "pkcs8", format: "pem" });
		const key = loadApnsKey(pem);
		const jwt = createApnsJwt("TEAM123456", "KEY1234567", key, 1_700_000_000_000);
		const [h, c, s] = jwt.split(".");
		expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
		expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1_700_000_000 });
		const signature = Buffer.from(s, "base64url");
		expect(signature.length).toBe(64); // raw r||s (JOSE), not DER
		const ok = verify(
			"sha256",
			Buffer.from(`${h}.${c}`),
			{ key: createPublicKey(key), dsaEncoding: "ieee-p1363" },
			signature,
		);
		expect(ok).toBe(true);
	});

	it("rejects non-P-256 keys", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
		expect(() => loadApnsKey(privateKey.export({ type: "pkcs8", format: "pem" }))).toThrow(/P-256/);
	});

	it("installs the key 0600 and writes apns.json", () => {
		const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
		const src = join(tmp, "AuthKey.p8");
		writeFileSync(src, privateKey.export({ type: "pkcs8", format: "pem" }));
		const config = setupApns({
			keyFile: src,
			keyId: "abc1234567",
			teamId: "TEAM123456",
			bundleId: "dev.example.phiremote",
		});
		expect(config.keyId).toBe("ABC1234567");
		expect(config.keyPath).toBe(join(tmp, "apns", "AuthKey_ABC1234567.p8"));
		expect(statSync(config.keyPath).mode & 0o777).toBe(0o600);
		expect(statSync(join(tmp, "apns.json")).mode & 0o777).toBe(0o600);
		expect(loadApnsConfig()).toEqual(config);
		expect(() => setupApns({ keyFile: src, keyId: "short", teamId: "TEAM123456", bundleId: "a.b" })).toThrow();
	});

	it("drops registrations on 410 / BadDeviceToken / Unregistered and builds the payload", () => {
		expect(shouldDropRegistration(410, "Unregistered")).toBe(true);
		expect(shouldDropRegistration(400, "BadDeviceToken")).toBe(true);
		expect(shouldDropRegistration(400, "BadTopic")).toBe(false);
		expect(shouldDropRegistration(200, undefined)).toBe(false);
		expect(buildPushBody({ title: "t", body: "b" }, { hubId: "h", sessionId: "s" })).toEqual({
			aps: { alert: { title: "t", body: "b" }, sound: "default", "thread-id": "s" },
			hubId: "h",
			sessionId: "s",
		});
	});
});

describe("recent cwds", () => {
	it("reads the newest session header per project directory, existing dirs only", () => {
		const sessions = join(tmp, "sessions");
		const projA = join(tmp, "projA");
		const projB = join(tmp, "projB");
		mkdirSync(projA);
		mkdirSync(projB);
		const write = (dir: string, file: string, cwd: string) => {
			mkdirSync(join(sessions, dir), { recursive: true });
			writeFileSync(
				join(sessions, dir, file),
				`${JSON.stringify({ type: "session", version: 3, id: file, timestamp: "t", cwd })}\n{"type":"message"}\n`,
			);
		};
		write("--a--", "2026-01-01T00-00-00-000Z_1.jsonl", projA);
		write("--b--", "2026-02-01T00-00-00-000Z_2.jsonl", projB);
		write("--gone--", "2026-03-01T00-00-00-000Z_3.jsonl", join(tmp, "deleted"));
		const cwds = readRecentSessionCwds(sessions, 20);
		expect(cwds.sort()).toEqual([projA, projB].sort());
		expect(mergeRecentCwds([projB, projB, join(tmp, "nope")], [projA, projB], 20)).toEqual([projB, projA]);
		expect(readRecentSessionCwds(join(tmp, "missing"))).toEqual([]);
	});
});

describe("NDJSON reader", () => {
	it("splits on LF only, keeps U+2028 inside strings and survives bad lines", async () => {
		const stream = new PassThrough();
		const values: unknown[] = [];
		const invalid: string[] = [];
		attachNdjsonReader(
			stream,
			(v) => values.push(v),
			(l) => invalid.push(l),
		);
		stream.write('{"a":"x\u2028y"}\r\n{"b"');
		stream.write(":2}\nnot json\n");
		const ended = new Promise((r) => stream.on("end", r));
		stream.end('{"c":3}');
		await ended;
		expect(values).toEqual([{ a: "x\u2028y" }, { b: 2 }, { c: 3 }]);
		expect(invalid).toEqual(["not json"]);
	});
});

describe("CLI arguments", () => {
	it("parses serve flags", () => {
		const parsed = parseRemoteArgs([
			"serve",
			"--port",
			"17717",
			"--bind",
			"127.0.0.1,100.64.0.2",
			"--bind=0.0.0.0",
			"--allow-root",
			"/srv",
		]);
		expect(parsed.positionals).toEqual(["serve"]);
		expect(parsed.port).toBe(17717);
		expect(parsed.binds).toEqual(["127.0.0.1", "100.64.0.2", "0.0.0.0"]);
		expect(parsed.allowRoots).toEqual(["/srv"]);
		expect(() => parseRemoteArgs(["serve", "--port", "nope"])).toThrow();
		expect(() => parseRemoteArgs(["serve", "--bogus"])).toThrow();
	});
});
