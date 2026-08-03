# Adapter / Infrastructure

PR #49 / base `main` / 契約 `.thread/37/plan.md`

DDL・OCC・FTS5・ジョブランナー / Alarm・migration ゲート・エラー翻訳・SQLite 制限・module スコープ制約・wrangler / Pulumi / vite 設定を観点として、変更ファイル一覧 220 件を全数分類した上でレビューした。

全体としては極めて質が高い。`spec/database/index.md` の 21 テーブル（User Data 16 / Identity Directory 5）を列・型・制約・索引の単位で突き合わせて一致を確認できた。FTS5 external-content の踏み外し（`DELETE FROM search_fts`）は無く、`'rebuild'` も使っていない。OCC は単一の実装に閉じ、retry は存在せず、#26 の誤帰属が構造的に起こらない形になっている。migration ゲートは同期で `await` を1つも挟まず forward-only・fail-closed である。設定側も D1 / Queue の残骸ゼロ、`exports` と `[[migrations]]` の併存なし、`main` の経路分割も AC-19 どおりである。

以下は、その上でなお修正が要ると判断した点である。

---

## Blockers

### **[B-001]** パスワードリセットの再依頼が 24 時間ものあいだ「成功したのに何も送られない」状態になり、しかも既存の有効リンクを破壊する

- 場所:
  - `packages/core/src/lib/jobBudgets.ts:37-42`（`SEND_MAIL_EMPTY_RETENTION_MS`）
  - `packages/core/src/adapters/cloudflare/jobs/table.ts:104-123`（収束規則 (3)）
  - `packages/core/src/adapters/cloudflare/jobs/table.ts:308-335`（`pruneCompleted`）
  - `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:300-343`（`requestPasswordReset`）
- 理由:
  `SEND_MAIL_EMPTY_RETENTION_MS = 15 * 60 * 1000` は JSDoc が「`send-mail` は再武装しない種別なので、生き残った `done` 行が再依頼を拒む側であり、**この値がそのままスロットル窓である**」と宣言している。しかしこの定数を読むコードはリポジトリのどこにも存在しない（`grep -rn "SEND_MAIL_EMPTY_RETENTION_MS"` の一致は宣言 1 件と `.thread/` の設計メモ 2 件のみ）。`pruneCompleted` は `kind` を見ずに `DONE_RETENTION_MS`（24 時間）を全種別へ一律に適用する。

  結果として実際に起きるのは次の連鎖である。

  1. 1 回目の依頼で `send-mail` 行が `done` に落ちる。
  2. 24 時間、その行は prune されない。
  3. 2 回目の依頼で `requestPasswordReset` は `RESET_THROTTLE_MS = 60_000`（`facade.ts:349`）を過ぎていれば `eligible` と判定し、`ctx.resetTokenStore.issue(...)` を呼ぶ。`issue` は同一トランザクションでその `credential_id` の**未使用行を全削除してから**新しい行を書く（`resetTokenStore.ts:62-80`）。
  4. 続く `ctx.enqueueJob({ kind: "send-mail", ... })` は既存 `done` 行に当たり、収束規則 (3) が `REARMING.has("send-mail") === false` で**何も書かずに return** する。
  5. RPC は成功を返す。メールは送られない。

  つまり「再送」ボタンを押すと、利用者が手元に持っている生きたリンクだけが無効化され、新しいリンクは届かない。しかもこの状態が 24 時間続く。`RESET_THROTTLE_MS`（1 分）も `SEND_MAIL_EMPTY_RETENTION_MS`（15 分）も、実効的にはどちらも死んでいる。

  既存テストはこれを「仕様」として固定してしまっている — `sendMail.integration.test.ts:340`「collapses a burst on one address onto a single row and one wake-up」はバースト連打の収束だけを見ており、**トークンが作り直されていること**（`tokenCount` の変化）も、**時間が経った後の正当な再依頼**も見ていない。

  なお、副次的な帰結として `provider_idempotency_key` も `send-mail:{kind}:{hmac}` の定数なので（`facade.ts:340`）、仮に `done` 行が prune された後に 2 回目が通ったとしても、プロバイダ側が同じ冪等キーで重複排除する可能性がある。
- 提案:
  1. `pruneCompleted` に種別ごとの保持期間を持たせ、`send-mail` は `SEND_MAIL_EMPTY_RETENTION_MS` を使う（定数の JSDoc が既に宣言している設計をそのまま実装する）。あるいは
  2. `operation_key` に時間窓を入れる（`spec/database/index.md`:24 が `operation_key` の導出を「DO ごとに定数のキーを持つ種別と、**対象と時間窓から導く種別**がある」と定義しており、`send-mail` は明らかに後者である）。`send-mail:{kind}:{hmac}:{floor(now / THROTTLE_WINDOW)}` にすれば、バースト連打は 1 行に収束したまま、窓をまたいだ正当な再依頼だけが新しい行を得る。`provider_idempotency_key` も自動的に窓ごとに変わるので上記の副次問題も同時に消える。
  3. どちらを採るにせよ、「窓を過ぎた 2 回目の依頼でトークンが再発行され、かつメールが届く」ことを固定する統合テストを 1 本足す。今の 4 ケース一致テストは、この経路を通らない。

### **[B-002]** `alarm()` から例外が逃げうる — 捕まえているのは migration ゲートとジョブ 1 本の失敗だけである

