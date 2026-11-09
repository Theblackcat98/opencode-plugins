/**
 * Shared shapes for the workflow plugin.
 *
 * The server owns a run; the RPC contract ships these objects to the TUI half,
 * which only renders them. Keep every field JSON-safe: RPC event data must be
 * a plain object, and snapshots are persisted with ctx.storage.
 */

export type RunStatus = "queued" | "running" | "completed" | "errored" | "stopped"

export type PhaseStatus = "pending" | "active" | "done" | "error"

export interface PhaseInfo {
	readonly name: string
	status: PhaseStatus
	/** How many times the script entered this phase (loops revisit one node). */
	readonly visits: number
	readonly startedAt?: number
	readonly endedAt?: number
	/** Distinct subagents that asked something while this phase was active. */
	readonly agentCount?: number
	readonly askCount?: number
}

export interface EdgeInfo {
	readonly from: number
	readonly to: number
	/** "loop" when the edge goes back to an earlier phase. */
	readonly kind: "forward" | "loop"
	traversals: number
}

export interface AgentInfo {
	readonly name: string
	readonly sessionID?: string
	readonly model?: string
	readonly asks: number
	readonly status: "idle" | "running" | "done" | "error"
	/** Index of the phase this agent last worked in. */
	readonly phase?: number
}

export interface FieldRef {
	readonly field: string
	readonly label?: string
	readonly unit?: string
}

interface ArtifactBase {
	readonly id: string
	readonly title: string
	readonly description?: string
	readonly primary?: boolean
	readonly version: number
	/** Index of the phase that published it, when one was active. */
	readonly phase?: number
}

export interface MarkdownArtifact extends ArtifactBase {
	readonly kind: "markdown"
	readonly content: string
}

export interface FileArtifact extends ArtifactBase {
	readonly kind: "file"
	readonly path: string
	readonly size: number
	readonly contentType?: string
}

export interface TableArtifact extends ArtifactBase {
	readonly kind: "table"
	readonly columns: readonly FieldRef[]
	readonly rows: readonly Record<string, unknown>[]
}

export interface ChartArtifact extends ArtifactBase {
	readonly kind: "chart"
	readonly type: "line" | "bar" | "scatter"
	readonly x: FieldRef
	readonly y: readonly FieldRef[]
	readonly scale: "linear" | "log"
	readonly baseline?: FieldRef
	readonly points: readonly Record<string, unknown>[]
}

export interface MetricsArtifact extends ArtifactBase {
	readonly kind: "metrics"
	readonly metrics: readonly FieldRef[]
	readonly latest: Record<string, unknown>
}

export interface BoardCard {
	readonly key: string
	readonly title: string
	readonly status: string
	readonly detail: Record<string, unknown>
}

export interface BoardArtifact extends ArtifactBase {
	readonly kind: "board"
	readonly columns: readonly string[]
	readonly cards: readonly BoardCard[]
}

export type ArtifactView =
	| MarkdownArtifact
	| FileArtifact
	| TableArtifact
	| ChartArtifact
	| MetricsArtifact
	| BoardArtifact

export interface RunError {
	readonly message: string
	readonly stack?: string
	readonly kind?: "script" | "provider" | "aborted" | "compile"
}

export interface RunSummary {
	readonly id: string
	readonly name: string
	readonly status: RunStatus
	readonly sessionID: string
	readonly directory: string
	readonly createdAt: number
	readonly updatedAt: number
	readonly endedAt?: number
	readonly phaseCount: number
	readonly phasesDone: number
	readonly agentCount: number
	readonly artifactCount: number
	readonly error?: RunError
	/** Set when this run reused a predecessor's cached work. */
	readonly resumedFrom?: string
}

export interface RunSnapshot extends RunSummary {
	readonly phases: readonly PhaseInfo[]
	readonly edges: readonly EdgeInfo[]
	readonly currentPhase?: number
	readonly agents: readonly AgentInfo[]
	readonly artifacts: readonly ArtifactView[]
	readonly items: readonly unknown[]
	readonly logs: readonly string[]
	readonly args: Readonly<Record<string, unknown>>
	readonly result?: unknown
	readonly maxConcurrency: number
	readonly subagentModel?: string
	readonly script: string
	readonly stoppedReason?: string
}

export interface SavedWorkflowInfo {
	readonly name: string
	readonly description: string
	readonly whenToUse?: string
	readonly scope: "project" | "global"
	readonly path: string
	readonly args?: Record<string, unknown>
	readonly updatedAt: number
}

/** Report shape the skill asks scripts to return. */
export interface Finding {
	readonly where: string
	readonly what: string
	readonly evidence: string
	readonly status: "verified" | "unconfirmed"
	readonly severity: "low" | "medium" | "high"
}

export interface WorkflowReport {
	readonly conclusion: string
	readonly findings: readonly Finding[]
	readonly verified: readonly string[]
	readonly notCovered: readonly string[]
}
