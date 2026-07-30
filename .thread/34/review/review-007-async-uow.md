# レビュー 007 — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design` / Issue #34 対応項目4
**主対象文書:** `.thread/34/design.md`（2,270行）、`.adr/003` / `.adr/004`
**ラウンド:** 7（前回指摘を前提にせずゼロベースで実施）
**実施日:** 2026-07-30

## 実施したこと

1. `CLAUDE.md` の Unit of Work / Outbox / Retry strategy / Error handling を読了。
2. `gh issue view 34` で対応項目4 を確認。
3. `.thread/34/design.md` を全文読了（第1〜11章）。
4. **第1.4節の検査1〜7 をリポジトリルートで実際に実行**（結果は N-001）。
5. 引用されている実装事実を実ファイルで照合（N-002）。
6. Cloudflare / SQLite の公式ドキュメントを実取得して事実表 F-* を裏取り（N-003）。
7. 先行ブランチ `origin/issue/19/cloudflare-do-fts` の引用箇所を `git grep` / `git show` で照合（N-004）。

## 非同期処理・UoW・migration

### Blockers

なし。

### Warnings

- **[W-001]** `reindex` の「内部カーソル」に永続先が定義されていない — 全数を名乗る2つの表（E-1 / 第8.2節）のどちらにも口が無い
  - 場所: `.thread/34/design.md:1492`（(iii-b) の「進捗カーソルのコミットと同じ `transactionSync` で」）、`:1498`（(iii) 対象4種）、`:1856`（`reindex` は `migration_progress` を使わないと明記）、`:373`（`jobs` は12列で全数）、`:395`（非集約ストア表の `migration_progress` は `migrate-bulk` 専用）、`:1663`（`setMigrationCursor` のみ）
  - 理由: 第7.4節 (iii) は `reindex` / `migrate-bulk` / `finalize-withdrawal` / `purge-trash` の4種を「内部カーソルを持つジョブ」と定め、(iii-b) の中断時に**カーソルのコミット**を要求している。ところが永続先が定義されているのは `migrate-bulk` だけである（`migration_progress` + `setMigrationCursor`）。第9.2節は `reindex` について「`migration_progress` ではなく自分の内部カーソルで進む」と**明示的に排除**しており、`jobs` は第4.1.1節が「12列」と全数を宣言していてカーソル列を持たない。第8.2節の「非集約ストアへの書き込み口の全数」にも該当する口が無い。`payload` へ持たせる形は `payloadDigest` の照合対象が「`nextRunAt` を除いた payload」と定義されている（`:1442`）ため、カーソル更新のたびに digest がずれる。
    - `purge-trash` / `finalize-withdrawal` は作業が行の削除・冪等な再計算なので「作業述語そのものが進捗を表す」形で書け、カーソル無しでも成立する。**`reindex` だけは成立しない** — projection の作り直しは本体行を消費しないので、再開位置を持たないと (iii-b) で中断するたびに先頭からやり直しになり、大きく育った DO では永久に完了しない（(iii-b) を置いた目的そのものが失われる）。
  - 提案: 第1.4節 I-4 のタイブレーク規則（「本文が要求する列が E-1 に無い場合、直す向きは E-1 の側」）に従って E-1 を直す。最小の形は次のどちらかで、いずれも第8.2節に口を1本足す必要がある。
    - (a) `jobs` に `cursor` 列を1本足して13列にし、第7.4節の列表・第4.1.1節の2行・第1.4節 検査7 の期待値（「`jobs` は12列」）を同時に直す。ジョブランナー（アダプター）が書くので UoW の口は不要という整理も可能だが、その場合は第8.2節に「`jobs.cursor` はアダプター専用」と `_meta` と同じ但し書きを置く。
    - (b) `migration_progress` を `reindex` にも開放し、第9.2節の「`migration_progress` ではなく」という排除文を撤回する（`targetVersion` を `schema_version` 以外にも使えるよう意味を広げる）。

