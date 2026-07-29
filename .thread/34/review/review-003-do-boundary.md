# DO 境界・ルーティング

3ラウンド目。ゼロベースで `.thread/34/design.md`（1,711行）を全文読み、Issue #34 対応項目3、`plan.md` の AC-4 / 11 / 12 / 13 / 15 / 22 / 23、既存コード、`spec/inventory/adapter.md` の `ADP-*` 台帳（実測85件）、Cloudflare 公式ドキュメント（limits / alarms / storage-api / sql-storage / sqlite-storage-api / id / error-handling / state / durable-objects-migrations）を突き合わせた。

**先に総括を書く。** 事実引用の精度は極めて高い。行番号・シンボル名・件数を30件以上照合して、実質的な誤りは下の W-004 / N-002 / N-003 の3件だけだった（`d1/` 20ファイル 2,514行 / プロダクション8ファイル 914行、`eventRelayWorker.ts` 301行、`handlers.ts` 138行 `handleQueue`:82 `handleDlq`:120、`wrangler.toml` 162行、`unitOfWork.ts` 19行、`pendingBatch.ts` 98行、`d1/unitOfWork.ts:39` の JSDoc、`schema.ts:118` の `OCC_GUARD_CHECK_NAME`、`currentUser.ts:17-26` / `:28-33`、`authState.ts:18-23`、`valueObject.ts:47` / `:125` / `:142`、`entity.ts:29`、`SystemErrorCode` 6値、`errorResponse.ts:70` / `:101`、`di/types.ts:53` / `:70`、`0000_initial.sql:46,47`、`spec/database/index.md:79` / `:355-357`、`spec/domains/search.md:264`、`spec/usecases/search.md:93`、`spec/domains/trash.md:239`、`spec/usecases/trash.md:315`、`spec/domains/export.md:249` / `:267` / `:275` / `:282`、`spec/requirements.md:87`、pulumi の destroy 保護コメント、deploy スクリプト24本、`spec/` 非レビュー md 101ファイル / レビュー39ファイル / 語彙走査ヒット62ファイル — すべて一致）。Cloudflare 公式の事実表（第2.1節）も #1〜#31 のうち検証可能な全項目が原文どおりだった。

**それでも Blocker を3件出す。** いずれも「章をまたぐ自己矛盾」で、うち2件（B-001 / B-002）は**設計が自ら網羅を宣言した表の穴**であり、#37 がそのまま実装すると saga が回復しない／認証が緩む。

---

## Blockers

### **[B-001]** 鍵ローテーションと credential 変更 saga・signup 予約の相互作用が未設計。旧パスワード復活と恒久ロックアウトが両方成立する

