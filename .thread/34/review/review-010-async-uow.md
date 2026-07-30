# レビュー R10（最終） — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design` / Issue #34 対応項目4
**主成果物:** `.thread/34/design.md`（2,526行）/ `.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md`
**方針:** ゼロベース。第1.4節の検査を全項目実行し、既存コードと公式ドキュメントで裏を取った。鍵ローテーション手順の未決（#44 委譲）は指摘対象外。

## 非同期処理・UoW・migration

### Blockers

なし。

### Warnings

- **[W-001]** `resume-credential-change` が `poison` に落ちた場合、`credential_mappings.changeState = 'pending'` が恒久化して全脱出経路が閉じるが、第6.9節の締め出し経路一覧（**全数を名乗る21経路**）にこの経路が無く、同節末尾の除外条項が「短時間だけ閉じる」を前提にしている。
  - 場所: `.thread/34/design.md:1511`（第6.9節 末尾の除外条項）。関連: `:1657`（(C) 一回性の `done` は復活させない）/ `:1699`（`poison` は `nextRunAt` を `NULL` にして実行可能集合の外へ）/ `:1695`（実行可能集合へ戻す唯一の手段は `enqueueJob`）/ `:1637`（`resume-credential-change` の投入点は第6.5.1節 phase 1 のみ・分類 (C)）/ `:1276`（phase 1 が旧検証材料を無効化）/ `:722`（`lookup-credential` は `changeState = 'pending'` をダミーへ倒す）/ `:665`（`SQLITE_FULL` は書き込みだけが恒久的に失敗する半死状態・`retryable` false）
  - 理由: 3つの規則が同時に成立すると、設計が「締め出しではない」と分類した中間状態が恒久化する。
    1. **`resume-credential-change` は分類 (C) で、投入点は phase 1（`begin-credential-change`）だけである。** `poison` に落ちた行を `pending` へ戻せるのは投入点からの再投入だけ（`:1695`）だが、その投入点を叩くには 起点 A（セッション + 旧パスワード照合）か 起点 B（新しいリセットトークン）が要る。
    2. **`pending` の間、脱出経路が3つとも閉じている。** 旧パスワードは `lookup-credential` がダミーへ倒すので login 不能（`:722`）、新パスワードは phase 3 未完了なので未昇格、リセット依頼も同じダミー化で解決されないためトークンが発行されない。第6.9節のローテーション行が「第6.2.2節 (a) の脱出経路 (i) も同時に壊れる」と書いているのと同じ状態が、**ローテーションと無関係に**成立する。残る手段は既存セッション（TTL 7日）からの 起点 A 再実行だけで、**セッション TTL が切れた時点で復旧手段がゼロになる**（`purge-user-mappings` は mapping を消すだけなので復旧ではなく恒久ロックの確定である）。
    3. **`poison` に至る具体的な契機が設計内にある。** phase 2（`advance-credential-change`）は User Data DO の `account.sessionEpoch` と `credential_locators.credentialVersion` を**書く**。第4.7節が `SQLITE_FULL` を「書き込みだけが恒久的に失敗し、読みと `DELETE` は通る半死状態」「`retryable` false」と定義している（`:665`）ので、10 GB に達した User Data DO の利用者がパスワードを変更すると phase 2 は毎回失敗し、`attempt` 上限で `poison` になる。しかも第4.6節が掲げる逼迫時の導線（「ゴミ箱を空にする / エクスポートして削除する」）は**ログインを要求する**ので、この順序では到達できない。
  - **Blocker に上げなかった理由:** 発火には「リトライ予算の枯渇（＝恒久的な失敗）」という条件が要り、他の21経路のような決定的なインターリーブでは起きない。また設計は `poison` を一般に「`terminalReason` + 運用エスカレーション（#38）」で受ける態度を取っており（`:1250`）、W-001 はその受け口の粒度の問題としても読める。ただし**第6.9節が「全数」を名乗り、除外条項が「短時間だけ」という保証されていない前提に依拠している**点は形式的に成立していない。
  - 提案（どれか1つで足りる）:
    - (a) 第6.9節の一覧に1行足し、塞ぎ方を書く。**最も安い形は「`resume-credential-change` が `poison` へ落ちるときに、同じ `transactionSync` で `changeState` / `changeOrigin` / `pendingVerifier` / `operationId` を `null` へ戻す」**である。`passwordVerifier` は phase 3 まで触られないので旧パスワードが復活し、利用者は自力で再試行できる。認可が開く方向へは倒れない（変更が「効かなかった」だけで、起点 B の材料は phase 1 が既に失効させている）。この巻き戻しは第6.4節の「phase 2 の成功以降は前進」という境界と衝突しない — phase 2 は成功していない。
    - (b) (a) を採らないなら、除外条項（`:1511`）の「短時間だけ閉じる」を撤回し、「`resume-credential-change` の `poison` は恒久ロックアウトであり、受け口は #38 の運用検知である」と残余リスクとして明記したうえで、第11.3節に**`jobs.poison` の検知・手動再投入手順**の項目を1つ足す（現在の第11.3節は `done` / `poison` の**保持期間**しか #38 へ送っていない）。

