# Adapter / Infrastructure（3周目）

PR #49 / base `main` / 契約 `.thread/37/plan.md` / 変更ファイル 259 件

2周目（`review-002-adapter-infra.md`）の B-001 / W-001〜003 と、`triage.md` が本観点に関係すると書いた ADR-090 / 091 / 092 / 093 / 094 / 110 を、実装側で1件ずつ検証した。**4件すべて解消しており、宣言だけ直った形は無い。** 副作用の新規混入も、投入点の追加・判定式の変更・キー導出の追加のいずれにも見つからなかった。

その上で、**マージを止めるほどではないが「設計として穴が残っている」ものを2件**挙げる。どちらも本 PR が新たに作ったものではなく、1周目 B-001 の修正で敷かれた不変条件と、DO 基盤の初回コミットから存在する Alarm 武装規則に属する。3周目の焦点は「マージしてよいか」なので、**Blocker は0件、判定は「可」**である。

---

## Blockers

なし。

---

## Warnings

### **[W-001]** `armAfterRpc` は既に張られた Alarm を**後ろへずらせる** — 毎秒1回以上 RPC が来る DO では due なジョブが永久に走らない

- 場所:
  - `packages/core/src/adapters/cloudflare/jobs/alarm.ts:31-33`（`clamp`）/ `:35-46`（`persist`）/ `:92-101`（`armAfterRpc`）
  - 呼び出し点: `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts:53`（**全ゲート付き RPC が必ず通る**）
- 理由:
  `armAfterRpc` は `persist(ctx, cache, clamp(now, earliest))` を呼ぶ。`clamp` は「すでに due なジョブ」を `now + 1000` に倒し、`persist` は `cache.scheduledAt !== at` なら **無条件に `setAlarm(at)` を発行する**。Durable Object の Alarm は1本しか無く `setAlarm` は既存を上書きするので、**この経路は Alarm を未来へ押し出す方向にも動く。**

  帰結: `next_run_at <= now` の行が1つでもある状態で、その DO へ **1秒より短い間隔で RPC が届き続けるかぎり、Alarm は毎回 `直近now + 1000` へ張り直され、一度も配信されない。** ジョブは `pending` のまま前進しない。

  ```
  t0      RPC → earliest=t0(due) → setAlarm(t0+1000)
  t0+0.5  RPC → earliest=t0(due) → setAlarm(t0+1500)   ← 前の武装は消える
  t0+1.2  RPC → earliest=t0(due) → setAlarm(t0+2200)
  ...
  ```

  Identity Directory は **bucket 単位で多数の利用者が相乗りする DO** であり、`lookupCredential` がログイン1回につき1本入る。bucket 数 256 のもとで全体 256 req/s のログインは bucket あたり 1 req/s に相当するので、到達しうるレートである。止まるのは `send-mail`（唯一の外部 I/O）と `resume-signup`（cross-DO saga の前進）で、どちらも「遅れてよい」種類ではない。負荷が下がれば自然回復するのでデータは失われないが、**「ジョブは高々1回の起床遅れで走る」という暗黙の前提は成立していない。**

  `settleAlarm` 側の `clamp` は正当である（`alarm()` の中から呼ばれるので、過去日時を張ると同じ起床が終わる前に再入する）。**`armAfterRpc` にはその再入の懸念が無く**、`clamp` はここでは 1 秒のデバウンスとしてしか働いていない。JSDoc（`alarm.ts:26-30`）も「re-enter before **this wake-up** has finished」と書いており、RPC 経路の説明にはなっていない。

  なお、この形は「1周目 W-006 / AC-12 (iv)」が固定した *`jobs` 行の* 単調性（`nextRunAt` は前倒し方向にしか動かない）とは**別の層**であり、行の側が単調でも Alarm の側は単調でない。テストも `jobs/__tests__/alarm.integration.test.ts` の「the RPC entry wrapper」4本を含めて、**RPC を2回続けて叩いたときに武装時刻が後退しないこと**を主張していない。
