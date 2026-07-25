# レビュー 005 — 最終レビュー（収束確認）

**対象:** PR #17（`issue/1/skeleton-auth`、`d26d246`） / Issue #1
**ラウンド:** 5（収束確認 + ラウンド4指摘の解消検証 + 全レイヤーのゼロベース最終確認）
**参照:** `.issue/1/plan.md`（AC-1〜AC-18） / `.issue/1/adr.md`（ADR-001〜051） / `review-004-backend.md` / `review-004-frontend-security-test.md` / `triage.md`
**前提（再指摘しない）:** defer = rehash-on-login / レート制限 / CSRF Origin 検証（Issue #18）。wont-fix = Cookie の `__Host-` プレフィックス

---

## 検証の方法

推測と実測を区別するため、判定の根拠にした実測を先に置く。**「唯一の」「全ての」「never」「the one」の類は、すべて自分で grep / 実行して数え直した。**

| 実測 | 手順 | 結果 |
|---|---|---|
| 品質ゲート全7本 | `pnpm typecheck && pnpm typecheck:infra && pnpm lint && pnpm format:check && pnpm test:unit && pnpm test:integration && pnpm build` | **全通過**（後述） |
| `hmacSessionCodec` の外部参照 | `grep -rn 'hmacSessionCodec' packages/core/src apps/web/app infra` | 出荷コードで `MIN_SESSION_SECRET_LENGTH` を読むのは `di/secrets.ts` の**1本のみ**。`createHmacSessionCodec` の呼び出しは DI 4本 + テストハーネス2本 → **JSDoc の記述と一致** |
| `UsecaseContainer` の退行検出 | ①`ServiceArgs.container` を `RequestContainer` に戻す ②`UsecaseContainer` の `Omit` を外す。各々で `pnpm typecheck` | **両方とも** `requestContainerConfig.test.ts(100,5): error TS2578: Unused '@ts-expect-error' directive.` で落ちる（revert 済み） |
| `fromBase64Url` の空白挙動 | 実モジュールを vitest から直接呼ぶ | `"YWJj "`(5) → throw / `"YW Jj"`(5) → throw / **`"YWJj    "`(8) → 受理 `[61,62,63]`** / **`"YQ  "`(4) → 受理 `[61]`** / `"YQ== "`(5) → throw → **JSDoc の記述と完全一致** |
| `burnVerificationTime` のラッチ／ログ | ミューテーション3種 | ①ラッチのガード行を削除 → 1件失敗 ②ガードを `if (true) return;` に → 3件失敗 ③`cause` の射影を生値に戻す → **全 424 件中 2 件失敗**（ADR-051 の記述は「3件」→ N-001） |
| redaction 境界 | `redactForClient` から `system` 分岐を外す | 全 424 件中 **6 件失敗**（`errorResponse` / `errorResponseMiddleware` / `errorDisplay` に分散）。トートロジーではない |
| オープンリダイレクト防御 | `redirectPathSchema` から `!value.includes("//")` を外す | 全 424 件中 **9 件失敗**（`never resolves to another origin` ほか）。多層の表明が効いている |
| `RoutePendingFallback` の発火条件 | `pnpm dev` + agent-browser。`renderSettings` の handler に 1500ms を注入し、クリーンなページロードから `/` → `/settings` をクライアント遷移。`MutationObserver` で `[role=status]` の `tagName` を記録 | t=27ms シェル見出しが「設定」→ **t=253ms `DIV`（= `RoutePendingFallback`）** → t=1593ms `SECTION`（= `SettingsSkeleton`）→ t=1902ms 本体。**「never trigger」は偽** → W-002（注入は revert 済み） |
| `bg-accent` の使用箇所 | `grep -rn "accent" apps/web/app` | `Brand/index.tsx:11` と `AppShell/index.tsx:128` の **2箇所** → W-001 |
| `ExpectedVersion` の構築点 | `grep -n "as ExpectedVersion" packages/core/src/adapters -r` | d1 / libsql とも **各1箇所**（`toVersioned` 内）。JSDoc の「only construction site」は真 |
| ADR 参照の解決性 | `grep -rnoE 'ADR-[0-9]+' packages/core/src apps/web/app infra`（52件）を `.issue/1/adr.md` の見出しと突合 | 参照番号は**全件実在**。パス未修飾の行は `loginWithPassword.test.ts:95` の1件のみ（→ N-003） |
| `users` の制約 | 生成 SQL と `spec/database/index.md` を突合 | 名前付き CHECK **5本** + `users_email_uq` + 部分一意 `users_sso_identity_uq`。spec の要求と一致（plan の「6本」→ N-002） |
| チェックリスト 75 行 | TC 39 件を `grep` でテストソースに突合、非 TC 36 件を spec と実装で1件ずつ突合 | **75/75 実装済み・スタブなし**（後述） |
| TODO / 仮実装 | `TODO` / `FIXME` / `XXX` / `not implemented` を `packages/core/src` `apps/web/app` `infra` で grep | **0件** |
| todo サンプルの撤去 | `ls apps/web/app/{components,routes}/todo packages/core/src/{domain,application}/todo` | **全て不在**（完全撤去済み） |
| GCP `/prune` の認証 | `wiring/main.tf` / `server.gcp.ts` / `pruneEndpoint.ts` / `docs/runtime_gcp.md` を突き合わせ | app サービスに `allUsers` の `roles/run.invoker`、`/prune` の検証は POST のみ → **無認証で起動可能**。ただし4ファイルとも本 PR の差分外 → W-003 |
| D1 の OCC 競合帰属 | `pendingBatch.ts` / `unitOfWork.ts` を d1・libsql で読み比べ（+ 一時統合テストによる再現） | `firstConflictHandler()` が無条件に `conflictHandlers[0]` を返す → 2本目の競合を1本目に帰属。libsql は直近ハンドラで正しい。差分外・現状到達不能 → W-004 |
| 差分内 / 差分外の切り分け | `gh pr diff 17 --name-only` と `git log --diff-filter=A` | `wiring/main.tf` / `server.gcp.ts` / `pruneEndpoint.ts` / `pendingBatch.ts` / `containerStore.ts` / `cloudflare/pulumi/*` は**全て `1898fcc` 由来かつ PR 差分に不在** |
| `installContainerStore` の呼び出し元 | `grep -rn "installContainerStore" apps/web`（`dist` 除く） | **4本**（node / aws / cloudflare / gcp）。JSDoc の「both runtimes」は2本しか数えていない → N-011(a) |
| `claimed_by` の出所 | `grep -n "workerId" packages/core/src/application/workers/eventRelayWorker.ts` | `RELAY_WORKER_ID = crypto.randomUUID()`。`IdGenerator` 不経由 → N-011(b) |
| `appFn` の IAM 付与 | `grep -n "grant.*(appFn)" infra/aws/lib/appStack.ts` | `relayFn.grantInvoke` / `tursoSecret.grantRead` / `sessionSecret.grantRead` の3本のみ。SQS 権限なし → N-011(c) |
| `changeTrashRetentionDays` の no-op | `grep -n "trashRetention" .issue/1/adr.md` / `.issue/1/progress.md` | **ADR-024 に記録済み・progress.md:84 の spec-sync 台帳にも転記済み** → 新規指摘ではない（N-012） |
| 作業ツリー | `git status --porcelain` | 実験的変更は全て revert。残るのは `?? pnpm-lock.yaml` / `?? spec/inventory/`（本 PR 由来ではない。→ N-007 / N-008） |

