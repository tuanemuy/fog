# TC-4: サイドバーとナビシートの余白が維持されている

**結果**: PASS
**セッション**: verify-appshell

対応する受け入れ基準: AC-7

## 前提

`test@example.com` / `password123` はログインに失敗した（DB 上にユーザーは存在するが、パスワードが一致せず「メールアドレスまたはパスワードが正しくありません」）。testing.md の指示どおり `/signup` から検証用アカウント `appshell-check@example.com` / `password123` を作成してログインし、以降の確認を行った。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `/signup` で検証用アカウントを作成しログイン | `/` へ遷移 | `http://localhost:3000/` へ遷移、AppShell 表示 | PASS |
| 2 | ビューポート 1280x900 で `/settings` を開く | lg レイアウト（サイドバー表示） | `matchMedia('(min-width: 1024px)').matches === true`、`aside` 表示（幅 200px） | PASS |
| 3 | サイドバーのブランド → 先頭ナビ項目「タイムライン」の間隔を計測 | 40px（`--space-2xl`） | ブランド bottom 66px、`nav` top 106px → **40px**。担い手は `nav.mt-2xl` の `margin-top: 40px` | PASS |
| 4 | ブランドリンク `aside a` の当たり判定を計測（ADR-002 の眼目） | ロゴ直下 40px に広がっていない / `padding-bottom: 0px` | 高さ **26px**、`padding-bottom: 0px`、`margin-bottom: 0px`（設計 HTML の `.brand` は高さ 66px / `padding-bottom: 40px`） | PASS |
| 5 | ビューポート 390x844 に変更しメニューボタンを押してナビシートを開く | シートが開く | `#global-nav-sheet` 出現、背面に `inert` 付与 | PASS |
| 6 | ハンドル → 先頭項目「タイムライン」の間隔を計測 | 14px（`--space-md`） | ハンドル bottom 512.02px、ラッパー `div.mt-md` top 526.02px → **14px** | PASS |
| 7 | ハンドルの左右余白を計測（`mx-auto` を落としていないこと） | 左右が等しい | シート left 14 / right 376、ハンドル left 177 / right 213 → 左 **163px** / 右 **163px**（`margin-left/right: 139px` の auto 解決） | PASS |
| 8 | ナビ項目の `border-top` を計測（`index === 0` 分岐） | 先頭 0px、2 番目以降 1px | タイムライン **0px** / トピック **1px** / 検索 **1px** / ゴミ箱 **1px** / 設定 **1px** | PASS |
| 9 | `spec/design/pages/timeline.html` を同一ビューポートで開いて計測・比較 | 実装と一致 | サイドバー: 設計も `nav` top 106px（ブランド top 40px 起点）で **40px 一致**。ナビシート: ハンドル → 先頭項目 **14px**、左右余白 **163/163**、border-top **0/1/1/1/1** ですべて一致 | PASS |
| 10 | `margin-bottom !== 0px` の要素を走査（`/settings` 1280px / 390px シート展開時） | 0 件 | 1 件のみ: `h1.sr-only` の `margin-bottom: -1px`（Tailwind `sr-only` ユーティリティ由来。`mb-*` クラスではない）。`grep -rE '\b(mb\|my)-' apps/web/app` も 0 件 | PASS |

## 計測値

### サイドバー（1280x900、`/settings`）

| 要素 | 値 |
|---|---|
| `aside` | `px-lg pt-2xl pb-lg` → padding-top 40px / bottom 24px、幅 200px |
| ブランドリンク `aside a` | top 40, height **26**, bottom 66 / margin 0 / padding-top 0 / **padding-bottom 0px** |
| `nav.mt-2xl` | top **106** / **margin-top 40px** |
| ブランド bottom → nav top | **40px** |
| サイドリンク（各） | height 46.8、`gap-xs`(2px) で列挙、border-top すべて 0px |

### 設計 HTML（`timeline.html`、1280x900）

| 要素 | 値 |
|---|---|
| `.brand` | top 40, height **66**, bottom 106 / **padding-bottom 40px** |
| `.side-nav` | top **106** / margin-top 0px |
| 視覚的な間隔 | **40px**（実装と一致。担い手のみ `.brand` の padding-bottom → `nav` の margin-top へ移動） |

### ナビシート（390x844、`/settings`）

| 要素 | 値 |
|---|---|
| `#global-nav-sheet` | top 494.02 / left 14 / right 376 / padding-top 14px / padding-bottom 40px |
| ハンドル `div.mx-auto` | top 508.02, bottom 512.02, 36x4 / margin-left 139px / margin-right 139px（左右の視覚余白 163/163） |
| ラッパー `div.mt-md` | top **526.02** / **margin-top 14px** |
| ハンドル bottom → ラッパー top | **14px** |
| 項目 top | タイムライン 526.02 / トピック 580.81 / 検索 636.61 / ゴミ箱 692.41 / 設定 748.20 |
| 項目 border-top | **0 / 1 / 1 / 1 / 1 px** |
| 項目 margin-top・margin-bottom | 全項目 0px（余白はラッパー側が保持） |

### 設計 HTML（`timeline.html` の `.nav-sheet`、390x844）

| 要素 | 値 |
|---|---|
| `.handle` | 36x4、左右余白 **163/163**（`margin: 0 auto`） |
| `.handle + *`（`.nav-item`） | **margin-top 14px**、ハンドル bottom からの間隔 **14px** |
| `.nav-item` border-top | **0 / 1 / 1 / 1 / 1 px** |

## 気づいた点

- 実装の項目高さは 54.80 / 55.80px、設計 HTML は 55 / 56px。フォント（本文の line-height）差による 0.2px 未満の違いで、余白の担い手には無関係。
- 設計 HTML の `.brand` はクリック可能な `<a>` に `padding-bottom: 40px` が乗っており、ロゴ直下 40px までが当たり判定になる。実装はその 40px を `nav` の `margin-top` へ移し、当たり判定を 26px に留めている（ADR-002 の意図どおり）。視覚上の間隔は両者とも 40px で完全に一致。
