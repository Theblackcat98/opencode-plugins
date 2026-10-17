/**
 * OpenCode Go usage in the session sidebar.
 *
 * Shows what the OpenCode Console dashboard shows: percent *used* in each of
 * the Go plan's three windows — rolling (5 hour), weekly, monthly — with the
 * bar filling as quota is spent. The bar is twenty flex segments rather than a
 * fixed number of characters, so it spans whatever width the sidebar gives it.
 *
 * Two endpoints, both undocumented as of 2026-10-17. The console status
 * endpoint is preferred because it is the data the Console page itself renders,
 * and because it reports dollars:
 *
 *   GET {console}/api/go/status               Authorization: Bearer <token>
 *                                             x-org-id: <workspace id>
 *   GET https://opencode.ai/zen/go/v1/usage   Authorization: Bearer <token>
 *
 * Console status meters are micro-cents (`limitMicroCents`, `usedMicroCents`)
 * for `fiveHour`, `week`, and `month`. The zen endpoint reports whole percents
 * for `rolling`, `weekly`, and `monthly`, and is the only one a `/connect` Go
 * API key can read; its percentages are used, not remaining. Whichever source
 * answers, the card renders the same thing. A public usage API is still an open
 * feature request upstream (#16017, #31084), so either endpoint can change
 * without notice; the detail dialog names what failed and the last good reading
 * stays on screen marked stale.
 *
 * Credential order, first hit wins:
 *   1. the `apiKey` plugin option
 *   2. OPENCODE_GO_API_KEY
 *   3. the `opencode-go` credential written by /connect
 *   4. the Console connection (`opencode`), whose device-flow token both
 *      endpoints accept
 *
 * Case 4 is why this works with a Console subscription and no separate Go API
 * key: the workspace id comes from that credential's `metadata.orgID`.
 *
 * Options apply only when the plugin is listed in opencode.jsonc or cli.json;
 * a directory discovered under plugins/ receives none.
 *
 *   apiKey         string   override the stored credential
 *   integrationIDs string[] credential integrations to try, in order
 *   consoleURL     string   override the Console base URL
 *   usageURL       string   override the zen usage endpoint
 *   orgID          string   override the workspace id
 *   refreshMinutes number   poll interval, default 5
 */

import { For, Show } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import type { CredentialEntry } from "@opencode/client"

type Theme = ReturnType<typeof usePlugin>["theme"]
type ThemeColor = Theme["text"]["base"]

type WindowKey = "rolling" | "weekly" | "monthly"

type UsageWindow = {
	key: WindowKey
	label: string
	name: string
	status: string | undefined
	usedPercent: number
	resetsAt: number | undefined
	startsAt: number | undefined
	usedDollars: number | undefined
	limitDollars: number | undefined
}

type UsageState = {
	phase: "loading" | "ready" | "unconfigured" | "error"
	endpoint: string
	credential: string
	windows: UsageWindow[]
	plan: string
	renewsAt: number | undefined
	detail: string
	updatedAt: number
}

type Credential = {
	token: string
	source: string
	orgID: string | undefined
	consoleBase: string | undefined
}

type Severity = "ok" | "warn" | "critical"

const DEFAULT_CONSOLE_URL = "https://opencode.ai/console"
const DEFAULT_USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const DEFAULT_INTEGRATION_IDS = ["opencode-go", "opencode"]
const DEFAULT_REFRESH_MINUTES = 5
const USER_AGENT = "opencode-go-usage/1.0.0"
/** Bar resolution; each segment stretches to fill the available width. */
const BAR_SEGMENTS = 20
/** Do not refetch more often than this. */
const MIN_POLL_INTERVAL_MS = 45_000
/** Console meter name -> window key. */
const METER_KEYS: ReadonlyArray<{ meter: string; key: WindowKey }> = [
	{ meter: "fiveHour", key: "rolling" },
	{ meter: "week", key: "weekly" },
	{ meter: "month", key: "monthly" },
]
const WINDOW_META: ReadonlyArray<{ key: WindowKey; label: string; name: string }> = [
	{ key: "rolling", label: "5h", name: "rolling 5h" },
	{ key: "weekly", label: "1w", name: "weekly" },
	{ key: "monthly", label: "1m", name: "monthly" },
]
const SEGMENTS = Array.from({ length: BAR_SEGMENTS }, (_, index) => index)

