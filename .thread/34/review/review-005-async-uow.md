# レビュー 005 — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design`
**主成果物:** `.thread/34/design.md`（1,975行）/ `.adr/003` / `.adr/004`
**実施日:** 2026-07-30
**方針:** 前ラウンドの指摘を前提にせず、ゼロベースで再読した。今回の重点は前ラウンドで新設された第7.4節「周期・反復ジョブの再武装規則」が実際に成立するかの検証。

## 検証の手段

1. `CLAUDE.md`（Unit of Work / Outbox / Retry strategy / Error handling）を通読。
2. `gh issue view 34` の対応項目4 を確認。
3. `.thread/34/design.md` を全文読解（第1〜11章）。
4. 実コードとの突き合わせ — `packages/core/src/application/execution/unitOfWork.ts` / `packages/core/src/adapters/d1/{unitOfWork,pendingBatch,schema}.ts` / `repositories/helpers.ts` / `packages/core/src/domain/common/{transactionalRepository,event}.ts` / `packages/core/src/domain/identity/{entity,events,valueObject}.ts` / `packages/core/src/domain/identity/ports/userRepository.ts` / `packages/core/src/application/{errors.ts,ports/*,workers/*,di/*}` / `apps/web/app/presentation/{currentUser,authState,errorResponse}.ts` / `apps/web/app/worker/cloudflare/*` / `apps/web/app/server.cloudflare.ts`。
5. Cloudflare 公式ドキュメントを実際に取得して裏取り — `/durable-objects/api/alarms/` / `/api/storage-api/` / `/api/sql-storage/` / `/api/sqlite-storage-api/` / `/platform/limits/` / `/reference/durable-objects-migrations/` / `/workers/reference/security-model/`。
6. 第8.2節の `run` 署名を実際に `tsc`（リポジトリ同梱の TypeScript）でコンパイルして型レベル保証の成否を確認。

## 非同期処理・UoW・migration

### Blockers

