# レビュー: PR #49 — Presentation / Config・Build・Docs

**対象:** PR #49（base `main`、6 commits: `01247b5`..`9f1bd66`、変更 220 ファイル）
**契約:** `.thread/37/plan.md`（AC-17〜AC-22 / AC-26 / AC-28 を中心に）
**観点:** Presentation / Config・Build・Docs
**実施日:** 2026-08-03

本レビューは差分の読解だけでなく、以下を実際に実行して裏取りした。

- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` — いずれも clean
- `pnpm build:cf` — 成功。`dist/{client,server,state}` が揃う。request 単体ビルドが `dist/state` を消さないことも実測
- `pnpm test:smoke` / `pnpm --filter @repo/web test:smoke` — 2 tests pass（パススルーも成立）
- `npx wrangler deploy -c wrangler.state.toml --dry-run` — `exports` が wrangler 4.114.0 で受理され、`.wrangler/deploy/config.json` の redirect に引きずられないことを確認（AC-26 の実測）
- `.tpl` を手でレンダリングした `wrangler.request.staging.toml` に対する `--dry-run` — 成功（AC-26 は state 側しか要求していないが、request 側も確認した）
- `pnpm dev`（vite dev、固定ポート）— 2 Worker 構成で起動、`.dev.vars` が両 Worker に読まれ、`/login` 200 / `/settings` → `307 /login?redirect=%2Fsettings`

---

## Blockers

- **[B-001]** ストリーミングのスケルトンが実 DOM と一致しなくなった（2行 vs 1行）
  - 場所: `apps/web/app/components/settings/SettingsSkeleton/index.tsx:1-30` / `apps/web/app/components/settings/CurrentUserPanel/index.tsx:43-55`
  - 理由: 旧 `CurrentUserPanel` は「メールアドレス」行と「認証方式」行の**常に2行**を描いていた。`SettingsSkeleton` はそれに合わせて2行を描き、JSDoc に「shaped like the real DOM (section label + **two rows** + the logout button) so the panel swaps in without shifting the layout」と自分で不変条件を宣言している。本 PR で `CurrentUserPanel` は `user.credentials.filter(usableForLogin)` の**件数ぶん**の行に変わった。`registerWithPassword` はメールクレデンシャルを1件だけ記録する（`packages/core/src/application/identity/registerWithPassword.ts:44-46`）ので、**現行のすべてのアカウントで1行**になる。したがってスケルトン→実体の差し替えで必ず1行ぶんのレイアウトシフトが起き、`CLAUDE.md`「Frontend」の *skeletons ... shaped to the real DOM so it swaps in without layout shift* に真正面から反する。加えて `SettingsSkeleton` の JSDoc が事実と食い違ったまま残っており、次に触る人を誤らせる。
  - 提案: `SettingsSkeleton` の2つ目の行 `<div className={`${ROW} border-t border-neutral-100`}>` を落として1行にし、JSDoc の「two rows」を「one row」（あるいは「クレデンシャル1件ぶんの行」）へ直す。複数クレデンシャルは #12 が入ってから改めて考える形でよい。`CurrentUserPanel` 側で `mt-sm` / `border-t` の担われ方（先頭行が `mt-sm`、以降が `border-t`）も変わっていないので、1行版のスケルトンは `mt-sm` のままでよい。

---

## Warnings

- **[W-001]** `docs/runtime_cloudflare.md` が全面的に陳腐化しているのに、README と CLAUDE.md が正本として名指ししたままで、警告ブロックも無い
  - 場所: `docs/runtime_cloudflare.md:1`（`# Runtime: Cloudflare Workers (D1 + Queues)`）／参照元は `README.md:63`・`README.md:97`・`CLAUDE.md:126`
  - 理由: 本ファイルは削除済みの世界を丸ごと記述している — タイトルからして D1 + Queues、`db:migrate:cf` / `db:apply:*` / `db:execute:*`（10本すべて消滅）、`deploy:{stage}:relay|consumer|pruner|dlq` と `--env <role>`（named environment ごと廃止）、`OUTBOX_*` 4変数、`packages/core/src/application/di/env.ts`（削除済み）、`packages/core/src/adapters/d1/migrations/`（削除済み）、`wrangler.staging.toml` / `wrangler.production.toml`（`wrangler.{request,state}.<stage>.toml` へ改名）。実測で `grep OUTBOX_` / `grep adapters/d1` に残るのはこのファイルだけである。`docs/` は #38 のスコープという plan の切り分けは妥当だが、**`docs/backend_implementation_example.md` には警告ブロックを1つ足す判断をしている**（AC-28、実装済み）のに、同じ理由が同じ強さで当てはまる `docs/runtime_cloudflare.md` だけが素通しになっている。README は「See `docs/runtime_cloudflare.md` for deployment and secrets.」と現在形で誘導しており、読者は存在しないコマンドを叩くことになる。
  - 提案: `docs/backend_implementation_example.md` に入れたのと同形の `> [!WARNING]` ブロックを `docs/runtime_cloudflare.md` の冒頭に1つ足す（内容は「D1 + Queues 時代の運用手順であり現行構成を反映していない。書き換えは #38。当面は `README.md`「Deployment」と `apps/web/.dev.vars.example` を正本とする」）。#38 の射程には踏み込まないので、AC の切り分けを崩さずに dead link 相当の誤誘導だけを潰せる。

