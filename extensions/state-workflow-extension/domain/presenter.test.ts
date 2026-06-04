import { describe, expect, it } from "vitest";

import { createNullPresenter, createRecordingPresenter } from "./presenter.js";
import type { WorkflowDefinition, WorkflowRunState } from "./types.js";

const run: WorkflowRunState = {
	workflowId: "wf",
	currentStateId: "build",
	status: "idle",
	history: [{ stateId: "build", startedAt: 10 }],
	context: {},
};

const workflow: WorkflowDefinition = {
	id: "wf",
	initialStateId: "build",
	states: {
		build: {
			id: "build",
			action: { kind: "command", command: "build" },
			transitions: [],
		},
	},
};

describe("presenter helpers", () => {
	it("null presenter is a no-op", async () => {
		const presenter = createNullPresenter();
		await expect(presenter.render(run, workflow)).resolves.toBeUndefined();
		await expect(presenter.clear("wf")).resolves.toBeUndefined();
		await expect(presenter.chooseTransition(run, [])).resolves.toBeNull();
	});

	it("recording presenter logs interactions", async () => {
		const presenter = createRecordingPresenter("pick");
		await presenter.render(run, workflow);
		const choice = await presenter.chooseTransition(run, [{ id: "pick", to: "next", trigger: "manual" }]);
		await presenter.clear("wf");

		expect(choice).toBe("pick");
		expect(presenter.events).toEqual([
			{ type: "render", workflowId: "wf", stateId: "build", status: "idle" },
			{ type: "chooseTransition", workflowId: "wf", candidateIds: ["pick"] },
			{ type: "clear", workflowId: "wf" },
		]);
	});
});
