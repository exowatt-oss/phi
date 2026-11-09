/** Shared checkpoint signal between the checkpoint tool and context-budget extension. */
let checkpointRecorded = false;

export function recordCheckpoint(): void {
	checkpointRecorded = true;
}

/** Consume the signal once, at the next turn boundary. */
export function consumeCheckpoint(): boolean {
	const recorded = checkpointRecorded;
	checkpointRecorded = false;
	return recorded;
}

export function resetCheckpointState(): void {
	checkpointRecorded = false;
}
