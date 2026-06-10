import { describe, expect, it, vi } from "vitest";

import stateWorkflowExtension, { WORKFLOW_HISTORY_TOOL, WORKFLOW_NEXT_TOOL } from "./index.js";

type CommandHandler = (args: string, ctx: any) => Promise<void>;
type ToolHandler = (
	toolCallId: string,
	params: Record<string, unknown>,
	signal: AbortSignal | undefined,
	onUpdate: ((update: unknown) => void) | undefined,
	ctx: any,
) => Promise<unknown>;

const createExtensionApiMock = () => {
	const commands = new Map<string, CommandHandler>();
	const commandDescriptions = new Map<string, string>();
	const tools = new Map<string, ToolHandler>();
	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const lifecycleHandlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void> | void>>();

	const api = {
		registerCommand: (name: string, config: { description: string; handler: CommandHandler }) => {
			commands.set(name, config.handler);
			commandDescriptions.set(name, config.description);
		},
		registerTool: (definition: { name: string; execute: ToolHandler }) => {
			tools.set(definition.name, definition.execute);
		},
		events: {
			on: (name: string, handler: (payload: unknown) => void) => {
				const handlers = eventHandlers.get(name) ?? [];
				handlers.push(handler);
				eventHandlers.set(name, handlers);
			},
		},
		on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			const handlers = lifecycleHandlers.get(name) ?? [];
			handlers.push(handler);
			lifecycleHandlers.set(name, handlers);
		},
		appendEntry: vi.fn(),
		sendUserMessage: vi.fn(),
	} as any;

	return {
		api,
		commands,
		commandDescriptions,
		tools,
		eventHandlers,
		lifecycleHandlers,
	};
};

const createCommandContext = () => ({
	hasUI: true,
	ui: {
		notify: vi.fn(),
		setWidget: vi.fn(),
		select: vi.fn(),
	},
	sessionManager: {
		getEntries: () => [],
		getLeafId: () => null,
		getSessionFile: () => undefined,
	},
});

