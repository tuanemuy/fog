# 設計 — Issue #34: Cloudflare Workers + ユーザー単位 Durable Objects の境界・ルーティング設計

**Issue:** #34
**作成日:** 2026-07-29
**対象読者:** #35（spec 改訂）/ #37（D1 → DO 実装）/ #38（運用ドキュメント）の担当者

---

## 1. この文書の位置づけ ［派生］

### 1.1 読者と入力・出力 ［派生］

本書は Issue #34 の設計成果物である。決定そのものは `.adr/002-cloudflare-workers-and-user-data-durable-objects.md` / `.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md` の3件に置き、**実装可能な粒度の設計は全部ここにある**。

- **#35 は第11.1節だけを開けば着手できる。** 改訂対象の spec ファイルと改訂内容が一覧になっている。
- **#37 は第4〜9章と第11.2節を読めば着手できる。** DO の保持データ、ルーティング、非同期処理、UoW 契約、migration、削除・新設モジュールが揃っている。
- **#38 は第10章と第11.3節。** 運用手順の対象が列挙してある。

本書は先行ブランチ `issue/19/cloudflare-do-fts` や `.thread/1/adr.md`（1662行の作業ログ）を開かなくても読めるように書いてある。それらへの言及はすべて「出自の注記」であり、内容の代替ではない。

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
| 外部 I/O と retention だけを永続 job table に記録し、単一の DO Alarm で処理する（operation key / payload digest / attempt / `nextRunAt` / lease / owner token / provider 冪等キー / poison、25件・10秒の budget、最早時刻への再設定、現在時刻+1秒への clamp） | **採用** | 本書第7.4節。ただし bounded 処理の判定基準を wall time ではなく CPU 予算に置き換え、チェックポイント単位で切る形にした（第2.1節の「リセット」意味論） |
| Identity Directory を秘密鍵付き決定的キーで固定分割し、DO 間操作を再開可能 saga + 冪等補償にする | **採用** | 本書第6.2〜6.5節・第6.9節 |
| Account Home DO を identity saga と session のオンライン権威として独立させる（3クラス構成） | **棄却** | 本書第3.1節。権威を `userId` で引ける場所に置く必要があるが、それは User Data DO そのものである。独立させると protected request ごとに RPC が1本増える一方、User Data DO に置けばそのリクエストが元々叩く相手なので追加コストがゼロになる |
| 新規 DO namespace を宣言的 `exports` で管理する | **採用** | 本書第9.1節 |
| RPC は primitive DTO と `{ ok: true, value } \| { ok: false, error: SerializedError }` だけを返し、リポジトリ・クロージャ・transaction capability・カスタムエラー実体を境界外へ出さない | **採用** | 本書第8.3節 (d) |
| PITR は staging 手動 smoke で検証し、local は wrapper contract まで。Account Home は restore 対象外とする operator policy | **部分採用** | 検証境界は本書第10.1節・第11.3節で採る。「Account Home を restore 対象外にする」は Account Home ごと棄却したので消える。代わりに「Directory mapping が到達性のゲートであり、User Data DO の restore に追随しない」を第10.1節の結論にした |
| #19 のレビュー指摘 B-IDDS6-001「Directory の page 走査だけでは旧世代 locator の0件を証明できない」（Account Home の reverse locator が集計から漏れる / 同一ユーザーの複数 locator を重複加算する / checkpoint が加算更新で snapshot 置換になっていない） | **採用** | 本書第6.8節。3つの穴のうち1つ目は Account Home の廃止で構造的に消え、残り2つは「bucket ごとの snapshot 置換」で塞ぐ |
| #19 固有の検証手段（最小 DO command harness、#19 のスコープ限定） | **棄却** | #19 のクローズに伴い対象消滅。#37 は本番ユースケースを直接実装する |

**未コミットで作業ツリーに残っている `apps/web/wrangler.{request,state}.{staging,production}.toml` の4本は先行ブランチの残骸である。** 参照先の `apps/web/app/server.state.ts` が現ブランチに存在しないため、そのままでは動かない。本 Issue では commit も削除もしない。#37 は「既にあるから使える」と誤認せず、第3.2節の結論に従って `.tpl` レンダリング経路で作り直す（第11.2節）。

---

## 2. 前提と制約 ［派生］

### 2.1 Cloudflare SQLite-backed DO のプラットフォーム制約 ［派生］

**本節が設計の依拠する事実の正本である。** 各行に出典と裏付けの種別（**公式記載** / **実測** / **未確認**）を付けた。種別を取り違えると #35 / #37 が公式保証だと誤認するので、区別は落とさない。

| # | 事実 | 種別 | 出典 | 効き先 |
|---|---|---|---|---|
| 1 | ストレージは1 DO あたり 10 GB。アカウント合計は Workers Paid 無制限 / Free 5 GB。上限到達時は書き込みが `SQLITE_FULL` で失敗し、`SELECT` などの読みと `DELETE` は成功し続ける | 公式記載 | `/durable-objects/platform/limits/` | 4.6 / 4.7 |
| 2 | Alarm は1 DO につき同時1本。`setAlarm` は既存を上書きする。at-least-once で、`alarm()` が throw すると初回2秒からの指数バックオフで最大6回リトライされる | 公式記載 | `/durable-objects/api/alarms/` | 7.4 / 7.5 |
| 3 | Alarm ハンドラの wall time は15分。**出典は alarms ページではなく limits ページの "Wall time limits by invocation type" 表**（alarms ページは duration / wall time を一切述べていない） | 公式記載 | `/durable-objects/platform/limits/` | 7.4 / 9.2 |
| 4 | CPU はリクエストあたり既定30秒・設定で最大5分の active CPU（wall time とは別枠）。**着信 HTTP リクエスト / WebSocket メッセージごとに残り CPU 時間が30秒へリセットされる**。着信ネットワークリクエストの間に30秒を超える計算をすると、**その DO がエビクトされリセットされる可能性が高まる** | 公式記載 | `/durable-objects/platform/limits/` | 4.8 / 7.4 / 9.2 |
| 5 | Worker から DO namespace の ID / 名前を列挙する API は存在しない。REST の List Objects が返すのは16進の object ID と `hasStoredData` だけである。**ただしこれを明示的に否定する公式の一文は無く、namespace binding の API 一覧（`idFromName` / `idFromString` / `newUniqueId` / `get`）に列挙手段が載っていないことによる**。`listDurableObjectIds()` は `@cloudflare/vitest-pool-workers` のテスト専用ユーティリティ | 公式記載（列挙 API の不在は記載の不在による） | `/api/resources/durable_objects/.../objects/methods/list/` | 6.2 / 6.8 |
| 6 | DO の内側から `ctx.id.name` で自分の名前を読める。`idFromName()` / `getByName()` 経由でのみ定義され、`newUniqueId()` 由来・`idFromString()` 経由では `undefined`。1,024 バイトを超える名前は `ctx.id` に渡らない。2026-03-15 より前に作られた Alarm では `undefined` になる | 公式記載 | `/durable-objects/api/id/` | 5.2 / 6.3 / 7.4 |
| 7 | `ctx.storage.transactionSync()` のコールバックは完全同期でなければならない（`async` 宣言も Promise 返却も不可） | 公式記載 | `/durable-objects/api/sql-storage/` | 8.2 |
| 8 | `sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` といったトランザクション関連文を実行できない | 公式記載 | `/durable-objects/api/sql-storage/` | 8.2 / 9.3 |
| 9 | SQL カーソルは `await` を跨いで保持できるが、その場合スナップショットの安定性は保証されない（カーソル作成後に挿入・更新・削除された行を観測しうる） | 公式記載 | `/durable-objects/api/sql-storage/` | 8.2 |
| 10 | SQLite 拡張として公式に明記されているのは **FTS5 モジュール本体（`fts5vocab` を含む）**・JSON 拡張・数学関数の3つだけ。`bm25` / `snippet` / `highlight` / トークナイザ（trigram）は**同ページに一語も現れない**。「仮想テーブルは原則禁止だが FTS5 のみ例外」という記述も存在しない | 公式記載 | `/durable-objects/api/sqlite-storage-api/` | 7.1 / 7.2 |
| 11 | trigram トークナイザ（`tokenize='trigram'`）は workerd 上で動作する | **実測** | `.thread/19/spike/fts5.integration.test.ts` ほか先行ブランチの統合テスト（要旨は第7.2節） | 7.2 |
| 12 | `bm25()` は workerd 上で動作する | **実測** | 先行ブランチの検索アダプターが `bm25(search_fts, 3.0, 1.0)` を使い、workerd 統合テストが通っている | 7.2 |
| 13 | SQL 関数の `snippet()` / `highlight()` が workerd で使えるか | **未確認: `snippet()` / `highlight()` の可用性 — #37 の着手時に spike で確定する。** 先行実装は SQL の `snippet()` を使わず TypeScript 側で原文からスニペットを組み立てているため、実測が存在しない | — | 7.2（設計はこれに依存しない） |
| 14 | `transactionSync` のネスト可否 | **未確認: `transactionSync` のネスト可否 — #37 の着手時に spike で確定する。** 公式に記載が無い。ただし #8 により `SAVEPOINT` による回避路は最初から無い | — | 8.2 |
| 15 | 仮想テーブルへの書き込みも rows written に算入される | 公式記載 | `/durable-objects/api/sqlite-storage-api/` | 4.6 / 7.1 |
| 16 | LIKE / GLOB パターンは 50 バイト上限 | 公式記載 | `/durable-objects/platform/limits/` | 7.2 |
| 17 | 1テーブル100列 / 行 2 MB / SQL 文 100 KB / bind パラメータ100 | 公式記載 | `/durable-objects/platform/limits/` | 4.4 |
| 18 | DO は single-threaded なグローバル一意インスタンス。input gate は同期 JS 実行中の新規イベントを止め、output gate は保留中の書き込みが完了するまで送信を止める。`fetch()` などの非ストレージ I/O を `await` すると input gate が開き、他のリクエストが割り込む | 公式記載 | `/durable-objects/best-practices/rules-of-durable-objects/`、`/durable-objects/api/state/` | 8.2 / 8.4 |
| 19 | 1オブジェクトの soft limit は 1,000 requests/second。超過すると `overloaded` になる。`.overloaded` が真のエラーは**リトライしてはならない**（リトライは過負荷を悪化させエラー率を上げる） | 公式記載 | `/durable-objects/platform/limits/`、`/durable-objects/best-practices/error-handling/` | 4.7 / 6.2 |
| 20 | PITR は SQLite-backed DO 限定で過去30日。復旧単位は object 1個で、SQL データと KV `put()` データを含む DB 全体が対象。**ローカル開発では利用できない**（変更の durable log がローカルに保存されないため）。`ctx.abort()` も `wrangler dev` では利用できない | 公式記載 | `/durable-objects/api/sqlite-storage-api/`、`/durable-objects/api/state/` | 10.1 |
| 21 | 宣言的 `exports`（2026-06-30 の changelog）は `[[migrations]]` 配列と排他で、両方を含む設定は検証で拒否される。`exports` で作る namespace は常に SQLite backend。ストレージ種別は namespace 生成後は不変。`exports` 経由で削除した namespace に Trash は無く、tombstone をデプロイする前にデータを退避する必要がある | 公式記載 | `/durable-objects/reference/durable-objects-migrations/` | 9.1 |
| 22 | `waitUntil` は Durable Objects の中では効果がない（DO の寿命もリクエスト / RPC の完了時点も変えない） | 公式記載 | `/durable-objects/api/state/` | 7.3 / 7.4 |
| 23 | `blockConcurrencyWhile()` はコールバックに30秒のタイムアウトがあり、超過すると DO がリセットされる。実行中は他のイベント配信をすべてブロックする | 公式記載 | `/durable-objects/api/state/` | 9.2 |
| 24 | DO は Workers Free / Workers Paid の両方で使える（Free は SQLite backend のみ）。`setAlarm()` 1回は1行の書き込みとして課金される | 公式記載 | `/durable-objects/platform/pricing/` | 4.6 / 7.4 |
| 25 | ダッシュボードの Metrics タブは「an individual Durable Object's ID or name」で絞り込める（2026-06-12 の changelog） | 公式記載 | `/changelog/post/2026-06-12-durable-objects-metrics-filter-by-id-name/` | 5.2 |
| 26 | 1クエリの結果セット合計サイズ上限 | **未確認: 単一 SQL クエリの結果セット合計サイズ上限 — limits ページに該当項目が無い。#37 の着手時に spike で確定する** | — | 4.8（export の読み出し上限） |

Free プランの「1オブジェクトあたり」上限が表と FAQ で食い違うという懸念は解消した — 10 GB は「Storage per Durable Object」として両プラン共通に1度だけ書かれており、Free の 5 GB は「Storage per account」の値である。矛盾は無い。

### 2.2 fog のデータ特性 ［派生］

**共有・共同編集・テナント横断検索・管理者機能は無い、を設計前提として固定する。** 根拠はページ定義が P-01〜P-14 の利用者向けだけで、管理者向け画面・統計の定義が `spec/pages/index.md` に存在しないこと。「集計」「全ユーザー」という語は `spec/domains/trash.md` / `spec/database/index.md` / `spec/domains/identity.md` にヒットするが、いずれも管理者機能ではなく retention の横断ジョブ由来である（第4.3節のカテゴリ D）。

したがって「1ユーザー = 1 DO」と矛盾する機能要件は存在しない。export の読み出しも `ExportSourceReader.readAll(userId)` 1本でユーザー内に閉じ、`spec/domains/export.md` が要求する「単一トランザクション（またはスナップショット読み）」は DO ではむしろ自然に満たせる。

### 2.3 現行実装の到達点 ［派生］

実装済みのドメインは `packages/core/src/domain/identity/` だけで、エンティティは `User` 1つである。memo / knowledge / search / trash / export はディレクトリごと存在しない。したがって #37 が書き換える既存コードの量は小さい。

**ただしゼロではない。** 次は実装済みで、DO 境界の再設計で書き換わる。

- **SSO** — ユースケースとルートだけが無い。値オブジェクト（`packages/core/src/domain/identity/valueObject.ts` の `SsoProvider`）、エンティティ（同 `entity.ts` の `SsoUser`）、スキーマ（`packages/core/src/adapters/d1/migrations/0000_initial.sql` の `sso_provider` / `sso_provider_subject` 列と `users_sso_identity_uq` 部分ユニーク）、リポジトリ、`packages/core/src/application/identity/`、`apps/web/app/components/settings/` まで実装済み。**第6.1節・第6.6節は「これから設計する」ではなく「既存実装をどう移すか」として書いてある。**
- **`Actor` 判別共用体** — `packages/core/src/domain/identity/valueObject.ts` の `Actor = UserActor | AiClientActor`。memo / knowledge のリビジョンが全部これを持つ。
- **`AiClientConnection`** — 値オブジェクトだけが実装済み。エンティティ・リポジトリ・テーブルは無い。
- **パスワードリセット / MCP・REST OAuth / `TokenScope`** — 実装が1行も無い。`apps/web/app/routes/password-reset.tsx` はプレースホルダー画面。

---

## 3. DO トポロジー ［Issue 要求］

### 3.1 クラス構成と責務分界 ［Issue 要求］

**2クラス構成を採る。Account Home DO は採用しない。**

| クラス | locator | 責務 |
|---|---|---|
| **User Data DO** | `userId` 由来（鍵に依存しない） | 利用者のドメインデータ全部（第4.1節）、ユーザー単位設定、認証権威（アカウント状態 / `sessionEpoch`）、signup saga のコーディネーター状態、retention の Alarm |
| **Identity Directory DO**（bucket 単位） | canonical credential の HMAC 由来（世代付き） | 正規化メール / SSO 主体 → `userId` の写像とその一意性、パスワード検証材料の保持、パスワードリセットトークン、メール送信ジョブ |

