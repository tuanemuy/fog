# 実装計画 — Issue #30: デザインの余白ルール（縦余白は上に付ける）を実装に反映する

**Issue:** #30
**作成日:** 2026-07-26
**複雑度:** 小規模

---

## 目的

`spec/design/tokens.md` の「余白の向き」（縦余白は必ず上に付ける）を `apps/web/app` に反映し、残っている `mb-*` 6 箇所を `mt-*` / コンテナ側の余白に反転する。以降の画面実装（#2〜#15）が最初から正しい形で書ける状態にする。

## 受け入れ基準

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `grep -rE '\b(mb\|my)-' apps/web/app` が 0 件 | Issue 完了条件 | 1〜4 |
| AC-2 | `AuthSheet` の `description === undefined ? "mb-section" : "mb-lg"` 条件分岐が削除されている | Issue 対象・AuthSheet 節 | 1 |
| AC-3 | ログイン / アカウント登録 の余白が `spec/design/pages/{login,signup}.html` と一致（ブランド→見出し 36px、見出し→フォーム 36px） | Issue 完了条件 | 1 |
| AC-4 | パスワードリセット・404・エラー画面の余白が `password-reset.html` と一致（ブランド→見出し 36px、見出し→説明 24px、説明→本文 36px） | Issue 完了条件 | 1 |
| AC-5 | 設定画面の「アカウント」見出しと直後の行の間隔が変更前と同じ 8px で、余白の担い手が h2 から次要素に移っている | Issue `CurrentUserPanel` 節 | 2 |
| AC-6 | `SettingsSkeleton` が `CurrentUserPanel` と同じ余白の持ち方になっており、ストリーミングのスワップでレイアウトシフトが起きない | Issue `SettingsSkeleton` 節 | 3 |
| AC-7 | サイドバーのブランドとナビの間隔 40px、ナビシートのハンドルと先頭項目の間隔 14px が維持されている | Issue `AppShell` 節 | 4 |
| AC-8 | `pnpm typecheck && pnpm lint:fix && pnpm format` が通る | Issue 完了条件 | 5 |

## スコープ

### 含まれないもの

- `mt-*` / `pt-*` / `pb-*` の既存箇所 — 方向として正しい、もしくは padding は本ルールの対象外（Issue 明記）
- `_app/index.tsx` / `topics.tsx` / `search.tsx` / `trash.tsx` — プレースホルダで該当箇所なし（Issue 明記、#2〜#9 で対応）
- 間隔の値そのものの変更 — 今回は向きの反転のみ。設定の `.section-head + *` は設計側 12px だが実装は現行の 8px（`sm`）を維持する（Issue の指示が `mt-sm`）
- `spec/design/` 側の変更 — 設計は 0242b57 / 07061d3 / 5a68f64 で確定済み

## 調査結果

- 関連ファイル（`mb-*` の 6 箇所）
  - `apps/web/app/components/ui/AuthSheet/index.tsx:20,25,31` — 3 箇所
  - `apps/web/app/components/settings/CurrentUserPanel/index.tsx:30` — 1 箇所
  - `apps/web/app/components/settings/SettingsSkeleton/index.tsx:15` — 1 箇所
  - `apps/web/app/components/layout/AppShell/index.tsx:84,188` — 2 箇所
- あるべきアーキテクチャ: `spec/design/tokens.md`「余白の向き」— (1) 等間隔はコンテナ `gap`、(2) 不揃いは次要素の `margin-top`、(3) `margin-bottom` / `margin: X 0` は使わない。例外は「`display:none` で開閉する要素」「`em` で余白を持つ要素」の 2 つのみで、実装側の 6 箇所はどちらにも該当しない
- 既存実装の状態: 全 6 箇所が下向き余白。`AuthSheet` の条件分岐は「下向きだから次に何が来るかを知る必要がある」ことに起因しており、反転すれば消える
- 依存関係
  - `AuthSheet` の利用側は `routes/{login,signup,password-reset}.tsx` と `routes/__root.tsx`（404 / ErrorScreen）の計 5 箇所。children は `<form>` / `<p>` / `<div>` / `<ErrorRetry>` と不揃いで、うち `ErrorRetry` は `className` を受け取らない
  - `SettingsSkeleton` は `CurrentUserPanel` のストリーミング fallback。両者の DOM 形状が一致していることが前提

## 設計

ドメイン / ユースケース / アダプター: **なし**（プレゼンテーション層の CSS クラスのみの変更）。

### UI / プレゼンテーション

設計側の対応 CSS は次のとおりで、これに合わせる。

