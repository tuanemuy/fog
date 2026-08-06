# 013. DO ローカル Outbox と Alarm relay へ移行し、ドメインイベント配送を維持する

**本 ADR は例外的に長い。数と値域の正本は `spec/async/index.md` / `spec/database/index.md` であり、本文の数値は決定当時の記録である。**

## ステータス

承認済み

`.adr/004-do-local-commit-and-alarm-jobs.md` の次の3点を supersede する。

- **決定のリード文**（「Durable Object のローカル SQLite トランザクションと、オブジェクトごとの Alarm ジョブへ全面的に移行し、**Outbox / relay / consumer / DLQ を廃止する**」）のうち、廃止を言う後半。**失効の範囲は下の第3項と同じである** — 本 ADR は Outbox / relay / consumer / DLQ を DO ローカル Outbox + Alarm relay + Queue consumer + DLQ として復活させる。前半（DO ローカル SQLite トランザクションと Alarm ジョブへの移行）は有効である。
- **決定の第3項**（ドメインイベントを配送の transport として扱うのをやめ、業務・監査の表現としても残さず、Unit of Work からのイベント収集そのものを廃止する）と、影響の対応する項（「ドメインイベントの機構そのものが無くなる」）。
- **決定の第2項のうち「外部 I/O を伴う処理は必ずこちらに載る」という十分条件**。外部 I/O は「同期トランザクションの中では実行できない」ことしか含意せず、**実行責任がどこにあるかを何も言わない**。第2項が名指しする `.thread/34/design.md` 第7.4節（載る処理の全数）も失効し、全数は `spec/async/index.md` が持つ。

**supersede しないもの**: 決定のリード文の**前半**（DO ローカル SQLite トランザクションと、オブジェクトごとの Alarm ジョブへの全面移行）、永続ジョブと Alarm という機構そのもの（第2項の残り）、第1項（本体データと検索索引を DO ローカルの同一トランザクションで同期的に確定させる）。`.adr/002-cloudflare-workers-and-user-data-durable-objects.md` の User Data DO / Identity Directory DO への集約、`.adr/003-sqlite-fts5-only-search.md` の FTS5 単独検索、`.adr/005-search-projection-inside-write-transaction.md` の「検索インデックスの更新は本体を書くトランザクションの中の projection である」は**すべて維持する**。本 ADR は検索インデックスの更新方式に一切触れない。

`.adr/010-job-enqueue-points-and-reenqueue-rules.md` については、機構（投入点の全数宣言・収束規則3つ）を維持したうえで、**2項の帰属を移し、1項の射程を広げる（計3項。全数は下の「影響」）**。

## コンテキスト

`.adr/004` は非同期処理を「要求処理と同じトランザクションで完結するか否か」で2分し、完結しないものをすべて `jobs` + Alarm に載せた。前提は「配送機構が必要だったのは検索インデックスの非同期更新だけであり、その理由は `.adr/003` で消えた」という読みである。

その読みは検索については正しいが、**分類の軸としては「どこで実行するか」を問うており、「誰が完了責任を持つか」を問うていない。** 帰結として、外部 I/O（メール送信）とローカルの期限処理が同じ `jobs` 表に並び、独立した consumer へ実行責任を委譲したい処理と、その DO 自身が必ず自分で完走させなければならない処理が区別できない。`CLAUDE.md` の非同期実行契約も「外部 I/O を伴う処理は必ず永続ジョブに載る」を軸に書かれ、`jobs.kind` 12種のうち `send-mail` だけが外部 I/O、という構造になっていた。

一方で、`.adr/002` が採った物理構成は次の制約を課している。

- 1つの Durable Object が持てる Alarm は1本だけである。
- `transactionSync` のコールバックは同期であり、`fetch` を呼べない。したがって Queue への publish はトランザクションの外にしか置けない。
- 共有の関係データベースが無いので、配送状態を集める中央のストアも、処理済みイベント ID の共有ストアも存在しない。

Issue #50 が要求するのは、判定軸を実行責任の所有者へ移し、**ドメインイベント配送を「専用の Outbox DO」ではなく「発行元 DO のローカル表」として復活させる**ことである。

## 決定

### 1. 非同期処理を「実行責任の所有者」で3類型へ分類する

**判定は3段の順序つき規則であり、上から順に評価して最初に当たった類型にちょうど1回割り当てる。**

1. **業務状態と同じトランザクションで完了しなければならないなら同期実行。** FTS5 projection、retention のハードデリート、saga の phase 前進、`purge_after` の一括再計算がこれに当たる。
2. **実行責任を独立した consumer へ委譲する／複数 consumer へ fan-out する／他システムへ配送の事実を残す必要があるなら Outbox event。**
3. **それ以外で、特定の DO または saga コーディネーターが完了責任を持って後から再開するなら local job（`jobs` + Alarm）。**

- **規則2の「独立」は実行責任の独立である** — Queue の retry と DLQ が完了を管理し、発行元 DO は publish 以降を知らない。**Worker が物理的に分かれていることではない**（下の 13.）。物理的な分離は運用判断であり、分類を動かさない。
- **外部 I/O であることも、cross-DO RPC であることも、単独では Outbox の条件にしない。** cross-DO RPC は `resume-link` / `resume-signup` / `resume-credential-change` / `finalize-withdrawal` / `sweep-orphan-mapping` が示すとおり、コーディネーター DO が状態機械の完了責任を持つので local job である。
- 初期値は旧 `send-mail` が Outbox event、残る11種が local job。**分類の変更には「実行責任の所有者が誰か」に基づく理由が要る。**
- 帰結として「**local job はすべて DO ローカルで完結する**」が新しい不変条件になる。`jobs` を読む側は「この表の行はネットワークに出ない」と仮定してよい。

### 2. `outbox_events` を `jobs` とは別のテーブルにする

共通化するのは **Alarm scheduler・backoff・lease・prune の規約**の**4つ**であり、分離するのは**同一性と収束の有無・配送状態の値域・終端時に `NULL` にする列**の**3つで、これが全数である**。**列名と状態遷移そのものは共通化する規約の項目として数えない** — 同名・同意味であることは下の「揃える列（8つ）」が、値域の差は分離する側の「配送状態の値域」が持つ。`spec/database/index.md` の「共通化する規約」も同じ4項であり、差は「どこに書いてあるか」だけである（両方の全数の正本は同ファイル）。

**prune は共通化する側に置く。** ランナーの実装は2表で共有し、**削除の対象集合が違うことは分離する規約の4つ目ではなく、値域の分離の帰結として畳む** — `jobs` は終端2値（`done` / `poison`）の両方を消すが、`outbox_events` が消すのは `published` だけで `quarantined` は恒久保持する（下の 12.）。対象集合を4つ目として数えると「3つで全数」が壊れる（分離の全数の正本は `spec/database/index.md`）。

