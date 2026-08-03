# レビュー（2回目）: PR #49 — Presentation / Config・Build・Docs

**対象:** PR #49（base `main`、7 commits: `01247b5`..`b1caa65`、変更 248 ファイル）
**契約:** `.thread/37/plan.md`（AC-17〜AC-22 / AC-26 / AC-28 を中心に）
**観点:** Presentation / Config・Build・Docs
**実施日:** 2026-08-03

1回目（`review-001-presentation-config.md`）の指摘と `triage.md` / `.thread/37/adr.md`（ADR-060〜064）を読み、修正の検証を主眼に見た。差分の読解だけでなく次を実行して裏取りした。

- `pnpm typecheck` / `pnpm lint` / `pnpm format:check` — clean（`biome.json` のスキーマ版差分 info 2件は本 PR 由来ではない）
- `pnpm build:cf` → `pnpm test:unit`（36 files / 510 pass）/ `pnpm test:smoke`（2 pass）
- **`wrangler deploy --dry-run` を3経路で実測**（wrangler 4.114.0）— redirect 経路 / `-c wrangler.request.staging.toml`（`.tpl` を手でレンダリング）/ `-c wrangler.state.toml`
- `pnpm dev` を起動して `/login` 200・`/settings` → `307 /login?redirect=%2Fsettings`、および `<meta property="og:url">` の実値を確認
- `@tanstack/react-router@1.170.18` の `dist/esm/Match.js` を読み、`errorComponent` を置いたときの境界の張られ方を確認

---

## Blockers

なし。

---

## Warnings

- **[W-001]** `redactForClient` が新たに潰した4 kind は、**ログにも残らない**ので運用側からも消える（ADR-061 の「運用側は raw を見る」が偽）
  - 場所: `apps/web/app/presentation/errorResponseMiddleware.ts:67-69` / `apps/web/app/presentation/errorResponse.ts:110-111`
  - 理由: `toClientError` は `if (rawSerialized.kind === "system" || rawSerialized.kind === "unknown")` のときだけ `logServerError` を呼ぶ。ADR-061 が `notFound` / `conflict` / `unauthorized` / `forbidden` の `message` をワイヤから落としたので、この4 kind のサーバ側自由文は**どこにも残らなくなった**。ADR-061「Consequences」の *運用側は raw を見る（`errorResponseMiddleware` の logger 経路は redact 前の値を渡している）ので triage は影響を受けない* は、まさに今回潰した4 kind については成立しない。`errorResponse.ts` の新 JSDoc も *server-side logs must use the raw form so operators retain the original code / message for triage* と断定しており、コードがその断定を満たしていない。実害の具体例は ADR 自身が挙げた `JOB_PAYLOAD_MISMATCH` で、`operationKey` を落とすのは正しいが、**同じ操作でメッセージ全体が観測不能になる**（ジョブ経路は runner 側のログが別にあるが、`OPTIMISTIC_LOCK_FAILURE` のようにサーバ関数境界へ出る `conflict` は救われない）。
  - 提案: どちらか。(a) `logServerError` の発火条件を「redact でメッセージを落とす kind」＝ `business` / `validation` 以外へ広げる（1行）。(b) 広げないなら、JSDoc の断定と ADR-061 の Consequences を「メッセージが残るのは `business` / `validation` だけで、他はワイヤにもログにも出ない」に直す。**現状は「実装 < 文書」で、次に triage する人が存在しないログを探すことになる。**

- **[W-002]** `APP_URL` を 3000 に固定した（ADR-063）が、`pnpm dev` のポートは固定されていない — **実測で 3013 に流れ、`og:url` が到達しないポートを指した**
  - 場所: `apps/web/vite.config.cloudflare.ts:47-53`（`server: { port: 3000, host: true }`、`strictPort` なし）/ `apps/web/wrangler.toml:29` / `apps/web/wrangler.state.toml:20` / `README.md:92`
  - 理由: ADR-063 は「正は `pnpm dev`（3000）」という前提の上に立っているが、vite は既定で**ポートが塞がっていれば黙って +1 していく**。本レビュー環境では 3000〜3012 が使用中で、`pnpm dev` は 3013 で起動し、`/login` の応答は `<meta property="og:url" content="http://localhost:3000/login">`（＝アプリが載っていないポート）を返した。state Worker が組み立てるリセットリンクも同じ値から作られるので、W-005 で潰したはずの「リンクが届かない」状態が**別の理由で再発する**。しかも今度は README の記述（「`pnpm dev` の 3000」）が正しく見えるぶん気づきにくい。
  - 提案: `vite.config.cloudflare.ts` の `server` に `strictPort: true` を足す。3000 が塞がっていれば起動が失敗するので、「設定と実ポートが黙って割れる」状態が構造的に起きなくなる。ADR-063 が選んだ「頻度の高いほうを正にする」判断はそのまま維持できる。