- **[W-002]** claim の CAS 述語に `status` の絞りが無く、`done` / `poison` 行を再 claim しうる。同じ根で `deleteAlarm()` の発火条件が節内で2通りに書かれている
  - 場所: `.thread/34/design.md:1476`（claim CAS）、`:1517`（`deleteAlarm()` 規則）、`:1470`（同節 (3) の「残る `pending` 行が常に1件ある」）、`:1478`（`done` / `poison` へ落とすときに書く列は `completedAt` だけ）
  - 理由: 2点ある。
    - **(i) claim CAS。** 本文の SQL は `WHERE operationKey=? AND (status='pending' OR leaseUntil < ?)` である。第2の選言に `status` 条件が無く、かつ `done` / `poison` へ落とす際に `leaseUntil` を解放する規定が本文のどこにも無い（(iii-b) の中断路だけが「`ownerToken` と `leaseUntil` を解放」と書いている。`:1492`）。したがって完了済みの行は過去の `leaseUntil` を保持したままになり、この述語に**一致する**。prune の保持期間中ずっと再 claim・再実行の対象になり、`finalize-withdrawal` のような一回性ジョブが完了後に再実行されうる。ジョブが冪等である（第7.7節 項3）ので実害は限定的だが、第7.4節が lease の用途を「DO がリセットされた場合の回収手段だけに限定できる」と断定している（`:1494`）根拠が成立しない。
    - **(ii) `deleteAlarm()` の条件。** `:1517` は「DB に `nextRunAt` を持つ行が1件も無ければ `deleteAlarm()` する」と書くが、`done` / `poison` の行も `nextRunAt` 列の値を保持する（クリアする規定が無い）ので、この述語は prune されるまで真にならない。同じ節の `:1470` は「`pending` 行が常に1件あるので下の `deleteAlarm()` も発火しない」と書いており、**`pending` 行の有無で判定する読み**を前提にしている。2つの書き方が同じ規則について食い違っている。前者どおりに実装すると、`:1517` が自ら「規則の一部であって省略可能な最適化ではない」として塞いだ恒久起床ループ（`setAlarm` 1回 = 課金対象の1行書き込み × 一度でもジョブを走らせた全ユーザー）がそのまま開く。
  - 提案: 「実行可能集合 = `status IN ('pending','running')`」を第7.4節に1文で明示し、両方の述語をそこへ帰着させる。具体的には (i) の CAS を `AND (status='pending' OR (status='running' AND leaseUntil < ?))` にし、(ii) を `:1470` の書き方に揃えて「`status IN ('pending','running')` の行が1件も無ければ」とする。あるいは `done` / `poison` へ落とす `transactionSync` で `completedAt` を書くのと同時に `leaseUntil` / `ownerToken` / `nextRunAt` を `NULL` にすると決め、その規定を `:1478` に足せば両方が同時に閉じる（第4.1.1節の `completedAt` の説明が既に「`pending` / `running` の行では `NULL`」という形の列ごとの状態規定を持っているので、同じ形で書ける）。

- **[W-003]** 第4.7節の翻訳表の `retryable` 欄が、現行実装および第11.2節の変更対象一覧と食い違う
  - 場所: `.thread/34/design.md:519`（行3: `ctx.abort()` / DO のリセット → `SystemError(DatabaseError)` / retryable **true**）、`:517`（行1 の根拠文）、`:2155`（第11.2節の `errors.ts` 改修行）。実物は `packages/core/src/application/errors.ts:206-210`
  - 理由: 2点ある。どちらも `.thread/34/design.md` が自分で「実装の事実」として引いている値と一致しない。
    - **(i) 行3 の `true` が実装で成立しない。** `RETRYABLE_SYSTEM_CODES` は `NetworkError` / `ExternalApiError` の2値だけで、`DatabaseError` を含まない（実ファイルで確認）。`SystemError.retryable` はこの集合からのみ導出されるので、`SystemError(DatabaseError).retryable` は **false** である。ところが第11.2節の `errors.ts` 改修行は `ServiceOverloaded` / `StorageCapacityExceeded` の2値追加しか指示しておらず、`RETRYABLE_SYSTEM_CODES` に `DatabaseError` を足す指示は本書のどこにも無い。**表が `true` と書いている値を実装が false で返す**状態がそのまま残る。同じ表の行1 / 行2 は `RETRYABLE_SYSTEM_CODES` に入れない旨を根拠欄で明示しており、`retryable` 欄がシリアライズ契約の `retryable` フラグを指していることは疑いようがない。
    - **(ii) 行1 の根拠文が同じ表の行4 と矛盾する。** 行1 は「`ConflictError("OPTIMISTIC_LOCK_FAILURE")` のような**リトライ可能系**へ写してはいけない」と書くが、`ConflictError` は `retryable` をオーバーライドしておらず `CodedError.retryable` の既定 `false` を返す（`packages/core/src/lib/error.ts:35-37`）。同じ表の行4 も `false（呼び出し元まで届ける）` と書いている。行1 が言いたいのは「リトライを誘う `kind: "conflict"`（HTTP 409）へ写すな」であって、`retryable` の話ではない。
  - 提案: (i) は行3 を **false** に直すのが現行実装と整合する（DO のリセットは「次のリクエストで DO が再構築される」ので上位でのリトライは意味を持つが、`retryable` フラグは `RETRYABLE_SYSTEM_CODES` の写しなので、表の値を実装に合わせるか、第11.2節の `errors.ts` 行に「`DatabaseError` を `RETRYABLE_SYSTEM_CODES` へ足す」を明記するかのどちらかに倒す。後者は既存の全 D1 経路の retryable 値を変えるので、**前者を推す**）。(ii) は「リトライ可能系」を「`kind: "conflict"`（409）系」へ言い換えれば足りる。

