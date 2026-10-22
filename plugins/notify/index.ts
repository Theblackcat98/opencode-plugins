/**
 * Notify Plugin (OpenCode V2)
 *
 * Pushes an ntfy message when a model's generation ends.
 *
 * A long agent run is invisible from the outside: the terminal looks the same
 * whether the model is still thinking or has finished. This plugin watches the
 * server event stream, measures the run, and publishes one message per
 * finished generation so a long run can be checked from a phone.
 *
 * The notification title is the chat title, so the phone shows which
 * conversation finished without opening anything.
 *
 * V2 API used (verified against @opencode/plugin 2.0.26):
 *   ctx.event.subscribe({ signal })   session.execution.* events
 *   ctx.session.get({ sessionID })    chat title, parent session, location
 *   ctx.options                       plugin options
 *   fetch                             ntfy publish (plain text plus headers)
 */

import { Plugin } from "@opencode/plugin"

const DEFAULT_SERVER = "https://ntfy.sh"
const DEFAULT_TOPIC = "theblackcat"
const DEFAULT_PRIORITY = "default"
const REQUEST_TIMEOUT_MS = 10_000

/**
 * A repeat of the same session inside this window is treated as the same
 * run. Several instances of the plugin (one per location) can see the same
 * event, and the server can repeat a terminal event on reconnect.
 */
const DEDUPE_WINDOW_MS = 30_000

/** A start marker older than this belongs to a run that never ended. */
const RUN_TTL_MS = 6 * 60 * 60 * 1000

/** ntfy topic names: letters, numbers, underscore and dash, 64 characters max. */
const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const PRIORITIES = new Set(["min", "low", "default", "high", "max", "1", "2", "3", "4", "5"])

export type Outcome = "succeeded" | "failed" | "interrupted"

export interface NotifyConfig {
	readonly server: string
	readonly topic: string
	readonly token?: string
	readonly priority: string
	/** Runs shorter than this are not reported. 0 reports every run. */
	readonly minDurationMs: number
	/** Report subagent sessions too. */
	readonly includeSubagents: boolean
	/** Report sessions outside this plugin location. */
	readonly allLocations: boolean
}

export interface NotifyPayload {
	readonly title: string
	readonly message: string
	readonly tags: string[]
}

export interface RunSummary {
	readonly title: string
	readonly outcome: Outcome
	readonly durationMs?: number
	readonly detail?: string
	readonly directory?: string
}

