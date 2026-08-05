# 実装手順 — Issue #50

本 Issue の成果物はドキュメントのみだが、**書く内容はレイヤーの内側から決める。** ドメイン（イベント契約と登録口）→ ユースケース（同期 UoW の中での登録）→ アダプター / 永続化（`outbox_events` schema・Alarm 多重化・relay・Queue・consumer・DLQ）→ 規約（`CLAUDE.md`）の順である。設計判断そのものは `adr.md`（AD-1〜AD-18）にあり、ここでは繰り返さず参照する。

## 設計

### ドメインモデルへの影響

**復元する契約（`main` のコードに現存する形をそのまま spec 側の契約として採る）**

- `EventId` — 不透明な非空文字列。形式（UUIDv7）は `IdGenerator` の責務。
- `DomainEventDraftBase<TType, TPayload>` — `{ type, payload, occurredAt, aggregateId }`。**ドメインは identity-less な draft を返し、`EventId` は application 層が付ける。** ドメインが `IdGenerator` に触らないための分離であり、同期 UoW でもこの分離は保つ。
- `DomainEventBase` = draft + `{ id: EventId }`。
- `EventDraft<TEvent>` — 分配的条件型。イベント union に対して `type` 判別子を保つ。
- `WithEventDrafts<TEntity, TEvent>` — エンティティのファクトリ / 遷移が `{ entity, eventDrafts }` を返す形。

**復元しない契約**

- `EventDecoder` / decoder registry — D1 時代は relay Worker が別プロセスで at-rest の payload を復号していた。DO ローカルでは relay が同じ DO の中で走るので、**復号ではなく素通し**でよい。consumer 側の payload 検証は transport 境界の入力検証（zod）として consumer Worker が持つ。
- `RelayTrigger.kick()` — 別 Worker への即時キックが不要になった（`adr.md` AD-5）。

**イベントの全数（初期）**

| owner DO クラス | `event.type` | 発行点 | consumer |
|---|---|---|---|
| Identity Directory | `identity.passwordResetRequested` | `requestPasswordReset` のトランザクション（4ケースすべて） | mail consumer |
| User Data | **0件** | — | — |

`main` のコードにある `identity.userRegistered` / `identity.passwordChanged` / `identity.trashRetentionChanged` の3種は **consumer が存在せず監査要件も無いので復元しない**（`spec/requirements.md` に監査要件が無いことは `.thread/34/design.md` 第7.3節が確認済み）。

**イベントを定義しないドメインとその理由**

- `memo` / `knowledge` — 変更履歴は `memo_revisions` / `document_revisions` が持つ。projection は同一トランザクション。consumer が無い。
- `search` — projection は同期。**検索用イベントと indexer consumer を置かない**（`.adr/003` / `.adr/005`）。`spec/domains/search.md:232–244` の projection 契機11行は**イベントの候補ではない**ことを表の直後に明記する。
- `trash` — 書き込みポートを持たない原則を維持。期限処理は local job。
- `export` — エンティティを持たず、同期生成（`spec/domains/export.md:289`）。

**ポートは1本も増えない。** relay の `queue.send()` はアダプター内部で、ドメインポートにしない。したがって `spec/domains/index.md:34` / `spec/domains/identity.md:369` の「同期契約の例外は `PasswordHasher` と `MailSender` の2つ」という列挙は**動かない**（`adr.md` AD-5）。

### ユースケース / アプリケーションロジック

**イベント登録口は `UnitOfWorkContext.enqueueEvent(drafts: readonly EventDraft[]): void` の1つに固定する**（`adr.md` AD-5）。`enqueueJob` と同じ形 — 同期・戻り値なし・同じ `transactionSync` の中で行を書く。`EventId` は UoW 実装が `IdGenerator` から採番して付ける。

**UoW コンテキストの副作用登録点（メソッド）は5つになる。**

| メソッド | 書き込み先 | User Data DO | Identity Directory DO |
|---|---|---|---|
| `enqueueJob` | `jobs` | ○ | ○ |
| **`enqueueEvent`** | **`outbox_events`** | **○** | **○** |
| `recordOperation` / `updateOperation` | `operations` | ○ | — |
| `setMigrationCursor` | `migration_progress` | ○ | — |

**非集約ストアのハンドルはもう1つ増える** — `resetThrottleStore`（`reset_request_windows`。Identity Directory DO のみ。`adr.md` AD-16）。**ドメイン側の契約は `PasswordResetThrottlePort`** で、メソッドは `claimWindow(windowKey, now): boolean` の1つだけである（`adr.md` AD-19。`resetTokenStore` / `PasswordResetTokenPort` と同じ「ハンドル名とポート名が別」の形）。`CLAUDE.md:68` の roster はこの2群を分けて書いており、`enqueueEvent` は**登録点**の群へ、`resetThrottleStore` は Identity Directory DO の**ストア**の群（現行は `resetTokenStore` / `rotationCheckpointStore` の2つ）へ入る。

**帰結として、非集約ストアは7つ→9つ、書き込み口は6ストア7メソッド→8ストア9メソッドになる。** 数を書いている実在の行は **`spec/database/index.md` L79 / L749 / L753 / L754 と `spec/domains/identity.md:378` の5行**で、これが全数である（`grep -rn '非集約ストア' spec` は**9ヒット**するが、数を書いているのはこの5行で、**残り4件は分類の話**）。**`CLAUDE.md:68` には数が無い** — 登録点を列挙したうえで `The per-table roster, and its count, lives in spec/database/index.md.` と数の権威を委譲しているので、**列挙に `enqueueEvent` と `resetThrottleStore` を足すだけで、数は書き足さない**（AC-17a / AC-17b）。

**同期 UoW の中で3つを一度に確定できることを契約として書く。** 1つの `transactionSync` の中で、(1) 業務データの書き込み、(2) FTS5 projection の更新、(3) `enqueueEvent` によるイベント行の追加、が起き、**rollback すると3つとも巻き戻る。** これは `spec/usecases/{memo,knowledge,identity}.md` の共通事項に置く（現在は「変更を外部へ通知する経路は持たない」と書かれている箇所）。

**変更するユースケースは `requestPasswordReset` の1つだけ。** `purge-trash` / `resume-link` / `sweep-orphan-mapping` の `enqueueJob` は local job のまま一切変えない。

`requestPasswordReset` の新しい手順（`spec/usecases/identity.md:185, 203–208` の書き換え）:

1. **イベントを発行するか否かは、スロットル窓の状態だけで決める**（`adr.md` AD-7）。窓のキーは `jobs.operation_key` と同じ導出（対象 canonical の全長 HMAC + 依頼の窓）で、**クライアントから受け取らない。** 窓の状態は **Identity Directory DO の `reset_request_windows`**（UoW コンテキストの `resetThrottleStore`。`adr.md` AD-16）が持ち、読み取りと更新（スロットル計上）は `enqueueEvent` と同じ `transactionSync` の中で行う。**`credential_mappings` には載せない** — 未登録 canonical に行が無く、そこへ載せると 2. が構造的に成立しない。
2. **4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）の処理経路を完全に一致させる。** 同じ窓の状態に対して4ケースは一様に落ちる — **その窓での最初の依頼なら4ケースとも必ずちょうど1行**（0行でも2行でもない）、**既に発行済みの窓なら4ケースとも1行も書かない。** 窓ストアの行のほうは**登録の有無に関係なく必ず作る。** 分岐の材料は窓ストアの状態だけであり、クレデンシャルの登録有無・認証方式・宛先の存在を一切参照しない。同じ起床を張り、同じ応答を返す（列挙オラクル対策。この性質は現行から一字も緩めない）。**「4ケースが同じ経路を通る」を spec の要件として明記する。**
3. イベントの payload に載せるのは `tokenId` / メール種別 / **発行元 bucket の routing key**（既に鍵付きハッシュ済みの内部キー）だけ。**メールアドレス・生トークン・`userId` を載せない。** **`tokenId` は nullable にしない** — トークンが発行されないケース（未登録 / SSO 専用）でも、`tokenId` の欄には**宛先の有無から独立に生成した不透明値**を置き、行の形を4ケースで同一に保つ。形が割れると payload そのものが列挙オラクルになる。宛先の有無は送信時に解決する（4.）。
4. 送信材料（宛先・生トークン・`providerIdempotencyKey`）は consumer が発行元 DO へ RPC して取得する。**復号と HMAC 導出は DO の中に閉じたまま**（`adr.md` AD-6）。**応答は `send` / `nothing-to-send` の2分岐で、これが全数である** — 宛先が無い（未登録 / SSO 専用 / 消費済み / 期限切れ）ケースも、より新しい発行に置き換えられているケースも、**理由を1つも載せない同じ `nothing-to-send`** が返る。consumer はどちらでも ack し、`nothing-to-send` は失敗ではない。**呼び出しガード3条件**（(a) event 行が存在する / (b) `quarantined` でない / (c) 不透明な `owner_token` が一致する。**`status` は照合しない**）と**運用値の制約2本**（`DLQ 保持期間 < トークン TTL` / `Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間`）も同時に書く。
5. **同一窓への連打で届くのは「現在有効なトークンのリンク1通」である**（0通でも2通でもない）。窓の中の2回目以降は**イベント行もトークンも書かない** — `PasswordResetTokenPort.issue()` を呼ばないので、**1通目のリンクは2回目の依頼後も有効なままである**（`adr.md` AD-7）。窓をまたいで積まれた古い行は `nothing-to-send` で no-op になる。
6. **窓行を作るのと同じトランザクションで `sweep-reset-tokens` を投入する**（`adr.md` AD-16）。窓行は4ケースすべてで作られるので、**投入も4ケースすべてで起きる。** 宛先の登録有無で投入するかどうかを分けない — 分けると起床の有無が観測可能な差になり、`.adr/010` の「投入点は全数として書く」も破れる。

`MailSender` ポートは残るが、**呼ぶのは Alarm ジョブではなく request Worker の `queue()` ハンドラ（mail consumer）になる**（`adr.md` AD-13）。`spec/domains/identity.md:612–624` にその旨を書く。

### アダプター / 永続化 / 外部連携

#### `outbox_events` の schema（両 DO クラス共通）

| カラム | 型 | 制約 | `jobs` との関係 |
|---|---|---|---|
| `id` | TEXT | PK。`EventId`。`IdGenerator` が採番する**不変**の値 | `jobs.operation_key`（同一性で収束）と**対照的**。イベントは収束しない |
| `type` | TEXT | NOT NULL。`event.type` | `jobs.kind` に対応 |
| `payload` | TEXT | NOT NULL。JSON。**PII および再利用可能な秘密を入れない** | `jobs.payload` と同じ制約 |
| `aggregate_id` | TEXT | NOT NULL | — |
| `occurred_at` | INTEGER | NOT NULL。ドメインが決めた発生時刻 | — |
| `created_at` | INTEGER | NOT NULL。**行が Outbox に載った時刻**。backlog の滞留時間を読む起点はこちらで、`occurred_at` では代用できない（ドメインが過去の時刻を入れうる） | — |
| `attempt` | INTEGER | NOT NULL | **同名・同意味** |
| `next_run_at` | INTEGER | nullable。終端行では `NULL` | **同名・同意味** |
| `status` | TEXT | NOT NULL, CHECK (`pending`,`publishing`,`published`,`quarantined`) | 形は同じ・**名前は別**（`published` は「Queue へ渡した」であって「処理された」ではない） |
| `lease_until` | INTEGER | nullable | **同名・同意味** |
| `owner_token` | TEXT | nullable。finalize は CAS で照合し、**送信材料 RPC の呼び出しガード (c) の照合材料でもある。終端（`published` / `quarantined`）へ落とすときも `NULL` にしない** | 名前は同じだが**意味の射程が広い**。`jobs` は終端時に `NULL` にする |
| `terminal_reason` | TEXT | nullable。**PII と秘密を入れない**（運用者が読む） | **同名・同意味** |
| `completed_at` | INTEGER | nullable。`published` / `quarantined` へ落ちた時刻 | **同名・同意味** |

**13列である。** `provider_idempotency_key` は**どちらの表にも置かない** — provider へ渡すキーは `event.id` から DO が導出し、送信材料 RPC の応答に載せて consumer へ渡す（`adr.md` AD-8）。`dedupe_key` も置かない — 連打の抑止はスロットル判定が担い、表は例外なく「1イベント1行・不変」である（`adr.md` AD-7）。

索引:

| 名前 | 定義 | 用途 |
|---|---|---|
| `outbox_runnable_idx` | (`status`, `next_run_at`) WHERE `status IN ('pending','publishing')` | claim と Alarm の張り直し |
| `outbox_lease_idx` | (`lease_until`) WHERE `status = 'publishing'` | DO がリセットされた行の回収 |
| `outbox_completed_idx` | (`status`, `completed_at`) | 保持期間を過ぎた `published` の prune |

**3本である**（部分 UNIQUE 索引は無い。`jobs` の3本と1対1で対応する）。

