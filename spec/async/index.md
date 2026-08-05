# 非同期実行の設計

非同期に実行される処理の**判定規則**と**全数表**の正本。「どの処理をどの機構に載せるか」はここで決まり、載せた機構の物理形（DDL・索引・CAS・backoff・prune）は [database/index.md](../database/index.md) が持つ。

- 上流: [.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)（DO ローカル Outbox と Alarm relay。**本ファイルの直接の根拠**） / [.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)（ローカル同期コミットと Alarm ジョブ。第3項と第2項の一部は `.adr/013` が supersede） / [.adr/010](../../.adr/010-job-enqueue-points-and-reenqueue-rules.md)（投入点の全数と再投入の収束規則）
- 関連: [database/index.md](../database/index.md)（`jobs` / `outbox_events` / `reset_request_windows` の物理形） / [domains/index.md](../domains/index.md)（ポートの同期契約と派生データの更新）
- **本ファイルが3類型の全数表の正本である。** `kind` / `event.type` を足すときに直すのは本ファイルの表1つだけである（下の「役割分担」）

## 判定規則

**上から順に評価し、最初に当たった類型にちょうど1回割り当てる。**

1. **業務状態と同じトランザクションで完了しなければならないなら同期実行。** 別の機構へ渡さず、その `transactionSync` の中で直接行う。
2. **実行責任を独立した consumer へ委譲する／複数 consumer へ fan-out する／他システムへ配送の事実を残す必要があるなら Outbox event。**
3. **それ以外で、特定の DO または saga コーディネーターが完了責任を持って後から再開するなら local job（`jobs` + Alarm）。**

規則の読み方:

- **規則2 の「独立」は実行責任の独立である** — Queue の retry と DLQ が完了を管理し、発行元 DO は publish 以降を知らない。**Worker が物理的に分かれていることではない**（mail consumer は request Worker に同居する。下の「配送機構の契約と責務」）。物理的な分離は運用判断であり、分類を動かさない。
- **外部 I/O であることは、単独では Outbox の条件にならない。** 外部 I/O は「同期トランザクションの中では実行できない」ことしか含意せず、実行責任がどこにあるかを何も言わない。
- **cross-DO RPC であることも、単独では Outbox の条件にならない。** `resume-link` / `resume-signup` / `resume-credential-change` / `finalize-withdrawal` / `sweep-orphan-mapping` はいずれも他の DO を呼ぶが、**状態機械の完了責任はコーディネーター DO 自身が持つ**ので規則3 の local job である。
- **分類の変更には「実行責任の所有者が誰か」に基づく理由が要る。** 「外部を呼ぶから」「重いから」「将来 consumer が要りそうだから」は理由にならない。`kind` / `event.type` を足すときは、上の3規則のどれで当たったかをレビューで問い、下の全数表に1行足す。

## 全数表

**すべての `event.type` と `jobs.kind` が、この表にちょうど1回だけ現れる。**

