# phi remote — protocol v1 (contract)

Source of truth shared by the phi host side (`exowatt-oss/phi`, `phi remote`) and the
iOS app (`your/phi-remote-client`). Both sides build against this file. A change here
is a contract change: update this file in the same change and say so in the report.

Goal: Claude Code Remote Control, for phi. Every phi session on a machine is visible and
drivable from the phone: live transcript, send a prompt / steer, abort, switch model,
start a new session in a directory, and get a push when a session finishes.

## Topology

```
iPhone app ──WebSocket (JSON)──▶ phi remote hub (one per machine/user) ◀──unix socket── each phi session
            Tailscale / LAN       `phi remote serve`, port 7717            (built-in `remote` extension)
```

- **Hub**: `phi remote serve` — one long-running process per user per machine (installed as a
  launchd agent on macOS / systemd user unit on Linux by `phi remote install`). Owns the network
  listener, auth, device pairing, the session registry, spawning headless sessions, and APNs.
- **Session side**: a built-in phi extension loaded in every top-level session (interactive and
  `--mode rpc`; never in nested subagents). If the hub socket exists it connects (fail-open,
  reconnect with backoff, never blocks or slows the session), registers, streams events, and
  executes commands the hub forwards. Sessions never open network ports.
- The session↔hub local wire is internal to phi (not part of this contract).

### Files (`~/.pi/agent/remote/`, dir mode 0700)

| File | Mode | Content |
|---|---|---|
| `hub.sock` | 0600 | unix socket, sessions + local CLI control |
| `hub.json` | 0600 | `{ hubId, pid, port, binds: string[], startedAt, version }` |
| `devices.json` | 0600 | paired devices: `{ id, name, platform, tokenSha256, createdAt, lastSeenAt, push?: { apnsToken, env, bundleId } }[]` |
| `apns.json` | 0600 | optional: `{ teamId, keyId, keyPath, bundleId }` (keyPath → `.p8`, 0600) |

`hubId` is a random stable id (created once, kept across restarts). Secrets never go in the
macOS keychain — files only.

## Network listener

- Port **7717** (`--port`). Default binds: `127.0.0.1` plus every local IPv4 in the Tailscale
  CGNAT range `100.64.0.0/10`. `--bind <addr>[,<addr>]` overrides (e.g. `0.0.0.0` for LAN).
