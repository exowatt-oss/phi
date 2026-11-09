import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MAX_MESSAGE_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = MAX_MESSAGE_BYTES + 8192;
const MAX_INBOUND_PER_MINUTE = 30;
const TIMEOUT_MS = 5000;
const ID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{8})?$/;

export interface MailRecord {
	id: string;
	sessionId: string;
	name: string;
	cwd: string;
	pid: number;
	socket: string;
	startedAt: number;
	model?: string;
	state: "busy" | "idle";
}

export interface MailFrom {
	id: string;
	name: string;
	cwd: string;
}

/**
 * Marks a message as a report from an overseer thread (`report_to_overseer`). The receiving
 * session then points replies at the overseer tool and the thread's name instead of the sender's
 * agent-mail id, which may belong to a short-lived member that is gone by then. Additive: older
 * receivers ignore it.
 */
export interface MailThreadReport {
	/** The thread's name, as the overseer knows it. */
	name: string;
	/** Report kind (question, blocker, progress, done). */
	kind: string;
}

export interface MailEnvelope {
	v: 1;
	from: MailFrom;
	message: string;
	replyTo?: string;
	thread?: MailThreadReport;
}

/** Optional fields a sender attaches to an envelope. */
export interface MailSendOptions {
	thread?: MailThreadReport;
}

function validThreadReport(value: unknown): boolean {
	if (value === undefined) return true;
	if (!value || typeof value !== "object") return false;
	const { name, kind } = value as Partial<MailThreadReport>;
	return (
		typeof name === "string" &&
		name.trim().length > 0 &&
		name.length <= 256 &&
		typeof kind === "string" &&
		kind.length <= 32
	);
}

interface AgentMailOptions {
	agentDir: string;
	sessionId: string;
	name: string;
	cwd: string;
	model?: string;
	onMessage: (envelope: MailEnvelope) => void;
}

type WireResponse = { status: "delivered"; state: "busy" | "idle" } | { status: "denied"; reason: string };
export type MailReceipt = {
	status: "delivered" | "denied" | "timeout" | "not running";
	text: string;
	state?: "busy" | "idle";
};

function socketPath(dir: string, id: string): string {
	if (process.platform === "win32") return `\\\\.\\pipe\\phi-mail-${id}`;
	const local = join(dir, `${id}.sock`);
	if (Buffer.byteLength(local) <= 100) return local;
	const filename = `phi-mail-${process.getuid?.() ?? "user"}-${id}.sock`;
	const temporary = join(tmpdir(), filename);
	return Buffer.byteLength(temporary) <= 100 ? temporary : join("/tmp", filename);
}

function unlinkIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Disk is the shared source of truth; never rely on a per-process list of other agents. */
export function listMailRecords(dir: string): MailRecord[] {
	let files: string[];
	try {
		files = readdirSync(dir).filter((file) => file.endsWith(".json"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
	const records: MailRecord[] = [];
	for (const file of files) {
		const path = join(dir, file);
		let record: MailRecord;
		try {
			record = JSON.parse(readFileSync(path, "utf8")) as MailRecord;
		} catch {
			continue; // An entry may still be written by an older client; never delete a live peer's file.
		}
		if (
			!ID_PATTERN.test(record?.id) ||
			file !== `${record.id}.json` ||
			typeof record.sessionId !== "string" ||
			typeof record.name !== "string" ||
			typeof record.cwd !== "string" ||
			!Number.isInteger(record.pid) ||
			record.pid < 1 ||
			record.socket !== socketPath(dir, record.id) ||
			!Number.isFinite(record.startedAt) ||
			(record.state !== "busy" && record.state !== "idle")
		)
			continue;
		if (!pidAlive(record.pid)) {
			try {
				unlinkIfPresent(path);
				if (process.platform !== "win32") unlinkIfPresent(record.socket);
			} catch {
				// Listing is best-effort when an old entry has become inaccessible.
			}
			continue;
		}
		records.push(record);
	}
	return records.sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id));
}

/** Members started in this process and not yet closed. */
const startedMembers = new Set<AgentMailMember>();

/**
 * Agent-mail members this process runs (normally at most one per live session). Other built-ins
 * that send on the session's behalf (an overseer thread's `report_to_overseer`) reuse its identity.
 */
export function liveMailMembers(): AgentMailMember[] {
	return [...startedMembers];
}

function singleLine(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, " ");
}

