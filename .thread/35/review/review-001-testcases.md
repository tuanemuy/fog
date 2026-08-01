# レビュー: PR #46（Issue #35） — テストケース・台帳・マニュアルテスト観点

- 対象: `origin/main...HEAD`（80ファイル。`spec/` 73 + `CLAUDE.md` 1 + `.thread/35/` 6）
- 契約: `.thread/35/plan.md`（AC-9 / AC-10 / AC-11 / AC-16 / AC-19）
- 設計の正本: `.thread/34/design.md` 第11.1節（`2289-2490`）
- 検証スクリプト: `check.mjs`（アンカー全件 + 逆引き）/ `gaps.mjs`（欠番・繰り上がり）/ `mt.mjs`（件数表）をスクラッチパッドで実行

## 総評

**機械検証はすべて通っている。** `spec/inventory/test.md` の 782 行のアンカーは全件が実在の**ケース行**を指し（ヘッダ行・区切り行・範囲外は 0 件）、`spec/testcases/**` の実ケース行 782 件と**過不足なく1対1**、しかも**行順まで単調**である。削除 ID は欠番のまま残り、後続 ID の繰り上がりは 1 件も無い。AC-16 のファイル数（101 → 100）、AC-19 の `P-7` 10本、AC-11 の環境前提の置き換え、`spec/manual-tests/index.md` の件数表（各行・合計 199・実行記録の分母）も、実測と完全に一致した。

**その上で Blocker が1件ある。** ステップ14 が (A)/(B)/(C) を適用しきれず、**イベント期待が4行残っている**。残った4行はいずれも `V-3` の走査語（`イベント` / `Outbox` / …）を含まないため負の検証では検出できず、しかも**台帳側だけが先に同期されている**ので、台帳とテストケースが正面から食い違っている。これは #13（テスト実装）が静かに取り違う形である。

---

### テストケース・台帳・マニュアルテスト

#### Blockers

- **[B-001]** ステップ14 のイベント期待の書き換えが4行漏れている。台帳は同期済みなので、**台帳とテストケースが矛盾している**
  - 場所:
    - `spec/testcases/knowledge/updateTopic.md:8` — 「説明文が変更され `version + 1`。`topic.updated` が記録される」
    - `spec/testcases/knowledge/updateTopic.md:12` — 「`version` は 2 回分進み、`topic.archived` / `topic.unarchived` が各 1 件記録される」
    - `spec/testcases/knowledge/editDocumentByAi.md:7` — 「新リビジョン…が積まれ、`document.edited` が記録される」
    - `spec/testcases/knowledge/trashTopic.md:9` — 「トピックのみ trashed になり `trashedDocumentIds: []`。`document.trashed` は発行されない」
  - 理由:
    1. **参照先が spec のどこにも存在しない。** 本 PR 後の `spec/domains/knowledge.md` は `topic.updated` / `topic.archived` / `topic.unarchived` / `document.edited` / `document.trashed` を一切定義していない（`grep -n 'topic\.updated\|document\.edited\|イベント' spec/domains/knowledge.md` は 0 行）。`spec/domains/index.md` も「エンティティの作成・更新・削除が通知を発行することもない」と明記した。**期待値が指す機構が消滅している。**
    2. **台帳だけが先に同期されており、両者が矛盾している。**
       - `spec/inventory/test.md:407` `TC-updateTopic-002` = 「説明文変更・version+1 なら PASS」（イベントに触れない）↔ ファイル `:8` は「`topic.updated` が記録される」
       - `spec/inventory/test.md:411` `TC-updateTopic-006` = 「archive→unarchive の往復が成立し version が 2 回進めば PASS」↔ ファイル `:12` は「両イベントが各 1 件記録される」
       - `spec/inventory/test.md:276` `TC-editDocumentByAi-001` = 「同じ transactionSync でエントリが作り直されれば PASS」↔ ファイル `:7` は「`document.edited` が記録される」
       - `spec/inventory/test.md:395` `TC-trashTopic-003` = 「配下のエントリ除去が起きなければ PASS」↔ ファイル `:9` は「`document.trashed` は発行されない」

       #10 / #13 の実装チェックリストは台帳 ID 由来なので、**実装者は台帳を見て通したつもりでテストケース本文を読むと別のことが書いてある**。ADR-011 が防ごうとした「静かな取り違え」と同じ事故形である。
    3. **設計の要求を満たしていない。** 設計 第11.1節「改訂する — テストケース」の前文は「イベントを期待値に持つケースは…**全件が対象になる**」と書いている。表が `updateTopic.md:8` / `:12` / `editDocumentByAi.md:7` / `trashTopic.md:9` を挙げていないのは、これら4行が「イベント」という語を含まず走査に掛からなかったためで、**除外の判断ではない**。実際 `.thread/35/step14-checklist.md:49` は同じ理由で表から漏れた行を `emptyTrash.md:10` / `hardDeleteTrashItem.md` 5行 / `restoreDocument.md` 3行 / `restoreTopic.md` 2行で拾い上げている。**同じ手当てをこの4行にだけ適用し忘れている。**
    4. **`V-3` では検出できない。** 4行とも `Outbox|collectEvents|consumer|…|ドメインイベント` のいずれにも当たらないので、AC-3 の負の検証は 0 行で通ってしまう（実測でも 0 行）。検出には `grep -rnE '(memo|document|topic|identity)\.(created|edited|restored|trashed|hardDeleted|sourceLinksChanged|updated|archived|unarchived)' spec/testcases` が要る。
  - 提案:
    - `updateTopic.md:8` / `:12` — 台帳に合わせて **(B)**。`:8` は「説明文が変更され `version + 1`」まで、`:12` は「アーカイブ → 完了解除の状態往復が成立し、最終状態は `active`。`version` は 2 回分進む」まで。`:7` と同様に「トピックはインデックスエントリを持たないので projection の更新は発生しない」を添えると `:7`〜`:15` の説明が揃う。
    - `editDocumentByAi.md:7` — **(A)**。同ファイル内の他行および `editDocument.md:7` と同じ「同じ `transactionSync` の中で当該ドキュメントのエントリが `search_entries` / `search_fts` に作り直される」へ。台帳 `TC-editDocumentByAi-001` は既にこの表現である。
    - `trashTopic.md:9` — **(B)**。「配下が 0 件なので projection から除去されるエントリも無い」へ。台帳 `TC-trashTopic-003` は既にこの表現である。
    - 併せて、上記の追加 grep を `.thread/35/testing.md` の確認項目（AC-3 側）へ足すことを勧める。`V-3` の走査語はイベント**名**を1つも含んでおらず、同じ穴が再発する。

