# テストケース: listMemoRevisions

[usecases/memo.md](../../usecases/memo.md) の listMemoRevisions に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 複数回編集されたメモが存在する | 履歴を取得する | `revisions` が `revisionNumber` 昇順で全件返る。各要素は `{ revisionNumber, actor, createdAt }` のみで本文を含まない。`latestRevisionNumber` は最大番号と一致する（S-TL-05） | |
| 人間と AI クライアントの両方が編集したメモが存在する | 履歴を取得する | 人間の編集は `actor: { kind: "user" }`、AI の編集は `actor: { kind: "aiClient", clientName }` で区別できる（S-TL-05。`kind: "user"` の表示名は presentation の責務） | |
| 投稿直後（編集なし）のメモが存在する | 履歴を取得する | `revisions` は初版 1 件のみ（`revisionNumber: 1`。メモが存在すれば必ず 1 件以上）。差分・ロールバック操作を出さない制御は presentation の責務（境界値: 最小履歴） | |
| 対象メモが trashed | 履歴を取得する | 正常に履歴が返る（人間 UI の履歴閲覧はゴミ箱内メモにも許される。`findByIdIncludingTrashed` 経由。エッジケース） | |
| ロールバック済みのメモが存在する | 履歴を取得する | ロールバックで積まれた新リビジョンも一覧に含まれ、過去のリビジョンは消えていない（履歴の線形性: 欠番・分岐なし） | |
| メモが存在しない（ハードデリート済み含む） | 架空の `memoId` で取得する | `NotFoundError` | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID で取得する | `NotFoundError`（テナント分離） | |
| — | `memoId` を空文字で取得する | バリデーションエラー（`MemoId.create` の非空制約） | |
| — | AI トークンで本ユースケース相当の操作を試みる | 到達不可（履歴閲覧は人間UI専用。application 層の公開範囲とトークンスコープで構造的に排除され、認可エラーとなる） | |
| — | DB 例外が発生する | `SystemError(DatabaseError)` | |