- 提案:
  `armAfterRpc` を「前倒し専用」にする。1行で足りる。

  ```ts
  export async function armAfterRpc(ctx, sql, now, cache): Promise<void> {
    const earliest = earliestNextRunAt(sql);
    if (earliest === null) return;
    const at = clamp(now, earliest);
    // 既に張られている武装より後ろへは動かさない。RPC が毎秒来る DO で
    // due な行が永久に走らなくなるのを防ぐ。
    if (cache.scheduledAt !== null && cache.scheduledAt <= at) return;
    await persist(ctx, cache, at);
  }
  ```

  `cache.scheduledAt` はインスタンス状態なので、インスタンスが作り直された直後は `null` になり必ず1回張る（安全側）。`settleAlarm` / `rearmBeforeWork` / `rearmFailClosed` は現状のままでよい — 前2つは正確な値を書き、最後は fail-closed の固定間隔である。検証テストは「同じ bucket へ RPC を2回叩き、2回目の `setAlarm` 引数が1回目以下であること」の1本で足りる（`alarm.integration.test.ts` の `describe("the RPC entry wrapper")` に置ける）。

  **本 PR で直さない場合は #38（運用値・可観測性）へ明示的に引き継ぐこと。** 現状はこの性質がコード・ADR・spec のどこにも書かれておらず、次に `armAfterRpc` を読む人が「Alarm も前倒し専用だ」と誤読する形になっている。

### **[W-002]** 「適格な依頼は必ず未使用の `operationKey` に着地する」不変条件は、**写像行が生まれた瞬間だけ破れる** — 未登録アドレスへの依頼が残した `done` 行に、同じ窓の登録直後の依頼が衝突して無言でメールが出ない

- 場所:
  - `packages/core/src/lib/jobBudgets.ts:48-52`（不変条件の宣言）/ `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:286-300`（同）
  - 破れる箇所: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts:74-92`（`reserve` の `INSERT` が `last_reset_requested_at` に **NULL** を入れる）
  - 判定側: `packages/core/src/domain/identity/credentialMappingRules.ts:103-107`（`lastResetRequestedAt === null` は無条件に適格）
- 理由:
  ADR-043 / ADR-091 の不変条件は「`last_reset_requested_at` が**全依頼で**前進する」ことに依存している。しかし前進するのは行が存在するときだけで、**行が無い間の依頼は何も残さない。** 一方 `send-mail` 行は「写像の有無にかかわらず必ず1行書く」（列挙オラクル対策・spec:480）ので、**未登録アドレスへの依頼も `send-mail:{kind}:{H}:{k}` を作る。** その行は `mapping === null` で `{ kind: "done" }` に落ち（`handlers/sendMail.ts:150-160`）、`SEND_MAIL_RETENTION_MS`（= 窓）ぶん残る。

  したがって次の順序が同一窓 k の中で起きると破れる。

  1. アドレス A が未登録の状態でリセット依頼 → `send-mail:email:H:k` が作られ、走って `done`
  2. A が signup（`reserve` が写像行を作る。`last_reset_requested_at` は **NULL**）
  3. A へリセット依頼 → `last` が NULL なので**適格** → トークンを発行 → `enqueueJob("send-mail:email:H:k")`
  4. 収束規則 (3) は `send-mail` を再武装種に含めないので **`done` 行は復活せず、何も書かずに成功が返る**（`jobs/table.ts:151-153`）

  結果、**トークンは発行されたのに配送ジョブが立たず、利用者はその窓の残り（最大15分）リンクを受け取れない。** 1周目 B-001 が塞いだのと同じ失敗の形が、別の入口から1窓ぶんだけ残っている。破壊されるのは「生きたリンク」ではない（この経路には先行トークンが無い）ので被害は遅延に限られ、次の窓で自然回復する。写像行を削除して同じ窓で作り直す経路（`cancel` / `delete`）も同型である。

  重いのは挙動そのものより**宣言との食い違い**で、`jobBudgets.ts:48-52` は「the row it enqueues is always one no earlier request could have created」と**全称で**書いており、`mappingOperations.ts:318-330` の長いコメントも同じ強さで書いている。#12（リセット完了）と #44（ローテーション）はこの宣言を前提に読む。
- 提案:
  `reserve` の `INSERT` で `last_reset_requested_at` に **NULL ではなく `timestamp`（= その行の `created_at`）** を入れる。1バインドの変更で不変条件が全称に戻る。

  - 写像が窓 k で生まれたなら、最初に適格になりうるのは窓 k+1 以降である。窓 k+1 に先行する依頼があればその依頼が `last` を k+1 へ進めるので現在の依頼は非適格になり、**適格な依頼はやはり必ずその窓の最初の1件**になる。行の削除→再作成も同様に閉じる。
  - `isResetRequestAllowed` の `lastResetRequestedAt === null` 分岐は残してよい（既存行の後方互換）。
  - 副作用は「登録直後の窓ではリセット依頼が適格にならない」だけで、4ケースの一様性（行数・`next_run_at`・応答）には触れない — 非適格ケースは既に `sendMail.integration.test.ts` の `throttled` が固定している。
  - 検証は「未登録で依頼 → 登録 → 同じ窓で依頼 → `send-mail` 行が1本で `pending`、`drain` で受信者1件」の1本。

  採らない場合は、`jobBudgets.ts` / `facade.ts` / `mappingOperations.ts` の3箇所の断定に**「写像行が存在する間に限る」という限定を明記**し、`spec/database/index.md#password_reset_tokens` に1行残すこと。今の書き方は全称に読めるので、#12 が前提として引き継いでしまう。

