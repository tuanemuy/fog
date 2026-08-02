# ADR — Issue #36: Node / AWS / GCP ランタイムを撤去する

## ADR-001: `:cf` サフィックスを維持したまま bare スクリプトをエイリアス化する

### Status

Proposed

### Context

ランタイムが Cloudflare 1本になると、`dev:cf` / `build:cf` / `start:cf` / `db:migrate:cf` / `db:generate:cf` / `test:integration:cf` というサフィックスは「他と区別するための接尾辞」としての意味を失う。選択肢は2つ。

1. **サフィックスを廃してフラット化する** — `dev` / `build` / `start` / `db:migrate` / `db:generate` / `test:integration` に一本化し、`:cf` 版を消す。ランタイムが1つである事実がスクリプト名に現れる。
2. **`:cf` を残し、bare スクリプトをそのエイリアスにする** — `"dev": "pnpm dev:cf"` のような1段の委譲を維持する。

判断材料:

- #37 は D1 系スクリプト（`db:generate:cf` / `db:migrate:cf` / `db:apply:*` / `db:execute:*`）と relay / consumer / pruner / dlq の `deploy:*` を DO 構成向けに作り直すことが Issue 本文で明示されている。`:cf` サフィックスの整理をここでやると、#37 が同じ行をもう一度書き換える。
- `.github/workflows/ci.yml` は `pnpm test:integration:${{ matrix.runtime }}` / `pnpm build:${{ matrix.runtime }}` という形で `:cf` 名に依存している。
- `docs/runtime_cloudflare.md` は `pnpm dev:cf` / `pnpm db:migrate:cf` / `pnpm db:apply:*` を手順として全編で参照している。#38 が DO 構成へ書き換えるまでこの文書は生きる。
- Issue #36 の要求は「`dev` / `build` / `start` の**既定**を Cloudflare 構成へ切り替える」であって、サフィックスの廃止ではない。

さらに、`start` には独立した論点がある。現行 `start:cf` は `wrangler dev` であり、これは開発サーバーであってプロダクション起動ではない。Cloudflare はデプロイ先が Cloudflare 側なので、そもそも「ローカルでプロダクション起動する」概念がない。選択肢は (a) `start` → `start:cf`（`wrangler dev`）のエイリアスにする、(b) `start` を削除して `preview` に寄せる、の2つ。

**2周目レビューで判明した前提の崩れ（実測）** — ⚠️ **本段落の原因の記述は誤りだった（2段落下の訂正ブロックを先に読むこと）。** `start:cf`（`wrangler dev`）は**本 Issue 以前から起動できない**。`apps/web` で `npx wrangler deploy -c wrangler.toml --dry-run` を実行すると `Build failed with 9 errors` で落ちる。恒久的な原因は `Could not resolve "#tanstack-router-entry"` / `"#tanstack-start-entry"` / `"tanstack-start-manifest:v"` の3件で、これらは **vite プラグイン鎖でのみ解決される仮想モジュール**であり wrangler の esbuild は解決できない（残り6件の `drizzle-orm` 解決エラーは検証環境の `node_modules` が古かったことによるもの）。根本原因は `apps/web/wrangler.toml:13` の `main = "app/server.cloudflare.ts"` が **TS ソースを直接指している**こと。`wrangler.staging.toml.tpl` / `wrangler.production.toml.tpl:21` も同形。傍証として、未追跡の `apps/web/wrangler.request.staging.toml` は既に `main = "dist/server/index.js"` に変わっている。

これにより、初版の Decision が根拠にしていた「`start` を残せば AC-3 が3コマンドの実行だけで検証できる」という主張は**成立しない**。ただし原因は撤去とは無関係の既存欠陥であり、`wrangler.toml` / `.tpl` の `main` を直すのは #37 の `wrangler*.toml` 書き換えと衝突する。したがって**本 Issue では直さない**。

