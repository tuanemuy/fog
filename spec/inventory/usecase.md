# Inventory — usecase

## Issue #19で公開接続するidentity

| ID | Usecase | 契約 |
|---|---|---|
| UC-ID-001 | registerWithPassword | operationId付きsignup saga、Directory reservation、User Data初期化、Account Home確定 |
| UC-ID-002 | loginWithPassword | active/previous lookup、dummy verify、同一public error、epoch検証 |
| UC-ID-003 | getCurrentUser | Account Home auth summaryとUser Data Profile/Settingsを合成 |
| UC-ID-004 | logout | presentationのsession破棄 |

## 将来機能向けprimitive

| ID | Primitive | 契約 |
|---|---|---|
| UC-ID-P01 | lookupOrCreateSso | 初回/再送/同時初回/email競合/provider境界/rotation |
| UC-ID-P02 | passwordChange | new hash、credential更新、session epoch。UIは#11 |
| UC-ID-P03 | passwordReset | enumeration-safe request、one-time token、mail Alarm。UIは#12 |
| UC-ID-P04 | link/unlink | last credential/primary email不変条件、session epoch。UIは#12 |
| UC-ID-P05 | deleteAccount | tombstone/epoch→locator→User Data→purgeの再開可能saga |
| UC-ID-P06 | exportUserData | ユーザー単位逐次export primitive。UIは#15 |

## memo / knowledge / trash

既存usecase名は維持するが、書き込みはUser Data DO内のtyped semantic commandとしてprepareし、本体、revision、source link、FTS5 projection、idempotency resultを同期commitする。

- memo: post/get timeline/jump/edit/history/diff/rollback/trash、AI post/update/recent/get/delete
- knowledge: topic create/update/list/get/trash、document create/edit/rollback/trash/get/history/source query
- trash: list/restore/hard delete/empty。retentionはAlarm job
- export: User Data DOからbounded batchで逐次stream

## search

| ID | Usecase | 契約 |
|---|---|---|
| UC-SEARCH-001 | search | 人間UI/AI共通のread-only FTS5 query |
| UC-SEARCH-002 | semantic command harness | memo/document create/update/remove/restoreとprojection atomicityのlocal-only検証 |

## Alarm

| ID | Usecase | 契約 |
|---|---|---|
| UC-JOB-001 | runDueJobs | lease claim、provider idempotency、owner CAS complete/retry/poison |
| UC-JOB-002 | reconcileIdentity | reservation/signup/delete等の途中phaseをoperation/epochから再開 |
| UC-JOB-003 | pruneExpiredTrash | bounded batchでhard deleteし、同transactionでFTS/sourceを同期更新 |