---

## ラウンド4指摘の解消状況

**判定 `fix` の R4 指摘は全件解消。** 未解消はゼロ。

| R4 ID | 内容 | 結論 | 根拠（実測） |
|---|---|---|---|
| backend **W-001** | `hmacSessionCodec` の「唯一の外部参照」が偽 | **解消** | `:15-19` が主語をファイルから**定数**に落とし、さらに「**in shipped code**」で限定した。実測で `MIN_SESSION_SECRET_LENGTH` を読む出荷コードは `di/secrets.ts` の1本のみ（テストの `di/__tests__/secrets.test.ts` は限定句の外）。波及側 `:52-58` も「this file / 4本の DI ファクトリ（`server{Node,Cloudflare,Aws,Gcp}.ts` と明示）/ `secrets.ts` / テストハーネス」と**閉じる範囲を列挙形で書き切っており**、実測の6本を漏れなく覆っている。ADR-036 にも同趣旨が反映済み |
| backend **W-002** | `UsecaseContainer` の `@ts-expect-error` が空振り | **解消** | 表明対象を型エイリアスから `ServiceArgs<unknown>` の実利用点に移した。**R4 が名指しした退行（`ServiceArgs.container` → `RequestContainer`）で実際に型検査が落ちることを実測**。加えて `Omit` を外す退行でも同じ位置・同じコードで落ちることを確認したので、旧表明の範囲も失われていない。判断は ADR-050 に「`@ts-expect-error` は守りたい境界を**通る式**に当てる」という一般則として記録されている |
| backend **W-003** | `fromBase64Url` の「空白は拒否」が偽 | **解消** | JSDoc `:49-56` が「Acceptance is *narrower* than `atob`'s, **not wider — but only along one axis**」に書き換わり、受理される例（`"YWJj    "`, `"YQ  "`）を**具体値で**挙げている。実測4ケースが記述と完全一致。テスト側も `accepts %s` の2件を新設して**境界の両側**を固定した（従来は拒否側だけ） |
| backend **N-001** | ラッチと `logger.warn` が無テスト | **解消（提案を上回る）** | `loginWithPassword.test.ts`（新規164行・4件）を追加。`vi.resetModules()` + 動的 import でモジュールごと作り直す方式は ADR-051 に記録。**ミューテーション3種で実効性を確認**（上表）。特に「ダミーが読める場合は何も出ない」を足したことで「毎回 warn する実装」でも緑になる経路を塞いでおり、テスト自身がその理由をコメントに書いている |
| frontend **N-002** | `__root.tsx` の JSDoc と ADR-048 Decision が実態と食い違う | **解消** | `__root.tsx:77-83` が「the pre-auth screens, and **a failure of the root's own `beforeLoad` (`loadAppContext`)**」に訂正され、`Match.js` の挙動（そのマッチ自身の `errorComponent` が使われる）まで書き足された。ADR-048 Decision も同じ内容に訂正され、**Consequences との矛盾が解消**している |
| test **N-002** | `currentUser.test.ts` が置き換え済みの ADR-031 を参照 | **解消** | 参照が ADR-038 に、文言が「the guard is the one authority」→「**belt-and-braces alongside `noStoreMiddleware`**」に訂正。実装側 `currentUser.ts:40-43` の記述とも整合。R4 が指摘した改行の崩れも直っている |
| test **N-003** | `burnVerificationTime` の `logger.warn` が無テスト | **解消** | backend N-001 と同一の対応 |

