# テストケース: listDocumentRevisions

[usecases/knowledge.md](../../usecases/knowledge.md) の listDocumentRevisions に対するテストケース（人間 UI ★。AI トークンのスコープに存在しない）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 人間編集 2 回 + AI 編集 1 回のリビジョン 1〜3 を持つ active ドキュメント | 履歴一覧を取得する | `revisions` が `revisionNumber` 昇順で 3 件返り、各要素は `revisionNumber` / `actor` / `changeReason` / `createdAt` のメタデータのみ（全文スナップショットは含まれない）。`latestRevision: 3` | |
| AI クライアントの編集リビジョンを含むドキュメント | 履歴一覧を取得する | 当該リビジョンの `actor` は `{ kind: "aiClient", clientName }` で、クライアント名と変更理由が確認できる（S-DT-06） | |
| 作成直後（リビジョン 1 のみ）のドキュメント | 履歴一覧を取得する | 1 件のみ返る（境界値: ドキュメントが存在すれば必ず 1 件以上。差分・ロールバック操作を出さない制御は presentation の責務） | |
| ゴミ箱内ドキュメント（ソフトデリート済み） | 履歴一覧を取得する | `findByIdIncludingTrashed` により正常に履歴が返る（人間 UI はゴミ箱内ドキュメントの履歴も閲覧可。エッジケース） | |
| ドキュメントが存在しない ID（ハードデリート済み含む） | 履歴一覧を取得する | `NotFoundError`（ハードデリートで履歴ごと消えている） | |
| 他ユーザー所有のドキュメント ID | 履歴一覧を取得する | 到達可能性により `NotFoundError`（自分の Durable Object の中に他ユーザーの行が存在しない） | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| active ドキュメントが存在する | `DocumentRepository.listRevisions` で DB 例外が発生する | `SystemError(DatabaseError)` | |
