# C1 Cloudflare runtime 独立レビュー

## 判定

**FAIL**。CF01 の Workers custom entry、TanStack Start RSC、AsyncLocalStorage、workerd KDF、Cloudflare build、Wrangler dry-run は PASS した。CF03 の Cron 分岐と Email adapter も、資格情報を要しない範囲では PASS した。

CF02 の remote client 境界は FAIL である。空白だけの `DATABASE_AUTH_TOKEN` を有効値として受理するため、phase report の「空 token を拒否する」という記載と一致しない。`http:`、`ws:`、`libsql:?tls=0` も受理し、DB token とデータを平文接続へ渡せる。C2 の environment 設定前に境界を修正する必要がある。

実 remote libSQL、実 Workers isolate、Cloudflare Email Service account は資格情報がないため未検証である。製品コード、`design.md`、`plan.md`、phase report は変更していない。本書だけを追加した。

## 検証対象

- 検証日時: 2026-09-06 00:59-01:12 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- phase report: `.goal-implement/cloudflare-deploy/phases/C1.md`
- manifest: phase report 記載の30ファイル
- manifest block SHA-256: `dbf38533f255a38d5a682e20dda48a2fa0df2bf75c24c2e1eb0dab689d804665`
- manifest照合: **30/30一致**。検証開始時と終了時の `sha256sum -c -` は全項目 `OK`
- build artifact SHA-256: `index.js` は `ed58a801c14ca9dd39be223bec79dec5cd58be7ace470e40db5ca22c19a6e7bc`、生成 `wrangler.json` は `6ac5028642be0058690b1d1595a875525ea339a4a0ac79705869bbe80aa21a3a`
- worktree: manifest 対象外の既存変更を含む。合否判断は HEAD と一致確認済み manifest を対象にした

## 項目別判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| manifest | PASS | phase report の30件を実ファイルへ照合し、30/30一致した。 |
| CF01 custom Worker entry | PASS | `server.cloudflare.ts` は module Worker の `fetch` と `scheduled` を公開する。公式の custom entry patternと一致する。 |
| CF01 TanStack Start / RSC | PASS | Cloudflare Vite plugin の `ssr` + `rsc` child environment、TanStack custom server entry、RSC pluginでbuildできた。実workerdの `/login?returnTo=%2Ftimeline` と `/password/forgot` は200を返した。 |
| CF01 request scope / AsyncLocalStorage | PASS | `defaultEntry.fetch()` を `storage.run(requestContainer, ...)` 内で呼ぶ。`__root.tsx` が `getContainer()` を使う実RSC routeもworkerdで200となり、request scopeの接続を確認した。 |
| CF01 env validation | **FAIL** | local DBとlocal encryption key、Google pair、Email pairは拒否する。空白 token はZodとclient factoryの両方を通過する。remote URLのtransport securityも制限しない。B-RT-001参照。 |
| CF01 health | PASS（failure path）/ readiness未検証 | fake remote URLで実workerdの `/healthz` は503 `unavailable` を返した。mock health成功時の200はworkerd testで確認した。実remote DBを使うready状態は未検証。 |
| CF01 KDF workerd | PASS（local） | workerdで実scryptのhash、正誤verify、固定dummy hash、active 1、queue 2、4件目のretryable `CAPACITY_EXCEEDED`を確認した。2 files / 8 testsの全体suiteもPASSした。 |
| CF01 KDF 実Workers resource | 未検証 | 実isolateのCPU時間、128 MiB memory accounting、3件以上の同時HTTP request、request abortは資格情報とdeploy許可がないため未検証。 |
| CF01 build / dry-run | PASS | Cloudflare production build、Node build、Wrangler dry-runが成功した。dry-runは136 modules、code 2,560.01 KiB、upload 3,344.55 KiB、gzip 703.18 KiB。 |
| CF01 Node-only exclusion | PASS | dry-run出力でSMTP、Node listener、signal、filesystem、migration、Node worker runnerを検索し0件だった。bundleのlibSQL実装は`lib-esm/web.js`、HTTP、WSだけで、native SQLite packageを含まない。 |
| CF02 `@libsql/client/web` boundary | PASS | Workers factoryは`@libsql/client/web`を直接importする。`:memory:`と`file:`を構築前に拒否する。共有UoWのvalue importはgeneric packageだが、Workers bundleではweb exportへ解決された。 |
| CF02 token / transport validation | **FAIL** | 空白 token、`http:`、`ws:`を独立再現で受理した。`libsql:` URLの`tls=0`も除外していない。B-RT-001参照。 |
| CF02 interactive transaction | PASS（mock/local）/ remote未検証 | workerd mockで`transaction("read")`と`transaction("write")`、commit、closeを確認した。実remoteのcommit、rollback、5秒timeout、busy error code、retryは未検証。 |
| CF03 scheduled dispatch | PASS（local）/ remote未検証 | `* * * * *` と `0 3 * * *` を定数で分岐する。workerd mockで両処理を確認した。実Workerのunknown cronは200 `ok`で副作用なし。DBを使う2本はfake remote URLで500となるため、実remote成功経路は未検証。 |
| CF03 Email payload | PASS（local） | structured `send()`へ任意の`to`、`from`、件名、text、`X-Fog-Message-ID`を渡す。workerd testで任意recipientとstable outbox IDを確認した。公式Workers APIとcustom header契約に一致する。 |
| CF03 Email error | PASS（static/direct） | binding例外をcause付きretryable `SystemError(EXTERNAL_API_ERROR)`へ変換する。独立実行で`kind=system`、`retryable=true`、cause保持を確認した。 |
| CF03 Email binding / delivery | 未検証（C2 gate） | generic `wrangler.jsonc` と生成configの`send_email`は空である。実accountのBeta有効化、sender onboarding、quota、suppression、任意recipient配送は未検証。 |

