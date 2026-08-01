# レビュー 001 — ドメイン・ユースケース

**対象:** PR #46（Issue #35）/ ベースブランチ `main` / 変更 80 ファイル
**基準:** `CLAUDE.md`・`.thread/35/plan.md`（AC-3 / AC-6 / AC-6b）・`.thread/34/design.md`（第7.1 / 7.2.1 / 7.3 / 4.5 / 6.6 / 8.2 / 8.2.1 節）・`.thread/35/adr.md`

## ドメイン・ユースケース

### 受け入れ基準の判定（この観点の担当分）

| 基準 | 判定 | 根拠 |
|---|---|---|
| AC-3（`V-3` = 0 行） | **不合格** | grep は 0 行だが、**意味としてのドメインイベントが 3 ファイル 4 行残っている**（B-001）。走査語にも `イベント` にも掛からない形 |
| AC-6（`SearchIndexPort` が `query` 1本・`Promise` なし） | **合格**（ただし B-007） | `spec/domains/search.md:185-188` は `query` 1メソッド・同期。`IndexerReadPort` / `EmbeddingPort` / `upsert*` / `remove*` は `spec/` 全域で 0 行。第7.2.1節の4点も「検索の規則」に載っている |
| AC-6b（4点が適用先へ届いている） | **合格** | `TOPIC_NOT_FOUND` が domains（`:165` / `:198`）と usecases（`:85`）の**両方**のエラー表にある。`grep -nw page` は 3 ファイルとも 0 行。`SearchPage` / `SearchCursor` / `nextCursor` が domains → usecases → pages → inventory の4層で閉じている |
| スコープ超過（#45 の先取り） | **合格** | `spec/usecases/identity.md` / `spec/testcases/identity/{changePassword,executePasswordReset,registerOrLoginWithSso}.md` は「中間状態の観測結果」と「終端後の観測結果」までで止まり、巻き戻す列の列挙・段構成・終端モードの印・再試行上限をどこにも書いていない。`#45` を名指しした dangling 回避も入っている（ADR-009 の線を守れている） |

### Blockers

- **[B-001]** ドメインイベントが「イベント名だけの期待値」として 3 ファイル 4 行残っている（AC-3 違反）
  - 場所: `spec/testcases/knowledge/updateTopic.md:8` / `:12`、`spec/testcases/knowledge/trashTopic.md:9`、`spec/testcases/knowledge/editDocumentByAi.md:7`
  - 該当行:
    - `updateTopic.md:8` — 「説明文が変更され `version + 1`。**`topic.updated` が記録される**」
    - `updateTopic.md:12` — 「**`topic.archived` / `topic.unarchived` が各 1 件記録される**（エッジケース: 状態往復）」
    - `trashTopic.md:9` — 「トピックのみ trashed になり `trashedDocumentIds: []`。**`document.trashed` は発行されない**（境界値: セット 0 件）」
    - `editDocumentByAi.md:7` — 「`latestRevision + 1` の新リビジョン…が積まれ、**`document.edited` が記録される**」
  - 理由: 設計 第7.3節は「イベントは transport としても**業務表現としても**残らない」と断定しており、`spec/domains/knowledge.md` からイベント定義表は削除済みなので、これらは定義の無い識別子を期待値にしている状態である。`.thread/35/adr.md` ADR-028 は同じ形（イベント名だけで走査語に掛からない行）を **trash 系 11 行についてだけ**洗い出しており、knowledge 系を射程に入れていない。**同じファイルの隣の行は projection 表現へ直っている**（`updateTopic.md:7` は「トピックはインデックスエントリを持たないので projection の更新は発生せず…」、`trashTopic.md:7` は「配下 2 件のエントリが同一 `transactionSync` の中で…除去され」）ので、取り残しであることは明白。さらに `spec/inventory/test.md` 側は既に直っており（`:395` TC-trashTopic-003 は「配下のエントリ除去が起きなければ PASS」）、**台帳とテストケース本体が矛盾している**
  - 提案: ADR-028 の (A) を同じ基準で適用する。`updateTopic.md:8` は「説明文が変更され `version + 1`。トピックはエントリを持たないので projection の更新は発生しない」、`:12` は「`version` は 2 回分進み、状態が `archived` → `active` と往復する」、`trashTopic.md:9` は「配下が 0 件なので projection の更新は発生しない」、`editDocumentByAi.md:7` は「同じ `transactionSync` の中で当該ドキュメントのエントリが作り直される」。あわせて `.thread/35/adr.md` ADR-028 の「全数は次の11行である」を訂正する（実際は 15 行）