- 場所: `.thread/34/design.md:914-926`（第6.8節 手順2）、`.thread/34/design.md:627-632`（第6.1節 (c)）、`.thread/34/design.md:825-838`（第6.5.1節）、`.thread/34/design.md:949-956`（第6.9節の締め出し経路一覧）
- 理由:

  第6.8節 手順2 は移送を4段（(1) 新 locator 追加 → (2) 移送先へ active 行 → (3) previous 行削除 → (4) 旧 locator 削除）で行い、`credential_mappings` 行の**読み出しは (1) より前**にある。(1) と (2) はいずれも DO 間 RPC なので `await` を挟み、第2.1節 #18（公式記載。`await` で input gate が開く）のとおり **source bucket に別リクエストが割り込める**。割り込める相手は第6.5.1節 phase 1（`begin-credential-change`）である — active 行がまだ移送先に無い窓では、lookup は active → previous の順で previous にヒットするので、**credential 変更は移送元の行に着地する**。

  設計はこの危険を**移送先側だけ**塞いでいる（`:919` の「(2) は移送先に行が無い場合にだけ書く CAS にする」。理由として挙げているのがまさに「(2) の後にその credential へパスワード変更が完走していた場合、再実行が…旧パスワードが復活する」）。**移送元側には同じガードが無い。** 帰結は2つとも重大である。

  - **(a) 旧パスワードの復活。** 窓の中でパスワード変更が完走すると、移送元行は `passwordVerifier` = 新・`credentialVersion` = n+1 になる。ところが (2) が書くのは**読み出し時のスナップショット**（旧 verifier / n）で、(3) が新しい値を持つ移送元行を消す。第6.8節 `:921` は「移送は `credentialVersion` を保存する（増やさない）」と定めているので、移送先も n のままである。User Data 側は (1) で n の新 locator 行を得て (4) で n+1 の旧 locator 行を失うので、**Directory と User Data が揃って n に巻き戻る** — 第5.3節 step 5 (iii) の `credentialVersion` 照合は一致して通り、**旧パスワードでログインできる**。第6.8節 `:919` が自ら「旧パスワードが復活する」と呼んだ事象が、再実行経路ではなく初回実行経路で成立する。

  - **(b) 恒久ロックアウト。** 移送元行が `changeState = 'pending'`（phase 1 完了・phase 3 未完了）の状態で移送されると、**前進ジョブ `resume-credential-change` は移送元 bucket の `jobs` テーブルにある**（第6.5.1節 `:836`「前進の駆動は Directory bucket の Alarm」／第7.4節の所有者表）。第6.8節 `:924` は「移送対象は `credential_mappings` 行だけである」と明記しており、**`jobs` 行は移送されない**。したがって phase 3 は永久に走らない。行ごと移送されれば移送先で `changeState = 'pending'` が固定され、行の一部だけが移ればユーザーは「User Data 側で epoch と `credentialVersion` が前進済み、Directory 側は旧 verifier」になる。**どちらでも旧新どちらのパスワードも通らない状態が恒久化する。** 第6.5.1節 `:834` が「可用性は落ちるが認可は開かない」と受容しているのは**短時間の中間状態**についてであって、恒久化は第6.9節の「fail closed が利用者を締め出す経路」の一覧（`:951-956`、4行）に**載っていない**。同節は「新しい cross-DO 操作を足したら、この一覧にも行を足す」としているが、これは新操作ではなく**既存2操作の相互作用**なので、その規則では捕まらない。

  - **(c) `reserved` 行の移送が未定義。** 第6.8節 `:926` 手順4 は退役証明で数える対象を「**`status` を問わず** previous 世代の bucket に残る `credential_mappings` 行の総数」とし、理由に「`reserved` を除外すると、移送されていない予約行を見落とす」と明記している。つまり `reserved` 行も移送対象である。ところが予約行はコーディネーターの `locators[]` / 非コーディネーターの `coordinatorLocator`（第4.1.1節 `:248`）で**旧世代の locator を相互参照**しており、`resume-signup` ジョブも旧 bucket の `jobs` にある。移送すると第6.3節の saga の参照が全部切れる。また `reserved` 行に対する手順2 (1) は「候補 `userId` の User Data DO に `credential_locators` を書く」ことになるが、phase 2 前なら**その DO はまだ存在しない**（第6.2節 `:668` が「重複チェックに勝った signup だけが User Data DO を作る」ために phase を入れ替えた前提と衝突する — 移送が未生成の DO を起こす）。

  第6.1節 (c) `:631` の「**previous 世代の行に対して起きる書き込みはローテーションによる削除だけであり**」という断定が、この3つを設計の視界から外している原因である。実際には previous 行に対して `begin-credential-change`（第6.5.1節 phase 1）・`promote-verifier`（phase 3）・`report-login-result` の `failedAttempts` 更新（第6.2.2節 (a)）・`lastResetRequestedAt` 更新（同 (b)）・リセットトークン行の発行（第6.1節 (d)）が起きる。同節が「ローテーションは数時間〜数日オーダーで開く窓である」と自ら見積もっている以上、これらの同時発生は例外ではなく通常事象である。

- 提案: 第6.8節 手順2 に**移送元側のガード**を3点足す。
  1. **(3) を CAS にする** — 「読み出し時の `credentialVersion` / `passwordVerifier` / `changeState` / `operationId` と一致する場合にだけ削除する」。0行削除なら (2) で書いた移送先行を破棄して**そのユーザーの移送をやり直す**（ジョブは冪等なので次の Alarm で再読み出しから始まる）。
  2. **`changeState = 'pending'` の行は移送しない** — スキップして次の bucket へ進み、`rotation_checkpoints.previousCount` に残す。pending が解けた次の走査で移送される。これで `resume-credential-change` ジョブの所有 bucket と行の所在が常に一致する。（併せて第7.4節の `rotate-remap` に「スキップした行があれば再走査する」規則を足す。）
  3. **`status = 'reserved'` の行も移送しない** — 予約は TTL で消えるか `active` へ昇格するかのどちらかなので、pending と同じくスキップして再走査で拾えばよい。手順4 の退役証明が「`status` を問わず0件」を要求している以上、**スキップした行が最終的に0になることが退役条件**になる（＝ローテーションは予約 TTL より長く回る、を制約として明記する）。
  4. 第6.1節 (c) `:631` の断定を「previous 世代の行にはローテーション以外の書き込みも起きる（credential 変更・カウンタ更新・トークン発行）。トゥームストーンが不要なのは**削除が active 世代への移送と対**だからであって、書き込みが無いからではない」に訂正する。
  5. 第6.9節 `:951-956` の締め出し経路一覧に「ローテーション中の credential 変更が phase 3 に到達できず恒久的に pending になる」を1行足す。

