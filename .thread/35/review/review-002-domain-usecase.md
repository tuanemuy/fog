# レビュー002 — ドメイン・ユースケース観点 / Issue #35 / PR #46

**ラウンド:** 2（1ラウンド目の Blocker 10 / Warning 27 は `.thread/35/review/triage.md` で判定済み。再提出していない）
**射程:** 変更ファイル 97 件全量（`git diff origin/main...HEAD`）
**重点:** 1ラウンド目の修正（5人並列 + 追随2回）が互いを壊していないかの検出

## 機械ゲートの再実行結果（このラウンドで実測）

| 検査 | 結果 |
|---|---|
| `V-1`（ベクトル） | 0 行 |
| `V-3`（Outbox / イベント transport） | 0 行 |
| `V-3b`（イベント名 24 件の直接走査） | 0 行 |
| `V-4`（`SearchIndexPort` 書き込み / `listExpiredItems`） | 0 行 |
| `V-7`（非同期反映の約束） | 0 行 |
| `V-10`（page 番号方式） | 0 行 |
| `P-6`（`SearchIndexPort` が `query` 1本） | 満たす（`query(query: SearchQuery): SearchPage`。`Promise` なし） |
| `P-8`（台帳アンカーの実在） | 0 行 |
| ファイル数 | 102 |
| `UC-*` / `TC-*` / シナリオ実測 | 53 / 814 / 39（`spec/index.md` の記載と一致） |
| 成果物制約（`git diff --name-status`） | 0 行（スコープ超過なし） |

**意味走査の追加実施:** `イベント|event|購読|publish|subscribe` を `spec/**`（`review/` と `adr/` を除く）へ掛けて **0 行**。`通知|配送|伝播|非同期に反映|ワーカーが受け|キュー` の全ヒットを目視したが、残っていたのはすべて**否定形**（「配送する経路は無い」「通知を発行することもない」等）と、イベントと無関係な語（メールの配送先・UI の通知）だけだった。**AC-3 は `spec/` 側については満たされている。** ただし `CLAUDE.md` に1件残っている（B-004）。

**AC-6 / AC-6b:** 満たされている。`SearchIndexPort` は `query` 1本・同期契約。設計 第7.2.1節の4点（`bm25` + 安定 tie-breaker `timestamp DESC, type, id` / optional 単一 topic filter と `TOPIC_NOT_FOUND` / スナップショットページング / 削除・復元時の projection 同期）が `spec/domains/search.md:151,165,167,168-172` に載り、`TOPIC_NOT_FOUND` は `spec/domains/search.md:198` と `spec/usecases/search.md:85` の**両方**のエラーケース表にある。不透明カーソルの責任分割（形式＝`SearchQuery.create` / 中身・期限＝`SearchIndexPort.query`）は `spec/domains/search.md:44,170,199` → `spec/usecases/search.md:24,66,67,84` → `spec/testcases/search/search.md:45,46` → `spec/inventory/domain.md:127,130,131` で一貫している。

**`#45` の射程:** 先取りは W-005 の2行のみ。`spec/domains/identity.md:431` / `spec/usecases/identity.md:51,250,293,526` / `spec/database/index.md:460,616` はいずれも「一様な終端（記録を残して運用へエスカレーション）」で止まっており、巻き戻し手順・段構成・終端モードの印・材料寿命・再試行上限は書かれていない。

**ポートの `Promise` 契約:** 違反なし。`spec/domains/**` に残る `Promise` は `PasswordHasher.hash` / `verify`（`identity.md:570,572`）と `MailSender.sendPasswordResetMail`（`:611`）の3箇所だけで、`spec/domains/index.md:34` の例外列挙と一致する。

**`AccountStore` の分類確定:** ドメイン（`spec/domains/identity.md:378,457`）・DB（`spec/database/index.md:79,751`）・台帳（`spec/inventory/domain.md:41`）・`CLAUDE.md:68` の4箇所で「名前は `*Store` だが集約ルート側であり非集約ストア7つには数えない」で完全に一致している。**この論点に指摘は無い**（N-002 は分類そのものではなく、その根拠に使った列が未行使であることの記録）。

---

## Blockers

### [B-001] `purge-trash` の起床を張る投入点が、ソフトデリートの4ユースケースのどこにも無い

