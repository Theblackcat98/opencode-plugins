/**
 * Artifact store for one run.
 *
 * Preset artifacts (chart, table, metrics, board) are declarations fed by the
 * items a script passes to report(item, id). Content artifacts (markdown, file)
 * are published directly. Views are bounded so a snapshot stays cheap to send
 * over RPC and to persist.
 */

import type {
	ArtifactView,
	BoardArtifact,
	BoardCard,
	ChartArtifact,
	FieldRef,
	FileArtifact,
	MarkdownArtifact,
	MetricsArtifact,
	TableArtifact,
} from "./types.js"

export const MARKDOWN_LIMIT = 256 * 1024
export const ARTIFACT_LIMIT = 32
export const VIEW_ROWS = 100
export const VIEW_POINTS = 200
export const VIEW_CARDS = 50
export const VIEW_MARKDOWN = 16 * 1024

export interface ArtifactOptions {
	readonly title?: string
	readonly description?: string
	readonly primary?: boolean
}

export interface ChartSpec extends ArtifactOptions {
	readonly type?: "line" | "bar" | "scatter"
	readonly x: FieldRef
	readonly y: FieldRef | readonly FieldRef[]
	readonly scale?: "linear" | "log"
	readonly baseline?: FieldRef
}

export interface TableSpec extends ArtifactOptions {
	readonly columns: readonly FieldRef[]
	readonly key?: string
}

export interface MetricsSpec extends ArtifactOptions {
	readonly metrics: readonly FieldRef[]
}

export interface BoardSpec extends ArtifactOptions {
	readonly key: string
	readonly status: string
	readonly columns: readonly string[]
	readonly cardTitle?: string
	readonly detail?: readonly FieldRef[]
}

type Decl =
	| { kind: "chart"; spec: ChartSpec }
	| { kind: "table"; spec: TableSpec }
	| { kind: "metrics"; spec: MetricsSpec }
	| { kind: "board"; spec: BoardSpec }

interface Entry {
	decl?: Decl
	version: number
	primary: boolean
	published?: ArtifactView
	points: Record<string, unknown>[]
	rows: Record<string, unknown>[]
	latest: Record<string, unknown>
	cards: BoardCard[]
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function pick(item: Record<string, unknown>, field: string): unknown {
	if (field in item) return item[field]
	// Dot paths: "timing.after".
	let current: unknown = item
	for (const part of field.split(".")) {
		if (!current || typeof current !== "object") return undefined
		current = (current as Record<string, unknown>)[part]
	}
	return current
}

function titleOf(id: string, opts: ArtifactOptions): string {
	return (opts.title ?? id).slice(0, 120)
}

function descriptionOf(opts: ArtifactOptions): string | undefined {
	return opts.description?.slice(0, 500)
}

export class ArtifactStore {
	private readonly entries = new Map<string, Entry>()

	private entry(id: string): Entry {
		let entry = this.entries.get(id)
		if (!entry) {
			if (this.entries.size >= ARTIFACT_LIMIT) throw new Error(`A run may publish at most ${ARTIFACT_LIMIT} artifacts.`)
			entry = { version: 0, primary: false, points: [], rows: [], latest: {}, cards: [] }
			this.entries.set(id, entry)
		}
		return entry
	}

	private setPrimary(id: string, primary: boolean | undefined): void {
		if (!primary) return
		for (const [otherID, other] of this.entries) if (otherID !== id) other.primary = false
		this.entries.get(id)!.primary = true
	}

	markdown(id: string, content: string, opts: ArtifactOptions = {}): MarkdownArtifact {
		if (content.length > MARKDOWN_LIMIT) throw new Error(`Artifact "${id}" exceeds the ${MARKDOWN_LIMIT} character markdown cap.`)
		const entry = this.entry(id)
		entry.version += 1
		this.setPrimary(id, opts.primary)
		const artifact: MarkdownArtifact = {
			kind: "markdown",
			id,
			title: titleOf(id, opts),
			...(descriptionOf(opts) ? { description: descriptionOf(opts) } : {}),
			primary: entry.primary || undefined,
			version: entry.version,
			content,
		}
		entry.published = artifact
		return artifact
	}

