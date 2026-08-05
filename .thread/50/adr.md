# ADR — Issue #50: User Data DO + DO ローカル Outbox へ移行し、ドメインイベント配送を維持する

本 Issue の成果物はドキュメントのみだが、書くべきドキュメントの内容そのものが設計判断の集合である。以下はその判断の記録であり、AD-1〜AD-59 のうちプロジェクト全体に効くものが `.adr/013` へ昇格する。**設計判断の記録先は本ファイルだけである** — plan.md / steps.md は結論を参照するだけで、判断の根拠を重複させない。

---

## AD-1: 非同期処理を「実行責任の所有者」で3類型へ分類する

### Status

Proposed

### Context

`.adr/004` は非同期処理を「トランザクション内で完結するか否か」で2分し、完結しないものをすべて `jobs` + Alarm に載せた。その結果、`CLAUDE.md` の非同期実行契約は「**外部 I/O を伴う処理は必ず永続ジョブに載る**」を軸に書かれ、`jobs.kind` 12種のうち `send-mail` だけが外部 I/O、という構造になっている。

この軸は「どこで実行するか」を問うており、「**誰が完了責任を持つか**」を問うていない。だから外部 I/O とローカル期限処理が同じ表に並び、独立にスケールする consumer へ責任を委譲したい処理と、その DO 自身が必ず自分で完走させなければならない処理が区別できない。

Issue #50 が要求するのは、判定軸を実行責任の所有者へ移すことである。

### Decision

**判定を3段の順序つき規則にする。上から順に評価し、最初に当たった類型に**ちょうど1回**割り当てる。**

1. **業務状態と同じトランザクションで完了しなければならないなら同期実行。** FTS5 projection、retention のハードデリート、saga の phase 前進、`purge_after` の一括再計算がこれに当たる。
2. **実行責任を独立した consumer へ委譲する／複数 consumer へ fan-out する／他システムへ配送の事実を残す必要があるなら Outbox event。** **ここでの「独立」は実行責任の独立**（Queue の retry と DLQ が完了を管理し、発行元 DO は publish 以降を知らない）**であって、Worker が物理的に分かれていることではない**（AD-13）。物理的な分離は運用判断であり、分類を動かさない。
3. **それ以外で、特定の DO または saga コーディネーターが完了責任を持って後から再開するなら local job（`jobs` + Alarm）。**

**外部 I/O であることも、cross-DO RPC であることも、単独では Outbox の条件にしない。** 外部 I/O は「トランザクションの中では実行できない」を意味するだけで、実行責任がどこにあるかを何も言わない。cross-DO RPC は `resume-*` / `finalize-withdrawal` / `sweep-orphan-mapping` が示すとおり、コーディネーター DO が状態機械の完了責任を持つので local job である。

初期値は `send-mail` が Outbox、残る11種が local job。**変更には「実行責任の所有者が誰か」に基づく理由が要る。**

### Consequences

- 良い点: `jobs` から外部 I/O が消え、**「local job はすべて DO ローカルで完結する」が新しい不変条件になる。** `jobs` を読む側は「この表の行はネットワークに出ない」と仮定してよくなる。
- 良い点: 「将来 consumer が要るかもしれない」でイベントを増やす動機が規則で塞がれる（判定 2 が「独立 consumer へ委譲する」を要求するので、consumer が無いイベントは類型を名乗れない）。
- トレードオフ: 判定 2 と 3 の境界は「独立してスケールさせたいか」という運用判断を含み、機械的には決まらない。**だから全数表に理由を書く欄を持たせるのではなく、`kind` / `type` を足すときに3規則のどれで当たったかをレビューで問う形にする。**
- トレードオフ: `.adr/004` が置いた「外部 I/O は必ず永続ジョブに載る」という**十分条件の言い回しが失効する。** 外部 I/O は「同期実行ではない」ことしか含意しなくなる。**この一文は `.adr/004` の決定の第3項ではなく第2項（L24）に入っている**ので、ステータス注記の失効範囲を第3項だけに書くと取り残される（AD-12 が注記の文言を持つ）。

---

## AD-2: `outbox_events` を独立したテーブルにし、`jobs` に相乗りさせない

### Status

Proposed

### Context

`jobs` は既に `operation_key` / `kind` / `payload` / `payload_digest` / `attempt` / `next_run_at` / `status` / `lease_until` / `owner_token` / `provider_idempotency_key` / `terminal_reason` / `completed_at` の12列を持ち、claim・CAS 完了・backoff・poison・prune の規約が完成している。イベントを `kind = 'publish-event'` の行として載せれば表もランナーも1本で済む。

しかし `jobs` の同一性規約は「**同じ `operation_key` の再投入は既存行へ収束する**」であり、収束規則3つ（早める方向のみ / `poison` は復帰 / `done` は5種だけ復帰）がその上に載っている。イベントは「起きた事実」なので**収束してはならない** — 2回起きた事実を1行に畳むと、片方が配送されない。

### Decision

**`outbox_events` を `jobs` とは別のテーブルとして、両 DO クラスに置く。共通化するのは列名・状態遷移・Alarm scheduler・backoff・lease・prune の規約であり、分離するのは同一性と配送状態である。**

- **訂正（レビュー3周目・W-004）: 「共通化する規約」は Alarm scheduler / backoff / lease / prune の4項である。** 列名と状態遷移そのものは項目として数えず、同名・同意味であることは下の「揃える列（8つ）」が、値域の差は分離する側の「配送状態の値域」が持つ（`.adr/013` の 2. / `spec/database/index.md` と同じ4項）。上の Decision 本文の6項の列挙はそれ以前の版であり、**確定した数は4項である**。
- **訂正（レビュー4周目・W-003）: 「分離する規約」も3項である**（同一性と収束の有無 / 配送状態の値域 / 終端時に `NULL` にする列）。**上の Decision 本文の2項の言い方はそれ以前の版であり、確定した数は3項である**（`.adr/013` の 2. / `spec/database/index.md` / `ADP-outbox-events-001` と同じ3項）。3つ目（終端時に `owner_token` を `NULL` にしない）は AD-6 の 2. が「これは AD-2 が言う『分離する規約』の1つ」として帰属させているものである。**削除の対象集合が違うこと（`jobs` は終端2値の両方を消し、`outbox_events` は `published` だけを消す）は4つ目として数えず、値域の分離の帰結として畳む。**
- **揃える列（8つ）**（`jobs` と同名・同意味にして、ランナーの実装を共有できるようにする）: `payload` / `attempt` / `next_run_at` / `status` / `lease_until` / `owner_token` / `terminal_reason` / `completed_at`。**`payload` は両表が持つ共有列である** — `outbox_events` 固有として数えると、`jobs` の列数（AD-8 で `provider_idempotency_key` を落として11列）と算術が合わなくなる。
- **`outbox_events` 固有の列（5つ）**: `id`（`EventId`。`IdGenerator` が採番する不変の主キー）/ `type` / `aggregate_id` / `occurred_at` / `created_at`。**`created_at` は行が Outbox に載った時刻であり、`occurred_at`（ドメインが決めた発生時刻）とは別物である** — backlog の滞留時間を読む起点は前者であり、後者はドメインが過去の時刻を入れうるので滞留の観測に使えない。`dedupe_key` は置かない（AD-7）。`provider_idempotency_key` も置かない（AD-8）。
- **`jobs` 固有の列（3つ）**: `operation_key`（同一性）/ `kind` / `payload_digest`。**この3つが「収束する表」と「収束しない表」を分けている実体である。** 以上より `jobs` は 8 + 3 = **11列**、`outbox_events` は 8 + 5 = **13列**である。
- `status` の値域は `pending` / `publishing` / `published` / `quarantined`。`jobs` の `pending` / `running` / `done` / `poison` と**形は同じで名前が違う** — 名前を分けるのは、`done`（仕事が終わった）と `published`（Queue へ渡した。処理されたとは言っていない。AD-10）が意味として別物だからである。

### Consequences

- 良い点: 「イベント行は決して収束しない」が表の分離として構造に出る。`jobs` の収束規則3つを `outbox_events` に誤って適用する経路が無くなる。
- 良い点: 保持期間を別に決められる。配送済みイベントと完了ジョブでは監査上の価値も行の大きさも違う。
- トレードオフ: テーブルが2つ増え（両 DO クラス）、`spec/database/index.md` の全数表・OCC 表・リレーション図・索引確認表・`spec/inventory/adapter.md` の schema 行がすべて2行ずつ増える。数え上げの同時修正義務が増える。
- トレードオフ: claim / backoff / lease / prune のロジックを2表で共有する実装上の抽象が要る。共有しないと規約が二重管理になり、`.thread/34/design.md` 第1.4節が記録した「片方を直すともう片方が取り残される」破れが再発する。

---

## AD-3: `outbox_events` を両 DO クラスに置く（User Data DO のイベントが初期0件でも）

### Status

Proposed

### Context

初期分類では Outbox に載るのは `send-mail` の1件だけで、その所有者は Identity Directory bucket である。したがって **User Data DO の `outbox_events` は初期状態で1行も持たない。** 「consumer が存在しないイベントは発行しない」という規則からすると、User Data DO 側の表は空のまま置かれる。

`.adr/001` は「理由が消えたら設定も消す」という態度を採っており、使われない機構を残すことに repo の設計態度は否定的である。

### Decision

**共通 schema を両クラスに置く。** ただし「置く」のは**表と機構**であって、**イベント型ではない。** User Data DO のイベント型は初期0件であり、全数表にその旨を明示する。

理由は3つ。

1. `jobs` が既に「同じ形の表を両クラスに持ち、違うのは `kind` の値域だけ」という前例を作っている（`spec/database/index.md` L652）。**同じ前例に揃えるほうが、2クラスで機構を共有するという事実を表現できる。**
2. **契約を2クラスで同一に保てる。** 「DO ローカル Outbox」という契約が DO クラスによって「ある / ない」に割れると、`spec/` も `CLAUDE.md` も「Identity Directory DO では」という限定を全箇所に付けて回ることになる。**なお、片方に後から足すコストを理由にはしない** — `outbox_events` は新設・空テーブルなので、追加は `CREATE TABLE` + 空テーブルへの索引の**単発適用**で足りる（`spec/database/index.md` L707–709）。`migrate-bulk` は行のコピーのための機構であり、コピーすべき行が0件のここでは出番が無い。**この誤読は旧稿の理由2 が置いていたもので、撤回する。**
3. Alarm の多重化（AD-4）は両クラスで同じ実装になる。片方に表が無いと、多重化のコードが DO クラスで分岐する。

**「使われない機構は消す」との衝突は受け入れる** — 消す対象は「理由の消えた機構」であり、ここでは理由（DO ローカル Outbox という契約を2クラスで同一にする）が生きている。

### Consequences

- 良い点: 2クラスの Alarm ランナーが同一実装になる。
- 良い点: User Data DO のイベント（例: 将来の監査配送、外部連携）を足すときに schema migration が要らない。
- トレードオフ: 空の表が1つ増える。**これを「consumer 不在のイベントを定義した」と読み違えられないよう、全数表に「User Data DO のイベント型: 0件」を明示的な行として書く。**

---

## AD-4: 1本の Alarm で Outbox relay と local jobs を多重化する — relay を `jobs.kind` にしない

### Status

Proposed

### Context

1 DO につき Alarm は1本しか持てない（`.thread/34/design.md` 第2.1節 F-2）。`jobs` は既にこの1本を「最も早い `next_run_at`」で張り直す形で使っている。`outbox_events` が第2の起床要求元になる。

`spec/database/index.md` L703 は `alarm()` の中の順序を **(1) Alarm の再武装 + 永続化の確認 → (2) migration ゲート → (3) 仕事** と固定している。L701–702 はゲートが `await` ゼロの同期関数であることを要求している。

### Decision

**2つの表を1本の Alarm で多重化する。relay を `jobs` の1種別（例 `relay-outbox`）にはしない。**

- **起床時刻の決め方**: `setAlarm(min(J, O))`。`J = min(jobs.next_run_at) WHERE status IN ('pending','running')`、`O = min(outbox_events.next_run_at) WHERE status IN ('pending','publishing')`。**両方が空のときだけ `deleteAlarm()` する**（`spec/database/index.md` L487 の規則を2表へ拡張）。
  - **訂正（ステップ5 の実装中に確定した）: 納品物の形は4本の min の合成である。** `min(jobs.next_run_at) WHERE status='pending'` / `min(jobs.lease_until) WHERE status='running'` / `min(outbox_events.next_run_at) WHERE status='pending'` / `min(outbox_events.lease_until) WHERE status='publishing'` の4本を合成し、**正本は `spec/database/index.md`「Alarm の多重化」である**（`.adr/013` 4. も同じ形へ揃えた）。上の2本立ての式は次項の lease 算入規則と**字面で両立しない** — `status IN ('pending','running')` の範囲で `next_run_at` を採るのか `max(next_run_at, lease_until)` を採るのかが決まらない。4本へ分けてよい根拠は、**leased 行では `next_run_at ≤ lease_until` が常に成り立つ**ので `max` が必ず `lease_until` を採ることであり、分ける理由は**索引で解ける形にすること**である（`min(max(next_run_at, lease_until))` を1本の SQL にすると式を key にした索引が無く、実行可能集合の全走査が毎起床かかる）。**`deleteAlarm()` の条件は変わらない** — 判定に使うのは実行可能集合（`jobs`: `pending` / `running`、`outbox_events`: `pending` / `publishing`）の空判定であって、min の本数ではない。
- **lease 中の行（`running` / `publishing`）は `max(next_run_at, lease_until)` で算入する。** claim の CAS は第2選言で `lease_until` 満了を要求する（`spec/database/index.md` L459）ので、過去の `next_run_at` を持つ leased 行だけが残った状態で `next_run_at` をそのまま採ると、「起床 → 1行も claim できない → 同じ過去時刻へ張り直す」の空転になる。**これは `jobs` 側に既に存在する曖昧さであり、本 Issue が作ったものではない** — Alarm 多重化の規則を書き下ろすこの機会に両表へ同じ形で確定させ、#51 が実装時に自前で決めずに済むようにする。
- **`alarm()` の中の順序**: (1) 再武装 + 永続化確認 → (2) migration ゲート → (3-a) **outbox relay パス** → (3-b) **jobs パス** → (4) 両表から再計算して張り直す。
- **公平性は「毎回の起床で両方のパスを必ず1回通す」で担保し、上限は各パスが独立に持つ。** 片方が上限を使い切っても他方は必ず走る。上限を共有すると、片方の滞留がもう片方を飢えさせる。
- **relay は `queue.send()` を await するのでゲートの中には置けない**（ゲートは同期関数）。したがって relay は必ず (3-a) に来る。
- **fail-closed で止まっている DO は relay もしない。** ゲートで戻るので (3-a) に到達せず、outbox 行は滞留する。**滞留は失われた配送ではない**（行は残り、コード更新後の起床で流れる）ことを明記する。
- relay の1回のパスは3相で、**Queue への送信だけがトランザクションの外**にある。
  1. `transactionSync`: 実行可能な行を件数上限まで claim（`status='publishing'`、`lease_until` / `owner_token` を CAS で書く）
  2. トランザクション外: Queue へ publish
  3. `transactionSync`: `published` へ落とす／失敗なら `attempt` を進め backoff で `next_run_at` を先送り／上限超過は `quarantined`
  - **訂正（AD-42）: 相3 の失敗分岐（上限未到達）で書く列を確定させた。** 同じトランザクションで `status='pending'` へ戻し、`lease_until` / `owner_token` を解放したうえで `attempt` と `next_run_at` を書く。上の書き方は `status` / `lease_until` / `owner_token` の扱いを書いておらず、素直に読むと行が `publishing` のまま残って**4本の min の根拠になっている不変条件（leased 行では `next_run_at ≤ lease_until`）が破れる。** 理由は AD-42 を読むこと。

### 検討した代替案

**relay を `jobs.kind = 'relay-outbox'` の再武装ジョブにする** — 表もランナーも1本になり、Alarm の計算も1箇所で済む。採らなかった理由は、**起床時刻の権威が二重化する**こと。ジョブ行の `next_run_at` と outbox 行群の `min(next_run_at)` の両方が「次に relay すべき時刻」を主張し、片方が取り残される。加えて backoff の単位が食い違う — outbox の backoff は**行ごと**（1件だけ失敗したら1件だけ先送りしたい）だが、ジョブ行の `attempt` は1本しかない。さらに `.adr/010` の収束規則3つが relay ジョブに適用され、`done` からの復帰可否という無関係な判断が要る。

**Outbox 専用の第2の Alarm を持つ** — プラットフォームが許さない（1 DO 1 Alarm）。

**Queue の cron や consumer 側から DO を叩いて relay させる** — 起動契機が DO の外になり、「Alarm が relay の起動契機である」という Issue の決定に反する。加えて全 DO を舐める外部スケジューラが要り、`.adr/002` の「全ユーザーを1バッチで舐める定期実行は存在しない」と衝突する。

### Consequences

- 良い点: Alarm の張り直しが1つの式（`min(J, O)`）に閉じ、「投入されるが二度と起きない」の検出単位が変わらない。
- 良い点: relay の失敗が行単位で backoff され、1件の poison が他の配送を止めない。
- トレードオフ: `alarm()` の1回の実行時間が2パスぶんになる。上限を2組（ジョブ側3階層 + relay 側）持つことになり、運用値の決定点が増える（実体は #38）。
- トレードオフ: **PITR で巻き戻すと `published` が `pending` に戻り、再 relay で重複配送になる。** at-least-once なので正しさは壊れないが、`spec/database/index.md` の PITR チェックリストに追加が要る。

---

## AD-5: イベント登録口は `collectEvents` を復元せず `enqueueEvent` を新設する。relay を**ドメインポートにしない**

### Status

Proposed

### Context

`main` のコードには `UnitOfWorkContext.collectEvents(drafts: readonly EventDraft[]): void` が残っている。これは**非同期 UoW 用**で、コミット時に flush するバッファリング契約だった（`packages/core/src/application/execution/unitOfWork.ts`）。新しい UoW は完全同期の `transactionSync` なので、登録はその場で `outbox_events` へ INSERT できる。

一方 `.adr/010` は「投入口は UoW コンテキストの `enqueueJob` に一本化する」を決めており、`spec/domains/trash.md:242` はその論証（「投入口はポートではなく UoW コンテキストである」）を持っている。

もう1つ、`spec/domains/index.md:34` は**ドメインポートの同期契約の例外が `PasswordHasher` と `MailSender` の2つだけ**であることを、列挙として固定している。relay の `queue.send()` は非同期 API しか無い。

### Decision

- **登録口は `UnitOfWorkContext.enqueueEvent(drafts: readonly EventDraft[]): void` とし、`collectEvents` は復元しない。** 名前を `enqueue*` に揃えるのは、(i) `enqueueJob` と同じ「同期トランザクションの中で行を1本書く」動作だから、(ii) `collect` はバッファリングを含意し、同期 INSERT の実体と食い違うからである。**書き込み口はこれ1つに固定する。**
- **`EventId` の採番は UoW 実装が `IdGenerator` に対して行い、ドメインは identity-less な `EventDraft` を返す。** 既存の `DomainEventDraftBase` / `EventDraft` / `attachEventIds`（`packages/core/src/domain/common/event.ts`）の契約をそのまま spec 側の契約として採る。
- **relay をドメインポートにしない。** Queue producer binding はアダプター（DO クラス）の内部実装であり、ドメインもユースケースも触らない。**したがって `spec/domains/index.md:34` の「例外は2つ」という列挙は維持される。**
- **`RelayTrigger`（`kick()`）は復元しない。** D1 時代は relay が別 Worker だったので即時起動のキックが要ったが、DO ローカルでは登録と同じトランザクションのあとに `setAlarm` を張るだけで足りる。

### 検討した代替案

**`collectEvents` をそのまま復元する** — PR #49 の差分や git 履歴と語彙が揃う。採らなかった理由は、名前がバッファリングを含意し、`enqueueJob` と非対称になること。**本 Issue は語彙の連続性より契約の正確さを採る。**

**イベント登録をドメインポート（`EventPublisher`）にする** — 素直だが、ポートは DI で単独注入でき、**トランザクションの外からイベントだけを書く経路が構造的に残る。** `.adr/005` が `SearchIndexPort` の書き込み側をポートにしなかったのとまったく同じ理由で採らない。

**relay を非同期ドメインポートとして足す** — `spec/domains/index.md:34` の2件の列挙を3件に開くことになる。relay はドメインの語彙を1つも必要としない純粋な配送機構なので、開く理由が無い。

### Consequences

- 良い点: UoW コンテキストの副作用登録点が `enqueueJob` / `enqueueEvent` / `recordOperation` / `updateOperation` / `setMigrationCursor` の5つになり、すべて同じ形（同期・戻り値なし・行を1本書く）で並ぶ。
- 良い点: ドメインポートの同期契約の例外が2件のまま動かない。
- トレードオフ: 非集約ストアと書き込み口の数え上げが動き、`spec/database/index.md`（L79 / L749 / L753 / L754）・`spec/domains/identity.md:378`・`CLAUDE.md:68` を同時に直す義務が生じる。**本 AD 単独の寄与は「+1ストア・+1メソッド」だが、AD-16 の窓ストアが同じ数にさらに +1 ずつ効くので、書き込む値は合算後の 7つ→9つ / 6ストア7メソッド→8ストア9メソッドである。** 単独の寄与だけを書き写すと取り残しになる。
- トレードオフ: コード側の `collectEvents` は #51 で改名になる。本 Issue はコードに触らない。

---

## AD-6: consumer は event payload から送信内容を組み立てず、発行元 DO へ RPC で取りに行く

### Status

Proposed

### Context

`send-mail` を Outbox へ移すと、実行するのは DO の外の consumer Worker になる。ところが現行設計では、

- 宛先の原本（`encryptedCanonical`）を復号できるのは state Worker だけで、その復号が許される経路は限定されている（`.thread/34/design.md` 第6.2.1節）
- **生のリセットトークンはジョブ行に載せず、送信直前に bucket の中で `HMAC(IDENTITY_RESET_TOKEN_KEY[generation], tokenId)` から導出する**（`spec/usecases/identity.md:206`）

Issue の受け入れ条件は「PII と再利用可能な秘密が event payload、ログ、terminal reason へ出ない」である。**メールアドレスもリセットトークンも、その両方に当たる。**

### Decision

**event payload には「どの DO の、どの `tokenId` について送るか」だけを載せ、consumer は発行元 DO へ RPC して、レンダリング済みの送信材料を取得してから provider を呼ぶ。**

- **訂正（AD-44）: 「レンダリング済み」は撤回した。** RPC が返すのは**宛先・生リセットトークン・`providerIdempotencyKey`** の3つであり、URL の組み立てとメール本文のレンダリングは `MailSender` アダプター（request Worker）が行う。理由は AD-44 を読むこと。**RPC が「送信材料の取得」であって「送信」ではないこと、および復号と HMAC 導出が DO の中に閉じることは変わらない。**

- payload に載せるもの: `tokenId`（識別子）/ メール種別 / **発行元 Identity Directory bucket の routing key**（`.adr/002` により既に鍵付きハッシュ済みの内部キーであり、生のメールアドレスでも SSO subject でもない）。
  - **訂正（AD-40）: 3つ目の routing key は payload から落とした。** ドメイン payload は `tokenId` / メール種別の**2つだけ**であり、routing key は relay が publish 時に Queue メッセージへ押す項目である。理由は AD-40 を読むこと。**Queue メッセージが5項目のうちの1つとして routing key を運ぶことは変わらない。**
  - **訂正（レビュー2周目・W-019）: routing key の粒度は発行元 DO 自身の locator（`dir:g{世代}:b{番号}`）であり、クレデンシャル単位の鍵付きハッシュではない。正本は `spec/async/index.md`「Queue メッセージ」。** 上の括弧書き（「`.adr/002` により既に鍵付きハッシュ済みの内部キー」）はそれ以前の版である。**クレデンシャル単位の内部キー（canonical の全長 HMAC）を Queue メッセージに載せると、窓で切れない仮名が DLQ に残り、`aggregate_id`（窓キー）を Queue から外した理由（DLQ 上での宛先相関）をそのまま無効化する。**
- payload に載せないもの: メールアドレス、生トークン、`userId`、その他の PII。
- consumer が呼ぶ RPC は「送信材料の取得」であって「送信」ではない。**復号と HMAC 導出は DO の中に閉じたまま**で、consumer が受け取るのは送信直前の完成品である。**訂正（AD-44）: 「送信直前の完成品」は本文ではなく送信材料3点である。DO の中に閉じるのは復号と HMAC 導出であって、レンダリングではない。**
- **RPC の応答は2分岐のタグ付きユニオンであり、これが全数である。**
  - `send` — 宛先・レンダリング済み本文・`providerIdempotencyKey` を持つ。consumer はこれを provider へ渡す。**訂正（AD-44）: 中身は「宛先・生リセットトークン・`providerIdempotencyKey`」の3つである。分岐が2つで全数であることは動かない。**
  - `nothing-to-send` — **理由を1つも載せない空の分岐である。** 未登録 / SSO 専用 / 消費済み / 期限切れ / より新しい発行に置き換えられた、のいずれであっても同じこの1値が返る。consumer は no-op して ack する。**失敗ではない。**