- 場所:
  - `spec/usecases/memo.md:394-397`（softDeleteMemo 手順 2-1〜2-4）
  - `spec/usecases/memo.md:573`（AI `delete`。「softDeleteMemo と同一」と宣言）
  - `spec/usecases/knowledge.md:534-535`（trashDocument 手順 3〜4）
  - `spec/usecases/knowledge.md:267-268`（trashTopic 手順 4〜5）
- 理由:
  - 正本は `spec/domains/trash.md:251-252` である — 「1. ソフトデリート時に `RetentionPolicy.expiresAt` を算出して `purgeAfter` に保存する / 2. **同じトランザクションで**「ゴミ箱内の `purgeAfter` の最小値」を求め（`TrashQueryPort.findEarliestPurgeAfter`）、それが現在予定されている起床より早ければ `purge-trash` ジョブを投入する」。`spec/usecases/trash.md:313` も「**ソフトデリート**と保持日数の変更が…起床時刻を張り」と断定し、`spec/inventory/adapter.md:131` も `findEarliestPurgeAfter` の読み手に「ソフトデリート」を名指ししている。
  - **ところが本 PR がソフトデリート側のユースケースへ足したのは `purgeAfter` の算出・保存までで、`findEarliestPurgeAfter` の読み出しとジョブ投入は4本とも1行も無い。** 4本はいずれも「算出 → `softDelete` → `save` → projection 更新」で終わっている。ソフトデリートのユースケースは memo / knowledge 側のこの4本しか存在しない（`spec/usecases/trash.md:11`「trash は書き込みポートを持たない」）ので、**張り直しの実施主体が spec 上に1つも無い。**
  - 帰結は機能の不成立である。`spec/database/index.md:484` は `purge-trash` を「完了時に自分を再武装する5種」に数えるが、再武装は残件があるときだけで、**ゴミ箱が空なら必ず `done` に落ちる**。`:456` は `done` からの復帰を「投入点からの再投入が唯一の再起動手段」と書いている。したがって投入点が無いと、**最初の `purge-trash` が空のゴミ箱で完走した時点で Alarm が恒久停止し、以後どれだけソフトデリートしても保持期限の自動ハードデリート（S-TR-05）が二度と走らない。**
  - 比較対象として `changeTrashRetentionDays` は張り直しまで書けている（`spec/usecases/identity.md:566` / `spec/inventory/usecase.md:19`）。**正本と片方の適用先だけが直り、もう片方（ソフトデリート4本）に届いていない**形で、`.thread/34/handoff.md` 第4節 罠1 そのものである。`.thread/35/adr.md` ADR-046 自身が「ソフトデリート・保持日数変更・ジョブ完了時の再武装が…と3箇所で書かれている」と書いているのに、3箇所のうちソフトデリートだけが実装契約を持たない。
- 提案: 4本の処理フローに、`save` / projection 更新と**同じ `transactionSync` の中で** `TrashQueryPort.findEarliestPurgeAfter()` を読み、それが現在予定されている起床より早ければ `purge-trash` を投入する手順を足す（**投入は早める方向にのみ効く**ことも併記する）。テストケース側（`spec/testcases/memo/softDeleteMemo.md` / `delete.md` / `spec/testcases/knowledge/trashDocument.md` / `trashTopic.md`）にも起床が張られることの期待値を1行足す。

### [B-002] 新設した `unlinkSsoCredential` の正常系が、既存ユースケースからは到達不能

