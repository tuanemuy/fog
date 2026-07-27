# Review 001 — Tests / Spec / Acceptance Coverage

Status: **CHANGES REQUIRED**

対象: PR #33、Issue #19、`.thread/19/{plan,testing,progress}.md`、unit/workerd tests、`spec/{inventory,testcases,manual-tests}/`、package scripts、CI、Issue #10。

## Blockers

### B-TS-001 — CI が削除済み runtime の存在を前提にし、必須チェックが4件失敗している

- 場所: `.github/workflows/ci.yml:45-95`、`package.json:10-34`
- 理由: integration matrix は `node`、build matrix は `node/aws/gcp` を実行するが、対応する `test:integration:node` と `build:{node,aws,gcp}` script は削除済みである。PR #33 の実ログでも4 jobすべてが `Command ... not found` で失敗している。AC-9 の旧 runtime 撤去後の CI が同期されておらず、AC-16 の品質ゲートを満たせない。
- 提案: CI を Cloudflare 単独へ更新し、root の既定 `pnpm test:integration` / `pnpm build` を実行する。必要なら dry deploy を別 job にし、削除済み runtime 名が workflow/package scripts に戻らない legacy audit を追加する。

### B-TS-002 — workerd suite が request Worker → state Worker 境界を通らず、公開 identity 回帰と routing 制約を検証していない

- 場所: `vitest.config.integration.ts:8-36`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:34-72`、`spec/inventory/test.md:23-37,50-57`、`.thread/19/testing.md:57-68,135-144`
- 理由: integration config の `main` は `server.state.ts` で、3 DO namespaceを同一 test Workerへ直接登録している。最初のテストも `CloudflareIdentityGateway` を直接構築しており、request Worker、`script_name` binding、生成 env 型、server action、session cookieを経由しない。削除された `serverCloudflare.test.ts` と Cloudflare worker integration testの代替もないため、request/state binding typo、secret境界、公開入力からのDO ID/userId override、signup/login/current-user/logout の実配線が壊れても9件の integration testはgreenになる。TEST-DO-001/003 と TEST-PRES-001〜004、AC-1/10/16を満たす証拠にならない。
- 提案: request entryをmain、state entryをauxiliary Workerにした harnessを用意し、実生成binding経由で signup → logout → login → current-user を通す。公開payload/URLに partition、DO ID、userId overrideがないこと、片側 unavailable と RPC version mismatch が構造化errorになることも境界testへ含める。

### B-TS-003 — 検索の必須 query contract の大半が未テストで、現行suiteは仕様違反をgreenのまま通す

- 場所: `spec/testcases/search/search.md:3-24`、`spec/inventory/test.md:30-33`、`.thread/19/testing.md:91-101`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:74-169`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:64-117`
- 理由: 自動テストが実際に確認するqueryは、日本語3文字1件、短語1件、topic一致1件、trash除外だけである。NFKC、50-byte境界、空入力、特殊文字、unknown topic、source memoのtopic包含、trashed topic、active sourceだけのDTO、memo/document種別DTO、順位tie-break、snippet、0件、pagination/snapshot、UI/AI同一semanticsがない。たとえば実装は空入力をerrorでなく空結果にし、50-byte超過を規定errorでなく`RangeError`にし、offsetを使ってsnapshot識別子を持たないが、suiteは通る。AC-5/6 と TEST-DO-006/007 を検証できていない。
- 提案: `spec/testcases/search/search.md` の各行をworkerd table testへ対応付け、error kind/codeまで表明する。順位・snippet・cursorは複数行fixtureとページ間mutationを使い、topic/source/trashはmemo/document双方のDTOをexact matchで検証する。

### B-TS-004 — semantic lifecycle/transaction/idempotency の削除済みcoverageが必要なDO contractへ移植されていない

- 場所: `spec/testcases/search/maintainSearchIndex.md:5-21`、`spec/inventory/test.md:30-34`、`.thread/19/testing.md:80-89`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:116-169,257-293`
- 理由: lifecycle testはdocumentのcreate → trash → restore → hard removeだけで、memo lifecycle、update時の旧語消滅/新語反映、revision、source link再射影、topic archive/trash/restore、同一operationId再送、異payload conflictを検証しない。rollbackもFTS tableをdropした射影失敗の一方向だけで、本体repository失敗はない。旧D1/libSQLのUoW・idempotency・制約/error integration testsを削除した一方、必要になった同期commit契約の同等coverageが復元されていない。現実装の「同じoperationIdなら異payloadでも成功扱い」や「revision未保存」を検出できず、AC-5を満たさない。
- 提案: memo/documentそれぞれのcreate/update/trash/restore/hard-delete、source/topic波及、main write/FTS write双方のfault injection、同一payload再送/異payload conflict、idempotency rowを含む全rollbackをworkerdで独立test化する。削除した汎用transaction testのうち新構成でも必要なerror translation/constraint coverageも移植する。