### Notes

- **[N-001]（Blocker / Warning 相当ではない）第1.4節の検査を検査1〜検査9 まで全項目実行し、すべてパスした。** 実測値は次のとおり（`.thread/34/testing.md` 確認項目18 の期待と一致）。
  - 検査1: `12` / `I-3 OK` / `rotate-remap` は `/tmp/e3.txt` `/tmp/e1.txt` ともに0件
  - 検査2: 投入点なし0件 / (A)=3 / (B)=2 / (C)=7 / `I-2(A) OK` / `I-2(B) OK` / 分類がちょうど1つでない行0件 / `I-2 重複なし OK`
  - 検査3: 7ストア / `MISSING in 8.2:` なし / アダプター専用1件
  - 検査4: `12` / `I-7 OK`
  - 検査5: クラス (3) 12行 / 4群の合計 `12`
  - 検査6: `16` / `MISSING in 4.1.1:` なし
  - 検査7a: ヒットは「新設する4つの秘密」「`jobs` は12列（両クラス）」「`kind` は各クラス6種」「(A)(B) の5種 / (C) の7種」「(iii) の4種 / 残り8種」で、注記の期待値と1件残らず一致
  - 検査7b: `NG` 0行 / grep ヒット数 `8` = `ok` の呼び出し回数 `8`（15 / 1 / 6 / 35 / 21 / 13 / 10 / 10）/ `ADP-*` 実測 `85`
  - 検査8: `MISSING column in 4.1.1:` なし。**併記された再カウントコマンドはそのまま実行して終端し `62` を返す**（R9 で報告された自己参照による非終端は解消済み）
  - 検査9: `E-2 の欄に無い書き手候補:` なし
- **[N-002]（同上）引用している実装の事実は、実ファイルを読んで照合した全件が一致した。**
  - `packages/core/src/application/errors.ts` — `SystemErrorCode` は6値（`DatabaseError` / `DataIntegrityError` / `CryptoError` / `SessionError` / `NetworkError` / `ExternalApiError`）で `ServiceOverloaded` / `StorageCapacityExceeded` は不在。`RETRYABLE_SYSTEM_CODES` は `:206-210` で `NetworkError` / `ExternalApiError` の2値のみ。したがって第4.7節の `retryable` 欄（4行すべて false）は実装から導出される実値として正しい。
  - `packages/core/src/lib/error.ts:35-37` — `get retryable(): boolean { return false; }`。`ConflictError`（`errors.ts:61-72`）は override していないので `false`。第4.7節 行1 の但し書きどおり。
  - `packages/core/src/adapters/d1/unitOfWork.ts:39` — "Read-your-write within the same UoW is unsupported by design"（行番号も一致）。`schema.ts:118` の `OCC_GUARD_CHECK_NAME = "occ_guard_positive"`、`repositories/helpers.ts:55-69` の `isOccGuardViolation` が `String.includes` で CHECK 名だけを照合しているのも一致。
  - `packages/core/src/application/execution/unitOfWork.ts` 19行 / `pendingBatch.ts` 98行 / `application/workers/eventRelayWorker.ts` 301行（`:97` にモジュールスコープの `crypto.randomUUID()`）/ `outboxPrune.ts` 25行 / `apps/web/app/worker/cloudflare/handlers.ts` 138行 / `domain/common/event.ts` 81行 / `domain/identity/events.ts` 62行 / `domain/identity/entity.ts` 227行 / `application/events/buildDecoder.ts` 37行 / `apps/web/wrangler.toml` 162行 — すべて一致。
  - `application/ports/` は `clock` / `idempotencyStore` / `idGenerator` / `logger` / `outboxRepository` / `relayTrigger` / `sessionCodec` の7本で、削除対象3本の名指しは正しい。`application/di/env.ts` が `../workers/eventRelayWorker` と `../workers/outboxPrune` から `DEFAULT_*` を value-import している（`:2-7`）のも実物どおり。
  - `domain/identity/ports/userRepository.ts` は `insert` / `save` / `findById` / `findByEmail` の4本で `findBySsoIdentity` は不在（第2.3節の断定と一致）。`domain/common/transactionalRepository.ts` は `insert` / `findById` / `save` / `delete` の4本で全部 `Promise` 返し（第8.2.1節「変わるもの」の対比と一致）。
  - `apps/web/app/presentation/errorResponse.ts` — `serializeError` は `:70`、`HTTP_STATUS_BY_KIND` は `:101` で `kind` だけを見る（第4.7節末尾の据え置き判断と一致）。