- **[W-003]** エラー面が3つになり、うち2つは本文が重複している — しかも「見た目は同じ構成に揃えてある」が既に割れている
  - 場所: `apps/web/app/routes/_app/settings.tsx:71-84` / `apps/web/app/routes/_app.tsx:52-62`（＋ `apps/web/app/routes/__root.tsx:58-95`）
  - 理由: ADR-060 は「エラー面が2箇所に増えたので片方だけ直すと割れる」をトレードオフとして自覚しているが、**マージ前の時点で既に割れている** — `ShellErrorScreen` の `<section className="flex flex-col gap-lg py-2xl">` に対し `SettingsErrorScreen` は `pb-2xl` で、上余白の有無が違う（`SettingsErrorScreen` は既存 `AppShell` の内側に出るので意図的な差だとは読めるが、そう書いてある場所が無い）。残りの3行（`ERROR_TITLE` の `h2` / `message === ERROR_TITLE ? null :` の分岐 / `<ErrorRetry />`）は完全な逐語コピーで、`__root.tsx` を数えれば同じ構造が3箇所にある。`components/ui/ErrorRetry` が既に「共有のエラー面のための部品」を名乗っている以上、共有すべきは `ErrorRetry` だけではない。
  - 提案: 内側のブロック（見出し ＋ 条件つきメッセージ ＋ `ErrorRetry`）を `components/ui/ErrorRetry`（もしくは `ErrorSurface`）へ抽出し、余白差だけを prop / className で受ける。`__root.tsx` は `AuthSheet` の `title` / `description` 経路なので無理に寄せなくてよいが、`_app` と `/settings` の2つは同一実装にできる。

- **[W-004]** CLAUDE.md「Frontend」に、今回学んだ規約（**streaming するルートは自前の `errorComponent` を持たないと親のエラー面に丸ごと差し替わる**）が書かれていない
  - 場所: `CLAUDE.md:63`（Loading fallbacks の段落。`/settings` を streaming の参照実装として名指ししている）
  - 理由: ADR-060 の中身は `.thread/37/adr.md` と `settings.tsx` のコメントにしか無い。CLAUDE.md は `/settings` を「per-fragment streaming の reference」と名指ししており、参照実装は今回 **(i) 断片の外に置く UI、(ii) ルート固有の `errorComponent`** という2つの構造要素を獲得したのに、CLAUDE.md はスケルトンと `pendingComponent` の話しかしていない。`_app` に `errorComponent` があるだけでは境界にならない（`Match.js` の `ResolvedCatchBoundary` は**そのルート自身の** `errorComponent` の有無で決まる）という事実は、次に streaming ルートを足す #10 / #11 が最も踏みやすい穴で、しかも「落ちるのは断片だけ」という直感と逆である。
  - 提案: `CLAUDE.md:63` の段落末に2文足す — 「streaming 断片の throw は**そのルートの** `errorComponent` が無ければ親（`_app`）のエラー面まで昇り、画面全体が差し替わる。断片が落ちても残さなければならない操作（`/settings` のログアウト）がある画面は、`errorComponent` をそのルートに置き、その操作を `Suspense` の外に出す」。AC-28 が要求する「Key concepts の一致」の外側だが、CLAUDE.md が参照実装を名指ししている以上ここが正本になる。

- **[W-005]** `wrangler.request.*.toml.tpl` のコメントが焼き込んだ実測値が、**マージ時点で既に古い**
  - 場所: `apps/web/wrangler.request.staging.toml.tpl:22-30` / `apps/web/wrangler.request.production.toml.tpl:23-31`（「77 modules / 1682 KiB either way with them, a single 1658 KiB `index.js` without」）
  - 理由: HEAD をビルドして両経路を実測すると **redirect 経路・`-c` 経路とも `Total (75 modules) 1134.29 KiB` / `Total Upload: 1690.12 KiB`**（警告ゼロ）で、コメントの 77 / 1682 とは一致しない。ADR-062 を書いた時点の値がそのまま `.tpl` に転記され、その後の修正（`settings.tsx` に `ErrorRetry` が入るなど）でチャンク構成が動いたためである。**主張そのもの（「両経路で成果物の形が一致する」「無いと単一ファイルへ再バンドルされる」）は実測で成立している**が、絶対値はビルドのたびに動くので、committed な設定コメントに置くと恒久的に嘘になる。
  - 提案: `.tpl` のコメントからモジュール数・KiB を落とし、「redirect 経路（`wrangler deploy`、`-c` なし）と同じ形になることを `--dry-run` で突き合わせて確認すること」という**手順**に書き換える。実測値は ADR / PR 本文（日付つき）に残せば十分。

