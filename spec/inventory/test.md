# Inventory — test

Issue #19後のactive test inventory。個別業務ケースは`spec/testcases/`、ここでは実行suiteと必須contractを台帳化する。

## domain unit

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-DOM-001 | account credential、primary email、last credential、session epoch不変条件 | automated | `spec/inventory/test-evidence.json#TEST-DOM-001` |
| TEST-DOM-002 | memo/document/topic lifecycle、revision、source link、trash/restore | automated | `spec/inventory/test-evidence.json#TEST-DOM-002` |
| TEST-DOM-003 | SearchQuery NFKC、空、UTF-8 50-byte境界、optional単一topic | automated | `spec/inventory/test-evidence.json#TEST-DOM-003` |

## application unit

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-APP-001 | signup coordinatorの全phase/fault/retry | automated | `spec/inventory/test-evidence.json#TEST-APP-001` |
| TEST-APP-002 | reset/link/unlink/delete primitive state machine | automated | `spec/inventory/test-evidence.json#TEST-APP-002` |
| TEST-APP-003 | loginの未登録/SSO-only/誤password/不正形式でdummy verifyと同一error | automated | `spec/inventory/test-evidence.json#TEST-APP-003` |
| TEST-APP-004 | current-user合成と片側unavailable | automated | `spec/inventory/test-evidence.json#TEST-APP-004` |
| TEST-APP-005 | RPC retry policy、job lease/CAS/poison/alarm scheduling policy | automated | `spec/inventory/test-evidence.json#TEST-APP-005` |

## workerd integration

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-DO-001 | request test worker + state auxiliary worker、3 class exports/bindings/generated types | automated | `spec/inventory/test-evidence.json#TEST-DO-001` |
| TEST-DO-002 | 3 classのlazy migration再実行、forward-only、newer-version拒否 | automated | `spec/inventory/test-evidence.json#TEST-DO-002` |
| TEST-DO-003 | userId別User Data DOの物理分離とunauthorized routing | automated | `spec/inventory/test-evidence.json#TEST-DO-003` |
| TEST-DO-004 | memo/document create/update/remove/restore + FTS5同期射影 | automated | `spec/inventory/test-evidence.json#TEST-DO-004` |
| TEST-DO-005 | 本体失敗/射影失敗双方のtransaction rollback | automated | `spec/inventory/test-evidence.json#TEST-DO-005` |
| TEST-DO-006 | trigram日本語、短語fallback、NFKC、special chars、rank/snippet/pagination | automated | `spec/inventory/test-evidence.json#TEST-DO-006` |
| TEST-DO-007 | optional topic、trash、archive、source DTO、UI/AI同一semantics | automated | `spec/inventory/test-evidence.json#TEST-DO-007` |
| TEST-DO-008 | operationId同一再送/異payload conflict | automated | `spec/inventory/test-evidence.json#TEST-DO-008` |
| TEST-DO-009 | Alarm at-least-once、lease reclaim、owner CAS、provider idempotency、poison | automated | `spec/inventory/test-evidence.json#TEST-DO-009` |
| TEST-DO-010 | commit後setAlarm、失敗後input gate再計算、最早時刻競合、再起動 | automated | `spec/inventory/test-evidence.json#TEST-DO-010` |
| TEST-DO-011 | SQL parameter/batch/CPU/capacity guardとerror translation | automated | `spec/inventory/test-evidence.json#TEST-DO-011` |

## identity contract / fault injection

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-ID-001 | password signup全fault point、reconciler、orphan/二重userなし | automated | `spec/inventory/test-evidence.json#TEST-ID-001` |
| TEST-ID-002 | SSO初回/再送/同時初回/email競合/provider境界/active-previous rotation | automated | `spec/inventory/test-evidence.json#TEST-ID-002` |
| TEST-ID-003 | change/reset/link/unlink primitive/schema/idempotency/invariants | automated | `spec/inventory/test-evidence.json#TEST-ID-003` |
| TEST-ID-004 | deletion tombstone/epochとDirectory/User Data復旧時の優先 | automated | `spec/inventory/test-evidence.json#TEST-ID-004` |
| TEST-ID-005 | Account Home restore拒否wrapper/admin tooling | automated | `spec/inventory/test-evidence.json#TEST-ID-005` |
| TEST-ID-006 | credential routing/loggingにPIIが含まれない | automated | `spec/inventory/test-evidence.json#TEST-ID-006` |

## presentation regression

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-PRES-001 | signup/login/current user/logout | automated | `spec/inventory/test-evidence.json#TEST-PRES-001` |
| TEST-PRES-002 | public inputにDO ID/partition/userId overrideがない | automated | `spec/inventory/test-evidence.json#TEST-PRES-002` |
| TEST-PRES-003 | primitive serialized envelope/error translation | automated | `spec/inventory/test-evidence.json#TEST-PRES-003` |
| TEST-PRES-004 | UI/将来REST/MCPが共有するcanonical authenticated User Data routing | automated | `spec/inventory/test-evidence.json#TEST-PRES-004` |

## manual / operations

| ID | 対象 | Status | 実装・手順 |
|---|---|---|---|
| TEST-MAN-001 | local-only lifecycle CLI。本番artifact/route不在 | automated | `spec/inventory/test-evidence.json#TEST-MAN-001` |
| TEST-MAN-002 | `spec/manual-tests/search.md` の直後反映、日本語/短語/topic/trash | manual | `spec/inventory/test-evidence.json#TEST-MAN-002` |
| TEST-OPS-001 | staging disposable User Data/Identity Directory PITR smoke | release gate | `spec/inventory/test-evidence.json#TEST-OPS-001` |
| TEST-OPS-002 | Account Home restore拒否、復旧後epoch/Directory全authority照合 | automated + staging | `spec/inventory/test-evidence.json#TEST-OPS-002` |
| TEST-OPS-003 | state先→request後deploy、RPC compatibility window、secret隔離 | automated + release gate | `spec/inventory/test-evidence.json#TEST-OPS-003` |