---

## Notes

### **[N-001]** 検証の実行結果 — unit / typecheck は緑。統合スイートは**別エージェントの未コミット実験が作業ツリーに載っている**ため清浄な全量実行ができなかった

- `pnpm test:unit` → **36 files / 525 tests 緑**。
- `pnpm typecheck` → 3プロジェクトとも緑。
- `pnpm test:integration` の全量は **6 failed**。ただし原因は本 PR ではない — レビュー中に `git status` / `git diff` を取ったところ、作業ツリーに次の**未コミット変更**が載っていた（`ps` で別プロセスの `vitest run --config vitest.config.integration.ts ... alarmEntry.integration.test.ts` が同時に走っていたので、テスト観点の並行レビューによる ADR-110 の陰性対照実験と判断した）。

  ```
   M packages/core/src/adapters/cloudflare/__tests__/doHarness.ts          ← disarm() を no-op に潰す
   M .../__tests__/alarmEntry.integration.test.ts                          ← RPC 後に 2000ms 注入
   M .../identityDirectory/__tests__/resetToken.integration.test.ts        ← 同上
   M .../application/identity/__tests__/identity.integration.test.ts       ← 同上
  ```

  落ちた3ファイルは ADR-110 が「`disarm` を no-op へ潰すと同じ遅延で**3本が赤**」と申告した集合と**完全に一致する**ので、この実行は本 PR の赤ではなく、ADR-110 の陰性対照が再現したものである（結果的に ADR-110 の主張の裏取りになっている）。
- 作業ツリーを壊さないため stash / checkout はせず、**未変更のファイル群だけを対象に統合スイートを実行した** — `jobs/` `schema/` `search/` `userData/` `apps/web/app/durable-objects/` で **12 files / 130 tests 緑**（B-001 の修正を検証する `sendMail.integration.test.ts` の "arms the sweep that eventually clears the rows this path writes" と、ADR-092 のキー検証、`alarm.integration.test.ts` の RPC エントリ4本を含む）。
- **マージ前に、清浄なツリーで `pnpm test:integration` を1回通すこと。** AC-29 の確認はそこで完結する。本レビューはコミット済み HEAD の内容を `git diff origin/main...HEAD` で読んで判断しており、上記の赤はその判断に影響しない。

### **[N-002]** ADR-110 の**プロダクション側の設計**は妥当 — テストが苦労していたのは「観測者が2人いた」ことであって、設計の匂いではない（ただし W-001 は別）

