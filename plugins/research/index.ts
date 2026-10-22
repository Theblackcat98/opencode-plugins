/**
 * Research Plugin (OpenCode V2)
 *
 * One research surface over three upstreams, with an explicit routing
 * procedure so the model picks the right backend per job instead of defaulting
 * to whichever tool it saw first.
 *
 *   - Tavily       web search already shaped for agents, plus site mapping
 *   - Firecrawl    page scraping, site crawling, structured extraction
 *   - Jina AI      URL -> LLM-ready markdown, works without an API key
 *
 * The routing block is a system instruction on every model call, rebuilt from
 * the backends that actually have credentials, so a missing key removes a
 * route instead of sending the model into a dead end.
 *
 * V2 API used (verified against @opencode/plugin 2.0.26):
 *   ctx.tool.transform + JSON Schema input + editor.namespace
 *   ctx.command.transform      (the /research command)
 *   ctx.session.hook("context") (routing block and research contract)
 *   ctx.storage                (durable research briefs)
 *   ctx.websearch.transform    (optional Tavily websearch provider)
 */

import { Plugin } from "@opencode/plugin"
import {
	InputError,
	ProviderError,
	assertWebUrl,
	exaFindSimilar,
	exaSearch,
	firecrawlCrawl,
	firecrawlExtract,
	firecrawlMap,
	firecrawlScrape,
	jinaRead,
	jinaSearch,
	publishedDateSince,
	resolveConfig,
	tavilyExtract,
	tavilyMap,
	tavilySearch,
	type Backend,
	type ExtractOutcome,
	type PageResult,
	type ResearchConfig,
	type SearchOutcome,
} from "./providers.js"
import {
	buildResearchContract,
	buildRoutingText,
	formatCrawlResults,
	formatExtractResult,
	formatPageResult,
	formatSearchResults,
	formatSourceList,
	truncate,
} from "./routing.js"

const NAMESPACE = "research"

const DEFAULT_READ_CHARS = 30_000
const DEFAULT_EXTRACT_CHARS = 20_000
const DEFAULT_CRAWL_PAGE_CHARS = 8_000

const BRIEF_STORAGE_PREFIX = "research/brief/"

interface ResearchBrief {
	readonly sessionID: string
	readonly question: string
	readonly createdAt: number
}

function isResearchBrief(value: unknown): value is ResearchBrief {
	if (!value || typeof value !== "object") return false
	const brief = value as Record<string, unknown>
	return (
		typeof brief.sessionID === "string" &&
		typeof brief.question === "string" &&
		typeof brief.createdAt === "number"
	)
}

function describeError(error: unknown): string {
	if (error instanceof Error) return error.message
	return String(error)
}

/**
 * Try each backend in order. The first success wins. An InputError aborts the
 * chain immediately: a fallback would reject the same input.
 */
async function route<T>(
	steps: ReadonlyArray<{ backend: Backend; run: () => Promise<T> }>,
): Promise<{ value: T; backend: Backend; notes: readonly string[] }> {
	const notes: string[] = []
	for (const step of steps) {
		try {
			return { value: await step.run(), backend: step.backend, notes }
		} catch (error) {
			if (error instanceof InputError) throw error
			notes.push(`${step.backend} failed: ${describeError(error)}`)
		}
	}
	throw new Error(notes.join(" | ") || "no backend was available")
}

