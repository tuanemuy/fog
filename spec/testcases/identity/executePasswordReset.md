# テストケース: password reset consume primitive

| 前提 | 操作 | 期待結果 |
|---|---|---|
| 有効・未使用token | stable operationIdでnew password設定 | one-time consume、credential更新、Account Home session epoch増加 |
| 同じoperationId | 再送 | 同じ完了結果、epoch/hash二重更新なし |
| 8文字/128文字 | 実行 | 成功 |
| 7文字/129文字 | 実行 | business error、token未消費 |
| 不在/改ざん/期限切れ/使用済みtoken | 実行 | 同一`RESET_TOKEN_INVALID` |
| 各saga phase後 | fault後再送 | 保存済みphaseから再開 |
| credential更新後Account Home更新前に障害 | reconciler実行 | operationを確認しepoch更新まで完了 |
| Account Home deleting/deleted | 実行 | 拒否しcredentialを復活させない |
