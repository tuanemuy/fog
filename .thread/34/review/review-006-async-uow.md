# レビュー 006 — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design`
**主成果物:** `.thread/34/design.md`（2,047行）/ `.adr/003` / `.adr/004`
**実施日:** 2026-07-30
**方針:** 前ラウンドの指摘を前提にせず、ゼロベースで全文を再読した。重点は第7.4節の収束規則・再武装規則が `kind` 全数に対して閉じているか、第7.7節の正文と `.adr/004` が一致しているか、第8.2節の UoW 契約が設計の全要求を書ける形になっているかの3点。

## 検証の手段

1. `CLAUDE.md`（Unit of Work / Outbox / Retry strategy / Error handling / Cross-layer catch policy）を通読。
2. `gh issue view 34` の対応項目4 を確認。
3. `.thread/34/design.md` を全文読解（第1〜11章）。
4. 実コードとの突き合わせ — `packages/core/src/application/execution/unitOfWork.ts`（19行）/ `packages/core/src/adapters/d1/{unitOfWork,pendingBatch,schema}.ts` / `adapters/d1/repositories/helpers.ts` / `packages/core/src/domain/common/{event,transactionalRepository}.ts` / `packages/core/src/domain/identity/{entity,events}.ts` / `packages/core/src/domain/identity/ports/userRepository.ts` / `packages/core/src/application/{errors.ts,ports/*,events/buildDecoder.ts,workers/*}` / `apps/web/app/worker/cloudflare/*`。
5. 公式ドキュメントを実際に取得して裏取り — SQLite `lang_altertable.html` / `optoverview.html` / `fts5.html`、Cloudflare `/durable-objects/api/alarms/` / `/api/storage-api/` / `/platform/limits/`。

## 非同期処理・UoW・migration

### Blockers

- **[B-001]** retention 設定の**延長**時に `nextRunAt` を後ろへ動かす手段が UoW 契約に存在しない。第7.4節の収束規則・第4.1節・第7.5節の3箇所が互いに矛盾している
  - 場所: `.thread/34/design.md:1265-1266`（収束規則とその適用範囲）、`:1365`（第7.5節 retention 設定変更時）、`:228`（第4.1節 表の行5）、`:1436` / `:1465-1466`（第8.2節の `enqueueJob` 署名と「全数」宣言・`ctx.storage.sql` 直接使用の禁止）
  - 理由:
    - 第7.4節 `:1265` は「**再投入は `nextRunAt` を「早める方向にのみ」更新し、遅らせない**」を規則として置き、続く `:1266` で適用範囲を「**外部からの再投入（`enqueueJob`）に限る。ジョブ自身が完了時に行う再スケジュールには適用しない**」と限定している。同じ行が、この限定によって「第7.5節（retention 設定変更時に Alarm を張り直す）と正面から矛盾する」事態が解消されると主張している。
    - **しかし第7.5節 `:1365` の張り直しは「ジョブ自身が完了時に行う再スケジュール」ではない。** `TrashRetentionDays` の変更は利用者操作であり、その処理は RPC 経路のユースケースが「変更したトランザクションの中で」行う（同行が明記）。ジョブ完了トランザクションではないので、`:1266` の除外側には**構造的に入らない**。したがって `:1265` の「遅らせない」がそのまま掛かる。
    - ところが `:1365` は「**延長方向（`min(purge_after)` が後ろへ動く）もここに含まれるので、この張り直しはジョブ自身の再スケジュールと同じ扱いにし、「早める方向にのみ」を適用しない**」と、`:1266` が与えていない例外を自分で名乗っている。第4.1節 `:228` はさらに強く「**`nextRunAt` を遅らせる向きの更新がジョブ自身の再スケジュールに限って許されること**」と書いており、`:1365` の要求を明示的に禁じている。**同じ操作について3箇所が別々のことを述べており、#37 はどれに従っても他の2つを破る。**
    - **迂回路も塞がれている。** 第8.2節 `:1436` の `enqueueJob(kind, operationKey, payload, nextRunAt): void` には「これは再武装なので遅らせてよい」を表現する引数が無く、`:1466` は「上のメソッド列挙は……書き込み口の全数」、`:1465` は「`ctx.storage.sql` を usecase から直接触る形は採らない」と断定している。**つまり retention 延長時に `jobs.nextRunAt` を後ろへ動かす経路は契約上どこにも無い。**
    - 実害は小さくないが致命的でもない — 延長しても古い（早い）`nextRunAt` のまま起動し、作業対象0件で再武装規則 (1) が新しい `min(purge_after)` を書くので次の起動から正しくなる。**したがって問題は「壊れる」ではなく「本文が要求する動作を実装する手段が無く、かつ規則が3箇所で食い違っていて #37 が決められない」ことである。** 第7.4節が `:1263` で収束規則を導入した論拠は retention **短縮**の前倒しのみで、**延長側は一度も規則で説明されていない**。
  - 提案: どちらか一方に倒し、3箇所を同じ文言に揃える。**(A) 規則側を直す** — `:1265` の例外を「同一 `kind` の駆動源クエリ（`:1275-1279` の表）を読み直して書き戻す再スケジュールは、実行主体がジョブ完了であるか usecase であるかを問わず方向を制限しない」と定義し直し、`enqueueJob` に `rearm: true` 相当の引数（または `rescheduleJob(kind, operationKey, nextRunAt): void` の第2メソッド）を第8.2節へ足す。`:1466` の「全数」宣言があるので、メソッドを足すなら同時に更新する。**(B) 第7.5節側を落とす** — `:1365` の張り直しを「`purge_after` の一括再計算だけを行い、`nextRunAt` は触らない（次の起動で再武装規則 (1) が拾う）」へ書き換え、`:1266` の「第7.5節と正面から矛盾する」という論拠も同時に訂正する。**(B) のほうが規則が1つ減り、`:228` / `:1266` を書き換えずに済む。**

