# TC-4 (part1): 変更前に作成したアカウントで引き続きログインできる — 手順3・4 のみ

**結果**: PASS
**実行時間**: 約 2 分
**担当範囲**: `.thread/20/testing.md`「確認項目4」の **手順3 と手順4 のみ**。手順1・2（`pnpm dev` 停止 / `git checkout main`）はオーケストレーター実施済み、手順5・6（ブランチを戻してログイン）は別工程。

## 前提条件（実行時に観測した状態）

| 項目 | 値 |
|---|---|
| `git branch --show-current` | `main`（実行前・実行後とも変化なし） |
| 開発サーバー | `http://localhost:3000` 稼働中（main のコードで起動済み。停止・再起動していない） |
| サーバーログ | `/tmp/manual-test-server-main.log`（実行前 118 行 → 実行後 148 行） |
| `users` テーブルの既存行 | `pbkdf2-new@example.com` / `pbkdf2-timing-tca@example.com` / `pbkdf2-long@example.com` の3件。いずれも `pbkdf2-sha512$210000$…`。**触っていない** |
| `pbkdf2-legacy@example.com` | 実行前は**存在しない**ことを `SELECT` で確認済み |

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | 手順3 — `http://localhost:3000/signup` を開く | 登録フォームが表示される | `heading "アカウント登録"` / メールアドレス・パスワードの textbox / `button "登録する"` を確認 | PASS |
| 2 | 手順3 — `pbkdf2-legacy@example.com` / `password123` を入力して「登録する」 | 登録が成功しタイムラインへ遷移 | 遷移後の snapshot が `heading "タイムライン" [level=1]` と `まだメモがありません`、グローバルナビゲーション（タイムライン / トピック / 検索 / ゴミ箱 / 設定）を表示。ログイン済みレイアウト | PASS |
| 3 | 手順4 — ローカル D1 に `SELECT email, password_hash FROM users WHERE email = 'pbkdf2-legacy@example.com';` | 1行返り、`pbkdf2-sha256$210000$` で始まる | 1行返った。値は下記のとおり `pbkdf2-sha256$210000$…` | PASS |
| 4 | 手順4 — 識別子フィールドの確認 | `pbkdf2-sha256`（＝変更前の形式） | `pbkdf2-sha256` | PASS |
| 5 | 手順4 — 反復回数フィールドの確認 | `210000` | `210000` | PASS |
| 6 | 手順4 — サーバーログを確認 | エラー・警告が出ない | `SystemError` / `CryptoError` / `DataIntegrityError` / `Login timing equalisation is inactive` はいずれも **0 件**。増分は既知の無関係な警告のみ（下記） | PASS |

## 保存された値（次工程の入力）

```
email:         pbkdf2-legacy@example.com
password_hash: pbkdf2-sha256$210000$QmPUp5sIAnr1Kg1WpyeOPQ==$IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=
auth_method:   password
```

フィールド分解:

| フィールド | 値 | 検証 |
|---|---|---|
| 1: 識別子 | `pbkdf2-sha256` | **変更前の形式**。実装ブランチの `pbkdf2-sha512` ではない |
| 2: 反復回数 | `210000` | 手順書が期待する `pbkdf2-sha256$210000$` プレフィックスと一致 |
| 3: salt | `QmPUp5sIAnr1Kg1WpyeOPQ==` | base64 24文字 = **16 byte** |
| 4: derived | `IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=` | base64 44文字 = **32 byte**（`DERIVED_BITS = 256`）|

`auth_method` は `password`。既存3行（`pbkdf2-sha512$210000$…`）は変更されていない。

## サーバーログ（テスト中に増えた差分）

`/tmp/manual-test-server-main.log` の 119〜148 行目。全 30 行がすべて既知・無関係:

1. `[vite] (client) warning: .../LoginForm/action.ts:7:24 createServerFn().inputValidator() is deprecated.`
2. `[vite] (client) warning: .../SignupForm/action.ts:7:25` 同内容
3. `[vite] (rsc) warning: .../SignupForm/action.ts?tss-serverfn-split:7:25` 同内容
4. `TanStack Start server functions are not protected by the CSRF middleware.` から始まる案内ブロック

`SystemError` / `CryptoError` / `DataIntegrityError` / `Login timing equalisation is inactive` はログ全体（148行）を grep しても 0 件。

## 補足（観測されたが判定に影響しない事象）

- 登録直後の snapshot でタイムラインを確認したあと、数十秒後に同セッションへ再度 `snapshot` を投げたところ `(empty page)` になっていた。`http://localhost:3000/` を開き直すと `/login?redirect=%2F` へリダイレクトされた。**agent-browser 側のブラウザコンテキストがリセットされ Cookie が失われたため**であり、アプリ側の失敗ではない（登録自体は直後の snapshot と D1 の行の両方で成立を確認済み）。手順5・6 は別プロセス・別セッションで実施されるので次工程への影響はない。
- **ログイン確認（手順6）は指示どおり実施していない。**
- `git checkout` / `git switch` / `git stash` は一切実行していない。サーバーも停止・再起動していない。

## 失敗詳細（FAILの場合）

なし。
