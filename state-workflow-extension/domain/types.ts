export type WorkflowId = string;
export type StateId = string;
export type TransitionId = string;
export type GuardName = string;

export type WorkflowTrigger = "success" | "error" | "always" | "manual";

export type WorkflowDefinition = {
	id: WorkflowId;
	title?: string;
	initialStateId: StateId;
	states: Record<StateId, WorkflowStateDefinition>;
};

export type WorkflowStateDefinition = {
	id: StateId;
	title?: string;
	action: WorkflowAction;
	transitions: WorkflowTransition[];
};

export type WorkflowAction =
	| {
			kind: "command";
			command: string;
			args?: string;
	  }
	| {
			kind: "userMessage";
			content: string;
			resultKey?: string;
	  }
	| {
			kind: "function";
			handler: string;
			input?: unknown;
	  }
	| {
			kind: "continueSession";
	  };

export type WorkflowTransition = {
	id: TransitionId;
	to: StateId;
	trigger: WorkflowTrigger;
	label?: string;
	guard?: GuardName;
	priority?: number;
};

export type WorkflowRunStatus = "idle" | "running" | "waitingManual" | "completed" | "failed";

export type WorkflowRunState = {
	workflowId: WorkflowId;
	currentStateId: StateId | null;
	status: WorkflowRunStatus;
	history: WorkflowHistoryEntry[];
	context: Record<string, unknown>;
	lastResult?: StateExecutionResult;
};

export type WorkflowHistoryEntry = {
	stateId: StateId;
	startedAt: number;
	finishedAt?: number;
	result?: "success" | "error";
	transitionId?: TransitionId;
};

export type CommandExecutionResult = {
	kind: "command";
	exitCode: number;
	stdout?: string;
	stderr?: string;
};

export type FunctionExecutionResult = {
	kind: "function";
	ok: boolean;
	output?: unknown;
	error?: {
		code: string;
		message: string;
	};
};

export type UserMessageExecutionResult = {
	kind: "userMessage";
	status: "success" | "error";
	output?: unknown;
	error?: {
		code: string;
		message: string;
	};
};

export type ContinueSessionExecutionResult = {
	kind: "continueSession";
	status: "success";
	output?: unknown;
};

export type RawExecutionResult =
	| CommandExecutionResult
	| FunctionExecutionResult
	| UserMessageExecutionResult
	| ContinueSessionExecutionResult;

export type StateExecutionResult = {
	outcome: "success" | "error";
	raw: RawExecutionResult;
	output?: unknown;
	error?: {
		code: string;
		message: string;
	};
};

export type GuardContext = {
	run: WorkflowRunState;
	result: StateExecutionResult;
	state: WorkflowStateDefinition;
};

export type GuardFn = (ctx: GuardContext) => boolean;
export type GuardRegistry = Record<GuardName, GuardFn>;

export type ResolveTransitionInput = {
	state: WorkflowStateDefinition;
	run: WorkflowRunState;
	result: StateExecutionResult;
	guards: GuardRegistry;
};

export type ResolveTransitionResult =
	| {
			kind: "transition";
			transition: WorkflowTransition;
			nextStateId: StateId;
	  }
	| {
			kind: "manual";
			candidates: WorkflowTransition[];
	  }
	| {
			kind: "complete";
	  };

export type WorkflowAdvanceResult =
	| {
			kind: "advanced";
			run: WorkflowRunState;
			nextStateId: StateId;
			transitionId: TransitionId;
	  }
	| {
			kind: "waitingManual";
			run: WorkflowRunState;
			candidates: WorkflowTransition[];
	  }
	| {
			kind: "completed";
			run: WorkflowRunState;
	  };

export type ActionExecutionRequest = {
	workflowId: WorkflowId;
	state: WorkflowStateDefinition;
	run: WorkflowRunState;
};

export type ActionExecutor = {
	execute: (request: ActionExecutionRequest) => Promise<RawExecutionResult>;
};

export type WorkflowValidationIssue = {
	level: "error" | "warning";
	code:
		| "UNKNOWN_INITIAL_STATE"
		| "UNKNOWN_TRANSITION_TARGET"
		| "DUPLICATE_TRANSITION_ID"
		| "UNREACHABLE_STATE";
	message: string;
};

export type WorkflowRunSnapshot = {
	version: 1;
	run: WorkflowRunState;
};

export type WorkflowRegistrationResult =
	| {
			ok: true;
			workflow: WorkflowDefinition;
	  }
	| {
			ok: false;
			workflow: WorkflowDefinition;
			issues: WorkflowValidationIssue[];
	  };

export type WorkflowRegistry = {
	register: (workflow: WorkflowDefinition) => WorkflowRegistrationResult;
	unregister: (workflowId: WorkflowId) => boolean;
	get: (workflowId: WorkflowId) => WorkflowDefinition | undefined;
	list: () => WorkflowDefinition[];
};

export type WorkflowRunStore = {
	load: (workflowId: WorkflowId) => Promise<WorkflowRunState | null>;
	save: (run: WorkflowRunState) => Promise<void>;
	clear: (workflowId: WorkflowId) => Promise<void>;
};

export type WorkflowPresenter = {
	render: (run: WorkflowRunState, workflow: WorkflowDefinition) => Promise<void>;
	clear: (workflowId: WorkflowId) => Promise<void>;
	chooseTransition: (
		run: WorkflowRunState,
		transitions: WorkflowTransition[],
	) => Promise<TransitionId | null>;
};

export type WorkflowService = {
	register: (workflow: WorkflowDefinition) => WorkflowRegistrationResult;
	unregister: (workflowId: WorkflowId) => Promise<boolean>;
	start: (workflowId: WorkflowId, now: number) => Promise<WorkflowRunState>;
	runNext: (workflowId: WorkflowId, now: number) => Promise<WorkflowAdvanceResult>;
	chooseManual: (workflowId: WorkflowId, transitionId: TransitionId, now: number) => Promise<WorkflowRunState>;
	getRun: (workflowId: WorkflowId) => Promise<WorkflowRunState | null>;
};
