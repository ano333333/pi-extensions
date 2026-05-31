# ADR 002: ステート遷移判定とテスト容易性を優先した type + object 設計

- Status: proposed
- Date: 2026-05-31

## Context

`state-workflow-extension` では、ステート遷移の実装を Pi 依存から分離し、単体テストしやすい形にしたい。

特に以下を明確にする必要がある。

- `success | error | always | manual` をどう判定するか
- action 実行結果をどう遷移判定に渡すか
- 実行部分をモック化し、exit code ベースの遷移を単体テストに含められるか
- TypeScript では class / interface より `type` と関数オブジェクト中心で設計したい

## Decision

遷移判定は以下の 2 段階で行う。

1. **action 実行結果を正規化して outcome を決める**
2. **outcome と transition 定義から次遷移を解決する**

この 2 つを分離することで、

- action 実行の差異（command / function / userMessage）
- exit code や例外などの差異
- Pi 連携の有無

を切り離してテストできるようにする。

## Trigger semantics

### `success`

action の正規化結果 `outcome === "success"` のとき成立する。

典型例:

- `command`: `exitCode === 0`
- `function`: 例外を投げずに `{ outcome: "success" }` を返した
- `userMessage`: 明示的な完了フックまたはクライアント定義の result mapper が success を返した

### `error`

action の正規化結果 `outcome === "error"` のとき成立する。

典型例:

- `command`: `exitCode !== 0`
- `function`: 例外を投げた
- `function`: `{ outcome: "error" }` を返した
- `userMessage`: result mapper が error を返した

### `always`

`success` / `error` に関係なく候補になる fallback 遷移。

- 同じ優先度で `success` または `error` の適合遷移があればそちらを優先
- 適合遷移がなければ `always` を採用

### `manual`

自動では遷移しない。

- 自動遷移候補がなければ `manual` 候補群を返し、UI または command が選択する
- `manual` は resolver が明示的に `waitingManual` を返す

## Core types

```ts
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
    };

export type WorkflowTransition = {
  id: TransitionId;
  to: StateId;
  trigger: WorkflowTrigger;
  label?: string;
  guard?: GuardName;
  priority?: number;
};
```

## Runtime types

```ts
export type WorkflowRunStatus =
  | "idle"
  | "running"
  | "waitingManual"
  | "completed"
  | "failed";

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
```

## Execution result types

action 実行の生結果と、遷移判定用の正規化結果を分ける。

```ts
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

export type RawExecutionResult =
  | CommandExecutionResult
  | FunctionExecutionResult
  | UserMessageExecutionResult;

export type StateExecutionResult = {
  outcome: "success" | "error";
  raw: RawExecutionResult;
  output?: unknown;
  error?: {
    code: string;
    message: string;
  };
};
```

## Outcome normalization

`success | error` の判定は、まず normalizer で一元化する。

```ts
export type NormalizeExecutionResult = (
  raw: RawExecutionResult,
) => StateExecutionResult;

export const normalizeExecutionResult: NormalizeExecutionResult = (raw) => {
  if (raw.kind === "command") {
    return raw.exitCode === 0
      ? { outcome: "success", raw, output: raw.stdout }
      : {
          outcome: "error",
          raw,
          error: {
            code: `EXIT_${raw.exitCode}`,
            message: raw.stderr ?? `Command failed with exit code ${raw.exitCode}`,
          },
        };
  }

  if (raw.kind === "function") {
    return raw.ok
      ? { outcome: "success", raw, output: raw.output }
      : {
          outcome: "error",
          raw,
          error: raw.error ?? { code: "FUNCTION_ERROR", message: "Function action failed" },
        };
  }

  return raw.status === "success"
    ? { outcome: "success", raw, output: raw.output }
    : {
        outcome: "error",
        raw,
        error: raw.error ?? { code: "USER_MESSAGE_ERROR", message: "User message action failed" },
      };
};
```

## Transition resolver design

class ではなく pure function 群で持つ。

```ts
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
```

優先順位は次のとおり。

1. `result.outcome` に一致する遷移 (`success` or `error`)
2. `always`
3. `manual`
4. 遷移なしなら `complete`

```ts
export const resolveTransition = (
  input: ResolveTransitionInput,
): ResolveTransitionResult => {
  const { state, run, result, guards } = input;
  const sorted = [...state.transitions].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

  const guardPasses = (transition: WorkflowTransition): boolean => {
    if (!transition.guard) return true;
    const guard = guards[transition.guard];
    return guard ? guard({ run, result, state }) : false;
  };

  const byTrigger = (trigger: WorkflowTrigger) =>
    sorted.filter((transition) => transition.trigger === trigger && guardPasses(transition));

  const direct = byTrigger(result.outcome);
  if (direct[0]) {
    return {
      kind: "transition",
      transition: direct[0],
      nextStateId: direct[0].to,
    };
  }

  const always = byTrigger("always");
  if (always[0]) {
    return {
      kind: "transition",
      transition: always[0],
      nextStateId: always[0].to,
    };
  }

  const manual = byTrigger("manual");
  if (manual.length > 0) {
    return {
      kind: "manual",
      candidates: manual,
    };
  }

  return { kind: "complete" };
};
```

## Runtime advancement design

runtime も object + pure function に寄せる。

```ts
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
```

