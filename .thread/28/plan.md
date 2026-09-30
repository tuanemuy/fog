# 実装計画 — Issue #28: デプロイが手作業だけで、workflow も管理された secret も無い

**Issue:** #28
**規模:** 大（CI/CD・secret 管理・検証ロジック・文書。UI なし）

## 目的

`docs/runtime_cloudflare.md` 第 4 章の手作業（Pulumi `resources` → render → secret 投入 → DLQ retention → state Worker → request Worker → Pulumi `routes`）を GitHub Actions に載せ、secret の実体を SOPS + age で暗号化してリポジトリで管理する。secret は Worker 単位のファイルに分け、`.dev.vars.example` の所有表から導いた期待集合と照らして、不足・余剰・所有者違い・local only の混入・開発用の値の流用があれば Worker のコードを上げる前に落とす。

## 方針

- workflow は再利用可能な `deploy.yml`（`workflow_call`、入力は `stage` だけ）1 本に手順を持たせ、`deploy-staging.yml`（`push` to `main` + `workflow_dispatch`）と `deploy-production.yml`（tag `v*.*.*` + `workflow_dispatch`）はトリガー・stage 名・`concurrency`（`deploy-<stage>`、`cancel-in-progress: false`）だけを持つ。job は GitHub environment `<stage>` で走る
- 手順の順序: install → sops（バージョン固定・checksum 照合）→ **secret の検証** → Pulumi `resources` up → `pnpm cf:render:<stage>`（`MAIL_FROM_ADDRESS` は environment の vars）→ `pnpm deploy:<stage>:all`（stage build → state → request。既存 script をそのまま使う）→ **secret の注入と、Worker に実在する secret 名の照合** → DLQ retention → Pulumi `routes` up。検証は何も触らない最初の段に置く（復号と roster しか要らない）
- wrangler はリポジトリの devDependency（lockfile で固定されたもの）を pnpm script 経由で使う。`cloudflare/wrangler-action` は使わない: request Worker は `scripts/deploy-built.ts` の stage 検査を通す必要があり、version の一致は lockfile が保証する
- secret ファイル: `apps/web/secrets/<stage>.<request|state>.enc.json`（SOPS、`encrypted_regex: "^(.+)$"`）。ルートの `.sops.yaml` が stage ごとに別の age 公開鍵を割り当てる（出荷時は placeholder。bootstrap で置き換える）。平文の雛形 `apps/web/secrets/<request|state>.json.example`。平文の `*.json` は git-ignore
- 期待集合の authority は `apps/web/.dev.vars.example` の header table のまま。表を機械で読める形にそろえ（1 行 1 名、rotation 用 3 つに `**rotation only**` の印）、parser を `scripts/lib/` に置く。表に無い行形式は parse を中断させる
- 判定は純関数（`scripts/lib/` 配下）: 復号済みの 2 ファイルと roster と開発用の値を受け取り、問題の一覧か、Worker ごとのアップロード計画（config のパスと `_` を落とした key/value）を返す。CLI `scripts/stage-secrets.ts <check|push> <stage>` は `sops --decrypt` をメモリに読み、`push` は計画を `wrangler secret bulk --config <その Worker の config>` の stdin に渡す。平文はディスクに書かない。`push` も同じ判定を通す
- 判定の中身:
  - 不足: その Worker 所有の必須 key が無い
  - 所有者違い: 相手 Worker 所有の key がある（request ⇄ state の両方向）
  - local only: `MAIL_DEV_SINK` / `SSO_DEV_STUB` がある
  - 余剰: roster に無い key がある
  - rotation 用 3 つは所有 Worker のファイルにだけ在ってよく、無くてもよい
  - 値が文字列でない
  - 開発用の値: trim した値が `.dev.vars.example` の同名の値（trim 後）と一致する（空の値もこれに当たる）
  - `_` で始まる key は判定から外し、アップロードからも落とす
- DLQ retention の秒数は `deploy.yml` にも現れるので、`wranglerConfig.test.ts` の既存の pin（template header ⇄ `dlqRetentionMs`）に `deploy.yml` を加える
- release-please は入れない（Issue が任意とした範囲。production は手で tag を打つ）

## 受け入れ基準