- 場所:
  - `apps/web/app/durable-objects/userData.ts:146-174`
  - `apps/web/app/durable-objects/identityDirectory.ts:210-243`
  - `packages/core/src/adapters/cloudflare/jobs/runner.ts:119-165`
- 理由:
  `alarm()` の本体は「再武装 → ゲート → 実行 → settle」の 4 段だが、`try / catch` が掛かっているのは 2 段目のゲートだけである。次の呼び出しはいずれも裸である。

  - `rearmBeforeWork` / `this.state.storage.sync()`（先頭）
  - `runDueJobs` 内の `listRunnable` / `claimJob` / `pruneCompleted`（`runOne` の外側）
  - `runOne` の `catch` 節が呼ぶ `poisonJob` / `failJob`（これ自体が `UPDATE`）
  - `settleAlarm`（`setAlarm` / `deleteAlarm` / `sync`）

  CLAUDE.md「非同期実行契約」(5) は「**Never throw out of `alarm()`**」と無条件に書き、AC-13 も「`alarm()` から throw しない」を要求している。throw すればリトライはプラットフォームに委譲され、これは同じ契約が明示的に禁じている形である。

  しかもこれは机上の話ではない。`spec/database/index.md`:20 は「逼迫時は**書き込みだけが失敗し**読みと削除は通る」を設計前提として明記しており、10 GB に達した DO ではまさに `claimJob` の `UPDATE` が `SQLITE_FULL` で失敗する。`sql/exec.ts` の翻訳を経て `SystemError(StorageCapacityExceeded)` になり、ハンドラが 1 つも走らないまま `alarm()` の外へ抜ける。`purge-trash`（＝容量を空ける唯一の自動経路）が二度と claim できない状態で、DO は自力回復できなくなる。
- 提案:
  ゲートの `catch` を「ゲート・実行・settle」を包む 1 つの `catch` に広げ、そこで `logger.error` して `rearmFailClosed` に落とす。fail-closed と同じ終端形に寄せるのが自然である（どちらも「原因はデータではないので `poison` にはせず、固定間隔で起き直す」に該当する）。あわせて `runOne` の `catch` 内の `poisonJob` / `failJob` にも内側のガードを置くか、少なくとも「終端書き込み自体が失敗したらキューの残りを止める」ことを意図として明示する。
  検証としては `runner.integration.test.ts` の「keeps running other jobs when one throws, and never rethrows」と同形で、**ストレージ側が throw するケース**（`claimJob` を失敗させる fake）を 1 本足すのが確実である。

### **[B-003]** `password_reset_tokens` が「照合に使う値」を平文で保存し、しかもその照合鍵が非暗号学的な 64 bit ハッシュで、さらに発行・配送・検証の 3 者が噛み合っていない

- 場所: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:12-40, 58-104` / `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts:109-138`
- 理由:
  3 点が絡んでいるが、どれも同じ 1 箇所の設計に由来する。

  **(a) 発行・配送・検証が合成できない。** `issue` は `tokenId = randomHex(16)` を作り、`token_id` に平文で、`token_hash` に `tokenHash(tokenId)` を書く。一方 `sendMail` が利用者へ届けるのは `{routingGen}.{bucket}.{HMAC(IDENTITY_RESET_TOKEN_KEY, tokenId)}` である（`sendMail.ts:109-138`）。そして `verifyAndConsume(token)` は `WHERE token_hash = tokenHash(token)` で引く。利用者が持っているのは HMAC 値であり、`tokenId` ではないので、**この 3 つは決して一致しない**。消費エントリ（`consume-reset-token`）は #12 の範囲なので今は誰も呼ばないが、#12 は成立しない契約を引き継ぐことになる。

  **(b) `spec/database/index.md`:627 の性質が成り立っていない。** 同行は「**生トークンは保存せず、`token_id` から導出したハッシュを保存する**（DB 漏えい時にトークンが使えないようにする）」と書く。しかし現状の実装では `verifyAndConsume` が受け付ける値がまさに `token_id` であり、それが PK 列に平文で載っている。バケットのダンプを得た者は、そのまま `verifyAndConsume(token_id)` を通して `changeAuthToken` を得られる。`sendMail` の JSDoc が主張する「ダンプは鍵を欠き、鍵は `tokenId` の 128 bit を欠く」は、`verifyAndConsume` が `tokenId` を直接受けている以上、成り立たない。

  **(c) `tokenHash` が暗号学的ハッシュではない。** FNV-1a を正順・逆順で 2 本回した 64 bit 値である（`resetTokenStore.ts:30-40`）。FNV は 32 bit 乗算と XOR だけなので代数的に可逆であり、目標ハッシュから原像を構成できる。2 本を同時に満たす原像も meet-in-the-middle で現実的な計算量に収まる。JSDoc は「入力が 128 bit の暗号論的乱数だから許される」と正当化しているが、守るべき性質は「ダンプから使える値を作れないこと」であって入力のエントロピーではない。仮に (a)(b) を直して「配送値のハッシュ」を保存する形にしても、64 bit の可逆ハッシュのままでは同じ穴が残る。
- 提案:
  同期ポートという制約は、この PR 自身が既に解いている。`reserveCredential` は WebCrypto が非同期であることを理由に、**トランザクションを開く前の RPC エントリで** `sealCanonical` を済ませ、暗号文を平の値としてトランザクションへ渡している（`durable-objects/identityDirectory.ts:92-109` / ADR-036）。リセットトークンも同じ形に揃えるのが素直である。

  1. 生トークン（配送値）を RPC エントリで作り、SHA-256 でハッシュしてから `run()` に渡す。`token_hash` にはその SHA-256 を入れる。
  2. `token_id` は「行の識別子」に徹させ、トークンを開ける値にしない（別採番にするか、少なくとも `verifyAndConsume` が受け付ける値と分離する）。
  3. `verifyAndConsume` の引数は配送値そのものにし、`token_hash` の計算方法を発行側と 1 箇所に共有する。
  4. #12 への引き継ぎメモを `passwordResetTokenPort.ts` の JSDoc に残す（現状の JSDoc `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts:23` は「a hash derived from `token_id`」と書いており、上の混乱の出発点になっている）。

---

## Warnings

### **[W-001]** `credential_mappings` の CAS が一致行数を読み戻していないので、CAS が空振りしても呼び出し側は成功を受け取る

- 場所: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts:100-118`（`activate`）・`153-190`（`beginChange` / `promote`）/ 呼び出し側 `packages/core/src/application/identity/signupSaga.ts:154-166`
- 理由:
  モジュール冒頭の JSDoc は「7 つの書き込みはすべて `operationId` / `payloadDigest` / `status` / `changeState` を条件に含む **CAS** である」と宣言している。`spec/database/index.md`:622 も「書き込みはすべて…CAS で直列化されており」と書く。しかし `run()` は影響行数を返さず、どのメソッドも一致 0 行を検出していない。結果として **CAS ではなく無条件 UPDATE** として振る舞う。

  signup saga の phase 3 で具体的に効く。`activateReservation` が 0 行にヒットしても（予約行が `sweep-reservations` に掃除された、`operation_id` が食い違った）`unwrap` は成功を返し、saga はそのまま phase 4 へ進んで完走する。予約行は `reserved` のまま、あるいは存在しない。ログイン時に `lookupCredential` は `status === 'active'` を要求するので（`facade.ts:131-146`）「材料なし」の一様な答えを返し、利用者は**理由が分からないまま永久にログインできない**。phase 5 の `verifyLogin` は User Data 側の `credential_locators` を見るので、この不整合を検出できない。
