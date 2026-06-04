import { validateWorkflow } from "./validate-workflow.js";
import type {
	WorkflowDefinition,
	WorkflowId,
	WorkflowRegistrationResult,
	WorkflowRegistry,
} from "./types.js";

export const createWorkflowRegistry = (
	initialWorkflows: WorkflowDefinition[] = [],
): WorkflowRegistry => {
	const workflows = new Map<WorkflowId, WorkflowDefinition>();

	const register = (workflow: WorkflowDefinition): WorkflowRegistrationResult => {
		const issues = validateWorkflow(workflow).filter((issue) => issue.level === "error");
		if (issues.length > 0) {
			return {
				ok: false,
				workflow,
				issues,
			};
		}

		workflows.set(workflow.id, workflow);
		return {
			ok: true,
			workflow,
		};
	};

	const unregister = (workflowId: WorkflowId): boolean => workflows.delete(workflowId);
	const get = (workflowId: WorkflowId): WorkflowDefinition | undefined => workflows.get(workflowId);
	const list = (): WorkflowDefinition[] => [...workflows.values()];

	for (const workflow of initialWorkflows) {
		register(workflow);
	}

	return {
		register,
		unregister,
		get,
		list,
	};
};
