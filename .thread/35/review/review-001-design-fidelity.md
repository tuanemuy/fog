# レビュー 001 — 設計正本との忠実性・CLAUDE.md・切り出し境界

**対象:** PR #46（ベース `main`）/ Issue #35
**契約:** `.thread/35/plan.md`（AC-12 / AC-13 / AC-16 / AC-17 を主担当）
**正本:** `.thread/34/design.md` 第11.1節（`2289-2490`）・第7.7節（`1934-1958`）・第8.2節 / 第8.2.1節、`.thread/34/handoff.md`
**変更ファイル:** 80件（一覧と1対1のカバレッジを末尾に置く）

判定材料はすべて実測で再現した。`V-1`〜`V-10` は全 0 行、`P-1`〜`P-7` / `P-11` は全ヒット、`P-8` / `P-9` / `P-10` は 0 行、`spec/` の非 review Markdown 100 ファイル・`NO-VERDICT` 0 行。**機械ゲートは全通過している。以下は機械では捕まらない領域の指摘である**（`.thread/34/handoff.md` 第4節が「#34 では検査を設計できなかった」と明言した2つの破れ方に的を絞った）。

---

## Blockers

- **[B-001]** `.thread/34/handoff.md` 第3節「#37 が落としてはいけない前方互換点」の**2番目が `spec/database/index.md` に落ちていない。**
  - 場所: `spec/database/index.md:557-566`（`credential_mappings` の「saga コーディネーター状態」）/ `:588`（`cm_reservation_idx`）/ `:456`（`sweep-reservations`）
  - handoff の4点のうち、1番目（`operations.targetLocators`）は `spec/database/index.md:480`「**`target_locators` は終端の後始末が終わるまで消さない**（消すと回収の材料が失われる）」として否定形で書かれ、4番目（`credential_mappings.changeState` の3値）は `:537` に CHECK ごと書かれている。**2番目「コーディネーター予約行（`locators[]` / `candidateUserId` / `callerToken` を持つ行）を、終端の各段が終わるまで消さない」だけが、どのファイルにも存在しない。**
  - 危険なのは、消す側の規則のほうは書かれていることである。`saga_committed` の説明は `:564`「印のある予約行は期限切れ掃除の対象から外れる」だけで、`cm_reservation_idx`（`:588`）は `WHERE saga_committed IS NULL` を作業述語に持ち、`sweep-reservations`（`:456`「予約の期限切れ掃除」）がそれを駆動する。**`saga_committed` が付かないまま終端した saga の予約行は、`reserved_until` を過ぎた時点で掃除の対象になる**と読める。そのとき消えるのは `locators` / `candidate_user_id` / `caller_token` — handoff が「回収の材料」として名指しし、「これを落とすと **#45 がどう設計しても後から入れられなくなる**」と書いた当のものである。
  - `spec/` は #37 の唯一の入力である（ADR-006 が「`spec/` が単独で読める」ことを本ファイルの設計目標に置き、`spec/` から `.thread/34/` への参照は実測で 0 件）。**design.md 側にもこの切り出しは未反映（ADR-009）なので、この規則が落ちる先は現状 `spec/database/index.md` しか無い。**
  - 提案: `credential_mappings` の節（`:590` 付近の箇条書き）に `:480` と同じ形の1行を足す。「**終端の後始末が終わるまで予約行を消さない**（`locators` / `candidate_user_id` / `caller_token` が回収の唯一の材料である）。掃除と終端の関係の具体は #45 が決める」。**これは #45 の射程（段の順序・原子性境界・材料寿命・再試行上限）に一切踏み込まずに書ける** — `:437` と `:480` が既にその書き方の手本になっている。

---

## Warnings

