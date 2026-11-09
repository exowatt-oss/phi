import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RepoDelta, RepoSnapshot } from "./types.ts";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]): Promise<string | undefined> {
	try {
		const result = await exec("git", args, { cwd, timeout: 5000, maxBuffer: 10 * 1024 * 1024 });
		return result.stdout;
	} catch {
		return undefined;
	}
}

export async function captureRepoSnapshot(cwd: string): Promise<RepoSnapshot | undefined> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
	if (!root) return undefined;
	const head = (await git(cwd, ["rev-parse", "HEAD"]))?.trim() ?? "";
	const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? "";
	const status = await git(cwd, ["status", "--porcelain=v1", "-z"]);
	if (status === undefined) return undefined;
	let stagedCount = 0;
	let unstagedCount = 0;
	let untrackedCount = 0;
	for (const entry of status.split("\0").filter(Boolean)) {
		const code = entry.slice(0, 2);
		if (code === "??") untrackedCount++;
		else {
			if (code[0] !== " ") stagedCount++;
			if (code[1] !== " ") unstagedCount++;
		}
	}
	const numstat = await git(cwd, ["diff", "HEAD", "--numstat"]);
	let insertions = 0;
	let deletions = 0;
	let filesChanged = 0;
	if (numstat !== undefined)
		for (const line of numstat.split("\n").filter(Boolean)) {
			const [adds, dels] = line.split("\t");
			filesChanged++;
			if (adds !== "-") insertions += Number(adds) || 0;
			if (dels !== "-") deletions += Number(dels) || 0;
		}
	return {
		roots: [root],
		head,
		branch,
		stagedCount,
		unstagedCount,
		untrackedCount,
		numstat: { filesChanged, insertions, deletions },
	};
}

export function computeRepoDelta(
	before: RepoSnapshot | undefined,
	after: RepoSnapshot | undefined,
	commitsAdded: string[],
): RepoDelta | undefined {
	if (!before && !after) return undefined;
	if (!after) return undefined;
	const dirty = before ? before.stagedCount + before.unstagedCount + before.untrackedCount > 0 : false;
	const rootsDiffer = Boolean(before && JSON.stringify(before.roots) !== JSON.stringify(after.roots));
	const headMoved = Boolean(before?.head && before.head !== after.head && commitsAdded.length === 0);
	return { ...after, commitsAdded, mixedChanges: dirty || rootsDiffer || headMoved };
}

export async function listCommitsBetween(cwd: string, beforeHead: string, afterHead: string): Promise<string[]> {
	if (!beforeHead || !afterHead) return [];
	const result = await git(cwd, ["rev-list", `${beforeHead}..${afterHead}`]);
	return (
		result
			?.split("\n")
			.map((sha) => sha.trim())
			.filter(Boolean) ?? []
	);
}
