# `/loop`: bounded autonomous work

`/loop` is a bounded autonomous task controller. It runs a complete agent iteration, verifies the result, decides whether more work is needed, and repeats under hard iteration, time, and cost limits. The controller records what happened and keeps its state visible: progress, phase, usage, verification, repository observations, and the reason it stopped.

A loop is not a timer. It waits for the agent to settle—including tools, retries, queued continuations, and compaction—before it records an iteration and decides what happens next.

## Quick start

```text
/loop Fix all failing tests and ship the change
/loop 30s Fix all failing tests and ship the change
/loop Check the deployment every 2 minutes until it is healthy

/loop --max 8 --check "npx tsgo --noEmit" -- Eliminate every TypeScript error

/loop --until "The benchmark reports p95 below 250 ms with no correctness regression" --every 30s --timeout 90m --budget 8 -- Reduce API latency

/loop --check "gh pr checks --required --watch=false" --every 2m -- Make CI green
```

The `--` separator is optional when the task does not begin with an option. Options must come before the task. Durations use integer `s`, `m`, or `h` units. A positional duration such as `/loop 30s <task>` is shorthand for `--every 30s`.

Freeform requests are interpreted by an LLM pass that can extract the task, interval, iteration/wall-time limits, and check or condition; the resolved configuration and interpretation rationale are echoed before work starts. If interpretation is unavailable or fails, the request runs literally and silently. Any flagged input (including `--`) is always literal and bypasses interpretation.

## Options

| Option | Meaning | Default |
| --- | --- | ---: |
| `--max <N>` | Maximum agent iterations. | `12` |
| `--until <condition>` | Semantic condition checked after each iteration. | none |
| `--check <command>` | Deterministic verifier run after settlement. | none |
| `--check-timeout <duration>` | Maximum verifier runtime. | `10m` |
| `--every <duration>` | Delay after settlement before the next iteration. | `0` |
| `--timeout <duration>` | Total loop wall-clock limit. | `2h` |
| `--budget <USD>` | Optional cumulative model-cost limit, including evaluator usage. | unlimited |
| `--model <provider/model[:thinking]>` | Pin the worker model for this loop. | current scoped model |
| `--evaluator <provider/model[:thinking]>` | Pin the semantic evaluator model. | captured worker model |

The parser accepts finite, positive numeric values where applicable, rejects duplicate or unknown options, and requires a non-empty task. Budget is opt-in: without `--budget`, cost is unlimited; setting it applies exactly the configured finite budget (there is no default or maximum budget cap). The hard ceilings are **100 iterations** and **24 hours**, regardless of settings or model requests. A check timeout or pacing interval cannot exceed the loop timeout.

## Control surface

```text
/loop          # open the active or most-recent dashboard
/loop status   # show a compact state snapshot
/loop pause    # stop future dispatch; let active work settle
/loop resume   # resume an explicitly paused or interrupted loop
/loop stop     # stop permanently
/loop verify   # run the configured check/evaluator without a worker iteration
```

`/loop` with no argument opens the dashboard; it never silently starts an old task. Only one active or paused loop is allowed per session. `/loop stop` is terminal: it does not undo files, commits, or external effects, and it cannot be resumed.

**Esc pauses.** During agent work it aborts the current activity and leaves the loop paused once settlement is recorded; during checking, evaluation, or pacing it cancels that work and pauses. It is not a terminal delete. Use `/loop stop` when the loop must never dispatch again.

## How completion works

Each iteration is one full settled agent run followed by accounting, verification, and a decision. The working model can call the built-in `loop_control` protocol near the end of an iteration:

```text
loop_control({
  action: "continue" | "complete" | "pause",
  summary: "what happened",
  evidence: ["useful evidence"],
  nextStep: "what to do next"
})
```

`complete` expresses the worker's opinion; it cannot override a failed hard gate. `pause` requests a human decision or records a blocker. If there is no valid call, the loop continues with a visible protocol warning. Multiple calls are recorded and the final valid call wins; invalid or stale calls cannot mutate another iteration.

### Deterministic checks

`--check` runs after the worker settles in the loop's captured working directory. Its contract is:

- exit `0`: satisfied;
- exit `1`: valid check, not satisfied yet, so continue;
- exit `2+`, signal, timeout, spawn failure, or missing executable: verifier error, so pause.

Output is bounded and recorded with the command, directory, duration, exit or signal, and truncation status. Prefer read-only checks; a check that changes the worktree is flagged as **mutating check**.

### Semantic conditions

`--until` uses a fresh, tool-less evaluator after settlement. It receives the task, condition, iteration evidence, check outcome, bounded repository summary, and remaining limits. Completion requires `satisfied: true` and confidence of at least **0.85**. Malformed output, provider failure, unavailable credentials, or insufficient confidence never counts as success; the loop pauses with an evaluator error.

### Gate precedence

The controller applies decisions in this order:

