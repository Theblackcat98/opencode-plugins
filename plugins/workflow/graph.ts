/**
 * Character-cell workflow graph.
 *
 * The TUI cannot use a DOM or React Flow, so the phase graph is translated to
 * a terminal grid: a layered layout (longest-path layering, barycentre
 * ordering), orthogonal edges with lane assignment, and box-drawing nodes.
 *
 * This module is deliberately framework-free. The server renders the same
 * layout as plain text for tool results; the TUI renders it twice — a blank
 * edge layer under absolutely positioned node boxes, and the full grid for
 * the narrow spine. The future GUI can reuse `nodes` and `edges` as SVG
 * rectangles and paths.
 */

import type { PhaseStatus } from "./types.js"

export type GraphRole = "text" | "muted" | "done" | "active" | "pending" | "error" | "line" | "loop"

export type GraphMode = "canvas" | "spine" | "chain"

export interface GraphPhase {
	readonly name: string
	readonly status: PhaseStatus
	readonly visits?: number
	/** Second line inside the node, and the right column in the spine. */
	readonly detail?: string
	/** Agent lines rendered under the node in the spine. */
	readonly notes?: readonly string[]
}

export interface GraphEdge {
	readonly from: number
	readonly to: number
}

export interface GraphOptions {
	readonly width: number
	readonly mode?: GraphMode | "auto"
	/** Draw the second line inside canvas nodes. */
	readonly detail?: boolean
	readonly maxNodeWidth?: number
}

export interface GraphSpan {
	readonly text: string
	readonly role: GraphRole
}

export interface GraphRow {
	readonly spans: readonly GraphSpan[]
}

export interface GraphNode {
	readonly index: number
	readonly x: number
	readonly y: number
	readonly width: number
	readonly height: number
	readonly lines: readonly (readonly GraphSpan[])[]
	readonly phase: GraphPhase
}

export interface GraphLayout {
	readonly mode: GraphMode
	readonly width: number
	readonly height: number
	/** Full picture, node borders included. */
	readonly rows: readonly GraphRow[]
	/** Edge-only picture; node rectangles are blank, for boxes drawn on top. */
	readonly edgeRows: readonly GraphRow[]
	readonly nodes: readonly GraphNode[]
}

interface Cell {
	ch: string
	role: GraphRole
}

type Grid = (Cell | undefined)[][]

const GLYPH: Record<PhaseStatus, string> = {
	done: "✓",
	active: "▶",
	pending: "·",
	error: "✗",
}

const ROLE_OF: Record<PhaseStatus, GraphRole> = {
	done: "done",
	active: "active",
	pending: "pending",
	error: "error",
}

const MIN_NODE_WIDTH = 12
const MAX_NODE_WIDTH = 30
const MARGIN_LEFT = 4
const GAP_X = 6
const LANE_LIMIT = 3

/** Display width of one code point: wide East Asian characters count 2, combining marks 0. */
export function charWidth(code: number): number {
	if (code === 0) return 0
	if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
	if (code >= 0x0300 && code <= 0x036f) return 0
	if (
		(code >= 0x1100 && code <= 0x115f) ||
		(code >= 0x2e80 && code <= 0x303e) ||
		(code >= 0x3041 && code <= 0x33ff) ||
		(code >= 0x3400 && code <= 0x4dbf) ||
		(code >= 0x4e00 && code <= 0x9fff) ||
		(code >= 0xa000 && code <= 0xa4cf) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff00 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x1f300 && code <= 0x1f64f) ||
		(code >= 0x1f900 && code <= 0x1f9ff) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) {
		return 2
	}
	return 1
}

export function stringWidth(text: string): number {
	let width = 0
	for (const char of text) width += charWidth(char.codePointAt(0) ?? 0)
	return width
}

/** Truncate to a display width, marking the cut with an ellipsis. */
export function truncate(text: string, width: number): string {
	if (width <= 0) return ""
	if (stringWidth(text) <= width) return text
	if (width === 1) return "…"
	let result = ""
	let used = 0
	for (const char of text) {
		const next = charWidth(char.codePointAt(0) ?? 0)
		if (used + next > width - 1) break
		result += char
		used += next
	}
	return `${result}…`
}

