# Inventory — domain

生成元: spec/domains/（最終同期: 2026-07-25）

## identity

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-identity-001 | User エンティティ | spec/domains/identity.md#User | PasswordUser / SsoUser の判別可能ユニオン。registerWithPassword / registerWithSso / changePassword（PasswordUser 限定）/ changeTrashRetentionDays を純関数ファクトリで提供し WithEventDrafts を返す |
| DOM-identity-002 | AiClientConnection エンティティ | spec/domains/identity.md#AiClientConnection | active / revoked の直和型（revokedAt は revoked のみ）。create / revoke（active のみ・不可逆）/ recordUsage（イベントなし・OCC 非対象）を提供する |
| DOM-identity-003 | UserId 値オブジェクト | spec/domains/identity.md#UserId | ブランド型。trim 後非空を create で検証し、違反は BusinessRuleError を throw する |
| DOM-identity-004 | AiClientConnectionId 値オブジェクト | spec/domains/identity.md#AiClientConnectionId | ブランド型。trim 後非空の不透明文字列として検証する |
| DOM-identity-005 | Email 値オブジェクト | spec/domains/identity.md#Email | trim・小文字化の正規化後にメール形式（local@domain、最大320文字）を検証。違反は InvalidEmail |
| DOM-identity-006 | PlainPassword 値オブジェクト | spec/domains/identity.md#PlainPassword | 8〜128文字を検証（違反は PasswordTooWeak）。ログ・イベント・永続化への漏出を防止する実装を持つ |
| DOM-identity-007 | PasswordHash 値オブジェクト | spec/domains/identity.md#PasswordHash | 非空のみ検証する不透明文字列。照合は文字列比較ではなく PasswordHasher.verify 経由に限定される |
| DOM-identity-008 | SsoProvider 値オブジェクト | spec/domains/identity.md#SsoProvider | "google" \| "apple" のリテラルユニオン。違反は UnsupportedSsoProvider |
| DOM-identity-009 | ClientName 値オブジェクト | spec/domains/identity.md#ClientName | trim 後非空・100文字以下を検証する |
| DOM-identity-010 | TrashRetentionDays 値オブジェクト | spec/domains/identity.md#TrashRetentionDays | 1以上の整数を検証（違反は InvalidTrashRetentionDays）。default() が 30 を返す。定義はここ一箇所のみ（trash 側に重複定義しない） |
| DOM-identity-011 | Actor 値オブジェクト | spec/domains/identity.md#Actor | UserActor / AiClientActor の直和型。Actor.user / Actor.aiClient ファクトリを提供し、AiClientActor は clientName をスナップショットとして持つ |
| DOM-identity-012 | TokenScope 値オブジェクト | spec/domains/identity.md#TokenScope | HumanScope / AiScope の直和型。AiPermission（read/write）⊂ HumanPermission（+hardDelete/trash/history）で、allows(scope, permission) が human 全許可・ai は AiPermission のみを返す |
| DOM-identity-013 | identity.userRegistered イベント | spec/domains/identity.md#ドメインイベント | registerWithPassword / registerWithSso から `{ userId, authMethod }` の識別子なしドラフトとして発行される |
| DOM-identity-014 | identity.passwordChanged イベント | spec/domains/identity.md#ドメインイベント | changePassword（リセット実行含む）から `{ userId }` で発行される |
| DOM-identity-015 | identity.trashRetentionChanged イベント | spec/domains/identity.md#ドメインイベント | changeTrashRetentionDays から `{ userId, retentionDays }` で発行される |
| DOM-identity-016 | identity.aiClientConnected イベント | spec/domains/identity.md#ドメインイベント | AiClientConnection.create から `{ connectionId, userId }` で発行される |
| DOM-identity-017 | identity.aiClientRevoked イベント | spec/domains/identity.md#ドメインイベント | AiClientConnection.revoke から `{ connectionId, userId }` で発行され、アダプター側トークン失効処理のトリガーとして購読可能 |
| DOM-identity-018 | UserRepository.insert | spec/domains/identity.md#UserRepository | 初回永続化。email / (provider, providerSubject) の一意制約違反を ConflictError("EMAIL_ALREADY_REGISTERED" / "SSO_IDENTITY_ALREADY_REGISTERED") にマップする |
| DOM-identity-019 | UserRepository.save | spec/domains/identity.md#UserRepository | ExpectedVersion による OCC 更新。不一致は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-identity-020 | UserRepository.findById | spec/domains/identity.md#UserRepository | 信頼済み ID による単体取得。Versioned<User> \| null を返す |
| DOM-identity-021 | UserRepository.findByEmail | spec/domains/identity.md#UserRepository | メールで検索（一意性検証・ログイン・リセット依頼用）。該当なしは null |
| DOM-identity-022 | UserRepository.findBySsoIdentity | spec/domains/identity.md#UserRepository | (provider, providerSubject) で SsoUser を検索。該当なしは null |
| DOM-identity-023 | AiClientConnectionRepository.insert | spec/domains/identity.md#AiClientConnectionRepository | ActiveAiClientConnection の初回永続化 |
| DOM-identity-024 | AiClientConnectionRepository.save | spec/domains/identity.md#AiClientConnectionRepository | OCC 更新。不一致は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-identity-025 | AiClientConnectionRepository.findById | spec/domains/identity.md#AiClientConnectionRepository | userId を第一引数に取り常に userId でスコープ。他ユーザー所有・不在は区別なく null（テナント分離） |
| DOM-identity-026 | AiClientConnectionRepository.listByUserId | spec/domains/identity.md#AiClientConnectionRepository | ユーザーの接続一覧を connectedAt 降順で返す |
| DOM-identity-027 | AiClientConnectionRepository.findActiveById | spec/domains/identity.md#AiClientConnectionRepository | 認可ミドルウェア専用。active のみ返し、失効済み・不在は区別なく null |
| DOM-identity-028 | AiClientConnectionRepository.recordUsage | spec/domains/identity.md#AiClientConnectionRepository | lastUsedAt のベストエフォート単独 UPDATE（version 不変・後勝ち）。失敗しても throw せずログのみ |
| DOM-identity-029 | PasswordHasher.hash | spec/domains/identity.md#PasswordHasher | PlainPassword → PasswordHash。アルゴリズムはアダプター責務、失敗は SystemError |
| DOM-identity-030 | PasswordHasher.verify | spec/domains/identity.md#PasswordHasher | タイミングセーフに照合し、不一致はエラーでなく false |
| DOM-identity-031 | PasswordResetTokenPort.issue | spec/domains/identity.md#PasswordResetTokenPort | now を起点にリセットトークン（不透明文字列）を発行する |
| DOM-identity-032 | PasswordResetTokenPort.verifyAndConsume | spec/domains/identity.md#PasswordResetTokenPort | 有効なら使い捨て消費して UserId を返す。無効・期限切れ・使用済みは null |
| DOM-identity-033 | MailSender.sendPasswordResetMail | spec/domains/identity.md#MailSender | リセットリンクメールを送る。宛先実在性起因の失敗をユーザー応答に反映しない |

