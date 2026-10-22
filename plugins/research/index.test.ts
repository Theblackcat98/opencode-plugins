import { describe, expect, test } from "bun:test"
import { internals } from "./index.js"
import { INTERNALS as PROVIDER_INTERNALS, InputError, ProviderError, assertWebUrl, isPrivateHostname } from "./providers.js"

describe("config resolution", () => {
	test("plugin options win over environment variables", () => {
		const cfg = internals.resolveConfig(
			{ tavilyKey: "from-option" },
			{ TAVILY_API_KEY: "from-env", FIRECRAWL_API_KEY: "fc-env" },
		)
		expect(cfg.tavilyKey).toBe("from-option")
		expect(cfg.firecrawlKey).toBe("fc-env")
	})

	test("environment variables are the fallback for every credential", () => {
		const cfg = internals.resolveConfig(
			{},
			{
				TAVILY_API_KEY: "tvly",
				TVLY_API_KEY: "tvly-alias",
				FIRECRAWL_API_KEY: "fc",
				JINA_API_KEY: "jina",
			},
		)
		expect(cfg.tavilyKey).toBe("tvly")
		expect(cfg.firecrawlKey).toBe("fc")
		expect(cfg.jinaKey).toBe("jina")
	})

	test("missing credentials stay undefined", () => {
		const cfg = internals.resolveConfig({}, {})
		expect(cfg.tavilyKey).toBeUndefined()
		expect(cfg.firecrawlKey).toBeUndefined()
		expect(cfg.jinaKey).toBeUndefined()
		expect(cfg.allowPrivateUrls).toBe(false)
	})

	test("blank option and env values are ignored", () => {
		const cfg = internals.resolveConfig({ tavilyKey: "   " }, { TAVILY_API_KEY: "" })
		expect(cfg.tavilyKey).toBeUndefined()
	})

	test("retry settings default to two retries with a one second base delay", () => {
		const cfg = internals.resolveConfig({}, {})
		expect(cfg.retryAttempts).toBe(2)
		expect(cfg.retryBaseDelayMs).toBe(1000)
	})

	test("retry settings can be zero, or come from the environment", () => {
		expect(internals.resolveConfig({ retryAttempts: 0 }, {}).retryAttempts).toBe(0)
		const cfg = internals.resolveConfig({}, { RESEARCH_RETRY_ATTEMPTS: "4", RESEARCH_RETRY_BASE_DELAY_MS: "250" })
		expect(cfg.retryAttempts).toBe(4)
		expect(cfg.retryBaseDelayMs).toBe(250)
	})
})