- 場所: `spec/usecases/identity.md:494-537` / `spec/testcases/identity/unlinkSsoCredential.md:7,8,9,10,11,12` / `spec/domains/identity.md:97,132,479,633` / `spec/inventory/usecase.md:22`
- 理由:
  - テストケースの正常系は「`kind: "sso"` と `kind: "email"`（`usableForLogin: true`）の2件を持つアカウント」（`:7`）と「`kind: "sso"` を2件 + `kind: "email"`（true）」（`:12`）を前提にしているが、**この状態を作れるユースケースが spec に1つも無い。**
    - `registerWithPassword`（`spec/usecases/identity.md:45`）— `kind: "email"` / `usableForLogin: true` の**1件だけ**。SSO 要素を持たない。
    - `registerOrLoginWithSso`（`:96`）— `kind: "sso"`（true）+ `kind: "email"`（**false**）の2件。
    - **既存アカウントへ SSO 連携を追加するユースケースは存在しない。** `spec/domains/identity.md` のユースケース一覧（`:618-637`）にも無く、`User.addCredential`（`:97`）は呼び出し元を持たない。しかも同ファイルの `registerOrLoginWithSso` の項が「**アカウントリンクは現段階のスコープ外**」と明言し、`spec/scenario/account.md:29` も自動リンクを否定している。
    - `usableForLogin` を `false → true` へ遷移させる経路も「本設計に存在しない」と断定されている（`spec/domains/identity.md:78,126`）。
  - したがって到達しうるアカウント状態は「email(true) 1件」か「sso(true) + email(false)」の2つだけで、**`unlinkSsoCredential` は前者では (1-a) の `BusinessRuleError`、後者では `BusinessRuleError(LastCredentialRemoval)` にしか落ちない。正常終了する入力が存在しない。**
  - 波及は画面約束にまで及ぶ。`spec/pages/index.md` P-03 の必須導線「覚えの無い SSO 連携をその場で解除できる」、P-13 の「保有クレデンシャル一覧…解除は `unlinkSsoCredential` を呼ぶ」（`spec/inventory/frontend.md:73,75`）、`spec/scenario/account.md:74` の「覚えのない SSO 連携を解除できる」は、**いずれも常に空振りする導線**になる。設計 `design.md:732` が残余リスクの唯一の対策としてこの導線を置いた前提（「攻撃者が自分の SSO 主体を **link** する」）も、link が無い以上そもそも成立しない。
  - あわせて `spec/domains/identity.md:132`（「クレデンシャル集合は SSO 連携の**追加**・解除で増減する」）と `:479`（「**SSO 連携の追加**では [`sessionEpoch` を] 進めない」）は、存在しない操作を前提にした記述になっている。
  - **1ラウンド目 B-002 の修正（ユースケース2件の新設）が半分だけ入った形である。** triage の B-002 は「画面だけが約束して実装契約が無い」だったが、修正後は「実装契約はあるが到達できない」に移っただけで、画面の約束は依然として履行されない。
- 提案: どちらかに倒す。(a) 設計 第6.6節の link 手順を `linkSsoCredential` として `spec/usecases/identity.md` / `spec/domains/identity.md` のユースケース一覧 / `spec/inventory/{usecase,test}.md` に足す（`User.addCredential` の呼び出し元ができ、`unlinkSsoCredential` の正常系が到達可能になる。`sessionEpoch` を進めないことは既に `:479` に書かれている）。(b) link をスコープ外のまま据え置くなら、`unlinkSsoCredential` のテストケースの前提を到達可能な状態へ直し、P-03 / P-13 / S-AC-07 の「SSO 連携を解除できる」という約束と `spec/domains/identity.md:132,479` の記述を、到達可能な範囲に合わせて書き直す。**どちらを採るかは #35 の判断だが、現状の「約束と契約が両方あるのに到達経路だけが無い」は残せない。**

### [B-003] 12種のジョブの投入点が spec のどこにも無く、`spec/database/index.md:452` の委譲先の表に「投入点」欄が存在しない

