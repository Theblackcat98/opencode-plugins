---
name: workflow
description: "Use when writing, planning or revising a workflow script for the workflow_create tool: choosing subagent topology, fanning out over files or git, gating loops on world.run commands, typing results with askJSON, reporting verified findings, publishing artifacts, and amending a run. Only for explicit workflow requests."
when_to_use: "Only for workflow_create scripts. One delegation or a few independent lookups belong to the normal subagent tool instead."
---

# Writing workflows

A workflow is one script that orchestrates several subagent sessions. The
script is the plan: it decides who works, in what order, what each one is
asked, which checks decide the result, and what the user keeps.

A workflow exists to produce work a senior practitioner would hand over, not a
faster draft of one reply. Depth means enough subagents to cover the ground,
fresh eyes on every plan and draft, deterministic checks wherever a command
can decide, and a report that separates verified from suspected.

## When this applies

Only an explicit request starts a workflow: `/workflow`, or the user naming a
workflow as the means. Never start one because a task looks orchestration-
shaped — delegate with the subagent tool, or do the work yourself.

## The shape of a run

1. Read the request and the repository enough to know the stages.
2. Write the script.
3. Call `workflow_create` **without** `confirm`. It returns the compiled graph,
   the command set and any diagnostics. Fix diagnostics, rerun.
4. When the plan reads right, call `workflow_create` again with `confirm: true`.
5. `workflow_create` returns immediately. Use `workflow_wait` only when you
   need the result now; otherwise do other work and read `workflow_get`.
6. Present the returned report. Never re-run the whole workflow to fix one
   stage: edit the script and `workflow_amend` it.

## Script language

Plain JavaScript (TypeScript is accepted when the runtime can transpile it).
The body is wrapped in an async function: top-level `await` and a final
`return <value>` are allowed.

Not available: `import`, `export`, `require`, `process`, `fetch`, `Date.now()`,
`Math.random()`. A resumed run must replay the same values, so time and
randomness are injected from outside, not read inside.

The final `return` is the model-facing handoff. Artifacts are what the user
keeps. Never put the same content in both.

## Facade

```js
args                  // frozen object from workflow_create's args
run                   // { id, name, resumedFrom? }
log(message)          // narration for the human watching
phase(name)           // one node on the run graph
agent(name?, persona?)// a subagent session; ask() and askJSON()
world.run(cmd, argv?, { timeoutMs?, output? })  // { exitCode, stdout, stderr }
files.glob(pattern) / files.read(path) / files.grep(pattern, glob?)
git.status() / git.changedFiles(base?) / git.diff(base?, path?) / git.log(n?)
report(item, artifactId?)  // one item; also feeds a declared artifact
artifact.file|markdown|chart|table|metrics|board
channel(name?) / future(fn) / model(id) / sleep(ms)
```

`agent(name).ask(text)` returns the subagent's reply text.
`agent(name).askJSON(text, shape)` appends a JSON instruction, parses the reply,
retries once, and returns the value.

A named agent keeps its context across asks. A name is an identity: unique in
the run, and the key an amended run reuses cached work by. Name per item
(``agent(`reviewer-${path}`)``) for independent work; share one agent when later
answers must be consistent with earlier ones (asks on one agent queue FIFO).

## Phases

The user experiences the run through its phase graph. Every stage opens with
`phase("...")`:

- One short phrase in the user's language saying what the stage accomplishes
  for them: "Review each changed file", "确认测试仍然通过". Not "fan-out",
  not "node 3".
- A phase must contain at least one `ask` or `world.run`. Setup and the final
  `return` are not stages.
- Two markers with the same name are one node, so a loop body stays one box.
- No `phase()` inside a per-item fan-out callback. Put the marker at the top of
  the stage that contains the fan-out.

## Topology

Fresh agent per item, or one shared agent:

```js
// Independent, concurrent.
const reviews = await Promise.all(
  paths.map((path) => agent(`reviewer-${path}`).ask(`Review ${path}. Report concrete defects.`)),
)
```

Hoisting `agent()` out of the loop turns the fan-out into a queue. Do that only
when consistency matters more than parallelism.

Pipeline by default. Chain stages per item inside the fan-out and join once at
the end; use a barrier only where the next step needs every item (ranking,
deduplication, synthesis):

```js
const confirmed = await Promise.all(
  paths.map(async (path) => {
    const review = await agent(`reviewer-${path}`).askJSON(`Review ${path}.`, { findings: ["..."] })
    return Promise.all(
      review.findings.map((finding, index) =>
        agent(`confirmer-${path}-${index}`).askJSON(`Reproduce this finding from its evidence: ${JSON.stringify(finding)}`, { holds: true }),
      ),
    )
  }),
)
```