### Notes

- **[N-001]** **第1.4節の検査1〜7 を実行し、7項目すべてパスした。** 本文記載の `tbl()` / `cells1()` をそのまま使った実測値は次のとおりで、すべて期待値と一致する。
  - 検査1（I-3）: E-3 = 12行、E-1 の `jobs` 2行の列挙 = 12件、`diff` 一致、`rotate-remap` は両方0件。
  - 検査2（I-1 / I-2）: 投入点欄が空の行は0。(A) 3 / (B) 2 / (C) 7。(1-A) 表3行・(1-B) 表2行と `diff` 一致。
  - 検査3（I-5）: 非集約ストア7行、口の識別子7種がすべて第8.2節のコードブロックに実在、`アダプター専用` は `_meta` の1件。
  - 検査4（I-7）: 第7.7節 項2 の4類型が12件を重複なく列挙し、E-3 と `diff` 一致。
  - 検査5（I-6）: クラス (3) が13行、4群の割り当て合計が13。実際の集合も過不足なく一致（(3-a) 5 / (3-b) 2 / (3-c) 4 / (3-d) 2）。
  - 検査6（I-4）: E-1 のテーブル行16、名指しされた16テーブルがすべて実在。
  - 検査7（I-8）: 「新設する4つの秘密」「`jobs` は12列」（両クラスとも列挙も12件）「`kind` は各クラス6種・合計12種」がすべて一致。第3.2節の「request 側3つ / state 側2つ / 表は6行だが秘密は5つ」も内部整合。
  - **検査の設計自体が有効に機能している。** 検査2 が「投入点欄が第N節を指しているか」を機械判定する形になっているため、投入点の空欄が構造的に検出できる。実際に12種すべての投入点参照先（第6.1節 (d) / 第6.3節 phase 1a・1b / 第6.6節 link 手順1・unlink 手順2 / 第6.7節 手順1 / 第6.8節末尾 / 第7.5節 / 第7.6節 / 第9.2節）を本文で当たり、`enqueueJob` に相当する記述が全件実在することを確認した。