/** Loose view of a server event. The stream is a wide union. */
interface SessionEvent {
	readonly type?: string
	readonly created?: number
	readonly data?: Record<string, unknown>
	readonly location?: { readonly directory?: string }
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/** Environment variables arrive as text, so a numeric string counts too. */
function asNumberLike(value: unknown): number | undefined {
	if (typeof value === "number") return asNumber(value)
	if (typeof value !== "string" || !value.trim()) return undefined
	const parsed = Number(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function asBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value
	if (value === "true") return true
	if (value === "false") return false
	return undefined
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/**
 * Options win over environment variables, environment variables win over the
 * defaults. The topic is the only thing that really matters: it is the
 * ntfy channel the phone subscribes to.
 */
export function resolveConfig(
	options: Readonly<Record<string, any>>,
	env: Readonly<Record<string, string | undefined>> = process.env,
): NotifyConfig {
	const server = asString(options.server) ?? asString(env.OPENCODE_NTFY_SERVER) ?? DEFAULT_SERVER
	const topic = asString(options.topic) ?? asString(env.OPENCODE_NTFY_TOPIC) ?? DEFAULT_TOPIC
	const token = asString(options.token) ?? asString(env.OPENCODE_NTFY_TOKEN) ?? asString(env.NTFY_TOKEN)
	const priority = asString(options.priority) ?? asString(env.OPENCODE_NTFY_PRIORITY) ?? DEFAULT_PRIORITY
	const minSeconds =
		asNumberLike(options.minDurationSec) ?? asNumberLike(env.OPENCODE_NTFY_MIN_SECONDS) ?? 0
	const includeSubagents = asBoolean(options.includeSubagents) ?? false
	const allLocations = asBoolean(options.allLocations) ?? false
	return {
		server,
		topic,
		token,
		priority: PRIORITIES.has(priority.toLowerCase()) ? priority.toLowerCase() : DEFAULT_PRIORITY,
		minDurationMs: Math.max(0, minSeconds) * 1000,
		includeSubagents,
		allLocations,
	}
}

/**
 * The ntfy topic URL. The message is published as plain text with the title
 * in a header, which is the form ntfy accepts without a JSON body.
 */
export function resolveEndpoint(config: NotifyConfig): string {
	let url: URL
	try {
		url = new URL(config.server)
	} catch {
		throw new Error(`invalid ntfy server URL: ${config.server}`)
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`ntfy server URL must be http(s): ${config.server}`)
	}
	if (!TOPIC_PATTERN.test(config.topic)) {
		throw new Error(`invalid ntfy topic: ${config.topic}`)
	}
	const path = url.pathname.replace(/\/+$/, "")
	return `${url.origin}${path}/${config.topic}`
}

/**
 * HTTP header values are bytes, and a chat title can hold any text. ntfy
 * reads RFC 2047 encoded headers, so a title that is not plain ASCII is
 * encoded instead of mangled or rejected.
 */
export function encodeHeaderValue(text: string): string {
	// eslint-disable-next-line no-control-regex
	if (!/[^\x00-\x7F]/.test(text)) return text
	return `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`
}

/** The headers of one ntfy message. */
export function buildHeaders(config: NotifyConfig, payload: NotifyPayload): Record<string, string> {
	const headers: Record<string, string> = {
		Title: encodeHeaderValue(payload.title),
		Priority: config.priority,
	}
	if (payload.tags.length) headers.Tags = payload.tags.join(",")
	if (config.token) headers.Authorization = `Bearer ${config.token}`
	return headers
}

/** Human readable run length. */
export function formatDuration(ms: number | undefined): string {
	if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "unknown"
	const total = Math.round(ms / 1000)
	const hours = Math.floor(total / 3600)
	const minutes = Math.floor((total % 3600) / 60)
	const seconds = total % 60
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
	if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`
	return `${seconds}s`
}

const OUTCOME_TEXT: Record<Outcome, string> = {
	succeeded: "finished",
	failed: "failed",
	interrupted: "stopped",
}

const OUTCOME_TAGS: Record<Outcome, string> = {
	succeeded: "white_check_mark",
	failed: "x",
	interrupted: "black_square_for_stop",
}

/** The chat title, with a fallback for sessions that have none yet. */
export function resolveTitle(title: unknown): string {
	const value = asString(title)
	return value ?? "OpenCode chat"
}

/** One line describing how the run ended. */
export function describeRun(summary: RunSummary): string {
	const duration = formatDuration(summary.durationMs)
	const head = `Generation ${OUTCOME_TEXT[summary.outcome]} in ${duration}.`
	const detail = asString(summary.detail)
	const directory = asString(summary.directory)
	const lines = [head]
	if (detail) lines.push(detail)
	if (directory) lines.push(directory)
	return lines.join("\n")
}

export function buildPayload(summary: RunSummary): NotifyPayload {
	return {
		title: resolveTitle(summary.title),
		message: describeRun(summary),
		tags: [OUTCOME_TAGS[summary.outcome]],
	}
}

/** Normalize a directory for comparison: no trailing slash. */
export function normalizeDirectory(directory: string | undefined): string | undefined {
	const value = asString(directory)
	if (!value) return undefined
	const trimmed = value.replace(/\/+$/, "")
	return trimmed || "/"
}

/**
 * True when a session directory belongs to the location this plugin instance
 * was loaded for. One plugin instance exists per location, and every instance
 * sees the whole event stream, so this keeps a session from being reported
 * once per open project.
 */
export function coversDirectory(roots: readonly (string | undefined)[], directory: string | undefined): boolean {
	const target = normalizeDirectory(directory)
	if (!target) return false
	for (const root of roots) {
		const base = normalizeDirectory(root)
		if (!base) continue
		if (base === target) return true
		if (base === "/") return true
		if (target.startsWith(`${base}/`)) return true
		if (base.startsWith(`${target}/`)) return true
	}
	return false
}

/**
 * True when a session belongs to the location this plugin instance was
 * loaded for. One plugin instance exists per project, and every instance sees
 * the whole event stream, so this keeps a run from being reported once per
 * open project.
 *
 * The project id is the exact owner. The directory comparison is the
 * fallback for a server that does not report one.
 */
export function ownsSession(
	instance: { readonly projectID?: string; readonly directories: readonly (string | undefined)[] },
	session: { readonly projectID?: string; readonly directory?: string },
): boolean {
	if (instance.projectID && session.projectID) return instance.projectID === session.projectID
	return coversDirectory(instance.directories, session.directory)
}

/** A run is reported when it lasted at least the configured minimum. */
export function shouldNotify(durationMs: number | undefined, minDurationMs: number): boolean {
	if (minDurationMs <= 0) return true
	if (durationMs === undefined) return false
	return durationMs >= minDurationMs
}

export const internals = {
	resolveConfig,
	resolveEndpoint,
	encodeHeaderValue,
	buildHeaders,
	resolveTitle,
	describeRun,
	buildPayload,
	formatDuration,
	normalizeDirectory,
	coversDirectory,
	ownsSession,
	shouldNotify,
	describeError,
	DEFAULT_SERVER,
	DEFAULT_TOPIC,
	DEFAULT_PRIORITY,
	REQUEST_TIMEOUT_MS,
	DEDUPE_WINDOW_MS,
	RUN_TTL_MS,
	TOPIC_PATTERN,
}

export default Plugin.define({
	id: "notify",
	async setup(ctx) {
		const options = (ctx.options ?? {}) as Readonly<Record<string, any>>
		const config = resolveConfig(options)

		const log = {
			info: (message: string) => console.log(`[notify] ${message}`),
			warn: (message: string) => console.error(`[notify] ${message}`),
		}

		let endpoint: string
		try {
			endpoint = resolveEndpoint(config)
		} catch (error) {
			// A bad configuration must not take the server down with it.
			log.warn(`disabled: ${describeError(error)}`)
			return
		}

		const locationRoots = [ctx.location.directory, ctx.location.project?.directory, ctx.location.project?.canonical]
		const instanceProjectID = asString(ctx.location.project?.id)

		// Transient state: the start time of a running generation and the
		// moment a session was last reported. Both reset on restart.
		const startedAt = new Map<string, number>()
		const reportedAt = new Map<string, number>()

		/** Keep the bookkeeping maps from growing with every session ever seen. */
		const prune = (now: number) => {
			for (const [sessionID, at] of reportedAt) {
				if (now - at >= DEDUPE_WINDOW_MS) reportedAt.delete(sessionID)
			}
			// A run may take hours, so the start marker lives much longer than
			// the dedupe window. Six hours is far past any real generation.
			for (const [sessionID, at] of startedAt) {
				if (now - at >= RUN_TTL_MS) startedAt.delete(sessionID)
			}
		}

		const publish = async (payload: NotifyPayload): Promise<void> => {
			const controller = new AbortController()
			const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
			try {
				const response = await fetch(endpoint, {
					method: "POST",
					headers: buildHeaders(config, payload),
					body: payload.message,
					signal: controller.signal,
				})
				if (!response.ok) {
					const text = await response.text().catch(() => "")
					throw new Error(`ntfy replied ${response.status}${text ? `: ${text.slice(0, 200)}` : ""}`)
				}
			} finally {
				clearTimeout(timer)
			}
		}

		const report = async (event: SessionEvent, outcome: Outcome): Promise<void> => {
			const data = event.data ?? {}
			const sessionID = asString(data.sessionID)
			if (!sessionID) return

			const now = Date.now()
			prune(now)
			const last = reportedAt.get(sessionID)
			if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return
			reportedAt.set(sessionID, now)

			const start = startedAt.get(sessionID)
			startedAt.delete(sessionID)
			const durationMs = start !== undefined ? Math.max(0, now - start) : undefined

			if (!shouldNotify(durationMs, config.minDurationMs)) {
				log.info(`run shorter than ${config.minDurationMs}ms, not reported`)
				return
			}

			let title = "OpenCode chat"
			let parentID: string | undefined
			let directory: string | undefined
			let projectID: string | undefined
			try {
				const info = await ctx.session.get({ sessionID })
				title = resolveTitle(info.title)
				parentID = asString(info.parentID)
				directory = asString(info.location?.directory)
				projectID = asString(info.projectID)
			} catch (error) {
				log.warn(`could not read session ${sessionID}: ${describeError(error)}`)
			}

			if (!config.includeSubagents && parentID) return
			if (!config.allLocations && !ownsSession({ projectID: instanceProjectID, directories: locationRoots }, { projectID, directory })) {
				return
			}

			const detail =
				outcome === "failed"
					? asString((data.error as { message?: unknown } | undefined)?.message)
					: outcome === "interrupted"
						? `reason: ${asString(data.reason) ?? "unknown"}`
						: undefined

			const payload = buildPayload({
				title,
				outcome,
				durationMs,
				detail,
				directory,
			})

			try {
				await publish(payload)
				log.info(`reported ${sessionID} (${outcome})`)
			} catch (error) {
				// A failed notification must never break the session.
				log.warn(`could not publish notification: ${describeError(error)}`)
			}
		}

		const controller = new AbortController()
		void (async () => {
			for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
				const typed = event as SessionEvent
				try {
					if (typed.type === "session.execution.started") {
						const sessionID = asString(typed.data?.sessionID)
						if (sessionID) {
							prune(Date.now())
							startedAt.set(sessionID, Date.now())
						}
						continue
					}
					if (typed.type === "session.execution.succeeded") {
						await report(typed, "succeeded")
						continue
					}
					if (typed.type === "session.execution.failed") {
						await report(typed, "failed")
						continue
					}
					if (typed.type === "session.execution.interrupted") {
						// The user pressing escape is not a finished run worth a push.
						if (asString(typed.data?.reason) === "user") continue
						await report(typed, "interrupted")
					}
				} catch (error) {
					log.warn(`event handling failed: ${describeError(error)}`)
				}
			}
		})().catch((error) => log.warn(`event loop stopped: ${describeError(error)}`))

		log.info(`ready (topic: ${config.topic}, minimum run: ${config.minDurationMs}ms)`)

		return async () => {
			controller.abort()
			startedAt.clear()
			reportedAt.clear()
		}
	},
})
