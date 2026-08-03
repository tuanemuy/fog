# Adapter / Infrastructure（2周目）

PR #49 / base `main` / 契約 `.thread/37/plan.md` / 変更ファイル 248 件

1周目（`review-001-adapter-infra.md`）の B-001〜003 / W-001〜009 の修正を、`triage.md` と `.thread/37/adr.md`（ADR-042〜048 / 081）を突き合わせながら実装側で検証した。**12 件すべて解消しており、いずれも「宣言だけ直して実装が追いついていない」形にはなっていない。** 主要な修正には検証テストが付いており、ローカルで unit 510 / integration 175 / smoke 2 がすべて緑（コミットメッセージの申告と一致）。

その上で、修正の副作用として1件、修正が及ばなかった残りとして1件、および1周目が拾えていなかった投入点の欠落を1件見つけた。

---

## Blockers

### **[B-001]** `sweep-reset-tokens` を投入するコードが1行も無い — ハンドラは到達不能で、`password_reset_tokens` は永久に掃除されない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:45-71`（`issue`。enqueue しない）
  - `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:300-345`（`requestPasswordReset`。`send-mail` だけを enqueue する）
  - 対象コード: `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`（全体）
- 理由:
  `spec/database/index.md`:484 は `sweep-reset-tokens` の**投入点を「リセットトークン行を発行するのと同じトランザクション」と名指しで定義している。** しかし実装にその enqueue が無い。リポジトリ全体で `ctx.enqueueJob({ ... })` の呼び出しは4箇所（`sweep-reservations` / `resume-signup` / `send-mail` / `purge-trash`）＋ migration ゲートの `migrate-bulk` / `reindex` だけで、`sweep-reset-tokens` はどこからも投入されない（`grep -rn "enqueueJob({" packages/core/src apps/web/app -A2 | grep 'kind:'` が全数）。

  帰結は3つある。

  1. **`password_reset_tokens` の行が一切削除されない。** `issue` が消すのは「同一 `credential_id` の未使用行」だけなので、**消費済み行（`used_at` 非 NULL）と、別クレデンシャルの期限切れ行は誰も消さない。** Directory DO は **bucket 単位で多数のユーザーが相乗りする** DO であり、10 GB の上限も bucket 単位である。単調増加するテーブルを共有 DO に置いたまま出荷することになる。
  2. `prt_expires_idx`（`expires_at`）は、spec の索引表で用途欄が「`sweep-reset-tokens` の期限切れ行の掃除」1つだけの索引である。読み手が誰もいない索引が残る。
  3. `sweepResetTokens.ts` の JSDoc が主張する「駆動源を狭めると bearer credential が TTL を過ぎて生き残る」という防御は、**そもそもジョブが起動しないので何も防いでいない。** `directoryJobs.integration.test.ts` はハンドラを直接呼んでいるので、この欠落を検出できない（同ファイルの `sweep-reservations` は `reserveCredential` 経由の投入点を持つので、対称性で見落としやすい）。

  1周目の指摘（B-001）で `send-mail` の投入点と保持期間は精査されたが、同じ節の `sweep-reset-tokens` 行は見落とされている。修正コミットが `resetTokenStore.ts` を全面的に書き換えた（ADR-042）ので、いま入れるのが最も安い。
- 提案:
  `resetTokenStore.issue` は同期ポートで `enqueueJob` を持たないので、`facade.requestPasswordReset` の `eligible` 分岐の中（`ctx.resetTokenStore.issue(...)` の直後、同一 `run()` 内）で

  ```ts
  ctx.enqueueJob({
    kind: "sweep-reset-tokens",
    operationKey: "sweep-reset-tokens",     // bucket ごとの定数キー
    payload: {},
    nextRunAt: now + RESET_TOKEN_TTL_MS,    // 定数の置き場は要調整
  });
  ```

  を足す（`sweep-reservations` が `reserveCredential` で採っているのと同じ形。`sweep-reset-tokens` は再武装5種の1つなので、`done` 行は収束規則 (3) で復活し、以後は自走する）。**ただし投入を `eligible` 分岐に置くと4ケースの一様性（同じ行数・同じ `setAlarm`）が崩れる**ので、`send-mail` と同じく **`eligible` に関係なく無条件に投入する**のが正しい — 定数キーなので連打しても1行に収束し、`nextRunAt` は前倒し方向にしか動かない。統合テストは「トークンを発行したあとに `jobs` に `sweep-reset-tokens` 行が立つ」「Alarm を回すと期限切れ行が消える」の2本で足りる。

