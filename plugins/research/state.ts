/**
 * Durable research state: the read cache, the per-session source ledger and
 * the per-session counters.
 *
 * Everything here is pure so it can be covered by bun:test without a plugin
 * host. The plugin owns when a value is written; this module owns its shape,
 * its key and the arithmetic that keeps it bounded.
 */

import type { Backend } from "./providers.js"

// ----------------------------------------------------------------- cache ----

export const CACHE_STORAGE_PREFIX = "research/cache/"
export const DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const DEFAULT_CACHE_MAX_ENTRIES = 200

export interface CacheKeyOptions {
	readonly format?: string
	readonly targetSelector?: string
	readonly removeSelector?: string
	readonly withLinksSummary?: boolean
	readonly onlyMainContent?: boolean
}

export interface CachedPage {
	readonly url: string
	readonly title: string
	readonly content: string
	readonly metadata?: Record<string, unknown>
	readonly backend: Backend
	readonly fetchedAt: number
}

/** 64-bit FNV-1a, hex encoded. Stable across processes, unlike node hashes. */
export function fnv1a64(input: string): string {
	let hash = 0xcbf29ce484222325n
	const prime = 0x100000001b3n
	const mask = 0xffffffffffffffffn
	for (let index = 0; index < input.length; index += 1) {
		hash ^= BigInt(input.charCodeAt(index))
		hash = (hash * prime) & mask
	}
	return hash.toString(16).padStart(16, "0")
}

/**
 * One entry per (backend, url, output-shaping options). Two reads that differ
 * only in a selector must not share an entry.
 */
export function cacheEntryKey(backend: Backend, url: string, options: CacheKeyOptions = {}): string {
	const material = JSON.stringify([
		backend,
		url,
		options.format ?? "markdown",
		options.targetSelector ?? "",
		options.removeSelector ?? "",
		options.withLinksSummary === true,
		options.onlyMainContent !== false,
	])
	return `${CACHE_STORAGE_PREFIX}${fnv1a64(material)}`
}

export function isCachedPage(value: unknown): value is CachedPage {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const entry = value as Record<string, unknown>
	return (
		typeof entry.url === "string" &&
		typeof entry.title === "string" &&
		typeof entry.content === "string" &&
		typeof entry.backend === "string" &&
		typeof entry.fetchedAt === "number"
	)
}

export function isCacheFresh(fetchedAt: number, ttlMs: number, now = Date.now()): boolean {
	if (!Number.isFinite(fetchedAt) || !Number.isFinite(ttlMs) || ttlMs <= 0) return false
	return now - fetchedAt < ttlMs
}

// ---------------------------------------------------------------- ledger ----

export const SOURCE_STORAGE_PREFIX = "research/sources/"
export const DEFAULT_LEDGER_MAX_ENTRIES = 200
/** Enough to recognise the source without re-reading the page. */
export const LEDGER_EXCERPT_CHARS = 160

export interface SourceEntry {
	readonly url: string
	readonly title: string
	readonly backend: Backend
	readonly readAt: number
	readonly excerpt: string
}

export interface SessionLedger {
	readonly sessionID: string
	readonly entries: readonly SourceEntry[]
	/** How many entries fell off the front because of the cap. */
	readonly dropped: number
}

export function sourceStorageKey(sessionID: string): string {
	return `${SOURCE_STORAGE_PREFIX}${sessionID}`
}

export function emptyLedger(sessionID: string): SessionLedger {
	return { sessionID, entries: [], dropped: 0 }
}

export function isSessionLedger(value: unknown): value is SessionLedger {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const ledger = value as Record<string, unknown>
	if (typeof ledger.sessionID !== "string" || !Array.isArray(ledger.entries) || typeof ledger.dropped !== "number") {
		return false
	}
	return ledger.entries.every((entry) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
		const item = entry as Record<string, unknown>
		return (
			typeof item.url === "string" &&
			typeof item.title === "string" &&
			typeof item.backend === "string" &&
			typeof item.readAt === "number" &&
			typeof item.excerpt === "string"
		)
	})
}

/**
 * Append one source, dropping the oldest when the cap is reached. The same URL
 * read twice updates its entry instead of growing the ledger.
 */
export function appendSource(
	ledger: SessionLedger,
	entry: SourceEntry,
	maxEntries = DEFAULT_LEDGER_MAX_ENTRIES,
): SessionLedger {
	const cap = Math.max(1, Math.floor(maxEntries))
	const withoutDuplicate = ledger.entries.filter((existing) => existing.url !== entry.url)
	const entries = [...withoutDuplicate, entry]
	const overflow = Math.max(0, entries.length - cap)
	return {
		sessionID: ledger.sessionID,
		entries: overflow ? entries.slice(overflow) : entries,
		dropped: ledger.dropped + overflow,
	}
}

// ----------------------------------------------------------------- stats ----

export const STATS_STORAGE_PREFIX = "research/stats/"
export const LIFETIME_STATS_ID = "lifetime"

export const BACKENDS: readonly Backend[] = ["tavily", "exa", "firecrawl", "jina"]

export interface BackendStats {
	calls: number
	failures: number
	/** Calls where this backend answered after a different one failed. */
	fallbacks: number
	results: number
}

export type BackendCounters = Record<Backend, BackendStats>

export interface ResearchStats {
	readonly sessionID: string
	backends: BackendCounters
	pagesRead: number
	pagesCrawled: number
	urlsExtracted: number
	charsReturned: number
	cacheHits: number
	updatedAt: number
}

export function statsStorageKey(sessionID: string): string {
	return `${STATS_STORAGE_PREFIX}${sessionID}`
}

export function emptyStats(sessionID: string, now = Date.now()): ResearchStats {
	const backends = {} as BackendCounters
	for (const backend of BACKENDS) {
		backends[backend] = { calls: 0, failures: 0, fallbacks: 0, results: 0 }
	}
	return {
		sessionID,
		backends,
		pagesRead: 0,
		pagesCrawled: 0,
		urlsExtracted: 0,
		charsReturned: 0,
		cacheHits: 0,
		updatedAt: now,
	}
}

export function isResearchStats(value: unknown): value is ResearchStats {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false
	const stats = value as Record<string, unknown>
	if (typeof stats.sessionID !== "string") return false
	for (const field of ["pagesRead", "pagesCrawled", "urlsExtracted", "charsReturned", "cacheHits", "updatedAt"]) {
		if (typeof stats[field] !== "number") return false
	}
	const backends = stats.backends
	if (!backends || typeof backends !== "object" || Array.isArray(backends)) return false
	return BACKENDS.every((backend) => {
		const entry = (backends as Record<string, unknown>)[backend]
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false
		const counters = entry as Record<string, unknown>
		return ["calls", "failures", "fallbacks", "results"].every((field) => typeof counters[field] === "number")
	})
}

/** Total calls and failures, for the lifetime line in the stats view. */
export function statsTotals(stats: ResearchStats): { calls: number; failures: number; results: number } {
	let calls = 0
	let failures = 0
	let results = 0
	for (const backend of BACKENDS) {
		const entry = stats.backends[backend]
		calls += entry.calls
		failures += entry.failures
		results += entry.results
	}
	return { calls, failures, results }
}
