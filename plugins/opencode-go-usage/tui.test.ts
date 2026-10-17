import { describe, expect, test } from "bun:test"
import type { CredentialEntry } from "@opencode/client"
import {
	detailText,
	filledSegments,
	formatDuration,
	parseConsoleStatus,
	parseZenUsage,
	selectCredential,
	severity,
	summarize,
} from "./tui.js"

/** Live response shape, captured 2026-10-17. */
const zenBody = {
	usage: {
		rolling: { status: "ok", percent: 0, resetsAt: "2026-10-17T22:49:32.000Z" },
		weekly: { status: "ok", percent: 69, resetsAt: "2026-10-19T00:00:00.000Z" },
		monthly: { status: "ok", percent: 34, resetsAt: "2026-11-15T01:44:54.000Z" },
	},
}

/** Live response shape, with amounts in micro-cents. */
const consoleBody = {
	subscriberUserId: "user_1",
	product: "go",
	useBalance: false,
	access: {
		endsAt: "2026-11-15T01:44:54.000Z",
		meters: {
			fiveHour: { startsAt: "2026-10-17T17:49:32.000Z", resetsAt: "2026-10-17T22:49:32.000Z", limitMicroCents: "1200000000", usedMicroCents: "8423054" },
			week: { startsAt: "2026-10-12T00:00:00.000Z", resetsAt: "2026-10-19T00:00:00.000Z", limitMicroCents: "3000000000", usedMicroCents: "2089880000" },
			month: { startsAt: "2026-10-15T01:44:54.000Z", resetsAt: "2026-11-15T01:44:54.000Z", limitMicroCents: "6000000000", usedMicroCents: "2089880000" },
		},
	},
}

function entry(integrationID: string, value: CredentialEntry["value"], active = true): CredentialEntry {
	return { id: `cred_${integrationID}`, integrationID, label: "test", active, value }
}

const keyValue: CredentialEntry["value"] = { type: "key", key: "sk-test" }
const oauthValue: CredentialEntry["value"] = {
	type: "oauth",
	methodID: "device",
	refresh: "rt",
	access: "st-access",
	expires: 1_794_621_152_933,
	metadata: { orgID: "org_1", server: "https://opencode.ai/console" },
}

describe("filledSegments", () => {
	test("maps used percent onto bar segments", () => {
		expect(filledSegments(0)).toBe(0)
		expect(filledSegments(50)).toBe(10)
		expect(filledSegments(70)).toBe(14)
		expect(filledSegments(100)).toBe(20)
	})

	test("clamps out-of-range input and honours an explicit resolution", () => {
		expect(filledSegments(-10)).toBe(0)
		expect(filledSegments(150)).toBe(20)
		expect(filledSegments(70, 10)).toBe(7)
	})
})

describe("severity", () => {
	test("bands usage so the card can colour it", () => {
		expect(severity(0)).toBe("ok")
		expect(severity(59.9)).toBe("ok")
		expect(severity(60)).toBe("warn")
		expect(severity(84.9)).toBe("warn")
		expect(severity(85)).toBe("critical")
		expect(severity(100)).toBe("critical")
	})
})

describe("formatDuration", () => {
	test("renders minutes, hours, and days", () => {
		expect(formatDuration(0)).toBe("0m")
		expect(formatDuration(90_000)).toBe("2m")
		expect(formatDuration(60 * 60_000)).toBe("1h 0m")
		expect(formatDuration(26 * 60 * 60_000)).toBe("1d 2h")
		expect(formatDuration(-5_000)).toBe("0m")
	})
})

describe("parseZenUsage", () => {
	test("reads the three windows and their reset times", () => {
		const windows = parseZenUsage(zenBody)
		expect(windows.map((window) => [window.key, window.usedPercent])).toEqual([
			["rolling", 0],
			["weekly", 69],
			["monthly", 34],
		])
		expect(windows[1]?.label).toBe("1w")
		expect(windows[1]?.resetsAt).toBe(Date.parse("2026-10-19T00:00:00.000Z"))
		expect(windows[0]?.usedDollars).toBeUndefined()
	})

	test("ignores junk and windows without a percent", () => {
		expect(parseZenUsage(undefined)).toEqual([])
		expect(parseZenUsage({})).toEqual([])
		expect(parseZenUsage({ usage: { weekly: { status: "ok" } } })).toEqual([])
		const partial = parseZenUsage({ usage: { weekly: { percent: "12.5", resetsAt: "nonsense" } } })
		expect(partial[0]?.usedPercent).toBe(12.5)
		expect(partial[0]?.resetsAt).toBeUndefined()
	})
})