- **[B-001]** 「周期・反復ジョブの再武装規則」の駆動源クエリが、ジョブの作業述語と一致していない。どちらの読み方をしても収束しない
  - 場所: `.thread/34/design.md:1247-1252`（規則本体、とくに `:1249`）。関連 `.thread/34/design.md:265` / `:892`（`sweep-reservations` の述語）、`:1295`（`deleteAlarm()` 規則）、`:1326-1327`（第7.5節の適用）
  - 理由:
    - 規則 (1) は駆動源を「`purge-trash` は `min(purge_after)`、`sweep-reservations` は `min(reservedUntil)`、`sweep-reset-tokens` は `min(expiresAt)`」と**列の最小値**として定義し、「**残件があれば**その値へ `nextRunAt` を設定して `pending` へ戻し、**残件が無いときだけ** `done`」としている。ところが `sweep-reservations` の作業述語は第4.1.1節・第6.4節で `WHERE status = 'reserved' AND reservedUntil < ? AND sagaCommitted IS NULL` と確定しており、**駆動源（列の最小値）と作業述語が一致していない**。
    - 一致していない結果、「掃除されないのに `reservedUntil` が過去である行」が存在しうる。具体的には (a) phase 2 成功後 phase 3 未完了のまま `resume-signup` が `poison` に落ちた `reserved` + `sagaCommitted` 行（第6.4節 3 の終端規則は `ConflictError` 確定時にしか走らないので、通常の再試行上限超過ではこの行が残る）、(b) `min(reservedUntil)` を `status` で絞らずに実装した場合、phase 3 で `active` へ昇格した**すべての正常ユーザーの行**（`reservedUntil` を消す規定がどこにも無い）。
    - この状態で規則 (1) を「残件 = まだ `reserved` な行」と読むと（**読み方 A**）、`nextRunAt` が恒久的に過去になり、`alarm()` が即時再発火 → 仕事ゼロ → 同じ過去値で再武装、の**恒久ループ**になる。`pending` 行が常に1件あるので `:1295` の `deleteAlarm()` も発火せず、**同節が `deleteAlarm()` 規則を「省略可能な最適化ではない」とまで書いて塞いだ失敗モード（「起きて、先頭でまた張って、仕事ゼロで終わり、また起きる、の恒久ループ」）が、再武装規則の側から再び開く**。`setAlarm` 1回は課金対象の1行書き込みであり（第2.1節 F-24。公式 pricing 記載を確認済み）、Directory bucket は同一 bucket に写像される全ユーザーを巻き込む。
    - 逆に「残件 = いま処理対象になる行（`reservedUntil < now`）」と読むと（**読み方 B**）、1回の掃除で対象を消し切った時点で `done` になり、**まだ期限の来ていない `reserved` 行に対する次の起動が張られない**。規則 (4) が「これが無いと第6.4節の TTL 掃除（3段ガードの1段目）が1回きりで止まる」として塞ごうとした事象が、そのまま起きる。
    - **つまり規則 (1) の文言はどちらに読んでも破れる。** 正しい駆動源は「作業述語から**時刻条件だけを外した**集合の最小値」（`sweep-reservations` なら `status = 'reserved' AND sagaCommitted IS NULL` の `min(reservedUntil)`）であり、これは現在の文言のどちらの読み方でもない。
    - `purge-trash` も同じ構造の穴を持つ。第4.1節 (5) は `trashed` 列と `purge_after` 列を別に持つと決めているが、**ゴミ箱からの復元時に `purge_after` を消す規定がどこにも無い**。復元済みの行が過去の `purge_after` を保持していると `min(purge_after)` が恒久的に過去になり、読み方 A と同じ恒久ループになる。
  - 提案: 規則 (1) を次の形に書き換える。**(i) 駆動源クエリは「そのジョブの作業述語から時刻条件だけを外したもの」と定義し、`kind` ごとに述語を明記する**（`purge-trash`: `WHERE trashed = 1` の `min(purge_after)` / `sweep-reservations`: `WHERE status = 'reserved' AND sagaCommitted IS NULL` の `min(reservedUntil)` / `sweep-reset-tokens`: `WHERE usedAt IS NULL OR ...` の `min(expiresAt)`）。**(ii) 「残件」を「その集合が空でないこと」と定義し直す**（時刻条件では判定しない）。**(iii) 再計算値が現在時刻以前になった場合、作業対象が0件なら安全弁として最小再開間隔でクランプする**（駆動源と述語がずれる将来の変更に対する保険）。あわせて第7.5節に「復元時に `purge_after` を NULL に戻す」を1行足す。

### Warnings

- **[W-001]** 非同期実行契約の正文（第7.7節 項2）が「永続ジョブに載るのは外部 I/O を伴う処理だけ／該当は1件だけ」と書いているが、第7.4節の `kind` 全数表は12種のうち11種がローカル完結のジョブである
  - 場所: `.thread/34/design.md:1365`（第7.7節 項2）、`:1335` / `:1337`（第7.6節の同旨）。対する `kind` 全数表は `:1218-1231`、テーブル定義は `:249` / `:255`
  - 理由: 第7.7節は「**本節が正文であり**、第7.3節・第7.4節・第7.6節・第8.2節・第8.4節はここへ帰着する。**#35 は本節を `CLAUDE.md` へ写す**」と自ら宣言している（`:1360`）。その正文の項2 が「永続ジョブに載るのは外部 I/O を伴う処理だけである。現時点で該当するのはメール送信の1件だけ」と述べる一方、第7.4節の `kind` 表は `purge-trash` / `reindex` / `migrate-bulk` / `finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption` の**11種のローカル完結ジョブ**を `jobs` テーブルの行として定義している。第7.6節 `:1337` に至っては「外部 I/O を伴わない処理（FTS 更新、**retention のハードデリート、saga の前進**）は……永続ジョブの transport は要らない」と、`purge-trash` と `resume-*` を名指しで「永続ジョブ不要」の側へ置いている。`.adr/004` は「外部 I/O を伴う処理**と期限処理**だけを永続的なジョブとして残し」と正しく書いており、design 側の正文だけが期限処理・saga 前進を落としている。このまま #35 が第7.7節を `CLAUDE.md` へ写すと、`CLAUDE.md` の中核概念と実装（12種の job kind）が最初から食い違う。
  - 提案: 第7.7節 項2 を「**外部 I/O を伴う処理は必ず永続ジョブに載せる**（トランザクション内では実行できないため）。加えて、期限処理・チェックポイント分割を要する一括処理・cross-DO saga の前進も同じ `jobs` テーブルと Alarm で駆動する。`kind` の全数は第7.4節が正本」と書き換える。第7.6節 `:1337` の「retention のハードデリート、saga の前進」の例示は、`jobs` 行を持つ側なので削るか「Queue などの外部 transport は要らない（同一 DO の `jobs` 行で駆動する）」へ限定する。

