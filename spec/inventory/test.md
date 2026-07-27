# Inventory — test

Issue #19後のactive test inventory。個別業務ケースは`spec/testcases/`、ここでは実行suiteと必須contractを台帳化する。

## domain unit

| ID | 対象 |
|---|---|
| TEST-DOM-001 | account credential、primary email、last credential、session epoch不変条件 |
| TEST-DOM-002 | memo/document/topic lifecycle、revision、source link、trash/restore |
| TEST-DOM-003 | SearchQuery NFKC、空、UTF-8 50-byte境界、optional単一topic |

## application unit

| ID | 対象 |
|---|---|
| TEST-APP-001 | signup coordinatorの全phase/fault/retry |
| TEST-APP-002 | reset/link/unlink/delete primitive state machine |
| TEST-APP-003 | loginの未登録/SSO-only/誤password/不正形式でdummy verifyと同一error |
| TEST-APP-004 | current-user合成と片側unavailable |
| TEST-APP-005 | RPC retry policy、job lease/CAS/poison/alarm scheduling policy |

## workerd integration

| ID | 対象 |
|---|---|
| TEST-DO-001 | request test worker + state auxiliary worker、3 class exports/bindings/generated types |
| TEST-DO-002 | 3 classのlazy migration再実行、forward-only、newer-version拒否 |
| TEST-DO-003 | userId別User Data DOの物理分離とunauthorized routing |
| TEST-DO-004 | memo/document create/update/remove/restore + FTS5同期射影 |
| TEST-DO-005 | 本体失敗/射影失敗双方のtransaction rollback |
| TEST-DO-006 | trigram日本語、短語fallback、NFKC、special chars、rank/snippet/pagination |
| TEST-DO-007 | optional topic、trash、archive、source DTO、UI/AI同一semantics |
| TEST-DO-008 | operationId同一再送/異payload conflict |
| TEST-DO-009 | Alarm at-least-once、lease reclaim、owner CAS、provider idempotency、poison |
| TEST-DO-010 | commit後setAlarm、失敗後input gate再計算、最早時刻競合、再起動 |
| TEST-DO-011 | SQL parameter/batch/CPU/capacity guardとerror translation |

## identity contract / fault injection

| ID | 対象 |
|---|---|
| TEST-ID-001 | password signup全fault point、reconciler、orphan/二重userなし |
| TEST-ID-002 | SSO初回/再送/同時初回/email競合/provider境界/active-previous rotation |
| TEST-ID-003 | change/reset/link/unlink primitive/schema/idempotency/invariants |
| TEST-ID-004 | deletion tombstone/epochとDirectory/User Data復旧時の優先 |
| TEST-ID-005 | Account Home restore拒否wrapper/admin tooling |
| TEST-ID-006 | credential routing/loggingにPIIが含まれない |

## presentation regression

| ID | 対象 |
|---|---|
| TEST-PRES-001 | signup/login/current user/logout |
| TEST-PRES-002 | public inputにDO ID/partition/userId overrideがない |
| TEST-PRES-003 | primitive serialized envelope/error translation |
| TEST-PRES-004 | 将来REST/MCPもAuthenticatedUserDataRouterを共有できるcontract |

## manual / operations

| ID | 対象 |
|---|---|
| TEST-MAN-001 | local-only lifecycle CLI。本番artifact/route不在 |
| TEST-MAN-002 | `spec/manual-tests/search.md` の直後反映、日本語/短語/topic/trash |
| TEST-OPS-001 | staging disposable User Data/Identity Directory PITR smoke |
| TEST-OPS-002 | Account Home restore拒否、復旧前後epoch照合 |
| TEST-OPS-003 | state先→request後deploy、RPC compatibility window、secret隔離 |