describe("provider retry", () => {
	const base = internals.resolveConfig({}, {})
	const cfg = { ...base, retryBaseDelayMs: 1, requestTimeoutMs: 50 }

	test("only 429 and 5xx are retryable", () => {
		for (const status of [429, 500, 502, 503, 599]) expect(PROVIDER_INTERNALS.isRetryableStatus(status)).toBe(true)
		for (const status of [400, 401, 403, 404, 422, 200]) expect(PROVIDER_INTERNALS.isRetryableStatus(status)).toBe(false)
		expect(PROVIDER_INTERNALS.isRetryableStatus(undefined)).toBe(false)
	})

	test("Retry-After accepts seconds and HTTP dates", () => {
		expect(PROVIDER_INTERNALS.parseRetryAfter("2")).toBe(2000)
		expect(PROVIDER_INTERNALS.parseRetryAfter("0.5")).toBe(500)
		expect(PROVIDER_INTERNALS.parseRetryAfter("Wed, 21 Oct 2026 10:00:05 GMT", Date.parse("2026-10-21T10:00:00Z"))).toBe(5000)
		expect(PROVIDER_INTERNALS.parseRetryAfter("nonsense")).toBeUndefined()
		expect(PROVIDER_INTERNALS.parseRetryAfter(null)).toBeUndefined()
	})

	test("the delay is exponential, jittered and capped", () => {
		expect(PROVIDER_INTERNALS.retryDelayMs(1, undefined, 1000, 60_000, () => 0)).toBe(1000)
		expect(PROVIDER_INTERNALS.retryDelayMs(2, undefined, 1000, 60_000, () => 0)).toBe(4000)
		expect(PROVIDER_INTERNALS.retryDelayMs(1, undefined, 1000, 60_000, () => 1)).toBe(1250)
		expect(PROVIDER_INTERNALS.retryDelayMs(1, 500, 1000, 60_000, () => 0)).toBe(500)
		expect(PROVIDER_INTERNALS.retryDelayMs(1, 999_999, 1000, 60_000, () => 0)).toBe(60_000)
	})

	test("a 429 then a 200 succeeds on the second attempt", async () => {
		const original = globalThis.fetch
		let calls = 0
		globalThis.fetch = (async () => {
			calls += 1
			if (calls === 1) return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } })
			return new Response(JSON.stringify({ ok: true }), { status: 200 })
		}) as unknown as typeof fetch
		try {
			const body = await PROVIDER_INTERNALS.fetchJson("jina", "https://example.test", {}, cfg)
			expect(body).toEqual({ ok: true })
			expect(calls).toBe(2)
		} finally {
			globalThis.fetch = original
		}
	})

	test("a 400 is not retried", async () => {
		const original = globalThis.fetch
		let calls = 0
		globalThis.fetch = (async () => {
			calls += 1
			return new Response("bad request", { status: 400 })
		}) as unknown as typeof fetch
		try {
			await expect(PROVIDER_INTERNALS.fetchJson("jina", "https://example.test", {}, cfg)).rejects.toMatchObject({
				status: 400,
			})
			expect(calls).toBe(1)
		} finally {
			globalThis.fetch = original
		}
	})

	test("an aborted signal stops the retry loop at once", async () => {
		const controller = new AbortController()
		let calls = 0
		await expect(
			PROVIDER_INTERNALS.withRetry("jina", cfg, controller.signal, async () => {
				calls += 1
				controller.abort()
				throw new Error("first attempt failed")
			}),
		).rejects.toThrow("first attempt failed")
		expect(calls).toBe(1)
	})

	test("the retry is logged with the attempt and the status", async () => {
		const messages: string[] = []
		const logged = { ...cfg, retryAttempts: 1, retryLog: (message: string) => messages.push(message) }
		let calls = 0
		await PROVIDER_INTERNALS.withRetry("tavily", logged, undefined, async () => {
			calls += 1
			if (calls === 1) throw new ProviderError("tavily", "429 Too Many Requests", 429)
			return "ok"
		})
		expect(calls).toBe(2)
		expect(messages.join("\n")).toContain("retrying tavily")
		expect(messages.join("\n")).toContain("status 429")
	})
})

describe("private address guard", () => {
	test("loopback, private and link-local addresses are blocked", () => {
		for (const host of [
			"localhost",
			"127.0.0.1",
			"127.1.2.3",
			"10.0.0.5",
			"172.16.0.1",
			"172.31.255.255",
			"192.168.1.1",
			"169.254.169.254",
			"0.0.0.0",
			"::1",
			"[::1]",
			"fd00::1",
			"fe80::1",
			"fc00::1",
			"metadata.google.internal",
			"myservice.local",
			"thing.internal",
		]) {
			expect(isPrivateHostname(host)).toBe(true)
		}
	})

	test("public addresses and normal hostnames pass", () => {
		for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "1.1.1.1", "www.firecrawl.dev", "2606:4700::1111"]) {
			expect(isPrivateHostname(host)).toBe(false)
		}
	})

	test("assertWebUrl rejects non-http schemes and private hosts", () => {
		expect(() => assertWebUrl("ftp://example.com/x", false)).toThrow(InputError)
		expect(() => assertWebUrl("file:///etc/passwd", false)).toThrow(InputError)
		expect(() => assertWebUrl("http://localhost:3000", false)).toThrow(InputError)
		expect(() => assertWebUrl("http://169.254.169.254/latest/meta-data", false)).toThrow(InputError)
		expect(() => assertWebUrl("not-a-url", false)).toThrow(InputError)
	})

	test("assertWebUrl accepts public urls and private ones when allowed", () => {
		expect(assertWebUrl("https://example.com/a?b=c", false).hostname).toBe("example.com")
		expect(assertWebUrl("http://localhost:3000", true).hostname).toBe("localhost")
	})
})

