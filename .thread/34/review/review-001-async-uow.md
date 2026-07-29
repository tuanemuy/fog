# レビュー — 非同期処理・UoW 契約・migration 設計（PR #43 / Issue #34）

**対象:** `.thread/34/design.md`（1059行）/ `.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md`
**観点:** 非同期処理・UoW 契約・schema migration（Issue #34 対応項目4、`plan.md` の AC-5 / AC-21）
**日付:** 2026-07-29

## 非同期処理・UoW・migration

### Blockers

- **[B-001]** `ctx.storage.transaction()`（非同期コールバックを受け付ける公式 API）が代替案として一度も検討されていない。「UoW を完全同期にし、ドメインのリポジトリポートから `Promise` を外す」という本 PR で最も高価な決定の根拠が、検討していない選択肢を残したまま閉じている
  - 場所: `.thread/34/design.md:769-777`（第8.2.1節「選択肢は2つあった」）/ `.thread/34/design.md:73`（第2.1節 fact #7）/ `.adr/004-do-local-commit-and-alarm-jobs.md` 影響節
  - 理由: Cloudflare 公式（`/durable-objects/api/storage-api/`）は `transaction(closureFunction(txn))` を **`Promise` を返す API** として定義し、SQLite-backed DO について「the `txn` object is obsolete. Any storage operations performed directly on the `ctx.storage` object, including SQL queries using `ctx.storage.sql.exec()`, will be considered part of the transaction」と明記している。つまり「DO でトランザクションを張る手段は `transactionSync` だけ」ではなく、**コールバックが async でよい経路が公式に存在する**。設計は第2.1節 fact #7 に `transactionSync` のみを載せ、`transaction()` の存在を一行も書いていない。その結果、第8.2.1節の選択肢は (a) 同期化 / (b) `SemanticCommitPort` の2つに閉じ、「(a) 一択」という結論が**存在しない制約の上に立っている**ように読める。この結論は `CLAUDE.md`「Reference runtime」の「ランタイムを差し替えても domain / application / presentation は無傷」を破棄する唯一の理由であり、代替案の欠落がそのまま最重量の意思決定の根拠の欠落になる。#37 の担当者が着手直後に `transaction()` を見つけて「これで済むのでは」と設計を再開させる確率が高い（本 Issue の目的「#37 が成果物だけで着手できる」に直接反する）
  - 補足（結論自体は生き残る見込み）: 上の公式記述を素直に読むと、`transaction()` のコールバック内で `await` すると input gate が開き、**割り込んだ別ハンドラの `ctx.storage` 書き込みまで同じトランザクションに巻き込まれる**。さらに同ページは「Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically」と書いており、原子性の条件がそもそも「await を挟まないこと」である。加えて fact #9（カーソルは `await` を跨ぐとスナップショット安定性を失う）も同じ方向を指す。したがって (c) は棄却されるべきだが、**棄却の記録が無いことが問題**である
  - 提案: 第2.1節に `transaction()` を fact として追加（種別: 公式記載、「SQLite-backed では txn オブジェクトは obsolete」「await を挟まない書き込み列は自動的に原子的」を含める）し、第8.2.1節の選択肢を (a)(b)(c) の3つにして (c) を上の理由で明示的に棄却する。`.adr/004` の「同期トランザクションのコールバックがそもそも外部呼び出しを許さない」という代替案節の記述も、`transaction()` の存在を踏まえた表現へ直す

- **[B-002]** lazy migration の実行ゲートが「全 RPC エントリの先頭」に限定されており、`alarm()` エントリを含んでいない。設計自身が「アクセスの無い利用者でも Alarm で期限処理が走る」ことを retention 方式の利点として掲げているため、**未 migration の DO で alarm ハンドラが走る経路が設計上開いている**
  - 場所: `.thread/34/design.md:863`（第9.2節「起動タイミング: DO の全 RPC エントリの先頭に置いた冪等なゲート関数で走らせる」）/ `.thread/34/design.md:894`（第9.4節「その DO は**リクエストを受け付けず** `SystemError` を返す」）/ `.thread/34/design.md:706`（第7.5節「Alarm は DO を起こすので、利用者がアクセスしていなくても期限処理は走る」）
  - 理由: dormant なユーザーの User Data DO は、次に起きる契機が `purge-trash` の Alarm しか無い。そのとき RPC ゲートは通らないので、`_meta.schema_version` は古いまま `alarm()` が走り、ジョブ実行部（新コード）が新スキーマ前提の SQL を投げる。第9.3節の「両対応の読み取り」はデータ書き換え中の期間の話であって、**DDL が未適用の DO** を救わない。逆向き（第9.4節の「コードより新しい version」の fail-closed）も alarm 経路に掛かっていないので、ロールバック直後に古いコードの alarm が新スキーマを触る経路も塞がっていない。第9.4節が守ろうとしている「読めないより壊れるほうが悪い」という判断が、alarm 経路でだけ効かない
  - 提案: 第9.2節の起動タイミングを「全 RPC エントリ**および `alarm()` の先頭**」に直す。第9.4節の fail-closed も alarm を含める形にし、fail-closed で止まった DO の alarm をどう扱うか（再設定して止めるのか、poison にするのか）を1文で決める。第7.5節の「アクセスが無くても走る」という主張は、このゲートが alarm に掛かって初めて成立することを明記する