- 揃える列（8つ）: `payload` / `attempt` / `next_run_at` / `status` / `lease_until` / `owner_token` / `terminal_reason` / `completed_at`。
- `outbox_events` 固有の列（5つ）: `id`（`EventId`。`IdGenerator` が採番する不変の主キー）/ `type` / `aggregate_id` / `occurred_at` / `created_at`。**`created_at` は行が Outbox に載った時刻**であり、`occurred_at`（ドメインが決めた発生時刻）では代用できない — backlog の滞留時間を読む起点は前者で、後者はドメインが過去の時刻を入れうる。
- `jobs` 固有の列（3つ）: `operation_key`（同一性）/ `kind` / `payload_digest`。**この3つが「収束する表」と「収束しない表」を分けている実体である。**
- したがって `jobs` は 8 + 3 = **11列**、`outbox_events` は 8 + 5 = **13列**である（列の正本は `spec/database/index.md`）。
- `status` の値域は `pending` / `publishing` / `published` / `quarantined`。`jobs` の `pending` / `running` / `done` / `poison` と形は同じで名前が違う。`done`（仕事が終わった）と `published`（Queue へ渡した。処理されたとは言っていない）は意味として別物である。

相乗りさせない理由は、`jobs` の同一性規約が「同じ `operation_key` の再投入は既存行へ収束する」であることにある。**イベントは起きた事実なので収束してはならない** — 2回起きた事実を1行に畳むと、片方が配送されない。

### 3. `outbox_events` を両 DO クラスに置く

置くのは**表と機構**であって**イベント型ではない。** User Data DO のイベント型は初期0件であり、全数表にその旨を明示的な行として書く。

理由は3つ。(i) `jobs` が「同じ形の表を両クラスに持ち、違うのは値域だけ」という前例を作っている。(ii) 「DO ローカル Outbox」という契約が DO クラスによって「ある / ない」に割れると、`spec/` も `CLAUDE.md` も限定句を全箇所に付けて回ることになる。(iii) Alarm の多重化が両クラスで同一実装になる。片方に表が無いと多重化のコードが DO クラスで分岐する。

**片方に後から足すコストは理由にしない** — `outbox_events` は新設・空テーブルなので、追加は `CREATE TABLE` と空テーブルへの索引の**単発適用**で足りる。

### 4. 1本の Alarm で Outbox relay と local jobs を多重化する

**relay を `jobs.kind` の1種別にはしない。**

- 起床時刻は `setAlarm(min(J, O))`。`J = min(jobs.next_run_at) WHERE status = 'pending'`、`O = min(outbox_events.next_run_at) WHERE status = 'pending'`。**lease 中の行はこの2本に入れない**（次のバレットが別に算入する）。**両表の実行可能集合（`jobs` の `pending` / `running` と `outbox_events` の `pending` / `publishing`）が両方とも空のときだけ `deleteAlarm()` する。**
- **lease 中の行（`running` / `publishing`）は `max(next_run_at, lease_until)` で算入する。** claim の CAS が `lease_until` の満了を要求するので、過去の `next_run_at` を持つ leased 行だけが残った状態で `next_run_at` をそのまま採ると「起床 → 1行も claim できない → 同じ過去時刻へ張り直す」の空転になる。**これは `jobs` 側に既にあった曖昧さであり、両表へ同じ形で確定させる。**
  - **実装形は4本の min の合成である**（各表の `next_run_at WHERE pending` と `lease_until WHERE running` / `publishing`）。**正本は `spec/database/index.md`「Alarm の多重化」であり、上の2本と本項はその分解前の意味を述べている。** 4本へ分けてよい根拠は、leased 行では `next_run_at ≤ lease_until` が常に成り立つので `max` が必ず `lease_until` を採ることにある。分けるのは索引で解ける形にするためで、**`min(max(next_run_at, lease_until))` を1本の SQL として発行すると式を key にした索引が無く、実行可能集合の全走査が毎起床かかる。**
- `alarm()` の中の順序は **(1) 再武装 + 永続化の確認 → (2) migration ゲート → (3-a) outbox relay パス → (3-b) jobs パス → (4) 両表から再計算して張り直す**。
- **公平性は「毎回の起床で両方のパスを必ず1回通す」で担保し、件数上限は各パスが独立に持つ。** 上限を共有すると片方の滞留がもう片方を飢えさせる。
- relay は `queue.send()` を await するので、**同期関数である migration ゲートの中には置けない。** したがって必ず (3-a) に来る。
- relay の1パスは3相で、**Queue への送信だけがトランザクションの外にある。** (1) `transactionSync` で実行可能な行を上限件数まで claim（`publishing` + `lease_until` + `owner_token` を CAS）、(2) トランザクション外で Queue へ publish、(3) `transactionSync` で `published` へ落とす／失敗なら `pending` へ戻す（下のバレット）／上限超過は `quarantined` + `terminal_reason`。
- **上限に達していない失敗は、同じトランザクションで `status='pending'` へ戻し、`lease_until` / `owner_token` を解放したうえで `attempt` と `next_run_at` を書く。** `publishing` のまま `next_run_at` だけを先送りすると、**leased 行では `next_run_at ≤ lease_until` が常に成り立つ**という不変条件が破れ、上の4本の min へ分解してよい根拠がそのまま崩れる。`publishing` を保ったまま `next_run_at` を `lease_until` の内側へ丸める案は不変条件こそ守るが、**backoff の効き幅が lease の長さに縛られる**（lease より長い backoff が書けず、上限回数まで持たせるには lease を延ばすしかなくなって DO reset からの回収も遅くなる）。**`owner_token` の解放は、その回に Queue へ出たかもしれないメッセージの持参人証を即座に失効させるので、at-least-once の観点でも安全側である。** チャンク上限に達した local job を `pending` へ戻して lease を解放する既存の形と同じであり、新しい概念を持ち込まない。**`jobs` と `outbox_events` の両方へ同じ形で掛かる**（共通化する規約の側。列と実行可能集合の述語の正本は `spec/database/index.md`）。**終端行で `owner_token` を残す規則（下の 6.）とは別の分岐である** — 残すのは `published` / `quarantined` だけで、`pending` へ戻った行は次の claim で新しい値を得る。
- **at-least-once の根拠は相 2 と 3 のあいだにある。** そこで DO がリセットすると、lease 満了後に同じ行が再 claim され再 publish される。
- **fail-closed で止まっている DO は relay もしない**（ゲートで戻るので (3-a) に到達しない）。outbox 行は滞留するが、**失われた配送ではない** — 行は残り、コードが揃った次の起床で流れる。
- **実行可能な行を増やした主体は、例外なく、その書き込みのあとに4本の min の合成で `setAlarm` を張り直す。`deleteAlarm()` 済みの DO でも張る。** **射程を経路の閉じた列挙では宣言しない** — 列挙で宣言すると列挙に載らない投入経路が静かに落ちる。`enqueueJob` / `enqueueEvent` を含むトランザクションと `requeue-quarantined-event` に加えて、**migration ゲートによる `reindex` / `migrate-bulk` の投入**（ユースケースの `enqueueJob` を通らない）や operator 経路による `rotate-encryption` の起動も同じ規約の下にあり、これらは例示であって全数ではない。**`setAlarm()` は非同期なので `transactionSync` の中でも `await` を1つも挟まない migration ゲートの中でも呼べず、張る位置は「その書き込みが確定したあと最初に来る非同期の文脈」である** — ユースケース / operator RPC は `UnitOfWorkProvider.run` が戻ったあと応答を返す前、**migration ゲートはゲートが戻った直後・RPC 本体に入る前**（本体が throw してもゲートの行は確定済みなので本体の成否に依存させない。射程は実際に投入した起動だけ）、**`alarm()` の中でゲートが投入した場合は末尾 (4) が兼ねる**。正本は `spec/database/index.md`「Alarm の多重化」の張り直しの項である。