- OCC の `version` は持たない（非集約ストア）。
- `user_id` 列は持たない（構造的テナント分離）。**ただし配送メッセージは宛先 DO の routing key を運ぶ** — DO の識別子が DO の外へ出る唯一の点なので、それが `.adr/002` の「正規化値を鍵付きハッシュした内部キー」であることを明記する。
- 保持期間は `published` と `quarantined` で別に持つ。`quarantined` は運用者の検査のために残す（`spec/database/index.md` の pruner の既存方針と同じ態度）。**`published` の保持期間には下側の制約が掛かる — `Queue の最大 retry 期間 + DLQ の保持期間 ≤ published の保持期間`。** 送信材料 RPC のガードが行の存在を要求する（`adr.md` AD-6 の (a)）ので、prune が行を消した後の DLQ 再駆動は必ず `nothing-to-send` になる。**上側の制約（`DLQ 保持期間 < リセットトークン TTL`）だけを書くと、値の決定者（#38）が両立しない2値を選べてしまい、再駆動が恒久的に空振りする形が運用上ほぼ検出できない。**
- **終端時に `NULL` にする列は `lease_until` / `next_run_at` の2つだけである。** `jobs` は `owner_token` も `NULL` にするが、`outbox_events` は**残す**（上表）。**これは AD-2 が言う「分離する規約」の1つとして、共通化する規約（Alarm scheduler / backoff / lease / prune）と並べて明示的に列挙する**（AC-15）。落とすとガード (c) が `published` の行に対して必ず失敗し、正常系の配送が全滅する。

#### `jobs` 側の変更

- `send-mail` を `kind` から削除 → **11種（User Data 6 / Identity Directory 5）**。**スロットル窓ストアの掃除は既存の `sweep-reset-tokens` の作業述語を広げて担うので、新しい `kind` は増えない**（`adr.md` AD-16）。11種は改訂の前後で確定値である。
- `provider_idempotency_key` 列を削除 → **11列**（`adr.md` AD-8）。あわせて「**この表に外部 I/O を伴う `kind` は存在しない**」を新しい不変条件として書く。
- 収束規則 (3) の「残る7種」→「残る6種」。再武装する5種は不変。**規則 (3) を置いている唯一の具体例が `send-mail` の同窓連打なので、例示を差し替える** — 規則自体は `resume-*` / `finalize-withdrawal` の重複依頼に効くので残す。
- 「ユースケースから投入する8種」→「**7種**」（`send-mail` が抜ける。残る4種は不変）。
- `kind` の全数表を `spec/async/index.md` へ移設し、ここは参照にする（`adr.md` AD-11）。**`CLAUDE.md` 側の全数列挙も落とす**ので、「`kind` を足したら両方の表を同時に直し」は「`spec/async/index.md` の全数表を直す」の1本になる（`adr.md` AD-14）。

#### Alarm 多重化（`adr.md` AD-4）

```
setAlarm( min(
    min(jobs.next_run_at)          WHERE status IN ('pending','running'),
    min(outbox_events.next_run_at) WHERE status IN ('pending','publishing')
) )
※ lease 中の行（running / publishing）は max(next_run_at, lease_until) で算入する
両方が空のときだけ deleteAlarm()
```

lease の算入規則を明示するのは、**claim の CAS が `lease_until` の満了を要求する**（`spec/database/index.md:459` の第2選言）ため、過去の `next_run_at` を持つ leased 行だけが残った状態で `next_run_at` をそのまま採ると「起床 → 1行も claim できない → 同じ過去時刻へ張り直す」の空転になるからである。**`jobs` 側に既にある曖昧さなので、両表へ同じ形で確定させる**（`adr.md` AD-4）。

`alarm()` の中の順序（`spec/database/index.md:703` の既存3段を4段へ拡張）:

1. Alarm の再武装 + 永続化の確認
2. migration ゲート（fail-closed。**`await` ゼロの同期関数なので relay はここに入れられない**）
3. **(a) outbox relay パス** → **(b) jobs パス**。件数上限は各パスが独立に持ち、**毎回の起床で両方を必ず1回通す**（片方の滞留がもう片方を飢えさせない）
4. 両表から再計算して張り直す

relay の1パスは3相で、**Queue への送信だけがトランザクションの外**:

1. `transactionSync`: 実行可能な行を上限件数まで claim（`publishing` + `lease_until` + `owner_token` を CAS）
2. トランザクション外: Queue へ publish
3. `transactionSync`: `published` へ落とす／失敗なら `attempt` を進め backoff で先送り／上限超過は `quarantined` + `terminal_reason`

**at-least-once の根拠**: 相 2 と 3 のあいだで DO がリセットすると、lease 満了後に同じ行が再 claim され再 publish される。**`alarm()` から throw しない**規則は relay パスにも掛かる。**fail-closed で止まっている DO は relay もしない**（ゲートで戻る）ため outbox 行が滞留するが、**失われた配送ではない。**

#### Queue / consumer / DLQ（`adr.md` AD-9 / AD-10 / AD-13）

**受け入れ条件6（配送機構の契約と責務）の記述点はここで、書き込み先は `spec/async/index.md`（ステップ3）である。** 内訳は5つ。

- **Queue メッセージの契約.** 載せるのは `event.id` / `type` / `payload` / **宛先 DO の routing key**（送信材料 RPC の宛先を選ぶための鍵付きハッシュ済み内部キー）。**PII と再利用可能な秘密は載せない。** メッセージは `outbox_events` の行の写しであり、Queue 側で組み立て直さない。
- **consumer の一覧と責務.** 初期は **mail consumer の1つだけ**である。責務は「送信材料 RPC を打ち、`send` なら provider を呼ぶ／`nothing-to-send` なら no-op する」だけで、宛先の解決・トークンの生存確認・冪等キーの導出はすべて DO 側にある。**業務判断を1つも持たないので、層としてはアダプターである**（`adr.md` AD-17。relay と DLQ ハンドラも同じ）。
- **consumer の置き場は request Worker の `queue()` ハンドラ**（`adr.md` AD-13）。Worker は request / state の2本のままで、DLQ ハンドラも同じ Worker に置く。**メール provider の秘密の帰属が state Worker から request Worker へ移る**ことを `.adr/013` の影響に書く（`apps/web/.dev.vars.example` の実際の追記は #51。本 Issue は `apps/web/` に触らない）。
- 配送は **at-least-once・順序保証なし**。consumer は `event.id` を基準に冪等化する。**冪等性キーの保持先は consumer ごとに全数表で宣言する。** 初期の mail consumer は保持せず、(i) `event.id` から DO が導いた `providerIdempotencyKey` を provider へ渡す、(ii) 送信材料 RPC がトークンの生存と supersede を再確認する、の2段で冪等化する。
- **責務分界は「Queue に入る前か後か」の1本。** publish できない失敗は発行元 DO の `quarantined`、consumer の失敗は Queue の retry → DLQ。**発行元 DO へ ack を書き戻さない。** operator 導線は2つ — DO の maintenance 経路（quarantine の一覧・再駆動）と DLQ ハンドラ。
- **fail-closed の DO と DLQ の相互作用を1行書く.** fail-closed になる**前に** publish 済みのメッセージは Queue に残っており、consumer がそれを処理しようとすると送信材料 RPC が migration ゲート（`spec/database/index.md:699` により全 RPC エントリの先頭に掛かる。例外は診断2本だけ）で `SystemError` を返し、retry を焼き切って **DLQ へ落ちる**。デプロイのスキュー期間に限られるが、**DO 側の滞留が「失われない」のとは非対称な挙動**なので両方書く。復旧は DLQ の再駆動。

### UI / プレゼンテーション

**影響なし。** `spec/pages/` と `spec/design/` に非同期・Outbox・job の言及は1件も無い。`spec/inventory/frontend.md` にも該当行が無い。リセットメールの到達が非同期になることは画面の状態に現れない（応答は従来どおり「登録されていれば送信された」旨のみ）。

---

## 実装ステップ

依存方向の順（内側のレイヤーが先）に並べる。ステップ1〜2は ADR（すべての正本）、3が新しい正本の骨格、4〜5が物理、6〜11が内側から外側、12〜18が台帳とテストと目次、19が規約、20〜22が同期と検証。

> **行アンカーの扱い（全ステップ共通）.** 本書の行番号は計画時点の `main` に対する実測値であり、**編集を始めた時点から順にずれていく。各ステップに着手するときは、必ず `grep -n` で対象行を取り直してから編集する。** 特に**ステップ4 と5 は同じ `spec/database/index.md` を続けて編集する** — ステップ4 がテーブル一覧に3行、`### outbox_events` ×2 と `### reset_request_windows` の3節を挿入するので、**ステップ5 が挙げる L428 以降のアンカーはその時点では別の行を指している。** 本書はステップ5 の各アンカーに内容の説明を併記してあるので、**行番号ではなく併記された検索文字列（`同じ12列` / `残る7種` / `ユースケースから投入する 8 種` など）で対象を特定すること。** 順序を入れ替えて5→4 で実行してもよいが、その場合はステップ5 の中で `outbox_events` を参照している箇所（Alarm 多重化・prune・fail-closed）が未定義の表を指す形になるので、**参照だけを後追いで足す**必要がある。

### 1. 新 ADR `.adr/013` を書く

- **対象ファイル:** `.adr/013-do-local-outbox-and-alarm-relay.md`（新規）
- **変更内容:** 既存 `.adr/*` と同じ節構成（`# 013. …` / `## ステータス` / `## コンテキスト` / `## 決定` / `## 検討した代替案` / `## 影響`）で書く。
  - ステータス: 承認済み。**`.adr/004` の決定の第3項（ドメインイベント transport の廃止）と対応する影響、および第2項のうち「外部 I/O を伴う処理は必ずこちらに載る」という十分条件を supersede する。永続ジョブと Alarm という機構そのもの、および第1項（ローカル同期コミット）は supersede しない。** `.adr/002` の DO 集約と `.adr/003` の FTS5 単独検索と `.adr/005` の projection をトランザクション内で行う決定は**維持する**と明記。
  - 決定: `adr.md` の AD-1（3類型の判定規則。**規則2の「独立」は実行責任の独立であって Worker の物理分離ではない**）/ AD-2（`outbox_events` を別表に）/ AD-3（両クラスに置く）/ AD-4（1本の Alarm で多重化。relay を `jobs.kind` にしない。lease 中の行の算入）/ AD-5（`enqueueEvent`。relay をポートにしない）/ AD-6（送信材料 RPC。**応答は `send` / `nothing-to-send` の2分岐で理由を載せない**。**呼び出しガード3条件で `status` は照合しない**。運用値の制約2本）/ AD-7（**`dedupe_key` を置かない。連打の抑止はスロットル判定、最新性は送信時再読。窓が消費済みならトークンも発行しない**）/ **AD-16（スロットル窓は Identity Directory DO の `reset_request_windows`。掃除も**投入点も** `sweep-reset-tokens` に同居させ `jobs.kind` を増やさない。`credential_mappings.last_reset_requested_at` を落とす）** / AD-9（冪等性キーは consumer ごと）/ AD-10（quarantine と DLQ の分界）/ AD-11（全数表の所在）/ AD-13（consumer は request Worker の `queue()`。Worker は2本のまま）/ AD-14（**全数表の正本は1箇所。`CLAUDE.md` は判定規則と参照だけ**）/ **AD-17（relay / mail consumer / DLQ ハンドラの層帰属はアダプター）** / **AD-18（前方互換点は3本のまま）** / **AD-19（窓ストアのドメイン契約は `PasswordResetThrottlePort.claimWindow` の1メソッド）** を決定として書く。**AD-20（マニュアルテストの追加先）/ AD-21（`CLAUDE.md` から #37 の識別子を落とす）/ AD-22（無限定の断言の検査方法）は本 Issue の作業手順に閉じた判断なので `.adr/013` へ昇格させず、`adr.md` にだけ残す。**
  - 検討した代替案: Issue 本文が要求する4案を全部書く — (1) 各業務 DO に Outbox + Alarm relay（**採用**）/ (2) 専用 Outbox DO へ RPC でイベントを書く（**業務更新と原子的に書けない**ので不採用）/ (3) すべて `jobs` + Alarm（`.adr/004` の現行案。**実行責任の所有者の違いが表現できない**ので不採用）/ (4) 業務 transaction の中で外部 I/O（**同期 transaction に外部障害を持ち込む。`transactionSync` は `fetch` を呼べない**ので不採用）。加えて AD-4 の「relay を `jobs.kind` にする」案、**AD-7 の `dedupe_key` 案（撤回した旧案として、撤回理由まで書く）**、**AD-6 の3分岐応答案（`superseded` / `no-recipient` を分ける旧案。DO 側で区別できず、区別できること自体が列挙オラクルになるので撤回した）**、**AD-16 の「`credential_mappings.last_reset_requested_at` に相乗りさせる」案（未登録 canonical に行が無く4ケース一様が崩れる）と「窓の掃除に新しい `jobs.kind` を足す」案（11種が12種へ動く）**、AD-13 の「consumer を3本目の Worker にする」案も書く。
  - 影響: `jobs` から外部 I/O が消えること / **非集約ストアが9つになること**（`outbox_events` + `reset_request_windows`）/ 全数表が `spec/async/index.md` へ移ること（**`.adr/010` について宣言する失効範囲は2項** — 「正本の表」の所在の変更と、「外部プロバイダへ渡す冪等キーの導出は生成 ID では成立しない」という項の帰属変更。後者は AD-8 で `jobs` の関心事でなくなり、新しい導出元が生成 ID である `event.id` なので論法が反転する）/ **`CLAUDE.md` から `kind` の全数列挙が消え、`spec/database/index.md:485` の「両方の表を同時に直す」義務が1本になること**（AD-14）/ **consumer が秘密を扱う実行主体になり、メール provider の秘密の帰属が state Worker から request Worker へ移ること**（AD-6 / AD-13。`.dev.vars.example` の追記は #51）/ **AD-6 の RPC 往復によって判定規則2の根拠が細ること**（consumer が担うのは provider 呼び出し1回だけ。全数表の `send-mail` 行の差し戻し条件と対にする）/ **`.thread/34/design.md` の失効宣言は5節で、これが全数であること**（plan.md「含まれないもの」の同じ列挙と一致していなければならない） — 第7.3節（廃止範囲。`.adr/004` L40 が名指し）/ **第7.4節（`jobs.kind` 12種の全数表。`.adr/004` L24 が名指しするので、宣言を落とすと `.adr/004` から辿って生きた表に見える）** / **第7.6節（外部 I/O を永続ジョブに残す境界。**部分失効**。境界の規則「トランザクションの中で外部 I/O をしない」とメール送信の所有者が Identity Directory bucket であること・生トークンをジョブ行に載せないことは**有効**。失効するのは行の書き方と収束の手段の3点 — 「登録の有無によらず**ダミージョブ行を書く**」「**スロットル中でもジョブ行は必ず書く**」「同じ canonical への連打は **`operationKey` でジョブ行1本に収束する**」。置き換えるのは AD-6 / AD-7 / AD-16 である。`.adr/004` から名指しされていないので「ADR から辿れる範囲」では漏れるが、**宣言を落とすと #51 の実装者が作業ログを読んで旧機構をそのまま実装する導線が残る** — 第1.4節と同じ実害基準で入れる）** / 第7.7節（契約の正文。`.adr/004` L24 が名指し）/ **第1.4節（機械検査の期待値「`jobs` は12列」「`kind` は各クラス6種・合計12種」「4類型が12種を1回ずつ覆う」。宣言を落とすと後で検査を回した人が全部赤を見る）**（`adr.md` AD-12）/ at-least-once と重複配送を受け入れること / PITR の巻き戻しが再配送になること / **スロットル窓ストアの新設で Identity Directory DO のテーブルが2つ増えること**（`adr.md` AD-16）。