---

## Warnings

### **[W-001]** 窓を 15 分にしたことで、「リセットを恒久的に受け取れなくする」攻撃のコストが 15 分の1になった — しかも隣のメソッドは同じ穴を明示的に塞いでいる

- 場所:
  - `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts:299-316`（`recordResetRequested`。無条件）
  - `packages/core/src/domain/identity/credentialMappingRules.ts:76-87`（`isResetRequestAllowed`。sliding）
  - `packages/core/src/lib/jobBudgets.ts:52`（`RESET_REQUEST_WINDOW_MS = 15 * 60 * 1000`）
- 理由:
  `recordResetRequested` は**依頼のたびに無条件で** `last_reset_requested_at = now` を書く。`isResetRequestAllowed` は `last + window <= now` の sliding 判定である。したがって**窓より短い間隔で依頼を送り続けるかぎり、その宛先は永久に `eligible` にならない。**

  結果として、未認証の攻撃者が victim のアドレスに対して**窓より短い間隔（15 分未満）で `request-password-reset` を叩き続けるだけで、victim はパスワードリセットを永久に受け取れなくなる。** `send-mail` ジョブは走るが、有効なトークンが1つも無いので `token === null` で `done` に落ちる（`sendMail.ts:165-175`）。応答は一様なので、victim にもオペレーターにも「なぜ届かないか」は観測できない。

  これは ADR-043 以前から成立していた（旧 `RESET_THROTTLE_MS` は 60 秒）が、**窓を 15 分にしたことで攻撃コストが 1 req/min から 1 req/15min へ 15 倍安くなった。** ADR-043 の「トレードオフ」欄はこの点に触れていない。

  そして同じファイルの 30 行上、`reportResult` は**まったく同じ問題を認識して塞いでいる** — 「Attempts made while already throttled do not advance the counter — without that, an attacker refreshes the lockout indefinitely」。リセット側だけが逆の実装になっている。

  なお `recordResetRequested` を素朴に「`eligible` のときだけ書く」へ変えると **B-001（1周目）が再発する**ので、そこは選べない。反例: 発行が `t=0.5w`（窓0）→ `[w, 1.5w)` の依頼は非適格だが窓1の行を作る → `t=1.5w` の依頼は適格になり、新トークンを発行した上で窓1の `done` 行に衝突する。**無条件記録は ADR-043 の不変条件を支えている本体であって、消してよい行ではない。**
- 提案:
  適格判定を sliding から**窓（floor）判定**へ変えると、両立する。

  ```ts
  Math.floor(mapping.lastResetRequestedAt / windowMs) < Math.floor(now / windowMs)
  ```

  - ADR-043 の不変条件は保たれる — ある窓 k の**最初の**依頼は必ず適格（`last` は窓 k 未満）であり、そのとき窓 k の行はまだ存在しない。2回目以降は同じ窓なので非適格で、同じ行に収束する。
  - 攻撃者が叩き続けても、victim は**遅くとも次の窓境界で必ず1通受け取る**（その窓の最初の依頼が攻撃者のものなら、発行されたトークンのリンクは victim のアドレスへ届くので、victim は使える）。恒久ロックアウトが消える。
  - トレードオフ: 窓境界をまたいだ2依頼が実質同時でも新トークンが発行され、直前のリンクが失効する（現状は「同じ生きたリンクの再送」になる）。ADR-043 が既に窓境界での二重送信を許容しているので、性質としては同種である。

  採らない場合でも、**この恒久 DoS が既知のトレードオフであること**と、緩和が #18（レート制限）にあることを ADR-043 の「Consequences」と `jobBudgets.ts:37-52` の JSDoc に書き足すこと。今の JSDoc は「この等式が不変条件を厳密にする」としか書いておらず、代償に一言も触れていない。