### 5. イベント登録口は UoW コンテキストの `enqueueEvent` に固定し、relay をポートにしない

- **登録口は `UnitOfWorkContext.enqueueEvent(drafts: readonly EventDraft[]): void` ただ1つである。** `enqueueJob` と同じ形（同期・戻り値なし・同じ `transactionSync` の中で行を書く）に揃える。`collectEvents` という旧名は復元しない — `collect` はバッファリングを含意し、同期 INSERT の実体と食い違う。
- **`EventId` の採番は UoW 実装が `IdGenerator` に対して行い、ドメインは identity-less な `EventDraft` を返す。** ドメインが id 生成に触らないための分離であり、同期 UoW でも保つ。
- **relay の `queue.send()` はドメインポートにしない。** Queue producer binding はアダプター（DO クラス）の内部実装であり、ドメインもユースケースも触らない。したがって**ドメインポートの同期契約の例外は `PasswordHasher` / `MailSender` の2つのまま動かない。**
- **別 Worker への即時キック（`RelayTrigger.kick()`）は復元しない。** DO ローカルでは登録と同じトランザクションのあとに `setAlarm` を張るだけで足りる。

イベント登録をドメインポートにしないのは、`.adr/005` が `SearchIndexPort` の書き込み側をポートにしなかったのとまったく同じ理由による — ポートは DI で単独注入でき、**トランザクションの外からイベントだけを書く経路が構造的に残る。**

### 6. consumer は event payload から送信内容を組み立てず、発行元 DO へ RPC で取りに行く

- payload に載せるのは `tokenId` / メール種別の**2つだけ**である。**発行元 bucket の routing key は payload に入れない** — routing key は relay が publish 時に Queue メッセージへ押す項目であって、ドメインの payload ではない（`EventId` と同じ扱い。上の 5.「配送機構をドメインへ出さない」）。**Queue メッセージのほうは `event.id` / `type` / `payload` / 宛先 DO の routing key / `owner_token` の5項目を運ぶ**（正本は `spec/async/index.md`「Queue メッセージ」）。**その routing key の粒度は発行元 DO 自身の locator である** — Identity Directory では `dir:g{世代}:b{番号}` の bucket 名で、多数の利用者に共有される粒度なので個人を指さない。**クレデンシャル単位の内部キー（canonical の全長 HMAC）は載せない** — 窓で切れない仮名になり、`aggregate_id`（窓キー）を Queue メッセージから外した理由（DLQ 上での宛先相関）をそのまま無効化する。`.adr/002` から引き継ぐのは「個人情報を識別子へ露出させない」の側であって、「鍵付きハッシュ済みなら何を載せてもよい」ではない。**メールアドレス・生トークン・`userId` を載せない。**
- consumer が呼ぶ RPC は「送信材料の取得」であって「送信」ではない。`send` が持つのは**宛先・生リセットトークン・`providerIdempotencyKey`** の3つである。**URL の組み立てとメール本文のレンダリングは `MailSender` アダプター（request Worker）の責務**であり、DO はテンプレートも base URL も持たない。DO の中に閉じるのは**復号と HMAC 導出**であって、レンダリングではない（`CLAUDE.md` の「CPU-bound work は request Worker」。レンダリングを DO へ寄せると、下の「影響」が受け入れているバケット共有 DO の直列化キュー占有がその分だけ増える）。
- **応答は2分岐のタグ付きユニオンで、これが全数である。** `send`（上の3項目を持つ）と `nothing-to-send`（**理由を1つも載せない空の分岐**）。未登録 / SSO 専用 / 消費済み / 期限切れ / より新しい発行に置き換えられた、のいずれであっても同じ1値が返る。consumer はどちらでも ack し、`nothing-to-send` は失敗ではない。
  - 分岐を分けないのは、(i) 発行が未使用トークンを全置換するので **DO 側の状態から supersede と宛先不在を区別できない**こと、(ii) **区別できること自体が列挙オラクルになる**こと（応答は consumer のログにも DLQ にも落ちうる）による。**分岐を1つに畳むのは実装上の妥協ではなく、秘密と PII を DO の外へ出さない範囲の延長である。**
  - **「なぜ送らなかったか」を consumer 側に残さない。** 運用の追跡が要るなら DO 側の観測に閉じる。
- **`providerIdempotencyKey` は DO が `event.id` から導出してこの応答に載せる。** 導出鍵は DO 側にあり consumer では導けないので、表の列にもせず、consumer にも鍵を配らない。
- **呼び出しガードを置く。** 生トークンは行の `payload` が持つ `tokenId` から導かれる。**`event.id` は Queue メッセージと DLQ を通って DO の外へ出るので、この RPC が無条件だと「`event.id` を知る者 = リセットリンクを引ける者」になる。** 応答が `send` になるのは次の3条件がすべて成り立つときだけである。
  1. その `event.id` の行が `outbox_events` に**存在する**
  2. 行が `quarantined` **でない**
  3. 呼び出しが持つ**不透明な `owner_token` が行の値と一致する**
  - **RPC が受け取るのは `event.id` と `owner_token` の2つだけであり、これが全数である。`tokenId` は行の payload から DO が読むので引数に取らない**（正本は `spec/async/index.md`「呼び出しガード」）。
  - **`status` は照合条件に入れない。** consumer が RPC を打つのは relay の相 3（`published` への落とし込み）の**後**なので、`status = 'publishing'` を条件にすると正常系の配送が全滅する。**二重送信の抑止は `status` ではなく `providerIdempotencyKey` が担い、役割を混ぜない。**
  - 同一性の判定は `owner_token` が単独で負う。再 claim で `owner_token` が書き換わるので、古い Queue メッセージを持った consumer の呼び出しは 3. で弾かれて `nothing-to-send` に落ちる。