| 識別子 | 由来（旧 `jobs.kind`） | 類型 | owner DO クラス | 実行責任者 | 発行点・投入点（全数） | consumer | fan-out | payload | 冪等性キーとその保持先 |
|---|---|---|---|---|---|---|---|---|---|
| FTS5 projection | — | 同期実行 | User Data | 業務トランザクションそのもの | memo / knowledge の本体を書くリポジトリ実装（作成・更新・ソフトデリート・復元・ハードデリート）。**本体を書くのと同じ `transactionSync`** | — | 無 | なし（別機構へ渡さない） | — （原子性が担保するので再実行が起きない） |
| retention のハードデリート | — | 同期実行 | User Data | 業務トランザクションそのもの | `purge-trash` の削除フェーズのトランザクション（本体行・リビジョン・出典リンク・検索 projection を同じ `transactionSync` で消す）。**`purge-trash` の内部フェーズであり、独立した起床契機を持たない** | — | 無 | なし | — |
| saga phase の前進 | — | 同期実行 | User Data / Identity Directory | 業務トランザクションそのもの | **前進させる先は owner DO クラスで分かれる** — User Data DO では `operations.phase` を書く各段のトランザクション（`resume-link` / `finalize-withdrawal` の各起床の中）、Identity Directory DO では予約行の `status` / `saga_committed` と `credential_mappings.change_state` を書く各段のトランザクション（`resume-signup` / `resume-credential-change` の各起床の中）。**`operations` は User Data DO にしか無いので、Identity Directory 側はそこに触れない**（database/index.md） | — | 無 | なし | — （User Data DO では `operations` の `payload_digest` と `phase`、Identity Directory DO では予約行の `saga_committed` と `credential_mappings.change_state` が再送を吸収する） |
| `purge_after` の一括再計算 | — | 同期実行 | User Data | 業務トランザクションそのもの | **2つあり、性格が違う** — (1) `changeTrashRetentionDays` のトランザクション（**独立した発行点**）、(2) `purge-trash` の再計算フェーズ（**`purge-trash` の内部フェーズであり、こちらは独立した起床契機を持たない**。自己消尽する作業述語。database/index.md の `user_settings` の項） | — | 無 | なし | — |
| `identity.passwordResetRequested` | **旧 `send-mail`** | Outbox event（**差し戻し条件は末尾の P-001**） | Identity Directory | Queue の retry と DLQ（発行元 DO は publish までしか関与しない） | `requestPasswordReset` のトランザクション。**分岐の材料は `reset_request_windows` の窓の状態だけで、登録有無・認証方式・宛先の存在を参照しない** — その窓での最初の依頼なら4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）とも必ずちょうど1行、既に発行済みの窓なら4ケースとも1行も書かない。**ただし4ケースは互いに素ではない — スロットル中は窓の状態の側であり、他の3つと同じ軸には並ばない**（実際の分割はクレデンシャル3状態 × 窓2状態） | mail consumer | 無（consumer は1つ） | `tokenId` / メール種別の**2つだけ**。**宛先 DO の routing key は payload に入れない** — routing key は relay が publish 時に Queue メッセージへ押す項目であって、ドメインの payload ではない（`EventId` と同じ扱い。`.adr/013` の「配送機構をドメインへ出さない」）。**メールアドレス・生トークン・`userId` を載せない。`tokenId` は nullable にせず、宛先の有無から独立に生成した不透明値を置く**（形が割れると payload が列挙オラクルになる） | `event.id`。**mail consumer は保持しない** — (i) `event.id` から DO が導いた `providerIdempotencyKey` を provider へ渡す、(ii) 送信材料 RPC がトークンの生存と supersede を再確認する、の2段で冪等化する |
| `purge-trash` | `purge-trash` | local job（期限処理） | User Data | 所有 DO の Alarm ジョブランナー | ソフトデリートの4ユースケース（`softDeleteMemo` / AI の `delete` / `trashDocument` / `trashTopic`）と `changeTrashRetentionDays`。`purge_after` を書くのと同じトランザクションで `TrashQueryPort.findEarliestPurgeAfter()` を読んで張る（domains/trash.md「保持期限」） | — | 無 | 対象 ID など。**PII と再利用可能な秘密を入れない** | `jobs.operation_key`（所有 DO の `jobs`。定数キー） |
| `reindex` | `reindex` | local job（チェックポイント分割を要する一括処理） | User Data | 所有 DO の Alarm ジョブランナー | migration ゲート（トークナイザ・正規化規則の変更を含む `schema_version` の前進時）。アダプター側で、usecase からは投入しない | — | 無 | 対象バージョンと段。**PII と再利用可能な秘密を入れない** | `jobs.operation_key`（進捗は `migration_progress`） |
| `migrate-bulk` | `migrate-bulk` | local job（チェックポイント分割を要する一括処理） | User Data | 所有 DO の Alarm ジョブランナー | migration ゲート（データ書き換えを伴う段を切り出すとき）。アダプター側で、usecase からは投入しない | — | 無 | 対象バージョンと段。**PII と再利用可能な秘密を入れない** | `jobs.operation_key`（進捗は `migration_progress`） |
| `finalize-withdrawal` | `finalize-withdrawal` | local job（cross-DO saga の前進） | User Data | 所有 DO の Alarm ジョブランナー | **2つあり、これが全数である** — (1) 退会の開始（`account.status` を `deleting` にするのと同じトランザクション）、(2) 新規登録 saga の終端規則によるアカウントの放棄（**その手順は #45 が定める**が、投入点が2つであること自体は本表が持つ） | — | 無 | 対象 locator など。**PII と再利用可能な秘密を入れない** | `jobs.operation_key` + `operations.operation_id` |
| `sweep-orphan-mapping` | `sweep-orphan-mapping` | local job（cross-DO saga の前進） | User Data | 所有 DO の Alarm ジョブランナー | `unlinkSsoCredential` の逆引き削除（`credential_locators` の行を消すのと同じトランザクション）。**これが唯一の投入点である** — 落とすと写像の削除が落ちたときに `active` な孤児 mapping が恒久的に残る | — | 無 | 対象 locator。**PII と再利用可能な秘密を入れない** | `jobs.operation_key`（定数キー） |
| `resume-link` | `resume-link` | local job（cross-DO saga の前進） | User Data | 所有 DO の Alarm ジョブランナー | SSO 連携 saga の開始（`operations` 行を記録するのと同じトランザクション） | — | 無 | `operationId` など。**PII と再利用可能な秘密を入れない** | `jobs.operation_key` + `operations.operation_id` |
| `resume-signup` | `resume-signup` | local job（cross-DO saga の前進） | Identity Directory | 所有 DO の Alarm ジョブランナー | 新規登録 saga の予約行を書くのと同じトランザクション。**コーディネーター bucket だけが自分に投入する**（非コーディネーター bucket には投入しない） | — | 無 | `operationId` など。**PII と再利用可能な秘密を入れない** | `jobs.operation_key` + `credential_mappings.operation_id`（コーディネーター bucket の予約行）。**`operations` は保持先にしない — User Data DO にしか無い**（database/index.md） |
| `resume-credential-change` | `resume-credential-change` | local job（cross-DO saga の前進） | Identity Directory | 所有 DO の Alarm ジョブランナー | クレデンシャル変更 saga の開始（`change_state` を `pending` にするのと同じトランザクション） | — | 無 | `operationId` など。**PII と再利用可能な秘密を入れない** | `jobs.operation_key` + `credential_mappings.change_state` |
| `sweep-reservations` | `sweep-reservations` | local job（期限処理） | Identity Directory | 所有 DO の Alarm ジョブランナー | 予約行を書く3箇所（新規登録 saga の予約2つと SSO 連携の予約）。**予約を書いた bucket が自分に投入する** | — | 無 | なし（作業述語は `cm_reservation_idx` から引く） | `jobs.operation_key`（定数キー） |
| `sweep-reset-tokens` | `sweep-reset-tokens` | local job（期限処理） | Identity Directory | 所有 DO の Alarm ジョブランナー | **リセットトークン行または窓行を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）。宛先の登録有無で投入を分けない** — 窓行は4ケースすべてで作られるので、投入も4ケースすべてで起きる。投入時の **`next_run_at` は窓の終端（= その窓の開始 + 窓の長さ）から導き、送る側でもリセットトークンの `expires_at` を材料にしない。** 窓行の `expires_at` は窓の終端に**猶予**を足した値だが、**猶予は窓行を書くアダプター側の掃除条件にだけ効くので、投入時刻の材料にしない** — 投入側にも置くと「2層が同じ設定値を読む」対象が窓の長さに加えてもう1つ増え、ズレたときに静かに壊れる面が広がる。窓の終端に起きた掃除は窓行についてはまだ空振りしうるが、**完了時の再武装が2表の索引（`prt_expires_idx` / `rrw_expires_idx`）から `min(expires_at)` を読み直して正しい時刻を張り直すので収束する。** 投入時刻を宛先の登録有無に依存させないことは変わらない（依存させると「同じ起床を張る」が4ケースで割れる）。 | — | 無 | なし（作業述語は `prt_expires_idx` / `rrw_expires_idx` から引く） | `jobs.operation_key`（定数キー） |
| `rotate-encryption` | `rotate-encryption` | local job（チェックポイント分割を要する一括処理） | Identity Directory | 所有 DO の Alarm ジョブランナー | operator 専用 maintenance 経路からの起動（database/index.md）。**本 spec で確定している投入点はこれだけである** — 移送側からの再投入を足すかは #44 が決める | — | 無 | 退役させる世代。**PII と再利用可能な秘密を入れない** | `jobs.operation_key`（進捗は `rotation_checkpoints`） |
| **User Data DO のイベント型: 0件** | — | Outbox event | User Data | — | **定義されたイベント型が1つも無い。** 表と機構（`outbox_events` + Alarm relay）は両クラスに置くが、置くのは表と機構であってイベント型ではない（`.adr/013`） | — | — | — | — |