- **[W-002]** セッション失効時に `/settings` が壊れ、唯一のログアウト導線が描画されない（cookie も残る）
  - 場所: `apps/web/app/components/settings/CurrentUserPanel/index.tsx:27-58`（`LogoutButton` が panel の内側）／`apps/web/app/presentation/currentUser.ts:41-60`／`packages/core/src/adapters/cloudflare/userData/facade.ts:102-118`
  - 理由: 認可の権威が DO 側の epoch ガードへ移った結果、`sessionEpoch` が進んだ / `status !== 'active'` のセッションは `UnauthorizedError("SESSION_REVOKED")` / `ForbiddenError("ACCOUNT_NOT_ACTIVE")` として **`CurrentUserPanel` のストリーミング中に**投げられる。このとき (i) `_app.tsx` の `beforeLoad` が呼ぶ `readAuthStateFn` は DO を叩かないので `authenticated: true` を返し続け、シェルは通常どおり描かれる、(ii) セッション cookie は消えない、(iii) `/settings` の中身は `CurrentUserPanel` ただ1つで、`LogoutButton` はその JSX の内側（`index.tsx:57`）なので、panel が throw した瞬間に**ログアウトボタンごと消える**。結果としてユーザーは「ログイン状態に見えるが設定画面がエラーで、自力でセッションを捨てる手段が UI に無い」状態に落ちる。`authState.ts` の新 JSDoc が置いたルール（「DO を叩かない server function は保護データを返さない」）自体は正しく守られているが、**その裏返しである「DO 側だけが知る失効をどう UI へ落とすか」が未定義のまま**である。`advanceSessionEpoch` の呼び手は現在リポジトリに存在しない（`grep advanceSessionEpoch` の非テストヒットはポート定義と実装の2件のみ）ので今は到達不能だが、#12（パスワード変更・リセット完了・unlink）が入った瞬間に実害になる。
  - 提案: 最小の対処は2つのどちらか。(a) `LogoutButton` を `CurrentUserPanel` の外（`routes/_app/settings.tsx` の `SettingsPage` 側、`Suspense` の外）へ出して、panel が落ちてもログアウトできるようにする。(b) `guardStreamedRender` / `errorResponseMiddleware` で `kind: "unauthorized"` を検出したらセッション cookie を破棄して `/login` へ redirect する経路を1本入れる。どちらも #37 の射程内で完結する。少なくとも「#12 が epoch を進める前にこの穴を塞ぐ」ことを `.thread/37/plan.md`「未解決事項」か #12 への引き継ぎコメントに明記してほしい（AC-30 の外部アクションに1件足す形）。