- **`outbox_events` は終端（`published` / `quarantined`）へ落とすときも `owner_token` を `NULL` にしない。** `jobs` は `NULL` にするが、こちらは照合材料として残す。**落とすとガード 3. が `published` の行に対して必ず失敗し、正常系の配送が全滅する。**
- **配送の運用値の制約は2本で、これが全数である**（値の確定は #38。**スロットル窓の運用値は 8. の側にあり、正本は `spec/database/index.md` の `reset_request_windows` の節である** — 「2本で全数」は配送についての宣言であって、窓の運用値まで無いという意味ではない）。
  1. **`Queue の最大 retry 期間 + DLQ の保持期間 < リセットトークンの TTL`.** これは**機能要件**である — 満たしていれば、DLQ 滞在の末期に再駆動しても**リセットトークンがまだ TTL の内側にあり、有効なリンクを届けられる。** **`DLQ の保持期間 < TTL` とだけ書くとこの帰結が導けない** — 再駆動の時点でトークンが経過しているのは DLQ の滞在時間だけではなく、その前に Queue が retry を焼き切るまでの時間も含むからである。**この制約は `(event.id, owner_token)` の持参人証に対する防壁ではない**（防壁は衛生規則の禁止則2条と、DLQ そのものへの到達制御。到達制御の実体は #38。下の「影響」が別に持つ）。
  2. **`Queue の最大 retry 期間 + DLQ の保持期間 ≤ published 行の保持期間`.** これも機能要件であり、「再駆動の時点で行がまだ存在し、**呼び出しガードの条件 1.（行の存在）**を通れる」ことを保証する。

  **2本は左辺が同じ `Queue の最大 retry 期間 + DLQ の保持期間` で、上限として置く相手だけが違う**（リセットトークンの TTL と `published` 行の保持期間）。相手は独立に決まる運用値なので片方から他方は導けない。**「配送の運用値の制約は2本で全数」は動かない。** **片方だけを書くと、値の決定者が両立しない2値を選べてしまう** — 2. を落とすと、prune が行を消した後の DLQ 再駆動が恒久的に空振りし、その形は運用上ほとんど検出できない。

### 7. 連打の抑止は行の収束ではなく DO transaction 内のスロットル判定で行う

**`outbox_events` に `dedupe_key` 列も部分 UNIQUE 索引も置かない。表は例外なく「1イベント1行・不変」である。**

- **イベントを発行するか否かの判断を DO の transaction 内に置く。** スロットルの窓の状態を読み、その窓で既に発行済みならイベント行を書かない。窓の状態の更新（スロットル計上）も同じ transaction の中で行う。
- **窓が消費済みの場合はイベント行だけでなくトークンの発行も行わない。発行判断と窓判定は同じ1つの分岐であり、2つの独立した条件ではない。** 分けると、2回目の依頼が未使用トークンを全置換するのにイベント行は書かれない、という状態になり、**(a) 1通目が未送信なら送信時再読が `nothing-to-send` に落ちて0通、(b) 1通目が送信済みなら利用者の手元のリンクが死ぬ。**
- **列挙オラクル対策は保たれる。** 発行するか否かを決めるのは窓の状態だけであり、クレデンシャルの登録有無・認証方式・宛先の存在を一切参照しない。窓のキーは canonical から導くので4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）のどれでも同じ値が出る。**したがって同じ窓の状態に対して4ケースは一様に落ちる** — その窓での最初の依頼なら4ケースとも必ずちょうど1行、既に発行済みの窓なら4ケースとも1行も書かない。**「スロットル中」は窓の状態の側であり、他の3つと同じ軸には並ばない**（実際の分割はクレデンシャル3状態 × 窓2状態）。4ケースという数え方は一様性を検証するときの読み替えであって、互いに素な分割の宣言ではない。
- **「送らない側」の payload も形を4ケースで同一にする。** `tokenId` を nullable にせず、**宛先の有無から独立に生成した不透明値**を置く。`NULL` か否かが観測できると payload そのものが列挙オラクルになる。
- **「最新のトークンだけが有効」は送信時の再読で保つ**（上の 6.）。窓をまたいで積まれた古い行は `nothing-to-send` で no-op になる。結果として、**配送が正常なら**その窓で発行される有効なリンクは1回だけである（**受信通数の上下限ではない** — 配送は at-least-once なので同じリンクが複数回届きうる。**0通になるのは配送が `quarantined` / DLQ へ落ちた運用側の失敗のときだけ**で、その扱いは 12. が持つ）。**射程の正本は `spec/usecases/identity.md`「連打と窓」であり、ここで二重の権威を作らない。**
- スロットル窓のキーは**対象 canonical の全長 HMAC と依頼の窓から決定的に導き**、**クライアントから受け取らない**（導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節。旧 `operation_key` が使っていた導出形と同じだが、現行の `jobs.kind` 11種にこの形を採るものは1つも無いので、`jobs` 側を参照先にしない）。導出主体は下の 9. が持つ。

### 8. スロットルの窓は Identity Directory DO の `reset_request_windows` に置く

- **`credential_mappings.last_reset_requested_at` に相乗りさせない。** 同表の行が置かれるのは登録・予約の経路だけで、**未登録の canonical には行が無い。** 相乗りさせると「登録済みは2回目以降イベント行を書かない／未登録は毎回書く」となり、7. が守ろうとした一様性を 7. 自身が破る。**当該列は落とす** — 唯一の占有者が移る以上、残すとスロットルの権威が2箇所にある誤読の導線になる。
- **登録の有無に関係なく行を作る。** 行の有無が観測可能な差にならないことが、この表を新設した理由そのものである。**生のメールアドレスも SSO subject も持たない**ので PII は増えない。
- **期限切れの掃除は既存の `sweep-reset-tokens` に同居させ、新しい `jobs.kind` を足さない。** 同ジョブの責務を「期限切れのリセットトークン行の削除と、期限切れの窓行の削除」へ広げる。`jobs.kind` は 11 種のまま動かない。
- **窓行を書くことも `sweep-reset-tokens` の投入点である。** 投入点を「リセットトークン行を発行するのと同じトランザクション」のまま据え置くと、(a) 未登録アドレスだけを投げられた bucket で掃除ジョブが一度も投入されず窓行が単調増加し、(b) `enqueueJob` を呼ぶか否かが登録有無で分岐して4ケースの起床が割れる。したがって投入点を「**リセットトークン行または窓行を書くのと同じトランザクション**（= リセット依頼の4ケースすべて）」へ広げる。**宛先の登録有無で投入を分けない。**

### 9. スロットル窓ストアのドメイン契約は `PasswordResetThrottlePort.claimWindow` の1メソッドだけである