- 場所: `spec/database/index.md:452`（委譲の宣言）/ `:469-481`（`kind` 全数表）/ `spec/usecases/identity.md:520-525`（`unlinkSsoCredential` 手順2）
- 理由:
  - `spec/database/index.md:452` は「**投入点の全数は下の `kind` 全数表が持つ**」と宣言している。ところが直下の全数表の列は `kind | 所有 DO クラス | 類型 | 用途` の4つで、**「投入点」欄が無い。** 委譲先が委譲された情報を持っていない。
  - 正本は設計 第7.4節の `kind` 全数表であり、そちらは「所有者・**投入点**・再武装分類」の3欄を持ち、`.thread/34/design.md` は「列を『所有者』だけにしない — 投入点と再武装分類を同じ表に持たせることで、**投入されるが二度と起きないジョブ**を表の空欄として検出できるようにする」と、欄の存在理由まで書いている（第1.4節 E-3 / I-1）。同節 (7) は「**投入点の無い周期・反復ジョブは、1回完走した時点で恒久的に停止する**」と断定している。
  - 実害が確定しているのは2件である。
    - **`purge-trash`** — B-001 のとおり、投入点が台帳にも散文にも無い。
    - **`sweep-orphan-mapping`** — 設計 第6.6節 unlink 手順2 が唯一の投入点として「`credential_locators` の削除と**同じ `transactionSync`** で自 DO の job table へ `sweep-orphan-mapping` を投入する」を要求し、「この一文が無いと `sweep-orphan-mapping` は投入点を持たないジョブになり、手順3 が落ちたときに Directory に残る `active` な孤児 mapping が恒久的に回収されない（＝その SSO 主体の永久ロック。第6.9節の登録事象）」とまで書いている。**`spec/usecases/identity.md:520-525` の unlink 手順にこの投入は無く、`sweep-orphan-mapping` という語は `spec/usecases/` にも `spec/domains/` にも1度も現れない。**
  - あわせて `spec/usecases/identity.md:522` の「**消す前に写像材料を控えておく**」は退避先を名指ししていない。設計は退避先を `operations.targetLocators` と特定しており、`.thread/34/handoff.md` 第2節「残すもの（#34 の成果。消してはならない）」が「**回収の材料が存在すること、およびその置き場**」を明示的に列挙している。`spec/database/index.md:498,504` は列と「終端の後始末が終わるまで消さない」までは書けているが、**書き手の側（unlink 手順2）と繋がっていない。** これも「正本だけ直して適用先に届かない」形である。
  - `recordOperation` / `updateOperation` / `enqueueJob` は `spec/usecases/**` にも `spec/domains/**` にも呼び出し箇所が **0 件**である。`CLAUDE.md:68` がこの3つ（+ `setMigrationCursor`）を「the in-transaction side-effect registration points」かつ非集約ストアへの書き込み経路の**閉じた集合**と宣言しているのに、それを使う場所が spec 側に1つも無い。
- 提案: `spec/database/index.md` の `kind` 全数表に「投入点」欄を復元し、12種すべてに書き手を入れる（`:452` の委譲宣言はそのまま活きる）。あわせて `spec/usecases/identity.md` の unlink 手順2 に「消す行の locator を全世代分 `operations.targetLocators` へ退避する」と「同じトランザクションで `sweep-orphan-mapping` を投入する」の2つを明記する。**これは #45 の射程ではない** — #45 が持つのは終端後の巻き戻し手順であって、正常系の前進ジョブの投入点は #34 が確定させた成果である。

### [B-004] `CLAUDE.md` の Layers 節に「domain events」が残っている（AC-3 の意味的残存）

- 場所: `CLAUDE.md:43`
- 理由:
  - 「**Domain** (`packages/core/src/domain/`) — Pure business logic: entities, value objects, domain services, port interfaces, **domain events**.」— ドメイン層の構成要素としてドメインイベントを列挙したままである。本 PR はこの行に触れていない。
  - 同じファイルの `:77` は「**There is no domain-event transport.**」と断定し、`spec/domains/index.md:35` は「エンティティの作成・更新・削除が通知を発行することもない」と断定している。設計 第7.3節は application 層の3ポートだけでなく**ドメイン層の抽象そのもの**（`domain/common/event.ts` 81行・`domain/identity/events.ts` 62行）を削除対象に挙げ、「**ドメイン層の契約変更として第8.2.1節（ポートの `Promise` 契約の同期化）と同格である。一覧に現れないと #37 が『消えるのは application 層の3本だけ』と読んでドメイン層の型を残す**」と、この取り残しの帰結まで名指ししている。
  - 「Migration in progress」節（`:124-132`）は #37 前の実体を書く唯一の場所と定義され、`:126` が「**the rest of this file is written as settled rule on purpose**」と宣言している。したがって Layers 節は現状記述ではなく規則側であり、規則として嘘になっている。
  - 1ラウンド目 B-003 が捕まえたのと同じ「語ではなく意味で残ったイベント」であり、`V-3`（射程が `spec/` のみ）にも `V-9`（射程が Key concepts 節のみ）にも構造的に掛からない位置にある。
- 提案: `CLAUDE.md:43` から `domain events` を落とす。`:66` の「Key concepts」導入文が #37 未着地の項について既に注記を持っているので、Layers 側に移行注記を足す必要は無い。

---

## Warnings

