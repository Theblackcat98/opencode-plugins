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
| `research_sources` | List the sources actually read in this session | storage only |
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

### Merged search

`mode: "merge"` queries more than one engine and returns the union, because one
engine's blind spot should not be the whole answer. It costs a second call, so
it is opt-in.

| Setting | Default | Meaning |
| --- | --- | --- |
| `mode` | `auto` | `auto` = first engine that answers wins. `merge` = query several and combine |
| `maxEngines` | `2` | How many engines may take part in a merge (capped at the number available) |

The merge path:

- runs the chosen engines concurrently; one failure never fails the search;
- deduplicates by a normalised URL (lower-case host, no `www.`, no fragment, no
  tracking parameters, no trailing slash);
- keeps the first engine's ranking, then what the second engine adds;
- labels each result with every engine that found it (`[tavily+exa]`), because
  agreement between engines is the strongest signal in the set;
- names the engines that answered and the ones that failed;
- reports a URL ranked at least 5 positions apart by two engines, since that is
  a cheap sign that the ranking is weak and the page deserves a read.

### Jina filters

Jina search has no domain filter of its own, so `includeDomains` and
`excludeDomains` are applied **locally**, before the result limit, on an exact
host or subdomain match. `example.com` covers `docs.example.com`; it does not
cover the lookalike `example.com.evil.net`.

Jina results carry no publication date and no generated answer, so `timeRange`,
`days` and `includeAnswer` cannot be applied there. The tool output says so
instead of pretending otherwise. When a domain filter removes every result,
the output reports how many the engine returned and that the filter removed all
of them; it does not read as "no results for this query".

### Fallback behaviour

Each tool tries its backends in order. The first success wins and the result
names the backend that answered. If a backend fails, the failure is appended to
the output so the model knows the answer came from a fallback:

```
[used a fallback: tavily failed: 401 Unauthorized: missing or invalid API key.]
```

Bad input (a malformed URL, a private address) never triggers a fallback: it
would be rejected the same way, so the tool returns the error directly.

## Retry

A transient `429` or `5xx` should not end a research run, so every provider call
except the Firecrawl crawl poll is retried with bounded exponential backoff.

- Retried: `429`, `5xx`, and network errors.
- Not retried: `400`, `401`, `403`, `404`, a request timeout, or a caller abort.
  A bad key or malformed request will not fix itself, and a timed-out request
  may already have reached the provider.
- Delay: 1s, then 4s (two retries, three attempts), capped by the request
  timeout, with up to 25 percent jitter so parallel sessions do not resynchronise.
- `Retry-After` is honoured when present, in seconds or as an HTTP date.
- The retry is logged with the backend, the attempt, the status and the delay.
- The Firecrawl crawl polling loop is excluded: it has its own deadline and
  sleep, so retrying there would only stack backoff on top of its own wait.

## Read cache

A page read twice in one run is a bill paid twice. `research_read` keeps a
durable cache in OpenCode storage, so it survives a restart.

- Key: backend + URL + every option that changes the returned text (`format`,
  `targetSelector`, `removeSelector`, `includeLinks`, `onlyMainContent`).
  Two reads that differ only in a selector do not share an entry.
- Value: the page, the backend that returned it, and the fetch time.
- TTL: 24 hours by default. An older entry is a miss.
- The output says the page came from the cache and how old it is; cached text
  can be stale, and the model should know which it is reading.
- Search results are **not** cached: a search is cheap, and a stale result set
  is worse than a stale page.
- A storage failure is never a read failure. A miss or an error falls back to a
  normal fetch.
- The cache is pruned at startup and whenever it grows past its entry cap:
  entries older than the TTL are dropped, and the count is corrected from the
  storage scan.

## Source ledger

The research contract asks for a source list, and the old way to produce it was
the model's memory of its own transcript, which drifts after a compaction.

`research_read`, `research_crawl` and `research_extract` now append to a
per-session ledger: URL, title, backend, time and a short excerpt. The
`research_sources` tool reads it back with no network call, and the contract and
routing block point at it, so the final list is the set of URLs that were
actually read. A URL that was never read is visibly absent.

The ledger lives under `research/sources/<sessionID>`, never leaks into another
session, and goes away with the session. It is capped (200 entries by default,
oldest dropped first) and reports how many entries fell off the end.

## Stats

`/research stats` prints counters for the current session, plus a lifetime
total, so a paid feature has a feedback loop:

