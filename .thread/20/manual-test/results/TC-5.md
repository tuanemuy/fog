# TC-5: 旧形式の低コストフィクスチャを注入した行でログインできる

**結果**: PASS
**対応する受け入れ基準**: AC-6 / AC-7

## 前提条件

| 項目 | 値 |
|---|---|
| `git branch --show-current` | `issue/20/pbkdf2-cost-parameters`（実行前・実行後とも変化なし） |
| 開発サーバー | `http://localhost:3000` 稼働中（停止・再起動していない） |
| サーバーログ | `/tmp/manual-test-server.log`（TC-4 終了時点で 148 行） |
| agent-browser セッション | `verify-tc-c2`（TC-4 から継続。ログイン状態は `/settings` の「ログアウト」で解除してから実施） |
| 対象行 | `pbkdf2-legacy@example.com`（TC-4 実施後の値 = `pbkdf2-sha256$210000$…`） |

## 注入したフィクスチャ

steps.md ステップ3-2 で採取され、ステップ6-9 のリグレッションテストに埋め込まれているのと**同一の値**:

```
pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=
```

対応する平文: `password123`

| フィールド | 値 |
|---|---|
| 1: 識別子 | `pbkdf2-sha256`（**旧形式**） |
| 2: 反復回数 | `1000`（低コスト。`MIN_PBKDF2_ITERATIONS` と同値） |
| 3: salt | `5faRifbz4tbABUNj0fGHwg==` |
| 4: derived | `6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=` |

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `apps/web/legacy.sql` を作成（`UPDATE users SET password_hash = '…' WHERE email = 'pbkdf2-legacy@example.com';`） | ファイル作成 | 作成。`$` を含むため `.sql` ファイル経由でシェル展開を回避 | PASS |
| 2 | `pnpm db:execute:local ./legacy.sql` | 実行成功 | `1 command executed successfully.` | PASS |
| 3 | `SELECT` で注入を確認 | 上のフィクスチャと完全一致 | `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=`。**バイト単位で一致** | PASS |
| 4 | `/settings` の「ログアウト」を押す | `/login` へ戻る | `heading "ログイン" [level=1]` のフォームを表示 | PASS |
| 5 | `/login` で `pbkdf2-legacy@example.com` / `password123` を送信 | **ログイン成功** | 遷移後の snapshot が `heading "タイムライン" [level=1]` と `まだメモがありません`、グローバルナビゲーションを表示。ログイン済みレイアウト | PASS |
| 6 | `DataIntegrityError` が出ていないこと | 出ない | サーバーログに 0 件。ログ行数も 148 行のまま増えていない | PASS |
| 7 | ログイン後に再度行を読む（確認項目6 の2回目） | 値が変わらない | `pbkdf2-sha256$1000$…` のまま**バイト単位で同一**。詳細は `TC-6.md` | PASS |
| 8 | `apps/web/legacy.sql` を削除 | 残骸なし | 削除済み。`git status --short` は `?? .thread/20/manual-test/` のみ | PASS |

## 判定の意味

- **単体テストが固定しているのと同一のフィクスチャが、アプリケーション経路（DI 配線 → D1 → `PasswordHasher.verify`）でも同じ結果になる**ことを実機で突き合わせた。
- `MIN_PBKDF2_ITERATIONS`（1,000）は**ファクトリ引数の下限であって `parse()` の下限ではない**という契約が保たれている。1,000 回の行が `DataIntegrityError` にならずログインできたので、`parse()` に不要な下限チェックは足されていない。
- 体感速度: TC-4（`SHA-256 @ 210,000`）と比べて明確に速く、送信からタイムライン表示までほぼ即時だった。低コスト（1,000 回）が実際に反映されている。ただしこれは観測であって合否判定ではない。

## サーバーログ（テスト中に増えた差分）

**差分なし。** TC-5 の一連の操作（ログアウト → ログイン → 画面遷移）でログ行数は 148 行から**変化しなかった**。TC-4 で出た 30 行（vite の `inputValidator` deprecation 警告 3 件と CSRF ミドルウェアの案内ブロック）が全増分で、TC-5 由来の増分は 0 行。

`SystemError` / `CryptoError` / `DataIntegrityError` / `Login timing equalisation is inactive` — いずれもログ全体（148 行）で **0 件**。

## 後始末

- `apps/web/legacy.sql` — **削除済み**。
- `pbkdf2-legacy@example.com` の行は**注入した低コストフィクスチャのまま残している**（本工程の指示に復元手順が無いため）。元の本番強度の値へ戻す場合は `pbkdf2-sha256$210000$QmPUp5sIAnr1Kg1WpyeOPQ==$IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=` を書き戻す。
- 触らないよう指示された 3 アカウントは無変更（いずれも `pbkdf2-sha512$210000$…`）。
- `git checkout` / `git switch` / `git stash` は一切実行していない。サーバーも停止・再起動していない。

## 失敗詳細（FAILの場合）

なし。