### Warnings

- **[W-001]** `sweep-reservations` / `sweep-reset-tokens` を最初に（および `done` から）投入する主体が、本書のどこにも書かれていない
  - 場所: `.thread/34/design.md:1275-1281`（再武装規則 (1) と「集合が空のときだけ `done`」）、`:1269`（`done` / `poison` からの復帰規則）。投入点が書かれていない側は `:843-844`（signup phase 1a / 1b の予約作成）と `:702`（「期限切れトークンの掃除は bucket の Alarm（第7.4節）。」）
  - 理由: 本書は12種の `kind` のうち10種について投入点を名指ししている — `purge-trash` は `:1362`（ソフトデリート時）、`send-mail` は `:1385-1386`、`resume-signup` は `:862`、`resume-link` は `:981`、`resume-credential-change` は `:941`、`finalize-withdrawal` は `:1017`、`migrate-bulk` は `:1615`（ゲートの中）、`rotate-encryption` は `:460`（maintenance 経路）、`sweep-orphan-mapping` は unlink 手順2 の文脈（`:1011`）、`reindex` は第4.8節。**残る2種 `sweep-reservations` / `sweep-reset-tokens` だけが投入点を持たない。**
    そして再武装規則 (1) `:1281` は「駆動源クエリの集合が空のときだけ `done` にする」と定めているので、**予約が1件も無い平常時・未使用トークンが1件も無い平常時には、この2つのジョブは必ず `done` に落ちる。** 次に予約行 / トークン行が作られたときに `pending` へ戻すのは `:1269` の再投入規則だが、**その再投入を発行する主体がどの節にも書かれていない**（`:702` は「掃除は bucket の Alarm」と実行機構だけを述べ、投入については何も言っていない）。`:1269` 自身が「この規則が無いと、定数 `operationKey` を持つ周期ジョブが1回完走した時点で……再投入を受け付けなくなる」と**再投入の存在を前提にしている**ので、前提側が空欄のまま残っている形である。
    影響は第6.4節の3段ガードの1段目（予約 TTL 掃除）と第6.1節 (d) のトークン掃除であり、どちらも「開くと到達不能アカウント / 発行済みトークンの残存」に直結する経路である。
  - 提案: 第6.3節 phase 1a / 1b の予約書き込みと同じ `transactionSync` で `enqueueJob('sweep-reservations', ...)` を、第6.1節 (d) のトークン行発行と同じ `transactionSync` で `enqueueJob('sweep-reset-tokens', ...)` を発行する、と各節に1行ずつ足す（`nextRunAt` はそれぞれ `reservedUntil` / `expiresAt`。定数 `operationKey` なので既存行への収束は `:1265` / `:1269` がそのまま処理する）。あわせて第7.4節の再武装規則の末尾に「周期ジョブの投入点は駆動源の行を作る側にある」を1行置くと、次に `kind` を足す担当者が同じ空欄を作らない。

