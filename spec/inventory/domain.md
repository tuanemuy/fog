# Inventory — domain

## identity

| ID | 要素 | 契約 |
|---|---|---|
| DOM-ID-001 | AccountIdentity | primary email、active credential、session epochの業務不変条件 |
| DOM-ID-002 | Profile | User Data内の表示情報 |
| DOM-ID-003 | Settings | trashRetentionDays等のUser Data設定 |
| DOM-ID-004 | AiClientConnection | active/revokedの直和型 |
| DOM-ID-005 | UserId/Email/Password/SSO VOs | 境界検証とillegal state排除 |
| DOM-ID-006 | credential invariants | 全shard一意、provider境界、last credential/primary email規則 |

## memo

| ID | 要素 | 契約 |
|---|---|---|
| DOM-MEMO-001 | Memo | active/trashed、body、postedAt、version |
| DOM-MEMO-002 | MemoRevision | 不変な全文snapshot、actor、連番 |
| DOM-MEMO-003 | memo lifecycle | create/edit/rollback/trash/restore/hard delete |

## knowledge

| ID | 要素 | 契約 |
|---|---|---|
| DOM-KNOW-001 | Topic | active/archived/trashedとset restore規則 |
| DOM-KNOW-002 | Document | topic必須、revision、source link、trash状態 |
| DOM-KNOW-003 | SourceLink | document→memoの参照。hard delete時に同期消去 |
| DOM-KNOW-004 | TopicTrashService | topicと配下documentのset trash/restore |

## search

| ID | 要素 | 契約 |
|---|---|---|
| DOM-SEARCH-001 | SearchQuery | NFKC、非空、UTF-8 50-byte、optional単一topic |
| DOM-SEARCH-002 | SearchResultItem | memo/document直和、snippet、topic/source fact DTO |
| DOM-SEARCH-003 | SearchIndexPort | read-only FTS5 query |
| DOM-SEARCH-004 | SearchProjectionPort | transaction-scoped upsert/remove。単独DI禁止 |
| DOM-SEARCH-005 | SemanticCommitPort | 本体+projectionの同期atomic commit |

## trash / export

| ID | 要素 | 契約 |
|---|---|---|
| DOM-TRASH-001 | TrashItem | memo/document/topicの横断view |
| DOM-TRASH-002 | RestorePolicy | 単独/セット/復元先選択 |
| DOM-TRASH-003 | HardDeletePolicy | 人間のみ、revision/source含む完全削除 |
| DOM-TRASH-004 | RetentionPolicy | Alarm jobの期限判定 |
| DOM-EXPORT-001 | ExportBundle | ユーザー単位の逐次可搬形式出力 |
