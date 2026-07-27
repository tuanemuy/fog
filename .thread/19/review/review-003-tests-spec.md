# PR #33 第3回レビュー — Tests / Spec / Acceptance

## 判定

**CHANGES_REQUESTED**

第2回後に identity fault matrix、document lifecycle、stable cursor、実 Alarm handler、旧 fixture migration、PITR operator workflow、machine-readable evidence が追加され、workerd 上の基礎 coverage は大きく改善した。しかし PR の必須 CI は現在赤であり、記録済みテスト結果は現 HEAD / clean install の結果ではない。また request acceptance は本番 entry を通らないテスト専用 Worker、traceability audit は文字列の存在だけを検査するため、Issue #19 の受け入れ条件を満たしていないケースも `automated` / `verified` と判定される。特に public request boundary、login 列挙耐性、Alarm 自動再試行、User Data lazy migration、PITR、検索順位の証拠が不足している。

## Blockers

### B-TS3-001 — 必須 CI が clean install 後の lifecycle acceptance で失敗し、記録済み結果も現 HEAD と一致しない

- 場所:
  - `.github/workflows/ci.yml:61-68`
  - `apps/web/package.json:21-27,53-67`
  - `.thread/19/test-results.json:2-20`
  - `.thread/19/testing.md:8-10`
  - `.thread/19/progress.md:18-21`
- 根拠:
  - PR #33 の run `30294626070` では `Cloudflare integration tests` job が失敗している。integration suite 後の `pnpm test:lifecycle:cli` が `lifecycle:run` を実行し、`tsx: not found` で終了する。
  - `lifecycle:run`、PITR/identity operator、secret check は `tsx` を呼ぶが、`@repo/web` にも root にも `tsx` dependency がない。ローカルの偶然の PATH / node_modules に依存した結果である。
  - `test-results.json` は base commit `1e716a3...` の dirty working tree を正本としており、現 HEAD `502776e...` の CI failure に反して lifecycle を `passed`、integration を `passed` と記録する。
- 影響:
  - AC-16 と TEST-MAN-001 の必須 gate を満たさず、再現可能な受入結果がない。
  - `.thread/19/progress.md` の「CI実行」と test inventory の `automated` 表示が実際の clean install を表さない。
- 修正案:
  - `tsx` を実際に script を所有する workspace の devDependency と lockfile に追加するか、Node が直接実行可能な runner に置換する。operator scripts も同じ clean-install 条件で確認する。
  - 現 HEAD を基準に全必須 command と PR CI を再実行し、commit SHA、run URL、結果を `test-results.json` に更新する。

### B-TS3-002 — request integration は本番 request entry / server action を通らず、TEST-PRES と AC-1 の false positive になっている