/** One listener per UI session; start/close match session_start/session_shutdown. */
export class AgentMailMember {
	private server?: Server;
	private readonly sockets = new Set<Socket>();
	private readonly inbound = new Map<string, number[]>();
	private closing = false;
	private onExit = () => this.removeFiles();
	record!: MailRecord;
	private readonly options: AgentMailOptions;

	constructor(options: AgentMailOptions) {
		this.options = options;
	}

	get directory(): string {
		return join(this.options.agentDir, "mail");
	}

	async start(): Promise<void> {
		mkdirSync(this.directory, { recursive: true, mode: 0o700 });
		// The directory is private even when it predates this version of phi.
		if (process.platform !== "win32") chmodSync(this.directory, 0o700);
		listMailRecords(this.directory); // Remove entries/sockets left by dead processes.
		const prefix = this.options.sessionId.slice(0, 8).toLowerCase();
		if (!/^[0-9a-f]{8}$/.test(prefix)) throw new Error("Invalid phi session id for agent mail");
		for (let attempt = 0; attempt < 10; attempt++) {
			// UUIDv7 sessions created near each other share their first eight characters.
			const id = attempt === 0 ? prefix : `${prefix}-${randomBytes(4).toString("hex")}`;
			const entry = join(this.directory, `${id}.json`);
			if (existsSync(entry)) continue;
			const socket = socketPath(this.directory, id);
			const server = createServer((client) => this.receive(client));
			try {
				await new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(socket, () => {
						server.off("error", reject);
						resolve();
					});
				});
			} catch (error) {
				try {
					server.close(() => {});
				} catch {
					/* The server never started. */
				}
				if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
				throw error;
			}
			try {
				if (process.platform !== "win32") chmodSync(socket, 0o600);
				this.record = {
					id,
					sessionId: this.options.sessionId,
					name: this.options.name,
					cwd: this.options.cwd,
					pid: process.pid,
					socket,
					startedAt: Date.now(),
					model: this.options.model,
					state: "idle",
				};
				// Exclusive creation prevents a racing session from overwriting another's identity.
				writeFileSync(entry, JSON.stringify(this.record), { mode: 0o600, flag: "wx" });
				this.server = server;
				process.on("exit", this.onExit);
				startedMembers.add(this);
				return;
			} catch (error) {
				await new Promise<void>((resolve) => server.close(() => resolve()));
				if (process.platform !== "win32") unlinkIfPresent(socket);
				if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
				throw error;
			}
		}
		throw new Error("Could not allocate an agent-mail socket");
	}

	private removeFiles(): void {
		if (!this.record) return;
		const entry = join(this.directory, `${this.record.id}.json`);
		try {
			const current = JSON.parse(readFileSync(entry, "utf8")) as MailRecord;
			if (
				current.pid !== process.pid ||
				current.sessionId !== this.record.sessionId ||
				current.socket !== this.record.socket
			)
				return;
			unlinkIfPresent(entry);
			if (process.platform !== "win32") unlinkIfPresent(this.record.socket);
		} catch {
			/* Already removed, replaced, or best-effort exit cleanup failed. */
		}
	}

	async close(): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		startedMembers.delete(this);
		process.off("exit", this.onExit);
		for (const client of this.sockets) client.destroy();
		if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
		this.removeFiles();
		this.server = undefined;
	}

	update(changes: Partial<Pick<MailRecord, "name" | "state" | "model">>): void {
		if (!this.server || this.closing) return;
		this.record = { ...this.record, ...changes };
		const entry = join(this.directory, `${this.record.id}.json`);
		const temp = `${entry}.${randomBytes(4).toString("hex")}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify(this.record), { mode: 0o600, flag: "wx" });
			renameSync(temp, entry);
		} finally {
			unlinkIfPresent(temp);
		}
	}

	list(): MailRecord[] {
		return listMailRecords(this.directory).filter((record) => record.id !== this.record.id);
	}

	private receive(client: Socket): void {
		this.sockets.add(client);
		client.on("close", () => this.sockets.delete(client));
		client.on("error", () => {}); // A caller may disconnect while we write its receipt.
		client.setTimeout(TIMEOUT_MS, () => client.destroy());
		let buffer = Buffer.alloc(0);
		let answered = false;
		const answer = (reply: WireResponse) => {
			if (answered || client.destroyed) return;
			answered = true;
			client.end(`${JSON.stringify(reply)}\n`);
		};
		client.on("data", (chunk: Buffer) => {
			if (answered) return;
			buffer = Buffer.concat([buffer, chunk]);
			if (buffer.length > MAX_FRAME_BYTES) return answer({ status: "denied", reason: "request too large" });
			const newline = buffer.indexOf(10);
			if (newline === -1) return;
			if (newline !== buffer.length - 1) return answer({ status: "denied", reason: "one request per connection" });
			let request: MailEnvelope;
			try {
				request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as MailEnvelope;
			} catch {
				return answer({ status: "denied", reason: "invalid JSON" });
			}
			if (this.closing || !this.server) return answer({ status: "denied", reason: "session shutting down" });
			if (
				request?.v !== 1 ||
				!request.from ||
				!ID_PATTERN.test(request.from.id) ||
				typeof request.from.name !== "string" ||
				typeof request.from.cwd !== "string" ||
				request.from.name.length > 256 ||
				request.from.cwd.length > 4096 ||
				(request.replyTo !== undefined && typeof request.replyTo !== "string") ||
				!validThreadReport(request.thread) ||
				typeof request.message !== "string"
			)
				return answer({ status: "denied", reason: "invalid envelope" });
			if (Buffer.byteLength(request.message) > MAX_MESSAGE_BYTES)
				return answer({ status: "denied", reason: "message exceeds 16 KiB" });
			let sender: MailRecord | undefined;
			try {
				sender = listMailRecords(this.directory).find((record) => record.id === request.from.id);
			} catch {
				return answer({ status: "denied", reason: "sender registry unavailable" });
			}
			if (
				!sender ||
				sender.name !== request.from.name ||
				sender.cwd !== request.from.cwd ||
				sender.id === this.record.id
			)
				return answer({ status: "denied", reason: "sender is not a live agent-mail member" });
			const now = Date.now();
			const recent = (this.inbound.get(sender.id) ?? []).filter((at) => now - at < 60_000);
			if (recent.length >= MAX_INBOUND_PER_MINUTE)
				return answer({ status: "denied", reason: "rate limit (30/minute)" });
			recent.push(now);
			this.inbound.set(sender.id, recent);
			const state = this.record.state;
			try {
				this.options.onMessage(request);
				answer({ status: "delivered", state });
			} catch {
				answer({ status: "denied", reason: "session could not accept message" });
			}
		});
	}

	async send(to: string, message: string, options: MailSendOptions = {}): Promise<MailReceipt> {
		if (this.closing || !this.server) return { status: "not running", text: "Agent mail is not running." };
		if (Buffer.byteLength(message) > MAX_MESSAGE_BYTES) throw new Error("Message exceeds 16 KiB.");
		const candidates = listMailRecords(this.directory);
		const key = to.trim().toLowerCase();
		if (!key) {
			const available = candidates.map((peer) => `${peer.name} (${peer.id})`).join("; ") || "none";
			throw new Error(`Unknown agent "${to}". Candidates: ${available}.`);
		}
		const exactId = candidates.filter((record) => record.id === key);
		const prefixes = candidates.filter((record) => record.id.startsWith(key));
		const names = candidates.filter((record) => record.name.toLowerCase() === key);
		const matches = exactId.length ? exactId : prefixes.length ? prefixes : names;
		if (matches.length !== 1) {
			const available =
				candidates.map((record) => `${record.name} (${record.id}, ${record.cwd})`).join("; ") || "none";
			throw new Error(`${matches.length ? "Ambiguous" : "Unknown"} agent "${to}". Candidates: ${available}.`);
		}
		const target = matches[0];
		if (target.id === this.record.id) throw new Error("Cannot send agent mail to yourself.");
		const from: MailFrom = { id: this.record.id, name: this.record.name, cwd: this.record.cwd };
		const response = await new Promise<WireResponse | "timeout" | "not running">((resolve) => {
			const client = createConnection(target.socket);
			let finished = false;
			const finish = (value: WireResponse | "timeout" | "not running") => {
				if (finished) return;
				finished = true;
				clearTimeout(deadline);
				client.destroy();
				resolve(value);
			};
			const deadline = setTimeout(() => finish("timeout"), TIMEOUT_MS);
			let responseBytes = Buffer.alloc(0);
			const envelope: MailEnvelope = { v: 1, from, message, ...(options.thread ? { thread: options.thread } : {}) };
			client.on("connect", () => client.write(`${JSON.stringify(envelope)}\n`));
			client.on("data", (chunk: Buffer) => {
				responseBytes = Buffer.concat([responseBytes, chunk]);
				if (responseBytes.length > 2048) return finish({ status: "denied", reason: "invalid response" });
				const newline = responseBytes.indexOf(10);
				if (newline === -1) return;
				try {
					const reply = JSON.parse(responseBytes.subarray(0, newline).toString("utf8")) as WireResponse;
					if (reply.status === "delivered" && (reply.state === "busy" || reply.state === "idle")) finish(reply);
					else if (reply.status === "denied" && typeof reply.reason === "string") finish(reply);
					else finish({ status: "denied", reason: "invalid response" });
				} catch {
					finish({ status: "denied", reason: "invalid response" });
				}
			});
			client.on("error", () => finish("not running"));
			client.on("end", () => finish("not running"));
		});
		const label = `"${singleLine(target.name)}" (${target.id})`;
		if (response === "timeout")
			return { status: "timeout", text: `Timeout: no ACK from ${label} within 5 s. Delivery unknown.` };
		if (response === "not running")
			return {
				status: "not running",
				text: `Not running: ${label} did not accept a connection. Message not delivered.`,
			};
		if (response.status === "denied")
			return {
				status: "denied",
				text: `${JSON.stringify(response)}\nNot delivered: ${label} denied the message (${response.reason}).`,
			};
		return {
			status: "delivered",
			state: response.state,
			text: `${JSON.stringify(response)}\nDelivered to ${label} (${response.state === "busy" ? "queued as steer after its current tool/response" : "idle; triggered a new turn"}). Delivery into that session is confirmed, not that the message was read or answered.`,
		};
	}
}

export function mailContent(envelope: MailEnvelope): string {
	const { id, name, cwd } = envelope.from;
	const header = `[message from agent "${singleLine(name)}" (${id}) in ${singleLine(cwd)} — another phi session, not the user]`;
	// A thread report may come from a short-lived member: answer the thread through the overseer.
	const hint = envelope.thread
		? `Reply with overseer {"action":"send","target":${JSON.stringify(singleLine(envelope.thread.name))},"message":"..."} if a reply is needed (a report from your overseer thread; do not agent_message it).`
		: `Reply with agent_message {"to":"${id}","message":"..."} if a reply is needed.`;
	return `${header}\n${envelope.message}\n${hint}`;
}
