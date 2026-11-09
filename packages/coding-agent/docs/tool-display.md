# Tool Display

`toolDisplay` controls how much of a tool call and its result phi prints while the block is collapsed. It is display only: what the model receives is identical in every mode.

| Mode | Collapsed call | Collapsed result | Session starts |
|------|----------------|------------------|----------------|
| `minimal` (default on this fork) | one intent line | one muted summary line | collapsed |
| `compact` | upstream pi behavior: full command, content/diff previews | first/last `toolOutputLines` lines | collapsed |
| `full` | same as `compact` | same as `compact` | expanded |

`ctrl+o` expands and re-collapses in all three modes, so nothing is lost — it is deferred.

## Why the fork defaults to minimal

A single bash call with a heredoc used to render around 30 rows: the whole script body, five lines of output, a truncation notice, and a `Took 0.1s` row. In a long session the transcript is mostly payload you already know, and the parts you actually read — which tool ran, on what, whether it worked — scroll away. Minimal shows intent and outcome and keeps the payload one keystroke away. Upstream pi's rendering is still available as `compact`.

## What the modes look like

Bash, in `compact`:

```text
 $ python3 - <<'PY'
 import json,collections
 ms=json.load(open('/tmp/bedrock-cw-metrics.json'))['Metrics']
 ... (21 more lines of the script body)
 PY (timeout 20s)

 ... (63 earlier lines, ctrl+o to expand)
   global.anthropic.claude-opus-5
   us.anthropic.claude-fable-5

 Took 0.1s
```

The same call in `minimal`:

```text
 $ python3 - <<'PY' (+24 lines)
 ⎿ 63 lines · 0.1s (ctrl+o to expand)
```

Other tools, collapsed in `minimal`:

```text
 write ~/example/model/scripts/probe.ts (26 lines)
 edit ~/example/model/packages/coding-agent/src/core/tools/bash.ts (+12 -3)
 read ~/example/model/AGENTS.md
 grep /toolDisplay/ in packages/coding-agent/src
 ⎿ 8 matches (ctrl+o to expand)
 find *.test.ts in packages/coding-agent
 ⎿ 41 files (ctrl+o to expand)
 ls packages/coding-agent/docs
 ⎿ 44 entries (ctrl+o to expand)
```

`read` already collapsed to its title line before this setting existed; that is unchanged.

An MCP or extension tool that ships no renderer of its own falls back to a JSON-shape header. In `minimal` that header is the only line:

```text
 mcp_feads_issues_list
 ⎿ {issues[12], total, board} · 96 lines, ctrl+o to expand
```

In `compact` the same header is followed by `toolOutputLines` preview lines.

Summary lines pick the count that means something for the tool: bash and generic output count lines, grep counts matches, find counts files, `ls` counts entries. ` · truncated` is appended when the tool hit an output limit. A one-line status result (`No matches found`, `(empty directory)`) is shown verbatim instead of being counted.

## Configuring it

In a session, `/settings` → **Tool display** cycles `minimal` → `compact` → `full`. The change is saved to global settings and applied live — tool blocks already on screen re-render at the new density immediately, including switching to `full`, which expands them.

Or set it directly in `~/.pi/agent/settings.json`:

```json
{
  "toolDisplay": "compact"
}
```

That restores the pre-fork look. `toolDisplay` is also accepted in project settings (`.pi/settings.json`), like other UI settings; `/settings` always writes the global file.

## Interaction with `toolOutputLines`

`toolOutputLines` (default `5`) is unchanged and still means "output lines per collapsed tool result":

- in `compact` and `full`, it is the collapsed preview budget, as before;
- in `minimal`, successful results have no preview, so it only bounds the output tail kept for **errors**.

Set `toolOutputLines` if `compact` is still too loud but `minimal` is too quiet.

## Expanding

`ctrl+o` toggles full expansion of tool output for the session. It is the `app.tools.expand` keybinding, so it is rebindable in `~/.pi/agent/settings.json` like any other binding — see [Keybindings](keybindings.md). Every expand hint the summary lines print is generated from the binding, so a rebound key shows up in the hints too.

## What never changes

- **Errors keep their content.** A failed call renders its output tail and exit status in every mode, `minimal` included.
- **Running calls keep their content.** While a call is still streaming, `minimal` behaves like `compact` — bash output tail and the elapsed ticker stay visible. It collapses to the summary line once the call settles.
- **The model sees the same thing.** Tool results in the conversation are untouched; this setting only changes rows on your screen.
- **Thinking display is untouched.** Use `hideThinkingBlock` for that.
- **Your own `!` commands are untouched.** You typed them, so they render in full.

## For extension authors

Renderers receive the density and should honor it:

- `renderCall` reads `context.display`;
- `renderResult` reads `options.display`.

Both are `"minimal" | "compact"`. `"full"` never reaches a renderer — the host resolves it into `compact` plus an expanded session, so every renderer only needs a two-way branch. The conventional shape is: `display === "minimal" && !expanded && !isError` renders one muted summary line, everything else keeps the existing rendering.

A tool with no `renderResult` needs no changes at all: the built-in fallback already collapses to its shape header in `minimal`. A renderer that ignores `display` keeps working and simply stays at compact density. See [Extensions](extensions.md) for the renderer API.
