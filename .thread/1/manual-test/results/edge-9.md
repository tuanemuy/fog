# 異常系-9: メールアドレス最大長の境界（321文字 / 320文字）

**結果**: PASS
**対応する受け入れ基準**: AC-12（manual TC-36）

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログアウト後 `/signup` を開く | 登録フォーム表示 | 表示された（email 欄の `maxlength` は 1024 なので 321 文字が切り詰められない） | PASS |
| 2 | `a` × 309 ＋ `@example.com` = **321文字** ／ `password123` を入力 | 入力できる | `input.value.length` = **321**、`checkValidity()` = **true**（`type="email"` のネイティブ検証は通るのでサーバー経路まで到達。`noValidate` の設定は不要だった） | PASS |
| 3 | 「登録する」を押す | メールアドレス欄の**直下**に「メールアドレスの形式が正しくありません」。登録されない | URL は `/signup` のまま。email `<input>` の**直後の兄弟**として `<p id="signup-email-error" aria-live="polite" class="text-sm text-error">メールアドレスの形式が正しくありません</p>` を表示。input は `aria-invalid="true"` / `aria-describedby="signup-email-error"`。フォーム上部の `role="alert"` バナーは **null（非表示）**。DB に 300 文字以上の email は **0 件** | PASS |
| 4 | メールアドレスを `a` × 308 ＋ `@example.com` = **320文字**に調整して「登録する」 | 登録成功して `/` へ遷移 | `http://localhost:3000/` へ遷移。DB に `length(email) = 320` の行が **1 件**作成された | PASS |

## 確認ポイントの判定

**「エラーが transport 由来の汎用文言になっていないこと」→ 満たしている。**

- 表示位置: メールアドレス `<input>` の直下（項目ごとの表示）。フォーム上部の汎用バナーではない。
- 文言: `メールアドレスの形式が正しくありません`（ドメインの `IDENTITY_INVALID_EMAIL` 相当）。
- `入力形式が不正です` のような transport（`validation`）由来の文言は出現しなかった。

## 補足

- ネイティブの `type="email"` 検証は 321 文字でも `valid` を返すため、`form.noValidate` を立てずにサーバー経路まで通せた。
- 本ケースで 320 文字のメールアドレスのユーザーが 1 件新規作成された。
