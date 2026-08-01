# レビュー 002 — 設計正本との忠実性・CLAUDE.md・切り出し境界

**対象:** PR #46 / `origin/main...HEAD`（97ファイル）
**観点:** 設計正本（`.thread/34/design.md`）との忠実性 / `CLAUDE.md`（AC-12）/ #44・#45 の切り出し境界 / ADR とスコープ（AC-13・AC-16・AC-17）
**ラウンド:** 2（ラウンド1の Blocker 10 / Warning 27 は `.thread/35/review/triage.md` で判定済み。既判定は再提出しない）
**本ラウンドの主目的:** `.thread/34/handoff.md` 第4節 罠2「同一ラウンド内で入れた複数の修正どうしの整合を、誰も検査していない」の検査

**結果: Blockers 3 / Warnings 5 / Notes 5**

---

## Blockers

### **[B-001]** W-024（ポートの同期契約の例外理由）の是正が3箇所に届いておらず、撤回された判定基準が残っている

> **これは W-024 の再審議ではない。** W-024 の判定（`fix`）はそのまま受け入れたうえで、**合意された修正が正本にしか適用されず、適用先3箇所に届いていない**ことの報告である（handoff 第4節 罠1）。

**場所**

- `CLAUDE.md:114`（Reference runtime）— "only `PasswordHasher` / `MailSender` remain asynchronous **because they run outside transactions**"
- `spec/inventory/domain.md:32`（`DOM-identity-029`）— 「**トランザクションの外で動くため Promise 契約のまま残る**」
- `spec/inventory/domain.md:36`（`DOM-identity-033`）— 同上
- 対する正本: `spec/domains/index.md:34` / `spec/domains/identity.md:369`

**理由**

ラウンド1の W-024（`fix` 判定 / `.thread/35/adr.md` ADR-052）は、まさにこの理由づけを**判定基準として成立しないもの**として撤回している。改訂後の `spec/domains/index.md:34` は次のとおり:

> **例外は `PasswordHasher` と `MailSender` の2つで、これは列挙であって導出規則ではない** — 残る理由は「暗号計算と外部 I/O であり、実装できる API が非同期しか無い」ことである。**トランザクションの外で動くことは `Promise` の根拠にならない**（`ArchiveWriter.write` は Durable Object の外で動くが同期契約である。domains/export.md）

上の3箇所は撤回された側（「外で動くから非同期」）を**そのまま断定形で、しかも太字で**残しており、**同一 PR 内の正本と適用先が正反対のことを言っている**。とくに `CLAUDE.md` は #37 の実装者が最初に読む文書であり、この基準を適用すると `ArchiveWriter.write`（`spec/domains/export.md` / `DOM-export-011` で同期契約）を `Promise` へ戻す — ADR-052 が「実装者がやってしまう」と名指しした破れ方そのものである。

**ADR-052 の「波及」欄は `spec/domains/index.md` / `spec/domains/identity.md` の2件しか挙げておらず、`CLAUDE.md` と `spec/inventory/domain.md` を数え落としている。** ラウンド1のレビュー（`review-001-domain-usecase.md:95` の N-002）が `DOM-identity-029/030/033` にも同じ言い回しがあることを**既に本文で記録していた**にもかかわらず、修正担当が分かれた結果その情報が反映されていない。正本だけが直って適用先に届かない形（handoff 第4節 罠1）と、同一ラウンドの修正どうしが互いを検査していない形（罠2）が重なっている。`V-1`〜`V-10` / `P-1`〜`P-11` のどれにも掛からない。

**提案**

3箇所とも `spec/domains/index.md:34` の結論へ揃える。

- `CLAUDE.md:114` 例: "Domain port contracts are synchronous — `TransactionalRepository` and the repositories return values, not promises. `PasswordHasher` / `MailSender` are the only asynchronous ports, and that list is an enumeration, not a derived rule: they stay asynchronous because the only APIs that can implement them are asynchronous, not because they run outside a transaction (`ArchiveWriter.write` runs outside the DO and is still synchronous)."
- `spec/inventory/domain.md:32` / `:36` 例: 「**実装できる API が非同期しか無いため `Promise` 契約のまま残る**（例外は列挙であって導出規則ではない。domains/index.md）」

あわせて ADR-052 の「波及」欄に `CLAUDE.md` と `spec/inventory/domain.md` を足す。

---

### **[B-002]** `CLAUDE.md` が、本 PR が同ラウンドで採択した ADR-054「員数を数値で持たない」に正面から違反している

**場所**

- `CLAUDE.md:68`（Key concepts / Unit of Work）— "…: seven tables, six of which have a way in — `operations` takes two methods, so six stores carry seven methods — while `_meta` has none…"
- 対する決定: `.thread/35/adr.md` ADR-054（`:1586-1608`）

**理由**

ADR-054 の Decision は逐語で次のとおり:

> **`CLAUDE.md` には3つだけを書く** — (1) ストアの列挙、(2) 例外構造（`operations` が2本・`_meta` が0本）、(3)「全数の正本は `spec/database/index.md`」。**員数は書かない。**

Context も「`CLAUDE.md` に『6ストア・7メソッド』と**員数を焼き込む**と、`spec/database/index.md` の全数表と食い違ったときに**両方が嘘になる**」と、いま `CLAUDE.md` に書かれている文字列を名指しで禁じている。ADR は `Status: Proposed` のまま superseded も撤回もされておらず（60件すべて `Proposed`、supersede 記述なし）、後続 ADR がこれを覆してもいない。

**同一ラウンドで採択された自分の決定を、同一ラウンドの成果物が破っている。** 数値そのものは現時点では `spec/database/index.md:747` / `:752` と一致している（7テーブル / 6ストア / 7メソッド）ので実害はまだ無いが、ADR-054 が防ごうとしたのはまさに「今は合っているが後で片方だけ動く」ことである。ADR とその成果物の食い違いは、次に `CLAUDE.md` を触る人がどちらに従うべきか判定できない状態を残す。

**提案**