#### Warnings

- **[W-001]** identity の中間状態まわりの識別子が **testcases（camelCase）と `spec/database/index.md`（snake_case）にしか存在せず、上流の `spec/domains/` / `spec/usecases/` に定義が無い**（実装者からの報告に対する判定）
  - 場所: `spec/testcases/identity/{changePassword,loginWithPassword,executePasswordReset,listAiClientConnections,requestPasswordReset}.md` / `spec/inventory/test.md` ↔ `spec/database/index.md` / `spec/inventory/adapter.md`
  - 実測（`spec/**`、`review/` 除く）:

    | 識別子 | camelCase の出現先 | snake_case の出現先 | `spec/domains/` `spec/usecases/` |
    |---|---|---|---|
    | `changeState` | testcases 3 + manual-tests 1 + inventory/test | `spec/database/index.md`, `spec/inventory/adapter.md` | **無し** |
    | `sessionEpoch` | testcases 2 + inventory/test | 同上 | **無し** |
    | `credentialVersion` | testcases 2 + manual-tests 1 + inventory/test | 同上 | **無し** |
    | `createdAtResetVersion` | testcases 2 + inventory/test | 同上 | **無し** |
    | `resetVersion` | testcases 3 + inventory/test | 同上 | **無し** |
    | `failedAttempts` | testcases 2 + inventory/test | 同上 | **無し** |
    | `nextAttemptAllowedAt` | testcases 2 + inventory/test | 同上 | **無し** |
    | `operationKey` | testcases 1 + inventory/test | 同上 | **無し** |

  - 判定: **報告は「2通りの綴りが混在している」という形では問題ではない。** その形なら `purgeAfter` / `purge_after` が反例になる — こちらは `spec/domains/trash.md` と `spec/usecases/{trash,memo,knowledge,identity}.md` に camelCase の定義があり、`spec/database/index.md` の snake_case は同じ概念の物理名として**両側にアンカーがある**。正しい形である。
    問題は別のところにある。上の8語は **camelCase 側にアンカーが1つも無い**。`spec/usecases/identity.md:50 / :244 / :284 / :328` は概念そのものは書いているが（「中間状態」「セッションの世代」「作成時点のリセット世代」）、**名前を与えていない**。結果として、テストケースが**物理スキーマにしか定義が無い名前で期待値を書いている**状態になっている — ドメインを飛び越して DB 層の語彙を直接参照する形であり、`spec/inventory/domain.md` にも対応する `DOM-*` が無いので、#10 / #13 の実装者が `changeState` の値域（3値）や `'advanced'` の意味を確かめようとすると `spec/database/index.md` まで降りるしかない。
    設計 第11.1節の changePassword 行が「第4.1.1節・第6.5.1節」を根拠に挙げているとおり、この語彙は設計時点から第4.1.1節（テーブル定義）由来である。したがって本 PR の逸脱ではないが、**#35 が「上流から下流へ一貫して反映する」Issue である以上、ここで止めるのが筋**である。
  - 提案: `spec/domains/identity.md` の `CredentialMapping` / `Account`（相当）にフィールドとして `changeState` / `changeOrigin` / `credentialVersion` / `failedAttempts` / `nextAttemptAllowedAt` / `sessionEpoch` / `resetVersion` / `createdAtResetVersion` を名前付きで置き、`spec/inventory/domain.md` に `DOM-identity-*` を採番する。それが本 Issue のスコープを超えるなら、**#37 へ引き継ぐ論点として `.thread/35/adr.md` に1本 ADR を足す**（「camelCase 側のアンカーは #37 のポート実装で確定する」と明示する）だけでも、実装者が spec を往復して迷う事故は消える。