- **[W-006]** `docs/test.md` が、リポジトリのどこにも存在しない「pre-PR checks」を根拠に断定している
  - 場所: `docs/test.md:68`（"The suite is run under `--sequence.shuffle` as part of the pre-PR checks for exactly this reason."）／`packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts:24` も同じ前提を引く
  - 理由: `--sequence.shuffle` を走らせるスクリプトは root にも `@repo/web` にも無く（`package.json` に 0 件）、`.github/workflows/ci.yml` の3ジョブも `pnpm test:integration` を素で叩くだけである。`docs/test.md` の「Commands」表にも載っていない。読者は「どこかで自動的にシャッフル実行されている」と受け取るが、実体は誰も走らせない。順序独立性を name uniquing に寄せた判断（ADR-082）は妥当なので、その担保だけが宙に浮いている形。
  - 提案: `test:integration:shuffle`（`vitest run --config vitest.config.integration.ts --sequence.shuffle`）を `package.json` に足して「Commands」表に載せるか、文を「順序依存を疑ったら `pnpm test:integration --sequence.shuffle` で確かめる」という手順に書き換える。

---

## Notes

- **[N-001]** W-006（1回目）の修正を実測で確認した。`-c wrangler.request.staging.toml --dry-run` と redirect 経路（`wrangler deploy --dry-run`）が**完全に同一の 75 modules / 1690.12 KiB**（`rsc/index.js` / `assets/*.js` が個別モジュールとして載る形）を出し、どちらも警告ゼロ。`no_bundle` を `main` の直後に置く配置も正しく、`[[durable_objects.bindings]]` の後ろに落ちていない。`-c wrangler.state.toml --dry-run` も警告ゼロで `exports` が認識される（バインディング表示も正しい）。production 側 `.tpl` は staging とコメントの折り返し以外の差分が無く、`no_bundle` / `[[rules]]` を同形で持つ。
- **[N-002]** W-002（1回目）の修正が構造として成立していることを、フレームワークの実装まで降りて確認した。`@tanstack/react-router@1.170.18` の `Match.js` で `ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment` であり、`CatchBoundary` は `MatchInner`（＝そのルートの component）を包む。したがって `Deferred` の `use()` が投げた例外は `/settings` 内で止まり、`SettingsErrorScreen` が `SettingsScreen`（＝ログアウトボタン）ごと再描画する。ログアウト経路が失効セッションでも成立することも実コードで裏取りした — `logoutFn` は `requireUserId()` を通るが、これは `sessionCodec.verify` だけで **DO を叩かない**（`presentation/currentUser.ts:26-39`）、`application/identity/logout.ts` は `UserId.create` のみ。ADR-060 の主張どおり。
- **[N-003]** ADR-061 の3分類は `errorDisplay.ts` と突き合わせて正しい。`renderErrorMessage` の `notFound` / `conflict` / `unauthorized` / `forbidden` の枝は固定文言か `renderConflictMessage(code)` で、**`error.message` を一度も読まない**（`business` / `validation` だけが `?? error.message` のフォールバックを持つ）。UI 側の消費点も `displayError` / `renderErrorMessage` 経由のみであることを grep で確認したので、メッセージを潰しても表示は変わらない。網羅 `switch` にしたことで新 kind の追加時に分類を強制できる形になっており、`errorResponse.test.ts` の追加2本（4 kind の `code` 保持 / `JOB_PAYLOAD_MISMATCH` の `operationKey` 非露出）も主張と噛み合っている。
- **[N-004]** スケルトンの**行数**は実 DOM と一致した（B-001 解消）が、**行の高さ**は 4px ずれている。`BAR` の `h-skeleton-line` は 1rem（`tokens.css:132`）、実行の中身は `text-sm` の span なので行ボックスは 1.25rem。`ROW` の `py-row` は共通なので、差はそのまま 4px のシフトになる。本 PR 由来ではない（`main` でも同じ構成で、1回目の指摘も行数についてだった）が、`SettingsSkeleton` の JSDoc が今回あらためて *without shifting the layout* を明言したので、詰めるならこの JSDoc を書き換えた今が最も安い。
- **[N-005]** `spec/**` から `.thread/37/adr.md` への参照が8箇所新設された（`spec/database/index.md` 3 / `spec/domains/identity.md` 2 / `spec/inventory/domain.md` 1 / `spec/usecases/identity.md` 2）。`origin/main` では `spec/` も `docs/` も `.thread/` を1件も参照していなかったので新しい先例である。`.thread/` は tracked なのでリンクは切れず、直近の main が「ADR-011 の昇格を取り消し」ている以上 `.adr/` へ上げないのは方針として一貫している。ただし**正本（spec）が作業ログを根拠に引く**構図になったことは意識しておきたい — #38 以降で `.thread/37/` を読まない読者が増える。
- **[N-006]** `docs/runtime_cloudflare.md` の警告ブロックと、README / CLAUDE.md からの「正本」名指しの撤去は妥当（W-001 解消）。相対リンクの機械検査（`README.md` / `CLAUDE.md` / `docs/*.md` のリンク先とバッククォート付きパス）を掛けて dead link 0 件を確認した。`docs/backend_implementation_example.md` の警告ブロックも同形で残っている（AC-28）。
- **[N-007]** AC-28 の「Key concepts が新構成と一致」を実コードで裏取りした。追記された UoW の2文（`recalcTrashPurgeAfter` / `findOperation`）は `application/execution/unitOfWork.ts:43-85` の `UserDataUnitOfWorkContext` の全メンバと過不足なく一致し、`IdentityDirectoryUnitOfWorkContext` 側の記述（`resetTokenStore` / `rotationCheckpointStore` / `enqueueJob` のみ）も一致する。Cross-layer catch policy の5項目め（migration ゲート）も `CLAUDE.md:108` に入っている。「Migration in progress — #37」節は削除済み。
- **[N-008]** `pnpm dev:state` のビルド内包（ADR-064）は開発体験を壊していない。`vite.config.state.ts` の `outDir` は `dist/state` で `dist/server` を消さず（実測で `build:cf` の2段が互いを消さないことも確認済み）、`pnpm dev` の aux worker 経路はソースエントリを `config: { main }` で上書きするので無関係。なお `wrangler dev` はビルド成果物を見るだけなので**ソース変更時は再起動が要る**点は変わらないが、README は "builds dist/state, then wrangler dev" と書いており誤解は生まない。
- **[N-009]** `CLAUDE.md:125` は英文の途中から日本語に切り替わる（"Operational guidance lives in `README.md`「Development commands」/「Deployment」と `apps/web/.dev.vars.example`。… `pnpm dev` / `pnpm build` / `pnpm start` are aliases of their `:cf` counterparts."）。同ファイルで日本語なのは「Examples」節だけなので、1文の中で混ぜるより英語に揃えるほうが読みやすい（`docs/backend_implementation_example.md` の警告は独立した1ブロックなので気にならない）。
- **[N-010]** 起動スモークの mtime ゲート（ADR-085）は、**内容が変わらなくても mtime を触る操作**で赤くなる。本レビュー中に実際に1回空振りし（`packages/core/src/lib/jobKind.ts` / `search/probe.ts` の mtime だけが進み、`git status` は clean）、再ビルドで緑になった。並行して走る他エージェントの `lint:fix` などが原因と思われる。テスト観点の担当だが、Docs 側の緩和として `docs/test.md`「Commands」表の `pnpm test:smoke` 行を `pnpm build:cf && pnpm test:smoke` の1組で書いておくと事故が減る。
- **[N-011]** 検証実行の結果: `pnpm typecheck` / `pnpm lint` / `pnpm format:check` clean、`pnpm test:unit` 36 files / 510 pass、`pnpm build:cf` 成功、`pnpm test:smoke` 2 pass、`pnpm dev` は2 Worker 構成で起動して `/login` 200・`/settings` 307。AC-29 のうち本観点で確認できる範囲は満たしている。

