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

## Round 2

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `identity/signup-id-boundary` | R2 DA2-B001 / IS2-B001 | fix | client operation IDをcanonical user/DO keyへ昇格させない | 1 |
| `identity/signup-public-replay` | R2 DA2-B002 / IS2-B002 / TS2-B002 | fix | salt付きhashを跨いで公開signupを同じoperationから再開する | 1 |
| `identity/sso-partial-saga` | R2 DA2-B003 / IS2-B003 | fix | provider/email shard競合と部分失敗をAccount Homeから収束する | 1 |
| `identity/logical-credential-saga` | R2 DA2-B004 / IS2-B003/B004 | fix | link/unlinkをlogical credential単位のauthority/CASへ直す | 1 |
| `identity/password-reset-saga` | R2 DA2-B005 / IS2-B005 | fix | password mapping確認とone-time consumeを単一sagaで保証する | 1 |
| `identity/deletion-resume-minimize` | R2 IS2-B006 | fix | User Data削除後も再開し、locator/PII履歴を消去する | 0 |
| `identity/rpc-version-validation-retry` | R2 DA2-B006 / IS2-B009 | fix | legacy shapeを除去しplatform failureもtyped retryする | 1 |
| `identity/domain-authority-model` | R2 DA2-B007/W003/W004 | fix | specと本番不変条件をlogical credential modelへ統一する | 0 |
| `identity/digest-and-input-bounds` | R2 DA2-W001/W005 / IS2-W001/W006 | fix | SHA-256とbounded VOを全identity境界へ適用する | 0 |
| `identity/cross-generation-security` | R2 IS2-W002/W003 | fix | hash/epoch不一致をfail closedにし同一work profileを検証する | 0 |
| `identity/secret-operator-response` | R2 IS2-W004/W005 | fix | secret型/formatとoperator no-storeを固定する | 0 |
| `identity/runtime-routing-contract` | R2 DA2-W002/W003 / TS2-W005 | fix | composition配置とcanonical user routerの実装/実行テストを揃える | 0 |
| `identity/fault-matrix` | R2 IS2-W007 / TS2-B002 | fix | 全sagaのRPC前後fault/reconcileを公開portから検証する | 1 |
| `infra/ci-offline-render` | R2 INFRA-B001 / TS2-B001 | fix | PR dry-runをPulumi Service認証から切り離してCIをgreenにする | 1 |
| `jobs/overdue-alarm` | R2 INFRA-B002 / SDJ-B006 | fix | due Alarmを通常RPCで未来へ上書きしない | 1 |
| `identity/operator-maintenance` | R2 INFRA-B003 / IS2-B008 | fix | rotation/reconcileをcheckpointから再開できるoperatorへ接続する | 1 |
| `infra/pitr-target-protocol` | R2 INFRA-B004 / IS2-B007 / TS2-B005 | fix | restore対象とauthorityを結び、適用後照合/undoを実行可能にする | 1 |
| `infra/migration-real-upgrade` | R2 INFRA-W001 / TS2-W001 | fix | v1 fixtureからlazy upgrade/restart/rollbackを検証する | 0 |
| `infra/state-secret-type-isolation` | R2 INFRA-W003 / TS2-W004 | fix | state Env型とartifact監査でrequest secret非参照を保証する | 0 |
| `infra/shared-zone-ownership` | R2 INFRA-W004 | fix | stage stackのDNS zone二重所有を廃止する | 0 |
| `infra/ignored-legacy-root` | R2 INFRA-W005 | fix | ignored legacy directoryもfilesystem監査対象にする | 0 |
| `search/sql-bind-limits` | R2 SDJ-B001 | fix | 100 binding上限からbatch sizeを導出し境界テストする | 0 |
| `search/topic-trash-semantics` | R2 SDJ-B002 | fix | topic集合trash/restoreとtrash済みhard-delete制約を実装する | 0 |
| `search/rpc-schema-no-legacy` | R2 SDJ-B003 / TS2-B008 | fix | exhaustive versioned schemaへ統一しlegacy検索APIを除去する | 0 |
| `search/source-active-integrity` | R2 SDJ-B004 | fix | active topicを含む双方向sourceとkind/FK不変条件を守る | 0 |
| `search/snapshot-quota` | R2 SDJ-B005 | fix | snapshotの作成条件・個数・item/byte上限を設ける | 0 |
| `jobs/terminal-retention` | R2 SDJ-W001 | fix | 最終terminal rowもalarmで自動pruneする | 0 |
| `search/dynamic-retention` | R2 SDJ-W002 | fix | 設定変更を既存trash期限とalarmへ反映する | 0 |
| `search/secure-digest` | R2 SDJ-W003 | fix | semantic/job digestをSHA-256またはcanonical比較へ変える | 0 |
| `search/snippet-grapheme` | R2 SDJ-W004 | fix | 結合文字を含むNFKC原文位置対応を保証する | 0 |
| `search/cursor-limit` | R2 SDJ-W005 | fix | cursorへpage sizeを拘束する | 0 |
| `tests/production-request-boundary` | R2 TS2-B003 | fix | test専用再実装でなく本番action/middleware/routingを通す | 0 |
| `tests/alarm-fault-matrix` | R2 TS2-B004 / INFRA-W002 | fix | 実alarmのfailure/reclaim/retry/poison/restartを検証する | 0 |
| `tests/search-full-lifecycle` | R2 TS2-B006/W003 | fix | document/topic/順位/UTF-8/cursor容量の全契約を自動化する | 0 |
| `tests/executable-traceability` | R2 TS2-B007 | fix | evidence実在・test名・suite includeまで監査する | 0 |
| `tests/lifecycle-ci-results` | R2 TS2-W002/W006 | fix | CLIをCI実行しcommit SHA付き実績を記録する | 0 |

