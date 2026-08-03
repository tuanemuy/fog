# TC-C09: `pnpm start` / `pnpm preview` の起動可否を確定させる（#40 の解消確認）

**結果**: PASS
**対応する受け入れ基準**: AC-28

## 確定した分岐

**(a) 両方起動する。** `CLAUDE.md` / `README.md` の「`pnpm start` / `pnpm preview` は起動しない（#40）」という但し書きは削除してよい。

ただし `pnpm start` には**新しい前提条件が2つ**あり、但し書きを単に消すだけでは AC-28 の「記述が新構成と一致していること」を満たさない。下記「新しい前提条件」を参照。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `pnpm build:cf` 済みで `pnpm start`（= `wrangler dev`） | 起動する | `[wrangler:info] Ready on http://localhost:8787`。wrangler 4.114.0 | PASS |
| 2 | 起動ログに `Disallowed operation called within global scope` が出ないこと | 出ない | `grep -c "Disallowed operation"` = **0** | PASS |
| 3 | `http://localhost:8787` を開いてログイン画面 | ログイン画面 | `GET /` → `HTTP/1.1 307` + `Location: /login?redirect=%2F`。`GET /login` → 200、`<title>ログイン</title>`、`<h1 …>ログイン</h1>`、`<input id="login-email" type="email" name="email">` / `<input id="login-password" type="password" name="password">`、`アカウント登録` リンクあり | PASS |
| 4 | `pnpm dev:state` の併走が要るか | 要否を確定 | **要る（fog-state を供給するプロセスが1つ必要）。** 詳細は下記 | PASS（確定） |
| 5 | `pnpm preview`（= `vite preview --config vite.config.cloudflare.ts`）で 1〜3 | 起動してログイン画面 | `➜ Local: http://localhost:4173/`。`Disallowed operation` 0件。`GET /` → 307 + `location: /login?redirect=%2F`、`GET /login` → 200 + `<title>ログイン</title>` + `<h1>ログイン</h1>`。**DO への到達も確認**（下記） | PASS |

## 手順4 の確定内容 — `pnpm start` は fog-state の供給元を1つ必要とする

`wrangler.toml` の DO バインディングは `script_name = "fog-state"` なので、`pnpm start` の Worker は**別プロセスが dev registry に登録した fog-state** を参照する。供給元は `pnpm dev`（`vite.config.cloudflare.ts` の `auxiliaryWorkers`）でも `pnpm dev:state` でもよい。

実測（`pnpm start` を起動したまま供給元を切り替えた）:

| 供給元の状態 | `pnpm start` のバインディング表示 | DO を叩くリクエスト |
|---|---|---|
| `pnpm dev` 稼働中 | `env.USER_DATA … local [connected]` / `env.IDENTITY_DIRECTORY … local [connected]` | 成功（Identity Directory DO まで到達し `EMAIL_ALREADY_REGISTERED` が返る） |
| 供給元なし | `… local [not connected]` | 失敗（21ms で 500。詳細は TC-E03） |
| `pnpm dev:state` のみ稼働 | `… local [connected]` | 成功（`EMAIL_ALREADY_REGISTERED`） |

供給元が無くても**起動自体は成功し、DO を叩かない画面（`/login`・`/` の 307・404）は正常に返る。** 落ちるのは DO を叩く実行点だけである。

**`pnpm dev:state` は 8787 が塞がっていると 8788 へ退避する**（実測: `pnpm start` が 8787 を握った状態で `[wrangler:info] Ready on http://localhost:8788`）。state Worker には公開ルートが無いのでポートは実害を持たない。

## 新しい前提条件（但し書きの書き換え先）

1. **`pnpm start` は `pnpm build:cf` 済みでないと成立しない。** 実測ログ:

   ```
   Using redirected Wrangler configuration.
    - Configuration being used: "dist/server/wrangler.json"
    - Original user's configuration: "wrangler.toml"
    - Deploy configuration file: ".wrangler/deploy/config.json"
   ```

   `wrangler dev` は `wrangler.toml` ではなく、vite ビルドが書いた `.wrangler/deploy/config.json` の redirect 経由で `dist/server/wrangler.json` を読む。`dist` が無ければ redirect 先が無い。`pnpm preview` も同様に `Using secrets defined in dist/server/.dev.vars` と出るのでビルド前提である。

2. **`APP_URL` が `http://localhost:3000` 固定なので、8787 / 4173 で動かすと canonical / `og:url` が 3000 を指す。** 実測: 8787 で開いた `/login` の `og:url` は `http://localhost:3000/login`。これは `wrangler.toml` / `wrangler.state.toml` のコメントが既に予告している既知の挙動で、#37 が壊したものではない。

3. DO を叩く動線を通すには fog-state の供給元が要る（上記）。

## DO 到達性の確認方法（参考）

ブラウザを使わずに DO 到達性を確かめるため、`POST /_serverFn/<signupFn の id>` に seroval 形式で `{data:{email:"do-check@example.com",password:"password123"}}` を送り、サーバーログに `kind: 'conflict' / code: 'EMAIL_ALREADY_REGISTERED'` が出ることを判定材料にした（TC-C03 で作られたアカウントに当たる）。

- `pnpm start`（8787）: `EMAIL_ALREADY_REGISTERED` を確認 → Identity Directory DO へ到達
- `pnpm preview`（4173）: `EMAIL_ALREADY_REGISTERED` を確認 → 同上

なお素の `curl` でサーバー関数を叩くと、成功・失敗にかかわらずクライアントには `{"status":500,"unhandled":true,"message":"HTTPError"}` が返る（TanStack のクライアント側ヘッダが無いため）。ブラウザ経路の判定は別エージェントの TC-C01〜TC-E07 が担保している。
