# テストケース: getCurrentUser

| 前提 | 操作 | 期待結果 |
|---|---|---|
| password account | current user取得 | Account Homeのprimary email/auth summaryとUser DataのProfile/Settingsを合成 |
| SSO account | current user取得 | `authMethods:["sso"]`、provider subjectなし |
| linked credentialsあり | current user取得 | 確定済みauthMethods、primary email、session epochに基づく |
| 登録直後 | current user取得 | trashRetentionDays 30 |
| Account Homeだけunavailable/PITR中 | current user取得 | retryable error、User Data片側で成功しない |
| User Dataだけunavailable/PITR中 | current user取得 | retryable error、Account Home片側で成功しない |
| Account Home deleting/deleted | current user取得 | unauthorized/not found |
| session epochが古い | current user取得 | unauthorized |
| public入力に別userId/DO IDを追加 | current user取得 |入力が拒否されroutingを変更できない |
| 正常応答 | DTO確認 | password hash、email canonical sensitive field、SSO subject、locatorを含めない |
