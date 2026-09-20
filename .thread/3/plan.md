# 実装計画 — Issue #3: request Worker をデプロイできず、`pnpm start` も起動しない

**Issue:** #3
**作成日:** 2026-09-20
**規模:** 中（ビルド・デプロイ経路と設定。UI なし）

## 目的

request Worker を wrangler に渡す経路を、ソースのエントリ（`app/server.cloudflare.ts`）から Vite のビルド成果物（`dist/server/wrangler.json`）へ変える。TanStack Start の仮想モジュールは Vite だけが解決できるので、wrangler の esbuild に request Worker のソースを bundle させる経路を無くす。これで `pnpm deploy:<stage>` と `pnpm start` が通る。

## 方針

- ステージは Vite の config ファイルで選ぶ。`vite.config.cloudflare.ts` が `createConfig(stage: DeployStage | null)` を export し、既定の export は `createConfig(null)`（ローカル）。`vite.config.cloudflare.staging.ts` / `vite.config.cloudflare.production.ts` は `createConfig("<stage>")` を返すだけ。環境変数は使わないので、`pnpm dev` / `pnpm build` / `pnpm preview` / `pnpm start` がシェルの状態でステージに切り替わることはない
- `createConfig` は `@cloudflare/vite-plugin` の `configPath` と `auxiliaryWorkers[].configPath` を、ステージの描画済み設定（`wrangler.<stage>.toml` / `wrangler.state.<stage>.toml`）かローカルの `wrangler.toml` / `wrangler.state.toml` に向ける
- ステージの一覧と「ステージ → 設定ファイルのパス」は 1 つのモジュールに置き、`createConfig` と `scripts/render-wrangler.ts`（描画の出力先）の両方がそこから取る
- `build:<stage>` がステージの config でビルドする。成果物のアップロードは `deploy:built`（`wrangler deploy --config dist/server/wrangler.json`）と `:dry` の 1 組で、`deploy:<stage>` は `build:<stage>` の後にそれを呼ぶ
- `deploy:<stage>:all` は **ビルド → state Worker のデプロイ → request Worker のデプロイ** の順。ビルドを先頭に置くのは、ビルドの中断で state だけが着地した half-run を作らないためと、2 つのデプロイの間隔（skew window、`docs/runtime_cloudflare.md` §4.4）をビルド時間の分だけ広げないため
- state Worker のデプロイは現行どおりソースから（`wrangler deploy --config wrangler.state.<stage>.toml`）。仮想モジュールを持たず、現に通っている
- `start:cf` はローカル設定でビルドしてから `wrangler dev -c dist/server/wrangler.json -c wrangler.state.toml` を起動する。ビルドを含めるのは、`dist/` が直前のステージビルドのままだと request 側の `script_name` がローカルの state Worker 名と食い違い、DO バインディングが黙って繋がらないため
- テンプレートの `main` はソースのエントリのまま（Vite プラグインがエントリとして読む）。したがって `wrangler deploy` / `wrangler dev` に request 側のソース設定（`wrangler.toml`、`wrangler.<stage>.toml`）を直接渡す経路は変更後も通らない。bundle しないコマンド（`wrangler types`、`wrangler secret put`、`wrangler queues`）にソース設定を渡すのは有効
- デプロイされる実体が `.tpl` から成果物の JSON に変わるので、成果物を検証するスイート（`scripts/__tests__/deployBundle.deploy.test.ts`、`pnpm test:deploy`、`vitest.config.deploy.ts`）を足し、CI のジョブで回す。固定値でテンプレートを描画し、ステージごとに実際のスクリプトでビルドと `wrangler deploy --dry-run` を実行し、成果物の JSON を検査する。設定が欠けたステージビルドの中断と、ステージビルド後の `pnpm start` の起動も同じスイートが見る。描画済み設定が既にある作業ツリーでは上書きせずに中断する。描画の置換はスイートと `render-wrangler.ts` が共有する 1 つの関数

## 受け入れ基準

