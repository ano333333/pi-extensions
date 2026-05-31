import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	createInMemoryWorkflowRunStore,
	createNullPresenter,
	createWorkflowRegistry,
	createWorkflowService,
	type ActionExecutionRequest,
	type RawExecutionResult,
	type WorkflowDefinition,
	type WorkflowRunSnapshot,
	type WorkflowRunState,
} from "./domain/index.js";
export const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
export const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";
export const START_WORKFLOW_EVENT = "state-workflow:start-workflow";

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
			const label = transition.label ? ` (${transition.label})` : "";
			lines.push(`- ${transition.id}${label} -> ${transition.to} [${transition.trigger}]`);
		}
	}

	return lines;
};

export default function stateWorkflowExtension(pi: ExtensionAPI): void {
	const registry = createWorkflowRegistry();
	const functionHandlers = new Map<string, WorkflowFunctionHandler>();
	const snapshots = new Map<string, WorkflowRunSnapshot>();
	let activeWorkflowId: string | null = null;
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

	const chooseManualAndRunEnteredState = async (
		workflowId: string,
		transitionId: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		captureSessionSnapshot(ctx);
		await service.chooseManual(workflowId, transitionId, Date.now());
		await refreshWidget(ctx);
		ctx.ui.notify(`Selected transition ${transitionId}`, "info");

		captureSessionSnapshot(ctx);
		const result = await service.runNext(workflowId, Date.now());
		await refreshWidget(ctx);

		if (result.kind === "advanced") {
			ctx.ui.notify(`Advanced to ${result.nextStateId}`, "info");
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

		captureSessionSnapshot(ctx);
		const result = await service.runNext(workflowId, Date.now());
		await refreshWidget(ctx);
		if (result.kind === "advanced") {
			ctx.ui.notify(`Started and advanced to ${result.nextStateId}`, "info");
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

	pi.on("session_start", async (_event, ctx) => {
		captureSessionSnapshot(ctx);
		snapshots.clear();
		activeWorkflowId = null;
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
		description: "Run the current state of the active workflow",
		handler: async (args, ctx) => {
			const workflowId = requireActiveWorkflowId(ctx, args);
			if (!workflowId) return;

			captureSessionSnapshot(ctx);
			const result = await service.runNext(workflowId, Date.now());
			await refreshWidget(ctx);

			if (result.kind === "advanced") {
				ctx.ui.notify(`Advanced to ${result.nextStateId}`, "info");
				return;
			}

			if (result.kind === "waitingManual") {
				if (ctx.hasUI) {
					const choice = await ctx.ui.select(
						"Choose workflow transition",
						result.candidates.map((candidate) => `${candidate.id} -> ${candidate.to}`),
					);
					if (choice) {
						const transitionId = choice.split(" -> ")[0] ?? choice;
						await chooseManualAndRunEnteredState(workflowId, transitionId, ctx);
						return;
					}
				}
				ctx.ui.notify("Workflow is waiting for manual transition.", "info");
				return;
			}

			ctx.ui.notify(`Workflow ${workflowId} completed.`, "info");
		},
	});

	pi.registerCommand("workflow-choose", {
		description: "Choose a manual transition: /workflow-choose <transitionId>",
		handler: async (args, ctx) => {
			const workflowId = activeWorkflowId;
			const transitionId = parseWorkflowIdArg(args);
			if (!workflowId) {
				ctx.ui.notify("No active workflow.", "warning");
				return;
			}
			if (!transitionId) {
				ctx.ui.notify("Usage: /workflow-choose <transitionId>", "warning");
				return;
			}

			await chooseManualAndRunEnteredState(workflowId, transitionId, ctx);
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