**集合演算からの除外は最終行1つだけであり、それが全数である。** 「User Data DO のイベント型: 0件」の行は識別子欄も由来欄も持てないので、識別子や由来を集合として突き合わせる検査（同一識別子の二重出現・`event.type` とドメイン定義の1対1・consumer 欄の充足・旧 `jobs.kind` 12種との突き合わせ）から**明示的に除外する。** 除外を書かずに回すと、この行を集合に入れて空文字列のズレを踏む。

**「由来」欄の `—` は「対応する旧 `jobs.kind` が無い」を表す。** 同期実行の4行がこれに当たる（もともとジョブではない）。**旧 `jobs.kind` 12種との突き合わせは `—` を除いた由来欄の集合に対して行い**、そのとき集合はちょうど12個（`旧 send-mail` + local job 11種）になる。

## 不変条件

- **すべての `event.type` と `jobs.kind` が、全数表にちょうど1回現れる。** 同じ識別子が2つの類型に現れない。
- **発行点・投入点の欄が空でない**（`.adr/010` の不変条件をイベントへ拡張したもの）。欄が空の行は「投入されるが二度と起きない」処理として検出される。
- **consumer 欄が空のイベントは存在しない。** consumer も明示的な監査要件も無いイベント型を定義しない。
- **同じ処理が Outbox と `jobs` の両方へ登録されない。** 二重登録は判定規則が「最初に当たった類型にちょうど1回」と言っていることの違反である。
- **local job はすべて DO ローカルで完結する。** `jobs` の行はネットワークに出ない。これは `.adr/013` が新設した不変条件であり、物理側では「`jobs` に外部 I/O を伴う `kind` は存在しない」として現れる。
  - **これは現時点の全数表の帰結であって、判定規則から導かれる恒久的な性質ではない。** 判定規則は「外部 I/O であることは単独では Outbox の条件にならない」と言っているので、**「外部 I/O を伴うが完了責任はその DO 自身が持つ」処理は規則3 で local job になりうる** — 規則と不変条件は導出関係にない。実際、末尾の P-001 が差し戻しの経路として明示している。**この不変条件は、そういう `kind` が現に1つも無いという事実の宣言として読む**（下の「分類の差し戻し条件」で撤回されうる）。

