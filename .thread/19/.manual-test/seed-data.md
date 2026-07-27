# 手動テスト用シードデータ

Issue #19 の確認項目1（signup / settings / logout / login / session）と
確認項目6（アカウント列挙耐性）に使う、ローカル専用の準備情報である。
この準備ではサーバー起動、ブラウザ操作、アカウント作成、DO storage の直接変更を
行っていない。

## 安全境界

- 対象は `pnpm dev:cf` が使うローカル workerd のみとする。
- staging / production への deploy、remote Wrangler コマンド、Cloudflare 上の
  secret や共有データの変更は不要であり、実施しない。
- アカウントは UI の `/signup` から作る。SQLite や Durable Object storage を
  直接編集して fixture を作らない。
- `.dev.vars`、cookie 値、入力したパスワードをスクリーンショットやログへ残さない。
- ローカルデータは `apps/web/.wrangler/state` に永続化され、ブラウザの
  シークレットウィンドウを閉じても消えない。既存データとの衝突を避けるため、
  毎回新しい `RUN_ID` を使う。

## ローカル環境

前提は Node.js 22.12 以上、pnpm 11.1.2、依存関係の `pnpm install` 済みである。
起動コマンドと公開 URL は次のとおり。

```text
起動コマンド: pnpm dev:cf
公開 URL:     http://localhost:8787
永続化先:     apps/web/.wrangler/state
```

`.thread/19/testing.md` にある `http://localhost:3000` は現行の 2 Worker 構成の
公開 URL ではない。`README.md` と `apps/web/wrangler.request.toml` が示す
request Worker の `http://localhost:8787` を使用する。既に起動済みかどうかは
同ディレクトリの `server-info.md` を確認し、同じポートで二重起動しない。

## 環境変数

`apps/web/.dev.vars.example` を `apps/web/.dev.vars` へコピーし、次の3値を
それぞれ別々に `openssl rand -base64 48` で生成する。実値はこの文書へ書かない。

| キー | ローカルでの用途 |
| --- | --- |
| `SESSION_SECRET` | session cookie の署名 |
| `DIRECTORY_ROUTING_SECRET_ACTIVE` | Identity Directory の locator 導出 |
| `PITR_OPERATOR_TOKEN` | private PITR operator endpoint の認証 |

`APP_URL=http://localhost:8787` と
`DIRECTORY_ROUTING_GENERATION_ACTIVE=local-v1` は
`wrangler.request.toml` に定義済みなので `.dev.vars` への追加は不要である。
previous-generation の routing secret も今回の確認には不要である。
`wrangler.state.toml` の required secrets は空であり、上記の request-only secret を
state Worker へ渡さない。

## テストデータ

実行開始時に `RUN_ID` を一度決め、同じ値を全ケースで使う。例は
`20260728t061500-a1b2c3` である。メールアドレスには予約済みドメイン
`example.com` を使い、実在する個人情報を入れない。

| 用途 | 値 |
| --- | --- |
| password アカウント | `issue19-password-<RUN_ID>@example.com` |
| 正しいパスワード | `Manual-I19-Valid-2026!` |
| 未登録アドレス | `issue19-unknown-<RUN_ID>@example.com` |
| 誤パスワード | `Manual-I19-Wrong-2026!` |
| 不正形式アドレス | `not-an-email` |
| SSO-only の概念上の名前 | `issue19-sso-only-<RUN_ID>@example.com` |

正しいパスワードと誤パスワードはいずれも password value object の
8〜128文字制約を満たす。誤パスワードケースでは password アカウントのメールと
誤パスワードを組み合わせる。

## 確認項目1のシード作成と利用順

1. 同じシークレットウィンドウを最後まで使い、`/signup` で password
   アカウントと正しいパスワードを登録する。この signup 自体が唯一のシード作成である。
2. 登録後に認証済み画面へ遷移することを確認し、`/settings` を開く。
3. 設定画面でメールが password アカウントの値、認証方式が
   `メールアドレスとパスワード` と表示されることを確認する。
4. `fog_session` cookie が `HttpOnly`、`SameSite=Lax`、`Path=/`、
   `Max-Age=604800` で発行されていることを確認する。値そのものはコピーしない。
   ローカル HTTP では `Secure` が付かないのが想定どおりである。
5. ログアウトすると `/login` へ置換遷移し、cookie が `Max-Age=0` で失効すること、
   戻る操作で保護画面が復元されないことを確認する。
6. 同じメールと正しいパスワードで再ログインし、ページ再読み込み後も
   `/settings` を開けることを確認する。

URL、フォーム、表示値に userId、DO ID、directory routing key を入力・表示する
箇所がないことも確認する。Network / console には password hash、SSO subject、
HMAC key、DO ID が露出していないことを確認するが、cookie や request body の
秘密値を証跡へ転記しない。

## 確認項目6の手動比較

確認項目1のログアウト後に、同じ `/login` で次を順に試す。

1. 未登録アドレスと正しいパスワード。
2. password アカウントと誤パスワード。

両方とも、公開境界では次の同一結果になることを確認する。

```text
HTTP status: 422
kind:        validation
error code:  INVALID_CREDENTIALS
UI message:  メールアドレスまたはパスワードが正しくありません
```

UI は message だけを表示するため、status と code はブラウザの Network
パネルで比較する。目視の応答時間を timing equalisation の合否判定には使わない。
dummy verification の呼び出し形と PII 非記録は自動契約テストを正本とする。

## UI から作れないケース

### SSO-only

通常の `pnpm dev:cf` UI には SSO-only アカウントを作る導線がない。
`/acceptance/fixture/sso-only` は
`apps/web/app/testing/request.integration.worker.ts` だけに存在する
統合テスト専用 endpoint であり、通常の request Worker へ fixture 作成のために
追加・露出させない。したがって SSO-only は手動シード対象外とし、
`pnpm test:integration:cf` の次の契約でカバーする。

- request/state 境界テストが SSO-only fixture を隔離環境で作成する。
- 未登録、SSO-only、誤パスワード、不正形式の4応答がすべて status 422、
  `validation`、`INVALID_CREDENTIALS`、同一 public message であることを比較する。

### 不正形式メール

`/login` のメール欄は `type="email"`、`required` であるため、
`not-an-email` は通常のブラウザ操作では HTML constraint validation により
server function の送信前に止まる。このクライアント検証を
`INVALID_CREDENTIALS` の公開応答として比較してはならない。

サーバー境界での不正形式ケースは `pnpm test:integration:cf` の上記4応答比較と、
`packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` の
work-profile 契約でカバーする。後者は未登録、SSO-only、誤パスワード、不正形式が
各1回の credential lookup、password verify、authority read を通り、
ログへメールやパスワードを残さないことを検証する。

## 後片付け

シークレットウィンドウを閉じても作成したローカルアカウントは
`apps/web/.wrangler/state` に残る。現在はアカウント削除 UI がないため、
この確認の一環として storage を削除しない。次回は新しい `RUN_ID` を使う。
ローカル永続領域全体の初期化が必要な場合は、他の手動テストとサーバーが完全に
終了した後に、workspace 所有者が別作業として明示的に判断する。
