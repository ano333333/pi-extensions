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
	run: unknown;
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

const extractLastWord = (session: WorkflowSessionSnapshot): string | null => {
	for (let index = session.entries.length - 1; index >= 0; index -= 1) {
		const entry = session.entries[index] as {
			type?: string;
			message?: {
				role?: string;
				content?: unknown;
			};
		};
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const content = message.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.map((block) => {
					if (typeof block === "object" && block && "type" in block && "text" in block && block.type === "text") {
						return String(block.text);
					}
					return "";
				})
				.join(" ");
		}

		const normalized = text
			.replace(/[\n\r]+/g, " ")
			.trim()
			.split(/\s+/)
			.filter(Boolean)
			.at(-1)
			?.replace(/[。、，,!.?！？\)]*$/, "")
			?.trim();

		if (normalized) return normalized;
	}

	return null;
};

const workflow: ClientWorkflowDefinition = {
	id: "shiritori",
	initialStateId: "announce",
	states: {
		announce: {
			id: "announce",
			title: "Announce game",
			action: {
				kind: "userMessage",
				content:
					"これからしりとりをします。最初の単語は『りんご』です。しりとりを続けてください。",
			},
			transitions: [{ id: "start-playing", to: "playing", trigger: "success" }],
		},
		playing: {
			id: "playing",
			title: "Playing",
			action: { kind: "continueSession" },
			transitions: [{ id: "check-last-word", to: "check-last-word", trigger: "manual" }],
		},
		"check-last-word": {
			id: "check-last-word",
			title: "Check last word",
			action: { kind: "function", handler: "shiritori.check-last-word" },
			transitions: [
				{ id: "game-over", to: "done", trigger: "success" },
				{ id: "continue-playing", to: "playing", trigger: "error" },
			],
		},
		done: {
			id: "done",
			title: "Done",
			action: { kind: "function", handler: "shiritori.done" },
			transitions: [],
		},
	},
};

export default function shiritoriClientExtension(pi: ExtensionAPI): void {
	const registerSelf = (): void => {
		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "shiritori.check-last-word",
			handler: (_input, context) => {
				const lastWord = extractLastWord(context.session);
				if (!lastWord) {
					throw new Error("最後の単語が見つかりませんでした");
				}
				if (/[んン]$/.test(lastWord)) {
					return { lastWord, gameOver: true };
				}
				throw new Error(`まだ継続できます: ${lastWord}`);
			},
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "shiritori.done",
			handler: (_input, context) => {
				const lastWord = extractLastWord(context.session);
				return {
					completed: true,
					lastWord,
				};
			},
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_WORKFLOW_EVENT, workflow);
	};

	pi.on("session_start", async () => {
		registerSelf();
	});

	pi.registerCommand("shiritori-client", {
		description: "Start the shiritori workflow",
		handler: async (_args, ctx) => {
			registerSelf();
			pi.events.emit(START_WORKFLOW_EVENT, {
				workflowId: "shiritori",
				autoRun: true,
				ctx,
			} satisfies StartWorkflowPayload);
		},
	});

	registerSelf();
}
