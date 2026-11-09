import { describe, expect, test } from "bun:test"
import { renderSnapshot } from "./index.js"
import type { RunSnapshot } from "./types.js"

function snapshot(): RunSnapshot {
	return {
		id: "wfr-render",
		name: "Review",
		status: "running",
		sessionID: "ses-1",
		directory: "/tmp/project",
		createdAt: 1_000,
		updatedAt: 9_000,
		phaseCount: 3,
		phasesDone: 1,
		agentCount: 2,
		artifactCount: 1,
		phases: [
			{ name: "Map the change", status: "done", visits: 1, startedAt: 1_000, endedAt: 4_000, agentCount: 1, askCount: 1 },
			{ name: "Review each file", status: "active", visits: 1, startedAt: 4_000, agentCount: 2, askCount: 3 },
			{ name: "Publish report", status: "pending", visits: 1 },
		],
		edges: [
			{ from: 0, to: 1, kind: "forward", traversals: 1 },
			{ from: 1, to: 2, kind: "forward", traversals: 1 },
		],
		currentPhase: 1,
		agents: [
			{ name: "reviewer", asks: 1, status: "idle", phase: 1 },
			{ name: "confirmer", asks: 2, status: "running", phase: 1 },
		],
		artifacts: [
			{
				kind: "markdown",
				id: "report",
				title: "Review report",
				version: 1,
				primary: true,
				phase: 1,
				content: "# Findings",
			},
		],
		items: [],
		logs: ["Started."],
		args: {},
		maxConcurrency: 4,
		script: "",
	}
}

describe("renderSnapshot", () => {
	test("draws the phase graph instead of a numbered list", () => {
		const output = renderSnapshot(snapshot())
		expect(output).toContain("## Phases")
		expect(output).toContain("╭")
		expect(output).toContain("▶")
		expect(output).toContain("3s")
		expect(output).not.toContain("(from")
	})

	test("keeps the report, agents and artifacts", () => {
		const output = renderSnapshot(snapshot())
		expect(output).toContain("## Subagents")
		expect(output).toContain("confirmer: 2 asks, running")
		expect(output).toContain("Review report (markdown) ★")
		expect(output).toContain("## Result")
	})
})