### [W-001] `Topic.softDelete` / `Topic.restore` の projection 影響欄が、出典メモへのファンアウトを落としている

- 場所: `spec/domains/knowledge.md:173`（softDelete）/ `:174`（restore）
- 理由: 影響欄が「配下ドキュメントのエントリを同一トランザクションで除去する」「復元した配下ドキュメントのエントリを同一トランザクションで作り直す」で止まっている。同じ表の `Document.softDelete`（`:234`）/ `Document.restore`（`:235`）は「**出典メモのエントリを作り直す**」を明記しており、`spec/domains/search.md:240,241` の契機表も、`spec/usecases/knowledge.md:268`（trashTopic 手順5）も同じ要求を持つ。**ドメイン記述だけが不足している。** 落ちると出典メモ側の `sourceOfDocumentIds` にゴミ箱内ドキュメントの ID が残り、`spec/domains/search.md:161`（ゴミ箱内項目の ID を露出させない）に反する。
- 提案: 2行の影響欄に「除去・復元した各ドキュメントの出典メモのエントリも作り直す」を足す。

### [W-002] trashTopic / AI delete のテストケースが、出典メモのエントリ作り直しを期待していない

- 場所: `spec/testcases/knowledge/trashTopic.md:7` / `spec/testcases/memo/delete.md:8`
- 理由: どちらも「エントリが `search_entries` / `search_fts` から除去される」までで、相手側の作り直しに触れていない。兄弟ケースの `spec/testcases/knowledge/trashDocument.md:7` と `spec/testcases/memo/softDeleteMemo.md:8` は両方書けており、**同じ性質のケースで期待の粒度が非対称**である。とくに `spec/usecases/memo.md:573` は AI `delete` を「softDeleteMemo と同一」と宣言しているので、テストケース側の非対称は宣言と矛盾する。
- 提案: 2件の期待結果に相手側の作り直しを足す（`spec/inventory/test.md` の要点欄も同時に直す）。

### [W-003] `changePassword` の正常系テストケースに `credentialVersion` 前進の期待が無い

- 場所: `spec/testcases/identity/changePassword.md:7`
- 理由: 期待結果が「検証材料の差し替え + 未使用トークンの無効化 + `sessionEpoch` 前進」までで止まっている。`spec/usecases/identity.md:290` は手順6で `AccountStore.advanceSessionEpoch()` と **`CredentialLocatorStore.advanceCredentialVersion(credentialId)` の両方**を要求している。前進が漏れると `spec/usecases/identity.md:143` の到達性検査（`credentialVersion` の一致）で正しいパスワードでも `ValidationError("INVALID_CREDENTIALS")` になる。同じ前進を持つ `executePasswordReset` はこの締め出しに専用ケースを立てている（`spec/testcases/identity/executePasswordReset.md:27`）ので、**2ユースケースで検証の粒度が非対称**である。
- 提案: `changePassword` 側にも同趣旨のケースを1行 append する（`spec/inventory/test.md` の連番規約に従い末尾へ）。

### [W-004] `listTrash` / `emptyTrash` から「ユーザー不在」を生む手順が消えたのに、エラーケース行とテストケースが残っている

- 場所: `spec/usecases/trash.md:62`（listTrash）/ `:301`（emptyTrash）/ `spec/testcases/trash/listTrash.md:25` / `spec/testcases/trash/emptyTrash.md:17`
- 理由: 改訂前の処理フローは `UserRepository.findById(userId)` で `trashRetentionDays` を取っており（不在は `NotFoundError`）、エラーケース表の「ユーザー不在 | NotFoundError」はその手順から出ていた。**本 PR は `TrashQueryPort` から `retentionDays` 引数を落としたのに伴いこの手順を削ったが、エラーケース行を残した。** 改訂後のフロー（`:53-55` / `:291-295`）は `UserId.create` → DO 選択 → `TrashQueryPort` だけで、ユーザーの実在確認を1度も行わない。`spec/usecases/trash.md:10` 自身が「保持日数が必要になるのは `purgeAfter` を算出・再計算するときだけ」と読み取り系での取得を外している。未初期化の DO は空のゴミ箱として振る舞う（`listTrashItems` が0件）ので、期待値は `NotFoundError` ではなく空結果 / no-op になるはずである。
- 提案: 2つのエラーケース行と対応する2件のテストケースを、実際に起きる振る舞い（空結果 / `deletedCount: 0`）へ直すか、行ごと落とす。**`spec/testcases/trash/hardDeleteTrashItem.md:20` / `restoreDocument.md:52` の同種の行は main から存在する取り残しなので、本 PR の射程外**（あわせて直すなら好都合というだけ）。