- **[B-003]** Alarm の再武装を `finally` に置いているが、同じ節が支配的な失敗モードとして自ら定義した「CPU 予算超過は例外ではなくエビクション / リセットとして現れる」条件では `finally` は実行されない。設計が自分の失敗モデルを満たしていない
  - 場所: `.thread/34/design.md:693`（第7.4節「Alarm ハンドラの `finally` では、リトライ・後片付けを継続するために DB の最早時刻へ必ず再設定する」「設定に失敗したら次の DO 入力で DB から最早時刻を再計算する」）/ `.thread/34/design.md:689-691`（同節「超過の帰結はエラーではなく**エビクションとリセット**」「『例外が上がるから検出できる』を前提にした設計にしない」）
  - 理由: isolate が殺される形のリセットでは `finally` ブロックは走らない。したがって「Alarm 処理中に CPU 予算を使い切って落ちる」ケースでは、**プラットフォーム側の alarm も DB 側の最早時刻からの再設定も、どちらも行われない**。フォールバックとして書かれている「次の DO 入力で再計算」は、Identity Directory bucket（未認証トラフィックが常時来る）では機能するが、**dormant な利用者の User Data DO では次の入力が来ない**。その DO の `purge-trash` は恒久的に停止し、ゴミ箱の保持期限が無期限に伸びる — 誰も気づかない形で。第7.4節が lease / `ownerToken` を「実行中に DO がリセットされた場合の回収手段」として用意しているのも、回収を駆動する次の Alarm が張られていなければ空振りする。なお Cloudflare 公式（`/durable-objects/api/alarms/`）が書いているのは「If an unexpected error terminates the Durable Object, the `alarm()` handler **may** be re-instantiated on another machine」で、"may" であり本設計が寄りかかれる保証ではない
  - 提案: 再武装を**ハンドラの処理開始前**に移す。すなわち alarm ハンドラの先頭で「今回の処理予算が尽きた場合の再開時刻（例: now + budget）」へ `setAlarm` してから仕事を始め、正常完了時に DB の最早時刻へ張り直す。これなら黙ってリセットされても alarm が武装済みのまま残る。`finally` での再設定は正常系・例外系の最適化として残してよいが、**正しさの拠り所にしない**。あわせて公式の「`alarm()` が throw した場合は 2 秒から指数バックオフで最大6回」というリトライ上限（第2.1節 fact #2）を使い切った後に何が起きるか（alarm が消える）を第7.4節に1文で書き、ジョブランナーが `alarm()` から throw しない設計であることを明示する

### Warnings

- **[W-001]** external-content FTS5 を rows-written の緩和策として位置づけているが、緩和されるのは複製された本文行だけで、trigram の増幅本体である転置インデックスの書き込みは変わらない。「更新時に仮想テーブル全体を走査せずに済む効果もある」は根拠が示されていない
  - 場所: `.thread/34/design.md:617`（第7.1節）/ `.thread/34/design.md:285`（第4.6節）/ `.adr/003-sqlite-fts5-only-search.md` 影響節
  - 理由: FTS5 の shadow table のうち `content=` 指定で消えるのは `%_content`（1ドキュメント1行の本文複製）であり、書き込み行数を支配するのは `%_data`（インデックスセグメント）である。trigram は `%_data` 側の増幅が最大になるトークナイザなので、external-content にしても **rows written の主要因はそのまま残る**。第4.6節は「それでも trigram の転置インデックス自体は本文長に比例して膨らむ」と正しく書けているのに、第7.1節では「緩和策として external-content FTS5 を採る」と書き、効果の範囲が読者に伝わらない。「更新時に仮想テーブル全体を走査せずに済む」は FTS5 の挙動として裏付けが無く、削るか根拠を付けるべき
  - 提案: 第7.1節を「external-content は**容量**（本文の二重保持）を消すためのものであり、rows written の主要因（インデックス行）は消えない」と書き分ける。`.adr/003` の影響節「容量の見積りと費用試算は本体の行数ではなく索引の行数で行う」は正しいのでそのままでよい。「走査せずに済む」の一文は削除を推奨