- **理由:** 過去 ADR を改変せず履歴を残すという Issue の要求を満たしつつ、以降のすべてのステップの根拠を1箇所に置く。

### 2. `.adr/004` と `spec/adr/005` のステータス節に注記を足す

- **対象ファイル:** `.adr/004-do-local-commit-and-alarm-jobs.md`（L3–7 のステータス節）/ `spec/adr/005-search-index-via-outbox.md`（L3–5 のステータス節）
- **変更内容:**
  - `.adr/004`: 「決定の第3項（ドメインイベント transport の廃止）と影響の対応する項、および**第2項（L24）のうち『外部 I/O を伴う処理は必ずこちらに載る』という十分条件**は `.adr/013` が supersede する。**永続ジョブと Alarm という機構そのものと、第1項（ローカル同期コミット）は有効である。** 第2項が名指しする `.thread/34/design.md` 第7.4節（載る処理の全数）も失効し、全数は `spec/async/index.md` が持つ」を2〜3行で追記。**「第2項は有効」とだけ書かないこと** — AD-1 の Consequences が自ら失効を認めている十分条件が第2項に入っているので、AD-12 が防ごうとしている破れが今回訂正した当の論点で起きる。**コンテキスト・決定・検討した代替案・影響の各節は1文字も変えない。**
  - `spec/adr/005`: 「検索インデックスの更新方式が superseded であることは変わらない。**本 ADR を検索 indexer consumer の復活根拠に使わない。** Outbox 機構そのものの廃止（`.adr/004`）は `.adr/013` が訂正した」を追記。
- **理由:** `adr.md` AD-12。どの ADR から読み始めても失効した決定に到達しないようにする。`spec/adr/005` が既に同じ形を採っている先例に揃える。

### 3. `spec/async/index.md` を新設し、3類型の判定規則と全数表を置く

- **対象ファイル:** `spec/async/index.md`（新規）
- **変更内容:**
  - 上流参照（`.adr/013` / `.adr/004` / `.adr/010` / `spec/database/index.md` / `spec/domains/index.md`）。
  - **判定規則**（`adr.md` AD-1 の3段を順序つきで）。「外部 I/O であること」「cross-DO RPC であること」が単独では Outbox の条件にならないことを、`resume-*` / `finalize-withdrawal` / `sweep-orphan-mapping` を例に明記する。**分類の変更には実行責任の所有者に基づく理由が要る**ことを規則として書く。
  - **全数表.** 欄は「識別子 / **由来（旧 `jobs.kind`）** / 類型 / owner DO クラス / 実行責任者 / 発行点・投入点（全数） / consumer / fan-out 有無 / payload / 冪等性キーとその保持先」。行は (i) 同期実行（FTS5 projection / retention のハードデリート / saga phase 前進 / `purge_after` の一括再計算）、(ii) Outbox event（`identity.passwordResetRequested`）、(iii) local job 11種。**`spec/database/index.md` L470–483 の投入点欄をここへ逐語で移す**（`.adr/010` の I-1 を落とさない）。
  - **「由来」欄は AC-8 の判定材料である。** Outbox 行の識別子は `identity.passwordResetRequested` であって `send-mail` ではないので、識別子欄では受け入れ条件12（初期分類）と突き合わせられない。**Outbox 行の由来欄に `旧 send-mail` と書き**、local job 11種の由来欄は自分自身の名前にする。判定は「**旧 `jobs.kind` 12種の集合 == 由来欄の集合**」の1本で行う。ステップ3・21 で「`send-mail` の行」と呼んでいるものは、この由来欄が `旧 send-mail` である行を指す。
  - **`sweep-reset-tokens` の用途欄と投入点欄の両方を広げる**（`adr.md` AD-16）。用途欄は「期限切れのリセットトークン行の削除と、期限切れの窓（`reset_request_windows`）の行の削除」へ。**投入点欄は「リセットトークン行を発行するのと同じトランザクション」から「リセットトークン行**または窓行**を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」へ。** 投入点を旧文言のまま移設すると、(a) 未登録アドレスだけを投げられた bucket で掃除ジョブが一度も投入されず窓行が単調増加し、(b) `enqueueJob` を呼ぶか否かが登録有無で分岐して4ケースの起床が割れる。**宛先の登録有無で投入を分けない。** `jobs.kind` を増やさない代償として、1つの `kind` が2目的を持つことを表の側に明示する。
  - **User Data DO のイベント型が0件であることを表の中に明示的な行として書く**（`adr.md` AD-3。表を置いたことを「consumer 不在のイベントを定義した」と読み違えられないため）。**この行は識別子欄も由来欄も持てないので、ステップ21 の集合演算（検査 2 / 4 / 5 / 15）から明示的に除外する**旨を表の直後に1行書く。書かないと、検査を書く人が0件行を集合に入れて空文字列のズレを踏む。**除外対象はこの1行だけで、それが全数である。**
  - **routing key の将来の扱いを1行で断つ**（潜在的な矛盾を先に閉じる）。Queue メッセージが運ぶ「宛先 DO の routing key」は、Identity Directory 宛では鍵付きハッシュ済みの内部キーなので payload の禁止項目（`userId`）と衝突しない。**しかし User Data DO のイベントを足すと、その routing key は `userId` そのものになりうる。** 初期のイベント型は0件なので今は潜在的だが、「**User Data DO のイベントを足すときは、routing key の扱い（`userId` を Queue に載せるか、別の不透明キーへ写すか）を同時に決める**」を規則として1行残す。後任が禁止項目の文面だけを読んで踏むことがなくなる。
  - **不変条件**: すべての `event.type` と `jobs.kind` がちょうど1回現れる / 発行点・投入点の欄が空でない / consumer 欄が空のイベントは存在しない / 同じ処理が Outbox と `jobs` へ二重登録されない。
  - **payload と `terminal_reason` の衛生規則**: PII と再利用可能な秘密を入れない。ログにも出さない。**保証範囲は「載らない・永続化されない」であって「DO の境界を出ない」ではない**（宛先と生トークンは送信材料 RPC の応答として境界を越え、配送の瞬間だけ consumer のメモリに載る。`adr.md` AD-6）。
  - **配送の性質**: at-least-once / 順序保証なし / exactly-once を前提にしない / イベント間の順序に依存する設計を書かない。
  - **送信材料 RPC の応答の全数**: `send` / `nothing-to-send` の2分岐。**`nothing-to-send` は理由を1つも載せない空である**（`adr.md` AD-6）。consumer はどちらでも ack し、`nothing-to-send` は失敗ではない。**「なぜ送らなかったか」を consumer 側に残さない** — 応答は consumer のログにも DLQ にも落ちうるので、理由を載せると宛先の登録有無が DO の外へ漏れる。運用の追跡が要るなら DO 側の観測に閉じる。**呼び出しガード**も同じ節に書く（`adr.md` AD-6）— 応答が `send` になるのは **(a) その `event.id` の行が存在し (b) `quarantined` でなく (c) 呼び出しが持つ不透明な `owner_token` が行の値と一致する**ときだけである。**`status` は照合条件に入れない** — at-least-once では consumer が RPC を打つのは relay が `published` へ落とした後なので、`status='publishing'` を条件にすると正常系の配送が全滅する。**二重送信の抑止は `status` ではなく `providerIdempotencyKey` が担い、役割を混ぜない**（この一文を落とすと、後任が「二重送信対策として `status` を足す」に戻る）。あわせて**運用値の制約2本**（`DLQ 保持期間 < リセットトークン TTL` / `Queue 最大 retry + DLQ 保持期間 ≤ published 行の保持期間`。値の確定は #38）を書く。
  - **配送機構の契約と責務**（**受け入れ条件6 の記述点。AC-34**）: (a) Queue メッセージに載せるもの／載せないもの、(b) consumer の一覧と各 consumer の責務（初期は mail consumer 1つ）、(c) **consumer の置き場が request Worker の `queue()` ハンドラであること**（`adr.md` AD-13）、(d) DLQ の扱いと operator 導線2本、(e) **fail-closed の DO へ送信材料 RPC を打った consumer が DLQ へ落ちること**（デプロイのスキュー期間限定。復旧は DLQ の再駆動）。実体は上の「Queue / consumer / DLQ」節が持つ。
  - **`CLAUDE.md` との役割分担を1段落で宣言する**（`adr.md` AD-14）: **全数表を持つのは本ファイルだけ**であり、`CLAUDE.md` は判定規則と本ファイルへの参照だけを持つ。`spec/database/index.md` は物理形だけを持つ。**`kind` / `event.type` を足すときに直すのは本ファイルの表1つである。**
  - **P-001 の差し戻し条件**（plan.md 未解決事項）を `send-mail` の行に注記として残す。**AD-6 の RPC 往復が判定規則2の根拠を細らせている事実と対にする** — 後任が「なぜこの分類なのか」を判断材料つきで再評価できるようにするため。
- **理由:** `adr.md` AD-11。全数表を1箇所に置き、`spec/database/index.md` を物理形に専念させる。

### 4. `spec/database/index.md` に `outbox_events` を定義する