- **[W-001]** `CLAUDE.md` の「Key concepts」導入文が、本 PR で足した項に対して嘘になっている。
  - 場所: `CLAUDE.md:66`「Each of these is enforced in code and documented in library-level JSDoc at the relevant module — read there for the details.」/ 対象は `:68`（同期 UoW）`:71`（Storage limits）`:73-92`（Asynchronous execution contract）
  - #37 が入るまで、Durable Object も `jobs` も Alarm も FTS5 も 10 GB 上限もコードに存在しない（実測で `packages/core/src/application/execution/unitOfWork.ts:14` は今も `collectEvents` を持ち、`adapters/d1/pendingBatch.ts` も `_occ_guard` も現存する）。**この導入文は節の先頭で読者を実在しない JSDoc へ送る。**
  - ADR-005 は「移行中の注記を1箇所に集約する」ことを選び、その1箇所を `## Reference runtime` の下（`:124`）に置いた。判断自体は妥当だが、**集約の代償として「Key concepts の導入文が節全体に掛かる断定である」ことが見落とされている。** 移行注記の「Everything above states the rules; the code has not moved yet」は `:126` にあり、`:66` を読む時点では未読である。
  - 提案は2つ。(i) `:66` を「規則の要約である。実装済みの項は…」の形へ緩めるか、(ii) `:66` に「（移行中の項については `Reference runtime` の Migration in progress を参照）」を1句足す。**ADR-005 の「1箇所集約」は壊さずに済む。**

- **[W-002]** `spec/domains/index.md` の「ポートの同期契約」の**理由づけが判定基準として機能しておらず、同じ PR の別ファイルと食い違う。**
  - 場所: `spec/domains/index.md:34`「例外は `PasswordHasher` と `MailSender` の2つで、**どちらもトランザクションの外（request Worker / ジョブ実行）で動くので** `Promise` のまま残る」 vs `spec/domains/export.md:277-280`（`ArchiveWriter.write` は `ArchiveBinary` を返す同期契約でありながら「**実行位置は Durable Object の外（リクエストを受ける側）である**」）/ `spec/inventory/domain.md:148`（`DOM-export-011` が「**同期契約**」と明記）
  - 結論そのものは design 第8.2.1節の表と一致している（export の各ポートは同期、`PasswordHasher` / `MailSender` だけ `Promise`）。**問題は #35 が新しく書いた「ので」の部分で、これは十分条件になっていない** — `ArchiveWriter` も外で動くのに同期だからである。
  - ステップ6（`domains/index.md`）とステップ7（`domains/export.md`）というチャンク境界で生じた食い違いであり、`V-*` にも `P-*` にも掛からない。**`spec/` だけを読む #37 がこの一文を判定基準として適用すると、`ArchiveWriter.write` を `Promise` に戻す。**
  - 提案: `:34` の理由を design 第8.2.1節の実際の線（`PasswordHasher` / `MailSender` は暗号計算と外部 I/O であり、非同期 API しか持たない）へ差し替えるか、「例外は列挙であって導出規則ではない」ことを明記する。

- **[W-003]** handoff 第3節の前方互換点**3番目が肯定形でしか書かれていない。**
  - 場所: `spec/database/index.md:71`「`caller_token` … **退会の完走時に消す**。ログ・エラー・ジョブの `terminal_reason` に出さない」
  - handoff の要求は「`account.callerToken` を**退会完走時以外に消さない**」である。現行の文は「いつ消すか」を述べるだけで、「それ以外では消さない」を言っていない。saga の終端処理で後始末として消す実装を、この文は止められない。
  - 1番目（`:480`）は同じ内容を否定形で書けている。**同じ形（「〜まで消さない」）に揃えれば1語で閉じる。**