## payload と `terminal_reason` の衛生規則

- **`outbox_events.payload` / `jobs.payload` / Queue のメッセージ / DLQ のメッセージ / ログ / `terminal_reason` のいずれにも、PII と再利用可能な秘密を載せない。** `terminal_reason` は運用者が読む場所であり、`payload` は PITR の保持期間ぶん残る。
- **保証範囲は「載らない・永続化されない」であって「DO の境界を出ない」ではない。** 宛先メールアドレスと生トークンは**送信材料 RPC の応答として境界を越え、配送の瞬間だけ consumer のメモリに載る。** どこにも永続化されないことと、**鍵が DO の中から出ないこと**（射程は次のバレット）が保証の実体である。「境界を出ない」と読むと、consumer 側のログ方針や秘密管理を緩める根拠に使われる。
- **DO の中から出ないのは、宛先の復号鍵・リセットトークンの導出鍵・`providerIdempotencyKey` の導出鍵の3つである。** canonical を全長 HMAC へ写す**写像鍵は bucket 選択のために request Worker 側（stub 選択アダプター）にあり、DO の中には無い**（正本は `spec/database/index.md`「窓キーの導出」）。これは本 PR 以前からの帰属であり、本 PR はそれを窓キー導出の前提として明示しただけである。**無限定に「HMAC 導出鍵は DO の中から出ない」と書かない** — 書くと (i) 窓キーの導出を DO 側へ寄せる案（`claimWindow` に canonical を渡す形。論点11 B）への導線になり、(ii) 写像鍵が request Worker の秘密であることが `.dev.vars.example` の帰属表（#51）から落ちる。
- **`owner_token` は再利用可能な秘密である。** `(event.id, owner_token)` の対を握れば送信材料 RPC が `send` を返すので、対そのものが「宛先と生トークンを引ける持参人証」になる。それでも Queue メッセージと DLQ に載るのは、**呼び出しガードを成立させるために必要な明示的な例外**だからであり、上の禁止則が緩むわけではない。例外の代償として、次の2条が掛かる。
  - **Queue メッセージをログへ出さない** — 個々の項目だけでなくメッセージ全体を出さない。**ログに載せてよいのは `event.id` と `type` までである。**
  - **DLQ のメッセージを外部の監視基盤・ログ集約先へ転送しない。** 転送する設計を足すなら、`.adr/013` の判断へ戻る。
