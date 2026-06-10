# 仕様書: commit-assistant-client (state-workflow-extension クライアント例)

state-workflow-extension を「利用する側」の簡易な拡張機能の例として、
**コミットメッセージ・アシスタント** クライアントを新規作成する。

この仕様書は単体で完結しており、実装者は本書と「参考ファイル」節に挙げたファイルだけを参照すれば実装できる。

## 1. 概要

`/commit-assistant` コマンドで起動するステートマシン型ワークフロー。
working tree がクリーンになるまで「起案 → 人間レビュー → (workflow がコミット実行) → 再検査」を繰り返し、
**複数コミット** に分けて積んでいく運用を支援する。

1. 未コミットの変更があるか `git status` で検査する(`function` action)。クリーンならその時点で完了へ
2. 変更があれば、AI agent に「変更内容を確認し、次の 1 コミット分を stage して、Conventional Commits 形式のメッセージ案を提示し、同じメッセージを `.git/COMMIT_ASSISTANT_MSG` に書き込め」と指示する(`userMessage` action)。agent は提案を出し終えたら `workflow_next` tool で次へ進める(`manualOrAgent` transition)
3. 人間が会話上で提案をレビューし、承認するなら `/workflow-next approve-commit` で `commit` state へ進める。提案をやり直させたい場合は `/workflow-next revise`(`continueSession` action + `manual` transitions)
4. `commit` state の function action が **実際に `git commit` を実行する**(stage 済みの変更を `.git/COMMIT_ASSISTANT_MSG` のメッセージでコミット)。成功したら再検査へ戻り、失敗したら `review` に戻って人間の判断を待つ
5. 再検査(`check-changes`)で変更が残っていれば 2 に戻り、クリーンになっていればコミット回数などのサマリを記録して完了する

**コミットの実行主体は workflow(`commit` state の function action)のみ**。
AI agent は stage(`git add`)とメッセージ起案まで行ってよいが、`git commit` は実行しない。
人間の manual 承認(`approve-commit`)を経ない限りコミットという副作用が発生しない構造にする。

設計上のポイント:

- 3 種類の state action(`function` / `userMessage` / `continueSession`)をすべて使う
- trigger は `success` / `error` / `manualOrAgent` / `manual` を使う
- AI は「起案完了」(`manualOrAgent`)は自分で宣言できるが、「承認してコミット」「再起案」(`manual`)は人間しか選べない、という権限分離をデモする
- 副作用(`git commit`)を manual 遷移の先の function action に置くことで、「人間が承認しない限り副作用が起きない」パターンをデモする
- ループ(commit → check-changes)を持つ workflow の例になっている
- 既存 examples(basic / shiritori / manual-review / agent-retry)とは題材・構成が重複しない

## 2. 成果物

| 操作 | ファイル |
| --- | --- |
| 新規作成または更新 | `extensions/state-workflow-extension/examples/commit-assistant-client.ts` |
| 更新 | `extensions/state-workflow-extension/README.md` の example clients 関連 2 箇所 |

README の内容(2 箇所):

- 冒頭の `Example clients:` リストに `examples/commit-assistant-client.ts` の行があること
- `examples/` の説明リストに次の 1 行があること(旧記述がある場合は差し替える):
  `- commit-assistant-client.ts: 起案→人間承認→workflow が git commit を実行、をクリーンになるまで繰り返すコミットアシスタントフロー`

## 3. 前提・制約

- client は base extension(`../index.ts` や `../domain/*`)の TypeScript を **一切 import しない**。イベント名と payload 型は client 内にローカル定義する(§4 の型をそのまま使うこと)
- import は `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";` のみ(node 標準モジュールも import しない)
- default export は `export default function commitAssistantClientExtension(pi: ExtensionAPI): void`
- インデントはタブ。payload を emit するときは `satisfies` で型付けする(既存 examples と同じ流儀)
- shell 実行は `pi.exec(command, args)` を使う。戻り値は `{ stdout, stderr, code, killed }`
- コミットメッセージの受け渡しファイルは定数 `const COMMIT_MESSAGE_FILE = ".git/COMMIT_ASSISTANT_MSG";` とする(`.git/` 配下なので `git status` を汚さない)
- client は guard を登録できないため、function state の分岐は handler の success / error outcome のみで表現する(「クリーン」は throw による error 扱い。§6.1 参照)
- `pnpm check`(`tsc --noEmit`)で、本 client ファイル由来の型エラーが 0 件であること
  (既知の例外: `extensions/state-workflow-extension/index.ts(574,9)` の既存エラー 1 件は本作業と無関係なので無視してよい)