- **[B-002]** テナント分離の根拠が `userId スコープ` のまま 20 ファイル 34 行残っている
  - 場所: `spec/inventory/test.md`（14 行）、`spec/usecases/memo.md:369`、`spec/testcases/knowledge/{createDocument:22, diffDocumentRevisions:14, editDocument:22, editDocumentByAi:29, getDocument:12, getTopic:18, listDocumentRevisions:12, listDocumentSourceMemos:16, listDocumentsReferencingMemo:14, rollbackDocument:20, trashDocument:12, trashTopic:14, updateTopic:20}.md`、`spec/testcases/memo/{diffMemoRevisions:15, getTimeline:22, rollbackMemo:18}.md`、`spec/testcases/trash/{emptyTrash:16, restoreMemo:14}.md`
  - 理由: `spec/domains/index.md:32` は「**構造的保証の在り処は「型（第一引数の `userId`）」ではなく「到達可能性」である**」「**例外は無い**」と断定し、`spec/database/index.md:18` は「どのテーブルも `user_id` 列を持たず」と書いている。ところが上記 34 行は「**`userId` スコープにより `NotFoundError`**」という**消えた機構**を期待値の根拠として名指ししたままである。`#37` はテストケースと台帳を実装チェックリストとして読むので、存在しない `userId` 引数付きクエリを探すことになる。同種の行のうち `spec/testcases/trash/listTrash.md:19` だけは「保証は列条件ではなく到達可能性による — 自分の Durable Object の中に他ユーザーの行が原理的に存在しない」へ直っており、**同一 PR の中で処理方針が割れている**
  - さらに悪いことに、**8 ファイルは PR で1文字も触られていない**（`knowledge/{getDocument,getTopic,listDocumentRevisions,listDocumentSourceMemos,listDocumentsReferencingMemo,diffDocumentRevisions}.md` / `memo/{getTimeline,diffMemoRevisions}.md`）。`.thread/35/coverage.md:96-98,110` はこれらを「**影響なし**」と判定しているが、いずれも旧テナント分離機構を本文に持つので判定が誤り（AC-16 の再走査が「語彙走査で拾えない」形を取り逃している。`.thread/34/handoff.md` 第4節 罠1 そのもの）
  - 提案: `userId スコープにより` を「到達可能性により（自分の Durable Object の中に他ユーザーの行が存在しない）」へ一律置換する。`listTrash.md:19` の文言が手本になる。あわせて `.thread/35/coverage.md` の当該 8 ファイルの判定を「改訂」へ格上げし、完了ゲートに `grep -rn 'userId スコープ' spec --include='*.md' | grep -v /review/` が 0 行であることを足す（負の検証に1本足すだけで再発を防げる）

- **[B-003]** `pruneExpiredTrashItems` の「期限切れ項目の列挙」に対応するポートが `spec/` のどこにも無い
  - 場所: `spec/usecases/trash.md:335`（手順3「自分の Durable Object の索引から `purgeAfter < now` のゴミ箱項目を `chunkLimit` 件まで取得する」）/ `spec/domains/trash.md:220`・`:245` / `spec/inventory/usecase.md:57`
  - 理由: `TrashQueryPort` から `listExpiredItems` を削除した（ADR-020）一方で、**代替の読み取り契約をどこにも置いていない**。`spec/domains/trash.md:220` は「全ユーザー横断で期限切れを列挙するメソッドは持たない…memo / knowledge のリポジトリにも cutoff 日時ベースの期限切れ列挙メソッドを置かない」、`spec/domains/memo.md:323` と `spec/domains/knowledge.md:419`・`:507` も「本ポートには列挙メソッドを置かない」と3ドメインで一致して**拒否**しており、`TrashQueryPort` の残る3メソッド（`listTrashItems` / `findTrashItem` / `countTrashItems`）はどれも期限で引けない。application 層のユースケースがポート無しで DB を引くのは `CLAUDE.md`「Adapters — Concrete implementations of ports per provider」および依存方向の規約に反する
  - 決定的なのは `spec/testcases/trash/pruneExpiredTrashItems.md:21`「**期限切れ項目の列挙自体が DB 例外で失敗する** → `SystemError(DatabaseError)`」で、**契約の無い呼び出しに対するエラーケースだけが定義されている**（台帳にも `TC-pruneExpiredTrashItems-016` として存在する）
  - 提案: `TrashQueryPort` に自 DO スコープの `listExpiredItems(now: Date, limit: number): readonly TrashItem[]`（`userId` 引数なし・同期契約・`purge_after` 索引で引く）を戻す。`V-4` の走査語に `listExpiredItems` が入っているのでメソッド名を変えるなら `listItemsToPurge` 等にし、`V-4` から語を落とす判断を `.thread/35/adr.md` に記録する。`spec/inventory/{domain,adapter}.md` に `DOM-trash-008` / `ADP-trash-004`（欠番のため新規採番）を末尾 append する