### **[W-002]** 8つの書き込みのうち `beginChange` だけが CAS の一致行数を読まず、しかも書き直された JSDoc の分類表からも漏れている

- 場所: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts:196-214` / 契約側 `packages/core/src/domain/identity/ports/credentialMappingStore.ts:122-131`
- 理由:
  ADR-047 は `activate` / `promote` に `RETURNING 1` を入れ、`cancel` / `delete` / `reportResult` を「absent is success」として書き分けた。モジュール冒頭の JSDoc も「## Which ones read the match back, and why the others do not」という節を新設して、**読み戻す2つと読み戻さない3つを列挙している。**

  しかし `beginChange` はどちらの列挙にも入っていない。実装も素の `run(...)` で、`WHERE credential_id = ? AND change_state IS NULL` が 0 行にヒットしても黙って成功を返す。ポート側の JSDoc（`credentialMappingStore.ts:122-127`）も、`promote` が「a predicate that matches nothing raises `ConflictError`」と明記しているのに対し `beginChange` には何も書いていない。

  `change_state IS NULL` は**実際に外れうる述語**である（別の変更が飛行中）。そして `beginChange` は「この瞬間から旧材料では検証が通らない（fail closed）」という状態遷移の起点なので、0 行を成功として返せば「変更を開始したつもりで何も起きていない」状態がそのまま saga に流れる — W-001（1周目）が `activate` について指摘したのと**同一の形**である。

  今日は呼び出し元が無い（`begin-credential-change` は #12。`grep -rn "beginChange"` の一致は宣言2件のみ）ので実害は無いが、**「7つ／8つの書き込みはすべて CAS である」という全数主張を掲げているモジュールで、その主張から1つだけ静かに漏れている**のが問題である。#12 はこの契約を引き継ぐ。
- 提案:
  `promote` と同形にする（`RETURNING 1` + 0 行で `ConflictError`。コード名は `CREDENTIAL_CHANGE_ALREADY_IN_FLIGHT` あたり）。ポートの JSDoc にも `promote` と同じ一文を足す。実装を変えないなら、少なくとも**モジュール JSDoc の分類節に `beginChange` を第3の群として明示**し、「0 行は #12 が扱う」と書くこと — 今の書き方は「列挙が全数である」と読ませてしまう。

### **[W-003]** 全世代ファンアウト（1周目 W-009 の修正）で、ローテーション中に同一クレデンシャルの生きたリセットトークンが2つ並びうる — 「発行時に未使用行を全削除」は bucket 内でしか効かない

- 場所: `packages/core/src/application/identity/requestPasswordReset.ts:48-54` / `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:52-56`
- 理由:
  修正後の `requestPasswordReset` は `forCanonical` が返す**全 locator へ無条件に**依頼を投げる（一様性のために「ヒットしたところだけ」にしないという判断は正しい）。一方 `resetTokenStore.issue` の「同一 `credential_id` の未使用行を全削除する」は、当然ながら**その bucket の中でしか効かない。**

  ローテーションの移送中は、同じクレデンシャルが**旧世代と新世代の両方の bucket に active な mapping を持つ**（`adapters/cloudflare/directoryLocator.ts:26-35` が「during a rotation a credential legitimately has rows in two buckets」と明記している状態）。この状態でリセットを依頼すると、両 bucket がそれぞれ適格と判定してそれぞれトークンを発行し、**2通のメールが2つの別々の有効リンクを運ぶ。** 片方を消費してももう片方は TTL（2 時間）まで生き残る — `verifyAndConsume` は消費された bucket の行しか触らないためである。

  `resetTokenStore.ts:38-41` の JSDoc は「Issuing deletes every unused token for the same credential **in the same transaction**. Without that, an older link keeps working after the user has asked for a new one, **which is the whole reason the port says issuing is per credential rather than per request**」と書いている。ファンアウトを入れたことで、その性質が世代をまたぐと崩れる。移送そのものは #44 だが、**性質が崩れる形を作ったのは #37 のこの修正**であり、いまその事実がどこにも記録されていない。
- 提案:
  実装を変える必要はない（片方だけに投げると一様性が壊れる）。`requestPasswordReset.ts` の「## Every generation, not just the active one」節に、**「2世代が同時に active な mapping を持つ移送中は有効リンクが2本並びうる。`issue` の全削除は bucket スコープなので世代をまたがない。移送手順がその重なりをどう畳むかは #44 の担当である」**を1段落足し、#44 へ引き継ぐこと。`spec/database/index.md` の `password_reset_tokens` 節に同じ1行を置ければなお良い（spec は担当範囲外なら引き継ぎで可）。

---

## Notes

### **[N-001]** 3スイートともローカルで緑

`pnpm test:unit` 510 / `pnpm test:integration` 175 / `pnpm build && pnpm test:smoke` 2 をこの作業ツリーで実行し、すべて成功した。コミットメッセージの申告値と一致する。

### **[N-002]** ADR-043 の不変条件を手計算で検証した — `recordResetRequested` の無条件性が本体である

「適格 ⇒ `floor(now/w) > floor(last/w)` ⇒ その `operationKey` の行はまだ無い」は、`last_reset_requested_at` が**適格・非適格を問わず全依頼で前進する**ことに依存している。W-001 で書いたとおり、これを「適格時だけ」に変えると 1周目 B-001 が別の入口から再発する。`prune` 側も安全で、窓 k の行の `completed_at` は窓 k 内にあり、保持が窓と等しいので**そのキーがまだ要求されうる間に消えることはない**（境界も含めて確認した）。この非自明な結合を将来「無駄な UPDATE」として消されないよう、`recordResetRequested` の1行コメントを「retrying could hold the window open」ではなく「**この無条件性が `operationKey` の窓一意性を成立させている**」という向きで書き直しておくと安全である（現在の文言は理由が逆向きに読める）。

### **[N-003]** `alarm()` の1つの catch が握り潰しすぎていないことを、経路ごとに確認した

- 4段すべてが1つの `try` に入り、catch は `rearmAfterFailure`（共有ヘルパ）へ落ちる。`errorIdentity` でログし、`rearmFailClosed` を内側 `try` 付きで呼ぶので、再武装自体の失敗でも throw しない。
- `runOne` の終端書き込み（`poisonJob` / `failJob`）を非ガードにした判断は**正しい**。`UPDATE` を受け付けないストレージではキューの残りも前進できないので、その起床を止めるのが正しい形である。**しかも自己回復する** — 終端書き込みが落ちた行は `running` / `lease_until = now + 60s` のまま残るが、`settleAlarm` は走らないので `rearmBeforeWork` が置いた `now + MIN_RESUME_INTERVAL_MS`(60s) で起床し、その回は `lease_until < now` が等号で外れて拾えない。しかし `earliestNextRunAt` がその行の過去の `next_run_at` を拾い `clamp` が `now + 1s` に寄せるので、1秒後の起床で reclaim される。恒久停止はしない。
- 逆に「握り潰してはいけない失敗」— OCC 競合とジョブ固有のデータ起因の失敗 — は `runOne` の per-job catch が先に受けて `terminal_reason` / backoff に落とすので、`alarm()` の catch には**そもそも到達しない**。`alarm()` の catch に来るのはストレージ層とゲートの失敗だけであり、どちらも `poison` にすべきでない種類である。分類は妥当。
- 検証テスト（`alarmEntry.integration.test.ts` の "never throws out of alarm() when storage itself fails" と "does not delete its alarm when the schema is fail-closed"）は、後者に**陽性対照（正常系で `deleteAlarm` が1回）**を置いており、スパイが配線されていないだけの緑にならない形になっている。

### **[N-004]** `asPhrase` は FTS5 の構文として正しく、空フレーズも例外にならないことがテストで踏まれている

FTS5 の文字列リテラルは二重引用符で囲み、内部の `"` は重ねてエスケープする — `probe.ts:36-38` はその形である。trigram が3文字未満を索引しないため、2文字キーワードは**トークン0個のフレーズ**になるが、`tokenizer.integration.test.ts:118` の「matches nothing for a 2-character keyword」が `matchFts` 経由でその経路を実際に通しており、例外ではなく0件で返ることが固定されている。演算子8種のテストも「throw しないこと」を主張の中心に置いていて妥当。

