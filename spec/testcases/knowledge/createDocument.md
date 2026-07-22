# テストケース: createDocument

[usecases/knowledge.md](../../usecases/knowledge.md) の createDocument に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| `active` トピックと active メモ 2 件が存在する | `title` / `body` / `sourceMemoIds`（2 件）/ `changeReason: "初稿"` で作成する | `ActiveDocument`（`version: 0`, `latestRevision: 1`）、リビジョン #1（全文スナップショット・`actor`・`changeReason: "初稿"`）、SourceLink 2 件が同一 UoW で保存され、`document.created` イベントが記録される | |
| `active` トピックが存在する | `sourceMemoIds: []`（空配列）で作成する | 出典なしで正常に作成される（出典は任意。S-DT-04）。SourceLink は 0 件 | |
| `active` トピックが存在する | `changeReason` を省略して作成する | application 層が既定値「作成」を補完し、リビジョン #1 の `changeReason` は「作成」になる（人間 UI / AI 共通。「なぜ」が空のリビジョンを存在させない） | |
| `active` トピックが存在する | `changeReason` に空白のみ（trim 後空）を渡して作成する | 「作成」が補完され正常に作成される | |
| `active` トピックとメモが存在する | `sourceMemoIds` に同一メモ ID を重複して渡す | 重複除去され SourceLink は 1 件のみ。出力 `sourceMemoIds` も重複除去後 | |
| `archived` トピックが存在する | 当該トピック配下に作成する | `findById` は Live（archived 含む）を返すため正常に作成される（アーカイブは削除ではない） | |
| `active` トピックが存在する | `body: ""`（空文字）で作成する | 空本文で正常に作成される（書きかけは正当な状態。境界値） | |
| `active` トピックが存在する | `body` をちょうど 1,000,000 文字で作成する | 正常に作成される（境界値: 最大長ちょうどは許容） | |
| `active` トピックが存在する | `body` を 1,000,001 文字で作成する | `BusinessRuleError(DocumentBodyTooLong)`。ドキュメントは作成されない | |
| `active` トピックが存在する | `title` を空文字 / 空白のみ / 改行入り / 201 文字で作成する | それぞれ `BusinessRuleError`（`EmptyDocumentTitle` / `EmptyDocumentTitle` / `DocumentTitleMultiline` / `DocumentTitleTooLong`） | |
| `active` トピックが存在する | `title` をちょうど 200 文字で作成する | 正常に作成される（境界値） | |
| `active` トピックが存在する | `changeReason` を改行入り / 201 文字で指定して作成する | `BusinessRuleError`（`ChangeReasonMultiline` / `ChangeReasonTooLong`） | |
| `active` トピックが存在する | `changeReason` をちょうど 200 文字で指定して作成する | 正常に作成される（境界値） | |
| 作成先トピックが存在しない ID | 作成する | `NotFoundError`。ドキュメントは作成されない | |
| 作成先トピックがゴミ箱内 | 作成する | `NotFoundError`（S-AI-03 異常系。ゴミ箱内トピック配下に作成させない） | |
| 作成先トピックが他ユーザー所有 | 作成する | userId スコープにより `NotFoundError` | |
| `sourceMemoIds` の 1 件が存在しないメモ ID（他は active） | 作成する | `NotFoundError` で全体が失敗し、ドキュメント・リビジョン・リンクとも作成されない（1 件でも不正なら全体失敗。部分的に壊れた状態を作らない） | |
| `sourceMemoIds` の 1 件がゴミ箱内メモ（他は active）（エッジケース: 出典の一部が trashed） | 作成する | `listActiveByIds` の結果に含まれないため `NotFoundError` で全体失敗。AI にゴミ箱内の存在事実も漏らさない（S-AI-03 異常系） | |
| `sourceMemoIds` の 1 件が他ユーザー所有のメモ | 作成する | `NotFoundError` で全体失敗（存在しない / ゴミ箱内 / 他ユーザーを区別しない） | |
| `sourceMemoIds` の要素に空文字が含まれる | 作成する | `BusinessRuleError`（MemoId の構築違反） | |
| トピック取得後、並行する `trashTopic` が先にトピックを `save` 済み（エッジケース: トピック touch の OCC 競合） | 作成を実行する | 手順 6 のトピック touch（`TopicRepository.save`）が 0 行更新となり `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。ドキュメントは作成されず、「trashed トピック配下の active ドキュメント」は生まれない。利用者は再試行 | |
| トピック取得後、並行する `updateTopic`（アーカイブ切替等）が先に `save` 済み | 作成を実行する | 同様に touch が `ConflictError` となり作成されない（OCC による直列化） | |
| 正常に作成が完了した | 作成先トピックの状態を確認する | トピックの `version` が 1 進んでいるが、内容は不変でトピックのイベントは発行されていない（touch は内容変更ではない） | |
| AI トークンで認証（MCP `create_document`） | `changeReason` 付きで作成する | 人間 UI と同一の振る舞いで作成される（S-AI-03） | |
| `active` トピックが存在する | `insertSourceLinks` で DB 例外が発生する | `SystemError(DatabaseError)`。UoW 全体がロールバックされる | |
