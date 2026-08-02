# 実装計画 — Issue #36: [実装] Node / AWS / GCP ランタイムを撤去する

**Issue:** #36
**作成日:** 2026-07-29
**複雑度:** 中〜大規模

---

## 目的

テンプレート由来の4ランタイム構成（Node / Cloudflare / AWS / GCP）から Node / AWS / GCP を撤去し、Cloudflare Workers 単独構成に収斂させる。D1 は唯一動作している永続化経路なので残し、代替実装を必要としない純粋な撤去だけを行う。

## 受け入れ基準

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `apps/web/app/` / `packages/core/src/` / `infra/` に Node / AWS / GCP 固有のコード（エントリ・worker・DI・アダプター・CDK・Terraform）が1ファイルも残らない | Issue 受け入れ条件 | 2, 3, 4, 5, 6, 7, 16 |
| AC-2 | `pnpm-workspace.yaml` の `packages` から `infra/aws` が外れ、`pnpm install` と `pnpm install --frozen-lockfile` が成功する | Issue 受け入れ条件 | 6, 9, 16 |
| AC-3 | `pnpm dev` / `pnpm build` / `pnpm start` の**スクリプト定義**が Cloudflare 構成（`vite.config.cloudflare.ts` / `wrangler`）を指している（`package.json` の記述で確認）。うち `pnpm dev` / `pnpm build` は実際に起動・完了する。**`pnpm start`（= `start:cf` = `wrangler dev`）の実行成功は基準に含めない** — 本 Issue 以前から起動不能であることを実測済み（引き継ぎ項目 H-8 / リスク節） | Issue 受け入れ条件 | 8, 16 |
| AC-4 | ルートと `apps/web` の package.json に、削除済みファイル・削除済みワークスペースを参照するスクリプトが1件も残らない（削除: `dev:node` / `dev:gcp` / `build:{node,aws,gcp}` / `start:{node,gcp}` / `db:migrate:{node,aws,gcp}` / `db:generate:node` / `test:integration:node` / `deploy:aws:*`。**更新: ルート `test:integration` を `"pnpm test:integration:cf"` に**——現状は `pnpm test:integration:node && pnpm test:integration:cf` で削除済みスクリプトを参照している） | Issue 対応項目5・6 | 8, 16 |
| AC-5 | 削除する統合テストのうち Cloudflare 側でカバーされないケース（H-1〜H-6）が #37 へのコメントとして記録されている。あわせて **H-7**（libSQL `PendingBatch` の参照実装の喪失）は #26 へ、**H-8**（`pnpm start` 起動不能）は #37 へ記録されている。**あわせて #35 に「`CLAUDE.md` の Reference runtimes 節が Cloudflare 単独に縮み、libSQL / Turso アダプターが実体ごと消えた」旨のコメントが付いている**（`spec/database/index.md:3` が同節を名指し参照しているため。★3周目で追加・派生） | Issue 受け入れ条件（H-7 / H-8 / #35 宛ては派生） | 1, 15 |
| AC-6 | `docs/` と `.github/workflows/ci.yml` に撤去済みランタイムへの参照・削除済みファイルへのリンクが残らない（`docs/runtime_{node,aws,gcp}.md` は削除、`docs/runtime_cloudflare.md` / `docs/test.md` / `docs/backend_implementation_example.md` の dead reference は解消）。**CI 側は 16-12 の専用 grep で機械的に検証する**（16-9 の全文検索は ci.yml の matrix 定義を構造上拾えないため） | Issue 対応項目7・受け入れ条件 | 12, 14, 16 |
| AC-7 | `pnpm typecheck` / `pnpm lint` / `pnpm format:check` / `pnpm test:unit` / `pnpm test:integration:cf` / `pnpm build:cf` がすべて成功する | Issue 受け入れ条件 | 16 |
| AC-8 | `CLAUDE.md` の Workspace layout / Reference runtimes 節と `README.md` に、削除済みファイル・削除済みランタイムへの参照が残らない | Issue 対応項目7（+ README は削除済みファイルへの dead link を生むため派生） | 12, 13, 16 |
| AC-9 | 撤去したランタイム専用の依存（`@aws-sdk/*` 3件 / `@google-cloud/*` 2件 / `@libsql/client` / `google-auth-library` / `@hono/node-server` / `@types/aws-lambda`）が `package.json` 3件（ルート / `apps/web` / `packages/core`）に残らず、かつ `pnpm-lock.yaml` の **`importers:` セクション**に残らない（lockfile 全体でのヒット0件は原理的に不可能。下の注記を参照） | AC-1「固有のコードが残っていない」の派生（`pnpm install` が通ることの前提） | 9, 16 |
| AC-10 | `.gitignore` / `.dockerignore` / `apps/web/.env*.example` に、撤去したランタイム専用のエントリが残らない | AC-1 の派生（Dockerfile.gcp / Node 前提 env の撤去に連動） | 7, 11, 16 |
| AC-11 | #26 に「GCP `/prune` 無認証の分は本 Issue の撤去で解消、D1 の OCC 競合誤帰属だけを残す」旨のコメントが付いている。**あわせて H-7（正しい参照実装だった libSQL の `PendingBatch.addOcc` が本 Issue で消えること）も同コメントに含まれている** | Issue 対応項目8（H-7 は派生） | 15 |
| AC-12 | Issue 対応項目4 の**10ファイル**（`apps/web/vite.config.{node,aws,gcp}.ts` 3件 / `apps/web/scripts/{listen.node.ts,listen.gcp.mjs,migrate.node.ts,migrate.aws.ts,migrate.gcp.ts}` 5件 / `apps/web/drizzle.libsql.config.ts` 1件 / `apps/web/Dockerfile.gcp` 1件）と対応項目6 のルート設定 `vitest.config.integration.node.ts` が削除されている。**Issue 本文の対応項目4 は `scripts/migrate.node.ts` を落としていて9件表記だが、実体は10件**（本計画が補完している）。実装後に Issue 本文と突き合わせて数が合わなくても、10件が正 | Issue 対応項目4・6（**AC-1 の文言は `apps/web/app/` / `packages/core/src/` / `infra/` に限定されていて、`apps/web/` 直下とリポジトリルートのこれらを含まない**） | 7, 10, 16 |

**AC-9 の注記（`aws-cdk*` を対象外にする理由）:** `aws-cdk-lib` / `aws-cdk` は `packages/core/package.json` にも `apps/web/package.json` にも存在せず、`infra/aws/package.json:15,20` にしかない（実測）。ディレクトリごと削除されるため **AC-9 の対象からは外し、AC-1（`infra/aws/` の削除）でカバーされる**とする。AC-9 に `aws-cdk*` を含めると検証不能な基準になる。

**AC-9 の注記（`pnpm-lock.yaml` を「ヒット0件」にできない理由 — 実測）:** `drizzle-orm` は D1 用に残すが、lockfile の `packages:` セクションにある `drizzle-orm@0.45.2` ブロックが `peerDependencies` / `peerDependenciesMeta` で `'@aws-sdk/client-rds-data'` / `'@libsql/client'` / `'@libsql/client-wasm'` を**恒久的に宣言している**（実測: `pnpm-lock.yaml:2662,2665,2666` ほか）。依存を全部外してもこの記述は消えない。実際に HEAD のコピーで9依存と `infra/aws` を落として `pnpm install --lockfile-only` を実行して確認した結果:

| 対象 | 撤去前 | 撤去後（実測） |
|---|---|---|
| `pnpm-lock.yaml` 全体のヒット行数 | 192 | **6**（すべて `drizzle-orm@0.45.2` の `peerDependencies` / `peerDependenciesMeta` の行） |
| `pnpm-lock.yaml` の `importers:` セクションのヒット行数 | 20 | **0** |
| `package.json` 3件のヒット行数 | ルート 0 / `apps/web` 9 / `packages/core` 7 | **0 / 0 / 0** |

したがって AC-9 の機械的検証は「**`package.json` 3件が0件** かつ **`importers:` セクションが0件**」とする（コマンドはステップ16-10）。`importers:` に現れていた `drizzle-orm` の peer 解決サフィックス `(@libsql/client@0.17.4)` も撤去後は消えることを実測で確認済み。

**AC-9 の注記（ルート `esbuild` は AC の対象外）:** ルート `package.json` の `esbuild` devDependency の削除（ADR-004 / ステップ9）は **Issue の対応項目にも受け入れ条件にも無い派生作業**である。判断根拠と検証手順はステップ9 のとおりだが、**検証で落ちたら戻す＝残したままでも Issue の受け入れ条件は満たす**。lockfile のコンフリクト面が広いというリスクがあるので、削除に固執して往復を増やさないこと。

## スコープ

### 含まれないもの

- **D1 の撤去・DO 移行一式** — `packages/core/src/adapters/d1/`、`apps/web/app/worker/cloudflare/`、`packages/core/src/application/di/serverCloudflare.ts` の D1 前提部分、`apps/web/drizzle.config.ts`、`wrangler*.toml` の D1 binding。#37 の担当。
- **D1 系 package.json スクリプト** — `db:generate:cf` / `db:migrate:cf` / `db:apply:*` / `db:execute:*`、および relay / consumer / pruner / dlq の `deploy:*`。#37 の担当。本 Issue では「バレのエイリアス（`db:generate` / `db:migrate`）が削除済みの Node スクリプトを指し続けない」ことだけを保証する。
- **Worker 名（`tanstack-start-template-*`）の fog へのリネーム** — #37 の担当。
- **`spec/` 本体の改訂** — `spec/database/index.md` / `spec/inventory/adapter.md` に残る libSQL / Turso 前提の記述は #35 の担当。本 Issue では触らない。ただし `spec/database/index.md:3` が本 Issue で縮む `CLAUDE.md`「Reference runtimes」節を名指し参照しているため、**#35 へのコメントで起点だけ渡す**（ステップ15。★3周目で追加）。
- **`docs/runtime_cloudflare.md` の DO 化** — #38 の担当。本 Issue では「削除したファイルを指すリンク・記述」の解消のみ行い、D1 前提の記述自体は残す。
- **`CLAUDE.md` の DO 構成への全面書き換え** — #35 の担当。本 Issue では撤去したファイルへの参照が残らないことだけを保証する。
- **`.thread/1/` 配下の過去作業ログ** — 当時の記録なので改変しない。ADR-004 の supersede は #34 の担当。
- **`ServiceBindingRelayTrigger` へのテスト追加** — 撤去に伴い RelayTrigger 実装のテストがゼロになるが、#37 で RelayTrigger 自体が DO Alarm に置き換わる見込みなので新規実装はしない（引き継ぎ項目 H-2 として記録する）。
- **`EventDispatcher` の Cloudflare 実装をアダプター層へ切り出すこと** — 撤去後、`packages/core/src/adapters/` 配下の `EventDispatcher` 実装がゼロになり、唯一の実装が `apps/web/app/worker/cloudflare/handlers.ts` にインラインで残る（実測）。この構造上の非対称は #37 の DO 移行でキュー境界ごと再設計されるので本 Issue では直さない（引き継ぎ項目 H-6 として記録する）。
- **d1 側の UoW 経路に `_occ_guard` 空判定テストを足すこと** — libsql 撤去で唯一の担保が消えるが、#37 で `_occ_guard` CHECK トリック自体が消える見込みなので新規実装はしない（引き継ぎ項目 H-5(b) として記録する）。
- **`wrangler.toml` / `wrangler.*.toml.tpl` の `main` の修正** — `main` が TS ソースを指しているため `wrangler dev` / `wrangler deploy --dry-run` がビルドできない（実測）。**本 Issue 以前から存在する欠陥**であり撤去では直せない。`.tpl` に手を入れると #37 との衝突面が広がるので触らない。引き継ぎ項目 **H-8** として記録し、Phase 5 で別 Issue として起票する候補にする。

## 調査結果

### 関連ファイル

**エントリポイント / worker（削除）**

| パス | 役割 |
|---|---|
| `apps/web/app/server.node.ts` / `server.aws.ts` / `server.gcp.ts` | 各ランタイムの fetch エントリ |
| `apps/web/app/worker/node/runner.ts` + `__tests__/runner.node.integration.test.ts` | 単一プロセスで4ロールを回すオーケストレーター |
| `apps/web/app/worker/aws/{relay,consumer,pruner,dlq,handlers}.ts` | Lambda ロール別ハンドラ |
| `apps/web/app/worker/gcp/{relay,consumer,dlq,pruneEndpoint,handlers}.ts` | Cloud Run ロール別ハンドラ |

**DI（削除）**: `packages/core/src/application/di/{serverNode,serverAws,serverGcp}.ts`

**アダプター（削除）**

| パス | 内容 |
|---|---|
| `packages/core/src/adapters/libsql/` | client / schema（d1 の再エクスポート1行）/ migrations / pendingBatch / unitOfWork / repositories 4件 / `__tests__` 6件 |
| `packages/core/src/adapters/node/` | `inMemoryQueueDispatcher` / `inProcessRelayTrigger` / `__tests__` 2件 |
| `packages/core/src/adapters/aws/` | `lambdaInvokeRelayTrigger` / `secretsLoader` / `sqsQueueDispatcher` |
| `packages/core/src/adapters/gcp/` | `cloudRunRelayTrigger` / `pubsubQueueDispatcher` / `secretsLoader` |

**残す側（ファイルとしては残るが JSDoc に手が入るものを含む）**: `adapters/d1/`（20ファイル、libsql への依存ゼロ・無変更）、`adapters/cloudflare/serviceBindingRelayTrigger.ts`（無変更）、`adapters/webcrypto/`（**JSDoc は要編集**）、`application/di/serverCloudflare.ts`（**JSDoc は要編集** — 下表参照）、`apps/web/app/{server.cloudflare.ts,worker/cloudflare/}`（無変更）

**設定 / スクリプト（削除）**: `apps/web/vite.config.{node,aws,gcp}.ts`、`apps/web/scripts/{listen.node.ts,listen.gcp.mjs,migrate.node.ts,migrate.aws.ts,migrate.gcp.ts}`、`apps/web/drizzle.libsql.config.ts`、`apps/web/Dockerfile.gcp`、`.dockerignore`、`apps/web/.env.example` / `.env.aws.example` / `.env.gcp.example`、`vitest.config.integration.node.ts`、`infra/aws/`、`infra/gcp/`

**参照が残る（要編集）**

同一ファイル内で先に行を削除すると後続の行番号がすべてずれるため、位置は **節名＋現行の引用文字列**で指定する（行番号は 2026-07-29 時点の目安に留める）。

