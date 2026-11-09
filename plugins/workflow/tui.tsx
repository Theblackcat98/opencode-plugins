/**
 * Workflow TUI plugin (OpenCode V2)
 *
 * The server half owns runs and announces transitions over RPC. This half
 * renders them: a session panel with the phase graph, live agents and artifact
 * cards, a status dot in the prompt footer, toasts when a run settles, and
 * palette commands to open or stop a run.
 *
 * Recovery: RPC event subscriptions are live-only, so setup polls listRuns
 * once for runs that started before this terminal attached.
 *
 * NOTE: keymap.layer() needs a Solid owner. It is called from the mounted
 * `app` slot component, never from setup().
 */

import { For, Show, createEffect, createSignal } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { WorkflowRpc } from "./rpc.js"
import type { ArtifactView, RunSnapshot, RunSummary } from "./types.js"

const PANEL_NAME = "workflow.run"

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

export default Plugin.define({
	id: "workflow.tui",
	async setup(context) {
		const rpc = context.client.rpc(WorkflowRpc)
		const directory = context.location?.directory
		const [runs, setRuns] = context.storage.memory("workflow-runs", { initial: { entries: [] as RunSummary[] } })
		const [selected, setSelected] = createSignal<string | undefined>(undefined)
		const [detail, setDetail] = createSignal<RunSnapshot | undefined>(undefined)
		const [watching, setWatching] = createSignal<string | undefined>(undefined)
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
			}, 250)
		}

		const loadDetail = async (runID: string): Promise<void> => {
			try {
				const result = await rpc.getRun({ runID })
				const data = unwrap<{ run?: unknown }>(result)
				const snapshot = data?.run
				if (isSnapshot(snapshot)) setDetail(snapshot)
			} catch (error) {
				console.error(`[workflow.tui] getRun failed:`, error)
			}
		}

		const forSession = (sessionID?: string): RunSummary | undefined => {
			const sorted = [...runs.entries].sort((left, right) => right.createdAt - left.createdAt)
			if (selected()) {
				const hit = sorted.find((entry) => entry.id === selected())
				if (hit) return hit
			}
			if (sessionID) {
				const hit = sorted.find((entry) => entry.sessionID === sessionID)
				if (hit) return hit
			}
			return sorted[0]
		}

		const unsubscribes: Array<() => void> = [
			rpc.events.on("updated", (event) => {
				if (!sameDirectory(event) || !isRunSummary(event.data)) return
				upsert(event.data)
				if (detail()?.id === event.data.id) refreshDetail(event.data.id)
			}),
			rpc.events.on("finished", (event) => {
				if (!sameDirectory(event) || !isRunSummary(event.data)) return
				const summary = event.data
				upsert(summary)
				if (summary.id === selected() || summary.id === watching()) refreshDetail(summary.id, true)
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
			const current = () => forSession(props.sessionID)
			return (
				<Show when={current()}>
					{(run: () => RunSummary) => (
						<box flexDirection="column">
							<text fg={ctx.theme.text.base}>
								WF {run().status} {run().phasesDone}/{run().phaseCount}
							</text>
							<text fg={ctx.theme.text.muted}>{run().name}</text>
						</box>
					)}
				</Show>
			)
		}

		const WorkflowDot = (props: { sessionID?: string }) => {
			const ctx = usePlugin()
			const current = () => forSession(props.sessionID)
			return (
				<Show when={current() && (current()?.status === "running" || current()?.status === "queued")}>
					<text fg={ctx.theme.text.feedback.info.base}>
						WF {current()?.phasesDone}/{current()?.phaseCount}
					</text>
				</Show>
			)
		}

		const PhaseGraph = (props: { run: RunSnapshot }) => {
			const ctx = usePlugin()
			const loopTargets = () => new Set(props.run.edges.filter((edge) => edge.to < edge.from).map((edge) => edge.to))
			return (
				<box flexDirection="column">
					<For each={props.run.phases}>
						{(phase, index) => (
							<text
								fg={
									phase.status === "error"
										? ctx.theme.text.feedback.error.base
										: phase.status === "active"
											? ctx.theme.text.feedback.info.base
											: ctx.theme.text.muted
								}
							>
								{glyph(phase.status)} {index() + 1}. {phase.name}
								{phase.visits > 1 ? ` ×${phase.visits}` : ""}
								{loopTargets().has(index()) ? " ↺" : ""}
							</text>
						)}
					</For>
					<Show when={props.run.phases.length === 0}>
						<text fg={ctx.theme.text.muted}>(no phases recorded)</text>
					</Show>
				</box>
			)
		}

		const ArtifactCard = (props: { artifact: ArtifactView }) => {
			const ctx = usePlugin()
			return (
				<box flexDirection="column">
					<text fg={ctx.theme.text.base}>
						{props.artifact.title}
						{props.artifact.primary ? " ★" : ""}
					</text>
					<text fg={ctx.theme.text.muted}>({props.artifact.kind})</text>
					<For each={artifactLines(props.artifact)}>{(line) => <text fg={ctx.theme.text.muted}>{line}</text>}</For>
				</box>
			)
		}

		const WorkflowPanel = (props: { name: string; sessionID: string }) => {
			const ctx = usePlugin()
			const current = () => (selected() ? runs.entries.find((entry) => entry.id === selected()) : forSession(props.sessionID))
			const snapshot = () => (detail()?.id === current()?.id ? detail() : undefined)
			createEffect(() => {
				const run = current()
				if (!run) return
				if (watching() === run.id) return
				setWatching(run.id)
				refreshDetail(run.id, true)
			})
			return (
				<Show when={props.name === PANEL_NAME}>
					<box flexDirection="column" gap={1}>
						<Show when={current()} fallback={<text fg={ctx.theme.text.muted}>No workflow runs yet. Use /workflow to start one.</text>}>
							{(run: () => RunSummary) => (
								<box flexDirection="column">
									<text fg={ctx.theme.text.base}>
										{glyph(run().status)} {run().name}
									</text>
									<text fg={ctx.theme.text.muted}>
										{run().id} · {run().status} · {run().phasesDone}/{run().phaseCount} phases · {run().agentCount} agents
									</text>
									<Show when={snapshot()}>{(snap: () => RunSnapshot) => <PhaseGraph run={snap()} />}</Show>
								</box>
							)}
						</Show>

						<Show when={snapshot()}>
							{(snap: () => RunSnapshot) => (
								<box flexDirection="column" gap={1}>
									<Show when={snap().agents.length > 0}>
										<box flexDirection="column">
											<text fg={ctx.theme.text.base}>Subagents</text>
											<For each={snap().agents}>
												{(agent) => (
													<text fg={ctx.theme.text.muted}>
														{glyph(agent.status)} {agent.name} · {agent.asks} asks
													</text>
												)}
											</For>
										</box>
									</Show>

									<Show when={snap().artifacts.length > 0}>
										<box flexDirection="column" gap={1}>
											<text fg={ctx.theme.text.base}>Artifacts</text>
											<For each={snap().artifacts}>{(artifact) => <ArtifactCard artifact={artifact} />}</For>
										</box>
									</Show>

									<Show when={snap().logs.length > 0}>
										<box flexDirection="column">
											<text fg={ctx.theme.text.base}>Log</text>
											<For each={snap().logs.slice(-10)}>{(line) => <text fg={ctx.theme.text.muted}>· {line}</text>}</For>
										</box>
									</Show>

									<Show when={snap().error}>
										{(error: () => NonNullable<RunSnapshot["error"]>) => (
											<box flexDirection="column">
												<text fg={ctx.theme.text.feedback.error.base}>Error</text>
												<text fg={ctx.theme.text.muted}>{error().message}</text>
											</box>
										)}
									</Show>
								</box>
							)}
						</Show>
					</box>
				</Show>
			)
		}

		const WorkflowCommands = () => {
			const ctx = usePlugin()
			ctx.keymap.layer(() => ({
				mode: "global",
				commands: [
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
									options: runs.entries
										.slice()
										.sort((left, right) => right.createdAt - left.createdAt)
										.map((entry) => ({
											title: `${entry.name} — ${entry.status}`,
											value: entry.id,
											description: `${entry.id} · ${entry.phasesDone}/${entry.phaseCount} phases`,
										})),
								})
								if (!picked) return
								setSelected(picked)
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
						run: () => {
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
						},
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
			render: (panel) => <WorkflowPanel name={panel.name} sessionID={panel.sessionID} />,
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
