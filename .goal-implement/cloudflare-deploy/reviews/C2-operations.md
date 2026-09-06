# C2 migration・secret・deploy preflight 独立レビュー

## 判定

**FAIL**。明示stage/config、固定生成path、source/built config比較、callback・sender契約、required keyの存在検査、shellを介さないWrangler起動、同stage migration再実行、部分失敗後の再開、Node migration回帰はPASSした。

一方、次の安全境界が成立していない。

1. stage configのDB identityは、その場で与えた`DATABASE_URL`自身から生成される。staging jobへproduction URLを誤投入するとproduction identityを持つstaging configが生成され、その同じURLをmigrationへ渡すと自己一致してDB clientとschema mutationへ進む。pair検査も、両URLを入れ替えた場合はidentityが異なるため通過する。
2. migration前にsource/built config、Cloudflare auth、Google secret、任意`FOG_AI_CLIENTS`を一括検証するpreflightがない。DB URL/tokenだけでmigrationを開始でき、後続のsecret/deploy検査で初めて失敗する。
3. secret bulkはJSONをstdinへ渡す一方、同じruntime secretをWrangler子プロセス環境にも複製する。deploy子プロセスにも不要なruntime secretを渡す。
4. `FOG_AI_CLIENTS`は非空文字列だけを検査し、不正JSON・不正schemaのままsecret sync/deployへ進む。`.dev.vars.example`の例も実runtime schemaと不一致である。
5. build/secret/deployのchild processにabort伝播・kill・完了待ちの契約がない。build失敗時は`dist-cloudflare/server/.dev.vars`削除が実行されない。

製品コード、`brief.md`、`design.md`、`plan.md`、phase reportは変更していない。本書だけを追加した。外部migration、secret sync、deployは実行していない。

## 検証対象

- 検証日時: 2026-09-06 02:46-02:59 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- phase report: `.goal-implement/cloudflare-deploy/phases/C2.md`
- manifest: phase report記載の50ファイル
- manifest block SHA-256: `5702d555002392fc50befe5d736708fe458f83fe3d1abe1a220363d3664db9eb`
- manifest照合: **50/50一致**。検証開始時と全回帰終了後に`shasum -a 256 -c`を実行し、全項目`OK`
- worktree: manifest対象外の既存変更とignored build artifactを含むため、合否判断は上記HEADと一致確認済みmanifestへ固定した

## CF別判定

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CF02 明示stage/config/path | PASS | migration CLIは`--stage`と`--config`を要求し、configの絶対pathを選択stageの`.cloudflare/generated/<stage>/wrangler.json`へ固定する。欠落stage、別path、空token、configと異なるDB URLは外部client生成前に終了した。 |
| CF02 DB identity | **FAIL** | identityの信頼元が独立していない。config renderとmigrationが同じ誤URLを使うと自己承認する。別stage configとのpair検査は任意手順であり、両stage URLのswapも検出しない。B-OPS-001。 |
| CF02 token | **FAIL** | 空白tokenは拒否するが、stage別の期待値・providerによるauth preflightはない。任意の非空tokenがclient生成/networkへ進む。外部での実token拒否は未検証。B-OPS-001。 |
| CF02 idempotency・partial failure | PASS（local） | 同一DBへの2回実行、初回新規DBの2並行実行、legacy rebuild、途中のadditive migration失敗後の再実行を確認した。legacy移行の強制競合では片方が一度失敗するが、DBは整合し再実行で収束する。 |
| CF02 concurrent migration | 条件付きPASS / C3必須 | 新規DBの自然な2並行実行は両方成功。legacy schemaで2実行を同じpre-check後へ進めると片方が`duplicate column name: purging`で失敗した。corruptionはなく再実行できるが、設計どおりC3のenvironment別concurrency groupで重複起動を防ぐ必要がある。 |
| CF02 Node migration回帰 | PASS | Node integration 6 files / 94 tests、Node build、legacy data/history/source/FK維持testを含めPASS。 |
| CF03 callback・sender・target Worker | PASS（local/static） | stageからWorker名、host、HTTPS `APP_URL`、Google callback、Email senderを固定導出し、source/built/runtimeで不一致を拒否する。secret CLIは生成configと固定Worker名を使用する。 |
| CF03 secret required keys/auth | 部分PASS | DB/Google 4 keyとCloudflare token/accountの欠落・空白はrunner前に拒否する。実Cloudflare token scope/account/Worker ownershipは資格情報なしのため未検証。 |
| CF03 secret transport | **FAIL** | secret値はCLI argsと一時fileには入らずstdin JSONは安全にescapeされるが、全sourceを子envへ複製するため「stdinだけ」ではない。子stdout/stderrもinheritでredaction契約がない。B-OPS-003。 |
| CF03 `FOG_AI_CLIENTS` | **FAIL** | 不正JSONでもsecret/deploy runnerへ到達し、Worker bootの`JSON.parse`で初めて失敗する。exampleもruntime schemaと異なる。B-OPS-002。 |
| CF06 deploy preflight | **FAIL** | deploy直前にはsource/built/stage/all required値を検査するが、migration前の共通preflightがない。migration済み・deploy未実施の部分状態を設定不備だけで作れる。B-OPS-002。 |
| CF06 command/path safety | PASS（CLI） | `spawn(command, args)`でshellを介さず、stage、Worker名、生成config/deploy config pathはCLI側で固定される。空白・改行・metacharacterをsecret値に含めてもargvへ入らず、stdin JSONではescapeされる。 |
| CF06 failure/abort cleanup | **FAIL** | child runnerは`AbortSignal`、signal handler、kill、close後の待機を持たない。buildの`.dev.vars`削除は成功後だけである。B-OPS-004。 |
| CF02/03/06 外部接続 | 未検証 | 実Turso identity/token、remote concurrent migration、Cloudflare token scope/account、secret bulk、OAuth登録、Email sender認可、実deployは資格情報と変更許可がない。C3/C4 gate。 |