- **[W-002]** テストケースの `userId スコープ` が **改訂後の `spec/domains/index.md` と正面から矛盾している**。しかも同じ保証について2通りの説明が併存している
  - 場所（テストケース 18 行 / 台帳 16 行 / usecases 1 行）:
    - 書き込み系（設計の「読み取り系14件・影響なし」に**入っていない**もの。いずれも本 PR で改訂済みのファイル）: `spec/testcases/knowledge/createDocument.md:22` / `editDocument.md:22` / `editDocumentByAi.md:29` / `rollbackDocument.md:20` / `trashDocument.md:12` / `trashTopic.md:14` / `updateTopic.md:20` / `spec/testcases/memo/rollbackMemo.md:18` / `spec/testcases/trash/emptyTrash.md:16` / `restoreMemo.md:14`
    - 読み取り系（設計が「触らない」と決めたもの）: `knowledge/{getDocument,getTopic,listDocumentRevisions,listDocumentSourceMemos,listDocumentsReferencingMemo,diffDocumentRevisions}.md` / `memo/{getTimeline,diffMemoRevisions}.md`
    - 上流: `spec/usecases/memo.md:369`（「userId スコープの `findRevision` を経る限り…」）
    - 台帳: `spec/inventory/test.md` の 16 行（`:221` `:252` `:272` `:298` `:307` `:322` `:330` `:342` `:352` `:379` `:388` `:400` `:419` `:448` `:774` ほか）
  - 理由: 改訂後の `spec/domains/index.md` は「**DO 内のリポジトリ・ポートは `userId` を引数に取らない**」「構造的保証の在り処は…**到達可能性**である」「**例外は無い**」と書き切った。`userId スコープにより NotFoundError` はもはや**存在しない機構を根拠に挙げている**（語の言い換えではなく、機構の指名である）。
    設計は「その読み替えは `spec/domains/index.md` の改訂で一括して効くので、個々のテストケースは触らない」としており、判断としては尊重できる。しかし本 PR は `spec/testcases/trash/listTrash.md:16`（→「保証は列条件ではなく到達可能性による」）、`spec/testcases/search/search.md:17`（→「ユーザー A の Durable Object に閉じており」）、`spec/testcases/identity/revokeAiClientConnection.md:8`（→「ユーザー A の Durable Object の中だけを引く」）を**書き換えている**。同じ保証に対する説明が corpus 内で2通りになり、しかも書き換えた側と残した側の境界が「設計の表に載っていたか」でしかない。上記10件は書き込み系で、設計の免除理由（「読み取り専用でイベント・インデックス・非同期反映のいずれにも触れない」）が**そもそも当たらない**。
  - 提案: Blocker にはしない（設計が明示的に一括読み替えを選んだため）が、**どちらかに寄せる**こと。最小の手当ては `spec/inventory/test.md` の 16 行の要点欄を「到達可能性により NotFoundError」に揃えること — 台帳は #10 / #13 のチェックリスト生成元なので、ここが正しければ実装者は迷わない。`spec/usecases/memo.md:369` は上流なので、他観点のレビューと合わせて処理されたい。

- **[W-003]** マニュアルテストの TC 番号が**文書内の並び順と一致しなくなった**。手順書は上から実行されるので、テスターの動線が壊れる
  - 場所:
    - `spec/manual-tests/search.md` — `TC-01`…`TC-07`（`:137`）→ **`TC-18`（`:153`）/ `TC-19`（`:167`）/ `TC-20`（`:178`）** → `### 異常系` → `TC-08`（`:191`）…`TC-17` → `### 境界値` → `TC-21`（`:293`）
    - `spec/manual-tests/account.md` — 正常系の末尾に **`TC-38`（`:190` 付近）/ `TC-39`** が入り、異常系の末尾に **`TC-40`（`:492`）** が入る
  - 理由: 種別セクション（正常系 / 異常系 / 境界値）への配置は正しく、`spec/manual-tests/index.md` の件数表とも一致している（`search` 21 = 10/7/4、`account` 40 = 13/23/4。実測と完全一致）。しかし `spec/manual-tests/index.md` の「実行順序の推奨」はファイル単位の順序しか示しておらず、ファイル内はドキュメント順に実行される前提である。番号が飛ぶと「TC-08 を飛ばしたか？」の疑いが実行のたびに発生し、実行記録の付け合わせもしにくい。ADR-011 の欠番規則は `spec/inventory/test.md` の `TC-*`（実装チェックリストの ID）に対するもので、マニュアルテストの通し番号には及ばない — マニュアルテストの番号は台帳と紐づいていないので、詰め直しても静かに取り違う先が無い。
  - 提案: (a) マニュアルテストの TC 番号は**文書順に振り直す**（ID の外部参照は各ファイル内の相互参照と `カバレッジ` 表に閉じており、同一 PR 内で機械的に追随できる）。または (b) 振り直さないなら、`spec/manual-tests/index.md` の「実行順序の推奨」に「ファイル内は**番号順ではなく記載順**に実行する」と1行足す。どちらでもよいが、現状の「番号順とも記載順とも読める」状態は残さないこと。