- **[W-002]** 「SQLite の DDL はデータ量にほぼ依存しない」は `CREATE INDEX` については事実誤りで、そこから導いた「索引追加は単発適用で足りる」という断定が大きく育った DO をブリックしうる
  - 場所: `.thread/34/design.md:1569`（第9.2節「単発適用で足りるかを断定する」）。関連 `:1571-1577`（分割が必要な3条件）、`:1553-1555`（ゲートの起動位置）
  - 理由: 同節は「テーブル追加・列追加・**索引追加**といった DDL 中心の変更は単発適用で足りる。SQLite の DDL はデータ量にほぼ依存しないためである」と断定している。`CREATE TABLE` と `ALTER TABLE ADD COLUMN` については正しい（SQLite の ADD COLUMN はスキーマ更新のみで O(1)）が、**`CREATE INDEX` はテーブル全走査 + ソートで O(n log n)** であり、データ量に正比例する。10 GB まで育った User Data DO の `memos` に索引を1本足すだけで CPU 予算（既定30秒、設定で最大5分）を超えうる。
    そして分割が必要な3条件（1: 全行書き換え / 2: FTS5 全件再インデックス / 3: 1・2 を大きな DO に対して行うとき）は `CREATE INDEX` を1つも捕捉しない（条件3 は明示的に「上記 1 / 2 を」に限定されている）ので、索引追加は単発適用へ分類される。
    帰結が重い。ゲート関数は**全 RPC エントリおよび `alarm()` の先頭**に置かれ（`:1553`）、CPU 予算超過はエラーではなく**エビクションとリセット**として現れる（第2.1節 F-4。公式 limits ページで確認済み）。したがってその DO は「どのリクエストもゲートで落ちる」状態になり、**恒久的に応答不能**になる。しかも同節自身が「例外が上がるから検出できる、を前提にした設計にしてはいけない」と書いているとおり、エラーとして観測されない。第9.5節の PITR も救済にならない（`schema_version` は進んでいないので巻き戻す対象が無い）。`CREATE INDEX` は SQLite ではチャンク分割もできないので、`migrate-bulk` への逃がし先も無い。
  - 提案: (i) `:1569` の根拠文を「`CREATE TABLE` / `ALTER TABLE ADD COLUMN` はデータ量に依存しないが、**`CREATE INDEX` は全行走査を伴うので依存する**」へ訂正する。(ii) 分割条件に「4. 既に大きく育った DO に対する `CREATE INDEX`（FTS5 の `CREATE VIRTUAL TABLE` を含む）」を追加し、**SQLite では分割できないことを明記したうえで回避策を1つ決める** — 「索引は原則テーブル新設時に同時に張り、既存の大テーブルへの索引追加は新テーブル + `migrate-bulk` によるコピー（多段 forward-only）へ分解する」が本設計の他の規則（`:1585` の多段 forward-only）とそのまま噛み合う。