- **Queue メッセージは宛先 DO の routing key を運ぶ。粒度の定義本体は下の「Queue メッセージ」が持ち、ここでは繰り返さない**（重複させると片方だけが伸びて割れる）。衛生規則としてここで確認するのは、**その粒度が個人を指さない**こと — したがって禁止項目（`userId`）と衝突しない — の1点だけである。**ただし User Data DO のイベントを足すと、その routing key は `userId` そのものになりうる。** 初期のイベント型は0件なので今は潜在的だが、規則として残す — **User Data DO のイベントを足すときは、routing key の扱い（`userId` を Queue に載せるか、別の不透明キーへ写すか）を同時に決める。**

## 配送の性質

- **at-least-once である。** relay の相2（publish）と相3（`published` への落とし込み）のあいだで DO がリセットすると、lease 満了後に同じ行が再 claim され再 publish される。**consumer は `event.id` を基準に冪等化する。**
- **順序保証は無い。** 同じイベント型のあいだでも、異なるイベント型のあいだでも、発行順に届く保証は無い。**イベント間の順序に依存する設計を書かない** — 順序はイベントではなく状態機械の phase と CAS 条件で表現する。
- **exactly-once を前提にしない。** 同じ通知が複数回届きうることを受け入れる。
- **冪等性キーの保持先は consumer ごとに全数表で宣言する。** 単一の共有ストア（processed-events）を前提にしない。**新しい consumer を足すときは、この欄を埋めることが条件である。**

## 送信材料 RPC

consumer は event payload から送信内容を組み立てず、**発行元 DO へ RPC して送信材料を取得してから provider を呼ぶ。**

`send` が持つのは**宛先・生リセットトークン・`providerIdempotencyKey`** の3つである。**URL の組み立てとメール本文のレンダリングは `MailSender` アダプター（request Worker）の責務**であり、DO はテンプレートも base URL も持たない。DO の中に閉じるのは**復号と HMAC 導出**であって、レンダリングではない（`CLAUDE.md` の「CPU-bound work は request Worker」。レンダリングを DO へ寄せると、バケット共有 DO の直列化キューをその分だけ余計に占有する）。

### 応答の全数

**応答は2分岐のタグ付きユニオンであり、これが全数である。**

| 分岐 | 内容 | consumer の振る舞い |
|---|---|---|
| `send` | 宛先・**生リセットトークン**・`providerIdempotencyKey`（**本文は載らない** — 上のとおり組み立てとレンダリングは `MailSender` アダプター側） | provider を呼び、ack する |
| `nothing-to-send` | **理由を1つも載せない空である** | no-op して ack する。**失敗ではない** |

- 未登録 / SSO 専用 / 消費済み / 期限切れ / より新しい発行に置き換えられた、のいずれであっても**同じ `nothing-to-send` が返る。**
- **「なぜ送らなかったか」を consumer 側に残さない。** 応答は consumer のログにも DLQ にも落ちうるので、理由を載せると宛先の登録有無が DO の外へ漏れる（列挙オラクル）。運用の追跡が要るなら DO 側の観測に閉じる。
- **`providerIdempotencyKey` は DO が `event.id` から決定的に導き、`send` の応答に載せる。** 導出鍵は DO 側にあり consumer では導けないので、表の列にもせず、consumer にも鍵を配らない。

