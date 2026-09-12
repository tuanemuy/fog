# 実装手順 — Issue #22

## 設計

ドメイン・ユースケース・アダプターへの影響は無い。変更は `apps/web` と spec / docs に閉じ、判断の中身は adr.md が持つ。

### UI / プレゼンテーション

層は 4 段で、上の層は下の層だけを使う。見た目は TSX のユーティリティで書く（ADR-001）。

1. **トークン層** — `tokens.css`（tokens.md の写し、ADR-003）、`theme.css`（Tailwind への投影と既定テーマのリセット）、`index.css`（base 層と ADR-012 の定義）
2. **共通プリミティブ**（`components/ui/`、ADR-004）
   - 操作: `Button`（塗り大 / 塗り小 / アウトライン / テキスト / 危険テキスト）とリンク版、`IconButton`、`Icon`（モックの線画の閉じた集合、tokens.md の 4 段）
   - 行と構造: `RowLink`、`Row`（独立ボタン、行の下のエラー）、`SectionLabel`、`EmptyState`、`Markdown`（本文組版。メモ / ドキュメントの 2 段。`timeline/Markdown` から移す）
   - フォームとフィードバック: `FormGroup` / `TextField`、`FormError`、`RowError`、`InlineAlert`、`Toast` とフック（ADR-010）、`PopoverMenu`、`ConfirmDialog`
   - 読み込み: `Sk`（ADR-005）
3. **共通シェルとロゴ**（`components/layout/`）
   - `BrandLockup`: `lockup.svg` をもとにしたインライン SVG
   - `PageHeader`: ルートの宣言から描く（ADR-006）。戻る付きの英語タイトルは、トピック詳細 = `topic`、メモ履歴 = `memo`、ドキュメント閲覧 / 編集 / 新規 / 履歴 = `document`
   - `NavSheet`（ADR-007）、`AppShell`（サイドバー・ヘッダー・スクロールするシート・ナビシート・トーストのホスト）、`AuthSheet`（ナビの無い中央のシート＋トーストのホスト）
4. **画面**を基準形へ載せ替え、文言をモックに合わせる。空状態は一文にし、インラインの通知は ADR-010 の分類で扱う

ルートは `_app`（ガード＋AppShell）と `_sheet`（AuthSheet）の 2 つの pathless レイアウトにする（ADR-008）。エラーと 404 の境界は ADR-009 のとおりに置く。

### 既存ドキュメントへの影響

- `spec/pages/index.md`: ナビをメニューから開くボトムシートにし、通信エラーの行からエラー基準形を参照する。P-13 の「成功を項目ごとに表示」を、成功はトーストに改める
- `spec/design/tokens.md`: 磨りガラス面をコンポーザーだけにする。トークンとモックの生の値の選別結果、役割トークンの追加、ガードの許容リストを書く
- `spec/design/icons/logo.md`: 構成ファイルに `apps/web/public/` の一式を用途つきで足す
- `docs/test.md`: Unit の走査一覧にトークンのガードと、それが見ない範囲（モック・`style` 属性・継承するプロパティ）を足す。DOM の「What is covered」を直す
- `docs/frontend_implementation_example.md`: ストリーミングの例の `errorComponent`、スケルトンの段落、Error / Not Found 節、例の `fog-*` クラスを直す

## 実装ステップ

- 2・3 は `styles/` と `lint/` を共有するので直列、4・5 は並列、6〜8 はルートファイルを共有するので直列に進める
- 9〜16 は担当ファイルが分かれているので並列に進める。画面ステップは `styles/` を触らず、旧 CSS は 17 がまとめて消す

### 1. spec に合意 1〜4・エラー基準形・トーストの扱いを反映する

- **束:** docs
- **対象:** `spec/pages/index.md`、`spec/design/icons/logo.md`
- **変更:** 上の「既存ドキュメントへの影響」のうち、この 2 ファイルの分を書く
- **理由:** 実装が参照する正を先に確定させる

### 2. トークンの選別と写し

- **束:** frontend
- **対象:** `spec/design/tokens.md`、`styles/`（`tokens.css` と旧 CSS）、`lint/` の走査テスト
- **変更:** `tokens.css` だけにあるトークンと 14 モックの生の値を 1 つずつ選別し（ADR-003）、結果と許容リストを tokens.md に書く。`--font-brand` を足して `tokens.css` を写しにし、未定義参照・フォールバック・生の色・存在しない ADR への参照を消して、その検査を入れる
- **理由:** 以降の層が消費するトークンを固定する

### 3. Tailwind への投影とユーティリティのガード

- **束:** frontend
- **対象:** `styles/theme.css`・`index.css`、`lint/` の走査テスト、既定スケールに頼る数か所のコンポーネント
- **変更:** 既定テーマを消してトークンだけを投影し、ADR-012 の定義を置く。生成されたユーティリティの値・`(--token)` の参照・上書きの経路（ADR-004 の TSX 側）の検査を入れ、既定スケールに頼る箇所を置き換える
- **理由:** 以降のステップが書くユーティリティを、書いた時点からテストで縛る

