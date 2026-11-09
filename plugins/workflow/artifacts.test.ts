import { describe, expect, test } from "bun:test"
import { ArtifactStore } from "./artifacts.js"

describe("ArtifactStore", () => {
	test("feeds a chart from reported items and keeps the primary", () => {
		const store = new ArtifactStore()
		store.chart("perf", { title: "Latency", x: { field: "round" }, y: { field: "ms" } })
		store.markdown("report", "# Result", { primary: true })
		store.report({ round: 1, ms: 30 }, "perf")
		store.report({ round: 2, ms: 20 }, "perf")
		const views = store.views()
		const chart = views.find((view) => view.id === "perf")
		const report = views.find((view) => view.id === "report")
		expect(views[0].id).toBe("report")
		expect(report?.primary).toBe(true)
		expect(chart?.kind).toBe("chart")
		if (chart?.kind === "chart") expect(chart.points.length).toBe(2)
	})

	test("table rows with a key replace instead of appending", () => {
		const store = new ArtifactStore()
		store.table("items", { columns: [{ field: "path" }, { field: "status" }], key: "path" })
		store.report({ path: "a.ts", status: "todo" }, "items")
		store.report({ path: "b.ts", status: "todo" }, "items")
		store.report({ path: "a.ts", status: "done" }, "items")
		const view = store.views()[0]
		expect(view.kind).toBe("table")
		if (view.kind === "table") {
			expect(view.rows.length).toBe(2)
			expect(view.rows.find((row) => row.path === "a.ts")?.status).toBe("done")
		}
	})

	test("metrics keep the newest value per field", () => {
		const store = new ArtifactStore()
		store.metrics("m", { metrics: [{ field: "ms", unit: "ms" }] })
		store.report({ ms: 10 }, "m")
		store.report({ ms: 3 }, "m")
		const view = store.views()[0]
		expect(view.kind).toBe("metrics")
		if (view.kind === "metrics") expect(view.latest.ms).toBe(3)
	})

	test("board cards move between columns", () => {
		const store = new ArtifactStore()
		store.board("b", { key: "id", status: "state", columns: ["todo", "done"] })
		store.report({ id: "1", state: "todo", title: "one" }, "b")
		store.report({ id: "1", state: "done", title: "one" }, "b")
		const view = store.views()[0]
		expect(view.kind).toBe("board")
		if (view.kind === "board") {
			expect(view.cards.length).toBe(1)
			expect(view.cards[0].status).toBe("done")
		}
	})

	test("republishing markdown mints a version", () => {
		const store = new ArtifactStore()
		store.markdown("r", "one")
		store.markdown("r", "two")
		const view = store.views()[0]
		expect(view.kind).toBe("markdown")
		if (view.kind === "markdown") {
			expect(view.content).toBe("two")
			expect(view.version).toBe(2)
		}
	})

	test("reports an undeclared tag as a failure", () => {
		const store = new ArtifactStore()
		expect(store.report({ a: 1 }, "missing")).toBe(false)
		expect(store.report({ a: 1 })).toBe(true)
	})

	test("rejects a second kind on one id", () => {
		const store = new ArtifactStore()
		store.table("x", { columns: [{ field: "a" }] })
		expect(() => store.chart("x", { x: { field: "a" }, y: { field: "b" } })).toThrow()
	})
})
