# PR #33 第3回レビュー — Search / Data / Jobs

## 判定

**BLOCKED**

対象: `main...502776e5a797fd042636164314755f1f5aa137d4`

検索の100 binding対策、snapshot quota、typed DTO、topic/source join、job storeのlease/CASは改善されている。一方、User Data schemaが現行domainの状態を保存できないこと、restore/revision semantics、trashとjobのatomicity、Alarmの障害復旧、1 query/jobあたりの実データ量上限に未解決の問題がある。

## Blockers

### B-SDJ3-001 — User Data schema が現行 domain の永続状態を表現できない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/schema.ts:5-78`
  - `spec/database/index.md:51-143`
  - `spec/domains/memo.md:41-71,191-207`
  - `spec/domains/knowledge.md:134-184,229-273`
- 根拠:
  - `profile` にversionがなく、`settings.trash_retention_days` に `>= 1` CHECKがない。
  - `ai_client_connections` はspecの `client_name/status/last_used_at/version` ではなく `client_id/label/scopes_json` を持ち、同じ認可事実を復元できない。
  - `topics` はdescriptionとversionを持たない。
  - memo/document共用の `content` はaggregate versionとlatest revisionを持たない。
  - `content_revisions` はactorを持たず、document revisionの必須change reasonも保存できない。
- 影響:
  - AC-4の「設定、AI client connection、メモ、文書、トピック、履歴を保持できるschema」を満たさない。
  - 後続IssueのOCC、履歴の「誰が・いつ・なぜ」、同一内容のno-op、topic/memo/documentのdomain reconstructionをこのschema上では実装できず、再migrationが必要になる。
- 修正案:
  - `spec/database/index.md` の現行modelを基準に、Profile/Settings/AI connection/topic/contentへversionと必要な事実列を追加する。
  - memo/document revisionにはactorを、document revisionにはchange reasonを保存し、親のlatest revisionと最大revisionが一致する制約/contract testを追加する。
  - 共用content tableを維持するなら、kind別の必須列・状態不変条件をschema CHECKとadapter reconstructionで保証する。

### B-SDJ3-002 — semantic lifecycle が restore と revision の domain semantics を破っている

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:196-240`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:243-325`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:614-637,783-803`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:133-171,686-715`
- 根拠:
  - memo/documentのupdateは現在値との比較をせず、同一内容でも必ずrevisionを追加する。
  - restore commandは現在の保存内容を復元するのではなく、callerが渡したbody/title/topic/sourceへ書き換え、さらにrevisionを追加する。domainのrestoreは状態遷移だけで、編集やrevision追加ではない。
  - memo bodyの非空・10,000 code point、document titleのtrim後非空/改行禁止/200文字を検証せず、byte上限だけを見る。統合テストも空titleのdocumentを正当データとして作成している。
  - 既存testはmemo restoreでrevisionが3件になることを明示的に期待し、誤った履歴規則を固定している。
- 影響:
  - 「同一内容ではrevisionを積まない」「restoreは履歴を改変しない」「document titleは非空」というdomain invariantに反する。
  - ゴミ箱内データをrestore RPCだけで編集・topic移動・source差し替えでき、履歴上は誰が/なぜ変更したかも残らない。
- 修正案:
  - semantic commandをdomain/applicationのprepared resultから構築し、create/edit/restoreを別の状態遷移として扱う。
  - restore inputは対象IDと確定時刻を基本とし、保存済み本文/タイトル/sourceを維持する。topic消失時だけ、specのrestore planで確定した移動先を明示する。
  - updateは現在内容と比較し、同一なら本体・revision・projectionをno-opにする。domain VOと同じ入力制約、actor/change reason、revision contract testを追加する。

### B-SDJ3-003 — trash状態とretention jobが別transactionで確定し、期限切れ削除を失い得る

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:69-117,327-355,407-460`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:215-228,456-488`
  - `packages/core/src/adapters/cloudflare/user-data/jobs.ts:28-112`