依頼された観点なので明示的に書く。

- 「RPC の後に必ず Alarm を張る」ことは**必須**である。RPC の中で `enqueueJob` された行を走らせる駆動源は他に無く、これを外すと「次に誰かがこの DO を叩くまでメールが出ない」になる。`runRpcEntry` が**失敗経路でも張る**判断（コミット済みトランザクションの後に throw しうる）も正しい。
- 「due な行を `now + 1000` に倒す」ことも、RPC 応答を返してから走らせるという意味では妥当で、パスワードリセットメールの1秒遅延は許容範囲である。
- テスト側が苦労していたのは、**同じキューに「テストが手で回す `alarm()`」と「プラットフォームが配信する `alarm()`」の2人の駆動者が居た**ためで、これは Alarm 駆動の実行機構を実ランタイムで検証する以上、設計を変えても消えない。「武装を残さない」を規則にした `disarm(stub)` は正しい方向の解であり、**主題が武装そのもののスイート（`jobs/__tests__/alarm.integration.test.ts`）では使えない**という境界まで JSDoc に書いてある点も良い。
- 唯一の設計上の欠けは、**その武装が単調でない**ことである（W-001）。これは「RPC 後に張る」形そのものの問題ではなく、`persist` に方向の条件が無いことの問題なので、規則を捨てずに直せる。

### **[N-003]** ADR-090 は列挙オラクルを壊していない — 4ケースの一様性は**2行に拡張された上で**固定されている

- 投入は `run()` の中で `eligible` を見ずに実行される（`facade.ts:352-361`）。定数キー `"sweep-reset-tokens"` / `payload: {}` なので `payloadDigest` は常に同一で、`JOB_PAYLOAD_MISMATCH` は起きない。
- 収束の向きも正しい。`nextRunAt = now + RESET_TOKEN_TTL_MS` は依頼が新しいほど**大きくなる**ので、既に `pending` の行は規則 (1) の `next_run_at <= args.nextRunAt` で**触られない**（`table.ts:183-185`）。`done` に落ちていれば規則 (3) が復活させる — `sweep-reset-tokens` は再武装5種の1つ（`lib/jobKind.ts:78-84`、spec:458 と一致）。
- 一様性テストが `kinds` / `status` / `nextRunAt` / `sweepNextRunAt` の4項目を4ケースで突き合わせる形に書き直されており（`sendMail.integration.test.ts:359-380`）、**「掃除の投入の有無が答えになる」形を明示的に排除している**。AC-11 の文面は「ジョブ行1行」だが、`spec/database/index.md`:480 が全数で定義しているのは `send-mail` の投入点であり、そちらは1行のままなので齟齬はない。
- 「バケットがリセット依頼を捌くとアラームが張られたままになる」影響は**有界**である。掃除は class (A) で `min(expires_at)` から自走し、行が尽きたところで `done` → `settleAlarm` が `deleteAlarm()` する。空 bucket に1件依頼が来ただけの場合でも、2時間後の起床1回で `done` に落ちて終わる。「1依頼あたり `jobs` 行が1→2」も定数キーゆえ bucket あたり1行で、依頼数には比例しない。ADR-090 の記述どおり。

### **[N-004]** ADR-091 の窓一意性は（W-002 の1点を除いて）保たれている — 境界の挙動も手計算で確認した

- `recordResetRequested` は `if (mapping !== null)` ガードが外れて**無条件1文**になり（`facade.ts:341`）、実行される文の数が登録の有無に依存しなくなった。未登録アドレスは `WHERE` が0行に当たるだけで、これは `mappingOperations.ts` の「absent is success」群として JSDoc の分類節にも追加されている。
- 判定は `Math.floor(last / w) < Math.floor(now / w)`。窓 k の**最初の**依頼は `last` が窓 k 未満なので必ず適格、2件目以降は同じ窓で非適格。したがって適格な依頼の `operationKey` の窓番号は、それ以前のどの依頼の窓番号よりも真に大きい。
- 恒久ロックアウトは消えた。誰が叩いても「その窓の最初の1回」は通るので、登録済みアドレスには窓あたり1通が必ず届く。`reportResult` 側の同型の防御と向きが揃った。
- 境界: `last = 窓末尾 - 1ms` → 次窓の最初の依頼が適格（`credentialMappingRules.test.ts` の2本が固定）。`throttled` ケースの `last = NOW` は `floor(NOW/w) < floor(NOW/w)` が偽で非適格。どちらも意図どおり。
- `pruneCompleted` 側も安全 — 窓 k の `send-mail` 行の `completed_at` は窓 k 内にあり、保持が窓と等しいので「まだそのキーが要求されうる間に消える」ことはない。