- **[W-004]** `.thread/35/adr.md` が自分に課した「**PR 本文に明記する**」という義務が、**6件すべて未履行**である。
  - 場所: `.thread/35/adr.md` の ADR-005（波及: 「#37 の本文編集は #35 のスコープ外なので、**PR 本文に引き継ぎとして書く**」）/ ADR-007（波及: 「**PR 本文にこの読み替えを明記する**」）/ ADR-009（「ずれの根拠は本 ADR と handoff 第2節であり、**PR 本文にも明記する**」）/ ADR-011（同）/ ADR-013（同）/ ADR-027（同）
  - PR #46 の本文には、これら6件のどれも書かれていない（Summary / Test plan / 残タスクを全文確認）。
  - **`spec/` が design 第11.1節の指示から意図的にずれている箇所が5つある**（`changePassword.md` の巻き戻し列の非記載 / `manual-tests/index.md` の判定上書き / 台帳イベント行24件の追加削除 / スナップショット物理形の非転記 / `executePasswordReset.md` の濫用抑止3件の非追加）。**ADR ファイルに記録は残っているが、PR を読む人と #34 の owner にはその signal が届かない。** ADR 自身がその届け先を PR 本文と決めているので、履行しないと「ずれが黙って通る」形になる — handoff 第4節が警告した破れ方と構造が同じである。
  - なお ADR-005 の #37 引き継ぎだけは `CLAUDE.md:132`「When #37 lands, delete this subsection.」が受け皿として機能しており、実害は最も小さい。

- **[W-005]** `README.md` が改訂後の `CLAUDE.md` と正面から矛盾したまま残り、**引き継ぎ先の記録が `.thread/35/` の1行しかない。しかもその1行の帰属が不正確である。**
  - 場所: `README.md:53`「… a paired entry point — **the inward layers stay put**.」/ `:51`「The template targets **Cloudflare Workers + D1 + Queues**」/ `:18`「**Outbox pattern** — …」 vs `CLAUDE.md:110-114`
  - `README.md:53` は、design 第8.2.1節が「これは実際に破れる」と名指しし `V-8` が消しに行った文言そのもの（`the inward layers stay put`）である。**`V-8` の射程が `CLAUDE.md` だけなので、同じ文がリポジトリのトップに素通りで残っている。**
  - 触らない判断自体は正しい（AC-17 のホワイトリストは `spec/**/*.md` / `CLAUDE.md` / `.thread/35/**` であり、`README.md` を編集すると AC-17 違反になる）。問題は**引き継ぎ先が記録されていない**ことで、`.thread/35/testing.md:306`「`README.md` / `docs/runtime_cloudflare.md` は対象外。どちらも Outbox / D1 前提の記述を持つが、**更新は #38 の担当である（plan.md スコープ「含まれないもの」）**」が唯一の記述である。**ところが plan.md のスコープ節が #38 へ委ねているのは `docs/runtime_cloudflare.md` だけで、`README.md` は一言も出てこない。** 存在しない根拠を引いており、#38 の Issue 本文にも PR 本文にも受け皿が無い。
  - 提案: PR 本文の「残タスク」に1行足す（W-004 と同じ場所で閉じられる）。

- **[W-006]** `.thread/35/step14-checklist.md` の件数が本文と食い違う。
  - 場所: `.thread/35/step14-checklist.md:49`「**設計の表が挙げていない行に手を入れたのは3ファイル**（#4 `emptyTrash.md:10` / #5 `hardDeleteTrashItem.md` の5行 / #6 `restoreDocument.md` の3行 / #8 `restoreTopic.md` の2行）」
  - 列挙されているのは**4ファイル・11行**であり、`.thread/35/adr.md`（ADR-028）も「増えたのは4ファイル11行」と書いている。`3` が誤り。
  - 実物は正しい（4ファイル11行に (A) が適用されていることを差分で確認済み。`grep -rn 'イベント' spec` は非 review で 0 行、イベント名の直接記述も 0 行）。**チェックリスト側の数字だけがずれている** — このチェックリストは「設計の表と1対1で照合する」ための成果物なので、数え間違いはそのまま照合の信頼度に効く。

