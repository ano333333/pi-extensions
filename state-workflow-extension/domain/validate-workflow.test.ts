import { describe, expect, it } from "vitest";

import { validateWorkflow } from "./validate-workflow.js";
import type { WorkflowDefinition } from "./types.js";

describe("validateWorkflow", () => {
	it("returns no issues for a valid workflow", () => {
		const workflow: WorkflowDefinition = {
			id: "wf",
			initialStateId: "build",
			states: {
				build: {
					id: "build",
					action: { kind: "command", command: "build" },
					transitions: [{ id: "t1", to: "test", trigger: "success" }],
				},
				test: {
					id: "test",
					action: { kind: "function", handler: "noop" },
					transitions: [],
				},
			},
		};

		expect(validateWorkflow(workflow)).toEqual([]);
	});

	it("reports unknown initial state", () => {
		const workflow: WorkflowDefinition = {
			id: "wf",
			initialStateId: "missing",
			states: {
				build: {
					id: "build",
					action: { kind: "command", command: "build" },
					transitions: [],
				},
			},
		};

		expect(validateWorkflow(workflow)).toContainEqual({
			level: "error",
			code: "UNKNOWN_INITIAL_STATE",
			message: 'Initial state "missing" does not exist',
		});
	});

	it("reports transition targets that do not exist", () => {
		const workflow: WorkflowDefinition = {
			id: "wf",
			initialStateId: "build",
			states: {
				build: {
					id: "build",
					action: { kind: "command", command: "build" },
					transitions: [{ id: "t1", to: "missing", trigger: "success" }],
				},
			},
		};

		expect(validateWorkflow(workflow)).toContainEqual({
			level: "error",
			code: "UNKNOWN_TRANSITION_TARGET",
			message: 'Transition "t1" in state "build" points to unknown state "missing"',
		});
	});

	it("reports duplicate transition ids across the workflow", () => {
		const workflow: WorkflowDefinition = {
			id: "wf",
			initialStateId: "build",
			states: {
				build: {
					id: "build",
					action: { kind: "command", command: "build" },
					transitions: [{ id: "dup", to: "test", trigger: "success" }],
				},
				test: {
					id: "test",
					action: { kind: "function", handler: "noop" },
					transitions: [{ id: "dup", to: "build", trigger: "manual" }],
				},
			},
		};

		expect(validateWorkflow(workflow)).toContainEqual({
			level: "error",
			code: "DUPLICATE_TRANSITION_ID",
			message: 'Transition id "dup" is duplicated',
		});
	});

	it("warns about unreachable states", () => {
		const workflow: WorkflowDefinition = {
			id: "wf",
			initialStateId: "build",
			states: {
				build: {
					id: "build",
					action: { kind: "command", command: "build" },
					transitions: [],
				},
				orphan: {
					id: "orphan",
					action: { kind: "function", handler: "noop" },
					transitions: [],
				},
			},
		};

		expect(validateWorkflow(workflow)).toContainEqual({
			level: "warning",
			code: "UNREACHABLE_STATE",
			message: 'State "orphan" is unreachable from initial state "build"',
		});
	});
});
