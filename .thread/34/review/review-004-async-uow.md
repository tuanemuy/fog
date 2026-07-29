# レビュー 004 — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design`
**主成果物:** `.thread/34/design.md`（1,913行）、`.adr/003-sqlite-fts5-only-search.md`、`.adr/004-do-local-commit-and-alarm-jobs.md`
**観点:** 非同期処理・UoW 契約・migration 設計
**日付:** 2026-07-30

## 検証の方法

ゼロベースで実施した。前回までのレビュー指摘は読んでいない。

1. `CLAUDE.md` の「Unit of Work」「Outbox / domain events」「Retry strategy」「Error handling」を読んだ。
2. `gh issue view 34` の対応項目4（FTS5 同期更新 / Alarm / UoW 契約 / lazy migration）を読んだ。
3. `.thread/34/design.md` を全文読んだ。
4. 引用されている実装を実ファイルで照合した（下記 N-003）。
5. **Cloudflare 公式ドキュメント11ページを実際に取得し、第2.1節の事実表 F-1〜F-32 を1行ずつ突き合わせた**（下記 N-001）。
6. 第8.2節の UoW 型契約を実際に `tsgo` / `tsc` でコンパイルして検証した（下記 N-002）。

## 非同期処理・UoW・migration

### Blockers

- **[B-001]** 反復・周期的に再武装が必要なジョブ（`purge-trash` / `sweep-*`）の「次回分の `nextRunAt` を誰がいつ書くか」の規則が無く、しかも第7.4節の収束規則がそれを構造的に禁じている。設計内の別々の断定どうしが矛盾している。
  - 場所: `.thread/34/design.md:1196`（収束規則）/ `:1270`・`:1271`（第7.5節の Alarm の張り方）/ `:228`（第4.1.1節「`purge_after` の最小値をそこへ写す」）/ `:1238`（正常完了時の再設定）/ `:1220`（`sweep-*` の「残りを次の起動へ回す」）
  - 理由:
    - 第4.1.1節 `:228` は「Alarm は `jobs` の `nextRunAt` で駆動し、**`purge_after` の最小値をそこへ写す**」と断定し、第7.5節 `:1271` は retention 設定変更時に「最早値を求めて **Alarm を張り直す**」と断定している。ところが第7.4節 `:1196` の収束規則は「再投入は `nextRunAt` を**早める方向にのみ**更新し、遅らせない。既存行の `nextRunAt` より早い値で再投入されたら更新し、**同じか遅ければ何も書かずに成功を返す**」である。**`trashRetentionDays` を延長したときは `min(purge_after)` が後ろへ動くので、「最小値を写す」と「遅らせない」は同時には成立しない。** 収束規則に従う限り第4.1.1節・第7.5節の断定は実装できない。
    - より重いのは**完走後の再武装が誰の責務か決まっていない**ことである。`purge-trash` が期限到達分を消去して正常完了した時点で、ゴミ箱にはまだ `purge_after` が未来の項目が残りうる。ところが (i) 収束規則は「遅らせない」ので新しい（より遅い）`nextRunAt` を書けず、(ii) `:1238` の正常完了時の再設定は「**DB の最早 `nextRunAt`**」＝ `jobs` テーブルだけを読み、`purge_after` を読み直さない。(iii) 残る `pending` 行が無ければ `:1239` の規則で `deleteAlarm()` する。**結果、次の期限が来ても DO は二度と起きない。** dormant な User Data DO には次の DO 入力が無いので（`:1234` が自ら定義した状況）、**ゴミ箱の保持期限が誰にも気づかれずに無期限へ伸びる** —— 第7.4節が `finally` を棄却し、先頭再武装を導入し、RPC 経路で `sync()` 失敗時に RPC ごと落とすことまでして塞いだ、まさにその失敗モードが、retention の本体経路で開いたままになる。
    - `operationKey` の導出規則が `purge-trash` について定義されていないことも同根である。定数キー（例 `"purge-trash"`）にすると、1回目の完走で `status = 'done'` になった行が prune 保持期間のあいだ残り、その間の再投入が `:1196` の「既存行」に当たる。**収束規則は `status = 'running'` の扱いだけを定めており（`:1198`）、`done` / `poison` の行への再投入の扱いを定めていない。** 「何も書かずに成功を返す」と読むと retention が保持期間ぶん停止し、「新規行を作る」と読むと `operationKey` の同一性の意味が壊れる。逆に期限ごとの可変キー（例 `purge-trash:<purge_after>`）にすると、`:1196` の「早める方向にのみ」は `purge-trash` に対して一度も発火しない条件になり、`:1194` が収束規則を導入した論拠（retention 短縮の前倒し）そのものが成立しなくなる。
    - 同じ穴が `sweep-reservations` / `sweep-reset-tokens` にも当たる。`:1220` は「1回の起動で処理する行数に (iii-a) と同じ上限を掛け、**残りを次の起動へ回す**」と書くが、「次の起動」を誰が張るかは (iii-b) を持つ4種と違って書かれていない。予約 TTL や トークン期限は行ごとに違うので、最早の1件を処理した後に次の期限へ再武装する規則が要る。これが無いと第6.4節の TTL 掃除（3段ガードの1段目）も1回きりになる。
  - 提案: 第7.4節に「**周期・反復ジョブの再武装規則**」を1つ足し、第4.1.1節 `:228`・第7.5節 `:1270`〜`:1271`・第7.4節 `:1220` をそこへ帰着させる。最小限、次の3点を断定すればよい。
    1. **完了時の再計算を規則にする。** `purge-trash` / `sweep-*` は自ジョブの完了トランザクションの中で、自分の駆動源（`purge-trash` は `min(purge_after)`、`sweep-reservations` は `min(reservedUntil)`、`sweep-reset-tokens` は `min(expiresAt)`）を読み直し、**残件があれば自分の `nextRunAt` をその値へ設定してから完了する**（`done` にしない、または同一 `operationKey` で `pending` へ戻す）。残件が無いときだけ `done` にする。これは `:1238` の「正常完了時に DB の最早 `nextRunAt` へ張り直す」と同じ `transactionSync` に入るので往復は増えない。
    2. **収束規則の適用範囲を限定する。** 「早める方向にのみ」は**外部からの再投入（`enqueueJob`）**に対する規則であり、**ジョブ自身が完了時に行う再スケジュール**には適用しない、と明記する。これで第4.1.1節・第7.5節の「最小値を写す」と両立する。あわせて `status = 'done'` / `'poison'` の行に対する再投入の扱い（新しい実行として `pending` へ戻すのか、別行を作るのか）を1つに決める。
    3. **`purge-trash` の `operationKey` を明記する。** 上記1・2を採るなら定数キー（DO ごとに1行）が最も単純で、`:1194` の retention 短縮の前倒しもそのまま効く。