## Blockers

### B-OPS-001: DB identity検査が入力URLを自己承認し、wrong stage/tokenをfail closedにできない

場所:

- `apps/web/scripts/cloudflareStage.ts:123-146`
- `apps/web/scripts/cloudflareStage.ts:196-206`
- `apps/web/scripts/cloudflareStage.ts:244-264`
- `apps/web/scripts/migrate.cloudflare.node.ts:24-35`

`renderStageConfig()`は`EXPECTED_DATABASE_IDENTITY`を`remoteLibsqlIdentity(input.databaseUrl)`から作る。migrationは同じ環境変数のURLをidentityへ戻し、その生成値と比較する。この比較は「config生成後にURLだけが変わった」事故は止めるが、「最初から誤ったstageのURLが注入された」事故を止めない。

独立runner/client spy再現:

1. `stage: "staging"`、`DATABASE_URL=libsql://fog-production.example.turso.io`でstaging configをrenderする。
2. 同じproduction URLと非空tokenで`runCloudflareMigration()`を呼ぶ。
3. identity比較が成功し、`createClient`と`migrate`が各1回呼ばれた。

```text
REPRO: a staging config rendered from the production URL self-authorized the same production URL; client=1 migrate=1
```

`validateStagePair()`は両configのidentityが同じことだけを拒否する。staging/production URLを互いにswapするとidentityは異なるため通過する。またC2 reportのC3手順ではpair検査は「両生成configを用意したrun」だけで、単独environment jobの必須gateではない。

tokenはtrim後非空だけを検査する。stage別tokenの取り違えやinvalid tokenはclient/network前に検出できない。これは外部auth確認なしには完全判定できないため、少なくともmigration前preflightで選択stageに紐づく独立したDB identity/provisioning metadataとprovider authを確認する必要がある。

必須修正:

- expected DB identityを、同じ`DATABASE_URL`からその場で導出しない。GitHub Environmentの独立protected value、provisioning output、またはstage別のcommitted non-secret identityへ固定する。
- pair検査を安全性の根拠にする場合、両stageの信頼済みidentityを必ず検査し、swapも拒否する。
- client/network/schema mutation前にstage、config、独立identity、token authをpreflightする。
- 「staging + production URL」「staging/production URL swap」「非空だがinvalid/mismatched token」でclient/migrationが0回のtestを追加する。

### B-OPS-002: migration前の共通preflightがなく、不正`FOG_AI_CLIENTS`もdeployまで通る

場所:

- `apps/web/scripts/migrate.cloudflare.node.ts:15-36`
- `apps/web/scripts/cloudflareDeploy.node.ts:33-62`
- `apps/web/scripts/cloudflareStage.ts:226-241`
- `apps/web/app/presentation/fogAiConfig.ts:19-40`
- `apps/web/.dev.vars.example:6-7`
- `.goal-implement/cloudflare-deploy/phases/C2.md:68-76`

C2の手順はbuild後すぐmigrationし、その後にsecret syncとdeployを行う。migration入口が検査するのはDB URL/tokenだけである。Cloudflare auth、Google secret、`FOG_AI_CLIENTS`、built configが欠落・不一致でもDB schema mutationを開始できる。deploy wrapperの検査自体はrunner前だが、migration済み・deploy未実施の部分状態を防がない。

独立spy再現:

```text
REPRO: runCloudflareMigration with only DATABASE_URL and DATABASE_AUTH_TOKEN called migrate=1; Cloudflare/Google/built inputs were absent
REPRO: FOG_AI_CLIENTS="not-json" passed runCloudflareDeploy and called runner=1
```

`runtimeSecrets()`は任意AI値をtrimするだけである。実runtimeはboot中に`JSON.parse`とZod schema検査をするため、deploy成功後に全requestがboot failureになる設定を事前に拒否できない。さらに`.dev.vars.example`は`clientId`、`clientSecretHash`を例示するが、runtime schemaは`id`、`name`、`redirectUris`を要求し、secret hash fieldを受理しない。

必須修正:

- migration・secret sync・deployより前に一度だけ実行する共有preflightを作る。stage/config固定、独立DB identity/token auth、source/built config、Cloudflare auth/account/target Worker、DB/Google全required secret、任意AI JSON schemaをそこで確定する。
- mutation各入口もpreflight結果を迂回できない契約にする。単なる順序ドキュメントだけを安全境界にしない。
- `FOG_AI_CLIENTS`はruntimeと同じparser/schemaで事前検証し、exampleを同じ形へ修正する。
- 各必須値欠落、built drift、不正AI JSON/schema、wrong stageでmigration・secret/deploy runnerがすべて0回になるtestを追加する。

