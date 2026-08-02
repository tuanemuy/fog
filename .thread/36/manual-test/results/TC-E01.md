# TC-E01: 未認証で保護画面を直接開くと `?redirect=` 付きでログインに飛ばされ、ログイン後に戻る

**結果**: PASS
**実行時間**: 約45秒
**セッション**: verify-auth-anon（close → 再オープンでクリーンな未認証状態）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | 未認証セッションで `http://localhost:3000/settings` を直接開く | ログイン画面に飛ばされる | `heading "ログイン"` のログイン画面が描画された | PASS |
| 2 | 遷移先の URL を確認 | `/login?redirect=%2Fsettings` | `location.href === "http://localhost:3000/login?redirect=%2Fsettings"` | PASS |
| 3 | 確認項目3 の資格情報（`cf-check@example.com` / `password123`）でログイン | `/` ではなく `/settings` に戻る | 送信中に `button "ログイン中…" [disabled]` を確認後、`location.href === "http://localhost:3000/settings"`。`heading "設定"` / `heading "アカウント"` / メールアドレス `cf-check@example.com` / 認証方式「メールアドレスとパスワード」/ `button "ログアウト"` を表示 | PASS |

## 補足

- `toSafeRedirect` / `redirectSearchSchema` によるリダイレクト往復は撤去後も無傷。ログイン後の着地はタイムラインではなく `?redirect=` で指定された `/settings`。