**Account Home を採らない理由。** 先行案が Account Home を独立させた動機は「Directory mapping だけでは signup の部分失敗・退会処理中・PITR で戻った古い mapping・credential 変更後の古いセッションを区別できない」であり、これは正しい。しかしその区別に必要な権威（アカウント状態・単調増加 epoch・saga の phase）は**すべて `userId` で引ける**。`userId` で引ける DO は既に User Data DO として存在する。独立クラスにすると次の対価を払う。

1. **protected request ごとに RPC が1本増える。** epoch 照合のためだけに Account Home を叩くことになる。権威を User Data DO に置けば、そのリクエストが元々データ取得で叩く相手なので照合コストは実質ゼロになる。
2. **DO クラスが1つ増え、saga の phase も増える。** signup は「Directory 予約 → User Data 初期化 → mapping 有効化 → Account Home 有効化」の4 phase から、「User Data に operation 記録 → Directory 予約 → User Data 初期化・active 化 → mapping 有効化」の4 phase になるが、後者は跨ぐ DO が2つで、補償の相手も1つに減る。
3. **鍵ローテーションの retirement 証明が難しくなる。** Account Home 側の reverse locator は Directory に active row を持たない場合があり、Directory 走査だけでは旧世代0件を証明できない（#19 のレビュー指摘 B-IDDS6-001）。2クラスなら reverse locator は User Data DO の側に1系統だけ存在し、Directory 側の bucket 走査が権威になる（第6.8節）。

**Account Home を採らないことで失うもの**は「Directory と User Data の両方が壊れたときに参照できる第3の非 PII 記録」だけである。退会 tombstone は User Data DO 側に非 PII のまま残す（第6.7節）ので、その役割は User Data DO が引き受ける。

**セッション方式の扱い（`.thread/1/adr.md` ADR-002 の去就）。** `sessionEpoch` の照合を導入するので「サーバー側失効の手段が無い」というトレードオフは解消する。しかしセッション方式そのもの（`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` のステートレス HMAC + TTL 7日）は**変えない**。トークンの真正性検証は従来どおり DB を触らずに完結し、epoch 照合は「データを取りに行く先で追加のガードを1つ通す」形の**認可**であって、トークン検証の方式変更ではない。したがって **`.thread/1/adr.md` ADR-002 を supersede する別 ADR は起こさない。** この判断は本 Issue で下し、結果を第5.1節に書いた。

### 3.2 Worker 分割（request Worker / state Worker） ［派生］

**分ける。** request Worker（`fetch` ハンドラ・TanStack Start のサーバー実行）と state Worker（DO class を export する script）を別 script にする。

理由は**秘密の配布境界を非重複にできる**ことに尽きる。

| Worker | 持つ秘密 | 理由 |
|---|---|---|
| request Worker | `SESSION_SECRET`、`DIRECTORY_ROUTING_SECRET` の世代付き keyring | セッションの署名・検証と、canonical credential から Directory locator を導出する HMAC はここでしか行わない。DO 側にこの2つを置かない |
| state Worker | `IDENTITY_MAIL_ENCRYPTION_KEY`、メール送信プロバイダのバインディング | canonical credential の暗号化保持と、Directory bucket の Alarm が回すメール送信ジョブ（第7.6節）に必要。逆にセッション鍵と routing secret は置かない |

デプロイ順序は **state を先、request を後**。DO class の追加・変更が先に反映されていないと request 側の binding が解決できないため。片側デプロイ・ロールバックの互換ウィンドウは最低1リリース分を確保する（RPC の値エンベロープに version を持たせる。第8.3節 (d)）。

**DO 設定は `apps/web/scripts/render-wrangler.ts` の `.tpl` レンダリング経路に乗せる。** `.gitignore` が `wrangler.staging.toml` / `wrangler.production.toml` を「`.tpl` からレンダーされる生成物」として ignore しているので、先行ブランチの手書き4本（`apps/web/wrangler.{request,state}.{staging,production}.toml`）をそのまま持ち込むと ignore 対象でないファイルが commit され二重管理になる。Worker が2本になるのに合わせて `.tpl` を2系統にし、`render-wrangler.ts` を2出力へ拡張する（実作業は #37）。ローカル開発用の `apps/web/wrangler.toml`（162行。DO バインディングが1つも無い）にも同じ2構成を反映する。

### 3.3 binding 構成の概念図 ［参考］

```
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
        │ - job / Alarm      │   │ - reset token             │
        │ - account status   │   │ - job / Alarm             │
        └────────────────────┘   └──────────┬───────────────┘
                                            │ MAIL_PROVIDER
                                            ▼  (IDENTITY_MAIL_ENCRYPTION_KEY)
                                     外部メール送信
```

実際の toml は #37 が書く。

---

## 4. User Data DO ［Issue 要求］

### 4.1 保持データ範囲 — Issue 列挙7項目の対応表 ［Issue 要求］

Issue が列挙した7項目はすべて同一 SQLite（1つの User Data DO）に載る。既存ドメイン集約との対応は次のとおり。

| # | Issue の項目 | 対応する既存ドメイン集約 | DO 内のテーブル群 |
|---|---|---|---|
| 1 | User のユーザー単位設定 | `packages/core/src/domain/identity/` の `User`（`trashRetentionDays` などの設定側） | `user_settings`（単一行）、`account`（状態 / `sessionEpoch` / 非 PII tombstone） |
| 2 | AI client connections | identity の `AiClientConnection`（値オブジェクトのみ実装済み） | `ai_client_connections` |
| 3 | memos / memo revisions | memo ドメインの `Memo` / `MemoRevision`（未実装） | `memos` / `memo_revisions` |
| 4 | topics / documents / document revisions / source links | knowledge ドメインの `Topic` / `Document` / `DocumentRevision` / `SourceLink`（未実装） | `topics` / `documents` / `document_revisions` / `source_links` |
| 5 | trash・retention に必要な状態 | trash ドメイン（エンティティを持たず、memo / knowledge の状態と `RetentionPolicy` で表現。未実装） | `memos` / `topics` / `documents` の trashed 列 + `trash_schedule`（次の期限） |
| 6 | FTS5 検索インデックス | search ドメイン（`SearchIndexPort` の派生データ。集約ではない） | `search_entries` + `search_fts`（external-content FTS5） |
| 7 | 必要な冪等化・非同期処理状態 | application 層（現行の `processed_events` / `outbox` に相当。DO では job table へ集約） | `jobs`、`operations`（saga / RPC 冪等キー）、`_meta`（`schema_version`） |

export ドメインはテーブルを持たない（`ExportSourceReader.readAll` が上記から読むだけ）。

### 4.2 ドメイン集約との対応表 ［Issue 要求］

| 集約 / 概念 | 帰属 | 備考 |
|---|---|---|
| `Memo` / `MemoRevision` | User Data DO | 書き込みは同一 `transactionSync` で FTS5 も更新する |
| `Topic` / `Document` / `DocumentRevision` / `SourceLink` | User Data DO | 同上。`source_links` は複合 PK のまま |
| `AiClientConnection` | User Data DO | 失効の権威。トークンは `userId` を自己完結で持つ（第5.4節） |
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

| # | カテゴリ | 箇所 | 台帳 ID / 出典 | 行き先 |
|---|---|---|---|---|
| 1 | A. 引き方の経路に `user_id` を持たないスキーマ制約・索引 | `users_email_uq`（メールの一意性） | `ADP-users-001` | **Directory の関心事**。bucket 内の credential 行が唯一の権威になる（第6.1節 (c)） |
| 2 | | `users_sso_identity_uq`（SSO provider + subject の部分ユニーク） | `ADP-users-001` | **Directory の関心事**。実装済みなので「設計する」ではなく「移す」 |
| 3 | | `password_reset_tokens.token_hash` のグローバル UNIQUE | `ADP-password-reset-tokens-001` | **Directory の関心事**。トークンから bucket を引ける形に変える（第6.1節 (d)） |
| 4 | | `ai_client_connections` の `findActiveById(id)` 経路（PK 素引き + `status = 'active'`。`user_id` 述語が無い） | `ADP-ai-client-connections-001` | **User Data DO に閉じる**。トークンが `userId` を自己完結で運ぶので、DO 選択後は `user_id` 述語が自明になる（第5.4節） |
| 5 | B. `userId` を第一引数に取らない解決ポート（読み） | `UserRepository.findByEmail(email)` | `ADP-identity-004` | **Directory の関心事** |
| 6 | | `UserRepository.findBySsoIdentity(provider, providerSubject)` | `ADP-identity-005` | **Directory の関心事** |
| 7 | | `PasswordResetTokenPort.verifyAndConsume(token, now)` | `ADP-identity-015` | **Directory の関心事**（第6.1節 (d)） |
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
| 20 | | Outbox relay / consumer / DLQ / pruner | `packages/core/src/application/workers/`、`apps/web/app/worker/cloudflare/` | **不要になる**（第7.3節） |
| 21 | | 認証アダプターの**トークン失効 consumer**（`identity.aiClientRevoked` を購読） | `spec/domains/identity.md`、`spec/database/index.md` | **不要になる**。失効の権威が `ai_client_connections.status` として同じ DO 内にあり、次のリクエストのガードが直接読む（第5.4.1節 (b)） |
| 22 | E. `user_id` 列を持たない共有基盤テーブル | `outbox`（実装の実テーブル名は `outbox_events`）/ `processed_events` / `_occ_guard` | `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-occ-guard-001` | **不要になる**（第7.3節・第8.1節） |
| 23 | | `search_fts`（`user_id` が UNINDEXED） | `ADP-search-fts-001` | **User Data DO に閉じる**。物理的に1ユーザー分しか入らなくなるので `user_id` 列ごと落ちる（第4.4節） |
| 24 | | `search_embeddings` | `ADP-search-embeddings-001` | **不要になる**（`.adr/003-sqlite-fts5-only-search.md`） |
| 25 | F. `user_id` 列を持たない子テーブル（JOIN でスコープ） | `memo_revisions` / `document_revisions` / `source_links` | `ADP-memo-revisions-001` / `ADP-document-revisions-001` / `ADP-source-links-001` | **User Data DO に閉じる**。JOIN によるスコープ自体が不要になる（第4.4節） |
| 26 | G. `userId` を引数に取らない副作用・変換ポート | `MailSender.sendPasswordResetMail(to: Email, resetToken)` | `ADP-identity-016` | **Directory の関心事**。`userId` 未確定の経路から始まり、宛先の原本を持つのも bucket なので、ジョブの所有者も bucket にする（第7.6節） |
| 27 | | `ArchiveWriter.write(archive)` | `ADP-export-002` | **User Data DO に閉じる**（読み出しのスナップショットまで）。zip エンコードは request Worker で回す（第4.8節） |
| 28 | | `PasswordHasher.hash(plain)` / `verify(hash, plain)` | `ADP-identity-012` / `ADP-identity-013` | **Directory の関心事**（検証材料の保持元）。**計算そのものはどの DO の中でも回さず request Worker で実行する**（第4.8節・第8.3節 (b)） |
| 29 | H. DI 次元（ポート／テーブル単位の列挙では捕まらない） | **indexer 専用**の拡張 `WorkerContainer` | `spec/domains/search.md`、`spec/usecases/search.md`、`packages/core/src/application/di/types.ts` | **不要になる**（第7.1節） |
| 30 | | **pruner 専用**の拡張 `WorkerContainer` | `spec/usecases/trash.md`、`packages/core/src/application/di/types.ts` | **不要になる**（第7.5節） |

**行28 は本 Issue の台帳再走査で新たに見つかった行である。** 述語 (a) を「ID も状態も受け取らないが利用者の秘密を扱うポート」まで広げた結果で、`PasswordHasher` の実行位置は第4.8節の結論を1つ増やしている。

### 4.4 スキーマ方針 ［派生］

**`user_id` 列は落とす。** DO が物理境界なので、同じ DO の中に他ユーザーの行は原理的に存在しない。列を残すと「一致しない行がありうる」という読み方を残してしまい、かえって誤解を招く。

- `memos` / `topics` / `documents` / `ai_client_connections` / `search_entries` から `user_id` 列を削る。`memos_timeline_idx` などの複合索引も先頭の `user_id` が落ちて単純になる。
- `memo_revisions` / `document_revisions` / `source_links` は元から `user_id` を持たず JOIN でスコープしていた。**JOIN によるスコープ自体が不要になる**ので、`spec/database/index.md` の該当記述はまるごと単純化される（#35）。
- 自分の `userId` は `_meta` テーブルに1行だけ持つ。用途は export のヘッダ、移送・検証、`ctx.id.name` が使えない経路（第6.3節）のフォールバックの3つに限る。**行データの絞り込みには使わない。**

制約の突き合わせ（第2.1節 #17）: 1テーブル100列に対して最大は `documents` の十数列、行 2 MB に対してメモ本文は要件上それを大きく下回る、bind パラメータ100 に対しては一括挿入（`insertSourceLinks` など）をチャンク分割する。いずれも抵触しない。

### 4.5 リポジトリ契約の変化 ［派生］

`spec/domains/index.md` のテナント分離規約「外部入力の ID を受けるメソッドは `userId` を第一引数に取る」は、DO 化後は次のように読み替える。

**`userId` は DO 選択で消費され、DO 内のリポジトリは `userId` を取らない。** 構造的保証の在り処が「型（第一引数）」から「到達可能性（他ユーザーの DO stub を得る経路が存在しないこと）」へ移る。後者のほうが強い — 型の保証は「呼び出し側が正しい `userId` を渡す」ことに依存するが、到達可能性の保証は誤った `userId` を渡す経路そのものを消す（第5.5節）。

これに伴い、**規約の例外条項（「例外は Outbox 経由の信頼済み内部イベントを契機とするワーカー（search の indexer consumer 等）のみ」）は消える。** Outbox が transport でなくなり indexer consumer が存在しなくなるため、規約は「例外なし」に単純化できる。#35 が `spec/domains/index.md` をそう直す。

**memo / knowledge の書き込み系が `userId` を取らない**という現行の非対称（規約が読み取り側にしか効いていない。第4.3節の行11〜16）も、これで自動的に解消する — 読み取り側からも `userId` が落ちるので、読み書きの署名が揃う。

### 4.6 容量とライフサイクル ［派生］

**上限は「本体 + FTS インデックスの合計で 10 GB」で見る。** 仮想テーブルへの書き込みも rows written に算入され（第2.1節 #15）、trigram は1ドキュメントあたりのインデックス行数が最も多い部類だからである。

増幅を抑える手段は external-content FTS5 を使うこと（第7.1節）。`content='search_entries'` / `content_rowid='rowid'` で本体行を参照させると、FTS 側に本文の複製を持たずに済む。それでも trigram の転置インデックス自体は本文長に比例して膨らむので、**容量の見積りは本体の数倍**を前提にする。

逼迫時の挙動は第4.7節のとおり「書き込みだけが `SQLITE_FULL` で落ち、読みと `DELETE` は通る」半死状態になる。したがって逼迫時の導線は **ゴミ箱を空にする / エクスポートして削除する** が生きる。監視の閾値・アラート・容量レポートは #38。

### 4.7 DO プラットフォームエラーの翻訳表 ［参考］

`CLAUDE.md`「adapter → application: アダプターが driver 固有エラーを共有エラー契約へ翻訳する」の適用先。DO アダプターが次の規則で `packages/core/src/lib/` 由来の共有エラー契約へ写す。