### 呼び出しガード

生トークンは行の `payload` が持つ `tokenId` から導かれる。**`event.id` は Queue メッセージと DLQ を通って DO の外へ出るので、この RPC が無条件だと「`event.id` を知る者 = リセットリンクを引ける者」になる。** したがって**応答が `send` になるのは次の3条件がすべて成り立つときだけである。**

1. その `event.id` の行が `outbox_events` に**存在する**
2. 行が `quarantined` **でない**
3. 呼び出しが持つ**不透明な `owner_token` が行の値と一致する**

1つでも満たさない呼び出しは `nothing-to-send` を返す（**理由は返さない**）。`event.id` と `owner_token` の対は Queue メッセージが運ぶ。

**RPC が受け取るのは `event.id` と `owner_token` の2つだけであり、これが全数である。`tokenId` は行の payload から DO が読むので引数に取らない。**

- **行の `owner_token` が `NULL` の呼び出しは、引数の値にかかわらず常に不一致として扱う**（`password_reset_tokens.change_auth_token` と同じ規則）。`owner_token` が `NULL` になるのは正常系で頻出する2状態 — `enqueueEvent` の INSERT 直後から最初の claim までと、上限未到達の失敗で `pending` へ戻された後から次の claim まで — であり、**そこを `NULL` 同士の一致として通す実装は「`event.id` を知る者が送信材料を引ける」ことを意味する。** 引数側の `owner_token` も、**欠落・空文字・規定長（128 bit）未満は照合の前に不一致として扱う。**
- **`status` は照合条件に入れない。** 配送は at-least-once であり、consumer が Queue からメッセージを受け取って RPC を打つのは relay が `published` へ落とした**後**である。`status = 'publishing'` を条件にすると**正常系の配送が全滅する。二重送信の抑止は `status` ではなく `providerIdempotencyKey` が担い、役割を混ぜない。**
- **同一性の判定は `owner_token` が単独で負う。** 再 claim が起きれば `owner_token` は書き換わるので、古い Queue メッセージを持った consumer の呼び出しは 3. で弾かれて `nothing-to-send` に落ちる。
- **`outbox_events` は終端へ落とすときも `owner_token` を `NULL` にしない**（`jobs` と分離する規約。database/index.md）。落とすと 3. が `published` の行に対して必ず失敗する。

**`owner_token` の生成要件**（`jobs` の「claim した実行主体の識別子」という読みを `outbox_events` では採らない。こちらは行ごとの capability である）:

- **claim ごと・行ごとに一意である。** 同じ起床で claim した複数の行に同じ値を書かない。行をまたいで共有すると、DLQ に落ちた1件の `owner_token` と、Queue / DLQ を通る他行の `event.id` を組み合わせるだけで他行のガードを通せる。
- **暗号論的乱数から生成し、時刻・連番・DO 識別子から導かない。** 導出可能な値は 3. を推測で通せることを意味する。
- **長さの下限は 128 bit。**

**持参人証の露出窓の上限。** **露出窓は `published` 行の保持期間で上から押さえられているわけではない。** prune はジョブランナーの起動末尾でしか走らないので、**終端行しか残っていない DO は定義上 `deleteAlarm()` 済みで起床せず、保持期間を過ぎた `published` 行が次の投入まで残る。** ただし**実効的な上限はリセットトークンの TTL である** — 行が残っていても、TTL を過ぎたトークンについては送信材料 RPC が `nothing-to-send` を返すので宛先も生トークンも引けない。**「行の存在」は `published` の保持期間では有界でなく、「引ける材料」は TTL で有界である。**

### 運用値の制約

**2本あり、これが全数である**（実値の確定は #38）。