	file(id: string, path: string, size: number, opts: ArtifactOptions & { contentType?: string } = {}): FileArtifact {
		const entry = this.entry(id)
		entry.version += 1
		this.setPrimary(id, opts.primary)
		const artifact: FileArtifact = {
			kind: "file",
			id,
			title: titleOf(id, opts),
			...(descriptionOf(opts) ? { description: descriptionOf(opts) } : {}),
			primary: entry.primary || undefined,
			version: entry.version,
			path,
			size,
			...(opts.contentType ? { contentType: opts.contentType } : {}),
		}
		entry.published = artifact
		return artifact
	}

	chart(id: string, spec: ChartSpec): void {
		if (!spec || !spec.x || !spec.y) throw new Error(`artifact.chart("${id}") needs an x field and at least one y field.`)
		const entry = this.entry(id)
		if (entry.decl && entry.decl.kind !== "chart") throw new Error(`Artifact id "${id}" is already used by a ${entry.decl.kind} artifact.`)
		entry.decl = { kind: "chart", spec }
		this.setPrimary(id, spec.primary)
	}

	table(id: string, spec: TableSpec): void {
		if (!spec || !Array.isArray(spec.columns) || spec.columns.length === 0) throw new Error(`artifact.table("${id}") needs columns.`)
		const entry = this.entry(id)
		if (entry.decl && entry.decl.kind !== "table") throw new Error(`Artifact id "${id}" is already used by a ${entry.decl.kind} artifact.`)
		entry.decl = { kind: "table", spec }
		this.setPrimary(id, spec.primary)
	}

	metrics(id: string, spec: MetricsSpec): void {
		if (!spec || !Array.isArray(spec.metrics) || spec.metrics.length === 0) throw new Error(`artifact.metrics("${id}") needs metrics.`)
		const entry = this.entry(id)
		if (entry.decl && entry.decl.kind !== "metrics") throw new Error(`Artifact id "${id}" is already used by a ${entry.decl.kind} artifact.`)
		entry.decl = { kind: "metrics", spec }
		this.setPrimary(id, spec.primary)
	}

	board(id: string, spec: BoardSpec): void {
		if (!spec || !spec.key || !spec.status) throw new Error(`artifact.board("${id}") needs key and status fields.`)
		const entry = this.entry(id)
		if (entry.decl && entry.decl.kind !== "board") throw new Error(`Artifact id "${id}" is already used by a ${entry.decl.kind} artifact.`)
		entry.decl = { kind: "board", spec: { ...spec, columns: spec.columns ?? [] } }
		this.setPrimary(id, spec.primary)
	}

	/**
	 * Feed a reported item into a declared preset artifact. Returns false when
	 * the tag names an artifact that has not been declared: the caller turns
	 * that into a run failure, matching the confirmation the user approved.
	 */
	report(item: unknown, artifactId?: string): boolean {
		if (!artifactId) return true
		const entry = this.entries.get(artifactId)
		if (!entry?.decl) return false
		const record = asRecord(item)
		if (entry.decl.kind === "chart") {
			entry.points.push(record)
			if (entry.points.length > VIEW_POINTS * 5) entry.points.shift()
			return true
		}
		if (entry.decl.kind === "table") {
			const keyField = entry.decl.spec.key
			if (keyField) {
				const key = String(pick(record, keyField))
				const index = entry.rows.findIndex((row) => String(pick(row, keyField)) === key)
				if (index !== -1) entry.rows[index] = record
				else entry.rows.push(record)
			} else entry.rows.push(record)
			if (entry.rows.length > VIEW_ROWS * 5) entry.rows.shift()
			return true
		}
		if (entry.decl.kind === "metrics") {
			for (const metric of entry.decl.spec.metrics) {
				const value = pick(record, metric.field)
				if (value !== undefined) entry.latest[metric.field] = value
			}
			return true
		}
		if (entry.decl.kind === "board") {
			const spec = entry.decl.spec
			const key = String(pick(record, spec.key))
			const detail: Record<string, unknown> = {}
			for (const field of spec.detail ?? []) detail[field.field] = pick(record, field.field)
			const card: BoardCard = {
				key,
				title: String(pick(record, spec.cardTitle ?? spec.key) ?? key),
				status: String(pick(record, spec.status) ?? ""),
				detail,
			}
			const index = entry.cards.findIndex((candidate) => candidate.key === key)
			if (index !== -1) entry.cards[index] = card
			else entry.cards.push(card)
			if (entry.cards.length > VIEW_CARDS * 5) entry.cards.shift()
			return true
		}
		return false
	}

