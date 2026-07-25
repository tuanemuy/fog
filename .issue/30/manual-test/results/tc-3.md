# TC-3: パスワードリセット画面の縦余白が設計と一致する

**結果**: PASS
**セッション**: verify-authsheet

対応する受け入れ基準: AC-2 / AC-4
実行日: 2026-07-26 / ビューポート: 1280x633 / 対象 URL: `http://localhost:3000/password-reset`

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | `agent-browser open http://localhost:3000/password-reset` → `wait --load networkidle` | パスワードリセット画面が表示される | `main > div`（AuthSheet）に 4 子要素（ブランド／見出し／説明文／リンクラッパー） | PASS |
| 2 | ブランド → 見出し「パスワードリセット」の間隔を計測 | 36px（`--space-section`） | 実測 36px（brand bottom 242 → h1 top 278）、`h1` の computed `margin-top: 36px` | PASS |
| 3 | 見出し → 説明文「この機能は準備中です」の間隔を計測 | 24px（`--space-lg`） | 実測 24px（h1 bottom 321 → p top 345）、`p` の computed `margin-top: 24px` | PASS |
| 4 | 説明文 → 「ログインに戻る」リンクラッパーの間隔を計測 | 36px（`--space-section`） | 実測 36px（p bottom 363 → wrapper top 399）、wrapper の computed `margin-top: 36px` | PASS |
| 5 | シート配下の全要素の computed `margin-bottom` を走査 | `0px` 以外が 0 件 | 0 件（`nonZeroMarginBottom: []`） | PASS |
| 6 | 見出しの `margin-top` を TC-1 / TC-2（description なし）と比較 | 同じ 36px | **36px で一致**（description の有無に依存しない = AC-2 の眼目） | PASS |
| 7 | `spec/design/pages/password-reset.html` の CSS と照合 | 実装値と一致 | `.page-title { margin-top: var(--space-section) }` / `.page-description { margin-top: var(--space-lg) }` / `.auth-form { margin-top: var(--space-section) }`、`margin-bottom` の記述 0 件 | PASS |

## 計測値

AuthSheet（`main > div`、padding 40px）の直下子要素:

| # | 要素 | クラス | margin-top | margin-bottom | 前要素との実間隔 |
|---|------|--------|-----------|---------------|-----------------|
| 0 | `div`（ブランド `fog` ロゴ） | `flex justify-center` | 0px | 0px | — |
| 1 | `h1`「パスワードリセット」 | `mt-section text-center text-2xl font-bold leading-tight` | **36px** | 0px | **36px** |
| 2 | `p`「この機能は準備中です」 | `mt-lg text-center text-sm text-neutral-600 text-balance` | **24px** | 0px | **24px** |
| 3 | `div`（「ログインに戻る」ラッパー） | `mt-section flex flex-col` | **36px** | 0px | **36px** |

- トークン実測: `--space-section: 2.25rem`（36px）、`--space-lg: 1.5rem`（24px）
- `margin-bottom` が 0px 以外の要素: **0 件**

設計 HTML（`spec/design/pages/password-reset.html`）との対応:

| 区間 | 設計 CSS | 設計値 | 実装計測 | 一致 |
|---|---|---|---|---|
| ブランド → 見出し | `.page-title { margin-top: var(--space-section) }` | 36px | 36px | ○ |
| 見出し → 説明文 | `.page-description { margin-top: var(--space-lg) }` | 24px | 24px | ○ |
| 説明文 → リンク | `.auth-form { margin-top: var(--space-section) }` | 36px | 36px | ○ |

## 確認ポイントの結果

- 見出しの `margin-top` が TC-1 / TC-2 と同じ 36px であること（description の有無で見出しの余白が変わらない）→ **OK**

| 画面 | description | `h1` の margin-top |
|---|---|---|
| `/login` | なし | 36px |
| `/signup` | なし | 36px |
| `/password-reset` | あり | **36px** |

## 失敗詳細

なし。
