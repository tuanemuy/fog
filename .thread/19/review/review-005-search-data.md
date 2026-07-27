# PR #33 第5回レビュー — Search / Data / Jobs / Application Capability

## 判定

**BLOCKED**

対象: `main...43ecf369de219aecbe5c2a6be33dcbe3d9cd4209`

Issue #19、`.thread/19/plan.md`、現行 `spec/`、受け入れ条件 AC-4/5/6/8/11/12 と現在の実装・テストをゼロベースで照合した。第4回後の expectedVersion 必須化、CAS、topic set 配下 document の version 更新、親 topic 消失後の復元先指定、AI connection table rebuild、revision actor provenance、保存 job payload の poison 化、trusted idempotency clock は有効な改善であり、以下には再掲しない。

一方、application transaction callback は同期性を型でも実行時にも保証せず、渡される repository capability も application が本体と projection を組み立てる境界になっていない。projection 途中失敗テストは capability guard で本体書込前に落ちる false positive のままである。document restore の topic OCC、Alarm の自動 retry/restart 証跡にも現行 spec・受け入れ条件と両立しない残存がある。

## Blockers

### B-SDJ5-001 — transaction callback が async 関数を受理し、commit 後の外部 I/O を型・実行時とも拒否できない

- 場所:
  - `packages/core/src/application/search/contracts.ts:260-267`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:103-127`
  - `spec/domains/search.md:150-161`
  - `spec/testcases/search/maintainSearchIndex.md:20`
- 根拠:
  - callback の戻り値は `void` である。TypeScript では戻り値を捨てる `(...args) => void` に `async (...args) => Promise<void>` を代入できるため、「Promise を型で拒否する」契約にならない。
  - adapter は `callback(repositories, projection)` の戻り値を確認しない。callback が `repositories.apply(...)` の後に `await` する形なら SQLite transaction は先に commit し、その後の RPC・暗号・メール・外部 API が transaction 外で継続する。
  - Promise callback を拒否する compile-time test / runtime contract test もない。
- 影響:
  - AC-5 と plan が要求する「同期 callback だけ」「外部 I/O を transaction に含めない」という境界が破れる。後続 usecase が誤って async callback を渡しても型チェックを通り、意味的 commit と外部副作用が分離する。
- 提案:
  - callback の戻り型を、async 関数が代入できない `undefined` 等の厳密な同期型にする。併せて実行時にも thenable を検出して rollback する。
  - 型テストと runtime contract test の双方で async callback が拒否されることを固定する。

### B-SDJ5-002 — 必須化された callback が application repository/projection orchestration ではなく、adapter の全処理 executor を再呼出しするだけである

- 場所:
  - `packages/core/src/application/search/contracts.ts:235-267`
  - `packages/core/src/application/search/prepareSemanticCommand.ts:153-307`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:103-121,189-351`
  - `apps/web/app/testing/LocalUserDataDurableObject.ts:39-55`
  - `.thread/19/plan.md:62-76,125-130`
- 根拠:
  - `SemanticTransactionRepositories` が公開する能力は `apply(command, projection)` 1つだけで、本体 repository の load/insert/save/remove capability はない。
  - Local application callback は受け取った command と projection をそのまま `repositories.apply(prepared, projection)` へ返すだけである。本体更新と projection 更新の判断はすべて adapter の private `execute()` が行う。
  - `prepareSemanticCommand()` は transport DTO を部分検証して cast しており、domain entity/value object/usecase の結果ではない。例えば memo 本文と document title の domain rule は application prepare ではなく adapter の `validateMemo()` / `validateDocument()` に残る。document create の change reason は command に存在せず adapter が `"created"` を直書きする。
- 影響:
  - callback を追加したものの、第4回で要求した「application が domain 判定済み結果を transaction-scoped repositories と projection へ commit する」境界は成立していない。
  - 後続の memo/document usecase は domain の結果を repository へ保存できず、test harness の永続化 DTO と adapter 手続きへ再び結合する。AC-5 の capability を本番 usecaseへ再利用できるという受け入れ根拠にならない。
- 提案:
  - prepare で domain value object/entity/usecase outcome を確定し、command を storage write DTO ではなく domain 判定済みの operation にする。
  - callback へ command 別の実 repository capability を渡し、application callback が本体 save と scoped projection を同じ semantic operation として構成する。adapter の全処理 executor を repository と呼ばない。

