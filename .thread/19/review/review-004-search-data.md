# PR #33 第4回レビュー — Search / Data / Jobs + Application Capability

## 判定

**BLOCKED**

対象: `main...e2ec1ace9c15b281a120ee577a56c23ec4d0936e`

Issue #19、`spec/`、`.thread/19/plan.md`、受け入れ基準と現行差分をゼロベースで照合した。第3回後に trash と retention job の同一 transaction 化、leased job の retention 再計算、topic purge の bounded chunk、検索候補の事前 byte budget、local-only command class は改善されている。

一方、application の semantic capability は依然として raw RPC DTO を adapter へ渡すだけで、契約に記載された repository/projection callback として機能していない。OCC、topic set の version、親 topic 消失後の document restore、履歴 provenance、AI connection schema にも現行 spec と両立しない状態が残る。追加されたテストの一部は同じ経路を2回呼ぶだけ、または write 前に失敗するだけで、AC-5/AC-12 の証拠として false positive である。

## Blockers

### B-SDJ4-001 — `SemanticCommitPort` の transaction capability が装飾的で、async prepare / domain 判定を経ない raw storage commandになっている

- 場所:
  - `packages/core/src/application/search/contracts.ts:230-247`
  - `apps/web/app/testing/LocalUserDataDurableObject.ts:37-47`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:90-143,187-301,634-636`
  - `.thread/19/plan.md:62-76,128-140`
- 根拠:
  - `SemanticCommand` は `SemanticRpcCommand` から `version` だけを `Omit` した型であり、domain entity/value object/usecase の結果ではない。Local DO も transport validation 後にversionを除いてcastするだけである。
  - `SemanticCommitPort.transactionSync` のcallbackはoptionalで、repository capabilityとして渡す値も `{ storage: "user-data" }` というmarkerだけである。
  - adapterはcallbackより先に `this.execute(command)` で本体を書き、`execute()` 内から直接 `this.projection().upsert/remove` を呼ぶ。callbackへ渡した `SearchProjectionPort` が本体repositoryと同期commitするという契約ではない。
  - その結果、application prepareでdomain ruleを確定する層がなく、adapterがraw string/numberを独自に検証・永続化している。
- 影響:
  - AC-5が要求する「`SemanticCommitPort` だけへ渡す transaction-scoped `SearchProjectionPort`」と、計画の async prepare → typed command → repository/projection callback 境界を満たさない。
  - 後続の本番memo/document usecaseはこのportへdomain結果を渡せず、test harness専用DTOとadapter手続きへ依存する。callbackを利用しても本体変更は既に終わっており、projection capability confinementの型上の証明にもならない。
- 修正案:
  - transport decoder、application usecaseのasync prepare、domainで検証済みのprepared commandを別型にする。
  - `transactionSync` callbackを必須にし、実repository群とtransaction-scoped projectionをそのcallback内だけへ渡す。本体saveとprojection更新をcallbackの1つのsemantic operationとして実行し、adapter内部から別のprojection instanceを生成しない。
  - application testでraw RPC DTOがportへ直接到達しないこと、callback外でprojectionを取得できないことを固定する。

### B-SDJ4-002 — OCCが任意指定で、topic set削除・復元は配下documentのversionを進めない

- 場所:
  - `packages/core/src/application/search/contracts.ts:141-227`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:198-299,512-594,758-785`
  - `apps/web/app/testing/localSemanticValidation.ts:91-98,130-193`
  - `spec/domains/knowledge.md:184-186,225-227,307-348`
- 根拠:
  - create以外の全mutationで `expectedVersion` がoptionalであり、`assertExpectedVersion` / `assertTopicExpectedVersion` は未指定なら無条件にreturnする。したがってcallerはOCCを省略してstale update/delete/restoreを成功させられる。
  - topic set trash/restoreは配下documentの `trashed_with_topic_id` と `updated_at` だけを変更し、`version` をincrementしない。domainでは各documentの `softDelete` / `restore` がいずれも `version + 1` である。
  - 永続versionも新規作成時に1から始まり、spec/schemaの生成時0と異なる。
- 影響:
  - topic trash → restoreをまたいだ古いeditorが、遷移前のversionのままdocumentを更新できる。状態遷移を含むaggregateのOCC tokenとして機能せず、後続UIの競合警告と履歴保全を壊す。
  - expectedVersionを付けない経路では通常の同時編集もlast-write-winsになり、domainが定める `OPTIMISTIC_LOCK_FAILURE` を保証しない。
