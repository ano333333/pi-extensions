# ADR 001: state-workflow-extension ベースの実現可能性と API 設計

- Status: proposed
- Date: 2026-05-31

## Context

Pi でステートマシン型ワークフローを扱うベース拡張機能を作りたい。

この ADR では、以下を満たせるかを docs ベースで整理する。

- ベース拡張機能を `state-workflow-extension` とする
- それを利用する拡張機能をクライアントとする
- クライアントはツールや状態定義を登録する
- ベースは状態を実行し、通常セッションに近い形で進行を表示する
- `belowEditor` に現在状態と次の遷移可能性を表示する

参照した主な docs / examples:

- `docs/extensions.md`
- `docs/tui.md`
- `docs/session-format.md`
- `examples/extensions/widget-placement.ts`
- `examples/extensions/dynamic-tools.ts`
- `examples/extensions/send-user-message.ts`
- `examples/extensions/plan-mode/`

## Findings

### 1. クライアントによるツール登録は可能

`pi.registerTool()` は動的登録に対応している。起動時だけでなく `session_start` や command / event handler からも登録できる。

これはクライアント側が、自分専用ツールを適宜追加する設計と整合する。

### 2. クライアントによる状態登録も可能

Pi に「workflow state」専用 API はないが、拡張機能間通信と拡張内メモリで十分構成できる。

使える要素:

- `pi.events.on / emit` によるクライアント→ベース通知
- 同一 package / import による直接登録
- `pi.appendEntry()` による永続化
- `session_start` での復元

### 3. `belowEditor` 表示は可能

`ctx.ui.setWidget(id, widget, { placement: "belowEditor" })` がある。

したがって、現在 state と遷移候補の常時表示は実現可能。

### 4. 通常セッション風の進行表示は部分的に可能

以下を組み合わせると、通常セッションにかなり近い見え方を作れる。

- `pi.sendUserMessage()` でユーザーメッセージとして投入
- `pi.sendMessage()` でカスタム進行メッセージを差し込み
- `before_agent_start`, `turn_*`, `message_*`, `tool_*` で進捗観測

ただし、ベースが Pi の内部エージェントループそのものを差し替えるわけではない。
そのため「完全に独自の実行ランタイムを Pi 標準メッセージとして自然に見せる」より、
「Pi の既存セッション機構に寄り添って見せる」方向が現実的である。

## Key constraint

## ベースから任意ツールを直接呼ぶ API は docs 上確認できない

確認できたのは主に以下:

- `pi.registerTool()`
- `pi.exec()`
- `pi.sendMessage()`
- `pi.sendUserMessage()`
- `ctx.newSession() / fork() / switchSession()`（command context）

一方で、以下のような API は docs 上見当たらない。

- `pi.callTool(name, args)`
- `ctx.invokeTool(name, args)`

このため、ベースが「クライアントが登録した任意ツールを deterministic に直接実行する汎用ランナー」になる設計は弱い。

## Decision

`state-workflow-extension` の state action は、docs 上確実に扱える実行単位へ寄せる。

### サポート対象 action

1. `command`
   - ベースまたはクライアントが登録した slash command を起点に実行する
   - deterministic

2. `userMessage`
   - `pi.sendUserMessage()` で agent に実行させる
   - 通常セッション表示に最も近い
   - deterministic ではない

3. `function`
   - クライアントが純 TypeScript handler を登録し、ベースが直接呼ぶ
   - deterministic

### 非推奨の action

4. `tool`
   - クライアントが登録済みの Pi tool をベースが直接呼ぶことは、現時点 docs ベースでは前提にしない
   - 必要なら「共有関数を tool と function の両方から使う」設計で吸収する

## Proposed API

以下は初版のベース API 案である。

### クライアント登録 API

```ts
export type WorkflowAction =
  | {
      kind: "command";
      command: string; // 先頭の / は任意
      args?: string;
    }
  | {
      kind: "userMessage";
      content: string;
      deliverAs?: "steer" | "followUp";
    }
  | {
      kind: "function";
      handler: string;
      input?: unknown;
    };

export type WorkflowTransition = {
  to: string;
  label?: string;
  when?: "success" | "error" | "always" | "manual";
  if?: string; // 将来的な condition key
};

export type WorkflowStateDefinition = {
  id: string;
  title?: string;
  description?: string;
  action: WorkflowAction;
  transitions?: WorkflowTransition[];
};

export type WorkflowDefinition = {
  id: string;
  title?: string;
  initialStateId: string;
  states: WorkflowStateDefinition[];
};
```

