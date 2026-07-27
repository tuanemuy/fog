# PR #33 第2回レビュー — Tests / Spec / Acceptance traceability

## 判定

**BLOCKED**

第1回後に request/state の2 Worker integration、3 class migration、検索 snapshot、persistent job、local lifecycle CLI、legacy/traceability audit が追加され、基礎的な workerd coverage は大きく改善した。ただし Issue #19 が contract test を明示的に受け入れ条件にしている identity fault matrix、検索 lifecycle、Alarm fault matrix、PITR staging smoke は未達である。さらに test inventory は未実装ケースを `automated` と記録し、監査は evidence の実在や対応テストを検査しないため green になる。PR の必須 CI も staging dry-run で失敗中であり、AC-16 を満たしていない。

## Blockers

### B-TS2-001 — PR の必須 CI が赤で、AC-16 の Cloudflare build/dry-run gateを満たさない

- 場所:
  - `.github/workflows/ci.yml:67-93`
  - `apps/web/package.json:20-26`
  - `apps/web/scripts/render-wrangler.ts:20-31`
- 根拠:
  - PR #33 の最新 checks は `Cloudflare integration tests` と `Lint / Format / Typecheck / Unit tests` が成功している一方、`Cloudflare build and configuration audit` が失敗している。
  - 失敗箇所は `pnpm deploy:staging:dry` の pre-script であり、`pulumi ... stack output --json` が CI にない `PULUMI_ACCESS_TOKEN` を要求して終了している。
  - shell は fail-fast なので、同 job 後段の `audit:legacy` / `audit:test-traceability` も CI 上では実行されていない。
- 影響:
  - `.thread/19/plan.md:32` の AC-16 と、同 `:235` の最終 gate を満たさず、merge可能な状態ではない。
  - dry-runを必須チェックにしたものの、PRから再現可能な hermetic gateになっていない。
- 修正案:
  - CI 用に認証不要の固定fixture/ローカル stack backendで Wrangler config を生成するか、必要な read-only Pulumi credentialを明示的に供給する。
  - audit は dry-run と別 step/job にして、dry-run失敗時にも結果が得られるようにする。

### B-TS2-002 — identity inventory が「全 fault point / reconciler / primitive state machine」を自動化済みと誤記している

- 場所:
  - `spec/inventory/test.md:17-21,43-46`
  - `.thread/19/testing.md:107-116,128-137,175-189`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:58-276`
  - `spec/testcases/identity/registerWithPassword.md:8,23`
  - `spec/testcases/identity/registerOrLoginWithSso.md:16-17`
  - `spec/testcases/identity/executePasswordReset.md:10-11`
- 根拠:
  - 実際の identity integration は signupの固定DTO再送、version mismatch、逐次SSO email競合、完了後delete再送、reset happy/replay、gatewayを直接呼ぶrotationの6件だけである。
  - reserve/init/finalize各phaseのfault injection、期限切れreservation、reconciler、並行SSO初回、active/previous競合、change/link/unlink、reset各phase、delete途中再開、RPC platform throw/retry/overloaded は存在しない。
  - signup再送testは同じ固定 `passwordHash` を gateway に2回渡すため、公開usecaseが再送ごとにrandom saltで再hashする実経路を通らない。実装の `IDENTITY_OPERATION_PAYLOAD_CONFLICT` 回帰を隠す false positive である。
- 影響:
  - AC-2/AC-3 が明示的に要求する contract test 条件を満たさない。
  - 別レビューで検出された signup再送不能、SSO途中失敗、reset/link/unlink/deleteの不整合がすべて green のまま残る。
- 修正案:
  - fault可能な Directory/Account Home/User Data auxiliary stubまたはDO test hookを用意し、全phase直後で一度失敗させ、同一operation再送とreconcilerで最終状態が一意に収束することを検証する。
  - signupは `registerWithPassword` 公開usecaseから同じ operation/email/plain password を再送する。
  - inventoryは未実装ケースを `pending` に戻し、テスト名単位のevidenceへ分解する。

### B-TS2-003 — request→state boundary test は本番 request Worker / route を通らず、AC-1 の認証済み routing を証明しない

- 場所:
  - `vitest.config.integration.ts:8-47`
  - `apps/web/app/testing/request.integration.worker.ts:22-46,68-145,167-200`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:22-109`
  - `spec/inventory/test.md:27-29,54-57`
