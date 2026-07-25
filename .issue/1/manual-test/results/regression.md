# 既存機能への影響確認

**総合結果**: 6項目すべて PASS
**実行日**: 2026-07-25
**環境**: Node ランタイム（`pnpm dev`）/ http://localhost:3000 / libSQL `apps/web/data/app.db`

## サマリー

| # | 項目 | 結果 | 確認内容 |
|---|------|------|---------|
| 1 | `/todo` サンプルルートの消滅 | PASS | `/todo` `/todo/about` とも **HTTP 404**。500 やテンプレートの todo 画面は出ない |
| 2 | デザイントークン全面差し替えの影響 | PASS | `--color-neutral-300` ≠ `--color-bg-page`（Skeleton は不可視にならない）。4画面の文字色・背景・ボタン・フォーカスリングとも破綻なし |
| 3 | ルート遷移時の pending 表示 | PASS | ローカルでは `RoutePendingFallback` は発火せず（loader が `defaultPendingMs=200` 未満で解決）。同一マークアップを実シェル内に描画して検証したところ、真っ白・レイアウト崩れは発生しない |
| 4 | outbox / relay（共通基盤） | PASS | `No decoder registered for event type "identity.userRegistered"` の類は **0 件**。outbox 7件すべて `processed_at` 済み・失敗0・リトライ0 |
| 5 | マイグレーションの冪等性 | PASS | `pnpm db:migrate` を追加で3回実行。すべて exit 0 / `[migrate.node] done`。`__drizzle_migrations` は1行のまま（`created_at` も不変） |
| 6 | サイト名・メタ情報の fog 化 | PASS | `og:site_name` / `apple-mobile-web-app-title` / 既定タイトルとも **fog**。`tanstack-start-template` はユーザー向けタイトル・メタに一切現れない |

## 1. `/todo` サンプルルートの消滅

| 確認 | 結果 |
|------|------|
| `curl -o /dev/null -w %{http_code} http://localhost:3000/todo` | **404** |
| `curl -o /dev/null -w %{http_code} http://localhost:3000/todo/about` | **404** |
| `/todo` の画面 | `<h1>ページが見つかりません</h1>` ＋「URL が変わったか、削除された可能性があります」＋「タイムラインへ」リンク（アプリ既定の NotFound 画面） |
| `/todo/about` の画面 | 同上 |
| 500 / テンプレートの todo UI | いずれも**出現せず** |
| タブタイトル | `fog`（NotFound は既定タイトルにフォールバック） |

## 2. デザイントークン全面差し替えの影響

### Skeleton の可視性（重点確認）

`getComputedStyle(document.documentElement)` の解決値と、canvas 経由で sRGB に落とした実測値。

| トークン | 解決値 | sRGB |
|---|---|---|
| `--color-neutral-300`（Skeleton の塗り） | `oklch(0.875 0.006 278)` | `rgb(213, 213, 218)` |
| `--color-bg-page` | `oklch(0.93 0.004 286)` | `rgb(231, 231, 234)` |
| `--color-bg-page-top`（グラデーション上端） | `oklch(0.955 0.003 286)` | `rgb(240, 240, 242)` |
| （参考）`--color-neutral-200` | `oklch(0.93 0.004 286)` | `--color-bg-page` と**完全一致** |

- **`--color-neutral-300` と `--color-bg-page` は一致しない**（`identical: false`）。コントラスト比は対 `bg-page` = **1.19**、対 `bg-page-top` = **1.28**。プレースホルダーとして視認できる差がある。
- `--color-neutral-200` がページ背景と完全一致しており、`Skeleton` の JSDoc が `neutral-200` を避けて `neutral-300` を選んだ理由が実測でも裏付けられた。
- ページ背景は `body` の `linear-gradient(oklch(0.955 0.003 286) 0%, oklch(0.93 0.004 286) 240px)`。Skeleton バーを実ページに挿入して計測しても背景色 `oklch(0.875 0.006 278)` / `animation-name: pulse` が適用され、サイズ（例 800x16）も 0 にならず可視だった。

### 4画面の目視・計測

| 画面 | タイトル | h1 色 | 送信ボタン | 入力欄 | 横スクロール |
|---|---|---|---|---|---|
| `/login` | ログイン | `oklch(0.21 0.006 270)` | bg `oklch(0.54 0.15 292)` / 文字 `oklch(1 0 0)` / radius 9999px | bg `oklch(1 0 0)`・文字 `oklch(0.21 0.006 270)` | なし |
| `/signup` | アカウント登録 | `oklch(0.21 0.006 270)` | 同上 | 同上 | なし |
| `/`（タイムライン） | タイムライン | `oklch(0.21 0.006 270)` | — | — | なし |
| `/settings` | 設定 | `oklch(0.21 0.006 270)` | ログアウト（危険操作色 `oklch(0.55 0.19 27)`） | — | なし |

コントラスト比（sRGB 換算・WCAG 式）:

- 本文 `neutral-900` on `bg-page` = **14.39**
- 本文 `neutral-900` on `bg-card` = **17.75**
- ボタン文字 `text-inverse` on `primary-dark` = **5.37**
- エラー文字 `error` on `bg-card` = **5.32**
- 補助文字 `neutral-600` on `bg-card` = **5.49**

### フォーカスリング

`/login` で Tab 移動（`:focus-visible` が真の状態）して計測。**全要素で `--color-focus` が適用**されている。

