# Workflow plugin — reference and design guide

`plugins/workflow/` adds a dynamic-workflow engine to OpenCode V2. One script
orchestrates several subagent sessions, the run is drawn as a phase graph, and
the artifacts a subagent produced are published for the user.

It is a port of the ideas in ZCode's `dynamic-workflows` skill (the `/workflow`
command, a typed facade over subagent sessions, phases as graph nodes,
`report()` salvage, artifact cards, amend-from-cache), rebuilt against the
OpenCode V2 plugin API and without private harness hooks.

- [1. Why it exists](#1-why-it-exists)
- [2. Concepts](#2-concepts)
- [3. Quick start](#3-quick-start)
- [4. Script contract](#4-script-contract)
- [5. Facade reference](#5-facade-reference)
- [6. Authoring guide](#6-authoring-guide)
- [7. Tools](#7-tools)
- [8. Saved workflows](#8-saved-workflows)
- [9. Runtime and architecture](#9-runtime-and-architecture)
- [10. RPC API](#10-rpc-api)
- [11. TUI](#11-tui)
- [12. Caps and constants](#12-caps-and-constants)
- [13. Permissions and security](#13-permissions-and-security)
- [14. Failure modes and recovery](#14-failure-modes-and-recovery)
- [15. Limits and roadmap](#15-limits-and-roadmap)
- [16. Development](#16-development)

---

## 1. Why it exists

A plain subagent call is one conversation with one brief. A workflow is the
next step up: a script decides who works, in what order, what each one is
asked, which checks decide the result, and what the user keeps.

The distinction matters:

| Request | Right tool |
| --- | --- |
| One thing delegated to one agent | `subagent` |
| A few independent lookups | `subagent`, in parallel |
| Anything the user did not name a workflow for | `subagent`, or do it yourself |
| "Use a workflow" / `/workflow` | this plugin |

The plugin enforces that boundary softly: the `workflow` skill says only an
explicit request starts a run, and `workflow_create` refuses without a second
`confirm: true` call so the user sees the plan first.

## 2. Concepts

| Term | Meaning |
| --- | --- |
| **Run** | One execution of one script, identified by `wfr-xxxxxxxx`. |
| **Script** | A JavaScript function body (TypeScript accepted) that the engine calls with the facade. |
| **Phase** | A named node on the run graph. `phase("…")` starts one. |
| **Subagent** | A separate OpenCode session created by `agent()`. Named agents keep context across asks. |
| **Ask** | One prompt to a subagent, awaited for its reply. |
| **Report** | `report(item, id?)` records a value. Items survive a failed run and feed preset artifacts. |
| **Artifact** | What the user keeps: markdown, file, chart, table, metrics, board. |
| **Journal** | The per-run record of asks and their replies, used by amend. |
| **Amend** | Supersede a run with a revised script, replaying unchanged asks from the journal. |

A run is *not* a chat session. It is a background job that owns zero or more
subagent sessions.

## 3. Quick start

### From the command line

```
/workflow review the changed files and confirm every finding
```

The command attaches the `workflow` skill to the model turn and instructs the
agent to plan, show the graph, and run.

### From a model turn

The agent is expected to follow this sequence:

1. **`workflow_plan`** — compile only. Returns the phase list, the command set
   (`world.run` literals) and any diagnostics. Nothing starts.
2. **`workflow_create` without `confirm`** — the confirmation gate. Returns the
   same plan plus "nothing has started".
3. **`workflow_create` with `confirm: true`** — starts the run. By default it
   returns immediately with a run id.
4. **`workflow_wait`** — block until the run settles and return the report.
   **`workflow_get`** — snapshot at any time. **`workflow_list`** — index.
5. **`workflow_amend`** — revise a run that errored, stopped or finished
   without paying again for the asks that did not change.
6. **`workflow_stop`** — interrupt the run and its subagents.

### A minimal script

```js
phase("Say hello")
const reply = await agent("greeter").ask("Reply with exactly: hello")
artifact.markdown("report", `# ${reply}`, { primary: true })
return { conclusion: reply, findings: [], verified: [], notCovered: [] }
```

## 4. Script contract

### Language

- JavaScript, ES2022, executed as a function body.
- TypeScript is accepted when the host runtime provides Bun's transpiler. Type
  annotations are stripped; there is no type check, only a syntax check.
- Top-level `await` and a final `return <value>` are allowed.
- `interface`/`type` declarations are erased with the rest of the types.

The engine wraps the script as:

```js
"use strict"
const { agent, phase, world, files, git, report, artifact,
        channel, future, log, args, run, model, sleep, hole } = __wf
return (async () => {
  // your script
})()
```

TypeScript input is transpiled inside a named async function and then called,
because a transpiler treats top-level `return` as a module error.

### Rejected constructs

`compileScript()` rejects these before anything runs:

| Construct | Reason |
| --- | --- |
| `import` / `export` | A script is a body, not a module; its output is the final `return`. |
| `require(...)` | No module system. |
| `process.*` | Use `world.run` for commands. |
| `fetch(...)` | Use `world.run` for network commands. |
| `Date.now()`, `Math.random()` | Run results must replay; time and randomness come from outside. |
| `world.run(<non-literal>, …)` | The user approves the command set before the run, so command names must be literals. |

Runtime values belong in the args array:

```js
world.run("git", ["diff", base, "--", path])   // good
world.run(`git diff ${path}`)                    // rejected
```

### Confirmation gate

`workflow_create` with no `confirm` compiles and returns the plan but starts
nothing. A second call with `confirm: true` starts it. Diagnostics mean the
script did not compile; the plan returns the line and message, and no run
exists.

### Return value

The final `return` is the model-facing handoff. Keep it to the report shape:

```js
{
  conclusion: string,
  findings: Array<{
    where: string,
    what: string,
    evidence: string,
    status: "verified" | "unconfirmed",
    severity: "low" | "medium" | "high"
  }>,
  verified: string[],
  notCovered: string[]
}
```

Artifacts are the user-facing deliverable. Do not duplicate the report in both.

## 5. Facade reference

### `args`

Frozen object from `workflow_create`'s `args`. Always defined; values are
whatever the caller passed.

```js
const target = typeof args.target === "string" ? args.target : "src"
```

### `run`

```js
{ id: string, name: string, resumedFrom?: string }
```

Keep `id` out of ask text and personas: it changes per run, so quoting it makes
every ask cache-miss on amend.

### `log(message)`

Narration for the human watching the run. Appears in the run panel and the
snapshot (`logs`, last 200 lines). Use it after a fan-out is sized and at the
top of a loop round.

### `phase(name)`

Marks the start of a stage. Required for a useful graph.

- `name` is a non-empty literal. Two calls with the same name are one node, so
  a loop body stays one box.
- The first call after a different phase adds an edge from the previous node.
  A later visit adds a back-edge; the panel marks it `↺`.
- `visits` counts entries into that node.
- Calls run sequentially; do not call `phase()` inside a per-item fan-out
  callback, or the graph records concurrent interleavings.

### `model(id)`

Returns a frozen marker accepted as an agent's `model`:

```js
agent("judge", { model: model("anthropic/claude-sonnet-5-5") })
```

Only use a model the user named. The engine passes `provider/model` through to
`session.switchModel`; a bare model id is resolved against the session's model
list.

### `agent(name?, persona?)`

Returns `{ ask, askJSON }`.

- **Name** is an identity. A named agent keeps one session and its context
  across asks; asks queue FIFO. Names must be unique in the run — name per item
  (``agent(`reviewer-${path}`)``) or stay anonymous.
- **Persona** is a string prepended to the agent's first ask as
  `Role for this conversation: …`. It is not a real agent-system prompt; the
  pinned SDK has no per-session instructions API.
- Anonymous agents get `agent-1`, `agent-2`, … and are never reused.

#### `ask(text) → Promise<string>`

Creates the session on first use, prompts it, waits for the turn to settle, and
returns the last assistant text. Errors if the reply never arrives.

#### `askJSON(text, shape?) → Promise<object>`

Appends "Reply with only a JSON object, no prose, no markdown fences" plus an
optional shape hint, strips fences, parses the first balanced `{…}` or `[…]`,
and retries once before throwing. There is no model-level schema enforcement.

```js
const review = await agent(`reviewer-${path}`).askJSON(
  `Review ${path}. Report concrete defects.`,
  { findings: [{ where: "path:line", what: "…", severity: "low|medium|high" }] },
)
```

### `world.run(command, args?, opts?) → Promise<{ exitCode, stdout, stderr }>`

Runs one process, once. The result is not journaled: an amended run executes its commands again.

- `command` must be a compile-time string literal and is shown in the plan.
- `args` is an array of strings; `cwd` is the workspace; no shell, so no pipes
  or redirection.
- A nonzero exit **resolves**; only spawn failure, timeout or the output cap
  rejects.
- `opts.timeoutMs` defaults to 300 000.
- `opts.output`:
  - `"full"` (default) — rejects over 16 MiB.
  - `"discard"` — returns `""`; use when only the exit code matters.
  - `{ tail: n }` — keeps the last `n` bytes, `n ≤ 16 MiB`.

```js
const check = await world.run("npm", ["test"], { output: { tail: 16_384 } })
if (check.exitCode !== 0) feedback = check.stderr
```

The exit code **is** the confirmation. Do not also ask a subagent to run the
same suite.

### `files`

Read-only workspace views. Caps reject rather than truncate.

| Call | Behaviour |
| --- | --- |
| `files.glob(pattern)` | Workspace-relative files matching a glob (`**`, `*`, `?`, `{a,b}`, classes). Skips `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `.cache`, `coverage`. Rejects over 2 000 matches. |
| `files.read(path)` | UTF-8 text, rejects over 2 MiB. |
| `files.grep(pattern, glob?)` | One entry per matching line; rejects over 2 000 matches or 256 KiB of matching text. Skips binaries. |

### `git`

Read-only; shells out to `git`, so a missing repository is a catchable
rejection.

| Call | Behaviour |
| --- | --- |
| `git.status()` | `{ branch?, clean, staged, unstaged, untracked }` |
| `git.changedFiles(base?)` | Without a base: staged + unstaged + untracked. With a base ref: tracked files that differ. |
| `git.diff(base?, path?)` | Unified diff, default `HEAD`, tail-capped at 512 KiB. |
| `git.log(count?)` | Newest first, default 20, max 100. |

```js
let paths
try { paths = await git.changedFiles("origin/main") }
catch { paths = await files.glob("src/**/*.ts") }
```

### `report(item, artifactId?)`

Records one value.

- Items are kept even when the run fails (up to 1 000, last 200 in a snapshot).
- `artifactId` feeds a declared preset artifact. A tag naming an undeclared id
  **fails the run**: the user approved the artifact set, so a typo is not
  silently ignored.
- Use it as each finding lands, not as one array at the end.

### `artifact`

| Call | Kind | Behaviour |
| --- | --- | --- |
| `artifact.markdown(id, content, opts?)` | markdown | Publishes text. 256 k character cap. Republishing mints a version. |
| `artifact.file(id, path, opts?)` | file | Publishes a workspace file; path must stay inside the workspace. Records path and size. |
| `artifact.chart(id, spec)` | chart | Declaration. Points come from `report(item, id)`. |
| `artifact.table(id, spec)` | table | Declaration. Rows come from `report(item, id)`. |
| `artifact.metrics(id, spec)` | metrics | Declaration. Latest value per field. |
| `artifact.board(id, spec)` | board | Declaration. Cards move by a status field. |

Common options: `{ title?, description?, primary? }`. At most one artifact is
`primary`; setting a new one clears the old. An id belongs to exactly one kind.
Caps: 32 ids per run; views show 100 table rows, 200 chart points, 50 cards.

Chart spec:

```js
artifact.chart("perf", {
  title: "Query latency by round",
  type: "line",                  // line | bar | scatter
  x: { field: "round", label: "Round" },
  y: [{ field: "ms", label: "ms" }],
  scale: "linear",               // linear | log
  baseline: { field: "target" },
})
```

Table spec: `{ columns: [{field,label?,unit?}], key? }`. With `key`, a row with
the same key replaces an earlier one.

Metrics spec: `{ metrics: [{field,label?,unit?}] }`.

Board spec: `{ key, status, columns, cardTitle?, detail? }`.

Field values support dot paths (`timing.after`) and settle the semantics of
each artifact:

- chart: one point per reported item.
- table: append, or replace by key.
- metrics: merge the listed fields into the latest record.
- board: upsert a card by key and place it by `status`.

### `channel(name?)` and `future(fn)`

`channel<T>()` is an unbounded FIFO async iterable: `send(item)`, `close()`,
and `for await`. `future(fn)` starts an async block immediately and returns its
promise.

```js
const facts = channel("facts")
const research = future(async () => {
  phase("Research each angle")
  try {
    await Promise.all(angles.map(async (angle) => {
      const found = await agent(`researcher-${angle}`).askJSON(`Research ${angle}.`, { facts: [] })
      for (const fact of found.facts) facts.send(fact)
    }))
  } finally {
    facts.close()          // the producer owns the close
  }
})
const verify = future(async () => {
  phase("Check each fact as it arrives")
  for await (const fact of facts) {
    await agent(`verifier-${fact.id}`).askJSON(`Does this hold? ${JSON.stringify(fact)}`, { holds: true })
  }
})
await Promise.all([research, verify])   // start every stage, then join once
```

A channel nobody can send to any more is not detected: the script waits until
the run is stopped. Close every channel you open.

### `sleep(ms)`

Abortable delay. Throws when the run is stopped.

### `hole(name, prompt?, body?)`

Reserved. This version throws a clear error: write the whole topology and use
`workflow_amend` when the findings change the plan. See
[Limits](#15-limits-and-roadmap).

## 6. Authoring guide

### Fresh agent per item, or one shared agent?

```js
// Independent: each judge sees only its item. Runs concurrently.
items.map((i) => agent(`judge-${i.id}`).ask(`Judge ${i.id}`))

// Calibrated: one context sees every item in sequence.
const judge = agent("judge", "You rank consistently across a whole batch.")
items.map((i) => judge.ask(`Judge ${i.id}`))
```

Sharing a context serialises asks (FIFO) and makes later answers consistent with
earlier ones. Hoisting `agent()` out of a loop for tidiness turns a fan-out into
a queue.

### Pipeline by default

Chain stages per item and join once at the end. A barrier is only for a step
that needs every item: ranking, deduplication, synthesis.

```js
const confirmed = (
  await Promise.all(
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
).flat()
```

### Loops

Bound every loop with a round cap and carry feedback forward. Reuse the two
agents across rounds; add one fresh reviewer at the end.

```js
let feedback = "none"
for (let round = 1; round <= 5; round++) {
  phase("Plan the fix")
  const plan = await planner.askJSON(`Plan the fix. Previous critique: ${feedback}`, { steps: [] })
  phase("Critique the plan")
  const review = await reviewer.askJSON(`What would break this plan? ${JSON.stringify(plan)}`, { approved: false, feedback: "" })
  if (review.approved) return { conclusion: "…", findings: [], verified: [], notCovered: [] }
  feedback = review.feedback
}
```

### Fresh eyes

- Give every draft a reader that has seen nothing else.
- Ask "what would break this?" — not "is this good?".
- Give the reader the same evidence the author had (tell it which files to read;
  tell it not to edit).
- One deliverable gets one mechanism: a plan gets a reviewer, findings a
  confirmer, prose a reader.

### Verify in proportion to cost

A finding the user will act on as fact is confirmed independently: a second
agent reproduces it from the evidence alone, or a `world.run` command decides
it. A finding that fails confirmation is kept and labelled `unconfirmed`.

Do not:
- confirm a finding a `world.run` already decided (the exit code is the
  confirmation),
- confirm work nobody acts on as fact (poems, brainstormed options),
- run the same suite in the hunter, the confirmer and the gate.

### Phases

- One short phrase in the user's language: "Review each changed file",
  "确认测试仍然通过".
- Never machinery words: "fan-out", "gate", "节点3".
- Every phase contains at least one `ask` or `world.run`.
- No `phase()` inside a per-item `map` callback.

### Artifacts

- Publish the deliverable: a file a subagent wrote (`artifact.file`), or the
  long form of the answer (`artifact.markdown`).
- Mark exactly one `{ primary: true }`.
- Add a chart/table/metrics/board only when there is state worth watching while
  the run goes, or a number the user will read.
- Do not duplicate: a CSV and a table of its rows is noise.

### Models

Only set `subagent_model` or `model(...)` when the user named a model. Never
move work to another provider on your own; if a cheaper model is clearly right,
ask first and treat their yes as the request.

## 7. Tools

All tools are registered location-wide. Every one takes JSON input and returns
a text result for the model.

### `workflow_plan`

Compile only.

| Input | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Run label |
| `script` | one of | Inline script |
| `path` | one of | Script file, relative to the workspace or absolute |

Returns phases, the command set, warnings and diagnostics.

### `workflow_create`

| Input | Default | Meaning |
| --- | --- | --- |
| `name` | — | Run label (saved workflows override it) |
| `script` / `path` / `saved` | — | Exactly one source |
| `args` | `{}` | Values for `args` |
| `max_concurrency` | `4` | Simultaneous subagents, 1–16 |
| `subagent_model` | session | `provider/model` for subagents |
| `background` | `true` | `false` waits for the result |
| `confirm` | `false` | Omit for the plan only |
| `notify_agent` | `false` | Queue a continuation prompt when the run settles |

Without `confirm` it starts nothing. With it, the run starts in the background
and the tool returns the run id, the graph and the command set.

### `workflow_get`

`{ run_id? }` — full snapshot. Without an id, the newest run started by this
session. Includes phases, edges, agents, artifacts, the last 200 items, logs,
args, result, error.

### `workflow_list`

`{ session_id? }` — one line per run: id, status, phases done/total, agents,
name.

### `workflow_wait`

`{ run_id, timeout_ms? }` — blocks until the run settles, then returns the
snapshot. Default 30 minutes, capped at 2 hours. A timeout returns the live
snapshot with a "still going" note.

### `workflow_stop`

`{ run_id }` — aborts the script, interrupts its subagent sessions, keeps
finished work. The run ends `stopped`.

### `workflow_amend`

| Input | Meaning |
| --- | --- |
| `run_id` | The run to supersede |
| `script` / `path` | The revised script |
| `max_concurrency?`, `subagent_model?` | Overrides |
| `background?` | `false` waits for the result |
| `confirm` | Required |

A live predecessor is stopped and superseded silently (no finish notification).
A new run starts with the predecessor's args and cache; asks whose name and
text are byte-identical replay at zero token cost. A completed, errored or
stopped run can also be amended.

### `workflow_save`

`{ name, description, scope: "project"|"global", when_to_use?, script?, path?, args? }`

Compiles before writing. Name pattern: letters, digits, dot, dash, underscore,
1–64 chars. Saving over an existing name replaces it.

### `workflow_list_saved`

No input. Lists project and global definitions with scope and description.

## 8. Saved workflows

A saved workflow is one file: a JSON metadata header, then the script body.

```js
/* workflow
{
  "name": "pr-review",
  "description": "Review the changes in a pull request",
  "whenToUse": "A PR needs a verified review",
  "args": { "pr": { "type": "string", "required": true } },
  "updatedAt": 1794241956628
}
*/
phase("See what changed")
const paths = await git.changedFiles(`origin/pr-${args.pr}`)
// …
```

| Scope | Path |
| --- | --- |
| `project` | `<workspace>/.opencode/workflows/<name>.wf.js` |
| `global` | `~/.config/opencode/workflows/<name>.wf.js` |

A project definition wins over a global one with the same name.

Run a saved workflow with:

```
workflow_create({ name: "PR review", saved: "pr-review", args: { pr: "123" }, confirm: true })
```

Argument declarations are metadata. `workflow_create` passes the provided
`args` through; defaults are not merged in this version.

## 9. Runtime and architecture

```
                 ┌──────────────────────────── server plugin (index.ts) ───────────────────────────┐
 /workflow ─────▶│ command → prompt + skill                                                          │
 workflow_* ────▶│ tools → compile → RunEngine ──▶ subagent sessions (ctx.session.create/prompt/wait)│
                 │            │                        │                                          │
                 │            ├── phases/graph          ├── OpenCode permission rules copied      │
                 │            ├── artifact store         └── model per session                    │
                 │            └── ask journal                                                        │
                 │            │                                                                     │
                 │            ├── ctx.storage: workflow/run/<id>, workflow/cache/<id>               │
                 │            └── RPC: updated / finished ──────────────┐                            │
                 └───────────────────────────────────────────────────────┼────────────────────────────┘
                                                                         ▼
                                                     TUI plugin (tui.tsx): panel, status dot,
                                                     palette commands, toasts, artifact cards
```

### A run, step by step

1. `workflow_create` resolves the script, compiles it, extracts phases and
   `world.run` literals, and returns the plan unless `confirm` is set.
2. With confirmation, `startRun` mints `wfr-xxxxxxxx`, builds the engine, and
   records an initial snapshot.
3. The engine executes the script. `phase()` updates the graph; `agent()`
   creates or reuses a session and awaits a reply; `world.run` spawns a process;
   `report()`/`artifact.*` fill the artifact store.
4. On every state change the manager emits an `updated` RPC event (throttled to
   250 ms) and persists the snapshot (throttled to 1.5 s).
5. When the script returns or throws, the run becomes `completed`, `errored` or
   `stopped`. The ask journal is persisted, the final snapshot is written, a
   `finished` event is emitted (unless superseded), and a synthetic message is
   posted to the starting session.
6. The run moves out of the live map into the in-memory history. `getRun`,
   `listRuns`, `wait` and `get` read it from there; a restart rehydrates it from
   storage.

### Subagent sessions

- Created with `ctx.session.create({ title, location })`.
- The SDK's create input has no `parentID`, so sessions are top-level and
  tracked in the run snapshot. They are not nested under the starting session.
- `switchModel` applies `subagent_model` when given.
- The starting session's permission rules are copied to each subagent session.
- `ask` records the assistant-message count, registers an idle waiter, prompts
  with `delivery: "queue"`, waits for the turn to settle, and returns the last
  assistant text after the baseline. A missing reply is retried briefly, then
  reported as an error.

### Journal and amend

- The cache key is `` `${agentName}\0${prompt}` ``. Prompts include the persona
  prefix on the first ask and the JSON instruction for `askJSON`.
- Values over 16 KiB, or beyond 400 entries, are not journaled: exact replay is
  worth more than a partial one.
- The journal is written to `workflow/cache/<runID>` when the run settles.
- `workflow_amend` loads the predecessor's journal and starts a new run. A hit
  returns the recorded text without creating or prompting a session. A changed
  name or prompt runs live.
- The engine also journals into the new run, so repeated amendments keep
  getting cheaper.
- A live predecessor is stopped first with `silent = true`: no `finished`
  event, no synthetic notice. The panel still sees it become `stopped`.

### Persistence

| Key | Value |
| --- | --- |
| `workflow/run/<id>` | Full `RunSnapshot` (script, phases, agents, artifacts, items, logs, result, error) |
| `workflow/cache/<id>` | `{ entries: [key, value][] }` |

Storage validates JSON strictly. Snapshots are round-tripped through
`JSON.stringify`/`parse` first, so keys with `undefined` values (optional
artifact metadata) are dropped rather than rejected.

On restart, any snapshot still marked `running` or `queued` is rehydrated as
`stopped` with `stoppedReason: "interrupted"`. Runs are never auto-resumed.

### Graph semantics

- Nodes are created by name on first `phase()`.
- An edge is added from the previously active node to the new one, once.
- Moving on marks the previous node `done`; the run's completion marks the last
  active node `done`; a failure marks it `error`.
- A node revisited by a loop keeps one entry and increments `visits`.
- The panel marks back-edges with `↺`.
- Edges are not rendered as text in tool results beyond "(from X)"; the panel
  and the snapshot carry the full edge list.

## 10. RPC API

Registered with `Rpc.define({ id: "workflow" })`.

Methods:

| Method | Input | Output |
| --- | --- | --- |
| `listRuns` | `{ sessionID? }` | `{ entries: RunSummary[] }` |
| `getRun` | `{ runID }` | `{ run: RunSnapshot }`, or `not_found` |
| `stopRun` | `{ runID }` | `{ stopped: boolean }`, or `not_found` |

Events:

| Event | Data | When |
| --- | --- | --- |
| `updated` | `RunSummary` | Any phase, agent, artifact or status change (throttled). |
| `finished` | `RunSummary` | Terminal `completed`, `errored` or `stopped`. Suppressed for a superseded predecessor. |

Event subscriptions are live-only, so the panel polls `listRuns` once on setup
and `getRun` for the selected run.

Over HTTP the RPC call is `POST /api/rpc/workflow/<method>` with
`{ "input": { … } }`. `run` in `getRun` is a permissive object because artifact
kinds differ; clients narrow by `kind`.

`RunSummary` fields: `id`, `name`, `status`, `sessionID`, `directory`,
`createdAt`, `updatedAt`, `endedAt?`, `phaseCount`, `phasesDone`, `agentCount`,
`artifactCount`, `error?`, `resumedFrom?`.

`RunSnapshot` adds: `phases`, `edges`, `currentPhase?`, `agents`, `artifacts`,
`items`, `logs`, `args`, `result?`, `maxConcurrency`, `subagentModel?`, `script`.

## 11. TUI

`tui.tsx` is the `./tui` part of the package.

### Session panel

Opened with the palette command **Open workflow run** (`workflow.panel`). The
panel shows the newest run for the session (or the one chosen with **Switch
workflow run**):

- header: status glyph, name, id, phase progress, agent count;
- phase graph: `✓` done, `▶` active, `·` pending, `✗` error, `×n` visits,
  `↺` loop target;
- subagents with ask counts and status;
- artifact cards:
  - markdown: first 14 lines;
  - file: path and size;
  - chart: a sparkline plus the latest value;
  - table: header plus the last eight rows;
  - metrics: field/value pairs;
  - board: columns with up to three cards each;
- the last ten log lines;
- the error message, when there is one.

### Status and notifications

- A prompt-footer dot shows `WF done/total` while a run is running or queued.
- A sidebar card shows the newest run's status.
- On `finished`, a toast reports completion, stop or failure, and failures also
  raise an attention notification.
- Repeats of the same terminal event are de-duplicated in TUI storage.

### Commands

| Command id | Palette title | Action |
| --- | --- | --- |
| `workflow.panel` | Open workflow run | Opens the panel |
| `workflow.list` | Switch workflow run | Picks a run from a select dialog |
| `workflow.stop` | Stop workflow run | Confirms, then calls `stopRun` |

`keymap.layer()` is registered inside the mounted `app` slot, never in
`setup()`, because it needs a Solid owner.

### Recovery

RPC subscriptions are live-only. `setup` calls `listRuns` once, and the panel
refreshes `getRun` when the selection changes or an `updated` event arrives for
the selected run.

## 12. Caps and constants

| Constant | Value | Where |
| --- | --- | --- |
| Default concurrency | 4 | `workflow_create` |
| Max concurrency | 16 | `workflow_create` |
| Ask timeout | 30 min | `engine.ts` |
| `world.run` default timeout | 5 min | `exec.ts` |
| Process output cap | 16 MiB | `exec.ts` |
| Glob matches | 2 000 | `fsx.ts` |
| Grep matches / text | 2 000 / 256 KiB | `fsx.ts` |
| File read | 2 MiB | `fsx.ts` |
| Markdown artifact | 256 k characters | `artifacts.ts` |
| Artifacts per run | 32 | `artifacts.ts` |
| Table rows / chart points / cards in a view | 100 / 200 / 50 | `artifacts.ts` |
| Recorded items | 1 000 (last 200 in a snapshot) | `engine.ts` |
| Log lines | 200 | `engine.ts` |
| Cache entries / value | 400 / 16 KiB | `index.ts` |
| Event throttle | 250 ms | `index.ts` |
| Persist throttle | 1.5 s | `index.ts` |
| `workflow_wait` default / max | 30 min / 2 h | `index.ts` |

## 13. Permissions and security

- Every tool declares `options.permission` with its own name
  (`workflow_create`, `workflow_amend`, …), so per-agent permission rules can
  deny it the same way they deny a built-in tool.
- `workflow_create` and `workflow_amend` refuse in sessions the plugin created:
  a subagent cannot start or amend a workflow.
- Subagent sessions copy the starting session's permission rules at creation
  time.
- `world.run` accepts only a literal command, never a shell, so approval covers
  the exact command set returned in the plan.
- **Scripts are not sandboxed.** They run in the OpenCode server process via
  `new Function` with the facade injected. They are model-authored and
  user-approved, but a malicious or mistaken script can reach globals. Treat
  them like any other code the agent runs.

## 14. Failure modes and recovery

| Symptom | Cause | Fix |
| --- | --- | --- |
| `workflow_create` returns the plan and nothing runs | `confirm` omitted | Call again with `confirm: true` |
| Diagnostics and no run | Syntax error, forbidden construct, non-literal `world.run`, unsupported syntax | Fix the reported line and resubmit |
| Run `errored` immediately | Script threw, artifact id undeclared, `world.run` spawn failure, missing file | Read `error.message`, edit, `workflow_amend` |
| Run `stopped` with `interrupted` | The server restarted while it was running | `workflow_amend` with the same script to re-run; cached asks replay |
| Subagent reply never arrives | Provider error, session error, very slow turn | `workflow_get` shows the run; `workflow_stop`, then amend |
| Panel empty after a restart | TUI never subscribed to the old run | It polls `listRuns` on setup; open the panel |
| `Path "…" is outside the workspace` | `artifact.file` or `files.read` escaped the workspace | Publish a workspace-relative path |
| Amend re-runs everything | Agent names or ask text changed | Keep names stable and prompts byte-identical |
| Channel never finishes | Nobody called `close()` | Close in a `finally` |

Provider rate limits are **not** a reason to lower concurrency or add retry
loops; the runtime adapts. Concurrency exists to bound cost and load when the
user asks.

## 15. Limits and roadmap

Known gaps against the ZCode feature:

1. **No `hole()`.** Mid-run script growth is not implemented; amend replaces
   it. A fill would need a parked branch, a `workflow_fill` tool and a
   recompilation of the effective script.
2. **No model-level schema enforcement.** `askJSON` parses and retries.
3. **No sandbox.** See section 13.
4. **Only asks are journaled.** An amended run replays subagent replies but
   re-executes `world.run` commands and re-reads files, so a step that depends
   on changing filesystem state can differ from the predecessor.
5. **Subagent sessions are top-level**, because `session.create` has no
   `parentID` in the pinned SDK.
6. **No TUI interleaving into the timeline.** Runs appear in a panel and as
   synthetic messages, not as first-class timeline cards.
7. **TUI visuals are text.** A Desktop GUI part (`./gui-experimental`) with a
   Solid panel, an SVG graph and real charts is the natural next step.
8. **Saved workflow args do not merge defaults.**

## 16. Development

```sh
cd ~/Documents/Projects/opencode-plugins
bun install
bun test plugins/workflow      # 30 tests
bun run typecheck              # tsc --noEmit, whole repo
```

Layout:

| File | Responsibility |
| --- | --- |
| `index.ts` | Server setup, tools, command, skill, run manager, persistence, events |
| `rpc.ts` | Shared contract |
| `engine.ts` | Facade, semaphore, agents, cache, phases, snapshots |
| `compile.ts` | Transpile, preflight, phase/command extraction |
| `artifacts.ts` | Artifact store and views |
| `exec.ts` | Bounded process execution |
| `fsx.ts` | Glob/read/grep/git |
| `store.ts` | Saved workflows, storage keys |
| `tui.tsx` | Panel, status dot, commands, toasts |
| `types.ts` | Shared types |
| `SKILL.md` | Authoring contract the model loads |

Testing style:

- Pure helpers live at module scope and are exported (`internals` in
  `index.ts`, plain exports elsewhere).
- Engine tests drive a fake `SubagentBackend`, so no model calls.
- Store tests use a temp directory, never the home directory.
- TUI helpers are tested without mounting Solid.

Installing locally:

```sh
ln -s "$PWD/plugins/workflow" ~/.config/opencode/plugins/workflow
# or copy, as the other plugins do
cp -r plugins/workflow ~/.config/opencode/plugins/workflow
```

Restart the service (`opencode service restart`) for the server half, and the
TUI for the panel and commands.
