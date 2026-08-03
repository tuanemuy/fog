# TC-E06: `SESSION_SECRET` / `DIRECTORY_ROUTING_SECRET` が未設定・不正だとリクエストが失敗する

**結果**: PASS
**対応する受け入れ基準**: AC-29（起動不能にせずリクエスト時に落とす）/ steps.md ステップ17 の keyring 構築時検査 (i)〜(iv)

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 0 | `apps/web/.dev.vars` をバックアップ（md5 `f3ba9dae…3999`） | — | `scratchpad/dev-vars.backup` に退避 | — |
| 0' | 破壊前のベースライン: signup サーバー関数を叩く | DO へ到達する | ログに `kind: 'conflict' / code: 'EMAIL_ALREADY_REGISTERED'` | PASS |
| 1 | `SESSION_SECRET=` （空）にして `pnpm dev` を再起動 | **起動は成功する** | `VITE v8.1.5 ready in 2141 ms` / `➜ Local: http://localhost:3000/`。起動時に落ちない | PASS |
| 2 | `GET /login` | リクエストがエラーになる | `HTTP 500`。`<title>Error</title>`、本文に `"message":"SESSION_SECRET is required and must be at least 32 characters"`。サーバーログ: `at requireSecret (packages/core/src/application/di/secrets.ts:117:11)` ← `requireSessionSecret (…:92:10)` | PASS |
| 3 | `GET /` | 同上 | `HTTP/1.1 500 Internal Server Error`（正常時は 307） | PASS |
| 4 | `SESSION_SECRET` を戻す | 正常化 | 後述の手順9で一括確認 | PASS |
| 5 | `DIRECTORY_ROUTING_SECRET` の keyring から `bucketCount` を削除 → 再起動 | 起動は成功 | `➜ Local: http://localhost:3000/`。起動時に落ちない | PASS |
| 6 | ログイン（`POST /_serverFn/<loginFn>`） | エラーになる | `HTTP 500`。本文に `"message":"DIRECTORY_ROUTING_SECRET entries must carry a bucketCount of 1 or more"`。サーバーログ: `at requireKeyring (…/di/secrets.ts:183:15)` ← `requireDirectoryRoutingKeyring (…:212:10)`。`GET /login` も同じ理由で 500 | PASS |
| 7 | `active` を2件にする（`generation` 1 と 2 の両方が role 省略 = active）→ 再起動 | 起動は成功 | `➜ Local: http://localhost:3000/` | PASS |
| 8 | ログイン | エラーになる | `HTTP 500`。サーバーログ: `DIRECTORY_ROUTING_SECRET must declare exactly one active generation` / `at requireKeyring (…/di/secrets.ts:199:11)` | PASS |
| 9 | `.dev.vars` をバックアップから復元 → 再起動 → 正常確認 | 正常に戻る | md5 が `f3ba9dae…3999` に一致。`GET /login` → 200、`GET /` → 307、signup サーバー関数 → `kind: 'conflict' / code: 'EMAIL_ALREADY_REGISTERED'`（DO 到達） | PASS |

## 確認できたこと

- **検査はリクエスト時に効いており、起動時には効いていない。** 3通りの壊し方（空の単一鍵 / `bucketCount` 欠落 / `active` 2件）すべてで `pnpm dev` の起動自体は成功し、最初のリクエストで 500 になった。Cloudflare では boot フェーズに `env` が無いので、これが正しい形である。
- **keyring の構築時検査は実装されている。** steps.md ステップ17 が要求する4項目のうち、(ii)「`active` がちょうど1件」と (iv)「`DIRECTORY_ROUTING_SECRET` は各エントリの `bucketCount >= 1`」を実際に発火させて確認した。検査点は `packages/core/src/application/di/secrets.ts` の `requireKeyring` に集約されている（`requireDirectoryRoutingKeyring` が呼ぶ）。
- 「エラーにならずそのまま動いてしまう」失敗モードは**起きていない**。

## 注意（テストケース外の観察）

`SESSION_SECRET` を空にしたときのエラー画面は vite dev のエラーオーバーレイであり、`{"message":…,"stack":…}` を含む HTML を返す。これは dev 専用の経路で、`errorResponseMiddleware` / `redactForClient` の redaction 境界より外側である。本番相当のビルド（`pnpm start` / `pnpm preview`）では同じ状況で redaction 済みの応答になる（TC-E03 の実測がその形を示している）。AC-3 の射程は本番経路なので問題ではないが、**dev のエラー表示を根拠に「漏れていない／漏れている」を判定してはならない**。

## 環境の復元

- `apps/web/.dev.vars` — バックアップから復元済み。md5 が破壊前と一致（`f3ba9daea71d4dd4b1cfbed06c1f3999`）。
- `pnpm dev` — 同じコマンド（`nohup pnpm dev > <ログパス> 2>&1 &`）で :3000 に再起動し、PID ファイルを更新済み。