R4 の Note で「据え置き」とされたもの（`users_sso_identity_uq` の部分索引の理由、`.env.aws.example` の断定形、`reconstruct` の日付検証、ADR 欠番 044/045、`DUMMY_PASSWORD_HASH` の生キャスト等）は本ラウンドでも実装に変化なし。いずれも triage 未登録の Note で、本 Issue の完了条件外である。

---

## Issue チェックリスト 75 行

**75/75 実装済み。スタブ・仮実装はゼロ。**

- **TC 39 件**（registerWithPassword 16 / loginWithPassword 11 / getCurrentUser 9 / logout 3）— 全 ID がテストソースに埋め込まれていることを ID 単位の grep で確認。ヒット0の ID は無い。
- **DOM 14 件** — `domain/identity/{valueObject,entity,events,ports/*}.ts` に実体があり、spec/domains/identity.md の制約表と一致。
- **ADP 10 件** — スキーマ4件は生成 SQL が spec の列・CHECK・インデックスと一致（d1 / libsql はバイト一致、スキーマ本体は d1 の再エクスポート1本）。リポジトリ / ハッシャー6件は d1・libsql・webcrypto に実装あり。
- **UC 4 件** — 4ユースケースとも spec の処理フロー・エラー契約どおり。
- **PAGE 8 件** — `/login`・`/signup` の両画面とフォーム送信、相互導線、`/password-reset` 導線、グローバルナビ5項目がすべて実ルート・実コンポーネント。

`/password-reset`・`/topics`・`/search`・`/trash` が「準備中です」表示なのは ADR-007 に記録された意図的なプレースホルダーで、チェックリストが要求するのは**導線の成立**であり、遷移先ページ本体（`PAGE-passwordReset-*` 等）はチェックリスト外である。

---