| # | 基準 | 観測方法 |
|---|---|---|
| AC-1 | `main` への push で staging に、tag `v*.*.*` で production（environment の承認付き）に、人手の操作無しでデプロイされる。`workflow_dispatch` でも同じ経路が走る。同じ stage の実行は並走せず、走っている実行は打ち切られない | actionlint ＋ workflow の構造を読む自動テスト（トリガー・environment・concurrency・手順順）。実デプロイは下の「観測の限界」 |
| AC-2 | 通る: 両 Worker のファイルが自分の必須 key をすべて持ち、rotation 用 3 つは所有 Worker のファイルに在っても無くてもよく、`_` で始まる key はあってよい。落ちる: 不足・余剰（roster に無い名前、`[vars]` の名前）・所有者違い（request ⇄ state の両方向）・local only 混入・文字列でない値・開発用の値（trim 後に `.dev.vars.example` の値と一致。空を含む）。どちらのファイルの問題でも、両 stage とも、Worker のコード（と Pulumi）に触れる前に workflow が落ちる | 判定の unit test（各分岐、両 Worker、変異）＋ workflow の手順順のテスト＋手元で実 sops による `check` の実行（正常・異常） |
| AC-3 | request 用の secret が state Worker に、state 用が request Worker に入らない。アップロードは Worker ごとに 1 回、`wrangler.<stage>.toml` / `wrangler.state.<stage>.toml` に対して行い、各アップロードは自分のファイルの key（`_` を除く）をすべて、かつそれだけ持つ。判定に 1 件でも問題があれば、どちらの Worker にも 1 回もアップロードしない | アップロード計画と `push` の実行（wrangler 呼び出しを差し替え）の unit test、変異 |
| AC-4 | アップロードの後、各 Worker に実在する secret 名の集合が自分のファイルの key 集合と一致しなければ workflow が落ち、食い違う名前と `wrangler secret delete` の要否を示す（手作業の fallback で相手 Worker に入った key、退役後に残った rotation 用 key、ファイル間で移した key の取り残しを検出する） | 照合の unit test（`wrangler secret list` の出力を差し替え）、変異 |
| AC-5 | `ci.yml` が request / state 両 Worker の deploy dry-run を回す | 既存の `deploy-dry-run` job（`pnpm test:deploy` → `deploy:<stage>:all:dry`）。`pnpm test:deploy` の手元実行 |
| AC-6 | 期待集合は `.dev.vars.example` の所有表だけから導かれる。表の名前集合と本文の代入の名前集合が食い違う、表に読めない行がある、のいずれでも test が落ちる。表の所有者は、各 secret を読むコード（request: `serverCloudflare.ts` と `app/` の handler、state: Durable Object）と一致することを test が固定する | roster parser の unit test ＋所有者とコードの照合 test（限界は test とこの計画に明記） |
| AC-7 | 復号した平文は CLI のメモリと wrangler の stdin にしかなく、`_` で始まる key はアップロードされない。問題の文言は key 名とファイル名だけを含み、値を含まない | unit test（計画から `_` が落ちる、アップロードは文字列で渡る、問題文に値が現れない）。「ディスクに書かない」は CLI がファイル書き込みを持たないことで成り立ち、test は無い（限界として文書に書く） |
| AC-8 | `.sops.yaml` は stage ごとに別の規則を持ち、`<stage>.*.enc.json` はその stage の規則にだけ当たり、2 つの規則の recipient が異なり、どちらも `encrypted_regex: "^(.+)$"`。平文の雛形 `*.json.example` の key 集合は各 Worker の必須 key と一致し、値はすべて空（開発用の値の検査に当たる） | unit test（`.sops.yaml` と雛形を読む）＋手元で実 sops による暗号化・復号 |
| AC-9 | `pnpm secrets:check <stage>` / `pnpm secrets:push <stage>` をローカルでも同じ形で打てる | コマンド出力＋`deployScripts` 系の test |
| AC-10 | `docs/runtime_cloudflare.md` 第 3 章・第 4 章が新しい経路（workflow・SOPS・検証・注入・照合）を述べ、手作業の手順は初回 bootstrap と障害時の fallback として残る。bootstrap（age 鍵・`.sops.yaml`・暗号化ファイル・GitHub の secret / vars / environment と required reviewers）が書かれている。検査の限界（rotation 用の値の中身と対の整合は見ない、開発用の値の検査は現状「空でない」に等しい、平文を書かないことに test は無い）が書かれている。`.dev.vars.example` の header と template header の記述が変更後と食い違わない | 差分の読み＋grep |
| AC-11 | typecheck・lint・format・unit・integration・`pnpm test:deploy` が通る | コマンド出力 |

## 判定の前提（明示）

- 必須 key は roster のうち rotation 用でない secret すべて。`OPERATOR_TOKEN` と `GOOGLE_*` も含む（未設定で面を消す運用は local だけ。Issue の「roster の所有分（rotation 用は optional）」に従う）
- rotation 用の値の中身（JSON の形・世代・keyring とコミットメントの対）は見ない。対の整合は bucket の世代ガードとコミットメント照合が実行時に守る（`spec/rotation/index.md`）。keyring を active だけにした単一世代はコミットメント無しで正当なので、存在の対も規則にしない
- 開発用の値の検査は `.dev.vars.example` の値との一致。現状その値は空か local only のもの（`console` / `true`）なので、実質「空でない」に等しい

## 観測の限界

Cloudflare アカウント・Pulumi backend・age 鍵・GitHub environment の設定がこのリポジトリに無い（`Pulumi.<stage>.yaml` は placeholder）。したがって workflow の実行そのもの（Pulumi up、実アップロード、`secret bulk`、`queues update`）は観測できない。AC-1 は構造（actionlint とテスト）までを観測し、実デプロイは bootstrap 後の最初の実行が観測になる。bootstrap が済むまで、`main` への push ごとに deploy-staging は赤で落ちる（ユーザー合意済み。未設定を黙らせるスイッチは置かない）。

## スコープ

### 含まれるもの

- `.github/workflows/deploy.yml` / `deploy-staging.yml` / `deploy-production.yml`
- `.sops.yaml`、`apps/web/secrets/*.json.example`、`.gitignore` / Biome の除外
- `apps/web/scripts/stage-secrets.ts` と `scripts/lib/` の roster parser・判定・計画・照合、それらの unit test、workflow 構造と `.sops.yaml` の test、pnpm script `secrets:check` / `secrets:push`
- `apps/web/.dev.vars.example` の header table の形式（1 行 1 名、`**rotation only**`）と、表の `APP_URL` 行の誤り（render は stack output から取る）の訂正
- `docs/runtime_cloudflare.md` 第 3・4 章、README の該当段落、template header の手順コメント、`docs/test.md` の該当箇所

### 含まれないもの

- 実 secret・age 鍵・暗号化ファイルの作成、GitHub の secret / environment の設定、Pulumi stack config の記入（bootstrap。ユーザーが行う）
- release-please
- Cloudflare Access / WAF / queue retry period などの out-of-band 設定、`[observability]`（#5）
- `ci.yml` の変更（AC-5 は既存 job が満たす）
