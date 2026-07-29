# TC-2: アカウント登録画面の縦余白が設計と一致する

**結果**: PASS
**セッション**: verify-authsheet

対応する受け入れ基準: AC-3
実行日: 2026-07-26 / ビューポート: 1280x633 / 対象 URL: `http://localhost:3000/signup`

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `agent-browser open http://localhost:3000/signup` → `wait --load networkidle` | アカウント登録画面が表示される | `main > div`（AuthSheet）に 3 子要素、`h1`「アカウント登録」 | PASS |
| 2 | ブランド → 見出し「アカウント登録」の間隔を計測 | 36px（`--space-section`） | 実測 36px（brand bottom 107 → h1 top 143）、`h1` の computed `margin-top: 36px` | PASS |
| 3 | 見出し → フォームラッパーの間隔を計測 | 36px | 実測 36px（h1 bottom 186 → wrapper top 222）、wrapper の computed `margin-top: 36px` | PASS |
| 4 | シート配下の全要素の computed `margin-bottom` を走査 | `0px` 以外が 0 件 | 0 件（`nonZeroMarginBottom: []`） | PASS |
| 5 | TC-1（ログイン）の計測値と比較 | 36px / 36px で同一 | 完全一致（フォームの高さが違っても余白は不変） | PASS |
| 6 | `spec/design/pages/signup.html` の CSS と照合 | 実装値と一致 | `.page-title { margin-top: var(--space-section) }`、`.auth-form { margin-top: var(--space-section) }`、`margin-bottom` の記述 0 件 | PASS |

## 計測値

AuthSheet（`main > div`、padding 40px）の直下子要素:

| # | 要素 | クラス | margin-top | margin-bottom | 前要素との実間隔 |
|---|------|--------|-----------|---------------|-----------------|
| 0 | `div`（ブランド `fog` ロゴ） | `flex justify-center` | 0px | 0px | — |
| 1 | `h1`「アカウント登録」 | `mt-section text-center text-2xl font-bold leading-tight` | **36px** | 0px | **36px** |
| 2 | `div`（フォームラッパー、「メールアドレス／パスワード／8文字以上128文字以下…」） | `mt-section flex flex-col` | **36px** | 0px | **36px** |

- トークン実測: `--space-section: 2.25rem`（36px）
- `margin-bottom` が 0px 以外の要素: **0 件**

設計 HTML（`spec/design/pages/signup.html`）との対応:

| 区間 | 設計 CSS | 設計値 | 実装計測 | 一致 |
|---|---|---|---|---|
| ブランド → 見出し | `.page-title { margin-top: var(--space-section) }` | 36px | 36px | ○ |
| 見出し → フォーム | `.auth-form { margin-top: var(--space-section) }` | 36px | 36px | ○ |

## 確認ポイントの結果

- 見出しの下に余分な隙間が増えていない（条件分岐削除で `mb-lg` 相当が残っていない）→ **OK**（`h1` の `margin-bottom: 0px`、見出し → フォームの実間隔がちょうど 36px でフォーム側の `mt-section` だけで説明できる）

## 失敗詳細

なし。
