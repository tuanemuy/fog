# アカウント認証と復旧

Node runtime は Google OpenID Connect と SMTP に接続する。設定を省略すると Google ボタンを非表示にし、復旧メールは期限まで配送キューに保持する。未登録・SSO のみ・制限中・配送未設定・配送失敗の復旧依頼は同じ応答を返す。

## 設定

| 変数 | 用途 |
| --- | --- |
| `APP_URL` | 公開 origin。Google callback と復旧リンクの基準 |
| `FOG_GOOGLE_CLIENT_ID` / `FOG_GOOGLE_CLIENT_SECRET` | Google Web client。両方を設定 |
| `FOG_SMTP_HOST` / `FOG_SMTP_PORT` | SMTP 接続先。465 は TLS、その他は STARTTLS 必須 |
| `FOG_SMTP_FROM` | 送信元アドレス |
| `FOG_SMTP_USER` / `FOG_SMTP_PASSWORD` | SMTP 認証。必要な場合は両方を設定 |

Google の登録 redirect URI は `${APP_URL}/auth/google/callback`。認可・token・JWKS の接続先は Google の固定 endpoint を使う。`state`、browser cookie、認証主体、S256 PKCE、nonce、RS256 署名、issuer、audience、azp、有効期限、確認済みメールを検査する。既存メールへの自動連携は行わず、ログイン後の設定画面で追加する。

通常のパスワード変更は現在のパスワードを要求し、全 human session を終了して新しい session を同じ transaction で発行する。既存 AI 接続は維持し、認可途中の grant を破棄する。SSO のみのアカウントにはパスワード変更欄を表示しない。

復旧 token は30分・単回、依頼はメールごとに15分で3回。検索照合には hash だけを保存する。配送用 URL は同じ transaction の短期 outbox payload に保存し、配送成功・期限切れ・reset 消費・パスワード変更で消去する。5秒周期の worker は HTTP アクセスなしで動き、60秒 lease と backoff で再配送する。送信は at-least-once であり、同じ message ID を再利用する。停止時は実行中の配送を drain する。SMTP が未設定でも期限切れ秘密データを掃除する。メール本文・token・cookie・provider credential をログへ出さない。

復旧完了は全 human session を終了してログインし直し、前回の復旧以降に作られた AI 接続を失効する。初回はすべてが対象。より古い接続は完了画面で一覧確認し、すべて解除できる。同じ画面にログイン手段と Google 解除も表示する。最後のログイン手段は削除できず、メール・パスワード手段は解除できない。

## ローカル契約検証

外部サービスを使わず、OIDC の HTTP/署名交換と SMTP の受信を実行できる。

```sh
pnpm --filter @repo/web exec tsx scripts/fog-account-fixtures.ts
```

別端末で Node を起動する。既存 `.env` を書き換える必要はない。

```sh
DATABASE_URL=file:./data/app.db APP_URL=http://localhost:3000 \
FOG_GOOGLE_CLIENT_ID=fog-local-oidc \
FOG_GOOGLE_CLIENT_SECRET=local-fixture-secret \
FOG_OIDC_FIXTURE_ORIGIN=http://127.0.0.1:3457 \
FOG_SMTP_HOST=127.0.0.1 FOG_SMTP_PORT=1025 \
FOG_SMTP_FROM=fog@localhost FOG_SMTP_LOCAL=true pnpm dev
```

1. `/login` の「Googleで続行」でローカル provider に移動する。任意のテストメール・subject で初回ログインし、同じ subject で再ログインする。
2. provider のキャンセル、認証失敗、署名・issuer・audience・nonce・期限・メール確認の各失敗モードを選べる。
3. パスワードでログインし、設定の「Google連携を追加」で明示連携する。元 session を維持する。既存 subject の重複は拒否する。
4. `/password/forgot` から復旧を依頼する。`http://127.0.0.1:8025` の受信箱を開き、再設定リンクから新しいパスワードを登録する。
5. 完了画面でログイン手段と AI 接続を同時に確認し、不要な連携を解除する。使用済みリンクは再利用できない。

fixture は OIDC `127.0.0.1:3457`、SMTP `127.0.0.1:1025`、mailbox `127.0.0.1:8025` にのみ listen する。fixture origin と `FOG_SMTP_LOCAL` は HTTP loopback の `APP_URL` でのみ使用できる。mailbox のメールは秘密の復旧 URL を含み、プロセスのメモリ内だけに保持する。終了で消去される。fixture credential は実サービスの秘密情報ではない。

この fixture による成功は、実 Google client の登録・同意画面・配信審査や実 SMTP の認証・到達性・迷惑メール分類の確認を代替しない。実サービスでの確認には登録済み client、許可された送信元と受信先、実行の明示許可が必要。

実装は [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect)、[jose JWT verification](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)、[Nodemailer SMTP](https://nodemailer.com/smtp) の契約を使用する。

## 実 Google を localhost で確認する場合

Google の Web server OAuth client は、登録した localhost redirect URI で確認できる。`APP_URL=http://localhost:3000` と `http://localhost:3000/auth/google/callback` を完全一致で登録し、実 client ID/secret を設定する。`FOG_OIDC_FIXTURE_ORIGIN` を外し、同意画面のテスト対象アカウントで認証する。公開 HTTPS URL の用意は localhost 検証の必須条件ではない。Google client の種類、登録 URI、同意画面の設定を実環境で確認する。実 Google の使用許可と設定がない場合は実行しない。[Google Web server OAuth の redirect URI 制約](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation)。