### **[N-005]** ADR-092 の冪等性は壊れていない

- `operationKey` の組み立て（`sendMailOperationKey`）と `SHA-256`（`deriveProviderIdempotencyKey`）が `identityDirectory/resetRequestKeys.ts` の2関数に閉じ、**DO の RPC エントリと facade が同じ関数を読む**。エントリは `const now = this.now()` を1回だけ読んで両方へ渡す（`apps/web/app/durable-objects/identityDirectory.ts:194-224`）ので、キーと `operation_key` が別の窓に落ちる経路が無い。
- 決定性は保たれる — 同一行の再配送は同じ `operationKey` を読み直すので同じキー、新しい窓は新しい `operationKey` なので新しいキー。収束規則 (2)(3) の `UPDATE` も `provider_idempotency_key = ?` を書き直す（1周目 W-006 の修正が生きている）。
- フォールバック `?? row.operation_key` が落ち、NULL は `terminal(SEND_MAIL_IDEMPOTENCY_KEY_MISSING)`。`send-mail` の投入点は1つで必ず埋めるので、NULL は「別の何かが書いた行」であり拒否が正しい。
- テストが値の一致だけでなく **`not.toContain(hmac)` と `/^[0-9a-f]{64}$/`** を見ているので、実装を素通しに戻すと赤になる。spec:442 も同期済み。

### **[N-006]** ADR-093 / ADR-094 は実装・契約・テストの3点が揃っている

- `beginChange` は `RETURNING 1` + 0行で `ConflictError("CREDENTIAL_CHANGE_NOT_STARTABLE")`（`mappingOperations.ts:212-230`）。理由で割らない判断（`notActivatable()` と同じく bucket の中身を報告しない）は妥当で、細分化を #12 へ残した点も適切。モジュール JSDoc の分類節が **8つ全数**（読み戻す3 / absent is success の4 / `reserve` の1）へ書き直され、「列挙が全数である」と読める形が実際に全数になった。ポート側 JSDoc にも同趣旨が入っている。統合テスト3本（開始できる / 飛行中は拒否して先行の `pending_verifier` を壊さない / 存在しない credential も同じ答え）。
- `parseResetToken(token, routing)` は必須引数で、宣言に無い `generation` と `bucket >= bucketCount` を `null` に落とす（`resetTokenCrypto.ts:190-201`）。正規表現が `\d+` なので負値は入らず、巨大値は `find` で外れる。応答は既存の「解析不能＝未知」に均されているので観測は増えない。テストは拒否3ケース＋**陽性対照2本**（`1.1023.<secret>` と元リンク）を持つので、`return null` を無条件化する変異では緑にならない。

### **[N-007]** `sweep-reset-tokens` の初回起床が境界ちょうどだと無害な `logger.warn` を1回出す

投入は `nextRunAt = now + RESET_TOKEN_TTL_MS`、トークンの `expires_at` も `now + RESET_TOKEN_TTL_MS`。プラットフォームが厳密にその時刻で配信すると `expires_at < now` が偽になり、`swept === 0 && earliest <= now` の枝に入って「clamping the re-arm」を warn し、60秒後に片付ける（`handlers/sweepResetTokens.ts:58-63`）。実際の Alarm 配信は通常わずかに遅れるので日常的には起きないが、起きたときの警告文は「駆動源が壊れている」ようにも読める。#38 の可観測性の作業で、境界一致だけは `debug` へ落とすか文言を分けると運用ノイズが減る。挙動そのものは正しい（有界・自己回復）。