- `claimWindow(windowKey, now): boolean` — その窓の**最初の依頼なら行を作って `true`**、既存の窓なら `last_requested_at` だけを更新して `false` を返す。**判定と計上を2メソッドに分けない。**
- 分けると「4ケースが一様に落ちる」が2つの呼び出しの組み合わせの性質になり、呼び出し順序を誤ると一様性が静かに壊れる。1メソッドなら**単一の呼び出しの性質**として書ける。戻り値の `boolean` が、7. の「イベント行を書くか」と「トークンを発行するか」の**両方を決める唯一の分岐**になる。
- `windowKey` は呼び出し側が導出して渡す。ポートは導出鍵を知らない。**同期契約なので、5. の Promise 例外2件は動かない。**
- **導出主体は次のとおりである。** `windowKey` は **bucket 選択のために canonical の全長 HMAC を既に計算しているアダプター（Identity Directory の stub を選ぶ側）が、その同じ値を DO facade へプリミティブとして渡し**、ユースケースが窓と合成して組み立てる。**導出鍵はその stub 選択アダプターの中にあり、ユースケースにもポートにも渡らない。** facade が受け取る HMAC は server-side で導出された値であって外部入力ではないので、`CLAUDE.md`「Input validation」の第3の検証点にはならない（**クライアントからは受け取らない**）。合成は keyed な再導出を行わない（鍵付きの部分は HMAC 側で済んでいる）ので、`transactionSync` の中に暗号処理を持ち込まない。**新しいポートを1本も足さないので、5. の Promise 例外2件もドメインポートの数も動かない。導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節である。**
- UoW コンテキスト側のハンドル名は `resetThrottleStore` とし、`resetTokenStore`（`PasswordResetTokenPort`）と同じ「ハンドル名とポート名が別」の形に揃える。

### 10. 外部プロバイダへ渡す冪等キーの列をどちらの表にも置かない

`jobs` から当該列を落とし（12列 → 11列）、`outbox_events` にも同名の列を置かない。**provider へ渡すキーは `event.id` から DO が決定的に導き、送信材料 RPC の応答で consumer へ渡す。** 中身が `id` の関数であり、独立した情報を持たないからである。あわせて「**`jobs` に外部 I/O を伴う `kind` は存在しない**」を新しい不変条件として書く。

### 11. consumer の冪等性キーの保持先は consumer ごとに全数表で宣言する

- 単一の共有ストア（processed-events）を前提にしない。**新しい consumer を足すときは全数表の「冪等性キー」欄を埋めることが条件である。**
- 初期の唯一の consumer である **mail consumer は処理済み `EventId` を保持しない。** 代わりに (i) `event.id` から DO が導いた `providerIdempotencyKey` を provider へ渡し、(ii) 送信材料 RPC がトークンの生存と supersede を再確認する、の2段で冪等化する。

### 12. quarantine と DLQ の分界は「Queue に入る前か後か」の1本だけである

| 失敗の位置 | 記録先 | 状態 | operator 導線 |
|---|---|---|---|
| relay が Queue へ publish できない | 発行元 DO の `outbox_events` | `quarantined` + `terminal_reason` | DO の operator 専用 maintenance 経路（一覧・再駆動） |
| consumer が処理に失敗する | Queue の retry → DLQ | Queue 側の管理 | DLQ ハンドラ |

- **`published` は「Queue へ渡した」の意味であり、「処理された」ではない。**
- **prune が消すのは保持期間を過ぎた `published` の行だけであり、`quarantined` の行に保持期間を置かない。** 隔離行は運用者が再駆動するか明示的に削除するまで残る。運用者が原因を調べる前に材料が消えるほうが、上限の無い増加より高くつく。代償は**隔離行が自動では減らない**ことで、隔離は Queue producer binding の障害などで一斉に起きうるから、10 GB の算入と operator 導線の両方にその旨を書く（正本は `spec/database/index.md`）。
- **consumer からの ack を発行元 DO へ書き戻さない。** 書き戻すと (i) consumer が発行元 DO を特定して RPC する経路が全イベント型に必要になり、(ii) その書き戻し自体が at-least-once で失敗しうるため三段目の隔離先が要り、(iii) DO が「配送されていない」と「処理されていない」の2つの状態を持つことになる。
- **`terminal_reason` に PII と再利用可能な秘密を入れない** — 運用者が読む場所だからである。

### 13. consumer と DLQ ハンドラは request Worker の `queue()` ハンドラに置く。Worker は2本のままにする

- 3本目の Worker を足すと、秘密の配置とデプロイ順序の契約が1組増える。consumer が1つしかない現状で先に置くのは `.adr/001` の態度に反する。deploy 順序（state 先）も変わらない。
- **同居させても 1. の規則2 は空文化しない** — そこで言う「独立」は実行責任の独立（Queue の retry / DLQ が完了を管理し、発行元 DO は関与しない）だからである。物理的に分けたくなったときは Worker を1本足せばよく、その判断は運用の材料が出てから行う。

### 14. 全数表の正本は `spec/async/index.md` 1箇所とし、`CLAUDE.md` は判定規則と参照だけを持つ

- **3類型の全数表を持つのは `spec/async/index.md` の1箇所である。** 欄は識別子 / 由来（旧 `jobs.kind`）/ 類型 / owner DO クラス / 実行責任者 / 発行点・投入点（全数）/ consumer / fan-out 有無 / payload / 冪等性キーとその保持先。
- `spec/database/index.md` は**物理形**（DDL・索引・CAS・収束規則・backoff・prune）に専念し、全数表は参照に置き換える。
- **`CLAUDE.md` からは識別子の全数列挙を落とす。** 残すのは判定規則と、「`kind` または `event.type` を足すときは 1. の3規則のどれで当たったかをレビューで問い、`spec/async/index.md` の全数表に1行足す」という手続きの規定だけである。
- したがって `spec/database/index.md` が持っていた「`kind` を足したら**両方の表**を同時に直す」という同期義務は、「**`spec/async/index.md` の全数表を直す**」の1本になる。
- **不変条件**: すべての `event.type` と `jobs.kind` がちょうど1回現れる / 発行点・投入点の欄が空でない / consumer 欄が空のイベントは存在しない / 同じ処理が Outbox と `jobs` へ二重登録されない。

### 15. relay・mail consumer・DLQ ハンドラはアダプター層に属する

3つとも台帳は `spec/inventory/adapter.md` にだけ行を持ち、**ユースケース層にハンドラを作らない。** mail consumer は「送信材料 RPC の2分岐 → `MailSender`」という2ポートの合成を持つのでユースケースに見えるが、持っているのは配送機構の手続きだけであり、**業務判断はすべて RPC の向こう側（DO の中）にある。判断が無いものはユースケースではない。** 現行の旧 `send-mail` ジョブも同じ形でアダプター側にしかない。

### 16. 前方互換点は3本のままとし、outbox 行を足さない

