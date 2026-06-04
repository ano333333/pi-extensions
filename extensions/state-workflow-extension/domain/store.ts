import type { WorkflowId, WorkflowRunState, WorkflowRunStore } from "./types.js";

export const createInMemoryWorkflowRunStore = (
	initialRuns: WorkflowRunState[] = [],
): WorkflowRunStore => {
	const runs = new Map<WorkflowId, WorkflowRunState>(initialRuns.map((run) => [run.workflowId, run]));

	return {
		load: async (workflowId) => runs.get(workflowId) ?? null,
		save: async (run) => {
			runs.set(run.workflowId, run);
		},
		clear: async (workflowId) => {
			runs.delete(workflowId);
		},
	};
};