## 受け入れ基準 AC-1〜AC-18

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1 | **充足** | 8 VO + `Actor` がブランド型 + `create` 検証。長さは `codePointLength`（ADR-023）。違反は `BusinessRuleError<IdentityErrorCode>` |
| AC-2 | **充足** | `PasswordUser \| SsoUser` の判別可能ユニオン + 4ファクトリ（純関数、`now` / `id` は引数）。`changePassword` の `PasswordUser` 限定は `entity.test.ts` の `@ts-expect-error` が表明 |
| AC-3 | **充足** | `EventDraft`（`id` なし）を `collectEvents` 経由で同一 UoW に投入。`UnitOfWorkContext` は `userRepository` と `collectEvents` しか露出しない |
| AC-4 | **充足** | 4メソッド + `PasswordHasher` 2メソッド。`ExpectedVersion` の構築点が `toVersioned` 1箇所であることを実測 |
| AC-5 | **充足** | 名前付き CHECK 5本 + `users_email_uq` + 部分一意 `users_sso_identity_uq`。共通基盤3テーブル（`outbox_events` / `processed_events` / `_occ_guard`）あり。spec の要求と一致（plan の件数表記のみ → N-002） |
| AC-6 | **充足** | d1 / libsql 両実装。OCC 0行更新 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`、不整合行 → `SystemError(DataIntegrityError)`、`EMAIL_ALREADY_REGISTERED` はユースケース境界（ADR-008） |
| AC-7 | **充足** | `timingSafeEqual`（短絡なし）で照合し `boolean` を返す。保存値の反復回数は `/^\d+$/` + 整数 + 下限1 + `MAX_PBKDF2_ITERATIONS` で検査 |
| AC-8 | **充足** | 4ユースケースとも spec の処理フローと一致。ログイン失敗は5経路すべて `invalidCredentials()` 単一ファクトリ + ダミー verify による等時間化 |
| AC-9 | **充足** | 未認証で保護5ルート → `/login?redirect=<path>`。`redirectPathSchema` は protocol-relative / backslash / `%2f` / 制御文字 / `/_` 内部パス / 長さ上限を拒否。**ミューテーションで9件が落ちることを確認** |
| AC-10 | **充足** | `useActionState` + `FormMessage`（`role="alert"` + フォーカス移動）+ `Button pending`（`disabled` + `aria-busy` + 「ログイン中…」）。送信失敗時はメールを `defaultValue` で保持 |
| AC-11 | **充足** | `/signup` / `/password-reset` へのリンクが `TextLink`（`createLink` の型付き `to`）で存在し、遷移先も実在 |
| AC-12 | **充足** | 項目別エラー + 重複メール時のログイン導線 + フォーカス移動。`useActionState` が送信を直列化し `Button` が pending 中 `disabled` になるので連打で二重登録にならない |
| AC-13 | **充足** | `SignupForm/index.tsx:114` に `/login` 導線 |
| AC-14 | **充足** | `navItems.ts` の5項目を PC サイドバー / モバイル下部シートで共有。`aria-current` は1件、Esc とフォーカス復帰あり |
| AC-15 | **充足** | ログアウトで `Max-Age=0` の失効 Cookie。`noStoreMiddleware` がリクエスト境界で `no-store, private` + `vary: cookie` を付け、`requireUserId()` が belt-and-braces で重ねる |
| AC-16 | **充足** | TC 39 件がテストソースに1対1で存在（実測） |
| AC-17 | **充足** | 品質ゲート全7本を実測で通過。`pnpm dev` で起動しログイン〜ログアウトまでブラウザで実操作できることも確認 |
| AC-18 | **充足** | 生値 hex / `[Npx]` / `[Nrem]` / テンプレ既定パレットは残存ゼロ。数値ユーティリティは `w-0` / `inset-0` 等のゼロ値のみ |

---

## 品質ゲートの実行結果

| コマンド | 結果 |
|---|---|
| `pnpm typecheck` | **通過**（root + 3パッケージ Done） |
| `pnpm typecheck:infra` | **通過** |
| `pnpm lint` | **通過**（error 0。biome 設定移行を促す info のみ、本 PR 由来ではない） |
| `pnpm format:check` | **通過** |
| `pnpm test:unit` | **通過** — 26 files / **424 passed**（R4 の 418 から +6。ラッチ4件 + encoding 2件） |
| `pnpm test:integration` | **通過** — node 6 files / **39 passed**、cf 9 files / **104 passed** |
| `pnpm build` | **通過** |

---

## 最終レビュー

### Blockers

**なし。**

4ラウンドで挙がった Blocker / Warning は全件解消済みで、**本 PR の差分が持ち込んだ振る舞いのバグ・セキュリティの穴・仕様の抜けは1件も見つかっていない。**

なお本ラウンドで、**テンプレート由来かつ本 PR の差分外**の箇所に実在のセキュリティ問題（W-003）と実在の誤帰属バグ（W-004）を見つけた。いずれも実測で成立を確認しているが、**本 PR が持ち込んだものではなく、本 PR が触れてもいない**（`gh pr diff 17 --name-only` に `infra/gcp/example/wiring/main.tf` / `apps/web/app/server.gcp.ts` / `apps/web/app/worker/gcp/pruneEndpoint.ts` / `packages/core/src/adapters/d1/pendingBatch.ts` はいずれも現れない。全て `1898fcc` 由来）。**この PR のマージ判断とは切り離し、別 Issue として起票すべき事柄**と判断して Blocker には置かない。

### Warnings

#### 本 PR の差分に属するもの

- **[W-001]** `Brand` の JSDoc「accent 色が現れることを許された唯一の場所」が偽。**同じ4クラスのドットが `AppShell` にも直書きされている**
  - 場所: `apps/web/app/components/ui/Brand/index.tsx:2-3`（"the one place the accent colour is allowed to appear"）/ 重複は `apps/web/app/components/layout/AppShell/index.tsx:126-129`
  - 理由: 実測した。`grep -rn "accent" apps/web/app` のヒットは `Brand/index.tsx:11` と `AppShell/index.tsx:128` の **2箇所**で、後者は
    `className="size-(--size-dot) flex-none rounded-full bg-accent lg:hidden"` — `Brand` を経由せず `bg-accent` と `--size-dot` を直接書いた、**同一の見た目のドット**である（モバイルヘッダーの見出し横）。`--size-dot` の使用箇所も同じ2つ。
    実害は「唯一」を信じた次の実装者が、accent の扱いを変えるときに `Brand` だけを直して `AppShell` を取り残すこと。`tokens.css:16` の「Accent — ブランドの「点」。面には使わない」のほうは両方とも 6px の点なので**正しい**ので、矛盾しているのは `Brand` の JSDoc1文だけである。この「断定表現 vs 実態」は R1〜R4 のすべてで指摘が出ているカテゴリで、本 PR で新規に追加されたファイル（`197f7ff`）に残っている
  - 提案: (a) `AppShell:126-129` のドットを共有プリミティブ（`AccentDot` 等）に切り出して本当に1箇所にする、または (b) 文言を「the accent colour appears only as this dot — here and in the mobile header (`AppShell`)」に直す。(a) のほうが JSDoc をそのまま真にできる

- **[W-002]** 「streaming するルートは route-level pending を **never trigger** する」が `/settings` に当てはまらない。**実ブラウザで `RoutePendingFallback` が出ることを確認した**
  - 場所: `apps/web/app/components/ui/RoutePendingFallback/index.tsx:7-8`（"Routes that stream their own content via `<Suspense>` settle their loader instantly and never trigger this"）/ 同趣旨が `CLAUDE.md:62`（"a route that streams (like `/settings`) settles its loader immediately and never triggers it"）。**同じ主張は `apps/web/app/components/ui/Deferred/index.tsx:8-10`（"the route loader forwards the … promise WITHOUT awaiting it, so navigation settles immediately"）にもあるが、こちらはテンプレート由来で本 PR は1バイトも触っていない**（直すなら3箇所まとめて）
  - 理由: 実測した。前提は `apps/web/app/routes/_app/settings.tsx:24-27` の loader が `await renderSettings()` — **`createServerFn({ method: "GET" })` そのものを await する**点にある。SSR では同一プロセス実行なので即時 settle するが、**クライアント遷移では `/_serverFn/...` への RPC が1往復入る**ため即時ではない。`router.tsx:18-20` の閾値は `defaultPendingMs: 200` / `defaultPendingMinMs: 300` と低い。
    `renderSettings` の handler に 1500ms を注入し、クリーンなページロードから `/` → `/settings` をクライアント遷移して `MutationObserver` で `[role=status]` の `tagName` を記録した結果（注入は revert 済み）:

    | t | `[role=status]` | 意味 |
    |---|---|---|
    | 27ms | なし（見出しは「設定」） | ルートは即コミット |
    | **253ms** | **`DIV`** | **`RoutePendingFallback`**（`<div role="status">`） |
    | 1593ms | `SECTION` | `SettingsSkeleton`（`<section role="status">`） |
    | 1902ms | なし | 本体 |

    つまり遅延下では **RoutePendingFallback → SettingsSkeleton → 本体の三段**になり、CLAUDE.md 自身が求める「Keep the two roles distinct」が崩れる。注入なしの高速なローカル環境では loader が ~58ms で settle して `SECTION` しか出ないので設計意図どおりに動く。**「never」が成り立つのは往復が 200ms 未満のときだけ**であり、実ネットワーク・コールドスタート下では容易に超える。
    この文は元テンプレート由来だが、本 PR が `/todo` → `/settings` に**書き換えて再主張している**ので本 PR のスコープに入る。`/settings` はこの規約の唯一の参照実装なので、誤解のコストが高い
  - 提案: 文言を実態に合わせる（「SSR では loader が即時 settle するので発火しない。クライアント遷移では server function の往復が `defaultPendingMs` を超えると発火しうる」）。三段重ねを避けたいなら `/settings` に `pendingComponent: () => null` を明示して per-fragment skeleton に一本化するのが確実で、そのほうが CLAUDE.md の「二つの役割を混ぜない」とも整合する

#### 本 PR の差分外（テンプレート由来。**マージ条件ではないが別 Issue を起票したい**）

- **[W-003]** GCP ランタイムの `/prune` が**実質無認証の公開エンドポイント**で、コメントと docs はそれを「Cloud Run IAM が守っている」と断定している
  - 場所: `infra/gcp/example/wiring/main.tf:66-72`（app サービスに `member = "allUsers"` の `roles/run.invoker`）/ `apps/web/app/server.gcp.ts:114-116`（"auth is enforced by Cloud Run IAM (scheduler SA holds `roles/run.invoker`)"）/ `apps/web/app/worker/gcp/pruneEndpoint.ts:3-5`（検証は `request.method !== "POST"` のみ）/ `docs/runtime_gcp.md:93`（同じ断定）
  - 理由: 4ファイルを直読して突き合わせた。`/prune` は `app` サービス上に同居しており（`server.gcp.ts:114-118` が TanStack entry より先に短絡する）、その `app` サービスには `allUsers` の invoker が付いている。**つまり Cloud Run IAM は誰も弾かない。** Scheduler は OIDC トークンを付けて呼ぶが（`wiring/main.tf:150-154`）、受け側はトークンを一切見ない。結果、`curl -X POST https://<app-url>/prune` を誰でも実行でき、`runPruneTick()` → `pruneProcessed` の DELETE を無制限に起動できる。
    影響は「処理済み outbox 行の早期削除」と「DB への無制限なメンテナンスクエリ」で、ユーザーデータの破壊や認証バイパスではない。ただし `docs/runtime_gcp.md:88` が同じ表の中で `app` を "Public HTTPS" と書いており、**同一ファイル内で自己矛盾している**のが問題の見つかりにくさを作っている
  - **本 PR との関係**: 実装3ファイルはいずれも `1898fcc`（テンプレート初期コミット）由来で、**本 PR は1バイトも触っていない**。`docs/runtime_gcp.md` は差分に含まれるが、`git diff 1898fcc..HEAD -- docs/runtime_gcp.md` に該当行の変更は無い。加えて GCP は CLAUDE.md「Reference runtimes」が挙げる3つ（Node / CF / AWS）にも入っておらず、`infra/gcp` は `example/` 配下の参照 Terraform（ホスト名は `example.com` のプレースホルダ）である。plan.md の「含まれないもの」もランタイム関連の整理を明示的にスコープ外にしている（ADR-004）
  - 提案: (a) `/prune` で OIDC `Authorization: Bearer` を自前検証する、または (b) 独立した pruner サービスに分離して `allUsers` を外す。どちらを採るにせよ、**最低限コメントと docs の断定を先に消す**（現状は「守られている」と読めるため、危険側に誤解させる）

