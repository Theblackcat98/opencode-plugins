/**
 * Routing instructions and output formatting for the research plugin.
 *
 * The routing text is the point of the plugin: four backends overlap, so the
 * model needs an explicit decision procedure rather than a tool list. The text
 * is rebuilt from the configured backends, so a missing API key removes that
 * route from the instructions instead of sending the model down a dead end.
 */

import type { ExtractOutcome, MergedSearchOutcome, PageResult, SearchOutcome } from "./providers.js"
import type { ResearchStats, SessionLedger } from "./state.js"

export interface AvailableBackends {
	readonly tavily: boolean
	readonly exa: boolean
	readonly firecrawl: boolean
	readonly jina: boolean
}

/** Rough token cost of the routing block, kept small on purpose. */
export const ROUTING_CHAR_LIMIT = 4_000

function capRoutingText(text: string): string {
	return text.length > ROUTING_CHAR_LIMIT ? `${text.slice(0, ROUTING_CHAR_LIMIT)}\n---` : text
}

/**
 * Decision procedure shipped to the model as a system instruction.
 *
 * Wording rules: name the tool, then the one job it is good at, then when to
 * reach for the neighbour instead.
 */
export function buildRoutingProcedure(available: AvailableBackends): string {
	const active = [available.tavily, available.exa, available.firecrawl, available.jina].filter(Boolean).length
	const count = active === 1 ? "One backend is" : `${active} backends are`

	/** Pad the tool name so the descriptions line up in the rendered prompt. */
	const route = (name: string, description: string): string => `${name.padEnd(24)}— ${description}`

	const searchParts: string[] = []
	if (available.tavily) searchParts.push("Tavily: natural language, news/finance topics, domain and time filters, optional answer")
	if (available.exa) searchParts.push("Exa: neural, best for conceptual queries and papers")
	searchParts.push("keyless Jina search as the fallback")

	const lines: string[] = [
		"--- RESEARCH ROUTING (authoritative, managed by the research plugin) ---",
		`${count} wired up. Route by capability, not by habit.`,
		"",
		"ROUTES",
		route(
			"research_search",
			`FIND SOURCES. ${searchParts.join(". ")}. engine sets the order; mode "merge" unions two engines at the cost of a second call.`,
		),
	]
	if (available.exa) lines.push(route("research_find_similar", "PAGES LIKE A KNOWN URL. Exa only."))
	lines.push(
		route(
			"research_read",
			available.firecrawl
				? "READ ONE URL as markdown. Firecrawl renders JS and PDFs; the keyless Jina reader is the fallback."
				: "READ ONE URL as markdown. Keyless Jina reader.",
		),
	)
	if (available.firecrawl) lines.push(route("research_crawl", "MANY PAGES of one site. Firecrawl only."))
	if (available.tavily || available.firecrawl) {
		const mapper = available.tavily && available.firecrawl ? "Tavily or Firecrawl" : available.tavily ? "Tavily" : "Firecrawl"
		lines.push(route("research_map", `URLS OF A SITE, no fetch. ${mapper}.`))
	}
	if (available.tavily || available.firecrawl) {
		const extractor =
			available.firecrawl && available.tavily ? "Firecrawl, then Tavily" : available.firecrawl ? "Firecrawl" : "Tavily"
		lines.push(route("research_extract", `FIELDS FROM KNOWN URLS. ${extractor}.`))
	}
	lines.push(
		route("research_sources", "SOURCES READ this session, with backend and time. Storage read; use it for the final list."),
	)

	const steps = [
		"1. research_search to find candidates.",
		"2. research_read the promising URLs.",
	]
	if (available.firecrawl) steps.push(`${steps.length + 1}. research_crawl only when one page is not enough.`)
	if (available.tavily || available.firecrawl) {
		steps.push(`${steps.length + 1}. research_extract for fields instead of prose.`)
	}
	if (available.exa) steps.push(`${steps.length + 1}. research_find_similar when one source suggests the rest.`)
	steps.push(`${steps.length + 1}. research_sources before the final answer.`)
	lines.push("", "ORDER OF WORK", ...steps, "---")

	return capRoutingText(lines.join("\n"))
}

/**
 * The few rules that the tool descriptions do not already state. The
 * decision procedure above carries the routing; this block is deliberately
 * short because it rides on every call in a researching session.
 */
export function buildRoutingRules(): string {
	return [
		"RULES",
		"- Cite the URL of every claim. Use research_sources for the final list, not memory.",
		"- If sources disagree, cite both; if the evidence is missing, say what is missing.",
	].join("\n")
}

/** Full routing block: procedure plus rules. */
export function buildRoutingText(available: AvailableBackends): string {
	return capRoutingText(`${buildRoutingProcedure(available)}\n${buildRoutingRules()}`)
}