`spec/database/index.md` が全数として宣言している前方互換点（`account.caller_token` / `operations.target_locators` / `credential_mappings` のコーディネーター予約行）は3本のまま据え置く。前方互換点の性質は「終端の後始末が終わるまで消してはならない材料」であり、`outbox_events` の prune が触るのは**保持期間を過ぎた `published` の行だけ**で、**`quarantined` の行は恒久的に残る**（上の 12.）。したがって「終端の後始末に要る材料を prune が消す」経路が存在しない。**据え置くことを明示的に書く** — 書かないと、3本という数が取り残されたのか意図的なのかを読み手が判別できない。

## 検討した代替案

**各業務 DO に Outbox 表と Alarm relay を置く（採用案）** — 業務更新とイベント行の追加が同じ `transactionSync` で原子的に確定し、relay の起動契機が DO の中に閉じる。代償は表が2つ増えること（両 DO クラス）と、claim / backoff / lease / prune の規約を2表で共有する実装上の抽象が要ることである。

**専用の Outbox DO へ RPC でイベントを書く** — Outbox の表とランナーが1箇所に集まり、relay の実装も1つで済む。採らなかった理由は、**業務更新とイベント行の追加を原子的に書けない**こと。RPC は業務トランザクションの外にしか置けないので、「業務は成功したがイベントが書かれていない」「イベントは書かれたが業務がロールバックした」の両方が構造的に生じる。加えて全ユーザーのイベントが1つの DO へ集まり、`.adr/002` の物理分離と正面から衝突する。

**すべて `jobs` + Alarm のままにする（`.adr/004` の現行案）** — 表もランナーも1本で、本 ADR が要求する変更が丸ごと不要になる。採らなかった理由は、**実行責任の所有者の違いが表現できない**こと。独立した consumer へ委譲したい処理と、その DO 自身が完走させなければならない処理が同じ表に並び、`jobs` を読む側が「この行はネットワークに出るか」を判定できない。加えて `jobs` の収束規則（同じ `operation_key` は既存行へ収束する）はイベントの意味論と両立しない。

**業務 transaction の中で外部 I/O を行う** — 配送機構そのものが要らなくなる。採らなかった理由は2つあり、どちらも単独で決定的である。(i) 外部の遅延と障害が利用者の操作の成否に直結する。(ii) **`transactionSync` のコールバックは同期であり `fetch` を呼べない** — 技術的に不可能である。

**relay を `jobs.kind = 'relay-outbox'` の再武装ジョブにする** — 表もランナーも1本になり、Alarm の計算も1箇所で済む。採らなかった理由は、**起床時刻の権威が二重化する**こと。ジョブ行の `next_run_at` と outbox 行群の `min(next_run_at)` の両方が「次に relay すべき時刻」を主張し、片方が取り残される。加えて backoff の単位が食い違う（outbox の backoff は行ごとだが、ジョブ行の `attempt` は1本しかない）。さらに `.adr/010` の収束規則3つが relay ジョブに適用され、`done` からの復帰可否という無関係な判断が要る。

**Outbox 専用の第2の Alarm を持つ** — プラットフォームが許さない（1 DO 1 Alarm）。

**Queue の cron や consumer 側から DO を叩いて relay させる** — 起動契機が DO の外になり、「Alarm が relay の起動契機である」という本 ADR の決定に反する。加えて全 DO を舐める外部スケジューラが要り、`.adr/002` の「全ユーザーを1バッチで舐める定期実行は存在しない」と衝突する。

**`outbox_events` に `dedupe_key` 列と部分 UNIQUE 索引を置き、同キーの終端していない行があれば2行目を作らない（撤回した旧案）** — 旧 `send-mail` の収束の形をそのまま移せる。**撤回した理由は、上の 6.（送信材料 RPC）と合成すると「2回依頼して0通」の経路が生まれる**こと。同一窓の2回目の依頼が来ると、発行が1回目のトークンを全置換するのに `dedupe_key` の衝突で新しい行は作られない。残った1行の payload は1回目の `tokenId` を指したままなので、送信時の再読で `nothing-to-send` に落ちる。**窓の長さぶんこの状態が続く。** 加えて `dedupe_key` は、表を分けた理由（イベントは収束してはならない）に対する例外を同じ表へ持ち込む。**収束をやめても濫用耐性は失われない** — 抑止の実体はもともと「窓ごとに1回だけ」であり、それは行の一意制約ではなくスロットル判定が担える。

**送信材料 RPC の応答を3分岐にする（`superseded` / `no-recipient` を分ける撤回した旧案）** — 運用の追跡がしやすくなる。**撤回した理由は2つあり、どちらも単独で決定的である。** (i) **DO 側の状態から区別できない** — 発行はそのクレデンシャル宛の未使用トークンを同じトランザクションで全削除するので、supersede された `tokenId` の行は痕跡なく消え、payload が持つのは `tokenId` だけなので、行が無いときに DO はクレデンシャルへ辿ることすらできない。(ii) **区別できること自体が列挙オラクルになる** — 応答は consumer のログにも DLQ にも落ちうるので、宛先不在が観測できれば「そのアドレスは未登録 / SSO 専用である」が DO の外へ漏れる。

**呼び出しガードに `status = 'publishing'` を含める（撤回した旧案）** — 「送信材料を引けるのは relay が lease を握っている最中だけ」という素直な読みで、lease の意味論とも揃って見える。**撤回した理由は、その窓が consumer には決して見えない**こと。relay の相 2 と相 3 のあいだに consumer が動く保証は無く、実際には Queue の配送遅延のぶんだけ必ず後になる。条件を課すと**すべての依頼が `nothing-to-send` に落ち、リセットメールが1通も送られない。**

**スロットル窓を `credential_mappings.last_reset_requested_at` に相乗りさせる** — テーブルが増えず、既存列の用途がそのまま生きる。採らなかった理由は、**未登録の canonical に行が無く、4ケース一様が構造的に成立しない**こと。未登録 canonical にも行を作って回避する案は、写像表が「一意性の権威」であるという性格を壊し、未登録メールアドレスを写像表へ書き込む濫用・PII の別問題を生む。

**窓の掃除に新しい `jobs.kind`（例 `sweep-reset-windows`）を足す** — 作業述語が1ジョブ1目的で読みやすい。採らなかった理由は、**`jobs.kind` が 11 種から 12 種へ動き、初期値の分類と全数表の両方が動く**こと。掃除の対象はどちらも「Identity Directory DO の、リセット依頼に伴って増える期限つき行」であり、同じ起床で一緒に掃除できる。**作業述語を広げるほうが、全数表の行を増やすより安い。**

**窓を KV / Cache API に置く** — DO の SQLite を増やさない。採らなかった理由は、**同じトランザクションで読めない**こと。窓の読み取りとスロットル計上はイベント行の追加と同じ `transactionSync` に入る必要がある。

**consumer を3本目の独立 Worker にする** — 判定規則2を物理構成でも満たせ、負荷の隔離もできる。採らなかった理由は、秘密の配置とデプロイ順序の契約が1組増え、本 ADR のスコープを越えること。運用の材料（consumer の負荷が request の負荷と干渉するか）が出てから再検討できる余地は残す。