describe("response normalization", () => {
	test("tavily search results are mapped and entries without a url are dropped", () => {
		const outcome = PROVIDER_INTERNALS.normalizeTavilySearch({
			answer: "42",
			results: [
				{ title: "First", url: "https://a.test", content: "snippet a", score: 0.91, raw_content: "# First" },
				{ title: "No url" },
				{ title: "Second", url: "https://b.test", content: "snippet b" },
			],
		})
		expect(outcome.backend).toBe("tavily")
		expect(outcome.answer).toBe("42")
		expect(outcome.results).toHaveLength(2)
		expect(outcome.results[0]).toEqual({
			title: "First",
			url: "https://a.test",
			snippet: "snippet a",
			score: 0.91,
			content: "# First",
		})
		expect(outcome.results[1].score).toBeUndefined()
	})

	test("tavily search survives junk", () => {
		const outcome = PROVIDER_INTERNALS.normalizeTavilySearch({ results: "nope" })
		expect(outcome.results).toEqual([])
		expect(PROVIDER_INTERNALS.normalizeTavilySearch(undefined).results).toEqual([])
	})

	test("jina search reads the data array", () => {
		const outcome = PROVIDER_INTERNALS.normalizeJinaSearch({
			data: [
				{ title: "One", url: "https://one.test", description: "d1" },
				{ title: "Two", url: "https://two.test", content: "c2" },
			],
		})
		expect(outcome.backend).toBe("jina")
		expect(outcome.results).toHaveLength(2)
		expect(outcome.results[0].snippet).toBe("d1")
		expect(outcome.results[1].snippet).toBe("c2")
	})

	test("firecrawl page handles the wrapped and the flat response shape", () => {
		const wrapped = PROVIDER_INTERNALS.normalizeFirecrawlPage(
			{
				success: true,
				data: { markdown: "# Title", metadata: { title: "Title", sourceURL: "https://a.test" } },
			},
			"https://fallback.test",
		)
		expect(wrapped.content).toBe("# Title")
		expect(wrapped.title).toBe("Title")
		expect(wrapped.url).toBe("https://a.test")

		const flat = PROVIDER_INTERNALS.normalizeFirecrawlPage(
			{ markdown: "flat body", metadata: { title: "Flat" } },
			"https://fallback.test",
		)
		expect(flat.content).toBe("flat body")
		expect(flat.url).toBe("https://fallback.test")
	})

	test("firecrawl crawl pages are mapped from the data array", () => {
		const pages = PROVIDER_INTERNALS.normalizeFirecrawlCrawl({
			status: "completed",
			data: [
				{ markdown: "a", metadata: { sourceURL: "https://a.test", title: "A" } },
				{ markdown: "b", metadata: { sourceURL: "https://b.test", title: "B" } },
			],
		})
		expect(pages).toHaveLength(2)
		expect(pages[1]).toEqual(
			expect.objectContaining({ url: "https://b.test", title: "B", content: "b" }),
		)
	})

	test("jina plain text preamble is parsed", () => {
		const parsed = PROVIDER_INTERNALS.parseJinaText(
			"Title: Example\nURL Source: https://example.com\nMarkdown Content:\n# Body",
		)
		expect(parsed.title).toBe("Example")
		expect(parsed.url).toBe("https://example.com")
		expect(parsed.content).toBe("# Body")
	})

	test("exa results prefer the first highlight as the snippet", () => {
		const outcome = PROVIDER_INTERNALS.normalizeExaSearch({
			results: [
				{
					title: "Paper",
					url: "https://arxiv.test/abs/1",
					highlights: ["first match", "second match"],
					summary: "a summary",
					text: "full body",
					score: 0.8,
				},
				{ title: "No highlights", url: "https://arxiv.test/abs/2", summary: "just a summary" },
				{ title: "No url" },
			],
		})
		expect(outcome.backend).toBe("exa")
		expect(outcome.results).toHaveLength(2)
		expect(outcome.results[0].snippet).toBe("first match")
		expect(outcome.results[0].content).toBe("full body")
		expect(outcome.results[0].score).toBe(0.8)
		expect(outcome.results[1].snippet).toBe("just a summary")
	})

	test("exa search survives junk", () => {
		expect(PROVIDER_INTERNALS.normalizeExaSearch({ results: "nope" }).results).toEqual([])
		expect(PROVIDER_INTERNALS.normalizeExaSearch(undefined).results).toEqual([])
	})

	test("publishedDateSince produces an ISO date the right age", () => {
		const now = new Date("2026-10-21T00:00:00.000Z")
		expect(PROVIDER_INTERNALS.publishedDateSince(7, now)).toBe("2026-10-14T00:00:00.000Z")
		expect(PROVIDER_INTERNALS.publishedDateSince(1, now)).toBe("2026-10-20T00:00:00.000Z")
	})
})

