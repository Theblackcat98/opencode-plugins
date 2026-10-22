import { describe, expect, test } from "bun:test"
import { internals } from "./index.js"
import { INTERNALS as PROVIDER_INTERNALS, InputError, assertWebUrl, isPrivateHostname } from "./providers.js"

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