- **[W-004]** D1 の `PendingBatch.firstConflictHandler()` が OCC 競合を**誤った集約に帰属**させる。JSDoc が挙げる論拠自体が成り立っていない
  - 場所: `packages/core/src/adapters/d1/pendingBatch.ts:43-47` / `:89-97`（"D1 stops at the first failure. The guard at index `i` is the one that fired, so ... the head handler is the right one"）/ 使用側は `packages/core/src/adapters/d1/unitOfWork.ts:108-116`
  - 理由: `firstConflictHandler()` は無条件に `conflictHandlers[0]` を返す。JSDoc の「D1 は最初の失敗で止まる」は正しいが、そこから「先頭ハンドラが正しい」は導けない — **止まるのは最初に*失敗した*文であって、最初の文ではない**。1本目の OCC write が成功し2本目が競合した場合、発火するガードは index 1 なのに、投げられるのは index 0（別集約）のハンドラである。
    バックグラウンドで走らせた検証エージェントが一時的な統合テストで「1本目=成功 / 2本目=stale version」を組み、`firstConflictHandler()` が1本目のハンドラを返すことを**実測で再現**している（テストは削除済み・作業ツリーはクリーン）。私自身も両アダプターを読み比べて論理を確認した。
    **libSQL 側は正しい**（`libsql/pendingBatch.ts:46` が「`onConflict` fires iff *this* write matched zero rows」、`libsql/unitOfWork.ts:83-96` が直近の `occ` 文を追跡）。つまり2つのアダプターで OCC 競合の帰属挙動が食い違っている
  - **本 PR との関係**: `pendingBatch.ts` は `1898fcc` 由来で PR の差分外。かつ**本 PR には 1 UoW に OCC write を2本出すユースケースが存在しない**（`userRepository.save` を呼ぶユースケースが未配線）ため現状到達不能。R3 N-005 / R4 N-005(d) が同じ箇所を Note として挙げており、本ラウンドで初めて実測の裏が取れた形
  - 提案: D1 側も libSQL と同じ「直近の OCC ハンドラ」方式に揃える。それまでは JSDoc の誤った論拠を消し、「1 UoW に複数の OCC write を置くと帰属が壊れる（未サポート）」と明記して次スライスの踏み抜きを防ぐ

