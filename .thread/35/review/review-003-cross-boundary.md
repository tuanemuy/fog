# レビュー003 — 担当境界をまたぐ整合（3ラウンド目）

**対象:** PR #46 / `origin/main...HEAD` / 変更 104 件（`spec/**/*.md` 84 + `CLAUDE.md` 1 + `.thread/35/**` 19）
**観点:** 波1（契約）と波2（派生物）の伝播、波1 の担当者どうしの境界、設計に根拠のない発明、#44 / #45 の切り出し境界、機械ゲートの全件実行
**方式:** `.thread/35/review/triage.md` の既判定（1R Blocker 10 / Warning 29、2R Blocker 12 / Warning 24 + N-002）は再審議しない。判定済み Key と同一根拠の指摘は本レポートに含めない。

## 担当境界をまたぐ整合

### 結論

**Blocker なし。** 2ラウンド目に採った「上流（契約）4名 → 下流（派生物）2名の2波」方式は、**本観点で見るかぎり効いている。**

`.thread/34/handoff.md` 第4節が「#34 では機械検査を設計できなかった」と名指しした2つの残余リスク——(1) 正本だけを直して適用先の散文に届けない、(2) 同一ラウンド内の複数修正どうしの整合——について、2ラウンド目に入った主要変更 8 系統（`linkSsoCredential` / `executePasswordReset` の出力 / `purge-trash` の投入点5つ / `jobs.kind` 投入点欄 / `jobs.operation_key` と `payload_digest` / `maxChunks` / `CLAUDE.md` の Layers と非集約ストア名簿 / 件数同期）をそれぞれ**全段で逐一突き合わせた結果、伝播漏れは1件も検出できなかった。**

残った指摘は Warning 3 件で、いずれも**波1 の担当者どうしの境界に残った断定の食い違い**である（下流には波及していない）。局所修正で閉じる。

## Blockers

**なし。**

## Warnings

### **[W-001]** `jobs.kind` 全数表の見出し文が「投入点はいずれも `enqueueJob` する」と断定するが、同じ表の3行がそれを否定している

**場所:** `spec/database/index.md:468`（見出し文）/ 同 `:473`（`reindex`）/ `:474`（`migrate-bulk`）/ `:483`（`rotate-encryption`）/ 同 `:453`

**理由:**
`:468` は「投入点はいずれも**そのジョブが待つ状態を書くのと同じトランザクション**の中で `enqueueJob` する」と、12種すべてに掛かる形で断定している。ところが同じ表の

- `:473` `reindex` — 「migration ゲート（…）。**アダプター側で、usecase からは投入しない**」
- `:474` `migrate-bulk` — 同上
- `:483` `rotate-encryption` — 「**operator 専用 maintenance 経路からの起動**（後述）」

の3行はこの形に当てはまらない。とくに `rotate-encryption` は「そのジョブが待つ状態」を書く書き込み自体が存在せず（`spec/database/index.md:759` の operator RPC からの起動である）、「同じトランザクション」という条件が成立しない。

さらに `:453` が「**usecase からの書き込み口は `enqueueJob` だけである**」と別の断定を置いているため、この2文を並べて読むと「12種すべてが usecase から投入される」と読める。実際は12種のうち usecase の手続きが名指しで投入するのは `purge-trash` / `resume-link` / `sweep-orphan-mapping` の3種だけである（`spec/usecases/{memo,knowledge,identity,trash}.md` を全数走査して確認）。

**投入点欄そのものは ADR-072 の狙いどおり全12行が非空で、内容も正しい。** 壊れているのは表の上に載った全称の1文だけである。この1文は投入点欄と同じラウンドで新設されており、欄を埋めた担当と見出しを書いた担当のあいだで射程が食い違った形である。

**提案:**
`:468` の全称を「投入点の**多くは**…同じトランザクションの中で `enqueueJob` する」に緩めるか、あるいは正確に例外を書く。後者を勧める（本ファイルの他の全数宣言と書き味が揃う）:

> 投入点は原則として**そのジョブが待つ状態を書くのと同じトランザクション**の中で `enqueueJob` する。**例外は3種で、これが全数である** — `reindex` / `migrate-bulk` は migration ゲート（アダプター）が、`rotate-encryption` は operator 専用 maintenance 経路が起動する。

---

### **[W-002]** `CLAUDE.md` の UoW 名簿の DO クラス別分割が、同じ文の後半（副作用登録メソッド4本）に届いていない

**場所:** `CLAUDE.md:68` / 裏づけ `spec/database/index.md:32-56`（テーブル一覧）/ `.thread/35/adr.md` ADR-074

**理由:**
ADR-074 は「`CLAUDE.md` の UoW コンテキスト名簿は DO クラス別に書く」と決め、その Context で理由をこう書いている——「同じ項が『`run` takes no scope argument: **the Durable Object is the scope**』と断定しているので、**同じ文の中で衝突する** — 1つのスコープに2クラス分のストアが載ることになる」。

修正はストア名簿（`credentialLocatorStore` / `resetTokenStore` / `rotationCheckpointStore`）にだけ適用され、**同じ文の後半に並ぶ副作用登録メソッド4本は DO クラスで分けられていない:**

> and the in-transaction side-effect registration points `enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor`.

ところが `spec/database/index.md` のテーブル一覧では、`operations` と `migration_progress` は **User Data DO にしか存在しない**（Identity Directory DO のテーブルは `credential_mappings` / `password_reset_tokens` / `jobs` / `rotation_checkpoints` / `_meta` の5つで、`operations` も `migration_progress` も無い）。したがって Identity Directory DO のコンテキストに `recordOperation` / `updateOperation` / `setMigrationCursor` は載りえず、載るのは `enqueueJob` だけである（`jobs` は両クラスに現れる）。