### **[N-008]** 2周目 W-003（ローテーション中に有効リンクが2本並ぶ）の引き継ぎは、コードと spec の両方に入った

`application/identity/requestPasswordReset.ts` に「## Handoff to #44」の段落、`resetTokenStore.ts` の JSDoc に「全削除の射程は bucket 内」、`spec/database/index.md`:665 に同趣旨。実装を変えない判断（ヒットした bucket だけに投げると一様性が壊れる）も引き継ぎ先（#44）も、2周目の提案どおり。

---

## 2回目指摘の修正検証

| ID | 判定 | 根拠 |
|---|---|---|
| **B-001** `sweep-reset-tokens` の投入点が無くハンドラが到達不能 | **解消** | `facade.requestPasswordReset` の `run()` 内で `send-mail` と並べて**無条件に**投入（定数キー・`nextRunAt = now + RESET_TOKEN_TTL_MS`）。`RESET_TOKEN_TTL_MS` は `lib/jobBudgets.ts` へ移り、`facade → resetTokenStore` の value import を作らずに共有できている。検証は**投入経路を通す**統合テスト（`sendMail.integration.test.ts` の "arms the sweep …"：依頼 → 配送 → 消費済みへ書き換え → TTL 経過後の起床 → 行0件）で、ハンドラ直呼びではない。`armed[0].next_run_at` の値まで assert している。4ケース一様性テストも2行に拡張済み（N-003）。spec:665-666 / :480 / :458 と一致。 |
| **W-001** 窓を 15 分にしたことで恒久ロックアウトのコストが 15 倍安くなった | **解消** | 判定式を `floor(last/w) < floor(now/w)` へ（`credentialMappingRules.ts:103-107`）。無条件記録は不変条件の本体なので残し、`mappingOperations.ts:318-330` のコメントを「この無条件性が窓一意性を成立させている」向きへ書き直した（2周目 N-002 の指摘どおり）。`facade` の `if (mapping !== null)` ガードも外れ、文の数が登録の有無に依存しなくなった。境界2本の unit テストあり（N-004）。**ただし不変条件そのものに写像行の生成をまたぐ穴が残る → 本レビュー W-002。** |
| **W-002** 8つの書き込みのうち `beginChange` だけが CAS の一致行数を読まない | **解消** | `RETURNING 1` + 0行で `ConflictError("CREDENTIAL_CHANGE_NOT_STARTABLE")`。分類節が8つ全数へ、ポート JSDoc にも追記。統合テスト3本（N-006）。コードを `..._ALREADY_IN_FLIGHT` に割らなかった理由（bucket の中身を報告しない）は `notActivatable()` と一貫していて妥当。 |
| **W-003** ローテーション中に有効リンクが2本並ぶ（記録が無い） | **解消（記録のみ・提案どおり）** | 実装変更なし。usecase / アダプター / spec の3箇所に引き継ぎが入った（N-008）。 |

**新たな問題を生んだもの: なし。** 3つの実装変更（無条件 enqueue / floor 判定 / SHA-256 導出）はいずれも一様性・冪等性・収束規則を壊していないことを、コードと統合テストの両側で確認した。本レビューの W-001 / W-002 は、どちらも**2周目の修正が触っていない層**（Alarm 武装規則と `reserve` の `INSERT`）に元からあったものである。

---

## カバレッジ

確認 **178** 件 / スキップ **81** 件 = **259** 件。

2周目からの増分は11件（`.adr/008` / 2周目レビュー成果物6件 / `ErrorSurface` / `errorResponseMiddleware.ts` / `_app.tsx` / `resetRequestKeys.ts`）で、うち確認2・スキップ9。それ以外の248件の内訳は `review-002-adapter-infra.md`「カバレッジ」節と同一である。**3周目の読み方**: `b1caa65..HEAD`（2周目指摘の修正コミット2本）で実際に動いた54ファイルは差分を全文で読み、それ以外は2周目の確認結果を前提に、B-001 / W-001〜003 と ADR-090〜094 / 110 が触る依存先（`jobs/table.ts` / `jobs/alarm.ts` / `platform/rpcEntry.ts` / `schema/identityDirectory.ts` / `handlers/sweepResetTokens.ts` / `lib/jobKind.ts` / `spec/database/index.md`）を再照合した。

