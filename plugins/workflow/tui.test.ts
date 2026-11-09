import { describe, expect, test } from "bun:test"
import { artifactLines, entriesOf, isRunSummary, sparkline, unwrap } from "./tui.js"
import type { ArtifactView, RunSummary } from "./types.js"

const summary: RunSummary = {
	id: "wfr-1",
	name: "Review",
	status: "running",
	sessionID: "ses-1",
	directory: "/tmp/project",
	createdAt: 1,
	updatedAt: 2,
	phaseCount: 3,
	phasesDone: 1,
	agentCount: 2,
	artifactCount: 1,
}

describe("tui helpers", () => {
	test("unwrap reads both raw and { data } results", () => {
		expect(unwrap<{ entries: unknown[] }>({ entries: [] })).toEqual({ entries: [] })
		expect(unwrap<{ entries: unknown[] }>({ data: { entries: [] } })).toEqual({ entries: [] })
	})

	test("entriesOf filters malformed entries", () => {
		expect(entriesOf({ data: { entries: [summary, { nope: true }] } })).toHaveLength(1)
		expect(entriesOf(null)).toEqual([])
	})

	test("isRunSummary requires id and status", () => {
		expect(isRunSummary(summary)).toBe(true)
		expect(isRunSummary({ id: "x" })).toBe(false)
	})

	test("sparkline uses block glyphs and survives a flat series", () => {
		const points = [{ v: 1 }, { v: 2 }, { v: 3 }]
		expect(sparkline(points, "v")).toHaveLength(3)
		expect(sparkline([{ v: 5 }, { v: 5 }], "v")).toBe("▅▅")
		expect(sparkline([], "v")).toBe("")
	})

	test("chart and table artifacts render lines", () => {
		const chart: ArtifactView = {
			kind: "chart",
			id: "perf",
			title: "Latency",
			version: 1,
			type: "line",
			x: { field: "round" },
			y: [{ field: "ms" }],
			scale: "linear",
			points: [{ round: 1, ms: 30 }, { round: 2, ms: 20 }],
		}
		expect(artifactLines(chart).length).toBeGreaterThan(1)

		const table: ArtifactView = {
			kind: "table",
			id: "rows",
			title: "Rows",
			version: 1,
			columns: [{ field: "path" }, { field: "status" }],
			rows: [{ path: "a.ts", status: "done" }],
		}
		const lines = artifactLines(table)
		expect(lines[0]).toContain("path | status")
		expect(lines[1]).toContain("a.ts | done")
	})

	test("board groups cards by column", () => {
		const board: ArtifactView = {
			kind: "board",
			id: "b",
			title: "Board",
			version: 1,
			columns: ["todo", "done"],
			cards: [
				{ key: "1", title: "one", status: "todo", detail: {} },
				{ key: "2", title: "two", status: "done", detail: {} },
			],
		}
		const lines = artifactLines(board)
		expect(lines[0]).toBe("todo (1)")
		expect(lines).toContain("  · one")
	})
})