> ⚠️ **訂正（事後の追試）** — 直前の段落の**原因の記述は誤り**だった。「`start:cf` が本 Issue 以前から起動できない」「本 Issue では直さない」という結論は変わらないが、原因は次のとおり:
>
> - **ビルドは成功する**（実測 `npx wrangler dev --port 8798` → 78 modules / 1132.07 KiB）。落ちるのは **workerd の起動時**で、`Disallowed operation called within global scope. ... generating random values are not allowed within global scope.` → `The Workers runtime failed to start.`
> - 原因は `packages/core/src/application/workers/eventRelayWorker.ts:97` の `const RELAY_WORKER_ID = crypto.randomUUID();` が**モジュールスコープで評価される**こと。流入経路は `app/server.cloudflare.ts` → `di/serverCloudflare.ts` → `di/env.ts` → `workers/eventRelayWorker.ts`
> - **`pnpm start` の経路では `wrangler.toml` の `main` は読まれない。** `pnpm build` 後は `apps/web/.wrangler/deploy/config.json` の redirect により `dist/server/wrangler.json`（`main: "index.js"`）が使われる
> - 上記 `--dry-run` の `9 errors` は `node_modules` が `package.json` と乖離した状態での観測。`pnpm install --frozen-lockfile` 後は `Build failed with 3 errors`（仮想モジュール3件のみ）になり、しかもこれは redirect が無いときだけ通る経路
> - 追跡先は **Issue #40**（https://github.com/tuanemuy/fog/issues/40 ）。以下の Decision / Consequences のうち「`main` を直せば `start:cf` が動く」を前提にした記述はこの訂正で読み替えること

### Decision

**選択肢2を採る。** `:cf` サフィックス付きスクリプトを実体として残し、`dev` / `build` / `start` / `db:migrate` / `db:generate` は `:cf` 版への1段の委譲にする。サフィックスのフラット化は #37 のスクリプト再編に委ねる。

`start` については **(a) を採り、`start` → `start:cf`（`wrangler dev`）のエイリアスにする。** ただし理由を差し替える（2周目の修正）。初版の理由「`start` を削除すると受け入れ条件が検証できなくなる」は、そもそも `start:cf` が起動しない以上成立しない。採る理由は次の2点:

1. Issue の受け入れ条件は「`dev` / `build` / `start` の**既定が Cloudflare 構成を指している**」であって「実行できること」ではない。エイリアス化はこれを素直に満たす。
2. `start` を消したり `preview` に付け替えたりすると、別 Issue で直せる既存欠陥を**スクリプト名の変更で覆い隠す**ことになる。名前を保ったまま欠陥を H-8 として記録するほうが正しい。（⚠️ 初版はここに「#37 が `main` を `dist/server/index.js` へ直せば `start:cf` はそのまま動くようになる」と書いていたが**誤り** — 上の訂正ブロック参照。真因は `eventRelayWorker.ts` の module-scope 乱数生成で、追跡先は **#40**。加えて `preview` への付け替えも同一原因で動かないので、いずれにせよ (a) を採るのが正しい。）

**したがって AC-3 の検証は「`package.json` のスクリプト定義が Cloudflare 構成を指していることの確認」＋ `pnpm dev` / `pnpm build` の実行に限定する**（`pnpm start` は実行しない）。

### Consequences

