# 通常系-5: 未ログインで保護 URL に直アクセスするとログイン後に元の URL へ戻る

**結果**: PASS
**対応する受け入れ基準**: AC-9（manual TC-22）
**実行時間**: 34

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログアウト状態で `http://localhost:3000/settings` を直接開く | `/login?redirect=/settings` へ誘導され、設定画面の中身は表示されない | `http://localhost:3000/login?redirect=%2Fsettings` へ遷移。画面はログインフォームのみ。`body.innerText` に `test@example.com`・「ログアウト」は含まれない（設定画面の中身は非表示） | PASS |
| 2 | 遷移先 URL を確認 | URL に `?redirect=/settings` が付いている | `?redirect=%2Fsettings`（`/settings` の URL エンコード） | PASS |
| 3 | メール欄（@e3）に `test@example.com` → Tab → パスワード欄（@e4）に `password123` を入力し「ログイン」（@e5）を押す | タイムラインではなく `/settings` へ戻る | `http://localhost:3000/settings` へ遷移。`h1` = 「設定」 | PASS |
| 4 | 【確認ポイント】ログアウト後、`http://localhost:3000/trash` を直接開く | 同じ挙動（`/login?redirect=/trash`） | `http://localhost:3000/login?redirect=%2Ftrash`、`h1` = 「ログイン」 | PASS |
| 5 | 同じ資格情報でログインする | `/trash` へ戻る | `http://localhost:3000/trash` へ遷移。`h1` = 「ゴミ箱」 | PASS |

## 補足

- `/settings`・`/trash` のどちらでも `?redirect=` に元のパスが積まれ、ログイン後にタイムライン（`/`）ではなく元の保護 URL に復帰することを確認した。