function padRight(text: string, width: number): string {
	const used = stringWidth(text)
	return used >= width ? truncate(text, width) : text + " ".repeat(width - used)
}

function glyph(phase: GraphPhase): string {
	return GLYPH[phase.status] ?? "·"
}

function badges(phase: GraphPhase, loopTarget: boolean): string {
	const parts: string[] = []
	if (loopTarget) parts.push("↺")
	if ((phase.visits ?? 0) > 1) parts.push(`×${phase.visits}`)
	return parts.length ? ` ${parts.join(" ")}` : ""
}

function nameLine(phase: GraphPhase, loopTarget: boolean): string {
	return `${glyph(phase)} ${phase.name}${badges(phase, loopTarget)}`
}

function nodeWidth(phase: GraphPhase, loopTarget: boolean, detail: boolean, maxNodeWidth: number): number {
	let widest = Math.max(MIN_NODE_WIDTH, stringWidth(nameLine(phase, loopTarget)) + 4)
	if (detail && phase.detail) widest = Math.max(widest, stringWidth(phase.detail) + 4)
	return Math.min(maxNodeWidth, widest)
}

// ---- grid ---------------------------------------------------------------

function createGrid(width: number, height: number): Grid {
	return Array.from({ length: height }, () => Array.from({ length: width }, () => undefined as Cell | undefined))
}

function setCell(grid: Grid, x: number, y: number, ch: string, role: GraphRole): void {
	if (y < 0 || y >= grid.length) return
	const row = grid[y]
	if (x < 0 || x >= row.length) return
	row[x] = { ch, role }
}

const LINE_MERGE: Record<string, string> = {
	"│─": "┼",
	"─│": "┼",
	"│┼": "┼",
	"─┼": "┼",
	"┼│": "┼",
	"┼─": "┼",
	"│┬": "┼",
	"─┬": "┼",
	"│┴": "┼",
	"─┴": "┼",
}

/** Draw a character, merging a line crossing into a junction instead of overwriting it. */
function drawCell(grid: Grid, x: number, y: number, ch: string, role: GraphRole): void {
	if (y < 0 || y >= grid.length) return
	const row = grid[y]
	if (x < 0 || x >= row.length) return
	const existing = row[x]
	if (!existing || existing.ch === " ") {
		row[x] = { ch, role }
		return
	}
	if (existing.ch === ch) return
	const merged = LINE_MERGE[`${existing.ch}${ch}`]
	if (merged) {
		row[x] = { ch: merged, role }
		return
	}
	row[x] = { ch, role }
}

function drawText(grid: Grid, x: number, y: number, text: string, role: GraphRole): void {
	let cursor = x
	for (const char of text) {
		const width = charWidth(char.codePointAt(0) ?? 0)
		if (width === 0) continue
		drawCell(grid, cursor, y, char, role)
		if (width === 2) setCell(grid, cursor + 1, y, "", role)
		cursor += width
	}
}

function drawVertical(grid: Grid, x: number, from: number, to: number, role: GraphRole): void {
	for (let y = from; y <= to; y++) drawCell(grid, x, y, "│", role)
}

function drawHorizontal(grid: Grid, y: number, from: number, to: number, role: GraphRole): void {
	for (let x = from; x <= to; x++) drawCell(grid, x, y, "─", role)
}

function drawBox(grid: Grid, node: GraphNode): void {
	const { x, y, width, height } = node
	const role = ROLE_OF[node.phase.status] ?? "line"
	drawCell(grid, x, y, "╭", role)
	drawCell(grid, x + width - 1, y, "╮", role)
	drawCell(grid, x, y + height - 1, "╰", role)
	drawCell(grid, x + width - 1, y + height - 1, "╯", role)
	drawHorizontal(grid, y, x + 1, x + width - 2, role)
	drawHorizontal(grid, y + height - 1, x + 1, x + width - 2, role)
	for (let row = y + 1; row < y + height - 1; row++) {
		drawCell(grid, x, row, "│", role)
		drawCell(grid, x + width - 1, row, "│", role)
	}
	node.lines.forEach((line, index) => {
		let cursor = x + 2
		for (const span of line) {
			drawText(grid, cursor, y + 1 + index, span.text, span.role)
			cursor += stringWidth(span.text)
		}
	})
}