- **[W-004]** `spec/manual-tests/search.md` の追加テストデータが、既存 TC の期待結果と**同居の検証をしていない**
  - 場所: `spec/manual-tests/search.md:40-46`（M4 / M5 / M6 / D-A2 / D-A3 の追加）と `:67`（TC-01）/ `:104`（TC-04）
  - 理由: 追加分は「**`fogsearch` は含めない**（TC-01 以降の結果一覧を変えないため）」と明記されており、実際に M4〜M6・D-A2・D-A3 のいずれも `fogsearch` を含まないので TC-01 の期待一覧（M1・M2・D-A1・D-B1・D-C1）は保たれる。ここは正しい。ただし **D-A2 / D-A3 は TP-A 配下に置かれる**ので、TC-04（トピック絞り込みで TP-A を選ぶ）の結果件数が増える。TC-04 の期待結果は現在「結果が D-A1 …に絞られる」形のままで、増えた 2 件をどう扱うかが書かれていない。
  - 提案: TC-04 の期待結果に「`fogsearch` で検索しているため D-A2 / D-A3 はヒットしない」を1句足すか、D-A2 / D-A3 を TP-A ではなく順位付け専用の別トピック配下へ移す。前者のほうが変更が小さい。

#### Notes

- **[N-001]** AC-9 のアンカー検査は**全件通過**。`spec/inventory/test.md` の 782 行について、(i) `#L{n}` が実在ファイルの実在行を指す、(ii) その行が表の**データ行**である（ヘッダ行 `| 前提条件 | 操作 | 期待結果 | 実装ステータス |` / 区切り行 / 範囲外が 0 件）、(iii) `spec/testcases/**` のケース行 782 件と**1対1の全単射**（台帳にあってファイルに無い / ファイルにあって台帳に無いが 0 件）、(iv) ID が重複していない、(v) 台帳の行順とファイルの行番号が**単調増加**（採番と記載順のねじれが無い）、を機械検証した。plan.md の `P-8`（`spec/inventory/*.md` 全体の見出しアンカー含む）も 0 行。

- **[N-002]** ADR-011 の欠番規則は完全に守られている。`origin/main` との突き合わせで、削除された ID は `TC-maintainSearchIndex-001`〜`028` / `TC-pruneExpiredTrashItems-010` / `TC-revokeAiClientConnection-002` / `TC-search-006` / `-022` / `-028` / `-029` の 34 件、追加は 45 件で、**欠番は欠番のまま**（`pruneExpiredTrashItems` は `[10]` 欠けの max 17、`revokeAiClientConnection` は `[2]` 欠けの max 10、`search` は `[6,22,28,29]` 欠けの max 43）。**両方に存在する ID で「要素」が別のケースを指すようになった行は 0 件**（変わったのは同一ケースの語彙のみ。41 行を1件ずつ確認した）。`DOM-identity-023`〜`028` も改訂前と同じ `AiClientConnectionRepository` の6メソッドを指し続けている（AC-15 の前提）。

- **[N-003]** AC-16 は成立している。`find spec -name '*.md' | grep -v '/review/' | wc -l` が **100**（`origin/main` は 101）、差分は `spec/testcases/search/maintainSearchIndex.md` の削除1件のみ、新設ファイルは 0。さらに `.thread/35/coverage.md` の 101 行の判定を `git diff --name-only` と突き合わせたところ、**「改訂」なのに差分に無いファイル 0 件 / 「影響なし」なのに差分にあるファイル 0 件 / 差分にあるのに判定が無いファイル 0 件**で完全一致した（`削除` 判定の `maintainSearchIndex.md` だけが「改訂」列に入らないが、冒頭の内訳「改訂 73 / 影響なし 28」はこれを改訂側に数えたもので整合している）。

- **[N-004]** AC-10 は成立している。ベクトル統合ケース（旧 `:12`）と非同期反映ケース（旧 `:28`）が消え、「投稿直後のヒット」（`spec/testcases/search/search.md:33`）が入った。FTS5 の観点は網羅されている — 日本語 trigram（`:34`）/ 短語フォールバック（`:35`。`LIKE` / `GLOB` を使わないことまで明記）/ 全角半角 NFKC（`:36`）/ 合成済み・結合文字列（`:37`）/ `bm25` とタイトル重み（`:38`）/ 同点時の `timestamp DESC, type, id`（`:39`）/ 原文スニペット（`:40`）/ topic 絞り込みの `TOPIC_NOT_FOUND` 2件（`:43` `:44`）/ カーソル（`:45`）。いずれも `spec/domains/search.md:150-200` と `spec/database/index.md:652-660` の記述と**用語まで一致**している。
  **巻き添え削除は無い。** 500 文字ちょうど（`:23`）/ 501 文字（`:38` 相当）/ `limit: 1`（下限）/ `limit: 100`（上限）/ `limit: 0` / `limit: 101` はすべて残っている。消えた `page: 0` / `page: 1.5` は ADR-012（page 番号方式そのものの撤廃）に対応する妥当な削除で、`grep -nw page` は `spec/usecases/search.md` / `spec/testcases/search/search.md` / `spec/pages/index.md` の3ファイルとも 0 行。`listTrash` が `page` 方式のまま残っているのは正しい（設計 第7.2.1節の対象は検索のみ。`spec/usecases/trash.md:25` も page 方式のまま）。

