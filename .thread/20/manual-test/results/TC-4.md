# TC-4: 変更前に作成したアカウントで引き続きログインできる

**結果**: PASS
**対応する受け入れ基準**: AC-7
**担当範囲**: `.thread/20/testing.md`「確認項目4」の全体。手順1〜5 は前工程で完了済み（手順3・4 の記録は [`TC-4-part1.md`](./TC-4-part1.md) を参照）。本ファイルは **手順6（実装ブランチでのログイン）** を実施し、確認項目4 全体の判定をまとめたもの。

## 前提条件（実行時に観測した状態）

| 項目 | 値 |
|---|---|
| `git branch --show-current` | `issue/20/pbkdf2-cost-parameters`（実行前・実行後とも変化なし） |
| 開発サーバー | `http://localhost:3000` 稼働中（実装ブランチのコードで起動済み。停止・再起動していない） |
| サーバーログ | `/tmp/manual-test-server.log`（実行前 **118 行**） |
| agent-browser セッション | `verify-tc-c2` |
| `pbkdf2-legacy@example.com` の保存値 | `pbkdf2-sha256$210000$QmPUp5sIAnr1Kg1WpyeOPQ==$IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=`（part1 が `main` で作成した値と一致） |

## 手順1〜5

前工程で完了済み。`pnpm dev` の停止・ブランチ切り替え・`main` での登録は本工程では**一切実施していない**。手順3・4 の観測結果は `TC-4-part1.md` に記録済み（PASS）。

## 実行ログ（手順6）

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | ログイン前に D1 の行を読む | `pbkdf2-sha256$210000$` で始まる旧形式 | `pbkdf2-sha256$210000$QmPUp5sIAnr1Kg1WpyeOPQ==$IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=`。part1 の記録とバイト単位で一致 | PASS |
| 2 | `http://localhost:3000/login` を開く | ログインフォームが表示される | `heading "ログイン" [level=1]` / メールアドレス・パスワードの textbox / `button "ログイン"` を確認 | PASS |
| 3 | `pbkdf2-legacy@example.com` / `password123` を入力して「ログイン」 | ログイン成功しタイムラインへ遷移 | 遷移後の snapshot が `heading "タイムライン" [level=1]` と `まだメモがありません`、グローバルナビゲーション（タイムライン / トピック / 検索 / ゴミ箱 / 設定）を表示。ログイン済みレイアウト | PASS |
| 4 | ログイン済みで `/settings` を開く | 登録したアドレスと認証方式が出る | `メールアドレス: pbkdf2-legacy@example.com` / `認証方式: メールアドレスとパスワード`。ハッシュ値は画面に出ていない | PASS |
| 5 | サーバーログを確認 | エラーも警告も出ない | 増分 30 行（119〜148 行目）はすべて既知・無関係。`SystemError` / `CryptoError` / `DataIntegrityError` / `Login timing equalisation is inactive` はログ全体を grep して **0 件** | PASS |

## 判定の意味

- **旧形式（`pbkdf2-sha256$`）読み取り枝の唯一の実機確認**（testing.md の確認ポイント）であり、実装ブランチの `hashFor()` に `pbkdf2-sha256` 枝が生きていることを実機で示した。
- `verify()` が「現在の設定（SHA-512 @ 210,000）」ではなく「保存値が宣言した方式とコスト（SHA-256 @ 210,000）」で導出する契約が保たれている。
- 体感: ログイン送信〜タイムライン表示まで待たされる感覚はなかった（`SHA-256 @ 210k` は `SHA-512 @ 210k` より軽い側）。ただし本項目は速度の合否判定ではない。

## サーバーログ（テスト中に増えた差分）

`/tmp/manual-test-server.log` の 119〜148 行目（118 行 → 148 行）。全 30 行が既知・無関係:

1. `4:48:47 [vite] (client) warning: .../auth/LoginForm/action.ts:7:24 createServerFn().inputValidator() is deprecated. Use createServerFn().validator() instead.`（Plugin / File の続き2行）
2. `4:48:47 [vite] (client) warning: .../auth/SignupForm/action.ts:7:25` 同内容（同じく続き2行）
3. `TanStack Start server functions are not protected by the CSRF middleware.` から始まる案内ブロック（`createCsrfMiddleware` の設定例と `disableCsrfMiddlewareWarning` の案内）
4. `4:48:55 [vite] (rsc) warning: .../auth/LoginForm/action.ts?tss-serverfn-split:7:24 createServerFn().inputValidator() is deprecated.` 同内容

**エラー・警告（本 Issue に関係するもの）: なし。**

## 失敗詳細（FAILの場合）

なし。