### **[N-005]** `pruneCompleted` の `CASE` 順序が列挙オラクルを作らないことを確認した

`WHEN status = 'poison'` が `WHEN kind = 'send-mail'` より前にあるので、**poison になった `send-mail` 行だけは 30 日保持される。** これが「保持期間が結果に依存する＝オラクル」にならないのは、`sendMail` ハンドラが**宛先の有無では poison にならない**（`mapping === null` も `token === null` も `{ kind: "done" }`）ためである。poison になるのはプロバイダ障害と payload 破損だけで、どちらも宛先に依存しない。順序は意図どおりで問題ない。

### **[N-006]** `payloadDigest` の 128bit 化・安定 stringify は正しい

`stableJson` はキー順ソート・配列順保持・`undefined` の除去を行い、`JSON.stringify` の挿入順依存を断っている。4レーンは前方読み／後方読み／位置混合の3系統に分かれており、転置に対して1レーンが不変でも他が動く。`payloadDigest.test.ts` がキー順不変・配列順有意・幅32桁・転置分離・`null`/`undefined` 同一視を固定している。なお digest の入力（`payload`）は全経路でサーバー由来の平オブジェクトであり、攻撃者が2つの payload を選んで衝突させられる経路は無いので、非暗号学的であることは問題にならない。

