# レビュー（3回目）: PR #49 — Presentation / Config・Build・Docs

**対象:** PR #49（base `main`、9 commits: `01247b5`..`e56785a`、変更 259 ファイル）
**契約:** `.thread/37/plan.md`（AC-17〜AC-22 / AC-26 / AC-28 を中心に）
**観点:** Presentation / Config・Build・Docs
**実施日:** 2026-08-03

2回目（`review-002-presentation-config.md`）の W-001〜W-006 と `triage.md` / `.thread/37/adr.md`（ADR-100〜103）を読み、**修正の検証**を主眼に見た。3回目なので判断基準は「マージしてよいか」に限定し、表記の好みや軽微な改善は指摘に上げていない。差分の読解だけでなく次を実行して裏取りした。

- `pnpm install --frozen-lockfile`（Already up to date）/ `pnpm typecheck` / `pnpm lint` / `pnpm format:check` — clean
- `pnpm test:unit`（36 files / 525 pass）/ `pnpm build:cf`（2成果物）/ `pnpm test:smoke`（2 pass、root と `apps/web` の両経路）
- **`pnpm test:integration:shuffle --sequence.seed=12345` を実行**（19 files / 184 pass。CI と同形の引数の渡り方を確認）
- **`pnpm dev` を起動して 3000 bind・`og:url`・redirect を実測**し、さらに**3000 占有下で起動失敗することも実測**
- **`wrangler deploy --dry-run` を3経路で実測**（wrangler 4.114.0）— redirect 経路 / `-c wrangler.request.staging.toml` / `-c wrangler.state.toml`
- **`pnpm start`（`wrangler dev`）を起動して `/login` 200 を確認**（README / CLAUDE.md が #40 解消を前提に書き換わったため）
- `@tanstack/react-router@1.170.18` の `Match.js` と `apps/web/app/router.tsx` を突き合わせ、CLAUDE.md に追加された `errorComponent` 規約の正確性を確認

---

## Blockers

なし。

---

## Warnings

なし。

---

## Notes

- **[N-001]** 2回目に指摘した6件はすべて解消しており、**新たな問題を生んでいないことを実測で確認した**（下の「2回目指摘の修正検証」）。この観点から見て、本 PR にマージを止める理由は無い。
- **[N-002]** `pnpm start` が実際に起動することを確認した（`wrangler dev` → `[wrangler:info] Ready on http://localhost:8787` → `GET /login 200 OK`）。README:90 / CLAUDE.md:29 が #40 の「起動不能」記述を削除して「build 成果物を serve する」に書き換えた主張は、実測で成立している。redirect 経路（`.wrangler/deploy/config.json`）で 76 modules を読み込んでおり、スモークテストが miniflare で見ているのと同じ形の成果物である。
- **[N-003]** 相対リンクの機械検査（`README.md` / `CLAUDE.md` / `docs/*.md` の Markdown リンク）で dead link 0 件。バッククォート付きパスの残りヒットは (i) `apps/web` 相対の記述（`app/worker/cloudflare/state.ts` / `wrangler.state.toml` など）と (ii) `docs/runtime_cloudflare.md` の旧構成への言及で、後者は同ファイル冒頭の `> [!WARNING]`（#38 が書き換える旨）が正しくカバーしている。
- **[N-004]** レビュー中、**作業ツリーが別セッションによって汚れた**（`__tests__/doHarness.ts` の `disarm` を no-op 化し、`alarmEntry` / `resetToken` / `identity` の各統合テストに 2s の sleep を入れる変更が 10:39〜10:40 に入った）。本 PR の内容ではない。私の統合テスト実行は 10:38:20 開始・約5秒で完了しており、mtime から**クリーンなツリーに対する結果**であることを確認済み。マージ前にこの未コミット変更が混入しないことだけ確認されたい。
- **[N-005]** `apps/web/worker-configuration.d.ts` は untracked（`wrangler types` の生成物）で、AC-17 が言う `D1Database` / `Queue` の非存在は**バインディング宣言**についてであり、ファイル後半の Cloudflare ランタイム型ライブラリには当然 `interface Queue` が含まれる。実際の `Cloudflare.Env` は `__BaseEnv_Env` を継承するだけで D1 / Queue バインディングを持たない。AC の意図は満たされている（AC の文言が生成物全体を指しているように読める点は #37 の範囲外）。
- **[N-006]** 2回目 N-004（スケルトンの行**高**が実 DOM と 4px ずれる）は未修正のまま残っている。本 PR 由来ではなく、受け入れ基準にも掛からないので指摘には上げない。
- **[N-007]** 2回目 N-009（CLAUDE.md:125 が1文の中で英語→日本語に切り替わる）も未修正。可読性の好みであり、マージ判断には関わらない。