- 良い点: #37 との書き換え衝突が最小になる。CI と `docs/runtime_cloudflare.md` の既存記述が `:cf` 名のまま生き続けるので、本 Issue の docs 修正範囲が「削除したファイルを指す記述」だけに閉じる。
- 良い点: bare スクリプトを実体コマンドの複製ではなく `"pnpm <name>:cf"` の**エイリアス**として書くので、#37 が `:cf` を整理するときに書き換える行が1本で済む。`test:integration` も同じ方針（`"pnpm test:integration:cf"`）に揃える。
- **撤回（2周目）: 「AC-3 が `pnpm dev` / `pnpm build` / `pnpm start` の実行だけで検証できる」という良い点は取り下げる。** 1周目でこの主張を成立させるためにステップ16 へ追加した `pnpm start` の起動確認も撤回した。実測のとおり `wrangler dev` は本 Issue 以前から起動できず、この項目を残すと実装者はステップ16-7 で必ず詰まり、その場で本 ADR を再決定する羽目になる。AC-3 の検証は上記のとおりスクリプト定義の確認 ＋ `pnpm dev` / `pnpm build` の実行とする。
- **撤回（2周目）: トレードオフ緩和として書いていた「`docs/runtime_cloudflare.md` の Quick start に『`pnpm start` は `wrangler dev` を起動する』旨を一行添える」（計画ステップ12）も削除する。** 動かないコマンドの案内を新設することになるため、`pnpm start` については docs に何も追記しない。
- トレードオフ: ランタイムが1つなのにサフィックスが残るため、一時的に冗長に見える。#37 完了までの過渡状態として受け入れる。
- トレードオフ: `pnpm start` が名前どおりに動かない状態が本 Issue 完了後も残る。**引き継ぎ項目 H-8** として記録し、リスク節にも項目を立て、**Phase 5 で別 Issue として起票する候補**とした → **Issue #40 として起票済み**（https://github.com/tuanemuy/fog/issues/40 ）。⚠️ 初版はここに「修正方針は `wrangler.toml` / `.tpl` の `main` を `dist/server/index.js` に直すこと」と書いていたが**誤り**（上の訂正ブロック参照）。修正対象は `packages/core/src/application/workers/eventRelayWorker.ts` の module-scope 乱数生成。`main` の修正（#37 の対応項目8）は redirect 設定が無い経路のために依然必要だが、それだけでは `wrangler dev` は直らない。`.tpl` に触ると #37 との衝突面が広がるので、`main` の修正は #37 に合流させるほうが安全。
- 参考: ⚠️ 初版はここに「ビルド成果物に近い形での確認には既存の `"preview": "vite preview --config vite.config.cloudflare.ts"` が H-8 解消までの実用上の代替になる」と書いていたが**誤り** — `pnpm preview` も同一原因（workerd のグローバルスコープ制約）で起動しない。**ローカルで動くのは `pnpm dev` だけ**（Vite のモジュールランナーがリクエストハンドラ内でモジュールを評価するため制約に当たらない）。
- 副次的な確認: bare → `:cf` のエイリアス化で `predev:cf` が発火しなくなるのでは、という懸念は**実測で否定済み**（pnpm 11.1.2・`.npmrc` なしで `"bar": "pnpm foo"` から `prefoo` が発火することを確認）。`predev` の追加は不要であり、追加すると `wrangler types` が二重実行される。

---

## ADR-002: 統合テストを Workers プール単独にし、Node プールの統合設定を撤去する

→ `.adr/001-integration-tests-single-workers-pool.md` に昇格

### Status

Proposed

### Context

統合テストは現在2プールに分かれている。

- `vitest.config.integration.ts` — `@cloudflare/vitest-pool-workers` による Workers プール。`env.DB`（Miniflare D1）を使う。
- `vitest.config.integration.node.ts` — Node プール。`@libsql/client` が Node のネイティブモジュールを必要とし Workers アイソレート内で動かせないため分離されていた。include は libsql アダプター / node アダプター / node worker runner の3パターンのみ。

libsql / node アダクターと node runner を削除すると、後者の include が全部消えて設定ファイルが空になる。選択肢は2つ。

1. **`vitest.config.integration.node.ts` をファイルごと削除する** — 統合テストのプールを Workers 1つにする。
2. **空の Node プール設定を残す** — 将来 Workers アイソレートで動かせない統合テストが出たときの受け皿として温存する。

判断材料:

