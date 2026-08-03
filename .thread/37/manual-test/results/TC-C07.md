# TC-C07: 秘密と PII が URL・画面・ログのどこにも出ない

**結果**: PASS
**対応する受け入れ基準**: AC-3

## 禁止語リストの作り方

推測ではなく、**この検証で実際に生成された値**を DO の SQLite から取り出して禁止語リスト（24件）を組んだ。read-only コピーに対して次を実行した。

- Identity Directory DO 4個から: `__miniflare_do_name`（= locator）/ `credential_mappings.hmac` / `.password_verifier` / `.encrypted_canonical` / `.caller_token` / `.coordinator_locator` / `.encryption_nonce` / `password_reset_tokens.token_hash`
- User Data DO 5個から: `account.caller_token` / `credential_locators.hmac`

得られた実値の種別（値そのものは記録しない）:

| 種別 | 件数 | 例（形だけ） |
|---|---|---|
| locator | 4 | `dir:g1:b1` / `dir:g1:b6` / `dir:g1:b7` / `dir:g1:b10` |
| HMAC（64桁 hex） | 4 | `d5168d08…`（フルレングス） |
| `passwordVerifier` | 4 | `pbkdf2-sha256$210000$…$…` |
| `callerToken`（UUID） | 4 | `019fc580-…-2668195c00ef` |
| `encryptedCanonical` + nonce | 8 | hex 文字列 |

加えて `.dev.vars` の5秘密（`SESSION_SECRET` / `AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET` / `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY`）の**値そのもの**も検査対象に加えた。

## 実行ログ

| # | 検査対象 | 方法 | 結果 | 判定 |
|---|---|---|---|---|
| 1 | dev サーバーログ全文（429行、全ケース実行後） | 禁止語24件を `grep -F`、加えてパターン `dir:g\d+:b\d+` / `[0-9a-f]{64}` / `callerToken` / `changeAuthToken` / `passwordVerifier` / `password_verifier` / `pbkdf2` / `canonical` / `reset_token` / 3つのテスト用メールアドレス | **すべて 0 件**。`userId`（`019fc5…`）すら 0 件 | PASS |
| 2 | dev サーバーログ vs `.dev.vars` の5秘密の実値 | `grep -F` | 5件とも 0 件 | PASS |
| 3 | URL バー（全遷移） | 各操作で `get url` を記録 | 現れた URL は `/`・`/login`・`/login?redirect=%2F`・`/login?redirect=%2Fsettings`・`/signup`・`/settings`・`/no-such-page` のみ。**locator も `userId` も HMAC も URL に出ない** | PASS |
| 4 | `/_serverFn/…` のレスポンスボディ | HAR 2本（2211 + 212 リクエスト）を採取し、**レスポンスボディ・レスポンスヘッダ・URL** を禁止語24件 + パターンで走査 | 禁止語 **0 件**。`dir:g…:b…` / 64桁 hex / `pbkdf2-sha256` / `callerToken` / `changeAuthToken` / `passwordVerifier` / `SQLITE_` / `encryptedCanonical` も **0 件** | PASS |
| 5 | 失敗レスポンス（誤パスワード・未登録メール・重複サインアップ） | 同 HAR | 中身は下表のとおりコード化された契約のみ。DO 側の内部詳細は無い | PASS |
| 6 | `document.cookie` | ブラウザコンソール | `""`（HttpOnly なので JS から読めない） | PASS |
| 7 | セッション cookie の中身 | CDP で取り出して base64url デコード | `{"typ":"session","uid":"019fc580-…","ep":0,"exp":1786329757963}`。**メールアドレスを含まない**。`{typ, uid, ep, exp}` ちょうど4フィールド | PASS |
| 8 | `/settings` の描画済み DOM（54 KB）と SSR HTML（18 KB） | 禁止語24件 + `dir:g…:b…` + 64桁 hex + 生メールアドレス | すべて 0 件 | PASS |
| 9 | epoch ガード失敗時の SSR レスポンス（28 KB） | `SQLITE_` / `Durable Object` / `epoch` / `stack` / `sql` / `workerd` / `internal` / `AppServerError` / `SystemError` / `ConflictError` / 禁止語24件 | **すべて 0 件**。画面に出るのは「エラーが発生しました」の汎用文言のみ | PASS |

### 失敗レスポンスの実際の中身（手順5）

| 状況 | HTTP | ボディ |
|---|---|---|
| 誤パスワード | 422 | `{"kind":"validation","code":"INVALID_CREDENTIALS","message":"Invalid email or password","retryable":false}` |
| 未登録メール | 422 | 上と**バイト単位で同一** |
| 重複サインアップ | 409 | `{"kind":"conflict","code":"EMAIL_ALREADY_REGISTERED","message":"Request failed","retryable":false}` |
| epoch 不一致 / 存在しない userId | RSC ストリーム内 | `AppServerError: Request failed`（`digest: ""`）。画面は `SettingsErrorScreen` |

いずれも `platform/stubErrors.ts` を通ったあとの形で、生のプラットフォームエラーは出ていない。

## 唯一の指摘事項（合否には影響しない）

**vite dev サーバーが返すソースファイルに `Durable Object` という語が含まれる。** HAR 走査で `Durable Object` が phase1 で 47 件・acct1 で 7 件ヒットしたが、内訳を確認したところ**全件が `text/javascript` として配信された未minify のソースコード内の JSDoc / コメント**だった。

```
200 text/javascript /app/routes/_app/settings.tsx
    …A revoked session is exactly that case: the Durable Object is the authority on revocation…
200 text/javascript /app/presentation/authState.ts
    …**It deliberately does not reach the Durable Object**, so it cannot observe a revoked epoch…
```

- エラーレスポンスでも DOM でもなく、**dev モードでソースをそのまま配信していることによるもの**。本番ビルドでは配信されない。
- 秘密・PII は一切含まれておらず、AC-3 の禁止対象（canonical / HMAC / locator / `passwordVerifier` / `callerToken` / `changeAuthToken` / リセットトークン）ではない。
- 記録のみ。修正対象とは考えていない。

## 確認ポイントの結果

- **セッション cookie が `{ typ, uid, ep, exp }` の署名付きトークンでメールを含まない** — 確認済み（手順7）。
- **エラーレスポンスに DO 側の内部詳細が生で出ない** — 確認済み（手順5 / 9）。`SQLITE_` / `Durable Object` はレスポンス経路に一切現れない。
- **`userId` が URL に出るのは設計上ありうるが locator は出てはならない** — 今回は `userId` すら URL に現れず、locator も当然現れない。