### B-OPS-003: secret bulkがruntime secretを子プロセス環境へ複製する

場所:

- `apps/web/scripts/cloudflareSecrets.node.ts:11-32`
- `apps/web/scripts/cloudflareSecrets.node.ts:35-56`
- `apps/web/scripts/cloudflareDeploy.node.ts:59-62`
- `apps/web/scripts/cloudflareStage.test.ts:165-191`

`syncRuntimeSecrets()`は正しくJSONをstdinへ作り、secret値をargsへ入れない。しかしrunner envが`{ ...process.env, ...input.source }`であり、`DATABASE_URL`、DB token、Google client secret、任意AI設定をWrangler child environmentにも渡す。Linux `/proc/<pid>/environ`、childが起動する孫process、crash reportなど、stdin限定なら存在しない露出面を作る。deployも同様に、Wrangler deployが不要なruntime secretを全て受け取る。

独立runner spyは次を確認した。

```text
stdin: JSON object with the five runtime keys
args: no secret values
env.DATABASE_AUTH_TOKEN: present
env.FOG_GOOGLE_CLIENT_SECRET: present
env.FOG_AI_CLIENTS: present
```

既存testはargsとstdinだけをassertし、child envからruntime secretが除去されたことを検査しない。`stdio`はstdout/stderrをinheritするため、実Wrangler側が値を出さないこともwrapperでは保証・redactしていない。実Wranglerは外部変更禁止のため未実行である。

必須修正:

- Wrangler child envはCloudflare認証と実行に必要な最小keyだけのallowlistで作り、runtime secretはsecret bulkのstdinだけに置く。
- deploy childにもruntime secretを渡さない。
- runner spyでsecret値がargs、env、log/output、generated fileへ入らず、stdinのみに存在することを検査する。
- shell metacharacter、空白、改行、JSON文字列を含む値でも同じ不変条件を検査する。

### B-OPS-004: child failure/abort時の終了・artifact cleanup契約がない

場所:

- `apps/web/scripts/cloudflareBuild.node.ts:8-21`
- `apps/web/scripts/cloudflareBuild.node.ts:41-58`
- `apps/web/scripts/cloudflareSecrets.node.ts:17-33`
- `apps/web/scripts/cloudflareDeploy.node.ts:18-31`

3つのrunnerはexit/errorだけを待ち、`AbortSignal`もprocess signal handlerもchild killも持たない。CI job cancellationや親process終了時にWrangler/Viteの完了を管理できない。secret bulkはstdinの`error`も監視しないため、childのearly exitと書込みが競合した場合のEPIPE処理が明示されない。

buildはVite成功後にだけ`dist-cloudflare/server/.dev.vars`を削除する。Viteが同fileを書いた後に失敗・abortするとcleanupへ到達しない。過去のC1独立検証ではVite build directoryに`.dev.vars`が生成される挙動を確認しており、成功時削除だけではfailure pathを覆わない。

必須修正:

- child runnerへabortを伝播し、TERM後の完了待ちと必要な強制終了を定義する。stdin errorもsettled-onceで処理する。
- `.dev.vars`と一時artifact cleanupを`finally`で行い、開始前にも前回の残留物を除去する。
- child spawn error、non-zero exit、stdin EPIPE、abortのmock testで、childが残らず、secret/temp artifactが残らず、後続migration/deployが呼ばれないことを検査する。

## migration詳細

### fail-closedで確認できた範囲

実CLIを外部接続なしで実行し、全てexit 1を確認した。

- `--stage`欠落: stage enum parseで終了。
- `--stage staging --config /tmp/not-generated-wrangler.json`: file readより前に固定path違反で終了。
- 選択stage config + 空白`DATABASE_AUTH_TOKEN`: client生成前に終了。
- staging config + production `DATABASE_URL`: config identityとの比較でclient生成前に終了。

最後の検査は「config生成時には正しいURLだった」場合だけ有効であり、B-OPS-001の自己承認ケースを覆わない。

### idempotency・concurrency・partial failure

独立local libSQL testの結果:

- 空DBへ2回連続適用: PASS。`CREATE ... IF NOT EXISTS`とcolumn検査により同一schemaを維持。
- 空DBへ2 client同時初回適用: PASS。両Promiseがfulfilledし、schema/FKは整合。
- legacy nonnullable topic schema: PASS。document/revision/sourceを保持し、rebuild batchはatomic。
- additive `purging` migrationの2つ目で例外注入: PASS。1つ目のcolumn追加は残るが、次回は既存columnをskipして全3tableへ収束。
- legacy migrationを両clientが同じdocument pre-check後へ進むようbarrier注入: 片方PASS、片方は`SQLITE_ERROR: duplicate column name: purging`。その後の再実行はPASSし、`PRAGMA foreign_key_check`は空。

並行legacy migrationがcorruptionせず再実行できる点はPASSだが、一方のrunが成功する保証はC2 CLI単体にない。`design.md:41,75`のenvironment別concurrency groupをC3で実装し、同stage migration/deployを直列化することが受入条件である。