### **[B-002]** 第5.1節の RPC エントリ表が「クラス (2)(3) の全数」を宣言しているのに、signup saga の再開・補償経路に必要なエントリが3つ欠けている

- 場所: `.thread/34/design.md:413-440`（第5.1節）、`.thread/34/design.md:798`（第6.4節）、`.thread/34/design.md:742`（第6.3節 phase 1b）、`.thread/34/design.md:804`（第6.4節 3）
- 理由:

  第5.1節 `:413` は「**したがって RPC エントリを3クラスに分け、(2)(3) を全数で列挙する。これが #37 への断定である**」と書き、第6.3節 `:766` も「クラス (2)(3) の全数は第5.1節の表が正本である」と念を押している。しかし第6章の saga が要求する経路のうち3つが表に無い、または呼び出し元が違う。

  1. **`reserve-credential` の呼び出し元が「request Worker（未認証）」だけになっている**（`:425`）。第6.4節 `:798` は「`resume-signup` ジョブは**コーディネーター bucket の job table にだけ**投入し、その Alarm が **phase 1b → 2 → 3 → 4 を前進させる**。…**phase 1b と 3 は Directory bucket → 別の Directory bucket の RPC**」と断定している。phase 1b は第6.3節 `:742` のとおり**予約を取る**手順なので、`reserve-credential` はコーディネーター bucket からも呼ばれる。同じ理由で `check-previous-generation`（`:434`。呼び出し元欄は「request Worker（signup）/ User Data DO（link）」）も phase 1b の「同じ確認」としてコーディネーター bucket から呼ばれる。
     - これにより `:426` の「**この1本だけが (2) と (3) の両方から呼ばれる**」（`initialize-account` について）という断定が偽になる。
  2. **予約の敗者補償・敗北時の一括削除に対応するエントリが無い。** 第6.3節 `:742` phase 1b は「1つでも敗北したら、**コーディネーターが全予約を冪等に削除して** saga 全体を敗北させる」とし、第6.5節 `:813` も「敗者は自分の `operationId` を持つ `reserved` 行だけを削除する」と定める。表にある唯一の削除系エントリは `delete-mapping`（`:436`）だが、呼び出し元は「User Data DO」、ガードは「mapping 行の `userId` 一致」である。予約行が持つのは `userId` ではなく `candidateUserId`（第4.1.1節 `:248`）で、呼び出し元も bucket なので、**`delete-mapping` では代用できない**。
  3. **到達不能アカウントの終端処理に対応するエントリが無い。** 第6.4節 `:804` は「`resume-signup` は **User Data DO の `account.status` を `deleting` へ倒し**、退会と同じ経路（第6.7節）で回収する」と断定する。呼び出し元は Directory bucket、対象は User Data DO だが、表の class (3) にある User Data DO 向けエントリは `advance-credential-change` と `record-credential-locator` の2つだけで、どちらも `account.status` を触らない。

  結果として、#37 が第5.1節の表を「正本」として実装すると、**phase 1a と 1b の間で落ちた signup を前進させる手段が無く**（1 が無い）、**phase 1b で敗北した予約を能動的に回収する手段も無く**（2 が無い。TTL 掃除に落ちるが、第6.4節はこれを「敗者の冪等補償」と別立てで設計している）、**第6.4節 3 の終端規則が実装不能になる**（3 が無い）。第6.4節が「黙って到達不能アカウントを残すだけは選ばない」と決めた結論が、正本の表の側で担保されていない。

- 提案:
  - `reserve-credential` の呼び出し元欄に「**または コーディネーター bucket（`resume-signup` の phase 1b）**」を、`check-previous-generation` の欄に「**コーディネーター bucket（`resume-signup`）**」を足す。
  - `:426` の「この1本だけが (2) と (3) の両方から呼ばれる」を「(2) と (3) の両方から呼ばれるのは `initialize-account` / `reserve-credential` / `check-previous-generation` の3本である」に訂正する。ガードは3本とも呼び出し元に依存していないので、`:440` の「binding を絞って到達性だけで守る形は採らない」という結論はそのまま維持できる。
  - class (3) に **`cancel-reservation`**（コーディネーター bucket → 各 bucket。ガード: 予約行の `operationId` 一致 + `status = 'reserved'`。「無ければ成功」の冪等操作）と、**`abandon-account`**（Directory bucket → User Data DO。ガード: `operations` 行の `operationId` 一致 + `account.status = 'active'` かつ当該 signup 由来であること。`deleting` へ倒して `finalize-withdrawal` を投入）の2行を足す。
  - 併せて第7.4節 `:1079` の「cross-DO saga を前進させるジョブは、saga の起点となった側の DO が所有する」の直後に、上の2本が「前進ではなく補償・終端の RPC である」ことを1行で位置づける。