- **[W-003]** `CLAUDE.md` の UoW 記述が実装の `UserDataUnitOfWorkContext` と一致していない（AC-28）
  - 場所: `CLAUDE.md:69`（Key concepts / Unit of Work）／`packages/core/src/application/execution/unitOfWork.ts:41-84`
  - 理由: `CLAUDE.md` はコンテキストの中身を「集約リポジトリ ＋ 非集約ストア ＋ in-transaction side-effect registration points」の3群として列挙し、後2者について *Those two groups are the **complete set** of write paths* と全数を主張している。列挙されているのは `enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor` の4つだが、実装の `UserDataUnitOfWorkContext` はさらに **`recalcTrashPurgeAfter`（書き込み）** と **`findOperation`（読み）** を持つ。`recalcTrashPurgeAfter` が書くのは `memos` / `documents`（集約側）なので `spec/database/index.md:767` の「非集約ストアへの書き込み口は6ストア・7メソッド」という数え方自体は壊れていないが、**`CLAUDE.md` の3群の分類にはどちらも入らない**ため、読者は「コンテキストにはこの4つしか無い」と読む。さらに `spec/domains/trash.md:191` / `spec/domains/memo.md:305` は `purgeAfter` の一括再計算の書き込み口を「各ドメインの Repository の `recalculatePurgeAfter`」と定めており、#37 がそれを UoW コンテキストへ直付けした逸脱は **`unitOfWork.ts` の JSDoc にしか記録されていない**（ADR-001 を根拠に挙げてはいる）。AC-28 は「Key concepts の記述が新構成と一致している」ことを要求している。
  - 提案: `CLAUDE.md` の Unit of Work の項に1文足す — 「User Data DO のコンテキストには、#2〜#6 がリポジトリを持たないあいだの暫定として `recalcTrashPurgeAfter`（集約テーブルへの一括更新）と `findOperation`（saga の相方を読む）も乗る。前者は各ドメインの `recalculatePurgeAfter` が実装され次第そちらへ移る」。あわせて `spec/database/index.md` か `spec/domains/trash.md` に同趣旨の暫定注記を1行入れておくと、#2〜#6 の実装者が仕様どおり Repository に生やしたときに二重の口ができるのを防げる。

- **[W-004]** `pnpm dev:state` はビルド成果物を要求するが、README / CLAUDE.md のコマンド一覧にその前提が書かれていない
  - 場所: `apps/web/wrangler.state.toml:8`（`main = "dist/state/index.js"`）／`README.md:106`／`CLAUDE.md:29`
  - 理由: AC-19 の設計どおり `wrangler.state.toml` の `main` はビルド成果物を指す（vite プラグインの管轄外なので正しい判断）。しかし `pnpm dev:state` は `wrangler dev -c wrangler.state.toml` そのままなので、`pnpm build:cf`（またはせめて `vite build --config vite.config.state.ts`）を先に走らせていないと `The entry-point file at "dist/state/index.js" was not found.` で落ちる。実際に本レビュー中、`dist` が無い設定で同じエラーを再現した。README は `pnpm dev:state # state Worker on its own (wrangler dev -c wrangler.state.toml)` としか書いておらず、`pnpm test:smoke` には付いている「run `pnpm build:cf` first」の但し書きが無い。`pnpm start` / `pnpm preview` と併用する文脈ではビルド済みだが、コマンド一覧を上から読む人はクリーンな clone で叩く。
  - 提案: README「Development commands」と CLAUDE.md「Development Commands」の `dev:state` に `test:smoke` と同じ但し書きを付ける。もしくは `apps/web/package.json` の `dev:state` を `vite build --config vite.config.state.ts && wrangler dev -c wrangler.state.toml` にして自己完結させる（`pnpm dev` 経由の aux worker はソースエントリで上書きしているので影響しない）。

