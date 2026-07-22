# テストケース: getDocument

[usecases/knowledge.md](../../usecases/knowledge.md) の getDocument に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active ドキュメントが存在する | ドキュメントを取得する | `id` / `topicId` / `title` / `body` / `latestRevision` / `version` / `createdAt` / `updatedAt` が返る（`version` は人間 UI の編集開始時 `expectedVersion` に使う） | |
| 本文が空文字の active ドキュメントが存在する | 取得する | `body: ""` で正常に返る（境界値: 空本文は正当な状態） | |
| 出典メモ付きの active ドキュメントが存在する | 取得する | 出典メモ一覧は含まれない（人間 UI は `listDocumentSourceMemos` を併用する） | |
| ドキュメントが存在しない ID | 取得する | `NotFoundError` | |
| ドキュメントがゴミ箱内（個別削除・セット削除とも） | 取得する | `findById` が active のみ返すため `NotFoundError`（AI からゴミ箱の中身は見えない。S-AI-04。人間 UI のゴミ箱表示は trash ドメインの責務） | |
| 他ユーザー所有のドキュメント ID | 取得する | userId スコープにより `NotFoundError`（存在の有無も漏らさない） | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| AI トークンで認証（MCP `get`、`type: "document"`） | ドキュメントを取得する | presentation 層が本ユースケースへディスパッチし、人間 UI と同一の結果（S-AI-02） | |
| active ドキュメントが存在する | `DocumentRepository.findById` で DB 例外が発生する | `SystemError(DatabaseError)` | |