### B-TS-005 — Identity contract test が happy path の局所操作に留まり、AC-2/3 の fault/reconcile/rotation を検証していない

- 場所: `spec/inventory/test.md:17-21,39-48`、`spec/testcases/identity/registerWithPassword.md:7-23`、`spec/testcases/identity/registerOrLoginWithSso.md:3-16`、`.thread/19/testing.md:103-122`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:35-72,171-255`
- 理由: signup testはhappy pathと重複emailだけで、reserve後/init後/finalize前後のfault、同じoperation再送、期限切れreservation、reconciler、orphan/二重userを確認しない。SSO testは単一Directory DOのraw `reserve`を呼ぶだけで、HMAC locator、Account Home/User Data、lookup/create primitive、verified email競合、active/previous世代、全bucket rotation checkpointを通らない。resetもtokenのstore/consumeだけでmapping更新やsession epochを検証せず、change/link/unlink/delete state machineのtestはない。Issueが明記するcontract test条件を満たしていない。
- 提案: application portまたはrequest→state境界から各sagaを駆動し、全RPC前後にfault injectionする。保存phaseから同一operationを再開して一つのuser/mappingへ収束すること、SSOの初回/再送/同時初回/email競合/provider境界/rotation、reset/link/unlink/deleteの不変条件を台帳ID単位で追加する。

### B-TS-006 — schema migration と Alarm/job の明示的な受け入れ条件が、各1ケースの表面的確認に縮退している

- 場所: `spec/inventory/test.md:27-37`、`.thread/19/testing.md:124-133,178-184`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:74-114,319-343`
- 理由: migration testはUser Data DOでversion 1が1行あることだけを確認し、3 classの再実行、forward-only、新er version拒否、途中失敗rollbackを確認しない。Alarm testはegress binding不在で1回失敗し`attempt: 1/pending`になったことだけで、at-least-once、lease expiry/reclaim、owner CAS、provider idempotency、成功、poison、最大retry、最早alarm競合、`setAlarm`失敗後input gate、eviction/restartを一切通さない。TEST-DO-002/009/010/011 とAC-11/12の完了判定ができない。
- 提案: 各classをversion状態別に起動するmigration harnessとfaulting migrationを追加する。Job egress auxiliary Workerと制御可能なclock/alarm failureを用意し、claim/lease/CAS/duplicate/success/retry/poison/restart/最早時刻をそれぞれ実storage上で表明する。capacity/error translationもtesting.mdのedge caseとして自動化する。

### B-TS-007 — AC-5 が要求する local-only manual CLI がなく、同名scriptはVitest 1件の別名にすぎない

- 場所: `package.json:23-27`、`spec/inventory/test.md:59-66`、`spec/testcases/search/maintainSearchIndex.md:27-29`、`.thread/19/testing.md:80-89`
- 理由: `pnpm test:lifecycle:cli` は `"commits lifecycle"` を `-t` で選ぶだけで、実行結果も「1 passed / 7 skipped」である。fixtureを対話的または引数でcreate/update/remove/restore/searchできるtest Worker/CLI、操作結果の表示、本番artifact/route非包含の検証は存在しない。testing.mdは「実装されたら」と任意化しているが、planのAC-5とinventoryのTEST-MAN-001は必須としている。
- 提案: local/test専用entryまたはCLIを実装し、全lifecycleと直後searchを実行可能にする。本番buildにbinding/routeが入らないこともtestする。自動testだけを採用するなら、Issue/plan/specの受け入れ基準を正式に改訂してscript名とtesting.mdを一致させる。