- **[N-005]** AC-11 は成立している。`spec/manual-tests/` から `consumer` / `pruner` / 「1〜2分待つ」/ 「テスト環境の DB」/ `UPDATE … SET` / `wrangler` が**全滅**（`grep -rniE 'UPDATE .* SET |wrangler|d1 execute|ワーカーを手動起動|consumer|pruner|直接更新|共有 ?DB|テスト環境の ?DB' spec/manual-tests/*.md` が 0 行）。**推測でコマンドを書いた箇所は無い** — `trash.md:18-22` / `:208` / `:216` / `:353`、`timeline.md:28`、`settings.md:37` はいずれも「Alarm の強制発火に相当する手段」「時計の巻き戻しに相当する手段」「DO 単位のシード投入、または開発用の RPC」という**手段の性質**までで止め、実体を `#38` へ委譲している。`V-7`（`ヒットしない場合がある|反映は非同期|1〜2分待つ|少し待って`）も 0 行。

- **[N-006]** `spec/manual-tests/index.md` の件数表を実測と突き合わせた（`grep -c '^## TC-'` と `**種別**:` の内訳）。**全行一致**する。

  | ファイル | 表の値（TC / 正 / 異 / 境） | 実測 |
  |---|---|---|
  | account | 40 / 13 / 23 / 4 | 40 / 13 / 23 / 4 |
  | timeline | 37 / 14 / 17 / 6 | 37 / 14 / 17 / 6 |
  | document | 41 / 19 / 15 / 7 | 41 / 19 / 15 / 7 |
  | search | 21 / 10 / 7 / 4 | 21 / 10 / 7 / 4 |
  | trash | 25 / 13 / 10 / 2 | 25 / 13 / 10 / 2（`異常系＋境界値` 2件・`異常系（空状態）` 1件を異常系に算入した内訳と一致） |
  | ai | 23 / 10 / 10 / 3 | 23 / 10 / 10 / 3 |
  | settings | 12 / 6 / 3 / 3 | 12 / 6 / 3 / 3 |
  | **合計** | **199 / 85 / 85 / 29** | **199 / 85 / 85 / 29** |

  実行記録欄の分母 `/199件 PASS` も一致。`spec/manual-tests/search.md` の 事前準備 は旧「8. 反映待ち」を削って 9 → 8 に繰り上がっているが、他ファイルから search.md の事前準備番号を参照している箇所は無く、宙づりの参照は生じていない（`timeline.md` の「事前準備3」への 4 箇所の参照は番号が変わっていないので健在）。

