# テストケース: listDocumentSourceMemos

[usecases/knowledge.md](../../usecases/knowledge.md) の listDocumentSourceMemos に対するテストケース（人間 UI ★。IncludingTrashed 読み取りを含むため AI に配線しない）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 出典メモ 2 件（いずれも active）を持つドキュメント | 出典一覧を取得する | `sourceMemos` 2 件が返り、各要素は `memoId` / `snippet`（本文抜粋）/ `postedAt` / `deleted: false` / `linkedAt`（= ドキュメント作成日時） | |
| 出典メモの 1 件が紐付け後に編集されている | 出典一覧を取得する | `snippet` は最新の内容で返る（SourceLink はリビジョンではなくメモを指す。当時の内容はメモの履歴で辿れる） | |
| 出典メモの 1 件がソフトデリート済み | 出典一覧を取得する | 当該メモは `deleted: true` として一覧に残る（「削除済みのメモ」表示・タイムライン遷移不可の判定用。S-DT-07） | |
| 出典メモの 1 件がハードデリート済み（リンクは同一 UoW で消去済み） | 出典一覧を取得する | 当該メモは一覧に現れない（ADR-003。壊れたリンクや痕跡を残さない） | |
| 出典メモが全てハードデリート済み | 出典一覧を取得する | `sourceMemos: []`（空になり得る。ドキュメント自体の内容には影響しない。ADR-003 のエッジケース） | |
| 出典なし（SourceLink 0 件）で作成されたドキュメント | 出典一覧を取得する | `sourceMemos: []`（境界値: 0 件はエラーにしない） | |
| 出典メモが複数件あるドキュメント | 出典一覧を取得する | メモの本文・削除状態は `listByIdsIncludingTrashed` の 1 クエリで取得される（N+1 にならない） | |
| ゴミ箱内ドキュメント（ソフトデリート済み） | 出典一覧を取得する | `findByIdIncludingTrashed` により正常に返る（人間 UI の読み取り経路。エッジケース） | |
| ドキュメントが存在しない ID（ハードデリート済み含む） | 出典一覧を取得する | `NotFoundError` | |
| 他ユーザー所有のドキュメント ID | 出典一覧を取得する | userId スコープにより `NotFoundError` | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| ドキュメントが存在する | `MemoRepository.listByIdsIncludingTrashed` で DB 例外が発生する | `SystemError(DatabaseError)` | |