- 提案:
  少なくとも `activate` と `promote` は `RETURNING 1` を付けて 0 行を `ConflictError` に落とす。`cancel` / `delete` は「absent is success」が意図的な冪等設計なので現状のままでよいが、その差が意図であることを JSDoc に書き分けると読み手が迷わない。

### **[W-002]** `reindex` は「正規化規則を変えたときの全件再構築」を果たせない — 既に正規化済みの projection を入力にしている

- 場所: `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts:66-100` / `packages/core/src/adapters/cloudflare/search/projection.ts:65-72`
- 理由:
  `spec/database/index.md`:695 は「トークナイザや正規化規則を変えたときの全件再構築は migration の `reindex` ジョブが担う」と書く。実装は `search_entries` を読み、その `title` / `body` をそのまま `upsertSearchEntry` へ渡す。`search_entries.title/body` には**旧規則で正規化済みのテキスト**が入っているので、`normalizeForIndex` を掛け直しても旧規則の結果しか得られない。トークナイザ変更（仮想表を作り直して全行を投入し直す）には効くが、正規化規則の変更には効かない。原文は `memos.body` / `documents.title` / `documents.body` にしかなく、#37 はそれらのリポジトリを持たない（ADR-001）。
- 提案:
  ハンドラの JSDoc に「射程はトークナイザ変更（＝索引側の再投入）に限る。正規化規則の変更は `search_entries` 本体の作り直しを要し、その入力を持つのは本体リポジトリ側なので #2〜#6 の projection 再実行に載せる」と明記し、ステップ 30 の外部アクション (e) の引き継ぎ文にも 1 行足す。実装を変える必要はないが、spec の記述と食い違ったまま残すのは危険である。

### **[W-003]** `matchFts` が利用者のキーワードを FTS5 の `MATCH` へ素通しで渡している

- 場所: `packages/core/src/adapters/cloudflare/search/probe.ts:27-45`
- 理由:
  `MATCH` の右辺は文字列リテラルではなく FTS5 のクエリ式である。`"` / `*` / `:` / `^` / `(` `)` や `AND` / `OR` / `NOT` / `NEAR` は演算子として解釈され、閉じていない `"` は構文エラーで例外になる。例外は `sql/exec.ts` → `translateSqliteError` を通って `SystemError(DatabaseError)` になるので、利用者から見ると「特定の文字を含む検索が 500 になる」形で表面化する。trigram トークナイザは記号もインデックスするため、記号を含む正当な検索語は珍しくない。
  #10 が検索ユースケースを持つとはいえ、`probe.ts` は #37 が出荷するモジュールであり、AC-9 の常設統合テストが叩いているのもここである。
- 提案:
  フレーズとして囲む（`'"' + keyword.replaceAll('"', '""') + '"'`）。1 行で済み、trigram の一致性は変わらない。`tokenizer.integration.test.ts` に「`"` を含むキーワードが例外にならない」を 1 本足すと固定できる。

### **[W-004]** 診断エントリ 2 本が `sql/exec.ts` を迂回しており、翻訳されない driver エラーが生のメッセージのまま封筒に載る

