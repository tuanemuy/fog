# Inventory — adapter

生成元: spec/database/ + spec/domains/（ポート定義）（最終同期: 2026-07-25）

## スキーマ / マイグレーション（テーブルごと）

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-users-001 | schema: users | spec/database/index.md#users | 認証方式の直和（password/sso）を判別タグ + nullable カラム + テーブル CHECK で表現し、`users_email_uq`（UNIQUE email）と部分一意 `users_sso_identity_uq`（sso_provider, sso_provider_subject WHERE sso_provider IS NOT NULL）を持つ |
| ADP-password-reset-tokens-001 | schema: password_reset_tokens | spec/database/index.md#password_reset_tokens | 生トークンではなく token_hash（UNIQUE）を保存し、version なし・`prt_user_idx` / `prt_expires_idx` を備える |
| ADP-ai-client-connections-001 | schema: ai_client_connections | spec/database/index.md#ai_client_connections | active/revoked の直和 CHECK（revoked のときのみ revoked_at 非 NULL）と `acc_user_connected_idx`（user_id, connected_at DESC）を持つ |
| ADP-memos-001 | schema: memos | spec/database/index.md#memos | active/trashed の直和 CHECK と部分インデックス `memos_timeline_idx`（user_id, posted_at DESC, id DESC WHERE active）/ `memos_trash_idx` / `memos_expired_idx` を持つ |
| ADP-memo-revisions-001 | schema: memo_revisions | spec/database/index.md#memo_revisions | 複合 PK (memo_id, revision_number)・Actor の直和 CHECK（user/ai_client）・FK ON DELETE CASCADE を持ち、actor_client_name を表示用スナップショットとして保存する |
| ADP-topics-001 | schema: topics | spec/database/index.md#topics | active/archived/trashed の直和 CHECK（trashed のときのみ trashed_at と was_archived 非 NULL）と `topics_user_live_idx` / `topics_trash_idx` / `topics_expired_idx` を持つ |
| ADP-documents-001 | schema: documents | spec/database/index.md#documents | 直和 CHECK + `trashed_with IS NULL OR trashed_with = topic_id` の CHECK を持ち、topic_id には意図的に FK を張らず（ADR-001）、`docs_topic_active_idx` 等 5 インデックスを備える |
| ADP-document-revisions-001 | schema: document_revisions | spec/database/index.md#document_revisions | 独立 TEXT PK + UNIQUE (document_id, revision_number)（`doc_revs_doc_rev_uq`）・Actor 直和 CHECK・change_reason NOT NULL・FK ON DELETE CASCADE を持つ |
| ADP-source-links-001 | schema: source_links | spec/database/index.md#source_links | 複合 PK (document_id, memo_id)・双方向 FK ON DELETE CASCADE（defense-in-depth）・`source_links_memo_idx` を持ち、user_id カラムは持たない（JOIN でスコープ） |
| ADP-outbox-001 | schema: outbox | spec/database/index.md#outbox--processed_events--_occ_guard共通基盤 | テンプレート流儀のイベント行（payload は対象 ID のみ）+ claimPending 用部分インデックス（processed_at IS NULL AND failed_at IS NULL）を持つ |
| ADP-processed-events-001 | schema: processed_events | spec/database/index.md#outbox--processed_events--_occ_guard共通基盤 | consumer の event.id ベース冪等化（INSERT OR IGNORE で claim）用テーブルをテンプレート流儀で持つ |
| ADP-occ-guard-001 | schema: _occ_guard | spec/database/index.md#outbox--processed_events--_occ_guard共通基盤 | D1 の PendingBatch 方式で OCC 不一致時に CHECK 違反でバッチ全体を abort するガードテーブルを全ランタイム共通スキーマとして持つ |
| ADP-search-fts-001 | schema: search_fts | spec/database/index.md#検索インデックスの永続化アダプター実装詳細 | FTS5 仮想テーブル（type, entity_id/user_id/topic_id UNINDEXED, title, content）を SearchIndexPort アダプターのマイグレーションとして domain tables と別ファイルで管理し、upsert は delete + insert で冪等にする |
| ADP-search-embeddings-001 | schema: search_embeddings | spec/database/index.md#検索インデックスの永続化アダプター実装詳細 | PRIMARY KEY (type, entity_id) の埋め込みテーブル（F32_BLOB。libSQL/Turso のベクトル型）をアダプターのマイグレーションとして管理する（D1 は外部インデックス差し替えで本テーブルを持たない） |