- **[N-002]** **本書が引用している実装の事実を実ファイルで照合し、全件一致した。** 行数・行番号・識別子・値のいずれにも齟齬が無い。
  - 行数: `application/execution/unitOfWork.ts` 19 / `adapters/d1/pendingBatch.ts` 98 / `application/workers/eventRelayWorker.ts` 301 / `outboxPrune.ts` 25 / `domain/common/event.ts` 81 / `domain/identity/events.ts` 62 / `application/events/buildDecoder.ts` 37 / `domain/identity/entity.ts` 227 / `apps/web/app/worker/cloudflare/handlers.ts` 138 / `apps/web/wrangler.toml` 162。`adapters/d1/` は20ファイル・2,514行。
  - 行番号: `adapters/d1/unitOfWork.ts:39`（"Read-your-write within the same UoW is unsupported by design"）/ `schema.ts:118`（`OCC_GUARD_CHECK_NAME = "occ_guard_positive"`）/ `repositories/helpers.ts:55`（`isOccGuardViolation`、`String.includes` で CHECK 名だけを照合しコメントが degrade を自認）/ `di/types.ts:53,70`（`RequestContainer` / `WorkerContainer` の2つだけ）/ `entity.ts:36,52,77,103,120` / `handlers.ts:82,120`（`handleQueue` / `handleDlq`）/ `presentation/currentUser.ts:17-26,28-33`（"The authoritative guard"）/ `authState.ts:18-23` / `errorResponse.ts:70`（`serializeError`）。
  - 契約: `UnitOfWorkContext { userRepository; collectEvents }` / `run<T>(fn): Promise<T>` / `TransactionalRepository` 4メソッドが全部 `Promise` / `UserRepository` は `insert` / `save` / `findById` / `findByEmail` の4本のみ（`findBySsoIdentity` は不在）/ `SessionCodec.issue(userId, now)` に epoch を運ぶ口が無い / `hmacSessionCodec.ts` の `type Payload = { uid; exp }` / `SystemErrorCode` は6値 / `RETRYABLE_SYSTEM_CODES` は2値 / `HTTP_STATUS_BY_KIND` は `system: 500` / `secrets.ts` の `RequestSecrets` 入れ子と `requireSessionSecret` のブランド型 / `0000_initial.sql` の実テーブルは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つ / `.tpl:21` の `main = "app/server.cloudflare.ts"`。
  - **UoW 新契約（第8.2節）は既存ポート定義と整合する。** `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` は TypeScript の推論規則上、条件型の両分岐へ推論が走るので `T` は素直に推論され、`async` コールバックは `T = Promise<...>` → 戻り値型 `never` となって代入不能になる。型トリックとして成立する。加えて非 `async` 関数内で `await` が構文エラーになる点も正しい。`Versioned<T>` / `ExpectedVersion<T>` を残す判断も、現行 `transactionalRepository.ts` のブランド型設計をそのまま同期化するだけで成立する。
  - **OCC の実装可能性も確認できた。** `version` を持つのは `account` / `user_settings` / `ai_client_connections` と集約3表で、`credential_mappings` は CAS で直列化されるので持たない、という切り分けは `spec/database/index.md` の現行規約（「集約ルートのみ」「アダプター内部ストアは持たない」）とそのまま整合する。0行検出の第一候補 `UPDATE ... RETURNING 1` は先行ブランチに `INSERT ... RETURNING rowid` の使用実績があり（N-004）、`rowsWritten` を「課金単位でありマッチ行数ではない」として不採用にした判断も公式定義と一致する。