**consumer を state Worker に置く** — メール provider の秘密の帰属が動かず、送信材料 RPC が同一 Worker 内で完結する。採らなかった理由は、state Worker が「DO クラスを所有する Worker」であるという役割が濁ること、および**外部 I/O を state Worker へ戻すなら Outbox を経由する意味が薄い**（規則3で local job に戻したほうが素直になる）こと。

**専用の processed-events ストア（DO / KV）を復活させて冪等化を一様にする** — consumer ごとの判断が要らなくなる。採らなかった理由は、consumer が1つしかない現状で共有ストアを先に置くこと自体が `.adr/001` の態度に反すること、**KV は結果整合なので「書いた直後に読む」が保証されず、重複配送が近接したときに素通りする**こと、DO を置くとそれ自体が単一のホットスポットになり `.adr/002` の物理分離と噛み合わないことである。

## 影響

- **`jobs` から外部 I/O が消える。** 「local job はすべて DO ローカルで完結する」が新しい不変条件になり、`jobs` の列数が 12 → 11 になる。
- **非集約ストアが7つから9つになる**（`outbox_events` / `reset_request_windows`）。書き込み口は 6ストア・7メソッド → **8ストア・9メソッド**（`enqueueEvent` / `resetThrottleStore` が増える）。UoW コンテキストの副作用登録点は `enqueueJob` / `enqueueEvent` / `recordOperation` / `updateOperation` / `setMigrationCursor` の5つになる。
- **Identity Directory DO のテーブルが2つ増える**（`outbox_events` と `reset_request_windows`）。User Data DO は `outbox_events` の1つが増える。
- **3類型の全数表が `spec/async/index.md` へ移る。** これに伴い `.adr/010` について次の3項を宣言する。これが失効範囲の全数である。
  1. **「正本の表」の所在が `spec/database/index.md` から `spec/async/index.md` へ移る。** `.adr/010` の本文は改変しないので、表を探しに行った読み手が見つけられなくならないよう本 ADR が移設を宣言する。投入点の欄を持つこと・欄が空でないことという不変条件そのものは維持し、イベントへも拡張する。
  2. **「収束、外部プロバイダへ渡す冪等キーの導出、同じ依頼の連打の吸収は、すべて『同じ入力から同じキーが出る』ことに依存しており、生成 ID では成立しない」という項のうち、冪等キーの導出の帰属が変わる。** 上の 10. により導出は `jobs` の関心事ではなくなり、しかも新しい導出元は**生成 ID である `event.id`** なので、`.adr/010` の論法がこの一点で反転する。収束と連打の吸収について `operation_key` が生成 ID であってはならないことは、`jobs` について引き続き有効である。
  3. **主キーの例外 (b) の射程が広がる。** `.adr/010` は例外を「**ジョブ**の同一性キーは生成せず、ジョブの同一性から決定的に導く」とジョブに限定して宣言しているが、射程は「**生成せず決定的に導く同一性キー**」へ広がる。上の 7. / 8. が置く `reset_request_windows.window_key` は、**対象 canonical の全長 HMAC と依頼の窓から決定的に導く**同一性キーであり（導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節）、**この例外そのものの射程に入る2つ目の列**である。したがって**例外の数は2つのまま動かない** — 数えているのは「生成せず決定的に導く」という**規則の例外の数**であって、その射程に入る列の数ではない。列で数えると、同じ性質の列が増えるたびに全数宣言が動き、宣言の意味が「規則の数」から「列の数」へ堕する。**根拠に `jobs.operation_key` の導出規則を引かない** — 現行の `jobs.kind` 11種はいずれもジョブの同一性から導く値（DO ごとの定数キー・`operationId` 由来・対象バージョンや世代由来）であり、「対象と時間窓から導く」形は旧 `send-mail` が使っていたもので現行には1つも無いので、引くと失効した規則を指すことになる。`.adr/010` が「3件目が要るときは同じ場所を直す」と書いた場所は `spec/database/index.md` の共通方針である。