- **対象ファイル:** `spec/database/index.md`
- **変更内容:**
  - `### jobs（Identity Directory DO）`（L652）の直後、または `### jobs` の直後に **`### outbox_events`** と **`### outbox_events（Identity Directory DO）`** を新設し、上の「アダプター / 永続化」節の schema と索引をそのまま書く。共通化する規約（Alarm scheduler / backoff / lease / prune）と分離する規約（同一性と収束の有無 / 配送状態の値域）を明示的に列挙する（AC-15）。
  - **テーブル一覧（L34–56）** に**3行**追加 — `outbox_events`（User Data）/ `outbox_events`（Identity Directory）/ **`reset_request_windows`（Identity Directory）**。L48 / L54 の「Alarm ジョブ（6種）」を「（6種）」「（5種）」へ訂正。**改訂後の実カウントは User Data 17 / Identity Directory 7**（現在値は L36–51 の16行 / L52–56 の5行。実カウント済み）。
  - **L11**（同じ形のテーブルが両クラスに現れる）に `outbox_events` を追加。
  - **L18**（テナント分離）に「`outbox_events` は `user_id` を持たない。ただし配送メッセージは宛先 DO の routing key を運ぶ」を追加。
  - **L20**（10 GB の数え方）に `outbox_events` と `reset_request_windows` を、**L29**（書き込みの単位）に `outbox_events` を追加。**L29 は「業務データ・FTS5 projection・Outbox 行が同じトランザクションに入る」という AC-12 の1つ目の記述点である。**
  - **L24**（ID 生成の例外2つ）に2点。(i)「`outbox_events.id` は生成 ID なので例外は増えない」を確認として1文。(ii) **例外 (b) の論拠から `provider_idempotency_key` を落とす** — 現行の「`IdGenerator` で採番すると `jobs` の収束規則3つと `provider_idempotency_key` の決定的な導出がどれも成立しない」の後半は AD-8 で失効する。**例外の数は2つのまま、論拠を収束規則だけへ絞り直す**（同文が `spec/inventory/adapter.md:23` にもあるのでステップ14で同時に直す）。
  - **L740–755（OCC 表）**: 「持たない（非集約ストア**9つ**）」へ。**数を書いている行は L79 / L749 / L753 / L754 の4行で、これが `spec/database/index.md` 内の全数である**（`grep -n '非集約ストア' spec/database/index.md` で確認済み。L79 は `account` が非集約ストア7つに入らないことを言う行で、ここも「9つ」になる）。L753 / L754 の「7つ」「6ストア・7メソッド」を「**9つ**」「**8ストア・9メソッド**」へ。書き込み口の列挙に **`enqueueEvent`（`outbox_events`）と `resetThrottleStore`（`reset_request_windows`）の2つ**を追加（`adr.md` AD-16）。**`_meta` だけが口を持たない、という文は動かさない。**
  - **L757–759（operator 専用 maintenance 経路）**: quarantine の一覧と再駆動のエントリを追加。`jobs.kind` に入らないこと（RPC であること）を既存の書き方に揃える。**L759 の「`jobs.kind` の12種には入らない」を「11種」へ**（`send-mail` の離脱に連動する数え上げ。ステップ5 と同時に直す）。
  - **L736（PITR）**: 巻き戻すと `published` が `pending` に戻り再 relay で重複配送になることをチェックリストへ追加。
  - **L793 / L798（リレーション図）**: 「FK なし。共通基盤」の行へ `outbox_events` を追加。
  - **L810–833（主要クエリと索引の確認表）**: relay の claim（`outbox_runnable_idx`）/ lease 満了行の回収（`outbox_lease_idx`）/ prune（`outbox_completed_idx`）の**3行**を追加（dedupe 索引は置かないので dedupe の行は無い）。
  - **L763–764（本ファイルで定義しないテーブル）**: `outbox_events` はここに逃がさず本ファイルで定義する。**L764 の #37 参照（検索カーソルの物理形）を #51 へ付け替える**（ステップ5 の #37 棚卸しに含む）。
  - **`### reset_request_windows`（Identity Directory DO）を新設する**（`adr.md` AD-16。**置き場は計画段階で確定済みであり、実行中に決め直さない** — 決め直すと同時修正リストの数が条件付きで崩れる）。
    - 列: `window_key`（TEXT PK。対象 canonical の全長 HMAC + 依頼の窓から決定的に導く。**クライアントから受け取らない**）/ `key_generation`（INTEGER。HMAC 鍵の世代）/ `first_requested_at`（INTEGER NOT NULL）/ `last_requested_at`（INTEGER NOT NULL）/ `expires_at`（INTEGER NOT NULL。窓の終端 + 猶予）。**生のメールアドレスも SSO subject も持たない**ので PII は増えない。
    - 索引: `rrw_expires_idx`（`expires_at`）。`sweep-reset-tokens` が期限切れ行を掃除するときに引く（`prt_expires_idx` と同じ役割・同じ形）。
    - **登録の有無に関係なく行を作る。** 4ケースのどれでも同じ1文で読み、同じ1文で書く。行の有無が観測可能な差にならないことが、この表を新設した理由そのものである。
    - OCC の `version` は持たない（非集約ストア）。**書き込み口は UoW コンテキストの `resetThrottleStore` の `claimWindow` ただ1つであり、これが全数である**（`password_reset_tokens` の節が採っている書き方に揃える）。**「読み」と「計上」を2つの書き込み箇所として数えない** — 判定と計上は1回の呼び出しで原子的に行われる（`adr.md` AD-19）。ドメイン側の契約名は `PasswordResetThrottlePort`（`spec/domains/identity.md`。ステップ7）。
    - **DDL 分類は単発適用**（`CREATE TABLE` + 空テーブルへの索引。L707–709）。
  - **`credential_mappings` から `last_reset_requested_at`（L582）を落とす**（`adr.md` AD-16）。唯一の占有者が `reset_request_windows` へ移るので、残すとスロットルの権威が2箇所にある誤読の導線になる。**列削除なので DDL 分類は L708 の「データ量に依存する（分割か回避が要る）」の (i) 側**であり、`outbox_events` / `reset_request_windows` の追加（単発適用）とは型が違う。同文の列挙が `spec/inventory/adapter.md:27`（濫用抑止の3列）にもあるのでステップ14 で同時に直す。
- **理由:** 物理形の正本は `spec/database/index.md`（L7）。閉じた数え上げが多数あるので、表の追加と同時にすべて直さないと `.thread/34/design.md` 第1.4節が記録した破れが再発する。

### 5. `spec/database/index.md` の `jobs` 節と Alarm 契約を改訂する

- **対象ファイル:** `spec/database/index.md`
- **変更内容:**
  - **L428**（「Alarm ジョブの多重化テーブル」「同じ12列」）: **2つの表を1本の Alarm で多重化する**説明へ拡張。列数を11へ。
  - **L441**: `provider_idempotency_key` 列を削除し、**どちらの表にも置かず、provider へ渡すキーは `event.id` から DO が導出して送信材料 RPC の応答で渡す**旨を1行残す（`adr.md` AD-8）。「**この表に外部 I/O を伴う `kind` は存在しない**」を不変条件として追加。
  - **L453**（「書き込み口は `enqueueJob` だけ」）: `outbox_events` の口は `enqueueEvent` であり、別表なのでこの断言は `jobs` について維持されることを明記。
  - **L457 / L486**（収束規則 (3) と再武装の「残る7種」）: 「残る**6種**」へ。再武装する5種は不変。**L457 は数だけでは足りない** — 規則 (3) を置いている唯一の具体的根拠が「復活させると `send-mail` の同窓連打で起床回数と書き込み行数が依頼回数に比例して増える」であり、`send-mail` が `jobs` から出ると**存在しない `kind` を根拠にした文になる**。規則自体は残す（`resume-*` / `finalize-withdrawal` の重複依頼に効く）ので、**根拠の例示を残る6種のいずれかへ差し替えるか、「かつて `send-mail` がその例だった」と過去形にする**。
  - **L459–463**（CAS / backoff / 3階層の上限 / チャンク上限での lease 解放）: relay に同じ規約を適用すること、ただし **Queue send はトランザクションの外**であること、relay パスは独立の件数上限を持つことを追加。
  - **L464**（prune 専用の `kind` は置かない）: outbox の prune も同じ末尾処理に載せる旨を追加。**あわせて `published` 行の保持期間の下側制約（`Queue の最大 retry 期間 + DLQ の保持期間 ≤ published の保持期間`）を運用値の制約として1行書く**（`adr.md` AD-6 の 4.）。送信材料 RPC のガードが行の存在を要求するので、prune が行を消した後の DLQ 再駆動は必ず空振りする。**上側の制約（`DLQ 保持期間 < リセットトークン TTL`）と対で書く** — 片方だけだと両立しない2値を選べてしまう。
  - **終端時の列の扱いに例外を1つ書く**（`adr.md` AD-6 の 2.）。L460 付近の「`done` / `poison` のどちらへ落とすときも `lease_until` / `owner_token` / `next_run_at` を `NULL` にする」は `jobs` の規則であり、**`outbox_events` では `owner_token` を `NULL` にしない**（送信材料 RPC の照合材料として終端後も残す）。`outbox_events` 節（ステップ4）と同じ文言で、共通化する規約と分離する規約の列挙に載せる。
  - **`sweep-reset-tokens` の責務と投入点の両方を広げる**（`adr.md` AD-16）。責務は「期限切れのリセットトークン行の削除**と、期限切れの窓行（`reset_request_windows`）の削除**」へ。**投入点は「リセットトークン行を発行するのと同じトランザクション」→「リセットトークン行**または窓行**を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」へ。** **新しい `jobs.kind` は足さない**ので 11 種は動かない。`password_reset_tokens` 節（L644 の `prt_expires_idx` の用途欄）と `reset_request_windows` 節（`rrw_expires_idx`）の両方から同じ `kind` を指す形になることを明記する。**投入点を旧文言のまま移設してはならない** — トークンが発行されるのは4ケースのうち1つだけなので、(a) 未登録アドレスだけを投げられた bucket では掃除ジョブが一度も投入されず窓行が 10 GB 上限へ向かって単調増加し、(b) `enqueueJob` の呼び出しが登録有無で分岐して4ケースの起床が割れる。`.adr/010` の「正本の表と各投入ユースケースの両方に書く」に従い、**同じ1文をステップ3（全数表）・本ステップ（物理）・ステップ8（ユースケース）の3箇所へ落とす。**
  - **L466–488（`kind` の全数）**: 表本体を削除し、「**全数は `spec/async/index.md` が持つ**」への参照へ置き換える。L468 は**2箇所**直す — 「12種で、所有 DO クラスごとに6種ずつ」→「11種（User Data 6 / Identity Directory 5）」と、「**ユースケースから投入する 8 種**」→「**7種**」（`send-mail` はその8種の1つ。残る4種 = `reindex` / `migrate-bulk` / `rotate-encryption` / `finalize-withdrawal` は不変）。あわせて同行末尾の「投入点は #37 が DO の RPC 側で決める」を **#51** へ付け替える。`send-mail` 行（L478）を落とす。L485 の「**類型は4つで、12種を漏れなく1回ずつ覆う**」を **3類型 + local job の3サブ類型・11種**へ書き換え、同行の「`kind` を足したら**両方の表**を同時に直し」を「**`spec/async/index.md` の全数表を直す**」の1本へ（`adr.md` AD-14）。L487（`deleteAlarm()`）を「**両表の実行可能集合が空のときだけ**」へ。L488（`rotate-remap` は Alarm ジョブではない）に「relay も `jobs.kind` ではない」を併記。
  - **L652–654（`jobs`（Identity Directory DO））**: 「同じ12列」→「同じ11列」、「6種」→「5種」（`send-mail` が抜ける）。
  - **L699（migration ゲートを `alarm()` にも置く根拠）**: **無条件に書き換えない。** 現行文は「アクセスの無い利用者の**User Data DO** が次に起きる契機が `purge-trash` の Alarm しか無いから」であり、**User Data DO のイベント型は初期0件**（`adr.md` AD-3 / AC-19）なので改訂後も真である。**限定つきの追記を1句足すだけにする** — 「Identity Directory DO ではこれに outbox relay の起床が加わる」。無条件に書き換えると、User Data DO が0件であることの意味が薄れる。
  - **L703（`alarm()` の順序）**: 順序を **(1) 再武装 → (2) ゲート → (3-a) relay → (3-b) jobs → (4) 張り直し** の4段へ。**L701–702 のゲートが `await` ゼロであることから、relay をゲートに入れられない**ことを明記。
  - **L707–712（DDL の分類）**: 3つとも分類に当てはめる。(i) **`outbox_events`（両クラス）と `reset_request_windows` の追加は単発適用である** — L707 が「`CREATE TABLE` はデータ量に依存しない」、L709 が「索引は原則としてテーブル新設時に同時に張る（**空テーブルへの `CREATE INDEX` は安い**）」と既に書いている。**`migrate-bulk` は行のコピーのための機構であり、コピーすべき行が0件のここでは出番が無い。** DO 全体が 10 GB まで育っていても、新設・空の表には関係しない。**L709 の多段分解（新テーブル → `migrate-bulk` → 切替）は「既に大きく育った**既存**テーブルへ索引を足す」場合の逃がし方であって、本件には当たらない。** この誤分類を書くと #51 が不要な多段 migration を実装する導線になる。(ii) **`jobs` からの `provider_idempotency_key` の削除は L708 の「データ量に依存する（分割か回避が要る）」の (i) 列削除に当たる。** (iii) **`credential_mappings` からの `last_reset_requested_at` の削除も同じ (i) 側である**（`adr.md` AD-16）。新テーブル追加側だけ分類を書いて列削除側を書かないのは非対称であり、#51 が判断をやり直すことになる。
  - **L725–727（fail-closed）**: fail-closed の DO は relay もしないこと、outbox 行が滞留するが失われた配送ではないことを追加。**あわせて逆向き（fail-closed 前に publish 済みのメッセージを処理しようとした consumer が、L699 のゲートに阻まれて DLQ へ落ちる）を1行書く** — 非対称な挙動なので片方だけ書くと運用時に読み違える。
  - **`setAlarm` の lease 算入規則**（`adr.md` AD-4）を L459 の CAS の記述と対にして書く。leased 行は `max(next_run_at, lease_until)` で算入し、空振り起床を作らない。**`jobs` 側にも同じ形で掛かる。**
  - **#37 参照の棚卸し（本ファイル10件）.** `grep -rn '#37' spec CLAUDE.md | grep -v '/review/'` は**19件**を返し、うち10件が本ファイルにある。付け替え先は次のとおり（他ファイルの内訳は各ステップが持つ — `spec/domains/identity.md:435` はステップ7、`spec/inventory/adapter.md:19` はステップ14、`spec/testcases/export/exportAllData.md:46` はステップ15、`spec/manual-tests/search.md:359` はステップ17、`CLAUDE.md` の5件はステップ19）。
    - L3（実装先は #37 が新設する DO アダプター）→ **#51**
    - L24 / L64 / L85（単一行制約の掛け方は実装裁量）→ **#51**
    - L81（退会 saga の書き手は #37 が DO の RPC 側で決める）→ **#51**
    - L461（落としてはならない前方互換点3本）→ **#51**。**あわせて「outbox 行はこの3本に加えない」を1文書いて全数宣言を据え置く**（`adr.md` AD-18）。根拠は「prune が触るのは `published` と保持期間を過ぎた行だけで、`quarantined` は残す（AD-10）。終端の後始末に要る材料を prune が消す経路が無い」。**据え置くことを書かないと、3本という数が取り残されたのか意図的なのかを読み手が判別できない。**
    - L462（値は #37 が spike で出して #38 が確定）→ **#51 が spike、#38 が確定**
    - L468（`finalize-withdrawal` の投入点）→ **#51**
    - L691（bm25 の重みを実環境で再検証）→ **#51**
    - L764（検索カーソルの物理形）→ **#51**