- **`superseded` と `no-recipient` を分けた旧案は撤回する。** 理由は2つあり、どちらも単独で決定的である。(i) **DO 側の状態から区別できない** — `spec/usecases/identity.md:205` と `ADP-identity-014` により、発行はそのクレデンシャル宛の未使用トークン行を同じトランザクションで**全削除**する。したがって supersede された `tokenId` の行は痕跡なく消え、payload が持つのは `tokenId` だけなので、行が無いときに DO は `credential_id` へ辿ることすらできない。**AD-7 が「発行が起きるのは窓の最初の依頼のときだけ」へ改めた後もこの論拠は変わらない** — 同一窓では発行そのものが1回しか起きないので supersede は生じず、supersede が生じるのは窓をまたいだときだけで、そのときは新しい窓の最初の依頼が全削除を実行するからである。(ii) **区別できること自体が列挙オラクルになる** — consumer は DO の外にあり、応答は consumer のログにも DLQ にも落ちうる。`no-recipient` が観測できれば「そのアドレスは未登録 / SSO 専用である」が DO の外へ漏れる。**分岐を1つに畳むのは実装上の妥協ではなく、決定2（PII と秘密を DO の外へ出さない範囲）の延長である。**
- **「なぜ送らなかったか」を consumer 側に残さない。** 運用の追跡が要るなら DO 側の観測（メトリクス）に閉じる。依頼者への応答にも一切現れない（列挙オラクル対策は DO の transaction 内で完結している。AD-7）。
- **`providerIdempotencyKey` は DO が導出してこの応答に載せる。** 導出鍵は DO 側にあり consumer 側では導けないので、`outbox_events` の列にもせず（AD-8）、consumer にも鍵を配らない。応答に載せることで、`event.id` から決まる値が「秘密を持たない側」へ渡る唯一の経路になる。
- **呼び出しガードを置く。** 生トークンは `HMAC(IDENTITY_RESET_TOKEN_KEY[generation], tokenId)` で導かれ、`tokenId` は Queue メッセージと DLQ を通って DO の外に出る。**この RPC が無条件だと「`tokenId` を知る者 = リセットリンクを引ける者」になる**ので、次のガードを掛ける。
  1. **応答が `send` になるのは、次の3条件がすべて成り立つときだけである。** (a) その `event.id` の行が `outbox_events` に**存在する**、(b) 行が `quarantined` **でない**、(c) 呼び出しが持つ**不透明な `owner_token` が行の値と一致する**。1つでも満たさない呼び出しは `nothing-to-send` を返す（**理由は返さない** — ここでも分岐を増やさない）。`event.id` と `owner_token` の対は Queue メッセージが運ぶ。
     - **`status` は照合条件に入れない。** 配送は at-least-once であり、consumer が Queue からメッセージを受け取って RPC を打つのは relay の相 3（`published` への落とし込み）の**後**である。`status = 'publishing'` を条件にすると**正常系の配送が全滅する**（AD-10 が `published` を「Queue へ渡した。処理されたとは言っていない」と定義していることとも整合しない）。**二重送信の抑止は `status` ではなく `providerIdempotencyKey` が担う。役割を混ぜない。**
     - **同一性の判定は `owner_token` が単独で負う。** 再 claim が起きれば `owner_token` は書き換わるので、古い Queue メッセージを持った consumer の呼び出しは (c) で弾かれて `nothing-to-send` に落ちる。lease と CAS の意味論をそのまま外側の照合に流用する形であり、新しい状態を1つも足さない。
  2. **`outbox_events` は終端時に `owner_token` を `NULL` にしない。** `jobs` は `done` / `poison` へ落とすときに `lease_until` / `owner_token` / `next_run_at` を `NULL` にする（`spec/database/index.md` L460 付近）が、`outbox_events` の `owner_token` は**終端後も照合材料として残す**。`lease_until` / `next_run_at` は `jobs` と同じく `NULL` にする。**これは AD-2 が言う「分離する規約」の1つであり、書き落とすとガードの 3. が `published` の行に対して必ず失敗し、1. の訂正がそのまま無効になる。**
  3. **DLQ の保持期間 < リセットトークンの TTL を運用値の制約として書く**（値の確定は #38）。満たしていれば DLQ からの再駆動が成功しても、トークンは既に失効している。満たせない場合は 1. のガードだけが有効な防壁になるので、**択一ではなく両方置く。**
     - **訂正（AD-37）: この根拠は不等式が意味することの逆である。** `DLQ 保持期間 < TTL` なら再駆動は TTL の内側に収まり、**トークンは生きている。** したがって制約1 は**機能要件**（再駆動が有効なリンクを届けられる）であって持参人証への防壁ではない。防壁は AD-36 の禁止則（ログ非出力・DLQ 非転送）と DLQ への到達制御（#38）の2本である。
     - **訂正（レビュー4周目・B-003）: 制約1 の左辺は `Queue の最大 retry 期間 + DLQ の保持期間` である。** 確定形は **`Queue の最大 retry 期間 + DLQ の保持期間 < リセットトークンの TTL`** で、上の 3. の本文（`DLQ 保持期間 < TTL`）はそれ以前の版である。**`DLQ の保持期間 < TTL` とだけ書くと、機能要件（DLQ 滞在の末期に再駆動しても有効なリンクを届けられる）が導けない** — 再駆動の時点でトークンが経過しているのは DLQ の滞在時間だけではなく、その前に Queue が retry を焼き切るまでの時間も含むからである。**不等式の方向も、AD-37 が確定させた「制約1 は防壁ではない」も動かない。**
  4. **`published` 行の保持期間 ≥ Queue の最大 retry 期間 + DLQ の保持期間**（値の確定は #38）。ガードが行の存在（1.）を要求する以上、prune が行を消した後の DLQ 再駆動は必ず `nothing-to-send` になる。**上側（3.）だけを書くと、値の決定者が両立しない2値を選べてしまい、再駆動が恒久的に空振りする** — その形は運用上ほとんど検出できない。3. と合わせて `Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間` かつ `DLQ 保持期間 < トークン TTL` が制約の全数である。
     - **訂正（レビュー4周目・B-003）: 総括の後半も左辺を揃える。** 確定形は **`Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間` かつ `Queue 最大 retry + DLQ 保持期間 < トークン TTL`** である。**2本は左辺が同じ `Queue 最大 retry + DLQ 保持期間` で、上限として置く相手だけが違う**（`published` 行の保持期間とリセットトークンの TTL）。相手は独立に決まる運用値なので片方から他方は導けず、**「配送の運用値の制約は2本で全数」は動かない。**

### 検討した代替案

**relay が publish 直前に生トークンを導出して payload に載せる** — consumer が1回で完結する。採らなかった理由は、**Queue のメッセージと DLQ に再利用可能な秘密が載る**こと。DLQ の行は運用者が読む場所でもある。受け入れ条件と正面から衝突する。

**consumer Worker に `IDENTITY_RESET_TOKEN_KEY` とメール暗号鍵を配る** — RPC 1往復が消える。採らなかった理由は、**復号鍵と HMAC 鍵を持つ Worker が増える**こと。`apps/web/.dev.vars.example` は「どの秘密がどの Worker に属するか」を宣言する設計になっており（現に `SESSION_SECRET` に `Only the request-path Worker needs it.` と書いている）、鍵の帰属を増やすのはその宣言を弱める。**本案でも consumer はメール provider の API キーを持つことになるので、「秘密を1つも持たない」は最初から成立しない** — 却下の実質は「持つ秘密を provider の API キー1本に留める」である。

**呼び出しガードに `status = 'publishing'` を含める（撤回した旧案）** — 「送信材料を引けるのは relay が lease を握っている最中だけ」という素直な読みで、lease の意味論とも揃って見える。採らなかった理由は、**その窓が consumer には決して見えない**こと。relay の相 2（publish）と相 3（`published` への落とし込み）のあいだに consumer が動く保証は無く、実際には Queue の配送遅延のぶんだけ必ず後になる。したがって条件を課すと**すべての依頼が `nothing-to-send` に落ちてリセットメールが1通も送られない**。同一性の判定は `owner_token` が単独で担えるので、`status` を足す利得も無い。**この案は2周目の反映で spec 側の文言まで落ちていたので、撤回であることを明示して残す。**

**`send-mail` を local job のまま残す** — 上記の問題がすべて消える。**採らないのは Issue #50 が `send-mail` を Outbox の初期値として決めているからであり、設計上の優劣で決めたのではない。** AD-1 の3規則に照らすと「メール送信の実行責任を独立 consumer へ委譲する」は規則2に当たり、Outbox が正しい。ただし本案が RPC 1往復を足していることは、この分類のコストとして記録しておく（差し戻し条件は全数表の `send-mail` 行に残す）。

### Consequences

- **保証範囲は「載らない」であって「越えない」ではない。** 保証するのは次の3つだけである。
  1. `outbox_events.payload` / Queue のメッセージ / DLQ のメッセージ / ログ / `terminal_reason` のいずれにも、PII と再利用可能な秘密を**載せない**。
  2. 宛先メールアドレスと生トークンは、**送信材料 RPC の応答と provider へのリクエストにのみ存在し、どこにも永続化されない**。
  3. 復号鍵と HMAC 導出鍵は DO の中から出ない。**訂正（レビュー4周目 → 5周目・W-002）: 「HMAC 導出鍵」と無限定に書かない。** DO の中から出ないのは **宛先の復号鍵・リセットトークンの導出鍵・`providerIdempotencyKey` の導出鍵の3つ**であり、**canonical を全長 HMAC へ写す写像鍵は bucket 選択のために request Worker 側（stub 選択アダプター）にある**（AD-45）。正本は `spec/async/index.md` の衛生規則。
- **「PII と秘密が DO の境界を出ない」は撤回する。** `MailSender.sendPasswordResetMail(to, resetToken)`（**確定した signature は第3引数 `providerIdempotencyKey` を持つ3引数形である。** この項の 2引数表記は本 AD を書いた時点の記録であり、正本は `spec/domains/identity.md` の `MailSender`）を呼ぶ以上、宛先と生トークンは RPC 応答として確実に境界を越え、**配送の瞬間だけ consumer のメモリに載る**。撤回しないと、後任が「consumer には秘密が渡らない」を前提に consumer 側のログ方針や秘密管理を緩める導線になる。
- **consumer は秘密を扱う実行主体である。** メール provider の API キーが帰属し、宛先と生トークンを一時的に保持する。`CLAUDE.md` の「Each Worker has its own, non-overlapping set of secrets」の対象が1件増える（帰属先は AD-13。`.dev.vars.example` の実際の追記は #51）。
- 良い点: 送信直前に権威（`credential_mappings` の `passwordVerifier` の有無、トークンの生存と supersede）を読み直すので、**イベント発行後にトークンが消費・失効・置換された場合に古い材料で送らない。** 素朴な payload 方式ではこれが守れない。
- トレードオフ: consumer → state Worker の service binding が要る（実装は #51）。配送1件あたり RPC が1往復増える。
- トレードオフ: **`status` を照合しないことで、`(event.id, owner_token)` の対が「送信材料を引ける持参人証」になる露出窓が、lease の長さから `published` 行の保持期間へ広がる。** 対は Queue メッセージと DLQ を通るので、DLQ を読める運用者はその期間だけリセットリンクを引ける。**これは `status` 照合では防げなかった** — 照合を残すと正常系が成立しないので、実際には守れていない防壁だった。実効的な防壁は運用値の制約 3.（`DLQ 保持期間 < トークン TTL`）であり、**上限を短く保つことが唯一の手段である**ことを #38 への引き継ぎに書く。`owner_token` を再 claim ごとに更新する規則（AD-4）が、古い対を無効化する二次的な絞りとして効く。**訂正（AD-36 / AD-37）: 制約 3. は防壁ではない。** 防壁は AD-36 の禁止則（Queue メッセージをログへ出さない / DLQ メッセージを外部へ転送しない）と DLQ への到達制御（#38）の2本であり、`owner_token` の再採番が二次的な絞りとして効くことだけは変わらない。
  - **訂正（レビュー4周目・W-007）: 露出窓を「`published` 行の保持期間ぶん」と量らない。** **露出窓は `published` 行の保持期間で上から押さえられているわけではない。** prune はジョブランナーの起動末尾でしか走らないので、**終端行しか残っていない DO は定義上 `deleteAlarm()` 済みで起床せず、保持期間を過ぎた `published` 行が次の投入まで残る。** ただし**実効的な上限はリセットトークンの TTL である** — 行が残っていても、TTL を過ぎたトークンについては送信材料 RPC が `nothing-to-send` を返すので宛先も生トークンも引けない。**「行の存在」は `published` の保持期間では有界でなく、「引ける材料」は TTL で有界である**（`.adr/013`「影響」/ `spec/async/index.md`「呼び出しガード」/ `plan.md` P-002 と同じ形）。**`status` を照合しないという決定そのものは動かない。**
- トレードオフ: consumer から DO を呼ぶ経路が1本増えるので、`.thread/34/design.md` 第5.1節の RPC エントリ分類に相当する扱いが要る。**この RPC は `userId` を公開入力から受け取らない**（event payload の routing key から選ぶ）ことを明記する。
- トレードオフ: **AD-1 の判定規則2の根拠が細る。** consumer が実際に担うのは provider 呼び出し1回だけで、送信材料の解決・宛先の有無・トークン生存の再確認はすべて DO へ戻る。「実行責任を独立してスケールする consumer へ委譲する」に照らすと委譲されている責任は薄い。**この事実は `.adr/013` の「影響」に残し、全数表の `send-mail` 行の差し戻し条件と対にする** — 後任が分類を再評価できるようにするためである。

---

## AD-7: `dedupe_key` による行の収束は採らない。連打の抑止は DO transaction 内のスロットル判定、最新性は送信時の再読で保つ

### Status

Proposed（**`dedupe_key` を置く旧案を撤回して差し替えた。旧案は「検討した代替案」に残す**）

### Context

現行の `send-mail` は `operationKey`（対象 canonical の全長 HMAC + 依頼の窓）で**同一メールアドレスへの連打を1本のジョブ行に収束**させ、「書き込みと起床は依頼回数ではなく**時間の窓の数**に比例する」を成立させている（`spec/usecases/identity.md:208`）。これは単なる最適化ではなく、未認証経路の濫用に対する防壁の一部である。

素朴な Outbox は「1イベント1行・不変」なので、この性質が失われる。N 回の依頼が N 件のイベント・N 件の Queue メッセージ・N 通のメールになる。

同時に、`spec/usecases/identity.md:203` の「**4ケースで処理経路を完全に一致させる**（同じトランザクションで行を1行書き、同じ起床を張り、同じ応答を返す）」という列挙オラクル対策も維持しなければならない。

**旧案（`outbox_events` に `dedupe_key` 列と部分 UNIQUE 索引を置き、2行目を作らない）は、AD-6 と合成すると機能が壊れる。** `spec/usecases/identity.md:205` は「発行はそのクレデンシャル宛の未使用トークンをすべて置き換える」と定めている。同一窓内の2回目の依頼が来ると、`issue()` が1回目のトークンを消すのに、`dedupe_key` の衝突で新しい行は作られない。残った1行の payload は1回目の `tokenId` を指したままなので、送信時の再読で「そのトークンは無い」に落ちる。**2回依頼して0通**になり、窓の長さぶんこの状態が続く。

### Decision

**`dedupe_key` 列と部分 UNIQUE 索引は置かない。`outbox_events` は例外なく「1イベント1行・不変」である。** 現行の3性質は、行の収束ではなく次の2つで保つ。

1. **連打の抑止は「イベントを発行するか否かの判断」を DO の transaction 内に置くことで行う。** スロットルの窓の状態（対象 canonical の全長 HMAC + 依頼の窓）を読み、その窓で既に発行済みなら**イベント行を書かない**。窓の状態の更新（スロットル計上）も同じ transaction の中で行う。
   - **窓が消費済みの場合は、イベント行だけでなくトークンの発行も行わない**（`PasswordResetTokenPort.issue()` を呼ばない）。**発行判断と窓判定は同じ1つの分岐であり、2つの独立した条件ではない。** 分けると、2回目の依頼が `issue()` を呼んで1回目の未使用トークンを全置換する（`spec/usecases/identity.md:205`）のにイベント行は書かれない、という状態になり、**(a) 1通目が未送信なら送信時再読が `nothing-to-send` に落ちて0通、(b) 1通目が送信済みなら利用者の手元のリンクが死ぬ** — 旧 `dedupe_key` 案を撤回させた「2回依頼して0通」の破れが別経路で復活する。
   - **したがって `spec/usecases/identity.md:205` は無改訂で残さない。** 「発行はそのクレデンシャル宛の未使用トークンをすべて置き換える」という**全置換の規則そのものは維持**したうえで、**発行が起きるのは窓での最初の依頼のときだけである**という前提条件を足す。2回目以降の依頼は何も発行せず、**既存の未使用トークンをそのまま有効に保つ。**
   - この形は4ケース一様性と矛盾しない。発行するか否かを決めるのは依然として**窓の状態だけ**であり、登録有無・認証方式・宛先の存在を参照しない。
   - **列挙オラクル対策は保たれる。** 発行するか否かを決めるのは**スロットルの窓の状態だけ**であり、クレデンシャルの登録有無・認証方式・宛先の存在を一切参照しない。窓のキーは canonical から導くので4ケースのどれでも同じ値が出る。**したがって同じ窓の状態に対して、4ケースは一様に落ちる** — その窓での最初の依頼なら**4ケースとも必ずちょうど1行**（0行でも2行でもない）、既に発行済みの窓なら**4ケースとも1行も書かない**。分岐が観測されうるのは窓の状態の差だけで、これは依頼者自身の依頼履歴であって他人の登録有無ではない。
   - **窓ストアの行のほうは、登録の有無に関係なく必ず作る**（AD-16）。窓ストアに行が有るか無いかが4ケースで割れると、経路差がそのまま列挙オラクルになる。
   - **これを spec の要件として明記する** — 「同じ窓の状態に対して4ケースが一様に1行書くか一様に書かない」は検証可能な命題であり、`spec/testcases/identity/requestPasswordReset.md` の中心的な検証点として残す。**未登録アドレス側でも書き込み行数と起床の有無が登録済みの場合と一致する**ことをケースとして持つ（登録済み側だけを見ても一致は検証できない）。
2. **「最新のトークンだけが有効」は送信時の再読で保つ**（AD-6）。窓をまたいで複数行が並んだ場合、supersede 済みの行に対して DO は `nothing-to-send` を返し、consumer は no-op して ack する。**結果として届くのは常に「現在有効なトークンのリンク1通」である。**

- **「送らない側」の payload の形も4ケースで同一にする。** 未登録 / SSO 専用ではトークンが発行されないので `tokenId` に入れる実体が無いが、**列を nullable にしない** — `NULL` か否かが観測できると payload そのものが列挙オラクルになる。**宛先の有無から独立に生成した不透明値**（トークンと同じ形・同じ長さの乱数）を置き、送信材料 RPC は「その `tokenId` に対応する行が無い」を通常の `nothing-to-send` として扱う。**行の形が4ケースで一字も違わないことが、AD-7 の一様性の実体である。**
- **`id` は不変で、consumer の冪等性キーであり続ける**（AD-9）。行を書き換える経路は存在しない。
- スロットルの窓のキーは `jobs.operation_key` と同じ導出（対象の全長 HMAC + 依頼の窓）を使う。**クライアントから受け取らない**（`CLAUDE.md`「Cross-request idempotency keys never come from the client」）。
  - **訂正（AD-45 / レビュー3周目・W-005）: 根拠として `jobs.operation_key` の導出規則を引かない。** 現行の `jobs.kind` 11種はいずれもジョブの同一性から導く値（DO ごとの定数キー・`operationId` 由来・対象バージョンや世代由来）であり、「対象と時間窓から導く」形は旧 `send-mail` が使っていたもので現行には1つも無いので、引くと失効した規則を指すことになる。**キーの中身（対象 canonical の全長 HMAC と依頼の窓から決定的に導く）と「クライアントから受け取らない」は変わらない。導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節であり、導出主体は AD-45 が持つ。****窓の状態の物理的な置き場は Identity Directory DO の専用ストアであり、`credential_mappings` に相乗りさせない**（AD-16 が決めた。`credential_mappings` は未登録 canonical に行を持たないので、そこへ載せると 1. の一様性が構造的に成立しない）。

### 検討した代替案

**`outbox_events` に `dedupe_key` 列と部分 UNIQUE 索引を置き、同キーの終端していない行があれば2行目を作らない（旧 AD-7）** — 現行の収束の形をそのまま移せる。採らなかった理由は2つ。(i) 上の Context のとおり **AD-6 と合成すると「2回依頼して0通」の経路が生まれる**。行は不変なので payload は古い `tokenId` を指し続け、送信時の再読はそれを `superseded` に落とす。(ii) Outbox の契約そのものと両立しない — AD-2 が表を分けた理由は「イベントは起きた事実なので収束してはならない」であり、`dedupe_key` は同じ表にその例外を持ち込む。**収束をやめても濫用耐性は失われない** — 抑止の実体はもともと「窓ごとに1回だけ」であり、それは行の一意制約ではなくスロットル判定が担える。

**payload の識別子を `tokenId` からクレデンシャル識別子へ変え、送信材料 RPC が「現在有効な未使用トークン」を解決する** — `dedupe_key` を残したまま「2回依頼して0通」を消せる。採らなかった理由は、**supersede の意味論が失われる**こと。どの行も常に「今有効なトークン」を送るので、窓をまたいで積まれた古い行が全部送信され、収束の意味論が「最後の1通」ではなく「行数ぶん」に戻る。順序逆転時の期待値（新しいほうだけが届く）も決められなくなる。**なお `superseded` を応答の分岐として表に出さない**ことは AD-6 が別途決めており（DO 側で区別できず、区別できること自体が列挙オラクルになる）、本案の却下理由はそれとは独立である。

**収束を諦め、`providerIdempotencyKey` を (canonical, 窓) から導いて provider 側に吸わせる** — schema が素朴なままで済み、`.thread/34/design.md` 第7.6節が既に「provider が冪等キーを解釈すれば抑止され、しなくても2通届くで済む」と受容している。採らなかった理由は、**行数・Queue メッセージ数・consumer 実行回数が依頼回数に比例したままになる**こと。第7.6節が受容したのは「二重送信」であって「攻撃者が依頼回数を増やせば資源消費が線形に増える」ではない。本決定はこの問題を、行の一意制約ではなく発行判断で解いている。

**スロットル中は「送らない側」の行を積む（現行 `jobs` 版の形をそのまま移す）** — 4ケースが常に1行書くので経路一致が自明になる。採らなかった理由は、**Outbox では「送らない側の行」が Queue メッセージ1件と consumer 実行1回を必ず生む**こと（`jobs` 版では起床1回で済んでいた）。一様に書かないほうが、経路一致を保ったまま資源消費を窓の数に比例させられる。

### Consequences

- 良い点: **`outbox_events` が例外なく「1イベント1行・不変」になる。** AD-2 の「イベントは収束しない」が表の形に一切の穴を持たない。部分 UNIQUE 索引が1本減る。
- 良い点: 現行の濫用耐性（書き込みと起床が窓の数に比例する）がそのまま移る。
- 良い点: 「2回依頼して0通」の経路が消え、**同一窓への連打に対して「有効なリンクを含むメールが1通届く（0通でも2通でもない）」**が期待値として書き下ろせる。
  - **訂正（レビュー2周目・W-005 / レビュー3周目・B-005）: 「1通」は発行回数についての命題であり、受信通数ではない。** 数えているのは**その窓で発行される有効なリンクの回数**であって受信通数の上下限ではなく（配送は at-least-once なので同じリンクが複数回届きうる）、**0通になるのは配送が `quarantined` / DLQ へ落ちた運用側の失敗のときだけ**である。したがってこの期待値には**その窓のイベント行の配送が正常であること**という前提が付く。**射程の正本は `spec/usecases/identity.md`「連打と窓」**（`.adr/013` の 7. も同じ射程へ直っている）。
- トレードオフ: **スロットルの窓の状態を持つ場所が要る。** 行の一意制約に肩代わりさせていた状態を明示的に持つことになる。置き場は AD-16 で確定した（Identity Directory DO の専用ストア）。**その帰結として、テーブル数・非集約ストア数・書き込み口の数え上げが AD-2 のぶんと合わせて動く**（実測値は AD-16 の Consequences）。
- トレードオフ: **「イベントを発行しない」判断がユースケースの中に入る。** 4ケース一様であることを spec とテストの両方で言い切らないと、列挙オラクル対策が「行を必ず1行書く」という単純な形では検証できなくなる。**この検証負担は受け入れる** — 単純な形を採ると Queue メッセージと consumer 実行が依頼回数に比例する。

---

## AD-8: `provider_idempotency_key` を `jobs` から落とし、どちらの表にも列として持たない

### Status

Proposed

### Context

`jobs.provider_idempotency_key`（`spec/database/index.md` L441）は「外部 I/O のプロバイダへ渡す冪等キー。`operation_key` から決定的に導く」であり、**唯一の占有者が `send-mail` である。** `send-mail` が Outbox へ移ると、`jobs` の11種はすべて DO ローカル完結になり、この列を使う `kind` が1つも無くなる。

### Decision

**`jobs` から `provider_idempotency_key` を落とし（12列 → 11列）、`outbox_events` にも同名の列を置かない。provider へ渡すキーは `event.id` から決定的に導き、AD-6 の送信材料 RPC の応答に載せて consumer へ渡す。** あわせて `spec/database/index.md` の `jobs` 節に「**この表に外部 I/O を伴う `kind` は存在しない**」を不変条件として書く。

列にしない理由は、**中身が `id` の関数であり独立した情報を持たない**ことである。`id` は不変・一意なので、列は同じ値を別の名前で2回持つだけになる。`jobs` から列を落とす理由（「占有者のいない列は誤読の導線になる」）を `outbox_events` にそのまま適用すると、`id` から導ける値を別列にするのは同じ態度に反する。

再導入が必要になるのは「外部 I/O を行うが完了責任が DO 自身にある処理」が現れたときだけで、その場合は forward-only migration が既に手段を持っている。

### 検討した代替案

**`jobs` から落として `outbox_events` へ移設する（旧案）** — `jobs` 側の理由づけはそのまま通る。採らなかった理由は上記のとおり、**`id` があれば導ける列を別に持つことになる**こと。加えて導出鍵は DO の中にあるので、列に持たせても consumer は結局 RPC の応答から受け取ることになり、列は誰にも読まれない。

**列を `jobs` に残し「現時点で占有者は無い」と注記する** — 将来の再導入が schema 変更なしで済む。採らなかった理由は、**占有者のいない列が「外部 I/O を local job に載せてよい」という誤読の導線になる**こと。`.adr/001` の「理由が消えたら設定も消す」と、AD-1 が新設する不変条件（local job は DO ローカル完結）の両方に照らして落とす。

### Consequences

- 良い点: 「`jobs` の行はネットワークに出ない」が列の形として現れる。
- 良い点: 冪等キーの導出が1箇所（DO の送信材料 RPC）に閉じ、永続化された同義の列が存在しない。
- トレードオフ: `spec/database/index.md` の「同じ12列」（L428 / L654）と `spec/inventory/adapter.md` の `ADP-jobs-001`（L23）/ `ADP-jobs-002`（L29）を同時に直す必要がある。
- トレードオフ: **`spec/database/index.md` L24 の主キー例外 (b) の論拠が半分失効する。** 「`IdGenerator` で採番すると収束規則3つと `provider_idempotency_key` の決定的な導出がどれも成立しない」のうち後半が `jobs` の関心事でなくなる（同文が `spec/inventory/adapter.md:23` にもある）。**例外の数は2つのままだが、論拠は収束規則だけへ絞り直す。**
- トレードオフ: AD-1 の判定規則 3 が外部 I/O を伴う local job を理論上許しているのに、schema がそれを拒む。**規則と schema の非対称を承知の上で受け入れる** — そのときは列を戻す migration を1本足す。

---

## AD-9: consumer の冪等性キーの保持先は consumer ごとに全数表で宣言する。初期の mail consumer は保持しない

### Status

Proposed

### Context

配送は at-least-once なので consumer は冪等でなければならない。D1 時代は `idempotencyStore`（`processed_events` テーブル）が処理済み `EventId` を持っていたが、共有 DB が無くなった今、その置き場が自明でない。候補は (i) consumer 専用の DO / KV、(ii) 副作用先の自然な冪等性、(iii) 発行元 DO への ack 書き戻し、である。

### Decision

**「どこで冪等化するか」を consumer ごとの判断とし、全数表の「冪等性キー」欄で宣言する。単一の共有ストアを前提にしない。**

初期の唯一の consumer である **mail consumer は処理済み `EventId` を保持しない。** 代わりに、

- `event.id` から決定的に導いた `providerIdempotencyKey` を provider へ渡す（provider 側で抑止させる）。**導出するのは DO で、consumer は AD-6 の RPC 応答から受け取る**（導出鍵が DO 側にあるため consumer 側では導けない）
- AD-6 の RPC が、**トークンが消費・失効している場合も、より新しい発行に置き換えられている場合も、理由を載せない `nothing-to-send` を返す** — これが2番目の防壁になる（consumer 側では両者を区別できず、区別する必要も無い）

**新しい consumer を足すときは、この欄を埋めることが条件である。** 空欄のまま consumer を足せない。

### 検討した代替案

**専用の processed-events ストア（DO / KV）を復活させる** — 一様な冪等化になる。採らなかった理由は、consumer が1つしかない現状で共有ストアを先に置くと、`.adr/001` の態度に反すること。加えて **KV は結果整合なので「書いた直後に読む」が保証されず、重複配送が近接したときに素通りする** — 冪等化ストアとしては正しく動かない。DO を置くとそれ自体が単一のホットスポットになり、`.adr/002` の物理分離と噛み合わない。

**発行元 DO へ ack を書き戻す** — 発行元が配送完了を知れる。採らなかった理由は AD-10 のとおり、責務分界が壊れること。加えて書き戻し自体が at-least-once なので、冪等化の問題が1段ずれるだけである。

### Consequences