| ファイル | 参照箇所（引用文字列で特定） |
|---|---|
| `package.json`（ルート） | `dev:node` / `dev:gcp` / `build:{node,aws,gcp}` / `start:{node,gcp}` / `db:migrate:{node,aws,gcp}` / `db:generate:node` / `test:integration`（実体は `pnpm test:integration:node && pnpm test:integration:cf`）/ `test:integration:node` / `deploy:aws:{staging,production,synth,diff}` 4件 |
| `apps/web/package.json` | `dev:node` / `dev:gcp` / `build:{node,aws,gcp}` / `start:{node,gcp}` / `db:migrate:{node,aws,gcp}` / `db:generate:node` ＋ `dev` / `build` / `start` / `db:migrate` / `db:generate` の既定（すべて `:node` を指す）、および runtime 専用 deps 9件（`@aws-sdk/*` 3 / `@google-cloud/*` 2 / `@hono/node-server` / `@libsql/client` / `google-auth-library` / `@types/aws-lambda`）＋ 要確認の `dotenv` / `tsx` |
| `packages/core/package.json` | `@aws-sdk/*` 3件 / `@google-cloud/*` 2件 / `@libsql/client` / `google-auth-library` |
| `pnpm-workspace.yaml` | `packages` の `- "infra/aws"` **のみ**。`overrides` / `publicHoistPattern` / `allowBuilds` は調査済み・変更不要（「既存実装の状態」参照） |
| `vitest.config.integration.ts` | `exclude` の `"packages/core/src/adapters/libsql/**"` / `"packages/core/src/adapters/node/**"` / `"apps/web/app/worker/node/**"` の3行と、その直前の `// The libSQL adapter and the in-process worker runner have their` で始まるコメントブロック |
| `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` | `serverNode` / `serverAws` / `serverGcp` を import して4ランタイム分を `describe.each` |
| `packages/core/src/application/di/containerStore.ts` | `getContainer()` の JSDoc（`` `apps/web/app/server.node.ts` `` … `` `apps/web/app/server.gcp.ts` all call `installContainerStore` ``）と throw 文の `"apps/web/app/server.{node,cloudflare,aws,gcp}.ts) "` |
| `packages/core/src/application/di/secrets.ts` | `requireSessionSecret` の JSDoc（`the AWS and GCP env readers are shared with the relay / consumer / pruner / DLQ entry points` と `Node, AWS and GCP build that config once at boot / cold start`） |
| `packages/core/src/application/di/env.ts` | `TuningEnv` の `/** Worker-tuning env variables shared by both runtimes. */` |
| `packages/core/src/application/di/serverCloudflare.ts` | **★ 初版で漏れていた。** `ServerEnv` の JSDoc `` * Node entry has its own env shape in `./serverNode`. ``（**削除するモジュールを名指ししている**）と、`SESSION_SECRET` フィールドのコメント `// never as a `[vars]` entry. Optional here — like the zod-validated` / `// runtimes, the request path is what demands it`（「他ランタイム」前提の複数形） |
| `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` | `createHmacSessionCodec` の JSDoc **2箇所**: `one implementation across all four runtimes`（★漏れ）と `` the four DI factories that call {@link createHmacSessionCodec} (`application/di/server{Node,Cloudflare,Aws,Gcp}.ts`) `` |
| `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` | **2箇所**: `MAX_PBKDF2_ITERATIONS` の JSDoc `(a Worker killed by its CPU limit, a Node worker thread pinned indefinitely)`（★漏れ）と `createPbkdf2PasswordHasher` の JSDoc `available unchanged on Node 20+, Workers, Lambda and Cloud Run, so all four reference runtimes share one implementation` |
| `packages/core/src/application/identity/__tests__/identity.integration.test.ts` | `(D1 aborts the losing batch; libSQL fails the transaction).` のコメント |
| `.github/workflows/ci.yml` | `integration` ジョブの `runtime: [cf, node]`、`build` ジョブの `runtime: [cf, node, aws, gcp]`、および `name: … (${{ matrix.runtime }})` / `pnpm test:integration:${{ matrix.runtime }}` / `pnpm build:${{ matrix.runtime }}` |
| `docs/test.md` | Integration 節の `real SQLite through two pools. … Node tests create isolated temporary libSQL databases`／Real DB test policy 節の `` - `pnpm test:integration:node` runs libSQL adapter and Node worker-runner tests `` と `- The libSQL adapter and the Node worker runner can't run in a Workers isolate`／Timeout 節の `set it in the runtime-specific integration config`／Commands 表の見出し `Integration only (both pools)` の行（**★ 漏れていた**）と `Integration, Node pool + libSQL` の行 |
| `docs/backend_implementation_example.md` | ディレクトリツリーの `│   ├── di/serverNode.ts           createNodeRequestContainer, createNodeWorkerContainer, readNodeServerEnv (Node runtime)` 行と、直上 `di/serverCloudflare.ts` 行末の `(CF runtime)` 注記 |
| `docs/runtime_cloudflare.md` | 冒頭の `` See [`runtime_node.md`](./runtime_node.md) for the standalone runtime that runs the same code on a single Node process. ``／TOC の `- [D1-specific behaviour and the libSQL diff](#d1-specific-behaviour-and-the-libsql-diff)`／`` documented in `apps/web/.env.example` — the schema is shared with the Node runtime ``／`` (Bare `pnpm db:generate` targets the libSQL runtime, matching `pnpm db:migrate`.) ``／`` is an alias of `db:apply:local` for parity with the Node runtime's `pnpm db:migrate`. ``／`## D1-specific behaviour and the libSQL diff` 節全体（比較表と `libSQL exposes an interactive `transaction("write", fn)` API` の段落を含む） |
| `README.md` | ツリーの `│  └─ server.*.ts   # server fetch entries` と `└─ scripts/         # migration and production launcher scripts`（**★ 漏れていた** — 撤去後 `scripts/` に残るのは `render-wrangler.ts` 1本）／`infra/                # aws (CDK, workspace member), cloudflare (Pulumi), gcp (Terraform)`／`docs/                 # implementation pattern examples + runtime guides`（**★ 漏れていた**）／`## Reference runtimes` 節全体（`four reference runtime wirings` 〜 `Per-runtime operational guidance:` のリンク行）／`## Requirements` の `The matching cloud CLI/account only for runtimes you keep`／`## Quick Start` 節（`The default scripts target the Node runtime.` 〜 `pnpm start` のブロックと `If you want to try the Cloudflare wiring instead` 段落）／`## Development commands` のスクリプト表／`## Database migrations` 節 |
| `CLAUDE.md` | Workspace layout 節の `per-runtime server entries and workers` / `` - `infra/aws` (`@repo/infra-aws`) `` / `` - `infra/gcp` — Terraform only ``／Reference runtimes 節全体（`four reference runtime wirings` / `**Node**:` `**AWS**:` `**GCP**:` のエントリポイント行 / `docs/runtime_node.md`〜`docs/runtime_gcp.md` 参照 / `The Node runtime is the default for` / `To target a different runtime (Cloud Run, Fly Machines, etc.)` / `libSQL works on Lambda / Cloud Run unchanged`） |
| `.gitignore` | `# Node runtime` ブロック（`data/` / `.env` / `.env.*` / `!.env.example` / `!.env.*.example`） |
| `.dockerignore` | ファイルごと（Dockerfile.gcp 専用。`infra/aws/cdk.out` も参照） |
| `biome.json`（★3周目で追加） | `files.includes` の `"*.mjs"`（`biome.json:15`）。リポジトリ唯一の `.mjs` である `apps/web/scripts/listen.gcp.mjs` が消えるとデッドパターンになる。**`infra/**` は `infra/cloudflare/pulumi` が残るので `files.includes` / `linter.includes` の両方で残す**（ステップ7） |

### あるべきアーキテクチャ

`CLAUDE.md` の Hexagonal + DDD が正。依存は presentation → application → domain の一方向で、adapters はその内側で定義されたポートを実装する。ランタイム差分は **adapters と entry point だけ**に閉じ込められている、というのがテンプレートの設計上の主張であり、今回の撤去はその主張の検証でもある。

したがって撤去後に残るべき構成は次のとおり:

- `domain` / `presentation` — **1行も変更されない**。ここに差分が出るなら、ランタイム漏れがあったということ。`application`（DI 除く）の差分も**テストコメント1行のみ**（`application/identity/__tests__/identity.integration.test.ts:341`）で、プロダクションコードは無変更。
- `application/di/` — ランタイムごとの合成ルート。`serverCloudflare.ts` だけが残り、`containerStore` / `env` / `secrets` / `types` は「複数ランタイム間で共有される部品」から「Cloudflare 用の部品」へと立ち位置が変わる。**ファイル構成は変えないが、JSDoc の主張（「両ランタイム共有」「4ランタイムすべて」）は嘘になるので直す**。
- `adapters/` — `d1` / `cloudflare` / `webcrypto` の3グループ。
- `apps/web` — エントリは `server.cloudflare.ts` のみ、vite config は `vite.config.cloudflare.ts` のみ。

**抽象の実測（初版の記述を訂正）** — 初版は「ポート（`RelayTrigger` / `QueueDispatcher` / `SecretsLoader` 等）の抽象は application 層に残るので壊れない」と書いていたが、後ろ2つは実在しない。実測した正しい姿は次のとおりで、#37 への引き継ぎはこの前提で行う。

| 抽象 | 実際の所在 | 撤去後の状態 |
|---|---|---|
| `Clock` / `IdGenerator` / `IdempotencyStore` / `Logger` / `OutboxRepository` / `RelayTrigger` / `SessionCodec` | `packages/core/src/application/ports/`（**この7つで全部**） | すべて維持。撤去の影響を受けるのは `RelayTrigger` のみ（実装が `ServiceBindingRelayTrigger` 1本になる） |
| `EventDispatcher`（キュー投入の抽象） | `packages/core/src/application/workers/eventRelayWorker.ts` の型エイリアス。**`ports/` ではない** | 型は維持。ただし `adapters/{node,aws,gcp}` の3実装が消え、**`packages/core/src/adapters/` 配下の実装がゼロ**になる。唯一の実装は `apps/web/app/worker/cloudflare/handlers.ts` の `runRelayTick` 内にインライン定義された `const dispatch: EventDispatcher` |
| `QueueDispatcher` | **存在しない**（`ports/` にも `workers/` にもない） | — |
| `SecretsLoader` | **存在しない**。`adapters/aws/secretsLoader.ts` と `adapters/gcp/secretsLoader.ts` がそれぞれ独立に `loadSecretsIntoEnv()` を export しているだけで、共通インターフェースも Cloudflare 版もない | 撤去とともに**概念ごと消滅**する。ポートを潰すわけではないので設計上の後退ではない |

「`EventDispatcher` の実装がアダプター層に1つも無く、唯一の実装が `apps/web` 側にインライン化されている」という構造上の非対称は本 Issue では直さない（#37 の DO 移行でキュー境界そのものが再設計されるため）。引き継ぎ項目 H-6 として記録する。

`spec/` はまだ 4ランタイム / libSQL / Turso 前提のままだが、その同期は #35 の担当（本 Issue のスコープ外）。

### 既存実装の状態

**あるべき姿と一致している点（＝撤去が素直に効く根拠）**

- ランタイム固有コードは実際に adapters と entry point に閉じている。**実測（`grep -rlE 'libsql|libSQL|serverNode|serverAws|serverGcp|Turso|Lambda|Cloud Run|@aws-sdk|@google-cloud'` を `domain/` / `application/` / `presentation/` に対して実行）では、`packages/core/src/domain/` と `apps/web/app/presentation/` はヒット0件、`application/` のヒットは `di/server{Cloudflare,Node,Aws,Gcp}.ts` / `di/__tests__/requestContainerConfig.test.ts` と `identity/__tests__/identity.integration.test.ts` の1コメント行だけ**。つまり「DI 以外の application 層は変更なし」は厳密には正しくなく、**テストコメント1行だけ差分が出る**（ステップ5 の編集対象）。ステップ16-11 の判定基準を `packages/core/src/domain/` の差分0に限っているのはそのため。
- `libsql → d1` は一方向依存。`packages/core/src/adapters/libsql/schema.ts` は `export * from "../d1/schema"` の1行のみで、逆方向（`d1 → libsql`）の import は0件。**移設・順序制約は不要**で、libsql をディレクトリごと消しても d1 は無傷。
- migrations も物理的に別ディレクトリ（`libsql/migrations/` と `d1/migrations/`）。schema.ts が共有だったため `0000_initial.sql` の中身が完全一致していただけで、ファイル共有はしていない。drizzle config の `out` も分離済み。
- `repositories/helpers.ts` は libsql / d1 で別実装（前者は `LibsqlError` の `instanceof`、後者はメッセージ正規表現）。共通抽象はない。

**乖離している点（本 Issue で直す）**

- 「複数ランタイムを支える共有部品」を主張する JSDoc / エラーメッセージが `containerStore.ts` / `secrets.ts` / `env.ts` / `webcrypto/*` に散在している。撤去後は事実と食い違うので更新する（`CLAUDE.md` の「Default to no comments … 一つだけ書くなら WHY」原則からしても、間違った WHY を残すのは最悪）。
- `requestContainerConfig.test.ts` は「4つの合成ルートすべてが `AppConfig` のキー集合しか公開しない」という恒久ガードを `describe.each` で張っている。Cloudflare 1本になっても**このガード自体は残す価値がある**（`satisfies` が excess property check を走らせない、という穴は Cloudflare でも同じ）ので、テーブルを cloudflare 1件に縮めて維持する。削除しない。
- `.env.example` は Node 専用の説明文書だが、`docs/runtime_cloudflare.md` の「documented in `apps/web/.env.example`」が outbox tuning 変数のドキュメントとしてこれを指している。`apps/web/wrangler.toml` に同等のコメントが既にあるので参照先を付け替えて `.env.example` は削除できる。ただし **4変数は1箇所にまとまっていない**（実測）: `OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` / `OUTBOX_MAX_ATTEMPTS` は `[env.relay.vars]`、`OUTBOX_RETENTION_MS` は `[env.pruner.vars]`。差し替え先は「`wrangler.toml` の `[env.relay.vars]` と `[env.pruner.vars]`」と**両方**を指す。
- `pnpm-workspace.yaml` の `overrides` / `publicHoistPattern` / `allowBuilds` は **調査済み・変更不要**。`allowBuilds` の4エントリは一見 GCP / AWS 由来に見えるものがあるが実測では全て Cloudflare 側で必要:
  - `protobufjs: false` — `@google-cloud/pubsub` ではなく `@pulumi/pulumi` → `@grpc/grpc-js` → `@grpc/proto-loader` 由来。`infra/cloudflare/pulumi` を残す以上そのまま必要。
  - `sharp: false` — `miniflare`（`@cloudflare/vite-plugin` / `vitest-pool-workers`）由来。
  - `esbuild: true` / `workerd: true` — vite / wrangler が transitive に持つビルドスクリプトに効く。**ルート devDependency の `esbuild` を削除しても `allowBuilds.esbuild` は残す**（一緒に消さない）。
- ルート `package.json` の `esbuild` devDependency は `infra/aws` 用だった蓋然性が高い。根拠は `pnpm why` ではなく**リポジトリ内の直接証拠**:
  - `infra/aws/lib/appStack.ts:34` が `import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs"` を持ち、`:110-111` のコメントが「NodejsFunction's esbuild bundler auto-discovers tsconfig by walking up from the entry」と明記している。CDK の `NodejsFunction` は Docker を使わないバンドルのためにローカルの `esbuild` 解決を要求する。
  - リポジトリ内で `esbuild` を直接名指ししているのは `package.json` / `pnpm-workspace.yaml`（`allowBuilds`）/ この `appStack.ts` のコメント2箇所のみ。
  - `git log -S esbuild -- package.json` は initial commit しか返さないため履歴からは辿れない。
  - `pnpm why esbuild -r` は `vite` / `tsx` / `wrangler` / `@cloudflare/vitest-pool-workers` / `vitest` 経由の推移依存を大量に返す（実測）ので、「他に必要とするものがなければ削除」という判定条件は**常に偽**になり判断材料にならない。
  - したがって判定は **`pnpm why` ではなく実際に削除して検証する**（ステップ9）。

**HEAD 時点のベースライン実測（★3周目で追加。2026-07-29 / `pnpm install --frozen-lockfile` 後）**

撤去後に検証コマンドが落ちたとき「撤去が原因か、元から壊れていたか」を切り分けられるよう、AC-3 / AC-7 が要求するコマンドを**撤去前の HEAD で実行した結果**を記録する。`pnpm start` が本 Issue 以前から起動不能（H-8）だった経緯があるため、残りも実測で確かめてある。

| コマンド | HEAD での結果 |
|---|---|
| `pnpm typecheck` | exit 0（4 ワークスペースすべて Done） |
| `pnpm lint` | exit 0（infos 22 のみ、エラーなし） |
| `pnpm format:check` | exit 0 |
| `pnpm test:unit` | 26 files / **424 tests** passed |
| `pnpm test:integration:cf` | 9 files / **104 tests** passed |
| `pnpm build:cf` | 成功（`dist/server/index.js` 735.68 kB） |
| `pnpm dev:cf` + `curl http://localhost:3000/` | vite ready 2.4s、`HTTP 307`（`/login` へのリダイレクト）。起動可能 |

**したがって AC-3 / AC-7 は HEAD で全 green ＝ 達成可能な基準である。撤去後にこれらが落ちたら原因は撤去側にある**、と切り分けてよい。`test:unit` の 424 / `test:integration:cf` の 104 は撤去後の件数比較の基準値にもなる（unit は `adapters/node/__tests__/` の2ファイル分だけ減るのが正しい。「テスト方針」節参照）。