- 修正案:
  - create以外のmutationはprepared commandでexpected versionを必須にし、`UPDATE ... WHERE version = ?` のrowsWrittenでCASする。生成時versionはspecどおり0へ統一する。
  - topic set trash/restoreでは対象documentごとにversionを進め、topic/document全件の期待versionを同一transactionで検証する。topic trash/restore前のstale tokenが後続更新を拒否されるtestを追加する。

### B-SDJ4-003 — 親topicをhard deleteした個別trash documentを復元する手段がなく、データが永久にゴミ箱へ取り残される

- 場所:
  - `packages/core/src/application/search/contracts.ts:184-190`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:445-464,596-632,673-677`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:567-607`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:319-348`
  - `spec/domains/knowledge.md:225-227,351-355,576-577`
- 根拠:
  - topic hard deleteとretention purgeは、個別にtrash済みのdocumentを残して `topic_id = NULL` にする。
  - `restore-document` commandには復元先topicまたはrestore planがなく、`restoreContent()` はそのままactiveへ戻した後にprojectionを読む。`topic_id = NULL` なら `TopicRequired` がthrowされtransaction全体がrollbackする。
  - integration testはtopic削除後に個別trash documentの `topic_id` がnullで残ることだけを期待し、その後の復元を確認しない。
  - 現行spec/ADR-001は、元topicがhard delete済みなら既存または新規の復元先を選び、`moveToTopic` 後にrestoreすると定める。
- 影響:
  - 自動retentionまたは人間のtopic hard delete後、そのtopic配下で先に個別削除されていたdocumentは、本文と履歴が残っていても公開command harnessから二度と復元できない。「AIが削除しても人間が復元できる」という信頼モデルを破る。
- 修正案:
  - applicationで所属topicの live/trashed/missing を判定するrestore planを実装し、missing時はvalidated destination topicをprepared commandに含める。
  - destinationへのmoveとrestore、version更新、projection upsertを同一transactionにする。手動topic hard deleteとAlarm purgeの双方で、個別trash documentを別topicへ復元できる統合testを追加する。

### B-SDJ4-004 — User Data v2 schemaは現行AI connectionと履歴provenanceを完全には表現できない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/schema.ts:18-25,142-160,189-202`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:724-755`
  - `apps/web/app/testing/__tests__/migrations.integration.test.ts:122-183`
  - `spec/database/index.md:74-86,88-143`
  - `spec/domains/identity.md:73-98`
  - `spec/domains/knowledge.md:231-248,267-273`
- 根拠:
  - v2 migrationはAI connectionへ新列を追加するだけで、v1の `client_id` / `label` / `scopes_json` / `created_at` の `NOT NULL` 制約を残す。現行 `AiClientConnection` の `id/clientName/status/connectedAt/lastUsedAt/revokedAt/version` を保存するだけではINSERTできず、廃止済み列へ架空値を作る必要がある。
  - revisionは `actor_id` しか持たず、必須のactor kindとAI client name snapshotを保存できない。人間とAIの履歴を再構築する情報が失われる。
  - versionのdefaultもspecの0ではなく1で、settingsの `>= 1` はUPDATE triggerだけのためinvalid INSERTをschema自体では拒否しない。
  - migration fixtureはprofile/contentだけをseedし、v1 AI connectionの移行と現行shapeでのinsert/revoke/readbackを検査しない。
- 影響:
  - AC-4が要求するAI connectionとmemo/document historyの保存schemaが未完成で、#11/#12/#15は再度table rebuildと履歴契約の変更を必要とする。
  - AI編集履歴をclient name付きで表示するspecを満たせず、既存v1 rowと新規rowで書込契約も分裂する。
- 修正案:
  - forward-onlyの次migrationでtable rebuildを行い、現行schemaだけを持つAI connection tableへcopy/canonicalizeする。
  - revisionへ `actor_kind`、`actor_id`、AI時の `actor_client_name` snapshotを追加し、状態別CHECKを設ける。version初期値とsettings CHECKも正本へ合わせる。
  - legacy AI rowのupgrade、現行AI rowのinsert/revoke、human/AI双方のrevision round-tripをmigration/integration testへ追加する。

### B-SDJ4-005 — AC-5/AC-12の追加テストが実際の境界・faultを通らず、greenでも受け入れ条件を証明しない

- 場所:
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:434-523,1102-1125`
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:228-261`
  - `.thread/19/plan.md:21,28,128-146,231-232`
- 根拠:
  - 「main rollback」testはsource存在確認で本体INSERT前に失敗するだけで、本体write後のprojection失敗もprojection write途中のrollbackも注入しない。
  - 「UI and AI consumers」testは同じ `stub.search(capabilityInput)` を変数名だけ変えて2回呼び、UI/AIのpresentation/application adapterを1つも通らない。同じ関数の決定性を確認しているだけで、共通 `SearchIndexPort` 配線の証拠ではない。
  - Alarm retry testは各attempt後にtestがSQLで `next_run_at` を過去へ書き換え、最初の1回以外はeviction/restartを挟まない。自動backoff、再設定、platform retry上限後の自前wake-upを実証していない。
- 影響:
  - application capabilityがB-SDJ4-001の形でも、projection rollbackが壊れても、Alarmが自力で次回実行へ進めなくてもtest suiteはgreenになる。
  - AC-5/AC-12を完了扱いするrelease evidenceとして利用できない。
- 修正案:
  - main row保存後、FTS delete後、FTS insert前後、idempotency保存時を個別にfaultさせ、全tableのrollbackを確認する。
  - UI用とAI用の実consumer adapterを別々に構築し、同じapplication `SearchIndexPort`へ到達することと同一結果をcontract testにする。
  - testによるdue時刻改変をやめ、fake clock/Alarm API faultを使ってbackoff、自動再設定、attempt間eviction、claim/complete/setAlarm失敗を検証する。

## Warnings

### W-SDJ4-001 — 保存済みjob payloadのJSON破損1件でclaim transaction全体がrollbackし、queueが永久に進まない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/jobs.ts:143-202`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:488-527`
- 理由:
  - `claim()` はdue行をleasedへ更新した後に `JSON.parse` し、parse失敗をthrowする。同じtransactionがrollbackするためattempt増加もpoison化も残らず、最古の破損行を次Alarmで再びclaimする。
  - `claim()` はhandler内のjob単位try/catchより外側なので、後続の正当なdue jobまで毎回処理されない。
- 提案:
  - parse/digest検証に失敗した行を同じtransactionでpoisonへ隔離して次行へ進む。破損行の後ろに正常jobを置き、正常jobが完了し破損行だけterminalになるfault testを追加する。

### W-SDJ4-002 — raw command validatorが現行domainの文字数・一行制約と一致しない

- 場所:
  - `apps/web/app/testing/localSemanticValidation.ts:63-73,91-98,119-128`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:472-495,991-1044`
  - `spec/domains/knowledge.md:48-58,74-85`