describe("routing instructions", () => {
	const all = { tavily: true, exa: true, firecrawl: true, jina: true }

	test("every route is described when every backend is available", () => {
		const text = internals.buildRoutingText(all)
		for (const tool of [
			"research_search",
			"research_find_similar",
			"research_read",
			"research_crawl",
			"research_map",
			"research_extract",
		]) {
			expect(text).toContain(tool)
		}
		expect(text).toContain("Tavily")
		expect(text).toContain("Exa")
		expect(text).toContain("Firecrawl")
		expect(text).toContain("Jina")
	})

	test("a route without a credential is not advertised", () => {
		const text = internals.buildRoutingText({ tavily: false, exa: false, firecrawl: false, jina: true })
		expect(text).toContain("research_search")
		expect(text).not.toContain("research_crawl")
		expect(text).not.toContain("research_map")
		expect(text).not.toContain("research_extract")
		expect(text).not.toContain("research_find_similar")
		expect(text).not.toContain("Tavily")
		expect(text).not.toContain("Exa")
		expect(text).not.toContain("Firecrawl")
		// Jina is keyless, so reading a URL always stays available.
		expect(text).toContain("Jina")
	})

	test("exa alone still offers the similar-pages route", () => {
		const text = internals.buildRoutingText({ tavily: false, exa: true, firecrawl: false, jina: true })
		expect(text).toContain("research_find_similar")
		expect(text).toContain("Exa")
		expect(text).not.toContain("research_crawl")
	})

	test("the routing block stays inside its size budget", () => {
		expect(internals.buildRoutingText(all).length).toBeLessThan(4_000)
	})

	test("the research contract names the question and the citation rules", () => {
		const contract = internals.buildResearchContract("why is the sky blue")
		expect(contract).toContain("why is the sky blue")
		expect(contract).toContain("URL")
	})
})

