# PR #33 第4回レビュー — Cloudflare Infra / Operations + Tests / Spec / Acceptance

## 判定

**CHANGES_REQUESTED**

対象: `main...e2ec1ace9c15b281a120ee577a56c23ec4d0936e`

- Blockers: 6
- Warnings: 4
- Notes: 3

PR の3必須 CI jobは現 HEAD で成功している。第3回後に `tsx` の直接依存、PITR restart/conflict の fail-closed 化、rotation conflict時のcursor保持、canonical release preflight、旧fixtureからの3 class migration testは改善された。

一方、実際の PITR runbook は restore 出力を undo へ渡せず、release gate は User Data / Identity Directory の両方を実行した証拠を要求しない。rotation の「旧世代参照ゼロ」は現データモデルとoperatorでは達成・観測できない。request acceptance と traceability auditにも、実装や証拠が不足していても green になる経路が残る。

## Blockers

### B-IT4-001 — PITR `restore` の出力をrunbookどおり `undo` へ渡すと必ず拒否される

- 場所:
  - `apps/web/scripts/pitr-operator.ts:34-45,70-90,92-118,121-148`
  - `docs/runtime_cloudflare.md:300-328`
  - `.github/workflows/ci.yml:70-71`
- 根拠:
  - `restore()` は `verifyUntilComplete()` の戻り値を出力し、成功時のJSONは `{ "receipt": {...version: 2...}, "verification": ... }` になる。
  - `undo` の `receipt()` は入力JSONのトップレベルに `version === 2` を要求する。
  - runbookはstep 5の出力を「version 2 receipt」と説明し、step 7で「step 5が出力したexact receipt」をそのまま `undo "$PITR_RECEIPT_JSON"` へ渡すよう指示する。その出力にはトップレベル `version` がないため、`receipt-json must be a version 2 PITR receipt` で停止する。
  - CIのoperator smokeは `--help` だけで、このrestore→undo往復を実行しない。
- 影響:
  - staging smokeはrestoreまで成功してもundoできず、TEST-OPS-001、AC-13、runbookの「undo verification成功まで完了扱いしない」を達成できない。
- 修正案:
  - CLI出力契約を一つに固定する。たとえば `restore` / `undo` は再利用可能なreceiptをトップレベルで出し、verificationをその中のmetadataにする。または `undo` が `{receipt, verification}` を正規化して受理し、runbookにも抽出方法を明記する。
  - fake operator HTTP serverを使い、`restore` のstdoutを無加工で `undo` のargvへ渡して成功するCLI contract testを追加する。

### B-IT4-002 — release preflightは両PITR対象の実行を証明せず、手編集した1レコードだけで通過できる

- 場所:
  - `apps/web/scripts/release-preflight.ts:7-14,63-98,100-121`
  - `apps/web/scripts/__tests__/release-preflight.test.ts:33-66`
  - `spec/inventory/test.md:65-66`
  - `spec/inventory/test-evidence.json:318-337`
  - `docs/runtime_cloudflare.md:267-331`
- 根拠:
  - TEST-OPS-001とrunbookは disposable staging の **User Data と Identity Directory** を別々にrestore/verify/undoすることを要求する。
  - gateが読むのは `.thread/19/test-results.json` の単一レコードで、検査項目は `result`、`stage`、空でない `namespace`、parse可能な `verifiedAt`、現在より未来の `expiresAt` だけである。class、対象object、bookmark、restore/undo receipt、Directory全page/conflict 0、User Data epoch、実行commit/run URLを持たない。
  - `verifiedAt` が未来でも、`expiresAt` が無期限に遠くても通る。repository内JSONを `passed` に書き換えるだけで、実operatorの成功や両classの実施とは独立にcanonical production deployを解錠できる。
- 影響:
  - User Dataだけ、Directoryだけ、または何も実行していない状態を「staging PITR済み」と誤認し、restore/undo不能なreleaseを本番へ進められる。
- 修正案:
  - class別の必須証跡を2件要求し、stage、opaque target、before/restore/undo bookmark、receipt version、verify結果、Directory最終cursor/conflict累積、verifiedAt、固定TTL、HEAD SHA、CI/manual run IDを構造化する。
  - `verifiedAt <= now < expiresAt` と最大有効期間を検査し、同じrun/commitでUser DataとIdentity Directoryの両方が成功した時だけgateを開く。可能なら手編集ファイルではなく保護されたworkflow artifact/environment approvalを正本にする。