- **[W-003]** 第8.2節の `recordOperation` の署名では `operations.targetLocators` を書けないが、第4.1.1節と第6.6節はその書き込みを必須にしており、第8.2節は代替経路（`ctx.storage.sql` の直接使用）を禁止している
  - 場所: `.thread/34/design.md:1400`（署名）、`:1413`（`ctx.storage.sql` 直接使用の禁止）。要求側は `:250`（`operations` の列全数）、`:973`（link 手順1 が `targetLocators` を記録）、`:990`（unlink 手順2 が全世代分を退避）
  - 理由: 第4.1.1節は「本表はテーブルの全数と、認証・saga・ジョブ系テーブルの**列の全数**の両方の正本である」と宣言し、`operations` の列に `targetLocators`（配列）と `terminalReason` を挙げている。第6.6節は link 手順1 で `{ operationId, kind, payloadDigest, phase, targetLocators }` を記録し、unlink 手順2 で「削除する前に、消す行の locator を全世代分 `operations.targetLocators` へ退避する」と、これを `sweep-orphan-mapping` の唯一の逆引き情報として要求している（`:1000`）。ところが第8.2節が示す唯一の書き込み口は `recordOperation(operationId, kind, payloadDigest, phase): void` で `targetLocators` も `terminalReason` も運べず、同節は「`ctx.storage.sql` を usecase から直接触る形は採らない — レイヤー違反であり、UoW を通らない書き込み経路を作るからである」と代替経路を明示的に閉じている。結果として、**設計が Blocker 級と評価した孤児 mapping 回収（第6.9節の締め出し経路一覧の3行目）を実装する手段が UoW 契約の側に存在しない**。`migration_progress` のカーソル更新については本文が「同じ位置に置く」と補っている（`:1413`）のに対し、`recordOperation` は完全な引数リストが書かれているぶん、#37 がそのまま実装しうる。
  - 提案: `recordOperation` の引数に `targetLocators?: readonly LocatorRef[]` と `terminalReason?: string` を足すか、`operations` 行の更新を担う第2のメソッド（`updateOperation(operationId, patch): void`）を並べる。あわせて第8.2節の擬似コードに `migration_progress` 用のメソッドも1行足し、「この interface は載せるメソッドの全数ではない／全数である」のどちらかを明記する。

- **[W-004]** Outbox 廃止に伴って消えるドメイン層のイベント抽象が、第11.2節の変更対象一覧にも第7.3節の列挙にも1つも現れない
  - 場所: `.thread/34/design.md:1192`（第7.3節が挙げる廃止対象は application 層のポート3本のみ）、`:1855-1876`（第11.2節の変更対象表）。実コードは `packages/core/src/domain/common/event.ts`、`packages/core/src/domain/identity/events.ts`、`packages/core/src/domain/identity/entity.ts:52,77,103,120`（`WithEventDrafts<...>` を返す4つのファクトリ）、`packages/core/src/application/identity/registerWithPassword.ts:46,52,56`
  - 理由: 第7.3節は「ドメインイベントは『業務・監査の表現』としても残さない。`UnitOfWorkContext.collectEvents` は廃止する」と断定し、第11.2節の #36 引き継ぎ表 H-6 も「**抽象ごと消える**」と書いている。ところが具体的な廃止対象として列挙されているのは `application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts` の3本だけで、実際に消える／変わるドメイン層の3箇所 — `domain/common/event.ts`（`EventDraft` / `DomainEvent` / `WithEventDrafts` の定義）、`domain/identity/events.ts`（`UserRegisteredEvent` ほか3種のファクトリ）、`domain/identity/entity.ts` の4つのファクトリが返す `WithEventDrafts<PasswordUser, IdentityEvent>` という**戻り値の形** — がどこにも現れない。`entity.ts` は第6.6節が「`SsoUser` 判別共用体の読み替えが前提になる」と別の理由でも改修を要求しているのに（`:963`）、第11.2節の表には1行も無い。第8.2.1節が「ドメインポートの `Promise` 契約が変わる」を独立した節で扱っているのと比べて非対称で、ドメイン層の契約変更としては同格である。
  - 提案: 第11.2節の表に3行を足す。**削除**: `packages/core/src/domain/common/event.ts` / `packages/core/src/domain/identity/events.ts`。**改修**: `packages/core/src/domain/identity/entity.ts`（ファクトリの戻り値から `WithEventDrafts` を外す + 第6.6節のクレデンシャル集合への読み替え）。あわせて `packages/core/src/application/di/types.ts:37` の JSDoc（`collectEvents` を「唯一のイベント発行点」として説明している）も既存の改修行の中に含める。