**前提条件（重要）:** この計測は `pnpm install --frozen-lockfile` の直後に行っている。`node_modules` が `package.json` と乖離した状態（`packages/core/node_modules` に `drizzle-orm` が無い等）では `pnpm build:cf` が `Rolldown failed to resolve import "drizzle-orm/d1"` で落ちる。**ステップ16 の検証は必ず 16-1 の `pnpm install` を済ませてから行うこと**（16-1 が先頭にあるのはこのため）。同時に、H-8 の `wrangler deploy --dry-run` が返した 9 errors のうち `drizzle-orm` 由来の6件が「検証環境の `node_modules` が古かったことによる」という診断の裏づけでもある（`pnpm install` 後は仮想モジュール3件のみの `Build failed with 3 errors` になる）。⚠️ **ただしこの `--dry-run` は `pnpm start` の実行経路ではない。`pnpm start` が起動しない真因は別（H-8 / Issue #40 を参照）。**

**本 Issue 以前から壊れており、本 Issue では直さない点**

- **`pnpm start`（= `start:cf` = `wrangler dev`）は起動できない。** ⚠️ **本項の診断は当初誤っていた。以下は事後の追試による訂正版。** 追跡先は **Issue #40**（https://github.com/tuanemuy/fog/issues/40 ）。
  - **ビルドは成功する。** 実測: `apps/web` で `npx wrangler dev --port 8798` を実行すると 78 modules / 1132.07 KiB のバンドルが問題なく生成される。落ちるのは **workerd の起動時**で、`service core:user:tanstack-start-template: Uncaught Error: Disallowed operation called within global scope. Asynchronous I/O (ex: fetch() or connect()), setting a timeout, and generating random values are not allowed within global scope.` → `The Workers runtime failed to start.` となる。
  - 原因は `packages/core/src/application/workers/eventRelayWorker.ts:97` の `const RELAY_WORKER_ID = crypto.randomUUID();` が**モジュールスコープで評価される**こと。workerd はグローバルスコープでの乱数生成を禁止している。流入経路は `apps/web/app/server.cloudflare.ts` → `application/di/serverCloudflare.ts` → `application/di/env.ts:6` → `application/workers/eventRelayWorker.ts`。`pnpm preview` も同一原因で失敗する。ローカルで動くのは `pnpm dev` だけ（Vite のモジュールランナーがリクエストハンドラ内でモジュールを評価するため制約に当たらない）。
  - **`wrangler.toml` の `main` は `pnpm start` の経路では読まれていない。** `pnpm build` 後は Cloudflare の vite プラグインが `apps/web/.wrangler/deploy/config.json`（`{"configPath":"../../dist/server/wrangler.json"}`）を書き出し、wrangler はその redirect 先（`main: "index.js"` = ビルド成果物）を使う。実測ログにも `Using redirected Wrangler configuration. - Configuration being used: "dist/server/wrangler.json" / - Original user's configuration: "wrangler.toml"` と出る。
  - 参考（redirect が無い経路）: `.wrangler/deploy/config.json` を退避して `npx wrangler deploy -c wrangler.toml --dry-run` を走らせたときだけ `main = "app/server.cloudflare.ts"` が使われ、**`Build failed with 3 errors`**（`#tanstack-router-entry` / `#tanstack-start-entry` / `tanstack-start-manifest:v` の仮想モジュール3件）で落ちる。`wrangler.staging.toml.tpl` / `wrangler.production.toml.tpl` も同じ形（`:21`）。したがって `main` を `dist/server/index.js` へ直す修正は **redirect が無い経路のためには依然として必要**だが、それだけでは `pnpm start` は直らない。
  - **当初の誤診断**: 「`main` が TS ソースを指しているため wrangler の esbuild が仮想モジュールを解決できず `Build failed with 9 errors` になる」と記録していた。9 件のうち 6 件は `node_modules` が `package.json` と乖離した状態での `drizzle-orm/d1` 等の解決失敗で、`pnpm install --frozen-lockfile` 後は再現しない。加えて上記のとおり `pnpm start` の経路ではこのビルドパス自体が使われない。
  - 傍証: #34 系の作業で生まれた未追跡の `apps/web/wrangler.request.staging.toml` は既に `main = "dist/server/index.js"`（ビルド成果物）に変わっている。
  - **これは本 Issue が壊すのではなく既に壊れている**ため、撤去のスコープでは直さない。AC-3 の検証を「スクリプト定義の確認」に緩め（AC-3 の文言参照）、事実を引き継ぎ項目 **H-8** とリスク節に記録した。**H-8 の追跡は Issue #40 へ移管済み**（#37 の対応項目8 では直らないため）。
  - 影響: `docs/runtime_cloudflare.md` の Quick start に「`pnpm start` は `wrangler dev` を起動する」旨を添える案（初版のステップ12）は**動かないコマンドの案内になるので撤回する**。

### 依存関係

- 本 Issue は #34 / #35 に依存しない（Issue 本文で「先行着手可」と明記）。逆に #37 は本 Issue に依存する。
- 撤去によって「Cloudflare 側でカバーされない統合テスト」が発生する。これは #37 への引き継ぎ項目として記録する（AC-5）。
- `pnpm-lock.yaml` の再生成が発生するため、他ブランチとのコンフリクト面が広い。

## 設計

本 Issue は撤去主体なので、「撤去後に残る構成がアーキテクチャとして一貫しているか」を設計の軸とする。

### ドメインモデルへの影響

**なし。** ランタイム差分は adapters と entry point に閉じているため、entity / value object / domain service / ポートインターフェース / domain event のいずれも変更しない。`packages/core/src/domain/` に1行も差分が出ないことが、テンプレートの層分離が本物だったことの検証になる。**差分が出たら撤去の切り口を間違えている**、という判定基準として使う。

### ユースケース / アプリケーションロジック

**ポート抽象は変更しない。** `application/ports/` の7ポート（`Clock` / `IdGenerator` / `IdempotencyStore` / `Logger` / `OutboxRepository` / `RelayTrigger` / `SessionCodec`）と `UnitOfWorkProvider` は、実装が1つになるだけで抽象を潰したり Cloudflare 型に特化させたりはしない（それは #37 が DO 前提で再設計する領域であり、本 Issue で先取りすると #37 と衝突する）。`application/workers/eventRelayWorker.ts` の `EventDispatcher` 型も同様に無変更。

ただし「あるべきアーキテクチャ」節の表のとおり、`QueueDispatcher` と `SecretsLoader` という抽象はそもそも存在しない。`SecretsLoader` は AWS / GCP がそれぞれ独立に持つランタイム固有ユーティリティ（`loadSecretsIntoEnv()`）なので、撤去とともに概念ごと消える。**これはポートを潰す行為ではない**ので設計上の後退にはあたらない。#37 に「#36 で維持されたはずのポート」として探させないよう、引き継ぎコメント（ステップ15）でもこの線で書く。

変更するのは **合成ルート（`application/di/`）だけ**:

- `serverNode.ts` / `serverAws.ts` / `serverGcp.ts` を削除し、`serverCloudflare.ts` を唯一の合成ルートにする。
- `containerStore.ts` / `env.ts` / `secrets.ts` / `types.ts` はファイルとして残す。ただし「複数ランタイム共有」を前提にした JSDoc・エラーメッセージは Cloudflare 単独の記述へ直す。特に `containerStore.ts` の `getContainer()` が投げるエラーメッセージは、存在しないファイル4つを利用者に案内してしまうので必ず直す。
- `application/workers/`（`eventRelayWorker` / `outboxPrune`）はランタイム非依存のまま無変更。

### アダプター / 永続化 / 外部連携

- `libsql` / `node` / `aws` / `gcp` の4グループをディレクトリごと削除。順序制約はない（`libsql → d1` の一方向依存のみで、逆方向はゼロ）。
- `d1` / `cloudflare` / `webcrypto` は無変更。
- migrations は `d1/migrations/` のみが残る。`drizzle.libsql.config.ts` を削除し、`drizzle.config.ts`（D1 用）を唯一の生成設定にする。スキーマ・マイグレーションの移設は**不要**。

### UI / プレゼンテーション

**なし。** `apps/web/app/{components,routes,presentation}/` はランタイム非依存で、撤去対象への参照ゼロ。`app/start.ts` / `app/router.tsx` も無変更。

### テスト構成

- 統合テストのプールが2つ（Workers プール + Node プール）から **Workers プール1つ**になる。`vitest.config.integration.node.ts` は include が全部消えて空になるのでファイルごと削除し、`test:integration` は `test:integration:cf` のみを呼ぶ。
- `vitest.config.ts`（unit / Node プール）は無変更。unit テストは残る。
- `vitest.config.integration.ts` の `exclude` から libsql / node / worker-node の3行と、その理由を説明するコメントを削除する（対象が消えるので嘘の説明になる）。

### 撤去で失われるテストカバレッジと引き継ぎ

**DB 層は libSQL 固有経路の検証を除いて D1 側が上位互換**（初版の「36 ケース / 1件残らず等価 / 喪失はゼロ」は実測と食い違っていたので訂正）。

実測した libsql 統合テストの内訳（`it(` ブロック数 / `it.each` 展開後のケース数）:

| ファイル | libsql | d1 | 等価性 |
|---|---|---|---|
| `idempotencyStore.integration.test.ts` | 3 | 3 | テスト名まで一致 |
| `occGuard.integration.test.ts` | 2 | 3 | **1:1 対応ではない**（下記） |
| `outboxRepository.integration.test.ts` | 10 | 11 | d1 が libsql の10件を包含 ＋ `never returns the same row to two concurrent claimers` |
| `unitOfWork.integration.test.ts` | 5 | 5 | テスト名まで一致 |
| `userRepository.integration.test.ts` | **12 ブロック**（`it(` 11 + `it.each` 1 × 6行）= 17 ケース | 同形（**12 ブロック** / 17 ケース） | 同形 |
| **合計** | **32 ブロック / 37 ケース** | — | — |

（`userRepository` のブロック数は初版で 11 と書いていたが実測は **12**。合計の 32 ブロック（3+2+10+5+12）は 12 を前提にした値なので、合計側が正しく、セル側が誤っていた。ケース数 17 は両方正しい。libsql / d1 とも `it(` 11 件 + 6 行の `it.each` 1 件で実測確認済み。）

加えて d1 側にのみ `helpers.integration.test.ts`（`mapDbError` の `SQLITE_CONSTRAINT_*` 分類 4 ケース）がある。

**occGuard の非対称（正確な記述）** — libsql の2件（`keeps _occ_guard empty across a successful commit` / `keeps _occ_guard empty after a failed OCC commit`）は `unitOfWorkProvider.run(...)` を通した **UoW 経路**で `_occ_guard` テーブルが空のままであることを検証している。対する d1 の3件は `db.batch([...])` を直に叩く **生バッチ経路**の検証で、UoW を経由していない。d1 側の UoW 経路の近接物は `unitOfWork.integration.test.ts` の `rolls back outbox events when the aggregate write hits an OCC failure` だが、これは outbox のロールバックを見るだけで **`_occ_guard` が空であることは検証していない**（実測確認済み）。

つまり正確には「**保証としては等価**（libsql 側のファイル JSDoc 自身が "Mirrors the D1 adapter's `occGuard.integration.test.ts`" と宣言している）だが、d1 側は生バッチ経路と UoW 経路に分割してカバーしており、**`_occ_guard` 空判定を UoW 経路で行うテストは d1 側に存在しない**」。この穴は撤去で新規に生まれるものではなく元から d1 側にあったものだが、libsql 撤去で「別経路で担保されていた」という言い訳が効かなくなるので H-5 として記録する。

**引き継ぎ項目（AC-5）** — H-1〜H-6 は #37 へ、H-7 は #26 へ、H-8 は #37（または Phase 5 で起票する別 Issue）へ引き継ぐ。

| ID | 失われる検証 | 評価 | #37 での扱い |
|---|---|---|---|
| H-1 | `createInMemoryQueueDispatcher` 4 ケース（成功/失敗の outcome 形、空バッチ、並行度上限） | 実装ごと消えるので実質喪失なし | 記録のみ。復活不要 |
| H-2 | `createInProcessRelayTrigger` 5 ケース（kick 合流、`stop()` の in-flight 待ち、stop 後の kick 無視、throw の握り潰し、tick 実行） | **削除後、`RelayTrigger` ポート実装のテストがリポジトリ全体でゼロになる**（`ServiceBindingRelayTrigger` は元々ノーテスト）。ただし失われる5観点はインプロセス固有のセマンティクスで、Cloudflare 側には概念が存在しない | #37 で RelayTrigger 自体が DO Alarm に置き換わる。置き換え後の起動セマンティクス（重複起動の合流・in-flight 中の再アラーム）に相当するテストを #37 で用意する |
| H-3 | worker runner の `stop()` 冪等性 | 長寿命ランナーが Cloudflare に存在しないため等価概念なし | #37 の「Alarm 再実行 / DO 再起動 / 処理途中失敗」テストが後継 |
| H-4 | relay → queue → consumer の一気通貫 E2E | Cloudflare 側は producer（`runRelayTick`）と consumer（`handleQueue`）を個別に検証するのみで、キューを跨いだ1本のフローは未検証 | #37 で FTS5 が同一トランザクション同期になり境界自体が消える。残す外部 I/O ジョブについては #37 で E2E を用意する |
| H-5 | (a) libSQL の interactive transaction 経路で `_occ_guard` CHECK トリックが成立する証拠、(b) **UoW 経路で `_occ_guard` が空のままであることを検証するテスト**（d1 側には生バッチ経路の検証しかなく、UoW 経路の等価物 `rolls back outbox events when the aggregate write hits an OCC failure` は outbox ロールバックしか見ていない） | (a) は Cloudflare 単独構成では無意味。(b) は撤去で新規に生まれる穴ではなく元から d1 側にあった穴だが、libsql 側で担保されていた分が消える | (a) は記録のみ・復活不要。(b) は #37 の DO 移行で `_occ_guard` トリックごと消える見込みなので復活不要だが、**消える前に穴があった事実**として記録する |
| H-6 | `EventDispatcher` の実装がアダプター層からゼロになる（唯一の実装が `apps/web/app/worker/cloudflare/handlers.ts` の `runRelayTick` 内にインライン定義される） | テストの喪失ではなく構造上の非対称。`packages/core/src/adapters/` に port 実装が無い抽象が1つできる | #37 の DO 移行でキュー境界そのものが再設計されるので、そこで整理する。本 Issue では直さない（スコープ外） |
| H-7 | **#26 の項目2「D1 の OCC 競合誤帰属」の“正しい参照実装”が消える** — `adapters/libsql/pendingBatch.ts` の `addOcc(write, onConflict)` は `{ kind: "occ", run, onConflict }` として**文ごとに** conflict handler を保持する。対する `adapters/d1/pendingBatch.ts:95` の `firstConflictHandler()` は**先頭の** handler を返し、`adapters/d1/unitOfWork.ts:109` がそれを使う（これが誤帰属の実体）。**テストではなく実装の喪失** | #26 本文は「libSQL 側の実装は正しく、2つのアダプターで挙動が食い違っている」を根拠に立っている。libsql を消すとその根拠が宙に浮き、修正担当者は per-statement handler の設計を一から再構成することになる | #26 のコメント（ステップ15）に「D1 分は残るが、**正しい実装の参照先（libSQL の `PendingBatch.addOcc`）は本 Issue で消える**」と明記する。設計そのものを引き継ぐのは #26 の担当 |
| H-8 | **`pnpm start`（= `start:cf` = `wrangler dev`）が起動不能** — ⚠️ **当初の診断は誤りだった（訂正済み）**。ビルドは成功する（実測 78 modules / 1132.07 KiB）。落ちるのは **workerd の起動時**で、`packages/core/src/application/workers/eventRelayWorker.ts:97` の `const RELAY_WORKER_ID = crypto.randomUUID();` がモジュールスコープで評価されるため `Disallowed operation called within global scope. ... generating random values are not allowed within global scope.` になる。流入経路は `app/server.cloudflare.ts` → `di/serverCloudflare.ts` → `di/env.ts` → `workers/eventRelayWorker.ts`。`pnpm preview` も同一原因。（誤診断の内容: 「`main` が TS ソースを指すため esbuild が `#tanstack-router-entry` 等を解決できず `Build failed with 9 errors`」。9 件中 6 件は `node_modules` 乖離由来で `pnpm install` 後は再現せず、そもそも `pnpm start` は `dist/server/wrangler.json` への redirect 設定を使うので `wrangler.toml` の `main` を読まない） | **本 Issue 以前から存在する欠陥**で、撤去では直せない。AC-3 の検証を「スクリプト定義の確認」に緩めることで受け入れる | **追跡先は Issue #40**（https://github.com/tuanemuy/fog/issues/40 ）。修正対象は `eventRelayWorker.ts` の module-scope 乱数生成。#37 の対応項目8（`main` を `dist/server/index.js` へ）は redirect の無い経路のために依然必要だが、それだけでは `wrangler dev` は直らない |

