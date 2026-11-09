# phi remote

`phi remote` lets the phi iPhone app see and drive every phi session running on your machine. It
works like Claude Code Remote Control. From the phone you can read the live transcript, send a
prompt or steer a running turn, abort, switch the model or thinking level, start a new session in
a directory, and get a notification when a session finishes.

```
iPhone app ──WebSocket──▶ phi remote hub (one per user per machine) ◀──unix socket── each phi session
            over Tailscale    `phi remote serve`, port 7717              (built-in remote extension)
```

- **The hub** is a small background process. It owns the network listener, device pairing,
  the list of sessions, the headless sessions it starts for the phone, and push notifications.
- **Sessions** are your normal phi sessions. Each one connects to the hub's local socket if the
  hub is running and registers itself. Sessions never open network ports. A session that cannot
  reach the hub carries on as usual.

The wire contract between the hub and the app is in [phi remote protocol](remote-protocol.md).

## Quick start

1. Install [Tailscale](https://tailscale.com) on the computer and the iPhone, signed in to the same
   tailnet.
2. Pair the phone:

   ```bash
   phi remote pair
   ```

   This starts the hub if it is not running, then prints a QR code, an 8-character code and the
   URLs the phone can use. Scan the QR code with the phi app (or the iPhone camera). The command
   prints `Paired <device>` and exits once the phone has paired.
3. Optional: run the hub at login so it is always available:

   ```bash
   phi remote install
   ```

You can also start pairing from inside a session with `/remote`.

## Commands

| Command | What it does |
|---|---|
| `phi remote serve [--port N] [--bind a,b] [--allow-root dir]` | Run the hub in the foreground (Ctrl-C stops it). |
| `phi remote start [same flags]` | Start the hub in the background; logs go to `hub.log`. |
| `phi remote stop` | Stop the hub. Headless sessions it started are ended. |
| `phi remote status [--json]` | Show the hub, its URLs, the live sessions and the paired devices. |
| `phi remote pair` | Show a pairing QR code and wait for the phone. |
| `phi remote devices [--json]` | List paired devices. |
| `phi remote revoke <device-id>` | Unpair a device and close its connections at once. |
| `phi remote install [flags]` / `uninstall` | Run the hub at login (launchd on macOS, `systemd --user` on Linux). |
| `phi remote push setup ...` / `push test` | Configure and test push notifications (see below). |
| `phi remote ctl '<json>'` / `ctl -` | Send one control op to the hub and print the reply as JSON (see [Local control for agents](#local-control-for-agents-overseer)). |

Only one hub runs per user. `serve` and `start` report the existing hub if one is already running.

## Network and security

- The hub listens on port **7717**. By default it binds `127.0.0.1` and every Tailscale address
  of this machine (`100.64.0.0/10`). It re-scans every 30 seconds, so it picks up Tailscale when
  Tailscale starts after the hub. It never listens on all interfaces unless you pass
  `--bind 0.0.0.0` (for example, to pair over home Wi-Fi without Tailscale).
- Traffic is plain HTTP/WebSocket. Tailscale's WireGuard tunnel encrypts it between your devices.
- **Pairing codes** are single use and expire after 10 minutes. Only a local user can mint one
  (`phi remote pair` or `/remote`). Pairing attempts are limited to 5 per minute per IP address.
- Each paired device gets a random 32-byte **token**. The hub stores only its SHA-256 hash and
  compares hashes in constant time. Every connection must authenticate within 5 seconds.
  `phi remote revoke` closes that device's connections immediately.
- Without a token, a client can only read `/v1/info` (host name, hub id, version, protocol) and
  try `/v1/pair`. Every other path returns 404. Pairing bodies over 16 KiB are refused. A
  connection must send its request headers within 10 seconds and the whole request within 15
  seconds. Before authenticating, a WebSocket message may be at most 64 KiB, and at most 32
  connections may wait to authenticate. After authenticating, a message may be up to 12 MiB. Both
  limits apply to the size in the frame header, before anything is buffered. Pairing codes and
  tokens are never written to a log.
- The pairing link lists the URLs the phone tries in order: the MagicDNS name (from
  `tailscale status`, when available), the Tailscale IPs, then any other non-loopback address the
  hub is bound to. `127.0.0.1` is included only when the hub is bound to loopback alone
  (`--bind 127.0.0.1`), which is useful for the iOS Simulator.

## Starting sessions from the phone (headless)

When the app starts a new session, the hub runs `phi --mode rpc` in the chosen directory, using
the same phi executable as the hub. The command runs without a shell, and the hub checks the model
against the model registry before passing it on. The new session is a normal, persisted phi session
that you can resume from a terminal later. It does not inherit the hub's session variables
(`PI_SESSION_*`, `PI_SUBAGENT_*`, `PHI_REMOTE*`, `PHI_OVERSEER_*`, `PHI_SUBAGENT_MODEL_*`). Nobody is
at its terminal, so the hub cancels any extension dialog (confirm, select, input, editor) that the
session opens. The session's stderr goes to `headless.log`, which rotates at 5 MB.

Headless sessions end with the hub. When the hub stops, crashes or gets a signal, it signals them.
If the hub is killed outright, their stdin closes and they exit on their own.

The directory must exist and be inside your home directory. Pass `--allow-root <dir>` (repeatable)
to `serve`, `start` or `install` to allow other roots. Symlinks are resolved before the check. The
app's recent-directories list shows only directories it could start a session in.

Only headless sessions can be closed from the phone. `phi remote stop` ends all of them.

The app can also pick the new session's thinking level; the hub passes it as `--thinking`, and
name it (one line, at most 200 characters); the hub passes that as `--name`. There is
no limit on how many headless sessions a hub runs; each one is a full phi process (about 100 MB of
memory), so memory is what bounds it in practice. The hub holds about four file descriptors per
headless session; phi's runtime raises its open-file soft limit at start, also under launchd (256
soft by default) and systemd, so descriptors do not run out first. Sessions started together share the CPU, so the 30 s connect
timeout grows by 1 s for every other session still starting.

## Overseers on the phone

An overseer is a phi session that starts and manages other phi sessions, its threads (see
[Local control for agents](#local-control-for-agents-overseer)). Hubs since phi 1.4.0-exo.12 tell the
app about them (`welcome.host.features` includes `overseer`):

- An overseer's summary carries `isOverseer: true` and `threadCounts` (`total`, `working`, `idle`,
  `error`, `exited`, `closed`), from its registry file (`~/.pi/agent/overseer/<id>.json`) merged
  with the threads that are live right now. A live thread's status always wins over what the
  registry last recorded. The hub re-sends the overseer's summary whenever a count changes: a thread
  starts, ends, goes working or idle, errors, or the registry file changes (the hub watches the
  folder and re-scans it every 5 s).
- `overseer.board` returns every thread of one overseer, running, exited and closed, in the order
  it started them: name, backend, folder, model, state, whether it is live, its status and current
  tool, its last reply or error, cost and context. The app uses it for the overseer's board, and
  for stepping into a thread: a live thread opens like any session, an exited one can be resumed.
- Past sessions carry `overseer` (which overseer started this one, and the thread's name) and
  `isOverseer`, so the phone can group them after the processes are gone.
- The app starts an overseer as a headless session named `Overseer · <goal>` whose first prompt
  invokes the overseer skill; no extra hub op is involved.

The registry files are read-only to the hub. A file that does not parse is logged once in
`hub.log`; its last good contents still count, and its board answers with an error until the
overseer writes it again. Protocol: [remote-protocol.md](remote-protocol.md), "Overseers".

## Past sessions and resume

The app lists every phi session stored on each paired computer, not only the running ones, and
merges them into one list. On this machine that is every session under `~/.pi/agent/sessions`
(what `phi --resume` shows with the "all" scope), newest first, with its title (its `/name`, else
its first prompt line), folder, message count, last reply and model. Empty sessions and subagent
runs are not listed. You can search titles, folders and the text of your prompts and phi's replies.

Open one to read its transcript. Resume it and phi continues that same session, in its folder, with
its whole context: the hub runs `phi --mode rpc --session <file>` (as a headless session), and the
session keeps its id and keeps writing to the same file, so `phi --resume` in a terminal shows it
too. If the session is already running (in a terminal or as a headless session), resume just opens
it; no second process starts. Every listed session can be resumed: the allowed roots
(`--allow-root` above) only limit new sessions started from the phone. If a session's folder no
longer exists (a removed worktree, a `/tmp` folder, a path from another machine), it resumes in
the same path under this machine's home if that exists (`/Users/<you>/X` -> `$HOME/X`), else in
the nearest parent folder that still exists, else in `$HOME`, and the app is told where.

The hub builds its index of stored sessions when it starts (about 2 seconds for 2,400 sessions) and
then only re-reads files that changed, from where it left off. It keeps the listing fields and the
searchable prompt and reply text in memory, never whole transcripts. Older hubs do not have this;
the app then shows "Update phi on <host> to see its past sessions": update phi with the install
command and run `phi remote install`. See
[Session history](remote-protocol.md#session-history-v1-addition) in the protocol.

## Slash commands

The app lists a session's slash commands and runs one when you send `/name args`, as if you typed
it in the terminal. The list has the session's skills (as `skill:<name>`), prompt templates and
extension commands, plus the built-ins that work without a terminal: `/new`, `/compact`, `/name`,
`/model` and `/thinking`. Built-ins that need the terminal, such as `/settings` or `/tree`, are
refused instead of being sent to the model. On the phone you can also type a skill without the
prefix (`/use-subs ...` runs `/skill:use-subs ...`) when nothing else has that name. The transcript
shows a skill prompt the way you typed it. See
[Slash commands](remote-protocol.md#slash-commands-v1-addition) in the protocol.

## Subagents

When a session runs the `subagent` tool, each subagent shows up in the app as a thread of its own
under that session. You can read its transcript while it works and after it finishes, steer it
(a prompt is delivered after its current tool call, or after its turn with follow-up), and abort
it. The session itself serves these threads from the subagents' output, so it does not matter
whether they run in the background. They stay listed until the session ends or is replaced, at most
50 per session; the oldest finished ones go first. Subagent threads never send a push, and the app
sees them only if it says it supports them. See
[Subagents](remote-protocol.md#subagents-v1-addition) in the protocol.

## tmux names

A session running inside tmux is named after its tmux session, unless you named it with `/name`.
For a devbox tab (`devbox-<profile>-<n>-<title>`) the name is the tab's title. tmux's default
numeric names (`0`, `1`, ...) are ignored. A rename shows up in the app within about 30 seconds.

## Local control for agents (overseer)

A program on this machine can drive sessions through the hub too, without the phone. The overseer
(a phi session that starts and manages other phi sessions, its threads) works this way, and so can
any script or agent, through `phi remote ctl`. Requests go over `hub.sock` as control frames, the
same newline-delimited JSON the `phi remote` commands use:

```
-> {"t":"ctl","id":"c1","op":"sessions.list"}
<- {"t":"ctl.reply","re":"c1","ok":true,"data":{"sessions":[...]}}
<- {"t":"ctl.reply","re":"c2","ok":false,"error":{"code":"not_found","message":"no live session ..."}}
```

Every request gets exactly one reply. Error codes are the protocol's: `not_found`, `bad_request`,
`forbidden`, `session_offline` (the session did not answer within 15 seconds, or disconnected while
asked) and `internal`. The types are `CtlSessionOp`, `CtlSessionsData`, `CtlSpawnData` and
`CtlSnapshotData` in `src/remote/protocol.ts`. A hub older than this phi answers the session ops
with `bad_request` `unknown control op: ...`; restart it (`phi remote stop`, then `phi remote start`).

**Trust.** `hub.sock` is mode 0600 in a 0700 directory, so only your user can connect. That is the
same trust as `phi remote stop` or minting a pairing code. A control client needs no device token,
sees every session (also those the phone does not), and can start sessions in any existing
directory: the allowed roots (`--allow-root`) apply to the phone only.

| Op | Fields | Reply `data` |
|---|---|---|
| `sessions.list` | `subagents?` | `{ sessions }`, most recently active first. Subagent threads only with `subagents: true`. |
| `session.spawn` | `cwd`, `prompt?`, `provider?`, `modelId?`, `thinkingLevel?`, `name?`, `appendSystemPrompt?`, `env?` | `{ sessionId, cwd, pid? }`, once the new session has registered. |
| `session.prompt` | `sessionId`, `text`, `mode?` (`auto`, `steer`, `followUp`; default `auto`) | `{}` once the session accepted it. |
| `session.abort` | `sessionId` | `{}` |
| `session.setModel` | `sessionId`, `provider`, `modelId` | `{}` |
| `session.setThinking` | `sessionId`, `level` | `{}` |
| `session.snapshot` | `sessionId`, `limit?` (default 120, at most 500) | `{ items, hasMore, state, summary }`: the live transcript tail, the session's state and its summary. |
| `session.history` | `sessionId`, `before` (an item id), `limit?` (default 120, at most 500) | `{ items, hasMore }`: live items before `before`. |
| `session.transcript` | `sessionId`, `before?`, `limit?` (default 120, at most 500) | `{ items, hasMore }` of any stored session, live or not. |
| `session.resume` | `sessionId`, `prompt?`, `provider?`, `modelId?`, `thinkingLevel?`, `env?` | `{ sessionId, cwd, pid?, cwdFallback? }`, once the session is live. |
| `session.close` | `sessionId`, `overseer?` | `{}` |
| `overseer.board` | `sessionId` (the overseer) | `{ sessionId, name?, threads }`: its threads, registry and live merged, as the app's `overseer.board` ([remote-protocol.md](remote-protocol.md), "Overseers"). `not_found` for an unknown overseer, `internal` for an unreadable registry file. |

The `status`, `pair.create`, `devices.list`, `devices.revoke`, `push.test` and `shutdown` ops of the
`phi remote` commands use the same wire.

**`session.spawn`** starts a headless `phi --mode rpc`, as a phone spawn does: the same executable,
no shell, the model checked against the model registry, `thinkingLevel` passed as `--thinking`.
`cwd` is absolute or `~/...`, must exist and be a directory, and has its symlinks resolved; the
session runs in that real path, which the reply returns as `cwd`. `name` becomes `--name` (one line,
at most 200 characters) and `appendSystemPrompt` becomes `--append-system-prompt` (at most 64 KiB;
phi reads it as a file when the text is the path of an existing file). `prompt` is sent once the
session has registered, as for the phone. The reply waits for the registration, normally a few
seconds. It fails with `internal` when the process exits first (`headless session exited (code N):
<last stderr line>`), or when it has not registered within 30 seconds, plus 1 second for every other
spawn still starting (`headless session did not connect in time`; the process is then ended).
Invalid arguments fail with `bad_request` (an unknown model with `not_found`) and start nothing.

**Thread environment.** `env` on `session.spawn` and `session.resume` passes overseer variables to
the new process: `PHI_OVERSEER_SESSION_ID`, `PHI_OVERSEER_NAME`, `PHI_OVERSEER_THREAD`, any other
`PHI_OVERSEER_*`, and `PHI_SUBAGENT_MODEL_*` (such as `PHI_SUBAGENT_MODEL_DEFAULT` and
`PHI_SUBAGENT_MODEL_ALLOW`). Values must be strings of at most 4096 characters. Every other key or
value is dropped without an error; an `env` that is not an object is a `bad_request`. The variables
are added after the hub removes inherited session variables, so `env` cannot change `PATH`, the spawn
id or anything else. The hub never passes its own `PHI_OVERSEER_*` or `PHI_SUBAGENT_MODEL_*` to a
child: a hub started from inside a thread would otherwise make every session it starts a thread too.

**`session.prompt`** delivers text as the phone does. Text that starts with `/` runs as a slash
command (see [Slash commands](#slash-commands)). `auto` steers a working session and starts a turn
in an idle one; `followUp` holds it until a working session's current turn ends.

**`session.resume`** works as from the phone (see [Past sessions and resume](#past-sessions-and-resume)).
A live session replies at once, gets the prompt, and starts no process; `env` is then ignored.
Any other stored session is continued by a headless `phi --mode rpc --session <file>`, and the reply
waits until it has registered. Resumes of one session that overlap share one process, started with
the first request's `env`. `cwdFallback: true` means the recorded folder no longer exists and `cwd`
is the folder used instead. In the first 10 seconds after the hub starts, a resume first waits for
sessions that ran before the hub to register again.

**`session.close`.** A headless session closes as from the phone: it is asked to close, its process
is ended, and it leaves `sessions.list` when the process exits. An interactive session closes only
for its own overseer: `overseer` must equal the session's `summary.overseer.sessionId`. The hub
checks this and forwards the close; the session checks it again against its own
`PHI_OVERSEER_SESSION_ID`, replies, aborts a running turn and exits the way `/quit` does. The
terminal it ran in stays open. Any other interactive close is `forbidden`. Subagent threads cannot be
closed (`bad_request`).

**Summary fields.** A session started with `PHI_OVERSEER_SESSION_ID` in its environment reports
`overseer: { sessionId, name?, thread? }` (from `PHI_OVERSEER_SESSION_ID`, `PHI_OVERSEER_NAME`,
`PHI_OVERSEER_THREAD`), so an overseer can find its threads again after a restart. Every session
reports `lastError` when its last assistant message ended in an error: one line of at most 200
characters, gone once a later assistant message ends without one. An abort is not an error, nor is an
error whose message is an abort's (`The operation was aborted.`). The hub adds `isOverseer` and `threadCounts` to an
overseer's summary (see [Overseers on the phone](#overseers-on-the-phone)).

### `phi remote ctl`

`phi remote ctl '<json>'` sends one op and prints the reply `data` as JSON on stdout (exit 0). The
JSON is the request object without `t` and `id`, which the command adds. On failure it prints
`{"code": ..., "message": ...}` on stderr and exits 1; `code` is the hub's error code,
`hub_offline` when no hub is running, or `bad_request` when the input is not a JSON object with an
`op`. A missing or extra argument prints the usage and exits 2. With `-` it reads the JSON from
stdin, for long prompts or for use over ssh. It waits up to 90 seconds for `session.spawn` and `session.resume`, 15 seconds for
any other op.

```bash
phi remote ctl '{"op":"sessions.list"}'
phi remote ctl '{"op":"session.spawn","cwd":"~/src/app","name":"tests","prompt":"Run the tests and fix failures"}'
phi remote ctl '{"op":"session.snapshot","sessionId":"<id>","limit":20}'
echo '{"op":"session.prompt","sessionId":"<id>","text":"/compact"}' | ssh box phi remote ctl -
```

## Push notifications

The hub sends pushes directly to Apple Push Notification service (APNs). No third-party service is
involved. You need an APNs auth key (`AuthKey_XXXXXXXXXX.p8`) from the Apple Developer account that
signs the app:

```bash
phi remote push setup --key ~/Downloads/AuthKey_ABC123DEFG.p8 \
  --key-id ABC123DEFG --team-id TEAM123456 --bundle-id dev.example.phiremote
phi remote push test
```

`setup` copies the key to `~/.pi/agent/remote/apns/` with mode 0600, and writes `apns.json`. The
original key file can then be deleted. The hub reads the configuration on every push, so a restart
is not needed.

A push is sent when a session goes from working to idle. The title is the session name and the body
is the start of the final reply, or the error. A push is not sent:

- when the phone has that session open on screen;
- when the run was aborted;
- when push is not configured.

If APNs reports that a device token is no longer valid, the hub drops that device's push
registration. The app registers again the next time it opens.

## Files

Everything lives in `~/.pi/agent/remote/` (mode 0700). Set `PI_REMOTE_DIR` to use another
directory, for example to run a second hub for testing. When it starts, the hub sets the directory
back to 0700 and its files back to 0600, even if they already existed with looser modes. State
files are written atomically: a temp file, then a rename.

| File | Content |
|---|---|
| `hub.sock` | Local socket used by sessions, the `phi remote` commands and other local control clients (0600). |
| `hub.json` | The running hub: `hubId`, pid, port, bound addresses, start time, version (0600). |
| `hub-id` | The hub's stable id, created once (0600). |
| `hub.lock` | Held by the running hub so that two hubs cannot start at the same time (0600). |
| `devices.json` | Paired devices: names, token hashes, push registrations (0600). |
| `apns.json`, `apns/` | Push configuration and the copied `.p8` key (0600). |
| `hub.log` | Hub output when started with `start`, `install` or `/remote` (0600). Past 5 MiB it is copied to `hub.log.1` and truncated. |
| `headless.log` | stderr of the headless sessions the hub started (0600). |

Secrets are kept only in these files. phi never uses the macOS keychain for them.

## Run at login

`phi remote install` creates and loads a login service, and stops any hub you started by hand
first.

- **macOS:** `~/Library/LaunchAgents/org.example.phi-remote.plist`, loaded with
  `launchctl bootstrap gui/$UID`. On a reinstall, `install` unloads the old service and waits for
  launchd to release it before loading the new one, and retries launchd's transient errors (5 and
  37).
- **Linux:** `~/.config/systemd/user/phi-remote.service`, enabled with `systemctl --user enable`
  and (re)started with `systemctl --user restart`.

Running `install` again replaces the definition and restarts the hub with it.

The service runs the same phi executable you installed it from (`node` + `cli.js`, or the compiled
binary). It keeps the `PATH` from install time, because launchd and systemd start services with a
minimal `PATH` and headless sessions need your tools.

The service restarts the hub if it crashes. If you run `phi remote stop`, the hub stays stopped
until your next login. `phi remote uninstall` removes the service. Run `install` again after you
move or reinstall phi.

## Troubleshooting

- **The phone cannot connect.** Run `phi remote status` and check the `urls` line. If it shows no
  Tailscale address, Tailscale is not running on this machine. The hub binds the address within
  30 seconds of Tailscale coming up.
- **A session is missing from the app.** Sessions connect when the hub's socket exists. Sessions
  started before the hub connect on their own after a short delay. Subagents appear as threads under
  the session that launched them, and only in app versions that support them.
- **A past session is missing or out of date.** The list is at most a couple of seconds old.
  Sessions with no messages are not listed. `phi remote status --json` shows the index (`history`:
  files, sessions, build time).
- **Port 7717 is in use.** Start the hub with `--port <n>`. Pairing links carry the port, so pair
  again afterwards.
- **The app shows this computer offline.** `phi remote status` lists each connected app with its
  address, how long it has been connected and its last keepalive pong. `hub.log` has one line per
  app connection event, numbered per connection (`app #12`): `connected from <phone ip:port> on
  <hub ip:port>`, `hello ok` (device, app version and build, protocol, time to `welcome`), `hello
  failed` (reason and close code, e.g. `unknown device token, close 4401`), `missed pong n/3`, and
  `closed by client|server|ping-timeout|lost` (code, reason, duration; `lost` means TCP ended with no
  close frame). No line in `hub.log` for a phone's attempt means it never reached the hub (Tailscale,
  DNS, the phone's network). Per address, failures and missed pongs are written at most once a
  second and other lines at most 4 times a second; the next line written says how many were folded
  (`+N suppressed`). Tokens and headers are never logged.
- **Logs:** `~/.pi/agent/remote/hub.log` and `headless.log`.