- **[W-007]** AC-14 / AC-15（ステップ18）が未達で、`steps.md` ステップ19 の完了ゲート5が落ちている。
  - 実測: `#10` は `ADP-UD-001`〜`004` / `DOM-SEARCH-001`〜`004` / `UC-SEARCH-001` / `TEST-DO-004,006,007` / `TEST-MAN-002` の **13件が改訂後の台帳に不在**。`#13` は `DOM-identity-016` / `DOM-identity-017` / `TC-revokeAiClientConnection-002` の **3件が残ったまま**で、台帳側からは既に消えているので非対称が現に生まれている。
  - PR 本文の「残タスク」が理由つきで延期を宣言している（「レビューで台帳の ID が動くと、先に更新した Issue 本文が古くなるため」）ので**意図的な延期であり見落としではない**。ただし design 第11.1節は「#35 は `spec/inventory/` の改訂後に **#13 のチェックリストも突き合わせる**」と名指ししているので、**マージ前に必ず閉じる必要がある**。この Warning はその確認のために残す。

---

## Notes

- **[N-001]** **設計 第7.7節の7項目は `CLAUDE.md` に1項目ずつ写されており、原文と突き合わせて漏れも改変も無い。** 項1（transport 不在 + `transactionSync` 内の3つの副作用）→ `:75`、項2（外部 I/O は必ずジョブ / ただし全数ではない + 4類型表 + 「`kind` を足したらここにも足す」）→ `:76-84`、項3（at-least-once / Alarm 1本 / `nextRunAt` 順 / 冪等 / `providerIdempotencyKey`）→ `:85`、項4（順序保証なし / phase と CAS で表現）→ `:86`、項5（`alarm()` から throw しない / `attempt` と `nextRunAt` / 上限超過は `poison` + `terminalReason` / 唯一の広い catch）→ `:87`、項6（OCC 非再試行）→ `:88`、項7（冪等キーをクライアントに持たせない / `operationId` はサーバー採番 / 予約行と `changeState`）→ `:89`。4類型表の `kind` 12種は `spec/database/index.md:444-457` の全数表と**類型欄まで**1対1で一致する（`P-9` の 0 行に加えて手で突き合わせた）。
- **[N-002]** **「ランタイムを差し替えても domain / application / presentation は無傷」は削除され**（`V-8` が 0 行）、第8.2.1節のロックイン記述（`TransactionalRepository` とリポジトリが値を返す / `PasswordHasher` / `MailSender` だけ非同期 / 「swap は `adapters/` とエントリポイントに閉じない」）へ置き換わっている。**エントリポイント一覧（`worker/cloudflare/{relay,consumer,pruner,dlq}.ts`）と #40 の段落は残り**、移行注記（`:124-132`）から「この4本は #37 で消える」と名指しされている — ADR-005 の (c) がそのとおり実装されている。移行注記の3つの主張（`adapters/d1/` が live / `run` は非同期で `collectEvents` を持つ / `pendingBatch.ts` と `_occ_guard` が現存 / DO・`jobs`・Alarm・FTS5 はコードに無い）は**実ファイルに当てて全件正しいことを確認した。**
- **[N-003]** **#45 の切り出し境界は守られている。** `spec/` に現れるのは一様な終端（`terminal_reason` + `poison` + operator エスカレーション。`spec/database/index.md:436-437` / `:726`）と、利用者から観測できる結果（中間状態では旧新どちらのパスワードも通らない / 終端後は旧パスワードで入れる）までである。**巻き戻す列の列挙・段構成（3-i〜3-iii）・終端モードの印の前倒し書き込み・材料寿命・後始末の再試行上限・(ii) の受け口の割り当ては 0 件**（`巻き戻し` の非 review ヒット3件はいずれも別文脈 — `manual-tests/trash.md:215` の時計の巻き戻し、`database/index.md:704` の PITR、`domains/memo.md:142` の履歴）。`:437` が「#45 が決めるので本ファイルには書かない」と明示し、`testcases/identity/{changePassword.md:27,executePasswordReset.md:26,registerOrLoginWithSso.md:18}` と `inventory/test.md:76,113` が dangling 回避の #45 名指しを持つ（ADR-009 の Consequences どおり）。**#44 も同様**（`database/index.md:463` の `rotate-remap` / `:644` の `rotation_checkpoints` / `ADP-rotation-checkpoints-001`）。
- **[N-004]** **handoff 第3節「残すもの（#34 の成果。消してはならない）」7項目は、B-001 で指摘した1点を除き `spec/` 側に残っている。** `poison` / backoff / `jobs` 12列 → `database/index.md:408-437`（12列を数えて 12 で design 第4.1.1節と一致）、中間状態の観測 → `usecases/identity.md:50,100,244,286`、回収材料の置き場 → `operations.target_locators`（`:475`）/ `locators`（`:565`）/ `candidate_user_id`（`:562`）/ `caller_token`（`:71` / `:572`）/ `change_state` の3値（`:537`）、operator 経路 `purge-user-mappings` / `cancel-reservation` → `:726`、一様な終端 → `:437`、「黙って中間状態を残す」を選ばない → `:437`。**第6.9節の締め出し経路22件の列挙だけは `spec/` に無いが、これは「落ちた」ではなく「対象外」と読むのが妥当**である — design 第11.1節は `spec/` への転記を指示しておらず、handoff 第3節の7項目は design.md 側で消すなという要求だからである。
- **[N-005]** **ADR 参照（AC-13）は要求どおり。** `git diff --name-only` に `spec/adr/` も `.adr/` も1件も現れず（本文無改変）、`spec/index.md:42` は ADR 一覧表の `005` 行を**リンクごと残したうえで同一行に superseded 注記**を置いている。ADR-014 が固定した2条件 —「行頭セルの形（`| [005](...)`）を保つ」「併記側にファイル名 `005-search-index-via-outbox` を書かない」— は両方守られており、`V-3` の除外パターンに実際に一致する。`.adr/002`〜`004` への導線表も新設された。`spec/` と `CLAUDE.md` の相対リンクを全数機械検査して**破断 0**、`.adr/` の3ファイルはすべて実在する。無注記の `ADR-005` 参照は `V-5` で 0 行。
- **[N-006]** **スコープ（AC-17）は完全にクリーン。** 80件すべてが `spec/**/*.md` / `CLAUDE.md` / `.thread/35/**` に収まり、ホワイトリスト違反 0 行。`spec/**/review/` の39ファイルと `.adr/` の4ファイルは1バイトも変わっていない。カバレッジ台帳も検算した — `.thread/35/coverage.md` は 101 行（重複なし・ファイル欠落なし）で、内訳は 改訂 71 + 改訂（ADR-010 上書き）1 + 削除 1 + 影響なし 28 = 101。ヘッダの「改訂 73 / 影響なし 28」と整合する。
- **[N-007]** **ADR-017 以降（実装中に足された分）はいずれもスコープ超過ではない、と判断した。** 自己申告のある4件について: **ADR-024**（`ADP-users-001` を行き先記録として残す）は steps.md の「行き先を台帳に明記する」の実行方法を決めただけで新しい要求を足していない。**ADR-025**（`ADP-identity-001`〜`005` を 1:1 読み替え）は ADR-019 が確定した実ポート構成（`CredentialMappingRepository` に書き込みメソッドが無い）との突き合わせの帰結で、字面どおり10行に割ると実体の無い行が2行生まれる — 実物を正とした判断は妥当。**ADR-028**（設計の表が挙げていない11行にも (A)/(B) を適用）は第7.3節の断定を適用先へ届ける作業そのもので、handoff 第4節 罠1 の予防にあたる。**ADR-033**（`manual-tests/search.md` の新設を4件に留める）は ADR-010 の申し送りを確定させたもので、「UI から起こせるか」という単一基準で粒度差を説明できている。台帳の欠番規約（ADR-011）も実測で守られている — `DOM-identity` は 013〜017 が欠番のまま `023`〜`028`（`AiClientConnectionRepository` の6本）が改訂前と同じ要素を指し続け、`DOM-memo` 007〜012 / `DOM-knowledge` 015〜027 / `DOM-search` 005〜012 も欠番、新設は末尾 append（`DOM-identity-034/035` / `DOM-search-013/014` / `ADP-identity-017`）。
- **[N-008]** `CLAUDE.md:68` の「one per table」は厳密には正しくない。`operations` だけ `recordOperation` / `updateOperation` の2本を持つので、口は「6テーブル / 7メソッド」である（design 第8.2節は「7行のうち6行が口を持つ」と書いている）。断定の強さの割に1語ずれているだけで実害は小さいが、`_meta` の例外を「single deliberate exception」と強く書いている文脈なので、正確さを揃えるなら「one per table (`operations` takes two)」程度でよい。
- **[N-009]** チャンク境界の整合は、B-001 / W-002 以外は取れている。個別に当たったのは — 要件 4.4/4.5 ↔ `domains/search.md` の `SearchQuery` / 検索の規則 ↔ `usecases/search.md` の DTO・エラー表 ↔ `testcases/search/search.md` の39ケース ↔ `pages/index.md` P-11 の不透明カーソル（`V-10` 0 行に加えて DTO のフィールド往復まで確認）、`database/index.md` の `search_entries` 8列 ↔ `domains/search.md` の `IndexEntry` ↔ `ADP-search-entries-001`（ADR-023 の「原文を持たない / トピック名を複製しない / `source_ids` は JSON」が3箇所で一致）、`purge_after` の保存化（`domains/trash.md` ↔ `database/index.md` の3テーブル CHECK と `*_purge_idx` ↔ `usecases/{memo,knowledge,identity,trash}.md` ↔ `testcases/trash/*` ↔ 台帳。ADR-020 の「シグネチャまで届かせる」が実際に届いている）、`CLAUDE.md` の4類型 ↔ `jobs.kind` 全数表 ↔ Identity Directory 側の6種（`:624`）。**`spec/inventory/test.md` の `#L` も検算した** — `TC-search-*` の39行が `search.md` の39ケース行に `L7`〜`L45` で1対1に対応し、欠番（006 / 022 / 028 / 029）も保たれている。
- **[N-010]** `spec/database/index.md:58` の「trash / export ドメインは自前のテーブルを持たない（ADR-004）」から `search` が外され、「**search は `search_entries` / `search_fts` を持つ**」が明記されている。plan.md がリスクとして名指しした「どの負の検証にも掛からない `:35` の宣言」（AC-7 と正面から矛盾する行）は解消済み。`:355-357` の「認証インフラテーブルはスコープ外」宣言も、`## 本ファイルで定義しないテーブル`（`:728`）— `jti` 表は #13、スナップショットの物理形は #37 — という**預け先を名指しした2項目**に置き換わっており、ADR-006 が避けたかった dangling が発生していない。

