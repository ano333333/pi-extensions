import { describe, expect, it } from "vitest";

import { applyExecutionResult, createInitialRunState } from "./runtime.js";
import type { WorkflowDefinition, WorkflowRunState, WorkflowStateDefinition } from "./types.js";

const workflow: WorkflowDefinition = {
	id: "wf",
	initialStateId: "build",
	states: {
		build: {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [],
		},
		test: {
			id: "test",
			action: { kind: "function", handler: "noop" },
			transitions: [],
		},
	},
};

const buildState = workflow.states.build as WorkflowStateDefinition;

describe("runtime", () => {
	it("creates initial run state at initialStateId", () => {
		const run = createInitialRunState(workflow, 10);
		expect(run.currentStateId).toBe("build");
		expect(run.history).toEqual([{ stateId: "build", startedAt: 10 }]);
	});

	it("advances to next state and records history on transition", () => {
		const run: WorkflowRunState = createInitialRunState(workflow, 10);
		const result = applyExecutionResult(
			run,
			buildState,
			{ outcome: "success", raw: { kind: "command", exitCode: 0 } },
			{ kind: "transition", transition: { id: "t1", to: "test", trigger: "success" }, nextStateId: "test" },
			20,
		);

		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.nextStateId).toBe("test");
			expect(result.run.history).toEqual([
				{ stateId: "build", startedAt: 10, finishedAt: 20, result: "success", transitionId: "t1" },
				{ stateId: "test", startedAt: 20 },
			]);
		}
	});

	it("enters waitingManual when manual resolution is returned", () => {
		const run = createInitialRunState(workflow, 10);
		const result = applyExecutionResult(
			run,
			buildState,
			{ outcome: "success", raw: { kind: "command", exitCode: 0 } },
			{ kind: "manual", candidates: [{ id: "m1", to: "review", trigger: "manual" }] },
			20,
		);

		expect(result.kind).toBe("waitingManual");
		if (result.kind === "waitingManual") {
			expect(result.run.status).toBe("waitingManual");
			expect(result.run.currentStateId).toBe("build");
		}
	});

	it("completes workflow when no transition remains", () => {
		const run = createInitialRunState(workflow, 10);
		const result = applyExecutionResult(
			run,
			buildState,
			{ outcome: "success", raw: { kind: "command", exitCode: 0 } },
			{ kind: "complete" },
			20,
		);

		expect(result.kind).toBe("completed");
		if (result.kind === "completed") {
			expect(result.run.status).toBe("completed");
			expect(result.run.currentStateId).toBeNull();
		}
	});
});
