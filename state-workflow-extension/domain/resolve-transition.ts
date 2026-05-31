import type {
	GuardRegistry,
	ResolveTransitionInput,
	ResolveTransitionResult,
	WorkflowTransition,
	WorkflowTrigger,
} from "./types.js";

const sortTransitions = (transitions: WorkflowTransition[]): WorkflowTransition[] =>
	[...transitions].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

const guardPasses = (
	transition: WorkflowTransition,
	input: ResolveTransitionInput,
	guards: GuardRegistry,
): boolean => {
	if (!transition.guard) return true;
	const guard = guards[transition.guard];
	return guard
		? guard({ run: input.run, result: input.result, state: input.state })
		: false;
};

const findByTrigger = (
	trigger: WorkflowTrigger,
	input: ResolveTransitionInput,
): WorkflowTransition[] => {
	const sorted = sortTransitions(input.state.transitions);
	return sorted.filter((transition) => transition.trigger === trigger && guardPasses(transition, input, input.guards));
};

export const resolveTransition = (input: ResolveTransitionInput): ResolveTransitionResult => {
	const direct = findByTrigger(input.result.outcome, input);
	if (direct[0]) {
		return {
			kind: "transition",
			transition: direct[0],
			nextStateId: direct[0].to,
		};
	}

	const always = findByTrigger("always", input);
	if (always[0]) {
		return {
			kind: "transition",
			transition: always[0],
			nextStateId: always[0].to,
		};
	}

	const manual = findByTrigger("manual", input);
	if (manual.length > 0) {
		return {
			kind: "manual",
			candidates: manual,
		};
	}

	return { kind: "complete" };
};
