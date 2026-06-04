import type {
	TransitionId,
	WorkflowDefinition,
	WorkflowPresenter,
	WorkflowRunState,
	WorkflowTransition,
} from "./types.js";

export type PresenterEvent =
	| {
			type: "render";
			workflowId: string;
			stateId: string | null;
			status: string;
	  }
	| {
			type: "clear";
			workflowId: string;
	  }
	| {
			type: "chooseTransition";
			workflowId: string;
			candidateIds: string[];
	  };

export const createNullPresenter = (): WorkflowPresenter => ({
	render: async (_run: WorkflowRunState, _workflow: WorkflowDefinition) => {},
	clear: async (_workflowId: string) => {},
	chooseTransition: async (_run: WorkflowRunState, _transitions: WorkflowTransition[]) => null,
});

export const createRecordingPresenter = (
	choice: TransitionId | null = null,
): WorkflowPresenter & { events: PresenterEvent[] } => {
	const events: PresenterEvent[] = [];

	return {
		events,
		render: async (run, workflow) => {
			events.push({
				type: "render",
				workflowId: workflow.id,
				stateId: run.currentStateId,
				status: run.status,
			});
		},
		clear: async (workflowId) => {
			events.push({
				type: "clear",
				workflowId,
			});
		},
		chooseTransition: async (run, transitions) => {
			events.push({
				type: "chooseTransition",
				workflowId: run.workflowId,
				candidateIds: transitions.map((transition) => transition.id),
			});
			return choice;
		},
	};
};
