export function buildMemorySection(memoryDir: string, indexContent: string, truncated: boolean): string {
	const truncationNote = truncated
		? "\n(NOTE: the index above was truncated because it exceeds the injection cap — it is overgrown. Compact it: shorten hooks, merge overlapping memories, delete stale ones.)"
		: "";
	return `<agent_memory>
You have a persistent, file-based memory for this project at:
${memoryDir}

It survives across sessions: whatever you write there is loaded back into your context at the start of every future session in this working directory. The directory already exists — write to it directly with your write/edit tools (no mkdir, no permission needed).

Each memory is ONE file holding ONE durable fact, named <short-kebab-slug>.md, with frontmatter:
---
name: <short-kebab-case-slug>
description: <one-line summary used to decide relevance>
type: user | feedback | project | reference
---
<the fact; for feedback/project follow with **Why:** and **How to apply:** lines. Link related memories with [[their-name]].>

MEMORY.md is the index — one line per memory (\`- [Title](file.md) — hook\`). Only the index is auto-loaded (shown below); read a memory file with your read tool when its index line looks relevant to the task.

Types: user — who the user is (role, preferences). feedback — corrections and confirmed approaches, with the why. project — ongoing work, goals, gotchas not derivable from the code or git history; convert relative dates to absolute. reference — pointers to external resources (URLs, dashboards, tickets).

Save a memory when: the user states a durable preference or corrects how you work; you finish non-obvious work whose "why" is recorded nowhere in the repo; you hit a gotcha that will bite the next session; an external URL/ticket matters beyond today.
Do NOT save: anything derivable from the repo (code structure, git history, AGENTS.md); details that only matter this session; secrets, tokens, or credentials — never.
Maintenance: before saving, check the index for an existing memory covering the same fact — update that file instead of duplicating. Delete memories you discover are wrong. Whenever you write or update a memory file, add or refresh its one-line MEMORY.md entry in the same step.
Memory edits take effect at the next session start (or /memory reload) — do not expect this index to refresh mid-session.

Current MEMORY.md index:
<memory_index path="${memoryDir}/MEMORY.md">
${indexContent}
</memory_index>${truncationNote}
</agent_memory>`;
}