Bound every loop with a round cap, and carry the feedback forward. Reuse the
same two agents across rounds; add one fresh reviewer at the end.

`channel` + `future` are for a stage served by a pool of workers, a producer
still finding items while consumers work, or a feedback loop. Start every
stage, then join once with `Promise.all`. The producing stage closes the
channel in a `finally`.

## Deterministic checks

`world.run` is the gate. A nonzero exit code is a value, not an exception:

```js
const check = await world.run("npm", ["test"], { output: { tail: 16384 } })
if (check.exitCode !== 0) feedback = check.stderr
```

The command name must be a literal; interpolate runtime values into `argv`.
Before writing a gate, find what checks the repository already has
(`package.json`, `Makefile`, CI config, README). A unit suite decides less than
the acceptance command the request implies. Run the strongest check the
request implies at least once before the final `return`.

The exit code is the confirmation. Do not also ask a subagent to run the same
suite.

## Verify, report, deliver

Verify in proportion to what a wrong claim costs. A finding the user will act
on as fact gets an independent confirmation: a second agent that reproduces it
from the evidence alone, or a `world.run` command when one decides it. A
finding that fails confirmation is kept and labelled `unconfirmed`, never
dropped. Do not confirm what nobody will act on.

`report(item)` is delivered even when the run fails. Report each finding as it
lands, not in one array at the end.

Return this shape:

```js
interface Finding {
  where: string        // path, plus a line when it applies: "src/a.ts:42"
  what: string         // one sentence: what is wrong
  evidence: string     // the lines read, or the command and output that proved it
  status: "verified" | "unconfirmed"
  severity: "low" | "medium" | "high"
}
interface WorkflowReport {
  conclusion: string   // two or three sentences answering the request
  findings: Finding[]
  verified: string[]   // what the run actually checked, and how
  notCovered: string[] // what it did not look at, and why
}
```

Write all four in the user's language. `notCovered` is for what could not be
checked, never for a check that exists and was skipped because it is slow.

## Artifacts

`artifact.markdown`, `artifact.file`, `artifact.chart`, `artifact.table`,
`artifact.metrics`, `artifact.board`. Declare preset artifacts once at the top,
then tag reported items: `report(item, "perf")`.

- Every run publishes what the user asked for. A file a subagent wrote is
  published with `artifact.file`; an answer the run composed is published as
  markdown.
- One artifact is the deliverable: `{ primary: true }`.
- A chart, table, metrics row or board is for state worth watching while the
  run is going. Do not duplicate the same facts across cards.
- Ids are literals, one kind per id. Reusing an id mints a new version.

## Models

Only set `subagent_model` or `model("provider/id")` when the user asks for a
specific model, using the name they used. Never move work to another provider
on your own. If a cheaper model looks clearly right, ask first.

## Anti-patterns

| Written | Cost |
| --- | --- |
| One agent hoisted out of a fan-out for tidiness | The fan-out became a FIFO queue |
| One fixed name for every agent in a fan-out | Duplicate identities; run fails |
| A fresh agent every loop round | Round five re-learns round four, at full price |
| An unbounded `while` | The run never ends |
| Findings accumulated and returned at the end | One late failure loses all of them |
| A whole file interpolated into a prompt | Tokens spent on what the agent could read; pass the path |
| A subagent asked to run the tests and report pass/fail | A claim you cannot trust; use world.run |
| A gate written from habit, unit tests only | The decisive check never ran |
| `Date.now()`, `Math.random()`, `fetch`, `fs` | Not available; a replayable run cannot contain them |
| An `await` per item with no ordering need | Wall-clock serial for concurrent work |
| A stage that waits for everything although it handles one item at a time | Idle concurrency slots |
| A dashboard nobody watches, or a CSV and a table of its rows | Noise |
| Phases named after the machinery ("fan-out", "节点3") | A graph that says nothing |

## Tools

- `workflow_plan` — compile a script and show its phases and command set. No run.
- `workflow_create` — start a run. Without `confirm` it returns the plan only.
- `workflow_get` / `workflow_list` — snapshot / index.
- `workflow_wait` — block until a run settles and return its report.
- `workflow_stop` — stop a run.
- `workflow_amend` — supersede a run with a revised script, reusing cached asks.
- `workflow_save` / `workflow_list_saved` — keep a reusable definition.

`hole()` is not available: write the whole topology, and amend when the
findings change the plan.
