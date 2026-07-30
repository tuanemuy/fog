# レビュー 009 — 非同期処理・UoW 契約・migration 設計

対象: PR #43 / ブランチ `issue/34/do-boundary-design` / Issue #34（対応項目4）
主成果物: `.thread/34/design.md`（2,471行）、`.adr/003`、`.adr/004`
前提: 鍵ローテーション手順の未決は Issue #44 へ切り出し済み。Blocker として扱わない。

## 実施した検証

1. `CLAUDE.md`（Unit of Work / Outbox / Retry strategy / Error handling）
2. `gh issue view 34` の対応項目4
3. `.thread/34/design.md` 全文
4. **第1.4節の検査1〜9 を実際に実行**（結果は N-001）
5. 既存コードとの突き合わせ（`adapters/d1/`、`application/errors.ts`、`application/`、`domain/`、`apps/web/app/worker/cloudflare/`、`application/di/`）
6. **Cloudflare / SQLite 公式ドキュメントの実取得**（結果は N-002）
7. 第8.2節の UoW 型契約を実際に `tsc` に通して検証（結果は N-003）

## 非同期処理・UoW・migration

### Blockers

なし。

再武装3分類 (A)(B)(C) と投入点の閉じ方、`done` / `poison` からの復帰規則、FTS5 同期更新と external-content の実装制約、UoW 契約と既存ポートの整合、OCC の実現手段、第7.7節と第7.4節の整合、Alarm の3階層件数上限と `alarm()` 先頭順序、lazy migration の両ゲート／カーソル／forward-only／fail-closed のいずれにも、技術的に成立しない結論・事実誤り・自己矛盾は見つからなかった。

### Warnings

- **[W-001]** migration ゲートが投入したジョブに対する `setAlarm` の発行主体が、`run()` を呼ばない RPC 経路について決まっていない
  - 場所: `.thread/34/design.md:1708-1712`（「通常の DO 入力（RPC）での再設定は、DO facade のラッパーが `run()` の戻り後に発行する。実行主体をここで名指しする」）× `.thread/34/design.md:2049-2050`（「ゲートの中で `enqueueJob('migrate-bulk', ...)` を発行する」「同じくゲートの中で `enqueueJob('reindex', ...)` を発行する」）
  - 理由: 第7.4節は Alarm 経路（先頭で `setAlarm` + `sync()`）と RPC 経路（`run()` の戻り後）の2つについて発行主体を名指しし、「誰がいつ呼ぶかを決めないと #37 に落ちる」と明言している。ところが migration ゲートは `run()` の**前**に自分の `transactionSync` で走り、しかもゲート自身は「`schema_version` の読み取りから全 DDL ステップの適用まで `await` を1つも挟まない」（`:2022`）と定められているので、`sync()` を要する `setAlarm` を**ゲートの中では発行できない**。したがってゲートが投入したジョブの arming は「ゲートの外・`run()` の後」でしか行えないが、`run()` を呼ばない RPC（`UnitOfWorkContext` を経由しない projection 読み。第4.3節 行10 の `SearchIndexPort.query` が該当しうる）では発行点が存在しない。
    - 帰結は dormant DO では実害になる。第7.4節の `deleteAlarm()` 規則により実行可能集合が空の DO には alarm が張られていないので、「新リリース → 読み取りだけの RPC が来る → ゲートが DDL を適用し `schema_version` を進め `migrate-bulk` / `reindex` を投入 → alarm が張られない」の順序で、**投入されたのに起動されないジョブ行**が残る。`migrate-bulk` 側は第9.3節の両対応読みがあるので正しさは保たれるが、`reindex` 側は第9.2節 条件2 の4段分解（新仮想表を作る → `reindex` → 参照先の切り替え → 旧表を落とす）の2段目が止まるため、切り替え後の検索が空を返す方向に倒れうる。
    - 第7.4節が Alarm 経路について「先頭で再武装する」まで踏み込んで塞いだ失敗モード（dormant DO のジョブ恒久停止）と同じ形の穴が、RPC 経路のゲート投入について1つ残っている。
  - 提案: 第7.4節の RPC 経路の規約に1文を足す。「**ゲートがジョブを投入した場合は、`run()` の有無にかかわらずゲートから戻った直後に `setAlarm` + `await ctx.storage.sync()` を発行する**」（発行値は既存規則どおり DB の最早 `nextRunAt`、過去・現在なら現在時刻+1秒へ clamp）。あるいは「DO facade のラッパーは**全 RPC エントリ**について、ゲートと本体処理の後に1回だけ再設定を行う（`run()` を呼ばない RPC も対象）」と射程を広げる。どちらでも `await` はゲートの外なので `:2022` の排他条件は破れない。