- **[B-004]** `purgeAfter` の一括再計算に対応する書き込み経路が無い
  - 場所: `spec/usecases/identity.md:473`（「**同じトランザクションでゴミ箱内の全項目の `purgeAfter` を再計算し**」）/ `spec/domains/trash.md:188` / `spec/inventory/usecase.md:19`
  - 理由: 再計算は `memos` / `topics` / `documents` の3テーブルへの一括 UPDATE だが、`MemoRepository` / `TopicRepository` / `DocumentRepository` は `save(entity, expectedVersion)`（OCC 付き単体上書き）しか持たない。全項目を `find` → `save` で回すと OCC トークンが要り「同一トランザクションで一括更新」という記述と噛み合わず、一括 UPDATE 用のメソッドはどのポートにも無い。`CLAUDE.md`「Unit of Work」は UoW コンテキストの書き込み経路を「**Those two groups are the complete set of write paths**」と閉じた集合として宣言しているので、規約上この操作を書く場所が存在しない
  - `spec/testcases/identity/changeTrashRetentionDays.md:19-20` は「3 件すべての `purgeAfter` が再計算され」「再計算はチャンクに分けて進められ、残件がある間は…」まで要求しており、**残件（再計算カーソル）の置き場も `spec/` に無い**（`spec/database/index.md` の User Data DO 16 テーブルにも該当する列・行が見当たらない）
  - 提案: 3リポジトリに `recalculatePurgeAfter(retentionDays, chunkLimit): { done: boolean }` 相当を置くか、`RetentionPolicy` を入力に取る trash 側の書き込みポートを1本だけ新設する（trash が書き込みポートを持たない原則の明示的な例外として `spec/domains/trash.md`「書き込みポートについて（設計判断）」に理由ごと書く）。残件の置き場は ADR-013 と同じ形で「物理形は #37 が決める」と1行預けてよいが、**預け先を名指しした行が無いと dangling になる**

- **[B-005]** `CredentialRef` に「ログイン手段になり得るか」を表すフィールドが無く、ドメイン不変条件も UI 判定も成立しない
  - 場所: `spec/domains/identity.md:52-58`（`CredentialRef` 定義）・`:116`（不変条件）・`:96`（`removeCredential`）・`:109` / `spec/usecases/identity.md:504`（`getCurrentUser` 出力 DTO）/ `spec/pages/index.md:223` / `spec/inventory/frontend.md:67`
  - 理由: `CredentialRef = { credentialId, kind, label }` の3フィールドしか無い。ところが同じファイルの不変条件は「`credentials` は常に1件以上で、**そのうち少なくとも1件はログイン手段である**。…数えるのは要素数ではなく**ログイン手段になり得るクレデンシャルの `credentialId` の異なり数**である」と書いており、**その「ログイン手段になり得るか」を表す情報が型に無い**。SSO 専用アカウントは `[sso, email（ログイン手段ではない）]` の2件を持つ（`:132`「SSO 初回登録でもメールのクレデンシャルが1件置かれる…この要素は**ログイン手段ではない**」）ので、`kind` でも要素数でも判定できない。結果として `User.removeCredential`（純関数）は「解除後に1件も残らない場合は `BusinessRuleError(LastCredentialRemoval)`」を**エンティティの状態だけでは決められない**
  - 同じ穴が UI 側にも抜けている。`spec/pages/index.md:223` と `spec/inventory/frontend.md:67` は「判定は『保有クレデンシャル集合に **`usableForLogin = true`** の `kind = 'email'` の要素があるか』で行う」と書いているが、`getCurrentUser` が返す `credentials` は `{ credentialId, kind, label }` の3つ組であり `usableForLogin` を含まない。`usableForLogin` は `credential_locators`（`spec/inventory/adapter.md:21`）と `CredentialMapping`（`spec/domains/identity.md:384`）にしか無く、**どちらも `getCurrentUser` の経路（`UserSettingsRepository.find()`）に乗っていない**
  - 提案: `CredentialRef` に `usableForLogin: boolean` を足す（非 PII であり `credential_locators.usable_for_login` と1対1）。これで不変条件が型の中で決定可能になり、`getCurrentUser` の DTO と P-13 / `PAGE-settings-005` の判定条件も一致する。`spec/inventory/domain.md:8`（`DOM-identity-001`）の要点欄も同時に直す。**足さない選択を採るなら**、不変条件の文面を「`kind: "sso"` の要素が2件以上あるときだけ解除できる」のように `kind` だけで決まる形へ書き換え、P-13 / frontend 台帳の判定条件も `usableForLogin` を使わない形へ揃える（どちらか一方に倒すこと。現状は両者が食い違っている）