- Node プールを分けていた理由は「libSQL のネイティブモジュールが workerd で動かない」という libSQL 固有の事情であり、libSQL の撤去とともに理由が消える。
- #37 は永続化を DO SQLite に移すので、統合テストはむしろさらに Workers プール（`@cloudflare/vitest-pool-workers` + DO SQLite）に寄る。Node プールの統合テストが再び必要になる見込みは薄い。
- 空の設定ファイルは「なぜあるのか」を説明できない死んだ設定になる。`CLAUDE.md` の「illegal states を型で表現し、runtime check に頼らない」精神からしても、使われない受け皿を先回りで残す理由はない。
- unit テスト用の `vitest.config.ts` は Node プールのままなので、「Node プールが必要になったら unit 側の設定を雛形に再作成できる」という退路はある。

### Decision

**選択肢1を採る。** `vitest.config.integration.node.ts` を削除し、`pnpm test:integration` は `vitest.config.integration.ts`（Workers プール）単独を実行する。あわせて `vitest.config.integration.ts` の `exclude` から libsql / node / worker-node の3行と、その理由を説明するコメントブロックを削除する。

`vitest.config.ts`（unit / Node プール）は無変更で残す。

### Consequences

- 良い点: 統合テストの実行経路が1本になり、`docs/test.md` の「two pools」という説明も1本に単純化できる。CI の integration matrix も畳める。
- 良い点: 「なぜ Node プール統合設定があるのか」を説明する必要がなくなる。理由（libSQL のネイティブモジュール）が消えたので設定も消す、という対応が取れている。
- トレードオフ: Workers アイソレートで動かせない統合テストが将来必要になった場合、設定を書き直す必要がある。`vitest.config.ts` が雛形になるので実コストは小さい。
- トレードオフ: `pnpm test:integration` と `pnpm test:integration:cf` が同義になり冗長。ADR-001 と同じ理由で `:cf` 名は #37 まで残す。

---

## ADR-003: 4ランタイム分の `describe.each` ガードを削除せず cloudflare 1件に縮めて維持する

### Status

Proposed

### Context

`packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` は、4つの合成ルート（cloudflare / node / aws / gcp）それぞれについて「`container.config` が `AppConfig` のキー集合ちょうどであること」「シリアライズした config に session secret が混入しないこと」を `describe.each` で検証している。

このテストが守っているのは、テスト本文のコメントが明記しているとおり **`satisfies AppConfig` が変数に対しては excess property check を走らせない**という TypeScript の穴である。`createXxxRequestContainer` は `const { db, relayTrigger, secrets, ...appConfig } = config` の rest spread で `AppConfig` を組むので、`RequestServerConfig` にフラットに置かれた秘密情報は型エラーなしに `container.config` へ乗り、`loadAppContext` 経由でブラウザまで届く。

ランタイムが1つになると、選択肢は3つ。

1. **テストごと削除する** — 4ランタイム比較のためのテーブルテストだったと解釈する。
2. **`describe.each` を解いて cloudflare の直書きテストにする**。
3. **`describe.each` の構造を保ち、テーブルを cloudflare 1件に縮める**。

### Decision

**選択肢3を採る。** テーブルを cloudflare 1件に縮め、`describe.each` の構造と2つのアサーション、および「usecase から `sessionCodec` に到達できない」型テストをそのまま維持する。`LibsqlDatabase` 型の import と `db` フィクスチャだけを落とす。

理由は、このテストが守っている穴が**ランタイムの数と無関係**だからである。Cloudflare 1本になっても `satisfies` の excess property check の穴は同じように開いており、`RequestServerConfig` に秘密情報を1つ足せば同じ事故が起きる。テストのコメント自身が「This suite is the permanent guard: the key set is enumerated, not merely checked for known offenders」と宣言しており、恒久ガードとして設計されている。

選択肢2ではなく3を採るのは、#37 で Identity Directory DO 向けの合成ルートが増える可能性があり、そのときテーブルに1行足すだけで済むためである。

### Consequences

