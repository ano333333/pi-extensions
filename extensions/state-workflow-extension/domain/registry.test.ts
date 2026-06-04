import { describe, expect, it } from "vitest";

import { createWorkflowRegistry } from "./registry.js";
import type { WorkflowDefinition } from "./types.js";

const validWorkflow: WorkflowDefinition = {
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

describe("createWorkflowRegistry", () => {
	it("registers and retrieves a workflow", () => {
		const registry = createWorkflowRegistry();
		const result = registry.register(validWorkflow);

		expect(result.ok).toBe(true);
		expect(registry.get("wf")).toEqual(validWorkflow);
		expect(registry.list()).toEqual([validWorkflow]);
	});

	it("rejects invalid workflows and does not register them", () => {
		const registry = createWorkflowRegistry();
		const invalidWorkflow: WorkflowDefinition = {
			id: "broken",
			initialStateId: "missing",
			states: {},
		};

		const result = registry.register(invalidWorkflow);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.issues[0]?.code).toBe("UNKNOWN_INITIAL_STATE");
		}
		expect(registry.get("broken")).toBeUndefined();
	});

	it("replaces existing workflow with same id when valid", () => {
		const registry = createWorkflowRegistry();
		registry.register(validWorkflow);

		const replacement: WorkflowDefinition = {
			...validWorkflow,
			title: "replacement",
		};

		const result = registry.register(replacement);
		expect(result.ok).toBe(true);
		expect(registry.get("wf")).toEqual(replacement);
	});

	it("can unregister workflows", () => {
		const registry = createWorkflowRegistry();
		registry.register(validWorkflow);

		expect(registry.unregister("wf")).toBe(true);
		expect(registry.get("wf")).toBeUndefined();
		expect(registry.unregister("wf")).toBe(false);
	});
});