## memo

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-memo-001 | Memo エンティティ（集約ルート） | spec/domains/memo.md#Memo（集約ルート） | active / trashed の直和型。create（初版リビジョン必須）/ edit（同一本文は no-op・newRevision null）/ rollback（同内容の新リビジョン）/ softDelete / restore を純関数で提供し、trashed への edit/rollback は型エラー。hardDelete はドメインに置かない |
| DOM-memo-002 | MemoRevision エンティティ | spec/domains/memo.md#MemoRevision | (memoId, revisionNumber) 複合キーの不変スナップショット。actor・全文 body・createdAt を持ち、変更理由は持たない。生成は Memo の振る舞い内部のみ（公開ファクトリなし） |
| DOM-memo-003 | MemoId 値オブジェクト | spec/domains/memo.md#MemoId | ブランド型。trim 後空なら BusinessRuleError(InvalidId) |
| DOM-memo-004 | MemoBody 値オブジェクト | spec/domains/memo.md#MemoBody | 非空（trim は空判定のみ、保存は入力そのまま。EmptyBody）・10,000 コードポイント上限（BodyTooLong）。equals で同一判定を提供する |
| DOM-memo-005 | RevisionNumber 値オブジェクト（memo） | spec/domains/memo.md#RevisionNumber | 1以上の整数（InvalidRevisionNumber）。first()=1 / next(n)=n+1 の補助ファクトリを持つ |
| DOM-memo-006 | TimelineCursor 値オブジェクト | spec/domains/memo.md#TimelineCursor | 非空の不透明トークン（InvalidCursor）。位置のみを表し方向を含まない |
| DOM-memo-007 | memo.created イベント | spec/domains/memo.md#ドメインイベント | Memo.create から発行。ペイロードは `{ memoId }` のみ（ADR-005） |
| DOM-memo-008 | memo.edited イベント | spec/domains/memo.md#ドメインイベント | Memo.edit / rollback から本文が変わった場合のみ発行（ロールバック専用イベントは設けない） |
| DOM-memo-009 | memo.trashed イベント | spec/domains/memo.md#ドメインイベント | Memo.softDelete から発行。search consumer のインデックス除去＋出典先ドキュメントのファンアウト再 upsert の契機 |
| DOM-memo-010 | memo.restored イベント | spec/domains/memo.md#ドメインイベント | Memo.restore から発行。インデックス再登録＋ファンアウトの契機 |
| DOM-memo-011 | memo.hardDeleted イベント | spec/domains/memo.md#ドメインイベント | trash のユースケースが直接発行（エンティティメソッドを経由しない） |
| DOM-memo-012 | memo.sourceLinksChanged イベント | spec/domains/memo.md#ドメインイベント | 参照先ドキュメントのハードデリートでリンクが消えたとき trash のユースケースが直接発行。ペイロードは対象 ID のみ |
| DOM-memo-013 | MemoRepository.insert | spec/domains/memo.md#MemoRepository | 初回永続化専用（version 0）。OCC トークン不要 |
| DOM-memo-014 | MemoRepository.insertRevision | spec/domains/memo.md#MemoRepository | リビジョン追記。本体の insert / save と同一 UoW で書き、(memoId, revisionNumber) 一意制約が線形性の最終防衛線 |
| DOM-memo-015 | MemoRepository.save | spec/domains/memo.md#MemoRepository | 状態を問わず ExpectedVersion 付き上書き。0 行更新は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-memo-016 | MemoRepository.hardDelete | spec/domains/memo.md#MemoRepository | メモ本体と全リビジョンを同一 UoW で物理削除（ExpectedVersion 必須） |
| DOM-memo-017 | MemoRepository.findById | spec/domains/memo.md#MemoRepository | userId スコープで active のみ返す。trashed・他ユーザー所有は null（AI からゴミ箱が「存在しない」の土台） |
| DOM-memo-018 | MemoRepository.findByIdIncludingTrashed | spec/domains/memo.md#MemoRepository | userId スコープで状態を問わず返す。人間 UI・trash 系専用（AI 向けでは使わない） |
| DOM-memo-019 | MemoRepository.listByIdsIncludingTrashed | spec/domains/memo.md#MemoRepository | ID 群を trashed 含め一括取得（出典表示用）。不在・他ユーザー所有の ID は結果に含めない |
| DOM-memo-020 | MemoRepository.listActiveByIds | spec/domains/memo.md#MemoRepository | ID 群を active のみ一括取得（AI 経路可）。trashed・不在・他ユーザーは区別なく結果から除外 |
| DOM-memo-021 | MemoRepository.findTimelinePage | spec/domains/memo.md#MemoRepository | 双方向カーソルページング（direction: older/newer、items は常に postedAt 降順、keyword 部分一致絞り込み、cursor null は先頭からの older のみ） |
| DOM-memo-022 | MemoRepository.findTimelineAround | spec/domains/memo.md#MemoRepository | 日付 / メモ ID アンカーで前後を含む初期ページと olderCursor / newerCursor を返す（日付にメモがなければ最近接、対象不在は空結果） |
| DOM-memo-023 | MemoRepository.listRevisions | spec/domains/memo.md#MemoRepository | userId スコープで全リビジョンを revisionNumber 昇順で返す。不在・他ユーザーは空配列 |
| DOM-memo-024 | MemoRepository.findRevision | spec/domains/memo.md#MemoRepository | userId スコープで単一リビジョン取得。なければ null |
| DOM-memo-025 | MemoRepository.listTrashed | spec/domains/memo.md#MemoRepository | trashed メモを trashedAt 降順・Versioned 付きで返す。TrashQueryPort アダプターの内部実装（UNION 枝）専用でユースケースから直接呼ばない |

