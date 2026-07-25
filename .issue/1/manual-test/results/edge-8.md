# 異常系-8: パスワード最大長の境界（129文字 / 128文字）

**結果**: PASS
**対応する受け入れ基準**: AC-12（manual TC-35）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログアウト後 `/signup` を開く | 登録フォーム表示 | 表示された。入力欄の `maxlength` は email / password とも **1024**（transport スキーマの上限緩和が UI にも反映されている） | PASS |
| 2 | `boundary2@example.com` ＋ `a` × **129** で「登録する」 | パスワード欄の**直下**に「パスワードは8文字以上128文字以下で入力してください」。登録されない | URL は `/signup` のまま。パスワード `<input>` の**直後の兄弟**として `<p id="signup-password-error" aria-live="polite" class="text-sm text-error">パスワードは8文字以上128文字以下で入力してください</p>` を表示。input は `aria-invalid="true"` / `aria-describedby="signup-password-helper signup-password-error"`。DB の `boundary2@example.com` は **0 件** | PASS |
| 3 | 汎用文言でないことを確認 | 「入力形式が不正です」等の transport 由来文言でないこと | フォーム上部の汎用エラーバナー（`role="alert"`）は**存在せず**、表示はドメイン由来の「パスワードは8文字以上128文字以下で入力してください」のみ | PASS |
| 4 | パスワードを `a` × **128** に直して「登録する」 | 登録成功して `/` へ遷移 | `http://localhost:3000/` へ遷移。DB の `boundary2@example.com` が **1 件**に増加 | PASS |
| 5 | `/settings` からログアウトし、`/login` で `boundary2@example.com` ＋ `a` × 128 でログイン | ログインできる | `http://localhost:3000/` へ遷移し、タイムライン（ナビ5項目＋「まだメモがありません」）を表示 | PASS |

## 確認ポイントの判定

**「129文字のエラーが transport 由来の汎用文言になっていないこと」→ 満たしている。**

- 表示位置: パスワード `<input>` の直下（`signup-password-error`）。フォーム上部バナーではない。
- 文言: `パスワードは8文字以上128文字以下で入力してください`（ドメインの `PasswordTooWeak` 相当）。
- `入力形式が不正です` / `validation` 由来の文言は出現しなかった。
- `maxlength="1024"` により 129 文字がブラウザ側で切り詰められることもなく、サーバー経路まで到達している。

## 補足

- メールアドレス欄の値はエラー後も `boundary2@example.com` が保持されていた。
- 本ケースで `boundary2@example.com`（パスワード = `a` × 128）が新規作成された。
