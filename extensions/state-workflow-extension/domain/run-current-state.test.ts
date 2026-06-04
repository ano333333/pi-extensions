import { describe, expect, it } from "vitest";

import { createFakeExecutor } from "./executor.js";
import { runCurrentState } from "./run-current-state.js";
import { createInitialRunState } from "./runtime.js";
import type { WorkflowDefinition } from "./types.js";

const createWorkflow = (transitions: WorkflowDefinition["states"]["build"]["transitions"]): WorkflowDefinition => ({
	id: "wf",
	initialStateId: "build",
	states: {
		build: {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions,
		},
		test: {
			id: "test",
			action: { kind: "function", handler: "noop" },
			transitions: [],
		},
		retry: {
			id: "retry",
			action: { kind: "function", handler: "noop" },
			transitions: [],
		},
		cleanup: {
			id: "cleanup",
			action: { kind: "function", handler: "noop" },
			transitions: [],
		},
		review: {
			id: "review",
			action: { kind: "function", handler: "noop" },
			transitions: [],
		},
	},
});

describe("runCurrentState", () => {
	it("takes success branch for command exitCode 0", async () => {
		const definition = createWorkflow([
			{ id: "t-success", to: "test", trigger: "success" },
			{ id: "t-error", to: "retry", trigger: "error" },
		]);
		const run = createInitialRunState(definition, 10);
		const executor = createFakeExecutor({
			build: { kind: "command", exitCode: 0, stdout: "ok" },
		});

		const result = await runCurrentState({ definition, run, executor, now: 20 });
		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.transitionId).toBe("t-success");
			expect(result.nextStateId).toBe("test");
			expect(result.run.lastResult?.outcome).toBe("success");
		}
	});

	it("takes error branch for command non-zero exitCode", async () => {
		const definition = createWorkflow([
			{ id: "t-success", to: "test", trigger: "success" },
			{ id: "t-error", to: "retry", trigger: "error" },
		]);
		const run = createInitialRunState(definition, 10);
		const executor = createFakeExecutor({
			build: { kind: "command", exitCode: 2, stderr: "failed" },
		});

		const result = await runCurrentState({ definition, run, executor, now: 20 });
		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.transitionId).toBe("t-error");
			expect(result.nextStateId).toBe("retry");
			expect(result.run.lastResult?.outcome).toBe("error");
		}
	});

	it("falls back to always transition when no direct branch exists", async () => {
		const definition = createWorkflow([{ id: "t-always", to: "cleanup", trigger: "always" }]);
		const run = createInitialRunState(definition, 10);
		const executor = createFakeExecutor({
			build: { kind: "command", exitCode: 1, stderr: "failed" },
		});

		const result = await runCurrentState({ definition, run, executor, now: 20 });
		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.transitionId).toBe("t-always");
			expect(result.nextStateId).toBe("cleanup");
		}
	});

	it("waits for manual selection when only manual transitions exist", async () => {
		const definition = createWorkflow([{ id: "t-manual", to: "review", trigger: "manual" }]);
		const run = createInitialRunState(definition, 10);
		const executor = createFakeExecutor({
			build: { kind: "command", exitCode: 0, stdout: "ok" },
		});

		const result = await runCurrentState({ definition, run, executor, now: 20 });
		expect(result.kind).toBe("waitingManual");
		if (result.kind === "waitingManual") {
			expect(result.candidates.map((candidate) => candidate.id)).toEqual(["t-manual"]);
			expect(result.run.status).toBe("waitingManual");
		}
	});
});