- **[W-002]** `.adr/004` の決定文が「外部 I/O を伴う処理と**期限処理だけ**」と書いており、設計の正文（第7.7節 項2）が明示的に否定した限定になっている
  - 場所: `.adr/004-do-local-commit-and-alarm-jobs.md:24`。対する設計側は `.thread/34/design.md:1402`（第7.7節 項2）と `:1240-1255`（`kind` 全数表）、`:1372`（第7.6節「12種のうち11種はローカル完結」）
  - 理由: 設計の第7.7節 項2 は「**「永続ジョブに載るのは外部 I/O を伴う処理だけ」と書いてはならない**」と名指しで禁じ、「期限処理・チェックポイント分割を要する一括処理・cross-DO saga の前進も同じ `jobs` テーブルと Alarm で駆動する」を正文として置いている。ところが `.adr/004:24` は「外部 I/O を伴う処理と期限処理だけを永続的なジョブとして残し」であり、**`reindex` / `migrate-bulk` / `finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link` / `resume-signup` / `resume-credential-change` / `rotate-encryption` の8種が「だけ」の外に落ちる**（12種のうち、外部 I/O は `send-mail` の1件、期限処理は `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` の3件で、合わせても4件にしかならない）。とくに cross-DO saga の前進は本設計で最も重い機構（第6.3〜6.7節）であり、それが ADR の決定文の射程外に見える。
    `.adr/` は「後続の読み手（architecture-audit / spec-sync）はそこだけを見る」薄い台帳と Issue #34 が定めている以上、決定文の限定が設計の正文と食い違ったまま残ると、#37 / #38 が ADR だけを読んで「saga 前進や bulk migration は永続ジョブではない」と読む余地が残る。**設計側の第7.7節が直った結果、限定が緩いほうと厳しいほうが入れ替わった形である。**
  - 提案: `.adr/004:24` を「**外部 I/O を伴う処理は必ず永続的なジョブとして残す。加えて期限処理・チェックポイント分割を要する一括処理・オブジェクトをまたぐ手続きの前進も、同じジョブ機構とオブジェクトごとに1本の Alarm で処理する**」へ書き換える（`kind` の全数は `.thread/34/design.md` 第7.4節が正本である旨は `:42` の既存行が既にカバーしている）。ADR の粒度を保ったまま「だけ」を外すだけで足りる。

### Notes

- **[N-001]** 第9.2節が引く SQLite 公式の3引用は、実際に取得して**逐語で一致**した。`lang_altertable.html` の「No changes are made to table content for renames or column addition without constraints. Because of this, the execution time of such ALTER TABLE commands is independent of the amount of data in the table and such commands will run as quickly on a table with 10 million rows as on a table with 1 row.」と「When adding new columns that have CHECK constraints, or adding generated columns with NOT NULL constraints, or when deleting columns, ... the ALTER TABLE command takes time that is proportional to the amount of content in the table being altered.」、`optoverview.html` の「the cost of constructing the automatic or query-time index is O(NlogN) (where N is the number of entries in the table)」— いずれも本文の引用どおりである。**「`CREATE INDEX` はデータ量に依存する」と分類し、条件4 として「分割できないので回避する」（索引つき新テーブル + `migrate-bulk` コピーへの多段分解）へ倒した結論は、公式記載の上に正しく立っている。**