## Blocker

### B-RT-001: remote database credentialを空白・平文接続へ渡せる

- 場所:
  - `packages/core/src/application/di/serverCloudflare.ts:20-22`
  - `packages/core/src/adapters/libsql/client.web.ts:10-18`
- 問題:
  - `z.string().min(1)` と `if (!options.authToken)` は空白だけのtokenを拒否しない。
  - URL allowlistが `http:` と `ws:` を含む。
  - `libsql:` URLの `tls=0` query parameterを拒否しない。libSQL clientはこのparameterでTLSを無効化する。
  - phase reportの「空 token を拒否する」は、空文字に限れば正しいが、設定境界の必須値検証として不十分である。
  - 誤設定時はbootが成功し、公開routeを返しながらDB処理だけが失敗する。平文URLではsecretとDB通信の機密性も失う。
- 独立再現:

```text
{"url":"http://example.com","token":"nonblank","accepted":true}
{"url":"ws://example.com","token":"nonblank","accepted":true}
{"url":"https://example.com","token":"blank","accepted":true}
{"url":"libsql://database.example.com:8080?tls=0","accepted":true,"protocol":"http"}
```

- 必須修正:
  - `DATABASE_AUTH_TOKEN` はtrim後1文字以上を要求する。入力を正規化してからenv型とclient factoryの両方で同じ契約を使う。
  - production remote URLは`https:`、`wss:`、TLS有効の`libsql:`だけを受理する。`http:`、`ws:`、`tls=0`を拒否する。local serverの平文接続が必要なら、loopback限定の明示的なdevelopment contractへ分離する。
  - `""`、空白、`:memory:`、`file:`、`http:`、`ws:`、`libsql://host:port?tls=0`のtable-driven testをworkerd suiteへ追加する。
  - C2のconfig rendererも同じvalidatorを使い、deploy前に失敗させる。

## 実 Worker 検証

Cloudflare Vite pluginのlocal workerdを、外部へ到達しない予約用fake hostnameで起動した。

```bash
CLOUDFLARE_INCLUDE_PROCESS_ENV=true \
  DATABASE_URL=libsql://fog-c1-verification.invalid \
  DATABASE_AUTH_TOKEN=verification-token \
  APP_URL=http://localhost:3000 \
  pnpm --filter @repo/web dev:cloudflare
```

| Request | 結果 | 判断 |
| --- | --- | --- |
| `GET /login?returnTo=%2Ftimeline` | 200、4,769 bytes | custom entry、TanStack SSR/RSC、root request containerはPASS。 |
| `GET /password/forgot` | 200、4,562 bytes | password recovery routeのrenderはPASS。 |
| `GET /healthz` | 503、`unavailable` | fake DBに対するfailure pathはPASS。ready pathは未検証。 |
| `GET /cdn-cgi/handler/scheduled?cron=unknown` | 200、`ok` | 実scheduled handlerへの到達とunknown分岐はPASS。 |
| `GET /cdn-cgi/local/scheduled?cron=unknown` | 200、`ok` | Vite local endpointでも同じ分岐を確認した。 |
| `GET /cdn-cgi/handler/scheduled?cron=* * * * *` | 500、`exception` | handlerへ到達した。fake DBのためreset outbox成功経路は未検証。 |

