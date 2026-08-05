# ADR — Issue #50: User Data DO + DO ローカル Outbox へ移行し、ドメインイベント配送を維持する

本 Issue の成果物はドキュメントのみだが、書くべきドキュメントの内容そのものが設計判断の集合である。以下はその判断の記録であり、AD-1〜AD-22 のうちプロジェクト全体に効くものが `.adr/013` へ昇格する。**設計判断の記録先は本ファイルだけである** — plan.md / steps.md は結論を参照するだけで、判断の根拠を重複させない。

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

- **揃える列**（`jobs` と同名・同意味にして、ランナーの実装を共有できるようにする）: `attempt` / `next_run_at` / `status` / `lease_until` / `owner_token` / `terminal_reason` / `completed_at`。
- **`outbox_events` 固有の列**: `id`（`EventId`。`IdGenerator` が採番する不変の主キー）/ `type` / `payload` / `aggregate_id` / `occurred_at` / `created_at`。**`created_at` は行が Outbox に載った時刻であり、`occurred_at`（ドメインが決めた発生時刻）とは別物である** — backlog の滞留時間を読む起点は前者であり、後者はドメインが過去の時刻を入れうるので滞留の観測に使えない。`dedupe_key` は置かない（AD-7）。`provider_idempotency_key` も置かない（AD-8）。
- **`jobs` 固有の列**: `operation_key`（同一性）/ `kind` / `payload_digest`。**この3つが「収束する表」と「収束しない表」を分けている実体である。**
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
- **lease 中の行（`running` / `publishing`）は `max(next_run_at, lease_until)` で算入する。** claim の CAS は第2選言で `lease_until` 満了を要求する（`spec/database/index.md` L459）ので、過去の `next_run_at` を持つ leased 行だけが残った状態で `next_run_at` をそのまま採ると、「起床 → 1行も claim できない → 同じ過去時刻へ張り直す」の空転になる。**これは `jobs` 側に既に存在する曖昧さであり、本 Issue が作ったものではない** — Alarm 多重化の規則を書き下ろすこの機会に両表へ同じ形で確定させ、#51 が実装時に自前で決めずに済むようにする。
- **`alarm()` の中の順序**: (1) 再武装 + 永続化確認 → (2) migration ゲート → (3-a) **outbox relay パス** → (3-b) **jobs パス** → (4) 両表から再計算して張り直す。
- **公平性は「毎回の起床で両方のパスを必ず1回通す」で担保し、上限は各パスが独立に持つ。** 片方が上限を使い切っても他方は必ず走る。上限を共有すると、片方の滞留がもう片方を飢えさせる。
- **relay は `queue.send()` を await するのでゲートの中には置けない**（ゲートは同期関数）。したがって relay は必ず (3-a) に来る。
- **fail-closed で止まっている DO は relay もしない。** ゲートで戻るので (3-a) に到達せず、outbox 行は滞留する。**滞留は失われた配送ではない**（行は残り、コード更新後の起床で流れる）ことを明記する。
- relay の1回のパスは3相で、**Queue への送信だけがトランザクションの外**にある。
  1. `transactionSync`: 実行可能な行を件数上限まで claim（`status='publishing'`、`lease_until` / `owner_token` を CAS で書く）
  2. トランザクション外: Queue へ publish
  3. `transactionSync`: `published` へ落とす／失敗なら `attempt` を進め backoff で `next_run_at` を先送り／上限超過は `quarantined`

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

- payload に載せるもの: `tokenId`（識別子）/ メール種別 / **発行元 Identity Directory bucket の routing key**（`.adr/002` により既に鍵付きハッシュ済みの内部キーであり、生のメールアドレスでも SSO subject でもない）。
- payload に載せないもの: メールアドレス、生トークン、`userId`、その他の PII。
- consumer が呼ぶ RPC は「送信材料の取得」であって「送信」ではない。**復号と HMAC 導出は DO の中に閉じたまま**で、consumer が受け取るのは送信直前の完成品である。
- **RPC の応答は2分岐のタグ付きユニオンであり、これが全数である。**
  - `send` — 宛先・レンダリング済み本文・`providerIdempotencyKey` を持つ。consumer はこれを provider へ渡す。
  - `nothing-to-send` — **理由を1つも載せない空の分岐である。** 未登録 / SSO 専用 / 消費済み / 期限切れ / より新しい発行に置き換えられた、のいずれであっても同じこの1値が返る。consumer は no-op して ack する。**失敗ではない。**