- 理由:
  - topic nameはbyte長1024以下だけで、trim後非空、改行禁止、100 code point上限を実施しない。
  - change reasonは最大1024 byteとtrim後非空だけで、改行禁止・200 code point上限を実施しない。
  - document bodyはspecの1,000,000 code pointではなく1 MiB byteで拒否するため、多byte文字の正当な本文を大幅に早く拒否する。
- 提案:
  - B-SDJ4-001のapplication prepareでdomain value objectを必ず構築し、adapter独自定数を正本にしない。日本語を含む境界値、改行、空白だけのtopic/reasonをcontract testへ追加する。

### W-SDJ4-003 — semantic idempotencyの90日pruneがserver clockではなくcaller提供timestampに依存する

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:39-65,130-141,169-184`
  - `apps/web/app/testing/localSemanticValidation.ts:24-30`
- 理由:
  - `completed_at` とprune基準がcommand内の `timestamp/trashedAt/restoredAt/...` で、validatorは遠い未来のsafe timestampも受理する。
  - 未来日時のcommandが1件入ると、それ以前のidempotency rowを90日超過として一括削除でき、古いoperation IDを異payloadで再利用可能になる。
- 提案:
  - semantic event時刻とidempotency retention clockを分離し、DO側のtrusted clockを `completed_at` / pruneへ使う。future/backdated business timestampでもreplay contractが維持されるtestを追加する。

## Notes

### N-SDJ4-001 — 第3回から実質的に改善した点

- trash/content/projection/idempotencyとretention job enqueueは同じ同期transactionへ入った。
- retention変更はpendingだけでなくleased jobも更新し、executorは新期限ならdeferする。
- topic semantic commandは100件guard、Alarm purgeは50件chunkになった。
- 検索は全文materialize前に件数/byte budgetを確認し、cursor/page排他、snapshot quota、source batch、NFKC/literal短語を実装した。
- raw semantic commitはproduction classからlocal-only subclassへ分離された。

これらは有効な修正であり、第3回の同名指摘をそのまま再掲してはいない。

### N-SDJ4-002 — レビュー時の検証結果

- `pnpm vitest run --config vitest.config.integration-state.ts apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts apps/web/app/testing/__tests__/migrations.integration.test.ts`
  - 3 files / 29 tests: pass
- greenであってもB-SDJ4-005のfault/consumer境界を通らないため、上記Blockerの反証にはならない。
- 実装コードの変更、commit、pushは行っていない。
