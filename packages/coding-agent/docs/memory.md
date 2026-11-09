# Memory

Memory is persistent, per-project knowledge that the agent maintains for itself across sessions. When you correct the agent, state a durable preference, or point it at a non-obvious gotcha, it writes that down; the next session in the same project starts already knowing it.

Memory is a built-in, not an extension or a hub bundle. It uses the agent's existing read, write, and edit tools—there is no new memory tool—so the agent curates memory the same way it edits any other file. A system-prompt section teaches it when to save and when not to.

## What it is

Memory is a directory of small Markdown files, one fact per file, plus an index. Only the index is loaded into the system prompt at session start; detail files are read on demand. This is progressive disclosure: the agent always knows *what* it remembers without paying the token cost of every detail until it needs one.

Memory captures knowledge that accumulates over a project's life and is not derivable from the repository itself:

- durable user preferences ("always run the linter before committing");
- corrections the agent was given ("this codebase uses tabs, not spaces");
- non-obvious gotchas ("the test suite hangs unless `FOO=1` is set");
- external references (a runbook URL, a ticket, a design doc).

It is not a scratchpad for the current task, and it is not a place for anything reconstructable from the repo or git history.

## Where memories live

Memory is stored under the agent directory, keyed by working directory using the same encoding sessions use—each path separator becomes `-` and the whole path is wrapped in `--`:

```text
~/.pi/agent/memory/<encoded-cwd>/
```

For example, a session started in `/Users/example/project` uses:

```text
~/.pi/agent/memory/--Users-example-project--/
├── MEMORY.md              # the index (auto-injected)
├── prefers-tabs.md        # one fact per file
├── test-suite-gotcha.md
└── deployment-runbook.md
```

Keying is by cwd, so each git worktree gets its own memory directory. See [Semantics and caveats](#semantics-and-caveats).

## File format

`MEMORY.md` is the index and is described in [The index contract](#the-index-contract). Every other `<slug>.md` file holds exactly one fact with YAML frontmatter:

```markdown
---
name: test-suite-gotcha
description: The integration suite hangs unless FOO=1 is exported.
type: project
---

The integration tests spawn a broker that blocks on `FOO`. Without
`FOO=1` in the environment, `npm test` hangs at the first integration
case with no error.

**Why:** discovered after a 20-minute hang that looked like a deadlock.
**How to apply:** export `FOO=1` before running any integration test.

Related: [[deployment-runbook]]
```

Frontmatter fields:

| Field | Meaning |
| --- | --- |
| `name` | The memory's slug; matches the filename without `.md`. |
| `description` | One-line summary; becomes the hook in the index. |
| `type` | One of `user`, `feedback`, `project`, `reference`. |

The `type` values distinguish a durable user preference (`user`), a correction or piece of feedback the agent received (`feedback`), project-specific knowledge (`project`), and a pointer to external material (`reference`).

`feedback` and `project` memories carry two extra lines so the reasoning survives:

- **Why:** the context that made this worth recording.
- **How to apply:** the concrete action to take next time.

Memories link to each other with `[[their-name]]`, matching the target file's `name`. This lets the agent follow related facts without loading everything up front.

## The index contract

`MEMORY.md` is the index, and it is the only file auto-injected into the system prompt. It lists one line per memory:

```markdown
# Memory

- [Prefers tabs](prefers-tabs.md) — this codebase uses tabs, not spaces
- [Test suite gotcha](test-suite-gotcha.md) — hangs unless FOO=1 is set
- [Deployment runbook](deployment-runbook.md) — steps + link for prod deploys
```

Three properties define the contract:

- **Always loaded, once per session.** The index is injected at session start as a snapshot. It is captured once and stays byte-identical across every turn, which keeps the prompt prefix stable and cache-friendly. Detail files are never auto-injected—the agent reads them on demand with its read tool.
- **8 KiB cap.** The injected index is capped at 8192 bytes. If it is larger, it is truncated on a line boundary and a note is appended telling the agent to compact the index.
- **Compaction.** When the index approaches the cap, the agent is expected to consolidate: merge overlapping entries, drop stale ones, and keep each hook short. Updating and deleting in place is preferred over appending duplicates, both in the index and in the underlying files.

## The `/memory` command

`/memory` inspects and manages the current project's memory:

| Invocation | Behavior |
| --- | --- |
| `/memory` | Status: entry count and the memory directory path. |
| `/memory path` | Print the memory directory path. |
| `/memory reload` | Re-read `MEMORY.md` and refresh the injected index mid-session. |

`/memory reload` is how you pick up writes made during the current session without starting a new one—see below.

## Disabling

Memory is on by default. Turn it off with a flag or an environment variable:

```bash
pi --no-memory              # disable for this run
PHI_MEMORY=0 pi             # disable via env
PI_MEMORY=0 pi              # PI_-prefixed alias
```

The environment variables accept `0` or `false`. When memory is disabled, nothing is injected and the agent is not prompted to save.

## Semantics and caveats

- **Session-start snapshot.** The index is a snapshot taken at session start. Memories the agent writes mid-session do not change the injected index until the next session—or until you run `/memory reload`. This is deliberate: a stable prefix is what makes the prompt cache-friendly.
- **Per-worktree memory.** Because the directory is keyed by cwd, each git worktree has its own memory. Two worktrees of the same repo do not share memory. Keying by the git common directory so worktrees share one store is possible future work, not current behavior.
- **Never store secrets.** Memory is plain files on disk and is injected into prompts. The agent is instructed never to record secrets, tokens, or credentials. Do not put them there yourself.
- **Subagents share the directory.** Subagents running in the same cwd read and write the same memory directory as the parent. Memory a subagent writes is visible to the next session there.
- **Not for derivable facts.** Anything reconstructable from the repository or git history, and anything specific to a single session, does not belong in memory.

## Relationship to AGENTS.md and skills

Memory is one of three mechanisms for giving the agent standing knowledge, and they do not overlap:

| Mechanism | What it holds | Who maintains it |
| --- | --- | --- |
| `~/.pi/agent/AGENTS.md` | Always-true global facts and policies. | You, by hand. |
| Skills | Curated, shareable, task-specific procedures. | You (or a hub author), by hand. |
| Memory | Accumulated per-project knowledge. | The agent itself. |

Use `AGENTS.md` for facts that are true everywhere and that you want to state explicitly. Use a skill when the knowledge is a reusable procedure worth sharing across people and projects. Let memory hold the per-project knowledge the agent learns as it works—the corrections, preferences, and gotchas that are true here and were discovered, not declared.
