import type { WorkflowRunSnapshot, WorkflowRunState } from "./types.js";

export const createWorkflowRunSnapshot = (run: WorkflowRunState): WorkflowRunSnapshot => ({
	version: 1,
	run,
});

export const restoreWorkflowRunSnapshot = (snapshot: WorkflowRunSnapshot): WorkflowRunState => snapshot.run;
