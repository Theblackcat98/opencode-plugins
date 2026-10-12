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
