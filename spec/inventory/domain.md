# Inventory — domain

生成元: spec/domains/（最終同期: 2026-08-01）

## identity

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-identity-001 | User エンティティ | spec/domains/identity.md#User | 認証方式の判別可能ユニオンを持たない。保有クレデンシャルの非 PII 要約集合（`{ credentialId, kind, label, usableForLogin }`。1件以上）と trashRetentionDays・OCC version を持ち、email / passwordHash / provider / providerSubject は持たない。initialize（**クレデンシャル集合を引数に取らない**。`credentials` は `CredentialLocatorStore` の射影で、signup phase 4 まで行が無い）/ loginCredentialCount / changeTrashRetentionDays を純関数として提供する。**`addCredential` / `removeCredential` は置かない**（`.thread/37/adr.md` ADR-070）— `save` が書くのは `trash_retention_days` と `version` だけなので、集合を書き換えるメソッドは version だけ進む no-op になる。集合の増減は `CredentialLocatorStore.record` / `deleteByCredentialId` が担い、`kind: "sso"` 限定と「最後のログイン手段」の検査は `linkSsoCredential` / `unlinkSsoCredential` が持つ（後者は `loginCredentialCount` を述語に使う）。**「ログイン手段の数」は `usableForLogin` が真である要素の `credentialId` の異なり数**であり、要素数でも `kind` でも決まらない。パスワードの変更・リセットは本エンティティの遷移ではない |
| DOM-identity-002 | AiClientConnection エンティティ | spec/domains/identity.md#AiClientConnection | active / revoked の直和型（revokedAt は revoked のみ）。**createdAtResetVersion（作成時点の resetVersion。生成後は不変）**を持ち、リセット完了時の自動失効の対象はこの値が前進前の resetVersion と等しい接続だけである。create / revoke（active のみ・不可逆）/ recordUsage（OCC 非対象のベストエフォート更新）を提供する |
| DOM-identity-003 | UserId 値オブジェクト | spec/domains/identity.md#UserId | ブランド型。trim 後非空を create で検証し、違反は BusinessRuleError を throw する |
| DOM-identity-004 | AiClientConnectionId 値オブジェクト | spec/domains/identity.md#AiClientConnectionId | ブランド型。trim 後非空の不透明文字列として検証する |
| DOM-identity-005 | Email 値オブジェクト | spec/domains/identity.md#Email | canonical 化の唯一の出所。trim → 構造チェック → 最後の `@` で分割 → local 部は非 ASCII 拒否・lowercase のみ（NFKC を掛けない）→ domain 部は NFKC + lowercase + punycode → 再結合、の順で正規化する。長さ上限 320 を正規化の前後で2回見る。違反は InvalidEmail |
| DOM-identity-006 | PlainPassword 値オブジェクト | spec/domains/identity.md#PlainPassword | 8〜128文字を検証（違反は PasswordTooWeak）。ログ・永続化への漏出を防止する実装を持つ |
| DOM-identity-007 | PasswordHash 値オブジェクト | spec/domains/identity.md#PasswordHash | 非空のみ検証する不透明文字列。照合は文字列比較ではなく PasswordHasher.verify 経由に限定される |
| DOM-identity-008 | SsoProvider 値オブジェクト | spec/domains/identity.md#SsoProvider | "google" \| "apple" のリテラルユニオン。違反は UnsupportedSsoProvider |
| DOM-identity-009 | ClientName 値オブジェクト | spec/domains/identity.md#ClientName | trim 後非空・100文字以下を検証する |
| DOM-identity-010 | TrashRetentionDays 値オブジェクト | spec/domains/identity.md#TrashRetentionDays | 1以上の整数を検証（違反は InvalidTrashRetentionDays）。default() が 30 を返す。定義はここ一箇所のみ（trash 側に重複定義しない） |
| DOM-identity-011 | Actor 値オブジェクト | spec/domains/identity.md#Actor | UserActor / AiClientActor の直和型。Actor.user / Actor.aiClient ファクトリを提供し、AiClientActor は clientName をスナップショットとして持つ |
| DOM-identity-012 | TokenScope 値オブジェクト | spec/domains/identity.md#TokenScope | HumanScope / AiScope の直和型。AiPermission（read/write）⊂ HumanPermission（+hardDelete/trash/history）で、allows(scope, permission) が human 全許可・ai は AiPermission のみを返す |
| DOM-identity-018 | UserSettingsRepository.insert | spec/domains/identity.md#UserSettingsRepository | ユーザー単位設定側の User の初回永続化（version 0）。同期契約 |
| DOM-identity-019 | UserSettingsRepository.save | spec/domains/identity.md#UserSettingsRepository | ExpectedVersion による OCC 更新。不一致は ConflictError("OPTIMISTIC_LOCK_FAILURE")。**単一行なので条件付き更新に `id` 述語を持たない**（条件は version だけ） |
| DOM-identity-020 | UserSettingsRepository.find | spec/domains/identity.md#UserSettingsRepository | 自分の Durable Object の User を返す。初期化前は null。**findById(id) は持たない**（DO 内に1人分しか存在しないため） |
| DOM-identity-021 | CredentialMappingRepository.findByEmail | spec/domains/identity.md#CredentialMappingRepository | canonical 化済みメールで解決（登録の一意性検証・パスワードログイン・リセット依頼）。該当なしは null。認証情報側（Identity Directory）に置く |
| DOM-identity-022 | CredentialMappingRepository.findBySsoIdentity | spec/domains/identity.md#CredentialMappingRepository | (provider, providerSubject) で解決。該当なしは null。一意性違反は予約の獲得で ConflictError として判定する |
| DOM-identity-023 | AiClientConnectionRepository.insert | spec/domains/identity.md#AiClientConnectionRepository | ActiveAiClientConnection の初回永続化 |
| DOM-identity-024 | AiClientConnectionRepository.save | spec/domains/identity.md#AiClientConnectionRepository | OCC 更新。不一致は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-identity-025 | AiClientConnectionRepository.findById | spec/domains/identity.md#AiClientConnectionRepository | userId を引数に取らない（DO 選択で消費済み）。不在は null で「存在の有無も漏らさない」（テナント分離は到達可能性による） |
| DOM-identity-026 | AiClientConnectionRepository.listByUserId | spec/domains/identity.md#AiClientConnectionRepository | 自分の DO の接続一覧を connectedAt 降順で返す（引数なし） |
| DOM-identity-027 | AiClientConnectionRepository.findActiveById | spec/domains/identity.md#AiClientConnectionRepository | 認可ミドルウェア専用。userId を取らない（トークンが userId を自己完結で運ぶ）。active のみ返し、失効済み・不在は区別なく null。**失効の権威はここで読む status であり、別ストアへの伝播経路は存在しない** |
| DOM-identity-028 | AiClientConnectionRepository.recordUsage | spec/domains/identity.md#AiClientConnectionRepository | lastUsedAt のベストエフォート単独 UPDATE（version 不変・後勝ち）。失敗しても throw せずログのみ |
| DOM-identity-029 | PasswordHasher.hash | spec/domains/identity.md#PasswordHasher | PlainPassword → PasswordHash。アルゴリズムはアダプター責務、失敗は SystemError。**実装できる API が非同期しか無いため Promise 契約のまま残る**（例外は列挙であって導出規則ではない。domains/index.md） |
| DOM-identity-030 | PasswordHasher.verify | spec/domains/identity.md#PasswordHasher | タイミングセーフに照合し、不一致はエラーでなく false |
| DOM-identity-031 | PasswordResetTokenPort.issue | spec/domains/identity.md#PasswordResetTokenPort | 対象クレデンシャル単位の発行（`issue(credentialId, now)`）。同じクレデンシャル宛の未使用トークンをすべて置き換える。置き場は認証情報側（Identity Directory） |
| DOM-identity-032 | PasswordResetTokenPort.verifyAndConsume | spec/domains/identity.md#PasswordResetTokenPort | 有効なら使い捨て消費して UserId を返す。無効・期限切れ・使用済みは null |
| DOM-identity-033 | MailSender.sendPasswordResetMail | spec/domains/identity.md#MailSender | リセットリンクメールを送る。宛先実在性起因の失敗をユーザー応答に反映しない。**実装できる API が非同期しか無いため Promise 契約のまま残る**（例外は列挙であって導出規則ではない。domains/index.md） |
| DOM-identity-034 | CredentialId 値オブジェクト | spec/domains/identity.md#CredentialId | ブランド型。IdGenerator が採番し、メールアドレスからも鍵からも導出しない（保管方式や鍵世代が変わっても値が変わらないことが目的）。設定画面へ出してよい非 PII の値 |
| DOM-identity-035 | CredentialMappingRepository.findByCredentialId | spec/domains/identity.md#CredentialMappingRepository | credentialId で解決（解除・リセットトークンの対象特定用）。該当なしは null |
| DOM-identity-036 | CredentialMapping のフィールド | spec/domains/identity.md#CredentialMappingRepository | `credentialId` / `userId` / `kind` / `usableForLogin`（ログイン手段になり得るかの**判定の権威**）/ `credentialVersion`（パスワード差し替えごとに +1。ログインの到達性検査で照合する）/ `changeState`（`null` \| `"pending"` \| `"advanced"` の3値）/ `changeOrigin`（`"password-change"` \| `"reset"`。**行へ永続化する**ので再開時にも起点が決まる）/ `failedAttempts` / `nextAttemptAllowedAt`（ログイン失敗と現在パスワード照合の失敗が同じカウンタを進める）を持つ。**濫用抑止には3規則を課す**（カウンタの単位はクレデンシャルであって発信元ではないので、素朴に組むと被害者を恒久的に締め出せてしまう。具体値は運用側が決める）— (i) 先送り幅に**天井**を置き無限の指数バックオフを採らない、(ii) 最後の失敗からの経過時間で `failedAttempts` を**時間減衰**させ成功だけをリセットの契機にしない、(iii) **制限中の照合はカウンタを進めない**（進めると攻撃者が先送りを無限に更新できる）。**脱出経路は2本** — リセットの完走（`promoteVerifier` が `failedAttempts` を 0 に、`nextAttemptAllowedAt` を過去へ戻す）と、カウンタが独立している SSO ログイン（パスワードの制限が SSO を巻き込まない） |
| DOM-identity-037 | 認証情報側への書き込み操作 | spec/domains/identity.md#CredentialMappingRepository | 手続きの各段が呼ぶ操作を名前と契約で固定する: `reserveCredential`（予約の獲得。既存の有効行があれば ConflictError）/ `activateReservation`（予約の確定と `usableForLogin` の確定）/ `cancelReservation`（敗北した予約の除去。無ければ成功）/ `beginCredentialChange`（保留の検証材料を書き `changeState` を `"pending"` に。同一トランザクションで未使用リセットトークンを全無効化）/ `promoteVerifier`（`changeState` が `"advanced"` のときだけ昇格し `changeState` / `changeOrigin` を null へ戻す）/ `deleteMapping`（写像行とリセットトークン行の除去。無ければ成功）。**単一のメソッドには畳まない**が、契約はここで確定している |
| DOM-identity-038 | AccountStore.find | spec/domains/identity.md#AccountStore | `status`（active/deleting/deleted）・`sessionEpoch`・`resetVersion` を返す。**`User` 集約には畳まない**が、`account` テーブルは OCC の `version` を持つ集約ルート側であり非集約ストアには数えない。前進メソッドは `ExpectedVersion` を取らない。初期化前は null。**`AccountState` は `version` を持たず、本ポートは `save` 相当のメソッドも持たない** — `account` テーブルは `version` 列を保持するが、**本 spec の範囲には条件付き更新を発行する書き手が無い**（`status` の遷移を書くのは退会の手続きであり、退会は要件・シナリオに存在しないためスコープ外）。`status` を型に残すのは、ログインとリセットのガードが `"active"` であることを読む側の権威だからである |
| DOM-identity-039 | AccountStore.advanceSessionEpoch | spec/domains/identity.md#AccountStore | セッションの世代を1つ進める。**進める操作は4つだけ**（パスワード変更 / リセット完了 / SSO 連携の解除 / 退会）で、**SSO 連携の追加では進めない**。既存セッションは次のリクエストで失効する |
| DOM-identity-040 | AccountStore.advanceResetVersion | spec/domains/identity.md#AccountStore | リセット世代を1つ進め、**進めた後の値を返す**。失効の射程となる前進前の値はこの戻り値から導き、**`find()` で読み直さない**（読み直しと前進を分けると並行実行で射程がずれる）。**リセットの完了だけで進む**（通常のパスワード変更・SSO の連携と解除では進めない）。`sessionEpoch` で代用しない |
| DOM-identity-041 | CredentialLocatorStore.list / findByCredentialId | spec/domains/identity.md#CredentialLocatorStore | 保有クレデンシャルの逆引き（`credentialId` / `kind` / 不透明な写像材料 / `credentialVersion` / `usableForLogin` / `label`）。**ログインの到達性検査の権威**であり、**照合は `credentialId` だけを見て写像材料の世代を含めない**。原本も検証材料も持たない |
| DOM-identity-042 | CredentialLocatorStore.record | spec/domains/identity.md#CredentialLocatorStore | upsert。既存があれば `credentialVersion` / `usableForLogin` / `label` を上書きする。**`credentialVersion` は `credentialId` 単位で単調非減少**（引数と既存の最大値のうち大きいほう）。**既存行があれば何もしない no-op にしてはならない**（記録が空振りすると到達性検査が利用者を締め出す） |
| DOM-identity-043 | CredentialLocatorStore.advanceCredentialVersion | spec/domains/identity.md#CredentialLocatorStore | その `credentialId` の `credentialVersion` を1つ進める。**その credential のすべての行に同時に効く**（1つだけ更新すると認証情報側との食い違いが残る） |
| DOM-identity-044 | CredentialLocatorStore.deleteByCredentialId | spec/domains/identity.md#CredentialLocatorStore | その `credentialId` の行をすべて消す。「無ければ成功」の冪等操作。SSO 連携の解除・退会が使う（消す前に写像材料を控える。消した後は認証情報側の行へ辿り着けない） |
| DOM-identity-045 | credentialMappingRules（ドメインサービス） | spec/domains/identity.md#認証情報の可否判定credentialMappingRules | `CredentialMapping` に対する4つの純粋述語 `isSettled` / `holdsPasswordVerifier` / `isUsableForLogin` / `isResetRequestAllowed` を**ドメイン層に1本化する**（ログインの写像解決・リセット依頼の適格判定・`send-mail` の宛先判定の3箇所が同じ規則を読む。アダプターに3重に書かない）。**リセットの窓判定は経過時間ではなく窓番号 `floor(t / windowMs)` の比較である** — `last_reset_requested_at` は全依頼で前進するので、sliding だと未認証の第三者がリセットを恒久的に封じられる。`windowMs` は引数で、実値・天井・減衰は #18 / #38。条件を足すのは #12 / #18 |