### [W-005] 終端のテストケース2件が「巻き戻し」を前提にしており、他の2件と非対称

- 場所: `spec/testcases/identity/changePassword.md:27` / `spec/testcases/identity/executePasswordReset.md:26`
- 理由: 両行とも前提が「中間状態のまま前進不能が確定し、**終端で中間状態が解除された**」、期待が「**旧パスワードでログインできる**」である。ところが `spec/usecases/identity.md:250,293` と `spec/domains/identity.md:431` が定める終端は「記録を残して運用へエスカレーションする」までで、中間状態の解除には触れていない。`poison` + エスカレーションだけの終端なら `changeState` は非 `null` のまま残り、`spec/domains/identity.md:425`（`beginCredentialChange` は「旧検証材料での照合はこの瞬間から拒否される」）により**旧パスワードでもログインできない**。つまりこの2行は、設計 第6.5.1節が (i)（巻き戻す）と (ii)（巻き戻さない）に分けた終端モードのうち **(i) を選んだ場合の観測結果**を書いている。**その (i)/(ii) の使い分けは `.thread/34/handoff.md` 第2節が #45 へ委譲した項目そのもの**である。同じ手続きを持つ `spec/testcases/identity/unlinkSsoCredential.md:20` と `registerOrLoginWithSso.md:18` は「終端に至った事実が記録され運用へエスカレーションされる」で正しく止まっており、**4件中2件だけが逸脱している。**
- 提案: 2行の前提と期待を、他の2件と同じ「一様な終端（記録 + エスカレーション）」の範囲へ揃える。中間状態中のログイン不能は既に `executePasswordReset.md:25` / `changePassword.md` の別行が押さえている。

### [W-006] リセット完了時の AI クライアント接続の一括失効に、呼び出すポート・メソッドの名指しが無い

- 場所: `spec/usecases/identity.md:247` / `spec/inventory/usecase.md:13`
- 理由: 手順6-3 は「`AccountStore.advanceResetVersion()` でリセット世代を進め、`createdAtResetVersion` が前進前の値と等しい AI クライアント接続を失効させる」だが、**失効を書くポート・メソッドを名指ししていない。** `AiClientConnectionRepository` の6メソッド（`spec/domains/identity.md:530-553`）に条件付き一括失効は無く、`listByUserId()` は `Versioned<...>` を返さないので `findById` の往復が要る。この形は spec の他の一括更新とは扱いが不揃いである — 1ラウンド目 B-006 は同型の欠落（`purgeAfter` の一括再計算）を Blocker と判定し、`recalculatePurgeAfter` という名指しで閉じた（`.thread/35/adr.md` ADR-047。`spec/usecases/identity.md:565` は3メソッドを明示的に列挙している）。あわせて「**前進前の値**」の取り方も書かれていない — `advanceResetVersion()` は**進めた後の値**を返す契約であり（`spec/domains/identity.md:471` / `spec/inventory/adapter.md:55`「読み直しと前進を分けると並行実行で射程がずれる」）、別途 `find()` で読み直すのは禁じ手である。
- 提案: 手順6-3 に呼び出し列（例: `advanceResetVersion()` の戻り値から前進前の値を導き、`listByUserId()` → `createdAtResetVersion` と `status: "active"` で絞り、対象ごとに `findById` → `AiClientConnection.revoke` → `save`）を書くか、`recalculatePurgeAfter` と同様に専用メソッドを1本置く。件数は少ないので前者でよいが、**どちらであるかは決めておく必要がある。**

### [W-007] knowledge の「他ドメインからの参照型」一覧に `TrashRetentionDays` が無い（memo と非対称）

