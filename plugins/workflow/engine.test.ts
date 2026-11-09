import { describe, expect, test } from "bun:test"
import { RunEngine, type AskCache, type SubagentBackend } from "./engine.js"
import { buildScriptFunction } from "./compile.js"

function fakeBackend(options: { reply?: (text: string) => string; delay?: number } = {}) {
	const sessions: string[] = []
	const asks: string[] = []
	let created = 0
	let concurrent = 0
	let peak = 0
	const backend: SubagentBackend = {
		async create() {
			const id = `session-${++created}`
			sessions.push(id)
			return id
		},
		async ask(_sessionID, text) {
			asks.push(text)
			concurrent += 1
			peak = Math.max(peak, concurrent)
			try {
				if (options.delay) await new Promise((resolvePromise) => setTimeout(resolvePromise, options.delay))
				return options.reply ? options.reply(text) : `reply:${text}`
			} finally {
				concurrent -= 1
			}
		},
		async interrupt() {},
	}
	return { backend, sessions, asks, peak: () => peak }
}

describe("RunEngine", () => {
	test("runs a script, builds the phase graph and returns the value", async () => {
		const fake = fakeBackend()
		const updates: number[] = []
		const engine = new RunEngine(
			{ id: "wfr-1", name: "Test", script: "", args: { target: "src" } },
			{
				directory: process.cwd(),
				sessionID: "root",
				subagents: fake.backend,
				signal: new AbortController().signal,
				log: () => {},
				onUpdate: () => updates.push(1),
				maxConcurrency: 2,
			},
		)
		const script = `
phase("Plan")
const plan = await agent("planner").ask("make a plan for " + args.target)
phase("Work")
const a = await agent("worker-a").ask("do a")
const b = await agent("worker-b").ask("do b")
artifact.markdown("report", "# " + plan, { primary: true })
return { plan, a, b }
`
		const result = (await engine.execute(buildScriptFunction(script))) as Record<string, string>
		expect(result.plan).toBe("reply:make a plan for src")
		expect(fake.sessions.length).toBe(3)
		const snapshot = engine.snapshot()
		expect(snapshot.status).toBe("completed")
		expect(snapshot.phases.map((phase) => phase.name)).toEqual(["Plan", "Work"])
		expect(snapshot.edges.length).toBe(1)
		expect(snapshot.agents.length).toBe(3)
		expect(snapshot.artifacts[0].primary).toBe(true)
		expect(updates.length).toBeGreaterThan(0)
	})

	test("replays a cached ask without creating a session", async () => {
		const fake = fakeBackend()
		const cache = new Map<string, string>([["planner\u0000plan", "cached plan"]])
		const askCache: AskCache = { get: (key) => cache.get(key), set: (key, value) => void cache.set(key, value) }
		const engine = new RunEngine(
			{ id: "wfr-2", name: "Cache", script: "", args: {} },
			{
				directory: process.cwd(),
				sessionID: "root",
				subagents: fake.backend,
				signal: new AbortController().signal,
				log: () => {},
				onUpdate: () => {},
				cache: askCache,
			},
		)
		const result = (await engine.execute(buildScriptFunction(`phase("Plan")\nreturn await agent("planner").ask("plan")`))) as string
		expect(result).toBe("cached plan")
		expect(fake.sessions.length).toBe(0)
	})

	test("respects maxConcurrency", async () => {
		const fake = fakeBackend({ delay: 30 })
		const engine = new RunEngine(
			{ id: "wfr-3", name: "Limit", script: "", args: {} },
			{
				directory: process.cwd(),
				sessionID: "root",
				subagents: fake.backend,
				signal: new AbortController().signal,
				log: () => {},
				onUpdate: () => {},
				maxConcurrency: 2,
			},
		)
		const script = `
phase("Work")
await Promise.all([1,2,3,4,5].map((i) => agent("w" + i).ask("item " + i)))
return "done"
`
		await engine.execute(buildScriptFunction(script))
		expect(fake.peak()).toBeLessThanOrEqual(2)
	})

	test("records a failure and keeps a readable error", async () => {
		const fake = fakeBackend()
		const engine = new RunEngine(
			{ id: "wfr-4", name: "Fail", script: "", args: {} },
			{
				directory: process.cwd(),
				sessionID: "root",
				subagents: fake.backend,
				signal: new AbortController().signal,
				log: () => {},
				onUpdate: () => {},
			},
		)
		await expect(engine.execute(buildScriptFunction(`phase("Boom")\nthrow new Error("nope")`))).rejects.toThrow("nope")
		const snapshot = engine.snapshot()
		expect(snapshot.status).toBe("errored")
		expect(snapshot.error?.message).toBe("nope")
		expect(snapshot.phases[0].status).toBe("error")
	})

	test("an undeclared report tag fails the run", async () => {
		const fake = fakeBackend()
		const engine = new RunEngine(
			{ id: "wfr-6", name: "Tag", script: "", args: {} },
			{
				directory: process.cwd(),
				sessionID: "root",
				subagents: fake.backend,
				signal: new AbortController().signal,
				log: () => {},
				onUpdate: () => {},
			},
		)
		await expect(
			engine.execute(buildScriptFunction(`phase("Report")\nreport({ a: 1 }, "missing")\nreturn 1`)),
		).rejects.toThrow("has not been declared")
	})

	test("askJSON strips fences and parses the object", async () => {
		const fake = fakeBackend({ reply: () => "```json\n{\"holds\":true}\n```" })
		const engine = new RunEngine(
			{ id: "wfr-5", name: "JSON", script: "", args: {} },
			{
				directory: process.cwd(),
				sessionID: "root",
				subagents: fake.backend,
				signal: new AbortController().signal,
				log: () => {},
				onUpdate: () => {},
			},
		)
		const value = (await engine.execute(
			buildScriptFunction(`phase("Check")\nreturn await agent("judge").askJSON("decide", { holds: true })`),
		)) as Record<string, unknown>
		expect(value.holds).toBe(true)
	})
})
