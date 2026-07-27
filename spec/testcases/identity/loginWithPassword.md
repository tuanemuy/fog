# テストケース: loginWithPassword

| 前提 | 操作 | 期待結果 |
|---|---|---|
| active password credential | 正しいemail/password | active/previous locator lookupとhash verify後にuserId/session |
| emailは正規化前の大文字/空白付き | login | 正規化後locatorで同じaccount |
| 未登録email | login | dummy verifyを1回行い`INVALID_CREDENTIALS` |
| SSO-only email | password login | dummy verifyを1回行い`INVALID_CREDENTIALS` |
| password誤り | login | 実verifyを1回行い`INVALID_CREDENTIALS` |
| email/password形式不正 | login | dummy verifyを1回行い`INVALID_CREDENTIALS` |
| 上記4失敗 | public応答/ログを比較 | 種別・message・statusが同じでPII/分岐理由なし |
| previous key generationにmapping | login | active/previous lookupで成功 |
| Account Homeがdeleting/deleted | login | unauthorized、credentialを再利用しない |
| mapping epochとAccount Home epoch不一致 | login | retryable/unauthorizedとしてfail closed |
| Directory/Account Home/hash基盤障害 | login | serialized `SystemError`、PIIなし |