describe("output formatting", () => {
	test("search results are numbered and carry their url", () => {
		const text = internals.formatSearchResults(
			{
				backend: "tavily",
				answer: "the answer",
				results: [{ title: "One", url: "https://one.test", snippet: "s1", score: 0.5 }],
			},
			"query text",
			8,
		)
		expect(text).toContain("1. One")
		expect(text).toContain("https://one.test")
		expect(text).toContain("the answer")
		expect(text).toContain("query text")
	})

	test("an empty search result says so instead of returning nothing", () => {
		const text = internals.formatSearchResults({ backend: "jina", results: [] }, "nothing", 8)
		expect(text).toContain("No results")
	})

	test("page output keeps the source and truncates long content", () => {
		const text = internals.formatPageResult(
			{ url: "https://a.test", title: "A", content: "x".repeat(200) },
			50,
		)
		expect(text).toContain("source: https://a.test")
		expect(text).toContain("truncated")
	})

	test("crawl output lists every page with its url", () => {
		const text = internals.formatCrawlResults(
			[
				{ url: "https://a.test", title: "A", content: "one" },
				{ url: "https://b.test", title: "B", content: "two" },
			],
			"https://site.test",
			100,
		)
		expect(text).toContain("Crawled 2 page(s)")
		expect(text).toContain("https://b.test")
	})

	test("the source list deduplicates urls", () => {
		expect(internals.formatSourceList(["https://a.test", "https://a.test", "https://b.test"])).toBe(
			"- https://a.test\n- https://b.test",
		)
		expect(internals.formatSourceList([])).toBe("(no sources)")
	})
})

describe("time window translation", () => {
	test("a relative time range becomes a day count for the Exa fallback", () => {
		expect(internals.exaWindowDays({ timeRange: "day" })).toBe(1)
		expect(internals.exaWindowDays({ timeRange: "week" })).toBe(7)
		expect(internals.exaWindowDays({ timeRange: "month" })).toBe(30)
		expect(internals.exaWindowDays({ timeRange: "year" })).toBe(365)
	})

	test("an explicit day count wins over the named range", () => {
		expect(internals.exaWindowDays({ timeRange: "year", days: 3 })).toBe(3)
	})

	test("no window means no restriction", () => {
		expect(internals.exaWindowDays({})).toBeUndefined()
		expect(internals.exaWindowDays({ timeRange: "nonsense" })).toBeUndefined()
		expect(internals.exaWindowDays({ days: 0 })).toBeUndefined()
	})
})

describe("research briefs", () => {
	test("a persisted brief is accepted only with every field", () => {
		expect(
			internals.isResearchBrief({ sessionID: "s", question: "q", createdAt: 1 }),
		).toBe(true)
		expect(internals.isResearchBrief({ sessionID: "s", question: "q" })).toBe(false)
		expect(internals.isResearchBrief(undefined)).toBe(false)
	})

	test("brief storage keys are namespaced by session", () => {
		expect(internals.briefStorageKey("ses_1")).toBe("research/brief/ses_1")
	})
})

