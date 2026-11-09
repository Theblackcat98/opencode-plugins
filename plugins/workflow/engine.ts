/**
 * Workflow script engine.
 *
 * One instance owns one run: the phase graph, the subagent sessions, the
 * artifact store, the journaled ask cache and the facade a script sees. The
 * server plugin adapts ctx to RunDeps; unit tests drive it with a fake backend.
 */

import { stat } from "node:fs/promises"
import { extname, isAbsolute, resolve, sep } from "node:path"
import { ArtifactStore, type BoardSpec, type ChartSpec, type MetricsSpec, type TableSpec } from "./artifacts.js"
import { ProcessError, runProcess, type OutputOption } from "./exec.js"
import { gitChangedFiles, gitDiff, gitLog, gitStatus, globFiles, grepFiles, readText } from "./fsx.js"
import type { AgentInfo, ArtifactView, EdgeInfo, PhaseInfo, RunError, RunStatus, RunSummary } from "./types.js"

export interface SubagentBackend {
	/** Create a subagent session. Returns its session id. */
	create(options: { title: string; model?: string; persona?: string; rootSessionID: string }): Promise<string>
	/** Send one ask, wait for the turn to settle, return the assistant's reply text. */
	ask(sessionID: string, text: string): Promise<string>
	/** Stop work in the session. Best effort. */
	interrupt(sessionID: string): Promise<void>
}

export interface AskCache {
	get(key: string): string | undefined
	set(key: string, value: string): void
}

export interface RunDeps {
	readonly directory: string
	readonly sessionID: string
	readonly subagents: SubagentBackend
	readonly signal: AbortSignal
	readonly log: (message: string) => void
	readonly onUpdate: () => void
	readonly cache?: AskCache
	readonly askTimeoutMs?: number
	readonly maxConcurrency?: number
	readonly subagentModel?: string
	readonly resumedFrom?: string
}

export interface EngineOptions {
	readonly id: string
	readonly name: string
	readonly script: string
	readonly args: Readonly<Record<string, unknown>>
}

interface AgentSlot {
	info: AgentInfo
	sessionID?: string
	persona?: string
}

const LOG_LIMIT = 200
const LOG_LINE_LIMIT = 2000
const ITEM_LIMIT = 1000
const ASK_TIMEOUT_MS = 30 * 60 * 1000
const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html",
	".htm": "text/html",
	".md": "text/markdown",
	".json": "application/json",
	".csv": "text/csv",
	".txt": "text/plain",
	".pdf": "application/pdf",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".toml": "application/toml",
	".yaml": "application/yaml",
	".yml": "application/yaml",
}

class Semaphore {
	private available: number
	private readonly waiting: Array<() => void> = []

	constructor(size: number) {
		this.available = Math.max(1, size)
	}

	async acquire(signal?: AbortSignal): Promise<() => void> {
		if (signal?.aborted) throw new Error("The run was stopped.")
		if (this.available > 0) {
			this.available -= 1
			return () => this.release()
		}
		return new Promise<() => void>((resolvePromise, rejectPromise) => {
			const grant = () => {
				signal?.removeEventListener("abort", onAbort)
				resolvePromise(() => this.release())
			}
			const onAbort = () => {
				const index = this.waiting.indexOf(grant)
				if (index !== -1) this.waiting.splice(index, 1)
				rejectPromise(new Error("The run was stopped."))
			}
			this.waiting.push(grant)
			signal?.addEventListener("abort", onAbort, { once: true })
		})
	}

	private release(): void {
		const next = this.waiting.shift()
		if (next) next()
		else this.available += 1
	}
}

/** Unbounded FIFO stream between two stages. */
class AsyncQueue<T> implements AsyncIterable<T> {
	private readonly items: T[] = []
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = []
	private closed = false

	constructor(readonly name = "channel") {}