### **[N-007]** 小さな死にコードが2件

`search/projection.ts:118-128` の `rebuildSearchEntry` は export されているが呼び出し元が無い（`reindex` は `upsertSearchEntry` を使う）。その JSDoc は「This is the chunked-`reindex` primitive: it assumes the index side was emptied beforehand」と、**実装されていない別の `reindex` 契約**を説明している。同様に `probe.ts:19` の `MIN_FTS_KEYWORD_LENGTH` も参照が無く、`matchFts` 自身は閾値を強制しない（呼び出し側の #10 が持つ前提）。あわせて `reindex.ts` の JSDoc は「leaves `search_entries` untouched」と書くが、`upsertSearchEntry` は `search_entries` に `ON CONFLICT DO UPDATE` を掛ける（値は同じなので実質不変だが、文は発行される）。どれも #10 が触る場所なので、削るか JSDoc を実態へ寄せるかは任意。

---

## 1回目指摘の修正検証

| ID | 判定 | 根拠 |
|---|---|---|
| **B-001** `SEND_MAIL_EMPTY_RETENTION_MS` が死にコード／再依頼が生きたリンクを壊す | **解消** | `RESET_REQUEST_WINDOW_MS` 1本が `operationKey` / `providerIdempotencyKey` / 発行スロットルの3つを決める（`facade.ts:307,335,342` / `jobBudgets.ts:52,63`）。`pruneCompleted` は `{done, poison, sendMail}` の種別別保持を取り、`send-mail` は結果によらず一律（`table.ts:364-399`）。不変条件を手計算で確認済み（N-002）。`sendMail.integration.test.ts` に「次の窓で必ず届く／同じ窓の2回目は生きたリンクを壊さない」の2本が入っている。**ただし副作用として W-001 が生じた。** |
| **B-002** `alarm()` から例外が逃げうる | **解消** | 両 DO クラスで4段が1つの `try`、catch は共有 `rearmAfterFailure`（`alarm.ts:131-148`）。再武装自体の失敗も内側 `try` で握る。`runOne` の終端書き込みを非ガードにした判断は正しく、恒久停止もしない（N-003 で経路を追った）。ストレージ throw の統合テストと fail-closed の `deleteAlarm` 陽性対照つきテストが追加されている。 |
| **B-003** リセットトークンの保存形式・FNV・3者の非合成 | **解消** | 導出鎖が `resetTokenCrypto.ts` の1本に閉じ、RPC エントリで `HMAC → SHA-256` まで済ませて同期ポートへ値渡し（ADR-036 と同型）。行に載るのは `token_id`（識別子）と `SHA-256(secret)` のみで、`token_id` を提出しても照合は成立しない。`activeResetTokenGeneration` の DI 経由が消え、DO コンストラクタが keyring を読まなくなった副次効果も良い。`resetToken.integration.test.ts` が「発行 → メールのリンク → 消費」を実 DO の RPC エントリ経由で通している。spec も同期済み。 |
| **W-001** `activate` / `promote` が一致行数を読まない | **解消（ただし残り1つ→ 本レビュー W-002）** | `activate` は read-then-CAS（`operationId` + 定数時間 `callerToken` + `candidateUserId`）＋ `RETURNING 1`、再実行の冪等性も明示。`promote` は `RETURNING 1` + `CREDENTIAL_CHANGE_NOT_ADVANCED`。`cancel` / `delete` / `reportResult` の「absent is success」も理由つきで書き分けられた。**`beginChange` だけが両方の列挙から漏れている。** |
| **W-002** `reindex` の射程が spec と食い違う | **解消** | ハンドラ JSDoc に「## Its reach is the tokenizer, not the normalisation rules」節、`spec/database/index.md`:707 にも1項追記済み。 |
| **W-003** `matchFts` がキーワードを素通し | **解消** | `asPhrase` でフレーズリテラル化。FTS5 の構文として正しく、空フレーズ経路もテストで踏まれている（N-004）。 |
| **W-004** 診断エントリが `sql/exec.ts` を迂回 | **解消** | `listBucketUserIds` が `all()` 経由になり、`limit` も `Math.max(1, Math.min(limit, 1000))` で有界化されている。「ゲートを通さないことと SQL ヘルパを通さないことは別」が JSDoc に明記された。 |
| **W-005** `payloadDigest` が 32bit・キー順依存 | **解消** | 安定 stringify + 4レーン 128bit + 純関数 unit テスト5本（N-006）。 |
| **W-006** 復活時に `provider_idempotency_key` を置換しない | **解消** | 収束規則 (2)(3) の両 `UPDATE` に `provider_idempotency_key = ?` が入った（`table.ts:130-167`）。 |
| **W-007** 実装済み性質の空 skip テスト | **解消** | `grep -rn "describe.skip\|it.skip\|test.skip" packages/core/src apps/web/app` が0件。 |
| **W-008** `guardStub` の JSDoc とコードが逆 | **解消** | 禁止事項が「`Reflect.apply` / `.call` / `.bind` を使わない」に書き直され、workerd 側の失敗メッセージまで理由として書かれている。 |
| **W-009** リセット依頼が active 世代しか見ない | **解消（副作用は本レビュー W-003）** | `for (const locator of ...)` で全世代へ**無条件に**投げる形になり、一様性も保たれている。unit テストあり。 |

