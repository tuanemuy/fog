| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `identity/application-coordinator` | R1 DA-001 | fix | saga状態機械をadapterからapplicationへ戻す | 0 |
| `identity/stable-operation-resume` | R1 DA-002 / ID-B001 | fix | 部分失敗後も同じuser/operationで再開する | 0 |
| `identity/login-authority-epoch` | R1 DA-003 / ID-B002/B003 | fix | pending/deleting/deletedと旧sessionを拒否する | 0 |
| `identity/sso-reset-link-delete-contract` | R1 DA-004 / ID-B004/B005 | fix | Issue明示のprimitive/sagaを実行可能にする | 0 |
| `identity/rotation-reconciler` | R1 Infra-B004 / ID-B006 | fix | checkpoint scanとorphan収束を実装する | 0 |
| `identity/rpc-envelope-retry` | R1 DA-005 / ID-B008/W003 | fix | version/validation/error/retryを実境界で機能させる | 0 |
| `identity/enumeration-secret-dto` | R1 ID-W001/W002/W004 | fix | timing、keyring強度、security projectionを守る | 0 |
| `identity/branded-ids-current-view-clock` | R1 DA-W001/W002/W003 | fix | 型境界・所有DTO・決定時刻を正す | 0 |
| `search/idempotency-payload-conflict` | R1 DA-006 / SDP-B001 | fix | 同ID異payloadを成功扱いしない | 0 |
| `search/lifecycle-revisions-trash` | R1 SDP-B002 / TS-B004 | fix | memo/document各lifecycleとrevisionをatomicにする | 0 |
| `search/source-integrity` | R1 SDP-B003 | fix | 双方向sourceとhard-delete孤児を解消する | 0 |
| `search/topic-semantics` | R1 SDP-B004 | fix | topic本体・source memo・archive/trashを権威化する | 0 |
| `search/result-dto-pagination` | R1 DA-007 / SDP-B005/B006 | fix | specの直和DTOと安定cursorを実装する | 0 |
| `search/snippet-normalization` | R1 SDP-B007 | fix | 原文一致箇所をNFKC/短語/titleでも示す | 0 |
| `search/validation-error-limits` | R1 SDP-B008 | fix | query/RPC/SQLite errorをtyped contractにする | 0 |
| `search/performance-storage-contract` | R1 SDP-W001/W002/W003/W005 | fix | rowid、batch source、容量選択、dead contractを解消する | 0 |
| `jobs/idempotency-conflict` | R1 SDP-B009 | fix | job/payload/provider key衝突を検出する | 0 |
| `jobs/alarm-starvation-egress` | R1 Infra-B002/B003 / SDP-B010 | fix |既存alarmを遅延させず実executorを配線する | 0 |
| `jobs/lease-index-retention` | R1 SDP-W004 | fix | reclaimと長期運用scanをboundedにする | 0 |
| `infra/ci-cloudflare-only` | R1 Infra-B001 / TS-B001 | fix | 削除済みruntime matrixを除去する | 0 |
| `infra/pitr-operator-wrapper` | R1 Infra-B005 / ID-B007 | fix | guardを実restore前のtoolingへ接続する | 0 |
| `infra/migrations-versioned` | R1 Infra-W001 / TS-B006 | fix | 3 classのordered migrationとrollbackを検証する | 0 |
| `infra/secret-stage-vite` | R1 Infra-W002/W004 | fix | secret gateとstage custom buildのconfigを正す | 0 |
| `tests/request-state-boundary` | R1 Infra-B006 / TS-B002 | fix | request→auxiliary state境界を実際に通す | 0 |
| `tests/search-acceptance` | R1 TS-B003 | fix | search testcaseをworkerd table testへ対応させる | 0 |
| `tests/identity-fault-matrix` | R1 ID-W005 / TS-B005 | fix | 公開port経由で全fault/rotationを検証する | 0 |
| `tests/manual-lifecycle-cli` | R1 Infra-W003 / TS-B007 | fix | local-only CLIを実装し本番除外を検査する | 0 |
| `tests/legacy-audit` | R1 TS-W001 | fix | active pathの旧前提をCIで禁止する | 0 |
| `tests/progress-traceability` | R1 TS-W002/W003 | fix | 実績記録とTEST-ID対応を一致させる | 0 |