### Notes

- **[N-001]** ADR-051 の Consequences「`cause` の射影を生のまま渡す形に戻すと**3件**が落ちる」が実測と合わない。`{ cause: cause instanceof Error ? cause.name : typeof cause }` を `{ cause }` に戻して全ユニットスイートを回すと、落ちるのは `reports an unreadable dummy hash, naming the failure's type only` と `names the type when the hasher rejects with a non-Error` の **2件**（424件中 422 passed）。ラッチ側の「2行を削ると (3) が落ちる」は正しい。ADR に実測値を書く運用自体は良いので、数字だけ 2 に直せばよい。

- **[N-002]** `plan.md` の AC-5「`users` テーブルが**名前付き制約6本** + インデックス2本」が実装と1本ずれる。生成 SQL の名前付き CHECK は `users_auth_method_sum` / `users_auth_method_valid` / `users_sso_provider_valid` / `users_sso_subject_nonempty` / `users_trash_retention_positive` の **5本**で、括弧内の列挙もこの5本 + インデックス2本の計7項目である（6+2=8 にならない）。`spec/database/index.md` が要求するのもこの5本なので**実装は正しく、直すのは plan.md の数字だけ**。

- **[N-003]** ADR 参照のパス修飾に1件の取りこぼし。`packages/core/src/application/identity/__tests__/loginWithPassword.test.ts:95` の `ADR-047` が無修飾（直前の94行目には `.issue/1/adr.md ADR-034` がある）。ADR-046 の例外規定は「**1行に**複数の兄弟参照がある場合は先頭だけ」なので、行をまたいだこのケースは規定の外にある。`spec/adr/` は 001〜006 しか無いため誤解決は起きず実害は無いが、ADR-046 の Consequences「全ヒットが直前のパスによって一意に解決する」が偽になる。あわせて ADR-046 の Context にある「44箇所」は現在 **52箇所**（本 PR の後続修正で増えた）。