function readEnv(name: string): string | undefined {
	try {
		const value = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]
		return typeof value === "string" && value.trim() ? value.trim() : undefined
	} catch {
		return undefined
	}
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value)
	return undefined
}

function toTimestamp(value: unknown): number | undefined {
	if (typeof value !== "string" || value === "") return undefined
	const parsed = Date.parse(value)
	return Number.isFinite(parsed) ? parsed : undefined
}

function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value))
}

/** How many bar segments are filled for a used percentage. */
export function filledSegments(usedPercent: number, segments = BAR_SEGMENTS): number {
	return Math.max(0, Math.min(segments, Math.round((clampPercent(usedPercent) / 100) * segments)))
}

/** Usage bands the card colours by. Higher usage is closer to the limit. */
export function severity(usedPercent: number): Severity {
	if (usedPercent >= 85) return "critical"
	if (usedPercent >= 60) return "warn"
	return "ok"
}

export function formatDuration(ms: number): string {
	const totalMinutes = Math.max(0, Math.round(ms / 60_000))
	const days = Math.floor(totalMinutes / 1_440)
	const hours = Math.floor((totalMinutes % 1_440) / 60)
	const minutes = totalMinutes % 60
	if (days > 0) return `${days}d ${hours}h`
	if (hours > 0) return `${hours}h ${minutes}m`
	return `${minutes}m`
}

/** Read the three quota windows out of a zen usage response body. */
export function parseZenUsage(body: unknown): UsageWindow[] {
	const usage = (body as { usage?: unknown } | null | undefined)?.usage
	if (!usage || typeof usage !== "object") return []
	const windows: UsageWindow[] = []
	for (const { key, label, name } of WINDOW_META) {
		const entry = (usage as Record<string, unknown>)[key]
		if (!entry || typeof entry !== "object") continue
		const percent = toNumber((entry as { percent?: unknown }).percent)
		if (percent === undefined) continue
		const status = (entry as { status?: unknown }).status
		windows.push({
			key,
			label,
			name,
			status: typeof status === "string" ? status : undefined,
			usedPercent: clampPercent(percent),
			resetsAt: toTimestamp((entry as { resetsAt?: unknown }).resetsAt),
			startsAt: undefined,
			usedDollars: undefined,
			limitDollars: undefined,
		})
	}
	return windows
}

/** Read the three quota windows out of a console status response body. */
export function parseConsoleStatus(body: unknown): {
	windows: UsageWindow[]
	plan: string
	renewsAt: number | undefined
} {
	const status = body as { product?: unknown; access?: { endsAt?: unknown; meters?: Record<string, unknown> } } | null | undefined
	const plan = typeof status?.product === "string" ? status.product : ""
	const renewsAt = toTimestamp(status?.access?.endsAt)
	const meters = status?.access?.meters
	if (!meters || typeof meters !== "object") return { windows: [], plan, renewsAt }
	const windows: UsageWindow[] = []
	for (const { meter, key } of METER_KEYS) {
		const meta = WINDOW_META.find((entry) => entry.key === key)
		const raw = (meters as Record<string, unknown>)[meter]
		if (!raw || typeof raw !== "object") continue
		const used = toNumber((raw as { usedMicroCents?: unknown }).usedMicroCents)
		const limit = toNumber((raw as { limitMicroCents?: unknown }).limitMicroCents)
		if (used === undefined || limit === undefined) continue
		// Amounts are micro-cents.
		const usedDollars = used / 1e8
		const limitDollars = limit / 1e8
		windows.push({
			key,
			label: meta?.label ?? key,
			name: meta?.name ?? key,
			status: undefined,
			usedPercent: limitDollars > 0 ? clampPercent((100 * usedDollars) / limitDollars) : 0,
			resetsAt: toTimestamp((raw as { resetsAt?: unknown }).resetsAt),
			startsAt: toTimestamp((raw as { startsAt?: unknown }).startsAt),
			usedDollars,
			limitDollars,
		})
	}
	return { windows, plan, renewsAt }
}