```ts
export const createInitialRunState = (
  definition: WorkflowDefinition,
  now: number,
): WorkflowRunState => ({
  workflowId: definition.id,
  currentStateId: definition.initialStateId,
  status: "idle",
  history: [
    {
      stateId: definition.initialStateId,
      startedAt: now,
    },
  ],
  context: {},
});
```

```ts
export const applyExecutionResult = (
  run: WorkflowRunState,
  state: WorkflowStateDefinition,
  result: StateExecutionResult,
  resolution: ResolveTransitionResult,
  now: number,
): WorkflowAdvanceResult => {
  const history = [...run.history];
  const last = history[history.length - 1];
  history[history.length - 1] = {
    ...last,
    finishedAt: now,
    result: result.outcome,
  };

  const baseRun: WorkflowRunState = {
    ...run,
    history,
    lastResult: result,
  };

  if (resolution.kind === "transition") {
    const nextRun: WorkflowRunState = {
      ...baseRun,
      currentStateId: resolution.nextStateId,
      status: "idle",
      history: [
        ...baseRun.history.slice(0, -1),
        {
          ...baseRun.history[baseRun.history.length - 1],
          transitionId: resolution.transition.id,
        },
        {
          stateId: resolution.nextStateId,
          startedAt: now,
        },
      ],
    };

    return {
      kind: "advanced",
      run: nextRun,
      nextStateId: resolution.nextStateId,
      transitionId: resolution.transition.id,
    };
  }

  if (resolution.kind === "manual") {
    return {
      kind: "waitingManual",
      run: {
        ...baseRun,
        status: "waitingManual",
      },
      candidates: resolution.candidates,
    };
  }

  return {
    kind: "completed",
    run: {
      ...baseRun,
      currentStateId: null,
      status: "completed",
    },
  };
};
```

## Executor abstraction

実行部分はモック化できる object にする。

```ts
export type ActionExecutionRequest = {
  workflowId: WorkflowId;
  state: WorkflowStateDefinition;
  run: WorkflowRunState;
};

export type ActionExecutor = {
  execute: (request: ActionExecutionRequest) => Promise<RawExecutionResult>;
};
```

Pi 連携 executor は adapter 層で実装する。
単体テストでは fake executor を使う。

```ts
export const createFakeExecutor = (
  table: Record<StateId, RawExecutionResult>,
): ActionExecutor => ({
  execute: async ({ state }) => table[state.id],
});
```

## Test strategy

### 1. 遷移判定の単体テスト

対象:

- `normalizeExecutionResult`
- `resolveTransition`
- `applyExecutionResult`

Pi 依存なし。

### 2. 実行モック込みの engine 単体テスト

対象:

- fake executor が返す `exitCode` に応じて遷移するか
- success branch / error branch / always fallback / manual wait

### 3. Pi adapter の結合テスト

対象:

- widget 更新
- `appendEntry()` 永続化
- command 起動

## Required unit test cases

### `normalizeExecutionResult`

- `command.exitCode === 0` -> `success`
- `command.exitCode === 1` -> `error`
- `function.ok === true` -> `success`
- `function.ok === false` -> `error`

### `resolveTransition`

- success で `success` 遷移を選ぶ
- error で `error` 遷移を選ぶ
- success/error がなく `always` を選ぶ
- 自動遷移がなく `manual` を返す
- guard false なら候補から落ちる
- 何もなければ `complete`

### engine 単体テスト（fake executor 使用）

#### success branch

```ts
const workflow: WorkflowDefinition = {
  id: "wf",
  initialStateId: "build",
  states: {
    build: {
      id: "build",
      action: { kind: "command", command: "build" },
      transitions: [
        { id: "t1", to: "test", trigger: "success" },
        { id: "t2", to: "retry", trigger: "error" },
      ],
    },
    test: { id: "test", action: { kind: "function", handler: "noop" }, transitions: [] },
    retry: { id: "retry", action: { kind: "function", handler: "noop" }, transitions: [] },
  },
};

const executor = createFakeExecutor({
  build: { kind: "command", exitCode: 0, stdout: "ok" },
});
```

期待:

- `normalizeExecutionResult()` が `success`
- `resolveTransition()` が `t1`
- 次 state は `test`

#### error branch

```ts
const executor = createFakeExecutor({
  build: { kind: "command", exitCode: 2, stderr: "failed" },
});
```

期待:

- `normalizeExecutionResult()` が `error`
- `resolveTransition()` が `t2`
- 次 state は `retry`

#### always fallback

`success` / `error` 遷移なしで `always` のみ定義し、exit code が 0 でも 1 でも `always` が選ばれること。

#### manual wait

`manual` のみ定義し、executor の結果に関係なく `waitingManual` へ入ること。

## Consequences

### 利点

- exit code ベースの遷移を pure function でテストできる
- command / function / userMessage の差異を normalizer に閉じ込められる
- class ベースにせず、`type` と関数 object で composable に保てる
- Pi adapter を外して engine 単体テストを書ける

### 欠点

- `userMessage` の success/error 判定は別途 result mapper や completion contract が必要
- pure function を分割しすぎると結線コードはやや増える

## Follow-up

実装では少なくとも以下のファイル分割を推奨する。

- `types.ts` - workflow / runtime / result 型
- `normalize.ts` - raw result -> normalized result
- `resolve-transition.ts` - trigger 解決
- `runtime.ts` - run state 進行
- `executor.ts` - executor type と fake executor
- `pi-adapter.ts` - Pi 連携
- `*.test.ts` - pure function と fake executor ベースの単体テスト