1. **`Queue の最大 retry 期間 + DLQ の保持期間 < リセットトークンの TTL`.** これは**機能要件**である — 満たしていれば、DLQ 滞在の末期に再駆動しても**リセットトークンがまだ TTL の内側にあり、有効なリンクを届けられる。** **`DLQ の保持期間 < TTL` とだけ書くとこの帰結が導けない** — 再駆動の時点でトークンが経過しているのは DLQ の滞在時間だけではなく、その前に Queue が retry を焼き切るまでの時間も含むからである。**この制約は `(event.id, owner_token)` の持参人証に対する防壁ではない**（防壁は衛生規則の禁止則2条と、DLQ そのものへの到達制御。到達制御の実体は #38）。
2. **`Queue の最大 retry 期間 + DLQ の保持期間 ≤ published 行の保持期間`.** 呼び出しガードの 1.（行の存在）を要求する以上、prune が行を消した後の DLQ 再駆動は必ず `nothing-to-send` になる。

**2本は左辺が同じ `Queue の最大 retry 期間 + DLQ の保持期間` で、上限として置く相手だけが違う**（リセットトークンの TTL と `published` 行の保持期間）。相手は独立に決まる運用値なので片方から他方は導けない。**「配送の運用値の制約は2本で全数」は動かない。**

**片方だけを書くと、値の決定者が両立しない2値を選べてしまう。** 2. を落とすと再駆動が恒久的に空振りし、その形は運用上ほとんど検出できない。

**この2本は「配送の」運用値についての全数である。** スロットル窓の長さと窓行の `expires_at` の猶予はこの全数の**外側**の別の運用値であり、正本は `spec/database/index.md` の `reset_request_windows` の節が持つ（値の決定者は同じく #38）。「2本で全数」を根拠に窓の運用値まで無いと読まない。

## 配送機構の契約と責務

### Queue メッセージ

- 載せるのは `event.id` / `type` / `payload` / **宛先 DO の routing key**（送信材料 RPC の宛先を選ぶための鍵。**relay が publish 時に押す項目であり、行にもドメイン payload にも無い**）/ 呼び出しガードが照合する `owner_token` の**5項目**である。
- **routing key の粒度は次のとおりであり、これが正本である。** Queue メッセージが運ぶ routing key は、**発行元 DO 自身の locator** である（Identity Directory では `_meta.self_locator` と同じ `dir:g{世代}:b{番号}` の bucket 名。多数の利用者で共有される粒度なので個人を指さない）。**クレデンシャル単位の内部キー（canonical の全長 HMAC）は載せない** — 窓で切れない仮名になり、`aggregate_id`（窓キー）を外した理由（DLQ 上での宛先相関）をそのまま無効化する。
- **`payload` は現時点で読み手を持たない** — consumer は業務判断を持たず、`tokenId` は行の payload から DO 自身が読む（送信材料 RPC は `event.id` と `owner_token` しか取らない）。載せるのは将来の consumer と DLQ 上での型別の切り分けのためであり、衛生規則（PII と再利用可能な秘密を載せない）が同じく掛かる。
- **PII と再利用可能な秘密は載せない**（`owner_token` は上の衛生規則が定める明示的な例外である）。
- **メッセージの各項目は `outbox_events` の行の値をそのまま使い、Queue 側で組み立て直さない。運ぶのは上に列挙した5項目だけで、行の他の列は載せない** — メッセージは行の写しではない。**特に `aggregate_id`（窓キー）は載せない。** 同一アドレス・同一窓に対して安定した仮名なので、載せると DLQ 上で複数のメッセージを同一の宛先へ相関させる材料になる。

### consumer の一覧と責務

**初期は mail consumer の1つだけである。**

| consumer | 対象 `event.type` | 責務 | 置き場 |
|---|---|---|---|
| mail consumer | `identity.passwordResetRequested` | 送信材料 RPC を打ち、`send` なら provider を呼ぶ／`nothing-to-send` なら no-op する。どちらでも ack する | request Worker の `queue()` ハンドラ |

- **宛先の解決・トークンの生存確認・supersede の判定・冪等キーの導出は、すべて DO 側にある。** consumer は業務判断を1つも持たない。
- **したがって relay / mail consumer / DLQ ハンドラの層帰属はアダプターである**（`.adr/013`）。台帳の行は `spec/inventory/adapter.md` にだけ立ち、`spec/inventory/usecase.md` には足さない。**判断が無いものはユースケースではない。**

### consumer の置き場

