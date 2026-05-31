# state-workflow-extension

Pi でステートマシン型ワークフローを扱うためのベース拡張機能。

- ADR: `adrs/001-base-feasibility-and-api-design.md`
- Entry point: `index.ts`
- Example clients: `examples/basic-client.ts`, `examples/shiritori-client.ts`

## Client registration

client は base extension のコードを import せず、`pi.events.emit(...)` を直接呼んで登録します。

イベント名は文字列契約です。

- workflow 登録: `"state-workflow:register-workflow"`
- function handler 登録: `"state-workflow:register-function-handler"`

`examples/` には、base extension へのコード依存なしで動く standalone client 例を置いています。

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
  trigger: "success" | "error" | "always" | "manual";
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

## Commands

- `/workflow-list`
- `/workflow-start <id>`
- `/workflow-next`
- `/workflow-choose <transitionId>`
- `/workflow-status`
- `/workflow-abort`
