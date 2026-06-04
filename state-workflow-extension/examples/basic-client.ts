import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";

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

const workflow: ClientWorkflowDefinition = {
	id: "demo-review-flow",
	initialStateId: "prepare",
	states: {
		prepare: {
			id: "prepare",
			title: "Prepare",
			action: {
				kind: "function",
				handler: "demo.prepare",
				input: { note: "prepare workflow context" },
			},
			transitions: [{ id: "prepare-ok", to: "ask-agent", trigger: "success" }],
		},
		"ask-agent": {
			id: "ask-agent",
			title: "Ask Agent",
			action: {
				kind: "userMessage",
				content:
					"Summarize the current repository status and propose the next implementation step for the workflow demo.",
			},
			transitions: [{ id: "ask-agent-dispatched", to: "done", trigger: "success" }],
		},
		done: {
			id: "done",
			title: "Done",
			action: {
				kind: "function",
				handler: "demo.done",
			},
			transitions: [],
		},
	},
};

export default function basicClientExtension(pi: ExtensionAPI): void {
	const registerSelf = (): void => {
		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "demo.prepare",
			handler: (input) => ({
				prepared: true,
				input,
			}),
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "demo.done",
			handler: () => ({
				completed: true,
			}),
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_WORKFLOW_EVENT, workflow);
	};

	pi.on("session_start", async () => {
		registerSelf();
	});

	registerSelf();
}
