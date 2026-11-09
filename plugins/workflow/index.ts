/**
 * Workflow plugin (OpenCode V2)
 *
 * A dynamic-workflow engine for OpenCode, modelled on the ZCode
 * `dynamic-workflows` skill: one script orchestrates several subagent sessions,
 * the run is drawn as a phase graph, findings are reported as they land, and
 * the artifacts a subagent produced are published for the user.
 *
 * Parts:
 *   index.ts  — server: script tools, /workflow command, skill, run manager
 *   rpc.ts    — shared contract with the TUI half
 *   tui.tsx   — CLI: run panel, phase graph, artifact cards, toasts
 *   SKILL.md  — the authoring contract the model loads
 *
 * The engine (engine.ts) is host-agnostic and unit tested with a fake backend.
 */

import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Plugin, Skill } from "@opencode/plugin"
import { buildScriptFunction, compileScript } from "./compile.js"
import { RunEngine, type AskCache, type SubagentBackend } from "./engine.js"
import { layoutGraph, renderGraph, type GraphPhase } from "./graph.js"
import { WorkflowRpc } from "./rpc.js"
import { loadSaved, listSaved, runStorageKey, saveSaved } from "./store.js"
import type { RunSnapshot, RunSummary } from "./types.js"

const SKILL_ID = "workflow"
const CACHE_PREFIX = "workflow/cache/"
const CACHE_ENTRY_LIMIT = 400
const CACHE_VALUE_LIMIT = 16 * 1024
const MAX_CONCURRENCY = 16
const DEFAULT_CONCURRENCY = 4
const WAIT_DEFAULT_MS = 30 * 60 * 1000
const EMIT_THROTTLE_MS = 250
const PERSIST_THROTTLE_MS = 1500

function skillContent(): string {
	try {
		return readFileSync(fileURLToPath(new URL("./SKILL.md", import.meta.url)), "utf8")
	} catch {
		// The skill is optional at runtime; tools still work, the model just
		// loses the authoring contract.
		return "Workflow scripts are JavaScript function bodies returning a value. See the workflow tool descriptions."
	}
}

