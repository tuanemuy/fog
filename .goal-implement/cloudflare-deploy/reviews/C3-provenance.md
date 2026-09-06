# C3 release provenance / smoke / helper 独立レビュー

## 判定

2026-09-06 04:48-05:01 JST、HEAD `7d449cf62c548f2084b30568b3f99e5535b37a28`を対象に再検証した。総合判定は**FAIL**。CF04のworkflow合成とhealth/smoke、CF06のworkflow入力・secret境界は成立するが、CF05のrelease provenanceに3件の未充足がある。

- B-C3-PROV-001: GitHub Releaseの`prerelease`を検査せず、手動recoveryからpre-releaseをproductionへ昇格できる。
- B-C3-PROV-002: 同一SHAの新しいfailed deploymentを古いsuccessful deploymentで上書きして受理する。
- B-C3-PROV-003: GitHub REST APIのpaginationを実装せず、2ページ目以降の正当なstaging記録へ到達できない。

外部account、GitHub repository、Cloudflare、Tursoは変更していない。GitHub-hosted run、Environment approval、実HTTPS endpoint、実deployは未検証である。製品コード、brief/design/plan/phase reportは変更せず、この報告だけを作成した。

## 検証対象

- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- manifest: `.goal-implement/cloudflare-deploy/phases/C3.md`記載の62ファイル
- manifest block SHA-256: `4c44e87900349318f58e7684c0aac5491c2b945a32e0d3241b7ccb1be2c889e3`
- 照合: **62/62一致**。開始時、一時test削除後、終了時に`shasum -a 256 -c`で全件`OK`
- 一時test: `apps/web/scripts/c3-provenance-final-review.test.ts`を独立再現後に削除。manifest対象外の製品fileを残していない

## CF別判定

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CF04 SHA health / staging deployment | PASS（local） | main pushのfull `github.sha`をcheckout、config `DEPLOYMENT_SHA`、artifact provenance、manual deployment payload、runtime healthへ通す。healthはruntime envのSHA/stage/DB authority検査後にDB `SELECT 1`を実行し、4項目のJSONと`Cache-Control: no-store`を返す。smokeはHTTPS、credentialなし、port/path/query/hashなし、redirect拒否、10秒timeout、18回retry、固定失敗文を使う。workerd focused 5/5 PASS。実endpointは未検証。 |
| CF05 Release / production provenance | **FAIL** | draft、tag peel、main ancestry、SHA、repository、head repository、push/main、workflow path、latest run jobs、job SHA/conclusion、deployment creator/payload/statusを検査し、approval後に再検査する。しかしprerelease、最新deployment優先、paginationが欠落し、3件を独立再現した。 |
| CF06 helper / recovery security | PASS（workflow境界）/ Warning 2件 | dispatch値はtrusted main validatorへenvで渡し、検証前にcandidate checkoutやproduction Environmentへ入れない。approval後も再検証する。shellへ`${{ inputs.* }}`を展開せず、output値はtag/full SHA schemaで制限する。helper単体ではrepository dot-segmentとnon-apex smoke suffixを受理するが、実workflowの`GITHUB_REPOSITORY`はtrusted context、DOMAINは先行config renderでICANN apex検証される。 |

## Blocker

### B-C3-PROV-001: prereleaseをproduction候補として受理する

場所: `apps/web/scripts/cloudflareGithub.node.ts:130-139`

Release response schemaは`tag_name`と`draft: false`だけを検査する。GitHubのRelease responseには`prerelease`が独立したbooleanとして存在するが、`prerelease: true`を拒否しない。通常のRelease Please設定がstable releaseを作る場合でも、`workflow_dispatch`は既存release tag/SHAを直接入力できるため、既存pre-releaseをproduction回復経路へ投入できる。

独立fetch fixtureで次を返した。

```json
{
  "tag_name": "v1.2.3",
  "draft": false,
  "prerelease": true
}
```

tag、main ancestry、staging run/jobを正当値にすると、`validateReleaseCandidate()`はresolveした。GitHub公式の[Release API response](https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10)も`draft`と`prerelease`を別fieldとして定義する。