### スキップ（81）

**他観点のレビュー成果物（10）** — `triage.md` で該当項目のみ参照
`.thread/37/review/review-001-{domain-usecase,presentation-config,security,test}.md`, `.../review-001.md`, `.../review-002-{domain-usecase,presentation-config,security,test}.md`, `.../review-002.md`

**作業ログ・手順書（2）** — 判定の契約は `plan.md` の受け入れ基準に一本化
`.thread/37/steps.md`, `.thread/37/testing.md`

**利用者向けドキュメント（4）** — AC-20 の grep で機械的に確認済み／#38 の担当
`README.md`, `docs/backend_implementation_example.md`, `docs/runtime_cloudflare.md`, `docs/test.md`

**ADR の書き戻し（1）** — Domain / Usecase 観点の担当
`.adr/008-identity-split-and-non-aggregate-stores.md`

**presentation 層（17）** — Presentation / Config 観点の担当
`apps/web/app/components/auth/{LoginForm,SignupForm}/action.ts`, `.../settings/CurrentUserPanel/index.tsx`, `.../settings/LogoutButton/action.ts`, `.../settings/SettingsSkeleton/index.tsx`, `.../ui/ErrorSurface/index.tsx`, `apps/web/app/routes/_app.tsx`, `apps/web/app/routes/_app/settings.tsx`, `apps/web/app/presentation/{authState,currentUser,errorResponse,errorResponseMiddleware,session}.ts`, `apps/web/app/presentation/__tests__/{currentUser,errorResponse,errorResponseMiddleware,session}.test.ts`

**webcrypto（3）** — 逆流依存の解消（定数移動）のみ。DO / SQLite 観点に接しない
`packages/core/src/adapters/webcrypto/{hmacSessionCodec.ts,pbkdf2PasswordHasher.ts,__tests__/hmacSessionCodec.test.ts}`

**application の DI / 型・テストハーネス（10）** — Usecase / Security 観点の担当
`application/__tests__/helpers.ts`, `application/di/__tests__/{noAdapterBackflow,requestContainerConfig,routingNonExposure,secrets,serverCloudflare(D)}.test.ts`, `application/di/{containerStore,types}.ts`, `application/execution/__tests__/unitOfWork.typetest.ts`, `application/ports/idGenerator.ts`

**application identity の usecase 側（11）** — Domain / Usecase 観点の担当
`application/identity/__tests__/{eventDecoders(D),identity.integration,loginWithPassword,logout}.test.ts`, `application/identity/{eventDecoders(D),getCurrentUser,loginWithPassword,registerWithPassword,view}.ts`, `application/ports/sessionCodec.ts`, `application/rpc/__tests__/restoreError.test.ts`

**domain 層（15）** — Domain 観点の担当（W-002 の関係で `credentialMappingRules.ts` / `credentialMappingStore.ts` / `passwordResetTokenPort.ts` は確認側）
`domain/common/transactionalRepository.ts`, `domain/identity/__tests__/{credentialMappingRules,entity,noRawNul,valueObject}.test.ts`, `domain/identity/{entity,errorCode,valueObject}.ts`, `domain/identity/ports/{accountStore,credentialLocatorStore,credentialMappingRepository,mailSender,rotationCheckpointStore,userSettingsRepository,userRepository(D)}.ts`

**lib のうち定数移動のみ（2）**
`packages/core/src/lib/{passwordHashing.ts,secretLengths.ts}`

**spec のうち他観点の正本（6）**
`spec/domains/identity.md`, `spec/inventory/{domain,usecase}.md`, `spec/manual-tests/search.md`, `spec/testcases/identity/unlinkSsoCredential.md`, `spec/usecases/identity.md`