- **[N-007]** AC-19（手段4 の9ファイル）を、設計 `design.md` の「改訂する — 手段4 でのみ拾えたもの」の表の**指示欄と1対1で突き合わせた**。`P-7` の10本は全ヒットするが、`P-7` は語の有無しか見ないので中身を目視した。結果は**9ファイルすべて指示どおり**である。
  - `requestPasswordReset.md` — 4ケース均一化（`:7`-`:10`。冒頭に「行を書くか書かないかで分岐させると測定可能な処理時間差になる」という理由まで明記）/ SSO は**送らない側**と明示（`:9`）/ 判定は `passwordVerifier` の有無（`:9`）/ `operationKey` による1本収束（`:16`）/ ジョブ行に載るのは `tokenId` だけ（`:18`）/ 新規発行が未使用トークンを全置換（`:19`）— **6項目すべて充足**
  - `loginWithPassword.md` — (i) 到達性検査（`:18`）/ (ii) `credentialVersion` 不一致（`:19`）/ (iii) `changeState` 中間状態（`:20`）/ (iv) `nextAttemptAllowedAt` 未到達（`:21`）/ (v) step 7 の報告（`:22`）/ (vi) 鍵ローテーション中の両世代並存（`:23`）— **6ケースすべて充足**。「同一メールの `SsoUser`」も `:9` でクレデンシャル集合へ読み替え済み
  - `getCurrentUser.md` — `authMethod` → クレデンシャル集合（`:7` `:8`）/ 3つ組 `{ credentialId, kind, label }`（`:7`）/ `credentialId` を落とすと解除が書けない旨（`:9`）/ 一覧には `email` も出すが解除は `sso` だけ・権威はドメイン側（`:15`）/ `email` の復号は認証済み本人の自己参照（`:16`）/ `provider` `providerSubject` 非露出は維持（`:10`）— **すべて充足**
  - `listAiClientConnections.md` — `createdAtResetVersion` 基準の自動失効（`:14`）/ 変更を挟んでも失効すること（`:15`。「基準は `credentialVersion` ではなく」と初版の空振りまで明記）/ 通常のパスワード変更では失効しない（`:16`）— **3件すべて充足**（`:17` の「すべて失効」は加点）
  - `exportAllData.md` — 上限超過で `SystemError` 系（`:47`。上限値は #37 → #38 と明記）/ `readAll` が DO 内1回の `transactionSync`・`render` と `write` が request Worker（`:5` の前提欄 + `:48`）— **充足**
  - `listTrash.md` — `expiresAt` の**根拠**を「同一トランザクションでの `purge_after` 再計算 + Alarm 張り直し」へ差し替え（`:16` `:17`。遡及適用という結果は不変）/ `:19` の「他ユーザーのゴミ箱」を到達可能性へ（`:19`）— **充足**
  - `scenario/account.md` — (i) S-AC-01 に所有確認を行わない前提（`:9-11`）/ (ii) S-AC-02 の異常系にメール側敗北（`:29`。「両方を確保できたときにだけ完了」）/ (iii) S-AC-07 に必須導線2つ（`:74`）/ (iv) パスワード変更の出し分けをクレデンシャル集合で判定（`:83`）— **4件すべて充足**
  - `manual-tests/account.md` — (i) ロックアウト再現 + 脱出経路2本（TC-40 `:492`。発動回数・先送り幅を固定しない旨も環境前提 `:24` に明記）/ (ii) 直近世代の接続だけ失効（TC-39）/ (iii) 完了画面の必須導線（TC-38）/ (iv) TC-29 の対象外理由を「応答も処理経路も同一なので UI からは区別できない」へ差し替え（カバレッジ表 `executePasswordReset` 行）— **4件すべて充足**
  - `inventory/frontend.md` — `PAGE-search-001`〜`004`（`:55-58`）と `PAGE-document-edit-002`（`:50`）は**削除されていない**（受け入れ条件7 の照合対象5行が健在）/ `PAGE-password-reset-004` 新設（`:74`）/ `PAGE-settings-005` をクレデンシャル集合判定へ（`:67`）— **充足**。追加の `PAGE-search-005` / `PAGE-settings-007` も `spec/pages/index.md:187` / `:224` に**裏づけが同時に入っている**ので、台帳が生成元より先行する状態にはなっていない

- **[N-008]** ステップ14 の (A)/(B)/(C) を設計の表 30 行と突き合わせた。**B-001 の4行を除き、全行が指示どおり**である。とくに次は「一律 (C)」に逃げずに正しく判断している。
  - `createTopic.md:7` `:20` は **(B)**（設計指定どおり。「トピックはインデックスエントリを持たない」と理由まで書いた）— (A) にしていたら誤り
  - `hardDeleteTrashItem.md:24` は **(B)**、`restoreMemo.md:7` `:16` は **(B)**、`denyAiClientAuthorization.md:9` は **(B)** で括弧内の理由「拒否の事実はドメインに残らない」だけを残す — すべて指定どおり
  - `revokeAiClientConnection.md:8` は **(C)** で行ごと削除し、置き換えケース（`status = 'revoked'` の次のリクエストで DO 内ガードが拒否）を**末尾に append**（`TC-revokeAiClientConnection-002` を欠番のまま `-010` を採番）— ADR-011 の扱いとして正しい
  - `pruneExpiredTrashItems.md` は 17 → 16 件で `:16`（ユーザー横断）のみ (C)、他は Alarm 前提へ全面書き換え（`batchSize` → `chunkLimit` / `hasMore`、`listExpiredItems` → 自 DO の `purge_after` 索引）— 業務上意味のあるケース（`purgeAfter == now` の境界、1ms 過去の境界、遡及適用の短縮 / 延長、冪等性、OCC 競合）は**全部残っている**
  - 「並行する pruner」→「並行する `purge-trash` ジョブ」の差し替えは 5 ファイル（`emptyTrash` `hardDeleteTrashItem` `restoreDocument` `restoreTopic` + `spec/manual-tests/trash.md`）で漏れなく適用され、`grep -rn 'pruner' spec` は 0 行

- **[N-009]** テストケースと改訂後の上流の整合を、検索まわりで逐語照合した。**矛盾なし**。`bm25` / タイトル重み / `timestamp DESC, type, id` / trigram / 短語フォールバックと `LIKE` `GLOB` 不採用 / NFKC + `trim()` の両側適用 / 不透明カーソルの3契約 / `TOPIC_NOT_FOUND` / `InvalidCursor` / `SearchIndexUnavailable` が、`spec/domains/search.md` ↔ `spec/usecases/search.md` ↔ `spec/inventory/{domain,adapter,usecase,test}.md` ↔ `spec/testcases/search/search.md` ↔ `spec/manual-tests/search.md` ↔ `spec/database/index.md` の**6層すべてで同一の語**になっている。`spec/testcases/search/search.md:14` `:20` が「空の `PaginationResult`」のままなのは矛盾ではない — `spec/usecases/search.md:31` が `SearchOutput` = `PaginationResult<SearchResultItemDto>` + カーソルと定義し、`:73` も同じ語で書いている。

