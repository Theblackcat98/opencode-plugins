# research — one research surface over four backends

Bundles **Tavily**, **Exa**, **Firecrawl** and **Jina AI** behind a single tool
namespace, and ships a routing block as a system instruction so the model
picks the right backend per job instead of defaulting to whichever tool it
saw first.

The four backends overlap. That overlap is the problem this plugin solves:
without an explicit decision procedure, a model tends to use one scraper for
everything, then either misses the content that only Firecrawl can render or
pays for Tavily credits when a plain URL fetch would have done.

## Tools

| Tool | Job | Backends (in order) |
| --- | --- | --- |
| `research_search` | Find candidate sources on the public web | Tavily → Exa → Jina search |
| `research_find_similar` | Find pages like a URL you already have | Exa |
| `research_read` | Read **one** URL as clean markdown | Firecrawl → Jina reader |
| `research_crawl` | Read **many** pages of one site | Firecrawl |
| `research_map` | List the URLs of a site without fetching them | Tavily → Firecrawl |
| `research_extract` | Pull structured fields out of known URLs | Firecrawl → Tavily extract |

### Why each route exists

- **Tavily** is a search engine built for agents. It understands natural
  language queries, filters by news/finance topic, domain and time range, and
  can return a generated answer plus the raw page text.
- **Exa** searches by meaning rather than by keyword. It is the better choice
  for conceptual queries, academic papers and technical content, where the
  right words are not known up front. It is also the only backend that can
  answer "find more pages like this one".
- **Firecrawl** renders JavaScript, handles PDFs, and can crawl a whole site or
  extract a JSON-schema-shaped object from a set of pages.
- **Jina AI** turns a URL into LLM-ready markdown in one call and **works
  without an API key** (at a lower rate limit). It is the fallback that keeps
  `research_read` alive when nothing else is configured, and it is the only
  route that stays available with zero credentials.

### Choosing a search engine

`research_search` takes an `engine` parameter:

| `engine` | Order | Use for |
| --- | --- | --- |
| `auto` (default) | Tavily → Exa → Jina | General questions |
| `neural` | Exa → Tavily → Jina | Conceptual, academic, technical queries where the exact keywords are unknown |
| `keyword` | Tavily → Exa → Jina | Literal lookups: a product name, an error string, a specific term |

The `timeRange` and `days` filters are translated into Exa's date window, so
the Exa fallback is restricted the same way as the primary search.

### Fallback behaviour

Each tool tries its backends in order. The first success wins and the result
names the backend that answered. If a backend fails, the failure is appended to
the output so the model knows the answer came from a fallback:

```
[used a fallback: tavily failed: 401 Unauthorized: missing or invalid API key.]
```

Bad input (a malformed URL, a private address) never triggers a fallback: it
would be rejected the same way, so the tool returns the error directly.

## Configuration

Credentials come from environment variables. Plugin options win over the
environment.

| Option | Environment variable | Purpose |
| --- | --- | --- |
| `tavilyKey` | `TAVILY_API_KEY` or `TVLY_API_KEY` | Tavily search, map, extract |
| `exaKey` | `EXA_API_KEY` | Exa search and find-similar |
| `firecrawlKey` | `FIRECRAWL_API_KEY` or `FIRECRAWL_KEY` | Firecrawl scrape, crawl, map, extract |
| `jinaKey` | `JINA_API_KEY` or `JINA_AI_API_KEY` | Optional. Jina works keyless without it |
| `allowPrivateUrls` | — | Allow fetching private/loopback addresses. Default `false` |
| `requestTimeoutMs` | `RESEARCH_REQUEST_TIMEOUT_MS` | Per-request timeout (default 60000) |
| `crawlTimeoutMs` | `RESEARCH_CRAWL_TIMEOUT_MS` | Crawl job budget (default 180000) |
| `injectRouting` | — | Set `false` to stop injecting the routing block on every model call |
| `websearchDefault` | — | Set `true` to make Tavily the default native websearch provider |

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/research",
      "options": {
        "allowPrivateUrls": false,
      },
    },
  ],
}
```

A route whose credential is missing is **not advertised** in the routing block.
With no keys at all, the model is told only that Jina is available, and it
still has a working `research_read`.

## The routing block

The routing text is a system instruction pushed onto every model call through
the `context` session hook. It is rebuilt from the backends that actually have
credentials, and it names the one job each route is good at:

```
ROUTES
research_search         — FIND SOURCES on the public web. Tavily: AI-shaped search, ...
research_find_similar   — FIND PAGES LIKE A KNOWN URL. Exa only. ...
research_read           — READ ONE URL as clean markdown. Firecrawl: JS-rendered pages, ...
research_crawl          — READ MANY PAGES of one site. Firecrawl only. ...
research_map            — LIST THE URLS of a site without fetching them. ...
research_extract        — PULL STRUCTURED FIELDS out of known URLs. ...

ORDER OF WORK
1. research_search to find candidate sources.
2. research_read on the promising URLs. research_crawl only when one page is not enough.
3. research_extract when you need specific fields instead of full prose.
4. research_find_similar when one good source suggests the rest of the literature.
```

It stays under 4000 characters, and around 800 tokens with every backend
configured.

## `/research` command

`/research <question>` starts a sourced research task. The question is stored
in `ctx.storage` (so it survives a restart) and a stricter contract rides along
as a system instruction:

```
--- RESEARCH CONTRACT (authoritative, managed by the research plugin) ---
Question to answer: why does X happen

Rules:
- Use the research_* tools. Do not answer from memory; verify against sources.
- ...
- Every factual claim in the final answer must carry the URL it came from.
- ...
---
```

The contract survives compaction: the question is prepended to the summary so
a long research session does not lose its subject.

## Security

`research_read`, `research_crawl`, `research_map` and `research_extract` refuse
URLs that point at private, loopback, link-local or metadata addresses
(`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`,
`*.internal`, `*.local`, `metadata.google.internal`). This blocks the obvious
server-side request forgery path of pointing the agent at a cloud metadata
service.

The check is **hostname based**, so a public hostname that resolves to a private
address still passes. It is a guard against accidents, not a complete SSRF
defence.

### Why a local DNS check would not help

The plugin never fetches a URL itself. `research_read`, `research_crawl`,
`research_map` and `research_extract` hand the URL to Firecrawl or Jina, and
that service fetches it from its own network. Two things follow:

- Resolving the hostname here would say nothing about the address the provider
  reaches. It would only ever protect the machine running OpenCode, which is
  not the machine that makes the request.
- A redirect cannot be inspected either. The provider follows it, so a public
  host that redirects to a link-local address is out of reach of this guard.

What the guard does buy is the common accident: the agent cannot hand a
private, loopback or metadata-looking host to a third party by name. That is
what it blocks, and it is worth keeping for that reason alone.

## Layout

```
plugins/research/
├── index.ts        # plugin: tools, command, session hooks
├── providers.ts    # the four backend clients and response normalizers
├── routing.ts      # routing block and output formatting
└── index.test.ts   # unit tests for the pure helpers
```

Server half only. There is no TUI half and no RPC contract: the plugin has
nothing to render and nothing to share between processes.

## Install

```sh
cp -r plugins/research ~/.config/opencode/plugins/research
```

Then restart the OpenCode service (`opencode service restart`).
