# ブラウザ検証レポート — Issue #36 / PR #39

**実行日**: 2026-07-29
**対象**: `issue/36/remove-node-aws-gcp-runtimes`（Node / AWS / GCP ランタイムの撤去）
**テストソース**: `.thread/36/testing.md`
**検証環境**: `pnpm dev`（= `vite dev --config vite.config.cloudflare.ts`、workerd + ローカル D1）@ http://localhost:3000

## 結論

**全12件 PASS。変更起因の FAIL はゼロ。**

撤去後も `dev` / `build` / `db:migrate` の既定が Cloudflare 構成を指し、アプリは認証・ルーティング・RSC ストリーミング・エラー表示のいずれも従来どおり動作した。

詳細は `results/summary.md` と `results/TC-*.md` を参照。

## 検証環境の準備

| 手順 | 結果 |
|---|---|
| `pnpm install --frozen-lockfile` | exit 0 / 4 workspace projects |
| `apps/web/.dev.vars` | 既存（`SESSION_SECRET` 50文字）。上書きせず尊重 |
| `pnpm db:migrate` | `✅ No migrations to apply!`（`0000_initial.sql` 適用済み） |
| ローカル D1 の初期状態 | `users` 0件 / `outbox_events` 0件 / `processed_events` 0件 |

検証用アカウント `cf-check@example.com` は TC-003（`/signup` からの登録手順そのもの）で作成した。

## 主な実測値

| 項目 | 実測 |
|---|---|
| 未認証 `GET /` | HTTP 307 → `location: /login?redirect=%2F` |
| `pnpm typecheck` | exit 0 / `Scope: 3 of 4 workspace projects`（`@repo/infra-aws` 消失） |
| `pnpm lint` / `pnpm format:check` | 両方 exit 0 |
| `pnpm test:unit` | 24 files / 409 tests passed（main の 26 files / 424 から node アダプター2ファイル分の減少） |
| `pnpm test:integration` | 9 files / 104 tests passed（1件も減らず） |
| `pnpm build` | exit 0 / `dist/server/index.js` 734.64 kB |
| `/settings` のスケルトン | +93.9ms 出現 → +390.9ms 消滅（約297ms 表示）、CLS = 0 |

## testing.md と実測のズレ（実装の退行ではない — 手順書側の記述の問題）

1. **TC-002 手順3** — testing.md は `location: /login` と書いているが実測は `location: /login?redirect=%2F`。リダイレクト先は一致しており、`?redirect=` はエッジケース1 で検証する `_app.tsx` の既存仕様と整合する。手順書の記載が簡略すぎる。
2. **TC-E03 手順3** — testing.md は「該当フィールドにフォーカスが移る」だが、実装はフォームレベルの `<p role="alert" tabindex="-1">` にフォーカスを移す。認証失敗はメール／パスワードのどちらが誤りか区別しない設計なので「該当フィールド」が定まらず、alert へのフォーカスが a11y 上正しい。手順書の文言がフィールド単位エラーを想定している。
3. **TC-007** — バンドルサイズが testing.md 記載の 735.68 kB に対し実測 734.64 kB。差はレビュー修正コミット由来で、期待結果の本文（「ビルドが成功し index.js が生成される」）は満たしている。
4. **TC-009** — unit テストの期待値がファイル数（24）のみで件数が書かれていない。実測 424 → 409（-15）で、減少が削除2ファイルに閉じていることは `git diff` で裏取り済み。

## 検証中に観測した既存のノイズ（本 Issue の変更とは無関係）

- ビルド時の TanStack 非推奨警告4件（`createServerFn().inputValidator() is deprecated`、`LoginForm/action.ts:7` / `SignupForm/action.ts:7`）
- `pnpm lint` の Biome 設定移行案内（`Found 2 infos.`、exit 0）
- 390px でサイドバーの `nav` が 0×0 で DOM に残るため、素朴なセレクタが非表示側にマッチする（自動化時の注意点。表示上の問題はなし）

## 起票した Issue

なし（変更起因の FAIL がゼロのため）。

なお本 Issue の作業中に別途 **#40**（`eventRelayWorker.ts:97` の module-scope `crypto.randomUUID()` により `wrangler dev` / `preview` が起動できない既存欠陥）を起票済み。`pnpm start` はこの欠陥のため TC-008 でスクリプト定義の目視確認に置き換えている。
