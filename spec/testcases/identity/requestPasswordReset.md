# テストケース: password reset request primitive

ユーザー向けUI/完成usecaseは#12。

| 前提 | 操作 | 期待結果 |
|---|---|---|
| password credential登録済み | reset request | token hash/expiryを保存しprovider idempotency付きmail jobをenqueue、success envelope |
| 未登録email | reset request | credential/token/jobを作らず同じsuccess envelope |
| SSO-only email | reset request | token/jobを作らず同じsuccess envelope |
| 上記3ケース | public応答比較 | status/body/timing policyが同じ |
| 同じoperationId/payload | 再送 | 同じ結果、token/job二重作成なし |
| mail provider一時障害 | Alarm実行 | leaseを解放しnextRunAt更新、同じprovider keyでretry |
| provider最大retry超過 | Alarm実行 | poison/terminal reasonを保存 |
| `setAlarm`失敗 | 次のDO input | DBの最早nextRunAtを再計算し再設定 |
| logを確認 | 全分岐 | email/token/locatorを含めない |