schema migration ledgerは実装されていない。C2 reportの「schema migration recordは1件」は、恒久recordの件数ではなく、既存testが`fog_users` tableの件数1を確認しているだけであり、表現を修正すべきである。

## secret・command・artifact詳細

- required DB/Google 4 keyとCloudflare auth 2 keyはrunner前にtrim後非空を検査する。
- runtime secretはstdin JSONへ渡すため、空白・改行・quote・shell metacharacterはJSON escapeされる。Wrangler起動はshell stringでなくcommand/args配列であり、command injectionにはならない。
- Worker名はstage config validatorにより`fog-staging`または`fog-production`へ固定される。
- migration config、secret config、deploy built configのCLI pathはrepository配下の決定済みpathへ固定される。testable helperは任意pathを受け取るがCLI入口から代入できない。
- source/built configはname、route、cron、Email binding、secret key contract、varsを完全一致比較する。mainは`index.js`、asset directoryは`../client`に固定する。
- current artifactをlocal secret値に対して値照合し、runtime secret match 0、`.dev.vars`/`.env`/`.tmp` artifact 0を確認した。ただしB-OPS-004の失敗時経路は静的にFAILである。
- Cloudflare token/accountは存在だけを検査する。scope、account一致、target Worker ownershipは外部APIなしでは未検証。

## 独立コマンド結果