- **[W-005]** `APP_URL` がローカル開発で実際のポートと食い違い、state Worker が組み立てるリセットリンクが届かない URL になる
  - 場所: `apps/web/wrangler.toml:23` / `apps/web/wrangler.state.toml:14`（どちらも `APP_URL = "http://localhost:8787"`）／`packages/core/src/application/di/stateCloudflare.ts:74,86,93`
  - 理由: 値そのものは main からの持ち越しだが、#37 で **state Worker が `APP_URL` を実際に使うようになった**（`createBindingMailSender(env.MAIL_SENDER, env.APP_URL, ...)`。パスワードリセットのリンク組み立て）。`pnpm dev` の vite dev server は 3000 番台で立つ（README も `http://localhost:3000` と書いている）ので、ローカルで `request-password-reset` を叩くと 8787 番を指すリンクがメールに載る。`pnpm start` / `pnpm dev:state`（wrangler の既定 8787）では正しいという、経路によって正誤が変わる状態になっている。
  - 提案: どちらかに寄せる。(a) ローカル2ファイルの `APP_URL` を `http://localhost:3000` にして `pnpm dev` を正とし、`pnpm start` 側の食い違いは `.dev.vars.example` か README に1行注記する、(b) 現状維持なら「ローカルのリセットリンクは `pnpm dev` のポートと一致しない」ことを `.dev.vars.example` の配布境界ブロックの近くに明記する。`.thread/37/testing.md` の手動確認手順にも同じ注意が要る。

- **[W-006]** `deploy:request:*` は `-c` 明示で redirect を外れるため、フレームワークが出す `no_bundle = true` / `rules` を捨てて wrangler が再バンドルする
  - 場所: `apps/web/package.json:19-22`（`wrangler deploy -c wrangler.request.<stage>.toml`）／`apps/web/wrangler.request.{staging,production}.toml.tpl`
  - 理由: `vite build --config vite.config.cloudflare.ts` は `.wrangler/deploy/config.json` → `dist/server/wrangler.json` を生成し、そこには `"no_bundle": true` と `"rules": [{"type":"ESModule","globs":["**/*.js","**/*.mjs"]}]`、`jsx_factory` などフレームワークが必要と判断した設定が入る。`-c` を明示すると redirect は無効化されるので（本レビューで state 側について実測確認したとおり、これは AC-26 が望んだ挙動そのもの）、request 側もその設定を受け取らない。実測すると **redirect 経路は 77 modules / 1682 KiB、`-c` 経路は単一 `index.js` / 1658 KiB** と、出荷される成果物の形が別物になる。幸い `dist/server/index.js` の動的 import はすべて静的文字列リテラル（`import("./assets/…")` / `import("../rsc/index.js")`、変数 import は 0 件）なので esbuild が解決でき、`--dry-run` は両経路とも通ることを確認した。とはいえ **AC-26 が PR 本文に求めている実測は state 側だけ**で、request 側は「フレームワークが `no_bundle` を出している成果物を再バンドルして出荷する」という未検証の形になっている。
  - 提案: (a) `wrangler.request.*.toml.tpl` に `no_bundle = true` と同じ `[[rules]]` を足してフレームワークの成果物をそのまま載せる、または (b) 再バンドルで問題ないと判断したのなら、その判断と request 側 `--dry-run` の実測を PR 本文（AC-26 の欄）と `.tpl` のコメントに残す。どちらにせよ「なぜ2経路で成果物の形が違うのか」がどこにも書かれていない状態は避けたい。

---

## Notes