- **[N-003]（同上）公式ドキュメントを実取得して裏を取った結果、第2.1節の事実表のうち非同期・UoW・migration に効く行はすべて正しい。**
  - Cloudflare: F-2（`alarm()` throw で初回2秒からの指数バックオフ・最大6回 / 1 DO に Alarm 1本 / `setAlarm` は上書き）・F-3（Alarm ハンドラの wall time 15分は limits ページ側の記載）・F-4（既定30秒・最大5分・**リセットの契機は「incoming HTTP request または WebSocket message」の2つだけ**）・**F-4b（FAQ は "the maximum CPU time per Durable Objects invocation (HTTP request, WebSocket message, or Alarm) is set to 30 seconds" と Alarm を名指しし、footnote 4 は Alarm も RPC も挙げていない — 2文が別のことを述べており決着しないという読みは正確）**・F-7（`transactionSync` のコールバックは `async` 不可・Promise 返却不可）・F-8（`sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` 不可）・F-9（カーソルは `await` を跨ぐとスナップショットが安定しない）・F-15（仮想テーブルへの書き込みも rows written）・F-16（LIKE / GLOB **パターン**の50バイト上限 — `instr()` に掛からないという導出も正しい）・F-18（input gate は同期 JS 実行中の新規イベントを止め、`fetch()` の `await` で開く / output gate は保留書き込み完了まで送出を止める）・F-20（PITR は SQLite-backed 限定・30日・単位は object 1個・SQL と KV の両方・ローカル不可）・F-22（"Unlike in Workers, `waitUntil` has no effect in Durable Objects"）・F-23（`blockConcurrencyWhile` は30秒でタイムアウトし DO をリセット）・F-24（`setAlarm()` 1回は1行の書き込みとして課金）・F-28（in-memory write buffer / 「すべて保存されるか1つも保存されないか」）・F-29（"Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."）・F-30（alarms ページは `void` / `number | null`、storage API ページは `Promise` — **公式内不整合は実在する**）・F-31（`sync()` の定義文）・F-32（`Date.now()` の凍結。3つの引用文すべて実在）。**第4.7節 行3 の output gate 引用（「Object をリセットし、送出待ちのメッセージをすべて破棄し、クライアントにはエラーを返す」）も公式側に実在する。**
  - SQLite: 第9.2節が引く `lang_altertable.html` の2文（制約なしの列追加・rename はデータ量に依存しない / CHECK 付き列追加・NOT NULL 生成列追加・列削除はテーブル内容量に比例）は逐語で一致。`optoverview.html` 第14節の "the cost of constructing the automatic or query-time index is O(NlogN)..." も逐語で一致（`CREATE INDEX` への外挿であることは本文が明示しており、外挿として妥当）。`fts5.html` の `'rebuild'`（「索引を全部消して table / content table から作り直す」単一文で中断・再開の単位が無い）・external-content が作成時に自動 populate されないこと・`tokenize` は `CREATE VIRTUAL TABLE` 時のみで既存表の tokenizer 変更手段の記載が無いこと・"Whenever column values are required by FTS5, it queries the content table..."・増分実行を許すのは `merge` / `usermerge` / `automerge` だけであること — **第9.2節 条件2 の「`'rebuild'` を採らず projection の全行再実行にする」「tokenizer 変更は4段の forward-only へ分解する」という結論は公式記載から正しく導かれている。**
