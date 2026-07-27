# Inventory — test

Issue #19後のactive test inventory。個別業務ケースは`spec/testcases/`、ここでは実行suiteと必須contractを台帳化する。

## domain unit

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-DOM-001 | account credential、primary email、last credential、session epoch不変条件 | automated | `packages/core/src/domain/identity/__tests__/{entity,valueObject}.test.ts`、`apps/web/app/durable-objects/__tests__/identity.integration.test.ts` |
| TEST-DOM-002 | memo/document/topic lifecycle、revision、source link、trash/restore | automated | `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts` lifecycle/topic cases |
| TEST-DOM-003 | SearchQuery NFKC、空、UTF-8 50-byte境界、optional単一topic | automated | `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts` validation/snippet cases |

## application unit

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-APP-001 | signup coordinatorの全phase/fault/retry | automated | `apps/web/app/durable-objects/__tests__/identity.integration.test.ts` signup resume/reconcile cases |
| TEST-APP-002 | reset/link/unlink/delete primitive state machine | automated | `apps/web/app/durable-objects/__tests__/{identity,durableObjects}.integration.test.ts` |
| TEST-APP-003 | loginの未登録/SSO-only/誤password/不正形式でdummy verifyと同一error | automated | `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` |
| TEST-APP-004 | current-user合成と片側unavailable | automated | `apps/web/app/presentation/__tests__/currentUser.test.ts`、request/state boundary suite |
| TEST-APP-005 | RPC retry policy、job lease/CAS/poison/alarm scheduling policy | automated | identity RPC version case、`userDataSearch.integration.test.ts` bounded retention executor |

## workerd integration

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-DO-001 | request test worker + state auxiliary worker、3 class exports/bindings/generated types | automated | `requestStateBoundary.integration.test.ts`、`cloudflare-config.test.ts` |
| TEST-DO-002 | 3 classのlazy migration再実行、forward-only、newer-version拒否 | automated | `migrations.integration.test.ts`（ordered/再実行/rollback/newer拒否） |
| TEST-DO-003 | userId別User Data DOの物理分離とunauthorized routing | automated | `durableObjects.integration.test.ts` physical isolation、request boundary override拒否 |
| TEST-DO-004 | memo/document create/update/remove/restore + FTS5同期射影 | automated | `userDataSearch.integration.test.ts` typed lifecycle |
| TEST-DO-005 | 本体失敗/射影失敗双方のtransaction rollback | automated | `durableObjects.integration.test.ts`、`userDataSearch.integration.test.ts` |
| TEST-DO-006 | trigram日本語、短語fallback、NFKC、special chars、rank/snippet/pagination | automated | `userDataSearch.integration.test.ts` query/snippet/snapshot cases |
| TEST-DO-007 | optional topic、trash、archive、source DTO、UI/AI同一semantics | automated | `userDataSearch.integration.test.ts` topic authority/source cases |
| TEST-DO-008 | operationId同一再送/異payload conflict | automated | `userDataSearch.integration.test.ts` digest idempotency case |
| TEST-DO-009 | Alarm at-least-once、lease reclaim、owner CAS、provider idempotency、poison | automated | `userDataSearch.integration.test.ts` bounded internal retention executor |
| TEST-DO-010 | commit後setAlarm、失敗後input gate再計算、最早時刻競合、再起動 | automated | `userDataSearch.integration.test.ts` retention/Alarm cases |
| TEST-DO-011 | SQL parameter/batch/CPU/capacity guardとerror translation | automated | FTS spike、`userDataSearch.integration.test.ts` typed validation/limits |

## identity contract / fault injection

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-ID-001 | password signup全fault point、reconciler、orphan/二重userなし | automated | `identity.integration.test.ts` stable operation resume |
| TEST-ID-002 | SSO初回/再送/同時初回/email競合/provider境界/active-previous rotation | automated | `identity.integration.test.ts` SSO/provider/rotation cases |
| TEST-ID-003 | change/reset/link/unlink primitive/schema/idempotency/invariants | automated | `durableObjects.integration.test.ts` primitive contract cases |
| TEST-ID-004 | deletion tombstone/epochとDirectory/User Data復旧時の優先 | automated | `identity.integration.test.ts` deletion epoch、PITR authority contract |
| TEST-ID-005 | Account Home restore拒否wrapper/admin tooling | automated | `pitrPolicy.test.ts`、`apps/web/app/operator/__tests__/pitr.test.ts` |
| TEST-ID-006 | credential routing/loggingにPIIが含まれない | automated | `identityRouting.test.ts`、identity public-envelope cases |

## presentation regression

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-PRES-001 | signup/login/current user/logout | automated | `requestStateBoundary.integration.test.ts` cookie/session flow |
| TEST-PRES-002 | public inputにDO ID/partition/userId overrideがない | automated | `requestStateBoundary.integration.test.ts` routing override case |
| TEST-PRES-003 | primitive serialized envelope/error translation | automated | request/state version mismatch、identity RPC version case |
| TEST-PRES-004 | 将来REST/MCPもAuthenticatedUserDataRouterを共有できるcontract | automated | `IdentityApplicationPort`/request composition contract and typecheck |

## manual / operations

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-MAN-001 | local-only lifecycle CLI。本番artifact/route不在 | automated + manual | `pnpm test:lifecycle:cli`、`pnpm audit:legacy` |
| TEST-MAN-002 | `spec/manual-tests/search.md` の直後反映、日本語/短語/topic/trash | manual | `spec/manual-tests/search.md` |
| TEST-OPS-001 | staging disposable User Data/Identity Directory PITR smoke | release gate | `docs/runtime_cloudflare.md` PITR operator CLI。実施状況は `.thread/19/progress.md` |
| TEST-OPS-002 | Account Home restore拒否、復旧前後epoch照合 | automated + staging | PITR workflow/HTTP contract、staging手順 |
| TEST-OPS-003 | state先→request後deploy、RPC compatibility window、secret隔離 | automated + release gate | config/boundary/version tests、`deploy:staging:dry`、`secrets:check:staging` |
