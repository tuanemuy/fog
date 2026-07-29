# 通常系-7: `/settings` に現在のユーザー情報が表示される

**結果**: PASS
**対応する受け入れ基準**: AC-15（UC-identity-013）
**実行時間**: 約40秒

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログイン状態で `/settings` を開く | 200 で設定画面が表示される | URL `http://localhost:3000/settings`、title「設定」、h1「設定」、h2「アカウント」 | PASS |
| 2 | メールアドレスの表示を確認 | ログイン中の `test@example.com` が表示される | ラベル「メールアドレス」＋値 `test@example.com` | PASS |
| 3 | 認証方式の表示を確認 | 認証方式（パスワード）が表示される | ラベル「認証方式」＋値「メールアドレスとパスワード」 | PASS |
| 4 | 「ログアウト」の項目を確認 | ログアウトの項目がある | `button "ログアウト"` が存在 | PASS |
| 5 | 資格情報の非露出を確認（DOM 全文 grep） | パスワードハッシュ・平文パスワード・SSO 主体 ID が現れない | `document.documentElement.outerHTML`（63,959 文字）に対し `password123` / `pbkdf2` / `argon` / `bcrypt` / `scrypt` / `passwordHash` / `password_hash` / `passwordCredential` / `ssoSubject` / `sso_subject` / `subjectId` / `subject_id` / `salt` / `$2b$` / `hash` をすべて検索 → **全件ヒット 0** | PASS |
| 6 | 資格情報の非露出を確認（サーバー生 HTML） | 同上 | セッション Cookie 付きで `GET /settings` を直接取得（200 / 15,783 bytes）し同じパターンを grep → **全件ヒット 0** | PASS |

## 確認ポイントの検証

- 画面表示・DOM（DevTools Elements 相当の `outerHTML`）・サーバーの生レスポンス HTML のいずれにも、パスワードハッシュ／平文パスワード／SSO 主体 ID を示す文字列は一切現れない。
- ハッシュアルゴリズム名（`pbkdf2` 等）や `hash` という単語自体も出力に含まれていない。
- セッション Cookie（`fog_session`）のペイロードは `{uid, exp}` のみで、資格情報を含まない。

## 失敗詳細

なし。