- 根拠:
  - integration main は本番 `server.cloudflare.ts` ではなく、テスト専用 `/acceptance/*` Workerである。
  - routing override拒否はテストWorkerだけに置いたキー名deny-listであり、本番action/schema/routerの入力を検証していない。
  - `/acceptance/user-data/profile` はsessionを検証せず、常に `getByName("acceptance-session-user")` を直接呼ぶ。したがって「認証済み userId だけから唯一のDOを選ぶ」実配線が壊れてもテストは通る。
  - signup/login/current/logoutも本番 route action、middleware、cookie optionを経由せず、usecaseと簡易cookie処理をテストWorker内に再実装している。
- 影響:
  - `script_name` 越しRPC自体は確認できるが、AC-1、TEST-DO-003、TEST-PRES-001/002/004 の証拠としては false positive である。
- 修正案:
  - 本番 request entryか本番action/middlewareを呼ぶ薄いtest entryをmainにし、実routeへのHTTPで signup → current → logout → login と認証済みUser Data routingを通す。
  - 別user ID/DO IDをpayload・query・formへ混ぜてもrouting先が変わらないことを、2 accountの実fixtureで検証する。

### B-TS2-004 — AC-12 の Alarm/job fault matrix が未実装なのに全項目 `automated` になっている

- 場所:
  - `.thread/19/plan.md:28,143-147,232`
  - `spec/inventory/test.md:21,35-37`
  - `.thread/19/testing.md:128-137,183-189`
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:35-202`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:407-438`
- 根拠:
  - job testの中心は `runInDurableObject` 内で `DurableJobStore` を直接操作するstore testで、実 `alarm()` handlerと外部adapter/provider副作用を通らない。
  - `runDurableObjectAlarm` の唯一のケースは期限切れtrashを1件正常purgeするだけで、at-least-once再実行、alarm途中失敗、最大retry後の自前再設定、provider idempotency、`setAlarm`失敗後input gate、eviction/restart、time budgetを検証しない。
  - `TEST-DO-009` のevidenceはlease/CAS/poisonを含む `userDataJobs.integration.test.ts` すら指さず、「bounded retention executor」だけで全契約を満たしたことにしている。
- 影響:
  - AC-12 は「統合テストで確認できる」こと自体が受け入れ条件であり、実装有無とは別に未達である。
  - alarm scheduling/retryの破損や重複外部副作用をCIが検出できない。
- 修正案:
  - faulting provider/clock/storage-alarm harnessを追加し、実 `alarm()` を複数回駆動してclaim、失敗、lease reclaim、owner CAS、retry、poison、再設定、再起動後回復を永続storage上で表明する。
  - `setAlarm` failure後の次RPC inputで最早時刻が復元されるケースを独立testにする。

### B-TS2-005 — PITR は release gate 未実施で、automated testも「restore後」の権威照合を検証していない

- 場所:
  - `.thread/19/progress.md:3-17`
  - `.thread/19/plan.md:29,44,221,234`
  - `spec/inventory/test.md:65-67`
  - `packages/core/src/adapters/cloudflare/pitrOperator.ts:39-51`
  - `apps/web/app/operator/pitr.ts:23-29,80-106,142-160`
  - `packages/core/src/adapters/cloudflare/__tests__/pitrPolicy.test.ts:64-141`
  - `docs/runtime_cloudflare.md:247-254`
- 根拠:
  - progress自身が staging bookmark/restore/undo restore と secret inventoryを未実施と記録している。AC-13 は staging smokeを明示的に要求している。
  - `onNextSessionRestoreBookmark` は次sessionへrestoreを予約するAPIで、runbookも object session restart 後に適用されると説明する。一方 `schedulePitrRestore` は予約直後、まだrestore前に2回目のAccount Home readを行って成功を返す。unit testもこの同期sequenceをfakeで確認するだけである。
  - operator入力の `objectName` と `accountId` は独立文字列で、対象User Dataと照合Account Homeが同一userであることを検証しない。Directory shardについても任意の単一accountを照合するだけである。
- 影響:
  - TEST-OPS-002 の「復旧前後epoch照合」は実際には復旧前/予約直後照合であり、無関係なactive accountを指定すればguardを通過できる。
  - AC-13 の安全性と実環境動作の双方が未証明である。
- 修正案:
  - restore schedulingとpost-restore verificationを別operation/statusにし、新sessionで対象をreadした後に最新Account Homeを再照合する。
  - User Data targetはAccount Homeのcanonical ownershipから解決し、callerが `objectName` と `accountId` の組を自由に作れないようにする。Directoryはshard全体reconcile/checkpointとして扱う。
  - disposable stagingでbookmark → mutation → restore → session restart → authority/reconcile → undoを実施し、結果をprogressへ記録する。