- **[W-002]** external-content FTS5 を採るための必須の実装制約（更新・削除前に旧値で `'delete'` コマンドを投入すること、`content_rowid` に安定した INTEGER rowid が必要なこと）が書かれていない。第4.4節の「PK は単一列 TEXT の `id`」と組み合わさると #37 が確実に踏む
  - 場所: `.thread/34/design.md:617`（第7.1節）/ `.thread/34/design.md:263-267`（第4.4節）/ `.thread/34/design.md:195`（第4.1節の `search_entries` + `search_fts`）
  - 理由: external-content FTS5 は本体行を書き換える前に `INSERT INTO fts(fts, rowid, <cols>) VALUES('delete', <old rowid>, <old values>)` で旧内容をインデックスから引き算しないと、インデックスが黙って壊れる（例外は上がらない）。設計は「本体を書くトランザクションの中で projection を更新する」（第7.1節）とだけ書いており、トリガーを使わない方針なら **旧値の読み出しが同一 `transactionSync` の中に必要**である。また `content_rowid='rowid'` は INTEGER rowid への安定した写像を前提にするが、第4.4節はすべてのテーブルを単一列 TEXT `id` の PK にすると決めている（暗黙 rowid は存在するが、`id` からの写像を自前で持たないと 'delete' の rowid を組み立てられない）。この2点は「同期更新できる」という結論の成否ではなく、実装の正しさに直結する
  - 提案: 第7.1節に (i) 更新・削除は「旧値で delete → 新値で insert」の2段であること、(ii) `search_entries` に INTEGER の surrogate rowid を明示的に持たせるか、`content_rowid` に使う列を明記すること、の2点を追記する。「FTS の整合はトリガーではなく projection コードが担う」という帰属も1文で書く

- **[W-003]** 第4.7節の翻訳先 `SystemError(ServiceOverloaded)` / `SystemError(StorageCapacityExceeded)` は既存の `SystemErrorCode` に存在しない新規コードだが、そのことが書かれておらず、第11.2節の変更対象にも `application/errors.ts` / `presentation/errorResponse.ts` が挙がっていない
  - 場所: `.thread/34/design.md:293-300`（第4.7節の翻訳表）/ `.thread/34/design.md:994-1008`（第11.2節の削除・新設対象表）
  - 理由: 実物の `packages/core/src/application/errors.ts:187-202` の `SystemErrorCode` は `DatabaseError` / `DataIntegrityError` / `CryptoError` / `SessionError` / `NetworkError` / `ExternalApiError` の6つで、`ServiceOverloaded` も `StorageCapacityExceeded` も存在しない。第4.7節は既存コードを指しているかのように書かれているため、#37 が「探しても無い」ことになる。さらに `apps/web/app/presentation/errorResponse.ts` の HTTP status 写像は `kind` 単位（`HTTP_STATUS_BY_KIND`）で、`code` を見ていない。したがって `overloaded`（本来は 429 / 503 相当）も `SQLITE_FULL`（容量超過）も **どちらも 500 になる**。`CLAUDE.md`「HTTP status mapping is presentation-only, driven by the serialized `kind`」という契約とは整合するが、その帰結が設計に書かれていない
  - 提案: 第4.7節に「この2コードは新規追加である」と明記し、第11.2節の変更対象に `packages/core/src/application/errors.ts`（`SystemErrorCode` へ2値追加、`RETRYABLE_SYSTEM_CODES` には入れない）を足す。`overloaded` を 500 のまま出してよいか（＝ status 写像を kind 単位のまま据え置くか）は本設計で断定すべき論点なので、1文で結論を書く