---

## 2回目指摘の修正検証

| ID | 判定 | 根拠（実測） |
|---|---|---|
| W-001（redact した4 kind がログにも残らない） | **解消** | `errorResponse.ts` に `redactsMessage(kind)` が入り（`redactForClient` と同形の網羅 `switch`、`default` 無しなので kind 追加が型エラーになる）、`errorResponseMiddleware.ts:68` が `if (redactsMessage(rawSerialized.kind))` へ。`errorResponse.test.ts` の `SAMPLES` は `satisfies Record<SerializedErrorKind, SerializedError>` の全数レコードで、`redactsMessage(kind) === (redactForClient(sample).message !== sample.message)` を8 kind すべてに掛けている。middleware 側も4 kind について「ワイヤは `code` のみ・ログに raw 1件」、`business` について「redact も log もしない」を assert。ADR-061 の Consequences と JSDoc の断定が初めて実装と一致した |
| W-002（`pnpm dev` のポートが固定されていない） | **解消（実測確認）** | `vite.config.cloudflare.ts:52` に `strictPort: true`。3000 が空いた状態で `pnpm dev` を起動 → `Local: http://localhost:3000/`、`/login` 200 で `<meta property="og:url" content="http://localhost:3000/login">`（＝到達するポート）、`/settings` は `307 → http://localhost:3000/login?redirect=%2Fsettings`。**3000 を占有した状態で再度起動 → `Error: Port 3000 is already in use` で失敗**。設定と実ポートが黙って割れる状態が構造的に消えた。README:92 の追記も実測と一致 |
| W-003（エラー面3つのうち2つが逐語重複・余白だけ割れている） | **解消** | `components/ui/ErrorSurface/index.tsx` に `<section>` ＋ 見出し ＋ 条件つきメッセージ ＋ `ErrorRetry` を抽出し、`_app.tsx` と `_app/settings.tsx` の両方がこれを描く。余白差は `className` prop（既定 `py-2xl` / `/settings` は `pb-2xl`）で、**理由が `ErrorSurface` の JSDoc と `SettingsErrorScreen` のコメントの両方に書かれている**（「実装の差」から「呼び出し側が明示する値」へ変わった）。`__root.tsx` の `AuthSheet` 経路を寄せない判断も妥当（DOM の形が違う） |
| W-004（CLAUDE.md に streaming ルートの `errorComponent` 規約が無い） | **解消・記述の正確性も確認** | `CLAUDE.md:65` に1段落追加。主張「catch boundary は**そのルート自身の** `errorComponent` で決まる」はフレームワーク実装で裏取り済み — `Match.js:73` が `route.options.errorComponent ?? router.options.defaultErrorComponent`、`:78` が `ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment`。**`apps/web/app/router.tsx` は `defaultErrorComponent` を設定していない**（`defaultPendingComponent` / `defaultPendingMs` のみ）ので、「無ければ `_app` の面まで昇る」も成立する。参照先 `ui/ErrorSurface` も実在 |
| W-005（request `.tpl` のコメントの実測値が陳腐化） | **解消（実測確認）** | 両 `.tpl` から `77 modules / 1682 KiB` が落ち、「`pnpm build:cf` 後に `-c` 経路と redirect 経路の `--dry-run` を突き合わせ、module 数と Total Upload が一致することを確認する。絶対値はビルドごとに動くので PR に書く」という**手順**に置き換わった。**その手順を実際に走らせて一致を確認** — redirect 経路（`wrangler deploy --dry-run`）と `-c wrangler.request.staging.toml --dry-run` がともに **`Total (76 modules) 1137.25 KiB` / `Total Upload: 1693.08 KiB`**、警告ゼロ、`rsc/index.js` と `assets/*.js` が個別モジュールとして載る形も同一。バインディング表示も `script_name` の違い（`fog-state` / `fog-staging-state`）と `APP_URL` 以外は同じ。`-c wrangler.state.toml` 側も `exports` が認識され警告ゼロ（AC-26） |
| W-006 / test W-004（`--sequence.shuffle` の pre-PR チェックが存在しない） | **解消（CI が動く形であることを確認）** | ルート `package.json` に `"test:integration:shuffle": "vitest run --config vitest.config.integration.ts --sequence.shuffle"` が実在。**`pnpm test:integration:shuffle --sequence.seed=12345` を実行して引数が渡ることを実証**（vitest が `Running tests with seed "12345"` を出し、19 files / 184 pass）。CI の該当ステップは `pnpm test:integration:shuffle --sequence.seed=${{ github.run_id }}` で、pnpm はスクリプト名の後の引数をそのまま転送するので同じ形になる。旧 `pnpm test:integration:cf` を叩いていたステップは置換済み（そのスクリプト自体も削除されているので、置換漏れなら CI が即赤になる）。`docs/test.md` の当該文と Commands 表も追随済み |

