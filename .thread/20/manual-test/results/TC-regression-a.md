# TC-regression-a: 既存機能への影響確認（セッション Cookie / `/settings` 表示 / pending 表示）

**結果**: PASS
**実行時間**: 約 40 秒（TC-1 の実行に相乗り）

担当範囲は `.thread/20/testing.md`「既存機能への影響確認」のうち次の3項目のみ。outbox / relay と `pnpm db:migrate` の冪等性は別担当。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | **セッション Cookie** — TC-1 のログイン後に `http://localhost:3000/` を再読み込み | `/login` へ戻されない | `http://localhost:3000/` のまま。タイムラインを表示 | PASS |
| 2 | **セッション Cookie** — 続けて `http://localhost:3000/settings` を開く | ログイン状態が維持される | `http://localhost:3000/settings` を表示。ログインフォームへ戻されない | PASS |
| 3 | **セッション Cookie** — TC-7 のログアウト／再ログインを合計6往復（登録1回 + ログイン5回 + ログアウト5回）繰り返す | 毎回セッションが張り直される | 全往復で成功。`/settings` から `/login` へ、ログイン後は `/` へ、と毎回期待どおり遷移 | PASS |
| 4 | **`/settings` の表示** — 「メールアドレス」の値を確認 | 登録したアドレス | `pbkdf2-new@example.com`（snapshot / `get text "body"` の両方で確認） | PASS |
| 5 | **`/settings` の表示** — 「認証方式」の値を確認 | 「メールアドレスとパスワード」 | `メールアドレスとパスワード` | PASS |
| 6 | **`/settings` の表示** — パスワードハッシュが画面に現れないこと | 現れない | `get text "body"` の全文は「タイムライン / トピック / 検索 / ゴミ箱 / 設定 / 設定 / アカウント / メールアドレス / pbkdf2-new@example.com / 認証方式 / メールアドレスとパスワード / ログアウト / - / TanStack Router」のみ。ハッシュ文字列なし | PASS |
| 7 | **`/settings` の表示** — パスワードハッシュが HTML ソースにも現れないこと | 現れない | `get html "html"` で 68,032 byte の全 HTML を取得し `grep -iE 'pbkdf2\|password_hash\|passwordHash\|\$210000\$'` を実行。**ヒット1件のみで、その中身はメールアドレス `pbkdf2-new@example.com` の文字列そのもの**（`<span ...>pbkdf2-new@example.com</span>`）。ハッシュ値・salt・derived・反復回数はいずれも HTML に出現しない | PASS |
| 8 | **pending 表示（登録）** — `/signup` 送信直後に snapshot | ボタンが「登録中…」になり無効化 | `- button "登録中…" [disabled, ref=e6]` を捕捉 | PASS |
| 9 | **pending 表示（ログイン）** — `/login` 送信直後に snapshot | ボタンが「ログイン中…」になり無効化 | `- button "ログイン中…" [disabled, ref=e7]` を捕捉 | PASS |

## 補足

- 手順6・7 の確認は `/settings` を表示中に実施。DevTools の Elements は agent-browser では使えないため、`get html "html"`（＝レンダリング後の DOM 全体）のダンプに対する grep で代替した。DevTools の Elements が見せるものと同じ内容である。
- 手順8・9 の「無効化」は snapshot の `[disabled]` 属性として観測できた。**連打による二重登録・二重ログインの試験そのものは実施していない**（担当指示は pending 表示の観測まで）が、送信中に `disabled` が付いていることは確認できているので、二重送信防御の前提は成立している。
- pending 表示が見えている時間は TC-7 の実測で 1 秒未満（ログイン送信の往復が中央値 792 ms、うちハッシュ由来は約 53 ms）。「数秒間残る」ような状態にはならなかった。

## サーバーログ（テスト中に増えた差分）

`/tmp/manual-test-server.log` の 121行目以降を確認（テスト終了時点で 154行）。

- `SystemError` — **出ていない**
- `CryptoError` — **出ていない**
- `DataIntegrityError` — **出ていない**
- `Login timing equalisation is inactive` — **出ていない**

増えた行はすべて既存・無関係の警告:

1. `[vite] (client) warning: .../LoginForm/action.ts:7:24 createServerFn().inputValidator() is deprecated. Use createServerFn().validator() instead.`
2. `[vite] (client) warning: .../SignupForm/action.ts:7:25 createServerFn().inputValidator() is deprecated. ...`
3. `[vite] (rsc) warning:` 同内容（`?tss-serverfn-split` 版）が LoginForm / SignupForm それぞれ1件
4. `TanStack Start server functions are not protected by the CSRF middleware.` から始まる案内ブロック

1〜3 はテスト開始前のログ末尾（`tail -5`）にも同じ警告が出ており既存。4 は TanStack Start の一般的な注意喚起で #20 と無関係。

**登録時の outbox / relay 由来のエラー行は増えていない**（別担当の項目だが、ログ差分の全文を読んだ結果として記録）。

## 失敗詳細（FAILの場合）

なし。