---

## カバレッジ

変更ファイル一覧（80件）と1対1で対応させる。「確認」は差分または全文を読んだもの、「機械確認」は差分本文を個別には読まず、負の検証（`V-1`〜`V-10`）・正の検証（`P-1`〜`P-11`）・`イベント` 全数 grep（非 review で 0 行）・イベント名の直接記述 grep（0 行）・`.thread/35/step14-checklist.md` の行別照合・台帳アンカー検査で覆ったものである。

**確認（差分または全文を読んだ）— 50件**

`CLAUDE.md`, `.thread/35/adr.md`, `.thread/35/coverage.md`, `.thread/35/plan.md`, `.thread/35/step14-checklist.md`, `spec/database/index.md`, `spec/domains/export.md`, `spec/domains/index.md`, `spec/domains/search.md`, `spec/idea.md`, `spec/index.md`, `spec/inventory/adapter.md`, `spec/inventory/domain.md`, `spec/inventory/frontend.md`, `spec/manual-tests/ai.md`, `spec/manual-tests/document.md`, `spec/manual-tests/index.md`, `spec/manual-tests/search.md`, `spec/manual-tests/settings.md`, `spec/manual-tests/timeline.md`, `spec/pages/index.md`, `spec/requirements.md`, `spec/scenario/account.md`, `spec/scenario/ai.md`, `spec/scenario/index.md`, `spec/scenario/search.md`, `spec/testcases/export/exportAllData.md`, `spec/testcases/identity/getCurrentUser.md`, `spec/testcases/identity/loginWithPassword.md`, `spec/testcases/identity/requestPasswordReset.md`, `spec/testcases/knowledge/createDocument.md`, `spec/testcases/knowledge/createTopic.md`, `spec/testcases/knowledge/editDocument.md`, `spec/testcases/knowledge/editDocumentByAi.md`, `spec/testcases/knowledge/rollbackDocument.md`, `spec/testcases/knowledge/trashDocument.md`, `spec/testcases/knowledge/trashTopic.md`, `spec/testcases/knowledge/updateTopic.md`, `spec/testcases/memo/delete.md`, `spec/testcases/memo/editMemo.md`, `spec/testcases/memo/postMemo.md`, `spec/testcases/memo/post_memo.md`, `spec/testcases/memo/rollbackMemo.md`, `spec/testcases/memo/softDeleteMemo.md`, `spec/testcases/memo/update_memo.md`, `spec/testcases/search/search.md`, `spec/testcases/trash/restoreMemo.md`, `spec/testcases/trash/restoreTopic.md`, `spec/usecases/export.md`, `spec/usecases/search.md`