- 根拠:
  - semantic transactionはcontent/trash/topic/FTS/idempotencyをcommitして終了する。
  - その後に `scheduleRetention` が別の `DurableJobStore.enqueue` transactionでjobを作る。
  - semantic commit成功後、job enqueue前の例外・eviction・容量超過では、soft-delete済みだがpurge jobのない状態が永続化する。次の通常input gateは既存jobのalarmを再設定するだけで、trash tableから欠落jobを再構築しない。
  - 同じsemantic commandをcallerが再送すれば回復するが、RPC応答喪失後の再送を期限削除の唯一の復旧手段にはできない。
- 影響:
  - AC-8/AC-12と計画の「job mutationをtransactionSyncで確定し、commit後はsetAlarmだけ」に反する。
  - 利用者が復元も認識もしないまま、ゴミ箱データが保持期限を超えて残り続ける。
- 修正案:
  - trash/topic状態、purge期限、retention job、semantic idempotencyを同じ `transactionSync` で保存し、その戻り値として最早 `nextRunAt` を返す。
  - transaction commit後にだけ `await setAlarm` する。
  - content/trashだけ成功、job insert失敗、setAlarm失敗のfault testを分け、job欠落が発生しないことと次inputでalarmだけが回復することを確認する。

### B-SDJ3-004 — retention変更とleased jobの組み合わせで、将来のpurgeが永久に失われる

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:283-309`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:491-563`
  - `packages/core/src/adapters/cloudflare/user-data/jobs.ts:135-159`
- 根拠:
  - retention変更はtrash/topicの `purge_after` を全件更新する一方、jobの `next_run_at` は `status = 'pending'` の行しか更新しない。
  - claim後のcrashでjobがleasedのまま残っている間にretentionを延長すると、jobの `next_run_at` は旧期限のままになる。
  - lease expiry後にclaimされるとexecutorは新しい `purge_after` を見て「まだ期限前」としてno-opするが、Alarm側はそのjobをcompletedにする。新期限のpending jobは存在しない。
- 影響:
  - 設定変更とat-least-once crash recoveryが組み合わさるだけで、対象は二度と自動purgeされない。
  - 現testはpending jobの短縮/延長だけで、leased/reclaim中の変更を扱わない。
- 修正案:
  - jobのdue時刻をtrash/topicの `purge_after` と単一の権威にする。
  - leased中に期限が後ろへ動いた場合、reclaim時に新期限のpendingへ戻すか、executorの「期限前」結果でjobをcompletedにせず新 `nextRunAt` へrescheduleする。
  - claim→evict→retention延長→lease expiry→新期限到来のintegration testを追加する。

### B-SDJ3-005 — Alarm handlerの外側障害は自前再設定されず、platform retry上限後にjobが停止する

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:409-440,566-574`
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:230-265`
- 根拠:
  - 個別jobの `executeJob` 失敗はcatchされるが、`store.claim`、`store.complete`、`retryOrPoison`、最後の `ensureAlarm` / `setAlarm` 失敗を扱うouter `try/finally` がない。
  - これらがthrowするとhandlerはDB最早時刻から次Alarmを自前設定しない。Cloudflareの自動retryを使い切った後は、別RPCでinput gateが動くまでjobが停止する。
  - testは「unsupported job」という正常にcatchされるjob failureだけで、storage/alarm API失敗やplatform retry上限後の再設定を検証していない。
- 影響:
  - AC-12の「最大自動retry後の自前再設定」を満たさず、外部I/O/retentionのat-least-once保証がinput trafficに依存する。
- 修正案:
  - handler全体のfailure pathでも、永続job状態を確認して次wake-upを保証する設計にする。少なくともclaim済みjobのlease expiryとpending最早時刻をcommit後に再設定する。
  - claim/complete/setAlarmを個別にfaultさせ、evictionと再起動を挟んでもAlarmが残るworkerd testを追加する。

### B-SDJ3-006 — 1 topic job/commandの処理量が無制限で、batch/time budgetが機能しない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:427-487,503-526`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:414-438,520-545`
- 根拠:
  - topic trash/restore/removeは配下document全件を `toArray()` し、各documentのFTS projectionを同期loopで更新する。
  - Alarmは「最大25 jobs / 10秒」を確認するが、1件のpurge-topic jobが全配下documentを読み、FTS remove、deleteまで一括実行するため、1 job自体には件数・時間上限がない。
  - 大きいtopicではCPU上限で毎回同じtransactionがrollbackし、5回後にpoison化して期限切れtopicを残す。