- **[B-006]** `executePasswordReset` の処理フローに `sessionEpoch` の前進が無いのに、テストケースと台帳はそれを要求している
  - 場所: `spec/usecases/identity.md:241-242`（手順5〜6）/ `spec/inventory/usecase.md:12`（`UC-identity-006`）↔ `spec/testcases/identity/executePasswordReset.md:24` / `spec/inventory/test.md:111`（`TC-executePasswordReset-018`）
  - 理由: `changePassword` は手順6で「**ユーザー単位設定側でセッションの世代を進める**」と明記しているのに、`executePasswordReset` の手順6は「リセット完了を契機とする AI クライアント接続の自動失効を適用する」だけで `sessionEpoch` に触れていない。台帳 `UC-identity-006` も同様に落としている。一方でテストケース `:24` は「`sessionEpoch` が前進しているため次のリクエストで失効する」を要求し、台帳の `TC-executePasswordReset-018` も同じ。**正本は設計側にあり**、`.thread/34/design.md:1331`（第6.5.1節 phase 2）は「`operations` に記録し、**`sessionEpoch` を1つ進め**、…`changeOrigin = 'reset'` の場合に限り…`account.resetVersion` を1つ進め」と、リセットでも前進することを断定している。したがって**ユースケース側の取り残し**である
  - 影響は表記の問題に留まらない。`spec/usecases/identity.md` だけを読んで実装すると、**パスワードをリセットしても侵害者の既存セッションが失効しない**（リセットは侵害からの復旧手順であり、`spec/scenario/account.md:74` と `spec/pages/index.md` P-03 の「必須導線」節はまさにその文脈で書かれている）
  - 提案: 手順6を「**ユーザー単位設定側でセッションの世代を進め**、リセット完了を契機とする AI クライアント接続の自動失効を適用する」に直し、`spec/inventory/usecase.md:12` の要点欄にも `sessionEpoch` の前進を足す

