# テストケース: diffDocumentRevisions

[usecases/knowledge.md](../../usecases/knowledge.md) の diffDocumentRevisions に対するテストケース（人間 UI ★）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| リビジョン 1〜3 を持つドキュメント | `baseRevisionNumber: 1`, `targetRevisionNumber: 3` で取得する | `base` / `target` にそれぞれの当時の全文スナップショット（`title` / `body`）とメタデータ（`revisionNumber` / `actor` / `changeReason` / `createdAt`）が返る。差分計算はされない（presentation の責務） | |
| リビジョン 1〜3 を持つドキュメント | `baseRevisionNumber: 3`, `targetRevisionNumber: 1`（新→旧の順）で取得する | 順序の制約はなく、指定どおり `base` = #3, `target` = #1 で返る | |
| リビジョン 1〜2 を持つドキュメント | `baseRevisionNumber: 1`, `targetRevisionNumber: 2`（隣接二点・最小構成）で取得する | 正常に二点が返る（境界値: 最小のリビジョン番号 1 を含む） | |
| ゴミ箱内ドキュメントのリビジョンが存在する | 二点を取得する | `findRevision` は userId とドキュメント ID でスコープするためリビジョンが引ければ返る（人間 UI の履歴閲覧経路。エッジケース） | |
| リビジョン 1〜3 を持つドキュメント | `baseRevisionNumber: 2`, `targetRevisionNumber: 2`（同一）で取得する | `ValidationError`（二点が同一） | |
| リビジョン 1〜3 を持つドキュメント | `targetRevisionNumber: 4`（存在しない）で取得する | `NotFoundError`（いずれか一方でも不在なら NotFound） | |
| ドキュメントが存在しない ID（ハードデリート済み含む） | 任意の二点を取得する | `NotFoundError` | |
| 他ユーザー所有のドキュメントのリビジョン | 二点を取得する | 到達可能性により `findRevision` が `null` を返し `NotFoundError`（自分の Durable Object の中に他ユーザーの行が存在しない） | |
| — | `baseRevisionNumber: 0` を指定する | `BusinessRuleError(InvalidRevisionNumber)`（境界値: 1 未満） | |
| — | `revisionNumber` に非整数（`1.5`）を指定する | `BusinessRuleError(InvalidRevisionNumber)` | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| ドキュメントが存在する | `DocumentRepository.findRevision` で DB 例外が発生する | `SystemError(DatabaseError)` | |
