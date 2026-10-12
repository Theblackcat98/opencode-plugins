# opencode-plugins

OpenCode V2 plugins developed here. Each plugin lives under `plugins/<name>/`
with a server half (`index.ts`), a shared RPC contract (`rpc.ts`), and a CLI
half (`tui.tsx`), following the handoff plugin layout.

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

`agents/goal-runner.md` is the agent profile goal sessions switch to.

## Install a plugin for local use

Copy the plugin directory into your OpenCode config (same layout as the
handoff reference in `~/.config/opencode/plugins/`):

```sh
cp -r plugins/goal ~/.config/opencode/plugins/goal
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