| プラットフォーム条件 | 写す先 | retryable | 根拠 |
|---|---|---|---|
| `.overloaded` が真のエラー（1オブジェクト 1,000 req/s の soft limit 超過） | `SystemError(ServiceOverloaded)` | **false** | 公式がリトライ禁止と明記している（第2.1節 #19）。`ConflictError("OPTIMISTIC_LOCK_FAILURE")` のようなリトライ可能系へ写してはいけない |
| `SQLITE_FULL`（10 GB 到達） | `SystemError(StorageCapacityExceeded)` | **false** | 書き込みだけが失敗し読みと `DELETE` は通る半死状態。通常の DB 障害と同じ扱いにすると復旧手段（削除）を塞ぐ |
| `ctx.abort()` / DO のリセット | `SystemError(DatabaseError)` | true | 接続断と同種。次のリクエストで DO が再構築される |
| 条件付き UPDATE の0行一致（OCC 不一致） | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` | false（呼び出し元まで届ける） | 現行方針を維持（`CLAUDE.md`「Retry strategy」）。D1 のような CHECK 違反メッセージの部分一致は不要になる |

**CPU 予算超過には写す先が無い。** 超過はエラーとして観測されず、エビクションとリセットとして現れるからである（第2.1節 #4）。翻訳表の対象外であることを明記し、予防は第4.8節で行う。

### 4.8 DO 内で回す大きな CPU 仕事の扱い ［派生］

DO は single-threaded なので、重い計算を回している間そのユーザー（または Directory bucket なら同じ bucket に写像される全ユーザー）のリクエストが止まる。しかも判定基準は wall time ではなく CPU 予算で、**Alarm 駆動には「着信ごとにリセット」の契機が無い**（第2.1節 #4）。対象4件それぞれに結論を出す。

| 仕事 | 結論 | 理由 |
|---|---|---|
| **パスワードハッシュ化 / 検証**（`ADP-identity-012` / `ADP-identity-013`） | **DO の外（request Worker）で回す** | PBKDF2 210,000 回（`.thread/1/adr.md` ADR-002）は CPU 予算を大きく使う。User Data DO で回すとそのユーザーの全リクエストが止まり、Directory bucket で回すと同じ bucket の全ユーザーの認証が止まる。Directory bucket は候補の検証材料を値として返し、照合は request Worker が行う（露出範囲は現行の `findByEmail` が `User` ごとハッシュを返しているのと同じ） |
| **export の zip エンコード**（`ADP-export-002`） | **DO の外（request Worker）で回す。あわせて「上限」を設ける** | `spec/domains/export.md` が同期生成を確定させ、読み出しに単一トランザクション（スナップショット読み）を要求しているので、**読み出しだけ**を DO 内の1回の `transactionSync` で完結させて値として返し、レンダリングと zip 化は request Worker で行う。分割読み出しはスナップショット要求を壊すので採らない。代わりに1回のエクスポートで返せる総バイト数に上限を置き、超過は拒否する（`SystemError` 系。具体値は #38 で決める。第2.1節 #26 が未確認なので spike の結果も入力にする） |
| **FTS5 の全件再インデックス** | **DO 内。ただし Alarm でチェックポイント分割する** | 本体テーブルからしか作れないので DO 内でしか回せない。1回の Alarm で処理する量は「進捗をコミットしてから次の Alarm を張る」単位で切る（第7.4節） |
| **bulk migration** | **DO 内。ただし Alarm でチェックポイント分割する** | 同上。DDL 部分は単発、データ書き換え部分は分割（第9.2節・第9.3節） |

---

## 5. ルーティング ［Issue 要求］

### 5.1 認証済みリクエスト（UI / REST / MCP） ［Issue 要求］

経路は次の一本道になる。

```
Cookie / Authorization ヘッダ
  → sessionCodec.verify(token, now)            ← request Worker。DB を触らない
  → userId（+ sessionEpoch。トークンに署名済み）
  → env.USER_DATA.idFromName(userId)           ← locator の導出はここだけ
  → stub.<usecase>(args)                        ← RPC。値だけを運ぶ
  → DO 内で epoch ガード → usecase 実行