## 4. クライアント契約(ローカル定義する定数と型)

以下を client ファイル内にそのまま定義して使う。

```ts
const REGISTER_WORKFLOW_EVENT = "state-workflow:register-workflow";
const REGISTER_FUNCTION_HANDLER_EVENT = "state-workflow:register-function-handler";
const START_WORKFLOW_EVENT = "state-workflow:start-workflow";

type WorkflowSessionSnapshot = {
	entries: unknown[];
	leafId: string | null;
	sessionFile?: string;
};

type WorkflowFunctionContext = {
	run: {
		history?: Array<{ stateId?: string; transitionId?: string }>;
		lastResult?: {
			error?: {
				code?: string;
				message?: string;
			};
		};
	};
	session: WorkflowSessionSnapshot;
};

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
	states: Record<
		string,
		{
			id: string;
			title?: string;
			action: ClientWorkflowAction;
			transitions: WorkflowTransition[];
		}
	>;
};

type RegisterFunctionHandlerPayload = {
	name: string;
	handler: (input: unknown, context: WorkflowFunctionContext) => Promise<unknown> | unknown;
};

type StartWorkflowPayload = {
	workflowId: string;
	autoRun?: boolean;
	ctx: unknown;
};
```

補足: `WorkflowFunctionContext.run` は base 側の run state の read-only snapshot で、
`history`(各エントリに `stateId` と、その state を抜けたときの `transitionId` を持つ)と
`lastResult`(直前 state の実行結果。失敗時は `error.message` を持つ)を参照してよい。

## 5. ワークフロー定義

- workflow id: `commit-assistant`
- title: `Commit Assistant`
- initialStateId: `check-changes`

状態遷移の全体像(commit → check-changes のループで複数コミットを積む):

```
        ┌─────────────────────── success(commit-done) ───────────────────────┐
        ↓                                                                    │
check-changes ─success(changes-found)→ draft-message                       commit
        │                                   │  ↑                            ↑  │
        │                    manualOrAgent  │  │ manual(revise)             │  │ error(commit-failed)
        │                  (message-ready)  ↓  │      manual(approve-commit)│  ↓
        │                                  review ──────────────────────────┘
        └─error(repo-clean)→ done [完了]
```

### 5.1 state: `check-changes`

ループの起点。初回起動時と、`commit` が成功するたびに実行される。

- title: `Check changes`
- action: `{ kind: "function", handler: "commit-assistant.check-changes" }`
- transitions:

| id | to | trigger |
| --- | --- | --- |
| `changes-found` | `draft-message` | `success` |
| `repo-clean` | `done` | `error` |

working tree がクリーンなら handler が throw し(§6.1)、`repo-clean` で `done` へ進んで workflow が完了する。
git コマンド自体の失敗も同じく error として `done` へ流れ、理由はサマリ(§6.3)に記録される。

### 5.2 state: `draft-message`

- title: `Draft commit message`
- action: `kind: "userMessage"`、content は次の文字列(そのまま使う):

```
コミットメッセージの提案をお願いします。このワークフローは変更がなくなるまで繰り返されるので、1 回につき 1 コミット分だけ提案してください。次の手順で進めてください。
1. git status と git diff(staged 分は git diff --cached)で現在の変更内容を確認する
2. 次の 1 コミットに含めるべき変更を選んで 1〜2 文で要約を報告し、その変更だけを git add で stage する(すでに stage 済みの内容と混ざる場合は git reset で整理してよい)
3. その 1 コミット分の Conventional Commits 形式のコミットメッセージ案を 1 つ、コードブロックで提示する
4. 同じメッセージをファイル .git/COMMIT_ASSISTANT_MSG に書き込む
注意: git commit / git push は実行しないでください。コミットは人間が承認したあとにワークフローが実行します。
ここまで終えたら、workflow_next ツールを transitionId='message-ready' で呼んでください。
```

- transitions:

| id | to | trigger | label |
| --- | --- | --- | --- |
| `message-ready` | `review` | `manualOrAgent` | `Commit message proposed` |

挙動メモ: `userMessage` は dispatch 成功で success になるが、この state に `success` transition は無いため、
run は `waitingManual` で待機する。agent が作業を終えて `workflow_next({ transitionId: "message-ready" })`
を呼んだ時点で `review` へ進む。

### 5.3 state: `review`

人間レビュー用の待機 state。新しいメッセージは送らず、会話の続きで提案を吟味できる
(stage 内容は `git diff --cached`、メッセージは `.git/COMMIT_ASSISTANT_MSG` で確認できる)。