### **[B-003]** 第4.1.1節（テーブルと列の正本）に OCC の `version` 列が1つも無い。第8.4節「OCC は残す」と第8.2.1節「`Versioned` / `ExpectedVersion` はそのまま残す」が実装不能になる

- 場所: `.thread/34/design.md:229-256`（第4.1.1節）、`.thread/34/design.md:1299-1309`（第8.4節）、`.thread/34/design.md:1239`（第8.2.1節「変わるもの」表）
- 理由:

  第4.1.1節 `:233` は「**本表はテーブルの全数と、認証・saga・ジョブ系テーブルの列の全数の両方の正本である。#37 が実テーブルと実列を判断する根拠はこの表である。**」「**本表と第6〜9章の本文が食い違ったら本表を直す**」と宣言している。集約テーブル（`memos` / `topics` / `documents` とその子）の列は `spec/database/index.md` に委ねると明記しているが、`account` / `user_settings` / `credential_locators` / `ai_client_connections` / `credential_mappings` は**本表が列を全数で列挙している**。そのどれにも `version` 列が無い。

  一方で第8.4節は「**残す**」と断定し、実現手段を「`UPDATE ... SET ... WHERE id = ? AND version = ?` を実行し、変更行数が0なら `ConflictError("OPTIMISTIC_LOCK_FAILURE")`」と具体化している。第8.2.1節の「変わるもの」表 `:1239` も「`Versioned<T>` / `ExpectedVersion<T>` — **そのまま残す。** OCC は残すため（第8.4節）。ブランド型による『読まずに書く』の型エラー化も維持する」と書いている。しかも第8.4節が OCC を残す動機として挙げている具体例が「**設定画面からの二重解除操作のような競合**」であり、これはまさに `ai_client_connections` / `user_settings` の話である。

  実装側の現状もこれを裏づける — `spec/database/index.md:12` が「集約ルートに `version INTEGER NOT NULL`（生成時 0）」を規約として定め、`:50`（`users`）・`:115`（`ai_client_connections`）が実列として持っている。`packages/core/src/domain/identity/ports/userRepository.ts` の `save(user, expectedVersion: ExpectedVersion<User>)` も現に OCC 契約である。第4.3節の行11 / 行7c はこの `User` 集約を「認証情報は Directory、設定は User Data DO」に**分裂させる**と決めているので、`version` は分裂後の両側に要る。

  したがって #37 が第4.1.1節を正本として DDL を書くと、**identity 系の全テーブルから OCC が黙って消える**。第4.7節の翻訳表が4行目に置いた「条件付き UPDATE の0行一致（OCC 不一致）→ `ConflictError("OPTIMISTIC_LOCK_FAILURE")`」も、照合する列が無いので発火しない。

- 提案: 第4.1.1節の該当行に `version`（OCC）を足す。最低限 `account` / `user_settings` / `ai_client_connections` の3つ。`credential_mappings` については、Directory 側の書き込みが `operationId` / `changeState` の CAS で直列化されるため OCC が不要である可能性が高いので、**「不要である」を1行の断定として書く**（第8.2.1節が `UserRepository` を2ポートに割ると決めた以上、割った両側について OCC の要否を書かないと #37 が判断できない）。`credential_locators` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` / `_meta` / `password_reset_tokens` は集約ではないので、`spec/database/index.md:91` の `password_reset_tokens` と同じく「OCC の `version` は持たない」を明示するのが安全である。

---

## Warnings

### **[W-001]** 第5.5節 1 の「`userId` を `idFromName` に渡せるのは2経路だけ」という列挙が、login step 5 を取りこぼしている（AC-12 の構造的保証の記述）

- 場所: `.thread/34/design.md:611-612`（第5.5節 1）、`.thread/34/design.md:538`（第5.3節 step 5）
- 理由: 第5.5節 1 は「ここに `userId` を渡せるのは (i) `sessionCodec.verify` / AI クライアントトークン検証の戻り値、(ii) signup で `IdGenerator` が毎回新規に採番した候補 `userId`、**のいずれかに限られる**」と断定し、第5.2.2節 (a)(ii) も同じ2つだけを挙げている。ところが第5.3節 step 5 は「成功したら `idFromName(userId)` で User Data DO を引き」と書いており、この `userId` は **step 3 で Directory bucket が返した値**である — (i) でも (ii) でもない第3の出所である。同節の但し書き（`:612`）が扱っているのは **DO → DO** の呼び出しであって、**request Worker → User Data DO** のこの経路を覆わない。SSO login（`:554`）とパスワードリセット完了（`consume-reset-token` の戻り値から `begin-credential-change` へ）も同じ形である。
  - 保証そのものは破れていない（Directory が返す `userId` はサーバーが過去に採番して永続化した値なので、外部入力ではない）。問題は **AC-12 が要求する「構造的な担保」の記述が、実際の経路を1つ数え落としている**ことで、#37 が第5.5節 1 をそのまま型・モジュール境界に落とすと login が書けなくなる（または場当たりに例外を空けて列挙が形骸化する）。
