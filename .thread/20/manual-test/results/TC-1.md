# TC-1: 新規登録 → ログアウト → ログインの往復がブラウザで通る

**結果**: PASS
**実行時間**: 約 70 秒（ブラウザ操作のみ。手順1〜5）

対応する受け入れ基準: AC-4 / AC-8（実行経路として）
実行ブランチ: `issue/20/pbkdf2-cost-parameters`
セッション: `verify-tc-a`（agent-browser）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `http://localhost:3000/` を開く（agent-browser の分離セッション。シークレットウィンドウ相当） | `/login` へ誘導される | `http://localhost:3000/login?redirect=%2F` へリダイレクト。`heading "ログイン"` を確認 | PASS |
| 2 | 「アカウント登録」リンク（`@e2`）をクリック | `/signup` へ移る | `http://localhost:3000/signup`。`heading "アカウント登録"` + メール/パスワード欄 + `button "登録する"` を確認 | PASS |
| 3 | メール `pbkdf2-new@example.com` / パスワード `password123` を入力し「登録する」を押す | 登録成功しタイムライン（`/`）へ遷移 | 送信直後の snapshot で `button "登録中…" [disabled]` を捕捉。遷移後 `http://localhost:3000/` で `heading "タイムライン"` + 「まだメモがありません」 | PASS |
| 4 | ブラウザを再読み込み（`open http://localhost:3000/`） | `/login` へ戻されない | `http://localhost:3000/` のまま。タイムライン表示継続 | PASS |
| 5 | `/settings` を開く | ログイン状態が維持されている | `http://localhost:3000/settings`。「メールアドレス: pbkdf2-new@example.com」「認証方式: メールアドレスとパスワード」を表示 | PASS |
| 6 | 「ログアウト」（`@e11`）を押す | ログアウトされる | `http://localhost:3000/login` へ遷移。ログインフォームを表示 | PASS |
| 7 | `/login` で `pbkdf2-new@example.com` / `password123` を入力し「ログイン」を押す | ログイン成功しタイムラインへ遷移 | 送信直後の snapshot で `button "ログイン中…" [disabled]` を捕捉。遷移後 `http://localhost:3000/` | PASS |

## 確認ポイントの結果

- **pending 表示**: 登録・ログインとも捕捉できた。登録時 `button "登録中…" [disabled=true]`、ログイン時 `button "ログイン中…" [disabled=true]`。いずれも送信中はボタンが無効化されている。
- **識別子の食い違い（`hash()` と `verify()`）**: 手順3の登録と手順7のログインが両方成功したので、書き込み側と読み取り側の識別子は一致している。
- **サーバーログ**: 下記のとおりエラーなし。

## サーバーログ（テスト中に増えた差分）

`/tmp/manual-test-server.log` の 121行目以降（テスト開始時点の末尾）を確認。

- `SystemError` — **出ていない**
- `CryptoError` — **出ていない**
- `DataIntegrityError` — **出ていない**
- `Login timing equalisation is inactive` — **出ていない**

増えた行はすべて #20 と無関係な既存の警告のみ:

- `[vite] (client/rsc) warning: ... createServerFn().inputValidator() is deprecated. Use createServerFn().validator() instead.`（`LoginForm/action.ts:7:24` / `SignupForm/action.ts:7:25`。テスト開始前のログ末尾にも同じ警告があり、既存）
- `TanStack Start server functions are not protected by the CSRF middleware.`（TanStack Start の一般的な注意喚起。#20 と無関係）

登録時の outbox / relay 由来のエラーログも増えていない。

## 失敗詳細（FAILの場合）

なし。