`CLAUDE.md:68` の該当箇所から員数を落とす。ADR-054 が求めた3要素（列挙 / `operations` は2本・`_meta` は0本 / 正本は `spec/database/index.md`）はいずれも既に本文にあるので、削るのは "seven tables, six of which have a way in — … so six stores carry seven methods —" の部分だけでよい。例:

> Those two groups are the **complete set** of write paths into the non-aggregate stores — `operations` is the only one reached by two methods, and `_meta` has none, since only the adapter writes it and no usecase may reach `schema_version`. The per-table roster (and its count) lives in `spec/database/index.md`.

員数を残す判断に倒すなら ADR-054 を明示的に撤回・上書きすること。**どちらでもよいが、両立はしない。**

---

### **[B-003]** 廃止した一意性機構「insert の一意制約違反」が、ユースケースのエラーケース表に残っている

**場所**

- `spec/usecases/identity.md:60` — `| 同時登録レース（insert の一意制約違反） | ConflictError("EMAIL_ALREADY_REGISTERED") |`
- `spec/usecases/identity.md:111` — `| 同時初回サインインのレース（insert の一意制約違反） | ConflictError("SSO_IDENTITY_ALREADY_REGISTERED") |`
- `spec/manual-tests/account.md:580` — `| registerWithPassword | 同時登録レース（一意制約違反） | 対象外 | …`

**理由**

改訂後の設計では、**メール / SSO 主体の一意性の権威は Identity Directory 側の予約獲得（`reserveCredential`）だけ**である。同一 PR の他の記述がすべてそう言っている:

- `spec/usecases/identity.md:45`（同じファイルの処理フロー手順4）「**認証情報側**でメールの予約を取る…既に使われていれば `ConflictError`」／手順5「**予約に勝った場合だけ**…初期化する」
- `spec/domains/identity.md:415`「一意性違反 → `ConflictError(...)`。**事前チェックではなく予約の獲得で判定する**（同時登録のレースはこちらで捕捉される）」
- `spec/inventory/adapter.md:9`（`ADP-users-001`）「**共有の `users` テーブルは存在しない。** …`users_email_uq` / `users_sso_identity_uq` を1枚に載せていた前提ごと消える」
- `spec/testcases/identity/registerWithPassword.md`「**認証情報側の予約獲得に敗北し** `ConflictError("EMAIL_ALREADY_REGISTERED")`」／`registerOrLoginWithSso.md` も同じ

書き込み先である `user_settings` は**ユーザー単位 DO 内の単一行テーブルで、メールも SSO 主体も列に持たず、一意制約も存在しない**（`spec/database/index.md:82-95` / `ADP-user-settings-001`）。したがって「insert の一意制約違反」は**改訂後の構成では原理的に発生しない事象**であり、実装契約として嘘である。

本 PR は同じ2つのユースケースの**処理フロー側**の括弧書き（`- 3. UserRepository.insert(user) で永続化する（同時登録レースは DB の email 一意制約で捕捉）` / `- 4. UserRepository.insert(user)（… (provider, providerSubject) 一意制約で捕捉）`）は正しく削除しているのに、**同じファイルのエラーケース表の行だけを取り残している。** handoff 第4節 罠1「正本だけを直して適用先の散文に届けない」の典型で、`V-1`〜`V-10` / `P-*` のどの検査にも掛からない（走査語に「一意制約」が無い）。

**提案**

3行とも捕捉主体を予約獲得へ差し替える。例:

- `:60` → `| 同時登録レース（認証情報側の予約獲得に敗北） | ConflictError("EMAIL_ALREADY_REGISTERED") |`
- `:111` → `| 同時初回サインインのレース（認証情報側の予約獲得に敗北） | ConflictError("SSO_IDENTITY_ALREADY_REGISTERED") |`
- `spec/manual-tests/account.md:580` → 「同時登録レース（予約獲得の敗北）」

あわせて `grep -rn '一意制約' spec --include='*.md' | grep -v '/review/'` を完了ゲートの目視項目に足すことを勧める（残る 21 件はリビジョンの `(id, revision_number)` PK とトピック名の非一意性で、いずれも正しい記述であることを確認済み）。

---

## Warnings

### **[W-001]** ADR-056 の決定が `CLAUDE.md` に半分しか反映されておらず、ADR 本文自体が本 PR で削除した項を前提にしている

**場所** `CLAUDE.md:66` / `.thread/35/adr.md` ADR-056（`:1628-1650`）

**理由**

ADR-056 の Decision は「**導入文に例外句を足し、#37 が未着地の項は `spec/` が唯一の正本であることを明示する。**」だが、実装された `CLAUDE.md:66` は例外句を足しただけで、**「`spec/` が唯一の正本」という肝心の指し先を書いていない**（"see "Migration in progress" under Reference runtime for what is and is not in the code today" は「何がコードに無いか」の案内であって「では何を読めばよいか」ではない）。ADR-056 が Consequences で挙げた「読者が JSDoc を探して見つからない空振りが無くなる」は満たされているが、「代わりにどこを読むか」が閉じていない。

さらに ADR-056 の本文が**本 PR の成果物と食い違っている**:

- Context / Decision がともに「実体のある項（Unit of Work / **Outbox** / Retry strategy / Input validation）は従来どおり code と JSDoc が正本のまま」と書くが、**本 PR は Key concepts から Outbox 項を削除している**（`V-9` が 0 行であることの要求そのもの）。存在しない項を「実体のある項」に数えている。
- 「Unit of Work は実体のある項」という分類も成立しない。改訂後の Unit of Work 項は**同期コールバック契約**（`run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T`）を断定しているが、同じファイルの `:128` が「`UnitOfWorkProvider.run` is still asynchronous and its context still exposes `collectEvents`」と明言している。code と JSDoc は現在この項の**正本ではない**。
- ADR-056 が挙げる「新規4項（Durable Objects / `jobs` / Alarm / 10 GB 上限）」に対応する Key concepts の項は実在しない（改訂後の項は Unit of Work / Retry strategy / Input validation / Storage limits の4つ + Asynchronous execution contract 節）。