- **[N-004]** `apps/web/app/presentation/authState.ts:16-17` が `no-store` の適用先を「`/`, `/topics`, `/search` and `/trash`」と4つ挙げるが、保護ルートは `/settings` を含めて5つある。`/settings` は `renderSettings` 側にも `noStoreMiddleware` が付いているため意図的な除外とも読めるが、文が「it is what puts …」と列挙形なので4つで尽きていると読める。1語足すか「every route under `_app`」に言い換えると曖昧さが消える。なお `noStoreMiddleware.ts` 自身の JSDoc（「Setting the header *before* `next()` runs is what covers every path, streaming included」）は R4 の curl 実測とも一致していて正確。

- **[N-005]** `apps/web/app/components/layout/AppShell/index.tsx:136` の `aria-controls="global-nav-sheet"` が、シートを閉じている間（`:185-213` が未レンダー）存在しない id を指す。多くの支援技術は無視するが、厳密には dangling reference。閉じている間も要素を残して `hidden` で畳むか、`aria-controls` を開いている間だけ付けると解消する。

- **[N-006]** `apps/web/app/presentation/pagination.ts` が todo サンプル撤去後に**参照ゼロ**になっている（`paginationSchema` / `paginationSearchSchema` を import する箇所が無い）。`redirectSearch.ts:14` が「Same two-schema split as `pagination.ts`」と**パターンの手本として**言及しているだけなので、残すなら「後続スライスの一覧画面のために置いてある」と1行書くか、削除して参照側の文言を書き換えるかを決めておきたい。テンプレート由来で本 PR の変更行ではない。

- **[N-007]** `pnpm-lock.yaml` が **untracked かつ gitignore 対象でもない**（`git ls-files` にヒットしない）。CLAUDE.md は「One lockfile at the root」と書くが、リポジトリにロックファイルがコミットされていないため CI / デプロイの再現性が担保されない。初回コミット由来で本 PR の変更ではないが、別 Issue として拾っておきたい。

- **[N-008]** Issue #1 のチェックリストは「`spec/inventory/` 由来・75行」と書くが、`spec/inventory/` は untracked でリポジトリに入っていない。チェックリストの出所を後から検証できない状態なので、コミットするか出所の記述を改めるかを決めたい。本 PR の変更ではない。

- **[N-010]** `packages/core/src/domain/identity/__tests__/entity.test.ts:81` の `expect(containsString(eventDrafts, PLAINTEXT)).toBe(false)` は**構造的に必ず通る空振り**。`User.registerWithPassword` は `{ id, email, passwordHash }` しか受け取らないので、`PLAINTEXT` がドラフトに入る経路がそもそも無い。同じ行の `HASH` 側（`:82`）と `Object.keys(...).toEqual([...])`（`:77-80`）は実効があるので、テストとしては壊れていない。防御的な意図なら「平文は引数として渡せないので、この表明は将来ファクトリのシグネチャが変わったときの網」と1行添えると空振りに見えなくなる。

- **[N-011]** 本 PR の差分外にある、実測で偽と確認した記述（いずれもテンプレート由来で、本 PR は該当行を触っていない。W-003 / W-004 と同じ扱い）。
  (a) `packages/core/src/application/di/containerStore.ts:31-32` が store のインストール元を「`app/server.cloudflare.ts` / `app/server.node.ts`」の2本とし「shared by **both** runtimes」と書くが、`grep -rn "installContainerStore" apps/web`（`dist` 除く）は **4本**（`server.{node,aws,cloudflare,gcp}.ts`）。`:44` / `:51` のエラーメッセージも2本しか案内しないので、AWS / GCP で配線を間違えた人が案内先に自分の entry を見つけられない。
  (b) `packages/core/src/adapters/d1/schema.ts:91` が `claimed_by` を「free-form worker id (**from `IdGenerator`**)」と書くが、実際の値は `eventRelayWorker.ts:97` の `RELAY_WORKER_ID = crypto.randomUUID()`（または呼び出し側の `options.workerId`）で、**`IdGenerator` ポートは一度も経由しない**。同じファイルの `:94-96` が「UUIDv4 で十分」と正しく書いているので、schema 側の1語だけがずれている。
  (c) `infra/aws/lib/appStack.ts:268` の「Request path → relay (async invoke) + **SQS read for DLQ requeue** + Turso auth token」のうち SQS 部分が偽。`appFn` への付与は `relayFn.grantInvoke` / `tursoSecret.grantRead` / `sessionSecret.grantRead` の3本だけで SQS 権限は無く、"DLQ requeue" という機能自体がリポジトリに存在しない（`git grep "requeue"` のヒットはこのコメント1件のみ）。
  (d) `infra/cloudflare/pulumi/resources/index.ts:11-14` が Cloudflare Zone を Pulumi 管理下で**新規作成**しており `protect` が無い一方、すぐ下の D1（`:16-24`）には `{ protect: true }` がある。加えて `Pulumi.staging.yaml` と `Pulumi.production.yaml` が同一の `zoneName: example.com` を指すので、staging の `destroy` が本番ゾーンを巻き込む形になっている。`example.com` はプレースホルダなので即時の実害は無いが、保護の非対称は事故を誘発する。