## memo

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-memo-001 | Memo エンティティ（集約ルート） | spec/domains/memo.md#Memo（集約ルート） | active / trashed の直和型。create（初版リビジョン必須）/ edit（同一本文は no-op・newRevision null）/ rollback（同内容の新リビジョン）/ softDelete（`purgeAfter` を受けて保存する）/ restore（`trashedAt` と `purgeAfter` を落とす）を純関数で提供し、trashed への edit/rollback は型エラー。hardDelete はドメインに置かない |
| DOM-memo-002 | MemoRevision エンティティ | spec/domains/memo.md#MemoRevision | (memoId, revisionNumber) 複合キーの不変スナップショット。actor・全文 body・createdAt を持ち、変更理由は持たない。生成は Memo の振る舞い内部のみ（公開ファクトリなし） |
| DOM-memo-003 | MemoId 値オブジェクト | spec/domains/memo.md#MemoId | ブランド型。trim 後空なら BusinessRuleError(InvalidId) |
| DOM-memo-004 | MemoBody 値オブジェクト | spec/domains/memo.md#MemoBody | 非空（trim は空判定のみ、保存は入力そのまま。EmptyBody）・10,000 コードポイント上限（BodyTooLong）。equals で同一判定を提供する |
| DOM-memo-005 | RevisionNumber 値オブジェクト（memo） | spec/domains/memo.md#RevisionNumber | 1以上の整数（InvalidRevisionNumber）。first()=1 / next(n)=n+1 の補助ファクトリを持つ |
| DOM-memo-006 | TimelineCursor 値オブジェクト | spec/domains/memo.md#TimelineCursor | 非空の不透明トークン（InvalidCursor）。位置のみを表し方向を含まない |
| DOM-memo-013 | MemoRepository.insert | spec/domains/memo.md#MemoRepository | 初回永続化専用（version 0）。OCC トークン不要。同期契約（`Promise` を返さない） |
| DOM-memo-014 | MemoRepository.insertRevision | spec/domains/memo.md#MemoRepository | リビジョン追記。本体の insert / save と同一 UoW で書き、(memoId, revisionNumber) 一意制約が線形性の最終防衛線 |
| DOM-memo-015 | MemoRepository.save | spec/domains/memo.md#MemoRepository | 状態を問わず ExpectedVersion 付き上書き。0 行更新は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-memo-016 | MemoRepository.hardDelete | spec/domains/memo.md#MemoRepository | メモ本体と全リビジョンを同一 UoW で物理削除（ExpectedVersion 必須） |
| DOM-memo-017 | MemoRepository.findById | spec/domains/memo.md#MemoRepository | userId を引数に取らない（DO 選択で消費済み）。active のみ返し、trashed は null（AI からゴミ箱が「存在しない」の土台） |
| DOM-memo-018 | MemoRepository.findByIdIncludingTrashed | spec/domains/memo.md#MemoRepository | 状態を問わず返す。人間 UI・trash 系専用（AI 向けでは使わない） |
| DOM-memo-019 | MemoRepository.listByIdsIncludingTrashed | spec/domains/memo.md#MemoRepository | ID 群を trashed 含め一括取得（出典表示用）。不在の ID は結果に含めない |
| DOM-memo-020 | MemoRepository.listActiveByIds | spec/domains/memo.md#MemoRepository | ID 群を active のみ一括取得（AI 経路可）。trashed・不在は区別なく結果から除外 |
| DOM-memo-021 | MemoRepository.findTimelinePage | spec/domains/memo.md#MemoRepository | 双方向カーソルページング（direction: older/newer、items は常に postedAt 降順、keyword 部分一致絞り込み、cursor null は先頭からの older のみ） |
| DOM-memo-022 | MemoRepository.findTimelineAround | spec/domains/memo.md#MemoRepository | 日付 / メモ ID アンカーで前後を含む初期ページと olderCursor / newerCursor を返す（日付にメモがなければ最近接、対象不在は空結果） |
| DOM-memo-023 | MemoRepository.listRevisions | spec/domains/memo.md#MemoRepository | 全リビジョンを revisionNumber 昇順で返す。不在は空配列 |
| DOM-memo-024 | MemoRepository.findRevision | spec/domains/memo.md#MemoRepository | 単一リビジョン取得。なければ null |
| DOM-memo-025 | MemoRepository.listTrashed | spec/domains/memo.md#MemoRepository | trashed メモを trashedAt 降順・Versioned 付きで返す。TrashQueryPort アダプターの内部実装（UNION 枝）専用でユースケースから直接呼ばない。**期限切れ列挙メソッドは置かない**（`purgeAfter` の索引を引くのは `TrashQueryPort.listItemsToPurge` で、それを呼ぶのは自 DO の Alarm ジョブ） |
| DOM-memo-026 | MemoRepository.recalculatePurgeAfter | spec/domains/memo.md#MemoRepository | 保持日数変更に伴う `purgeAfter` の一括更新。`purgeAfter` が retentionDays からの算出値と一致しない trashed 行を limit 件まで書き換え、`{ updatedCount, hasMore }` を返す。**OCC トークンを取らず version も進めない**（派生値の追随）。**進捗はカーソルではなく作業述語が表す**ので残件を別に永続化しない。active な行には触れない |

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
| DOM-knowledge-011 | Topic エンティティ（集約ルート） | spec/domains/knowledge.md#Topic | active / archived / trashed（trashedAt + purgeAfter + wasArchived）の直和型。create / rename / changeDescription / archive / unarchive / softDelete（`purgeAfter` を受ける）/ restore（wasArchived に従い復帰し `purgeAfter` を落とす）を純関数で提供し、不正遷移は引数型で排除。softDelete / restore は TopicTrashService 経由でのみ使う。**projection のファンアウトは配下ドキュメントだけで閉じない** — softDelete は配下ドキュメントのエントリを同一トランザクションで除去したうえで**その各ドキュメントの出典メモのエントリも作り直し**、restore は復元した配下ドキュメントのエントリと**その各ドキュメントの出典メモのエントリ**を同じトランザクションで作り直す（`Document.softDelete` / `Document.restore` と同じファンアウト。作り直さないと出典メモ側にゴミ箱内ドキュメントの ID が残る）。トピック自体のエントリは無い |
| DOM-knowledge-012 | Document エンティティ（集約ルート） | spec/domains/knowledge.md#Document | active / trashed（trashedAt + purgeAfter + trashedWith）の直和型。create（リビジョン#1と重複除去済み SourceLink 群を同時生成）/ edit（適用後全文を受け、unchanged 判定でリビジョンを積まない）/ rollback / softDelete（`trashedWith` 不一致は TrashedWithMismatch。`purgeAfter` を受ける）/ restore / moveToTopic（ADR-001）を提供する |
| DOM-knowledge-013 | DocumentRevision エンティティ | spec/domains/knowledge.md#DocumentRevision | 不変スナップショット。(documentId, revisionNumber) 一意で title・body 全文・actor・changeReason（必須）・createdAt を持つ。生成は Document の振る舞い内部のみ |
| DOM-knowledge-014 | SourceLink エンティティ | spec/domains/knowledge.md#SourceLink | (documentId, memoId) 複合同一性。生成はドキュメント作成時のみで後からの追加・削除操作は提供しない。振る舞いを持たない |
| DOM-knowledge-028 | TopicTrashService ドメインサービス | spec/domains/knowledge.md#TopicTrashService | 純関数。trashTopicSet はトピック＋active 配下ドキュメントをセット削除（各 doc に trashedWith と同一の `purgeAfter` を付与）、restoreTopicSet は trashedWith 一致分のみ restore し個別削除分は skippedDocuments に返す（topicId 不一致混入は TrashedWithMismatch） |
| DOM-knowledge-029 | TopicRepository.insert | spec/domains/knowledge.md#TopicRepository | ActiveTopic の初回永続化。同期契約（`Promise` を返さない） |
| DOM-knowledge-030 | TopicRepository.save | spec/domains/knowledge.md#TopicRepository | OCC 更新。0 行更新は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-knowledge-031 | TopicRepository.delete | spec/domains/knowledge.md#TopicRepository | ハードデリート（ExpectedVersion 必須。アダプターが同一トランザクションで行を消す） |
| DOM-knowledge-032 | TopicRepository.findById | spec/domains/knowledge.md#TopicRepository | userId を引数に取らない（DO 選択で消費済み）。LiveTopic（active/archived）のみ返し、trashed は null |
| DOM-knowledge-033 | TopicRepository.findByIdIncludingTrashed | spec/domains/knowledge.md#TopicRepository | 全状態取得。人間 UI・trash 系専用 |
| DOM-knowledge-034 | TopicRepository.listByUser | spec/domains/knowledge.md#TopicRepository | ゴミ箱外トピック一覧。includeArchived: false で active のみ、安定順序で返す |
| DOM-knowledge-035 | TopicRepository.listTrashedByUser | spec/domains/knowledge.md#TopicRepository | ゴミ箱内トピック一覧（Versioned 付き）。TrashQueryPort アダプターの内部実装専用 |
| DOM-knowledge-036 | TopicRepository.listByIds | spec/domains/knowledge.md#TopicRepository | ID 群の一括取得（検索結果のトピック名解決を 1 クエリにする）。不在の ID は結果に含めない |
| DOM-knowledge-037 | DocumentRepository.insert | spec/domains/knowledge.md#DocumentRepository | ActiveDocument の初回永続化 |
| DOM-knowledge-038 | DocumentRepository.save | spec/domains/knowledge.md#DocumentRepository | OCC 更新。0 行更新は ConflictError("OPTIMISTIC_LOCK_FAILURE") |
| DOM-knowledge-039 | DocumentRepository.delete | spec/domains/knowledge.md#DocumentRepository | ハードデリート。アダプターが同一トランザクションで全リビジョン・全出典リンク（documentId 側）も消去する |
| DOM-knowledge-040 | DocumentRepository.findById | spec/domains/knowledge.md#DocumentRepository | active のみ返す。trashed は null（userId は引数に取らない） |
| DOM-knowledge-041 | DocumentRepository.findByIdIncludingTrashed | spec/domains/knowledge.md#DocumentRepository | 全状態取得。人間 UI・trash 系専用 |
| DOM-knowledge-042 | DocumentRepository.listByIdsIncludingTrashed | spec/domains/knowledge.md#DocumentRepository | ID 群を trashed 含め一括取得（出典表示用の 1 クエリ化）。不在の ID は除外 |
| DOM-knowledge-043 | DocumentRepository.listActiveByTopic | spec/domains/knowledge.md#DocumentRepository | トピック配下の active 一覧（Versioned 付き）。存在しないトピック ID には空配列 |
| DOM-knowledge-044 | DocumentRepository.listActiveByTopics | spec/domains/knowledge.md#DocumentRepository | 複数トピック配下の active を一括取得（listTopics の N+1 回避） |
| DOM-knowledge-045 | DocumentRepository.listTrashedByTopic | spec/domains/knowledge.md#DocumentRepository | トピック配下のゴミ箱内一覧（Versioned 付き。セット復元・ハードデリート対象取得用） |
| DOM-knowledge-046 | DocumentRepository.listTrashedByUser | spec/domains/knowledge.md#DocumentRepository | ゴミ箱内ドキュメント一覧。TrashQueryPort アダプターの内部実装専用 |
| DOM-knowledge-047 | DocumentRepository.insertRevision | spec/domains/knowledge.md#DocumentRepository | リビジョン追記（同一 UoW）。(documentId, revisionNumber) 一意制約違反は ConflictError |
| DOM-knowledge-048 | DocumentRepository.listRevisions | spec/domains/knowledge.md#DocumentRepository | revisionNumber 昇順の履歴一覧。不在は空配列 |
| DOM-knowledge-049 | DocumentRepository.findRevision | spec/domains/knowledge.md#DocumentRepository | 特定リビジョンの取得。不在は null |
| DOM-knowledge-050 | DocumentRepository.insertSourceLinks | spec/domains/knowledge.md#DocumentRepository | 出典リンクの一括登録（Document.create と同一 UoW） |
| DOM-knowledge-051 | DocumentRepository.listSourceLinksByDocument | spec/domains/knowledge.md#DocumentRepository | ドキュメント ID → 出典リンク一覧 |
| DOM-knowledge-052 | DocumentRepository.listSourceLinksByDocuments | spec/domains/knowledge.md#DocumentRepository | ドキュメント ID 群 → 出典リンクの一括逆引き（getTopic の関連メモを 1 クエリ化） |
| DOM-knowledge-053 | DocumentRepository.listSourceLinksByMemo | spec/domains/knowledge.md#DocumentRepository | メモ ID → 参照元ドキュメントのリンク一覧 |
| DOM-knowledge-054 | DocumentRepository.listSourceLinksByMemos | spec/domains/knowledge.md#DocumentRepository | メモ ID 群 → リンクの一括逆引き（タイムライン 1 ページ分を 1 クエリ化） |
| DOM-knowledge-055 | DocumentRepository.deleteSourceLinksByMemo | spec/domains/knowledge.md#DocumentRepository | メモのハードデリートに伴うリンク消去（ADR-003、同一 UoW・冪等）。**userId を第一引数に取らず、documents 側 JOIN によるスコープ規則も持たない**（到達可能性で閉じる） |
| DOM-knowledge-056 | TopicRepository.recalculatePurgeAfter | spec/domains/knowledge.md#TopicRepository | 保持日数変更に伴う `purgeAfter` の一括更新（契約は `MemoRepository` の同名メソッドと同じ。OCC トークンを取らず version も進めず、残件の有無を返す） |
| DOM-knowledge-057 | DocumentRepository.recalculatePurgeAfter | spec/domains/knowledge.md#DocumentRepository | 同上（ゴミ箱内ドキュメントが対象） |

