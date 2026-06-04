# state-workflow-extension

Pi でステートマシン型ワークフローを扱うためのベース拡張機能。

- ADR: `adrs/001-base-feasibility-and-api-design.md`
- Entry point: `index.ts`
- Example clients:
  - `examples/basic-client.ts`
  - `examples/shiritori-client.ts`
  - `examples/manual-review-client.ts`
  - `examples/agent-retry-client.ts`

## Client registration

client は base extension のコードを import せず、`pi.events.emit(...)` を直接呼んで登録します。

イベント名は文字列契約です。

- workflow 登録: `"state-workflow:register-workflow"`
- function handler 登録: `"state-workflow:register-function-handler"`

`examples/` には、base extension へのコード依存なしで動く standalone client 例を置いています。

- `basic-client.ts`: 最小構成の success 連鎖
- `shiritori-client.ts`: `manual` による人手チェック
- `manual-review-client.ts`: `manual` のみを使う手動承認フロー
- `agent-retry-client.ts`: `manualOrAgent` と `workflow_next` を使う AI 再試行フロー

client は base より先に load される可能性があるため、examples では登録 event を extension load 時だけでなく `session_start` でも再送しています。

## Client contract

base extension と client extension の間の契約は、現状次の 3 つの event と payload です。

### 1. workflow 登録 event

Event name:

```ts
"state-workflow:register-workflow"
```

Payload shape:

```ts
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
  states: Record<string, {
    id: string;
    title?: string;
    action: ClientWorkflowAction;
    transitions: WorkflowTransition[];
  }>;
};
```

### 2. function handler 登録 event

Event name:

```ts
"state-workflow:register-function-handler"
```

Payload shape:

```ts
type WorkflowSessionSnapshot = {
  entries: unknown[];
  leafId: string | null;
  sessionFile?: string;
};

type WorkflowFunctionContext = {
  run: unknown;
  session: WorkflowSessionSnapshot;
};

type RegisterFunctionHandlerPayload = {
  name: string;
  handler: (input: unknown, context: WorkflowFunctionContext) => Promise<unknown> | unknown;
};
```

### 3. workflow 起動 event

Event name:

```ts
"state-workflow:start-workflow"
```

Payload shape:

```ts
type StartWorkflowPayload = {
  workflowId: string;
  autoRun?: boolean;
  ctx: unknown;
};
```

これは client command から base workflow を起動したいときのための補助契約です。
`ctx` には command handler が受け取る context をそのまま渡します。

### Compatibility note

client は base extension の TypeScript を import しない前提です。
そのため、上記の event 名と payload shape を client 側でローカル定義して使ってください。
base 側の契約を変える場合は、この README と standalone examples を同時に更新してください。

## Public client API

公開 API でサポートする state action は次の 3 つです。

- `function`
- `userMessage`
- `continueSession`

## Function handler context

client が登録する function handler には第 2 引数として read-only な session snapshot が渡されます。

- `context.run`
- `context.session.entries`
- `context.session.leafId`
- `context.session.sessionFile`

`ctx.sessionManager` そのものではなく、読み取り用 snapshot です。

## Current userMessage semantics

`userMessage` は base extension から `pi.sendUserMessage()` を呼び、
**送信に成功したら success** とみなします。

つまり、現時点では **LLM の最終応答内容で success / error を判定するのではなく、
メッセージを正常 dispatch できたかどうか** を判定基準にしています。

## continueSession semantics

`continueSession` は **新しいユーザーメッセージを送らず**、
その state を success として完了させる no-op action です。

しりとりのように、既存セッションの会話継続中に workflow 上は待機し、
後で manual transition で検査 state へ進みたいケースを想定しています。

manual transition を選んだあとは、base extension が遷移先 state の action を続けて実行します。
そのため、検査用 state を manual 遷移先に置くと「選択 → 即チェック」の流れにできます。

transition trigger の意味:

- `manual`: 手動の `/workflow-next <transitionId>` でのみ選択可能
- `manualOrAgent`: `/workflow-next <transitionId>` と `workflow_next({ transitionId })` の両方で選択可能

## Auto-run semantics

state action の実行後に `success` / `error` / `always` で次 state が自動決定された場合、
base extension は **manual transition 待ち (`waitingManual`) または workflow 完了 (`completed`) に当たるまで**
次 state の action を連鎖実行します。

たとえば `function` action の formatter が成功し、`trigger: "success"` で linter に遷移する場合、
formatter 実行後に linter state へ進むだけでなく、linter の action もそのまま続けて実行されます。

## AI-triggered selectable transitions

base extension は AI agent 向けに `workflow_next` tool も登録します。
これは `trigger: "manualOrAgent"` の transition を確定するための tool です。
`trigger: "manual"` の transition は AI からは選べません。

想定フロー:

1. `userMessage` state で agent に「修正が終わったら `workflow_next` を `transitionId` 付きで呼ぶ」と指示する
2. agent が通常の編集・確認 tool を実行する
3. agent が最後に `workflow_next` を呼ぶ
4. base extension が `tool_execution_end` で `manualOrAgent` transition を適用し、遷移先 state から再び auto-run する

`workflow_next` tool は execute 中には遷移を実行しません。
同一 turn 中の再入を避けるため、**先勝ちで pending transition フラグだけを立て**、
実際の遷移は `tool_execution_end` で行います。

## Commands

- `/workflow-list`
- `/workflow-start <id>`
- `/workflow-next <transitionId>`
- `/workflow-status`
- `/workflow-abort`

## Tools

- `workflow_next({ transitionId })`