- title: `Human review`
- action: `{ kind: "continueSession" }`
- transitions(**どちらも `manual`。AI からは選べないこと**):

| id | to | trigger | label |
| --- | --- | --- | --- |
| `approve-commit` | `commit` | `manual` | `Approve and commit` |
| `revise` | `draft-message` | `manual` | `Request another draft` |

`/workflow-next approve-commit` を選ぶと base が `commit` の action を即座に実行し(§6.2)、
成功すれば `check-changes` の再検査まで自動で進む。
`/workflow-next revise` を選ぶと `draft-message` の userMessage が再送され、agent が再起案する。

### 5.4 state: `commit`

人間の承認を受けて、**実際に `git commit` を実行する** state。

- title: `Commit`
- action: `{ kind: "function", handler: "commit-assistant.commit" }`
- transitions:

| id | to | trigger | label |
| --- | --- | --- | --- |
| `commit-done` | `check-changes` | `success` | `Committed` |
| `commit-failed` | `review` | `error` | `Commit failed` |

成功すると `check-changes` に戻ってループが続く(残変更がなければ `repo-clean` → `done` まで自動進行)。
失敗(stage 漏れ・メッセージファイル欠落・git エラー)は `review` に戻り、人間が
`revise` で再起案させるか、手で状況を直してから再度 `approve-commit` するかを選べる。

### 5.5 state: `done`

終端 state。ループ全体のサマリを返して完了する。

- title: `Done`
- action: `{ kind: "function", handler: "commit-assistant.summarize" }`
- transitions: `[]`(なし → workflow は completed になる)

## 6. function handler 仕様

3 つの handler を `REGISTER_FUNCTION_HANDLER_EVENT` で登録する。名前は `commit-assistant.` プレフィックスで名前空間を切る。

### 6.1 `commit-assistant.check-changes`

非同期 handler。

1. `await pi.exec("git", ["status", "--porcelain"])` を実行する
2. `result.code !== 0` の場合、`throw new Error(\`git status failed: ${result.stderr}\`)`
3. stdout を trim し、空文字列なら `throw new Error("No uncommitted changes")`
4. 変更がある場合、stdout を改行で分割した配列を `files` とし、次を返す:
   `{ changedFiles: files.length, files: files.slice(0, 20) }`
   (20 件で打ち切るのは出力肥大化を避けるため)

throw が `error` outcome になり、`repo-clean` transition で `done` へ流れる。
つまり「クリーン = 正常完了ルート」も「git 失敗 = 異常終了ルート」もこの error 遷移を通る。
両者の区別は summarize(§6.3)が `lastResult.error.message` を記録することで可能にする。

### 6.2 `commit-assistant.commit`

非同期 handler。stage 済みの変更を `.git/COMMIT_ASSISTANT_MSG` のメッセージでコミットする。

1. stage 済み変更の存在確認: `await pi.exec("git", ["diff", "--cached", "--quiet"])`
   - `code === 0`(差分なし)なら `throw new Error("Nothing staged for commit")`
   - `code` が `0` でも `1` でもない場合は `throw new Error(\`git diff --cached failed: ${result.stderr}\`)`
   - `code === 1`(stage 済み差分あり)なら続行
2. コミット実行: `await pi.exec("git", ["commit", "-F", COMMIT_MESSAGE_FILE])`
   - `code !== 0` なら `throw new Error(\`git commit failed: ${result.stderr}\`)`
     (メッセージファイルが無い・空の場合も git 自体が失敗するので、この throw に集約される)
3. 使い終わったメッセージファイルを削除する: `await pi.exec("rm", ["-f", COMMIT_MESSAGE_FILE])`
   (次のループで stale なメッセージを誤用しないため。失敗しても無視してよい)
4. 作成されたコミットを確認して返す: `await pi.exec("git", ["log", "-1", "--format=%h %s"])` の stdout を trim し、
   `{ committed: true, head: <その文字列> }` を返す

throw した場合は `commit-failed` transition で `review` に戻る。
**この handler 以外(agent への指示文を含む)では `git commit` を実行しないこと。**

### 6.3 `commit-assistant.summarize`

同期 handler。`context.run.history` から次を集計して返す:

- `commits`: `transitionId === "commit-done"` のエントリ数(= workflow がコミットを実行してループした回数)
- `draftCount`: `stateId === "draft-message"` のエントリ数(= 起案回数)
- `reason`: `context.run.lastResult?.error?.message ?? "unknown"`(直前の check-changes が止まった理由。通常は "No uncommitted changes")

