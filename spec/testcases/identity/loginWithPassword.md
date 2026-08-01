# テストケース: loginWithPassword

[usecases/identity.md](../../usecases/identity.md) の loginWithPassword に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| パスワードの検証材料を持つクレデンシャルが登録済み | 正しいメールアドレスとパスワードでログインする | `userId` が返る（セッション確立は presentation 層） | |
| 同上（メールは canonical 化して保存） | 大文字混在・前後空白付きの同一メールでログインする | 正規化後の一致でログイン成功し `userId` が返る | |
| 該当メールのクレデンシャルが未登録 | 未登録メールでログインする | `ValidationError("INVALID_CREDENTIALS")`。**存在しない場合もダミーの検証材料で同じ計算量を通す**ので、登録有無を応答時間から推測できない | |
| パスワードの検証材料を持つクレデンシャルが登録済み | 正しいメール・誤ったパスワードでログインする | `ValidationError("INVALID_CREDENTIALS")` | |
| 同一メールのクレデンシャルは存在するが、パスワードの検証材料を持たない（SSO 専用アカウント） | そのメールと任意のパスワードでログインする | `ValidationError("INVALID_CREDENTIALS")`（クレデンシャル集合の中身を明かさない） | |
| — | メール形式不正な入力でログインする | `BusinessRuleError(InvalidEmail)` ではなく `ValidationError("INVALID_CREDENTIALS")` に変換される（登録有無の推測材料を与えない） | |
| — | パスワード7文字（`PlainPassword` 要件違反）でログインする | `PasswordTooWeak` ではなく `ValidationError("INVALID_CREDENTIALS")` に変換される | |
| 上記の各失敗ケース | 未登録メール / パスワード不一致 / SSO 専用 / 形式不正の応答を比較する | すべて同一のエラー種別・メッセージであり、どれが原因かを区別できない | |
| パスワードが8文字ちょうどで登録されている | その8文字パスワードでログインする | ログイン成功（境界値: 最低長パスワードでの照合） | |
| `CredentialMappingRepository.findByEmail` で DB 例外が発生する | ログインを実行する | `SystemError` | |
| `PasswordHasher.verify` の照合計算が失敗する | ログインを実行する | `SystemError`（不一致の `false` とは区別される） | |
| 認証情報側に mapping は残っているが、ユーザー単位設定側のクレデンシャル集合に該当 `credentialId` の active な要素が無い（片方だけが残った中間状態） | 正しいメールとパスワードでログインする | **到達性検査**で拒否され `ValidationError("INVALID_CREDENTIALS")`。照合そのものが成功していても通さない | |
| ユーザー単位設定側の `credentialVersion` が認証情報側の値と一致しない | 正しいメールとパスワードでログインする | `credentialVersion` の照合で拒否され `ValidationError("INVALID_CREDENTIALS")` | |
| `changeState` が `null` でない（`'pending'` / `'advanced'`） | 旧パスワード / 新パスワードのそれぞれでログインする | クレデンシャル行が存在してもダミーの検証材料が返り、照合が成立しない。どちらも `ValidationError("INVALID_CREDENTIALS")` | |
| `nextAttemptAllowedAt` が未到達（ロックアウト中） | 正しいパスワード / 誤ったパスワードのそれぞれでログインする | どちらもダミー経路へ倒れ、成功と失敗を区別できない（未認証経路なので拒否の事実そのものを明かさない） | |
| ログインの照合が完了した | 照合結果の報告を確認する | 成功なら `failedAttempts` が 0 にリセットされ、失敗なら `failedAttempts` が前進する（`nextAttemptAllowedAt` はこのカウンタから決まる） | |
| 鍵ローテーション中で、`credential_locators` に同じ `credentialId` の行が両世代ぶん存在する | 正しいメールとパスワードでログインする | ログインできる。到達性検査が見るのは `credentialId` であり、世代は判定に影響しない | |