- **理由:** Alarm が1本しか無いという制約は物理側の事実なので、多重化の規則は `spec/database/index.md` が持つ。AC-13 / AC-14 / AC-15 / AC-35 の記述点。

### 6. `spec/domains/index.md` の憲章的記述を改訂する

- **対象ファイル:** `spec/domains/index.md`
- **変更内容:**
  - **L35 を分割する。** 現行の「別ストアへ非同期に配送する経路は持たず、エンティティの作成・更新・削除が通知を発行することもない」を、(a)「**派生データ**（検索インデックス等）は同一トランザクションで更新し、配送しない — これは変わらない」と (b)「**外部への配送**は DO ローカル Outbox（`outbox_events` → Alarm relay → Queue → consumer → DLQ）が担う。契約と全数は `spec/async/index.md`」の2バレットへ。**本 Issue の一次編集対象。**
  - **L34 を維持したうえで補強する。** ポートの同期契約の例外が `PasswordHasher` / `MailSender` の2つのままであること、**relay の `queue.send()` はドメインポートではなくアダプター内部なので列挙が開かない**ことを明記（AC-18）。
  - **domain event / event draft の契約の所在**を1バレットで示す（`EventId` は application 層が付ける／ドメインは identity-less な draft を返す／登録口は UoW コンテキストの `enqueueEvent` 1つ）。
- **理由:** この2バレットを他のすべての `spec/domains/*` と `spec/usecases/*` が引用している。ここを直さないと下流の改訂が根拠を失う。

> **AC-36 の全数（ステップ6・7・9 が分担して消す）.** 無限定の「別ストアへ配送する経路は持たない」系の断言は**6箇所**で、これが全数である — `spec/domains/index.md:35`（ステップ6）/ `spec/domains/memo.md:14`（ステップ7）/ `spec/domains/search.md:216`（ステップ7）/ `spec/usecases/memo.md:14`（ステップ9）/ `spec/usecases/knowledge.md:16`（ステップ9）/ `spec/usecases/identity.md:10`（ステップ9）。**6箇所とも限定形へ直し、同じバレットに `spec/async/index.md` への参照を置く。** `grep -rn '配送する経路\|通知する経路\|外部 transport' spec | grep -v '/review/'` は9件を返すが、残る3件（`spec/database/index.md:162` / `spec/domains/trash.md:266` / `spec/inventory/adapter.md:45`）は**既に「失効」または「検索インデックス」へ限定済みなので変更しない。** 1つでも取り残すと「Outbox は無い」と「Outbox がある」が同じ `spec/` に同居する — 本 Issue が最も避けたい破れであり、目視では守れないので機械検査（ステップ21 項目10）と対にする。

### 7. 各ドメインのイベント定義と非定義を書く

- **対象ファイル:** `spec/domains/identity.md` / `spec/domains/search.md` / `spec/domains/memo.md` / `spec/domains/knowledge.md` / `spec/domains/trash.md` / `spec/domains/export.md`
- **変更内容:**
  - `identity.md`: **`identity.passwordResetRequested`** の定義（`type` / payload の形 / `aggregateId` / 発行点）を新設。payload に PII と再利用可能な秘密を載せない制約を明記。**L378 の「非集約ストアの全数（7つ）／書き込み口（6ストア・7メソッド）」を「9つ／8ストア・9メソッド」へ**（AC-17a。`outbox_events` と `reset_request_windows` の2つが増える）。**L369 の Promise 例外2件は維持**。**L612–624（`MailSender`）に「呼ぶのは Alarm ジョブではなく request Worker の `queue()` ハンドラ（mail consumer）」を追記**し、**`spec/inventory/adapter.md:51`（`ADP-identity-016`）と一字レベルで揃える**（ステップ14）。**L435 の #37 参照を #51 へ付け替える。**
    - **`PasswordResetThrottlePort` の節を新設する**（`adr.md` AD-19）。置き場は `PasswordResetTokenPort`（L588–）の隣。**メソッドは `claimWindow(windowKey, now): boolean` の1つだけ**で、窓の最初の依頼なら行を作って `true`、既存の窓なら `last_requested_at` だけを更新して `false` を返す。**判定と計上を2メソッドに分けない** — 分けると「4ケースが一様に落ちる」が2つの呼び出しの組み合わせの性質になり、呼び出し順序を誤ると一様性が静かに壊れる。1メソッドなら**単一の呼び出しの性質**として書ける。`windowKey` は呼び出し側が導出して渡す（対象 canonical の全長 HMAC + 依頼の窓。クライアントからは受け取らない）ので、ポートは導出鍵を知らない。**同期契約なので L369 の Promise 例外2件は動かない**（AC-18 / AC-39）。UoW コンテキスト側のハンドル名は `resetThrottleStore` で、`resetTokenStore`（`PasswordResetTokenPort`）と同じ「ハンドル名とポート名が別」の形に揃える。**この節が無いと、ユースケース spec が名前だけのハンドルを参照する形になり、原子性の粒度が #51 の実装裁量へ落ちる。**
  - `search.md`: **L216 の「外部 transport（キュー・ワーカー）は登場しない」を「検索ドメインについては登場しない」へ限定**し、`spec/async/index.md` へのポインタを添える。**L174 / L194 / L246 は維持**（AC-21）。**L232–244 の projection 契機11行の表の直後に「この11の契機はイベントではない。検索用イベントと indexer consumer を置かない」を明記**（AC-19 / AC-21）。
  - `memo.md`: **L14 の「別ストアへ配送する経路は持たない」を「検索インデックスについては配送しない。memo ドメインはイベントを定義しない（consumer が無い。変更履歴は `memo_revisions` が持つ）。**外部への配送の契約と全数は `spec/async/index.md`**」へ**。**末尾の参照を落とさない** — AC-36 は限定形へ直した6箇所すべてが同じバレットに `spec/async/index.md` への参照を持つことを要求しており、「イベントを定義しない」で閉じるバレットも例外にしない（読み手が「では誰が配送するのか」を1ホップで辿れるようにするため。`adr.md` AD-22）。**この置換で grep 対象の語句（`配送する経路`）は消えるので、AC-36 は総数一致では判定しない。**
  - `knowledge.md`: 同様の1バレットを L5–7 のヘッダブロックに追加。
  - `trash.md`: **L242 の論証（「投入口は UoW コンテキストであってポートではない」）を `enqueueEvent` へも及ぶ形に拡張**。ただし trash はイベントを定義しないので、**L253–254 の「投入点は5つで、これが全数である」は変えない**。
  - `export.md`: **L289 の「非同期は採用しない」の直後に「Outbox 復活後も export は同期生成のままである」を1文追加**（陳腐化して読めるのを防ぐ）。
- **理由:** 各ドメインの「配送経路は持たない」という再掲が残ったままだと、`spec/domains/index.md` を直しても下流が矛盾する。

### 8. `spec/usecases/identity.md` の `requestPasswordReset` を書き換える

- **対象ファイル:** `spec/usecases/identity.md`
- **変更内容:** L185 / L203 / L204 / **L205** / L206 / L208 を上の「ユースケース」節の6手順へ書き換える。**維持すべき3性質を一字も緩めない** —
  1. **4ケースの処理経路の完全一致**（列挙オラクル対策。L203）。**形は変わる** — 現行の「どのケースでも必ず1行書く」から「**同じ窓の状態に対して一様に落ちる。その窓での最初の依頼なら4ケースとも必ずちょうど1行、既に発行済みの窓なら4ケースとも1行も書かない**」へ。分岐の材料が `reset_request_windows` の状態だけであり、**登録有無・認証方式・宛先の存在を一切参照しない**ことを明記しないと、緩めたように読める。**窓ストアの行は登録の有無に関係なく必ず作る**ことも同じ場所に書く（`adr.md` AD-16）。**「送らない側」の payload も形が同一である**（`tokenId` を nullable にせず、宛先の有無から独立に生成した不透明値を置く）ことを明記する — 形が割れると payload そのものが列挙オラクルになる。
  2. **同一 canonical・同一窓への連打で、書き込みと起床が窓の数に比例する**（L208）。**手段が変わる** — 行の一意制約（`operationKey` / `dedupe_key`）ではなく、DO の transaction 内のスロットル判定が担う（`adr.md` AD-7）。窓ストアの行も窓ごとに1行で、2回目以降は同じ行への冪等な更新であり新しい行も起床も作らない。
  3. **生トークンを載せず送信直前に導出**（L206。ただし導出の場所が「起床したジョブ」から「consumer の RPC 先である DO の中」へ移る）。
  - **L205 を条件付きに改訂する。「無改訂で残す」という旧指示は撤回する**（`adr.md` AD-7）。**全置換の規則そのもの**（「発行はそのクレデンシャル宛の未使用トークンをすべて置き換える」）は維持したうえで、**発行が起きるのは窓での最初の依頼のときだけである**という前提条件を足す。**2回目以降の依頼は `PasswordResetTokenPort.issue()` を呼ばず、既存の未使用トークンをそのまま有効に保つ。** 無改訂で残すと、改訂後の spec は「同一窓の2回目でも登録済みなら `issue()` が走って1回目の未使用トークンを全削除するが、イベント行は書かれない」と読め、**(a) 1通目が未送信なら送信時再読が `nothing-to-send` に落ちて0通、(b) 1通目が送信済みなら利用者の手元のリンクが死ぬ** — 旧 `dedupe_key` 案を撤回させた破れが別経路で復活する。**発行判断と窓判定は同じ1つの分岐**（`claimWindow` の戻り値。`adr.md` AD-19）であって、2つの独立した条件ではないことを本文に書く。
    - **全置換の規則を維持することが AD-6 の2分岐固定の根拠であり続ける。** 同一窓では発行が1回しか起きないので supersede は生じず、**supersede が生じるのは窓をまたいだときだけ**で、そのときは新しい窓の最初の依頼が全削除を実行する。したがって「この全削除があるために DO 側では supersede と宛先不在を区別できない」は改訂後も成立する（`adr.md` AD-6）。
  - **窓行を書くのと同じトランザクションで `sweep-reset-tokens` を投入する**ことを処理フローに書く（`adr.md` AD-16）。**投入は4ケースすべてで起きる**（窓行が4ケースすべてで作られるため）。`.adr/010` の「投入点は正本の表と各投入ユースケースの両方に書く」に従い、ステップ3・5 と同じ1文をここにも置く。

  L533（`resume-link`）と L586（`sweep-orphan-mapping`）と L628–629（`changeTrashRetentionDays`）は**変更しない**。
- **理由:** 唯一 Outbox へ移るユースケース。既存の安全性設計を壊さないことが plan.md の最大のリスク項目。

### 9. `spec/usecases/*` の共通事項にイベント登録の契約を足す

- **対象ファイル:** `spec/usecases/memo.md`（L14）/ `spec/usecases/knowledge.md`（L16）/ `spec/usecases/identity.md`（L10）/ `spec/usecases/trash.md`（L11）/ `spec/usecases/search.md` / `spec/usecases/export.md`（L16）
- **変更内容:**
  - `memo.md` / `knowledge.md` / `identity.md` の3つの共通事項にある「**変更を外部へ通知する経路は持たない**」を、「(1) 業務データの書き込み、(2) FTS5 projection の更新、(3) `enqueueEvent` によるイベント行の追加、を**同じ `transactionSync` の中で一度に確定できる**。rollback すると3つとも巻き戻る。イベントを発行するユースケースの全数は `spec/async/index.md`」へ書き換える。**AC-12 の2つ目の記述点。**
  - `trash.md` L11（書き込みポートを持たない）と L313（投入点5つの全数）は**変更しない**。
  - `search.md` L74（反映待ちは存在しない）は**変更しない**（AC-21）。
  - `export.md` L16（同期生成）に再確認の1文。
- **理由:** 「同じトランザクションで3つが確定する」は受け入れ条件そのもの（AC-12）で、DB 設計・ユースケース共通事項・`CLAUDE.md` の3箇所で一致していなければならない。

### 10. `spec/requirements.md` に整合性要件を分離して書く