- 提案: 第5.5節 1 の列挙に「(iii) **Directory bucket の RPC 戻り値として得た `userId`**（login step 5 / credential 変更 phase 2 の起点）。Directory 側で永続化済みの `credential_mappings.userId` に由来し、その呼び出しの外部入力ではない」を足す。第5.2.2節 (a)(ii) も同様に3経路へ広げる。3経路すべてが「サーバーが採番し永続化した値」という共通性質を持つことを1行でまとめると、列挙が今後増えても保証の形が壊れない。

### **[W-002]** 第6.1節 (c) の「previous 世代の行への書き込みはローテーションによる削除だけ」が事実として誤り

- 場所: `.thread/34/design.md:631`
- 理由: B-001 の根本原因なので独立して立てる。第6.1節 (c) は「previous 世代にトゥームストーンを書く必要は無い。**previous 世代の行に対して起きる書き込みはローテーションによる削除だけであり**」を根拠に、世代跨ぎ検査を「読み1回」で足りると結論している。実際には previous 世代の行に対して、第6.5.1節 phase 1 / phase 3（credential 変更）、第5.3節 step 7（`failedAttempts` / `nextAttemptAllowedAt`）、第6.2.2節 (b)（`lastResetRequestedAt`）、第6.1節 (d)（リセットトークン行の発行）の書き込みが起きる。同節自身が「この窓は現実に数時間〜数日オーダーで開く」と見積もっているので、これらは例外ではない。
  - 「トゥームストーン不要」という**結論そのものは成立する** — previous への新規登録は起きず、すり抜けた競合は active 世代の一意制約が捕まえるからである。壊れているのは根拠の書き方だけである。
- 提案: 根拠を「previous 世代の行に**新しい canonical が登録されることは無い**（登録は常に active 世代）」に置き換える。既存行への更新が起きることは B-001 の提案と併せて明記する。

### **[W-003]** 第6.5.1節 phase 3 が `failedAttempts` をリセットする対象行と、rotation 中の所在がずれる

- 場所: `.thread/34/design.md:830`（第6.5.1節 phase 3）、`.thread/34/design.md:722`（第6.2.2節 (a) の脱出経路）
- 理由: 第6.2.2節 (a) は恒久 DoS を塞ぐ脱出経路として「**リセットの完走時に `failedAttempts` を0にし `nextAttemptAllowedAt` を過去へ戻す**（第6.5.1節 phase 3 の同じ `transactionSync`）」を挙げ、第6.9節の締め出し経路一覧 `:956` もこれを塞ぎ方として登録している。phase 3 は phase 1 と同じ bucket（`resume-credential-change` の所有 bucket）で走るが、B-001 のとおり移送が挟まると phase 3 の対象行がその bucket に無い。B-001 の提案2（pending 行を移送しない）を採れば自動的に解消するが、**採らない場合はこの脱出経路も同時に壊れる**ことを明示しておく必要がある。
- 提案: B-001 の提案2 を採る。採らない設計にする場合は、第6.2.2節 (a) の脱出経路 (i) に「ローテーション中は成立しない」という但し書きを付け、第6.9節の一覧にも反映する（＝脱出経路が実質 SSO 1本だけになるので、パスワード単独アカウントの恒久 DoS が残る）。

### **[W-004]** 第4.3節 行25b が引用しているポート署名が spec と食い違う

- 場所: `.thread/34/design.md:316`（第4.3節 行25b）
- 理由: 行25b は `DocumentRepository.deleteSourceLinksByMemo(memoId)` と書いているが、`spec/domains/knowledge.md:538` の実際の署名は `deleteSourceLinksByMemo(userId: UserId, memoId: MemoId): Promise<void>` である。同ファイル `:400` は「外部入力起点の ID を直接受ける書き込みメソッド（`deleteSourceLinksByMemo`）は `userId: UserId` を第一引数に取る」と**名指しで**規約に載せている。
  - 行き先（「User Data DO に閉じる」）と、行を足した理由（`ADP-knowledge-027` の契約が持つ「documents 側 JOIN でスコープする」規則ごと撤回される）は正しい。`:324` も「行25b は述語 (a) が文字どおりには発火しない」と正しく断っている。矛盾しているのは**表の中に書いた署名だけ**である。#35 は台帳と spec の両方を書き換える立場なので、署名の誤記は「`userId` 引数を落とす対象だった」と読み違える余地を作る。