- **[B-007]** 不透明カーソルの「期限切れ」判定が `SearchQuery.create`（純粋な値オブジェクト構築）に置かれていて実装できない
  - 場所: `spec/domains/search.md:44`（バリデーションルール）・`:49`（`SearchCursor` の定義）・`:58-65`（`create` シグネチャ）・`:199`（ポートのエラーケース）/ `spec/usecases/search.md:24`・`:66` / `spec/inventory/domain.md`（`DOM-search-001` / `DOM-search-013`）
  - 理由: 3つの記述が両立しない。(i) `SearchCursor` は「**不透明。中身の解釈は `SearchIndexPort` の実装に閉じる**」（`:49`・`:171`）、(ii) にもかかわらず `SearchQuery` のバリデーションルールは「`cursor` が不正**または期限切れ**なら `BusinessRuleError(SearchErrorCode.InvalidCursor)`」（`:44`）、(iii) `SearchQuery.create` は `now` を受け取らない（`:59-65`）。`CLAUDE.md`「Domain — Pure business logic … **No I/O, no framework, no ambient time**」の下では、`create` は復号もできず現在時刻も持てないので期限判定は原理的に不可能。`spec/usecases/search.md:24`「不正・期限切れは **`SearchQuery.create` が拒否する**」・`:66`「`cursor` の妥当性の検証はここ（ドメイン）で行われる」がこの誤りを下流へ伝播させている
  - 同じ判定が `SearchIndexPort.query` のエラーケース（`:199`）にも重複して置かれており、**責務の所在が2箇所ある**。`.thread/35/adr.md` ADR-013 が「スナップショットの物理形は #37 が決める」と預けた以上、有効期限の判定はポート実装側にしか置けない
  - 提案: `SearchQuery` の規則を「`cursor` は非空の不透明文字列であること（形式のみ）」に狭め、「不正・期限切れの判定は `SearchIndexPort.query` が行い `InvalidCursor` を返す」と明記する。`spec/usecases/search.md:24` / `:66` の「`SearchQuery.create` が拒否する」も同じ向きに直す（エラーケース表 `:84` は行き先が書かれていないので触らなくてよい）。`spec/inventory/domain.md` の `DOM-search-001` / `DOM-search-013` の要点欄も追随させる

### Warnings

- **[W-001]** `CredentialMappingRepository` に書き込みメソッドが1本も無く、Directory 側への書き込みがユースケースの散文にしか存在しない
  - 場所: `spec/domains/identity.md:369-389`（ポート定義とその注記）/ `spec/usecases/identity.md:43`・`:47`（`registerWithPassword` 手順4・6）・`:93`・`:97`（SSO）・`:241`（リセット）・`:283`（変更）
  - 理由 / 提案: 「予約行を書く」「予約を確定させ、パスワードの検証材料を記録する」「検証材料を新しいものへ差し替え、未使用トークンをすべて無効化する」はいずれも書き込みだが、対応するポートメソッドが無い。`spec/domains/identity.md:389` は「登録・変更・解除の手順そのものは単一のメソッドに畳めない。…順序と再開の規則を持つ手続きとして usecases/identity.md に書く」と宣言し、`.thread/35/adr.md` ADR-025 も同じ判断を記録しているので**意図的**だが、結果として **#37 は Directory 側の書き込みについて実装すべき契約を1つも持たない**（`spec/inventory/{domain,adapter}.md` にも行が無い）。B-003 / B-004 と同じクラスの穴が、こちらは「意図的」というラベルで通っている。少なくとも「予約の獲得」「予約の確定」「検証材料の差し替え」の3つは戻り値と CAS 条件が決まっているので、`spec/domains/identity.md` に**手続きの各段が呼ぶ操作名だけでも列挙する**（1メソッドに畳まないことと、契約を書かないことは別）

- **[W-002]** 非集約ストア（`credential_locators` 等）が domain 側に契約を持たないまま、ユースケース・テストケースがその読み取りを前提にしている
  - 場所: `spec/usecases/identity.md:141`（`loginWithPassword` 手順5「到達可能性を検査する」）/ `spec/testcases/identity/loginWithPassword.md:18-19`・`:22` / `spec/inventory/adapter.md:21` / `CLAUDE.md`（UoW コンテキストの `credentialLocatorStore` / `resetTokenStore` / `rotationCheckpointStore`）
  - 理由 / 提案: `grep -rn 'locator' spec/domains spec/usecases` が **0 行**である一方、`credential_locators` はテーブル定義（`spec/database/index.md`）とアダプター台帳にだけ存在する。`spec/testcases/identity/loginWithPassword.md:19` は「ユーザー単位設定側の **`credentialVersion`** が認証情報側の値と一致しない → 拒否」を要求するが、`credentialVersion` は `User` にも `CredentialRef` にも無く、`credential_locators` にしかない。到達性検査がどのポートを通るのかが `spec/` の inward 側から辿れないので、`spec/domains/identity.md` のポート節に非集約ストアの契約（少なくとも「到達性検査は `credentialId` だけを見て `generation` を含めない」という規則の置き場）を1つ足すか、`spec/database/index.md` への預け先を1行で明示する