---

## 1回目指摘の修正検証

| ID | 判定 | 根拠 |
|---|---|---|
| B-001（スケルトンが実 DOM と一致しない） | **解消** | `SettingsSkeleton` はラベル1本＋`mt-sm` の1行になり、`CurrentUserPanel` の実 DOM（`registerWithPassword` が作る単一クレデンシャル）と行数が一致。ログアウト部を落としたのも、それが断片の外へ出た事実と整合する。JSDoc も「one credential row」＋「sign-out affordance is deliberately absent」へ更新済み。行**高**の 4px 差は残るが本 PR 由来ではない（N-004） |
| W-001（`docs/runtime_cloudflare.md` の陳腐化） | **解消** | 同ファイル冒頭に `> [!WARNING]` を追加。README:63 / CLAUDE.md:125 の「正本」名指しも撤去され、代わりに README「Development commands」「Deployment」と `.dev.vars.example` を指す。本体改訂は #38 のままでスコープを侵していない |
| W-002（失効セッションでログアウト導線が消える） | **解消** | `LogoutButton` を `SettingsScreen`（`Suspense` の外）へ移し、`/settings` に `errorComponent` を新設。提案 (a) 単独では塞がらないという ADR-060 の分析はフレームワーク実装で裏取りでき、採用した (a)+(b') の組が正しい（N-002）。cookie の自動破棄が積み残しである点も ADR に明記されている |
| W-003（CLAUDE.md の UoW 記述が実装と不一致） | **解消** | `recalcTrashPurgeAfter`（暫定・集約テーブルへの一括書き込み）と `findOperation`（読み）の位置づけが CLAUDE.md:69 に追記され、`unitOfWork.ts` の実体と一致（N-007）。spec 側の暫定注記も `spec/database/index.md#user_settings` に引き継がれ済み |
| W-004（`dev:state` がビルド成果物を要求する） | **解消** | `dev:state` が `vite build --config vite.config.state.ts && wrangler dev …` になり自己完結。README:101 / CLAUDE.md:29 の説明も追随（N-008） |
| W-005（ローカル `APP_URL` のポート不一致） | **解消（ただし新たな穴あり）** | 両 toml を 3000 に統一し、8787 経路の食い違いを両ファイルのコメントと README:92 に明記。ただし vite が `strictPort` 無しなので、3000 が塞がると同じ症状が別経路で再発する → **本回 W-002** |
| W-006（`deploy:request:*` が成果物を再バンドル） | **解消（実測確認）** | request `.tpl` 2本に `no_bundle` / `[[rules]]` が入り、`--dry-run` の実測で redirect 経路と**完全一致**（75 modules / 1690.12 KiB、警告ゼロ）。ADR-062 が記録した TOML の落とし穴（トップレベルキーの配置）も正しく回避されている。コメントに焼き込んだ数値だけが陳腐化 → **本回 W-005** |
| security W-003（presentation 側: `conflict` が redact 対象外） | **解消（ただし文書と実装が不一致）** | `redactForClient` が網羅 `switch` の3分類になり、4 kind は `code` だけ通す。分類の根拠は `errorDisplay.ts` と突き合わせて正しい（N-003）。ただしログ側の非対称が残る → **本回 W-001** |

1回目の Notes（N-001〜N-016）は判定対象外。うち N-015（`.thread/37/testing.md:128` の tracked/untracked 誤り）は未修正のままだが、作業ログの記述であり triage でも取り上げられていないので再審議しない。

---

## カバレッジ

一覧 248 件に 1 対 1 で対応する。**確認 40 件 / スキップ 208 件。**

### 確認（40）

**設定・ビルド（17）**
`.github/workflows/ci.yml`, `package.json`, `apps/web/package.json`, `apps/web/vite.config.cloudflare.ts`, `apps/web/vite.config.state.ts`, `apps/web/scripts/render-wrangler.ts`, `apps/web/.dev.vars.example`, `apps/web/wrangler.toml`, `apps/web/wrangler.state.toml`, `apps/web/wrangler.request.staging.toml.tpl`, `apps/web/wrangler.request.production.toml.tpl`, `apps/web/wrangler.state.staging.toml.tpl`, `apps/web/wrangler.state.production.toml.tpl`, `apps/web/wrangler.staging.toml.tpl`（削除）, `apps/web/wrangler.production.toml.tpl`（削除）, `apps/web/drizzle.config.ts`（削除）, `apps/web/__tests__/boot.smoke.test.ts`

**Presentation（7）**
`apps/web/app/routes/_app/settings.tsx`, `apps/web/app/components/settings/CurrentUserPanel/index.tsx`, `apps/web/app/components/settings/SettingsSkeleton/index.tsx`, `apps/web/app/components/settings/LogoutButton/action.ts`, `apps/web/app/presentation/errorResponse.ts`, `apps/web/app/presentation/__tests__/errorResponse.test.ts`, `apps/web/app/presentation/currentUser.ts`

**ドキュメント（5）**
`CLAUDE.md`, `README.md`, `docs/test.md`, `docs/runtime_cloudflare.md`, `docs/backend_implementation_example.md`

**spec（7）**
`spec/database/index.md`, `spec/domains/identity.md`, `spec/usecases/identity.md`, `spec/inventory/adapter.md`, `spec/inventory/domain.md`, `spec/inventory/usecase.md`, `spec/testcases/identity/unlinkSsoCredential.md`

**作業ログ（4）**
`.thread/37/plan.md`, `.thread/37/adr.md`（ADR-060〜064 と参照した項）, `.thread/37/review/triage.md`, `.thread/37/review/review-001-presentation-config.md`

**差分外だが判断の裏取りのため読んだもの（カバレッジには数えない）**
`apps/web/app/routes/_app.tsx`, `apps/web/app/routes/__root.tsx`, `apps/web/app/components/ui/ErrorRetry/index.tsx`, `apps/web/app/components/ui/Deferred/index.tsx`, `apps/web/app/components/settings/LogoutButton/index.tsx`, `apps/web/app/presentation/errorDisplay.ts`, `apps/web/app/presentation/errorResponseMiddleware.ts`, `apps/web/app/presentation/head.ts`, `apps/web/app/styles/{tokens,theme}.css`, `packages/core/src/application/execution/unitOfWork.ts`, `packages/core/src/application/identity/logout.ts`, `packages/core/src/domain/identity/entity.ts`, `spec/pages/index.md`, `node_modules/.../@tanstack/react-router/dist/esm/Match.js`, `apps/web/dist/server/wrangler.json`, `apps/web/.wrangler/deploy/config.json`

### スキップ（208）

- `vitest.config.ts`, `vitest.config.integration.ts`, `vitest.config.smoke.ts`（3） — 本回の修正で未変更。1回目で確認済み（N-004）
- `packages/core/package.json`, `pnpm-lock.yaml`（2） — 同上（AC-17 / N-007 の grep 検証済み）
- `infra/cloudflare/pulumi/**`（7） — 本回の修正で未変更。1回目で確認済み（N-010）
- `.adr/001-integration-tests-single-workers-pool.md`, `.adr/003-sqlite-fts5-only-search.md`（2） — 同上（N-011）
- `spec/manual-tests/search.md`（1） — 本回の修正で未変更
- `.thread/37/steps.md`, `.thread/37/testing.md`, `.thread/37/review/review-001.md`, `.thread/37/review/review-001-{adapter-infra,domain-usecase,security,test}.md`（7） — 他観点の作業ログ・レビュー記録。修正の妥当性判断に必要な範囲は `triage.md` 経由で参照した
- `apps/web/app/server.cloudflare.ts`（1） — 本回の修正で未変更。1回目で確認済み
- `apps/web/app/worker/cloudflare/**`（8。`state.ts` 新設 ＋ relay / consumer / pruner / dlq / handlers とそのテスト2本の削除） — 本回の修正で未変更。1回目で確認済み
- `apps/web/app/durable-objects/**`（4） — DO クラス本体と RPC エントリテスト。アダプター / テスト観点の担当
- `apps/web/app/presentation/` の残り5件（`authState.ts`, `session.ts`, `__tests__/{currentUser,errorResponseMiddleware,session}.test.ts`） — 本回の修正で未変更。1回目で確認済み（`errorResponseMiddleware.ts` 本体は差分に無いが、W-001 の判断のため読んだ）
- `apps/web/app/components/auth/{LoginForm,SignupForm}/action.ts`（2） — 本回の修正で未変更。1回目で確認済み
- `packages/core/src/adapters/cloudflare/**`（73） — Cloudflare アダプター実装。アダプター観点の担当
- `packages/core/src/adapters/d1/**`（20、全削除） — 対象消滅。AC-17 の機械検証は1回目で実施済み
- `packages/core/src/adapters/webcrypto/**`（3） — 逆流依存の解消。ドメイン / アプリケーション観点の担当
- `packages/core/src/application/**`（42） — 合成ルート・ユースケース・ポート・RPC 復元表・実行基盤。アプリケーション / ドメイン観点の担当（`execution/unitOfWork.ts` は AC-28 の裏取りのために読んだが、レビュー本体は当該観点）
- `packages/core/src/domain/**`（20） — ドメイン観点の担当
- `packages/core/src/lib/**`（8） — 共有プリミティブ。アプリケーション / ドメイン観点の担当