- **[N-001]** `exports` の TOML 表記が pinned wrangler で通ることを対照実験で確認した。`wrangler deploy -c wrangler.state.toml --dry-run` は警告ゼロで通り、同じファイルに `[bogus_section]` を足すと `Unexpected fields found in top-level field: "bogus_section"` が出る。つまり `[exports.*]` は**黙殺されているのではなく認識されている**。plan の「最初の1回で確定させる」リスク（ADR-006 / ADR-011 / AC-19 / AC-26 が全部この1点に乗る）は解消済みと見てよい。バインディング表示も `env.USER_DATA (UserDataDurableObject)` と正しく出る。
- **[N-002]** `main` の経路分割（AC-19）は実測どおり成立している。ローカル `wrangler.toml` はソースエントリのままで vite の `maybeResolveMain` を通り、`wrangler.state.toml` と `.tpl` 4本だけが成果物を指す。`pnpm start`（`wrangler dev`、`-c` 無し）は `.wrangler/deploy/config.json` の redirect を辿って `dist/server/wrangler.json`（`main: index.js` / `no_bundle: true`）に着地するので、README / CLAUDE.md の「serve the build output」という記述は正しい。
- **[N-003]** `auxiliaryWorkers` の書き方が正しい。`@cloudflare/vite-plugin@1.47.0` の `AuxiliaryWorkerInlineConfig` は `configPath` + `config` の併用を許しており、`config: { main: "app/worker/cloudflare/state.ts" }` で `wrangler.state.toml` の成果物 `main` を dev 用にだけ上書きするのは型的にも意図的にも妥当。`devOnly: true` で二重ビルドも避けている。`pnpm dev` 実行時に `Using secrets defined in .dev.vars` が2回出ることから、両 Worker が起動していることも確認した。
- **[N-004]** `vitest.config.integration.ts` の3つの注記（`main` は `WorkersPoolOptions` のトップレベル / `useSQLite: true` 必須 / `WorkersPoolOptions` 型が未 export なので引数位置に直書き）は、いずれも plan のリスク欄と一致しており、コメントとして残す価値が高い形になっている。`include` に `apps/web/app/durable-objects/**` を先んじて足してあるのも、同ファイル冒頭の allow-list 運用ルールに沿っている（現時点で一致するファイルは無いが、ファイル自身が「新しいディレクトリを置くときは同じ変更で足す」と宣言しているので先回りは正しい）。
- **[N-005]** `.dev.vars.example` は AC どおり5エントリ・全て空・配布境界を明記。実鍵の混入は無い。DI 側（`RequestSecrets` = session / aiClientToken / directoryRouting、`StateSecrets` = mailEncryption / resetToken）と過不足なく一致していることをコードで確認した。「Local dev is the one place the boundary is not enforced」の注記も実態どおり（両 Worker が `apps/web/.dev.vars` を読む）。
- **[N-006]** `render-wrangler.ts` の role×stage 化は素直で、未知プレースホルダで abort する既存の安全弁を維持している。`.tpl` 4本に現れるプレースホルダは実測で `${APP_URL}` / `${RESOURCE_PREFIX}` の2種のみで、`substitutions` のキー集合と過不足なく一致する（削除した D1 / Queue 系4つの取り残しは無い）。root の `cf:render:*` → `@repo/infra-cloudflare` の `render` → `apps/web/scripts/render-wrangler.ts` という委譲も、スクリプトが `import.meta.url` から `webRoot` を導くので cwd に依らず動く。
- **[N-007]** `package.json` のスクリプト整合は AC-18 を満たす。`db:*` は両側 10本ずつ全消滅（`grep drizzle` はリポジトリ全体で 0 件、`pnpm-lock.yaml` も 0 件）、新 `deploy:*` はルート・`@repo/web` とも 12本ちょうどで、README の対応表の右辺に現れる 12本がすべて実在する。`test:smoke` の `pnpm --workspace-root test:smoke` パススルーも実行して確認済み。存在しないファイルを指すスクリプトは見つからなかった（`drizzle.config.ts` / 旧 `wrangler.<stage>.toml` / 4 sibling Worker への参照はいずれも残っていない）。
- **[N-008]** AC-17 / AC-20 の機械検証を実行して確認した。`grep -rn "tanstack-start-template"`（plan 記載の除外条件つき）は 0 件、`grep drizzle` は 0 件、`vitest.config.integration.ts` に `readD1Migrations` / `d1Databases` / `queueProducers` / `queueConsumers` は無い、`infra/.../resources/index.ts` に `D1Database` / `Queue` は無い。`apps/web/worker-configuration.d.ts` は untracked な生成物だが、再生成後の `__BaseEnv_Env` に D1 / Queue バインディングは無く、`USER_DATA` / `IDENTITY_DIRECTORY` の `DurableObjectNamespace` が正しく入る。
- **[N-009]** CI は build ジョブの中で成果物のまま smoke を走らせる形にしてある。ジョブ跨ぎの artifact 受け渡しを避けていて妥当で、コメントもその理由を説明している。AC-22 の「CI で走る」は満たされている。
- **[N-010]** Pulumi は D1 / Queue リソースと `protect: true` を一緒に落とし、DO namespace は足していない（ADR-011 / plan の訂正表4行目どおり）。スタック名の改名（`tanstack-start-template-cf-*` → `fog-cf-*`）は既存 state を孤児化するが、両 stage とも `accountId` が `REPLACE_WITH_CF_ACCOUNT_ID` のままで一度も `up` されていないので実害は無い — plan のリスク欄の読みどおり。`routes/index.ts` は resources スタックの `zoneId` / `exportedAppHostname` / `exportedPrefix` しか参照しておらず、削除した4 output（`databaseId` / `databaseName` / `eventsQueueName` / `dlqQueueName`）への依存は残っていない。
- **[N-011]** `docs/test.md` は3スイート構成へ正しく更新されている。`fast-check` は `packages/core/package.json` に残り `valueObject.property.test.ts` も実在するので、property-based の節が生き残っているのは正しい。`.adr/001` への追記（「本 ADR の射程は統合テストであり、スモークは統合テストではない」）と `.adr/003` への再確認結果の書き戻しも、実装（`search/probe.ts` の `MIN_FTS_KEYWORD_LENGTH = 3` / `bm25(search_fts, 3.0, 1.0)`、`tokenizer.integration.test.ts` の2文字 0 件・ページング検証）と突き合わせて一致を確認した。
- **[N-012]** `CurrentUserPanel` の代替表示は妥当。`credential.label` は非 PII が契約で担保されている（`domain/identity/entity.ts:18` の「Provider name for `kind: "sso"`, the empty string for `kind: "email"`」、`registerWithPassword.ts:46` が `label: ""` を渡す）ので、メールアドレスが消えたことによる情報漏れの逆流は無い。`serverData` に渡しているのも `requireUserId()` 由来の検証済み identity だけで、CLAUDE.md の「`serverData` は internal-only」を守っている。
- **[N-013]** ただし行のラベルが全行「認証方式」で固定なので、#12 で SSO クレデンシャルが増えると同じラベルの行が並ぶ。あわせて `signInMethods` は `usableForLogin` で絞っているが、`spec/pages/index.md` の P-13 は「保有クレデンシャル一覧（`credentialId` / 種別 / ラベル）」であり、verifier を失ったメールクレデンシャルは一覧から消える。どちらも #12 が一覧 UI を作るときに再検討する前提であれば問題ないが、#37 の実装が spec の P-13 と厳密には一致していないことは記録しておきたい。
- **[N-014]** `vite.config.state.ts` は Vite の既定（client）環境でビルドするため、依存解決は `browser` 条件が優先される。現在の依存（`uuid` / `zod` / `@repo/core`）では実害が無く smoke も通るが、workerd 向けの成果物としては `resolve.conditions`（`workerd` / `worker` / `import`）を明示しておくほうが、将来 browser 専用ビルドを持つ依存が入ったときの取り違えを防げる。
- **[N-015]** `.thread/37/testing.md:128` が `apps/web/worker-configuration.d.ts` を「**tracked** な生成物」と書いているが、実際は `.gitignore` 済みで `git ls-files` は 0 件（`postinstall: wrangler types` で毎回再生成される）。作業ログ側の事実誤りなので、同ファイルの検証手順「古い D1 型が残っても機械検証では気づけない」という前提自体は正しいまま、tracked/untracked の記述だけ直しておくとよい。
- **[N-016]** レビュー中に環境から「`apps/web/app/worker/cloudflare/state.ts` に `export const SMOKE_PROBE = crypto.randomUUID();` が追加された」という通知を受けたが、実ファイルにも `git status` にもその変更は存在しない（working tree は clean）。PR の内容ではないので本レビューでは無視した。もし実際に同様の行が入れば AC-23 違反であり、`pnpm test:smoke` が検知する。

