# テストケース: listDocumentsReferencingMemo

[usecases/knowledge.md](../../usecases/knowledge.md) の listDocumentsReferencingMemo に対するテストケース（人間 UI ★。IncludingTrashed 読み取りを含むため AI に配線しない）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メモを出典とする active ドキュメント 2 件が存在する | 参照元一覧を取得する | `documents` 2 件が返り、各要素は `documentId` / `title` / `topicId` / `deleted: false` / `linkedAt`（「→ ドキュメントX」導線。S-TL-07） | |
| 参照元ドキュメントの 1 件がソフトデリート済み | 参照元一覧を取得する | 当該ドキュメントは `deleted: true` として一覧に残る（「削除済みのドキュメント」表示・遷移不可の判定用。S-DT-08） | |
| 参照元ドキュメントの 1 件がハードデリート済み（リンクごと消去済み） | 参照元一覧を取得する | 当該ドキュメントは一覧に現れない（ADR-003） | |
| どのドキュメントからも参照されていないメモ | 参照元一覧を取得する | `documents: []`（境界値: 0 件はエラーにしない） | |
| 参照元ドキュメントが複数件あるメモ | 参照元一覧を取得する | ドキュメントのタイトル・削除状態は `listByIdsIncludingTrashed` の 1 クエリで取得される（N+1 にならない） | |
| メモ自身がソフトデリート済み | 参照元一覧を取得する | `findByIdIncludingTrashed` により正常に返る（人間 UI の読み取り経路。エッジケース） | |
| メモが存在しない ID（ハードデリート済み含む） | 参照元一覧を取得する | `NotFoundError`（ハードデリート済みメモはリンクも消えている） | |
| 他ユーザー所有のメモ ID | 参照元一覧を取得する | 到達可能性により `NotFoundError`（自分の Durable Object の中に他ユーザーの行が存在しない） | |
| — | `memoId` に空文字を渡す | `BusinessRuleError`（MemoId の構築違反） | |
| メモが存在する | `DocumentRepository.listSourceLinksByMemo` で DB 例外が発生する | `SystemError(DatabaseError)` | |