describe("stateWorkflowExtension commands", () => {
	it("registers workflow-next and does not register workflow-choose", () => {
		const { api, commands, commandDescriptions, tools } = createExtensionApiMock();

		stateWorkflowExtension(api);

		expect(commands.has("workflow-next")).toBe(true);
		expect(commands.has("workflow-history")).toBe(true);
		expect(commands.has("workflow-choose")).toBe(false);
		expect(tools.has(WORKFLOW_NEXT_TOOL)).toBe(true);
		expect(tools.has(WORKFLOW_HISTORY_TOOL)).toBe(true);
		expect(commandDescriptions.get("workflow-next")).toBe(
			"Choose a manual transition: /workflow-next [transitionId]",
		);
	});

	it("warns when workflow-next is used without an active workflow", async () => {
		const { api, commands } = createExtensionApiMock();
		stateWorkflowExtension(api);
		const handler = commands.get("workflow-next");
		const ctx = createCommandContext();

		expect(handler).toBeTypeOf("function");
		await handler!("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("No active workflow.", "warning");
	});

	it("auto-selects the only manual transition when workflow-next has no transition id", async () => {
		const { api, commands, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		expect(registerWorkflow).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "approve", to: "done", trigger: "manual" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});

		const startHandler = commands.get("workflow-start");
		const nextHandler = commands.get("workflow-next");
		expect(startHandler).toBeTypeOf("function");
		expect(nextHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);
		await nextHandler!("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Selected transition approve", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow wf completed.", "info");
		expect(ctx.ui.select).not.toHaveBeenCalled();
	});

	it("opens a selection UI when workflow-next has multiple manual candidates", async () => {
		const { api, commands, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		expect(registerWorkflow).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [
						{ id: "approve", to: "done", trigger: "manual", label: "Approve changes" },
						{ id: "reject", to: "done", trigger: "manual", label: "Reject changes" },
					],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});

		const startHandler = commands.get("workflow-start");
		const nextHandler = commands.get("workflow-next");
		expect(startHandler).toBeTypeOf("function");
		expect(nextHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		ctx.ui.select.mockResolvedValue("reject (Reject changes) -> done [manual]");

		await startHandler!("wf --run", ctx);
		await nextHandler!("", ctx);

		expect(ctx.ui.select).toHaveBeenCalledWith("Choose a workflow transition", [
			"approve (Approve changes) -> done [manual]",
			"reject (Reject changes) -> done [manual]",
		]);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Selected transition reject", "info");
	});

	it("auto-runs chained states after workflow-start --run until completion", async () => {
		const { api, commands, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		const registerFunctionHandler = eventHandlers.get("state-workflow:register-function-handler")?.[0];
		expect(registerWorkflow).toBeTypeOf("function");
		expect(registerFunctionHandler).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "formatter",
			states: {
				formatter: {
					id: "formatter",
					action: { kind: "function", handler: "formatter" },
					transitions: [{ id: "formatter-ok", to: "linter", trigger: "success" }],
				},
				linter: {
					id: "linter",
					action: { kind: "function", handler: "linter" },
					transitions: [{ id: "linter-ok", to: "done", trigger: "success" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});
		registerFunctionHandler!({
			name: "formatter",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});
		registerFunctionHandler!({
			name: "linter",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});

		const startHandler = commands.get("workflow-start");
		expect(startHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith("Started and completed workflow wf.", "info");
		const lastWidgetCall = ctx.ui.setWidget.mock.calls.at(-1);
		expect(lastWidgetCall?.[0]).toBe("state-workflow:status");
		expect(lastWidgetCall?.[1]).toEqual(expect.arrayContaining(["Current: <completed>", "Status: completed"]));
		expect(lastWidgetCall?.[2]).toEqual({ placement: "belowEditor" });
	});

	it("selects a manual transition and runs chained entered states until completion", async () => {
		const { api, commands, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		const registerFunctionHandler = eventHandlers.get("state-workflow:register-function-handler")?.[0];
		expect(registerWorkflow).toBeTypeOf("function");
		expect(registerFunctionHandler).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "approve", to: "formatter", trigger: "manual" }],
				},
				formatter: {
					id: "formatter",
					action: { kind: "function", handler: "formatter-handler" },
					transitions: [{ id: "formatter-ok", to: "linter", trigger: "success" }],
				},
				linter: {
					id: "linter",
					action: { kind: "function", handler: "linter-handler" },
					transitions: [{ id: "linter-ok", to: "done", trigger: "success" }],
				},
				done: {
					id: "done",
					action: { kind: "function", handler: "done-handler" },
					transitions: [],
				},
			},
		});
		registerFunctionHandler!({
			name: "done-handler",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});
		registerFunctionHandler!({
			name: "formatter-handler",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});
		registerFunctionHandler!({
			name: "linter-handler",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});

		const startHandler = commands.get("workflow-start");
		const nextHandler = commands.get("workflow-next");
		expect(startHandler).toBeTypeOf("function");
		expect(nextHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);
		await nextHandler!("approve", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Started workflow and entered manual transition wait state.",
			"info",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith("Selected transition approve", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow wf completed.", "info");
	});

	it("queues manual transition in workflow_next tool and applies it on tool_execution_end", async () => {
		const { api, commands, tools, eventHandlers, lifecycleHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		const registerFunctionHandler = eventHandlers.get("state-workflow:register-function-handler")?.[0];
		const toolHandler = tools.get(WORKFLOW_NEXT_TOOL);
		const toolEndHandlers = lifecycleHandlers.get("tool_execution_end");
		expect(registerWorkflow).toBeTypeOf("function");
		expect(registerFunctionHandler).toBeTypeOf("function");
		expect(toolHandler).toBeTypeOf("function");
		expect(toolEndHandlers?.length).toBeGreaterThan(0);

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "retry-linter", to: "linter", trigger: "manualOrAgent" }],
				},
				linter: {
					id: "linter",
					action: { kind: "function", handler: "linter-handler" },
					transitions: [{ id: "linter-ok", to: "done", trigger: "success" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});
		registerFunctionHandler!({
			name: "linter-handler",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});

		const startHandler = commands.get("workflow-start");
		expect(startHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);

		const toolResult = await toolHandler!("call-1", { transitionId: "retry-linter" }, undefined, undefined, ctx);
		expect(toolResult).toMatchObject({
			details: { queued: true, workflowId: "wf", transitionId: "retry-linter" },
		});
		expect(ctx.ui.notify).not.toHaveBeenCalledWith("Selected transition retry-linter", "info");

		for (const handler of toolEndHandlers ?? []) {
			await handler({ toolName: WORKFLOW_NEXT_TOOL, toolCallId: "call-1" }, ctx);
		}

		expect(ctx.ui.notify).toHaveBeenCalledWith("Selected agent transition retry-linter", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow wf completed.", "info");
	});

	it("keeps only the first queued workflow_next tool transition", async () => {
		const { api, commands, tools, eventHandlers, lifecycleHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		const registerFunctionHandler = eventHandlers.get("state-workflow:register-function-handler")?.[0];
		const toolHandler = tools.get(WORKFLOW_NEXT_TOOL);
		const toolEndHandlers = lifecycleHandlers.get("tool_execution_end");
		expect(registerWorkflow).toBeTypeOf("function");
		expect(registerFunctionHandler).toBeTypeOf("function");
		expect(toolHandler).toBeTypeOf("function");
		expect(toolEndHandlers?.length).toBeGreaterThan(0);

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [
						{ id: "retry-linter", to: "retry", trigger: "manualOrAgent" },
						{ id: "abort", to: "done", trigger: "manualOrAgent" },
					],
				},
				retry: {
					id: "retry",
					action: { kind: "function", handler: "retry-handler" },
					transitions: [{ id: "retry-ok", to: "done", trigger: "success" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});
		registerFunctionHandler!({
			name: "retry-handler",
			handler: vi.fn().mockResolvedValue({ ok: true }),
		});

		const startHandler = commands.get("workflow-start");
		expect(startHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);

		const firstResult = await toolHandler!("call-1", { transitionId: "retry-linter" }, undefined, undefined, ctx);
		const secondResult = await toolHandler!("call-2", { transitionId: "abort" }, undefined, undefined, ctx);

		expect(firstResult).toMatchObject({
			details: { queued: true, transitionId: "retry-linter" },
		});
		expect(secondResult).toMatchObject({
			details: {
				queued: false,
				reason: "TRANSITION_ALREADY_QUEUED",
				pendingTransitionId: "retry-linter",
			},
		});

		for (const handler of toolEndHandlers ?? []) {
			await handler({ toolName: WORKFLOW_NEXT_TOOL, toolCallId: "call-2" }, ctx);
		}
		expect(ctx.ui.notify).not.toHaveBeenCalledWith("Selected transition abort", "info");

		for (const handler of toolEndHandlers ?? []) {
			await handler({ toolName: WORKFLOW_NEXT_TOOL, toolCallId: "call-1" }, ctx);
		}

		expect(ctx.ui.notify).toHaveBeenCalledWith("Selected agent transition retry-linter", "info");
		expect(ctx.ui.notify).not.toHaveBeenCalledWith("Selected agent transition abort", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Workflow wf completed.", "info");
	});

	it("does not allow workflow_next tool to select manual-only transitions", async () => {
		const { api, commands, tools, eventHandlers, lifecycleHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		const toolHandler = tools.get(WORKFLOW_NEXT_TOOL);
		const toolEndHandlers = lifecycleHandlers.get("tool_execution_end");
		expect(registerWorkflow).toBeTypeOf("function");
		expect(toolHandler).toBeTypeOf("function");
		expect(toolEndHandlers?.length).toBeGreaterThan(0);

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "approve", to: "done", trigger: "manual" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});

		const startHandler = commands.get("workflow-start");
		expect(startHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);
		await toolHandler!("call-1", { transitionId: "approve" }, undefined, undefined, ctx);

		for (const handler of toolEndHandlers ?? []) {
			await handler({ toolName: WORKFLOW_NEXT_TOOL, toolCallId: "call-1" }, ctx);
		}

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			'Manual transition "approve" is not available in state "review"',
			"error",
		);
		expect(ctx.ui.notify).not.toHaveBeenCalledWith("Selected agent transition approve", "info");
	});

	it("shows workflow history from a command", async () => {
		const { api, commands, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		expect(registerWorkflow).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "approve", to: "done", trigger: "manual" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});

		const startHandler = commands.get("workflow-start");
		const nextHandler = commands.get("workflow-next");
		const historyHandler = commands.get("workflow-history");
		expect(startHandler).toBeTypeOf("function");
		expect(nextHandler).toBeTypeOf("function");
		expect(historyHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);
		await nextHandler!("approve", ctx);
		await historyHandler!("", ctx);

		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("History:\n- review | started="),
			"info",
		);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			expect.stringContaining("transition=approve"),
			"info",
		);
	});

	it("returns workflow history from a tool", async () => {
		const { api, commands, tools, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		const historyTool = tools.get(WORKFLOW_HISTORY_TOOL);
		expect(registerWorkflow).toBeTypeOf("function");
		expect(historyTool).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "approve", to: "done", trigger: "manual" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});

		const startHandler = commands.get("workflow-start");
		const nextHandler = commands.get("workflow-next");
		expect(startHandler).toBeTypeOf("function");
		expect(nextHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		await startHandler!("wf --run", ctx);
		await nextHandler!("approve", ctx);

		const result = await historyTool!("call-history", {}, undefined, undefined, ctx);
		expect(result).toMatchObject({
			details: {
				workflowId: "wf",
				status: "completed",
				currentStateId: null,
				history: [
					expect.objectContaining({ stateId: "review", transitionId: "approve" }),
					expect.objectContaining({ stateId: "done" }),
				],
			},
		});
	});

	it("does not touch the old ctx after dispatching a workflow userMessage", async () => {
		const { api, commands, eventHandlers } = createExtensionApiMock();
		stateWorkflowExtension(api);

		const registerWorkflow = eventHandlers.get("state-workflow:register-workflow")?.[0];
		expect(registerWorkflow).toBeTypeOf("function");

		registerWorkflow!({
			id: "wf",
			initialStateId: "review",
			states: {
				review: {
					id: "review",
					action: { kind: "continueSession" },
					transitions: [{ id: "approve", to: "ask-agent", trigger: "manual" }],
				},
				"ask-agent": {
					id: "ask-agent",
					action: { kind: "userMessage", content: "/reload-runtime" },
					transitions: [{ id: "queued", to: "done", trigger: "success" }],
				},
				done: {
					id: "done",
					action: { kind: "continueSession" },
					transitions: [],
				},
			},
		});

		const startHandler = commands.get("workflow-start");
		const nextHandler = commands.get("workflow-next");
		expect(startHandler).toBeTypeOf("function");
		expect(nextHandler).toBeTypeOf("function");

		const ctx = createCommandContext();
		api.sendUserMessage.mockImplementation(() => {
			ctx.ui.notify.mockImplementation(() => {
				throw new Error("stale ctx notify");
			});
			ctx.ui.setWidget.mockImplementation(() => {
				throw new Error("stale ctx widget");
			});
		});

		await startHandler!("wf --run", ctx);
		await expect(nextHandler!("approve", ctx)).resolves.toBeUndefined();
		expect(api.sendUserMessage).toHaveBeenCalledWith("/reload-runtime");
	});
});