- 良い点: 秘密情報がクライアントへ漏れる経路に対する恒久ガードが、ランタイム撤去で失われない。
- 良い点: #37 で合成ルートが増えたときの追加コストがテーブル1行で済む。
- トレードオフ: 要素1件の `describe.each` は冗長に見える。テスト本文のコメントが「なぜテーブル構造なのか」を説明しているので、コメントを Cloudflare 単独の文脈に合わせて更新することで緩和する。

---

## ADR-004: ルート `esbuild` devDependency は「削除して検証」で決着させる（`pnpm why` では判定しない）

### Status

Proposed

### Context

ルート `package.json` の `esbuild` devDependency は導入経緯が initial commit に埋もれており（`git log -S esbuild -- package.json` は initial commit しか返さない・実測）、`infra/aws` を削除したあとも必要なのかが自明でない。

初版の計画は「`pnpm why esbuild` で確認し、他に必要とするものがなければ削除、確証が得られなければ残す」としていたが、これは**原理的に結論が出ない判定条件**である。実測すると `pnpm why esbuild -r` は `vite` / `tsx` / `wrangler` / `@cloudflare/vitest-pool-workers` / `vitest` 経由の推移依存を大量に返す。`esbuild` は Cloudflare 側のツールチェーンが必ず transitive に持つので「他に必要とするものがない」状態は永遠に来ず、判定は常に既定（残す）へ落ちる。つまり判断を先送りしているだけになる。

一方、リポジトリ内には十分に強い直接証拠がある。

- `infra/aws/lib/appStack.ts:34` が `import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs"` を持ち、Relay / Consumer / Pruner / DLQ の4関数を `NodejsFunction` で作っている。
- 同ファイル `:110-111` のコメントが「NodejsFunction's esbuild bundler auto-discovers tsconfig by walking up from the entry」と明記している。CDK の `NodejsFunction` は Docker を使わないバンドル時にローカルの `esbuild` 解決を要求する。
- リポジトリ内で `esbuild` を直接名指ししているのは `package.json` / `pnpm-workspace.yaml` の `allowBuilds` / この `appStack.ts` のコメント2箇所のみ。

### Decision

**削除する。** 根拠は上記の直接証拠。ただし推測で確定させず、**実際に削除して `pnpm install` → `pnpm build:cf` → `pnpm test:unit` / `pnpm test:integration` が通ることで検証する**。落ちた場合は戻す。

**コミット粒度と lockfile の往復回数（2周目で確定）** — 初版は Consequences で「lockfile の往復を避けたいので依存整理（ステップ9）の中で一度に決着させる」と書きつつ、Decision では「戻しやすいよう独立したコミットにする」と書いており、往復が1回なのか2回なのかが読み取れなかった。**確定: `esbuild` の削除は独立したコミットにする。したがってステップ9 内で `pnpm install` は 2 回走る**（① ランタイム専用依存9件 + `infra/aws` のワークスペース除去で1回、② `esbuild` 削除で1回）。

この選択の理由は、`esbuild` が **Issue の対応項目にも受け入れ条件にも無い派生作業**だからである。検証で落ちたら戻す＝残したままでも受け入れ条件は満たすので、単独で `git revert` できる形にしておく価値が、lockfile 往復1回の節約を上回る。ただし2回の `pnpm install` は**ステップ9 内で連続して実行し、間に他の作業を挟まない**（lockfile のコンフリクト面が広いという既存リスクへの対処）。

`pnpm-workspace.yaml` の `allowBuilds.esbuild: true` は**残す**。これは vite / wrangler が transitive に持つ esbuild のビルドスクリプト許可であり、ルート devDependency の有無とは独立している。

### Consequences

