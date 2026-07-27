# Inventory — adapter

Issue #19後のactive adapter inventory。本番providerはCloudflareだけとし、request Workerとstate/DO Workerの2 script、3 SQLite-backed Durable Object classで構成する。

## Worker / routing

| ID | 実装要素 | 契約 |
|---|---|---|
| ADP-CF-001 | request Worker entry | session/token検証、transport validation、canonical userId/credential locator routing、error envelope |
| ADP-CF-002 | state Worker entry | 3 DO class export。request secretを受け取らない |
| ADP-CF-003 | AuthenticatedUserDataRouter | 認証済みuserIdだけからUser Data DOを選び、公開入力にpartition指定を持たせない |
| ADP-CF-004 | Directory locator router | versioned HMAC active/previous keyring、固定bucket、checkpoint。PIIをobject name/logへ出さない |
| ADP-CF-005 | primitive RPC codec | versioned DTOとserialized success/error envelope。mutationはoperationId必須 |

## User Data DO

| ID | 実装要素 | 契約 |
|---|---|---|
| ADP-UD-001 | schema migration | profile/settings/AI connection/memo/document/topic/revision/source/trash/FTS/idempotency/jobをforward-only lazy migration |
| ADP-UD-002 | semantic commit | `transactionSync`内で本体repositoryとtransaction-scoped projectionをatomic commit |
| ADP-UD-003 | FTS5 query | trigram、短語fallback、NFKC、UTF-8 50-byte guard、bm25、snippet、snapshot pagination |
| ADP-UD-004 | source/topic projection | optional単一topic、active source link、archived/trashed状態をDTOへ射影 |
| ADP-UD-005 | command harness | memo/document create/update/remove/restoreをlocal workerd/CLIから検証。本番route非公開 |
| ADP-UD-006 | job repository | lease/reclaim、owner CAS、attempt、nextRunAt、provider idempotency、poison |
| ADP-UD-007 | Alarm runner | job commit後に最早alarm設定。設定失敗後は次input gateで再計算 |
| ADP-UD-008 | capacity guards | SQL parameter/batch/CPU/query byte上限と`StorageCapacityExceeded`変換 |

## Identity Directory DO

| ID | 実装要素 | 契約 |
|---|---|---|
| ADP-ID-001 | schema migration | mapping/reservation/reconcile/idempotency/rotation checkpoint |
| ADP-ID-002 | credential lookup/reserve | email/SSOの一意・冪等lookup/create、同時初回、provider境界 |
| ADP-ID-003 | key rotation | active/previous lookup、全固定bucket checkpoint scan、reverse locator同期 |
| ADP-ID-004 | reconciler | Account Home operation/epochとUser Data初期化状態を照合し、fault pointから再開 |

## Account Home DO

| ID | 実装要素 | 契約 |
|---|---|---|
| ADP-AH-001 | schema migration | account summary/credential reverse locator/identity operation/deletion tombstone |
| ADP-AH-002 | saga coordinator | signup/change/reset/link/unlink/deleteをstable operationId/epochで再開 |
| ADP-AH-003 | current-user summary | primary email/auth summaryのみ。User Data Profile/Settingsとrequest Workerが合成 |
| ADP-AH-004 | restore guard | operator toolingでAccount Home class/namespaceのrestore指定を拒否 |

## 外部adapter

| ID | 実装要素 | 契約 |
|---|---|---|
| ADP-EXT-001 | PasswordHasher | hash/verify/dummyVerify。login列挙耐性 |
| ADP-EXT-002 | SessionCodec | request Worker secretだけを利用し、state Workerへ配布しない |
| ADP-EXT-003 | Mail provider | Alarm jobからprovider idempotency key付きで実行 |
| ADP-EXT-004 | PITR admin wrapper | User Data/Identity Directoryのみ許可。前後で現行Account Home epoch照合 |

## 削除対象

Cloudflare以外のruntime entry/DI/adapter/infra、共有DB用adapter、外部検索provider、非同期イベント配送workerはactive inventoryに含めない。
