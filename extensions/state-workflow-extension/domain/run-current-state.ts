import { normalizeExecutionResult } from "./normalize.js";
import { resolveTransition } from "./resolve-transition.js";
import { applyExecutionResult, getCurrentState } from "./runtime.js";
import type {
	ActionExecutor,
	GuardRegistry,
	WorkflowAdvanceResult,
	WorkflowDefinition,
	WorkflowRunState,
} from "./types.js";

export type RunCurrentStateInput = {
	definition: WorkflowDefinition;
	run: WorkflowRunState;
	executor: ActionExecutor;
	guards?: GuardRegistry;
	now: number;
};

export const runCurrentState = async ({
	definition,
	run,
	executor,
	guards = {},
	now,
}: RunCurrentStateInput): Promise<WorkflowAdvanceResult> => {
	const state = getCurrentState(definition, run);
	if (!state) {
		throw new Error("Current state is not available in workflow definition");
	}

	const raw = await executor.execute({
		workflowId: definition.id,
		state,
		run,
	});
	const result = normalizeExecutionResult(raw);
	const resolution = resolveTransition({
		state,
		run,
		result,
		guards,
	});

	return applyExecutionResult(run, state, result, resolution, now);
};