- **[W-002]** 検査8 の列一覧の件数を数え直すコマンドが、自己参照で終端せず動作しない
  - 場所: `.thread/34/design.md:291`（`# 期待: 出力なし（一覧は61件。件数は \`awk '/<<.COLS./{f=1;next} /^COLS$/{f=0} f'\` で数え直せる）`）
  - 理由: 実測すると 61 ではなく **2,242行**を出力する。原因は2つ重なっている。(i) 終端パターンが `/^COLS$/` だが実ファイルの終端行は2スペース字下げの `  COLS`（`:290`）なので一致しない。(ii) より根本的に、**注記行 `:291` 自身が `<<.COLS.` という文字列を含む**ため開始パターン `/<<.COLS./` に再ヒットし、`/^ *COLS$/` へ直しても `f=1` が再点火して以降ファイル末尾まで出力し続ける（実測 2,241行）。したがって「61件」は本文が主張する値としては正しい（`:229-289` の61行）が、**添えられたコマンドでは検証できない**。
    - 第1.4節は R8 の反省として「注記に数を書く形そのものを廃止し、左辺と右辺を両方コマンドで出して `ok` 関数で突き合わせる」（`:68`, `:197`）と決めているのに、検査8 の側は「注記の数 + 動かない再カウントコマンド」という R8 で廃止したはずの形のまま残っている（`61` は I-8 の grep パターンにも検査7b の `P` にも掛からないので機械検出されない）。
  - 提案: 注記のコマンドを終端が自己参照しない形へ直し、かつ左辺・右辺の突き合わせにする。例: `` awk 'f&&/^ *COLS$/{exit} f&&/:/{n++} /done <<.COLS.$/{f=1} END{print n}' `` のように**開始パターンを `done <<'COLS'` の行に限定**して（注記行に一致しないようにして）数え、期待値を注記に書かずに `ok` 関数で `61`（= while ループが読む行数）と突き合わせる。あるいは検査8 の一覧をヒアドキュメントから外部化せず、`61` という数そのものを本文から落とす（I-8 の「表を持たない列挙には数を書かない」に合わせる）。

### Notes

- **[N-001]** 第1.4節の検査1〜9 を全項目実行し、**すべてパスした**。実測値も注記どおりである。
  - 検査1（I-3）: E-3 の `kind` = 12件、E-1 の `jobs` 2行の列挙と `diff` 一致、`rotate-remap` はどちらにも0件。
  - 検査2（I-1 / I-2）: 投入点の空欄なし。(A) 3 / (B) 2 / (C) 7。(1-A) 表3行・(1-B) 表2行と `diff` 一致。分類が2つを名乗る行なし、(1-A)/(1-B) 両方に現れる `kind` なし。
  - 検査3（I-5）: 非集約ストア7行、書き込み口の識別子7つがすべて第8.2節のコードブロックに実在、「アダプター専用」は `_meta` の1件だけ。
  - 検査4（I-7）: 第7.7節 項2 の4類型が12件を重複なく覆い、E-3 と `diff` 一致。
  - 検査5（I-6）: クラス (3) は12行、4群の割り当て合計は 5+2+3+2 = 12。
  - 検査6（I-4）: テーブル行16、名指しされた16テーブルすべてが E-1 に実在。
  - 検査7a: 「新設する秘密は4つ」「`jobs` は12列」「各クラス6種・合計12種」がいずれも本文と一致。
  - 検査7b: grep ヒット数 8 = `ok` 呼び出し回数 8、`NG` は0行（15 / 1 / 6 / 35 / 20 / 12 / 10 / 10）。
  - 検査8（I-4 逆向き）: 列一覧61件すべてが E-1 の該当行に実在（**ただし件数の再カウントコマンドは W-002**）。
  - 検査9（I-5b）: E-2 の「書き込み箇所」欄に取りこぼしなし（除外リスト4件は本文どおり非書き手）。

