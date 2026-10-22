/**
 * Routing instructions and output formatting for the research plugin.
 *
 * The routing text is the point of the plugin: four backends overlap, so the
 * model needs an explicit decision procedure rather than a tool list. The text
 * is rebuilt from the configured backends, so a missing API key removes that
 * route from the instructions instead of sending the model down a dead end.
 */

import type { ExtractOutcome, PageResult, SearchOutcome } from "./providers.js"

export interface AvailableBackends {
	readonly tavily: boolean
	readonly exa: boolean
	readonly firecrawl: boolean
	readonly jina: boolean
}

/** Rough token cost of the routing block, kept small on purpose. */
export const ROUTING_CHAR_LIMIT = 4_000

/**
 * Decision procedure shipped to the model as a system instruction.
 *
 * Wording rules: name the tool, then the one job it is good at, then when to
 * reach for the neighbour instead.
 */
export function buildRoutingText(available: AvailableBackends): string {
	const active = [available.tavily, available.exa, available.firecrawl, available.jina].filter(Boolean).length
	const count = active === 1 ? "One backend is" : `${active} backends are`

	/** Pad the tool name so the descriptions line up in the rendered prompt. */
	const route = (name: string, description: string): string => `${name.padEnd(24)}— ${description}`

	const lines: string[] = [
		"--- RESEARCH ROUTING (authoritative, managed by the research plugin) ---",
		`${count} wired up. Route by capability, not by habit.`,
		"",
		"ROUTES",
	]

	const searchParts: string[] = []
	if (available.tavily) {
		searchParts.push("Tavily: AI-shaped search, news and finance topics, domain and time filters, optional generated answer")
	}
	if (available.exa) {
		searchParts.push("Exa: neural and semantic search, best for conceptual queries, papers and technical content")
	}
	searchParts.push("Jina search as the last-resort fallback")
	const engineHint = available.exa
		? ' Use engine "neural" to put Exa first for a conceptual query, "keyword" for a literal one, or "auto" for the default order.'
		: ""
	lines.push(
		route(
			"research_search",
			`FIND SOURCES on the public web. ${searchParts.join(". ")}.${engineHint}`,
		),
	)

	if (available.exa) {
		lines.push(
			route(
				"research_find_similar",
				"FIND PAGES LIKE A KNOWN URL. Exa only. Use it when you have one good source and want the rest of that literature.",
			),
		)
	}

	lines.push(
		available.firecrawl
			? route(
					"research_read",
					"READ ONE URL as clean markdown. Firecrawl: JS-rendered pages, PDFs, cache control. Falls back to the Jina reader, which needs no API key, so this route always works.",
				)
			: route(
					"research_read",
					"READ ONE URL as clean markdown. Jina reader only; it needs no API key, so this route always works.",
				),
	)

	if (available.firecrawl) {
		lines.push(
			route(
				"research_crawl",
				"READ MANY PAGES of one site. Firecrawl only. Use it when a whole documentation set or a section index is needed, not for a single page.",
			),
		)
	}

	if (available.tavily || available.firecrawl) {
		const mapper =
			available.tavily && available.firecrawl
				? "Tavily (with natural-language instructions) or Firecrawl"
				: available.tavily
					? "Tavily"
					: "Firecrawl"
		lines.push(
			route(
				"research_map",
				`LIST THE URLS of a site without fetching them. ${mapper}. Use it before research_crawl when the target site is large or its structure is unknown.`,
			),
		)
	}

	if (available.firecrawl || available.tavily) {
		const extractor =
			available.firecrawl && available.tavily
				? "Firecrawl (JSON schema or prompt) with Tavily extract as fallback"
				: available.firecrawl
					? "Firecrawl"
					: "Tavily extract"
		lines.push(
			route(
				"research_extract",
				`PULL STRUCTURED FIELDS out of known URLs. ${extractor}. Use it when you know which pages hold the facts and want fields, not prose.`,
			),
		)
	}

	lines.push(
		"",
		"ORDER OF WORK",
		"1. research_search to find candidate sources.",
		available.firecrawl
			? "2. research_read on the promising URLs. research_crawl only when one page is not enough."
			: "2. research_read on the promising URLs.",
	)
	if (available.firecrawl || available.tavily) {
		lines.push("3. research_extract when you need specific fields instead of full prose.")
	}
	if (available.exa) {
		lines.push(
			"4. research_find_similar when one good source suggests the rest of the literature.",
		)
	}
	lines.push(
		"",
		"RULES",
		"- Do not fetch a URL you did not get from a search result, a map, or the user.",
		"- Prefer primary sources: official docs, the original paper, the source repository.",
		"- Read the page, do not judge it by its search snippet.",
		"- Every factual claim you keep must carry the URL it came from.",
		"- If two sources disagree, say so and cite both.",
		"- If the evidence is missing, say what is missing. Never fill a gap with a plausible guess.",
		"---",
	)

	const text = lines.join("\n")
	return text.length > ROUTING_CHAR_LIMIT ? `${text.slice(0, ROUTING_CHAR_LIMIT)}\n---` : text
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
- End with a short source list of the URLs you actually used.
---`
}

// ------------------------------------------------------------ formatting ----

export function truncate(text: string, limit: number): string {
	if (text.length <= limit) return text
	return `${text.slice(0, limit)}\n\n[... truncated at ${limit} characters; raise maxChars to see the rest ...]`
}

export function formatSearchResults(outcome: SearchOutcome, query: string, limit: number): string {
	if (!outcome.results.length) {
		const extra = outcome.answer ? `\n\nProvider answer:\n${outcome.answer}` : ""
		return `No results for "${query}" via ${outcome.backend}.${extra}`
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
