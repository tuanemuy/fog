### Test

2回目のレビュー。1回目の指摘（B-001〜004 / W-001〜016）の修正検証と、修正によって生まれた問題の検出を主眼に置いた。

レビュー時に実際に実行した検証（すべてローカル実測、2026-08-03）:

| 実行 | 結果 |
|---|---|
| `pnpm test:unit` | 36 files / 510 passed（1回目: 31 / 461） |
| `pnpm test:integration` ×22回 | **20回緑 / 2回赤**（下記 B-001） |
| `rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke` | 1 file / 2 passed |
| `--sequence.shuffle` 6シード（12345 / 777 / 4242 / 99 / 31337 / 8） | 5緑 / 1赤（同 B-001） |
| 自前の変異試験 9本 | **9本とも検出**（詳細は下記） |
| `evictAllDurableObjects()` を削除して統合スイート | 緑のまま（修正エージェントの実測は正しい） |
| `reset()` を削除して統合スイート | `cleanup.integration.test.ts (2 of 2)` が赤（荷重は本物） |
| `dist/` を残したままソースを `touch` → `test:smoke` | `beforeAll` で赤・`exit=1`（鮮度検査は本物） |

---

#### Blockers

- **[B-001]** 統合スイートが**不安定**である。1回目の修正で新設された `alarmEntry.integration.test.ts` の "does not delete its alarm when the schema is fail-closed" が、フルスイート実行時に確率的に落ちる。AC-29（`pnpm test:integration` が通る）が確率的にしか成立していない
  - 場所: `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts:166-191`（とくに `:175` の陽性対照 `expect(await fireCountingDeletes(stub)).toBe(1)`）。同根の潜在箇所が `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts:217-249` と `packages/core/src/application/identity/__tests__/identity.integration.test.ts:917-937`
  - 理由: **実測** — フルスイート22回のうち2回、`AssertionError: expected 2 to be 1` で赤になった（シャッフル seed 31337 と、キャッシュが冷えた初回実行）。当該ファイル単独では8回連続で緑なので、単独実行では見えない。
    原因は**プラットフォーム自身の Alarm 配信との競合**である。`requestPasswordReset` の RPC は `runRpcEntry` → `armAfterRpc` → `persist()` で `setAlarm(clamp(now, earliest))` を発行し、`clamp` は過去日時を `now + 1000` に倒す（`jobs/alarm.ts:31-33`）。つまり **RPC の1秒後に workerd が本物の `alarm()` を配信する**。`fireCountingDeletes` は `ctx.storage.deleteAlarm` を差し替えてから手動で `alarm()` を呼ぶので、その窓の中にプラットフォーム配信が入ると `deleteAlarm` が2回数えられる。フルスイートは4〜5秒かかるため、この1秒窓は日常的に超える。
    **同じ競合は数え上げ以外にも効く。** 検証のため `resetToken.integration.test.ts` の "stores nothing a database dump could redeem" と `identity.integration.test.ts` の "sends the link to the address the signup itself sealed" に 2000ms の遅延を1行注入したところ、**どちらも決定的に赤になった**（前者は `TypeError: Cannot read properties of null (reading 'generation')` — プラットフォームが noop sender でジョブを先に消費し `deliver()` が空配列を返す。後者は `expected [] to deeply equal [ 'user-29@example.com' ]`）。遅延は検証後に revert 済みで `git status` は clean。つまりこの2本も「CI が遅い日に落ちる」テストであり、いまは1秒に間に合っているだけである。
    `docs/test.md`:68 の「順序独立性は名前のユニーク化が第一防衛線」という説明は正しいが、**この不安定さは順序でも名前でもなく時間に依存する**ので、その説明でも `afterEach` でも防げない。
  - 提案: RPC 経由で enqueue してから手でジョブを駆動するテストは、RPC の直後に `runInDurableObject(stub, (_i, ctx) => ctx.storage.deleteAlarm())` でプラットフォーム配信を明示的に外す（1行で、3ファイルとも同じ形）。`fireCountingDeletes` の陽性対照はそれに加えて、数える窓をプラットフォームが入れない位置（`enqueueJob` 直接投入 + 遠い未来の `nextRunAt`）に移すのが確実。`runner.integration.test.ts` / `purgeTrash.integration.test.ts` が既にその形で、一度も揺れていない。