**ADR-074 が自ら定義した欠陥（1つのスコープに2クラス分が載る）が、同じ文の後半でそのまま残っている。** ADR-074 の Consequences が「**ストア名簿には機械検査が無い。この整合はレビューでしか守れない**」と書いたとおり、`P-9` / `P-10` のどちらにも掛からない。

**提案:**
後半も DO クラスで割る。例:

> …and the in-transaction side-effect registration points — `enqueueJob` on both classes, plus `recordOperation` / `updateOperation` / `setMigrationCursor` on the User Data DO only (`operations` and `migration_progress` exist only there).

`spec/database/index.md:754` の「6ストア・7メソッド」という員数は正しく（ADR-054 どおり `CLAUDE.md` は員数を持たない）、直すのは `CLAUDE.md` 側の1文だけである。

---

### **[W-003]** `session_epoch` を進める操作の列挙が、DB 側は3つ・ドメイン側と台帳は「4つだけ」で食い違う

**場所:** `spec/database/index.md:69` ⇔ `spec/domains/identity.md:485` / `spec/inventory/domain.md:42`（`DOM-identity-039`）

**理由:**
ドメイン側と台帳は**全数宣言**として4つを挙げる:

- `spec/domains/identity.md:485` — 「**`sessionEpoch` を進める操作は4つだけである** — パスワードの変更、パスワードリセットの完了、SSO 連携の解除、**退会**」
- `spec/inventory/domain.md:42` — 「**進める操作は4つだけ**（パスワード変更 / リセット完了 / SSO 連携の解除 / **退会**）」

一方 DB 側の `session_epoch` 列の説明は3つしか挙げない:

- `spec/database/index.md:69` — 「セッション失効の唯一の権威。パスワード変更・リセット完了・SSO 連携解除で単調増加する」

**同じファイルが退会を扱っていないわけではない** — `:68` の `status` は `deleting` / `deleted` を持ち、`:71` の `caller_token` は「消すのは**退会の完走時**だけ」と書き、`:475` の `finalize-withdrawal` は「退会の開始」を投入点に持つ。つまり `spec/database/index.md` は退会を明示的にモデル化しており、`session_epoch` の1行だけが列挙から退会を落としている。

#37 は「`spec/database/index.md` が本 spec 側のスキーマの正本である」（同 `:6`）と読むので、退会の実装時に「列の説明に無い＝進めなくてよい」と読める。**2R の N-005（`AccountStore` に `status` 遷移の口が無く、4操作の1つに spec 側ユースケースが無い）とは別の破れである** — N-005 は受け皿ユースケースの不在、本件は物理列の説明と全数宣言の不一致で、直す場所も違う。

**提案:**
`:69` の説明を4つに揃える（退会の書き手が #37 の DO RPC 側であることは `:81` が既に書いているので、そこを指せば新しい約束は増えない）:

> `session_epoch` | INTEGER | NOT NULL。セッション失効の唯一の権威。パスワード変更・リセット完了・SSO 連携解除・**退会**で単調増加する（**前進させる操作はこの4つだけである**。domains/identity.md。退会の書き手は #37。後述の `version` の項）

## Notes

### **[N-001]** 波1 の8系統は全段に届いている（伝播漏れゼロの実測記録）

抜き取りではなく、系統ごとに全段を突き合わせた結果を記録として残す。

**`linkSsoCredential`（54ユースケース目 / 新設）** — 8段すべてに実体がある。
| 段 | 実測 |
|---|---|
| シナリオ | `spec/scenario/account.md:33-35`（S-AC-02 エッジケース。追加・重複拒否・解除の3行）、`spec/scenario/index.md:17` |
| 画面 | `spec/pages/index.md` P-13（「SSO 連携の追加」機能と、成立しないときの状態）/ P-03（解除導線） |
| ドメイン | `spec/domains/identity.md:641`（★ 一覧）+ `:631`（`registerOrLoginWithSso` の「スコープ外なのは**サインイン時の自動リンクだけ**」という限定。R2-B-002 の受け皿） |
| ユースケース | `spec/usecases/identity.md:500-560`（概要 / 入出力 DTO / 6手順 / エラー5件） |
| 台帳 usecase | `UC-identity-016`（末尾 append。ADR-076） |
| 台帳 domain | `DOM-identity-042`（`CredentialLocatorStore.record`）ほか |
| 台帳 frontend | `PAGE-settings-008` |
| テストケース | `spec/testcases/identity/linkSsoCredential.md`（16件） |
| 台帳 test | `TC-linkSsoCredential-001`〜`016`（16行。ファイルの行数と一致） |
| 手順書 | `spec/manual-tests/account.md` TC-41 / TC-43 + カバレッジ表5行 + テストデータ「SSO 連携追加用 Google アカウント」（ADR-077） |

**`executePasswordReset` の出力 `void` → `{ userId }`** — 6段すべてが「新しいセッションを確立する」で揃っている。`spec/usecases/identity.md`（出力 DTO + 手順8 + 「確立は手順6-1 の世代前進より後」）/ `UC-identity-006` の要点欄 / `spec/testcases/identity/executePasswordReset.md`（先頭ケースの「出力は `{ userId }`」+ 末尾ケースの「再ログインを挟まずに実行できる」）/ `TC-executePasswordReset-022` / `spec/pages/index.md` P-03「完了画面の認証文脈」/ `PAGE-password-reset-003` `-004` / `spec/scenario/account.md:81`。**旧記述（`void` / 再ログイン）の取り残しは0件。**

