# テストケース: rollbackMemo

[usecases/memo.md](../../usecases/memo.md) の rollbackMemo に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| リビジョン 1〜3 を持つメモ（現在本文はリビジョン 3）が存在する | `targetRevisionNumber: 1` でロールバックする | `result: "rolledBack"`。現在本文がリビジョン 1 の内容になり、`latestRevisionNumber: 4` の**新しい**リビジョンとして積まれる。リビジョン 1〜3 は消えない（S-TL-05「この内容に戻す」。履歴は消えない） | |
| 上記のロールバックが成功した | リビジョン・イベントを確認する | 新リビジョン（`revisionNumber: 4`、`actor` = 操作者、`body` = 対象リビジョンの全文、`createdAt = now`）が同一 UoW で記録され、`memo.edited` イベントが Outbox に記録される（専用イベントはない）。`version` は +1、`postedAt` は不変 | |
| 現在本文がリビジョン 1 と同一のメモが存在する | `targetRevisionNumber: 1` でロールバックする | `result: "unchanged"`。新リビジョンは積まれず、`version` も上がらず、イベントも発行されない（no-op） | |
| 直前に AI クライアントが同メモを編集した | ロールバックする | `expectedVersion` を受けないため競合警告なしで対象リビジョンの内容に戻る。AI の編集リビジョンも履歴に残る（エッジケース: 明示操作は他者編集後も意図が変わらない） | |
| リビジョン 1〜3 を持つメモが存在する | `targetRevisionNumber: 3`（最新）でロールバックする | 現在本文と同一のため `result: "unchanged"`（境界値: 最新リビジョン指定） | |
| リビジョン 1〜3 を持つメモが存在する | `targetRevisionNumber: 1` でロールバックする | 正常（境界値: revisionNumber の下限 1 = 初版へ戻す） | |
| リビジョン 1〜3 を持つメモが存在する | `targetRevisionNumber: 4`（存在しない番号）でロールバックする | `NotFoundError`（対象リビジョン不在。境界値: 最大番号 + 1） | |
| — | `targetRevisionNumber: 0` / 負数 / 非整数でロールバックする | `BusinessRuleError(InvalidRevisionNumber)`（境界値: 1 未満） | |
| メモが存在しない | 架空の `memoId` でロールバックする | `NotFoundError` | |
| 対象メモが trashed | ロールバックする | `NotFoundError`（trashed は編集不可のため一律 NotFound。`findById` が active のみ返す） | |
| 対象メモが他ユーザー所有 | 実在する他ユーザーのメモ ID でロールバックする | `NotFoundError`（テナント分離） | |
| 別メモのリビジョンが `Memo.rollback` に渡る（防衛線） | `targetRevision.memoId ≠ memo.id` の状態でドメイン関数を呼ぶ | `BusinessRuleError(RevisionMismatch)`（userId スコープの `findRevision` を経る限り通常到達しない防衛線） | |
| — | `memoId` を空文字でロールバックする | バリデーションエラー（`MemoId.create` の非空制約） | |
| UoW 内の読み取り後、save までの間に他書き込みが割り込む | ロールバックする | `ConflictError("OPTIMISTIC_LOCK_FAILURE")`。UI は再試行する | |
| — | AI トークンで本ユースケース相当の操作を試みる | 到達不可（ロールバックは人間UI専用。公開範囲とトークンスコープで構造的に排除） | |
| — | `save` / `insertRevision` で DB 例外が発生する | `SystemError(DatabaseError)`。ロールバックされ何も記録されない | |