### B-TS2-006 — AC-5 の自動検索lifecycleとquery契約がまだ一部しか検証されていない

- 場所:
  - `.thread/19/plan.md:21-22,140,231`
  - `.thread/19/testing.md:84-105`
  - `spec/testcases/search/maintainSearchIndex.md:7-21`
  - `spec/testcases/search/search.md:5-24`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:49-405`
  - `apps/web/app/testing/lifecycle.integration.worker.ts:29-142`
- 根拠:
  - workerd自動testはmemo update/trash/restore/removeを通すが、documentはcreateのみで、document update/trash/restore/removeを検証しない。topicもarchive/trash/restoreだけでhard deleteと配下projectionを検証しない。
  - 同順位時の `bm25/timestamp/type/id` tie-break、UTF-8の非ASCII 50/51-byte境界、snapshot expiry/capacity、不正cursor shape、UI/AI 2 consumerの同一semanticsは未テストである。
  - local lifecycle Workerにはdocument trash/restore/removeがあるが、runnerはレスポンス成功だけを確認してJSONを表示する。各stepの検索結果をassertせず、document updateもない。
- 影響:
  - AC-5 は memo/document create/update/remove/restore と列挙した検索契約を「自動統合テストとlocal-only CLI」で確認できることを要求しており、未達である。
- 修正案:
  - `maintainSearchIndex.md` / `search.md` の各行に対応するtest名を付け、document全lifecycle、topic hard-delete、順位tie、UTF-8 byte境界、cursor expiry/capを追加する。
  - lifecycle runnerは期待するstep別 hit ID/typeを検証し、不一致ならnon-zeroで終了させる。

### B-TS2-007 — traceability audit はMarkdownの形だけを検査し、虚偽の `automated` evidenceをすべて通す

- 場所:
  - `scripts/audit-test-traceability.mjs:3-39`
  - `spec/inventory/test.md:17-21,27-37,43-48,54-57`
- 根拠:
  - auditが検査するのはTEST IDの重複、status文字列、evidenceセルが空/TODOでないことだけである。
  - evidenceに書かれたfileが存在するか、test名が存在するか、そのtestがCI configにincludeされるか、testcase/ACへ一対一で対応するかを検査しない。
  - そのため B-TS2-002/004/006 の未実装契約を `automated` と記載した現在のinventoryでも、ローカルでは `test traceability audit passed (34 unique TEST IDs)` になる。
- 影響:
  - 台帳の目的である未実装検出が働かず、CIのgreenが受け入れ条件coverageを意味しない。
- 修正案:
  - evidenceを機械可読な `file#test-name` またはtest内 `TEST-*` tagへし、実在・一意性・実行suite includeを検査する。
  - AC→TEST→実test/manual resultの対応表を追加し、`automated` は実test参照必須、`release gate` は結果記録必須にする。

### B-TS2-008 — legacy auditが残存互換APIを見逃し、workerd spike自身がそのlegacy経路を使っている