function gridToRows(grid: Grid): GraphRow[] {
	return grid.map((row) => {
		let last = -1
		for (let index = 0; index < row.length; index++) if (row[index]) last = index
		const spans: GraphSpan[] = []
		for (let index = 0; index <= last; index++) {
			const cell = row[index]
			const text = cell?.ch ?? " "
			if (cell && text === "") continue
			const role = cell?.role ?? "line"
			const previous = spans[spans.length - 1]
			if (previous && previous.role === role) {
				spans[spans.length - 1] = { text: previous.text + text, role }
			} else {
				spans.push({ text, role })
			}
		}
		return { spans }
	})
}

function clearRect(grid: Grid, node: GraphNode): void {
	for (let row = node.y; row < node.y + node.height; row++) {
		for (let column = node.x; column < node.x + node.width; column++) setCell(grid, column, row, " ", "line")
	}
}

// ---- canvas -------------------------------------------------------------

interface Layer {
	readonly nodes: number[]
	readonly width: number
	readonly height: number
	top: number
	x: number
}

export function layoutGraph(
	phases: readonly GraphPhase[],
	edges: readonly GraphEdge[],
	options: GraphOptions,
): GraphLayout {
	const width = Math.max(12, Math.floor(options.width))
	const mode = chooseMode(width, options.mode ?? "auto", phases.length)
	if (mode === "chain") return chainLayout(phases, width)

	const loopTargets = new Set<number>()
	const backEdges: GraphEdge[] = []
	const forwardEdges: GraphEdge[] = []
	for (const edge of edges) {
		if (edge.from === edge.to || edge.from < 0 || edge.to < 0 || edge.from >= phases.length || edge.to >= phases.length) continue
		if (edge.to < edge.from) {
			loopTargets.add(edge.to)
			backEdges.push(edge)
		} else {
			forwardEdges.push(edge)
		}
	}

	if (mode === "spine") return spineLayout(phases, loopTargets, width)
	return canvasLayout(phases, forwardEdges, backEdges, loopTargets, width, options)
}

function chooseMode(width: number, requested: GraphMode | "auto", phaseCount: number): GraphMode {
	if (requested !== "auto") return requested
	if (width < 34) return "chain"
	if (width < 72 || phaseCount > 8) return "spine"
	return "canvas"
}

