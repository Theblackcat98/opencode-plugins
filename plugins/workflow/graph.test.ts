import { describe, expect, test } from "bun:test"
import { charWidth, layoutGraph, renderChain, renderGraph, stringWidth, truncate } from "./graph.js"
import type { GraphPhase } from "./graph.js"

const linear: GraphPhase[] = [
	{ name: "Map the change", status: "done", detail: "14s" },
	{ name: "Review each file", status: "done", detail: "2 agents · 41s" },
	{ name: "Verify findings", status: "active", detail: "1 agent · 08s" },
	{ name: "Publish report", status: "pending" },
]

const edges = [
	{ from: 0, to: 1 },
	{ from: 1, to: 2 },
	{ from: 2, to: 3 },
]

function overlaps(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/** Character at a display column, so wide glyphs do not shift the check. */
function cellAt(row: string, column: number): string {
	let used = 0
	for (const char of row) {
		if (used === column) return char
		used += charWidth(char.codePointAt(0) ?? 0)
		if (used > column) return ""
	}
	return " "
}

describe("terminal width", () => {
	test("counts East Asian characters twice", () => {
		expect(stringWidth("abc")).toBe(3)
		expect(stringWidth("确认")).toBe(4)
		expect(stringWidth("a确b")).toBe(4)
		expect(stringWidth("✓")).toBe(1)
	})

	test("truncates on cell boundaries and marks the cut", () => {
		expect(truncate("abcdef", 4)).toBe("abc…")
		expect(truncate("确认测试", 5)).toBe("确认…")
		expect(truncate("short", 10)).toBe("short")
	})
})

describe("layoutGraph", () => {
	test("lays a linear workflow left to right with arrows", () => {
		const layout = layoutGraph(linear, edges, { width: 120, mode: "canvas", detail: true })
		expect(layout.mode).toBe("canvas")
		expect(layout.nodes).toHaveLength(4)
		for (let index = 1; index < layout.nodes.length; index++) {
			expect(layout.nodes[index].x).toBeGreaterThan(layout.nodes[index - 1].x + layout.nodes[index - 1].width)
		}
		const picture = renderGraph(layout)
		expect(picture).toContain("▶")
		expect(picture).toContain("✓")
		expect(picture).not.toContain("▼")
		expect(picture.split("\n").every((line) => stringWidth(line) <= layout.width)).toBe(true)
	})

	test("stacks a fan-out in one column without overlap", () => {
		const phases: GraphPhase[] = [
			{ name: "Survey", status: "done", detail: "6s" },
			{ name: "Read code", status: "done" },
			{ name: "Read tests", status: "done" },
			{ name: "Judgement", status: "active", detail: "1 agent" },
		]
		const layout = layoutGraph(
			phases,
			[
				{ from: 0, to: 1 },
				{ from: 0, to: 2 },
				{ from: 1, to: 3 },
				{ from: 2, to: 3 },
			],
			{ width: 110, mode: "canvas", detail: true },
		)
		expect(layout.nodes[1].x).toBe(layout.nodes[2].x)
		expect(layout.nodes[1].y).not.toBe(layout.nodes[2].y)
		for (let left = 0; left < layout.nodes.length; left++) {
			for (let right = left + 1; right < layout.nodes.length; right++) {
				expect(overlaps(layout.nodes[left], layout.nodes[right])).toBe(false)
			}
		}
	})

	test("routes a loop under the graph", () => {
		const layout = layoutGraph(
			[
				{ name: "Plan", status: "done" },
				{ name: "Fix", status: "active", detail: "round 2" },
				{ name: "Critique", status: "pending" },
			],
			[
				{ from: 0, to: 1 },
				{ from: 1, to: 2 },
				{ from: 2, to: 1 },
			],
			{ width: 100, mode: "canvas", detail: true },
		)
		const picture = renderGraph(layout)
		expect(picture).toContain("↺")
		expect(picture).toContain("▲")
		expect(layout.height).toBeGreaterThan(4)
	})

	test("falls back to a spine when the canvas does not fit", () => {
		const layout = layoutGraph(linear, edges, { width: 50, mode: "canvas", detail: true })
		expect(layout.mode).toBe("spine")
		expect(layout.nodes).toHaveLength(0)
		const picture = renderGraph(layout)
		expect(picture).toContain("Map the change")
		expect(picture).toContain("│")
		expect(picture).toContain("14s")
	})

	test("draws agent notes under the phase in the spine", () => {
		const layout = layoutGraph(
			[{ name: "Verify", status: "active", detail: "1 agent", notes: ["├ ✓ reviewer-api", "└ ▶ confirmer-api"] }],
			[],
			{ width: 48, mode: "spine" },
		)
		const picture = renderGraph(layout)
		expect(picture).toContain("reviewer-api")
		expect(picture).toContain("confirmer-api")
	})

	test("chooses a mode from the width", () => {
		expect(layoutGraph(linear, edges, { width: 30 }).mode).toBe("chain")
		expect(layoutGraph(linear, edges, { width: 40 }).mode).toBe("spine")
		expect(layoutGraph(linear, edges, { width: 140 }).mode).toBe("canvas")
	})

	test("renders a one-line chain for the footer", () => {
		const layout = layoutGraph(linear, edges, { width: 60, mode: "chain" })
		const chain = renderChain(layout)
		expect(chain).toContain("▶ Verify findings")
		expect(chain).toContain("Publish report")
		expect(chain).not.toContain("\n")
		expect(stringWidth(chain)).toBeLessThanOrEqual(60)
	})

	test("places node borders on their layout rectangles", () => {
		const layout = layoutGraph(linear, edges, { width: 140, mode: "canvas", detail: true })
		const rows = renderGraph(layout).split("\n")
		const edgesOnly = layout.edgeRows.map((row) => row.spans.map((span) => span.text).join(""))
		for (const node of layout.nodes) {
			expect(cellAt(rows[node.y], node.x)).toBe("╭")
			expect(cellAt(rows[node.y], node.x + node.width - 1)).toBe("╮")
			expect(cellAt(rows[node.y + node.height - 1], node.x)).toBe("╰")
			expect(cellAt(rows[node.y + node.height - 1], node.x + node.width - 1)).toBe("╯")
			expect(cellAt(edgesOnly[node.y] ?? "", node.x)).toBe(" ")
		}
	})

	test("keeps CJK node borders aligned", () => {
		const layout = layoutGraph(
			[
				{ name: "确认测试仍然通过", status: "done", detail: "3 个代理" },
				{ name: "发布报告", status: "active" },
			],
			[{ from: 0, to: 1 }],
			{ width: 100, mode: "canvas", detail: true },
		)
		const rows = renderGraph(layout).split("\n")
		expect(rows.every((row) => stringWidth(row) <= layout.width)).toBe(true)
		const node = layout.nodes[0]
		expect(stringWidth(rows[0])).toBe(node.x + node.width)
		expect(rows[1].startsWith("    │ ✓ 确认测试仍然通过 │")).toBe(true)
		expect(stringWidth("    │ ✓ 确认测试仍然通过 │")).toBe(node.x + node.width)
		expect(node.width).toBeGreaterThanOrEqual(20)
	})

	test("keeps the active phase when a chain overflows", () => {
		const phases = Array.from({ length: 8 }, (_, index): GraphPhase => ({
			name: `Phase number ${index + 1}`,
			status: index === 6 ? "active" : index < 6 ? "done" : "pending",
		}))
		const layout = layoutGraph(phases, [], { width: 40, mode: "chain" })
		const chain = renderChain(layout)
		expect(chain).toContain("▶ Phase number 7")
	})
})