## 実装ステップ

**参照元 → 参照先（外側 → 内側）の順**に並べる。撤去なので「参照される側を消す前に参照元を消す」のが正しい順序であり、ステップ 2（エントリポイント）→ 3（DI）→ 4（アダプター）はその順序になっている。

### 1. 引き継ぎ項目を確定させる

- **対象ファイル:** `.thread/36/plan.md`（本ファイル・上表 H-1〜H-8）
- **変更内容:** 削除前に、上の「撤去で失われるテストカバレッジと引き継ぎ」表を最終確認する。実装中に追加で見つかった喪失があれば表に追記する。
- **理由:** 削除してしまうと何を失ったか再構成できない。#37 へのコメント（ステップ15）の内容源になる。AC-5。

### 2. エントリポイントと worker を削除する

- **対象ファイル:** `apps/web/app/server.node.ts` / `server.aws.ts` / `server.gcp.ts`、`apps/web/app/worker/node/`（`runner.ts` + `__tests__/`）、`apps/web/app/worker/aws/`（5ファイル）、`apps/web/app/worker/gcp/`（5ファイル）
- **変更内容:** ディレクトリ・ファイルごと削除。`apps/web/app/worker/cloudflare/` は無変更。
- **理由:** 最も外側の参照元。ここを先に消すと以降の削除で「残った参照」を追いやすい。AC-1。

### 3. DI の合成ルートを Cloudflare 単独にする

- **対象ファイル:** `packages/core/src/application/di/serverNode.ts` / `serverAws.ts` / `serverGcp.ts`（削除）、`packages/core/src/application/di/__tests__/requestContainerConfig.test.ts`（編集）
- **変更内容:** 3ファイルを削除。テストは `containers` テーブルを cloudflare 1件に縮め、`LibsqlDatabase` 型 import と `db` フィクスチャを落とす。`describe.each` は1件でも成立するので構造は保つ。「usecase が sessionCodec に到達できない」型テストは無変更。
- **理由:** `AppConfig` のキー集合ガードは Cloudflare でも同じ穴（`satisfies` が excess property check を走らせない）に対する恒久ガードなので、ランタイムが減っても捨てない。AC-1。

### 4. ランタイム固有アダプターを削除する

- **対象ファイル:** `packages/core/src/adapters/libsql/`、`packages/core/src/adapters/node/`、`packages/core/src/adapters/aws/`、`packages/core/src/adapters/gcp/`
- **変更内容:** 4ディレクトリを丸ごと削除（`__tests__` / `migrations` を含む）。`adapters/d1/` / `adapters/cloudflare/` / `adapters/webcrypto/` は無変更。
- **理由:** `libsql/schema.ts` は `d1/schema` の再エクスポート1行で逆依存がないため、移設・順序制約なしで消せる。AC-1。

### 5. 残存コードの JSDoc / エラーメッセージから撤去済みランタイムの記述を消す

- **対象ファイル（引用文字列で特定。行番号は目安であり、編集で必ずずれる）:**

  | ファイル | 潰す文字列 | 直し方 |
  |---|---|---|
  | `application/di/containerStore.ts` | `getContainer()` の JSDoc `` — `apps/web/app/server.node.ts`, `apps/web/app/server.cloudflare.ts`, `apps/web/app/server.aws.ts` and `apps/web/app/server.gcp.ts` all call `installContainerStore`; this reader is shared by all of them. `` | 「`apps/web/app/server.cloudflare.ts` が `installContainerStore` を呼ぶ」の単数形に |
  | 同上 | throw 文の `"The runtime entry (one of " + "apps/web/app/server.{node,cloudflare,aws,gcp}.ts) "` | `"The runtime entry (apps/web/app/server.cloudflare.ts) "` に。**存在しないファイル4つを利用者に案内してしまうので必須** |
  | `application/di/secrets.ts` | `requireSessionSecret` の JSDoc `the AWS and GCP env readers are shared with the relay / consumer / pruner / DLQ entry points, which never touch a session` | WHY 自体は生きている。Cloudflare の relay / consumer / pruner / DLQ Worker が同じ env スキーマ（`ServerEnv`）を使う、という形に書き直す |
  | 同上 | `Node, AWS and GCP build that config once at boot / cold start, so a missing or too-short secret fails the process rather than every request. Cloudflare has no boot phase in which `env` exists, so its config is necessarily per-request;` | 対比の片側が消えるので、「Cloudflare には `env` が存在する boot フェーズが無いので config は必然的に per-request。チェックはアイソレートが仕事を始める前に走る」だけを残す |
  | `application/di/env.ts` | `/** Worker-tuning env variables shared by both runtimes. */` | 「Cloudflare の top-level / relay / consumer / pruner / DLQ Worker が共有する」等、実態に合わせる |
  | `application/di/serverCloudflare.ts` | **★初版で漏れていた。** `ServerEnv` JSDoc の `` The Node entry has its own env shape in `./serverNode`. `` | 一文ごと削除（削除するモジュールを名指ししている） |
  | 同上 | `SESSION_SECRET` フィールドのコメント: `Optional here — like the zod-validated` と続く行の `runtimes, the request path is what demands it (see` | 「他ランタイムと同様」という比較を落とし、`requireSessionSecret` が request path で要求する、という理由だけ残す |
  | `adapters/webcrypto/hmacSessionCodec.ts` | **★漏れていた** `one implementation across all four runtimes` | 「no read on the request path」等、ランタイム数に依存しない表現に |
  | 同上 | `the four DI factories that call {@link createHmacSessionCodec}` と続く行の `(application/di/server{Node,Cloudflare,Aws,Gcp}.ts), the` | 「`createHmacSessionCodec` を呼ぶ唯一の DI ファクトリ（`application/di/serverCloudflare.ts`）」に |
  | `adapters/webcrypto/pbkdf2PasswordHasher.ts` | **★漏れていた** `MAX_PBKDF2_ITERATIONS` JSDoc の `(a Worker killed by its CPU limit, a Node worker thread pinned indefinitely)` | Worker 側の例だけ残す |
  | 同上 | `createPbkdf2PasswordHasher` の JSDoc: `unchanged on Node 20+, Workers, Lambda and Cloud Run, so all four` / `reference runtimes share one implementation` | 「Workers で使えるので `packages/core` は crypto 依存を持たない」に縮める |
  | `application/identity/__tests__/identity.integration.test.ts` | `(D1 aborts the losing batch; libSQL fails the transaction).` | `(D1 aborts the losing batch).` に |

- **変更内容:** 上表のとおり、「4ランタイムすべて」「both runtimes」「`server.{node,cloudflare,aws,gcp}.ts`」といった列挙・比較を Cloudflare 単独の記述に置換する。**行番号ではなく引用文字列で探して潰す**（同一ファイル内で先に消すと以降の行番号がずれるため）。ファイル単位の仕上げチェックとして次を実行し、ヒット0件になることを確認する（**現状ではこの7ファイルで grep 出力 14 行 ＝ 記述としては 12 箇所**ヒットすることを実測済み。上表の12行と1:1 対応するのは「箇所」であって grep の行数ではない。`secrets.ts` と `pbkdf2PasswordHasher.ts` は**1つの記述が2行にまたがる**ため行数が2つ多く出る。行数で照合して「2箇所見落とした」と誤解しないこと。ファイル別内訳の実測: `containerStore.ts` 2行 / `secrets.ts` 3行 / `env.ts` 1行 / `serverCloudflare.ts` 2行 / `hmacSessionCodec.ts` 2行 / `pbkdf2PasswordHasher.ts` 3行 / `identity.integration.test.ts` 1行）:

  ```
  grep -nE "runtimes|all four|serverNode|server\.\{?node|\bNode\b|AWS|GCP|Lambda|Cloud Run|libSQL" \
    packages/core/src/application/di/{containerStore,secrets,env,serverCloudflare}.ts \
    packages/core/src/adapters/webcrypto/{hmacSessionCodec,pbkdf2PasswordHasher}.ts \
    packages/core/src/application/identity/__tests__/identity.integration.test.ts
  ```
- **理由:** `containerStore.ts` のエラーメッセージは存在しないファイル4つを利用者に案内してしまう。`serverCloudflare.ts` は**撤去後に唯一残る合成ルート**であり、その本体の JSDoc が削除済みモジュールを名指ししている状態は最も避けたい。`CLAUDE.md` の「コメントは非自明な WHY のみ」原則からしても、事実と食い違う WHY を残すのは最悪。AC-1。

### 6. infra を撤去し、ワークスペースから外す

- **対象ファイル:** `infra/aws/`（6ファイル、`@repo/infra-aws`）、`infra/gcp/`（12ファイル、Terraform）、`pnpm-workspace.yaml`
- **変更内容:** 2ディレクトリを削除し、`pnpm-workspace.yaml` の `packages` から `- "infra/aws"` を削除。`infra/cloudflare/pulumi`（`@repo/infra-cloudflare`）は残す。
- **変更内容の注記:** `pnpm-workspace.yaml` で触るのは `packages` の1行**だけ**。`overrides`（`tinypool: 1.0.2`）/ `publicHoistPattern`（`@types/*`）/ `allowBuilds`（`esbuild` / `workerd` / `protobufjs` / `sharp`）は **調査済み・変更不要**。特に `protobufjs: false` は「GCP を消すから一緒に消す」と判断しがちだが、実測では `@google-cloud/pubsub` ではなく `@pulumi/pulumi` → `@grpc/grpc-js` → `@grpc/proto-loader` 由来で、`infra/cloudflare/pulumi` を残す以上必要（「既存実装の状態」参照）。
- **理由:** `infra/aws` はワークスペースメンバーなので、削除だけしてエントリを残すと `pnpm install` が失敗する。AC-1 / AC-2。

### 7. vite / drizzle / scripts / Docker / env サンプルを削除する

- **対象ファイル:** `apps/web/vite.config.node.ts` / `vite.config.aws.ts` / `vite.config.gcp.ts`、`apps/web/scripts/listen.node.ts` / `listen.gcp.mjs` / `migrate.node.ts` / `migrate.aws.ts` / `migrate.gcp.ts`、`apps/web/drizzle.libsql.config.ts`、`apps/web/Dockerfile.gcp`、`.dockerignore`（ルート）、`apps/web/.env.example` / `.env.aws.example` / `.env.gcp.example`、`biome.json`（★3周目で追加・編集）
- **`biome.json` の編集（★3周目で追加。arch S-003）:** `listen.gcp.mjs` は**リポジトリ唯一の `.mjs` ファイル**（実測: `find . -name '*.mjs'` のヒットは1件のみ）なので、削除すると `biome.json` の `files.includes` にある `"*.mjs"` が**マッチ対象ゼロのデッドパターン**になる。**`files.includes` 配列（`biome.json:10-19`）から `"*.mjs"` の1行だけを削除する。** 同じ配列の `"apps/**"` / `"packages/**"` / `"infra/**"` / `"*.ts"` / `"*.json"` / `"!**/routeTree.gen.ts"` / `"!**/migrations"` はすべて残す。`linter.includes`（`biome.json:28-35`）は `.mjs` パターンを持たないので**無変更**。
  - **`infra/**` は `files.includes` / `linter.includes` の両方で必ず残すこと。** `infra/aws` / `infra/gcp` は消えるが `infra/cloudflare/pulumi`（`@repo/infra-cloudflare`）が残るため、一緒に落とすと Pulumi パッケージが lint / format の対象から外れる。
  - これは **Issue の対応項目にも受け入れ条件にも無い派生作業**（ルート `esbuild` と同じ位置づけ）。`pnpm lint` / `pnpm format:check` が落ちるようなら戻してよく、残しても受け入れ条件は満たす。
- **変更内容:** `biome.json` 以外はすべて削除。`apps/web/scripts/render-wrangler.ts` は残す（`@repo/infra-cloudflare` の `render` から使われる）。`apps/web/drizzle.config.ts`（D1 用）は残す。`.dockerignore` は Dockerfile.gcp 専用（`infra/aws/cdk.out` も参照している）なので一緒に削除。`.env.example` の outbox tuning 変数の説明は `apps/web/wrangler.toml` に同等のコメントが既にあるので移設不要。ただし4変数は1箇所ではなく **`[env.relay.vars]`（`OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` / `OUTBOX_MAX_ATTEMPTS`）と `[env.pruner.vars]`（`OUTBOX_RETENTION_MS`）に分かれている**（実測）ので、ステップ12 の `docs/runtime_cloudflare.md` 差し替えでは両方を指すこと。
- **理由:** AC-1 / AC-10 / **AC-12**（対応項目4 の10ファイル。Issue 本文は `migrate.node.ts` を落として9件表記だが実体は10件）。`.env.example` は Issue の項目に明示されていないが、Node ランタイム専用の設定文書であり、残すと「消えたランタイムの設定手順」が唯一のサンプルとして残ってしまう。

### 8. package.json のスクリプトを整理し、既定を Cloudflare に切り替える

- **対象ファイル:** `package.json`（ルート）、`apps/web/package.json`
- **変更内容:**
  - 削除（両方）: `dev:node` / `dev:gcp` / `build:node` / `build:aws` / `build:gcp` / `start:node` / `start:gcp` / `db:migrate:node` / `db:migrate:aws` / `db:migrate:gcp` / `db:generate:node` / `test:integration:node`（ルートのみ）/ `deploy:aws:staging` / `deploy:aws:production` / `deploy:aws:synth` / `deploy:aws:diff`（ルートのみ）
  - 既定の切り替え（`apps/web`）: `dev` → `pnpm dev:cf`、`build` → `pnpm build:cf`、`start` → `pnpm start:cf`、`db:migrate` → `pnpm db:migrate:cf`、`db:generate` → `pnpm db:generate:cf`
  - 更新（ルート）: `test:integration` を `"pnpm test:integration:cf"` にする。実体コマンド（`vitest run --config vitest.config.integration.ts`）をコピーすると `test:integration:cf` と同一文字列の二重管理になり、#37 で `:cf` を整理するときに2行書き換えることになる。ADR-001 の方針（`:cf` が実体、bare はエイリアス）とも揃う。
  - `predev:cf` は**そのまま**。`"dev": "pnpm dev:cf"` は子プロセスで `dev:cf` を起動するため `predev:cf` は必ず発火する（pnpm 11.1.2・本リポジトリに `.npmrc` なしの条件で `"bar": "pnpm foo"` → `prefoo` が発火することを実測確認済み）。**`predev` を新設してはいけない** — `pnpm dev` で `wrangler types` が二重実行される。`postinstall` の `wrangler types` も無変更。
- **変更内容の注記:** `:cf` サフィックス自体は残す（ADR-001 参照）。`start` = `wrangler dev` の意味論のねじれについても ADR-001 参照。`apps/web` には `test:integration:node` / `deploy:aws:*` は存在しない（ルートのみ）ので、削除対象の所在を取り違えないこと。
- **理由:** AC-3 / AC-4。

### 9. 撤去したランタイム専用の依存を外し、lockfile を更新する