- 場所: `apps/web/app/durable-objects/identityDirectory.ts:173-199`（`listBucketUserIds`）・`:201-207`（`readSchemaVersion`）/ `apps/web/app/durable-objects/userData.ts:123-129`
- 理由:
  `sql/exec.ts` の JSDoc は「**The only way DO-side code issues SQL**」と宣言し、その 3 つ目の理由として「driver エラーをアプリケーションコードが見る前に共有のエラー契約へ翻訳する」を挙げている。`listBucketUserIds` は `sql.exec(...)` を直に呼ぶのでこの主張の唯一の例外になっており、失敗すると `err(error)` が `isSerializableError` を通らずに `kind: "system" / code: "DATABASE_ERROR"` と**生の driver メッセージ**を封筒へ載せる（`platform/envelope.ts:28-37`）。100 bind parameter のアサートも掛からない。
  ゲートを通さない設計自体は spec:713 どおりで正しいが、ゲートを通さないことと SQL ヘルパを通さないことは別である。
- 提案:
  `all()` 経由にする。ゲートを呼ばないという性質は変わらない。

### **[W-005]** `payloadDigest` が 32 bit — 衝突すると異なる payload が既存行へ黙って乗る

- 場所: `packages/core/src/adapters/cloudflare/jobs/table.ts:41-49`
- 理由:
  `payload_digest` は「実行可能集合の行に違う payload が来たら `ConflictError`」を判定する唯一の材料である（spec:435）。32 bit FNV-1a なので約 43 億分の 1 で異なる payload が一致と判定され、その依頼は黙って捨てられる（既存行の `next_run_at` を早める側だけが走る）。確率は小さいが、失敗が「エラー」ではなく「静かな取りこぼし」になる種類の値なので、桁を上げるコストに見合う。
- 提案:
  同ファイル内で `resetTokenStore` が使っている 2 本立ての形にするか、そもそも `JSON.stringify` の安定化（キー順ソート）とあわせて 128 bit 相当にする。`JSON.stringify` はキーの挿入順に依存するので、**同じ論理 payload でもオブジェクトリテラルの書き方が変われば digest が変わる**点も同時に手当てできる。

### **[W-006]** 収束規則 (2)(3) の復活が `provider_idempotency_key` を引数の値で置き換えない

- 場所: `packages/core/src/adapters/cloudflare/jobs/table.ts:88-123`
- 理由:
  規則 (2) は spec:456 で「`next_run_at` / `payload` / `payload_digest` を引数の値で置き換える」と定義されている。`providerIdempotencyKey` はその列挙に無いが、`EnqueueJobArgs` の引数としては渡ってくる（`application/execution/jobs.ts:22-26`）。復活パスは古い値を保持し続けるので、引数で渡した値が無視される。今は全呼び出し元が `operationKey` から決定的に導いているので実害は無いが、それは呼び出し側の慣習であってストアが強制している性質ではない。
- 提案:
  復活時に `provider_idempotency_key = ?` も引数で置き換えるか、`EnqueueJobArgs` の JSDoc に「終端行の復活では引き継がれる（`operationKey` から決定的に導かれる前提）」と明記する。どちらでもよいが、どちらかは要る。

### **[W-007]** 実装済みの性質に対する空の skip テストが残っている

- 場所: `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts:419-421`
- 理由:
  `// Enabled once the job runner and the alarm entry exist (steps 10 / 16).` というコメント付きで `describe.skip("fail-closed alarm")` と本体の無い `it("runs no jobs, does not deleteAlarm, and re-arms at a fixed interval")` が残っている。ステップ 10 / 16 は本 PR で完了しているのでコメントが陳腐化しており、`vitest` は本体の無い `it` を todo として集計するため、テスト件数の実測（テスト方針「数の記録」）にもノイズが乗る。
  実質的な検証は `alarmEntry.integration.test.ts:103` と `jobs/__tests__/alarm.integration.test.ts:153` が持っているので、カバレッジ上の穴ではない。
- 提案:
  削除する（既存の 2 本を指すコメントを `gate.integration.test.ts` 側に 1 行残すなら十分）。

### **[W-008]** `guardStub` の JSDoc とコードが食い違っている

- 場所: `packages/core/src/application/di/serverCloudflare.ts:104-117`
- 理由:
  コメントは「**Invoked as a property of the stub, never as an extracted function**」と書いているが、実装は `const method = target[property]; method(...args)` と、まさに取り出してから呼んでいる。意図しているのは `Reflect.apply(value, target, args)` を避けることだと読めるが、書かれている禁止事項と書かれているコードが逆になっているので、次に触る人が「コメントに従って」`target[property](...args)` へ直したり、逆に安全だと思って `Reflect.apply` に戻したりする余地がある。
- 提案:
  コメントを実際の制約（`Reflect.apply` / `.call` / `.bind` を使わない）に書き直す。

### **[W-009]** リセット依頼が活性世代のバケットしか見ない — ログイン経路とルーティング鍵ローテーションへの耐性が非対称である

- 場所: `packages/core/src/application/identity/requestPasswordReset.ts:31-39` / 比較対象 `packages/core/src/application/identity/loginWithPassword.ts:118-130`
- 理由:
  `directoryLocator.forCanonical` の JSDoc は「Locators to try, active generation first, then the previous one if the keyring still carries it. **Reads *and* uniqueness registration consult every generation**」と宣言している（`adapters/cloudflare/directoryLocator.ts:24-30`）。`loginWithPassword` はそのとおり `for (const locator of locators)` で 2 世代を歩く。しかし `requestPasswordReset` は `locators[0]` だけを取り、見つからなければ `return` する。

  ローテーション中、まだ再写像されていない利用者の mapping は旧世代のバケットにある。その利用者はログインはできるが、リセット依頼は**新世代の空バケット**へ届き、`send-mail` ジョブがそこで「mapping なし」と判定して静かに `done` に落ちる。一様な応答は保たれるので列挙オラクルにはならないが、機能としては「リセットメールが永久に届かない利用者」がローテーション期間中だけ発生する。移送そのものは #44 だが、**2 世代並存に耐える読み**は #37 のスコープ内である（plan.md「含まれないもの」の鍵ローテーション項が明示的にそう書いている）。