- 良い点: 「消してよいか分からないので残す」という判断保留が、実行可能な検証手順に置き換わる。撤去 Issue で「消し残し」を許すと、次の担当者が同じ調査を繰り返す。
- 良い点: 判定根拠が `pnpm why` の出力（環境依存・バージョン依存）ではなくリポジトリ内のコードとコメントなので、再現性がある。
- 良い点: `esbuild` の可否が独立コミットに閉じるので、検証で落ちてもそのコミットだけ revert すれば済む。他の依存削除・ワークスペース除去を巻き添えにしない。
- トレードオフ: ステップ9 で `pnpm install` が2回走り、lockfile も2回書き換わる。連続実行して間に他の作業を挟まないことで緩和する。
- 注記: `esbuild` の削除は AC に現れない派生作業である。**検証で落ちたら戻す＝残したままでも Issue の受け入れ条件は満たす**ので、削除に固執して往復を増やさないこと（計画の AC-9 注記と同じ線）。
- 注記: `allowBuilds.esbuild` を巻き添えで消すと vite / wrangler 側のビルドが許可されなくなる。同様に `allowBuilds.protobufjs: false` は GCP ではなく `@pulumi/pulumi` → `@grpc/grpc-js` 由来なので、GCP 撤去に巻き込んで消してはいけない（`sharp: false` は miniflare 由来）。

---

## ADR-005: 実装時に発生した2件の逸脱（コミット粒度 / README の `pnpm start`）

### Status

Accepted（実装時に確定）

### コンテキスト

実装中、計画・ADR が前提にしていた2点をそのまま実行できなかった。

1. **ADR-004 / ステップ9 のコミット粒度** — ルート `esbuild` の削除を「独立したコミット」にし、落ちたら単独 revert できる形にする、と決めていた。しかし本実装セッションは呼び出し元から **`git commit` / `git push` を行わない**（変更を作業ツリーに残すところまで）と明示的に指示されており、コミットを切ること自体ができない。
2. **README の Quick Start にあった `pnpm start`** — 計画ステップ12 は Quick Start ブロックを Cloudflare 手順に置き換えるよう指示していたが、置き換え後に `pnpm start`（= `wrangler dev`）を残すかどうかまでは書かれていなかった。H-8 のとおり `wrangler dev` は本 Issue 以前から起動できない。

### 決定内容

1. **`esbuild` の削除は「独立コミット」ではなく「独立した検証」で担保した。** 削除 → `pnpm install` → `pnpm build:cf` を**他の作業を挟まずに連続実行**し、ビルドが通ること（`dist/server/index.js` 734.21 kB、HEAD ベースライン 735.68 kB とほぼ同値）を確認したうえで先へ進めた。コミット分割は呼び出し元の判断に委ねる。切り戻しが必要になった場合、対象はルート `package.json` の1行と `pnpm-lock.yaml` の再生成だけである。
2. **README の「For a production build」ブロックから `pnpm start` を落とし、`pnpm build` のみを残した。** `## Development commands` の一覧には `pnpm start` / `pnpm start:cf` を残している（AC-3 が要求するのはスクリプト定義が Cloudflare 構成を指していることであり、一覧はその事実の記述であるため）。

### 理由

1. ADR-004 がコミット分割を求めた目的は「検証で落ちたときに `esbuild` だけを切り戻せること」であり、その目的は**削除の直後に単独で検証を走らせる**ことでも達成できる。コミット権限が無い以上、目的側を満たす手段に置き換えるのが正しい。
2. ADR-001 は「動かないコマンドの案内を新設しない」ために `docs/runtime_cloudflare.md` への `pnpm start` 追記を撤回している。README の Quick Start は**新規利用者が最初に順番どおり実行する手順**なので、そこに壊れたコマンドを残すのは docs への新設と同じ害がある。一方 Development commands 表は手順ではなくスクリプトの一覧なので、H-8 が解消したときに追記が要らないよう残した（H-8 の追跡先は **#40**。当初「#37 で解消する」と書いていたのは誤診断に基づく — ADR-001 の訂正ブロック参照）。その後のレビュー指摘を受け、一覧側にも「currently fails to boot」の注記と原因の説明段落を README に足している。
