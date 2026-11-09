# Feads agent extension

The built-in `feads-agent` extension connects phi subagents to Feads identities and work flares. Runtime presence reads `FEADS_AGENT_TOKEN` first and, for compatibility with older setups that export `FEADS_TOKEN`, falls back to `FEADS_TOKEN` only when the canonical variable is unset or blank. When neither is in the process environment, both read `<agentDir>/phi.env` (see below). Delegation and work flares remain canonical-only.

## Environment contract

- `FEADS_AGENT_TOKEN` must be one valid Feads agent bearer token in the exact `fdsa_` + 32 lowercase hexadecimal characters format. Set the raw token value only: do not include `Bearer `, an invite token (`fdsi_`), a `${FEADS_AGENT_TOKEN}` placeholder, or surrounding text.
- Runtime presence accepts legacy `FEADS_TOKEN` only when `FEADS_AGENT_TOKEN` is unset or blank. The canonical variable wins when both are present. Rename the legacy variable to `FEADS_AGENT_TOKEN` and restart phi; this compatibility fallback does not enable delegation or flares.
- The token is per user. Feads attributes each request to the identity that owns the bearer token. Each user must run phi with that user's own token; sharing one token makes the runs appear under the token owner's identity.
- `phi.env` fallback: when neither variable is set (non-blank) in the environment, as for phi launched without a login shell (Copper, GUI launchers, some remote servers), phi reads `phi.env` in the agent directory (`~/.pi/agent/phi.env`, or under `PI_CODING_AGENT_DIR`). Only `FEADS_AGENT_TOKEN=...` / `export FEADS_AGENT_TOKEN=...` lines count, then `FEADS_TOKEN` for presence only; matching single or double quotes are stripped, and a value containing `$`, a backtick, whitespace, or `op://`, or not starting with `fdsa_`, is ignored. A missing or unreadable file means no token. phi never writes the file or logs the value; the credential source is `file`.
- phi reads the selected token when the process starts. Changing or adding the variable requires restarting phi (and starting a new child process); `/feads-status` does not reload credentials.
- `FEADS_URL` selects the Feads base URL. It defaults to `http://127.0.0.1:8788`. The status command reports only its parsed host, never credentials, paths, query strings, or fragments.
- `PHI_CLIENT` names the ADE that launched phi (P3 Code sets `p3`, Forca sets `forca`). It is trimmed and lowercased, and must match `^[a-z0-9][a-z0-9-]*$` with at most 32 characters. Without a valid value, `TERM_PROGRAM=Orca` implies `forca`. phi reads it once at startup and sends it as each runtime-presence row's optional `client` field; when it resolves to nothing, rows omit the `client` key entirely.
- `BEADS_ACTOR` is set in a delegated child environment to the actor returned by Feads. The extension does not invent or overwrite it in the parent.
- `FEADS_BOARD` is an optional fallback board id when a touched issue does not provide a `board` argument and its id does not contain a usable prefix.

On a parent `subagent_spawn`, the extension starts an opportunistic POST to `/api/agent/delegate` with the run handle and display name, then returns immediately so network latency cannot delay process launch. Because the child process starts immediately, the response is not injected into its environment; the child inherits the parent identity. A failed request logs only a bounded generic diagnostic and does not affect launch.

A child (`PI_SUBAGENT_ID` is set) observes `mcp_feads_*` and `feads_*` tool calls. Issue ids found in `issue_id`, `target_issue`, or `mine` are raised as flares and refreshed every 30 seconds. The timer starts only after the first actual issue touch. Flares are dropped on `session_shutdown`; requests are fire-and-forget with a short timeout. The parent does not synchronously drop child flares at run end: the server TTL is the crash-safe cleanup path, avoiding a parent-side identity/ownership race.

`/no-feads` and `/skill:no-feads` activate the same session-local runtime guard. It suppresses delegation, raises, drops, and heartbeats, and blocks explicit Feads extension/MCP tools. A new session id resets the guard. Subagents still launch normally.

The command registers with `acceptsArgs: false`, so `/no-feads <prompt>` activates the guard and forwards `<prompt>` to the model as a normal user message instead of swallowing it.

## Runtime-presence diagnostics

Run `/feads-status` in an interactive phi session. It makes no network request and displays only these safe categories:

- whether a token is configured;
- the credential source (`canonical`, `legacy`, `file (phi.env)`, or `none`), with migration guidance for `legacy`;
- the effective Feads host, without credentials, paths, query strings, or fragments;
- whether presence is enabled and, when disabled, a bounded reason such as `token not configured`, `PI_NO_FEADS=1`, or `/no-feads`;
- whether the publisher has started;
- the last successful accepted row count and timestamp;
- the last failure category: `400`, `401`, `403`, `404`, `409`, `429`, `timeout`, `network`, or `other`, its HTTP status code when there was a response, and the consecutive-failure count.

### Warnings

Outside nested subagents, and only while Feads is enabled (no `PI_NO_FEADS=1` or `/no-feads`), the extension warns through `ctx.ui.notify(..., "warning")`: in the TUI as a notification, under `--mode rpc` as an `extension_ui_request` with `method: "notify"` (P3 Code), and in print/JSON modes on stderr.

- At `session_start`, once per process: no token resolved while the effective MCP config (user `mcp.json` plus the trusted project overlay) has an enabled server named `feads` or whose URL host contains `feads.`.
- Heartbeat failures, once per failure category per process: immediately on a `400`, `401`, `403`, `404`, or `409` response; after three consecutive failures for timeouts, network errors, `429`, and `5xx`. Success and recovery are silent.

The publisher reports through `setFeadsPresenceAlertListener`, which the extension registers per session; it never touches UI itself.

The command never displays or logs token values, request bodies, task or prompt text, local paths, or raw server error bodies. A status showing `configured token: yes` proves only that the process has a non-empty environment value or a literal `phi.env` token; a `401` or `403` still requires a valid, non-revoked token with the expected per-user attribution. After changing the token, restart phi before checking the status again.

## MCP configuration

The Feads HTTP server must use the per-process token rather than a literal bearer. In `mcp.json`, migrate the Feads server headers to:

```json
{
  "Authorization": "Bearer ${FEADS_AGENT_TOKEN}"
}
```

The mcp-bridge resolves `${...}` from each process environment. Consequently, a child authenticates with the token present in its process environment. Do not commit the token or put it in an agent definition.

Without a configured `FEADS_AGENT_TOKEN` or legacy `FEADS_TOKEN` (in the environment or `phi.env`), this extension makes no runtime-presence requests. The legacy fallback is scoped to presence; delegation and flares still require `FEADS_AGENT_TOKEN`. Feads failures never block agent work; flares are advisory and their absence is safe.
