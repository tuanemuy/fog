# テストケース: diffMemoRevisions

[usecases/memo.md](../../usecases/memo.md) の diffMemoRevisions に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| リビジョン 1〜3 を持つメモが存在する | `baseRevisionNumber: 1`, `targetRevisionNumber: 3` で取得する | `base` / `target` の `RevisionView`（`revisionNumber` / `body` 全文スナップショット / `actor` / `createdAt`）が返る。差分の計算・整形は行わない（presentation の責務。S-TL-05） | |
| リビジョン 1〜3 を持つメモが存在する | `baseRevisionNumber: 3`, `targetRevisionNumber: 1`（逆順）で取得する | 指定どおり `base` = 3, `target` = 1 で返る（順序の入れ替えはしない） | |
| AI クライアントが編集したリビジョンを含むメモが存在する | 二点を取得する | 該当 `RevisionView.actor` は `{ kind: "aiClient", clientName }`（ActorView 射影） | |
| リビジョン 2 件のメモが存在する | `baseRevisionNumber: 1`, `targetRevisionNumber: 2` で取得する | 正常に返る（境界値: 最小の二点。revisionNumber の下限 1 を含む） | |
| 対象メモが trashed | 二点を取得する | 正常に返る（人間 UI の履歴閲覧はゴミ箱内メモにも許される。エッジケース） | |
| リビジョン 1〜3 を持つメモが存在する | `baseRevisionNumber: 2`, `targetRevisionNumber: 2`（同一）で取得する | `ValidationError`（二点は異なること） | |
| リビジョン 1〜3 を持つメモが存在する | `targetRevisionNumber: 4`（存在しない番号）で取得する | `NotFoundError`（いずれか一方でも不在なら NotFound。境界値: 最大番号 + 1） | |
| メモが存在しない | 架空の `memoId` で取得する | `NotFoundError`（`findRevision` が null を返す） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID・リビジョン番号で取得する | `NotFoundError`（テナント分離: リビジョンも userId スコープ） | |
| — | `baseRevisionNumber: 0` で取得する | `BusinessRuleError(InvalidRevisionNumber)`（境界値: 1 未満） | |
| — | `targetRevisionNumber` に負数・非整数（`1.5`）を指定する | `BusinessRuleError(InvalidRevisionNumber)` | |
| — | `memoId` を空文字で取得する | バリデーションエラー（`MemoId.create` の非空制約） | |
| — | AI トークンで本ユースケース相当の操作を試みる | 到達不可（履歴閲覧は人間UI専用。公開範囲とトークンスコープで構造的に排除） | |
| — | DB 例外が発生する | `SystemError(DatabaseError)` | |