### B-IT4-003 — routing secret rotationの「旧世代参照ゼロ」は達成も確認もできない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1329-1407,1638-1683`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:632-662,780-821`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:424-472,572-600`
  - `apps/web/app/operator/identity-maintenance.ts:12-23,64-78,118-143`
  - `docs/runtime_cloudflare.md:137-172`
  - `spec/database/index.md:219-221`
- 根拠:
  - conflict時にcursorを保持する修正は有効である。
  - 正常移送後は、Directoryの旧mappingとAccount Homeの旧reverse locatorを削除せず、双方を `tombstoned` に更新する。rotation scanは `state = 'active'` だけを再走査するため、それらは残ったままcheckpointを `completed` にできる。
  - `status` は1 Directory shardの全state合計だけを返し、generation別の残存数でもAccount Home reverse locator数でもない。全Account Homeを列挙して旧generation参照を数えるoperatorもない。
  - runbook/specは両側のprevious-generation referenceがゼロになってから旧secretを削除すると定義するが、現実装ではその状態を達成・証明する手段がない。release preflightもrotation完了証跡を要求しない。
- 影響:
  - operatorはcheckpoint完了を「旧鍵を破棄してよい」と誤認し得る一方、文書どおりのzero-reference確認は実行不能である。stale reverse locatorや移送漏れを見逃すと旧世代credentialのログイン不能、逆に鍵を残すとrotation未完了になる。
- 修正案:
  - 「参照ゼロ」をactive参照ゼロに定義し直すならspec/runbookを明確化し、全64 shardとAccount Home側のgeneration別active countを機械的に集計するoperator/release gateを追加する。
  - tombstone自体もゼロにする契約なら、保持期間とauthority照合後のbounded purgeを実装する。いずれも両側0件を確認するまでprevious secret削除を拒否し、移送→conflict→再開→両側0→secret removalをintegration/operations testにする。

### B-IT4-004 — request integrationは本番entry/server actionを通らず、TEST-PRESとAC-1のfalse positiveになる