- **[N-004]（同上）第8.2節の「同期 commit を型で表す」トリックを実際に typecheck して成立を確認した。** `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` に対し、`async` コールバックと `Promise` を返す非 async コールバックはどちらも `Type 'Promise<number>' is not assignable to type 'never'.` で拒否され、同期コールバック（値返し / void）は通る（リポジトリの `node_modules/.bin/tsc` で確認）。条件型が推論サイトにならないために `T` が `unknown` へ落ちて検査が空振りする、という懸念は成立しない。したがって「`async` を型で排除すれば `await` が構文エラーになる」という第8.2.1節 (b)(c) 棄却の根拠は実際に効く。
- **[N-005]（Blocker / Warning 相当ではない）第7.1節の「別列を surrogate にする」分岐で、`fts5vocab` を「列値取得が発生する経路」として挙げているのは不正確に読める。** 場所: `.thread/34/design.md:1541`。`fts5vocab` の `col` / `row` / `instance` は FTS の転置索引側を読むテーブルなので、content テーブルへの `WHERE <content_rowid> = ?` を伴わない。ただし (i) この記述は本設計が**採らない**分岐（設計は `rowid INTEGER PRIMARY KEY` を採る）の中にあり、(ii) 同じ括弧の残り2つ（`'integrity-check'` 相当の整合性検査、将来の `snippet()` 導入）は実際に content テーブルを引くので、**結論（surrogate 列には UNIQUE と索引を必須にする）は成立している。** 直すなら例示から `fts5vocab` を落とすだけでよい。
- **[N-006]（W-001 の一般形。W-001 以外の `kind` については Blocker / Warning 相当ではない）分類 (C) の `poison` は「投入点が繰り返し叩かれるか」で復旧可能性が分かれ、繰り返し叩けない4種は実質終端になる。** 設計はこれを個別に受けているので破れではないが、受け方が均一でないことは #37 / #38 が読み取れる形で残っている。
  - 繰り返し叩ける（復旧可能）: `send-mail`（窓が変われば新しいキー）/ `resume-signup`（新しい `operationId`。到達不能アカウントの終端は第6.4節 3 が持ち、poison + エスカレーションを #38 へ送っている）。分類 (A)(B) の5種はすべて投入点が利用者操作か operator 経路なので同じく復旧可能である（`rotate-encryption` は maintenance RPC を再実行すれば `poison → pending` の規則で戻る）。
  - 実質終端: `reindex` / `migrate-bulk`（投入点は migration ゲートで、`schema_version` が進んだ後は冪等にスキップされるため二度と投入されない）/ `finalize-withdrawal`（手順1 は `account.status = 'active'` でしか通らない。受け口は `purge-user-mappings` の operator 経路で第6.7節が明記済み）/ `resume-link`（`active` な孤児 mapping の回収経路が第6.9節の記述では `resume-link` 一本で、退会が起きなければ引き取られない）。
  - 第11.3節が #38 へ送っているのは `done` / `poison` の**保持期間**だけで、**`poison` 行そのものを検知して再投入する運用項目が無い**。W-001 の提案 (b) を採るならこの項目を1つ足すのが自然である。
- **[N-007]（同上）本ラウンドで観測した限り、非同期・UoW・migration の範囲に「両立しない2つの記述」は残っていない。** 具体に見た組は次のとおりで、いずれも一方が正本を名乗り他方が「適用」と明示する形に揃っている。
  - 第7.7節 項2（永続ジョブに載るものの4類型）と第7.4節の `kind` 全数表 — 「外部 I/O だけ」と書いてはならないという禁止まで明文化されており、`grep` でも当該表現は禁止文以外に出現しない。
  - 「早める方向にのみ」（外部からの再投入）と (1-A)/(1-B) の再武装（ジョブ自身の再スケジュール）— 第7.4節・第4.1節 行5・第7.5節の3箇所が同じことを述べており、retention 延長は「空振り1回 + 再武装」で閉じている。
  - `reindex` のカーソル — 第7.4節「カーソルの永続先」と第9.2節 条件2 の両方が `migration_progress` を指し、旧記述（内部カーソル）の撤回が両側に書かれている。第8.2節の `setMigrationCursor` と第4.1.1節の主キー `(targetVersion, step)` も整合。
  - `alarm()` 先頭の順序（(1) 再武装 + `sync()` → (2) migration ゲート → (3) 仕事）— 第7.4節・第9.2節・第9.4節の3箇所が同じ順序を書き、fail-closed の `deleteAlarm()` 例外も両側に但し書きがある。
  - `deleteAlarm()` の述語 — 実行可能集合（`status IN ('pending','running')`）に統一され、完了時の `nextRunAt` NULL 化と対で読む形になっている。claim の第2の選言に `status='running'` を含める規則も同じ「2つの規則を対で置く」型の冗長化であり、矛盾ではない。
  - 3階層の件数上限 — 「25 × 中間 × 内側」（1起動の上界）と「中間 × 内側」（1ジョブの上界）が区別され、第9.2節の `migrate-bulk` の読み（外側は発火しない / 効く保護は中間と内側の2つ）と一致する。
- **[N-008]（同上）UoW 契約と既存ポート定義の整合について、`UnitOfWorkContext` のスケッチが2つの DO クラスの口を1つの型に並べている点は、第4.1.1節の非集約ストア表の「所属」列（両クラス / User Data DO / Identity Directory DO）が分割の材料を与えているので実装不能ではない。** 同様に `enqueueJob(kind: JobKind, ...)` は12種の union なので User Data DO から Directory の `kind` を渡す型が通るが、所有者の全数は第7.4節の表が持つ。どちらも #37 が per-DO の型へ絞る余地の話であり、契約としての破れではない。