function canvasLayout(
	phases: readonly GraphPhase[],
	forwardEdges: readonly GraphEdge[],
	backEdges: readonly GraphEdge[],
	loopTargets: ReadonlySet<number>,
	width: number,
	options: GraphOptions,
): GraphLayout {
	if (phases.length === 0) return { mode: "spine", width, height: 0, rows: [], edgeRows: [], nodes: [] }
	const detail = options.detail ?? true
	const maxNodeWidth = options.maxNodeWidth ?? MAX_NODE_WIDTH

	// Longest-path layering over forward edges. Nodes are ordered by first visit,
	// so a forward edge always points from a lower index to a higher one.
	const layerOf = new Array<number>(phases.length).fill(0)
	const incoming = Array.from({ length: phases.length }, () => [] as GraphEdge[])
	for (const edge of forwardEdges) incoming[edge.to].push(edge)
	for (let index = 0; index < phases.length; index++) {
		for (const edge of incoming[index]) layerOf[index] = Math.max(layerOf[index], layerOf[edge.from] + 1)
	}

	const layerCount = Math.max(...layerOf) + 1
	const groups: number[][] = Array.from({ length: layerCount }, () => [])
	for (let index = 0; index < phases.length; index++) groups[layerOf[index]].push(index)

	orderLayers(groups, forwardEdges)

	const sizes = phases.map((phase, index) => {
		const nodeW = nodeWidth(phase, loopTargets.has(index), detail, maxNodeWidth)
		return { width: nodeW, height: detail && phase.detail ? 4 : 3 }
	})

	const layers: Layer[] = groups.map((nodes) => {
		const widths = nodes.map((index) => sizes[index].width)
		const heights = nodes.map((index) => sizes[index].height)
		return {
			nodes,
			width: Math.max(0, ...widths),
			height: heights.reduce((total, value) => total + value, 0) + Math.max(0, nodes.length - 1),
			top: 0,
			x: 0,
		}
	})

	// Fit or fall back to the spine.
	const gapX = GAP_X
	const total = MARGIN_LEFT + layers.reduce((sum, layer) => sum + layer.width, 0) + gapX * Math.max(0, layers.length - 1) + 1
	if (total > width) return spineLayout(phases, loopTargets, width)

	// Left-to-right columns; every layer is centred vertically.
	const contentHeight = Math.max(...layers.map((layer) => layer.height))
	for (const layer of layers) layer.top = Math.round((contentHeight - layer.height) / 2)
	let cursorX = MARGIN_LEFT
	for (const layer of layers) {
		layer.x = cursorX
		cursorX += layer.width + gapX
	}
	const loopLanes = Math.min(LANE_LIMIT, backEdges.length)
	const height = contentHeight + loopLanes

	const nodes: GraphNode[] = new Array(phases.length)
	for (const layer of layers) {
		let cursorY = layer.top
		for (const index of layer.nodes) {
			const size = sizes[index]
			const nodeX = layer.x + Math.floor((layer.width - size.width) / 2)
			const lines: GraphSpan[][] = []
			lines.push([
				{ text: `${glyph(phases[index])} `, role: ROLE_OF[phases[index].status] ?? "text" },
				{
					text: `${phases[index].name}${badges(phases[index], loopTargets.has(index))}`,
					role: "text",
				},
			])
			if (detail && phases[index].detail) lines.push([{ text: truncate(phases[index].detail ?? "", size.width - 4), role: "muted" }])
			nodes[index] = {
				index,
				x: nodeX,
				y: cursorY,
				width: size.width,
				height: size.height,
				lines,
				phase: phases[index],
			}
			cursorY += size.height + 1
		}
	}

	const grid = createGrid(width, height)
	drawEdges(grid, nodes, forwardEdges, backEdges, layerOf, layers, phases)
	const edgeGrid = grid.map((row) => row.map((cell) => (cell ? { ...cell } : undefined)))
	for (const node of nodes) {
		clearRect(edgeGrid, node)
		drawBox(grid, node)
	}

	return {
		mode: "canvas",
		width,
		height,
		rows: gridToRows(grid),
		edgeRows: gridToRows(edgeGrid),
		nodes,
	}
}

function orderLayers(groups: number[][], edges: readonly GraphEdge[]): void {
	if (groups.length < 2) return
	const predecessors = new Map<number, number[]>()
	const successors = new Map<number, number[]>()
	for (const edge of edges) {
		predecessors.set(edge.to, [...(predecessors.get(edge.to) ?? []), edge.from])
		successors.set(edge.from, [...(successors.get(edge.from) ?? []), edge.to])
	}
	const position = (): Map<number, number> => {
		const map = new Map<number, number>()
		for (const group of groups) group.forEach((index, offset) => map.set(index, offset))
		return map
	}
	const sortBy = (group: number[], reference: Map<number, number>, related: Map<number, number[]>): void => {
		const before = new Map(group.map((index) => [index, group.indexOf(index)]))
		group.sort((left, right) => {
			const leftLinks = related.get(left) ?? []
			const rightLinks = related.get(right) ?? []
			const average = (list: number[]): number =>
				list.length ? list.reduce((sum, value) => sum + (reference.get(value) ?? 0), 0) / list.length : 0
			const delta = average(leftLinks) - average(rightLinks)
			if (delta !== 0) return delta
			return (before.get(left) ?? 0) - (before.get(right) ?? 0)
		})
	}
	for (let pass = 0; pass < 2; pass++) {
		for (let index = 1; index < groups.length; index++) sortBy(groups[index], position(), predecessors)
		for (let index = groups.length - 2; index >= 0; index--) sortBy(groups[index], position(), successors)
	}
}