- 良い点: consumer ごとに最も安いところで冪等化できる。共有ストアの可用性が全 consumer の配送を止めることが無い。
- 良い点: 「冪等性キーをどこに置くか」が全数表の欄として毎回問われる。
- トレードオフ: **mail consumer は provider が冪等キーを解釈しない場合に二重送信しうる。** `.thread/34/design.md` 第7.6節が既に受容した「リセットメールが2通届く」で済み、届かないほうが有害という判断を引き継ぐ。
- トレードオフ: 一様な冪等化の仕組みが無いので、consumer ごとに正しさをテストする必要がある。

---

## AD-10: quarantine と DLQ の分界を「Queue に入る前か後か」で切り、発行元 DO へ ack を書き戻さない

### Status

Proposed

### Context

失敗を隔離する場所が2つある。発行元 DO の `outbox_events`（`quarantined`）と Queue の DLQ である。どちらが何を持つかを決めないと、同じ失敗が両方に現れるか、どちらにも現れない。

### Decision

**境界は「Queue に入ったかどうか」の1本だけである。**

| 失敗の位置 | 記録先 | 状態 | operator 導線 |
|---|---|---|---|
| relay が Queue へ publish できない（binding 障害・payload 不正） | 発行元 DO の `outbox_events` | `quarantined` + `terminal_reason` | DO の operator 専用 maintenance 経路（一覧・再駆動） |
| consumer が処理に失敗する | Queue の retry → DLQ | Queue 側の管理 | DLQ consumer Worker |

- **`published` は「Queue へ渡した」の意味であり、「処理された」ではない。** 発行元 DO は consumer の結果を知らない。
- **consumer からの ack を発行元 DO へ書き戻さない。** 書き戻すと (i) consumer が発行元 DO を特定して RPC する経路が全イベント型に必要になり、(ii) その書き戻し自体が at-least-once で失敗しうるため三段目の隔離先が要り、(iii) DO が「配送されていない」と「処理されていない」の2つの状態を持つことになる。
- **`terminal_reason` に PII と再利用可能な秘密を入れない** — `jobs.payload` と同じ制約を明文で掛ける。運用者が読む場所だからである。

### 検討した代替案

**end-to-end の配送状態を発行元 DO に集める（ack 書き戻し）** — 「このイベントは処理されたか」が1箇所で引ける。採らなかった理由は上記3点。

**DLQ を持たず、consumer の失敗も発行元 DO へ戻して `outbox_events` の backoff に載せる** — 隔離先が1つになる。採らなかった理由は、Queue の retry / DLQ を使わずに再実装することになり、プラットフォームが持つ機構を捨てて等価物を書くことになる。

### Consequences

- 良い点: 各失敗がちょうど1箇所に現れる。二重管理が無い。
- 良い点: 発行元 DO の責務が「Queue へ渡すまで」に閉じ、DO の中の状態機械が単純なままである。
- トレードオフ: **end-to-end の配送を1箇所で観測できない。** backlog と quarantine は DO、consumer 失敗は DLQ の2箇所を見る。運用手順（#38）とマニュアルテストの両方でこの2箇所を明示する必要がある。
- トレードオフ: 「イベントは発行されたが最終的に処理されなかった」を発行元から追えない。監査要件が生まれたらこの分界を再検討する。

---

## AD-11: 3類型の全数表を `spec/async/index.md` に1本だけ置き、`spec/database/index.md` は参照にする

### Status

Proposed

### Context

現在 `jobs.kind` の全数表は `spec/database/index.md` L466–488 にあり、`.adr/010` が「投入点の欄が空でないこと」を不変条件にしている。Issue #50 はこれに加えて、`event.type` と `jobs.kind` を3類型へ一度だけ分類し、owner DO / 実行責任者 / consumer / fan-out 有無 / payload / 冪等性キーを持つ全数表を要求している。

`.thread/34/design.md` 第1.4節は、「全数」を名乗る表を複数持ったときに**片方を直してもう片方が取り残される**破れが、レビューの R3・R5・R6・R7 の4ラウンドで繰り返し検出されたことを記録している。

### Decision

**`spec/async/index.md` を新設し、3類型の全数表をそこに1本だけ置く。`spec/database/index.md` の `#### kind の全数` 節は、物理形（DDL・索引・CAS・収束規則・backoff・prune）だけを残し、全数表は `spec/async/index.md` への参照に置き換える。**

- 全数表の欄: **識別子**（`event.type` / `jobs.kind` / 同期処理名）/ **類型**（同期実行 / Outbox event / local job）/ **owner DO クラス** / **実行責任者** / **発行点・投入点（全数）** / **consumer** / **fan-out 有無** / **payload** / **冪等性キーとその保持先**。
- 不変条件: すべての `event.type` と `jobs.kind` が**ちょうど1回**現れる。発行点・投入点の欄が空でない（`.adr/010` の I-1 をイベントへ拡張）。local job の再武装分類は `spec/database/index.md` が引き続き持つ（物理の話なので）。
- **同期実行の類型も表に載せる。** 載せないと「3類型へ全数分類する」が2類型の分類になり、FTS5 projection がどの類型かを表から引けない。

### 検討した代替案

**`spec/database/index.md` に3類型の表も置く** — 参照が1ファイルで済む。採らなかった理由は、表の欄の半分（consumer / fan-out / 実行責任者）が DB 設計ではないこと。DB 設計の正本に非 DB の情報を持たせると、`spec/database/index.md` が「物理形の正本」であるという性格が薄まる。

**両方に置いて相互整合を不変条件にする** — `.thread/34/design.md` 第1.4節が記録した4ラウンド分の破れが、まさにこの形である。採らない。

**`spec/domains/index.md` に置く** — `jobs.kind` はドメインの語彙ではない。

**新 ADR の本文に置く** — ADR は決定の記録であって、増減する台帳ではない。`kind` を足すたびに ADR を書き換えることになる。

### Consequences

- 良い点: 「同じ処理が二重登録されていない」が1つの表の中で検査できる。
- 良い点: `spec/database/index.md` が物理形に専念する。
- トレードオフ: `spec/` に新しいトップレベルのディレクトリが1つ増える。`spec/index.md` の成果物一覧・進捗表への登録が要る。
- トレードオフ: **`spec/database/index.md` から表を移すので、`.adr/010` が言う「正本の表」の所在が変わる。** `.adr/010` の本文は改変しないので、新 ADR（`.adr/013`）が移設を明示的に宣言する必要がある。宣言を落とすと、`.adr/010` を読んだ人が `spec/database/index.md` に表を探して見つけられない。
- トレードオフ: **`.adr/013` が宣言する `.adr/010` の失効範囲は、表の移設だけでは足りない。** `.adr/010` の決定にはもう1項、「収束、**外部プロバイダへ渡す冪等キーの導出**、同じ依頼の連打の吸収は、すべて『同じ入力から同じキーが出る』ことに依存しており、生成 ID では成立しない」がある。AD-8 で `provider_idempotency_key` が `jobs` から出ると、この項の「外部プロバイダへ渡す冪等キーの導出」は `jobs` の関心事ではなくなり、しかも新しい導出元は**生成 ID である `event.id`** なので `.adr/010` の論法が反転する。**移設に加えてこの項の帰属変更も `.adr/013` の宣言対象に含める。**

---

## AD-12: 過去 ADR の本文は改変せず、ステータス節への注記だけで supersede を表現する

### Status

Proposed

### Context

Issue は「過去の ADR 本文を改変せず、新しい永続 ADR を追加して履歴を残す」ことを求めている。一方で `.adr/004` の決定の第3項（ドメインイベントの transport 廃止）は全面的に訂正され、**第2項（永続ジョブと Alarm）は一部だけが失効する。** 第2項の本文（`.adr/004` L24）は「要求処理と同じトランザクションで完結させられない処理は永続的なジョブにする。**外部 I/O を伴う処理は必ずこちらに載る**が、それが載るものの全数ではない」であり、太字の十分条件は AD-1 の Consequences が自ら「失効する」と認めているものである。第1項（本体と検索索引を同一トランザクションで確定）は無傷である。**本文をそのままにすると、`.adr/004` だけを読んだ人が失効した決定を有効なものとして読む** — しかも今回訂正した当の論点でそれが起きる。

### Decision

**`.adr/004` と `spec/adr/005` の「ステータス」節にだけ1〜2行を足す。コンテキスト・決定・検討した代替案・影響の4節は改変しない。**

- `.adr/004` のステータス節: 「決定の第3項（ドメインイベント transport の廃止）と対応する影響、および**第2項のうち『外部 I/O を伴う処理は必ずこちらに載る』という十分条件**は `.adr/013` が supersede する。**永続ジョブと Alarm という機構そのものと、第1項（ローカル同期コミット）は有効である。** 第2項が名指しする `.thread/34/design.md` 第7.4節（載る処理の全数）は失効し、全数は `spec/async/index.md` が持つ」
  - **失効を宣言する `.thread/34/design.md` の節は5つで、これが全数である** — 第7.3節（廃止範囲。`.adr/004` L40 が名指し）/ **第7.4節（`jobs.kind` 12種の全数表。`.adr/004` L24 が名指し）** / **第7.6節（外部 I/O を永続ジョブに残す境界。下記のとおり部分失効）** / 第7.7節（契約の正文。`.adr/004` L24 が名指し）/ **第1.4節（機械検査の期待値。「`jobs` は12列」「`kind` は各クラス6種・合計12種」「4類型が12種を1回ずつ覆う」がいずれも改訂後の実体と食い違う）**。作業ログ自体は改訂しないので、`.adr/013` 側で節を名指しするのが唯一の防波堤になる。
  - **第7.6節は部分失効である。** 境界の規則（「トランザクションの中で外部 I/O をしない」。`transactionSync` が `fetch` を呼べないことに帰着する）と、メール送信の所有者が Identity Directory bucket であること、生トークンをジョブ行に載せず送信直前に導出することは**有効**である。失効するのは**行の書き方と収束の手段**で、逐語では次の3点になる — 「**登録の有無によらずダミージョブ行を書く**」「**スロットル中でもジョブ行は必ず書く**」「**同じ canonical への連打はジョブ行1本に収束する**（`operationKey` = 対象 canonical の全長 HMAC + 依頼の窓）」。置き換えるのは `.adr/013` / `spec/async/index.md` / `spec/usecases/identity.md`（AD-6 / AD-7 / AD-16）である。
  - 第7.6節は `.adr/004` から名指しされていないので「ADR から辿れる範囲」では漏れる。**それでも入れるのは第1.4節と同じ実害基準による** — 宣言を落とすと、#51 の実装者が作業ログを読んで旧機構（ダミージョブ行・`operationKey` 収束）をそのまま実装する導線が残る。
- `spec/adr/005` のステータス節: 「検索インデックスの更新方式が superseded であることは変わらない。**本 ADR を検索 indexer consumer の復活根拠に使わない。** Outbox 機構そのものの廃止は `.adr/013` が訂正した」

**ステータス節への注記追加は「本文の改変」に当たらない**と扱う。`spec/adr/005` が既に同じ形（ステータス節に superseded 注記を足し、本文を保持する）で運用されており、その先例に揃える。

**訂正（レビュー5周目・B-001 → AD-51）: 上の Context と Decision は `.adr/004` の決定節を第1〜3項の3つとして数えているが、実際は「リード文（太字1文）+ 3つのバレット」の4要素である。** リード文（「Outbox / relay / consumer / DLQ を廃止する」）が失効側にも有効側にも現れないまま有効側が閉じた形で宣言されていたので、**注意深く読むほど「Outbox の廃止は生きている」という失効済みの結論に到達できた。** 失効側の列挙にリード文を加えることで閉じる（射程は第3項と同じ。詳細と代替案は **AD-51**）。**ステータス節にだけ足すという本 AD の方針そのものは動かない。**

### Consequences

- 良い点: どの ADR から読み始めても失効した決定に到達しない（**この目的に対する反例が1件あり、AD-51 が閉じた**）。
- 良い点: 決定の履歴が改竄されない。
- トレードオフ: `.adr/004` の決定が「一部有効・一部失効」という読みにくい状態になる。**部分 supersede をステータス節1行で表現できる限界に近い** — これ以上分割された supersede が起きたら、ADR の粒度そのものを見直すことになる。

---

## AD-13: consumer は request Worker の `queue()` ハンドラに置く。Worker は2本のままにする

### Status

Proposed（**前提の裏取りが片方だけ取れていない。下の「裏取りの結果」を参照**）

### Context

`CLAUDE.md:110` は「**Two Workers**: a request Worker … and a state Worker …」と宣言し、`apps/web/.dev.vars.example` は「どの秘密がどの Worker に属するか」を宣言する設計になっている。consumer / DLQ をどこに置くかは、Worker 数・deploy 順序・秘密の帰属・service binding の向きの4つを同時に決めてしまう。決めないまま `CLAUDE.md` の Worker 構成記述を改訂することはできない。

### Decision

**consumer と DLQ ハンドラは request Worker の `queue()` ハンドラとして置く。Worker は request / state の2本のままにする。**

- `CLAUDE.md` の「Two Workers」の**文は維持し、request Worker の責務に「Queue consumer」を足す形**に改訂する。deploy 順序（state 先）も変わらない。
- 3本目の Worker を足すと、秘密の配置とデプロイ順序の契約が1組増える。**Issue #50 のスコープ外**であり、consumer が1つしかない現状で先に置くのは `.adr/001` の態度（理由が消えたら設定も消す）にも反する。
- **AD-1 の判定規則2「独立してスケールする consumer へ委譲する」との緊張を認める。** 同居させると規則2の「独立してスケール」は物理的な独立ではなく**実行責任の独立**（Queue の retry / DLQ が完了を管理し、発行元 DO は関与しない）を指すことになる。**規則2の文言をそう読める形に書き下ろす**のが本決定の帰結であり、規則を空文化させないための条件である。物理的に分けたくなったときは Worker を1本足せばよく、その判断は運用の材料（consumer の負荷が request の負荷と干渉するか）が出てから #38 が行う。

### 裏取りの結果

- **取れた:** request Worker が DO を呼ぶ経路は設計として既にある（`CLAUDE.md:99`「Errors cross the request Worker ↔ Durable Object boundary…」、`CLAUDE.md:110` の2 Worker 構成）。送信材料 RPC を request Worker から打てる。
- **取れなかった:** 「MailSender の秘密が request Worker 側に属する」は `apps/web/.dev.vars.example` から確認できない。**同ファイルが宣言している秘密は `SESSION_SECRET` の1件だけ**で（`Only the request-path Worker needs it.`）、メール provider の秘密は登場しない。しかも現行 spec では `MailSender` を呼ぶのは DO の Alarm ジョブ（= state Worker）なので、**今日の帰属はむしろ state Worker 側である。** したがって本決定は「既にある帰属を使う」のではなく「**メール provider の秘密の帰属を state Worker から request Worker へ移す**」という変更を含む。
- **`apps/web/` 配下のファイルは AC-32 の差分範囲に抵触する**ので、本 Issue では `.dev.vars.example` にも `wrangler*.toml` にも触らない。帰属の変更は `.adr/013` の「影響」と #51 の引き継ぎに書く。
- 参考: `main` の `apps/web/wrangler.toml` / `wrangler.{staging,production}.toml.tpl` は D1 時代のままで、`[env.relay]` / `[env.consumer]` / `[env.pruner]` / `[env.dlq]` の4つの named environment を持ち、DO バインディングも state Worker も存在しない。**現物の設定ファイルは本決定の裏付けにも反証にもならない**（#51 が全面的に書き換える対象である）。

### 検討した代替案

**consumer を3本目の独立 Worker にする** — AD-1 の判定規則2を物理構成でも満たせ、負荷の隔離もできる。採らなかった理由は、秘密の配置とデプロイ順序の契約が増え、Issue のスコープを越えること。**#38 / #51 が運用の材料をもって再検討できる余地は残す。**

**consumer を state Worker に置く** — メール provider の秘密の帰属が動かず、送信材料 RPC が同一 Worker 内で完結する。採らなかった理由は、state Worker が「DO クラスを所有する Worker」であるという役割が濁ること、および**外部 I/O を state Worker へ戻すなら Outbox を経由する意味が薄い**（AD-1 の規則3で local job に戻したほうが素直になる）こと。

### Consequences

- 良い点: Worker が2本のままで、deploy 順序（state 先）と `CLAUDE.md` の「Two Workers」記述が動かない。
- 良い点: request Worker は DO バインディングを既に持つので、送信材料 RPC に新しい binding の種類が要らない。
- トレードオフ: **メール provider の秘密の帰属が state Worker から request Worker へ移る。** `.dev.vars.example` の宣言を1件更新する義務が #51 に生じる。
- トレードオフ: **AD-1 の判定規則2を「実行責任の独立」と読む形で書き下ろす必要がある。** 物理的独立と読めるまま残すと、本決定が規則違反に見える。
- トレードオフ: consumer の負荷が request パスと同じ Worker に載る。**Cloudflare Queues の consumer 呼び出しは HTTP リクエストとは別の呼び出しなので直接は干渉しないが、観測は同じ Worker のメトリクスに混ざる**（運用値と観測の分離は #38）。

---

## AD-14: 全数表の正本は `spec/async/index.md` 1箇所とし、`CLAUDE.md` は判定規則と参照だけを持つ

### Status

Proposed

### Context

AD-11 は「全数表を2箇所に持つと必ず片方が取り残される」を根拠に `spec/async/index.md` へ一本化した。ところが `CLAUDE.md` の非同期実行契約 項2 は**全 `kind` を列挙する表**を持ち（現行 L78–87 が12種を4類型へ割り付けている）、`spec/database/index.md:485` は「`kind` を足したら**両方の表**を同時に直し」と、その二重性を明示的に受容している。`send-mail` を Outbox 側へ移すだけでは、AD-11 の原則と正面から食い違ったまま残る。

### Decision

**`CLAUDE.md` からは識別子の全数列挙を落とす。** 項2 は「判定規則の要約 + 類型名 + `spec/async/index.md` への参照」だけを持ち、`event.type` / `jobs.kind` を1つも列挙しない。

- **全数表を持つのは `spec/async/index.md` の1箇所である。** `spec/database/index.md` は物理形に専念して参照にし（AD-11）、`CLAUDE.md` は判定規則の正本であって台帳ではない。
- `spec/database/index.md:485` の「`kind` を足したら両方の表を同時に直し」は、**「`spec/async/index.md` の全数表を直す」の1本へ**書き換える。
- `CLAUDE.md` に残すのは「**`kind` または `event.type` を足すときは AD-1 の3規則のどれで当たったかをレビューで問い、`spec/async/index.md` の全数表に1行足す**」という手続きの規定だけである。

### 検討した代替案

**`CLAUDE.md` 側を「意図的な要約であり正本は `spec/async/index.md`」と宣言したうえで列挙を維持する** — `CLAUDE.md` だけを読んで全体像が掴める利点が残る。採らなかった理由は、**要約と宣言しても列挙は列挙であり、`kind` が増減したときに取り残される確率は下がらない**こと。`.thread/34/design.md` 第1.4節が記録した4ラウンド分の破れは、どれも「片方は要約のつもりだった」表で起きている。

**`CLAUDE.md` を正本にして `spec/async/index.md` を作らない** — ファイルが1つ減る。採らなかった理由は AD-11 のとおり、全数表が持つ欄（owner DO / 実行責任者 / consumer / fan-out / payload / 冪等性キー）が開発規約の粒度ではないこと。

### Consequences

- 良い点: AD-11 の原則が例外なしで成立する。「全数」を名乗る表がリポジトリに1つしかない。
- 良い点: `CLAUDE.md` の非同期実行契約が短くなり、規約（判定規則）と台帳（全数）の役割分担が読み手に見える。
- トレードオフ: **`CLAUDE.md` だけを読む人が `jobs.kind` の顔ぶれを知れなくなる。** 参照を1本辿る必要がある。判定規則は残るので「何を書くべきか」は `CLAUDE.md` で閉じる。
- トレードオフ: `spec/database/index.md:485` の既存の同期義務（両方の表）を書き換えるので、その行の意図（二重性の受容）を打ち消す宣言が `.adr/013` に要る。

---

## AD-15: `spec/testcases/async/` を新カテゴリーとして設け、ID 規約を「テストケースファイルの slug」へ広げる

### Status

Proposed

### Context

`spec/inventory/test.md:5` は ID 規約を「全行 `TC-{ユースケースslug}-{連番3桁}`」と宣言し、`:7` は「新設は**各ユースケースの表の末尾**に append する」としている。`spec/index.md` は L15 / L24 / L26 で「54ユースケース・838ケース」という枠組みで数えている。

本 Issue が定義するテスト方針（relay の claim / backoff / lease / quarantine / DLQ / prune / 重複配送 / 順序逆転）は、**どのユースケースにも属さない機構のテスト**である。既存のどのユースケース表にも自然な置き場が無い。

### Decision

**`spec/testcases/async/outboxDelivery.md` を新設し、slug を `outboxDelivery`（ID は `TC-outboxDelivery-{連番3桁}`）とする。`spec/inventory/test.md:5` の規約を「テストケースファイルの slug」へ言い換える。**

- **規約の言い換えであって新設ではない。** 実体は既に「ファイル名の basename」で採番されている — `TC-post_memo` / `TC-recent_memos` / `TC-update_memo` の3 slug はユースケース名ではなくファイル名由来である（対応するユースケースは `postMemo` / `getTimeline` / `editMemo`）。規約文だけが「ユースケース slug」と狭く書かれている。
- `spec/inventory/test.md` は見出しを持たない単一の表なので、**新しい表は設けず、既存表の末尾に `TC-outboxDelivery-*` を append する。** 欠番規約と `#L{n}` アンカーの規則はそのまま掛かる。
- **`spec/index.md` の「54ユースケース・838ケース」は「54ユースケース + async 1ファイル・{改訂後の実数}ケース」の形へ改める。** ユースケースに属さないファイルが1つ増えたことを数え方に出さないと、54 という数がテストケースファイル数と読めてしまう。
- `requestPasswordReset` に属するケース（4ケース経路一致・連打の収束・supersede）は**引き続き `spec/testcases/identity/requestPasswordReset.md` に置く。** 機構ではなくユースケースの振る舞いだからである。

### 検討した代替案

**`spec/inventory/test.md` に `async` 用の第2の表を設ける** — カテゴリーの境界が表として見える。採らなかった理由は、**現在の台帳が見出しを1つも持たない単一表であり、`#L{n}` アンカーと欠番規約がその形の上に載っている**こと。表を割ると「どの表の末尾に append するか」という判断が毎回要る。

**機構のテストを既存のユースケース（`requestPasswordReset`）のケースとして足す** — 新カテゴリーが要らない。採らなかった理由は、relay / lease / prune / DLQ が `requestPasswordReset` の振る舞いではないこと。イベント型が将来増えたときに、機構のテストが最初のユースケースにぶら下がったまま残る。

### Consequences

- 良い点: ID 規約の実体（ファイル名 slug）と規約文が一致する。既存の3件の逸脱も同時に解消する。
- 良い点: 機構のテストが、イベント型の増減と独立した場所に置かれる。
- トレードオフ: `spec/index.md` の数え方の表記が「54ユースケース」だけでは足りなくなり、L15 / L24 / L26 の3行を同じ形へ揃える義務が生まれる。
- トレードオフ: `spec/testcases/` のディレクトリがドメイン名以外を1つ持つ。**`async` は `spec/async/index.md` と対応するので、対応先のあるカテゴリーであることを台帳の側に1行書く。**

---

## AD-16: スロットルの窓は Identity Directory DO の専用ストア `reset_request_windows` に置く。`credential_mappings` に相乗りさせず、掃除は `sweep-reset-tokens` に同居させる

### Status

Proposed

### Context

AD-7 が `dedupe_key` を撤回したことで、これまで `jobs` の pending 行（`operation_key` = 対象 canonical の全長 HMAC + 依頼の窓）が**暗黙に担っていた「連打の窓」の置き場が消えた。** `outbox_events` は1イベント1行・不変なので窓を担えない。明示的な置き場が要る。

候補は2つあった。既存の `credential_mappings.last_reset_requested_at`（`spec/database/index.md:582`。用途欄は「リセット依頼のスロットル判定」）を使う案と、専用ストアを新設する案である。

**`credential_mappings` に相乗りさせる案は、AD-7 の一様性を構造的に壊す。** `credential_mappings` の PK は `(kind, hmac)` で、行が置かれるのは登録・予約の経路だけである。**未登録の canonical には行が無い**ので、`last_reset_requested_at` を書く先が無い。結果は「登録済みは2回目以降イベント行を書かない／未登録は毎回書く」で、**書き込み行数と起床の有無が登録有無で分岐する** — AD-7 が守ろうとした列挙オラクル対策を AD-7 自身が破ることになる。未登録アドレス宛に `credential_mappings` の行を作って回避する案は、未登録メールアドレスを写像表へ書き込むことになり、濫用面・PII 面の別問題を生む。

### Decision

**Identity Directory DO に `reset_request_windows` を新設し、UoW コンテキストの `resetThrottleStore` から読み書きする。**

- **キーは canonical 化したメールアドレスのハッシュ（対象の全長 HMAC）と依頼の窓の対である。** `jobs.operation_key` と同じ導出を使い、**クライアントから受け取らない**（`CLAUDE.md`「Cross-request idempotency keys never come from the client」）。
  - **訂正（AD-24 / AD-47 / レビュー4周目・W-004）: 根拠として `jobs.operation_key` の導出規則を引かない。導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節である。キーの中身（対象 canonical の全長 HMAC と依頼の窓）と「クライアントから受け取らない」は変わらない。** 現行の `jobs.kind` 11種はいずれもジョブの同一性から導く値（DO ごとの定数キー・`operationId` 由来・対象バージョンや世代由来）で、「対象と時間窓から導く」形は旧 `send-mail` が使っていたものなので、引くと失効した規則を指すことになる。AD-24 が「この言い回しは根拠としては使わない」と名指ししているのは、この1文である。
- **登録の有無に関係なく行を作る。** 4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）のどれでも、同じ1文で読み、同じ1文で書く。行の有無が観測可能な差にならない。
- **生のメールアドレスも SSO subject も持たない。** 持つのは鍵付きハッシュと時刻だけであり、`credential_mappings` の `encrypted_canonical` のような原本を持たない。したがって「未登録アドレスの記録が残る」ことによる PII の増加は無い。
- **期限切れの掃除は既存の `sweep-reset-tokens` に同居させる。** 新しい `jobs.kind` は作らない。同ジョブの**責務**を「期限切れのリセットトークン行の削除**と、期限切れの窓行（`reset_request_windows`）の削除**」へ広げ、`spec/async/index.md` の全数表の用途欄と `spec/database/index.md` の同 `kind` の欄を同時に直す。**`jobs.kind` は 11 種のまま動かず、受け入れ条件12 の初期値分類も動かない。**
- **窓行の作成も `sweep-reset-tokens` の投入点である。** 現行の投入点は「リセットトークン行を発行するのと同じトランザクション」だが、**トークンが発行されるのは4ケースのうち1つ（登録済み + パスワードの検証材料あり、かつ窓の最初の依頼）だけ**である。窓行は4ケースすべてで作られるので、投入点を旧文言のまま移設すると次の2つが同時に起きる。
  - **(a) 掃除ジョブを一度も投入されない bucket ができる。** 攻撃者が未登録アドレスだけを投げ続ける bucket が典型で、窓行が掃除されずに `.adr/002` の 10 GB 上限へ向かって単調増加する。
  - **(b) `enqueueJob` を呼ぶか否かが登録有無で分岐する。** 書き込み行数と起床の有無が4ケースで一致しなくなり、`credential_mappings` 相乗り案を却下した理由とまったく同型の破れが掃除ジョブ側に残る。
  - したがって投入点を「**リセットトークン行または窓行を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）**」へ広げる。**宛先の登録有無で投入するかどうかを分けない。** `sweep-reset-tokens` は再武装する5種の1つなので、投入点さえ4ケース一様にすれば残件がある限り自走する。
  - `.adr/010` は「投入点は数え上げ可能な全数として書き、**正本の表と各投入ユースケースの両方に書く**」を不変条件にしている。したがって全数表（`spec/async/index.md`）・物理側（`spec/database/index.md`）・ユースケース側（`spec/usecases/identity.md`）の3箇所へ同じ1文を落とす。**`jobs.kind` は 11 種のまま増やさない。**