- 場所: `spec/domains/knowledge.md:29-38`
- 理由: `TopicRepository.recalculatePurgeAfter`（`:418`）と `DocumentRepository.recalculatePurgeAfter`（`:513`）が `TrashRetentionDays` を引数に取るようになったが、「エンティティの直接参照はせず型のみを参照する」と宣言している参照型一覧に載っていない（ユビキタス言語表 `:27` にのみある）。memo 側は `spec/domains/memo.md:243` で参照型一覧に追加済みで、**同じ変更が片側にしか届いていない。**
- 提案: knowledge 側の参照型一覧に1行足す。

### [W-008] `registerWithPassword` の DB 例外ケースが、別境界の予約行まで巻き戻ると読める

- 場所: `spec/testcases/identity/registerWithPassword.md:22`
- 理由: 「`UserSettingsRepository.insert` で DB 例外が発生する → `SystemError`。**トランザクションはロールバックされ**、ユーザーは作成されない」。この時点で認証情報側のメール予約（`reserveCredential`）は既に獲得済みであり、`spec/usecases/identity.md:51` が「手順4〜7は2つの物理境界をまたぐので単一のトランザクションには収まらない」と明記している。**「トランザクションはロールバック」という表現は、別の物理境界にある予約行まで巻き戻るように読める。** 同じ構造を持つ `registerOrLoginWithSso.md:17-18` は予約の敗北と中間状態の2行を立てており、`registerWithPassword` 側だけこの観測点が欠けている。
- 提案: 「ユーザー単位設定側のトランザクションはロールバックされるが、認証情報側の予約は中間状態として残る（観測できるのは『そのメールで登録もログインもできない』ことだけ）」へ言い換えるか、中間状態の行を1件 append する。

---

## Notes

- **[N-001]** `AiClientConnectionRepository.listByUserId()` は引数を取らない（`spec/domains/identity.md:539` / `spec/inventory/domain.md:29`「引数なし」）のに、名前だけ `ByUserId` が残っている。テナント分離を「型（第一引数の `userId`）ではなく到達可能性」へ移した本 PR の趣旨（`spec/domains/index.md:32`）に照らすと名前が古い。ただし #10 / #13 のチェックリストと `ADP-identity-009` / `DOM-identity-026` が同名で参照しており、改名の波及が広い。**本 PR で直すべきとは考えない。記録のみ。**
- **[N-002]** `account` を「集約ルート側であり非集約ストアではない」と分類した根拠は4箇所とも「OCC の `version` を持つ」だが（`spec/database/index.md:79,751` / `spec/domains/identity.md:378,457` / `spec/inventory/domain.md:41`）、**その `version` 列を条件に使うポートメソッドが1本も無い** — `AccountStore` の2つの前進メソッドは「`ExpectedVersion` を取らず `version` も進めない」と明記されており（`spec/domains/identity.md:481`）、`account` に `save(entity, expectedVersion)` 相当は無い。`account.status`（`active` / `deleting` / `deleted`）を遷移させるメソッドも無い（退会が spec のユースケースに無いため）。設計 第4.1.1節が `account.version` を列挙しているので列そのものは正しいが、**分類の根拠に使った性質が spec 内では一度も行使されない**ことは記録しておく。
- **[N-003]** memo は「`trashed` であることと `purgeAfter` を持つことは同値」を**不変条件8**として立てているが、knowledge の不変条件一覧（`spec/domains/knowledge.md:276-286`）には対応条項が無く、振る舞い表の `restore` 行（`:174` / `:235`）へ散らして書かれている。結果として `spec/testcases/memo/softDeleteMemo.md:18` は「不変条件 8」を参照し、`spec/testcases/knowledge/{trashDocument,trashTopic}.md` は `trash.md` を参照するという参照先の食い違いが出ている。軽微。
- **[N-004]** AC-14 / AC-15 は未達である（`gh issue view 10` は `ADP-UD-001`〜`004` / `DOM-SEARCH-001`〜`004` / `UC-SEARCH-001` / `TEST-DO-004,006,007` / `TEST-MAN-002` が MISSING、`gh issue view 13` は `DOM-identity-016` / `:017` / `TC-revokeAiClientConnection-002` が MISSING）。**triage W-029 で「判定は fix、実行はレビュー APPROVED 後のステップ18」と判定済みなので指摘としては提出しない。** B-002 の決着次第で `UC-identity-014` / `-015` の扱いが動くため、ステップ18 は本レビューの反映後に回すのが正しい。
- **[N-005]** `DOM-trash-008` は改訂前に `TrashQueryPort.listExpiredItems` を指しており、改訂後は同じポートの `listItemsToPurge` を指している（ID を欠番にせず同じ枠を置き換えた）。`spec/inventory/domain.md` は `test.md` と違って「連番は表の行順に対応する」を宣言しておらず、#10 / #13 のどちらも `DOM-trash-008` を参照していないので実害は無い。`ADP-trash-004` は欠番として正しく残されている（`.thread/35/adr.md` ADR-057）。記録のみ。