## identity ポート実装

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-identity-001 | UserRepository.insert | spec/domains/identity.md#userrepository | users へ初回挿入。email 一意制約違反は `ConflictError("EMAIL_ALREADY_REGISTERED")`、SSO 主体一意制約違反は `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` に翻訳する |
| ADP-identity-002 | UserRepository.save | spec/domains/identity.md#userrepository | `WHERE id = ? AND version = ?` の条件付き更新で、0 行更新を `ConflictError("OPTIMISTIC_LOCK_FAILURE")` にマップする |
| ADP-identity-003 | UserRepository.findById | spec/domains/identity.md#userrepository | 信頼済み ID の PK 引き。auth_method で判別して PasswordUser/SsoUser に再水和し、該当なしは null、不整合行は `SystemError(DataIntegrityError)` |
| ADP-identity-004 | UserRepository.findByEmail | spec/domains/identity.md#userrepository | 正規化済み email で `users_email_uq` を引き、`Versioned<User>` または null を返す |
| ADP-identity-005 | UserRepository.findBySsoIdentity | spec/domains/identity.md#userrepository | (provider, providerSubject) で部分一意インデックスを引き、`Versioned<SsoUser>` または null を返す |
| ADP-identity-006 | AiClientConnectionRepository.insert | spec/domains/identity.md#aiclientconnectionrepository | ActiveAiClientConnection を ai_client_connections へ初回挿入し、DB 例外は `SystemError(DatabaseError)` に翻訳する |
| ADP-identity-007 | AiClientConnectionRepository.save | spec/domains/identity.md#aiclientconnectionrepository | OCC 条件付き更新。0 行更新は `ConflictError("OPTIMISTIC_LOCK_FAILURE")`（二重解除操作等） |
| ADP-identity-008 | AiClientConnectionRepository.findById | spec/domains/identity.md#aiclientconnectionrepository | PK 引き + `user_id = ?` スコープ。他ユーザー所有・不在は区別せず null（テナント分離） |
| ADP-identity-009 | AiClientConnectionRepository.listByUserId | spec/domains/identity.md#aiclientconnectionrepository | `acc_user_connected_idx` で userId の接続一覧を connectedAt 降順で返す |
| ADP-identity-010 | AiClientConnectionRepository.findActiveById | spec/domains/identity.md#aiclientconnectionrepository | 認可ミドルウェア専用の PK 引き + `status = 'active'` 条件。失効済み・不在は区別せず null |
| ADP-identity-011 | AiClientConnectionRepository.recordUsage | spec/domains/identity.md#aiclientconnectionrepository | `UPDATE ... SET last_used_at = ? WHERE id = ? AND status = 'active'` の単独文（version 不変・後勝ち）。失敗時も throw せずログのみ |
| ADP-identity-012 | PasswordHasher.hash | spec/domains/identity.md#passwordhasher | PlainPassword を Argon2id 等でハッシュ化して PasswordHash を返す。計算失敗は `SystemError` |
| ADP-identity-013 | PasswordHasher.verify | spec/domains/identity.md#passwordhasher | タイミングセーフに照合し、不一致はエラーでなく false を返す |
| ADP-identity-014 | PasswordResetTokenPort.issue | spec/domains/identity.md#passwordresettokenport | トークンを発行し、生トークンではなくハッシュを `expires_at = now + TTL` とともに password_reset_tokens に保存して生トークンを返す |
| ADP-identity-015 | PasswordResetTokenPort.verifyAndConsume | spec/domains/identity.md#passwordresettokenport | token_hash 一致・未使用・未失効の行を条件付き UPDATE（used_at = now）で消費して UserId を返し、0 行更新（無効・期限切れ・使用済み・並行消費の敗者）は null |
| ADP-identity-016 | MailSender.sendPasswordResetMail | spec/domains/identity.md#mailsender | リセットリンク（トークン込み URL の組み立て含む）をメール送信する。送信基盤の失敗は `SystemError` |