初回起動では`DATABASE_URL`をprocess envへ渡さなかったため、repositoryの`.env`にあるlocal DB URLが読み込まれ、bootが「remote libSQL URL」で失敗した。`DATABASE_URL`をprocess envへ明示した再起動では上記結果となった。local developmentで読み込むenv sourceと必要値を運用手順へ明記する必要がある。

## Build artifact

`pnpm build:cloudflare` は専用 `dist-cloudflare` へ出力した。`wrangler deploy --dry-run` は外部変更なしでupload artifactを生成した。

```text
Total (136 modules): 2560.01 KiB
Total Upload: 3344.55 KiB / gzip: 703.18 KiB
NODE_ONLY_SCAN=0
SECRET_ENV_FILES=0
```

検索語は `nodemailer`、`smtpMailer`、`node:fs`、`SIGTERM`、`SIGINT`、`listen.node`、`migrateFog`、`fogResetMailRunner`、`fogRetentionRunner`、`setInterval(tick` である。`dist-cloudflare/server/.dev.vars` はbuild directoryに生成され、key名は`DATABASE_URL`と`APP_URL`だった。Wrangler dry-run出力には`.dev.vars`と`.env`を含まない。

C3でbuild directory全体をCI artifactとして保存する場合は`.dev.vars`を除外する。Wrangler uploadだけを使う場合、今回のdry-runではsecret file混入はない。

## 独立コマンド結果

