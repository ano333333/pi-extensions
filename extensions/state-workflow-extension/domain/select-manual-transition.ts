import type {
	SelectableTransitionTrigger,
	WorkflowDefinition,
	WorkflowRunState,
	WorkflowTransition,
} from "./types.js";

export type SelectManualTransitionInput = {
	definition: WorkflowDefinition;
	run: WorkflowRunState;
	transitionId: string;
	now: number;
	allowedTriggers?: SelectableTransitionTrigger[];
};

const findSelectableTransition = (
	transitions: WorkflowTransition[],
	transitionId: string,
	allowedTriggers: SelectableTransitionTrigger[],
): WorkflowTransition | undefined =>
	transitions.find(
		(transition) => allowedTriggers.includes(transition.trigger as SelectableTransitionTrigger) && transition.id === transitionId,
	);

export const selectManualTransition = ({
	definition,
	run,
	transitionId,
	now,
	allowedTriggers = ["manual", "manualOrAgent"],
}: SelectManualTransitionInput): WorkflowRunState => {
	if (run.status !== "waitingManual") {
		throw new Error("Workflow is not waiting for a manual transition");
	}
	if (!run.currentStateId) {
		throw new Error("Workflow has no current state for manual transition");
	}

	const state = definition.states[run.currentStateId];
	if (!state) {
		throw new Error(`Current state "${run.currentStateId}" is missing from workflow definition`);
	}

	const transition = findSelectableTransition(state.transitions, transitionId, allowedTriggers);
	if (!transition) {
		throw new Error(`Manual transition "${transitionId}" is not available in state "${state.id}"`);
	}

	const last = run.history.at(-1);
	if (!last) {
		throw new Error("Workflow history is empty");
	}

	return {
		...run,
		currentStateId: transition.to,
		status: "idle",
		history: [
			...run.history.slice(0, -1),
			{
				...last,
				transitionId: transition.id,
			},
			{
				stateId: transition.to,
				startedAt: now,
			},
		],
	};
};