- **[N-002]** 依拠している Cloudflare / SQLite 公式記載を実取得して照合し、**非同期・UoW・migration に関わる事実はすべて原文どおりだった**。
  - `/durable-objects/api/alarms/`: `setAlarm(scheduledTimeMs): void` / `getAlarm(): number|null` / `deleteAlarm(): void`、"Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."、"exponential backoff starting at a 2 second delay from the first failure with up to 6 retries"、1 DO 1 alarm・`setAlarm` は上書き。**wall time / duration の記載は無い**（F-2 / F-3 / F-29 / F-30 の「alarms ページは wall time を述べていない」まで含めて一致）。
  - `/durable-objects/api/storage-api/`: `sync()` = "Synchronizes any pending writes to disk."、`transactionSync` の "The callback must complete synchronously, that is, it should not be declared async nor otherwise return a Promise."、`transaction()` の "the txn object is obsolete … will be considered part of the transaction" / "Explicit transactions are no longer necessary. Any series of write operations with no intervening await will automatically be submitted atomically"、"put() writes to an in-memory write buffer that is flushed to disk asynchronously." / "either all of the writes will have been stored to disk or none"、同ページの alarm 3メソッドは `Promise` 返却。**F-7 / F-27 / F-27b / F-28 / F-30 / F-31 が原文どおりで、公式内不整合（alarms ページ `void` × storage ページ `Promise`）も実在する。**
  - `/durable-objects/platform/limits/`: FAQ が "maximum CPU time per Durable Objects invocation (HTTP request, WebSocket message, or Alarm) is set to 30 seconds"、footnote が "Each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds"（Alarm / RPC は**含まれない**）、"Alarm handler invocations have a maximum wall time of 15 minutes"、1,000 req/s soft limit、LIKE/GLOB 50 bytes・100列・2 MB・100 KB・100 params。**F-3 / F-4 / F-4b / F-16 / F-17 / F-19 が一致し、F-4b の「同じページの2文が別のことを述べており決着しない」という判定も正しい。**
  - `/durable-objects/api/sql-storage/`: "sql.exec() cannot execute transaction-related statements like BEGIN TRANSACTION or SAVEPOINT"、"Although a cursor object can technically be held across an await, it does not provide a stable snapshot"、`rowsWritten` = "The final value is used for SQL billing" + 索引の1行更新は追加1行。**F-8 / F-9 と第8.4節の「`rowsWritten` は課金単位でマッチ行数ではない」が一致。**
  - `/workers/reference/security-model/`: "the value returned by Date.now() is locked in place while code is executing" / "Date.now() returns the time of the last I/O. It does not advance during code execution."。**F-32 が原文どおりで、第7.4節が経過時間を打ち切り条件から外した根拠は成立している。**
  - `/durable-objects/api/sqlite-storage-api/`: 拡張は FTS5（`fts5vocab` を含む）/ JSON / Math の3つだけで **bm25・snippet・highlight・trigram は一語も無い**、PITR は過去30日・DB 全体・ローカル開発では非対応、"Writing data to SQLite virtual tables also counts towards rows written."。**F-10 / F-15 / F-20 が一致。**
  - `sqlite.org/lang_altertable.html`: "the execution time of such ALTER TABLE commands is independent of the amount of data" / "adding new columns that have CHECK constraints, or adding generated columns with NOT NULL constraints, or when deleting columns … takes time that is proportional to the amount of content"。**第9.2節のデータ量依存／非依存の切り分けが原文と完全一致（3操作の列挙まで）。**
  - `sqlite.org/fts5.html`: `'rebuild'` = "first deletes the entire full-text index, then rebuilds it based on the contents of the table or content table"、**増分・再開の手段は無く**、増分実行を許すのは `merge` / `usermerge` / `automerge` / `optimize` のみ、external content は自動 populate されず delete には旧値が必要（"must supply data matching what is currently stored"）、tokenizer は `CREATE VIRTUAL TABLE` の `tokenize` オプションで設定し**既存表の tokenizer を変更する手段の記載は無い**、"Whenever column values are required by FTS5, it queries the content table"。**第7.1節の実装制約2点、第9.2節の `'rebuild'` 棄却、`tokenize` 変更の4段分解、`content_rowid` の索引要求がすべて原文で裏付けられる。**
  - `sqlite.org/optoverview.html`: "the cost of constructing the automatic or query-time index is O(NlogN) (where N is the number of entries in the table)"。**第9.2節の `CREATE INDEX` 分割不能・条件4 の根拠が原文どおり**（`CREATE INDEX` への適用が推論であることは本文が明示している）。

