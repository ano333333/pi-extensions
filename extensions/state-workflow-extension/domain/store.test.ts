import { describe, expect, it } from "vitest";

import { createInMemoryWorkflowRunStore } from "./store.js";
import type { WorkflowRunState } from "./types.js";

const run: WorkflowRunState = {
	workflowId: "wf",
	currentStateId: "build",
	status: "idle",
	history: [{ stateId: "build", startedAt: 10 }],
	context: {},
};

describe("createInMemoryWorkflowRunStore", () => {
	it("loads null for missing workflow", async () => {
		const store = createInMemoryWorkflowRunStore();
		await expect(store.load("missing")).resolves.toBeNull();
	});

	it("saves and loads workflow runs", async () => {
		const store = createInMemoryWorkflowRunStore();
		await store.save(run);
		await expect(store.load("wf")).resolves.toEqual(run);
	});

	it("clears workflow runs", async () => {
		const store = createInMemoryWorkflowRunStore([run]);
		await store.clear("wf");
		await expect(store.load("wf")).resolves.toBeNull();
	});
});