- **[W-004]** 「Alarm 駆動には CPU 30秒を戻す契機が無い」は公式記載ではなく**記載の不在からの推論**である。第2.1節は fact #4 を「公式記載」と分類しているため、そこから導いた第7.4節・第9.2節の結論が公式保証であるかのように読める
  - 場所: `.thread/34/design.md:70`（第2.1節 fact #4）/ `.thread/34/design.md:689`（第7.4節）/ `.thread/34/design.md:867-869`（第9.2節）
  - 理由: 公式（`/durable-objects/platform/limits/`）の原文は「Each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds」で、**alarm 起動について肯定も否定もしていない**。設計はこれを「alarm には戻す契機が無い」と読み替えて、bounded 処理の判定基準を wall time から CPU 予算へ切り替える根拠にしている。同じ問題が RPC にもある — 本設計の主経路は `fetch()` ではなく Workers RPC（第8.3節）だが、RPC 呼び出しが「incoming HTTP request」に当たるかは公式に書かれていない。第2.1節は fact #5 について「列挙 API の不在は記載の不在による」とわざわざ但し書きを付けており、その運用と不整合である
  - 提案: fact #4 の種別欄に「reset の対象に alarm / RPC が含まれるかは**記載の不在**による推論」と但し書きを足すか、fact を「#4（公式記載）」と「#4b（推論）」に割る。結論（保守的にチェックポイント分割する）は推論が外れても安全側なので変える必要はない。第11.4節の spike 項目に加えるのも一案

- **[W-005]** `blockConcurrencyWhile` を捨てた代償として、migration ゲートの正しさが「ゲート関数が await を挟まない同期実行であること」に依存するが、その条件が明示されていない
  - 場所: `.thread/34/design.md:863-865`（第9.2節）/ `.thread/34/design.md:887-890`（第9.3節）
  - 理由: 第9.3節は各ステップの適用と `schema_version` の更新を同一 `transactionSync` に入れると決めているので、**1ステップ単位の原子性**は担保される。しかし複数ステップの migration をゲートが順に回す間に `await` が1つでも入ると、input gate が開いて並行 RPC が割り込み、その RPC 自身のゲートが同じ migration を別のステップから走らせる。冪等に書いてあれば最終状態は収束するが、ステップ間に順序依存がある場合（`ALTER TABLE ADD COLUMN` → backfill → `CREATE INDEX`）は途中の観測が壊れる。`blockConcurrencyWhile` を明示的に棄却した以上、代わりの排他条件を設計側で言い切る必要がある
  - 提案: 第9.2節に「ゲート関数は同期関数とし、`schema_version` の読み取りから全 DDL ステップの適用まで `await` を挟まない。したがって input gate が排他を保証する」と1文で書く。重い部分を `migrate-bulk` ジョブへ逃がす方針（既に書かれている）はこの条件と両立する

- **[W-006]** Directory bucket の予約 TTL 掃除ジョブと、phase 3 以降の saga 再開が競合しうる。結果として「クレデンシャルを1件も持たない `active` アカウント」＝ログイン手段の無い到達不能アカウントを作れる
  - 場所: `.thread/34/design.md:517-525`（第6.4節の補償表）/ `.thread/34/design.md:498-506`（第6.3節の saga 表）/ `.thread/34/design.md:694`（第7.4節「(a) 予約の期限切れ掃除」）
  - 理由: 第6.4節の規則は「phase 3 以降は前進」だが、**前進できない場合が規定されていない**。phase 3（User Data 初期化・`active` 化）完了後に落ち、予約 TTL が経過して bucket の sweep ジョブが `reserved` 行を消し、その canonical を別の利用者が先に取得した場合、再開した saga は phase 2 で `ConflictError("EMAIL_ALREADY_REGISTERED")` に当たって前進できない。第6.6節の unlink ガード（`credential_locators` の行数が1なら拒否）は unlink 経路にしか掛かっておらず、この経路を救わない。第10.1節は「どちらか一方の restore だけでアカウントが復活することは無い」という fail-closed 性を強調しているが、この経路は fail-closed が**利用者のアカウントを永久に閉じる方向**に働く
  - 提案: (i) 予約の TTL を「saga の再開間隔 × 十分な回数」より必ず長く取る、(ii) phase 3 以降は sweep の対象から外す（`reserved` 行に「saga が phase 3 を超えた」印を持たせ、sweep はそれを消さない）、(iii) それでも前進できなかった場合の終端（アカウントを `deleting` へ倒して補償する／運用へ上げる）を1つ決める、のいずれかを第6.4節に書く。少なくとも「前進できない場合がある」ことを設計が認識していると読める状態にする