## memo ポート実装

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-memo-001 | MemoRepository.insert | spec/domains/memo.md#memorepository | ActiveMemo（version 0）を memos へ初回挿入。PK 重複・DB 障害は `SystemError(DatabaseError)` |
| ADP-memo-002 | MemoRepository.insertRevision | spec/domains/memo.md#memorepository | memo_revisions へ追記のみ。(memo_id, revision_number) 一意制約違反（線形性の最終防衛線）・DB 障害は `SystemError(DatabaseError)` |
| ADP-memo-003 | MemoRepository.save | spec/domains/memo.md#memorepository | active/trashed 問わず OCC 条件付き上書き。0 行更新は `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ADP-memo-004 | MemoRepository.hardDelete | spec/domains/memo.md#memorepository | メモ本体と全リビジョンを同一 UoW で物理削除。version 不一致は `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ADP-memo-005 | MemoRepository.findById | spec/domains/memo.md#memorepository | userId スコープで active のみ返す。trashed・他ユーザー所有は null |
| ADP-memo-006 | MemoRepository.findByIdIncludingTrashed | spec/domains/memo.md#memorepository | userId スコープで状態を問わず `Versioned<Memo>` を返す。他ユーザー所有は null |
| ADP-memo-007 | MemoRepository.listByIdsIncludingTrashed | spec/domains/memo.md#memorepository | ID 群を userId スコープで trashed 含め一括取得。不在・他ユーザー所有 ID は結果に含めない |
| ADP-memo-008 | MemoRepository.listActiveByIds | spec/domains/memo.md#memorepository | ID 群を userId スコープで active のみ `Versioned` 付き一括取得。trashed・不在・他ユーザー所有は区別せず結果から除外 |
| ADP-memo-009 | MemoRepository.findTimelinePage | spec/domains/memo.md#memorepository | `memos_timeline_idx` の (posted_at, id) 行値比較による双方向カーソルページング。items は常に postedAt 降順、keyword は範囲内 LIKE、デコード不能カーソルは `ValidationError` |
| ADP-memo-010 | MemoRepository.findTimelineAround | spec/domains/memo.md#memorepository | 日付 / メモアンカーの位置を含む前後ページと olderCursor/newerCursor を返す。0 件・アンカー不在は空結果 |
| ADP-memo-011 | MemoRepository.listRevisions | spec/domains/memo.md#memorepository | userId スコープで全リビジョンを revisionNumber 昇順で返す。メモ不存在・他ユーザー所有は空配列 |
| ADP-memo-012 | MemoRepository.findRevision | spec/domains/memo.md#memorepository | userId スコープの単一リビジョン取得。なければ（他ユーザー所有含め）null |
| ADP-memo-013 | MemoRepository.listTrashed | spec/domains/memo.md#memorepository | trashed メモを trashedAt 降順で `Versioned` 付きで返す（TrashQueryPort アダプターの UNION 枝専用） |