**`purge-trash` の投入点5つ** — 「5つで全数」の宣言（`spec/domains/trash.md:254`）と、実際に起床を張る5箇所（`spec/usecases/memo.md:398` `softDeleteMemo` / `:574` AI `delete` / `spec/usecases/knowledge.md:269` `trashDocument` / `:537` `trashTopic` / `spec/usecases/identity.md:629` `changeTrashRetentionDays`）と、`spec/database/index.md:472` の投入点欄が完全に一致する。テストケースも5箇所すべてにある（`TC-softDeleteMemo-013` / `TC-delete-014` / `TC-trashDocument-012` / `TC-trashTopic-015` / `TC-changeTrashRetentionDays-013`）。

**`maxChunks`** — ユースケース（`spec/usecases/trash.md:320,324,338,344` の入力 DTO と手順）/ 台帳（`UC-trash-007` の要点欄）/ テストケース（`pruneExpiredTrashItems.md:16,22,24`）/ 台帳 test（`TC-pruneExpiredTrashItems-011` `-017` `-019`）/ 手順書のカバレッジ表（`spec/manual-tests/trash.md:406`）。ドメイン側は `chunkLimit` だけを持ち（`TrashQueryPort.listItemsToPurge(now, chunkLimit)`）、反復回数の上限はユースケースの責務に置かれている——**これは正しい割り方**で、DB 側の3階層（`spec/database/index.md:462`）と `spec/usecases/trash.md:324` が明示的に対応づけている。

**`CLAUDE.md` の Layers から `domain events` 除去** — `:43` に残存なし（`V-3` 0 行、`V-9` 0 行）。`spec/idea.md:48` の「Unit of Work + Outbox / ドメインイベント」も「Unit of Work（DO ローカルの同期トランザクション）+ Alarm ジョブ」に更新済み。

**件数同期** — 実測と `spec/index.md` / `spec/manual-tests/index.md` が全一致（下の機械ゲート節）。

---

### **[N-002]** 「設計に根拠のない発明」— 6件すべてに根拠を確認した

`.thread/34/design.md` を原文で当たった結果。

| 契約 | design.md の原文 | 判定 |
|---|---|---|
| `linkSsoCredential` | 第6.6節「link の順序（saga として扱う）」`design.md:1393-1419` が4 phase の cross-DO saga として全設計している（`resume-link` の投入、`sessionEpoch` を進めない、既存 `credentialVersion` に触れない、冪等キー `(credentialId, generation)`）。名前だけが design.md に無い | **根拠あり**（ADR-062 が名前と `spec/` への載せ方を記録） |
| `maxChunks` | 名前は design.md に無い。第7.4節の「ジョブ件数・チャンク反復回数・1チャンクの行数の3階層の上限」が上位概念で、`spec/usecases/trash.md:324` がその内側2つへの対応を明記 | **根拠あり**（ADR-068。設計の沈黙を spec の整合上埋めた形） |
| `AccountStore` | 名前は design.md に無い（0 ヒット）。第4.1.1節の `account` 列と第5.1節の epoch 規則が実体 | **根拠あり**（ADR-049 が命名と契約、ADR-064 が `version` の書き手不在を記録） |
| `CredentialLocatorStore` | design.md に2ヒット。第4.1.1節 `credential_locators` と第5.3節 step 5 (ii) の到達性検査が実体 | **根拠あり** |
| `recalculatePurgeAfter` | 名前は design.md に無い。第4.1.1節の `purge_after` 列と保持日数変更の再計算が実体 | **根拠あり**（ADR-047） |
| `listItemsToPurge` | 名前は design.md に無い。第7.5節 trash retention の期限処理が実体 | **根拠あり**（ADR-046。旧 `listExpiredItems` の置き直し。`V-4` が旧名 0 行を保証） |

**「下流だけ直して上流に根拠が無い」形は検出できなかった。** 逆向き（上流だけ直して下流が古い）も N-001 のとおり0件。

---

### **[N-003]** 波1 の担当者どうしの境界 — W-001〜W-003 以外は一致

- **`AccountStore` / `account` の分類と `version` の書き手** — 3ファイルが同じことを言う。`spec/database/index.md:79`「名前は `*Store` だが**この表は非集約ストア7つには入らない**」/ `:753`「`account` は集約ルート側であり、非集約ストアではない」/ `spec/domains/identity.md:378`「**`spec/database/index.md` の「非集約ストア」の分類に入るのは `CredentialLocatorStore` の側だけである**」/ `CLAUDE.md:68`「`account` is not on that roster … even though the domain names its port `AccountStore`」。書き手については `spec/database/index.md:81` と `spec/domains/identity.md:489` が「本 spec の範囲には条件付き更新を発行する操作が無い / 書き手は #37 の DO RPC 側」で一致（ADR-064）。**食い違いなし。**
- **非集約ストアの全数** — `spec/database/index.md:749`（7つの表）= `:754`（口を持つのは6ストア・7メソッド、`_meta` だけが口を持たない）= `spec/domains/identity.md:378`（7つを名前で列挙し員数も一致）。`CLAUDE.md` は ADR-054 どおり員数を持たず正本を指すだけ。`spec/inventory/adapter.md` の schema 行は 19 テーブル + 廃止記録 `ADP-users-001` の 20 行で、`P-10` の 19 名と全単射。**W-002 の1点を除いて一致。**
- **`enqueueJob` の呼び出し箇所** — identity 側（`resume-link` / `sweep-orphan-mapping`）と trash 側（`purge-trash`）の追加が衝突していない。`spec/usecases/identity.md:533` `:586` と `spec/usecases/{memo,knowledge,trash,identity}.md` の5箇所が、`spec/database/index.md:470-483` の投入点欄と1対1。
- **`resume-link` / `sweep-orphan-mapping` / `purge-trash` の投入点欄** — 3行とも「**これが唯一の投入点である**」「**投入点は5つで全数**」の断定を持ち、指した先に実体がある。`sweep-orphan-mapping` の spec 全域 0 件（2R の R2-B-004）は解消。