## search

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-search-001 | SearchQuery 値オブジェクト | spec/domains/search.md#SearchQuery | keyword（trim 後非空 EmptyKeyword・500文字以内 KeywordTooLong）・任意 topicId・limit（1〜100）・任意 cursor を持ち create で検証する。**userId はフィールドに持たない**（DO 選択で消費済み）。**cursor は「非空の不透明文字列であること」（形式）だけを見る** — 中身と有効期限は SearchIndexPort.query の判定であり、create は復号も現在時刻の参照もしない。どちらの違反も InvalidCursor |
| DOM-search-002 | SearchResultItem 値オブジェクト | spec/domains/search.md#SearchResultItem | memo / document の直和型。snippet 非空、事実データのみ（要約・再構成禁止）、type + id で同一性（重複ヒットは 1 件に統合） |
| DOM-search-003 | IndexEntry 値オブジェクト | spec/domains/search.md#IndexEntry | memo / document の直和型で、`search_entries` の1行に対応する projection の値。削除済み対象から構築禁止、sourceOfDocumentIds / sourceMemoIds は相手が active な ID のみ含める（ゴミ箱の存在事実を露出させない） |
| DOM-search-004 | SearchIndexPort.query | spec/domains/search.md#SearchIndexPort | **唯一のメソッドであり同期契約**（`Promise` を返さない）。全文一致を `bm25` と安定 tie-breaker（`timestamp DESC, type, id`）で順位付けした単一結果を返す。検索の規則（到達可能性による境界・ゴミ箱除外・アーカイブはヒット・optional 単一 topic 絞り込み・事実データのみ・カーソル）を満たし、0 件は空の SearchPage。**カーソルの中身と有効期限の判定はここが担う**（不正・期限切れは InvalidCursor、未知・ゴミ箱内トピックは TOPIC_NOT_FOUND）。**書き込み側はポートではない**（本体を書くトランザクション内の projection 処理へ畳まれる） |
| DOM-search-013 | SearchCursor 値オブジェクト | spec/domains/search.md#SearchQuery | 不透明な文字列。中身の解釈は SearchIndexPort の実装に閉じ、利用者・ユースケースは解釈せず次の要求へそのまま渡す。有効期限を持ち、**期限切れの判定はポートの実装が行う**（期限切れは InvalidCursor） |
| DOM-search-014 | SearchPage 値オブジェクト | spec/domains/search.md#SearchPage | `PaginationResult<SearchResultItem>` に `nextCursor?: SearchCursor` を添えた形。count はスナップショットに固定した集合の総件数。続きが無ければ nextCursor は undefined |

