/**
 * RPC contract between the workflow server plugin and its TUI half.
 *
 * The server owns run state and announces transitions; the TUI renders them.
 * Event subscriptions are live-only, so `listRuns` / `getRun` are the recovery
 * path for a terminal that attached after the run started.
 *
 * Verified against @opencode/plugin 2.0.26: `Rpc.define` needs both `methods`
 * and `events`, and every event's data must be an object.
 */

import { Rpc } from "@opencode/plugin/rpc"

const FieldShape = {
	type: "object",
	properties: {
		field: { type: "string" },
		label: { type: "string" },
		unit: { type: "string" },
	},
	required: ["field"],
	additionalProperties: false,
} as const

const RunErrorShape = {
	type: "object",
	properties: {
		message: { type: "string" },
		stack: { type: "string" },
		kind: { type: "string" },
	},
	required: ["message"],
	additionalProperties: false,
} as const

const RunSummaryShape = {
	type: "object",
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		status: { type: "string", description: "queued | running | completed | errored | stopped" },
		sessionID: { type: "string" },
		directory: { type: "string" },
		createdAt: { type: "number" },
		updatedAt: { type: "number" },
		endedAt: { type: "number" },
		phaseCount: { type: "integer" },
		phasesDone: { type: "integer" },
		agentCount: { type: "integer" },
		artifactCount: { type: "integer" },
		error: RunErrorShape,
		resumedFrom: { type: "string" },
	},
	required: [
		"id",
		"name",
		"status",
		"sessionID",
		"directory",
		"createdAt",
		"updatedAt",
		"phaseCount",
		"phasesDone",
		"agentCount",
		"artifactCount",
	],
	additionalProperties: false,
} as const

export const WorkflowRpc = Rpc.define({
	id: "workflow",
	methods: {
		/** Recovery path: every tracked run, oldest first. */
		listRuns: {
			input: {
				type: "object",
				properties: {
					sessionID: { type: "string", description: "Only runs started from this session" },
				},
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: {
					entries: { type: "array", items: RunSummaryShape },
				},
				required: ["entries"],
				additionalProperties: false,
			},
		},
		/** Full snapshot for the run panel. */
		getRun: {
			input: {
				type: "object",
				properties: { runID: { type: "string" } },
				required: ["runID"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: {
					run: { type: "object", additionalProperties: true },
				},
				required: ["run"],
				additionalProperties: false,
			},
			errors: {
				not_found: {
					type: "object",
					properties: { runID: { type: "string" } },
					required: ["runID"],
					additionalProperties: false,
				},
			},
		},
		/** Stop a running workflow. */
		stopRun: {
			input: {
				type: "object",
				properties: { runID: { type: "string" } },
				required: ["runID"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: { stopped: { type: "boolean" } },
				required: ["stopped"],
				additionalProperties: false,
			},
			errors: {
				not_found: {
					type: "object",
					properties: { runID: { type: "string" } },
					required: ["runID"],
					additionalProperties: false,
				},
			},
		},
	},
	events: {
		/** Any phase, agent, artifact or status change. Summary only. */
		updated: { schema: RunSummaryShape },
		/** Terminal state: completed, errored or stopped. */
		finished: { schema: RunSummaryShape },
	},
})