- **[N-002]** 第9.2節 条件2 の FTS5 に関する断定も公式で裏が取れた。`fts5.html` の 'rebuild' の説明（「This command first deletes the entire full-text index, then rebuilds it based on the contents of the table or content table」）、**external-content テーブルが作成時に content テーブルから自動 populate されない**こと、`INSERT INTO ft(ft, rowid, a, b, c) VALUES('delete', 14, $a, $b, $c)` の delete 構文とそこへ渡す値が現在保存されている値と一致していなければならないこと、「Whenever column values are required by FTS5, it queries the content table」— 第7.1節の実装制約2点（旧値 delete → 新値 insert の2段 / surrogate 列に UNIQUE と索引が必須）と第9.2節 条件2 の分類は、いずれも公式記載と整合している。

- **[N-003]** 第2.1節の事実表のうち非同期・migration に効く行を公式から取得して照合し、**確認した範囲では誤りは無かった**。F-2（"exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed" / `setAlarm` は既存を上書き）/ F-3（"Alarm handler invocations have a maximum wall time of 15 minutes"）/ F-4（30秒既定・5分まで設定可・リセット契機は incoming HTTP request と WebSocket message）/ F-19（1,000 req/s soft limit と overloaded）/ F-27（"Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically"）/ F-28（in-memory write buffer と "either all of the writes will have been stored to disk or none"）/ F-29（"Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."）/ **F-30（alarms ページは `setAlarm(): void` / `getAlarm(): number | null` / `deleteAlarm(): void`、storage API ページは3本とも `Promise` — 公式内で実際に食い違っている）**/ F-31（"Synchronizes any pending writes to disk."）。**とくに F-30 の「公式内の不整合」という主張自体が正しいことを確認した。** 第7.4節が `setAlarm` の `await` に依拠せず `ctx.storage.sync()` を唯一の永続化確認手段に据えているのは、この不整合の上で成立する唯一の書き方である。

- **[N-004]** 実コードの引用は照合した範囲で行番号・行数とも一致していた。`application/execution/unitOfWork.ts` が19行で `run<T>(fn: (ctx) => Promise<T>): Promise<T>` と `collectEvents` だけを持つこと、`adapters/d1/unitOfWork.ts:39` の "Read-your-write within the same UoW is unsupported by design"、`repositories/helpers.ts:55` の `isOccGuardViolation`、`schema.ts:118` の `OCC_GUARD_CHECK_NAME = "occ_guard_positive"`、`domain/common/event.ts` 81行 / `domain/identity/events.ts` 62行 / `domain/identity/entity.ts` 227行で `:52` / `:77` / `:103` / `:120` の4ファクトリが `WithEventDrafts<...>` を返すこと、`application/events/buildDecoder.ts` 37行、`application/errors.ts` の `SystemErrorCode` 6値と `RETRYABLE_SYSTEM_CODES` 2値（`NetworkError` / `ExternalApiError`）、`apps/web/app/worker/cloudflare/` が `consumer.ts` 7行 / `dlq.ts` 7行 / `handlers.ts` 138行 / `pruner.ts` 17行 / `relay.ts` 30行 — いずれも記述どおりである。

- **[N-005]** 前ラウンド（005）の指摘は5件とも解消を確認した。**B-001（駆動源クエリ）** — 第7.4節 `:1273-1288` に `kind` ごとの作業述語 / 駆動源の対応表、「残件 = 集合が空でないこと」の定義、安全弁のクランプ、(3-a) 復元時の `purge_after` NULL 化、(3-b) 駆動源への `status` / `sagaCommitted` 条件の必須化が入り、読み方 A / B のどちらの破れ方も塞がっている。**W-001（第7.7節 項2）** — `:1402` が「外部 I/O は必ず載る側の条件であって、載るものの全数ではない」へ書き換わり、第7.6節 `:1372` も「12種のうち11種はローカル完結」に整合した（残る食い違いは `.adr/004` 側のみ。W-002）。**W-002（`CREATE INDEX`）** — `:1623-1637` が DDL をデータ量依存 / 非依存へ分類し直し、条件4 と回避策 (a)(b) が入った。**W-003（`recordOperation`）** — `:1437-1452` に `targetLocators` / `updateOperation` / `setMigrationCursor` が入り、第6.6節が要求する孤児 mapping 回収の逆引き情報を契約側で書けるようになった。**W-004（ドメイン層のイベント抽象）** — `:1210-1216` の実測全数と `:1927-1929` の変更対象3行（`domain/common/event.ts` 削除 / `domain/identity/events.ts` 削除 / `domain/identity/entity.ts` 改修）が入り、H-6 `:1983` も「抽象」の実体を名指ししている。

