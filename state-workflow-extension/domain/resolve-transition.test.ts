import { describe, expect, it } from "vitest";

import { resolveTransition } from "./resolve-transition.js";
import type { ResolveTransitionInput, WorkflowRunState, WorkflowStateDefinition } from "./types.js";

const run: WorkflowRunState = {
	workflowId: "wf",
	currentStateId: "build",
	status: "idle",
	history: [{ stateId: "build", startedAt: 1 }],
	context: {},
};

const createInput = (
	state: WorkflowStateDefinition,
	outcome: "success" | "error",
): ResolveTransitionInput => ({
	state,
	run,
	result: {
		outcome,
		raw: outcome === "success" ? { kind: "command", exitCode: 0 } : { kind: "command", exitCode: 1 },
	},
	guards: {},
});

describe("resolveTransition", () => {
	it("prefers success transition for success results", () => {
		const state: WorkflowStateDefinition = {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [
				{ id: "err", to: "retry", trigger: "error" },
				{ id: "ok", to: "test", trigger: "success" },
			],
		};

		const result = resolveTransition(createInput(state, "success"));
		expect(result).toMatchObject({ kind: "transition", nextStateId: "test" });
	});

	it("prefers error transition for error results", () => {
		const state: WorkflowStateDefinition = {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [
				{ id: "err", to: "retry", trigger: "error" },
				{ id: "ok", to: "test", trigger: "success" },
			],
		};

		const result = resolveTransition(createInput(state, "error"));
		expect(result).toMatchObject({ kind: "transition", nextStateId: "retry" });
	});

	it("falls back to always transition when direct trigger is absent", () => {
		const state: WorkflowStateDefinition = {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [{ id: "always", to: "cleanup", trigger: "always" }],
		};

		const result = resolveTransition(createInput(state, "error"));
		expect(result).toMatchObject({ kind: "transition", nextStateId: "cleanup" });
	});

	it("returns manual candidates when no auto transition matches", () => {
		const state: WorkflowStateDefinition = {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [
				{ id: "m1", to: "review", trigger: "manual" },
				{ id: "m2", to: "abort", trigger: "manual" },
			],
		};

		const result = resolveTransition(createInput(state, "success"));
		expect(result.kind).toBe("manual");
		if (result.kind === "manual") {
			expect(result.candidates.map((candidate) => candidate.id)).toEqual(["m1", "m2"]);
		}
	});

	it("skips guarded transitions when guard returns false", () => {
		const state: WorkflowStateDefinition = {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [
				{ id: "guarded", to: "test", trigger: "success", guard: "allow" },
				{ id: "fallback", to: "cleanup", trigger: "always" },
			],
		};

		const result = resolveTransition({
			...createInput(state, "success"),
			guards: {
				allow: () => false,
			},
		});

		expect(result).toMatchObject({ kind: "transition", nextStateId: "cleanup" });
	});

	it("returns complete when no transitions match", () => {
		const state: WorkflowStateDefinition = {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [],
		};

		const result = resolveTransition(createInput(state, "success"));
		expect(result).toEqual({ kind: "complete" });
	});
});