```ts
{ commits, draftCount, reason, sessionFile: context.session.sessionFile }
```

throw はしない(この state は常に success で完了する)。
history の数え方は agent-retry-client の `countStateEntries` と同様、filter + length でよい。

## 7. コマンド仕様

`pi.registerCommand("commit-assistant", { ... })` で 1 コマンドを登録する。

- description: `Start the commit message assistant workflow`
- handler: `async (_args, ctx)` で次を行う
  1. `registerSelf()`(§8)を呼ぶ
  2. `pi.events.emit(START_WORKFLOW_EVENT, { workflowId: "commit-assistant", autoRun: true, ctx } satisfies StartWorkflowPayload)`

## 8. 登録タイミング(registerSelf)

client は base より先に load される可能性があるため、登録イベントの再送パターンを実装する。

`registerSelf(): void` 関数を定義し、その中で:

1. 3 つの function handler をそれぞれ `REGISTER_FUNCTION_HANDLER_EVENT` で emit(`satisfies RegisterFunctionHandlerPayload`)
2. workflow 定義を `REGISTER_WORKFLOW_EVENT` で emit

`registerSelf()` は次の 3 箇所すべてで呼ぶ:

- extension factory 本体の末尾(load 時)
- `pi.on("session_start", async () => { registerSelf(); })`
- `/commit-assistant` コマンド handler の先頭

構成は `examples/agent-retry-client.ts` の `agentRetryClientExtension` と同型にすること。

## 9. 非ゴール

- `git push` の実行
- AI agent が `git commit` を直接実行すること(コミットは `commit` state の function action のみが行う。stage と `.git/COMMIT_ASSISTANT_MSG` への書き込みは agent が行ってよい)
- 部分 stage(hunk 単位)の自動化(stage 粒度の判断は agent と人間に委ねる)
- base extension(`index.ts` / `domain/`)への変更
- guard・priority の使用(本例では使わない)
- 自動テストの追加(既存 examples 同様、テストファイルは不要。検証は §10 の手動シナリオで行う)

## 10. 受け入れ基準

1. `pnpm check` で本 client ファイル由来の型エラーが 0 件(§3 の既知エラー 1 件を除き成功する)
2. `examples/commit-assistant-client.ts` が base extension のコードを import していない
3. 手動シナリオ A(複数コミットのループ): 複数の論理的変更を含む未コミット変更のあるリポジトリで
   `pi -e extensions/state-workflow-extension/index.ts -e extensions/state-workflow-extension/examples/commit-assistant-client.ts`
   を起動し、
   - `/workflow-list` に `commit-assistant` が表示される
   - `/commit-assistant` で起動すると `check-changes` が成功し、agent への起案指示メッセージが自動送信される
   - agent が stage・提案・`.git/COMMIT_ASSISTANT_MSG` 書き込みの後に `workflow_next`(`message-ready`)を呼ぶと `review` へ進み、`waitingManual` で待機する
   - `review` 中に agent が `workflow_next` で `approve-commit` / `revise` を選ぶことは **できない**(manual のため)
   - `/workflow-next revise` で `draft-message` に戻り、指示メッセージが再送される
   - `/workflow-next approve-commit` を選ぶと `commit` state が `git commit` を実行し(`git log` で新コミットを確認できる)、`check-changes` の再検査まで自動で進む。変更が残っていれば再び起案指示が送られる(ループ 2 周目)
   - 最後の変更分をコミットし終えると、`check-changes` が error(`No uncommitted changes`)になり `done` を経て completed になる
   - 何も stage されていない状態で `/workflow-next approve-commit` を選ぶと、`commit` が error(`Nothing staged for commit`)になり `review` に戻って待機する
   - `/workflow-history` に `check-changes → draft-message → review → commit → check-changes → … → done` のループを含む履歴が出る
   - `done` の出力にコミット回数(`commits`)・起案回数(`draftCount`)・停止理由(`reason`)が含まれる
4. 手動シナリオ B(変更なし): クリーンな working tree で `/commit-assistant` を実行すると、
   `check-changes` が即座に error になり `done` を経て completed になる(`commits: 0`、`reason` に "No uncommitted changes" が記録される)

## 11. 参考ファイル

- `extensions/state-workflow-extension/README.md` — client 契約(イベント名・payload・semantics)の正本
- `extensions/state-workflow-extension/examples/agent-retry-client.ts` — registerSelf パターン、`manualOrAgent`、history による回数カウントの実装例
- `extensions/state-workflow-extension/examples/basic-client.ts` — 最小の client 構成例