1. user pause/stop/abort and safety limits;
2. permission, authentication, or project-trust blockers;
3. deterministic check;
4. semantic evaluator;
5. worker `loop_control` decision.

| Configuration or outcome | Completion rule |
| --- | --- |
| Neither `--check` nor `--until` | A valid `loop_control.complete` completes the loop. |
| `--check` only | The check must exit `0`; the model cannot override failure. |
| `--until` only | The evaluator must report satisfied at required confidence. |
| Both | The check must exit `0` **and** the evaluator must report satisfied. |
| Worker says `pause` | Pause immediately unless the user already stopped the loop. |
| Worker says `continue`, hard gates pass | Complete; verification outranks worker uncertainty. |
| Worker says `complete`, a hard gate fails | Continue, or pause when the verifier/evaluator has an error. |
| No valid worker call and no hard gate passes | Continue with a protocol warning. |

Natural-language completion promises are never parsed as a stop signal.

## What you see

The TUI keeps one canonical controller state visible at several levels.

### Footer badge

The badge remains visible while active or paused, for example:

```text
↻ LOOP 4/12 · 18m · $2.41 · working
```

It changes to phases such as `check`, `next 27s`, or `permission required`; after termination it briefly shows the reason while the durable audit remains in the transcript.

### Live board

The above-editor board shows current activity and remaining limits:

```text
◉ LOOP 4/12 · working · 18:42 · $2.41 · ctx 63%
task   Fix all failing tests and ship the change
now    bash: npm test -- --runInBand
gate   check: npm test · last exit 1
limit  8 left · 1h41m · $7.59
       /loop inspect · esc pause · /loop stop
```

Repository changes on this board are labeled **observed**. They are not automatically attributed to the loop.

### Iteration cards

One durable card is appended after each settled iteration:

```text
↻ loop iteration 4/12 — continue
  3m 12s · $0.62 · 6 tools · ctx 63%
  observed: 4 files · +84/-27
  check exit 1: 2 tests failing
  next: repair cancellation race and rerun focused tests
```

Expanded cards include usage, retries, compactions, repository state, check/evaluator details, all control calls, anomalies, and the precedence decision.

### Dashboard

`/loop` opens an interactive history and control view:

```text
LOOP · running · 4/12 · 18m42s · $2.41
› 4  continue  3m12s  $0.62  +84/-27   check:1
  3  continue  2m48s  $0.51  +31/-8    check:1
  2  continue  4m03s  $0.77  +102/-44  check:1
Σ 4 iterations · $2.41
```

Use the dashboard to inspect iterations, pause/resume, stop with confirmation, run verification, pin a snapshot, or copy the audit. Esc or `q` closes it.

### Final audit

Every terminal path gets one final audit card:

```text
✓ loop completed — check_passed
  7 iterations · 31m 08s · $3.08
  observed: 11 files · +418/-203 · 2 commits
  validation: npm test → exit 0
```

The expanded audit includes the per-iteration table, validation evidence, retries, compactions, and exact termination reason.

## Safety and repository accounting

- Limits are checked before and after expensive work. Late provider usage or a budget overshoot is recorded honestly, but it cannot trigger another iteration.
- Loops do not escalate permissions or approve prompts. Permission, authentication, credential, or project-trust blockers pause the loop under the ordinary permission policy. Print/JSON mode fails closed if interaction is required.
- Loops **never auto-resume** after restart, reload, session switch, or recovered interruption. They restore as `paused: session_interrupted`. `/loop resume` compares session identity, cwd, repository roots, HEAD, command, model, and schema; drift requires explicit confirmation (including an explicit confirmation field/flag for RPC/headless callers).
- Forks and clones retain historical cards but do not inherit active loop ownership.
- Repository snapshots capture visible Git roots, branches, HEADs, staged/unstaged/untracked counts, numstat, and commits added. Changes are labeled **observed**. Dirty baselines, concurrent edits, multiple worktrees, or external processes produce **mixed changes** rather than a claim that the loop authored them.

## Mode behavior

- **TUI:** full footer, live board, iteration cards, dashboard, confirmations, and Esc pause behavior.
- **RPC:** `/loop` is exposed through command discovery; command results and loop state/transition information are available to clients. Status/widgets use the existing RPC extension UI protocol. Drift confirmation and permission blocks require explicit client responses.
- **Print/JSON:** loop start is explicitly rejected in v1 with a machine-readable error; print/JSON is single-shot and cannot run the autonomous controller. Interaction-dependent permission flows fail closed with a machine-readable reason.

## v1 non-goals

The first version does not provide:

- multiple concurrent loops in one session;
- week-long cron scheduling, model-selected wakeup intervals, or cloud execution after the local process exits;
- automatic permission approval or rollback of loop changes;
- completion-promise string parsing;
- exclusive authorship claims for observed Git diffs;
- a new low-level agent loop;
- delivery as a user extension or hub bundle.

For long-running deployment or PR monitoring, a future event-driven Monitor primitive is a better fit than blind polling.