function nowID(): string {
	return `wfr-${randomUUID().slice(0, 8)}`
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

/**
 * RPC output and plugin storage both validate JSON strictly: a key whose value
 * is `undefined` is not a JSON value, even though JSON.stringify would drop
 * it. Round-tripping here keeps snapshots inside the contract.
 */
function jsonSafe<T>(value: T): T {
	try {
		return JSON.parse(JSON.stringify(value)) as T
	} catch {
		return value
	}
}

function parseModelRef(raw: string): { providerID: string; id: string } | undefined {
	const trimmed = raw.trim()
	if (!trimmed) return undefined
	if (trimmed.includes("/")) {
		const [providerID, ...rest] = trimmed.split("/")
		const id = rest.join("/")
		return providerID && id ? { providerID, id } : undefined
	}
	return undefined
}

/** Defensive extraction across V2 session message shapes. */
function messageInfo(message: unknown): Record<string, unknown> {
	if (!message || typeof message !== "object") return {}
	const record = message as Record<string, unknown>
	const info = record.info
	return info && typeof info === "object" ? (info as Record<string, unknown>) : record
}

function messageText(message: unknown): string {
	const info = messageInfo(message)
	if (info.role !== undefined && info.role !== "assistant" && info.type !== "assistant") return ""
	if (typeof info.text === "string") return info.text
	const parts = (info.parts ?? (message as Record<string, unknown>)?.parts) as unknown
	if (!Array.isArray(parts)) return ""
	return parts
		.map((part) => {
			const record = part as Record<string, unknown> | null
			return record && typeof record === "object" && typeof record.text === "string" ? record.text : ""
		})
		.filter(Boolean)
		.join("\n")
}

function lastAssistant(messages: readonly unknown[], from = 0): string | undefined {
	for (let index = messages.length - 1; index >= from; index--) {
		const text = messageText(messages[index]).trim()
		if (text) return text
	}
	return undefined
}

function assistantCount(messages: readonly unknown[]): number {
	let count = 0
	for (const message of messages) {
		const info = messageInfo(message)
		if (info.role === "assistant" || info.type === "assistant") count++
	}
	return count
}

function planText(input: {
	name: string
	phases: readonly string[]
	commands: readonly string[]
	warnings: readonly string[]
	diagnostics: readonly { message: string; line?: number }[]
	transpiled: boolean
}): string {
	const lines = [`# Workflow plan: ${input.name}`, ""]
	if (input.diagnostics.length) {
		lines.push("## Diagnostics (nothing will run)", "")
		for (const diagnostic of input.diagnostics) lines.push(`- line ${diagnostic.line ?? "?"}: ${diagnostic.message}`)
		lines.push("", "Fix the script and call workflow_create again.")
		return lines.join("\n")
	}
	lines.push(`Phases (${input.phases.length}):`)
	if (input.phases.length) lines.push(...input.phases.map((phase, index) => `${index + 1}. ${phase}`))
	else lines.push("(none — every stage needs a phase(\"...\") marker)")
	lines.push("", `Commands the run may execute (${input.commands.length}):`)
	if (input.commands.length) lines.push(...input.commands.map((command) => `- \`${command}\``))
	else lines.push("(none)")
	if (input.transpiled) lines.push("", "The script was compiled with the host's TypeScript transpiler.")
	if (input.warnings.length) {
		lines.push("", "Warnings:")
		for (const warning of input.warnings) lines.push(`- ${warning}`)
	}
	return lines.join("\n")
}

interface ManagedRun {
	readonly engine: RunEngine
	readonly controller: AbortController
	readonly cache: Map<string, string>
	settled: Promise<void>
	readonly sessionID: string
	lastEmit: number
	lastPersist: number
	/** A predecessor superseded by an amendment: no finish event, no notice. */
	silent?: boolean
	emitTimer?: ReturnType<typeof setTimeout>
}

export const internals = {
	messageText,
	lastAssistant,
	assistantCount,
	parseModelRef,
	planText,
	truncate,
	skillContent,
}

export default Plugin.define({
	id: "workflow",
	async setup(ctx) {
		const directory = String(ctx.location.directory)
		const log = {
			info: (message: string) => console.log(`[workflow] ${message}`),
			warn: (message: string) => console.error(`[workflow] ${message}`),
		}

		const runs = new Map<string, ManagedRun>()
		const history = new Map<string, RunSnapshot>()
		const waiters = new Map<string, Set<() => void>>()
		const busy = new Set<string>()
		/** Child sessions we created, for cleanup and the TUI. */
		const ownedSessions = new Set<string>()

		const waitFor = (sessionID: string): Promise<void> => {
			return new Promise((resolvePromise, rejectPromise) => {
				const set = waiters.get(sessionID) ?? new Set()
				const done = () => {
					clearTimeout(timer)
					set.delete(done)
					if (!set.size) waiters.delete(sessionID)
					resolvePromise()
				}
				const timer = setTimeout(() => {
					set.delete(done)
					if (!set.size) waiters.delete(sessionID)
					rejectPromise(new Error("Subagent turn timed out."))
				}, 30 * 60 * 1000)
				set.add(done)
				waiters.set(sessionID, set)
			})
		}

		const resolveWaiters = (sessionID: string) => {
			const set = waiters.get(sessionID)
			if (!set) return
			for (const waiter of [...set]) waiter()
		}

		// ---- persistence ---------------------------------------------------

		const persist = async (snapshot: RunSnapshot): Promise<void> => {
			try {
				await ctx.storage.set(runStorageKey(snapshot.id), jsonSafe(snapshot) as never)
			} catch (error) {
				log.warn(`persist failed for ${snapshot.id}: ${error}`)
			}
		}

		const persistCache = async (run: ManagedRun): Promise<void> => {
			if (!run.cache.size) return
			const entries = [...run.cache.entries()].slice(-CACHE_ENTRY_LIMIT).map(([key, value]) => [key, truncate(value, CACHE_VALUE_LIMIT)])
			try {
				await ctx.storage.set(`${CACHE_PREFIX}${run.engine.id}`, { entries })
			} catch (error) {
				log.warn(`cache persist failed for ${run.engine.id}: ${error}`)
			}
		}

		const loadCache = async (runID: string): Promise<AskCache> => {
			const cache = new Map<string, string>()
			try {
				const stored = (await ctx.storage.get(`${CACHE_PREFIX}${runID}`)) as { entries?: unknown } | undefined
				if (Array.isArray(stored?.entries)) {
					for (const entry of stored.entries) {
						if (Array.isArray(entry) && typeof entry[0] === "string" && typeof entry[1] === "string") cache.set(entry[0], entry[1])
					}
				}
			} catch {
				// an unreadable cache only costs tokens, never correctness
			}
			return { get: (key) => cache.get(key), set: (key, value) => void cache.set(key, value) }
		}

		const snapshotOf = (runID: string): RunSnapshot | undefined => {
			const live = runs.get(runID)
			if (live) return jsonSafe(live.engine.snapshot() as RunSnapshot)
			return history.get(runID)
		}

		const summaryOf = (runID: string): RunSummary | undefined => {
			const live = runs.get(runID)
			if (live) return live.engine.summary()
			return history.get(runID)
		}

		// ---- RPC -----------------------------------------------------------

		const rpc = await ctx.rpc.register(WorkflowRpc, {
			listRuns: async (input) => {
				const sessionID = (input as { sessionID?: unknown } | undefined)?.sessionID
				const all = [...runs.values()].map((run) => run.engine.summary()).concat([...history.values()])
				const filtered = typeof sessionID === "string" && sessionID ? all.filter((entry) => entry.sessionID === sessionID) : all
				const byID = new Map<string, RunSummary>()
				for (const entry of filtered) byID.set(entry.id, jsonSafe(entry))
				return { entries: [...byID.values()].sort((left, right) => left.createdAt - right.createdAt) }
			},
			getRun: async (input, rpcCtx) => {
				const runID = String((input as { runID?: unknown })?.runID ?? "")
				const snapshot = snapshotOf(runID)
				if (!snapshot) return rpcCtx.error("not_found", "No such run", { runID })
				return { run: snapshot }
			},
			stopRun: async (input, rpcCtx) => {
				const runID = String((input as { runID?: unknown })?.runID ?? "")
				const run = runs.get(runID)
				if (!run) return rpcCtx.error("not_found", "No such run", { runID })
				await stopRun(run, "Stopped from the run panel.")
				return { stopped: true }
			},
		})

		const emit = (run: ManagedRun, force = false): void => {
			const now = Date.now()
			if (!force && now - run.lastEmit < EMIT_THROTTLE_MS) {
				if (!run.emitTimer) {
					run.emitTimer = setTimeout(() => {
						run.emitTimer = undefined
						emit(run, true)
					}, EMIT_THROTTLE_MS)
				}
				return
			}
			run.lastEmit = now
			const summary = run.engine.summary()
			void rpc.events.emit("updated", { ...summary }).catch((error) => log.warn(`event emit failed: ${error}`))
			if (summary.status !== "running" && summary.status !== "queued" && !run.silent) {
				void rpc.events.emit("finished", { ...summary }).catch((error) => log.warn(`finish emit failed: ${error}`))
			}
			if (now - run.lastPersist > PERSIST_THROTTLE_MS || summary.status !== "running") {
				run.lastPersist = now
				void persist(run.engine.snapshot())
			}
		}

		// ---- subagent backend ----------------------------------------------

		const resolveModel = async (raw: string): Promise<{ providerID: string; id: string } | undefined> => {
			const explicit = parseModelRef(raw)
			if (explicit) return explicit
			try {
				const listed = (await ctx.model.list()) as unknown
				const models = Array.isArray(listed)
					? (listed as Array<{ id: string; providerID: string }>)
					: ((listed as { data?: Array<{ id: string; providerID: string }> }).data ?? [])
				const match = models.find((model) => model.id === raw)
				if (match) return { providerID: match.providerID, id: match.id }
			} catch {
				// fall through
			}
			return undefined
		}

		const backend: SubagentBackend = {
			create: async ({ title, model, persona, rootSessionID }) => {
				const created = await ctx.session.create({ title, location: { directory } })
				ownedSessions.add(created.id)
				if (model) {
					const resolved = await resolveModel(model)
					if (resolved) {
						await ctx.session.switchModel({ sessionID: created.id, model: resolved }).catch((error) => {
							log.warn(`could not switch subagent model to ${model}: ${error}`)
						})
					} else log.warn(`unknown subagent model "${model}"; using the session default.`)
				}
				// Persona is delivered with the first ask (engine.ts): the SDK
				// version this repo pins has no session instructions.entry.
				try {
					const root = await ctx.session.get({ sessionID: rootSessionID })
					if (root.permissions?.length) await ctx.session.update({ sessionID: created.id, permissions: root.permissions })
				} catch (error) {
					log.warn(`could not copy session permissions: ${error}`)
				}
				return created.id
			},
			ask: async (sessionID, text) => {
				const before = assistantCount(await ctx.session.context({ sessionID }))
				const idle = waitFor(sessionID)
				await ctx.session.prompt({ sessionID, text, delivery: "queue" })
				for (let attempt = 0; attempt < 4; attempt++) {
					await idle.catch(() => {})
					const messages = await ctx.session.context({ sessionID })
					if (assistantCount(messages) > before) {
						const reply = lastAssistant(messages)
						if (reply !== undefined) return reply
					}
					await new Promise((resolvePromise) => setTimeout(resolvePromise, 400))
				}
				throw new Error("The subagent produced no reply. Check the session for an error.")
			},
			interrupt: async (sessionID) => {
				await ctx.session.interrupt({ sessionID, resume: false }).catch(() => {})
			},
		}

		// ---- run lifecycle -------------------------------------------------

		const startRun = async (input: {
			name: string
			script: string
			code: string
			transpiled?: boolean
			args: Record<string, unknown>
			sessionID: string
			maxConcurrency: number
			subagentModel?: string
			resumedFrom?: string
			cache?: AskCache
		}): Promise<ManagedRun> => {
			const id = nowID()
			const controller = new AbortController()
			const seen = new Map<string, string>()
			// Every run journals its asks, so amending it later can replay the
			// ones whose text did not change. A resumed run also reads the
			// predecessor's cache through `input.cache`.
			const engineCache: AskCache = {
				get: (key) => seen.get(key) ?? input.cache?.get(key),
				set: (key, value) => {
					// Oversized replies would make the journal useless for exact
					// replay, so they are simply not cached.
					if (value.length > CACHE_VALUE_LIMIT) return
					if (!seen.has(key) && seen.size >= CACHE_ENTRY_LIMIT) return
					seen.set(key, value)
					input.cache?.set(key, value)
				},
			}
			let managed: ManagedRun
			const engine = new RunEngine(
				{ id, name: input.name, script: input.script, args: input.args },
				{
					directory,
					sessionID: input.sessionID,
					subagents: backend,
					signal: controller.signal,
					log: (line) => log.info(line),
					onUpdate: () => {
						if (managed) emit(managed)
					},
					cache: engineCache,
					maxConcurrency: input.maxConcurrency,
					subagentModel: input.subagentModel,
					resumedFrom: input.resumedFrom,
				},
			)
			managed = { engine, controller, cache: seen, settled: Promise.resolve(), sessionID: input.sessionID, lastEmit: 0, lastPersist: 0 }
			managed.settled = (async () => {
				try {
					const fn = buildScriptFunction(input.code, input.transpiled)
					await engine.execute(fn)
				} catch {
					// engine.execute records the failure
				} finally {
					await persistCache(managed)
					const final = engine.snapshot() as RunSnapshot
					await persist(final)
					emit(managed, true)
					await notifyCompletion(managed)
					// A terminal run no longer needs live bookkeeping; the
					// snapshot is what listRuns/getRun/wait read from now on.
					history.set(final.id, final)
					runs.delete(final.id)
					if (managed.emitTimer) clearTimeout(managed.emitTimer)
				}
			})()
			runs.set(id, managed)
			await persist(engine.snapshot() as RunSnapshot)
			emit(managed, true)
			return managed
		}

		const stopRun = async (run: ManagedRun, reason: string, silent = false): Promise<void> => {
			run.silent = silent
			run.controller.abort()
			run.engine.stop(reason)
			await run.engine.interruptAgents()
			await persist(run.engine.snapshot())
			emit(run, true)
		}

		const notifyCompletion = async (run: ManagedRun): Promise<void> => {
			if (run.silent) return
			const snapshot = run.engine.snapshot() as RunSnapshot
			const status = snapshot.status
			const headline =
				status === "completed"
					? `Workflow "${snapshot.name}" completed`
					: status === "stopped"
						? `Workflow "${snapshot.name}" stopped`
						: `Workflow "${snapshot.name}" failed`
			const lines = [`${headline} (${snapshot.id}).`]
			const result = snapshot.result
			if (result && typeof result === "object") {
				const record = result as Record<string, unknown>
				if (typeof record.conclusion === "string") lines.push(`Conclusion: ${record.conclusion}`)
			}
			if (snapshot.error) lines.push(`Error: ${snapshot.error.message}`)
			if (snapshot.artifacts.length) {
				lines.push("Artifacts:")
				for (const artifact of snapshot.artifacts) lines.push(`- ${artifact.title} (${artifact.kind})`)
			}
			const text = lines.join("\n")
			try {
				await ctx.session.synthetic({ sessionID: snapshot.sessionID, text })
			} catch (error) {
				log.warn(`completion message failed: ${error}`)
			}
		}

		// ---- event loop: subagent turns, cleanup ---------------------------

		const controller = new AbortController()
		void (async () => {
			for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
				const type = event.type
				const data = (event as { data?: Record<string, unknown> }).data ?? {}
				const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
				if (!sessionID) continue
				if (type === "session.status") {
					const statusType = (data.status as { type?: string } | undefined)?.type
					if (statusType === "idle") {
						busy.delete(sessionID)
						resolveWaiters(sessionID)
					} else busy.add(sessionID)
					continue
				}
				if (type === "session.idle") {
					busy.delete(sessionID)
					resolveWaiters(sessionID)
					continue
				}
				if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
					resolveWaiters(sessionID)
					continue
				}
				if (type === "session.deleted") {
					ownedSessions.delete(sessionID)
					busy.delete(sessionID)
				}
			}
		})().catch((error) => log.warn(`event loop stopped: ${error}`))

		// ---- skill ---------------------------------------------------------

		try {
			await ctx.skill.transform((editor) => {
				editor.add({
					id: Skill.ID.make(SKILL_ID),
					name: Skill.Name.make("workflow"),
					description: "Write, run and revise multi-subagent workflow scripts.",
					autoinvoke: false,
					path: fileURLToPath(new URL("./SKILL.md", import.meta.url)) as never,
					content: skillContent(),
				})
			})
		} catch (error) {
			log.warn(`could not register the workflow skill: ${error}`)
		}

		// ---- /workflow command ---------------------------------------------

		await ctx.command.transform((editor) => {
			editor.add({
				name: "workflow",
				description: "Design and launch a multi-subagent workflow for a task",
				async execute({ sessionID, prompt, delivery }) {
					const raw = (prompt.text ?? "").replace(/^\/?workflow\b\s*/i, "").trim()
					const instruction = raw
						? `Design and run a workflow for this request:\n\n${raw}`
						: "Ask the user what the workflow should accomplish, then design it. Do not start a run before you have a concrete task."
					const body = [
						instruction,
						"",
						"Load the workflow skill before writing the script. Follow its contract:",
						"- every stage opens with phase(\"...\") in the user's language;",
						"- fan out one named subagent per item, chain stages per item, join only where the next step needs every item;",
						"- gate loops on world.run when a command can decide;",
						"- report each finding as it lands, verify what the user will act on, and publish the deliverable as an artifact;",
						"- return the report shape from the skill.",
						"",
						"Call workflow_create without confirm first, read the graph and command set it returns, fix diagnostics, then call it again with confirm: true.",
					].join("\n")
					await ctx.session.prompt({
						sessionID,
						delivery,
						text: body,
						skills: [{ id: SKILL_ID }],
					})
				},
			})
		})

		// ---- tools ---------------------------------------------------------

		const readScript = async (input: { script?: string; path?: string; saved?: string }): Promise<{ script: string; args: Record<string, unknown>; name?: string; savedInfo?: string }> => {
			if (input.script?.trim()) return { script: input.script, args: {} }
			if (input.path) {
				const absolute = isAbsolute(input.path) ? input.path : resolve(directory, input.path)
				const script = await readFile(absolute, "utf8")
				return { script, args: {} }
			}
			if (input.saved) {
				const saved = await loadSaved(directory, input.saved)
				if (!saved) throw new Error(`No saved workflow named "${input.saved}".`)
				return { script: saved.body, args: {}, name: saved.info.name, savedInfo: saved.info.description }
			}
			throw new Error("Pass one of script, path or saved.")
		}

		await ctx.tool.transform((editor) => {
			editor.add({
				name: "workflow_plan",
				description:
					"Compile a workflow script without running it. Returns the phase graph, the commands the run may execute, and diagnostics. Use this to iterate before starting a run.",
				input: {
					type: "object",
					properties: {
						name: { type: "string", description: "Short run label in the user's language" },
						script: { type: "string", description: "The workflow script body" },
						path: { type: "string", description: "A script file to read instead" },
					},
					required: ["name"],
					additionalProperties: false,
				},
				options: { permission: "workflow_plan" },
				async execute(input) {
					const args = input as { name: string; script?: string; path?: string }
					try {
						const source = await readScript({ script: args.script, path: args.path })
						const compiled = compileScript(source.script)
						return {
							content: planText({
								name: args.name,
								phases: compiled.phases,
								commands: compiled.commands,
								warnings: compiled.warnings,
								diagnostics: compiled.diagnostics,
								transpiled: compiled.transpiled,
							}),
						}
					} catch (error) {
						return { content: `workflow_plan failed: ${error instanceof Error ? error.message : String(error)}` }
					}
				},
			})

			editor.add({
				name: "workflow_create",
				description:
					"Start a workflow run. Without confirm it only returns the plan (phase graph, command set, diagnostics) and starts nothing. With confirm: true it starts the run in the background and returns a run id; use workflow_wait or workflow_get for the result.",
				input: {
					type: "object",
					properties: {
						name: { type: "string", description: "Short run label in the user's language" },
						script: { type: "string", description: "The workflow script body" },
						path: { type: "string", description: "A script file to read instead of script" },
						saved: { type: "string", description: "Run a saved workflow by name" },
						args: { type: "object", description: "Values the script reads from args" },
						max_concurrency: { type: "integer", description: "Upper bound on simultaneous subagents (default 4)" },
						subagent_model: { type: "string", description: "provider/model for subagents; only when the user asked" },
						background: { type: "boolean", description: "Return immediately (default true); false waits for the result" },
						confirm: { type: "boolean", description: "Start the run. Omit to get the plan only." },
						notify_agent: {
							type: "boolean",
							description: "Queue a prompt to this session when the run settles, so the agent reports the result (default false)",
						},
					},
					required: ["name"],
					additionalProperties: false,
				},
				options: { permission: "workflow_create" },
				async execute(input, toolCtx) {
					const params = input as {
						name: string
						script?: string
						path?: string
						saved?: string
						args?: Record<string, unknown>
						max_concurrency?: number
						subagent_model?: string
						background?: boolean
						confirm?: boolean
						notify_agent?: boolean
					}
					if (ownedSessions.has(toolCtx.sessionID)) {
						return { content: "Subagents cannot start workflows. Report your result normally; the root session decides what runs next." }
					}
					try {
						const source = await readScript({ script: params.script, path: params.path, saved: params.saved })
						const name = source.name ?? params.name
						const compiled = compileScript(source.script)
						const plan = planText({
							name,
							phases: compiled.phases,
							commands: compiled.commands,
							warnings: compiled.warnings,
							diagnostics: compiled.diagnostics,
							transpiled: compiled.transpiled,
						})
						if (compiled.diagnostics.length) return { content: `${plan}\n\nNothing was started.` }
						if (!params.confirm) {
							return {
								content: `${plan}\n\nNothing has started. Call workflow_create again with the same script and \`confirm: true\` to run it.`,
							}
						}
						const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, params.max_concurrency ?? DEFAULT_CONCURRENCY))
						const run = await startRun({
							name,
							script: source.script,
							code: compiled.code,
							transpiled: compiled.transpiled,
							args: params.args ?? {},
							sessionID: toolCtx.sessionID,
							maxConcurrency: concurrency,
							subagentModel: params.subagent_model,
						})
						const header = `${plan}\n\nStarted workflow ${run.engine.id} "${name}".`
						if (params.background === false) {
							await Promise.race([run.settled, new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_DEFAULT_MS))])
							const snapshot = run.engine.snapshot() as RunSnapshot
							return { content: `${header}\n\n${renderSnapshot(snapshot)}` }
						}
						if (params.notify_agent) {
							// Queue one continuation after the run settles.
							void run.settled.then(async () => {
								const snapshot = run.engine.snapshot() as RunSnapshot
								if (snapshot.status === "completed" || snapshot.status === "stopped" || snapshot.status === "errored") {
									const conclusion =
										snapshot.result && typeof snapshot.result === "object"
											? (snapshot.result as Record<string, unknown>).conclusion
											: undefined
									await ctx.session
										.prompt({
											sessionID: toolCtx.sessionID,
											delivery: "queue",
											text: `[workflow] Run ${snapshot.id} "${snapshot.name}" settled as ${snapshot.status}.${
												typeof conclusion === "string" ? ` Conclusion: ${conclusion}` : ""
											} Read it with workflow_get if you need the details, then report the outcome to the user.`,
										})
										.catch((error) => log.warn(`continuation failed: ${error}`))
								}
							})
						}
						return {
							content: `${header}\n\nThe run continues in the background. Do not poll it: call workflow_wait when you need the result, or workflow_get for a snapshot.`,
						}
					} catch (error) {
						return { content: `workflow_create failed: ${error instanceof Error ? error.message : String(error)}` }
					}
				},
			})

			editor.add({
				name: "workflow_get",
				description: "Snapshot of one workflow run: phases, agents, artifacts, logs, result and error. Omit run_id for the newest run in this session.",
				input: {
					type: "object",
					properties: { run_id: { type: "string" } },
					additionalProperties: false,
				},
				options: { permission: "workflow_get" },
				async execute(input, toolCtx) {
					const runID = (input as { run_id?: string }).run_id
					let id = runID
					if (!id) {
						const candidates = [...runs.values()]
							.map((run) => run.engine.summary())
							.concat([...history.values()])
							.filter((entry) => entry.sessionID === toolCtx.sessionID)
							.sort((left, right) => right.createdAt - left.createdAt)
						id = candidates[0]?.id
					}
					if (!id) return { content: "No workflow runs in this session." }
					const snapshot = snapshotOf(id)
					if (!snapshot) return { content: `No workflow run with id ${id}.` }
					return { content: renderSnapshot(snapshot) }
				},
			})

			editor.add({
				name: "workflow_list",
				description: "List workflow runs, newest last.",
				input: {
					type: "object",
					properties: { session_id: { type: "string", description: "Filter to one session" } },
					additionalProperties: false,
				},
				options: { permission: "workflow_list" },
				async execute(input) {
					const sessionID = (input as { session_id?: string }).session_id
					const all = [...runs.values()].map((run) => run.engine.summary()).concat([...history.values()])
					const filtered = sessionID ? all.filter((entry) => entry.sessionID === sessionID) : all
					const byID = new Map<string, RunSummary>()
					for (const entry of filtered) byID.set(entry.id, entry)
					const entries = [...byID.values()].sort((left, right) => left.createdAt - right.createdAt)
					if (!entries.length) return { content: "No workflow runs yet." }
					return {
						content: entries
							.map(
								(entry) =>
									`${entry.id}  ${entry.status.padEnd(9)}  ${entry.phasesDone}/${entry.phaseCount} phases  ${entry.agentCount} agents  ${entry.name}`,
							)
							.join("\n"),
					}
				},
			})

			editor.add({
				name: "workflow_wait",
				description: "Block until a workflow run settles, then return its report. Only call this when you need the result now.",
				input: {
					type: "object",
					properties: {
						run_id: { type: "string" },
						timeout_ms: { type: "integer", description: "Default 30 minutes" },
					},
					required: ["run_id"],
					additionalProperties: false,
				},
				options: { permission: "workflow_wait" },
				async execute(input, toolCtx) {
					const params = input as { run_id: string; timeout_ms?: number }
					const run = runs.get(params.run_id)
					if (!run) {
						const snapshot = history.get(params.run_id)
						if (!snapshot) return { content: `No workflow run with id ${params.run_id}.` }
						return { content: renderSnapshot(snapshot) }
					}
					const timeout = Math.min(2 * 60 * 60 * 1000, Math.max(5_000, params.timeout_ms ?? WAIT_DEFAULT_MS))
					const settled = await Promise.race([
						run.settled.then(() => true),
						new Promise<boolean>((resolvePromise) => {
							const timer = setTimeout(() => resolvePromise(false), timeout)
							void run.settled.finally(() => clearTimeout(timer))
						}),
						new Promise<boolean>((resolvePromise) => {
							toolCtx.signal.addEventListener("abort", () => resolvePromise(false), { once: true })
						}),
					])
					const snapshot = run.engine.snapshot() as RunSnapshot
					return { content: `${settled ? "" : "Timed out; the run is still going.\n\n"}${renderSnapshot(snapshot)}` }
				},
			})

			editor.add({
				name: "workflow_stop",
				description: "Stop a running workflow. Subagent sessions are interrupted; finished work is kept.",
				input: {
					type: "object",
					properties: { run_id: { type: "string" } },
					required: ["run_id"],
					additionalProperties: false,
				},
				options: { permission: "workflow_stop" },
				async execute(input) {
					const runID = String((input as { run_id?: string }).run_id ?? "")
					const run = runs.get(runID)
					if (!run) return { content: `No running workflow with id ${runID}.` }
					await stopRun(run, "Stopped by the agent.")
					return { content: `Stopped ${runID}.` }
				},
			})

			editor.add({
				name: "workflow_amend",
				description:
					"Revise a run that errored, stopped or finished: start a new run with the revised script, reusing every ask whose text did not change. Use this instead of starting over.",
				input: {
					type: "object",
					properties: {
						run_id: { type: "string", description: "The run to supersede" },
						script: { type: "string" },
						path: { type: "string" },
						max_concurrency: { type: "integer" },
						subagent_model: { type: "string" },
						background: { type: "boolean" },
						confirm: { type: "boolean" },
					},
					required: ["run_id", "confirm"],
					additionalProperties: false,
				},
				options: { permission: "workflow_amend" },
				async execute(input, toolCtx) {
					const params = input as {
						run_id: string
						script?: string
						path?: string
						max_concurrency?: number
						subagent_model?: string
						background?: boolean
						confirm?: boolean
					}
					if (ownedSessions.has(toolCtx.sessionID)) {
						return { content: "Subagents cannot amend workflows. Report your result normally; the root session decides what runs next." }
					}
					const predecessor = snapshotOf(params.run_id)
					if (!predecessor) return { content: `No workflow run with id ${params.run_id}.` }
					try {
						const source = params.script?.trim()
							? params.script
							: params.path
								? await readFile(isAbsolute(params.path) ? params.path : resolve(directory, params.path), "utf8")
								: undefined
						if (!source) return { content: "Pass the revised script or a path to it." }
						const compiled = compileScript(source)
						const plan = planText({
							name: predecessor.name,
							phases: compiled.phases,
							commands: compiled.commands,
							warnings: compiled.warnings,
							diagnostics: compiled.diagnostics,
							transpiled: compiled.transpiled,
						})
						if (compiled.diagnostics.length) return { content: `${plan}\n\nNothing was started.` }
						if (!params.confirm) {
							return { content: `${plan}\n\nNothing has started. Call workflow_amend again with confirm: true to supersede ${params.run_id}.` }
						}
						const live = runs.get(params.run_id)
						if (live) await stopRun(live, "Superseded by an amendment.", true)
						const cache = await loadCache(params.run_id)
						const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, params.max_concurrency ?? predecessor.maxConcurrency ?? DEFAULT_CONCURRENCY))
						const run = await startRun({
							name: predecessor.name,
							script: source,
							code: compiled.code,
							transpiled: compiled.transpiled,
							args: { ...(predecessor.args ?? {}) },
							sessionID: toolCtx.sessionID,
							maxConcurrency: concurrency,
							subagentModel: params.subagent_model ?? predecessor.subagentModel,
							resumedFrom: params.run_id,
							cache,
						})
						const header = `${plan}\n\nStarted ${run.engine.id}, superseding ${params.run_id}. Unchanged asks replay from cache.`
						if (params.background === false) {
							await Promise.race([run.settled, new Promise((resolvePromise) => setTimeout(resolvePromise, WAIT_DEFAULT_MS))])
							return { content: `${header}\n\n${renderSnapshot(run.engine.snapshot() as RunSnapshot)}` }
						}
						return { content: `${header}\n\nIt continues in the background; use workflow_wait when you need the result.` }
					} catch (error) {
						return { content: `workflow_amend failed: ${error instanceof Error ? error.message : String(error)}` }
					}
				},
			})

			editor.add({
				name: "workflow_save",
				description:
					"Save a workflow definition so it can run again by name. Only call when the user asks to save, or agrees to your suggestion.",
				input: {
					type: "object",
					properties: {
						name: { type: "string", description: "File-safe identifier" },
						description: { type: "string" },
						when_to_use: { type: "string" },
						scope: { type: "string", enum: ["project", "global"] },
						script: { type: "string" },
						path: { type: "string" },
						args: { type: "object", description: "Argument declarations keyed by name" },
					},
					required: ["name", "description", "scope"],
					additionalProperties: false,
				},
				options: { permission: "workflow_save" },
				async execute(input) {
					const params = input as {
						name: string
						description: string
						when_to_use?: string
						scope: "project" | "global"
						script?: string
						path?: string
						args?: Record<string, unknown>
					}
					try {
						const source = await readScript({ script: params.script, path: params.path })
						const compiled = compileScript(source.script)
						if (compiled.diagnostics.length) {
							return { content: `Not saved: ${compiled.diagnostics.map((diagnostic) => diagnostic.message).join("; ")}` }
						}
						const info = await saveSaved(directory, {
							name: params.name,
							description: params.description,
							whenToUse: params.when_to_use,
							scope: params.scope,
							script: source.script,
							args: params.args,
						})
						return { content: `Saved workflow "${info.name}" (${info.scope}) at ${info.path}.` }
					} catch (error) {
						return { content: `workflow_save failed: ${error instanceof Error ? error.message : String(error)}` }
					}
				},
			})

			editor.add({
				name: "workflow_list_saved",
				description: "List saved workflow definitions in this project and globally.",
				input: { type: "object", properties: {}, additionalProperties: false },
				options: { permission: "workflow_list_saved" },
				async execute() {
					try {
						const entries = await listSaved(directory)
						if (!entries.length) return { content: "No saved workflows." }
						return {
							content: entries
								.map(
									(entry) =>
										`${entry.name}  [${entry.scope}]  ${entry.description}${entry.whenToUse ? `\n    when: ${entry.whenToUse}` : ""}`,
								)
								.join("\n"),
						}
					} catch (error) {
						return { content: `workflow_list_saved failed: ${error instanceof Error ? error.message : String(error)}` }
					}
				},
			})
		})

		// ---- rehydrate -----------------------------------------------------

		try {
			let after: string | undefined
			for (;;) {
				const page = await ctx.storage.scan({ prefix: "workflow/run/", after, limit: 100 })
				for (const entry of page.entries) {
					const value = entry.value as unknown as RunSnapshot | undefined
					if (!value || typeof value !== "object" || typeof value.id !== "string") continue
					if (runs.has(value.id)) continue
					history.set(value.id, {
						...value,
						// A run that was live when the process exited has no engine
						// any more. Keep what it produced, and say so plainly.
						status: value.status === "running" || value.status === "queued" ? "stopped" : value.status,
						...(value.status === "running" || value.status === "queued" ? { stoppedReason: "interrupted" } : {}),
					})
				}
				if (!page.next) break
				after = page.next
			}
			if (history.size) log.info(`rehydrated ${history.size} workflow run(s)`)
		} catch (error) {
			log.warn(`run rehydration failed: ${error}`)
		}

		return async () => {
			controller.abort()
			for (const run of runs.values()) {
				run.controller.abort()
				if (run.emitTimer) clearTimeout(run.emitTimer)
			}
			try {
				await rpc.dispose()
			} catch (error) {
				log.warn(`rpc dispose failed: ${error}`)
			}
		}
	},
})