- **[W-007]** 第4.3節の行29 / 行30 が「indexer 専用 / pruner 専用の拡張 `WorkerContainer`」の出典に `packages/core/src/application/di/types.ts` を挙げているが、そのような型は実装に存在しない。第11.2節も実在物を消すかのように書いている
  - 場所: `.thread/34/design.md:256-257`（第4.3節 行29 / 行30）/ `.thread/34/design.md:1001`（第11.2節「そこから拡張していた (i) indexer 専用コンテナ (ii) pruner 専用コンテナの2種類も同時に消える」）
  - 理由: 実物の `packages/core/src/application/di/types.ts` に定義されている Container 型は `RequestContainer`（:53）と `WorkerContainer`（:70）の2つだけで、専用コンテナは存在しない。`serverCloudflare.ts` のファクトリも `createRequestContainer` / `createWorkerContainer` の2本のみ。専用コンテナが書かれているのは spec 側（`spec/domains/search.md:264` / `spec/usecases/search.md:93` / `spec/domains/trash.md:239` / `spec/usecases/trash.md:315`）だけである。「不要になる」という結論は変わらないが、#37 にとっては「コードを消す作業」ではなく「spec 上の未実装の設計指示を撤回する作業（＝#35 の領分）」であり、担当 Issue が違う
  - 提案: 行29 / 行30 の出典から `application/di/types.ts` を落とし、spec 側の4箇所に差し替える。第11.2節の削除対象表からも専用コンテナの行を外し、第11.1節（#35 の spec 改訂）側へ移す。`WorkerContainer` そのものが消えるのは事実なので、そちらは第11.2節に残す