- **対象ファイル:** `packages/core/package.json`、`apps/web/package.json`、`pnpm-lock.yaml`
- **変更内容:**
  - `packages/core`: `@aws-sdk/client-lambda` / `@aws-sdk/client-secrets-manager` / `@aws-sdk/client-sqs` / `@google-cloud/pubsub` / `@google-cloud/secret-manager` / `@libsql/client` / `google-auth-library` を削除。`drizzle-orm` / `uuid` / `zod` は残す。
  - `apps/web`: 上記7件 + `@hono/node-server` / `@types/aws-lambda` を削除（計9件）。`dotenv`（`listen.node.ts` / `migrate.*.ts` 専用だった）と `tsx`（`listen.node.ts` / `migrate.*.ts` 専用。`render-wrangler.ts` は `@repo/infra-cloudflare` の自前 `tsx` devDependency から `tsx ../../../apps/web/scripts/render-wrangler.ts` として起動される）は、削除後に他の参照が残っていないことを確認してから外す。`drizzle-kit` は `db:generate:cf` で必要なので残す。
    - **`tsx` を外すときの注記:** `render-wrangler.ts` の1行目は `#!/usr/bin/env tsx` なので、`apps/web` 側から直接実行する経路（`./scripts/render-wrangler.ts`）は壊れる。現状そういう呼び出し経路は無いので許容するが、後から迷わないよう記録しておく。
  - **ルート `esbuild` devDependency は削除して検証する。** 判定に `pnpm why esbuild` は使わない — 実測すると `vite` / `tsx` / `wrangler` / `@cloudflare/vitest-pool-workers` / `vitest` 経由の推移依存を大量に返すため「他に必要とするものがなければ削除」という条件は常に偽になり、判断材料にならない。根拠にするのは `infra/aws/lib/appStack.ts:34` の `NodejsFunction` import と `:110-111` のコメント（「NodejsFunction's esbuild bundler auto-discovers tsconfig」）で、ルート `esbuild` は `infra/aws` 用だった蓋然性が高い。手順は「削除 → `pnpm install` → `pnpm build:cf` → `pnpm test:unit` / `pnpm test:integration`」で、ここで落ちたら**戻す**。`pnpm-workspace.yaml` の `allowBuilds.esbuild: true` は vite が transitive に持つ esbuild にも効くので**一緒に消さない**。
  - **コミット粒度と lockfile の往復回数（ADR-004 と揃える）:** ルート `esbuild` の削除は**独立したコミット**にする。したがって `pnpm install` はこのステップ内で **2 回**走る（① 上記9依存 + ワークスペース削除で1回、② `esbuild` 削除で1回）。「lockfile の往復を1回に抑える」よりも「落ちたときに revert する対象が1コミットに閉じている」ことを優先する — 誤削除はビルド不能を招くうえ、`esbuild` は AC に現れない派生作業なので単独で切り戻せる形にしておく価値が高い。**2回の `pnpm install` はこのステップ内で連続して行い、間に他の作業を挟まない**（lockfile のコンフリクト面が広いというリスクへの対処）。
  - 上記 ① の時点で `pnpm install` を実行して `pnpm-lock.yaml` を再生成する。
- **理由:** AC-2 / AC-9。ワークスペース削除と依存削除は同じコミットにまとめる（別々にすると lockfile が余計に往復する）。

### 10. vitest 設定を Workers プール単独にする

- **対象ファイル:** `vitest.config.integration.node.ts`（削除）、`vitest.config.integration.ts`（編集）
- **変更内容:** `vitest.config.integration.node.ts` を削除（include の3パターンすべてが消えるため空になる。うち `packages/core/src/adapters/node/__tests__/**/*.integration.test.ts` は現時点でもマッチ0件＝実効2パターンだが、結論は変わらない）。`vitest.config.integration.ts` の `exclude` から `"packages/core/src/adapters/libsql/**"` / `"packages/core/src/adapters/node/**"` / `"apps/web/app/worker/node/**"` の3行と、その直前の `// The libSQL adapter and the in-process worker runner have their` で始まるコメントブロックを削除する。`exclude` の `**/node_modules/**` / `**/dist/**` / `**/.direnv/**` は残す。`include` の3パターン（`worker/cloudflare` / `adapters/d1` / `application`）は無変更。`vitest.config.ts`（unit）は無変更。
- **理由:** Issue 対応項目6。AC-7 / **AC-12**（`vitest.config.integration.node.ts` の削除は AC-7 では検出できない——`test:integration` から呼ばれなくなるので残置してもコマンドは通る）。

### 11. `.gitignore` を整理する

- **対象ファイル:** `.gitignore`
- **変更内容:** 「# Node runtime」ブロックのうち `data/` を削除。`.env` / `.env.*` は vite が読む余地があるので残すが、`!.env.example` / `!.env.*.example` は対象ファイルが消えるので削除し、ブロックの見出しコメントを実態に合わせる。`*.db` / `*.db-shm` / `*.db-wal` は D1 のローカル state で発生しうるので残す。
- **理由:** AC-10。存在しないファイルの否定パターンが残ると、後から `.env.example` を作った人が意図せず commit してしまう。

### 12. docs を整理する

- **対象ファイル:** `docs/runtime_node.md` / `docs/runtime_aws.md` / `docs/runtime_gcp.md`（削除）、`docs/test.md`、`docs/backend_implementation_example.md`、`docs/runtime_cloudflare.md`、`README.md`
- **変更内容:** 位置は**節名＋現行の引用文字列**で指定する（同一ファイル内で先に消すと以降の行番号がずれるため）。
  - `docs/runtime_{node,aws,gcp}.md` を削除。
  - `docs/test.md`:
    - **Integration (`pnpm test:integration`)** 節 — `- **Dependencies**: real SQLite through two pools. Cloudflare tests use an in-memory Miniflare D1 binding; Node tests create isolated temporary libSQL databases and close each client during teardown.` を Workers プール単独（Miniflare D1 binding のみ）に書き換える。
    - **Real DB test (integration) policy** 節 — `` - `pnpm test:integration:node` runs libSQL adapter and Node worker-runner tests through … `` の行と `- The libSQL adapter and the Node worker runner can't run in a Workers isolate, so they have a second integration config: …` の行を**2行とも削除**。
    - **Timeout / flakiness** 節 — `set it in the runtime-specific integration config rather than slowing the unit suite` の「runtime-specific」を単数化（`vitest.config.integration.ts` 名指しでよい）。
    - **Commands** 表 — `` | Integration only (both pools) | `pnpm test:integration` | `` の見出しを `Integration only` 等に（**★ 初版で漏れていた。"both pools" はステップ16 の旧 grep パターンでは一切拾えない**）、`` | Integration, Node pool + libSQL | `pnpm test:integration:node` | `` の行を削除。
  - `docs/backend_implementation_example.md`: ディレクトリツリーの `│   ├── di/serverNode.ts           createNodeRequestContainer, …` 行を削除し、直上の `di/serverCloudflare.ts` 行末の `(CF runtime)` 注記を落として単一の合成ルートとして読める形にする。
  - `docs/runtime_cloudflare.md`:
    - 冒頭の `` See [`runtime_node.md`](./runtime_node.md) for the standalone runtime … `` 段落を削除。
    - TOC の `- [D1-specific behaviour and the libSQL diff](#d1-specific-behaviour-and-the-libsql-diff)` と `## D1-specific behaviour and the libSQL diff` 節全体（比較表と `libSQL exposes an interactive transaction("write", fn) API` の段落を含む）を削除。
    - `` documented in `apps/web/.env.example` — the schema is shared with the Node runtime via … `` を、`wrangler.toml` の **`[env.relay.vars]`（`OUTBOX_BATCH_SIZE` / `OUTBOX_LEASE_MS` / `OUTBOX_MAX_ATTEMPTS`）と `[env.pruner.vars]`（`OUTBOX_RETENTION_MS`）の両方**を指す形に差し替える（実測では4変数は1箇所にまとまっていない）。
    - `` (Bare `pnpm db:generate` targets the libSQL runtime, matching `pnpm db:migrate`.) `` と `` `pnpm db:migrate:cf` is an alias of `db:apply:local` for parity with the Node runtime's `pnpm db:migrate`. `` を、新しいスクリプト構成（bare が `:cf` のエイリアス）に合わせて修正。
    - **「Quick start に『`pnpm start` は `wrangler dev` を起動する』旨を一行添える」という初版の指示は撤回する。** `wrangler dev` は本 Issue 以前から起動できない（H-8 / 「既存実装の状態」参照）ので、動かないコマンドの案内を新設することになる。`pnpm start` については docs に**何も追記しない**。
    - **D1 前提の記述自体は残す**（DO 化は #38）。
  - `README.md`:
    - ツリーの `│  └─ server.*.ts   # server fetch entries` を `server.cloudflare.ts` に、`└─ scripts/         # migration and production launcher scripts` を実態（撤去後は `render-wrangler.ts` 1本）に（**★ 初版で漏れていた**）。
    - `infra/                # aws (CDK, workspace member), cloudflare (Pulumi), gcp (Terraform)` を `cloudflare (Pulumi)` のみに。
    - `docs/                 # implementation pattern examples + runtime guides` を実態に（**★ 漏れていた**）。
    - `## Reference runtimes` 節（`four reference runtime wirings` 〜 `Per-runtime operational guidance:` のリンク行まで）を Cloudflare 単独に書き換え、削除した `docs/runtime_{node,aws,gcp}.md` への Markdown リンク3本を消す。
    - `## Requirements` の `The matching cloud CLI/account only for runtimes you keep` を Cloudflare 前提に。
    - `## Quick Start` 節 — `The default scripts target the Node runtime.` / `cp apps/web/.env.example apps/web/.env` / `pnpm db:migrate   # creates apps/web/data/app.db` / `If you want to try the Cloudflare wiring instead` を Cloudflare 手順に置き換える。**放置すると README のとおりにやると必ず失敗する**（`.env.example` は削除済み、`db:migrate` は D1 を指すようになる）。
    - `## Development commands` のスクリプト表から `dev:node` / `dev:gcp` / `build:{node,aws,gcp}` / `start:node`（`@hono/node-server`）を削除し、`alias of pnpm dev:node` 等の注記を `:cf` に直す。
    - `## Database migrations` 節 — `Migration SQL is generated from `schema.ts`, committed, and shared across the reference runtimes.` の複数ランタイム前提と、`` pnpm db:generate  # generate libSQL SQL (alias of db:generate:node) `` / `pnpm db:migrate   # apply to local libSQL …` を D1 単独に書き換える。
- **理由:** AC-6 / AC-8。README は Issue の項目に明示されていないが、削除する3つの docs へのリンクを持っており、かつ Quick Start が削除済みファイル・スクリプトを指示しているので放置できない。

### 13. `CLAUDE.md` から撤去したランタイムの記述を消す

- **対象ファイル:** `CLAUDE.md`
- **変更内容:** 位置は節名＋引用文字列で指定する。
  - **Workspace layout** 節 — `` - `infra/aws` (`@repo/infra-aws`) — CDK stack. `` と `` - `infra/gcp` — Terraform only; … `` の2行を削除。`apps/web` の説明にある `per-runtime server entries and workers` を単数形（`the Cloudflare server entry and workers`）に。**同じ行（`CLAUDE.md:19`）の `all runtime configs (vite / wrangler / drizzle / Dockerfile)` から `Dockerfile` も落とす**（★2周目で追加 — `apps/web/Dockerfile.gcp` はステップ7 で削除され、`apps/web` に Dockerfile は1本も残らない。ルートの `.dockerignore` も消える）。**この行は2箇所直すことになる**ので、片方だけ直して終わらせないこと。
  - **Reference runtimes** 節 — `The template ships four reference runtime wirings … **Pick one and delete the others**, or keep multiple …` の段落、`**Node**:` / `**AWS**:` / `**GCP**:` の3エントリ行、`Per-runtime operational guidance lives in `docs/runtime_node.md`, …` の `docs/runtime_{node,aws,gcp}.md` 参照と `The Node runtime is the default for `pnpm dev` / `pnpm build` / `pnpm start`; the other runtimes use the `:cf`, `:aws`, and `:gcp` suffixes.`、`Existing adapters can usually be reused across runtimes (libSQL works on Lambda / Cloud Run unchanged)` を削除・修正する。
  - 同節末尾の `To target a different runtime (Cloud Run, Fly Machines, etc.)` の例示から `Cloud Run` を外す（README は `(Bun, Fly Machines, etc.)` になっており、そちらに揃えれば撤去漏れ grep の `Cloud Run` パターンが 0 件に収束する）。
- **変更内容の注記:** DO 構成への全面書き換えは #35 の担当。本 Issue では「撤去したファイルへの参照が残らない」ことだけを保証し、D1 / Outbox / relay の記述には手を付けない。
- **理由:** AC-8。Issue 対応項目7。

### 14. CI から撤去したランタイムのジョブを削除する

- **対象ファイル:** `.github/workflows/ci.yml`
- **変更内容:** `integration` ジョブの matrix `[cf, node]` → `cf` 単独。`build` ジョブの matrix `[cf, node, aws, gcp]` → `cf` 単独。matrix が1要素になるのでジョブ名の `(${{ matrix.runtime }})` ごと畳んで、`pnpm test:integration:cf` / `pnpm build:cf` の直呼びにする（matrix を残すと将来の1要素 matrix が誤解を招く）。`lint-typecheck-unit` ジョブは無変更。
- **完了確認（★2周目で追加）:** 次がヒット0件であること。ステップ16-9 の全文検索は ci.yml の matrix 定義（`runtime: [cf, node]` / `pnpm build:${{ matrix.runtime }}`）を構造上ほとんど拾えないため、**CI は専用チェックで担保する**（16-12 に同じコマンドを再掲）。

  ```
  grep -nE 'runtime:|matrix\.runtime|:(node|aws|gcp)\b' .github/workflows/ci.yml
  ```

  **現状6行ヒット**（`:46,52,69,72,78,95`）、**畳んだ後は0件**になることを実測で確認済み（畳んだ ci.yml の写しを作って実行）。`\b(node|aws|gcp)\b` のような広いパターンは `actions/setup-node@v4` / `node-version: 22` に恒久ヒットして0件にならないので使わない（実測: 現状でも8行ヒットし、うち6行は撤去後も残る）。
- **理由:** AC-6。削除済みスクリプトを呼ぶジョブは即座に CI を赤にする（事後的な backstop）が、それは AC の検証手段ではないので機械的チェックを別に置く。

### 15. 関連 Issue にコメントする

- **対象ファイル:** なし（`gh issue comment`）
- **変更内容:**
  - **#26** — 「GCP `/prune` の無認証は本 Issue（#36）の GCP ランタイム撤去により該当実装が消滅し解消。残るのは D1 の OCC 競合誤帰属のみ」旨をコメントする。**あわせて H-7 を明記する**（★2周目で追加）: #26 項目2 の根拠になっていた「libSQL 側の正しい実装」＝ `adapters/libsql/pendingBatch.ts` の `addOcc(write, onConflict)`（文ごとに conflict handler を保持）**が本 Issue で削除される**こと、対する `adapters/d1/pendingBatch.ts:95` の `firstConflictHandler()` が先頭の handler を返すのが誤帰属の実体であること。**D1 分は残るが、正しい実装の参照先は消える**ので、修正時は per-statement handler の設計を再構成する必要がある。
  - **#37** — 引き継ぎ項目 H-1〜H-6 と H-8（本計画の表）をコメントする。特に次を明示する。
    - H-2: `RelayTrigger` ポート実装のテストがリポジトリ全体でゼロになる。
    - H-4: relay → queue → consumer の一気通貫 E2E が無い。
    - H-5(b): d1 側に「UoW 経路で `_occ_guard` が空」を検証するテストが無い（libsql 撤去で唯一の担保が消える）。
    - H-6: `EventDispatcher` の実装が `packages/core/src/adapters/` からゼロになり、唯一の実装が `apps/web/app/worker/cloudflare/handlers.ts` にインライン化される。
    - H-8: `pnpm start`（`start:cf` = `wrangler dev`）が**本 Issue 以前から起動不能**である。⚠️ **初回コメントに書いた原因（`main` が TS ソースを指すため esbuild が解決できない）は誤りだったので、訂正コメントを追記済み。** 正しくはビルドは成功し、`packages/core/src/application/workers/eventRelayWorker.ts:97` の module-scope `crypto.randomUUID()` により workerd の起動が拒否される。**追跡先は Issue #40**（https://github.com/tuanemuy/fog/issues/40 ）。#37 の対応項目8（`main` を `dist/server/index.js` へ）は redirect 設定が無い経路のために依然必要だが、それだけでは `wrangler dev` は直らない旨も併記する。
    - あわせて「`SecretsLoader` は共通ポートではなく AWS / GCP 固有ユーティリティだったので撤去で概念ごと消える／`QueueDispatcher` というポートは元から存在しない」ことを書く。#37 が「#36 で維持されたはずのポート」を探して見つからない事故を防ぐ。
  - **#35（★3周目で追加）** — 「本 Issue で `CLAUDE.md` の **Reference runtimes 節が Cloudflare 単独に縮み**、libSQL / Turso アダプター（`packages/core/src/adapters/{libsql,aws,gcp,node}/`）は実体ごと消えた」旨を1コメント残す。理由は **`spec/database/index.md:3` が `CLAUDE.md` の「Reference runtimes」節を名指しで参照している**こと（本 Issue のステップ13 がその節を大幅に縮める）。あわせて `spec/database/index.md:341,349,350` と `spec/inventory/adapter.md:22` に libSQL / Turso 前提が残っている（実測）ことも書き添える。`spec/` 本体の改訂は #35 の担当でスコープ外（本 Issue では触らない）だが、**#35 が上流から一貫改訂するときの起点を明示しておく**のが目的。コスト1コメント。