- 提案:
  `loginWithPassword` と同じループにする。ヒットしたバケットへ 1 回だけ `requestPasswordReset` を投げる形にすれば、「必ず 1 行書く」という列挙オラクル対策も維持できる（どの世代にも無ければ活性世代へ投げて `done` に落とせばよい）。

---

## Notes

### **[N-001]** DDL が spec と列単位で一致している

`schema/userData.ts` / `schema/identityDirectory.ts` / `schema/jobsDdl.ts` を `spec/database/index.md` の各テーブル節と 1 つずつ突き合わせ、以下まで含めて一致を確認した。

- `memos` に `created_at` が**無い**こと（spec の列表どおり。他の集約は持つので取り違えやすい箇所）
- `search_entries.id` の一意性を列制約ではなく名前つき索引 `search_entries_id_uq` で取っていること（spec:376 の「列に `UNIQUE` を書くと名前のない暗黙索引がもう 1 本できる」に対応）
- `password_reset_tokens.token_hash` の UNIQUE も同様に `prt_token_hash_uq` として外出ししていること
- 複合 PK（`credential_locators` / `memo_revisions` / `source_links` / `credential_mappings` / `migration_progress` / `rotation_checkpoints`）に名前を付けていないこと
- `credential_mappings` の 26 列と `reserved_until INTEGER NOT NULL`、3 値 CHECK の `change_state`（AC-27 (iv)）
- `jobs` が両クラスで同一 12 列・同一 3 索引であること、`kind` に CHECK を置かずレジストリ側で全数を担保していること（spec:428 の書き方に一致）
- 部分索引の述語（`memos_timeline_idx` の `WHERE status='active'` など）が spec の「定義」欄と逐語で一致していること

単一行制約（spec が「実装裁量」として #37 へ委ねた箇所）を `CREATE UNIQUE INDEX ... ON account ((status IS NOT NULL))` という定数式ユニーク索引で表現しているのは良い解である — サロゲート `id` を足さないので列リストが spec と逐語で一致したまま残り、`_meta` にも同じ形が適用されている。

### **[N-002]** FTS5 external-content の扱いが正しい

- `projection.ts` が唯一の書き込み点であることを JSDoc で宣言し、引き算は `INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)` の特殊コマンド構文で書かれている。
- リポジトリ全体で `DELETE FROM search_fts` は JSDoc とテストコメントの中にしか現れない（実行される SQL としては 0 件）。
- `'rebuild'` も使っていない。`reindex` は 1 行ずつの再 projection をチャンク分割し、カーソル更新を**同じ `transactionSync`** に入れている。
- `projection.integration.test.ts` の検証が「2 文発行されたこと」ではなく「更新後に旧値でヒットしないこと」になっており、`spec/database/index.md`:414 とプラン risk 欄が名指しした落とし穴を正面から突いている。トランザクション途中 throw で本体・索引の**どちらも**変わらないことも両方向（memo / document）で見ている。

### **[N-003]** OCC の実装が 1 箇所に閉じ、#26 の誤帰属が構造的に起こらない

- 条件付き `UPDATE` は `sql/occ.ts:12-27` の `conditionalUpdate` ただ 1 つで、`RETURNING 1` が返した行数を**その文の中で**読む。他の文の結果を流用する余地が無い（`occ.integration.test.ts:65`「does not read another statement's success as its own」がこれを固定している）。
- 本 spec の範囲で唯一の発行者である `user_settings.save` は `WHERE version = ?` のみで、`id` 述語を持たない（spec:26 の単一行テーブル規則どおり）。
- `account` の 2 つの単調増加（`advanceSessionEpoch` / `advanceResetVersion`）は `version` 条件を付けず `version` も進めない — spec:80 の指示と一致し、その理由も JSDoc に書かれている。
- application 層にも adapters 層にも OCC の retry デコレーターは無い。

### **[N-004]** migration ゲートが AC-16 の 6 条件をすべて満たしている

`schema/gate.ts` は (i) 両 DO クラスの全 RPC エントリ（`runRpcEntry`）と `alarm()` の先頭に置かれ、例外は診断 2 本のみ、(ii) `runMigrationGate` は同期関数で `await` を 1 つも含まず、(iii) ステップ適用と `UPDATE _meta SET schema_version = ?` が同一 `transactionSync`、(iv) 下方向のステップが型として存在せず、(v) 部分適用は `migration_progress` + `migrate-bulk` / `reindex` へ、(vi) `current > codeVersion` で `SystemError` を投げ `alarm()` は `deleteAlarm()` せずに固定間隔で再武装する。

`_meta` を version 1 のステップ配列から意図的に外し `bootstrap` だけが作るようにしてあるので、`schema_version` の権威が 1 箇所に閉じている。ゲートが `jobs` へ直接 INSERT せず `enqueueJob` を通しているのも、「`jobs` の書き込み口は 1 つ」という全数主張を守るうえで正しい。

