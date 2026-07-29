# 通常系-1: 未ログインでトップにアクセスするとログイン画面に誘導される

**結果**: PASS
**対応する受け入れ基準**: AC-9（manual TC-01）
**実行時間**: 20

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | 新規セッション（未ログイン）で `http://localhost:3000/` を open | `/login` へリダイレクト | `http://localhost:3000/login?redirect=%2F` へ遷移 | PASS |
| 2 | `get url` で URL 確認 | `/login` | `http://localhost:3000/login?redirect=%2F`（パスは `/login`、`redirect=/` が付与） | PASS |
| 3 | `snapshot` で画面要素確認 | 見出し「ログイン」・「メールアドレス」入力欄・「パスワード」入力欄・送信ボタン「ログイン」・「アカウント登録」リンク・パスワードリセットリンク | heading "ログイン" (e1) / textbox "メールアドレス" (e3, required) / textbox "パスワード" (e4, required) / button "ログイン" (e5) / link "アカウント登録" (e6) / link "パスワードを忘れた" (e7) すべて存在 | PASS |
| 4 | SSO ボタンの非表示確認（snapshot + HTML grep: google/github/sso/続ける） | SSO ボタンが表示されないこと | 該当要素・文字列ともに 0 件 | PASS |
| 5 | `curl -i http://localhost:3000/` でリダイレクト種別を確認 | タイムラインの中身が一瞬でも見えないこと | HTTP 307 + `location: /login?redirect=%2F`。ボディにタイムライン内容は含まれずサーバー側で先回りリダイレクト | PASS |

## 補足

- URL は素の `/login` ではなく `/login?redirect=%2F` になるが、これは確認項目5（`?redirect=` による復帰経路）の仕様と一貫した挙動であり、`/login` 画面が表示されるという期待は満たしている。
- リダイレクトは 307（サーバー側）なので、認証必須レイアウトの「先回りリダイレクト」が効いており、タイムラインの DOM は一度も描画されない。