- **理由:** AC-5 / AC-11。Issue 対応項目8（#35 宛ては派生 — `spec/` を触らない代わりに参照の破れを引き継ぎ先へ渡す）。

### 16. 検証する

- **対象ファイル:** なし
- **変更内容:** 次を順に実行して全部通ることを確認する。
  1. `pnpm install`（lockfile が更新されること）→ 更新された `pnpm-lock.yaml` をコミット → `pnpm install --frozen-lockfile`（**CI の3ジョブすべてがこちらを使う**。lockfile とマニフェストの不整合はこちらでしか落ちない。AC-2）
  2. `pnpm typecheck`
  3. `pnpm lint:fix && pnpm format`
  4. `pnpm test:unit`
  5. `pnpm test:integration`（= `test:integration:cf` 単独になっていること）
  6. `pnpm build`（Cloudflare 構成でビルドされること）
  7. **`pnpm start` は「スクリプト定義が Cloudflare 構成を指していること」だけを確認する（実行しない）。** `apps/web/package.json` の `"start": "pnpm start:cf"` と `"start:cf": "wrangler dev"`、およびルート `package.json` の委譲を目視で確認する。**初版にあった「起動して応答することを確認する」は削除した** — `wrangler dev` は本 Issue 以前から起動できないため（実測: バンドル生成は成功するが workerd が `Disallowed operation called within global scope.` で起動を拒否する。原因は `packages/core/src/application/workers/eventRelayWorker.ts:97` の module-scope `crypto.randomUUID()`。⚠️ 当初ここに書いていた「`Build failed with 9 errors`／仮想モジュール3件の解決不能」は誤診断で訂正済み）。詳細と扱いは「既存実装の状態」の該当ブロックと H-8、リスク節、および Issue #40 を参照。AC-3。
  8. `pnpm dev` を起動してトップページが表示されること（AC-3 のうち実行検証する2つのうちの1つ。もう1つは 6. の `pnpm build`）。
     **判定基準（★3周目で明確化）:** 本アプリはログイン必須なので、未認証で `http://localhost:3000/` を叩くと **HTTP 307 で `/login` にリダイレクトされるのが正常**（`apps/web/app/routes/_app.tsx` の `beforeLoad` が `redirect({ to: "/login" })` を投げる）。HEAD でも同じ 307 を返すことを実測済み（上の「HEAD 時点のベースライン実測」）。**307 を撤去による退行と誤認して調査に入らないこと。** ブラウザで開いた場合はログイン画面が描画されれば合格。`curl -i http://localhost:3000/` なら `HTTP/1.1 307` + `location: /login` が期待値。
  9. **撤去漏れの全文検索（強化版・2周目で修正）** — 旧版のパターンはパス・識別子形しか拾わず、`README.md` / `docs/runtime_cloudflare.md` に対して**実測ヒット0件**で AC-6 / AC-8 の検証手段になっていなかった。さらに1周目の強化版は `all four` が `CLAUDE.md:52` の「4**レイヤー**」の記述（本 Issue で絶対に触ってはいけない行）に恒久ヒットして**ヒット0件に到達できなかった**。次のコマンドに差し替える。

     ```
     grep -rnE 'serverNode|serverAws|serverGcp|adapters/(libsql|node|aws|gcp)|server\.(node|aws|gcp)|worker/(node|aws|gcp)|infra/(aws|gcp)|infra-aws|drizzle\.libsql|listen\.(node|gcp)|migrate\.(node|aws|gcp)|vite\.config\.(node|aws|gcp)|Dockerfile|integration\.node|runtime_(node|aws|gcp)|libsql|libSQL|Turso|hono/node-server|@aws-sdk|@google-cloud|google-auth-library|aws-lambda|aws-cdk|\.env(\.aws|\.gcp)?\.example|data/app\.db|two pools|both pools|Node pool|both runtimes|Node, AWS and GCP|four (reference )?runtimes?|all four (reference )?runtimes?|all four *$|matrix\.runtime|dev:node|dev:gcp|build:(node|aws|gcp)|start:(node|gcp)|db:(migrate|generate):(node|aws|gcp)|test:integration:node|deploy:aws|Cloud Run|AWS Lambda|Pub/Sub' . \
       --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
       --exclude-dir=.output --exclude-dir=.wrangler --exclude-dir=.direnv \
       --exclude-dir=.issue --exclude-dir=.thread --exclude-dir=.artifacts \
       --exclude-dir=spec --exclude=pnpm-lock.yaml
     ```

     **1周目からの差分（すべて実行して確認済み）:**

     | 変更 | 理由と実測 |
     |---|---|
     | `all four` → `all four (reference )?runtimes?\|all four *$` | `all four` 単体は `CLAUDE.md:52`（`lets all four layers depend on it`）に**恒久ヒット**する。狭めた形での実測ヒットは `hmacSessionCodec.ts:49`（`all four runtimes`）と `pbkdf2PasswordHasher.ts:139`（行末が `so all four`——なので行末形 `all four *$` が必要）の**2件だけ**で、どちらもステップ5 の編集対象。`CLAUDE.md:52` はヒットしないことを確認済み |
     | `Dockerfile\.gcp` → `Dockerfile` | `CLAUDE.md:19` の `all runtime configs (vite / wrangler / drizzle / Dockerfile)` を拾うため（arch S-001 / ステップ13）。実測ヒットは `CLAUDE.md:19` と削除対象ファイル群のみ |
     | `matrix\.runtime` を追加 | 旧パターンは `.github/workflows/ci.yml` を**1件も拾わなかった**。これで ci.yml が全文検索側にも現れる（機械的検証の本体は 12. の専用チェック） |
     | `both runtimes\|Node, AWS and GCP` を追加 | `di/env.ts:9`（`shared by both runtimes`）と `di/secrets.ts:50`（`Node, AWS and GCP build that config`）は旧パターンでは拾えなかった。どちらもステップ5 の編集対象で、撤去後は0件になる |

     **期待値: ヒット0件。** 現状（撤去前）は **79 ファイル**がヒットすることを実測済み。うち削除対象ファイル自身を除いた「編集で潰す側」は `.dockerignore` / `.gitignore` / `CLAUDE.md` / `README.md` / `docs/{test,runtime_cloudflare,backend_implementation_example}.md` / `package.json` 3種 / `pnpm-workspace.yaml` / `vitest.config.integration.ts` / `.github/workflows/ci.yml` / `di/{containerStore,env,secrets,serverCloudflare}.ts` / `di/__tests__/requestContainerConfig.test.ts` / `webcrypto/{hmacSessionCodec,pbkdf2PasswordHasher}.ts` / `application/identity/__tests__/identity.integration.test.ts` で、**すべて本計画の編集対象表に載っている**。

     除外の理由: `.issue/` は当時の作業ログ、`.thread/` は本計画自身、`spec/` は #35 の担当、`pnpm-lock.yaml` はパッケージ名で常時ノイズが出るため（lockfile は 10. で個別に検証する）。
  10. **AC-9 専用の依存残存チェック（2周目で修正）** — 初版は `pnpm-lock.yaml` も同じ grep に含めて「ヒット0件」を求めていたが、**これは原理的に達成不可能**（`drizzle-orm@0.45.2` の `peerDependencies` / `peerDependenciesMeta` が `'@aws-sdk/client-rds-data'` / `'@libsql/client'` / `'@libsql/client-wasm'` を恒久宣言する。AC-9 の注記を参照）。次の2本に分ける。

      (a) `package.json` 3件 — **ヒット0件**（現状: ルート 0 / `apps/web` 9 / `packages/core` 7）:

      ```
      grep -nE '@aws-sdk|@google-cloud|@libsql|google-auth-library|hono/node-server|aws-lambda|aws-cdk' \
        package.json apps/web/package.json packages/core/package.json
      ```

      (b) `pnpm-lock.yaml` の `importers:` セクション — **ヒット0件**（現状: 20 行）:

      ```
      awk '/^importers:/{f=1} /^packages:/{f=0} f' pnpm-lock.yaml \
        | grep -nE '@aws-sdk|@google-cloud|@libsql|google-auth-library|hono/node-server|aws-lambda|aws-cdk'
      ```

      **既知の許容ヒット**: lockfile 全体では撤去後も **6 行**残る（すべて `packages:` セクションの `drizzle-orm@0.45.2` ブロック内の optional peer 宣言）。HEAD のコピーで9依存と `infra/aws` を落として `pnpm install --lockfile-only` を実行し、全体 192 行 → 6 行 / `importers:` 20 行 → 0 行になることを実測確認済み。**この6行以外が lockfile に残っていたら撤去漏れ**とみなす。
      `dotenv` / `tsx`（`apps/web`）とルート `esbuild` はステップ9の判断次第なので、このパターンには含めず個別に確認する。
  11. **層分離の検証（★3周目で `git status` からブランチ差分に変更）** — ステップ9 が「`esbuild` の削除は独立コミット」「lockfile をコミットしてから `--frozen-lockfile`」と指示している以上、ステップ16 に到達した時点で作業の大半は**コミット済み**になる。`git status` は HEAD との差分しか見ないので、**コミット済みの変更は1件も表示されず検証が空振りで「合格」してしまう**。さらに #34 系の未追跡ファイル `apps/web/wrangler.{request,state}.{staging,production}.toml` が `.gitignore` に無く `git status` に常時現れるため、目視確認はノイズも拾う。ブランチ差分で判定する:

      ```
      git diff --stat main...HEAD -- packages/core/src/domain/
      git diff --stat main...HEAD -- apps/web/app/presentation/
      git diff --stat main...HEAD -- packages/core/src/application/
      ```

      - `packages/core/src/domain/` — **出力が空**であること。差分が1行でも出たら撤去の切り口が間違っている。
      - `apps/web/app/presentation/` — **出力が空**であること。
      - `packages/core/src/application/` — 差分が出るのは `di/`（`serverNode.ts` / `serverAws.ts` / `serverGcp.ts` の削除、`containerStore.ts` / `secrets.ts` / `env.ts` / `serverCloudflare.ts` の JSDoc、`__tests__/requestContainerConfig.test.ts`）と `identity/__tests__/identity.integration.test.ts` のコメント1行**だけ**であること。それ以外のパスが出たら要調査。
      - 作業ブランチが `main` から分岐していない場合は `main...HEAD` を実際の分岐元に読み替える。
  12. **CI 専用の撤去漏れチェック（2周目で新設。AC-6 の CI 側の機械的検証）** — 9. の全文検索は ci.yml の matrix 定義を構造上ほとんど拾えないため別立てにする。**現状6行ヒット / 畳んだ後0件**を実測確認済み（ステップ14 の完了確認と同一）:

      ```
      grep -nE 'runtime:|matrix\.runtime|:(node|aws|gcp)\b' .github/workflows/ci.yml
      ```

      `\b(node|aws|gcp)\b` のような広いパターンは `actions/setup-node@v4` / `node-version: 22` に恒久ヒットするので**使わない**（実測: 現状8行ヒットのうち6行は撤去後も残る）。
- **理由:** AC-7 と全 AC の最終確認。

## 設計判断

`.thread/36/adr.md` に記録する。

- **ADR-001** — `:cf` サフィックスを維持したまま bare スクリプトをエイリアス化する（フラット化は #37 に委ねる）。あわせて `start` = `wrangler dev` の意味論のねじれをどう扱うか。**2周目で更新**: `start:cf` が本 Issue 以前から起動不能である実測を受け、`start` をエイリアスにする決定は維持しつつ**理由を差し替え**、AC-3 の検証をスクリプト定義の確認に緩め、「`pnpm start` を実行して検証」という 1周目の追記を撤回した。
- **ADR-002** — `vitest.config.integration.node.ts` を削除して統合テストを Workers プール単独にする（Node プール統合テストの枠自体を捨てる）。
- **ADR-003** — `requestContainerConfig.test.ts` の4ランタイム `describe.each` を削除せず cloudflare 1件に縮めて維持する。
- **ADR-004** — ルート `esbuild` devDependency は `pnpm why` ではなく `infra/aws/lib/appStack.ts` の `NodejsFunction` を根拠に「削除して検証」で決着させる。`allowBuilds.esbuild` は残す。**2周目で更新**: コミット粒度を「独立コミット＝ステップ9 内で `pnpm install` が2回走ることを受け入れる（ただし連続実行）」で確定し、ステップ9・リスク節と文言を揃えた。

## リスクと注意点

- **`RelayTrigger` ポート実装のテストがリポジトリ全体でゼロになる** — `InProcessRelayTrigger` のテストを消すと、残る `ServiceBindingRelayTrigger` は元々ノーテストなので実装テストが1つもない状態になる。#37 で DO Alarm に置き換わる前提で受け入れるが、#37 が遅延した場合は無防備な期間が延びる（H-2 として #37 にコメント）。
- **`pnpm start`（= `start:cf` = `wrangler dev`）は本 Issue 以前から起動できない（既存の欠陥・本 Issue では直さない）** — ⚠️ **当初ここに書いていた原因は誤りだった（訂正済み。詳細は「本 Issue 以前から壊れており、本 Issue では直さない点」ブロックと H-8 を参照）。** 正しくは **ビルドは成功し、workerd の起動時に落ちる**: `packages/core/src/application/workers/eventRelayWorker.ts:97` の `const RELAY_WORKER_ID = crypto.randomUUID();` がモジュールスコープで評価されるため、workerd が `Disallowed operation called within global scope.` を投げて `The Workers runtime failed to start.` となる。`pnpm preview` も同一原因。**撤去が原因ではないので本 Issue のスコープでは直さない**。対処:
  - AC-3 の検証は「`package.json` のスクリプト定義が Cloudflare 構成を指していること」＋ `pnpm dev` / `pnpm build` の実行に限定する（ステップ16-7）。
  - `docs/runtime_cloudflare.md` の Quick start に `pnpm start` の案内を**追記しない**（初版のステップ12 の指示は撤回）。
  - H-8 として #37 に引き継いだうえで、**追跡先は Issue #40 へ移した**（https://github.com/tuanemuy/fog/issues/40 ）。修正対象は `eventRelayWorker.ts` の module-scope 乱数生成であって `wrangler*.toml` ではない。`main` を `dist/server/index.js` に直す修正（#37 の対応項目8）は redirect 設定が無い経路のために依然必要だが、それだけでは `wrangler dev` は直らない。`.tpl` に手を入れると #37 との衝突面が広がるので、`main` の修正は #37 の `wrangler*.toml` 書き換えに合流させるほうが安全。