function notesSuffix(notes: readonly string[]): string {
	if (!notes.length) return ""
	return `\n\n[used a fallback: ${notes.join(" | ")}]`
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined
	const list = value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
	return list.length ? list : undefined
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function asObjectArray(value: unknown): Record<string, unknown>[] | undefined {
	if (!Array.isArray(value)) return undefined
	const list = value.filter(
		(entry): entry is Record<string, unknown> => !!entry && typeof entry === "object" && !Array.isArray(entry),
	)
	return list.length ? list : undefined
}

/**
 * Translate the relative time window the model asked for into a day count,
 * so the Exa fallback applies the same restriction as Tavily.
 */
function exaWindowDays(args: Record<string, unknown>): number | undefined {
	const days = asNumber(args.days)
	if (days !== undefined && days > 0) return Math.min(Math.round(days), 3650)
	switch (args.timeRange) {
		case "day":
			return 1
		case "week":
			return 7
		case "month":
			return 30
		case "year":
			return 365
		default:
			return undefined
	}
}

const briefStorageKey = (sessionID: string): string => `${BRIEF_STORAGE_PREFIX}${sessionID}`

export const internals = {
	isResearchBrief,
	describeError,
	briefStorageKey,
	resolveConfig,
	buildRoutingText,
	buildResearchContract,
	formatSearchResults,
	formatPageResult,
	formatCrawlResults,
	formatExtractResult,
	formatSourceList,
	exaWindowDays,
	truncate,
}

export default Plugin.define({
	id: "research",
	async setup(ctx) {
		const options = (ctx.options ?? {}) as Readonly<Record<string, any>>
		const cfg: ResearchConfig = resolveConfig(options, process.env)

		const log = {
			info: (message: string) => console.log(`[research] ${message}`),
			warn: (message: string) => console.error(`[research] ${message}`),
		}

		const available = {
			tavily: !!cfg.tavilyKey,
			exa: !!cfg.exaKey,
			firecrawl: !!cfg.firecrawlKey,
			// Jina works without a key, at a lower rate limit.
			jina: true,
		}
		const routingText = buildRoutingText(available)

		const missingKeys = [
			available.tavily ? null : "tavily",
			available.exa ? null : "exa",
			available.firecrawl ? null : "firecrawl",
		].filter(Boolean)
		if (missingKeys.length) log.info(`no API key for: ${missingKeys.join(", ")} (those routes are disabled)`)

		// ---- durable research briefs ----------------------------------------
		// The brief is the task the user asked for, so it outlives a restart.
		const briefs = new Map<string, ResearchBrief>()
		const persistBrief = async (brief: ResearchBrief): Promise<void> => {
			try {
				await ctx.storage.set(briefStorageKey(brief.sessionID), { ...brief })
			} catch (error) {
				log.warn(`could not persist research brief: ${describeError(error)}`)
			}
		}
		const dropBrief = async (sessionID: string): Promise<void> => {
			briefs.delete(sessionID)
			try {
				await ctx.storage.remove(briefStorageKey(sessionID))
			} catch (error) {
				log.warn(`could not remove research brief: ${describeError(error)}`)
			}
		}
		try {
			let after: string | undefined
			for (;;) {
				const page = await ctx.storage.scan({ prefix: BRIEF_STORAGE_PREFIX, after, limit: 100 })
				for (const entry of page.entries) {
					if (isResearchBrief(entry.value)) briefs.set(entry.value.sessionID, entry.value)
					else log.warn(`ignoring malformed research brief at ${entry.key}`)
				}
				if (!page.next) break
				after = page.next
			}
			if (briefs.size) log.info(`rehydrated ${briefs.size} research brief(s)`)
		} catch (error) {
			log.warn(`research brief rehydration failed: ${describeError(error)}`)
		}

		// ---- tools ------------------------------------------------------------
		await ctx.tool.transform((editor) => {
			editor.namespace({
				name: NAMESPACE,
				description:
					"Web research: find sources on the public web, read pages, crawl sites, map site structure, and extract structured fields.",
			})

			// -- find sources ----------------------------------------------------
			editor.add({
				name: "search",
				description:
					"Find candidate sources on the public web. Use this first, before reading anything. Tavily handles natural-language queries, news and finance topics, domain filters and time ranges; Exa handles conceptual, academic and technical queries with neural search; Jina search is the last-resort fallback. Returns titles, URLs and snippets.",
				input: {
					type: "object",
					properties: {
						query: { type: "string", description: "Search query. Natural language works well." },
						engine: {
							type: "string",
							enum: ["auto", "neural", "keyword"],
							description:
								"auto = Tavily first, then Exa, then Jina. neural = Exa semantic search first, best for conceptual, academic and technical queries. keyword = literal matching first. Default auto.",
						},
						maxResults: { type: "integer", description: "How many results to return (default 8, max 20)." },
						depth: {
							type: "string",
							enum: ["basic", "advanced"],
							description: "basic = 1 credit and fast. advanced = 2 credits, more thorough. Default basic.",
						},
						topic: {
							type: "string",
							enum: ["general", "news", "finance"],
							description: "Search topic. Default general.",
						},
						timeRange: {
							type: "string",
							enum: ["day", "week", "month", "year"],
							description: "Restrict results to this recent window.",
						},
						days: { type: "integer", description: "For topic news: how many days back to search." },
						includeDomains: {
							type: "array",
							items: { type: "string" },
							description: "Only return results from these domains.",
						},
						excludeDomains: {
							type: "array",
							items: { type: "string" },
							description: "Never return results from these domains.",
						},
						includeAnswer: {
							type: "boolean",
							description: "Also return a generated answer. Useful for quick factual questions.",
						},
						includeRawContent: {
							type: "boolean",
							description: "Also return the full page text of each result. Token heavy; prefer research_read.",
						},
					},
					required: ["query"],
					additionalProperties: false,
				},
				options: { namespace: NAMESPACE, codemode: true },
				async execute(input, toolCtx) {
					const args = (input ?? {}) as Record<string, unknown>
					const query = asString(args.query)
					if (!query) return { content: "research_search: `query` is required." }
					const maxResults = asNumber(args.maxResults) ?? 8
					const includeDomains = asStringArray(args.includeDomains)
					const excludeDomains = asStringArray(args.excludeDomains)
					const engine = args.engine === "neural" || args.engine === "keyword" ? args.engine : "auto"

					// Tavily takes a relative time window, Exa takes dates. Translate
					// so the fallback search is not weaker than the primary one.
					const windowDays = exaWindowDays(args)
					const exaType = engine === "neural" ? "neural" : engine === "keyword" ? "keyword" : "auto"

					const tavilyStep = (): { backend: Backend; run: () => Promise<SearchOutcome> } => ({
						backend: "tavily",
						run: () =>
							tavilySearch(
								cfg,
								{
									query,
									maxResults,
									depth: args.depth === "advanced" ? "advanced" : "basic",
									topic: args.topic === "news" || args.topic === "finance" ? args.topic : "general",
									timeRange:
										args.timeRange === "day" || args.timeRange === "week" || args.timeRange === "month" || args.timeRange === "year"
											? args.timeRange
											: undefined,
									days: asNumber(args.days),
									includeDomains,
									excludeDomains,
									includeAnswer: args.includeAnswer === true,
									includeRawContent: args.includeRawContent === true,
								},
								toolCtx.signal,
							),
					})
					const exaStep = (): { backend: Backend; run: () => Promise<SearchOutcome> } => ({
						backend: "exa",
						run: () =>
							exaSearch(
								cfg,
								{
									query,
									maxResults,
									type: exaType,
									includeDomains,
									excludeDomains,
									startPublishedDate: windowDays ? publishedDateSince(windowDays) : undefined,
									includeRawContent: args.includeRawContent === true,
								},
								toolCtx.signal,
							),
					})
					const jinaStep = (): { backend: Backend; run: () => Promise<SearchOutcome> } => ({
						backend: "jina",
						run: () => jinaSearch(cfg, query, maxResults, toolCtx.signal),
					})

					const steps: { backend: Backend; run: () => Promise<SearchOutcome> }[] = []
					if (engine === "neural") {
						if (available.exa) steps.push(exaStep())
						if (available.tavily) steps.push(tavilyStep())
					} else if (engine === "keyword") {
						if (available.tavily) steps.push(tavilyStep())
						if (available.exa) steps.push(exaStep())
					} else {
						if (available.tavily) steps.push(tavilyStep())
						if (available.exa) steps.push(exaStep())
					}
					steps.push(jinaStep())

					try {
						const { value, notes } = await route(steps)
						return {
							content: formatSearchResults(value, query, maxResults) + notesSuffix(notes),
						}
					} catch (error) {
						return { content: `research_search failed: ${describeError(error)}` }
					}
				},
			})

			// -- find pages like a known url -------------------------------------
			editor.add({
				name: "find_similar",
				description:
					"Find web pages similar to a URL you already have. Exa only. Use it when one good source suggests the rest of the literature: a paper, a competitor page, a well-written blog post on the topic.",
				input: {
					type: "object",
					properties: {
						url: { type: "string", description: "Absolute http or https URL of the page to match." },
						maxResults: { type: "integer", description: "How many similar pages to return (default 8, max 100)." },
						excludeSourceDomain: {
							type: "boolean",
							description: "Drop results from the same domain as the given URL. Default true.",
						},
						includeDomains: {
							type: "array",
							items: { type: "string" },
							description: "Only return results from these domains.",
						},
						excludeDomains: {
							type: "array",
							items: { type: "string" },
							description: "Never return results from these domains.",
						},
					},
					required: ["url"],
					additionalProperties: false,
				},
				options: { namespace: NAMESPACE, codemode: true },
				async execute(input, toolCtx) {
					const args = (input ?? {}) as Record<string, unknown>
					const rawUrl = asString(args.url)
					if (!rawUrl) return { content: "research_find_similar: `url` is required." }
					if (!available.exa) {
						return {
							content:
								"research_find_similar: needs an Exa API key (set EXA_API_KEY or the exaKey plugin option). Use research_search with engine \"neural\" instead.",
						}
					}
					let url: URL
					try {
						url = assertWebUrl(rawUrl, cfg.allowPrivateUrls)
					} catch (error) {
						return { content: `research_find_similar: ${describeError(error)}` }
					}
					try {
						const outcome = await exaFindSimilar(
							cfg,
							url.toString(),
							{
								maxResults: asNumber(args.maxResults) ?? 8,
								excludeSourceDomain: args.excludeSourceDomain !== false,
								includeDomains: asStringArray(args.includeDomains),
								excludeDomains: asStringArray(args.excludeDomains),
							},
							toolCtx.signal,
						)
						return {
							content: formatSearchResults(outcome, `pages like ${url.toString()}`, asNumber(args.maxResults) ?? 8),
						}
					} catch (error) {
						return { content: `research_find_similar failed: ${describeError(error)}` }
					}
				},
			})

			// -- read one page --------------------------------------------------
			editor.add({
				name: "read",
				description:
					"Read ONE URL and return it as clean markdown. Use after research_search, on the URLs that look worth reading. Firecrawl renders JavaScript and handles PDFs; the Jina reader is the fallback and needs no API key, so this route always works.",
				input: {
					type: "object",
					properties: {
						url: { type: "string", description: "Absolute http or https URL." },
						format: {
							type: "string",
							enum: ["markdown", "text", "html"],
							description: "Output format. Default markdown. Firecrawl has no plain-text format, so \"text\" arrives as markdown there.",
						},
						onlyMainContent: {
							type: "boolean",
							description: "Strip navigation, footers and boilerplate. Default true.",
						},
						targetSelector: {
							type: "string",
							description: "CSS selector of the part of the page to read (Jina only).",
						},
						removeSelector: {
							type: "string",
							description: "CSS selector of the part of the page to drop (Jina only).",
						},
						includeLinks: {
							type: "boolean",
							description: "Append a link summary (Jina only).",
						},
						maxChars: { type: "integer", description: `Characters of page text to return (default ${DEFAULT_READ_CHARS}).` },
					},
					required: ["url"],
					additionalProperties: false,
				},
				options: { namespace: NAMESPACE, codemode: true },
				async execute(input, toolCtx) {
					const args = (input ?? {}) as Record<string, unknown>
					const rawUrl = asString(args.url)
					if (!rawUrl) return { content: "research_read: `url` is required." }
					let url: URL
					try {
						url = assertWebUrl(rawUrl, cfg.allowPrivateUrls)
					} catch (error) {
						return { content: `research_read: ${describeError(error)}` }
					}
					const target = url.toString()
					const maxChars = asNumber(args.maxChars) ?? DEFAULT_READ_CHARS
					const format = args.format === "text" || args.format === "html" ? args.format : "markdown"

					const steps: { backend: Backend; run: () => Promise<PageResult> }[] = []
					if (available.firecrawl) {
						steps.push({
							backend: "firecrawl",
							run: () =>
								firecrawlScrape(
									cfg,
									target,
									{ format, onlyMainContent: args.onlyMainContent !== false },
									toolCtx.signal,
								),
						})
					}
					steps.push({
						backend: "jina",
						run: () =>
							jinaRead(
								cfg,
								target,
								{
									format,
									targetSelector: asString(args.targetSelector),
									removeSelector: asString(args.removeSelector),
									withLinksSummary: args.includeLinks === true,
								},
								toolCtx.signal,
							),
					})

					try {
						const { value, notes } = await route(steps)
						return { content: formatPageResult(value, maxChars) + notesSuffix(notes) }
					} catch (error) {
						return { content: `research_read failed: ${describeError(error)}` }
					}
				},
			})

			// -- crawl a site ---------------------------------------------------
			editor.add({
				name: "crawl",
				description:
					"Read MANY pages of one site and return them as markdown. Firecrawl only. Use it for documentation sets, sitemaps and section indexes. Do not use it for a single page; use research_read. If you do not know the site structure, run research_map first.",
				input: {
					type: "object",
					properties: {
						url: { type: "string", description: "Absolute http or https URL to start from." },
						limit: { type: "integer", description: "Maximum pages to fetch (default 20, max 100)." },
						maxDepth: { type: "integer", description: "How many link levels to follow (default 2)." },
						includePaths: {
							type: "array",
							items: { type: "string" },
							description: "Regex path patterns to include, for example \"^/docs/.*$\".",
						},
						excludePaths: {
							type: "array",
							items: { type: "string" },
							description: "Regex path patterns to exclude, for example \"^/blog/.*$\".",
						},
						allowSubdomains: { type: "boolean", description: "Follow links to subdomains." },
						maxCharsPerPage: { type: "integer", description: `Characters kept per page (default ${DEFAULT_CRAWL_PAGE_CHARS}).` },
					},
					required: ["url"],
					additionalProperties: false,
				},
				options: { namespace: NAMESPACE, codemode: true },
				async execute(input, toolCtx) {
					const args = (input ?? {}) as Record<string, unknown>
					const rawUrl = asString(args.url)
					if (!rawUrl) return { content: "research_crawl: `url` is required." }
					if (!available.firecrawl) {
						return {
							content:
								"research_crawl: needs a Firecrawl API key (set FIRECRAWL_API_KEY or the firecrawlKey plugin option). Use research_read for a single page, or research_map to list a site's URLs.",
						}
					}
					let url: URL
					try {
						url = assertWebUrl(rawUrl, cfg.allowPrivateUrls)
					} catch (error) {
						return { content: `research_crawl: ${describeError(error)}` }
					}
					try {
						const pages = await firecrawlCrawl(
							cfg,
							url.toString(),
							{
								limit: asNumber(args.limit) ?? 20,
								maxDepth: asNumber(args.maxDepth) ?? 2,
								includePaths: asStringArray(args.includePaths),
								excludePaths: asStringArray(args.excludePaths),
								allowSubdomains: args.allowSubdomains === true ? true : undefined,
							},
							toolCtx.signal,
						)
						const maxChars = asNumber(args.maxCharsPerPage) ?? DEFAULT_CRAWL_PAGE_CHARS
						return { content: formatCrawlResults(pages, url.toString(), maxChars) }
					} catch (error) {
						return { content: `research_crawl failed: ${describeError(error)}` }
					}
				},
			})

			// -- map a site -----------------------------------------------------
			editor.add({
				name: "map",
				description:
					"List the URLs of a site WITHOUT fetching them. Use it to learn what a site contains before crawling, or to pick the right pages to read. Cheap and fast.",
				input: {
					type: "object",
					properties: {
						url: { type: "string", description: "Absolute http or https URL of the site." },
						limit: { type: "integer", description: "Maximum URLs to return (default 50, max 500)." },
						maxDepth: { type: "integer", description: "How deep to walk the link graph (default 2)." },
						instructions: {
							type: "string",
							description: "Natural-language focus, for example \"find the authentication documentation\".",
						},
						includeSubdomains: { type: "boolean", description: "Include subdomains (Firecrawl only)." },
					},
					required: ["url"],
					additionalProperties: false,
				},
				options: { namespace: NAMESPACE, codemode: true },
				async execute(input, toolCtx) {
					const args = (input ?? {}) as Record<string, unknown>
					const rawUrl = asString(args.url)
					if (!rawUrl) return { content: "research_map: `url` is required." }
					let url: URL
					try {
						url = assertWebUrl(rawUrl, cfg.allowPrivateUrls)
					} catch (error) {
						return { content: `research_map: ${describeError(error)}` }
					}
					const target = url.toString()
					const steps: { backend: Backend; run: () => Promise<string[]> }[] = []
					if (available.tavily) {
						steps.push({
							backend: "tavily",
							run: () =>
								tavilyMap(
									cfg,
									target,
									{
										limit: asNumber(args.limit) ?? 50,
										maxDepth: asNumber(args.maxDepth) ?? 2,
										instructions: asString(args.instructions),
									},
									toolCtx.signal,
								),
						})
					}
					if (available.firecrawl) {
						steps.push({
							backend: "firecrawl",
							run: () =>
								firecrawlMap(
									cfg,
									target,
									{
										limit: asNumber(args.limit) ?? 50,
										includeSubdomains: args.includeSubdomains === true ? true : undefined,
									},
									toolCtx.signal,
								),
						})
					}
					if (!steps.length) {
						return { content: "research_map: needs a Tavily or Firecrawl API key." }
					}
					try {
						const { value, backend, notes } = await route(steps)
						const body = value.length
							? value.map((entry) => `- ${entry}`).join("\n")
							: "(no URLs found)"
						return {
							content: `${value.length} URL(s) for ${target} via ${backend}.\n${body}${notesSuffix(notes)}`,
						}
					} catch (error) {
						return { content: `research_map failed: ${describeError(error)}` }
					}
				},
			})

			// -- structured extraction -------------------------------------------
			editor.add({
				name: "extract",
				description:
					"Pull structured fields out of URLs you already know. Use it when you want data, not prose: a price, a version list, an author, a spec. Pass a JSON schema for a fixed shape, or a prompt for free-form extraction.",
				input: {
					type: "object",
					properties: {
						urls: {
							type: "array",
							items: { type: "string" },
							description: "Absolute http or https URLs to extract from (max 20).",
						},
						prompt: {
							type: "string",
							description: "What to extract, in natural language. Used when no schema is given.",
						},
						schema: {
							type: "object",
							description:
								"JSON Schema describing the shape you want. Use this instead of a prompt for a stable result.",
							additionalProperties: true,
						},
						query: {
							type: "string",
							description: "Keywords that focus the extraction (Tavily only).",
						},
						maxChars: { type: "integer", description: `Characters of result to return (default ${DEFAULT_EXTRACT_CHARS}).` },
					},
					required: ["urls"],
					additionalProperties: false,
				},
				options: { namespace: NAMESPACE, codemode: true },
				async execute(input, toolCtx) {
					const args = (input ?? {}) as Record<string, unknown>
					const rawUrls = asStringArray(args.urls)
					if (!rawUrls) return { content: "research_extract: `urls` must be a non-empty array of URLs." }
					const urls: string[] = []
					for (const raw of rawUrls) {
						try {
							urls.push(assertWebUrl(raw, cfg.allowPrivateUrls).toString())
						} catch (error) {
							return { content: `research_extract: ${describeError(error)}` }
						}
					}
					const schema = args.schema && typeof args.schema === "object" && !Array.isArray(args.schema)
						? (args.schema as Record<string, unknown>)
						: undefined
					const prompt = asString(args.prompt)
					if (!schema && !prompt) {
						return { content: "research_extract: give either a `schema` or a `prompt` describing what to extract." }
					}

					const steps: { backend: Backend; run: () => Promise<ExtractOutcome> }[] = []
					if (available.firecrawl) {
						steps.push({
							backend: "firecrawl",
							run: () => firecrawlExtract(cfg, urls, { prompt, schema }, toolCtx.signal),
						})
					}
					if (available.tavily) {
						steps.push({
							backend: "tavily",
							run: () => tavilyExtract(cfg, urls, { query: prompt ?? asString(args.query) }, toolCtx.signal),
						})
					}
					if (!steps.length) {
						return { content: "research_extract: needs a Firecrawl or Tavily API key." }
					}
					try {
						const { value, notes } = await route(steps)
						const maxChars = asNumber(args.maxChars) ?? DEFAULT_EXTRACT_CHARS
						return { content: formatExtractResult(value, maxChars) + notesSuffix(notes) }
					} catch (error) {
						return { content: `research_extract failed: ${describeError(error)}` }
					}
				},
			})
		})

		// ---- /research command ------------------------------------------------
		await ctx.command.transform((editor) => {
			editor.add({
				name: "research",
				description: "Answer a question with sourced research (search, read, crawl, map, extract)",
				async execute({ sessionID, prompt, delivery }) {
					const raw = (prompt.text ?? "").trim()
					const question = raw.replace(/^\/?research\b\s*/i, "").trim()
					if (!question) {
						await ctx.session.prompt({
							sessionID,
							delivery,
							text: "Usage: /research <question>",
						})
						return
					}
					const brief: ResearchBrief = { sessionID, question, createdAt: Date.now() }
					briefs.set(sessionID, brief)
					await persistBrief(brief)
					await ctx.session.prompt({
						sessionID,
						delivery,
						text: `Research task accepted: ${question}\n\nThe research contract is attached as a system instruction. Use the research_* tools, read the primary sources, and cite every claim with its URL.`,
					})
				},
			})
		})

		// ---- session hooks ----------------------------------------------------
		// The routing block is the deliverable: it tells the model which backend
		// fits which job. It is rebuilt from the configured backends, so a route
		// without a credential is never advertised.
		const hookRegistrations: { dispose: () => Promise<void> }[] = []

		if (options.injectRouting !== false) {
			hookRegistrations.push(
				await ctx.session.hook("context", (event) => {
					const brief = briefs.get(event.sessionID)
					const parts: string[] = []
					if (brief) parts.push(buildResearchContract(brief.question))
					parts.push(routingText)
					event.system.push({ type: "text", text: parts.join("\n\n") })
				}),
			)
		}

		// Compaction would drop the research question, so it rides along in the
		// summary path.
		hookRegistrations.push(
			await ctx.session.hook("compaction", (event) => {
				const brief = briefs.get(event.sessionID)
				if (!brief) return
				event.system.push({
					type: "text",
					text: `An active research task survives this compaction. Preserve the question verbatim: ${JSON.stringify(brief.question)}`,
				})
				if (event.result) {
					event.result = {
						...event.result,
						summary: `[research] question=${JSON.stringify(brief.question)}\n${event.result.summary}`,
					}
				}
			}),
		)

		// A deleted session takes its brief with it.
		const eventController = new AbortController()
		void (async () => {
			for await (const event of ctx.event.subscribe({ signal: eventController.signal })) {
				if (event.type !== "session.deleted") continue
				const data = (event as { data?: Record<string, unknown> }).data ?? {}
				const sessionID = data.sessionID as string | undefined
				if (sessionID && briefs.has(sessionID)) await dropBrief(sessionID)
			}
		})().catch((error) => log.warn(`event loop stopped: ${describeError(error)}`))

		// ---- optional native websearch provider --------------------------------
		// Exposes Tavily as an OpenCode websearch provider. It is NOT made the
		// default unless the user asks for it, so the native websearch tool
		// keeps working the way it did before.
		if (available.tavily) {
			try {
				await ctx.websearch.transform((editor) => {
					editor.add({
						id: "tavily",
						name: "Tavily",
						execute: async ({ query }, { signal }) => {
							const outcome = await tavilySearch(cfg, { query, maxResults: 8 }, signal)
							return outcome.results.map((result) => ({
								url: result.url,
								title: result.title,
								content: result.snippet,
								time: {},
							}))
						},
					})
					if (options.websearchDefault === true) editor.default.set("tavily")
				})
			} catch (error) {
				log.warn(`could not register the Tavily websearch provider: ${describeError(error)}`)
			}
		}

		log.info(
			`ready (tavily: ${available.tavily ? "yes" : "no"}, firecrawl: ${available.firecrawl ? "yes" : "no"}, jina: yes)`,
		)

		return async () => {
			eventController.abort()
			for (const registration of hookRegistrations) {
				try {
					await registration.dispose()
				} catch (error) {
					log.warn(`hook dispose failed: ${describeError(error)}`)
				}
			}
			// Durable briefs survive restarts; only the in-memory index is cleared.
			briefs.clear()
		}
	},
})