- 場所:
  - `vitest.config.integration.ts:8-10`
  - `apps/web/app/testing/request.integration.worker.ts:43-80,82-145,147-163`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:82-215`
  - `apps/web/app/server.cloudflare.ts:37-55`
  - `apps/web/app/components/auth/LoginForm/action.ts:7-20`
  - `apps/web/app/components/auth/SignupForm/action.ts:7-20`
  - `spec/inventory/test.md:54-57`
  - `spec/inventory/test-evidence.json:272-298`
- 根拠:
  - workerd request suiteの `main` はproduction `server.cloudflare.ts` ではなく、テスト専用 `/acceptance/*` Workerである。
  - test WorkerはJSON envelope、cookie読取/書込、error translation、action dispatchを独自実装し、production handlerなど一部の内側だけを共有する。
  - productionはTanStack `defaultEntry.fetch`、`createServerFn`、middleware、dynamic `loadServerDeps`、framework cookie API、`startSession`を通るが、この経路はbehavioral testされない。
- 影響:
  - server-fn登録、middleware順序、session cookie連携、production entryのbinding/container、serializationが壊れても、TEST-PRES-001/002/004と「request/state boundary」はgreenのままになる。build成功はこの実行時契約を代替しない。
- 修正案:
  - production request bundle/entryをMiniflareのmainとして起動し、実server-fn endpointまたは実画面からsignup/login/current/logoutとcookie往復を行う。
  - fixture投入が必要ならoperator/test-only補助Workerへ分離し、検証対象の公開requestはproduction `defaultEntry.fetch` を必ず通す。TEST-PRES evidenceをそのtestへ付け替える。

### B-IT4-005 — TEST-APP-003は同じ公開errorしか確認せず、dummy/real verify contractを検証していない

- 場所:
  - `spec/inventory/test.md:19`
  - `spec/testcases/identity/loginWithPassword.md:7-11`
  - `spec/usecases/identity.md:58-68`
  - `spec/inventory/test-evidence.json:72-82`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:156-215`
  - `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts:70-155`
- 根拠:
  - inventory/testcaseは未登録、SSO-only、誤password、不正形式についてdummyまたは実verifyを1回行い、同じ公開errorとPII非ログを保証すると宣言する。
  - request integrationが比較するのは4応答のstatus/bodyだけで、hasher call数、dummy hash/保存hashの選択、Directory/Account Home call profile、ログを観測しない。
  - evidenceに紐づくunit testは、unknown addressでdummy hashが読めない時のwarning型とlatchを検査するだけである。SSO-only、wrong password、malformedのwork profileを固定しない。
- 影響:
  - unknown/SSO-only/malformedで高コストverifyを削除する、余分なauthority lookupを一分岐だけ省く、PIIを分岐ログへ出す、といった列挙耐性の回帰が全必須CIを通る。
- 修正案:
  - 4失敗分岐を同じspy付き `PasswordHasher` / identity portでtable testし、verifyが厳密に1回、dummy/real hashが期待どおり、authority lookup回数が同じ、公開errorが同じ、捕捉ログにemail/password/分岐理由がないことを表明する。
  - TEST-APP-003 evidenceはこの決定的contract testを直接参照する。

### B-IT4-006 — traceability auditはテスト実行結果を検証せず、staleな自己申告をgreenにする

- 場所:
  - `scripts/audit-test-traceability.mjs:15-26,100-110,113-179,182-192`
  - `.thread/19/test-results.json:2-6,51-59`
  - `.github/workflows/ci.yml:95-104`
  - `spec/inventory/test-evidence.json:72-89,272-355`
- 根拠:
  - auditのpassing suite判定は `test-results.json` に `result: "passed"` と書かれているかだけであり、test reporter、GitHub Actions conclusion、実行SHAを読まない。test名も `source.includes(record.test)` の文字列存在だけで、該当testがtarget contractをassertしたかを検査しない。
  - `ci-command` もworkflow文字列と自己申告passedを見るだけである。release gateがpendingでもpending一覧を表示してexit 0になる。
  - 現 HEADは `e2ec1ac...` でCIも完了済みだが、committed `test-results.json` は `baseCommit: 502776e...`、`source: working-tree`、`workingTree: true`、`committedCi: pending`、理由は「fixes are not committed」のままである。この矛盾をauditは検出せず、実際に `pnpm audit:test-traceability` は成功する。
- 影響:
  - B-IT4-004/005やTEST-APP-004、TEST-OPS-003のような意味的coverage不足、古い実行結果、未実施release gateを「34 TEST IDs traced」と表示できる。CI greenがIssue/specの受入証拠にならない。
- 修正案:
  - CIでHEAD SHA、workflow run/job URL、各suiteのmachine-readable reporter artifactから結果を生成し、committed自己申告を正本にしない。少なくとも `baseCommit === HEAD`、clean/committed source、必須CI conclusionを検査する。
  - TEST IDをtest metadata/tagへ埋め込み、実行reportからIDと成功testを集計する。文字列一致は構造検査に限定し、manual/release pendingは通常CIの情報とrelease gateのfail-closed判定を分離する。

## Warnings

### W-IT4-001 — Directory Alarm reconcilerはspecのper-operation状態を持たず、未分類stateでhot loopになる

- 場所:
  - `spec/database/index.md:215-217`
  - `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:99-108`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:206-339`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:824-923`
- 理由:
  - specはjobに `operation_id`、Account Home locator、phase、attempt、next run、last errorを持つとするが、実schemaはshard全体で1行のsingletonである。
  - expired rowでUser Data/authority/operationが存在する一方、operation stateが `pending` 等の処理対象外ならactivateもtombstoneもせず残る。`finishReconcile()` はその期限切れ時刻を `now` に丸め、attempt/errorを0/NULLへ戻して即時Alarmを再設定するため、backoff/poisonなしの再起動ループになる。
  - Identity Directoryの実 `alarm()` を `runDurableObjectAlarm` で駆動するintegration testはない。
- 提案:
  - 全operation stateを明示的にresume/compensate/retryable failure/poisonへ分類し、進展しないrowではattemptとbackoffを保持する。specどおりper-operation jobにするか、singleton設計へspecを同期し、実faultからAlarm再開・eviction・poisonを検査する。

### W-IT4-002 — TEST-APP-004はcurrent-userの片側unavailableを検査していない

- 場所:
  - `.thread/19/plan.md:80`
  - `spec/inventory/test.md:20`
  - `spec/inventory/test-evidence.json:84-89`
  - `apps/web/app/presentation/__tests__/currentUser.test.ts:112-152`
- 理由:
  - acceptanceはAccount HomeまたはUser Dataがunavailableなら古い片側で成功せずretryable errorにすることを要求する。
  - evidenceはsession epoch不一致でnullになる1件だけで、Account Home failure、User Data failure、片側だけ取得済みのケースを検査しない。
- 提案:
  - `getCurrentUser` compositionに両依存の個別failureを注入し、partial DTO/nullへ縮退せず同じretryable infrastructure errorになることを固定する。

### W-IT4-003 — TEST-OPS-003はRPC compatibility windowとrequest rollbackを検査していない

- 場所:
  - `.thread/19/testing.md:184-192`
  - `spec/inventory/test.md:67`
  - `spec/inventory/test-evidence.json:339-354`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:82-110`
- 理由:
  - evidenceはsecret分離unit、staging dry-run command、secret inventory gateである。request testのversion mismatchも未知version拒否だけで、state先行時のold request/new state、new request/current state、request deploy失敗後rollbackを検証しない。
- 提案:
  - version切替可能なauxiliary state Workerとrequest fixtureを用意し、互換windowの組合せ成功、非互換時の構造化error/no mutation、request rollback後の旧request継続を自動化する。

### W-IT4-004 — remote staging PITRとsecret inventoryは未実施で、現時点ではrelease-readyではない

- 場所:
  - `.thread/19/progress.md:3-29`
  - `.thread/19/test-results.json:60-76`
  - `apps/web/package.json:29-48`
- 理由:
  - PITR smokeとauthenticated secret inventoryは正しく `pending` と記録され、local workerdで代替しない判断も妥当である。
  - canonical deployは現状態でPITR gate/secret checkにより停止するため、未実施をすり抜ける現在のscript経路は確認できなかった。ただしB-IT4-001/002を直すまでは、そのgateを正しく完了することもできない。
- 提案:
  - 修正後、認証済みdisposable stagingで両classのrestore/verify/undoとsecret inventoryを実施し、保護された証跡を確定してからreleaseする。

## Notes

### N-IT4-001 — 現HEADのPR CIは3 jobすべて成功している

- `Lint / Format / Typecheck / Unit tests`: pass
- `Cloudflare integration tests`: pass
- `Cloudflare build and configuration audit`: pass
- Run: `30297557438`

これはclean install、unit/integration、lifecycle CLI、operator dependency smoke、build、staging dry-run、legacy auditが再現可能になったことを示す。ただしBlockerで示したremote/semantic acceptanceの代替ではない。

### N-IT4-002 — canonical release順序とsecret/config gateは第3回から改善された

- `deploy:{staging,production}` は release preflight → state → request → routes の順に固定された。
- preflightはresources/routesのaccount/zone/hostname/Worker名を照合し、authenticated secret inventoryと両Worker dry-runを実行する。
- request/state secret allowlistと、通常時の余分なrequest secret拒否もunit testで固定されている。

### N-IT4-003 — 3 class migrationの主要な失敗条件は実workerd testへ移された

- ordered/idempotent/forward-only/newer-version拒否に加え、User Data、Identity Directory、Account Homeの実v1 fixture、途中失敗rollback、eviction後のlazy retryを検査している。
- 今回の再評価ではmigration実装・受入証拠に新しいBlockerは確認しなかった。

## 確認内容

- `git diff main...HEAD` のCI、release scripts、Wrangler/Pulumi、secret、PITR、rotation/reconcile、migration、request boundary、test inventory/evidenceをゼロベースで確認
- Issue #19、`.thread/19/plan.md`、`.thread/19/testing.md`、`spec/database/index.md`、`spec/inventory/test.md`、個別testcase、runbookと実装を照合
- `gh pr checks 33` — 3 job pass
- `pnpm audit:test-traceability` — pass。ただしB-IT4-006のstale/self-attested結果を受理することを確認
- コード変更、commit、pushは未実施