- **`pnpm-lock.yaml` の再生成でコンフリクト面が広くなる** — ワークスペースメンバー削除と依存削除で lockfile が大きく変わる。並行して進む #34 / #35 は docs / spec 中心なので衝突は小さいが、他ブランチとのマージ順序に注意する。ステップ9 では `pnpm install` が **2 回**走る（依存9件 + ワークスペース削除で1回、`esbuild` 削除で1回）。この2回は連続して実行し、間に他の作業を挟まない。
- **`predev:cf` の発火タイミング（結論: 追加作業なし）** — `dev` を `pnpm dev:cf` のエイリアスにすると、pnpm の pre スクリプトは子プロセスの `dev:cf` 実行時に発火するので `wrangler types` は走る（pnpm 11.1.2・`.npmrc` なしで実測確認済み）。**`predev` を足すと二重実行になるので足さない。** ただし `postinstall` の `wrangler types` は `wrangler.toml` を必要とするため、依存整理後の `pnpm install` で失敗しないことは確認する。
- **`.dockerignore` の削除** — ルートの `.dockerignore` は `Dockerfile.gcp` 専用だが、将来 Cloudflare 以外でコンテナを作る可能性を潰す。ただし今の方針（Cloudflare 単独）では不要であり、必要になった時点で作り直す方が正確。
- **ルート `esbuild` devDependency（Issue の対応項目にも受け入れ条件にも無い派生作業）** — 判定に `pnpm why` を使わない（推移依存を大量に返すので常に「必要」と読めてしまい、判断材料にならない）。`infra/aws/lib/appStack.ts` の `NodejsFunction` を根拠に「`infra/aws` 用だった」と判断して**削除し、`pnpm install` → `pnpm build:cf` → テストで検証する**。落ちたら戻せるよう、esbuild 削除は**独立したコミット**にしておく（＝ステップ9 内で lockfile が2往復するのを受け入れる。ADR-004 と揃える）。**検証で落ちたら戻す＝残したままでも Issue の受け入れ条件は満たす**ので、削除に固執して往復を増やさないこと。`allowBuilds.esbuild` は消さない。
- **`tsx` を `apps/web` から外すことの副作用** — `render-wrangler.ts` の shebang は `#!/usr/bin/env tsx` なので、`apps/web` 側から直接実行する経路は壊れる（現状そういう呼び出しは無い）。`@repo/infra-cloudflare` の `render` 経由は自前の `tsx` で動くので影響なし。
- **`docs/runtime_cloudflare.md` への介入範囲** — DO 化は #38 の担当なので、D1 前提の記述には手を付けない。触るのは「削除したファイル・スクリプトを指す記述」だけ、という線引きを守る。過剰に書き換えると #38 と衝突する。
- **`spec/` を触らない** — `spec/database/index.md` / `spec/inventory/adapter.md` に libSQL / Turso 前提が残るが、#35 の担当。本 Issue で先に手を入れると #35 の上流からの一貫改訂と衝突する。撤去漏れ検索でも `spec/` を除外する。
- **`.thread/1/` を触らない** — 当時の作業ログであり改変対象ではない。ADR-004 の supersede は #34 の担当。

## テスト方針

本 Issue は撤去なので新規テストは書かない。既存テストが「撤去後の構成でも通る」ことを担保する。

- **unit（`pnpm test:unit`）** — `adapters/node/__tests__/` の2ファイルが減る以外、件数は変わらないこと。`domain/` / `application/`（DI 除く）/ `webcrypto` / `presentation` のテストは1件も減らないこと。
- **integration（`pnpm test:integration`）** — `test:integration:cf` 単独になり、`adapters/d1/__tests__/` 6ファイル・`worker/cloudflare/__tests__/handlers.integration.test.ts`・`application/**/*.integration.test.ts` が全件通ること。libsql 側の 32 ブロック / 37 ケースのうち、**libSQL 固有経路（interactive transaction）の検証と occGuard の UoW 経路検証を除いて d1 側が上位互換**（詳細は「撤去で失われるテストカバレッジと引き継ぎ」節）。
- **DI（`requestContainerConfig.test.ts`）** — cloudflare 1件に縮めた後も「`container.config` が `AppConfig` のキー集合ちょうどであること」「シリアライズした config に session secret が混入しないこと」「usecase から `sessionCodec` に到達できないこと（型テスト）」の3つが残っていること。
- **型・静的検査** — `pnpm typecheck` が「削除したモジュールへの import 残り」を検出する第一の網。`pnpm lint` が未使用 import / 未使用変数を拾う。
- **ビルド** — `pnpm build`（= Cloudflare）が通ること。CI の build matrix が `cf` 単独になっていること。
- **手動確認** — `pnpm dev` でアプリが起動しトップページが表示されること。`pnpm build` と合わせて AC-3 のうち実行検証できる2コマンドを押さえる。**`pnpm start`（= `wrangler dev`）は実行検証の対象外**（本 Issue 以前から起動不能。H-8 / リスク節）。スクリプト定義が `wrangler` を指していることの目視確認に置き換える。
- **撤去漏れ検索** — ステップ16-9 の強化版 grep がヒット0件であること（AC-1 / AC-4 / AC-8 の機械的検証。AC-6 のうち docs 側もここで担保される）。1周目の強化版は `all four` が `CLAUDE.md:52` の「4レイヤー」の記述に恒久ヒットして0件に到達できなかったため、2周目でパターンを絞り込み済み（現状 79 ファイルヒット / 撤去後0件）。
- **CI の撤去漏れチェック** — ステップ16-12 の専用 grep がヒット0件であること（AC-6 の CI 側の機械的検証）。16-9 は ci.yml の matrix 定義を構造上ほとんど拾えないので別立てにしている（現状6行 / 撤去後0件）。
- **依存残存チェック** — ステップ16-10 の (a) `package.json` 3件と (b) `pnpm-lock.yaml` の `importers:` セクションがともにヒット0件であること（AC-9 の機械的検証）。**lockfile 全体でのヒット0件は求めない** — `drizzle-orm` の optional peer 宣言6行は撤去後も残るのが正常（実測確認済み）。
- **JSDoc の残存チェック** — ステップ5の7ファイル向け grep がヒット0件であること。撤去済みランタイムを言及する残存コードは実測で **7ファイル・計12箇所（grep 出力 14 行）** しかないので、全滅させられる。
- **層分離の検証** — `packages/core/src/domain/` と `apps/web/app/presentation/` に差分が0であること。差分が出た場合は撤去の切り口が間違っている。`application/` は `di/` とテストコメント1行（`identity.integration.test.ts`）以外に差分が出ないこと。判定は **`git status` ではなく `git diff --stat main...HEAD -- <パス>`** で行う（ステップ16-11。ステップ16 到達時点で作業の大半はコミット済みなので `git status` は空振りする）。

## レビュー履歴

指摘の台帳は `.thread/36/plan-review/triage.md`。

### 1周目

2視点（要件カバレッジ 11件 / アーキ整合性・リスク 13件）の計 24 件。重複6組（13件）を正規化して **17 件**。**全件を取り込み、見送りはゼロ。**

**修正した点**:

- **P-001（= arch P-002）: `serverCloudflare.ts` の dead JSDoc が編集対象から漏れていた** — 「調査結果 / 参照が残る」表とステップ5の対象に `packages/core/src/application/di/serverCloudflare.ts` を追加。`` Node entry has its own env shape in `./serverNode`. ``（削除するモジュールを名指し）と `SESSION_SECRET` コメントの「他ランタイム」前提の複数形の2箇所を明記した。**撤去後に唯一残る合成ルートの本体が削除済みファイルを指している**という最も避けたい形だったため、backstop の grep 頼みをやめて計画的に潰す。
- **P-002（⊂ arch P-006）: JSDoc / docs の取りこぼし** — `hmacSessionCodec.ts` を1箇所 → 2箇所（`all four runtimes` を追加）、`pbkdf2PasswordHasher.ts` を1箇所 → 2箇所（`MAX_PBKDF2_ITERATIONS` の `a Node worker thread pinned indefinitely` を追加）、`docs/test.md` に `| Integration only (both pools) |` を追加、`README.md` にツリーの `server.*.ts` / `scripts/` / `docs/` の3行を追加。実測で残存箇所は**7ファイル計12箇所**と確定し、ステップ5に1:1 対応する表とチェック用 grep を置いた（現状12箇所ヒットすることを実測確認）。
- **P-003: AC-3 が要求する `pnpm start` の検証手順が無かった** — ステップ16 の `pnpm build` の直後に `pnpm start`（= `wrangler dev`）の起動確認を追加。ADR-001 が「`start` を削除すると受け入れ条件が検証できなくなる」を残す理由にしているのに実際には検証しない、という食い違いを解消した。ADR-001 の Consequences にもその旨を追記。**※ この追加は2周目に撤回した**（`wrangler dev` が本 Issue 以前から起動不能であることが実測で判明したため。2周目 arch P-001 / H-8）。
- **P-004（= arch P-001）: 撤去漏れ grep が検証手段になっていなかった** — 旧パターンを `README.md` / `docs/runtime_cloudflare.md` に対して実行すると**実測ヒット0件**で、AC-6 / AC-8 を何も保証していなかった。`runtime_(node|aws|gcp)` / `libsql|libSQL|Turso` / 依存名 / `both pools|two pools|Node pool` / `four (reference )?runtimes?|all four` / スクリプト名 / `Cloud Run|AWS Lambda|Pub/Sub` などを足した強化版に差し替え、除外に `.direnv` / `.artifacts` / `pnpm-lock.yaml` を追加。**書く前に実行して現状 76 ファイルがヒットすることを確認済み**。加えて AC-9 専用の依存残存チェックを 16-10 として新設（現状 `packages/core` 7件 / `apps/web` 9件ヒットを確認）。**※ この強化版パターンは2周目にさらに修正した**（`all four` が `CLAUDE.md:52` に恒久ヒットして0件に到達できなかった／ci.yml を拾えなかった／lockfile が0件にならなかった）。現行の値は 79 ファイル。
- **P-005（= arch P-005）: `predev:cf` の記述が事実と逆だった** — pnpm 11.1.2 で `"bar": "pnpm foo"` から `prefoo` が発火することを実測確認し、ステップ8を「`predev:cf` はそのまま。`predev` を足すと `wrangler types` が二重実行される」に書き換え。リスク節も同じ結論に揃えた。
- **arch P-003（= coverage S-003 / S-004）: テストカバレッジの主張が実測と食い違っていた** — (a) 件数を実測値（**32 ブロック / 37 ケース**。`outboxRepository` は 12 ではなく 10、`userRepository` は 11 ブロック + `it.each` 6行 = 17 ケース）に訂正（**※ `userRepository` のブロック数は2周目に 11 → 12 で再訂正**）。(b) occGuard は 1:1 対応ではなく、libsql が UoW 経路・d1 が生バッチ経路で、**d1 側に「UoW 経路で `_occ_guard` が空」を検証するテストが無い**ことを明記。(c)「DB 層の喪失はゼロ」を「libSQL 固有経路と occGuard の UoW 経路検証を除き D1 側が上位互換」に緩め、同じ節で H-5 と矛盾していた状態を解消。(d) この穴を H-5(b) として #37 へ引き継ぐ。
- **arch P-004: 存在しないポートについて「壊れない」と宣言していた** — 「あるべきアーキテクチャ」節に実測ベースの表を追加。`application/ports/` は7つ（`Clock` / `IdGenerator` / `IdempotencyStore` / `Logger` / `OutboxRepository` / `RelayTrigger` / `SessionCodec`）で全部、`QueueDispatcher` は存在せず、キュー投入の抽象は `application/workers/eventRelayWorker.ts` の `EventDispatcher`、`SecretsLoader` は共通抽象ではなく AWS / GCP 固有ユーティリティ、と訂正。撤去後 `packages/core/src/adapters/` から `EventDispatcher` 実装がゼロになる構造上の非対称を **H-6** として新設し、ステップ15 の #37 コメントにも反映した（「#36 で維持されたはずのポート」を #37 に探させない）。
- **arch P-006: 上記 P-002 と同一** — 併せて対応。

**取り込んだ改善提案**:

- **S-001（coverage）** — AC-1 の対応ステップを `2, 3, 4, 6` → `2, 3, 4, 5, 6, 7, 16` に修正。ステップ5・7 の「理由」が AC-1 を挙げているのに表から見えなかった。他の AC にも検証ステップ 16 を追加。
- **S-002（coverage）** — AC-4 の括弧内列挙に `test:integration:node` を追加（Issue 対応項目6 由来。チェックリストとして使う想定なので明示）。
- **S-006（coverage）** — docs / README / CLAUDE.md の編集指示を**行番号から「節名＋引用文字列」へ全面的に書き換え**。同一ファイル内で先に削除すると後続行がずれるため。あわせて `docs/runtime_cloudflare.md` の `.env.example` 差し替え先を、実測に基づき `wrangler.toml` の **`[env.relay.vars]` と `[env.pruner.vars]` の両方**に訂正（`OUTBOX_RETENTION_MS` だけ pruner 側にある）。
- **arch S-001** — 実装ステップ冒頭のラベルを「依存方向の順（内側 → 外側）」→「**参照元 → 参照先（外側 → 内側）**」に訂正。順序自体は撤去として正しく、直したのはラベルのみ。
- **arch S-002（coverage S-005 と重複。arch 案を採用）** — ルート `esbuild` の判定を `pnpm why` から実測ベースへ変更。`pnpm why esbuild -r` が推移依存を大量に返して常に「必要」と読めることを確認したうえで、`infra/aws/lib/appStack.ts:34` の `NodejsFunction` import と `:110-111` のコメントを根拠に**削除して `pnpm install` → `pnpm build:cf` → テストで検証する**方針に確定。**ADR-004** として新規に起こした。`allowBuilds.esbuild` は残すことも明記。
- **arch S-003** — ルート `test:integration` を実体コマンドの複製ではなく `"pnpm test:integration:cf"` のエイリアスにする。ADR-001 の方針（`:cf` が実体、bare がエイリアス）と揃い、#37 での書き換えが1行で済む。
- **arch S-004** — ステップ16-1 に `pnpm install --frozen-lockfile` を追加（CI の3ジョブすべてがこれを使い、lockfile とマニフェストの不整合はこちらでしか落ちない）。AC-2 の文言にも反映。
- **arch S-005** — `pnpm-workspace.yaml` の `overrides` / `publicHoistPattern` / `allowBuilds` を「調査済み・変更不要」としてステップ6と「既存実装の状態」に明記。特に `protobufjs: false` が `@google-cloud/pubsub` ではなく `@pulumi/pulumi` → `@grpc/grpc-js` 由来である点（GCP 撤去に巻き込んで消す事故の防止）を実測付きで記録。
- **arch S-006** — `apps/web` から `tsx` を外すと `render-wrangler.ts` の shebang `#!/usr/bin/env tsx` 経由の直接実行が壊れる旨を、ステップ9とリスク節に注記。
- **arch S-007** — AC-9 から `aws-cdk*` を外し、「`infra/aws/package.json` にしか無く、`infra/aws/` 削除（AC-1）でカバーされる」と注記。検証不能な基準になっていた。

**見送った提案とその理由**:

- なし（正規化後 17 件すべてを取り込み）。

### 2周目

2視点（要件カバレッジ 9件 / アーキ整合性・リスク 7件）の計 16 件。重複3組（6件）を正規化して **13 件**。**全件を取り込み、見送りはゼロ。**

**修正した点（P）**:

- **arch P-001: `pnpm start` が起動不能で、AC-3 の検証手順と ADR-001 の根拠が成立しない** — ⚠️ **この項の当時の診断（「ビルド不能」「`Build failed with 9 errors`」「根本原因は `wrangler.toml:13` の `main` が TS ソースを指していること」）は誤りだった。事後の追試で訂正済み** — 正しくは**ビルドは成功し**（78 modules / 1132.07 KiB）、workerd の起動時に `Disallowed operation called within global scope.` で落ちる。原因は `packages/core/src/application/workers/eventRelayWorker.ts:97` の module-scope `crypto.randomUUID()`。追跡先は **Issue #40**（https://github.com/tuanemuy/fog/issues/40 ）。`pnpm start` の経路では `dist/server/wrangler.json` への redirect 設定が使われるため `wrangler.toml` の `main` はそもそも読まれない。**これは本 Issue 以前から存在する欠陥であり撤去のスコープでは直せない**という結論自体は変わらないので、扱いは以下のまま維持する。
  - **AC-3** を「`dev` / `build` / `start` のスクリプト定義が Cloudflare 構成を指していること（`package.json` で確認）＋ `pnpm dev` / `pnpm build` の実行」に緩め、**`pnpm start` の実行成功は基準から外した**。
  - **ステップ16-7** の「起動して応答することを確認する」を「スクリプト定義の目視確認（実行しない）」に差し替え。
  - **ステップ12** の「Quick start に『`pnpm start` は `wrangler dev` を起動する』旨を一行添える」を**撤回**（動かないコマンドの案内になるため）。
  - 「既存実装の状態」に **本 Issue 以前から壊れており本 Issue では直さない点**のブロックを新設し、引き継ぎ表に **H-8** を追加、リスク節にも項目を立てた。**Phase 5 で別 Issue として起票する候補**とした（→ 実際に **Issue #40** として起票済み。H-8 の追跡先はそちら）。
  - **ADR-001** の Consequences から「`pnpm start` を実行して検証」の良い点を撤回し、実測結果と上記方針に書き直した。