**新たな問題を生んだもの:** B-001 の修正 → W-001（恒久 DoS のコストが 15 倍安くなった）、W-009 の修正 → W-003（移送中に有効リンクが2本並びうる。引き継ぎ記録が無い）。どちらも設計判断としては正しい方向で、記録と（W-001 は）判定式の1行変更で済む。

---

## カバレッジ

確認 **176** 件 / スキップ **72** 件 = **248** 件。

### スキップ（72）

**他観点の1周目レビュー成果物（5）** — `triage.md` で該当項目のみ参照
`.thread/37/review/review-001-domain-usecase.md`, `.../review-001-presentation-config.md`, `.../review-001-security.md`, `.../review-001-test.md`, `.../review-001.md`

**作業ログ・手順書（2）** — 判定の契約は `plan.md` の受け入れ基準に一本化
`.thread/37/steps.md`, `.thread/37/testing.md`

**利用者向けドキュメント（4）** — AC-20 の grep で機械的に確認済み／#38 の担当
`README.md`, `docs/backend_implementation_example.md`, `docs/runtime_cloudflare.md`, `docs/test.md`

**presentation 層（14）** — Presentation / Config 観点の担当
`apps/web/app/components/auth/LoginForm/action.ts`, `.../auth/SignupForm/action.ts`, `.../settings/CurrentUserPanel/index.tsx`, `.../settings/LogoutButton/action.ts`, `.../settings/SettingsSkeleton/index.tsx`, `apps/web/app/routes/_app/settings.tsx`, `apps/web/app/presentation/{authState,currentUser,errorResponse,session}.ts`, `apps/web/app/presentation/__tests__/{currentUser,errorResponse,errorResponseMiddleware,session}.test.ts`

