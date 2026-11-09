# workflow — multi-subagent workflow engine

One script orchestrates several subagent sessions. The run is drawn as a phase
graph, reports as it goes, and publishes artifact cards the user keeps.

Modelled on ZCode's `dynamic-workflows` skill, rebuilt against OpenCode V2's
plugin API (server + TUI + RPC). The run is drawn as a layered canvas in the
fullscreen panel and as a compact spine in the side panel.

Full reference — concepts, facade, tools, RPC, TUI, caps, security, recovery:
[`docs/workflow-plugin.md`](../../docs/workflow-plugin.md).

## Usage

```
/workflow review the changed files and confirm every finding
```

Then, from the agent:

1. `workflow_plan` — compile only; returns phases, the command set and
   diagnostics. Nothing runs.
2. `workflow_create` without `confirm` — the same plan, as the confirmation
   gate.
3. `workflow_create` with `confirm: true` — starts in the background and returns
   a run id.
4. `workflow_wait` — block for the report; `workflow_get` — snapshot;
   `workflow_list` — index.
5. `workflow_amend` — supersede a run with a revised script, reusing cached
   asks.
6. `workflow_stop` — interrupt the run.

Saved definitions: `workflow_save` / `workflow_list_saved`. Project files live
in `.opencode/workflows/<name>.wf.js`, global ones in
`~/.config/opencode/workflows/<name>.wf.js`.

## Visuals

- **Fullscreen panel** (`f`; the host forces fullscreen on narrow panes):
  layered left-to-right graph. Nodes are rounded
  boxes coloured by status; edges are routed as orthogonal lines with `▶`
  arrowheads; loop edges run below the graph and enter from the bottom with
  `▲`. The inspector below shows the selected node's agents, artifacts and log.
- **Side panel**: a vertical spine with phase detail, the active phase's agents
  and artifact cards.
- **Prompt footer**: a one-line chain while a run is live, e.g.
  `WF ✓ Plan ─ ✓ Review ─ ▶ Verify`.
- **Sidebar**: the newest run and its first four phases; click to open.
- **Artifacts**: `o` opens a scrollable viewer for the selected or primary
  artifact (markdown text, table rows, chart points, metrics, board).
- **Keys** (only while the panel is focused): `j`/`k` move, `o` open artifact,
  `f` fullscreen, `x` stop (with confirmation).

The graph is computed by `graph.ts` from phases, edges, timings and per-phase
counts. The same renderer draws the plain-text graph in `workflow_get` results,
so the transcript and the TUI agree.

## Script contract

A script is a JavaScript function body (TypeScript is accepted when the host
provides Bun's transpiler). Top-level `await` and a final `return` are allowed.
`import`, `export`, `require`, `process`, `fetch`, `Date.now()` and
`Math.random()` are rejected.

```js
phase("Review each changed file")
const paths = await git.changedFiles("origin/main")

const confirmed = await Promise.all(
  paths.map(async (path) => {
    const review = await agent(`reviewer-${path}`).askJSON(`Review ${path}.`, { findings: [] })
    return Promise.all(
      review.findings.map((finding, index) =>
        agent(`confirmer-${path}-${index}`).askJSON(
          `Reproduce this finding from its evidence: ${JSON.stringify(finding)}`,
          { holds: true },
        ),
      ),
    )
  }),
)

artifact.markdown("report", "# Review\n\n…", { primary: true })
return { conclusion: "…", findings: [], verified: [], notCovered: [] }
```

Full facade: `args`, `run`, `log`, `phase`, `agent(name, persona)` with
`ask` / `askJSON`, `world.run(cmd, argv, opts)`, `files.*`, `git.*`,
`report(item, id?)`, `artifact.*`, `channel`, `future`, `model`, `sleep`.

The `workflow` skill (`SKILL.md`) is the authoring contract the model loads; it
covers topology, phases, verification, artifacts and anti-patterns.

## Architecture

| File | Role |
| --- | --- |
| `index.ts` | Server: tools, `/workflow` command, skill registration, run manager, persistence, completion notices |
| `rpc.ts` | Shared contract: `listRuns`, `getRun`, `stopRun`, `updated` / `finished` events |
| `engine.ts` | Host-agnostic run engine: facade, semaphore, agent sessions, ask cache, phase graph |
| `compile.ts` | TypeScript transpile, syntax preflight, phase/command extraction |
| `artifacts.ts` | Chart/table/metrics/board store fed by `report()` |
| `exec.ts` | Bounded `world.run` process execution |
| `fsx.ts` | Glob, read, grep, git views |
| `graph.ts` | Framework-free layered layout, edge routing, text rasteriser |
| `store.ts` | Saved workflows and durable run keys |
| `tui.tsx` | Fullscreen canvas, side-panel spine, footer chain, sidebar card, artifact viewer, commands, toasts |

- Runs are journaled in `ctx.storage` under `workflow/run/<id>`; ask results
  under `workflow/cache/<id>`, so `workflow_amend` replays unchanged asks at
  zero token cost.
- A run that was live when the server exited is rehydrated as `stopped`
  (`interrupted`), never as still running.
- Subagent sessions are top-level sessions created by the plugin (the SDK's
  `session.create` accepts no `parentID`), tracked in the run snapshot. They
  inherit the root session's permission rules.
- Completion posts a synthetic message into the starting session, so the user
  sees the result without spending a model turn. `notify_agent: true` also
  queues one continuation prompt.

## Known limits

- `hole()` is not implemented: write the whole topology, then amend when the
  findings change the plan.
- `askJSON` validates by parsing and retrying once; there is no model-level
  schema enforcement.
- Scripts run in-process with the facade injected (`new Function`), not in a
  sandbox. They are model-authored and user-approved; treat them like any other
  code the agent runs.
- The TUI graph is drawn with box glyphs, not a GPU/SVG surface. A Desktop GUI
  client sharing `graph.ts` geometry is not implemented.

## Tests

`bun test plugins/workflow` covers compilation, artifact assembly, the run
engine (phases, concurrency, caching, failures, JSON asks), the graph layout
(routing, loops, CJK width, fallbacks), saved workflows, the snapshot renderer
and the TUI helpers.
