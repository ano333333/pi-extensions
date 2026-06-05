import { describe, expect, it } from "vitest";

import { listSelectableTransitions, selectManualTransition } from "./select-manual-transition.js";
import { createInitialRunState } from "./runtime.js";
import type { WorkflowDefinition } from "./types.js";

const workflow: WorkflowDefinition = {
	id: "wf",
	initialStateId: "review",
	states: {
		review: {
			id: "review",
			action: { kind: "function", handler: "noop" },
			transitions: [
				{ id: "approve", to: "deploy", trigger: "manual" },
				{ id: "reject", to: "abort", trigger: "manualOrAgent" },
			],
		},
		deploy: {
			id: "deploy",
			action: { kind: "command", command: "deploy" },
			transitions: [],
		},
		abort: {
			id: "abort",
			action: { kind: "function", handler: "noop" },
			transitions: [],
		},
	},
};

describe("selectManualTransition", () => {
	it("lists selectable transitions only while waiting for manual input", () => {
		const idleRun = createInitialRunState(workflow, 10);
		expect(listSelectableTransitions(workflow, idleRun)).toEqual([]);

		const waitingRun = {
			...idleRun,
			status: "waitingManual" as const,
			history: [{ stateId: "review", startedAt: 10, finishedAt: 20, result: "success" as const }],
		};

		expect(listSelectableTransitions(workflow, waitingRun)).toEqual(workflow.states.review.transitions);
		expect(listSelectableTransitions(workflow, waitingRun, ["manualOrAgent"])).toEqual([
			workflow.states.review.transitions[1],
		]);
	});

	it("advances to selected transition target and appends next history entry", () => {
		const run = {
			...createInitialRunState(workflow, 10),
			status: "waitingManual" as const,
			history: [{ stateId: "review", startedAt: 10, finishedAt: 20, result: "success" as const }],
		};

		const result = selectManualTransition({
			definition: workflow,
			run,
			transitionId: "approve",
			now: 30,
		});

		expect(result.currentStateId).toBe("deploy");
		expect(result.status).toBe("idle");
		expect(result.history).toEqual([
			{ stateId: "review", startedAt: 10, finishedAt: 20, result: "success", transitionId: "approve" },
			{ stateId: "deploy", startedAt: 30 },
		]);
	});

	it("throws when run is not waiting for manual selection", () => {
		const run = createInitialRunState(workflow, 10);
		expect(() =>
			selectManualTransition({
				definition: workflow,
				run,
				transitionId: "approve",
				now: 30,
			}),
		).toThrow("Workflow is not waiting for a manual transition");
	});

	it("throws for unknown transition id", () => {
		const run = {
			...createInitialRunState(workflow, 10),
			status: "waitingManual" as const,
			history: [{ stateId: "review", startedAt: 10, finishedAt: 20, result: "success" as const }],
		};

		expect(() =>
			selectManualTransition({
				definition: workflow,
				run,
				transitionId: "missing",
				now: 30,
			}),
		).toThrow('Manual transition "missing" is not available in state "review"');
	});

	it("can restrict allowed triggers to agent-selectable transitions", () => {
		const run = {
			...createInitialRunState(workflow, 10),
			status: "waitingManual" as const,
			history: [{ stateId: "review", startedAt: 10, finishedAt: 20, result: "success" as const }],
		};

		expect(() =>
			selectManualTransition({
				definition: workflow,
				run,
				transitionId: "approve",
				now: 30,
				allowedTriggers: ["manualOrAgent"],
			}),
		).toThrow('Manual transition "approve" is not available in state "review"');

		const result = selectManualTransition({
			definition: workflow,
			run,
			transitionId: "reject",
			now: 30,
			allowedTriggers: ["manualOrAgent"],
		});

		expect(result.currentStateId).toBe("abort");
	});
});