| 実行 | 結果 |
| --- | --- |
| manifest block digest + `shasum -a 256 -c` | PASS。block hash一致、50/50一致。開始時・終了時。 |
| `pnpm cloudflare:config validate --stage staging` | PASS。固定生成config。 |
| `pnpm cloudflare:config validate --stage production` | PASS。固定生成config。 |
| `pnpm cloudflare:config validate-pair` | PASS。現在の2生成configはWorker/host/DB identityが分離。 |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts` | PASS。1 file / 16 tests。 |
| migration/secret/deploy独立runner・libSQL test | 7 scenarios中、期待した現挙動を全て再現。4 blocker再現、空DB並行、legacy強制競合+retry、partial failure+retry。temp testは削除済み。 |
| migration CLI negative table | PASS。stage欠落、wrong path、empty token、configと異なるDB identityは各exit 1、外部接続なし。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。206 files。既存`staticAssets.test.ts:42`のinfo 1件、修正なし。 |
| `pnpm format:check` | PASS。220 files。 |
| `pnpm test:unit` | PASS。15 files / 96 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 94 tests。 |
| `pnpm build:node` | PASS。Node target回帰。 |
| `git diff --check` | PASS。whitespace error 0。 |
| current artifact secret-value/env-file scan | PASS。runtime secret値match 0、`.dev.vars`/`.env`/`.tmp` 0。failure/abort pathは未成立。 |

## 再レビュー条件

1. B-OPS-001のexpected DB identityを独立したstage信頼元へ固定し、URL swapとwrong/mismatched tokenをmigration前に拒否する。
2. B-OPS-002の共通preflightをmigrationより前へ置き、source/built/stage、DB/Cloudflare auth、全required secret、AI JSON schemaを一括検証する。
3. B-OPS-003のchild envをallowlist化し、runtime secretをstdin以外へ渡さない。
4. B-OPS-004のabort/kill/waitと`finally` cleanupを実装する。
5. command mock testへwrong-stage render、URL swap、invalid token、各missing key、malformed AI JSON/schema、whitespace/newline/metacharacter、spawn failure、non-zero exit、stdin EPIPE、abort、artifact cleanupを追加する。
6. C3で同stage concurrency groupを実装し、legacy migrationの重複起動を防ぐ。外部資格情報を使う承認済みgateでDB/token identity、Cloudflare account/target、secret sync、OAuth callback、Email sender、実deployを確認する。

## 最終再検証 2026-09-06 03:34-03:46 JST

### 判定

**FAIL**。B-OPS-001、B-OPS-002、B-OPS-004の元再現は解消した。B-OPS-003もruntime secretのchild env/argv漏洩は解消したが、child stdout/stderrのredactionがJSON escape表現とsecret同士のprefix重複を完全に除去できない。phase reportの「改行、JSON文字を含む値もoutputに含めない」は成立せず、secret output契約をPASSにできない。

実Cloudflare/Turso資格情報を要する認証、scope、remote migration、secret sync、deployは未検証gateのままである。製品コードと管理入力は変更せず、本再検証節だけを追記した。

### 検証対象の固定

- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- final manifest: `.goal-implement/cloudflare-deploy/phases/C2.md`記載の54ファイル
- manifest block SHA-256: `da33ce61cd822db7ae1363a2f3dcfdd6773c9cc64ac94d0e44d5181e65273ba4`
- 照合結果: **54/54一致**。検証開始、独立test削除後、全回帰終了後に`shasum -a 256 -c`で全件`OK`
- 独立再現用`apps/web/scripts/c2-operations-final-review.test.ts`は削除済み。manifest対象外の製品fileを残していない

### B-OPS再判定

| Blocker | 最終判定 | 根拠 |
| --- | --- | --- |
| B-OPS-001 独立DB authority | PASS（local） | `DATABASE_IDENTITY`をURLと別入力にし、stage別先頭labelを強制した。元再現のstaging + production authority/URLはconfig renderで拒否する。URLだけ差替え、authorityだけ差替え、config driftもpreflight token生成前に拒否する。 |
| B-OPS-001 marker/auth gate | PASS（local）/ remote auth未検証 | DB接続後の最初のstatementは`SELECT 1`。失敗時はidentity/lock/app schemaを作らない。markerなしは明示bootstrapなしで拒否し、bootstrap後はstage/identityを固定する。別stage markerはlock/app migration前に拒否する。 |
| B-OPS-002 共通preflight | PASS（local） | migration、secret sync、実deploy CLIは全て`loadCloudflarePreflight(sideEffect: true)`完了後にだけclient/runnerを作る。stage/path、source/built exact一致、provenance、DB authority、DB/Google secret、Cloudflare auth、AI schemaのどれかが不正ならpreflight objectを取得できない。 |
| B-OPS-002 AI/example | PASS | `FOG_AI_CLIENTS`をruntimeと同じ`readFogAiClients()`でparseする。不正JSONと`[{"clientId":"wrong"}]`を拒否し、`.dev.vars.example`は`id/name/redirectUris`へ一致した。 |
| B-OPS-003 stdin-only/runtime child env | PASS | secret bulkのruntime DB/Google/AI値はstdin JSONだけに置く。child envはsystem allowlistとCloudflare authだけで、deploy childにもruntime secretを渡さない。shellを介さず固定command/argsで起動する。 |
| B-OPS-003 child output | **FAIL** | exact raw値のredactは成功するが、JSON escaped改行値とprefix重複値で残片を出力する。独立実child再現を後述。 |
| B-OPS-004 child lifecycle | PASS（local） | pre-abortはspawn前にrejectする。mid-abortはSIGTERMし、5秒後のSIGKILL fallbackを設定して`close`まで待つ。spawn error、exit 7、stdin EPIPE相当を全てsettleする。process signal listenerはfinallyで解除する。 |
| B-OPS-004 cleanup | PASS（local） | buildは開始前・成功・failure・abortの全経路で`.dev.vars`とVite tempを削除し、未完了時はprovenanceも削除する。dry-run failureもoutdirを削除する。現artifact scanはsecret/env/temp file 0。 |

### B-OPS-001: authority、marker、token gate

独立authorityは入力値の正規形だけでなく、hostname先頭labelをstaging=`fog-staging`/`fog-staging-*`、production=`fog-production`/`fog-production-*`へ固定する。元の自己承認再現であるstaging + production URL/authorityは`renderStageConfig()`内で`fog-staging` naming errorとなり、configを生成しない。同stage authorityと別URLもauthority mismatchとなる。

独立memory libSQL再現では次を確認した。

1. markerなし、bootstrapなし: `SELECT 1`とread-only `sqlite_master`確認後に拒否。identity table、lock table、app tableは0。
2. `DATABASE_IDENTITY_BOOTSTRAP=true`: identity tableとmarkerをatomic batchで作り、lock取得後にmigrationへ進む。
3. 2回目: bootstrapなしで同じmarkerを受理し、migrationを再実行してlockをreleaseする。
4. markerをproduction stage/identityへ変更: app migration呼出しを増やさず拒否する。
5. active lease: 2本目を`already running`で拒否し、1本目完了後のretryは成功する。

tokenの値から所属DBをローカルに内省することはできない。Fogがclient/network前に保証するのはtrim後非空、URL、独立authority、stage naming、source/built/provenanceまでである。Turso authはclient生成後の`SELECT 1`で初めて確認し、失敗時はDB schema mutation 0を保証する。実tokenのDB scopeとremote `SELECT 1`は未検証であり、phase reportどおりC3のDB別least-privilege tokenと実接続gateが必要である。

Cloudflare token/accountもローカルpreflightではtrim後非空だけを確認する。実認証、account一致、scope、Worker/zone ownershipは外部gateであり、今回のPASSへ含めない。不正だが非空のCloudflare authではTurso migration後にWrangler側で初めて失敗し得るため、C3でmutation前にread-only auth確認を置くか、この部分状態を運用契約として明示する必要がある。

### B-OPS-002: preflightとprovenance

`CloudflarePreflight`は非公開unique symbolのbrandを持ち、migration/secret/deployのapplication入口はraw sourceではなく同tokenを要求する。CLIは固定source configと固定`dist-cloudflare/server/wrangler.json`を読み、次をclient/runnerより前に完了する。

- stage、生成path、Worker名、route、cron、Email sender、OAuth callback、required secret key contract。
- Wrangler出力の全top-level key、binding default、compatibility、entry、assetsとsource configの完全一致。
- DB authority/URL、DB/Google required secret、Cloudflare authの存在、runtime-equivalent AI JSON schema。
- HEAD、clean flag、product workspace、source config、built config、entry、server treeのdigest。

focused testはstale stage/source/config/entry/tree/SHA、build時dirty、現在dirty、未知bindingを拒否した。独立stage buildとdry-runもPASSし、136 modules、upload 3356.79 KiB / gzip 705.83 KiBだった。side-effect preflightはdirty checkoutを拒否するため、今回の共有dirty worktreeから外部操作は行っていない。

### B-OPS-003残存: encoded/prefix secretをchild outputから完全redactできない

場所:

- `apps/web/scripts/cloudflareChild.node.ts:13-16`
- `apps/web/scripts/cloudflareChild.node.ts:53-63`
- `apps/web/scripts/cloudflareSecrets.node.ts:23-51`

`redact()`はraw secret配列を入力順に`replaceAll()`するだけである。この方式には2つの決定的な漏洩がある。

1. secret `alpha\nbeta`はstdin JSON内では`alpha\\nbeta`になる。childが受け取ったstdinまたはJSON error contextをstdout/stderrへ出すと、raw改行値とは一致しない。別の短いsecret `alpha`だけが置換され、`\\nbeta`が残る。
2. secretが`abc`と`abcdef`なら短い`abc`が先に置換される。文字列は`[REDACTED]def`となり、後段の`abcdef`とは一致せずsuffix `def`が残る。

独立実childは`process.stdin.pipe(process.stdout)`でsecret bulk JSONをechoし、captureした親stdoutで次を観測した。値は再現専用fixtureであり実資格情報ではない。

```text
payload/redaction secret values: "alpha\nbeta", "abc", "abcdef"
captured output fragments: "[REDACTED]\\nbeta", "[REDACTED]def"
```

command/args配列とruntime child envにsecretがない点はPASSである。しかしWranglerのstdout/stderrを安全境界で捕捉する設計を採った以上、exact raw表現だけのbest-effort置換で「outputに値を含めない」とは保証できない。少なくともredaction候補を長さ降順にし、raw値に加えてJSON string escape表現を置換する必要がある。より堅くするならsecret bulk child outputを成功時に破棄し、失敗時も既知の安全な診断だけを出す。

### leaseの条件

DB lockのCAS取得、holder一致release、failure時finally、10分後の回収は成立する。ただしexpires_atはrunnerの`Date.now()`を使う固定10分leaseで、実行中renewalはない。したがって「同じDBの実排他」はmigrationが10分以内に終わり、runner間の時計差がleaseを超えない条件で成立する。10分を超えて動作中のmigrationも次runには異常終了holderと区別できず、leaseを奪われる。

現在のmigrationはremote interactive transactionの5秒制約下に収める設計であり、C3 environment concurrencyも追加されるため、本再検証ではwarningとした。DB leaseを唯一の排他根拠として一般化するなら、DB時刻の使用、実行中renewal、またはoperation全体の10分未満timeoutを契約・testで保証すべきである。

### 最終回帰結果

| 実行 | 結果 |
| --- | --- |
| manifest block digest + `shasum -a 256 -c` | PASS。block digest一致、54/54一致。開始時・一時test削除後・終了時。 |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts` | PASS。1 file / 38 tests。 |
| operations独立test | 6/6 PASS。元B-OPS再現、marker/bootstrap、実file DB lease overlap/retry、実child stdout漏洩、pre/mid abort。temp file削除済み。 |
| `pnpm test:unit` | PASS。15 files / 118 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 94 tests。 |
| `pnpm test:integration:cloudflare` | PASS。2 files / 8 tests。shutdown時の既知診断あり。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。210 files。既存`staticAssets.test.ts:42`のinfo 1件、修正なし。 |
| `pnpm format:check` | PASS。224 files。 |
| `pnpm build:node` | PASS。Node target回帰。 |
| `pnpm build:cloudflare:stage --stage staging` | PASS。entry 813.80 kB / gzip 174.60 kB。 |
| `pnpm cloudflare:deploy --stage staging --dry-run` | PASS。136 modules、3356.79 KiB / gzip 705.83 KiB。外部deployなし。 |
| artifact scan | PASS。local runtime secret値match 0、`.dev.vars`/`.env`/`.tmp` artifact 0。 |
| `git diff --check` | PASS。whitespace error 0。 |