- **[W-008]** 第4.3節の行20 が「Outbox relay / consumer / DLQ / pruner」の出典に `packages/core/src/application/workers/` を挙げているが、同ディレクトリにあるのは `eventRelayWorker.ts`（301行）と `outboxPrune.ts`（25行）の2本だけで、consumer / DLQ は存在しない
  - 場所: `.thread/34/design.md:247`（第4.3節 行20）/ `.thread/34/design.md:997`（第11.2節「`packages/core/src/application/workers/`（`eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 ほか）」）
  - 理由: consumer / DLQ の実体は `apps/web/app/worker/cloudflare/handlers.ts`（138行）の `handleQueue`（:82）/ `handleDlq`（:120）である。第11.2節はそちらも別行で正しく挙げているので削除漏れは起きないが、行20 の出典表記は事実と合っていない。第11.2節の「ほか」も、実際には他のプロダクションファイルは無い（`__tests__/` のみ）
  - 提案: 行20 の出典を `packages/core/src/application/workers/`（relay / pruner）と `apps/web/app/worker/cloudflare/handlers.ts`（consumer / DLQ）に分ける。第11.2節の「ほか」を「+ `__tests__/`」に直す

- **[W-009]** Outbox 廃止後の非同期実行契約（`CLAUDE.md`「Delivery is at-least-once with no ordering guarantee; consumers must be idempotent」の置き換え）が、#35 がそのまま写せる断定文として1箇所にまとまっていない
  - 場所: `.thread/34/design.md:665-695`（第7.4節）/ `.thread/34/design.md:709-722`（第7.6節）/ `.thread/34/design.md:982`（第11.1節の `CLAUDE.md` 行）
  - 理由: 第11.1節は `CLAUDE.md` の「Key concepts」の Outbox / domain events / Retry strategy / Unit of Work を「本設計に合わせて書き直す」と #35 へ投げているが、**何に書き直すのかが1箇所に無い**。断片は揃っている（外部副作用は at-least-once・provider 冪等キー・lease・poison・OCC は握り潰さない）が、**ジョブ間の順序保証**についてはどこにも記述が無い。単一 Alarm + `nextRunAt` 順の逐次処理という機構上、種別の異なるジョブ間には順序保証が無く、それが W-006 の競合を生んでいる。「順序保証は無い」を明言するか「同一 `operationKey` 系列では nextRunAt 順に処理される」を保証するかで、#37 の実装が変わる
  - 提案: 第7章の末尾に「新しい非同期実行契約」の小節を置き、(i) ジョブ実行は at-least-once、(ii) ジョブ間の順序保証は無い（または保証する範囲を明示）、(iii) ジョブ実装は冪等であること、(iv) OCC 競合は再試行せず呼び出し元まで届ける、を4行で断定する。#35 はそれを `CLAUDE.md` へ写すだけになる

- **[W-010]** 第2.3節・第4.2節・第4.3節が「実装済み」として引用している事実のいくつかが実物と食い違っている。設計の結論は変わらないが、#37 が着手時に見つけられない対象を探すことになる
  - 場所: `.thread/34/design.md:108`（第2.3節「SSO — …リポジトリ、`packages/core/src/application/identity/` まで実装済み」）/ `.thread/34/design.md:110`（同「`AiClientConnection` — 値オブジェクトだけが実装済み」）/ `.thread/34/design.md:228-257`（第4.3節）
  - 理由: 実測では次のとおり。(i) `UserRepository.findBySsoIdentity` はコードベースに 0 ヒットで、`packages/core/src/domain/identity/ports/` にあるのは `userRepository.ts` / `passwordHasher.ts` の2本のみ。SSO で実装済みなのは値オブジェクト・エンティティ・`users_sso_identity_uq`・`users` テーブルへの sum-type 列書き込みまでで、**解決経路はリポジトリ層に存在しない**。(ii) `AiClientConnection` という名前のシンボルは存在せず、実在するのは `AiClientConnectionId`（`valueObject.ts:125`）と `ClientName`（同 :142）。(iii) 第4.3節は `spec/inventory/adapter.md` 台帳（ユニーク85件は実測一致、引用 ID も全件実在）を出典にしているが、台帳は spec 由来なので**「台帳にある」と「実装がある」が区別されていない**。`password_reset_tokens` / `search_fts` / `search_embeddings` は `0000_initial.sql` に存在せず（実装済みテーブルは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つ）、`AiClientConnectionRepository` / `PasswordResetTokenPort` / `MailSender` / `IndexerReadPort` / `SearchIndexPort` / `TrashQueryPort` も未実装
  - 提案: 第2.3節の SSO の行から「リポジトリ」を落とし、`AiClientConnection` を `AiClientConnectionId` / `ClientName` に直す。第4.3節の冒頭に「本表は `spec/inventory/adapter.md`（spec 由来の台帳）を走査したもので、行の存在は実装の存在を意味しない」の1文を足す（これは第4.3節の網羅性の主張を弱めない — 述語の適用対象が spec であることを明示するだけ）。第2.3節の主張「#37 が書き換える既存コードの量は小さい。ただしゼロではない」はむしろ強まる

### Notes

- **[N-001]** 第8.2節の UoW 型を実際に `tsc --strict` で検証したところ、**主張どおり機能する**。`run<T>(fn: (ctx: UnitOfWorkContext) => T extends Promise<unknown> ? never : T): T` に `async` コールバックを渡すと `Argument of type '(ctx: Ctx) => Promise<number>' is not assignable to parameter of type '(ctx: Ctx) => never'` で落ち、非 `async` だが `Promise` を返すコールバック（`(ctx) => Promise.resolve(ctx.x)`）も同様に落ちる。同期コールバックでは `T` が正しく推論され（`number`、union 戻り値なら `string | number`、`void` も可）、通常利用を阻害しない。TypeScript は条件型の分岐位置からも推論するため、条件型を引数側に置いたこの形は、戻り値側に置く形（`run<T>(fn: (ctx) => T): T extends Promise<unknown> ? never : T`。async でも呼び出し自体はエラーにならず `never` が伝播するだけ）より**強い**。第8.2.1節が (b) を棄却した根拠は型機構としては成立している
  - 唯一の抜け穴は戻り値が `any` の場合で、`any` は条件型の両分岐へ分配されるため素通りする。設計の主張「コマンド機構より強い保証がゼロコストで得られる」に影響する規模ではないが、#37 は UoW コールバック内で `any` を作らない lint 方針と併せると穴が閉じる

- **[N-002]** 第2.1節の「公式記載」20項目を Cloudflare 公式ドキュメントで実際に取得して裏取りした結果、**全件一致**した。とくに次は原文まで確認済み
  - `transactionSync`: "The callback must complete synchronously, that is, it should not be declared `async` nor otherwise return a Promise." / "If `callback()` throws an exception, the transaction will be rolled back."（fact #7）
  - `sql.exec()`: "cannot execute transaction-related statements like `BEGIN TRANSACTION` or `SAVEPOINT`"（fact #8）
  - カーソル: "Although a cursor object can technically be held across an `await`, it does not provide a stable snapshot of the query results."（fact #9）
  - Alarm: "Each Durable Object is able to schedule a single alarm at a time" / "If you call `setAlarm` when there is already one scheduled, it will override the existing alarm." / "guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws" / "exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed"（fact #2）
  - CPU: "30 seconds (default)" / "configurable to 5 minutes of active CPU time" / "Each incoming HTTP request or WebSocket message resets the remaining available CPU time to 30 seconds" / "If you consume more than 30 seconds of compute between incoming network requests, there is a heightened chance that the individual Durable Object is evicted"（fact #4）
  - Alarm handler wall time 15分が limits ページ側にしか無いこと（fact #3）、alarms ページが duration を述べていないことも確認した
  - `blockConcurrencyWhile`: "there is a 30 second timeout applied when executing the callback" / "If this timeout is exceeded, the Durable Object will be reset."（fact #23）
  - `waitUntil`: "Unlike in Workers, `waitUntil` has no effect in Durable Objects."（fact #22）
  - 仮想テーブル: "Writing data to SQLite virtual tables also counts towards rows written."（fact #15）
  - PITR: 過去30日 / DB 全体（SQL + KV）が対象 / "The PITR API is not supported in local development"（fact #20）
  - 限界値（10 GB / 5 GB / 1,000 req/s + overloaded / LIKE・GLOB 50 バイト / 100列 / 行 2 MB / SQL 文 100 KB / bind 100）も一致。fact #26 の「結果セット合計サイズ上限は limits ページに項目が無い」も一致

- **[N-003]** **「FTS5 を本体更新と同一 SQLite transaction で同期更新できる」という結論は技術的に成立する。** 根拠3点（同一 SQLite / `transactionSync` の原子性とロールバック / workerd 実測）はいずれも上記の公式記載と噛み合っており、`sql.exec()` が `BEGIN`/`SAVEPOINT` を実行できないことが迂回不要である点も正しく処理されている。これに伴う `IndexerReadPort` の消滅と `SearchIndexPort` の `query` 単独への縮小も、ポートの由来（`spec/domains/search.md:153-159` / :184-191）と整合する

- **[N-004]** 第2.1節 fact #10 の保守的な扱い（`bm25` / `snippet` / `highlight` / trigram は公式ページに一語も無い）は文字どおり正しいが、**やや過小評価**でもある。upstream SQLite では `bm25()` / `snippet()` / `highlight()` は FTS5 の組み込み補助関数、trigram は FTS5 の組み込みトークナイザであり、「FTS5 module（`fts5vocab` を含む）をサポート」という公式記載はそれらを含むと読むのが自然である。加えて同ページは "Refer to the source code for the full list of supported functions" と続けている。`.adr/003` の成否が実測1件だけに懸かっているような書き方は、実際よりリスクを高く見せている。安全側なので修正は必須ではないが、fact #10 の効き先に「FTS5 module の記載が upstream の補助関数・トークナイザを含むという読みも可能」と1行足すと `.adr/003` の足場が明確になる

- **[N-005]** 第2.1節 fact #14（`transactionSync` のネスト可否）は公式記載が無いという判定で正しい。補足として、非公式には「DO の SQLite は nested transaction / savepoint 相当を提供しない」という記述が複数ある（`sql.exec()` の `SAVEPOINT` 禁止と整合する）。設計の「ネストしない規約を置き、`UnitOfWorkContext` から `UnitOfWorkProvider` へ到達できなくして構造で担保する」は安全側で妥当であり、spike の結果がどちらでも設計は動かない

- **[N-006]** 既存 D1 実装の記述は実物と一致している。`PendingBatch`（`packages/core/src/adapters/d1/pendingBatch.ts:49`、`addOcc()` が `INSERT INTO _occ_guard (n) SELECT changes() WHERE changes() = 0` を追加、:63-71）、CHECK 名 `occ_guard_positive`（`schema.ts:118`）、メッセージ部分一致による OCC 検出（`repositories/helpers.ts:55-69` の `isOccGuardViolation`）、`ConflictError("OPTIMISTIC_LOCK_FAILURE")` の throw（`repositories/userRepository.ts:124-127`）、現行 `run` の署名（`application/execution/unitOfWork.ts:61` の `async run<T>(fn: (ctx) => Promise<T>): Promise<T>`）、`adapters/d1/` が20ファイル・2,514行、`eventRelayWorker.ts` の module scope `crypto.randomUUID()`（:97）、`wrangler.toml` 162行で `durable_objects` 0ヒット、`.gitignore:14-17` のレンダリング生成物 ignore — すべて実測一致。第8.1節の棚卸し3点と第8.4節の OCC 方針（条件付き UPDATE の0行検出へ置き換え、`ConflictError` は握り潰さず境界まで届ける、アプリ層 OCC リトライは置かない）は `CLAUDE.md`「Retry strategy」と整合しており、**既存契約の去就は決着している**

- **[N-007]** `CLAUDE.md`「Reference runtime」の「ランタイム swap で domain / application / presentation は無傷」が破れる点は、第8.2.1節（`.thread/34/design.md:789`）と `.adr/004` の影響節の**両方に明示**されており、`CLAUDE.md` の改訂も第11.1節で #35 へ割り当てられている。Issue の要求「破れる点が明示されているか」は満たしている（妥当性の議論の穴は B-001）

- **[N-008]** 同期 UoW の帰結として「`run()` が返った ≠ 耐久化された」ことに設計が触れていない。実際には output gate が保留中の書き込み完了まで送信を止めるので RPC 応答の時点では耐久化されており、耐久化の失敗は例外ではなく DO のリセット（＝ RPC の失敗）として現れる。結論は変わらないが、第8.2節か第8.3節 (d) に1行あると #37 が「commit の成功をどう確認するか」で迷わない

- **[N-009]** AC-5（断定形）は満たしている。`検討する` / `TBD` / `暫定` / `要検討` / `保留` の grep ヒットは 0 件で、`未確認` は第2.1節の fact #13 / #14 / #26 の3件のみ。いずれも第11.4節で「決める主体 = #37 / いつ = 着手時の spike / 本設計への影響 = 無い（#26 のみ値の決定に使う）」まで割り当てられており、`#37 が着手できない節` は残っていない。AC-21（Account Home の採否）も第3.1節で「採用しない」と断定され、対価3点が示され、第11.4節に現れない