| 要素 | outline |
|---|---|
| `#login-email` | `oklch(0.63 0.13 292) 2px solid` offset 2px |
| `#login-password` | `oklch(0.63 0.13 292) 2px solid` offset 2px |
| `button[type=submit]` | `oklch(0.63 0.13 292) 2px solid` offset 2px |
| `a[href="/signup"]` | `oklch(0.63 0.13 292) 2px solid` offset 2px |

> 補足: フォーカス直後の一瞬だけ `outline-color` が `currentColor` に見えることがあるが、これは Tailwind v4 の `transition-colors` が `outline-color` を含むための遷移途中の値。遷移完了後は全要素 `--color-focus` に収束する（600ms 後の再計測で確認）。破綻ではない。

## 3. ルート遷移時の pending 表示

| # | 確認 | 結果 |
|---|------|------|
| 1 | ナビ5項目を 45〜90ms 間隔で往復クリックし、`[role=status][aria-live=polite]` の出現を MutationObserver ＋ 25〜30ms ポーリングで監視 | **0 回**。ローカルでは全ルートの loader が `defaultPendingMs = 200ms` 未満で解決するため `RoutePendingFallback` は発火しない（`RoutePendingFallback` の JSDoc の想定どおり） |
| 2 | 発火時の描画を検証するため、`RoutePendingFallback` と同一のマークアップを実シェル（`/settings`）の `<main>` に描画して計測 | 4本のバーが **192x32 / 800x16 / 800x16 / 192x16** で描画。背景 `oklch(0.875 0.006 278)`・`animation: pulse`・`border-radius: 6px`。**真っ白にならない** |
| 3 | シェルの残存（レイアウト崩れ） | サイドバーの `<nav>` とヘッダー `<h1>設定</h1>` は残ったまま。pending 領域は `x=300, y=70, w=880, h=170` でコンテンツ列に収まる。**横スクロールなし** |
| 4 | スクリーンリーダー向け | `.sr-only`「読み込み中」が `position: absolute` で視覚的に隠れ、バーは `aria-hidden="true"` | 

## 4. outbox / relay（共通基盤）

登録を計7件（`test@example.com` / `boundary1` / `new-user+tc13` / `new-user2` / `new-user+dup` / `boundary2` / 320文字メール）実行した後の状態。

| 確認 | 結果 |
|------|------|
| `No decoder registered for event type ...` のログ | **0 件**（`grep -ciE "no decoder registered"` = 0） |
| `[queue] received identity.userRegistered` のログ | **7 件**（登録件数と一致。payload に `userId` / `authMethod: 'password'` を含む） |
| `outbox_events` の総数 / 未処理 / 失敗 | 7 / **0** / **0** |
| `outbox_events.attempts` 合計 / `last_error` あり | **0** / **0**（リトライなしで初回ディスパッチ成功） |
| `processed_events` 件数 | 7（consumer 側の冪等性レコードも1対1で作られている） |

### 参考: 本 Issue と無関係の既存ログ所見（今回の実行では未再現）

サーバーログの 14:44:32 に 1 回だけ `SerovalDeserializationError`（→ 500）が記録されている。直前の行が `LoginForm/action.ts` の Vite RSC 再コンパイル通知であり、HMR 直後に旧クライアントチャンクが新しい server fn へ POST した際の dev サーバー固有の事象と見られる。**今回の一連の検証（登録3件・ログイン4回・Cookie 改ざん・404 アクセス）では一度も再現しなかった**ため、影響確認の判定には含めていない。参考情報として記録する。

## 5. マイグレーションの冪等性

| # | 実行 | exit code | 出力 |
|---|------|-----------|------|
| 1 | `pnpm db:migrate`（2回目の適用） | 0 | `[migrate.node] applying migrations from .../libsql/migrations to file:./data/app.db` → `[migrate.node] done` |
| 2 | `pnpm db:migrate`（3回目） | 0 | 同上 |
| 3 | `pnpm db:migrate`（4回目） | 0 | 同上 |

- `__drizzle_migrations` は **1 行のまま**（`hash=b14b14e8…`、`created_at=1784941160500` が初回適用時から不変 = 再適用されていない）。
- テーブル一覧も不変: `__drizzle_migrations` / `_occ_guard` / `outbox_events` / `processed_events` / `users`。
- 既存データも保持（`users` 7件）。エラー・警告の出力なし。

## 6. サイト名・メタ情報の fog 化

`packages/core/src/config.ts` は `siteName: "fog"` / `defaultTitle: "fog"` / `defaultDescription: "雑に書き留めたメモを、AI が紡いでドキュメントに変えるメモアプリ。"`。

| 画面 | `document.title` |
|---|---|
| `/login` | ログイン |
| `/signup` | アカウント登録 |
| `/`（タイムライン） | タイムライン |
| `/settings` | 設定 |
| `/todo`（NotFound） | **fog**（既定タイトル） |

`/login` の meta 抜粋:

| name / property | content |
|---|---|
| `og:site_name` | **fog** |
| `apple-mobile-web-app-title` | **fog** |
| `description` / `og:description` / `twitter:description` | 雑に書き留めたメモを、AI が紡いでドキュメントに変えるメモアプリ。 |
| `og:title` / `twitter:title` | ログイン |
| `theme-color` | `#ffffff` |
| `og:locale` | `ja_JP` |

- **`tanstack-start-template` はタブタイトル・meta のいずれにも出現しない。**
- リポジトリ内の `tanstack-start-template` の残存はすべて非ユーザー向け（ルート `package.json` の `name`、`README.md` の見出し、AsyncLocalStorage / container-store のシンボル名、Cloudflare Queue 名、Pulumi スタック名、CF/AWS のテスト用リソース名）。ブラウザに露出するメタ情報ではない。