### 再レビュー条件

1. B-OPS-003のchild outputを、JSON escapeと重複/prefix関係を含めて漏れなく抑止する。
2. hostile testでstdout/stderr、成功/nonzero/EPIPEの各経路にraw、JSON escaped、prefix重複secretを出し、値と識別可能なsuffixが残らないことを確認する。
3. 更新manifestを固定し、focused、unit、Node integration、stage build/dry-run、artifact scanを再実行する。
4. C3ではCloudflare authのread-only実確認、Turso DB別token、remote marker/lease/concurrent retry、GitHub Environment concurrencyを外部gateとして実施する。

## 最終再検証2 2026-09-06 04:04-04:18 JST

### 判定

**PASS（資格情報不要・local範囲）**。B-OPS-001〜004の元再現はすべて解消した。前回FAILだったB-OPS-003 child outputは、redactionを廃止してsecret syncと実deployのstdout/stderrをOS discardへ直結したため、raw、JSON escape、prefix、URL、base64、binaryの表現に依存せず親processへ転送されない。spawn、stdin EPIPE、pre/mid abort、nonzero exitのerrorも固定labelとexit/signalだけになり、例外・log経路へ値を残さない。

migrationはrunner時計と期限leaseを廃止し、認証用`SELECT 1`後のmarker再検査/bootstrapとschema migration全体を1本のwrite transactionに統合した。local libSQLではatomic rollback、長時間保持中の非overlap、busy fail-closed後の明示retry、OS kill後のrollback/lock解放、idempotent再実行を独立確認した。