- **[N-006]** UoW 契約と既存ポート定義の整合を確認した。第8.2節の `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` は現行 `run<T>(fn: (ctx) => Promise<T>): Promise<T>` の完全な置き換えであり、第11.2節 `:1990` が Issue #37 本文の「契約は維持したまま実装だけ差し替える」を明示的に訂正している。`collectEvents` のスロットを `enqueueJob` が継ぐ形も、`di/types.ts` の「リポジトリはコンテナに載せない / `UnitOfWorkContext` が唯一の発行点」という既存の不変条件と矛盾しない（第8.3節 (b) が DO facade を「トランスポートであってリポジトリではない」と分離している）。第8.2.1節が (b) `SemanticCommitPort` と (c) `ctx.storage.transaction(closure)` を棄却した論拠も、公式の F-27（原子性の条件が `await` の不在の側にある）だけで完結しており、未確認の F-27b に依存していない。

- **[N-007]** OCC の実現手段（第8.4節）は実装可能である。`version` 列の所在は第4.1.1節が `account` / `user_settings` / `ai_client_connections` について明示し、集約テーブルは `spec/database/index.md` の現行規約を引き継ぐと `:259` が宣言しているので、列の全数として閉じている。`UPDATE ... WHERE id = ? AND version = ? RETURNING 1` を第一候補、`SELECT changes()` を spike 待ちの第二候補、`rowsWritten` を「課金単位であってマッチ行数ではない」として不採用にする序列も筋が通っており、`credential_mappings` が `version` を持たない理由（CAS と OCC の権威が二重になる）も説明されている。

- **[N-008]** エラー翻訳の場所（第4.7節）は捕捉可能性の観点で正しい。`.overloaded` と `ctx.abort()` / DO リセットは DO のコードが1行も走らない、あるいは送出待ちメッセージごと破棄されるので DO 内に catch 点が無く、stub 側ラッパーに置くのが唯一成立する形である。`overloaded` を retryable false かつ 500（429 / 503 ではない）で返す判断も、公式の「`.overloaded` が真のエラーはリトライしてはならない」と `CLAUDE.md`「HTTP status は `kind` だけで決める」を同時に満たしている。**「CPU 予算超過には写す先が無い」を明記した点**（エラーではなくエビクションとして現れるため）も正しく、第9.2節の「例外が上がるから検出できる、を前提にした設計にしない」と一貫している。

- **[N-009]** `alarm()` 先頭の順序（(1) 再武装 + `await ctx.storage.sync()` → (2) migration ゲート → (3) 仕事）と第9.2節の排他条件は両立している。(1) の `await` はゲートに入る前に完了するので「ゲート関数は `schema_version` の読み取りから全 DDL 適用まで `await` を挟まない同期関数」という条件は破れず、第9.4節の fail-closed が (2) で発火する場合も (1) の再武装は永続化済みである。RPC 経路の「`run()` 戻り後に `await` を挟まず `setAlarm` → `sync()`」も、F-28 の全か無かの保証が同一フラッシュ単位に対するものであることを正しく使っている。3階層の件数上限（25件 × 20チャンク × 1,000行）で1回の起動が触る行数の上界が静的に決まる点、`Date.now()` の凍結（F-32）を理由に経過時間による打ち切りを採らない点も、公式記載と整合している。