- **[W-003]** 新設した不変条件「`trashed` ⇔ `purgeAfter` を持つ」を検証するテストケースが1件も無い
  - 場所: `spec/domains/memo.md:76`（不変条件8）・`spec/domains/trash.md:187` ↔ `spec/testcases/memo/softDeleteMemo.md`・`spec/testcases/memo/delete.md`・`spec/testcases/knowledge/{trashDocument,trashTopic}.md`・`spec/testcases/trash/{restoreMemo,restoreDocument,restoreTopic}.md`
  - 理由 / 提案: `grep -rn 'purgeAfter' spec/testcases` は identity / trash の一部（`changeTrashRetentionDays` / `pruneExpiredTrashItems` / `listTrash`）にしか当たらない。ソフトデリート側は「`status: "trashed"`・`trashedAt = now`・`version` +1」までしか期待していないし、復元側は `purgeAfter` の解除に一言も触れていない。`spec/domains/trash.md:187`・`:240` は「**戻さないと駆動源が過去へ固定され、起床が止まらなくなる**」と、落とし忘れが機能停止に直結すると自ら書いている箇所である。ソフトデリート系4ファイルに「`purgeAfter` が `RetentionPolicy.expiresAt(now, retentionDays)` と一致する」、復元系3ファイルに「`purgeAfter` が落ちる」を1ケースずつ足す（台帳 `spec/inventory/test.md` は末尾 append）

- **[W-004]** `requestPasswordReset` / `executePasswordReset` に旧語彙（`SsoUser` 前提）と旧契約が残っている
  - 場所: `spec/usecases/identity.md:183`（概要）・`:214`（エラーケース表は「メール未登録 / SSO 専用アカウント / スロットル中」へ直っているが概要は未更新）・`:253`（`executePasswordReset` エラーケース表「**対象が SSO ユーザー**（防衛的）」）
  - 理由 / 提案: `:183` は「未登録メール、および **SSO ユーザー**のメールに対してはトークンを発行せずメールも送らない」のままで、同ファイル手順3〜4 が新たに置いた中核契約（**4ケースで処理経路を完全に一致させ、どのケースでも同じトランザクションで送信ジョブ行を1行書く**）に触れていない。概要だけを読むと「送らないケースでは何も書かない」と読め、列挙オラクルを作る実装になる。`:255` の「対象が SSO ユーザー」も、判別共用体を廃止した後は「対象クレデンシャルがパスワードの検証材料を持たない」が正しい

- **[W-005]** trash の「期限切れ」のユビキタス言語定義が保存済み `purge_after` 方式と食い違い、`RetentionPolicy.isExpired` が呼び出し元を失っている
  - 場所: `spec/domains/trash.md:21`（ユビキタス言語）・`:178-180`（`isExpired`）
  - 理由 / 提案: `:21` は「Expiration | 期限切れ | **`trashedAt + retentionDays` が現在時刻を過ぎた状態**」のままで、これは「照会時算出」時代の定義である。同じファイルの `:188-189` は「**延長方向の変更では、再計算が済むまで削除を進めない**」と書いており、**再計算が終わるまで `trashedAt + retentionDays` と `purgeAfter` は一致しない**ことを設計自身が認めている。判定の権威は `purgeAfter` なので `:21` を「保存された `purgeAfter` が現在時刻を過ぎた状態」へ直す。あわせて `isExpired(trashedAt, retentionDays, now)` は改訂後どこからも呼ばれない（ジョブは `purgeAfter < now` で引く）ので、`isExpired(purgeAfter, now)` へシグネチャを寄せるか「算出規則の対照用に残す」と用途を明記する

- **[W-006]** AI 経路の `delete` / `post_memo` の処理フローが `Memo.softDelete` の新シグネチャに追随していない
  - 場所: `spec/usecases/memo.md:573`（`delete`）・`:435`（`post_memo`）
  - 理由 / 提案: `:573` は「softDeleteMemo と同一: UoW 内で `findById` → `Memo.softDelete` → `save` → 同一 `transactionSync` での projection 更新」と書いているが、`Memo.softDelete(memo, purgeAfter, now)` は引数が1つ増えており、人間 UI 側（`:395`）にある `UserSettingsRepository.find()` → `RetentionPolicy.expiresAt` の手順が抜けている。台帳 `UC-memo-014` は正しく `purgeAfter` 算出を含んでいるので、ユースケース本文だけがずれている。「softDeleteMemo と同一（保持日数の読み取りと `purgeAfter` の算出を含む）」と補うだけでよい