実Cloudflare/Turso資格情報を要する認証・scope・remote operationは未検証gateである。特にTurso remote interactive transactionの5秒上限に対して、legacy table copyを含む実DB migration全体が収まるかは今回のlocal PASSに含めない。C3で代表的な既存データ量を持つstaging DBを使い、所要時間、timeout/busy code、同時起動、process/network切断、retryを実測することが必須である。

製品コード、plan/design、phase reportは変更していない。独立再現用testは実行直後に削除し、production fresh artifactを維持した。

### 検証対象の固定

- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- final2 manifest: `.goal-implement/cloudflare-deploy/phases/C2.md`記載の54ファイル
- manifest block SHA-256: `0293b0521199d7d5100f4df1c192f8941a82fec42e9a9f458f2b60316443957d`
- 照合結果: **54/54一致**。開始時、独立test削除後、終了時に`shasum -a 256 -c`で全件`OK`
- 現artifact: production、provenance version 2、HEAD一致、server/client digestあり。`.dev.vars`、`.env`、`.tmp` artifactは0

### CF別判定

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CF02 migration / DB identity | PASS（local）/ remote 5秒gate未検証 | 共通preflight完了後にだけclientを作り、最初のstatementを`SELECT 1`に固定する。続く単一write transaction内でmarkerを再検査または明示bootstrapし、同じtransaction objectを`migrateFog`へ渡してcommitする。wrong marker、bootstrapなし、auth error、busyはschema commitなしでfail closedする。失敗、同時起動、時計差、再実行、別process killを独立確認した。 |
| CF03 secrets / callback外部契約 | PASS（local）/ 実provider未検証 | required DB/Google/AI/Cloudflare値とstage固定configをrunner前に検査する。runtime secretはsecret bulkのJSON stdinだけで、argv、child env、file、生成artifact、親outputに置かない。OAuth callback、Email sender、AI schemaはsource/built exact比較対象である。実token scope、account、Worker/zone ownership、OAuth/Email providerはC3 gate。 |
| CF06 safe operations / deploy preflight | PASS（local）/ 実deploy未検証 | migration、secret sync、実deployは同じbranded preflightを要求し、source-built/provenance、stage、全secret/auth検査前にclient/runnerを作らない。実deployだけdiscard、資格情報を渡さないbuild/dry-runだけdiagnosticを使う。abort/kill/wait、failure cleanup、safe path、dirty/別SHA拒否を維持した。外部deployは実行していない。 |

### B-OPS-001〜004再判定

| Blocker | 最終判定 | 根拠 |
| --- | --- | --- |
| B-OPS-001 独立DB authority / marker | PASS（local） | stage別`DATABASE_IDENTITY`とURL hostname namingを独立検証し、URL swap、authority swap、wrong stageをconfig/preflightで拒否する。DB接続後は`SELECT 1`を先行し、markerなしは`DATABASE_IDENTITY_BOOTSTRAP=true`のときだけtransaction内で作る。markerとschemaの一方だけが残る失敗を独立再現で否定した。 |
| B-OPS-002 共通preflight / provenance | PASS（local） | 全side-effect入口はbranded preflightを要求する。source config、built config、entry、server tree、client tree、workspace、HEADをdigest照合し、stage/path/未知binding/dirty/別SHAを拒否する。DB/Google required secret、runtime-equivalent AI schema、Cloudflare authもclient/runner前に検査する。 |
| B-OPS-003 stdin-only / child output | PASS | secret bulkはshellなしの固定command/argsとJSON stdinを使う。child envはsystem allowlistとCloudflare authだけでruntime secretを含まない。secret sync/実deployのstdout/stderrは`ignore`で、native/spawn/stdin/abort reasonをgeneric errorへ変換する。独立hostile matrixで親stdout/stderr call 0を確認した。 |
| B-OPS-004 lifecycle / cleanup | PASS（local） | pre-abortはspawn前に固定error、mid-abortはSIGTERM、5秒後SIGKILL fallback、`close`待ち。spawn error、exit 9、EPIPEを全てsettleした。build failure/abortは`.dev.vars`、Vite temp、未完了provenanceをfinallyで消し、dry-run failureはoutdirを消す。process signal listenerもfinallyで解除する。 |

### Sensitive child output独立matrix

`runChildCommand()`を実childで直接実行し、成功、exit 9、stdin EPIPE、spawn error、secretをreasonに含むpre-abort/mid-abortを確認した。childには次をstdout/stderrへ書かせた。

- rawとJSON encodedの改行値
- 短いprefixと長いprefix値
- URLとそのbase64表現
- NUL以外の非UTF-8 byteを含むbinary prefix
- stdin payload全体

discard modeでは親`process.stdout.write`/`process.stderr.write`は全経路0回だった。返却errorは`Sensitive operation`とexit/signalだけで、fixture断片を含まなかった。成功時もbufferを保持しない。別のdiagnostic modeではsecretでない`safe-diagnostic-42`だけが親へ転送され、mode分離も確認した。