---

### **[N-004]** `send-mail` など5種の `kind` 名は `spec/database/index.md` と `spec/inventory/adapter.md` の外に一度も現れない

**場所:** `spec/database/index.md:478`（`send-mail`）/ `:479`（`resume-signup`）/ `:480`（`resume-credential-change`）/ `:481`（`sweep-reservations`）/ `:482`（`sweep-reset-tokens`）

投入点欄はこの5種について「`requestPasswordReset` を受けたトランザクション」「予約行を書く3箇所」等とユースケース側の手続きを指している。ところが指された側（`spec/usecases/identity.md` の `requestPasswordReset` 手順3・`linkSsoCredential` 手順3・`registerWithPassword` / `registerOrLoginWithSso`）は「同じトランザクションで送信ジョブの行を1行書き、同じ起床を張り」のように**散文で書いており、`kind` 名を1つも書いていない。**

**これは破れではない** — 5種はいずれも Identity Directory DO の所有であり、その `jobs` 表は User Data DO の UoW コンテキストからは触れないので、ユースケース側が `enqueueJob` として書けないのは正しい。`resume-link` / `sweep-orphan-mapping` / `purge-trash` の3種（User Data DO 所有）だけがユースケースに名前で現れるのも、この非対称の帰結である。

ただし **2R の R2-B-004 が「投入点が spec 全域 0 件」を Blocker にした基準を厳密に当てると、この5種は「投入点欄からの片道リンク」しか持たない。** 逆向きのアンカーが無いので、ユースケース側を編集したときに欄が古くなっても機械検査に掛からない（`P-9` は `kind` 名の有無しか見ない）。#37 が読む順序を考えると欄の側が正本で足りる、と本レビューは判断するが、次に投入点を動かす担当者への申し送りとして記録する。

---

### **[N-005]** AC-14 / AC-15 は未達のまま（W-029 の判定どおり、APPROVED 後に実行される）

実測:

```
#10: MISSING ADP-UD-001..004 / DOM-SEARCH-001..004 / UC-SEARCH-001 / TEST-DO-004,006,007 / TEST-MAN-002（13件）
#13: MISSING DOM-identity-016 / DOM-identity-017 / TC-revokeAiClientConnection-002（3件）
```

#13 側の3件は **AC-15 が「#13 から除け」と指定した当の3件**であり、`spec/` 側は既に正しく欠番になっている（`spec/inventory/domain.md` に `DOM-identity-013`〜`017` は不在、`DOM-identity-023`〜`028` は `AiClientConnectionRepository` の6メソッドを指し続けている）。#10 側の13件も着手前の実測と同一で、本 PR が増やした MISSING は無い。**残っているのは `gh issue edit` という外部副作用（ステップ18）だけ**で、`spec/` の側は受け入れ準備が完了している。triage の W-029 が「判定は fix だが実行順序は最後」と決めたとおりであり、本レビューは Blocker にしない。

---

### **[N-006]** #44 / #45 の切り出し境界は守られている（禁止6項目 + 前方互換点4点を全数走査）

**禁止項目（`.thread/35/plan.md:62` / ADR-009）:**

| 禁止項目 | 実測 |
|---|---|
| 巻き戻し手順 | `spec/` に無し。`spec/database/index.md:461` が「**それ以外の巻き戻し（自動回収）の具体 — 段の順序・原子性境界・終端モードの印・後始末の再試行上限 — は #45 が決める**ので、本ファイルには書かない」と明示委譲 |
| 段構成（3-i / 3-ii / 3-iii） | `grep -E '3-i\|段構成'` 0 行 |
| 終端モードの印（`terminalReason` の前倒し書き込み） | 無し。`jobs.terminal_reason` は列としてのみ存在し、書くタイミングの規定は無い |
| 材料寿命 | ADR-073 の判断（前方互換点3本の寿命は DB spec が持つ）の範囲内。`:461` / `:506` / `:618` / `:71` の4箇所はいずれも「消さない」という否定形の保存規則で、どの段でどう消すかは書いていない |
| 再試行上限 | `:461` が「後始末の再試行上限」を #45 のものと明記 |
| 受け口の割り当て | `:759` は operator 経路が**存在すること**（`purge-user-mappings` / `cancel-reservation`）までで、残渣種別ごとの割り当ては書いていない |

`spec/database/index.md:591` の `saga_committed` は #34 第6.4節が signup saga について決着させた予約行の印であり、#45 が設計する「終端モードの印」とは別物である（handoff 第3節「残すもの」の側）。

**前方互換点4点（handoff 第3節）:**

1. `operations.target_locators` を終端の各段が終わるまで消さない → `spec/database/index.md:500`（列定義。JSON 配列である理由つき）+ `:506`（否定形の保存規則）
2. コーディネーター予約行を終端の各段が終わるまで消さない → `:618`（`locators` / `candidate_user_id` / `caller_token` を持つ行を `sweep-reservations` が先に消さない）
3. `account.caller_token` を退会完走時以外に消さない → `:71`（列定義に「**消すのは退会の完走時だけであり、それ以外の経路では消さない**」）
4. `credential_mappings.change_state` を3値で実装する → `:564`（`CHECK (... IN ('pending','advanced'))` + 「**値域は3値である**」）/ `spec/domains/identity.md:410`（ドメイン側の意味）