- **[N-010]** `.thread/35/step14-checklist.md:49` の「**設計の表が挙げていない行に手を入れたのは3ファイル**」は、直後に4ファイル（`#4` `#5` `#6` `#8`）を列挙しており数が合わない。成果物として PR に含まれる文書なので直しておくとよい（B-001 を修正すると 6 ファイルになる）。

- **[N-011]** 参考: B-001 の再発防止として、`.thread/35/testing.md` へ次を足すことを勧める。イベント**名**を直接書いた期待値は `V-3` の走査語に一切当たらないため、現在の検査体系には構造的な穴がある。

  ```bash
  # V-3b ドメインイベント名を直接書いた期待値（AC-3 の補完）— 期待 0 行
  grep -rnE '(memo|document|topic|identity)\.(created|edited|restored|trashed|hardDeleted|sourceLinksChanged|updated|archived|unarchived|userRegistered|passwordChanged|aiClientConnected|aiClientRevoked|trashRetentionChanged)' \
    spec --include='*.md' | grep -v '/review/' | grep -v '^spec/adr/'
  ```

  実行すると現状 4 行ヒットする（B-001 の4箇所）。

#### カバレッジ

一覧の 80 件に1対1で対応させる。**確認 70 件 / スキップ 10 件。**

**確認（70件）**

- `.thread/35/adr.md` — ADR-003 / ADR-005 / ADR-009 / ADR-010 / ADR-011 / ADR-012 / ADR-014 / ADR-015 / ADR-019 / ADR-027 の該当節
- `.thread/35/coverage.md` — 101 行を `git diff --name-only` と突き合わせ（N-003）
- `.thread/35/plan.md` — AC 表 / 検証コマンド（`V-1`〜`V-10` / `P-1`〜`P-11`）を再実行
- `.thread/35/step14-checklist.md` — 設計の表 30 行と突き合わせ（N-008 / N-010）
- `.thread/35/testing.md` — 確認項目5 / 6 / 7 / 11 / 13 の手順と期待値
- `CLAUDE.md` — 差分全文（Key concepts / 非同期実行契約 / Reference runtime / #37 移行中の注記）
- `spec/database/index.md` — `search_entries` / `search_fts` / tokenizer 方針（`:652-660`）/ `purge_after` / identity の snake_case 列名
- `spec/domains/identity.md` — W-001 の語彙照合と `AiClientConnectionRepository` 節
- `spec/domains/index.md` — テナント分離規約 / ポートの同期契約 / 派生データの更新（W-002 の根拠）
- `spec/domains/knowledge.md` — イベント定義が全滅していることの確認（B-001 の根拠）
- `spec/domains/search.md` — 「検索の規則」全文 / `SearchIndexPort` / エラーコード（N-009）
- `spec/domains/trash.md` — `purgeAfter` / `purge_after` の用語照合
- `spec/index.md` — ADR 一覧の `005` 行の superseded 注記（`V-5` 0 行）
- `spec/inventory/adapter.md` — 削除 ID 13 件の不在 / `ADP-search-001` / snake_case 語彙
- `spec/inventory/domain.md` — `DOM-search-005`〜`012` の不在 / `DOM-search-001`〜`004` `-013` `-014` / `DOM-identity-023`〜`028`
- `spec/inventory/frontend.md` — AC-19 対象（N-007）
- `spec/inventory/test.md` — **782 行を機械全件検証**（N-001 / N-002）+ 要点欄の残存語彙 grep
- `spec/inventory/usecase.md` — `UC-search-002` の不在 / `UC-search-001` / `UC-trash-007`
- `spec/manual-tests/account.md` — 差分全文 + TC 数・種別内訳（N-006 / N-007 / W-003）
- `spec/manual-tests/ai.md` — 差分全文（環境前提の反映待ち削除 / ハイブリッド → 全文検索）
- `spec/manual-tests/document.md` — 差分全文（`:25` `:131` の環境前提）
- `spec/manual-tests/index.md` — 件数表・合計・実行記録の分母を実測突き合わせ（N-006）
- `spec/manual-tests/search.md` — 差分全文 + TC 配置 + テストデータの整合（N-005 / W-003 / W-004）
- `spec/manual-tests/settings.md` — 差分全文（SQL 手順の #38 委譲）
- `spec/manual-tests/timeline.md` — 差分全文（`:29-33` の SQL 手順）
- `spec/manual-tests/trash.md` — 差分全文（環境前提 / TC-13 / TC-23 / TC-24 / カバレッジ表）
- `spec/pages/index.md` — P-02 / P-03 / P-11 / P-13（`inventory/frontend.md` の裏づけ）
- `spec/scenario/account.md` — 差分全文（N-007）
- `spec/testcases/export/exportAllData.md` — 差分全文（N-007）
- `spec/testcases/identity/approveAiClientAuthorization.md` — 差分全文
- `spec/testcases/identity/changePassword.md` — 差分全文（新設8ケースを設計の指示と照合）
- `spec/testcases/identity/changeTrashRetentionDays.md` — 差分全文（新設2ケース）
- `spec/testcases/identity/denyAiClientAuthorization.md` — 差分全文
- `spec/testcases/identity/executePasswordReset.md` — 差分全文（新設4ケース / 濫用抑止3件を足さない判断）
- `spec/testcases/identity/getCurrentUser.md` — 差分全文（N-007）
- `spec/testcases/identity/listAiClientConnections.md` — 差分全文（N-007）
- `spec/testcases/identity/loginWithPassword.md` — 差分全文（N-007）
- `spec/testcases/identity/logout.md` — 差分全文
- `spec/testcases/identity/registerOrLoginWithSso.md` — 差分全文（signup saga の phase 順 / 新設2ケース）
- `spec/testcases/identity/registerWithPassword.md` — 差分全文
- `spec/testcases/identity/requestPasswordReset.md` — 差分全文（N-007）
- `spec/testcases/identity/revokeAiClientConnection.md` — 差分全文（(C) + 末尾 append）
- `spec/testcases/knowledge/createDocument.md` — 差分全文（W-002）
- `spec/testcases/knowledge/createTopic.md` — 差分全文（(B) 判断の正しさ）
- `spec/testcases/knowledge/editDocument.md` — 差分全文（W-002）
- `spec/testcases/knowledge/editDocumentByAi.md` — 差分全文（**B-001**）
- `spec/testcases/knowledge/rollbackDocument.md` — 差分全文（W-002）
- `spec/testcases/knowledge/trashDocument.md` — 差分全文（W-002）
- `spec/testcases/knowledge/trashTopic.md` — 差分全文（**B-001** / W-002）
- `spec/testcases/knowledge/updateTopic.md` — 差分全文（**B-001** / W-002）
- `spec/testcases/memo/delete.md` — 差分全文
- `spec/testcases/memo/editMemo.md` — 差分全文
- `spec/testcases/memo/postMemo.md` — 差分全文
- `spec/testcases/memo/post_memo.md` — 差分全文
- `spec/testcases/memo/rollbackMemo.md` — 差分全文（W-002）
- `spec/testcases/memo/softDeleteMemo.md` — 差分全文
- `spec/testcases/memo/update_memo.md` — 差分全文
- `spec/testcases/search/maintainSearchIndex.md` — 削除を確認（AC-10 / AC-16）
- `spec/testcases/search/search.md` — 差分全文 + 現行全文（N-004 / N-009）
- `spec/testcases/trash/emptyTrash.md` — 差分全文（W-002）
- `spec/testcases/trash/hardDeleteTrashItem.md` — 差分全文
- `spec/testcases/trash/listTrash.md` — 差分全文（N-007）
- `spec/testcases/trash/pruneExpiredTrashItems.md` — 差分全文（N-008）
- `spec/testcases/trash/restoreDocument.md` — 差分全文
- `spec/testcases/trash/restoreMemo.md` — 差分全文（W-002）
- `spec/testcases/trash/restoreTopic.md` — 差分全文
- `spec/usecases/identity.md` — 中間状態 / セッションの世代 / リセット世代の記述（W-001）
- `spec/usecases/memo.md` — `userId スコープ` 残存の確認（W-002）
- `spec/usecases/search.md` — 入出力 / 処理手順 / エラーケース表（N-004 / N-009）
- `spec/usecases/trash.md` — `listTrash` の page 方式の維持（N-004）