- calls, failures, fallback hits and results per backend;
- pages read, pages crawled, URLs extracted, characters returned;
- cache hits.

It holds counts only: no query text, no credentials. The counters are stored
under `research/stats/<sessionID>` and survive a plugin restart. A failed
counter write is logged and ignored; it never breaks a tool call.

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
| `retryAttempts` | `RESEARCH_RETRY_ATTEMPTS` | Retries on 429/5xx/network errors (default `2`; `0` disables) |
| `retryBaseDelayMs` | `RESEARCH_RETRY_BASE_DELAY_MS` | First backoff delay; the second is 4x (default `1000`) |
| `cacheEnabled` | `RESEARCH_CACHE_ENABLED` | Keep the read cache (default `true`; `false`/`0` disables) |
| `cacheTtlMs` | `RESEARCH_CACHE_TTL_MS` | Cache lifetime (default 86400000, 24 hours) |
| `cacheMaxEntries` | `RESEARCH_CACHE_MAX_ENTRIES` | Prune the cache above this count (default `200`) |
| `ledgerMaxEntries` | `RESEARCH_LEDGER_MAX_ENTRIES` | Source ledger cap per session (default `200`) |
| `injectRouting` | — | Set `false` to stop injecting the routing block entirely |
| `routingAlways` | `RESEARCH_ROUTING_ALWAYS` | Set `true` to inject the block in every session (default `false`) |
| `websearchDefault` | — | Set `true` to make Tavily the default native websearch provider |

```jsonc title="opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "./plugins/research",
      "options": {
        "allowPrivateUrls": false,
        "retryAttempts": 2,
        "cacheEnabled": true,
      },
    },
  ],
}
```

A route whose credential is missing is **not advertised** in the routing block.
With no keys at all, the model is told only that Jina is available, and it
still has a working `research_read`.

## The routing block

The routing text is a system instruction. It is rebuilt from the backends that
actually have credentials, and it names the one job each route is good at:

```
ROUTES
research_search         — FIND SOURCES. Tavily: ... Exa: ... keyless Jina search as the fallback. ...
research_find_similar   — PAGES LIKE A KNOWN URL. Exa only.
research_read           — READ ONE URL as markdown. ...
research_crawl          — MANY PAGES of one site. Firecrawl only.
research_map            — URLS OF A SITE, no fetch. ...
research_extract        — FIELDS FROM KNOWN URLS. ...
research_sources        — SOURCES READ this session, with backend and time. ...

ORDER OF WORK
1. research_search to find candidates.
2. research_read the promising URLs.
...
```

It used to be pushed onto **every** model call in every session, including the
sessions that only edit a file. That was a permanent tax on a feature most
sessions never use. It is now injected only when it can change behaviour:

- a session with an active `/research` brief receives the contract and the full
  block;
- `routingAlways: true` restores the old behaviour everywhere;
- every other session receives nothing. The tool descriptions stay, because
  they are how the model learns the tools exist, and they are far cheaper.

The overlap with the tool descriptions was also trimmed: the repeated "prefer
primary sources", "read the page" and "do not fetch a URL you did not get from
a search" lines are gone. The decision procedure and the two rules that the tool
descriptions do not state (cite the URL from `research_sources`; report
disagreement and missing evidence) remain.

Measured with all four backends configured:

| | Characters | Tokens (chars/4) |
| --- | --- | --- |
| Before | 2,222 | 556 |
| After | 1,432 | 358 |
| Saving | 790 (36%) | 198 |

Of the new block, the decision procedure is 1,259 characters and the rules are
172. With only Jina configured the block is 805 characters (was 900).

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
- End with the source list from research_sources: the URLs you actually read, ...
---
```

The contract survives compaction: the question is prepended to the summary so
a long research session does not lose its subject.

`/research stats` prints the counters described above instead of starting a
task.

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
├── index.ts        # plugin: tools, command, session hooks, cache/ledger/stats wiring
├── providers.ts    # the four backend clients, retry, response normalizers, merge
├── routing.ts      # routing block and output formatting
├── state.ts        # cache keys, ledger and counter shapes (pure, testable)
└── index.test.ts   # unit tests for the pure helpers
```

Server half only. There is no TUI half and no RPC contract: the plugin has
nothing to render and nothing to share between processes.

## Install

```sh
cp -r plugins/research ~/.config/opencode/plugins/research
```

Then restart the OpenCode service (`opencode service restart`).