- 場所:
  - `vitest.config.integration.ts:8-10,62-66`
  - `apps/web/app/testing/request.integration.worker.ts:23-67,69-142,144-229`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:7-142`
  - `apps/web/app/server.cloudflare.ts:40-55`
  - `spec/inventory/test.md:27-29,54-57`
  - `spec/inventory/test-evidence.json:68-79,87-93,207-234`
- 根拠:
  - request integration の `main` は production `server.cloudflare.ts` ではなく、テスト専用 `/acceptance/*` Worker である。
  - payload deny-list、session cookie parsing/flags、signup/login/current/logout dispatch、HTTP status/error mapping を test Worker 内で再実装している。production の TanStack server action、presentation middleware、session helper、実 route schema、default entry は一度も実行されない。
  - したがって production action から routing override field が混入する、cookie option が退行する、middleware/error adapter が壊れる、といった回帰でも4件の integration testは通る。
- 影響:
  - `script_name` 越しの state Worker 呼び出し自体は確認できるが、TEST-PRES-001/002/004、TEST-DO-003、AC-1 の公開契約の証拠にはならない。
  - テスト用 deny-list と本番 input schema が別々に進化し、最も重要な userId/DO routing boundary に偽の安心を与える。
- 修正案:
  - production request entry、または production server action/middleware/session modulesをそのまま composition する薄い test entry を使い、実 `/signup`、`/login`、`/settings` 相当の HTTP boundary を通す。
  - payload、query、form に `userId` / DO ID / partition key を混ぜた2 account testで、production routeから選択先が変わらないことを表明する。

### B-TS3-003 — traceability audit は文字列の存在だけで「executable evidence verified」と報告し、対象契約との対応を検査しない

- 場所:
  - `scripts/audit-test-traceability.mjs:16-25,39-44,46-130,137-139`
  - `spec/inventory/test.md:5-67`
  - `spec/inventory/test-evidence.json:2-286`
- 根拠:
  - test evidence は `source.includes(record.test)`、suite は config 内に対象 glob 文字列があるかだけを検査する。テスト名が inventory の「対象」を表明するか、実行結果が PASS かは検査しない。
  - `ci-command` は package script 名の存在だけ、`release-gate` は結果が `pending` でも marker 文字列の存在だけで成功する。
  - 実際に `pnpm audit:test-traceability` は現在の CI が赤、PITR staging が pending のまま `34 TEST IDs, executable evidence verified` と成功する。
  - 代表的な誤対応:
    - TEST-DOM-001 の credential/primary email/last credential/session epoch に対し、単一 `identity.userRegistered` event testだけを割り当てる (`test-evidence.json:2-8`)。
    - TEST-APP-003 の未登録/SSO-only/誤password/不正形式の同一 error に対し、dummy hash warning の logger testだけを割り当てる (`:47-53`)。
    - TEST-DO-006 の trigram/短語/NFKC/special chars/rank/snippet/pagination に対し、100 bind/tie/snapshot quota の1 testだけを割り当てる (`:108-114`)。
    - semantic operation replay の TEST-DO-008 に job provider-key testを割り当てる (`:122-128`)。
    - Account Home restore拒否の TEST-ID-005 に Directory reconcile testを割り当てる (`:193-199`)。
    - TEST-OPS-001/002/003 は未実施項目を記した progress marker を release evidence として受理する (`:252-285`)。
- 影響:
  - inventory の `automated` と audit の green が AC coverage を意味せず、B-TS3-002/004〜008 の不足を品質 gate が検出できない。
- 修正案:
  - testcase/AC を細粒度 case ID に分け、各 test に一意な case ID tagを付けて AST または reporter JSON から実行・PASSを検査する。
  - `ci-command` は workflow から実行され成功した run evidence、release gate は `passed` result/対象/日時を必須にする。未実装・未実施は `pending` として audit を失敗させる。

### B-TS3-004 — Identity の fault coverage は改善したが、公開 login 列挙耐性と競合ケースを自動化済みとする証拠がない

- 場所:
  - `.thread/19/plan.md:18-19`
  - `.thread/19/testing.md:116-135`
  - `spec/inventory/test.md:17-20,43-48`
  - `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts:70-155`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:74-120,122-151,180-252,377-530`
  - `spec/inventory/test-evidence.json:28-60,160-205`
- 根拠:
  - signup/SSO/link/unlink/reset/delete の fault-point再送testは追加されたが、TEST-ID-001 の evidence は fault matrixではなく happy replay 1件だけ、TEST-ID-003 は reset 1件だけを参照する。
  - AC-2 / testing plan が要求する「同時初回 SSO」と signup の期限切れ reservation reclaim を駆動する test はない。
  - TEST-APP-003 は unknown addressで dummy verify が失敗した際の warning redaction/latchだけを検査する。未登録、SSO-only、誤password、不正形式の4経路について、dummy verify の有無と公開 status/code/message が同一であることを比較する test は存在しない。
  - request integration も successful loginしか実行せず、B-TS3-002のテスト専用 error mapperを使う。
- 影響:
  - Directory分割後の account enumeration regression と、同時作成時の orphan/二重 user を自動検出できない。
  - AC-2/AC-3、TEST-APP-003、TEST-ID-001/002/003/006 を完了扱いする根拠が不足する。
- 修正案:
  - production public login boundary から4失敗経路を table testし、同じ HTTP status/code/message と期待する dummy verification callを表明する。ログ sink も捕捉して PII 非包含を検査する。
  - barrier付き並行 SSO初回、期限切れ reservation、reconciler後の全 shard/Account Home/User Data 最終状態を追加し、実 fault matrix の各 test名を evidence に割り当てる。

### B-TS3-005 — Alarm test は retry を手動で due 化・再設定しており、AC-12 の自動回復を証明しない

- 場所:
  - `.thread/19/plan.md:28`
  - `.thread/19/testing.md:137-146,192-198`
  - `spec/inventory/test.md:21,35-37`
  - `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:43-153,210-265,339-368`
  - `spec/inventory/test-evidence.json:61-67,129-159`
- 根拠:
  - lease reclaim/owner CAS/poison/store digest は実SQLiteで確認されている。
  - 一方「real alarm handler」testは各失敗後に test 自身が `next_run_at` を過去へ更新し、`state.storage.setAlarm(...)` を呼んでから次の alarm を駆動する (`userDataJobs.integration.test.ts:245-263`)。handlerが retry時刻を自前で再設定したことも、その alarm だけで次回実行されたことも表明しない。
  - `setAlarm` failureを注入し、次の input gate / restartで最早時刻を復元する test はない。
  - provider idempotency は DB key uniquenessだけで、同じ key に対する外部adapter副作用が1回であることを検査しない。CPU/time budget、capacity/`SQLITE_FULL`、platform retryable/overloaded translationもない。
- 影響:
  - AC-12 が明記する最大retry後の自前再設定、途中失敗、provider idempotencyを壊しても suite が green になる。
  - TEST-DO-009/010/011 と TEST-APP-005 の `automated` 表示が実 coverage を過大評価する。
- 修正案:
  - 制御可能な clock、faulting `setAlarm`、counting external providerを持つ workerd harness で、test側から alarmを再設定せず pending → retry → success/poison を駆動する。
  - 各attempt後の persisted `nextRunAt` と platform alarm、eviction後の再開、provider effect count、budget/capacity error codeを独立して表明する。

### B-TS3-006 — 3 class lazy migration の受入条件に対し、User Data の実旧fixtureがなく、既存2 classも RPC 前に手動upgradeしている

- 場所:
  - `.thread/19/plan.md:27`
  - `spec/inventory/test.md:27-28`
  - `apps/web/app/testing/__tests__/migrations.integration.test.ts:43-120,122-204,206-261`
  - `spec/inventory/test-evidence.json:80-86`
  - `.thread/19/progress.md:16`
- 根拠:
  - ordered/idempotent/atomic/newer-version test は3 classを対象にするが、constructorで最新まで初期化済みの storage へ migration関数を直接呼ぶ testである。
  - 「real v1 fixture」cases は Identity Directory と Account Home の2件だけで、最も大きな schema を持つ User Data がない。
  - さらに fixture test は v1をseedした後、`upgradeCase.migrate(...)` を testから直接実行してから eviction/RPC を行う (`migrations.integration.test.ts:219-250`)。通常 RPC が lazy migration を発火したことを証明しない。
- 影響:
  - AC-11 の「3 classそれぞれの lazy migration」を満たさず、User Data の既存 rows/FTS/jobs を保持した upgrade regressionを検出できない。
  - test名と progress の「v1 fixtureから実migration / eviction後lazy no-op」は実際の sequence を過大表現する。
- 修正案:
  - User Data を含む3 classそれぞれで実旧schema/rowsをseedし、migration関数をtestから呼ばず、最初の通常 RPC がupgradeを実行することを検査する。
  - failure後は version/旧rows/schemaが原子的に戻り、次RPCで再試行、eviction後はno-opになる sequenceを表明する。

### B-TS3-007 — PITR staging gate は未実施で、local testも restart/restore/conflict failureを模倣しない

- 場所:
  - `.thread/19/plan.md:29,44`
  - `.thread/19/testing.md:12-15,160-169`
  - `.thread/19/progress.md:3-26`
  - `.thread/19/test-results.json:45-55`
  - `packages/core/src/adapters/cloudflare/__tests__/pitrPolicy.test.ts:36-67,70-201`
  - `apps/web/app/operator/__tests__/pitr.test.ts:18-131`
- 根拠:
  - AC-13 が明示する disposable staging の bookmark/restore/verify/undo は `pending` のままである。
  - local workflow fake の `restartSession()` は sequenceへ文字列を追加して正常returnするだけで、実際の isolate abort/restart、restart failure、restore未適用を表現しない。`verifyRestoredSession()` も引数に関係なく任意の `"restored-current"` を返す。
  - Directory testは `conflicts: 0` の成功/incomplete cursorだけで、authority conflictを検出した時に成功させないことを検査しない。
  - それでも testing/progress は「schedule→restart→verify→undo protocolまでを自動検証」と記録し、traceability auditは `pending` markerをrelease evidenceとして受理する。
- 影響:
  - restoreが適用されていない、restartできない、Directory conflictが残る状態でも operatorが成功を返す回帰を検出できない。
  - AC-13 / TEST-OPS-001/002 の完了条件を満たさない。
- 修正案:
  - local unit/HTTP testsに restart rejection、未更新session marker、bookmark mismatch、Directory conflict、undo failureを追加し、成功receiptを返さないことを表明する。
  - 認証済み disposable staging で実 bookmark → mutation → restore → restart → verify/reconcile → undo を完了し、対象、時刻、bookmark、結果、runbook実行者を release resultとして記録する。

### B-TS3-008 — 検索 coverage は改善したが、順位・literal special chars・短語境界の仕様をまだ証明せず、TEST-DO-006 は別testへ誤マッピングされている

- 場所:
  - `.thread/19/plan.md:21-22`
  - `.thread/19/testing.md:104-114`
  - `spec/testcases/search/search.md:5-24`
  - `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:350-419,645-774`
  - `spec/inventory/test.md:30-37`
  - `spec/inventory/test-evidence.json:94-128,153-159`
- 根拠:
  - memo/document lifecycle、NFKC原文snippet、topic/trash/source DTO、snapshot cursorは実 workerd testで改善された。
  - 順位testは同一本文・同一timestampの document/memo ID順だけを検査し、異なる `bm25` relevance、timestamp tie-break の順序を表明しない。
  - special chars testは特殊文字を含まないfixtureに `\"*() OR -` を検索して0件を期待するだけである。全記号を捨てる実装でも通り、仕様の「literalとして一致」を証明しない。
  - short fallbackは1文字の `"1"` / `"設"` / `"ガ"` と2文字の `"古い"` が中心で、testcaseが指定する一意な ASCII `q` / `qx` の一致境界がない。
  - TEST-DO-006 evidence はこれらのtestではなく、100 bind/tie/snapshot quota 1件だけを指す。TEST-DO-004/005/008も対象を満たす複数testの一部または別のjob testへ割り当てられている。
- 影響:
  - AC-5/AC-6 の rank と safe short/literal query semantics が退行しても acceptance gate が成功する。
- 修正案:
  - term frequency/field差で `bm25` が異なるfixture、同rankでtimestamp/type/idが異なるfixtureを作り、全sort keyを順番に表明する。
  - 特殊文字そのものを含むcontentと ASCII 1/2 byte contentをseedして literal hit、安全なfallback、無関係行非一致を確認する。
  - TEST-DO-004〜008/011 を実際の個別 test名へ分割して再マッピングする。

## Warnings

### W-TS3-001 — TEST-APP-004 は current-user の片側 unavailable を検査していない

- 場所:
  - `spec/inventory/test.md:20`
  - `spec/inventory/test-evidence.json:54-60`
  - `.thread/19/plan.md:80`
- 理由: evidence は session epochが進んだ時に nobody を返す1件だけで、Account Home unavailable、User Data unavailable、片側だけ古い値が取れるケースの retryable infrastructure error を表明しない。
- 提案: 両依存を個別に失敗させ、partial current-userを返さず同じ retryable error contractになることを追加する。

### W-TS3-002 — state Worker の request-only secret「不在」は runtime integration で確認していない

- 場所:
  - `apps/web/app/testing/request.integration.worker.ts:147-153`
  - `apps/web/app/testing/__tests__/requestStateBoundary.integration.test.ts:22-42`
  - `.thread/19/testing.md:148-158`
- 理由: testは request Worker に2 secretが存在することだけを返し、state auxiliary Worker側に session/routing secretがないことを state側から表明しない。
- 提案: state test-only introspection contractまたは generated deploy metadata auditで、許可 binding listと禁止 secret名の不在を検査する。

### W-TS3-003 — TEST-OPS-003 は RPC compatibility window / rollbackを検査していない

- 場所:
  - `spec/inventory/test.md:67`
  - `spec/inventory/test-evidence.json:271-285`
  - `.thread/19/testing.md:184-190`
- 理由: evidence は secret separation unit、dry deploy command、pending secret markerだけである。旧/新 request-state versionの互換組み合わせ、state先行、request rollbackの synthetic test はない。
- 提案: auxiliary workerのversionを切替可能にし、互換version成功、非互換versionの構造化error/no mutation、request rollbackを自動化する。

### W-TS3-004 — manual search inventory は現 Issue の実行可能 surface と一致しない

- 場所:
  - `spec/inventory/test.md:63-65`
  - `spec/manual-tests/search.md:12-49,55-257`
  - `.thread/19/plan.md:42-44`
- 理由: manual手順は `/search` UI、memo/document/topic作成画面を前提にするが、Issue #19 の scope はそれらの本番 UI/usecaseを実装しない。TEST-MAN-002 は `manual` だが実施結果もなく、現 PR で実行できるのは local-only lifecycle CLI である。
- 提案: 現 Issue の acceptance はCLI手順へ分離し、将来UI用 manual testは対象Issue/pendingを明記する。実施していない manual caseを完了表示にしない。

## Notes

### N-TS3-001 — 第2回から実質的に改善した coverage

- Identity signup/SSO/link/unlink/reset/delete の fault-point再送
- document update/trash/restore/hard-delete、main write rollback、semantic RPC schema
- search NFKC原文snippet、topic authority、stable snapshot、quota
- persistent job lease/CAS/poisonと実 `alarm()` entry
- Identity Directory / Account Home の旧fixture migration
- canonical User Data target、Directory cursor reconcileを持つ PITR workflow
- TEST ID evidence fileとsuite includeの機械検査

これらは有効な追加である。ただし上記 Blocker の受入条件を代替しない。

### N-TS3-002 — レビュー時の実行状況

- PR #33:
  - `Cloudflare integration tests`: FAIL（lifecycle `tsx: not found`）
  - `Cloudflare build and configuration audit`: PASS
  - `Lint / Format / Typecheck / Unit tests`: PASS
- ローカル:
  - `pnpm audit:test-traceability`: PASS（34 IDs。ただし B-TS3-003 の semantic false positiveあり）

