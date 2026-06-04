import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";
const START_WORKFLOW_EVENT = "state-workflow:start-workflow";

type WorkflowSessionSnapshot = {
	entries: unknown[];
	leafId: string | null;
	sessionFile?: string;
};

type WorkflowFunctionContext = {
	run: {
		history?: Array<{ stateId?: string }>;
	};
	session: WorkflowSessionSnapshot;
};

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
	handler: (input: unknown, context: WorkflowFunctionContext) => Promise<unknown> | unknown;
};

type StartWorkflowPayload = {
	workflowId: string;
	autoRun?: boolean;
	ctx: unknown;
};

const countStateEntries = (history: Array<{ stateId?: string }> | undefined, stateId: string): number =>
	history?.filter((entry) => entry.stateId === stateId).length ?? 0;

const workflow: ClientWorkflowDefinition = {
	id: "agent-retry-demo",
	initialStateId: "formatter",
	title: "Agent Retry Demo",
	states: {
		formatter: {
			id: "formatter",
			title: "Formatter",
			action: { kind: "function", handler: "agent-retry-demo.formatter" },
			transitions: [{ id: "formatter-ok", to: "linter", trigger: "success" }],
		},
		linter: {
			id: "linter",
			title: "Linter",
			action: { kind: "function", handler: "agent-retry-demo.linter" },
			transitions: [
				{ id: "lint-clean", to: "done", trigger: "success" },
				{ id: "lint-failed", to: "linter-failed", trigger: "error" },
			],
		},
		"linter-failed": {
			id: "linter-failed",
			title: "Linter failed",
			action: {
				kind: "userMessage",
				content:
					"Lint が失敗しました。エラーを修正してください。修正後は workflow_next ツールを transitionId='retry-linter' で呼んで再試行してください。人間が中止したい場合は /workflow-next abort-run を使えます。",
			},
			transitions: [
				{
					id: "retry-linter",
					to: "linter",
					trigger: "manualOrAgent",
					label: "Retry after fix",
				},
				{
					id: "abort-run",
					to: "done",
					trigger: "manual",
					label: "Abort manually",
				},
			],
		},
		done: {
			id: "done",
			title: "Done",
			action: { kind: "function", handler: "agent-retry-demo.done" },
			transitions: [],
		},
	},
};

export default function agentRetryClientExtension(pi: ExtensionAPI): void {
	const registerSelf = (): void => {
		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "agent-retry-demo.formatter",
			handler: () => ({
				formatted: true,
			}),
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "agent-retry-demo.linter",
			handler: (_input, context) => {
				const attempts = countStateEntries(context.run.history, "linter");
				if (attempts <= 1) {
					throw new Error("Example lint failure on first attempt");
				}
				return {
					linted: true,
					attempts,
				};
			},
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "agent-retry-demo.done",
			handler: (_input, context) => ({
				completed: true,
				sessionFile: context.session.sessionFile,
			}),
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_WORKFLOW_EVENT, workflow);
	};

	pi.on("session_start", async () => {
		registerSelf();
	});

	pi.registerCommand("agent-retry-demo", {
		description: "Start the AI-selectable retry workflow demo",
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