**webcrypto（3）** — 逆流依存の解消（定数移動）のみ。DO / SQLite 観点に接しない
`packages/core/src/adapters/webcrypto/{hmacSessionCodec.ts,pbkdf2PasswordHasher.ts,__tests__/hmacSessionCodec.test.ts}`

**application の DI / 型・テストハーネス（10）** — Usecase / Security 観点の担当
`application/__tests__/helpers.ts`, `application/di/__tests__/noAdapterBackflow.test.ts`, `application/di/__tests__/requestContainerConfig.test.ts`, `application/di/__tests__/routingNonExposure.test.ts`, `application/di/__tests__/secrets.test.ts`, `application/di/__tests__/serverCloudflare.test.ts`(D), `application/di/containerStore.ts`, `application/di/types.ts`, `application/execution/__tests__/unitOfWork.typetest.ts`, `application/ports/idGenerator.ts`

**application identity の usecase 側（11）** — Domain / Usecase 観点の担当
`application/identity/__tests__/{eventDecoders.test.ts(D),identity.integration.test.ts,loginWithPassword.test.ts,logout.test.ts}`, `application/identity/{eventDecoders.ts(D),getCurrentUser.ts,loginWithPassword.ts,registerWithPassword.ts,view.ts}`, `application/ports/sessionCodec.ts`, `application/rpc/__tests__/restoreError.test.ts`

**domain 層（15）** — Domain 観点の担当（B-001 / W-002 の関係で `credentialMappingStore.ts` / `passwordResetTokenPort.ts` / `credentialMappingRules.ts` だけは確認側に置いた）
`domain/common/transactionalRepository.ts`, `domain/identity/__tests__/{credentialMappingRules,entity,noRawNul,valueObject}.test.ts`, `domain/identity/{entity.ts,errorCode.ts,valueObject.ts}`, `domain/identity/ports/{accountStore,credentialLocatorStore,credentialMappingRepository,mailSender,rotationCheckpointStore,userSettingsRepository}.ts`, `domain/identity/ports/userRepository.ts`(D)

**lib のうち定数移動のみ（2）**
`packages/core/src/lib/{passwordHashing.ts,secretLengths.ts}`

**spec のうち他観点の正本（6）**
`spec/domains/identity.md`, `spec/inventory/domain.md`, `spec/inventory/usecase.md`, `spec/manual-tests/search.md`, `spec/testcases/identity/unlinkSsoCredential.md`, `spec/usecases/identity.md`

### 確認（176）

上記スキップ 72 件を除く残り全件。内訳は次のとおり（7 + 1 + 20 + 4 + 7 + 39 + 43 + 29 + 12 + 3 + 6 + 2 + 3 = 176）。

**契約・ADR・CI（7）**
`.adr/001-integration-tests-single-workers-pool.md`, `.adr/003-sqlite-fts5-only-search.md`, `.github/workflows/ci.yml`, `.thread/37/adr.md`, `.thread/37/plan.md`, `.thread/37/review/review-001-adapter-infra.md`, `.thread/37/review/triage.md`

**規約（1）** `CLAUDE.md`

**Cloudflare 設定・エントリ・ビルド（20）**
`apps/web/.dev.vars.example`, `apps/web/__tests__/boot.smoke.test.ts`, `apps/web/app/server.cloudflare.ts`, `apps/web/app/worker/cloudflare/state.ts`, `apps/web/package.json`, `apps/web/scripts/render-wrangler.ts`, `apps/web/vite.config.cloudflare.ts`, `apps/web/vite.config.state.ts`, `apps/web/wrangler.toml`, `apps/web/wrangler.state.toml`, `apps/web/wrangler.request.{staging,production}.toml.tpl`, `apps/web/wrangler.state.{staging,production}.toml.tpl`, `apps/web/wrangler.{staging,production}.toml.tpl`(D), `apps/web/drizzle.config.ts`(D), `package.json`, `packages/core/package.json`, `pnpm-lock.yaml`

**Durable Object クラスとその統合テスト（4）**
`apps/web/app/durable-objects/{identityDirectory.ts,userData.ts}`, `apps/web/app/durable-objects/__tests__/{env.d.ts,rpcEntries.integration.test.ts}`