## knowledge

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-knowledge-001 | TopicId 値オブジェクト | spec/domains/knowledge.md#TopicId / DocumentId / DocumentRevisionId | ブランド型。trim 後非空（InvalidTopicId） |
| DOM-knowledge-002 | DocumentId 値オブジェクト | spec/domains/knowledge.md#TopicId / DocumentId / DocumentRevisionId | ブランド型。trim 後非空（InvalidDocumentId） |
| DOM-knowledge-003 | DocumentRevisionId 値オブジェクト | spec/domains/knowledge.md#TopicId / DocumentId / DocumentRevisionId | ブランド型。trim 後非空（InvalidRevisionId） |
| DOM-knowledge-004 | TopicName 値オブジェクト | spec/domains/knowledge.md#TopicName | trim 後非空・改行なし・100文字以内（EmptyTopicName / TopicNameMultiline / TopicNameTooLong） |
| DOM-knowledge-005 | TopicDescription 値オブジェクト | spec/domains/knowledge.md#TopicDescription | trim 後非空・500文字以内。「説明なし」はエンティティ側 null で表す（空文字 VO を作らない） |
| DOM-knowledge-006 | RevisionNumber 値オブジェクト（knowledge） | spec/domains/knowledge.md#RevisionNumber | 1以上の整数、first()/next() 付き。memo の同名 VO を import せず自前定義（ブランド別物） |
| DOM-knowledge-007 | DocumentTitle 値オブジェクト | spec/domains/knowledge.md#DocumentTitle | trim 後非空・改行なし・200文字以内 |
| DOM-knowledge-008 | DocumentBody 値オブジェクト | spec/domains/knowledge.md#DocumentBody | 空文字許容・1,000,000文字以内（DocumentBodyTooLong）。構文解釈しない |
| DOM-knowledge-009 | ChangeReason 値オブジェクト | spec/domains/knowledge.md#ChangeReason | trim 後非空・改行なし・200文字以内。既定値補完（「手動編集」等）は application 層の責務でドメインは常に非空要求 |
| DOM-knowledge-010 | DocumentPatch 値オブジェクト | spec/domains/knowledge.md#DocumentPatch | hunks 1件以上・oldText 非空を検証。apply は各 hunk を順に「完全一致でちょうど1箇所」置換し、0箇所は PatchTargetNotFound / 2箇所以上は PatchTargetAmbiguous、失敗時は部分適用しない。結果は DocumentBody.create を通す |
| DOM-knowledge-011 | Topic エンティティ（集約ルート） | spec/domains/knowledge.md#Topic | active / archived / trashed（trashedAt + wasArchived）の直和型。create / rename / changeDescription / archive / unarchive / softDelete / restore（wasArchived に従い復帰）を純関数で提供し、不正遷移は引数型で排除。softDelete / restore は TopicTrashService 経由でのみ使う |
| DOM-knowledge-012 | Document エンティティ（集約ルート） | spec/domains/knowledge.md#Document | active / trashed（trashedAt + trashedWith）の直和型。create（リビジョン#1と重複除去済み SourceLink 群を同時生成）/ edit（適用後全文を受け、unchanged 判定でリビジョンを積まない）/ rollback / softDelete（trashedWith 不一致は TrashedWithMismatch）/ restore / moveToTopic（ADR-001、イベントなし）を提供する |
| DOM-knowledge-013 | DocumentRevision エンティティ | spec/domains/knowledge.md#DocumentRevision | 不変スナップショット。(documentId, revisionNumber) 一意で title・body 全文・actor・changeReason（必須）・createdAt を持つ。生成は Document の振る舞い内部のみ |
| DOM-knowledge-014 | SourceLink エンティティ | spec/domains/knowledge.md#SourceLink | (documentId, memoId) 複合同一性。生成はドキュメント作成時のみで後からの追加・削除操作は提供しない。振る舞いを持たない |
| DOM-knowledge-015 | topic.created イベント | spec/domains/knowledge.md#ドメインイベント | Topic.create から `{ topicId }` で発行 |
| DOM-knowledge-016 | topic.updated イベント | spec/domains/knowledge.md#ドメインイベント | Topic.rename / changeDescription から発行 |
| DOM-knowledge-017 | topic.archived イベント | spec/domains/knowledge.md#ドメインイベント | Topic.archive から発行。consumer はこれでインデックス除去してはならない |
| DOM-knowledge-018 | topic.unarchived イベント | spec/domains/knowledge.md#ドメインイベント | Topic.unarchive から発行 |
| DOM-knowledge-019 | topic.trashed イベント | spec/domains/knowledge.md#ドメインイベント | Topic.softDelete（trashTopicSet 経由）から発行 |
| DOM-knowledge-020 | topic.restored イベント | spec/domains/knowledge.md#ドメインイベント | Topic.restore（restoreTopicSet 経由）から発行 |
| DOM-knowledge-021 | topic.hardDeleted イベント | spec/domains/knowledge.md#ドメインイベント | trash のユースケースが直接発行 |
| DOM-knowledge-022 | document.created イベント | spec/domains/knowledge.md#ドメインイベント | Document.create から `{ documentId }` で発行 |
| DOM-knowledge-023 | document.edited イベント | spec/domains/knowledge.md#ドメインイベント | Document.edit / rollback から発行（ロールバックも編集の一種） |
| DOM-knowledge-024 | document.trashed イベント | spec/domains/knowledge.md#ドメインイベント | Document.softDelete から発行（個別・セット共通） |
| DOM-knowledge-025 | document.restored イベント | spec/domains/knowledge.md#ドメインイベント | Document.restore から発行（個別・セット共通） |
| DOM-knowledge-026 | document.hardDeleted イベント | spec/domains/knowledge.md#ドメインイベント | trash のユースケースが直接発行 |
| DOM-knowledge-027 | document.sourceLinksChanged イベント | spec/domains/knowledge.md#ドメインイベント | 出典メモのハードデリートでリンクが消えたとき、リンク消去と同一 UoW で影響ドキュメントごとに trash のユースケースが発行 |
| DOM-knowledge-028 | TopicTrashService ドメインサービス | spec/domains/knowledge.md#TopicTrashService | 純関数。trashTopicSet はトピック＋active 配下ドキュメントをセット削除（各 doc に trashedWith 付与）、restoreTopicSet は trashedWith 一致分のみ restore し個別削除分は skippedDocuments に返す（topicId 不一致混入は TrashedWithMismatch） |
| DOM-knowledge-029 | TopicRepository.insert | spec/domains/knowledge.md#TopicRepository | ActiveTopic の初回永続化 |
| DOM-knowledge-030 | TopicRepository.save | spec/domains/knowledge.md#TopicRepository | OCC 更新。0 行更新は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-knowledge-031 | TopicRepository.delete | spec/domains/knowledge.md#TopicRepository | ハードデリート（ExpectedVersion 必須。アダプターが同一バッチで行を消す） |
| DOM-knowledge-032 | TopicRepository.findById | spec/domains/knowledge.md#TopicRepository | userId スコープで LiveTopic（active/archived）のみ返す。trashed・他ユーザーは null |
| DOM-knowledge-033 | TopicRepository.findByIdIncludingTrashed | spec/domains/knowledge.md#TopicRepository | userId スコープで全状態取得。人間 UI・trash 系専用 |
| DOM-knowledge-034 | TopicRepository.listByUser | spec/domains/knowledge.md#TopicRepository | ゴミ箱外トピック一覧。includeArchived: false で active のみ、安定順序で返す |
| DOM-knowledge-035 | TopicRepository.listTrashedByUser | spec/domains/knowledge.md#TopicRepository | ゴミ箱内トピック一覧（Versioned 付き）。TrashQueryPort アダプターの内部実装専用 |
| DOM-knowledge-036 | TopicRepository.listByIds | spec/domains/knowledge.md#TopicRepository | ID 群の一括取得（検索結果のトピック名解決を 1 クエリにする）。不在・他ユーザーの ID は結果に含めない |
| DOM-knowledge-037 | DocumentRepository.insert | spec/domains/knowledge.md#DocumentRepository | ActiveDocument の初回永続化 |
| DOM-knowledge-038 | DocumentRepository.save | spec/domains/knowledge.md#DocumentRepository | OCC 更新。0 行更新は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-knowledge-039 | DocumentRepository.delete | spec/domains/knowledge.md#DocumentRepository | ハードデリート。アダプターが同一バッチで全リビジョン・全出典リンク（documentId 側）も消去する |
| DOM-knowledge-040 | DocumentRepository.findById | spec/domains/knowledge.md#DocumentRepository | userId スコープで active のみ返す。trashed・他ユーザーは null |
| DOM-knowledge-041 | DocumentRepository.findByIdIncludingTrashed | spec/domains/knowledge.md#DocumentRepository | userId スコープで全状態取得。人間 UI・trash 系専用 |
| DOM-knowledge-042 | DocumentRepository.listByIdsIncludingTrashed | spec/domains/knowledge.md#DocumentRepository | ID 群を trashed 含め一括取得（出典表示用の 1 クエリ化）。不在・他ユーザーの ID は除外 |
| DOM-knowledge-043 | DocumentRepository.listActiveByTopic | spec/domains/knowledge.md#DocumentRepository | トピック配下の active 一覧（Versioned 付き）。他ユーザーのトピック ID には空配列 |
| DOM-knowledge-044 | DocumentRepository.listActiveByTopics | spec/domains/knowledge.md#DocumentRepository | 複数トピック配下の active を一括取得（listTopics の N+1 回避） |
| DOM-knowledge-045 | DocumentRepository.listTrashedByTopic | spec/domains/knowledge.md#DocumentRepository | トピック配下のゴミ箱内一覧（Versioned 付き。セット復元・ハードデリート対象取得用） |
| DOM-knowledge-046 | DocumentRepository.listTrashedByUser | spec/domains/knowledge.md#DocumentRepository | ゴミ箱内ドキュメント一覧。TrashQueryPort アダプターの内部実装専用 |
| DOM-knowledge-047 | DocumentRepository.insertRevision | spec/domains/knowledge.md#DocumentRepository | リビジョン追記（同一 UoW）。(documentId, revisionNumber) 一意制約違反は ConflictError |
| DOM-knowledge-048 | DocumentRepository.listRevisions | spec/domains/knowledge.md#DocumentRepository | revisionNumber 昇順の履歴一覧。他ユーザーのドキュメントは空配列 |
| DOM-knowledge-049 | DocumentRepository.findRevision | spec/domains/knowledge.md#DocumentRepository | 特定リビジョンの取得。他ユーザーのものは null |
| DOM-knowledge-050 | DocumentRepository.insertSourceLinks | spec/domains/knowledge.md#DocumentRepository | 出典リンクの一括登録（Document.create と同一 UoW） |
| DOM-knowledge-051 | DocumentRepository.listSourceLinksByDocument | spec/domains/knowledge.md#DocumentRepository | ドキュメント ID → 出典リンク一覧（userId スコープ） |
| DOM-knowledge-052 | DocumentRepository.listSourceLinksByDocuments | spec/domains/knowledge.md#DocumentRepository | ドキュメント ID 群 → 出典リンクの一括逆引き（getTopic の関連メモを 1 クエリ化） |
| DOM-knowledge-053 | DocumentRepository.listSourceLinksByMemo | spec/domains/knowledge.md#DocumentRepository | メモ ID → 参照元ドキュメントのリンク一覧（userId スコープ） |
| DOM-knowledge-054 | DocumentRepository.listSourceLinksByMemos | spec/domains/knowledge.md#DocumentRepository | メモ ID 群 → リンクの一括逆引き（タイムライン 1 ページ分を 1 クエリ化） |
| DOM-knowledge-055 | DocumentRepository.deleteSourceLinksByMemo | spec/domains/knowledge.md#DocumentRepository | メモのハードデリートに伴うリンク消去（ADR-003、同一 UoW・冪等）。userId を第一引数に取りスコープして消去する |