- **[N-003]** **事実表 F-* を公式ドキュメントで実取得して裏を取り、本レビューで確認した範囲はすべて逐語で一致した。**
  - `/durable-objects/api/storage-api/` — `transactionSync` の "The callback must complete synchronously, that is, it should not be declared `async` nor otherwise return a Promise."（F-7）。`transaction()` の "When using the SQLite-backed storage engine, the `txn` object is obsolete. Any storage operations performed directly on the `ctx.storage` object, including SQL queries using `ctx.storage.sql.exec()`, will be considered part of the transaction." と "Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically."（F-27 が逐語で正しい）。`sync()` の定義（F-31）。write buffer と「すべて保存されるか1つも保存されないか」（F-28）。同ページの `setAlarm` / `getAlarm` / `deleteAlarm` はいずれも `Promise`（F-30 の片側）。
  - `/durable-objects/api/alarms/` — `setAlarm(scheduledTimeMs): void` / `getAlarm(): number | null` / `deleteAlarm(): void`（F-30 の公式内不整合が実在する）。「1 DO 1 alarm」「上書き」「throw 時は初回2秒からの指数バックオフで最大6回」（F-2）。"Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."（F-29 が逐語で正しい）。alarm ページに wall time の記述は無い（F-3 の但し書きが正しい）。"the `alarm()` handler may be re-instantiated on another machine"（`:1526` の "may" の指摘が正しい）。
  - `/durable-objects/platform/limits/` — alarm handler の wall time 15分（F-3）。CPU 既定30秒・最大5分。footnote 4 は "Each incoming HTTP request or WebSocket _message_ resets the remaining available CPU time to 30 seconds." で **Alarm も RPC も含まない**。一方 FAQ は "the maximum CPU time per Durable Objects invocation (HTTP request, WebSocket message, or Alarm) is set to 30 seconds"。**F-4b が「同じページの2文が別々のことを述べており決着しない」と書いているとおりで、保守的に読む判断は妥当である。** `SQLITE_FULL` の "10 GB on Workers Paid, or 1 GB on the Free plan"、表側の無条件 10 GB + 脚注3 のアカウント合計 5 GB という**公式内の不整合**も実在する（`:227` の記述が正確）。1,000 req/s soft limit と `overloaded`（F-19）。100列 / 2 MB / 100 KB / bind 100（F-17）。
  - `/durable-objects/api/sqlite-storage-api/` — 拡張は FTS5（`fts5vocab` 含む）/ JSON / 数学関数の3つだけで `bm25` / `snippet` / `highlight` / trigram は一語も無い（F-10）。`sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` 不可（F-8）。カーソルを `await` 跨ぎで持つとスナップショットが安定しない（F-9）。仮想テーブルへの書き込みも rows written に算入（F-15）。PITR は30日・DB全体単位・ローカル不可（F-20）。
  - `/durable-objects/api/state/` — "Unlike in Workers, `waitUntil` has no effect in Durable Objects."（F-22）。`blockConcurrencyWhile` の30秒タイムアウトと DO リセット（F-23）。`abort` は `wrangler dev` で不可（F-20 の但し書き）。
  - `/workers/reference/security-model/` — "The value returned by `Date.now()` is locked in place while code is executing. No other timers are provided." / "`Date.now()` returns the time of the last I/O. It does not advance during code execution." / "The attacker cannot use `Date` to measure the execution time of their code."（F-32 が逐語で正しい）。**したがって「経過時間による打ち切りを採らない」「3階層とも件数で有界にする」という第7.4節の中核判断は公式記載の上に正しく立っている。**
  - `/durable-objects/reference/durable-objects-migrations/` — "`exports` and `migrations` are mutually exclusive. A Worker configuration that contains both fields is rejected at validation."、`exports` の namespace は常に SQLite、ストレージ種別は生成後不変、削除に Trash は無く tombstone デプロイ前にデータ退避が要る（F-21）。`new_sqlite_classes` はレガシーの `[[migrations]]` 配列側である。**第9.1節が #37 の Issue 本文（`new_sqlite_classes` を追加せよ）を訂正対象と断じているのは正しい。**
  - `sqlite.org/lang_altertable.html` — 「rename / 制約なし列追加は table content を変えず、実行時間はデータ量に依存しない」と「CHECK 制約付き列追加・NOT NULL 生成列追加・列削除ではテーブル内容量に比例する」の両方が逐語で存在する。第9.2節の (i) の分類は公式どおり。
  - `sqlite.org/optoverview.html` — "the cost of constructing the automatic or query-time index is O(NlogN) (where N is the number of entries in the table)"。第9.2節 (ii) の引用と、そこから `CREATE INDEX` を条件4（分割不能なので回避）へ回した判断は妥当である。
  - `sqlite.org/fts5.html` — `'rebuild'` の逐語（"This command first deletes the entire full-text index, then rebuilds it based on the contents of the table or content table"）、**external content の FTS5 は作成時に content テーブルから自動 populate されない**、`'delete'` は**旧値の供給が必須**（"If the values 'inserted' into the text columns as part of a 'delete' command are not the same as those currently stored within the table, the results may be unpredictable."）、"Whenever column values are required by FTS5, it queries the content table as follows... `WHERE <content_rowid> = ?`"、`content_rowid` の既定は `rowid`。**第7.1節が挙げた external-content の実装制約2つは、どちらも公式記載どおりで正しい。**「例外が上がらずインデックスだけが黙って壊れる」という表現も、公式の "the results may be unpredictable" と整合する。

- **[N-004]** **先行ブランチの引用も実物と一致した。** `origin/issue/19/cloudflare-do-fts:apps/web/app/durable-objects/UserDataDurableObject.ts:514` に `while (processed < 25 && Date.now() - startedAt < 10_000)` が実在する（第1.3節・`:1537` の「凍結する時計をそのまま使っている形」という指摘は事実）。`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:216` に `RETURNING rowid`、同 `:465` に `bm25(search_fts, 3.0, 1.0)` が実在する（第8.4節の「動作実績がある」と F-12 の裏付け）。`.thread/19/spike/fts5.integration.test.ts` も実在し、「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件・`東京駅` / `東京` / `周辺` の `limit 1` ページングという第2.1.1節の再現手順の記述と一致する。