- **`credential_mappings.last_reset_requested_at` は落とす。** 唯一の占有者が本ストアへ移る以上、残すと「スロットルの権威が2箇所にある」という誤読の導線になる。AD-8 が `provider_idempotency_key` を落としたのと同じ態度（`.adr/001`「理由が消えたら設定も消す」）である。**列削除なので DDL 分類は `spec/database/index.md:708` の「データ量に依存する（分割か回避が要る）」の (i) 側**であり、`outbox_events` の追加（単発適用）とは別の型になる。
- **窓の行は攻撃者が任意の未登録アドレスを投げるだけで増える。** 掃除の担い手を持つことに加えて、行が窓の数に比例して増える（依頼回数ではない）ことを不変条件として書く。

### 検討した代替案

**`credential_mappings.last_reset_requested_at` をそのまま使う** — テーブルが増えず、既存列の用途がそのまま生きる。採らなかった理由は上の Context のとおり、**未登録 canonical に行が無く、4ケース一様が構造的に成立しない**こと。

**未登録 canonical にも `credential_mappings` の行を作る** — 一様性は回復する。採らなかった理由は、写像表が「一意性の権威」であるという性格が壊れること（登録されていない主体の行が混ざる）と、未登録アドレスを写像表へ書き込むことが濫用の増幅点になること。

**窓の掃除に新しい `jobs.kind`（例 `sweep-reset-windows`）を足す** — 作業述語が1ジョブ1目的で読みやすい。採らなかった理由は、**`jobs.kind` が 11 種から 12 種へ動き、受け入れ条件12 が名指しする初期値分類と全数表の両方が動く**こと。掃除の対象はどちらも「Identity Directory DO の、リセット依頼に伴って増える期限つき行」であり、同じ起床で一緒に掃除できる。**作業述語を広げるほうが、全数表の行を増やすより安い。**

**窓を KV / Cache API に置く** — DO の SQLite を増やさない。採らなかった理由は、**同じトランザクションで読めない**こと。AD-7 は窓の読み取りとスロットル計上をイベント行の追加と同じ `transactionSync` に入れることを要求している。

### Consequences

- 良い点: 4ケース一様が**構造として**成立する。「未登録には行が無い」という分岐の材料そのものが存在しない。
- 良い点: スロットルの権威が1箇所になる。`credential_mappings` から列が1つ減る。
- トレードオフ: **数え上げが AD-2 のぶんと合わせて動く。実測値は次のとおり**（`spec/` の現在値はコマンドで再測定済み）。
  - Identity Directory DO のテーブル数: **5 → 7**（`outbox_events` + `reset_request_windows`）。User Data DO は **16 → 17**（`outbox_events` のみ）。
  - 非集約ストア: **7 → 9**（`outbox_events` / `reset_request_windows`）。
  - 非集約ストアへの書き込み口: **6ストア・7メソッド → 8ストア・9メソッド**（`enqueueEvent` / `resetThrottleStore`）。`_meta` が口を持たない唯一のストアであることは変わらない。
  - `spec/inventory/adapter.md` の schema 行: **22行 → 25行**（`outbox_events` ×2 + `reset_request_windows` ×1）。
- トレードオフ: `credential_mappings` の列削除が1件生じる。`ADP-credential-mappings-001` の「濫用抑止（failed_attempts / next_attempt_allowed_at / last_reset_requested_at）」という列挙も同時に直す。
- トレードオフ: `sweep-reset-tokens` の作業述語が2目的になる。**`kind` を増やさない代わりに、用途欄が「トークンと窓の両方」であることを全数表で明示する義務が生まれる。**

---

## AD-17: relay / mail consumer / DLQ ハンドラはアダプター層に属する。ユースケース層にハンドラを作らない

### Status

Proposed

### Context

mail consumer は「送信材料 RPC の応答（2分岐）を受けて `MailSender` を呼ぶ」という2つのポート越しの合成を持つ。合成があるとユースケース層に見えるので、層帰属を決めておかないと #51 が `spec/inventory/usecase.md` に行を足すか `spec/inventory/adapter.md` に足すかで揺れる。ステップ13 が「`spec/inventory/usecase.md` は `UC-identity-005` の1行しか触らない」としていることとも対にする必要がある。

### Decision

**relay・mail consumer・DLQ ハンドラはいずれもアダプター層に属し、台帳は `spec/inventory/adapter.md` にだけ行を持つ。**

- 前例に揃える判断である。現行の `send-mail` ジョブも「アダプターのジョブランナーが起床して `MailSender` を呼ぶ」形で、`spec/inventory/usecase.md` に行を持たない。
- 判定の根拠は AD-1 の規則ではなく**層の定義**にある。mail consumer が持つのは業務判断ではなく配送機構の手続き（RPC を打つ / 2分岐で分ける / provider を呼ぶ / ack する）だけであり、**業務判断はすべて送信材料 RPC の向こう側（DO の中）にある。** 判断が無いものはユースケースではない。
- **したがって `spec/inventory/usecase.md` に足す行は無い。** 「足さないこと」自体が「同じ処理を2類型へ二重登録していない」の傍証になる。

### Consequences

- 良い点: 台帳の帰属が1文で決まり、#51 が層を選び直さない。
- 良い点: ユースケース層が Queue / Worker の語彙を1つも持たないままになる。
- トレードオフ: consumer が将来「どのイベント型をどう処理するか」の分岐を持ち始めたら、この帰属を再検討することになる。**consumer が1つしかない現状での判断である**ことを台帳側に1行残す。

---

## AD-18: `spec/database/index.md:461` の前方互換点は3本のままとし、outbox 行を足さない

### Status

Proposed

### Context

`spec/database/index.md:461` は「材料の寿命のうち落としてはならない**前方互換点3本**」を全数として宣言している（`account.caller_token` / `operations.target_locators` / `credential_mappings` のコーディネーター予約行）。全数宣言なので、`outbox_events` を足すなら数が動く。決着させずに #51 へ渡すと、`.adr/010` 型の「全数宣言が静かにずれる」破れになる。

### Decision

**足さない。3本のままである。**

- 前方互換点の性質は「**終端の後始末が終わるまで消してはならない材料**」である。3本はいずれも、消すと自動回収（#45）が回収対象を特定できなくなる。
- `outbox_events` の prune が触るのは `published`（= Queue へ渡し終えた）行と、保持期間を過ぎた行だけである。**`quarantined` の行は残す**（AD-10。operator の検査材料）。したがって「終端の後始末に要る材料を prune が消す」経路が存在しない。
- **この1文を `spec/database/index.md:461` の周辺に明示的に書く。** 「増えない」ことを書かないと、読み手は3本という数が改訂前のまま取り残されたのか意図的に据え置かれたのかを判別できない。

### Consequences

- 良い点: 全数宣言が動かず、`#37 → #51` の付け替えだけで L461 の改訂が閉じる。
- トレードオフ: 将来 `outbox_events` の行を回収材料に使う設計（例: end-to-end の配送監査）が出たら、この決定を戻すことになる。AD-10 が ack の書き戻しを断っている限りその需要は出ない。

---

## AD-19: スロットル窓ストアのドメイン側契約を `PasswordResetThrottlePort.claimWindow` として1メソッドで置く

### Status

Proposed

### Context

AD-16 は `reset_request_windows` の物理形（列・索引・掃除の担い手）と `CLAUDE.md:68` の roster への追加までを決めたが、**ドメイン側の契約を書く場所を決めていなかった。** ところが AD-7 は「窓の読み取りと計上を `enqueueEvent` と同じ `transactionSync` の中で行う」とユースケースの手順に書く。

**この repo では、ユースケースから触る非集約ストアは必ずドメイン側の契約を持っている。** `resetTokenStore` は `PasswordResetTokenPort`（`spec/domains/identity.md:588`。台帳は `DOM-identity-031` / `-032`）、`credentialLocatorStore` は `CredentialLocatorStore`（`:493`。`DOM-identity-041`〜`-044`）である。契約が無いと (i) ユースケース spec が名前だけのハンドルを参照する形になり、(ii) 「判定と計上が1回の呼び出しで原子的に行われるのか、読みと書きの2メソッドなのか」という**4ケース一様性の実体を決める判断**が #51 の実装裁量へ落ちる。

### Decision

**`spec/domains/identity.md` に `PasswordResetThrottlePort` の節を1つ足し、`spec/inventory/domain.md` に対応する `DOM-identity-*` 行を append する。UoW コンテキスト側のハンドル名は `resetThrottleStore` で、`resetTokenStore`（`PasswordResetTokenPort`）と同じ「ハンドル名とポート名が別」の形に揃える。**

- **メソッドは1つだけにする。** `claimWindow(windowKey, now): boolean` — その窓の**最初の依頼なら行を作って `true`**、既存の窓なら `last_requested_at` だけを更新して `false` を返す。**判定と計上を分けない。**
- **1メソッドにするのが本 AD の実質である。** 読みと書きの2メソッドにすると「4ケースが一様に落ちる」が2つの呼び出しの組み合わせの性質になり、呼び出し順序を誤ると一様性が静かに壊れる。1メソッドなら**単一の呼び出しの性質**として spec にもテストにも書ける。戻り値の `boolean` が、AD-7 の「発行するか否か」と「トークンを発行するか否か」の**両方を決める唯一の分岐**になる。
- **`windowKey` は呼び出し側が導出して渡す**（対象 canonical の全長 HMAC + 依頼の窓。クライアントからは受け取らない）。ポートは導出鍵を知らない。**補足（AD-45）: 「呼び出し側」の実体は、bucket 選択のために全長 HMAC を既に計算している stub 選択アダプターと、それを窓と合成するユースケースの2者である。本 AD の文（ポートは導出鍵を知らない / 1メソッド / 同期契約）はいずれも動かない。**
- **同期契約である。** `transactionSync` の中で呼ぶので、`spec/domains/index.md:34` の Promise 例外2件（`PasswordHasher` / `MailSender`）は動かない。

### 検討した代替案

**`read` と `record` の2メソッドにする** — 読みだけをしたい将来の用途（運用の観測など）に開ける。採らなかった理由は上記のとおり、一様性が呼び出し順序に依存する形になること。観測が要るなら operator 専用 maintenance 経路に別の口を置くほうが、ユースケースの契約を汚さない。

**契約を書かず、UoW コンテキストのハンドルだけを `spec/database/index.md` に書く** — 台帳の行が1つ減る。採らなかった理由は、`resetTokenStore` / `credentialLocatorStore` の前例と非対称になり、`spec/inventory/domain.md` に行が立たないこと。

### Consequences

- 良い点: 4ケース一様性が「1回の呼び出しの戻り値だけで発行可否が決まる」という**検証可能な単一の命題**になる。
- 良い点: `CLAUDE.md:68` の roster で `resetTokenStore`（`PasswordResetTokenPort` on the domain side）と同じ書き方（`resetThrottleStore`（`PasswordResetThrottlePort` on the domain side））が使える。
- トレードオフ: `spec/domains/identity.md` の節が1つ、`spec/inventory/domain.md` の行が1つ増える。**ポート数が増えるが同期契約なので、`spec/domains/index.md:34` の Promise 例外の列挙（2件）は動かない。**

---

## AD-20: Outbox の運用系マニュアルテストは既存カテゴリー `account.md` に足し、新規カテゴリーを作らない

### Status

Proposed

### Context

本 Issue は Outbox backlog の観測 / quarantine 一覧 / DLQ の確認 / 再駆動の手順をマニュアルテストへ追加する（受け入れ条件・AC-28）。ところが `spec/index.md:16` は「**7カテゴリ**・204ケース」と宣言しており、新規カテゴリーを作るとこの数が動く。`spec/manual-tests/index.md` の件数表にも行が1つ増える。

**plan.md は窓ストアについて「置き場は計画段階で確定済みであり、実行中に決め直さない — 決め直すと同時修正リストの数が条件付きで崩れる」という原則を置いている。** 同じ原則をここにも適用する。

### Decision

**追加先は `spec/manual-tests/account.md` に確定する。新規カテゴリーは作らず、`spec/index.md:16` の「7カテゴリ」は動かさない。同時修正リストにカテゴリ数の行を足す必要も無い。**

- 実ファイルを読んで選んだ結果である。`account.md` は「アカウント登録・ログイン・ログアウト・AIクライアント接続・**パスワードリセット/変更**」を対象とし（同ファイル L5）、環境前提に「**パスワードリセットメールを確認できる開発用メールボックス**」を既に持ち（L21）、リセット依頼〜受信〜再設定のケースを4本持つ（TC-10 / TC-29 / TC-30 / TC-31）。**本 Issue が足す手順が観測するのは、そのリセットメールの配送そのものである。**
- `settings.md`（設定とデータ管理）は保持期限変更とエクスポートだけを対象としており、メール配送と接点が無い。運用系という理由だけでそちらへ寄せると、テストデータの前提を丸ごと作り直すことになる。
- **手段の実体は #38 が定める**という既存の書き方に揃える（`spec/manual-tests/trash.md:18–22` が先例で、Alarm の強制発火について同じ形を採っている）。
- 動く数は「`account.md` のケース数」と「合計 204」の2つだけであり、**どちらも既に同時修正リストに載っている。**

### 検討した代替案

**新規の運用カテゴリー（例 `operations.md`）を作る** — 運用手順が1ファイルに集まり、開発者向けと利用者向けの手順が混ざらない。採らなかった理由は、`spec/index.md:16` の「7カテゴリ」と `spec/manual-tests/index.md` の件数表が動き、**同時修正リストに条件付きの行が1つ増える**こと。カテゴリーを跨ぐ運用手順が1本しか無い時点で作るのは `.adr/001` の態度にも反する。

**`settings.md` に足す** — 「データ管理」という括りには収まる。採らなかった理由は上記のとおり、リセットメールの配送とテストデータ・環境前提が噛み合わないこと。

### Consequences

- 良い点: カテゴリ数が動かないので、`spec/index.md` 側の改訂が件数（204）だけで閉じる。
- トレードオフ: `account.md` が運用者向けの手順を持つ最初のカテゴリーになる。**配送機構の観測手順が増えたら独立カテゴリーへ切り出す**という含みだけ残す（切り出す時点でカテゴリ数の同時修正が要る）。

---

## AD-21: `CLAUDE.md` から #37 の識別子を落とし、歴史的経緯は Issue のコメント側に置く

### Status

Proposed

### Context

AC-35 は「有効な `spec/` と `CLAUDE.md` に CLOSED 済みの #37 を指す参照が1件も残っていない」を要求し、その検査は `grep -rn '#37' spec CLAUDE.md | grep -v '/review/'` が**0件**であることで行う（改訂前は19件）。

ところが steps.md ステップ19 の「Migration in progress」の項は、当初「**#37 が CLOSED であること**、`main` のコードがまだ D1 + Outbox であること…を書く」と指示していた。**指示どおり書けば `CLAUDE.md` に `#37` が1件残り、機械検査が必ず赤になる。** 実装フェーズで「AC に従って消す」か「ステップに従って書く」かの二択が発生し、どちらを選んでも一方の受け入れ基準を落とす。

### Decision

**`CLAUDE.md` からは `#37` という識別子を落とす。「Migration in progress」の項は #51 だけを指す。**

- 書くのは「**旧移行 Issue はクローズ済みで、実装は #51 が引き継ぐ**」までであり、番号を出さない。`main` のコードがまだ D1 + Outbox であること、`collectEvents` が `enqueueEvent` へ改名されるのは #51 であること、という**現在の状態と次にやる人**は従来どおり書く。
- **歴史（#37 が何をしようとして、なぜ CLOSED になり、何が引き継がれたか）は #37 の gh コメント側に置く**（ステップ20 が既に担っている）。文書に置くのは「今どうなっているか」であり、「かつて誰が何を計画したか」ではない。
- **したがって AC-35 と機械検査は素の `grep` で 0件を期待する形のままにする。** 例外条項（「1件だけ許容する」）を置かない — 例外を置くと検査が「0件」から「特定の1行を除いて0件」へ変わり、除外条件が正しいかどうかを毎回人間が判定することになる。

### 検討した代替案

**AC-35 と機械検査の期待値を「能動的参照0件。歴史的言及は `CLAUDE.md` の Migration in progress の1箇所に限り許容し、その1件だけが grep に残る」へ緩める** — 経緯が repo の中に残る。採らなかった理由は、**検査が単純さを失う**こと。19件を0件にする検査は誰でも読めるが、「1件だけ残ってよく、それがどの行かを目で確かめる」検査は `.thread/34/design.md` 第1.4節が記録した「誰も見なくなる検査」の形そのものである。加えて #37 は CLOSED であり、その中身を参照する導線が repo に残る積極的な理由が無い。

### Consequences

- 良い点: AC-35・機械検査・ステップ19 が1つの期待値（0件）で揃う。実装フェーズに二択が残らない。
- トレードオフ: `CLAUDE.md` だけを読む人は、旧移行計画の Issue 番号に辿り着けない。**#51 の本文と gh コメントが辿り先になる**ので、導線そのものは切れない。

---

## AD-22: 「無限定の断言が残っていない」の検査は総数一致ではなく、残存ヒットの性質で行う

### Status

Proposed

### Context

AC-36 は「別ストアへ配送する経路は持たない」系の無限定の断言を0件にすることを要求し、その検査を **`grep -rn '配送する経路\|通知する経路\|外部 transport' spec | grep -v '/review/'` が改訂前後とも9件を返す**という形で書いていた。

**この期待値はステップ6 / 7 / 9 が指定する具体的な書き換え文と両立しない。** 対象6箇所のうち5箇所は、指定文に置き換えると grep 対象の語句そのものが消えるからである。

- `spec/domains/index.md:35` → ステップ6 の (a)「同一トランザクションで更新し、配送しない」/ (b)「外部への配送は DO ローカル Outbox が担う」— 語句なし
- `spec/domains/memo.md:14` → ステップ7 の「検索インデックスについては配送しない。memo ドメインはイベントを定義しない（…）」— 語句なし
- `spec/usecases/{memo,knowledge,identity}.md` → ステップ9 の「(1)(2)(3) を同じ `transactionSync` で確定できる…」— 語句なし

語句が生き残るのは `spec/domains/search.md:216`（「外部 transport（キュー・ワーカー）は登場しない」を検索ドメインへ限定する形）だけである。

### Decision

**AC-36 と機械検査の判定を「総数の一致」から「残存ヒットの性質」へ改める。**

- **改訂前は9件、改訂後は4件**である。内訳は無変更3件（`spec/database/index.md:162` / `spec/domains/trash.md:266` / `spec/inventory/adapter.md:45`）+ `spec/domains/search.md:216` の限定形1件。
- 判定は2本立てにする。
  1. **`git diff` で無変更3件が1文字も変わっていないこと。**
  2. **改訂後の残存ヒットに無限定の断言が1件も無いこと**（4件それぞれが「失効済み」「検索インデックスに限定」「検索ドメインに限定」のいずれかであること）。
- **「同じバレットに `spec/async/index.md` への参照を持つ」という要求は、イベントを定義するドメイン／ユースケースに限る。** `spec/domains/memo.md:14` のように「このドメインはイベントを定義しない」で閉じるバレットには参照を置かない選択もありうるが、**本 Issue では置く** — 読み手が「では誰が配送するのか」を1ホップで辿れるほうが、断言を限定した意味が伝わる。ステップ7 の `memo.md` の指定文に参照を足して揃える。

### 検討した代替案

**書き換え文のほうを、語句を残す形に寄せて総数を9件に保つ** — 検査が「総数が変わらないこと」で書けて単純になる。採らなかった理由は、**検査のために本文の書きぶりを歪めることになる**こと。「配送する経路は持たない」という語句を残したまま限定するのは、`spec/domains/search.md:216` のように語句自体が主語を持つ場合にだけ自然で、他の5箇所では不自然な文になる。

### Consequences

- 良い点: 期待値が改訂側の実体と一致し、検査が赤を出さない。**赤が出たときに「改訂側のミス」と「基準値のミス」を切り分けられる。**
- トレードオフ: 検査の 2. が完全には機械化できない（残存4件の性質を目で確かめる）。**件数が4件と少なく、かつ全数が名指しされている**ので、目視の範囲は有界である。

---

## AD-23: 全数表の「由来」欄は同期実行の行で `—` とし、集合突き合わせは `—` を除いて行う

### Status

Proposed（**ステップ3 の実装中に確定した。plan.md / steps.md の検査15 の判定手順を1点だけ具体化する**）

### Context

AD-11 が決めた全数表は「(i) 同期実行 / (ii) Outbox event / (iii) local job」の3類型を1つの表に載せる。AC-8 の判定は「**旧 `jobs.kind` 12種の集合 == 由来欄の集合**」だが、**同期実行の4行（FTS5 projection / retention のハードデリート / saga phase の前進 / `purge_after` の一括再計算）はもともとジョブではないので、由来欄に書ける旧 `kind` を持たない。**

plan.md の集合演算の除外規則は「除外対象は『User Data DO のイベント型: 0件』の1行だけで、それが全数である」としており、同期実行の4行を想定していない。空セルのまま置くと、検査を書く人が空文字列4件を集合に入れて必ず赤を見る。

### Decision

**同期実行の4行の由来欄には `—` を置き、「`—` は対応する旧 `jobs.kind` が無いことを表す」を全数表の直後に明記する。検査15 は `—` を除いた由来欄の集合に対して行い、そのとき集合はちょうど12個になる。**

- **これは除外規則の拡張ではなく、欄の値の定義である。** 「0件行の除外」は行を集合から外す操作だが、こちらは「`—` という値が『該当なし』を意味する」というセルの読み方であり、由来欄以外の列（consumer / fan-out / 冪等性キー）でも同じ `—` を同じ意味で使っている。
- **plan.md の「除外対象は1行だけ」は動かさない。** 同期実行の4行は識別子欄を持つので、検査2（識別子の重複）・検査4（`event.type` とドメイン定義の1対1）・検査5（consumer 欄）にはそのまま参加する。集合から外れるのは0件行だけである。

### 検討した代替案

**同期実行の行を別表に分ける** — 由来欄そのものが要らなくなる。採らなかった理由は、AD-11 が「同期実行の類型も表に載せる。載せないと3類型へ全数分類するが2類型の分類になる」と決めており、表を割ると「同じ処理が2類型に現れていない」を1つの表の中で検査できなくなること。

**同期実行の行の由来欄を空セルにする** — 記法が減る。採らなかった理由は上記のとおり、空文字列が集合に混ざること。

### Consequences

- 良い点: 検査15 が `—` の除去1つで書け、期待値（12件）が動かない。
- トレードオフ: 「集合から外す行は1つだけ」と「集合から外す値は `—`」という2つの規則が並ぶ。**どちらも全数表の直後の2段落に書いてあるので、検査を書く人はそこだけ読めばよい。**

---

## AD-24: `reset_request_windows.window_key` は主キー例外 (b) と同じ1件として扱い、例外の数を2つのまま据え置く

### Status

Proposed（**ステップ4 の実装中に確定した。AD-16 が決めなかった1点を閉じる**）

### Context

`spec/database/index.md` の共通方針は「単一の `TEXT` 列を主キーに持つテーブルでは、その値は `IdGenerator` が採番する。**例外は2つで、これが全数である**」と宣言し、(a) `password_reset_tokens.token_id`、(b) `jobs.operation_key` を挙げている。

AD-16 が新設する `reset_request_windows` の主キー `window_key` は**単一の `TEXT` 列**であり、**生成せず決定的に導く値**である。素直に読むと3件目の例外になるが、steps.md ステップ4 は「例外の数は2つのまま、論拠を収束規則だけへ絞り直す」としており、`window_key` について何も言っていない。**書かずに済ませると、閉じた全数宣言が新設テーブルによって静かに破れる。** 「3つ」に変えると、同文を持つ `spec/inventory/adapter.md:23`（ステップ14）まで数が動き、同時修正リストに載っていない数が1つ増える。

### Decision

**`window_key` を例外 (b) と同じ1件として扱い、例外の数を2つのまま据え置く。** 該当箇所には「例外 (b) と同じ1件である — 生成せず、`jobs.operation_key` と**同じ導出**（対象 canonical の全長 HMAC + 依頼の窓）で決まる同一性キーであり、別の例外を新設しない」を1文添える。

- **訂正（レビュー3周目・W-005）: 添える文から `jobs.operation_key` の導出規則への参照を落とす。** 現行の `jobs.kind` 11種はいずれもジョブの同一性から導く値（DO ごとの定数キー・`operationId` 由来・対象バージョンや世代由来）で、「対象と時間窓から導く」形は旧 `send-mail` が使っていたものなので、参照すると失効した規則を指す。**結論（例外は2つのまま）は動かない**が、根拠は「同じ導出規則の2つ目の適用先だから」ではなく「**生成せず決定的に導く同一性キー**という例外そのものの射程に入る2つ目の列だから」である（納品物・`.adr/013` の「影響」3項ともこの形で確定した）。添える文は「対象 canonical の全長 HMAC と依頼の窓から決定的に導く」＋導出規則の正本（`spec/database/index.md` の `reset_request_windows` の節）への参照に一本化する。
- **同一視できる根拠は AD-16 が既に持っている** — 「キーは `jobs.operation_key` と同じ導出を使う」と決めている。導出の入力も規則も同じで、違うのは書き込み先の表だけである。**上の訂正のとおり、この言い回しは根拠としては使わない。同一視の根拠は下の「例外 (b) の本質」の項が単独で担う。**
- **例外 (b) の本質は「列名」ではなく「決定的に導く同一性キーである」という性質である。** 同じ窓に同じキーが出ることがスロットル判定の成立条件そのものなので、生成 ID では成立しないという (b) の論拠がそのまま当てはまる。
- **したがって同時修正リストに「主キー例外の数」の行を足す必要は無い。** 足すべきだったのは数ではなく、例外 (b) の射程が2列に及ぶことの明示である。

### 検討した代替案

**例外を3つに増やす** — 列を1対1で数える形になり、読み手が迷わない。採らなかった理由は、**同じ導出規則の2つ目の適用先を「別の例外」と数えると、例外の全数宣言が「規則の例外の数」ではなく「列の数」になる**こと。以後 `operation_key` と同じ導出を使う表が増えるたびに全数が動き、宣言の意味が薄れる。加えて `spec/inventory/adapter.md` まで数が動くので、同時修正リストに条件付きの行が1つ増える。

**何も書かない（steps.md の文面どおりに留める）** — 差分が小さい。採らなかった理由は、閉じた全数宣言が新設テーブルによって破れたまま残ること。**「2つのまま」を守るには、なぜ増えないかを書く必要がある。**

### Consequences

- 良い点: 「例外は2つ」が改訂前後で動かず、`spec/inventory/adapter.md:23` 側の記述も数の上では触らずに済む。
- トレードオフ: 例外 (b) が2つの列を射程に持つ形になる。3つ目の表が同じ導出を使うときも同じ扱いになるので、**例外の全数宣言は「規則の例外の数」として読む**ことを前提にする。

---

## AD-25: quarantine の operator 導線に `list-quarantined-events` / `requeue-quarantined-event` の2エントリを置く

### Status

Proposed（**ステップ4 の実装中に確定した。AD-10 が決めた導線に名前を与えるだけの判断である**）

### Context