## search

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-search-001 | SearchQuery 値オブジェクト | spec/domains/search.md#SearchQuery | userId・keyword（trim 後非空 EmptyKeyword・500文字以内 KeywordTooLong）・任意 topicId・Pagination を持ち create で検証する |
| DOM-search-002 | SearchResultItem 値オブジェクト | spec/domains/search.md#SearchResultItem | memo / document の直和型。snippet 非空、事実データのみ（要約・再構成禁止）、type + id で同一性（重複ヒットは 1 件に統合） |
| DOM-search-003 | IndexEntry 値オブジェクト | spec/domains/search.md#IndexEntry | memo / document の直和型。削除済み対象から構築禁止、sourceOfDocumentIds / sourceMemoIds は相手が active な ID のみ含める（ゴミ箱の存在事実を露出させない） |
| DOM-search-004 | SearchIndexPort.query | spec/domains/search.md#SearchIndexPort | ハイブリッド検索の統合済み単一結果を関連度順で返す。検索の規則（ユーザー境界・ゴミ箱除外・アーカイブはヒット・topicId 絞り込み・0 件は空）を満たす |
| DOM-search-005 | SearchIndexPort.upsertMemo | spec/domains/search.md#SearchIndexPort | メモの登録・上書き（埋め込み再生成含む）。同一エントリで冪等 |
| DOM-search-006 | SearchIndexPort.upsertDocument | spec/domains/search.md#SearchIndexPort | ドキュメントについて upsertMemo と同様に冪等 |
| DOM-search-007 | SearchIndexPort.removeMemo | spec/domains/search.md#SearchIndexPort | インデックスから除去。存在しない ID でもエラーにしない（冪等） |
| DOM-search-008 | SearchIndexPort.removeDocument | spec/domains/search.md#SearchIndexPort | ドキュメントについて removeMemo と同様（種別分離は ID ブランド型の取り違えを型エラーにするため） |
| DOM-search-009 | IndexerReadPort.findMemoById | spec/domains/search.md#IndexerReadPort | userId スコープなし（Outbox 由来の信頼済み ID 専用）。active のみ返し、trashed・不在は null（null = remove 判断） |
| DOM-search-010 | IndexerReadPort.findDocumentById | spec/domains/search.md#IndexerReadPort | findMemoById と同契約で ActiveDocument \| null を返す |
| DOM-search-011 | IndexerReadPort.listSourceLinksByMemo | spec/domains/search.md#IndexerReadPort | メモを出典とする SourceLink を返す（ファンアウト逆引き用）。なければ空配列 |
| DOM-search-012 | IndexerReadPort.listSourceLinksByDocument | spec/domains/search.md#IndexerReadPort | ドキュメントの出典リンクを返す（ファンアウト逆引き用）。なければ空配列 |