- **対象ファイル:** `spec/requirements.md`
- **変更内容:**
  - **§5.3 永続化**（L140–145）に2つのバレットを追加 — 「**検索インデックスは本体更新と同一トランザクションで確定する（即時整合）**」「**外部副作用とイベント配送は結果整合である。配送は at-least-once・順序保証なしで、同じ通知が複数回届きうる**」。**2つを別のバレットに分ける**のが AC-23 の要求。
  - **L143**（10 GB の数え方）に `outbox_events` と `reset_request_windows` を加算対象として追加。
  - **§4.4 検索**（L85–96）は**1文字も変えない**（AC-22）。
- **理由:** 上流の要件で整合性の水準が分かれていないと、下流で「検索も結果整合でよい」と読める余地が残る。

### 11. シナリオを確認・微修正する

- **対象ファイル:** `spec/scenario/search.md` / `spec/scenario/account.md` / `spec/idea.md`
- **変更内容:**
  - `scenario/search.md` **L18（「反映待ちは無い」）は変更しない。** 変更していないことを PR で明示する（AC-21）。
  - `scenario/account.md`: パスワードリセットのシナリオ **S-AC-07（L76 の見出し。手順は L78–L83、異常系は L87–L89）** に、**メールの到達が非同期で、同じメールが複数届きうる**ことを利用者視点で1行。書き足す位置は **L79（「届いたメールのリンクから新しいパスワードを設定する」）の直後**が最も自然で、異常系側は **L88（リセットリンクの期限切れ）** の隣に置く。**アンカーは実ファイルで再測定済みであり、ずれていない**（`grep -n` で L76 / L78 / L79 / L87 / L88 / L89 を確認。レビュー2周目の「1行ずれている」という指摘は誤りだった）。
  - `spec/idea.md` **L48**: 「Unit of Work（DO ローカルの同期トランザクション）+ Alarm ジョブ、ポート & アダプター構成」を「+ DO ローカル Outbox（Alarm relay → Queue → consumer）」を含む形へ。**直す理由を1行添える** — `spec/index.md` は idea.md を「インプット」に置いているが、**L44–48 は「技術的前提（テンプレート由来）」であって記録ではなく現に効いている Phase 0 決定事項**である。plan.md が「直さない」としている `spec/*/review/**` / `.thread/34/design.md` は日付つきの追記型レビュー記録であり、性質が違う。**「記録は直さない / 生きている決定は直す」という1本の基準で仕分けている**ことを PR の説明に書く。
- **理由:** 要件・シナリオ層で「検索は即時、外部配送は結果整合」が読めるようにする。

### 12. `spec/inventory/domain.md` を同期する

- **対象ファイル:** `spec/inventory/domain.md`
- **変更内容:** identity セクションの末尾に、イベント契約（`EventId` / `EventDraft` / `DomainEventBase` / `WithEventDrafts`）と `identity.passwordResetRequested` の `DOM-*` 行を **append**（欠番規約により既存連番は詰めない。**identity の現在の末尾は `DOM-identity-044`（L47）なので、新規は `DOM-identity-045` から**）。**あわせて `PasswordResetThrottlePort.claimWindow` の行を1つ append する**（`adr.md` AD-19。ステップ7 で `spec/domains/identity.md` に立てた節と対。**要点は「窓の最初の依頼なら行を作って `true`、既存なら `last_requested_at` を更新して `false`。判定と計上は1回の呼び出しで原子的に行われる。同期契約」**）。行を落とすと、ユースケースが触る非集約ストアなのにドメイン台帳に契約が無い、という `resetTokenStore` / `credentialLocatorStore` との非対称ができる。`DOM-identity-029` / `-033`（Promise 例外）と `DOM-trash-009`（投入点5つ）は**変更しない**。
- **理由:** 台帳は `spec/domains/` の生成物なので、ステップ7の変更が反映されていなければならない。

### 13. `spec/inventory/usecase.md` を同期する

- **対象ファイル:** `spec/inventory/usecase.md`
- **変更内容:** **L12（`UC-identity-005` requestPasswordReset）のみ**をステップ8の内容へ書き換える。L19 / L22 / L23 / L28 / L33 / L47 の `enqueueJob` 行は**変更しない**。
- **理由:** 変更するユースケースは1つだけなので、他の行に触れないこと自体が「二重登録していない」の傍証になる。

### 14. `spec/inventory/adapter.md` を同期する

- **対象ファイル:** `spec/inventory/adapter.md`
- **変更内容:**
  - schema 行（**L9–L30 の22行**。末尾は `ADP-meta-002` = L30）に **`ADP-outbox-events-001`（User Data DO）/ `ADP-outbox-events-002`（Identity Directory DO）/ `ADP-reset-request-windows-001`（Identity Directory DO）** の**3行**を追加し、**22行 → 25行**にする。**不変条件の言い方を実態へ揃える** — 「schema 行は DB のテーブル一覧と 1:1」は厳密には成立していない（先頭の `ADP-users-001` は「schema: users（廃止・分裂）」で対応する実テーブルが無い）。**「現存テーブルは必ず schema 行を持ち、廃止されたテーブルの行は履歴として残る」**という向きへ言い換えたうえで新規3行を足す。言い換えないと「1:1 が崩れている既存行をどうするか」で手が止まる。
  - **`ADP-jobs-001`（L23）と `ADP-jobs-002`（L29）** の「12列」→「11列」、「6種」→「6種 / 5種」（`ADP-jobs-002` は `send-mail` を含む6種を逐語で列挙しているので**列挙からも落とす**）、収束規則 (3) の「残る7種」→「残る6種」、`provider_idempotency_key` の削除を反映。**`ADP-jobs-001` は `spec/database/index.md:24` と同じ「`provider_idempotency_key` の決定的な導出が成立しない」という論拠を持つので、そこも同時に絞り直す**（ステップ4）。「全数は `spec/database/index.md` の `kind` 全数表が持つ」→「`spec/async/index.md` が持つ」へ参照先を変更。
  - **`ADP-identity-016`（L51。`MailSender.sendPasswordResetMail`）を訂正する。** 現行は「**`send-mail` ジョブの起床から呼ばれ、生トークンはジョブ行ではなく送信直前に認証情報側で導出する**」で、**呼び手と導出の場所の2箇所とも誤りになる** — 呼び手は request Worker の `queue()` ハンドラ（mail consumer）、導出は送信材料 RPC の中（DO 側）である。**ステップ7 の `spec/domains/identity.md:612–624` と一字レベルで揃える。**
  - **`ADP-account-001`（L19）の #37 参照**（退会 saga の前進は #37 が DO の RPC 側で決める）を **#51** へ付け替える。
  - **`ADP-credential-mappings-001`（L27）から `last_reset_requested_at` を落とす**（`adr.md` AD-16）。同行の「濫用抑止（failed_attempts / next_attempt_allowed_at / last_reset_requested_at）」という列挙が3列を逐語で並べているので、**列挙からも落とす**。`spec/database/index.md:582` の列削除（ステップ4）と同時に直す。
  - **relay / mail consumer / DLQ** の `ADP-*` 行を追加（Alarm 多重化・3相 claim/publish/finalize・冪等性キーの保持先・quarantine と DLQ の分界・**送信材料 RPC の2分岐応答と呼び出しガード3条件** — (a) 行が存在する / (b) `quarantined` でない / (c) `owner_token` が一致する。**`status` は照合しない**）。**3つとも層はアダプターであり、`spec/inventory/usecase.md` には行を足さない**ことを1行添える（`adr.md` AD-17。mail consumer は「DO RPC の2分岐 → `MailSender`」という2ポートの合成を持つのでユースケースに見えるが、業務判断はすべて RPC の向こう側にある。現行の `send-mail` ジョブも同じ形でアダプター側にしかない）。**この1行が無いと #51 が application 層にハンドラを作るか否かで揺れる。**
  - `ADP-operations-001`（L24）/ `ADP-migration-progress-001`（L25）の「書き込み口の全数」記述に影響が無いことを確認（別ストアなので変わらない）。
- **理由:** 現存テーブルが必ず schema 行を持つことが、この台帳の不変条件である。

### 15. テストケースを追加・改訂する

- **対象ファイル:** `spec/testcases/async/outboxDelivery.md`（新規）/ `spec/testcases/identity/requestPasswordReset.md` / `spec/testcases/export/exportAllData.md`
- **変更内容:**
  - **ID 規約と枠組みの決定**（`adr.md` AD-15）: slug は **`outboxDelivery`**（ID は `TC-outboxDelivery-{連番3桁}`）。`spec/inventory/test.md:5` の規約文「全行 `TC-{ユースケースslug}-{連番3桁}`」を「**テストケースファイルの slug**」へ言い換える（ステップ16）。**これは規約の新設ではなく言い換えである** — 実体は既にファイル名 basename で採番されており、`TC-post_memo` / `TC-recent_memos` / `TC-update_memo` の3 slug はユースケース名ではない。**新しい表は設けない**（台帳は見出しを持たない単一表であり、`#L{n}` アンカーと欠番規約がその形の上に載っている）。
  - **新規ファイル**を既存の形式（`# テストケース: {名前}` → 1段落の説明 → `| 前提条件 | 操作 | 期待結果 | 実装ステータス |`）で作り、plan.md「テスト方針 (b)」のうち**機構に属する項目**（原子性 / relay / at-least-once / 順序逆転 / backoff / lease / quarantine / DLQ / 再駆動 / prune / PII 非露出 / fail-closed × DLQ）をケースに落とす。**ユースケースの振る舞いに属する3項目**（4ケース経路一致 / 連打の収束 / FTS5 の即時性）は既存ファイルに置く。
  - `requestPasswordReset.md`: **L5（4ケースの経路一致の中心的な検証点）と L9–L20** をステップ8の内容へ書き換える。**新しいケースは表の末尾に append する**（`spec/inventory/test.md` L5–7 の欠番規約と `#L{n}` アンカーを壊さないため）。**必ず足す3ケース**（AC-37b）— (i)「同一 canonical・同一窓へ2回依頼 → **有効なリンクを含むメールが1通届く（0通でも2通でもない）。かつ1通目のリンクが2回目の依頼後も有効である**（2回目は `PasswordResetTokenPort.issue()` を呼ばないので未使用トークンが置き換わらない。`adr.md` AD-7）」、(ii)「窓をまたいで積まれた新旧2件が**逆順で consumer へ届く** → 新しいほうが送信され、古いほうは送信材料 RPC が `nothing-to-send` を返して no-op。**期待値は『`nothing-to-send` が返る』までであり、理由は期待値に書けない**」、(iii)「**未登録アドレスへ同一窓で2回依頼しても、測定対象が登録済みの場合と一致する**」。**(iii) の測定対象を4つに明示する** — (1) `outbox_events` の行数、(2) `reset_request_windows` の行数、(3) Alarm の起床の有無、(4) `sweep-reset-tokens` の投入の有無。**「総書き込み行数」で測ってはならない** — 登録済み側は `password_reset_tokens` の発行行を追加で書くので総数では一致せず（この非対称は `main` の spec にも既にある）、文字どおりに読むと成立しない命題になる。**(iii) を落とさない** — 窓ストアを `credential_mappings` に相乗りさせる案が破れたのは未登録側であり、登録済み側だけを見るテストではその破れを検出できない（`adr.md` AD-16）。既存の「ジョブ行1本に収束する」「スロットル中も同じ行に収束する」の2ケースは、**行の収束ではなく窓ごとの発行判断**を検証する形へ書き換える。
  - `exportAllData.md`: **L46 の #37 参照**（上限値は「#37 → #38 で決まる」）を **#51 → #38** へ付け替える。
  - **`spec/testcases/search/search.md` は変更しない**（L35 の `TC-search-033` を含む。AC-21）。
- **理由:** 受け入れ条件が「テスト方針が定義されていること」まで求めている（実装は #51）。

### 16. `spec/inventory/test.md` を同期する

- **対象ファイル:** `spec/inventory/test.md`
- **変更内容:** ステップ15 で追加したケースの `TC-*` 行を表の末尾に append（**台帳は見出しを持たない単一表なので「各表」ではなく1つの表である**。現在 838 行・**54 slug**。どちらも実測済み）。**L5 の ID 規約文を「テストケースファイルの slug」へ言い換える**（`adr.md` AD-15）。`spec/testcases/async/` が `spec/async/index.md` に対応するカテゴリーであることを1行添える。`requestPasswordReset` の既存行（L204 / L211 / L213 / L214 / L215）の要点を書き換える。**`#L{n}` アンカーがずれた行があれば同時に直す。** `TC-search-033`（L707。「反映待ちが存在しなければ PASS」）は変更しない。
- **理由:** 台帳の位置の権威は `#L{n}` なので、テストケースファイルを編集したら必ず同期する。

### 17. マニュアルテストを追加する