### Warnings

- **[W-001]** チャンク反復回数上限 (iii-b) に達したジョブの状態遷移が、claim の CAS と食い違っている。
  - 場所: `.thread/34/design.md:1216`（「そのジョブを `pending` のまま残して次の Alarm へ回す」）と `:1200`（claim の CAS が `SET status='running'`）
  - 理由: claim は `UPDATE jobs SET status='running', leaseUntil=?, ownerToken=? WHERE ...` なので、実行中のジョブは `running` である。「`pending` のまま残して」は文字どおりには claim を経ていないジョブについての記述になり、**claim 済みのジョブが (iii-b) で中断したときに `status` を `pending` へ戻すのか `running` のまま残すのかが決まらない**。`running` のまま残すと、次の Alarm 起動での再 claim 述語 `(status='pending' OR leaseUntil < ?)` がリース満了まで一致せず、**そのジョブだけがリース期間ぶん進捗を止める**。`migrate-bulk` は外側の25件上限が発火しないぶん (iii-b) が唯一の中断点なので（`:1508`）、影響は migration の所要時間に直接出る。
  - 提案: `:1216` に「(iii-b) で中断するときは、進捗カーソルのコミットと同じ `transactionSync` で `status` を `pending` へ戻し `ownerToken` / `leaseUntil` を解放する」の1文を足す。lease は `:1200` が定義するとおり「DO がリセットされた場合の回収手段」に用途を限定できる。

### Notes