## knowledge ポート実装

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-knowledge-001 | TopicRepository.insert | spec/domains/knowledge.md#topicrepository | ActiveTopic を topics へ初回挿入。DB 例外は `SystemError(DatabaseError)` |
| ADP-knowledge-002 | TopicRepository.save | spec/domains/knowledge.md#topicrepository | OCC 条件付き更新。0 行更新は `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ADP-knowledge-003 | TopicRepository.delete | spec/domains/knowledge.md#topicrepository | OCC 付きハードデリート。同一バッチで行を消し、0 行更新は Conflict |
| ADP-knowledge-004 | TopicRepository.findById | spec/domains/knowledge.md#topicrepository | userId スコープで LiveTopic（active/archived）のみ返す。trashed・他ユーザー所有は null |
| ADP-knowledge-005 | TopicRepository.findByIdIncludingTrashed | spec/domains/knowledge.md#topicrepository | userId スコープで全状態の `Versioned<Topic>` を返す。他ユーザー所有は null |
| ADP-knowledge-006 | TopicRepository.listByUser | spec/domains/knowledge.md#topicrepository | ゴミ箱外トピック一覧を includeArchived に応じて名前順等の安定順序で返す（`topics_user_live_idx`） |
| ADP-knowledge-007 | TopicRepository.listTrashedByUser | spec/domains/knowledge.md#topicrepository | ゴミ箱内トピックを `Versioned` 付きで返す（TrashQueryPort アダプターの UNION 枝専用） |
| ADP-knowledge-008 | TopicRepository.listByIds | spec/domains/knowledge.md#topicrepository | ID 群を userId スコープで一括取得（検索結果のトピック名解決を 1 クエリで）。不在・他ユーザー所有は結果に含めない |
| ADP-knowledge-009 | DocumentRepository.insert | spec/domains/knowledge.md#documentrepository | ActiveDocument を documents へ初回挿入。DB 例外は `SystemError(DatabaseError)` |
| ADP-knowledge-010 | DocumentRepository.save | spec/domains/knowledge.md#documentrepository | OCC 条件付き更新。0 行更新は `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ADP-knowledge-011 | DocumentRepository.delete | spec/domains/knowledge.md#documentrepository | OCC 付きハードデリートで、同一バッチで全リビジョンと documentId 側の全出典リンクも明示消去する |
| ADP-knowledge-012 | DocumentRepository.findById | spec/domains/knowledge.md#documentrepository | userId スコープで active のみ返す。trashed・他ユーザー所有は null |
| ADP-knowledge-013 | DocumentRepository.findByIdIncludingTrashed | spec/domains/knowledge.md#documentrepository | userId スコープで全状態の `Versioned<Document>` を返す。他ユーザー所有は null |
| ADP-knowledge-014 | DocumentRepository.listByIdsIncludingTrashed | spec/domains/knowledge.md#documentrepository | ID 群を userId スコープで trashed 含め一括取得（出典表示用）。不在・他ユーザー所有は結果に含めない |
| ADP-knowledge-015 | DocumentRepository.listActiveByTopic | spec/domains/knowledge.md#documentrepository | トピック配下の active ドキュメントを `Versioned` 付きで返す（`docs_topic_active_idx`）。他ユーザー所有トピックは空配列 |
| ADP-knowledge-016 | DocumentRepository.listActiveByTopics | spec/domains/knowledge.md#documentrepository | 複数トピック配下の active ドキュメントを 1 クエリで一括取得（N+1 回避）。他ユーザー所有分は含めない |
| ADP-knowledge-017 | DocumentRepository.listTrashedByTopic | spec/domains/knowledge.md#documentrepository | トピック配下のゴミ箱内ドキュメントを `Versioned` 付きで返す（`docs_topic_trashed_idx`。セット復元・ハードデリート対象確定用） |
| ADP-knowledge-018 | DocumentRepository.listTrashedByUser | spec/domains/knowledge.md#documentrepository | ゴミ箱内ドキュメントを `Versioned` 付きで返す（TrashQueryPort アダプターの UNION 枝専用） |
| ADP-knowledge-019 | DocumentRepository.insertRevision | spec/domains/knowledge.md#documentrepository | document_revisions へ追記のみ。(document_id, revision_number) 一意制約違反は `ConflictError` に翻訳する |
| ADP-knowledge-020 | DocumentRepository.listRevisions | spec/domains/knowledge.md#documentrepository | userId スコープでリビジョン履歴を revisionNumber 昇順で返す。他ユーザーのドキュメントは空配列 |
| ADP-knowledge-021 | DocumentRepository.findRevision | spec/domains/knowledge.md#documentrepository | userId スコープの特定リビジョン取得。他ユーザーのドキュメントのリビジョンは null |
| ADP-knowledge-022 | DocumentRepository.insertSourceLinks | spec/domains/knowledge.md#documentrepository | SourceLink 群を source_links へ一括登録（Document.create と同一 UoW）。複合 PK が重複を排除する |
| ADP-knowledge-023 | DocumentRepository.listSourceLinksByDocument | spec/domains/knowledge.md#documentrepository | documentId → 出典リンク一覧を PK 前方一致 + documents JOIN の userId スコープで返す |
| ADP-knowledge-024 | DocumentRepository.listSourceLinksByDocuments | spec/domains/knowledge.md#documentrepository | documentId 群 → 出典リンクを 1 クエリで一括逆引き（N+1 回避）。他ユーザー所有分は含めない |
| ADP-knowledge-025 | DocumentRepository.listSourceLinksByMemo | spec/domains/knowledge.md#documentrepository | memoId → 参照元リンク一覧を `source_links_memo_idx` + userId スコープで返す |
| ADP-knowledge-026 | DocumentRepository.listSourceLinksByMemos | spec/domains/knowledge.md#documentrepository | memoId 群 → 参照元リンクを 1 クエリで一括逆引き（タイムライン 1 ページ分）。他ユーザー所有分は含めない |
| ADP-knowledge-027 | DocumentRepository.deleteSourceLinksByMemo | spec/domains/knowledge.md#documentrepository | memoId 側リンクの冪等消去。userId スコープは **documents 側 JOIN**（`document_id IN (SELECT id FROM documents WHERE user_id = ?)`）で行う（memos 側 JOIN は同一 UoW 内でメモ削除済みのため 0 行更新となり禁止。spec/database/index.md#source_links） |