| 実装 | 設計側 |
|---|---|
| `AuthSheet` ブランド | `.brand` — 余白なし |
| `AuthSheet` h1 | `.page-title { margin-top: var(--space-section) }` |
| `AuthSheet` p | `.page-description { margin-top: var(--space-lg) }` |
| `AuthSheet` children | `.auth-form { margin-top: var(--space-section) }` |
| `CurrentUserPanel` h2 | `.section-head + * { margin-top: … }` |
| `AppShell` ブランド | `.brand { padding: 0 var(--space-md) var(--space-2xl) }` |
| `AppShell` ハンドル | `.handle { margin: 0 auto }` + `.handle + * { margin-top: 14px }` |

`children` の余白の担い手が問題になる。設計の `.auth-form { margin-top }` は「children 自身が上余白を宣言する」形だが、実装の children は 5 箇所すべて形が違い `ErrorRetry` は `className` を受け取らない。利用側 5 箇所に `mt-section` を配らせると、付け忘れれば余白が消え、`AuthSheet` の内部レイアウトの責務が外に漏れる。`AuthSheet` 側で `<div className="mt-section">` にラップし、シートが自分の縦リズムを持ち切る（ADR-001）。

サイドバーのブランドは設計が `padding-bottom` で持っているが、リンク要素の padding はクリック領域を広げるため現行の挙動が変わる。Issue のチェックリストどおり `<nav>` 側の `mt-2xl` に移す（ADR-002）。

## 実装ステップ

### 1. `AuthSheet` の 3 箇所を反転し、条件分岐を削除

- **対象ファイル:** `apps/web/app/components/ui/AuthSheet/index.tsx`
- **変更内容:**
  - ブランドの `div` から `mb-section` を削除
  - h1 を `mt-section` の固定クラスにし、`description === undefined ? … : …` の三項演算子を削除
  - p を `mb-section` → `mt-lg`
  - `{children}` を `<div className="mt-section">` でラップ
- **理由:** AC-1〜AC-4。各要素が自分の前の余白を自分で宣言する形にすると、description の有無を h1 が知る必要がなくなる

### 2. `CurrentUserPanel` の `mb-sm` を反転

- **対象ファイル:** `apps/web/app/components/settings/CurrentUserPanel/index.tsx`
- **変更内容:** h2 から `mb-sm` を削除し、直後のメールアドレス行の `div` に `mt-sm` を付ける（`ROW` 定数は共有なので、この行のクラスにだけ足す）
- **理由:** AC-1 / AC-5。設計の `.section-head + *` と同型

### 3. `SettingsSkeleton` をステップ 2 と同じ形に追従

- **対象ファイル:** `apps/web/app/components/settings/SettingsSkeleton/index.tsx`
- **変更内容:** ラベル相当の `Skeleton` から `mb-sm` を削除し、直後の行の `div` に `mt-sm` を付ける
- **理由:** AC-1 / AC-6。実 DOM と余白の持ち方がずれるとスワップ時にレイアウトシフトする

### 4. `AppShell` の 2 箇所を反転

- **対象ファイル:** `apps/web/app/components/layout/AppShell/index.tsx`
- **変更内容:**
  - `:84` `BrandLink` の `mb-2xl` を削除し、直後の `<nav>` に `mt-2xl` を付ける
  - `:188` ハンドルの `mb-md` を削除（`mx-auto` は維持）し、先頭のナビ項目（`index === 0`）に `mt-md` を付ける
- **理由:** AC-1 / AC-7。ハンドルは設計側でも `margin: 0 auto` + `+ *` に分割済み

### 5. 静的チェック

- **対象:** リポジトリ全体
- **変更内容:** `pnpm typecheck && pnpm lint:fix && pnpm format` を実行し、`grep -rE '\b(mb|my)-' apps/web/app` が 0 件であることを確認
- **理由:** AC-1 / AC-8

## 設計判断

- ADR-001: `AuthSheet` の children を内部でラップし、シートが縦リズムを持ち切る
- ADR-002: サイドバーのブランドは設計の `padding-bottom` ではなく `<nav>` 側の `mt-2xl` に移す

詳細は `.issue/30/adr.md`。

## リスクと注意点

- ナビシート先頭項目に付ける `mt-md` は既存の `index === 0 ? "" : "border-t …"` と同じ条件分岐に乗る。境界線の分岐と取り違えないこと
- `CurrentUserPanel` / `SettingsSkeleton` の `ROW` 定数は複数行で共有されている。定数側に `mt-sm` を足すと全行に付いてしまうので、先頭行のクラスにだけ足す
- `AuthSheet` の children ラップは DOM ノードが 1 段増える。`ErrorRetry fullWidth` がブロック幅で描画されることを実機で確認する

## テスト方針

- 自動テスト: なし（クラス名のみの変更で、既存のユニットテストは DOM 構造に依存していない）。`pnpm typecheck` / Biome で静的に担保
- 実機確認: ログイン / アカウント登録 / パスワードリセット / 設定 の 4 画面と、404 画面を `spec/design/pages/` の対応ページと並べて余白を比較（詳細は `testing.md`）