AD-10 は「relay が publish できない失敗は発行元 DO の `quarantined` に記録し、operator 導線は DO の maintenance 経路（一覧・再駆動）である」と決めたが、**エントリの名前を決めていない。** `spec/database/index.md` の「operator 専用 maintenance 経路」の節は既存の4エントリ（`purge-user-mappings` / `cancel-reservation` / `read-schema-version` / `list-bucket-user-ids`）を逐語で名指ししており、**名前を与えないと新しい導線だけが無名で並ぶ。**

### Decision

**`list-quarantined-events`（一覧）と `requeue-quarantined-event`（`pending` へ戻す再駆動）の2つを、既存4エントリと同じ書き方で同じ節に置く。**

- **どちらも `jobs.kind` にも `event.type` にも入らない**（ジョブでもイベントでもなく RPC である）。既存の「`purge-user-mappings` と `cancel-reservation` は `jobs.kind` に入らない」という書き方に揃える。
- **診断エントリ2本（migration ゲートの射程外）とは別である。** この2つはゲートの射程内であり、fail-closed の DO では使えない。
- **consumer 側の失敗の導線はここではない** — DLQ ハンドラである（AD-10 の分界を1行添える）。

### Consequences

- 良い点: マニュアルテスト（ステップ17）と運用手順（#38）が名前で参照できる。
- トレードオフ: operator 経路のエントリが4つから6つになる。**この節は「これが全数である」という宣言を持たない**ので、閉じた数え上げは動かない。

---

## AD-26: `identity.passwordResetRequested` の `aggregateId` はスロットル窓のキー（`windowKey`）にする

### Status

Proposed（**ステップ7 の実装中に確定した。AD-6 / AD-7 が payload の中身までは決めたが、`aggregate_id` 列に何を入れるかを決めていなかった**）

### Context

`outbox_events.aggregate_id` は **NOT NULL** である（`spec/database/index.md`）。したがって `identity.passwordResetRequested` の行にも必ず値が入る。ところが AD-7 は「その窓での最初の依頼なら**4ケースとも必ずちょうど1行**」を要求し、AD-7 の Decision は「**行の形が4ケースで一字も違わないことが一様性の実体である**」と言っている。`aggregate_id` は行の一部なので、この要求は payload だけでなくこの列にも掛かる。

素直な候補は `credentialId` だが、**未登録の canonical には credential が無い。** `NULL` にできない列に入れる値が4ケースのうち2ケースで存在しないので、そのままでは形が割れる。

### Decision

**`aggregateId` には `PasswordResetThrottlePort.claimWindow` に渡した `windowKey`（対象 canonical の全長 HMAC + 依頼の窓）を入れる。**

- **4ケースのどれでも同じ導出で必ず決まる唯一の識別子である。** 窓のキーは canonical から導くので、登録の有無・認証方式・宛先の存在を1つも参照しない。AD-16 が窓ストアを `credential_mappings` から分離したのと同じ理由がそのまま当てはまる。
- **鍵付きハッシュ済みなので原本を含まない。** `reset_request_windows.window_key` と同じ値であり、`spec/database/index.md` が「この表を新設しても PII は増えない」と言っているのと同じ根拠が効く。**補足（AD-50）: 「原本を含まない」は「窓をまたぐ相関材料にならない」までは言っていない。** 合成の一方向性を要求するか否かと、その射程は AD-50 が持つ。
- **DO の外へは出ない。** Queue メッセージが運ぶのは `event.id` / `type` / `payload` / routing key / `owner_token` であり（`spec/async/index.md`「Queue メッセージ」）、`aggregate_id` はその列挙に無い。したがって窓キーが consumer 側・DLQ 側へ漏れる経路は無い。
- **「イベントが指す集約」としての読みも通る。** このイベントの発生源は特定のクレデンシャルではなく「その窓のリセット依頼」そのものであり、`requestPasswordReset` が扱う一貫性の単位と一致する。

### 検討した代替案

**`credentialId` を入れ、未登録では不透明なダミー値を置く** — payload の `tokenId` が採っている形（AD-7）と揃う。採らなかった理由は、**`aggregate_id` は payload と違って「同じ対象の行を引き当てる」ための列である**こと。ダミー値を入れると、登録済みの行だけが実在の集約を指し、未登録の行はどこも指さない列になる。同じ列に2つの意味が同居し、後から集約単位で引く経路（運用の観測など）を書くときに必ず踏む。`tokenId` のダミーは「送信材料 RPC が通常の `nothing-to-send` として扱う」という**使い道が決まっている**が、`aggregate_id` にはそれが無い。

**`tokenId` をそのまま入れる** — payload と重複するだけで、集約を指さない。列の意味が失われる。

**`event.id` を入れる** — 常に一意になるので「集約」を表さない。`aggregate_id` を持つ意味が消える。

### Consequences

- 良い点: 4ケースで行の形が一字も割れない、という AD-7 の一様性が `aggregate_id` まで含めて成立する。
- 良い点: 同じ窓のイベント行と窓行が同じキーで対応づく（同一窓では行が1件しか作られないので、実質は1対1である）。
- トレードオフ: `aggregate_id` の値域が DO クラスによって違う種類のキーになる。**User Data DO のイベント型は初期0件**（AD-3）なので今は潜在的だが、足すときは `spec/async/index.md` の routing key の規則（User Data DO のイベントを足すときに扱いを同時に決める）と一緒に読むことになる。

---

## AD-27: `requestPasswordReset` のエラーケース表から「送信基盤障害」を分離し、応答に現れないことを行として書く

### Status

Proposed（**ステップ8 の実装中に確定した。AD-13 / AD-6 の帰結を既存の表へ落とすときに生じた1点である**）

### Context

`spec/usecases/identity.md` のエラーケース表は「トークンストア障害・**送信基盤障害** → `SystemError`」という1行を持っていた。現行設計では `MailSender` を呼ぶのは同じ DO の Alarm ジョブなので、送信の失敗はユースケースの外だが同じ DO の中で起きる。

Outbox 化すると送信は **Queue → mail consumer** で起きる。依頼のトランザクションが確定した時点で配送はまだ始まっておらず、**送信基盤の失敗が `requestPasswordReset` の応答に到達する経路が構造的に無くなる。** 行をそのまま残すと、「送信基盤障害で `SystemError` が返る」と読めてしまう。

### Decision

**行を2つに分ける。**

- 「トークンストア・**窓ストア**障害 → `SystemError`」（窓ストアが加わったので対象も1つ増える）
- 「送信基盤の失敗 → **依頼の応答には現れない**」を独立の行として書き、失敗は Queue の retry → DLQ が扱うことを添える

**「宛先の実在性に起因する失敗を応答に反映してはならない」という既存の注記は維持する。** これは列挙オラクル対策であり、配送が同期か非同期かとは独立している。

### 検討した代替案

**行をそのまま残す** — 差分が小さい。採らなかった理由は、**成立しない期待値がテスト設計へ流れる**こと。`spec/testcases/identity/requestPasswordReset.md` は現行のエラーケース表から導かれており、「送信基盤障害 → `SystemError`」のケースは改訂後には作れない（ステップ15 の担当者がその不整合をユースケース spec 側へ戻すことになる）。

**行を削除する** — 表が短くなる。採らなかった理由は、**「送信基盤の失敗はどうなるのか」という問いが表から消えるだけで、答えが要らなくなるわけではない**こと。S-AC-07 の異常系が「宛先実在性に起因する失敗を応答に反映しない」を要求しているので、その隣に「配送の失敗も応答に現れない」がある形のほうが読み手の問いに沿う。

### Consequences

- 良い点: 依頼の応答が同期に決まる範囲（入力検証・窓判定・トークン発行）だけで閉じることが表に出る。
- トレードオフ: エラーケース表が「エラーにならないもの」を2行持つ（未登録 / SSO 専用 / スロットル中の行と、送信基盤の行）。**表の性格が「例外の一覧」から「起こりうる終わり方の一覧」へ寄る**が、元の表が既に前者の行を持っていたので新しい逸脱ではない。

---

## AD-28: 新しく書く本文に「反映待ち」という語を持ち込まない

### Status

Proposed（**ステップ6・10 の実装中に確定した。plan.md の同時修正リストが持つ「7箇所・件数は動かない」を守るための書きぶりの規則である**）

### Context

plan.md と steps.md ステップ21 の同時修正リストは、**`grep -rn '反映待ち' spec | grep -v '/review/'` の件数を改訂前後とも 7 で固定**している。7箇所の内訳も名指しされており、「7箇所とも『検索については反映待ちが無い』を維持し、Outbox への言及を足すのは manual-tests の1箇所だけにする」という指示になっている。

ところがステップ6（`spec/domains/index.md` の派生データの項）とステップ10（`spec/requirements.md` §5.3 の即時整合の要件）は、**どちらも「検索は即時整合である」を新しく書く。** 素直に書くと「反映待ちは存在しない」という語が自然に出てきて、**件数が 7 → 9 に動く。** 初稿は実際にそうなった。

### Decision

**新規に書く本文では「反映待ち」という語を使わず、「即時整合」「直後の検索から必ずヒットする」で言い換える。**

- 意味は1文字も変えない。**変えるのは語の選択だけである。**
- 既存の7箇所は1つも触らない（うち上流3件は AC-21 の非変更検査の対象でもある）。
- **これは検査のために本文を歪める行為ではない。** 「反映待ち」は検索インデックスの文脈で使われてきた既存の語であり、要件層・ドメイン憲章層で同じ語を再掲する必然性が無い。むしろ、**同じ主張が7箇所から9箇所へ増えるほうが、後で1つ取り残される確率を上げる。**

### 検討した代替案

**書きたいように書いて同時修正リストの期待値を 7 → 9 に更新する** — 本文が自然になる。採らなかった理由は、**この行が数えているのは「同じ主張の再掲箇所」であり、増やすこと自体がリストの目的（片方だけ書き換わる乖離の防止）に逆行する**こと。AD-22 が「検査のために本文を歪めない」と決めたのは、**歪めないと成立しない場合**の話であり、ここは言い換えで意味が保てる。

### Consequences

- 良い点: 「反映待ち」の実在箇所が 7 のまま動かず、ステップ21 の検査6 が期待値のまま通る。
- 良い点: 「反映待ちが無い」という主張の所在が検索まわりの7箇所に閉じたままになる。
- トレードオフ: 後任が `grep '反映待ち'` だけで「即時整合の記述の全数」を数えると、要件層と憲章層の2箇所を取りこぼす。**その2箇所は「即時整合」という語を持つ**ので、両方を数えたいときは語を2つ並べて grep する。

---

## AD-29: `spec/inventory/adapter.md` の非同期配送は独立節に置き、ID を `ADP-{役割}-001` で採る

### Status

Proposed（**ステップ14 の実装中に確定した。AD-17 が層帰属を決めたが、台帳のどこに置くかと ID 体系を決めていなかった**）

### Context

AD-17 は「relay / mail consumer / DLQ ハンドラはアダプター層に属し、`spec/inventory/adapter.md` にだけ行を持つ」と決めた。しかし同台帳の構造は `## スキーマ / マイグレーション（テーブルごと）` と `## {ドメイン} ポート実装`（identity / memo / knowledge / search / trash / export）だけで、**3つはそのどれにも属さない** — テーブルでもドメインポートの実装でもないからである。ID も `ADP-{ドメイン}-{連番}` の形しか前例が無い。

### Decision

**`## 非同期配送（relay / consumer / DLQ）` を独立節として末尾に置き、ID は `ADP-outbox-relay-001` / `ADP-mail-consumer-001` / `ADP-dlq-handler-001` とする。**

- **ドメイン名の枠へ押し込まない。** `identity` の節へ入れると「identity ドメインのポート実装」に見えるが、relay も DLQ ハンドラも `identity.passwordResetRequested` に依存しない機構であり、イベント型が増えても行は増えない。
- **`ADP-{役割}-001` は既存の命名（`ADP-{テーブル名}-001` / `ADP-{ドメイン}-{連番}`）と同じ「対象を名前にする」形である。** 対象がテーブルでもドメインでもなく役割なので、役割名が入る。
- 節の冒頭に **AD-17 の判断（層帰属と「`spec/inventory/usecase.md` に行を足さない」）を1段落で置く。** ステップ13 が usecase 台帳を1行しか触らないことと対にするための記述点であり、行の中に埋めると読み手が探せない。

### Consequences

- 良い点: イベント型が増えても機構の行が増えないことが、節の分離として構造に出る。
- トレードオフ: 台帳の節が7つから8つになる。**節の数を数えている記述は無い**ので、閉じた数え上げは動かない。

---

## AD-30: `spec/inventory/adapter.md` の「現存テーブルは必ず schema 行を持つ」は明文として新設する

### Status

Proposed（**ステップ14 の実装中に確定した。steps.md の指示が前提としていた文が実ファイルに存在しなかった**）

### Context

steps.md ステップ14 は「**不変条件の言い方を実態へ揃える** — 『schema 行は DB のテーブル一覧と 1:1』は厳密には成立していない（…）『現存テーブルは必ず schema 行を持ち、廃止されたテーブルの行は履歴として残る』という向きへ言い換えたうえで新規3行を足す」と指示している。

**ところが実ファイルにはその不変条件を述べた文が1行も無い。** `## スキーマ / マイグレーション（テーブルごと）` という見出しと表があるだけで、1:1 を主張する文も、`ADP-users-001`（廃止・分裂した `users`）が例外であることを述べる文も存在しない。「言い換える」対象が無い。

### Decision

**見出しの直後に不変条件を1文で新設する** — 「現存するテーブルは必ず schema 行を持ち、廃止されたテーブルの行は履歴として残る。『schema 行と DB のテーブル一覧が 1:1』ではない」。

- **書かずに済ませない。** steps.md がこの不変条件を根拠に「新規3行を足す」と言っている以上、根拠のほうが暗黙のままだと、次に表を触る人が `ADP-users-001` を見て「1:1 が崩れている」と判断し、削除するか実テーブルを探しに行く。
- **「1:1」という言い方をしないことが本 AD の実質である。** 25 の schema 行に対して現存テーブルは 24（User Data 17 + Identity Directory 7）であり、差の1が `ADP-users-001` である。数を並べると必ずずれるので、**数ではなく向き**（現存 → 行は必ずある）で書く。

### Consequences

- 良い点: schema 行数（25）とテーブル数（24）が一致しないことの理由が台帳の中で閉じる。
- トレードオフ: 廃止された行が増えるほど差が開く。**差そのものを数えている記述は無い**ので、同時修正リストには載らない。

---

## AD-31: `TC-requestPasswordReset-014`〜`-018` は slug の行群の末尾へ置き、欠番規約の文言を単一表の実態へ揃える

### Status

Proposed（**ステップ16 の実装中に確定した。AD-15 と steps.md の「表の末尾に append」が既存 slug の追加ケースにも掛かるかを決めていなかった**）

### Context

AD-15 は「`spec/inventory/test.md` は見出しを持たない単一の表なので、新しい表は設けず、**既存表の末尾に `TC-outboxDelivery-*` を append する**」と決めた。steps.md ステップ16 はこれを「ステップ15 で追加したケースの `TC-*` 行を表の末尾に append」と書いており、**新 slug（`outboxDelivery`）と既存 slug（`requestPasswordReset`）の追加ケースを区別していない。**

文字どおり読むと `TC-requestPasswordReset-014`〜`-018` も表の最末尾に来る。ところが**現行の台帳は slug ごとに行が連続している**（54 slug すべてが1つの塊を作っている）。5行だけを 800 行以上離れた場所へ置くと、この構造を持つ唯一の台帳に構造の例外が1つできる。

一方、L7 の欠番規約は「新設は**各ユースケースの表**の末尾に append する」と書いており、**単一表であるという実態と食い違っている**（表は1つしかない）。

### Decision

**`TC-requestPasswordReset-014`〜`-018` は `-013` の直後（slug の行群の末尾）へ置き、`TC-outboxDelivery-*` は表全体の末尾へ置く。あわせて L7 の欠番規約を「同じ slug の行群の末尾に append し、新しい slug は表全体の末尾に append する」へ言い換える。**

**訂正: 最終的に append したのは `-014`〜`-021` の8件である**（見出しと本節が挙げる `-014`〜`-018` の5件は決定時点の見込みであり、ステップ15・16 の実装中に3件増えた）。**決定（同一 slug の行群の末尾へ置く／新しい slug は表全体の末尾へ置く）は8件すべてに掛かる。** 射程が5件に限られたと読まないこと — `-019`〜`-021` も `-018` の直後、`requestPasswordReset` の行群の末尾に連続して置かれている。

- **AD-15 の決定と矛盾しない。** AD-15 が禁じたのは「新しい表を設けること」であって、行の位置ではない。`TC-outboxDelivery-*` が表の末尾に来ることは変わらない。
- **位置の権威は `#L{n}` なので、行の並びは正しさに影響しない。** 影響するのは読み手が同じ slug の全ケースを1箇所で読めるかどうかだけであり、それは連続していたほうがよい。
- **L7 の言い換えは AD-15 の「規約の言い換えであって新設ではない」と同じ性質である** — 実体（slug ごとの連続した行群）は既に成立しており、規約文だけが「各ユースケースの表」と、存在しない複数表を前提に書かれていた。

### Consequences

- 良い点: 54 slug すべてが「連続した行群」という同じ形のまま、55 slug になる。
- 良い点: 欠番規約が単一表という実態と一致し、次に新 slug を足す人が「どの表か」を判断しなくてよくなる。
- トレードオフ: `#L{n}` を持たない読み手（連番だけを見る人）にとっては、`-013` と `-014` のあいだで採番時期が変わっていることが見えない。**欠番規約が既に「連番と現在の行順は一致しないことがある」と宣言している**ので、新しい逸脱ではない。

---

## AD-32: `requestPasswordReset` の「送信基盤障害」のケースは削除せず改訂で残す

### Status

Proposed（**ステップ15 の実装中に確定した。AD-27 の帰結をテスト側へ落とすときに生じた1点である**）

### Context

AD-27 は `spec/usecases/identity.md` のエラーケース表から「送信基盤障害 → `SystemError`」を分離し、「送信基盤の失敗 → **依頼の応答には現れない**」を独立の行にした。その検討した代替案には「**`spec/testcases/identity/requestPasswordReset.md` は現行のエラーケース表から導かれており、『送信基盤障害 → `SystemError`』のケースは改訂後には作れない**」とある。

これを「該当ケースを削除する」と読むと、`TC-requestPasswordReset-008` が欠番になる。**ところが実ファイルの当該ケースの期待結果は `SystemError` ではない** — 「依頼そのものの応答は成功のまま変わらない（宛先の実在性を応答に反映しない）。送信の失敗はジョブの再試行として扱われる」である。`SystemError` を期待していたのはユースケース spec のエラーケース表のほうだった。

### Decision

**ケースは削除せず、期待結果を AD-27 の新しい行に合わせて改訂する** — 「送信基盤の失敗は依頼の応答に一切現れない。失敗は Queue の retry → DLQ が扱う」。

- **主張は改訂の前後で変わっていない。** 変わったのは失敗を引き受ける機構（ジョブの再試行 → Queue の retry と DLQ）だけである。
- **削ると AD-27 が表に残した行に対応するケースが無くなる。** AD-27 が行を削除ではなく分離にした理由（「送信基盤の失敗はどうなるのか」という問いが表から消えるだけで、答えが要らなくなるわけではない）は、テスト側にもそのまま掛かる。
- **欠番を作らないほうが安い。** 欠番規約は削除したケースのために存在するのであって、書き換えれば成立するケースを削る理由にはならない。

### Consequences

- 良い点: エラーケース表の行とテストケースの対応が1対1のまま保たれる。
- 良い点: `TC-requestPasswordReset-008` の ID が指す対象が変わらない（要点だけが更新される）。

---

## AD-33: マニュアルテストの追加は3件（正常系1・異常系2）とし、合計を 204 → 207 にする

### Status

Proposed（**ステップ17 の実装中に確定した。AD-20 が追加先を確定したが、件数と種別内訳を決めていなかった**）

### Context

AD-20 は追加先を `spec/manual-tests/account.md` に確定し、「動く数は『`account.md` のケース数』と『合計 204』の2つだけである」とした。steps.md の同時修正リストも「**204 + 新規ケース数**」としか書いていない。受け入れ条件（AC-28）が求めるのは **Outbox backlog の観測 / quarantine 一覧 / DLQ の確認 / 再駆動の実行**の4項目である。

4項目を4ケースに1対1で割ると、**再駆動が単独のケースになって前提を作れない** — 再駆動には隔離された行か DLQ のメッセージが要り、それを作る手順は quarantine 側と DLQ 側で別物である。

### Decision

**3件にする。** TC-44（正常系。backlog の観測）/ TC-45（異常系。quarantine の一覧と再駆動）/ TC-46（異常系。DLQ の確認と再駆動）。**再駆動は独立のケースにせず、隔離先ごとに親のケースの手順として持たせる。**

- **AD-10 の分界がそのままケースの分け方になる。** 失敗の位置が「Queue に入る前か後か」で2つなら、隔離先も2つ、operator 導線も2つ、したがって復旧のケースも2つである。再駆動を1本に括ると、どちらの導線の話か毎回書き分けることになる。
- **backlog の観測を正常系に置く。** 観測手順そのものは障害時だけのものではなく、「依頼 → 行が積まれる → relay が捌く」という正常な配送の姿を確認する手順である。**fail-closed 由来の滞留の判別材料**（`read-schema-version` で `schema_version` を確かめる）はこのケースの確認ポイントに置く — 運用者が最初に見るのは backlog であり、そこに切り分けが無いと滞留を障害と誤診する。
- 種別内訳は **正常系 14 → 15 / 異常系 25 → 27 / 境界値 4（不変）**、`account.md` は **43 → 46**、合計は **204 → 207**。**カテゴリ数は 7 のまま動かない**（AD-20）。
- 配置は種別セクションの中の末尾（TC-44 は正常系の最後、TC-45 / TC-46 は異常系の最後）で、**番号は全体の末尾採番**である（`spec/manual-tests/index.md` の「追加したケースは既存の番号を繰り上げないよう末尾採番する」に従う。TC-38〜TC-43 が既に同じ形で置かれている）。

### 検討した代替案

**4項目を4ケースにする** — AC-28 の項目と1対1になる。採らなかった理由は上記のとおり、再駆動のケースが前提を持てず、結局 quarantine 側か DLQ 側のどちらかの手順を複製することになること。

**1ケースにまとめる** — 件数の変化が最小になる。採らなかった理由は、正常系の観測と2種類の障害復旧が1つの手順表に同居し、**どこまで実行できたら PASS なのかが決められない**こと（配送を失敗させる手段が用意できない環境では途中で止まる）。3件に分ければ、用意できない手段に依存するケースだけを対象外として記録できる。

### Consequences

- 良い点: 同時修正リストの「204 + 新規ケース数」が 207 で閉じ、カテゴリ数（7）は動かない。
- 良い点: 「観測手段の実体は #38 が定める」という書き方（`spec/manual-tests/trash.md` の先例）を、環境前提の1箇所にまとめて掛けられる。
- トレードオフ: `account.md` が運用者向けの手順を3本持つ最初のカテゴリーになる。**独立カテゴリーへ切り出す含み**は AD-20 が既に残している。

---

## AD-34: `CLAUDE.md` の「Retry は job runner の1箇所だけ」という断言を2箇所へ直し、委譲の例外をキュー境界に限る

### Status

Proposed（**ステップ19 の実装中に確定した。steps.md ステップ19 の列挙には無い箇所である**）

### Context

steps.md ステップ19 は改訂点を列挙しているが、その中に **Key concepts の「Retry strategy」の項**が入っていない。ところが同項は末尾で「**Retry exists in exactly one place — the job runner (see below) — and is never delegated to the platform.**」と閉じた数え上げをしており、これは非同期実行契約の項5（「Retry belongs to the job runner, not to the platform」）と対になった同じ断言である。

項5 に relay を足す（AD-4 / AD-10 が要求する）と、**項5 だけを直した場合に「1箇所」の断言が取り残される。** さらに「never delegated to the platform」は、AD-10 が Queue の retry と DLQ に完了管理を委ねると決めた以上、**無条件では成立しない。**

### Decision

**「Retry strategy」の末尾を2文に割り、DO の中と Queue の向こう側を分けて書く。**

- **DO の中では2箇所** — job runner と Outbox relay。ここは従来どおりプラットフォームへ委譲しない。
- **Queue 境界の向こう側では委譲する** — Queue の retry と DLQ が完了を管理する。これが「委譲する唯一の点」であることを明示し、AD-1 の判定規則2（実行責任の独立）と AD-10 の分界に一致させる。
- **数の権威は `CLAUDE.md` に残す**（`spec/async/index.md` へ委譲しない）。ここで数えているのは識別子ではなく規約上の retry の所在であり、AD-14 が `CLAUDE.md` から落とすと決めたのは**識別子の全数列挙**であって、規約そのものの断言ではない。

### 検討した代替案

**「Retry strategy」を無改訂で残す** — steps.md の列挙に忠実になる。採らなかった理由は、**同じファイルの中で項5 と正面から矛盾する**こと。閉じた数え上げが取り残される破れは `.thread/34/design.md` 第1.4節が記録した型そのものである。

**「exactly one place」を数のない表現（「the job runner and the relay」）へ逃がす** — 数を書かなければズレない。採らなかった理由は、**この項の要点が「retry する場所はここしかない」という閉じた列挙であること**。数を落とすと、後任が3箇所目を足すときに問われなくなる。

### Consequences

- 良い点: 項5・「worker → root」の catch policy・「Retry strategy」の3箇所が1つの数え方（DO の中は2箇所 / 委譲はキュー境界のみ）で揃う。
- トレードオフ: steps.md の列挙に無い箇所を触ったので、差分がステップの指示より1段落だけ広い。**`CLAUDE.md` の中で閉じており、`spec/` 側の数え上げには影響しない。**

---

## AD-35: `CLAUDE.md` のエントリポイント一覧を「役割ごとの3項」にし、D1 時代の4 Worker の列挙をそのまま残す

### Status

Proposed（**ステップ19 の実装中に確定した**）

### Context

steps.md ステップ19 は、エントリポイント一覧に「relay が DO の `alarm()` の中にあること、consumer / DLQ が request Worker の `queue()` ハンドラであること」を反映せよと言う一方、「Migration in progress」の項については「**worker の列挙が `relay` / `consumer` / `pruner` / `dlq` の4本であることは現行どおり維持する**」と言う。

改訂前の一覧は `apps/web/app/server.cloudflare.ts` と4 Worker のファイルパスを1行に並べた形で、**現に動いているコードの入口**を書いている。ここを目標構成の入口だけに差し替えると、「Migration in progress」の「**The four workers in the entry-point list above**」という後方参照が指す先が消える。

### Decision

**一覧を3項に割り、目標構成の入口2項と「現に disk にある4本」の1項を並べる。**

1. request Worker（`server.cloudflare.ts` + consumer / DLQ を載せる `queue()` ハンドラ）
2. **relay は固有の入口を持たない** — 各 DO の `alarm()` の中で、local job のパスより先に走る
3. D1 時代から残っていて実際に動いている `apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq}.ts` の4本（「Migration in progress」へのポインタつき）

- **2 を独立の項として書くのは、「入口が無い」ことが設計上の主張だからである。** 落とすと、後任が relay 用のハンドラを探すか、新設してよいと読む。
- **3 を残すことで後方参照が生き、`CLAUDE.md` の他の記述（`pnpm start` が起動しない理由の段落が `eventRelayWorker.ts` を名指しする）とも噛み合う。**

### Consequences

- 良い点: 「規約は目標構成・1箇所だけが現状を語る」という `CLAUDE.md` の建て付けを崩さずに、両方を同じ節で読める。
- トレードオフ: 一覧が1行から3行に増える。#51 が着地したら 3 を消して2行に戻る。

---

