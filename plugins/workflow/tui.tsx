/**
 * Workflow TUI plugin (OpenCode V2)
 *
 * The server half owns runs and announces transitions over RPC. This half
 * renders them: a phase graph (canvas in fullscreen, spine in the side panel),
 * a prompt-footer chain, a sidebar card, artifact cards and toasts.
 *
 * Recovery: RPC event subscriptions are live-only, so setup polls listRuns
 * once and lazily fetches snapshots for runs that started before this terminal
 * attached.
 *
 * NOTE: keymap.layer() needs a Solid owner. It is called from the mounted
 * `app` slot component, never from setup().
 */

import type { RGBA } from "@opentui/core"
import { For, Show, createEffect, createMemo, createSignal, onCleanup, type JSX } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { layoutGraph, stringWidth, truncate, type GraphPhase, type GraphRole } from "./graph.js"
import { WorkflowRpc } from "./rpc.js"
import type { ArtifactView, PhaseInfo, RunError, RunSnapshot, RunSummary } from "./types.js"

const PANEL_NAME = "workflow.run"
const SNAPSHOT_LIMIT = 8
const CHAIN_WIDTH = 64

export function unwrap<T>(value: unknown): T | undefined {
	if (!value || typeof value !== "object") return undefined
	const record = value as Record<string, unknown>
	if ("data" in record) return record.data as T
	return value as T
}

export function entriesOf(value: unknown): RunSummary[] {
	const data = unwrap<{ entries?: unknown }>(value)
	const entries = data?.entries
	if (!Array.isArray(entries)) return []
	return entries.filter((entry): entry is RunSummary => !!entry && typeof entry === "object" && typeof (entry as RunSummary).id === "string")
}

export function isRunSummary(value: unknown): value is RunSummary {
	return !!value && typeof value === "object" && typeof (value as RunSummary).id === "string" && typeof (value as RunSummary).status === "string"
}

export function isSnapshot(value: unknown): value is RunSnapshot {
	return isRunSummary(value) && Array.isArray((value as RunSnapshot).phases)
}

const STATUS_GLYPH: Record<string, string> = {
	done: "✓",
	active: "▶",
	pending: "·",
	error: "✗",
	running: "▶",
	completed: "✓",
	errored: "✗",
	stopped: "■",
	queued: "·",
}

function glyph(status: string): string {
	return STATUS_GLYPH[status] ?? "·"
}

function formatMoney(value: number): string {
	return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(value / 1024))} KB`
}

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000))
	const minutes = Math.floor(total / 60)
	const seconds = total % 60
	return minutes ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`
}

function phaseDetail(phase: PhaseInfo): string | undefined {
	const parts: string[] = []
	if (phase.agentCount) parts.push(`${phase.agentCount} agent${phase.agentCount === 1 ? "" : "s"}`)
	if (phase.askCount) parts.push(`${phase.askCount} ask${phase.askCount === 1 ? "" : "s"}`)
	const ended = phase.endedAt ?? (phase.status === "active" ? Date.now() : undefined)
	if (phase.startedAt && ended && ended > phase.startedAt) parts.push(formatDuration(ended - phase.startedAt))
	return parts.length ? parts.join(" · ") : undefined
}

export function graphPhases(run: RunSnapshot): GraphPhase[] {
	return run.phases.map((phase) => ({
		name: phase.name,
		status: phase.status,
		visits: phase.visits,
		detail: phaseDetail(phase),
	}))
}

/** Coloured inline run. `span` has no `fg` in its published JSX types, though the renderable accepts it. */
function Tint(props: { fg: RGBA; children?: JSX.Element }) {
	return <span {...({ fg: props.fg } as Record<string, unknown>)}>{props.children}</span>
}

type TextTheme = {
	readonly base: RGBA
	readonly muted: RGBA
	readonly feedback: Readonly<Record<"info" | "success" | "warning" | "error", { readonly base: RGBA; readonly muted: RGBA }>>
}

export function roleColor(theme: TextTheme, role: GraphRole): RGBA {
	if (role === "done") return theme.feedback.success.base
	if (role === "active") return theme.feedback.info.base
	if (role === "error") return theme.feedback.error.base
	if (role === "loop") return theme.feedback.warning.base
	if (role === "text") return theme.base
	return theme.muted
}