---

## カバレッジ（97件と1対1）

### 確認した（87件）

| 群 | 件数 | 確認の仕方 |
|---|---|---|
| `CLAUDE.md` | 1 | 全文通読 + 差分（B-004） |
| `spec/domains/*.md`（export / identity / index / knowledge / memo / search / trash） | 7 | 差分 + 該当節の全文（`search.md` / `identity.md` / `trash.md` / `index.md` は全文） |
| `spec/usecases/*.md`（export / identity / knowledge / memo / search / trash） | 6 | 差分 + 処理フロー・エラーケース表の全文突合 |
| `spec/inventory/*.md`（adapter / domain / frontend / test / usecase） | 5 | 差分 + ID 増減の集合差分 + `P-8` + `#L` アンカー抜き取り8件 |
| `spec/database/index.md` | 1 | ドメイン・ユースケース観点で必要な範囲（`account` / `credential_locators` / `ai_client_connections` / `jobs` / `operations` / OCC 節）。**DDL・索引の妥当性はデータベース観点の射程** |
| `spec/testcases/identity/*.md` | 15 | 全件（新規2件は全文、他は差分） |
| `spec/testcases/knowledge/*.md` | 14 | 全件（差分 + 上流契約との突合） |
| `spec/testcases/memo/*.md` | 9 | 全件（同上） |
| `spec/testcases/trash/*.md` | 7 | 全件（同上） |
| `spec/testcases/search/*.md`（`search.md` / `maintainSearchIndex.md` の削除） | 2 | `search.md` は全文、削除は `V-3` / AC-10 で確認 |
| `spec/testcases/export/exportAllData.md` | 1 | 差分 |
| `spec/{idea,index,requirements}.md` | 3 | 差分全量 |
| `spec/pages/index.md` | 1 | 差分全量（新設ユースケースとの配線を確認） |
| `spec/scenario/*.md`（account / ai / index / search） | 4 | 差分全量 |
| `spec/manual-tests/*.md`（account / ai / document / index / search / settings / timeline / trash） | 8 | **語彙・機械検査のみ**（`V-3` / `V-3b` / `V-7` の全域走査 + ユースケース名 17 語の突合）。手順の妥当性はテストケース観点・要件観点の射程 |
| `.thread/35/plan.md` | 1 | 全文（受け入れ基準 AC-3 / AC-6 / AC-6b とスコープ節） |
| `.thread/35/review/triage.md` | 1 | 全文（既判定 37 件の把握） |
| `.thread/35/adr.md` | 1 | ADR 見出し全件 + ADR-046 / 047 / 051 / 057 / 059 の本文 |

### スキップした（10件）

| ファイル | 理由 |
|---|---|
| `.thread/35/coverage.md` | 判定台帳。AC-16 の検証は要件観点・設計忠実性観点の射程。本観点の指摘に影響しない |
| `.thread/35/steps.md` | 作業手順書。契約を持たない |
| `.thread/35/step14-checklist.md` | (A)/(B)/(C) 適用の照合表。イベント残存は `V-3` / `V-3b` / 意味走査で 0 を実測済みなので、チェックリスト自体の照合は重複 |
| `.thread/35/testing.md` | 検証手順。plan.md のテスト方針で代替 |
| `.thread/35/review/review-001.md` | 1ラウンド目の統合レポート。triage.md で判定を把握済み |
| `.thread/35/review/review-001-database.md` | 同上（かつ他観点） |
| `.thread/35/review/review-001-design-fidelity.md` | 同上 |
| `.thread/35/review/review-001-domain-usecase.md` | 同上（**再提出防止のため triage.md 側の Key で確認した**） |
| `.thread/35/review/review-001-requirements.md` | 同上 |
| `.thread/35/review/review-001-testcases.md` | 同上 |

**87 + 10 = 97。**