**「残すもの」7項目**もすべて `spec/` 側に着地している — 分類 (C) が `poison` に達しうること（`:460`）/ backoff と poison の規則（`:460`）/ `jobs` の12列（`:430-443`。design 第7.4節の12列と1対1）/ 各 saga が終端時に残しうる中間状態（各ユースケースの「利用者から観測できるのは…」）/ 回収の材料の置き場（上の4点）/ operator 経路の存在（`:759`）/ 一様な終端の形（`:461`）/「黙って中間状態を残す」は選ばない（`:461` に原文で存在）。

## 機械ゲート（全件を自分で実行）

すべて `origin/main...HEAD` の作業ツリー上で実行。

**負の検証 — 全件 0 行（期待どおり）**

| 検査 | 実測 |
|---|---|
| V-1 / V-2a / V-2b / V-2c / V-3 / V-3b / V-4 / V-5 / V-6 / V-7 / V-8 / V-9 / V-10 | **すべて 0 行** |

**正の検証 — 全件ヒット（期待どおり）**

| 検査 | 実測 |
|---|---|
| P-1 | `requirements` FTS5=1 / `domains/search` 3 / `database/index` 11 / `manual-tests/search` 4 / `scenario/search` 全文検索=2 / `usecases/search` 3 — 全6ファイル 1 以上 |
| P-2 | `database/index` trigram=6 NFKC=3 不透明カーソル=1、`instr(` 2行、`domains/search` 不透明カーソル=1・`bm25\|timestamp DESC` 2行・`TOPIC_NOT_FOUND` 3行、`usecases/search` `TOPIC_NOT_FOUND` 1行 — 全行 1 以上 |
| P-3 | `schema_version` 14 / `migration_progress` 9 / `forward-only\|fail-closed\|PITR` 18 |
| P-4 | `Durable Object` 2 / `到達可能性\|10 ?GB` 2 |
| P-5 | `Durable Object` 7 / `at-least-once\|Alarm\|transactionSync` 8 |
| P-6 | `SearchIndexPort` は `query` 1行のみ |
| P-7 | 10本すべて 1 以上（2/4/2/2/2/2/1/7/3/2）+ 補の `changeState` 2 |
| P-8 | **0 行**（台帳の「定義場所」アンカーに dangling なし） |
| P-9 | **0 行**（12種すべてが `CLAUDE.md` と `spec/database/index.md` の両方に存在） |
| P-10 | **0 行**（19テーブル名すべて存在。節も21個すべて実在） |
| P-11 | `検索方式の選択をAIに委ねない` 1 行（維持）/ `search — 全文検索` 1 行 |

**件数（AC-18）**

- `spec/index.md` の旧値 grep: **0 行**
- `UC-` 台帳行 = **54** / `TC-` 台帳行 = **838** / シナリオ ID の異なり数 = **39** / マニュアルテスト合計 = **204** — `spec/index.md:15,16,21,24,26,27` の記載と全一致
- `spec/manual-tests/index.md` の件数表: account 43 / timeline 37 / document 41 / search 23 / trash 25 / ai 23 / settings 12、合計 204 — **各ファイルの実測 `grep -cE '^#+ TC-[0-9]+'` と全一致**。正常系/異常系/境界値の内訳も、節を持つ5ファイル（account 14/25/4・document 19/15/7・search 11/8/4・timeline 14+23・trash 13+12）で一致。実行記録欄の分母も `/204件`
- `spec/` の非レビュー Markdown = **103 ファイル**（AC-16 の期待値）

**台帳と実ファイルの全単射**

- **テストケース:** 全 40 ファイルについて「ファイルのデータ行数 = `spec/inventory/test.md` の `TC-{usecase}-*` 行数」が**全件一致**（不一致 0）。合計 838
- **`#L` 参照:** 838 行すべてについて、指し先が (a) 実在する行で、(b) 表のデータ行（区切り行でもヘッダでもない）で、(c) **台帳の k 番目の行がファイルの k 番目のデータ行を指す**ことを検証。**ズレ 0 件**（＝ ADR-078 の「行内書き換えと末尾 append に限る」が守られている）
- **ユースケース:** `spec/usecases/*.md` の見出しと `spec/inventory/usecase.md` の 54 行が全単射
- **ページ:** `spec/pages/index.md` の P-01〜P-14 と `spec/inventory/frontend.md` の 70 行の参照先が全単射
- **相対リンク:** 変更のあった全 spec ファイルの `](./*.md)` 形リンクを解決 — **broken 0 件**

**ID 欠番規約**

- 削除対象がすべて不在: `DOM-identity-013`〜`017` / `DOM-memo-007`〜`012` / `DOM-knowledge-015`〜`027`（イベント24行）/ `ADP-search-002`〜`009` / `ADP-search-embeddings-001` / `ADP-occ-guard-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-trash-004` / `DOM-search-005`〜`012` / `UC-search-002` / `TC-maintainSearchIndex-*`（0件）
- 繰り上げが起きていない: `DOM-identity-023`〜`028` が改訂前と同じ `AiClientConnectionRepository` の6メソッドを指す（AC-15 の前提）。`ADP-trash-005` / `-006` は `-004` を欠番のまま末尾 append（ADR-057）。`ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001` は削除されずに残存（plan のリスク欄が名指しした行18 の例外）
- `TC-*` の連番も欠番のまま: `TC-revokeAiClientConnection-002` / `TC-search-006,022,028,029` / `TC-pruneExpiredTrashItems-010` が飛んでいて、後続が繰り上がっていない

**ADR 番号 / スコープ / lint**