- **consumer と DLQ ハンドラは request Worker の `queue()` ハンドラに置く。Worker は request / state の2本のままである。**
- **メール provider の秘密の帰属が state Worker から request Worker へ移る**（`.dev.vars.example` の追記は #51）。
- 同居させても判定規則2 は空文化しない — そこで言う「独立」は実行責任の独立だからである。物理的に分けたくなったときは Worker を1本足せばよく、その判断は運用の材料が出てから #38 が行う。

### 責務分界と DLQ

**境界は「Queue に入る前か後か」の1本だけである。**

| 失敗の位置 | 記録先 | 状態 | operator 導線 |
|---|---|---|---|
| relay が Queue へ publish できない（binding 障害・payload 不正） | 発行元 DO の `outbox_events` | `quarantined` + `terminal_reason` | DO の operator 専用 maintenance 経路（quarantine の一覧・再駆動） |
| consumer が処理に失敗する | Queue の retry → DLQ | Queue 側の管理 | DLQ ハンドラ |

- **`published` は「Queue へ渡した」の意味であり、「処理された」ではない。**
- **発行元 DO へ ack を書き戻さない。** 書き戻すと、書き戻し自体が at-least-once で失敗しうるため三段目の隔離先が要り、DO が「配送されていない」と「処理されていない」の2つの状態を持つことになる。
- **operator 導線は2つである** — DO の maintenance 経路と DLQ ハンドラ。**end-to-end の配送は1箇所で観測できない**ので、運用手順（#38）とマニュアルテストの両方でこの2箇所を明示する。

### fail-closed の DO と DLQ の相互作用

**2つの向きがあり、挙動が非対称なので両方を書く。**

- **DO 側**: fail-closed で止まっている DO は relay もしない（migration ゲートで戻るので relay パスに到達しない）。outbox 行は滞留するが、**失われた配送ではない** — 行は残り、コードが揃った次の起床で流れる。
- **Queue 側**: fail-closed になる**前に** publish 済みのメッセージは Queue に残っている。consumer がそれを処理しようとすると、送信材料 RPC が migration ゲート（database/index.md により全 RPC エントリの先頭に掛かる。例外は診断2本だけ）で `SystemError` を返し、**retry を焼き切って DLQ へ落ちる。** デプロイのスキュー期間に限られる。**復旧は DLQ の再駆動である。**

## `CLAUDE.md` / `spec/database/index.md` との役割分担

- **全数表を持つのは本ファイルだけである。** `kind` / `event.type` を足すときに直すのは、本ファイルの表1つである。
- **`CLAUDE.md` は判定規則と本ファイルへの参照だけを持ち、識別子（`event.type` / `jobs.kind`）を1つも列挙しない。** 開発規約の正本であって台帳ではない。
- **`spec/database/index.md` は物理形だけを持つ** — `jobs` / `outbox_events` / `reset_request_windows` の列と索引、CAS と収束規則、backoff、lease、prune、Alarm の多重化。同ファイルに残る `kind` の言及は再武装する5種と収束規則の例示であって、全数ではない。

## 分類の差し戻し条件

**[P-001] `identity.passwordResetRequested`（旧 `send-mail`）の Outbox 分類.** 送信材料 RPC の往復により、**consumer が実際に担うのは provider 呼び出し1回だけ**で、送信材料の解決・宛先の有無・トークン生存の再確認はすべて DO へ戻る。判定規則2 の「実行責任を独立した consumer へ委譲する」に照らすと、**委譲されている責任は薄い。**

- 実装（#51）で RPC 往復のコストが想定を超えた場合、**判定規則3（完了責任が Identity Directory bucket 自身にある）を根拠に local job へ差し戻すことが規則上は可能である。**
- そのときは Outbox に載るイベントが0件になるので、`outbox_events` を置くこと自体の是非まで戻ることになる。
- 差し戻すなら、上の「分類の変更には実行責任の所有者に基づく理由が要る」に従って理由を書き、本表と `.adr/013` の両方を同時に直す。
- **あわせて不変条件「local job はすべて DO ローカルで完結する」も同時に撤回する。** 差し戻した先の `kind` はメール送信（外部 I/O）を行うので、撤回せずに差し戻すと規則と不変条件が両立しなくなる。**撤回は3点セット**（本表の行 / 不変条件 / `.adr/013`）であり、どれか1つを落とさない。
