import { describe, expect, test } from "bun:test"
import { internals } from "./index.js"

describe("goal storage helpers", () => {
	test("goalStorageKey prefixes session IDs", () => {
		expect(internals.goalStorageKey("abc")).toBe("goal/abc")
		expect(internals.GOAL_STORAGE_PREFIX).toBe("goal/")
	})

	test("isGoalState accepts persisted shapes and rejects junk", () => {
		expect(
			internals.isGoalState({
				sessionID: "s",
				objective: "o",
				maxRounds: 8,
				round: 0,
				status: "active",
				createdAt: 1,
			}),
		).toBe(true)
		expect(internals.isGoalState({ sessionID: "s" })).toBe(false)
		expect(internals.isGoalState(undefined)).toBe(false)
		expect(
			internals.isGoalState({
				sessionID: "s",
				objective: "o",
				maxRounds: 8,
				round: 0,
				status: "bogus",
				createdAt: 1,
			}),
		).toBe(false)
	})
})

describe("goal system contract", () => {
	test("goalSystemText carries objective, round, and check", () => {
		const text = internals.goalSystemText({
			sessionID: "s",
			objective: "make tests pass",
			checkCmd: "npm test",
			maxRounds: 5,
			round: 2,
			status: "active",
			createdAt: 1,
		})
		expect(text).toContain("make tests pass")
		expect(text).toContain("npm test")
		expect(text).toContain("2")
		expect(text).toContain("goal_complete")
	})

	test("goalStartText is short and names the objective", () => {
		const text = internals.goalStartText({
			sessionID: "s",
			objective: "make tests pass",
			maxRounds: 5,
			round: 0,
			status: "active",
			createdAt: 1,
		})
		expect(text).toContain("make tests pass")
		expect(text.length).toBeLessThan(500)
	})

	test("isWatchdogText detects watchdog injections", () => {
		expect(internals.isWatchdogText("[goal] continue")).toBe(true)
		expect(internals.isWatchdogText("Goal mode started")).toBe(false)
	})
})
describe("goal session rules", () => {
	test("buildGoalSessionRules denies shells and confines external dirs", () => {
		const rules = internals.buildGoalSessionRules()
		expect(rules.length).toBe(internals.GOAL_DENY_SHELL.length + 1 + internals.GOAL_ALLOW_EXTERNAL.length)
		// deny * comes before the allows so last-match-wins permits the exceptions
		const extRules = rules.filter((r) => r.action === "external_directory")
		expect(extRules[0]).toEqual({ action: "external_directory", resource: "*", effect: "deny" })
		expect(extRules.slice(1).every((r) => r.effect === "allow")).toBe(true)
		expect(rules.filter((r) => r.action === "shell").every((r) => r.effect === "deny")).toBe(true)
	})
})

describe("goal argument parsing", () => {
	test("parses check and max flags", () => {
		const parsed = internals.parseGoalArguments('make tests pass --check "npm test" --max 5')
		expect(parsed.objective).toBe("make tests pass")
		expect(parsed.checkCmd).toBe("npm test")
		expect(parsed.maxRounds).toBe(5)
	})

	test("parseVerdict falls back on garbage", () => {
		const v = internals.parseVerdict("not json")
		expect(v.complete).toBe(false)
		expect(v.next_action.length).toBeGreaterThan(0)
	})
})
