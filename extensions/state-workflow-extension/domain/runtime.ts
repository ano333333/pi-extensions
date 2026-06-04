import type {
	ResolveTransitionResult,
	StateExecutionResult,
	WorkflowAdvanceResult,
	WorkflowDefinition,
	WorkflowRunState,
	WorkflowStateDefinition,
} from "./types.js";

export const createInitialRunState = (
	definition: WorkflowDefinition,
	now: number,
): WorkflowRunState => ({
	workflowId: definition.id,
	currentStateId: definition.initialStateId,
	status: "idle",
	history: [
		{
			stateId: definition.initialStateId,
			startedAt: now,
		},
	],
	context: {},
});

export const getCurrentState = (
	definition: WorkflowDefinition,
	run: WorkflowRunState,
): WorkflowStateDefinition | undefined => {
	if (!run.currentStateId) return undefined;
	return definition.states[run.currentStateId];
};

export const applyExecutionResult = (
	run: WorkflowRunState,
	_state: WorkflowStateDefinition,
	result: StateExecutionResult,
	resolution: ResolveTransitionResult,
	now: number,
): WorkflowAdvanceResult => {
	const history = [...run.history];
	const last = history.at(-1);
	if (!last) {
		throw new Error("Workflow history is empty");
	}

	history[history.length - 1] = {
		...last,
		finishedAt: now,
		result: result.outcome,
	};

	const baseRun: WorkflowRunState = {
		...run,
		history,
		lastResult: result,
	};

	if (resolution.kind === "transition") {
		const finishedEntry = {
			...baseRun.history[baseRun.history.length - 1],
			transitionId: resolution.transition.id,
		};

		const nextRun: WorkflowRunState = {
			...baseRun,
			currentStateId: resolution.nextStateId,
			status: "idle",
			history: [
				...baseRun.history.slice(0, -1),
				finishedEntry,
				{
					stateId: resolution.nextStateId,
					startedAt: now,
				},
			],
		};

		return {
			kind: "advanced",
			run: nextRun,
			nextStateId: resolution.nextStateId,
			transitionId: resolution.transition.id,
		};
	}

	if (resolution.kind === "manual") {
		return {
			kind: "waitingManual",
			run: {
				...baseRun,
				status: "waitingManual",
			},
			candidates: resolution.candidates,
		};
	}

	return {
		kind: "completed",
		run: {
			...baseRun,
			currentStateId: null,
			status: "completed",
		},
	};
};