production呼出箇所はsecret syncと実deployがdiscardである。buildはCloudflare authを削除したallowlist env、dry-runは`sideEffect: false`の空auth/runtime secretでdiagnosticを使うため、diagnostic対象にsecretを投入する経路はない。CLIの成功logはstage名だけ、failure logはgeneric child errorだけである。

### Migration transaction独立matrix

1. fake unauthorized clientでcall順を採取し、`SELECT 1`失敗後は`transaction()`、marker、`migrate`が未呼出しでclientだけcloseすることを確認した。
2. 空DBのbootstrap transaction内でmarker作成後に`CREATE TABLE partial_probe`と例外を注入し、外部clientからmarker/tableの両方が0であることを確認した。次のbootstrap + 実`migrateFog`、bootstrapなし再実行は成功し、markerは1件、`PRAGMA foreign_key_check`は空だった。
3. 先行write transactionを意図的に保持し、後行runnerの`Date.now()`を大きくずらした。後行migration callbackは先行中に入らず、完了待ちまたはfail-closedとなる。明示的に`SQLITE_BUSY`を返すclientもschema mutationなしでrejectし、先行終了後の新process相当retryでmarker/schemaへ収束した。application内部の無断retryはない。
4. 別Node processでwrite transactionと未commit DDLを作り、ready後に`SIGKILL`した。次clientでは未commit tableが存在せず、新write transactionを取得・commitできた。通常例外経路はrunner自身がrollback/transaction close/client closeをfinallyで行う。

単一transactionにより、marker bootstrap、既存schema作成、legacy document table rebuild、`purging` column追加は同じcommit境界に入る。statement数自体はschema定義で有限だが、legacy table copyの実変更行数とremote所要時間はDB内容に依存する。したがってatomicityはPASSだが、remote 5秒制約適合は未検証である。timeout時はrollbackと再実行へ収束する設計をlocalで確認しただけで、remote transport切断後のcommit結果不明も含めC3実測を要する。

### Token内省不能gate

Turso token自体から所属stage/DBをFogがローカルに内省することはできない。事前に保証するのは、stage固定source config、独立authority、URL hostname naming、source-built/provenance一致、token非空までである。実tokenの有効性は対象URLへの`SELECT 1`、その後のstage identityはtransaction内markerで確認する。広域tokenを避けるため、C3ではstaging/production DBごとのleast-privilege tokenを発行して実接続する。

Cloudflare API token/accountもlocal preflightでは非空とtarget Worker名/configの固定までで、token scope、account一致、Worker/zone ownershipは内省しない。外部mutation前のread-only auth確認または承認済みstaging実行をC3 gateに残す。非空だが無効なCloudflare authはpreflight通過後Wranglerで失敗し得るため、この点をlocal PASSには含めない。

### 回帰結果

| 実行 | 結果 |
| --- | --- |
| manifest block digest + `shasum -a 256 -c` | PASS。block digest一致、54/54一致。 |
| operations独立hostile test | PASS、4/4。child output/lifecycle 1、migration atomic/idempotent 1、long-held/clock-skew/process kill 1、busy fail-closed/retry 1。一時testは全削除済み。 |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts` | PASS、1 file / 42 tests。同一manifestでconfig verifierがartifact競合前に実行し、結果を共有。 |
| `pnpm test:unit` | PASS、15 files / 122 tests。同一manifestでconfig verifierが実行し、終了後production artifactを再固定。 |
| `pnpm test:integration:node` | PASS、6 files / 94 tests。operations verifierが独立実行。 |
| `pnpm test:integration:cloudflare` | PASS、2 files / 8 tests。operations verifierが独立実行。shutdown時の既知diagnostic 1件あり。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。210 files。既存`staticAssets.test.ts:42`のinfo 1件のみ。 |
| `pnpm format:check` | PASS。224 files。 |
| `pnpm build:node` | PASS。Node migration/runtime回帰。 |
| production fresh build + dry-run | PASS。config verifierがfocused/unit後に再buildし、provenance v2、client/server tree、実dry-runを確認。外部deployなし。 |
| artifact/env scan | PASS。artifact内の`.dev.vars`、`.env`、`.tmp`は0。runtime secret値scanも同一manifestのfresh artifactで0。 |
| `git diff --check` | PASS。whitespace error 0。 |

### C3必須gate

1. 実staging Turso DBへDB専用tokenで接続し、`SELECT 1`、初回marker bootstrap、同stage idempotent migration、wrong marker、並行起動、busy/timeout code、network/process切断、retryを確認する。
2. legacy tableを含む代表的な最大データ量で、単一remote interactive write transactionが**5秒以内**にcommitすることを実測する。超える場合はmigrationを安全なversioned stepへ分けるまで実deploy不可とする。
3. Cloudflare tokenのscope/account/Worker/zoneをread-only確認し、staging secret sync、OAuth callback、Email sender、dry-run後の承認済み実deployを確認する。
4. GitHub Environmentのstage別approval/concurrencyを追加防御として確認する。DB transactionが実排他、Environment concurrencyがoperation重複低減を担う。