## Round 3

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `identity/domain-model-authority` | R3 DA3-B001/W002 | fix | 旧Userを除去し完全なAccountIdentity/Profile/Settingsへ統一する | 1 |
| `identity/physical-routing-encapsulation` | R3 DA3-B002 | fix | generation/bucket/checkpointをapplication contractからadapterへ戻す | 0 |
| `identity/fresh-retry-stability` | R3 IS3-B001 | fix | request時刻/hashが変わる再送でも初回stateを再利用する | 0 |
| `identity/concurrent-create-compensation` | R3 DA3-B003 / IS3-B002 | fix | password/SSO同時初回の敗者を非PII tombstoneへ収束する | 0 |
| `identity/reconciler-initialization-probe` | R3 IS3-B003 / INFRA3-B005 | fix | User Data状態を見て自動Alarm jobからactivate/回収を決める | 0 |
| `identity/rotation-dual-write-conflict` | R3 IS3-B004 / INFRA3-B004 | fix | dual-write済みlocatorを冪等移送し未解決時checkpointを完了しない | 0 |
| `identity/password-change-reset-request` | R3 DA3-B004 / IS3-B006 | fix | change sagaと列挙耐性reset request/mail job契約を実装する | 0 |
| `identity/rpc-runtime-schema` | R3 IS3-B007 | fix | 全methodのbounds/enum/transition/unknown fieldをfail closedにする | 0 |
| `identity/delete-eviction-resume` | R3 IS3-B008 | fix | 空再構築DOでも同operation deleteを再開可能にする | 0 |
| `identity/activate-fault-points` | R3 DA3-B007 | fix | initialized後と各generation activate後を実注入点で検証する | 0 |
| `identity/userdata-versioned-rpc` | R3 DA3-B008 | fix | initialize/profile/deleteを共通versioned envelopeとDO冪等性へ統一する | 0 |
| `identity/fault-hook-isolation` | R3 DA3-W001 | fix | production APIからtest-only fault hookを除く | 0 |
| `search/application-capability-contract` | R3 DA3-B005 | fix | transport DTOとdomain query、transaction-scoped projectionを分離する | 0 |
| `search/local-harness-production-isolation` | R3 DA3-B006 | fix | raw semantic commitをlocal専用DO class/artifactへ移す | 0 |
| `search/schema-history-occ-ai` | R3 SDJ3-B001 | fix | revision/OCC/connection provenanceをschemaとcontractへ実装する | 0 |
| `search/restore-revision-semantics` | R3 SDJ3-B002 | fix | restoreで内容を巻き戻さず新revisionを正しく記録する | 0 |
| `search/atomic-retention-enqueue` | R3 SDJ3-B003 | fix | trash stateとretention jobを同一transactionで確定する | 0 |
| `search/leased-retention-update` | R3 SDJ3-B004 | fix | leased job更新時もpurgeを失わず新期限へ再駆動する | 0 |
| `jobs/alarm-outer-reschedule` | R3 SDJ3-B005 | fix | claim/complete外の例外でも次Alarmをfinallyで復元する | 0 |
| `search/topic-bounded-work` | R3 SDJ3-B006 | fix | topic集合処理をbounded chunk/jobへ分割する | 0 |
| `search/bounded-candidate-materialization` | R3 SDJ3-B007 | fix | quota判定前の最大5001全文DTO materializeを避ける | 0 |
| `tests/search-fault-large-consumers` | R3 SDJ3-B008 / TS3-B008 | fix | fault/大規模/restart/UI-AI/順位/文字境界を実証する | 0 |
| `infra/pitr-proof-fail-closed` | R3 INFRA3-B002 / IS3-B005 | fix | restart例外、undo boundary、sentinel、conflict zeroを検証する | 0 |
| `infra/directory-target-allowlist` | R3 INFRA3-B003 / IS3-W001 | fix | destructive restore前にgeneration/bucketを厳密検証する | 0 |
| `infra/maintenance-input-and-secret-retirement` | R3 INFRA3-W001/W002 | fix | maintenance boundsとprevious secret削除/inventoryを固定する | 0 |
| `infra/shared-zone-preflight` | R3 INFRA3-W004 | fix | resources/routesのzone/account整合をrelease前検証する | 0 |
| `infra/release-aggregate-gate` | R3 INFRA3-W005 | fix | secret/config/PITR evidenceをcanonical release commandへ組み込む | 0 |
| `ci/web-tsx-dependency` | R3 INFRA3-B001 / TS3-B001 | fix | web packageへtsxを直接宣言してclean CIをgreenにする | 0 |
| `tests/production-entry-boundary` | R3 TS3-B002 / IS3-W002 | fix | test再実装でなく本番entry/action/epoch guardを通す | 1 |
| `tests/semantic-traceability` | R3 TS3-B003 | fix | test名存在だけでなく目的/tag/resultまで検証する | 1 |
| `tests/identity-concurrency-enumeration` | R3 TS3-B004 | fix | 同時初回と列挙耐性work profileを公開境界で実証する | 0 |
| `tests/alarm-self-recovery` | R3 TS3-B005 | fix | test側補助なしでalarmが自己再設定することを証明する | 0 |
| `tests/lazy-migration-fixtures` | R3 TS3-B006 | fix | 3 classの旧schemaから通常RPC/eviction経由でupgradeする | 1 |
| `tests/pitr-realistic-failure` | R3 TS3-B007 | fix | restart未到達/conflictとstaging pendingを正確に記録する | 0 |
| `tests/committed-ci-evidence` | R3 INFRA3-W003 / TS3-B001 | fix | committed SHA/Actions URLとworking tree結果を分離する | 0 |

