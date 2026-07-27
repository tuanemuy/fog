# テストケース: editMemo

[usecases/memo.md](../../usecases/memo.md) の editMemo に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモ（`version: 0`, `latestRevisionNumber: 1`）が存在する | 編集開始時の `expectedVersion: 0` と新本文で保存する | `result: "saved"`。`MemoView` は新本文・`version: 1`・`latestRevisionNumber: 2`。`conflict: null`（S-TL-04） | |
| 上記の保存が成功した | リビジョンと検索を確認する | `revisionNumber: 2` の新リビジョンとFTS5射影が同じtransactionで記録され、旧語は消え新語が直後にヒットする | |
| メモを編集した | `postedAt` を確認する | `postedAt` は変わらない（タイムライン上の位置は不変）。`updatedAt` は `now` に更新される | |
| active なメモが存在する | 現在と同一の本文で保存する（no-op） | `result: "unchanged"`。新リビジョンは積まれず、`version` も上がらず、イベントも発行されない（S-TL-04「変更せずに保存」。同一本文の連続リビジョンは存在しない） | |
| active なメモが存在する | 本文の等価判定を確認する（例: 末尾空白 1 文字だけ異なる本文で保存） | 文字列の完全一致で判定されるため `result: "saved"`（`MemoBody.equals` は完全一致） | |
| 編集開始後に AI クライアントが同メモを編集済み（version が進んでいる） | 古い `expectedVersion` で保存する | `result: "conflict"`。**何も書き込まれない**。`memo` は他者編集後の現在状態、`conflict.currentBody` は現在本文、`conflict.currentVersion` は現在 version、`conflict.latestRevision` は `{ revisionNumber, actor: { kind: "aiClient", clientName }, createdAt }`（誰がいつ編集したかの警告表示用） | |
| conflict 応答を受け取った | `expectedVersion = conflict.currentVersion` として同じ本文で再度保存する（「そのまま保存」） | `result: "saved"`。最新状態への再適用として新リビジョンが積まれ、AI の編集リビジョンも履歴に残る（S-TL-04） | |
| 編集開始後に別セッションの自分が編集済み | 古い `expectedVersion` で保存する | `result: "conflict"`。`conflict.latestRevision.actor` は `{ kind: "user" }`（表示名は presentation の責務） | |
| active なメモが存在する | `body` をちょうど 10,000 文字で保存する | `result: "saved"`（境界値: 上限ちょうどは許容） | |
| active なメモが存在する | `body` を 10,001 文字で保存する | `BusinessRuleError(BodyTooLong)`。何も書き込まれない | |
| active なメモが存在する | `body` を空文字で保存する | `BusinessRuleError(EmptyBody)`（空文字への編集は不可） | |
| active なメモが存在する | `body` を空白のみで保存する | trim 後空のため `BusinessRuleError(EmptyBody)` | |
| メモが存在しない | 架空の `memoId` で保存する | `NotFoundError` | |
| 対象メモが trashed | 保存する | `NotFoundError`（`findById` が active のみ返す。trashed は編集不可） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID で保存する | `NotFoundError`（テナント分離） | |
| — | `memoId` を空文字で保存する | バリデーションエラー（`MemoId.create` の非空制約） | |
| — | `expectedVersion` に負数・非整数を指定する | バリデーションエラー（0 以上の整数） | |
| version 一致判定の通過後、save までの間に他書き込みが割り込む（レア） | 保存する | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再取得して再試行する | |
| active なメモが存在する | `save` / `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ本文・リビジョン・イベントのいずれも記録されない | |