**部分確認（該当節・該当行のみ読み、残りは機械確認）— 12件**

- `.thread/35/steps.md` — ステップ12 / 15.5 / 16.5 / 17 / 18 / 19 を精読。ステップ1〜11・13〜16 は見出しと根拠節の引用のみ
- `.thread/35/testing.md` — 確認環境節と確認項目1〜2、および `:306`（README / docs の扱い）を精読。確認項目3〜20 は未読
- `spec/domains/identity.md` — `:354-356`（ポート分割）と `PasswordHasher` / `MailSender` の `Promise` 残置箇所
- `spec/inventory/test.md` — `TC-search-*` 39行を全数照合。他は `changeState` / `purge_after` / `#45` を含む行のみ
- `spec/inventory/usecase.md` — `UC-search-*` の欠番、`UC-identity-001/002/006`、`UC-trash-001/007`
- `spec/manual-tests/account.md` — `P-7`（`ロックアウト`）、種別集計（13/23/4）、カバレッジ表 `:591`
- `spec/manual-tests/trash.md` — `:215`（DO シード投入 / #38 への委譲）、`V-2c` 対象箇所
- `spec/testcases/identity/changePassword.md` — `:20` / `:21` / `:27`（中間状態3値と終端）
- `spec/testcases/identity/executePasswordReset.md` — `:23` / `:26`
- `spec/testcases/identity/listAiClientConnections.md` — `createdAtResetVersion` を含む行
- `spec/testcases/identity/registerOrLoginWithSso.md` — `:18`（中間状態と一様な終端）
- `spec/usecases/identity.md` — `:50` / `:100` / `:141` / `:244` / `:286` / `:473`（物理境界跨ぎと中間状態・終端の記述）

**機械確認（差分本文を個別には読んでいない）— 18件**

`spec/domains/knowledge.md`, `spec/domains/memo.md`, `spec/domains/trash.md`, `spec/testcases/identity/approveAiClientAuthorization.md`, `spec/testcases/identity/changeTrashRetentionDays.md`, `spec/testcases/identity/denyAiClientAuthorization.md`, `spec/testcases/identity/logout.md`, `spec/testcases/identity/registerWithPassword.md`, `spec/testcases/identity/revokeAiClientConnection.md`, `spec/testcases/search/maintainSearchIndex.md`（削除。ファイル不在と台帳からの `TC-maintainSearchIndex-*` 28件の消失を確認）, `spec/testcases/trash/emptyTrash.md`, `spec/testcases/trash/hardDeleteTrashItem.md`, `spec/testcases/trash/listTrash.md`, `spec/testcases/trash/pruneExpiredTrashItems.md`, `spec/testcases/trash/restoreDocument.md`, `spec/usecases/knowledge.md`, `spec/usecases/memo.md`, `spec/usecases/trash.md`

**スキップ — 0件**

計 50 + 12 + 18 = **80件**。