- **coverage P-002: AC-9 の「`pnpm-lock.yaml` にヒット0件」が原理的に達成不可能** — `drizzle-orm@0.45.2` の `peerDependencies` / `peerDependenciesMeta` が `'@aws-sdk/client-rds-data'` / `'@libsql/client'` / `'@libsql/client-wasm'` を恒久宣言しているため。**HEAD のコピーで9依存と `infra/aws` を落として `pnpm install --lockfile-only` を実行し、撤去後の実値を確認した**（全体 192 行 → **6 行**、`importers:` セクション 20 行 → **0 行**、`package.json` 3件 → **0 件**）。AC-9 を「`package.json` 3件が0件 かつ `importers:` セクションが0件」に書き換え、残る6行を**既知の許容ヒット**として明記。ステップ16-10 を (a) `package.json` / (b) `awk` で `importers:` を切り出す grep の2本に分割した。
- **coverage P-003 = arch P-002: 撤去漏れ grep が `CLAUDE.md:52` に恒久ヒットして0件にならない** — `all four` が「4**レイヤー**」の記述（本 Issue で絶対に触ってはいけない行）に当たる。`all four (reference )?runtimes?|all four *$` に絞った（`pbkdf2PasswordHasher.ts:139` は行末が `so all four` で改行しているため**行末形が必須**）。**書く前に実行して、絞った形でのヒットが `hmacSessionCodec.ts:49` と `pbkdf2PasswordHasher.ts:139` の2件だけ・`CLAUDE.md:52` は非ヒットであることを確認済み。**
- **coverage P-004 = arch P-003: 同 grep が `.github/workflows/ci.yml` を拾わず AC-6 の CI 側が無検証** — ci.yml を実際に読み、撤去対象が `runtime: [cf, node]` / `${{ matrix.runtime }}` という形であることを確認。**ステップ16-12 として CI 専用チェック `grep -nE 'runtime:|matrix\.runtime|:(node|aws|gcp)\b' .github/workflows/ci.yml` を新設**（ステップ14 の完了確認にも同じものを置いた）。畳んだ後の ci.yml の写しを作って実行し、**現状6行 → 撤去後0件**を確認済み。レビューが提案した `\b(node|aws|gcp)\b` は `actions/setup-node@v4` / `node-version: 22` に恒久ヒットして0件にならないため**採用せず**、狭いパターンにした（この点も実測）。全文検索側には `matrix\.runtime` を足して ci.yml が現れるようにした。
- **coverage P-001: AC 表に Issue 対応項目4・6 の9ファイル分の基準が無かった** — AC-1 の文言が `apps/web/app/` / `packages/core/src/` / `infra/` に限定されており、`apps/web/` 直下（vite config 3 / scripts 5 / `drizzle.libsql.config.ts` / `Dockerfile.gcp`）とルート（`vitest.config.integration.node.ts`）が文言上のスコープ外だった。**AC-12 を新設**し、ステップ7 / 10 / 16 を紐づけた。`vitest.config.integration.node.ts` は AC-7 では検出できない（`test:integration` から呼ばれなくなるので残置しても通る）ことも明記。

**取り込んだ改善提案（S）**:

- **coverage S-001: ステップ5 の「12箇所」と grep 出力行数の食い違い** — 実測すると **7ファイル・14 行**返る（`secrets.ts` と `pbkdf2PasswordHasher.ts` は1つの記述が2行にまたがる）。「**12 箇所 / grep 出力 14 行**」と併記し、ファイル別の行数内訳も記載した。テスト方針の記述も揃えた。
- **coverage S-002 = arch S-002: `userRepository` のブロック数 11 → 12** — 実測で libsql / d1 とも `it(` 11 件 + `it.each` 1 件（6行）= **12 ブロック / 17 ケース**。合計の 32 ブロック（3+2+10+5+12）は 12 を前提にした値なので合計側が正しかった。セルを訂正し、訂正の理由も添えた。
- **coverage S-003: H-7（libSQL の `PendingBatch` 参照実装の喪失）** — 実測で `adapters/libsql/pendingBatch.ts` の `addOcc(write, onConflict)` が**文ごとに** conflict handler を保持するのに対し、`adapters/d1/pendingBatch.ts:95` の `firstConflictHandler()` は先頭の handler を返し `adapters/d1/unitOfWork.ts:109` がそれを使う（＝ #26 の誤帰属の実体）ことを確認。**H-7 を引き継ぎ表に追加**し、ステップ15 の #26 コメントに「D1 分は残るが、正しい実装の参照先（libSQL）は本 Issue で消える」を明記した。失われるのはテストではなく**参照実装**であることも書いた。
- **coverage S-004: ルート `esbuild` 削除が Issue の対応項目にも AC にも無い派生作業である旨の明記** — AC-9 に注記を追加し、「検証で落ちたら戻す＝残しても受け入れ条件は満たす／削除に固執して lockfile の往復を増やさない」と明文化。リスク節にも同じ線を追記。
- **coverage S-005: AC-4 にルート `test:integration` の書き換えが含まれていなかった** — AC-4 の括弧内を「削除するスクリプト」と「更新するスクリプト（ルート `test:integration` → `"pnpm test:integration:cf"`）」に分けて明示。
- **arch S-001: CLAUDE.md の `(vite / wrangler / drizzle / Dockerfile)` から `Dockerfile` を落とす指示が無かった** — ステップ13 に追記し、**同じ行（`CLAUDE.md:19`）を2箇所直す**ことを強調。あわせて全文検索のパターンを `Dockerfile\.gcp` → `Dockerfile` に広げて拾えるようにした（実測でヒットは `CLAUDE.md:19` と削除対象ファイル群のみ）。
- **arch S-003: 「`application` は変更なし」の断定が実態と食い違う** — 実測（`domain/` / `application/` / `presentation/` への横断 grep）で `domain` と `presentation` は0件、`application` のヒットは `di/*` と `identity/__tests__/identity.integration.test.ts` の**コメント1行だけ**であることを確認。「あるべきアーキテクチャ」と「既存実装の状態」の断定を実測に合わせ、ステップ16-11 の判定基準も `domain` の差分0 + `application` は DI とコメント1行以外差分なし、に具体化した。
- **arch S-004: esbuild のコミット粒度が ステップ9 と ADR-004 で食い違って読める** — 「**独立コミット**にする（＝ステップ9 内で `pnpm install` が2回走ることを受け入れる）。ただし2回は連続実行し間に他の作業を挟まない」で確定。ステップ9・リスク節・ADR-004 の3箇所を同じ文言に揃えた。判断根拠は「lockfile の往復1回の節約より、落ちたときに revert 対象が1コミットに閉じることの価値が高い」。
- **（派生）全文検索パターンの穴を1つ追加で塞いだ** — `di/env.ts:9`（`shared by both runtimes`）と `di/secrets.ts:50`（`Node, AWS and GCP build that config`）はステップ5 の編集対象なのに 16-9 のパターンでは拾えなかったため、`both runtimes|Node, AWS and GCP` を追加。実測で恒久ヒットは無く、撤去後0件になる。

**実測のやり直し（今回の修正で根拠にした実行）**:

| 実行 | 結果 |
|---|---|
| `npx wrangler deploy -c wrangler.toml --dry-run`（`apps/web`） | 当時 `Build failed with 9 errors`。⚠️ **これは `node_modules` が `package.json` と乖離した状態での観測で、`pnpm install --frozen-lockfile` 後は `Build failed with 3 errors`（tanstack の仮想モジュール3件のみ）。しかもこのコマンドは `pnpm start` の実行経路ではない**（`pnpm start` は `dist/server/wrangler.json` への redirect 設定を使う）。`pnpm start` の起動不能の真因は Issue #40 を参照 |
| HEAD のコピーで9依存 + `infra/aws` を落として `pnpm install --lockfile-only` | lockfile 全体 192 → **6** 行、`importers:` 20 → **0** 行 |
| 絞った `all four (reference )?runtimes?\|all four *$` | 2件（`hmacSessionCodec.ts:49` / `pbkdf2PasswordHasher.ts:139`）。`CLAUDE.md:52` は非ヒット |
| 修正後の 16-9 全文検索 | **79 ファイル**（`ci.yml` / `di/env.ts` / `di/secrets.ts` が新たに含まれる） |
| `grep -nE 'runtime:\|matrix\.runtime\|:(node\|aws\|gcp)\b' ci.yml` | 現状6行 / 畳んだ写しでは**0件** |
| `\b(node\|aws\|gcp)\b` を ci.yml に適用 | 8行。うち6行（`setup-node` / `node-version`）は撤去後も残る ⇒ 不採用 |
| ステップ5 の JSDoc grep | 7ファイル・**14 行**（`containerStore` 2 / `secrets` 3 / `env` 1 / `serverCloudflare` 2 / `hmacSessionCodec` 2 / `pbkdf2PasswordHasher` 3 / `identity` 1）＝ **12 箇所** |
| `userRepository.integration.test.ts` のブロック数 | libsql / d1 とも `it(` 11 + `it.each` 1（6行）= **12 ブロック / 17 ケース** |
| `domain` / `application` / `presentation` への横断 grep | `domain` 0 / `presentation` 0 / `application` は `di/*` とテストコメント1行のみ |
| `libsql/pendingBatch.ts` vs `d1/pendingBatch.ts` | libsql は `addOcc(write, onConflict)` で文ごとに handler 保持、d1 は `firstConflictHandler()` が先頭を返す（#26 の誤帰属の実体） |

**見送った提案とその理由**:

- なし（正規化後 13 件すべてを取り込み）。ただし提案された**具体的なコマンド案は2件そのままでは採らなかった**（どちらも実行して不成立を確認したため、より狭いパターンに置き換えた）: coverage P-004 の `grep -nE '\b(node|aws|gcp)\b' .github/workflows/ci.yml` は `setup-node` / `node-version` に恒久ヒットする。coverage P-002 の `pnpm ls ... -r` は本リポジトリの `node_modules` が `package.json` と同期していない状態でも空を返し（実測）、判定材料にならない。

### 3周目

**両視点とも問題点ゼロ**（要件カバレッジ / アーキ整合性・リスクのどちらも「実装をブロックするものなし」）。**改善提案5件を反映してレビューループを終了する。**

2視点とも、計画に書かれた実測値・grep の期待値・ファイル特定をゼロベースで再実行して**1件の誤差もなく再現**した（16-9 の 79 ファイル / 16-12 の6行 / ステップ5 の 14 行 = 12 箇所 / lockfile 192 行・`importers:` 20 行 / libsql 32 ブロック / `libsql → d1` の一方向依存 / `#26` `#37` `#35` の OPEN 状態）。加えて 16-9 の 79 ヒットを1件ずつ分類し、**全件が「削除対象」または「本計画の編集対象表に載っている」のどちらか**＝期待値0件が到達可能であることも確認された。

**取り込んだ改善提案（S）**:

- **coverage S-001: AC-12 の「対応項目4 の8ファイル」が直後の列挙（10件）と合っていない** — 実体は `vite.config.{node,aws,gcp}.ts` 3 + `scripts/{listen.node.ts,listen.gcp.mjs,migrate.node.ts,migrate.aws.ts,migrate.gcp.ts}` 5 + `drizzle.libsql.config.ts` 1 + `Dockerfile.gcp` 1 = **10**（ステップ7 の対象ファイル欄は元から10件で正しかった）。AC-12 とステップ7 の理由欄を「10ファイル」に訂正し、**Issue 本文の対応項目4 が `scripts/migrate.node.ts` を落として9件表記であること（本計画が補完している側が正）**も併記した。AC-12 を実装後のチェックリストとして使う想定なので、Issue 本文と突き合わせて数が合わずに迷わないようにするため。
- **coverage S-002: ステップ16-8 の判定基準と HEAD ベースラインの記録** — (a) `pnpm dev` 起動後の `/` は**未認証だと HTTP 307 で `/login` にリダイレクトされるのが正常**（`routes/_app.tsx` の `beforeLoad`）。撤去とは無関係の既存挙動なので、307 を退行と誤認して調査に入らないよう判定基準に明記した（ブラウザならログイン画面の描画、`curl -i` なら `307` + `location: /login` が期待値）。(b) 「調査結果 / 既存実装の状態」に **HEAD 時点のベースライン実測**表を新設し、`typecheck` / `lint` / `format:check` / `test:unit`(**424**) / `test:integration:cf`(**104**) / `build:cf` / `dev:cf` がすべて green であることを記録した。撤去後にこれらが落ちたら原因は撤去側にある、と H-8 と同じ精度で切り分けるため。あわせて **`pnpm install` 前は `pnpm build:cf` が `drizzle-orm/d1` の解決失敗で落ちる**（＝ステップ16-1 が先頭にある理由、H-8 の当時の `--dry-run` が返した 9 errors のうち6件が環境由来だったことの裏づけ。H-8 の真因そのものは別 → Issue #40）ことも前提条件として明記した。
- **arch S-001: ステップ16-11 の層分離検証が `git status` ベースで空振りする** — ステップ9 が「`esbuild` の削除は独立コミット」「lockfile をコミットしてから `--frozen-lockfile`」と指示している以上、ステップ16 到達時には作業の大半がコミット済みで、**`git status` は何も表示せず検証が「合格」してしまう**（さらに #34 系の未追跡 `wrangler.{request,state}.*.toml` がノイズとして常時現れる）。判定を **`git diff --stat main...HEAD -- <パス>`** に置き換え、`domain/` と `presentation/` は出力が空、`application/` は `di/` とテストコメント1行だけ、と対象パスごとに具体化した。「テスト方針」節の同項目も同じ文言に揃えた。
- **arch S-002: ステップ15 に #35 宛てのコメントを1件追加** — `spec/database/index.md:3` が `CLAUDE.md`「Reference runtimes」節を**名指しで参照**しており、本 Issue のステップ13 がその節を大幅に縮める。`spec/` 本体の改訂は #35 の担当でスコープ外なので触らないが、「#36 で Reference runtimes 節が Cloudflare 単独に縮み、libSQL / Turso アダプターは実体ごと消えた」旨と、`spec/database/index.md:341,349,350` / `spec/inventory/adapter.md:22` に libSQL / Turso 前提が残る実測を **#35 に1コメントで渡す**（H-1〜H-8 と同じ扱い）。AC-5 とスコープ節にも反映した。
- **arch S-003: `biome.json` の `"*.mjs"` がデッドパターンになる** — `apps/web/scripts/listen.gcp.mjs` は**リポジトリ唯一の `.mjs`**（実測: `find . -name '*.mjs'` のヒット1件）なので、ステップ7 で消すと `files.includes` の `"*.mjs"`（`biome.json:15`）はマッチ対象ゼロになる。ステップ7 の対象ファイルに `biome.json` を追加し、**`files.includes` から `"*.mjs"` の1行だけを削除する**（配列の他の6要素は残す。`linter.includes` は `.mjs` パターンを持たないので無変更）と具体化した。**`infra/**` は `files.includes` / `linter.includes` の両方で必ず残す** — `infra/aws` / `infra/gcp` は消えるが `infra/cloudflare/pulumi` が残るため、一緒に落とすと Pulumi パッケージが lint / format の対象外になる。ルート `esbuild` と同じく **AC に無い派生作業**なので、落ちたら戻してよい旨も明記。「参照が残る（要編集）」表にも行を追加した。

**見送った提案とその理由**:

- なし（5件すべてを取り込み）。

**レビューループの終了**: 3周目で両視点とも問題点ゼロに到達し、改善提案も全件反映した。以降の改訂は実装中に見つかった事実に基づいて行う。