### Notes

- **[N-001]** `SearchIndexPort` の縮小は狙いどおり効いている。`spec/domains/search.md:194` が「**書き込み側はポートではない**…ポートにすると DI で単独注入でき、本体更新と同じトランザクションの外から呼べる経路が構造的に残るため」と**行き先と理由の両方**を残しており、ADR-001 が懸念した「search の `spec/` を読んでもインデックスの書き方が分からなくなる」を「インデックスの維持」節の契機表（`:231-243`）で埋めている。契機表は 11 行あり、memo / knowledge / trash の各ユースケースの projection 記述と1対1で照合できる（実際に照合したが不整合は無かった）

- **[N-002]** ポートの同期化と例外の維持は全ドメインで一貫している。`grep -rn 'Promise' spec/domains/*.md` のヒットは `PasswordHasher.hash` / `verify` と `MailSender.sendPasswordResetMail` の3行だけで、`spec/domains/index.md:34` の「例外は `PasswordHasher` と `MailSender` の2つ」と過不足なく一致する。`spec/inventory/domain.md` の `DOM-identity-029/030/033` にも「**トランザクションの外で動くため Promise 契約のまま残る**」と理由つきで残っている

- **[N-003]** ADR-018 の非対称（エンティティの `userId` は残し、テーブルの `user_id` 列は落とす）は、`spec/domains/{memo:60, knowledge:133, knowledge:186, identity:138}.md` の4箇所すべてに**同一文言**（「値は所属する Durable Object の同一性そのものであり、行ごとの絞り込みには用いない」）が入っており、`spec/database/index.md:18` の「どのテーブルも `user_id` 列を持たず」および `:222`（「再水和時は DO の同一性（`_meta` の自 locator）から補う」）と橋渡しできている。**この非対称は各ファイルで矛盾なく説明されている**

- **[N-004]** `UserRepository` の分割は domains / usecases / 台帳の3層で一貫している。`grep -rn 'UserRepository' spec` は 0 行で、`UserSettingsRepository`（`insert` / `save` / `find`。`findById` を持たない理由も明記）と `CredentialMappingRepository`（3つの read）が `spec/inventory/domain.md` の `DOM-identity-018`〜`022` / `035` と1対1で対応する。ADR-011 / ADR-025 の欠番規約も守られており、`DOM-identity-013`〜`017` は欠番、`DOM-identity-023`〜`028` は改訂前と同じ `AiClientConnectionRepository` の6メソッドを指し続けている（#13 の参照が壊れない）

- **[N-005]** `maintainSearchIndex` はユースケース・テストケースファイル・台帳の3箇所から漏れなく消えている（`spec/testcases/search/maintainSearchIndex.md` 削除、`UC-search-002` 欠番、`grep -c 'TC-maintainSearchIndex' spec/inventory/test.md` = 0）。代わりに `spec/domains/search.md:245` が「トークナイザや正規化規則を変えたときの全件再構築は、migration の `reindex` ジョブが担う」と行き先を1行で残しており、ADR-003 が要求した dangling 回避が効いている

- **[N-006]** ページングの不透明カーソル方式は**検索だけ**に閉じており、trash の `listTrash`（`page` / `limit`）と衝突していない。ADR-012 / ADR-017 の射程（共通型 `PaginationResult` を広げず `SearchPage` で1フィールド添える）どおりで、`spec/usecases/search.md:31-37` の出力 DTO・`spec/pages/index.md:190`・`spec/inventory/frontend.md:74`（`PAGE-search-005`）まで届いている。過不足は無い

- **[N-007]** #45 の境界の守り方が良い。`spec/testcases/identity/changePassword.md:26` / `executePasswordReset.md:27` / `registerOrLoginWithSso.md:18` はいずれも「終端で中間状態が解除された → 旧パスワードでログインできる」という**利用者から観測できる結果**までで止め、「**終端の具体的な手順は #45 が定める**」と預け先を名指ししている。`changeState` の3値と `'advanced'` の意味も `.thread/34/handoff.md` 第3節の前方互換点4番の範囲に収まっており、巻き戻す列の列挙・段構成・材料寿命・再試行上限はどこにも書かれていない