## Round 4

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `identity/opaque-logical-authority` | R4 IDDA4-B001 | fix | generation/bucket/opaqueKeyをadapter内部へ閉じる | 1 |
| `identity/domain-runtime-authority` | R4 IDDA4-B002 | fix | active aggregateのprimary email/credential/epochを必須化し全sagaで使う | 1 |
| `identity/executable-reset-mail` | R4 IDDA4-B003 | fix | secret生成・暗号化delivery・lease/retry/poison Alarmを実装する | 0 |
| `identity/credential-pii-encryption` | R4 IDDA4-B004 | fix | canonical/operation PIIを暗号化しTTL/削除する | 0 |
| `identity/deterministic-create-winner` | R4 IDDA4-B005 | fix | password/SSO同時初回を最小operation IDへ収束する | 0 |
| `identity/enumeration-work-profile` | R4 IDDA4-W001 / IT4-B005 | fix | 4失敗分岐のverify/authority/log profileを一致させる | 1 |
| `identity/no-production-fault-hook` | R4 IDDA4-W002 | fix | production classからhook/factoryを完全除去する | 1 |
| `search/real-semantic-capability` | R4 SDJ4-B001 | fix | prepared commandと必須repository/projection callbackへ再構成する | 1 |
| `search/mandatory-occ-topic-version` | R4 SDJ4-B002 | fix | create以外のexpectedVersionとtopic配下versionをCASする | 0 |
| `search/orphan-document-restore` | R4 SDJ4-B003 | fix | 親削除後もdestination topicへatomic restoreする | 0 |
| `search/ai-history-provenance` | R4 SDJ4-B004 | fix | AI connection移行とrevision actor provenanceを完全化する | 1 |
| `tests/search-meaningful-fault-consumers` | R4 SDJ4-B005 | fix | rollback/UI-AI/Alarm testsを別consumer/実fail pointへ直す | 1 |
| `infra/pitr-cli-roundtrip` | R4 IT4-B001 | fix | restore stdoutを無加工でundo可能にする | 0 |
| `infra/pitr-dual-class-evidence` | R4 IT4-B002 | fix | 両class receipt/commit/run/TTL証跡をgateへ要求する | 0 |
| `identity/rotation-zero-reference` | R4 IT4-B003 | fix | active旧世代参照を両側集計しzeroまでsecret削除を拒否する | 1 |
| `tests/production-entry-acceptance` | R4 IT4-B004 | fix | production bundle/defaultEntry/server-fnを実HTTPで通す | 2 |
| `tests/non-self-attested-traceability` | R4 IT4-B006 | fix | HEAD/Actions/reporter artifactへ証跡を結び付ける | 2 |
| `identity/reconcile-backoff-poison` | R4 IT4-W001 | fix | 未分類stateのhot loopをbackoff/poisonへする | 0 |
| `tests/current-user-partial-failure` | R4 IT4-W002 | fix | Account Home/User Data各unavailableをretryable errorにする | 0 |
| `tests/rpc-compatibility-window` | R4 IT4-W003 | fix | state先行/新request/rollback組合せを検証する | 0 |