describe("parseConsoleStatus", () => {
	test("converts micro-cents into dollars and percent used", () => {
		const parsed = parseConsoleStatus(consoleBody)
		expect(parsed.plan).toBe("go")
		expect(parsed.renewsAt).toBe(Date.parse("2026-11-15T01:44:54.000Z"))
		expect(parsed.windows.map((window) => window.key)).toEqual(["rolling", "weekly", "monthly"])
		const weekly = parsed.windows[1]
		expect(weekly?.usedDollars).toBeCloseTo(20.8988, 4)
		expect(weekly?.limitDollars).toBeCloseTo(30, 6)
		expect(weekly?.usedPercent).toBeCloseTo(69.66, 2)
		expect(weekly?.startsAt).toBe(Date.parse("2026-10-12T00:00:00.000Z"))
	})

	test("returns nothing when the meters are absent", () => {
		expect(parseConsoleStatus(undefined).windows).toEqual([])
		expect(parseConsoleStatus({ product: "go" }).windows).toEqual([])
		expect(parseConsoleStatus({ access: { meters: { week: {} } } }).windows).toEqual([])
	})
})

describe("selectCredential", () => {
	test("prefers the configured integrations in order", () => {
		const entries = [entry("zai-coding-plan", keyValue), entry("opencode-go", keyValue), entry("opencode", oauthValue)]
		const picked = selectCredential(entries, ["opencode-go", "opencode"], undefined)
		expect(picked?.token).toBe("sk-test")
		expect(picked?.source).toBe("opencode-go API key")
	})

	test("falls back to the Console connection and its workspace metadata", () => {
		const entries = [entry("opencode", oauthValue)]
		const picked = selectCredential(entries, ["opencode-go", "opencode"], undefined)
		expect(picked?.token).toBe("st-access")
		expect(picked?.source).toBe("opencode session")
		expect(picked?.orgID).toBe("org_1")
		expect(picked?.consoleBase).toBe("https://opencode.ai/console")
	})

	test("prefers an API key over OAuth within one integration", () => {
		const entries = [entry("opencode-go", oauthValue), entry("opencode-go", keyValue)]
		expect(selectCredential(entries, ["opencode-go"], undefined)?.source).toBe("opencode-go API key")
	})

	test("skips inactive entries and reports nothing when unmatched", () => {
		expect(selectCredential([entry("opencode-go", keyValue, false)], ["opencode-go"], undefined)).toBeUndefined()
		expect(selectCredential([entry("google", keyValue)], ["opencode-go", "opencode"], undefined)).toBeUndefined()
	})

	test("lets an explicit workspace id win over credential metadata", () => {
		const picked = selectCredential([entry("opencode", oauthValue)], ["opencode"], "org_override")
		expect(picked?.orgID).toBe("org_override")
	})
})

describe("detailText", () => {
	const state = {
		phase: "ready" as const,
		endpoint: "console",
		credential: "opencode session",
		windows: parseConsoleStatus(consoleBody).windows,
		plan: "go",
		renewsAt: Date.parse("2026-11-15T01:44:54.000Z"),
		detail: "",
		updatedAt: Date.parse("2026-10-17T21:00:00.000Z"),
	}

	test("shows percents, dollars, resets, and the source that answered", () => {
		const text = detailText(state, Date.parse("2026-10-17T21:00:00.000Z"))
		expect(text).toContain("weekly: 70% used (30% left) — $20.90 of $30.00")
		expect(text).toContain("resets in 1d 3h")
		expect(text).toContain("plan: go")
		expect(text).toContain("endpoint: console")
		expect(text).toContain("credential: opencode session")
	})

	test("explains how to connect when no credential was found", () => {
		const text = detailText({ ...state, phase: "unconfigured", windows: [], plan: "", endpoint: "", credential: "" })
		expect(text).toContain("/connect")
		expect(text).toContain("OPENCODE_GO_API_KEY")
	})

	test("surfaces the failure when nothing was ever fetched", () => {
		expect(detailText({ ...state, phase: "error", windows: [], detail: "HTTP 500" })).toBe("HTTP 500")
	})

	test("keeps a stale reading and names the failure", () => {
		const text = detailText({ ...state, phase: "error", detail: "HTTP 500" })
		expect(text).toContain("last poll failed: HTTP 500")
		expect(text).toContain("weekly")
	})
})

describe("summarize", () => {
	test("renders one line for toasts", () => {
		expect(summarize(parseZenUsage(zenBody))).toBe("5h 0% used · 1w 69% used · 1m 34% used")
		expect(summarize([])).toBe("no quota windows reported")
	})
})