| 実行 | 結果 |
| --- | --- |
| manifest抽出 + `sha256sum -c -` | PASS。30/30一致。開始時と終了時に実行。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm format:check` | PASS。209 files。 |
| `pnpm lint` | PASS。195 files。既存`staticAssets.test.ts:42`のinfo 1件。 |
| `pnpm test:integration:cloudflare` | PASS。2 files / 8 tests、5.55秒。実workerd + 実scrypt。 |
| `pnpm build:node` | PASS。Node runtime回帰。 |
| `pnpm build:cloudflare` | PASS。Workers entry 803.37 kB、gzip 172.31 kB。最終再実行もPASS。 |
| `pnpm --filter @repo/web exec wrangler deploy --dry-run --config dist-cloudflare/server/wrangler.json --outdir <tmp>` | PASS。deployなし。 |
| dry-run artifact `rg` scan | PASS。Node-only検索語0件。env/secret file 0件。 |
| direct boundary table | **FAILを再現**。`http:`、`ws:`、空白tokenを受理。 |
| Email failure direct test | PASS。`EXTERNAL_API_ERROR`、retryable、cause保持。 |

## 公式根拠

- [Cloudflare TanStack Start custom entrypoints](https://developers.cloudflare.com/workers/framework-guides/web-apps/tanstack-start/): custom entryから`fetch`と`scheduled`を公開する構成、local scheduled endpointを確認した。2026-09-06参照、ページ更新日は2026-06-25。
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/): workerdを使うlocal development、production build、previewの位置付けを確認した。2026-09-06参照、ページ更新日は2026-07-03。
- [Cloudflare Email Service Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/): structured `send()`、任意の`to`、text、headers、`messageId`、標準Errorを確認した。2026-09-06参照、ページ更新日は2026-06-25。
- [Cloudflare Email headers](https://developers.cloudflare.com/email-service/reference/headers/): `X-` prefixのcustom headerが許可されることを確認した。2026-09-06参照、ページ更新日は2026-08-25。
- [Turso TypeScript SDK reference](https://docs.turso.tech/sdk/ts/reference): interactive transactionと5秒timeoutを確認した。2026-09-06参照。
- [libSQL client changelog](https://github.com/tursodatabase/libsql-client-ts/blob/main/CHANGELOG.md): `libsql:` URLの`tls=0`がTLSを無効化する契約を確認した。2026-09-06参照。

## 再レビュー条件

1. B-RT-001を修正し、workerdのtable-driven境界testを追加する。
2. 更新したmanifestを固定し、typecheck、workerd suite、Cloudflare build、dry-run、Node-only scanを再実行する。
3. C2でenvironment別Email binding、sender、remote DB、secretを生成configへ設定する。
4. stagingでremote transaction、health 200、2本のconfigured cron、Email任意recipient配送、KDFのCPU/memory/HTTP concurrencyを検証する。

CF02 retention/applicationの判定は`reviews/C1-core.md`を参照する。同レビューのblockerは本runtimeレビューの対象外である。

## 再検証 2026-09-06

### 判定

**PASS**。B-RT-001 は解消した。remote libSQLの共通validatorは空白token、平文scheme、TLS解除、重複・未知query、URL内credential、fragmentを拒否する。TLS付きremote URLとtrim済みtokenだけをclientへ渡す。初回レビューでPASSだったcustom entry、RSC、AsyncLocalStorage、KDF、Cron、Email adapter、build、dry-run、Node-only exclusionも維持している。

実remote libSQL、実Workers isolateのCPU・memory、Cloudflare Email Service実配送は未検証のままである。C2以降のstaging gateを変更しない。

### 検証対象

- 検証日時: 2026-09-06 01:34-01:38 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- 基準: `.goal-implement/cloudflare-deploy/phases/C1.md` の「再検証 SHA-256 manifest」
- manifest: 41/41一致
- manifest block SHA-256: `2131b5d8d08a250a076073a67d95f602517baa22cab47a77b20eca2c9f19e6a0`
- Cloudflare entry artifact SHA-256: `a21f0a423f48415a10a7d427d08e16a21658e5eda7ff0c5a2f3479a05ba72395`
- 生成 `wrangler.json` SHA-256: `6ac5028642be0058690b1d1595a875525ea339a4a0ac79705869bbe80aa21a3a`

manifestは検証開始時と全コマンド終了後に照合した。両時点とも41/41が一致した。

### B-RT-001

| 観点 | 判定 | 根拠 |
| --- | --- | --- |
| 共通境界 | PASS | `normalizeRemoteLibsqlUrl()`をenv parserとWorkers client factoryが共有する。 |
| 空白token | PASS | `""`、space、tab/newlineをclient factoryで拒否した。env parserもtrim後の空白を拒否する。 |
| token正規化 | PASS | `" token "`は`"token"`となり、env値とclient入力の両方で確認した。 |
| 平文scheme | PASS | `http:`と`ws:`を拒否した。 |
| TLS解除 | PASS | `libsql://database.example.com:8080?tls=0`、`tls=false`を拒否した。 |
| 曖昧query | PASS | 重複`tls`、大文字`TLS`、未知query、`tls=1`と未知queryの併用を拒否した。percent encoded `tls=0`も拒否した。 |
| URL credential | PASS | user/password、`authToken`、`auth_token`、`access-token`を拒否した。未知queryも一律拒否する。 |
| fragment / local URL | PASS | fragment、`:memory:`、`file:`を拒否した。 |
| 許可URL | PASS | `libsql:`、`libsql:?tls=1`、`https:`、`wss:`を受理した。前後空白はtrimした。 |
| workerd回帰test | PASS | 更新testは拒否12種、空白token、許可4種、env正規化を検証する。suite全体は2 files / 8 tests PASS。 |

独立tableは実装testに含まれない追加ケースも含め、拒否14種・許可5種を実行した。結果は`FAILURES=0`だった。

```text
ALLOW "libsql://database.example.com"
ALLOW "libsql://database.example.com?tls=1"
ALLOW "https://database.example.com"
ALLOW "wss://database.example.com"
ALLOW "  https://database.example.com/path  " => https://database.example.com/path
ENV_NORMALIZED url=libsql://database.example.com token=token
REJECT_COUNT=14 ALLOW_COUNT=5 FAILURES=0
```

### 回帰結果