### B-SDJ5-003 — document create/restore が復元先 topic を touchせず、destination move + restore の document version も1回しか進まない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:410-472,508-564`
  - `spec/testcases/knowledge/createDocument.md:27-29`
  - `spec/testcases/trash/restoreDocument.md:9-14,35-40`
  - `spec/domains/knowledge.md:225-227`
- 根拠:
  - document create は topic の存在確認後に document をINSERTするだけで、topic の version を touchしない。
  - active/archived topic 配下への restore、および既存 destination topic への restore も topic を検証するだけで version を進めない。
  - 元 topic が消失した document は、domain上 `moveToTopic`（version +1）と `restore`（version +1）の2状態遷移である。現行SQLは topic差替えとrestoreを1回の `UPDATE ... version = version + 1` に畳み、1しか進めない。
- 影響:
  - document の所属・復元と並行して取得済みだった stale topic token が、その後の topic trash/update を成功させられる。spec が topic touch で排除している「復元直後のdocumentをstale topic操作が巻き込む」競合を検出できない。
  - destination restore 後の document OCC token がdomain遷移回数と一致せず、履歴・UIが期待するversion契約が崩れる。
- 提案:
  - create/restore の既存 topic を同一 transaction で CAS touchする。destination が新規topicの場合だけcreateの初期versionを使う。
  - 親消失後の既存topic復元は、moveとrestoreの2遷移をversionへ反映する。topic/document双方のstale tokenを拒否する統合テストを追加する。

### B-SDJ5-004 — 「projection write途中失敗」テストは capability guard で本体書込前に失敗しており、依然 false positive である

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:103-119`
  - `apps/web/app/testing/LocalUserDataDurableObject.ts:59-79`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:746-790`
- 根拠:
  - production repository は `candidateProjection !== projection` なら `execute()` 前に `DATA_INTEGRITY_ERROR` をthrowする。
  - fault helper は wrapper の `failingProjection` を `repositories.apply()` に渡すため、上記guardに必ず一致し、本体INSERTも実projectionのupsert/removeも一度も実行されない。
  - テストは初期状態で content/search/idempotency が0件であることだけを確認するため、この早期失敗でもgreenになる。
  - FTS tableを先にdropする別テストは「本体書込後、projection開始時の失敗」を証明するが、FTS delete/entry insert後などprojection自体の途中失敗は証明しない。
- 影響:
  - AC-5のatomicity証跡として掲げたmid-projection rollbackが壊れてもsuiteはgreenになる。第4回のfalse positive指摘が解消されたという根拠にならない。
- 提案:
  - scoped projection instance自体へ明示的なfault pointを注入し、search entry削除後、FTS delete後、entry insert後、FTS insert後を個別に失敗させる。
  - 各faultで本体/revision/source/search/idempotencyの全tableがrollbackしたことを確認する。

### B-SDJ5-005 — Alarm retryテストが各attemptを手動でdue化し、最大retryまでの自動再設定・再起動を証明しない

- 場所:
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:271-305`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:488-527,627-635`
  - `.thread/19/plan.md:24,81,143-147,231-232`
- 根拠:
  - 各attempt後、テストがSQLで `next_run_at = Date.now() - 1` に書き換えてから次の Alarm を強制実行する。
  - evictionは最初のattempt前に1回だけで、attempt間の再起動、実際に永続化されたbackoff時刻、`ensureAlarm()`がその時刻を自動設定したことを検査しない。
  - 追加されたsetAlarm fault testは「失敗後の次input gate再計算」を確認するが、通常retryの自動wake-up、claim/complete途中失敗、attempt間restartの証跡にはならない。
- 影響:
  - AC-12が明示する最大自動retry後の自前再設定、再起動、途中失敗をrelease evidenceが満たさない。Alarmが自動的に2回目へ進めなくてもテストはgreenになる。
- 提案:
  - fake clockまたは実Alarm時刻の検査を使い、retryで保存した `next_run_at` と設定Alarmの一致を確認する。attempt間でevictし、DB時刻の直接改変なしに再開する。
  - claim後、complete前、setAlarm時のfaultを分離し、それぞれlease reclaimまたはinput gate再設定で継続することを固定する。

## Warnings

### W-SDJ5-001 — v1 settings fixtureのversion 1がmigration後も残り、生成時0の正本へ変換されない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/schema.ts:142-250`
  - `apps/web/app/testing/__tests__/migrations.integration.test.ts:127-137,168-253`
  - `spec/database/index.md:65-72`