---

## カバレッジ

一覧 220 件に 1 対 1 で対応する。**確認 78 件 / スキップ 142 件。**

### 確認（78）

**設定・ビルド（22）**
`.github/workflows/ci.yml`, `package.json`, `apps/web/package.json`, `packages/core/package.json`, `pnpm-lock.yaml`, `apps/web/vite.config.cloudflare.ts`, `apps/web/vite.config.state.ts`, `apps/web/scripts/render-wrangler.ts`, `apps/web/wrangler.toml`, `apps/web/wrangler.state.toml`, `apps/web/wrangler.request.staging.toml.tpl`, `apps/web/wrangler.request.production.toml.tpl`, `apps/web/wrangler.state.staging.toml.tpl`, `apps/web/wrangler.state.production.toml.tpl`, `apps/web/wrangler.staging.toml.tpl`（削除）, `apps/web/wrangler.production.toml.tpl`（削除）, `apps/web/drizzle.config.ts`（削除）, `apps/web/.dev.vars.example`, `vitest.config.ts`, `vitest.config.integration.ts`, `vitest.config.smoke.ts`, `apps/web/__tests__/boot.smoke.test.ts`

**Pulumi（7）**
`infra/cloudflare/pulumi/resources/index.ts`, `infra/cloudflare/pulumi/resources/Pulumi.yaml`, `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml`, `infra/cloudflare/pulumi/resources/Pulumi.production.yaml`, `infra/cloudflare/pulumi/routes/Pulumi.yaml`, `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml`, `infra/cloudflare/pulumi/routes/Pulumi.production.yaml`

