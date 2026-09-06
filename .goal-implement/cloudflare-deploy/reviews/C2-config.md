# C2 環境 config / runtime / build 独立レビュー

## 判定

2026-09-06T03:04:14+09:00 時点の総合判定は **FAIL**。CF02 の stage / DB 分離は資格情報不要範囲で PASS したが、CF03 の runtime fail-closed と CF06 の deploy artifact / secret 取扱いに blocker 4 件がある。外部 deploy と外部リソース変更は行っていない。

| 対象 | 判定 | 要約 |
| --- | --- | --- |
| CF02 stage isolation / runtime DB identity | PASS | Worker、host、APP URL、callback、sender、DB identity は両 stage で分離され、cross-stage config / migration と不正 remote URL を拒否した。実 remote DB への migration は未検証 gate のまま。 |
| CF03 callback / Email / Cron bindings | FAIL | 生成 config の callback、Email binding、2 cron は正しい。一方、runtime は required 扱いの Google secrets が両方ない状態と stage に対応しない sender を受理する。任意利用者宛 Email Service 送信は未検証。 |
| CF06 config / build / secret contract | FAIL | deterministic 生成、両 stage build / dry-run、leak scan は PASS。built config の runtime 設定 drift、同一 stage の stale bundle、Wrangler 子 process への runtime secrets 複製を防止できない。 |

## 検証対象

- repository: `/Users/hikaru/github.com/tuanemuy/fog`
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- phase report: `.goal-implement/cloudflare-deploy/phases/C2.md`
- manifest: 50 files / block SHA-256 `5702d555002392fc50befe5d736708fe458f83fe3d1abe1a220363d3664db9eb`
- manifest 検証: `awk ... phases/C2.md > /tmp/fog-c2-manifest.txt && sha256sum -c /tmp/fog-c2-manifest.txt` は 50 / 50 `OK`。レビュー終了時にも再照合した。
- 時刻: 2026-09-06T02:50:00+09:00〜2026-09-06T03:04:14+09:00

## Blocker

### B-CFG-001: required OAuth / stage sender が runtime で fail closed にならない

判定: **FAIL**（CF03、CF06）

`cloudflareStage.ts` は DB / Google の4 keyを required secret と宣言し、generated config と deploy preflight では必須にする。一方、`packages/core/src/application/di/serverCloudflare.ts:42-54` は Google 2 key を optional とし、片方だけの欠落しか拒否しない。両方欠落は受理され、Worker は Google login を無効化した状態で起動する。また `FOG_EMAIL_FROM` は email 形式だけを検査し、`DEPLOYMENT_ENV` / `APP_URL` に対応しない sender も受理する。

独立再現 `pnpm --filter @repo/web exec tsx /tmp/c2-runtime-negative.mts`:

```text
valid accepted=true
one-google-missing accepted=false
both-google-missing accepted=true
sender-cross-stage accepted=true
sender-external accepted=true
```

同じ matrix では wrong-stage DB、`http:`、`tls=0`、URL credential、credential query、HTTP APP URL、path 付き ambiguous APP URL、callback drift をすべて拒否した。

修正案:

- Cloudflare production contract では Google client ID / secret を両方必須にし、`runtimeSecrets()` と runtime schema の必須性を一致させる。
- `DEPLOYMENT_ENV` と `APP_URL` の host から期待 sender を導出し、staging は `fog-staging@<apex>`、production は `fog@<apex>` との完全一致を runtime でも検査する。
- 欠落2件と cross-stage / external sender を runtime test に追加する。

### B-CFG-002: built config の runtime 設定 drift を一致検査しない

判定: **FAIL**（CF06）

`apps/web/scripts/cloudflareStage.ts:76-87,209-223` の built schema / 比較対象に `compatibility_date`、`compatibility_flags`、`workers_dev` がない。source 側も `nodejs_compat` を含むことだけを検査し、余分な flag と重複を許可する。

独立再現 `pnpm --filter @repo/web exec tsx /tmp/c2-built-config-negative.mts`:

```text
compatibility-date-drift accepted=true
compatibility-flags-missing accepted=true
compatibility-flags-extra accepted=true
workers-dev-enabled accepted=true
source-extra-flag accepted=true
source-duplicate-flag accepted=true
```

`workers_dev` の既定値は true であり、明示 false の drift は公開面を変える。compatibility date / flags も runtime 挙動を決める設定である。

修正案:

- built schema に3 fieldを必須で追加し、source と完全一致させる。
- source の flags は設計上の exact set に固定し、未知値と重複を拒否する。
- 上記6ケースを負方向 test に追加する。

根拠: [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/)、[compatibility flags](https://developers.cloudflare.com/workers/configuration/compatibility-flags/)、[workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)。

### B-CFG-003: secret bulk / deploy が runtime secrets を子 process env に複製する

判定: **FAIL**（CF06）

`cloudflareSecrets.node.ts:44-56` は secret JSON を stdin へ渡すが、同時に `{ ...process.env, ...input.source }` を Wrangler 子 process の環境へ渡す。`cloudflareDeploy.node.ts:59-62` も同様である。phase report の「stdinだけで渡す」と一致しない。

独立 fake-runner 再現 `pnpm --filter @repo/web exec tsx /tmp/c2-negative.mts`:

```text
secret-bulk argvHasSecretValue=false
secret-bulk stdinKeys=DATABASE_URL,DATABASE_AUTH_TOKEN,FOG_GOOGLE_CLIENT_ID,FOG_GOOGLE_CLIENT_SECRET,FOG_AI_CLIENTS
secret-bulk childEnvSecretKeys=上記5 key + CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
deploy childEnvSecretKeys=同じ7 key
```

stdin と argv の設計自体は PASS した。問題は不要な runtime secret の環境継承であり、子 process、その plugin、診断出力の露出範囲を広げる。

修正案:

- secret bulk の child env から DB / Google / AI key を除き、Cloudflare auth と実行に必要な非 secret 環境だけを渡す。secret payload は stdin のみにする。
- deploy child env も runtime secret を除く。preflight は親 process 内で行い、Wrangler には Cloudflare auth だけを渡す。
- fake runner test で argv、stdin、child env の3経路を明示検査する。

根拠: Wrangler は file 指定を省略すると stdin を受ける。[Wrangler Workers commands](https://developers.cloudflare.com/workers/wrangler/commands/workers/)、[Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

### B-CFG-004: current config と同じ stage の stale bundle を deploy 前に識別できない

判定: **FAIL**（CF06、C3入力）

cross-stage は built `name` / vars の比較で拒否するが、deploy validation は bundle file の digest、source revision、build provenance を検査しない。current staging build の entry `0ee986c10329dd119f0ccd52b764aa15231ac7bc5d76d5e47a5bfd952b2e52bb` を旧 entry `89ef121d13d6e0a02c0eccf8e1c6a00b97e775647a69cefd0bb240a1d20c0792` に差し替え、current staging `wrangler.json` と組み合わせた。

`C2_STALE_BUILT_CONFIG=<temp>/server/wrangler.json pnpm --filter @repo/web exec tsx /tmp/c2-stale-dryrun.mts` は Wrangler 4.129.0 の dry-run に成功した。

```text
Total (136 modules)
Total Upload: 3355.36 KiB / gzip: 705.46 KiB
env.DEPLOYMENT_ENV ("staging")
--dry-run: exiting now.
```

修正案:

- build 時に stage、source config digest、checked-out Git SHA、entry / module digest を含む provenance manifest を生成する。
- deploy は expected SHA と provenance、実 file digest を照合し、欠落・不一致を拒否する。C3 は同じ immutable artifact を migration 後の deploy へ渡す。
- stale same-stage entry/config、欠落 provenance、改変 module を負方向 test に追加する。

## PASS の詳細

### deterministic generation / domain / stage isolation

- `DOMAIN=example.co.uk DATABASE_URL=... pnpm cloudflare:config render --stage staging` を2回実行し、両方 `269f38913b30952409fd699be5ab3043720207a8c311fd73a6f27dd7af8f8565`。
- production も2回実行し、両方 `06d0faf67528458406936933f5a98c89155a2e92de0eb3176706dc570a9c922b`。
- `validate --stage staging`、`validate --stage production`、`validate-pair` は PASS。
- ICANN matrix は valid 5件、reject 22件、誤判定0件。`example.com`、`example.co.uk`、大文字・周辺空白、punycode、`city.kawasaki.jp` を受理し、localhost、IP、public suffix、subdomain、private suffix、placeholder、URL/path/port、trailing dot、wildcard、raw Unicode、異常 label を拒否した。
- generated config は staging / production の Worker name、custom hostname、APP URL、callback、sender、DB identity を分離した。cron は `* * * * *` と `0 3 * * *`、Email binding は `EMAIL` と stage sender allowlist、required secrets は DB / Google 4 key である。
- production artifact を staging source で、staging artifact を production source で検査すると、いずれも runner 実行前に `Built config does not match source config: name` で拒否した。
- migration の `staging/../production` config path と `--stage ../../production` は exit 1。前者は `--config must be the generated staging config`、後者は stage enum error だった。

Custom Domain は所有する active zone 内の exact hostname が必要で、`custom_domain: true` の形は仕様どおりである。[Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。Cron は UTC で、config の2 triggerは `scheduled()` 契約に適合する。[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)。

### Vite configPath / build / dry-run

- staging / production とも `pnpm build:cloudflare:stage --stage <stage>` が PASS。entry は 813.30 kB / gzip 174.50 kB。
- wrapper が設定する `CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH` は Cloudflare Vite plugin の entry Worker config 解決順2位で、両 build の output `wrangler.json` は選択 stage の name、compatibility、workers_dev、route、cron、Email、secrets、vars と実値一致した。[Vite plugin API](https://developers.cloudflare.com/workers/vite-plugin/reference/api/)。
- staging / production とも `pnpm cloudflare:deploy --stage <stage> --dry-run` が PASS。Wrangler 4.129.0、136 modules、upload 3356.30 KiB / gzip 705.74 KiB。binding 表も選択 stage の sender、APP URL、DEPLOYMENT_ENV、DB identity を示した。
- build に DB / Google / AI / Cloudflare token sentinel と `CLOUDFLARE_INCLUDE_PROCESS_ENV=true` を与えたが、built / dry-run artifact の sentinel、raw DB URL、`.env*` / `.dev.vars*` は0件。`dist-cloudflare/server/.dev.vars` も build 後に存在しない。
- executable Node marker `node:fs` import、Node listener、SMTP transport、migration call は0件。`app/server.node.ts` 文字列は shared container の JSDoc / error text に4件残るが、Node module の import ではない。

### regression

| コマンド | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts` | PASS、1 file / 16 tests |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS、既存 `staticAssets.test.ts` の info 1件 |
| `pnpm format:check` | PASS、220 files |
| `pnpm test:unit` | PASS、15 files / 96 tests |
| `pnpm test:integration` | PASS、6 files / 94 tests |
| `pnpm test:integration:cloudflare` | PASS、2 files / 8 tests。shutdown 時の既知 `Called close before connection was established` 診断あり |
| `git diff --check` | PASS |

## 未検証 / 注意事項

### Email Service の任意利用者宛送信

**未検証**。Wrangler dry-run は binding を `unrestricted - senders: ...` と表示するが、2026-09-06 時点の公式説明では recipient restriction なしは account の「verified destination address」への送信である。任意の fog 利用者の password-reset address への実送信を保証しない。実 account の onboarding と未登録 recipient 宛送信を gate に残し、不可能なら設計どおり HTTPS mail provider adapter に切り替える。[Configure send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)、[Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)。

### symlink

**注意**。通常 CLI の stage と migration path traversal は拒否した。一方、`renderConfig({ output })` は symlink parent を検査せず、temp test では `/tmp/.../link -> /tmp/.../outside` を経由して outside の `wrangler.json` を作成した。CLI render は固定 output のため直ちに外部入力から到達しないが、persistent / self-hosted runner の workspace を信頼する前提が必要である。生成 root の各 parent を `lstat` / `realpath` で検査して symlink を拒否し、production API から任意 `output` を外すことを推奨する。

### 外部 gate

- 実 Cloudflare zone / custom domain ownership / DNS / TLS。
- 実 staging / production remote libSQL、token、migration、DB identity の独立性。
- Email Service onboarding、sender authorization、未登録 recipient 宛の reset mail。
- Google OAuth の2 callback 登録と実 login。
- Cloudflare secret state、account permission、実 deploy。

これらは外部資格情報と変更許可がないため未検証であり、本レビューでは deploy を実行していない。

## 最終再検証 2026-09-06T03:46:51+09:00

### 判定

総合判定は **FAIL**。B-CFG-001〜003、B-CFG-004 の server artifact 範囲、symlink 注意は PASS した。B-CFG-004 の provenance が Wrangler の static assets を含まないため、CF06 は FAIL を維持する。

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CF02 stage isolation / runtime DB identity | PASS | 54-file manifest、両 stage config、DB authority、secure URL、cross-stage 拒否を再照合した。 |
| CF03 callback / Email / Cron bindings | PASS | Google secrets は両方必須。sender、callback、Email binding、cron は stage / domain と一致する。実 Email / OAuth は外部 gate のまま。 |
| CF06 config / build / secret contract | FAIL | exact config、child env、server provenance、安全な path、両 stage build / dry-run は PASS。client artifact 改変を provenance が検出しない。 |

検証対象は HEAD `7d449cf62c548f2084b30568b3f99e5535b37a28` と C2 の新54-file manifest である。manifest block SHA-256 は `da33ce61cd822db7ae1363a2f3dcfdd6773c9cc64ac94d0e44d5181e65273ba4`。開始時、他 Verifier の一時 test 削除後、終了時の3回とも54 / 54一致した。

### B-CFG-001: PASS

`pnpm --filter @repo/web exec tsx /tmp/c2-runtime-negative.mts` で元の負方向ケースを再実行した。

- Google client ID または secret の片方欠落を拒否した。
- Google 2 key の両方欠落を拒否した。
- staging runtime の production sender と external sender を `FOG_EMAIL_FROM does not match DEPLOYMENT_ENV` で拒否した。
- wrong-stage DB、`http:`、`tls=0`、URL credential、credential query、HTTP / path付き APP URL、callback drift も拒否した。
- valid staging runtime env は受理した。

`serverCloudflare.ts` の2 Google keyは必須 schemaである。sender は `DEPLOYMENT_ENV` と `APP_URL` から導出した値との完全一致を検査する。

### B-CFG-002: PASS

`pnpm --filter @repo/web exec tsx /tmp/c2-built-config-negative.mts` は次の6ケースをすべて拒否した。

- built `compatibility_date` drift
- built compatibility flags の欠落と余分な flag
- built `workers_dev=true`
- source の余分な flag と重複 flag

source schema は `compatibility_date=2026-08-04`、`compatibility_flags=["nodejs_compat"]`、`workers_dev=false` を exact に固定する。built validator は3 fieldを含む runtime 設定、全 top-level key、空 binding defaults、`configPath`、entry、assets を exact に検査する。

### B-CFG-003: PASS

`pnpm --filter @repo/web exec tsx /tmp/c2-final-child.mts` で hostile whitespace / 改行 / shell metacharacter を含む secret を fake runner へ渡した。

```text
secret-bulk argvSecret=false envRuntimeKeys=[]
secret-bulk envAuthKeys=[CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID]
secret-bulk stdinKeys=[DATABASE_URL,DATABASE_AUTH_TOKEN,FOG_GOOGLE_CLIENT_ID,FOG_GOOGLE_CLIENT_SECRET]
deploy argvSecret=false envRuntimeKeys=[]
deploy envAuthKeys=[CLOUDFLARE_API_TOKEN,CLOUDFLARE_ACCOUNT_ID]
```

runtime DB / Google / AI secret は secret bulk の JSON stdin だけに入り、argv と child env には入らない。deploy child env も Cloudflare auth と allowlist 済み system keys だけである。

### B-CFG-004: FAIL

server bundle、SHA、dirty checkout の修正は PASS した。

- `pnpm --filter @repo/web exec tsx /tmp/c2-final-provenance.mts` は別 SHA、stale entry、stale server module tree、dirty build、dirty current checkout をすべて拒否した。
- fresh staging `server/index.js` の末尾へ有効な JS comment を加えると、`pnpm cloudflare:deploy --stage staging --dry-run` は exit 1、`Cloudflare artifact provenance mismatch: builtEntryDigest` となった。
- build 後に別 Verifier の一時 product test が追加された際も、dry-run は `workspaceDigest` mismatch で停止した。一時 test 削除後の54 / 54 manifestを確認して再buildした。
- current worktree は未コミット実装を含むため、実 side effect の migration、secret sync、deploy はすべて `Cloudflare side effects require a clean checkout provenance` で client / child 作成前に停止した。

static client artifact は未保護である。fresh build の `dist-cloudflare/client/favicon.svg` は SHA-256 `33b6f323029c9f5f84c9a42424f12496b0deb2ab7d873c46b21c444f7152989c`。有効な SVG comment を加えて `b2497c9657dd0b7cbb71e4c5770a305bc14e15c4c40e2419b9c1f91a1164d2c5` に変更しても、同じ provenance で staging dry-run が成功した。

```text
Read 69 files from the assets directory .../dist-cloudflare/client
Total Upload: 3356.79 KiB / gzip: 705.83 KiB
env.DEPLOYMENT_ENV ("staging")
--dry-run: exiting now.
```

`cloudflareProvenance.node.ts` の `artifactTreeDigest()` は `dist-cloudflare/server` だけを走査する。built config の `assets.directory` は `../client` であり、Wrangler は client tree も deploy artifact として upload する。client file の内容、追加・削除、symlink、hardlink は build 後に検出されない。

修正案:

- provenance に `clientDigest` を追加するか、`dist-cloudflare/server` と `dist-cloudflare/client` を一つの artifact digest に含める。
- client tree も path、相対 filename、内容を hash し、symlink と hardlink を拒否する。
- client file の内容変更、追加、削除、symlink、hardlink を負方向 test に追加する。

検証後に production を再buildした。`favicon.svg` は元の SHA-256へ戻り、fresh provenance と production dry-run は PASS した。

### symlink / path traversal / atomic write: PASS

`pnpm --filter @repo/web exec tsx /tmp/c2-final-fs.mts` の結果:

```text
normalMode=600
tempAfterSuccess=[]
symlinkRejected=true
hardlinkRejected=true
traversalRejected=true
```

stage traversal と cross-stage migration config path も exit 1。generated config は同一内容の再生成で同じ SHA-256となり、mode 0600、残存 `.fog-write-*` directory 0件だった。production artifact を staging dry-runへ渡すと、runner 起動前に `Built config does not match source config: name` で拒否した。

### build / dry-run / leak scan: PASS

- staging build: entry 813.80 kB / gzip 174.60 kB。Wrangler dry-runは136 modules、3356.79 KiB / gzip 705.83 KiB。
- production build: entry 813.80 kB / gzip 174.60 kB。Wrangler dry-runは136 modules、3356.79 KiB / gzip 705.83 KiB。
- production built config と generated source は name、compatibility、workers_dev、route、cron、Email、secrets、vars が一致した。`configPath` と `userConfigPath` も production generated config の絶対 path と一致した。
- DB / Google / AI / Cloudflare token sentinel、raw DB URL、`.env*` / `.dev.vars*`、Node listener / fs / net、SMTP、migration call は artifact 内0件だった。
- build / dry-run後の `.fog-write-*` と `.vite-rsc-temp` は0件だった。

### regression: PASS

| コマンド | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts` | PASS、1 file / 38 tests |
| `pnpm test:unit` | PASS、15 files / 118 tests |
| `pnpm test:integration` | PASS、6 files / 94 tests |
| `pnpm test:integration:cloudflare` | PASS、2 files / 8 tests。shutdown 時の既知診断あり |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS。既存 `staticAssets.test.ts` の info 1件 |
| `pnpm format:check` | PASS、224 files |
| `git diff --check` | PASS |

実 Cloudflare / Turso / Email / Google resource と実 deploy は未検証 gateを維持する。外部状態は変更していない。

## 最終再検証 2 2026-09-06T04:16:27+09:00

### 判定

総合判定は **PASS**。前回残った B-CFG-004 の client artifact 保護を provenance v2 が解消した。CF02、CF03、CF06 のローカル受入範囲に新しい blocker はない。実 Cloudflare / Turso / Email / Google resource と実 deploy は未検証 gate を維持する。

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CF02 stage isolation / runtime DB identity | PASS | 両 stage config、secure DB URL、runtime identity、cross-stage config / artifact 拒否を再確認した。 |
| CF03 callback / Email / Cron bindings | PASS | callback、stage sender、Email binding、2 cron、Google secrets 必須性は source、built config、runtime で一致する。 |
| CF06 config / build / secret / provenance contract | PASS | provenance v2 は server と client の deploy tree を保護する。exact config、secret child env、安全な file 操作、両 stage build / dry-run、漏洩 scan も PASS した。 |

検証対象は HEAD `7d449cf62c548f2084b30568b3f99e5535b37a28` と C2 の新54-file manifestである。manifest block SHA-256 は `0293b0521199d7d5100f4df1c192f8941a82fec42e9a9f458f2b60316443957d`。`sha256sum -c /tmp/fog-c2-manifest-final2.txt` は開始時と別Verifierの一時test削除後の終了時に54 / 54一致した。外部 deploy と外部状態変更は行っていない。

### provenance v2 / B-CFG-004: PASS

fresh staging artifact に対する実改変後、毎回 `pnpm cloudflare:deploy --stage staging --dry-run` を実行した。全ケースが exit 1で、Wrangler 4の起動 header は0件だった。各改変は直後に復元した。

| 改変 | 観測結果 |
| --- | --- |
| `client/favicon.svg` 内容 | `Cloudflare artifact provenance mismatch: clientDigest` |
| `client/favicon.svg` mode 0644→0600 | `Cloudflare artifact provenance mismatch: clientDigest` |
| client file 追加 | `Cloudflare artifact provenance mismatch: clientDigest` |
| `favicon.svg` renameによる旧path削除 / 新path追加 | `Cloudflare artifact provenance mismatch: clientDigest` |
| client symlink追加 | `Cloudflare artifact tree must not contain symbolic links` |
| client hardlink追加 | `Cloudflare files must not be hard linked` |
| `server/index.js` 内容 | `Cloudflare artifact provenance mismatch: builtEntryDigest` |

復元後の `favicon.svg` は mode 0644、link count 1、SHA-256 `33b6f323029c9f5f84c9a42424f12496b0deb2ab7d873c46b21c444f7152989c`。entryは `df53925fbb2da5be4d2ce8d4afcd604d138c0248f3b8ae1da66fa97504a77e6a` へ戻った。

`pnpm --filter @repo/web exec tsx /tmp/c2-final-provenance.mts` では valid v2だけを受理し、別SHA、別stage、stale entry、stale server tree、stale client tree、dirty build、dirty current checkoutを拒否した。さらにfresh productionのprovenance fileだけを別stage、別SHAへ改変して実dry-runを行い、それぞれ `Cloudflare artifact provenance mismatch: stage` と `...: gitSha`、exit 1、Wrangler header 0件を観測した。復元後のproduction dry-runは再びPASSした。実 staging buildをproduction dry-runへ、実 production buildをstaging dry-runへ渡したケースも、いずれも `Built config does not match source config: name`、exit 1、Wrangler header 0件だった。

current checkoutは実装差分を含むため、fake資格情報で正しい generated configを指定した migration、secret sync、deploy side effectの3入口を実行した。すべて `Cloudflare side effects require a clean checkout provenance` でDB client / child / Wrangler作成前に停止した。

`cloudflareProvenance.node.ts` はversion 2の `serverDigest` と `clientDigest` を記録し、relative path、entry type、permission mode、file内容を決定的にhashする。tree内のsymlink、hardlink、regular file / directory以外も拒否する。focused testの favicon内容 / mode / 追加 / 削除、symlink、hardlinkを含む42件も全件PASSした。

### B-CFG-001〜003 / file安全性: PASS

- `/tmp/c2-runtime-negative.mts` はvalid envだけを受理し、Google片方欠落 / 両方欠落、cross-stage / external sender、wrong-stage DB、`http:`、`tls=0`、credential / token query付きDB URL、HTTP / path付きAPP URL、callback driftをすべて拒否した。
- `/tmp/c2-built-config-negative.mts` はbuilt compatibility date drift、flags欠落 / 余分、`workers_dev=true`、source flagsの余分 / 重複をすべて拒否した。
- `/tmp/c2-final-child.mts` ではsecret bulk / deployともruntime secretのargv混入はfalse、child envのruntime keyは空だった。Cloudflare authだけがchild envへ入り、bulk secretはJSON stdinだけに入った。
- `/tmp/c2-final-fs.mts` は生成file mode 0600、残存temporary directory 0、symlink parent、hardlink target、path traversalをすべて拒否した。

staging / production configをそれぞれ同じ入力で2回renderし、SHA-256は各 stage内で一致した。stagingは `ae0e548d4df2dbfcf05f10498c3d60ca99698d193a69ad2d378156fcf80b2496`、productionは `4d797cb401ef5958ee9719e9a0bfbcfde07245a7ecb4cfe8b93352b6b3285f11`。`cloudflare:config validate-pair` もPASSした。

fresh production built configを `validateBuiltStageConfig` でsourceとexact照合した。`name=fog-production`、`configPath` / `userConfigPath` は生成したproduction configの絶対pathである。compatibility、workers.dev、route、assets、cron、Email sender allowlist、vars、secretsを含む契約もdry-run前検査を通過した。

### build / dry-run / leak scan: PASS

- fresh staging buildとWrangler 4.129.0 dry-run: PASS。136 modules、client 69 files、3356.79 KiB / gzip 705.83 KiB。
- fresh production buildとWrangler 4.129.0 dry-run: PASS。同じ136 modules、client 69 files、3356.79 KiB / gzip 705.83 KiB。
- DB / Google / AI / Cloudflare sentinel、raw DB URL、`.env*` / `.dev.vars*` はartifact内0件。
- `node:fs` / `node:net` / `node:tls` / `node:child_process`、Node listener、SMTP、Cloudflare migration markerはserver JS内0件。
- `.fog-write-*` / `.vite-rsc-temp` 残存directoryは0件。
- 最終artifactはfresh production build + provenance v2 + production dry-run PASSの状態に戻した。provenanceは `stage=production`、`clientDigest=a45289ca1db459f437c70cdcbab3793422eb81a54f2ae455cb6cab2744ce007e` である。

### regression: PASS

| コマンド | 結果 |
| --- | --- |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts` | PASS、1 file / 42 tests |
| `pnpm test:unit` | PASS、15 files / 122 tests |
| `pnpm test:integration:node` | PASS、6 files / 94 tests |
| `pnpm test:integration:cloudflare` | PASS、2 files / 8 tests。shutdown時の既知診断あり |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS。既存 `staticAssets.test.ts` のinfo 1件 |
| `pnpm format:check` | PASS、224 files |
| `pnpm build:node` | PASS |
| `git diff --check` | PASS |

外部資格情報を必要とするcustom domain / DNS / TLS、stage別remote libSQL migration、Email Serviceの未登録recipient宛送信、Google OAuth callback、secret state、実deployは未検証である。