- **[N-003]** 第8.2節の「`T extends Promise<unknown> ? never : T` を課すと `async` 関数はコールバックとして渡せなくなる」を実際に `tsc`（リポジトリ同梱、`--strict`）で確認した。`p.run(async (c) => c.x)` と `p.run((c) => Promise.resolve(c.x))` はどちらも `TS2322: Type 'Promise<number>' is not assignable to type 'never'.` になり、同期コールバックは `T = number` が正しく推論される。**条件型を推論位置に置いたために型が骸になる、という懸念は当たらない。** 設計の最も高価な決定（ドメインポートから `Promise` を剥がす）の前提が型システム上成立している。

- **[N-004]** 引用している実装の事実・行番号をすべて実ファイルで照合し、**食い違いは1件も無かった**。
  - `packages/core/src/application/errors.ts`: `SystemErrorCode` は6値（`DatabaseError` / `DataIntegrityError` / `CryptoError` / `SessionError` / `NetworkError` / `ExternalApiError`）、`RETRYABLE_SYSTEM_CODES` は `:206-210` で `NetworkError` / `ExternalApiError` の2値。`retryable` を override するのは `SystemError`（`:215`）だけなので、`ConflictError` は `packages/core/src/lib/error.ts:35-37` の既定 `false` を返す。**第4.7節の `retryable` 欄4行すべてが実装の集合から正しく導出されている。**
  - `apps/web/app/presentation/errorResponse.ts`: `HTTP_STATUS_BY_KIND`（`:101-110`）は `kind` だけを見て `system: 500`、`serializeError` は `:70`。**第4.7節の「500 で返す・`code` 分岐を持ち込まない」が実装と整合。**
  - `packages/core/src/application/execution/unitOfWork.ts` は19行で `userRepository` + `collectEvents` のみ、`run` は `Promise` 版。`adapters/d1/unitOfWork.ts:39` に "Read-your-write within the same UoW is unsupported by design"。`pendingBatch.ts` は98行。`schema.ts:118` に `OCC_GUARD_CHECK_NAME = "occ_guard_positive"`。`repositories/helpers.ts:55-69` が `isOccGuardViolation`。**第8.1節の3行と第11.2節の新旧対比が正確。**
  - `UserRepository` は `insert` / `save` / `findById` / `findByEmail` の4本のみで `findBySsoIdentity` は存在しない（第2.3節どおり）。`TransactionalRepository` は4メソッドすべて `Promise`（第8.2.1節「変わるもの」表どおり）。
  - `domain/common/event.ts` 81行 / `domain/identity/events.ts` 62行 / `entity.ts` 227行（`:36` が `User = PasswordUser | SsoUser`、`:52` / `:77` / `:103` / `:120` が `WithEventDrafts<...>` 戻り）/ `application/events/buildDecoder.ts` 37行 / `workers/eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 / `worker/cloudflare/handlers.ts` 138行（`handleQueue` `:82` / `handleDlq` `:120`）。`registerWithPassword.ts` の `:46` / `:52` / `:56`。**第7.3節の削除・改修の全数と行数がすべて一致。**
  - `adapters/d1/` は20ファイル / 2,514行、うち非テストの `.ts` が8ファイル / **914行**（`client.ts` 14 + `pendingBatch.ts` 98 + `repositories/helpers.ts` 102 + `idempotencyStore.ts` 26 + `outboxRepository.ts` 227 + `userRepository.ts` 172 + `schema.ts` 145 + `unitOfWork.ts` 130）。`0000_initial.sql` の実テーブルは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つ。
  - `application/di/types.ts` は `RequestContainer`（`:53`）と `WorkerContainer`（`:70`）の2つだけ、`:35-47` の JSDoc が `collectEvents` を「唯一の経路」と説明（第11.2節の「`:37` 付近の JSDoc も同時に書き換える」が妥当）。`containerStore.ts` は `Symbol.for` スロットのみで `AsyncLocalStorage` を import しない。ALS の実体は `apps/web/app/server.cloudflare.ts:4`（import）/ `:33`（`installContainerStore`）/ `:44`（`storage.run`）。
  - `apps/web/package.json` の deploy 系は24本（非 dry 12本）、`db*` は10本。`apps/web/wrangler.toml` は162行で `durable_object` の出現0。両 `.tpl` の `FNR==21` が `main = "app/server.cloudflare.ts"`。

- **[N-005]** 12種の収束を1件ずつ追跡し、**(A)(B)(C) の割り当てと投入点で実際に閉じることを確認した。** (A) の3種（`purge-trash` / `sweep-reservations` / `sweep-reset-tokens`）と (B) の2種（`sweep-orphan-mapping` / `rotate-encryption`）はいずれも投入点が繰り返し呼ばれる操作（ソフトデリート・retention 変更 / signup 予約 / トークン発行 / unlink / operator RPC）に紐づいており、`done` からの復帰規則（分類 (A)(B) 限定）で平常時の `done` から確実に復帰する。(C) の7種は投入点が「1回分の仕事」に対応し、`operationKey` に対象の同一性（`targetVersion` / `operationId` / アカウント / canonical HMAC + 窓）を含むので `done` の非復帰が正しい。**`:1652` が「分類 (C) の `done` 行は戻す手段を持たない終端である」と明記しているので、`done` / `poison` の復帰規則に読み手へ委ねられた分岐は残っていない。**
  - `poison` は分類にかかわらず再投入で `pending` へ戻る規則があり、投入点が再発火しない (C) の `migrate-bulk` / `reindex` については **`operationKey` が `targetVersion` を含むため修正リリース（新 `targetVersion`）が別行として新規投入される**という forward-only の回復経路が構造的に存在する。第9.3節・第9.5節の forward-only 方針と整合している。
  - `finalize-withdrawal` が「未完了 unlink 行が0件」を満たさないときに次の起動へ回す機構は、(1-B) の残件駆動ではなく **(iii) の内部カーソルジョブとしての中断（`:1670` の (iii-b)）と、失敗時の `attempt` バックオフ（第7.7節 項5）**で足りる。`:1340` / `:1467` が「第7.4節 (1-B)」を参照しているのは (1-B) 節に噛み合いの説明が置かれているためで、`finalize-withdrawal` を分類 (B) と主張しているわけではない（分類欄は (C) のままで I-2 も破れていない）。

- **[N-006]** Alarm の CPU 有界性について、3階層の上界と (iii-b) の同一起動再 claim 禁止が実際に上界を確定させることを確認した。1件あたりの上界が「中間 × 内側」、1起動あたりが「25 × 中間 × 内側」で、両者を区別する `:1727` の記述が第9.2節の「外側の25件は `migrate-bulk` 1件に対して一度も発火しない／効く保護は中間と内側の2つだけ」と整合している。除外集合を揮発値として `jobs` に列を足さない判断も、claim 述語（`status='pending' OR (status='running' AND leaseUntil < ?)`）が解放直後の行に一致してしまう問題を過剰な永続化なしに塞いでいる。`alarm()` 先頭順序（(1) 再武装 + `sync()` → (2) ゲート → (3) 仕事）と `deleteAlarm()` の述語（実行可能集合が空）、fail-closed 経路の「意図的に消さない」例外の3つが互いに矛盾していない。

- **[N-007]** 第7.7節（正文）と第7.4節（`kind` 全数表）のあいだに「両立しない2つの記述」は残っていない。項2 が「外部 I/O は必ず載る側の条件であって、載るものの全数ではない」と明記し、4類型表が12種を1回ずつ覆っている（検査4 で機械確認）。`.adr/004` の決定節も同じ言い方（「外部 I/O を伴う処理は必ずこちらに載るが、それが載るものの全数ではない」）で書かれており、ADR と設計書のあいだにもずれが無い。

- **[N-008]** OCC の実現手段は実装可能である。`UPDATE ... WHERE id = ? AND version = ? RETURNING 1` は SQLite 3.35+ の機能で、`sql.exec()` は `BEGIN`/`SAVEPOINT` 以外の文を制約なく実行できる（公式記載）。`rowsWritten` を棄却した理由（課金単位であってマッチ行数でない）は公式定義と一致し、`SELECT changes()` を第二候補として第11.4節の spike 一覧へ送っている扱いも妥当である。`version` 列を持つのは集約ルート3つ（`account` / `user_settings` / `ai_client_connections`）だけという断定は、`spec/database/index.md` の現行規約の延長として一貫している。