- **[N-005]** **再武装の3分類 (A)(B)(C) は12種すべてについて収束する。** 本文の規則を追って各 `kind` の状態遷移を検算した。
  - **(A) 時刻駆動3種。** 駆動源が「作業述語から時刻条件だけを外したもの」と定義されているので、駆動源 ⊇ 作業述語が構造的に保証される。集合が空のときだけ `done` にする規則と、`done` / `poison` 行を `pending` へ戻す再投入規則（`:1444`）が対になっており、投入点（`purge-trash` = ソフトデリート / 設定変更、`sweep-reservations` = phase 1a・1b、`sweep-reset-tokens` = トークン発行）はいずれも「新しい残件を作る操作そのもの」なので、`done` からの復帰が構造的に保証されている。(3-a)（復元時に `purge_after` を `NULL`）と (3-b)（駆動源に `status` / `sagaCommitted` を含める）で恒久ループ側も塞がっている。
  - **(B) 残件駆動2種。** どちらも残件が単調減少する。`sweep-orphan-mapping` は全世代の `delete-mapping` 成功時に `updateOperation(phase: 'done')` を書くので `operations` の該当行が減り、`rotate-encryption` は再暗号化した行の `encryptionGeneration` を active へ進めるので非 active 行が減る。**1回の起動で少なくとも1件は進む**（(iii-a) の行数上限は 1,000 なので0件になりえない）ため、有限回で `done` に達する。`done` からの復帰も、投入点（unlink 手順2 / operator の起動 RPC）が残件を作る操作そのものなので成立する。恒久失敗（`delete-mapping` が throw し続ける等）は `attempt` のバックオフ経由で `poison` に落ちるので、無限に `setAlarm` を書き続ける経路にはならない。
  - **(C) 一回性7種。** `reindex` / `migrate-bulk` / `finalize-withdrawal` は (iii) のチェックポイント中断で `pending` に戻る（`done` にはならない）ので「完走していないのに `done`」が起きない。`resume-*` 3種は各 phase が冪等で、`operations.phase` / `changeState` / 予約行の状態から中断点を再開する形なので、部分成功のまま success を返さない限り正しい。`send-mail` は単発の外部 I/O。**(A)(B) の再武装規則の射程が (C) を含まないことが `:1446` で明示され、(C) の再投入が投入点側から来ることも `:1474` (7) で閉じている。**
  - **`rotate-remap` を Alarm ジョブから外した判断（`:1431`）は、第3.2節の秘密の非重複配布から必然的に導かれる。** routing key が Alarm 起動時に存在しない以上、Alarm ジョブにすると鍵を DO 側に置く実装へ倒れる、という論証は妥当である。

- **[N-006]** **第7.7節（正文）と第7.4節（実装規約）の関係は一貫している。** 「規則を改訂するときは本節だけを直す」という宣言どおり、第7.4節の「`alarm()` から throw しない」は 項5 の適用、第7.6節の `providerIdempotencyKey` は 項3 の適用、第8.4節の OCC 非リトライは 項6 として畳まれており、規則の実体が二重に書かれている箇所は見つからなかった。項2 の「外部 I/O は『必ず載る』側の条件であって、載るものの全数ではない」という書き換えは、第7.4節の12種と正しく両立する。項1 の `collectEvents` 廃止と第8.2節の `enqueueJob` によるスロット継承も整合する。

- **[N-007]** **`alarm()` 先頭の順序（(1) 再武装 + `sync()` → (2) migration ゲート → (3) 仕事）は第9.2節の排他条件と両立する。** 第9.2節はゲート関数を「`schema_version` の読み取りから全 DDL ステップの適用まで `await` を1つも挟まない同期関数」と定め、input gate による排他をその同期性から得ている。(1) の `await ctx.storage.sync()` はゲートに**入る前**に完了するので同期区間は破れない。`finally` を棄却して先頭再武装 + `sync()` にした論証（CPU 予算超過は例外ではなくエビクション → `finally` は走らない、`setAlarm` の戻り値は公式内で不整合なので `await` で代用できない、`sync()` が唯一の手段）は、F-28 / F-29 / F-30 / F-31 の公式記載から正しく導かれている。第9.4節の fail-closed が `deleteAlarm()` 規則の明示的な例外であることも両節に相互に書かれている。

