import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
	createInMemoryWorkflowRunStore,
	listSelectableTransitions,
	createNullPresenter,
	createWorkflowRegistry,
	createWorkflowService,
	type ActionExecutionRequest,
	type RawExecutionResult,
	type WorkflowAdvanceResult,
	type WorkflowDefinition,
	type WorkflowRunSnapshot,
	type WorkflowRunState,
} from "./domain/index.js";
export const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
export const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";
export const START_WORKFLOW_EVENT = "state-workflow:start-workflow";
export const WORKFLOW_NEXT_TOOL = "workflow_next";
export const WORKFLOW_HISTORY_TOOL = "workflow_history";

export type WorkflowSessionSnapshot = {
	entries: unknown[];
	leafId: string | null;
	sessionFile?: string;
};

export type WorkflowFunctionContext = {
	run: WorkflowRunState;
	session: WorkflowSessionSnapshot;
};

export type WorkflowFunctionHandler = (
	input: unknown,
	context: WorkflowFunctionContext,
) => Promise<unknown> | unknown;

export type ClientWorkflowAction =
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

export type ClientWorkflowStateDefinition = Omit<WorkflowDefinition["states"][string], "action" | "transitions" | "imagePath"> & {
	action: ClientWorkflowAction;
	transitions: WorkflowDefinition["states"][string]["transitions"];
};

export type ClientWorkflowDefinition = Omit<WorkflowDefinition, "states"> & {
	states: Record<string, ClientWorkflowStateDefinition>;
};

export type RegisterFunctionHandlerPayload = {
	name: string;
	handler: WorkflowFunctionHandler;
};

export type StartWorkflowPayload = {
	workflowId: string;
	autoRun?: boolean;
	ctx: ExtensionCommandContext;
};

const SNAPSHOT_ENTRY = "state-workflow:snapshot";
const ACTIVE_ENTRY = "state-workflow:active";
const WIDGET_ID = "state-workflow:status";

type SnapshotEntryData = {
	workflowId: string;
	snapshot: WorkflowRunSnapshot | null;
};

type ActiveEntryData = {
	workflowId: string | null;
};

type PendingToolTransition = {
	toolCallId: string;
	workflowId: string;
	transitionId: string;
};

type WorkflowNextToolDetails = {
	queued: boolean;
	reason?: string;
	pendingTransitionId?: string;
	workflowId?: string;
	transitionId?: string;
};

type WorkflowHistoryToolDetails = {
	workflowId: string;
	status: WorkflowRunState["status"];
	currentStateId: string | null;
	history: WorkflowRunState["history"];
};

const parseWorkflowIdArg = (args: string): string | undefined => {
	const workflowId = args.trim();
	return workflowId || undefined;
};

const parseStartArgs = (args: string): { workflowId?: string; autoRun: boolean } => {
	const parts = args
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const autoRun = parts.includes("--run");
	const workflowId = parts.find((part) => part !== "--run");
	return { workflowId, autoRun };
};

const formatRunLines = (workflow: WorkflowDefinition, run: WorkflowRunState): string[] => {
	const state = run.currentStateId ? workflow.states[run.currentStateId] : undefined;
	const transitions = state?.transitions ?? [];
	const lines = [
		`Workflow: ${workflow.id}`,
		`Current: ${run.currentStateId ?? "<completed>"}`,
		`Status: ${run.status}`,
	];

	if (run.lastResult) {
		lines.push(`Last result: ${run.lastResult.outcome}`);
	}

	lines.push("Next:");
	if (transitions.length === 0) {
		lines.push("- <none>");
	} else {
		for (const transition of transitions) {
			lines.push(`- ${formatTransitionOption(transition)}`);
		}
	}

	return lines;
};

const formatTransitionOption = (transition: WorkflowDefinition["states"][string]["transitions"][number]): string => {
	const label = transition.label ? ` (${transition.label})` : "";
	return `${transition.id}${label} -> ${transition.to} [${transition.trigger}]`;
};

const formatTimestamp = (value: number | undefined): string => {
	if (value === undefined) return "-";
	return new Date(value).toISOString();
};