- **[N-012]** `User.changeTrashRetentionDays` の同値 no-op（`entity.ts:129-131`）が spec（`spec/domains/identity.md:103` の「変更系は `version + 1`」「対応するイベントドラフトと共に返す」）と字面で異なる点は、**すでに ADR-024 に判断として記録され、`.issue/1/progress.md:84` の spec-sync 台帳にも転記済み**であることを確認した（`grep -n "trashRetention" .issue/1/adr.md` → ADR-024 が該当）。新規の指摘ではなく、台帳が機能していることの確認として記録する。なお `spec/testcases/identity/changeTrashRetentionDays.md:13` が要求しているのは「正常終了する」までで no-op ではないので、実装コメントの「the spec's test cases require it to succeed」という書き方（＝成功のみを spec の要求とし、no-op は自分の判断だと読める）は正確。

- **[N-009]** 良かった点（実測で裏が取れたもの）。
  - (a) **redaction 境界とオープンリダイレクト防御は、いずれもミューテーションで実際に落ちる**（それぞれ6件 / 9件）。R1〜R3 で繰り返し指摘された「写経・トートロジー」の形は残っていない。特に `errorResponse.test.ts` の `SAMPLES` を実クラスから組み立てて `satisfies Record<SerializedErrorKind, SerializedError>` で受ける設計は、union にメンバーが増えたらコンパイルエラーになる**型による網羅性の門番**になっている。
  - (b) `@ts-expect-error` を表明の本体にした3箇所が、いずれも**実際に守りたい退行で落ちる**ことを確認した。ADR-050 の一般則「表明は守りたい境界を*通る式*に当てる」は、次のスライスでもそのまま使える形に言語化されている。
  - (c) `ExpectedVersion` の `as` キャストが d1 / libsql とも `toVersioned` の1箇所に閉じており、JSDoc の「only construction site」が実測で真。R3 W-001 の修正で主語をファイルから helper に落としたことが効いている。
  - (d) `PlainPassword` の JSDoc が「この規則は型ではなく**テストとレビューで守られている**」と、保証できないことを保証できないと書いている。断定を避けた記述の見本。
  - (e) `pbkdf2PasswordHasher.ts` の `parse()` が反復回数を `/^\d+$/` + 整数 + 下限1 + 上限で検査してから `derive` に渡しており、保存値由来の値で無制限に計算させられる経路が塞がれている。

---

## 総評

**Blocker 0 / Warning 4（本 PR の差分内 2・差分外 2）/ Note 12。マージ可（APPROVED）。**

ラウンド4で残っていた Warning 3件・Note 3件は**全件解消**しており、そのうち「実際に退行を検出できるか」が争点だった2件（`UsecaseContainer` の型ピン、`burnVerificationTime` のラッチ）は、本ラウンドで**退行を注入して落ちることを実測**して閉じた。加えて redaction 境界とオープンリダイレクト防御もミューテーションで実効性を確認しており、テストが契約を検証しているという判断には十分な裏付けがある。品質ゲート7本すべてが通過し、Issue のチェックリスト75行はスタブなしで実装済み、AC-1〜AC-18 も全て充足している。

**本 PR の差分に属する Warning 2件は、どちらも「コードは正しいが説明が実態と違う」**もので、振る舞いには影響しない。W-002 だけは、遅延下でローディング表示が三段になるという観測可能な帰結を持つが、これは仕様どおりの UI が2つ重なるだけで欠陥ではなく、`/settings` に `pendingComponent: () => null` を1行足せば消える。どちらもマージ後の追随で足りる。

差分外の W-003（GCP `/prune` の無認証公開）と W-004（D1 の OCC 競合誤帰属）は**実在する問題**で、前者はセキュリティ、後者は次スライスで顕在化するバグである。ただし**どちらもテンプレート初期コミット由来で本 PR は該当ファイルに一切触れておらず**、本 PR のレビューで発見されたからといってこの PR のマージを止める理由にはならない。**別 Issue として起票し、W-003 は GCP をターゲットにする前に、W-004 は 1 UoW に OCC write を2本出すユースケースを書く前に、それぞれ閉じること。**

5ラウンドを通じて一貫して最も多く指摘が出たのは「JSDoc の断定表現が実測と食い違う」という一点であり、本ラウンドでも W-001 / W-002 と記述系の Note 5件（N-001 / N-002 / N-003 / N-004 / N-011）が同じ形で出ている。**実装の質と比べて、説明文の検証だけが構造的に弱い。** 次のスライスに向けては、「the one」「only」「never」「both」「全て」を書いたら**その場で grep して件数を本文に残す**（本 PR の ADR-050 / ADR-051 が既にやっている形）を運用として固定すると、このクラスは自然に減る。W-003 はまさにこの弱さが**セキュリティの誤解に直結した**例で、「IAM が守っている」という一文が守られていない実態を10ヶ月隠せることを示している。

**最終判定: APPROVED。** W-001 / W-002 はマージの条件にしない（同一コミットで直せるなら直し、そうでなければ次スライスまたは spec-sync へ）。W-003 / W-004 は本 PR とは独立に Issue 起票を推奨する。