#### Warnings

- **[W-001]** `cleanup.integration.test.ts` の JSDoc が `evictAllDurableObjects()` を**荷重ありと断定**しており、同じ PR の `setup.ts` の記述および実測と食い違う
  - 場所: `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts:17-21`
  - 理由: 「Whichever runs second can only pass if, between them: … `evictAllDurableObjects()` destroyed the instance — otherwise the surviving `AlarmCache` still reads `ARMED_AT`, `persist()` skips the `setAlarm` as redundant, and the alarm the reset just cleared is never re-armed」と書いてあるが、実測では `evictAllDurableObjects()` を削っても統合スイート175件は**全部緑**（このファイルも含む）。`setup.ts:21-28` は正しく「Measured, it is currently redundant」「no comment here should claim otherwise, since a redundant call that is believed to be load-bearing is how a real cleanup gap gets misdiagnosed」と書いているので、**同じ PR の中で2つのコメントが正反対のことを言っている**。W-006 が指摘した「効いていないものを効いていると書く」問題が、setup.ts から cleanup テストへ移動しただけの状態になっている。
  - 提案: 当該2行を「`reset()` が唯一の荷重で、`evictAllDurableObjects()` は保険（実測で冗長）」に直す。両方が要ると書きたいなら、evict だけを消して赤になるケースを実際に1本作る。

- **[W-002]** AC-12 (iii) の「**成功・失敗のどちらの経路でも** `setAlarm` が発火する」が未検証。`runRpcEntry` を通るテストが1本も無い
  - 場所: `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts:37-60` / `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts:129-151`
  - 理由: `grep -rn "runRpcEntry"` の非定義側ヒットは DO クラス2本だけで、テストは0件。`alarm.integration.test.ts` の "arms from an RPC entry …" は `armAfterRpc` を**直接**呼んでおり、`runRpcEntry` の `catch` 経路（body が throw した後でも arm する）も、arm 自体が失敗したとき `ok` を `err` に倒す分岐（`:52-56`）も通っていない。前者は JSDoc が「a transaction can commit and a later statement still throw」という具体的な失敗モードを名指ししている性質なので、`armAfterRpc` の呼び出しを `try` ブロックの中へ動かしても全テストが緑のままになる。
  - 提案: `inIdentityDirectory` ハーネスで `runRpcEntry` を直接叩き、(i) `body` が `enqueueJob` してから throw したときに envelope が `ok:false` かつ alarm が武装されていること、(ii) `armAfterRpc` が throw したら成功した body でも `err` が返ること、の2本を足す。どちらも DO クラスを経由せず書ける。