- 提案: 行25b の署名を `deleteSourceLinksByMemo(userId, memoId)` に直す。第4.5節の読み替え（`userId` は DO 選択で消費される）で結局 `userId` は落ちるので、行き先の結論は変わらない。

### **[W-005]** design.md 内部の自己参照 `第6.5.1節 :690` が古い行を指している

- 場所: `.thread/34/design.md:644`
- 理由: 第6.1節 (d) が「第6.5.1節 `:690` の『別の `operationId` による変更依頼が `pending` 中に来た場合は後勝ち』という規則が、この上書きを設計として認めてしまっていた」と書いているが、`design.md:690` は第6.2.1節 (b-1) の再暗号化ジョブの行である。当該の後勝ち規則は `design.md:837` にある。改稿で節が動いたときの取り残しと思われる。
  - 本書は第1.1節 `:15` で「実参照は31節あるので個別列挙は古びる」と述べて**節番号ではなく節タイトルで指す**方針を採っており、行番号による自己参照はその方針からも外れている。
- 提案: `:690` を落として「第6.5.1節の後勝ち規則」とだけ書く。本書内の他の自己参照はすべて節番号で、行番号を使っているのはこの1箇所だけだった。

---

## Notes

### **[N-001]** Cloudflare 公式ドキュメントとの照合結果 — 第2.1節の事実表は原文どおり

実際に取得して逐語照合した。以下はすべて一致した。

- **#1** `/durable-objects/platform/limits/` — Paid 10 GB / Free 1 GB per SQLite-backed DO。`"database or disk is full: SQLITE_FULL"`、"Read operations (such as `SELECT` queries, `get()`, and `list()` calls) will continue to work, and `DELETE` operations will also succeed so that you can remove data to free up space." `:98` が指摘している「表と本文の公式内不整合」も現物で確認できた。
- **#2** `/durable-objects/api/alarms/` — "guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws"、"exponential backoff starting at a 2 second delay from the first failure with **up to 6 retries** allowed"、"If you call `setAlarm` when there is already one scheduled, it will override the existing alarm."
- **#3** alarms ページは duration / wall time を一切述べておらず、15分は limits ページの "Wall time limits by invocation type" にある — 第2.1節 `:67` の但し書きのとおりだった。
- **#4** "Each incoming HTTP request or WebSocket _message_ resets the remaining available CPU time to 30 seconds."、超過時は "heightened chance that the individual Durable Object is evicted and reset"。**#4b の「Alarm / RPC が列挙に含まれない」も原文で確認**（列挙は HTTP request と WebSocket message の2つだけ）。「未確認」ラベルは正しい。
- **#5** `idFromName` / `idFromString` / `newUniqueId` / `get` / `getByName` のいずれも列挙を提供しない。「記載の不在による」という但し書きも妥当。
- **#6** `/durable-objects/api/id/` — "Names longer than 1,024 bytes are not passed through to `ctx.id`."、"**Alarms created before 2026-03-15 do not have `name` stored.**"。日付まで一致。
- **#7 / #8 / #9 / #15** `/durable-objects/api/sqlite-storage-api/` — transactionSync の "should not be declared `async` nor otherwise return a Promise"、"`sql.exec()` cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`"、"it does not provide a stable snapshot of the query results"、"Writing data to SQLite virtual tables also counts towards rows written."
- **#10** 拡張として挙がっているのは **FTS5（`fts5vocab` を含む）/ JSON / 数学関数の3つだけ**で、`bm25` / `snippet` / `highlight` / trigram は同ページに一語も無い。第2.1節の記述どおり。
- **#16 / #17** LIKE / GLOB は 50 バイト。100列 / 2 MB / 100 KB / bind 100。
- **#19** "**JavaScript Errors with the property `.overloaded` set to True should not be retried.**"、"retrying will worsen the overload and increase the overall error rate."。第4.7節がこれを 429 / 503 ではなく 500 に倒した判断（`:375`）は原文の趣旨と整合する。
- **#20** PITR 30日、"not supported in local development because a durable log of data changes is not stored locally"。`ctx.abort()` も "not available in local development with the `wrangler dev` CLI command"。
- **#21** "A Worker configuration that contains both fields is rejected at validation."、"always use the SQLite storage backend"、"Storage type is immutable once a namespace exists."、"**There is no Trash** for Durable Object namespaces deleted through `exports`."
- **#22** "Unlike in Workers, `waitUntil` has no effect in Durable Objects."
- **#23** "there is a 30 second timeout applied when executing the callback. If this timeout is exceeded, the Durable Object will be reset."
- **#26** limits ページに結果セット合計サイズの項目は無い。「未確認」ラベルは正しい。
- **#28 / #29 / #30 / #31** — write buffer と "either all of the writes will have been stored to disk or none"、"Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."、**`setAlarm` の戻り値が alarms ページ `void` / storage-api ページ `Promise` で食い違っていること**、`sync()` の "Synchronizes any pending writes to disk… the returned promise will resolve when they complete" — 4件とも現物で確認した。第7.4節 `:1095-1097` の「先頭で `setAlarm` → `sync()` を待ってから仕事を始める」という結論は、この4件の組み合わせから正しく導かれている。**本設計で最も価値の高い導出だと思う。**