| 実行 | 結果 |
| --- | --- |
| `pnpm format:check` | PASS。212 files。 |
| `pnpm lint` | PASS。198 files。既存`staticAssets.test.ts:42`のinfo 1件だけ。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm test:unit` | PASS。14 files / 78 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 88 tests。 |
| `pnpm test:integration:cloudflare` | PASS。2 files / 8 tests。実workerd + 実scrypt。 |
| `pnpm build:node` | PASS。 |
| `pnpm build:cloudflare` | PASS。entry 807.91 kB、gzip 173.47 kB。artifact hashはphase reportと一致した。 |
| Wrangler deploy dry-run | PASS。136 modules、code 2,561.22 KiB、upload 3,350.20 KiB、gzip 704.58 KiB。外部deployなし。 |
| dry-run artifact scan | PASS。Node-only検索語0件、`.dev.vars` / `.env` 0件。 |
| actual local workerd | PASS範囲維持。login 200 / 4,769 bytes、password forgot 200 / 4,562 bytes、unknown scheduled 200 / `ok`。 |
| actual local health | PASS（failure path）。fake remote URLのため503 / `unavailable`。実remote DBのready pathは未検証。 |

workerd suiteはexit 0で全8 testがPASSした。接続前clientをcloseするURL境界testに伴い、workerdが`Called close before connection was established`を1件stderrへ出した。HTTP request処理やtest failureではない。

dry-run scanの検索語は初回と同じ`nodemailer`、`smtpMailer`、`node:fs`、`SIGTERM`、`SIGINT`、`listen.node`、`migrateFog`、`fogResetMailRunner`、`fogRetentionRunner`、`setInterval(tick`である。bundleのlibSQLは`@libsql/client/lib-esm/web.js`へ解決され、native SQLite packageを含まない。

最初のdry-run検証器はzshの予約済みread-only変数`status`への代入でscan前に終了した。変数名を`task_status`へ修正した同一dry-runはexit 0となり、上記artifactとscan結果を得た。製品の失敗ではない。

### 未検証

- Workersから実remote libSQLへのtransaction、rollback、5秒timeout、busy error code、retry。
- 実Workers isolateでのKDF CPU時間、memory accounting、同時HTTP request、abort。
- 実Cloudflare Email Service binding、sender onboarding、任意recipient配送、quota、bounce、suppression。
- environment別config、remote migration、OAuth callback、custom domain、staging health 200、configured cron成功。

### 現在の再レビュー条件

B-RT-001に追加修正は不要である。C2は同じ共通validatorを生成configへ適用し、stagingで未検証項目を確認する。

## 最終照合 2026-09-06

### 判定

**PASS**。B-CORE-003修正後の41件manifestへ、受入済みruntime判定を適用できる。runtime、KDF、remote DB URL境界、Cron、Emailの対象ファイルは前回再検証時から不変である。型検査、workerd、Cloudflare build、Wrangler dry-run、Node-only scanも現manifestでPASSした。

### 検証対象

- 検証日時: 2026-09-06 02:04-02:05 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- 基準: `.goal-implement/cloudflare-deploy/phases/C1.md` の「B-CORE-003 再検証 SHA-256 manifest」
- manifest: 41/41一致
- manifest block SHA-256: `00f3d5661e0f3de0945ce6fa286287b315b2adc2604f977152e13d4f65ff3815`
- Cloudflare entry artifact SHA-256: `c48b11cbd665fa478ef6702b3d0e5e90d2ee91a4a755bc15e6b1b1b22fdcd345`
- 生成 `wrangler.json` SHA-256: `6ac5028642be0058690b1d1595a875525ea339a4a0ac79705869bbe80aa21a3a`

manifestは検証開始時とコマンド終了後に照合した。両時点とも41/41が一致した。

### 適用可能性

前回から次のruntime対象14ファイルは変わっていない。

- Worker entry、共通HTTP routing、Cron runner、workerd runtime test
- Cloudflare Vite config、generic Wrangler config
- bounded KDF、secret crypto、KDF workerd test
- Cloudflare Email adapter
- remote libSQL client、env parser、共通secure URL validator、UoW

このため、次の受入判定を維持する。

| 項目 | 最終判定 | 根拠 |
| --- | --- | --- |
| Workers custom entry / RSC / ALS | PASS | 対象hash不変。Cloudflare buildとworkerdがPASS。 |
| KDF strength / active 1 / queue 2 / overload | PASS（workerd） | 対象hash不変。実scryptを含むworkerd suiteがPASS。 |
| remote DB URL / token boundary | PASS | 対象hash不変。workerd suiteが空白token、`http/ws`、`tls=0`、credential、曖昧URLの拒否と許可URLを再実行。 |
| read/write transaction boundary | PASS（mock）/ remote未検証 | UoW hash不変。workerd mock testがPASS。 |
| Cron routing | PASS（local）/ remote未検証 | Cron runnerとtestのhash不変。2本の分岐testがPASS。 |
| Email payload / error contract | PASS（local）/ delivery未検証 | Email adapterとtestのhash不変。任意recipientとstable IDのworkerd testがPASS。 |
| Node-only exclusion | PASS | 現在のdry-run artifactで検索語0件。libSQLは`lib-esm/web.js`へ解決。 |

### 最小再実行

| 実行 | 結果 |
| --- | --- |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm test:integration:cloudflare` | PASS。2 files / 8 tests。実workerd + 実scrypt。 |
| `pnpm build:cloudflare` | PASS。entry 812.13 kB、gzip 174.19 kB。artifact hash一致。 |
| Wrangler deploy dry-run | PASS。136 modules、code 2,561.94 KiB、upload 3,355.04 KiB、gzip 705.41 KiB。外部deployなし。 |
| dry-run artifact scan | PASS。Node-only検索語0件、`.dev.vars` / `.env` 0件。 |

workerdは前回と同じく、接続前clientをcloseする境界testで`Called close before connection was established`をstderrへ1件出した。exit codeは0で、8 testは全件PASSした。

### 未検証

実remote libSQL、実Workers isolateのCPU・memory、Cloudflare Email Service実配送、environment別configは未検証のままである。C2以降のstaging gateを変更しない。

## 最終照合3 2026-09-06

### 判定

**PASS**。Root marker gap修正後の41件manifestへ、受入済みruntime判定を適用できる。runtime、KDF、secure DB URL境界、Cron、Emailの対象hashは前回から不変である。現manifestでtypecheck、workerd、Cloudflare build、Wrangler dry-run、bundle scanがPASSした。

### 検証対象

- 検証日時: 2026-09-06 02:21-02:22 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- 基準: `.goal-implement/cloudflare-deploy/phases/C1.md` の「Root marker gap再検証 SHA-256 manifest」
- manifest: 41/41一致
- manifest block SHA-256: `c2c937f5e97f9a44731b7e157b434513982e52abb3e146c8f98147026148b484`
- Cloudflare entry artifact SHA-256: `89ef121d13d6e0a02c0eccf8e1c6a00b97e775647a69cefd0bb240a1d20c0792`
- 生成 `wrangler.json` SHA-256: `6ac5028642be0058690b1d1595a875525ea339a4a0ac79705869bbe80aa21a3a`

manifestは開始時に41/41一致した。runtime対象14ファイルは前回の最終照合と同じhashである。変更はtrash UIとbounded deletionのcore実装・testに限られ、Cloudflare bundleだけを再生成する必要がある。

### 最小再実行

| 実行 | 結果 |
| --- | --- |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm test:integration:cloudflare` | PASS。2 files / 8 tests。実workerd + 実scrypt。 |
| `pnpm build:cloudflare` | PASS。entry 812.34 kB、gzip 174.21 kB。指定artifact hashと一致した。 |
| Wrangler deploy dry-run | PASS。136 modules、code 2,562.06 KiB、upload 3,355.36 KiB、gzip 705.46 KiB。外部deployなし。 |
| Node-only scan | PASS。SMTP、Node listener、signal、filesystem、migration、Node worker runnerの検索語は0件。 |
| dependency scan | PASS。libSQLは`@libsql/client/lib-esm/web.js`へ解決し、native SQLite packageを含まない。 |
| env file scan | PASS。dry-run artifactに`.dev.vars`と`.env`は0件。 |

workerdは接続前clientをcloseする境界testで、既知の`Called close before connection was established`をstderrへ1件出した。exit codeは0で、8 testは全件PASSした。

### 最終項目判定

| 項目 | 判定 |
| --- | --- |
| Workers custom entry / RSC / ALS | PASS |
| KDF strength / bounded admission | PASS（workerd） |
| secure remote DB URL / token boundary | PASS |
| read/write transaction boundary | PASS（mock）/ remote未検証 |
| Cron routing | PASS（local）/ remote未検証 |
| Email payload / error contract | PASS（local）/ delivery未検証 |
| Cloudflare build / dry-run / Node-only exclusion | PASS |

実remote libSQL、実Workers isolateのCPU・memory、Cloudflare Email Service実配送、environment別configは未検証のままである。C2以降のstaging gateを変更しない。