- Plain `http`/`ws` (Tailscale's WireGuard encrypts the path). The app sets
  `NSAllowsArbitraryLoads`.
- `GET /v1/info` (no auth) → `{ "name": "<hostname>", "hubId": "...", "hubVersion": "...", "protocol": 1 }`.
- `POST /v1/pair` (no auth, JSON) `{ "code": "...", "deviceName": "demo phone", "platform": "ios" }`
  → `200 { "deviceId": "...", "token": "...", "hubId": "...", "name": "<hostname>" }`;
  `401 { "error": "invalid_code" }`; `429` when rate-limited (5 attempts/min/IP).
  Codes: 8 chars Crockford base32 (no I/L/O/U), case-insensitive, single use, 10-minute TTL,
  minted only by a local user (`phi remote pair` or `/remote` in a session).
- Device token: 32 random bytes, base64url. Hub stores only its SHA-256. Revoking a device
  closes its sockets immediately.
- `GET /v1/ws` → WebSocket upgrade. **First frame must be `hello`** within 5 s, else close
  `4401`. Bad/revoked token → close `4401`. Protocol mismatch → close `4426`.
- Inbound frame cap 12 MiB (prompts may carry images). Hub sends WS pings every 20 s; a client
  missing 3 pongs is dropped. Clients may also send `ping`.

## Pairing QR / deep link

```
phiremote://pair?v=1&code=K7Q2M9XD&name=demo-laptop&hubId=<id>&url=http%3A%2F%2F192.0.2.52%3A7717
```

`url` repeats (try in order with `GET /v1/info`, first that answers with the same `hubId`
wins). The CLI prints the QR in the terminal plus the code and URLs for manual entry.

## Frames (WebSocket text, one JSON object each)

Every frame has `t` (type). Requests carry a client-chosen `id` (string); the reply carries
`re: <id>`. Unsolicited hub frames have no `re`.

### Client → hub

| `t` | fields | reply |
|---|---|---|
| `hello` | `token`, `app: { version, build }`, `device?: { name }`, `features?: string[]` (see [Subagents](#subagents-v1-addition)) | `welcome` or close 4401 |
| `ping` | `id` | `pong` |
| `sessions.list` | `id` | `sessions` |
| `session.subscribe` | `id`, `sessionId`, `limit?` (default 120 items) | `session.snapshot`, then `session.event` stream |
| `session.unsubscribe` | `sessionId` | — |
| `session.history` | `id`, `sessionId`, `before` (item id), `limit?` | `session.history` |
| `session.prompt` | `id`, `sessionId`, `text`, `images?: { mimeType, data }[]` (base64), `mode?: "auto" \| "steer" \| "followUp"` | `ack` |
| `session.abort` | `id`, `sessionId` | `ack` |
| `models.list` | `id`, `sessionId` | `models` |
| `session.setModel` | `id`, `sessionId`, `provider`, `modelId` | `ack` |
| `session.setThinking` | `id`, `sessionId`, `level` | `ack` |
| `commands.list` | `id`, `sessionId` (see [Slash commands](#slash-commands-v1-addition)) | `commands` |
| `cwds.recent` | `id` | `cwds` |
| `session.spawn` | `id`, `cwd`, `prompt?`, `provider?`, `modelId?`, `thinkingLevel?` | `ack` with `sessionId` |
| `session.close` | `id`, `sessionId` (headless sessions only) | `ack` |
| `sessions.past` | `id`, `limit?`, `cursor?`, `query?`, `cwd?` (see [Session history](#session-history-v1-addition)) | `sessions.past` |
| `session.transcript` | `id`, `sessionId`, `before?`, `limit?` (see [Session history](#session-history-v1-addition)) | `session.transcript` |
| `session.resume` | `id`, `sessionId`, `prompt?`, `provider?`, `modelId?`, `thinkingLevel?` (see [Session history](#session-history-v1-addition)) | `ack` with `sessionId`, `cwd?`, `cwdFallback?` |
| `push.register` | `id`, `apnsToken`, `env: "sandbox" \| "production"`, `bundleId` | `ack` |
| `push.unregister` | `id` | `ack` |
| `focus` | `sessionId \| null` (what the app has on screen in the foreground; suppresses pushes for it) | — |

`mode: "auto"` (default): idle session → new prompt; working session → steer (delivered after the
current tool call, like pressing Enter while phi works). `followUp` queues it until the agent is done.

### Hub → client

| `t` | fields |
|---|---|
| `welcome` | `host: { name, hubId, hubVersion, protocol: 1, features?: string[] }`, `deviceId` (`features`: see [Session history](#session-history-v1-addition)) |
| `pong` | `re` |
| `ack` | `re`, `ok: boolean`, `error?: { code, message }`, `sessionId?` |
| `error` | `re?`, `code`, `message` |
| `sessions` | `re`, `sessions: SessionSummary[]` |
| `session.upsert` | `session: SessionSummary` (pushed to every client on any change; throttled ≤ 2/s per session) |
| `session.remove` | `sessionId`, `replacedBy?` (see [Session replacement](#session-replacement-replacedby)) |
| `session.snapshot` | `re`, `sessionId`, `items: TranscriptItem[]` (oldest → newest), `hasMore`, `state: LiveState` |
| `session.history` | `re`, `sessionId`, `items`, `hasMore` |
| `session.event` | `sessionId`, `event: LiveEvent` |
| `models` | `re`, `models: { provider, id, name, reasoning: boolean }[]`, `current?: { provider, id }`, `thinkingLevel?`, `thinkingLevels: string[]` |
| `cwds` | `re`, `cwds: string[]` (most recent first, from live + recent sessions, existing dirs only) |
| `commands` | `re`, `sessionId`, `commands: CommandInfo[]` (see [Slash commands](#slash-commands-v1-addition)) |
| `sessions.past` | `re`, `sessions: PastSession[]`, `nextCursor?`, `indexing?` (see [Session history](#session-history-v1-addition)) |
| `session.transcript` | `re`, `sessionId`, `items: TranscriptItem[]`, `hasMore` (see [Session history](#session-history-v1-addition)) |

Error codes: `not_found`, `bad_request`, `session_offline`, `forbidden`, `internal`.

### Types

```ts
type SessionSummary = {
  sessionId: string;          // phi session id
  name: string;               // session name, else tmux session (v1 addition), else first prompt
                              // line (≤60), else cwd basename
  cwd: string;
  host: string;               // hostname
  pid: number;
  kind: "interactive" | "headless"; // headless = spawned by the hub; "subagent": see Subagents
  status: "working" | "idle";
  model?: { provider: string; id: string; name?: string };
  thinkingLevel?: string;
  startedAt: number;          // ms epoch
  lastActivityAt: number;     // ms epoch
  lastText?: string;          // last assistant text, ≤200 chars, single line
  activity?: { tool: string; summary?: string }; // current tool while working
  usage?: { costUsd?: number; contextPercent?: number };
  commandsVersion?: string;   // v1 addition: see Slash commands
};

type LiveState = { status: "working" | "idle"; activity?: { tool: string; summary?: string } };

type TranscriptItem =
  | { id: string; ts: number; kind: "user"; text: string; images?: number }
  | { id: string; ts: number; kind: "assistant"; text: string; thinking?: string; model?: string;
      streaming?: boolean; error?: string }
  | { id: string; ts: number; kind: "tool"; toolCallId: string; name: string;
      summary: string;            // one line, e.g. "bash  ls -la" / "read  src/app.ts"
      args?: unknown;             // JSON, truncated to ~4 KB
      status: "running" | "ok" | "error";
      output?: string;            // text, truncated to ~8 KB (head + tail)
      outputTruncated?: boolean }
  | { id: string; ts: number; kind: "note"; label?: string; text: string }; // custom messages,
      // compaction / branch summaries, user `!bash` runs, subagent results, etc.

type LiveEvent =
  | { type: "item.upsert"; item: TranscriptItem } // full item; idempotent; streaming text ≤ 8 updates/s
  | { type: "state"; state: LiveState }
  | { type: "reset"; replacedBy?: string };      // /new, resume, fork, tree nav, compaction → resubscribe
                                                 // (replacedBy: see Session replacement)
```

Ordering: an assistant message produces one `assistant` item followed by one `tool` item per tool
call (tool result merged into it when it arrives). Item ids are stable across snapshot and events,
so the client keeps a map keyed by `id` and an ordered id list; an upsert for a known id replaces in
place, an unknown id appends.

## Push notifications (hub → APNs, direct, no third party)

- Configured by `phi remote push setup --key <AuthKey.p8> --key-id <id> --team-id <id> --bundle-id <id>`
  (writes `apns.json`). Without it, pushes are silently off.
- Sent when a session goes `working → idle` (and when it fails), to every registered device that
  does **not** currently have that session in `focus`. Title = session name, body = first 140 chars
  of the final assistant text (or the error). Custom payload: `{ "hubId": "...", "sessionId": "..." }`.
  `apns-push-type: alert`, `apns-topic: <bundleId>`, `env` picks `api.sandbox.push.apple.com` vs
  `api.push.apple.com` (TestFlight builds are `production`).
- APNs `410`/`BadDeviceToken` → drop that device's push registration.

## Headless sessions (`session.spawn`)

The hub starts `phi --mode rpc` in `cwd` (must exist and be inside `$HOME` unless
`--allow-root <dir>` was given), keeps its stdio, answers any RPC `extension_ui_request` with a
cancel, and sends `prompt` (if given) once the child's remote extension registers. The child is a
normal phi session: persisted, resumable from a terminal later. `session.close` ends it.
`thinkingLevel` (v1 addition) starts it with that thinking level (`--thinking`); absent, it uses the
machine's default. There is no limit on how many headless sessions a hub runs.

## App constants

| | |
|---|---|
| Display name | `phi` |
| App Store Connect name | `phi remote` |
| Bundle id | Client-defined; not part of the wire protocol |
| URL scheme | `phiremote` |
| Default port | 7717 |

## Clarifications (v1, binding — resolved after the mock-hub conformance run)

Additive; everything above still holds. Both hub and app follow these.

1. **`hello.protocol`**: the app sends `protocol: 1` in `hello`. A hub closes `4426` when it is present and not `1`; absent is accepted as 1.
2. **Failures for requests whose success reply is not `ack`** (`sessions.list`, `session.subscribe`, `session.history`, `models.list`, `cwds.recent`): `error { re, code, message }`. Requests whose success reply is `ack` fail with `ack { re, ok: false, error }`.
3. **Malformed frames after auth** (bad JSON, unknown `t`, missing `id` on a request): `error { re?, code: "bad_request", message }`; the socket stays open.
4. **`session.history`**: default `limit` 120, maximum 500 (larger values are clamped). Unknown `before` id → `error not_found`. `session.subscribe` `limit` has the same default and cap.
5. **`POST /v1/pair`**: every attempt counts toward 5/min/IP. 429 body `{ "error": "rate_limited" }`; malformed body → 400 `{ "error": "bad_request" }`. The app strips spaces/dashes and uppercases before sending; the hub also normalises.
6. **`session.spawn`**: missing/non-directory `cwd` → `bad_request`; outside allowed roots → `forbidden`; unknown model → `not_found`; `thinkingLevel` that is not one of phi's levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, the superset of every `models.list` `thinkingLevels`) → `bad_request` ("invalid thinkingLevel"). A valid level the model does not support is clamped by the session as `--thinking` is (a non-reasoning model reports `off`); hubs that predate `thinkingLevel` ignore it. The number of headless sessions is not capped (hubs before 1.4.0-exo.6 refused the 17th with `forbidden`). The `ack` is sent only after the child has registered (hub-side timeout 30 s, extended by 1 s for every other spawn still pending when it expires, since children started together boot together → `ack ok:false internal`). A `session.upsert` for the new session may arrive before the `ack`. `cwds.recent` lists only directories `session.spawn` would accept.
7. **`session.setModel`** unknown model → `not_found`. **`session.setThinking`** invalid level → `bad_request`; on a non-reasoning model the level is reported as `off`.
8. **`models.list`**: `sessionId` is optional. Without it the hub answers from its own model registry (same auth/config as phi on that machine; `current`/`thinkingLevel` are the user's defaults). Used by the new-thread screen.
9. **`session.abort`** on an idle session → `ack ok:true` (no-op). Effect on the transcript: the streaming assistant item gets `error: "aborted"`, running tool items become `status: "error"`. An abort never triggers a push.
10. **Push vs focus** is per device: a push is suppressed when any connection of that device has the session in `focus`.
11. **`state` events** are sent on every status or activity change, throttled to ≤ 4/s per session with a trailing edge (the final state is always delivered). `session.upsert` throttle (≤ 2/s) is also trailing-edge.
12. **Heartbeat** = WebSocket control-frame ping/pong (iOS answers these automatically). The JSON `ping` frame is an optional app-level RTT probe.
13. **Pairing link `url` order**: MagicDNS name first, then Tailscale IPs, then any other bound non-loopback address; `127.0.0.1` only when the hub was explicitly bound to loopback only (Simulator/dev).
14. **Session removal**: `session.remove` is the only signal; subscribers drop that session's subscription.
15. **Values**: `session_offline` = the owning session is disconnected or did not answer within 15 s. Image `mimeType` ∈ `image/jpeg`, `image/png`, `image/webp`, `image/gif`. `hubId` is an opaque string (≤ 64 chars). A tool item's `ts` is when the tool call started.

## Slash commands (v1 addition)

Additive. The app can list the slash commands of a session and run one by sending `/name args` as
a prompt, exactly as typing it in the phi terminal would. A hub or session that predates this
answers `commands.list` with an error (`bad_request`, or `not_found` / `session_offline` as for any
request); the app treats any error as "no commands".

### Listing: `commands.list`

| Direction | `t` | fields |
|---|---|---|
| client → hub | `commands.list` | `id`, `sessionId` |
| hub → client | `commands` | `re`, `sessionId`, `commands: CommandInfo[]` |

```ts
type CommandInfo = {
  name: string;          // what the user types after the slash: "compact", "skill:use-subs", "mcp"
  description?: string;  // one line, ≤ 160 chars
  source: "builtin" | "extension" | "prompt" | "skill";
  argumentHint?: string; // e.g. "<name>", "[instructions]", a prompt template's argument-hint
};
```

- **Order**: `builtin`, then `extension`, `skill`, `prompt`; alphabetical (case-insensitive) within
  each group. Names are unique. At most 500 entries.
- **`builtin`**: only the built-ins a session runs without a terminal: `new`, `compact
  [instructions]`, `name <name>`, `model <provider/model>`, `thinking <level>`. Built-ins that need
  the terminal (settings, tree, resume, fork, export, fast, reload, login, ...) are never listed.
- **`skill`**: named `skill:<name>`, the phi terminal's own form (its autocomplete inserts
  `/skill:use-subs`). Not listed when the user turned skill commands off (`enableSkillCommands:
  false`).
- **`extension`**: commands registered by extensions, under the name they are invoked by (e.g.
  `mcp`; `deploy:1`, `deploy:2` when two extensions register `deploy`). Extension commands and
  prompt templates that the terminal shadows with a built-in of the same name are not listed, nor
  is phi remote's own `/remote`.
- **`prompt`**: prompt templates.
- **Failures** (success reply is not `ack`, so clarification 2 applies): `error { re, code,
  message }` with `not_found` (unknown session), `session_offline`, `bad_request`.

### Freshness: `SessionSummary.commandsVersion`

`commandsVersion?: string` is opaque and changes whenever the session's list changes (`/reload`, an
extension registering a command, skills discovered after startup); it arrives with `session.upsert`
like any summary change. Compare it for equality with the version the cached list was fetched at,
and refetch when it differs. Absent: the session predates slash commands.

### Running a command

Send `session.prompt` with `text` = `/name args`. `mode` and `images` work as for any prompt. The
session routes it as the terminal would, in this order:

1. **Built-ins** run in the session and add no transcript item; their effect shows in
   `session.upsert` (name, model, thinking level) or as a new session.
   - `/new` (no arguments) starts a new session; see [Session replacement](#session-replacement-replacedby).
     `/clear` is accepted as an alias but not listed (the terminal has no `/clear`).
   - `/compact [instructions]` compacts the context. Only on an idle session; on a working one the
     ack is `bad_request` (the terminal queues it; a remote request cannot without aborting the run).
   - `/name <name>`; `/model <provider/model>` (exact reference, from the session's scoped models
     when it has any, else every available model; unknown → `not_found`); `/thinking <level>` (one
     of the model's levels).
   - Missing or invalid arguments → `ack ok:false bad_request` with a usage message. Images with a
     built-in → `bad_request`.
2. **Built-ins that need the terminal**, and `/remote` → `ack ok:false bad_request` ("/settings needs
   the phi terminal; ...") instead of reaching the model as text.
3. **Extension commands** run (no model needed); **skills** (`/skill:<name> args`) and **prompt
   templates** (`/<template> args`) expand; the result goes to the model, steered or queued per
   `mode` like any prompt.
4. **Bare skill names** (phi remote only; the terminal does not do this): `/<name> args`, when no
   built-in, extension command or prompt template is called `<name>` but the skill `skill:<name>`
   exists (and skill commands are on), runs that skill as `/skill:<name> args`.
5. **Anything else** (an unknown `/foo`) goes to the model as plain text, as in the terminal.

`ack ok:true` means dispatched: the command started, or the prompt started or was queued. For
`/new` the ack follows the new session's registration; for `/compact` it waits up to 1 s so quick
failures ("Nothing to compact") come back as `bad_request`, and a compaction still running then is
acknowledged and lands later as a `reset`.

### Transcript

- An expanded **skill** is a `user` item whose `text` is what the user typed: `/skill:<name> args`
  (`/skill:<name>` without arguments), also when the user typed the bare name. The terminal shows the
  same prompt as a collapsed skill block followed by the request. Snapshot, history and live
  upserts agree; the session name taken from a first prompt uses the same text.
- A **prompt template** is a `user` item with the expanded text, as the terminal shows it.
- **Extension commands** and **built-ins** add no `user` item.

### Session replacement (`replacedBy`)

`/new`, and `/resume`, `/fork`, `/clone`, `/import` in the terminal, switch the phi process to a
session with a new `sessionId`. The process stays connected, and the hub sends, in order:

1. to every client subscribed to the old session: `session.event { sessionId: OLD, event: { type:
   "reset", replacedBy: NEW } }`;
2. to every client: `session.remove { sessionId: OLD, replacedBy: NEW }`;
3. `session.upsert { session: <NEW> }`.

An app that sees `replacedBy` moves the open thread to `NEW` and subscribes to it (`session.subscribe`
→ snapshot). Without `replacedBy`, `reset` and `session.remove` mean what they always meant: a session
that disconnects or ends is removed with no successor.

## Subagents (v1 addition)

Additive. A session's subagent runs (the `subagent` tool: single, parallel and chain tasks, in the
foreground or in the background) are listed as sessions of their own, `kind: "subagent"`, children of
the session that launched them. The parent's phi process serves them itself from each child's event
stream (it already runs and watches every child), so they work while the run is live and after it
has finished, with no change to the child processes.

### Opt-in: `hello.features`

| Direction | `t` | fields |
|---|---|---|
| client → hub | `hello` | ..., `features?: string[]` |

`features` lists optional additions the app understands. With `"subagents"` in it the hub sends
subagent sessions in `sessions`, `session.upsert` and `session.remove`. Without it the app never sees
one: they are left out of `sessions`, their upserts and removes are not sent, and any request naming
one fails as for an unknown session (`not_found`). Unknown features are ignored. At most 32 entries
of ≤ 64 chars are read.

### `SessionSummary` fields

```ts
type SessionSummary = {
  // ...as above, plus:
  kind: "interactive" | "headless" | "subagent";
  // kind "subagent" only:
  parentSessionId?: string;   // the session that launched it
  subagent?: {
    runId: string;
    toolCallId?: string;      // the parent's `subagent` tool call (its transcript `tool` item)
    index?: number;           // 0-based position in that call's `tasks` / `chain` (0 for `task`)
    name?: string;            // the task's explicit `name`, when it had one
    agent?: string;           // named agent definition used
    task: string;             // one line, ≤ 200 chars
    status: "running" | "done" | "failed" | "killed";
    startedAt: number;        // ms epoch
    endedAt?: number;
    turns?: number;
    toolCalls?: number;
    background?: boolean;     // launched in the background (the parent's turn did not wait)
  };
  // any session that launched subagents still listed (absent when none):
  subagents?: { running: number; total: number };
};
```

- `sessionId` of a subagent session: `<parentSessionId>~sa~<runId>` (opaque to the app; use
  `parentSessionId` to find the parent).
- `name` = the task's `name` (a name repeated within one call gets ` #2`, ` #3`, as in the
  terminal), else its `agent`, else the first line of the task (≤ 60 chars).
- `status` is `working` while the run is running, then `idle`; `subagent.status` says how it ended
  (`killed` = aborted from the phone, the `/subagents` viewer or the tool's kill action).
- `cwd`, `host`, `model` (the model the run was launched with; `provider` may be `""` when only an
  id is known), `thinkingLevel`, `activity`, `lastText`, `usage` (`costUsd`, `contextPercent`),
  `startedAt` and `lastActivityAt` are filled like any session's. `pid` is the child process's
  (the parent's until the child has started).
  `commandsVersion` and `subagents` are never set on a subagent session.
- Retention: listed until the parent session ends or is replaced; at most 50 per parent, the
  oldest finished one is removed first (then the oldest).
- A parent that starts subagents before any hub has seen it does not list those runs.

### Requests on a subagent session

| Request | Effect |
|---|---|
| `session.subscribe`, `session.history` | As for any session: snapshot then live `item.upsert` / `state` events, same item kinds, ids and throttles. |
| `session.prompt` | Running: delivered to the run through its control channel; `auto` and `steer` steer it (after its current tool call), `followUp` queues it after its current turn; a run waiting on a question (`message_parent`) gets the text as the answer. `ack ok:true` = written to the run. Finished: `ack ok:false bad_request "subagent finished"`. `images` → `bad_request`. |
| `session.abort` | Kills the run (as the tool's kill action does); `ack ok:true`, also when it has already finished. |
| `session.close`, `models.list`, `session.setModel`, `session.setThinking`, `commands.list` | `bad_request` (in the request's failure shape, clarification 2). |

- No push notification is ever sent for a subagent session.
- When the parent session ends, disconnects or is replaced (`/new`, `/resume`, ...), each of its
  subagent sessions gets `session.remove { sessionId }` (no `replacedBy`), before the parent's own
  `session.remove`.

### Subagent transcript

- The first item is the task: `{ id: "u:task", kind: "user", text: <task> }` (`ts` = run start).
- Then the child's messages as for any session: `assistant` items (streamed), one `tool` item per
  tool call (`t:<assistantTs>:<toolCallId>`), `note` items for displayed custom messages and
  compactions. A prompt sent from the phone appears as a `user` item with the text as typed.
  Messages from the parent agent (the tool's message action) appear as `user` items starting
  `[message from your parent agent]`.
- Kept in memory by the parent process: at most 500 items and about 512 KiB per subagent; beyond that
  the oldest are dropped and the first item becomes a `note` ("N earlier items are no longer
  kept."). Tool output is truncated as for any session.

### The `subagent` tool item in the parent's transcript

Unchanged kind (`tool`, `name: "subagent"`), so it renders as a card. `summary` is one line:
`3 subagents: ws-a, ws-b, scout` (each task's name, else agent, else first line), `2 subagents
(chain): plan → build`, `1 subagent: <name>`, `subagent  status`, `subagent  kill ws-a`,
`subagent  message ws-a  <text>`. `args` keeps its shape within the ~4 KB cap: `tasks` / `chain`
stay an array with every task's `name`, `agent`, `model`, `cwd`, `timeoutSeconds`; only the `task`
texts are shortened. The child sessions of that call are the ones whose `subagent.toolCallId` is the
item's `toolCallId`, in `subagent.index` order.

## tmux session names (v1 addition)

Additive. A phi process running inside tmux reports its tmux session:

```ts
type SessionSummary = {
  // ...as above, plus:
  tmux?: { session: string; window?: string };  // raw tmux session and window names
};
```

`name` precedence: an explicit session name (`/name`) always wins; else the tmux session name;
else the first prompt line; else the cwd basename. A tmux session named by a devbox tab
(`devbox-<profile>-<n>-<title>`) gives `<title>`; tmux's default numeric names (`0`, `1`, ...) are
not used. Renames reach the app within about 30 s. The app may show `tmux.session` as a subtle tag.

## Overseer threads and last error (v1 addition)

Additive. Two optional summary fields, set by phi sessions that know them; apps may ignore both:

```ts
type SessionSummary = {
  // ...as above, plus:
  overseer?: { sessionId: string; name?: string; thread?: string }; // the phi session that started
                              // this one (an "overseer"), its display name, and this thread's name
  lastError?: string;         // error of the last assistant message, ≤200 chars, single line; absent
                              // once a later assistant message ends without one (an abort is not one)
};
```

Neither changes any frame or any other field. Sessions started by an overseer may be interactive or
headless; `kind` keeps its meaning. See "Local control for agents (overseer)" in
[phi remote](remote.md).

## Session history (v1 addition)

The host and any compatible client build against this text. Additive to protocol v1; everything above still holds. Hubs since phi 1.4.0-exo.7 implement it.

### Capability

`welcome.host` gains `features?: string[]`. A hub that implements this section includes
`"history"`. The app shows past sessions and Resume only for hubs that advertise it; for an
older hub it shows one quiet line: "Update phi on <host> to see its past sessions"
(update the host from its own trusted distributor, then run `phi remote install`). Unknown requests to old hubs already fail with `error bad_request`.

### Requests (client -> hub)

| `t` | fields | reply |
|---|---|---|
| `sessions.past` | `id`, `limit?` (default 50, max 200), `cursor?` (opaque string from the previous reply), `query?` (string <= 200 chars), `cwd?` (exact cwd filter) | `sessions.past` |
| `session.transcript` | `id`, `sessionId`, `before?` (item id), `limit?` (default 120, max 500) | `session.transcript` |
| `session.resume` | `id`, `sessionId`, `prompt?`, `provider?`, `modelId?`, `thinkingLevel?` | `ack` with `sessionId`, `cwd?`, `cwdFallback?` |

### Replies (hub -> client)

| `t` | fields |
|---|---|
| `sessions.past` | `re`, `sessions: PastSession[]` (newest `modifiedAt` first), `nextCursor?: string` (absent = end), `indexing?: boolean` (true while the hub is still building its index; the app may re-request) |
| `session.transcript` | `re`, `sessionId`, `items: TranscriptItem[]` (oldest -> newest, the newest page when `before` is absent), `hasMore: boolean` |

Failures use clarification 2: `sessions.past` / `session.transcript` fail with
`error { re, code, message }`; `session.resume` fails with `ack { re, ok: false, error }`.

```ts
type PastSession = {
  sessionId: string;        // phi session id (the session file header id)
  title: string;            // session_info name, else first user message line (<= 120 chars), else cwd basename
  named: boolean;           // true when title came from a session_info name
  cwd: string;              // "" for very old sessions
  createdAt: number;        // epoch ms
  modifiedAt: number;       // epoch ms (last entry / file mtime)
  messageCount: number;     // user + assistant messages
  preview?: string;         // last assistant reply text, one line, <= 200 chars
  model?: { provider: string; id: string };   // last model used
  live: boolean;            // a session with this id is registered with the hub right now
  liveKind?: "interactive" | "headless";      // when live
  resumable: boolean;       // false only when the session file can no longer be read
};
```

### Semantics

1. **Which sessions.** Every stored phi session on that machine (all project dirs under the
   phi sessions dir, i.e. what `phi --resume`'s "all" scope shows), excluding: sessions with 0
   messages, subagent child sessions, and anything that is not a valid phi session file.
   Live sessions ARE included (with `live: true`) so the list is complete.
2. **Search.** `query` is a case-insensitive substring match over title, cwd and the session's
   message text (user + assistant text, like phi's /resume search). Cursor pagination applies
   to the filtered result.
3. **Transcript.** `session.transcript` works for any listed session, live or not. Items are
   built by the SAME transcript code the live session bridge uses for `session.snapshot` /
   `session.history`, so the ids and shapes match exactly what that session will produce once
   resumed (the app swaps from the stored transcript to the live one without duplicates or
   gaps). For a live session the hub may forward to the session (`snapshot`/`history`).
   Unknown `sessionId` -> `not_found`; unknown `before` -> `not_found`.
4. **Resume.** If the session is live, ack at once with its `sessionId` and `cwd` (no new
   process); a `prompt` is then delivered like `session.prompt` mode `auto`. Otherwise the hub
   starts a headless `phi --mode rpc --session <that session file>` (plus `--model` /
   `--thinking` when given, validated exactly as `session.spawn` validates them) and acks after
   the child registers (same 30 s + burst grace as spawn). The resumed live session keeps the
   SAME `sessionId` and continues the SAME file, with its full context. `prompt` (if given) is
   sent once the child registers. **Any listed session can be resumed, wherever its folder is:**
   the hub's allowed roots (`$HOME`, `--allow-root`) limit `session.spawn` only, never resume,
   because the session file is already on that machine. A missing folder never blocks a resume
   either; the hub runs the session in the first of: (a) the recorded `cwd`, if it is a
   directory; (b) that path re-rooted from another home (`/Users/<u>/X` or `/home/<u>/X` ->
   `$HOME/X`; sessions synced from another machine), if it is a directory; (c) the nearest
   existing ancestor of the recorded `cwd` other than `/`; (d) `$HOME`. The ack's `cwd` is the
   folder used, and `cwdFallback: true` is set when it differs from the recorded one (the app
   may show a quiet note such as "Resumed in ~/X: the original folder is gone"). Hubs before
   1.4.0-exo.8 omit both and refuse such resumes. Errors: unknown session -> `not_found`;
   a session file that can no longer be read -> `internal` (the child exits); a second
   concurrent resume of the same session joins the first (all ack with the same id, `cwd` and
   `cwdFallback`; one process).
5. **Cost.** The hub keeps an index (cached by path + size + mtime, refreshed incrementally,
   warmed at hub start) so `sessions.past` answers in well under 500 ms once warm on a machine
   with ~2,500 session files / 2 GB. While cold it answers with what it has and `indexing: true`.
6. **Privacy.** Same trust as live sessions: only authenticated (paired) devices. Nothing
   leaves the machine except to the paired phone.

### App side ("one central place")

The app is the central place: it merges `sessions.past` from every paired computer into ONE
list (newest first), and persists that merged index plus the transcripts the user has opened
(bounded cache) on the phone, so sessions of an offline computer (e.g. a stopped devbox) are
still listed and readable. Resume needs that computer online.

### How phi's hub implements it

Informative; the contract above is what binds.

- **Index.** Built in the background at hub start (`src/remote/hub/history.ts`), newest files
  first, yielding to the event loop every ~8 ms. A file is re-read only when its size, mtime or
  inode changed, and then only from the last line already folded in (session files are
  append-only; a shrunk or replaced file is read again). Tool results and entry types the listing
  does not use are recognized from their first 256 bytes and never decoded; image payloads are
  dropped before parsing. Per session the hub keeps the listing fields and the lower-cased
  user + assistant text (skill prompts as typed, `/skill:name args`), never transcripts.
  `sessions.past` refreshes first when the index is older than 2 s (a no-change refresh stats
  every file: ~15 ms for 2,400 files). Measured on a laptop with 2,404 files / 2.2 GB: first build
  ~2 s; warm `sessions.past` p50 0.7 ms without a query, 4–10 ms with one (max ~35 ms, when it
  includes the refresh); about 15 MB of search text, ~65 MB more hub RSS.
- **Fields.** `title` is the latest `session_info` name, else the first non-empty line of the
  first user message, else the cwd basename (else the first 8 chars of the id). `modifiedAt` is
  the newest entry timestamp in the file (never before `createdAt`); `model` is the latest of the
  assistant messages' model and `model_change` entries; `preview` is the text of the last
  assistant message that has text. Two files claiming one session id: the most recently active
  one is listed. `resumable` is false only when the file can no longer be read (a listed file
  always parsed); the folder is not consulted (hubs before 1.4.0-exo.8 also set it false outside
  the allowed roots).
- **Subagents.** phi's `subagent` tool runs its children with `--no-session`, so no child session
  is ever stored; their live threads (`kind: "subagent"`) are never listed. A session file whose
  header carries a `subagent` marker is excluded as well.
- **Transcript.** A stored page is `storedTranscript()` (`src/extensions/remote/transcript.ts`):
  the bridge's own `walkBranch` over the branch the session manager would resume (leaf = last
  entry), with no in-flight records and a tool call that has no result shown as `error` — exactly
  what the resumed session's bridge renders while idle. Only the lines a page needs are parsed
  (ids and parents come from each line's first bytes; entries are parsed backwards from the leaf
  in growing windows). At most two stored transcripts are read at once. A live session is asked
  for its own `snapshot` / `history` (so in-flight items are included); if it goes away while
  asked, its file answers.
- **Resume.** The child is `phi --mode rpc --session <file> --session-cwd <dir> [--model p/id]
  [--thinking level]`, started in `<dir>` (the folder chosen above), with the same environment
  rules as `session.spawn`. `--session-cwd` makes phi keep the session's id and file and run it
  in `<dir>` instead of the header's cwd: without it phi in rpc mode exits when the recorded
  folder is gone (`Stored session working directory does not exist`). A live session's
  resume ignores `provider` / `modelId` / `thinkingLevel` (use `session.setModel` /
  `session.setThinking`); a joining resume's model arguments are ignored too (the first one
  started the child), but each joining `prompt` is delivered, in order. For the first 10 s after
  the hub starts, a resume of a session that is not live waits (up to the rest of those 10 s) for
  it to re-register: sessions that ran before a hub restart reconnect within ~5 s, and resuming
  one of them before that would start a second process on its file.

## Overseers (v1 addition)

The host and a compatible client build against this text. It is
additive to protocol v1; everything above still holds. Hubs since phi 1.4.0-exo.12 implement it.

An overseer is a phi session that starts and manages other phi sessions, its **threads**, with the
`overseer` tool. Thread sessions report `summary.overseer = { sessionId, name?, thread? }` (see
"Overseer threads and last error" above). Each overseer keeps a registry file
`<agentDir>/overseer/<overseerSessionId>.json` (`src/extensions/overseer/registry.ts`, `types.ts`
`ThreadRecord`) that lists every thread it started or adopted: running, exited and closed.

### Capability

`welcome.host.features` includes `"overseer"` on hubs that implement this section. The app shows
overseer UI only for those hubs. For older hubs it may still group live threads by
`summary.overseer`, but it does not offer starting an overseer from the phone.

### Summary fields

```ts
type SessionSummary = { /* existing fields, plus: */
  isOverseer?: true;   // this session has an overseer registry file with at least one thread,
                       // or a live session names it in summary.overseer.sessionId
  threadCounts?: { total: number; working: number; idle: number; error: number; exited: number; closed: number };
                       // on overseers only; computed by the hub from the registry plus live summaries.
                       // "error": live threads with lastError. "exited": state exited, or registered but not
                       // live. "closed": state closed.
};
type PastSession = { /* existing fields, plus: */
  overseer?: { sessionId: string; name?: string; thread?: string };  // from the registry files (inverse index)
  isOverseer?: true;
};
```

When a registry file changes, the hub sends a `session.upsert` for the overseer, so its
`threadCounts` stay fresh. Watch `<agentDir>/overseer/` (fs.watch, debounced) or refresh it on the
existing 30 s rescan. It must never be slower than one update every 5 s while a thread is working.

### Requests

| `t` | fields | reply |
|---|---|---|
| `overseer.board` | `id`, `sessionId` (the overseer) | `overseer.board` |
| `session.spawn` | adds optional `name?: string` (one line, at most 200 chars, passed as `--name`, as the ctl spawn already does) | unchanged |

```ts
// hub -> client
type OverseerBoard = {
  t: "overseer.board"; re: string; sessionId: string; name?: string;  // the overseer's session name
  threads: BoardThread[];  // registry order (createdAt ascending)
};
type BoardThread = {
  name: string; sessionId: string;
  backend: "forca" | "tmux" | "headless" | "external"; adopted?: boolean;
  cwd: string; model?: string; thinking?: string;            // model = "provider/id"
  state: "running" | "exited" | "closed";                    // registry state
  live: boolean;                                             // registered with the hub right now
  status?: "working" | "idle";                               // live summary status when live
  activity?: string;                                         // live summary activity (current tool, etc.)
  lastText?: string; lastError?: string;                     // live summary first, else registry
  costUsd?: number; contextPercent?: number;
  createdAt: number; lastActivityAt?: number; exitedAt?: number; closedAt?: number;
  subagentModels?: { default?: string; allow?: string[] };
};
```

An unknown overseer (no registry file and no live thread naming it) gets `error not_found`. A
corrupt registry file gets `error internal` with a short message; never crash the hub. Also add
`overseer.board` with the same reply `data` to the ctl op table, if cheap.

### Starting an overseer from the phone (app behaviour; no extra hub op)

The app spawns a headless session (`session.spawn`) with `name: "Overseer · <goal, first ~40 chars>"`
and a first `prompt` that invokes the overseer skill with the goal. Use the command the hub's
`commands.list` reports for the overseer skill (e.g. `/skill:overseer` or `/overseer`). If none is
listed, send plain text that starts with "Act as overseer (use the overseer tool): ". The app
appends the user's thread defaults to that prompt in plain words: thread model and thinking,
thread window (`auto` or `headless`), subagent model policy, how many threads at most.
"Add a thread" on an existing overseer sends that overseer a normal `session.prompt`
(mode `auto`): "Start a new thread: <description>" plus the same defaults.

### How phi's hub implements it

Informative; the contract above is what binds.

- **Registry index** (`src/remote/hub/overseers.ts`). The hub watches `<agentDir>/overseer/`
  (fs.watch, 150 ms debounce) and also re-scans it every 5 s, which picks up a directory created
  after the hub started. A scan stats every `<id>.json` (temp files `<id>.json.<hex>.tmp` are
  skipped) and reads a file only when its mtime, size or inode changed; all I/O is async, one scan
  runs at a time, and files over 8 MiB are not read. Records the overseer itself would reject
  (no `sessionId`, unknown `backend` / `state`) are skipped; text fields are cut to one line.
  `overseer.board` re-reads the requested file first if it changed.
- **Corrupt files.** A file that does not parse is logged once in `hub.log`, keeps its last good
  threads for `isOverseer`, `threadCounts` and past-session links, and makes `overseer.board`
  answer `internal` (`overseer registry of <id> is unreadable: not valid JSON`) until it parses again.
- **Counts.** The six buckets are disjoint and sum to `total`. Live status beats registry state: a
  live thread counts as `working` (status working), else `error` (has `lastError`), else `idle`,
  whatever its registry state. A thread that is not live counts as `closed` (registry state closed)
  or `exited` (anything else). Live sessions naming the overseer that its registry does not list
  yet count as live threads. The overseer's `session.upsert` is re-sent (throttled like any upsert,
  500 ms) whenever its counts change: a thread registers, leaves, changes status or error, or the
  registry file changes. A session cannot set `isOverseer` / `threadCounts` itself; the hub drops
  them from what it sends. The control wire's `sessions.list`, `session.snapshot` and `status`
  carry the same fields.
- **Board.** A live thread's `cwd`, `model`, `thinking`, `status`, `activity` (`"<tool> <summary>"`,
  only while working), `lastText`, `costUsd`, `contextPercent` and `lastActivityAt` come from its
  live summary, and its `lastError` only from the live summary (a live thread without one has
  none). Threads the registry does not list yet follow the registry's threads, oldest first, with
  `state: "running"`. `name` is the overseer's live session name, else its stored session's title,
  else the `overseer.name` a live thread reports.
- **Past sessions.** `PastSession.overseer` is the live session's own `summary.overseer` when it
  is live, else the registry that lists it (a thread in two registries: an open record beats a
  closed one, then the newest); `name` is filled in as for the board.
- **Spawn `name`.** Validated as for the control wire (one non-blank line of at most 200
  characters, trimmed); anything else is `ack` `bad_request` and starts nothing. Apps still cannot
  pass `appendSystemPrompt` or `env`.