クライアントは概念的に以下のいずれかで登録する。

```ts
registerWorkflow(definition)
registerWorkflowHandler(name, fn)
```

または extension 間 event bus を使うなら:

```ts
pi.events.emit("state-workflow:register", definition)
pi.events.emit("state-workflow:register-handler", { name, fn })
```

実装時は event bus よりも、共通モジュール import のほうが型安全で扱いやすい可能性が高い。

## Execution model

### 1. workflow 実行開始

ベース command 例:

- `/workflow:list`
- `/workflow:start <id>`
- `/workflow:next`
- `/workflow:goto <stateId>`
- `/workflow:abort`

### 2. state 実行

ベースは current state を見て action を dispatch する。

- `command`: 対応 command を起動
- `userMessage`: `pi.sendUserMessage()` を送る
- `function`: 登録済み handler を呼ぶ

### 3. state 完了と遷移決定

最初は単純化して、以下だけを扱う。

- 成功時の自動遷移
- 失敗時の自動遷移
- 手動選択遷移

### 4. UI 更新

常に widget を更新し、最低限以下を表示する。

- workflow 名
- 現在 state
- 実行状態（idle / running / waiting / failed / completed）
- 次の遷移候補

表示例:

```txt
Workflow: release-flow
Current: build
Status: running
Next:
- test (on success)
- retry-build (on error)
- abort (manual)
```

## Persistence model

Pi の `custom` entry を使って workflow runtime state を保存する。

保存対象例:

```ts
{
  workflowId: string,
  currentStateId: string,
  status: "idle" | "running" | "waiting" | "failed" | "completed",
  history: Array<{
    stateId: string,
    startedAt: number,
    finishedAt?: number,
    result?: "success" | "error"
  }>
}
```

復元は `session_start` で行う。

## Session actions

### session 開始 / 切替 / fork を state として扱う案

Pi docs 上、`newSession`, `switchSession`, `fork` は command context で扱う前提である。
そのため、これらは通常の event handler や generic runtime から無制限に呼ぶ前提にはしない。

初版方針:

- session 系 action は `command` action の内部で扱う
- つまり「state が session 操作を直接持つ」のではなく、「その state で呼ぶ command が session を切り替える」方式を採る

必要なら将来以下を追加する。

```ts
{ kind: "command", command: "workflow-internal:new-session", args: "..." }
```

## Recommended client patterns

### パターン A: deterministic な処理

- `function` action を使う
- 必要なら同じロジックを tool 側からも再利用する

### パターン B: LLM 主導で進めたい処理

- `userMessage` action を使う
- 通常セッション表示との親和性が高い

### パターン C: session 制御を含む処理

- `command` action を使う
- command handler 側で `newSession` / `switchSession` / `fork` を行う

## Consequences

### 利点

- docs 上確認できる API のみで構成できる
- widget と session persistence を自然に使える
- deterministic / agentic の両方を混在できる
- 将来、Pi 側に tool invocation API が増えても拡張しやすい

### 欠点

- 「tool を state action として直接呼ぶ」モデルは初版では弱い
- `userMessage` action は LLM 依存で結果が不安定になりうる
- session 操作は command context に寄せる必要がある

## Initial implementation scope

初版は以下に絞る。

- workflow / state / transition の登録
- `function`, `command`, `userMessage` action の実装
- `belowEditor` widget 表示
- `appendEntry()` による状態永続化
- `/workflow:start`, `/workflow:next`, `/workflow:goto`, `/workflow:abort`

初版では見送るもの:

- tool action の直接呼び出し
- 複雑な guard expression evaluator
- 並列 state 実行
- 階層ステートマシン
- session action の専用 DSL

## Follow-up

次のステップとしては、以下を実施する。

1. ベース拡張の最小 skeleton を作る
2. workflow registry と runtime state を定義する
3. widget renderer を実装する
4. client 用の登録 API を確定する
5. `function` / `command` / `userMessage` の 3 action を通す
