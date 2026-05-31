import type {
	StateId,
	WorkflowDefinition,
	WorkflowTransition,
	WorkflowValidationIssue,
} from "./types.js";

const collectReachableStateIds = (definition: WorkflowDefinition): Set<StateId> => {
	const reachable = new Set<StateId>();
	const stack: StateId[] = [definition.initialStateId];

	while (stack.length > 0) {
		const stateId = stack.pop();
		if (!stateId || reachable.has(stateId)) continue;
		const state = definition.states[stateId];
		if (!state) continue;

		reachable.add(stateId);
		for (const transition of state.transitions) {
			stack.push(transition.to);
		}
	}

	return reachable;
};

const collectTransitionIds = (definition: WorkflowDefinition): WorkflowTransition["id"][] =>
	Object.values(definition.states).flatMap((state) => state.transitions.map((transition) => transition.id));

export const validateWorkflow = (definition: WorkflowDefinition): WorkflowValidationIssue[] => {
	const issues: WorkflowValidationIssue[] = [];
	const stateIds = new Set(Object.keys(definition.states));

	if (!stateIds.has(definition.initialStateId)) {
		issues.push({
			level: "error",
			code: "UNKNOWN_INITIAL_STATE",
			message: `Initial state "${definition.initialStateId}" does not exist`,
		});
	}

	for (const state of Object.values(definition.states)) {
		for (const transition of state.transitions) {
			if (!stateIds.has(transition.to)) {
				issues.push({
					level: "error",
					code: "UNKNOWN_TRANSITION_TARGET",
					message: `Transition "${transition.id}" in state "${state.id}" points to unknown state "${transition.to}"`,
				});
			}
		}
	}

	const counts = new Map<string, number>();
	for (const transitionId of collectTransitionIds(definition)) {
		counts.set(transitionId, (counts.get(transitionId) ?? 0) + 1);
	}
	for (const [transitionId, count] of counts) {
		if (count > 1) {
			issues.push({
				level: "error",
				code: "DUPLICATE_TRANSITION_ID",
				message: `Transition id "${transitionId}" is duplicated`,
			});
		}
	}

	const reachable = collectReachableStateIds(definition);
	for (const stateId of stateIds) {
		if (!reachable.has(stateId)) {
			issues.push({
				level: "warning",
				code: "UNREACHABLE_STATE",
				message: `State "${stateId}" is unreachable from initial state "${definition.initialStateId}"`,
			});
		}
	}

	return issues;
};