ADR は判断の記録なので、成果物と食い違うと #37 / #38 が「なぜこう書いてあるか」を再構成できなくなる。

**提案**

1. `CLAUDE.md:66` の例外句に正本の指し先を足す（例: "…there is no module or JSDoc behind them yet — `spec/` is the authority until #37 lands; see "Migration in progress" under Reference runtime for what is and is not in the code today."）。
2. ADR-056 の Context / Decision から `Outbox` を落とし、「実体のある項」の分類を改訂後の実際の項名に合わせる（Unit of Work は #37 未着地側である）。

---

### **[W-002]** `CLAUDE.md` の UoW コンテキスト名簿が、2つの DO クラスに散らばるストアを1つのコンテキストとして提示している

**場所** `CLAUDE.md:68`

**理由**

同じ1文が「`run` takes no scope argument: **the Durable Object is the scope**」と言いながら、コンテキストが露出するものとして次の3ストアを列挙している:

| 露出しているストア | 実際の置き場（`spec/database/index.md` テーブル一覧 `:36-56`） |
|---|---|
| `credentialLocatorStore` (`credential_locators`) | **User Data DO** |
| `resetTokenStore` (`password_reset_tokens`) | **Identity Directory DO** |
| `rotationCheckpointStore` (`rotation_checkpoints`) | **Identity Directory DO** |

「DO がスコープ」なら、この3つを同時に露出するコンテキストは存在し得ない。しかも `spec/usecases/identity.md:10` は「認証情報側（Identity Directory）とユーザー単位設定側（User Data DO）の両方に書く操作は、**単一のトランザクションに収まらない**」と断定しており、CLAUDE.md の書き方はその断定と正面から衝突して読める。

設計 第4.3節の対応表は同じ内容を「DO クラス」列つきで書いているので、列を落とした転記で生じた欠落である。`P-9`（`kind` の12種）が両側を突き合わせるのと違い、ストア名簿には突き合わせ検査が無い。

**提案**

コンテキストが DO クラスごとに別物であることを1句で示す。例: "The context's roster depends on which DO class it belongs to — the User Data DO exposes `credentialLocatorStore`, the Identity Directory DO exposes `resetTokenStore` (`PasswordResetTokenPort` on the domain side) and `rotationCheckpointStore` — plus the in-transaction side-effect registration points …"。正本（`spec/database/index.md`）は既に DO クラス別に節を分けているので、追加の記述は要らない。

---

### **[W-003]** `account` を非集約ストアから外す判定基準（「OCC の `version` を持つ」）が、`spec/` の中では観測不能になっている

**場所** `spec/database/index.md:79` / `:81` / `:751`、`spec/domains/identity.md:378` / `:457` / `:481`、`spec/inventory/domain.md:41`、`spec/inventory/adapter.md:19` / `:54` / `:55`、`CLAUDE.md:68`

**理由**

5箇所すべてが「`account` は **OCC の `version` を持つ集約ルート側**だから非集約ストア7つには入らない」という同じ理由づけを繰り返しており、**分類そのものの整合は取れている**（この点は問題なし）。ところが同じファイルの `spec/database/index.md:81` が直後にこう書いている:

> `session_epoch` / `reset_version` の前進は単調増加カウンタの更新なので、**`version` の条件を付けない単独文で書き、`version` も進めない**

`AccountStore` の契約（`spec/domains/identity.md:481`）も `ADP-identity-019` / `ADP-identity-020` も同じで、**`AccountStore` の2つの書き込みメソッドはどちらも `version` を読まず・書かず・条件にも使わない。** `account` を書く残りの経路は `UserSettingsRepository.insert` の初期化時 INSERT（`ADP-identity-001`）だけで、`status` の `active → deleting → deleted` 遷移には `spec/` 側の書き込み口が存在しない（退会ユースケースが `spec/usecases/identity.md` に無い。N-005 参照）。

結果として **`account.version` には `spec/` 上ただ1つも writer が無い**。分類の根拠に据えた性質が、同じ PR の中で「使われない」と打ち消されている。DB 担当とドメイン担当が独立に正しいことを書いた結果、合わせ読むと判定基準が空回りする — 担当境界をまたぐ整合の典型的な破れ方である。

`CLAUDE.md:68` もこの理由づけをそのまま英訳して持っている（"it carries the OCC `version` column and is reached from the aggregate side"）ので、#37 は「OCC のためのカラム」として `version` を追加し、誰も触らないまま残す。

**提案**

分類の根拠を、実際に判定できる性質へ差し替えるか、`version` の用途を明記する。どちらかで足りる:

- (a) 根拠を「`User` 集約と同じ DO の中でアカウント状態の権威として扱う単一行テーブルであり、非集約ストアの CAS 規約（`owner_token` / `operation_id` / 置換キー）に乗らない」へ差し替える、または
- (b) `spec/database/index.md:81` に「`version` は退会に伴う `status` 遷移（#37 の担当）が使う OCC 列であり、`session_epoch` / `reset_version` の前進では使わない」と用途を明記する。

(a)(b) いずれの場合も5箇所すべてに届かせること（`CLAUDE.md` を含む）。

---

### **[W-004]** `CLAUDE.md` の OCC の説明が単一行テーブル2件に当てはまらない

**場所** `CLAUDE.md:69`（Key concepts / Retry strategy）

**理由**

> OCC is enforced by a conditional `UPDATE ... WHERE id = ? AND version = ?` whose matched-row count is read back

一方 `spec/database/index.md:26`（共通方針 / version）は本 PR で次を追加している:

> **単一行テーブル（`account` / `user_settings`）は `id` 列を持たないので `WHERE version = ?` だけで条件付ける**（`id` 述語は不要。他の行が存在しないため）

これは W-014（`fix`）の是正で足された行である。`CLAUDE.md` は例外に触れないまま `id = ?` を含む形を断定しており、`user_settings` は**まさに OCC を実際に使う唯一の単一行テーブル**（`changeTrashRetentionDays` が `save(user, expectedVersion)` を呼ぶ）なので、例外は絵に描いた餅ではない。

