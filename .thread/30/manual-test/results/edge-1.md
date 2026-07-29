# EDGE-1: 404 画面の余白（description あり経路）

**結果**: PASS
**セッション**: verify-authsheet

対応: エッジケース・異常系 1
実行日: 2026-07-26 / ビューポート: 1280x633 / 対象 URL: `http://localhost:3000/no-such-page`

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `agent-browser open http://localhost:3000/no-such-page` → `wait --load networkidle` | 404 画面（`AuthSheet` 経由）が表示される | `main > div` に 4 子要素。`h1`「ページが見つかりません」、`p`「URL が変わったか、削除された可能性があります」、リンク「タイムラインへ」 | PASS |
| 2 | ブランド → 見出しの間隔を計測 | 36px（`--space-section`） | 実測 36px（brand bottom 242 → h1 top 278）、`h1` の computed `margin-top: 36px` | PASS |
| 3 | 見出し → 説明文の間隔を計測 | 24px（`--space-lg`） | 実測 24px（h1 bottom 321 → p top 345）、`p` の computed `margin-top: 24px` | PASS |
| 4 | 説明文 → 「タイムラインへ」リンクラッパーの間隔を計測 | 36px（`--space-section`） | 実測 36px（p bottom 363 → wrapper top 399）、wrapper の computed `margin-top: 36px` | PASS |
| 5 | シート配下の全要素の computed `margin-bottom` を走査 | `0px` 以外が 0 件 | 0 件（`nonZeroMarginBottom: []`） | PASS |
| 6 | TC-3（`/password-reset`）の計測値と比較 | 36px / 24px / 36px で同一 | **完全一致**（top/bottom の座標まで同値: 216/242, 278/321, 345/363, 399/417） | PASS |

## 計測値

AuthSheet（`main > div`、padding 40px）の直下子要素:

| # | 要素 | クラス | margin-top | margin-bottom | 前要素との実間隔 |
|---|------|--------|-----------|---------------|-----------------|
| 0 | `div`（ブランド `fog` ロゴ） | `flex justify-center` | 0px | 0px | — |
| 1 | `h1`「ページが見つかりません」 | `mt-section text-center text-2xl font-bold leading-tight` | **36px** | 0px | **36px** |
| 2 | `p`「URL が変わったか、削除された可能性があります」 | `mt-lg text-center text-sm text-neutral-600 text-balance` | **24px** | 0px | **24px** |
| 3 | `div`（「タイムラインへ」ラッパー） | `mt-section flex flex-col` | **36px** | 0px | **36px** |

- トークン実測: `--space-section: 2.25rem`（36px）、`--space-lg: 1.5rem`（24px）
- `margin-bottom` が 0px 以外の要素: **0 件**

ルート定義外の経路（`notFoundComponent`）でも `AuthSheet` の余白の担い手が同じで、TC-3 と 1px の差もない。

## 失敗詳細

なし。
