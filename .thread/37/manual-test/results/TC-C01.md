# TC-C01: 2 Worker 構成でローカルが起動し、未認証がログイン画面へ誘導される

**結果**: PASS
**対応する受け入れ基準**: AC-19 / AC-29

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `pnpm dev` 単独起動（本検証開始時点で起動済み。11:39 起動） | 起動する | 起動済み。`vite dev --config vite.config.cloudflare.ts` が `http://localhost:3000/` を listen | PASS |
| 2 | `ps aux` でプロセス構成を確認 | request / state 両方が動く | node(vite) 1本 + workerd 1本のみ。**別プロセスの `wrangler dev -c wrangler.state.toml` は存在しない** | PASS |
| 3 | `curl -i http://localhost:3000/` | `HTTP/1.1 307` + `location: /login` | `HTTP/1.1 307 Temporary Redirect` / `location: /login?redirect=%2F` | PASS |
| 4 | ブラウザで `http://localhost:3000/` を開く | ログイン画面が描画される | `http://localhost:3000/login?redirect=%2F` へ遷移。`heading "ログイン" [level=1]` / `textbox "メールアドレス" [required]` / `textbox "パスワード" [required]` / `button "ログイン"` / `link "アカウント登録"` / `link "パスワードを忘れた"` | PASS |
| 5 | 起動ログの `wrangler types`（`predev:cf`）完走を確認 | 走り切っている | `$ wrangler types` → `✨ Types written to worker-configuration.d.ts`。生成された `__BaseEnv_Env` に `USER_DATA: DurableObjectNamespace /* UserDataDurableObject from fog-state */` と `IDENTITY_DIRECTORY: ...` が含まれる | PASS |
| 6 | 起動ログの D1 / Queue 系エラーを確認 | 出ない | `d1_database` / `D1Database` / `no such D1` / `EVENTS_QUEUE` / `queues` / `Cannot find binding` の一致は0件。ログ中のエラーらしき出力は `inputValidator() is deprecated` の vite warning 4件のみ（#37 と無関係の既知の非推奨警告） | PASS |

## 追加の確定事項（testing.md が「確認事項（断定しない）」として残していた論点）

**`pnpm dev` 単独で足りる。`pnpm dev:state` の併走は不要。**

根拠:

- `apps/web/wrangler.toml` の DO バインディング2本は `script_name = "fog-state"` を持つが、`apps/web/vite.config.cloudflare.ts` の `auxiliaryWorkers` が state Worker を同一 vite プロセス内で起動するため、dev registry を介した別プロセス解決は不要。
- 実測でも workerd プロセスは1本しか存在せず、その状態で `/` → `/login` の 307 と DO 経路（TC-C03 以降）が成立している。
- `apps/web/wrangler.toml` の `main` は `app/server.cloudflare.ts`（ソースエントリ）のまま。`wrangler.state.toml` の `main` のみ `dist/state/index.js`（成果物）を指す。AC-19 の「main は経路で分ける」と一致。