- `.thread/35/adr.md` の `## ADR-NNN` は **78 件で重複 0**（001〜078 の連番）
- `git diff --name-status origin/main...HEAD | grep -vE '^[AMD]\s+(spec/.*\.md|CLAUDE\.md|\.thread/35/.*)$'` — **0 行**（スコープ逸脱なし。コード・コンフィグの変更 0）
- `pnpm lint` exit 0 / `pnpm format:check` exit 0 / 変更ファイルの NUL バイト 0
- `.thread/35/coverage.md` は 104 行（103 ファイル + 削除1件の判定行）で、内訳「改訂 80 / 新設 3 / 削除 1 / 影響なし 20」が実測と一致。`NO-VERDICT` 0 行

## カバレッジ（104 件と1対1）

**確認 90 件 / スキップ 14 件 = 104 件**

### 契約・正本（確認 3）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 1 | `CLAUDE.md` | 確認（精読） | Layers の `domain events` 除去 / Key concepts の UoW 名簿と4類型 / Retry strategy / Error handling / Reference runtime。**W-002** |
| 2 | `.thread/35/plan.md` | 確認（精読） | AC-1〜19・スコープ・検証バッテリー全文を根拠に使用 |
| 3 | `.thread/35/adr.md` | 確認（精読・抽出） | ADR-001〜078 の見出し全数 + ADR-009 / 046 / 047 / 049 / 051 / 054 / 057 / 059 / 061 / 062 / 064 / 066〜078 を本文で確認 |

### 上流（要件・シナリオ・画面）（確認 8）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 4 | `spec/idea.md` | 確認 | 差分全文。ハイブリッド→全文検索、Outbox→Alarm ジョブ |
| 5 | `spec/index.md` | 確認 | 差分全文。件数 54/838/39/204、テーブル 16+5、ADR 表の 005 注記と `.adr/` 表の新設 |
| 6 | `spec/requirements.md` | 確認 | `P-1` / `P-4` / `P-11`。4.4 の残す一文の維持 |
| 7 | `spec/scenario/index.md` | 確認 | 差分全文。SSO 連携の追加・解除の1行追加、全文検索への置換 |
| 8 | `spec/scenario/account.md` | 確認（精読） | S-AC-02 エッジケース3行（link 追加・重複拒否・解除）、S-AC-07 のリセット完了導線2つ、`P-7` の `所有確認\|verification` |
| 9 | `spec/scenario/ai.md` | 確認 | 差分全文。S-AI-02 の全文検索置換 |
| 10 | `spec/scenario/search.md` | 確認 | `P-1`（`全文検索`=2）。実装語彙 FTS5 が漏れていないこと |
| 11 | `spec/pages/index.md` | 確認（精読） | P-02 / P-03（完了画面の認証文脈と必須導線2つ）/ P-11（不透明カーソル・カーソル期限切れ・TOPIC_NOT_FOUND）/ P-13（SSO 連携追加・試行制限の開示）/ `V-10` 0 行 |