### Notes

- **[N-001]** 第8.2節の同期 commit の型表現は、実際にコンパイルして期待どおり動くことを確認した。リポジトリ同梱の TypeScript で `run<T>(fn: (ctx: Ctx) => T extends Promise<unknown> ? never : T): T` を検証したところ、(a) 同期コールバックでは `T` が正しく推論され（`number` / オブジェクト型とも）、(b) `async` コールバックと `Promise` を返すコールバックはいずれも `error TS2322: Type 'Promise<number>' is not assignable to type 'never'.` で拒否された。条件型が推論サイトにならないために `T` が `unknown` へ落ちて保証が空振りする、という失敗パターンには**該当しない**。第8.2節の「`async` を型で排除すれば `await` が構文エラーになるので、コマンド機構より強い保証がゼロコストで得られる」という論拠は成立している。

- **[N-002]** 第2.1節の事実表について、非同期・UoW・migration に効く行を公式ドキュメントから実際に取得して照合し、**確認した範囲では誤りは無かった**。確認したのは F-1（10 GB / Free 1 GB の本文記載と表の不整合まで含めて記載どおり）/ F-2（"exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed" / at-least-once / `setAlarm` の上書き）/ F-3（"Durable Object alarm handlers: 15 minutes"）/ F-4（footnote 4 のリセット契機は "Each incoming HTTP request or WebSocket message" の2つだけ）/ F-4b（FAQ 本文が "the maximum CPU time per Durable Objects invocation (HTTP request, WebSocket message, or Alarm) is set to 30 seconds" と Alarm を invocation として名指ししている。**footnote と FAQ が別々のことを述べていて決着しない、という第2.1節の読みは正確**）/ F-7 / F-8 / F-9 / F-10（公式が挙げるのは FTS5・JSON・数学関数の3つだけで、bm25 / snippet / highlight / trigram は一語も無い）/ F-15 / F-16 / F-17 / F-19 / F-20（30日・DB 全体・ローカル非対応）/ F-21（`exports` と `[[migrations]]` は検証で拒否 / Trash 無し）/ F-22（"waitUntil has no effect in Durable Objects"）/ F-23 / F-26（結果セット合計サイズの記載が実際に無い）/ F-27 / F-28 / F-29 / F-30（alarms ページは `void` / `number | null`、storage API ページは3本とも `Promise` と、**公式内で実際に食い違っている**）/ F-31 / F-32。とくに F-30 と F-4b は「公式内の不整合」「記載の不在」という主張自体が正しいことまで確認した。