**提案**

`CLAUDE.md:69` を「a conditional `UPDATE` guarded on `version` (plus `id` where the table has one)」程度に緩めるか、`spec/database/index.md` を正本として指す1句を添える。

---

### **[W-005]** `CLAUDE.md:66` の英文が主述の数で崩れている

**場所** `CLAUDE.md:66`

**理由**

> The exception **is** the **items** #37 has not landed yet: they state the rule, but there is no module or JSDoc behind them to read until it does

- `The exception is the items` — 単数の主語 + be 動詞に複数の補語。既存の `CLAUDE.md` の文体（他はすべて破綻なし）から浮く。
- `until it does` の `it` は #37、`does` は `land` の代動詞だが、直前が `has not landed` なので受けが弱い。

`CLAUDE.md` は Key concepts 節の**冒頭1文**であり、この文書の読者はまずここを読む。

**提案**

例: "The exceptions are the items #37 has not landed yet: they state the rule, but there is no module or JSDoc behind them until it does — `spec/` is the authority in the meantime; see "Migration in progress" under Reference runtime for what is and is not in the code today."（W-001 の修正と同時に直せる）

---

## Notes

### **[N-001]** 非集約ストアの員数が3ファイルに重複している

`spec/database/index.md:752`（正本）/ `spec/domains/identity.md:378` / `CLAUDE.md:68` の3箇所が「非集約ストア7つ」「6ストア・7メソッド」を持つ。ADR-054 が `CLAUDE.md` について述べた論拠（「員数を焼き込むと食い違ったとき両方が嘘になる」）は `spec/domains/identity.md:378` にも等しく効く。B-002 を直すついでに、ドメイン側も「全数は `spec/database/index.md` が持つ」への参照に寄せる余地がある。**本 PR 時点で3箇所の値は一致している**ので、いま壊れているわけではない。

### **[N-002]** `CredentialMapping.usableForLogin` が `credential_mappings` の列一覧に無く、導出値であることが同じ節に書かれていない

`spec/domains/identity.md:402-410` は `usableForLogin` を `CredentialMapping` の「フィールド」として挙げ、「判定はこちら側が権威」と書く。`spec/inventory/domain.md:39` も同じ。ところが `spec/database/index.md` の `credential_mappings` 列一覧（`:536-618`）にも `ADP-credential-mappings-001` にも `usable_for_login` 列は無い。導出規則（`kind='sso'` は常に真、`kind='email'` は `password_verifier` を持つときだけ真）は**`credential_locators` 側の節**（`:109`）にだけ書かれているので、#37 が `credential_mappings` の節だけを読むと列を足しかねない。`credential_mappings` の節に「`usableForLogin` は列ではなく `password_verifier` の有無からの導出である」を1行足すと閉じる。

### **[N-003]** 設計正本の内部で `pruneExpiredTrashItems` の扱いが割れている（本 PR の瑕疵ではない）

- `.thread/34/design.md` 第7.5節: 「**`pruneExpiredTrashItems` ユースケースは消える。**」
- 同 第11.1節「改訂する — ユースケース」表: 削除欄が `pruneExpiredTrashItems`（`:311` 以降）、追加欄が「**Alarm 前提の期限処理へ書き換える**」／台帳表も「`UC-trash-007` を Alarm 前提へ書き換える」

本 PR は後者（書き換え・`UC-trash-007` 存続）を採っており、`spec/usecases/trash.md:311` / `spec/testcases/trash/pruneExpiredTrashItems.md` / `spec/inventory/{usecase,test}.md` の4段すべてで整合している。**選択そのものは #35 向け指示（第11.1節）に忠実**なので指摘ではないが、設計の第7.5節と読み合わせると矛盾するため、#37 へ渡す前にどちらが生きているかを1行残しておくと安全（ADR に落とすのが素直）。

### **[N-004]** 一意性の判定が「予約の獲得だけ」なのか「事前検証も含む」なのかの言い回しがドメインとユースケースでずれている

`spec/domains/identity.md:415` は「**事前チェックではなく予約の獲得で判定する**」と断定するが、`spec/usecases/identity.md:45`（手順4）は `CredentialMappingRepository.findByEmail` による**事前検証**と `reserveCredential` を併用し、エラーケース表も両者を別行に分けている（`:59` 事前検証 / `:60` レース）。実装としては「事前検証は UX、権威は予約」で両立するが、ドメイン側の「〜ではなく」が categorial に読めるので、「権威は予約であり、事前検証は早期のフィードバックのために置く」と1句添えると読み違いが消える。B-003 を直すときに同時に見ると効率がよい。

### **[N-005]** `AccountStore` に `status` を遷移させる口が無く、「`sessionEpoch` を進める4操作」の1つ（退会）に対応する spec 側ユースケースが存在しない

`spec/domains/identity.md:479` / `spec/inventory/domain.md:42` はどちらも「`sessionEpoch` を進める操作は4つだけ — パスワード変更 / リセット完了 / SSO 連携の解除 / **退会**」と断定するが、`spec/usecases/identity.md` の15ユースケースに退会は無く、`AccountStore` にも `status` を `deleting` / `deleted` へ動かすメソッドが無い。`account.status` / `deleted_at` / `finalize-withdrawal` は `spec/database/index.md` 側にだけ存在する。**退会は元々 `spec/` のユースケース集合に無く、本 PR がスコープ外と判断したのは妥当**（Issue #35 は改訂であって機能追加ではない）だが、断定の1項が spec 内に受け皿を持たない状態は #37 に持ち込まれるので、記録として残す。

---

## #44 / #45 の切り出し境界

**Blocker なし。境界は守られている。**

`.thread/35/plan.md`「含まれないもの」（`:61`）と `.thread/35/adr.md` ADR-009 が禁じた6項目を全数走査した結果:

| 禁止項目 | `spec/` 内の実測 |
|---|---|
| 巻き戻し手順 | なし。`spec/database/index.md:460` が「巻き戻し（自動回収）の具体 … は #45 が決めるので、本ファイルには書かない」と明示的に委譲 |
| 段構成（3-i / 3-ii / 3-iii） | なし（`grep -E '3-i\|段構成'` が 0 件） |
| 終端モードの印（`terminalReason` の前倒し書き込み） | なし |
| 材料寿命 | なし。`spec/database/index.md:616` は「掃除と終端の関係の具体（どの段でどの行を消すか）は #45 が決めるので本ファイルには書かない」 |
| 後始末の再試行上限（`attempt` の2倍） | なし |
| (ii) の受け口の残渣種別ごとの割り当て | なし。`spec/database/index.md:757` は operator 経路の**存在**（`purge-user-mappings` / `cancel-reservation`）までで止め、「到達制御・監査ログ・運用手順の実体は #38 が定める」 |

`spec/` に書かれているのは (a) 一様な終端（`terminal_reason` + `poison` + operator エスカレーション）、(b) 「黙って中間状態を残す」は選ばない原則、(c) 利用者から観測できる結果の3つだけで、ADR-009 の線引きどおりである。#45 への委譲は `spec/domains/identity.md:431` / `spec/usecases/identity.md:51,250,293,526` / `spec/testcases/identity/{changePassword:27,executePasswordReset:26,registerOrLoginWithSso:18,unlinkSsoCredential:20}` / `spec/inventory/test.md:76,113,227` の12箇所に一貫した文言で置かれている。

**「終端で中間状態が解除された → 旧パスワードでログインできる」の扱いも越境していない。** 断定形ではなく条件形（`spec/inventory/test.md:76`「中間状態が解除されれ**ば** … 終端が記録として残れ**ば** PASS（手順は #45）」）で書かれており、#45 が自動回収をどう設計しても矛盾しない。

**handoff 第3節「残すもの」7項目**はすべて `spec/` に着地している:

| # | 残すもの | 着地点 |
|---|---|---|
| 1 | 分類 (C) が `poison` に達しうること / `backoff と poison` / `jobs` の12列 | `spec/database/index.md:458-462` / `ADP-jobs-001`（「12列」） |
| 2 | 各 saga が終端時に残しうる中間状態の列挙 | `spec/testcases/identity/` の中間状態ケース群 + `spec/usecases/identity.md` の各手順末尾 |
| 3 | 締め出し経路の塞ぎ方 | `spec/database/index.md:757`（operator 経路）/ `:612-618`（CAS と束縛） |
| 4 | 回収の材料とその置き場 | `operations.target_locators`（`:498`）/ 予約行の `locators` `candidate_user_id` `caller_token`（`:555,552,597`）/ `account.caller_token`（`:71`）/ `change_state` の3値（`:562`） |
| 5 | operator 経路の存在 | `spec/database/index.md:757` |
| 6 | 一様な終端の形 | `spec/database/index.md:460` ほか12箇所 |
| 7 | 「黙って中間状態を残す」は選ばない | `spec/database/index.md:460` |

**「#37 が落としてはいけない前方互換点」4点**も全数着地（ラウンド1の B-010 / W-025 の是正が効いている）:

1. `operations.target_locators` を終端の各段が終わるまで消さない → `spec/database/index.md:504`（**否定形**）/ `ADP-operations-001`
2. コーディネーター予約行を終端の各段が終わるまで消さない → `spec/database/index.md:616`（**否定形** + `sweep-reservations` との関係を名指し）/ `ADP-credential-mappings-001`
3. `account.caller_token` を退会完走時以外に消さない → `spec/database/index.md:71`（「**消すのは退会の完走時だけであり、それ以外の経路では消さない**」＝ 肯定形 + 否定形）/ `ADP-account-001`
4. `credential_mappings.change_state` を3値で実装する → `spec/database/index.md:562`（CHECK 制約 + 「値域は3値である」）/ `spec/domains/identity.md:410` / `ADP-credential-mappings-001` / テストケース4ファイル

---

## 修正どうしの整合（ラウンド1の並列修正の相互検査）

本ラウンドの主目的。**Blocker 3件（B-001 / B-002 / B-003）と Warning 3件（W-001 / W-002 / W-003）がこの検査から出た。** 検査した軸と結果は次のとおり。

### `account` の分類（5箇所）— **一致**

`spec/database/index.md:79` `:751` / `spec/domains/identity.md:378` `:457` / `spec/inventory/domain.md:41` / `spec/inventory/adapter.md:19` / `CLAUDE.md:68` の全部が「ドメイン側の口の名前は `AccountStore` だが、非集約ストア7つには入らない」「畳まないことと非集約であることは別」で一致。表現も互いを参照し合っている。判定基準そのものの空回りだけが W-003。

### 非集約ストアの全数と書き込み口（3箇所）— **数値は一致、粒度に欠落**

`spec/database/index.md:747`（7テーブル）/ `:752`（6ストア・7メソッド、`_meta` だけ口なし）/ `CLAUDE.md:68` / `spec/domains/identity.md:378` の員数がすべて一致。各テーブルの節（`:124` `:452` `:503` `:519` `:531` `:646` `:672`）も1対1に対応する。DO クラス別の分割が `CLAUDE.md` で落ちている点が W-002、員数の重複が B-002 / N-001。

### 新設ポート・ユースケースの全段貫通 — **一致**