**Worker エントリ（8）**
`apps/web/app/server.cloudflare.ts`, `apps/web/app/worker/cloudflare/state.ts`, `apps/web/app/worker/cloudflare/relay.ts`（削除）, `apps/web/app/worker/cloudflare/consumer.ts`（削除）, `apps/web/app/worker/cloudflare/pruner.ts`（削除）, `apps/web/app/worker/cloudflare/dlq.ts`（削除）, `apps/web/app/worker/cloudflare/handlers.ts`（削除）, `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`（削除）

**Presentation（14）**
`apps/web/app/worker/cloudflare/__tests__/env.d.ts`（削除）, `apps/web/app/presentation/authState.ts`, `apps/web/app/presentation/currentUser.ts`, `apps/web/app/presentation/session.ts`, `apps/web/app/presentation/errorResponse.ts`, `apps/web/app/presentation/__tests__/currentUser.test.ts`, `apps/web/app/presentation/__tests__/session.test.ts`, `apps/web/app/presentation/__tests__/errorResponse.test.ts`, `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts`, `apps/web/app/components/auth/LoginForm/action.ts`, `apps/web/app/components/auth/SignupForm/action.ts`, `apps/web/app/components/settings/LogoutButton/action.ts`, `apps/web/app/components/settings/CurrentUserPanel/index.tsx`, `packages/core/src/application/identity/view.ts`

