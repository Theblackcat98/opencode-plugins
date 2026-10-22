/**
 * Backend clients for the research plugin.
 *
 * Four independent upstreams, each with a different strength:
 *
 *   - Tavily       web search already shaped for agents, plus site mapping
 *   - Exa          neural/semantic search, and finding pages like a known URL
 *   - Firecrawl    page scraping, site crawling, structured extraction
 *   - Jina AI      URL -> LLM-ready markdown, works without an API key
 *
 * Every call takes a ResearchConfig plus an AbortSignal and throws a
 * ProviderError naming the backend, so the caller knows whether a fallback is
 * worth trying. Input problems throw InputError instead: a fallback would
 * fail the same way, so it must not be attempted.
 */

export type Backend = "tavily" | "exa" | "firecrawl" | "jina"

export class ProviderError extends Error {
	readonly backend: Backend
	readonly status?: number
	/** Delay the server asked for, from a Retry-After header. */
	readonly retryAfterMs?: number
	constructor(backend: Backend, message: string, status?: number, retryAfterMs?: number) {
		super(message)
		this.name = "ProviderError"
		this.backend = backend
		this.status = status
		this.retryAfterMs = retryAfterMs
	}
}

/** Bad input from the model. Never triggers a fallback. */
export class InputError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "InputError"
	}
}

export interface ResearchConfig {
	readonly tavilyKey?: string
	readonly exaKey?: string
	readonly firecrawlKey?: string
	readonly jinaKey?: string
	readonly allowPrivateUrls: boolean
	readonly requestTimeoutMs: number
	readonly crawlTimeoutMs: number
	/** How many times a retryable failure is retried. 0 disables retry. */
	readonly retryAttempts: number
	readonly retryBaseDelayMs: number
	/** Optional sink for retry diagnostics, so the plugin log explains a slow call. */
	readonly retryLog?: (message: string) => void
}

export const TAVILY_BASE = "https://api.tavily.com"
export const EXA_BASE = "https://api.exa.ai"
export const FIRECRAWL_BASE = "https://api.firecrawl.dev/v2"
export const JINA_READER_BASE = "https://r.jina.ai"
export const JINA_SEARCH_BASE = "https://s.jina.ai"

export const INTERNALS = {
	asRecord,
	firstString,
	isPrivateHostname,
	clamp,
	resolveConfig,
	normalizeTavilySearch,
	normalizeExaSearch,
	normalizeJinaSearch,
	normalizeFirecrawlPage,
	normalizeFirecrawlCrawl,
	normalizeFirecrawlExtract,
	normalizeTavilyExtract,
	extractErrorMessage,
	parseJinaText,
	publishedDateSince,
	fetchJson,
	fetchText,
	withRetry,
	isRetryableStatus,
	parseRetryAfter,
	retryDelayMs,
	normalizeHost,
	hostMatchesDomain,
	filterResultsByDomain,
	describeUnsupportedFilters,
	normalizeUrl,
	mergeSearchResults,
}

// ---------------------------------------------------------------- config ----

export function resolveConfig(
	options: Readonly<Record<string, any>>,
	env: Readonly<Record<string, string | undefined>>,
): ResearchConfig {
	const pick = (optionName: string, ...envNames: string[]): string | undefined => {
		const fromOption = typeof options[optionName] === "string" ? (options[optionName] as string).trim() : ""
		if (fromOption) return fromOption
		for (const name of envNames) {
			const value = env[name]
			if (typeof value === "string" && value.trim()) return value.trim()
		}
		return undefined
	}
	const pickNumber = (optionName: string, envName: string, fallback: number): number => {
		const fromOption = Number(options[optionName])
		if (Number.isFinite(fromOption) && fromOption > 0) return fromOption
		const fromEnv = Number(env[envName])
		if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv
		return fallback
	}
	// A count may legitimately be 0 (retry disabled), so this one differs from pickNumber.
	const pickCount = (optionName: string, envName: string, fallback: number): number => {
		const fromOption = options[optionName]
		if (typeof fromOption === "number" && Number.isInteger(fromOption) && fromOption >= 0) return fromOption
		const rawEnv = env[envName]
		const fromEnv = Number(rawEnv)
		if (rawEnv !== undefined && rawEnv !== "" && Number.isInteger(fromEnv) && fromEnv >= 0) return fromEnv
		return fallback
	}
	return {
		tavilyKey: pick("tavilyKey", "TAVILY_API_KEY", "TVLY_API_KEY"),
		exaKey: pick("exaKey", "EXA_API_KEY"),
		firecrawlKey: pick("firecrawlKey", "FIRECRAWL_API_KEY", "FIRECRAWL_KEY"),
		jinaKey: pick("jinaKey", "JINA_API_KEY", "JINA_AI_API_KEY"),
		allowPrivateUrls: options.allowPrivateUrls === true,
		requestTimeoutMs: pickNumber("requestTimeoutMs", "RESEARCH_REQUEST_TIMEOUT_MS", 60_000),
		crawlTimeoutMs: pickNumber("crawlTimeoutMs", "RESEARCH_CRAWL_TIMEOUT_MS", 180_000),
		retryAttempts: pickCount("retryAttempts", "RESEARCH_RETRY_ATTEMPTS", 2),
		retryBaseDelayMs: pickNumber("retryBaseDelayMs", "RESEARCH_RETRY_BASE_DELAY_MS", 1_000),
	}
}

