# ADR 003: `/workflow-next` を manual transition 選択コマンドへ統合する

- Status: proposed
- Date: 2026-06-05

## Context

現行実装では次の 2 コマンドがある。

- `/workflow-next`
- `/workflow-choose <transitionId>`

しかし現在の実装上、`/workflow-next` は現在 state の action を実行したうえで、manual transition 待ちになった場合はその場で候補選択 UI を開き、選択後に遷移先 state の action まで続けて実行している。

同時に `/workflow-choose <transitionId>` も、manual transition を選択したあとに遷移先 state の action を続けて実行している。

このため両者の責務が重複し、差異が不明瞭になっている。

また、state に設定された処理は「その state に遷移したタイミングで自動的に実行される」前提で扱いたい。
この前提では「現在 state を明示的に 1 回進めるだけ」の `/workflow-next` は不要であり、必要なのは manual transition を確定する操作だけである。

## Decision

以下を採用する。

1. 現行の `/workflow-next` を削除する
2. 現行の `/workflow-choose <transitionId>` を `/workflow-next <transitionId>` にリネームする
3. manual transition を選択したあとは、base extension が遷移先 state の action を続けて実行する現在の挙動を維持する
4. `workflow-start --run` と manual transition 選択後の自動実行は、`waitingManual` または `completed` に当たるまで連鎖実行する
5. `manual` は手動専用 transition として維持し、AI と手動の両方で選択可能な新 trigger `manualOrAgent` を追加する
6. AI agent 向けに `workflow_next` tool を登録し、`manualOrAgent` transition のみを選択可能にする
7. `workflow_next` tool は execute 中には遷移せず、先勝ちで pending transition フラグだけを立て、`tool_execution_end` で実際の遷移と連鎖実行を行う

## Consequences

### Benefits

- コマンド責務が 1 つにまとまり、manual transition の操作経路が明確になる
- `/workflow-next` という名前を残しつつ、実際の責務を manual transition の確定に寄せられる
- 現在の runtime 実装を大きく変えずに、不要なコマンドだけを除去できる
- function / command / continueSession の success 連鎖で、複数 state をまたいだ自動実行ができる
- 手動専用 transition を残したまま、一部の transition だけを AI に開放できる
- tool 実行中の再入を避けつつ、turn 終了直前に deterministic に workflow を再開できる

### Costs

- `/workflow-next` の意味が「現在 state を実行する」から「manual transition を選んで先へ進める」へ変わる
- 既存利用者が旧仕様を前提にしている場合、コマンドの意味変更を周知する必要がある
- 自動遷移だけで閉じた cycle を作ると、manual または completed に到達するまで実行が続く
- 同一 turn 内で `workflow_next` が複数回呼ばれた場合、どの transition を採用するかのルールが必要になる
- client は `manual` と `manualOrAgent` の使い分けを明示的に設計する必要がある

## Notes

この ADR は command surface の整理を起点にした extension 挙動の整理に限定する。
state entered 時の自動実行そのものを domain service の API にどう昇格するかは別途整理対象とする。
`workflow_next` tool の pending transition は先勝ちとし、同一 turn 内の後続呼び出しは無視する。
`workflow_next` からは `manual` transition を選べない。