function fieldValue(row: Record<string, unknown>, field: string): unknown {
	if (field in row) return row[field]
	let current: unknown = row
	for (const part of field.split(".")) {
		if (!current || typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function formatValue(value: unknown): string {
	if (value === undefined || value === null) return "—"
	if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(2)
	if (typeof value === "boolean") return value ? "yes" : "no"
	if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 60)}…` : value
	return JSON.stringify(value).slice(0, 60)
}

/** Seven-level sparkline; enough to show a trend in a terminal. */
export function sparkline(points: readonly Record<string, unknown>[], field: string): string {
	const blocks = "▁▂▃▄▅▆▇█"
	const values = points.map((point) => Number(fieldValue(point, field))).filter((value) => Number.isFinite(value))
	if (!values.length) return ""
	const min = Math.min(...values)
	const max = Math.max(...values)
	if (max === min) return blocks[4].repeat(values.length)
	return values
		.map((value) => blocks[Math.min(blocks.length - 1, Math.max(0, Math.round(((value - min) / (max - min)) * (blocks.length - 1))))])
		.join("")
}

export function artifactLines(artifact: ArtifactView, width = 60): string[] {
	if (artifact.kind === "markdown") {
		return artifact.content.split("\n").slice(0, 14).map((line) => (line.length > width ? `${line.slice(0, width)}…` : line))
	}
	if (artifact.kind === "file") {
		return [`${artifact.path} (${formatMoney(artifact.size)})`]
	}
	if (artifact.kind === "chart") {
		const series = artifact.y[0]?.field ?? "y"
		const bar = sparkline(artifact.points, series)
		const last = artifact.points[artifact.points.length - 1]
		return [
			`${artifact.type} · ${artifact.x.label ?? artifact.x.field} → ${artifact.y.map((field) => field.label ?? field.field).join(", ")}`,
			bar || "(no points yet)",
			last ? `latest ${formatValue(fieldValue(last, series))}` : "",
		].filter(Boolean)
	}
	if (artifact.kind === "table") {
		const header = artifact.columns.map((column) => column.label ?? column.field).join(" | ")
		const rows = artifact.rows
			.slice(-8)
			.map((row) => artifact.columns.map((column) => formatValue(fieldValue(row, column.field))).join(" | "))
		return [header, ...rows, artifact.rows.length > 8 ? `… ${artifact.rows.length - 8} more` : ""].filter(Boolean)
	}
	if (artifact.kind === "metrics") {
		return artifact.metrics.map((metric) => `${metric.label ?? metric.field}: ${formatValue(artifact.latest[metric.field])}${metric.unit ? ` ${metric.unit}` : ""}`)
	}
	const lines: string[] = []
	for (const column of artifact.columns) {
		const cards = artifact.cards.filter((card) => card.status === column)
		lines.push(`${column} (${cards.length})`)
		for (const card of cards.slice(0, 3)) lines.push(`  · ${card.title}`)
	}
	const other = artifact.cards.filter((card) => !artifact.columns.includes(card.status))
	if (other.length) lines.push(`other (${other.length})`, ...other.slice(0, 3).map((card) => `  · ${card.title}`))
	return lines
}

/** Long form for the artifact dialog. */
export function artifactText(artifact: ArtifactView): string {
	if (artifact.kind === "markdown") return artifact.content
	if (artifact.kind === "file") return `${artifact.path}\n${formatMoney(artifact.size)}${artifact.contentType ? ` · ${artifact.contentType}` : ""}`
	if (artifact.kind === "table") {
		const header = artifact.columns.map((column) => column.label ?? column.field).join(" | ")
		const rows = artifact.rows.map((row) => artifact.columns.map((column) => formatValue(fieldValue(row, column.field))).join(" | "))
		return [header, ...rows].join("\n")
	}
	if (artifact.kind === "chart") {
		const series = artifact.y[0]?.field ?? "y"
		return [
			`${artifact.type} · ${artifact.x.label ?? artifact.x.field} → ${artifact.y.map((field) => field.label ?? field.field).join(", ")}`,
			sparkline(artifact.points, series),
			...artifact.points.map((point) =>
				artifact.y.map((field) => `${point[artifact.x.field] ?? "?"}: ${formatValue(fieldValue(point, field.field))}`).join("  "),
			),
		].join("\n")
	}
	if (artifact.kind === "metrics") {
		return artifact.metrics.map((metric) => `${metric.label ?? metric.field}: ${formatValue(artifact.latest[metric.field])}${metric.unit ? ` ${metric.unit}` : ""}`).join("\n")
	}
	return artifactLines(artifact, 100).join("\n")
}

type PanelInput = {
	readonly name: string
	readonly sessionID: string
	readonly width: number
	readonly presentation: "panel" | "fullscreen"
	readonly focused: boolean
	readonly focus: () => void
	readonly close: () => void
	readonly toggleFullscreen: () => void
}

type PhaseSelection = { readonly runID: string; readonly index: number } | undefined

export default Plugin.define({
	id: "workflow.tui",
	async setup(context) {
		const rpc = context.client.rpc(WorkflowRpc)
		const directory = context.location?.directory
		const [runs, setRuns] = context.storage.memory("workflow-runs", { initial: { entries: [] as RunSummary[] } })
		const [selected, setSelected] = createSignal<string | undefined>(undefined)
		const [snapshots, setSnapshots] = createSignal<Record<string, RunSnapshot>>({})
		const [ancestry, setAncestry] = createSignal<PhaseSelection>(undefined)
		const [panel, setPanel] = createSignal<{ sessionID: string; focused: boolean; toggle: () => void } | undefined>(undefined)
		const [lastFinished, setLastFinished] = context.storage.memory("workflow-last-finished", {
			initial: { id: "", status: "" },
		})

		const sameDirectory = (event: { location?: { directory?: string } }): boolean => {
			const eventDirectory = event.location?.directory
			return !directory || !eventDirectory || eventDirectory === directory
		}

		const upsert = (summary: RunSummary): void => {
			setRuns((draft) => {
				const index = draft.entries.findIndex((entry) => entry.id === summary.id)
				if (index === -1) draft.entries.push({ ...summary })
				else draft.entries[index] = { ...summary }
			})
		}

		const refreshRuns = async (): Promise<void> => {
			try {
				const result = await rpc.listRuns({})
				const entries = entriesOf(result)
				setRuns((draft) => {
					draft.entries = entries
				})
			} catch (error) {
				console.error(`[workflow.tui] listRuns failed:`, error)
			}
		}

		const remember = (snapshot: RunSnapshot): void => {
			setSnapshots((previous) => {
				const next = { ...previous, [snapshot.id]: snapshot }
				const ordered = Object.keys(next).sort((left, right) => (next[left]?.createdAt ?? 0) - (next[right]?.createdAt ?? 0))
				for (const id of ordered.slice(0, Math.max(0, ordered.length - SNAPSHOT_LIMIT))) delete next[id]
				return next
			})
		}

		const pending = new Set<string>()
		const loadDetail = async (runID: string): Promise<void> => {
			if (pending.has(runID)) return
			pending.add(runID)
			try {
				const result = await rpc.getRun({ runID })
				const data = unwrap<{ run?: unknown }>(result)
				const snapshot = data?.run
				if (isSnapshot(snapshot)) remember(snapshot)
			} catch (error) {
				console.error(`[workflow.tui] getRun failed:`, error)
			} finally {
				pending.delete(runID)
			}
		}

		let detailTimer: ReturnType<typeof setTimeout> | undefined
		const refreshDetail = (runID: string | undefined, immediate = false): void => {
			if (!runID) return
			if (immediate) {
				if (detailTimer) clearTimeout(detailTimer)
				void loadDetail(runID)
				return
			}
			if (detailTimer) return
			detailTimer = setTimeout(() => {
				detailTimer = undefined
				void loadDetail(runID)
			}, 200)
		}

		const sorted = (): RunSummary[] => [...runs.entries].sort((left, right) => right.createdAt - left.createdAt)

		const newest = (sessionID?: string): RunSummary | undefined => {
			if (sessionID) return sorted().find((entry) => entry.sessionID === sessionID)
			return sorted()[0]
		}

		const forSession = (sessionID?: string): RunSummary | undefined => {
			if (selected()) {
				const hit = sorted().find((entry) => entry.id === selected())
				if (hit) return hit
			}
			return newest(sessionID)
		}

		const snapshotOf = (runID: string | undefined): RunSnapshot | undefined => {
			if (!runID) return undefined
			return snapshots()[runID]
		}

		const ensureSnapshot = (runID: string | undefined): void => {
			if (!runID || snapshotOf(runID)) return
			refreshDetail(runID)
		}

		const phaseIndex = (snapshot: RunSnapshot): number => {
			const choice = ancestry()
			if (choice && choice.runID === snapshot.id && choice.index < snapshot.phases.length) return choice.index
			if (snapshot.currentPhase !== undefined) return snapshot.currentPhase
			const active = snapshot.phases.findIndex((phase) => phase.status === "active")
			if (active !== -1) return active
			return Math.max(0, snapshot.phases.length - 1)
		}

		const panelRun = (): RunSummary | undefined => {
			const input = panel()
			const run = forSession(input?.sessionID)
			if (run) return run
			return newest(input?.sessionID)
		}

		const stepSelection = (delta: number): void => {
			const run = panelRun()
			const snapshot = snapshotOf(run?.id)
			if (!snapshot || !snapshot.phases.length) return
			const current = phaseIndex(snapshot)
			const next = Math.max(0, Math.min(snapshot.phases.length - 1, current + delta))
			setAncestry({ runID: snapshot.id, index: next })
		}

		const openArtifact = (): void => {
			const run = panelRun()
			const snapshot = snapshotOf(run?.id)
			if (!snapshot) return
			const index = phaseIndex(snapshot)
			const artifact =
				snapshot.artifacts.find((entry) => entry.phase === index && entry.primary) ??
				snapshot.artifacts.find((entry) => entry.phase === index) ??
				snapshot.artifacts.find((entry) => entry.primary) ??
				snapshot.artifacts[0]
			if (!artifact) {
				context.ui.toast.show({ title: "Workflow", message: "This run has no artifacts yet.", variant: "info" })
				return
			}
			context.ui.dialog.show(() => <ArtifactDialog artifact={artifact} theme={context.theme.text} />)
			context.ui.dialog.set({ size: "large" })
		}

		const unsubscribes: Array<() => void> = [
			rpc.events.on("updated", (event) => {
				if (!sameDirectory(event) || !isRunSummary(event.data)) return
				upsert(event.data)
				const summary = event.data
				if (selected() === summary.id || newest(summary.sessionID)?.id === summary.id) {
					if (snapshotOf(summary.id)) refreshDetail(summary.id)
					else ensureSnapshot(summary.id)
				}
			}),
			rpc.events.on("finished", (event) => {
				if (!sameDirectory(event) || !isRunSummary(event.data)) return
				const summary = event.data
				upsert(summary)
				if (summary.id === selected() || summary.id === newest(summary.sessionID)?.id) refreshDetail(summary.id, true)
				if (lastFinished.id === summary.id && lastFinished.status === summary.status) return
				void setLastFinished((draft) => {
					draft.id = summary.id
					draft.status = summary.status
				})
				const success = summary.status === "completed"
				context.ui.toast.show({
					title: success ? "Workflow completed" : summary.status === "stopped" ? "Workflow stopped" : "Workflow failed",
					message: `${summary.name} · ${summary.phasesDone}/${summary.phaseCount} phases${summary.error ? `\n${summary.error.message}` : ""}`,
					variant: success ? "success" : summary.status === "stopped" ? "warning" : "error",
					sessionID: summary.sessionID,
				})
				if (!success) {
					void context.attention
						.notify({ title: `Workflow ${summary.status}`, message: summary.name })
						.catch((error) => console.error(`[workflow.tui] notify failed:`, error))
				}
			}),
		]

		void refreshRuns()

		const WorkflowCard = (props: { sessionID: string }) => {
			const ctx = usePlugin()
			const run = () => newest(props.sessionID)
			const snapshot = () => snapshotOf(run()?.id)
			createEffect(() => {
				const current = run()
				if (current && (current.status === "running" || current.status === "queued")) ensureSnapshot(current.id)
			})
			return (
				<Show when={run()}>
					{(entry: () => RunSummary) => (
						<box flexDirection="column" onMouseDown={() => ctx.ui.panel.open(PANEL_NAME)}>
							<text fg={ctx.theme.text.base}>
								{glyph(entry().status)} {entry().name}
							</text>
							<text fg={ctx.theme.text.muted}>
								{entry().status} · {entry().phasesDone}/{entry().phaseCount} phases · {entry().agentCount} agents
							</text>
							<Show when={snapshot()}>
								{(snap: () => RunSnapshot) => (
									<box flexDirection="column">
										<For each={snap().phases.slice(0, 4)}>
											{(phase, index) => (
												<text fg={phase.status === "active" ? ctx.theme.text.base : ctx.theme.text.muted}>
													{phaseIndex(snap()) === index() ? "▸ " : "  "}
													{glyph(phase.status)} {truncate(phase.name, 24)}
												</text>
											)}
										</For>
										<Show when={snap().phases.length > 4}>
											<text fg={ctx.theme.text.muted}>… {snap().phases.length - 4} more</text>
										</Show>
									</box>
								)}
							</Show>
						</box>
					)}
				</Show>
			)
		}

		const WorkflowDot = (props: { sessionID?: string }) => {
			const ctx = usePlugin()
			const run = () => (props.sessionID ? newest(props.sessionID) : undefined)
			const snapshot = () => snapshotOf(run()?.id)
			const live = () => run()?.status === "running" || run()?.status === "queued"
			const chain = createMemo(() => {
				const snap = snapshot()
				if (!snap || !snap.phases.length) return []
				const layout = layoutGraph(graphPhases(snap), snap.edges, { width: CHAIN_WIDTH, mode: "chain" })
				return layout.rows[0]?.spans ?? []
			})
			createEffect(() => {
				const current = run()
				if (current && live()) ensureSnapshot(current.id)
			})
			return (
				<Show when={live()}>
					<text>
						<Tint fg={ctx.theme.text.muted}>WF </Tint>
						<Show
							when={chain().length}
							fallback={
								<Tint fg={ctx.theme.text.muted}>
									{run()?.phasesDone}/{run()?.phaseCount}
								</Tint>
							}
						>
							<For each={chain()}>{(span) => <Tint fg={roleColor(ctx.theme.text, span.role)}>{span.text}</Tint>}</For>
						</Show>
					</text>
				</Show>
			)
		}

		const PhaseList = (props: { run: RunSnapshot; selected: number; width: number; onSelect: (index: number) => void }) => {
			const ctx = usePlugin()
			return (
				<box flexDirection="column">
					<For each={props.run.phases}>
						{(phase, index) => {
							const name = () => truncate(phase.name, Math.max(8, props.width - 16))
							const detail = () => phaseDetail(phase)
							const prefix = () => `${index() === props.selected ? "▸ " : "  "}${glyph(phase.status)} ${String(index() + 1).padStart(2)}  `
							const label = () => `${prefix()}${name()}${phase.visits > 1 ? ` ×${phase.visits}` : ""}`
							const pad = () => Math.max(1, props.width - stringWidth(label()) - (detail() ? stringWidth(detail() ?? "") : 0))
							return (
							<box flexDirection="column">
								<text onMouseDown={() => props.onSelect(index())}>
									<Tint fg={index() === props.selected ? ctx.theme.text.base : ctx.theme.text.muted}>{index() === props.selected ? "▸ " : "  "}</Tint>
									<Tint fg={roleColor(ctx.theme.text, phase.status)}>{glyph(phase.status)} </Tint>
									<Tint fg={ctx.theme.text.muted}>{String(index() + 1).padStart(2)}  </Tint>
									<Tint fg={index() === props.selected ? ctx.theme.text.base : ctx.theme.text.muted}>
										{name()}
										{phase.visits > 1 ? ` ×${phase.visits}` : ""}
									</Tint>
									<Show when={detail()}>
										{(value: () => string) => (
											<Tint fg={ctx.theme.text.muted}>
												{" ".repeat(pad())}
												{truncate(value(), Math.max(4, props.width - stringWidth(prefix()) - 2))}
											</Tint>
										)}
									</Show>
								</text>
								<Show when={index() === props.selected}>
									<For each={props.run.agents.filter((agent) => agent.phase === index())}>
										{(agent) => (
											<text fg={ctx.theme.text.muted}>
												{"      "}
												{glyph(agent.status)} {truncate(agent.name, 18)} · {agent.asks} asks
											</text>
										)}
									</For>
								</Show>
								<Show when={index() < props.run.phases.length - 1}>
									<text fg={ctx.theme.text.muted}>  │</text>
								</Show>
							</box>
							)
						}}
					</For>
				</box>
			)
		}

		const GraphCanvas = (props: { run: RunSnapshot; width: number; selected: number; onSelect: (index: number) => void; animated: boolean }) => {
			const ctx = usePlugin()
			const [beat, setBeat] = createSignal(false)
			createEffect(() => {
				if (!props.animated) {
					setBeat(false)
					return
				}
				const timer = setInterval(() => setBeat((value) => !value), 700)
				onCleanup(() => clearInterval(timer))
			})
			const layout = createMemo(() => layoutGraph(graphPhases(props.run), props.run.edges, { width: props.width, mode: "canvas", detail: true }))
			const border = (status: string, selected: boolean): RGBA => {
				if (selected) return ctx.theme.text.base
				if (status === "done") return ctx.theme.text.feedback.success.base
				if (status === "error") return ctx.theme.text.feedback.error.base
				if (status === "active") return beat() ? ctx.theme.text.feedback.info.muted : ctx.theme.text.feedback.info.base
				return ctx.theme.text.muted
			}
			return (
				<Show
					when={layout().mode === "canvas"}
					fallback={<PhaseList run={props.run} selected={props.selected} width={props.width} onSelect={props.onSelect} />}
				>
					<box position="relative" width={layout().width} height={layout().height} flexShrink={0}>
						<For each={layout().edgeRows}>
							{(row, rowIndex) => (
								<text position="absolute" left={0} top={rowIndex()} wrapMode="none">
									<For each={row.spans}>{(span) => <Tint fg={roleColor(ctx.theme.text, span.role)}>{span.text}</Tint>}</For>
								</text>
							)}
						</For>
						<For each={layout().nodes}>
							{(node) => (
								<box
									position="absolute"
									left={node.x}
									top={node.y}
									width={node.width}
									height={node.height}
									zIndex={1}
									border
									borderStyle="rounded"
									borderColor={border(node.phase.status, node.index === props.selected)}
									backgroundColor={ctx.theme.background.raised.base}
									flexDirection="column"
									paddingLeft={1}
									paddingRight={1}
									onMouseDown={() => props.onSelect(node.index)}
								>
									<For each={node.lines}>
										{(line) => (
											<text wrapMode="none">
												<For each={line}>
													{(span) => (
														<Tint fg={span.role === "muted" ? ctx.theme.text.muted : node.index === props.selected ? ctx.theme.text.base : roleColor(ctx.theme.text, span.role)}>
															{span.text}
														</Tint>
													)}
												</For>
											</text>
										)}
									</For>
								</box>
							)}
						</For>
					</box>
				</Show>
			)
		}

		const Inspector = (props: { run: RunSnapshot; index: number; compact: boolean }) => {
			const ctx = usePlugin()
			const phase = () => props.run.phases[props.index]
			const agents = () => props.run.agents.filter((agent) => agent.phase === props.index)
			const artifacts = () => props.run.artifacts.filter((artifact) => artifact.phase === props.index)
			return (
				<box flexDirection="column" gap={1}>
					<Show when={phase()} fallback={<text fg={ctx.theme.text.muted}>(no phase selected)</text>}>
						{(current: () => PhaseInfo) => (
							<box flexDirection="column">
								<text fg={ctx.theme.text.base}>
									{glyph(current().status)} {current().name}
								</text>
								<text fg={ctx.theme.text.muted}>
									{current().status}
									{current().visits > 1 ? ` · visit ${current().visits}` : ""}
									{phaseDetail(current()) ? ` · ${phaseDetail(current())}` : ""}
								</text>
							</box>
						)}
					</Show>
					<Show when={agents().length}>
						<box flexDirection="column">
							<text fg={ctx.theme.text.base}>Agents</text>
							<For each={agents()}>
								{(agent) => (
									<text fg={ctx.theme.text.muted}>
										{glyph(agent.status)} {truncate(agent.name, 20)} · {agent.asks} asks
									</text>
								)}
							</For>
						</box>
					</Show>
					<Show when={artifacts().length}>
						<box flexDirection="column">
							<text fg={ctx.theme.text.base}>Artifacts</text>
							<For each={artifacts()}>
								{(artifact) => (
									<box flexDirection="column">
										<text fg={ctx.theme.text.base}>
											{artifact.primary ? "★ " : "· "}
											{truncate(artifact.title, 24)}
										</text>
										<For each={artifactLines(artifact, 28).slice(0, props.compact ? 2 : 4)}>
											{(line) => <text fg={ctx.theme.text.muted}>{truncate(line, 30)}</text>}
										</For>
									</box>
								)}
							</For>
						</box>
					</Show>
					<Show when={props.run.logs.length}>
						<box flexDirection="column">
							<text fg={ctx.theme.text.base}>Log</text>
							<For each={props.run.logs.slice(-(props.compact ? 3 : 6))}>{(line) => <text fg={ctx.theme.text.muted}>· {truncate(line, 32)}</text>}</For>
						</box>
					</Show>
					<Show when={props.run.error}>
						{(error: () => RunError) => <text fg={ctx.theme.text.feedback.error.base}>{truncate(error().message, 34)}</text>}
					</Show>
				</box>
			)
		}

		const ArtifactDialog = (props: { artifact: ArtifactView; theme: TextTheme }) => (
			<box flexDirection="column" width="90%" height="80%" border padding={1}>
				<text fg={props.theme.base}>
					{props.artifact.title} ({props.artifact.kind})
				</text>
				<scrollbox flexGrow={1} border marginTop={1}>
					<text fg={props.theme.muted}>{artifactText(props.artifact)}</text>
				</scrollbox>
				<text fg={props.theme.muted}>esc closes</text>
			</box>
		)

		const ArtifactCard = (props: { artifact: ArtifactView }) => {
			const ctx = usePlugin()
			return (
				<box flexDirection="column">
					<text fg={ctx.theme.text.base}>
						{props.artifact.primary ? "★ " : ""}
						{props.artifact.title}
					</text>
					<text fg={ctx.theme.text.muted}>({props.artifact.kind})</text>
					<For each={artifactLines(props.artifact)}>{(line) => <text fg={ctx.theme.text.muted}>{line}</text>}</For>
				</box>
			)
		}

		const WorkflowPanel = (props: { input: PanelInput }) => {
			const ctx = usePlugin()
			let grabbedFocus = false
			createEffect(() => {
				if (props.input.name !== PANEL_NAME) {
					grabbedFocus = false
					setPanel(undefined)
					return
				}
				setPanel({ sessionID: props.input.sessionID, focused: props.input.focused, toggle: props.input.toggleFullscreen })
				if (grabbedFocus) return
				grabbedFocus = true
				// The panel owns j/k/o/f while it is open; take focus once so they reach it.
				try {
					props.input.focus()
				} catch (error) {
					console.error(`[workflow.tui] panel focus failed:`, error)
				}
			})
			onCleanup(() => setPanel(undefined))
			const current = () => forSession(props.input.sessionID)
			const snapshot = () => snapshotOf(current()?.id)
			let lastID: string | undefined
			createEffect(() => {
				const run = current()
				if (!run) return
				if (run.id !== lastID) {
					lastID = run.id
					setAncestry(undefined)
				}
				refreshDetail(run.id)
			})
			const index = () => {
				const snap = snapshot()
				return snap ? phaseIndex(snap) : 0
			}
			const fullscreen = () => props.input.presentation === "fullscreen"
			const elapsed = () => {
				const entry = current()
				if (!entry) return ""
				return formatDuration((entry.endedAt ?? Date.now()) - entry.createdAt)
			}
			return (
				<Show when={props.input.name === PANEL_NAME}>
					<box flexDirection="column" gap={1}>
						<Show when={current()} fallback={<text fg={ctx.theme.text.muted}>No workflow runs yet. Use /workflow to start one.</text>}>
							{(entry: () => RunSummary) => (
								<box flexDirection="column">
									<box flexDirection="row" width={props.input.width}>
										<text fg={ctx.theme.text.base}>
											{glyph(entry().status)} {truncate(entry().name, Math.max(12, props.input.width - 24))}
										</text>
									</box>
									<text fg={ctx.theme.text.muted}>
										{entry().id} · {entry().status} · {entry().phasesDone}/{entry().phaseCount} phases · {entry().agentCount} agents · {elapsed()}
									</text>
									<Show when={entry().error}>{(error: () => RunError) => <text fg={ctx.theme.text.feedback.error.base}>{truncate(error().message, 60)}</text>}</Show>
								</box>
							)}
						</Show>
						<Show when={snapshot()}>
							{(snap: () => RunSnapshot) => (
								<Show
									when={fullscreen()}
									fallback={
										<box flexDirection="column" gap={1}>
											<PhaseList run={snap()} selected={index()} width={props.input.width} onSelect={(value) => setAncestry({ runID: snap().id, index: value })} />
											<Inspector run={snap()} index={index()} compact />
											<Show when={snap().artifacts.length}>
												<box flexDirection="column" gap={1}>
													<For each={snap().artifacts.slice(0, 3)}>{(artifact) => <ArtifactCard artifact={artifact} />}</For>
												</box>
											</Show>
											<text fg={ctx.theme.text.muted}>j/k move · o artifact · f fullscreen · x stop</text>
										</box>
									}
								>
									<box flexDirection="column" gap={1}>
										<GraphCanvas
											run={snap()}
											width={Math.max(40, props.input.width - 2)}
											selected={index()}
											onSelect={(value) => setAncestry({ runID: snap().id, index: value })}
											animated={snap().status === "running"}
										/>
										<text fg={ctx.theme.text.muted}>j/k or click a node · o artifact · f panel · x stop</text>
										<box flexDirection="row" gap={2} flexWrap="wrap">
											<box flexDirection="column" width={44} border borderStyle="rounded" padding={1}>
												<Inspector run={snap()} index={index()} compact={false} />
											</box>
											<Show when={snap().artifacts.length}>
												<box flexDirection="column" width={44} gap={1}>
													<For each={snap().artifacts.slice(0, 4)}>
														{(artifact) => (
															<box flexDirection="column">
																<text fg={ctx.theme.text.base}>
																	{artifact.primary ? "★ " : "· "}
																	{truncate(artifact.title, 34)}
																</text>
																<For each={artifactLines(artifact, 40).slice(0, 3)}>
																	{(line) => <text fg={ctx.theme.text.muted}>{line}</text>}
																</For>
															</box>
														)}
													</For>
												</box>
											</Show>
										</box>
									</box>
								</Show>
							)}
						</Show>
					</box>
				</Show>
			)
		}

		const WorkflowCommands = () => {
			const ctx = usePlugin()
			const open = () => ctx.ui.panel.current()?.name === PANEL_NAME && panel()?.focused === true
			const stopCurrent = (): void => {
				void (async () => {
					const run = forSession()
					if (!run) {
						ctx.ui.toast.show({ title: "Workflow", message: "No run selected.", variant: "info" })
						return
					}
					if (run.status !== "running" && run.status !== "queued") {
						ctx.ui.toast.show({ title: "Workflow", message: `${run.name} already ${run.status}.`, variant: "info" })
						return
					}
					const confirmed = await ctx.ui.dialog.confirm({
						title: "Stop workflow?",
						message: `Stop "${run.name}"? Finished work is kept.`,
						label: { confirm: "Stop", cancel: "Cancel" },
					})
					if (!confirmed) return
					try {
						await rpc.stopRun({ runID: run.id })
						ctx.ui.toast.show({ title: "Workflow stopped", message: run.name, variant: "info", sessionID: run.sessionID })
					} catch (error) {
						ctx.ui.toast.show({
							title: "Workflow",
							message: `Could not stop: ${error instanceof Error ? error.message : String(error)}`,
							variant: "error",
							sessionID: run.sessionID,
						})
					}
				})()
			}

			ctx.keymap.layer(() => ({
				mode: "global",
				commands: [
					{
						id: "workflow.next",
						title: "Workflow: next phase",
						group: "Workflow",
						bind: "j",
						enabled: open,
						run: () => stepSelection(1),
					},
					{
						id: "workflow.previous",
						title: "Workflow: previous phase",
						group: "Workflow",
						bind: "k",
						enabled: open,
						run: () => stepSelection(-1),
					},
					{
						id: "workflow.artifact",
						title: "Workflow: open artifact",
						group: "Workflow",
						bind: "o",
						enabled: open,
						run: () => openArtifact(),
					},
					{
						id: "workflow.fullscreen",
						title: "Workflow: toggle fullscreen",
						group: "Workflow",
						bind: "f",
						enabled: open,
						run: () => panel()?.toggle(),
					},
					{
						id: "workflow.panel",
						title: "Open workflow run",
						group: "Workflow",
						palette: true,
						run: () => ctx.ui.panel.open(PANEL_NAME),
					},
					{
						id: "workflow.list",
						title: "Switch workflow run",
						group: "Workflow",
						palette: true,
						run: () => {
							void (async () => {
								if (!runs.entries.length) {
									ctx.ui.toast.show({ title: "Workflow", message: "No workflow runs yet.", variant: "info" })
									return
								}
								const picked = await ctx.ui.dialog.select({
									title: "Switch workflow run",
									current: selected() ?? forSession()?.id,
									options: sorted().map((entry) => ({
										title: `${entry.name} — ${entry.status}`,
										value: entry.id,
										description: `${entry.id} · ${entry.phasesDone}/${entry.phaseCount} phases`,
									})),
								})
								if (!picked) return
								setSelected(picked)
								setAncestry(undefined)
								refreshDetail(picked, true)
								ctx.ui.panel.open(PANEL_NAME)
							})()
						},
					},
					{
						id: "workflow.stop",
						title: "Stop workflow run",
						group: "Workflow",
						palette: true,
						run: stopCurrent,
					},
					{
						id: "workflow.stop.key",
						title: "Workflow: stop run",
						group: "Workflow",
						bind: "x",
						enabled: open,
						run: stopCurrent,
					},
				],
			}))
			return null
		}

		const unregisterSidebar = context.ui.slot({
			append: "sidebar.content",
			render: (input) => <WorkflowCard sessionID={input.sessionID} />,
		})
		const unregisterDot = context.ui.slot({
			append: "prompt.footer.status",
			render: (input) => <WorkflowDot sessionID={input.sessionID} />,
		})
		const unregisterPanel = context.ui.slot({
			append: "session.panel",
			render: (input) => <WorkflowPanel input={input} />,
		})
		const unregisterCommands = context.ui.slot({
			append: "app",
			render: () => <WorkflowCommands />,
		})

		return () => {
			if (detailTimer) clearTimeout(detailTimer)
			for (const stop of unsubscribes) {
				try {
					stop()
				} catch (error) {
					console.error(`[workflow.tui] unsubscribe failed:`, error)
				}
			}
			unregisterSidebar()
			unregisterDot()
			unregisterPanel()
			unregisterCommands()
		}
	},
})