### 4. 操作・構造・読み込みのプリミティブ

- **束:** frontend
- **対象:** `components/ui/`（設計の 2 のうち操作・行と構造・読み込み）、`timeline/Markdown` の呼び出し元、DOM テスト、`biome.json`
- **変更:** モックから形を写してプリミティブを作り、`components/ui` を lint の対象に戻す
- **理由:** 同じ役割を 1 つの実装から使う

### 5. フォーム・フィードバックのプリミティブ

- **束:** frontend
- **対象:** `components/ui/`（設計の 2 のうちフォームとフィードバック）、DOM テスト
- **変更:** 入力欄・ラベル・`fog-error` の兼用を、役割ごとの 1 実装に畳む受け皿を作る
- **理由:** エラーの持ち場と成功トーストを全画面で同じ形にする

### 6. ロゴ・ヘッダー・ナビシート・アプリシェル

- **束:** frontend
- **対象:** `components/layout/`（BrandLockup, PageHeader, NavSheet, AppShell。Brand は撤去）、`router.tsx`、`_app` 配下のルート（ヘッダーの宣言）、DOM テスト
- **変更:** パス名からタイトルを引く表をやめ、ルートの宣言からヘッダーを描く。操作スロット・戻る・スクロールするシート・トーストのホストを入れる
- **理由:** logo.md のヘッダー規則と共通シェルの基準形を満たす

### 7. 認証シートのフレームとルートの再編

- **束:** frontend
- **対象:** `components/layout/AuthSheet`、`routes/_sheet.tsx` とその配下（5 ルートを移す）、`routes/_app.tsx`、presentation のガードヘルパー
- **変更:** 5 画面を `_sheet` の下に移し、認証済みの 2 画面を入れ子のガードの下に置く
- **理由:** 認可とリセット完了を、ナビの無い単体シートにする

### 8. ルート共通のエラー表示と 404

- **束:** frontend
- **対象:** `components/ui/`（RouteError, NotFound, RoutePendingFallback）、`router.tsx`、`routes/__root.tsx`・`_app.tsx`・`_sheet.tsx`、各ルートの `errorComponent`、DOM テスト
- **変更:** 既定のエラーと 404 を基準形で作り、再試行でローダーを読み直す。レイアウトルートの境界を ADR-009 のとおりに置き、ルート側の重複を消す。pending を `Sk` で組み直す
- **申し送り:** timeline.html の「404（アプリシェル内）」は `_app` 配下の子ルートの not found に限る。未知の URL は ADR-009 どおり AuthSheet の枠
- **申し送り:** 認証シート枠のエラー・404 は見出しが無い。見た目を変えずに一文を `h1` にするかを決める
- **理由:** 合意 3 の基準形を 1 実装にし、どの段の失敗も枠に収める

### 9〜16. 画面の載せ替え（各行が 1 ステップ）

- **束:** frontend
- **対象:** 各行の components と、該当する DOM テスト
- **変更:** 各行のモックに合わせる
  - 9 認証: `auth/*`・`aiClients/AuthorizeSheet`・`settings/PasswordResetDoneFeed` → 認証系の 4 モック。説明文を除き、エラーをフォームの先頭へ
  - 10 タイムライン: `timeline/*` → timeline.html。コンポーザー（ADR-011）・ヘッダーの絞り込みと日付移動・メモ操作のポップオーバー
    - 申し送り: コンポーザーは通常フローの `<input>` と「音声で入力」ではなく、1 行の状態例と ADR-011 を写す
  - 11 トピック: `topics/*`・`knowledge/*` → topics.html / topic-detail.html。行・作成フォーム・完了済み・見つからない表示
  - 12 ドキュメント: `documents/*`（履歴を除く）→ document.html / document-edit.html。操作と保存をヘッダーへ移し、本文組版・元になったメモ・出典の選択
  - 13 履歴: `memoHistory/*`・`documents/` の履歴 2 つ → 2 画面の版の行・差分・戻す操作を 1 つの形に。戻す成功はトースト
  - 14 検索: `search/*` → search.html。検索欄・チップ・結果行・0 件
  - 15 ゴミ箱: `trash/*` → trash.html。アイコンの行操作・行の下のエラー・セット関係・復元先の選択。復元成功はトーストにし、「タイムラインで見る」を撤去
  - 16 設定: `settings/*`（リセット完了を除く）→ settings.html。成功はトースト、一括失効の失敗の部分はインラインに残す
- **理由:** 画面間の不揃いと、画面ごとの再定義を解消する

### 17. 旧 CSS の撤去とガードの完成、docs

- **束:** frontend
- **対象:** `styles/` の旧 CSS（`app.css` と画面ごとのファイル）、汎用 `Skeleton`、`lint/` の走査テスト、`docs/test.md`、`docs/frontend_implementation_example.md`
- **変更:** `fog-*` の参照が無くなった旧 CSS と汎用 `Skeleton` を消す。手書き CSS の許容リスト外の生の値と、クラスセレクタの規則の検査を足す。docs を直す
- **理由:** 載せ替えた状態を、以後もテストで保つ