- **`CLAUDE.md` から `jobs.kind` / `event.type` の全数列挙が消える。** `spec/database/index.md` が持っていた「両方の表を同時に直す」義務は1本になる。
- **Cloudflare Queues への依存が復活する。** `.adr/004` が Outbox / relay / consumer / DLQ を廃止して以降、`CLAUDE.md` は「Queues を持たない」をランタイムの性質として宣言していた。本 ADR はそれを反転させ、プラットフォーム依存が1つ増える。provisioning の義務も戻る — Queue 1本と DLQ 1本（`infra/cloudflare/pulumi`）、**state Worker（DO 側）の producer binding**、request Worker の consumer / DLQ binding、4つの wrangler テンプレートの更新である。producer binding が state Worker 側に立つのは、publish するのが relay = DO だからである（上の 5.）。実際の追加は #51、運用値（retry 期間 / DLQ の保持期間）は #38。
- **consumer が秘密を扱う実行主体になる。** メール provider の API キーが帰属し、宛先と生トークンを配送の瞬間だけ保持する。**帰属は state Worker から request Worker へ移る**（`apps/web/.dev.vars.example` への実際の追記は #51）。`CLAUDE.md` の「Each Worker has its own, non-overlapping set of secrets」の対象が1件増える。**canonical を全長 HMAC へ写す写像鍵は（本 ADR 以前から）request Worker 側の秘密であり、#51 の `.dev.vars.example` 追記の対象に含める** — 帰属が動くのはメール provider の秘密1件だけだが、宣言されていない既存の帰属がもう1つあることを同じ表に載せる。
- **秘密と PII について保証するのは「載らない・永続化されない」であって「DO の境界を出ない」ではない。** 保証は3つ — (i) `outbox_events.payload` / Queue メッセージ / DLQ / ログ / `terminal_reason` のいずれにも PII と再利用可能な秘密を載せない（**明示的な例外は `owner_token` ただ1つで、載せる理由と代わりに置く禁止則は下の持参人証の項が持つ**）、(ii) 宛先メールアドレスと生トークンは送信材料 RPC の応答と provider へのリクエストにのみ存在し、どこにも永続化されない、(iii) **DO の中から出ないのは、宛先の復号鍵・リセットトークンの導出鍵・`providerIdempotencyKey` の導出鍵の3つである**（3本目は上の 6.）。canonical を全長 HMAC へ写す**写像鍵は bucket 選択のために request Worker 側（stub 選択アダプター）にあり、DO の中には無い**（正本は `spec/database/index.md`「窓キーの導出」）。これは本 ADR 以前からの帰属であり、本 ADR はそれを窓キー導出の前提として明示しただけである（上の 9.）。**無限定に「HMAC 導出鍵は DO の中から出ない」と書かない** — 書くと (a) 窓キーの導出を DO 側へ寄せる案（`claimWindow` に canonical を渡す形。上の 9. が却下している）への導線になり、(b) 写像鍵が request Worker の秘密であることが `.dev.vars.example` の帰属表（#51）から落ちる。**「境界を出ない」と書くと、後任が consumer 側のログ方針や秘密管理を緩める導線になる。**
- **判定規則2の根拠が細る。** 上の 6. の RPC 往復により、consumer が実際に担うのは provider 呼び出し1回だけで、送信材料の解決・宛先の有無・トークン生存の再確認はすべて DO へ戻る。「実行責任を独立した consumer へ委譲する」に照らすと委譲されている責任は薄い。**この事実を全数表の該当行の差し戻し条件と対にして残す** — 実装で RPC 往復のコストが想定を超えた場合、規則3を根拠に local job へ差し戻すことが規則上は可能であり、そのときは Outbox に載るイベントが0件になる。
- **送信材料 RPC は、バケット共有の Identity Directory DO を配送1件あたり1回占有する。** `.adr/002` は「1利用者のリクエストが1つの Durable Object に直列化する」ことを構造的制約として名指ししており、Identity Directory DO はバケット単位で多数の利用者に共有される。本文レンダリングと復号・HMAC 導出を DO の中に置く（上の 6.）以上、その直列化キューを配送のぶんだけ占有するコストを受け入れる。負荷の実測は #38 であり、閾値を超えた場合の逃げ道は1つ上の差し戻しである。
- **未認証の `requestPasswordReset` の増幅係数が上がる。** distinct な canonical 1件につき、窓行1 + `outbox_events` 行1 + Queue メッセージ1 + cross-Worker RPC 1往復が生じる。**canonical 単位のスロットルはこれを抑止しない** — 窓のキーは canonical ごとに独立なので、異なるアドレスを撒く経路には一切掛からない。逼迫すると書き込みだけが失敗し、影響は**バケットを共有する他の利用者**にも及ぶ。**発信元単位のレート制限は transport 境界の責務であり、本 ADR の範囲外として #38 / #51 へ引き継ぐ。**
- **配送は at-least-once・順序保証なしである。** 同じ通知が複数回届きうることを受け入れ、イベント間の順序に依存する設計を書かない。
- **PITR で巻き戻すと `published` が `pending` に戻り、再 relay で重複配送になる。** at-least-once なので正しさは壊れないが、PITR のチェックリストに項目が要る。
- **`(event.id, owner_token)` の対が「送信材料を引ける持参人証」になる。** 対は Queue メッセージと DLQ を通るので、DLQ を読める者はその窓のあいだリセットリンクを引ける。**`status` 照合では防げない**（照合を残すと正常系が成立しない。上の 6.）。**運用値の制約1（`Queue 最大 retry + DLQ 保持期間 < トークン TTL`）はこの防壁ではない** — 不等式が意味するのは「DLQ 滞在中の再駆動はまだ有効なリンクを届けられる」ことであって、持参人証の無効化ではない。**露出窓は `published` 行の保持期間で上から押さえられているわけではない。** prune はジョブランナーの起動末尾でしか走らないので、**終端行しか残っていない DO は定義上 `deleteAlarm()` 済みで起床せず、保持期間を過ぎた `published` 行が次の投入まで残る。** ただし**実効的な上限はリセットトークンの TTL である** — 行が残っていても、TTL を過ぎたトークンについては送信材料 RPC が `nothing-to-send` を返すので宛先も生トークンも引けない。**「行の存在」は `published` の保持期間では有界でなく、「引ける材料」は TTL で有界である。** 防壁は次の2本で構成する。
  1. **`owner_token` を到達させない。** `owner_token` は再利用可能な秘密であり、Queue メッセージと DLQ に載るのは**呼び出しガードの成立に必要だからという明示的な例外**であって、衛生規則の対象外だからではない。したがって (i) Queue メッセージ全体を含めてログへ出さない（consumer / DLQ ハンドラのエラーログに載せてよいのは `event.id` / `type` まで）、(ii) DLQ のメッセージを外部の監視基盤・ログ集約先へ転送しない（転送する設計を足すなら上の 6. へ差し戻す）。**規則の正本は `spec/async/index.md` の衛生規則である。**
  2. **DLQ に到達できる者を絞る。** 誰が DLQ を読めるかは運用の設計であり、#38 が持つ。
- **`owner_token` は claim ごと・行ごとに一意な capability として採る。** `jobs` の「claim した実行主体の識別子」という言い回しを `outbox_events` 側では使わない — その読みで最も素直な実装（1回の relay パスにつき1個）を採ると、同じ起床で claim した全行が同じ値を共有し、**DLQ に落ちた1件から `event.id` だけで他の行のガードを通せる。** 生成要件（暗号論的乱数由来・時刻や連番や DO 識別子から導かない・長さの下限）の正本は `spec/database/index.md` の列定義であり、ここに置くのは秘密区分を分けた理由だけである。**主キーではないので、同ファイルの「ID の例外は2つ」の数え上げには入らない。**
- **`.thread/34/design.md`（#34 の作業ログ）の次の5節は、本 ADR が置き換えた範囲で失効する。これが全数である。** 作業ログそのものは改訂しないので、ここで節を名指しするのが唯一の防波堤になる。
  - **第7.3節**（ドメインイベント機構の廃止範囲。`.adr/004` の影響が名指ししている）— 全面的に失効する。
  - **第7.4節**（`jobs.kind` 12種の全数表。`.adr/004` の決定の第2項が名指ししている）— 失効する。全数は `spec/async/index.md` が持つ。**宣言を落とすと `.adr/004` から辿って生きた表に見える。**
  - **第7.6節**（外部 I/O を永続ジョブに残す境界）— **部分失効である。** 境界の規則（トランザクションの中で外部 I/O をしない）、メール送信の所有者が Identity Directory bucket であること、生トークンをジョブ行に載せず送信直前に導出することは**有効**である。失効するのは行の書き方と収束の手段の3点 — 「登録の有無によらずダミージョブ行を書く」「スロットル中でもジョブ行は必ず書く」「同じ canonical への連打は `operationKey` でジョブ行1本に収束する」。置き換えるのは上の 6. / 7. / 8. である。**`.adr/004` から名指しされていないので「ADR から辿れる範囲」では漏れるが、宣言を落とすと実装者が作業ログを読んで旧機構をそのまま実装する導線が残る。**
  - **第7.7節**（ジョブ契約の正文。`.adr/004` の決定の第2項が名指ししている）— 上の 2. / 4. / 10. が置き換えた範囲で失効する。
  - **第1.4節**（機械検査の期待値。「`jobs` は12列」「`kind` は各クラス6種・合計12種」「4類型が12種を1回ずつ覆う」）— いずれも改訂後の実体と食い違う。**宣言を落とすと、後で検査を回した人が全部赤を見る。**
