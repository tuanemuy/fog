# TC-3: ダミーハッシュが出荷ハッシャーで読めている（等時間化が無音で死んでいない）

**結果**: PASS
**実行時間**: 約 130 秒（ブラウザ操作 + ログ確認）

対応する受け入れ基準: AC-8
実行ブランチ: `issue/20/pbkdf2-cost-parameters`
セッション: `verify-tc-b`（agent-browser）

このテストの signal は UI ではなくサーバーログ 1 行のみである。`burnVerificationTime` は例外を握り潰す設計なので、ダミーハッシュが読めなくなっていてもログインは成功し続け、画面には何も出ない。

## 実行前の基準値

テスト開始前に取得（`pnpm dev` は起動したまま。再起動していない）:

```
$ grep -c "Login timing equalisation is inactive" /tmp/manual-test-server.log
0
$ wc -l /tmp/manual-test-server.log
154
```

サーバーは本テスト以前に既に複数回のリクエストを受けている（他担当の確認項目1・2 等）。`dummyHashUnreadableReported` ラッチは isolate ごとに1回しか発火しないため、**開始時点で 0 件であること**が「まだ一度も発火していない」ことの根拠になる。

## ログ経路の健全性確認（ポジティブコントロール）

警告が出ないことを確認するテストなので、「ログ経路が生きていて、出れば拾える」ことを先に確認した。

```
$ lsof -p 78173 | grep manual-test-server
node 78173 hikaru 1w REG 1,17 7111 46553480 /private/tmp/manual-test-server.log
node 78173 hikaru 2w REG 1,17 7111 46553480 /private/tmp/manual-test-server.log
```

PID 78173 は `vite dev --config vite.config.cloudflare.ts`。stdout（1w）/ stderr（2w）とも当該ログファイルに向いている。workerd の `console.warn` が vite 経由で転送される先はこのファイルで間違いない。

## 実行ログ

手順の実行順は testing.md（手順2 = 未登録アドレス → 手順4 = 誤パスワード）と入れ替え、誤パスワード → 未登録アドレスの順で実施した。**この項目の判定は全ログの grep（件数 0）で行っており、ラッチは isolate 単位・順序非依存なので判定結果に影響しない。**（異常系1 と同一のブラウザフローを共用したため。）

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | 開始前に `grep -c "Login timing equalisation is inactive"` と `wc -l` | 開始時点の状態を控える | 0 件 / 154 行 | PASS |
| 2 | `/login` を開く（agent-browser 分離セッション = シークレットウィンドウ相当） | ログインフォームが出る | `heading "ログイン"` + メール/パスワード欄 + `button "ログイン"` | PASS |
| 3 | `pbkdf2-new@example.com` / **誤ったパスワード** `wrongpassword` で「ログイン」 | 画面に資格情報エラー。警告は出ない | `alert` に「メールアドレスまたはパスワードが正しくありません」。ログは 154 行のまま増えず | PASS |
| 4 | `no-such-user@example.com` / `password123`（**存在しないメールアドレス**）で「ログイン」 | 画面に手順3と同一の資格情報エラー。警告は出ない | 同一文言・同一位置（異常系1 で厳密比較済み）。ログは 154 行のまま増えず | PASS |
| 5 | 全ログを `grep` して警告の有無を判定 | `Login timing equalisation is inactive` が1度も出ていない | **0 件**（ファイル全体） | PASS |

## 確認ポイントの結果

- **警告の有無（本項目の全部）**: `Login timing equalisation is inactive: the password hasher could not verify the dummy hash` は**ファイル全体で 0 件**。開始前 0 件 / 終了後 0 件で変化なし。ダミーハッシュ（`DUMMY_PASSWORD_HASH_ALGORITHM_ID`）が出荷ハッシャーの `verify()` で読めており、等時間化は生きている。
- **ブラウザ Console ではなくサーバーログを見た**: `ConsoleLogger` の `console.warn` が vite の stdout に転送される先を lsof で確認したうえで grep している。
- **サーバー再起動なし**: ラッチをリセットしていない。PID 78173 は 4:25 起動のまま、テスト全体を通じて同一プロセス。
- **UI 側は無変化が正**: 手順3・4 ともログインは失敗し、資格情報エラーのみが出た。`burnVerificationTime` の握り潰しにより UI からは判定できないため、UI の観測は判定材料にしていない。

## サーバーログ（テスト中に増えた差分）

テスト開始時点 154 行 → 終了時点 **154 行（増分ゼロ）**。ログの最終エントリは 4:30:06 で、テスト実行時刻（約 4:35〜4:37）より前。つまり本テストの3回のログイン試行はログに1行も出力していない。

- `SystemError` — **出ていない**（ファイル全体で 0 件）
- `CryptoError` — **出ていない**（ファイル全体で 0 件）
- `DataIntegrityError` — **出ていない**（ファイル全体で 0 件）
- `Login timing equalisation is inactive` — **出ていない**（ファイル全体で 0 件）

上記4語はいずれも差分だけでなく**ファイル全体（154行）を対象に grep して 0 件**である。既存の 154 行に含まれる警告は #20 と無関係な TanStack Start / vite の既知警告（`createServerFn().inputValidator() is deprecated` と CSRF ミドルウェアの注意喚起）のみ。

## 失敗詳細（FAILの場合）

なし。
