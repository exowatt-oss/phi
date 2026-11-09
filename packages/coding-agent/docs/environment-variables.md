# Environment Variables

Pi uses environment variables in three ways:

- Variables such as `PI_OFFLINE` configure the Pi process.
- Pi sets process markers so child processes can identify Pi as the launching agent.
- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Providers](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=pi` is a generic marker that lets tooling identify Pi as the agent that launched the process.
- `PI_CODING_AGENT=true` is Pi-specific and lets child processes detect that they run inside Pi.

Child processes inherit both markers. They are not session-specific and are not set automatically when Pi is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current Pi session state:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting Pi. `PI_PROVIDER` and `PI_MODEL` identify the selected Pi model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$PI_PROVIDER" "$PI_MODEL"
printf 'reasoning=%s session=%s\n' "$PI_REASONING_LEVEL" "$PI_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$PI_SESSION_FILE" ]; then
  tail -n 1 "$PI_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with Pi. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, Pi removes inherited values for these variables so nested Pi processes do not expose stale parent-session metadata.

## Pi Process Configuration

These variables are read by Pi itself:

| Variable | Description |
|----------|-------------|
| `PI_CODING_AGENT_DIR` | Override the config directory; default is `~/.pi/agent` |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `PI_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `PI_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `PI_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `PI_CODEMODE_MAX_WORKERS` | Maximum codemode workers alive at once across all sessions in the process; default `2`. Each worker's script may use up to 256 MB. Raise it when one process runs several sessions, such as in-process subagents. Further scripts wait for a free worker. See [Codemode](codemode.md) |
| `PI_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `PI_ANTHROPIC_FALLBACKS` | Server-side refusal fallback for first-party Anthropic API-key requests: `default` (recommended routing, the default), `off`, or a comma-separated chain of up to three model ids. On a safety-classifier decline the API retries the same request on the fallback model within the same stream and applies fallback credit automatically |
| `PI_REFUSAL_FALLBACK_CHAIN` | Override `refusalFallback.chain` for one run: a comma-separated list of `provider/modelId` rungs, or `off` to disable client-side refusal escalation. See [Settings](settings.md#refusal-fallback) |
| `PI_ERROR_FALLBACK_CHAIN` | Override `errorFallback.chain` for one run: a comma-separated list of `provider/modelId` rungs, or `off` to disable provider-outage rerouting. See [Settings](settings.md#error-fallback) |
| `PI_DEBUG_FORCE_REFUSAL` | Treat the next _n_ completed turns as safety-classifier declines, so the refusal ladder can be exercised without writing a violative prompt |
| `PI_MCP_OAUTH_BRIDGE_COMMAND` | Optional executable path/name for the per-session remote MCP OAuth bridge. Requests and responses use bounded protocol-v1 JSON over stdin/stdout; the value is never parsed as a shell command and authorization URLs are never passed as argv. |
| `PI_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `PI_RADIUS_GATEWAY` | Override the Radius gateway origin used by `/bug` uploads |
| `PI_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `PI_CLIPBOARD_OSC52` | Set to `1` to also send copied text to the terminal with OSC 52 after the local clipboard write, as Pi does over SSH. Use it when a remote client reaches Pi without SSH variables, such as a multiplexer attached from another machine or a remote IDE daemon |
| `PI_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `PI_PROGRAM_STATUS` | Override OSC 7501 program status detection: `1` always reports, `0` never reports; otherwise Pi reports only after the terminal confirms support. See [Terminal setup](terminal-setup.md#program-status) |
| `PI_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `PI_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `PI_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and provider-specific configuration are listed in [Providers](providers.md#use-an-api-key-from-the-environment).

### phi additions

phi reads the `PHI_*` spelling first and falls back to the `PI_*` one where both exist. Exowatt hardening turns several upstream phone-home features off by default; the variables below opt back in.

| Variable | Description |
|----------|-------------|
| `PHI_CODING_AGENT_DIR`, `PHI_CODING_AGENT_SESSION_DIR` | Same as the `PI_*` variables above; the `PHI_*` spelling wins when both are set |
| `PHI_ENABLE_VERSION_CHECK` | Opt in to the `pi.dev` latest-version check (off by default in phi). `PHI_SKIP_VERSION_CHECK` / `PI_SKIP_VERSION_CHECK` always disable it |
| `PHI_MODEL_CATALOG_URL` | Base URL of a remote model catalog overlay (unset by default: built-in catalog only) |
| `PHI_ENABLE_SHARE` | Allow `/share` to upload the session to a GitHub gist (off by default in phi) |
| `PHI_MCP_CONFIG` | Point phi's native MCP runtime at a different config file instead of `~/.pi/agent/mcp.json` |
| `PHI_MCP_BROWSER_AUTH` | Allow the local MCP browser OAuth flow when set to `1`/`true`/`yes` (set by desktop hosts that can present it) |
| `PHI_MCP_INSTRUCTIONS_WAIT_MS` | How long the first prompt waits for uncached MCP server instructions; default `3000`, `0` skips the wait |
| `PHI_MCP_AUTH_DIR` | Move the MCP OAuth token store to another directory |
| `PHI_MCP_AUTH_LOG` | Override the MCP OAuth event log location, or `off`/`0`/`false` to record nothing; read with `phi mcp events` |
| `PI_CONTEXT_BUDGET` | Context-aware compaction ladder (background summary, `context-budget` line, `checkpoint` tool, pinned constraints): `1`/`true`/`on`/`yes` enables it in any mode, `0`/`false`/`off` disables it; unset follows TUI mode. See [Compaction](compaction.md) |
| `PI_COMPACTION_SOFT_CEILING_TOKENS` | Host default for `compaction.softCeilingTokens` (below a model's `models.json` value and the setting); `0` uses the raw window |
| `PI_SUBAGENT_ISOLATION` | `off`/`0`/`false` spawns subagents without the systemd cgroup isolation for the whole process tree |
| `PI_SUBAGENT_WORKER_CAP` | Worker-count hint exported to isolated subagents (also fills `VITEST_MAX_*` and `PYTEST_XDIST_AUTO_NUM_WORKERS` when unset) |
| `PI_STALL_GUARD` | `off` disables the stall guard |
| `PI_NO_FEADS` | `1` disables the built-in feads agent integration for the session |
| `PHI_MEMORY` / `PI_MEMORY` | `0`/`false` disables the built-in memory extension (same as `--no-memory`); see [Memory](memory.md) |
| `PHI_HUB_URL` | Override the phi-hub deployment used by the built-in `hub` extension |
| `PHI_UPDATE_BASE_URL` | Override the downloads base URL used by the built-in updater |

### Remote MCP OAuth bridge

When `PI_MCP_OAUTH_BRIDGE_COMMAND` is set, each MCP manager/session creates its
own command-backed host integration. The executable receives one JSON request
for `prepare`, `open`, or `close` on stdin and must return one bounded JSON
response on stdout. It has no configured arguments and is not invoked through a
shell. The host may return only an exact `http://` loopback
`/oauth/callback` URI; phi keeps that URI unchanged for registration,
authorization, and token exchange.

The host receives the complete authorization URL only in the bounded `open`
payload. It controls callback reachability and workstation-browser
presentation; phi continues to own the callback listener, state/PKCE checks,
token exchange, token storage, and cross-process login lock. Host protocol and
command failures are redacted before they reach MCP diagnostics.

The protocol-v1 lifecycle uses a client-generated UUID `requestId`: `prepare`
includes it, `ready` echoes it and returns `leaseId`, `redirectUri`, and a
relative `expiresInMs` no greater than five minutes, and `close` includes the
request ID plus an optional valid lease ID and outcome. The wire contract never
uses an absolute expiry, avoiding clock-skew dependence. A malformed or failed
`ready` response receives a bounded best-effort `close` by request ID before phi
reports the validation error.

With no variable set, standalone phi uses its existing local browser flow. An
explicit `auth.browser: false` in `mcp.json` remains authoritative even when a
host is configured. A remote callback host is inside the SSH target's trust
boundary and can observe the phi process and its local MCP token store.