- **`superseded` と `no-recipient` を分けた旧案は撤回する。** 理由は2つあり、どちらも単独で決定的である。(i) **DO 側の状態から区別できない** — `spec/usecases/identity.md:205` と `ADP-identity-014` により、発行はそのクレデンシャル宛の未使用トークン行を同じトランザクションで**全削除**する。したがって supersede された `tokenId` の行は痕跡なく消え、payload が持つのは `tokenId` だけなので、行が無いときに DO は `credential_id` へ辿ることすらできない。**AD-7 が「発行が起きるのは窓の最初の依頼のときだけ」へ改めた後もこの論拠は変わらない** — 同一窓では発行そのものが1回しか起きないので supersede は生じず、supersede が生じるのは窓をまたいだときだけで、そのときは新しい窓の最初の依頼が全削除を実行するからである。(ii) **区別できること自体が列挙オラクルになる** — consumer は DO の外にあり、応答は consumer のログにも DLQ にも落ちうる。`no-recipient` が観測できれば「そのアドレスは未登録 / SSO 専用である」が DO の外へ漏れる。**分岐を1つに畳むのは実装上の妥協ではなく、決定2（PII と秘密を DO の外へ出さない範囲）の延長である。**
- **「なぜ送らなかったか」を consumer 側に残さない。** 運用の追跡が要るなら DO 側の観測（メトリクス）に閉じる。依頼者への応答にも一切現れない（列挙オラクル対策は DO の transaction 内で完結している。AD-7）。
- **`providerIdempotencyKey` は DO が導出してこの応答に載せる。** 導出鍵は DO 側にあり consumer 側では導けないので、`outbox_events` の列にもせず（AD-8）、consumer にも鍵を配らない。応答に載せることで、`event.id` から決まる値が「秘密を持たない側」へ渡る唯一の経路になる。
- **呼び出しガードを置く。** 生トークンは `HMAC(IDENTITY_RESET_TOKEN_KEY[generation], tokenId)` で導かれ、`tokenId` は Queue メッセージと DLQ を通って DO の外に出る。**この RPC が無条件だと「`tokenId` を知る者 = リセットリンクを引ける者」になる**ので、次のガードを掛ける。
  1. **応答が `send` になるのは、次の3条件がすべて成り立つときだけである。** (a) その `event.id` の行が `outbox_events` に**存在する**、(b) 行が `quarantined` **でない**、(c) 呼び出しが持つ**不透明な `owner_token` が行の値と一致する**。1つでも満たさない呼び出しは `nothing-to-send` を返す（**理由は返さない** — ここでも分岐を増やさない）。`event.id` と `owner_token` の対は Queue メッセージが運ぶ。
     - **`status` は照合条件に入れない。** 配送は at-least-once であり、consumer が Queue からメッセージを受け取って RPC を打つのは relay の相 3（`published` への落とし込み）の**後**である。`status = 'publishing'` を条件にすると**正常系の配送が全滅する**（AD-10 が `published` を「Queue へ渡した。処理されたとは言っていない」と定義していることとも整合しない）。**二重送信の抑止は `status` ではなく `providerIdempotencyKey` が担う。役割を混ぜない。**
     - **同一性の判定は `owner_token` が単独で負う。** 再 claim が起きれば `owner_token` は書き換わるので、古い Queue メッセージを持った consumer の呼び出しは (c) で弾かれて `nothing-to-send` に落ちる。lease と CAS の意味論をそのまま外側の照合に流用する形であり、新しい状態を1つも足さない。
  2. **`outbox_events` は終端時に `owner_token` を `NULL` にしない。** `jobs` は `done` / `poison` へ落とすときに `lease_until` / `owner_token` / `next_run_at` を `NULL` にする（`spec/database/index.md` L460 付近）が、`outbox_events` の `owner_token` は**終端後も照合材料として残す**。`lease_until` / `next_run_at` は `jobs` と同じく `NULL` にする。**これは AD-2 が言う「分離する規約」の1つであり、書き落とすとガード (c) が `published` の行に対して必ず失敗し、1. の訂正がそのまま無効になる。**
  3. **DLQ の保持期間 < リセットトークンの TTL を運用値の制約として書く**（値の確定は #38）。満たしていれば DLQ からの再駆動が成功しても、トークンは既に失効している。満たせない場合は 1. のガードだけが有効な防壁になるので、**択一ではなく両方置く。**
  4. **`published` 行の保持期間 ≥ Queue の最大 retry 期間 + DLQ の保持期間**（値の確定は #38）。ガードが行の存在（(a)）を要求する以上、prune が行を消した後の DLQ 再駆動は必ず `nothing-to-send` になる。**上側（3.）だけを書くと、値の決定者が両立しない2値を選べてしまい、再駆動が恒久的に空振りする** — その形は運用上ほとんど検出できない。3. と合わせて `Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間` かつ `DLQ 保持期間 < トークン TTL` が制約の全数である。