- 場所:
  - `.thread/19/plan.md:50,167-176,197-200`
  - `packages/core/src/application/search/contracts.ts:115-232`
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:213-251`
  - `.thread/19/spike/fts5.integration.test.ts:18-50`
  - `scripts/audit-legacy.mjs:72-87`
- 根拠:
  - 計画は「互換レイヤーを残さず単一構成へ置換」とするが、production contractに `LegacySemanticCommand`、`LegacySearchQuery/Result/Page` が残り、adapterにも旧offset APIの変換実装がある。
  - workerd先行spikeはtyped command/queryではなく `upsert-content` と `{ text, offset }` のlegacy APIを使う。
  - legacy auditの禁止語regexはこれらの型名・command名・旧query shapeを対象にせず、ローカルで `legacy audit passed` になる。
- 影響:
  - legacy撤去をgreen判定しながら、実装・テスト経路が二重契約のまま残る。RPC version/validation回避の回帰も温存される。
- 修正案:
  - legacy search DTO/command/adapter methodを削除し、spikeをversioned typed `SemanticCommand` / `SearchQuery` へ移す。
  - auditへ旧symbol/command名とunversioned shapeを追加する。

## Warnings

### W-TS2-001 — migration testはmigration関数を手動実行し、lazy invocationと再起動を確認しない

- 場所:
  - `apps/web/app/testing/__tests__/migrations.integration.test.ts:63-118`
  - `spec/inventory/test.md:28`
- 理由: atomic rollback、再実行、newer version拒否は実SQLiteで改善されたが、testはDO instance生成時のmigrationを観測せず、`runInDurableObject` 内から `migrate*` を直接2回呼ぶ。旧version fixtureからRPCを受けて自動upgradeすることやeviction後再起動を検証しない。
- 提案: 各classに旧schema/version fixtureを作り、通常RPCでlazy migrationが起動するtestとeviction/restart testを追加する。

### W-TS2-002 — lifecycle CLI はCIで実行されず、`automated + manual` の自動部分が退行し得る

- 場所:
  - `package.json:28`
  - `.github/workflows/ci.yml:13-93`
  - `spec/inventory/test.md:63`
- 理由: `pnpm test:lifecycle:cli` はどのCI jobにも含まれない。本番artifact非包含auditは走る設計だが、CLIが起動してstate auxiliary Workerへ接続できることは継続検証されない。
- 提案: 専用CI stepへ追加し、B-TS2-006の期待値assertも含める。

### W-TS2-003 — search inventoryのevidence粒度が粗く、仕様行と実testの差分が見えない

- 場所:
  - `spec/inventory/test.md:10-11,30-37`
  - `spec/testcases/search/search.md:5-24`
  - `spec/testcases/search/maintainSearchIndex.md:7-21`
- 理由: 1つのintegration fileを多数のTEST IDへ重複して示すだけで、どの `it` がどの仕様行を満たすか分からない。たとえばASCII 50文字のtestだけで「UTF-8 50-byte境界」を完了扱いしている。
- 提案: testcase行にcase IDを付け、各 `it` へcase IDを記載する。境界値は日本語/結合文字を含むbyte長で表明する。

### W-TS2-004 — request secret isolation testはstate Worker側の「不在」を実行時にassertしない

- 場所:
  - `apps/web/app/testing/request.integration.worker.ts:167-200`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:22-45`
  - `.thread/19/testing.md:139-149`
- 理由: testはrequest Workerのsecretが存在することだけを返し、state auxiliary Workerに同secretが注入されていないことを状態側から確認しない。dry-run outputも自動assertしていない。
- 提案: state test RPCから許可binding名だけを返す専用contractを設けるか、generated dry-run metadataを解析してrequest-only secret名がないことをassertする。

### W-TS2-005 — `TEST-PRES-004` は型宣言とtypecheckだけで runtime routing contractを検証済みとしている

- 場所:
  - `spec/inventory/test.md:57`
  - `packages/core/src/application/identity/contracts.ts:385-389`
- 理由: REST/MCP共通routerはinterface宣言のみで実装・consumer・contract testがない。将来拡張の型を置くことと、現在のcanonical routingを検証することは別である。
- 提案: statusをdesign-only/pendingへ変更するか、実compositionで共有routerを実装してruntime testを追加する。

### W-TS2-006 — `.thread/19/testing.md` は計画のままで、実施結果へのリンクがない

- 場所:
  - `.thread/19/testing.md:21-33,59-189`
  - `.thread/19/progress.md:3-17`
- 理由: 各節は「確認する」と書かれているが、どのコマンドをいつ誰が実行し、どのcaseがPASS/未実施だったかを示さない。PITRだけはprogressに未実施とあるものの、ほかのmanual account/search/dev smokeの結果記録がない。
- 提案: testing planとexecution reportを分離し、commit SHA、command、result、manual evidence、未実施理由を記録する。

## Notes

### N-TS2-001 — 最新の実行状況

- GitHub PR #33:
  - `Cloudflare integration tests`: PASS
  - `Lint / Format / Typecheck / Unit tests`: PASS
  - `Cloudflare build and configuration audit`: FAIL（Pulumi authentication）
- ローカル:
  - `pnpm audit:test-traceability`: PASS（34 IDs。ただしB-TS2-007の構造的false positiveあり）
  - `pnpm audit:legacy`: PASS（265 active files。ただしB-TS2-008のfalse negativeあり）

### N-TS2-002 — 第1回から実質的に改善したcoverage

- request main → `script_name` → state auxiliary Worker の境界
- signup/login/current/logout のDO-backed happy path
- 3 class migrationのordered/idempotent/atomic/newer-version拒否
- memo lifecycle、NFKC snippet、special chars、stable snapshot cursor
- job storeのdigest、lease reclaim、owner CAS、poison、retention
- Account Home restore拒否、local-only lifecycle production非包含audit

これらは有効な追加である。ただし上記Blockerの未到達条件を代替するものではない。