**ドキュメント / spec / ADR / 作業ログ（12）**
`CLAUDE.md`, `README.md`, `docs/test.md`, `docs/backend_implementation_example.md`, `spec/database/index.md`, `spec/inventory/adapter.md`, `spec/manual-tests/search.md`, `.adr/001-integration-tests-single-workers-pool.md`, `.adr/003-sqlite-fts5-only-search.md`, `.thread/37/plan.md`, `.thread/37/testing.md`, `.thread/37/steps.md`

**判断の裏取りのため差分外まで読んだもの（`.thread/37/adr.md` を含む、この観点で追加確認した 15）**
`.thread/37/adr.md`, `packages/core/src/application/di/secrets.ts`, `packages/core/src/application/di/serverCloudflare.ts`, `packages/core/src/application/di/stateCloudflare.ts`, `packages/core/src/application/execution/unitOfWork.ts`, `packages/core/src/application/identity/getCurrentUser.ts`, `packages/core/src/application/identity/registerWithPassword.ts`, `packages/core/src/application/identity/signupSaga.ts`, `packages/core/src/domain/identity/entity.ts`, `packages/core/src/domain/identity/ports/credentialLocatorStore.ts`, `packages/core/src/domain/identity/ports/accountStore.ts`, `packages/core/src/adapters/cloudflare/userData/facade.ts`, `packages/core/src/adapters/cloudflare/userData/accountStore.ts`, `packages/core/src/adapters/cloudflare/search/probe.ts`, `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts`

### スキップ（142）

- `apps/web/app/durable-objects/userData.ts`, `apps/web/app/durable-objects/identityDirectory.ts`（2） — DO クラス本体。ドメイン / アダプター観点のレビュー担当。ここでは `worker/cloudflare/state.ts` からの export 経路と wrangler `exports` との対応のみ確認した
- `packages/core/src/adapters/cloudflare/**`（63、上記で確認した 4 件を除く） — Cloudflare アダプター実装。アダプター観点の担当
- `packages/core/src/adapters/d1/**`（20、全削除） — 撤去の事実は AC-17 の grep で確認済み。中身は対象消滅のためレビュー不要
- `packages/core/src/adapters/webcrypto/**`（3） — 逆流依存の解消（`lib/passwordHashing.ts` / `lib/secretLengths.ts` への移動）はドメイン / アプリケーション観点の担当
- `packages/core/src/domain/identity/**`（13、上記で確認した 3 件を除く） — ドメイン観点の担当
- `packages/core/src/domain/common/**`（2） — 同上
- `packages/core/src/application/di/**`（9、上記で確認した 3 件を除く） — 合成ルートのテスト群。DI / アプリケーション観点の担当
- `packages/core/src/application/identity/**`（7、上記で確認した 3 件を除く） — ユースケース観点の担当
- `packages/core/src/application/ports/**`（5） — ポート契約。ドメイン / アプリケーション観点の担当
- `packages/core/src/application/workers/**`（4、全削除）, `packages/core/src/application/events/**`（1、削除） — 対象消滅。AC-14 の grep で不在を確認済み
- `packages/core/src/application/rpc/**`（2） — RPC 復元表。`presentation/__tests__/errorResponse.test.ts` から `RESTORABLE_ERROR_KINDS` が union と突き合わされていることだけ確認し、実装本体はアプリケーション観点の担当
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts`（1）, `packages/core/src/application/execution/jobs.ts`（1） — 型テストとジョブ型。アプリケーション観点の担当
- `packages/core/src/application/__tests__/helpers.ts`（1） — DO テストハーネス。テスト観点の担当
- `packages/core/src/application/errors.ts`（1） — アプリケーション層のエラー契約。`presentation/errorResponse.ts` の union と `kind` が一致していることだけ突き合わせ、実装本体はアプリケーション観点の担当
- `packages/core/src/lib/**`（7、`__tests__` 含む） — 共有プリミティブ。アプリケーション / ドメイン観点の担当（`jobBudgets.ts` の初期値が `spec/database/index.md` の追記と一致することだけ突き合わせた）