## trash

| ID | 要素 | 定義場所 | 実装されるべき振る舞いの要点 |
|----|------|---------|------------------------------|
| DOM-trash-001 | TrashItem 値オブジェクト | spec/domains/trash.md#TrashItem | memo / document / topic の直和の読み取り専用ビュー。**expiresAt は保存値（各エンティティの `purgeAfter`）をそのまま返す**、topic は setDocumentIds を持つ。ドメイン層は型定義のみでファクトリを置かない |
| DOM-trash-002 | RestorePolicy ドメインサービス | spec/domains/trash.md#RestorePolicy | 純関数 decideDocumentRestore がトピック現況（active / trashed / hardDeleted）から restoreAlone / restoreWithTopic / selectDestination の 3 分岐を判定する |
| DOM-trash-003 | HardDeletePolicy ドメインサービス | spec/domains/trash.md#HardDeletePolicy | 純関数 expandTargets が TrashItem を種別ごとの消去対象 ID 集合（HardDeletePlan）に展開する。トピックは setDocumentIds を含め、個別削除分は含めない |
| DOM-trash-004 | RetentionPolicy ドメインサービス | spec/domains/trash.md#RetentionPolicy | 純関数。expiresAt = trashedAt + retentionDays、**isExpired は保存値を入力に取る（`isExpired(purgeAfter, now)`）**。**算出結果は保存する**（ソフトデリートで `purgeAfter` に設定し、復元で必ず null へ戻す）。判定の権威は保存値であり、保持日数の変更直後は再計算が済むまで算出値と一致しない。保持日数の変更は同一トランザクションでゴミ箱内全項目の `purgeAfter` を再計算し、遡及適用を成立させる |
| DOM-trash-005 | TrashQueryPort.listTrashItems | spec/domains/trash.md#TrashQueryPort | ゴミ箱一覧を削除日時降順・ページング付きで返す。**retentionDays 引数を取らず** expiresAt には保存済みの purgeAfter を載せ、topic の setDocumentIds を trashedWith から射影して埋める |
| DOM-trash-006 | TrashQueryPort.findTrashItem | spec/domains/trash.md#TrashQueryPort | TrashItemRef による単一取得（復元・ハードデリートの対象確認用）。ゴミ箱にない場合は null |
| DOM-trash-007 | TrashQueryPort.countTrashItems | spec/domains/trash.md#TrashQueryPort | ゴミ箱の総件数を返す（「空にする」の件数確認 S-TR-04 用） |
| DOM-trash-008 | TrashQueryPort.listItemsToPurge | spec/domains/trash.md#TrashQueryPort | 自 DO のゴミ箱から**保存された `purgeAfter` が now を過ぎた項目**を limit 件まで `purgeAfter` 昇順で返す（`purge-trash` ジョブの駆動源）。**`userId` を取らず、全ユーザー横断で舐めるメソッドも持たない**。引き方は `purgeAfter` の索引であり、`trashedAt` と保持日数からの算出ではない |
| DOM-trash-009 | TrashQueryPort.findEarliestPurgeAfter | spec/domains/trash.md#TrashQueryPort | ゴミ箱内の `purgeAfter` の最小値（無ければ null）。ソフトデリート・保持日数変更・ジョブ完了時の再武装が、次の起床時刻の材料として読む。**本メソッドは材料を返すだけで投入は行わない** — 投入口は UnitOfWork コンテキストの `enqueueJob` であり、**投入点は5つで全数である**（memo の `softDeleteMemo` と AI `delete`、knowledge の `trashDocument` と `trashTopic`、identity の `changeTrashRetentionDays`）。**1つでも書き落とすと、最初の `purge-trash` が空のゴミ箱で完走した時点で待機状態に落ち、以後どれだけソフトデリートしても自動ハードデリート（S-TR-05）が二度と走らない** |

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
| DOM-export-009 | ExportRenderer ドメインサービス | spec/domains/export.md#ExportRenderer | 純関数 render(source, exportedAt, timezone) がアーカイブ構成の規則（マニフェスト・日別メモ・トピックメタ・ドキュメント・スラッグ導出と衝突解決・出典の相対パス解決・deleted: true 規則）どおり ExportArchive を導出する。実行位置はリクエストを受ける側 |
| DOM-export-010 | ExportSourceReader.readAll | spec/domains/export.md#ExportSourceReader | **同期契約で引数を取らない**（`userId` は DO 選択で消費済み）。ユーザーの全データをゴミ箱除外・最新リビジョンのみで Durable Object 内の1回のトランザクションで読み切り ExportSource に組み立てる。**1回で返せる総バイト数に上限があり、超過は拒否する**（SystemError 系） |
| DOM-export-011 | ArchiveWriter.write | spec/domains/export.md#ArchiveWriter | **同期契約**。ExportArchive を rootDirName/ 配下に格納した zip にエンコードし ArchiveBinary を返す。失敗は SystemError(ArchiveEncodingError)。**実行位置は Durable Object の外（リクエストを受ける側）である** |