## trash

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-trash-001 | TrashItem 値オブジェクト | spec/domains/trash.md#TrashItem | memo / document / topic の直和の読み取り専用ビュー。expiresAt は保存せず照会時算出、topic は setDocumentIds を持つ。ドメイン層は型定義のみでファクトリを置かない |
| DOM-trash-002 | RestorePolicy ドメインサービス | spec/domains/trash.md#RestorePolicy | 純関数 decideDocumentRestore がトピック現況（active / trashed / hardDeleted）から restoreAlone / restoreWithTopic / selectDestination の 3 分岐を判定する |
| DOM-trash-003 | HardDeletePolicy ドメインサービス | spec/domains/trash.md#HardDeletePolicy | 純関数 expandTargets が TrashItem を種別ごとの消去対象 ID 集合（HardDeletePlan）に展開する。トピックは setDocumentIds を含め、個別削除分は含めない |
| DOM-trash-004 | RetentionPolicy ドメインサービス | spec/domains/trash.md#RetentionPolicy | 純関数。expiresAt = trashedAt + retentionDays（毎回算出で遡及適用を実現）、isExpired は expiresAt < now |
| DOM-trash-005 | TrashQueryPort.listTrashItems | spec/domains/trash.md#TrashQueryPort | ゴミ箱一覧を削除日時降順・ページング付きで返す。retentionDays から expiresAt を付与し、topic の setDocumentIds を trashedWith から射影して埋める |
| DOM-trash-006 | TrashQueryPort.findTrashItem | spec/domains/trash.md#TrashQueryPort | TrashItemRef による単一取得（復元・ハードデリートの対象確認用）。ゴミ箱にない場合は null |
| DOM-trash-007 | TrashQueryPort.countTrashItems | spec/domains/trash.md#TrashQueryPort | ゴミ箱の総件数を返す（「空にする」の件数確認 S-TR-04 用） |
| DOM-trash-008 | TrashQueryPort.listExpiredItems | spec/domains/trash.md#TrashQueryPort | 全ユーザー横断で各ユーザーの TrashRetentionDays を適用して期限切れ項目（userId 付き）を limit 件列挙する。期限切れ列挙経路はここに一本化 |