## Warnings

### W-TS-001 — testing.md が「legacy allowlist auditを含む」とするが、そのtest/scriptが存在しない

- 場所: `.thread/19/testing.md:157-166`、`package.json:23-27`、`vitest.config.integration.ts:31-36`
- 理由: `pnpm test` はunitと2ファイル・9件のworkerd testを連結するだけで、active source/config/specの旧runtime/D1/Vectorize/embedding/RRF/Outbox禁止を走査しない。実際に今回のCI workflowにnode/aws/gcpが残ったことも検出できていない。
- 提案: 履歴ADR/reviewなどを明示allowlistにしたrepository audit testを追加し、source/config/workflow/package/spec active pathをCIで検査する。

### W-TS-002 — progress.md の「自動検証済み」記録が実suiteと一致せず、staging PITR smokeも未実施である

- 場所: `.thread/19/progress.md:3-12`、`.thread/19/testing.md:146-155`、`packages/core/src/adapters/cloudflare/__tests__/pitrPolicy.test.ts:4-24`
- 理由: progressはlazy migration、export pagination、deletion tombstoneを自動検証済みとするが、workerd suiteにexport paginationはなく、migrationはUser Data version 1の初回だけ、deletionはAccount Homeの局所状態だけでDirectory/User Data連携を通らない。PITR実restoreは未実施で、testing.mdのAC-13手順は未完了である。
- 提案: 記録を実際に通ったtestへ限定し、未検証項目を明示する。staging資格情報が必要なsmokeはPRのrelease gateとして担当者・対象object・結果記録先を決め、完了まではAC-13をPASS扱いにしない。

### W-TS-003 — test inventoryと個別testcaseに実装testへのtraceabilityがなく、67件の必須contractが9件のintegration testへ対応したように見える

- 場所: `spec/inventory/test.md:1-67`、`spec/testcases/**/*.md`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:34-344`
- 理由: inventoryは「active test inventory」と記載するが、実装status、test file/name、未実装理由がない。testing.mdも各節で同じ`pnpm test:integration:cf`を指すため、実行者はどのcontractが未到達か判別できない。
- 提案: 各TEST-*行にautomated test名またはmanual case、statusを紐付ける。未実装は空欄でなく明示し、CIで重複/未参照IDを検査する。

## Notes

### N-TS-001 — 現在存在するローカル品質コマンド自体は成功した

- `pnpm test:unit`: 21 files / 379 tests PASS
- `pnpm test:integration:cf`: 2 files / 9 tests PASS
- `pnpm test:lifecycle:cli`: 1 PASS / 7 skipped
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`: PASS
- PR CIのCloudflare integration/buildもPASS。ただしB-TS-001の4 legacy matrix jobがFAIL。

### N-TS-002 — Issue #10 はIssue #19依存のFTS5単独チェックリストへ同期済み

- 場所: GitHub Issue #10
- 内容: Vectorize/embedding/RRF/Outbox consumerを使わず、User Data DO内FTS5、同期semantic commit、日本語/短語/topic/trash/source DTOを扱うチェックリストに更新されている。

### N-TS-003 — 旧ADRのsuperseded pointerと、active specの非ベクトル方針は確認できた

- 場所: `.issue/1/adr.md:1-5`、`spec/adr/005-search-index-via-outbox.md:1-8`、`spec/domains/search.md:1-4`
- 内容: 旧本文を保持したままIssue #19と現行設計へのpointerがあり、active search specはSQLite FTS5単独・同期projectionを示している。legacy auditを自動化すべき点はW-TS-001のとおり。