---

## AC 機械検証の結果

plan.md に検証コマンドが書かれているもの、および本観点に掛かるものを実行した。**通らなかったものは無い。**

| AC | 検証 | 結果 |
|---|---|---|
| AC-4 | `grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app \| grep -v '/__tests__/'` | `application/di/serverCloudflare.ts:149` / `:159` の2件のみ ✅ |
| AC-5（後半） | `grep -n "storage\.sql\|ctx\.storage\|\bsql\b"` を両 facade に | 0件 ✅ |
| AC-14 | `application/workers/` `application/events/` `domain/common/event.ts` `application/di/env.ts` の非存在、`apps/web/app/worker/cloudflare/` の中身、`OUTBOX_` の全文検索 | 4パスとも不在、`worker/cloudflare/` は `state.ts` の1本のみ、`OUTBOX_` 0件 ✅ |
| AC-17 | `adapters/d1/` / `drizzle.config.ts` の非存在、`drizzle` の `package.json` 全数、`pnpm-lock.yaml` の `drizzle`、`vitest.config.integration.ts` の D1 / Queue 語 | 前2つ不在、`package.json` ヒット0、lock ヒット0、integration config に4語とも無し ✅（`worker-configuration.d.ts` は N-005 参照） |
| AC-18 | `grep -c '"db:'` / `'"deploy:'` を両 `package.json` に | `db:*` 0 / 0、`deploy:*` **12 / 12**（合計24。`deploy:{request,state}:{staging,production}`＋`:dry` の8＋合成4）✅。README:143 の対応表の右辺に出るスクリプトも全数実在 |
| AC-19 | `wrangler.toml` / `wrangler.state.toml` / `.tpl` 4本に `d1_databases` / `queues.` / `[env.` | 0件。`main` は `wrangler.toml` だけソースエントリ、他4本は build 成果物 ✅ |
| AC-20 | plan.md 記載の `grep -rn "tanstack-start-template" …` （除外は `.thread/` と `spec/idea.md` のみ） | 0件 ✅ |
| AC-21 | `vitest.config.integration.ts` の `durableObjects` に `useSQLite: true`、`include` 3ディレクトリ、`setupFiles` | すべて所在確認。`apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` は削除済み ✅ |
| AC-22 | `pnpm build:cf` → `pnpm test:smoke`（root / `apps/web` の両経路） | 2 pass ×2。request / state の2 Worker を miniflare で起動し、`Disallowed operation…` を assert。CI の build ジョブに `Boot smoke test` ステップとして載っている ✅ |
| AC-25 | plan.md 記載の grep 2本 | ともに 0件 ✅ |
| AC-26 | `-c wrangler.state.staging.toml --dry-run` / request 側の redirect 対照 | 上記 W-005 の実測どおり一致、警告ゼロ ✅ |
| AC-28 | CLAUDE.md の「Migration in progress」節・エントリポイント一覧・Key concepts・Cross-layer catch policy、`docs/test.md`、`docs/backend_implementation_example.md` の警告ブロック | 該当節は削除済み。エントリポイントは request / state の2本立てに更新。UoW の追記（`recalcTrashPurgeAfter` / `findOperation`）と catch policy 5項目め（migration ゲート）は `application/execution/unitOfWork.ts` / `durable-objects/userData.ts:154-186` の実体と一致（`alarm()` の4段が1つの catch にあり `rearmAfterFailure` へ落ちる＝`deleteAlarm()` しない、も実コードどおり）。両 `docs/*.md` の `> [!WARNING]` も所在確認 ✅ |
| AC-29 | `pnpm install --frozen-lockfile` / `typecheck` / `lint` / `format:check` / `test:unit` / `test:integration`（shuffle 版）/ `test:smoke` | 全通過。`lint` の info 2件は `biome.json` のスキーマ版に関するもので本 PR 由来ではない ✅ |

---

## カバレッジ

一覧 259 件に 1 対 1 で対応する。**確認 47 件 / スキップ 212 件（合計 259）。**

### 確認（47）

**設定・ビルド（21）**
`.github/workflows/ci.yml`, `package.json`, `apps/web/package.json`, `apps/web/vite.config.cloudflare.ts`, `apps/web/vite.config.state.ts`, `apps/web/scripts/render-wrangler.ts`, `apps/web/.dev.vars.example`, `apps/web/wrangler.toml`, `apps/web/wrangler.state.toml`, `apps/web/wrangler.request.staging.toml.tpl`, `apps/web/wrangler.request.production.toml.tpl`, `apps/web/wrangler.state.staging.toml.tpl`, `apps/web/wrangler.state.production.toml.tpl`, `apps/web/wrangler.staging.toml.tpl`（削除）, `apps/web/wrangler.production.toml.tpl`（削除）, `apps/web/drizzle.config.ts`（削除）, `apps/web/__tests__/boot.smoke.test.ts`, `vitest.config.smoke.ts`, `vitest.config.integration.ts`, `pnpm-lock.yaml`, `packages/core/package.json`