**スキップ（10件）**

- `.thread/35/steps.md` — 作業手順書。成果物側（`spec/**` の差分）で結果を検証したため本文は未読
- `spec/domains/export.md` — ポート契約（`Promise` 除去 / `userId` 第一引数除去）は「ポート設計」観点の担当。本観点では `spec/testcases/export/exportAllData.md` の実行位置分割の記述として照合済み
- `spec/domains/memo.md` — 上流。テストケース側の projection 記述との矛盾が無いことは `V-3` / イベント名 grep（N-011）で機械確認したのみ
- `spec/idea.md` — 現在の前提を述べる履歴的文書。テストケース・台帳・手順書のいずれとも参照関係を持たない
- `spec/requirements.md` — AC-4 / AC-5 は要件観点の担当。本観点では `P-1` の `FTS5` 出現数（1 以上）と `P-11`（`検索方式の選択をAIに委ねない` が 1 行）を機械確認したのみ
- `spec/scenario/ai.md` — シナリオ層。対応する `spec/manual-tests/ai.md` を差分全文で確認したことで代替
- `spec/scenario/index.md` — シナリオ目次。テストケース・台帳との参照関係を持たない
- `spec/scenario/search.md` — シナリオ層。`P-1` の `全文検索` 1 以上を機械確認。S-SE-01 / S-SE-02 への参照が `spec/testcases/search/search.md` と `spec/manual-tests/search.md` の双方で健在であることは確認済み
- `spec/usecases/export.md` — ユースケース観点の担当。本観点では `exportAllData.md` の上限・実行位置の期待値として照合済み
- `spec/usecases/knowledge.md` — ユースケース観点の担当。イベント語彙の残存が無いことは `V-3` / イベント名 grep（N-011）で機械確認したのみ