## 裏取りの記録

| 検証したこと | 手段 | 結果 |
|---|---|---|
| 第2.1節の「公式記載」20項目 | Cloudflare 公式5ページを実取得（`api/sql-storage/` / `api/sqlite-storage-api/` / `api/alarms/` / `api/state/` / `platform/limits/`） | 全件一致（N-002） |
| `ctx.storage.transaction()` の存在と SQLite-backed での意味論 | `api/storage-api/` を実取得 | **設計に記載なし**（B-001） |
| alarm がエビクション時に再配信されるか | `api/alarms/` を実取得 | "may be re-instantiated" のみ。保証ではない（B-003） |
| 第8.2節の UoW 型が実際に async を弾くか | `tsc --noEmit --strict` で最小再現 | 弾く。設計の主張は成立（N-001） |
| `transactionSync` のネスト可否 | Web 検索 | 公式記載なし。非公式には「非対応」（N-005） |
| design.md が引用する実装の事実16項目 | 実ファイル走査 | 一致12 / 不一致・部分不一致4（W-003 / W-007 / W-008 / W-010） |
| `spec/inventory/adapter.md` の `ADP-*` ユニーク85件と引用 ID の実在 | 実測 | 85件一致、引用 ID 全件実在（ただし台帳 = spec であって実装ではない。W-010） |
| AC-5 の断定形 / AC-21 | grep + 本文読解 | 満たしている（N-009） |

## 総評

対応項目4の5論点（FTS5 同期更新の可否 / trash retention の Alarm / 外部 I/O を永続ジョブに残す境界 / UoW 契約 / lazy migration）は**すべて断定形で結論が出ており**、外部 I/O の有無で永続ジョブの境界を引く規則（第7.6節）も明快である。Outbox / relay / consumer / DLQ / pruner の廃止範囲は購読者2件を個別に潰したうえで「ドメインイベントを業務・監査の表現としても残さない」まで踏み込んでおり、残存の曖昧さが無い。`CLAUDE.md` の不変条件が破れる点も隠さず書けている。

指摘の重心は2つある。**第一に、最も高価な決定（ドメインポートの `Promise` 剥奪）の代替案検討に公式 API が1つ抜けている**（B-001）。結論は生き残る見込みだが、記録が無いままだと #37 で再燃する。**第二に、Alarm と migration ゲートの適用範囲に、設計自身が掲げた前提（アクセスの無い利用者でも Alarm が回る／CPU 超過は例外にならない）と噛み合わない穴が2つある**（B-002 / B-003）。どちらも dormant な User Data DO という同じ盲点から出ており、alarm 経路を RPC 経路と同格に扱えば同時に塞がる。