**Presentation（9）**
`apps/web/app/components/ui/ErrorSurface/index.tsx`, `apps/web/app/routes/_app.tsx`, `apps/web/app/routes/_app/settings.tsx`, `apps/web/app/presentation/errorResponse.ts`, `apps/web/app/presentation/errorResponseMiddleware.ts`, `apps/web/app/presentation/__tests__/errorResponse.test.ts`, `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts`, `apps/web/app/components/settings/SettingsSkeleton/index.tsx`, `apps/web/app/components/settings/CurrentUserPanel/index.tsx`

**ドキュメント（5）**
`CLAUDE.md`, `README.md`, `docs/test.md`, `docs/runtime_cloudflare.md`, `docs/backend_implementation_example.md`

**インフラ（7）**
`infra/cloudflare/pulumi/resources/{index.ts,Pulumi.yaml,Pulumi.staging.yaml,Pulumi.production.yaml}`, `infra/cloudflare/pulumi/routes/{Pulumi.yaml,Pulumi.staging.yaml,Pulumi.production.yaml}`

**作業ログ（5）**
`.thread/37/plan.md`, `.thread/37/adr.md`（ADR-100〜103 と参照した項）, `.thread/37/review/triage.md`, `.thread/37/review/review-002-presentation-config.md`, `.thread/37/review/review-001-presentation-config.md`

**差分外だが判断の裏取りのため読んだもの（カバレッジには数えない）**
`apps/web/app/router.tsx`, `apps/web/app/components/ui/ErrorRetry/index.tsx`, `apps/web/app/presentation/errorDisplay.ts`, `infra/cloudflare/pulumi/routes/index.ts`, `.gitignore`, `node_modules/.../@tanstack/react-router/dist/esm/Match.js`, `apps/web/dist/server/wrangler.json`

### スキップ（212）

- `packages/core/src/adapters/cloudflare/**`（74） — Cloudflare アダプター実装・DO 統合テスト。アダプター / テスト観点の担当
- `packages/core/src/application/**`（42） — 合成ルート・ユースケース・ポート・実行基盤。ドメイン / ユースケース観点の担当（`execution/unitOfWork.ts` は AC-28 の裏取りのため読んだが、レビュー本体は当該観点）
- `packages/core/src/domain/**`（20） — ドメイン観点の担当
- `packages/core/src/adapters/d1/**`（20、全削除） — 対象消滅。AC-17 の機械検証で非存在を確認済み
- `.thread/37/**` の残り12（`steps.md`, `testing.md`, `review-001.md`, `review-002.md`, 他観点の review-001/002 各4本） — 他観点の作業ログ。必要範囲は `triage.md` 経由で参照した
- `spec/**`（8） — 正本ドキュメント。ドメイン / spec 観点の担当
- `packages/core/src/lib/**`（8） — 共有プリミティブ。ドメイン / アプリケーション観点の担当
- `apps/web/app/worker/**`（8。`state.ts` 新設 ＋ relay / consumer / pruner / dlq / handlers とテスト2本の削除） — 存在・非存在のみ AC-14 で機械検証。中身はアダプター観点の担当
- `apps/web/app/presentation/` の残り5（`authState.ts`, `currentUser.ts`, `session.ts`, `__tests__/{currentUser,session}.test.ts`） — 本回の修正で未変更。1・2回目で確認済み
- `apps/web/app/durable-objects/**`（4） — DO クラス本体と RPC エントリテスト。アダプター観点の担当（`userData.ts` の `alarm()` は AC-28 の裏取りのために読んだ）
- `packages/core/src/adapters/webcrypto/**`（3） — 逆流依存の解消。ドメイン / アプリケーション観点の担当
- `apps/web/app/components/` の残り3（`auth/{LoginForm,SignupForm}/action.ts`, `settings/LogoutButton/action.ts`） — 本回の修正で未変更。1・2回目で確認済み
- `.adr/**`（3） — 本回の修正で未変更（`.adr/001` の「#37 で解消済み」追記のみ確認）
- `vitest.config.ts`（1） — 本回の修正で未変更。1回目で確認済み
- `apps/web/app/server.cloudflare.ts`（1） — 本回の修正で未変更。1回目で確認済み（`pnpm start` / スモークで実行時の健全性は確認）

---

## 判定

**マージ可。** この観点からブロッカーは無い。