| 新設物 | ドメイン | ユースケース | 台帳 | テストケース | 画面 |
|---|---|---|---|---|---|
| `unlinkSsoCredential` | `domains/identity.md:633` / `User.removeCredential`（`DOM-identity-001`） | `usecases/identity.md:494-539` | `UC-identity-015` / `TC-unlinkSsoCredential-001..014` | 新規ファイル（14ケース） | `PAGE-settings-007` / `PAGE-password-reset-004` / `pages/index.md:68,225` |
| `revokeAllAiClientConnections` | `domains/identity.md` AI 接続節 | `usecases/identity.md:455-494` | `UC-identity-014` / `TC-revokeAllAiClientConnections-001..008` | 新規ファイル（8ケース） | `PAGE-password-reset-004` / `pages/index.md:69` |
| `TrashQueryPort.listItemsToPurge` | `domains/trash.md:219` | `usecases/trash.md:335` | `DOM-trash-008` / `ADP-trash-005` | `pruneExpiredTrashItems.md:21`（列挙の DB 例外） | — |
| `*.recalculatePurgeAfter`（memo / topic / document の3本） | `domains/{memo:329,knowledge:427,trash:191}.md` | `usecases/identity.md:565` / `usecases/trash.md:334` | `DOM-memo-026` ほか / `ADP-memo-014` `ADP-knowledge-028` | `changeTrashRetentionDays.md` / `pruneExpiredTrashItems.md:23` | — |
| `CredentialRef.usableForLogin` | `domains/identity.md:62,78,124,408,497` | `usecases/identity.md:45,96,267,520,597,605` | `DOM-identity-001` `-036` `-041..043` / `ADP-identity-021,023` | `getCurrentUser` / `unlinkSsoCredential` ほか | `PAGE-settings-005,007` / `pages/index.md:224` |

`usableForLogin` は設計 第11.1節が「集合の要素は `{ credentialId, kind, label }` の3つ組」と書いているのに対し**4つ組に拡張**されているが、これはラウンド1の B-001（`fix`・ADR-048）で意図的に決めたずれであり、5層すべてで4つ組に統一されている（`TC-getCurrentUser-001` も「4つ組」と明記）。**取り残しゼロ。**

`listItemsToPurge` / `recalculatePurgeAfter` / 2ユースケースはいずれも `.thread/34/design.md` に**名前としては1度も現れない**が、根拠は原文にある（第7.5節の一括再計算・自己消尽述語・Alarm 起床 / 第11.1節の画面仕様4件 2. と 3.）。**「設計が言っていないものを発明した」箇所は無い。**

### カーソル責任分割 — **一致**

「形式は `SearchQuery.create` / 中身と有効期限は `SearchIndexPort.query`、どちらも `InvalidCursor`」が `spec/domains/search.md:44,170` / `spec/usecases/search.md:24,66,67,84` / `spec/inventory/{domain:130,adapter:119,test:693}.md` / `spec/testcases/search/search.md:45,46` / `spec/pages/index.md:190,198` / `spec/inventory/frontend.md:74` / `spec/scenario/search.md:14` / `spec/manual-tests/search.md:359` の全段で同一。物理形は `spec/database/index.md:762` で #37 へ委譲（ADR-013 どおり）。`V-10`（`page` 番号方式）0 行。**取り残しゼロ。**

### `'delete'` 構文 / `search_entries` の物理形の一本化 — **一致**

`spec/domains/search.md:228` が「物理形（主キーの取り方・列の型・索引）を決めるのは `spec/database/index.md` であり、本ファイルではない（両側に置くと片方だけが直って静かに食い違う）」と宣言し、実際に `rowid` / `PRIMARY KEY` / `VALUES('delete', ...)` は `spec/database/index.md` にしか無い（W-013 / W-017 / ADR-044 / ADR-053 の是正が二重管理を作っていない）。

### `jobs` の再投入規則 / 自己消尽述語 / 12種の分類 — **一致**

`spec/database/index.md:453-456`（収束規則3つ、`status` 別の優先）/ `:466-486`（12種を DO クラス別 6+6、4類型が1回ずつ被覆、再武装する5種の名指し）/ `:94`（再計算の自己消尽述語を `user_settings` 節に一本化）/ `CLAUDE.md:80-87`（4類型 12種）。`P-9` 0 行。`ADP-memo-014` / `ADP-knowledge-028` も同じ述語を持つ。

### `userId スコープ` の一掃（B-004 / W-020）— **完了**

`grep -rn 'userId スコープ'` は 0 件。読み取り専用テストケース8件は `.thread/35/coverage.md` で「影響なし → 改訂」に上書き済み（ADR-036）で、実際の差分もその8件を含む。`spec/domains/index.md:32`「**例外は無い**」と矛盾する行は残っていない。

### 台帳（`spec/inventory/test.md`）の `#L` 再同期 — **完全一致**

独自に機械検証した（`P-8` より強い検査）:

- 814件の `#L{n}` アンカーが**全件、指し先ファイルの実在するテーブル行**（`^|` で始まる行）を指す。ダングリング 0 件。
- 同一ファイル内で `TC-*-{連番}` の行番号が**単調増加**（順序の取り違えなし）。0 件の逆転。
- 各テストケースファイルのデータ行数と台帳の該当行数が**全53ファイルで一致**（`restoreDocument.md` の4テーブル構成も含む）。
- `spec/testcases/` の53ファイルと `spec/inventory/usecase.md` の53ユースケースが**名前まで完全一致**（`comm -3` が空）。

---

## 機械検査の再実行結果

### 負の検証（AC-1〜AC-3 / AC-6 / AC-8 / AC-10〜AC-13）

| 検査 | 期待 | 実測 |
|---|---|---|
| V-1 | 0 | **0** |
| V-2a / V-2b | 0 / 0 | **0 / 0** |
| V-2c | 0 | **0** |
| V-3 | 0 | **0** |
| V-3b | 0 | **0** |
| V-4 | 0 | **0** |
| V-5 | 0 | **0** |
| V-6（2コマンド計） | 0 | **0** |
| V-7 | 0 | **0** |
| V-8 | 0 | **0** |
| V-9 | 0 | **0** |
| V-10 | 0 | **0** |

### 正の検証

`P-7`（手段4 の10本）全行ヒット（実測 2 / 4 / 2 / 2 / 2 / 2 / 1 / 7 / 3 / 2）。`P-8` 0 行。`P-9` 0 行。`P-10` 0 行。

### 件数同期（AC-18）

`UC-` 53 / `TC-` 814 / シナリオ 39 / マニュアルテスト 201 が、`spec/index.md:15,21,24,26,27` と `spec/manual-tests/index.md:15-23` の記載と**全件一致**。マニュアルテストの内訳（40/37/41/23/25/23/12）も実測と一致し、正常系 86 + 異常系 86 + 境界値 29 = 201 が合う。