describe("Jina domain filters", () => {
	test("a domain matches the exact host and its subdomains only", () => {
		expect(PROVIDER_INTERNALS.hostMatchesDomain("example.com", "example.com")).toBe(true)
		expect(PROVIDER_INTERNALS.hostMatchesDomain("docs.example.com", "example.com")).toBe(true)
		expect(PROVIDER_INTERNALS.hostMatchesDomain("EXAMPLE.COM", "example.com")).toBe(true)
		expect(PROVIDER_INTERNALS.hostMatchesDomain("example.com.", "example.com")).toBe(true)
		expect(PROVIDER_INTERNALS.hostMatchesDomain("example.com", "*.example.com")).toBe(true)
		expect(PROVIDER_INTERNALS.hostMatchesDomain("example.com.evil.net", "example.com")).toBe(false)
		expect(PROVIDER_INTERNALS.hostMatchesDomain("notexample.com", "example.com")).toBe(false)
	})

	test("includeDomains keeps only the listed domains, excludeDomains drops them", () => {
		const results = [
			{ title: "A", url: "https://docs.example.com/a", snippet: "" },
			{ title: "B", url: "https://other.test/b", snippet: "" },
			{ title: "C", url: "https://example.com.evil.net/c", snippet: "" },
		]
		const included = PROVIDER_INTERNALS.filterResultsByDomain(results, { includeDomains: ["example.com"] })
		expect(included.results.map((entry) => entry.title)).toEqual(["A"])
		expect(included.removed).toBe(2)

		const excluded = PROVIDER_INTERNALS.filterResultsByDomain(results, { excludeDomains: ["example.com"] })
		expect(excluded.results.map((entry) => entry.title)).toEqual(["B", "C"])
		expect(excluded.returned).toBe(3)
		expect(excluded.removed).toBe(1)
	})

	test("a filter that removes everything reports the count", () => {
		const outcome = PROVIDER_INTERNALS.filterResultsByDomain(
			[
				{ title: "A", url: "https://a.test", snippet: "" },
				{ title: "B", url: "https://b.test", snippet: "" },
			],
			{ includeDomains: ["allowed.test"] },
		)
		expect(outcome.results).toEqual([])
		expect(outcome.removed).toBe(2)
		const text = internals.formatSearchResults({ backend: "jina", results: [], filter: outcome }, "q", 8)
		expect(text).toContain("returned 2 result(s)")
		expect(text).toContain("removed all of them")
		expect(text).not.toContain("No results")
	})

	test("unsupported Jina filters are stated, and other backends have none", () => {
		const notes = PROVIDER_INTERNALS.describeUnsupportedFilters("jina", {
			timeRange: "week",
			includeAnswer: true,
			topic: "news",
		})
		expect(notes.join("\n")).toContain("time window")
		expect(notes.join("\n")).toContain("generated answer")
		expect(notes.join("\n")).toContain('"news"')
		expect(PROVIDER_INTERNALS.describeUnsupportedFilters("tavily", { timeRange: "week" })).toEqual([])
	})

	test("unsupported notes ride along with the formatted results", () => {
		const text = internals.formatSearchResults(
			{ backend: "jina", results: [{ title: "A", url: "https://a.test", snippet: "s" }] },
			"q",
			8,
			["jina search returns no generated answer"],
		)
		expect(text).toContain("note: jina search returns no generated answer")
	})
})

describe("merged search", () => {
	test("url normalization removes the parts that do not identify a page", () => {
		expect(PROVIDER_INTERNALS.normalizeUrl("https://WWW.Example.com/path/?utm_source=x&b=2&a=1#frag")).toBe(
			"example.com/path?a=1&b=2",
		)
		expect(PROVIDER_INTERNALS.normalizeUrl("https://example.com/")).toBe("example.com")
		expect(PROVIDER_INTERNALS.normalizeUrl("https://example.com/path/")).toBe("example.com/path")
		expect(PROVIDER_INTERNALS.normalizeUrl("https://example.com:443/x")).toBe("example.com/x")
	})

	test("the merged list keeps the first engine's order, then what the second adds", () => {
		const merged = PROVIDER_INTERNALS.mergeSearchResults([
			{
				backend: "tavily",
				results: [
					{ title: "A", url: "https://a.test", snippet: "a" },
					{ title: "B", url: "https://b.test", snippet: "b" },
				],
			},
			{
				backend: "exa",
				results: [
					{ title: "B again", url: "https://www.b.test/", snippet: "b2" },
					{ title: "C", url: "https://c.test", snippet: "c" },
				],
			},
		])
		expect(merged.results.map((entry) => entry.url)).toEqual([
			"https://a.test",
			"https://b.test",
			"https://c.test",
		])
		expect(merged.results[1].engines).toEqual(["tavily", "exa"])
		expect(merged.results[1].positions).toEqual({ tavily: 2, exa: 1 })
		expect(merged.results[0].engines).toEqual(["tavily"])
		expect(merged.answered).toEqual(["tavily", "exa"])
	})

	test("a large rank gap between engines is reported as a disagreement", () => {
		const merged = PROVIDER_INTERNALS.mergeSearchResults([
			{
				backend: "tavily",
				results: Array.from({ length: 6 }, (_, index) => ({
					title: `T${index}`,
					url: `https://t${index}.test`,
					snippet: "",
				})),
			},
			{
				backend: "exa",
				results: [
					...Array.from({ length: 5 }, (_, index) => ({
						title: `E${index}`,
						url: `https://e${index}.test`,
						snippet: "",
					})),
					{ title: "far", url: "https://t0.test", snippet: "" },
				],
			},
		])
		expect(merged.disagreements.map((entry) => entry.url)).toEqual(["https://t0.test"])
	})

	test("the merged format names the engines, the labels and the failures", () => {
		const text = internals.formatMergedSearchResults(
			{
				results: [
					{
						title: "A",
						url: "https://a.test",
						snippet: "s",
						engines: ["tavily", "exa"],
						positions: { tavily: 1, exa: 1 },
					},
				],
				answered: ["tavily", "exa"],
				failed: [{ backend: "jina", error: "429" }],
				disagreements: [],
			},
			"q",
			8,
		)
		expect(text).toContain("Merged search")
		expect(text).toContain("tavily, exa")
		expect(text).toContain("[tavily+exa]")
		expect(text).toContain("jina failed: 429")
	})
})

