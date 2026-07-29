# TC-1: ログイン画面の縦余白が設計と一致する

**結果**: PASS
**セッション**: verify-authsheet

対応する受け入れ基準: AC-3
実行日: 2026-07-26 / ビューポート: 1280x633 / 対象 URL: `http://localhost:3000/login`

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `agent-browser open http://localhost:3000/login` → `wait --load networkidle` | ログイン画面が表示される | title「ログイン」、`main > div`（AuthSheet）に 3 子要素 | PASS |
| 2 | `eval` でブランド（`div.flex.justify-center`）→ 見出し `h1`「ログイン」の間隔を計測 | 36px（`--space-section`） | 実測 36px（brand bottom 105 → h1 top 141）、`h1` の computed `margin-top: 36px` | PASS |
| 3 | 見出し → フォームラッパー（`div.mt-section.flex.flex-col`、メールアドレス欄を含む）の間隔を計測 | 36px | 実測 36px（h1 bottom 184 → wrapper top 220）、wrapper の computed `margin-top: 36px` | PASS |
| 4 | シート配下の全要素の computed `margin-bottom` を走査 | `0px` 以外が 0 件 | 0 件（`nonZeroMarginBottom: []`） | PASS |
| 5 | `spec/design/pages/login.html` の CSS を読み、`.page-title` / `.auth-form` の margin と照合 | 実装値と一致 | `.page-title { margin-top: var(--space-section) }`、`.auth-form { margin-top: var(--space-section) }`、`margin-bottom` の記述はファイル内に 0 件。トークンは `--space-section: 2.25rem`（=36px） | PASS |

## 計測値

AuthSheet（`main > div`、padding 40px）の直下子要素:

| # | 要素 | クラス | margin-top | margin-bottom | 前要素との実間隔 |
|---|------|--------|-----------|---------------|-----------------|
| 0 | `div`（ブランド `fog` ロゴ） | `flex justify-center` | 0px | 0px | — |
| 1 | `h1`「ログイン」 | `mt-section text-center text-2xl font-bold leading-tight` | **36px** | 0px | **36px** |
| 2 | `div`（フォームラッパー） | `mt-section flex flex-col` | **36px** | 0px | **36px** |

- トークン実測: `--space-section: 2.25rem`（36px）、`--space-lg: 1.5rem`（24px）
- `margin-bottom` が 0px 以外の要素: **0 件**

設計 HTML（`spec/design/pages/login.html`）との対応:

| 区間 | 設計 CSS | 設計値 | 実装計測 | 一致 |
|---|---|---|---|---|
| ブランド → 見出し | `.page-title { margin-top: var(--space-section) }` | 36px | 36px | ○ |
| 見出し → フォーム | `.auth-form { margin-top: var(--space-section) }` | 36px | 36px | ○ |

## 確認ポイントの結果

- 余白がブランド側の `margin-bottom` ではなく見出し側の `margin-top` として付いている → **OK**（ブランド `margin-bottom: 0px`、`h1` `margin-top: 36px`）
- フォームは `AuthSheet` が挿入したラッパー `div` の `margin-top: 36px` で押し下げられている → **OK**

## 失敗詳細

なし。