### カバレッジ（AC-16）

- `find spec -name '*.md' | grep -v '/review/' | wc -l` = **102**（計画どおり）
- `NO-VERDICT` 0 件（102ファイル全部に `.thread/35/coverage.md` の行がある）
- `coverage.md` の判定内訳 改訂 80（71 + ADR-010 の1 + ADR-036 の8）/ 新設 2 / 削除 1 / 影響なし 20 = **103行**、うち触っている 83 件が `git diff` の spec 側 83 件と**完全一致**（影響なし 20 件は無改変）
- `.thread/35/step14-checklist.md` の32行が設計 第11.1節テストケース表の32ファイルと**名前まで一致**（W-028 の是正を確認）

### ADR とスコープ（AC-13 / AC-17）

- `.thread/35/adr.md` の見出しは `## ADR-001` 〜 `## ADR-060` の**60件で、重複 0 / 欠番 0 / 061 以降なし**（機械検証）
- **内容として矛盾する ADR の同居: ADR 間には無い。** ただし ADR-054 / ADR-056 と `CLAUDE.md` の成果物のあいだに矛盾がある（B-002 / W-001）
- 60件すべて `Status: Proposed`。supersede / 撤回された ADR は無い
- `spec/adr/` / `.adr/` / `spec/**/review/` は**全件無改変**（`git diff --name-only` に1件も現れない）
- `git diff --name-status origin/main...HEAD | grep -vE '^[AMD]\s+(spec/.*\.md|CLAUDE\.md|\.thread/35/.*)$'` が **0 行**（AC-17 のスコープ条件を満たす。コード・コンフィグ・マイグレーションへの変更は 1 件も無い）

### `CLAUDE.md` が現状のガイドとして嘘になっていないか

`### Migration in progress — #37` の記述をリポジトリの実体と突き合わせた:

| `CLAUDE.md:128-130` の主張 | 実測 |
|---|---|
| `packages/core/src/adapters/d1/` が live | 実在（`pendingBatch.ts` / `schema.ts` / `unitOfWork.ts` / `repositories/` / `migrations/`） |
| `run` はまだ非同期で `collectEvents` を露出 | `packages/core/src/application/execution/unitOfWork.ts:14` に `collectEvents` あり |
| `pendingBatch.ts` と `_occ_guard` がまだある | 実在（`schema.ts:115-128`） |
| relay / consumer / pruner / dlq がまだ動く | `apps/web/app/worker/cloudflare/` に4本とも実在 |
| Durable Object / `jobs` / Alarm はコードに無い | プロジェクトコードに無し（`worker-configuration.d.ts` は Cloudflare 生成の型定義のみ） |
| 検索に FTS5 インデックスは無い | `.ts` / `.sql` に `fts5` 0 件 |
| `pnpm start` / `preview` が #40 で起動しない | `eventRelayWorker.ts:97` に module scope の `crypto.randomUUID()` あり |

**全項目が現状と一致。** `Reference runtime` 節が DO 単独構成を断定しつつ Entry points に旧4ワーカーを並べる構成は、`:126` の「Everything above states the rules; the code has not moved yet」と `:129` で明示的に接続されており、嘘にはなっていない。

### 設計 第7.7節（`1934-1958`）の7項目 vs `CLAUDE.md`（AC-12）— 1項目ずつ突き合わせ

| # | 設計 第7.7節 | `CLAUDE.md` | 判定 |
|---|---|---|---|
| 1 | ドメインイベントという transport は存在しない / トランザクション内で完結する副作用（FTS5 projection・retention のハードデリート・saga の phase 前進）は `transactionSync` の中で直接行う | `:77`「There is no domain-event transport. … the FTS5 projection, retention hard-deletes, saga phase advances — are performed directly in that `transactionSync`」 | **一致**。「`collectEvents` / Outbox / relay / consumer / DLQ が無い」の列挙は落ちているが、これは `V-9`（Key concepts 節に `Outbox` / `collectEvents` を残さない）の要求によるもので意図的 |
| 2 | 外部 I/O は必ず永続ジョブ / ただし全数ではない / 4類型が12種を1回ずつ覆う / `kind` を足したらこの表にも足す / 外部 I/O は `send-mail` 1件のみ | `:78-87` 同内容 + 4類型の表 + 「adding a `kind` means adding it here too」+「Only `send-mail` reaches outside; the other eleven are DO-local」 | **一致**。12種の綴りも `spec/database/index.md` の全数表と一致（`P-9` 0 行） |
| 3 | at-least-once / 1 DO に Alarm 1本 / `nextRunAt` 順 / 送信成功直後のリセット / 冪等必須 / `operationKey` からの `providerIdempotencyKey` | `:88` 同内容 | **一致** |
| 4 | 順序保証なし / 失敗はバックオフで先送り / DO をまたぐと共通の時計もキューも無い / 種別の異なるジョブの相対順序に依存しない / phase と CAS で表現 | `:89` 同内容 | **一致** |
| 5 | リトライはジョブランナー / `alarm()` から throw しない / `attempt` と `nextRunAt` を進める / 上限超過は `poison` + `terminalReason` / 唯一の広い catch | `:90` 同内容 + "This is the one broad catch allowed under "worker → root" below" | **一致**。`:106` の cross-layer catch policy とも整合 |
| 6 | OCC 競合は再試行しない / `terminalReason` まで届ける / デコレーターを置かない | `:91` 同内容 | **一致** |
| 7 | 冪等キーをクライアントに持たせない / `operationId` はサーバー採番 / 予約行と `credential_mappings.changeState` が担う | `:92` 同内容 | **一致** |

**7項目とも原文どおり。**「ランタイムを差し替えても domain / application / presentation は無傷」の明言も削除済み（`V-8` 0 行）。AC-12 の残りの要求（Reference runtime / Unit of Work / Retry strategy / Error handling が DO 単独構成を記述）も満たしている。**AC-12 に対する Blocker は B-001（同期契約の例外理由）と B-002（員数）の2件のみで、7項目の写しそのものには問題なし。**