function edgesFromLayer(edges: readonly GraphEdge[], layerOf: readonly number[], layer: number): GraphEdge[] {
	return edges.filter((edge) => layerOf[edge.from] === layer)
}

function drawEdges(
	grid: Grid,
	nodes: readonly GraphNode[],
	forwardEdges: readonly GraphEdge[],
	backEdges: readonly GraphEdge[],
	layerOf: readonly number[],
	layers: readonly Layer[],
	phases: readonly GraphPhase[],
): void {
	const laneOf = new Map<GraphEdge, number>()
	const lanes = new Map<number, number>()
	for (const edge of forwardEdges) {
		const layer = layerOf[edge.from]
		const next = lanes.get(layer) ?? 0
		laneOf.set(edge, next % LANE_LIMIT)
		lanes.set(layer, next + 1)
	}

	for (const edge of forwardEdges) {
		const source = nodes[edge.from]
		const target = nodes[edge.to]
		if (!source || !target) continue
		const sx = source.x + source.width
		const sy = source.y + Math.floor(source.height / 2)
		const tx = target.x - 1
		const ty = target.y + Math.floor(target.height / 2)
		const lane = laneOf.get(edge) ?? 0
		const midX = layers[layerOf[edge.from]].x + layers[layerOf[edge.from]].width + 2 + lane
		const role: GraphRole = phases[edge.to]?.status === "active" ? "active" : "line"
		routeForward(grid, sx, sy, midX, tx, ty, role)
	}

	const contentHeight = Math.max(...layers.map((layer) => layer.top + layer.height))
	backEdges.forEach((edge, offset) => {
		const source = nodes[edge.from]
		const target = nodes[edge.to]
		if (!source || !target) return
		const sx = source.x + Math.floor(source.width / 2)
		const sy = source.y + source.height
		const tx = target.x + Math.floor(target.width / 2)
		const ty = target.y + target.height
		const lane = offset % LANE_LIMIT
		routeBack(grid, sx, sy, contentHeight + lane, tx, ty)
	})
}

function routeForward(grid: Grid, sx: number, sy: number, midX: number, tx: number, ty: number, role: GraphRole): void {
	if (tx <= sx || midX >= tx) return
	if (sy === ty) {
		drawHorizontal(grid, sy, sx, tx - 1, role)
		drawCell(grid, tx, ty, "▶", role)
		return
	}
	drawHorizontal(grid, sy, sx, midX - 1, role)
	drawCell(grid, midX, sy, sy < ty ? "╮" : "╯", role)
	drawVertical(grid, midX, sy + 1, ty - 1, role)
	drawCell(grid, midX, ty, sy < ty ? "╰" : "╭", role)
	drawHorizontal(grid, ty, midX + 1, tx - 1, role)
	drawCell(grid, tx, ty, "▶", role)
}

function routeBack(grid: Grid, sx: number, sy: number, busY: number, tx: number, ty: number): void {
	if (busY < sy) return
	drawVertical(grid, sx, sy, busY - 1, "loop")
	drawCell(grid, sx, busY, tx > sx ? "╰" : "╯", "loop")
	if (tx > sx) drawHorizontal(grid, busY, sx + 1, tx - 1, "loop")
	else drawHorizontal(grid, busY, tx + 1, sx - 1, "loop")
	drawCell(grid, tx, busY, tx > sx ? "╯" : "╰", "loop")
	if (busY - 1 >= ty + 1) drawVertical(grid, tx, ty + 1, busY - 1, "loop")
	drawCell(grid, tx, ty, "▲", "loop")
}

// ---- spine --------------------------------------------------------------