describe("read cache", () => {
	test("the key covers the backend and every option that changes the text", () => {
		const base = internals.cacheEntryKey("firecrawl", "https://a.test", { format: "markdown" })
		expect(base.startsWith("research/cache/")).toBe(true)
		expect(internals.cacheEntryKey("firecrawl", "https://a.test", { format: "markdown" })).toBe(base)
		expect(internals.cacheEntryKey("jina", "https://a.test", { format: "markdown" })).not.toBe(base)
		expect(internals.cacheEntryKey("jina", "https://a.test", { format: "text" })).not.toBe(base)
		expect(internals.cacheEntryKey("jina", "https://a.test", { targetSelector: "#main" })).not.toBe(base)
		expect(internals.cacheEntryKey("jina", "https://a.test", { removeSelector: "nav" })).not.toBe(base)
		expect(internals.cacheEntryKey("jina", "https://a.test", { withLinksSummary: true })).not.toBe(base)
	})

	test("an entry older than the TTL is a miss", () => {
		const now = Date.parse("2026-10-21T12:00:00Z")
		expect(internals.isCacheFresh(now - 1000, 60_000, now)).toBe(true)
		expect(internals.isCacheFresh(now - 120_000, 60_000, now)).toBe(false)
	})

	test("the cache note says it is cached and how old it is", () => {
		const now = Date.parse("2026-10-21T12:00:00Z")
		const note = internals.formatCacheNote(now - 2 * 60 * 60 * 1000, "firecrawl", now)
		expect(note).toContain("cached")
		expect(note).toContain("2 hour(s)")
		expect(note).toContain("firecrawl")
	})

	test("cache settings resolve from options, then env, then defaults", () => {
		const defaults = internals.resolveStateOptions({}, {})
		expect(defaults.cacheEnabled).toBe(true)
		expect(defaults.cacheTtlMs).toBe(24 * 60 * 60 * 1000)
		expect(internals.resolveStateOptions({ cacheEnabled: false }, {}).cacheEnabled).toBe(false)
		expect(internals.resolveStateOptions({}, { RESEARCH_CACHE_ENABLED: "0" }).cacheEnabled).toBe(false)
		expect(internals.resolveStateOptions({}, { RESEARCH_CACHE_TTL_MS: "1000" }).cacheTtlMs).toBe(1000)
		expect(internals.resolveStateOptions({ cacheTtlMs: 500 }, { RESEARCH_CACHE_TTL_MS: "1000" }).cacheTtlMs).toBe(500)
	})
})

