import { createInitialRunState } from "./runtime.js";
import { runCurrentState } from "./run-current-state.js";
import { selectManualTransition } from "./select-manual-transition.js";
import { createNullPresenter } from "./presenter.js";
import { createWorkflowRegistry } from "./registry.js";
import type {
	ActionExecutor,
	GuardRegistry,
	TransitionId,
	WorkflowDefinition,
	WorkflowId,
	WorkflowPresenter,
	WorkflowRegistrationResult,
	WorkflowRunState,
	WorkflowRunStore,
	WorkflowService,
} from "./types.js";

export type CreateWorkflowServiceInput = {
	registry?: ReturnType<typeof createWorkflowRegistry>;
	store: WorkflowRunStore;
	executor: ActionExecutor;
	presenter?: WorkflowPresenter;
	guards?: GuardRegistry;
};

const requireWorkflow = (
	workflowId: WorkflowId,
	definition: WorkflowDefinition | undefined,
): WorkflowDefinition => {
	if (!definition) {
		throw new Error(`Workflow "${workflowId}" is not registered`);
	}
	return definition;
};

const requireRun = (workflowId: WorkflowId, run: WorkflowRunState | null): WorkflowRunState => {
	if (!run) {
		throw new Error(`Workflow run "${workflowId}" does not exist`);
	}
	return run;
};

export const createWorkflowService = ({
	registry = createWorkflowRegistry(),
	store,
	executor,
	presenter = createNullPresenter(),
	guards = {},
}: CreateWorkflowServiceInput): WorkflowService => {
	const register = (workflow: WorkflowDefinition): WorkflowRegistrationResult => registry.register(workflow);

	const unregister = async (workflowId: WorkflowId): Promise<boolean> => {
		await store.clear(workflowId);
		await presenter.clear(workflowId);
		return registry.unregister(workflowId);
	};

	const getRun = async (workflowId: WorkflowId): Promise<WorkflowRunState | null> => store.load(workflowId);

	const start = async (workflowId: WorkflowId, now: number): Promise<WorkflowRunState> => {
		const workflow = requireWorkflow(workflowId, registry.get(workflowId));
		const run = createInitialRunState(workflow, now);
		await store.save(run);
		await presenter.render(run, workflow);
		return run;
	};

	const runNext = async (workflowId: WorkflowId, now: number) => {
		const workflow = requireWorkflow(workflowId, registry.get(workflowId));
		const run = requireRun(workflowId, await store.load(workflowId));
		const result = await runCurrentState({
			definition: workflow,
			run,
			executor,
			guards,
			now,
		});

		await store.save(result.run);
		await presenter.render(result.run, workflow);
		if (result.kind === "completed") {
			await presenter.clear(workflowId);
		}
		return result;
	};

	const chooseManual = async (
		workflowId: WorkflowId,
		transitionId: TransitionId,
		now: number,
	): Promise<WorkflowRunState> => {
		const workflow = requireWorkflow(workflowId, registry.get(workflowId));
		const run = requireRun(workflowId, await store.load(workflowId));
		const nextRun = selectManualTransition({
			definition: workflow,
			run,
			transitionId,
			now,
		});
		await store.save(nextRun);
		await presenter.render(nextRun, workflow);
		return nextRun;
	};
	const chooseAgent = async (
		workflowId: WorkflowId,
		transitionId: TransitionId,
		now: number,
	): Promise<WorkflowRunState> => {
		const workflow = requireWorkflow(workflowId, registry.get(workflowId));
		const run = requireRun(workflowId, await store.load(workflowId));
		const nextRun = selectManualTransition({
			definition: workflow,
			run,
			transitionId,
			now,
			allowedTriggers: ["manualOrAgent"],
		});
		await store.save(nextRun);
		await presenter.render(nextRun, workflow);
		return nextRun;
	};

	return {
		register,
		unregister,
		start,
		runNext,
		chooseManual,
		chooseAgent,
		getRun,
	};
};
