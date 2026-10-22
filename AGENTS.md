# AGENTS.md

Instructions for agents working in this repo.

## Commands

- `bun install` — install dependencies (bun 1.x).
- `bun test` — run unit tests. Test files sit next to sources
  (`plugins/goal/*.test.ts`).
- `bun run typecheck` — must pass before every commit (`tsc --noEmit`).
- Run long commands with a timeout (`timeout 120 ...`).

## Layout

- `plugins/<name>/index.ts` — server plugin (`Plugin.define` from
  `@opencode/plugin`).
- `plugins/<name>/rpc.ts` — shared RPC contract (`Rpc.define` from
  `@opencode/plugin/rpc`, imported with a `.js` suffix).
- `plugins/<name>/tui.tsx` — CLI plugin (`Plugin.define` from
  `@opencode/plugin/tui`).
- `agents/` — agent profiles referenced by plugins via `switchAgent`.

## Conventions

- Pure, testable helpers go at module scope and are exposed through the
  `internals` export; cover them with `bun:test`.
- Plugin settings resolve in one order: `ctx.options`, then environment
  variables, then an optional JSON config file at
  `~/.config/opencode/<name>.json` (`notify` does this; keep new plugins
  consistent).
- Runtime state (maps, timers, registrations) lives in `setup()` closures.
- Durable state goes in `ctx.storage` under a `"<name>/"` prefix with a
  type guard for rehydration; transient execution state (`busy`,
  `verifying`, timers, child links) stays in memory and resets on restart.
- Persist on every mutation; never let a failed persist/reload/emit break
  bookkeeping (log and continue).
- TUI: never call `keymap.layer()` in `setup()` — it throws
  (Keymap.Provider missing). Register layers inside mounted
  slot/route components only.
- TUI JSX uses `@opentui/solid` intrinsics (`box`, `text`); the tsconfig
  `jsxImportSource` is already set — do not change it to `solid-js`.
- RPC event data must be plain JSON objects; subscriptions are live-only,
  so provide a polling method (e.g. `listGoals`) as the recovery path.

## SDK notes

- Pinned to `@opencode/plugin` ^2.0.26. Verify API shapes in
  `node_modules/@opencode/plugin/dist/` — do not trust memory.
- Known gap: the SDK has no `ctx.permission.rules`; use
  `ctx.session.update({ sessionID, permissions })` for session-scoped rules.
- `ctx.model.default()` is async and returns `{ data: ModelInfo | null }`.
- `SessionDomain` includes `compact`/`remove` as of 2.0.26.

## Docs

- Fetch https://opencode.ai/v2/docs/build/plugins (and `/cli`, `/rpc`
  subpages) before answering API questions. Never use V1 docs for V2 work.