### 検討した代替案

**relay が publish 直前に生トークンを導出して payload に載せる** — consumer が1回で完結する。採らなかった理由は、**Queue のメッセージと DLQ に再利用可能な秘密が載る**こと。DLQ の行は運用者が読む場所でもある。受け入れ条件と正面から衝突する。

**consumer Worker に `IDENTITY_RESET_TOKEN_KEY` とメール暗号鍵を配る** — RPC 1往復が消える。採らなかった理由は、**復号鍵と HMAC 鍵を持つ Worker が増える**こと。`apps/web/.dev.vars.example` は「どの秘密がどの Worker に属するか」を宣言する設計になっており（現に `SESSION_SECRET` に `Only the request-path Worker needs it.` と書いている）、鍵の帰属を増やすのはその宣言を弱める。**本案でも consumer はメール provider の API キーを持つことになるので、「秘密を1つも持たない」は最初から成立しない** — 却下の実質は「持つ秘密を provider の API キー1本に留める」である。

**呼び出しガードに `status = 'publishing'` を含める（撤回した旧案）** — 「送信材料を引けるのは relay が lease を握っている最中だけ」という素直な読みで、lease の意味論とも揃って見える。採らなかった理由は、**その窓が consumer には決して見えない**こと。relay の相 2（publish）と相 3（`published` への落とし込み）のあいだに consumer が動く保証は無く、実際には Queue の配送遅延のぶんだけ必ず後になる。したがって条件を課すと**すべての依頼が `nothing-to-send` に落ちてリセットメールが1通も送られない**。同一性の判定は `owner_token` が単独で担えるので、`status` を足す利得も無い。**この案は2周目の反映で spec 側の文言まで落ちていたので、撤回であることを明示して残す。**

**`send-mail` を local job のまま残す** — 上記の問題がすべて消える。**採らないのは Issue #50 が `send-mail` を Outbox の初期値として決めているからであり、設計上の優劣で決めたのではない。** AD-1 の3規則に照らすと「メール送信の実行責任を独立 consumer へ委譲する」は規則2に当たり、Outbox が正しい。ただし本案が RPC 1往復を足していることは、この分類のコストとして記録しておく（差し戻し条件は全数表の `send-mail` 行に残す）。

### Consequences

- **保証範囲は「載らない」であって「越えない」ではない。** 保証するのは次の3つだけである。
  1. `outbox_events.payload` / Queue のメッセージ / DLQ のメッセージ / ログ / `terminal_reason` のいずれにも、PII と再利用可能な秘密を**載せない**。
  2. 宛先メールアドレスと生トークンは、**送信材料 RPC の応答と provider へのリクエストにのみ存在し、どこにも永続化されない**。
  3. 復号鍵と HMAC 導出鍵は DO の中から出ない。
- **「PII と秘密が DO の境界を出ない」は撤回する。** `MailSender.sendPasswordResetMail(to, resetToken)` を呼ぶ以上、宛先と生トークンは RPC 応答として確実に境界を越え、**配送の瞬間だけ consumer のメモリに載る**。撤回しないと、後任が「consumer には秘密が渡らない」を前提に consumer 側のログ方針や秘密管理を緩める導線になる。
- **consumer は秘密を扱う実行主体である。** メール provider の API キーが帰属し、宛先と生トークンを一時的に保持する。`CLAUDE.md` の「Each Worker has its own, non-overlapping set of secrets」の対象が1件増える（帰属先は AD-13。`.dev.vars.example` の実際の追記は #51）。
- 良い点: 送信直前に権威（`credential_mappings` の `passwordVerifier` の有無、トークンの生存と supersede）を読み直すので、**イベント発行後にトークンが消費・失効・置換された場合に古い材料で送らない。** 素朴な payload 方式ではこれが守れない。
- トレードオフ: consumer → state Worker の service binding が要る（実装は #51）。配送1件あたり RPC が1往復増える。
- トレードオフ: **`status` を照合しないことで、`(event.id, owner_token)` の対が「送信材料を引ける持参人証」になる露出窓が、lease の長さから `published` 行の保持期間へ広がる。** 対は Queue メッセージと DLQ を通るので、DLQ を読める運用者はその期間だけリセットリンクを引ける。**これは `status` 照合では防げなかった** — 照合を残すと正常系が成立しないので、実際には守れていない防壁だった。実効的な防壁は運用値の制約 3.（`DLQ 保持期間 < トークン TTL`）であり、**上限を短く保つことが唯一の手段である**ことを #38 への引き継ぎに書く。`owner_token` を再 claim ごとに更新する規則（AD-4）が、古い対を無効化する二次的な絞りとして効く。
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
- スロットルの窓のキーは `jobs.operation_key` と同じ導出（対象の全長 HMAC + 依頼の窓）を使う。**クライアントから受け取らない**（`CLAUDE.md`「Cross-request idempotency keys never come from the client」）。**窓の状態の物理的な置き場は Identity Directory DO の専用ストアであり、`credential_mappings` に相乗りさせない**（AD-16 が決めた。`credential_mappings` は未登録 canonical に行を持たないので、そこへ載せると 1. の一様性が構造的に成立しない）。