| # | 基準 | 観測方法 |
|---|---|---|
| AC-1 | 描画済みのステージ設定がある状態で `deploy:staging:dry` / `deploy:production:dry` / `deploy:<stage>:all:dry` が exit 0 で終わり、request Worker の bundle で仮想モジュールの解決エラーが出ない | `pnpm test:deploy`（CI でも実行）＋コマンド出力 |
| AC-2 | ステージビルドの成果物 `dist/server/wrangler.json` がそのステージの値を持つ: `name` がステージのプレフィックス、DO バインディングの `script_name` が `<prefix>-state`、`vars` がテンプレートの `[vars]` と同じキー集合（`DIAGNOSTICS_ENABLED`・`MAIL_DEV_SINK`・`SSO_DEV_STUB` が無い）、キューの consumer 2 本がステージのキュー名で `max_retries` / `dead_letter_queue` がテンプレートと同じ。ローカルの値が混ざらない | `pnpm test:deploy`。変異: テンプレートに `DIAGNOSTICS_ENABLED` を足すと赤 |
| AC-3 | `pnpm start` が起動し、トップページが応答し（未ログインなのでログインへの 307）、`/__diagnostics/schema-version?locator=dir:g1:b0` が 200 を返す（request Worker → DO の往復）。直前にステージビルドをしていても同じ | `pnpm test:deploy`（ステージビルドの後に `start:cf` を起動して往復）＋コマンド出力（curl） |
| AC-4 | ステージビルドは、request 側・state 側どちらの描画済み設定が欠けていても中断する（片方だけある場合を含む） | `pnpm test:deploy`（3 通り: 両方無い／request だけ／state だけ） |
| AC-5 | `pnpm build` / `pnpm dev` / `pnpm preview` は従来どおり `wrangler.toml` / `wrangler.state.toml` を使う。`pnpm build` 後の成果物はローカルの値を持ち、`pnpm preview` で DO への往復が 200 | 自動テスト（パスの解決）＋コマンド出力 |
| AC-6 | `apps/web/package.json` のスクリプトについて: (a) `build:<stage>` が自分のステージの Vite config を使う (b) request 側の `deploy:<stage>` と `:dry` が自分のステージの `build:<stage>` の後に `dist/server/wrangler.json` をデプロイする (c) `:all` と `:all:dry` がビルド → state → request の順 (d) `wrangler deploy` / `wrangler dev` を呼ぶどのスクリプトも request 側のソース設定を渡さない。ステージの取り違え・順序の入れ替え・直渡しへの逆戻りでテストが落ちる | 自動テスト＋変異 |
| AC-7 | 描画スクリプトの出力先とビルドが読む設定のパスが同じ定義から決まる。未知のプレースホルダーは描画を中断する（既存の挙動の維持） | 自動テスト＋型 |
| AC-8 | ローカルの `.dev.vars`（Vite プラグインが `dist/server/` に複写する）の中身が、`wrangler deploy --dry-run` の添付モジュール一覧と `--outdir` の出力に入らない | `pnpm test:deploy`（`--outdir` の全ファイルを `.dev.vars` の 16 文字以上の値で検索して 0 件） |
| AC-9 | 文書が変更後の経路を述べる。対象: `README.md`（起動・デプロイの段落、コマンド一覧の注記）、`docs/runtime_cloudflare.md`（How to read の marker の例示、§2、§3 の Reality 注記と「The split does not hold locally」、§4.2、§4.5、§6 の「到達する経路が無い」、§14）、`.dev.vars.example` の `wrangler dev` 前提の記述、テンプレート 2 本とローカル設定 2 本のヘッダー、`docs/test.md`（deploy 層）。「デプロイできない／起動しない」と #3 への参照が残らない。§2 は「ソース設定の直 deploy は通らないが、`secret put --config` などの設定参照は有効」を区別して書く | コマンド出力（grep）＋差分の読み |
| AC-10 | 文書は観測の限界を自身の文で述べる: 実アップロードはこのリポジトリで未観測で、確かめているのは dry-run まで（bundle・設定の解決・アセットの読み取り）。§4.2 の Reality marker はその事実に合わせる。`wranglerConfig.test.ts` が見るのはテンプレート（Vite プラグインの入力）で、成果物は `pnpm test:deploy` が見る、という分担も書く | 差分の読み |

## 観測の限界

Cloudflare アカウントと Pulumi スタックがこの環境に無いため、実際のアップロード（`wrangler deploy` の API 呼び出し）は観測しない。`--dry-run` は bundle・設定の解決・アセットの読み取りまでを実行し、アップロードだけを省く。Issue の失敗点は bundle なので、dry-run がその失敗点を通過することを観測とする。

## スコープ

### 含まれるもの

- `apps/web/vite.config.cloudflare*.ts`、`apps/web/package.json` とルート `package.json` のスクリプト、`apps/web/scripts/render-wrangler.ts`、ステージ定義モジュール、描画の置換モジュール、それらのテスト、deploy スイートと `vitest.config.deploy.ts`、CI のジョブ 1 本、`docs/test.md`
- AC-9 / AC-10 の文書

### 含まれないもの

- state Worker のデプロイ経路の変更
- CI からの実デプロイ
- wrangler / `@cloudflare/vite-plugin` のバージョン更新
- #4（D1 の残骸）ほか §14 の他の行
- dry-run の `--outdir`（`dist/worker`、`dist/state`）の変更。`pnpm preview` / `pnpm start` は `dist/server`・`dist/client` と `.wrangler/deploy/config.json` しか読まず、干渉しない

## リスクと注意点

- ステージビルドは `dist/` と `.wrangler/deploy/config.json` を上書きする。その後の `pnpm preview` はステージのビルドを配信するので、`pnpm build` をやり直す必要がある旨を文書に書く（`pnpm start` は自分でビルドする）