## search ポート実装

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-search-001 | SearchIndexPort.query | spec/domains/search.md#searchindexport | キーワード + ベクトルを RRF 等で統合した単一結果を関連度順で返し、userId 境界・ゴミ箱除外・topicId スコープ絞り込み・事実データのみの規則を満たす。0 件は空 `PaginationResult` |
| ADP-search-002 | SearchIndexPort.upsertMemo | spec/domains/search.md#searchindexport | MemoIndexEntry を埋め込み再生成込みで冪等 upsert（delete + insert）。失敗は `SystemError(SearchIndexUnavailable / EmbeddingFailed)` で retryable |
| ADP-search-003 | SearchIndexPort.upsertDocument | spec/domains/search.md#searchindexport | DocumentIndexEntry について upsertMemo と同じ冪等 upsert 契約を満たす |
| ADP-search-004 | SearchIndexPort.removeMemo | spec/domains/search.md#searchindexport | メモをインデックスから除去する。存在しない ID でもエラーにせず成功（冪等） |
| ADP-search-005 | SearchIndexPort.removeDocument | spec/domains/search.md#searchindexport | ドキュメントについて removeMemo と同じ冪等 remove 契約を満たす |
| ADP-search-006 | IndexerReadPort.findMemoById | spec/domains/search.md#indexerreadport | userId スコープなし（信頼済み内部 ID）で active メモのみ返す。trashed・不在は null（remove 判断用） |
| ADP-search-007 | IndexerReadPort.findDocumentById | spec/domains/search.md#indexerreadport | active ドキュメントのみ返す。trashed・不在は null |
| ADP-search-008 | IndexerReadPort.listSourceLinksByMemo | spec/domains/search.md#indexerreadport | memoId を出典とする SourceLink をスコープなしで返す（ファンアウト逆引き用）。なければ空配列 |
| ADP-search-009 | IndexerReadPort.listSourceLinksByDocument | spec/domains/search.md#indexerreadport | documentId の SourceLink をスコープなしで返す（ファンアウト逆引き用）。なければ空配列 |

## trash ポート実装

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-trash-001 | TrashQueryPort.listTrashItems | spec/domains/trash.md#trashqueryport | memo/document/topic の trashed 行を UNION 射影し、削除日時降順ページングで返す。expiresAt は `RetentionPolicy.expiresAt` で算出付与し、topic 項目の setDocumentIds を trashed_with から埋める |
| ADP-trash-002 | TrashQueryPort.findTrashItem | spec/domains/trash.md#trashqueryport | TrashItemRef で単一項目を listTrashItems と同じ射影契約（expiresAt 算出・setDocumentIds 付与）で取得し、ゴミ箱にない場合は null |
| ADP-trash-003 | TrashQueryPort.countTrashItems | spec/domains/trash.md#trashqueryport | ユーザーのゴミ箱総件数を返す（「空にする」の件数確認用） |
| ADP-trash-004 | TrashQueryPort.listExpiredItems | spec/domains/trash.md#trashqueryport | 全ユーザー横断で users と JOIN し `trashed_at + retention_days * 86400000 < now` を評価（`RetentionPolicy.isExpired` と一致必須）して userId 付き期限切れ項目を limit 件まで返す |

## export ポート実装

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| ADP-export-001 | ExportSourceReader.readAll | spec/domains/export.md#exportsourcereader | 対象ユーザーの全メモ・トピック・ドキュメントをゴミ箱除外・最新リビジョンのみで単一トランザクション（スナップショット読み）で読み出し、sourceMemoIds にハードデリート済みメモ ID を含めない |
| ADP-export-002 | ArchiveWriter.write | spec/domains/export.md#archivewriter | ExportArchive を `rootDirName/` 配下に格納した zip にエンコードして `{rootDirName}.zip` の ArchiveBinary を返す。失敗は `SystemError(ArchiveEncodingError)` |