	send(item: T): void {
		if (this.closed) throw new Error(`ChannelClosed: "${this.name}" was already closed.`)
		const waiter = this.waiters.shift()
		if (waiter) waiter({ value: item, done: false })
		else this.items.push(item)
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		while (this.waiters.length) this.waiters.shift()!({ value: undefined as never, done: true })
	}

	private next(): Promise<IteratorResult<T>> {
		if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
		if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
		return new Promise((resolvePromise) => this.waiters.push(resolvePromise))
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return { next: () => this.next() }
	}
}

function parseModel(value: unknown): string | undefined {
	if (typeof value === "string" && value.trim()) return value.trim()
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>
		if (typeof record.id === "string" && record.id) return record.id
		if (typeof record.__modelRef === "string") return record.__modelRef
	}
	return undefined
}

function stripFences(text: string): string {
	return text.replace(/```(?:json)?[ \t]*\r?\n?/gi, "").replace(/```/g, "")
}

function extractJSON(text: string): string | undefined {
	const clean = stripFences(text)
	const start = clean.search(/[[{]/)
	if (start === -1) return undefined
	const open = clean[start]
	const close = open === "{" ? "}" : "]"
	let depth = 0
	let inString = false
	let escaped = false
	for (let i = start; i < clean.length; i++) {
		const char = clean[i]
		if (inString) {
			if (escaped) escaped = false
			else if (char === "\\") escaped = true
			else if (char === '"') inString = false
			continue
		}
		if (char === '"') inString = true
		else if (char === open) depth++
		else if (char === close) {
			depth--
			if (depth === 0) return clean.slice(start, i + 1)
		}
	}
	return undefined
}

export class RunEngine {
	readonly id: string
	readonly name: string
	readonly script: string
	readonly args: Readonly<Record<string, unknown>>
	readonly startedAt: number
	readonly artifacts = new ArtifactStore()
	readonly subagentModel?: string

	private readonly deps: RunDeps
	private readonly semaphore: Semaphore
	private readonly agents = new Map<string, AgentSlot>()
	private readonly anonymous: AgentSlot[] = []
	private readonly phaseList: PhaseInfo[] = []
	private readonly edgeList: EdgeInfo[] = []
	private readonly phaseAgents = new Map<number, Set<string>>()
	private readonly artifactPhase = new Map<string, number>()
	private readonly items: unknown[] = []
	private readonly logs: string[] = []
	private readonly cache?: AskCache
	private readonly askTimeoutMs: number
	private currentPhase = -1
	private status: RunStatus = "running"
	private result: unknown
	private error?: RunError
	private endedAt?: number
	private syntheticID = 0

	constructor(options: EngineOptions, deps: RunDeps) {
		this.id = options.id
		this.name = options.name
		this.script = options.script
		this.args = Object.freeze({ ...options.args })
		this.deps = deps
		this.cache = deps.cache
		this.startedAt = Date.now()
		this.semaphore = new Semaphore(deps.maxConcurrency ?? 4)
		this.askTimeoutMs = deps.askTimeoutMs ?? ASK_TIMEOUT_MS
		this.subagentModel = deps.subagentModel
	}

	get running(): boolean {
		return this.status === "running"
	}

	summary(): RunSummary {
		return {
			id: this.id,
			name: this.name,
			status: this.status,
			sessionID: this.deps.sessionID,
			directory: this.deps.directory,
			createdAt: this.startedAt,
			updatedAt: Date.now(),
			...(this.endedAt ? { endedAt: this.endedAt } : {}),
			phaseCount: this.phaseList.length,
			phasesDone: this.phaseList.filter((phase) => phase.status === "done").length,
			agentCount: this.agents.size + this.anonymous.length,
			artifactCount: this.artifacts.views().length,
			...(this.error ? { error: this.error } : {}),
			...(this.deps.resumedFrom ? { resumedFrom: this.deps.resumedFrom } : {}),
		}
	}

	snapshot() {
		return {
			...this.summary(),
			phases: this.phaseList.map((phase) => ({ ...phase })),
			edges: this.edgeList.map((edge) => ({ ...edge })),
			...(this.currentPhase >= 0 ? { currentPhase: this.currentPhase } : {}),
			agents: [...this.agents.values()].map((slot) => ({ ...slot.info })).concat(this.anonymous.map((slot) => ({ ...slot.info }))),
			artifacts: this.artifacts.views().map((artifact) => {
				const phase = this.artifactPhase.get(artifact.id)
				return phase === undefined ? artifact : { ...artifact, phase }
			}),
			items: this.items.slice(-200),
			logs: [...this.logs],
			args: { ...this.args },
			...(this.result !== undefined ? { result: this.result } : {}),
			maxConcurrency: this.deps.maxConcurrency ?? 4,
			...(this.subagentModel ? { subagentModel: this.subagentModel } : {}),
			script: this.script,
		}
	}

	async execute(fn: (facade: Record<string, unknown>) => Promise<unknown>): Promise<unknown> {
		try {
			this.logLine(`Started "${this.name}"${this.deps.resumedFrom ? ` (amending ${this.deps.resumedFrom})` : ""}.`)
			const value = await fn(this.facade())
			this.result = value
			this.complete()
			return value
		} catch (error) {
			if (this.deps.signal.aborted) this.stop("User stop requested.")
			else this.fail(error)
			throw error
		} finally {
			this.endedAt = Date.now()
			for (const slot of [...this.agents.values(), ...this.anonymous]) {
				if (!slot.sessionID) continue
				slot.info = { ...slot.info, status: this.status === "errored" ? "error" : "done" }
			}
			this.deps.onUpdate()
		}
	}

	complete(): void {
		if (this.status !== "running") return
		this.status = "completed"
		this.endedAt = Date.now()
		for (const [index, phase] of this.phaseList.entries()) {
			if (phase.status !== "active") continue
			this.phaseList[index] = { ...phase, status: "done", endedAt: this.endedAt }
		}
		this.currentPhase = -1
		this.logLine("Completed.")
		this.deps.onUpdate()
	}

	fail(error: unknown): void {
		if (this.status !== "running") return
		this.status = "errored"
		this.endedAt = Date.now()
		const message = error instanceof Error ? error.message : String(error)
		this.error = {
			message,
			...(error instanceof Error && error.stack ? { stack: error.stack.split("\n").slice(0, 8).join("\n") } : {}),
			kind: error instanceof ProcessError ? "script" : "script",
		}
		for (const [index, phase] of this.phaseList.entries()) {
			if (phase.status !== "active") continue
			this.phaseList[index] = { ...phase, status: "error", endedAt: this.endedAt }
		}
		this.currentPhase = -1
		this.logLine(`Errored: ${message}`)
		this.deps.onUpdate()
	}

	stop(reason = "Stopped."): void {
		if (this.status !== "running") return
		this.status = "stopped"
		this.endedAt = Date.now()
		this.error = undefined
		for (const [index, phase] of this.phaseList.entries()) {
			if (phase.status !== "active") continue
			this.phaseList[index] = { ...phase, status: "pending", endedAt: this.endedAt }
		}
		this.currentPhase = -1
		this.logLine(reason)
		this.deps.onUpdate()
	}

	async interruptAgents(): Promise<void> {
		for (const slot of [...this.agents.values(), ...this.anonymous]) {
			if (!slot.sessionID) continue
			await this.deps.subagents.interrupt(slot.sessionID).catch(() => {})
		}
	}

	// ---- facade ---------------------------------------------------------

	private logLine(message: string): void {
		const line = message.length > LOG_LINE_LIMIT ? `${message.slice(0, LOG_LINE_LIMIT)}…` : message
		this.logs.push(line)
		if (this.logs.length > LOG_LIMIT) this.logs.shift()
		this.deps.log(line)
	}

	private advancePhase(name: string): void {
		if (!name.trim()) throw new Error("phase() needs a non-empty name.")
		const now = Date.now()
		let index = this.phaseList.findIndex((phase) => phase.name === name)
		if (index === -1) {
			this.phaseList.push({ name, status: "active", visits: 1, startedAt: now })
			index = this.phaseList.length - 1
		} else {
			const existing = this.phaseList[index]
			this.phaseList[index] = {
				...existing,
				status: "active",
				visits: existing.visits + 1,
				startedAt: existing.startedAt ?? now,
				endedAt: undefined,
			}
		}
		if (this.currentPhase !== -1 && this.currentPhase !== index) {
			const previous = this.phaseList[this.currentPhase]
			if (previous?.status === "active") {
				this.phaseList[this.currentPhase] = { ...previous, status: "done", endedAt: now }
			}
			const existing = this.edgeList.find((edge) => edge.from === this.currentPhase && edge.to === index)
			if (existing) {
				existing.traversals += 1
			} else {
				this.edgeList.push({
					from: this.currentPhase,
					to: index,
					kind: index < this.currentPhase ? "loop" : "forward",
					traversals: 1,
				})
			}
		}
		this.currentPhase = index
		this.deps.onUpdate()
	}

	private touchAsk(slot: AgentSlot): void {
		if (this.currentPhase < 0) return
		const phase = this.phaseList[this.currentPhase]
		if (!phase) return
		const agents = this.phaseAgents.get(this.currentPhase) ?? new Set<string>()
		agents.add(slot.info.name)
		this.phaseAgents.set(this.currentPhase, agents)
		this.phaseList[this.currentPhase] = {
			...phase,
			agentCount: agents.size,
			askCount: (phase.askCount ?? 0) + 1,
		}
		slot.info = { ...slot.info, phase: this.currentPhase }
	}

	private slot(name?: string, persona?: string): AgentSlot {
		if (!name || !name.trim()) {
			const slot: AgentSlot = {
				info: { name: `agent-${++this.syntheticID}`, asks: 0, status: "idle" },
				...(persona ? { persona } : {}),
			}
			this.anonymous.push(slot)
			return slot
		}
		const id = name.trim()
		let slot = this.agents.get(id)
		if (slot) {
			if (persona && !slot.persona) slot.persona = persona
			return slot
		}
		slot = { info: { name: id, asks: 0, status: "idle" }, ...(persona ? { persona } : {}) }
		this.agents.set(id, slot)
		return slot
	}

	/** The facade object handed to the script. Every member is frozen. */
	facade(): Record<string, unknown> {
		const update = () => this.deps.onUpdate()
		const ensureAbort = () => {
			if (this.deps.signal.aborted) throw new Error("The run was stopped.")
		}

		const askAgent = async (slot: AgentSlot, text: string, jsonHint?: string): Promise<string> => {
			ensureAbort()
			this.touchAsk(slot)
			const rolePrefix = slot.info.asks === 0 && slot.persona ? `Role for this conversation: ${slot.persona}\n\n` : ""
			const body = `${rolePrefix}${text}`
			const prompt = jsonHint ? `${body}\n\nReply with only a JSON object, no prose, no markdown fences.` : body
			const key = `${slot.info.name}\u0000${prompt}`
			const cached = this.cache?.get(key)
			if (cached !== undefined) {
				this.logLine(`cache hit · ${slot.info.name}`)
				return cached
			}
			const release = await this.semaphore.acquire(this.deps.signal)
			slot.info = { ...slot.info, asks: slot.info.asks + 1, status: "running" }
			update()
			try {
				ensureAbort()
				if (!slot.sessionID) {
					slot.sessionID = await this.deps.subagents.create({
						title: `[workflow] ${this.name} · ${slot.info.name}`,
						model: this.subagentModel,
						persona: slot.persona,
						rootSessionID: this.deps.sessionID,
					})
					slot.info = { ...slot.info, sessionID: slot.sessionID }
					update()
				}
				const controller = new AbortController()
				const onAbort = () => controller.abort()
				this.deps.signal.addEventListener("abort", onAbort, { once: true })
				const timer = setTimeout(() => controller.abort(), this.askTimeoutMs)
				try {
					const reply = await withAbort(this.deps.subagents.ask(slot.sessionID, prompt), controller.signal)
					this.cache?.set(key, reply)
					return reply
				} finally {
					clearTimeout(timer)
					this.deps.signal.removeEventListener("abort", onAbort)
				}
			} finally {
				slot.info = { ...slot.info, status: "idle" }
				release()
				update()
			}
		}

		const workspacePath = (path: string): string => {
			const absolute = isAbsolute(path) ? resolve(path) : resolve(this.deps.directory, path)
			const root = resolve(this.deps.directory)
			if (absolute !== root && !absolute.startsWith(root + sep)) {
				throw new Error(`Path "${path}" is outside the workspace.`)
			}
			return absolute
		}

		const tagArtifact = (id: unknown): void => {
			if (this.currentPhase >= 0) this.artifactPhase.set(String(id ?? ""), this.currentPhase)
		}

		const facade: Record<string, unknown> = {
			args: this.args,
			run: Object.freeze({ id: this.id, name: this.name, ...(this.deps.resumedFrom ? { resumedFrom: this.deps.resumedFrom } : {}) }),
			log: (message: unknown) => {
				this.logLine(String(message ?? ""))
			},
			phase: (name: unknown) => {
				ensureAbort()
				this.advancePhase(String(name ?? ""))
			},
			model: (id: unknown) => Object.freeze({ __modelRef: String(id ?? "") }),
			sleep: (ms: unknown) => abortableSleep(Math.max(0, Number(ms) || 0), this.deps.signal),
			agent: (name?: unknown, persona?: unknown) => {
				const slot = this.slot(name === undefined ? undefined : String(name), typeof persona === "string" ? persona : undefined)
				return Object.freeze({
					ask: (instructions: unknown) => askAgent(slot, String(instructions ?? "")),
					askJSON: async (instructions: unknown, hint?: unknown) => {
						const suffix = hint === undefined ? "" : `\n\nShape: ${typeof hint === "string" ? hint : JSON.stringify(hint)}`
						let last = ""
						for (let attempt = 0; attempt < 2; attempt++) {
							last = await askAgent(slot, `${String(instructions ?? "")}${suffix}`, "json")
							const candidate = extractJSON(last)
							if (candidate !== undefined) {
								try {
									return JSON.parse(candidate)
								} catch {
									// retry once with the parse failure attached
								}
							}
							if (attempt === 0) this.logLine(`${slot.info.name} did not return JSON; asking once more.`)
						}
						throw new Error(`Subagent "${slot.info.name}" did not return parseable JSON. Last reply: ${last.slice(0, 500)}`)
					},
				})
			},
			world: Object.freeze({
				run: async (command: unknown, args?: unknown, opts?: unknown) => {
					ensureAbort()
					const cmd = String(command ?? "")
					const argv = Array.isArray(args) ? args.map((value) => String(value)) : []
					const options = (opts ?? {}) as { timeoutMs?: number; output?: OutputOption }
					return runProcess(cmd, argv, {
						cwd: this.deps.directory,
						timeoutMs: typeof options.timeoutMs === "number" ? options.timeoutMs : undefined,
						output: options.output,
						signal: this.deps.signal,
					})
				},
			}),
			files: Object.freeze({
				glob: (pattern: unknown) => globFiles(this.deps.directory, [String(pattern ?? "")]),
				read: (path: unknown) => readText(this.deps.directory, String(path ?? "")),
				grep: (pattern: unknown, glob?: unknown) =>
					grepFiles(this.deps.directory, String(pattern ?? ""), glob === undefined ? undefined : String(glob)),
			}),
			git: Object.freeze({
				status: () => gitStatus(this.deps.directory),
				changedFiles: (base?: unknown) => gitChangedFiles(this.deps.directory, base === undefined ? undefined : String(base)),
				diff: (base?: unknown, path?: unknown) => gitDiff(this.deps.directory, base === undefined ? "HEAD" : String(base), path === undefined ? undefined : String(path)),
				log: (count?: unknown) => gitLog(this.deps.directory, Number(count) || 20),
			}),
			report: (item: unknown, artifactId?: unknown) => {
				ensureAbort()
				if (this.items.length < ITEM_LIMIT) this.items.push(item)
				if (artifactId !== undefined && !this.artifacts.report(item, String(artifactId))) {
					throw new Error(
						`report() was tagged with artifact "${String(artifactId)}", which has not been declared. Declare it with artifact.chart/table/metrics/board before reporting.`,
					)
				}
				update()
			},
			artifact: Object.freeze({
				markdown: (id: unknown, content: unknown, opts?: unknown) => {
					const value = this.artifacts.markdown(String(id ?? ""), String(content ?? ""), (opts ?? {}) as never)
					tagArtifact(id)
					return value
				},
				file: async (id: unknown, path: unknown, opts?: unknown) => {
					const absolute = workspacePath(String(path ?? ""))
					const info = await stat(absolute)
					if (!info.isFile()) throw new Error(`artifact.file: ${path} is not a file.`)
					const contentType = CONTENT_TYPES[extname(absolute).toLowerCase()]
					const value = this.artifacts.file(String(id ?? ""), String(path ?? ""), info.size, {
						...((opts ?? {}) as object),
						...(contentType ? { contentType } : {}),
					} as never)
					tagArtifact(id)
					return value
				},
				chart: (id: unknown, spec: unknown) => {
					const value = this.artifacts.chart(String(id ?? ""), spec as ChartSpec)
					tagArtifact(id)
					return value
				},
				table: (id: unknown, spec: unknown) => {
					const value = this.artifacts.table(String(id ?? ""), spec as TableSpec)
					tagArtifact(id)
					return value
				},
				metrics: (id: unknown, spec: unknown) => {
					const value = this.artifacts.metrics(String(id ?? ""), spec as MetricsSpec)
					tagArtifact(id)
					return value
				},
				board: (id: unknown, spec: unknown) => {
					const value = this.artifacts.board(String(id ?? ""), spec as BoardSpec)
					tagArtifact(id)
					return value
				},
			}),
			channel: (name?: unknown) => new AsyncQueue(String(name ?? "channel")),
			future: (body: unknown) => {
				if (typeof body !== "function") throw new Error("future() needs an async function.")
				return (body as () => Promise<unknown>)()
			},
			hole: () => {
				throw new Error(
					"hole() is not available in this host. Write the whole script, or finish with workflow_create and revise it with workflow_amend once the findings are in.",
				)
			},
		}

		return Object.freeze(facade)
	}

	// ---- snapshots ------------------------------------------------------

	views(): ArtifactView[] {
		return this.artifacts.views()
	}

	get current(): PhaseInfo[] {
		return this.phaseList
	}
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(new Error("The run was stopped."))
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const onAbort = () => rejectPromise(new Error("The run was stopped."))
		signal.addEventListener("abort", onAbort, { once: true })
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort)
				resolvePromise(value)
			},
			(error) => {
				signal.removeEventListener("abort", onAbort)
				rejectPromise(error)
			},
		)
	})
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new Error("The run was stopped."))
	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort)
			resolvePromise()
		}, ms)
		const onAbort = () => {
			clearTimeout(timer)
			rejectPromise(new Error("The run was stopped."))
		}
		signal.addEventListener("abort", onAbort, { once: true })
	})
}