### **[N-002]** 第2.1節 #27 の裏付け種別が「公式記載」になっているが、`transaction()` のコールバックを `async` にできることは公式が肯定していない

- 場所: `.thread/34/design.md:92`
- `/durable-objects/api/sqlite-storage-api/` の `transaction()` 節にあるのは "Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically." だけで、コールバックが `async` でよいとは書いていない（"must complete synchronously" の一文は `transactionSync()` 側に付いており、`/durable-objects/api/storage-api/` の同節では `transaction()` にも同じ制約が読める書き方になっている）。#4b / #5 / #13 / #14 / #26 では「記載の不在」を丁寧にラベル分けしているので、ここだけ「公式記載」になっているのは基準がずれている。
- **結論には影響しない。** 第8.2.1節が (c) を棄却した根拠(1)〜(4) は「原子性の条件が `await` の不在側にある」という公式記載だけで完結しており、もし `transaction()` のコールバックも同期必須なら (c) はそもそも選択肢として存在しないので、棄却はより強くなる。種別欄を「未確認（記載の不在）」に直し、第8.2.1節に「仮にコールバックが同期必須なら (c) は選択肢ですらない」を1行足せば十分である。

### **[N-003]** 細かい引用のずれ2件

- `.thread/34/design.md:644` が `verifyAndConsume` の使い捨て性の出典を `spec/database/index.md:92` としているが、実際は `:90`（`:92` は「期限切れ行は pruner / 定期ジョブで削除してよい」）。同節が別の箇所で引いている `:79`（生トークンを保存しない理由）と `:77-101`（`user_id` 列と `prt_user_idx`）は正確だった。
- `.thread/34/design.md:1632`（第11.2節の削除対象）が「D1 前提の db 系7本」として `db:migrate:cf` / `db:apply:{local,staging,production}` / `db:execute:{local,staging,production}` を挙げ、これに委譲する `db:migrate` も道連れとしているが、実測の `db*` スクリプトは10本で、**`db:generate` / `db:generate:cf` の2本が列挙から漏れている**。`db:generate:cf` は drizzle の D1 向け生成なので `packages/core/src/adapters/d1/` の削除と同時に道連れになる。deploy 系24本（非 dry 12本）は完全に一致していた。

### **[N-004]** AC の検証結果