---

## カバレッジ（97件と1対1）

**確認 97 件 / スキップ 0 件。** 確認の深さを3段階で記す。

### 精読（本文または全差分を通読）— 14件

| ファイル | 確認内容 |
|---|---|
| `CLAUDE.md` | 全136行を通読。第7.7節7項目との逐語照合、移行注記の実体検証、英文の質。→ B-001 / B-002 / W-001 / W-002 / W-004 / W-005 |
| `spec/database/index.md` | 物理境界・共通方針・`account` / `user_settings` / `credential_locators` / `jobs`（収束規則・`kind` 全数）/ `operations` / `migration_progress` / `_meta` / `credential_mappings` / `password_reset_tokens` / `rotation_checkpoints` / OCC 分類 / operator 経路 / 本ファイルで定義しないテーブル を精読 → W-003 / N-002 |
| `spec/domains/identity.md` | `User` / `CredentialRef` / `CredentialMappingRepository` / `UserSettingsRepository` / `AccountStore` / `CredentialLocatorStore` / ユースケース一覧を精読 → W-003 / N-002 / N-004 / N-005 |
| `spec/domains/index.md` | 横断事項（テナント分離・ポートの同期契約・派生データ）を精読 → B-001 の対照 |
| `spec/domains/search.md` | 検索の規則・`SearchIndexPort` / `IndexEntry` / external-content 制約 / 残った節の参照を精読 |
| `spec/domains/trash.md` | `TrashQueryPort`（`listItemsToPurge` / `findEarliestPurgeAfter`）/ 保持期限 / ジョブのフローを精読 |
| `spec/usecases/identity.md` | 15ユースケース全部の処理フローとエラーケース表を精読 → **B-003** / N-004 |
| `spec/usecases/search.md` | 入力 DTO / 処理フロー / エラーケース（カーソル責任分割）を精読 |
| `spec/usecases/trash.md` | `pruneExpiredTrashItems` の再計算フェーズ / 削除フェーズを精読 → N-003 |
| `spec/testcases/trash/pruneExpiredTrashItems.md` | 全17ケースを精読（列挙の DB 例外 / 自己消尽述語） |
| `spec/testcases/identity/unlinkSsoCredential.md` | 全14ケース精読（新設・#45 境界） |
| `spec/testcases/identity/revokeAllAiClientConnections.md` | 全8ケース精読（新設） |
| `.thread/35/adr.md` | ADR-001〜060 の見出し全件 + ADR-005 / 009 / 010 / 011 / 012 / 014 / 034 / 036 / 041 / 048 / 050 / 051 / 052 / 054 / 056 / 059 / 060 を精読 → B-001 / B-002 / W-001 |
| `.thread/35/plan.md` | 全393行を通読（AC-12 / AC-13 / AC-16 / AC-17 の分解、検証バッテリー、スコープ宣言） |

### 差分精読（追加行を全数読んだもの）— 62件

`git diff -U0` の追加行 2581 行を全件出力し、以下のファイル群について1行ずつ読んだ。

- **要件・体験（6件）**: `spec/idea.md` / `spec/requirements.md` / `spec/index.md` / `spec/scenario/{account,ai,index,search}.md`（`spec/scenario/index.md` 含む）/ `spec/pages/index.md`
- **ドメイン残り（4件）**: `spec/domains/{export,knowledge,memo}.md`
- **ユースケース残り（4件）**: `spec/usecases/{export,knowledge,memo}.md`
- **台帳（5件）**: `spec/inventory/{adapter,domain,frontend,test,usecase}.md` → `spec/inventory/domain.md:32` `:36` から **B-001** の2箇所目・3箇所目
- **テストケース（40件）**: `spec/testcases/export/exportAllData.md` / `spec/testcases/identity/*`（16件。新設2件は精読側）/ `spec/testcases/knowledge/*`（13件）/ `spec/testcases/memo/*`（9件）/ `spec/testcases/search/search.md` / `spec/testcases/trash/*`（7件のうち `pruneExpiredTrashItems.md` は精読側）
- **マニュアルテスト（8件）**: `spec/manual-tests/{account,ai,document,index,search,settings,timeline,trash}.md`
- **削除1件**: `spec/testcases/search/maintainSearchIndex.md`（34行削除。ファイルごと削除 = 設計 第11.1節 (C) の指示どおり）

（`spec/domains/index.md` / `spec/domains/{identity,search,trash}.md` / `spec/usecases/{identity,search,trash}.md` / `spec/database/index.md` は精読側に計上）

### 機械検査 + 抜き取り — 21件

| ファイル群 | 検査 |
|---|---|
| `spec/inventory/test.md`（再掲・814行） | `#L` アンカー 814件の実在・行種別（テーブル行か）・単調性・件数一致を全数機械検証 |
| `.thread/35/coverage.md` | 103行の判定内訳と `git diff` の 83 件を突合、`NO-VERDICT` 全数検査 |
| `.thread/35/steps.md`（430行） | 目次とステップ番号、AC 対応、`#44` / `#45` への言及の有無を確認（越境指示なし） |
| `.thread/35/testing.md`（309行） | `V-*` / `P-*` の定義が `plan.md` と一致することを確認、全バッテリーを実行 |
| `.thread/35/step14-checklist.md`（51行） | 32行が設計 第11.1節の32ファイルと一致することを機械照合 |
| `.thread/35/review/triage.md` | 全55行精読（既判定の把握） |
| `.thread/35/review/review-001.md` ほか `review-001-*.md` 5件 | ラウンド1の指摘 Key と本ラウンドの重複がないことの照合。**重複 0。** B-001 は W-024 と同じ Key だが再審議ではなく「合意された `fix` が適用先3箇所に届いていない」の報告であり、うち2箇所（`DOM-identity-029` / `-033`）は `review-001-domain-usecase.md:95` の N-002 が既に本文で記録していた場所である |

**スキップ: なし（0件）。**