### 確認（178）

上記スキップ81件を除く残り全件。2周目の176件に `.thread/37/review/review-002-adapter-infra.md` と `packages/core/src/adapters/cloudflare/identityDirectory/resetRequestKeys.ts` を加えたもの。内訳は次のとおり（8 + 1 + 20 + 4 + 7 + 39 + 44 + 29 + 12 + 3 + 6 + 2 + 3 = 178）。

**契約・ADR・CI（8）**
`.adr/001-integration-tests-single-workers-pool.md`, `.adr/003-sqlite-fts5-only-search.md`, `.github/workflows/ci.yml`, `.thread/37/adr.md`, `.thread/37/plan.md`, `.thread/37/review/review-001-adapter-infra.md`, `.thread/37/review/review-002-adapter-infra.md`, `.thread/37/review/triage.md`

**規約（1）** `CLAUDE.md`

**Cloudflare 設定・エントリ・ビルド（20）**
`apps/web/.dev.vars.example`, `apps/web/__tests__/boot.smoke.test.ts`, `apps/web/app/server.cloudflare.ts`, `apps/web/app/worker/cloudflare/state.ts`, `apps/web/package.json`, `apps/web/scripts/render-wrangler.ts`, `apps/web/vite.config.cloudflare.ts`, `apps/web/vite.config.state.ts`, `apps/web/wrangler.toml`, `apps/web/wrangler.state.toml`, `apps/web/wrangler.request.{staging,production}.toml.tpl`, `apps/web/wrangler.state.{staging,production}.toml.tpl`, `apps/web/wrangler.{staging,production}.toml.tpl`(D), `apps/web/drizzle.config.ts`(D), `package.json`, `packages/core/package.json`, `pnpm-lock.yaml`

**Durable Object クラスとその統合テスト（4）**
`apps/web/app/durable-objects/{identityDirectory.ts,userData.ts}`, `apps/web/app/durable-objects/__tests__/{env.d.ts,rpcEntries.integration.test.ts}`

**Pulumi（7）**
`infra/cloudflare/pulumi/resources/{Pulumi.yaml,Pulumi.staging.yaml,Pulumi.production.yaml,index.ts}`, `infra/cloudflare/pulumi/routes/{Pulumi.yaml,Pulumi.staging.yaml,Pulumi.production.yaml}`

**旧 Worker / D1 / イベント機構の削除確認（39）**
`apps/web/app/worker/cloudflare/{consumer,dlq,handlers,pruner,relay}.ts`(D), `.../__tests__/{env.d.ts,handlers.integration.test.ts}`(D), `packages/core/src/adapters/d1/**`(D 20 件), `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`(D), `application/events/buildDecoder.ts`(D), `application/ports/{idempotencyStore,outboxRepository,relayTrigger}.ts`(D), `application/workers/**`(D 4 件), `application/di/env.ts`(D), `domain/common/event.ts`(D), `domain/identity/events.ts`(D)

**Cloudflare アダプター本体（44）**
`adapters/cloudflare/{directoryLocator,mailSender}.ts`,
`.../identityDirectory/{canonicalCipher,credentialMappingRepository,facade,mappingOperations,opaqueBinding,resetRequestKeys,resetTokenCrypto,resetTokenStore,rotationCheckpointStore,unitOfWork}.ts`,
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

---

## マージ可否

**可。** Blocker は0件。W-001 / W-002 はいずれも本 PR が導入した退行ではなく、負荷条件・順序条件のそろった場合に限って現れる有界な劣化（一時的な起床遅延 / 最大1窓のメール未達）である。#37 の受け入れ基準（AC-1〜AC-30）に反する点は見つからなかった。

ただしマージ前に1点だけ機械的な確認が要る — **清浄な作業ツリーで `pnpm test:integration` を1回通すこと**（N-001。レビュー時点のツリーには別エージェントの未コミット実験が載っており、AC-29 の全量確認だけができていない）。
