# workflow — multi-subagent workflow engine

One script orchestrates several subagent sessions. The run is drawn as a phase
graph, reports as it goes, and publishes artifact cards the user keeps.

Modelled on ZCode's `dynamic-workflows` skill, rebuilt against OpenCode V2's
plugin API (server + TUI + RPC).

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
| `store.ts` | Saved workflows and durable run keys |
| `tui.tsx` | Session panel (phase graph, agents, artifact cards, log), status dot, palette commands, toasts |

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
- The TUI graph is text (box glyphs); the artifact cards are text renderings.
  A Desktop GUI part (Solid + SVG) is the next step for richer visuals.

## Tests

`bun test plugins/workflow` covers compilation, artifact assembly, the run
engine (phases, concurrency, caching, failures, JSON asks), saved workflows and
the TUI render helpers.