- 影響:
  - 計画が要求するbounded batch/time budgetと、Cloudflare 30秒CPU guardを満たさない。
  - 通常のtopic trashも同じ理由で利用不能になり得る。
- 修正案:
  - topic配下件数に入口上限を設けるか、永続cursor付きのbounded set transition/purgeへ分割する。
  - 1 batchのSQL parameter、document数、CPU deadlineを明示し、途中再起動から同じcursorで継続する。
  - 上限直前/直後と、途中eviction後の再開をworkerd testに追加する。

### B-SDJ3-007 — 検索はquota判定前に最大5,001件の全文をmaterializeし、DOのmemory/CPU上限を超え得る

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:23-32,278-304`
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:351-409`
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:411-481`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:22-25,793-803`
- 根拠:
  - FTS queryは最大5,001行についてtitle/body全文を `toArray()` する。bodyは1件あたり最大1 MiBを許容するため、理論上数GiBをJS heapへ読み込む。
  - その後、全件のsnippet/source DTOを作ってからsnapshot byte quotaを計算する。4 MiB quotaはDB書込量だけを制限し、quota判定までのheap/CPUを制限しない。
  - first pageが20件でも、cursor用に最大5,000件を毎回全DTO化し、source queryも50件ごとの複数roundで全件実行する。
  - 現limit testは100件の小さなmemoだけで、large body・5,000 hit・CPU/memory rejectionを確認しない。
- 影響:
  - 正当な検索入力だけでUser Data DOがCPU/memory上限に達し、同じobjectの他操作も一時的に利用不能になる。
  - `QueryTooComplex` / snapshot quotaへ到達する前にplatform failureとなり、typed error contractも守れない。
- 修正案:
  - SQLでranked ID/score/必要なsnippet範囲だけを先に取得し、全文を全件materializeしない。
  - cursor snapshotにはcompactな順序factを保存し、表示DTOの構築はcurrent pageだけに限定するか、SQL側で累積byte上限を早期判定する。
  - 1 MiB bodyを含む複数hit、5,000/5,001件、snapshot byte上限をworkerd上で検証し、platform failure前にtyped rejectionする。

### B-SDJ3-008 — atomicity・restart・UI/AI共通契約の受け入れテスト証拠が不足している

- 場所:
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:421-475`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:645-774`
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:81-153,210-265`
  - `.thread/19/plan.md:226-235`
- 根拠:
  - 「main rollback」testはsource存在検証で本体write前に失敗するだけで、本体write後のFTS projection失敗やidempotency保存失敗を注入していない。
  - search limit testはsmall payload 100件で、5,000件、byte quota、large content、QueryTooComplexを検証しない。
  - job testはstore-level lease reclaimとhandler内job failureを確認するが、claim後restart、storage途中失敗、setAlarm失敗、最大platform retry後のself-reschedule、1 jobのtime budgetを確認しない。
  - 人間UI/AIのconsumerが同じ `SearchIndexPort.query` semanticsを利用するarchitecture/contract testがない。
- 影響:
  - AC-5/AC-12が要求する「本体/FTS双方のrollback」「UI/AI同一検索」「再起動・途中失敗・最大retry・batch/time budget」の合格証拠にならない。
- 修正案:
  - main write後、projection中、idempotency insert時の各faultを注入し、全tableがrollbackすることを確認する。
  - Alarmの永続phaseごとのeviction/fault、large search/topic job境界、UI/AI adapterの同一query contractを追加する。

## Warnings

### W-SDJ3-001 — cursorとpageの併用、および巨大pageが曖昧なまま受理される

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:247-276,284-287`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:677-697`
- 影響:
  - cursor指定時のpageは検証後に無視され、cursor offsetから計算したpageを返す。callerの指定と応答metadataが一致しない。
  - page自体に上限がなく、safe integer同士でも `(page - 1) * limit` がsafe integerを超え得る。
- 修正案:
  - cursorとpageを相互排他にし、offset計算後のsafe integerと最大探索範囲を検証する。

### W-SDJ3-002 — source listのset semanticsとidempotency digestが一致しない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:58-61,594-611,759-780`
- 影響:
  - 永続化はsource IDをdedupe/sortする一方、上限判定とpayload digestは入力配列の順序・重複をそのまま使う。
  - 同じsource集合の順序違いが異payload conflictになり、同一IDの重複だけで100件上限を超える。