/** Contract shipped with an active /research brief. */
export function buildResearchContract(question: string): string {
	return `--- RESEARCH CONTRACT (authoritative, managed by the research plugin) ---
Question to answer: ${question}

Rules:
- Use the research_* tools. Do not answer from memory; verify against sources.
- Search first, then read the sources that matter. Crawl a site only when a single page cannot answer the question.
- Prefer primary sources (official docs, the original paper, the source repo) over commentary and summaries.
- Every factual claim in the final answer must carry the URL it came from.
- If two sources disagree, say so and cite both.
- If the evidence is not there, state what is missing. Never fill a gap with a plausible guess.
- End with the source list from research_sources: the URLs you actually read, not ones you remember.
---`
}

// ------------------------------------------------------------ formatting ----

export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text
	return `${text.slice(0, limit)}\n\n[... truncated at ${limit} characters; raise maxChars to see the rest ...]`
}

export function formatSearchResults(
	outcome: SearchOutcome,
	query: string,
	limit: number,
	notes: readonly string[] = [],
): string {
	if (!outcome.results.length) {
		const parts: string[] = []
		if (outcome.filter && outcome.filter.removed > 0) {
			parts.push(
				`${outcome.backend} returned ${outcome.filter.returned} result(s) for "${query}"; the domain filter removed all of them.`,
			)
		} else {
			parts.push(`No results for "${query}" via ${outcome.backend}.`)
		}
		if (outcome.answer) parts.push(`Provider answer:\n${outcome.answer}`)
		parts.push(...notes.map((note) => `note: ${note}`))
		return parts.join("\n")
	}
	const parts: string[] = [`${outcome.results.length} result(s) for "${query}" via ${outcome.backend}.`]
	if (outcome.answer) parts.push(`Provider answer:\n${outcome.answer}\n`)
	outcome.results.slice(0, limit).forEach((result, index) => {
		parts.push(`${index + 1}. ${result.title}`)
		parts.push(`   ${result.url}`)
		if (result.score !== undefined) parts.push(`   relevance: ${result.score.toFixed(3)}`)
		if (result.snippet) parts.push(`   ${result.snippet}`)
	})
	if (outcome.results.length > limit) {
		parts.push(`[${outcome.results.length - limit} further result(s) omitted]`)
	}
	if (outcome.filter && outcome.filter.removed > 0) {
		parts.push(`[${outcome.filter.removed} result(s) removed by the domain filter]`)
	}
	parts.push(...notes.map((note) => `note: ${note}`))
	return parts.join("\n")
}