/**
 * Pick a credential out of the stored entries. Pure so the ordering rules are
 * testable: the configured integrations win in order, key credentials before
 * OAuth, and inactive entries never match.
 */
export function selectCredential(
	entries: readonly CredentialEntry[],
	integrationIDs: readonly string[],
	overrideOrgID: string | undefined,
): Credential | undefined {
	const active = entries.filter((entry) => entry.active)
	for (const integrationID of integrationIDs) {
		const matches = active.filter((candidate) => candidate.integrationID === integrationID)
		const key = matches.find((candidate) => candidate.value.type === "key")
		if (key && key.value.type === "key" && key.value.key) {
			return { token: key.value.key, source: `${integrationID} API key`, orgID: overrideOrgID, consoleBase: undefined }
		}
		const oauth = matches.find((candidate) => candidate.value.type === "oauth")
		if (oauth && oauth.value.type === "oauth" && oauth.value.access) {
			const metadata = (oauth.value.metadata ?? {}) as { orgID?: unknown; server?: unknown }
			const orgID = overrideOrgID ?? (typeof metadata.orgID === "string" ? metadata.orgID : undefined)
			const consoleBase = typeof metadata.server === "string" ? metadata.server : undefined
			return { token: oauth.value.access, source: `${integrationID} session`, orgID, consoleBase }
		}
	}
	return undefined
}

/** One-line summary of the windows, for toasts. */
export function summarize(windows: UsageWindow[]): string {
	if (windows.length === 0) return "no quota windows reported"
	return windows.map((window) => `${window.label} ${Math.round(window.usedPercent)}% used`).join(" · ")
}

function money(window: UsageWindow): string {
	if (window.usedDollars === undefined || window.limitDollars === undefined) return ""
	return ` — $${window.usedDollars.toFixed(2)} of $${window.limitDollars.toFixed(2)}`
}

export function detailText(state: UsageState, now = Date.now()): string {
	if (state.phase === "unconfigured") {
		return [
			"No OpenCode Go credential found.",
			"",
			"Subscribe to OpenCode Go and connect with /connect (pick OpenCode Go),",
			"or connect the OpenCode Console. Set OPENCODE_GO_API_KEY to override.",
		].join("\n")
	}
	if (state.phase === "loading") return "Loading usage…"
	if (state.phase === "error" && state.windows.length === 0) return state.detail || "Usage unavailable."
	const lines: string[] = []
	for (const window of state.windows) {
		lines.push(`${window.name}: ${Math.round(window.usedPercent)}% used (${Math.round(100 - window.usedPercent)}% left)${money(window)}`)
		if (window.resetsAt !== undefined) {
			lines.push(`   resets in ${formatDuration(window.resetsAt - now)} — ${new Date(window.resetsAt).toLocaleString()}`)
		}
	}
	lines.push("")
	if (state.plan) {
		const renews = state.renewsAt !== undefined ? ` · renews ${new Date(state.renewsAt).toLocaleDateString()}` : ""
		lines.push(`plan: ${state.plan}${renews}`)
	}
	lines.push(`endpoint: ${state.endpoint}`)
	lines.push(`credential: ${state.credential}`)
	lines.push(`updated: ${new Date(state.updatedAt).toLocaleTimeString()}`)
	if (state.phase === "error") lines.push(`last poll failed: ${state.detail}`)
	return lines.join("\n")
}

function footerText(state: UsageState, now = Date.now()): string {
	if (state.phase === "unconfigured") return "not connected — run /connect"
	if (state.phase === "loading" && state.windows.length === 0) return "loading…"
	if (state.phase === "error" && state.windows.length === 0) return state.detail || "usage unavailable"
	const soonest = state.windows
		.filter((window) => window.resetsAt !== undefined)
		.toSorted((left, right) => (left.resetsAt ?? 0) - (right.resetsAt ?? 0))[0]
	const reset = soonest?.resetsAt !== undefined ? `${soonest.label} resets in ${formatDuration(soonest.resetsAt - now)}` : ""
	if (state.phase === "error") return reset ? `${reset} · stale` : "stale"
	return reset
}