- **対象ファイル:** `spec/manual-tests/account.md`（**追加先。確定済み**）/ `spec/manual-tests/search.md` / `spec/manual-tests/ai.md` / `spec/manual-tests/document.md`（確認のみ）/ `spec/manual-tests/index.md`
- **変更内容:**
  - **Outbox backlog の観測 / quarantine 一覧 / DLQ の確認 / 再駆動の実行**の手順を、**既存カテゴリー `spec/manual-tests/account.md` に追加する**（`adr.md` AD-20）。**新規カテゴリーは作らない** — 作ると `spec/manual-tests/index.md` の件数表に行が増え、`spec/index.md:16` の「**7カテゴリ**・204ケース」のカテゴリ数まで動く。**置き場は計画段階で確定済みであり、実行中に決め直さない**（窓ストアに適用したのと同じ原則）。**同時修正リストにカテゴリ数の行を足す必要は無い** — 動くのは `account.md` のケース数と合計204の2つだけで、どちらも既に載っている。
    - **`account.md` を選んだ根拠**（実ファイルを読んで確定した）: 同ファイルは「アカウント登録・ログイン・ログアウト・AIクライアント接続・**パスワードリセット/変更**」を対象とし（L5）、環境前提に「**パスワードリセットメールを確認できる開発用メールボックス**」を既に持ち（L21）、リセット依頼〜受信〜再設定のケースを4本持つ（TC-10 / TC-29 / TC-30 / TC-31）。**本 Issue が足す手順が観測するのは、そのリセットメールの配送そのものである。** `settings.md` は保持期限変更とエクスポートだけを対象としており、テストデータの前提が噛み合わない。
    - 追加位置は**既存ケースの末尾に append する**（`account.md` の番号は既に飛んでおり、`spec/manual-tests/index.md:33` が「追加したケースは既存の番号を繰り上げないよう末尾採番する」と規定している）。
  - **手段の実体は #38 が定める**という既存の書き方に揃える（`spec/manual-tests/trash.md:18–22` が先例で、Alarm の強制発火について同じ形を採っている）。
  - **backlog の観測手順に fail-closed 由来の滞留の判別材料を1行入れる。** 「backlog が増えている DO の `schema_version` を診断エントリ（`read-schema-version`）で確かめる。コード側の期待より大きければ fail-closed による滞留であり、**配送の失敗ではない**（行は残り、デプロイが揃った次の起床で流れる）」。`spec/database/index.md` L725–727 側に「fail-closed の DO は relay もしない」を書いても、**実際に backlog を見るのは運用者でありその導線はこのファイルと #38 の手順**なので、判別材料をここに置かないと滞留を障害と誤診する。
  - `account.md`（L22 / L42 / L167–177 / L459–460）: リセットメールの受信手順に**配送遅延の待ち時間**と「**同じメールが複数届きうる**」の注記を追加。
  - `search.md`（L19）/ `ai.md`（L22）/ `document.md`（**L25 のみ。確認対象**）: 「インデックス更新のための追加のワーカー・常駐プロセスは存在せず、反映待ちも無い」を**検索については維持**しつつ、「外部への配送には別途 relay と consumer がある」ことを1行で限定する。**`document.md:131` は対象から外す** — 実体は TC-07 の前提行「TC-06 で `日々の作業メモ` が完了済みであること…（検索インデックスは同一トランザクションで維持されるため、反映のための待ち時間は無い）」で、**「反映待ち」系の全数（7箇所）にも入っていない**（`grep -n '反映待ち' spec/manual-tests/document.md` は0件）。対象欄に残すと実装者が「ここも直すのか」で一度止まる。**「反映待ち」の記述は全部で7箇所ある**（`spec/scenario/search.md:18` / `spec/domains/search.md:174` / `spec/usecases/search.md:74` / `spec/manual-tests/search.md:19` と `:154` / `spec/testcases/search/search.md:35` / `spec/inventory/test.md:707`）。**限定の1行を足すのは `spec/manual-tests/search.md:19` の1箇所だけ**にし、残り6箇所は変更しない（AC-21 の非変更検査の対象は上流3件）。
  - `search.md` **L359 の #37 参照**（検索カーソルの物理形と寿命）を **#51** へ付け替える。
  - `index.md`: **L9 の spec バージョン行**、**L13–22 の件数表と合計（L22 の `**204**`）**、**L41 の実行記録テンプレートの `/204件`** を更新。**件数表で動くのは「アカウントと認証」の行（現在 43 / 正常系14 / 異常系25 / 境界値4）と合計行の2行だけであり、行は増えない**（AD-20）。**`grep -n '204' spec/manual-tests/index.md` が返すのは L22 / L41 の2件であり、L9 は数ではなく日付を持つ行である**（更新点は3箇所だが grep で拾えるのは2箇所、という区別を残す）。
- **理由:** 受け入れ条件が「マニュアルテストに Outbox backlog / quarantine / DLQ / 再駆動の確認を追加する」を明示している（AC-28）。

### 18. `spec/index.md` を同期する

- **対象ファイル:** `spec/index.md`
- **変更内容:**
  - 成果物一覧に **`spec/async/index.md`** を追加。進捗表の Phase 3 の行（**L15**）にも反映。
  - **L25**「User Data DO **16** テーブル / Identity Directory DO **5** テーブル」を **17 / 7** へ（User Data は `outbox_events` の1つ、Identity Directory は `outbox_events` と `reset_request_windows` の2つが増える。`adr.md` AD-2 / AD-16）。
  - テストケース件数を実体に合わせる — **L15 と L26 の「54ユースケース・838ケース」**（2箇所）。**`spec/testcases/async/` はユースケースに属さないので、「54ユースケース + async 1ファイル」の形で数え方に出す**（`adr.md` AD-15）。**L24 の「6ドメイン・54ユースケース」は `spec/usecases/` の数え上げなので変更しない。**
  - マニュアルテスト件数（204）を実体に合わせる — **L16 と L27** の2箇所。**L16 の「7カテゴリ」は変更しない**（追加先は既存カテゴリー `account.md`。`adr.md` AD-20）。**変えていないことを機械検査7（非変更検査）の対象に入れる** — 新規カテゴリーを作った場合にだけ動く数なので、動いていたら AD-20 から外れたことの検出になる。
  - `.adr/` の表に **`.adr/013`** の行を追加。`.adr/004` の行の注記を部分 supersede が起きた形へ更新。
  - **L42**（`spec/adr/005` の行）の注記をステップ2 の内容に揃える。
- **理由:** 目次の件数が実体とずれると、`.thread/34/design.md` I-8 が禁じた「表を持つ数え上げの不一致」になる。

### 19. `CLAUDE.md` を改訂する

- **対象ファイル:** `CLAUDE.md`
- **変更内容:**
  - **L66（Key concepts の前置き）**: 「The exceptions are the items still waiting on **#37**」の #37 を **#51** へ差し替える。**ここを落とすと、下の「Migration in progress」だけを直しても存在しない Issue を指す文が残る。**
  - **L68（Unit of Work）**: 2群それぞれを更新する。**(a) 副作用登録点**に `enqueueEvent` を追加（両 DO クラス）。**(b) 非集約ストアの roster の Identity Directory DO 側の列挙**（現行は `resetTokenStore`（`PasswordResetTokenPort` on the domain side）と `rotationCheckpointStore` の2つ）に **`resetThrottleStore`（`reset_request_windows`）を追加**する（`adr.md` AD-16）。**この (b) を落とすと、`CLAUDE.md` が列挙している roster と `spec/database/index.md` の全数が食い違う。** 「the **complete set** of write paths」の列挙も同時に更新。**数は書き足さない** — 末尾の `The per-table roster, and its count, lives in spec/database/index.md.` が数の権威を委譲しており、`CLAUDE.md` には現在も「7つ」「6ストア・7メソッド」という数が無い（AC-17b）。「業務データ・FTS5 projection・イベント行が同じ `transactionSync` で確定する」を1文（**AC-12 の3つ目の記述点**）。
  - **Key concepts に Outbox の項を新設**: at-least-once / 順序保証なし / consumer は `event.id` で冪等化 / 冪等性キーの保持先は consumer ごと / **トランザクションの中で外部 I/O をしない**（`transactionSync` が `fetch` を呼べない） / Outbox は専用 DO ではなく発行元 DO にある / Alarm は relay の起動契機 / **秘密と PII は payload・Queue メッセージ・DLQ・ログ・`terminal_reason` に載らず、送信材料 RPC の応答としてのみ境界を越える**。**識別子（`event.type` / `jobs.kind`）は1つも書かない**（`adr.md` AD-14）。
  - **Asynchronous execution contract 項1（L77）**: 「There is no domain-event transport.」を **`adr.md` AD-1 の3類型の判定規則**へ全面差し替え。外部 I/O であることと cross-DO RPC であることが単独では Outbox の条件にならないことを明記（AC-5）。**規則2の「独立」が実行責任の独立であって Worker の物理分離ではないこと**も書く（AD-13 で consumer が request Worker に同居するため）。
  - **項2 の4類型表（L78–87）を全数表ではなくす**（`adr.md` AD-14）。`event.type` / `jobs.kind` の識別子を**1つも列挙しない**形（類型名 + `spec/async/index.md` への参照 + 「足すときは AD-1 の3規則のどれで当たったかをレビューで問い、全数表に1行足す」という手続きの規定）へ縮める。**「`kind` を足したらここにも足す」は削除する** — 全数表を持つのは `spec/async/index.md` の1箇所だけになる。
  - **項3・項4（L88–89）**: at-least-once と順序保証なしが Outbox 配送にも掛かることを追加。Alarm が2表を多重化することと、その順序・上限を1文で。項3 の「External providers receive a `providerIdempotencyKey` derived deterministically from the job's `operationKey`」は、**`event.id` から DO が導出して送信材料 RPC の応答で渡す**形へ訂正する（`adr.md` AD-8）。
  - **L98（Error handling の catch 境界の列挙）**: 現行は `server-function serialization, the Durable Object's RPC entry points, per-job tolerance in the job runner` の3点。**relay パスの per-row catch と consumer 側の catch 境界を足す**（列挙なので落とすと不整合になる）。
  - **Cross-layer catch policy / worker → root（L106）**: relay パスの per-row catch と consumer 側の catch 境界を追加。**`alarm()` から throw しない**規則が relay にも掛かることを明記。
  - **Reference runtime（L110）**: 「no D1, **no Queues**, no external search service」の Queues を訂正。**「Two Workers」の文は維持し、request Worker の責務に「Queue consumer（mail consumer と DLQ ハンドラ）」を足す**（`adr.md` AD-13）。**deploy 順序（state 先）の記述は変えない。** エントリポイント一覧（L118）に relay が DO の `alarm()` の中にあること、consumer / DLQ が request Worker の `queue()` ハンドラであることを反映。**メール provider の秘密が request Worker に属することは `.dev.vars.example` の更新（#51）とセットなので、`CLAUDE.md` には「Each Worker has its own, non-overlapping set of secrets」の対象が増えることだけを書く。**
  - **Migration in progress（L124–132）**: **#37 → #51 へ差し替え**（L124 / L126 / L129 / L132 の4箇所）。**`#37` という識別子を1件も残さない**（`adr.md` AD-21）。「**旧移行 Issue はクローズ済みで、実装は #51 が引き継ぐ**」までを書き、**番号は出さない** — 「#37 が CLOSED であることを書く」という旧指示は**撤回する**。指示どおり書くと `CLAUDE.md` に `#37` が1件残り、**AC-35 と機械検査8（素の grep が0件）が必ず赤になる**。歴史（#37 が何をしようとして、なぜ CLOSED になり、何が引き継がれたか）は **#37 の gh コメント側に置く**（ステップ20 が担う）。文書に置くのは「今どうなっているか」であって「かつて誰が何を計画したか」ではない。**`main` のコードがまだ D1 + Outbox であること、`collectEvents` が `enqueueEvent` へ改名されるのは #51 であることは従来どおり書く。****L129 の「#37 deletes them along with the outbox and processed-events tables」は改訂後に半分だけ真になる**ので明示的に訂正する — `processed_events` は消えるが、**outbox は消えず DO ローカルへ移る**。あわせて worker の列挙が `relay` / `consumer` / `pruner` / `dlq` の**4本**であることは現行どおり維持する。
- **理由:** `CLAUDE.md` は開発規約の正本で、受け入れ条件2（`spec/` と `CLAUDE.md` が一貫している）の直接の対象。

### 20. 関連 Issue / PR を同期する

- **対象:** `gh` 操作のみ（ファイル変更なし）
- **変更内容:**
  - **#37**（CLOSED）: 本 Issue で supersede した旨、DO 移行と FTS5 同期更新は維持されること、Outbox 廃止の判断だけが訂正されたこと、実装は #51 が引き継ぐことをコメント。
  - **PR #49**（CLOSED・未マージ）: クローズ済みの履歴として残すこと、DO / FTS5 の実装を #51 が参照してよいが Outbox 削除は取り消されることをコメント。
  - **#38**: 依存を #37 から **#51** へ、文書化対象を **DO ローカル Outbox + local jobs 構成**へ更新するコメント。**本文の「relay / consumer / pruner / dlq の個別 deploy が消えたことを反映」が失効した**ことを明記。Outbox backlog / quarantine / DLQ / 再駆動の運用手順と、relay の運用値（batch size / lease / retry 上限 / 保持期間）の確定が #38 の担当に加わること、`README.md` と `docs/` の同期時期も添える。
  - **#10**: FTS5 同期更新は維持され検索 indexer consumer は復活しないこと、改訂後の `spec/inventory/` と同期することをコメント。
  - **#51**: 本 Issue で確定した ADR（`.adr/013`）と全数表（`spec/async/index.md`）の所在、および P-001 の差し戻し条件をコメント。**依存の明記は既存本文が満たしている**ので、その確認を記録する。あわせて**本 Issue が触らなかった `apps/web/` 側の引き継ぎ2件**を明記する — (i) `apps/web/.dev.vars.example` に**メール provider の秘密を request Worker 側の宣言として足す**こと（`adr.md` AD-13。現在は `SESSION_SECRET` 1件しか宣言が無い）、(ii) `wrangler.toml` / `wrangler.{staging,production}.toml.tpl` が D1 時代の `[env.relay]` / `[env.consumer]` / `[env.pruner]` / `[env.dlq]` の4環境のままであり、**Queue の producer / consumer binding と DO binding を含めて全面的に書き換える**こと。