const formatHistoryLines = (workflow: WorkflowDefinition, run: WorkflowRunState): string[] => {
	const lines = [
		`Workflow: ${workflow.id}`,
		`Current: ${run.currentStateId ?? "<completed>"}`,
		`Status: ${run.status}`,
		"History:",
	];

	if (run.history.length === 0) {
		lines.push("- <empty>");
		return lines;
	}

	for (const entry of run.history) {
		const result = entry.result ?? "-";
		const transitionId = entry.transitionId ?? "-";
		lines.push(
			`- ${entry.stateId} | started=${formatTimestamp(entry.startedAt)} | finished=${formatTimestamp(entry.finishedAt)} | result=${result} | transition=${transitionId}`,
		);
	}

	return lines;
};

const dispatchedUserMessage = (result: WorkflowAdvanceResult): boolean =>
	result.run.lastResult?.raw.kind === "userMessage";

export default function stateWorkflowExtension(pi: ExtensionAPI): void {
	const registry = createWorkflowRegistry();
	const functionHandlers = new Map<string, WorkflowFunctionHandler>();
	const snapshots = new Map<string, WorkflowRunSnapshot>();
	let activeWorkflowId: string | null = null;
	let pendingToolTransition: PendingToolTransition | null = null;
	let latestSessionSnapshot: WorkflowSessionSnapshot = {
		entries: [],
		leafId: null,
	};

	const persistActiveWorkflow = (): void => {
		pi.appendEntry(ACTIVE_ENTRY, { workflowId: activeWorkflowId } satisfies ActiveEntryData);
	};

	const captureSessionSnapshot = (ctx: ExtensionContext): void => {
		latestSessionSnapshot = {
			entries: ctx.sessionManager.getEntries() as unknown[],
			leafId: ctx.sessionManager.getLeafId() ?? null,
			sessionFile: ctx.sessionManager.getSessionFile(),
		};
	};

	const store = createInMemoryWorkflowRunStore();
	const persistentStore = {
		load: store.load,
		save: async (run: WorkflowRunState) => {
			await store.save(run);
			const snapshot: WorkflowRunSnapshot = { version: 1, run };
			snapshots.set(run.workflowId, snapshot);
			pi.appendEntry(SNAPSHOT_ENTRY, {
				workflowId: run.workflowId,
				snapshot,
			} satisfies SnapshotEntryData);
		},
		clear: async (workflowId: string) => {
			await store.clear(workflowId);
			snapshots.delete(workflowId);
			pi.appendEntry(SNAPSHOT_ENTRY, {
				workflowId,
				snapshot: null,
			} satisfies SnapshotEntryData);
		},
	};

	const executor = {
		execute: async ({ state, run }: ActionExecutionRequest): Promise<RawExecutionResult> => {
			if (state.action.kind === "function") {
				const handler = functionHandlers.get(state.action.handler);
				if (!handler) {
					return {
						kind: "function",
						ok: false,
						error: {
							code: "HANDLER_NOT_FOUND",
							message: `Workflow function handler \"${state.action.handler}\" is not registered`,
						},
					};
				}

				try {
					const output = await handler(state.action.input, {
						run,
						session: latestSessionSnapshot,
					});
					return {
						kind: "function",
						ok: true,
						output,
					};
				} catch (error) {
					return {
						kind: "function",
						ok: false,
						error: {
							code: "HANDLER_ERROR",
							message: error instanceof Error ? error.message : String(error),
						},
					};
				}
			}

			if (state.action.kind === "command") {
				return {
					kind: "command",
					exitCode: 1,
					stderr: "command action is not supported by the public base API",
				};
			}

			if (state.action.kind === "continueSession") {
				return {
					kind: "continueSession",
					status: "success",
					output: "continue-session",
				};
			}

			try {
				pi.sendUserMessage(state.action.content);
				return {
					kind: "userMessage",
					status: "success",
					output: state.action.content,
				};
			} catch (error) {
				return {
					kind: "userMessage",
					status: "error",
					error: {
						code: "USER_MESSAGE_SEND_FAILED",
						message: error instanceof Error ? error.message : String(error),
					},
				};
			}
		},
	};

	const service = createWorkflowService({
		registry,
		store: persistentStore,
		executor,
		presenter: createNullPresenter(),
	});

	const refreshWidget = async (ctx: ExtensionContext): Promise<void> => {
		captureSessionSnapshot(ctx);
		if (!ctx.hasUI || !activeWorkflowId) {
			ctx.ui.setWidget(WIDGET_ID, undefined, { placement: "belowEditor" });
			return;
		}

		const workflow = registry.get(activeWorkflowId);
		const run = await service.getRun(activeWorkflowId);
		if (!workflow || !run) {
			ctx.ui.setWidget(WIDGET_ID, undefined, { placement: "belowEditor" });
			return;
		}

		ctx.ui.setWidget(WIDGET_ID, formatRunLines(workflow, run), { placement: "belowEditor" });
	};

	const requireActiveWorkflowId = (ctx: ExtensionCommandContext, args: string): string | undefined => {
		const explicit = parseWorkflowIdArg(args);
		const workflowId = explicit ?? activeWorkflowId ?? undefined;
		if (!workflowId) {
			ctx.ui.notify("No active workflow. Use /workflow-start <id> first.", "warning");
			return undefined;
		}
		return workflowId;
	};

	const getSelectableTransitions = async (
		workflowId: string,
	): Promise<{
		workflow: WorkflowDefinition;
		run: WorkflowRunState;
		transitions: WorkflowDefinition["states"][string]["transitions"];
	}> => {
		const workflow = registry.get(workflowId);
		const run = await service.getRun(workflowId);
		if (!workflow || !run) {
			throw new Error(`Workflow ${workflowId} has no active run.`);
		}

		return {
			workflow,
			run,
			transitions: listSelectableTransitions(workflow, run),
		};
	};

	const runUntilPauseOrCompletion = async (
		workflowId: string,
		ctx: ExtensionContext,
	): Promise<WorkflowAdvanceResult> => {
		for (;;) {
			captureSessionSnapshot(ctx);
			const result = await service.runNext(workflowId, Date.now());
			if (dispatchedUserMessage(result)) {
				return result;
			}
			await refreshWidget(ctx);
			if (result.kind !== "advanced") {
				return result;
			}
		}
	};

	const resolveManualTransitionId = async (
		workflowId: string,
		explicitTransitionId: string | undefined,
		ctx: ExtensionCommandContext,
	): Promise<string | undefined> => {
		if (explicitTransitionId) {
			return explicitTransitionId;
		}

		const { transitions } = await getSelectableTransitions(workflowId);
		if (transitions.length === 0) {
			ctx.ui.notify("No selectable manual transitions are available.", "warning");
			return undefined;
		}

		if (transitions.length === 1) {
			return transitions[0].id;
		}

		if (!ctx.hasUI) {
			ctx.ui.notify("Multiple transitions are available. Use /workflow-next <transitionId>.", "warning");
			return undefined;
		}

		const options = transitions.map(formatTransitionOption);
		const selected = await ctx.ui.select("Choose a workflow transition", options);
		if (!selected) {
			ctx.ui.notify("Workflow transition selection cancelled.", "info");
			return undefined;
		}

		const selectedIndex = options.indexOf(selected);
		return selectedIndex >= 0 ? transitions[selectedIndex].id : undefined;
	};

	const chooseManualAndRunEnteredState = async (
		workflowId: string,
		transitionId: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		captureSessionSnapshot(ctx);
		await service.chooseManual(workflowId, transitionId, Date.now());
		await refreshWidget(ctx);
		ctx.ui.notify(`Selected transition ${transitionId}`, "info");

		const result = await runUntilPauseOrCompletion(workflowId, ctx);
		if (dispatchedUserMessage(result)) {
			return;
		}

		if (result.kind === "waitingManual") {
			ctx.ui.notify("Workflow is waiting for manual transition.", "info");
			return;
		}
		ctx.ui.notify(`Workflow ${workflowId} completed.`, "info");
	};

	const chooseAgentAndRunEnteredState = async (
		workflowId: string,
		transitionId: string,
		ctx: ExtensionContext,
	): Promise<void> => {
		captureSessionSnapshot(ctx);
		await service.chooseAgent(workflowId, transitionId, Date.now());
		await refreshWidget(ctx);
		ctx.ui.notify(`Selected agent transition ${transitionId}`, "info");

		const result = await runUntilPauseOrCompletion(workflowId, ctx);
		if (dispatchedUserMessage(result)) {
			return;
		}

		if (result.kind === "waitingManual") {
			ctx.ui.notify("Workflow is waiting for manual transition.", "info");
			return;
		}
		ctx.ui.notify(`Workflow ${workflowId} completed.`, "info");
	};

	pi.events.on(REGISTER_WORKFLOW_EVENT, (workflow) => {
		registry.register(workflow as WorkflowDefinition);
	});

	pi.events.on(REGISTER_FUNCTION_HANDLER_EVENT, (payload) => {
		const { name, handler } = payload as RegisterFunctionHandlerPayload;
		functionHandlers.set(name, handler);
	});

	const startWorkflow = async (workflowId: string, autoRun: boolean, ctx: ExtensionCommandContext): Promise<void> => {
		const run = await service.start(workflowId, Date.now());
		activeWorkflowId = workflowId;
		persistActiveWorkflow();
		await refreshWidget(ctx);

		if (!autoRun) {
			ctx.ui.notify(`Started workflow ${workflowId} at state ${run.currentStateId}`, "info");
			return;
		}

		const result = await runUntilPauseOrCompletion(workflowId, ctx);
		if (dispatchedUserMessage(result)) {
			return;
		}
		if (result.kind === "waitingManual") {
			ctx.ui.notify("Started workflow and entered manual transition wait state.", "info");
			return;
		}
		ctx.ui.notify(`Started and completed workflow ${workflowId}.`, "info");
	};

	pi.events.on(START_WORKFLOW_EVENT, (payload) => {
		void (async () => {
			const { workflowId, autoRun = false, ctx } = payload as StartWorkflowPayload;
			try {
				await startWorkflow(workflowId, autoRun, ctx);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		})();
	});

	pi.registerTool({
		name: WORKFLOW_NEXT_TOOL,
		label: "Workflow Next",
		description: "Queue a workflow manual transition for the active workflow.",
		promptSnippet: "Use workflow_next to confirm a manual workflow transition by its transitionId.",
		promptGuidelines: [
			"Use workflow_next only when the session instructions explicitly tell you which workflow transitionId to select.",
		],
		parameters: Type.Object({
			transitionId: Type.String({
				description: "Manual workflow transition ID to select, for example retry-linter.",
			}),
		}),
		async execute(toolCallId, params) {
			const workflowId = activeWorkflowId;
			const transitionId = params.transitionId.trim();
			const details = (value: WorkflowNextToolDetails): WorkflowNextToolDetails => value;

			if (!workflowId) {
				return {
					content: [{ type: "text", text: "No active workflow. workflow_next was ignored." }],
					details: details({ queued: false, reason: "NO_ACTIVE_WORKFLOW" }),
				};
			}

			if (!transitionId) {
				return {
					content: [{ type: "text", text: "workflow_next requires a non-empty transitionId." }],
					details: details({ queued: false, reason: "MISSING_TRANSITION_ID" }),
					isError: true,
				};
			}

			if (pendingToolTransition) {
				return {
					content: [
						{
							type: "text",
							text: `workflow_next ignored because ${pendingToolTransition.transitionId} is already queued.`,
						},
					],
					details: details({
						queued: false,
						reason: "TRANSITION_ALREADY_QUEUED",
						pendingTransitionId: pendingToolTransition.transitionId,
					}),
				};
			}

			pendingToolTransition = {
				toolCallId,
				workflowId,
				transitionId,
			};

			return {
				content: [
					{
						type: "text",
						text: `Queued workflow transition ${transitionId}. It will be applied after tool execution ends.`,
					},
				],
				details: details({ queued: true, workflowId, transitionId }),
			};
		},
	});

	pi.registerTool({
		name: WORKFLOW_HISTORY_TOOL,
		label: "Workflow History",
		description: "Show state transition history for the active workflow or a specified workflow.",
		promptSnippet: "Use workflow_history to inspect the workflow state transition log before deciding the next step.",
		parameters: Type.Object({
			workflowId: Type.Optional(
				Type.String({
					description: "Workflow ID. When omitted, the active workflow is used.",
				}),
			),
		}),
		async execute(_toolCallId, params) {
			const workflowId = params.workflowId?.trim() || activeWorkflowId;
			if (!workflowId) {
				return {
					content: [{ type: "text", text: "No active workflow. workflow_history was ignored." }],
					details: { reason: "NO_ACTIVE_WORKFLOW" },
				};
			}

			const workflow = registry.get(workflowId);
			const run = await service.getRun(workflowId);
			if (!workflow || !run) {
				return {
					content: [{ type: "text", text: `Workflow ${workflowId} has no active run.` }],
					details: { reason: "RUN_NOT_FOUND", workflowId },
					isError: true,
				};
			}

			return {
				content: [{ type: "text", text: formatHistoryLines(workflow, run).join("\n") }],
				details: {
					workflowId,
					status: run.status,
					currentStateId: run.currentStateId,
					history: run.history,
				} satisfies WorkflowHistoryToolDetails,
			};
		},
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		const pending = pendingToolTransition;
		if (!pending) return;
		if (event.toolName !== WORKFLOW_NEXT_TOOL) return;
		if (event.toolCallId !== pending.toolCallId) return;

		pendingToolTransition = null;

		try {
			await chooseAgentAndRunEnteredState(pending.workflowId, pending.transitionId, ctx);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		captureSessionSnapshot(ctx);
		snapshots.clear();
		activeWorkflowId = null;
		pendingToolTransition = null;
		for (const entry of ctx.sessionManager.getEntries() as Array<any>) {
			if (entry.type !== "custom") continue;
			if (entry.customType === SNAPSHOT_ENTRY) {
				const data = entry.data as SnapshotEntryData | undefined;
				if (!data) continue;
				if (data.snapshot) {
					snapshots.set(data.workflowId, data.snapshot);
					await store.save(data.snapshot.run);
				} else {
					await store.clear(data.workflowId);
					snapshots.delete(data.workflowId);
				}
			}
			if (entry.customType === ACTIVE_ENTRY) {
				const data = entry.data as ActiveEntryData | undefined;
				activeWorkflowId = data?.workflowId ?? null;
			}
		}

		await refreshWidget(ctx);
	});

	pi.registerCommand("workflow-list", {
		description: "List registered workflows",
		handler: async (_args, ctx) => {
			const workflows = registry.list();
			if (workflows.length === 0) {
				ctx.ui.notify("No workflows registered.", "info");
				return;
			}
			const text = workflows
				.map((workflow) => `${workflow.id}${workflow.id === activeWorkflowId ? " *active" : ""}`)
				.join("\n");
			ctx.ui.notify(text, "info");
		},
	});

	pi.registerCommand("workflow-start", {
		description: "Start a workflow: /workflow-start <id> [--run]",
		handler: async (args, ctx) => {
			const { workflowId, autoRun } = parseStartArgs(args);
			if (!workflowId) {
				ctx.ui.notify("Usage: /workflow-start <workflowId> [--run]", "warning");
				return;
			}
			await startWorkflow(workflowId, autoRun, ctx);
		},
	});

	pi.registerCommand("workflow-next", {
		description: "Choose a manual transition: /workflow-next [transitionId]",
		handler: async (args, ctx) => {
			const workflowId = activeWorkflowId;
			if (!workflowId) {
				ctx.ui.notify("No active workflow.", "warning");
				return;
			}
			const transitionId = await resolveManualTransitionId(workflowId, parseWorkflowIdArg(args), ctx);
			if (!transitionId) {
				return;
			}

			await chooseManualAndRunEnteredState(workflowId, transitionId, ctx);
		},
	});

	pi.registerCommand("workflow-history", {
		description: "Show workflow transition history",
		handler: async (args, ctx) => {
			const workflowId = requireActiveWorkflowId(ctx, args);
			if (!workflowId) return;
			const workflow = registry.get(workflowId);
			const run = await service.getRun(workflowId);
			if (!workflow || !run) {
				ctx.ui.notify(`Workflow ${workflowId} has no active run.`, "warning");
				return;
			}
			ctx.ui.notify(formatHistoryLines(workflow, run).join("\n"), "info");
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show status of the active workflow",
		handler: async (args, ctx) => {
			const workflowId = requireActiveWorkflowId(ctx, args);
			if (!workflowId) return;
			const workflow = registry.get(workflowId);
			const run = await service.getRun(workflowId);
			if (!workflow || !run) {
				ctx.ui.notify(`Workflow ${workflowId} has no active run.`, "warning");
				return;
			}
			ctx.ui.notify(formatRunLines(workflow, run).join("\n"), "info");
		},
	});

	pi.registerCommand("workflow-abort", {
		description: "Abort the active workflow and clear its run state",
		handler: async (args, ctx) => {
			const workflowId = requireActiveWorkflowId(ctx, args);
			if (!workflowId) return;
			await persistentStore.clear(workflowId);
			if (activeWorkflowId === workflowId) {
				activeWorkflowId = null;
				persistActiveWorkflow();
			}
			await refreshWidget(ctx);
			ctx.ui.notify(`Aborted workflow ${workflowId}`, "info");
		},
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget(WIDGET_ID, undefined, { placement: "belowEditor" });
	});
}