// ----------------------------------------------------------------- utils ----

export function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
	return value as Record<string, unknown>
}

export function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value
	}
	return undefined
}

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min
	return Math.min(Math.max(Math.round(value), min), max)
}

export function extractErrorMessage(body: unknown): string | undefined {
	const record = asRecord(body)
	if (!record) return undefined
	for (const key of ["error", "message", "detail", "error_description"]) {
		const value = record[key]
		if (typeof value === "string" && value.trim()) return value
		const nested = asRecord(value)
		if (nested) {
			const inner = firstString(nested.message, nested.error)
			if (inner) return inner
		}
	}
	return undefined
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				resolve()
			},
			{ once: true },
		)
	})

/**
 * Combine the caller's signal with a request timeout. AbortSignal.any is
 * available in Bun and Node 20.3+, but the manual path keeps the plugin
 * usable on older runtimes.
 */
function linkSignals(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; done: () => void } {
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
	const onAbort = () => controller.abort(signal?.reason)
	if (signal) {
		if (signal.aborted) onAbort()
		else signal.addEventListener("abort", onAbort, { once: true })
	}
	return {
		signal: controller.signal,
		done: () => {
			clearTimeout(timer)
			signal?.removeEventListener("abort", onAbort)
		},
	}
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

async function fetchJsonOnce(
	backend: Backend,
	url: string,
	init: RequestInit,
	cfg: ResearchConfig,
	signal?: AbortSignal,
): Promise<unknown> {
	const link = linkSignals(signal, cfg.requestTimeoutMs)
	try {
		const response = await fetch(url, { ...init, signal: link.signal })
		const text = await response.text()
		let body: unknown
		if (text) {
			try {
				body = JSON.parse(text)
			} catch {
				body = undefined
			}
		}
		if (!response.ok) {
			const detail = extractErrorMessage(body) ?? text.slice(0, 300).trim()
			throw new ProviderError(
				backend,
				`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
				response.status,
				parseRetryAfter(response.headers.get("retry-after")),
			)
		}
		if (body === undefined) throw new ProviderError(backend, "Response was not valid JSON")
		return body
	} catch (error) {
		if (error instanceof ProviderError) throw error
		if (signal?.aborted) throw new ProviderError(backend, "Request cancelled")
		throw new ProviderError(backend, `Request failed: ${describeError(error)}`)
	} finally {
		link.done()
	}
}

async function fetchTextOnce(
	backend: Backend,
	url: string,
	init: RequestInit,
	cfg: ResearchConfig,
	signal?: AbortSignal,
): Promise<string> {
	const link = linkSignals(signal, cfg.requestTimeoutMs)
	try {
		const response = await fetch(url, { ...init, signal: link.signal })
		const text = await response.text()
		if (!response.ok) {
			const detail = extractErrorMessage(text) ?? text.slice(0, 300).trim()
			throw new ProviderError(
				backend,
				`${response.status} ${response.statusText}${detail ? `: ${detail}` : ""}`,
				response.status,
				parseRetryAfter(response.headers.get("retry-after")),
			)
		}
		return text
	} catch (error) {
		if (error instanceof ProviderError) throw error
		if (signal?.aborted) throw new ProviderError(backend, "Request cancelled")
		throw new ProviderError(backend, `Request failed: ${describeError(error)}`)
	} finally {
		link.done()
	}
}

// ----------------------------------------------------------------- retry ----

/** 429 and 5xx can pass on a second try; 4xx cannot. */
export function isRetryableStatus(status: number | undefined): boolean {
	if (status === undefined) return false
	return status === 429 || (status >= 500 && status <= 599)
}

/** Retry-After is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
	if (!value) return undefined
	const trimmed = value.trim()
	if (!trimmed) return undefined
	const seconds = Number(trimmed)
	if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000)
	const date = Date.parse(trimmed)
	if (Number.isFinite(date)) return Math.max(0, date - now)
	return undefined
}

/**
 * Exponential backoff with up to 25 percent jitter, so parallel sessions do
 * not resynchronise after a shared rate limit. A server-provided delay wins,
 * but is capped so a hostile header cannot stall the call.
 */
export function retryDelayMs(
	attempt: number,
	retryAfterMs: number | undefined,
	baseMs: number,
	capMs: number,
	random: () => number = Math.random,
): number {
	const exponential = baseMs * 4 ** Math.max(0, attempt - 1)
	const base = retryAfterMs !== undefined ? Math.min(retryAfterMs, capMs) : Math.min(exponential, capMs)
	const jittered = base + base * 0.25 * random()
	return Math.round(Math.min(jittered, Math.max(0, capMs)))
}

function isRetryableError(error: ProviderError): boolean {
	if (error.status !== undefined) return isRetryableStatus(error.status)
	// A network failure is worth one more try. A timeout or a caller abort is not:
	// the request may already have reached the provider.
	return !/timed out|cancel/i.test(error.message)
}

/** Bounded retry around one provider call. Cancellable at every step. */
async function withRetry<T>(
	backend: Backend,
	cfg: ResearchConfig,
	signal: AbortSignal | undefined,
	attempt: (attemptNumber: number) => Promise<T>,
): Promise<T> {
	const maxAttempts = 1 + Math.max(0, Math.floor(cfg.retryAttempts))
	for (let number = 1; ; number += 1) {
		if (signal?.aborted) throw new ProviderError(backend, "Request cancelled")
		try {
			return await attempt(number)
		} catch (error) {
			if (!(error instanceof ProviderError) || !isRetryableError(error) || number >= maxAttempts) {
				if (error instanceof ProviderError && number >= maxAttempts && isRetryableError(error)) {
					cfg.retryLog?.(`giving up on ${backend} after ${number} attempt(s): ${error.message}`)
				}
				throw error
			}
			const delay = retryDelayMs(number, error.retryAfterMs, cfg.retryBaseDelayMs, cfg.requestTimeoutMs)
			cfg.retryLog?.(
				`retrying ${backend} in ${delay}ms (attempt ${number + 1}/${maxAttempts}, ${
					error.status !== undefined ? `status ${error.status}` : "network error"
				}): ${error.message}`,
			)
			await sleep(delay, signal)
			if (signal?.aborted) throw new ProviderError(backend, "Request cancelled")
		}
	}
}

async function fetchJson(
	backend: Backend,
	url: string,
	init: RequestInit,
	cfg: ResearchConfig,
	signal?: AbortSignal,
	retry = true,
): Promise<unknown> {
	if (!retry) return fetchJsonOnce(backend, url, init, cfg, signal)
	return withRetry(backend, cfg, signal, () => fetchJsonOnce(backend, url, init, cfg, signal))
}

async function fetchText(
	backend: Backend,
	url: string,
	init: RequestInit,
	cfg: ResearchConfig,
	signal?: AbortSignal,
): Promise<string> {
	return withRetry(backend, cfg, signal, () => fetchTextOnce(backend, url, init, cfg, signal))
}

// -------------------------------------------------------------- url guard ---

const BLOCKED_HOSTNAMES = new Set([
	"localhost",
	"0.0.0.0",
	"::",
	"::1",
	"metadata.google.internal",
	"metadata.goog",
	"instance-data",
])

/**
 * Best-effort private address check. Hostname based, so a public name that
 * resolves to a private address still passes. Documented as such in the
 * plugin README.
 */
export function isPrivateHostname(hostname: string): boolean {
	const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
	if (!host) return true
	if (BLOCKED_HOSTNAMES.has(host)) return true
	if (host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return true
	if (host.includes(":")) {
		// IPv6 literal.
		if (host === "::1" || host === "::") return true
		if (/^f[cd]/.test(host)) return true
		if (/^fe[89ab]/.test(host)) return true
		return false
	}
	const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
	if (!match) return false
	const a = Number(match[1])
	const b = Number(match[2])
	if (a === 0 || a === 10 || a === 127) return true
	if (a === 192 && b === 168) return true
	if (a === 172 && b >= 16 && b <= 31) return true
	if (a === 169 && b === 254) return true
	if (a === 100 && b >= 64 && b <= 127) return true
	if (a >= 224) return true
	return false
}

/** Validate a web target. Throws InputError so callers do not fall back. */
export function assertWebUrl(raw: string, allowPrivate: boolean): URL {
	let parsed: URL
	try {
		parsed = new URL(raw)
	} catch {
		throw new InputError(`Not a valid absolute URL: ${raw}`)
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new InputError(`Only http and https URLs are supported, got ${parsed.protocol}`)
	}
	if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
		throw new InputError(
			`Refusing to fetch a private or loopback address (${parsed.hostname}). Set the plugin option "allowPrivateUrls" to allow it.`,
		)
	}
	return parsed
}

// --------------------------------------------------------------- results ----

export interface SearchResult {
	readonly title: string
	readonly url: string
	readonly snippet: string
	readonly score?: number
	readonly content?: string
}

export interface SearchOutcome {
	readonly backend: Backend
	readonly answer?: string
	readonly results: readonly SearchResult[]
	/** Set when a backend applied a local domain filter to the raw result list. */
	readonly filter?: { readonly returned: number; readonly removed: number }
}

// ------------------------------------------------------- search filters ----

/**
 * A domain matches on an exact host or a subdomain, so "example.com" covers
 * "docs.example.com" but not the lookalike "example.com.evil.net".
 */
export function normalizeHost(hostname: string): string {
	return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "")
}

function normalizeDomainFilter(value: string): string {
	let domain = value.trim().toLowerCase()
	if (!domain) return ""
	if (domain.includes("://")) {
		try {
			domain = new URL(domain).hostname
		} catch {
			// Keep the raw text; the match below simply fails.
		}
	}
	domain = domain.replace(/^\*\./, "")
	return normalizeHost(domain)
}

export function hostMatchesDomain(hostname: string, domain: string): boolean {
	const host = normalizeHost(hostname)
	const target = normalizeDomainFilter(domain)
	if (!host || !target) return false
	return host === target || host.endsWith(`.${target}`)
}

/**
 * Jina search has no domain filter of its own, so the list is filtered here.
 * Filtering happens before the caller slices to its limit, so the limit still
 * returns the requested number of usable results when enough remain.
 */
export function filterResultsByDomain(
	results: readonly SearchResult[],
	filters: { includeDomains?: readonly string[]; excludeDomains?: readonly string[] },
): { results: SearchResult[]; returned: number; removed: number } {
	const includes = (filters.includeDomains ?? []).filter((entry) => entry.trim() !== "")
	const excludes = (filters.excludeDomains ?? []).filter((entry) => entry.trim() !== "")
	if (!includes.length && !excludes.length) {
		return { results: [...results], returned: results.length, removed: 0 }
	}
	const kept: SearchResult[] = []
	for (const result of results) {
		let host: string
		try {
			host = new URL(result.url).hostname
		} catch {
			// A result whose URL cannot be parsed cannot be proven to satisfy the
			// filter, so it is dropped rather than passed through.
			continue
		}
		if (includes.length && !includes.some((domain) => hostMatchesDomain(host, domain))) continue
		if (excludes.some((domain) => hostMatchesDomain(host, domain))) continue
		kept.push(result)
	}
	return { results: kept, returned: results.length, removed: results.length - kept.length }
}

/**
 * State the filters a backend could not apply, instead of letting the model
 * believe the result set obeys a rule that was never enforced.
 */
export function describeUnsupportedFilters(
	backend: Backend,
	requested: { timeRange?: unknown; days?: unknown; includeAnswer?: unknown; topic?: unknown },
): string[] {
	if (backend !== "jina") return []
	const notes: string[] = []
	if (requested.timeRange !== undefined || requested.days !== undefined) {
		notes.push("jina search results carry no publication date, so the time window was not applied")
	}
	if (typeof requested.topic === "string" && requested.topic !== "general") {
		notes.push(`jina search has no "${requested.topic}" topic filter`)
	}
	if (requested.includeAnswer === true) {
		notes.push("jina search returns no generated answer")
	}
	return notes
}

// ---------------------------------------------------------- merge search ----

/** Parameters that never change which page a result points at. */
const TRACKING_PARAMS = new Set([
	"fbclid",
	"gclid",
	"msclkid",
	"yclid",
	"mc_cid",
	"mc_eid",
	"igshid",
	"ref_src",
	"ref_url",
	"_hsenc",
	"_hsmi",
	"spm",
])

/**
 * The deduplication key for a URL: lower-case host without "www.", no
 * fragment, no tracking parameters, no default port and no trailing slash.
 */
export function normalizeUrl(raw: string): string {
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		return raw.trim().toLowerCase()
	}
	const host = url.hostname.toLowerCase().replace(/^www\./, "")
	const defaultPort =
		(url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")
	const port = url.port && !defaultPort ? `:${url.port}` : ""
	const path = url.pathname.replace(/\/+$/, "")
	const params = [...url.searchParams.entries()]
		.filter(([key]) => {
			const name = key.toLowerCase()
			return !TRACKING_PARAMS.has(name) && !name.startsWith("utm_")
		})
		.sort(([a], [b]) => a.localeCompare(b))
	const search = params.length ? `?${new URLSearchParams(params).toString()}` : ""
	return `${host}${port}${path}${search}`
}

export interface MergedSearchResult extends SearchResult {
	/** Every engine that returned this URL, in merge order. */
	readonly engines: readonly Backend[]
	/** 1-based rank per engine. */
	readonly positions: Readonly<Record<string, number>>
}

export interface MergedSearchOutcome {
	readonly results: readonly MergedSearchResult[]
	readonly answered: readonly Backend[]
	readonly failed: readonly { readonly backend: Backend; readonly error: string }[]
	/** Same URL ranked far apart by two engines: a weak ranking, worth a read. */
	readonly disagreements: readonly { readonly url: string; readonly title: string; readonly positions: readonly number[] }[]
}

/** Rank gap that counts as a disagreement between engines. */
export const MERGE_POSITION_GAP = 5

/**
 * Combine result lists without losing order: the first engine's ranking, then
 * what each later engine adds. A URL found by two engines appears once and
 * keeps both labels, because agreement between engines is the strongest signal
 * in the set.
 */
export function mergeSearchResults(
	lists: readonly { readonly backend: Backend; readonly results: readonly SearchResult[] }[],
): MergedSearchOutcome {
	const order: string[] = []
	const merged = new Map<string, { result: MergedSearchResult; engines: Backend[]; positions: Record<string, number> }>()
	const answered: Backend[] = []
	for (const list of lists) {
		answered.push(list.backend)
		list.results.forEach((result, index) => {
			const key = normalizeUrl(result.url)
			const existing = merged.get(key)
			if (existing) {
				if (!existing.engines.includes(list.backend)) existing.engines.push(list.backend)
				existing.positions[list.backend] = index + 1
				return
			}
			const entry = {
				result: {
					title: result.title,
					url: result.url,
					snippet: result.snippet,
					score: result.score,
					content: result.content,
					engines: [] as Backend[],
					positions: {} as Record<string, number>,
				},
				engines: [list.backend],
				positions: { [list.backend]: index + 1 },
			}
			order.push(key)
			merged.set(key, entry)
		})
	}
	const results: MergedSearchResult[] = []
	const disagreements: { url: string; title: string; positions: number[] }[] = []
	for (const key of order) {
		const entry = merged.get(key)
		if (!entry) continue
		const result: MergedSearchResult = {
			...entry.result,
			engines: [...entry.engines],
			positions: { ...entry.positions },
		}
		results.push(result)
		const ranks = Object.values(entry.positions)
		if (ranks.length >= 2 && Math.max(...ranks) - Math.min(...ranks) >= MERGE_POSITION_GAP) {
			disagreements.push({ url: result.url, title: result.title, positions: ranks.slice().sort((a, b) => a - b) })
		}
	}
	return { results, answered, failed: [], disagreements }
}

export interface PageResult {
	readonly url: string
	readonly title: string
	readonly content: string
	readonly metadata?: Record<string, unknown>
}

export interface ExtractOutcome {
	readonly backend: Backend
	readonly data: unknown
	readonly failed: readonly { url: string; error: string }[]
}

// --------------------------------------------------------------- tavily -----

export interface TavilySearchParams {
	query: string
	maxResults?: number
	depth?: "basic" | "advanced"
	topic?: "general" | "news" | "finance"
	timeRange?: "day" | "week" | "month" | "year"
	days?: number
	includeDomains?: string[]
	excludeDomains?: string[]
	includeAnswer?: boolean
	includeRawContent?: boolean
}

export function normalizeTavilySearch(raw: unknown): SearchOutcome {
	const body = asRecord(raw)
	const list = Array.isArray(body?.results) ? body.results : []
	const results: SearchResult[] = []
	for (const item of list) {
		const record = asRecord(item)
		if (!record) continue
		const url = firstString(record.url)
		if (!url) continue
		results.push({
			title: firstString(record.title) ?? url,
			url,
			snippet: firstString(record.content) ?? "",
			score: typeof record.score === "number" ? record.score : undefined,
			content: firstString(record.raw_content),
		})
	}
	return {
		backend: "tavily",
		answer: firstString(body?.answer),
		results,
	}
}

export async function tavilySearch(
	cfg: ResearchConfig,
	params: TavilySearchParams,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	if (!cfg.tavilyKey) throw new ProviderError("tavily", "Tavily API key is not configured")
	const body: Record<string, unknown> = {
		api_key: cfg.tavilyKey,
		query: params.query,
		search_depth: params.depth ?? "basic",
		topic: params.topic ?? "general",
		max_results: clamp(params.maxResults ?? 8, 1, 20),
		include_answer: params.includeAnswer ? "advanced" : false,
		include_raw_content: params.includeRawContent ? "markdown" : false,
	}
	if (params.timeRange) body.time_range = params.timeRange
	if (params.days !== undefined) body.days = clamp(params.days, 1, 30)
	if (params.includeDomains?.length) body.include_domains = params.includeDomains
	if (params.excludeDomains?.length) body.exclude_domains = params.excludeDomains
	const json = await fetchJson(
		"tavily",
		`${TAVILY_BASE}/search`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.tavilyKey}`,
			},
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	return normalizeTavilySearch(json)
}

export async function tavilyMap(
	cfg: ResearchConfig,
	url: string,
	opts: { limit?: number; maxDepth?: number; instructions?: string },
	signal?: AbortSignal,
): Promise<string[]> {
	if (!cfg.tavilyKey) throw new ProviderError("tavily", "Tavily API key is not configured")
	const body: Record<string, unknown> = { url }
	if (opts.limit !== undefined) body.limit = clamp(opts.limit, 1, 500)
	if (opts.maxDepth !== undefined) body.max_depth = clamp(opts.maxDepth, 1, 10)
	if (opts.instructions) body.instructions = opts.instructions
	const json = await fetchJson(
		"tavily",
		`${TAVILY_BASE}/map`,
		{
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.tavilyKey}` },
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	const record = asRecord(json)
	const list = Array.isArray(record?.results) ? record.results : []
	return list.filter((entry): entry is string => typeof entry === "string")
}

export function normalizeTavilyExtract(raw: unknown): ExtractOutcome {
	const record = asRecord(raw)
	const list = Array.isArray(record?.results) ? record.results : []
	const failedRaw = Array.isArray(record?.failed_results) ? record.failed_results : []
	const pages: Record<string, string> = {}
	for (const item of list) {
		const entry = asRecord(item)
		const url = firstString(entry?.url)
		if (!url) continue
		pages[url] = firstString(entry?.raw_content, entry?.content) ?? ""
	}
	const failed: { url: string; error: string }[] = []
	for (const item of failedRaw) {
		const entry = asRecord(item)
		failed.push({ url: firstString(entry?.url) ?? "(unknown url)", error: firstString(entry?.error) ?? "unknown error" })
	}
	return { backend: "tavily", data: pages, failed }
}

export async function tavilyExtract(
	cfg: ResearchConfig,
	urls: readonly string[],
	opts: { query?: string; format?: "markdown" | "text"; depth?: "basic" | "advanced" },
	signal?: AbortSignal,
): Promise<ExtractOutcome> {
	if (!cfg.tavilyKey) throw new ProviderError("tavily", "Tavily API key is not configured")
	if (!urls.length) throw new InputError("At least one URL is required")
	const body: Record<string, unknown> = {
		urls: urls.slice(0, 20),
		extract_depth: opts.depth ?? "advanced",
		format: opts.format ?? "markdown",
	}
	if (opts.query) body.query = opts.query
	const json = await fetchJson(
		"tavily",
		`${TAVILY_BASE}/extract`,
		{
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.tavilyKey}` },
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	return normalizeTavilyExtract(json)
}

// ------------------------------------------------------------------ exa ----

export type ExaSearchType = "auto" | "neural" | "keyword" | "fast"

export interface ExaSearchParams {
	query: string
	maxResults?: number
	type?: ExaSearchType
	includeDomains?: string[]
	excludeDomains?: string[]
	startPublishedDate?: string
	endPublishedDate?: string
	includeRawContent?: boolean
}

/**
 * Exa returns matching passages as `highlights` and a one-line `summary` per
 * result. The highlight is the better snippet, the summary is the fallback.
 */
export function normalizeExaSearch(raw: unknown): SearchOutcome {
	const body = asRecord(raw)
	const list = Array.isArray(body?.results) ? body.results : []
	const results: SearchResult[] = []
	for (const item of list) {
		const record = asRecord(item)
		if (!record) continue
		const url = firstString(record.url)
		if (!url) continue
		const highlights = Array.isArray(record.highlights)
			? record.highlights.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
			: []
		results.push({
			title: firstString(record.title) ?? url,
			url,
			snippet: highlights[0] ?? firstString(record.summary) ?? "",
			score: typeof record.score === "number" ? record.score : undefined,
			content: firstString(record.text),
		})
	}
	return { backend: "exa", results }
}

/** ISO date for "N days ago", used to translate a relative time window. */
export function publishedDateSince(days: number, now = new Date()): string {
	const date = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)
	return date.toISOString()
}

export async function exaSearch(
	cfg: ResearchConfig,
	params: ExaSearchParams,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	if (!cfg.exaKey) throw new ProviderError("exa", "Exa API key is not configured")
	const body: Record<string, unknown> = {
		query: params.query,
		numResults: clamp(params.maxResults ?? 8, 1, 100),
		type: params.type ?? "auto",
		contents: params.includeRawContent
			? { text: true, highlights: true }
			: { highlights: true, summary: true },
	}
	if (params.includeDomains?.length) body.includeDomains = params.includeDomains
	if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains
	if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate
	if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate
	const json = await fetchJson(
		"exa",
		`${EXA_BASE}/search`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": cfg.exaKey },
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	return normalizeExaSearch(json)
}

/**
 * Find pages like a known URL. This is the one capability in the plugin that
 * no other backend offers, and it is the cheapest way to gather the rest of a
 * body of work once one good source is known.
 */
export async function exaFindSimilar(
	cfg: ResearchConfig,
	url: string,
	opts: {
		maxResults?: number
		excludeSourceDomain?: boolean
		includeDomains?: string[]
		excludeDomains?: string[]
	},
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	if (!cfg.exaKey) throw new ProviderError("exa", "Exa API key is not configured")
	const body: Record<string, unknown> = {
		url,
		numResults: clamp(opts.maxResults ?? 8, 1, 100),
		contents: { highlights: true, summary: true },
	}
	if (opts.excludeSourceDomain) body.excludeSourceDomain = true
	if (opts.includeDomains?.length) body.includeDomains = opts.includeDomains
	if (opts.excludeDomains?.length) body.excludeDomains = opts.excludeDomains
	const json = await fetchJson(
		"exa",
		`${EXA_BASE}/findSimilar`,
		{
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": cfg.exaKey },
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	return normalizeExaSearch(json)
}

// ------------------------------------------------------------- firecrawl ----

export function normalizeFirecrawlPage(raw: unknown, fallbackUrl: string): PageResult {
	const body = asRecord(raw)
	const data = asRecord(body?.data) ?? body ?? {}
	const metadata = asRecord(data.metadata) ?? {}
	return {
		url: firstString(metadata.sourceURL, metadata.url, data.url) ?? fallbackUrl,
		title: firstString(metadata.title, data.title) ?? "",
		content: firstString(data.markdown, data.content, data.text, data.html) ?? "",
		metadata,
	}
}

export function normalizeFirecrawlCrawl(raw: unknown): PageResult[] {
	const body = asRecord(raw)
	const list = Array.isArray(body?.data) ? body.data : []
	const pages: PageResult[] = []
	for (const item of list) {
		const record = asRecord(item)
		if (!record) continue
		const metadata = asRecord(record.metadata) ?? {}
		const url = firstString(metadata.sourceURL, metadata.url)
		pages.push({
			url: url ?? "",
			title: firstString(metadata.title, record.title) ?? "",
			content: firstString(record.markdown, record.content, record.text, record.html) ?? "",
			metadata,
		})
	}
	return pages
}

export function normalizeFirecrawlExtract(raw: unknown): ExtractOutcome {
	const body = asRecord(raw)
	const data = body?.data
	return {
		backend: "firecrawl",
		data: data === undefined ? body : data,
		failed: [],
	}
}

export async function firecrawlScrape(
	cfg: ResearchConfig,
	url: string,
	opts: { format?: "markdown" | "text" | "html"; onlyMainContent?: boolean; waitFor?: number },
	signal?: AbortSignal,
): Promise<PageResult> {
	if (!cfg.firecrawlKey) throw new ProviderError("firecrawl", "Firecrawl API key is not configured")
	const body: Record<string, unknown> = {
		url,
		formats: [opts.format === "html" ? "html" : opts.format === "text" ? "markdown" : "markdown"],
		onlyMainContent: opts.onlyMainContent !== false,
	}
	if (opts.waitFor !== undefined) body.waitFor = clamp(opts.waitFor, 0, 60_000)
	const json = await fetchJson(
		"firecrawl",
		`${FIRECRAWL_BASE}/scrape`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.firecrawlKey}`,
			},
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	return normalizeFirecrawlPage(json, url)
}

export async function firecrawlCrawl(
	cfg: ResearchConfig,
	url: string,
	opts: {
		limit?: number
		maxDepth?: number
		includePaths?: string[]
		excludePaths?: string[]
		allowSubdomains?: boolean
	},
	signal?: AbortSignal,
): Promise<PageResult[]> {
	if (!cfg.firecrawlKey) throw new ProviderError("firecrawl", "Firecrawl API key is not configured")
	const body: Record<string, unknown> = { url, limit: clamp(opts.limit ?? 20, 1, 100) }
	if (opts.maxDepth !== undefined) body.maxDiscoveryDepth = clamp(opts.maxDepth, 0, 10)
	if (opts.includePaths?.length) body.includePaths = opts.includePaths
	if (opts.excludePaths?.length) body.excludePaths = opts.excludePaths
	if (opts.allowSubdomains !== undefined) body.allowSubdomains = opts.allowSubdomains
	const started = await fetchJson(
		"firecrawl",
		`${FIRECRAWL_BASE}/crawl`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.firecrawlKey}`,
			},
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	const jobID = firstString(asRecord(started)?.id)
	if (!jobID) throw new ProviderError("firecrawl", "Crawl did not return a job id")

	const deadline = Date.now() + cfg.crawlTimeoutMs
	for (;;) {
		// The polling loop has its own deadline and sleep, so it does not retry:
		// a slow job would otherwise stack backoff on top of its own wait.
		const status = await fetchJson(
			"firecrawl",
			`${FIRECRAWL_BASE}/crawl/${jobID}`,
			{ headers: { authorization: `Bearer ${cfg.firecrawlKey}` } },
			cfg,
			signal,
			false,
		)
		const record = asRecord(status)
		const state = firstString(record?.status) ?? "unknown"
		if (state === "completed") return normalizeFirecrawlCrawl(record)
		if (state === "failed" || state === "cancelled" || state === "error") {
			throw new ProviderError("firecrawl", `Crawl job ${state}`)
		}
		if (Date.now() > deadline) {
			throw new ProviderError("firecrawl", `Crawl did not finish within ${cfg.crawlTimeoutMs}ms`)
		}
		await sleep(2_000, signal)
	}
}

export async function firecrawlMap(
	cfg: ResearchConfig,
	url: string,
	opts: { limit?: number; includeSubdomains?: boolean },
	signal?: AbortSignal,
): Promise<string[]> {
	if (!cfg.firecrawlKey) throw new ProviderError("firecrawl", "Firecrawl API key is not configured")
	const body: Record<string, unknown> = { url }
	if (opts.limit !== undefined) body.limit = clamp(opts.limit, 1, 500)
	if (opts.includeSubdomains !== undefined) body.includeSubdomains = opts.includeSubdomains
	const json = await fetchJson(
		"firecrawl",
		`${FIRECRAWL_BASE}/map`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.firecrawlKey}`,
			},
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	const record = asRecord(json)
	const data = asRecord(record?.data) ?? record
	const list = Array.isArray(data?.links) ? data.links : Array.isArray(data?.results) ? data.results : []
	return list.filter((entry): entry is string => typeof entry === "string")
}

export async function firecrawlExtract(
	cfg: ResearchConfig,
	urls: readonly string[],
	opts: { prompt?: string; schema?: Record<string, unknown>; enableWebSearch?: boolean },
	signal?: AbortSignal,
): Promise<ExtractOutcome> {
	if (!cfg.firecrawlKey) throw new ProviderError("firecrawl", "Firecrawl API key is not configured")
	if (!urls.length) throw new InputError("At least one URL is required")
	const body: Record<string, unknown> = { urls: urls.slice(0, 50) }
	if (opts.prompt) body.prompt = opts.prompt
	if (opts.schema) body.schema = opts.schema
	if (opts.enableWebSearch !== undefined) body.enableWebSearch = opts.enableWebSearch
	const json = await fetchJson(
		"firecrawl",
		`${FIRECRAWL_BASE}/extract`,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${cfg.firecrawlKey}`,
			},
			body: JSON.stringify(body),
		},
		cfg,
		signal,
	)
	return normalizeFirecrawlExtract(json)
}

// ------------------------------------------------------------------ jina ----

export function normalizeJinaSearch(raw: unknown): SearchOutcome {
	const body = asRecord(raw)
	const list = Array.isArray(body?.data) ? body.data : []
	const results: SearchResult[] = []
	for (const item of list) {
		const record = asRecord(item)
		if (!record) continue
		const url = firstString(record.url)
		if (!url) continue
		results.push({
			title: firstString(record.title) ?? url,
			url,
			snippet: firstString(record.description, record.content) ?? "",
		})
	}
	return { backend: "jina", results }
}

/**
 * Jina answers with text/plain by default: a "Title:" / "URL Source:" /
 * "Markdown Content:" preamble. Used when JSON is not returned.
 */
export function parseJinaText(text: string): { title: string; url: string; content: string } {
	const titleMatch = text.match(/^Title:\s*(.*)$/m)
	const urlMatch = text.match(/^URL Source:\s*(.*)$/m)
	const contentIndex = text.indexOf("Markdown Content:")
	const content = contentIndex >= 0 ? text.slice(contentIndex + "Markdown Content:".length).trim() : text.trim()
	return {
		title: titleMatch?.[1]?.trim() ?? "",
		url: urlMatch?.[1]?.trim() ?? "",
		content,
	}
}

export interface JinaSearchParams {
	query: string
	limit: number
	includeDomains?: string[]
	excludeDomains?: string[]
}

export async function jinaSearch(
	cfg: ResearchConfig,
	params: JinaSearchParams,
	signal?: AbortSignal,
): Promise<SearchOutcome> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"x-respond-with": "no-content",
	}
	if (cfg.jinaKey) headers.authorization = `Bearer ${cfg.jinaKey}`
	const url = `${JINA_SEARCH_BASE}/${encodeURIComponent(params.query)}`
	const text = await fetchText("jina", url, { headers }, cfg, signal)
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		throw new ProviderError("jina", "Search response was not valid JSON")
	}
	const outcome = normalizeJinaSearch(body)
	const filtered = filterResultsByDomain(outcome.results, params)
	return {
		...outcome,
		results: filtered.results.slice(0, params.limit),
		filter: filtered.removed ? { returned: filtered.returned, removed: filtered.removed } : undefined,
	}
}