## export

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-export-001 | ExportRequest 値オブジェクト | spec/domains/export.md#ExportRequest | userId と IANA timezone を持ち、解決不能な timezone は BusinessRuleError(InvalidTimezone) |
| DOM-export-002 | ExportSource 値オブジェクト | spec/domains/export.md#ExportSource | memos / topics / documents の読み取り専用スナップショット。documents[].topicId が topics に存在しない場合は OrphanDocument |
| DOM-export-003 | MemoExportEntry 値オブジェクト | spec/domains/export.md#MemoExportEntry | memoId・最新リビジョン本文・postedAt・updatedAt を持つ |
| DOM-export-004 | TopicExportEntry 値オブジェクト | spec/domains/export.md#TopicExportEntry | topicId・name・description・archived・createdAt を持つ |
| DOM-export-005 | DocumentExportEntry 値オブジェクト | spec/domains/export.md#DocumentExportEntry | documentId・topicId・title・最新本文・sourceMemoIds（ハードデリート済み ID を含まない）・日時を持つ |
| DOM-export-006 | ExportFile 値オブジェクト | spec/domains/export.md#ExportFile | 相対 path（先頭 / なし・.. なし・.md 拡張子。違反は InvalidArchivePath）と UTF-8 Markdown content |
| DOM-export-007 | ExportArchive 値オブジェクト | spec/domains/export.md#ExportArchive | rootDirName（fog-export-YYYYMMDD）・path 辞書順の files（重複は DuplicateArchivePath）・exportedAt。同一入力から常にバイト同一の決定的導出 |
| DOM-export-008 | ArchiveBinary 値オブジェクト | spec/domains/export.md#ArchiveBinary | {rootDirName}.zip / application/zip / Uint8Array の終端値（バリデーションなし） |
| DOM-export-009 | ExportRenderer ドメインサービス | spec/domains/export.md#ExportRenderer | 純関数 render(source, exportedAt, timezone) がアーカイブ構成の規則（マニフェスト・日別メモ・トピックメタ・ドキュメント・スラッグ導出と衝突解決・出典の相対パス解決・deleted: true 規則）どおり ExportArchive を導出する |
| DOM-export-010 | ExportSourceReader.readAll | spec/domains/export.md#ExportSourceReader | ユーザーの全データをゴミ箱除外・最新リビジョンのみで単一トランザクション（スナップショット読み）により ExportSource に組み立てる |
| DOM-export-011 | ArchiveWriter.write | spec/domains/export.md#ArchiveWriter | ExportArchive を rootDirName/ 配下に格納した zip にエンコードし ArchiveBinary を返す。失敗は SystemError(ArchiveEncodingError) |