```

**コンテナ構築と `userId` 確定の順序問題を解く。** 現行は `apps/web/app/server.cloudflare.ts` がリクエスト先頭で `createRequestContainer` を作って `AsyncLocalStorage` に載せており、`userId` を確定する `apps/web/app/presentation/currentUser.ts` の `requireUserId()` はそれより後に走る。DO 化後の `RequestContainer` は **`unitOfWorkProvider` を持たなくなり、代わりに DO stub factory（`userId` を受けて stub を返す関数）を持つ**。ファクトリは呼ばれるまで `userId` を要求しないので、構築が先でも問題がなくなる。順序を入れ替える必要は無い。

**epoch ガード。** セッショントークンには発行時の `sessionEpoch` を署名しておき、User Data DO 側の全 RPC エントリの先頭で `account` テーブルの現在値と照合する。不一致・アカウントが `deleting` / `deleted` なら fail closed で拒否する。パスワード変更・リセット・SSO の解除・退会は同じ operation の再送では epoch を一度だけ進める（第6.5節）。

この照合は**追加の往復を生まない** — 認証済みリクエストはどのみち自分の User Data DO を叩くからである。これが第3.1節で Account Home を採らなかった理由の中核である。`.thread/1/adr.md` ADR-002 が受け入れた「サーバー側失効の手段が無い」というトレードオフはこれで解消するが、セッション方式（ステートレス HMAC + TTL 7日）自体は変わらないので、**セッション方式を扱う別 ADR は起こさない**（第3.1節で下した判断）。

### 5.2 DO ID / routing key と PII ［Issue 要求］

**結論は3点。**

- **(a) 生のメールアドレス・SSO subject を DO ID / routing key に使わない。** 使うのは `userId`（User Data DO）と、canonical credential を HMAC した値（Directory bucket）だけである。
- **(b) 正規化値の HMAC-SHA-256 を使う。** Directory の locator は `HMAC-SHA-256(DIRECTORY_ROUTING_SECRET[generation], canonical)` から導出する（第5.2.2節・第5.2.5節）。
- **(c) canonical 値・HMAC 値・locator を、公開入力・URL・ログ・エラーメッセージ・トレースのいずれにも出さない。** エラーは `kind` タグ付きの共有エラー契約だけを運び、識別子を含めない。ログには `userId`（採番された不透明値）と operation ID だけを出す。

**非露出の範囲には運用面も含める。** DO の名前は `ctx.id.name` で DO の内側から可読であり（第2.1節 #6）、さらにダッシュボードの Metrics タブを「an individual Durable Object's ID or name」で絞り込めるようになっている（同 #25）。つまり生クレデンシャルを DO 名に使うと、ルーティング経路の外側（運用画面）にも露出する。これは HMAC を使う理由をもう1つ増やす。

#### 5.2.1 canonical 化の定義 ［派生］

canonical 値の規則を定めないまま HMAC 分割をすると、1バイト違う正規形が別の bucket に落ち、「重複アカウントが例外の出ない形で2つできる」という検出しにくい破れ方をする。規則を確定させる。

- **(a) 正規化手順（メール）** — `trim()` → **NFKC 正規化** → 最後の `@` で local 部と domain 部に分割 → **domain 部を lowercase 化し、非 ASCII を含む場合は punycode（IDNA、ASCII 形式）へ変換** → **local 部を lowercase 化**（Unicode の simple case folding ではなく `toLowerCase()` に揃える。実装間差異を避けるため）→ `local + "@" + domain` に再結合。
- **(b) `Email.create` を canonical 化の唯一の出所にする。** 現行の `packages/core/src/domain/identity/valueObject.ts` の `Email.create` は `trim().toLowerCase()` **だけ**で、NFKC も IDN 正規化もしない。ここを (a) に置き換える。ドメイン層の変更なので #35（spec 反映）と #37（実装）の両方へ引き継ぐ（第11.1節・第11.2節）。
- **(c) SSO subject は正規化しない。** provider 由来の opaque 値であり、正規化すると provider 側の同一性判定とずれる。適用するのは `trim()` のみ。**provider 名だけを lowercase 化**して `provider + " " + subject` を canonical とする（区切りに NUL を使うのは、provider 名や subject に含まれうる文字と衝突させないため）。
- **(d) 規則の変更は鍵ローテーションと同格の移行作業である。** canonical 規則を変えると全 mapping の再写像が必要になり、第6.8節と同じ手順を踏む。規則には版番号を持たせ、mapping 行に記録する。

#### 5.2.2 locator 鍵の分離 ［派生］

DO の名前が変われば別オブジェクトであり、データは付いてこない。したがって鍵に依存する locator と依存しない locator を分けないと、鍵ローテーションが**全ユーザーのデータ本体を移送する作業**になる。**2系統に分ける。**

- **(a) `userId` → User Data DO の locator は鍵に依存させない。** `idFromName(userId)` をそのまま使う。**ローテーション対象外。**
  - 論拠は「`UserId` が UUIDv7 だから」ではない。`packages/core/src/domain/identity/valueObject.ts` の `UserId.create` は trim + 空文字チェックのみで、コメントが明言するとおり id フォーマットは `IdGenerator` の責務であり、ドメインは不透明な非空文字列としてしか扱わない。正しい論拠は次の2つである。
  - (i) 値を採番するのは `IdGenerator` であって外部入力ではない。
  - (ii) `idFromName(userId)` に渡す `userId` は署名済みセッション（または signup 時に request Worker が採番した operation ID）に由来し、外部入力から来ることが構造的にありえない（第5.5節の保証）。
- **(b) canonical credential → Directory bucket の locator は世代付き secret で HMAC する。** **ローテーション対象。**

この分離により、**鍵ローテーションの対象は credential 由来 locator に限られ、User Data DO の同一性には一切波及しない。** ローテーションで動くのは Directory bucket 内の mapping 行と、User Data DO 側の reverse locator 記録だけである。

#### 5.2.3 鍵の所有者と世代管理 ［参考］

第3.2節で Worker を request / state に分けたので、**`DIRECTORY_ROUTING_SECRET` の keyring は request Worker だけに配布する**。state Worker（DO class 側）には置かない。

- keyring は `{ generation, key }` の配列で、active 1件 + previous 0〜1件を持つ。
- lookup は active → previous の順に引く。
- 再 HMAC が必要なローテーション（第6.8節）は、operator 専用の maintenance 経路（公開ルートを持たない）が request Worker 側で走り、bucket から canonical を読んで新しい鍵で HMAC し直す。**secret が state Worker 側へ渡らない構造を保つ。**

Issue の必須要件ではない節なので、詳細な鍵管理手順（保管・ローテーション頻度・監査）は #38 に送る。

#### 5.2.4 location hint / jurisdiction ［参考］

`idFromName()` で作った DO の物理配置は最初のアクセス地点で決まり、後から移せない。`jurisdiction` も ID 生成時にしか指定できない。Issue はレイテンシもデータ居住性も要求していない。

**結論: 今は既定のまま（location hint も jurisdiction も指定しない）。将来変えるならオブジェクトの再作成が必要になる。**

#### 5.2.5 ハッシュ衝突の扱い ［派生］

**(a) HMAC 出力の切り詰めは bucket index の導出にだけ使い、識別には使わない。** HMAC-SHA-256 の256ビット出力のうち、bucket index は先頭2バイトを big-endian の整数として読み bucket 数で剰余を取る。**mapping 行のキーには256ビット全長（hex 64文字）を使う。**

**(b) 2段構造を明記する。** bucket index は衝突しうる（多対1の写像なので設計上必然である）。一意性は bucket の中で確定する。

1. bucket index（切り詰め）で bucket DO を選ぶ。**ここでの衝突は正常**。
2. bucket の中で256ビット全長の HMAC をキーに mapping 行を引く。**ここが識別**。256ビットの偶然衝突は現実的に起きない。
3. さらに確実を期す照合が必要な場面（一意性の登録時と鍵ローテーション時）は、暗号化保持した canonical 原本を復号して定数時間比較する（第6.2.1節）。

**固定 bucket 分割では衝突が設計上必然なので、canonical 原本を「持たない」に倒すと一意性の最終確認手段が消える。** これが第6.2.1節で原本を保持する3つ目の動機である。逆に credential 1件 = DO 1個の案（第6.2節 (c)）で HMAC を切り詰めると、衝突は「別人のアカウントに解決する」という認証境界の破れになる — 本設計は (b) を採るのでこの経路は生じない。

### 5.3 未認証リクエスト（login / signup / password reset） ［Issue 要求］

`userId` が確定するまでの解決順序を決める。すべて request Worker が起点になる。

**login（パスワード）**

1. 入力を transport 境界で検証し、`Email.create` で canonical 化する（第5.2.1節）。
2. canonical から active 世代の locator を導出して Directory bucket を引く。見つからなければ previous 世代でも引く。
3. bucket は `{ userId, passwordVerifier, status }` を値として返す。**見つからない場合もダミーの検証材料を返す**（request Worker 側の定数でもよい）。
4. request Worker が `PasswordHasher.verify` を実行する（第4.8節）。未登録・SSO 専用・パスワード誤り・不正形式のいずれでも**同じ計算量を通り、同じ公開エラーを返す**。
5. 成功したら `idFromName(userId)` で User Data DO を引き、アカウント状態が `active` であることと `sessionEpoch` の現在値を得る。
6. 現在の `sessionEpoch` を署名したセッショントークンを発行する。

**signup** は第6.3節の saga。**password reset** は第6.1節 (d) と第7.6節。

**SSO login** は canonical が `provider + subject`（第5.2.1節 (c)）になるだけで、2〜3 と 5〜6 は同じである。

### 5.4 MCP / REST（AI クライアント）の認可経路 ［Issue 要求］

**AI クライアントトークンを自己完結型にする。** トークンは `{ userId, connectionId, scope, exp }` を HMAC 署名したもので、検証は request Worker が DB を触らずに行う（セッショントークンと同じ方式）。

これで `AiClientConnectionRepository.findActiveById(id)` のグローバル引き（第4.3節の行4 / 行8）は**置き換わる** — `userId` はトークンから直接得られるので DO を選べ、DO の中では `connectionId` の `status = 'active'` 判定と `recordUsage` がユーザー境界の内側に閉じる。ポートの署名からは `userId` が落ちるが、それは第4.5節の読み替えのとおりである。

Directory に token → userId の写像を持つ案は採らない。理由は (i) 認証済みリクエストのホットパスに Directory への往復が1本増える、(ii) Directory bucket が AI API の全リクエストを受けることになり 1,000 req/s の soft limit に近づく、の2点である。

#### 5.4.1 セッション / AI クライアントトークンストアの所在 ［派生］

`spec/database/index.md` は認証インフラテーブル（Cookie セッションストア・OAuth 2.1 のアクセス／リフレッシュトークン・認可コード・PKCE 検証子）を「スコープ外」とだけ書き、スキーマが存在しない。一方で同ファイルと `spec/domains/identity.md` は `identity.aiClientRevoked` を「認証アダプターのトークン失効 consumer」が購読して**そのストアを書き換える**と定めている（第4.3節の行21）。3点を決める。

- **(a) トークン → `userId` の解決は Directory に置かず、自己完結トークンにする**（第5.4節）。セッショントークンも同様に自己完結のままである。したがって「トークンストア」として**永続化が必要なのは認可の事実だけ**になり、それは既に `ai_client_connections`（User Data DO）にある。
- **(b) 失効の到達手段は Outbox ではなく、権威の直読みにする。** `ai_client_connections.status` と `account.sessionEpoch` が権威で、どちらも User Data DO の中にある。トークンを持ったリクエストは必ずその DO を叩くので、失効は**次のリクエストで即座に効く**。トークン失効 consumer は不要になる（第7.3節）。
- **(c) セッションストアは現行の HMAC ステートレスのままでよい。** 第3.1節・第5.1節のとおり、epoch ガードが「サーバー側失効の手段が無い」を解消するので、セッション行を永続化する必要が無い。

**OAuth 2.1 の認可コードと PKCE 検証子だけは短命な永続状態を必要とする**（#12 の範囲）。置き場所は **User Data DO**（認可フローは既にログイン済みのユーザーが同意する経路なので `userId` が確定している）と決める。`spec/database/index.md` の「スコープ外」宣言はこの結論に合わせて #35 が見直す（第11.1節）。

### 5.5 他ユーザーの DO を指定させない構造的保証 ［Issue 要求］

「他ユーザーの DO を指定できる入力面を公開しない」ことを、規約ではなく構造で担保する。

1. **locator を導出する場所を1箇所に限る。** `idFromName` を呼ぶのは request Worker の1モジュール（DO stub factory）だけにする。ここに `userId` を渡せるのは `sessionCodec.verify` / トークン検証の戻り値、または signup で `IdGenerator` が採番した値のいずれかに限られる。
2. **外部入力が locator の材料にならない。** `CLAUDE.md`「Input validation」のとおり、外部入力は transport 境界（`validateSearch` / `inputValidator`）で検証されてから usecase に入る。usecase は DO の**内側**で走る（第8.3節 (a)）ので、外部入力が locator の導出点に到達する経路が構造上存在しない。
3. **URL・フォーム・API パラメータのいずれにも DO 名 / bucket index を出さない**（第5.2節 (c)）。出さないので、書き換えて別の DO を指す攻撃対象面が無い。
4. **DO の中には他ユーザーの行が存在しない。** 万一 locator の導出を誤っても、誤った DO には誤ったユーザーのデータしか無く、「他人のデータを1行だけ読む」という部分的な漏洩は起き得ない。誤りは全件のズレとして即座に顕在化する。

---

## 6. Identity Directory DO ［Issue 要求］

### 6.1 解決責務 ［Issue 要求］

Issue が列挙した4項目を個別に結論づける。第3.1節で Account Home を採らなかったので、委譲先は無く4項目とも Directory bucket が持つ。

- **(a) 正規化メール → `userId`。** bucket 内の `credential_mappings` 行が `{ hmac(64 hex), kind: 'email', userId, generation, status, encryptedCanonical }` を持つ。現行の `UserRepository.findByEmail`（`ADP-identity-004`）を移す形になる。**これは「これから設計する」ではなく「既存実装をどう移すか」である** — `packages/core/src/adapters/d1/migrations/0000_initial.sql` の `users_email_uq` が既に動いているグローバル一意制約であり、それが bucket 内の一意制約へ移る。
- **(b) SSO provider + subject → `userId`。** 同じ `credential_mappings` に `kind: 'sso'` の行として入る。canonical は第5.2.1節 (c) の `provider + " " + subject`。現行の `findBySsoIdentity`（`ADP-identity-005`）と `users_sso_identity_uq` 部分ユニークを移す。**`kind` が違えば同じ bucket に同居してよい** — 一意性は `(kind, hmac)` で取る。
- **(c) メール・SSO 主体の一意性。** 権威は「その canonical を写像する bucket の中の行」1つだけである。同じ canonical は必ず同じ bucket に落ちる（同一世代・同一鍵なら決定的）ので、bucket 内の一意制約がグローバル一意性と等価になる。**bucket 間の調整は要らない。** これが固定 bucket 分割を採る最大の利点である（第6.2節）。
- **(d) パスワード認証・パスワードリセットで必要な認証情報の所有境界。** **Directory bucket が持つ。**
  - パスワードの検証材料（現行の `users.password_hash` 相当）は `credential_mappings` の `kind: 'email'` 行に持つ。`userId` 未確定の経路（login / reset）から引く必要があるため、User Data DO には置けない。**照合の計算は request Worker で行う**（第4.8節）。
  - リセットトークンは `password_reset_tokens` 相当を bucket 内に持つ。現行のグローバル UNIQUE（`ADP-password-reset-tokens-001`）は「トークンのハッシュから bucket を引ける」形に変える — **リセットトークンの生成時に、対象 credential と同じ bucket index をトークン本体に埋め込む**（`{bucketIndex}.{random}` 形式）。これでトークン単体から bucket を決定でき、全 bucket 走査が不要になる。トークンのハッシュは bucket 内で一意であればよい。
  - 期限切れトークンの掃除は bucket の Alarm（第7.4節）。

### 6.2 分割方式 ［Issue 要求］

3案を4つの判断軸で比較する。

| 判断軸 | (a) 単一グローバル DO | (b) 固定 bucket 数のハッシュ分割 | (c) credential 1件 = DO 1個（DO 名 = HMAC(canonical)） |
|---|---|---|---|
| **(i) 列挙可能性**（ローテーションと retirement 証明） | 対象が1個なので自明 | **bucket の集合が `0..N-1` として構成上既知**。走査できる | **不可能**。DO 名の集合は既存 canonical の HMAC 集合そのもので、namespace を実行時に列挙する手段が無い（第2.1節 #5）以上、外部に権威ある inventory を別途持たない限り旧世代0件を証明できない |
| **(ii) bucket 数の不変性** | 該当なし | 後から変えられない。**世代 + 再写像で対処する**（下記） | 該当なし（原理的に消える） |
| **(iii) 衝突の意味**（第5.2.5節） | 該当なし | **設計上必然**（多対1）。bucket 内の全長 HMAC で識別が確定する | 切り詰めると**別人のアカウントに解決する**認証境界の破れになる。切り詰めなければ DO 名が64文字になる |
| **(iv) 未認証経路からの DO 生成** | 生成は1個だけ。ただし**未認証トラフィックが1オブジェクトに集中し 1,000 req/s の soft limit と `overloaded`（リトライ禁止）に直撃する** | bucket 数が天井になる。未認証の総当たりでも新しいオブジェクトは増えない | **任意の未認証文字列が新しい DO 名を引く**。総当たりが毎回コールドな DO インスタンス化を誘発する |

**(b) 固定 bucket 数のハッシュ分割を採る。**

- **(a) を採らない理由**は (iv) — login / signup / password reset の全トラフィックが1オブジェクトに集まり、soft limit を超えると `overloaded` になる。公式がリトライを禁じているので、超過は素直に失敗として利用者に返るしかない。無条件採用はしない。
- **(c) を採らない理由は (i) と (iv) の両方である。** どちらか一方に寄りかからせない。(i) 鍵ローテーションを完了させるには「旧世代の locator が0件である」ことを証明しなければならないが、DO namespace を実行時に列挙できない以上、権威ある locator inventory を別に持たない限り証明できない。inventory を持てば結局それが単一の集中点になり (c) の利点が消える。(iv) 未認証入力が無制限にコールドな DO を起こせる構造は、それ自体が資源枯渇の攻撃面になる。
  - なお **(i) が立脚しているのは「外から namespace を列挙できない」というプラットフォーム事実であって、「DO が自分の名前を読めるか」ではない。** 後者は `ctx.id.name` で可能である（第2.1節 #6）が、それは (i) の結論を動かさない。

**bucket 数と (ii) の扱い。** bucket 数は locator 名に世代とともに埋め込む — 名前は `dir:g{generation}:b{index}` の形にする。**bucket 数の変更は世代の変更として表現し、鍵ローテーション（第6.8節）とまったく同じ再写像機構で処理する。** これにより (ii) の「後から変えられない」は行き止まりではなくなる。初期 bucket 数は **256** を採る。根拠は (i) Directory を叩くのは未認証経路（login / signup / reset）と SSO リンク操作だけで認証済みトラフィックは通らないこと、(ii) 256 分割なら1 bucket あたりの認証トラフィックが 1,000 req/s の soft limit から十分離れること、(iii) ローテーションの全 bucket 走査が 256 オブジェクトのチェックポイント走査に収まり、Alarm の CPU 予算（第2.1節 #4）で分割実行できる規模であること、の3つである。

#### 6.2.1 canonical credential の保持と保護 ［派生］

HMAC は一方向なので locator から原本を復元できない。しかし原本が可逆に必要になる動機が**3つ**ある。

1. **パスワードリセットメールの宛先** — `MailSender.sendPasswordResetMail(to: Email, ...)`（`ADP-identity-016`）は生のメールアドレスを要求する。
2. **鍵ローテーション時の再 HMAC** — 新しい世代の locator は canonical からしか計算できない（第6.8節）。
3. **bucket 内の識別の最終確認** — 固定 bucket 分割では bucket index の衝突が設計上必然なので、一意性の登録時に「本当に同じ canonical か」を確定させる最終手段が要る（第5.2.5節）。

**(a) 保持場所: Directory bucket。** `credential_mappings` 行の `encryptedCanonical` として、暗号化した状態で持つ。**User Data DO には複製しない** — 複製すると PII の所在が2箇所になり、退会時の消去範囲と PITR の復旧単位（第10.1節）がどちらも複雑になる。

**(b) 暗号化鍵の所有者と配布境界: `IDENTITY_MAIL_ENCRYPTION_KEY` として state Worker だけに配布する。routing secret とは別鍵にする。** 別鍵にする理由は2つ — routing secret はローテーションのたびに世代が増えるが暗号化鍵はそうではないこと、routing secret は request Worker、暗号化鍵は state Worker と配布先が違うこと（第3.2節）。

**(c) 復号が許される経路を2つに限る。**
1. メール送信ジョブ（bucket の Alarm。第7.6節）— 宛先の組み立てのためだけに復号する。
2. 鍵ローテーションの再写像（第6.8節）— このときだけ canonical が request Worker 側へ渡る。secret の配布境界を守るため、HMAC の計算は request Worker でしかできないためである。

いずれも復号結果をログ・エラー・メトリクスに出さない（第5.2節 (c)）。

**(d) 退会時の消去範囲。** 退会が完了した時点で `encryptedCanonical` を含む `credential_mappings` 行を**物理削除する**（第6.7節）。bucket 側には何も残さない。非 PII の tombstone は User Data DO 側だけに残す。

### 6.3 アカウント作成 saga ［Issue 要求］

DO 間に分散トランザクションは無い（第6.9節）ので、**再開可能な saga** にする。跨ぐ DO は User Data DO と Directory bucket の2つだけである。

| phase | 実行場所 | 内容 | 再開可能性 |
|---|---|---|---|
| 0 | request Worker | `IdGenerator` が operation ID を採番し、**その値をそのまま候補 `userId`** として使う。再送では同じ値を保持する | 冪等キーの起点 |
| 1 | User Data DO | `operations` に `{ operationId, kind: 'signup', payloadDigest, phase: 'reserving' }` を記録する。同じ `operationId` で違う digest なら `ConflictError` | phase を読めば再開できる |
| 2 | Directory bucket | 全 credential（メール、SSO 主体）の locator を**安定ソートして決定順に**予約する（`status: 'reserved'`、`operationId` 付き、TTL 付き）。既に active な mapping があれば敗北して `ConflictError("EMAIL_ALREADY_REGISTERED")` 等 | 予約行が冪等キーを持つ |
| 3 | User Data DO | 実データを初期化し（`user_settings` / `account` を書く）、`account.status = 'active'`、`operations.phase = 'activating'` | 同上 |
| 4 | Directory bucket | 予約を `status: 'active'` へ昇格する | 同上 |
| 5 | User Data DO | `operations.phase = 'done'`、`credential_locators` に reverse locator（世代 + bucket index + 全長 HMAC）を記録 | 完了 |

**決定順の予約**（phase 2 で locator を安定ソートしてから順に取る）は、複数 credential を同時に登録する signup が互いにデッドロックしないための規則である。

**`ctx.id.name` を前提に配線を組む。** 先行案は「DO に自分の routing key を明示的に渡す」形になっていたが、DO は `ctx.id.name` で自分の名前を読める（第2.1節 #6）。とくに Alarm ハンドラには名前を渡すクライアントが居ないため、公式が用例として挙げている経路そのものである。

**結論: 明示的に渡すのはやめる。ただし `ctx.id.name` が `undefined` になる4条件（`newUniqueId()` 由来 / `idFromString()` 経由 / 1,024 バイト超の名前 / 2026-03-15 より前に作られた Alarm）に備え、初期化時に自分の locator（`userId` または `dir:g{gen}:b{index}`）を `_meta` テーブルへ1行だけ書き込み、`ctx.id.name` が使えない場合のフォールバックにする。** 第6.8節と第7.4節も同じ判断に従う。

### 6.4 部分失敗と補償 ［Issue 要求］

各 phase の失敗時に何が残り、誰がいつ片付けるかを決める。

| 失敗した phase | 残るもの | 片付ける主体 | いつ |
|---|---|---|---|
| 1 の直後 | User Data DO に `phase: 'reserving'` の operation 行だけ | User Data DO の Alarm | operation の TTL 経過後。DO ごと未初期化なので `account` 行を作らずに operation 行を消す |
| 2 の途中 | 一部の credential だけが `reserved` | **Directory bucket の Alarm**（予約の期限切れ掃除） | 予約の TTL 経過後。`status: 'reserved'` かつ TTL 超過の行を削除する |
| 3 の途中 | Directory に全 credential の `reserved`、User Data は初期化途中 | User Data DO の Alarm が saga を**前進**させる（補償ではなく再開） | operation の再開間隔経過後。phase 2 は冪等なので同じ予約を掴み直せる |
| 4 の途中 | 一部の mapping だけが `active` | 同上（前進） | 同上。phase 4 は冪等 |
| 5 の直前 | すべて `active` だが reverse locator が未記録 | 同上（前進） | 同上 |

**規則は「phase 3 以降は前進、phase 2 までは巻き戻し」である。** 境界を phase 3（User Data の初期化完了）に置く理由は、そこが「利用者から見てアカウントが存在し始める」点だからである。それ以前なら黙って消してよく、それ以降は完成させるほうが利用者の期待に合う。

「誰がいつ」の実行機構は第7.4節の Alarm ジョブで、**Directory bucket 側にも同じジョブ機構を置く**（第7.4節の結論）。

### 6.5 リトライ時の冪等性 ［Issue 要求］

- **operation key の設計。** `operationId` は request Worker が採番し、再送中は同じ値を保持する。signup では `operationId` がそのまま候補 `userId` になる。DO 側は `operations` テーブルに `{ operationId, kind, payloadDigest, phase, createdAt }` を持ち、**同じ `operationId` に違う `payloadDigest` が来たら `ConflictError` にする**（別の操作の再送を装った上書きを防ぐ）。
- **同時競合の勝者決定規則。** 同じ canonical に対する予約が競合したら、**(1) 既に `active` な mapping があればそれが勝つ、(2) 無ければ `operationId` の辞書順最小が勝つ。** 決定的な規則にすることで、どちらの側から見ても同じ結論になり調停が要らない。
- **敗者の冪等補償。** 敗者は自分の `operationId` を持つ `reserved` 行だけを削除する（他人の行には触れない）。削除は「無ければ成功」の冪等操作にする。敗者が補償の前に落ちても、予約の TTL 掃除（第6.4節）が同じ結果に収束させる。
- **epoch の前進も冪等にする。** パスワード変更・リセット・SSO の解除・退会は、同じ `operationId` の再送では `sessionEpoch` を**一度だけ**進める。判定は `operations` 行の存在で行う。

### 6.6 SSO リンク / 解除の整合性 ［Issue 要求］

**既存の `SsoUser` 判別共用体の読み替えが前提になる。** 現行の `packages/core/src/domain/identity/entity.ts` は `User = PasswordUser | SsoUser` で、**1ユーザーにつき認証方式が1つ**という形になっている。link / unlink（複数クレデンシャル）はこの形のままでは表現できない。

**読み替え: `User` から認証方式の判別共用体を外し、クレデンシャルの集合を Directory 側の事実として持つ。** User Data DO 側の `account` は「そのアカウントが持つクレデンシャルの種類と件数」だけを非 PII の要約として持ち（`credential_locators` の行数として自然に表現される）、原本と検証材料は Directory bucket にある。`spec/domains/identity.md` の `User` 定義の改訂は #35（第11.1節）。

**link の順序**

1. User Data DO で `operations` に link 操作を記録し、**現在のクレデンシャル件数を読む**。
2. 対象 credential の bucket に予約を取る（既に他アカウントで `active` なら `ConflictError`）。
3. 予約を `active` へ昇格する。
4. User Data DO に reverse locator を追加し、`sessionEpoch` を1つ進める。

**unlink の順序（link の逆順にはしない）**

1. User Data DO で **「最後のログイン手段を外そうとしていないか」を検査する。** `credential_locators` の行数が1ならば `BusinessRuleError` で拒否する。**この検査を最初に置くのは、ここが唯一のアカウント到達性の権威だからである。**
2. User Data DO の `credential_locators` から対象行を削除し、`sessionEpoch` を1つ進め、`operations` に unlink を記録する。
3. Directory bucket の mapping 行を削除する。

**「解除済みだが mapping が残る」状態を作らない方法。** 上の順序だと 2 と 3 の間で落ちると「User Data からは消えたが Directory には残る」状態になる。これは**片方向にしか壊れない** — 残った mapping で login すると `userId` は引けるが、User Data DO 側に reverse locator が無いので **epoch ガードと到達性検査が fail closed で拒否する**（第5.1節）。つまり「解除したのにログインできてしまう」は起きない。逆順（Directory を先に消す）だと、途中で落ちたときに「User Data には残っているが引けない」孤児 locator になり、次の link で「既に使われている」と誤判定させる余地が生じる。したがって**この順序が正しい**。

残った mapping は User Data DO の Alarm が reverse locator との突き合わせで検出し、削除を再試行する。

### 6.7 退会 ［派生］

**tombstone 先行 → User Data 削除確認 → mapping 削除**の順にする。

1. **User Data DO** に `account.status = 'deleting'` を書き、`sessionEpoch` を進める。この瞬間から既存セッション・AI トークンが全部無効になり、login も（Directory から `userId` を引いた後の状態照合で）拒否される。
2. **User Data DO** が利用者データを消す（memos / topics / documents / revisions / source_links / FTS / ai_client_connections / user_settings）。10 GB 級ならチェックポイント分割で Alarm から進める（第4.8節）。
3. **User Data DO** が `account.status = 'deleted'` にする。残すのは**非 PII の tombstone だけ** — 不透明なアカウントキー（= `userId`）、status、epoch、完了時刻。`credential_locators` はこの時点で消す。
4. **Directory bucket** の mapping 行（`encryptedCanonical` を含む）を物理削除する。

**この順序は PITR の復旧単位が DO 1個であること（第10.1節）に耐える。** Directory mapping が到達性のゲートなので、User Data DO を過去へ戻しても mapping が無ければ login できない。逆に Directory bucket を過去へ戻して mapping が復活しても、User Data DO 側の tombstone（`status = 'deleted'`）が現在のままなので fail closed で拒否される。**どちらか一方の restore だけでアカウントが復活することは無い。**

### 6.8 鍵ローテーション ［派生］

**ローテーションの対象は credential 由来 locator に限られる**（第5.2.2節）。User Data DO の同一性には波及しない。

**手順**

1. keyring に新しい世代を active として追加し、旧 active を previous へ降格する（request Worker のみ。第5.2.3節）。この時点から lookup は active → previous の順になる。
2. operator 専用の maintenance 経路が bucket を `0..N-1` の順に走査する。各 bucket で previous 世代の mapping 行を読み、`encryptedCanonical` を復号し、request Worker 側の active 鍵で再 HMAC して**新しい世代の bucket へ移す**。移送先の bucket に active 行を書いてから、元の previous 行を消す。
3. 移送に伴い User Data DO 側の `credential_locators` も更新する（同じ saga・同じ冪等キー機構を使う。第6.5節）。
4. **全 bucket で previous 世代が0件になったことを確認してから、旧鍵を破棄する。**

**「旧世代 locator が0件である」ことの証明。** 全 bucket の checkpoint scan を加算集計するだけでは足りない。#19 のレビュー指摘 B-IDDS6-001 が3つの穴を記録している。本設計での扱いは次のとおり。

| 穴 | 本設計での扱い |
|---|---|
| Directory 側に active row が無い reverse locator が集計から漏れる | **構造的に消える。** Account Home を採らなかった（第3.1節）ので reverse locator は User Data DO 側の `credential_locators` に1系統しか無く、Directory bucket の走査が唯一の権威になる。突き合わせは第6.6節の孤児検出が別途行う |
| 同一ユーザーの複数 locator を重複加算する | **加算をやめる。** 数えるのは「bucket ごとの previous 世代の行数」であり、ユーザー単位では数えない |
| checkpoint が加算更新で snapshot 置換になっていない | **bucket ごとの snapshot 置換にする。** 各 bucket の走査完了時に `{ bucketIndex, generation, previousCount, scannedAt }` を**置換**で記録する。旧鍵の破棄条件は「同一 generation の全 `0..N-1` について `previousCount = 0` の記録が揃っていること」。加算カウンタは持たない |

### 6.9 DO 間分散トランザクションを前提としない宣言 ［Issue 要求］

**本設計は DO 間の分散トランザクションを一切前提としない。** Cloudflare は複数 DO を跨ぐアトミックなトランザクションを提供しないので、User Data DO と Directory bucket にまたがる操作は必ず「途中で落ちうる」ものとして設計する。

代替は **再開可能な saga + 冪等な補償** である。

- 各操作は request Worker が採番した `operationId` を冪等キーとして持つ（第6.5節）。
- 各 DO は自分の side effect の前に phase を永続化してから進む（第6.3節）。
- 落ちた場合は Alarm が拾い、phase 3 以降は前進、phase 2 までは巻き戻す（第6.4節）。
- 補償は「無ければ成功」の冪等操作にし、何度実行しても同じ結果に収束させる。
- **どの中間状態でも、認証・認可は fail closed 側に倒れる**（第6.6節・第6.7節）。中間状態が「ログインできてしまう」方向に開くことは無い。

---

## 7. 非同期処理 ［Issue 要求］

### 7.1 FTS5 の同期更新 ［Issue 要求］

**できる。本体更新と FTS5 の更新を同一 SQLite トランザクションで確定させる。**

根拠は3つである。

1. **同じ SQLite にある。** User Data DO の `search_entries` / `search_fts` は本体テーブル（`memos` / `documents`）と同一の埋め込み SQLite に置かれる。別ストアではないので、そもそも分散させる理由が無い。
2. **`transactionSync` が原子性を与える。** SQLite のストレージ操作は同期でイベントループを譲らないため原子的に実行され（第2.1節 #18）、`ctx.storage.transactionSync()` が明示的なトランザクション境界になる（同 #7）。`sql.exec()` が `BEGIN TRANSACTION` / `SAVEPOINT` を実行できない（同 #8）ことは制約だが、`transactionSync` を使う限り迂回は要らない。
3. **workerd 上で動くことが実測されている。** 先行ブランチの User Data DO 実装が、本体行の書き込みと FTS 側の更新を同一 `transactionSync` で行い、workerd の統合テストで通っている（第7.2節）。

**したがって Outbox consumer を介したインデックス維持は不要になる。** `spec/adr/005-search-index-via-outbox.md` が定めた「ドメインイベントを Outbox 経由で consumer が受け取り非同期にインデックスを更新する」方式は、その根拠（埋め込み生成が外部 API 呼び出しを伴うこと）と方式そのものの両方が失効する。`.adr/003-sqlite-fts5-only-search.md` が根拠側を、`.adr/004-do-local-commit-and-alarm-jobs.md` が方式側を supersede する。

**書き込みコストの増幅を設計に織り込む。** 仮想テーブルへの書き込みも rows written に算入され（第2.1節 #15）、trigram はインデックス行数が最も多い部類なので、本体1行の書き込みが FTS 側の多数行書き込みを伴う。ユーザー単位 DO は 10 GB を1人で使う構成なので増幅が直に効く。緩和策として **external-content FTS5 を採る** — `search_fts` を `content='search_entries'` / `content_rowid='rowid'` で作り、FTS 側に本文の複製を持たせない。更新時に仮想テーブル全体を走査せずに済む効果もある。

**ポートの形も変わる。** `SearchIndexPort` から `upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` が消え、読み取りの `query` だけが残る（第4.3節の行10 / 行16）。書き込み側は「本体を書くトランザクションの中で projection を更新する」内部処理へ畳まれ、独立したポートではなくなる。**`IndexerReadPort` は丸ごと消える**（同行9）。`SystemError(EmbeddingFailed)` も消える。

### 7.2 FTS5 のみで日本語全文検索が成立する根拠（`.adr/003-sqlite-fts5-only-search.md` を支える範囲） ［派生］

**成立する。** ただし公式ドキュメントが保証しているのは FTS5 モジュール本体と `fts5vocab` だけである（第2.1節 #10）。以下は裏付けの種別を明示して積む。

- **正規化（NFKC）。** インデックス側とクエリ側の両方で `String.prototype.normalize("NFKC")` + `trim()` を通す。全角・半角、合成済み文字と結合文字列の差が検索に響かなくなる。**これは自前の処理なので裏付けは不要。** ただし正規化した文字列をインデックスに入れると、スニペットに使う原文とずれる — スニペットは原文側から組み立てる（下記）。
- **トークナイザ（trigram）。裏付けは実測。** `CREATE VIRTUAL TABLE ... USING fts5(..., tokenize='trigram')` が workerd 上で動く。実測の要旨は次のとおり — 「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件を投入し、`東京駅` で2件、**3文字未満に切り詰めた `東京` でも2件**がヒットし、`周辺` を `limit 1` で2ページに分けて引いたときに1ページ目と2ページ目で別の項目が返ることを確認している。日本語は空白でトークン分割できないので、この trigram の可用性が FTS5 単独案の成否を決める。**公式ドキュメントに記載が無いため、この実測が唯一の根拠である。**
- **ランキング（`bm25`）。裏付けは実測。** 先行ブランチの検索アダプターが `bm25(search_fts, 3.0, 1.0)`（タイトルを本文より重く見る重み付け）を使い、workerd 統合テストが通っている。**公式ドキュメントに記載は無い。**
- **スニペット。SQL の `snippet()` / `highlight()` には依存しない。** これらが workerd で使えるかは**未確認**である（第2.1節 #13）。設計上も使わない — インデックスは NFKC 正規化後のテキストを持つのに対し、利用者に見せるスニペットは原文でなければならないため、**原文から grapheme 単位でマッチ位置を割り出して `<mark>` を挿す**方式を採る。先行実装がこの方式で動いている。したがって `snippet()` の可否は `.adr/003-sqlite-fts5-only-search.md` の成否に影響しない。
- **短語フォールバック。** trigram は3文字未満の語をインデックスできない。1〜2文字のクエリは FTS ではなく `LIKE` / `GLOB` へフォールバックする。**制約は LIKE / GLOB パターンの 50 バイト上限**（第2.1節 #16）で、UTF-8 の日本語は1文字3バイトなので実質16文字程度が上限になる。1〜2文字のクエリしかフォールバックに落ちないので抵触しないが、パターン長を境界で検証して超過を拒否する。加えてフォールバックは全走査になるため、対象列とページサイズを制限する。

以上より、**ベクトル検索なしで日本語の全文検索が成立する。** 提供しないのは意味類似検索（表記が異なり字面が重ならない語での想起）だけである。

#### 7.2.1 検索 API の仕様 → #35 へ委譲 ［参考］

**本 Issue では決めない。** topic filter / ゴミ箱除外 / 安定順位 / スニペットの形 / ページングは検索 API の仕様設計であり、`spec/domains/search.md` の改訂（#35）と実装（#37）の領分である。本 Issue が検索について決めたのは第7.1節（同期更新の可否）と第7.2節（`.adr/003-sqlite-fts5-only-search.md` を支える根拠）までである。

先行実装が既に決めている内容を **#35 への入力**として第11.1節へ送る。要旨は次のとおり。

- topic filter は optional な単一トピック。指定時は配下ドキュメントと、その出典になっている active なメモを返す。未知・ゴミ箱内のトピック指定は `TOPIC_NOT_FOUND`。
- 順位の同点は `timestamp DESC, type, id` で決定する。
- ページ間の変更で重複・欠落を出さないため、最初のクエリで結果 DTO を期限付きのスナップショットテーブルへ固定し、不透明なカーソルから同じ集合を読む。
- 検索エントリとトピックは正規化した事実の join で結ぶ。

### 7.3 Outbox / relay / consumer / DLQ の廃止範囲 ［Issue 要求］

**Outbox をドメインイベントの transport として使うのをやめる。relay / consumer / DLQ / pruner をすべて廃止する。**

購読者は2つあり、どちらも消える。

| 購読者 | 廃止できる理由 |
|---|---|
| search の indexer consumer | インデックスが本体と同一トランザクションで更新されるので、そもそも配送する必要が無い（第7.1節） |
| 認証アダプターの**トークン失効 consumer**（`identity.aiClientRevoked` を購読） | 失効の権威（`ai_client_connections.status` と `account.sessionEpoch`）が User Data DO の中にあり、トークンを持ったリクエストが必ずその DO を叩くので、次のリクエストのガードが直接読める（第5.4.1節 (b)）。書き込み先が `spec/database/index.md` で「スコープ外」とされスキーマが存在しなかった問題も、これで解消する |

**ドメインイベントは「業務・監査の表現」としても残さない。** `UnitOfWorkContext.collectEvents` は廃止する。理由は3つである。

1. 唯一の購読者だった indexer が消え、残る購読者（トークン失効）も直読みへ置き換わるので、**発行された事実を消費する経路が1つも無くなる**。
2. 監査ログが要件として存在しない（`spec/requirements.md` に監査要件が無い）。「将来使うかもしれない」で仕組みだけ残すのは、`.adr/001-integration-tests-single-workers-pool.md` が「理由が消えたら設定も消す」として採った態度と一致しない。
3. `spec/domains/*.md` に広範に書かれているイベント定義は、**リビジョン（`memo_revisions` / `document_revisions`）が業務上の変更履歴を既に持っている**ので、業務表現としての役割も重複している。

これに伴い `packages/core/src/application/ports/outboxRepository.ts` / `packages/core/src/application/ports/relayTrigger.ts` / `packages/core/src/application/ports/idempotencyStore.ts` の3本も不要になる（第11.2節）。RPC の再送に対する冪等性は `operations` テーブル（第6.5節）が担うので、`idempotencyStore` の役割はそちらへ移る。

`spec/domains/*.md` のイベント定義表の削除は #35 の作業になる。改訂量が大きいので第11.1節に明記した。

### 7.4 Alarm ジョブ ［Issue 要求］

1 DO につき Alarm は1本しか持てない（第2.1節 #2）ので、複数種類のジョブを1つの job table で多重化し、Alarm は「最も早い `nextRunAt`」に張り直す。

**ジョブ行が持つ列**

| 列 | 用途 |
|---|---|
| `operationKey` | ジョブの同一性。同じキーの再投入は既存行に収束する |
| `kind` | 実行する処理の種別（`purge-trash` / `send-mail` / `resume-signup` / `sweep-reservations` / `rotate-remap` / `reindex` / `migrate-bulk`） |
| `payload` | 実行に必要な値（対象 ID など）。**PII を入れない** |
| `payloadDigest` | 同じ `operationKey` に違う payload が来たら `ConflictError`（第6.5節と同じ規則） |
| `attempt` | リトライ回数 |
| `nextRunAt` | 次に実行してよい時刻 |
| `status` | `pending` / `running` / `done` / `poison` |
| `leaseUntil` | claim の有効期限 |
| `ownerToken` | claim した実行主体の識別子。完了は CAS でこれを照合する |
| `providerIdempotencyKey` | 外部 I/O のプロバイダへ渡す冪等キー（第7.6節） |
| `terminalReason` | poison になった理由 |

**claim と完了の CAS。** 1件ずつ `UPDATE jobs SET status='running', leaseUntil=?, ownerToken=? WHERE operationKey=? AND (status='pending' OR leaseUntil < ?)` で claim し、0行更新なら他が持っているとみなして次へ進む。完了も `WHERE operationKey=? AND ownerToken=?` の CAS で行う。DO は single-threaded なので同一 DO 内で claim が競合することは無いが、**lease は「実行中に DO がリセットされた」場合の回収手段として必要である**（第2.1節 #4 のエビクション）。期限切れ lease は専用の索引から reclaim する。

**backoff と poison。** 失敗時は `attempt` を進め、指数バックオフで `nextRunAt` を先送りする。上限回数を超えたら `status='poison'` にして `terminalReason` を残し、ホットパスの索引から外す。`done` と `poison` は別々の保持期間で prune し、走査を bounded に保つ。

**bounded 処理の判定基準は wall time ではなく CPU 予算で書く。** Alarm ハンドラの wall time は15分ある（第2.1節 #3）が、先に当たるのは CPU 予算である（同 #4）。しかも **30秒は着信ごとにリセットされる枠であり、着信リクエストの無い Alarm 駆動には戻す契機が無い。** さらに超過の帰結はエラーではなく**エビクションとリセット**なので、bounded 処理は「失敗して再試行される」のではなく「途中まで進んで黙って落ちる」形になる。

**したがって1回の Alarm で処理する量は、進捗をコミットしてから次の Alarm を張る単位（チェックポイント）で切る。** 具体的には (i) ジョブを1件ずつ処理し、1件ごとに結果をコミットする、(ii) 1回の Alarm で処理する件数と累積の経過時間に上限を置き、上限に達したら残りを次の Alarm へ回す、(iii) 1件が大きい場合（全件再インデックス、bulk migration、退会時の一括削除）はジョブ自身が内部カーソルを持ち、カーソルを進めてコミットしてから次の Alarm を張る。**「例外が上がるから検出できる」を前提にした設計にしない。**

**Alarm の再設定規則。** ジョブの変更と「DB 上の最早 `nextRunAt`」の読み取りを同じ `transactionSync` の戻り値にする。通常の DO 入力では既存 alarm より早い場合だけ `setAlarm` する。Alarm ハンドラの `finally` では、リトライ・後片付けを継続するために DB の最早時刻へ必ず再設定する。過去または現在時刻の due job は同じ入力中の即時発火と競合しないよう、DB の `nextRunAt` は変えずにプラットフォーム側の alarm だけを現在時刻の1秒後へ clamp する。設定に失敗したら次の DO 入力で DB から最早時刻を再計算する。`waitUntil` は DO の中では効かない（第2.1節 #22）ので、Alarm 以外の遅延実行手段を使わない。

**同じジョブ機構を Identity Directory bucket にも適用する。** 「1 DO につき Alarm は1本」はどのクラスにも効き、bucket 側にも (a) 予約の期限切れ掃除（第6.4節）、(b) saga 補償の再開駆動（同）、(c) 鍵ローテーションの再写像バッチ（第6.8節）、(d) `password_reset_tokens` 相当の期限切れ行掃除（第6.1節 (d)。`spec/usecases/` にユースケース定義が無い未設計領域）、(e) メール送信（第7.6節）が要る。**job table と Alarm の実装は2クラスで共有する**（`packages/core/src/adapters/cloudflare/*` の共通モジュールとして #37 が置く）。

### 7.5 trash retention の期限処理 ［Issue 要求］

**全ユーザー横断の `TrashQueryPort.listExpiredItems(now, limit)` を、各 User Data DO の Alarm に置き換える。**

置き換え対象はポート1本だけではない。その実現手段である **`user_id` を含まない部分インデックス3本（`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`）と `users` との全ユーザー JOIN も道連れになる**（第4.3節の行17 / 行18）。DO の中では「自分のユーザーの期限」しか無いので、JOIN する相手が存在しない。

- **期限の持ち方。** ソフトデリート時に `RetentionPolicy.expiresAt` 相当を計算して `purge_after` 列に保存する。現行 spec は期限を保存せず毎回算出する純関数にしているが、**DO では保存する** — Alarm を張る時刻を決めるために「最も早い期限」を索引で引く必要があるためである。算出規則そのもの（`RetentionPolicy`）は変えない。
- **Alarm の張り方。** ソフトデリート時に「`purge_after` の最小値」を求め、それが現在の最早 `nextRunAt` より早ければ `purge-trash` ジョブを投入する（第7.4節の再設定規則に乗る）。
- **retention 設定の変更時。** `TrashRetentionDays` は `User` の属性なので変更も同じ DO 内で起きる。変更したトランザクションの中で **ゴミ箱内の全項目の `purge_after` を一括再計算し**、最早値を求めて Alarm を張り直す。ゴミ箱の件数は利用者1人分なので一括更新で足りる（件数が大きい場合は第7.4節のチェックポイント分割に乗せる）。
- **DO が長期間アクセスされない場合。** Alarm は DO を起こすので、利用者がアクセスしていなくても期限処理は走る。これは cron ベースの pruner より強い保証である（cron は「全ユーザーを1バッチで舐める」ので、ユーザー数が増えると1周の遅延が伸びる）。
- **`pruneExpiredTrashItems` ユースケースは消える。** pruner 専用の拡張 `WorkerContainer`（第4.3節の行30）も同時に消える。ハードデリートのロジック（`HardDeletePolicy.expandTargets` による展開、リビジョンと出典リンクの消去）は DO 内のジョブ実行部へ移る。

### 7.6 外部 I/O を永続ジョブに残す境界 ［Issue 要求］

**永続ジョブに残すのは、DO のローカル SQLite だけでは完了できない処理 — すなわち外部 I/O を伴う処理だけである。現時点では該当するのはメール送信の1件だけである。**

線引きの規則は「トランザクションの中で外部 I/O をしない」に尽きる。`transactionSync` のコールバックは完全同期なので（第2.1節 #7）、そもそも `fetch` を呼べない。したがって外部 I/O は必ず「トランザクションでジョブ行を書く → コミット後に Alarm が拾って実行する」形になる。逆に、外部 I/O を伴わない処理（FTS 更新、retention のハードデリート、saga の前進）は**トランザクションかローカルの Alarm で完結するので永続ジョブの transport は要らない**。

**メール送信ジョブの所有者は Identity Directory bucket にする。** 理由は2つ。

1. **パスワードリセットメールは `userId` 未確定の経路から始まる。** 「このメールアドレスの持ち主にリセットリンクを送る」という操作なので、起点は canonical credential であり、所有者が User Data DO でありえない。
2. **宛先の原本を持つのが bucket だけである**（第6.2.1節 (a)）。`encryptedCanonical` を復号できるのは state Worker で、その復号が許される経路の1つがこのジョブである（同 (c)）。

**provider 冪等キーの扱い。** 配送は at-least-once になる（Alarm も at-least-once であり、送信に成功した直後に DO がリセットされうる）。ジョブ行が持つ `providerIdempotencyKey` は `operationKey` から決定的に導出し、**リトライで値が変わらないようにする**。プロバイダ側が冪等キーを解釈すれば二重送信は抑止され、解釈しない場合でも「リセットメールが2通届く」で済む（利用者影響が小さく、逆に届かないほうが有害なので at-least-once を選ぶ）。

**登録の有無によらず同じ成功レスポンスを返す。** リセット依頼は、canonical に対応する mapping が無い場合でもジョブを投入せずに成功を返す。応答時間の差から登録の有無が漏れないよう、**mapping の有無にかかわらず同じ処理経路を通す**（第5.3節の login と同じ規則）。PII をログに出さない（第5.2節 (c)）。

---

## 8. UoW 契約 ［Issue 要求］

### 8.1 現行契約と D1 固有物の棚卸し ［派生］

現行の `packages/core/src/application/execution/unitOfWork.ts` は19行で、`UnitOfWorkContext { userRepository; collectEvents(drafts) }` と `UnitOfWorkProvider { run<T>(fn) }` だけを持つ。`run` はコールバックだけを受け、**テナント / ユーザーのスコープを受け取る引数が構造上存在しない**。

D1 実装（`packages/core/src/adapters/d1/`）が持ち込んでいる次の3つは、**存在理由が「D1 に interactive transaction が無い」ことだけ**なので DO では丸ごと不要になる。

| 対象 | 何をしていたか | 廃止できる理由 |
|---|---|---|
| `packages/core/src/adapters/d1/pendingBatch.ts` の **deferred-batch モデル** | 未 await の Drizzle クエリビルダを配列に溜め、コールバック完走後に `db.batch()` で一括フラッシュする。JSDoc が「Read-your-write within the same UoW is unsupported by design」と明記している | `transactionSync` が本物のトランザクションを与えるので、**同一 UoW 内の read-your-write が普通に書けるようになる** |
| `packages/core/src/adapters/d1/schema.ts` の **`_occ_guard` テーブル** | OCC 書き込みの直後に0行マッチを CHECK 違反へ変換してバッチ全体を abort させる仕掛け。D1 が「`UPDATE ... WHERE version = ?` の0行マッチ」を正常成功として扱うことへの回避策 | トランザクション内で `UPDATE` の変更行数を直接読めるので、CHECK 違反へ変換する必要が無い（第8.4節） |
| `packages/core/src/adapters/d1/repositories/helpers.ts` の **メッセージ部分一致による OCC 検出** | D1 が CHECK 違反をエラーメッセージ文字列でしか返さないため `CHECK constraint failed: occ_guard_positive` の部分一致で判定していた。コメント自身が「メッセージから CHECK 名が落ちると degrade する」と脆さを自認している | 同上。文字列マッチが消える |

**UNIQUE 違反の翻訳点がユースケースに漏れている問題**（`packages/core/src/application/identity/registerWithPassword.ts` の `catch` ブロック）も、同じ理由の派生である。第8.5節で扱う。

### 8.2 新しい UoW 契約 ［Issue 要求］

**`run` を完全同期にする。**

```ts
export interface UnitOfWorkContext {
  userSettingsRepository: UserSettingsRepository;
  memoRepository: MemoRepository;
  // ... その DO が持つ集約のリポジトリ
}

export interface UnitOfWorkProvider {
  run<T>(fn: (ctx: UnitOfWorkContext) => T extends Promise<unknown> ? never : T): T;
}
```

**決定事項**

- **`run` はスコープ引数を取らない。** DO インスタンスそのものがスコープであり、`userId` は DO 選択の時点で消費済みである（第4.5節）。現行の「スコープを受け取る引数が無い」という形はそのまま維持され、**意味だけが「根拠が示されていない」から「DO が境界なので不要」へ変わる**。
- **`collectEvents` は消える**（第7.3節）。`UnitOfWorkContext` はリポジトリだけを配る。
- **同期 commit を型で表す。** コールバックの戻り値型に `T extends Promise<unknown> ? never : T` を課すと、`async` 関数はコールバックとして渡せなくなる（`async` 関数の戻り値は必ず `Promise` なので `never` に落ちる）。
- **transaction に Promise / 暗号 / RPC / メールを持ち込ませない構造。** 上の型で `async` を排除すると、**コールバックの中では `await` が構文エラーになる**。これはライブラリの規約ではなく言語の規則なので、コマンドオブジェクトを介した間接化より強い保証が得られる。加えて、`UnitOfWorkContext` にはリポジトリしか載せない（`MailSender` / `PasswordHasher` / DO stub factory を載せない）ので、非同期ポートへの**到達手段そのものが無い**。
  - 根拠として押さえておくべき事実がもう1つある。**SQL カーソルは `await` を跨いで保持するとスナップショット分離が保証されない**（第2.1節 #9）。同期を型で強制することは、この落とし穴を構造的に踏めなくすることでもある。
- **ネストした UoW は型で禁じない。** `transactionSync` のネスト可否は公式に記載が無く（第2.1節 #14）、`sql.exec()` が `SAVEPOINT` を実行できない（同 #8）ので迂回路も無い。**`run` の中でさらに `run` を呼ばない**という規約を置き、`UnitOfWorkContext` から `UnitOfWorkProvider` へ到達できないようにして構造で担保する。#37 は SAVEPOINT による回避を試みない。

#### 8.2.1 既存ドメインポートの Promise 契約との整合 ［派生］

`packages/core/src/domain/common/transactionalRepository.ts` の `TransactionalRepository` と `packages/core/src/domain/identity/ports/userRepository.ts` の `UserRepository` は、**全メソッドが `Promise` を返すドメイン層のポート**である。`transactionSync` のコールバックは完全同期なので、両立しない。選択肢は2つあった。

- **(a) 署名を同期に変える。**
- **(b) 書き込みをポートから外し、commit command 側へ寄せる**（先行案の `SemanticCommitPort`）。

**(a) を採る。**

(b) を採らない理由は、(b) が目指す保証（transaction に Promise と外部 I/O を持ち込ませない）が **(a) でも `async` の排除だけで達成でき、しかもそちらのほうが強い**からである（第8.2節）。(b) は加えて次の代償を払う — usecase が「読んで判断して書く」形を書けなくなり、すべての書き込みをコマンド DTO に翻訳する層が増える。DO では read-your-write が普通にできる（第8.1節）のに、それを自ら捨てることになる。

**変わるもの**

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

**(a) usecase は DO の中で実行する。** ただし例外を明示する。

request Worker で usecase を実行して remote repository を注入する形は採らない。リポジトリ・UoW のコールバック・SQLite の transaction capability はいずれも RPC 越しに運べず、アプリケーションのトランザクション境界と実際の DO トランザクションが一致しなくなるからである。

**DO の中で実行しないもの（第4.8節の結論と対）**

| 処理 | 実行場所 | 理由 |
|---|---|---|
| パスワードのハッシュ化 / 検証 | request Worker | CPU 予算。single-threaded な DO を長時間占有させない |
| セッショントークン / AI クライアントトークンの署名・検証 | request Worker | `SESSION_SECRET` の配布境界（第3.2節） |
| canonical credential → Directory locator の HMAC | request Worker | `DIRECTORY_ROUTING_SECRET` の配布境界（同上） |
| export のレンダリングと zip エンコード | request Worker | CPU 予算。DO 側は1回の `transactionSync` によるスナップショット読み出しだけを行う |

export の扱いが (a) の判断で最も重い入力である。`spec/domains/export.md` は生成方式を同期生成と確定させ、読み出しに単一トランザクション（スナップショット読み）を要求している。usecase を DO 内で実行する結論に倒すと、素直に書けば read → render → zip の連鎖ごと DO の中に入り、**最大 10 GB を持ちうる single-threaded な DO で zip エンコードを回す**ことになる。そこで export だけは「DO は読み出し、request Worker が render と zip」に分ける。読み出しは1回のトランザクションで完結するのでスナップショット要求は満たされ、上限超過は拒否する（第4.8節）。

**(b) request 側 DI に残るもの**

`sessionCodec` / `clock` / `idGenerator` / `logger` / `config` / `passwordHasher` / **DO stub factory**（`userId` → User Data DO stub、canonical → Directory bucket stub の2種類）。`unitOfWorkProvider` は消える。

**`packages/core/src/application/di/types.ts` の不変条件は維持する。** 同ファイルの JSDoc は「リポジトリはコンテナに載せない。`UnitOfWorkContext` が唯一の発行点」と明文化しており、これが全集約アクセスを UoW の中に閉じ込めている根拠である。DO stub は「その DO 内の全リポジトリへの入口」なので、素朴に載せるとリポジトリを載せたのと同じ到達性を与えてしまう。**そこで stub factory が返すのは生の stub ではなく、その DO が公開する usecase facade（値だけを受け取り値だけを返すメソッド群）に限る。** リポジトリ型も `UnitOfWorkContext` 型も request 側の型に現れない。JSDoc は「リポジトリはコンテナに載せない」を維持したまま、「DO facade はトランスポートであってリポジトリではない」の1文を足す（#37）。

**(c) server component / server function から DO を呼ぶ経路と `getContainer()` の去就**

`getContainer()` は **request 側専用のまま残す。** `packages/core/src/application/di/containerStore.ts` の実装は `globalThis` の `Symbol.for` スロットと `AsyncLocalStorage` の二段構えで、**DO インスタンス内にはリクエストスコープの ALS が無いため必ず throw する**。したがって DO 側は別の合成ルートを持つ — DO クラスの constructor が `ctx.storage` から自前のコンテナを組み立て、インスタンスフィールドとして持つ。ALS は使わない（DO の中では1インスタンス = 1ユーザーなので、暗黙のスコープ伝播が要らない）。

server component / server function から見た変化は「`getContainer()` で得たコンテナから usecase を直接呼ぶ」が「コンテナの DO facade を呼ぶ」に変わるだけで、`apps/web/app/presentation/` の構造（server-function エントリ、エラー応答ミドルウェア、transport 境界の入力検証）は保たれる。**request Worker は `@repo/core/application/*` の usecase 実装を import しなくなり、DTO 型と `SerializedError` の契約だけを import する。**

**(d) `SerializedError` を RPC 越しに維持する方法**

RPC は **`{ ok: true, value } | { ok: false, error: SerializedError }` の値エンベロープだけ**を返す。リポジトリ・クロージャ・transaction capability・カスタムエラーの実体を境界外へ出さない。Workers RPC のカスタムエラー伝搬は `CodedError` の構造的シリアライズ契約を保証しないので、**DO 側の RPC エントリで catch し、`toSerialized()` の結果を値として返す**。request 側は `kind` タグから復元して既存のエラー応答ミドルウェアに載せる。`CLAUDE.md`「エラーは構造的にシリアライズする。`instanceof` で列挙しない」という契約は維持され、境界が1つ増えるだけである。

エンベロープには `version` を持たせ、片側デプロイ・ロールバックの互換ウィンドウ（第3.2節）を確保する。第4.7節のプラットフォームエラー翻訳表は **DO 側で適用する** — request 側に届く時点で既に共有エラー契約になっている。

### 8.4 OCC と `Version` の去就 ［派生］

**残す。**

DO は single-threaded なので、1つのトランザクションの中の read-modify-write は原子的である。しかし競合が消えるわけではない — **「一覧を表示する → 利用者が編集する → 保存する」のようにリクエストを跨ぐ lost update は残る**（第2の書き手が別リクエストで割り込む）。設定画面からの二重解除操作のような競合も同じである。

実現手段は **条件付き UPDATE の0行検出**に変える。`UPDATE ... SET ... WHERE id = ? AND version = ?` を実行し、変更行数が0なら `ConflictError("OPTIMISTIC_LOCK_FAILURE")` を投げる。`_occ_guard` テーブルもエラーメッセージの部分一致も要らなくなる（第8.1節）。

方針は現行のまま維持する — **`ConflictError("OPTIMISTIC_LOCK_FAILURE")` は握り潰さず、ユースケースを通ってトランスポート境界まで届ける。** アプリケーション層の OCC リトライデコレーターは置かない（`CLAUDE.md`「Retry strategy」）。

### 8.5 UNIQUE 違反翻訳点の是正 ［参考］

**戻せる。**

`packages/core/src/application/identity/registerWithPassword.ts` の `catch` ブロックは、UNIQUE 違反を `EMAIL_ALREADY_REGISTERED` へ翻訳する処理がユースケース層に漏れている。コメント自身が「この UoW が何を書くかに依存した安全性であり、別のユニーク制約を持つ書き込みを足したらこの翻訳は消さなければならない」と自認している。原因は deferred-batch モデルで、違反が `insert` の呼び出しフレームの外（バッチのフラッシュ時）で起きることである。

同期 commit では `insert` を呼んだその場で違反が上がるので、**翻訳点をアダプターへ戻せる**（`CLAUDE.md`「adapter → application」の本来の姿）。さらに本設計ではメールの一意性の権威が Directory bucket へ移る（第6.1節 (c)）ので、翻訳は Directory アダプターの責務になり、ユースケースは `ConflictError` をそのまま通す。

これにより `.thread/1/progress.md` に記録されている spec-sync 項目が1件解消する。#35 へ引き継ぐ（第11.1節）。

---

## 9. スキーマバージョン管理と lazy migration ［Issue 要求］

### 9.1 DO class lifecycle と object 内 schema version の分離 ［派生］

**2つは別レイヤーとして扱う。**

- **DO class の lifecycle は Wrangler の宣言的 `exports` で管理する。** `UserDataDurableObject` / `IdentityDirectoryDurableObject` の2クラスを `type = "durable-object"` / `storage = "sqlite"` として宣言する。`[[migrations]]` 配列とは排他で、両方を含む設定は検証で拒否される（第2.1節 #21）。fog はまだ本番 DO namespace を持たないので、`exports` へ直行できる。
- **object 内の schema version は SQL の `_meta` テーブルで管理する。** これは Cloudflare の関知しない、アプリケーション側の関心事である。

**取り違えると危険な点を2つ明記する。** (i) `exports` を deploy した後に旧 `migrations` 配列へ戻せない。(ii) `exports` 経由で削除した namespace に Trash は無く、tombstone をデプロイする前にデータを退避する必要がある。staging / production / local の全設定を `exports` 方式に揃える（第3.2節の `.tpl` 経路）。

### 9.2 `schema_version` の持ち方と migration の起動タイミング ［Issue 要求］

**持ち方: `_meta` テーブルの単一行に `schema_version`（整数）を持つ。** KV の `put()` ではなく SQL 側に置く — migration の適用とバージョンの更新を**同じ `transactionSync` で確定させる**ためである。

**起動タイミング: DO の全 RPC エントリの先頭に置いた冪等なゲート関数で走らせる。`blockConcurrencyWhile` は使わない。**

`blockConcurrencyWhile` を使わない理由は明確である。「最初のアクセス時に migration」は実装上ほぼ確実に constructor + `blockConcurrencyWhile` になるが、これは **30秒でタイムアウトし DO をリセットする**（第2.1節 #23）。10 GB まで育った DO のスキーマ変更が1回のコールバックで終わる保証は無い。ゲート関数方式なら、DDL を1回の `transactionSync` で適用し、重い部分はジョブへ逃がせる（下記）。

**「1回の入力で完了するか」の判定基準は CPU 予算で書く。wall time では導かない。** Alarm 経由なら handler の wall time は15分ある（第2.1節 #3）が、bulk migration や FTS5 の全件再インデックスで**先に当たるのは CPU 予算（既定30秒 / 設定で最大5分の active CPU）**である（同 #4）。`blockConcurrencyWhile` の30秒と CPU 既定の30秒は偶然同値なだけで別物なので、書き分ける。

**失敗モードは「リセット」の意味論で決まる。** CPU 予算は着信リクエストごとに戻る枠であり、Alarm 駆動には戻す契機が無い。しかも超過の帰結はエラーではなく**エビクションとリセット**である。したがって bulk migration は**途中まで進んで黙ってリセットされる**。「例外が上がるから検出できる」を前提にした設計にしてはいけない。これが第9.3節の「部分適用の記録」を任意ではなく**必須**にする。

**単発適用で足りるかの断定。**

**本 Issue が想定する migration（テーブル追加・列追加・索引追加といった DDL 中心の変更）は単発適用で足りる。** SQLite の DDL はデータ量にほぼ依存しないためである。

**分割が必要になるのは次の3条件のいずれかに当たるときで、そのときは必ず分割する。**

1. 既存の全行を書き換える変更（列の型変換、値の再計算、テーブルの作り直し）。
2. FTS5 の全件再インデックス（トークナイザや正規化規則を変えたとき。第5.2.1節 (d) の canonical 規則変更も同種である）。
3. 上記 1 / 2 を、既に大きく育った DO に対して行うとき。

分割する場合は **DDL 部分を単発の `transactionSync` で適用して `schema_version` を進め、データ書き換え部分は `migrate-bulk` ジョブとして Alarm のチェックポイント分割に乗せる**（第7.4節）。

### 9.3 forward-only と失敗時の再実行 ［Issue 要求］

**forward-only にする。下方向の migration は書かない。**

- **各ステップは冪等に書き、ステップの適用と `schema_version` の更新を同じ `transactionSync` に入れる。** これで「適用したがバージョンが進んでいない」状態が原理的に作れない。途中で失敗したステップは丸ごとロールバックされ、次のゲート通過時に同じステップから再実行される。
- **1回で完了しない migration の部分適用を記録する。** `migration_progress` テーブルに `{ targetVersion, step, cursor, updatedAt }` を持ち、**カーソルを進めた分をコミットしてから次の Alarm を張る。** これは任意の最適化ではなく必須である（第9.2節の「黙ってリセットされる」失敗モードのため）。
- **途中状態でのリクエスト受付可否。** DDL 部分が完了して `schema_version` が進んでいれば、**リクエストは受け付ける**。データ書き換えが進行中の期間は、新旧どちらの形の行も読めるようにコードを書く（両対応の読み取り）。受付を止めると、10 GB 級の DO で数分〜数十分のダウンタイムになるためである。両対応が書けない変更は、第9.2節の分類 1 として「新しい列を足して二重書きし、書き換え完了後に旧列を落とす」という**多段の forward-only migration** に分解する。
- **再実行の安全性。** ステップは `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` のように再実行可能な形で書く。`ALTER TABLE ADD COLUMN` のように冪等でない文は、`schema_version` の比較でスキップされることが保証されるので問題にならない（同じトランザクションでバージョンが進むため）。

### 9.4 「コードより新しい version」への遭遇 ［派生］

**fail-closed にする。** `_meta.schema_version` がコード側の期待する最大バージョンより大きい場合、その DO は**リクエストを受け付けず** `SystemError` を返す。

理由は、片側デプロイやロールバックで古いコードが新しいスキーマの DO を触ったときの損害が大きいからである。新しいスキーマの列を知らないコードが `INSERT` すると NOT NULL 違反や不完全な行を作り、次に新しいコードが戻ってきたときにデータが壊れている。**読めないより壊れるほうが悪い。**

これは第3.2節のデプロイ順序（state を先、request を後）と噛み合う — state Worker を先に上げれば、新しい DO コードが古い request からの呼び出しを受ける形になり、逆（古い DO コードが新しいスキーマに当たる）はロールバック時にしか起きない。ロールバック時は fail-closed で止まり、運用が気づける。

### 9.5 ロールバック方針 ［Issue 要求］

**データのロールバックは行わない。**

- スキーマは forward-only で、下方向の migration は書かない（第9.3節）。
- コードのロールバックは可能だが、そのとき `schema_version` が進んでいれば第9.4節の fail-closed で止まる。**したがってスキーマを進める migration を含むリリースは、ロールバック不可のリリースとして扱う。**
- 代替手段は **PITR**（object 単位・過去30日。第2.1節 #20）である。ただし復旧単位は DO 1個で、複数 DO を同一時点へ戻す手段は無い（第10.1節）。PITR はローカル開発では使えないので、検証は staging で行う（第11.3節）。

「戻せない」ことを受け入れる代わりに、**壊れる前に止まる**（第9.4節）と**部分適用を記録して再開できる**（第9.3節）の2つで安全性を確保する。

---

## 10. 運用上の論点（本 Issue では方針だけ、詳細は #38） ［派生］

### 10.1 PITR / export / 退会削除の関係 ［派生］

**PITR の復旧単位は DO 1個であり、複数 DO を同一時点へ戻す手段は無い**（第2.1節 #20）。これは設計上の結論として本節に置く（運用手順は #38）。

したがって「User Data DO を昨日へ戻したが Directory の mapping は今日のまま」という状態が**原理的に作れる**。本設計はこれに耐えるよう組んである。

- **Directory mapping が到達性のゲートである。** login は必ず Directory から `userId` を引くところから始まる（第5.3節）。User Data DO を過去へ戻しても、mapping が今日のままなら到達性は今日の状態に従う。
- **User Data DO の `account.status` と `sessionEpoch` が状態の権威である。** Directory bucket を過去へ戻して削除済みの mapping が復活しても、User Data DO 側の tombstone が現在のままなので fail closed で拒否される（第6.7節）。
- **したがって、どちらか一方の restore だけでアカウントが復活することは無い。** 復旧作業は必ず「両方の現在状態を照合してから」行う。
- **saga の中間状態は restore で復活しうる。** 復活した `reserved` 行は TTL 掃除（第6.4節）が回収し、復活した `operations` 行は `payloadDigest` の照合で古い再送として弾かれる（第6.5節）。
- **export は PITR の代替ではない。** export はゴミ箱を除外し最新リビジョンのみを返す（`spec/domains/export.md`）ので、復旧用のバックアップとしては不完全である。用途は利用者のデータ可搬性であり、両者を混同しない。

### 10.2 監視・容量・コスト ［参考］

いずれも #38 で詰める。本設計が依存する前提だけを固定しておく。

- **容量は「本体 + FTS インデックスの合計で 10 GB」で見る**（第4.6節）。監視の閾値と逼迫時の利用者向け導線は #38。
- **`overloaded` はリトライしない**（第4.7節）。Directory bucket の負荷は bucket 数で割れるので、逼迫したら世代を進めて bucket 数を増やす（第6.2節）。
- **コストの主要因は rows written である。** 仮想テーブルへの書き込みと `setAlarm` 1回がそれぞれ算入される（第2.1節 #15 / #24）。trigram の増幅が最も効くので、コスト試算は本体行数ではなくインデックス行数で行う。

---

## 11. 影響範囲と引き継ぎ ［Issue 要求］

### 11.1 #35 への引き継ぎ — 改訂対象の spec ファイルと改訂内容 ［Issue 要求］

**一覧の取り方。** 手作りの列挙ではない。`grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド' spec` を走らせ（`spec/*/review/**` と `spec/idea.md` は履歴文書なので除外）、ヒットした **40件すべてに「改訂する / 影響なし」の判定**を付けた。判定なしのファイルは無い。

**改訂する（要件・体験側）**

| ファイル | どこを、何に |
|---|---|
| `spec/requirements.md` | **2箇所。** `:87` 付近の「キーワード検索とベクトル検索のハイブリッドを単一の検索として提供する」→「SQLite FTS5 による全文検索として提供する」。`:108` 付近の公開インターフェース「search — ハイブリッド検索。トピックによる絞り込み可」→「search — 全文検索。トピックによる絞り込み可」。「検索方式の選択をAIに委ねない」は維持する（単一の検索であることは変わらない） |
| `spec/scenario/search.md` | `:6` / `:25` のハイブリッド検索前提を全文検索に置き換える。「投稿直後は検索にヒットしない場合がある」という非同期反映の前提を**削除する**（同期更新になるため。第7.1節） |
| `spec/pages/index.md` | `:180` 付近の P-11（検索）の説明からハイブリッド／ベクトルの語を落とす |

**改訂する（ドメイン）**

| ファイル | どこを、何に |
|---|---|
| `spec/domains/search.md` | **271行の大半が対象。** 「検索の規則」の非同期反映条項を削除。`SearchIndexPort` を `query` 1メソッドに縮小（`upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` を削除）。**`IndexerReadPort` の節（4メソッド）を全削除**。「`EmbeddingPort` について」の節を全削除。エラーコードから `SystemError(EmbeddingFailed)` を削除。**「インデックス更新フロー」の節（イベント→consumer 処理の対応表を含む）を全削除**し、「本体更新と同一トランザクションで projection を更新する」の記述に置き換える。末尾の「indexer 専用の拡張ワーカーコンテナ」の記述を削除。第7.2.1節の検索 API 仕様（topic filter / 安定順位 / スナップショットページング）を新しい入力として反映する |
| `spec/domains/index.md` | テナント分離規約を第4.5節の読み替えに合わせる（`userId` 第一引数 → DO 選択で消費。**例外条項「例外は Outbox 経由の信頼済み内部イベントを契機とするワーカー（search の indexer consumer 等）のみ」を削除**）。「ドメインイベント + Outbox」の横断事項を削除する（第7.3節） |
| `spec/domains/memo.md` | イベント定義表を削除。リポジトリ契約から `userId` 第一引数と `Promise` を落とす |
| `spec/domains/knowledge.md` | 同上。`document.sourceLinksChanged` / `memo.sourceLinksChanged` は「イベント」ではなく同一トランザクション内の projection 更新として書き直す |
| `spec/domains/identity.md` | **改訂量が大きい。** `User = PasswordUser \| SsoUser` の判別共用体を解体し、クレデンシャル集合として書き直す（第6.6節）。`UserRepository` を「認証情報側（Directory）」と「ユーザー単位設定側（User Data DO）」に分割。`findActiveById` の説明を自己完結トークン前提に（第5.4節）。`identity.aiClientRevoked` の失効 consumer の記述を削除（第7.3節）。`Email` の canonical 化規則を第5.2.1節に差し替え |
| `spec/domains/trash.md` | `TrashQueryPort.listExpiredItems` を削除し、各 DO の Alarm による期限処理に置き換える（第7.5節）。`RetentionPolicy` の算出規則は維持しつつ「期限を保存する」に変える |

**改訂する（ユースケース・テストケース・台帳）**

| ファイル | どこを、何に |
|---|---|
| `spec/usecases/search.md` | `maintainSearchIndex`（`:85` 以降）を**ユースケースごと削除**する。`search` は残るが、非同期反映の注記を落とす |
| `spec/usecases/trash.md` | `pruneExpiredTrashItems`（`:311` 以降）を Alarm 前提へ書き換える。`:315` の「pruner 専用の拡張ワーカーコンテナ」の記述は削除 |
| `spec/testcases/search/maintainSearchIndex.md` | **対象消滅。** ファイルごと削除する |
| `spec/testcases/trash/pruneExpiredTrashItems.md` | Alarm 前提へ書き換える（起動契機が cron から Alarm へ変わる） |
| `spec/inventory/domain.md` | `DOM-*` のうち search の `IndexEntry` 系、identity の `User` 判別共用体、trash の期限列挙が対象 |
| `spec/inventory/adapter.md` | `ADP-*` の第4.3節で「不要になる」と判定した全件を落とし、残りから `userId` 第一引数と `Promise` を落とす |
| `spec/inventory/usecase.md` | `UC-search-002`（`maintainSearchIndex`）を削除、`UC-trash-007`（`pruneExpiredTrashItems`）を書き換える。**「ポート契約が変われば台帳も変わる」は usecase 台帳にも等しく効く** |
| `spec/inventory/test.md` | `TC-maintainSearchIndex-*` 28件を削除、`TC-pruneExpiredTrashItems-*` 17件を書き換える |

**改訂する（DB・索引・マニュアルテスト・リポジトリ規約）**

| ファイル | どこを、何に |
|---|---|
| `spec/database/index.md` | **403行の前提（共有 SQLite + `user_id` 列による論理分離）ごと組み替える。** 全テーブルから `user_id` 列と先頭 `user_id` の複合索引を落とす（第4.4節）。`outbox` / `processed_events` / `_occ_guard` の節を削除。`search_embeddings` を削除し `search_fts` を external-content 構成に。期限切れ索引3本を DO ローカルの `purge_after` 索引に。**`:355-357` の「認証インフラテーブルはスコープ外」宣言を第5.4.1節の結論（自己完結トークン + OAuth の認可コード / PKCE は User Data DO）に合わせて見直す**。冒頭の `spec/adr/005-search-index-via-outbox.md` への参照を新 ADR へ差し替える |
| `spec/index.md` | `:38-43` の ADR 一覧表。`spec/adr/005-search-index-via-outbox.md` の行に superseded を反映し、`.adr/` の3件への導線を足すか判断する |
| `spec/manual-tests/search.md` | `:5` / `:17` / `:69` / `:266`。とくに `:17`「検索インデックス更新用のワーカー（非同期 consumer）が起動している」という前提が**成立しなくなる**（consumer が存在しない）。「投稿直後は検索にヒットしない場合がある」の確認項目も反転する（同期更新なので必ずヒットする） |
| `spec/manual-tests/trash.md` | `:18` / `:204` / `:212` / `:351` が前提にしている「pruner ワーカーを手動起動できること、またはテスト環境の DB で `trashedAt` を直接更新できること」を、**Alarm の強制発火 / 時計の巻き戻しに相当する手段**へ置き換える。`spec/manual-tests/search.md` の consumer 起動口とまったく同じ性質の前提である。代替手段の実体は #38 |
| `CLAUDE.md` | 「Reference runtime」の「ランタイムを差し替えても `domain` / `application` / `presentation` は無傷」が**成立しなくなる**（第8.2.1節）。「Key concepts」の Outbox / domain events / Retry strategy / Unit of Work の各項も本設計に合わせて書き直す |

**影響なし（判定済み）**

`spec/adr/004-domain-boundaries.md`（ドメイン境界の切り方は変えない。第4.2節）/ `spec/manual-tests/ai.md` / `spec/scenario/ai.md` / `spec/scenario/index.md` / `spec/testcases/identity/registerWithPassword.md` / `spec/testcases/identity/revokeAiClientConnection.md` / `spec/testcases/knowledge/createTopic.md` / `spec/testcases/memo/delete.md` / `spec/testcases/memo/editMemo.md` / `spec/testcases/memo/postMemo.md` / `spec/testcases/memo/post_memo.md` / `spec/testcases/memo/rollbackMemo.md` / `spec/testcases/memo/softDeleteMemo.md` / `spec/testcases/memo/update_memo.md` / `spec/testcases/search/search.md` / `spec/testcases/trash/restoreMemo.md` / `spec/usecases/identity.md` / `spec/usecases/knowledge.md` / `spec/usecases/memo.md` — いずれもヒット語が「ゴミ箱に入れたメモは検索にヒットしない」等の**利用者から見た振る舞い**の記述であり、実現手段の変更に影響されない。ただし `spec/testcases/search/search.md` と `spec/usecases/memo.md` は、非同期反映を前提にした期待値があれば同期前提へ直す（該当箇所は #35 が本文を読んで判断する）。

`spec/adr/005-search-index-via-outbox.md` は本 Issue でステータス行に supersede ポインタを付けた。**本文は改訂しない**（過去の決定の記録として保持する）。

### 11.2 #37 への引き継ぎ — 削除対象 / 新設対象のモジュールと UoW 契約の新旧対比 ［Issue 要求］

**削除対象**

| パス | 内容 | 根拠 |
|---|---|---|
| `packages/core/src/adapters/d1/`（20ファイル / 2,514行。うちプロダクションコード8ファイル / 914行） | D1 アダプター一式。`unitOfWork.ts` / `pendingBatch.ts` / `schema.ts` の `_occ_guard` / `repositories/` / `migrations/` | 第8.1節 |
| `packages/core/src/application/workers/`（`eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 ほか） | relay / prune | 第7.3節 |
| `packages/core/src/application/execution/unitOfWork.ts` | 新契約に置き換える | 第8.2節 |
| `packages/core/src/application/ports/outboxRepository.ts` / `packages/core/src/application/ports/relayTrigger.ts` / `packages/core/src/application/ports/idempotencyStore.ts` | Outbox を transport から外すと3本とも役割が消える。冪等性は `operations` テーブルへ移る | 第7.3節 |
| `packages/core/src/application/di/serverCloudflare.ts` | `ServerEnv = { DB: D1Database; ...; OUTBOX_* }` を DO バインディング前提へ作り直す | 第3.2節・第8.3節 |
| `packages/core/src/application/di/types.ts` / `packages/core/src/application/di/containerStore.ts` | `RequestContainer` から `unitOfWorkProvider` を外し DO facade を足す。**`WorkerContainer` は用途ごと消える** — そこから拡張していた **(i) indexer 専用コンテナ**（`spec/domains/search.md` / `spec/usecases/search.md`）と **(ii) pruner 専用コンテナ**（`spec/usecases/trash.md`）の2種類も同時に消える。`containerStore.ts` は request 側専用として残す | 第8.3節 (b)(c) |
| `apps/web/app/worker/cloudflare/relay.ts` / `consumer.ts` / `pruner.ts` / `dlq.ts` / `handlers.ts`（138行） | Queue ワーカー一式 | 第7.3節 |
| `apps/web/app/presentation/` の一部 | server-function エントリとエラー応答ミドルウェアは残る。usecase の直接呼び出しが DO facade 呼び出しに変わる | 第8.3節 (c) |
| `infra/cloudflare/pulumi/resources/index.ts` | D1 リソースと events / DLQ Queue リソースを削除する。**D1 リソースには「D1 is the system of record — refuse accidental destroy」の destroy 保護がかかっているので、解除手順が要る** | 第11.2節末尾 |
| `apps/web/scripts/render-wrangler.ts` + `apps/web/wrangler.staging.toml.tpl` / `apps/web/wrangler.production.toml.tpl` | Worker が2本になるので `.tpl` を2系統に増やし、2出力へ拡張する。**`.gitignore` により `wrangler.staging.toml` / `wrangler.production.toml` は生成物であり直接編集してはいけない。** 未コミットの `apps/web/wrangler.{request,state}.{staging,production}.toml` 4本は `.tpl` を通さない手書き実ファイルでこの運用に乗っていないので、破棄して作り直す | 第3.2節 |
| ローカル開発用 `apps/web/wrangler.toml`（162行。**DO バインディングが1つも無い**） | 2 Worker + 2 DO クラスの構成を反映する。`pnpm dev` が唯一動く実行手段なので必須項目 | 第3.2節 |
| `apps/web/package.json` の **deploy 系（非 dry 12本 = `deploy:staging` / `deploy:staging:relay` / `:consumer` / `:pruner` / `:dlq` / `:all` と production 側の同6本。`:dry` 変種を含めると全24本）** と **D1 前提の db 系7本（`db:migrate:cf` / `db:apply:local` / `db:apply:staging` / `db:apply:production` / `db:execute:local` / `db:execute:staging` / `db:execute:production`）**。これらに委譲する `db:migrate` も道連れになる | Queue ワーカーの個別デプロイが不要になり、`wrangler d1 ...` は D1 廃止で全滅する。deploy は request / state の2本立てに再編する | 第3.2節・第9.1節 |
| `vitest.config.integration.ts` | `readD1Migrations` / `d1Databases` / `queueProducers` / `queueConsumers` を削除し、DO バインディングに置き換える。`.adr/001-integration-tests-single-workers-pool.md` が「`include` はディレクトリの明示的な許可リスト」と決めているので、新設する DO クラスのディレクトリを `include` に足す | `.adr/001-integration-tests-single-workers-pool.md` |

**新設対象**

- `apps/web/app/durable-objects/*` — `UserDataDurableObject` / `IdentityDirectoryDurableObject` の2クラス。
- `apps/web/app/server.{request,state}.ts` に相当する2つのエントリ（第3.2節）。
- `packages/core/src/adapters/cloudflare/*` — DO 用スキーマ、同期リポジトリ実装、FTS5 projection、job / Alarm 実行部、Directory の mapping ストア、プラットフォームエラー翻訳（第4.7節）。
- `packages/core/src/application/di/*` に DO 側の合成ルート（第8.3節 (c)）。

**UoW 契約の新旧対比**

| 項目 | 現行（D1） | 新（DO） |
|---|---|---|
| `run` の署名 | `run<T>(fn: (ctx) => Promise<T>): Promise<T>` | `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T`（完全同期） |
| スコープ引数 | 無い（構造上渡す口が無い） | 無い（DO インスタンスがスコープ。第4.5節） |
| トランザクション実体 | deferred batch（`PendingBatch` → `db.batch()`） | `ctx.storage.transactionSync()` |
| read-your-write | **不可**（JSDoc に「unsupported by design」） | **可** |
| ドメインポートの戻り値 | `Promise<...>` | 同期（第8.2.1節） |
| イベント登録 | `ctx.collectEvents(drafts)` → outbox 行 | **廃止**（第7.3節） |
| OCC | `_occ_guard` の CHECK 違反 + メッセージ部分一致 | 条件付き UPDATE の0行検出（第8.4節） |
| UNIQUE 違反の翻訳点 | ユースケース層の `catch`（漏れている） | アダプター（第8.5節） |
| 非同期処理 | Outbox + relay + Queue consumer + DLQ | job table + 単一 Alarm（第7.4節） |

**既存 D1 データのカットオーバー方針。**

**移行しない。DO 側で作り直す。** 実装済みドメインは `identity/User` だけで、本番稼働しているサービスが無いためである。移行ツールを作らない。`infra/cloudflare/pulumi/resources/index.ts` の D1 リソースには destroy 保護がかかっているので、削除の際は保護の解除手順が要る（#38 の運用手順に含める）。

**残存課題の扱い。** `.thread/1/progress.md` の残存課題5（D1 データベース名が `tanstack-start-template-d1` のまま / 実装の `outbox_events` と spec 表記 `outbox` の乖離）は **D1 / Outbox の廃止に伴い対象消滅する**。DO の binding 名 / namespace 名の命名として読み替える。

**#40 の扱い。** `pnpm start` / `pnpm preview` の起動不能は `packages/core/src/application/workers/eventRelayWorker.ts` のモジュールスコープ `crypto.randomUUID()` が原因である。同ファイルは第7.3節で削除されるので、**#40 は対象消滅する**。

### 11.3 #38 への引き継ぎ — 運用ドキュメント化が必要な事項 ［参考］

- **PITR の手順** — ローカル workerd では使えないので staging での実施手順。復旧単位が DO 1個であることの設計上の帰結は第10.1節で決着済みなので、ここへ送るのは手順（対象 bookmark、実施日時、User Data DO と Directory bucket の照合、後片付けの記録）だけである。
- **export と退会削除の運用** — 退会のチェックポイント分割（第6.7節）が長時間かかる場合の進捗確認手段。
- **容量監視** — 「本体 + FTS インデックスの合計で 10 GB」の監視閾値、逼迫時の利用者向け導線（第4.6節）。
- **コスト** — rows written の内訳（trigram の増幅、`setAlarm`）（第10.2節）。
- **鍵ローテーションの運用手順** — keyring の世代管理、maintenance 経路の実行、旧鍵破棄の判定（第5.2.3節・第6.8節）。
- **retention を Alarm 化した後の「手動での期限到達再現手段」** — `spec/manual-tests/trash.md` の pruner 手動起動口に対応する運用手段（Alarm の強制発火 / 時計の巻き戻しに相当するもの）。`spec/manual-tests/search.md` の consumer 起動口は consumer ごと消えるので対応不要である。
- **D1 / Queue リソースの destroy 保護の解除手順**（第11.2節）。

### 11.4 未決事項 ［派生］

本 Issue で結論を出さなかったのは次の3件だけである。いずれも**誰がいつ決めるかを割り当ててある**。

| 論点 | 決める主体 | いつ | 本設計への影響 |
|---|---|---|---|
| SQL 関数の `snippet()` / `highlight()` が workerd で使えるか（第2.1節 #13） | #37 | 着手時の spike | **無い。** 設計は原文からスニペットを組む方式を採っており、これらに依存していない（第7.2節） |
| `transactionSync` のネスト可否（第2.1節 #14） | #37 | 着手時の spike | **無い。** ネストしない規約を置いて構造で担保している（第8.2節） |
| 単一 SQL クエリの結果セット合計サイズ上限（第2.1節 #26） | #37 | 着手時の spike | export の読み出し上限値の決定に使う（第4.8節）。上限を設けること自体は決着済みで、**値だけ**が spike 待ちである |

検索 API の仕様（第7.2.1節）は未決事項ではなく、#35 への明示的な委譲である。