export async function jinaRead(
	cfg: ResearchConfig,
	url: string,
	opts: { format?: "markdown" | "text" | "html"; targetSelector?: string; removeSelector?: string; withLinksSummary?: boolean },
	signal?: AbortSignal,
): Promise<PageResult> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"x-return-format": opts.format === "html" ? "html" : opts.format === "text" ? "text" : "markdown",
		"x-retain-images": "none",
	}
	if (cfg.jinaKey) headers.authorization = `Bearer ${cfg.jinaKey}`
	if (opts.targetSelector) headers["x-target-selector"] = opts.targetSelector
	if (opts.removeSelector) headers["x-remove-selector"] = opts.removeSelector
	if (opts.withLinksSummary) headers["x-with-links-summary"] = "true"
	const text = await fetchText("jina", `${JINA_READER_BASE}/${url}`, { headers }, cfg, signal)
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		const parsed = parseJinaText(text)
		return { url: parsed.url || url, title: parsed.title, content: parsed.content }
	}
	const record = asRecord(body)
	const data = asRecord(record?.data) ?? record ?? {}
	return {
		url: firstString(data.url, data.sourceURL) ?? url,
		title: firstString(data.title) ?? "",
		content: firstString(data.content, data.text, data.html) ?? "",
		metadata: data,
	}
}
