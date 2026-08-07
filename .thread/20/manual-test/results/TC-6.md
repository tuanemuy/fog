# TC-6: 旧形式の行はログイン成功後も書き換わらない

**結果**: PASS
**対応する受け入れ基準**: スコープ確認（plan.md「含まれないもの」— #18 rehash-on-login は本 Issue の対象外）
**実施回数**: 2 回（TC-4 のログイン直後 / TC-5 のログイン直後）

## 前提条件

| 項目 | 値 |
|---|---|
| `git branch --show-current` | `issue/20/pbkdf2-cost-parameters`（変化なし） |
| 開発サーバー | `http://localhost:3000` 稼働中（停止・再起動していない） |
| サーバーログ | `/tmp/manual-test-server.log`（実行前 118 行 → 実行後 148 行） |

## 実行ログ

### 1 回目 — 本番強度の旧形式行（TC-4 のログイン直後）

| # | 時点 | `password_hash` | 判定 |
|---|------|-----------------|------|
| 1 | ログイン**前** | `pbkdf2-sha256$210000$QmPUp5sIAnr1Kg1WpyeOPQ==$IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=` | — |
| 2 | ログイン成功**直後** | `pbkdf2-sha256$210000$QmPUp5sIAnr1Kg1WpyeOPQ==$IP21sXoH5aLkcaIerzheECghS5bIm5VTemTl2y1m+9o=` | **バイト単位で同一** / PASS |

`auth_method` も `password` のまま変化なし。依然として `pbkdf2-sha256$` で始まる。

### 2 回目 — 低コストフィクスチャの行（TC-5 のログイン直後）

| # | 時点 | `password_hash` | 判定 |
|---|------|-----------------|------|
| 1 | 注入直後（ログイン前） | `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=` | — |
| 2 | ログイン成功**直後** | `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=` | **バイト単位で同一** / PASS |

反復回数 `1000` も書き換わっていない。**現在の設定（`pbkdf2-sha512$210000$`）への昇格は起きていない。**

## 判定の意味

- 2 回とも `pbkdf2-sha512$` に変わっていない ＝ **rehash-on-login は実装ブランチに混入していない**。本 Issue は「ハッシュ移行を一切発生させない」という前提で閉じられる。
- 反復回数の引き上げ（1,000 → 210,000）すら起きないので、「識別子だけ」でも「コストだけ」でもない、部分的な移行実装も存在しない。
- 触らないよう指示された 3 アカウント（`pbkdf2-new@example.com` / `pbkdf2-timing-tca@example.com` / `pbkdf2-long@example.com`）はいずれも `pbkdf2-sha512$210000$…` のまま変化なし。

## サーバーログ（テスト中に増えた差分）

TC-4 と同一の 30 行（119〜148 行目）。TC-5 の操作中にはログ行が 1 行も増えていない（148 行のまま）。`SystemError` / `CryptoError` / `DataIntegrityError` / `Login timing equalisation is inactive` はログ全体で 0 件。**エラー・警告なし。**

## 失敗詳細（FAILの場合）

なし。