修正条件:

- Release schemaへ`prerelease: z.literal(false)`を追加する。
- draftとprereleaseを個別にtrueにしたhostile testを追加する。
- 通常releaseとdispatch recoveryの両方が同じvalidatorを通る状態を維持する。

### B-C3-PROV-002: 新しいfailed deploymentより古いsuccessを採用する

場所: `apps/web/scripts/cloudflareGithub.node.ts:158-233`

`/deployments?sha=...&environment=staging`の全recordを順に走査し、各deploymentのlatest statusがsuccessなら即時acceptする。先頭の新しいdeploymentがfailureでも、後続の古いdeploymentがsuccessなら受理する。新しいstaging attemptのmigration、secret sync、deploy、smokeが失敗した後も、同じSHAの過去成功を使ってproductionへ進めるため、「staleなstaging recordを受理しない」契約を満たさない。

独立fixtureではdeployment ID 100を最新failure、ID 99を過去successとし、両方を同一SHA/payload/runへ結び付けた。validatorはID 100をskipし、ID 99のsuccessでresolveした。

GitHubはdeploymentごとに複数statusを保持し、最新statusをそのdeploymentのcurrent stateとして扱う。[Deployment status API](https://docs.github.com/en/rest/deployments/statuses?apiVersion=2026-03-10)に合わせた`statuses[0]`の検査は成立するが、deployment集合そのものの最新recordを確定していない。

修正条件:

- API順序を暗黙に信頼せず、`created_at`と一意な`id`をdecodeして最新の対象deploymentを決定する。
- 最新deploymentがfailure/in-progress/queued/statusなしなら、古いsuccessへfallbackせずfail closedにする。
- `new failure + old success`、`new success + old failure`、同時刻/ID tie、run attempt差のtestを追加する。

### B-C3-PROV-003: paginated API responseを追跡しない

場所: `apps/web/scripts/cloudflareGithub.node.ts:25-43,158-168,178-188,210-230`

`githubJson()`はJSON bodyだけを返し、responseの`Link` headerを捨てる。deployments、deployment statuses、workflow jobsは`per_page=100`を指定するだけで、`rel="next"`を追わない。GitHub公式の[REST pagination契約](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2026-03-10)では1 responseは部分集合であり、次pageは`Link` headerから取得する必要がある。

独立fixtureでdeployments page 1を空、`Link`のpage 2に正当recordがある形にした。validatorのdeployments requestは1回だけで、`No successful trusted staging deployment`となった。これは任意SHAを通すfail-openではないが、CF05が要求する既存releaseの部分失敗recoveryを正当な履歴件数によって失敗させるため、完了条件を満たさない。

修正条件:

- same-origin `https://api.github.com`だけを許すbounded pagination helperを作り、`Link rel="next"`を検査する。
- deploymentsは必要な最新recordを確定できるまで追跡する。statusesはcurrent statusがpage 1先頭にある契約をtestし、jobsは固定workflowのjob数が100以下であることを構造検査するかpaginationする。
- page数/総item数をboundedにし、cycle、別origin Link、malformed Linkをfail closedにする。
- page 2 success、100件境界、next cycle、別origin、429/403をhostile testへ追加する。

## Warning

### W-C3-HELPER-001: repository schemaがdot segmentを許す

場所: `apps/web/scripts/cloudflareGithub.node.ts:6-8,46-48`

`../..`は`owner/repository` regexを通る。生成文字列は`https://api.github.com/repos/../../deployments`となり、URL parser/fetchでは`https://api.github.com/deployments`へ正規化される。実workflowの値はGitHubが設定する`GITHUB_REPOSITORY`であり、tokenの送信originもGitHubから変わらないため、現在のworkflowから任意originへの漏洩やproduction迂回は再現しない。ただしtoken付きhelperのtarget repository境界として不完全である。

各segmentの`.`/`..`を拒否し、URL path segmentを`encodeURIComponent()`して組み立てる。dot-only、leading/trailing dot、Unicode、percent、slash、改行をtestする。

### W-C3-HELPER-002: smoke helper単体ではregistrable apexを再検査しない

場所: `apps/web/scripts/cloudflareSmoke.node.ts:20-37`

`https://staging-fog.example.com.evil.com`は`staging-fog.`で始まるため受理され、fixture healthが一致すると成功する。実workflowでは同じ`DOMAIN`を先行config rendererがregistrable ICANN apexとして検査するため、構成全体のhost固定は成立する。helperを単独の安全境界として扱うなら、C2の`stageIdentity()`から期待originを渡すか、suffixのregistrable apexを同じvalidatorで検査する。

## 成立したrelease provenance

- Release Pleaseのroot component outputs `release_created`、`tag_name`、`sha`は公式[action README](https://github.com/googleapis/release-please-action#outputs)と一致する。通常経路は`release-output`でRelease SHAとstaged SHAを一致させる。
- draft releaseを拒否し、lightweight tagと最大5段のannotated tagをcommitまでpeelする。cycleと5段超過をfail closedにする。独立fixtureで5段成功とcycle拒否を確認した。
- `/compare/{sha}...main`のmerge baseをSHAと一致させ、main ancestorだけを許す。
- deploymentはstage、exact SHA、strict payload、GitHub Actions bot creatorを要求する。payloadのrun IDからrunを引き、event=`push`、branch=`main`、repository/head repository、workflow path/refを照合する。
- workflow jobsは`filter=latest`を使い、`Deploy staging`の`head_sha`と`conclusion=success`を要求する。GitHub公式の[workflow jobs契約](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10)は`latest`をrunの最新executionと定義し、job responseに`head_sha`、`name`、`conclusion`を含む。[Workflow run response](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10)には`path`、`repository`、`head_repository`、`run_attempt`がある。
- public validation jobはEnvironmentと`secrets.*`を持たない。dispatchではcandidate inputをcheckout refやshellへ渡さず、`refs/heads/main`のvalidatorへenvとして渡す。production Environmentはvalidation成功後だけ評価され、approval後の最初の製品処理として同じrelease/tag/main/staging記録を再検査する。
- post-approval再検査後にtag/statusが移動する時間窓は残るが、production checkoutと全config/provenance/smokeはvalidation outputのfull SHAへ固定されるため、後続のtag移動で任意SHAへ切り替わらない。

## Health / smoke確認

- Workers bootは`DEPLOYMENT_SHA`をfull lowercase 40桁、`DEPLOYMENT_ENV`をstage union、DB URL authorityを`EXPECTED_DATABASE_IDENTITY`と一致させる。health DB checkは実clientへの`SELECT 1`である。
- `GET /healthz`はDB成功後だけ`status`、`deploymentSha`、`deploymentEnv`、`databaseIdentity`をJSONで返す。`HEAD`はbodyなし。DB errorはdetailを捨てた503 `unavailable`。200/503とも`Cache-Control: no-store`を持つ。
- smokeはHTTP、credential、明示port、root以外のpath、query、fragmentを開始前に拒否し、redirectをfollowしない。レスポンスは200かつstrict 4-field JSONだけを受理する。
- SHA/stage/DB identity mismatch、HTTP error、JSON parse error、network error、timeoutをretryする。既定は1 request 10秒、最大18回、間隔5秒。最終errorは固定文言でresponse bodyを含めない。
- 独立matrixでTLS/credential/port/path/query/hash、2回timeout、retry、503 body secret非反映を確認した。W-C3-HELPER-002のsuffix以外はPASS。

## Workflowとproduction同一SHA

- `push.main`だけがverify→staging→Release Pleaseを実行する。tag push、PR、dispatchはstaging/releaseを実行しない。
- stagingは`environment: staging`、`fog-staging` concurrency、cancel=false。config render、build/provenance、dry-run、deployment in-progress、migration、secret sync、deploy、smoke、success statusの順で、failure時はfailure statusを追加する。
- productionはpublic validator outputのSHAを明示checkoutし、`DEPLOYMENT_SHA`へ設定する。approval後revalidation、production config render、fresh artifact/provenance、dry-run、migration、secret sync、deploy、同一SHA health smokeの順である。
- production jobだけが`environment: production`とproduction secretsを参照する。[GitHub Environment契約](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)ではrequired reviewer承認前にjobは開始せず、environment secretsへアクセスできない。
- 全actionは40桁commit SHAへ固定され、`persist-credentials: false`。4 SHAのGitHub commit pageが存在することを確認した。workflow default permissionsは空で、jobごとのcontents/actions/deployments/pull-requestsだけを付与する。
- shell commandへdispatch入力を直接展開しない。tag、SHA、repository、IDをZodでdecodeしてからURL/JSON/GitHub outputへ使う。shell metacharacter、空白、改行、uppercase/short SHA、unknown event/path/repository/job/stateはfail closedとなる。

## GitHub API契約確認

- `X-GitHub-Api-Version: 2026-03-10`は2026-09-06時点の最新supported versionである。[GitHub API versions](https://docs.github.com/en/rest/about-the-rest-api/api-versions)
- Release responseには`draft`、`prerelease`、`tag_name`がある。B-C3-PROV-001はresponse fieldの欠落ではなく実装側の未検査である。[GitHub Releases](https://docs.github.com/en/rest/releases/releases?apiVersion=2026-03-10)
- deployment/status/jobs endpointsはいずれも`per_page`最大100のpaginated endpointである。B-C3-PROV-003は公式pagination契約との不一致である。[Deployments](https://docs.github.com/en/rest/deployments/deployments?apiVersion=2026-03-10)、[Deployment statuses](https://docs.github.com/en/rest/deployments/statuses?apiVersion=2026-03-10)、[Workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10)
- 403/429では自動retryせずgeneric status errorで停止する。body/tokenはerrorへ含めない。独立429 fixtureでsecret body非反映を確認した。GitHub公式は`Retry-After`または`X-RateLimit-Reset`まで待つよう求めるため、現在の「停止してworkflowを再dispatch」は安全側だが自動回復ではない。[GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)

## 独立テスト結果

| 実行 | 結果 |
| --- | --- |
| manifest block digest + `shasum -a 256 -c` | PASS。block hash一致、62/62一致。 |
| `pnpm exec vitest run apps/web/scripts/cloudflareDelivery.test.ts` | PASS、1 file / 24 tests。既存testは3 blockerと2 warningを検出しない。 |
| C3 provenance独立hostile test | 5/5 PASS。prerelease受理、new failure + old success受理、Link page 2無視、non-apex suffix受理、repository dot traversalを現挙動として再現。一時test削除済み。 |
| Deno独立helper matrix | tag peel 5段/cycle、429 fail-closed/body非反映、TLS/credential/port/path/query/hash、timeout/retry/no-body-leak PASS。 |
| Cloudflare runtime focused | PASS、1 file / 5 tests。workerd shutdown時の既知diagnosticあり。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。213 files。既存`staticAssets.test.ts:42`のinfo 1件のみ。 |
| `pnpm format:check` | PASS。229 files。 |

## 再レビュー条件

1. Release responseで`draft: false`と`prerelease: false`を両方要求する。
2. 同一SHA/environmentの最新deploymentを一意に決定し、そのcurrent statusとrun/jobだけを検証する。古いsuccessへfallbackしない。
3. bounded・same-originのpaginationを実装し、page 2、100件境界、Link cycle、別origin、malformed Link、rate limitをtestする。
4. repository segmentのdot traversalを拒否する。smoke helper単体にもC2と同じstage origin検査を適用するか、先行validated configを型で要求する。
5. 修正manifestを固定し、既存24件と独立hostile再現、actionlint、unit/workerd、両stage build/dry-runを再実行する。

## 2026-09-06 最終再検証（修正後）

### 判定

2026-09-06T05:33:00+09:00から2026-09-06T05:42:00+09:00まで、HEAD `7d449cf62c548f2084b30568b3f99e5535b37a28`と修正後manifestを独立再検証した。この節の判定を最新とし、総合判定は **PASS（local）** とする。B-C3-PROV-001から003およびW-C3-HELPER-001から002の元再現はすべて解消した。新しいBlockerとWarningは検出しなかった。

外部資格情報を使わず、GitHub、Cloudflare、Turso、DNS、OAuth、Emailへ変更を加えていない。GitHub-hosted run、実deployment record、Environment approval、実HTTPS endpoint、実migration/secret sync/deploy/smokeは引き続き未検証である。

### 対象固定

- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- manifest: `.goal-implement/cloudflare-deploy/phases/C3.md`記載の62ファイル
- manifest block SHA-256: `99b1b5fc5daeeb039c7af8de53613642c113b603f5c4f014a4b8678412d3e59b`
- 照合: block digest一致、62/62 `OK`。独立fixture削除後にも再照合した
- 一時fixture: `apps/web/scripts/c3-provenance-final-review.test.ts`を8件の再現後に削除した。manifest対象外のfileを残していない

### CF別判定

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| CF04 SHA health / staging deployment | PASS（local） | full SHA、stage、DB authorityをboot前に検査し、healthは実DB `SELECT 1`成功時だけSHA/stage/identityを返す。smokeは独立DOMAINから生成したstage originとの文字列完全一致、TLS、credential/port/path/query/hashなし、redirect拒否を要求する。既存60 testsとworkerd focused 5 testsがPASSした。 |
| CF05 Release / production provenance | PASS（local） | releaseは非draft・非prerelease、tag peel後のexact SHAとmain ancestryを要求する。deployment/statusを全pageから最新時刻と一意IDで確定し、古いsuccessへfallbackしない。payloadのrun ID/attempt/SHA/path、runのpush/main/repository/head repository/path、attempt endpointのexact staging job一意性/SHA/successを照合する。公開validationの7 fingerprintをapproval後に再取得して完全一致させる。 |
| CF06 helper / recovery security | PASS（local） | repositoryをowner/nameごとに制限してpath segmentをencodeし、API URLを`https://api.github.com/repos/{owner}/{name}/...`へ固定する。paginationはsame-origin・same-path・same-queryで100件/page、最大10 pageに制限し、cycle、malformed、duplicate next、cross-origin、query drift、duplicate record、oversized pageを拒否する。dispatch入力はtrusted validatorへenvで渡され、candidate checkoutとproduction Environmentより前に検査される。 |

### 旧BlockerとWarningの元再現

| ID | 修正後判定 | 独立観測 |
| --- | --- | --- |
| B-C3-PROV-001 prerelease | PASS | `draft: false, prerelease: true`を返すfixtureはrelease response decodeでrejectした。 |
| B-C3-PROV-002 new failure + old success | PASS | ID 100の最新failureとID 99の旧successを返すfixtureは`Latest staging deployment status is not successful`でrejectした。旧ID 99のstatuses endpointは呼ばれず、fallbackがないことも確認した。 |
| B-C3-PROV-003 page 2 | PASS | deployments、statuses、jobsを各100件のpage 1と1件のpage 2へ分割したfixtureは、3 endpointすべてのpage 2を取得し、deployment ID 101、status ID 201、run attempt 2を受理した。 |
| W-C3-HELPER-001 repository dot segment | PASS | `../fog`、`owner/..`、`owner/%2e%2e`、3 segment、改行をAPI request前にrejectした。生成API URLも固定origin、encoded owner/name、固定repository prefixを保持する。 |
| W-C3-HELPER-002 smoke suffix | PASS | `staging-fog.example.com.evil.com`、subdomain prefix、末尾dot、punycode、credential、明示port、非canonical slash/caseをfetch前にrejectした。 |

### Paginationとlatest authority

- deployments、選択deploymentのstatuses、選択run attemptのjobsは同じbounded helperを通り、各responseをZod decodeしてから最大100件を累積する。
- `Link`は全要素をparseし、`rel="next"`を最大1件だけ許す。next URLはGitHub API origin、初回と同一pathname、初回queryの不変値、単一の正整数`page`だけを許す。
- 100/101件境界を3 endpointすべてで独立実行し、page 2の最新deployment/statusとexact jobへ到達した。
- malformed、cross-origin、environment query drift、複数next、cycle、重複ID、101件の単一page、10 pageを超えるnextをfail closedにした。
- deploymentとstatusは全取得後に`created_at`降順、同時刻では一意ID降順でauthorityを1件に固定する。最新がfailure/error/inactive/in-progress/queued/pending、またはstatusなしなら旧successを探索しない。
- jobsはpayloadとrun responseが一致した`run_attempt`固有endpointを使う。unrelated jobは許可し、`Deploy staging`は全pageでexactly oneを要求する。duplicate exact job、wrong SHA、非success、run attempt driftを拒否する。

### Approval後TOCTOU

公開validationはrelease ID/update time、tag object SHA、staging deployment ID、latest status ID、run ID、run attemptをoutputする。production Environment承認後、production migrationより前にrelease/tag/main/deployment/status/run/jobを再取得し、同じ検証を再実行する。

独立fixtureで7 fingerprintを1項目ずつ変化させ、すべて`Release provenance changed after public validation`でrejectした。部分的なEXPECTED入力もrejectする。tag/SHA自体は公開validation outputのschema済み値をproduction checkout、`DEPLOYMENT_SHA`、再validationへ共通で渡すため、approval中のtag force-moveでcheckout対象が切り替わらない。main ancestry、最新deployment/status、run attemptとjob conclusionも承認後に再評価される。

### Release/tag/run/deployment consistency

- Release responseはexact tag、ID、非draft、非prerelease、更新時刻を要求する。
- lightweight tagと最大5段のannotated tagをcommitまでpeelし、cycleと深さ超過を拒否する。tag ref object SHAをapproval後照合へ渡す。
- tag commitは入力full SHAと一致し、`compare/{sha}...main`のmerge baseも同じSHAでなければならない。
- deploymentはexact SHA/staging、GitHub Actions bot creator、strict payloadを要求する。payloadはrun ID、run attempt、workflow path、SHA以外を許さない。
- runはpayload ID/attempt、push、main、exact SHA、workflow path、repositoryとhead repositoryの一致を要求する。
- normal releaseはRelease Please action output SHAとstaging job output SHAの一致をproduction validation前に要求する。recoveryはtrusted `refs/heads/main`のvalidatorが入力tag/SHAをAPI照合してからproductionへ渡す。

### Health/runtime回帰

- Workers bootはfull lowercase 40桁SHA、stage、HTTPS remote DB、stage別expected DB identityと実`DATABASE_URL` authority、stage別APP URLをclient利用前に検査する。
- `/healthz`はGET/HEADだけを受け、DB `SELECT 1`成功時にstrict smoke schemaの4 fieldを返す。DB failureはdetailなし503となり、health responseは`Cache-Control: no-store`を持つ。
- smokeは既定18 attempts、1 request 10秒、5秒間隔でSHA/stage/DB readinessを照合する。HTTP bodyと例外detailを最終errorへ反映しない。
- Cloudflare runtime focusedは1 file / 5 tests PASS。終了時の`Called close before connection was established` diagnosticは既知のworkerd shutdown出力であり、test exit codeは0だった。

### 独立テスト結果

| 実行 | 結果 |
| --- | --- |
| manifest block digest + `shasum -a 256 -c` | PASS。`99b1b5…e59b`一致、62/62 `OK`。 |
| `pnpm exec vitest run apps/web/scripts/cloudflareDelivery.test.ts` | PASS、1 file / 60 tests。 |
| C3 provenance独立fixture | PASS、1 file / 8 tests。旧3 blocker、100/101境界、latest status、pagination hostile/max、multi-job/attempt、7-field TOCTOU、repository/hostを確認。一時file削除済み。 |
| `pnpm exec vitest run --config vitest.config.integration.cloudflare.ts apps/web/app/worker/cloudflare/runtime.cloudflare.test.ts` | PASS、1 file / 5 tests。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。213 files。既存`apps/web/scripts/staticAssets.test.ts:42`のinfo 1件のみ。 |
| `pnpm format:check` | PASS。229 files。 |

phase C3が記録するactionlint、full unit 182 tests、Node integration 94 tests、workerd 8 tests、両stage fresh build/dry-runは今回重複実行していない。独立再検証では製品コード、workflow、artifact、generated configを変更していない。