- **[N-008]** `spec/testcases/identity/loginWithPassword.md:22`（「鍵ローテーション中で、`credential_locators` に同じ `credentialId` の行が両世代ぶん存在する → ログインできる」）は #44 の射程に触れているように見えるが、**ローテーションの手順ではなく到達性検査の不変（`generation` を判定に含めない）**を述べているだけで、#34 が残すと決めた材料（第4.1.1節）の範囲に収まっている。境界越えとは判定しない

### カバレッジ

一覧 80 件に 1 対 1 で対応させる（確認 70 / スキップ 10）。

**確認（70件）**

- 作業成果物（3）: `.thread/35/adr.md`, `.thread/35/coverage.md`, `.thread/35/plan.md`
- 規約（1）: `CLAUDE.md`
- ドメイン（7）: `spec/domains/export.md`, `spec/domains/identity.md`, `spec/domains/index.md`, `spec/domains/knowledge.md`, `spec/domains/memo.md`, `spec/domains/search.md`, `spec/domains/trash.md`
- ユースケース（6）: `spec/usecases/export.md`, `spec/usecases/identity.md`, `spec/usecases/knowledge.md`, `spec/usecases/memo.md`, `spec/usecases/search.md`, `spec/usecases/trash.md`
- 台帳（5）: `spec/inventory/adapter.md`（ポート対応行のみ）, `spec/inventory/domain.md`, `spec/inventory/frontend.md`（`PAGE-settings-005` / `PAGE-search-005` / `PAGE-password-reset-*`）, `spec/inventory/test.md`（イベント・テナント分離・`purgeAfter` 関連行）, `spec/inventory/usecase.md`
- テストケース（38）: `spec/testcases/export/exportAllData.md`, `spec/testcases/identity/{approveAiClientAuthorization,changePassword,changeTrashRetentionDays,denyAiClientAuthorization,executePasswordReset,getCurrentUser,listAiClientConnections,loginWithPassword,logout,registerOrLoginWithSso,registerWithPassword,requestPasswordReset,revokeAiClientConnection}.md`, `spec/testcases/knowledge/{createDocument,createTopic,editDocument,editDocumentByAi,rollbackDocument,trashDocument,trashTopic,updateTopic}.md`, `spec/testcases/memo/{delete,editMemo,postMemo,post_memo,rollbackMemo,softDeleteMemo,update_memo}.md`, `spec/testcases/search/maintainSearchIndex.md`（削除の妥当性）, `spec/testcases/search/search.md`, `spec/testcases/trash/{emptyTrash,hardDeleteTrashItem,listTrash,pruneExpiredTrashItems,restoreDocument,restoreMemo,restoreTopic}.md`
- 上流・横断（10）: `spec/database/index.md`（テナント分離宣言・`purge_after` 索引・`credential_*` 系・`jobs.kind` の観点関連部分）, `spec/idea.md`, `spec/index.md`, `spec/manual-tests/account.md`（カバレッジ表の「対象外」理由が到達性検査・中間状態に触れるため）, `spec/pages/index.md`, `spec/requirements.md`, `spec/scenario/account.md`, `spec/scenario/ai.md`, `spec/scenario/index.md`, `spec/scenario/search.md`

**スキップ（10件）**

- `.thread/35/steps.md` — 作業手順書。ドメイン / ユースケースの契約を定義しないため（判断根拠は plan.md と adr.md で足りる）
- `.thread/35/step14-checklist.md` — (A)/(B)/(C) 適用の照合表。B-001 の取り残しは実ファイル側で直接検出したため参照不要
- `.thread/35/testing.md` — 完了ゲートの検証手順。`V-*` / `P-*` は plan.md から逐語で実行済み
- `spec/manual-tests/ai.md` — ブラウザ手順書。ポート・ユースケース契約を定義しない
- `spec/manual-tests/document.md` — 同上
- `spec/manual-tests/index.md` — 件数表と実行順序のみ
- `spec/manual-tests/search.md` — 同上（FTS5 の確認項目は AC-11 / 手順書の観点）
- `spec/manual-tests/settings.md` — 同上
- `spec/manual-tests/timeline.md` — 同上
- `spec/manual-tests/trash.md` — 同上