## AD-36: `owner_token` は「claim ごと・行ごとの capability」であり、秘密として扱う

### Status

Proposed（**レビュー1周目のトリアージで確定した。security B-001 / B-002 への決定**）

### Context

`outbox_events.owner_token` は AD-6 の呼び出しガードの 3. の照合材料であり、`(event.id, owner_token)` を握れば送信材料 RPC が `send` を返す。**ガードの3条件のうち秘密を含むのはこの1つだけである**（1. 行の存在と 2. `quarantined` でないことは行の状態であって秘密ではない）。

ところが列の説明は `jobs.owner_token` からの引き写しで「claim した実行主体の識別子」のままであり、`jobs` ではそれで正しい — CAS の所有権照合にしか使わないので、**1回の起床につき1個**の値を全 claim 行へ書く実装で何も壊れない。むしろそれが最も素直な実装である。加えて衛生規則は「Queue メッセージと DLQ に再利用可能な秘密を載せない」と宣言しているのに、同じ正本が `owner_token` を Queue メッセージへ載せることを要求している。**載せること自体はガードの成立条件なので動かせない。**

### Decision

**秘密区分と生成要件の2つを明示する。**

1. **`owner_token` は再利用可能な秘密である。** Queue メッセージと DLQ に載るのは**ガードの成立に必要だからという明示的な例外**であって、衛生規則の対象外だからではない。したがって禁止則を2条置く — (i) **Queue メッセージ全体を含めてログへ出さない**（consumer / DLQ ハンドラのエラーログに載せてよいのは `event.id` / `type` まで）、(ii) **DLQ のメッセージを外部の監視基盤・ログ集約先へ転送しない**（転送する設計を足すなら AD-6 へ差し戻す。plan.md [P-002] の引き継ぎを正本へ降ろした形である）。
2. **`owner_token` は claim ごと・行ごとに一意である。** 暗号論的乱数から生成し、時刻・連番・DO 識別子など推測可能な材料から導かない。長さの下限は 128 bit。`jobs` からの引き写し文（「claim した実行主体の識別子」）を `outbox_events` 側では使わない。

**主キーではないので、`spec/database/index.md` の「ID の例外は2つで全数」の数え上げには入らない**（AD-24 の枠を動かさない）。

### 検討した代替案

**「短命の capability なので DLQ 保持期間の制約1本で足りる」とだけ書く** — 記述量は最小。採らなかった理由は、**ログの保持期間と監視基盤の転送先には何の制約も掛からない**こと。AD-37 で制約1が防壁でないと確定した以上、この案では防壁が1つも残らない。

**生成を「1回の relay パスにつき1個」で許す（`jobs` と同じ実装）** — 実装が `jobs` と完全に共有できる。採らなかった理由は、**同じ起床で claim された全行が同じ値を共有する**こと。`event.id` は Queue メッセージと DLQ を通るので、DLQ に落ちた1件から token を得た者が同じバッチの他の行のガードを通せる。**実効的な破れである。**

### Consequences

- 良い点: ガードの強度が実装裁量から出る。実装コストは claim ごとの乱数生成1回で、`password_reset_tokens.token_id` の既存要件と同じ形である。
- 良い点: 衛生規則と Queue メッセージ仕様の矛盾が「例外の明示」で解け、実装者が「`owner_token` は秘密ではない」と読んで矛盾を解消する経路が閉じる。
- トレードオフ: 降ろす先が5箇所ある — `spec/async/index.md`（衛生規則 + 呼び出しガード）/ `spec/database/index.md` の列定義 / `spec/inventory/adapter.md` の `ADP-outbox-events-001`・`ADP-outbox-relay-001` / `spec/testcases/async/outboxDelivery.md`（行間の相異を測るケース）/ `spec/manual-tests/account.md` TC-46 手順4（確認後に写しを残さない）。`.adr/013` は「なぜその区分にしたか」だけを持ち、値と規則の正本は `spec/` 側に置く。
- トレードオフ: (ii) は #38 の運用設計を先取りして縛る。ただし plan.md [P-002] が既に同じ引き継ぎを持っているので、新しい制約ではなく所在の移動である。

---

## AD-37: 運用値の制約1（`DLQ 保持期間 < トークン TTL`）は機能要件であり、持参人証への防壁ではない

### Status

Proposed（**レビュー1周目のトリアージで確定した。test W-004 への決定**）

### Context

AD-6 の 3. は制約1の根拠を「満たしていれば DLQ からの再駆動が成功しても**トークンは既に失効している**」と書いていた。**これは不等式が意味することの逆である** — `DLQ 保持期間 < TTL` なら、DLQ に滞在しているあいだの再駆動は TTL の内側に収まり、**トークンは生きている。**

実際の期待値もそちら側に立っている（`spec/testcases/async/outboxDelivery.md` と `spec/manual-tests/account.md` TC-46 の主期待値は「再駆動でリセットメールが**届く**」）。にもかかわらず同じ制約が `.adr/013` の影響と plan.md [P-002] で「持参人証に対する実効的な防壁」として引かれているので、**防壁の根拠がそのまま崩れる。**

### Decision

**不等式の方向は動かさない**（AC-20 / plan.md が確定済み）。**制約1の目的を機能要件として書き直す** — 「DLQ からの再駆動が有効なリンクを届けられる」。制約2（`Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間`）も同じ性格で、「再駆動の時点で行がまだ存在しガードを通れる」ことを保証する。

**持参人証への防壁は AD-36 の禁止則（ログ非出力・DLQ 非転送）と、DLQ に到達できる者の制御（#38）の2本である。** `.adr/013` の影響と plan.md [P-002] の「実効的な防壁は制約1本」を、この形へ書き直す。

- **訂正（レビュー4周目・B-003）: 制約1 の左辺は `Queue の最大 retry 期間 + DLQ の保持期間` である。** 本 AD の表題と本文が持つ `DLQ 保持期間 < トークン TTL` はそれ以前の版であり、確定形は **`Queue の最大 retry 期間 + DLQ の保持期間 < リセットトークンの TTL`** である。**本 AD の結論（不等式の方向を動かさない / 制約1 は機能要件であって防壁ではない）は動かない** — 動いたのは左辺の完成度だけで、`DLQ 保持期間 < TTL` とだけ書くと機能要件そのものが導けないことが4周目に判明した。

### 検討した代替案

**制約1を防壁として維持し、不等式を `DLQ 保持期間 ≥ トークン TTL` へ反転させる** — 防壁としては筋が通る。採らなかった理由は、**AC-20 と plan.md [P-002] が名指しで固定した方向の反転**であり、決定済み事項の変更に当たること。テストとマニュアルテストの主期待値も「届かない」へ倒れる。

**説明文だけを最小限に直し、防壁の話には触れない** — 1文で済む。採らなかった理由は、`.adr/013` の影響に「実効的な防壁は制約1本」が残り、AD-36 と食い違ったままになること。

### Consequences

- 良い点: TC-46 手順6 の期待値が「届く」で一意に固定でき、判定不能が消える。
- 良い点: 制約2本が同じ性格（機能要件）で揃い、「防壁」と「機能要件」が同じ不等式に同居しなくなる。
- トレードオフ: plan.md [P-002] は契約なので、訂正するなら差分を明示する必要がある。**決定順序は AD-36 → AD-37**（禁止則が防壁の本体になる）。

---

## AD-38: `quarantined` 行は保持期間を持たず、運用者の再駆動か明示削除まで恒久保持する

### Status

Proposed（**レビュー1周目のトリアージで確定した。persistence B-001 への決定**）

### Context

`spec/database/index.md` の共通規約は prune を「保持期間を過ぎた**終端行**を上限件数だけ削除」と定義しているが、同ファイルの別の2箇所は「`published` を削除して `quarantined` は残す」と「保持期間は `published` と `quarantined` で**別に持つ**」と書いており、3つは両立しない。消す実装も消さない実装も spec のどこかに違反する。

本 PR は `outbox_events` を 10 GB に算入すると新たに宣言したので、恒久保持なら上限の無い増加要因が1つ増える。隔離は Queue producer binding の障害で一斉に起きうる。

### Decision

**`quarantined` に保持期間を置かない。** prune が消すのは**保持期間を過ぎた `published` の行だけ**であり、隔離行は運用者が再駆動するか明示的に削除するまで残る。共通規約の「終端行」を「`published` 行」へ改め、「保持期間を別に持つ」の記述を書き換える。

あわせて代償を2箇所へ明記する — 10 GB 算入の項へ「**隔離行は自動では減らない**」、operator 導線へ「**減らす手段は再駆動と明示削除だけ**」。

### 検討した代替案

**`quarantined` にも保持期間を置き prune の対象に含める（`jobs` の `poison` と同じ扱い）** — 共通規約の文言をそのまま生かせ、10 GB の増加要因も有界になる。採らなかった理由は、**`.adr/013` §16（前方互換点3本の据え置き）の論拠が「`quarantined` の行は残す」に依存している**こと。採ると ADR 本文の論拠まで書き換えることになり、かつ**運用者が原因を調べる前に材料が消える窓**が生まれる。

### Consequences

- 良い点: 既に「残す」で揃っている3箇所（`.adr/013` §12 / §16 と `spec/database/index.md` の2箇所）をそのまま生かせ、修正は本文2箇所 + 注記2箇所で閉じる。
- 良い点: 隔離行が自動では減らないことを、**明示的な運用制約**として #38 へ渡せる。
- トレードオフ: 一斉隔離時の増加が運用でしか止まらない。10 GB へ向かう増加要因が1つ、上限なしで残る。

---

## AD-39: `.adr/013` の長さは維持し、同期義務の向きを冒頭1行で宣言する

### Status

Proposed（**レビュー1周目のトリアージで確定した。adr W-005 への決定**）

### Context

既存の `.adr/*` 12本は 29〜44行で、詳細は `spec/` や作業ログへ委ねている。`.adr/013` は 223行あり、閉じた数え上げ4種（運用値の制約2本 / 呼び出しガード3条件 / quarantine と DLQ の分界表 / 前方互換点3本）を `spec/` と重複して持つ。同じ PR が AD-11 / AD-14 で「『全数』を名乗る表を2箇所に持つと必ず片方が取り残される」を根拠に `CLAUDE.md` から列挙を落としているので、向きが逆に見える。

### Decision

**現状の粒度を維持し、冒頭に「本 ADR は例外的に長い。数と値域の正本は `spec/async/index.md` / `spec/database/index.md` であり、本文の数値は決定当時の記録である」を1行置く。**

- この Issue は「1つの設計訂正で6機構が同時に動く」性質であり、**長さそのものは正当化できる。** 実害は同期義務の向き（spec が正、ADR は記録）が不明なことに絞られ、それは1行で閉じる。
- ADR は**凍結文書**なので、決定当時の値を残すこと自体に価値がある。`CLAUDE.md` から落とした列挙は「更新され続ける規約の中の識別子」であり、性格が違う。

### 検討した代替案

**数と値域を `spec/` への参照へ落とし、ADR には「なぜそう分けたか」だけを残す** — AD-11 / AD-14 と同じ原則で一貫する。採らなかった理由は、**削る作業が同ラウンドの他の修正（列の分類・失効範囲・影響の追加）と正面から衝突する**こと、および決定当時の値を残す価値を失うこと。

**2本（分類規則 + 表の設計 / 送信材料 RPC + スロットル窓）へ分割する** — `.adr/010` の前例（機構1つに ADR 1本）に近づく。採らなかった理由は、番号が `.adr/014` まで動き、`spec/` 側の参照20箇所以上を書き換えることになること。

### Consequences

- 良い点: 以後の同期義務の向きが明示され、数が動いたときに「どちらを正として直すか」が一意になる。
- トレードオフ: 長さそのものは残る。**次に同種の ADR を書くときの前例にはしない** — 例外であることを本文が自称している。

---

## AD-40: イベント payload から宛先 DO の routing key を落とし、relay が publish 時に Queue メッセージへ押す

### Status

Proposed（**レビュー1周目のトリアージで確定した。論点4 への決定。AD-6 の Decision の 1項目を訂正する**）

### Context

AD-6 は event payload に載せるものを `tokenId` / メール種別 / **発行元 Identity Directory bucket の routing key** の3つと決めた。ところが AD-5 が復元したドメインイベントの契約では、ドメインが返すのは identity-less な draft（`{ type, payload, occurredAt, aggregateId }`）であり、**配送のための識別子である `EventId` はアプリケーション層が付ける。** routing key も同じく配送のための識別子であり、ドメインは自分がどの DO に載っているかを知らない。3つ目を payload に含めたままにすると、**draft ファクトリが routing key を引数に取ることになり、`.adr/013` 5.（配送機構をドメインへ出さない）と正面から衝突する。**

一方で Queue メッセージのほうは routing key を運ばなければ送信材料 RPC の宛先を選べない。**「payload に無い」と「Queue メッセージに無い」は別の命題である。**

### Decision

**routing key をドメイン draft の payload から落とす。ドメイン payload は `tokenId` / メール種別の2つだけである。routing key は relay が publish 時に Queue メッセージへ押す項目とする。**

- `EventId` と同じ扱いになる — どちらも配送のための識別子であり、ドメインではなくアプリケーション層 / アダプターが付ける。
- **relay は自分の DO の routing key を自明に知っている**ので、行にもドメイン payload にも持たせる必要が無い。**訂正（レビュー2周目・W-019 / レビュー4周目・B-005）: 「導出鍵を持つのはアダプター（DO クラス）だけである」という一文は落とす** — routing key の粒度は発行元 DO 自身の locator（`dir:g{世代}:b{番号}`）であって鍵付きハッシュではないので、そもそも導出鍵が要らない。加えて canonical を全長 HMAC へ写す写像鍵は request Worker 側（stub 選択アダプター）にあり DO の中には無いので（AD-45 / `.adr/013` の「影響」）、この一文は二重に誤りである。
- **Queue メッセージの5項目（`event.id` / `type` / `payload` / 宛先 DO の routing key / `owner_token`）は動かない。** 落としたのは payload の内訳としての routing key であって、メッセージの項目ではない。
- 記述点は `spec/domains/index.md`（draft の契約）/ `spec/domains/identity.md`（payload 欄と draft ファクトリの引数）/ `spec/usecases/identity.md` / `spec/async/index.md` の全数表 / `spec/inventory/{domain,usecase}.md` / `spec/testcases/identity/requestPasswordReset.md` であり、**Queue メッセージ側（`spec/async/index.md`「Queue メッセージ」/ `spec/inventory/adapter.md` の relay 行 / `spec/manual-tests/account.md` の DLQ 確認手順）は5項目のまま維持する。**

### 検討した代替案

**payload に残したまま、ドメインには「アダプターが後から埋める欄」として持たせる** — Queue メッセージの組み立てが素朴になる。採らなかった理由は、**draft の形が「ドメインが決められない欄を持つ」形になる**こと。AD-5 が `enqueueEvent` を1つの登録口に固定したのは行の形を一様に保つためであり、後から埋める欄はその保証を崩す。列挙オラクル対策として `tokenId` を nullable にしない決定（AD-6）とも整合しない。

**routing key を `aggregate_id` で兼ねる** — 列も payload も増えない。採らなかった理由は、AD-26 が `aggregate_id` をスロットル窓のキー（`windowKey`）に確定させており、**窓キーは DO の外へ出さない**（同一アドレス・同一窓に対して安定した仮名なので、DLQ 上で複数メッセージを同じ宛先へ相関させる材料になる）と決めているためである。兼ねると Queue メッセージに窓キーが載る。

### Consequences

- 良い点: ドメイン payload の項目が2つに減り、`.adr/013` 5.（配送機構をドメインへ出さない）と一貫する。draft ファクトリは routing key を引数に取らない。
- 良い点: **payload の禁止項目の規則が単純になる** — 「PII と再利用可能な秘密を載せない」だけで済み、「ただし鍵付きハッシュ済みの routing key は例外」という但し書きが要らなくなる。但し書きは Queue メッセージ側の衛生規則へ移り、そこで `owner_token` の例外と並ぶ。
- トレードオフ: 「payload の routing key」と「Queue メッセージの routing key」が別物であることを、両方を書くすべての箇所で明示し続ける義務が残る。**片方だけを読んで「routing key は載らない」と読まれると、relay が宛先を選べない実装になる。**
- 波及: AD-6 の Decision の該当項に訂正の注記を置く。**AD-6 の他の決定（送信材料 RPC・応答2分岐・呼び出しガード3条件・運用値の制約2本）は本 AD の射程外であり、有効なままである。**

---

## AD-41: `{ entity, eventDrafts }` は「イベントを発行するファクトリ / 遷移」の契約であり、無条件の宣言にしない

### Status

Proposed（**レビュー2周目のトリアージで確定した。論点7 への決定。AD-5 の契約の射程を狭める**）

### Context

AD-5 はイベント登録口を `enqueueEvent` の1つに固定し、ドメイン側は identity-less な draft を返す形を復元した。その復元の一部として `WithEventDrafts<TEntity, TEvent>`（ファクトリ / 遷移が `{ entity, eventDrafts }` を返す形）が納品物へ入ったが、**無条件の宣言として書かれている** — `spec/domains/index.md` の共通契約、`spec/domains/identity.md` の契約表、`spec/inventory/domain.md`（`DOM-identity-048`）の3箇所である。しかも台帳側は「イベントを発行しない遷移では `eventDrafts` が空になる」と書き、限定解釈の余地を自ら塞いでいる。

ところが**本 PR で変更していない既存規約と正面から衝突する。** `spec/domains/memo.md` / `spec/domains/knowledge.md` は「状態遷移は次状態のエンティティだけを返す」と書き、`spec/domains/identity.md` のファクトリ / 遷移はすべて `): User;` である。**実インスタンスはリポジトリ全体で0件**で、唯一のイベント `identity.passwordResetRequested` は draft ファクトリ経由で出る。

### Decision

**契約を条件つきへ狭める。「イベントを発行するファクトリ / 遷移は `{ entity, eventDrafts }` を返す。現状そのような遷移は存在しないので、既存の『状態遷移は次状態のエンティティだけを返す』は動かない」とする。** `DOM-identity-048` の「イベントを発行しない遷移では `eventDrafts` が空になる」は削り、「**この形は将来イベントを発行する遷移が現れたときの契約であり、現在インスタンスは0件**」へ置き換える。

- **AC-16（登録口を1つに固定）は `enqueueEvent` 側で既に満たされている。** `{ entity, eventDrafts }` を無条件で義務づける必要は契約上どこにも無く、義務づけると「イベントを1つも持たないドメインのファクトリまで戻り値の形を変える」導線になる。
- **記述点は3ファイルで閉じる** — `spec/domains/index.md` / `spec/domains/identity.md` / `spec/inventory/domain.md`。**`spec/domains/memo.md` / `knowledge.md` / `trash.md` は触らない。**
- 将来形としての価値は残る。「イベントを発行する遷移が現れたときの形」を先に決めてあるので、そのときに設計をやり直さずに済む。

### 検討した代替案

**無条件のまま残し、既存規約側に例外を書く**（`memo.md` / `knowledge.md` に「イベントを発行する遷移は例外」を足す）— 契約文が強い形のまま保たれる。採らなかった理由は、**実インスタンス0件の形のために、イベントを1つも持たない4ドメインの規約文を書き換える**ことになり波及が最大であること。#51 が全ファクトリのシグネチャを機械的に変える導線がむしろ強まる。

**`{ entity, eventDrafts }` の行そのものを共通契約から落とし、draft ファクトリ1本に一本化する** — 記述量は最小になる。採らなかった理由は、将来 User Data DO にイベントが増えたとき（`spec/async/index.md` が明示的に想定している）に「遷移とイベントを1つの戻り値で表す」形の設計をゼロからやり直すことになり、`.adr/013` 5.（`EventId` を UoW 側へ寄せた分離）の文脈も失うこと。

### Consequences

- 良い点: 既存規約との衝突が完全に消える。**本 PR で触っていないファイル（`memo.md` / `knowledge.md`）が正しいままでいられる。**
- 良い点: 「インスタンスは0件」と書くことで、後任が実例を探して見つからない時間が消える。
- トレードオフ: 契約が「将来こう書く」形として弱くなる。イベントを発行する遷移を最初に書く人が、限定の意味を読み違えて別の形を持ち込む余地は残る。

---

## AD-42: relay 相3 の失敗分岐（上限未到達）は `pending` へ戻し、`lease_until` / `owner_token` を解放する

### Status

Proposed（**レビュー2周目のトリアージで確定した。論点8 への決定。AD-4 の相3 を確定させる**）

### Context

AD-4 は relay の相3 を「`published` へ落とす／失敗なら `attempt` を進め backoff で `next_run_at` を先送り／上限超過は `quarantined`」と書き、**上限に達していない失敗のときに `status` / `lease_until` / `owner_token` をどうするかを書いていない。** 納品物（`spec/database/index.md`）も同じ形で、終端（`published` / `quarantined`）の列の扱いだけが確定していた。

素直に読むと、行は `publishing` のまま `attempt` と `next_run_at` だけが進む。すると **「leased 行では `next_run_at ≤ lease_until` が常に成り立つ」という不変条件が破れる。** この不変条件は、Alarm の張り直しを4本の min へ分解してよい根拠そのもの（AD-4 の訂正）なので、破れると分解の正当化が崩れる。

### Decision

**上限に達していない失敗は、同じトランザクションで `status='pending'` へ戻し、`lease_until` / `owner_token` を解放したうえで `attempt` と `next_run_at` を書く。** あわせて**claim の選択述語が `next_run_at <= now` を含むことを規範として明記する**（現状は本文中の括弧書きにしかない。**なお実行可能集合そのものは `status` だけで定義したままにする** — 時刻の条件を集合の定義へ入れると、まだ時刻の来ていない行しか残っていない DO で「両表の実行可能集合が空」が成立して `deleteAlarm()` が打たれ、その DO が二度と起きなくなる。正本は `spec/database/index.md`「Alarm の多重化」）。

- **既存のチャンク上限の規則と同じ形である** — local job がチャンク反復の上限に達したとき、進捗をコミットするのと同じトランザクションで `pending` へ戻し `lease_until` / `owner_token` を解放する。新しい概念を持ち込まない。
- **`jobs` にも同じ形で掛かる**（共通化する規約の側）。`outbox_events` 側だけを直すと、共通化しているはずの backoff 規約が2表で割れる。
- **`owner_token` の解放は at-least-once の観点でも安全側である。** その回に Queue へ出た（かもしれない）メッセージの持参人証が即座に失効し、再 claim で新しい値が振られる。
- **終端行で `owner_token` を残す規則（AD-6 の 2.）とは別の分岐である。** 残すのは `published` / `quarantined` の行だけで、`pending` へ戻る行は照合材料として残す理由が無い。

### 検討した代替案

**`publishing` のまま保ち、`next_run_at` を `lease_until` の内側へ丸める** — 不変条件は保たれ、lease の満了だけが再 claim の契機になるので状態機械が単純になる。採らなかった理由は、**backoff の効き幅が lease の長さに縛られる**こと。lease より長い backoff が書けず、上限回数まで持たせるには lease を延ばすしかない。延ばすと DO reset からの回収も同じだけ遅くなる。

**spec には書かず #51 の実装裁量に委ねる** — 記述が増えない。採らなかった理由は、本 Issue の成果物が設計の確定であり、**4本の min という納品物が明示的に選んだ形の正当化が「実装がどちらを選ぶか」に依存したまま残る**こと。委ねる先の判断が納品物の他の記述を左右してしまう。

### Consequences

- 良い点: 不変条件（leased 行では `next_run_at ≤ lease_until`）と4本 min の分解が無傷で保たれる。
- 良い点: `jobs` と `outbox_events` で失敗時の状態遷移が同一になり、ランナー実装の共有（AD-2 の「共通化する規約」）が実際に成立する。
- トレードオフ: 記述の範囲が1表ぶん広がる（`jobs` 側も同時に確定させる）。
- トレードオフ: #51 の裁量として残るのは backoff の係数と上限回数だけになる。どちらももともと #38 / #51 の運用値なので、新しい制約ではない。

---

## AD-43: 3点同時確定 / rollback のテストケースは DO クラスごとに分割し、契約文（3点）は動かさない

### Status

Proposed（**レビュー2周目のトリアージで確定した。論点9 への決定。AC-12 の契約には触れない**）

### Context

AC-12 は「業務データ更新・FTS5 projection・`outbox_events` の追加が**同じ `transactionSync`** で確定する」を契約として3箇所（`spec/database/index.md` / `spec/usecases/*` の共通事項 / `CLAUDE.md`）へ落とすことを求めており、納品物はそのとおりになっている。**契約は正しい。**

一方でテスト側は今日そのままでは実行できない。FTS5（`search_entries` / `search_fts`）は **User Data DO にしか無く**、定義された唯一のイベント型 `identity.passwordResetRequested` は **Identity Directory DO 所属**で、AD-3 が User Data DO のイベント型を初期0件と明示している。したがって「FTS5 projection を更新し、かつ `enqueueEvent` する」ユースケースは存在せず、実現できるのは (a) User Data DO の「業務データ + FTS5」、(b) Identity Directory DO の「業務データ（窓行・トークン行）+ イベント行」の**2種のペアまで**である。テスト専用の `event.type` をでっち上げる回避は、「consumer 欄が空のイベントは存在しない」という全数表の不変条件に反する。

### Decision

**`TC-outboxDelivery-001` / `-002` を「その DO クラスに存在する要素の全部が同じ `transactionSync` で確定する / 巻き戻る」と書き直し、測る対象を DO クラスごとに明示する**（User Data: 業務行 + FTS5 / Identity Directory: 窓行・トークン行 + イベント行）。**表の直前の解説に「3点が同時に成立するのは User Data DO のイベント型が1つでも定義された時点であり、そのとき本ケースを3点版へ拡張する」を1行足す。** 台帳 `spec/inventory/test.md` の該当2行も同時に直す。

- **契約文（AC-12 の3箇所）は1文字も動かさない。** 食い違っているのは契約ではなくテストの実行可能性だけであり、直す先はテスト側である。
- **今日そのまま実行できる形になる。** 原子性という最重要契約が、今日1件もテストされない状態を作らない。
- **将来の拡張条件が spec の中に残る。** User Data DO にイベント型が増えた人が、拡張すべきケースを探さずに済む。

### 検討した代替案

**条件つきケースとして残す**（「User Data DO にイベント型が定義されたときに実行する」を前提条件にし、それまでは対象外）— 記述の変更が最小。採らなかった理由は、**中心的な検証点（原子性）が今日1件も実行されないケースになる**こと。マニュアルテストの「手段が用意できない環境は対象外」と同じ扱いに見えるが、あちらは環境の都合であり、こちらは spec が自ら0件と決めた帰結なので性質が違う。

**契約側を「その DO クラスに存在する要素の全部」へ緩める** — テストと契約が字面で一致する。採らなかった理由は、**AC-12 が名指しで固定した3箇所を書き換えることになり、決定済みの受け入れ基準に触れる**こと。将来 User Data DO にイベントが増えたときに契約を戻す作業も発生する。

### Consequences

- 良い点: 契約（3点）とテスト（今日はペアまで）の食い違いが、テスト側の1行の明示で閉じる。`spec/async/index.md` の不変条件にも触れない。
- 良い点: 「なぜ今日は2点なのか」が spec に残るので、レビューのたびに同じ疑問が再発しない。
- トレードオフ: ケースの前提欄が DO クラスごとに2行へ割れ、`TC-001` / `-002` の記述量が増える。

---

## AD-44: 送信材料 RPC の `send` は「宛先・生リセットトークン・`providerIdempotencyKey`」の3点を返す。URL 組み立てとレンダリングは `MailSender` アダプターが持つ

### Status

Proposed（**レビュー3周目のトリアージで確定した。論点10 への決定。AD-6 の応答の中身を確定させる**）

### Context

