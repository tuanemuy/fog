# 異常系-10: `SESSION_SECRET` 未設定・不正時の起動時エラー

**結果**: PASS
**対応する受け入れ基準**: AC-17（plan.md ステップ11「秘密鍵の検証は `createXxxRequestContainer` で行う」）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 0 | `apps/web/.env` をバックアップ | バックアップが取れる | `/tmp/fog-env-backup-1784960420.env` と `apps/web/.env.bak-manualtest` に退避 | PASS |
| 1 | `pnpm dev` を停止（`kill $(cat /tmp/manual-test-server.pid)`） | 停止する | プロセス停止。`curl http://localhost:3000/login` は接続不能（`000`） | PASS |
| 2 | `SESSION_SECRET` を `short` に変更して `pnpm dev` を起動 | 起動する | Vite dev は起動（`VITE v8.1.5 ready in 729 ms`）。この時点ではまだエラーなし（秘密鍵の検証はリクエストパスで行う設計どおり） | PASS |
| 3 | `http://localhost:3000/login` を開く | リクエスト処理時に明確なエラー | **HTTP 500**。サーバーログに以下の明確な例外:<br>`Error: SESSION_SECRET is required on the request path and must be at least 32 characters`<br>`  at requireSessionSecret (packages/core/src/application/di/secrets.ts:60:11)`<br>`  at readNodeRequestServerConfig (packages/core/src/application/di/serverNode.ts:115:31)`<br>`  at boot (apps/web/app/server.node.ts:90:18)` | PASS |
| 4 | セッションが不正な鍵で発行されないこと | 発行されない | レスポンスヘッダに **`Set-Cookie` なし**。ブラウザで開いても Cookie は **0 件**、タイトルは `Error`（Vite のエラーオーバーレイ）。`/` `/settings` も同じく **500**（保護画面に入れない） | PASS |
| 5 | エラーメッセージに秘密鍵の値そのものが出ないこと | 出ない | サーバーログ中の `SESSION_SECRET=short` の出現 **0 件**、リテラル `short` の出現も `at least 32 characters` の文言以外 **0 件**。レスポンス本文（HTML）中の `short` も **0 件**。長さ不足という事実のみを報告している | PASS |
| 6 | `SESSION_SECRET` を 32 文字以上に戻し、`pnpm dev` を再起動 | 正常に戻る | `.env` をバックアップから復元（`diff` で**バイト単位一致**を確認）。`nohup pnpm dev > /tmp/manual-test-server.log` で再起動（PID 67674） | PASS |
| 7 | 復旧のヘルスチェック | `/login` が 200 | `/login` = **200**（1回目の試行で成功）、`/signup` = **200**、`/`（未ログイン）= **307** → `/login?redirect=%2F`。`test@example.com` / `password123` でログインすると `/` へ遷移し `fog_session` Cookie が正しく発行される | PASS |

## 秘密鍵の露出チェック（詳細）

| 対象 | 検査 | 結果 |
|---|---|---|
| `/tmp/manual-test-server-broken.log` | `grep -c "SESSION_SECRET=short"` | **0** |
| 同上 | `grep -nE "\bshort\b"`（`at least 32 characters` の行を除外） | **0 件** |
| `/login` のレスポンス HTML | `grep -c "short"` | **0** |
| `/login` のレスポンスヘッダ | `Set-Cookie` | **なし** |

エラー文言は `SESSION_SECRET is required on the request path and must be at least 32 characters` のみで、**値も長さの実測値も含まない**。

## 補足

- 検証は `packages/core/src/application/di/secrets.ts` の `requireSessionSecret` が投げており、plan.md ステップ11 が意図した「リクエストコンテナ構築時の検証」の位置と一致している。
- プロセス起動時ではなくリクエスト処理時にエラーになる（＝ worker ロールは秘密鍵なしでも起動できる）挙動は `apps/web/.env.example` のコメント（"Required by the request path only — the worker roles boot without it"）どおり。
- 検証用ログは `/tmp/manual-test-server-broken.log` に残してある。
- **`.env` は元に戻し済み**（`SESSION_SECRET=dev-only-session-secret-change-me-0123456789`）。一時ファイル `apps/web/.env.bak-manualtest` は削除済み。サーバーは復旧状態で起動したまま。