### **[N-005]** 駆動源クエリと作業述語の一致が 3 本すべてで意識的に扱われている

`purge-trash` / `sweep-reservations` / `sweep-reset-tokens` のいずれも、駆動源が作業述語と同じ集合の `min(...)` になっており、さらに「期限が来ているのに仕事が 0 件だった」場合に `MIN_RESUME_INTERVAL_MS` へクランプして `logger.warn` を出す防御が入っている。恒久起床ループ（課金直撃）に対する二重の歯止めとして妥当である。

`recalcPurgeAfterChunk` の作業述語 `WHERE status='trashed' AND purge_after <> trashed_at + ?` は本当に自己消尽する形になっており、`purge-trash` が永続カーソルを持たない根拠が実装として成立している。再計算フェーズが空になった起床でだけ削除フェーズへ進む順序も、その理由（保持期間を延ばした直後に古い `purge_after` で消してしまう）とともに JSDoc に書かれている。

### **[N-006]** `Date.now()` の射程が正しく分離されている

プロダクションコードに `Date.now()` の呼び出しは 1 件も無い（一致するのは JSDoc 2 件のみ）。時刻はすべて `Clock` ポート経由で `alarm()` / RPC エントリの入口で 1 回だけ取られ、引数で運ばれる。チャンク予算はすべて件数（`chunkRowLimit` / `maxChunks` / `MAX_JOBS_PER_ALARM` / `PRUNE_ROW_LIMIT`）で有界化されており、経過時間による打ち切りはどこにも無い。lease / backoff / `completed_at` / prune の保持期間だけが絶対時刻比較を使っている。

### **[N-007]** SQLite の 100 bind parameter 制限が呼び出し点で落ちる

`sql/exec.ts:20-29` の `assertBindings` が全ヘルパの入口に掛かっており、超過は `SystemError(DataIntegrityError)` に「Chunk the statement」という指示付きで落ちる。不透明な driver 失敗として現れないので、バルク挿入のチャンク分割漏れが実装時に分かる。

### **[N-008]** 設定側が AC-17 / AC-19 / AC-20 / AC-26 の機械検証をすべて通る

- `wrangler.toml` / `wrangler.state.toml` / `.tpl` 4 本のいずれにも `[[d1_databases]]` / `[[queues.*]]` / `[env.*]` が無い。
- DO クラス宣言は `[exports.X]` + `type = "durable-object"` + `storage = "sqlite"` のみで、`[[migrations]]` との併存は無い。
- `main` の経路分割が正しい — vite プラグインが自動発見するローカル `wrangler.toml` だけがソースエントリ（`app/server.cloudflare.ts`）で、`wrangler.state.toml` と `.tpl` 由来の 4 本が `dist/{server,state}/index.js` を指す。`vite.config.cloudflare.ts` の `auxiliaryWorkers` 側で `config: { main: ... }` を上書きしているのも、クリーンな clone でブートストラップ不能にならないための正しい手当てである。
- Pulumi から `D1Database` / `Queue` が消え、DO namespace は**足されていない**（ADR-011 どおり）。`{ protect: true }` の解除手順を #38 へ残す判断も plan.md の risk 欄と整合する。
- `pnpm-lock.yaml` に `drizzle` の一致が 0 件、`packages/core/src/adapters/d1/` と `apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq,handlers}.ts` は実在しない。
- `grep -rn "tanstack-start-template"`（AC-20 の確定コマンド）が 0 件。
- `vitest.config.integration.ts` が `main` を `WorkersPoolOptions` のトップレベルに置き、`durableObjects` を**オブジェクト形式で `useSQLite: true` 付き**にしている。プラン risk 欄が名指しした 2 つの罠を両方回避できている。
- `setup.ts` が `reset()` → `evictAllDurableObjects()` の 2 本を呼び、なぜ両方要るかを冒頭コメントで説明している。DO クラスにテスト専用の public メソッドを生やしていないのも良い（ADR-015）。

### **[N-009]** エラー翻訳の 2 点が明示的に分離されている

DO 内部の `SqlStorage` 失敗は `sql/errors.ts`、stub 呼び出し自体の失敗は `platform/stubErrors.ts` と、責務が分かれ、両方の JSDoc が互いを名指ししている。`translateStubError` が `ConflictError` へ写像しないこと（到達不能を 409 と言うのは嘘だから）を理由付きで書き、テスト（`stubErrors.test.ts:42`）でも固定している。`SystemErrorCode` へ `ServiceOverloaded` / `StorageCapacityExceeded` を足したのも、DO 移行で新しく表現可能になった状態に対応していて妥当である。

RPC 値エンベロープの型を `lib/rpcEnvelope.ts` に置き、`toSerialized()` を叩くヘルパだけを `adapters/.../envelope.ts` に残した分割（ADR-014）も、`application → adapters` の逆流を実際に断てている。`restoreError` が未知の `kind` を黙って潰さず `SystemError(DataIntegrityError)` にするのも要求どおり。

### **[N-010]** テストの厚みが妥当

新設の統合テストは、`jobs/table` の収束規則 3 つ・claim / lease / reclaim・終端形の一様性・prune、Alarm の起動セマンティクス 5 項目、DDL の全テーブル / 全索引 / 全列ラウンドトリップ、FTS5 の同一トランザクション整合と trigram / bm25 / `instr()` フォールバック / ページング、`send-mail` の 4 ケース一致と冪等性、`purge-trash` の 2 フェーズと駆動源、OCC の誤帰属不在、SSO 解決の 4 ケースを覆っている。`forbiddenValues.ts` を共有した禁止語アサートが `terminal_reason` とログの両方に掛かっているのも AC-3 / AC-27 の担保として実効的である。