AD-6 は応答 `send` を「宛先・**レンダリング済み本文**・`providerIdempotencyKey`」と書き、同じ項で「consumer が受け取るのは**送信直前の完成品**である」と述べていた。納品物の `spec/async/index.md` もその形で書かれていた。

ところが、**その後に確定した3つの記述はいずれも「本文は consumer 側で作る」を前提にしている。**

- `MailSender.sendPasswordResetMail(to, resetToken, providerIdempotencyKey)` — 2周目に確定した3引数の signature に、**本文を受け取る引数が無い。**
- `spec/domains/identity.md` の `MailSender` の JSDoc と `ADP-identity-016` — 「**リセットリンク（トークン込み URL の組み立て含む）**をメール送信する」＝ URL 組み立てはアダプターの責務。
- `spec/async/index.md` の衛生規則 — 「**宛先メールアドレスと生トークンは送信材料 RPC の応答として境界を越え**、配送の瞬間だけ consumer のメモリに載る」。

**4者が同時に真になる読みが存在しない。** どれか1つを実体として選ぶ必要がある。

### Decision

**応答 `send` が持つのは「宛先・生リセットトークン・`providerIdempotencyKey`」の3つである。URL の組み立てとメール本文のレンダリングは `MailSender` アダプター（request Worker）の責務であり、DO はテンプレートも base URL も持たない。**

- **DO の中に閉じるのは復号と HMAC 導出であって、レンダリングではない。** AD-6 が守ろうとした性質（復号鍵と HMAC 導出鍵が DO の外へ出ない／宛先と生トークンがどこにも永続化されない。**前者の射程は AD-6 Consequences 3. の訂正のとおりで、canonical を全長 HMAC へ写す写像鍵は含まない**）は、生トークンを返す形でも1つも落ちない — 衛生規則がすでにその形で書かれている。
- **これは新しい設計判断ではなく「4通りの記述のうちどれが実体か」の確定である。** 変えるのは正本2つの文言（`spec/async/index.md` の送信材料 RPC 節と `.adr/013` の 6.）だけで、決定済みの signature も台帳も動かない。
- **`CLAUDE.md` の「CPU-bound work は request Worker」とも整合する。** レンダリングを DO へ寄せると、`.adr/013` が「影響」で受け入れた**バケット共有 DO の直列化キュー占有**が本文レンダリングのぶんだけ増える。
- **応答が2分岐で全数であること、`nothing-to-send` が理由を1つも載せない空の分岐であること、呼び出しガード3条件は動かない。**

### 検討した代替案

**応答をレンダリング済み本文に確定し、`MailSender` の signature を変える** — AD-6 の原文をそのまま活かせる。採らなかった理由は、**2周目に確定した signature（AD-6 の訂正）と `ADP-identity-016` / `MailSender` の JSDoc / ユースケース手順7 を全部書き換える決定の巻き戻しになる**こと。加えて DO 側にアプリの base URL とメールテンプレートを持ち込む必要が生じ、`CLAUDE.md` の「CPU-bound work は request Worker」と衝突し、受け入れ済みの DO 占有コストが増える。

**両方を返す（本文も生トークンも）** — どちらの読みも壊さない。採らなかった理由は、**同じ情報を2つの形で境界の外へ出すことになり、衛生規則の「載る秘密は最小限」と正面から矛盾する**こと。加えて「どちらを使うか」が consumer の裁量になり、応答の全数宣言が実質的に開く。

### Consequences

- 良い点: 決定済みの signature・衛生規則・`MailSender` の JSDoc・`ADP-identity-016` の4者が同時に真になる。
- 良い点: バケット共有の Identity Directory DO の直列化キュー占有が、本文レンダリングのぶんだけ軽くなる（`.adr/013` の「影響」が受け入れたコストの上限が下がる）。
- トレードオフ: **生トークンが DO の外（consumer のメモリ）に出る点は変わらない** — これは AD-6 の Consequences が既に「保証範囲は『載らない・永続化されない』であって『境界を出ない』ではない」として受け入れ済みの範囲である。
- トレードオフ: メールテンプレートと base URL の帰属が request Worker 側に確定する。#51 が `MailSender` アダプターを書くときの前提になる。

---

## AD-45: `windowKey` は stub 選択アダプターが計算済みの全長 HMAC を facade へ渡し、ユースケースが窓と合成する。新しいポートを足さない

### Status

Proposed（**レビュー3周目のトリアージで確定した。論点11 への決定。AD-19 が書かなかった導出主体を閉じる**）

### Context

AD-19 は `windowKey` を「呼び出し側が導出して渡す。ポートは導出鍵を知らない」と決めたが、**「呼び出し側」が誰なのかを書いていない。** 納品物では次の3つが同時に成立していて、契約が閉じていなかった。

- `spec/domains/identity.md`「`windowKey` は呼び出し側が導出して渡す … ポートは導出鍵を知らない」
- `spec/usecases/identity.md`「同じ値を**本ユースケース**（`windowKey` の導出）とアダプターの2層が読む」＝ 導出主体はユースケース
- `ADP-identity-027`「**`windowKey` はアダプターが導出せず引数で受け取る**」＝ 窓ストアのアダプターでの導出は明示的に禁止

ところが**ユースケースが HMAC を得る経路が無い** — `container` の9ポートのどれにも canonical の全長 HMAC を返す口が無く、未登録アドレスでは `credential_mappings` の行も無いので既存の読み取り結果から得ることもできない。

一方で、**その HMAC は既に計算されている。** `ADP-identity-004`（`findByEmail`）は「canonical 化済み email の HMAC で bucket を決めて PK を引く」であり、bucket 選択は DO stub を得る前に必要なので、この導出は必ずトランザクションの外（`crypto.subtle` が使える場所）で先に走っている。

### Decision

**bucket 選択のために全長 HMAC を既に計算しているアダプター（Identity Directory の stub を選ぶ側）が、その同じ値を DO facade へプリミティブとして渡し、ユースケースは「HMAC + 窓」を合成するだけにする。**

- **導出鍵はその stub 選択アダプターの中にあり、ユースケースにもポートにも渡らない。** AD-19 の「ポートは導出鍵を知らない」を撤回せずに済む。
- **facade が受け取る HMAC は server-side で導出された値であって外部入力ではない**ので、`CLAUDE.md`「Input validation」の第3の検証点にはならない（**クライアントからは受け取らない**）。RPC hop が第3の検証点ではないという既存の扱いと同じ形である。
- **合成は keyed な再導出を行わない**（鍵付きの部分は HMAC 側で済んでいる）ので、`transactionSync` の中に暗号処理を持ち込まない。
- **新しいポートを1本も足さない** — Promise 例外2件も、`spec/domains/identity.md` の9ポートも、`spec/inventory/domain.md` の行数も動かない。
- **導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節**とし、他のファイルはそこを参照する。旧 `jobs.operation_key` の導出規則は参照先にしない（現行11種にこの導出形が1つも無く、失効した規則を指すことになる）。

### 検討した代替案

**`claimWindow` の引数を `windowKey` ではなく canonical（または `Email` VO）にし、導出をアダプター側へ閉じる** — `findByEmail` と同じ形になり、窓長の正本もアダプター1箇所で読める。採らなかった理由は2つあり、**2つ目が単独で決定的である。** (i) AC-39 が `claimWindow(windowKey, now): boolean` を明示的に固定しているので受け入れ基準の改定が要る。(ii) **ユースケースが `windowKey` を手に入れられなくなる** — `identity.passwordResetRequested` の `aggregateId` は `windowKey` そのもの（AD-26）なので、戻り値を `{ claimed, windowKey }` にしない限り draft を組めない。`ADP-identity-027` の明示禁止も撤回することになり、同期契約の中で HMAC を計算する制約も新たに掛かる。

**同期の導出ポートを新設する（例 `ThrottleWindowKeyDeriver.derive(canonicalEmail, now)`）** — 既存の文言を一字も変えずに済み、同期実装（純 JS の HMAC）があるので Promise 例外も2件のままにできる。採らなかった理由は、**ドメインポートが9 → 10 になり、本 Issue が最大のリスクとして挙げている「数え上げの同時修正」を1つ増やす**こと。加えて導出鍵が2箇所（stub 選択アダプターと新ポートの実装）に必要になり、**鍵の在り処が分散する。**

### Consequences

- 良い点: 追加ゼロで閉じる。AC-18（Promise 例外2件）/ AC-39（`claimWindow` の1メソッド）/ draft ファクトリの契約のどれにも触れない。
- 良い点: 「既に計算済みの値を捨てて計算し直さない」ので実装上も素直で、`transactionSync` の中に暗号処理が入らない。
- トレードオフ: **facade の引数が1つ増える。** 「facade が受け取る HMAC は server-side で導出された値であって外部入力ではない」を併記しないと、`CLAUDE.md`「Input validation」の第3の検証点に見える。**同じ1文を4ファイル + `.adr/013` へ入れる**（`spec/database/index.md` / `spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/inventory/adapter.md` / `.adr/013` の 9.）。
- トレードオフ: 導出鍵を握るのは stub 選択アダプターだけになるので、**bucket 選択を経ずに窓ストアへ到達する経路を作ると `windowKey` が導けない。** これは制約ではなく、リセット依頼が必ず bucket 選択を通ることの再確認である。

---

## AD-46: 隔離行の再駆動とリセットトークン TTL の関係は「外側の注記」として書き、配送の運用値の制約は2本のまま据え置く

### Status

Proposed（**レビュー3周目のトリアージで確定した。論点12 への決定。AD-38（`quarantined` の恒久保持）の帰結を閉じる**）

### Context

配送の運用値の制約は「2本でこれが全数」（AC-20）で、DLQ 側には `DLQ の保持期間 < リセットトークンの TTL` がある。マニュアルテストの DLQ 再駆動の手順は、この制約を根拠に「届かなければ FAIL」と断定できる。

**隔離側には対応する束縛が無い。** AD-38 が `quarantined` を恒久保持と決めたので保持期間の上限が存在せず、backoff の上限到達までの合計時間も #38 未確定である。したがって「隔離行を再駆動すれば `pending` へ戻り、次の起床で relay され、**リセットメールが届く**」は、**TTL を過ぎてから再駆動した場合に正しい実装で FAIL する**（トークン行は `sweep-reset-tokens` に消えているので送信材料 RPC は `nothing-to-send` を返す）。

### Decision

**隔離の再駆動については、TTL との関係を「外側の注記」として書き、テストの期待値を2分岐にする。配送の運用値の制約は2本のまま据え置く。**

- 注記の本文（`spec/database/index.md` の `reset_request_windows` の窓内隔離の項と、対になるマニュアルテストの手順に同じ内容で置く）: **隔離行の再駆動が有効なリンクを届けられるのはリセットトークンが TTL 内のときだけである。`quarantined` は恒久保持なので DLQ 側の `DLQ 保持期間 < トークン TTL` に相当する束縛を置けない。TTL を過ぎてからの再駆動は送信材料 RPC が `nothing-to-send` を返し、利用者側の復旧は窓が明けてからの再依頼になる。**
- **DLQ 側と隔離側の非対称は実体の非対称である。** DLQ 側が断定できるのは保持期間という上限が存在するからで、隔離側には存在しない。**非対称を消すために片方を歪めない。**
  - **訂正（レビュー4周目・B-003）: DLQ 側の制約の左辺は `Queue の最大 retry 期間 + DLQ の保持期間` である**（確定形は `Queue 最大 retry + DLQ 保持期間 < リセットトークン TTL`）。本 AD の Context と上の注記本文が持つ `DLQ 保持期間 < トークン TTL` はそれ以前の版である。**DLQ 側が断定できる理由も、隔離側との非対称も、制約が2本で全数であることも動かない** — DLQ 側の経過時間を上から押さえているのが `DLQ の保持期間`ではなく `Queue 最大 retry + DLQ 保持期間` である、というだけである。
- **窓の運用値と同じ扱いにする** — 配送の「2本で全数」は配送についての宣言であって、外側の注記まで無いという意味ではない（`.adr/013` の 6. が既にこの読み方を明示している）。

### 検討した代替案

**運用値の制約を3本目として足す（例「backoff 上限到達までの合計時間 + 再駆動の猶予 < トークン TTL」）** — テストの期待値を1分岐に保てる。採らなかった理由は、**構造的に成立しない**こと。縛る対象が**operator の反応時間**であって設定値ではないので、そもそも不等式として書けない。加えて AC-20 が「2本」を名指しで確定しており、AD-38（恒久保持）とも正面から衝突する。

**`quarantined` に保持期間を置き、隔離側にも上限を作る** — DLQ 側と同じ形の不等式が書けるようになる。採らなかった理由は、**AD-38 の決定そのものの巻き戻しになる**こと（運用者が原因を調べる前に材料が消えるほうが、上限の無い増加より高くつくと既に判断している）。

### Consequences

- 良い点: 運用値の全数宣言（2本）を開かず、AD-38 にも触れない。
- 良い点: **実際に不確定なもの（operator が何時間後に再駆動するか）を確定したことにしない。** 手順が正しい実装を FAIL させる経路が消える。
- トレードオフ: 該当手順の判定力が落ちる（どちらの分岐でも PASS になりうる）。**それでも「行が `pending` へ戻り、次の起床で relay され、送信材料 RPC が呼ばれる」ところまでは判定できる** — 落ちるのは最後の1段（メールが届くか）だけである。
- トレードオフ: 「外側の注記」という書き方の先例が1つ増える（窓の運用値に続いて2つ目）。**閉じた数え上げの脇に注記を置く形が常態化すると宣言が形骸化する**ので、置くたびに「なぜ本体の数に入らないか」を同じ文の中に書く。

---

## AD-47: 「対象と時間窓から導く形は現行の `kind` に無い」の根拠文から `send-mail` の固有名を落とし、全称命題を導出形の列挙へ弱める

### Status

Proposed（**方針照合3周目の R-002 / R-005 への決定。W-005 が置いた文面を、機械検査9 の判定条件と全数表の実測の両方に合わせて確定させる**）

### Context

W-005 は `reset_request_windows.window_key` の根拠として `jobs.operation_key` の導出規則を引かないことを決め、その理由を1文で `spec/database/index.md` の共通方針・`ADP-jobs-001`・`.adr/013` の「影響」3項・作業ログへ同時に置いた。その文は2つの問題を同時に持っていた。

1. **機械検査9 の判定条件を破る。** 判定条件は「`jobs` 節と `spec/inventory/adapter.md` に `send-mail` の文字列が無い」（plan.md 検査9 / testing.md 確認項目13）と字面で書かれているのに、理由文が `旧 send-mail` という固有名を `spec/inventory/adapter.md` と `spec/database/index.md` へ新たに持ち込んだ。検査1（`spec/database/index.md` が言及する `kind` ⊆ 全数表の `jobs.kind`）も、素朴な識別子抽出では同じ1件を差集合に拾う。
2. **前半の全称命題が正本と食い違う。** 「現行の11種はすべて定数キーか `operationId` 由来」は、自身が名指しした正本（`spec/async/index.md` 全数表の冪等性キー欄）の実測と 3/11 で合わない — `reindex` / `migrate-bulk` は対象バージョンと段、`rotate-encryption` は退役させる世代から導く。

### Decision

**固有名を落とし、全称命題を「ジョブの同一性から導く値」の列挙へ弱める。判定条件（plan.md / testing.md）には手を触れない。**

- `spec/database/index.md` の共通方針と `ADP-jobs-001` の該当文を **「現行の11種はいずれもジョブの同一性から導く値（DO ごとの定数キー・`operationId` 由来・対象バージョンや世代由来）であり、対象と時間窓から導く形は旧構成の外部送信ジョブが使っていたもので現行の `kind` には無い」** へ差し替える。
- **`.adr/` と `.thread/50/` の同趣旨の4箇所は前半だけを同じ形へ弱め、`旧 send-mail` の固有名は残す。** 検査9 / 検査1 の射程は `spec` と `CLAUDE.md` であり、`.adr/013` はそこに入らない（testing.md 確認項目13 が明示している）。射程の外まで固有名を落とすと、旧構成のどのジョブを指しているかが辿れなくなる。
- **`spec/async/index.md` の由来欄（`旧 send-mail`）には触れない。** そこは検査15（旧 `jobs.kind` 12種との突き合わせ）の判定材料である。

### 検討した代替案

**判定条件の側を言い換える（検査9 を「`send-mail` を現行の `jobs.kind` として扱う記述が0件」へ緩め、許容2件を期待結果に明記する）** — 理由文をそのまま残せる。採らなかった理由は、(i) 判定条件を「字面の0件」から「文脈の読解」へ落とすと検査が機械検査でなくなり、走らせる人ごとに合否が動くこと、(ii) 許容件数を期待結果に書く形は、以後 `send-mail` の言及が増えるたびに許容リストの同時修正義務を生むこと、(iii) 本 Round が閉じようとしている破れ（数え上げの片側だけが動く）を検査の側に作ることである。

**前半の全称命題を残したまま「ただし `reindex` / `migrate-bulk` / `rotate-encryption` は除く」と例外を添える** — 元の文面を保てる。採らなかった理由は、この文の役割が「この導出形を採る `kind` は無い」という**否定**の根拠であって、肯定側の分類を全数で言い切る必要がどこにも無いこと。例外つきの全称命題は、`kind` が増えるたびに例外リストの同時修正義務を生む。

### Consequences

- 良い点: 機械検査9 が PASS へ戻り、期待結果（`spec/async/index.md` の3件だけが残る）と実測が一致する。検査1 も素朴な識別子抽出で通る。
- 良い点: 「11種すべて」を全数表と突き合わせた読み手が 3/11 の不一致を踏まなくなる。無限定の断言を作らないという AC-36 / 検査12 の態度が、本文側にも一貫する。
- 良い点: W-005 が実際に必要とした結論（`window_key` の根拠に `jobs.operation_key` を引かない）は無傷である。前半を弱めても「対象と時間窓から導く形は現行の `kind` には無い」は真のままで、後半は逐語で残る。
- トレードオフ: `spec/` 側の2箇所だけ旧ジョブを固有名で呼べなくなり、`.adr/013` を読まないと「旧構成の外部送信ジョブ」が何かが分からない。**それでも `spec/async/index.md` の全数表の由来欄が同じファイル群の中に `旧 send-mail` を持っている**ので、辿る経路は残る。
- トレードオフ: 同じ趣旨の文が `spec/` 側と `.adr/` / `.thread/` 側で1語だけ違う形になる。差が生じる理由（検査の射程）を本 AD が持つ。

---

## AD-48: `sweep-reset-tokens` の投入時 `next_run_at` は窓の終端から導き、猶予はアダプター側の掃除条件に閉じる

### Status

Proposed（**レビュー4周目・論点13（design B-001 / impl W-008）への決定。2周目 W-020 が3箇所へ置いた逐語文を、`claimWindow` の契約から到達できる材料へ置き換える**）

### Context

2周目 W-020 の修正で「**投入時の `next_run_at` は窓行の `expires_at` から導く**」という1文が3箇所（`spec/usecases/identity.md` 手順6 / `spec/database/index.md` / `spec/async/index.md` の全数表）へ逐語で入った（`.adr/010` の「3箇所に同じ1文」規則の対象）。

ところが `enqueueJob` を呼ぶのはユースケースであり、ユースケースが窓について得られるのは `PasswordResetThrottlePort.claimWindow(windowKey, now): boolean` の戻り値だけである（AD-45 / AC-39。「メソッドは1つだけでこれが全数」「戻り値の `boolean` が唯一の分岐」と二重に締められている）。`reset_request_windows.expires_at` は **窓の終端 + 猶予**であり、**猶予の読み手はアダプター側しか宣言されていない**（`ADP-identity-027`）。2層が同じ設定値を読むと明記されているのは**窓の長さだけ**である。

したがって #51 は spec の外で (i) 猶予の定数をユースケース側にも置く、(ii) ポートの戻り値を広げる、(iii) 「`expires_at` から導く」を諦める、のどれかを選ばされる。

### Decision

**投入時刻の材料を「窓の終端（= その窓の開始 + 窓の長さ）」へ緩め、猶予はアダプター側の掃除条件にだけ効かせる。`claimWindow` の戻り値も AC-39 の「1メソッド」も動かさない。**

- 3箇所の逐語文を**全文置換**する（置換後の文は `.thread/50/review/triage-draft-004.md` の [文A]）。要旨は3点 — **窓の終端から導く / 送る側でもリセットトークンの `expires_at` を材料にしない / 猶予は投入時刻の材料にしない。**
- **`spec/domains/identity.md` の「窓の長さは2層が同じ設定値を読む」は無改訂で正しいまま残る。** 猶予を2層へ広げないので、この文の射程は動かない。
- **窓の終端に起きた掃除は窓行についてはまだ空振りしうるが、完了時の再武装が2表の索引（`prt_expires_idx` / `rrw_expires_idx`）から `min(expires_at)` を読み直して正しい時刻を張り直すので収束する**（この再武装は `spec/database/index.md` で既に確定済み）。
- **投入時刻を宛先の登録有無に依存させないことは変わらない**（依存させると AD-16 が守った「4ケースで同じ起床を張る」が割れる）。

### 検討した代替案

**猶予も「単一の設定値を2層が読む」へ格上げする（design B-001 案）** — `expires_at` をユースケース側でも組める。採らなかった理由は、**「ズレると静かに壊れる」2層共有定数を1つ新設する**こと。`spec/database/index.md` は窓の長さについてこの破れ（アダプター側が短いと有効な窓行が消される）を明示的に警戒しており、同型のリスクを猶予について作ることになる。読み手の数と同期義務も増える。

**`claimWindow` の戻り値を `{ claimed, windowExpiresAt }` へ広げる** — 材料が正確に渡る。採らなかった理由は、**AC-39 の「メソッドは1つ・`boolean` が唯一の分岐」と `DOM-identity-050` / `ADP-identity-027` の signature に正面から触れる**こと。指摘したレビュアー自身も採らないと書いている。

### Consequences

- 良い点: **AC-39 / AC-18 / 閉じた数え上げのいずれにも触れない。** 動くのは逐語文3箇所だけである。
- 良い点: 猶予の読み手が1層（窓行を書くアダプター）に閉じ、二重定義が生まれない。
- 良い点: 4ケース一様性（AC-37a / AC-38）は「窓の終端」でも同じく成立する — 材料が窓の状態だけで、登録有無を参照しないという性質が保たれる。
- トレードオフ: 掃除が猶予ぶん早く起き、窓行については空振りしうる。**空振りは1回の追加起床であり、再武装が正しい時刻を張り直すので単調に収束する。**

---

## AD-49: 送信材料 RPC の呼び出しガードは、行の `owner_token` が `NULL` の呼び出しを引数の値にかかわらず常に不一致として扱う

### Status

Proposed（**レビュー4周目・論点15（security B-001）への決定。AD-42（失敗時に `owner_token` を解放）と AD-6（ガードから `status` を外す）の交点で生まれた穴を、どちらの決定にも触れずに閉じる**）

### Context

`outbox_events.owner_token` は nullable であり、`NULL` になる状態は**正常系で頻出する2つ**である — (i) `enqueueEvent` の INSERT 直後から最初の claim まで、(ii) 上限未到達の失敗で `pending` へ戻された後から次の claim まで（**これは AD-42 の決定そのものの帰結**）。

ガードは `status` を照合しない（AD-6）ので、行が `pending` であっても条件 1.（行の存在）と 2.（`quarantined` でない）は成立する。SQL の `=` では `NULL` は不一致になるが、JS 側で `row.owner_token === callerToken` と書けば `null === null` が真になり、**「`event.id` を知る者が送信材料を引ける」が実装裁量で成立してしまう。**

同じ `spec/database/index.md` の `password_reset_tokens.change_auth_token` には「**列が `NULL` の行は照合で常に不一致とする**」という明示規則の先例がある。

### Decision

**加法的な照合規則を1つ足す。ガードの3条件も、AD-42 も AD-6 も動かさない。**

- **行の `owner_token` が `NULL` の呼び出しは、引数の値にかかわらず常に不一致として扱う**（`password_reset_tokens.change_auth_token` と同じ規則）。
- **引数側の `owner_token` も、欠落・空文字・規定長（128 bit）未満は照合の前に不一致として扱う。**
- 記述点は `spec/async/index.md`「呼び出しガード」/ `spec/database/index.md` の `outbox_events.owner_token` 列定義 / `spec/inventory/adapter.md` `ADP-mail-consumer-001` のガード3条件 / `spec/testcases/async/outboxDelivery.md`（1ケース append）である。

### 検討した代替案

**`pending` へ戻すときに `owner_token` を残す** — `NULL` の状態が減る。採らなかった理由は、**AD-42 を覆す**こと。加えて「その回に Queue へ出た対がその場で失効する」という AD-42 が明示した安全側の性質を失う。

**ガードに `status` の条件を足す** — `NULL` の行を構造的に排除できる。採らなかった理由は、**AD-6 を覆す**こと。consumer が RPC を打つのは `published` 到達後なので、正常系の配送が全滅する。

### Consequences

- 良い点: **新しい状態も新しい列も増えない。** 追加されるのは照合の前提だけである。
- 良い点: 先例（`change_auth_token`）と同じ書き方なので、読み手の学習コストが無い。
- 良い点: 失効経路（`requeue-quarantined-event` の `owner_token` 再採番、PITR 巻き戻し時の対処）の前提である「`owner_token` の秘匿」が、`owner_token` を要らなくする経路を塞ぐことで初めて成立する。
- トレードオフ: 実装が SQL の `=` に任せず明示的に書く必要がある（そのために規則として書いている）。

---

## AD-50: `windowKey` の合成に一方向性を要求せず、全長 HMAC が DO 内に残ることの射程を明示する

### Status

Proposed（**レビュー4周目・論点17（security W-002）への決定。AD-45（導出主体）にも AC-39 にも触れずに閉じる**）

### Context

`windowKey` の合成は「窓と合成して組み立てる」「keyed な再導出を行わない」までしか書かれていない（AD-45）。素直な連結だと、canonical の全長 HMAC が `reset_request_windows.window_key` と `outbox_events.aggregate_id`（AD-26）に**逐語で残る**。後者は `quarantined` 行では恒久保持である（AD-38）。

一方で、同じ Identity Directory DO には `credential_mappings.hmac`（canonical の HMAC・全長）が**登録済みクレデンシャルについて既に恒久的に在る**。ユースケースは導出鍵を持たず、`transactionSync` に暗号処理を持ち込まない規則があり、Workers の `crypto.subtle.digest` は非同期なので同期ポートとしては足せない。

### Decision

**一方向性を要求せず、性質と射程を明示して受ける。** 記述点は `spec/database/index.md`「窓キーの導出」の1箇所で、W-015（`list-quarantined-events` の応答）の修正と対で入れる。

- **合成は一方向である必要はない。** したがって `window_key` と `outbox_events.aggregate_id` は canonical の全長 HMAC を逐語で含みうる。
- 受け入れられる根拠は4つ — (i) 同じ DO の `credential_mappings.hmac` が登録済みクレデンシャルについて同じ値を既に恒久的に持っており、**DO 内部の読み手にとって新しい相関材料ではない**、(ii) 窓行は `sweep-reset-tokens` が掃除する、(iii) **DO の外へ出る経路（Queue メッセージ）には `aggregate_id` を載せない**（AD-26 で既決）、(iv) **`list-quarantined-events` も `aggregate_id` を返さない**（レビュー4周目・W-015 の修正）。
- **(iii) か (iv) のどちらかを緩めるなら、合成を一方向にする（全長 HMAC と窓を連結したうえで一方向ハッシュを1回通す）ところまで戻る** — 緩めた側では窓で切れない仮名が DO の外へ出る。この条件を同じ節に書き残す。

### 検討した代替案

