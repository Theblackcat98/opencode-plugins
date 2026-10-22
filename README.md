# opencode-plugins

OpenCode V2 plugins developed here. Each plugin lives under `plugins/<name>/`
with a server half (`index.ts`) and a CLI half (`tui.tsx`), plus a shared RPC
contract (`rpc.ts`) where the two halves need to talk. `opencode-go-usage` is
TUI-only and keeps an inert server half so the directory keeps the same shape.

## Plugins

### goal — autonomous goal mode (`plugins/goal/`)

Drives the agent autonomously until a verifiable objective is reached.

- `/goal <objective> [--check "<command>"] [--max <N>]` starts goal mode,
  `/goal status` reports state, `/goal stop` ends it.
- A watchdog verifies claims: a deterministic check command when `--check`
  is given, otherwise an LLM judge over the transcript.
- `goal_complete` / `goal_block` tools let the agent declare completion or
  report being blocked; the verifier arbitrates.
- Goal state survives restarts via `ctx.storage`; the contract ships as a
  system instruction on every model call so transcripts stay clean.
- Session-scoped permission rules deny dangerous shells and confine external
  directory access; subagent sessions share the policy but only the root
  session may settle the goal.
- The TUI half shows a sidebar card, prompt status dot, detail panel, and
  route, with toasts and notifications on verification.
- When the LLM judge returns no parseable verdict after a retry, the raw
  output is kept in plugin storage under `goal/debug/<sessionID>` and a
  truncated excerpt goes into the agent's next-action message instead of a
  bare retry loop.

`agents/goal-runner.md` is the agent profile goal sessions switch to.

### handoff — continue work in a fresh session (`plugins/handoff/`)

Backs the `/handoff` command. The running agent writes the summary itself, so no
extra summarization call is needed; the plugin only does what an agent cannot do
for itself: create a fresh root session in the location and seed it with the
summary as a synthetic, non-resuming message. The old session is never mutated.

- `handoff` tool exposes the summary to the agent; the server half creates and
  seeds the session, then announces it over RPC.
- The TUI half navigates into the new session, with `listPending` as the
  recovery path for a handoff this terminal was not attached for.
- Durable storage records the last handoff it moved to, so restarting the TUI
  never drags the user back into an old session.
- Registers no keymap layer on purpose: an optional feature must never be able
  to fail `setup()`.

### research — sourced web research (`plugins/research/`)

One research surface over four backends: **Tavily** (agent-shaped web search,
site mapping), **Exa** (neural/semantic search, find-similar-by-URL),
**Firecrawl** (scrape, crawl, structured extraction) and **Jina AI** (URL to
LLM-ready markdown, works without an API key). Full details in
`plugins/research/README.md`.

- Six tools under the `research` namespace: `search`, `find_similar`, `read`,
  `crawl`, `map` and `extract`.
- The point of the plugin is the routing block, a system instruction on every
  model call that tells the model which backend fits which job, and in what
  order to work. It is rebuilt from the backends that actually have
  credentials, so a route without a key is never advertised.
- `research_search` takes an `engine` parameter (`auto`, `neural`, `keyword`)
  so the model can deliberately ask for semantic search on conceptual or
  academic questions instead of always going to the keyword engine.
- Each tool falls back through its backends in order and names the one that
  answered. Jina is the last-resort reader, so `read` works with no
  credentials at all.
- `/research <question>` starts a sourced task: the question is durable, and a
  stricter contract (cite every claim, prefer primary sources, never guess)
  rides along as a system instruction and survives compaction.
- Web tools refuse private, loopback and metadata addresses by default, so the
  agent cannot be pointed at a cloud metadata service. The guard is hostname
  based; it stops accidents, not a determined SSRF.
- Server half only: nothing to render, nothing to share between processes.

### opencode-go-usage — Go quota in the sidebar (`plugins/opencode-go-usage/`)

Shows OpenCode Go usage in the session sidebar: percent used for the rolling
(5 hour), weekly, and monthly windows, matching the Console dashboard. The bar
is twenty flex segments, so it spans whatever width the sidebar gives it, and it
is coloured green/amber/red by usage band.

- Reads a Go credential from the `opencode-go` connection, or from the Console
  connection (`opencode`) when that is what the workspace has; a `/connect` Go
  API key works too. `OPENCODE_GO_API_KEY` overrides both.
- Prefers the Console status endpoint (the data the dashboard renders, and the
  only one that reports dollars), falling back to the zen usage endpoint, which
  is all a Go API key can read.
- Commands: `Show OpenCode Go usage` (detail dialog with dollars, reset times,
  plan, and which endpoint answered), `Refresh OpenCode Go usage`, and the
  `/go-usage` slash command.
- On a failed poll the last good reading stays visible, marked stale. Both
  endpoints are undocumented, so the file header documents their shapes and a
  public usage API is still an open upstream feature request (#16017, #31084).
- Pure helpers (`parseZenUsage`, `parseConsoleStatus`, `selectCredential`,
  `filledSegments`, `severity`, `detailText`) are exported for `bun test`.

## Install a plugin for local use

Copy the plugin directory into your OpenCode config (the reference layout is
`plugins/handoff`, the same shape as `~/.config/opencode/plugins/`):

```sh
cp -r plugins/goal ~/.config/opencode/plugins/goal
cp -r plugins/handoff ~/.config/opencode/plugins/handoff
cp -r plugins/research ~/.config/opencode/plugins/research
cp -r plugins/opencode-go-usage ~/.config/opencode/plugins/opencode-go-usage
```

Restart the OpenCode service (`opencode service restart`) so the server half
reloads. No package publishing step is needed for local use.

## Development

```sh
bun install          # install dependencies
bun test             # run unit tests (bun:test)
bun run typecheck    # tsc --noEmit
```

- SDK: `@opencode/plugin` ^2.0.26. Server API: `Plugin` from
  `@opencode/plugin`; CLI API: `Plugin`, `usePlugin` from
  `@opencode/plugin/tui`; RPC: `Rpc` from `@opencode/plugin/rpc`.
- Pure helpers live at module scope and are exported through `internals` for
  unit tests; setup closures hold runtime state.
- Full API reference: https://opencode.ai/v2/docs/build/plugins (plus
  `/build/plugins/cli` and `/build/plugins/rpc`).
