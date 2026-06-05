# ADR 004: workflow history 公開と `/workflow-next` の暗黙選択

- Status: proposed
- Date: 2026-06-05

## Context

`state-workflow-extension` は内部的に `WorkflowRunState.history` を保持しており、
各 state 実行の開始時刻、終了時刻、result、採用された transitionId は永続化されている。

一方で現状の公開 surface では、この履歴を人間も AI agent も直接参照できない。

また `/workflow-next` は常に `transitionId` 引数を要求しているため、

- 候補が 1 つしかないケースでも毎回 ID 入力が必要
- 候補が複数あるケースでも、ユーザーは事前に `/workflow-status` などで候補を確認してから ID を再入力する必要がある

という摩擦がある。

Pi extension API では `ctx.ui.select()` を使った選択 UI と、`pi.registerTool()` を使った agent 向け公開面の両方を提供できる。

## Decision

以下を採用する。

1. workflow 実行履歴は既存の `WorkflowRunState.history` を正式なログとみなし、新たな event log は導入しない
2. 人間向けには `/workflow-history [workflowId]` コマンドを追加し、現在までの state 遷移履歴を表示する
3. AI agent 向けには `workflow_history({ workflowId? })` tool を追加し、同じ履歴を text と structured details の両方で返す
4. `/workflow-next` は `transitionId` 引数を省略可能にする
5. 引数省略時の挙動は次の通りとする
   - 候補 0 件: 警告して何もしない
   - 候補 1 件: その transition を自動選択する
   - 候補 2 件以上: `ctx.ui.select()` で候補選択 UI を開く
6. AI agent 向けの `workflow_next` tool は従来どおり明示 `transitionId` 必須のままとし、自動選択は行わない

## Consequences

### Benefits

- 既存の永続化済みデータをそのまま可視化でき、追加の保存機構が不要
- agent が workflow の直前の経路を見てから次の判断を行える
- 候補 1 件の manual transition で余計な入力が不要になる
- 候補複数時も status 出力を目視して ID を打ち直す必要がなくなる
- `workflow_next` tool の安全性は維持され、agent 側は常に明示的な transitionId を選ぶ

### Costs

- `history` は state 実行単位のログであり、「選択 UI を開いたがキャンセルした」などの UI event は記録されない
- `/workflow-next` の UX が改善される一方、引数必須という単純な契約ではなくなる
- 複数候補 UI は `ctx.hasUI` に依存するため、非対話環境では引数省略時に完結しない場合がある

## Notes

manual 遷移候補は run state に別保存せず、`waitingManual` 中の `currentStateId` から毎回再計算する。
これにより persistence schema は変更しない。