function colorFor(theme: Theme, usedPercent: number): ThemeColor {
	switch (severity(usedPercent)) {
		case "critical":
			return theme.text.feedback.error.base
		case "warn":
			return theme.text.feedback.warning.base
		default:
			return theme.text.feedback.success.base
	}
}

/** Adaptive bar: every segment grows, so the track spans the sidebar width. */
function UsageBar(props: { usedPercent: number; theme: Theme }) {
	const filled = () => filledSegments(props.usedPercent)
	return (
		<box flexDirection="row" flexGrow={1} height={1}>
			<For each={SEGMENTS}>
				{(index) => (
					<box
						height={1}
						flexGrow={1}
						backgroundColor={index < filled() ? colorFor(props.theme, props.usedPercent) : props.theme.border.base}
					/>
				)}
			</For>
		</box>
	)
}

/** Fails soft: a bad endpoint must not take the card or the plugin down. */
async function getJson(url: string, credential: Credential, orgID: string | undefined): Promise<unknown> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${credential.token}`,
		Accept: "application/json",
		"User-Agent": USER_AGENT,
	}
	if (orgID) headers["x-org-id"] = orgID
	const response = await fetch(url, { headers })
	if (!response.ok) {
		const host = new URL(url).host
		if (response.status === 401 || response.status === 403) {
			throw new Error(`${host} rejected the ${credential.source} credential (HTTP ${response.status})`)
		}
		throw new Error(`${host} returned HTTP ${response.status}`)
	}
	return response.json()
}

export default Plugin.define({
	id: "opencode-go-usage.tui",
	setup(context) {
		const options = context.options as {
			apiKey?: string
			integrationIDs?: string[]
			consoleURL?: string
			usageURL?: string
			orgID?: string
			refreshMinutes?: number
		}
		const usageURL = options.usageURL ?? readEnv("OPENCODE_GO_USAGE_URL") ?? DEFAULT_USAGE_URL
		const consoleURL = options.consoleURL ?? readEnv("OPENCODE_GO_CONSOLE_URL") ?? DEFAULT_CONSOLE_URL
		const integrationIDs =
			Array.isArray(options.integrationIDs) && options.integrationIDs.length > 0 ? options.integrationIDs : DEFAULT_INTEGRATION_IDS
		const refreshMinutes =
			typeof options.refreshMinutes === "number" && options.refreshMinutes > 0 ? options.refreshMinutes : DEFAULT_REFRESH_MINUTES
		const overrideOrgID = options.orgID ?? readEnv("OPENCODE_GO_ORG_ID")

		const initial: UsageState = {
			phase: "loading",
			endpoint: "",
			credential: "",
			windows: [],
			plan: "",
			renewsAt: undefined,
			detail: "",
			updatedAt: 0,
		}
		const [usage, setUsage] = context.storage.memory("usage", { initial })
		let polling = false

		/** Console first (what the dashboard renders), zen second. */
		const requestUsage = async (credential: Credential) => {
			const failures: string[] = []
			const consoleBase = credential.consoleBase ?? consoleURL
			if (credential.orgID) {
				try {
					const url = `${consoleBase.replace(/\/+$/, "")}/api/go/status`
					const parsed = parseConsoleStatus(await getJson(url, credential, credential.orgID))
					if (parsed.windows.length > 0) return { endpoint: "console", ...parsed }
					failures.push("console status had no meters")
				} catch (error) {
					failures.push(error instanceof Error ? error.message : String(error))
				}
			} else {
				failures.push("no workspace id for the console endpoint")
			}
			const windows = parseZenUsage(await getJson(usageURL, credential, undefined).catch((error) => {
				throw new Error(failures.length > 0 ? `${String(error)} (console: ${failures[0]})` : String(error))
			}))
			if (windows.length === 0) throw new Error("usage response carried no quota windows")
			return { endpoint: "zen", windows, plan: "", renewsAt: undefined }
		}

		const refresh = async (announce = false): Promise<void> => {
			if (polling) return
			polling = true
			try {
				const optionKey = options.apiKey
				const envKey = optionKey ? undefined : readEnv("OPENCODE_GO_API_KEY")
				const override = optionKey ?? envKey
				const stored = override ? [] : await context.client.credential.list()
				const credential = override
					? { token: override, source: optionKey ? "plugin option" : "OPENCODE_GO_API_KEY", orgID: overrideOrgID, consoleBase: undefined }
					: selectCredential(stored, integrationIDs, overrideOrgID)
				if (!credential) {
					setUsage((draft) => {
						draft.phase = "unconfigured"
						draft.endpoint = ""
						draft.credential = ""
						draft.windows = []
						draft.plan = ""
						draft.detail = ""
					})
					if (announce) {
						context.ui.toast.show({
							title: "OpenCode Go",
							message: "No credential found. Connect with /connect, then pick OpenCode Go.",
							variant: "warning",
						})
					}
					return
				}
				const result = await requestUsage(credential)
				setUsage((draft) => {
					draft.phase = "ready"
					draft.endpoint = result.endpoint
					draft.credential = credential.source
					draft.windows = result.windows
					draft.plan = result.plan
					draft.renewsAt = result.renewsAt
					draft.detail = ""
					draft.updatedAt = Date.now()
				})
				if (announce) {
					context.ui.toast.show({ title: "OpenCode Go", message: summarize(result.windows), variant: "info" })
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				setUsage((draft) => {
					draft.phase = "error"
					draft.detail = message
				})
				if (announce) context.ui.toast.show({ title: "OpenCode Go", message, variant: "error" })
			} finally {
				polling = false
			}
		}

		// Poll on a timer, and after a run finishes so the numbers stay current.
		const poll = (): void => {
			if (Date.now() - usage.updatedAt < MIN_POLL_INTERVAL_MS) return
			void refresh(false)
		}
		const timer = setInterval(poll, Math.max(1, refreshMinutes) * 60_000)
		const stopExecutions = context.data.on("session.execution.succeeded", poll)
		void refresh(false)

		const UsageCard = () => {
			const plugin = usePlugin()
			const theme = () => plugin.theme
			return (
				<box flexDirection="column">
					<text fg={theme().text.base}>{"OpenCode Go · used"}</text>
					<For each={usage.windows}>
						{(window) => (
							<box flexDirection="row" height={1}>
								<text fg={theme().text.muted}>{`${window.label} `}</text>
								<UsageBar usedPercent={window.usedPercent} theme={theme()} />
								<text fg={colorFor(theme(), window.usedPercent)}>{` ${String(Math.round(window.usedPercent)).padStart(3)}%`}</text>
							</box>
						)}
					</For>
					<Show when={footerText(usage)}>
						<text fg={usage.phase === "error" ? theme().text.feedback.error.base : theme().text.muted}>{footerText(usage)}</text>
					</Show>
				</box>
			)
		}

		// keymap.layer() needs a Solid owner: setup() is not a component, so the
		// commands register from a always-mounted slot instead.
		const UsageCommands = () => {
			const plugin = usePlugin()
			plugin.keymap.layer(() => ({
				mode: "global",
				commands: [
					{
						id: "opencode-go.usage",
						title: "Show OpenCode Go usage",
						group: "OpenCode Go",
						palette: true,
						slash: { name: "go-usage", aliases: ["usage-go"] },
						run: () => plugin.ui.dialog.alert({ title: "OpenCode Go usage", message: detailText(usage) }),
					},
					{
						id: "opencode-go.usage.refresh",
						title: "Refresh OpenCode Go usage",
						group: "OpenCode Go",
						palette: true,
						run: () => refresh(true),
					},
				],
			}))
			return null
		}

		const unregisterCard = context.ui.slot({
			append: "sidebar.content",
			render: () => <UsageCard />,
		})
		const unregisterCommands = context.ui.slot({
			append: "app",
			render: () => <UsageCommands />,
		})

		return () => {
			clearInterval(timer)
			stopExecutions()
			unregisterCard()
			unregisterCommands()
		}
	},
})