- **[N-001]** **第2.1節の事実表 F-1〜F-32 を Cloudflare 公式ドキュメントで実地に検証したところ、確認できた全項目が正確だった。** 取得したのは `/durable-objects/platform/limits/`、`/api/alarms/`、`/api/storage-api/`、`/api/sql-storage/`、`/api/sqlite-storage-api/`、`/api/state/`、`/api/id/`、`/best-practices/error-handling/`、`/best-practices/rules-of-durable-objects/`、`/platform/pricing/`、`/reference/durable-objects-migrations/`、`/workers/reference/security-model/` である。とくに設計の中核を支える次が原文一致で確認できた。
  - **F-27**（`transaction()` の棄却根拠）— 「When using the SQLite-backed storage engine, the `txn` object is obsolete. Any storage operations performed directly on the `ctx.storage` object, including SQL queries using `ctx.storage.sql.exec()`, will be considered part of the transaction.」および「Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically」。第8.2.1節 (c) の棄却論拠 (1)(2) は原文どおり成立する。
  - **F-29**（alarm 操作が write buffer に掛かる）— 「Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations.」が原文どおり存在する。
  - **F-30**（公式内の不整合）— alarms ページは `setAlarm(): void` / `getAlarm(): number | null` / `deleteAlarm(): void`、storage API ページは `getAlarm(): Promise<Number | null>` / `deleteAlarm(): Promise`。**食い違いは実在する。** したがって「`setAlarm` を `await` して代用しない」「`getAlarm()` の同期性に依拠しない」という第7.4節の断定は正しい。
  - **F-31 / F-32** — `sync()` の定義文、および「`Date.now()` returns the time of the last I/O. **It does not advance during code execution.**」がいずれも原文どおり。第7.4節が経過時間による打ち切りを棄却した根拠は堅い。
  - **F-1 の「表と本文の不整合」も実在する** — 表は Free の per-object 値を持たないが、storage-full の説明文が「10 GB on Workers Paid, or 1 GB on the Free plan」と明記している。本書 `:103` の指摘は正確。
  - **F-18 の出典 `/best-practices/rules-of-durable-objects/` も確認した** — 「Input gates block new events (incoming requests, fetch responses) while synchronous JavaScript execution is in progress.」「Awaiting async operations like `fetch()` or KV storage methods opens the input gate, allowing other requests to interleave.」。第9.2節が同期ゲート関数の排他を input gate に帰着させる論法、および第6.9節の再入前提は公式記載に一致する。
  - **F-4b / F-32b / F-13 / F-14 / F-26 を「未確認」と分類したのも正しい。** Alarm / RPC が CPU リセットの契機に当たるかはドキュメントに肯定も否定も無く、`sql.exec()` が I/O に当たるかも無記載、`snippet()` / `highlight()` / trigram / `bm25` は sqlite-storage-api ページに一語も現れない。**種別（公式記載 / 実測 / 未確認）の付け方に誤りは見つからなかった。**
  - 補足1: F-5（DO ID の列挙 API が無い）を「列挙 API の不在は記載の不在による」と本書自身が注記しているのは正確である。明示的に否定する一文は公式に存在しない。
  - 補足2: F-10 の拡張リストは公式が "including" で列挙しており、**閉じたリストとは書かれていない**。本書は「明記されているのは3つだけ」と正しく書いており、閉じているとは主張していない。

- **[N-002]** **第8.2節の UoW 型契約は、主張どおりに機能することを実際にコンパイルして確認した。**
  ```ts
  run<T>(fn: (ctx: Ctx) => T extends Promise<unknown> ? never : T): T;
  ```
  この形で `tsgo` に掛けると、`async` コールバックと Promise を返す非 `async` コールバックの**両方**が `Type 'Promise<number>' is not assignable to type 'never'.` で落ち、同期コールバックは `T` が正しく推論される（`const a: number = provider.run(ctx => ctx.x + 1)` が通る）。条件型が推論サイトになるかは自明ではないので実測した。**`:1358`〜`:1359` の断定（「`async` 関数はコールバックとして渡せなくなる」「コールバックの中では `await` が構文エラーになる」）は成立する。**

