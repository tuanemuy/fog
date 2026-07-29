# 異常系-5: メールアドレスの正規化（前後空白・大文字）が効く

**結果**: PASS
**対応する受け入れ基準**: AC-12（manual TC-16）
**実行時間**: 約80秒

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/signup` でメール `  New-User2@Example.COM  `（前後空白・大文字混在）／`password123` を入力して「登録する」 | 登録成功し `/` へ遷移 | 送信 FormData が `email="  New-User2@Example.COM  "` であることを確認したうえで送信 → `http://localhost:3000/` へ遷移し、タイムライン（空状態）を表示 | PASS |
| 1-a | 確認ポイント: `/settings` の表示 | 小文字・空白なしの `new-user2@example.com` | `/settings` の「メールアドレス」に `new-user2@example.com`、「認証方式」に「メールアドレスとパスワード」を表示。DB（`users.email`）も `new-user2@example.com` で保存 | PASS |
| 2 | `/settings` からログアウトし、`/login` で小文字の `new-user2@example.com` / `password123` を入力して「ログイン」 | ログインできてタイムラインが表示される | ログアウトで `/login` へ遷移 → ログイン後 `http://localhost:3000/` へ遷移し、タイムラインとグローバルナビが表示 | PASS |
| 3 | `/settings` からログアウトし、`/signup` で `NEW-USER2@EXAMPLE.COM` / `password123` を入力して「登録する」 | 正規化後の比較で重複が検出され、登録済みエラーが表示される | POST 1回。URL は `/signup` のまま、メール欄の直下に「このメールアドレスは登録済みです」＋「このメールアドレスでログインする」リンクを表示。入力値 `NEW-USER2@EXAMPLE.COM` は保持され、二重登録は発生していない（DB 上 `new-user2@example.com` は1件のみ） | PASS |

## 補足（テスト実施上の注意）

- メール欄は `type="email"` のため、**ブラウザの value sanitization が前後の空白を自動的に除去する**（`fill` 後の `input.value` は `New-User2@Example.COM` になった）。そのままでは「前後空白」がサーバーに届かないため、手順1では eval で一時的に `input.type='text'` にして生の `  New-User2@Example.COM  ` を FormData に載せ、trim がサーバー側（値オブジェクト構築）で効いていることを確認した。大文字小文字はブラウザが変換しないため、そのまま送信されている。
- 正規化は **登録（保存値）・表示（`/settings`）・ログイン・重複検出** のすべてで一貫して効いていた。
- 本ケースで **`new-user2@example.com`（入力は `  New-User2@Example.COM  `）/ `password123`** のユーザーを作成した。
