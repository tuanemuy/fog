# テストケース: password change primitive

ユーザー向けUI/完成usecaseは#11。

| 前提 | 操作 | 期待結果 |
|---|---|---|
| password credential | 正しいcurrent/new passwordでstable operationId実行 | new hash、credential mapping、session epochをsagaで更新 |
| 8文字/128文字new password | 実行 | 成功 |
| 7文字/129文字 | 実行 | business error、状態不変 |
| current password誤り | 実行 | `CURRENT_PASSWORD_MISMATCH`、状態不変 |
| SSO-only account | 実行 | PasswordNotSupported |
| 同じoperationId/payload | 再送 | 同じ結果、epoch二重増加なし |
| 各phase後 | fault後再送/reconciler | 保存済みphaseから再開 |
| 成功後の旧session | current user/API | epoch不一致でunauthorized |
| Account Home deleting/deleted | 実行 | 拒否 |