function spineLayout(phases: readonly GraphPhase[], loopTargets: ReadonlySet<number>, width: number): GraphLayout {
	const rows: GraphRow[] = []
	phases.forEach((phase, index) => {
		const status = ROLE_OF[phase.status] ?? "text"
		const prefix = `${glyph(phase)} ${String(index + 1).padStart(2)}  `
		const badgesText = badges(phase, loopTargets.has(index))
		const nameRoom = Math.max(4, width - stringWidth(prefix) - stringWidth(badgesText) - (phase.detail ? 12 : 0))
		const name = truncate(phase.name, nameRoom)
		const left = `${prefix}${name}${badgesText}`
		const spans: GraphSpan[] = [
			{ text: `${glyph(phase)} `, role: status },
			{ text: `${String(index + 1).padStart(2)}  `, role: "muted" },
			{ text: `${name}${badgesText}`, role: "text" },
		]
		if (phase.detail) {
			const used = stringWidth(left)
			const room = width - used
			if (room > 4) {
				const detail = truncate(phase.detail, room)
				spans.push({ text: " ".repeat(room - stringWidth(detail)), role: "muted" }, { text: detail, role: "muted" })
			}
		}
		rows.push({ spans })
		for (const note of phase.notes ?? []) {
			rows.push({ spans: [{ text: `  │   ${truncate(note, Math.max(4, width - 6))}`, role: "muted" }] })
		}
		if (index < phases.length - 1) rows.push({ spans: [{ text: "  │", role: "line" }] })
	})
	return { mode: "spine", width, height: rows.length, rows, edgeRows: rows, nodes: [] }
}

// ---- chain --------------------------------------------------------------

function chainLayout(phases: readonly GraphPhase[], width: number): GraphLayout {
	if (phases.length === 0) {
		return { mode: "chain", width, height: 1, rows: [{ spans: [{ text: "no phases", role: "muted" }] }], edgeRows: [], nodes: [] }
	}
	const parts: GraphSpan[] = []
	const room = Math.max(8, width)
	let used = 0
	// The active phase is the one the reader needs; build forward from it first.
	const activeIndex = phases.findIndex((phase) => phase.status === "active")
	const focus = activeIndex >= 0 ? activeIndex : 0
	for (let index = focus; index < phases.length; index++) {
		const name = truncate(phases[index].name, 16)
		const separator = parts.length ? " ─ " : ""
		const cost = stringWidth(separator) + stringWidth(glyph(phases[index])) + 1 + stringWidth(name)
		if (used + cost > room) {
			if (!parts.length) {
				const short = truncate(name, Math.max(4, room - 2))
				parts.push({ text: `${glyph(phases[index])} `, role: ROLE_OF[phases[index].status] ?? "text" }, { text: short, role: "text" })
				used += stringWidth(glyph(phases[index])) + 1 + stringWidth(short)
			}
			break
		}
		if (separator) parts.push({ text: separator, role: "line" })
		parts.push({ text: `${glyph(phases[index])} `, role: ROLE_OF[phases[index].status] ?? "text" }, { text: name, role: "text" })
		used += cost
	}
	let earliest = focus
	for (let index = focus - 1; index >= 0; index--) {
		const name = truncate(phases[index].name, 12)
		const cost = 3 + stringWidth(glyph(phases[index])) + 1 + stringWidth(name) + (index > 0 ? 2 : 0)
		if (used + cost > room) break
		parts.unshift({ text: " ─ ", role: "line" }, { text: `${glyph(phases[index])} `, role: ROLE_OF[phases[index].status] ?? "text" }, { text: name, role: "text" })
		used += cost
		earliest = index
	}
	if (earliest > 0) parts.unshift({ text: "…", role: "muted" })
	return { mode: "chain", width, height: 1, rows: [{ spans: parts }], edgeRows: [], nodes: [] }
}

/** Plain-text rendering, used by tool results and tests. */
export function renderGraph(layout: GraphLayout): string {
	return layout.rows
		.map((row) => row.spans.map((span) => span.text).join(""))
		.join("\n")
}

/** One-line chain for the prompt footer. */
export function renderChain(layout: GraphLayout): string {
	const row = layout.rows[0]
	return row ? row.spans.map((span) => span.text).join("") : ""
}
