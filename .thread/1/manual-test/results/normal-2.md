# 通常系-2: `/signup` でメール＋パスワード登録ができ、タイムラインへ遷移する

**結果**: PASS
**対応する受け入れ基準**: AC-12 / AC-3（manual TC-02）
**実行時間**: 126

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/login` で「アカウント登録」リンク（@e6）をクリック | URL が `/signup` になる | `http://localhost:3000/signup` に遷移。heading "アカウント登録"、メール/パスワード欄、「8文字以上128文字以下」ヒント、button "登録する"、link "ログイン" を確認 | PASS |
| 2 | メール欄（@e3）に `test@example.com` を入力 → Tab → パスワード欄（@e4）に `password123` を入力 | 入力できる | 入力完了 | PASS |
| 3 | 「登録する」（@e5）をクリック | 送信中はボタンが無効化され進行表示が出る | 送信ボタンの状態を 15ms 間隔で記録した結果、`disabled=false / "登録する"` → `disabled=true / aria-busy=true / "登録中…"` → 遷移、と遷移した | PASS |
| 4 | 遷移先を確認 | `/`（タイムライン）へ遷移し、空状態のタイムラインとグローバルナビが表示される | `http://localhost:3000/` に遷移。heading "タイムライン"、`main` に「まだメモがありません」、navigation "グローバルナビゲーション"（タイムライン/トピック/検索/ゴミ箱/設定の5項目）を確認 | PASS |
| 5 | ブラウザ再読み込み（reload） | ログイン状態が維持され `/login` へ戻されない | reload 後も URL は `http://localhost:3000/`、`h1` は「タイムライン」。`/login` へのリダイレクトなし | PASS |
| 6 | `document.cookie` を確認 | セッション Cookie が JS から読めない（HttpOnly） | `document.cookie` は空文字。セッション Cookie は JS から不可視 | PASS |
| 7 | CDP（`Network.getAllCookies`）でセッション Cookie の属性を確認 | `HttpOnly` / `SameSite=Lax` / `Path=/` が付いている | `name: "fog_session"`, `httpOnly: true`, `sameSite: "Lax"`, `path: "/"`, `domain: "localhost"`, `secure: false`, 有効期限あり（session: false） | PASS |

## 補足

- 手順7の Cookie 属性は `agent-browser cookies get` が本環境で空配列を返すため、CDP の `Network.getAllCookies` を直接叩いて確認した（`HttpOnly` Cookie も含めて取得できる）。
- `secure: false` は `http://localhost` での開発環境のため妥当（TC の確認対象は `HttpOnly` / `SameSite=Lax` / `Path=/` の3点）。
- 実行時間には、途中で agent-browser のバックグラウンドデーモンが再起動しブラウザが初期化された分の再実行が含まれる（アプリ側の事象ではない）。
