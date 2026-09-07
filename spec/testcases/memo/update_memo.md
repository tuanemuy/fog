# テストケース: update_memo（AI API）

[usecases/memo.md](../../usecases/memo.md) の update_memo に対するテストケース。全文置換のみ（パッチ非対応。[ADR-006](../../adr/006-memo-fulltext-update.md)）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモ（`latestRevisionNumber: 1`）が存在する | 新しい全文 `body` で更新する | `result: "saved"`。`memo` は新本文・`latestRevisionNumber: 2`。全文置換であり部分パッチは受け付けない（S-AI-04, ADR-006） | |
| 上記の更新が成功した | リビジョンとインデックスを確認する | 新リビジョン（`actor: { kind: "aiClient", clientName }`、全文スナップショット）が同一 UoW で自動記録され、同じ `transactionSync` の中で当該メモのエントリが `search_entries` / `search_fts` に作り直される（履歴による復元可能性が「原則パッチ」の趣旨を代替。ADR-006） | |
| メモを更新した | `postedAt` を確認する | `postedAt` は変わらない（タイムライン上の位置は不変） | |
| active なメモが存在する | 現在と同一の本文で更新する（no-op） | `result: "unchanged"`。新リビジョンは積まれず、`version` も上がらず、インデックスエントリも作り直されない | |
| 人間が編集画面を開いている間に AI が更新する | 更新する | `expectedVersion` を受けないため UoW 内で読み直した最新状態に適用され `result: "saved"`。編集内容は新リビジョンとして積まれ、履歴で追跡・ロールバック可能（S-AI-04 手順 3。人間側は保存時に editMemo の conflict 警告で検出） | |
| active なメモが存在する | `body` をちょうど 10,000 文字で更新する | `result: "saved"`（境界値: 上限ちょうどは許容） | |
| active なメモが存在する | `body` を 10,001 文字で更新する | `BusinessRuleError(BodyTooLong)`。何も書き込まれない | |
| active なメモが存在する | `body` を空文字で更新する | `BusinessRuleError(EmptyBody)`（空文字への編集は不可） | |
| active なメモが存在する | `body` を空白のみで更新する | trim 後空のため `BusinessRuleError(EmptyBody)` | |
| メモが存在しない | 架空の `memoId` で更新する | `NotFoundError`（S-AI-04 異常系） | |
| 対象メモが trashed | 更新する | `NotFoundError`。不在との区別がつかない応答であること（ゴミ箱内のメモは「存在しない」世界を貫き、存在事実も漏らさない。S-AI-04） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID で更新する | `NotFoundError`（テナント分離。不在と区別しない） | |
| — | `memoId` を空文字で更新する | バリデーションエラー（`MemoId.create` の非空制約） | |
| 同一 UoW 内の読み書き間で競合が発生する（レア） | 更新する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。AI クライアントは再試行する | |
| 失効・スコープ外の AI トークン | 更新を試みる | identity / プレゼンテーション境界で認可エラー。本ユースケースには到達しない | |
| — | `save` / `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ何も記録されない | |