### ドメイン（確認 7）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 12 | `spec/domains/index.md` | 確認（精読） | テナント分離「例外は無い」/ ポートの同期契約の例外は列挙（W-024 の適用先）/ 派生データの同一トランザクション更新 |
| 13 | `spec/domains/identity.md` | 確認（精読） | `AccountStore` / `CredentialLocatorStore` の契約、`CredentialMapping` の8語、濫用抑止3規則、ユースケース概要16件、`usableForLogin`。**W-003** |
| 14 | `spec/domains/memo.md` | 確認 | `recalculatePurgeAfter`、`softDelete` の新シグネチャ、`V-3b` 0 行 |
| 15 | `spec/domains/knowledge.md` | 確認 | `Topic/DocumentRepository.recalculatePurgeAfter`、`TrashRetentionDays` の入力、`V-3b` 0 行 |
| 16 | `spec/domains/search.md` | 確認（精読） | `SearchIndexPort` が `query` 1本、検索の規則4点、`IndexEntry` の projection 化、インデックスの維持節、**tokenizer 機構（trigram / instr( / NFKC）が漏れていないこと** |
| 17 | `spec/domains/trash.md` | 確認（精読） | `listItemsToPurge` / `findEarliestPurgeAfter`、投入点5つの全数宣言、`purgeAfter` 駆動のユビキタス言語 |
| 18 | `spec/domains/export.md` | 確認 | `ArchiveWriter` の同期契約（`V-*` / 語彙走査） |

### DB（確認 1）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 19 | `spec/database/index.md` | 確認（精読） | 21テーブルの節、共通方針（主キー3通り + 例外2つ、OCC）、`jobs` 12列・収束規則3つ・`kind` 全数表と投入点欄、`operations` / `credential_mappings` / `_meta`、非集約ストア7つと6ストア・7メソッド、operator 経路、リレーション図、`P-3` / `P-9` / `P-10`。**W-001 / W-003** |

### ユースケース（確認 6）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 20 | `spec/usecases/identity.md` | 確認（精読） | 16ユースケース。`linkSsoCredential` / `unlinkSsoCredential` / `revokeAllAiClientConnections` / `executePasswordReset` / `changePassword` / `requestPasswordReset` / `getCurrentUser` / `changeTrashRetentionDays` を全文 |
| 21 | `spec/usecases/memo.md` | 確認 | `softDeleteMemo` / AI `delete` の `purge-trash` 投入、カーソル記述 |
| 22 | `spec/usecases/knowledge.md` | 確認 | `trashDocument` / `trashTopic` の `purge-trash` 投入 |
| 23 | `spec/usecases/trash.md` | 確認（精読） | `pruneExpiredTrashItems` の `chunkLimit` / `maxChunks`、再計算フェーズの有界反復、起動契機 |
| 24 | `spec/usecases/search.md` | 確認 | 入力 DTO の不透明カーソル、`TOPIC_NOT_FOUND`、`V-10` 0 行 |
| 25 | `spec/usecases/export.md` | 確認 | 上限・`transactionSync` 記述（`P-7` 第9行の対） |

### 台帳（確認 5）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 26 | `spec/inventory/usecase.md` | 確認（精読） | 54行。`UC-identity-016` 新設、`UC-identity-006` の `{ userId }`、`UC-trash-007` の `maxChunks`。見出しとの全単射 |
| 27 | `spec/inventory/domain.md` | 確認（精読） | 129行。イベント24行の削除と欠番、`DOM-identity-036`〜`044`、`DOM-trash-008` / `-009`、`DOM-memo-026` / `DOM-knowledge-056` / `-057` |
| 28 | `spec/inventory/adapter.md` | 確認（精読） | 99行。schema 行20（19テーブル + `ADP-users-001`）、`ADP-trash-005` / `-006` と `-004` 欠番、`ADP-jobs-002` / `ADP-meta-002` |
| 29 | `spec/inventory/test.md` | 確認（機械全数） | 838行。テストケース40ファイルとの全単射、`#L` の k 番目一致、欠番 |
| 30 | `spec/inventory/frontend.md` | 確認 | 70行。`PAGE-settings-008`（link）/ `PAGE-password-reset-004`（P-03 必須導線）/ `PAGE-search-005`（不透明カーソル） |

### テストケース（確認 49）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 31 | `spec/testcases/identity/linkSsoCredential.md` | 確認（精読） | 新設16件。台帳と全単射 |
| 32 | `spec/testcases/identity/unlinkSsoCredential.md` | 確認 | 新設。台帳と全単射 |
| 33 | `spec/testcases/identity/revokeAllAiClientConnections.md` | 確認 | 新設。台帳と全単射 |
| 34 | `spec/testcases/identity/executePasswordReset.md` | 確認（精読） | 22件。`{ userId }`、`changeState` 中間状態、P-03 必須導線、一様な終端 |
| 35 | `spec/testcases/identity/changePassword.md` | 確認 | `changeState` 2件（`P-7` 補） |
| 36 | `spec/testcases/identity/loginWithPassword.md` | 確認 | `到達性` / `credentialVersion` / `nextAttemptAllowedAt` / `changeState`（`P-7` 1・2行目） |
| 37 | `spec/testcases/identity/getCurrentUser.md` | 確認 | `credentialId`（`P-7` 3行目） |
| 38 | `spec/testcases/identity/listAiClientConnections.md` | 確認 | `createdAtResetVersion`（`P-7` 4行目） |
| 39 | `spec/testcases/identity/requestPasswordReset.md` | 確認 | `operationKey`（`P-7` 5行目） |
| 40 | `spec/testcases/identity/changeTrashRetentionDays.md` | 確認（精読） | 14件。再計算とチャンク分割の2件 |
| 41 | `spec/testcases/identity/registerWithPassword.md` | 確認 | 台帳と全単射・`V-3` / `V-3b` 0 行 |
| 42 | `spec/testcases/identity/registerOrLoginWithSso.md` | 確認 | 同上 |
| 43 | `spec/testcases/identity/approveAiClientAuthorization.md` | 確認 | 同上 |
| 44 | `spec/testcases/identity/denyAiClientAuthorization.md` | 確認 | 同上 |
| 45 | `spec/testcases/identity/logout.md` | 確認 | 同上 |
| 46 | `spec/testcases/identity/revokeAiClientConnection.md` | 確認 | 同上 + `-002` の欠番 |
| 47 | `spec/testcases/export/exportAllData.md` | 確認 | `上限\|transactionSync`（`P-7` 9行目） |
| 48 | `spec/testcases/trash/listTrash.md` | 確認 | `purge_after`（`P-7` 6行目） |
| 49 | `spec/testcases/trash/pruneExpiredTrashItems.md` | 確認（精読） | 18件。`chunkLimit` / `maxChunks` / 再計算フェーズの打ち切り。`-010` 欠番 |
| 50 | `spec/testcases/trash/emptyTrash.md` | 確認 | 台帳と全単射・語彙走査 |
| 51 | `spec/testcases/trash/hardDeleteTrashItem.md` | 確認 | 同上 |
| 52 | `spec/testcases/trash/restoreMemo.md` | 確認 | 同上（`purgeAfter` 落とし） |
| 53 | `spec/testcases/trash/restoreDocument.md` | 確認 | 同上 |
| 54 | `spec/testcases/trash/restoreTopic.md` | 確認 | 同上 |
| 55 | `spec/testcases/search/search.md` | 確認（精読） | 41件。`V-10` 0 行、カーソルの形式/中身・期限の分離、`-006/022/028/029` 欠番 |
| 56 | `spec/testcases/memo/softDeleteMemo.md` | 確認 | `purge-trash` 起床の投入 |
| 57 | `spec/testcases/memo/delete.md` | 確認 | 同上（AI 経路） |
| 58 | `spec/testcases/memo/getTimeline.md` | 確認 | カーソル3件 |
| 59 | `spec/testcases/memo/postMemo.md` | 確認 | 台帳と全単射・`V-3b` 0 行 |
| 60 | `spec/testcases/memo/post_memo.md` | 確認 | 同上 |
| 61 | `spec/testcases/memo/editMemo.md` | 確認 | 同上 |
| 62 | `spec/testcases/memo/update_memo.md` | 確認 | 同上 |
| 63 | `spec/testcases/memo/rollbackMemo.md` | 確認 | 同上 |
| 64 | `spec/testcases/memo/diffMemoRevisions.md` | 確認 | 同上 |
| 65 | `spec/testcases/knowledge/createDocument.md` | 確認 | 同上 |
| 66 | `spec/testcases/knowledge/createTopic.md` | 確認 | 同上 |
| 67 | `spec/testcases/knowledge/editDocument.md` | 確認 | 同上 |
| 68 | `spec/testcases/knowledge/editDocumentByAi.md` | 確認 | 同上（1R B-003 のイベント名残存4行の1つ） |
| 69 | `spec/testcases/knowledge/trashDocument.md` | 確認 | `purge-trash` 起床の投入 |
| 70 | `spec/testcases/knowledge/trashTopic.md` | 確認 | 同上 |
| 71 | `spec/testcases/knowledge/updateTopic.md` | 確認 | `V-3b` 0 行（B-003 の対象） |
| 72 | `spec/testcases/knowledge/getDocument.md` | 確認 | 台帳と全単射 |
| 73 | `spec/testcases/knowledge/getTopic.md` | 確認 | 同上 |
| 74 | `spec/testcases/knowledge/listDocumentRevisions.md` | 確認 | 同上 |
| 75 | `spec/testcases/knowledge/listDocumentSourceMemos.md` | 確認 | 同上 |
| 76 | `spec/testcases/knowledge/listDocumentsReferencingMemo.md` | 確認 | 同上 |
| 77 | `spec/testcases/knowledge/rollbackDocument.md` | 確認 | 同上 |
| 78 | `spec/testcases/knowledge/diffDocumentRevisions.md` | 確認 | 同上 |
| 79 | `spec/testcases/search/maintainSearchIndex.md`（削除） | 確認 | 削除済み。`TC-maintainSearchIndex-*` 0 行、`coverage.md` に「削除」判定行あり |

### マニュアルテスト（確認 8）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 80 | `spec/manual-tests/index.md` | 確認（精読） | 件数表7行 + 合計 204 + 実行記録の分母。実測と全一致 |
| 81 | `spec/manual-tests/account.md` | 確認（精読） | TC-01〜43 連番、TC-38 / 41 / 42 / 43、カバレッジ表の新設3ユースケース、SSO 連携追加用 Google アカウント、`ロックアウト`（`P-7` 8行目） |
| 82 | `spec/manual-tests/trash.md` | 確認（精読） | 環境前提2手段、TC-13 / 23 / 24 の `purge_after` 駆動、`V-2c` 0 行 |
| 83 | `spec/manual-tests/search.md` | 確認 | FTS5 新設4件（TC-18〜21 相当）、`V-2c` / `V-7` 0 行、`P-1` |
| 84 | `spec/manual-tests/timeline.md` | 確認 | TC 連番37、件数表と一致、`V-3` 0 行 |
| 85 | `spec/manual-tests/document.md` | 確認 | TC 連番41、内訳 19/15/7 一致 |
| 86 | `spec/manual-tests/ai.md` | 確認 | TC 連番23、件数表と一致 |
| 87 | `spec/manual-tests/settings.md` | 確認 | TC 連番12、件数表と一致 |

### 作業成果物（確認 3 / スキップ 14）

| # | ファイル | 扱い | 内容 |
|---|---|---|---|
| 88 | `.thread/35/coverage.md` | 確認 | 104行 = 103ファイル + 削除1。判定内訳 80/3/1/20 を実測と照合、`NO-VERDICT` 0 |
| 89 | `.thread/35/review/triage.md` | 確認（精読） | 1R / 2R の既判定 Key を把握（再審議回避のため） |
| 90 | `.thread/35/review/review-002-design-fidelity.md` | 確認（抽出） | 2R の N-005 / #44・#45 境界の判定を確認し、W-003 との重複を排除 |
| 91 | `.thread/35/steps.md` | スキップ | 作業手順書。成果物の整合は spec 実物で直接検証したため参照不要 |
| 92 | `.thread/35/testing.md` | スキップ | 検証手順書。`plan.md` のバッテリーを自分で実行したため代替 |
| 93 | `.thread/35/step14-checklist.md` | スキップ | (A)/(B)/(C) 適用の作業記録。結果は `V-3` / `V-3b` 0 行と台帳全単射で担保 |
| 94 | `.thread/35/review/review-001.md` | スキップ | 1R の指摘は `triage.md` に判定つきで集約済み |
| 95 | `.thread/35/review/review-001-database.md` | スキップ | 同上 |
| 96 | `.thread/35/review/review-001-design-fidelity.md` | スキップ | 同上 |
| 97 | `.thread/35/review/review-001-domain-usecase.md` | スキップ | 同上 |
| 98 | `.thread/35/review/review-001-requirements.md` | スキップ | 同上 |
| 99 | `.thread/35/review/review-001-testcases.md` | スキップ | 同上 |
| 100 | `.thread/35/review/review-002.md` | スキップ | 2R の指摘は `triage.md` に判定つきで集約済み |
| 101 | `.thread/35/review/review-002-database.md` | スキップ | 同上 |
| 102 | `.thread/35/review/review-002-domain-usecase.md` | スキップ | 同上 |
| 103 | `.thread/35/review/review-002-requirements.md` | スキップ | 同上 |
| 104 | `.thread/35/review/review-002-testcases.md` | スキップ | 同上 |

## 判定

**APPROVED 可（YES）。** Blocker 0 件で、機械ゲートは全件通過し、2波方式で入れた8系統の契約変更はいずれも下流の全段へ届いている。Warning 3 件はすべて `spec/database/index.md` の2行と `CLAUDE.md` の1文に閉じる局所修正で、下流の派生物には波及していない。
