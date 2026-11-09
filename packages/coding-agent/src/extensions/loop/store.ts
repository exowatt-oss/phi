import {
	LOOP_AUDIT_ENTRY,
	LOOP_ITERATION_ENTRY,
	LOOP_SCHEMA_VERSION,
	LOOP_STATE_ENTRY,
	type LoopAuditRecord,
	type LoopIterationRecord,
	type LoopStateSnapshot,
} from "./types.ts";

export interface LoopStorePort {
	append(customType: string, data: unknown): void;
	entries(): Array<{ type: string; customType?: string; data?: unknown }>;
}

export class LoopStore {
	private readonly auditLoops = new Set<string>();
	private readonly port: LoopStorePort;
	constructor(port: LoopStorePort) {
		this.port = port;
	}

	persistState(snapshot: LoopStateSnapshot): void {
		this.port.append(LOOP_STATE_ENTRY, snapshot);
	}
	persistIteration(record: LoopIterationRecord): void {
		this.port.append(LOOP_ITERATION_ENTRY, record);
	}
	persistAudit(record: LoopAuditRecord): void {
		if (this.auditLoops.has(record.loopId)) return;
		this.auditLoops.add(record.loopId);
		this.port.append(LOOP_AUDIT_ENTRY, record);
	}

	reconstruct(): {
		latest?: LoopStateSnapshot;
		iterations: LoopIterationRecord[];
		audits: LoopAuditRecord[];
		corruption?: string;
	} {
		const notes: string[] = [];
		const states: LoopStateSnapshot[] = [];
		const iterations: LoopIterationRecord[] = [];
		const audits: LoopAuditRecord[] = [];
		for (const entry of this.port.entries()) {
			const kind = entry.customType ?? entry.type;
			if (kind !== LOOP_STATE_ENTRY && kind !== LOOP_ITERATION_ENTRY && kind !== LOOP_AUDIT_ENTRY) continue;
			const data = entry.data as Record<string, unknown> | undefined;
			if (!data || data.schemaVersion !== LOOP_SCHEMA_VERSION) {
				if (data?.schemaVersion !== undefined && data.schemaVersion !== LOOP_SCHEMA_VERSION)
					notes.push(`unknown schemaVersion in ${kind}`);
				else notes.push(`malformed ${kind} entry`);
				continue;
			}
			if (typeof data.loopId !== "string") {
				notes.push(`malformed ${kind}: missing loopId`);
				continue;
			}
			if (kind === LOOP_STATE_ENTRY) {
				if (typeof data.revision !== "number" || typeof data.phase !== "string") {
					notes.push(`malformed ${kind}: missing revision or phase`);
					continue;
				}
				states.push(data as unknown as LoopStateSnapshot);
			} else if (kind === LOOP_ITERATION_ENTRY) {
				if (typeof data.iterationId !== "string" || typeof data.index !== "number") {
					notes.push(`malformed ${kind}`);
					continue;
				}
				iterations.push(data as unknown as LoopIterationRecord);
			} else {
				if (typeof data.reason !== "string") {
					notes.push(`malformed ${kind}`);
					continue;
				}
				audits.push(data as unknown as LoopAuditRecord);
				this.auditLoops.add(data.loopId);
			}
		}
		let latest: LoopStateSnapshot | undefined;
		if (states.length) {
			const loopId = states.at(-1)!.loopId;
			let previous = -1;
			for (const state of states.filter((s) => s.loopId === loopId)) {
				if (state.revision <= previous) notes.push(`non-monotonic revisions for loop ${loopId}`);
				previous = state.revision;
			}
			latest = states.filter((s) => s.loopId === loopId).reduce((a, b) => (b.revision > a.revision ? b : a));
		}
		return { latest, iterations, audits, ...(notes.length ? { corruption: notes.join("; ") } : {}) };
	}
}
