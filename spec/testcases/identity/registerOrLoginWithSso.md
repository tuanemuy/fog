# テストケース: SSO lookup/create primitive

OAuth UIは#12。本書はIssue #19で提供する非公開primitive contractを検証する。

| 前提 | 操作 | 期待結果 |
|---|---|---|
| credential未登録、email未登録 | Google credentialをstable operationIdでcreate | Directory/Account Home/User Dataが確定し、新しいuserId |
| credential未登録、email未登録 | Apple credentialをcreate | provider境界を保って作成 |
| 同一provider/subject登録済み | lookup | 既存userId |
| 完了済みoperationId | 同一payloadで再送 | 同じuserId/結果、二重作成なし |
| credential未登録 | 同時初回create | 1つのmapping/userIdへ収束 |
| credential未登録、同一emailのpassword accountあり | create | `EMAIL_ALREADY_REGISTERED`、自動linkなし |
| credential未登録、同一emailの別provider accountあり | create | `EMAIL_ALREADY_REGISTERED` |
| `google/sub-1`登録済み | `apple/sub-1`をlookup/create | 別credentialとして扱う |
| previous generationだけにmappingあり | active/previous lookup | 既存userIdを返しactiveへの移送を冪等再開 |
| rotation途中でactive/previousが競合 | lookup/create | Account Home reverse locatorとoperationを照合して1つへ収束 |
| 各saga phase後 | fault後に同operationIdで再送 | 保存済みphaseから再開しorphan/二重userなし |
| unsupported provider/不正email/空subject | create | business/validation error、永続化なし |