describe("source ledger", () => {
	const entry = (url: string, readAt: number) => ({ url, title: url, backend: "firecrawl" as const, readAt, excerpt: "" })

	test("entries append and the same URL is updated, not duplicated", () => {
		let ledger = internals.emptyLedger("s")
		ledger = internals.appendSource(ledger, entry("https://a.test", 1), 10)
		ledger = internals.appendSource(ledger, entry("https://b.test", 2), 10)
		expect(ledger.entries.map((item) => item.url)).toEqual(["https://a.test", "https://b.test"])
		ledger = internals.appendSource(ledger, entry("https://a.test", 3), 10)
		expect(ledger.entries.map((item) => item.url)).toEqual(["https://b.test", "https://a.test"])
	})

	test("the cap drops the oldest entries and reports how many", () => {
		let ledger = internals.emptyLedger("s")
		ledger = internals.appendSource(ledger, entry("https://a.test", 1), 2)
		ledger = internals.appendSource(ledger, entry("https://b.test", 2), 2)
		ledger = internals.appendSource(ledger, entry("https://c.test", 3), 2)
		expect(ledger.entries.map((item) => item.url)).toEqual(["https://b.test", "https://c.test"])
		expect(ledger.dropped).toBe(1)
	})

	test("ledger keys are per session and malformed values are rejected", () => {
		expect(internals.sourceStorageKey("ses_1")).toBe("research/sources/ses_1")
		expect(internals.isSessionLedger({ sessionID: "s", entries: [], dropped: 0 })).toBe(true)
		expect(internals.isSessionLedger({ sessionID: "s", entries: [] })).toBe(false)
	})

	test("an empty ledger says so, and a full one lists URLs with backend and time", () => {
		expect(internals.formatSourceLedger(internals.emptyLedger("s"))).toContain("No sources read")
		const ledger = internals.appendSource(internals.emptyLedger("s"), entry("https://a.test", 0), 5)
		const text = internals.formatSourceLedger(ledger)
		expect(text).toContain("https://a.test")
		expect(text).toContain("firecrawl")
		expect(text).toContain("1970-01-01 00:00 UTC")
		expect(text).toContain("Source list:")
	})
})

describe("session stats", () => {
	test("the counters start at zero for every backend", () => {
		const stats = internals.emptyStats("s")
		for (const backend of ["tavily", "exa", "firecrawl", "jina"] as const) {
			expect(stats.backends[backend]).toEqual({ calls: 0, failures: 0, fallbacks: 0, results: 0 })
		}
		expect(stats.pagesRead).toBe(0)
		expect(internals.isResearchStats(stats)).toBe(true)
		expect(internals.isResearchStats({ sessionID: "s" })).toBe(false)
		expect(internals.statsStorageKey("lifetime")).toBe("research/stats/lifetime")
	})

	test("the view shows zeros, the page counts and the lifetime total", () => {
		const stats = internals.emptyStats("s")
		const lifetime = internals.emptyStats("lifetime")
		lifetime.backends.tavily.calls = 10
		lifetime.backends.tavily.failures = 2
		const text = internals.formatStats(stats, lifetime)
		expect(text).toContain("Research stats")
		expect(text).toContain("pages read: 0")
		expect(text).toContain("cache hits: 0")
		expect(text).toContain("lifetime: 10 call(s), 2 failure(s)")
		expect(text).toContain("no query text")
		expect(text).not.toContain("TAVILY_API_KEY")
	})
})

describe("routing injection decision", () => {
	test("no brief and no setting means no routing block", () => {
		expect(internals.routingMode({ hasBrief: false, routingAlways: false, injectRouting: true })).toBe("none")
	})

	test("an active brief gets the contract and the routing block", () => {
		expect(internals.routingMode({ hasBrief: true, routingAlways: false, injectRouting: true })).toBe("contract+routing")
	})

	test("routingAlways restores the block in every session", () => {
		expect(internals.routingMode({ hasBrief: false, routingAlways: true, injectRouting: true })).toBe("routing")
	})

	test("injectRouting false wins over everything", () => {
		expect(internals.routingMode({ hasBrief: true, routingAlways: true, injectRouting: false })).toBe("none")
	})

	test("the routing block names the ledger and the merge mode", () => {
		const all = { tavily: true, exa: true, firecrawl: true, jina: true }
		const procedure = internals.buildRoutingText(all)
		expect(procedure).toContain("research_sources")
		expect(procedure).toContain('mode "merge"')
		expect(procedure).toContain("RULES")
		expect(internals.buildResearchContract("q")).toContain("research_sources")
	})
})