**Pulumi（7）**
`infra/cloudflare/pulumi/resources/{Pulumi.yaml,Pulumi.staging.yaml,Pulumi.production.yaml,index.ts}`, `infra/cloudflare/pulumi/routes/{Pulumi.yaml,Pulumi.staging.yaml,Pulumi.production.yaml}`

**旧 Worker / D1 / イベント機構の削除確認（39）**
`apps/web/app/worker/cloudflare/{consumer,dlq,handlers,pruner,relay}.ts`(D), `.../__tests__/{env.d.ts,handlers.integration.test.ts}`(D), `packages/core/src/adapters/d1/**`(D 20 件), `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`(D), `application/events/buildDecoder.ts`(D), `application/ports/{idempotencyStore,outboxRepository,relayTrigger}.ts`(D), `application/workers/**`(D 4 件), `application/di/env.ts`(D), `domain/common/event.ts`(D), `domain/identity/events.ts`(D)

**Cloudflare アダプター本体（43）**
`adapters/cloudflare/{directoryLocator,mailSender}.ts`,
`.../identityDirectory/{canonicalCipher,credentialMappingRepository,facade,mappingOperations,opaqueBinding,resetTokenCrypto,resetTokenStore,rotationCheckpointStore,unitOfWork}.ts`,
`.../jobs/{alarm,registry,runner,table}.ts`, `.../jobs/handlers/{migrateBulk,purgeTrash,reindex,resumeSignup,sendMail,sweepReservations,sweepResetTokens}.ts`,
`.../platform/{envelope,rpcEntry,stubErrors}.ts`,
`.../schema/{bulkSteps,gate,identityDirectory,jobsDdl,types,userData}.ts`,
`.../search/{normalize,probe,projection}.ts`, `.../sql/{errors,exec,occ}.ts`,
`.../userData/{accountStore,credentialLocatorStore,facade,trashQuery,unitOfWork,userSettingsRepository}.ts`

**Cloudflare アダプターのテスト（29）**
`adapters/cloudflare/__tests__/{alarmEntry,binding,cleanup}.integration.test.ts`, `.../__tests__/{directoryLocator.test.ts,doHarness.ts,env.d.ts,envelope.test.ts,forbiddenValues.ts,mailSender.test.ts,setup.ts,stubErrors.test.ts}`,
`.../identityDirectory/__tests__/{mappingOperations,resetToken,ssoResolution}.integration.test.ts`,
`.../jobs/__tests__/{alarm,directoryJobs,purgeTrash,runner,sendMail,table}.integration.test.ts`, `.../jobs/__tests__/{payloadDigest.test.ts,registry.test.ts,registry.typetest.ts}`,
`.../schema/__tests__/{gate,migration}.integration.test.ts`,
`.../search/__tests__/{normalize.test.ts,projection.integration.test.ts,tokenizer.integration.test.ts}`,
`.../userData/__tests__/occ.integration.test.ts`

**application 層のうち adapter / infra に接する部分（12）**
`application/di/{facades,secrets,serverCloudflare,stateCloudflare}.ts`, `application/di/__tests__/stateContainerConfig.test.ts`, `application/errors.ts`, `application/execution/{jobs,unitOfWork}.ts`, `application/identity/{requestPasswordReset,signupSaga}.ts`, `application/identity/__tests__/requestPasswordReset.test.ts`, `application/rpc/restoreError.ts`

**domain のうちアダプターが直接呼ぶ契約（3）**
`domain/identity/credentialMappingRules.ts`, `domain/identity/ports/credentialMappingStore.ts`, `domain/identity/ports/passwordResetTokenPort.ts`

**lib（6）**
`lib/{directoryLocator,errorIdentity,jobBudgets,jobKind,rpcEnvelope}.ts`, `lib/__tests__/jobKind.test.ts`

**spec（2）** `spec/database/index.md`（正典として該当節を再照合）, `spec/inventory/adapter.md`

**vitest 設定（3）** `vitest.config.ts`, `vitest.config.integration.ts`, `vitest.config.smoke.ts`
