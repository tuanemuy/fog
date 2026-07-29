# 設計 — Issue #34: Cloudflare Workers + ユーザー単位 Durable Objects の境界・ルーティング設計

**Issue:** #34
**作成日:** 2026-07-29
**対象読者:** #35（spec 改訂）/ #37（D1 → DO 実装）/ #38（運用ドキュメント）の担当者

## 1. この文書の位置づけ ［派生］

### 1.1 読者と入力・出力 ［派生］

本書は Issue #34 の設計成果物である。決定そのものは `.adr/002-cloudflare-workers-and-user-data-durable-objects.md` / `.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md` の3件に置き、**実装可能な粒度の設計は全部ここにある**。

読む順序は実際の依存に沿って書く。**「1つの節だけ読めば足りる」担当者は居ない** — 引き継ぎ節の各行は結論の要約であり、根拠は参照先の節にしかない。

- **#35（spec 改訂）は第11.1節を起点に、そこの各行が指す節をすべて辿る。** 参照先の節は改訂のたびに増減するので、**件数を書かない**（数えた値を本文に置くと、次の改訂で必ず実測とずれる）。列挙の代わりに**必ず入力として要る5節だけ**を名指しする — **第4.1.1節（テーブル全数の正本。受け入れ条件4を満たすための必須入力）**・第4.3節（台帳の行き先判定）・**第6.1.2節（`credentialId` の定義。`spec/domains/identity.md` の `User` 定義と `getCurrentUser` の DTO がここに依存する）**・第7.7節（`CLAUDE.md` へ写す非同期実行契約の正文）・第8.2.1節（ドメインポートの同期化と `CLAUDE.md`「Reference runtime」の訂正）。「何をどう書き換えるか」は参照先が決めている。
- **#37（D1 → DO 実装）は第2.1節（依拠する事実の正本）→ 第3〜9章 → 第11.2節の順に読む。** 第11.2節は第3.2節・第7.3節・第8.1〜8.3節を根拠に挙げており、設計全体が第2.1節のプラットフォーム事実表に依存している。第11.2節だけでは着手できない。**本文が「#37 の改修対象である」と断定している4箇所（第3.2節の `secrets.ts`、第4.7節の `errors.ts`、第5.1節の `currentUser.ts` / `authState.ts`）は、第11.2節にも専用行として取り込んである。** そのうえで**本文と一覧が食い違ったら本文が正本**である — 一覧は要約であり、変更する理由を持っているのは本文の側だからである。
- **#38（運用ドキュメント）は第10章と第11.3節を起点に、そこの各行が指す節をすべて辿る。** ここも件数は書かない（上と同じ理由）。必ず入力として要るのは第6.2.2節（レート制限の具体値）・第6.4節（予約 TTL の不等式）・第6.8節（鍵ローテーション手順）・第9.4節（fail-closed の検知）・第10.1節（PITR の設計上の帰結）である。

本書は先行ブランチ `issue/19/cloudflare-do-fts` や `.thread/1/adr.md`（1,664行の作業ログ）を開かなくても読めるように書いてある。それらへの言及はすべて「出自の注記」であり、内容の代替ではない。

### 1.2 `.adr/002〜004` との分担 ［Issue 要求］

`.adr/` はプロダクトの意思決定だけを置く薄い台帳で、後続の読み手（architecture-audit / spec-sync）はそこだけを見る。本書はその決定を実装可能な粒度へ落とした設計文書である。

| 置き場所 | 何が書いてあるか |
|---|---|
| `.adr/002-cloudflare-workers-and-user-data-durable-objects.md` | Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects を本番構成とする決定。トポロジーの具体は本書第3章 |
| `.adr/003-sqlite-fts5-only-search.md` | 検索を SQLite FTS5 の全文検索のみとし、ベクトル検索・Vectorize・embedding・RRF を採らない決定。成立根拠は本書第7.2節 |
| `.adr/004-do-local-commit-and-alarm-jobs.md` | DO ローカルの同期 commit と Alarm へ移行し、Outbox / relay / consumer / DLQ を廃止する決定。契約の具体は本書第7〜9章 |
| 本書 | DO トポロジー、保持データ、ルーティング、PII、Directory 分割、saga、Alarm、UoW 契約、lazy migration、引き継ぎ |

DO の分割数・saga の手順・migration の手順・スキーマ断片は `.adr/` に書かない。逆に本書は「なぜ Cloudflare か」を再説明しない。

### 1.3 先行案（issue/19/cloudflare-do-fts）との差分 ［派生］

分割元 Issue #19 のブランチには DO 実装一式と ADR 10件（`.thread/19/adr.md`）が残っている。#19 はクローズ済みで #34〜#38 に分割されたので、**これは採用済みの決定ではなく、本 Issue が引き受けるか棄却するかを判断すべき先行案**である。全10件 + レビュー指摘2件に採否を出した。**保留はゼロ** — すべて採用 / 部分採用 / 棄却のいずれかに倒してある。

| 先行案 | 採否 | 採用した内容の要旨 / 棄却の理由 |
|---|---|---|
| ランタイムをすべて Cloudflare Workers に集約し、ユーザーのドメインデータを1つの SQLite-backed User Data DO に置く | **採用** | 本書第3.1節・第4章。認証済みリクエストは `userId` からのみ DO を選び、公開入力からは選べない |
| request Worker と state Worker を別 script にし、`SESSION_SECRET` と routing secret keyring は request Worker だけに配布する | **採用** | 本書第3.2節。加えて配布境界を非重複にした — request Worker はセッション鍵と routing secret、state Worker はメール送信系の鍵だけを持つ |
| 検索は User Data DO 内の FTS5 に限定し、Vectorize / embedding / RRF / `search_embeddings` を削除する | **採用** | 本書第7.1〜7.2節、`.adr/003-sqlite-fts5-only-search.md` |
| 検索 API の詳細（single topic filter、trash 除外、`timestamp DESC, type, id` の安定順位、snapshot table によるページング、external-content FTS5） | **部分採用** | external-content FTS5（本体行を rowid で参照し FTS 側に本文を複製しない）だけを本書第7.1節で採る。残りは検索 API の仕様であり #35 の領分なので第7.2.1節から #35 へ送る |
| 本体と FTS index を同一 SQLite transaction で同期更新し、Outbox / relay / consumer / DLQ を削除する | **採用** | 本書第7.1節・第7.3節、`.adr/004-do-local-commit-and-alarm-jobs.md` |
| usecase は async prepare で typed command を作り、`SemanticCommitPort` だけが `transactionSync` で書く（書き込みをリポジトリポートから外す） | **棄却** | 本書第8.2.1節。同じ目的（transaction に Promise / 外部 I/O を持ち込ませない）は、UoW のコールバックを非 `async` 関数にするだけで達成できる。非 `async` 関数の中では `await` が**構文エラー**になるので、コマンド機構より強い保証がゼロコストで得られる。代わりにドメインのリポジトリポートを同期契約へ変える |
| 外部 I/O と retention だけを永続 job table に記録し、単一の DO Alarm で処理する（operation key / payload digest / attempt / `nextRunAt` / lease / owner token / provider 冪等キー / poison、25件・10秒の budget、最早時刻への再設定、現在時刻+1秒への clamp） | **部分採用** | 本書第7.4節。列と機構は採るが、bounded 処理の判定基準を2点変えた。**(1)** wall time ではなく CPU 予算に置き換え、チェックポイント単位で切る形にした（第2.1節の「リセット」意味論）。**(2) 「10秒」の側を捨てた** — Workers の `Date.now()` は最後の I/O の時刻を返しコード実行中は進まないので（第2.1節 F-32）、先行案の `while (processed < 25 && Date.now() - startedAt < 10_000)` は CPU バウンドなジョブ列で発火しない。代わりに「1ジョブあたりのチャンク反復回数」の上限を新設し、3階層すべてを件数で有界にした |
| Identity Directory を秘密鍵付き決定的キーで固定分割し、DO 間操作を再開可能 saga + 冪等補償にする | **採用** | 本書第6.2〜6.5節・第6.9節 |
| Account Home DO を identity saga と session のオンライン権威として独立させる（3クラス構成） | **棄却** | 本書第3.1節。権威を `userId` で引ける場所に置く必要があるが、それは User Data DO そのものである。独立させると protected request ごとに RPC が1本増える一方、User Data DO に置けばそのリクエストが元々叩く相手なので追加コストがゼロになる |
| 新規 DO namespace を宣言的 `exports` で管理する | **採用** | 本書第9.1節 |
| RPC は primitive DTO と `{ ok: true, value } \| { ok: false, error: SerializedError }` だけを返し、リポジトリ・クロージャ・transaction capability・カスタムエラー実体を境界外へ出さない | **採用** | 本書第8.3節 (d) |
| PITR は staging 手動 smoke で検証し、local は wrapper contract まで。Account Home は restore 対象外とする operator policy | **部分採用** | 検証境界は本書第10.1節・第11.3節で採る。「Account Home を restore 対象外にする」は Account Home ごと棄却したので消える。代わりに「Directory mapping が到達性のゲートであり、User Data DO の restore に追随しない」を第10.1節の結論にした |
| #19 のレビュー指摘 B-IDDS6-001「Directory の page 走査だけでは旧世代 locator の0件を証明できない」（Account Home の reverse locator が集計から漏れる / 同一ユーザーの複数 locator を重複加算する / checkpoint が加算更新で snapshot 置換になっていない） | **採用** | 本書第6.8節。3つの穴のうち1つ目は Account Home の廃止で構造的に消え、残り2つは「bucket ごとの snapshot 置換」で塞ぐ |
| #19 固有の検証手段（最小 DO command harness、#19 のスコープ限定） | **棄却** | #19 のクローズに伴い対象消滅。#37 は本番ユースケースを直接実装する |

**未コミットで作業ツリーに残っている `apps/web/wrangler.{request,state}.{staging,production}.toml` の4本は先行ブランチの残骸である。** 参照先の `apps/web/app/server.state.ts` が現ブランチに存在しないため、そのままでは動かない。本 Issue では commit も削除もしない。#37 は「既にあるから使える」と誤認せず、第3.2節の結論に従って `.tpl` レンダリング経路で作り直す（第11.2節）。

## 2. 前提と制約 ［派生］

### 2.1 Cloudflare SQLite-backed DO のプラットフォーム制約 ［派生］

**本節が設計の依拠する事実の正本である。** 各行に出典と裏付けの種別（**公式記載** / **実測** / **未確認**）を付けた。種別を取り違えると #35 / #37 が公式保証だと誤認するので、区別は落とさない。

**行の ID は `F-1`〜`F-32` である。`#1` のような番号は使わない。** 本書は GitHub Issue を `#12` / `#13` / `#35` などで参照しており、事実表の行を `#N` で書くと数値域が重なる範囲で衝突する（`#8` / `#10` / `#12` / `#13` はいずれも実在する Issue 番号でもある）。**本文からは `第2.1節 F-4` / `同 F-4b` の形で参照し、`#` 記法は Issue 番号だけに使う。**

| ID | 事実 | 種別 | 出典 | 効き先 |
|---|---|---|---|---|
| F-1 | ストレージは **1 DO あたり 10 GB（Workers Paid）/ 1 GB（Free）**。アカウント合計は Workers Paid 無制限 / Free 5 GB。上限到達時は書き込みが `SQLITE_FULL` で失敗し、`SELECT` などの読みと `DELETE` は成功し続ける | 公式記載 | `/durable-objects/platform/limits/` | 4.6 / 4.7 |
| F-2 | Alarm は1 DO につき同時1本。`setAlarm` は既存を上書きする。at-least-once で、`alarm()` が throw すると初回2秒からの指数バックオフで最大6回リトライされる | 公式記載 | `/durable-objects/api/alarms/` | 7.4 / 7.5 |
| F-3 | Alarm ハンドラの wall time は15分。**出典は alarms ページではなく limits ページの "Wall time limits by invocation type" 表**（alarms ページは duration / wall time を一切述べていない） | 公式記載 | `/durable-objects/platform/limits/` | 7.4 / 9.2 |
| F-4 | CPU はリクエストあたり既定30秒・設定で最大5分の active CPU（wall time とは別枠）。**着信 HTTP リクエスト / WebSocket メッセージごとに残り CPU 時間が30秒へリセットされる**。着信ネットワークリクエストの間に30秒を超える計算をすると、**その DO がエビクトされリセットされる可能性が高まる** | 公式記載 | `/durable-objects/platform/limits/` | 4.8 / 7.4 / 9.2 |
| F-4b | 同じ limits ページの FAQ は **Alarm を invocation の一種として名指しで列挙している** — 「By default, the maximum CPU time per Durable Objects invocation (**HTTP request, WebSocket message, or Alarm**) is set to 30 seconds」。一方で**リセットの契機**として footnote 4 が挙げるのは「incoming HTTP request」と「WebSocket message」の2つだけで、Alarm も Workers RPC も含まれていない。**「Alarm ごとに30秒が与えられる」のか「着信間で共有される枠を Alarm が消費するだけ」なのかは、この2文からは決まらない。** 本書は「Alarm 駆動にはリセットの契機が無い」と保守的に読む | **未確認: Alarm / RPC が CPU リセットの契機に当たるか — 公式内の2文が別々のことを述べており決着しない。#37 の着手時に spike で確定する** | `/durable-objects/platform/limits/` の FAQ「Can I increase Durable Objects' CPU limit?」の当該文と footnote 4 | 7.4 / 9.2（推論が外れても結論は安全側に倒れる） |
| F-5 | Worker から DO namespace の ID / 名前を列挙する API は存在しない。REST の List Objects が返すのは16進の object ID と `hasStoredData` だけである。**ただしこれを明示的に否定する公式の一文は無く、namespace binding の API 一覧（`idFromName` / `idFromString` / `newUniqueId` / `get`）に列挙手段が載っていないことによる**。`listDurableObjectIds()` は `@cloudflare/vitest-pool-workers` のテスト専用ユーティリティ | 公式記載（列挙 API の不在は記載の不在による） | `/api/resources/durable_objects/.../objects/methods/list/` | 6.2 / 6.8 |
| F-6 | DO の内側から `ctx.id.name` で自分の名前を読める。`idFromName()` / `getByName()` 経由でのみ定義され、`newUniqueId()` 由来・`idFromString()` 経由では `undefined`。1,024 バイトを超える名前は `ctx.id` に渡らない。2026-03-15 より前に作られた Alarm では `undefined` になる | 公式記載 | `/durable-objects/api/id/` | 5.2 / 6.3 / 7.4 |
| F-7 | `ctx.storage.transactionSync()` のコールバックは完全同期でなければならない（`async` 宣言も Promise 返却も不可） | 公式記載 | `/durable-objects/api/sql-storage/` | 8.2 |
| F-8 | `sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` といったトランザクション関連文を実行できない | 公式記載 | `/durable-objects/api/sql-storage/` | 8.2 / 9.3 |
| F-9 | SQL カーソルは `await` を跨いで保持できるが、その場合スナップショットの安定性は保証されない（カーソル作成後に挿入・更新・削除された行を観測しうる） | 公式記載 | `/durable-objects/api/sql-storage/` | 8.2 |
| F-10 | SQLite 拡張として公式に明記されているのは **FTS5 モジュール本体（`fts5vocab` を含む）**・JSON 拡張・数学関数の3つだけ。`bm25` / `snippet` / `highlight` / トークナイザ（trigram）は**同ページに一語も現れない**。「仮想テーブルは原則禁止だが FTS5 のみ例外」という記述も存在しない | 公式記載 | `/durable-objects/api/sqlite-storage-api/` | 7.1 / 7.2 |
| F-11 | trigram トークナイザ（`tokenize='trigram'`）は workerd 上で動作する | **実測** | `.thread/19/spike/fts5.integration.test.ts` ほか先行ブランチの統合テスト（要旨は第7.2節） | 7.2 |
| F-12 | `bm25()` は workerd 上で動作する | **実測** | 先行ブランチの検索アダプターが `bm25(search_fts, 3.0, 1.0)` を使い、workerd 統合テストが通っている | 7.2 |
| F-13 | SQL 関数の `snippet()` / `highlight()` が workerd で使えるか | **未確認: `snippet()` / `highlight()` の可用性 — #37 の着手時に spike で確定する。** 先行実装は SQL の `snippet()` を使わず TypeScript 側で原文からスニペットを組み立てているため、実測が存在しない | — | 7.2（設計はこれに依存しない） |
| F-14 | `transactionSync` のネスト可否 | **未確認: `transactionSync` のネスト可否 — #37 の着手時に spike で確定する。** 公式に記載が無い。ただし F-8 により `SAVEPOINT` による回避路は最初から無い | — | 8.2 |
| F-15 | 仮想テーブルへの書き込みも rows written に算入される | 公式記載 | `/durable-objects/api/sqlite-storage-api/` | 4.6 / 7.1 |
| F-16 | LIKE / GLOB パターンは 50 バイト上限 | 公式記載 | `/durable-objects/platform/limits/` | 7.2（短語フォールバックに LIKE / GLOB を**採らない**根拠） |
| F-17 | 1テーブル100列 / 行 2 MB / SQL 文 100 KB / bind パラメータ100 | 公式記載 | `/durable-objects/platform/limits/` | 4.4 |
| F-18 | DO は single-threaded なグローバル一意インスタンス。input gate は同期 JS 実行中の新規イベントを止め、output gate は保留中の書き込みが完了するまで送信を止める。`fetch()` などの非ストレージ I/O を `await` すると input gate が開き、他のリクエストが割り込む | 公式記載 | `/durable-objects/best-practices/rules-of-durable-objects/`、`/durable-objects/api/state/` | 8.2 / 8.4 |
| F-19 | 1オブジェクトの soft limit は 1,000 requests/second。超過すると `overloaded` になる。`.overloaded` が真のエラーは**リトライしてはならない**（リトライは過負荷を悪化させエラー率を上げる） | 公式記載 | `/durable-objects/platform/limits/`、`/durable-objects/best-practices/error-handling/` | 4.7 / 6.2 |
| F-20 | PITR は SQLite-backed DO 限定で過去30日。復旧単位は object 1個で、SQL データと KV `put()` データを含む DB 全体が対象。**ローカル開発では利用できない**（変更の durable log がローカルに保存されないため）。`ctx.abort()` も `wrangler dev` では利用できない | 公式記載 | `/durable-objects/api/sqlite-storage-api/`、`/durable-objects/api/state/` | 10.1 |
| F-21 | 宣言的 `exports`（2026-06-30 の changelog）は `[[migrations]]` 配列と排他で、両方を含む設定は検証で拒否される。`exports` で作る namespace は常に SQLite backend。ストレージ種別は namespace 生成後は不変。`exports` 経由で削除した namespace に Trash は無く、tombstone をデプロイする前にデータを退避する必要がある | 公式記載 | `/durable-objects/reference/durable-objects-migrations/` | 9.1 |
| F-22 | `waitUntil` は Durable Objects の中では効果がない（DO の寿命もリクエスト / RPC の完了時点も変えない） | 公式記載 | `/durable-objects/api/state/` | 7.3 / 7.4 |
| F-23 | `blockConcurrencyWhile()` はコールバックに30秒のタイムアウトがあり、超過すると DO がリセットされる。実行中は他のイベント配信をすべてブロックする | 公式記載 | `/durable-objects/api/state/` | 9.2 |
| F-24 | DO は Workers Free / Workers Paid の両方で使える（Free は SQLite backend のみ）。`setAlarm()` 1回は1行の書き込みとして課金される | 公式記載 | `/durable-objects/platform/pricing/` | 4.6 / 7.4 |
| F-25 | ダッシュボードの Metrics タブは「an individual Durable Object's ID or name」で絞り込める（2026-06-12 の changelog） | 公式記載 | `/changelog/post/2026-06-12-durable-objects-metrics-filter-by-id-name/` | 5.2 |
| F-26 | 1クエリの結果セット合計サイズ上限 | **未確認: 単一 SQL クエリの結果セット合計サイズ上限 — limits ページに該当項目が無い。#37 の着手時に spike で確定する** | — | 4.8（export の読み出し上限） |
| F-27 | `ctx.storage.transaction(closure)` は `Promise` を返す API として存在する。公式は SQLite-backed について「`txn` オブジェクトは obsolete で、`ctx.storage` に対する操作 — `ctx.storage.sql.exec()` を含む — がトランザクションの一部として扱われる」「**明示的なトランザクションはもはや必要ない。`await` を挟まない書き込み列は自動的に原子的に提出される**」と述べている。すなわち原子性の条件は「`await` を挟まないこと」の側にあり、`transaction()` はそれを緩めない | 公式記載 | `/durable-objects/api/storage-api/` | 8.2.1（代替案 (c) の棄却根拠） |
| F-27b | `transaction()` の**コールバックを `async` にできるか**。「コールバックは同期で完了しなければならず `async` 宣言も Promise 返却も不可」と明記されているのは `transactionSync()` の節だけで、`transaction()` の節には肯定も否定も無い | **未確認: `transaction()` のコールバックが `async` でよいか — 禁止規定の不在による推論。#37 の着手時に spike で確定する** | 記載の不在（`/durable-objects/api/storage-api/` の `transaction()` 節） | 8.2.1（**推論が外れても棄却は強くなるだけで、結論は動かない**） |
| F-28 | ストレージ書き込みは「**in-memory write buffer へ書き、ディスクへは非同期にフラッシュされる**」。マシン障害時は「**すべての書き込みが保存されているか、1つも保存されていないかのどちらか**」である | 公式記載 | `/durable-objects/api/storage-api/` | 7.4 / 9.4 |
| F-29 | **「Alarm は Storage API で変更され、alarm の操作は他のストレージ操作と同じ規則に従う」**（公式原文: "Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."）。したがって F-28 の write buffer が `setAlarm()` にも掛かる | 公式記載 | `/durable-objects/api/alarms/` | 7.4 / 9.4 |
| F-30 | **`setAlarm()` / `getAlarm()` / `deleteAlarm()` の戻り値は公式ドキュメント内で食い違う** — alarms ページは `setAlarm(scheduledTimeMs: number): void` / `getAlarm(): number \| null` / `deleteAlarm(): void`、storage API ページはいずれも `Promise` を返すと書いている。**したがって「`setAlarm` を `await` すれば永続化が確認できる」に依拠してはならない**し、`getAlarm()` の同期性にも依拠できない | 公式記載（公式内の不整合） | `/durable-objects/api/alarms/`、`/durable-objects/api/storage-api/` | 7.4 / 9.4 |
| F-31 | **`ctx.storage.sync(): Promise` が pending write のフラッシュ完了を待つ唯一の手段である。** 公式は「Synchronizes any pending writes to disk.」「write buffer に pending write があれば、返された promise はそれらの完了時に解決する。無ければ既に解決済みの promise を返す」と定義している | 公式記載 | `/durable-objects/api/storage-api/` | 7.4 / 9.4 |
| F-32 | **`Date.now()` は Spectre 緩和として意図的に凍結されている。** 公式原文は "The value returned by `Date.now()` is locked in place while code is executing. No other timers are provided."、"`Date.now()` returns the time of the last I/O. **It does not advance during code execution.**"、"The attacker cannot use `Date` to measure the execution time of their code"。Workers / Durable Objects はこの runtime の上で動く | 公式記載 | `/workers/reference/security-model/` | 7.4 / 9.2（**経過時間による打ち切りを採らない根拠**） |
| F-32b | `ctx.storage.sql.exec()` が F-32 の「I/O」に当たり `Date.now()` を進めるか | **未確認: ローカル SQLite 操作が clock を進める I/O に当たるか — 公式に記載が無い。#37 の着手時に spike で確定する** | — | 7.4（**設計はこれに依存しない** — 経過時間を打ち切り条件から外したため） |

**Free プランの per-object 上限は 1 GB であり、公式に明示されている。** limits ページの表は 10 GB を "Storage per Durable Object" として Workers Paid 列に置く一方、同じページの storage-full の説明が「When a SQLite-backed Durable Object reaches its maximum storage limit (**10 GB on Workers Paid, or 1 GB on the Free plan**)」と Free 側の値を明記している。つまり**表と本文のあいだに公式内の不整合がある**（表だけを読むと Free の per-object 値が無いように見える）。**Free では per-object 1 GB と account 5 GB の両方が効く。** 本設計は Workers Paid 前提なので 10 GB で見るが、**ローカル / Free での検証時は 1 GB が先に当たる**ので #37 / #38 はこの値で見る。

#### 2.1.1 実測2件（F-11 / F-12）の再現手順 ［派生］

F-11 / F-12 の出典は先行ブランチ `origin/issue/19/cloudflare-do-fts` 上の統合テスト（`.thread/19/spike/fts5.integration.test.ts` ほか）であり、**現ブランチには存在しない**。trigram / `bm25` は公式ドキュメントに一語も無い（F-10）ため、この実測が `.adr/003-sqlite-fts5-only-search.md` の唯一の根拠である。要旨は第7.2節に取り込んであるので本書だけで読めるが、**#37 は着手時に次の最小 spike で再確認する**（第11.2節の新設対象・第11.4節）。

1. `@cloudflare/vitest-pool-workers` の DO 環境で `CREATE VIRTUAL TABLE search_fts USING fts5(title, body, content='search_entries', content_rowid='rowid', tokenize='trigram')` を作る。
2. 「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件を `search_entries` へ投入し、projection で `search_fts` を更新する。
3. 次の4点を確認する。`search_fts MATCH '東京駅'` が2件を返す（trigram = F-11）。`ORDER BY bm25(search_fts, 3.0, 1.0)` が例外を上げずに順位を返す（F-12）。`instr(title, ?) > 0 OR instr(body, ?) > 0` に2文字の `東京` を渡して2件が返る（第7.2節の短語フォールバック）。`周辺` を `limit 1` で2ページに割ると1ページ目と2ページ目で別の項目が返る（ページング）。

この spike は #37 の Issue が要求する「日本語検索に使う FTS5 tokenizer を実環境（workerd / SQLite-backed DO）で検証する」とまったく同じ作業なので、独立した工数を足さない。

### 2.2 fog のデータ特性 ［派生］

**共有・共同編集・テナント横断検索・管理者機能は無い、を設計前提として固定する。** 根拠はページ定義が P-01〜P-14 の利用者向けだけで、管理者向け画面・統計の定義が `spec/pages/index.md` に存在しないこと。「集計」「全ユーザー」という語は `spec/domains/trash.md` / `spec/database/index.md` / `spec/domains/identity.md` にヒットするが、いずれも管理者機能ではなく retention の横断ジョブ由来である（第4.3節のカテゴリ D）。

したがって「1ユーザー = 1 DO」と矛盾する機能要件は存在しない。export の読み出しも `ExportSourceReader.readAll(userId)` 1本でユーザー内に閉じ、`spec/domains/export.md` が要求する「単一トランザクション（またはスナップショット読み）」は DO ではむしろ自然に満たせる。

### 2.3 現行実装の到達点 ［派生］

実装済みのドメインは `packages/core/src/domain/identity/` だけで、エンティティは `User` 1つである。memo / knowledge / search / trash / export はディレクトリごと存在しない。したがって #37 が書き換える既存コードの量は小さい。

**ただしゼロではない。** 次は実装済みで、DO 境界の再設計で書き換わる。

- **SSO** — 値オブジェクト（`packages/core/src/domain/identity/valueObject.ts` の `SsoProvider`）、エンティティ（同 `entity.ts` の `SsoUser`）、スキーマ（`packages/core/src/adapters/d1/migrations/0000_initial.sql` の `sso_provider` / `sso_provider_subject` 列と `users_sso_identity_uq` 部分ユニーク）、`packages/core/src/application/identity/`、`apps/web/app/components/settings/` まで実装済み。**ただし読み解決は未実装である** — `packages/core/src/domain/identity/ports/userRepository.ts` が持つのは `insert` / `save` / `findById` / `findByEmail` の4本だけで、`findBySsoIdentity` は `packages/core/` にも `apps/web/` にも1件も存在しない（`spec/domains/identity.md` の定義だけがある）。したがって第6.1節 (b) は「`users_sso_identity_uq` の一意制約を Directory へ**移す**」と「`findBySsoIdentity` を Directory 側で**新規に書く**」の2つに分かれる。第6.6節（link / unlink）は既存のエンティティ形状の読み替えが中心である。
- **`Actor` 判別共用体** — `packages/core/src/domain/identity/valueObject.ts` の `Actor = UserActor | AiClientActor`。memo / knowledge のリビジョンが全部これを持つ。
- **AI クライアント接続** — 実装済みなのは値オブジェクト `AiClientConnectionId`（`valueObject.ts:125`）と `ClientName`（同 `:142`）の2つだけである。**`AiClientConnection` という名前の型は存在しない。** エンティティ・リポジトリ・テーブルも無い。
- **パスワードリセット / MCP・REST OAuth / `TokenScope`** — 実装が1行も無い。`apps/web/app/routes/password-reset.tsx` はプレースホルダー画面。

## 3. DO トポロジー ［Issue 要求］

### 3.1 クラス構成と責務分界 ［Issue 要求］

2クラス構成を採る。**Account Home DO は採用しない。**

| クラス | locator | 責務 |
|---|---|---|
| **User Data DO** | `userId` 由来（鍵に依存しない） | 利用者のドメインデータ全部（第4.1節）、ユーザー単位設定、認証権威（アカウント状態 / `sessionEpoch`）、signup saga のコーディネーター状態、retention の Alarm |
| **Identity Directory DO**（bucket 単位） | canonical credential の HMAC 由来（世代付き） | 正規化メール / SSO 主体 → `userId` の写像とその一意性、パスワード検証材料の保持、パスワードリセットトークン、メール送信ジョブ |

**Account Home を採らない理由。** 先行案が Account Home を独立させた動機は「Directory mapping だけでは signup の部分失敗・退会処理中・PITR で戻った古い mapping・credential 変更後の古いセッションを区別できない」であり、これは正しい。しかしその区別に必要な権威（アカウント状態・単調増加 epoch・saga の phase）は**すべて `userId` で引ける**。`userId` で引ける DO は既に User Data DO として存在する。独立クラスにすると次の対価を払う。

1. **protected request ごとに RPC が1本増える。** epoch 照合のためだけに Account Home を叩くことになる。権威を User Data DO に置けば、そのリクエストが元々データ取得で叩く相手なので照合コストは実質ゼロになる。
2. **DO クラスが1つ増え、saga が跨ぐ DO も1つ増える。** signup は「Directory 予約 → User Data 初期化 → mapping 有効化 → Account Home 有効化」になるが、2クラス構成なら「Directory 予約 → User Data 初期化・active 化 → mapping 有効化 → reverse locator 記録」（第6.3節）で済み、**補償の相手が1つ減る**。跨ぐ DO の実数は credential の数で決まるので2つとは限らないが（第6.3節）、Account Home を足すとそこへ常に1つ上乗せされる。
3. **鍵ローテーションの retirement 証明が難しくなる。** Account Home 側の reverse locator は Directory に active row を持たない場合があり、Directory 走査だけでは旧世代0件を証明できない（#19 のレビュー指摘 B-IDDS6-001）。2クラスなら reverse locator は User Data DO の側に1系統だけ存在し、Directory 側の bucket 走査が権威になる（第6.8節）。

**Account Home を採らないことで失うもの**は「Directory と User Data の両方が壊れたときに参照できる第3の非 PII 記録」だけである。退会 tombstone は User Data DO 側に非 PII のまま残す（第6.7節）ので、その役割は User Data DO が引き受ける。

**セッション方式の扱い（`.thread/1/adr.md` ADR-002 の去就）。** `sessionEpoch` の照合を導入するので「サーバー側失効の手段が無い」というトレードオフは解消する。しかしセッション方式そのもの（`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` のステートレス HMAC + TTL 7日）は**変えない**。トークンの真正性検証は従来どおり DB を触らずに完結し、epoch 照合は「データを取りに行く先で追加のガードを1つ通す」形の**認可**であって、トークン検証の方式変更ではない。したがって **`.thread/1/adr.md` ADR-002 を supersede する別 ADR は起こさない。** この判断は本 Issue で下し、結果を第5.1節に書いた。

### 3.2 Worker 分割（request Worker / state Worker） ［派生］

**分ける。** request Worker（`fetch` ハンドラ・TanStack Start のサーバー実行）と state Worker（DO class を export する script）を別 script にする。

理由は**秘密の配布境界を非重複にできる**ことに尽きる。

| Worker | 持つ秘密 | 形 | 理由 |
|---|---|---|---|
| request Worker | `SESSION_SECRET` | **単一鍵** | セッショントークンの署名・検証。多世代照合を持たないので、鍵を差し替えると全セッションが無効になる。代償は**全ユーザーの再ログイン1回**で、第5.1節が `ep` 欠落トークンについて同じ代償を既に受容している |
| request Worker | `AI_CLIENT_TOKEN_SECRET` | **単一鍵** | AI クライアントトークンと OAuth 2.1 認可コードの署名・検証（第5.4節・第5.4.1節）。両者は `typ` audience タグで分離する。差し替えの代償は「AI クライアントの再接続と、進行中の認可フローのやり直し」に留まる |
| request Worker | `DIRECTORY_ROUTING_SECRET` | **世代付き keyring** | canonical credential から Directory locator を導出する HMAC。locator は DO の同一性そのものなので、差し替えには再写像（第6.8節）が要り、多世代の並存が不可避である |
| state Worker | `IDENTITY_MAIL_ENCRYPTION_KEY` | **世代付き keyring** | canonical credential の暗号化保持（第6.2.1節 (b)）。再暗号化ジョブが走る間は新旧2世代が並存する |
| state Worker | `IDENTITY_RESET_TOKEN_KEY` | **世代付き keyring** | 生のパスワードリセットトークンを `tokenId` から決定的に導出する（第6.1節 (d)）。**DB には一切載らない**ので DB 漏えい単独ではトークンを再現できず、逆に**`tokenId` が128ビット以上の暗号論的乱数である**ことにより本鍵の漏えい単独でも再現できない（第6.1節 (d)。2方向とも閉じている） |
| state Worker | メール送信プロバイダのバインディング | — | Directory bucket の Alarm が回すメール送信ジョブ（第7.6節） |

**配布は非重複である。** request Worker 側の3つを state Worker に置かず、state Worker 側の3つを request Worker に置かない。唯一の例外は鍵ローテーションの maintenance 経路が routing key を bucket へ**一時注入**する経路で、理由と限定条件は第5.2.3節にある。

**新設する5つの秘密は、既存の `SESSION_SECRET` が持つ構築境界の保証をすべて引き継ぐ。** 現行の `packages/core/src/application/di/secrets.ts` は3点を保証している — (1) `MIN_SESSION_SECRET_LENGTH = 32` の下限チェック、(2) ブランド型 `SessionSecret` + `requireSessionSecret` により「チェックを通した値しか型を得られない」構築境界、(3) `RequestSecrets` を**入れ子**に置くことで `createRequestContainer` の rest-spread（`const { …, secrets, ...appConfig } = config`）が秘密を `container.config` へ運ばず `loadAppContext` 経由でクライアントへ出ないようにする不変条件。同ファイルの JSDoc は (3) について「フラットに置くと型エラーが1つも出ないままブラウザへ配られる」と明言している。**したがって次を制約として固定する。**

- **request 側の新設2秘密は `RequestSecrets` の中に、state 側の新設3秘密は新設する `StateSecrets` の中に置く。** どちらも入れ子であることが (3) の保証の実体である。**keyring を `RequestServerConfig` / `StateServerConfig` にフラットに置く実装は、型エラーを出さずに routing keyring をブラウザへ配る。**
- **それぞれにブランド型と構築時チェックを与える。** 単一鍵は最小長 32。keyring は加えて **(i) `generation` が一意であること、(ii) `active` がちょうど1件であること、(iii) `previous` が0〜1件であること、(iv) `DIRECTORY_ROUTING_SECRET` は各エントリの `bucketCount` が1以上であること**を構築時に検査する。**検査を通した値しか型を得られない**形にし、検査を分散させない。
- **`packages/core/src/application/di/secrets.ts` は #37 の改修対象である。** 第11.2節の変更対象一覧に行を足してある。

**`SESSION_SECRET` と `AI_CLIENT_TOKEN_SECRET` は別鍵にする。** セッションと AI クライアントトークンは TTL も失効機構も発行契機も違うので、片方の鍵を捨てただけでもう片方が巻き添えになる構成を避ける。鍵を分けたうえで、さらに両方のペイロードに audience タグ `typ` を必須で入れる（第5.4節）。

**state Worker の binding と到達性。** state Worker は DO クラスを export するだけの script で、**公開ルート（`routes` / `workers.dev`）を持たない。** 到達手段は binding 経由の RPC だけである。そのうえで **state Worker には `USER_DATA` と `IDENTITY_DIRECTORY` の両方の binding を置く** — 第6章の saga（signup の前進、SSO unlink 後の孤児 mapping 削除、退会の mapping 削除、credential 変更の前進）が DO 間の相互呼び出しを要求するためである。何を locator に使ってよいかの制約は第5.5節 (1) に、input gate の再入については第6.9節に書いた。

デプロイ順序は **state を先、request を後**。DO class の追加・変更が先に反映されていないと request 側の binding が解決できないため。片側デプロイ・ロールバックの互換ウィンドウは最低1リリース分を確保する（RPC の値エンベロープに version を持たせる。第8.3節 (d)）。

**DO 設定は `apps/web/scripts/render-wrangler.ts` の `.tpl` レンダリング経路に乗せる。** `.gitignore` が `wrangler.staging.toml` / `wrangler.production.toml` を「`.tpl` からレンダーされる生成物」として ignore しているので、先行ブランチの手書き4本（`apps/web/wrangler.{request,state}.{staging,production}.toml`）をそのまま持ち込むと ignore 対象でないファイルが commit され二重管理になる。Worker が2本になるのに合わせて `.tpl` を2系統にし、`render-wrangler.ts` を2出力へ拡張する（実作業は #37）。ローカル開発用の `apps/web/wrangler.toml`（162行。DO バインディングが1つも無い）にも同じ2構成を反映する。

### 3.3 binding 構成の概念図 ［参考］

```text
                 ┌──────────────────────────────┐
  ブラウザ ─────▶│ request Worker               │
  MCP / REST     │  - TanStack Start fetch      │
                 │  - sessionCodec (SESSION_SECRET)
                 │  - passwordHasher (CPU)      │
                 │  - directoryLocator          │
                 │    (DIRECTORY_ROUTING_SECRET)│
                 └───┬───────────────────┬──────┘
                     │ USER_DATA         │ IDENTITY_DIRECTORY
                     │ (script_name =    │ (script_name = state Worker)
                     ▼  state Worker)    ▼
        ┌────────────────────┐   ┌──────────────────────────┐
        │ User Data DO       │   │ Identity Directory DO     │
        │ name: userId       │   │ name: dir:g{gen}:b{index}│
        │ - 全ドメインデータ   │   │ - credential → userId     │
        │ - FTS5             │   │ - password 検証材料        │
        │ - job / Alarm      │◀─▶│ - reset token             │
        │ - account status   │   │ - job / Alarm             │
        └────────────────────┘   └──────────┬───────────────┘
              ▲          saga の前進（第6章）  │ MAIL_PROVIDER
              └── state Worker 内の            ▼  (IDENTITY_MAIL_ENCRYPTION_KEY)
                  USER_DATA / IDENTITY_DIRECTORY binding
                                     外部メール送信
```

**DO 間の双方向矢印は state Worker が持つ2本の binding である。** request Worker からの2本と同じ binding 名を state Worker にも配線する（第3.2節）。どちらの向きでも、呼び出し側が使ってよい locator は「自分の SQLite に永続化済みの locator」だけである（第5.5節 (1)）。

実際の toml は #37 が書く。

## 4. User Data DO ［Issue 要求］

### 4.1 保持データ範囲 — Issue 列挙7項目の対応表 ［Issue 要求］

Issue が列挙した7項目はすべて同一 SQLite（1つの User Data DO）に載る。既存ドメイン集約との対応は次のとおり。

| # | Issue の項目 | 対応する既存ドメイン集約 | DO 内のテーブル群 |
|---|---|---|---|
| 1 | User のユーザー単位設定 | `packages/core/src/domain/identity/` の `User`（`trashRetentionDays` などの設定側） | `user_settings`（単一行）、`account`（状態 / `sessionEpoch` / 非 PII tombstone） |
| 2 | AI client connections | identity の AI クライアント接続（値オブジェクト `AiClientConnectionId` / `ClientName` だけが実装済み） | `ai_client_connections` |
| 3 | memos / memo revisions | memo ドメインの `Memo` / `MemoRevision`（未実装） | `memos` / `memo_revisions` |
| 4 | topics / documents / document revisions / source links | knowledge ドメインの `Topic` / `Document` / `DocumentRevision` / `SourceLink`（未実装） | `topics` / `documents` / `document_revisions` / `source_links` |
| 5 | trash・retention に必要な状態 | trash ドメイン（エンティティを持たず、memo / knowledge の状態と `RetentionPolicy` で表現。未実装） | `memos` / `topics` / `documents` の trashed 列と `purge_after` 列（第7.5節）。**次の期限を持つ専用テーブルは置かない** — Alarm は `jobs` の `nextRunAt` で駆動し、`purge-trash` ジョブ行の `nextRunAt` に `WHERE trashed = 1` の `min(purge_after)` を写す。**写す規則の正本は第7.4節の「周期・反復ジョブの再武装規則」である**（駆動源クエリの定義と、`nextRunAt` を遅らせる向きの更新がジョブ自身の再スケジュールに限って許されること）。**復元時に `purge_after` を `NULL` へ戻す**のも同節の要求である（第7.5節） |
| 6 | FTS5 検索インデックス | search ドメイン（`SearchIndexPort` の派生データ。集約ではない） | `search_entries` + `search_fts`（external-content FTS5。第7.1節） |
| 7 | 必要な冪等化・非同期処理状態 | application 層（現行の `processed_events` / `outbox` に相当。DO では job table へ集約） | `jobs`（第7.4節）、`operations`（saga / RPC 冪等キー。第6.5節）、`_meta`（`schema_version` と自 locator。第6.3節・第9.2節）、`migration_progress`（部分適用のカーソル。第9.3節） |

export ドメインはテーブルを持たない（`ExportSourceReader.readAll` が上記から読むだけ）。

#### 4.1.1 テーブルの全数（第6〜9章の正本） ［派生］

上の表は Issue の7項目への対応を示すもので、**認証まわりのテーブルは7項目に現れないため落ちている**。第6〜9章が使うテーブルを漏れなく並べ直す。

**本表はテーブルの全数と、認証・saga・ジョブ系テーブルの列の全数の両方の正本である。#37 が実テーブルと実列を判断する根拠はこの表である。** 第6〜9章で新しいテーブルや列を足したら、ここも同時に更新する。**本表と第6〜9章の本文が食い違ったら本表を直す**（本文が列を導入した理由を持つので、本文の側が正しい）。集約テーブル（`memos` / `topics` / `documents` とその子）の列は `spec/database/index.md` が正本であり、本表は所在だけを示す。

| DO クラス | テーブル | 列（認証・saga・ジョブ系は全数） | 定義箇所 |
|---|---|---|---|
| User Data DO | `account` | `status`（`active` / `deleting` / `deleted`）/ `sessionEpoch` / `deletedAt` / **`callerToken`**（DO 間 RPC の呼び出し元束縛。第5.1節）/ **`version`**（OCC。第8.4節）。非 PII tombstone は退会後もこの行として残る（`callerToken` は退会完了時に消す） | 第3.1節・第5.1節・第6.7節 |
| User Data DO | `user_settings` | `trashRetentionDays` ほかユーザー単位設定（単一行）/ **`version`**（OCC。第8.4節） | 第4.1節・第8.4節 |
| User Data DO | `credential_locators` | **`credentialId`**（世代非依存の credential 同一性。第6.1.2節）/ `kind`（`email` / `sso`）/ `hmac`（全長64 hex）/ `generation` / `bucketIndex` / `credentialVersion` / `status`（**値域は `active` の1値だけである。** 除去は物理削除で行うので他の値を取らない — `record-credential-locator` は挿入時に `active` を書き、unlink 手順2 / 退会 手順4 は行ごと消す。**`revoked` のような論理削除状態は置かない**、を断定する。置くと「active な行」を数える述語が2系統になり、第6.1.1節 (R4) の数え方と第5.3節 step 5 (ii) の到達性検査が同じ列を別々に解釈しうる）/ **`usableForLogin`**（その credential が単独でログイン手段として成立するか。`kind = 'sso'` は常に真、`kind = 'email'` は Directory 側の mapping 行が `passwordVerifier` を持つときだけ真。SSO signup がメール一意性のためだけに置く行は偽。値は Directory 側が判定して `record-credential-locator` / `advance-credential-change` の引数で運ぶ）/ **`label`**（設定画面に出す非 PII の表示名。`kind = 'sso'` なら provider 名（`google` / `apple`）、`kind = 'email'` なら空文字。**SSO subject もメールアドレスも入れない**。値は `usableForLogin` と同じく Directory 側が判定して運ぶ）。**一意性は `(credentialId, generation)` で取る。`(kind, hmac, generation)` にも UNIQUE を張る**（同じ canonical が2つの `credentialId` を持たないことを保証するため）。**login の到達性検査の権威**（照合は `credentialId` だけを見て `generation` を含めない）であり、退会・unlink 時の mapping 削除の唯一の逆引き情報。**鍵ローテーション中は同じ credential について新旧2世代の行が並存しうる**（第6.1.1節）。**したがって「ログイン手段の数」は行数ではなく `usableForLogin = true` かつ active な行の distinct な `credentialId` の個数である** | 第5.3節 step 5・第6.1.1節・第6.1.2節・第6.3節 phase 4・第6.6節・第6.7節・第6.8節 |
| User Data DO | `ai_client_connections` | `id` / `clientName` / `scope` / `status` / `connectedAt` / `lastUsedAt` / `revokedAt` / **`createdAtCredentialVersion`**（作成時点のパスワード credential の `credentialVersion`。リセット完了時の自動失効に使う）/ **`version`**（OCC。第8.4節。**設定画面からの二重解除操作の競合を検出する対象そのものである**）。ただし `recordUsage` による `lastUsedAt` の単独更新は `version` を進めない後勝ち更新にする（`spec/database/index.md` の現行規約を維持する） | 第5.4節・第6.5.1節 phase 2・第8.4節 |
| User Data DO | `memos` / `memo_revisions` | memo 集約（`purge_after` 列を足す。第7.5節） | 第4.1節・第7.5節 |
| User Data DO | `topics` / `documents` / `document_revisions` / `source_links` | knowledge 集約（`topics` / `documents` に `purge_after` 列を足す）。`source_links` は複合 PK のまま | 第4.1節・第4.2節・第7.5節 |
| User Data DO | `search_entries` / `search_fts` | FTS5 projection（external-content）。`search_entries` の PK は `rowid INTEGER PRIMARY KEY`、`id TEXT` は UNIQUE 制約付きの別列 | 第7.1節 |
| User Data DO | `jobs` | 第7.4節の11列（`operationKey` / `kind` / `payload` / `payloadDigest` / `attempt` / `nextRunAt` / `status` / `leaseUntil` / `ownerToken` / `providerIdempotencyKey` / `terminalReason`）。`kind` は `purge-trash` / `reindex` / `migrate-bulk` / `finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link` | 第7.4節 |
| User Data DO | `operations` | `operationId` / `kind` / `payloadDigest` / `phase` / `createdAt` / `terminalReason` / **`targetLocators`**（link では対象 locator を、unlink では削除対象の locator を退避する。要素は **`credentialId`** + `kind` + 全長 HMAC + 世代 + bucket index。**単一値ではなく配列である** — ローテーション中は同じ credential が2世代の bucket に行を持つので、削除対象も2件になりうる。第6.1.1節 (R3)） | 第6.5節・第6.6節 |
| User Data DO | `migration_progress` | `targetVersion` / `step` / `cursor` / `updatedAt` | 第9.3節 |
| User Data DO | `_meta` | `schema_version` / 自 locator（`userId`。`ctx.id.name` のフォールバック） | 第6.3節・第9.2節 |
| Identity Directory DO | `credential_mappings` | **識別**: **`credentialId`**（世代非依存の credential 同一性。第6.1.2節）/ `kind`（`email` / `sso`）/ `hmac`（全長64 hex）/ `generation`。一意性は `(kind, hmac)` で取る（第6.1節 (b)）。**`credentialId` にも bucket 内 UNIQUE を張る。** 根拠は Directory DO の命名規則である — DO 名は `dir:g{generation}:b{index}` で**世代を含む**ので（第6.1節 (d)・第6.2節）、世代が違えば bucket index が一致しても別の DO インスタンスであり、**1つの Directory DO の `credential_mappings` に載る行は常に同一世代である**。したがって bucket 内では `(credentialId, generation)` UNIQUE と `credentialId` UNIQUE が等価になる。`(credentialId, generation)` の UNIQUE も残してよいが、`generation` 列は DO 名と冗長なので実効は変わらない。**初版は「新旧2世代の locator が同じ bucket index に落ちると同じ bucket に2行並ぶ」を根拠に非一意と書いていた。これは DO 名が世代を含むという自分の決定と矛盾しており、事実として誤りである** — 2世代が同居するのは `credential_locators`（User Data DO 側。1 DO に両世代が載る）であって `credential_mappings` ではない。`consume-reset-token` / `delete-mapping` / トークン一括削除はこの UNIQUE 索引から引く。**写像**: `userId` / `status`（`reserved` / `active`）。**認証材料**: `passwordVerifier` / `pendingVerifier` / `changeState`（`null` / `pending`）/ `credentialVersion`。**PII**: `encryptedCanonical` / `encryptionGeneration` / **`encryptionNonce`**（AES-256-GCM の96ビット nonce。**独立列に持ち、暗号文に連結しない** — AAD が `(kind, credentialId, encryptionGeneration)` を束縛するので、nonce の切り出し規則を暗号文の形式に埋め込むと再暗号化ジョブが世代ごとに別の切り出しを持つことになる。行ごと・書き込みごとに再生成し、使い回さない。第6.2.1節 (b-2)）。**濫用抑止**: `failedAttempts` / `nextAttemptAllowedAt` / `lastResetRequestedAt`。**saga コーディネーター状態**: `operationId` / `candidateUserId` / **`reservedUntil`**（予約 TTL の絶対時刻）/ `sagaCommitted` / `locators[]`（コーディネーター行が持つ全 credential の locator 一覧。要素は `credentialId` + `kind` + 全長 HMAC + 世代 + bucket index）/ `coordinatorLocator`（非コーディネーター行が持つ）。**呼び出し元束縛**: **`callerToken`**（この mapping の所有アカウントが提示すべき不透明値。User Data DO 側の `account.callerToken` と同じ値。第5.1節） | 第6.1節・第6.1.2節・第6.2.1節・第6.2.2節・第6.3節・第6.4節・第6.5.1節 |
| Identity Directory DO | `password_reset_tokens` | `tokenId`（**暗号論的乱数由来の128ビット以上の不透明値**。bucket 内で採番する。**連番・rowid・時刻由来の値を使わない** — 理由は第6.1節 (d)）/ `tokenHash` / `expiresAt` / `usedAt` / **対象 credential のキー `credentialId`**（第6.1.2節）/ **`consumedByOperationId`**（`consume-reset-token` が消費時に記録する。`begin-credential-change` の起点 B 側の束縛に使う。第5.1節）/ **`tokenKeyGeneration`**（`IDENTITY_RESET_TOKEN_KEY` の世代。**routing 世代とは別の番号体系である**。第6.1節 (d)）。credential キー `credentialId` に索引を張り、credential 変更 / unlink / 退会が未使用トークンを一括削除できるようにする。**キーを `(kind, hmac)` にしない理由は第6.1.2節にある** — `hmac` は世代依存なので、ローテーション中に発行されたトークンが世代の違う削除要求から漏れる。**生トークンは保存しない**（`tokenId` から導出する） | 第6.1節 (d)・第6.1.2節 |
| Identity Directory DO | `jobs` | User Data DO 側と同じ11列。`kind` は `send-mail` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption`。**`rotate-remap` は Alarm ジョブではない** — routing key を保持できないため maintenance 経路が1チャンクずつ駆動する同期 RPC である（第6.8節 手順2） | 第7.4節 |
| Identity Directory DO | `rotation_checkpoints` | `bucketIndex` / `generation` / `previousCount` / `scannedAt`（**置換**で記録する） | 第6.8節 |
| Identity Directory DO | `_meta` | `schema_version` / 自 locator（`dir:g{gen}:b{index}`） | 第6.3節・第9.2節 |

**OCC の `version` 列を持つテーブルを本表で確定する。持たない側も明示する。** 第8.4節は「OCC は残す」と断定し、第8.2.1節は `Versioned<T>` / `ExpectedVersion<T>` を「そのまま残す」と決めているので、**列の全数を名乗る本表に `version` が1つも無いと第8.4節が実装不能になる**。`spec/database/index.md` の現行規約（「集約ルートに `version INTEGER NOT NULL`（生成時 0）。リビジョン・出典リンクは不変の子行のため `version` を持たない」）を DO 側へそのまま引き継ぐ。

- **持つのは集約ルートの3つだけである** — `account` / `user_settings` / `ai_client_connections`。`User` 集約が第4.3節の行11 / 行7c で「認証情報は Directory、設定は User Data DO」に分裂した結果、設定側の OCC は `user_settings` と `account` が引き受ける。集約テーブル（`memos` / `topics` / `documents`）の `version` は `spec/database/index.md` が正本であり、本表は所在だけを示す（`memo_revisions` / `document_revisions` / `source_links` は不変の子行なので持たない）。
- **`credential_mappings` は OCC の `version` を持たない、と断定する。** Directory 側の書き込みはすべて `operationId` / `changeState` / `status` / `sagaCommitted` を条件に含む CAS で直列化されており（第6.3節・第6.5.1節・第6.8節 手順2）、**同じ行に対する「読んで判断して書く」がリクエストを跨がない**。分裂した認証情報側に汎用の OCC を重ねると、CAS 条件と `version` のどちらが権威かが二重になる。**したがって `UserRepository` を割った2つのポートのうち、Directory 側だけは `ExpectedVersion` を取らない。**
- **`credential_locators` / `password_reset_tokens` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` / `_meta` も持たない。** いずれも集約ではなくアダプター内部のストアであり、更新は専用の CAS（`ownerToken` / `operationId` / `previousCount` の置換）で守られる。`spec/database/index.md` が `password_reset_tokens` について既に「OCC の `version` は持たない（集約ではなくアダプター内部のストア）」と書いているのと同じ扱いである。

**予約 TTL の列名を `reservedUntil` に確定する。** 第6.3節 phase 1a が「TTL 付き」、第6.4節の sweep が「TTL 超過」と書いているだけで列名も型も決まっていなかった。**型は絶対時刻**（epoch ミリ秒）にする — 相対値にすると sweep の述語が行の作成時刻を別に読む必要が生じるためである。これで `sweep-reservations` の述語が `WHERE status = 'reserved' AND reservedUntil < ? AND sagaCommitted IS NULL` として組める（第6.4節）。

**OAuth 2.1 の認可コード**（第5.4.1節）は署名済みの自己完結値なので永続化しない。User Data DO に置くのは**交換済みコードの `jti` を短期間だけ記録する一回性テーブル**だけである（PKCE の `code_challenge` はコード本体に署名済みで載る）。**テーブル定義は #13「AIクライアント接続（OAuth認可・一覧・失効）」の範囲であり、本書では名前を確定させない。** OCC の `version` は持たない（一回性の記録なので集約ではない）。

- **引き取り先は #12 ではない。** #12 は「SSO・パスワードリセット」で、その実装チェックリスト54行に OAuth 2.1・認可コード・PKCE・AI クライアント認可は1行も無い。OAuth 2.1 の認可画面（P-14）と `approveAiClientAuthorization` / `denyAiClientAuthorization` を持つのは **#13** である（`gh issue view 12` / `gh issue view 13` で確認済み）。**本表は「テーブルの全数の正本」なので、唯一「定義を他 Issue へ預けたテーブル」の預け先が実在しないと #37 がそこで手を止める。**

`credential_locators` は User Data DO 側にしか無い（Directory 側の逆は `credential_mappings` の `userId` 列が担う）。

### 4.2 ドメイン集約との対応表 ［Issue 要求］

| 集約 / 概念 | 帰属 | 備考 |
|---|---|---|
| `Memo` / `MemoRevision` | User Data DO | 書き込みは同一 `transactionSync` で FTS5 も更新する |
| `Topic` / `Document` / `DocumentRevision` / `SourceLink` | User Data DO | 同上。`source_links` は複合 PK のまま |
| AI クライアント接続（`AiClientConnectionId` / `ClientName`） | User Data DO | 失効の権威。トークンは `userId` を自己完結で持つ（第5.4節） |
| ユーザー単位設定（`TrashRetentionDays` ほか） | User Data DO | retention の入力がすべて同じ DO 内にある |
| アカウント状態 / `sessionEpoch` / 退会 tombstone | User Data DO | 第3.1節で Account Home を畳んだ結果 |
| 認証クレデンシャル（メール / SSO 主体 / パスワード検証材料 / リセットトークン） | Identity Directory DO | `userId` 未確定の経路から引かれるため User Data DO に置けない |
| 検索インデックス | User Data DO | 集約ではなく派生データ。常に本体から再構築可能 |
| ジョブ / 冪等化状態 | 両方 | User Data DO は retention、Directory bucket は予約掃除・補償再開・再写像・メール送信 |
| `User` 集約 | **分裂する** | 「認証情報の所有者」は Directory、「ユーザー単位設定の所有者」は User Data DO。第4.5節と第6.1節 (d) |

`spec/adr/004-domain-boundaries.md` が定めたドメイン境界（identity / memo / knowledge / search / trash / export）は**変更しない**。変わるのは「その集約がどの物理境界に置かれるか」だけである。

### 4.3 ユーザー境界に閉じないものの帰属（全数） ［Issue 要求］

**述語の定義（表より先に置く）。** 何をもって「ユーザー境界に閉じない」とするかを先に固定する。

- **(a) `userId` を第一引数に取らないポート。** 引数オブジェクトの中に `userId` があるものも該当する — `spec/domains/index.md` のテナント分離規約が求めているのは「第一引数の `userId` による構造的保証」であり、オブジェクトの中に埋まっていると型レベルで境界が保証されないため。ID も永続状態も受け取らない純粋計算のポート（`PasswordHasher` など）も、**利用者の秘密を扱い実行位置の判断が要る**ため対象に含める。
- **(b) `user_id` 列を持たない、または当該の引き方の経路に `user_id` が入っていないテーブル。** 「`user_id` を PK に含まない」では判定にならない — 設計上すべてのテーブルが単一列 TEXT の `id` を PK にしているので全件が該当してしまう。見るのは列の有無ではなく**引き方の経路**（ユニーク索引 / 期限切れ索引 / PK 素引きに `user_id` 述語が入っているか）である。
- **(c) 台帳の粒度では捕まらない次元** — DI 構成・ジョブ・spec 上の未設計領域。

**取り方。** `spec/inventory/adapter.md` の `ADP-*` 要素台帳（実測でユニーク85件）を全件走査し、上の述語を機械的に当てた。手作りの列挙ではない。台帳は `spec/database/` と `spec/domains/`（ポート定義）から生成されているので、spec 側の追加は台帳の更新として現れる。**表を更新するときは台帳を再走査する。**

**台帳は spec 由来であり、行の存在は実装の存在を意味しない。** 述語の適用対象は spec 上のポート・スキーマ定義である。実装済みなのは第2.3節に挙げた範囲だけで、`password_reset_tokens` / `search_fts` / `search_embeddings` は `0000_initial.sql` に無く（実在するのは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4テーブル）、`AiClientConnectionRepository` / `PasswordResetTokenPort` / `MailSender` / `IndexerReadPort` / `SearchIndexPort` / `TrashQueryPort` も未実装である。したがって行き先の欄が「不要になる」でも、#37 の作業がコード削除とは限らない — spec 側の未実装の設計指示を撤回する作業（#35 の領分）である場合がある。各行の出典欄でどちらかを見分ける。

| # | カテゴリ | 箇所 | 台帳 ID / 出典 | 行き先 |
|---|---|---|---|---|
| 1 | A. 引き方の経路に `user_id` を持たないスキーマ制約・索引 | `users_email_uq`（メールの一意性） | `ADP-users-001` | **Directory の関心事**。bucket 内の credential 行が唯一の権威になる（第6.1節 (c)） |
| 2 | | `users_sso_identity_uq`（SSO provider + subject の部分ユニーク） | `ADP-users-001` | **Directory の関心事**。実装済みなので「設計する」ではなく「移す」 |
| 3 | | `password_reset_tokens.token_hash` のグローバル UNIQUE | `ADP-password-reset-tokens-001` | **Directory の関心事**。トークンから bucket を引ける形に変える（第6.1節 (d)） |
| 4 | | `ai_client_connections` の `findActiveById(id)` 経路（PK 素引き + `status = 'active'`。`user_id` 述語が無い） | `ADP-ai-client-connections-001` | **User Data DO に閉じる**。トークンが `userId` を自己完結で運ぶので、DO 選択後は `user_id` 述語が自明になる（第5.4節） |
| 5 | B. `userId` を第一引数に取らない解決ポート（読み） | `UserRepository.findByEmail(email)` | `ADP-identity-004` | **Directory の関心事** |
| 6 | | `UserRepository.findBySsoIdentity(provider, providerSubject)` | `ADP-identity-005` | **Directory の関心事** |
| 7 | | `PasswordResetTokenPort.verifyAndConsume(token, now)` | `ADP-identity-015` | **Directory の関心事**（第6.1節 (d)） |
| 7b | | `PasswordResetTokenPort.issue(userId, now)` | `ADP-identity-014` | **Directory の関心事**（第6.1節 (d)）。`userId` を第一引数に取るので述語 (a) は文字どおりには発火しないが、**行き先はトークン行の置き場所で決まる** — 行3（`password_reset_tokens.token_hash` のグローバル UNIQUE）と行19（期限切れ掃除）を Directory へ送った以上、発行側だけ User Data DO に置くとテーブルの所在と矛盾する。発行時は `userId` から `credential_locators` を引いて bucket を決め、トークンに世代と bucket index を埋め込む |
| 7c | | `UserRepository.findById(id)` | `ADP-identity-003` | **分裂する**（行11 と対）。`insert` / `save` を「認証情報は Directory、設定は User Data DO」に割った以上、同じ集約を再水和する読み側も同じ2つに割れる。認証情報側は `credential_mappings`、設定側は `user_settings` / `account` を読む |
| 8 | | `AiClientConnectionRepository.findActiveById(id)` | `ADP-identity-010` | **User Data DO に閉じる**（行4 と対） |
| 9 | | `IndexerReadPort` 4本（`findMemoById` / `findDocumentById` / `listSourceLinksByMemo` / `listSourceLinksByDocument`） | `ADP-search-006` / `ADP-search-007` / `ADP-search-008` / `ADP-search-009` | **不要になる**。FTS5 同期更新（第7.1節）でインデクサ経路そのものが消える |
| 10 | | `SearchIndexPort.query(query: SearchQuery)` | `ADP-search-001` | **User Data DO に閉じる**。`userId` は DO 選択で消費され、引数から落ちる |
| 11 | C. `userId` を第一引数に取らない書き込みポート | `UserRepository.insert(user)` / `save(user, expectedVersion)` | `ADP-identity-001` / `ADP-identity-002` | **分裂する。** ユーザー単位設定は **User Data DO に閉じる**、認証情報は **Directory の関心事**（第4.5節） |
| 12 | | `AiClientConnectionRepository.insert` / `save` | `ADP-identity-006` / `ADP-identity-007` | **User Data DO に閉じる** |
| 13 | | `AiClientConnectionRepository.recordUsage(id, lastUsedAt)` | `ADP-identity-011` | **User Data DO に閉じる**。AI API 全リクエストのホットパスだが、既に対象 DO の中にいるので追加コストが無い |
| 14 | | `MemoRepository.insert` / `insertRevision` / `save` / `hardDelete` | `ADP-memo-001` / `ADP-memo-002` / `ADP-memo-003` / `ADP-memo-004` | **User Data DO に閉じる** |
| 15 | | `TopicRepository.insert` / `save` / `delete`、`DocumentRepository.insert` / `save` / `delete` / `insertRevision` / `insertSourceLinks` | `ADP-knowledge-001` / `ADP-knowledge-002` / `ADP-knowledge-003` / `ADP-knowledge-009` / `ADP-knowledge-010` / `ADP-knowledge-011` / `ADP-knowledge-019` / `ADP-knowledge-022` | **User Data DO に閉じる** |
| 16 | | `SearchIndexPort.upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` | `ADP-search-002` / `ADP-search-003` / `ADP-search-004` / `ADP-search-005` | **不要になる**。書き込み側は同一トランザクションの projection へ畳まれ、ポートとしては消える（第7.1節） |
| 17 | D. 全ユーザー横断ジョブ | `TrashQueryPort.listExpiredItems(now, limit)` | `ADP-trash-004` | **不要になる**。各 DO の Alarm が自分の期限だけを見る（第7.5節） |
| 18 | | 期限切れ列挙用の `user_id` なし部分インデックス3本（`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`）と `users` との全ユーザー JOIN | `ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001` | **不要になる**。行17 のスキーマレベルの実現手段なので道連れになる |
| 19 | | `password_reset_tokens` の期限切れ行掃除（`prt_expires_idx` は `user_id` を含まない） | `ADP-password-reset-tokens-001` | **Directory の関心事**。bucket の Alarm が掃除する（第7.4節） |
| 20 | | Outbox relay / pruner | `packages/core/src/application/workers/`（`eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 の2本だけ。consumer / DLQ はここに無い） | **不要になる**（第7.3節） |
| 20b | | Queue consumer / DLQ ハンドラ | `apps/web/app/worker/cloudflare/handlers.ts`（138行）の `handleQueue` / `handleDlq` | **不要になる**（第7.3節） |
| 21 | | 認証アダプターの**トークン失効 consumer**（`identity.aiClientRevoked` を購読） | `spec/domains/identity.md`、`spec/database/index.md` | **不要になる**。失効の権威が `ai_client_connections.status` として同じ DO 内にあり、次のリクエストのガードが直接読む（第5.4.1節 (b)） |
| 22 | E. `user_id` 列を持たない共有基盤テーブル | `outbox`（実装の実テーブル名は `outbox_events`）/ `processed_events` / `_occ_guard` | `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-occ-guard-001` | **不要になる**（第7.3節・第8.1節） |
| 23 | | `search_fts`（`user_id` が UNINDEXED） | `ADP-search-fts-001` | **User Data DO に閉じる**。物理的に1ユーザー分しか入らなくなるので `user_id` 列ごと落ちる（第4.4節） |
| 24 | | `search_embeddings` | `ADP-search-embeddings-001` | **不要になる**（`.adr/003-sqlite-fts5-only-search.md`） |
| 25 | F. `user_id` 列を持たない子テーブル（JOIN でスコープ） | `memo_revisions` / `document_revisions` / `source_links` | `ADP-memo-revisions-001` / `ADP-document-revisions-001` / `ADP-source-links-001` | **User Data DO に閉じる**。JOIN によるスコープ自体が不要になる（第4.4節） |
| 25b | | `DocumentRepository.deleteSourceLinksByMemo(userId, memoId)` | `ADP-knowledge-027` | **User Data DO に閉じる**（行25 の帰結）。台帳の契約が「`userId` スコープは **documents 側 JOIN**（`document_id IN (SELECT id FROM documents WHERE user_id = ?)`）で行う」を**規則として**持っているので、行25 で JOIN によるスコープが不要になると**この規則ごと撤回される**。テーブル側（`ADP-source-links-001`）だけを行に立てて操作側を落とすと、#35 が台帳の当該記述を書き換えそこねる |
| 26 | G. `userId` を引数に取らない副作用・変換ポート | `MailSender.sendPasswordResetMail(to: Email, resetToken)` | `ADP-identity-016` | **Directory の関心事**。`userId` 未確定の経路から始まり、宛先の原本を持つのも bucket なので、ジョブの所有者も bucket にする（第7.6節） |
| 27 | | `ArchiveWriter.write(archive)` | `ADP-export-002` | **request Worker で回す。** zip エンコードは CPU 予算を使うので DO の中では回さない（第4.8節・第8.3節 (a)） |
| 27b | | `ExportSourceReader.readAll(userId)` | `ADP-export-001` | **User Data DO に閉じる**（読み出しのスナップショットまで）。`userId` を第一引数に取るので述語 (a) は文字どおりには発火しないが、行7b / 行7c と同じ理由で足した — **第4.8節と第8.3節 (a) が「読み出しは DO 内、render と zip は request Worker」と実行位置を分割した以上、分割された両側が台帳に現れないと行27 の結論が根拠 ID を持たない**。読み出しは DO 内の1回の `transactionSync` で完結させ、値として返す |
| 28 | | `PasswordHasher.hash(plain)` / `verify(plain, hash)` | `ADP-identity-012` / `ADP-identity-013` | **Directory の関心事**（検証材料の保持元）。**計算そのものはどの DO の中でも回さず request Worker で実行する**（第4.8節・第8.3節 (b)） |
| 29 | H. DI 次元（ポート／テーブル単位の列挙では捕まらない） | **indexer 専用**の拡張 `WorkerContainer` | `spec/domains/search.md:264`、`spec/usecases/search.md:93`。**実装には存在しない** — `packages/core/src/application/di/types.ts` が定義しているのは `RequestContainer`（:53）と `WorkerContainer`（:70）の2つだけである | **不要になる**（第7.1節）。撤回は spec 側の作業なので **#35**（第11.1節） |
| 30 | | **pruner 専用**の拡張 `WorkerContainer` | `spec/domains/trash.md:239`、`spec/usecases/trash.md:315`。同上で実装には存在しない | **不要になる**（第7.5節）。撤回は **#35**（第11.1節） |

**行28 / 行7b / 行7c / 行25b / 行27b は本 Issue の台帳再走査で新たに見つかった行である。** 行28 は述語 (a) を「ID も状態も受け取らないが利用者の秘密を扱うポート」まで広げた結果で、`PasswordHasher` の実行位置は第4.8節の結論を1つ増やしている。行7b / 行7c / 行25b / 行27b は述語 (a) が文字どおりには発火しないが、**同じ集約・同じテーブル・同じ問いの対象を分割した以上、対称性のために行き先を書かないと結論が根拠 ID を失う**という理由で足した。

**台帳側の穴を1件、#35 へ送る。** `ExportRenderer.render`（`spec/domains/export.md:249`）に `ADP-*` ID が振られておらず、走査で拾えない。行27 / 行28 が「純粋計算の実行位置」を論点にした以上、同じ問いの対象になるべき要素である。`spec/inventory/adapter.md` の改訂時に採番する（第11.1節）。

**述語を当てた結果、上の表以外に漏れは無い。** 上の表は番号でいうと1〜30だが、枝番（7b / 7c / 20b / 27b / 25b）を含む**実行数35行**であり、引用している distinct な `ADP-*` は **53件**である。したがって**台帳85件のうち表に現れないのは32件**で、いずれも `userId` を第一引数に取る（`MemoRepository.findById(userId, ...)` / `TopicRepository.findById(userId, ...)` / `TrashQueryPort.listTrashItems(userId, ...)` / knowledge の読み18件ほか）ので述語 (a)(b)(c) のいずれにも当たらない。**件数を書き換えるときは台帳を再走査する**（`grep -o 'ADP-[A-Za-z0-9-]*' spec/inventory/adapter.md | sort -u | wc -l` = 85）。

### 4.4 スキーマ方針 ［派生］

**`user_id` 列は落とす。** DO が物理境界なので、同じ DO の中に他ユーザーの行は原理的に存在しない。列を残すと「一致しない行がありうる」という読み方を残してしまい、かえって誤解を招く。

- `memos` / `topics` / `documents` / `ai_client_connections` / `search_entries` から `user_id` 列を削る。`memos_timeline_idx` などの複合索引も先頭の `user_id` が落ちて単純になる。
- `memo_revisions` / `document_revisions` / `source_links` は元から `user_id` を持たず JOIN でスコープしていた。**JOIN によるスコープ自体が不要になる**ので、`spec/database/index.md` の該当記述はまるごと単純化される（#35）。
- 自分の `userId` は `_meta` テーブルに1行だけ持つ。用途は export のヘッダ、移送・検証、`ctx.id.name` が使えない経路（第6.3節）のフォールバックの3つに限る。**行データの絞り込みには使わない。**

制約の突き合わせ（第2.1節 F-17）: 1テーブル100列に対して最大は `documents` の十数列、行 2 MB に対してメモ本文は要件上それを大きく下回る、bind パラメータ100 に対しては一括挿入（`insertSourceLinks` など）をチャンク分割する。いずれも抵触しない。

### 4.5 リポジトリ契約の変化 ［派生］

`spec/domains/index.md` のテナント分離規約「外部入力の ID を受けるメソッドは `userId` を第一引数に取る」は、DO 化後は次のように読み替える。

**`userId` は DO 選択で消費され、DO 内のリポジトリは `userId` を取らない。** 構造的保証の在り処が「型（第一引数）」から「到達可能性（他ユーザーの DO stub を得る経路が存在しないこと）」へ移る。後者のほうが強い — 型の保証は「呼び出し側が正しい `userId` を渡す」ことに依存するが、到達可能性の保証は誤った `userId` を渡す経路そのものを消す（第5.5節）。

これに伴い、**規約の例外条項（「例外は Outbox 経由の信頼済み内部イベントを契機とするワーカー（search の indexer consumer 等）のみ」）は消える。** Outbox が transport でなくなり indexer consumer が存在しなくなるため、規約は「例外なし」に単純化できる。#35 が `spec/domains/index.md` をそう直す。

**memo / knowledge の書き込み系が `userId` を取らない**という現行の非対称（規約が読み取り側にしか効いていない。第4.3節の行11〜16）も、これで自動的に解消する — 読み取り側からも `userId` が落ちるので、読み書きの署名が揃う。

### 4.6 容量とライフサイクル ［派生］

**上限は「本体 + FTS インデックスの合計で 10 GB」で見る。** 仮想テーブルへの書き込みも rows written に算入され（第2.1節 F-15）、trigram は1ドキュメントあたりのインデックス行数が最も多い部類だからである。

増幅を抑える手段は external-content FTS5 を使うこと（第7.1節）。`content='search_entries'` / `content_rowid='rowid'` で本体行を参照させると、FTS 側に本文の複製を持たずに済む。それでも trigram の転置インデックス自体は本文長に比例して膨らむので、**容量の見積りは本体の数倍**を前提にする。

逼迫時の挙動は第4.7節のとおり「書き込みだけが `SQLITE_FULL` で落ち、読みと `DELETE` は通る」半死状態になる。したがって逼迫時の導線は **ゴミ箱を空にする / エクスポートして削除する** が生きる。監視の閾値・アラート・容量レポートは #38。

### 4.7 DO プラットフォームエラーの翻訳表 ［参考］

`CLAUDE.md`「adapter → application: アダプターが driver 固有エラーを共有エラー契約へ翻訳する」の適用先。次の規則で `packages/core/src/lib/` 由来の共有エラー契約へ写す。

**翻訳の実行場所は1箇所ではない。4行のうち2行は DO のコードが1行も走らない状況で発生する**ので、DO の中に catch 点が存在しない。「捕捉する側」を列として明示する。

| プラットフォーム条件 | 捕捉する側 | 写す先 | retryable | 根拠 |
|---|---|---|---|---|
| `.overloaded` が真のエラー（1オブジェクト 1,000 req/s の soft limit 超過） | **呼び出し側（request Worker / 他 DO）の stub アダプター** | `SystemError(ServiceOverloaded)` | **false** | 超過分は DO へ配送されないので、エラーを受け取るのは stub を叩いた側である。公式がリトライ禁止と明記している（第2.1節 F-19）。`ConflictError("OPTIMISTIC_LOCK_FAILURE")` のようなリトライ可能系へ写してはいけない |
| `SQLITE_FULL`（10 GB 到達） | **DO 内アダプター** | `SystemError(StorageCapacityExceeded)` | **false** | 書き込みだけが失敗し読みと `DELETE` は通る半死状態。通常の DB 障害と同じ扱いにすると復旧手段（削除）を塞ぐ |
| `ctx.abort()` / DO のリセット | **呼び出し側の stub アダプター** | `SystemError(DatabaseError)` | true | DO が消滅した結果として RPC の promise が reject する形でしか観測できない。公式も output gate について「書き込みに失敗するとシステムは Object をリセットし、**送出待ちのメッセージをすべて破棄し**、クライアントにはエラーを返す」としており、DO 側に catch する場所が残らない。接続断と同種で、次のリクエストで DO が再構築される |
| 条件付き UPDATE の0行一致（OCC 不一致） | **DO 内アダプター** | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | false（呼び出し元まで届ける） | 現行方針を維持（`CLAUDE.md`「Retry strategy」）。D1 のような CHECK 違反メッセージの部分一致は不要になる |

**したがって翻訳層は2箇所に置く。** DO 内アダプター（行2 / 行4）と、**DO stub factory が返す facade ラッパー**（行1 / 行3）である。後者を置かないと、生のプラットフォームエラーが `apps/web/app/presentation/errorResponse.ts` の `serializeError`（:70）へ素通りして `kind: "unknown"` の 500 になり、行1 が持つ**リトライ禁止**という最も重要な情報が失われる。第8.3節 (b) が「request 側 DI に残るもの」に DO stub factory を挙げているので、翻訳はそのファクトリが返すラッパーの責務である。**state Worker 内の DO 間 RPC にも同じラッパーを通す**（第3.2節で state Worker にも両 binding を置いたため）。

**`ServiceOverloaded` / `StorageCapacityExceeded` は新規コードである。** 現行の `packages/core/src/application/errors.ts` の `SystemErrorCode` は `DatabaseError` / `DataIntegrityError` / `CryptoError` / `SessionError` / `NetworkError` / `ExternalApiError` の6値で、この2つは存在しない。**#37 は同ファイルへ2値を追加する**（`RETRYABLE_SYSTEM_CODES` には**入れない** — どちらも retryable false）。第11.2節の変更対象一覧に行を足してある。

**HTTP status は `kind` 単位のまま据え置き、両方とも 500 で返す。** `apps/web/app/presentation/errorResponse.ts` の `HTTP_STATUS_BY_KIND` は `kind`（`system`）だけを見て `code` を見ない。`CLAUDE.md`「HTTP status mapping is presentation-only, driven by the serialized `kind`」がそう定めているからであり、`overloaded` に 429 / 503 を割り当てるために `code` 分岐を presentation へ持ち込むのは、その契約を崩すのに見合わない。**`overloaded` は 500 で返す**（リトライしてはならないので、クライアントへ「後で再試行せよ」を意味する 429 / 503 を返すほうがむしろ有害である。第2.1節 F-19）。利用者向けの文言差は `code` を見る表示側（`apps/web/app/presentation/` のエラー表示ヘルパ）で吸収する。

**CPU 予算超過には写す先が無い。** 超過はエラーとして観測されず、エビクションとリセットとして現れるからである（第2.1節 F-4）。翻訳表の対象外であることを明記し、予防は第4.8節で行う。

### 4.8 DO 内で回す大きな CPU 仕事の扱い ［派生］

DO は single-threaded なので、重い計算を回している間そのユーザー（または Directory bucket なら同じ bucket に写像される全ユーザー）のリクエストが止まる。しかも判定基準は wall time ではなく CPU 予算で、**Alarm 駆動には「着信ごとにリセット」の契機が無い**（第2.1節 F-4）。対象4件それぞれに結論を出す。

| 仕事 | 結論 | 理由 |
|---|---|---|
| **パスワードハッシュ化 / 検証**（`ADP-identity-012` / `ADP-identity-013`） | **DO の外（request Worker）で回す** | PBKDF2 210,000 回（`.thread/1/adr.md` ADR-002）は CPU 予算を大きく使う。User Data DO で回すとそのユーザーの全リクエストが止まり、Directory bucket で回すと同じ bucket の全ユーザーの認証が止まる。Directory bucket は候補の検証材料を値として返し、照合は request Worker が行う（露出範囲は現行の `findByEmail` が `User` ごとハッシュを返しているのと同じ） |
| **export の zip エンコード**（`ADP-export-002`） | **DO の外（request Worker）で回す。あわせて「上限」を設ける** | `spec/domains/export.md` が同期生成を確定させ、読み出しに単一トランザクション（スナップショット読み）を要求しているので、**読み出しだけ**を DO 内の1回の `transactionSync` で完結させて値として返し、レンダリングと zip 化は request Worker で行う。分割読み出しはスナップショット要求を壊すので採らない。代わりに1回のエクスポートで返せる総バイト数に上限を置き、超過は拒否する（`SystemError` 系）。**上限を設けること自体は本設計で決着済みで、残るのは値だけである。決定は2段に分ける — #37 が着手時の spike（第2.1節 F-26 の結果セット合計サイズ上限）から根拠値を出し、#38 が運用値として確定する。** 第11.4節も同じ分担で書いてある |
| **FTS5 の全件再インデックス** | **DO 内。ただし Alarm でチェックポイント分割する** | 本体テーブルからしか作れないので DO 内でしか回せない。1回の Alarm で処理する量は「進捗をコミットしてから次の Alarm を張る」単位で切る（第7.4節） |
| **bulk migration** | **DO 内。ただし Alarm でチェックポイント分割する** | 同上。DDL 部分は単発、データ書き換え部分は分割（第9.2節・第9.3節） |

## 5. ルーティング ［Issue 要求］

### 5.1 認証済みリクエスト（UI / REST / MCP） ［Issue 要求］

経路は次の一本道になる。

```text
Cookie / Authorization ヘッダ
  → sessionCodec.verify(token, now)            ← request Worker。DB を触らない
  → userId（+ sessionEpoch。トークンに署名済み）
  → env.USER_DATA.idFromName(userId)           ← locator の導出はここだけ
  → stub.<usecase>(args)                        ← RPC。値だけを運ぶ
  → DO 内で epoch ガード → usecase 実行
```

**コンテナ構築と `userId` 確定の順序問題を解く。** 現行は `apps/web/app/server.cloudflare.ts` がリクエスト先頭で `createRequestContainer` を作って `AsyncLocalStorage` に載せており、`userId` を確定する `apps/web/app/presentation/currentUser.ts` の `requireUserId()` はそれより後に走る。DO 化後の `RequestContainer` は **`unitOfWorkProvider` を持たなくなり、代わりに DO stub factory（`userId` を受けて stub を返す関数）を持つ**。ファクトリは呼ばれるまで `userId` を要求しないので、構築が先でも問題がなくなる。順序を入れ替える必要は無い。

**epoch ガード。** セッショントークンには発行時の `sessionEpoch` を署名しておき、下表のクラス (1) に属する RPC エントリの先頭で `account` テーブルの現在値と照合する。不一致・アカウントが `deleting` / `deleted` なら fail closed で拒否する。

**epoch を進める操作は4つであり、本節がその正本である。** パスワード変更 / パスワードリセット完了 / SSO の**解除**（unlink）/ 退会。同じ `operationId` の再送では一度だけ進める（第6.5節）。**SSO の link では進めない。** link は認証手段を増やすだけで既存セッションの信頼性を下げないので失効の必然性が無く、進めると「設定画面から SSO を連携した利用者がその場でログアウトされる」という害だけが残る。第6.5節の列挙と第6.6節 link 手順4 は本節に揃えてある。

- **残余リスクを隠さない。** セッションを握った攻撃者が自分の SSO 主体を link すると、その後パスワードをリセットされても SSO 経由で入り続けられる。epoch を進めても link 済みクレデンシャルは消えないので、**epoch 前進はこの経路の対策になりえない**（link で進める案を採ってもこのリスクは残る）。塞ぐのは**リセット完了画面の必須導線**である — クレデンシャル一覧と AI クライアント接続一覧を提示し、覚えの無いものを解除させる。画面要件なので #35 へ送る（第5.4節の AI 接続側の導線と1つにまとめる）。

**「epoch ガードを通らない RPC エントリは signup の1本だけ」は成立しない。** 同じ文書の中に epoch を構造的に運べないエントリが2系統ある — login の step 5 は epoch を**取得する**側であり照合対象のトークンがまだ存在しない（第5.3節）。DO 間 saga の前進は Alarm 起点で、セッションを持つ主体がそもそも存在しない。#37 がこの断定をそのまま実装すると login と全 saga が epoch 不一致で拒否され、逆に場当たりに穴を空けると「どのエントリが認証を要求しどれが要求しないか」の一覧が設計側に存在しない状態になる。**したがって RPC エントリを3クラスに分け、(2)(3) を全数で列挙する。これが #37 への断定である。**

- **(1) 利用者由来** — セッション / AI クライアントトークンを持つリクエストから呼ばれる。**epoch ガード必須**（AI クライアントトークンは epoch を持たないので接続状態ガード。第5.4節）。
- **(2) 未認証 bootstrap** — request Worker が未認証入力（またはトークンだけを認可材料とする入力）を受けて叩く。epoch の代わりに個別ガードが守る。
- **(3) 内部エントリ** — 呼び出し元が DO（saga の前進・Alarm）または operator 専用の maintenance 経路。**既定のガードは binding 到達性 + `operationId` / `payloadDigest` の CAS + phase 条件**である。
  - **クラス分けの基準は「誰が呼ぶか」ではなく「何がガードするか」である。** (2) は「未認証入力に対して個別ガードが守る」、(3) は「CAS / phase 条件 / `callerToken` / 到達制御が守る」という区別で、呼び出し元は結果として決まる。第5.5節 1 が保証しているのは locator の材料であって呼び出し元の身元ではないので、**「(3) は DO からしか来ない」を実装の前提にしてはならない**（下記「(3) は request Worker からも binding 上は呼べる」）。
  - **既定のガードが当てはまらないエントリが8本ある。** `read-own-canonical` / `delete-mapping` / `lookup-credential-by-locator` は `callerToken` が守り（下記 (3-b)）、`begin-credential-change` / `advance-credential-change` / ローテーション経路の `record-credential-locator` は**`operations` 行を新規に作る側なので phase 条件が原理的に効かず**、同じく `callerToken` が守る（下記 (3-d)）。`check-previous-generation` / `purge-user-mappings` は到達制御と監査だけが守る（下記 (3-c)）。**とくに `check-previous-generation` は signup 起点では未認証の request Worker から呼ばれるので、呼び出し元だけを見れば (2) に見える。** それでも (3) に置くのは、**返す情報が真偽1ビットで副作用が無く、locator の算出に `DIRECTORY_ROUTING_SECRET` を要する**ため、(2) が必要とする「応答の均一化」や「レート制限」に相当する個別ガードを持たないからである。**#37 はこの1本について「(3) だから DO からしか来ない」と仮定しない。**

| クラス | エントリ | 所属 DO | 呼び出し元 | ガード |
|---|---|---|---|---|
| (1) | 利用者データの usecase facade 全部（memo / knowledge / search / trash / export / 設定変更 / AI 接続の作成・失効 / SSO link・unlink の起点 / 退会の起点） | User Data DO | request Worker（認証済み） | **epoch ガード**。**unlink の起点はこれに加えて「対象 `credentialId` の `kind` が `'sso'` であること」と「最後のログイン手段でないこと」の2検査を DO 側で通す**（第6.6節 unlink 手順1）。AI クライアントトークン由来の呼び出しは epoch を持たないので `ai_client_connections.status` + `account.status`（第5.4節） |
| (2) | `lookup-credential`（login step 3 / リセット依頼の解決） | Directory bucket | request Worker（未認証） | 無条件に応答し、**中身を均一化する** — 未登録 / `changeState = 'pending'` / `nextAttemptAllowedAt` 未到達はすべてダミー検証材料へ倒す（第5.3節・第6.2.2節） |
| (2) | `verify-login`（login step 5） | User Data DO | request Worker（未認証） | `account.status = 'active'` + 到達性検査 + `credentialVersion` 一致（第5.3節 step 5） |
| (2) | `report-login-result`（login step 7） | Directory bucket | request Worker（未認証） | **`usedLocator` の `(kind, 全長 HMAC, generation)` が自 bucket に実在する mapping 行を指すこと。** 実在しなければカウンタを更新せず成功を返す（未登録 canonical との応答差を作らない。第5.3節）。**「step 3 で自分が返した行であること」は要求しない** — DO は RPC を跨いだセッション状態を持たないので bucket 側に照合材料が無く、実装不能な述語だからである。悪用可能な差は無い（成功報告は request Worker の照合結果に従属し、失敗報告は正規の login 失敗と等価で、天井・減衰・非加算の3規則が第6.2.2節 (a) にある）。カウンタの更新以外の副作用を持たない（第5.3節 step 7） |
| (2) | `reserve-credential`（signup phase 1a / 1b / link 手順2） | Directory bucket | request Worker（未認証）**または** コーディネーター bucket（`resume-signup` の phase 1b。第6.4節）**または** User Data DO（link 手順2 / `resume-link`。第6.6節） | 既存 active 行との一意制約 + `operationId` / `payloadDigest` の CAS。**予約行には `credentialId` と `callerToken` を載せる** — signup 経路は phase 0 が採番した値、link 経路は request Worker が採番した `credentialId` と `account.callerToken` から読んだ値である（第6.1.2節・第6.6節 手順1〜2） |
| (2) | `initialize-account`（signup phase 2） | User Data DO | request Worker（未認証）**または** コーディネーター bucket（`resume-signup`） | **`account` 行の有無だけでは判定しない。述語は `account` 行と `operations` 行の組で決まる**（第5.5節 5・第6.3節 phase 2）— **(i) `account` 行が無ければ初期化する**、**(ii) `account` 行があり、同じ `operationId` の `operations` 行（`kind = 'signup'`）が存在しないなら拒否する**（他人のアカウントの DO への書き込み）、**(iii) 同じ `operationId` の行があって `payloadDigest` が一致するなら成功として返す**（no-op。第6.4節が要求する phase 2 の冪等性）、**(iv) 一致しなければ `ConflictError`**。**`callerToken` は引数で受け取り `account` 行に書く**（採番は phase 0。下記） |
| (2) | `lookup-credential-by-locator`（パスワード変更 phase 0 の旧検証材料取得。第6.5.1節） | Directory bucket | request Worker（セッション認証済み） | 引数は canonical ではなく **`(credentialId, generation, bucketIndex)`**（呼び出し元が `credential_locators` から得た永続化済みの locator。第6.1.1節 (R5)）+ `callerToken` の定数時間比較。返すのは `passwordVerifier` / `credentialVersion` / `changeState` だけで、`encryptedCanonical` も復号結果も返さない |
| (2) | `request-password-reset` | Directory bucket | request Worker（未認証） | レート制限と応答均一化のみ（第6.2.2節 (b)・第7.6節） |
| (2) | `begin-credential-change`（第6.5.1節 phase 1） | Directory bucket | request Worker | **起点ごとに DO 側の束縛を1つ持つ**（これが無いと「検証材料は読めないが差し替えはできる」状態になる。下記 (3-d)）。**起点 A（パスワード変更）は `callerToken` の定数時間比較**（呼び出し元は phase 0 の A-1 で `account.callerToken` を取得済みである）。**起点 B（リセット完了）は、引数の `operationId` が同 bucket の `password_reset_tokens` 行の `consumedByOperationId` と一致し、その行の `credentialId` が対象と一致すること**（`consume-reset-token` は同じ bucket で走るので照合材料がその場にある）。認可の判定そのものは呼ぶ前に request Worker が済ませる — パスワード変更はセッション + 旧パスワード照合（材料の取得経路は第6.5.1節 phase 0 の起点 A）、リセット完了はトークンの消費。**Directory は epoch を持たないので、ここで認可を再判定しない**。対象 locator は呼び出し元が第6.1.1節 (R5) で解決した値であり、canonical から導出し直さない |
| (2) | `consume-reset-token` | Directory bucket | request Worker（未認証） | トークンハッシュの一致 + 未使用 + 未期限 + **同 bucket にトークン行の `credentialId` と一致する mapping 行が存在すること**。消費時に **`consumedByOperationId` へ引数の `operationId` を記録する**（`begin-credential-change` の起点 B 側の束縛材料になる）。戻り値は `userId` / `credentialId` / `credentialVersion`。**`generation` / `bucketIndex` の範囲検査は DO を叩く前に request Worker の transport 境界で行う**（第6.1節 (d)） |
| (2) | `exchange-authz-code`（OAuth 2.1 token エンドポイント。第5.4.1節） | User Data DO | request Worker（**未認証**。クライアント資格情報だけを持つ） | 署名検証 + **`typ: "authzCode"` の厳密一致** + `exp` + **`jti` の一回性 CAS**（短命テーブルへの記録が0行なら再交換として拒否）+ `code_verifier` → challenge の**定数時間比較** + **`redirect_uri` の一致**（コードに署名済みの `redirectUri` と、token リクエストが送ってきた値の完全一致。第5.4.1節）+ `account.status = 'active'`。`userId` は署名済みコードから得るので呼び出し元供給ではない |
| (3) | `advance-credential-change`（第6.5.1節 phase 2） | User Data DO | Directory bucket | **`callerToken` の定数時間比較**（Directory 側の mapping 行が持つ値を引数に載せ、User Data DO の `account.callerToken` と比較する）+ `operationId` / `payloadDigest` の CAS。**このエントリは `operations` 行を新規に作る側なので「記録されていない `operationId` で phase を飛ばせない」は当てはまらない** — 束縛は `callerToken` である（下記 (3-d)） |
| (3) | `record-credential-locator`（signup phase 4 / link 手順4 / ローテーション手順2 の (1)(4)） | User Data DO | Directory bucket / User Data DO 自身（link 手順4 の `resume-link`） | **`callerToken` の定数時間比較**（全経路共通。Directory 側は mapping 行が持つ値を運ぶ）。signup / link 経路はこれに加えて `operationId` / `payloadDigest` の CAS を課す。**ローテーション経路は `operations` 行を作らない**（移送は認証状態の変更ではないため）ので `callerToken` だけが束縛である（下記 (3-d)）。**追加の冪等キーは `(credentialId, generation)` で、既存行があれば `credentialVersion` / `usableForLogin` / `label` を上書きする upsert である**（no-op にしない。`credentialVersion` の上書きは `credentialId` 単位で単調非減少。第6.1.1節 (R8)）。削除は「無ければ成功」の冪等操作 |
| (3) | `activate-reservation`（signup phase 3 / link 手順3） | Directory bucket | コーディネーター bucket（signup）/ User Data DO（link） | 予約行の `operationId` 一致 |
| (3) | `promote-verifier`（第6.5.1節 phase 3） | Directory bucket | 自 bucket の Alarm | `changeState = 'pending'` かつ `operationId` 一致 |
| (3) | `check-previous-generation`（signup phase 1 / link 手順2 の previous 世代確認。第6.1節 (c)） | Directory bucket | request Worker（signup）/ User Data DO（link）/ コーディネーター bucket（`resume-signup` の phase 1b） | **CAS も phase 条件も持たない。** 読み取り専用で副作用が無く、返すのは「その locator の行が存在するか」の真偽1ビットだけである。locator の算出には `DIRECTORY_ROUTING_SECRET` が要り、返る情報量は signup を1回投げて得られる情報と同じなので、追加の束縛を課さない |
| (3) | `read-own-canonical`（設定画面に自分のメールアドレスを表示する。第6.2.1節 (c) 4） | Directory bucket | User Data DO | **引数は `(userId, credentialId, callerToken)`。行の選択キーは `credentialId` である**（bucket 内 UNIQUE なので最大1行に定まる。第4.1.1節）。**CAS も phase 条件も持たない。束縛は `callerToken` である** — 引数の `callerToken` を mapping 行の値と定数時間比較し、加えて `credential_mappings.userId` が引数の `userId` と一致する行に限る。復号結果を1件だけ返し、bulk 復号の口を持たない |
| (3) | `delete-mapping`（退会 手順3 / unlink 手順3 / `sweep-orphan-mapping`） | Directory bucket | User Data DO | **CAS も phase 条件も持たない。束縛は `callerToken` である** — 定数時間比較 + mapping 行の `userId` 一致。**削除対象は引数の `credentialId` に一致する行**（bucket 内 UNIQUE なので最大1行である。第4.1.1節）。**同じ credential の別世代の行は別 bucket にある**（DO 名が世代を含むため）ので、呼び出し元が**世代ごとに `delete-mapping` を発行する**（第6.1.1節 (R3)・第6.7節 手順3）。「無ければ成功」の冪等操作 |
| (3) | `cancel-reservation`（signup 敗北時の敗者補償 / 第6.4節 3 の終端規則） | Directory bucket | コーディネーター bucket | 行の `operationId` 一致。**`status` は `reserved` / `active` を問わない** — 終端規則は phase 3 で `active` へ昇格済みの行も回収する必要があるため。`operationId` が一致しない行には触れない。「無ければ成功」の冪等操作 |
| (3) | `abandon-account`（第6.4節 3 の終端規則） | User Data DO | コーディネーター bucket | `operations` 行の `operationId` 一致 + `kind = 'signup'` + `phase` が `done` でないこと。`account.status` を `deleting` へ倒して `finalize-withdrawal` を投入する。**`done` に達した saga は倒せない** |
| (3) | `propagate-saga-committed`（第6.4節 2） | Directory bucket | コーディネーター bucket | 予約行の `operationId` 一致 |
| (3) | `purge-user-mappings`（退会の最後の砦。第6.7節） | Directory bucket | **operator 専用 maintenance 経路**（request Worker 内） | **CAS も phase 条件も持たない。** maintenance 経路そのものの到達制御（公開ルートを持たない。#38）+ 対象 `userId` の存在確認 + **実行の監査ログを必須にする**（#38）。逆引き情報ごと失われた場合の回収手段なので `callerToken` を要求できない — したがって**本表で最も危険なエントリであり、到達制御と監査だけが守っている**ことを明記する |
| (3) | ローテーションの起動と鍵の一時注入（`rotate-remap` の1チャンク / `rotate-encryption` の起動） | Directory bucket | operator 専用 maintenance 経路（request Worker 内） | maintenance 経路そのものの到達制御（公開ルートを持たない。#38）+ 世代の CAS。**`rotate-remap` は Alarm ジョブではなく、maintenance 経路が1チャンクずつ同期に駆動する**（第6.8節 手順2） |

**本表は「クラス (2)(3) の全数」を宣言している。したがって更新規則を表に添える — 本文が新しい RPC エントリを導入したら、本表にも必ず行を足す。** 第6.4節の cross-DO 操作表・第6.9節の締め出し経路表と同じ扱いである。本表と本文が食い違ったら**本表を直す**（本文がエントリを導入した理由を持つので、本文の側が正しい）。

**(3) は request Worker からも binding 上は呼べる。それでよい、と断定する。** state Worker は公開ルートを持たず、到達手段は binding 経由の RPC だけである（第3.2節・第8.3節 (e)）。したがって (3) を呼べるのは同一アカウント内の信頼済み script に限られる。**binding を絞って到達性だけで守る形は採らない** — 絞ると saga の前進経路そのものが塞がるからである。

**そのうえで「(3) のガードは呼び出し元が DO であることに一切依存していない」を全エントリについて成り立たせる。ただし守り方は一様ではないので、エントリを4群に分けて明示する。初版は「守っているのは CAS と phase 条件である」と一括で正当化していたが、それが当てはまらないエントリが実際には8本あった。**

- **(3-a) 既存の saga 状態を前提とするエントリ — CAS と phase 条件が守る群** — `activate-reservation` / `promote-verifier` / `propagate-saga-committed` / `cancel-reservation` / `abandon-account`。いずれも**呼び出し前に別の主体が書いた行（予約行 / `operations` 行 / `changeState = 'pending'` の mapping 行）の存在を条件にする**ので、存在しない saga を前進させることも、記録されていない `operationId` で phase を飛ばすこともできない。locator の材料も呼び出し側が永続化済みの値に限られる（第5.5節 1）。
  - **初版は (3-a) を「CAS と phase 条件が守る」と一括で書いていたが、それは `operations` 行を新規に作る側のエントリには成立しない。** 該当する3本（`begin-credential-change` / `advance-credential-change` / ローテーション経路の `record-credential-locator`）を (3-d) として切り出した。
- **(3-b) `callerToken` が守る群（既存状態の読みと削除）** — `read-own-canonical` / `delete-mapping`（および (2) の `lookup-credential-by-locator`）。**書き側の3本も同じトークンで束縛するが、当てはまらない理由が違うので (3-d) に分けてある。** **この3本は CAS も phase 条件も持たず、初版は「呼び出し元 DO の `userId` と一致する行に限る」だけを守りにしていた。ところが DO 間 RPC には呼び出し元の認証済み識別子が存在しない** — 「呼び出し元 DO の `userId`」は引数として渡るほか無く、bucket 側にそれを検証する材料が無い。**そのままだと `read-own-canonical` は「`userId` を1つ渡せばメール平文が1件返る」復号オラクル、`delete-mapping` は「`userId` を渡すだけで mapping が消える」ロックアウト原始関数になる。`userId` は秘密ではない**（リビジョンの `Actor` や export ヘッダから知りうる。第6.3節）。**したがって `callerToken` を導入する。**
  - **`callerToken` は128ビットの不透明値で、signup phase 0 に request Worker の `IdGenerator` が候補 `userId` と同時に採番する。** 保存先は User Data DO 側が `account.callerToken`（`initialize-account` が引数で受け取って書く）、Directory 側が `credential_mappings.callerToken`（phase 1a / 1b の予約行が持ち、link では手順2 の予約が `account` から読んだ値を運ぶ）である。**鍵ローテーションの移送は行ごと引き継ぎ、再採番しない**（第6.8節 手順2）。退会で行ごと消える。
  - **束縛の実体はこのトークンだけである。** 「呼び出し元が epoch ガードを通った User Data DO であること」を bucket 側で検証する手段は無いので、そう書いた要求（初版の第6.2.1節 (c) 4 のガード (i)）は撤回して本規則へ置き換える。トークンは第5.2節 (c) の非露出対象に含め、RPC の引数・戻り値ロギングと同じく出さない。
  - **`callerToken` が守る相手を正確に書く。守れるのは「binding には到達できるが `SESSION_SECRET` を持たない呼び出し元」だけである。** 具体的には、同一アカウント内の別 script、誤配線された内部経路、将来 state Worker が別の Worker から呼ばれる構成である。この範囲では上記の復号オラクル／ロックアウト原始関数は正しく塞げている。
  - **request Worker 内でのコード実行を得た攻撃者に対しては `callerToken` は防壁にならない。残余リスクとして明記する。** その攻撃者は `SESSION_SECRET` を握っているので（第3.2節）任意の `userId` について有効なセッショントークンを署名でき、`sessionEpoch` は単調増加の小さなカウンタなので数回の試行で一致させられる。そのうえで第6.5.1節 phase 0 の A-1（クラス (1) のエントリ）を叩けば被害者の `account.callerToken` がそのまま返る。**したがって「1層目は公開ルートの不在、2層目は `callerToken` で、後者は request Worker のコード実行を得た攻撃者に効く」という初版の脅威モデルは誤りである。** 正しくは「1層目（公開ルートの不在）が破られた時点で `callerToken` も同時に破られる」であり、この残余リスクは (3-c) の `purge-user-mappings` と同じ扱いで #38 の監査要件へ送る（第11.3節）。**それでも機構は廃止しない** — 上の「`SESSION_SECRET` を持たない binding 保有者」に対しては実効があり、`encryptedCanonical` の復号結果は本システムで最も価値の高い PII だからである（第6.2.1節 (b-1)）。
- **(3-d) saga を新規に開始できる群 — `callerToken` が守る。** `begin-credential-change`（クラス (2)）/ `advance-credential-change` / ローテーション経路の `record-credential-locator` の3本である。**この3本は `operations` 行や `changeState` を新規に作る側なので、(3-a) の「記録されていない `operationId` で phase を飛ばせない」が原理的に当てはまらない。** 束縛を置かないと次の3つが同時に成立する — (i) `begin-credential-change` を無束縛にすると、任意アカウントの `pendingVerifier` を差し替えて `resume-credential-change` の Alarm に phase 2 / 3 を自走させられる（**乗っ取り原始関数**）、(ii) `advance-credential-change` を無束縛にすると `sessionEpoch` と `credentialVersion` だけが前進して Directory 側と不一致になる（**恒久ロックアウト原始関数**）、(iii) ローテーション経路の `record-credential-locator` を無束縛にすると `reserve-credential` + `activate-reservation` と組み合わせて任意アカウントへ攻撃者のクレデンシャルを注入でき、第5.3節 step 5 (ii) の到達性検査を通せる。**同じ locator に対する読み（`lookup-credential-by-locator`）を `callerToken` で束縛しておきながら、より強い書きを無束縛のまま残すのは設計の自己矛盾なので、3本とも `callerToken` で束縛する。** 材料は新しく増えない — 起点 A は phase 0 の A-1 が `account.callerToken` を返し、`advance-credential-change` と `record-credential-locator` は Directory 側の mapping 行が同じ値を持つ。**唯一の例外は `begin-credential-change` の起点 B（リセット完了）で、未認証経路なので `callerToken` を提示できない。** ここは `consume-reset-token` が同じ bucket で走ることを使い、消費したトークン行の `consumedByOperationId` と `credentialId` の一致を条件にする（表のガード欄）。**ローテーション経路の `record-credential-locator` に `operations` 行を要求しない、と決め切る** — 要求するとローテーションが動かず、`operations` 行を新規作成して満たす実装にすると無束縛になるので、どちらにも倒さずに `callerToken` を束縛の実体にする。
- **(3-c) 到達制御と監査だけが守る群** — `check-previous-generation` と `purge-user-mappings`。前者は副作用が無く返す情報が真偽1ビットなので追加の束縛を課さない。**しかも signup 起点では未認証の request Worker から呼ばれるので、クラス (3) の定義文（「呼び出し元が DO または operator 専用の maintenance 経路」）に文字どおりは当てはまらない** — その扱いはクラス定義の側に例外として明記してある（上記）。後者は**逆引き情報ごと失われた場合の最後の砦なので、原理的に `callerToken` を要求できない**（トークンは失われた行と一緒に消えている）。**したがって `purge-user-mappings` は operator 専用 maintenance 経路の到達制御と実行監査だけが守る、と正直に書く。** 残余リスクは「request Worker 内でのコード実行を得た攻撃者が任意アカウントの mapping を消せる（＝恒久ロックアウト）」であり、緩和は #38 の監査要件へ送る（第11.3節）。

**`requireUserId()` / `readAuthStateFn` は epoch ガードの外側にある。** 現行の `apps/web/app/presentation/currentUser.ts:17-26` の `getCurrentUserId` は `sessionCodec.verify` の戻り値だけで `userId` を確定し、DB も DO も触らない。同ファイル `:28-33` の JSDoc は `requireUserId()` を「The authoritative guard」と宣言している。`apps/web/app/presentation/authState.ts:18-23` の `readAuthStateFn` も `getCurrentUserId()` の結果だけで `{ authenticated: true }` を返し、これが `apps/web/app/routes/_app.tsx` の `beforeLoad` から全保護ルートで走る。**つまり epoch を進めて失効させたはずのセッションが、認証済みシェルの描画とルーティング判定を通過する。** データ取得は DO を叩くので最終的には拒否されるが、認可の権威の所在が設計と実装で食い違ったまま残り、**DO を叩かない server function を1つ足した時点で本物のバイパスになる**。#37 は次の3つを行う。

1. **`currentUser.ts` の JSDoc から `requireUserId()` の「The authoritative guard」という位置づけを外す。** 書き換え後の位置づけは「トークン真正性の前段チェック」であり、認可の権威は DO 側の epoch ガードであることを明記する。
2. **`readAuthStateFn` は DO を叩かないままにする**（epoch 照合のために全ナビゲーションへ RPC を1本足さない）。代わりに `beforeLoad` が「ナビゲーションの利便であって認可ではない」ことを本文コメントで維持したうえで、**保護データを返す server 実行点が必ず DO を経由することをテストで固定する**。
3. **「DO を叩かない server function は保護データを返さない」を規約として置く。** 本節が掲げる「認証済みリクエストはどのみち自分の User Data DO を叩く」という不変条件は、この規約があって初めて保てる。

**したがって `apps/web/app/presentation/currentUser.ts` と `authState.ts` は #37 の改修対象である。** 第11.2節の `apps/web/app/presentation/` の行（「server-function エントリとエラー応答ミドルウェアは残る」）ではこの3点を覆えないので、**第11.2節にこの2ファイル専用の行を分けて置いてある**。

**`SessionCodec` ポートの契約が変わる。** 現行の `packages/core/src/application/ports/sessionCodec.ts` は `issue(userId, now): Promise<string>` / `verify(token, now): Promise<{ userId } | null>` で **epoch を運ぶ口が無く**、実装 `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` のペイロードも `{ uid, exp }` だけである。**#37 は `issue(userId, epoch, now)` / `verify` の戻り値に `epoch` を足し、ペイロードを `{ typ: "session", uid, ep, exp }` へ広げる**（`typ` は第5.4節の audience タグ）。第3.1節の「セッション方式そのものは変えない」はステートレス HMAC + TTL 7日という**方式**の話であって、ポート契約が据え置かれるという意味ではない。

**移行期の epoch 無しトークンは拒否する（fail closed）。** `ep` を持たないトークンを「epoch 0」とみなすと、`sessionEpoch` を進めて失効させたはずのトークンが古い形式のまま生き残る余地を残す。したがって `ep` 欠落は `verify` が `null` を返す。**代償は全ユーザーの再ログイン1回**で、TTL 7日の据え置きより安全側に倒す。第3.2節が定めた「片側デプロイ・ロールバックの互換ウィンドウ最低1リリース分」の対象はセッショントークンには適用しない — セッションはロールバックしても再ログインで回復するデータであり、DO のスキーマのように壊れると戻せないものではないからである。

**AI クライアントトークンは epoch を持たない。** 失効の機構が違うので、第5.4節で別に書く。「epoch を進めれば AI トークンも無効になる」は成立しない。

この照合は**追加の往復を生まない** — 認証済みリクエストはどのみち自分の User Data DO を叩くからである。これが第3.1節で Account Home を採らなかった理由の中核である。`.thread/1/adr.md` ADR-002 が受け入れた「サーバー側失効の手段が無い」というトレードオフはこれで解消するが、セッション方式（ステートレス HMAC + TTL 7日）自体は変わらないので、**セッション方式を扱う別 ADR は起こさない**（第3.1節で下した判断）。

### 5.2 DO ID / routing key と PII ［Issue 要求］

結論は3点ある。

- **(a) 生のメールアドレス・SSO subject を DO ID / routing key に使わない。** 使うのは `userId`（User Data DO）と、canonical credential を HMAC した値（Directory bucket）だけである。
- **(b) 正規化値の HMAC-SHA-256 を使う。** Directory の locator は `HMAC-SHA-256(DIRECTORY_ROUTING_SECRET[generation], canonical)` から導出する（第5.2.2節・第5.2.5節）。
- **(c) 次の値を、公開入力・URL・ログ・エラーメッセージ・トレースのいずれにも出さない。** canonical 値 / HMAC 値 / locator に加え、**`passwordVerifier`（パスワード検証材料）・`encryptedCanonical`（暗号文とその復号結果の両方）・パスワードリセットトークン（生値とハッシュの両方）・`callerToken`（DO 間 RPC の呼び出し元束縛。第5.1節）** を対象に含める。エラーは `kind` タグ付きの共有エラー契約だけを運び、識別子を含めない。とくに `passwordVerifier` は第5.3節 step 3 で **未認証リクエストに応答して DO 境界（script 境界）を越える RPC 値**になるので、RPC の引数・戻り値ロギングを有効化する構成そのものを禁止する。
  - **未認証経路では `userId` も `credentialId` もログに出さない。** ログに出してよいのは operation ID だけである。`credentialId`（第6.1.2節）は `userId` と同じく「サーバーが採番した不透明値で PII ではないが、その存在が『登録済みである』ことを漏らす」性質を持つので、扱いを揃える。login 失敗時に `userId` が出ると「そのメールアドレスは登録済みだった」（未登録ならダミー材料なので `userId` が無い）がログに残り、ログ閲覧権限を持つ内部者に対する列挙オラクルになる。第5.3節が公開レスポンス側で払っている均一化の努力と釣り合わせる。`userId`（採番された不透明値）を出してよいのは**認証済み経路のログだけ**である。
  - **例外は1つだけで、パスワードリセットトークンに埋め込む世代と bucket index である**（第6.1節 (d)）。トークンは URL で運ばれるので (c) の原則の明示的な例外になる。理由と漏れる情報量は同節に書いた。

**非露出の範囲には運用面も含める。** DO の名前は `ctx.id.name` で DO の内側から可読であり（第2.1節 F-6）、さらにダッシュボードの Metrics タブを「an individual Durable Object's ID or name」で絞り込めるようになっている（同 F-25）。つまり生クレデンシャルを DO 名に使うと、ルーティング経路の外側（運用画面）にも露出する。これは HMAC を使う理由をもう1つ増やす。

#### 5.2.1 canonical 化の定義 ［派生］

canonical 値の規則を定めないまま HMAC 分割をすると、1バイト違う正規形が別の bucket に落ち、「重複アカウントが例外の出ない形で2つできる」という検出しにくい破れ方をする。規則を確定させる。

- **(a) 正規化手順（メール）** — 検証と正規化の順序も含めて確定させる。**`trim()` → 構造チェック（下記）→ 最後の `@` で local 部と domain 部に分割 → local 部の非 ASCII 検査（下記）→ local 部を lowercase 化 → domain 部を NFKC 正規化して lowercase 化し、非 ASCII を含む場合は punycode（IDNA、ASCII 形式）へ変換 → `local + "@" + domain` に再結合 → 長さ上限の再チェック。**
  - **NFKC は domain 部にだけ掛ける。local 部には掛けない。** NFKC は互換等価な文字を畳むので、全角英数（`U+FF41` 等）・合字（`ﬁ` → `fi`）・上付き文字が別の文字列に変わる。ところが **SMTP の local 部はオクテット単位で不透明であり、`ａｂｃ@example.com`（全角）と `abc@example.com` は別のメールボックスである。** 一方、原本として保持するのは canonical（＝正規化後の値）だけであり（第6.2.1節 (a)）、第7.6節のメール送信ジョブはその復号結果を宛先に使う。したがって local 部に NFKC を掛けると、**利用者が打鍵した実アドレスが復元不能になり、リセットメールが正規化後の別アドレスへ送られる。** signup にメールアドレスの所有確認が無い（下記）ので、この取り違えはそのまま「A のアカウントのリセットリンクが B のメールボックスに届き、B が A のアカウントを乗っ取れる」経路になる。本節 (c) が SSO subject について「provider 由来の opaque 値なので正規化すると provider 側の同一性判定とずれる」と判断したのとまったく同じ理屈が、配送側の同一性判定に対しても成立する。
  - **local 部に非 ASCII（`U+0080` 以上）を含む入力は `BusinessRuleError(InvalidEmail)` で拒否する。SMTPUTF8 には対応しない、を設計の制約として宣言する。** 正規化しない方針と両立する唯一の形がこれである — 正規化せずに受け入れると `ａ` と `a` が別アカウントになり、利用者が自分のアドレスを取り違える。拒否すれば、日本語 IME で全角のまま打鍵する事故が**登録される前に**利用者へ返る。検証点は `EMAIL_PATTERN` と同じ `Email.create` の中（構造チェックの拡張）で、transport 境界ではない。
  - **local 部の lowercase 化は残す。ただしこれは「NFKC を退けた論拠が当てはまらない」からではなく、明示的な受容判断である。** RFC 5321 上 local 部は大文字小文字を区別しうるので、**上の3つの論拠（オクテット単位の不透明性 / 打鍵形の復元不能 / 所有確認が無いための乗っ取り経路）は lowercase 化にも形式的にはそのまま当てはまる**。区別するプロバイダに `Foo@example.com` の利用者が居れば、リセットメールが `foo@example.com` へ誤配送されうる。それでも lowercase を残すのは、**区別しない側に揃っている実運用のプロバイダ実装のもとでは、区別する設計が `Foo@example.com` と `foo@example.com` で重複アカウントを作り、しかも利用者が自分のどちらのアドレスで登録したか分からなくなるという、より頻度の高い害を生む**からである。**頻度の低い誤配送リスクを受容し、頻度の高い重複アカウントを避ける、という選択である。**
    - **NFKC との非対称が成立する理由も書く。** 全角 / 合字は日本語 IME の事故として**利用者が意図せず打鍵しうる**のに対し、大文字小文字の差は利用者が自分で選んだ表記なので、拒否ではなく畳み込みで扱ってよい。非 ASCII local 部は拒否（上記）、大文字小文字は畳み込み、という非対称はこの違いに対応している。
    - **残余リスク（local 部を区別するプロバイダでのリセットメール誤配送）は第11.3節経由で #38 へ送る。** 現行実装（`packages/core/src/domain/identity/valueObject.ts:47` の `trim().toLowerCase()`）と同じ妥協であり、**本節が実装として変えるのは NFKC の適用範囲だけである。**
    - **代替案（打鍵形を canonical と別に暗号化保持し、配送先には打鍵形を使う）は採らない。** 暗号化列が1つ増えるだけで退会時の削除範囲（第6.2.1節 (d)）と復号許可経路（同 (c)）は流用できるが、**「原本の所在は Directory bucket の1列だけ」という第6.2.1節 (a) の単純さが失われ、2つの列のどちらが配送先かという分岐が第7.6節・第6.8節・第10.1節に波及する**。受容するリスクの大きさに見合わない。
  - **構造チェックを正規化より前に置く。** `@` を含まない入力、local 部または domain 部が空になる入力は `BusinessRuleError(InvalidEmail)` にする。「最後の `@` で分割」は `@` の存在を前提にしているので、先に弾かないと分割が定義されない。
  - **長さ上限 320（RFC 5321 のパス長）は正規化の前後で2回見る。** punycode 変換は文字列を伸ばしうるので、変換前に通っても変換後に超える入力がある。**超過は変換後の値で判定して拒否する。**
  - **メールアドレスの所有確認（verification）が signup に存在しないことを、設計の既知の前提として明記する。** 第6.3節の saga は phase 0〜4 のいずれにも確認手順を持たず、`packages/core/src/application/identity/registerWithPassword.ts` にも無い。したがって**所有の唯一の証明はパスワードリセット経路であり、リセットトークンの安全性（第6.1節 (d)・第6.2.2節 (b)）がアカウント所有の安全性の上限になる。** 所有確認 phase を本 Issue で新設するかは #34 のスコープ外だが、**この前提は #35（画面仕様）と #38（運用ドキュメント）へ引き継ぐ。** 第11.1節「画面仕様として #35 へ送る2件」と第11.3節に行を足してある。
- **(b) `Email.create` を canonical 化の唯一の出所にする。差し替えるのは正規化部分だけで、既存の検証は残す。** 現行の `packages/core/src/domain/identity/valueObject.ts:45-62` の `Email.create` は `raw.trim().toLowerCase()` で正規化したうえで、**`EMAIL_MAX_LENGTH = 320` の長さ上限**（`codePointLength` で判定）と **`EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/` の構造チェック**を持ち、いずれも違反時に `BusinessRuleError(IdentityErrorCode.InvalidEmail)` を投げる。**#37 が置き換えるのは `trim().toLowerCase()` の部分だけであり、長さ上限と構造チェックは (a) の順序に組み込んで維持する。** 構造チェックには **local 部の非 ASCII 拒否が1つ増える**（(a)）。 長さ上限は `CLAUDE.md`「Input validation」の2つの検証点のうち値オブジェクト側の DoS 防御なので落とさない。ドメイン層の変更なので #35（spec 反映）と #37（実装）の両方へ引き継ぐ（第11.1節・第11.2節）。
- **(c) SSO subject は正規化しない。** provider 由来の opaque 値であり、正規化すると provider 側の同一性判定とずれる。適用するのは `trim()` のみ。**provider 名だけを lowercase 化**して `provider + SEP + subject` を canonical とする。**区切り子 `SEP` は単一の `U+0000`（NUL、UTF-8 で1バイト）と確定する。** provider 名は `packages/core/src/domain/identity/valueObject.ts` の `SsoProvider = "google" | "apple"` という閉じた列挙なので `U+0000` を含みえず、区切りは一意に決まる。**本書の本文には生の NUL バイトを埋め込まない** — 埋め込むと `grep` がこのファイルをバイナリ扱いして無言で0件を返し、#35 / #37 が本書を検索して引き継ぎ項目を拾う運用（第11.1節・第11.2節）と、`plan.md` の機械検証が同時に壊れるためである。本書での表記は常に `U+0000` とし、実装コード側でエスケープ表記に落とす。
- **(d) 規則の変更は鍵ローテーションと同格の移行作業である。** canonical 規則を変えると全 mapping の再写像が必要になり、第6.8節と同じ手順を踏む。規則には版番号を持たせ、mapping 行に記録する。

#### 5.2.2 locator 鍵の分離 ［派生］

DO の名前が変われば別オブジェクトであり、データは付いてこない。したがって鍵に依存する locator と依存しない locator を分けないと、鍵ローテーションが**全ユーザーのデータ本体を移送する作業**になる。**2系統に分ける。**

- **(a) `userId` → User Data DO の locator は鍵に依存させない。** `idFromName(userId)` をそのまま使う。**ローテーション対象外。**
  - 論拠は「`UserId` が UUIDv7 だから」ではない。`packages/core/src/domain/identity/valueObject.ts` の `UserId.create` は trim + 空文字チェックのみで、コメントが明言するとおり id フォーマットは `IdGenerator` の責務であり、ドメインは不透明な非空文字列としてしか扱わない。正しい論拠は次の2つである。
  - (i) 値を採番するのは `IdGenerator` であって外部入力ではない。
  - (ii) `idFromName(userId)` に渡す `userId` の出所は**3つしかない** — **署名済みセッション / AI クライアントトークン / OAuth 認可コードの検証結果**、**signup 時に request Worker が `IdGenerator` で毎回新規に採番した候補 `userId`**（**クライアントから受け取らない**。第6.3節 phase 0 で断定）、**Directory bucket の RPC 戻り値として得た `userId`**（login step 5・credential 変更 phase 2 の起点。Directory 側で永続化済みの `credential_mappings.userId` に由来する）である。**3つに共通する性質は「サーバーが採番して永続化した値である」ことで、いずれもその呼び出しの外部入力ではない。** したがって外部入力が `idFromName` に到達する経路が構造的に存在しない（第5.5節の保証）。
- **(b) canonical credential → Directory bucket の locator は世代付き secret で HMAC する。** **ローテーション対象。**

この分離により、**鍵ローテーションの対象は credential 由来 locator に限られ、User Data DO の同一性には一切波及しない。** ローテーションで動くのは Directory bucket 内の mapping 行と、User Data DO 側の reverse locator 記録だけである。

#### 5.2.3 鍵の所有者と世代管理 ［参考］

第3.2節で Worker を request / state に分けたので、**`DIRECTORY_ROUTING_SECRET` の keyring は request Worker だけに配布する**。state Worker（DO class 側）には置かない。

- **keyring のエントリは `{ generation, key, bucketCount }` の3つ組**で、active 1件 + previous 0〜1件を持つ配列である。`bucketCount` を世代のメタデータとして持つのは、previous 世代を引くときの剰余計算（第5.2.5節 (a)）に**その世代の bucket 数**が必要だからである。DO 名 `dir:g{generation}:b{index}` に入っているのは index であって bucket 数ではないので、名前からは復元できない。
- **keyring の構築境界（入れ子への配置・ブランド型・構築時チェック）は第3.2節で固定した。** `generation` の一意性・`active` がちょうど1件・`bucketCount ≥ 1` の3点は構築時に検査し、検査を通した値しか型を得られない形にする。
- lookup は active → previous の順に引く。各世代で「その世代の `bucketCount` で剰余を取る」ため、bucket 数が世代間で違っていても正しく引ける。**読みだけでなく一意性の登録も全世代を見る**（第6.1節 (c)）。
- 再 HMAC が必要なローテーション（第6.8節）は、operator 専用の maintenance 経路（公開ルートを持たない）が request Worker 側で起動する。**ただし再 HMAC の計算そのものは bucket の中で行い、平文 canonical を Worker 境界の外へ出さない。** maintenance 経路は active 世代の鍵を RPC 引数として bucket へ**一時的に注入**し、bucket は受け取った鍵を SQLite にもインスタンスフィールドにも書かずに、その呼び出しの中だけで使って破棄する。
  - **「保持しない」と「一時注入しない」を区別する。** 第3.2節の配布境界が禁じているのは state Worker が routing secret を**バインディングとして保持する**ことであって、operator が明示的に起動した保守経路で鍵が一度だけ引数として渡ることではない。逆の設計（bucket が平文 canonical を request Worker へ返して向こうで HMAC する）を採らない理由は、**全ユーザーのメール平文が bulk で Worker 境界を越えることになり、被害の最大値がこちらのほうがはるかに大きい**からである。鍵1本の一時的な越境と、全 PII の bulk 越境を天秤にかけてこちらを採る。
  - HMAC-SHA-256 は PBKDF2 と違い CPU 予算を圧迫しないので、DO の中で回してよい（第4.8節の対象外）。

Issue の必須要件ではない節なので、詳細な鍵管理手順（保管・ローテーション頻度・監査）は #38 に送る。

#### 5.2.4 location hint / jurisdiction ［参考］

`idFromName()` で作った DO の物理配置は最初のアクセス地点で決まり、後から移せない。`jurisdiction` も ID 生成時にしか指定できない。Issue はレイテンシもデータ居住性も要求していない。

**結論は「今は既定のまま」である**（location hint も jurisdiction も指定しない）。将来変えるならオブジェクトの再作成が必要になる。

#### 5.2.5 ハッシュ衝突の扱い ［派生］

**(a) HMAC 出力の切り詰めは bucket index の導出にだけ使い、識別には使わない。** HMAC-SHA-256 の256ビット出力のうち、bucket index は先頭2バイトを big-endian の整数として読み bucket 数で剰余を取る。**mapping 行のキーには256ビット全長（hex 64文字）を使う。**

**(b) 2段構造を明記する。** bucket index は衝突しうる（多対1の写像なので設計上必然である）。一意性は bucket の中で確定する。

1. bucket index（切り詰め）で bucket DO を選ぶ。**ここでの衝突は正常**。
2. bucket の中で256ビット全長の HMAC をキーに mapping 行を引く。**ここが識別**。256ビットの偶然衝突は現実的に起きない。
3. さらに確実を期す照合が必要な場面（一意性の登録時と鍵ローテーション時）は、暗号化保持した canonical 原本を復号して定数時間比較する（第6.2.1節）。

**固定 bucket 分割では衝突が設計上必然なので、canonical 原本を「持たない」に倒すと一意性の最終確認手段が消える。** これが第6.2.1節で原本を保持する3つ目の動機である。逆に credential 1件 = DO 1個の案（第6.2節 (c)）で HMAC を切り詰めると、衝突は「別人のアカウントに解決する」という認証境界の破れになる — 本設計は (b) を採るのでこの経路は生じない。

### 5.3 未認証リクエスト（login / signup / password reset） ［Issue 要求］

`userId` が確定するまでの解決順序を決める。すべて request Worker が起点になる。

login（パスワード）の手順は次のとおり。

1. 入力を transport 境界で検証し、`Email.create` で canonical 化する（第5.2.1節）。
2. canonical から active 世代の locator を導出して Directory bucket を引く。見つからなければ previous 世代でも引く。
3. bucket は `{ userId, credentialId, passwordVerifier, status, credentialVersion, usedLocator }` を値として返す。`usedLocator` は実際にヒットした行の locator（世代 + bucket index + 全長 HMAC）であり、`credentialId` はその行が持つ**世代非依存の credential 同一性**である（第6.1.2節）。**見つからない場合もダミーの検証材料を返す**（request Worker 側の定数でもよい）。**mapping 行が credential 変更中（`changeState = 'pending'`。第6.5.1節）なら、行が存在しても未登録と同じダミー材料を返す** — 旧検証材料での照合を成立させないためである。
4. request Worker が `PasswordHasher.verify` を実行する（第4.8節）。未登録・SSO 専用・変更中・パスワード誤り・不正形式のいずれでも**同じ計算量を通り、同じ公開エラーを返す**。
5. 成功したら `idFromName(userId)` で User Data DO を引き、**`{ credentialId, usedLocator, credentialVersion }` を渡して次の3つを1回の RPC で確認する。**
   - **(i) アカウント状態が `active` であること。**
   - **(ii) 到達性検査 — `credentialId` が一致する active な行が `credential_locators` に存在すること。** 無ければ拒否する。**照合キーを `credentialId` にする理由は第6.1.2節にある** — `(kind, 全長 HMAC)` は世代依存の値なので、世代非依存の同一性として使うと鍵ローテーション中に破れる。`credentialId` は鍵にも canonical にも依存しないので、**世代を照合条件に含めるかどうかという問い自体が消える**（同じ credential の2世代の行はどちらも同じ `credentialId` を持つ）。一意性の権威は Directory 側にあるので、User Data 側が2行持っても認可は緩まない。これは「Directory に mapping は残っているが User Data 側では解除済み」という孤児 mapping（第6.6節の unlink 手順2と3の間で落ちた場合）を fail closed で塞ぐための検査であり、**Account Home を採らない設計（第3.1節）が成立するための必須条件**である。epoch ガードはここでは効かない — login は新規にトークンを発行する側で、照合対象のトークンがまだ存在しないからである。
   - **(iii) `credentialId` が一致する active な行の `credentialVersion` が、すべて引数の値と一致すること。** step 3 と step 5 の間に credential 変更 saga（第6.5.1節）が完走すると、旧パスワードでの照合が成功したまま新しい epoch を載せた有効なセッションが発行されてしまう。この TOCTOU をバージョン照合で塞ぐ。不一致は拒否し、利用者にはログインのやり直しを案内する。**「すべて」と書けるのは第6.1.1節 (R8) が `credentialVersion` を `credentialId` 単位で管理し、更新を全世代の行へ同時に行うと定めているからである** — 2世代の行が違う値を持つ状態は (R8) の破れなので、そこで fail closed に倒すのが正しい。(R8) が無いと、ローテーション中の credential 変更で片方の世代の行だけが前進し、**恒久的な不一致でログインできなくなる**（第6.9節の締め出し経路一覧に行を足してある）。
   - 3つとも通ったときだけ、現在の `sessionEpoch` を返す。
6. 現在の `sessionEpoch` を署名したセッショントークンを発行する（`typ: "session"`。第5.4節）。
7. **step 4 の照合結果を Directory bucket へ報告する**（`report-login-result`）。成功なら `failedAttempts` を0にリセットし、失敗なら `failedAttempts` を進めて `nextAttemptAllowedAt` を先送りする（第6.2.2節 (a)）。**成功・失敗のどちらでも必ず1回発行し、応答を返す前に完了させる** — 失敗側を非同期にすると利用者が接続を切るだけでカウンタを回避できるので、抑止として機能しなくなる。

**step 5 の中では追加の往復が発生しない。** (i)(ii)(iii) は step 5 で既に叩いている DO の中の2テーブル（`account` / `credential_locators`）を読むだけである。

**ただし login 全体の RPC 本数は3本になる。** 内訳は step 3（Directory の `lookup-credential`）/ step 5（User Data DO の `verify-login`）/ step 7（Directory の `report-login-result`）で、**照合が失敗した場合は step 5 を飛ばして2本**である。初版は「追加の往復は発生しない」を節全体の主張のように書いていたが、それは step 5 の内部についての記述であり、**照合そのものは request Worker で行われる以上（第4.8節）、結果を bucket へ書き戻す往復は原理的に避けられない**。第6.2.2節 (a) が要求する `failedAttempts` の更新経路はこの step 7 である。

**未登録 canonical には試行回数を数える行が無い。** `credential_mappings` 行が存在しないので step 7 は書き込む先を持たず、`lookup-credential` と同じく「行を作らずに成功を返す」しかない（未認証入力で行を作れる設計にすると、それ自体が資源枯渇の攻撃面になる。第6.2節の判断軸 (iv)）。したがって**未登録 canonical に対する試行のスロットルは Directory の責務ではなく、発信元単位の WAF / Rate Limiting Rules（第6.2.2節 (c)）の責務である。** 登録済み / 未登録で応答も処理経路も変わらないことは step 3 のダミー材料が保証しているので、この非対称は列挙オラクルにならない。

**signup** は第6.3節の saga。**password reset** は第6.1節 (d)・第6.5.1節・第7.6節。

**SSO login** は canonical が `provider + U+0000 + subject`（第5.2.1節 (c)）になるだけで、2〜3 と 5〜6 は同じである。到達性検査（step 5 (ii)）は SSO でも同じく効き、これが第6.6節の unlink 順序を正当化する。**ただし step 4（`PasswordHasher.verify`）の代わりに何を検証するかを書かないと、SSO 経路の未認証ガードが未定義のまま #37 へ渡る。3点を断定する。**

1. **IdP アサーションの検証は `lookup-credential` を呼ぶ前に request Worker で完了させる。** 検証項目は ID トークンの署名（provider の JWKS）・`iss`・`aud`・`exp` / `iat`・`nonce`（認可要求時に発行した値との一致）である。**検証が通るまで Directory を1度も叩かない** — 叩くと未検証の subject が locator の材料になり、任意の SSO 主体について mapping の有無を問い合わせる列挙オラクルになる。
2. **canonical に使う `subject` は検証済みアサーション由来の値だけである。** クライアントが POST した値・リダイレクト URL のクエリから読んだ値は使わない。`provider` は認可要求を開始したときにサーバーが選んだ値であり、これも外部入力ではない。
3. **step 5 の (i)(ii)(iii) はパスワード経路と完全に同一である。** アカウント状態・到達性検査・`credentialVersion` 照合の3つとも SSO 行に同じく効く。
   - **応答均一化（step 3 のダミー検証材料）は SSO 行には意味を持たない。** `kind: 'sso'` の行は `passwordVerifier` を持たないので、均一化すべき計算量がそもそも無い。**SSO 経路の未登録 / 登録済みの区別は「均一化」ではなく「未登録なら signup へ倒す」で扱う** — `registerOrLoginWithSso`（`spec/usecases/identity.md`）が示すとおり SSO は login と signup が同じ入口なので、未登録であることは正常な分岐であって秘匿対象ではない。
   - 詳細な OIDC フロー（認可要求の組み立て、state / nonce の保管先、provider ごとの差分）は #12 / #37 へ委譲する。**本節が固定するのは上の3点である。**

### 5.4 MCP / REST（AI クライアント）の認可経路 ［Issue 要求］

**AI クライアントトークンを自己完結型にする。** トークンは `{ typ: "aiClient", userId, connectionId, scope, exp }` を HMAC 署名したもので、検証は request Worker が DB を触らずに行う（セッショントークンと同じ**方式**）。

**鍵は分離する。署名は `AI_CLIENT_TOKEN_SECRET` で行い、`SESSION_SECRET` を流用しない**（第3.2節）。TTL も失効機構も発行契機も違う2種類のトークンを同じ鍵で署名すると、片方の鍵ローテーションがもう片方を巻き添えにする。

**audience タグ `typ` を両方のペイロードに必須で入れ、検証側で厳密一致を要求する。** セッションは `typ: "session"`、AI クライアントは `typ: "aiClient"` で、**欠落は拒否する**。鍵を分けたうえでさらに `typ` を課す理由は、現行の `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` の `parsePayload` が `uid` と `exp` の存在しか見ておらず、ペイロード形状が偶然重なると型混同（token confusion）が実装依存で成立しうるからである。とくに AI トークンは `scope` を持つので、混同は **scope の格上げ**に直結する。鍵分離だけに頼らず、構造でも弾く。

**`scope` はトークンを信頼せず、保存された現在値と突き合わせる。** DO 側のガードは `ai_client_connections` に保存された現在の scope を読み、**トークンの `scope` との積を有効 scope とする**。トークン内の `scope` は「保存値を読む前に明らかに権限外の呼び出しを弾く」早期拒否の最適化としてのみ使う。こうしないと、利用者が「このクライアントを read-only に落とす」操作をしても発行済みトークンが `exp` まで元の scope で通り続ける — 失効（`status`）は全否定にしか効かず、権限**縮小**には効かないからである。`TokenScope` は未実装（第2.3節）なので、ここで決めておかないと #37 がトークン内 scope をそのまま信頼する実装になる。

**AI クライアントトークンの失効経路は epoch ではない。** トークンに `sessionEpoch` を載せないので、`sessionEpoch` を進めても AI トークンには何の効果も無い。失効は次の2つのガードで効く。

| 契機 | 効くガード | 効き方 |
|---|---|---|
| 個別の接続を revoke | `ai_client_connections.status = 'revoked'` | 次のリクエストで DO 内のガードが読んで拒否 |
| 退会（`deleting` / `deleted`） | `account.status` | 次のリクエストで DO 内のガードが読んで拒否 |
| パスワード変更（旧パスワードを知っている経路）・SSO link / unlink | **効かない（意図した挙動）** | 下記 |
| **パスワードリセット完了** | `ai_client_connections.createdAtCredentialVersion` | 下記。**前進前の `credentialVersion` で作られた接続だけを自動失効させる** |

**credential 変更で AI クライアント接続を一括失効させない、と断定する。** AI クライアント接続は利用者が接続ごとに発行・失効を管理する独立した認可であり、パスワードを変えたことがその認可の取り消し意思を意味しない。「パスワードを変えたら AI 連携が全部切れる」ほうが利用者の期待から外れる。

**ただし「補償はドキュメントだけ」では侵害復旧として不完全なので、構造的な補償を1つ設計側で決める。** 攻撃者がパスワードを握っている間に AI クライアント接続を1本作れば、被害者がリセットを完走しても攻撃者のアクセスは `exp` まで（または被害者が接続一覧に気づいて個別 revoke するまで）残る。次の2点を置く。

- **(i) `ai_client_connections` に `createdAtCredentialVersion` を1列足す。** 値は接続作成時点の、そのアカウントのパスワード credential の `credentialVersion`（第6.5.1節）である。**パスワードリセット完了に限り、第6.5.1節 phase 2 の同じ `transactionSync` で「`createdAtCredentialVersion` が前進前の現在値と等しい接続」を `revoked` にする。** 同じ DO 内の1列で済み、追加の往復が無い。
  - **通常のパスワード変更（旧パスワードを知っている経路）には適用しない。** リセットは「アカウントの制御を失った」という利用者の申告であり、変更は日常操作である。両者を区別することで、「パスワードを変えたら最近作った連携だけ切れる」という説明のつかない挙動を避けられる。
  - 失効の対象は「前回の credential 変更以降に作られた接続」に限られるので、**長く使っている接続は生き残る**。利用者の期待を壊さずに、攻撃者が持ち込んだ分だけを切れる。
- **(ii) リセット完了画面に「AI クライアント接続の一覧」と「すべて失効」を必須の導線として出す。** (i) が切れるのは1世代分だけなので、それより前に持ち込まれた接続は利用者の判断で切る。画面要件なので #35 の `spec/pages/` へ送る（第5.1節の SSO link 残余リスクへの導線と同じ画面にまとめる）。

**それでも「パスワードを変えても AI クライアント接続は有効のままである」ことは #38 の運用ドキュメントと利用者向け導線（P-13 相当の設定画面）に明記する。** (i)(ii) は補償であって、決定そのものを覆すものではない。

これで `AiClientConnectionRepository.findActiveById(id)` のグローバル引き（第4.3節の行4 / 行8）は**置き換わる** — `userId` はトークンから直接得られるので DO を選べ、DO の中では `connectionId` の `status = 'active'` 判定と `recordUsage` がユーザー境界の内側に閉じる。ポートの署名からは `userId` が落ちるが、それは第4.5節の読み替えのとおりである。

Directory に token → userId の写像を持つ案は採らない。理由は (i) 認証済みリクエストのホットパスに Directory への往復が1本増える、(ii) Directory bucket が AI API の全リクエストを受けることになり 1,000 req/s の soft limit に近づく、の2点である。

#### 5.4.1 セッション / AI クライアントトークンストアの所在 ［派生］

`spec/database/index.md` は認証インフラテーブル（Cookie セッションストア・OAuth 2.1 のアクセス／リフレッシュトークン・認可コード・PKCE 検証子）を「スコープ外」とだけ書き、スキーマが存在しない。一方で同ファイルと `spec/domains/identity.md` は `identity.aiClientRevoked` を「認証アダプターのトークン失効 consumer」が購読して**そのストアを書き換える**と定めている（第4.3節の行21）。3点を決める。

- **(a) トークン → `userId` の解決は Directory に置かず、自己完結トークンにする**（第5.4節）。セッショントークンも同様に自己完結のままである。したがって「トークンストア」として**永続化が必要なのは認可の事実だけ**になり、それは既に `ai_client_connections`（User Data DO）にある。
- **(b) 失効の到達手段は Outbox ではなく、権威の直読みにする。権威はトークンの種類ごとに違う。** セッションは `account.sessionEpoch`、AI クライアントトークンは **`ai_client_connections.status` と `account.status`**（epoch ではない。第5.4節）である。いずれも User Data DO の中にあり、トークンを持ったリクエストは必ずその DO を叩くので、失効は**次のリクエストで即座に効く**。トークン失効 consumer は不要になる（第7.3節）。
- **(c) セッションストアは現行の HMAC ステートレスのままでよい。** 第3.1節・第5.1節のとおり、epoch ガードが「サーバー側失効の手段が無い」を解消するので、セッション行を永続化する必要が無い。

**OAuth 2.1 の認可コードと PKCE 検証子だけは短命な永続状態を必要とする**（**#13「AIクライアント接続（OAuth認可・一覧・失効）」の範囲**。#12「SSO・パスワードリセット」は OAuth 認可を持たない。第4.1.1節）。置き場所は **User Data DO** と決める。**ただし根拠は「`/authorize` で `userId` が確定しているから」ではない。**

- `userId` が確定しているのは `/authorize`（同意画面）までである。**token エンドポイント（`code` + `code_verifier` を POST する交換）はクライアント資格情報だけを持つ未認証リクエスト**で、セッションを持たない。「ログイン済みだから `userId` が確定している」を根拠にすると、token エンドポイントがどの User Data DO を叩けばよいか決まらず、第6章が Directory を必要としたのとまったく同じ構造の問題（`userId` 未確定の経路からの解決）が再発する。放置すると #13 が Directory 側に別の解決表を足す方向へ流れる。
- **正しい根拠は第5.4節と対称である — 認可コードを自己完結値にする。** 認可コードは `{ typ: "authzCode", userId, connectionId, scope, codeChallenge, codeChallengeMethod, redirectUri, exp }` を HMAC 署名した値とし、**token エンドポイントは署名検証で得た `userId` から User Data DO を選ぶ**。これで routing の根拠が「トークンから `userId` が引ける」という第5.4節と同じ形になり、Directory を1つも増やさずに済む。
- **`redirect_uri` をコードのペイロードに含め、token エンドポイントで完全一致を検証する。** 第5.4.1節と第5.1節の表がこのエントリのガードを**完結した集合として**宣言している以上、OAuth の必須検証が列挙から漏れると「宣言された集合が実は完結していない」状態になる。OAuth 2.1 では PKCE が必須なので code interception 自体は `code_challenge` の定数時間比較で塞がれているが、**`redirect_uri` の一致検証はそれとは別の要求**であり、落とすと認可要求時に登録された宛先と交換時の宛先が食い違ってよいことになる。
  - **`/authorize` 側の検証（クライアント登録済み `redirect_uri` との突き合わせ、および認可画面の組み立て）は #13「AIクライアント接続（OAuth認可・一覧・失効）」の領分である。** 本書が確定させるのは「**コードのペイロードに `redirectUri` を載せて署名し、token エンドポイントがそれとの一致を検証する**」という DO 側の要求までで、認可エンドポイントの実装は #13 へ**明示的に委譲する**（第11.1節の #13 への入力に行を足してある）。委譲を書かずに列挙だけを完結集合と宣言すると、#13 と #37 のどちらも自分の担当でないと読む。
- **コード本体の一回性と PKCE の照合は DO の内側で行う。** `code_verifier` から計算した challenge を署名済みの `codeChallenge` と定数時間比較し、コードの `jti` を User Data DO 内の短命テーブルへ記録して二度目の交換を拒否する。**署名だけでは一回性を担保できない**（署名済み値は再送できる）ので、この記録は必須である。
- **このエントリは第5.1節の表にクラス (2)（未認証 bootstrap）の `exchange-authz-code` として載せてある。** token エンドポイントは**未認証リクエスト**なので epoch ガードを通らず、代わりに「署名検証 + `typ: "authzCode"` の厳密一致 + `exp` + `jti` の一回性 CAS + PKCE の定数時間比較 + `account.status = 'active'`」が守る。**`account.status` の照合を落とさない** — 落とすと退会処理中のアカウントに対して進行中の認可フローが完走し、AI クライアントトークンが発行される。表に行が無いとこのガードが未定義のまま #13 / #37 へ流れるので、本文がエントリを導入した以上は表にも足す（第5.1節の更新規則）。
- **署名鍵は `AI_CLIENT_TOKEN_SECRET` を流用し、`typ: "authzCode"` の audience タグで分離する。** 鍵を別に立てない理由は、認可コードの TTL が分オーダーで、鍵差し替えの巻き添えが「進行中の認可フローのやり直し」に留まるからである（セッションと AI トークンを別鍵にした理由 — TTL も失効機構も発行契機も違う — は、認可コードと AI トークンの間には当てはまらない。認可コードは AI クライアントトークンの発行過程そのものである）。`typ` の厳密一致は第5.4節と同じく必須で、欠落は拒否する。

`spec/database/index.md` の「スコープ外」宣言はこの結論に合わせて #35 が見直す（第11.1節）。

### 5.5 他ユーザーの DO を指定させない構造的保証 ［Issue 要求］

「他ユーザーの DO を指定できる入力面を公開しない」ことを、規約ではなく構造で担保する。

1. **locator を「外部入力から」導出する場所を request Worker の1モジュール（DO stub factory）に限る。** ここに `userId` を渡せるのは次の**3経路**に限られる。**3経路に共通する性質は「サーバーが採番し永続化した値である」ことで、列挙が今後増えてもこの性質を満たすかどうかで判定できる。**
   - **(i) `sessionCodec.verify` / AI クライアントトークン / OAuth 認可コード（第5.4.1節）の検証結果。**
   - **(ii) signup で `IdGenerator` が毎回新規に採番した候補 `userId`**（クライアントからは受け取らない。第6.3節 phase 0）。
   - **(iii) Directory bucket の RPC 戻り値として得た `userId`。** login step 5（`lookup-credential` が返した `userId` で User Data DO を引く。第5.3節）、SSO login（同）、パスワードリセット完了（`consume-reset-token` の戻り値から credential 変更 saga へ入る。第6.5.1節）がこれにあたる。**初版はこの経路を数え落としていた** — Directory が返す `userId` は Directory 側で永続化済みの `credential_mappings.userId` に由来し、その呼び出しの外部入力ではないので保証そのものは破れていないが、列挙から漏れると #37 が本項を型・モジュール境界へ落とした時点で login が書けなくなる。
   - **DO 側も `idFromName` を呼ぶが、材料が違う。** state Worker は `USER_DATA` / `IDENTITY_DIRECTORY` の両 binding を持ち（第3.2節）、第6章の saga は DO 間の相互呼び出しを行う。**そのとき使ってよい locator は「呼び出し側の DO が自分の SQLite に永続化済みの locator」だけである** — User Data DO → Directory bucket は `credential_locators` に記録済みの locator、Directory bucket → User Data DO は `credential_mappings` 行が持つ `userId` である。どちらもサーバーが過去に採番・記録した値であり、その呼び出しの外部入力に由来しない。**「導出点は1箇所」を「外部入力からの導出点は1箇所」に言い直す**のが正確であり、第6.4節・第6.5.1節・第6.6節・第6.7節の手順はこの言い直しの下で第5.5節と両立する。
2. **外部入力が locator の材料にならない。** `CLAUDE.md`「Input validation」のとおり、外部入力は transport 境界（`validateSearch` / `inputValidator`）で検証されてから usecase に入る。usecase は DO の**内側**で走る（第8.3節 (a)）ので、外部入力が locator の導出点に到達する経路が構造上存在しない。
3. **URL・フォーム・API パラメータのいずれにも DO 名 / bucket index を出さない**（第5.2節 (c)）。出さないので、書き換えて別の DO を指す攻撃対象面が無い。唯一の例外はパスワードリセットトークンに埋め込む世代 + bucket index で、理由と漏れる情報量は第6.1節 (d) に書いた。**この例外は「出す」だけでなく「未認証入力として戻ってくる」ことを意味するので、locator を導出する前に範囲検査を通す**（第6.1節 (d)）。検査を通らないトークンは **DO を一切叩かずに拒否する** — 叩いてから照合に失敗する形にすると、任意の未認証文字列が新しい DO オブジェクトを起こせてしまい、第6.2節の判断軸 (iv) が無効になる。
4. **DO の中には他ユーザーの行が存在しない。** 万一 locator の導出を誤っても、誤った DO には誤ったユーザーのデータしか無く、「他人のデータを1行だけ読む」という部分的な漏洩は起き得ない。誤りは全件のズレとして即座に顕在化する。
5. **読み取りに効く 4 は書き込みには効かないので、書き込み側のガードを別に置く。** 4 が保証するのは「誤った DO から他人のデータが読めない」ことだけで、「誤った DO に書き込まない」ことは保証しない。したがって **signup の RPC エントリ（`initialize-account`）には「対象 DO に `account` 行が既に存在し、かつその `operationId` の `operations` 行が無いなら拒否する」ガードを置く**（第6.3節 phase 2）。これは 1 が破れた場合の二重の防波堤であり、**1 が成立している限り他人の DO に対しては発火しない** — 他人の DO にはその `operationId` の `operations` 行が存在しないので必ず拒否される。
   - **述語を「`account` 行が既に存在するなら無条件で拒否」にしてはならない。** 初版はそう書いていたが、それは第6.4節が saga の前進規則の前提として要求する「phase 2 は冪等」と正面から矛盾する。phase 2 が commit した後に応答が失われると（DO のリセット / `.overloaded` / `ctx.abort()`。第4.7節）コーディネーターは `sagaCommitted` 印を書けず `resume-signup` が phase 2 を再送するので、無条件拒否だと**永久に前進できず、再試行上限で第6.4節 3 の終端規則が発火して正常に作られたアカウントが `abandon-account` される**。利用者から見ると「登録は成功したのに数分後にアカウントが消える」になる。無条件拒否は `operationId` / `payloadDigest` の比較そのものにも到達しないので、同じセルに並ぶ CAS が死ぬ。**述語は上の条件付きの形だけが正しい。**

## 6. Identity Directory DO ［Issue 要求］

### 6.1 解決責務 ［Issue 要求］

Issue が列挙した4項目を個別に結論づける。第3.1節で Account Home を採らなかったので、委譲先は無く4項目とも Directory bucket が持つ。

- **(a) 正規化メール → `userId`。** bucket 内の `credential_mappings` 行が `{ hmac(64 hex), kind: 'email', userId, generation, status, encryptedCanonical }` を持つ。現行の `UserRepository.findByEmail`（`ADP-identity-004`）を移す形になる。**これは「これから設計する」ではなく「既存実装をどう移すか」である** — `packages/core/src/adapters/d1/migrations/0000_initial.sql` の `users_email_uq` が既に動いているグローバル一意制約であり、それが bucket 内の一意制約へ移る。
- **(b) SSO provider + subject → `userId`。** 同じ `credential_mappings` に `kind: 'sso'` の行として入る。canonical は第5.2.1節 (c) の `provider + U+0000 + subject`。**移すのと書くのが混在する** — `users_sso_identity_uq` の部分ユニーク（`0000_initial.sql` に実在する）は bucket 内の一意制約へ**移す**が、`findBySsoIdentity`（`ADP-identity-005`）は `spec/domains/identity.md` に定義があるだけで実装が1行も無いので（第2.3節）、Directory 側で**新規に書く**。**`kind` が違えば同じ bucket に同居してよい** — 一意性は `(kind, hmac)` で取る。
- **(c) メール・SSO 主体の一意性。** 権威は「その canonical を写像する bucket の中の行」である。同じ canonical は同じ鍵・同じ世代なら必ず同じ bucket に落ちるので、**単一世代のあいだは bucket 内の一意制約がグローバル一意性と等価になり、bucket 間の調整は要らない。** これが固定 bucket 分割を採る最大の利点である（第6.2節）。
  - **鍵ローテーション中はこの等価が成立しない。世代間の調整は要る。** 読み経路（login。第5.3節 step 2）は active → previous の順に2世代を引くのに対し、素朴に組んだ書き経路は active 世代の locator しか導出しない。第6.8節のローテーションは 256 bucket をチェックポイント走査する長時間の保守作業なので、この窓は現実に数時間〜数日オーダーで開く。**その間、previous 世代にしか行が無い canonical に対する signup / SSO link が成功してしまう** — 既存利用者のメールアドレス・SSO 主体で第三者がアカウントを作れ、login は active を先に引くので以後は後発アカウントが解決先になる（正規利用者は自分のアドレスでログインできなくなる）。第6.7節（退会）は「ローテーション中は両世代に行が存在しうる」を既に見ているのに、一意性の登録側だけが見ていなかった。
  - **したがって一意性の検査は keyring に載っている全世代に対して行う。具体は「previous 世代は読むだけ、書くのは active 世代だけ」の2段である。**
    1. **previous 世代が keyring に載っている間は、previous 世代の locator を導出して bucket を読み、その canonical の行が存在しないことを確認する**（`check-previous-generation`。第5.1節のクラス (3)）。存在すれば `ConflictError` で敗北する。
    2. **active 世代の bucket に予約を取る**（第6.3節 phase 1 / 第6.6節 link 手順2）。
  - **previous 世代にトゥームストーンを書く必要は無い。ただし根拠は「previous 世代の行に書き込みが起きないから」ではない。** 正しい根拠は **previous 世代の bucket に新しい canonical が登録されることは無い**（登録は常に active 世代。上の2段規則）ことである。ローテーションの移送は「新世代へ書いてから旧世代を消す」順序なので両世代とも不在になる窓が存在せず（第6.8節 手順2）、削除された時点でその canonical は active 世代へ移っている。したがって 1 をすり抜けた競合は必ず 2 の一意制約が捕まえる。**読み1回で足りる**ので、saga が補償すべき相手（＝書き込んだ DO）は増えない。
    - **初版は根拠を「previous 世代の行に対して起きる書き込みはローテーションによる削除だけである」と書いていた。これは事実として誤りである。** previous 世代の**既存行**に対しては、credential 変更 saga の phase 1 / 3（第6.5.1節）・`report-login-result` の `failedAttempts` / `nextAttemptAllowedAt` 更新（第6.2.2節 (a)）・`lastResetRequestedAt` 更新（同 (b)）・リセットトークン行の発行と削除（本節 (d)）が起きる。**本節自身が「この窓は現実に数時間〜数日オーダーで開く」と見積もっている以上、これらの同時発生は例外ではなく通常事象である。** 誤った根拠は「移送中の行に何も起きない」という前提を設計の視界から外し、鍵ローテーションと credential 変更 saga・signup 予約の相互作用を未設計のまま残していた。**扱いの規則は第6.1.1節に集約する。**
  - **代償は「previous 世代がある間だけ signup / link に Directory への RPC が1本増える」ことだけである。** 単一世代の平常時はゼロである。**ローテーション中は signup / link を止める、という運用回避は採らない** — 止める期間が数時間〜数日になるうえ、止め忘れが一意性の破れに直結するからである。
- **(d) パスワード認証・パスワードリセットで必要な認証情報の所有境界。** **Directory bucket が持つ。**
  - パスワードの検証材料（現行の `users.password_hash` 相当）は `credential_mappings` の `kind: 'email'` 行に持つ。`userId` 未確定の経路（login / reset）から引く必要があるため、User Data DO には置けない。**照合の計算は request Worker で行う**（第4.8節）。
  - リセットトークンは `password_reset_tokens` 相当を bucket 内に持つ。現行のグローバル UNIQUE（`ADP-password-reset-tokens-001`）は「トークンのハッシュから bucket を引ける」形に変える — **リセットトークンの生成時に、対象 credential の世代と bucket index をトークン本体に埋め込む**。形式は **`{generation}.{bucketIndex}.{random}`** で、世代を含めるのは bucket の DO 名が `dir:g{generation}:b{index}` であり index だけでは DO を特定できないためである（世代を落とすと鍵ローテーション中に発行済みトークンが到達不能になる）。これでトークン単体から bucket を決定でき、全 bucket 走査が不要になる。トークンのハッシュは bucket 内で一意であればよい。
  - **トークンから読んだ `generation` / `bucketIndex` には範囲検査を課す。locator を導出する前に、request Worker の transport 境界で検証する。** 検査は3つ — **(i) `generation` が keyring に存在する世代（active / previous）のいずれかであること、(ii) `bucketIndex` がその世代の `bucketCount` に対して `0 ≤ index < bucketCount` であること、(iii) `{random}` 部が規定の長さと文字種であること。** いずれかを外れたトークンは **DO を一切叩かずに拒否する**。
    - **この検査が無いと第6.2節の判断軸 (iv) が無効になる。** リセット URL は未認証で叩ける経路であり、トークンから読んだ2つの値は**そのまま `idFromName("dir:g{generation}:b{index}")` の材料になる**。ハッシュ照合は bucket の中で行われるので、**照合に失敗する前に DO インスタンスが起きる**。検査が無ければ `dir:g0:b999999999` のような URL を大量に叩くだけで、bucket 数と無関係に新しい DO オブジェクトが無制限に生成される — これは案 (c)（credential 1件 = DO 1個）を棄却した理由そのものの再現であり、生成された DO は `hasStoredData` の有無にかかわらず PITR の durable log を残しうる（第2.1節 F-20）。**第6.2節 (b) の欄「未認証の総当たりでも新しいオブジェクトは増えない」は、この検査があって初めて真になる。**
    - 追加の材料は要らない。`bucketCount` は keyring のエントリが既に持っている（第5.2.3節）。
  - **生のリセットトークンを DB にもジョブ行にも置かない。送信直前に bucket の中で決定的に導出する。** `password_reset_tokens` 行が持つのは `tokenId` と `tokenHash` だけで、**`{random}` 部は `HMAC(IDENTITY_RESET_TOKEN_KEY[tokenKeyGeneration], tokenId)` から導出する**（第3.2節）。`jobs.payload` に載るのは `tokenId` だけである。
    - **`tokenId` は暗号論的乱数由来の128ビット以上の値とする。bucket 内の連番・rowid・時刻由来の値を使わない**（`callerToken`・`credentialId` と同じ採番規則である。第5.1節 (3-b)・第6.1.2節 (C1)）。**この要求が無いと、導出方式の採用によって新しい漏えい方向が開く。** トークンの秘匿部は `{random} = HMAC(鍵, tokenId)` の1点に集約されているので、推測困難性は **`tokenId` の推測困難性と鍵の秘匿の積**になる。`tokenId` を連番で実装すると、**`IDENTITY_RESET_TOKEN_KEY` 単独の漏えいで、`{generation}`（keyring の小さな集合）× `{bucketIndex}`（256 分割なら 0..255）× `{tokenId}`（連番）を全列挙するだけで、その時点の未使用・未期限の全リセットトークンを再現できる**。第5.5節 3 / 本項の範囲検査はこの列挙を止めない（正しい範囲の値を投げるからである）。生トークンのハッシュを保存する素朴な設計には鍵が存在しないので、**この方向のリスクは導出方式に固有のものであり、方式を採る側が明示的に閉じる責任がある。** 第5.2.1節 (a) が「リセットトークンの安全性がアカウント所有の安全性の上限になる」と断定している以上、上限側の前提は数値で固定する。
    - **`tokenKeyGeneration` と、トークン本体が運ぶ `generation` は別の番号体系である。取り違えを防ぐため記号を分ける。** トークン形式 `{generation}.{bucketIndex}.{random}` の `generation` は **routing secret（`DIRECTORY_ROUTING_SECRET`）の世代**であり、範囲検査 (i) が照合する相手も routing keyring である。一方 `IDENTITY_RESET_TOKEN_KEY` の世代は `password_reset_tokens` 行の `tokenKeyGeneration` 列だけが持ち、**トークン本体には載らない**（載せる必要が無い — 検証はハッシュ照合なので導出鍵を要しない。導出鍵が要るのは発行時の1回だけである）。暗号化鍵の世代が routing 世代と独立した番号体系であるのと同じ構造である（第6.2.1節 (b-1)）。**routing 世代で reset-token keyring を引く実装は、routing のローテーションだけでトークン導出鍵が切り替わる（あるいは存在しない世代を引く）ので誤りである。**
    - 理由は2つある。**(i) 外部 I/O は必ず「トランザクションでジョブ行を書く → コミット後に Alarm が拾う」形になる**ので（第7.6節）、素朴に組むと生トークンがジョブ行に載る。ところが `jobs.payload` の制約は「PII を入れない」だけだったので、**`spec/database/index.md:79` が生トークンを保存しない理由として明示している「DB 漏えい時にトークンを使えなくする」がジョブ行の側から無効化される**。**(ii) DO の書き込みは PITR の durable log に30日残る**（第2.1節 F-20）ので、`done` 後に行を prune しても消えない。第7.4節の `payload` 制約は本節に合わせて「PII **および再利用可能な秘密**を入れない」へ広げてある。
    - **DB 漏えい単独でも鍵漏えい単独でもトークンを再現できない。2方向とも成立していることを明示する。** 前者は導出鍵が DB に一切載らないため、後者は `tokenId` が128ビット以上の暗号論的乱数で推測できないためである（上記）。**片方向だけを保証する書き方にしない** — 初版は前者しか書いておらず、後者は本書のどこにも評価が無かった。鍵の世代は `password_reset_tokens` 行が宣言し、世代が退役した時点で未使用トークンは自然に無効になる。
  - **発行済みトークンを無効化する手段を持つ。`password_reset_tokens` 行は対象 credential のキー `credentialId` を持ち、それに対する索引を定義する。** 現行 spec（`spec/database/index.md:77-101`）は `user_id` 列と `prt_user_idx`（用途欄に「ユーザーの既存トークン**無効化**・整理」と明記）を持っており、これを落とすと既存設計からの後退になる。bucket 内では `userId` より credential 単位のほうが自然なので、キーは credential 側に置く。**キーを `(kind, hmac)` にしない理由は第6.1.2節にある** — `hmac` は世代依存の値なので、ローテーション中に previous 世代の bucket で発行されたトークン行を active 世代側の削除要求が取りこぼす。`credentialId` は世代非依存なので、どの bucket にある行も同じキーで引ける。
    - **無効化を発行する箇所は3つで、いずれも同じ `transactionSync` の中で行う。** 第6.5.1節 phase 1（credential 変更の起点。対象 credential の未使用トークンを全削除）/ 第6.6節 unlink 手順3 / 第6.7節 手順3（退会）。
    - **`verifyAndConsume` の使い捨て性（`spec/database/index.md:90`）だけでは塞げない。** 使い捨てが保証するのは「同じトークンが二度使えない」ことだけで、「別のトークンがもう1本ある」ケースには効かない。塞がないと次の経路が開く — 攻撃者がアカウントを乗っ取ってリセットを1回依頼しトークンを保持 → 正規利用者が気づいてパスワードをリセット（`sessionEpoch` 前進・`credentialVersion` 前進・`passwordVerifier` 差し替え）→ **攻撃者の古いトークンが TTL 内なら依然有効なので、もう一度リセットを完走して奪い返せる**。第6.5.1節の後勝ち規則（「別の `operationId` による変更依頼が `pending` 中に来た場合は後勝ち」）が、この上書きを設計として認めてしまっていた。**本書内の自己参照はすべて節番号で行い、行番号では指さない** — 改稿で節が動くと取り残されるためである（第1.1節が「参照先の節は改訂のたびに増減するので件数を書かない」と決めているのと同じ理由）。
  - **鍵ローテーション時、リセットトークン行は移送しない。** 第6.8節の再写像が移すのは `credential_mappings` 行だけである。その credential が新世代 bucket へ移送された時点で、旧世代 bucket に残ったトークン行は対応する mapping を失うので**発行済みリセットトークンは無効になる**。**この断定は `consume-reset-token` のガードに「同 bucket にトークン行の `credentialId` と一致する mapping 行が存在すること」を含めて初めて成立する**（第5.1節の表）。含めないとトークンは普通に消費でき、その後の credential 変更 saga の phase 1 が行の無い bucket で空振りする。**逆に、まだ移送されていない credential のトークンは旧世代 bucket で有効なままでよい** — 行がそこにあるので phase 1 も同じ bucket に着地する（第6.1.1節 (R2)(R5)）。TTL が短い（時間オーダー）ので利用者影響は「リセットをやり直す」だけであり、移送機構を1つ増やす価値が無い。旧世代 bucket に残った行は同 bucket の Alarm が TTL 掃除で消す。#38 の運用手順には「ローテーション開始を告知し、直後のリセット依頼失敗を想定する」を送る。
  - **世代 + bucket index を URL に出すことは第5.2節 (c) の明示的な例外である。** リセットリンクは URL なのでブラウザ履歴・Referer・アクセスログ・メールプロバイダのログに残る。漏れるのは世代番号（運用者にとって既知の小さな値）と bucket index（256 分割なら約 8 ビット）だけで、**canonical との照合には `DIRECTORY_ROUTING_SECRET` が必要なので、鍵を持たない観測者は「どのメールアドレスか」を絞り込めない**。残るリスクは「複数のリセット URL を観測できる立場（メールゲートウェイ、共有端末）で、同じ bucket index を持つ URL 同士の弱い名寄せ」だけであり、これは受容する。**この例外を許さない代替**（独立したルーティングタグを持たせ、bucket 側にタグ → bucket の対応表を置く）は、対応表の置き場所がまた「どの bucket にあるか分からない行」になって振り出しに戻るので採らない。
  - 期限切れトークンの掃除は bucket の Alarm（第7.4節）。

#### 6.1.1 ローテーション中の2世代並存の規則（正本） ［派生］

第6.8節のローテーションは 256 bucket をチェックポイント走査する保守作業なので、**同じ credential が previous 世代の bucket と active 世代の bucket の両方に行を持つ窓が、現実に数時間〜数日オーダーで開く**。この状態を各節が個別に扱うと必ず食い違うので（初版は実際に食い違っており、退会だけが全世代を扱い、unlink・credential 変更・signup 予約はいずれも1世代しか見ていなかった）、**規則を本節に集約する。第6.3節・第6.4節・第6.5.1節・第6.6節・第6.7節・第6.8節は本節を参照し、規則を各節で言い直さない。**

- **(R1) 新規登録は必ず active 世代に取る。previous 世代は読むだけである。** signup phase 1（第6.3節）と link 手順2（第6.6節）は previous 世代を `check-previous-generation` で読んで不在を確認し、予約は active 世代の bucket に取る（第6.1節 (c) の2段規則）。
- **(R2) 既存行への更新は「行が実在する世代」へ向ける。active に行が無く previous にあるなら、previous の行が正本である。** 対象は credential 変更 saga の phase 1 / 3（第6.5.1節）・`report-login-result` の `failedAttempts` / `nextAttemptAllowedAt`（第6.2.2節 (a)）・`lastResetRequestedAt`（同 (b)）・リセットトークン行の発行と削除（第6.1節 (d)）である。**「active 世代の locator しか導出しない書き経路」を書いてはならない** — 移送されていない利用者の書き込みが、行の無い bucket へ着地して黙って空振りする。
- **(R3) 削除は全世代・全 bucket を対象にする。対象の選択キーは `credentialId` である。** unlink（第6.6節）・退会（第6.7節）・signup の敗者補償と終端規則（第6.4節）はいずれも、`credential_locators`（または `operations.targetLocators`）から**対象 `credentialId` の全行**を引いて、その全世代分の locator に対して削除を発行し、**「無ければ成功」の冪等操作**にする。「1世代・1 bucket だけを消す」手順は本設計に存在しない。**キーを `(kind, hmac)` にしてはならない** — `hmac` は世代依存なので、世代ごとに違う値になり「同じ credential の別世代の行」を突き合わせられない（第6.1.2節）。
- **(R4) ログイン手段の数え方は行数ではない。** `credential_locators` は同じ credential について2世代の行を持ちうる（(R6)）うえ、SSO signup が置くメール予約行のように**ログイン手段として成立しない行**も持つ（第6.3節。SSO 専用ユーザーの行数は常に2である）。**数えるのは `usableForLogin = true` かつ active な行の distinct な `credentialId` の個数である**（第4.1.1節・第6.6節 unlink 手順1）。**`(kind, hmac)` で distinct を取ってはならない** — 2世代の行は `hmac` が違うので distinct 2件と数えられ、ローテーション中の SSO 専用利用者が自分を締め出せる（第6.1.2節・第6.9節）。
- **(R5) locator 解決の出所は4つに限る。初版は3分類で、SSO link を (ii) に誤って含めていた。** **(i) 未認証経路**（login / signup / リセット依頼）は canonical から active → previous の順に導出する。**(ii) 認証済み経路のうち既存 credential を対象にするもの**（パスワード変更 / unlink / 退会）は `credential_locators` に永続化済みの行から `credentialId` で引く。**(iii) 認証済み経路のうち新しい credential を登録するもの**（SSO link。第6.6節 手順2）は**検証済み IdP アサーション由来の canonical から導出する** — link の対象はまだ `credential_locators` に無い credential なので (ii) では手順が決まらない。ここで使う `subject` は第5.3節 SSO 経路 2 のとおり**検証済みアサーション由来の値だけ**で、クライアントが POST した値・リダイレクト URL のクエリから読んだ値は使わない。**(iv) リセット完了**はトークン本体が運ぶ `{generation}.{bucketIndex}` から取る（第6.1節 (d)）。**(ii) が canonical から locator を導出することは無い** — その経路のリクエストはそもそも canonical を持たず（メールアドレスは送られてこない）、原本は bucket の中で暗号化されている（第6.2.1節 (a)）。導出しようとすると復号平文を request Worker へ運ぶことになり、第6.2.1節 (c) の「平文を持ち回らない」制約を破る。**(iii) にはこの論拠が当てはまらない** — link の起点では検証済みアサーション由来の `subject` が request Worker の手元にあり、canonical が**存在する**からである。
- **(R6) 進行中の saga を跨いで行を移送しない。** `changeState = 'pending'` の行と `status = 'reserved'` の行は移送対象から外す（第6.8節 手順2）。**移送は「行の所在」と「その行を前進させるジョブの所在」を引き剥がす** — `resume-credential-change` は phase 1 を書いた bucket の `jobs` にあり、`resume-signup` はコーディネーター bucket の `jobs` にあるが、第6.8節 手順2 が移すのは `credential_mappings` 行だけだからである。引き剥がすと phase 3 が永久に走らず、**旧新どちらのパスワードも通らない状態が恒久化する**。スキップした行は `previousCount` に残るので、退役条件（全 bucket で `previousCount = 0`）が自動的に再走査を要求する。
- **(R7) 移送は移送元・移送先の両側を CAS で守る。「移送先への書き込み」には前進（(2) の書き込み）だけでなく巻き戻しの破棄も含む。** 移送先の前進は (R9) の新旧比較、移送元の削除は「読み出し時のスナップショットと一致する場合にだけ消す」、**移送先の破棄は「(2) が書いたスナップショットと全列が一致する場合にだけ消す」**である（第6.8節 手順2）。片側だけを守ると、移送の窓に入った書き込みが黙って巻き戻る。
  - **(R6) はこの窓を塞がない。** (R6) が `pending` 行を移送対象から外すのは**読み出し時点**の判定であり、**(2) が移送先に行を書いた後は active 世代の lookup がそちらにヒットするので、そこへ新しく `changeState = 'pending'` が着地する窓が開く**（第6.5.1節 phase 1 / `report-login-result` / `lastResetRequestedAt`）。したがって移送先の破棄を無条件にすると、(R6) を守っていても credential 変更の中間状態が壊れる。
  - **`credential_locators` 側（(1) が追加した行）は「破棄しない」に倒す。** (R8) の単調非減少 upsert により値が正本以上に保たれ、到達性検査が `credentialId` だけを見るので、余分な世代行は認可を緩めない（第6.8節 手順2）。CAS を持てない破棄を残すより、残すほうが規則が1つ減る。
- **(R8) `credential_locators` の `credentialVersion` / `usableForLogin` / `label` は `credentialId` 単位で管理し、更新は常にその credential の全世代の行へ同時に行う。** (R3) が削除について定めているのと対になる、**更新側の規則**である。具体は2点。
  - **`credentialVersion` は `credentialId` 単位で単調非減少である。** `record-credential-locator`（冪等キー `(credentialId, generation)` の upsert）は、**引数の値とその `credentialId` の既存行が持つ最大値のうち大きいほうを、全世代の行へ書く**。行の新規追加も既存行の更新もこの1規則に従う。第6.5.1節 phase 2 の前進も「`credentialId` が一致する全世代の行を1つ進める」である。
  - **`usableForLogin` / `label` は引数の値で全世代の行を上書きする**（単調性は要らない。判定するのは Directory 側である。第6.3節 phase 4）。
  - **この規則が無いと何が壊れるか。** (i) rotation の (1) が新世代の locator 行を追加した直後に credential 変更が走ると、phase 2 が「当該行」1行だけを進めて新世代行が取り残され、(4) が旧世代行を消した時点で **Directory 側 n+1 / User Data 側 n の恒久不一致**になる（第5.3節 step 5 (iii) が永久に落ちる）。(ii) 逆に rotation のチャンクが古いスナップショットで (1) を実行すると、新世代行に古い `credentialVersion` が書かれて同じ不一致になる — 単調非減少にすることで塞ぐ。(iii) `record-credential-locator` を「既存行があれば何もしない」no-op にすると、rotation の (1) が常に空振りして (4) の後に `credential_locators` が空になり、**到達性検査が移送済みの全利用者を締め出す**（第6.9節）。**したがって upsert であることと単調非減少であることの両方が必須である。**
- **(R9) 2世代に行が並存する状態では `credentialVersion` が大きい側が正本であり、移送は必ず正本の側へ収束させる。** 第6.8節 手順2 の (2) は「移送先に行が無ければ書く / あって `credentialVersion` が移送元のほうが大きければ移送元のスナップショットで上書きする / 移送先のほうが大きければ移送先が正本なので触らず移送元を消すだけ / 等しければ何も書かない」である。**「行があれば書かない」だけに倒すと、移送先が陳腐化する方向が無防備になる** — (2) の後・(3) の前で中断し、その間に旧世代 bucket 宛の発行済みトークンでリセットが完走すると、再実行が移送先の古い行をそのまま正本にして**旧 `passwordVerifier` が復活する**（リセットで設定した新パスワードが黙って捨てられる）。移送元 CAS は「そのチャンクの読み出し値と一致するか」しか見ないのでこれを救わない。

**本節の規則が塞いでいる失敗モードを明示する。** (R2) と (R5) が無いと、ローテーション中のパスワード変更が移送元の行に着地し、移送先だけの CAS では守れない（**旧パスワードの復活**）。(R6) が無いと、進行中の credential 変更が phase 3 に到達できず**恒久ロックアウト**になる。(R7) の「移送先の破棄も CAS で守る」が無いと、移送の巻き戻しが**移送先に着地済みの credential 変更の中間状態**（`changeState = 'pending'` / `pendingVerifier`）を消し、Directory 側 n / User Data 側 n+1 の恒久不一致で**ログイン不能**になる。(R3) と (R4) が無いと、unlink が**自己ロックアウト**と**解除済みクレデンシャルでのログイン**を同時に成立させる。(R8) が無いと、ローテーション中の credential 変更が `credential_locators` の片側の世代だけを進めて**恒久ログイン不能**になる。(R9) が無いと、移送先の陳腐化を経由して**旧パスワードが正本に戻る**。いずれも第6.9節の締め出し経路一覧に行として登録してある。**(R8) と (R9) は対で入れる必要がある** — 片方だけを直すと失敗モードが「旧パスワード復活」と「恒久ロックアウト」で入れ替わるだけである。

#### 6.1.2 `credentialId` — 世代非依存の credential 同一性（正本） ［派生］

**`hmac` は世代依存の値である。** locator の全長 HMAC は `HMAC-SHA-256(DIRECTORY_ROUTING_SECRET[generation], canonical)` の出力なので（第5.2節 (b)・第5.2.5節 (a)）、**同じ canonical でも世代が違えば `hmac` の値は違う**。ところが第6.1.1節の規則群は「同じ credential の別世代の行を突き合わせる」ことを繰り返し要求する — (R3) の削除対象の選択、(R4) のログイン手段の数え上げ、(R8) の全世代更新がいずれもそれである。**`(kind, hmac)` を世代非依存の同一性として使うと、これらがすべてローテーション中に破れる。**

**したがって世代非依存の識別子 `credentialId` を1本立て、突き合わせのキーはすべてこれにする。本節がその定義の正本である。**

- **(C1) 値は `IdGenerator` が採番する128ビットの不透明値である。** canonical からも鍵からも導出しない。`callerToken` とまったく同じ扱いで、**採番点は request Worker である**。
  - **signup**: phase 0 で `operationId` / 候補 `userId` / `callerToken` と同時に、**credential ごとに1つ**採番する（第6.3節）。SSO signup は SSO credential とメール credential で別の値になる。
  - **SSO link**: 起点が認証済みリクエストなので、request Worker が `operationId` と同時に新しい `credentialId` を採番し、第6.6節 手順1 の引数で渡す。
  - **鍵ローテーションの移送**: 行ごと引き継ぎ、**再採番しない**（第6.8節 手順2）。これが「世代非依存」の実体である。
- **(C2) 世代に依存しないことの根拠。** 値の生成に `DIRECTORY_ROUTING_SECRET` も canonical も入らないので、**routing 世代が変わっても値が変わる理由が構造的に存在しない**。第5.2.2節 (a) が `userId` について「鍵に依存しない locator を分離する」と決めたのとまったく同じ理屈を credential 側に適用したものである。**canonical 化規則の変更（第5.2.1節 (d)）にも耐える** — 規則を変えると `hmac` は全件変わるが `credentialId` は変わらないので、再写像が `credential_locators` の突き合わせを壊さない。
- **(C3) 置き場所は3テーブルである。**
  - **`credential_mappings`（Directory）** — 予約行が採番された値を受け取り、以後その行が持つ。**bucket 内 UNIQUE の索引を張る** — DO 名 `dir:g{generation}:b{index}` が世代を含むので1 DO の行は常に同一世代であり、同じ bucket に同じ `credentialId` の行が2つ並ぶ状況は構造上発生しない（第4.1.1節）。`(credentialId, generation)` の UNIQUE も残してよいが実効は同じである。
  - **`credential_locators`（User Data DO）** — **一意性を `(credentialId, generation)` で取る**。到達性検査・ログイン手段の数え上げ・削除対象の選択・`credentialVersion` の更新はすべてこの列をキーにする。
  - **`password_reset_tokens`（Directory）** — 対象 credential のキーとして持ち、索引を張る。credential 変更 / unlink / 退会による一括無効化がここから引く（第6.1節 (d)）。
- **(C4) `hmac` は落とさない。役割を分ける。** `hmac` は**その世代における locator の材料**であり続ける — bucket index の導出（第5.2.5節 (a)）、bucket 内の一意性の権威（第6.1節 (b)(c)）、未認証経路での canonical → 行の解決（第5.3節 step 2）はいずれも `hmac` でしか書けない。**`credentialId` が置き換えるのは「世代をまたいで同じ credential を指す」用途だけである。** `credential_locators` に `(kind, hmac, generation)` の UNIQUE も残すのは、同じ canonical が2つの `credentialId` を持たないことを保証するためである。
- **(C5) UI への露出。** 設定画面のクレデンシャル一覧に出すのは **`credentialId`（不透明）・`kind`・`label`** の3つだけである。`label` は `kind = 'sso'` なら provider 名（`google` / `apple`。第5.2.1節 (c) の閉じた列挙なので PII ではない）、`kind = 'email'` なら空文字である。**SSO subject もメールアドレスも出さない** — メールアドレスの表示は `read-own-canonical` の1件復号経路（第6.2.1節 (c) 4）が別に担う。**一覧には `kind = 'email'` の行も出すが、解除操作を出してよいのは `kind = 'sso'` の行だけである**（第6.6節 unlink 手順1 (1-a)。権威は DO 側にあるので UI の出し分けは二重の防波堤であって単独の守りではない）。unlink は `credentialId` を指定して発行する。**これが無いと「Google の連携を解除する」という操作が対象行を特定する経路が設計上どこにも無くなる** — 第11.1節が `getCurrentUser` に `provider` / `providerSubject` を返させない現行の期待を維持すると決めているので、UI が持てる材料はこの3つだけである。
- **(C6) `encryptedCanonical` の AAD が束縛するのは `(kind, credentialId, encryptionGeneration)` であり、`hmac` は含めない**（第6.2.1節 (b-2)）。**これにより移送で AAD が変わらず、再暗号化が不要になる。** 詳細と、付け替え防止が維持される理由は同節に書く。

### 6.2 分割方式 ［Issue 要求］

3案を4つの判断軸で比較する。

| 判断軸 | (a) 単一グローバル DO | (b) 固定 bucket 数のハッシュ分割 | (c) credential 1件 = DO 1個（DO 名 = HMAC(canonical)） |
|---|---|---|---|
| **(i) 列挙可能性**（ローテーションと retirement 証明） | 対象が1個なので自明 | **bucket の集合が `0..N-1` として構成上既知**。走査できる | **不可能**。DO 名の集合は既存 canonical の HMAC 集合そのもので、namespace を実行時に列挙する手段が無い（第2.1節 F-5）以上、外部に権威ある inventory を別途持たない限り旧世代0件を証明できない |
| **(ii) bucket 数の不変性** | 該当なし | 後から変えられない。**世代 + 再写像で対処する**（下記） | 該当なし（原理的に消える） |
| **(iii) 衝突の意味**（第5.2.5節） | 該当なし | **設計上必然**（多対1）。bucket 内の全長 HMAC で識別が確定する | 切り詰めると**別人のアカウントに解決する**認証境界の破れになる。切り詰めなければ DO 名が64文字になる |
| **(iv) 未認証経路からの DO 生成** | 生成は1個だけ。ただし**未認証トラフィックが1オブジェクトに集中し 1,000 req/s の soft limit と `overloaded`（リトライ禁止）に直撃する** | bucket 数が天井になる。未認証の総当たりでも新しいオブジェクトは増えない。**ただしこれは第6.1節 (d) の範囲検査（トークンの `generation` / `bucketIndex` を locator 導出の前に検証する）が前提である** — 検査が無ければリセット URL 経由で任意の DO 名を引けるので、この欄は (c) と同じになる | **任意の未認証文字列が新しい DO 名を引く**。総当たりが毎回コールドな DO インスタンス化を誘発する |

採るのは **(b) 固定 bucket 数のハッシュ分割**である。

- **(a) を採らない理由**は (iv) — login / signup / password reset の全トラフィックが1オブジェクトに集まり、soft limit を超えると `overloaded` になる。公式がリトライを禁じているので、超過は素直に失敗として利用者に返るしかない。無条件採用はしない。
- **(c) を採らない理由は (i) と (iv) の両方である。** どちらか一方に寄りかからせない。(i) 鍵ローテーションを完了させるには「旧世代の locator が0件である」ことを証明しなければならないが、DO namespace を実行時に列挙できない以上、権威ある locator inventory を別に持たない限り証明できない。inventory を持てば結局それが単一の集中点になり (c) の利点が消える。(iv) 未認証入力が無制限にコールドな DO を起こせる構造は、それ自体が資源枯渇の攻撃面になる。
  - なお **(i) が立脚しているのは「外から namespace を列挙できない」というプラットフォーム事実であって、「DO が自分の名前を読めるか」ではない。** 後者は `ctx.id.name` で可能である（第2.1節 F-6）が、それは (i) の結論を動かさない。

**判断軸 (iv) を User Data DO にも当てる。** (iv) は Directory の分割方式を選ぶためだけの軸ではない — 「未認証入力が新しい DO をいくつ起こせるか」という同じ問いが User Data namespace にも立つ。**当てた結果、signup saga の phase 順を入れ替えた。**

- **入れ替え前**（本節を書いた時点の案）は「User Data DO に operation 行を書く → Directory 予約」だった。これは**メールが既に登録済みかを判定する前に User Data DO を1個作って書き込む**ことを意味し、未認証の POST を N 回投げれば User Data DO が N 個生成される。DO は1個あたり独立した SQLite DB であり、(iv) で「資源枯渇の攻撃面」と評価した Directory 側の対象よりも重い。しかも第6.4節の TTL 掃除が消せるのは `operations` **行**であって、生成された DO オブジェクトそのものではない（`hasStoredData` は残り、PITR の durable log も30日残る。第2.1節 F-20）。
- **入れ替え後**（第6.3節の結論）は「Directory 予約 → User Data DO 初期化」である。**Directory の重複チェックに勝った signup だけが User Data DO を作る。** saga のコーディネーター状態は予約行が持てるので、**phase の入れ替えによって跨ぐ DO の数も補償の相手も増えない**（跨ぐ DO の実数は credential の数で決まる。第6.3節）。
- **それでも「未登録のメールアドレスで N 回 signup を投げる」経路は残る。** 予約に勝ってしまうからである。これは bucket 側の予約行1行の書き込みで済み、User Data DO の生成には至らない（phase 2 で候補 `userId` の DO が作られるが、同じ canonical への総当たりでは予約が1本に収束するので DO も1個に収束する）。異なる canonical を大量に投げる攻撃には**レート制限で対処する**（第6.2.2節）。

**bucket 数と (ii) の扱い。** locator 名は `dir:g{generation}:b{index}` の形にする — **名前に入るのは世代と index であり、bucket 数そのものは名前に入らない。** bucket 数は**世代のメタデータとして keyring のエントリ `{ generation, key, bucketCount }` が持つ**（第5.2.3節）。previous 世代を引くときの剰余計算にその世代の bucket 数が要るので、名前ではなく keyring が持ち場になる。**bucket 数の変更は世代の変更として表現し、鍵ローテーション（第6.8節）とまったく同じ再写像機構で処理する。** これにより (ii) の「後から変えられない」は行き止まりではなくなる。初期 bucket 数は **256** を採る。根拠は (i) Directory を叩くのは未認証経路（login / signup / reset）と SSO リンク操作だけで認証済みトラフィックは通らないこと、(ii) 256 分割なら1 bucket あたりの認証トラフィックが 1,000 req/s の soft limit から十分離れること、(iii) ローテーションの全 bucket 走査が 256 オブジェクトのチェックポイント走査に収まり、Alarm の CPU 予算（第2.1節 F-4）で分割実行できる規模であること、の3つである。

#### 6.2.1 canonical credential の保持と保護 ［派生］

HMAC は一方向なので locator から原本を復元できない。しかし原本が可逆に必要になる動機が**3つ**ある。

1. **パスワードリセットメールの宛先** — `MailSender.sendPasswordResetMail(to: Email, ...)`（`ADP-identity-016`）は生のメールアドレスを要求する。
2. **鍵ローテーション時の再 HMAC** — 新しい世代の locator は canonical からしか計算できない（第6.8節）。
3. **bucket 内の識別の最終確認** — 固定 bucket 分割では bucket index の衝突が設計上必然なので、一意性の登録時に「本当に同じ canonical か」を確定させる最終手段が要る（第5.2.5節）。

**(a) 保持場所: Directory bucket。** `credential_mappings` 行の `encryptedCanonical` として、暗号化した状態で持つ。**User Data DO には複製しない** — 複製すると PII の所在が2箇所になり、退会時の消去範囲と PITR の復旧単位（第10.1節）がどちらも複雑になる。

**(b) 暗号化鍵の所有者と配布境界: `IDENTITY_MAIL_ENCRYPTION_KEY` として state Worker だけに配布する。routing secret とは別鍵にする。** 別鍵にする理由は、routing secret は request Worker、暗号化鍵は state Worker と**配布先が違う**ことである（第3.2節）。用途も違う（片方はルーティング、片方は保存時暗号化）。

**(b-1) 暗号化鍵も世代管理する。ローテーション経路を持たせる。** `encryptedCanonical` は全ユーザーのメールアドレス原本という本システムで最も価値の高い PII なので、「鍵が漏洩したら再暗号化できない」という状態にはしない。

- keyring は routing secret と同じ形の `{ generation, key }` 配列（active 1件 + previous 0〜1件）で、**state Worker だけに配布する**。
- `credential_mappings` 行は `encryptionGeneration` を持ち、**復号は行が宣言した世代の鍵で行う**。routing secret 側の世代（locator の世代）とは**独立した番号体系**である — 2つのローテーションは別々の理由で走るので連動させない。
- 再暗号化は bucket の Alarm ジョブ `kind: 'rotate-encryption'` として回す（第7.4節）。走査・チェックポイント・retirement 証明は第6.8節とまったく同じ「bucket ごとの snapshot 置換」に乗せる — 旧鍵の破棄条件は「同一 `encryptionGeneration` の全 `0..N-1` bucket について `previousCount = 0` の記録が揃っていること」である。
- **再暗号化は bucket の中で完結する**（復号 → 再暗号化とも state Worker 側）。routing secret のローテーション（第6.8節）と違い、Worker 境界を越える値が無い。

(b-2) 暗号方式を確定させる。**AEAD の AES-256-GCM を使う。**

- **nonce は行ごと・書き込みごとにランダムな96ビット**を生成し、**`credential_mappings.encryptionNonce` という独立列**に保存する（第4.1.1節）。使い回さない。**暗号文に連結する形は採らない** — AAD が `(kind, credentialId, encryptionGeneration)` を束縛するので、nonce の切り出し規則を暗号文の形式に埋め込むと、再暗号化ジョブ（`rotate-encryption`）が世代ごとに別の切り出しを持つことになる。
- **AAD に `(kind, credentialId, encryptionGeneration)` を束縛する。`hmac` は束縛しない。** 束縛の目的は、DB 書き込み権限を得た攻撃者が bucket 内で暗号文を別の mapping 行へ**付け替える**こと（「B のメールアドレスを A のアカウントの原本にすり替え、リセットメールを別アドレスへ送らせる」経路）を復号失敗として検出することである。`credentialId` は credential ごとに一意なので、**別 credential の行への付け替えは変わらず検出できる**。検出できなくなるのは「同じ credential の previous 世代の行と active 世代の行のあいだで暗号文を入れ替える」場合だけだが、**その2行の平文は同じ canonical なので入れ替えても何も起きない。**
  - **`hmac` を束縛しない理由は移送である。** `hmac` は世代依存の値なので（第6.1.2節）、AAD に含めると鍵ローテーションの移送で AAD が変わり、**移送された全行の暗号文が復号不能になる**。復号失敗は `SystemError(DataIntegrityError)` に翻訳して fail closed で止める規則なので（下記）、移送完了後に (i) パスワードリセットメールの宛先組み立て（第7.6節）、(ii) 設定画面の自メールアドレス表示（下記 (c) 4）、(iii) **次回のローテーションの再 HMAC**（本節の動機2）が恒久的に壊れる。(iii) が壊れるので1回目のローテーション完了時点で2回目が原理的に実行不能になり、しかも移送直後は誰も復号しないため最初のリセット依頼まで顕在化しない。
  - **したがって移送時に再暗号化しない、と決め切る。** 第6.8節 手順2 は暗号文系の列（`encryptedCanonical` / `encryptionGeneration` / `encryptionNonce`）を**そのまま運ぶ**。代替案（AAD に `hmac` を残したまま移送時に新しい nonce と新しい AAD で再暗号化する）は、平文がその場にあるのでコストは無いが、**再暗号化を `rotate-encryption` ジョブだけの仕事として定義した (b-1) と、2つのローテーションを独立に走らせてよいという第6.8節末尾の断定の両方を崩す**。AAD から `hmac` を外すほうが規則が1つ減る。
- 復号失敗は `SystemError(DataIntegrityError)` に翻訳し、**その行を使う操作を fail closed で止める**（黙って未登録扱いにしない）。

(c) **復号が許される経路を4つに限る。**
1. メール送信ジョブ（bucket の Alarm。第7.6節）— 宛先の組み立てのためだけに復号する。
2. 鍵ローテーションの再写像（第6.8節）— **bucket の中で復号し、同じ bucket の中で再 HMAC する。平文は DO の外へ出ない**（第5.2.3節で routing key を一時注入する形に倒したため）。
3. 暗号化鍵の再暗号化（上記 (b-1)）— これも bucket の中で完結する。
4. **認証済み本人の自己参照** — 設定画面が自分のメールアドレスを表示する経路（`getCurrentUser` 相当）。原本の所在を Directory bucket に一本化した以上、**利用者に自分のアドレスを見せる経路も復号を必要とする**。これを許可経路に入れないと、第11.1節の `spec/testcases/identity/getCurrentUser.md`（`email` を返す）が実現手段を失う。
   - **選択キーを確定させる。引数は `(userId, credentialId, callerToken)` で、行は `credentialId` で引く。** `credentialId` は bucket 内 UNIQUE なので（第4.1.1節・第6.1.2節 (C3)）対象行が最大1行に定まる。**`userId` だけを選択キーにしてはならない** — SSO signup はメール credential と SSO credential の両方に行を置き（第6.3節）、bucket index が衝突すれば同じ bucket に同じ `userId` の行が2つ載るので、**返る値が「自分のメールアドレス」ではなく「自分の SSO canonical（`provider + U+0000 + subject`）」になりうる**。認可は `callerToken` + `userId` で閉じているので穴ではないが、選択キーが無いと実装が決まらない。
     - **呼び出し元（User Data DO）は `credential_locators` の `kind = 'email'` かつ active な行から `credentialId` と locator を引く。** ローテーション中は同じ `credentialId` の行が2世代あるが、**2つの locator は別 bucket を指し、どちらの平文も同じ canonical である**ので、第6.1.1節 (R2) に従って「行が実在する世代」を1つ選べばよい（active 世代を先に試し、対象行が無ければ previous 世代）。
   - **ガードは3つ。** **(i) 呼び出しは `callerToken` の提示を必須とし、bucket は mapping 行の値と定数時間比較する**（第5.1節 (3-b)）。(ii) bucket は `credential_mappings.userId` が**引数の `userId` と一致する行だけ**を復号する。(iii) 返すのは復号結果1件だけで、bulk 復号の口を開けない。
   - **初版は (i) を「呼び出し元は epoch ガードを通った User Data DO に限る（request Worker からは直接呼ばせない）」と書いていたが、これは実装不能な要求だったので撤回した。** **DO 間 RPC には呼び出し元の認証済み識別子が存在しない** — bucket が受け取るのは引数だけで、「呼び出し元が誰か」を検証する材料が無い。しかも同じ要求は第5.1節の「(3) は request Worker からも binding 上は呼べる。それでよい」と正面から矛盾していた。**束縛の実体は `callerToken` である。** 呼び出し元の User Data DO 側は、epoch ガードを通したうえで自分の `account.callerToken` を載せて呼ぶ（この順序は User Data DO 側の規約であって bucket 側の検証ではない）。
   - 平文が Worker 境界を越える点は 1（メール送信）と同じ性質だが、**越える量が1件に限られる**ので第5.2.3節が「全 PII の bulk 越境」を棄却した論拠には当たらない。(i)〜(iii) は同節の「復号結果をログ・エラー・メトリクス・トレースに出さない」「永続化しない」と併せて守る。

いずれも次を守る。**(i) 復号結果をログ・エラー・メトリクス・トレースに出さない**（第5.2節 (c)）。**(ii) 復号結果を永続化しない** — DO の SQLite にも request Worker のいかなる永続領域にも書かず、その呼び出しのスコープを出たら参照を残さない。**(iii) 平文を含む処理はチェックポイントを bucket 単位に閉じる** — 1回の Alarm 起動で複数 bucket 分の平文を同時にメモリへ載せない。

**(d) 退会時の消去範囲。** 退会が完了した時点で `encryptedCanonical` を含む `credential_mappings` 行を**物理削除する**（第6.7節）。bucket 側には何も残さない。非 PII の tombstone は User Data DO 側だけに残す。**削除は `credential_locators` に記録された全世代分を対象にする**。`password_reset_tokens` 行も同時に消す（第6.7節 手順3）。**ただし「何も残さない」は論理的な到達性についての主張であり、物理削除が不可逆になるのは PITR 保持期間（30日）の経過後である**（第6.7節）。

#### 6.2.2 未認証経路の濫用抑止 ［派生］

bucket 分割は**一様分布を前提とした緩和策であって、標的型の攻撃には効かない**。攻撃者は単一のメールアドレスを狙って撃てるので、任意の1 bucket を選んで 1,000 req/s の soft limit へ追い込み `overloaded` にできる。`overloaded` は公式にリトライ禁止（第2.1節 F-19）なので、**その bucket に写像される全ユーザー（256 分割なら約 1/256 = 全体の 0.4%）の login / signup / password reset が停止する**。第6.2節の (iv) が「未認証トラフィックの集中」を単一グローバル DO 案 (a) の棄却理由にした以上、同じ問いが (b) にも返ってくる。**bucket 数を増やしても解決しない** — 攻撃者は同じ canonical を狙うので、常に1 bucket に集中する。3層で抑止する。

- **(a) 認証試行のカウントは `credential_mappings` 行に持つ。** 行に `{ failedAttempts, nextAttemptAllowedAt }` を足し、login の照合失敗ごとに `failedAttempts` を進めて指数的に `nextAttemptAllowedAt` を先送りする。更新経路は第5.3節 step 7（`report-login-result`）である — **照合そのものは request Worker で行われる**（第4.8節）ので、bucket は結果を報告されて初めて知る。**DO 化によって「同じ canonical への試行が必ず同じ bucket の同じ行に集まる」という、カウントに最適な構造が手に入っている** — 共有 DB 時代には無かった性質なので使う。`nextAttemptAllowedAt` 未到達の照合は、第5.3節 step 3 のダミー材料経路へ倒して**成功・失敗の応答を区別させない**（ロックアウトの有無が列挙オラクルにならないようにする）。成功時に `failedAttempts` をリセットする。
  - **この機構はそのまま標的型のアカウントロックアウトに転用できる。天井・減衰・非加算の3点を設計の制約として固定して塞ぐ。** カウンタの単位は canonical credential であって IP でもデバイスでもないので、被害者のメールアドレスを知る攻撃者は誤ったパスワードを投げ続けるだけで `nextAttemptAllowedAt` を先送りできる。素朴に組むと、ロックアウト中の試行もダミー経路へ倒れて「失敗」になるため `failedAttempts` が減らず、正規利用者が正しいパスワードを入れても「成功時のリセット」に到達できない **恒久的な DoS** になる。
    1. **天井を置く。** `nextAttemptAllowedAt` の先送り幅には上限があり、一定時間で頭打ちになる。無限に伸びる指数バックオフは採らない。
    2. **時間減衰を置く。** 最後の失敗からの経過時間に応じて `failedAttempts` を減らす。成功だけがリセットの契機である設計にしない。
    3. **ロックアウト中の試行は `failedAttempts` を進めない。** `nextAttemptAllowedAt` 未到達の照合はダミー経路へ倒すだけで、カウンタに触らない。**これが無いと攻撃者は先送りを無限に更新できる**ので、天井と減衰があっても意味が無くなる。
    - **具体値（天井の秒数、減衰の係数、初期のバックオフ幅）は #38 へ送る。天井・減衰・非加算という3つの存在自体は #38 へ送らず、本節で固定する。**
    - **カウンタは credential 単位だけでは足りない。発信元単位のカウンタは (c) の WAF が持ち、そちらが第一防壁である。** credential 単位のバックオフは「特定アカウントへの総当たりを遅くする」ためのものであって、発信元を止める役割は負わない。
  - **更新先の世代は第6.1.1節 (R2) に従う。** `report-login-result` が渡される `usedLocator` は step 3 が実際にヒットした行の locator なので、previous 世代の行がヒットしたなら previous の行を更新する。**「active 世代の locator を導出し直して書く」実装にすると、移送されていない利用者のカウンタが黙って空振りし、抑止機構そのものが効かなくなる。**
  - **脱出経路を2本残す。** (i) パスワードリセットは `failedAttempts` に影響されない別経路であり、**リセットの完走時に `failedAttempts` を0にし `nextAttemptAllowedAt` を過去へ戻す**（第6.5.1節 phase 3 の同じ `transactionSync`）。(ii) SSO は別 credential なので、その行のカウンタは独立している。**パスワードのロックアウトが SSO ログインを巻き込まない。**
    - **脱出経路 (i) は鍵ローテーション中も成立する。** 成立させているのは第6.1.1節 (R6) — `changeState = 'pending'` の行を移送しないので、phase 3 が触る行は phase 1 が書いた行と常に同じ bucket にある。**(R6) を採らずに pending 行を移送する設計にすると、phase 3 の対象行がその bucket から消えて脱出経路 (i) が同時に壊れ、パスワード単独アカウント（SSO を持たない利用者）の恒久 DoS が残る。** この依存関係は第6.9節の締め出し経路一覧にも反映してある。
- **(b) パスワードリセット依頼は canonical 単位でレート制限する。ただし「ジョブ行を書かない」形では実装しない。** 同じ `credential_mappings` 行に `{ lastResetRequestedAt }` を持ち、一定間隔内の再依頼は**メールを送らない**。初版はこれを「ジョブを投入せずに成功を返す」と書いていたが、それは第7.6節の「mapping が無い場合もジョブ行を書いて即 `done` にする」（＝ジョブ行の書き込みという測定可能な処理時間差を列挙オラクルにしない規則）と**正面から矛盾する**。矛盾を次のとおり解消する。
  - **依頼は常に同じ経路を通る。** mapping の有無・スロットルの有無にかかわらず、(i) 同じ `transactionSync` でジョブ行を1行書き、(ii) 同じ `setAlarm` を発行し、(iii) 同じレスポンスを返す。**違うのは行の中身だけ**で、送らない行は Alarm が拾った時点で何も送らずに `done` へ落ちる（第7.6節）。**登録済み / 未登録 / スロットル中の3ケースで処理経路が完全に一致する。**
  - **未登録 canonical にレート制限の状態を置く場所は無い。置かない、と断定する。** mapping 行が無いので `lastResetRequestedAt` を持てず、そのために行を新設すると**未認証入力で無制限に行を作れる**（第6.2節の判断軸 (iv) と同じ攻撃面）。代わりに **`send-mail` ジョブの `operationKey` を「対象 canonical の全長 HMAC + 依頼の窓」から決定的に導く** — 第7.4節の「同じキーの再投入は既存行に収束する」がそのまま効くので、同じ canonical への連打は登録済み / 未登録のどちらでも**行1本に収束する**。列挙オラクルも生じない。**ただし収束するのは同一 canonical への連打だけであり、異なる canonical を大量に投げる経路ではジョブ行が増え続ける。** その経路の第一防壁は (c) の WAF であって Directory ではない（第7.6節に同じ限定を書いてある）。未登録側の発信元スロットルは (c) の責務である。
  - **このスロットルは被害者の脱出経路を塞がない。** リセットメールの宛先は**常に canonical の所有者**であって依頼者ではないので、攻撃者が依頼を連打しても届くのは被害者のメールボックスである。`lastResetRequestedAt` を更新するのは**実際に送信可能な行として書かれたときだけ**にすると、**窓ごとに必ず1通が被害者へ届く**。したがって被害者は自分で依頼し直さなくても窓の先頭の1通を使える。攻撃者に残るのは「被害者の受信箱を1窓につき1通だけ汚す」ことだけである。
    - 発行される新しいトークンは、第6.1節 (d) の無効化規則により**その credential の未使用トークンを全部置き換える**ので、連打が古いトークンを増やすことも無い。
- **(c) 標的型の `overloaded` は DO の外で止める。** (a)(b) は DO に到達した後の抑止なので、`overloaded` そのものは防げない。**request Worker の手前、Cloudflare の WAF / Rate Limiting Rules を未認証エンドポイント（login / signup / password reset）に当てる**、を本設計の結論とする。**(c) は (a) の天井設計の前提でもある** — credential 単位のバックオフに天井を置ける（＝無限に伸ばさなくてよい）のは、発信元単位の第一防壁がその手前にあるからである。ルールの具体（キー、閾値、窓、チャレンジの出し方）と (a)(b) の具体値（天井・減衰の係数・依頼間隔）は #38 の運用要件へ送る。**「どのレイヤーで当てるか」だけは本 Issue で決着させる** — DO 側で受けてから数える設計に倒すと、数える前に `overloaded` になるという順序で破れるからである。

### 6.3 アカウント作成 saga ［Issue 要求］

DO 間に分散トランザクションは無い（第6.9節）ので、**再開可能な saga** にする。

**跨ぐ DO は2つとは限らない。SSO signup では3つになる。** `spec/usecases/identity.md` の `registerOrLoginWithSso` は `findBySsoIdentity` で SSO 主体を引いたうえで **`findByEmail(email)` によるメール重複検証を必須にしており**、`0000_initial.sql:46,47` の `users_email_uq` / `users_sso_identity_uq` が示すとおりメールの一意性は SSO ユーザーにも掛かる。第6.1節 (c) が「一意性の権威はその canonical を写像する bucket の中の行」と決めた以上、**SSO signup は SSO canonical の bucket とメール canonical の bucket の2つに行を置く**必要があり、両者は別 canonical・別 HMAC なので原則として別 bucket に落ちる。したがって跨ぐ DO は **User Data DO 1つ + Directory bucket 1〜2つ**である。

**複数 bucket を認める。そのうえでコーディネーターを決定的に1つ選ぶ。** 「跨ぐ DO は2つだけ」という初版の断定は撤回する。代替として「signup を1 credential に限る」も採らない — SSO signup のメール一意性を保証する手段が結局メール bucket への行の設置になり、同じ形へ戻るからである。

| phase | 実行場所 | 内容 | 再開可能性 |
|---|---|---|---|
| 0 | request Worker | `IdGenerator` が `operationId` / 候補 `userId` / **`callerToken`**（第5.1節 (3-b)）/ **credential ごとの `credentialId`**（第6.1.2節 (C1)）を**それぞれ新規に採番する**。いずれも**クライアントからは受け取らない**。全 credential の canonical を確定し、locator を安定ソートして**コーディネーター bucket を決める**（下記） | 冪等キーの起点 |
| 1a | **コーディネーター bucket** | previous 世代が keyring に載っている間は previous 世代の bucket を読んで既存行の不在を確認する（第6.1節 (c)・第6.1.1節 (R1)）。そのうえで予約を取る（`status: 'reserved'`、`{ operationId, credentialId, candidateUserId, callerToken, locators[], reservedUntil }` 付き）。**`locators[]` は全 credential の locator 一覧**（要素は `credentialId` + `kind` + 全長 HMAC + 世代 + bucket index）、**`reservedUntil` は予約 TTL の絶対時刻**である（第4.1.1節）。既に active な mapping があれば敗北して `ConflictError("EMAIL_ALREADY_REGISTERED")` 等。**saga のコーディネーター状態はこの予約行が持つ** | 予約行が冪等キーと全 locator を持つ |
| 1b | 残りの Directory bucket | 同じ確認と予約を、`locators[]` の順に取る（`{ operationId, credentialId, candidateUserId, callerToken, coordinatorLocator, reservedUntil }` 付き）。1つでも敗北したら、コーディネーターが `cancel-reservation` で全予約を冪等に削除して saga 全体を敗北させる（phase 2 より前なので巻き戻し） | コーディネーター予約行から再開できる |
| 2 | User Data DO | **`account` 行が既に存在し、かつ同じ `operationId` の `operations` 行（`kind = 'signup'`）が存在しないなら拒否する**（他人のアカウントの DO への書き込み。第5.5節 5）。**`account` 行が無ければ** `operations` に `{ operationId, kind: 'signup', payloadDigest, phase: 'activating' }` を記録し、実データを初期化して（`user_settings` / `account` を書く。**`account.callerToken` は phase 0 が採番した値を引数で受け取って書く**）`account.status = 'active'` にする。**`account` 行があって同じ `operationId` の行もある場合は、`payloadDigest` が一致するなら成功として返し**（no-op。応答喪失後の再送がここに来る。第6.4節）、**一致しないなら `ConflictError`** | phase を読めば再開できる |
| 3 | Directory bucket（全数） | 予約を `status: 'active'` へ昇格する。コーディネーターが自分の行を昇格し、残りへは `activate-reservation` を発行する | 同上 |
| 4 | User Data DO | `operations.phase = 'done'`、`credential_locators` に reverse locator（**`credentialId`** + 世代 + bucket index + `kind` + 全長 HMAC + `credentialVersion` + **`usableForLogin`** + **`label`**）を記録する。冪等キーは `(credentialId, generation)` の upsert である（第6.1.1節 (R8)） | 完了 |

**phase 4 の `usableForLogin` と `label` は Directory 側が判定して運ぶ。** `label` は `kind = 'sso'` なら provider 名、`kind = 'email'` なら空文字である（第6.1.2節 (C5)）。 値は「`kind = 'sso'` であるか、または `kind = 'email'` かつその mapping 行が `passwordVerifier` を持つ」である。**SSO signup がメールの一意性のためだけに置く行は偽になる** — メール予約行は一意性の予約であってログイン手段ではなく、`passwordVerifier` を持たないので第5.3節 step 4 の照合が成立しないからである。この値が無いと第6.6節 unlink の「最後のログイン手段」検査が**SSO 専用ユーザーで常に誤る**（行数が常に2になるので検査を通過し、SSO を外すとログイン手段が0になる）。詳細は第6.1.1節 (R4)。

**signup の重複エラーが公開の列挙オラクルであることを、受容判断として記録する。** phase 1a が返す `ConflictError("EMAIL_ALREADY_REGISTERED")` は、**誰でも未認証で叩ける経路から「そのメールアドレスは登録済みである」を直接返す**。login（第5.3節のダミー検証材料）・リセット依頼（第7.6節のダミージョブ行）・ログ（第5.2節 (c) の未認証経路での `userId` 非出力）に払っている均一化のコストと比べると非対称である。**それでも受容する。** 理由は、重複を秘匿する唯一の実装可能な形が「重複時もメールを送って結果を UI で区別しない」（＝所有確認 phase の新設）であり、**signup にメールアドレスの所有確認が存在しない**（第5.2.1節 (a)）本設計ではその経路そのものが無いからである。所有確認を持たないまま重複を秘匿すると、利用者は「登録できたのかできなかったのか分からない」状態に置かれる。

- **緩和は既に決まっている2つで足りる。** (i) 未認証エンドポイントへの WAF / Rate Limiting Rules（第6.2.2節 (c)）が signup にも掛かる。(ii) 重複判定は canonical 単位なので、列挙には正確なメールアドレスの推測が要る。
- **#35 への文言方針。** 画面には「このメールアドレスは既に登録されています」を出してよい。**秘匿しない、を明示的な設計判断として #35 へ送る**（第11.1節）。所有確認 phase を新設する判断は #34 のスコープ外である（第5.2.1節 (a) と同じ扱い）。

**phase 1 を Directory 予約にし、User Data DO の生成を phase 2 へ下げたのは第6.2節の判断軸 (iv) を User Data DO にも当てた結果である。** 重複チェックに勝った signup だけが User Data DO を作る。

#### コーディネーターの選び方と役割

1. **コーディネーター bucket は「安定ソート後の先頭 locator の bucket」である。** ソートキーは `(kind, 全長 HMAC)` の辞書順に固定し、`kind` の順序は `'email' < 'sso'` とする。**決定的な規則なので、どの主体が計算しても同じ bucket に収束する** — 調停が要らない。
2. **予約は必ずコーディネーターから取る**（phase 1a → 1b）。したがって **1本目の予約が書かれた時点で、この signup の存在と全 credential の locator を知る主体が必ず1つ存在する**。初版は「複数 credential を決定順に予約する」としか書いておらず、**A に書いた直後に落ちると B にはこの signup の痕跡が一切残らない**（A の再開ジョブは B の予約を知らないので、メールが予約されないまま `active` なアカウントが完成しうる）という穴があった。`locators[]` をコーディネーター行に持たせることでこの穴が閉じる。
3. **`resume-signup` はコーディネーター bucket の job table にだけ投入する**（第6.4節）。非コーディネーター bucket は前進を駆動しない。**両方が前進させると phase 3 が bucket ごとに独立して進み、片方が落ちたまま他方が phase 4 まで完走して `operations.phase = 'done'` を書ける**ので、駆動主体は1つに限る。
4. **`sagaCommitted` 印はコーディネーターが全 bucket へ伝播する**（`propagate-saga-committed`。第6.4節 2）。伝播は冪等な RPC で、失敗しても `resume-signup` の再試行で収束する。**印の無い bucket だけ TTL 掃除が先行する**という非対称を、この伝播が消す。
5. **非コーディネーター bucket の予約が孤立した場合**（コーディネーターが敗北したのに敗者補償の前に落ちた場合など）は、`sagaCommitted` 印の無い `reserved` 行として `sweep-reservations` が TTL 経過後に回収する（第6.4節）。

**決定順の予約**（`locators[]` の順に取る）は、複数 credential を同時に登録する signup が互いにデッドロックしないための規則である。ソートが決定的なので、2つの signup が同じ2 bucket を逆順に掴む状況が起きない。

`operationId` と候補 `userId` は**サーバー側でのみ採番し、クライアントから受け取らない**。

- **request Worker はステートレスなのでリクエストを跨いで値を「保持」できない。** したがって「再送では同じ `operationId` を保持する」を成立させる手段は、クライアントに運ばせる（hidden field / `Idempotency-Key` ヘッダ）以外に無い。それを採ると**外部入力がそのまま `idFromName()` の引数になり**、第5.2.2節 (a)(ii) と第5.5節 1 の構造的保証が偽になる。攻撃者が被害者の `userId`（リビジョンの `Actor` や export ヘッダから知りうる）を `operationId` として送れば、未認証のまま他人の User Data DO へ書き込める。**採らない。**
- **したがって「リクエスト跨ぎの再送」という概念を signup に持ち込まない。** ブラウザからの再 POST は**毎回新しい `operationId` と新しい候補 `userId` を採番する**。落ちた saga を前進させるのは第6.4節の Alarm による再開だけである。
- **再送の冪等性は候補 `userId` の再利用ではなく Directory bucket の予約行が担う。** 同じ canonical に対する予約は第6.5節の勝者決定規則で1本に収束するので、再 POST が2つ目のアカウントを作ることはない。**敗北した候補 `userId` の User Data DO はそもそも作られない**（phase 1 で負けるので phase 2 に進まない）。
- **`operationId` を跨リクエストで保持したくなったら、クライアント供給ではなくサーバー導出にする** — `HMAC(SIGNUP_SECRET, canonical)` から決定的に導く形なら外部入力にならない。ただしその値を `userId` に流用すると第5.2.2節 (a)「鍵に依存しない locator」を壊すので、**`userId` には決して使わない**。本設計は前項で足りるためこの機構を採らないが、#37 が必要と判断した場合の唯一許される形として書き残す。

**signup の phase 2 は第5.1節のクラス (2)（未認証 bootstrap）に属する。** epoch ガードの代わりに「`account` 行が存在し、かつ同じ `operationId` の `operations` 行が無いなら拒否」という**条件付きの**ガードと `operationId` / `payloadDigest` の CAS が守る。**この2つは直列に効く** — 前者を無条件拒否にすると後者へ到達しなくなり、phase 2 の冪等性（第6.4節）が失われる。**epoch ガードを通らないエントリは signup 1本ではない** — クラス (2)(3) の全数は第5.1節の表が正本である。

**`ctx.id.name` を前提に配線を組む。** 先行案は「DO に自分の routing key を明示的に渡す」形になっていたが、DO は `ctx.id.name` で自分の名前を読める（第2.1節 F-6）。とくに Alarm ハンドラには名前を渡すクライアントが居ないため、公式が用例として挙げている経路そのものである。

**結論: 明示的に渡すのはやめる。ただし `ctx.id.name` が `undefined` になる4条件（`newUniqueId()` 由来 / `idFromString()` 経由 / 1,024 バイト超の名前 / 2026-03-15 より前に作られた Alarm）に備え、初期化時に自分の locator（`userId` または `dir:g{gen}:b{index}`）を `_meta` テーブルへ1行だけ書き込み、`ctx.id.name` が使えない場合のフォールバックにする。** 第6.8節と第7.4節も同じ判断に従う。

### 6.4 部分失敗と補償 ［Issue 要求］

各 phase の失敗時に何が残り、誰がいつ片付けるかを決める。

**まず cross-DO 操作の全数について「残るもの / 片付ける主体 / 前進か巻き戻しか」を1箇所に並べる。** 初版は signup の phase 表しか持たず、他の操作は各節に散っていたので**抜けが検出できない構造**になっていた（実際に SSO link の前進ジョブが落ちていた）。**新しい cross-DO 操作を足したら、この表にも行を足す。**

| cross-DO 操作 | 中間状態で残るもの | 片付ける主体 / ジョブ | 前進か巻き戻しか |
|---|---|---|---|
| signup（第6.3節） | phase 2 より前: 一部 bucket の `reserved` 行。phase 2 以降: `active` な `account` と未昇格の予約 / 未記録の reverse locator。**phase 3 の部分成功では `credential_locators` に対応行を持たない `active` な mapping** | コーディネーター bucket の `sweep-reservations`（巻き戻し）と `resume-signup`（前進 / 終端）。終端時は `cancel-reservation` + `abandon-account`（下記 3） | **phase 2 の成功を境界に、前が巻き戻し・後が前進。前進不能が確定したら終端（回収してから `deleting`）** |
| SSO link（第6.6節） | 手順3 まで進んで手順4 で落ちると、`credential_locators` に対応行を持たない **`active` な孤児 mapping** | User Data DO の `resume-link` | **常に前進**（手順1 で `operations` に記録した時点で利用者の意図が確定しているため） |
| SSO unlink（第6.6節） | 手順2 まで進んで手順3 で落ちると、User Data からは消えたが Directory に残る mapping | User Data DO の `sweep-orphan-mapping` | **常に前進**（削除の再試行） |
| credential 変更 / リセット完了（第6.5.1節） | phase 1 完了・phase 3 未完了の間は `changeState = 'pending'`（旧新どちらのパスワードも通らない） | Directory bucket の `resume-credential-change` | **常に前進**（旧検証材料は phase 1 で既に無効化されているので巻き戻せない） |
| 退会（第6.7節） | `account.status = 'deleting'` のまま、mapping / `credential_locators` が残る | User Data DO の `finalize-withdrawal` | **常に前進** |
| 鍵ローテーションの再写像（第6.8節） | 同じ credential の行が新旧2世代に並存する / `credential_locators` に2世代の行が並存する / 移送をスキップされた `pending` / `reserved` 行 | **operator の maintenance 経路が駆動する `rotate-remap` チャンク**（Alarm ジョブではない。第6.8節 手順2） | **常に前進**（並存する中間状態でも login は通る。スキップ行は次の走査で拾う。第6.1.1節 (R6)） |

以下は signup の phase 単位の内訳である。

| 失敗した phase | 残るもの | 片付ける主体 | いつ |
|---|---|---|---|
| 1a / 1b の途中 | 一部の credential だけが `reserved`。User Data DO は未生成 | **コーディネーター bucket の Alarm**（予約の期限切れ掃除 `sweep-reservations`）。非コーディネーター側の孤立行も同じ規則で自 bucket の Alarm が消す | 予約の TTL 経過後。述語は `WHERE status = 'reserved' AND reservedUntil < ? AND sagaCommitted IS NULL`（列は第4.1.1節） |
| 2 の途中 | Directory に全 credential の `reserved`、User Data は初期化途中 | **コーディネーター bucket の Alarm** が saga を**前進**させる（`resume-signup`。補償ではなく再開） | 予約の再開間隔経過後。phase 2 は冪等（`account` 行があり同じ `operationId` なら成功として返す） |
| 3 の途中 | 一部の mapping だけが `active` | 同上（前進） | 同上。phase 3 は冪等 |
| 4 の直前 | すべて `active` だが reverse locator が未記録 | 同上（前進） | 同上 |

**規則は「User Data の初期化が完了した時点（phase 2 の成功）以降は前進、それ以前は巻き戻し」である。** 境界をそこに置く理由は、そこが「利用者から見てアカウントが存在し始める」点だからである。それ以前なら黙って消してよく、それ以降は完成させるほうが利用者の期待に合う。

**前進の駆動はコーディネーター bucket に置く。1つに限る。** phase 1a が saga の起点なので、落ちたときに操作の存在と全 credential の locator を知っているのはコーディネーターの予約行だけである（phase 2 より前に落ちた場合、User Data DO はまだ何も知らない）。したがって `resume-signup` ジョブは**コーディネーター bucket の job table にだけ**投入し、その Alarm が phase 1b → 2 → 3 → 4 を前進させる。phase 2 と 4 は Directory bucket → User Data DO の RPC になり、その locator は予約行が持つ `candidateUserId` である（第5.5節 1 の但し書き）。phase 1b と 3 は Directory bucket → 別の Directory bucket の RPC で、locator は予約行の `locators[]` から取る（同じく永続化済みの値である）。**非コーディネーター bucket は `resume-signup` を持たない** — 持たせると同じ saga が2系統から前進し、phase 3 が bucket ごとに独立して進む（片方が落ちたまま他方が phase 4 まで完走できてしまう）。

**予約 TTL 掃除と saga 再開の競合を潰す。** 素朴に組むと次の順序で**ログイン手段を1件も持たない `active` アカウント**（＝到達不能アカウント）が生まれる — phase 2 完了 → 落ちる → 予約 TTL が経過して sweep が `reserved` 行を消す → その canonical を別の利用者が先に取得する → 再開した saga が phase 3 で `ConflictError` に当たり**前進できない**。第10.1節が強調している fail closed 性が、ここでは**利用者のアカウントを永久に閉じる方向**に働く。3段で塞ぐ。

1. **予約 TTL は「saga の再開間隔 × 再試行上限 + マージン」より必ず長く取る。** 予約行の `reservedUntil`（絶対時刻。第4.1.1節）は phase 1a / 1b で `now + TTL` として書く。具体値は #38（第11.3節）だが、**この不等式そのものは設計の制約として固定する**。
2. **phase 2 が成功した時点で、全 bucket の予約行に `sagaCommitted` 印を立てる。** コーディネーターは phase 2 の戻り値を受けて自分の行に同じ `transactionSync` で印を書き、続けて残りの bucket へ `propagate-saga-committed` を発行する（冪等 RPC。失敗しても `resume-signup` の再試行で収束する）。**sweep は `sagaCommitted` 印のある行を消さない。** これで 1 のマージン設定を誤っても掃除が先行しない。**伝播しないと、印の付かない bucket だけで TTL 掃除が先行する**という非対称が残る — 複数 bucket を認める以上、印も全 bucket に届かせる必要がある。
3. **それでも前進できなかった場合の終端を決める。** 印を書く前に落ち、かつ TTL 経過後に別の利用者へ canonical を取られた場合は、再開が `ConflictError` で確定する。そのとき `resume-signup` は**次の2つをこの順で行う**。同時に `terminalReason` を残して poison 化し、**運用へエスカレーションする**（#38）。「黙って到達不能アカウントを残す」だけは選ばない。
   - **(3-i) 先に、自分が作った mapping をすべて回収する。** コーディネーター予約行の `locators[]` を辿り、各 bucket へ `cancel-reservation` を発行して**自分の `operationId` を持つ行を `status` を問わず削除する**（第5.1節）。**`status` を問わないのが要点である** — phase 3 は逐次なので部分成功しうる（コーディネーターが自分の行を昇格した後、`activate-reservation` の途中で落ちる）。
   - **(3-ii) その後で User Data DO の `account.status` を `deleting` へ倒す**（`abandon-account`）。到達不能アカウントは利用者から見て存在しないので消してよい — signup が完走していない以上セッションも発行されておらず、利用者データも空である。回収は退会と同じ経路（第6.7節）に乗る。
   - **順序を「mapping の回収が先」にした理由。** 初版は `deleting` へ倒すだけで、回収を第6.7節の `finalize-withdrawal` に任せていた。**ところが `finalize-withdrawal` は `credential_locators` を唯一の逆引き情報として mapping を消す設計であり（第6.7節 手順3）、`credential_locators` を書くのは phase 4 である。** 終端規則が発火するのは phase 3 の途中なので、**この時点で `credential_locators` は空**であり、回収対象が1件も見つからない。結果としてコーディネーター bucket に **`active` な孤児 mapping** が残り、そのメールアドレス / SSO 主体は**恒久的に再登録不能**になる（次の signup が phase 1 で `EMAIL_ALREADY_REGISTERED` に敗北する）。この孤児は `sweep-reservations`（`status: 'reserved'` の行しか見ない）・`sweep-orphan-mapping`（`operations.targetLocators` は link / unlink 用で signup には書かれない）・`finalize-withdrawal`（上記）のいずれの対象でもない。**第6.6節が SSO link の同じ状態を「その SSO 主体の永久ロック」と呼んで Blocker 級に扱った以上、signup も同じ基準で塞ぐ。** SSO signup は常に2 bucket を跨ぐので（第6.3節）、これは例外的な構成ではなく SSO 登録の標準経路である。
   - **代替案（phase 4 を分割し、phase 3 の各昇格の直後に `record-credential-locator` を発行して `credential_locators` を常に mapping の上位集合に保つ）は採らない。** 不変条件としては強いが、**昇格前に locator を書くと「mapping が `reserved` なのに `credential_locators` に active 行がある」窓が開き、第5.3節 step 5 (ii) の到達性検査の意味（User Data 側の active 行 = そのアカウントが認めたログイン手段）が緩む**。コーディネーター行が既に `locators[]` を持っている以上、(3-i) は新しい情報を必要としない。

「誰がいつ」の実行機構は第7.4節の Alarm ジョブで、**Directory bucket 側にも同じジョブ機構を置く**（第7.4節の結論）。

### 6.5 リトライ時の冪等性 ［Issue 要求］

- **operation key の設計。** `operationId` は **request Worker がリクエストごとに新規採番し、クライアントからは受け取らない**（第6.3節）。**候補 `userId` とは別の値**であり、`operationId` を `userId` に流用しない。DO 側は `operations` テーブルに `{ operationId, kind, payloadDigest, phase, createdAt }` を持ち、**同じ `operationId` に違う `payloadDigest` が来たら `ConflictError` にする**（別の操作の再送を装った上書きを防ぐ）。
  - **`operationId` が同一になるのは「同じ操作を Alarm が再開したとき」だけである。** ブラウザからの再 POST は別の `operationId` になるので、`operations` 行による冪等性はリクエスト跨ぎには効かない。**リクエスト跨ぎの冪等性を担うのは Directory bucket の予約行**（signup）と `credential_mappings` 行の `changeState`（credential 変更。第6.5.1節）である。この分担を取り違えると、リクエスト跨ぎの冪等キーをクライアントに持たせる実装に倒れる。
- **同時競合の勝者決定規則。** 同じ canonical に対する予約が競合したら、**(1) 既に `active` な mapping があればそれが勝つ、(2) 無ければ `operationId` の辞書順最小が勝つ。** 決定的な規則にすることで、どちらの側から見ても同じ結論になり調停が要らない。
- **敗者の冪等補償。** 敗者は自分の `operationId` を持つ行だけを削除する（他人の行には触れない）。**実体は `cancel-reservation` RPC である**（第5.1節。コーディネーター bucket → 各 bucket）。削除は「無ければ成功」の冪等操作にする。敗者が補償の前に落ちても、予約の TTL 掃除（第6.4節）が同じ結果に収束させる。**`cancel-reservation` が `status` を問わないのは第6.4節 3 の終端規則が `active` へ昇格済みの行も回収する必要があるためで、phase 1b の敗北時は対象が `reserved` 行しか無いので挙動は変わらない。**
- **epoch の前進も冪等にする。** パスワード変更・リセット完了・SSO の**解除**・退会は、同じ `operationId` の再送では `sessionEpoch` を**一度だけ**進める。判定は `operations` 行の存在で行う。**この4つが全数であり、正本は第5.1節である。SSO の link は含まない**（第6.6節 link 手順の末尾）。

#### 6.5.1 credential 変更 saga（パスワード変更 / パスワードリセット完了） ［派生］

パスワード変更とリセット完了は「新しい検証材料を Directory bucket に書く」と「User Data DO の `sessionEpoch` を進める」の**2 DO をまたぐ操作**であり、signup / SSO link / unlink / 退会と同格の saga である。順序も補償も決めないと次のどちらかの穴が開く。

- **Directory を先にして落ちる** → 新パスワードが有効なのに**旧セッションが TTL 7日ぶん生き続ける**。リセットは「アカウントが乗っ取られたので取り返す」典型経路なので、攻撃者のセッションが残るのは致命的である。
- **epoch を先にして落ちる** → 正規利用者はログアウトされるが**旧パスワードが通り続ける**。攻撃者が旧パスワードを知っている前提の経路なので、これも塞がらない。

どちらも採らず、**「先に旧検証材料を無効化してから両方を前進させる」順序**にする。

| phase | 実行場所 | 内容 |
|---|---|---|
| 0 | request Worker | `operationId` を採番し、`PasswordHasher.hash` で**新しい検証材料を計算する**（第4.8節。DO の外で回す）。**対象 credential の locator は canonical から導出せず、下記の規則で解決する** |
| 1 | Directory bucket | 対象 `credential_mappings` 行を `{ operationId, pendingVerifier, changeState: 'pending' }` にする。**この瞬間から旧検証材料での login 照合を拒否する**（第5.3節 step 3 がダミー材料経路へ倒す）。**同じ `transactionSync` で、その credential の未使用リセットトークン行を全削除する**（下記）。同時に自 bucket の job table へ `resume-credential-change` を投入する |
| 2 | User Data DO | `operations` に記録し、**`sessionEpoch` を1つ進め**、**`credentialId` が一致する `credential_locators` の全世代の行**の `credentialVersion` を1つ進め（第6.1.1節 (R8)。「当該行」1行ではない — 1行だけ進めるとローテーション中に世代スキューが残って恒久ログイン不能になる）、**`usableForLogin` を Directory 側が判定した値へ更新する**（`pendingVerifier` を持つ以上は真になる。第4.1.1節）。**起点がリセットトークンの消費だった場合に限り、同じ `transactionSync` で `createdAtCredentialVersion` が前進前の値と等しい `ai_client_connections` 行を `revoked` にする**（第5.4節 (i)） |
| 3 | Directory bucket | `pendingVerifier` を `passwordVerifier` へ昇格し、行の `credentialVersion` を phase 2 と同じ値へ揃え、`changeState` を解除する。**同じ `transactionSync` で `failedAttempts` を0にし `nextAttemptAllowedAt` を過去へ戻す**（第6.2.2節 (a) の脱出経路） |

**phase 0 の locator 解決規則を定める。起点によって出所が違う。** 第6.1.1節 (R5) の適用であり、**どちらの起点でも canonical からは導出しない。**

- **(起点 A) パスワード変更（認証済み）。** 手順は3段である。**(A-1) セッションから `userId` を得て User Data DO を叩き（クラス (1)。epoch ガードを通る）、`credential_locators` の `kind = 'email'` かつ `usableForLogin = true` の行を読む。** ローテーション中に**同じ `credentialId` の2世代の行**があれば**両方が返り、以降の手順は両方に対して行う**（先に成功したほうを採る。第6.1.1節 (R2)）。同じ RPC で `account.callerToken` も返す。**(A-2) その locator（`(credentialId, generation, bucketIndex)`）で `lookup-credential-by-locator` を叩き（第5.1節のクラス (2)）、`callerToken` を載せて `passwordVerifier` / `credentialVersion` / `changeState` を得る。** **(A-3) request Worker が `PasswordHasher.verify` で旧パスワードを照合する**（第4.8節）。照合が通った locator が phase 1 の対象であり、**phase 1 の `begin-credential-change` にも同じ `callerToken` を載せる**（第5.1節 (3-d)）。
  - **`lookup-credential-by-locator` を新設した理由。** 既存の `lookup-credential`（第5.1節）は入力が canonical だが、**パスワード変更は認証済み操作なのでリクエストにメールアドレスが含まれず、canonical の原本は bucket の中で暗号化されている**（第6.2.1節 (a)）。`read-own-canonical` で復号平文を取ってきて canonical を再構成する形は、第6.2.1節 (c) の「復号結果を持ち回らない」制約を破るうえ、平文を照合のためだけに Worker 境界へ運ぶことになる。**locator を直接受け取るエントリを足すのが、既存制約のどれも破らない唯一の形である。**
  - **`callerToken` を要求する理由。** このエントリは `passwordVerifier` を返すので、locator を知る主体なら誰でも検証材料を引ける形にはできない。`callerToken` はセッションから引いた User Data DO しか返さないので、束縛は認証済み経路に閉じる（第5.1節 (3-b)）。
- **(起点 B) パスワードリセット完了（未認証）。** locator は**トークン本体が運ぶ `{generation}.{bucketIndex}`** と、`consume-reset-token` が返す `credentialId` から組む（第6.1節 (d)）。範囲検査は locator 導出の前に transport 境界で行う（第5.5節 3）。**旧検証材料の照合は要らない** — トークンの消費そのものが認可である。`consume-reset-token` のガードに「同 bucket にトークン行の `credentialId` と一致する mapping 行が存在すること」を含めるので（第5.1節）、**行の無い bucket でトークンだけが消費されて phase 1 が空振りすることは起きない。**
  - **この起点は `callerToken` を提示できない**（未認証経路なのでセッションが無い）。代わりに `consume-reset-token` が消費したトークン行へ `consumedByOperationId` を記録し、**`begin-credential-change` は「その `operationId` で直前に消費されたトークンが対象 `credentialId` のものであること」を条件にする**（第5.1節 (3-d)）。`consume-reset-token` と `begin-credential-change` は同じ bucket で走るので、照合材料はその場にある。
- **(共通) ローテーション中の世代解決。** 起点 A は `credential_locators` の行が世代を持ち、起点 B はトークンが世代を持つので、**どちらも「行が実在する世代」へ着地する**（第6.1.1節 (R2)）。**「active 世代の locator を導出して書く」実装にすると、まだ移送されていない利用者の変更が行の無い bucket を叩いて黙って空振りする。** さらに第6.1.1節 (R6) により `changeState = 'pending'` の行は移送されないので、**phase 1 が着地した bucket と phase 3 が触る bucket は常に同じである。** この2点が揃って初めて、第6.8節 手順2 の CAS（移送先だけ）では守れない「移送元へ着地した変更」の問題が閉じる。

中間状態はすべて **fail closed** に倒れる。

- phase 1 完了後・phase 3 未完了の間は、**旧パスワードも新パスワードも通らない**。利用者から見れば「リセット処理中」であり、可用性は落ちるが認可は開かない。
- phase 2 完了時点で旧セッションと旧 AI トークン…ではなく**旧セッションだけ**が無効になる（AI クライアントトークンは epoch を持たない。第5.4節）。
- 前進の駆動は **Directory bucket の Alarm（`resume-credential-change`）** である。phase 1 が起点なので、落ちたときに操作を知っているのは mapping 行だけだからである。phase 2 は Directory bucket → User Data DO の RPC で、locator は mapping 行が持つ `userId` である（第5.5節 1 の但し書き）。
- **リクエスト跨ぎの冪等性は `changeState = 'pending'` + `operationId` が担う。** 同じ `operationId` の再開は phase 2 / 3 を何度実行しても同じ結果に収束する。**別の** `operationId` による変更依頼が `pending` 中に来た場合は、後勝ちで `pendingVerifier` と `operationId` を差し替える（利用者が「リセットをもう一度やり直した」ケースが自然に通る）。差し替えても phase 2 の epoch 前進は `operations` 行で一度だけに保たれる。
- **phase 1 で対象 credential の未使用リセットトークンを全削除する。これが無いと後勝ち規則が奪還経路になる。** 攻撃者がアカウントを乗っ取ってリセットを1回依頼しトークンを保持 → 正規利用者が気づいてパスワードをリセット（epoch 前進・`credentialVersion` 前進・`passwordVerifier` 差し替え）→ **攻撃者の古いトークンが TTL 内なら依然有効なので、上の後勝ち規則を使ってもう一度リセットを完走し奪い返せる**。phase 1 の削除がこの経路を閉じる。削除の対象を引く索引と、`verifyAndConsume` の使い捨て性だけでは足りない理由は第6.1節 (d) に書いた。

**login の TOCTOU を `credentialVersion` で塞ぐ。** 第5.3節の login は step 3（Directory から検証材料取得）と step 5（User Data DO から epoch 取得）の間に窓がある。この窓で credential 変更が完走すると、**旧パスワードでの照合が成功したまま新しい epoch を載せた有効なセッションが発行される** — epoch ガードでは検出できない（epoch は最新だから）。

- **`credentialVersion` は credential ごとの単調増加カウンタで、Directory 側の `credential_mappings` 行と User Data 側の `credential_locators` 行の両方に持つ。** credential の同一性は `credentialId` である（第6.1.2節）ので、**ローテーション中に2世代の行があってもカウンタは1つの論理値であり、第6.1.1節 (R8) が全世代の行を同じ値に保つ。**
- login step 3 が返した値を step 5 で User Data DO に渡し、`credentialId` が一致する `credential_locators` の active な行**すべてと一致することを要求する**（第5.3節 step 5 (iii)）。
- 窓の中で phase 2 が走れば User Data 側だけが先に進むので不一致となり拒否される。phase 1 だけが走った場合は step 3 が `changeState: 'pending'` を見てダミー材料へ倒すので、そもそも照合が成立しない。**どちらの順序でも fail closed になる。**
- アカウント全体ではなく credential ごとのカウンタにする理由は、アカウント単位にすると SSO link で新しい credential を足したときに**既存の credential のバージョンが取り残されてログインできなくなる**からである。

### 6.6 SSO リンク / 解除の整合性 ［Issue 要求］

**既存の `SsoUser` 判別共用体の読み替えが前提になる。** 現行の `packages/core/src/domain/identity/entity.ts` は `User = PasswordUser | SsoUser` で、**1ユーザーにつき認証方式が1つ**という形になっている。link / unlink（複数クレデンシャル）はこの形のままでは表現できない。

**読み替え: `User` から認証方式の判別共用体を外し、クレデンシャルの集合を Directory 側の事実として持つ。** User Data DO 側の `account` は「そのアカウントが持つクレデンシャルの種類と件数」だけを非 PII の要約として持ち（`credential_locators` の**行そのものではなく、`usableForLogin = true` かつ active な行の distinct な `credentialId`** として表現される。行数ではない理由は第6.1.1節 (R4)、キーが `(kind, hmac)` でない理由は第6.1.2節）、原本と検証材料は Directory bucket にある。**設定画面に出すのは `credentialId` / `kind` / `label` の3つだけで、unlink はこの `credentialId` を指定して発行する**（第6.1.2節 (C5)）。`spec/domains/identity.md` の `User` 定義の改訂は #35（第11.1節）。

#### link の順序（saga として扱う）

**link は signup / unlink / credential 変更 / 退会と同格の cross-DO saga である。** 初版は4手順を並べただけで前進ジョブを持たず、手順3 と手順4 の間で落ちると **`status: 'active'` の mapping 行が `credential_locators` に対応行を持たない**状態で恒久的に残った。この孤児は誰にも回収されない — `sweep-reservations` は `status: 'reserved'` の行しか見ず（第6.7節が自ら明記している）、`sweep-orphan-mapping` は unlink 時に `operations` 行へ退避した locator に依存するうえ、**link に対する正しい修復は削除ではなく前進（locator の記録）**なので同じジョブでは直せない。結果はその SSO 主体の永久ロックである — login は第5.3節 step 5 (ii) の到達性検査で fail closed に拒否されるので認可は開かないが、**利用者は自分でリンクし直すこともできない**（手順2 の予約が `ConflictError` で敗北する）。第6.4節が signup について「黙って到達不能アカウントを残すだけは選ばない」と決めた基準が、link にも等しく掛かる。

| phase | 実行場所 | 内容 |
|---|---|---|
| 1 | User Data DO | `operations` に `{ operationId, kind: 'link', payloadDigest, phase: 'reserving', targetLocators }` を記録し、**現在のログイン可能なクレデンシャル数を読む**（数え方は第6.1.1節 (R4)）。同時に自 DO の job table へ `resume-link` を投入する。**`targetLocators`（要素は `credentialId` + `kind` + 全長 HMAC + 世代 + bucket index）をこの時点で記録する**のが前進を可能にする条件である。**`credentialId` は request Worker が `operationId` と同時に採番して引数で渡した値である**（第6.1.2節 (C1)）。**`account.callerToken` も読み、手順2 の予約に載せる** |
| 2 | Directory bucket | **locator は検証済み IdP アサーション由来の canonical から導出する**（第6.1.1節 (R5)(iii)。link の対象はまだ `credential_locators` に無い credential なので (ii) では手順が決まらない）。previous 世代が keyring に載っている間はその bucket を読んで既存行の不在を確認し（第6.1節 (c)・第6.1.1節 (R1)）、active 世代の bucket に予約を取る（`credentialId` と `callerToken` 付き。既に他アカウントで `active` なら `ConflictError`） |
| 3 | Directory bucket | 予約を `status: 'active'` へ昇格する |
| 4 | User Data DO | `credential_locators` に reverse locator（`credentialId` + 世代 + bucket index + `kind` + 全長 HMAC + `credentialVersion` + `usableForLogin`（SSO 行なので常に真）+ `label`（provider 名））を追加し、`operations.phase = 'done'` にする |

- **前進の駆動は User Data DO の Alarm（`kind: 'resume-link'`）である。** 起点が手順1 なので、落ちたときに操作の存在を知っているのは `operations` 行だけである。第7.4節の「cross-DO saga を前進させるジョブは、saga の起点となった側の DO が所有する」という規則にそのまま乗る。
- **手順2〜4 はすべて冪等である。** 手順2 は同じ `operationId` の予約が既にあれば成功として返し、手順3 は既に `active` なら成功、**手順4 は `(credentialId, generation)` を冪等キーとする upsert である**（既存行があれば `credentialVersion` / `usableForLogin` / `label` を上書きし、`credentialVersion` は単調非減少。第6.1.1節 (R8)・第5.1節の表）。`resume-link` は `operations.phase` を見て中断点から再開する。
  - **初版は手順4 の冪等キーを `(kind, hmac)` と書いていた。これは誤りである。** `credential_locators` の一意性は `(credentialId, generation)` であり（第4.1.1節）、鍵ローテーションの手順2 (1) は**同じ credential について世代違いの行を追加する**（第6.8節）。`(kind, hmac)` を冪等キーにすると link だけを見れば動くが、**同じ RPC を共有するローテーションの (1) が常に no-op になり、(4) が旧世代行を消した時点で `credential_locators` からその credential の行が1つも無くなる** — 到達性検査（第5.3節 step 5 (ii)）が移送済みの全利用者を fail closed で締め出す。**冪等キーは全経路で `(credentialId, generation)` に統一する。**
- **敗北時の巻き戻し。** 手順2 が `ConflictError` で敗北したら、`operations` 行を `terminalReason` 付きで閉じるだけで、User Data DO 側には何も残らない（reverse locator はまだ書いていない）。
- **`sessionEpoch` は進めない。** link は認証手段を増やすだけで、既存セッションの信頼性を下げないからである。正本は第5.1節で、そこに残余リスクと補償（リセット完了画面の必須導線）も書いた。初版はこの手順で epoch を1つ進めており、第5.1節・第6.5節の「epoch を進める操作は4つ」という列挙と食い違っていた。
- **既存クレデンシャルの `credentialVersion` には触れない。** credential ごとのカウンタなので、link が他の credential でのログインを巻き添えにしない（第6.5.1節）。

#### unlink の順序（link の逆順にはしない）

1. **利用者は解除対象を `credentialId` で指定する**（第6.1.2節 (C5)）。User Data DO で**次の2つをこの順に検査する。どちらも DO 側の権威であり、UI の出し分けに委ねない** — ここが**唯一のアカウント到達性の権威**だからである。
   - **(1-a) 対象 `credentialId` の `kind` が `'sso'` であること。`kind = 'email'` の解除経路は本設計に存在しない**（`BusinessRuleError`）。**初版のガードは `kind` を一切見ておらず、パスワード + SSO のアカウントで `kind = 'email'` を対象に指定すると (1-b) を通過した。** 通過すると手順2〜3 が忠実に実行され、メール行が全世代の `credential_locators` から消え、Directory の `credential_mappings` 行（`encryptedCanonical` を含む）と `password_reset_tokens` 行も消える。結果は (i) `read-own-canonical` の対象行を失って自分のメールアドレスを表示できない、(ii) `request-password-reset` が mapping 不在の空振り経路へ落ちて**リセットが恒久的に不能**になる、(iii) 第6.5.1節 起点 A のパスワード変更も対象行が無く成立しない、の3つである。**メールクレデンシャルを追加するフローは本設計に存在しない**（link は SSO 専用。本節）ので、利用者自身にも復旧手段が無い。第5.2.1節 (a) が「所有の唯一の証明はパスワードリセット経路である」と断定している以上、その唯一の証明をセッションを握った攻撃者が1回の unlink で消せる形は残せない。**第5.1節と本節の見出しがいずれも「SSO link・unlink」と書いているとおり、設計の意図は元から SSO 限定である** — 食い違っていたのはガードの記述だけである。
     - **将来メールアドレスの変更・再登録を入れる場合は、unlink ではなく credential 変更 saga の一種（第6.5.1節）として設計する。** 新しい canonical の一意性予約と旧行の削除を1つの saga に収める必要があり、「外すだけ」の unlink では到達性が0になる窓を構造的に塞げないからである。
   - **(1-b) 「最後のログイン手段を外そうとしていないか」の検査。** **検査述語は行数ではない** — **`credential_locators` のうち `usableForLogin = true` かつ active な行の distinct な `credentialId` を数え、対象 `credentialId` を除いた残りが0件なら `BusinessRuleError` で拒否する**（第6.1.1節 (R4)）。**(1-a) があっても (1-b) は要る** — SSO を2つ持つ利用者が両方を順に外す経路は `kind = 'sso'` のままで成立するからである。
   - **初版は「行数が1ならば拒否」だった。これは本設計自身の2つの決定によって既に誤っていた。** **(a) SSO signup はメール canonical にも mapping を置く**ので（第6.3節）、SSO 専用ユーザーの行数は**常に2**である。ところがメール行は一意性の予約であってログイン手段ではない（`passwordVerifier` を持たないので第5.3節 step 4 の照合が成立しない）。行数で数えると SSO を unlink したときに検査を通過し、**ログイン手段が0になる**。**(b) ローテーション中は同じ credential の行が2世代並存する**ので（第6.1.1節）、単一クレデンシャルの利用者でも行数が2になり、検査が発火しない。**どちらもローテーションの有無にかかわらず、あるいは通常運用の中で成立する。**
   - **2版目は述語を distinct `(kind, hmac)` にしていた。これでも (b) は閉じない。** `hmac` は世代依存の値なので（第6.1.2節）、**2世代の行は `hmac` が異なり distinct 2件と数えられる**。SSO 専用ユーザー（`usableForLogin = true` の行は SSO 1件だけ）が自分の移送窓中に unlink を実行すると、残り1件と誤判定して検査を通過し、**ログイン手段が0のアカウントが完成する**。`usableForLogin` 列（第4.1.1節）と **distinct `credentialId`** の2つで初めて (a)(b) の両方が閉じる。
2. User Data DO の `credential_locators` から**対象 `credentialId` の全行**（＝全世代）を削除し、`sessionEpoch` を1つ進め、`operations` に unlink を記録する。**削除する前に、消す行の locator を全世代分 `operations.targetLocators` へ退避する**（第4.1.1節。`credential_locators` から消えると逆引きできなくなるため）。**`credentialId` をキーにすることで「同じ credential の別世代の行」を突き合わせられる** — `(kind, hmac)` では世代ごとに値が違うので、そもそも突き合わせるキーが存在しない（第6.1.2節）。
3. **`targetLocators` が持つ全世代の bucket に対して** mapping 行の削除（`delete-mapping`。引数は `credentialId` + `callerToken`）を発行する。**「無ければ成功」の冪等操作**にする（第6.1.1節 (R3)。第6.7節 手順3 と同じ規則である）。**同じ `transactionSync` で、その `credentialId` の `password_reset_tokens` 行も全削除する**（第6.1節 (d)）。解除したクレデンシャル宛に発行済みのリセットトークンを生かしておくと、解除の意味が無くなる。
   - **初版は手順2 が1行、手順3 が1 bucket だけを消していた。ローテーション中はこれが「解除済みクレデンシャルでログインできる」経路になる。** `credential_locators` に残ったもう一方の世代の行が第5.3節 step 5 (ii) の到達性検査（`credentialId` の一致だけを見る）を通し、残存 mapping 行は `passwordVerifier` を保持したままなので、login step 1〜6 が全部通って**新しいセッションが発行される**。下の「片方向にしか壊れない」という保証は「当該 credential の行が `credential_locators` からすべて消えている」ことに依存しており、**2世代並存下では1行削除では成立しない。** 退会（第6.7節 手順3）が既に全世代を扱っていたのに unlink だけが未対応だった非対称を、ここで解消する。**`credentialId` を持たない設計では「全世代の行を消す」を実装する手段そのものが無かった**ことも、あわせて第6.1.2節に記録してある。

**「解除済みだが mapping が残る」状態を作らない方法。** 上の順序だと 2 と 3 の間で落ちると「User Data からは消えたが Directory には残る」状態になる。これは**片方向にしか壊れない** — 残った mapping で login すると `userId` は引けるが、**第5.3節 login step 5 (ii) の到達性検査**（bucket から得た locator が `credential_locators` に active 行として存在するかの照合）が `credential_locators` の行の不在を見て fail closed で拒否する。つまり「解除したのにログインできてしまう」は起きない。

**この保証は到達性検査があって初めて成立する。** epoch ガードはここでは効かない — epoch ガードは「トークンが持つ epoch と現在値の照合」であり、**login は新規にトークンを発行する側なので照合対象が存在しない**。しかも第6.1節 (d) により、パスワードの検証材料は残存 mapping 行そのものに載っている。到達性検査が無ければ login の手順 1〜6 が全部通り、**解除済みクレデンシャルで新しいセッションが発行される**。第5.3節 step 5 (ii) はこの穴のために置いた検査であり、**Account Home を採らない設計（第3.1節）の成立条件そのもの**である。

逆順（Directory を先に消す）だと、途中で落ちたときに「User Data には残っているが引けない」孤児 locator になり、次の link で「既に使われている」と誤判定させる余地が生じる。したがって**この順序が正しい**。

残った mapping は User Data DO の Alarm（`kind: 'sweep-orphan-mapping'`）が `credential_locators` との突き合わせで検出し、削除を再試行する。**locator は unlink 時に `operations.targetLocators` へ全世代分を退避しておく**（`credential_locators` からは消えているため）。**退避が単一 locator では、ローテーション中に片側の世代の mapping が回収されずに残る**（第6.1.1節 (R3)）。突き合わせのキーは `credentialId` である。

### 6.7 退会 ［派生］

**tombstone 先行 → mapping 削除 → `credential_locators` 削除**の順にする。**`credential_locators` は最後まで消さない。**

1. **User Data DO** に `account.status = 'deleting'` を書き、`sessionEpoch` を進める。この瞬間から既存セッションは epoch 不一致で、AI クライアントトークンは `account.status` ガードで拒否される（第5.4節。**epoch が AI トークンを無効にするのではない**）。login も第5.3節 step 5 (i) の状態照合で拒否される。同時に `kind: 'finalize-withdrawal'` のジョブを投入する。
2. **User Data DO** が利用者データを消す（memos / topics / documents / revisions / source_links / FTS / ai_client_connections / user_settings）。10 GB 級ならチェックポイント分割で Alarm から進める（第4.8節）。
3. **Directory bucket** の mapping 行（`encryptedCanonical` を含む）を物理削除する。**削除対象は `credential_locators` に記録された `credentialId` ごとの全世代分**である — 鍵ローテーション中（第6.8節）は active 世代と previous 世代の両方に行が存在しうるので、**両世代の bucket に対して削除を発行し、「無ければ成功」の冪等操作**にする（第6.1.1節 (R3)。unlink 手順3 と同じ規則である）。RPC は `delete-mapping` で、**引数に `credentialId` と `account.callerToken` を載せる**（第5.1節 (3-b)）。この手順は `credential_locators` を読んで locator を得るので、**その行がまだ存在している必要がある**。**同じ `transactionSync` で、その `credentialId` の `password_reset_tokens` 行も全削除する**（第6.1節 (d)）。トークン行を残すと第6.2.1節 (d) の「bucket 側には何も残さない」が守られない。
4. **User Data DO** が `credential_locators` を消し、`account.callerToken` を消し、`account.status = 'deleted'` にする。残すのは**非 PII の tombstone だけ** — 不透明なアカウントキー（= `userId`）、status、epoch、完了時刻。

**順序を「mapping 削除が先、`credential_locators` 削除が後」にした理由。** `credential_locators` は「`credentialId` + 世代 + bucket index + 全長 HMAC」を持つ**唯一の逆引き情報**である（第6.3節 phase 4）。これを先に消すと、3 と 4 の間ではなく **3 の前**に落ちた場合に、削除すべき mapping 行の所在を知る手段が消える。HMAC は一方向なので User Data DO 側から再計算できず、canonical 原本は削除対象の行の中にしかない。帰結は2つとも重大で、(i) **退会後もメール原本が暗号化状態で無期限に残存する** — 第6.2.1節 (d) の「bucket 側には何も残さない」が守られない、(ii) mapping が `active` のまま残るので**そのメールアドレスで再登録できない**（第6.3節 phase 1 が `EMAIL_ALREADY_REGISTERED` で敗北する）永久ロックになる。順序を入れ替えればどちらも起きない。

**回収は `kind: 'finalize-withdrawal'` ジョブが担う。** 「`account.status = 'deleting'` または `'deleted'` なのに `credential_locators` が空でない」状態を User Data DO の Alarm が前進させ、手順3 → 4 を冪等に再試行する。**第6.4節の予約 TTL 掃除は `status: 'reserved'` の行しか対象にしないので、`active` な孤児 mapping を回収できない** — 専用ジョブが必要な理由である。

**「bucket 側には何も残さない」は PITR 保持期間の外側では成立しない。消去が不可逆になるのは退会の30日後である。** PITR は SQLite-backed DO の DB 全体を過去30日まで戻せる（第2.1節 F-20）ので、**物理削除した `credential_mappings` 行と `password_reset_tokens` 行は30日間は復元可能**である。第6.2.1節 (d) の「退会が完了した時点で bucket 側には何も残さない」は**論理的な到達性についての主張**であって、記録の消滅についての主張ではない。設計はこの事実を第6.2節の判断軸 (iv) の議論では正しく使っていたのに、退会の消去範囲では使っていなかった。次の3点を設計上の結論として置く。

- **退会による削除は即時消去ではない。不可逆になるのは PITR 保持期間（30日）が経過した時点である。** 利用者への説明（#38 が起こす運用ドキュメントと画面文言）はこの粒度で正確に書く。
- **退会済み `userId` の User Data DO と、その credential が載っていた Directory bucket に対する PITR 実行を禁止する。** 運用者が単独で実行できる操作にせず、**承認手続きの対象**にする。第10.1節が「どちらか一方の restore だけでアカウントが復活することは無い」までしか書いていないのは、**両方を戻せば復活する**ことと、それを運用者が単独で行えることを述べていないためである。
- **Directory bucket の PITR は退会1件に閉じない。** bucket は同じ index に写像される全ユーザーの mapping を持つので、1人の退会を取り消す目的の restore が**他の利用者の credential 状態まで巻き戻す**。したがって bucket 側の PITR は「アカウント1件の復旧手段」として使えない。手順と監査は #38（第11.3節の PITR の項）。
- **「PITR 保持期間の外側では成立しない」の帰結は、消去の不可逆性だけではない。認可の再開にも及ぶ。** bucket を戻すと、消費済み・削除済みのリセットトークン行が `usedAt = null` で復活し、乗っ取り復旧を巻き戻す経路が開く（第10.1節）。**したがって Directory bucket の restore には「復旧できないなら全部切る」型の必須ステップが付く** — restore 直後に当該 bucket の `password_reset_tokens` を全行削除し、`failedAttempts` / `nextAttemptAllowedAt` を安全側へ戻す（第10.1節。手順は #38）。

**最後の砦として operator 経路を用意する。** Directory bucket に **`purge-user-mappings`**（「`userId` を指定して自 bucket 内の全 mapping 行を削除する」冪等 RPC。**第5.1節の表にクラス (3) の operator 専用エントリとして載せてある**）を持たせ、逆引き情報ごと失われた場合は 256 bucket の走査で回収できるようにする。実行手順は #38（第11.3節）。

- **このエントリだけは `callerToken` で束縛できない。** トークンは失われた行と一緒に消えているためである（第5.1節 (3-c)）。**したがって守りは maintenance 経路の到達制御と実行監査だけであり、任意の `userId` を受けて破壊的に一括削除できる。本表で最も危険なエントリであることを隠さずに書く。** 監査要件（誰が・いつ・どの `userId` に対して実行したかの記録と、実行前の承認）は #38 へ送る（第11.3節）。

**この順序は PITR の復旧単位が DO 1個であること（第10.1節）に耐える。** Directory mapping が到達性のゲートなので、User Data DO を過去へ戻しても mapping が無ければ login できない。逆に Directory bucket を過去へ戻して mapping が復活しても、User Data DO 側の tombstone（`status = 'deleted'`）が現在のままなので fail closed で拒否される。**どちらか一方の restore だけでアカウントが復活することは無い。**

### 6.8 鍵ローテーション ［派生］

**ローテーションの対象は credential 由来 locator に限られる**（第5.2.2節）。User Data DO の同一性には波及しない。

#### 手順

1. keyring に新しい世代を active として追加し、旧 active を previous へ降格する（request Worker のみ。第5.2.3節）。この時点から lookup は active → previous の順になる。
2. operator 専用の maintenance 経路が previous 世代の bucket を `0..N-1` の順に走査する（**`N` は previous 世代の `bucketCount`**。keyring から引く。第5.2.3節）。各 bucket で previous 世代の mapping 行を読み、`encryptedCanonical` を復号し、**bucket の中で** active 鍵で再 HMAC して**新しい世代の bucket へ移す**。移送は**4段の順序で行い、どの中断点でも login が通る状態を保つ**。

**`rotate-remap` は bucket の Alarm ジョブではない。maintenance 経路が1チャンクずつ駆動する同期 RPC である、と結論を改める。** 初版は `rotate-remap` を Directory bucket 所有の Alarm ジョブとして定義していたが（第7.4節の `kind` 表）、**3つの規則が同時に成立しない**。

- (i) 再 HMAC は bucket の中で行う（平文を外へ出さないため。第5.2.3節）。
- (ii) routing key は RPC 引数として一時注入し、SQLite にもインスタンスフィールドにも書かずにその呼び出しの中で破棄する（同節）。
- (iii) 大きな仕事は Alarm を跨ぐチェックポイントで分割する（第7.4節）。

**(iii) を採ると次の Alarm 起動時に鍵が存在せず、(ii) を守ったまま1回の RPC で bucket 全件を処理しようとすると CPU 予算超過（＝途中まで進んで黙って落ちる）に当たる。** #37 が実装で辻褄を合わせるときの最も安易な解決は**鍵を bucket の SQLite かインスタンスフィールドに置く**ことで、それは第3.2節が固定した「秘密の配布は非重複である」を壊す（`DIRECTORY_ROUTING_SECRET` が state Worker 側に永続化される）。しかも第7.4節が要求するチェックポイントごとの `sync()` を守れば、鍵は write buffer からディスクへ流れる。

**したがって実行主体を決め直す。** `rotate-remap` は **operator の maintenance 経路が「1チャンク = 1 RPC」で駆動する**。鍵は毎チャンクの引数として注入され、**チャンクの境界で必ず破棄される**。進捗は `rotation_checkpoints`（第4.1.1節）と mapping 行の世代が既に持っているので、**Alarm による自走は不要である**。チャンクの大きさ（1回の RPC で移送する行数）は第7.4節の内側チェックポイント予算と同じ扱いで、#37 が spike で根拠値を出し #38 が運用値を確定する。

- **`rotate-encryption` はこの制約を受けない。** `IDENTITY_MAIL_ENCRYPTION_KEY` は state Worker の**常設バインディング**なので（第3.2節）、Alarm 起動時にも鍵が存在する。**したがって `rotate-encryption` は bucket の Alarm ジョブのままである。** 2つのローテーションで実行主体が違うのはこの非対称による。
- 第7.4節の `kind` 表と第4.1.1節の Directory `jobs` 行から `rotate-remap` を外してある。第5.1節のクラス (3) には「ローテーションの起動と鍵の一時注入」のエントリとして残る。
   - **(1) 新 locator を User Data DO の `credential_locators` に追加する**（`record-credential-locator`。冪等キーは `(credentialId, generation)` で、**`credentialId` は移送元の行の値をそのまま運ぶ — 再採番しない**。第6.1.2節 (C1)。旧行は残す。`credentialVersion` / `usableForLogin` / `label` は移送元の行の値を運ぶが、**`credentialVersion` の書き込みは `credentialId` 単位で単調非減少である**。第6.1.1節 (R8)）。**(2) 移送先の bucket に active 行を書く。** **(3) 元の previous 行を消す。** **(4) 旧 locator（`(credentialId, previous 世代)` の行）を `credential_locators` から消す。**
   - **順序を「新 locator の追加が先」にした理由。** 初版は (2) → (3) → 「その後に `credential_locators` を更新する」（手順3）という順序だったが、**(2) が完了した時点で active 世代の lookup が新 locator にヒットするので、login step 3 が返す `usedLocator` は新世代になる**。ところが `credential_locators` の更新は別 DO への RPC なので、その間 User Data DO 側には旧世代の locator しか無い。step 5 (ii) の到達性検査が世代まで一致を要求すると、**この窓に入った login はすべて拒否される**。ローテーションは全 bucket を走査する保守作業なので、窓は理論上全ユーザーに順次開く。第6.1節 (d) は同じローテーション中の「発行済みリセットトークンが無効になる」影響を明示的に受容しているが、**login が落ちる影響は受容しない** — リセット依頼のやり直しと違い、ログインできないことに利用者側の回避手段が無いからである。
   - **`credential_locators` は移送中、同じ credential について新旧2世代の行を同時に持つ。** これを許すことが上の順序の実体である。**2行は同じ `credentialId` を持つ**ので（第6.1.2節）、到達性検査は `credentialId` の一致だけを見れば足り、**「世代を照合条件に含めるかどうか」という問い自体が消える**（第5.3節 step 5 (ii)）。一意性の権威は Directory 側にあるので、User Data 側が2行持っても認可は緩まない。第6.7節（退会）が既に「両世代の bucket に対して削除を発行する」と書いているのと同じ前提である。
   - **移送先に既に行がある場合の規則を書く。** ジョブは at-least-once であり（第7.7節 3）、`alarm()` は CPU 予算超過時に「途中まで進んで黙って落ちる」（第7.4節）ので、**(2) の後・(3) の前でのクラッシュと再実行は想定内の経路**である。
     - **(2) は「行の有無」ではなく「世代間の新旧比較」で分岐する。規則の正本は第6.1.1節 (R9)（`credentialVersion` が大きい側が正本）である。** 具体は4分岐で、**移送元・移送先とも `credentialId` は同じ値のまま**である。
       - **移送先に行が無い** → 読み出したスナップショットをそのまま書く。
       - **行があって `userId` が異なる** → 移送せず `poison` にし、`terminalReason` を残して運用へエスカレーションする（#38）。これは「同じ canonical が別ユーザーに二重登録された」ことを意味し、第6.1節 (c) の世代跨ぎ検査が破れた場合の受け口である。自動で解決しない。
       - **行があって `userId` が同じで `source.credentialVersion > dest.credentialVersion`** → **移送先を移送元のスナップショットで行ごと上書きする**（`passwordVerifier` / `pendingVerifier` / `changeState` / `operationId` / `credentialVersion` / `status` / `failedAttempts` / `nextAttemptAllowedAt` / `lastResetRequestedAt` / `encryptedCanonical` / `encryptionGeneration` / `encryptionNonce` / `callerToken` / `credentialId`）。
       - **行があって `userId` が同じで `source.credentialVersion < dest.credentialVersion`** → **移送先が既に正本なので触らず、(3)(4) だけを行う**。
       - **等しい** → 何も書かずに (3)(4) を行う（冪等成功）。
     - **「行があれば書かない」だけに倒すと2方向のうち片方しか塞げない。** 初版の規則は「再実行が新 bucket の新しい値を previous 行の古い値で上書きする」向き（＝**旧パスワードの復活**）だけを塞いでいたが、**移送先が陳腐化する向き**は無防備だった。後者は偶然ではなく**起点 B（リセット完了）では構造的に必然**である — リセットトークンは発行時の `{generation}.{bucketIndex}` を運び（第6.1節 (d)）、`consume-reset-token` は「同 bucket に対象 credential の mapping 行が存在すること」しか確認しないので、旧世代 bucket に行が残っている限り必ずそちらに着地する。そのとき移送元が n+1 / 移送先が n になり、旧来の規則では「行があるから書かない」を選んで移送元を消してしまう。**終状態は「active bucket に旧 `passwordVerifier`」であり、第5.3節 step 5 の (ii)(iii) はどちらも通る — 旧パスワードでログインでき、リセットで設定した新パスワードは通らない。**
     - **移送は `credentialVersion` を増やさない。** 移送は認証状態の変更ではないからである。運ぶのは常に正本側の値である。`callerToken` と `credentialId` も行ごと引き継ぎ、再採番しない（第5.1節 (3-b)・第6.1.2節 (C1)）。
     - **暗号文系の3列（`encryptedCanonical` / `encryptionGeneration` / `encryptionNonce`）は再暗号化せずにそのまま運ぶ。** AAD が束縛するのは `(kind, credentialId, encryptionGeneration)` であり `hmac` を含まないので（第6.2.1節 (b-2)）、移送で AAD が変わらない。**AAD に `hmac` を残したまま移送すると、移送された全行の canonical が復号不能になる** — その帰結（リセットメールの宛先組み立て・自メールアドレス表示・次回ローテーションの再 HMAC が恒久的に壊れ、しかも最初のリセット依頼まで顕在化しない）は同節に書いた。
   - **移送元側にも同じ強さのガードを置く。移送先だけの CAS では守れない。** (1) と (2) はいずれも DO 間 RPC なので `await` を挟み、その間 source bucket の input gate が開いて別のリクエストが割り込む（第2.1節 F-18）。**割り込める相手は credential 変更 saga の phase 1 である** — active 行がまだ移送先に無い窓では lookup が active → previous の順で previous にヒットするので、**credential 変更は移送元の行に着地する**（第6.1.1節 (R2) がそう定めている）。初版は移送先だけを CAS で守っており、移送元は無防備だった。3点を足す。
     - **(3) を CAS にする。** 「読み出し時の `credentialVersion` / `passwordVerifier` / `changeState` / `operationId` / `failedAttempts` / `nextAttemptAllowedAt` / `lastResetRequestedAt` と一致する場合にだけ削除する」。**0行削除なら巻き戻して、そのユーザーの移送を最初からやり直す**（読み出しからの再実行。チャンクは冪等なので次の駆動で拾う）。**巻き戻しの対象は2つあり、両方を明示する。**
       - **(2) で書いた移送先の行を破棄する。ただし破棄も CAS で守る — 無条件に消してはならない**（第6.1.1節 (R7)）。**「(2) が書いたスナップショットと全列が一致する場合にだけ削除し、一致しなければ破棄せずそのまま残す。」** 一致しない場合は (2) の後に移送先の行が更新されたということなので、残したうえで次の走査の (R9) 新旧比較に正本の側へ収束させる。
         - **無条件破棄は実在する状態を壊す。** (2) が移送先 A に行を書いた時点で active 世代の lookup は A にヒットするので、以後の書き経路は A へ向かう — `begin-credential-change`（起点 A は `credential_locators` の両世代から選ぶので A を選びうる。起点 B は (2) 以後に発行されたトークンが A 世代を運ぶ）、`report-login-result` の `failedAttempts`、`lastResetRequestedAt` である。一方 (3) の CAS が失敗する条件は移送元 P 側の変化で、**(2) より前に step 3 を終えた login が (2) より後に step 7 を報告する**だけで成立する（step 4 の `PasswordHasher.verify` は PBKDF2 210,000 回で数百 ms 掛かる。第4.8節）。この2つが重なると、無条件破棄は A に載った `changeState = 'pending'` / `pendingVerifier` を消す。**消えた後は fail closed ではなくログイン不能に倒れる** — phase 2 が先に走っていれば `sessionEpoch` は前進し `credential_locators` の `credentialVersion` は n+1 になる一方、A の行は消え P の行は n のままなので第5.3節 step 5 (iii) が恒久的に不一致になり、`resume-credential-change` は対象行を失って `poison` へ落ちる。復旧手段はパスワードリセットのやり直ししか残らない。
         - **(R9) の新旧比較は救わない。** 比較するのは `credentialVersion` の大小だけなので、`changeState` / `pendingVerifier` の消失は検出できない。「破棄は最適化であって正しさの拠り所ではない」（次の走査が収束させる）という主張は**破棄しない場合**についてのものであって、**破棄が壊しうる**ことの否定にはならない。
         - **(R6)（`pending` 行を移送しない）もこの窓を塞がない。** (R6) は**読み出し時点**の判定であり、(2) 以後に `pending` が移送先へ着地する窓は開いたままだからである。
       - **(1) がその走査で新規に追加した `credential_locators` 行は破棄しない、と決め切る。** 初版は「破棄する」と書いていたが、それは移送先（User Data DO 側）への**無条件の書き込み**であり (R7) に反する。**破棄しなくても不変条件は壊れない** — 第6.1.1節 (R8)（全世代同時更新 + 単調非減少 upsert）により新世代行の `credentialVersion` は常に正本以上に保たれ、到達性検査（第5.3節 step 5 (ii)）は `credentialId` だけを見るので世代行が1つ余分にあっても認可は緩まない。残った新世代行は、次の走査で (1) が同じ `(credentialId, generation)` へ upsert するか、ローテーション完了後の (4) が旧世代行を消すことで自然に整合する。**「どの走査にも属さない孤児の世代行を残さない」という初版の動機は、(R8) の単調性で代替できる範囲であり、CAS を持たない破棄を正当化しない。**
       - **(3) の CAS そのものが無いと**、窓の中で完走したパスワード変更の結果（新 `passwordVerifier` / `credentialVersion` = n+1）を、**(2) が書いた読み出しスナップショット（旧 verifier / n）が上書きし、(3) が新しい値を持つ移送元行を消す**。移送は `credentialVersion` を保存するので移送先も n のままであり、User Data 側も (1) で n の新 locator 行を得て (4) で n+1 の旧 locator 行を失う。**Directory と User Data が揃って n に巻き戻るので第5.3節 step 5 (iii) の照合が通り、旧パスワードでログインできる。** 第6.8節が「再実行経路の危険」として特定していた事象が、**初回実行経路で成立する。**
     - **`changeState = 'pending'` の行は移送しない。** スキップして次の行へ進み、`rotation_checkpoints.previousCount` に残す。**理由は第6.1.1節 (R6)** — 前進ジョブ `resume-credential-change` は phase 1 を書いた bucket の `jobs` にあり、移送対象は `credential_mappings` 行だけなのでジョブは移送されない。行だけが移ると phase 3 が永久に走らず、**旧新どちらのパスワードも通らない状態が恒久化する**（第6.2.2節 (a) の脱出経路 (i) も同時に壊れる）。pending が解けた次の走査で移送される。
     - **`status = 'reserved'` の行も移送しない。** 予約は TTL で消えるか `active` へ昇格するかのどちらかなので、pending と同じくスキップして再走査で拾う。移送すると、コーディネーターの `locators[]` / 非コーディネーターの `coordinatorLocator` が指す旧世代 locator と `resume-signup` の所有 bucket が一斉に指す先を失い、**第6.3節の saga の参照が全部切れる**。加えて phase 2 前の予約行に対する (1) は「候補 `userId` の User Data DO へ `credential_locators` を書く」ことになるが、**その DO はまだ存在しない** — 第6.2節が判断軸 (iv) を User Data DO へ当てて phase を入れ替えた前提（重複チェックに勝った signup だけが User Data DO を作る）と正面から衝突する。
     - **スキップした行があってもローテーションは止まらない。** 手順4 の退役条件が「`status` を問わず previous 世代の行が全 bucket で0件」なので、**スキップした行が0になることが自動的に退役条件になる**。したがって **`rotate-remap` の走査は「1周して終わり」ではなく、`previousCount = 0` が全 bucket で揃うまで繰り返す**。**制約として明記する — ローテーションの所要時間は予約 TTL（第6.4節 1）と credential 変更の pending 解消時間より必ず長くなる。** #38 の運用手順にこの前提を送る。
   - **平文 canonical を Worker 境界の外へ出さない。** maintenance 経路は active 世代の routing key を RPC 引数として bucket へ一時注入するだけで、bucket は復号 → 再 HMAC をローカルに完結させる（第5.2.3節）。逆に「bucket が平文を返して request Worker が HMAC する」形にすると、**全ユーザーのメール平文が bulk で Worker 間 RPC を流れる**。ローテーションは operator が手動で走らせる保守作業であり、まさにトレース・詳細ログを有効化しがちな場面なので、事故時の被害が最大化する。採らない。
   - 保護規定を明示する。**(i) 注入された鍵と復号結果を含む RPC のログ・トレースを無効化する**、**(ii) チェックポイントは bucket 単位に閉じ、1回の Alarm 起動で複数 bucket 分の平文を同時にメモリへ載せない**、**(iii) 平文を DO の SQLite にも request Worker のいかなる永続領域にも書かない**（第6.2.1節 (c)）。
   - **リセットトークン行は移送しない**（第6.1節 (d)）。移送対象は `credential_mappings` 行だけである。
3. 手順2 の (1) と (4) は **Directory bucket → User Data DO の RPC**（`record-credential-locator`。第5.1節のクラス (3)）であり、locator は mapping 行が持つ `userId` である（第5.5節 1 の但し書き）。**冪等キーは `(credentialId, generation)` で、`credentialVersion` / `usableForLogin` / `label` を上書きする upsert である**（第6.1.1節 (R8)。link / signup 経路とまったく同じ意味論を使う）。**ローテーション経路は `operations` 行を作らない、と決め切る** — 移送は認証状態の変更ではないので saga の phase を持たせる必然が無い。**したがってこの経路の束縛は `callerToken` だけである**（mapping 行が持つ値を運び、User Data DO の `account.callerToken` と定数時間比較する。第5.1節 (3-d)）。**この2本は独立した手順ではなく手順2 の一部である** — 分けて後回しにすると上に書いた login の窓が開く。
4. **全 bucket で previous 世代が0件になったことを確認してから、旧鍵を破棄する。** 数えるのは **`status` を問わず previous 世代の bucket に残る `credential_mappings` 行の総数**である（`reserved` を除外すると、移送されていない予約行を見落とす）。**手順2 でスキップした `pending` / `reserved` 行もここに数えられるので、退役条件はスキップ行の消化を自動的に要求する。** 走査は `previousCount = 0` が全 bucket で揃うまで繰り返す（手順2 の最後の項）。

**暗号化鍵（`IDENTITY_MAIL_ENCRYPTION_KEY`）のローテーションは別の走査である。** 手順の骨格（世代の追加 → bucket 走査 → snapshot 置換による retirement 証明 → 旧鍵破棄）は同じだが、locator が変わらないので**移送が発生せず、行を同じ bucket の中で再暗号化するだけ**である。ジョブは `kind: 'rotate-encryption'`（第6.2.1節 (b-1)）。2つのローテーションは独立に走らせてよい。

**「旧世代 locator が0件である」ことの証明。** 全 bucket の checkpoint scan を加算集計するだけでは足りない。#19 のレビュー指摘 B-IDDS6-001 が3つの穴を記録している。本設計での扱いは次のとおり。

| 穴 | 本設計での扱い |
|---|---|
| Directory 側に active row が無い reverse locator が集計から漏れる | **構造的に消える。** Account Home を採らなかった（第3.1節）ので reverse locator は User Data DO 側の `credential_locators` に1系統しか無く、Directory bucket の走査が唯一の権威になる。突き合わせは第6.6節の孤児検出が別途行う |
| 同一ユーザーの複数 locator を重複加算する | **加算をやめる。** 数えるのは「bucket ごとの previous 世代の行数」であり、ユーザー単位では数えない |
| checkpoint が加算更新で snapshot 置換になっていない | **bucket ごとの snapshot 置換にする。** 各 bucket の走査完了時に `rotation_checkpoints` テーブル（第4.1.1節）へ `{ bucketIndex, generation, previousCount, scannedAt }` を**置換**で記録する。旧鍵の破棄条件は「同一 generation の全 `0..N-1` について `previousCount = 0` の記録が揃っていること」。加算カウンタは持たない |

### 6.9 DO 間分散トランザクションを前提としない宣言 ［Issue 要求］

**本設計は DO 間の分散トランザクションを一切前提としない。** Cloudflare は複数 DO を跨ぐアトミックなトランザクションを提供しないので、User Data DO と Directory bucket にまたがる操作は必ず「途中で落ちうる」ものとして設計する。

代替は **再開可能な saga + 冪等な補償** である。

- 各操作は request Worker が採番した `operationId` を冪等キーとして持つ（第6.5節）。
- 各 DO は自分の side effect の前に phase を永続化してから進む（第6.3節）。
- 落ちた場合は Alarm が拾い、User Data の初期化完了以降は前進、それ以前は巻き戻す（第6.4節）。
- 補償は「無ければ成功」の冪等操作にし、何度実行しても同じ結果に収束させる。
- **どの中間状態でも、認証・認可は fail closed 側に倒れる**（第6.5.1節・第6.6節・第6.7節）。中間状態が「ログインできてしまう」方向に開くことは無い。
  - **この宣言の射程は「本設計が作る中間状態」であり、PITR による巻き戻しはその外側である。** restore は本設計が進めた状態を過去へ戻す操作なので、`credentialVersion` の照合を回避せずに**前進させて解消する**経路（復活した消費済みリセットトークン）が成立し、認可が開く方向へ倒れうる。**塞ぐのは restore 直後の必須ステップであって中間状態の設計ではない**（第10.1節）。射程を書かないと、この宣言が反例を持つ。
- **第2の規則を置く。fail closed が「利用者を締め出す」方向へ働く経路は列挙して塞ぐ。** 「開かない」だけを規則にすると、締め出す側の破れが設計から見えなくなる。初版は該当経路を「1つだけ」と断定し、次に4つ・8つ・12へ広げたが、実際には次の14経路がある。**うち後半の4つは `hmac`（世代依存の値）を credential の世代非依存な同一性として使っていたことを共通の根とする**（第6.1.2節）。**新しい cross-DO 操作を足したら、この一覧にも行を足す。加えて — 3ラウンド目に追加した4行はいずれも「新しい操作」ではなく既存操作どうしの相互作用だったので — `.thread/34/design.md` の cross-DO 操作表（第6.4節）に載っている操作の組み合わせについても、片方が中間状態を持つ間に他方が走る場合を検査する。**

| 締め出す経路 | 塞ぎ方 |
|---|---|
| 予約 TTL 掃除と saga 再開の競合（ログイン手段を持たない `active` アカウント） | 第6.4節で3段（TTL の下限不等式・`sagaCommitted` 印・終端規則）で塞ぐ |
| 鍵ローテーション中、移送済みユーザーの login が到達性検査に落ちる（第6.8節 手順2） | 移送の順序を「新 locator の追加が先」にし、`credential_locators` に両世代の並存を許す。到達性検査は世代を条件に含めない（第5.3節 step 5 (ii)） |
| SSO link の部分失敗で `active` な孤児 mapping が残り、その主体が永久ロックになる（第6.6節） | `resume-link` で常に前進させる。`operations` 行に `targetLocators` を持たせて前進を可能にする |
| 標的型の認証試行によるアカウントロックアウト（第6.2.2節 (a)） | 天井・時間減衰・「ロックアウト中は加算しない」の3点と、リセット / SSO という2本の脱出経路で塞ぐ |
| **unlink の「最後のログイン手段」検査が行数ベースで誤り、SSO 専用ユーザー / ローテーション中の利用者が自分を締め出せる**（第6.6節 unlink 手順1） | 検査述語を `usableForLogin = true` かつ active な行の **distinct `credentialId`** の個数に変える（第6.1.1節 (R4)・第6.1.2節・第4.1.1節）。**`(kind, hmac)` で distinct を取る形ではローテーション中の経路が閉じない** — 2世代の行が別々に数えられる |
| **ローテーション中の credential 変更が phase 3 に到達できず恒久的に `pending` になる**（第6.8節 手順2 × 第6.5.1節）。旧新どちらのパスワードも通らず、第6.2.2節 (a) の脱出経路 (i) も同時に壊れる | `changeState = 'pending'` の行を移送しない（第6.1.1節 (R6)）。移送元の削除を CAS にして、窓の中で完走した変更が巻き戻らないようにする（第6.8節 手順2） |
| **移送の巻き戻しが、移送先に着地済みの credential 変更の中間状態を無条件に破棄する**（第6.8節 手順2 の (3) 0行削除時 × 第6.5.1節 phase 1）。(2) が移送先に行を書いた後は lookup がそちらへ向くので `changeState = 'pending'` / `pendingVerifier` が移送先に載る一方、(3) の CAS は移送元の変化（遅れて届く `report-login-result` で足りる）で失敗する。破棄すると Directory 側 n / User Data 側 n+1 の恒久不一致になり**ログイン不能**になる | 移送先の破棄も CAS にする — 「(2) が書いたスナップショットと全列が一致する場合にだけ削除し、一致しなければ残す」（第6.1.1節 (R7)・第6.8節 手順2）。`credential_locators` 側の追加行は破棄しない（(R8) の単調性で正本以上に保たれる） |
| **unlink のガードが `kind` を見ず、`kind = 'email'` のクレデンシャルを解除できる**（第6.6節 unlink 手順1）。パスワード + SSO のアカウントで「最後のログイン手段」検査を通過してしまい、リセットの宛先・`read-own-canonical` の対象行・パスワード変更の対象行が同時に消える。**メールクレデンシャルを追加するフローが存在しない**ので利用者にも復旧手段が無く、第5.2.1節 (a) の「所有の唯一の証明」を1回の unlink で失う | 検査 (1-a) を足す — **対象 `credentialId` の `kind` が `'sso'` であること**（`BusinessRuleError`）。UI の出し分けに委ねず DO 側の権威として置く（第6.6節 unlink 手順1・第6.1.2節 (C5)） |
| **複数クレデンシャル signup の phase 3 部分成功で `active` な孤児 mapping が残り、その credential が恒久的に再登録不能になる**（第6.4節 3） | 終端規則を「`cancel-reservation` で自分の `operationId` の行を `status` を問わず全 bucket から回収してから `abandon-account`」の2段にする（第6.4節 3） |
| **`purge-user-mappings`（operator 専用）の誤用・悪用による恒久ロックアウト**（第6.7節） | `callerToken` で束縛できない唯一のエントリなので、maintenance 経路の到達制御と実行監査で守る。監査要件は #38（第5.1節 (3-c)・第11.3節） |
| **ローテーション中の credential 変更が `credential_locators` の片側の世代の行だけを進め、step 5 (iii) が恒久的に不一致になる**（第6.8節 手順2 (1) × 第6.5.1節 phase 2）。パスワードを変えた直後から一切ログインできず、`sessionEpoch` も進んでいるので既存セッションも死ぬ | 第6.1.1節 (R8) — `credentialVersion` を `credentialId` 単位で管理し、更新は全世代の行へ同時に行う。`record-credential-locator` を `(credentialId, generation)` の upsert（`credentialVersion` は単調非減少）にする。あわせて第6.8節 手順2 の巻き戻しが (1) の追加行も破棄する |
| **`record-credential-locator` の冪等キーを `(kind, hmac)` にすると、ローテーションの (1) が常に no-op になり (4) の後に `credential_locators` が空になる**（第6.6節 link 手順4 × 第6.8節 手順2）。到達性検査が**移送を終えた全利用者**を締め出す | 冪等キーを `(credentialId, generation)` に統一する（第6.1.1節 (R8)・第6.1.2節）。`hmac` が世代依存であることが根因なので、世代非依存の `credentialId` を突き合わせキーにする |
| **`encryptedCanonical` の AAD が `hmac` を束縛していると、移送された全行が復号不能になる**（第6.2.1節 (b-2) × 第6.8節 手順2）。リセットメールの宛先組み立てが壊れ、**アカウント回復手段そのものが失われる** | AAD を `(kind, credentialId, encryptionGeneration)` にして移送で変わらないようにする（第6.2.1節 (b-2)）。付け替え防止は `credentialId` の一意性で維持される |
| **移送先の陳腐化を区別しない移送規則が、リセットで設定した新パスワードを捨てて旧 `passwordVerifier` を正本に戻す**（第6.8節 手順2 (2)）。締め出しではなく**認可が開く**方向の破れだが、(R8) と対で直さないと失敗モードが入れ替わるだけなので同じ表に並べる | 第6.1.1節 (R9) — `credentialVersion` が大きい側を正本とし、移送を必ず正本の側へ収束させる（第6.8節 手順2 (2) の4分岐） |

- **意図的に可用性を落とす中間状態は上の一覧に含めない。** credential 変更の `changeState = 'pending'`（旧新どちらのパスワードも通らない。第6.5.1節）と退会の `deleting` は、**利用者の操作の結果として短時間だけ閉じる**ものであり、締め出しではない。

**DO 間 RPC と input gate の再入について。** saga の前進は DO の中から他の DO を `await` することになり、その `await` で input gate が開いて別のリクエストが割り込む（第2.1節 F-18）。これを安全にするための制約を3つ置く。

1. **DO 間 RPC は必ずトランザクションの外で行う。** `transactionSync` のコールバックは完全同期なので（第2.1節 F-7）そもそも `await` を書けず、これは規約ではなく言語と API の制約として自動的に守られる（第8.2節）。
2. **他 DO を呼ぶ前に、自分側の phase を永続化してからコミットする。** 割り込んだリクエストが観測するのは「phase まで進んだ整合状態」だけになる。RPC の結果を受けて次の phase を書くのは、戻ってきた後の別トランザクションである。
3. **再入は「同じ saga が二重に前進する」形で起きうるので、各 phase を冪等にする。** 冪等性の担保は第6.5節（`operationId` + `payloadDigest`）と、各 phase の CAS 条件（予約行の `operationId` 一致、**`account` 行と同じ `operationId` の `operations` 行の組**、`changeState` の値）である。**ロックで再入を止めるのではなく、冪等性で吸収する** — DO は single-threaded なので同期区間の排他は自動的に効き、非同期区間の排他はそもそも取れないからである。

## 7. 非同期処理 ［Issue 要求］

### 7.1 FTS5 の同期更新 ［Issue 要求］

**できる。** 本体更新と FTS5 の更新を同一 SQLite トランザクションで確定させる。

根拠は3つである。

1. **同じ SQLite にある。** User Data DO の `search_entries` / `search_fts` は本体テーブル（`memos` / `documents`）と同一の埋め込み SQLite に置かれる。別ストアではないので、そもそも分散させる理由が無い。
2. **`transactionSync` が原子性を与える。** SQLite のストレージ操作は同期でイベントループを譲らないため原子的に実行され（第2.1節 F-18）、`ctx.storage.transactionSync()` が明示的なトランザクション境界になる（同 F-7）。`sql.exec()` が `BEGIN TRANSACTION` / `SAVEPOINT` を実行できない（同 F-8）ことは制約だが、`transactionSync` を使う限り迂回は要らない。
3. **workerd 上で動くことが実測されている。** 先行ブランチの User Data DO 実装が、本体行の書き込みと FTS 側の更新を同一 `transactionSync` で行い、workerd の統合テストで通っている（第7.2節）。

**したがって Outbox consumer を介したインデックス維持は不要になる。** `spec/adr/005-search-index-via-outbox.md` が定めた「ドメインイベントを Outbox 経由で consumer が受け取り非同期にインデックスを更新する」方式は、その根拠（埋め込み生成が外部 API 呼び出しを伴うこと）と方式そのものの両方が失効する。`.adr/003-sqlite-fts5-only-search.md` が根拠側を、`.adr/004-do-local-commit-and-alarm-jobs.md` が方式側を supersede する。

**書き込みコストの増幅を設計に織り込む。** 仮想テーブルへの書き込みも rows written に算入され（第2.1節 F-15）、trigram はインデックス行数が最も多い部類なので、本体1行の書き込みが FTS 側の多数行書き込みを伴う。ユーザー単位 DO は 10 GB を1人で使う構成なので増幅が直に効く。

**external-content FTS5 を採る。ただし効果の範囲を取り違えない。** `search_fts` を `content='search_entries'` / `content_rowid='rowid'` で作ると、FTS5 の shadow table のうち `%_content`（1ドキュメント1行の本文複製）が消える。**消えるのは容量（本文の二重保持）であって、rows written の主要因ではない** — 書き込み行数を支配するのは `%_data`（インデックスセグメント）であり、trigram はそこの増幅が最大になるトークナイザだからである。したがって **external-content にしても rows written の主要因はそのまま残る**。第4.6節・第10.2節が「容量の見積りは本体の数倍」「コスト試算は本体行数ではなくインデックス行数で行う」と書いているのはこの理解に立っている。

**external-content を採るための実装制約を2つ明記する。** どちらも「同期更新できるか」の成否ではなく実装の正しさに直結し、踏むと**例外が上がらずインデックスだけが黙って壊れる**。

1. **更新・削除は「旧値で delete → 新値で insert」の2段で行う。** external-content の FTS5 は本体行の内容を自分で保持しないので、本体を書き換える前に `INSERT INTO search_fts(search_fts, rowid, <cols>) VALUES('delete', <old rowid>, <old values>)` で旧内容をインデックスから引き算する必要がある。**旧値の読み出しは同じ `transactionSync` の中で行う**（DO では read-your-write が普通にできる。第8.1節）。
2. **`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にし、`id TEXT` を UNIQUE 制約付きの別列にする。** 第4.3節の述語 (b) が「設計上すべてのテーブルが単一列 TEXT の `id` を PK にしている」と書いているとおり、素直に組むと `id` から INTEGER rowid への安定した写像が無く、`'delete'` コマンドの rowid を組み立てられない（**なお `source_links` は複合 PK のままなので、この「すべて」には既に例外が1つある**。第4.2節）。`INTEGER PRIMARY KEY` は真の rowid alias なので **VACUUM でも再採番されず**、「安定した INTEGER rowid」という要求を最も直接に満たす。この形なら `content_rowid` は既定の `rowid` のままでよい。
   - **別列を surrogate にする形を採る場合は、その列に UNIQUE 制約と索引を必須にする。** FTS5 は列値が必要になるたびに content テーブルを `WHERE <content_rowid> = ?` で引く（公式: 「Whenever column values are required by FTS5, it queries the content table」）ので、UNIQUE も索引も無い INTEGER 列にすると、列値取得が発生する経路（`fts5vocab`、整合性検査、将来の `snippet()` 導入）で毎回テーブル全走査になる。
   - `id`（TEXT）と rowid の対応は `search_entries` の中に閉じる。**DO 外の DTO には rowid を出さない** — 安定性は同一 DO 内でのみ意味を持つ値だからである。

**FTS の整合はトリガーではなく projection コードが担う。** SQLite の `CREATE TRIGGER` に寄せない — 本体を書くリポジトリと同じ `transactionSync` の中で projection 関数が明示的に delete → insert を発行する。整合の責任の所在をコード側に置くほうが、両対応の読み取り（第9.3節）や再インデックス（第4.8節）と噛み合うためである。

**ポートの形も変わる。** `SearchIndexPort` から `upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` が消え、読み取りの `query` だけが残る（第4.3節の行10 / 行16）。書き込み側は「本体を書くトランザクションの中で projection を更新する」内部処理へ畳まれ、独立したポートではなくなる。**`IndexerReadPort` は丸ごと消える**（同行9）。`SystemError(EmbeddingFailed)` も消える。

### 7.2 FTS5 のみで日本語全文検索が成立する根拠（`.adr/003-sqlite-fts5-only-search.md` を支える範囲） ［派生］

**成立する。** ただし公式ドキュメントが保証しているのは FTS5 モジュール本体と `fts5vocab` だけである（第2.1節 F-10）。以下は裏付けの種別を明示して積む。

- **正規化（NFKC）。** インデックス側とクエリ側の両方で `String.prototype.normalize("NFKC")` + `trim()` を通す。全角・半角、合成済み文字と結合文字列の差が検索に響かなくなる。**これは自前の処理なので裏付けは不要。** ただし正規化した文字列をインデックスに入れると、スニペットに使う原文とずれる — スニペットは原文側から組み立てる（下記）。
- **トークナイザ（trigram）。裏付けは実測。** `CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='trigram')` が workerd 上で動く。実測の要旨は次のとおり — 「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件を投入し、**3文字の `東京駅` で2件**がヒットし、`周辺` を `limit 1` で2ページに分けて引いたときに1ページ目と2ページ目で別の項目が返ることを確認している。日本語は空白でトークン分割できないので、この trigram の可用性が FTS5 単独案の成否を決める。**公式ドキュメントに記載が無いため、この実測が唯一の根拠である。**（`東京` の2件ヒットは trigram ではなく短語フォールバック側の実測なので、下の項目に付け替えてある。）
- **ランキング（`bm25`）。裏付けは実測。** 先行ブランチの検索アダプターが `bm25(search_fts, 3.0, 1.0)`（タイトルを本文より重く見る重み付け）を使い、workerd 統合テストが通っている。**公式ドキュメントに記載は無い。**
- **スニペット。SQL の `snippet()` / `highlight()` には依存しない。** これらが workerd で使えるかは**未確認**である（第2.1節 F-13）。設計上も使わない — インデックスは NFKC 正規化後のテキストを持つのに対し、利用者に見せるスニペットは原文でなければならないため、**原文から grapheme 単位でマッチ位置を割り出して `<mark>` を挿す**方式を採る。先行実装がこの方式で動いている。したがって `snippet()` の可否は `.adr/003-sqlite-fts5-only-search.md` の成否に影響しない。
- **短語フォールバック。裏付けは実測。** trigram は3文字未満の語をインデックスできない。**1〜2文字のクエリは FTS ではなく `instr()` へフォールバックする** — 述語は `instr(title, ?) > 0 OR instr(body, ?) > 0` の形である。実測の要旨は、上と同じ3件を投入した状態で **2文字の `東京` が2件ヒットする**ことを確認している。
  - **`LIKE` / `GLOB` は採らない。** 実測されているのは `instr()` のほうであり、実測されていない機構を結論に据えない。副次的な利点として、**LIKE / GLOB パターンの 50 バイト上限（第2.1節 F-16）が `instr()` には掛からない** — F-16 は LIKE / GLOB のパターンに限定された制約である。したがって「UTF-8 の日本語は1文字3バイトなので実質16文字が上限」という導出は本設計には効かない。**上限を根拠にした入力長制限は置かない**（入力長の制限は transport 境界の DoS 対策として別途行う。`CLAUDE.md`「Input validation」）。
  - **機構に依らず正しい制約は残す。** `instr()` によるフォールバックは索引を使えない全走査なので、**対象列（`title` / `body`）とページサイズを制限する**。1〜2文字のクエリしかここへ落ちないので、走査量はユーザー1人分の `search_entries` に閉じる。

以上より、**ベクトル検索なしで日本語の全文検索が成立する。** 提供しないのは意味類似検索（表記が異なり字面が重ならない語での想起）だけである。

#### 7.2.1 検索 API の仕様 → #35 へ委譲 ［参考］

**本 Issue では決めない。** topic filter / ゴミ箱除外 / 安定順位 / スニペットの形 / ページングは検索 API の仕様設計であり、`spec/domains/search.md` の改訂（#35）と実装（#37）の領分である。本 Issue が検索について決めたのは第7.1節（同期更新の可否）と第7.2節（`.adr/003-sqlite-fts5-only-search.md` を支える根拠）までである。

先行実装が既に決めている内容を **#35 への入力**として第11.1節へ送る。要旨は次のとおり。

- topic filter は optional な単一トピック。指定時は配下ドキュメントと、その出典になっている active なメモを返す。未知・ゴミ箱内のトピック指定は `TOPIC_NOT_FOUND`。
- 順位の同点は `timestamp DESC, type, id` で決定する。
- ページ間の変更で重複・欠落を出さないため、最初のクエリで結果 DTO を期限付きのスナップショットテーブルへ固定し、不透明なカーソルから同じ集合を読む。
- 検索エントリとトピックは正規化した事実の join で結ぶ。

### 7.3 Outbox / relay / consumer / DLQ の廃止範囲 ［Issue 要求］

Outbox をドメインイベントの transport として使うのをやめる。**relay / consumer / DLQ / pruner をすべて廃止する。**（廃止後の非同期実行契約の正文は第7.7節）

購読者は2つあり、どちらも消える。

| 購読者 | 廃止できる理由 |
|---|---|
| search の indexer consumer | インデックスが本体と同一トランザクションで更新されるので、そもそも配送する必要が無い（第7.1節） |
| 認証アダプターの**トークン失効 consumer**（`identity.aiClientRevoked` を購読） | 失効の権威（AI クライアントトークンは `ai_client_connections.status` と `account.status`、セッションは `account.sessionEpoch`。第5.4節）が User Data DO の中にあり、トークンを持ったリクエストが必ずその DO を叩くので、次のリクエストのガードが直接読める（第5.4.1節 (b)）。書き込み先が `spec/database/index.md` で「スコープ外」とされスキーマが存在しなかった問題も、これで解消する |

**ドメインイベントは「業務・監査の表現」としても残さない。** `UnitOfWorkContext.collectEvents` は廃止する。理由は3つである。

1. 唯一の購読者だった indexer が消え、残る購読者（トークン失効）も直読みへ置き換わるので、**発行された事実を消費する経路が1つも無くなる**。
2. 監査ログが要件として存在しない（`spec/requirements.md` に監査要件が無い）。「将来使うかもしれない」で仕組みだけ残すのは、`.adr/001-integration-tests-single-workers-pool.md` が「理由が消えたら設定も消す」として採った態度と一致しない。
3. `spec/domains/*.md` に広範に書かれているイベント定義は、**リビジョン（`memo_revisions` / `document_revisions`）が業務上の変更履歴を既に持っている**ので、業務表現としての役割も重複している。

**廃止の範囲は application 層のポートに留まらない。ドメイン層のイベント抽象も同時に消える。** 実測した全数は次のとおりである。

- **application 層（削除）** — `packages/core/src/application/ports/outboxRepository.ts` / `relayTrigger.ts` / `idempotencyStore.ts` の3本と、`packages/core/src/application/events/buildDecoder.ts`（37行。Outbox 行の payload を復号する `buildEventDecoder`）。RPC の再送に対する冪等性は `operations` テーブル（第6.5節）が担うので、`idempotencyStore` の役割はそちらへ移る。
- **ドメイン層（削除）** — `packages/core/src/domain/common/event.ts`（81行。`EventId` / `DomainEventDraftBase` / `DomainEventBase` / `DomainEvent` / `EventDraft` / `EventDecoder` / `WithEventDrafts` / `attachEventIds`）と `packages/core/src/domain/identity/events.ts`（62行。`UserRegisteredEvent` / `PasswordChangedEvent` / `TrashRetentionChangedEvent` と `IdentityEvents` ファクトリ）。
- **ドメイン層（改修）** — `packages/core/src/domain/identity/entity.ts`（227行）。`:52` / `:77` / `:103` / `:120` の4つのファクトリが返す `WithEventDrafts<..., IdentityEvent>` という**戻り値の形が変わる**（エンティティだけを返す）。同ファイルは第6.6節の「`User` から認証方式の判別共用体を外す」読み替えでも改修対象なので、2つの理由で同じファイルに手が入る。

**ドメイン層の契約変更として第8.2.1節（ポートの `Promise` 契約の同期化）と同格である。** 一覧に現れないと、#37 が「消えるのは application 層の3本だけ」と読んでドメイン層の型を残す。第11.2節の変更対象一覧に行を足してある。

`spec/domains/*.md` のイベント定義表の削除は #35 の作業になる。改訂量が大きいので第11.1節に明記した。

### 7.4 Alarm ジョブ ［Issue 要求］

1 DO につき Alarm は1本しか持てない（第2.1節 F-2）ので、複数種類のジョブを1つの job table で多重化し、Alarm は「最も早い `nextRunAt`」に張り直す。**本節は第7.7節の契約を DO の Alarm へ具体化した実装規約である（契約の正文は第7.7節）。**

#### ジョブ行が持つ列

| 列 | 用途 |
|---|---|
| `operationKey` | ジョブの同一性。同じキーの再投入は既存行に収束する（収束時の更新規則は下記） |
| `kind` | 実行する処理の種別（下表） |
| `payload` | 実行に必要な値（対象 ID など）。**PII および再利用可能な秘密を入れない** — 生のパスワードリセットトークンが典型で、載せると DB 漏えい時にトークンが使えてしまい、しかも PITR の durable log に30日残る（第2.1節 F-20）。載せるのは `tokenId` だけにし、生トークンは送信直前に bucket の中で導出する（第6.1節 (d)） |
| `payloadDigest` | 同じ `operationKey` に違う payload が来たら `ConflictError`（第6.5節と同じ規則）。**照合対象は `nextRunAt` を除いた payload である**（下記） |
| `attempt` | リトライ回数 |
| `nextRunAt` | 次に実行してよい時刻 |
| `status` | `pending` / `running` / `done` / `poison` |
| `leaseUntil` | claim の有効期限 |
| `ownerToken` | claim した実行主体の識別子。完了は CAS でこれを照合する |
| `providerIdempotencyKey` | 外部 I/O のプロバイダへ渡す冪等キー（第7.6節） |
| `terminalReason` | poison になった理由 |

#### `kind` の全数（DO クラスごとの所有者つき）

| `kind` | 所有者 | 用途 |
|---|---|---|
| `purge-trash` | User Data DO | retention の期限到達処理（第7.5節） |
| `reindex` | User Data DO | FTS5 の全件再インデックス（第4.8節） |
| `migrate-bulk` | User Data DO | データ書き換えを伴う migration（第9.2節・第9.3節） |
| `finalize-withdrawal` | User Data DO | 退会の手順3〜4 を前進させる（第6.7節） |
| `sweep-orphan-mapping` | User Data DO | unlink 後に残った孤児 mapping の削除再試行（第6.6節） |
| `resume-link` | User Data DO | SSO link saga の前進（第6.6節）。手順3 と手順4 の間で落ちたときに `active` な孤児 mapping を回収する唯一の経路である |
| `send-mail` | Directory bucket | 外部 I/O を伴う唯一のジョブ（第7.6節） |
| `resume-signup` | Directory bucket | signup saga の前進（第6.4節） |
| `resume-credential-change` | Directory bucket | credential 変更 saga の前進（第6.5.1節） |
| `sweep-reservations` | Directory bucket | 予約の期限切れ掃除（第6.4節） |
| `sweep-reset-tokens` | Directory bucket | リセットトークンの期限切れ行掃除（第6.1節 (d)） |
| `rotate-encryption` | Directory bucket | メール暗号鍵ローテーションの再暗号化（第6.2.1節 (b-1)） |

**`rotate-remap`（routing secret ローテーションの再写像）は本表に無い。Alarm ジョブではないからである。** 再 HMAC には routing key が要るが、その鍵は「RPC 引数として一時注入し、呼び出しのスコープを出たら破棄する」と定めてあるので（第5.2.3節）、**Alarm 起動時には存在しない**。Alarm ジョブにすると #37 が鍵を bucket の SQLite かインスタンスフィールドに置く実装へ倒れ、第3.2節の秘密の配布境界が壊れる。**したがって `rotate-remap` は operator の maintenance 経路が1チャンクずつ駆動する同期 RPC である**（第6.8節 手順2）。`rotate-encryption` が本表に残るのは、`IDENTITY_MAIL_ENCRYPTION_KEY` が state Worker の常設バインディングで Alarm 起動時にも存在するためである。

**cross-DO saga を前進させるジョブ（`finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link` / `resume-signup` / `resume-credential-change`）は、saga の起点となった側の DO が所有する。** 落ちたときに操作の存在を知っているのは起点側だけだからである（第6.4節・第6.5.1節・第6.6節）。**signup だけは起点側の bucket が複数ありうるので、コーディネーター bucket（安定ソート後の先頭 locator の bucket）が所有する**（第6.3節）。

**`cancel-reservation` と `abandon-account` は本表に現れない。ジョブではなく RPC だからである。** この2本は「前進」ではなく**補償と終端**であり、`resume-signup` ジョブの実行中に同期の RPC として発行される（第6.4節 3・第6.5節）。ジョブ種別を足さないのは、独立した `kind` にすると終端処理が別の Alarm 起動へ持ち越されて「`deleting` へ倒したが mapping が回収されていない」窓が新しく開くためである。**回収と終端は同じジョブ実行の中で順に完了させる。**

**`operationKey` の「収束」の意味を1つに固定する。** 「同じキーの再投入は既存行に収束する」だけでは、`kind` によって逆の更新が要求される。`send-mail` では収束は**重複を捨てて既存行を保つ**ことである（同じ窓で2通目を送らないのが目的。第7.6節）。ところが `purge-trash` では、利用者が `trashRetentionDays` を短くしたときに**既存行の `nextRunAt` を早める**必要がある（第7.5節）。素朴に「既存行を保つ」に倒すと retention の短縮が既存項目に効かず、`spec/testcases/trash/listTrash.md` の遡及適用の期待（第11.1節で「結果は変わらない」と断定した箇所）が実際に破れる。**次の1規則で両方を説明する。**

- **再投入は `nextRunAt` を「早める方向にのみ」更新し、遅らせない。** 既存行の `nextRunAt` より早い値で再投入されたら更新し、同じか遅ければ何も書かずに成功を返す。`send-mail` の連打は同じ窓に対して同じ `nextRunAt` を渡すので何も起きず（＝重複が捨てられ）、`purge-trash` の retention 短縮はより早い `nextRunAt` を渡すので前倒しされる。
- **この収束規則の適用範囲は「外部からの再投入（`enqueueJob`）」に限る。ジョブ自身が完了時に行う再スケジュールには適用しない。** 下の「周期・反復ジョブの再武装規則」がそちらの正本である。**限定しないと第4.1節（`purge_after` の最小値を `nextRunAt` へ写す）・第7.5節（retention 設定変更時に Alarm を張り直す）と正面から矛盾する** — `trashRetentionDays` を**延長**すると `min(purge_after)` は後ろへ動くので、「最小値を写す」と「遅らせない」は同時には成立しない。
- **`payloadDigest` の照合は `nextRunAt` を除いた payload に対して行う。** `nextRunAt` を digest に含めると、前倒しの再投入が `ConflictError` になって上の規則と衝突する。
- **`status = 'running'` の行に対する再投入は `nextRunAt` を書き換えない。** claim 済みの実行を横から動かさないためで、前倒しが必要なら次の完了時に DB の最早 `nextRunAt` を読み直す規則（下記）が拾う。
- **`status = 'done'` / `'poison'` の行に対する再投入は、同じ行を `pending` へ戻して `attempt` を0にし、`nextRunAt` / `payload` / `payloadDigest` を引数の値で置き換える。別行は作らない。** `operationKey` は「そのジョブの同一性」なので、行を増やすと同一性の意味が壊れる。`poison` から戻すのは、`terminalReason` が残る一方で**利用者操作による明示的な再投入まで拒み続ける理由が無い**ためである（`terminalReason` は上書きせず残す）。**この規則が無いと、定数 `operationKey` を持つ周期ジョブが1回完走した時点で prune 保持期間ぶん再投入を受け付けなくなる。**

**周期・反復ジョブの再武装規則（`purge-trash` / `sweep-*`）。** これらは「1回走れば終わり」ではなく、次の期限が来たらまた走る必要がある。**完了時の再計算をジョブ自身の責務として規則にする。**

- **(1) 自分の駆動源を完了トランザクションの中で読み直す。駆動源クエリは「そのジョブの作業述語から時刻条件だけを外したもの」と定義する。** `kind` ごとの対応は次のとおりで、**作業述語と駆動源が同じ行集合を指すことが規則の要である**（ずれると下の (5) の失敗モードが開く）。

  | `kind` | 作業述語 | 駆動源クエリ（時刻条件を外したもの） |
  |---|---|---|
  | `purge-trash` | `WHERE trashed = 1 AND purge_after < ?` | `WHERE trashed = 1` の `min(purge_after)`（`memos` / `topics` / `documents` の3テーブルにまたがるので、3つの最小値のうち最小を採る） |
  | `sweep-reservations` | `WHERE status = 'reserved' AND reservedUntil < ? AND sagaCommitted IS NULL` | `WHERE status = 'reserved' AND sagaCommitted IS NULL` の `min(reservedUntil)` |
  | `sweep-reset-tokens` | `WHERE expiresAt < ?` | `password_reset_tokens` 全行の `min(expiresAt)` |

  **「残件がある」とは、この駆動源クエリの集合が空でないことである。時刻では判定しない。** 残件があれば自分の `nextRunAt` をその `min(...)` へ設定して同じ `operationKey` の行を `pending` へ戻し、**集合が空のときだけ `done` にする**。これは「正常完了時に DB の最早 `nextRunAt` へ張り直す」（下記）と同じ `transactionSync` に入るので往復は増えない。**この再スケジュールには「早める方向にのみ」を適用しない** — 適用すると次の期限が現在の `nextRunAt` より後のときに何も書けず、ジョブが `done` に落ちて二度と起きなくなる。
  - **安全弁: 再計算した `nextRunAt` が現在時刻以前になり、かつその起動での作業対象が0件だったときは、最小再開間隔でクランプする。** 駆動源と作業述語がずれる将来の変更に対する保険であり、ずれても即時再発火の恒久ループにはならず「最小間隔で空回りする」に留まる。**クランプが実際に発火したことはメトリクスに出す**（#38）— 発火は上の対応表が壊れた合図だからである。
  - **`sagaCommitted` 印のある `reserved` 行は作業述語からも駆動源からも外れる。** 回収するのは第6.4節 3 の終端規則（`cancel-reservation`）と、そこで `poison` になった行の運用エスカレーション（#38）であって `sweep-reservations` ではない。**駆動源からも外すのが要点で、外さないと `min(reservedUntil)` が恒久的に過去へ固定される。**
- **(2) `purge-trash` の `operationKey` は定数（DO ごとに1行）にする。** 期限ごとの可変キー（`purge-trash:<purge_after>`）にすると、「早める方向にのみ」が `purge-trash` に対して一度も発火しない条件になり、収束規則を導入した論拠（retention 短縮の前倒し）そのものが成立しなくなる。`sweep-*` も同じく定数キーである。
- **(3) 駆動源が作業述語より広い集合を指すと恒久ループになる。したがって「掃除されないのに時刻列が過去である行」を1つも残さない。** 具体は2点で、どちらも本設計の側で塞いである。**(3-a) ゴミ箱からの復元時に `purge_after` を `NULL` へ戻す**（第7.5節）。戻さないと復元済みの行が過去の `purge_after` を保持し続け、`WHERE trashed = 1` で外れるはずが実装次第で残って `min(purge_after)` を恒久的に過去へ固定する。**(3-b) 駆動源に `status` / `sagaCommitted` の条件を必ず含める**（上の表）。`min(reservedUntil)` を `status` で絞らずに実装すると、phase 3 で `active` へ昇格した**すべての正常ユーザーの予約行**（昇格時に `reservedUntil` を消す規定は置かない — 予約成立の記録として残すため）が駆動源に入り、同じ恒久ループになる。**恒久ループは `alarm()` の即時再発火 → 仕事ゼロ → 同じ過去値で再武装の繰り返しで、`pending` 行が常に1件あるので下の `deleteAlarm()` も発火しない。** `setAlarm` 1回は課金対象の1行書き込みであり（第2.1節 F-24）、Directory bucket なら同一 bucket に写像される全ユーザーを巻き込む。
- **(4) 逆に駆動源を作業述語より狭く（＝時刻条件を残したまま）読むと、1回で `done` に落ちて止まる。** 「残件 = いま処理対象になる行」と読むと、1回の掃除で対象を消し切った時点で `done` になり、**まだ期限の来ていない行に対する次の起動が張られない**。これは (6) が塞ごうとしている事象そのものである。**「残件」の定義を時刻から切り離してあるのはこのためである。**
- **(5) 上の (1) が無いと何が起きるか。** `purge-trash` が期限到達分を消して `done` になった時点で、ゴミ箱にはまだ `purge_after` が未来の項目が残りうる。ところが「正常完了時の張り直し」は `jobs` テーブルだけを読み `purge_after` を読み直さないので、残る `pending` 行が無ければ `deleteAlarm()` が走る。**dormant な User Data DO には次の DO 入力が無いので、次の期限が来ても DO は二度と起きない — ゴミ箱の保持期限が誰にも気づかれずに無期限へ伸びる。** 本節が `finally` を棄却し、先頭再武装を導入し、RPC 経路で `sync()` 失敗時に RPC ごと落とすことまでして塞いだ失敗モードが、retention の本体経路で開いたままになる。
- **(6) `sweep-*` も同じ規則に乗る。** 予約 TTL やトークン期限は行ごとに違うので、1回の起動で処理しきれなかった残りと、まだ期限の来ていない行の**両方**について次の起動が要る。どちらも上の駆動源クエリの集合に入っているので、`min(...)` を書くだけで両方が拾われる（前者は `min(...)` が過去になるので即時再開、後者は最早の期限そのものになる）。**これが無いと第6.4節の TTL 掃除（3段ガードの1段目）が1回きりで止まる。**

**claim と完了の CAS。** 1件ずつ `UPDATE jobs SET status='running', leaseUntil=?, ownerToken=? WHERE operationKey=? AND (status='pending' OR leaseUntil < ?)` で claim し、0行更新なら他が持っているとみなして次へ進む。完了も `WHERE operationKey=? AND ownerToken=?` の CAS で行う。DO は single-threaded なので同一 DO 内で claim が競合することは無いが、**lease は「実行中に DO がリセットされた」場合の回収手段として必要である**（第2.1節 F-4 のエビクション）。期限切れ lease は専用の索引から reclaim する。

**backoff と poison。** 失敗時は `attempt` を進め、指数バックオフで `nextRunAt` を先送りする。上限回数を超えたら `status='poison'` にして `terminalReason` を残し、ホットパスの索引から外す。`done` と `poison` は別々の保持期間で prune し、走査を bounded に保つ。

**`done` / `poison` の prune には専用の `kind` を置かない。ジョブランナーが自分でやる、と断定する。** 「`jobs` 自身を掃除するジョブ」を `kind` に足すと、その行自体が prune 対象になるという入れ子ができ、`kind` の全数表（下記）と第4.1.1節の両方に自己参照が1行増える。**規則は「ジョブランナーは1回の Alarm 起動の末尾で、保持期間を過ぎた `done` / `poison` を最大 N 行だけ削除する」である。** N は内側の行数上限と同じ扱いで #37 → #38 が決める（出発点 1,000行）。削除は `status` と完了時刻の複合索引から引き、走査は bounded に保つ。**この処理はジョブ行を持たないので、下の `kind` 表と第4.1.1節の `kind` 列挙のどちらにも現れない — その理由を本段落が正本として持つ。**

- **`send-mail` の空振り行（mapping が無いか、スロットル中で何も送らずに `done` へ落ちた行。第7.6節）は最も短い保持期間を割り当てる。** 未認証入力で作られる唯一のジョブ行なので、溜めておく価値が無い。具体値は #38（第11.3節）。

**bounded 処理の判定基準は wall time ではなく CPU 予算で書く。** Alarm ハンドラの wall time は15分ある（第2.1節 F-3）が、先に当たるのは CPU 予算である（同 F-4）。しかも **30秒は着信ごとにリセットされる枠であり、着信リクエストの無い Alarm 駆動には戻す契機が無い**（保守的な読みである。公式は FAQ で Alarm を30秒の CPU を持つ invocation として名指ししつつ、リセットの契機としては footnote 4 に挙げていない。第2.1節 F-4b）。さらに超過の帰結はエラーではなく**エビクションとリセット**なので、bounded 処理は「失敗して再試行される」のではなく「途中まで進んで黙って落ちる」形になる。

**時間を測って打ち切る形は採らない。`Date.now()` は Workers では凍結しているからである。** 公式は Spectre 緩和として「`Date.now()` は**最後の I/O の時刻**を返し、**コード実行中は進まない**」と明記している（第2.1節 F-32）。`transactionSync` / `sql.exec()` は同期なので、ローカル SQL だけで完結するジョブ（`purge-trash` / `sweep-*` など）を何件連続で回しても `Date.now()` の差分は1ミリ秒も動かないことがありうる。**したがって「累積経過時間が N 秒を超えたら打ち切る」は、まさに保護が必要な CPU バウンドの列で発火しない。** さらに「CPU ≤ 経過時間だから安全側」という論拠も成立しない — 成立するのは「CPU ≤ **実**経過時間」であって、`Date.now()` の差分は実経過時間ではなく最後の I/O 時刻の差分だからである。I/O 間に費やした CPU はこの測定値に一切現れない。**本設計は経過時間をチェックポイント予算の条件に使わない、と断定する。**

**代わりに「回数」だけで有界にする。3階層の件数上限を置き、CPU を件数の積で押さえる。** 時計を読む実装を1箇所も置かないので、凍結の影響を受けない。

1. **(i) ジョブを1件ずつ処理し、1件ごとに結果をコミットする。**
2. **(ii) 1回の Alarm 起動で処理するジョブ件数に上限を置く**（外側）。上限に達したら残りを次の Alarm へ回す。
3. **(iii) 1件が大きいジョブ（全件再インデックス、bulk migration、退会時の一括削除）はジョブ自身が内部カーソルを持ち、カーソルを進めてコミットしてから次のチャンクへ進む。** ここに**2つの**上限を置く — **(iii-a) 1チャンクで触ってよい行数の上限**と、**(iii-b) 1回の Alarm 起動で同一ジョブについて回してよいチャンク反復回数の上限**である。**(iii-b) で中断するときは、進捗カーソルのコミットと同じ `transactionSync` で `status` を `pending` へ戻し、`ownerToken` と `leaseUntil` を解放してから次の Alarm へ回す。**
   - **「`pending` のまま残す」とは書けない。** claim は `UPDATE jobs SET status='running', leaseUntil=?, ownerToken=? WHERE ...` なので（下記）、**実行中のジョブは必ず `running` である**。`running` のまま残すと、次の Alarm 起動での再 claim 述語 `(status='pending' OR leaseUntil < ?)` がリース満了まで一致せず、**そのジョブだけがリース期間ぶん進捗を止める**。`migrate-bulk` は外側の25件上限が発火しないぶん (iii-b) が唯一の中断点なので（第9.2節）、影響は migration の所要時間に直接出る。
   - これで **lease の用途を「DO がリセットされた場合の回収手段」だけに限定できる**（下記）。

**(iii-b) を落とすと保護が消える。** (iii-a) は1チャンクの大きさを縛るだけで**反復回数を縛らない**ので、「1,000 行ずつ 100 万回」が (i)(ii)(iii-a) のどれにも違反せずに書ける。初版はこの反復回数を外側の累積経過時間で縛るつもりでいたが、上のとおりその測定手段が存在しない。**行数上限と反復回数上限は必ず対で置く。**

**(iii) の対象は内部カーソルを持つ4種 — `reindex` / `migrate-bulk` / `finalize-withdrawal`（退会の一括削除）/ `purge-trash` である。** `purge-trash` を含めるのは、`HardDeletePolicy.expandTargets` の展開件数が利用者のゴミ箱の大きさに比例するためである（第7.5節）。**残り8種（`sweep-orphan-mapping` / `resume-link` / `send-mail` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption`）は1件の仕事量が構造的に有界なので (iii) の対象外である** — ただし `sweep-*` / `rotate-encryption` は1回の起動で処理する行数に (iii-a) と同じ上限を掛け、残りを次の起動へ回す。**「次の起動」を張るのは上の「周期・反復ジョブの再武装規則」であり、`sweep-*` は自分の駆動源（同節 (1) の表。作業述語から時刻条件だけを外したもの）を完了時に読み直して `nextRunAt` を設定する。**

**(iii-a) / (iii-b) の上限値の初期値は #37 が着手時の spike で出し、#38 が運用値として確定する**（第4.8節の export 上限と同じ2段の分担）。目安として (iii-a) は 1,000 行、(iii-b) は 20 チャンクを初期値の出発点にする。**「例外が上がるから検出できる」を前提にした設計にしない。**

**チェックポイントごとにも `sync()` を挟む。** カーソルを進めてコミットしても、その書き込みが write buffer のままリセットされれば進捗は残らない（第2.1節 F-28）。1チャンクを終えて次の Alarm を張り直した直後に `await ctx.storage.sync()` を1回入れる。

**`alarm()` ハンドラの先頭に置くものは2つあり、順序を確定させる。** 本節が「先頭で再武装する」と定め、第9.2節が migration ゲート関数を「全 RPC エントリ**および `alarm()`** の先頭に置く」と定めているので、どちらが先かを書かないと #37 が決められない。**順序は (1) 再武装 + `await ctx.storage.sync()` → (2) migration ゲート → (3) 仕事 である。**

- **再武装を先にする理由。** ゲートを先にすると、ゲート内の DDL が CPU 予算を使い切った場合に本節が塞いだはずの失敗モード（dormant DO の `purge-trash` が恒久停止）がそのまま再発する。再武装は `setAlarm` 1回と `sync()` 1回で、DDL より桁違いに軽い。
- **この順序は第9.2節の制約と両立する。** 同節はゲート関数を「`schema_version` の読み取りから全 DDL ステップの適用まで `await` を1つも挟まない同期関数」と定めており、input gate による排他をその同期性から得ている。(1) の `await` はゲートに**入る前**に完了しているので、ゲート内の同期性は破れない。
- **第9.4節の fail-closed も同じ順序に乗る。** ゲートが「コードより新しい `schema_version`」を検出して仕事を拒否する時点で、(1) の再武装は既に永続化済みである。

**Alarm の再設定規則。** 再武装はハンドラの「先頭」で行い、`finally` を正しさの拠り所にしない。

- **`alarm()` の先頭で、仕事を始める前に「今回の予算が尽きた場合の再開時刻」（`now + 再開間隔`）へ `setAlarm` し、続けて `await ctx.storage.sync()` で永続化を確認してから仕事を始める。** これが本規則の中核である。上で自ら定義した支配的な失敗モード（CPU 予算超過 → **エビクションとリセット**）では isolate ごと殺されるので **`finally` ブロックは走らない**。`finally` に再武装を置くと、その失敗モードでは「プラットフォーム側の alarm も DB からの再設定も、どちらも行われない」状態になる。**dormant な User Data DO では次の DO 入力が来ないので、その `purge-trash` は恒久的に停止し、ゴミ箱の保持期限が誰にも気づかれずに無期限へ伸びる。**
  - **`sync()` を省くと先頭での再武装が同じ失敗モードで失われる。** alarm の操作は他のストレージ操作と同じ規則に従い（第2.1節 F-29）、ストレージ書き込みは **in-memory write buffer へ書かれてディスクへは非同期にフラッシュされる**（同 F-28）。CPU 予算超過は isolate が同期実行の途中で殺される形なので、**フラッシュに必要なイベントループの一巡が起きない** — つまり先頭の `setAlarm` はバッファ上にしかない可能性がある。`finally` を棄却した論拠がそのまま先頭の `setAlarm` にも跳ね返る。
  - **`setAlarm` を `await` して代用しない。** 戻り値は公式ドキュメント内で `void` と `Promise` に食い違っており（第2.1節 F-30）、依拠できない。`ctx.storage.sync()` が pending write のフラッシュ完了を待つ唯一の手段である（同 F-31）。
  - **この `await` は `transactionSync` の外なので第8.2節の同期契約と衝突しない。** 出力ゲートも救わない — output gate が保証するのは**外向きネットワークメッセージ**を書き込み確定まで止めることであって、送信の無い CPU 専従の `alarm()` には効かないからである。
- **正常完了時に DB の最早 `nextRunAt` へ張り直す。** ジョブの変更と「DB 上の最早 `nextRunAt`」の読み取りは同じ `transactionSync` の戻り値にする。`finally` での再設定は正常系・例外系の**最適化**として残してよいが、**正しさの拠り所にはしない**。
- **正常完了時、DB に `nextRunAt` を持つ行が1件も無ければ `deleteAlarm()` する。これは規則の一部であって省略可能な最適化ではない。** 先頭での再武装は「仕事を始める前に必ず次の起動を張る」ので、**張った alarm を明示的に消す手順が無いと、due job がゼロでも DO が再開間隔ごとに永久に起き続ける** — 起きて、先頭でまた張って、仕事ゼロで終わり、また起きる、の恒久ループになる。`setAlarm()` 1回は1行の書き込みとして課金され（第2.1節 F-24）、第10.2節が「コストの主要因は rows written」「`setAlarm` が算入される」と書いているとおり、これは**一度でもジョブを走らせた全ユーザー分**の恒久的な書き込みになる。同時に第7.5節が retention 方式の利点として掲げる「dormant な DO は Alarm でだけ起きる」も崩れる。
  - **`deleteAlarm()` の戻り値にも依拠しない**（第2.1節 F-30 の公式内不整合は `getAlarm` / `deleteAlarm` にも及ぶ）。削除の永続化も `await ctx.storage.sync()` で確認する。
  - **例外は第9.4節の fail-closed 経路だけである。** そちらは「ジョブを実行せずに一定間隔で `setAlarm` を張り直す」＝**意図的に消さない**経路なので、本規則の対象外であることを同節に明記してある。
- **通常の DO 入力（RPC）での再設定は、DO facade のラッパーが `run()` の戻り後に発行する。実行主体をここで名指しする。** `enqueueJob` は `UnitOfWorkContext` の同期メソッドでトランザクション内に閉じる（第8.2節）一方、`setAlarm` はトランザクションの外なので、誰がいつ呼ぶかを決めないと #37 に落ちる。**規約は次の3点である。**
  - **(1) `run()` の戻り後、`await` を1つも挟まずに `setAlarm` を発行し、続けて `await ctx.storage.sync()` を1回入れる。** `run()` の書き込みと `setAlarm` を同じフラッシュ単位に収めるためである。第2.1節 F-28 の「すべての書き込みが保存されているか1つも保存されていないか」は**バッファ内容についての保証**であって、`await` を跨いだ2回のフラッシュを1単位にする保証ではない。
  - **(2) 既存 alarm との比較に `getAlarm()` を呼ばない。** 戻り値の同期性が公式内で食い違っており（第2.1節 F-30）、`await` すると (1) が破れる。代わりに **DO インスタンスのフィールドに現在の alarm 時刻を保持して比較する** — DO は1インスタンス = 1ユーザー（または1 bucket）なので保持できる。フィールドが未初期化なら（コールドスタート直後）比較せず無条件に `setAlarm` する。
  - **(3) `sync()` が失敗したら RPC 自体を失敗させる。** 「設定に失敗したら次の DO 入力で DB から最早時刻を再計算する」という回復策は **dormant な User Data DO には効かない** — 次の DO 入力が来ないからである。本節が `finally` を棄却した論拠（「利用者がメモをゴミ箱に入れて二度と戻ってこない」と `purge-trash` が恒久停止する）がそのまま RPC 経路にも当てはまる。**利用者にリトライさせるほうが、保持期限が黙って無期限へ伸びるより良い。**
  - 過去または現在時刻の due job は同じ入力中の即時発火と競合しないよう、DB の `nextRunAt` は変えずにプラットフォーム側の alarm だけを現在時刻の1秒後へ clamp する。
- **`alarm()` から throw しない**（**第7.7節 項5 を DO の Alarm に適用したもの**。規則の正文はそちら）。ここで補うのは根拠だけである — 公式のリトライは「`alarm()` ハンドラが throw したとき」に初回2秒からの指数バックオフで**最大6回**であり（第2.1節 F-2）、使い切ると alarm は消えて次の DO 入力があるまで何も起きない。
- **エビクション時の再配信は保証ではない。** 公式は「予期せぬエラーで DO が終了した場合、`alarm()` ハンドラは別マシンで**再インスタンス化されうる（may）**」としか書いていない。"may" に寄りかからず、先頭での再武装で自力で担保する。
- `waitUntil` は DO の中では効かない（第2.1節 F-22）ので、Alarm 以外の遅延実行手段を使わない。

**チェックポイント予算の測り方と初期値。予算は3階層で、すべて件数である。** CPU 予算が真の制約だが、**Workers / DO には残り CPU 時間を実行時に読む API が無く、`Date.now()` も凍結している**（第2.1節 F-4 / F-32）。したがって**3階層とも保守的な固定件数で近似する**。階層が違うので打ち切り条件は二重にならない。

| 階層 | 単位 | 初期値 | 決める主体 |
|---|---|---|---|
| **外側（ジョブランナー）** | 1回の Alarm 起動で処理するジョブ件数 | **ジョブ25件** | 本設計で固定。見直し契機は #38 |
| **中間（1ジョブの1回の起動で回すチャンク数）** | 同一ジョブについて連続で回してよいチャンク反復回数 | ジョブ種別ごとに持つ（出発点 **20 チャンク**） | #37 が spike で根拠値 → #38 が運用値 |
| **内側（1チャンクで進めるカーソル）** | 1チャンクで触る行数 | ジョブ種別ごとに持つ（出発点 **1,000行**） | #37 が spike で根拠値 → #38 が運用値 |

**外側の「25件」は先行案（第1.3節）が採っていた値をそのまま引き継いだものである。** 先行案は「25件 または 累積経過時間10秒のいずれか早い方」だったが、**経過時間の側は第2.1節 F-32 により発火しないので捨てた**（先行ブランチの実装 `while (processed < 25 && Date.now() - startedAt < 10_000)` は、凍結する時計をそのまま使っている形である）。件数側だけを残し、失われた保護を中間階層の反復回数上限で置き換えた。**1回の Alarm 起動で触る行数の上界は「25 × 中間上限 × 内側上限」で静的に決まる**ので、時計を読まずに CPU が有界になる。初期値を見直す契機は #38 の運用監視（エビクション由来の進捗停止をどう検知するか）へ送る。

**同じジョブ機構を Identity Directory bucket にも適用する。** 「1 DO につき Alarm は1本」はどのクラスにも効き、bucket 側にも上表の6種類（`send-mail` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption`）が要る。**job table と Alarm の実装は2クラスで共有する**（`packages/core/src/adapters/cloudflare/*` の共通モジュールとして #37 が置く）。

### 7.5 trash retention の期限処理 ［Issue 要求］

全ユーザー横断の `TrashQueryPort.listExpiredItems(now, limit)` を、**各 User Data DO の Alarm に置き換える**。

置き換え対象はポート1本だけではない。その実現手段である **`user_id` を含まない部分インデックス3本（`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`）と `users` との全ユーザー JOIN も道連れになる**（第4.3節の行17 / 行18）。DO の中では「自分のユーザーの期限」しか無いので、JOIN する相手が存在しない。

- **期限の持ち方。** ソフトデリート時に `RetentionPolicy.expiresAt` 相当を計算して `purge_after` 列に保存する。現行 spec は期限を保存せず毎回算出する純関数にしているが、**DO では保存する** — Alarm を張る時刻を決めるために「最も早い期限」を索引で引く必要があるためである。算出規則そのもの（`RetentionPolicy`）は変えない。
- **Alarm の張り方。** ソフトデリート時に「`purge_after` の最小値」を求め、それが現在の最早 `nextRunAt` より早ければ `purge-trash` ジョブを投入する（第7.4節の収束規則に乗る。**外部からの再投入なので「早める方向にのみ」が効く**）。`operationKey` は DO ごとに定数である（第7.4節）。
- **完了後の再武装はジョブ自身が行う。** `purge-trash` は完了トランザクションの中で駆動源（`WHERE trashed = 1` の `min(purge_after)`）を読み直し、その集合が空でなければ自分の `nextRunAt` をそこへ設定して `pending` へ戻す（第7.4節「周期・反復ジョブの再武装規則」(1)）。**これが無いと1回目の完走で `done` になり、dormant な DO は次の期限が来ても二度と起きない。**
- **ゴミ箱からの復元時に `purge_after` を `NULL` へ戻す。** `trashed` を解除するのと同じ `transactionSync` で行う。戻さないと復元済みの行が過去の `purge_after` を保持し続け、駆動源クエリの実装が `trashed` 条件を落とした場合に `min(purge_after)` が恒久的に過去へ固定されて第7.4節 (3-a) の恒久ループになる。**`purge_after` は「ゴミ箱にある間だけ意味を持つ列」であり、`trashed` と必ず同時に設定・解除する**（`trashed = 1` ⇔ `purge_after IS NOT NULL` を不変条件とする）。
- **retention 設定の変更時。** `TrashRetentionDays` は `User` の属性なので変更も同じ DO 内で起きる。変更したトランザクションの中で **ゴミ箱内の全項目の `purge_after` を一括再計算し**、最早値を求めて Alarm を張り直す。**延長方向（`min(purge_after)` が後ろへ動く）もここに含まれるので、この張り直しはジョブ自身の再スケジュールと同じ扱いにし、「早める方向にのみ」を適用しない**（第7.4節）。ゴミ箱の件数は利用者1人分なので一括更新で足りる（件数が大きい場合は第7.4節のチェックポイント分割に乗せる）。
- **DO が長期間アクセスされない場合。** Alarm は DO を起こすので、利用者がアクセスしていなくても期限処理は走る。これは cron ベースの pruner より強い保証である（cron は「全ユーザーを1バッチで舐める」ので、ユーザー数が増えると1周の遅延が伸びる）。
- **`pruneExpiredTrashItems` ユースケースは消える。** pruner 専用の拡張 `WorkerContainer`（第4.3節の行30）も同時に消える。ハードデリートのロジック（`HardDeletePolicy.expandTargets` による展開、リビジョンと出典リンクの消去）は DO 内のジョブ実行部へ移る。
- **`purge-trash` は内部カーソルを持つジョブである。** `expandTargets` の展開件数は利用者のゴミ箱の大きさに比例するので、第7.4節 (iii) の対象に含める（`reindex` / `migrate-bulk` / `finalize-withdrawal` と同じく、1チャンクの行数上限とチャンク反復回数上限を種別ごとに持つ）。retention 設定の変更に伴う `purge_after` の一括再計算も同じカーソルに乗せる。

### 7.6 外部 I/O を永続ジョブに残す境界 ［Issue 要求］

**本節が決めるのは「外部 I/O をどこに置くか」の境界であって、`jobs` テーブルに載る `kind` の全数ではない**（全数の正本は第7.4節。12種のうち11種はローカル完結のジョブである）。**外部 I/O を伴う処理は必ず永続ジョブに載る**（DO のローカル SQLite だけでは完了できないため）。現時点で該当するのは**メール送信の1件だけ**である。**本節は第7.7節 項2・項3 を具体化したものである（契約の正文は第7.7節）。**

線引きの規則は「トランザクションの中で外部 I/O をしない」に尽きる。`transactionSync` のコールバックは完全同期なので（第2.1節 F-7）、そもそも `fetch` を呼べない。したがって外部 I/O は必ず「トランザクションでジョブ行を書く → コミット後に Alarm が拾って実行する」形になる。逆に、外部 I/O を伴わない処理は**外部 transport（Queue / relay / consumer）を要さない** — FTS 更新は本体更新と同じ `transactionSync` の中で完結し、retention のハードデリート（`purge-trash`）と saga の前進（`resume-*` / `sweep-*` / `finalize-withdrawal`）は**同一 DO の `jobs` 行と Alarm で駆動する**。**後者は「ジョブに載らない」という意味ではない** — いずれも第7.4節の `kind` 表に行を持つ。消えるのは DO をまたぐ transport であって、ジョブ行そのものではない。

**メール送信ジョブの所有者は Identity Directory bucket にする。** 理由は2つ。

1. **パスワードリセットメールは `userId` 未確定の経路から始まる。** 「このメールアドレスの持ち主にリセットリンクを送る」という操作なので、起点は canonical credential であり、所有者が User Data DO でありえない。
2. **宛先の原本を持つのが bucket だけである**（第6.2.1節 (a)）。`encryptedCanonical` を復号できるのは state Worker で、その復号が許される経路の1つがこのジョブである（同 (c)）。

**provider 冪等キーの扱い**（**第7.7節 項3 をメール送信に適用したもの**。規則の正文はそちら）。ここで補うのは受容判断だけである — プロバイダ側が冪等キーを解釈すれば二重送信は抑止され、解釈しない場合でも「リセットメールが2通届く」で済む。利用者影響が小さく、逆に届かないほうが有害なので at-least-once を選ぶ。

**登録の有無によらず同じ成功レスポンスを返す。** 手段は「ダミージョブ行を書く」である。

- **mapping が無い場合も、ジョブ行を書いて即 `done` にする。** 「ジョブを投入せずに成功を返す」と「同じ処理経路を通す」は両立しない — ジョブ行の書き込み（SQLite write + `setAlarm`）は測定可能な処理時間差であり、**登録済みメールの列挙オラクル**になる。第5.3節の login はダミー検証材料で計算量を揃える具体策まで書いているので、リセット側も宣言だけで終わらせない。
- 具体的には、mapping の有無にかかわらず (i) 同じ `transactionSync` でジョブ行を1行書き、(ii) 同じ `setAlarm` を発行し、(iii) 同じレスポンスを返す。**違うのは `kind` ではなく行の中身だけ**で、mapping が無い場合の行は宛先を持たないため Alarm が拾った時点で何も送らずに `done` へ落ちる。
- **ジョブ行が持つのは `tokenId` だけである。生のリセットトークンは載せない。** 送信直前に bucket の中で `HMAC(IDENTITY_RESET_TOKEN_KEY[generation], tokenId)` から導出する（第6.1節 (d)）。第7.4節の `payload` 制約が「PII **および再利用可能な秘密**を入れない」なのはこのためである。
- 「レスポンスを固定遅延で返す」案は採らない。遅延の見積りが環境依存で、しかも DO を単純に占有する（single-threaded なので他リクエストを止める）ためである。書き込み1行のコストのほうが安く、確実である。
- 加えて **canonical 単位のレート制限**（第6.2.2節 (b)）が掛かるが、**スロットル中でもジョブ行は必ず書く。** 「レート制限時はジョブを投入しない」と本節の「必ず1行書く」は両立しないので、第6.2.2節 (b) を本節に合わせて書き直してある — スロットルは「行を書かない」ではなく「書いた行を送らない側に倒す」で表現する。**登録済み / 未登録 / スロットル中の3ケースで処理経路が完全に一致する**のがこの規則の目的である。
- **同じ canonical への連打はジョブ行1本に収束する。登録済みでも未登録でも同じである。** `operationKey` を「対象 canonical の全長 HMAC + 依頼の窓」から決定的に導くので、第7.4節の「同じキーの再投入は既存行に収束する」がそのまま効く（第6.2.2節 (b)）。
  - **収束するのは同一 canonical への連打だけである。断定をそこへ限定する。** 攻撃者が毎回異なるアドレスを投げれば bucket の `jobs` に行は増え続ける。第6.2節が「異なる canonical を大量に投げる攻撃にはレート制限で対処する」と決めているとおり、**この経路の第一防壁は第6.2.2節 (c) の WAF / Rate Limiting Rules であって Directory ではない。** 加えて DO の書き込みは PITR の durable log に30日残る（第2.1節 F-20）ので、prune しても記録そのものは消えない。
  - **したがって空振り行（宛先を持たず即 `done` へ落ちる行）には最も短い保持期間を割り当てる**（第7.4節の prune 規則）。具体値は #38（第11.3節）。
- PII をログに出さない（第5.2節 (c)）。未認証経路なので `userId` も出さない（同節）。

### 7.7 Outbox 廃止後の非同期実行契約（正文） ［派生］

`CLAUDE.md`「Key concepts」の **Outbox / domain events** の項が定めている現行契約 —— 「Delivery is at-least-once with no ordering guarantee; consumers must be idempotent」 —— の置き換えである。**本節が正文であり、第7.3節・第7.4節・第7.6節・第8.2節・第8.4節はここへ帰着する。#35 は本節を `CLAUDE.md` へ写す**（第11.1節）。

**参照は双方向にしてある。** 上の5節（第7.3節・第7.4節・第7.6節・第8.2節・第8.4節）は**それぞれ節の冒頭に**「契約の正文は第7.7節」を持ち、規則そのものを重複して書かない — 第7.4節の「`alarm()` から throw しない」は本節 項5 の適用、第7.6節の `providerIdempotencyKey` は本節 項3 の適用、第8.4節の OCC 非リトライは本節 項6 として畳んである。**規則を改訂するときは本節だけを直す。**

1. **ドメインイベントという transport は存在しない。** `UnitOfWorkContext.collectEvents` も Outbox も relay も consumer も DLQ も無い（第7.3節）。トランザクション内で完結する副作用（FTS5 projection、retention のハードデリート、saga の phase 前進）は、その `transactionSync` の中で直接行う。
2. **外部 I/O を伴う処理は必ず永続ジョブに載せる**（トランザクション内では実行できないため。第7.6節）。**加えて、期限処理・チェックポイント分割を要する一括処理・cross-DO saga の前進も同じ `jobs` テーブルと Alarm で駆動する。`kind` の全数は第7.4節が正本である**（12種のうち外部 I/O を伴うのは `send-mail` の1件だけで、残り11種はローカル完結のジョブである）。**「永続ジョブに載るのは外部 I/O を伴う処理だけ」と書いてはならない** — 初版はそう書いており、第7.4節の `kind` 全数表と正面から矛盾していた。**外部 I/O は「必ず載る」側の条件であって、載るものの全数ではない。**
3. **ジョブ実行は at-least-once である。** 1 DO につき Alarm は1本で（第2.1節 F-2）、`jobs` テーブルの `nextRunAt` 順に逐次処理する。送信に成功した直後に DO がリセットされうるので、**ジョブ実装は冪等でなければならない**。外部プロバイダへは `operationKey` から決定的に導いた `providerIdempotencyKey` を渡す（第7.6節）。
4. **ジョブ間に順序保証は無い。** 同一 DO 内では `nextRunAt` 順に取り出すが、これは実行順の保証ではない — 失敗ジョブはバックオフで先送りされ（第7.4節）、DO をまたぐジョブ（cross-DO saga の前進）には共通の時計も共通のキューも無い。**種別の異なるジョブの相対順序に依存する設計を書かない。** 順序が必要な箇所は、ジョブ間の順序ではなく**状態機械の phase と CAS 条件**で表現する（第6.3節・第6.5.1節・第6.9節）。第6.4節の「予約 TTL 掃除と saga 再開の競合」は、この順序保証の不在が具体化した例であり、3段のガードで塞いである。
5. **リトライはジョブランナーが持ち、プラットフォームには委ねない。** `alarm()` から throw しない（throw に対する公式のリトライは最大6回で、使い切ると alarm ごと消える。第2.1節 F-2）。個々のジョブの失敗は `try / catch` で吸収し、`attempt` と `nextRunAt` を進める。これが `CLAUDE.md`「worker → root」で許されている唯一の広い catch にあたる。上限超過は `poison` にして `terminalReason` を残す。
6. **OCC 競合は再試行しない。** `ConflictError("OPTIMISTIC_LOCK_FAILURE")` は握り潰さず、ユースケースを通ってトランスポート境界（またはジョブの `terminalReason`）まで届ける。アプリケーション層の OCC リトライデコレーターは置かない（第8.4節。`CLAUDE.md`「Retry strategy」の方針をそのまま維持する）。
7. **リクエスト跨ぎの冪等キーをクライアントに持たせない。** `operationId` はサーバー側でのみ採番する（第6.3節・第6.5節）。リクエスト跨ぎの冪等性は Directory bucket の予約行と `credential_mappings.changeState` が担う。

## 8. UoW 契約 ［Issue 要求］

### 8.1 現行契約と D1 固有物の棚卸し ［派生］

現行の `packages/core/src/application/execution/unitOfWork.ts` は19行で、`UnitOfWorkContext { userRepository; collectEvents(drafts) }` と `UnitOfWorkProvider { run<T>(fn) }` だけを持つ。`run` はコールバックだけを受け、**テナント / ユーザーのスコープを受け取る引数が構造上存在しない**。

D1 実装（`packages/core/src/adapters/d1/`）が持ち込んでいる次の3つは、**存在理由が「D1 に interactive transaction が無い」ことだけ**なので DO では丸ごと不要になる。

| 対象 | 何をしていたか | 廃止できる理由 |
|---|---|---|
| `packages/core/src/adapters/d1/pendingBatch.ts` の **deferred-batch モデル** | 未 await の Drizzle クエリビルダを配列に溜め、コールバック完走後に `db.batch()` で一括フラッシュする。この契約を明記した JSDoc は `pendingBatch.ts`（98行）ではなく **`packages/core/src/adapters/d1/unitOfWork.ts:39`** にある（"Read-your-write within the same UoW is unsupported by design"） | `transactionSync` が本物のトランザクションを与えるので、**同一 UoW 内の read-your-write が普通に書けるようになる** |
| `packages/core/src/adapters/d1/schema.ts` の **`_occ_guard` テーブル** | OCC 書き込みの直後に0行マッチを CHECK 違反へ変換してバッチ全体を abort させる仕掛け。D1 が「`UPDATE ... WHERE version = ?` の0行マッチ」を正常成功として扱うことへの回避策 | トランザクション内で `UPDATE` の変更行数を直接読めるので、CHECK 違反へ変換する必要が無い（第8.4節） |
| `packages/core/src/adapters/d1/repositories/helpers.ts` の **メッセージ部分一致による OCC 検出** | D1 が CHECK 違反をエラーメッセージ文字列でしか返さないため、`isOccGuardViolation`（`helpers.ts:55-69`）がエラーチェーンを辿って `OCC_GUARD_CHECK_NAME`（= `"occ_guard_positive"`。`schema.ts:118`）**だけ**を `String.includes` で照合していた（`CHECK constraint failed: ` の前置きは含めない）。コメント自身が「メッセージから CHECK 名が落ちると degrade する」と脆さを自認している | 同上。文字列マッチが消える |

**UNIQUE 違反の翻訳点がユースケースに漏れている問題**（`packages/core/src/application/identity/registerWithPassword.ts` の `catch` ブロック）も、同じ理由の派生である。第8.5節で扱う。

### 8.2 新しい UoW 契約 ［Issue 要求］

`run` を**完全同期**にする。**非同期実行契約の正文は第7.7節であり、本節はそのうち「トランザクション内で完結する副作用」（項1）の実装契約にあたる。**

```ts
export interface UnitOfWorkContext {
  userSettingsRepository: UserSettingsRepository;
  memoRepository: MemoRepository;
  // ... その DO が持つ集約のリポジトリ

  // トランザクション内の副作用登録点（`collectEvents` の後継）
  enqueueJob(kind: JobKind, operationKey: string, payload: JobPayload, nextRunAt: number): void;
  recordOperation(
    operationId: string,
    kind: OperationKind,
    payloadDigest: string,
    phase: OperationPhase,
    targetLocators?: readonly LocatorRef[],
  ): void;
  updateOperation(
    operationId: string,
    patch: Readonly<{
      phase?: OperationPhase;
      targetLocators?: readonly LocatorRef[];
      terminalReason?: string;
    }>,
  ): void;
  setMigrationCursor(targetVersion: number, step: number, cursor: string): void;
}

export interface UnitOfWorkProvider {
  run<T>(fn: (ctx: UnitOfWorkContext) => T extends Promise<unknown> ? never : T): T;
}
```

#### 決定事項

- **`run` はスコープ引数を取らない。** DO インスタンスそのものがスコープであり、`userId` は DO 選択の時点で消費済みである（第4.5節）。現行の「スコープを受け取る引数が無い」という形はそのまま維持され、**意味だけが「根拠が示されていない」から「DO が境界なので不要」へ変わる**。
- **`collectEvents` は消えるが、その位置を `enqueueJob` が引き継ぐ**（第7.3節）。`collectEvents` が占めていた「**トランザクション内の唯一の副作用登録点**」というスロットは空にしない。設計の複数箇所が「ジョブ投入は本体更新と同一 `transactionSync` に入っていなければ意味がない」ことを要求している — 第7.5節（`purge_after` の最小値から `purge-trash` を投入）、第7.6節（外部 I/O は必ずトランザクションでジョブ行を書く）、第6.2.2節 (b)（レート制限時もジョブ行を必ず書く）、第9.2節（migration ゲートの中でのジョブ投入）。
  - **`jobs` / `operations` はドメイン集約ではないので、リポジトリとしてではなく専用メソッドとして配る。** 第4.1.1節はこの2つを集約テーブルとは別の用途で並べており、第4.2節も「ジョブ / 冪等化状態」を集約の表とは別行で扱っている。`operations` の CAS（`operationId` + `payloadDigest` + phase。第6.5節）も同じ位置に置く。
  - **`migration_progress` のカーソル更新も同じ位置に置く**（第9.3節。`setMigrationCursor`）。`ctx.storage.sql` を usecase から直接触る形は採らない — レイヤー違反であり、UoW を通らない書き込み経路を作るからである。
- **上のメソッド列挙は「その DO が持つ非集約ストア（`jobs` / `operations` / `migration_progress`）への書き込み口の全数」である。** リポジトリ側は DO ごとに増減する（コメント行の `// ... その DO が持つ集約のリポジトリ`）が、非集約ストア側は**ここに書かれたものが全数であり、新しい非集約ストアを足したら必ずメソッドを1本足す**。`ctx.storage.sql` の直接使用を禁じている以上、書き込み口をここに列挙しないと、そのテーブルは**書く手段を持たないまま第4.1.1節に載る**ことになる。
  - **`recordOperation` に `targetLocators` を、`updateOperation` を、それぞれ足した理由。** 第4.1.1節は `operations` の列に `targetLocators`（配列）と `terminalReason` を挙げ、第6.6節は link 手順1 でその記録を、unlink 手順2 で「削除する前に消す行の locator を全世代分退避する」ことを要求している。これが `sweep-orphan-mapping` の**唯一の逆引き情報**である（第6.6節末尾）。初版の `recordOperation(operationId, kind, payloadDigest, phase)` ではこの2列を書けず、代替経路（`ctx.storage.sql` の直接使用）も同じ節で閉じていたので、**第6.9節が締め出し経路として登録している孤児 mapping の回収を実装する手段が契約の側に無かった**。`phase` の前進（`'reserving'` → `'done'`）と終端（`terminalReason`）も `updateOperation` が担う。
  - **`LocatorRef` は「`credentialId` + `kind` + 全長 HMAC + 世代 + bucket index」のプレーンなオブジェクトである**（第4.1.1節の `operations.targetLocators`）。ブランド型を含めない（第8.3節 (e) と同じ理由）。
  - **`operations.createdAt` と `migration_progress.updatedAt` は引数に取らない。** どちらも実装側（アダプター）が書く時刻列で、`UnitOfWorkContext` は clock を持たない（clock はコンテナ側のポートであり、同期コールバックの中へ持ち込む必要が無い）。**時刻を usecase から渡す形にすると、同じ `transactionSync` の中で2つの時刻源が混ざる。**
- **`UnitOfWorkContext` に載せてよいものは「禁止の形」で書く。** 載せてはいけないのは**非同期ポート**（`MailSender` / `PasswordHasher` / DO stub factory / `fetch` を持つ任意のポート）である。「リポジトリしか載せない」という肯定形は許可対象を過度に狭め、上の `enqueueJob` を排除してしまう。
- **同期 commit を型で表す。** コールバックの戻り値型に `T extends Promise<unknown> ? never : T` を課すと、`async` 関数はコールバックとして渡せなくなる（`async` 関数の戻り値は必ず `Promise` なので `never` に落ちる）。
- **transaction に Promise / 暗号 / RPC / メールを持ち込ませない構造。** 上の型で `async` を排除すると、**コールバックの中では `await` が構文エラーになる**。これはライブラリの規約ではなく言語の規則なので、コマンドオブジェクトを介した間接化より強い保証が得られる。加えて、上の禁止により非同期ポートへの**到達手段そのものが無い**。
  - 根拠として押さえておくべき事実がもう1つある。**SQL カーソルは `await` を跨いで保持するとスナップショット分離が保証されない**（第2.1節 F-9）。同期を型で強制することは、この落とし穴を構造的に踏めなくすることでもある。
- **ネストした UoW は型で禁じない。** `transactionSync` のネスト可否は公式に記載が無く（第2.1節 F-14）、`sql.exec()` が `SAVEPOINT` を実行できない（同 F-8）ので迂回路も無い。**`run` の中でさらに `run` を呼ばない**という規約を置き、`UnitOfWorkContext` から `UnitOfWorkProvider` へ到達できないようにして構造で担保する。#37 は SAVEPOINT による回避を試みない。

#### 8.2.1 既存ドメインポートの Promise 契約との整合 ［派生］

`packages/core/src/domain/common/transactionalRepository.ts` の `TransactionalRepository` と `packages/core/src/domain/identity/ports/userRepository.ts` の `UserRepository` は、**全メソッドが `Promise` を返すドメイン層のポート**である。`transactionSync` のコールバックは完全同期なので、両立しない。選択肢は3つある。

- **(a) 署名を同期に変える。**
- **(b) 書き込みをポートから外し、commit command 側へ寄せる**（先行案の `SemanticCommitPort`）。
- **(c) `transactionSync` ではなく `ctx.storage.transaction(closure)` を使い、コールバックを `async` のまま保つ**（第2.1節 F-27・F-27b）。

採るのは **(a)** である。

**(b) を採らない理由**は、(b) が目指す保証（transaction に Promise と外部 I/O を持ち込ませない）が **(a) でも `async` の排除だけで達成でき、しかもそちらのほうが強い**からである（第8.2節）。(b) は加えて次の代償を払う — usecase が「読んで判断して書く」形を書けなくなり、すべての書き込みをコマンド DTO に翻訳する層が増える。DO では read-your-write が普通にできる（第8.1節）のに、それを自ら捨てることになる。

**(c) を採らない理由**は、**`transaction()` が「非同期でも原子性が保たれる」ことを意味しないから**である。本設計で最も高価な決定（ドメインポートから `Promise` を剥がす）の根拠なので、棄却を記録しておく。

1. **公式が原子性の条件を `await` の不在に置いている。** 同じページが「**明示的なトランザクションはもはや必要ない。`await` を挟まない書き込み列は自動的に原子的に提出される**」と述べ、SQLite-backed では「`txn` オブジェクトは obsolete で、`ctx.storage` に対する操作 — `ctx.storage.sql.exec()` を含む — がトランザクションの一部として扱われる」としている（第2.1節 F-27）。つまり `transaction()` は「`await` を挟んでも原子性を守る仕組み」ではなく、`await` を挟まない書き込み列に対する明示的な別名でしかない。
2. **`await` を挟むと input gate が開き、割り込んだ別ハンドラの `ctx.storage` 書き込みまで同じトランザクションに巻き込まれる**（第2.1節 F-18 + F-27 の「`ctx.storage` への操作はトランザクションの一部」）。これは「トランザクション境界がアプリケーションの意図と一致しない」という、第8.3節 (a) が remote repository 案を棄却したのとまったく同じ破れ方である。
3. **SQL カーソルは `await` を跨ぐとスナップショットの安定性を失う**（第2.1節 F-9）。read-modify-write の read 側が壊れる。
4. したがって (c) を採っても、**結局「コールバック内で `await` しない」という規約を人手で守る**ことになる。それなら `async` を型で排除して**言語の規則として守らせる**（第8.2節）ほうが強く、しかも実行時のコストが同じである。

**棄却は F-27b（コールバックを `async` にできるか）の未確認に依存しない。** 上の (1)〜(4) はいずれも「原子性の条件が `await` の不在の側にある」という**公式記載**（F-27）だけで完結している。**仮に spike の結果が「`transaction()` のコールバックも同期必須」であれば、(c) はそもそも選択肢として存在しなくなるので棄却はより強くなる。** どちらに転んでも (a) を採る結論は動かない。

**(c) の棄却は「`transaction()` を知らなかった」からではない。** #37 が着手時にこの API を見つけて「これで済むのでは」と設計を再開させないよう、ここに理由を残す。

##### 変わるもの

| 対象 | 変更後 |
|---|---|
| `TransactionalRepository<TEntity, TId>` | 全メソッドから `Promise` を外す。`insert(entity): void` / `findById(id): Versioned<TEntity> \| null` / `save(entity, expectedVersion): void` / `delete(id, expectedVersion): void` |
| `Versioned<T>` / `ExpectedVersion<T>` | **そのまま残す。** OCC は残すため（第8.4節）。ブランド型による「読まずに書く」の型エラー化も維持する |
| `UserRepository` | 同期化する。加えて第4.5節の読み替えで `userId` 引数が落ち、第6章の分裂（認証情報は Directory、設定は User Data DO）で2つのポートに割れる |
| memo / knowledge / trash / export の各ポート（未実装） | 最初から同期契約で定義する |
| `PasswordHasher` / `MailSender` | **`Promise` のまま。** どちらもトランザクションの外で動く（第4.8節・第7.6節） |
| `SearchIndexPort` | `query` だけが残り、同期契約になる（第7.1節） |

**`CLAUDE.md`「Reference runtime」の明言が実際に破れる箇所がここである。** 「ランタイムを差し替えても `domain` / `application` / `presentation` は無傷」は成立しなくなる — ドメイン層のポート契約が同期に変わり、非同期 I/O を前提とするランタイムでは実装できなくなるからである。これは `.adr/002-cloudflare-workers-and-user-data-durable-objects.md` が受け入れた Cloudflare へのロックインの具体的な現れ方であり、**隠さずに `CLAUDE.md` の記述を直す**（改訂は #35。第11.1節）。変わるファイルの一覧は第11.2節。

### 8.3 ユースケースの実行位置と Worker RPC ［派生］

#### (a) usecase は DO の中で実行する

ただし例外を明示する。

request Worker で usecase を実行して remote repository を注入する形は採らない。リポジトリ・UoW のコールバック・SQLite の transaction capability はいずれも RPC 越しに運べず、アプリケーションのトランザクション境界と実際の DO トランザクションが一致しなくなるからである。

DO の中で実行しないものは次の4つである（第4.8節の結論と対）。

| 処理 | 実行場所 | 理由 |
|---|---|---|
| パスワードのハッシュ化 / 検証 | request Worker | CPU 予算。single-threaded な DO を長時間占有させない |
| セッショントークン / AI クライアントトークンの署名・検証 | request Worker | `SESSION_SECRET` の配布境界（第3.2節） |
| canonical credential → Directory locator の HMAC | request Worker | `DIRECTORY_ROUTING_SECRET` の配布境界（同上） |
| export のレンダリングと zip エンコード | request Worker | CPU 予算。DO 側は1回の `transactionSync` によるスナップショット読み出しだけを行う |

export の扱いが (a) の判断で最も重い入力である。`spec/domains/export.md` は生成方式を同期生成と確定させ、読み出しに単一トランザクション（スナップショット読み）を要求している。usecase を DO 内で実行する結論に倒すと、素直に書けば read → render → zip の連鎖ごと DO の中に入り、**最大 10 GB を持ちうる single-threaded な DO で zip エンコードを回す**ことになる。そこで export だけは「DO は読み出し、request Worker が render と zip」に分ける。読み出しは1回のトランザクションで完結するのでスナップショット要求は満たされ、上限超過は拒否する（第4.8節）。

#### (b) request 側 DI に残るもの

`sessionCodec` / `clock` / `idGenerator` / `logger` / `config` / `passwordHasher` / **DO stub factory**（`userId` → User Data DO stub、canonical → Directory bucket stub の2種類）。`unitOfWorkProvider` は消える。

**`packages/core/src/application/di/types.ts` の不変条件は維持する。** 同ファイルの JSDoc は「リポジトリはコンテナに載せない。`UnitOfWorkContext` が唯一の発行点」と明文化しており、これが全集約アクセスを UoW の中に閉じ込めている根拠である。DO stub は「その DO 内の全リポジトリへの入口」なので、素朴に載せるとリポジトリを載せたのと同じ到達性を与えてしまう。**そこで stub factory が返すのは生の stub ではなく、その DO が公開する usecase facade（値だけを受け取り値だけを返すメソッド群）に限る。** リポジトリ型も `UnitOfWorkContext` 型も request 側の型に現れない。JSDoc は「リポジトリはコンテナに載せない」を維持したまま、「DO facade はトランスポートであってリポジトリではない」の1文を足す（#37）。

#### (c) server component / server function から DO を呼ぶ経路と `getContainer()` の去就

`getContainer()` は **request 側専用のまま残す。** `packages/core/src/application/di/containerStore.ts` が持つのは `globalThis` の `Symbol.for` スロットだけで、`AsyncLocalStorage` は import すらしていない（エラーメッセージ中に語が出るだけである）。ALS の実体は runtime エントリ側の `apps/web/app/server.cloudflare.ts:4,33,44` にあり、そこが `installContainerStore` でストアを差し込む。**DO インスタンスにはそのリクエストスコープが無いため、`getContainer()` は必ず throw する**（ストア未インストール、またはリクエストスコープ外のどちらかで throw する経路しかない）。したがって DO 側は別の合成ルートを持つ — DO クラスの constructor が `ctx.storage` から自前のコンテナを組み立て、インスタンスフィールドとして持つ。ALS は使わない（DO の中では1インスタンス = 1ユーザーなので、暗黙のスコープ伝播が要らない）。

server component / server function から見た変化は「`getContainer()` で得たコンテナから usecase を直接呼ぶ」が「コンテナの DO facade を呼ぶ」に変わるだけで、`apps/web/app/presentation/` の構造（server-function エントリ、エラー応答ミドルウェア、transport 境界の入力検証）は保たれる。**request Worker は `@repo/core/application/*` の usecase 実装を import しなくなり、DTO 型と `SerializedError` の契約だけを import する。**

#### (d) `SerializedError` を RPC 越しに維持する方法

RPC は **`{ ok: true, value } | { ok: false, error: SerializedError }` の値エンベロープだけ**を返す。リポジトリ・クロージャ・transaction capability・カスタムエラーの実体を境界外へ出さない。Workers RPC のカスタムエラー伝搬は `CodedError` の構造的シリアライズ契約を保証しないので、**DO 側の RPC エントリで catch し、`toSerialized()` の結果を値として返す**。request 側は `kind` タグから復元して既存のエラー応答ミドルウェアに載せる。`CLAUDE.md`「エラーは構造的にシリアライズする。`instanceof` で列挙しない」という契約は維持され、境界が1つ増えるだけである。

エンベロープには `version` を持たせ、片側デプロイ・ロールバックの互換ウィンドウ（第3.2節）を確保する。

**値エンベロープに載る `SerializedError` は DO 側で作る。ただし DO へ到達しなかった／DO が消滅した場合のプラットフォームエラーは DO の中に catch 点が無いので、stub 呼び出しを包む呼び出し側アダプターが翻訳する**（第4.7節の「捕捉する側」列）。**この2つは別経路である** — 前者は `{ ok: false, error }` としてエンベロープに載って正常に返り、後者は **stub 呼び出し自体が throw する**。呼び出し側は両方を同じ `SerializedError` に畳んでからエラー応答ミドルウェアへ渡す。

#### (e) RPC の引数側 — DO facade はブランド型を受け取らない

(d) が扱ったのは戻り値だけである。**引数側は別の問題を持つ。DO への RPC は新しい信頼境界になる。**

- state Worker は独立した script であり、その DO クラスは binding を持つ任意の Worker から呼べる。第5.5節 2 の「usecase は DO の内側で走るので外部入力が locator に到達しない」は**locator についての主張**であって、RPC 引数の**内容**が検証済みである根拠にはならない。
- ドメインの値オブジェクトはすべて**ブランド付きの `string` / `number`**（`packages/core/src/domain/identity/valueObject.ts` の `UserId` / `Email` / `SsoProvider` / `AiClientConnectionId` / `ClientName` / `TrashRetentionDays` ほか）で、ブランドは**型レベルにしか存在しない**。RPC は構造化クローンで値を運ぶので**ブランドは境界を越えた時点で失われ、生の `string` が `Email` 型として通る**。DO facade の署名が `Email` を受け取る形で書かれると、型システムが「検証済み」と嘘をつき、`CLAUDE.md`「値オブジェクト構築で検証する」が構造的に無効化される。とくに第5.2.1節 (b) は `Email.create` を canonical 化の唯一の出所にすると決めているので、これが破れると HMAC の入力が揃わなくなる。

**結論: DO facade のメソッド署名はブランド型を取らない。** プリミティブ（`string` / `number` / それらのプレーンなオブジェクト）だけを受け取り、DO の内側で値オブジェクトを再構築する。

- これで `CLAUDE.md`「validated at exactly two points」は「**transport 境界（request Worker の `inputValidator` / `validateSearch`）**」と「**値オブジェクト構築（DO の内側）**」の2点として維持され、RPC 境界は3点目にならない。DO 側の値オブジェクト構築が、そのまま2点目の実体になる。
- **信頼境界は「script 分離 + binding」に置く。** state Worker は公開ルートを持たず、到達手段は binding 経由の RPC だけである（第3.2節）。これを設計上の前提として明文化しておく — 将来 state Worker に公開ルートを足すと、この節の前提が崩れる。
- 戻り値側も同じ理由でブランド型を返さない。DTO は primitive で構成する（第1.3節で採用した先行案「RPC は primitive DTO と値エンベロープだけを返す」と同じ規則を、引数側へ対称に広げたものである）。

### 8.4 OCC と `Version` の去就 ［派生］

**（OCC を再試行しない方針の正文は第7.7節 項6。本節はその実現手段を DO の SQLite へ具体化したものである。）**

残す。

DO は single-threaded なので、1つのトランザクションの中の read-modify-write は原子的である。しかし競合が消えるわけではない — **「一覧を表示する → 利用者が編集する → 保存する」のようにリクエストを跨ぐ lost update は残る**（第2の書き手が別リクエストで割り込む）。設定画面からの二重解除操作のような競合も同じである。

実現手段は **条件付き UPDATE の0行検出**に変える。`UPDATE ... SET ... WHERE id = ? AND version = ?` を実行し、変更行数が0なら `ConflictError("OPTIMISTIC_LOCK_FAILURE")` を投げる。`_occ_guard` テーブルもエラーメッセージの部分一致も要らなくなる（第8.1節）。

**変更行数は `UPDATE ... WHERE id = ? AND version = ? RETURNING 1` が返した行の有無で読む。第一候補をこれにする。** 意味論がその文の中で閉じるからである — 課金単位でもグローバル関数の状態でもなく、**その `UPDATE` が実際にマッチした行**を見る。

**`SqlStorageCursor.rowsWritten` は使わない。** `rowsWritten` は公式に「索引の1行更新も追加の1行として数える」「最終値は SQL の課金に使われる」と定義されており、**マッチした行数ではなく課金単位**である。0 / 非0 の判定にだけ使うなら結果は同じだが、意味論が一致していない値を OCC の正しさの拠り所にしない。

**`sql.exec("SELECT changes()")` は第二候補として残すが、`RETURNING` が使えることを確認するまで第一候補にしない。** `changes()` は core SQLite 関数なので動く公算が高いものの、**`sql.exec()` をまたいだときに直前の DML のマッチ行数を返すか（workerd が exec ごとに新しい prepared statement を用意する実装であっても connection 単位の `changes()` が保持されるか）は公式に記載が無く、workerd 上の実測もない**。OCC の正しさが直接これに懸かるので、**第11.4節の spike 一覧へ足してある**（`transactionSync` のネスト可否 / `snippet()` と同じ枠）。逆に `RETURNING` は先行ブランチの Cloudflare アダプターが `INSERT ... RETURNING rowid` で使っており動作実績がある。

方針は現行のまま維持する — **`ConflictError("OPTIMISTIC_LOCK_FAILURE")` は握り潰さず、ユースケースを通ってトランスポート境界まで届ける。** アプリケーション層の OCC リトライデコレーターは置かない（`CLAUDE.md`「Retry strategy」。**契約の正文は第7.7節 項6**）。

### 8.5 UNIQUE 違反翻訳点の是正 ［参考］

戻せる。

`packages/core/src/application/identity/registerWithPassword.ts` の `catch` ブロックは、UNIQUE 違反を `EMAIL_ALREADY_REGISTERED` へ翻訳する処理がユースケース層に漏れている。コメント自身が「この UoW が何を書くかに依存した安全性であり、別のユニーク制約を持つ書き込みを足したらこの翻訳は消さなければならない」と自認している。原因は deferred-batch モデルで、違反が `insert` の呼び出しフレームの外（バッチのフラッシュ時）で起きることである。

同期 commit では `insert` を呼んだその場で違反が上がるので、**翻訳点をアダプターへ戻せる**（`CLAUDE.md`「adapter → application」の本来の姿）。さらに本設計ではメールの一意性の権威が Directory bucket へ移る（第6.1節 (c)）ので、翻訳は Directory アダプターの責務になり、ユースケースは `ConflictError` をそのまま通す。

これにより `.thread/1/progress.md` に記録されている spec-sync 項目が1件解消する。#35 へ引き継ぐ（第11.1節）。

## 9. スキーマバージョン管理と lazy migration ［Issue 要求］

### 9.1 DO class lifecycle と object 内 schema version の分離 ［派生］

2つは**別レイヤー**として扱う。

- **DO class の lifecycle は Wrangler の宣言的 `exports` で管理する。** `UserDataDurableObject` / `IdentityDirectoryDurableObject` の2クラスを `type = "durable-object"` / `storage = "sqlite"` として宣言する。`[[migrations]]` 配列とは排他で、両方を含む設定は検証で拒否される（第2.1節 F-21）。fog はまだ本番 DO namespace を持たないので、`exports` へ直行できる。
- **object 内の schema version は SQL の `_meta` テーブルで管理する。** これは Cloudflare の関知しない、アプリケーション側の関心事である。

**取り違えると危険な点を2つ明記する。** (i) `exports` を deploy した後に旧 `migrations` 配列へ戻せない。(ii) `exports` 経由で削除した namespace に Trash は無く、tombstone をデプロイする前にデータを退避する必要がある。staging / production / local の全設定を `exports` 方式に揃える（第3.2節の `.tpl` 経路）。

**#37 の Issue 本文の当該行を訂正したうえで作業する。** #37 の対応項目8 は「`wrangler.toml` … に User Data DO・Identity Directory DO の binding と **SQLite class 定義（`new_sqlite_classes` migration）を追加**」と書き、受け入れ条件も「DO binding と **SQLite class migration** が定義されている」と書いている。**`new_sqlite_classes` は `[[migrations]]` 配列の中の指定であり、本節が採る `exports` と排他である**（第2.1節 F-21。両方を含む設定は検証で拒否される）。Issue のチェックリストどおりに `.tpl` を書くと wrangler の設定検証で弾かれる。**したがって #37 は Issue 本文の当該2行を「`exports` で `type = "durable-object"` / `storage = "sqlite"` を宣言する」へ訂正してから着手する。** これは第11.1節が #35 の受け入れ条件3 について行っている訂正指示と同じ扱いである。

### 9.2 `schema_version` の持ち方と migration の起動タイミング ［Issue 要求］

**持ち方: `_meta` テーブルの単一行に `schema_version`（整数）を持つ。** KV の `put()` ではなく SQL 側に置く — migration の適用とバージョンの更新を**同じ `transactionSync` で確定させる**ためである。

**起動タイミングは、DO の全 RPC エントリ「および `alarm()`」の先頭に置いた冪等なゲート関数である。** `blockConcurrencyWhile` は使わない。**`alarm()` については「先頭」に置くものが本節のゲートと第7.4節の再武装の2つあるので、順序を第7.4節で確定させてある — (1) 再武装 + `await ctx.storage.sync()` → (2) 本節のゲート → (3) 仕事 である。** (1) の `await` はゲートに入る前に完了するので、下記「ゲート関数は同期関数とし `await` を1つも挟まない」という排他条件は破れない。

**`alarm()` を RPC と同格に扱う。** dormant な利用者の User Data DO は、次に起きる契機が `purge-trash` の Alarm しか無い（第7.5節が「利用者がアクセスしていなくても期限処理は走る」を retention 方式の利点として掲げているのは、まさにこの状況を指している）。ゲートを RPC だけに置くと、そのとき `_meta.schema_version` は古いまま `alarm()` が走り、**ジョブ実行部（新コード）が新スキーマ前提の SQL を未 migrate の DO へ投げる**。第9.3節の「両対応の読み取り」はデータ書き換え中の期間の話であって、**DDL が未適用の DO** を救わない。**第7.5節の「アクセスが無くても走る」という主張は、このゲートが `alarm()` に掛かって初めて成立する。**

`blockConcurrencyWhile` を使わない理由は明確である。「最初のアクセス時に migration」は実装上ほぼ確実に constructor + `blockConcurrencyWhile` になるが、これは **30秒でタイムアウトし DO をリセットする**（第2.1節 F-23）。10 GB まで育った DO のスキーマ変更が1回のコールバックで終わる保証は無い。ゲート関数方式なら、DDL を1回の `transactionSync` で適用し、重い部分はジョブへ逃がせる（下記）。

**`blockConcurrencyWhile` を捨てた代わりの排他条件を明示する。** **ゲート関数は同期関数とし、`schema_version` の読み取りから全 DDL ステップの適用まで `await` を1つも挟まない。** これにより input gate が排他を保証する（第2.1節 F-18 — input gate は同期 JS 実行中の新規イベントを止める）。`await` が1つでも入ると input gate が開いて並行 RPC が割り込み、その RPC 自身のゲートが同じ migration を別のステップから走らせる。各ステップは冪等なので最終状態は収束するが、ステップ間に順序依存がある場合（`ALTER TABLE ADD COLUMN` → backfill → `CREATE INDEX`）は途中の観測が壊れる。**重い部分を `migrate-bulk` ジョブへ逃がす方針（下記）はこの条件と両立する** — ジョブ投入もゲートの中では同期の1行書き込みで済み、実行は Alarm 側の別の入力になるからである。

**「1回の入力で完了するか」の判定基準は CPU 予算で書く。wall time では導かない。** Alarm 経由なら handler の wall time は15分ある（第2.1節 F-3）が、bulk migration や FTS5 の全件再インデックスで**先に当たるのは CPU 予算（既定30秒 / 設定で最大5分の active CPU）**である（同 F-4）。`blockConcurrencyWhile` の30秒と CPU 既定の30秒は偶然同値なだけで別物なので、書き分ける。

**失敗モードは「リセット」の意味論で決まる。** CPU 予算は着信リクエストごとに戻る枠であり、Alarm 駆動には戻す契機が無い（記載の不在からの推論。第2.1節 F-4b）。しかも超過の帰結はエラーではなく**エビクションとリセット**である。したがって bulk migration は**途中まで進んで黙ってリセットされる**。「例外が上がるから検出できる」を前提にした設計にしてはいけない。これが第9.3節の「部分適用の記録」を任意ではなく**必須**にする。

**計測手段と閾値は第7.4節と同じものを使う。** 残り CPU 時間を実行時に読む API は Workers / DO に無く、`Date.now()` も凍結している（第2.1節 F-4 / F-32）ので、`migrate-bulk` も第7.4節の**3階層の件数予算**をそのまま使う — **外側（ジョブランナー）は「ジョブ25件」、中間（チャンク反復回数）と内側（1チャンクの行数上限）は `migrate-bulk` 種別の値**である。**migration 専用の別閾値は置かない、の意味は「外側の打ち切り条件を migration 専用に分岐させない」である** — `migrate-bulk` は `jobs` テーブルの1レコードとして同じジョブランナーが回すので、外側に閾値が2系統あると打ち切り条件が二重になるためである。**中間と内側の上限をジョブ種別ごとに持つのが前提**なので、`migrate-bulk` が自分の値を持つことはこの禁止に当たらない。**外側の「25件」は `migrate-bulk` 1件に対して一度も発火しない**（1件の巨大ジョブだから）ので、**`migrate-bulk` に実際に効く保護は中間の反復回数上限と内側の行数上限の2つだけである。どちらか一方を落とすと保護が消える。**

単発適用で足りるかを断定する。**「SQLite の DDL はデータ量に依存しない」を一括の根拠にしてはならない。DDL の中でデータ量に依存するものとしないものを分ける。**

- **データ量に依存しない（単発適用で足りる）** — `CREATE TABLE` と、**制約を伴わない** `ALTER TABLE ADD COLUMN` / `RENAME`。SQLite 公式（`lang_altertable.html`）は「No changes are made to table content for renames or column addition without constraints. Because of this, the execution time of such ALTER TABLE commands is independent of the amount of data in the table and such commands will run as quickly on a table with 10 million rows as on a table with 1 row.」と明記している。
- **データ量に依存する（分割か回避が要る）** — **(i) CHECK 制約付きの列追加・NOT NULL の生成列追加・列削除**。同じ公式ページが「the ALTER TABLE command takes time that is proportional to the amount of content in the table being altered」と述べている。**(ii) `CREATE INDEX`。索引の構築は全行走査 + ソートである。** 公式（`optoverview.html`、自動索引の節）は索引構築のコストを「the cost of constructing the automatic or query-time index is O(NlogN) (where N is the number of entries in the table)」と定義しており、これは索引の作り方そのものについての記述なので `CREATE INDEX` にも同じく当てはまる。**初版は「索引追加は単発適用で足りる」と断定していた。これは事実として誤りである。**

**誤りの帰結が重い。** ゲート関数は全 RPC エントリおよび `alarm()` の先頭に置かれ、CPU 予算超過はエラーではなく**エビクションとリセット**として現れる（第2.1節 F-4）。10 GB まで育った User Data DO の `memos` に索引を1本足すだけで超過しうるので、その DO は**どのリクエストもゲートで落ちる恒久的な応答不能**に陥る。しかも同節が自ら書いているとおり「例外が上がるから検出できる」を前提にできない。第9.5節の PITR も救済にならない（`schema_version` は進んでいないので巻き戻す対象が無い）。

分割が必要になるのは次の4条件のいずれかに当たるときで、**そのときは必ず分割する（4 だけは分割できないので回避する）**。

1. 既存の全行を書き換える変更（列の型変換、値の再計算、テーブルの作り直し、上記 (i) の列追加・列削除）。
2. FTS5 の全件再インデックス（トークナイザや正規化規則を変えたとき。第5.2.1節 (d) の canonical 規則変更も同種である）。**external-content の `CREATE VIRTUAL TABLE ... USING fts5(...)` 自体は shadow table を作るだけなので単発でよい**が、既存行を載せるには `INSERT INTO search_fts(search_fts) VALUES('rebuild')`（公式 `fts5.html`: 「This command first deletes the entire full-text index, then rebuilds it based on the contents of the table or content table」）または projection の全行再実行が要り、**そちらが本条件に当たる**（external-content は作成時に content テーブルから自動で populate されない）。
3. 上記 1 / 2 を、既に大きく育った DO に対して行うとき。
4. **既に大きく育った DO に対する `CREATE INDEX`。SQLite ではこれをチャンク分割できないので、`migrate-bulk` への逃がし先が無い。** 中断・再開の単位が存在せず、`SAVEPOINT` も使えない（第2.1節 F-8）。

**条件4 の回避策を1つに決め切る。** **(a) 索引は原則としてテーブル新設時に同時に張る**（`CREATE TABLE` と同じ単発の `transactionSync` に入れる。空テーブルへの `CREATE INDEX` は O(1) である）。**(b) 既に大きく育った既存テーブルへ索引を足す必要が生じたら、`CREATE INDEX` を直接発行せず、「索引つきの新テーブルを作る → `migrate-bulk` で行をコピーする → 参照を切り替える → 旧テーブルを落とす」という多段の forward-only migration へ分解する**（第9.3節が既に定めている「新しい列を足して二重書きし、書き換え完了後に旧列を落とす」と同じ形である）。コピーは条件1 に当たるのでチェックポイント分割に乗り、**索引の構築は行の挿入に分散して有界になる**。

分割する場合は **DDL 部分を単発の `transactionSync` で適用して `schema_version` を進め、データ書き換え部分は `migrate-bulk` ジョブとして Alarm のチェックポイント分割に乗せる**（第7.4節）。

### 9.3 forward-only と失敗時の再実行 ［Issue 要求］

**forward-only にする。** 下方向の migration は書かない。

- **各ステップは冪等に書き、ステップの適用と `schema_version` の更新を同じ `transactionSync` に入れる。** これで「適用したがバージョンが進んでいない」状態が原理的に作れない。途中で失敗したステップは丸ごとロールバックされ、次のゲート通過時に同じステップから再実行される。
- **1回で完了しない migration の部分適用を記録する。** `migration_progress` テーブルに `{ targetVersion, step, cursor, updatedAt }` を持ち、**カーソルを進めた分をコミットしてから次の Alarm を張る。** これは任意の最適化ではなく必須である（第9.2節の「黙ってリセットされる」失敗モードのため）。
- **途中状態でのリクエスト受付可否。** DDL 部分が完了して `schema_version` が進んでいれば、**リクエストは受け付ける**。データ書き換えが進行中の期間は、新旧どちらの形の行も読めるようにコードを書く（両対応の読み取り）。受付を止めると、10 GB 級の DO で数分〜数十分のダウンタイムになるためである。両対応が書けない変更は、第9.2節の分類 1 として「新しい列を足して二重書きし、書き換え完了後に旧列を落とす」という**多段の forward-only migration** に分解する。
- **再実行の安全性。** ステップは `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` のように再実行可能な形で書く。**ただし冪等であることは有界であることを意味しない** — 既に大きく育ったテーブルへの `CREATE INDEX` は再実行可能でも1回の入力で完了しないので、第9.2節の条件4 の回避策（索引つき新テーブル + `migrate-bulk` コピー）へ分解する。`ALTER TABLE ADD COLUMN` のように冪等でない文は、`schema_version` の比較でスキップされることが保証されるので問題にならない（同じトランザクションでバージョンが進むため）。

### 9.4 「コードより新しい version」への遭遇 ［派生］

**fail-closed にする。** `_meta.schema_version` がコード側の期待する最大バージョンより大きい場合、その DO は**リクエストを受け付けず** `SystemError` を返す。

**この fail-closed も `alarm()` に掛ける。** 掛けないと、ロールバック直後に古いコードの `alarm()` が新スキーマを触る経路が開いたままになり、第9.2節でゲートを `alarm()` へ広げた意味が半分になる。**fail-closed で止まった DO の `alarm()` は、ジョブを実行せずに一定間隔（バックオフ付き）で `setAlarm` を張り直し、`await ctx.storage.sync()` で永続化を確認してから戻る。** poison にはしない — 原因はデータではなくデプロイ状態であり、正しいコードが戻れば次の起動で自然に回復するべきものだからである。張り直しは第7.4節の「ハンドラ先頭での再武装」と**同じ規則**に乗る（`sync()` を含む）。規則を2箇所に分岐させない — fail-closed の DO は仕事をしないので実害は小さいが、ここだけ `sync()` を省くと規則が2つになる。運用は「fail-closed で止まっている DO の存在」をメトリクスで検知する（#38）。

**ただし第7.4節の `deleteAlarm()` 規則だけは、この経路の明示的な例外である。** 同節は「正常完了時に DB の最早 `nextRunAt` が無ければ `deleteAlarm()` する」を規則として置いているが、**fail-closed の DO は due job の有無にかかわらず alarm を消してはならない** — 消すと、正しいコードが戻ってきても次の DO 入力があるまで誰も回復を検知せず、dormant な DO では永久に止まる。**fail-closed 経路は「意図的に消さない」と読む。** 第7.4節にも同じ但し書きを置いてある。第9.2節が定める `alarm()` 先頭の順序（(1) 再武装 + `sync()` → (2) migration ゲート → (3) 仕事）のうち、fail-closed が発火するのは (2) なので、(1) の再武装は既に永続化されており、この例外は「(3) を飛ばして戻る」だけで成立する。

理由は、片側デプロイやロールバックで古いコードが新しいスキーマの DO を触ったときの損害が大きいからである。新しいスキーマの列を知らないコードが `INSERT` すると NOT NULL 違反や不完全な行を作り、次に新しいコードが戻ってきたときにデータが壊れている。**読めないより壊れるほうが悪い。**

これは第3.2節のデプロイ順序（state を先、request を後）と噛み合う — state Worker を先に上げれば、新しい DO コードが古い request からの呼び出しを受ける形になり、逆（古い DO コードが新しいスキーマに当たる）はロールバック時にしか起きない。ロールバック時は fail-closed で止まり、運用が気づける。

### 9.5 ロールバック方針 ［Issue 要求］

データのロールバックは**行わない**。

- スキーマは forward-only で、下方向の migration は書かない（第9.3節）。
- コードのロールバックは可能だが、そのとき `schema_version` が進んでいれば第9.4節の fail-closed で止まる。**したがってスキーマを進める migration を含むリリースは、ロールバック不可のリリースとして扱う。**
- 代替手段は **PITR**（object 単位・過去30日。第2.1節 F-20）である。ただし復旧単位は DO 1個で、複数 DO を同一時点へ戻す手段は無い（第10.1節）。PITR はローカル開発では使えないので、検証は staging で行う（第11.3節）。

**PITR の対象 DO を特定する手段を明示する。PITR は「対象を知っている場合の復旧手段」であって「対象を発見する手段」ではない。** Worker から DO namespace を列挙する API は存在せず、REST の List Objects が返すのは16進の object ID と `hasStoredData` だけである（第2.1節 F-5）。`UserDataDurableObject` の locator は `idFromName(userId)`（第5.2.2節 (a)）なので、**16進 object ID から `userId` へは戻せない**。したがって「不良 migration が N 人分の User Data DO を壊した」ときの対象集合を、object ID の側からは作れない。

- **対象を特定する唯一の経路は Identity Directory bucket の全走査である。** `0..N-1` の全 bucket を舐めて `credential_mappings.userId` を集めれば全 `userId` を列挙できる。第6.7節の operator 経路（256 bucket の走査）と第6.8節の retirement 走査が既に同じ前提に立っている。
- **したがって不良 migration の影響範囲は「`_meta.schema_version` が特定値の User Data DO」としてしか表現できず、その判定には全ユーザー分の RPC が要る。** 走査は第7.4節のチェックポイント予算に乗せる。
- **現実的な防御線は PITR ではなく、第9.4節の fail-closed と第9.3節の部分適用記録である。PITR は個別救済の最後の手段として位置づける。** 全ユーザー規模の巻き戻しを PITR で行う想定を持たない。

「戻せない」ことを受け入れる代わりに、**壊れる前に止まる**（第9.4節）と**部分適用を記録して再開できる**（第9.3節）の2つで安全性を確保する。

## 10. 運用上の論点（本 Issue では方針だけ、詳細は #38） ［派生］

### 10.1 PITR / export / 退会削除の関係 ［派生］

**PITR の復旧単位は DO 1個であり、複数 DO を同一時点へ戻す手段は無い**（第2.1節 F-20）。これは設計上の結論として本節に置く（運用手順は #38）。

したがって「User Data DO を昨日へ戻したが Directory の mapping は今日のまま」という状態が**原理的に作れる**。本設計はこれに耐えるよう組んである。

- **Directory mapping が到達性のゲートである。** login は必ず Directory から `userId` を引くところから始まる（第5.3節）。User Data DO を過去へ戻しても、mapping が今日のままなら到達性は今日の状態に従う。
- **User Data DO の `account.status` と `sessionEpoch` が状態の権威である。** Directory bucket を過去へ戻して削除済みの mapping が復活しても、User Data DO 側の tombstone が現在のままなので fail closed で拒否される（第6.7節）。
- **したがって、どちらか一方の restore だけでアカウントが復活することは無い。** 復旧作業は必ず「両方の現在状態を照合してから」行う。**ただしこの論証は「login が必ず Directory を経由する」ことに依存しているので、Directory を1度も参照しない AI クライアントトークン経路には当てはまらない**（下記）。
  - **逆に、両方を戻せば退会済みアカウントは復活する。** しかも PITR は運用者が単独で実行できる。したがって**退会は PITR 保持期間（30日）が経過して初めて不可逆になる**（第6.7節）。退会済み `userId` の User Data DO と、その credential が載っていた Directory bucket への PITR 実行は**禁止し、承認手続きの対象とする**。加えて Directory bucket の restore は同じ bucket に写像される**他の利用者の credential 状態まで巻き戻す**ので、アカウント1件の復旧手段としては使えない。手順と監査は #38（第11.3節）。
- **PITR は `sessionEpoch` を巻き戻し、失効済みセッションを再有効化する。** これは上の3点では塞がらない独立した穴である。セッションはステートレス HMAC + TTL 7日（第3.1節・第5.4.1節 (c)）で、**失効の唯一の手段が epoch 照合**なので、User Data DO を N 日前（N ≤ 7）へ restore すると `account.sessionEpoch` も N 日前の値に戻り、**その間にパスワード変更・リセット・SSO 解除で失効させたセッショントークンが再び有効になる**。「アカウント侵害 → パスワードリセットで攻撃者を締め出す → その後の障害で PITR」という順序で現実に起こりうる。
  - **対処: PITR で User Data DO を戻した直後に、`sessionEpoch` を restore 前の最大値より大きい値へ強制的に進める。** これを復旧手順の**必須ステップ**とする（結論は本節、手順の実体は #38。第11.3節）。restore 前の値は Metrics / 運用記録から拾えないので、**「現在時刻由来の十分大きな単調値へ飛ばす」形にして、restore 前の値を知らなくても必ず上回るようにする**。副作用は全セッションの再ログイン1回で、失効済みセッションの復活より軽い。
  - `sessionEpoch` を単調増加させる別の永続場所（例: Directory 側 mapping 行に最終既知 epoch を持つ）を置く案は**採らない**。第3.1節の「権威はすべて `userId` で引ける」を崩し、Account Home を畳んだ判断の前提を壊すからである。**運用手順側で閉じるほうが設計に整合する。**
  - **`credentialVersion`（第6.5.1節）も同じ理由で巻き戻る**が、こちらは Directory 側の値と不一致になることで login が fail closed で拒否される方向へ倒れるので、安全側である。復旧後に不一致が残る場合は credential 変更をやり直せば揃う。
- **PITR は失効済みの AI クライアント接続も復活させる。これは `sessionEpoch` とは別の穴であり、同じ必須ステップでは塞げない。** AI クライアントトークンは自己完結で、検証は request Worker が DB を触らずに行う（第5.4節）。失効の権威は `ai_client_connections.status` と `account.status` で、**どちらも User Data DO の中にしか無く、Directory を1度も参照しない**（第5.4.1節 (b)）。したがって User Data DO を単独で restore すると `status` が `revoked` → `active` に戻り、**`exp` までのあいだ失効させたはずのトークンが再び通る**。上の3点（Directory mapping がゲート / `account.status` が権威 / 片方だけでは復活しない）はいずれも login 経路の話なので、この経路には効かない。
  - **対処: restore 直後の必須ステップを2つに広げる。** **(1) `sessionEpoch` を現在時刻由来の十分大きな単調値へ強制的に進める**（上記）。**(2) その User Data DO の `ai_client_connections` を全件 `revoked` にし、利用者に再接続させる。** restore 前にどれが `revoked` だったかは復旧時点では読めない（restore で上書き済み）ので、**「復旧できないなら全部切る」を既定手順にする**。副作用は AI 連携の再接続で、失効済み接続の復活より軽い。
  - **利用者向けの導線は既にある。** 第5.4節 (ii) がリセット完了画面に「AI クライアント接続の一覧」と「すべて失効」を必須導線として要求しているので、復旧後の再接続案内はその画面を流用する（#35）。手順の実体は #38（第11.3節）。
- **Directory bucket の PITR は、消費済み・削除済みのリセットトークン行を復活させる。これは3つ目の独立した穴であり、上の2つの必須ステップ（どちらも User Data DO 側の操作）では塞げない。** 上の3点（Directory mapping がゲート / `account.status` が権威 / 片方だけでは復活しない）は**認可を閉じる向き**についての論証だが、この経路は**認可を開く向き**に倒れる。
  - **経路。** 乗っ取り被害者がリセットで攻撃者を締め出した後に bucket を T0 へ restore すると、**(a) `credential_mappings` の `passwordVerifier` / `credentialVersion` が n へ巻き戻り、(b) 攻撃者が保持していたリセットトークン行が `usedAt = null` で復活する**（第6.5.1節 phase 1 の未使用トークン一括削除も、`consume-reset-token` の使い捨て記録も、どちらも巻き戻る）。**(a) 単独なら fail closed で止まる** — 第5.3節 step 5 (iii) の `credentialVersion` 照合が User Data 側の n+1 と不一致になるからで、上の `credentialVersion` の項が述べているのはこの向きである。**ところが (b) は照合を回避せずに前進させて解消する** — `consume-reset-token` → `begin-credential-change`（起点 B の束縛 `consumedByOperationId` も復活済みの行で満たされる）→ phase 2 が `sessionEpoch` と `credentialVersion` を n+2 へ進める → phase 3 で攻撃者の `pendingVerifier` が昇格する。**終状態は攻撃者のパスワードで正規にログインできるアカウントである。** トークン TTL は時間オーダー（第6.1節 (d)）なので成立するのは「直近数時間へ戻す restore」に限られるが、**それは PITR の典型的な使い方そのものである。**
  - **対処: Directory bucket restore 直後の必須ステップを2つ置く。** **(1) restore した bucket の `password_reset_tokens` を全行削除する**（消費済み・未消費を問わない）。**誰のトークンがいつ有効だったかは restore 後には読めない**ので、「復旧できないなら全部切る」を既定手順にする — `ai_client_connections` を全件 `revoked` にするのとまったく同じ判断である。利用者影響は「リセットをやり直す」だけで、第6.1節 (d) が鍵ローテーションについて既に受容している影響と同じ大きさである。**(2) `failedAttempts` を0 に、`nextAttemptAllowedAt` を過去に戻す**（同じく巻き戻る列であり、restore 前の値を知らなくても安全側になる形にする）。**締め出し方向へ倒さないのが要点で**、発信元単位の抑止は第6.2.2節 (c) の WAF が引き受ける。
  - **この穴は第6.9節の「どの中間状態でも fail closed」に対する反例ではない、と読めるようにしておく。** 同節の宣言の射程は**本設計が作る中間状態**であり、PITR はそれを外側から巻き戻す操作である。射程は同節に明記した。手順の実体は #38（第11.3節）。
- **saga の中間状態は restore で復活しうる。** 復活した `reserved` 行は TTL 掃除（第6.4節）が回収し、復活した `operations` 行は `payloadDigest` の照合で古い再送として弾かれる（第6.5節）。**復活するのはこの2つだけではない — `password_reset_tokens` 行も復活し、そちらは自動では収束しないので上の必須ステップで消す。**
- **export は PITR の代替ではない。** export はゴミ箱を除外し最新リビジョンのみを返す（`spec/domains/export.md`）ので、復旧用のバックアップとしては不完全である。用途は利用者のデータ可搬性であり、両者を混同しない。

### 10.2 監視・容量・コスト ［参考］

いずれも #38 で詰める。本設計が依存する前提だけを固定しておく。

- **容量は「本体 + FTS インデックスの合計で 10 GB」で見る**（第4.6節）。監視の閾値と逼迫時の利用者向け導線は #38。
- **`overloaded` はリトライしない**（第4.7節）。Directory bucket の負荷は bucket 数で割れるので、逼迫したら世代を進めて bucket 数を増やす（第6.2節）。
- **コストの主要因は rows written である。** 仮想テーブルへの書き込みと `setAlarm` 1回がそれぞれ算入される（第2.1節 F-15 / F-24）。trigram の増幅が最も効くので、コスト試算は本体行数ではなくインデックス行数で行う。

## 11. 影響範囲と引き継ぎ ［Issue 要求］

### 11.1 #35 への引き継ぎ — 改訂対象の spec ファイルと改訂内容 ［Issue 要求］

#### 走査の方法（#35 が再実行できる形で記録する）

grep 1本では足りない。4つの手段を重ねた。**#35 は同じ4つを再実行して、本節の一覧に漏れが無いことを確認する。**

1. **語彙走査。** 対象は `spec/**/*.md`。除外するのは `spec/**/review/**`（レビュー記録そのもの。**39ファイル** — `spec/database/review` 3 / `spec/design/review` 8 / `spec/domains/review` 9 / `spec/manual-tests/review` 7 / `spec/pages/review` 3 / `spec/review` 3 / `spec/scenario/review` 3 / `spec/usecases/review` 3）**だけ**である。**`spec/idea.md` は除外しない** — #35 の対応項目1の先頭が `spec/idea.md` の改訂を名指ししているので、履歴文書として落とすと本書と Issue 本文で指示が食い違う。走査語は次のとおりで、ヒットは **62ファイル**。

   **`spec/usecases/review/002.md` は除外したままにする（改訂しない）、と断定する。** #35 の背景節の旧前提ファイル一覧に同ファイルが挙がっており、実測でも走査語に7件ヒットする。それでも改訂しない理由は、**レビュー記録は「そのとき何を指摘したか」の履歴であり、後から本文を書き換えると記録としての意味が消える**からである。`spec/idea.md` に例外を認めたのは、あれが**現在の前提を述べる文書**であって履歴ではないためで、論拠は `spec/usecases/review/002.md` には及ばない。**#35 は Issue 本文の当該行を「レビュー記録なので改訂対象から外す」と読み替えて着手する。** これで「Issue 本文が改訂対象と書いているのに本書の101件判定に現れないファイル」がゼロになる。

   ```text
   Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド|collectEvents|pruner|D1|libSQL|Turso|Vectorize|RRF|PendingBatch|occ_guard|UnitOfWork|indexer|embedding|イベント|Queue
   ```

2. **ポート定義の目視。** `Promise` の除去（第8.2.1節）と `userId` 第一引数の除去（第4.5節）は語彙走査に掛からない。`spec/domains/*.md` と `spec/usecases/*.md` のポート表・シグネチャを全件当たる。これで拾ったのが `spec/domains/export.md` である。
3. **マニュアルテストの「環境前提」節の目視。** 共有 DB への直接 SQL、ワーカーの手動起動といった**手段の前提**も語彙走査に掛からない。これで拾ったのが `spec/manual-tests/document.md`（「検索インデックス更新ワーカーが起動していること」「反映まで1〜2分待つ」）と `spec/manual-tests/settings.md`（`UPDATE memos SET posted_at = ...` の直接更新手順）である。
4. **本設計が新設・変更した振る舞いからの逆引き。** 手段1〜3 はいずれも「**消す**もの」（Outbox / ベクトル / D1 / consumer / pruner）の語彙と手段に反応する走査であり、本設計が**足した**振る舞いを1件も捕まえない。逆引きの起点は次の8つである — **login の到達性検査**（第5.3節 step 5 (ii)）、**`credentialVersion` 照合**（同 (iii)）、**`changeState: 'pending'` のダミー材料経路**（第6.5.1節）、**`failedAttempts` / `nextAttemptAllowedAt` のロックアウト**（第6.2.2節 (a)）、**リセット依頼のダミージョブ行**（第7.6節）、**export の読み出し上限**（第4.8節）、**signup saga の phase 順とコーディネーター bucket**（第6.3節）、**リセット完了時の AI クライアント接続の自動失効と必須導線**（第5.4節 (i)(ii)）。これらの語で `spec/` を引き直し、さらに `spec/testcases/identity/*` と `spec/scenario/account.md` / `spec/manual-tests/account.md` を全文目視した。**下の「改訂する — 手段4 でのみ拾えたもの」9件はこの手段でしか拾えない。**

**カバレッジの実測。** `spec/` の非レビュー md は **101ファイル**である。手段1（語彙走査）のヒットは **62ファイル**、手段2 が1件（`spec/domains/export.md`）、手段3 が2件（`spec/manual-tests/document.md` / `settings.md`）で、**手段1〜3 が触れたのは合わせて65ファイル**。残る **36ファイル**は手段1〜3 のいずれにも掛からなかったので、**手段4 で全数に判定を付けた**（改訂対象9件 / 影響なし27件）。

**したがって `spec/` の非レビュー md 101ファイルすべてに判定がある。改訂対象72件 / 影響なし29件である。** これに `spec/` の外の `CLAUDE.md` が加わる（#35 の対応項目6）。

**再現手順。** 未判定の残りは次で機械的に出せる。

```bash
find spec -name '*.md' | grep -v '/review/' | sort > /tmp/all.txt
grep -rlE '<上の走査語>' spec --include='*.md' | grep -v '/review/' | sort > /tmp/hits.txt
comm -23 /tmp/all.txt /tmp/hits.txt   # 39件（うち3件は手段2・3 が拾う。残り36件が手段4 の対象）
```

#### #35 の受け入れ条件との対応

Issue #35 の受け入れ条件7項目を左端に置き、それを満たすために触る対象を並べる。**#35 は本書と Issue の受け入れ条件を突き合わせ直さなくてよい。ただし上の4手段は再実行して、`spec/` に新しいファイルが増えていないことと本節の一覧に漏れが無いことを確認する。**

| # | #35 の受け入れ条件 | 触る対象 | 本設計側の根拠 |
|---|---|---|---|
| 1 | `spec/` にベクトル検索 / Vectorize / embedding / RRF / D1・libSQL・Turso 前提の有効な設計が残っていない | `spec/idea.md` / `spec/requirements.md` / `spec/scenario/{search,ai,index}.md` / `spec/pages/index.md` / `spec/domains/{search,index}.md` / `spec/usecases/search.md` / `spec/database/index.md` / `spec/inventory/*` / `spec/testcases/search/*` / `spec/manual-tests/{search,ai,document}.md` | 第7.1節・第7.2節・`.adr/003` |
| 2 | `spec/requirements.md` 4.4 がキーワード全文検索として定義され、**非機能要件にユーザー単位 DO の物理分離が入っている** | `spec/requirements.md`（検索2箇所 **+ 非機能要件への追記**） | 第3.1節・第4.4節・第5.5節 |
| 3 | `SearchIndexPort` の契約が単純化されている | `spec/domains/search.md` / `spec/inventory/adapter.md` | 第7.1節 |
| 4 | `spec/database/index.md` が SQLite-backed DO 一本になり、**DO の schema version / lazy migration 方針を含む** | `spec/database/index.md`（削除だけでなく**追記**が要る） | 第4.1.1節・第4.4節・第9.1〜9.5節 |
| 5 | `spec/inventory/` / `spec/testcases/search/` / `spec/manual-tests/` が改訂後の設計と一致している | 下の判定一覧の該当行すべて | 第4.3節・第7.3節・第7.5節 |
| 6 | `CLAUDE.md` の Reference runtimes / UoW / Outbox / DB 制約が DO 単独構成を記述している | `CLAUDE.md` | 第7.7節（**非同期実行契約の正文**）・第8.2節・第8.2.1節・第8.4節 |
| 7 | #10 の実装チェックリストが改訂後の `spec/inventory/` と一致している | #10 の Issue 本文 | 改訂後の `spec/inventory/` が入力。本設計に追加の指示は無い |

**受け入れ条件7 の照合対象に #13 を足す。** #13「AIクライアント接続（OAuth認可・一覧・失効）」のチェックリストも `spec/inventory/` 由来であり、本設計は #13 に対して2つの入力を出している — **(i) OAuth 2.1 の認可コード / PKCE / `jti` 一回性テーブルを User Data DO に置く**（第4.1.1節・第5.4.1節。#12 ではなく #13 の範囲である。**認可コードのペイロードに `redirectUri` を載せて署名し、token エンドポイントで完全一致を検証する。`/authorize` 側の `redirect_uri` 検証そのものは #13 の担当である**）と、**(ii) `identity.aiClientRevoked` の失効 consumer が消える**（第7.3節。#13 のチェックリストに `DOM-identity-017 identity.aiClientRevoked イベント` と `TC-revokeAiClientConnection-002 失効イベント` が載っている）。**#35 は `spec/inventory/` の改訂後に #13 のチェックリストも突き合わせる。**

**受け入れ条件3の文言を訂正する必要がある。** #35 の受け入れ条件は「`SearchIndexPort` の契約が FTS5 の query / upsert / remove に単純化されている」と書いているが、**本設計の結論は `query` の1本だけである** — `upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` はポートとして残らず、本体を書くトランザクション内の projection 処理へ畳まれる（第7.1節）。#35 は Issue 本文の当該行を「`query` 1本へ縮小する」に訂正したうえで作業する。

**非機能要件（受け入れ条件2の後半）に足す内容の要旨。** 「ユーザーのドメインデータはユーザー単位の SQLite-backed Durable Object に**物理分離**される。分離の保証は列条件（`user_id`）ではなく到達可能性（他ユーザーの DO stub を得る経路が存在しないこと）に依る（第5.5節）。1 DO あたりのストレージ上限は 10 GB で、本体と FTS5 インデックスの合計で見る（第4.6節）。」

**`spec/database/index.md` に足す内容の要旨（受け入れ条件4の後半）。** (i) DO ごとの `_meta.schema_version` と、全 RPC エントリおよび `alarm()` の先頭に置く冪等なゲート関数（第9.2節）。(ii) `blockConcurrencyWhile` を使わず、ゲート関数を同期実行にして input gate に排他させる条件（同）。(iii) forward-only と `migration_progress` による部分適用の記録（第9.3節）。(iv)「コードより新しい version」への fail-closed（第9.4節）。(v) データのロールバックを行わず PITR を代替手段とする方針（第9.5節）。(vi) 第4.1.1節のテーブル全数。

**画面仕様として #35 へ送る3件（本文が断定形で書いているもの）。** いずれも `spec/pages/index.md` / `spec/scenario/account.md` / `spec/inventory/frontend.md` に落ちる。

1. **メールアドレスの所有確認（verification）が signup に存在しないことを、既知の前提として明記する**（第5.2.1節 (a)）。第6.3節の saga は phase 0〜4 のいずれにも確認手順を持たない。したがって**所有の唯一の証明はパスワードリセット経路であり、リセットトークンの安全性がアカウント所有の安全性の上限になる**。所有確認 phase を新設するかは #34 のスコープ外だが、この前提は画面文言（「登録されていれば送信された」の意味）と運用の両方に効くので落とさない。
2. **リセット完了画面に必須の導線を2つ置く** — **クレデンシャル一覧**（覚えの無い SSO 連携を解除できる。第5.1節の残余リスクの唯一の対策）と、**AI クライアント接続一覧 + 「すべて失効」**（第5.4節 (ii)。`createdAtCredentialVersion` による自動失効が切るのは1世代分だけなので、それより前に持ち込まれた接続は利用者の判断で切る）。**2つは同じ画面にまとめる。** この画面は第10.1節の PITR 復旧手順（restore 後に全接続を失効させ利用者に再接続させる）からも流用される。
3. **signup の重複エラーは秘匿しない。文言方針を明示的な設計判断として送る**（第6.3節）。**画面には「このメールアドレスは既に登録されています」を出してよい。** これは公開の列挙オラクルであることを承知のうえでの受容判断であり、理由は「重複を秘匿する唯一の実装可能な形（重複時もメールを送って結果を UI で区別しない）が、所有確認 phase を持たない本設計では成立しないから」である。**#35 は「秘匿すべきでは」と再検討しない** — 覆すなら所有確認 phase の新設とセットであり、それは #34 のスコープ外として明示的に切り出してある。緩和は未認証エンドポイントへの WAF / Rate Limiting Rules（第6.2.2節 (c)）で、signup にも掛かる。

**FTS5 tokenizer 方針（#35 の対応項目3）。** `spec/database/index.md` に次を書く。**日本語は空白でトークン分割できないため `tokenize='trigram'` を採る**（第7.2節）。**1〜2文字のクエリは trigram でインデックスできないので `instr()` へフォールバックする** — `instr(title, ?) > 0 OR instr(body, ?) > 0` の形で、`LIKE` / `GLOB` は採らない（実測されているのは `instr()` のほうであり、LIKE / GLOB の 50 バイトパターン上限も `instr()` には掛からない）。**フォールバックは索引を使えない全走査なので、対象列とページサイズを制限する。** 正規化はインデックス側・クエリ側の両方で NFKC + `trim()` を通し、スニペットは正規化前の原文から組み立てる（SQL の `snippet()` / `highlight()` に依存しない）。実環境での再検証は #37（第2.1.1節）。

**`spec/adr/005-search-index-via-outbox.md` の参照側は6箇所あり、そのすべてを差し替える（#35 の対応項目4）。** ADR 本文は書き換えないが、**supersede 済みの ADR へ無注記でリンクしている参照は1本も残さない**。実測は次の6本で、`grep -rn '005-search-index-via-outbox' spec --include='*.md' | grep -v '^spec/adr/005'` で再現できる — `spec/index.md:42` / `spec/database/index.md:6` / `spec/domains/search.md:3` / `spec/domains/knowledge.md:6` / `spec/domains/memo.md:6` / `spec/usecases/search.md:3`。**差し替え後の指し先は `.adr/003-sqlite-fts5-only-search.md`（根拠側）と `.adr/004-do-local-commit-and-alarm-jobs.md`（方式側）で、`spec/adr/005` が superseded であることを併記する**（第7.1節）。下の各表の該当行にも同じ指示を書いてあるが、**表の行の他の指示（イベント定義表の削除など）を実行しても「関連 ADR」のリンク行には触れずに済んでしまう**ので、横断指示としてここにも置く。

#### 改訂する — 要件・体験側

| ファイル | 削除する記述 | 追加・置換する記述 |
|---|---|---|
| `spec/idea.md` | `:40` 「メモ・ドキュメント横断の**ハイブリッド検索**」。`:48` の技術要素「Unit of Work + **Outbox / ドメインイベント**」 | `:40` は「メモ・ドキュメント横断の全文検索（SQLite FTS5）」。`:48` は「Unit of Work（DO ローカルの同期トランザクション）+ Alarm ジョブ」。**履歴文書として除外しない** — #35 の対応項目1が明示的に改訂を要求している |
| `spec/requirements.md` | `:87` 付近「キーワード検索とベクトル検索のハイブリッドを単一の検索として提供する」。`:108` 付近の公開インターフェース「search — ハイブリッド検索」 | `:87` は「SQLite FTS5 による全文検索として提供する」、`:108` は「search — 全文検索。トピックによる絞り込み可」。「検索方式の選択をAIに委ねない」は**維持する**（単一の検索であることは変わらない）。**非機能要件にユーザー単位 DO の物理分離を追加する**（上記要旨） |
| `spec/scenario/search.md` | `:6` / `:25` のハイブリッド検索前提。「投稿直後は検索にヒットしない場合がある」という非同期反映の前提 | 全文検索へ置き換え、**同期更新なので投稿直後から必ずヒットする**に反転（第7.1節） |
| `spec/scenario/ai.md` | `:19` 「AIが search（**ハイブリッド検索**。必要ならトピック絞り込み）で…」 | 「AIが search（全文検索。必要ならトピック絞り込み）で…」 |
| `spec/scenario/index.md` | `:42` 「キーワードでメモ・ドキュメントを横断検索する（**ハイブリッド検索**）」 | 「キーワードでメモ・ドキュメントを横断検索する（全文検索）」 |
| `spec/pages/index.md` | `:180` 付近 P-11（検索）の説明にあるハイブリッド／ベクトルの語 | 全文検索の語に置き換える |

#### 改訂する — ドメイン

| ファイル | 削除する記述 | 追加・置換する記述 |
|---|---|---|
| `spec/domains/search.md` | **271行の大半。** **`:3` の「インデックス更新は Outbox 経由の consumer が非同期で行う（[ADR-005]）」**、「検索の規則」の非同期反映条項、`SearchIndexPort` の `upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument`、**`IndexerReadPort` の節（4メソッド）を全削除**、「`EmbeddingPort` について」の節を全削除、エラーコード `SystemError(EmbeddingFailed)`、**「インデックス更新フロー」の節（イベント→consumer 処理の対応表を含む）を全削除**、`:264` の「indexer 専用の拡張ワーカーコンテナ」 | `SearchIndexPort` を `query` 1メソッドへ縮小し同期契約にする。「本体更新と同一トランザクションで projection を更新する」（第7.1節）。external-content FTS5 の実装制約2点（旧値 delete → 新値 insert、`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にし `id TEXT` を UNIQUE の別列にする）。第7.2.1節の検索 API 仕様（topic filter / 安定順位 `timestamp DESC, type, id` / スナップショットページング / 検索エントリとトピックの join）を新しい入力として反映。**`:3` の冒頭説明を「インデックスは本体更新と同一トランザクションで維持する」へ書き換え、`ADR-005` への参照を `.adr/003` / `.adr/004` へ差し替える**（`spec/adr/005` は superseded） |
| `spec/domains/index.md` | テナント分離規約の**例外条項**「例外は Outbox 経由の信頼済み内部イベントを契機とするワーカー（search の indexer consumer 等）のみ」。「ドメインイベント + Outbox」の横断事項 | テナント分離規約を第4.5節の読み替えへ（`userId` 第一引数 → DO 選択で消費、**例外なし**）。全ドメインポートが同期契約になること（第8.2.1節） |
| `spec/domains/memo.md` | イベント定義表。リポジトリ契約の `userId` 第一引数と `Promise`。**`:6` の「関連 ADR」行にある `[ADR-005]` へのリンク** | 同期契約のリポジトリ定義。`purge_after` を保存する retention（第7.5節。復元時に `NULL` へ戻す）。**`:6` の `ADR-005` を `.adr/003` / `.adr/004` へ差し替える**（`spec/adr/005` は superseded。上の横断指示） |
| `spec/domains/knowledge.md` | 同上。`document.sourceLinksChanged` / `memo.sourceLinksChanged` の**イベント**としての定義。**`:6` の「関連 ADR」行にある `[ADR-005]`（イベント経由のインデックス更新）へのリンク** | 同一トランザクション内の projection 更新として書き直す。**`:6` の `ADR-005` を `.adr/003` / `.adr/004` へ差し替える**（上の横断指示） |
| `spec/domains/identity.md` | `identity.aiClientRevoked` の失効 consumer の記述、イベント定義表、`User = PasswordUser \| SsoUser` の判別共用体 | クレデンシャル集合として書き直す（第6.6節）。`UserRepository` を「認証情報側（Directory）」と「ユーザー単位設定側（User Data DO）」に分割（第4.3節の行11 / 行7c）。`findActiveById` を自己完結トークン前提に（第5.4節）。`Email` の canonical 化規則を第5.2.1節に差し替え（**長さ上限 320 と構造チェックは残す**）。`PasswordResetTokenPort.issue` の行き先が Directory であること（第4.3節の行7b） |
| `spec/domains/trash.md` | `TrashQueryPort.listExpiredItems`。`:239` の「pruner 専用の拡張ワーカーコンテナ」 | 各 DO の Alarm による期限処理（第7.5節）。`RetentionPolicy` の算出規則は維持しつつ「期限を `purge_after` に保存する」へ |
| `spec/domains/export.md` | `ExportSourceReader.readAll` / `ArchiveWriter.write` の `Promise` と `userId` 引数（`:264` / `:275`） | 読み出しは DO 内の同期契約、zip エンコードは request Worker（第4.8節・第8.3節 (a)）。`ExportRenderer.render`（`:249`）は純粋計算のまま |

#### 改訂する — ユースケース

| ファイル | 削除する記述 | 追加・置換する記述 |
|---|---|---|
| `spec/usecases/search.md` | `maintainSearchIndex`（`:85` 以降）を**ユースケースごと削除**。`:93` の「indexer 専用の拡張ワーカーコンテナ」。**`:3` の上流参照にある `[ADR-005]` と「検索インデックスの維持（consumer）」** | `search` は残す。非同期反映の注記を落とす。**`:3` の上流参照から consumer への言及を外し、`ADR-005` を `.adr/003` / `.adr/004` へ差し替える**（上の横断指示） |
| `spec/usecases/trash.md` | `pruneExpiredTrashItems`（`:311` 以降）。`:315` の「pruner 専用の拡張ワーカーコンテナ」 | Alarm 前提の期限処理へ書き換える（第7.5節） |
| `spec/usecases/identity.md` | `:10` の共通事項「イベントドラフトを `collectEvents` に渡す（Outbox に同一トランザクションでフラッシュされる）」、`:47` / `:95` / `:237` / `:280` / `:324` / `:434` / `:470` の `collectEvents(eventDrafts)` 手順、`:411` の「`identity.aiClientRevoked` イベントの consumer として実行される」 | 共通事項を「書き込みは `UnitOfWorkProvider.run` 内の**同期**コールバックで行う。ドメインイベントは発行しない」へ。`:411` は「失効の権威は `ai_client_connections.status` であり、次のリクエストの DO 内ガードが直読みする」（第5.4.1節 (b)）へ。`:150` のログアウト記述は「イベントが存在しない」が自明になるので、イベントへの言及を落とす |
| `spec/usecases/knowledge.md` | `:16` の「**イベント**: ドメインの振る舞いが返す `EventDraft` を同一 UoW 内で `collectEvents` に渡す（Outbox 経由。ADR-005）」、`:79` / `:122` / `:268` / `:322` / `:387` / `:440` / `:493` / `:535` の `collectEvents(drafts)` 手順、`:267` / `:320` / `:534` のイベントドラフト取得 | 同一 UoW 内の projection 更新へ置き換える。`:321` の「イベントも発行しない」という但し書きは前提ごと消えるので、トピック touch の説明から落とす |
| `spec/usecases/memo.md` | `:51` / `:232` / **`:359`**（`rollbackMemo` の `memo.edited`）/ `:396` / `:434` / `:474` / `:572` の `collectEvents(eventDrafts)`（**実測7箇所**。`grep -n 'collectEvents' spec/usecases/memo.md` で再現できる）と、その括弧内の「Outbox へ。search consumer がインデックスに upsert する」「search consumer が最新本文を読み直して upsert」「search consumer がインデックスから除去し…再 upsert する」 | **`collectEvents` は条件付きではなく確定で消える**（第7.3節）。括弧内の説明を「同一 `transactionSync` の中で `search_entries` / `search_fts` の projection を更新する」（第7.1節）へ置き換える。`:48` / `:227` / `:354` / `:392` / `:470` の「UnitOfWork 内で」は同期コールバックの意味に読み替える |
| `spec/usecases/export.md` | `:5` の「リポジトリ・UoW・ドメインイベントは登場しない」のうちドメインイベントへの言及 | 読み出しを DO 内の1回の `transactionSync` で完結させ、レンダリングと zip を request Worker で行う分割（第4.8節）。1回のエクスポートで返せる総バイト数に上限があること |

#### 改訂する — テストケース

イベントを期待値に持つケースは、**ドメインイベントが transport としても業務表現としても残らない**（第7.3節）ため全件が対象になる。書き換え方は3通りしかない。

- **(A) イベント期待を projection の期待へ読み替える** — 「`memo.created` イベントが Outbox に記録される」→「同一トランザクションで `search_entries` / `search_fts` に該当エントリが作られる」。
- **(B) イベント期待を落とす** — リビジョン（`memo_revisions` / `document_revisions`）が業務上の変更履歴を既に持つので、履歴の期待はそちらへ寄せる。
- **(C) ケースごと削除する** — 対象機構が消滅する場合。

| ファイル | ヒット行と内容 | 指示 |
|---|---|---|
| `spec/testcases/search/maintainSearchIndex.md` | ユースケースごと消滅 | **(C) ファイルごと削除** |
| `spec/testcases/search/search.md` | `:12` 「同一項目がキーワード検索・**ベクトル検索**の双方にヒットする」/ `:28` 「インデックス更新（**非同期 consumer**）が未完了」 | `:12` は **(C)** ケースごと削除（統合対象が無い）。`:28` も **(C)** — 同期更新になるとケースが成立しない。代わりに「投稿直後の検索で必ずヒットする」を新設する |
| `spec/testcases/trash/pruneExpiredTrashItems.md` | `:7`〜`:22` の全ケースが pruner・`listExpiredItems`・`batchSize`・ユーザー横断抽出を前提 | Alarm 前提へ全面書き換え。起動契機は cron から `purge-trash` ジョブへ、`listExpiredItems` は自 DO の `purge_after` 索引へ、`:16` のユーザー横断ケースは **(C)** 削除（DO 内に他ユーザーが居ない）。`:8` の「インデックス除去・再構築は outbox 経由の consumer に委ねられる」は **(A)** |
| `spec/testcases/trash/emptyTrash.md` | `:7` イベント発行を含む消去手順 / `:12` 「並行操作（**pruner** / hardDeleteTrashItem）」/ `:15` 「項目ごとの **UnitOfWork**」 | `:7` は **(A)**、`:12` は競合相手を「`purge-trash` ジョブ」へ差し替え、`:15` は同期 UoW の意味に読み替え |
| `spec/testcases/trash/hardDeleteTrashItem.md` | `:17` 「並行する emptyTrash / **pruner** が先に消去済み」/ `:24` 「リンク消去・**イベント**も取り消される」 | `:17` は競合相手を `purge-trash` ジョブへ、`:24` は **(B)** |
| `spec/testcases/trash/restoreDocument.md` | `:9` / `:36` 「イベントなし」「`document.restored` が収集される」/ `:55` 「**pruner** / ハードデリートとの並行実行」 | `:9` / `:36` は **(A)**（復元で projection が再構築される）、`:55` は競合相手を `purge-trash` ジョブへ |
| `spec/testcases/trash/restoreMemo.md` | `:7` 「`memo.restored` イベントが収集される」/ `:9` 「`memo.restored` により **search consumer** が再インデックス…する契機となる」/ `:16` 「イベントも発行されない」 | `:9` は **(A)** — 「復元と同一トランザクションで `search_entries` / `search_fts` が再構築され、出典先ドキュメントのエントリも同時に更新される」。`:7` / `:16` は **(B)** |
| `spec/testcases/trash/restoreTopic.md` | `:18` 「並行操作（ハードデリート・**pruner**・別の復元）」 | 競合相手を `purge-trash` ジョブへ差し替え |
| `spec/testcases/memo/postMemo.md` | `:9` 「`memo.created` イベント…が同一 UoW で **Outbox** に記録される」/ `:19` 「イベントのいずれも記録されない」 | `:9` は **(A)**、`:19` は **(B)** |
| `spec/testcases/memo/post_memo.md` | `:9` 「`memo.created` イベントが同一 UoW で **Outbox** に記録される（**search consumer** が upsert）」 | **(A)** |
| `spec/testcases/memo/editMemo.md` | `:8` 「`memo.edited` イベントが **Outbox** に記録される」/ `:10` / `:25` イベント非発行 | `:8` は **(A)**、残りは **(B)** |
| `spec/testcases/memo/update_memo.md` | `:8` 「`memo.edited` イベントが **Outbox** に記録される」/ `:10` イベント非発行 | 同上 |
| `spec/testcases/memo/rollbackMemo.md` | `:8` 「`memo.edited` イベントが **Outbox** に記録される（専用イベントはない）」/ `:9` イベント非発行 | 同上 |
| `spec/testcases/memo/softDeleteMemo.md` | `:8` 「`memo.trashed` イベント…が **Outbox** に記録される（**search consumer** がインデックスから除去し、出典先ドキュメントのエントリを再 upsert する）」/ `:17` | `:8` は **(A)**、`:17` は **(B)** |
| `spec/testcases/memo/delete.md` | `:8` 「`memo.trashed` イベントが同一 UoW で **Outbox** に記録される（**search consumer** がインデックスから除去…）」/ `:18` | 同上 |
| `spec/testcases/knowledge/createTopic.md` | `:7` 「`topic.created` イベントが同一 UoW で **Outbox** に記録される」/ `:20` | `:7` は **(B)**（トピックは `search_entries` の join 相手であり、それ自体はエントリを持たない）、`:20` も **(B)** |
| `spec/testcases/knowledge/createDocument.md` | `:7` 「`document.created` イベントが記録される」/ `:29` 「トピックの**イベント**は発行されていない」 | `:7` は **(A)**、`:29` は **(B)**（touch の意味は version インクリメントだけになる） |
| `spec/testcases/knowledge/editDocument.md` | `:7` 「`document.edited` イベントが記録される」/ `:10` イベント非発行 | `:7` は **(A)**、`:10` は **(B)** |
| `spec/testcases/knowledge/editDocumentByAi.md` | `:15` 「リビジョンは積まれずイベントも発行されない」 | **(B)** |
| `spec/testcases/knowledge/rollbackDocument.md` | `:7` / `:10` | `:7` は **(A)**、`:10` は **(B)** |
| `spec/testcases/knowledge/trashDocument.md` | `:7` / `:16` | `:7` は **(A)**、`:16` は **(B)** |
| `spec/testcases/knowledge/trashTopic.md` | `:7` 「`topic.trashed` 1 件 + `document.trashed` 2 件のイベントが同一 UoW で記録され」/ `:19` | `:7` は **(A)**（配下ドキュメントのエントリが同一トランザクションで除去される）、`:19` は **(B)** |
| `spec/testcases/knowledge/updateTopic.md` | `:7` / `:10` / `:11` / `:13` / `:14` / `:15` / `:28` のイベント期待6件 | 全件 **(B)**。`:15` の「両イベントが記録される」は「rename と archive が順に適用される」だけを残す |
| `spec/testcases/identity/registerWithPassword.md` | `:7` 「`identity.userRegistered`…イベントが **Outbox** に同一トランザクションで記録される」/ `:22` | 全件 **(B)** |
| `spec/testcases/identity/registerOrLoginWithSso.md` | `:7` / `:9` | **(B)**。あわせて **signup saga（第6.3節）の phase 順に合わせて期待値を書き直す** — Directory 予約に勝ってから User Data DO が初期化される |
| `spec/testcases/identity/revokeAiClientConnection.md` | `:7` / `:12` / `:15` のイベント期待。**`:8` 「アダプター（イベント consumer）の挙動を確認する」「`identity.aiClientRevoked` を契機にトークンストアの実トークンが削除され」** | `:8` は **(C)** — 購読者そのものが消える（第7.3節）。代わりに「`status = 'revoked'` の次のリクエストで DO 内ガードが拒否する」ケースへ置き換える（第5.4.1節 (b)）。残りは **(B)** |
| `spec/testcases/identity/changePassword.md` | `:7` / `:19` | **(B)**。あわせて **credential 変更 saga（第6.5.1節）の中間状態**（`changeState: 'pending'` の間は旧新どちらのパスワードも通らない）と `sessionEpoch` の前進をケースに足す |
| `spec/testcases/identity/executePasswordReset.md` | `:7` / `:22` | 同上 |
| `spec/testcases/identity/changeTrashRetentionDays.md` | `:7` / `:18` | **(B)**。あわせて「変更と同一トランザクションでゴミ箱内全項目の `purge_after` を再計算し Alarm を張り直す」を足す（第7.5節） |
| `spec/testcases/identity/approveAiClientAuthorization.md` | `:9` / `:16` | **(B)** |
| `spec/testcases/identity/denyAiClientAuthorization.md` | `:9` 「イベントも発行されない（拒否の事実はドメインに残らない）」 | **(B)**。イベントが存在しないので括弧内の理由だけを残す |
| `spec/testcases/identity/logout.md` | `:9` 「ドメイン状態の変更・**イベント発行**・永続化は一切発生しない」 | **(B)** |

#### 改訂する — 台帳

| ファイル | 削除する記述 | 追加・置換する記述 |
|---|---|---|
| `spec/inventory/domain.md` | search の `IndexEntry` 系のうちベクトル・埋め込み由来のもの、identity の `User` 判別共用体、trash の期限列挙 | クレデンシャル集合としての identity、`purge_after` を持つ trash |
| `spec/inventory/adapter.md` | 第4.3節で「不要になる」と判定した全件（`ADP-search-006`〜`009` / `ADP-search-002`〜`005` / `ADP-trash-004` / `ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001` / `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-occ-guard-001` / `ADP-search-embeddings-001`） | 残りから `userId` 第一引数と `Promise` を落とす。`ADP-identity-001`〜`003` は Directory 側と User Data 側に割る。**`ADP-knowledge-027`（`deleteSourceLinksByMemo`）の契約から「`userId` スコープは documents 側 JOIN で行う」という規則を撤回する**（第4.3節の行25b）。**`ExportRenderer.render`（`spec/domains/export.md:249`）に `ADP-*` ID を採番する**（現在は台帳から漏れている。第4.3節）。第4.1.1節の新設テーブル群（`credential_mappings` / `credential_locators` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` / `_meta` / `password_reset_tokens` / `account` / `user_settings`）に対応する `ADP-*` を新設する |
| `spec/inventory/usecase.md` | `UC-search-002`（`maintainSearchIndex`） | `UC-trash-007`（`pruneExpiredTrashItems`）を Alarm 前提へ書き換える。**「ポート契約が変われば台帳も変わる」は usecase 台帳にも等しく効く** |
| `spec/inventory/test.md` | `TC-maintainSearchIndex-*` 28件 | `TC-pruneExpiredTrashItems-*` 17件を書き換える。上のテストケース表で **(C)** にした個別ケースを台帳からも落とす |
| `spec/inventory/frontend.md` | — | **`PAGE-search-001`〜`004`（`:55-58`）と `PAGE-document-edit-002`（`:50`）は全文検索でも記述が変わらないので削除しない。** #35 の受け入れ条件7（#10 の実装チェックリストとの照合）の照合対象はこの5行である。**追加が要るのは `PAGE-password-reset-*` と `PAGE-settings-*` の側**で、リセット完了画面の必須導線（クレデンシャル一覧 + AI クライアント接続一覧 + 「すべて失効」）に対応する `PAGE-password-reset-004` 相当を新設する（第5.1節・第5.4節 (ii)）。`PAGE-settings-005`（パスワード変更）の「SSOのみのユーザーにはフォーム自体を非表示」はクレデンシャル集合による判定へ読み替える（第6.6節） |

#### 改訂する — DB・索引・マニュアルテスト

| ファイル | 削除する記述 | 追加・置換する記述 |
|---|---|---|
| `spec/database/index.md` | **403行の前提（共有 SQLite + `user_id` 列による論理分離）ごと。** 全テーブルの `user_id` 列と先頭 `user_id` の複合索引、`outbox` / `processed_events` / `_occ_guard` の節、`search_embeddings`、期限切れ索引3本（`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`）、D1 / libSQL / Turso の並列記述、`:355-357` の「認証インフラテーブルはスコープ外」宣言 | 第4.1.1節のテーブル全数（**`credential_mappings` / `credential_locators` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` / `_meta` / `password_reset_tokens` / `account` / `user_settings` は新設**）。`search_fts` を external-content 構成（`content='search_entries'` / `content_rowid` は既定の `rowid`。`search_entries` の PK は `rowid INTEGER PRIMARY KEY` で `id TEXT` は UNIQUE の別列）へ。`purge_after` 列と DO ローカルの索引。**DO の schema version / lazy migration 方針**（上記要旨）。**FTS5 tokenizer 方針**（上記要旨）。冒頭の `spec/adr/005-search-index-via-outbox.md` への参照を `.adr/003` / `.adr/004` へ差し替え |
| `spec/index.md` | — | `:38-43` の ADR 一覧表に `spec/adr/005-search-index-via-outbox.md` の superseded を反映し、`.adr/002`〜`.adr/004` への導線を足す |
| `spec/manual-tests/search.md` | `:17` 「検索インデックス更新用のワーカー（**非同期 consumer**）が起動している」という環境前提。`:5` / `:69` / `:266` の非同期反映前提 | consumer は存在しないので環境前提ごと削除する。「投稿直後は検索にヒットしない場合がある」の確認項目は**必ずヒットする**に反転する |
| `spec/manual-tests/document.md` | `:25` 「検索インデックス更新ワーカーが起動していること。インデックス反映は非同期のため…1〜2分待つ」/ `:131` の同趣旨の前提 | 同上。待ち時間の指示ごと削除する。**語彙走査では拾えなかったファイルである**（「consumer」ではなく「ワーカー」と書かれている） |
| `spec/manual-tests/ai.md` | `:50` 「AI の search（**ハイブリッド検索**）が…」 | 「AI の search（全文検索）が…」 |
| `spec/manual-tests/trash.md` | `:18` / `:204` / `:212` / `:351` の「**pruner** ワーカーを手動起動できること」。`:211` / `:335` / `:348` の「テスト環境の DB で `trashedAt` を直接更新できること」 | **Alarm の強制発火 / 時計の巻き戻しに相当する手段**へ置き換える。共有 DB が無くなるので `wrangler d1 execute` 相当の直接更新も成立しない。代替手段の実体は #38（第11.3節） |
| `spec/manual-tests/timeline.md` | `:29-33` の「テスト環境の DB を直接更新」手順（`UPDATE memos SET posted_at = ...`） | ユーザー単位 DO 内の SQLite に対する手段へ置き換える（DO 単位のシード投入、または開発用の RPC）。代替手段の実体は #38 |
| `spec/manual-tests/settings.md` | `:37-44` / `:93` の同趣旨の DB 直接更新手順 | 同上。**語彙走査では拾えなかったファイルである** |
| `CLAUDE.md` | 「Reference runtime」の「ランタイムを差し替えても `domain` / `application` / `presentation` は無傷」。「Key concepts」の **Outbox / domain events** の項全体。「Retry strategy」の D1 固有の記述 | **第7.7節を正文としてそのまま写す**（at-least-once / 順序保証なし / 冪等性 / OCC を握り潰さない / 冪等キーをクライアントに持たせない）。「Unit of Work」は第8.2節の同期契約へ。「Reference runtime」は Cloudflare ロックインの具体的な現れ方として第8.2.1節の結論を書く。DB 制約は第2.1節 F-17 と第4.4節へ |

#### 改訂する — 手段4 でのみ拾えたもの

**語彙走査・ポート目視・環境前提目視のいずれにも掛からなかった9件である。** 本設計が**足した**振る舞いに触れているため改訂が要る。

| ファイル | 現行の記述と本設計との衝突 | 指示 |
|---|---|---|
| `spec/testcases/identity/requestPasswordReset.md` | 「該当メールのユーザーが未登録 → **トークン発行・メール送信は行われず**正常終了する」は第7.6節（mapping が無くてもジョブ行を必ず書く）の**結論の反対**。「同一メールで連続してリセットを依頼する → **依頼ごとにトークンが発行される**」は第6.2.2節 (b) のレート制限と衝突する。`PasswordResetTokenPort.issue(user.id, now)` / `UserRepository.findByEmail` は第4.3節 行7b / 行5 で Directory へ移る。`SsoUser` 前提のケースは第6.6節で前提ごと変わる | 期待値を「**登録済み / 未登録 / SSO のみ / スロットル中の4ケースで処理経路が完全に一致する**（同じ `transactionSync` でジョブ行を1行書き、同じ `setAlarm` を発行し、同じ応答を返す。違うのは行の中身だけ）」へ書き換える（第7.6節）。**同じ canonical への連打が `operationKey` によりジョブ行1本に収束する**ケースを足す。**ジョブ行に載るのは `tokenId` だけで生トークンは載らない**（第6.1節 (d)）と、**新しいトークンの発行がその credential の未使用トークンを全部置き換える**（同）をケースに足す |
| `spec/testcases/identity/loginWithPassword.md` | 11ケース全部が「`findByEmail` を引いて `PasswordHasher.verify` する」現行フロー前提で、第5.3節が足した手順が1つも無い | 次の6ケースを足す。(i) **到達性検査**（step 5 (ii)）— Directory に mapping が残っているが `credential_locators` に active 行が無いと拒否される。(ii) **`credentialVersion` 不一致**（step 5 (iii)）で拒否される。(iii) **`changeState: 'pending'` 中**は行が存在してもダミー材料が返り照合が成立しない。(iv) **`nextAttemptAllowedAt` 未到達**の試行はダミー経路へ倒れ、成功・失敗を区別できない（第6.2.2節 (a)）。(v) **step 7 の報告** — 成功で `failedAttempts` がリセットされ、失敗で前進する。(vi) **鍵ローテーション中**に `credential_locators` が両世代の行を持っていてもログインできる（第6.8節 手順2）。「同一メールの `SsoUser`」ケースは第6.6節のクレデンシャル集合へ読み替える |
| `spec/testcases/identity/getCurrentUser.md` | `authMethod: "password"` / `"sso"` が `User = PasswordUser \| SsoUser` の判別共用体を前提にしている。また `email` を返すが、原本は Directory bucket の `encryptedCanonical` にしか無い | `authMethod` を「**保有クレデンシャルの種別集合**」へ読み替える（第6.6節）。**集合の要素は `{ credentialId, kind, label }` の3つ組である**（第6.1.2節 (C5)）— `credentialId` が unlink の対象指定に使われるので、DTO から落とすと解除操作が書けなくなる。**一覧には `kind = 'email'` の行も出すが、解除操作を出してよいのは `kind = 'sso'` の行だけである**（第6.6節 unlink 手順1 (1-a)。権威は DO 側にあり、`kind = 'email'` の unlink は `BusinessRuleError` で拒否される。UI の出し分けは二重の防波堤である）。`email` の取得は**第6.2.1節 (c) の復号許可経路 (4)**（認証済み本人の自己参照）に当たることを明記し、`provider` / `providerSubject` を返さない現行の期待は維持する（`label` は provider 名までで subject を含まない） |
| `spec/testcases/identity/listAiClientConnections.md` | 「active と revoked の混在」ケースはあるが、**リセット完了による自動失効**のケースが無い | 「**パスワードリセットを完走すると、`createdAtCredentialVersion` が前進前の値と等しい接続だけが `revoked` になり、それより古い接続は `active` のまま残る**」ケースを足す（第5.4節 (i)）。通常のパスワード変更では失効しないことも足す |
| `spec/testcases/export/exportAllData.md` | 第4.8節が「1回のエクスポートで返せる総バイト数に上限を置き、超過は拒否する」と決めたのに**上限超過ケースが無い**。読み出しと render / zip の実行位置分割（第8.3節 (a)）も期待値に無い | **上限超過で `SystemError` 系になる**ケースを足す（上限値そのものは #37 → #38 で決まるので、テストケースは「上限を超えると拒否される」まで書く）。`ExportSourceReader.readAll` が **DO 内の1回の `transactionSync`** で完結し、`ExportRenderer.render` / `ArchiveWriter.write` が **request Worker** で回ることを前提の欄に明記する |
| `spec/testcases/trash/listTrash.md` | `:16` / `:17` が `expiresAt` を「**保存値ではなく照会時算出。遡及適用**」と期待している。第7.5節は `purge_after` を**保存**し、`trashRetentionDays` の変更と同一トランザクションで一括再計算すると決めた | 遡及適用という**結果**は変わらないので、期待値の**根拠**だけを「変更と同一トランザクションで全項目の `purge_after` が再計算され、Alarm が張り直される」へ差し替える（第7.5節）。`:19` の「他ユーザーのゴミ箱」は第4.5節の読み替え（DO 内に他ユーザーの行が存在しない）へ |
| `spec/scenario/account.md` | S-AC-01 / S-AC-02 / S-AC-07 のいずれにも、本設計が足した前提と導線が無い | (i) **S-AC-01 に「メールアドレスの所有確認は行わない」ことを既知の前提として明記する**（第5.2.1節 (a)）。所有の唯一の証明はパスワードリセット経路である。(ii) **S-AC-02（SSO 初回自動登録）はメール一意性が SSO にも掛かるので Directory bucket を2つ跨ぐ**（第6.3節）。「初回なら自動でアカウントが作成され」の裏で予約が2本走ることを異常系に反映する（メール側が既に他アカウントで使われていれば SSO 登録も敗北する）。(iii) **S-AC-07 のリセット完了に必須導線を足す** — クレデンシャル一覧と AI クライアント接続一覧（「すべて失効」つき）を提示し、覚えの無いものを解除させる（第5.1節・第5.4節 (ii)）。(iv) 「SSO のみのユーザーにパスワード変更を出さない」はクレデンシャル集合に `kind: 'email'` があるかで判定する |
| `spec/manual-tests/account.md` | 562行の手順書全体が現行フロー前提。TC-29 は「requestPasswordReset が SSO ユーザーにトークンを発行しない」を対象外理由に使っている | 上の `spec/scenario/account.md` の変更を手順へ落とす。加えて (i) **ロックアウト**（`nextAttemptAllowedAt`）の再現と、リセット / SSO という2本の脱出経路の確認手順、(ii) **リセット完了後に直近世代の AI クライアント接続だけが失効している**ことの確認、(iii) **リセット完了画面の必須導線**の確認、(iv) TC-29 の対象外理由を「応答も処理経路も同一なので UI からは区別できない」へ差し替える（第7.6節） |
| `spec/inventory/frontend.md` | 下の「改訂する — 台帳」に行を置いた | 同上 |

#### 影響なし（判定済み）

**29件である。** いずれも「本文を改訂しない」という判断であって、走査から落としたわけではない。

手段1〜3 がヒットさせたうちの2件は次のとおり。

| ファイル | ヒット行 | 判定の理由 |
|---|---|---|
| `spec/adr/004-domain-boundaries.md` | `:25` 「『単一の**ハイブリッド検索**』という要件（検索方式の選択をAIに委ねない）に反して入口が分かれる。不採用」 | ADR 本文は過去の決定の記録であり書き換えない（#35 の対応項目4が「ADR 本文は書き換えず、参照側を更新する」と定めている）。ドメイン境界の切り方そのものは変えない（第4.2節）。**引用されている要件が「単一の全文検索」へ変わっても、棄却理由（入口が分かれる）は成立し続ける** |
| `spec/adr/005-search-index-via-outbox.md` | 全文 | 本 Issue でステータス行に supersede ポインタを付けた。本文は改訂しない。`.adr/003` が根拠側を、`.adr/004` が方式側を supersede している（第7.1節） |

手段4 で判定した27件は次のとおり。

| 群 | ファイル | 判定の理由 |
|---|---|---|
| ADR 本文4件 | `spec/adr/001-restore-document-without-topic.md` / `002-export-scope.md` / `003-source-link-after-hard-delete.md` / `006-memo-fulltext-update.md` | ADR 本文は書き換えない（#35 の対応項目4）。決定の内容（復元先を失ったドキュメントの扱い / エクスポート範囲 / ハードデリート済み出典の表示 / メモは全文置換のみ）はいずれも物理境界に依存しないので、DO 化後も成立し続ける。**`002-export-scope.md` は第4.8節の読み出し上限とは別の論点**である — 上限はサイズの制約であって範囲の定義ではない |
| デザイン3件 | `spec/design/index.md` / `tokens.md` / `icons/logo.md` | 視覚言語とトークン定義のみ。永続化・検索・認証のいずれにも触れない |
| UI 指摘メモ1件 | `spec/issues.md` | 画面の見た目に対する未整理の指摘リスト。設計の前提を持たない |
| マニュアルテスト目次1件 | `spec/manual-tests/index.md` | 件数表と推奨実行順序だけを持つ。手順の実体は各ファイルにあり、そちらで改訂される |
| シナリオ4件 | `spec/scenario/document.md` / `settings.md` / `timeline.md` / `trash.md` | 利用者から見た振る舞いだけを書いており、本設計が変えたのは実現手段だけである。とくに `trash.md` の「保持期限が経過した項目は自動でハードデリートされる」「短く変更すると既存項目にも適用される」は、pruner から Alarm へ替わっても**利用者から見た結果が変わらない**（第7.5節） |
| 読み取り系テストケース14件 | `spec/testcases/memo/{diffMemoRevisions,get,getTimeline,jumpToDate,listMemoRevisions,recent_memos,showMemoInTimeline}.md` / `spec/testcases/knowledge/{diffDocumentRevisions,getDocument,getTopic,listDocumentRevisions,listDocumentSourceMemos,listDocumentsReferencingMemo,listTopics}.md` | 読み取り専用でイベント・インデックス・非同期反映のいずれにも触れない。**「他ユーザーの ID を指定すると `NotFoundError`」という期待は DO 化後も同じ結果に落ちる** — DO の中に他ユーザーの行が原理的に存在しないためで、変わるのは理由の語（`userId` スコープ → 到達可能性）だけである。その読み替えは `spec/domains/index.md` のテナント分離規約の改訂（第4.5節）で一括して効くので、個々のテストケースは触らない |

### 11.2 #37 への引き継ぎ — 変更対象のモジュールと UoW 契約の新旧対比 ［Issue 要求］

#### 変更対象（区分つき）

**区分を取り違えると事故になる。** 「削除」は消してよいもの、「作り直す」は同じ役割の別実装に置き換えるもの、「改修」は残したまま手を入れるものである。

| 区分 | パス | 内容 | 根拠 |
|---|---|---|---|
| **削除** | `packages/core/src/adapters/d1/`（20ファイル / 2,514行。うちプロダクションコード8ファイル / 914行） | D1 アダプター一式。`unitOfWork.ts` / `pendingBatch.ts` / `schema.ts` の `_occ_guard` / `repositories/` / `migrations/` | 第8.1節 |
| **削除** | `packages/core/src/application/workers/`（`eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 の2本 + `__tests__/`。**consumer / DLQ はここに無い**） | relay / prune | 第7.3節 |
| **削除** | `packages/core/src/application/ports/outboxRepository.ts` / `relayTrigger.ts` / `idempotencyStore.ts` | Outbox を transport から外すと3本とも役割が消える。冪等性は `operations` テーブルへ移る | 第7.3節 |
| **削除** | `packages/core/src/application/events/buildDecoder.ts`（37行） | Outbox 行の payload を復号する `buildEventDecoder`。読む相手のテーブルごと消える | 第7.3節 |
| **削除** | `packages/core/src/domain/common/event.ts`（81行） | **ドメイン層のイベント抽象の定義元。** `EventId` / `DomainEventDraftBase` / `DomainEventBase` / `DomainEvent` / `EventDraft` / `EventDecoder` / `WithEventDrafts` / `attachEventIds` の全部。**「抽象ごと消える」（下の H-6）の実体はこのファイルである** | 第7.3節 |
| **削除** | `packages/core/src/domain/identity/events.ts`（62行） | `UserRegisteredEvent` / `PasswordChangedEvent` / `TrashRetentionChangedEvent` の3型と `IdentityEvents` ファクトリ | 第7.3節 |
| **改修** | `packages/core/src/domain/identity/entity.ts`（227行） | **2つの理由で変わる。** (i) `:52` / `:77` / `:103` / `:120` の4ファクトリの戻り値から `WithEventDrafts<..., IdentityEvent>` を外し、エンティティだけを返す形にする（第7.3節）。(ii) `:36` の `User = PasswordUser \| SsoUser` という判別共用体を、クレデンシャルの集合による表現へ読み替える（第6.6節）。**(i) はドメイン層の契約変更であり、第8.2.1節の `Promise` 契約の同期化と同格である** | 第7.3節・第6.6節 |
| **削除** | `apps/web/app/worker/cloudflare/relay.ts` / `consumer.ts` / `pruner.ts` / `dlq.ts` / `handlers.ts`（138行。`handleQueue` :82 / `handleDlq` :120 が consumer / DLQ の実体） | Queue ワーカー一式 | 第7.3節 |
| **作り直す** | `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` | **同ディレクトリの `__tests__/` は上の削除行に含まれない。** #37 の対応項目9 が名指しで「DO 前提へ移植または削除する」と要求しているファイルである。`handleQueue` / `handleDlq` は消えるので**そのままでは移植先が無い** — 後継は「job table + Alarm の実行部を DO 統合テストで検証する」であり、#36 の引き継ぎ項目 H-2 / H-3 / H-4 が求めるテスト（重複起動の合流、in-flight 中の再アラーム、DO 再起動、外部 I/O ジョブの E2E）と同じ枠で書き直す | 第7.3節・第7.4節 |
| **削除** | `apps/web/package.json` の deploy 系（非 dry 12本 = `deploy:staging` / `:relay` / `:consumer` / `:pruner` / `:dlq` / `:all` と production 側の同6本。`:dry` 変種を含めて全24本）と **`db*` スクリプト10本すべて**。内訳は D1 / drizzle 前提の8本（`db:migrate:cf` / **`db:generate:cf`** / `db:apply:{local,staging,production}` / `db:execute:{local,staging,production}`）と、それらに委譲する2本（`db:migrate` / **`db:generate`**）である。**`db:generate` / `db:generate:cf` は初版の列挙から漏れていた** — `db:generate:cf` は `drizzle-kit generate --config=./drizzle.config.ts` で `drizzle.config.ts` が D1 用なので、`packages/core/src/adapters/d1/` の削除と同時に道連れになる | Queue ワーカーの個別デプロイが不要になり、`wrangler d1 ...` は D1 廃止で全滅する。`drizzle.config.ts` も #37 の対応項目7 で消える | 第3.2節・第9.1節 |
| **作り直す** | `packages/core/src/application/execution/unitOfWork.ts` | 同期の新契約へ置き換える（下の新旧対比） | 第8.2節 |
| **作り直す** | `packages/core/src/application/di/serverCloudflare.ts` | `ServerEnv = { DB: D1Database; ...; OUTBOX_* }` を DO バインディング前提へ | 第3.2節・第8.3節 |
| **作り直す** | `apps/web/scripts/render-wrangler.ts` + `apps/web/wrangler.staging.toml.tpl` / `wrangler.production.toml.tpl` | Worker が2本になるので `.tpl` を2系統に増やし、2出力へ拡張する。**`.gitignore` により `wrangler.staging.toml` / `wrangler.production.toml` は生成物であり直接編集してはいけない。** 未コミットの `apps/web/wrangler.{request,state}.{staging,production}.toml` 4本は `.tpl` を通さない手書き実ファイルなので破棄して作り直す。**あわせて `main` をビルド成果物へ向ける**（現行は両 `.tpl` の `:21` が `main = "app/server.cloudflare.ts"` で TS ソースを指しており、redirect 設定を使わない経路 — `wrangler deploy --dry-run` など — がビルドできない。#36 の引き継ぎ項目 H-8 が「`main` の修正は #37 の対応項目8 として依然必要」と明記している）。**DO クラスの宣言は `exports` で行い `new_sqlite_classes` は使わない**（第9.1節。#37 の Issue 本文の当該行は訂正対象である） | 第3.2節・第9.1節 |
| **改修** | `packages/core/src/application/di/types.ts` / `containerStore.ts` | `RequestContainer` から `unitOfWorkProvider` を外し DO facade を足す。**`WorkerContainer` は用途ごと消える。** ただし「そこから拡張していた indexer 専用 / pruner 専用コンテナ」は**実装に存在しない** — 書かれているのは spec 側（`spec/domains/search.md:264` / `spec/usecases/search.md:93` / `spec/domains/trash.md:239` / `spec/usecases/trash.md:315`）だけなので、その撤回は #35 の作業である（第4.3節の行29 / 行30）。`containerStore.ts` は request 側専用として残す（実装は `globalThis` の Symbol スロットのみで、ALS の実体は `apps/web/app/server.cloudflare.ts:4,33,44` 側にある）。**`types.ts:37` 付近の JSDoc（`collectEvents` を「ドメインイベントを enqueue する唯一の経路」として説明している段落）も同時に書き換える** — その経路ごと消えるので、放置すると存在しない機構を説明する JSDoc が残る（第7.3節） | 第8.3節 (b)(c)・第7.3節 |
| **改修** | `packages/core/src/application/errors.ts` | `SystemErrorCode` に **`ServiceOverloaded` と `StorageCapacityExceeded` の2値を追加する**（現行は `DatabaseError` / `DataIntegrityError` / `CryptoError` / `SessionError` / `NetworkError` / `ExternalApiError` の6値）。**`RETRYABLE_SYSTEM_CODES` には入れない** — どちらも retryable false である | 第4.7節 |
| **改修** | `apps/web/app/presentation/errorResponse.ts` | **変更しない、が結論である。** `HTTP_STATUS_BY_KIND` は `kind` 単位のままにし、追加2コードは 500 で返す。`code` 分岐を presentation へ持ち込まない（第4.7節）。#37 はここを触らないことを明示的な決定として扱う | 第4.7節 |
| **改修** | `packages/core/src/application/ports/sessionCodec.ts` | `issue(userId, now)` → **`issue(userId, epoch, now)`**、`verify` の戻り値に **`epoch` を追加**する。epoch を運ぶ口が現行契約に無い | 第5.1節 |
| **改修** | `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` | ペイロードを `{ uid, exp }` から **`{ typ: "session", uid, ep, exp }`** へ広げる。`parsePayload` は `typ` の厳密一致と `ep` の存在を要求する。**`ep` を持たない既存トークンは `verify` が `null` を返す（fail closed）** — 移行の代償は全ユーザーの再ログイン1回で、セッションはロールバックしても再ログインで回復するので互換ウィンドウの対象外である（第5.1節）。あわせて `AI_CLIENT_TOKEN_SECRET` で署名する `typ: "aiClient"` 用の codec を別に立てる（第3.2節・第5.4節） | 第5.1節・第5.4節 |
| **改修** | `packages/core/src/domain/identity/valueObject.ts` の `Email.create` | 正規化部分を第5.2.1節 (a) へ差し替える。**`EMAIL_MAX_LENGTH = 320` と `EMAIL_PATTERN` は維持する**（punycode 変換後にもう一度長さを見る） | 第5.2.1節 (b) |
| **改修** | `packages/core/src/application/identity/registerWithPassword.ts` | UNIQUE 違反の翻訳をアダプターへ戻し、ユースケースの `catch` を落とす（第8.5節）。あわせて **`:46` の `const { entity: user, eventDrafts } = User.registerWithPassword(...)` を `entity` だけの受け取りへ、`:52` / `:56` の `collectEvents` 呼び出しを削除する**（第7.3節。`entity.ts` のファクトリが `WithEventDrafts` を返さなくなるため） | 第8.5節・第7.3節 |
| **改修** | `apps/web/app/presentation/`（`currentUser.ts` / `authState.ts` を除く） | **server-function エントリとエラー応答ミドルウェアは残る。** 変わるのは usecase の直接呼び出しが DO facade 呼び出しになる点だけである | 第8.3節 (c) |
| **改修** | `apps/web/app/presentation/currentUser.ts` / `authState.ts` | **`currentUser.ts:28-33` の JSDoc から `requireUserId()` の「The authoritative guard」という位置づけを外す**（書き換え後は「トークン真正性の前段チェック」で、認可の権威は DO 側の epoch ガード）。**`readAuthStateFn` は DO を叩かないままにする**（全ナビゲーションへ RPC を1本足さない）が、**保護データを返す server 実行点が必ず DO を経由することをテストで固定する**。あわせて「**DO を叩かない server function は保護データを返さない**」を規約として置く。この3点が無いと、epoch を進めて失効させたはずのセッションが認証済みシェルの描画とルーティング判定を通過したままになる | 第5.1節 |
| **改修** | `packages/core/src/application/di/secrets.ts` | **新設5秘密（`AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET` / `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY` と `StateSecrets` の枠）**を、既存 `SESSION_SECRET` と同じ3点の構築境界（下限チェック / ブランド型 / **入れ子配置**）に乗せる。request 側2つは `RequestSecrets` の中、state 側3つは新設する `StateSecrets` の中に置く。keyring には `generation` の一意性・`active` ちょうど1件・`previous` 0〜1件・`bucketCount ≥ 1` の構築時検査を課す。**フラットに置く実装は型エラーを出さずに routing keyring をブラウザへ配る** | 第3.2節 |
| **改修** | `infra/cloudflare/pulumi/resources/index.ts` | D1 リソースと events / DLQ Queue リソースを削除し、DO namespace のレンダリングを足す。**D1 リソースには「D1 is the system of record — refuse accidental destroy」の destroy 保護がかかっているので、解除手順が要る** | 第11.2節末尾 |
| **改修** | ローカル開発用 `apps/web/wrangler.toml`（162行。**DO バインディングが1つも無い**） | 2 Worker + 2 DO クラスの構成を反映する。`pnpm dev` が唯一動く実行手段なので必須項目 | 第3.2節 |
| **改修** | `vitest.config.integration.ts` | `readD1Migrations` / `d1Databases` / `queueProducers` / `queueConsumers` を削除し、DO バインディングに置き換える。`.adr/001-integration-tests-single-workers-pool.md` が「`include` はディレクトリの明示的な許可リスト」と決めているので、新設する DO クラスのディレクトリを `include` に足す | `.adr/001-integration-tests-single-workers-pool.md` |

#### 新設対象

- `apps/web/app/durable-objects/*` — `UserDataDurableObject` / `IdentityDirectoryDurableObject` の2クラス。
- `apps/web/app/server.{request,state}.ts` に相当する2つのエントリ（第3.2節）。
- `packages/core/src/adapters/cloudflare/*` — DO 用スキーマ、同期リポジトリ実装、FTS5 projection、job / Alarm 実行部、Directory の mapping ストア、**プラットフォームエラー翻訳（第4.7節）。翻訳は2箇所に置く** — **(i) DO 内アダプター**（`SQLITE_FULL` / 条件付き UPDATE の0行一致）と、**(ii) DO stub factory が返す facade ラッパー**（`.overloaded` / `ctx.abort()` / DO のリセット。DO の中に catch 点が無いので呼び出し側で捕捉する）。(ii) は request Worker 側と state Worker 内の DO 間 RPC の両方に掛ける。**job table と Alarm の実装は2クラスで共有する**（第7.4節）。
- `packages/core/src/application/di/*` に DO 側の合成ルート（第8.3節 (c)）。
- **DO 内のテーブル群。** 第4.1.1節が全数の正本である。`account` / `user_settings` / `credential_locators` / `jobs` / `operations` / `migration_progress` / `_meta`（User Data DO）、`credential_mappings` / `password_reset_tokens` / `jobs` / `rotation_checkpoints` / `_meta`（Identity Directory DO）はいずれも現行スキーマに存在しない新設である。
- **trigram / `bm25` の再確認 spike。** 第2.1.1節の手順を着手時に1回走らせる。#37 の Issue が要求する tokenizer 実環境検証と同じ作業である。**あわせて第11.4節の表のうち「#37 / 着手時の spike」を含む行すべてを同じ着手時にまとめて走らせる。第11.4節は9行あり、9行とも #37 の着手時 spike を含む**（うち2行は #37 が根拠値を出して #38 が運用値を確定する2段の分担である）。trigram / `bm25` の再確認以外の**残り8件**は、`snippet()` / `highlight()` の可用性 / `transactionSync` のネスト可否 / Alarm・RPC の CPU リセット契機 / 単一 SQL クエリの結果セット合計サイズ上限 / チェックポイント予算の中間・内側の初期値 / `SELECT changes()` の意味論 / `transaction()` コールバックの `async` 可否 / `sql.exec()` が `Date.now()` を進めるか、である。**件数を書き換えるときは第11.4節の表を数え直す。**

**本設計が新しく導入した列が変更対象一覧に与える影響。** 下の8列はいずれも新設テーブルの列なので DDL 側の追加作業は増えないが、**テーブル定義の外に作業を1つずつ生む**。

| 列 | テーブル | テーブル定義の外に生む作業 |
|---|---|---|
| `account.callerToken` | User Data DO `account` | **request Worker の `IdGenerator` が signup phase 0 で候補 `userId` と同時に採番する**（第6.3節）。`initialize-account` RPC の引数に1つ増える。第5.2節 (c) の非露出対象に含めるので、RPC の引数・戻り値ロギングを有効化しない |
| `credential_mappings.callerToken` | Directory `credential_mappings` | 予約行（phase 1a / 1b）と link 手順2 が運ぶ。`read-own-canonical` / `delete-mapping` / `lookup-credential-by-locator` に加え、**書き側の `record-credential-locator` / `advance-credential-change` / `begin-credential-change`（起点 A）でも定数時間比較が要る**（第5.1節 (3-b)(3-d)）。鍵ローテーションの移送は行ごと引き継ぎ再採番しない（第6.8節 手順2） |
| **`credential_mappings.credentialId` / `credential_locators.credentialId` / `password_reset_tokens.credentialId`** | 3テーブル | **本設計の構造的な追加である**（第6.1.2節）。`IdGenerator` が signup phase 0 で credential ごとに、SSO link では request Worker が `operationId` と同時に採番する。**移送では再採番しない。** 影響は列の追加に留まらず、次の述語がすべてこの列に置き換わる — 到達性検査（第5.3節 step 5 (ii)）/ ログイン手段の数え上げ（第6.1.1節 (R4)）/ 削除対象の選択（同 (R3)）/ `credentialVersion` の更新範囲（同 (R8)）/ `record-credential-locator` の冪等キー（`(credentialId, generation)`）/ `encryptedCanonical` の AAD（第6.2.1節 (b-2)）/ `password_reset_tokens` の無効化索引（第6.1節 (d)）。**`(kind, hmac)` を世代非依存の同一性として使う実装は、鍵ローテーション中に自己ロックアウト・恒久ログイン不能・復号不能を同時に起こす**（第6.9節の締め出し経路一覧の後半4行） |
| `credential_locators.usableForLogin` | User Data DO `credential_locators` | **値の判定は Directory 側**で、`record-credential-locator` / `advance-credential-change` の引数で運ぶ（第6.3節 phase 4）。unlink の「最後のログイン手段」検査の述語が行数から **distinct `credentialId`** へ変わる（第6.6節・第6.1.1節 (R4)） |
| `credential_locators.label` | User Data DO `credential_locators` | 設定画面のクレデンシャル一覧に出す非 PII の表示名（`kind = 'sso'` なら provider 名、`kind = 'email'` なら空文字）。**値の判定は `usableForLogin` と同じく Directory 側**で、`record-credential-locator` の引数で運ぶ。**これが無いと利用者が unlink の対象を選べない**（第6.1.2節 (C5)）。画面仕様は #35 |
| `operations.targetLocators` | User Data DO `operations` | **配列である**。要素は `credentialId` + `kind` + 全長 HMAC + 世代 + bucket index。単一値で実装すると、ローテーション中に片側の世代の mapping が回収されずに残る（第6.1.1節 (R3)） |
| `password_reset_tokens.consumedByOperationId` | Directory `password_reset_tokens` | `consume-reset-token` が消費時に記録し、`begin-credential-change` の**起点 B（未認証）側の束縛材料**になる（第5.1節 (3-d)）。この列が無いと、リセット完了経路の `begin-credential-change` に DO 側の束縛が1つも無くなる |
| `credential_mappings.encryptionNonce` | Directory `credential_mappings` | AES-256-GCM の nonce を**独立列**に持つ。AAD に `(kind, credentialId, encryptionGeneration)` を束縛するので、暗号文への連結にしない（第4.1.1節・第6.2.1節 (b-2)）。**移送では再暗号化しない** — AAD が世代非依存なので暗号文は3列そのまま運べる（第6.8節 手順2） |

#### #36 からの引き継ぎ項目

**`.thread/36/plan.md` の引き継ぎ表 H-1〜H-8 を #37 の入力として消化する。** #37 の対応項目9 が「#36 で記録された『Cloudflare 側でカバーされない統合テスト』の引き継ぎ項目を消化する」を明示的に要求している。**本設計での扱いは次のとおりで、H-7 だけが #37 の対象外である。**

| ID | #36 が失った検証 | 本設計での後継 |
|---|---|---|
| H-1 | `createInMemoryQueueDispatcher` 4ケース | **復活不要。** 実装ごと消える（第7.3節） |
| H-2 | `createInProcessRelayTrigger` 5ケース（kick 合流、`stop()` の in-flight 待ち、stop 後の kick 無視、throw の握り潰し、tick 実行）。削除後 `RelayTrigger` ポート実装のテストがリポジトリ全体でゼロになる | **後継は Alarm の起動セマンティクスのテストである。** 第7.4節が定めた規則 —— 先頭での再武装 + `sync()`、due job ゼロでの `deleteAlarm()`、RPC 経路での `await` を挟まない `setAlarm`、`operationKey` の「早める方向にのみ更新」—— がそのまま検証項目になる |
| H-3 | worker runner の `stop()` 冪等性 | **後継は「Alarm 再実行 / DO 再起動 / 処理途中失敗」のテスト**（#37 の対応項目5）。lease の reclaim（第7.4節）がこれにあたる |
| H-4 | relay → queue → consumer の一気通貫 E2E | **境界そのものが消える**（FTS5 は同一トランザクション同期。第7.1節）。**残る外部 I/O ジョブ（`send-mail` の1件。第7.6節）については E2E を用意する** — 登録済み / 未登録 / SSO のみ / スロットル中の4ケースで処理経路が完全に一致することの検証を含める |
| H-5 | (a) libSQL の `_occ_guard` CHECK トリックの証拠、(b) UoW 経路で `_occ_guard` が空であることの検証 | **どちらも復活不要。** `_occ_guard` は第8.1節で機構ごと消える。後継は第8.4節の OCC（`UPDATE ... RETURNING 1` の0行検出）のテストである |
| H-6 | `EventDispatcher` の実装がアダプター層からゼロになる構造上の非対称 | **抽象ごと消える**（第7.3節でドメインイベントという transport を廃止する）。**「抽象」の実体は上の変更対象一覧の `domain/common/event.ts` / `domain/identity/events.ts`（削除）と `domain/identity/entity.ts`（戻り値の形の改修）である** — application 層のポート3本だけではない |
| H-7 | #26 の参照実装（libSQL `PendingBatch.addOcc`）の喪失 | **#37 の対象外。** 引き取り先は #26 である（`.thread/36/plan.md` の割り当てどおり）。ただし D1 側の `firstConflictHandler()` ごと第8.1節で消えるので、**#26 は対象消滅する可能性が高い**。#37 は自分の Issue 本文の対応項目3 に従って #26 へコメントする |
| H-8 | `pnpm start` / `pnpm preview` が起動不能 | **真因（`eventRelayWorker.ts` の module-scope `crypto.randomUUID()`）は第7.3節の削除で消えるので #40 は対象消滅する**（第11.2節末尾）。**ただし `.tpl` の `main` が TS ソースを指す問題は別で、`.thread/36/adr.md` が「redirect 設定が無い経路のために依然必要」と明記しているとおり #37 の対応項目8 で直す**（上の `render-wrangler.ts` の行） |


#### UoW 契約の新旧対比

**#37 は Issue 本文の対応項目3 の「`UnitOfWorkProvider.run(fn)` の契約（`CLAUDE.md` の Key concepts）は**維持したまま**、実装を DO storage の transaction へ差し替える」を、「**契約ごと差し替える（第8.2節の新契約）**」へ訂正してから着手する。** 第8.2節は `run` を**完全同期**へ変え（`async` コールバックを型で拒否する）、`collectEvents` を廃止し、`enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor` を新設するので、契約は維持されない。`CLAUDE.md` の Key concepts の当該項を書き換えるのは #35 である（第11.1節）。**下の対比表を読めば分かるが、Issue 本文だけを読んだ担当者は「契約は変えない」という前提で着手しうる。** 同じ形式の訂正指示は第9.1節（`new_sqlite_classes`）と第11.1節（#35 の受け入れ条件3）にも置いてある。

| 項目 | 現行（D1） | 新（DO） |
|---|---|---|
| `run` の署名 | `run<T>(fn: (ctx) => Promise<T>): Promise<T>` | `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T`（完全同期） |
| スコープ引数 | 無い（構造上渡す口が無い） | 無い（DO インスタンスがスコープ。第4.5節） |
| トランザクション実体 | deferred batch（`PendingBatch` → `db.batch()`） | `ctx.storage.transactionSync()` |
| read-your-write | **不可**（`adapters/d1/unitOfWork.ts:39` の JSDoc に "unsupported by design"） | **可** |
| ドメインポートの戻り値 | `Promise<...>` | 同期（第8.2.1節） |
| イベント登録 | `ctx.collectEvents(drafts)` → outbox 行 | **`ctx.enqueueJob(...)` → `jobs` 行**（第8.2節）。ドメインイベントという transport は廃止するが（第7.3節）、「トランザクション内の唯一の副作用登録点」というスロットの後継はこれである |
| 冪等キーの記録 | `idempotencyStore`（別ポート） | `ctx.recordOperation(...)` → `operations` 行（第6.5節・第8.2節） |
| OCC | `_occ_guard` の CHECK 違反 + `OCC_GUARD_CHECK_NAME` の部分一致 | 条件付き UPDATE の0行検出。判定は `UPDATE ... WHERE id = ? AND version = ? RETURNING 1` が返した行の有無で行う（第8.4節。`SELECT changes()` は spike 待ちの第二候補、`rowsWritten` は不採用） |
| UNIQUE 違反の翻訳点 | ユースケース層の `catch`（漏れている） | アダプター（第8.5節） |
| 非同期処理 | Outbox + relay + Queue consumer + DLQ | job table + 単一 Alarm（第7.4節）。契約の正文は第7.7節 |

#### 既存 D1 データのカットオーバー方針

**移行しない。DO 側で作り直す。** 実装済みドメインは `identity/User` だけで、本番稼働しているサービスが無いためである。移行ツールを作らない。`infra/cloudflare/pulumi/resources/index.ts` の D1 リソースには destroy 保護がかかっているので、削除の際は保護の解除手順が要る（#38 の運用手順に含める）。

**残存課題の扱い。** `.thread/1/progress.md` の残存課題5（D1 データベース名が `tanstack-start-template-d1` のまま / 実装の `outbox_events` と spec 表記 `outbox` の乖離）は **D1 / Outbox の廃止に伴い対象消滅する**。DO の binding 名 / namespace 名の命名として読み替える。

**#40 の扱い。** `pnpm start` / `pnpm preview` の起動不能は `packages/core/src/application/workers/eventRelayWorker.ts` のモジュールスコープ `crypto.randomUUID()` が原因である。同ファイルは第7.3節で削除されるので、**#40 は対象消滅する**。

### 11.3 #38 への引き継ぎ — 運用ドキュメント化が必要な事項 ［参考］

- **PITR の手順** — ローカル workerd では使えないので staging での実施手順。復旧単位が DO 1個であることの設計上の帰結は第10.1節で決着済みなので、ここへ送るのは手順（対象 bookmark、実施日時、User Data DO と Directory bucket の照合、後片付けの記録）だけである。**restore 直後の必須ステップを、restore した DO のクラス別に書く**（第10.1節）。**User Data DO を戻した場合は2つ** — **(i) `sessionEpoch` を現在時刻由来の十分大きな単調値へ強制的に進める、(ii) その User Data DO の `ai_client_connections` を全件 `revoked` にして利用者に再接続させる**（AI クライアントトークンは Directory を1度も参照しないので、第10.1節の3点では塞げない独立した穴である）。**Identity Directory bucket を戻した場合も2つ** — **(iii) その bucket の `password_reset_tokens` を全行削除する**（消費済み・未消費を問わない。復活した消費済みトークンは `consume-reset-token` → `begin-credential-change` → phase 2/3 の経路を**前進させて**攻撃者のパスワードを昇格させうる。認可が開く向きに倒れる唯一の PITR 経路である）、**(iv) `failedAttempts` を0・`nextAttemptAllowedAt` を過去へ戻す**（締め出し方向へ倒さないため）。**(iii)(iv) は「復旧できないなら全部切る」型の既定手順であり、実行の可否を運用者に判断させない。****対象 DO の特定手段（Identity Directory bucket の全走査で `credential_mappings.userId` を集める）**を手順の第1項に置く — Worker から namespace を列挙する API が無いので、これが唯一の経路である（第9.5節・第2.1節 F-5）。あわせて「**PITR は個別救済の最後の手段であり、全ユーザー規模の巻き戻しには使わない**」を運用の原則として書く（第9.5節）。
- **export と退会削除の運用** — 退会のチェックポイント分割（第6.7節）が長時間かかる場合の進捗確認手段。**export の読み出し上限の運用値の確定**（#37 が spike で出した根拠値を入力にする。第4.8節）。逆引き情報ごと失われた場合の operator 経路（256 bucket 走査による mapping 削除。第6.7節）。
- **容量監視** — 「本体 + FTS インデックスの合計で 10 GB」の監視閾値、逼迫時の利用者向け導線（第4.6節）。
- **コスト** — rows written の内訳（trigram の増幅、`setAlarm`）（第10.2節）。
- **鍵ローテーションの運用手順** — keyring の世代管理（`{ generation, key, bucketCount }`）、maintenance 経路の実行、旧鍵破棄の判定（第5.2.3節・第6.8節）。**ローテーション開始を告知し、直後のリセット依頼失敗を想定する**（第6.1節 (d)）。**maintenance 経路のログ・トレースを平文が残らない構成にする**（第6.2.1節 (c)・第6.8節）。
- **未認証経路のレート制限** — Cloudflare WAF / Rate Limiting Rules を login / signup / password reset に当てる際のキー・閾値・窓・チャレンジの出し方と、`failedAttempts` のバックオフ係数・リセット依頼間隔の具体値（第6.2.2節）。
- **メールアドレスの所有確認が signup に存在しないことの運用上の帰結** — 所有の唯一の証明はパスワードリセット経路であり、**リセットトークンの安全性がアカウント所有の安全性の上限になる**（第5.2.1節 (a)）。侵害対応の手順と利用者向け説明をこの前提の上で書く。所有確認 phase を新設するかは別 Issue の判断である。
- **メール local 部の lowercase 化による誤配送の残余リスク** — 本設計は local 部を lowercase に畳む（第5.2.1節 (a)）。RFC 5321 上 local 部は大文字小文字を区別しうるので、**区別するプロバイダの利用者に対してはリセットメールが別のメールボックスへ届きうる**（`Foo@example.com` → `foo@example.com`）。これは NFKC を local 部に掛けない論拠（オクテット単位の不透明性 / 打鍵形の復元不能 / 所有確認が無いための乗っ取り経路）が形式的にはそのまま当てはまる箇所で、**「区別しない側に揃っている実運用の実態」を根拠に受容した判断である**（現行実装 `valueObject.ts:47` の `trim().toLowerCase()` と同じ妥協）。#38 は (i) 侵害対応の手順にこの経路を明記し、(ii) 利用者からの「リセットメールが届かない」申告の切り分けに含める。**設計を変える判断（打鍵形の別列保持）は第5.2.1節で棄却済みなので、#38 は再検討しない。**
- **`purge-user-mappings`（operator 専用）の監査要件** — 第5.1節の RPC エントリ表で**最も危険なエントリ**であり、逆引き情報ごと失われた場合の最後の砦なので**原理的に `callerToken` で束縛できない**（第5.1節 (3-c)・第6.7節）。任意の `userId` を受けて自 bucket 内の全 mapping 行を破壊的に削除できる。**守りは maintenance 経路の到達制御と実行監査だけである。** #38 は次を運用手順として書く — (i) **実行前の承認手続き**（誰が承認したかを含む）、(ii) **誰が・いつ・どの `userId` に対して実行したかの記録を必須にする**、(iii) 256 bucket の走査手順そのもの、(iv) 残余リスク（request Worker 内でのコード実行を得た攻撃者が任意アカウントを恒久ロックアウトできる）を明記したうえでの検知方法。**監査ログを「あればよい」ではなく「無ければ実行しない」と書く。**
- **リセット完了後の利用者向け導線と説明** — クレデンシャル一覧と AI クライアント接続一覧（「すべて失効」つき）を提示する画面は #35 が仕様化するが、**「パスワードを変えても AI クライアント接続は有効のままである」「リセット完了で自動失効するのは直近世代の接続だけである」**の説明は #38 の運用ドキュメントと利用者向け文言に書く（第5.4節）。
- **予約 TTL の具体値** — 「saga の再開間隔 × 再試行上限 + マージン」より長く取るという不等式は設計側で固定済みなので、値だけを決める（第6.4節）。到達不能アカウントの終端（poison + エスカレーション）の運用受け口も含む。
- **retention を Alarm 化した後の「手動での期限到達再現手段」** — `spec/manual-tests/trash.md` の pruner 手動起動口に対応する運用手段（Alarm の強制発火 / 時計の巻き戻しに相当するもの）。**共有 DB への直接 SQL 更新に依存していた `spec/manual-tests/{timeline,settings}.md` の準備手順の代替**（DO 単位のシード投入、または開発用の RPC）も同じ枠で決める。`spec/manual-tests/{search,document}.md` の consumer 起動口は consumer ごと消えるので対応不要である。
- **fail-closed で止まっている DO の検知** — `_meta.schema_version` がコードより新しい DO をメトリクスで拾う（第9.4節）。
- **チェックポイント予算の見直し契機** — エビクション由来の進捗停止をどう検知するか（第7.4節の3階層の件数予算「ジョブ25件 / 20チャンク / 1,000行」の初期値を見直す入力）。**`jobs` の `done` / `poison` の保持期間と、`send-mail` の空振り行に割り当てる最短の保持期間**も同じ枠で決める（第7.4節）。
- **D1 / Queue リソースの destroy 保護の解除手順**（第11.2節）。

### 11.4 未決事項 ［派生］

本 Issue で結論を出さなかったのは下表の9件だけである。いずれも**誰がいつ決めるかを割り当ててある**。**種類は3つに分かれる** — (i) 未確認の事実で、設計がそれに依存しないよう組んであるもの、(ii) 結論は出ているが依拠する事実が実測1件なので再確認が要るもの（`.adr/003-sqlite-fts5-only-search.md` が「再確認が覆れば本決定そのものが成立しない」と明示している）、(iii) 決定は済んでいて値だけが2段階で決まるもの。**「本設計への影響」欄でどれかが分かる。**

| 論点 | 決める主体 | いつ | 本設計への影響 |
|---|---|---|---|
| SQL 関数の `snippet()` / `highlight()` が workerd で使えるか（第2.1節 F-13） | #37 | 着手時の spike | **無い。** 設計は原文からスニペットを組む方式を採っており、これらに依存していない（第7.2節） |
| `transactionSync` のネスト可否（第2.1節 F-14） | #37 | 着手時の spike | **無い。** ネストしない規約を置いて構造で担保している（第8.2節） |
| Alarm 起動 / Workers RPC 呼び出しが CPU 予算リセットの契機に含まれるか（第2.1節 F-4b） | #37 | 着手時の spike | **無い。** 「含まれない」と保守的に読んで固定値のチェックポイント予算（第7.4節）を置いているので、推論が外れても安全側に倒れる。含まれることが確認できたら予算を緩められるという上振れだけがある。**spike の出発点は limits ページ FAQ の「maximum CPU time per Durable Objects invocation (HTTP request, WebSocket message, or Alarm) is set to 30 seconds」である** — Alarm が invocation として名指しされている以上、問いは「Alarm ごとに30秒が与えられるのか、着信間で共有される枠を消費するだけなのか」の一段細かい形になる |
| 単一 SQL クエリの結果セット合計サイズ上限（第2.1節 F-26） | #37（根拠値）→ #38（運用値） | #37 は着手時の spike、#38 は運用ドキュメント作成時 | export の読み出し上限値の決定に使う（第4.8節）。**上限を設けること自体は決着済みで、値だけが2段階で決まる** |
| **trigram トークナイザと `bm25()` が workerd で動くことの再確認**（第2.1節 F-11 / F-12。公式ドキュメントに一語も無く、根拠は先行ブランチの実測1件だけである） | #37 | 着手時の spike（手順は第2.1.1節。#37 の Issue が要求する tokenizer 実環境検証と同じ作業なので工数を足さない） | **未決事項ではなく再確認である。ただし覆れば `.adr/003-sqlite-fts5-only-search.md` の決定そのものが成立しない**（同 ADR の「影響」節が明示）。その場合は第7.2節・第7.2.1節を含めて検索方式そのものを別 Issue で立て直すことになる |
| **チェックポイント予算の中間（チャンク反復回数上限）と内側（1チャンクの行数上限）の初期値**（第7.4節） | #37（根拠値）→ #38（運用値） | #37 は着手時の spike、#38 は運用ドキュメント作成時 | **上限を置くこと自体と3階層であることは決着済みで、値だけが2段階で決まる**（出発点は 20チャンク / 1,000行） |
| **`sql.exec("SELECT changes()")` が直前の条件付き UPDATE のマッチ行数を返すか**（第8.4節） | #37 | 着手時の spike | **無い。** 第一候補を `UPDATE ... RETURNING 1` にしてあり、`changes()` は第二候補として置いているだけである。spike が通れば選択肢が1つ増えるという上振れだけがある。**`rowsWritten` へは戻らない**（課金単位でマッチ行数ではないため） |
| **`transaction()` のコールバックを `async` にできるか**（第2.1節 F-27b） | #37 | 着手時の spike | **無い。** できてもできなくても (c) は棄却される。できないことが確認できれば棄却がより強くなるだけである（第8.2.1節） |
| **`ctx.storage.sql.exec()` が `Date.now()` を進める I/O に当たるか**（第2.1節 F-32b） | #37 | 着手時の spike | **無い。** 経過時間を打ち切り条件から外し、3階層とも件数で有界にしたため（第7.4節）。進むことが確認できても打ち切り条件へは戻さない — 凍結時計に依存しない設計のほうが検証しやすいからである |

検索 API の仕様（第7.2.1節）は未決事項ではなく、#35 への明示的な委譲である。