- **[N-003]** **本書が引用している実装の事実を全件、実ファイルで照合した。誤りは1件も無かった。** 行番号・行数・件数まで一致している。
  - `packages/core/src/application/execution/unitOfWork.ts` = 19行、`UnitOfWorkContext { userRepository; collectEvents }` / `run<T>(fn) : Promise<T>` ✓
  - `packages/core/src/adapters/d1/unitOfWork.ts:39` に "Read-your-write within the same UoW is unsupported by design" ✓（`:130`行、`pendingBatch.ts` 98行）
  - `packages/core/src/adapters/d1/schema.ts:118` = `export const OCC_GUARD_CHECK_NAME = "occ_guard_positive";` ✓
  - `packages/core/src/adapters/d1/repositories/helpers.ts:55-69` = `isOccGuardViolation`（`String.includes(OCC_GUARD_CHECK_NAME)` でチェーンを辿る。`CHECK constraint failed: ` の前置きは見ていない）✓
  - `domain/common/transactionalRepository.ts` の4メソッドが全て `Promise`、`ExpectedVersion<T>` / `Versioned<T>` のブランド ✓ / `domain/identity/ports/userRepository.ts` は `insert` / `save` / `findById` / `findByEmail` の4本のみで `findBySsoIdentity` は無い ✓
  - `application/workers/` は `eventRelayWorker.ts`(301) / `outboxPrune.ts`(25) の2本だけで consumer / DLQ は無い ✓、`apps/web/app/worker/cloudflare/handlers.ts` = 138行、`handleQueue`:82 / `handleDlq`:120 ✓
  - `application/errors.ts` の `SystemErrorCode` は6値、`RETRYABLE_SYSTEM_CODES` は `NetworkError` / `ExternalApiError` の2つ ✓
  - `application/di/types.ts:53` = `RequestContainer`、`:70` = `WorkerContainer` ✓ / `di/secrets.ts` の3点（`MIN_SESSION_SECRET_LENGTH = 32`、ブランド型 `SessionSecret`、`RequestSecrets` の入れ子が rest-spread を防ぐ JSDoc）✓
  - `apps/web/app/presentation/currentUser.ts:17-26` / `:28-33`（"The authoritative guard"）、`authState.ts:18-23` ✓
  - `0000_initial.sql` の実テーブルは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つ ✓
  - `adapters/d1/` = 20ファイル / 2,514行、プロダクションコード（非 `__tests__` の `.ts`）8ファイル / 914行 ✓
  - `apps/web/package.json` の deploy 系24本 / `db*` 10本（`db:generate` / `db:generate:cf` を含む）✓ / `wrangler.toml` 162行 ✓ / `wrangler.staging.toml.tpl:21` = `main = "app/server.cloudflare.ts"` ✓