### 検討した代替案

**`outbox_events` に `dedupe_key` 列と部分 UNIQUE 索引を置き、同キーの終端していない行があれば2行目を作らない（旧 AD-7）** — 現行の収束の形をそのまま移せる。採らなかった理由は2つ。(i) 上の Context のとおり **AD-6 と合成すると「2回依頼して0通」の経路が生まれる**。行は不変なので payload は古い `tokenId` を指し続け、送信時の再読はそれを `superseded` に落とす。(ii) Outbox の契約そのものと両立しない — AD-2 が表を分けた理由は「イベントは起きた事実なので収束してはならない」であり、`dedupe_key` は同じ表にその例外を持ち込む。**収束をやめても濫用耐性は失われない** — 抑止の実体はもともと「窓ごとに1回だけ」であり、それは行の一意制約ではなくスロットル判定が担える。

**payload の識別子を `tokenId` からクレデンシャル識別子へ変え、送信材料 RPC が「現在有効な未使用トークン」を解決する** — `dedupe_key` を残したまま「2回依頼して0通」を消せる。採らなかった理由は、**supersede の意味論が失われる**こと。どの行も常に「今有効なトークン」を送るので、窓をまたいで積まれた古い行が全部送信され、収束の意味論が「最後の1通」ではなく「行数ぶん」に戻る。順序逆転時の期待値（新しいほうだけが届く）も決められなくなる。**なお `superseded` を応答の分岐として表に出さない**ことは AD-6 が別途決めており（DO 側で区別できず、区別できること自体が列挙オラクルになる）、本案の却下理由はそれとは独立である。

**収束を諦め、`providerIdempotencyKey` を (canonical, 窓) から導いて provider 側に吸わせる** — schema が素朴なままで済み、`.thread/34/design.md` 第7.6節が既に「provider が冪等キーを解釈すれば抑止され、しなくても2通届くで済む」と受容している。採らなかった理由は、**行数・Queue メッセージ数・consumer 実行回数が依頼回数に比例したままになる**こと。第7.6節が受容したのは「二重送信」であって「攻撃者が依頼回数を増やせば資源消費が線形に増える」ではない。本決定はこの問題を、行の一意制約ではなく発行判断で解いている。

**スロットル中は「送らない側」の行を積む（現行 `jobs` 版の形をそのまま移す）** — 4ケースが常に1行書くので経路一致が自明になる。採らなかった理由は、**Outbox では「送らない側の行」が Queue メッセージ1件と consumer 実行1回を必ず生む**こと（`jobs` 版では起床1回で済んでいた）。一様に書かないほうが、経路一致を保ったまま資源消費を窓の数に比例させられる。

### Consequences

- 良い点: **`outbox_events` が例外なく「1イベント1行・不変」になる。** AD-2 の「イベントは収束しない」が表の形に一切の穴を持たない。部分 UNIQUE 索引が1本減る。
- 良い点: 現行の濫用耐性（書き込みと起床が窓の数に比例する）がそのまま移る。
- 良い点: 「2回依頼して0通」の経路が消え、**同一窓への連打に対して「有効なリンクを含むメールが1通届く（0通でも2通でもない）」**が期待値として書き下ろせる。
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

### Consequences

- 良い点: どの ADR から読み始めても失効した決定に到達しない。
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
- **`windowKey` は呼び出し側が導出して渡す**（対象 canonical の全長 HMAC + 依頼の窓。クライアントからは受け取らない）。ポートは導出鍵を知らない。
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

- **同一視できる根拠は AD-16 が既に持っている** — 「キーは `jobs.operation_key` と同じ導出を使う」と決めている。導出の入力も規則も同じで、違うのは書き込み先の表だけである。
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
- **鍵付きハッシュ済みなので原本を含まない。** `reset_request_windows.window_key` と同じ値であり、`spec/database/index.md` が「この表を新設しても PII は増えない」と言っているのと同じ根拠が効く。
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
