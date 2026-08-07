# TC-edge-3: パスワード長の境界（128文字）でも登録・ログインできる

**結果**: PASS
**実行時間**: 約 120 秒

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/signup` を開く | 登録フォームが表示される | 「アカウント登録」フォーム。パスワード欄のヘルプは「8文字以上128文字以下」 | PASS |
| 2 | `pbkdf2-long@example.com` と `a` × 128 を入力して「登録する」 | 登録成功 | `/`（「タイムライン」見出し・グローバルナビゲーション）へ遷移。エラー表示なし | PASS |
| 3 | `/settings` を開く | 登録したアカウントの設定が見える | メールアドレス = `pbkdf2-long@example.com`、認証方式 = 「メールアドレスとパスワード」 | PASS |
| 4 | 「ログアウト」を押す | ログイン画面へ | `/login` の「ログイン」フォームへ遷移 | PASS |
| 5 | `/login` で `pbkdf2-long@example.com` と `a` × 128 を入力してログイン | ログイン成功 | 「タイムライン」へ遷移。ログイン成功 | PASS |
| 6 | 保存値を読む（`SELECT email, password_hash FROM users WHERE email='pbkdf2-long@example.com';`） | 識別子 `pbkdf2-sha512` / 反復 `210000` / derived 32 byte | `pbkdf2-sha512$210000$G6tKa7YX/Ff8AHtsHH+g6Q==$xshpMZ0kxMOZszcyJH0TLTlU+WZiozkawoB0vuW5RlM=`。base64 デコードで derived = **32 byte**、salt = 16 byte | PASS |

## 参考情報: 129文字の境界挙動（本 Issue では変更していない）

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| R1 | `/signup` で `pbkdf2-long129@example.com` と `a` × 129 を入力して「登録する」 | パスワード欄直下にエラーが出て登録されない | パスワード欄直下の `paragraph` に「パスワードは8文字以上128文字以下で入力してください」。`/signup` に留まり、`users` に `pbkdf2-long129@example.com` の行は作られていない | 期待どおり |

## 保存値の内訳

| 項目 | 値 |
|------|-----|
| 識別子 | `pbkdf2-sha512` |
| 反復回数 | `210000` |
| salt | `G6tKa7YX/Ff8AHtsHH+g6Q==`（16 byte） |
| derived | `xshpMZ0kxMOZszcyJH0TLTlU+WZiozkawoB0vuW5RlM=`（**32 byte**） |

確認項目2 の表と同一の識別子・反復回数。長い入力（128文字 > SHA-512 のブロック長 128 byte 境界ちょうど）でも `importKey` / `deriveBits` は壊れていない。

## サーバーログ差分

このテストケースの実行中、`/tmp/manual-test-server.log` への追記は **1行もなかった**（登録・ログアウト・ログイン・129文字の拒否のいずれもログを出していない）。テスト全体で増えた 18 行はすべて TC-edge-2 の `DATA_INTEGRITY_ERROR` ブロックであり、`TC-edge-2.md` に全文を記録した。

## 残存データ

`pbkdf2-long@example.com` のアカウントはローカル D1 に残している（テスト手順に削除の指示がないため）。`pbkdf2-long129@example.com` は登録に失敗しているので行は存在しない。
