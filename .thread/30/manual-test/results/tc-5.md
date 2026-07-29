# TC-5: 設定画面の見出しまわりの余白が変わっていない

**結果**: PASS
**セッション**: verify-appshell

対応する受け入れ基準: AC-5

## 前提

`test@example.com` / `password123` ではログインできなかった（DB にユーザーは存在するがパスワード不一致）。testing.md の指示に従い `/signup` から `appshell-check@example.com` / `password123` を作成してログインした。表示メールアドレスがこのアカウントである点以外、計測対象の DOM 構造は同一。

## 実行ログ

| # | 操作 | 期待結果 | 実際の結果 | 判定 |
|---|------|---------|-----------|------|
| 1 | 検証用アカウントでログイン | 認証済み状態になる | `/` へ遷移 | PASS |
| 2 | `/settings` を開く（1280x900） | `CurrentUserPanel` が表示される | 見出し「アカウント」+ メールアドレス行 + 認証方式行 + ログアウトが表示 | PASS |
| 3 | 見出し「アカウント」→「メールアドレス」行の間隔を計測 | 8px（`--space-sm`）、`mt-sm` が先頭行側 | 見出し bottom 99.34、行 top 107.34 → **8px**。担い手は先頭行の `mt-sm`（`margin-top: 8px`）、見出しは `margin-top/bottom` ともに 0px | PASS |
| 4 | 2 行目「認証方式」の `margin-top` を確認（8px の二重掛かりが無いこと） | 0px | **margin-top 0px**、`border-t` 1px で隣接（top 157.17 = 1 行目 bottom 157.17） | PASS |
| 5 | 行のリズム（padding・境界線・ログアウト上の余白）を確認 | 変更前と同じ | 両行とも `py-row` = padding 16px/16px、2 行目とログアウトブロックに `border-top: 1px`、ログアウトブロックは `pt-lg` = **padding-top 24px**、margin はすべて 0px | PASS |
| 6 | `margin-bottom !== 0px` の要素を走査 | 0 件 | `h1.sr-only`（`-1px`、Tailwind `sr-only` 由来）のみ。`grep -rE '\b(mb\|my)-' apps/web/app` は 0 件 | PASS |
| 7 | `spec/design/pages/settings.html` の `.section-head` / `.section-head + *` と比較 | — | 設計は `.section-head + * { margin-top: 12px }`（実測 12px）、実装は 8px。**Issue #30 が明示的に `mt-sm`（8px）を指示しているための意図的な据え置きで FAIL ではない** | PASS（据え置き） |

## 計測値

### 実装（`/settings`、1280x900）

| 要素 | クラス | top | height | margin-top | margin-bottom | padding | border-top |
|---|---|---|---|---|---|---|---|
| `h2` アカウント | `text-xs font-semibold uppercase tracking-label` | 84 | 15.34 | 0px | 0px | 0 | 0px |
| メールアドレス行 | `flex ... py-row **mt-sm**` | 107.34 | 49.83 | **8px** | 0px | 16px / 16px | 0px |
| 認証方式行 | `flex ... py-row border-t border-neutral-100` | 157.17 | 50.83 | **0px** | 0px | 16px / 16px | 1px |
| ログアウトブロック | `border-t border-neutral-100 pt-lg` | 208 | 58.83 | 0px | 0px | **24px** / 0 | 1px |

区間:
- 見出し → 先頭行: **8px**（期待 8px）
- 先頭行 → 2 行目: **0px**（`border-top` で区切り、余白の二重掛かりなし）
- 2 行目 → ログアウトブロック: **0px** + ブロック内 `padding-top 24px`

### 設計 HTML（`settings.html`、1280x900）

| 要素 | 値 |
|---|---|
| `.section-head` | top 84 / height 17 / margin 0 |
| `.section-head + *`（`.client-row`） | top 113 / **margin-top 12px** → 間隔 **12px** |

## 気づいた点

- 設定画面の見出し下は設計 12px / 実装 8px の差があるが、Issue #30 が `mt-sm`（8px）を明示指定しているため意図的な据え置き。将来設計に合わせるなら `--space-md`(14px) ではなく 12px 相当のトークンが必要になる（現状のトークンには 12px が無く、`sm`=8px と `md`=14px の間になる）。
- 余白の担い手はすべて「次の要素の `margin-top`」に統一されており、`CurrentUserPanel` 内に `margin-bottom` を持つ要素は 1 つも無い。