function phaseDetail(phase: RunSnapshot["phases"][number]): string | undefined {
	const parts: string[] = []
	if (phase.agentCount) parts.push(`${phase.agentCount} agent${phase.agentCount === 1 ? "" : "s"}`)
	if (phase.askCount) parts.push(`${phase.askCount} ask${phase.askCount === 1 ? "" : "s"}`)
	if (phase.startedAt && phase.endedAt && phase.endedAt > phase.startedAt) {
		parts.push(`${Math.max(1, Math.round((phase.endedAt - phase.startedAt) / 1000))}s`)
	}
	return parts.length ? parts.join(" · ") : undefined
}

/** Human-readable snapshot for a tool result. */
export function renderSnapshot(snapshot: RunSnapshot): string {
	const lines = [
		`# ${snapshot.name} — ${snapshot.status}`,
		`run ${snapshot.id}${snapshot.resumedFrom ? ` (amended from ${snapshot.resumedFrom})` : ""}`,
		"",
	]
	if (snapshot.phases.length) {
		const phases: GraphPhase[] = snapshot.phases.map((phase) => ({
			name: phase.name,
			status: phase.status,
			visits: phase.visits,
			detail: phaseDetail(phase),
		}))
		const graph = layoutGraph(phases, snapshot.edges, { width: 96, mode: "auto", detail: true })
		lines.push("## Phases", renderGraph(graph), "")
	}
	if (snapshot.agents.length) {
		lines.push("## Subagents")
		for (const agent of snapshot.agents) lines.push(`- ${agent.name}: ${agent.asks} asks, ${agent.status}`)
		lines.push("")
	}
	if (snapshot.logs.length) {
		lines.push("## Log", ...snapshot.logs.slice(-20).map((line) => `- ${line}`), "")
	}
	if (snapshot.artifacts.length) {
		lines.push("## Artifacts")
		for (const artifact of snapshot.artifacts) lines.push(`- ${artifact.title} (${artifact.kind})${artifact.primary ? " ★" : ""}`)
		lines.push("")
	}
	lines.push("## Result", "```json", JSON.stringify(snapshot.result ?? null, null, 2).slice(0, 12_000), "```")
	if (snapshot.error) lines.push("", "## Error", `${snapshot.error.message}`, snapshot.error.stack ?? "")
	return lines.join("\n")
}
