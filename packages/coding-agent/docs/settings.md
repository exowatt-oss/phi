# Settings Reference

This reference lists user-configurable settings, their types, defaults, and purposes. Project settings override agent-directory settings. Resource lists are combined. See [Configuration](configuration.md) for file locations and trust behavior.

Add `"$schema": "https://pi.dev/schemas/settings.schema.json"` to `settings.json` for editor validation and completion.

## Model and thinking

<a id="model-cycling"></a>

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatic | Startup AI provider. |
| `defaultModel` | string | Automatic | Startup model ID. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Startup thinking level. |
| `modelThinkingLevels` | object | None | Per-model startup thinking levels keyed by exact `provider/modelId`. |
| `serviceTier` | `"fast" \| "default" \| "flex" \| "ultrafast"` | `"default"` | Processing tier: `"fast"`, `"default"`, OpenAI-only `"flex"`, or `"ultrafast"` (sent verbatim; Amazon Bedrock UltraFast, e.g. GPT-6 Astra). Fast also enables Anthropic fast mode on supported first-party Opus models. See [Service tier](#service-tier). |
| `thinkingBudgets` | object | Built-in budgets | Token budgets for `minimal`, `low`, `medium`, and `high` thinking levels. |
| `enabledModels` | `string[]` | All available models | Model patterns used for startup selection and model cycling. Uses the same format as `--models`. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in the transcript. |
| `showCacheMissNotices` | boolean | `false` | Show notices for significant cache misses, successful cache warming, compaction usage, and provider recovery. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"streaming"` | Keep eligible provider prompt caches warm during active runs or, with `"idle"`, between runs. Global setting only. |

Cache warming runs only when the model declares a cache lifetime and Pi estimates at least $0.05 in avoided cache-miss cost. Refresh usage counts toward session totals but does not enter model context. `/session` shows the next decision; extensions can override it with `cache_warming_decision`. See [Prompt Cache Lifetimes](models.md#prompt-cache-lifetimes).

See [Choose a Model](models.md) for model selection and thinking controls.

### Service tier

Select **Service tier** in `/settings` to persist the default, or use `--service-tier` for one process. Fast mode has premium pricing; Flex is discounted but can have longer or variable latency. Providers report the tier actually used, and phi uses that response tier for local cost accounting when available.

Use `/fast on`, `/fast off`, or `/fast status` in interactive mode for a session-only choice, restored by `/resume` without changing the default for other sessions. Codex sessions map Phi's `fast` choice to `service_tier: "priority"` on both HTTP and WebSocket requests, as required by the ChatGPT Codex endpoint. GPT-6 Astra, GPT-6.1 Sol, GPT-6 Sol, and GPT-6 Luna support Fast where your account and workspace allow it; account refusals remain visible, and a response downgraded to `default` is recorded at standard speed and price. Local token-cost estimates use the 2× paid-credit rate; included subscription limits can be consumed at a different multiplier. See [OpenAI's Fast availability and billing](https://learn.chatgpt.com/docs/agent-configuration/speed).

Anthropic Fast is available on Claude Opus 5.5, Opus 5, and Opus 4.8 through the Claude API, subject to organization access. Fable, Sonnet, Haiku, and the cloud-provider Claude endpoints do not offer this mode. Phi retries an eligible Fast request at standard speed when capacity or organization access prevents Fast, and reports the fallback. See [Anthropic Fast mode](https://platform.claude.com/docs/en/build-with-claude/fast-mode).

## Interaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued steering messages are delivered. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued follow-up messages are delivered. |
| `externalEditor` | string | `$VISUAL`, `$EDITOR`, then platform default | Command opened by the external-editor keybinding. |
| `doubleEscapeAction` | `"tree" \| "fork" \| "none"` | `"tree"` | Action for double Escape with an empty editor. |
| `treeFilterMode` | `"default" \| "no-tools" \| "user-only" \| "labeled-only" \| "all"` | `"default"` | Initial filter used by `/tree`. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Fallback project-trust behavior. **Can only be set in agent-directory settings.** |

### /btw side questions

| Setting | Type | Default | Description |
|---|---|---|---|
| `btw.model` | string | current main model | Model for side queries. Any `provider/modelId[:thinking]` ref phi has auth for. Omit to use the current session model (Claude Code parity). |
| `btw.persist` | boolean | `true` | Append completed answers to the TUI transcript as non-context entries. Set `false` for fully ephemeral behaviour. |
| `btw.maxHistory` | number | `20` | Maximum Q&A pairs kept in the in-memory side thread. Oldest pairs are dropped when the cap is reached. Clamped to 1–100. |

```json
{
  "btw": {
    "model": "example/model",
    "persist": true,
    "maxHistory": 20
  }
}
```

See `docs/btw.md` for full `/btw` documentation.

## Tools

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` | Tools enabled at startup. Plain names replace the defaults; `+name` adds a tool and `-name` removes one. An empty array disables all built-in tools but not extension or SDK tools. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | How the `codemode` tool presents tools while it is active. `on`: declared tools get a note on calling them from scripts appended to their description, and `codemode` lists only tools that are not declared. `only`: `codemode` lists every tool scripts can call, and active built-in and extension tools are hidden from the model, so it reaches them through `codemode`. |
| `codemode.inlineBudget` | number | `3000` | Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations. Tools that do not fit are left out and found with `searchTools()`. `0` lists only namespaces. |

Available built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. `defaultTools` can also name `codemode` and `tool_search`, which built-in extensions register inactive, and other extension tools registered inactive.

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it. For example, this enables `codemode` next to the default tools:

```json
{
  "defaultTools": ["+codemode"]
}
```

This replaces `bash` with `powershell` and enables `grep`: `["-bash", "+powershell", "+grep"]`. Project settings apply on top of user settings: a project list with only `+name` and `-name` entries changes the user's selection, and a project list with a plain name replaces it. In one list, plain names form the selection, and `+name` and `-name` then apply in order.

`/reload` enables tools newly added to `defaultTools`. It does not disable tools removed from it or re-enable unchanged tools you turned off. `--tools` with plain names, `--no-tools`, and `--no-builtin-tools` override `defaultTools`, also on reload.

CLI tool options override this setting for one invocation. `--tools` with only `+name` and `-name` entries changes the resolved `defaultTools` selection instead, for example `pi --tools +codemode`. On `/reload`, these entries apply to the reloaded setting too, so a tool removed with `-name` stays removed. See [Command Line](cli.md#tools).

## Sessions and context

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionDir` | string | Agent session directory | Session storage directory. Relative paths resolve from the working directory. `PI_CODING_AGENT_SESSION_DIR` and `--session-dir` override this setting. |
| `sessionShareDestination` | `"auto" \| "gist" \| "radius"` | `"auto"` | Destination used by `/share`. `auto` uses Radius when authenticated and otherwise creates a GitHub gist. `gist` always uses a gist. `radius` requires Radius authentication and never falls back to a gist. |

### Compaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction. |
| `compaction.reserveTokens` | number | `16384` | Free context tokens below which automatic compaction starts; phi's hard line is `effectiveWindow - reserveTokens`. |
| `compaction.keepRecentTokens` | number | adaptive: max(`20000`, 10% of the effective window) | Recent tokens retained without summarization. |
| `compaction.softCeilingTokens` | number | `PI_COMPACTION_SOFT_CEILING_TOKENS`, else `300000` | Caps the context window used for compaction thresholds; `0` uses the raw model window. |
| `compaction.model` | string | session model | Summarization model as `provider/modelId[:thinkingLevel]`; when `PI_TUI_MODE=1` (unless `PI_CONTEXT_BUDGET=off`) and unset, Anthropic sessions default to `anthropic/claude-sonnet-5:low` and other providers to `example/model:low`. |
| `models.json` model `compaction.softCeilingTokens` | number | global `compaction.softCeilingTokens` | A model entry may set `compaction: { softCeilingTokens }`, which overrides the global `compaction.softCeilingTokens`. |
| `compaction.modelOverrides` | object | None | Per-model token settings keyed by exact `provider/modelId`. |

<a id="per-model-compaction-overrides"></a>

Compaction token values must be non-negative safe integers. Each value resolves independently from the matching model override, then the ordinary compaction setting, then the built-in default. Project and user objects merge before model lookup.

See [Compaction Reference](compaction.md) for trigger, summarization, and validation behavior.

### Branch summaries

| Setting | Type | Default | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when summarizing branch history. |
| `branchSummary.skipPrompt` | boolean | `false` | Skip the branch-summary prompt and default to no summary. |

## Terminal and display

| Setting | Type | Default | Description |
|---|---|---|---|
| `theme` | string | `"system"` | Built-in or custom theme name. `system` derives colors from the terminal theme. |
| `quietStartup` | boolean \| `"header"` | `false` | `true` hides the startup header and loaded-resource listing. `"header"` keeps the header (version and key hints) but hides the model scope line and loaded-resource listing. |
| `tuiMode` | `"regular" \| "fullscreen"` | `"fullscreen"` | Interactive terminal UI mode. Changes from `/settings` apply immediately; `--tui-mode` overrides this setting at startup (`--tui-mode regular` or `"tuiMode": "regular"` opts out of fullscreen). phi ≤ 0.83 wrote this as `uiMode`, which is still read as a fallback. |
| `fullscreenExitOutput` | `"transcript" \| "resume-hint"` | `"transcript"` | Output printed when fullscreen mode exits. |
| `fullscreenScrollbar` | `"auto" \| "always" \| "hidden"` | `"auto"` | Fullscreen transcript scrollbar behavior. |
| `fullscreenCopyOnSelect` | boolean | `true` | Copy selected text automatically in fullscreen mode. |
| `fullscreenWheelScrollLines` | `"auto"` \| number | `"auto"` | Lines per mouse-wheel event in fullscreen mode, from 1 to 100. `"auto"` moves one line per event in local macOS terminals, which already accelerate wheel and trackpad input; elsewhere, and over SSH, it speeds up fast wheel spins to at most 6 lines per event. Alt+wheel moves five times as far. |
| `editorPaddingX` | number | `0` | Horizontal editor padding from 0 to 3 cells. |
| `outputPad` | `0 \| 1` | `1` | Horizontal transcript padding for messages, tool output, `!` command output, and summary blocks. |
| `toolOutputLines` | number | `5` | Output lines shown per tool result while collapsed (0-200). `0` shows only the expand hint. `ctrl+o` always expands to the full output, and this never changes what the model receives. |
| `toolDisplay` | `"minimal" \| "compact" \| "full"` | `"minimal"` | How much of a tool call/result is shown while collapsed. `"minimal"`: intent line plus a one-line summary. `"compact"`: short previews (upstream pi behavior). `"full"`: same as `"compact"` but sessions start expanded. Errors and running calls always keep their output, and `ctrl+o` always expands. See [Tool Display](tool-display.md). |
| `autocompleteMaxVisible` | number | `5` | Visible autocomplete entries, from 3 to 20. |
| `showHardwareCursor` | boolean | `false` | Use the terminal cursor instead of Pi's drawn cursor. Pi still positions it for input methods. |
| `terminal.showImages` | boolean | `true` | Display inline images when supported. |
| `terminal.imageWidthCells` | number | `60` | Preferred inline image width in terminal cells. |
| `terminal.clearOnShrink` | boolean | `false` | Clear empty rows when rendered content shrinks. |
| `terminal.showTerminalProgress` | boolean | `false` | Show OSC 9;4 progress in the terminal tab. |
| `terminal.hyperlinks` | `boolean \| "auto"` | `"auto"` | Override OSC 8 hyperlink detection. |
| `terminal.images` | `"kitty" \| "iterm2" \| "auto" \| false` | `"auto"` | Override inline-image protocol detection. |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | Override true-color detection. |
| `images.autoResize` | boolean | `true` | Fit images to Claude's native resolution (2576px long edge, 4784 visual tokens) before sending; smaller images pass through untouched. Hard provider limits are enforced per request even when off. |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to models. |
| `markdown.codeBlockIndent` | string | `"  "` | Prefix used to indent rendered code blocks. |
| `markdown.mermaid` | `"off" \| "final" \| "streaming"` | `"streaming"` | Mermaid rendering mode. |

See [Themes](themes.md) and [Terminal Setup](terminal-setup.md) for format and platform details.

## Network and retries

| Setting | Type | Default | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Preferred transport for AI providers that support multiple transports. |
| `httpProxy` | string | None | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients. **Can only be set in agent-directory settings.** |
| `httpIdleTimeoutMs` | number | `300000` | HTTP header and body idle timeout in milliseconds. Set to `0` to disable. |
| `streamIdleTimeoutMs` | number | `420000` | Maximum observable raw model-stream inactivity before phi aborts the request and retries it as a transient network failure. Valid range: `0`–`2147483647`; `0` disables it. See [Stream idle timeout](#stream-idle-timeout). |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket connection timeout in milliseconds. Set to `0` to disable. |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry for transient failures. |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts. |
| `retry.baseDelayMs` | number | `2000` | Initial exponential-backoff delay in milliseconds. |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number | `0` | Provider-level retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay in milliseconds. Set to `0` to disable the limit. |

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are required. Provider retries can delay Pi from handling quota and usage-limit errors itself.

### Stream idle timeout

`streamIdleTimeoutMs` measures raw transport activity, not decoded model output or total request duration. Configure it for your own providers; the default is 420 seconds.

The guard is fail-safe: phi arms it only after a wrapped fetch is invoked or a WebSocket frame hook is installed for that call, rather than from the API id alone. This lets Anthropic `ping` events and OpenAI-compatible `: ping` comment frames reset the timer even when the parser discards them, while custom implementations that ignore the raw wrapper stay unguarded. A path whose SDK exposes only decoded items remains unguarded rather than risking a false abort during legitimate hidden keepalive traffic.

| Built-in API | Idle guard | Observed activity |
|---|---|---|
| `anthropic-messages` | Enabled | Raw fetch response-body bytes |
| `azure-openai-responses` | Enabled | Raw fetch response-body bytes |
| `mistral-conversations` | Enabled | Raw fetch response-body bytes |
| `openai-completions` | Enabled | Raw fetch response-body bytes |
| `openai-responses` | Enabled | Raw fetch response-body bytes |
| `pi-messages` | Enabled | Raw fetch response-body bytes |
| `openai-codex-responses` | Enabled | Raw fetch response-body bytes or raw WebSocket frames |
| `google-generative-ai` | Disabled | Pinned Google SDK exposes only decoded stream items |
| `google-vertex` | Disabled | Pinned Google SDK exposes only decoded stream items |
| `bedrock-converse-stream` | Disabled | Native AWS event-stream SDK exposes only modeled events |
| Custom/unrecognized API ids | Disabled | No declared raw-transport capability |
| Custom implementation under a built-in API id | Conditional | Arms only after that call invokes the wrapped fetch or installs the raw WebSocket frame hook |

The resulting `StreamIdleTimeoutError` names the provider, model, and idle duration and enters the normal retry budget. The same resolved setting applies to main turns, `/btw`, `ctx.llm.sideQuestion`, interactive, print, JSON, and RPC calls. The subagent stall watchdog's stream hard-kill threshold is `max(15m, 3× streamIdleTimeoutMs)`, so the 420-second stream guard fires before the default 21-minute subagent threshold.

### Refusal Fallback

A safety classifier can decline a request outright (Anthropic reports `stop_reason: "refusal"`). That failure is deterministic in the request, so the `retry` budget above cannot clear it — only a different model can. `refusalFallback` is the ladder phi walks when that happens: it drops the declined turn from the context it sends, switches to the next usable model in `chain`, and replays the turn.

| Setting | Type | Default | Description |
|---|---|---|---|
| `refusalFallback.enabled` | boolean | `true` | Escalate to the next model in `chain` when a safety classifier declines a turn |
| `refusalFallback.chain` | string[] | `[]` | Ordered `"provider/modelId"` rungs, best model first. Rungs that name an unknown model or a provider with no auth are skipped |
| `refusalFallback.sticky` | boolean | `true` | Stay on the model that answered for the rest of the session. `false` restores the head of the chain after each escalated turn |

Unlike Anthropic's server-side `fallbacks` beta (`PI_ANTHROPIC_FALLBACKS`), this is client-side: it crosses providers, and it works on OAuth (subscription) auth, which the beta does not cover. Both can be on — the server-side beta gets first refusal inside the stream, and this ladder catches whatever still comes back declined.

A model that is not in `chain` escalates into it at the head, so the ladder still works from a model you selected ad hoc.

`sticky` defaults to `true` because the content that was declined is still in the conversation, so returning to the head of the chain on the next turn spends a guaranteed refusal per turn. Set it to `false` when the decline was about one specific prompt and you want the preferred model back afterwards.

```json
{
  "refusalFallback": {
    "enabled": true,
    "chain": [
      "anthropic/claude-fable-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-4-5",
      "openai/gpt-5"
    ],
    "sticky": true
  }
}
```

Escalations are visible in the transcript (`Safety classifier declined (cyber) on anthropic/claude-opus-5 — escalating to …`) and recorded in the session as a model change. When every rung has declined, the error surfaces with the list of models that were tried. To exercise the ladder without a violative prompt, run with `PI_DEBUG_FORCE_REFUSAL=2`.

### Error Fallback

Provider-outage rerouting is off by default. Set `errorFallback.enabled: true` and
list your own configured `provider/model` entries in `errorFallback.chain` to
opt in. The `PI_ERROR_FALLBACK_CHAIN` env var supplies a session-only chain;
`off` disables it. A failed model is restored after the rerouted turn unless
`errorFallback.sticky` is true. In RPC mode, hosts should enable this only when
they can track model changes.

## Shell

| Setting | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string | Platform default | Custom shell executable path. Supports a leading `~`. |
| `shellCommandPrefix` | string | None | Prefix prepended to every shell command. |
| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation. |

See [Shell aliases](shell-aliases.md) for shell setup and [Pi Packages](packages.md) for package-manager behavior.

## Resources

Resource paths in user settings resolve from the agent directory. Paths in project settings resolve from the project `.pi` directory. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages` | array | `[]` | npm, git, or local Pi package sources. See [Pi Packages](packages.md). |
| `extensions` | `string[]` | `[]` | Extension files or directories. |
| `skills` | `string[]` | `[]` | Skill files or directories. |
| `prompts` | `string[]` | `[]` | Prompt-template files or directories. |
| `themes` | `string[]` | `[]` | Theme files or directories. |
| `enableSkillCommands` | boolean | `true` | Register skills as `/skill:name` commands. |

Resource arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact exclusion with `-path`. Pi loads resources listed in both user-level and project settings.

The built-in extensions are named `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search` in `extensions`. They load by default; `-builtin:mcp` disables one. A `+builtin:<name>` or `-builtin:<name>` entry in project settings overrides the user setting. `pi config` lists them under Built-in. `--no-extensions` disables them too, and `-e builtin:<name>` loads one explicitly.

## phi built-in extensions

These settings belong to extensions that ship inside the phi binary.

### Subagents

The `subagent` tool supervises each child process with a liveness watchdog and, on Linux, runs it in its own `systemd-run --user --scope` cgroup. Thresholds are minutes.

| Setting | Type | Default | Description |
|---|---|---|---|
| `subagents.watchdogEnabled` | boolean | `true` | `false` disables every watchdog and default-budget kill. |
| `subagents.stallSoftMinutes` | number | `5` | Parsed-event silence while waiting for model output before a run is flagged. |
| `subagents.stallHardMinutes` | number | `21` | Stream hard fuse; floored at `max(15, 3 × streamIdleTimeoutMs)`, soft-only when that guard is off. |
| `subagents.toolStallSoftMinutes` | number | `20` | Silence threshold while a tool execution is outstanding. |
| `subagents.toolStallHardMinutes` | number | `60` | Hard kill threshold while a tool execution is outstanding. |
| `subagents.maxRunMinutes` | number | `120` | Soft wall-clock budget per run: only idle children are killed. `0` disables. |
| `subagents.toolMaxMinutes` | number | `90` | Ceiling for one tool call inside a subagent, even while it streams output. `0` disables. |
| `subagents.maxHardRunMinutes` | number | `360` | Absolute ceiling for a run without an explicit `timeoutSeconds`. `0` disables. |
| `subagents.childIsolation` | `"auto" \| "off"` | `"auto"` | Run each child in its own cgroup when the host can. `PI_SUBAGENT_ISOLATION=off` disables it for a process tree. |
| `subagents.childMemoryMax` | string \| number | 30% of RAM, clamped to 2–16 GiB | `MemoryMax` for each child cgroup: bytes, `"8G"`, `"512M"`, or `"25%"`. `0`/`"off"` removes the ceiling. |
| `subagents.childCpuCores` | number \| `"off"` | `max(4, CPUs / 6)` | Whole CPUs per child cgroup; also exported as test-runner worker caps. |
| `subagents.models.default` | string | none | Model for tasks that name none and whose agent definition names none, e.g. `"example/model:max"`. `PHI_SUBAGENT_MODEL_DEFAULT` overrides it. |
| `subagents.models.allow` | string[] | none | Model patterns subagents may use (`provider/id`, `provider/id:level`, `provider/id:l1\|l2`, `*` globs). A call with any task outside the list is refused. `PHI_SUBAGENT_MODEL_ALLOW` (comma-separated) overrides it. Configure the models in settings.json or through PHI_SUBAGENT_MODEL_ALLOW. |
| `agentMail.enabled` | boolean | `true` | Join other local UI sessions and offer the `agent_list` / `agent_message` tools. |

### /loop

Defaults for bounded `/loop` runs; see [/loop](loop.md).

| Setting | Type | Default | Description |
|---|---|---|---|
| `loop.maxIterations` | number | `12` | Iteration cap, 1–100. |
| `loop.maxWallTimeMs` | number | `7200000` | Wall-time cap, up to 24 hours. |
| `loop.maxCostUsd` | number | unset | Spend cap in USD; unset means unlimited. |
| `loop.checkTimeoutMs` | number | `600000` | Timeout for each `--check` command. |
| `loop.maxCheckOutputBytes` | number | `65536` | Check output kept per iteration, 1 KiB–1 MiB. |
| `loop.evaluatorModel` | string | session default | Model that judges `--until` conditions. |
| `loop.evaluatorConfidence` | number | `0.85` | Confidence the evaluator needs to stop the loop, 0.5–1. |

### Workspace state

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionState.classifier` | `"llm" \| "heuristic"` | `"llm"` | How the end-of-run workspace state is classified: an isolated side-question call, or a local heuristic. |
| `sessionState.model` | string | `example/model` | Model for the `llm` classifier. |

Memory and the feads agent are configured through their own files and environment variables; see [Memory](memory.md), [feads agent](feads-agent.md), and [Environment Variables](environment-variables.md#phi-additions).

## Updates, telemetry, and warnings

| Setting | Type | Default | Description |
|---|---|---|---|
| `autoUpdate` | boolean | `false` | Install newer phi releases from a configured self-hosted update feed automatically, so `/upgrade` is not needed. Interactive sessions check at start and every 30 minutes (one session per machine runs the installer, under `~/.pi/agent/phi-auto-update.lock`); the footer then shows `phi <version> installed · restart phi to use it`. Requires a feed serving versions.json, per-release archives and phi-install.sh, plus local phi-version.json beside installed binaries; no public feed or installer ships here. Toggle it in `/settings` (also `/config`). |
| `collapseChangelog` | boolean | `false` | Show a condensed changelog after an update. |
| `enableInstallTelemetry` | boolean | `false` in phi (`true` upstream) | Enable anonymous install/update reporting and selected provider attribution headers. Does not control update checks. `PI_TELEMETRY=1` also opts in. |
| `enableAnalytics` | boolean | `false` | Opt in to analytics data sharing. Currently used only by the experimental first-run setup. |
| `warnings.anthropicExtraUsage` | boolean | `true` | Warn when Anthropic subscription authentication may use paid extra usage. |
