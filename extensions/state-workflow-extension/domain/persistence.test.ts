import { describe, expect, it } from "vitest";

import { createWorkflowRunSnapshot, restoreWorkflowRunSnapshot } from "./persistence.js";
import type { WorkflowRunState } from "./types.js";

describe("workflow run persistence", () => {
	it("creates a snapshot with versioned metadata", () => {
		const run: WorkflowRunState = {
			workflowId: "wf",
			currentStateId: "build",
			status: "idle",
			history: [{ stateId: "build", startedAt: 10 }],
			context: { x: 1 },
		};

		expect(createWorkflowRunSnapshot(run)).toEqual({
			version: 1,
			run,
		});
	});

	it("restores a snapshot payload into run state", () => {
		const snapshot = {
			version: 1 as const,
			run: {
				workflowId: "wf",
				currentStateId: null,
				status: "completed" as const,
				history: [{ stateId: "build", startedAt: 10, finishedAt: 20, result: "success" as const }],
				context: {},
			},
		};

		expect(restoreWorkflowRunSnapshot(snapshot)).toEqual(snapshot.run);
	});
});
