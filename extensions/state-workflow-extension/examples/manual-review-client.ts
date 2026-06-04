import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";
const START_WORKFLOW_EVENT = "state-workflow:start-workflow";

type ClientWorkflowAction =
	| {
			kind: "function";
			handler: string;
			input?: unknown;
	  }
	| {
			kind: "userMessage";
			content: string;
			resultKey?: string;
	  }
	| {
			kind: "continueSession";
	  };

type WorkflowTransition = {
	id: string;
	to: string;
	trigger: "success" | "error" | "always" | "manual" | "manualOrAgent";
	label?: string;
	guard?: string;
	priority?: number;
};

type ClientWorkflowDefinition = {
	id: string;
	initialStateId: string;
	title?: string;
	states: Record<
		string,
		{
			id: string;
			title?: string;
			action: ClientWorkflowAction;
			transitions: WorkflowTransition[];
		}
	>;
};

type RegisterFunctionHandlerPayload = {
	name: string;
	handler: (input: unknown, context: unknown) => Promise<unknown> | unknown;
};

type StartWorkflowPayload = {
	workflowId: string;
	autoRun?: boolean;
	ctx: unknown;
};

const workflow: ClientWorkflowDefinition = {
	id: "manual-review-demo",
	initialStateId: "draft-plan",
	title: "Manual Review Demo",
	states: {
		"draft-plan": {
			id: "draft-plan",
			title: "Draft plan",
			action: {
				kind: "userMessage",
				content:
					"README の改善案を 3 点提案してください。提案だけを返し、承認は待ってください。",
			},
			transitions: [{ id: "proposal-sent", to: "human-review", trigger: "success" }],
		},
		"human-review": {
			id: "human-review",
			title: "Human review",
			action: { kind: "continueSession" },
			transitions: [
				{ id: "approve-plan", to: "apply-plan", trigger: "manual", label: "Approve" },
				{ id: "request-redraft", to: "redraft-plan", trigger: "manual", label: "Redraft" },
			],
		},
		"redraft-plan": {
			id: "redraft-plan",
			title: "Redraft plan",
			action: {
				kind: "userMessage",
				content: "提案を短くし、実装手順ベースで 2 点に絞って提案し直してください。",
			},
			transitions: [{ id: "redraft-sent", to: "human-review", trigger: "success" }],
		},
		"apply-plan": {
			id: "apply-plan",
			title: "Apply plan",
			action: { kind: "function", handler: "manual-review-demo.apply-plan" },
			transitions: [{ id: "applied", to: "done", trigger: "success" }],
		},
		done: {
			id: "done",
			title: "Done",
			action: { kind: "function", handler: "manual-review-demo.done" },
			transitions: [],
		},
	},
};

export default function manualReviewClientExtension(pi: ExtensionAPI): void {
	const registerSelf = (): void => {
		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "manual-review-demo.apply-plan",
			handler: () => ({
				applied: true,
				note: "This example keeps approval manual-only. AI cannot choose these transitions.",
			}),
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "manual-review-demo.done",
			handler: () => ({
				completed: true,
			}),
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_WORKFLOW_EVENT, workflow);
	};

	pi.on("session_start", async () => {
		registerSelf();
	});

	pi.registerCommand("manual-review-demo", {
		description: "Start the manual-only review workflow demo",
		handler: async (_args, ctx) => {
			registerSelf();
			pi.events.emit(START_WORKFLOW_EVENT, {
				workflowId: workflow.id,
				autoRun: true,
				ctx,
			} satisfies StartWorkflowPayload);
		},
	});

	registerSelf();
}