---

## カバレッジ

確認 **150** 件 / スキップ **70** 件 = **220** 件。

### 確認（150）

**ADR / 契約 / CI（4）**
`.adr/001-integration-tests-single-workers-pool.md`, `.adr/003-sqlite-fts5-only-search.md`, `.github/workflows/ci.yml`, `.thread/37/plan.md`

**規約（1）**
`CLAUDE.md`

**Cloudflare 設定・エントリ・ビルド（20）**
`apps/web/.dev.vars.example`, `apps/web/__tests__/boot.smoke.test.ts`, `apps/web/app/server.cloudflare.ts`, `apps/web/app/worker/cloudflare/state.ts`, `apps/web/package.json`, `apps/web/scripts/render-wrangler.ts`, `apps/web/vite.config.cloudflare.ts`, `apps/web/vite.config.state.ts`, `apps/web/wrangler.toml`, `apps/web/wrangler.state.toml`, `apps/web/wrangler.request.production.toml.tpl`, `apps/web/wrangler.request.staging.toml.tpl`, `apps/web/wrangler.state.production.toml.tpl`, `apps/web/wrangler.state.staging.toml.tpl`, `apps/web/wrangler.production.toml.tpl`(D), `apps/web/wrangler.staging.toml.tpl`(D), `apps/web/drizzle.config.ts`(D), `package.json`, `packages/core/package.json`, `pnpm-lock.yaml`

**Durable Object クラス（2）**
`apps/web/app/durable-objects/userData.ts`, `apps/web/app/durable-objects/identityDirectory.ts`

**旧 Worker / D1 アダプターの削除確認（27）**
`apps/web/app/worker/cloudflare/__tests__/env.d.ts`(D), `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`(D), `apps/web/app/worker/cloudflare/consumer.ts`(D), `apps/web/app/worker/cloudflare/dlq.ts`(D), `apps/web/app/worker/cloudflare/handlers.ts`(D), `apps/web/app/worker/cloudflare/pruner.ts`(D), `apps/web/app/worker/cloudflare/relay.ts`(D), `packages/core/src/adapters/d1/__tests__/env.d.ts`(D), `.../helpers.integration.test.ts`(D), `.../helpers.ts`(D), `.../idempotencyStore.integration.test.ts`(D), `.../occGuard.integration.test.ts`(D), `.../outboxRepository.integration.test.ts`(D), `.../setup.ts`(D), `.../unitOfWork.integration.test.ts`(D), `.../userRepository.integration.test.ts`(D), `packages/core/src/adapters/d1/client.ts`(D), `.../migrations/0000_initial.sql`(D), `.../migrations/meta/0000_snapshot.json`(D), `.../migrations/meta/_journal.json`(D), `.../pendingBatch.ts`(D), `.../repositories/helpers.ts`(D), `.../repositories/idempotencyStore.ts`(D), `.../repositories/outboxRepository.ts`(D), `.../repositories/userRepository.ts`(D), `.../schema.ts`(D), `.../unitOfWork.ts`(D)

**Cloudflare アダプター本体（43）**
`adapters/cloudflare/directoryLocator.ts`, `.../mailSender.ts`, `.../serviceBindingRelayTrigger.ts`(D),
`.../identityDirectory/{canonicalCipher,credentialMappingRepository,facade,mappingOperations,opaqueBinding,resetTokenStore,rotationCheckpointStore,unitOfWork}.ts`,
`.../jobs/{alarm,registry,runner,table}.ts`, `.../jobs/handlers/{migrateBulk,purgeTrash,reindex,resumeSignup,sendMail,sweepReservations,sweepResetTokens}.ts`,
`.../platform/{envelope,rpcEntry,stubErrors}.ts`,
`.../schema/{bulkSteps,gate,identityDirectory,jobsDdl,types,userData}.ts`,
`.../search/{normalize,probe,projection}.ts`,
`.../sql/{errors,exec,occ}.ts`,
`.../userData/{accountStore,credentialLocatorStore,facade,trashQuery,unitOfWork,userSettingsRepository}.ts`

**Cloudflare アダプターのテスト（24）**
`adapters/cloudflare/__tests__/{alarmEntry.integration.test.ts,binding.integration.test.ts,doHarness.ts,env.d.ts,envelope.test.ts,forbiddenValues.ts,mailSender.test.ts,setup.ts,stubErrors.test.ts}`,
`.../identityDirectory/__tests__/ssoResolution.integration.test.ts`,
`.../jobs/__tests__/{alarm,directoryJobs,purgeTrash,runner,sendMail,table}.integration.test.ts`, `.../jobs/__tests__/{registry.test.ts,registry.typetest.ts}`,
`.../schema/__tests__/{gate,migration}.integration.test.ts`,
`.../search/__tests__/{normalize.test.ts,projection.integration.test.ts,tokenizer.integration.test.ts}`,
`.../userData/__tests__/occ.integration.test.ts`

（一覧の行番号では #59〜#67 / #69 / #78〜#85 / #101〜#102 / #109〜#111 / #119 の 24 件）

