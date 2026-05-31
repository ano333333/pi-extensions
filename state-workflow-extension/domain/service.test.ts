import { describe, expect, it } from "vitest";

import { createFakeExecutor } from "./executor.js";
import { createRecordingPresenter } from "./presenter.js";
import { createWorkflowService } from "./service.js";
import { createInMemoryWorkflowRunStore } from "./store.js";
import type { WorkflowDefinition } from "./types.js";

const createWorkflow = (buildTransitions: WorkflowDefinition["states"]["build"]["transitions"]): WorkflowDefinition => ({
	id: "wf",
	initialStateId: "build",
	states: {
		build: {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: buildTransitions,
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
		review: {
			id: "review",
			action: { kind: "function", handler: "noop" },
			transitions: [
				{ id: "review-approve", to: "test", trigger: "manual" },
				{ id: "review-reject", to: "retry", trigger: "manual" },
			],
		},
	},
});

describe("createWorkflowService", () => {
	it("starts a workflow, stores it, and renders it", async () => {
		const workflow = createWorkflow([{ id: "t1", to: "test", trigger: "success" }]);
		const presenter = createRecordingPresenter();
		const service = createWorkflowService({
			store: createInMemoryWorkflowRunStore(),
			executor: createFakeExecutor({ build: { kind: "command", exitCode: 0 } }),
			presenter,
		});

		service.register(workflow);
		const run = await service.start("wf", 10);

		expect(run.currentStateId).toBe("build");
		expect(await service.getRun("wf")).toEqual(run);
		expect(presenter.events).toContainEqual({
			type: "render",
			workflowId: "wf",
			stateId: "build",
			status: "idle",
		});
	});

	it("takes success branch and persists updated run", async () => {
		const workflow = createWorkflow([
			{ id: "t-success", to: "test", trigger: "success" },
			{ id: "t-error", to: "retry", trigger: "error" },
		]);
		const presenter = createRecordingPresenter();
		const service = createWorkflowService({
			store: createInMemoryWorkflowRunStore(),
			executor: createFakeExecutor({ build: { kind: "command", exitCode: 0, stdout: "ok" } }),
			presenter,
		});

		service.register(workflow);
		await service.start("wf", 10);
		const result = await service.runNext("wf", 20);

		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.nextStateId).toBe("test");
		}
		expect((await service.getRun("wf"))?.currentStateId).toBe("test");
	});

	it("takes error branch based on non-zero exit code", async () => {
		const workflow = createWorkflow([
			{ id: "t-success", to: "test", trigger: "success" },
			{ id: "t-error", to: "retry", trigger: "error" },
		]);
		const service = createWorkflowService({
			store: createInMemoryWorkflowRunStore(),
			executor: createFakeExecutor({ build: { kind: "command", exitCode: 2, stderr: "failed" } }),
			presenter: createRecordingPresenter(),
		});

		service.register(workflow);
		await service.start("wf", 10);
		const result = await service.runNext("wf", 20);

		expect(result.kind).toBe("advanced");
		if (result.kind === "advanced") {
			expect(result.nextStateId).toBe("retry");
		}
	});

	it("enters waitingManual and then applies chosen manual transition", async () => {
		const workflow = createWorkflow([
			{ id: "approve", to: "test", trigger: "manual" },
			{ id: "reject", to: "retry", trigger: "manual" },
		]);
		const presenter = createRecordingPresenter();
		const service = createWorkflowService({
			store: createInMemoryWorkflowRunStore(),
			executor: createFakeExecutor({ build: { kind: "command", exitCode: 0 } }),
			presenter,
		});

		service.register(workflow);
		await service.start("wf", 10);
		const waiting = await service.runNext("wf", 20);
		const waitingRun = await service.getRun("wf");
		await service.chooseManual("wf", "approve", 30);
		const after = await service.getRun("wf");

		expect(waiting.kind).toBe("waitingManual");
		expect(waitingRun?.currentStateId).toBe("build");
		expect(waitingRun?.status).toBe("waitingManual");
		expect(after?.currentStateId).toBe("test");
		expect(after?.status).toBe("idle");
		expect(presenter.events.at(-1)).toMatchObject({
			type: "render",
			stateId: "test",
			status: "idle",
		});
	});

	it("clears presenter when workflow completes", async () => {
		const workflow = createWorkflow([]);
		const presenter = createRecordingPresenter();
		const service = createWorkflowService({
			store: createInMemoryWorkflowRunStore(),
			executor: createFakeExecutor({ build: { kind: "command", exitCode: 0 } }),
			presenter,
		});

		service.register(workflow);
		await service.start("wf", 10);
		const result = await service.runNext("wf", 20);

		expect(result.kind).toBe("completed");
		expect(presenter.events).toContainEqual({ type: "clear", workflowId: "wf" });
	});
});