- 理由:
  - upgrade fixtureは旧settingsを明示的に `version = 1` でseedするが、v2/v3 migrationにsettings versionを0起点へ変換する処理はない。
  - post-upgrade assertionはprofile/content/AI connectionだけで、settings versionを確認しない。このため旧objectだけ初期versionが1、新規objectは0という分裂を見逃す。
- 提案:
  - 旧versionを論理的なmutation回数へ変換するforward migrationを追加し、settingsの値・DDL/default/checkをpost-upgrade testで固定する。

### W-SDJ5-002 — lease reclaim とterminal pruneが件数無制限の単一UPDATE/DELETEで、job batch budgetを迂回する

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/jobs.ts:143-151,336-343`
  - `.thread/19/plan.md:143-147,222,232`
- 理由:
  - claim結果は25件に制限されるが、その直前のexpired lease reclaimは該当行を全件更新する。terminal pruneも期限超過行を全件削除する。
  - 大量のleased/terminal jobが蓄積すると、Alarmの25件/10秒budgetより前に無制限SQL mutationが走り、CPU/storage pressureで同じtransactionを繰り返しrollbackし得る。
- 提案:
  - subquery + LIMITでreclaim/pruneをbounded chunkにし、残件がある場合は直近Alarmへ継続を返す。大件数境界をintegration testへ追加する。

### W-SDJ5-003 — 破損payloadをpoison化できても、retention設定変更はmalformed JSON 1件で全体rollbackする

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:298-324`
  - `packages/core/src/adapters/cloudflare/user-data/jobs.ts:152-193`
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:154-195,338-482`
- 理由:
  - claimは不正JSON/digestをpoisonへ隔離するよう改善された。一方、retention変更はpending/leased job全件へ `json_extract(payload_json, '$.trashedAt')` を実行するため、将来dueのmalformed JSONが1件あるだけでSQLite errorとなり、settings/trash/topic/job更新を全てrollbackする。
  - corrupt payload testとretention再計算testは別々で、この組合せを確認しない。
- 提案:
  - purge期限をJSON再解析に依存せずcanonical trash/topic行から更新するか、不正rowを同じtransactionでpoisonへ隔離して正常rowの再計算を続ける。

### W-SDJ5-004 — typed projectionのsource fieldsをadapterが捨て、spec記載のsource projection tableも存在しない

- 場所:
  - `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:169-225,500-570`
  - `packages/core/src/adapters/cloudflare/user-data/schema.ts:79-110`
  - `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:785-843`
  - `spec/database/index.md:145-165`
  - `spec/domains/search.md:70-96,163-173`
- 理由:
  - `MemoSearchProjection.sourceOfDocumentIds` / `DocumentSearchProjection.sourceMemoIds` はsemantic commitで構築されるが、`replace()`はtitle/body/topicIdだけを保存しsource配列を無視する。
  - specの `search_entry_sources` tableはschemaに存在せず、検索時にcanonical `content_sources`を直接joinして結果を再構築する。現行動作は整合するが、typed projection contractとDB設計の説明は実装されていない。
- 提案:
  - canonical tableを直接joinする設計を正本にするならprojection DTOから未使用source fieldsと`search_entry_sources`記述を削除する。projection所有とするならtable/upsert/remove/fault testを実装する。

## Notes

### N-SDJ5-001 — 第4回後のOCC・migration・provenance・payload poison改善は有効

- create以外のexpectedVersion必須化、content/topic CAS、topic setでのdocument version更新、親topic消失後のdestination指定は実装・テストに反映された。
- AI connectionはlegacy列を除いたcanonical tableへrebuildされ、revisionにはhuman/AI kind・ID・AI client name snapshotが保存される。
- semantic idempotencyの保持時計はcallerのbusiness timestampからDO trusted clockへ分離された。
- stored job payloadのJSON/digest破損はpoisonへ隔離され、同一claim batchの後続正常jobを阻害しない。

### N-SDJ5-002 — 検証結果

- `pnpm --filter @repo/core typecheck`: pass
- Search/Jobs/DurableObjects integration: 3 files / 33 tests pass
- User Data migration filter: 2 tests pass / 4 skip
- greenであってもB-SDJ5-004/005のfault・retry経路を実際には通らないため、当該Blockerの反証にはならない。
- 本レビューではコード変更、commit、pushを行っていない。
