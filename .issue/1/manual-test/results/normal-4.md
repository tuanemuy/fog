# 通常系-4: ログアウトすると `/login` に戻り、以後保護画面にアクセスできない

**結果**: PASS
**対応する受け入れ基準**: AC-15（manual TC-06 / TC-23）
**実行時間**: 25

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログイン済みで `/`（タイムライン）からグローバルナビの「設定」（@e9）を押す | `/settings` へ遷移 | `http://localhost:3000/settings`。heading "設定"、メールアドレス `test@example.com`、認証方式「メールアドレスとパスワード」、button "ログアウト" を確認。`history.length` = 3 | PASS |
| 2 | 「ログアウト」（@e11）を押す | `/login` へ遷移する | `http://localhost:3000/login` へ遷移 | PASS |
| 3 | ログアウト遷移が `replace` であることを確認（`history.length` 比較） | 履歴に保護画面が残らない | ログアウト前後とも `history.length` = 3 のまま（履歴エントリが増えていない = `replace` 遷移） | PASS |
| 4 | CDP でセッション Cookie を確認 | セッション Cookie が消えている（`Max-Age=0` で失効） | `localhost` の Cookie は空配列。`fog_session` は消えている | PASS |
| 5 | ブラウザの戻るボタン（`back`）を押す | 保護画面の操作可能な状態に戻れない（`/login` へ誘導される） | `http://localhost:3000/login?redirect=%2F` へ着地。heading "ログイン" とログインフォームのみ。タイムラインの内容は復元されない | PASS |
| 6 | アドレスバーに `http://localhost:3000/` を直接入力して開く | `/login` へリダイレクト | `http://localhost:3000/login?redirect=%2F`、`h1` = 「ログイン」 | PASS |

## 補足

- 手順5の戻り先はタイムライン（`/`）の履歴エントリだが、認証必須レイアウトの先回りリダイレクトが効いて `/login?redirect=%2F` に着地するため、保護画面がキャッシュから復元されることはなかった。