/** Merged search: one entry per URL, labelled with every engine that found it. */
export function formatMergedSearchResults(outcome: MergedSearchOutcome, query: string, limit: number): string {
	const engines = outcome.answered.join(", ") || "no engine"
	if (!outcome.results.length) {
		const parts = [`Merged search for "${query}" returned no results from ${engines}.`]
		for (const failure of outcome.failed) parts.push(`- ${failure.backend} failed: ${failure.error}`)
		return parts.join("\n")
	}
	const parts: string[] = [
		`Merged search for "${query}": ${outcome.results.length} unique result(s) from ${engines}.`,
	]
	for (const failure of outcome.failed) parts.push(`- ${failure.backend} failed: ${failure.error}`)
	parts.push("")
	outcome.results.slice(0, limit).forEach((result, index) => {
		parts.push(`${index + 1}. ${result.title} [${result.engines.join("+")}]`)
		parts.push(`   ${result.url}`)
		if (result.snippet) parts.push(`   ${result.snippet}`)
		const ranks = Object.entries(result.positions)
			.map(([engine, rank]) => `#${rank} ${engine}`)
			.join(", ")
		if (ranks) parts.push(`   rank: ${ranks}`)
	})
	if (outcome.results.length > limit) {
		parts.push(`[${outcome.results.length - limit} further result(s) omitted]`)
	}
	if (outcome.disagreements.length) {
		parts.push("")
		parts.push("Engines disagree on these positions; rank is weak, so read them before trusting them:")
		for (const entry of outcome.disagreements.slice(0, 5)) {
			parts.push(`- ${entry.url} (ranked ${entry.positions.map((rank) => `#${rank}`).join(" vs ")})`)
		}
	}
	return parts.join("\n")
}

export function formatPageResult(page: PageResult, maxChars: number, label = "page"): string {
	const head = [`${label}: ${page.title || "(untitled)"}`, `source: ${page.url}`].join("\n")
	if (!page.content) return `${head}\n\n(no content returned)`
	return `${head}\n\n${truncate(page.content, maxChars)}`
}

export function formatCrawlResults(pages: readonly PageResult[], root: string, maxCharsPerPage: number): string {
	if (!pages.length) return `Crawl of ${root} returned no pages.`
	const parts: string[] = [`Crawled ${pages.length} page(s) from ${root}.`]
	pages.forEach((page, index) => {
		parts.push("")
		parts.push(`${index + 1}. ${page.title || "(untitled)"}`)
		parts.push(`   ${page.url}`)
		if (page.content) parts.push(truncate(page.content, maxCharsPerPage))
	})
	return parts.join("\n")
}

export function formatExtractResult(outcome: ExtractOutcome, maxChars: number): string {
	const parts: string[] = [`Structured extraction via ${outcome.backend}.`]
	if (outcome.failed.length) {
		parts.push(`Failed: ${outcome.failed.map((entry) => `${entry.url} (${entry.error})`).join(", ")}`)
	}
	const serialized = typeof outcome.data === "string" ? outcome.data : JSON.stringify(outcome.data, null, 2)
	parts.push(truncate(serialized, maxChars))
	return parts.join("\n")
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** Build a clickable markdown list of URLs, for the "sources" section. */
export function formatSourceList(urls: readonly string[]): string {
	const unique = [...new Set(urls.filter((url) => url.trim()))]
	if (!unique.length) return "(no sources)"
	return unique.map((url) => `- ${url}`).join("\n")
}

// -------------------------------------------------------- cache output ------

export function formatAge(ageMs: number): string {
	const seconds = Math.max(0, Math.round(ageMs / 1000))
	if (seconds < 60) return `${seconds} second(s)`
	const minutes = Math.round(seconds / 60)
	if (minutes < 60) return `${minutes} minute(s)`
	const hours = Math.round(minutes / 60)
	if (hours < 24) return `${hours} hour(s)`
	return `${Math.round(hours / 24)} day(s)`
}

/** Cached page text can be stale, so the model is told which it is reading. */
export function formatCacheNote(fetchedAt: number, backend: string, now = Date.now()): string {
	return `[cached: fetched ${formatAge(now - fetchedAt)} ago from ${backend}. The page may have changed since; read it live if freshness matters.]`
}

// ------------------------------------------------------ source ledger -------

function formatTimestamp(ms: number): string {
	return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`
}

export function formatSourceLedger(ledger: SessionLedger): string {
	if (!ledger.entries.length) return "No sources read in this session yet."
	const parts: string[] = [`${ledger.entries.length} source(s) read in this session, oldest first.`]
	ledger.entries.forEach((entry, index) => {
		const title = entry.title ? ` — ${entry.title}` : ""
		parts.push(`${index + 1}. ${entry.url}${title}`)
		parts.push(`   ${entry.backend}, ${formatTimestamp(entry.readAt)}`)
		if (entry.excerpt) parts.push(`   ${entry.excerpt}`)
	})
	if (ledger.dropped > 0) {
		parts.push(`[${ledger.dropped} older source(s) dropped from the ledger at its cap]`)
	}
	parts.push("")
	parts.push("Source list:")
	parts.push(formatSourceList(ledger.entries.map((entry) => entry.url)))
	return parts.join("\n")
}

// -------------------------------------------------------------- stats -------

export function formatStats(stats: ResearchStats, lifetime?: ResearchStats): string {
	const rows = (["tavily", "exa", "firecrawl", "jina"] as const).map((backend) => {
		const entry = stats.backends[backend]
		return `${backend.padEnd(10)}${String(entry.calls).padStart(6)}${String(entry.failures).padStart(8)}${
			String(entry.fallbacks).padStart(11)
		}${String(entry.results).padStart(9)}`
	})
	const parts = [
		"Research stats — this session",
		`${"backend".padEnd(10)}${"calls".padStart(6)}${"failed".padStart(8)}${"fallbacks".padStart(11)}${"results".padStart(9)}`,
		...rows,
		"",
		`pages read: ${stats.pagesRead} | pages crawled: ${stats.pagesCrawled} | urls extracted: ${stats.urlsExtracted}`,
		`characters returned: ${stats.charsReturned.toLocaleString("en-US")} | cache hits: ${stats.cacheHits}`,
	]
	if (lifetime) {
		const total = [...(["tavily", "exa", "firecrawl", "jina"] as const)].reduce(
			(acc, backend) => {
				acc.calls += lifetime.backends[backend].calls
				acc.failures += lifetime.backends[backend].failures
				return acc
			},
			{ calls: 0, failures: 0 },
		)
		parts.push(`lifetime: ${total.calls} call(s), ${total.failures} failure(s)`)
	}
	parts.push("")
	parts.push("Counts only: no query text, no credentials.")
	return parts.join("\n")
}