- **[N-004]** **第7.1節の FTS5 同期更新の結論と external-content の実装制約は正しい。**
  - 「external-content で消えるのは `%_content`（容量）であって rows written の主要因（`%_data`）ではない」は FTS5 の shadow table 構成として正確で、`:1092` が第4.6節・第10.2節の見積り方針をこれに整合させているのも正しい。公式の「Writing data to SQLite virtual tables also counts towards rows written.」も原文確認済み。
  - 「更新・削除は旧値で `'delete'` → 新値で insert の2段」は external-content FTS5 の必須手順であり、踏まないと例外が出ずにインデックスだけが壊れるという記述も正しい。
  - 「`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にする」は正しい選択である。`INTEGER PRIMARY KEY` は真の rowid alias なので `VACUUM` で再採番されず、`'delete'` コマンドに渡す rowid の安定性という要求を直接満たす。別列を `content_rowid` にする場合に UNIQUE と索引を必須にする論拠（FTS5 が列値取得のたびに content テーブルを引く）も正しい。
  - trigram / `bm25` が公式ドキュメントに一語も無いことを確認したうえで、実測1件を唯一の根拠として明示し、第2.1.1節に再現手順を置き、第11.4節で「覆れば `.adr/003` の決定そのものが成立しない」と書いているのは、根拠の弱さの扱いとして誠実である。

- **[N-005]** **第8.4節の OCC の実現手段の選び方が妥当である。** `rowsWritten` を棄却した根拠として引いている公式定義は原文確認できた（「The number of rows written so far as part of this SQL `query`. … The final value is used for SQL billing」「When writing data, every row update of an index counts as an additional row.」）。**課金単位であってマッチ行数ではない**という読みは正しく、0/非0 判定なら結果が同じでも意味論の一致しない値を正しさの拠り所にしない、という判断は `CLAUDE.md`「Retry strategy」の姿勢と整合する。`SELECT changes()` を第二候補に留めて第11.4節の spike へ送り、`UPDATE ... RETURNING 1` を第一候補にしたのも妥当（`RETURNING` は SQLite 3.35 以降で UPDATE / DELETE / INSERT に一様に効き、SQLite は RETURNING 出力を返す前に文全体を完了させるので、カーソルを完全に消費しなくても UPDATE の効果は確定する）。

- **[N-006]** **`alarm()` 先頭の順序（(1) 再武装 + `sync()` → (2) migration ゲート → (3) 仕事）は成立する。**
  - 公式は alarm ハンドラ内での `setAlarm()` を明示的に扱っていないが、`setAlarm` が「will override the existing alarm」である以上、発火中の alarm が残っていても消えていても結果は「`now + 再開間隔` に1本」に収束するので、順序の前提は破れない。
  - `deleteAlarm()` については公式が「Calling `deleteAlarm()` inside the `alarm()` handler may prevent retries on a best-effort basis, but is not guaranteed.」と書いているが、**本設計は `alarm()` から throw しない（第7.7節 項5）ので、リトライ抑止は害にならない。**
  - 「予期せぬエラーで DO が終了した場合、`alarm()` ハンドラは別マシンで再インスタンス化されうる（may）」も原文どおりで、"may" に寄りかからないという `:1248` の判断は正しい。
  - `:1229` の「(1) の `await` はゲートに入る前に完了しているので、ゲート内の同期性は破れない」は正しい。ゲート関数が完全同期である限り、その実行中に別イベントは配送されない。

- **[N-007]** **lazy migration の設計は #37 が着手できる粒度に達している。** `blockConcurrencyWhile` の30秒タイムアウト（公式確認済み）を根拠に排除し、代替の排他条件を「ゲート関数を同期にして input gate に任せる」として明示し、重い部分だけ `migrate-bulk` へ逃がす方針がその条件と両立することまで書いてある。forward-only + `migration_progress` による部分適用記録を「任意の最適化ではなく必須」と位置づけた根拠（CPU 予算超過はエラーではなくエビクションとして現れるので「例外が上がるから検出できる」が使えない）は、F-4 の公式記載から正しく導かれている。第9.4節の fail-closed を `alarm()` にも掛け、そこだけ `deleteAlarm()` 規則の例外にする扱いも整合している。

- **[N-008]** **第7.7節を非同期実行契約の正文として立て、第7.3節・第7.4節・第7.6節・第8.2節・第8.4節が双方向に参照する構造は、`CLAUDE.md`「Key concepts」の Outbox 項を置き換える形として適切である。** 規則の重複記述が無く、改訂点が1箇所に閉じている。項5（`alarm()` から throw せず個々のジョブ失敗を `try / catch` で吸収する）が `CLAUDE.md`「worker → root」で許された唯一の広い catch にあたる、という接続も正しい。

- **[N-009]** **第8.2.1節が `CLAUDE.md`「Reference runtime」の「`domain` / `application` / `presentation` は無傷」という明言の破れを隠さずに書き、#35 で `CLAUDE.md` を直すと決めている点**（`:1397`）は、Issue #34 の受け入れ条件（後続 Issue が本 Issue の成果物だけで着手できる）に対して重要な情報であり、正しく扱われている。

## 総評

Blocker 1件は「反復・周期ジョブの再武装規則の欠落」で、収束規則の適用範囲を1文で限定し、完了時の再計算を規則化すれば閉じる。それ以外に、非同期処理・UoW 契約・migration の範囲で技術的に成立しない結論・事実誤り・自己矛盾は見つからなかった。とくに **Cloudflare 公式ドキュメントの事実表（F-1〜F-32）と、引用されている実装の事実は、実地に照合した限り全件正確である。**