- **[N-008]** **lazy migration の設計は実装可能である。** RPC と `alarm()` の両方にゲートを掛ける判断（`:1825`）は、dormant な User Data DO が `purge-trash` の Alarm でしか起きないという第7.5節の前提と対になっており、片方だけだと未 migrate の DO に新スキーマ前提の SQL が飛ぶ、という論証は正しい。`blockConcurrencyWhile` を捨てた代わりに input gate の同期性で排他を取る形も F-18 / F-23 から導ける。`CREATE INDEX` の多段分解（索引つき新テーブル → `migrate-bulk` でコピー → 参照切り替え → 旧テーブル削除）は、`SAVEPOINT` が使えない（F-8）以上、大きく育った既存テーブルへの索引追加を有界化する唯一の形として妥当である。forward-only + 部分適用記録 + fail-closed + 「スキーマを進めるリリースはロールバック不可」という組み合わせも自己整合している。
  - **第9.5節の PITR の位置づけも正しい。** 「PITR は対象を知っている場合の復旧手段であって対象を発見する手段ではない」「16進 object ID から `userId` へは戻せない（`idFromName` は一方向）」「唯一の特定経路は Directory bucket の全走査」という論証は、F-5（列挙 API の不在）から正しく導かれる。第10.1節の3つの独立した穴（`sessionEpoch` の巻き戻し / AI クライアント接続の復活 / 消費済みリセットトークンの復活）と、それぞれに対する restore 直後の必須ステップの割り当ても、第6.9節の宣言の射程を明示したうえで整合している。

- **[N-009]** **FTS5 同期更新の結論（第7.1節）は成立する。** 「同一 SQLite にある」「`transactionSync` が原子性を与える」「workerd 上で実測がある」の3点はすべて裏が取れた。external-content の効果の範囲について「消えるのは `%_content`（容量）であって rows written の主要因（`%_data`）ではない」と切り分けている点も、FTS5 の shadow table の構造として正しく、第4.6節・第10.2節の見積り方針と一貫している。**トリガーではなく projection コードに寄せる判断**も、両対応の読み取り（第9.3節）と再インデックス（第4.8節）との噛み合わせという理由づけが妥当である。`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にする根拠（真の rowid alias なので VACUUM で再採番されない）も SQLite の仕様どおりである。

- **[N-010]** **エラー翻訳の場所は捕捉可能性の観点で正しい。** 第4.7節が「捕捉する側」を列として持ち、4行のうち2行（`.overloaded` / `ctx.abort()`・リセット）は DO のコードが1行も走らないため DO 内に catch 点が無い、として呼び出し側の facade ラッパーへ割り当てているのは正確である。**state Worker 内の DO 間 RPC にも同じラッパーを通す**という追記（第3.2節で state Worker にも両 binding を置いた帰結）も抜けがない。「CPU 予算超過には写す先が無い（エラーではなくエビクションとして現れる）」を翻訳表の対象外として明記した点も、F-4 から正しい。`kind` 単位の HTTP status 据え置き（`overloaded` も 500。429 / 503 を返すほうが有害）という判断も `CLAUDE.md` の "HTTP status mapping is presentation-only, driven by the serialized `kind`" と整合する。**ただし `retryable` 欄の値そのものに W-003 の齟齬がある。**

- **[N-011]** 第7.7節 項2 の類型名「チェックポイント分割を要する一括処理」（`reindex` / `migrate-bulk` / `rotate-encryption`）と、第7.4節 (iii) の「内部カーソルを持つ4種」（`reindex` / `migrate-bulk` / `finalize-withdrawal` / `purge-trash`）は**別の軸**である。前者はジョブの存在理由の類型（I-7 が全数を要求する側）、後者は実装機構の分類で、集合が一致しないことは矛盾ではない。`rotate-encryption` は (iii) の対象外だが (iii-a) と同じ行数上限を掛けて起動をまたいで刻む（`:1498`）ので、類型名の「チェックポイント分割」とは矛盾しない。#37 が両者を同一視しないよう、必要なら第7.7節 項2 の表に「この類型は第7.4節 (iii) の対象集合とは一致しない」の1行を添えると読み違えが減る（**必須ではない**）。