	/** Declared but not yet fed artifacts still appear, so the panel can show them. */
	views(): ArtifactView[] {
		const views: ArtifactView[] = []
		for (const [id, entry] of this.entries) {
			if (entry.published) {
				views.push(entry.published)
				continue
			}
			const decl = entry.decl
			if (!decl) continue
			if (decl.kind === "chart") {
				const y = Array.isArray(decl.spec.y) ? decl.spec.y : [decl.spec.y as FieldRef]
				const artifact: ChartArtifact = {
					kind: "chart",
					id,
					title: titleOf(id, decl.spec),
					...(descriptionOf(decl.spec) ? { description: descriptionOf(decl.spec) } : {}),
					primary: entry.primary || undefined,
					version: entry.version,
					type: decl.spec.type ?? "line",
					x: decl.spec.x,
					y,
					scale: decl.spec.scale ?? "linear",
					...(decl.spec.baseline ? { baseline: decl.spec.baseline } : {}),
					points: entry.points.slice(-VIEW_POINTS),
				}
				views.push(artifact)
				continue
			}
			if (decl.kind === "table") {
				const artifact: TableArtifact = {
					kind: "table",
					id,
					title: titleOf(id, decl.spec),
					...(descriptionOf(decl.spec) ? { description: descriptionOf(decl.spec) } : {}),
					primary: entry.primary || undefined,
					version: entry.version,
					columns: decl.spec.columns,
					rows: entry.rows.slice(-VIEW_ROWS),
				}
				views.push(artifact)
				continue
			}
			if (decl.kind === "metrics") {
				const artifact: MetricsArtifact = {
					kind: "metrics",
					id,
					title: titleOf(id, decl.spec),
					...(descriptionOf(decl.spec) ? { description: descriptionOf(decl.spec) } : {}),
					primary: entry.primary || undefined,
					version: entry.version,
					metrics: decl.spec.metrics,
					latest: entry.latest,
				}
				views.push(artifact)
				continue
			}
			const artifact: BoardArtifact = {
				kind: "board",
				id,
				title: titleOf(id, decl.spec),
				...(descriptionOf(decl.spec) ? { description: descriptionOf(decl.spec) } : {}),
				primary: entry.primary || undefined,
				version: entry.version,
				columns: decl.spec.columns,
				cards: entry.cards.slice(-VIEW_CARDS),
			}
			views.push(artifact)
		}
		// Primary first, then source order.
		return views.sort((left, right) => Number(!!right.primary) - Number(!!left.primary))
	}

	/** Rehydrate views from a persisted snapshot. */
	static fromViews(views: readonly ArtifactView[]): ArtifactStore {
		const store = new ArtifactStore()
		for (const view of views) {
			const entry: Entry = {
				version: view.version,
				primary: !!view.primary,
				published: view,
				points: [],
				rows: [],
				latest: {},
				cards: [],
			}
			store.entries.set(view.id, entry)
		}
		return store
	}
}
