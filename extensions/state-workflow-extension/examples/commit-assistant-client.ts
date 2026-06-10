import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";
const START_WORKFLOW_EVENT = "state-workflow:start-workflow";
const COMMIT_MESSAGE_FILE = ".git/COMMIT_ASSISTANT_MSG";

type WorkflowSessionSnapshot = {
	entries: unknown[];
	leafId: string | null;
	sessionFile?: string;
};

type WorkflowFunctionContext = {
	run: {
		history?: Array<{ stateId?: string; transitionId?: string }>;
		lastResult?: {
			error?: {
				code?: string;
				message?: string;
			};
		};
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

const DRAFT_MESSAGE = `コミットメッセージの提案をお願いします。このワークフローは変更がなくなるまで繰り返されるので、1 回につき 1 コミット分だけ提案してください。次の手順で進めてください。
1. git status と git diff(staged 分は git diff --cached)で現在の変更内容を確認する
2. 次の 1 コミットに含めるべき変更を選んで 1〜2 文で要約を報告し、その変更だけを git add で stage する(すでに stage 済みの内容と混ざる場合は git reset で整理してよい)
3. その 1 コミット分の Conventional Commits 形式のコミットメッセージ案を 1 つ、コードブロックで提示する
4. 同じメッセージをファイル .git/COMMIT_ASSISTANT_MSG に書き込む
注意: git commit / git push は実行しないでください。コミットは人間が承認したあとにワークフローが実行します。
ここまで終えたら、workflow_next ツールを transitionId='message-ready' で呼んでください。`;

const countStateEntries = (
	history: Array<{ stateId?: string; transitionId?: string }> | undefined,
	stateId: string,
): number => history?.filter((entry) => entry.stateId === stateId).length ?? 0;

const countTransitionEntries = (
	history: Array<{ stateId?: string; transitionId?: string }> | undefined,
	transitionId: string,
): number => history?.filter((entry) => entry.transitionId === transitionId).length ?? 0;

const workflow = {
	id: "commit-assistant",
	initialStateId: "check-changes",
	title: "Commit Assistant",
	states: {
		"check-changes": {
			id: "check-changes",
			title: "Check changes",
			action: { kind: "function", handler: "commit-assistant.check-changes" },
			transitions: [
				{ id: "changes-found", to: "draft-message", trigger: "success" },
				{ id: "repo-clean", to: "done", trigger: "error" },
			],
		},
		"draft-message": {
			id: "draft-message",
			title: "Draft commit message",
			action: {
				kind: "userMessage",
				content: DRAFT_MESSAGE,
			},
			transitions: [
				{
					id: "message-ready",
					to: "review",
					trigger: "manualOrAgent",
					label: "Commit message proposed",
				},
			],
		},
		review: {
			id: "review",
			title: "Human review",
			action: { kind: "continueSession" },
			transitions: [
				{
					id: "approve-commit",
					to: "commit",
					trigger: "manual",
					label: "Approve and commit",
				},
				{
					id: "revise",
					to: "draft-message",
					trigger: "manual",
					label: "Request another draft",
				},
			],
		},
		commit: {
			id: "commit",
			title: "Commit",
			action: { kind: "function", handler: "commit-assistant.commit" },
			transitions: [
				{
					id: "commit-done",
					to: "check-changes",
					trigger: "success",
					label: "Committed",
				},
				{
					id: "commit-failed",
					to: "review",
					trigger: "error",
					label: "Commit failed",
				},
			],
		},
		done: {
			id: "done",
			title: "Done",
			action: { kind: "function", handler: "commit-assistant.summarize" },
			transitions: [],
		},
	},
} satisfies ClientWorkflowDefinition;

export default function commitAssistantClientExtension(pi: ExtensionAPI): void {
	const registerSelf = (): void => {
		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "commit-assistant.check-changes",
			handler: async () => {
				const result = await pi.exec("git", ["status", "--porcelain"]);
				if (result.code !== 0) {
					throw new Error(`git status failed: ${result.stderr}`);
				}
				const stdout = result.stdout.trim();
				if (stdout === "") {
					throw new Error("No uncommitted changes");
				}
				const files = stdout.split("\n");
				return {
					changedFiles: files.length,
					files: files.slice(0, 20),
				};
			},
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "commit-assistant.commit",
			handler: async () => {
				const stagedResult = await pi.exec("git", ["diff", "--cached", "--quiet"]);
				if (stagedResult.code === 0) {
					throw new Error("Nothing staged for commit");
				}
				if (stagedResult.code !== 1) {
					throw new Error(`git diff --cached failed: ${stagedResult.stderr}`);
				}

				const commitResult = await pi.exec("git", ["commit", "-F", COMMIT_MESSAGE_FILE]);
				if (commitResult.code !== 0) {
					throw new Error(`git commit failed: ${commitResult.stderr}`);
				}

				await pi.exec("rm", ["-f", COMMIT_MESSAGE_FILE]);

				const logResult = await pi.exec("git", ["log", "-1", "--format=%h %s"]);
				return {
					committed: true,
					head: logResult.stdout.trim(),
				};
			},
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_FUNCTION_HANDLER_EVENT, {
			name: "commit-assistant.summarize",
			handler: (_input, context) => {
				const commits = countTransitionEntries(context.run.history, "commit-done");
				const draftCount = countStateEntries(context.run.history, "draft-message");
				const reason = context.run.lastResult?.error?.message ?? "unknown";
				return {
					commits,
					draftCount,
					reason,
					sessionFile: context.session.sessionFile,
				};
			},
		} satisfies RegisterFunctionHandlerPayload);

		pi.events.emit(REGISTER_WORKFLOW_EVENT, workflow);
	};

	pi.on("session_start", async () => {
		registerSelf();
	});

	pi.registerCommand("commit-assistant", {
		description: "Start the commit message assistant workflow",
		handler: async (_args, ctx) => {
			registerSelf();
			pi.events.emit(START_WORKFLOW_EVENT, {
				workflowId: "commit-assistant",
				autoRun: true,
				ctx,
			} satisfies StartWorkflowPayload);
		},
	});

	registerSelf();
}