- **理由:** 受け入れ条件16・17。

### 21. 全数表と数え上げの機械検査を走らせる

- **対象:** 検査コマンドの実行（`.thread/50/` に一時ファイルを置いてよいが、成果物には残さない）
- **変更内容:** plan.md「テスト方針 (a)」の検査を全項目実行する。
  1. **`spec/database/index.md` が言及する `kind` の集合 ⊆ `spec/async/index.md` の全数表の `jobs.kind` 集合**（差集合が空）。**一致では検査しない** — 移設後の `spec/database/index.md` には再武装5種と収束規則の例示しか残らないので、一致で見ると恒常的に赤になり、その検査は無視されるようになる
  2. 同じ識別子が2つの類型に現れない
  3. 発行点・投入点の欄に空欄が無い
  4. `event.type` が `spec/domains/` の定義と1対1
  5. すべての `event.type` の consumer 欄が埋まっている
  6. **下の「同時修正リスト」の数を、宣言箇所と実体の両方からコマンドで出して比較する**（**注記に数を書き写す形は採らない**）
  7. `git diff` で `spec/scenario/search.md:18` / `spec/domains/search.md:174` / `spec/usecases/search.md:74` / `spec/requirements.md` §4.4 / **`spec/index.md:16` の「7カテゴリ」** が変わっていないこと
  8. `grep -rn '#37' spec CLAUDE.md | grep -v '/review/'` が **0件**（改訂前は19件。AC-35）。**例外条項は置かない** — `CLAUDE.md` の Migration in progress からも識別子を落とす（`adr.md` AD-21）
  9. `jobs` 節と `spec/inventory/adapter.md` に **`send-mail` の文字列が1件も残っていない**（全数表の「由来」欄の `旧 send-mail` は `spec/async/index.md` にあるので射程外）
  10. **`provider_idempotency_key` が `spec/` のどこにも列として現れない**（`jobs` からも `outbox_events` からも落ちたことの検査）
  11. **`CLAUDE.md` に `event.type` / `jobs.kind` の識別子が1つも列挙されていない**（`adr.md` AD-14）
  12. **無限定の「配送する経路は持たない」が0件**（AC-36）。`grep -rn '配送する経路\|通知する経路\|外部 transport' spec | grep -v '/review/'` は**改訂前 9件・改訂後 4件**。**総数の一致では判定しない**（`adr.md` AD-22）— 限定形へ直す6箇所のうち5箇所は、ステップ6 / 7 / 9 の指定文に置き換えると grep 対象の語句そのものが消えるからである（生き残るのは `spec/domains/search.md:216` だけ）。判定は2本立て: **(1)** 無変更3件（`spec/database/index.md:162` / `spec/domains/trash.md:266` / `spec/inventory/adapter.md:45`）が `git diff` で1文字も変わっていない、**(2)** 改訂後の残存4件のいずれにも無限定の断言が無い（それぞれ「失効済み」「検索インデックスに限定」「検索ドメインに限定」のいずれかである）。**5件目が出たら改訂側のミスとして扱う**（新しい無限定の断言が生まれたか、直したはずの箇所が直っていない）
  13. **応答分岐の識別子 `` `superseded` `` / `no-recipient` が `spec/` と `CLAUDE.md` に1件も現れない**（`adr.md` AD-6 の2分岐固定。3分岐の記述の取り残し検査）。

      `superseded` は**バッククォートで囲んだ識別子表記に限定して**数える（`grep -rnF '` + "`superseded`" + `' spec/ CLAUDE.md`。改訂前 0件 → 改訂後も 0件）。素の `grep -rn 'superseded'` は ADR のステータス語（「`spec/adr/005`（superseded）」）に**改訂前から8件**ヒットし、これは AD-6 が禁じた応答分岐の識別子とは別物。素朴に0件を期待すると必ず赤になり、赤を消すために ADR のステータス表記を壊す導線になる。`no-recipient` は素の grep でよい（改訂前 0件）。
  14. **`last_reset_requested_at` が `spec/` のどこにも列として現れない**（`adr.md` AD-16。改訂前は `spec/database/index.md:582` と `spec/inventory/adapter.md:27` の2件）
  15. **旧 `jobs.kind` 12種の集合 == `spec/async/index.md` 全数表の「由来」欄の集合**（AC-8 の判定）

> **集合演算の除外規則（検査 2 / 4 / 5 / 15 に掛かる）.** 全数表の「**User Data DO のイベント型: 0件**」の行（AC-19 / `adr.md` AD-3）は、識別子欄も由来欄も持てない。**4つの検査すべてから明示的に除外する** — 除外を書かずに回すと、0件行を集合に入れて空文字列のズレを踏む。**除外対象はこの1行だけで、それが全数である。** ステップ3 が全数表の直後に同じ1行を書くので、検査を書く人はそこを読めばよい。

**同時修正リスト（改訂で一斉にズレる数。左は実ファイル・実コマンドで再測定した現在値）**

| 数 | 現在値 | 改訂後 | 実在箇所（全数）と再測定コマンド |
|---|---|---|---|
| User Data DO のテーブル数 | 16 | **17** | `spec/index.md:25` / `spec/database/index.md` のテーブル一覧（L36–51 が User Data の16行。実カウント済み）。増えるのは `outbox_events` の1つ |
| Identity Directory DO のテーブル数 | 5 | **7** | 同上（L52–56 が5行）。増えるのは `outbox_events` と **`reset_request_windows`** の2つ（`adr.md` AD-16） |
| 非集約ストア数 | 7 | **9** | `spec/database/index.md` L79 / L749 / L753 / L754 の**4行**、`spec/domains/identity.md:378` の1行。`grep -rn '非集約ストア' spec` は**9ヒット**（`\| grep -v '/review/'` を付けても9件）するが、**数を書いているのはこの5行だけで、残り4件は分類の話**（`spec/database/index.md` L533 / L752、`spec/domains/identity.md:463`、`spec/inventory/domain.md:41`）。**`CLAUDE.md` には数が無い** — L68 は `spec/database/index.md` へ委譲している |
| 非集約ストアの書き込み口 | 6ストア・7メソッド | **8ストア・9メソッド** | `spec/database/index.md:754` / `spec/domains/identity.md:378`。増えるのは `enqueueEvent` と `resetThrottleStore` |
| `spec/inventory/adapter.md` の schema 行数 | 22（L9–L30） | **25** | `ADP-outbox-events-001` / `-002` / `ADP-reset-request-windows-001` の3行を append |
| `jobs` の列数 | 12 | **11** | `spec/database/index.md` L428 / L654、`spec/inventory/adapter.md` L23 / L29。**`grep -rn '12列' spec` は4行を返し、その4行が修正箇所の全数である**（L23 は「Alarm ジョブの多重化テーブル（12列）」という括弧つきの形なので、目で拾うときに見落としやすい） |
| `jobs.kind` の種別数 | 12（User Data 6 / Identity Directory 6） | **11（User Data 6 / Identity Directory 5）** | `spec/database/index.md` L48 / L54 / L468 / L485 / L654 / **L759**、`spec/inventory/adapter.md` L29。**窓ストアの掃除は `sweep-reset-tokens` に同居させるので 11 種から動かない**（`adr.md` AD-16） |
| 収束規則 (3) の「残る7種」 | 7 | **6** | `spec/database/index.md` L457（同一行内に2回）/ L486、`spec/inventory/adapter.md:23`（`grep -rn '残る7種' spec` の全数 = 2行3箇所 + adapter 1件）。**L457 は数だけでなく根拠の例示（`send-mail` の同窓連打）も差し替える** |
| 「ユースケースから投入する8種」 | 8 | **7** | `spec/database/index.md:468`（残る4種は不変） |
| `jobs.kind` の類型数 | 4 | **3類型 + local job の3サブ類型** | `spec/database/index.md:485`（`grep -rn '4類型\|類型は4つ' spec` の全数 = 1件） |
| テストケース件数 | 838（`grep -c '^\| TC-' spec/inventory/test.md`） | **838 + 新規ケース数** | `spec/index.md` L15 / L26、`spec/inventory/test.md` の実カウント |
| テストケースの slug 数 | **54** | **55**（`outboxDelivery` を追加） | `grep -o '^\| TC-[A-Za-z_0-9]*-[0-9]\{3\}' spec/inventory/test.md \| sed 's/^\| TC-//; s/-[0-9]\{3\}$//' \| sort -u \| wc -l` = **54**、`ls spec/testcases/*/*.md \| wc -l` = **54**（両者の集合は完全一致する。**slug 数 = テストケースファイル数**が不変条件）。**この 54 と `spec/index.md` の「54ユースケース」は現時点で偶然一致している別の数である** — 後者は `spec/usecases/` の数え上げ。改訂後は 55 と 54 に分かれ、区別が値の上でも見えるようになる |
| マニュアルテスト件数 | 204 | **204 + 新規ケース数** | `spec/index.md` L16 / L27、`spec/manual-tests/index.md` L13–22（件数表と L22 の合計）/ L41（実行記録テンプレート）。**`grep -n '204' spec/manual-tests/index.md` が返すのは L22 / L41 の2件**で、L9（spec バージョン行）は日付なので拾えない |
| `#37` の参照件数 | 19 | **0** | `spec/database/index.md` 10 / `CLAUDE.md` 5 / `spec/domains/identity.md` 1 / `spec/inventory/adapter.md` 1 / `spec/testcases/export/exportAllData.md` 1 / `spec/manual-tests/search.md` 1 |
| 「反映待ち」の実在箇所 | **7**（`grep -rn '反映待ち' spec \| grep -v '/review/'`。**除外前の全ヒットは8件**で、8件目は `spec/manual-tests/review/002.md:46` = 改訂対象外のレビュー記録） | **7**（件数は動かない） | 上流3件 + `spec/manual-tests/search.md:19` `:154` + `spec/testcases/search/search.md:35` + `spec/inventory/test.md:707`。**限定の1行を足すのは `spec/manual-tests/search.md:19` だけ** |
| 無限定の「配送する経路は持たない」 | **6** | **0**（限定形へ） | `grep -rn '配送する経路\|通知する経路\|外部 transport' spec \| grep -v '/review/'` は**改訂前9件・改訂後4件**。うち6件（AC-36 の全数）を限定形へ直すが、**5箇所は指定文に置き換えると語句そのものが消える**ので総数は9件のままにならない。残る3件（`spec/database/index.md:162` / `spec/domains/trash.md:266` / `spec/inventory/adapter.md:45`）は無変更、`spec/domains/search.md:216` は「外部 transport」を残した限定形で生存。**総数一致では検査しない**（`adr.md` AD-22） |
| マニュアルテストのカテゴリ数 | **7** | **7（不変）** | `spec/index.md:16` / `spec/manual-tests/index.md` L13–22 の件数表の行数。**追加先を既存カテゴリー `account.md` に確定したので動かない**（`adr.md` AD-20）。動くのは `account.md` の行の件数（現在 43）と合計（204）の2つだけで、どちらも上の行が既に持っている |
| `last_reset_requested_at` の実在箇所 | 2 | **0** | `spec/database/index.md:582` / `spec/inventory/adapter.md:27`（`adr.md` AD-16 で列ごと落とす） |

- **理由:** 「片方を直してもう片方が取り残される」破れが `.thread/34/design.md` 第1.4節に4ラウンド分記録されている。目視では守れない。**現在値を実ファイル・実コマンドから再測定したうえで表に固定してある**ので、改訂後は同じコマンドで再カウントして突き合わせる。**スロットル窓ストアの新設は上の4行（テーブル数・非集約ストア数・書き込み口・schema 行数）に追加で効く** — `outbox_events` のぶんだけを足した値で止めると、ステップ21 の検査6 が改訂側のミスとして赤を出す。

### 22. 差分範囲を検査し、lint / format を通す

- **対象:** `git diff --name-only main` / `pnpm lint` / `pnpm format:check`
- **変更内容:**
  - `git diff --name-only main` の出力が `.adr/` / `spec/` / `CLAUDE.md` / `.thread/50/` **だけ**であることを確認する。`packages/` / `apps/` / `infra/` / `*.toml` / migration SQL が1行も含まれないこと（AC-32）。
  - `pnpm lint` と `pnpm format:check` を通す（AC-33）。
- **理由:** 受け入れ条件18・19。「本 Issue の PR にプロダクションコード・wrangler 設定・DB migration の変更が含まれていない」は機械的に検証できる基準なので、必ずコマンドで確認する。