- 修正案:
  - application boundaryでsource集合をdedupe/sortしてからvalidation・digest・writeに共通利用する。

### W-SDJ3-003 — source存在確認が最大100回のpoint queryになっている

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:759-780`
- 影響:
  - 1 document writeで最大100 SQL queryを同期実行し、その後さらに100件を個別INSERTするため、CPU budgetを不必要に消費する。
- 修正案:
  - 100 binding上限内の一括SELECTで存在/kind/activeを検証し、不足IDを集合差分で判定する。insertも安全なbatchにする。

### W-SDJ3-004 — settings系のSQLITE_FULLがstructured errorへ変換されない

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:243-321,699-759`
- 影響:
  - `updateTrashRetention` のdirect SQLはsearch/semantic/job adapterのerror translatorを通らず、SQLITE_FULL等は `rpc()` が認識しないunknown errorとしてDO exceptionになる。
- 修正案:
  - User Data persistence操作を共通adapter error boundaryで囲み、SQLITE_FULLをnon-retryable `StorageCapacityExceeded`、その他SQLiteをtyped database errorへ統一する。

### W-SDJ3-005 — idempotency recordsにretention/quotaがなく単調増加する

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/schema.ts:112-120`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:73-115`
- 影響:
  - semantic operationごとに本文digest/result rowが永久に残り、長寿命userでは容量を継続消費する。snapshot/jobにはquota/pruneがあるがidempotencyにはない。
- 修正案:
  - operation再送期間に基づくretention、namespace別quota、またはcontent lifecycleに連動した安全なcompaction policyを定義し、Alarmでbounded pruneする。

### W-SDJ3-006 — searchの短語/unknown-topic規則がplanとspecで一致していない

- 場所:
  - `.thread/19/plan.md:93`
  - `spec/domains/search.md:98-106`
  - `spec/usecases/search.md:65-75`
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:336-355`
- 影響:
  - planはunknown topicを空結果、usecase/実装はNotFoundとする。
  - domain specは1〜2 UTF-8 byteをfallbackと書く一方、plan/実装/testは1〜2 Unicode文字をfallbackにする。日本語1文字は3 byteなので、どちらが正かで検索経路が変わる。
- 修正案:
  - UX上の正しい結果を1つ決め、plan/domain/usecase/testを同じ「byte」または「文字」規則とunknown-topic結果へ同期する。

## Notes

### N-SDJ3-001 — Cloudflare 100 binding上限へのbatch修正は妥当

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:28-32,315-331,418-438`
- 評価:
  - snapshot insertを33件、source joinを50 IDへ分割し、各SQLを最大99/100 bindingに抑えている。100 hitのworkerd testも追加されている。

### N-SDJ3-002 — search resultとsource/topic lifecycleの基本整合性は改善されている

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:351-481`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:407-527`
- 評価:
  - ranking tie-break、NFKC、original-text highlight、typed memo/document DTO、active source link、archived topic、topic source memo、set-deleted documentの除外は一貫したqueryで扱われている。

### N-SDJ3-003 — job storeの永続lease/CAS/idempotency基盤は良い

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/jobs.ts:28-299`
- 評価:
  - expired lease reclaim、owner token CAS、attempt、retry/poison、provider idempotency conflict、terminal retention時刻を永続化し、due/reclaim indexも用意している。残課題はstoreより上のatomic schedulingとAlarm failure lifecycleにある。

## 検証

- `main...HEAD` のsearch/user-data/jobs/schema/test差分を、Issue #19、`.thread/19/plan.md`、`spec/domains/{search,memo,knowledge,trash}.md`、`spec/usecases/{search,trash}.md`、`spec/database/index.md` と照合した。
- `pnpm exec vitest run --config vitest.config.integration-state.ts apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts`
  - 2 files / 17 tests PASS
  - PASSは現testの範囲を示すもので、B-SDJ3-003〜008のfault/large-data/restart境界は未検証。