**application 層のうち adapter / infra に接する部分（12）**
`application/di/{facades,secrets,serverCloudflare,stateCloudflare}.ts`, `application/di/env.ts`(D),
`application/errors.ts`, `application/execution/{jobs,unitOfWork}.ts`, `application/rpc/restoreError.ts`,
`application/identity/signupSaga.ts`, `application/identity/requestPasswordReset.ts`,
`application/di/__tests__/stateContainerConfig.test.ts`

**lib（5）**
`lib/{directoryLocator,jobBudgets,jobKind,rpcEnvelope}.ts`, `lib/__tests__/jobKind.test.ts`

**Pulumi（7）**
`infra/cloudflare/pulumi/resources/{Pulumi.production.yaml,Pulumi.staging.yaml,Pulumi.yaml,index.ts}`, `infra/cloudflare/pulumi/routes/{Pulumi.production.yaml,Pulumi.staging.yaml,Pulumi.yaml}`

**vitest 設定（3）**
`vitest.config.ts`, `vitest.config.integration.ts`, `vitest.config.smoke.ts`

**spec（2）**
`spec/database/index.md`（正典として全文照合）, `spec/inventory/adapter.md`

### スキップ（70）

（グループ化した項目は末尾に実ファイル数を付した。合計 70。）

- `.thread/37/adr.md` — 作業ログ。判定の契約は `plan.md` の受け入れ基準に一本化した
- `.thread/37/steps.md` — 実装手順書。成果物側で AC を直接検証したため
- `.thread/37/testing.md` — テスト計画。実テストファイル側で確認したため
- `README.md` — 利用者向けドキュメント。Worker 名の残骸は AC-20 の grep（0 件）で機械的に確認済み
- `docs/backend_implementation_example.md` — #38 で全面改訂予定の例示ドキュメント。観点外
- `docs/test.md` — テスト構成の説明文書。実体は vitest 設定 3 本で確認済み
- `spec/manual-tests/search.md` — 手動テスト手順書。観点外
- `apps/web/app/components/auth/LoginForm/action.ts` — presentation 層
- `apps/web/app/components/auth/SignupForm/action.ts` — presentation 層
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx` — presentation 層
- `apps/web/app/components/settings/LogoutButton/action.ts` — presentation 層
- `apps/web/app/presentation/__tests__/currentUser.test.ts` — presentation 層
- `apps/web/app/presentation/__tests__/errorResponse.test.ts` — presentation 層（`SerializedError` union の権威側。Domain / Presentation 観点の担当）
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts` — presentation 層
- `apps/web/app/presentation/__tests__/session.test.ts` — presentation 層
- `apps/web/app/presentation/authState.ts` — presentation 層
- `apps/web/app/presentation/currentUser.ts` — presentation 層
- `apps/web/app/presentation/errorResponse.ts` — presentation 層
- `apps/web/app/presentation/session.ts` — presentation 層
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — 逆流依存の解消（定数移動）のみで、DO / SQLite 観点に接しない
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` — 同上
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` — 同上（コスト見直しは #20）
- `packages/core/src/application/__tests__/helpers.ts` — テストハーネス。Usecase 観点の担当
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` — DI の秘密漏出ガード。Usecase / Security 観点の担当
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts` — 同上
- `packages/core/src/application/di/__tests__/secrets.test.ts` — 同上
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts`(D) — 対象消滅の削除
- `packages/core/src/application/di/containerStore.ts` — リクエストスコープの ALS。DO 側に影響しない
- `packages/core/src/application/di/types.ts` — 型定義のみ
- `packages/core/src/application/events/buildDecoder.ts`(D) — イベント機構の撤去（AC-8 / AC-14 は削除確認で足りる）
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts` — 型テスト。Usecase 観点の担当
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts`(D) — 対象消滅
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts` — Usecase 観点
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` — Usecase 観点
- `packages/core/src/application/identity/__tests__/logout.test.ts` — Usecase 観点
- `packages/core/src/application/identity/{eventDecoders.ts(D),getCurrentUser.ts,loginWithPassword.ts,registerWithPassword.ts,view.ts}` — Usecase 観点（**5 件**）
- `packages/core/src/application/ports/idGenerator.ts` — ポート定義。Domain / Usecase 観点
- `packages/core/src/application/ports/{idempotencyStore,outboxRepository,relayTrigger}.ts`(D) — 対象消滅（**3 件**、AC-14 の削除確認のみ）
- `packages/core/src/application/ports/sessionCodec.ts` — ポート定義
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts` — 実装側 `restoreError.ts` で確認済み
- `packages/core/src/application/workers/{__tests__/eventRelayWorker.integration.test.ts,__tests__/outboxPrune.test.ts,eventRelayWorker.ts,outboxPrune.ts}`(D) — 対象消滅（**4 件**）
- `packages/core/src/domain/**` — Domain 観点の担当（**18 件**: `common/event.ts`(D), `common/transactionalRepository.ts`, `identity/__tests__/{entity,noRawNul,valueObject}.test.ts`, `identity/{entity,errorCode,valueObject}.ts`, `identity/events.ts`(D), `identity/ports/{accountStore,credentialLocatorStore,credentialMappingRepository,credentialMappingStore,mailSender,passwordResetTokenPort,rotationCheckpointStore,userSettingsRepository}.ts`, `identity/ports/userRepository.ts`(D)。ただし B-003 の関係で `passwordResetTokenPort.ts` の JSDoc だけは参照した）
- `packages/core/src/lib/{passwordHashing,secretLengths}.ts` — 逆流依存の解消のための定数移動のみ（**2 件**）