- **AC-4** — 第4章（User Data DO）・第5章（ルーティング）・第6章（Identity Directory DO）が揃い、`plan.md` の「design.md 構成案」が挙げた節にすべて本文がある。**充足。**
- **AC-11** — 第4.1節の対応表に Issue 列挙の7項目が7行として現れ、既存ドメイン集約と DO 内テーブル群の対応が取れている。**充足。** さらに第4.1.1節が「7項目には認証系が現れないので落ちている」という穴を自ら埋めているのは良い（ただし B-003）。
- **AC-12** — 第5.1節に session / token → `userId` → `idFromName` の一本道があり、第5.5節に5点の構造的担保がある。**充足だが W-001 の取りこぼしあり。**
- **AC-13** — 解決責務は (a)〜(d) が個別の結論として立っており（第6.1節）、分割方式は3案 × 4判断軸で (b) 固定 bucket を決め切っている（第6.2節。「単一グローバル DO を無条件採用」していない）。部分失敗（第6.4節）・冪等性（第6.5節）・SSO link / unlink（第6.6節）にも節がある。**構成としては充足。ただし B-001 / B-002 が「部分失敗」と「整合性」の中身に穴を残している。**
- **AC-15** — 第6.9節に「DO 間の分散トランザクションを一切前提としない」の宣言と、再開可能 saga + 冪等補償という代替がある。**充足。**
- **AC-22** — **主判定（台帳走査）を自分で再実行して検証した。** `spec/inventory/adapter.md` の `ADP-*` はユニーク85件（design.md `:328` が示すコマンドで再現）。第4.3節の表が引用している distinct な `ADP-*` は**ちょうど53件**で、**53件すべてが台帳に実在し、台帳側の未引用は32件**（85 = 53 + 32）。その32件（`ADP-identity-008/009`、`ADP-memo-005〜013` の残り、`ADP-knowledge-004〜008 / 012〜018 / 020/021 / 023〜026`、`ADP-trash-001〜003`）を1件ずつ spec の署名まで当たったところ、**全件が `userId` を第一引数に取る**（`spec/domains/memo.md:313` の `findTimelineAround(userId, ...)`、`spec/domains/knowledge.md:510/519/522/530` の `listSourceLinks*(userId, ...)`、`spec/domains/trash.md` の `listTrashItems(userId, ...)` ほか）。**第4.3節の「述語を当てた結果、上の表以外に漏れは無い」は成立している。件数（実行数35行 / distinct 53件 / 台帳85件 / 未引用32件）もすべて実測と一致した。** 3周にわたって拡大してきた棚卸しが、今回は機械的に再現可能な形で閉じている。**充足**（W-004 の署名誤記は行き先の結論に影響しない）。
- **AC-23** — (a) 第5.2.1節（正規化手順を順序まで確定、NFKC を local 部に掛けない理由、SMTPUTF8 非対応の宣言）、(b) 第5.2.2節（`userId` 由来は鍵非依存でローテーション対象外、credential 由来のみ対象）、(c) 第6.2.1節（保持場所・鍵の配布境界・世代管理・AES-256-GCM + AAD 束縛・復号許可4経路・退会時の消去範囲）、(d) 第5.2.5節（切り詰めは bucket index の導出だけ、識別は256ビット全長、2段構造）。**いずれも断定形で書かれており充足。** (b) の「鍵ローテーションの対象が credential 由来 locator に限られ、User Data DO の同一性に波及しない」も明示されている。

### **[N-005]** Account Home DO を採らない結論は成立している

第3.1節の3つの対価（protected request ごとの RPC 増、saga が跨ぐ DO の増加、retirement 証明の困難化）はいずれも具体的で、とくに3つ目（#19 のレビュー指摘 B-IDDS6-001 の1つ目の穴が Account Home の廃止で**構造的に消える**）は、代替案を採らないことが問題を1つ解消するという珍しい形の論拠になっている。

**成立の条件が明示されているのが良い。** 「権威をすべて `userId` で引ける場所に置く」を成り立たせているのは、第5.3節 step 5 (ii) の到達性検査（Directory に mapping が残っていても `credential_locators` に active 行が無ければ拒否）であり、第6.6節 `:878` がそれを「**Account Home を採らない設計の成立条件そのもの**」と名指ししている。到達性検査の権威が User Data DO 側に1系統だけ存在する構造は、第6.8節の retirement 証明とも整合している。第3.1節が「失うもの」を「Directory と User Data の両方が壊れたときに参照できる第3の非 PII 記録」だけと限定し、その役割を退会 tombstone で引き受けると書いているのも正確である。

### **[N-006]** 第6.2節の判断軸 (iv) を User Data DO にも当てて signup の phase 順を入れ替えた判断（`:666-670`）

分割方式を選ぶための軸を、選び終わった後に**別の namespace へ横展開して結論を1つ変えた**箇所である。「未認証の POST を N 回投げれば User Data DO が N 個生成される」「TTL 掃除が消せるのは `operations` 行であって生成された DO オブジェクトそのものではない（`hasStoredData` は残り、PITR の durable log も30日残る）」という指摘は、公式の PITR 記述（#20）を第6.2節の議論へ持ち込んだもので、根拠が自前の事実表の中で閉じている。第6.1節 (d) の範囲検査が「第6.2節 (b) の欄を真にする前提である」と明記されているのも同じ構造で、**判断軸が装飾ではなく実際に結論を動かしている**ことが追跡できる。

### **[N-007]** 「#37 が着手できない節」は残っていない

第11.4節の未決事項6行はすべて「決める主体 / いつ / 本設計への影響」が埋まっており、うち4行は「本設計への影響: **無い**」（設計がその事実に依存しないよう組んである）、2行は「決定は済んでいて値だけが2段階で決まる」である。第7.2.1節（検索 API 仕様）も「未決」ではなく #35 への明示的委譲として整理されている。**「後で決める」で終わっている節は見つからなかった。** 第1.3節が先行案10件 + レビュー指摘2件のすべてに採否を出し「保留はゼロ」としているのも確認した。