**合成そのものを stub 選択アダプターへ寄せる** — 全長 HMAC と窓を連結したうえで一方向ハッシュを1回通した `windowKey` をプリミティブで facade へ渡す（アダプターは非同期なので `crypto.subtle` が使える）。導出主体の家族・導出鍵の在り処・ポート数・`aggregateId = windowKey` はいずれも動かないので **AD-45 の覆しではない。** 採らなかった理由は2つ — (i) 窓の境界がアダプター側の時計で決まり、`claimWindow(windowKey, now)` の `now` と**2つの時計**になる、(ii) 記述点が5箇所（`spec/database/index.md`「窓キーの導出」/ `spec/domains/identity.md` / `spec/usecases/identity.md` / `ADP-identity-027` / `spec/inventory/usecase.md`）に広がり、本ラウンドの収束を1つの論点のために遅らせる。

**ユースケース側で一方向ハッシュを通す** — 記述点が1箇所で済む。採らなかった理由は、`transactionSync` の中に暗号処理を持ち込まない規則と、Workers の `crypto.subtle` が非同期であることの両方に当たること。同期の導出ポートを新設する案は、閉じた数え上げ（ドメインポートの Promise 例外2件）の脇にもう1つ数え上げを増やす。

### Consequences

- 良い点: **AD-45 にも AC-39 にも触れない。** 動くのは正本の節1箇所と、W-015 の修正との対だけである。
- 良い点: 「DO の外へ出さない」という緩和の実体が (iii)(iv) の2経路に名指しで固定され、**緩めるときに戻る先が書かれている。**
- トレードオフ: **未登録アドレス**については、掃除されるまでのあいだ窓をまたいで相関できる仮名が DO 内に残る（登録済みは `credential_mappings.hmac` として元から残っている）。この残差を受けることが本 AD の実質である。
- トレードオフ: 「一方向でなくてよい」を明示するので、後任が「では外へ出してもよい」と読む導線が残る。**だから (iii)(iv) を緩めるときの戻り先を同じ文の中に書く。**

---

## AD-51: 失効宣言は項番の列挙ではなく「決定のリード文を含む本文の全数」で書く

### Status

Proposed（**レビュー5周目・B-001 への決定**）

### Context

`.adr/004` の「決定」節は**リード文（太字1文）+ 3つのバレット**で構成されている。AD-12 が置いた失効宣言は「決定の第3項」と「第2項のうち十分条件」だけを名指しし、有効側を「機構そのもの（第2項の残り）と第1項」と**閉じた形で**宣言した。**リード文はどちらにも現れない。** ところがリード文が言っているのは「Outbox / relay / consumer / DLQ を**廃止する**」であり、本 Issue が丸ごと反転させた当の命題である。

閉じた宣言の脇に名指しされない文があると、読み手は「名指しされていない = 有効」と読む。AD-12 が自ら掲げた目的（**どの ADR から読み始めても失効した決定に到達しない**）の反例が、AD-12 自身の宣言の中にあったことになる。同じ穴が `.adr/013` のステータス節（「次の2点を supersede する」）にもある。

### Decision

**失効宣言の単位を「決定の第 N 項」から「決定節の本文の全数」へ広げる。** リード文が独立した命題を持つ ADR では、リード文も失効側／有効側のどちらかに必ず現れさせる。

- `.adr/004` のステータス節の失効側に、**決定のリード文が言う「Outbox / relay / consumer / DLQ を廃止する」**を加える。失効の範囲は第3項と同じであり、機構は `.adr/013` が DO ローカル Outbox + Alarm relay + Queue consumer + DLQ として復活させた、と括弧で添える。
- `.adr/013` のステータス節を「次の**3点**を supersede する」に改め、リード文のバレットを先頭に置く。**リード文の前半（DO ローカル SQLite トランザクションと Alarm ジョブへの移行）は有効**であることを同じバレットに書く — 前半まで失効させると `.adr/002` / `.adr/004` 第1項の維持宣言と衝突する。
- `.adr/013` の**「supersede しないもの」（有効側の閉じた宣言）にもリード文の前半を明記する** — 失効側だけに足すと、有効側の閉じた列挙に現れない文が今度は前半について生まれる。
- `spec/index.md` の ADR 表の `.adr/004` 行にも同じ3点／有効側を反映する（ここだけ旧い形で残ると、索引から読み始めた人に古い射程が渡る）。
- **触るのはどの ADR でもステータス節だけである**（AC-3 / AC-32 の「過去 ADR の本文は無改変」に当たらない。`spec/index.md` は索引であって ADR 本文ではない）。

### 検討した代替案

**有効側の閉じた宣言を開く（「…は有効である」を「…などは有効である」に弱める）** — 1語で済む。採らなかった理由は、閉じた宣言そのものが本 Issue の資産だからである。開くと「どこまでが有効か」が読み手の推測に戻り、AD-12 の目的を別の形で壊す。

**`.adr/004` の決定節のリード文を書き換える** — 最も直接的だが、**過去 ADR の本文の改変**であり AC-3 に正面から当たる。ADR は決定当時の記録なので本文は動かさない。

### Consequences

- 良い点: `.adr/004` から読み始めた読み手が「Outbox の廃止は生きている」に到達する経路が閉じる。有効側の閉じた宣言も保たれる。
- 良い点: `.adr/013` の supersede 対象が 2 → 3 になり、`.adr/004` 側の失効列挙と**項目数で突き合わせられる**ようになった。
- トレードオフ: 「決定のリード文」という単位を導入したので、今後 supersede を書く人はリード文の有無を確認する手間が1つ増える。**閉じた宣言を置く ADR ではその確認が必須である**ことを、この AD が根拠として持つ。

---

## AD-52: `jobs` の収束規則 (2)(3) の `completed_at` は本 PR の射程外とし、本 PR が置いた誤った相互参照だけを訂正する

### Status

Proposed（**レビュー5周目・B-002 へのスコープ判定**）

### Context

`jobs.completed_at` の列定義は「`pending` / `running` では `NULL`」を不変条件として宣言しているのに、`done` / `poison` → `pending` の逆向き遷移を定める収束規則 (2)(3) は書く列に `completed_at` を挙げていない。復帰した行は終端時刻を保持したまま `pending` になる。再武装する5種は投入点からの再投入が唯一の再起動手段なので、規則 (3) を通る `done → pending` は平常運転で毎回起きる。

`git diff main...HEAD` で確認すると、**規則 (2) は `main` と逐語で同一**であり、**規則 (3) の差分は「残る7種 → 残る6種」と根拠の例示の差し替えだけ**で、書く列の集合には触れていない。一方、本 PR が新設した `requeue-quarantined-event` の節には「`attempt` の 0 復帰と `completed_at` の `NULL` 復帰は `jobs` の収束規則 (2) と同じ形である」という**規則 (2) が定めていないことを定めていると断言する文**が入っている。

### Decision

**穴そのものは `main` から継承した既存の問題として射程外に置き、本 PR が置いた誤った相互参照だけを訂正する。**

- `spec/database/index.md` の `requeue-quarantined-event` の節を「`attempt` の 0 復帰は収束規則 (2) と同じ形である。**`completed_at` の `NULL` 復帰のほうは `outbox_events` 側で明示的に定める規約であり、`jobs` の収束規則 (2)(3) が書く列には含まれていない**」へ直し、`jobs` 側の逆向き遷移が未定義であることを明示する。
- 穴そのものは `plan.md` の未解決事項 **P-006** として #51 へ引き継ぐ。

### 検討した代替案

**規則 (2)(3) に `completed_at = NULL` を追記して本 PR で閉じる** — 2行で済み、`outbox_events` 側との非対称も消える。採らなかった理由は、**`main` から継承した規則の本文を「Outbox 配送の設計訂正」の PR が書き換えることになり、差分の射程が受け入れ基準の外へ出る**こと。加えて (2)(3) は `.adr/010` が機構として宣言した収束規則であり、書く列を動かすと `.adr/010` の射程の再確認が要る。

### Consequences

- 良い点: 本 PR が作った破れ（誤った相互参照）と、`main` から継承した穴が**分離して記録される。** 「`outbox_events` 側だけが閉じている非対称が意図的か取り残しか」も P-006 が答える。
- トレードオフ: `jobs` 側の穴は開いたまま残る。**実害は運用診断（`jobs_completed_idx` から「いつ終端したか」を読む）の精度であり、配送にも収束規則の判定にも効かない**ので、#51 まで持ち越せる。

---

## AD-53: 呼び出しガード3条件の参照表記は正本の `1. / 2. / 3.` へ一本化する

### Status

Proposed（**レビュー5周目・W-003 への決定**）

### Context

呼び出しガードの3条件は、正本（`spec/async/index.md` / `.adr/013` / `spec/database/index.md`）では番号（`1. / 2. / 3.`）で、テストケース・台帳・`.thread/50/` ではレター（`(a) / (b) / (c)`）で参照されていた。**対応はどこにも定義されていない。** 閉じた3条件は本 PR の security の中心なので、期待値が指す条件が推測でしか解決できないと、テストの実行者が別の条件を検証しうる。

### Decision

**正本の番号表記へ一本化し、レター表記を spec と `.thread/50/` から全廃する。** 参照の形は `spec/database/index.md` に先例のある「**呼び出しガードの 3.**」に揃える。書き換えたファイルは `spec/testcases/async/outboxDelivery.md` / `spec/inventory/test.md` / `spec/inventory/adapter.md` / `.thread/50/{plan,testing,steps,adr}.md` である。**判定は件数ではなく「`ガード` の近傍に `(a)` / `(b)` / `(c)` が0件であること」で行う**（本 AD の Context にある表記の説明だけが唯一の残存であり、それが全数である）。

### 検討した代替案

**正本の3条件に `(a) (b) (c)` を併記して対応を1箇所で確定させる** — テスト側の表記を動かさずに済む。採らなかった理由は、**閉じた3条件に2つ目の名前空間を恒久的に置く**ことになり、以後どちらで書くかの判断が読み手ごとに割れること。正本は1つの表記だけを持つほうが強い。

### Consequences

- 良い点: 「呼び出しガードの 3.」という参照が spec 全体で1通りに解決する。
- トレードオフ: 条件の順序を将来入れ替えると参照が全部ずれる。**3条件は `.adr/013` と `spec/async/index.md` の両方で全数宣言されている**ので、順序を動かす変更はそもそも ADR へ戻る変更である。

---

## AD-54: 観測で判定できない実装形の要件は期待値に入れず、実装レビューの確認項目へ落とす

### Status

Proposed（**レビュー5周目・W-005 への決定。`TC-outboxDelivery-026` が先に採っている形を規則として明示する**）

### Context

`TC-outboxDelivery-006` の期待値は「`min(max(next_run_at, lease_until))` を1本の SQL として発行する実装はこのケースで落ちる」と書いていた。しかし `spec/database/index.md`「Alarm の多重化」は**両者の値が一致すること**を（leased 行では `next_run_at ≤ lease_until` が常に成り立つことから）証明として書いており、分解する理由は**コスト**であってセマンティクスではない。操作が「起床時刻を確認する」である以上、この比較で拾えるのは値であってコストではない — **正しい実装も全走査形の実装も同じ時刻を張るので、期待値として判定不能である。**

同じファイルは同種の問題を2箇所で正しく処理している（`TC-outboxDelivery-026` の「生成源の要件は実行時に検証できないので期待値に入れず、実装レビューの確認項目とする」、`TC-outboxDelivery-004` の「射程の外である」）。

### Decision

**観測で判定できない要件は期待値から外し、`TC-026` と同じ形で「実装レビューの確認項目」へ落とす。** 値として判定できる部分（4本の min と等しい時刻が張られる / 両方の実行可能集合が空のときだけ `deleteAlarm()`）は期待値に残し、**本ケースが PASS / FAIL を判定するのはこの2点だけである**と明示する。正本（`spec/database/index.md`「Alarm の多重化」）の設計要件そのものは動かさない。台帳 `spec/inventory/test.md` の要点欄にも同じ1句を足す。

### 検討した代替案

**索引の使用を測る操作へ差し替える**（`EXPLAIN QUERY PLAN` を観測する） — コストの側を直接測れる。採らなかった理由は、**テストケース定義が発行 SQL の実装形を前提にする**ことになり、`spec/testcases/` の粒度（振る舞いの契約）から外れること。`UPDATE ... LIMIT` を前提にしない規則と同じく、実装形の確認は実装レビューの側に置く。

### Consequences

- 良い点: 「正しい実装が FAIL する期待値」が消え、**テストで担保されているという誤った安心**も消える（全走査形が通ることは、この期待値では元から検出できなかった）。
- 良い点: `TC-004` / `TC-006` / `TC-026` の3ケースで「射程の外」「実装レビューへ」の扱いが揃った。
- トレードオフ: 分解形の担保が人の目に戻る。**leased 行が算入されること自体は `TC-outboxDelivery-007` が値として測る**ので、カバレッジは落ちない。

---

## AD-55: `requestPasswordReset` は窓の判定（`claimWindow`）を宛先の解決（`findByEmail`）より先に置く

### Status

Proposed（**レビュー6周目・design W-003 への決定**）

### Context

処理フローは手順2 で `CredentialMappingRepository.findByEmail` を無条件に走らせ、手順3 で `claimWindow` を呼んでいた。この順序のもとでは、列挙オラクルの残差2つのうち **(2)（`findByEmail` のヒット / ミスと、行が在るときの宛先の復号）がスロットルの外側**に置かれる — 窓が消費済みでも `findByEmail` は毎回走るので、同一アドレスに対して**回数無制限にサンプルできる**。4周目はこれを「スロットルが緩和になるのは (1) についてだけである」と正直に開示したが、**この非対称は順序の帰結であって構造の帰結ではない。**

`requestPasswordReset` は未認証で叩ける唯一のエンドポイントであり（`.adr/013`「影響」の増幅係数の項）、この設計はスロットル窓のためにテーブルを1つ新設している。スロットルが効かない残差が1つ残るのは、その代償に見合わない。

### Decision

**手順を入れ替える。`claimWindow` を新しい手順2 に、`findByEmail` を新しい手順3 に置き、`findByEmail` は `claimWindow` が `true` を返した場合にだけ走らせる。**

入れ替えが成立する根拠は、**`claimWindow` が `windowKey` しか要らず `findByEmail` の結果に依存しない**ことである（`windowKey` は stub 選択アダプター由来の全長 HMAC と窓から合成する。AD-24 / 論点11）。逆に `findByEmail` の戻り値（`credentialId` / 検証材料の有無）が要るのは、イベント行を書く側 = `claimWindow` が `true` を返した場合だけである。

**帰結として、残差 (1)(2) はどちらも窓あたり1サンプルに縛られる。** 4周目に4箇所（`spec/usecases/identity.md` / `spec/testcases/identity/requestPasswordReset.md` / `spec/inventory/test.md` / `spec/inventory/usecase.md`）へ入れた射程注記は、**「(1) だけが緩和される」から「(1)(2) とも窓あたり1サンプル」へ書き直す。** ただし**縛られるのはサンプルの回数であって差そのものではない** — 窓ごとに1回は観測でき、窓は時間とともに明けるので、時間側の等価性は引き続き主張しない。

### 検討した代替案

**順序を動かさず、「入れ替えられない理由」を1行書く** — 差分は最小。採らなかった理由は、**入れ替えられない理由が存在しない**こと。書けるのは「そうなっている」という実測の記述だけで、選択であることが読み取れない。

**`findByEmail` の側を等時化する**（`PasswordHasher.verify` と同じダミー材料）— 採れない。送らない側には `credential_id` が NOT NULL のデコイのトークン行を作れず、この非対称は `main` の spec が既に「意図的に受け入れた残余チャネル」として記録している。

### Consequences

- 良い点: スロットルが残差2つの両方に効く。**窓ストアを新設した費用に、列挙オラクルの緩和という2つ目の見返りが付く。**
- 良い点: 窓が消費済みのときは `findByEmail` にも `issue()` にも到達しないので、**その状態では4ケースが内部処理まで一致する**（測定対象4つの外側でも差が消える）。
- トレードオフ: `findByEmail` の DB 例外を測るテスト（`TC-requestPasswordReset-009`）は、窓が消費済みだと `findByEmail` が呼ばれず成立しない。**前提に「その窓での最初の依頼」を締める**（`spec/testcases/identity/requestPasswordReset.md` と `spec/inventory/test.md` の要点欄）。
- **AC-37a / AC-37b / AC-40 が指定した文は動かない** — 一様性の命題も測定対象4つも、手順の順序に依存していない。

---

## AD-56: ユースケースが運用値を読む経路は `container` であり、合成根を単一にすることで「2箇所に別々の定数を置かない」を満たす

### Status

Proposed（**レビュー6周目・design W-004 への決定**）

### Context

窓の長さは単一の運用値であり、`windowKey` の合成（ユースケース側）と窓行の `expires_at` の算出（アダプター側）の2層が同じ値を読む。`spec/database/index.md` の `reset_request_windows` の節は「2箇所に別々の定数を置かない」と要求しているが、**ユースケースがその値を受け取る経路がどこにも書かれていない。** `spec/usecases/identity.md` の共通事項は `container` を `clock` / `idGenerator` / `unitOfWorkProvider` / 各ポートと列挙しており、**ポートでも時計でも ID 生成器でもない素の運用値の置き場がそこに無い。** `claimWindow(windowKey, now)` は窓長を引数に取らないのでポート経由でも入らない。

このままだと #51 は (a) 列挙を黙って開く、(b) ユースケースに定数を置く（禁止に触れる）、(c) 合成をアダプターへ寄せる（論点11 の決定に触れる）のいずれかを根拠なしに選ぶ。

### Decision

**`container` の列挙に「ポートでも時計でも ID 生成器でもない運用値」を明示的に加え、ユースケースはそこから読む。定数を直書きしない。**

**「2箇所に別々の定数を置かない」の実体は「2層が同じ DI コンテナから同じ値を受け取る」ことである**と、ユースケース側（`spec/usecases/identity.md`）と物理側（`spec/database/index.md`）の両方に書く。窓行を書くアダプターも同じコンテナから受け取るので、合成根は1つになる。

### 検討した代替案

**窓インデックスを stub 選択アダプターから facade へ渡す**（HMAC と同じ扱いにする）— ユースケースが窓長を知らなくてよくなる。採らなかった理由は、**読み手が減らないうえに悪化する**こと — 窓行の `expires_at` を算出する DO 側のアダプターは依然として窓長を要るので、2つの読み手が request Worker と DO に分かれる。同じ運用値が Worker 境界をまたいで2箇所に置かれるほうが、同一コンテナ内の2層より drift しやすい。

**運用値を返す同期ポートを新設する** — 列挙を開かずに済む。採らなかった理由は、**閉じた数え上げ（ポート数）を1つ増やす**こと。論点11 で C 案を却下したのと同じ理由である。

### Consequences

- 良い点: 論点11（導出鍵は stub 選択アダプター、ユースケースは合成だけ）にも AC-39（`claimWindow` は1メソッド）にも AC-18（Promise 例外2件）にも触れない。
- 良い点: 実装側に先例がある（`RequestContainer` は既に `config` を持つ）ので、#51 に新しい機構を要求しない。
- トレードオフ: `container` の列挙が1項目伸びる。**この列挙は「これが全数である」と宣言されたものではない**ので、閉じた数え上げを開いたことにはならない。

---

## AD-57: claim の `SELECT` は `next_run_at` の昇順とし、そのためのソートを受け入れる

### Status

Proposed（**レビュー6周目・impl W-001 への決定**）

### Context

claim の実装形は「**実行可能集合を索引順に**上限件数だけ `SELECT` し、行ごとの CAS を1文ずつ発行する」と書かれていた。しかし実行可能集合の索引は `(status, next_run_at)` なので、**索引順は `status` 主・`next_run_at` 従**である。一方 `TC-outboxDelivery-004` の期待値は「`next_run_at` の昇順で claim される」であり、射程から外しているのは lease **未満了**で CAS に弾かれる行だけで、**lease 満了済みの行は射程の中に残る。**

具体的な破れ: 行 A（`pending`, `next_run_at = T+10`）と行 B（`publishing`, lease 満了済み, `next_run_at = T−5`）があり件数上限 1 のとき、索引順の実装は A を claim し、より早い B が残る → 期待値が FAIL する。さらに `pending` が供給され続けるかぎり B は常に索引順の後ろに並ぶので、**DO reset で生じた行が回収されずに滞留し続ける**（`*_lease_idx` は Alarm の張り直しの材料であって claim の入口ではない）。

### Decision

**物理形の文を「実行可能集合を `next_run_at` の昇順で上限件数だけ `SELECT` する」へ改め、「索引順」と書かないことを理由つきで明記する。** `status` が2値なのでこの順序は宣言済みの索引だけでは1本のシークにならず、**実行可能集合ぶんのソートが要る。そのコストを受け入れる。**

Alarm の張り直しを4本の min へ分解したのと同じ種類の判断だが、**結論は逆である** — あちらは分解でソートを避けられ、値も一致するのでコストだけの問題だった。こちらは順序が正しさ（lease 満了行の飢餓の回避）に効くので、避けられない。件数上限は取得件数にしか掛からないので、**実行可能集合が大きい DO では毎起床ソートが載る**ことを運用値の材料として #38 へ渡す。

`TC-outboxDelivery-004` の射程に「lease 満了済みの `publishing` 行は射程の中であり、索引順で読む実装は落ちる」を明記する。`jobs` 側（`jobs_runnable_idx`）も同じ形なので、`ADP-jobs-001` にもそのまま効く。

### 検討した代替案

**期待値の側を索引順へ寄せる** — spec の物理形を動かさずに済む。採らなかった理由は、**飢餓が残る**こと。「lease 満了行が回収されない」は DO reset のたびに起きる平常運転の破れであり、テストの射程を狭めて隠す対象ではない。

**claim の入口を2本（`*_runnable_idx` と `*_lease_idx`）に分けてマージする** — ソートを避けられる。採らなかった理由は、claim の実装形が2経路になり、上限件数の配分という新しい判断が増えること。**実行可能集合は `status` だけで定義するという規則**（同ファイル）とも噛み合わない。

### Consequences

- 良い点: 索引の形・物理形の文・期待値の3つが同じ順序を指す。
- トレードオフ: 毎起床のソートが載る。**上限は取得件数に掛かるのでソート対象は絞れない** — これを承知で運用値を決める。

---

## AD-58: 「投入と同じトランザクションのあとに `setAlarm` を張る」を規則として置き、テストで測る

### Status

Proposed（**レビュー6周目・impl W-002 への決定**）

### Context

`requeue-quarantined-event` の節は張り直しを正当化するときに「ユースケース側の投入点が `enqueueJob` / `enqueueEvent` と同じトランザクションのあとに起床を張るのと**同じ規約**であり、この経路だけを例外にしない」と書いていた。ところが**その「同じ規約」は `spec/` のどこにも規則として書かれていない**（`grep -rn 'setAlarm' spec` は式・再駆動・この参照の3件だけで、投入側の規約は0件）。正本らしきものは `.adr/013` の「`RelayTrigger.kick()` を復元しない理由」の中に埋まった1文だけである。

実害は再駆動について書かれている静かな停止と同型である — **終端行しか残っていない DO は定義上 `deleteAlarm()` 済み**なので、そこへ `requestPasswordReset` が来て `enqueueEvent` が `next_run_at = now` の行を1本書いても、`setAlarm` を張らない実装ではその行は次に誰かが DO を起こすまで配送されない。休眠中の Identity Directory bucket では「誰か」が来る保証が無い。テストも無い（`TC-outboxDelivery-016` は再駆動側だけを測る）。

### Decision

**規則の正本を `spec/database/index.md`「Alarm の多重化」に置く。** 内容は「行を書いた側は、そのトランザクションのあとに4本の min の合成で `setAlarm` を張り直す」で、**射程は `enqueueJob` / `enqueueEvent` を含むトランザクションと `requeue-quarantined-event` の2つ、これが全数である**（claim / 終端 / prune は `alarm()` の末尾 (4) が張るので射程外）。`deleteAlarm()` 済みの DO でも張ること、張る時刻はいま書いた行の `next_run_at` ではなく4本の min であることを併記する。`requeue-quarantined-event` の節はこの正本を参照する形へ直す。

**テストを1件 append する**（`TC-outboxDelivery-028`）。`TC-outboxDelivery-016` の裏返しであり、期待値は流用できる。**テストケース件数は 875 → 876 へ動くので、`spec/index.md` の2箇所（L15 / L27）と `spec/inventory/test.md` を同時に直す。** slug 数は 55 のまま動かない。

### 検討した代替案

**規則だけ置いてテストは足さない** — 数え上げを動かさずに済む。採らなかった理由は、**この規約の破れが「静かな停止」である**こと — 起きないものは観測されないので、テストが無いと実装レビューでしか捕まらない。同型の破れ（再駆動側）には既にテストがあり、投入側だけ無いのは非対称である。

### Consequences

- 良い点: 「規約」と参照されていたものに正本ができ、`.adr/013` の埋もれた1文に依存しなくなる。
- 良い点: `enqueueJob` 側にも同じ規則が明示的に掛かる（休眠 DO への `sweep-reset-tokens` の投入も同じ経路である）。
- トレードオフ: テストケース件数の同期先が1組動く。**動くのは `spec/index.md` の2箇所と `spec/inventory/test.md` だけである**（マニュアルテスト件数・slug 数・カテゴリ数は動かない）。

---

## AD-59: `list-quarantined-events` に件数上限を置く

### Status

Proposed（**レビュー6周目・impl W-004 への決定**）

### Context

本 PR は claim・prune・チャンク反復・bind パラメータのすべてに上限を置き、`enqueueEvent` の bind 上限まで計算している。ところが `list-quarantined-events` は返す列（6つ）だけを確定させ、**返す行数の上限もページングも定めていない。** 同時に `quarantined` を**恒久保持**とし、「隔離は Queue producer binding の障害などで**一斉に起きうる**」ことを明示的に受け入れている。一斉隔離のあとに一覧を叩くのは運用上の既定動作なので、**上限の無い一覧が唯一の無制限経路として残る。**

### Decision

**返す件数に上限を置き、順序は `completed_at`（= 隔離された時刻）の昇順として超過分の続きを引く。** この順序を選ぶのは、`outbox_completed_idx` が `(status, completed_at)` なので**宣言済みの索引で解けてソートが要らない**からである（`created_at` 順にすると索引が無く、AD-57 で受け入れたソートをもう1箇所増やすことになる）。**上限の実値と続きの引き方（カーソルかオフセットか）は #38 が定める** — 到達制御・監査ログ・運用手順と同じく maintenance 経路の実体だからである。`TC-outboxDelivery-015` の期待値に「上限件数で打ち切られ、超過分の続きが引ける」を加える（**実値は書かない** — 未確定値を期待値に入れない、という本 PR の他の運用値と同じ扱い）。

**`requeue-quarantined-event` は単体 RPC のまま据え置く。** その帰結として一斉隔離からの復旧が隔離件数ぶんの RPC になることは、一括再駆動を足すかどうかの材料として #38 へ注記で渡す。

### 検討した代替案

**上限を置かず「一覧は運用者が叩くので大量にならない」と書く** — 差分ゼロ。採らなかった理由は、**その前提を本 PR 自身が否定している**こと（一斉隔離を明示的に受け入れている）。10 GB まで育ちうる表に対する無制限の読みは、逼迫時にこそ叩かれる。

**上限の実値もここで決める** — 採らなかった理由は、他の運用値（件数上限・保持期間・窓の長さ）と扱いが割れること。実値の確定者は一貫して #38 である。

### Consequences

- 良い点: 「上限の無い経路が1つも無い」が物理形の全体で成り立つ。
- トレードオフ: operator は続きを引く操作を覚える必要がある。**一括再駆動が無いこととあわせて、一斉隔離からの復旧手順が #38 の宿題として明示的に残る。**