- **[W-003]** `requestPasswordReset` の「登録済み / 未登録で行数が同じ」テストが**バケット衝突に対して脆い**
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:873-915`（`jobsFor` の `SELECT … WHERE kind = 'send-mail'`）
  - 理由: 同じファイルの `mappingRowsFor` は「two addresses in one test can legitimately share a bucket (there are 256 of them), so an unfiltered `SELECT` makes the assertion depend on which pair the run drew」とコメントまで付けて hmac で絞っているのに、`jobsFor` は `kind` だけで絞っている。`registeredAddress` と `unknownAddress` が同じバケットに落ちると、両方の `toHaveLength(1)` が 2 を見て落ちる。いまは `seq` が決定的なので当たっていないだけで、このファイルにテストを1本足して `seq` がずれれば 1/256 で顕在化する。列挙オラクル検査という主題からしても、行数を数える対象は「その hmac の行」であるべき。
  - 提案: `jobsFor` に `operation_key` か hmac 由来の条件を足す（`send-mail` の `operation_key` は hmac と窓から作られるので絞れる）。

- **[W-004]** `docs/test.md` が実行されない運用を「実行している」と書いている
  - 場所: `docs/test.md`:68（「The suite is run under `--sequence.shuffle` as part of the pre-PR checks for exactly this reason」）
  - 理由: `grep -rn shuffle package.json .github/workflows/ci.yml` は0件。シャッフル実行はスクリプトにも CI にも存在しない。B-001 の flake は実際にシャッフル実行で1回捕まえられているので、この一文が指す運用には価値があるが、**現状は人が思い出したときだけ走る**。1回目で「実測に合わせて書き換える」を徹底した直後の PR で、検証していない運用の記述が新たに入っているのは同じ穴である。
  - 提案: `test:integration:shuffle` をスクリプト化して CI か PR チェックに入れるか、この一文を「推奨」と分かる書き方に落とす。

- **[W-005]** `docs/test.md` の「固定名を使うスイートは2本」が実際は3本
  - 場所: `docs/test.md`:52（「Every suite but two derives one from a module-scope counter」）
  - 理由: 実測で `seq += 1` を持たない統合テストは `gate` / `cleanup` / **`binding.integration.test.ts`** の3本（`binding-USER_DATA` などの固定名）。`binding` は `SELECT 1` しかしないので実害は無いが、数を断定している以上は合わせるべきで、W-006 の是正の趣旨（断定は実測に合わせる）と同じ話である。
  - 提案: 「三本、うち状態を持つのは2本」と書き分ける。

- **[W-006]** `purgeTrash.integration.test.ts` の `Io.lines` の JSDoc が「every case below asserts it」と断定しているが、12ケース中5ケースしか assert していない
  - 場所: `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts:41-47`（`lines` の説明）と `:253` / `:290` / `:310` / `:336` の4箇所 +1
  - 理由: W-010 の是正で `lines` は死に変数ではなくなり「clamp が火を噴かない」不変条件の言明になったが、`deletes only the items whose retention has elapsed` など残り7ケースは `lines` を見ていない。断定と実態のずれは W-011 で指摘したのと同じ形（テストが主張していないことを説明文が主張する）。
  - 提案: `afterEach` 相当で一括 assert するか、JSDoc を「代表ケースで assert する」に直す。

#### Notes

- **[N-001]** **1回目の指摘16件＋Blocker 4件は、抜き取り変異試験の範囲では本物の是正である。** 自分で回した9本の変異はすべて、狙ったテスト（だけ）を赤にした。とくに B-002 / B-003 / B-004 の新規テストは、実装を写しただけの assert ではなく実経路を通していることを確認できた（`changeTrashRetentionDays` は facade → `uow.run` を実際に通り、`recalcTrashPurgeAfter` を消すと1本だけ赤になる）。
- **[N-002]** `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts` は AC-16 (i) を grep から**実行検査**へ引き上げている。`Object.getOwnPropertyNames(prototype)` から `INTERNALS` を引いた集合をエントリ表と突き合わせるので、エントリを足して片側の表に入れ忘れると必ず落ちる。fail-closed の DO に対して全ゲート付きエントリが**同一メッセージ**で拒否されることを1つのオブジェクト比較で見ている点も、どのエントリが漏れたかが diff に出る良い形。
- **[N-003]** `boot.smoke.test.ts` の mtime 鮮度検査（ADR-085）は実測で本物だった。`touch packages/core/src/lib/jobKind.ts` だけで `beforeAll` が赤になり `exit=1`。`__tests__` と `*.gen.ts` の除外理由もコメントに書かれていて、自己参照で永久に赤くなる罠を避けている。CI ではビルドジョブ内でビルド直後に走るので二重ビルドも起きていない。
- **[N-004]** `directoryLocator.test.ts` は「実装を写さない」書き方ができている。`bucketCount` を 256 / 5 と**変えた**2世代を与え、期待値を公開された `hmac` から独立に再導出しており（`expectedIndex`）、`expect(expectedIndex(previous.hmac, 256)).toBeGreaterThanOrEqual(5)` と `expect(active.hmac.slice(0,2)).not.toBe(active.hmac.slice(2,4))` という**witness ガード**まで置いてあるので、テストの前提が崩れたら空振りではなく赤になる。
- **[N-005]** `noRawNul.test.ts` / `noAdapterBackflow.test.ts` はどちらも「走査対象が空でないこと」を別の `it` で先に固定している（`files.length > 100` / `> 20` ＋ 合成ルート2本の存在）。機械検査が無言で0件を返して緑になる事故（1回目の B-001 そのもの）に対する正しい保険。
- **[N-006]** `packages/core/src/application/__tests__/fakes/fakePasswordHasher.ts` の JSDoc がまだ D1 時代の `users.password_hash` を名指ししている（実際の検査対象は Directory の `password_verifier` 列）。`docs/test.md` 側は直っているので、コメントだけが取り残されている。
- **[N-007]** `tokenizer.integration.test.ts` の "treats FTS5 operators in a keyword as text rather than syntax" は `expect(count).toBeGreaterThanOrEqual(0)`（常に真）だが、実際の主張は「throw しないこと」でありコメントもそう明言している。W-011 で指摘した「名前と中身の乖離」には当たらないと判断した（名前が主張しているのは syntax として解釈されないことで、それは throw の不在で観測される）。
- **[N-008]** テスト設定は3スイートとも `include` / `exclude` が排他で、取りこぼしも重複も無いことを確認した。unit は `*.integration.test.ts` と `*.smoke.test.ts` を除外、integration は `include` 許可リスト3件（`apps/web/app/durable-objects/**` は W-013 の是正で実マッチするようになった）、smoke は `apps/web/__tests__/**`。`*.typetest.ts` が vitest の既定 `include` に掛からず `tsconfig` にだけ載る分離も維持されている。

---

#### 1回目指摘の修正検証

- **B-001（生 NUL）** — 解消。`forbiddenValues.ts:27` は JS エスケープになり、`file` は text 判定。`noRawNul.test.ts` は `packages/core/src` / `apps/web/app` 全体走査＋空振りガード付きへ拡張されている。
- **B-002（signup saga の部分失敗・再試行）** — 解消。`identity.integration.test.ts:701-870` に3本。**変異試験で確認**: `cancelAll` の呼び出しを消すと "rolls the coordinator's reservation back when a later bucket refuses" だけが赤、`payloadDigest` 不一致の分岐を `if (false)` にすると "replays phase 2 idempotently…" だけが赤。stub を差し替えて phase 2 を落とす形（`withInitializeAccount`）も、RPC stub が spread できないことを踏まえて全メソッド委譲で書かれている。
- **B-003（`changeTrashRetentionDays` の同一トランザクション再計算）** — 解消。`identity.integration.test.ts:581-699` に3本。**変異試験で確認**: `ctx.recalcTrashPurgeAfter(...)` を消すと "recomputes every trashed item…" が赤、identity 早期 return を消すと "burns no OCC round trip…" が赤。facade / RPC 経路を実際に通っており、seed からの再現ではない。
- **B-004（平文非混入と実 PBKDF2 往復）** — 解消。**変異試験で確認**: `FakePasswordHasher` の出力に平文を混ぜると "keeps the password plaintext out of the stored verifier" が赤（同時にログイン系5本も赤になるが、狙ったテストは確かに反応する）。`round-trips a password through the real PBKDF2 hasher` は `createPbkdf2PasswordHasher({ iterations: MIN_PBKDF2_ITERATIONS })` を注入し、保存形式 `pbkdf2-sha256$1000$…` と正誤2ケースのログインまで見ている。
- **W-001（メール正規化の経路）** — 解消。登録側 `:262` とログイン側 `:419` の2本。
- **W-002（login の入力検証分岐）** — 解消。`:384` "answers all four rejections in exactly the same shape" が4ケース列挙オラクル。
- **W-003（禁止語配列の空振り）** — 解消。**変異試験で確認**: `directoryStubFactory` の返す stub をラップしてエラーメッセージに `locator.doName` を混ぜたところ、`Forbidden value leaked into observable output: dir:g1:b19` で赤になった。実導出値が `extra` 経由で検査されており、haystack も「アドレス指定」と「ログ」に分離されている。
- **W-004（backoff の伸び）** — 解消。`attempt` 列 `[1..7,7,7]`、`status` 列、`next_run_at - now` ＝ `backoffMs(attempt)` の列、単調増加、重複無しまで assert。
- **W-005（bm25 の順位）** — 解消。**変異試験で確認**: `probe.ts` の重みを `(1.0, 1.0)` にすると "ranks a title hit above a body hit through bm25's 3.0 title weight" だけが赤。tie-breaker を全部 body 側に有利にしたフィクスチャ設計が効いている。
- **W-006（クリーンアップの荷重）** — 解消。**両方向を自分で再実測**: `reset()` を消すと `cleanup.integration.test.ts (2 of 2)` が赤、`evictAllDurableObjects()` を消すと175件すべて緑。`setup.ts` の JSDoc と `docs/test.md`:51 の書き換えは**正しい**。ただし `cleanup.integration.test.ts` 自身のコメントが逆のことを言っている（W-001）。
- **W-007（`describe.skip` / fail-closed の `deleteAlarm`）** — **不十分**。skip の削除と `deleteAlarm` 数え上げの追加自体は行われているが、そのために書かれたテストが不安定（B-001）。検証の意図は正しいので、数える窓の取り方だけを直せばよい。
- **W-008（`directoryLocator` の unit）** — 解消。5本（N-004）。
- **W-009（OCC の「行が無い」）** — 解消。`occ.integration.test.ts:65` "answers a row that does not exist the same way as a stale version" と `sql/occ.ts` の JSDoc。
- **W-010（purge-trash の yield / clamp / 死に変数）** — 解消。`createPurgeTrash(budget)` の既定引数で本番経路は無変更、縮小予算で `yield` に到達する3ケース。clamp が到達不能であることの言明へ切り替えた判断も妥当（ただし言明の適用範囲が JSDoc と食い違う。W-006）。
- **W-011（名前と assert の乖離2件）** — 解消。後者は `ctx.storage.setAlarm` をスパイして書き込み回数と引数列を見る形になり、「別の時刻なら書く」陽性対照まで入っている。
- **W-012（統合スイート内の純関数テスト）** — 解消。`GOOGLE` で導出した locator が `google` で書いた行を引ける形になり、subject の再ケースが別 identity になることまで見ている。
- **W-013（`include` の空マッチ）** — 解消。`rpcEntries.integration.test.ts` 6本（N-002）。
- **W-014（古い dist に緑を返すスモーク）** — 解消。**変異試験で確認**（N-003）。
- **W-015（`getCurrentUser` の失敗系・投影系）** — 解消。`trashRetentionDays === 30` と `USER_NOT_FOUND` の2点。
- **W-016（未使用の recordingLogger）** — 解消。`directoryJobs` は `silentLogger()`、`purgeTrash` は `lines` を実 assert へ。

**新たに生まれた問題**: B-001（新設テストの flake）と W-001（新設テストのコメントが実測と逆）の2件。どちらも1回目の是正そのものに付随して入った。

---

#### 自分で行った変異試験

いずれも実施後に `git checkout` で戻し、`git status` が clean であることを確認済み。

| # | 対象 | 壊し方 | 結果 |
|---|---|---|---|
| 1 | `userData/facade.ts` | `ctx.recalcTrashPurgeAfter(...)` の呼び出しを削除 | **赤** — "recomputes every trashed item and queues the sweep in one transaction" のみ |
| 2 | `userData/facade.ts` | `if (next === found.entity) return …`（identity 早期 return）を削除 | **赤** — "burns no OCC round trip when the value has not moved" のみ |
| 3 | `application/identity/signupSaga.ts` | phase 1b の `catch` から `cancelAll(...)` を削除 | **赤** — "rolls the coordinator's reservation back when a later bucket refuses" のみ |
| 4 | `application/__tests__/fakes/fakePasswordHasher.ts` | 出力に平文を埋め込む | **赤** — "keeps the password plaintext out of the stored verifier"（＋ verify が壊れるためログイン系5本） |
| 5 | `identityDirectory/resetTokenCrypto.ts` | 行のハッシュを `SHA-256(secret)` から `SHA-256(tokenId)` へ（旧バグの再現） | **赤** — resetToken 3本 |
| 6 | `application/di/serverCloudflare.ts` | directory stub のエラーに `locator.doName` を混ぜる | **赤** — "keeps the canonical, its hmac and its locator out of a failing stub call…"（`Forbidden value leaked: dir:g1:b19`） |
| 7 | `search/probe.ts` | `bm25(search_fts, 3.0, 1.0)` → `(1.0, 1.0)` | **赤** — "ranks a title hit above a body hit…" のみ |
| 8 | `userData/facade.ts` | `operation.payloadDigest !== args.payloadDigest` を `false` へ | **赤** — "replays phase 2 idempotently, and refuses a replay with another payload" のみ |
| 9 | `packages/core/src/lib/jobKind.ts` を `touch`（ビルド後） | dist を古くする | **赤** — smoke の `beforeAll`、`exit=1` |

クリーンアップ側の再実測（同じく revert 済み）:

| 対象 | 壊し方 | 結果 |
|---|---|---|
| `__tests__/setup.ts` | `await reset();` を削除 | **赤** — `cleanup.integration.test.ts (2 of 2)`（1本だけ） |
| `__tests__/setup.ts` | `await evictAllDurableObjects();` を削除 | **緑のまま**（175件） |

不安定性の原因究明のための一時注入（同じく revert 済み。`git status` clean）:

| 対象 | 注入 | 結果 |
|---|---|---|
| `resetToken.integration.test.ts` | `deliver()` の前に 2000ms 待つ | **赤**（決定的）— プラットフォーム配信が noop sender でジョブを先に消費 |
| `identity.integration.test.ts` | `deliverDueMail(email)` の前に 2000ms 待つ | **赤**（決定的）— `expected [] to deeply equal [ 'user-29@example.com' ]` |

---

#### カバレッジ

確認 65 件 / スキップ 183 件（合計 248 件、変更ファイル一覧と1対1）。

**確認の粒度**: テストファイル・テスト設定・テスト用ドキュメントは差分ないし全文を読み、主要なものは実行と変異試験で検証した。ケース名の一覧だけを確認したファイル（`envelope` / `mailSender` / `stubErrors` / `payloadDigest` / `registry` / `normalize` / `jobKind` / `restoreError` / `credentialMappingRules` / `secrets` / `requestContainerConfig` / `stateContainerConfig` / `projection` / `migration` / `sendMail` / `directoryJobs` / `mappingOperations` / `table` / `occ`）は、テスト名と主張の対応まで見て確認とした。実装側ファイルは、対応するテストの十分性を `__tests__` 側で判定する形をとった（1回目と同じ方針）。

- 確認: `.adr/001-integration-tests-single-workers-pool.md`
- スキップ: `.adr/003-sqlite-fts5-only-search.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- 確認: `.github/workflows/ci.yml`
- スキップ: `.thread/37/adr.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- 確認: `.thread/37/plan.md`
- スキップ: `.thread/37/review/review-001-adapter-infra.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-domain-usecase.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-presentation-config.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-security.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- 確認: `.thread/37/review/review-001-test.md`
- スキップ: `.thread/37/review/review-001.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- 確認: `.thread/37/review/triage.md`
- スキップ: `.thread/37/steps.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/testing.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `CLAUDE.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- スキップ: `README.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- スキップ: `apps/web/.dev.vars.example` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- 確認: `apps/web/__tests__/boot.smoke.test.ts`
- スキップ: `apps/web/app/components/auth/LoginForm/action.ts` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/auth/SignupForm/action.ts` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/settings/CurrentUserPanel/index.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/settings/LogoutButton/action.ts` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/settings/SettingsSkeleton/index.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- 確認: `apps/web/app/durable-objects/__tests__/env.d.ts`
- 確認: `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts`
- 確認: `apps/web/app/durable-objects/identityDirectory.ts`
- スキップ: `apps/web/app/durable-objects/userData.ts` — DO クラス。エントリ表の全数と fail-closed は rpcEntries.integration.test.ts が実行検査している
- スキップ: `apps/web/app/presentation/__tests__/currentUser.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `apps/web/app/presentation/__tests__/errorResponse.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `apps/web/app/presentation/__tests__/session.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `apps/web/app/presentation/authState.ts` — 実装側。対応テストは1回目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/currentUser.ts` — 実装側。対応テストは1回目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/errorResponse.ts` — 実装側。対応テストは1回目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/session.ts` — 実装側。対応テストは1回目に審査済みで今回差分なし
- スキップ: `apps/web/app/routes/_app/settings.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/server.cloudflare.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/__tests__/env.d.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `apps/web/app/worker/cloudflare/consumer.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/dlq.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/handlers.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/pruner.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/relay.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/state.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/drizzle.config.ts` — D1 撤去に伴う削除。対象消滅で等価テストは不要
- 確認: `apps/web/package.json`
- スキップ: `apps/web/scripts/render-wrangler.ts` — ビルド設定・スクリプト。成果物が起動するかは boot.smoke.test.ts で確認済み
- スキップ: `apps/web/vite.config.cloudflare.ts` — ビルド設定・スクリプト。成果物が起動するかは boot.smoke.test.ts で確認済み
- スキップ: `apps/web/vite.config.state.ts` — ビルド設定・スクリプト。成果物が起動するかは boot.smoke.test.ts で確認済み
- スキップ: `apps/web/wrangler.production.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.request.production.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.request.staging.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.staging.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.state.production.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.state.staging.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.state.toml` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.toml` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `docs/backend_implementation_example.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- スキップ: `docs/runtime_cloudflare.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- 確認: `docs/test.md`
- スキップ: `infra/cloudflare/pulumi/resources/Pulumi.production.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/resources/Pulumi.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/resources/index.ts` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/routes/Pulumi.production.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/routes/Pulumi.yaml` — IaC 定義。テストスイートから参照されない
- 確認: `package.json`
- スキップ: `packages/core/package.json` — パッケージ定義。テストスクリプトはルート package.json 側で確認済み
- 確認: `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/directoryLocator.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/env.d.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/setup.ts`
- 確認: `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/directoryLocator.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/mappingOperations.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts`
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/payloadDigest.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/registry.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/runner.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/jobs/table.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/mailSender.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/platform/envelope.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- スキップ: `packages/core/src/adapters/cloudflare/platform/stubErrors.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/schema/gate.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/schema/types.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/schema/userData.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts`
- 確認: `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/search/normalize.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/search/probe.ts`
- スキップ: `packages/core/src/adapters/cloudflare/search/projection.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/adapters/cloudflare/sql/errors.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/sql/exec.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/sql/occ.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/userData/accountStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/adapters/cloudflare/userData/facade.ts`
- スキップ: `packages/core/src/adapters/cloudflare/userData/trashQuery.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/env.d.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/helpers.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/setup.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/d1/client.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/migrations/0000_initial.sql` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/migrations/meta/_journal.json` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/pendingBatch.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/helpers.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/idempotencyStore.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/outboxRepository.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/userRepository.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/schema.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/d1/unitOfWork.ts` — D1 撤去に伴う削除。後継テストの十分性を cloudflare/ 側で判定済み
- スキップ: `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/application/__tests__/helpers.ts`
- 確認: `packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts`
- 確認: `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts`
- 確認: `packages/core/src/application/di/__tests__/routingNonExposure.test.ts`
- 確認: `packages/core/src/application/di/__tests__/secrets.test.ts`
- スキップ: `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- 確認: `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts`
- スキップ: `packages/core/src/application/di/containerStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/di/env.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/application/di/facades.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/di/secrets.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/application/di/serverCloudflare.ts`
- スキップ: `packages/core/src/application/di/stateCloudflare.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/di/types.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/errors.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/events/buildDecoder.ts` — イベント機構の削除。対象消滅で等価テストは不要
- 確認: `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts`
- スキップ: `packages/core/src/application/execution/jobs.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/execution/unitOfWork.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/identity/__tests__/eventDecoders.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- 確認: `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- スキップ: `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/application/identity/__tests__/logout.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- 確認: `packages/core/src/application/identity/__tests__/requestPasswordReset.test.ts`
- スキップ: `packages/core/src/application/identity/eventDecoders.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/application/identity/getCurrentUser.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/identity/loginWithPassword.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/identity/registerWithPassword.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/identity/requestPasswordReset.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/application/identity/signupSaga.ts`
- スキップ: `packages/core/src/application/identity/view.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/ports/idGenerator.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/application/ports/idempotencyStore.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/application/ports/outboxRepository.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/application/ports/relayTrigger.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/application/ports/sessionCodec.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- 確認: `packages/core/src/application/rpc/__tests__/restoreError.test.ts`
- スキップ: `packages/core/src/application/rpc/restoreError.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/application/workers/__tests__/outboxPrune.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/application/workers/eventRelayWorker.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/application/workers/outboxPrune.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/domain/common/event.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/domain/common/transactionalRepository.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- 確認: `packages/core/src/domain/identity/__tests__/credentialMappingRules.test.ts`
- スキップ: `packages/core/src/domain/identity/__tests__/entity.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- 確認: `packages/core/src/domain/identity/__tests__/noRawNul.test.ts`
- スキップ: `packages/core/src/domain/identity/__tests__/valueObject.test.ts` — 1回目のレビューで審査済み。今回の修正差分が無く、再審議の対象外
- スキップ: `packages/core/src/domain/identity/credentialMappingRules.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/domain/identity/entity.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/domain/identity/errorCode.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/domain/identity/events.ts` — イベント機構の削除。対象消滅で等価テストは不要
- スキップ: `packages/core/src/domain/identity/ports/accountStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/credentialLocatorStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/credentialMappingRepository.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/credentialMappingStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/mailSender.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/userRepository.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/userSettingsRepository.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/valueObject.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- 確認: `packages/core/src/lib/__tests__/jobKind.test.ts`
- スキップ: `packages/core/src/lib/directoryLocator.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/lib/errorIdentity.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/lib/jobBudgets.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/lib/jobKind.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/lib/passwordHashing.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/lib/rpcEnvelope.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `packages/core/src/lib/secretLengths.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み
- スキップ: `pnpm-lock.yaml` — 生成物。miniflare 追加／drizzle 削除は package.json 側で確認済み
- スキップ: `spec/database/index.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/domains/identity.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/inventory/adapter.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/inventory/domain.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/inventory/usecase.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/manual-tests/search.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/testcases/identity/unlinkSsoCredential.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/usecases/identity.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- 確認: `vitest.config.integration.ts`
- 確認: `vitest.config.smoke.ts`
- 確認: `vitest.config.ts`