- **[N-003]** 実コードの引用も全数に近く照合したが、行番号・行数・列挙とも一致していた。`adapters/d1/unitOfWork.ts:39` の "Read-your-write within the same UoW is unsupported by design"、`repositories/helpers.ts:55-69` の `isOccGuardViolation`、`schema.ts:118` の `OCC_GUARD_CHECK_NAME = "occ_guard_positive"`、`application/errors.ts` の `SystemErrorCode` 6値と `RETRYABLE_SYSTEM_CODES` 2値、`workers/` が `eventRelayWorker.ts` 301行 + `outboxPrune.ts` 25行の2本だけであること（consumer / DLQ は `apps/web/app/worker/cloudflare/handlers.ts` 138行の `handleQueue`:82 / `handleDlq`:120）、`eventRelayWorker.ts:97` のモジュールスコープ `crypto.randomUUID()`、`ports/sessionCodec.ts` の `issue`/`verify` に epoch を運ぶ口が無いこと、`hmacSessionCodec.ts` の `parsePayload` が `uid` / `exp` しか見ないこと、`userRepository.ts` が `insert`/`save`/`findById`/`findByEmail` の4本だけで `findBySsoIdentity` が存在しないこと、`presentation/currentUser.ts:17-26` / `:28-33`、`presentation/authState.ts:18-23`、`errorResponse.ts:70` / `:101`、`server.cloudflare.ts:4,33,44`、`0000_initial.sql` の実テーブル4本（`_occ_guard` / `outbox_events` / `processed_events` / `users`）— いずれも記述どおりである。

- **[N-004]** 第7.1節の external-content FTS5 の実装制約は正しい。(a)「更新・削除は旧値で `'delete'` → 新値で insert の2段」は external-content FTS5 の正しい使い方であり、怠ると例外なくインデックスだけが壊れるという記述も正確。(b)「`INTEGER PRIMARY KEY` は真の rowid alias なので VACUUM でも再採番されない」も正確（逆に rowid alias が無いテーブルは VACUUM で rowid が変わりうる）。(c)「FTS5 は列値が必要になるたびに content テーブルを `WHERE <content_rowid> = ?` で引くので、surrogate 列には UNIQUE と索引が必須」も公式の記述どおり。(d)「external-content で消えるのは `%_content` であって rows written の主要因（`%_data`）は残る」という効果範囲の限定も正しく、第4.6節・第10.2節のコスト見積りと整合している。

- **[N-005]** 第7.4節の `alarm()` 先頭の順序（(1) 再武装 + `await ctx.storage.sync()` → (2) migration ゲート → (3) 仕事）と第9.2節の排他条件は両立している。(1) の `await` はゲートに入る前に完了するので、「ゲート関数は `schema_version` の読み取りから全 DDL 適用まで `await` を挟まない同期関数」という条件は破れない。`await` 中に input gate が開いて別 RPC が割り込んでも、そちらのゲートは同期関数として完走するか未着手かのどちらかなので、alarm 側のゲートが中途半端な状態を観測することもない。RPC 経路の「`run()` 戻り後に `await` を挟まず `setAlarm` → `sync()`」も、F-28 の「すべての書き込みが保存されているか1つも保存されていないか」が同一フラッシュ単位に対する保証であることを正しく使っており、ジョブ行だけが残って alarm が張られない窓を構造的に消している。

- **[N-006]** 第8.4節の OCC（条件付き UPDATE の0行検出）は実装可能で、`version` 列の所在も第4.1.1節で確定している。`RETURNING` を第一候補、`SELECT changes()` を spike 待ちの第二候補、`rowsWritten` を「課金単位であってマッチ行数ではない」として不採用にする序列は、公式の `rowsWritten` の定義（"every row update of an index counts as an additional row" / 最終値は課金に使う）と一致している。`credential_mappings` が `version` を持たない理由（CAS と OCC の権威が二重になる）も筋が通っている。

- **[N-007]** 第4.7節のエラー翻訳表は「捕捉可能性」の観点で正しい。`.overloaded` と `ctx.abort()` / DO リセットは DO のコードが1行も走らない、あるいは送出待ちメッセージごと破棄されるので DO 内に catch 点が無く、呼び出し側の stub ラッパーに置くのが唯一成立する形である。`overloaded` を retryable false にし、かつ 429 / 503 ではなく 500 で返す（クライアントに再試行を示唆しない）判断も、公式の「`.overloaded` が真のエラーはリトライしてはならない」と `CLAUDE.md` の「HTTP status は `kind` だけで決める」の両方を同時に満たしている。「CPU 予算超過には写す先が無い」を明記したのも正しい（エラーではなくエビクションとして現れるため）。
