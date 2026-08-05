# 実装計画 — Issue #50: [設計訂正] User Data DO + DOローカルOutboxへ移行し、ドメインイベント配送を維持する

**Issue:** #50
**作成日:** 2026-08-05
**複雑度:** 中〜大規模
**実装方針:** steps.md

---

## 目的

`.adr/004` が下した「Outbox / domain events / relay / consumer / DLQ を全面廃止し、すべての非同期処理を `jobs` + Alarm へ置き換える」という決定のうち、**ドメインイベント配送の廃止だけを訂正する**。User Data DO / Identity Directory DO への集約（`.adr/002`）と FTS5 単独検索・同期更新（`.adr/003` / `.adr/005`）は維持したまま、業務データ更新・FTS5 projection・`outbox_events` の追加を同じ DO SQLite transaction で確定し、DO Alarm を relay の起動契機として Queue → consumer → DLQ へ at-least-once で配送する構成を、永続 ADR と `spec/` と `CLAUDE.md` の正本として確定する。

## 前提（計画の土台）

- **成果物はドキュメントのみ。** プロダクションコード・wrangler 設定・DB migration には一切触らない。
- **`main` の `spec/` は既に「Outbox は無い」を絶対形で断言している。** 改訂は「Outbox の記述を直す」ではなく「断言を書き換え、`jobs` 一本の記述の中に第2の経路を割り込ませる」作業になる（`research.md` §5.5 が全数）。
- **`main` のコードには D1 時代の Outbox 実装がまだ残っている**（`domain/common/event.ts` / `application/ports/outboxRepository.ts` / `worker/cloudflare/{relay,consumer,pruner,dlq}.ts` の**4本** / `processed_events` テーブル ほか）。**既存実装として扱わず**、新しい spec を書くときの参照材料としてだけ使う。実装は #51。
- **新 ADR の番号は `.adr/013`**（`main` の連番は `012` まで）。

## 受け入れ基準

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `.adr/013-*.md` が存在し、`.adr/004` の「Outbox / domain events / relay / consumer / DLQ の全面廃止」を supersede すると本文で明示している。`.adr/002` の DO 集約と `.adr/003` の FTS5 単独検索を維持すると明示している | 受け入れ条件1 | 1 |
| AC-2 | `.adr/013` が Issue 本文の4案（(1) 各業務 DO に Outbox + Alarm relay ＝採用 / (2) 専用 Outbox DO / (3) すべて `jobs` + Alarm / (4) transaction 内で外部 I/O）をすべて比較し、不採用理由を書いている | 対応項目1 | 1 |
| AC-3 | `.adr/004` と `spec/adr/005` の**ステータス節にだけ**注記が足され、コンテキスト・決定・代替案・影響の各節は改変されていない（`git diff` で確認可能）。`.adr/004` の注記は**第3項に加えて第2項の「外部 I/O を伴う処理は必ずこちらに載る」という十分条件も失効させ**、機構そのもの（永続ジョブと Alarm）と第1項は有効と書いている（`adr.md` AD-12）。**訂正（レビュー5周目・B-001）: 失効側の列挙に、決定の「リード文」（「Outbox / relay / consumer / DLQ を廃止する」）を加える。** 項番だけを名指しした形だと、リード文が失効側にも有効側にも現れないまま「第1項と第2項の残りは有効」と閉じた形で宣言されるので、**注意深く読むほど「Outbox 廃止は生きている」という失効済みの結論に到達できる**（`adr.md` AD-51）。**判定条件そのもの（ステータス節にだけ注記が足され、本文は無改変であること）は動かない** | 対応項目1 | 2 |
| AC-4 | `spec/adr/005` が検索 indexer 復活の根拠に使えないことが同ファイルに明記されている | 対応項目1 | 2 |
| AC-5 | 3類型（同期実行 / Outbox event / local job）を**実行責任の所有者**で判定する順序つき規則が `spec/async/index.md` と `CLAUDE.md` の両方にあり、外部 I/O であることと cross-DO RPC であることが**単独では Outbox の条件にならない**と明記されている | 受け入れ条件9・10 | 3, 19 |
| AC-6 | `spec/async/index.md` の全数表に、すべての `event.type` とすべての `jobs.kind` が**ちょうど1回**現れる。同じ処理が2類型に現れる行が無い | 受け入れ条件9 | 3, 21 |
| AC-7 | 全数表が **owner DO / 実行責任者 / 発行点・投入点 / consumer / fan-out 有無 / payload / 冪等性キーとその保持先**の各欄を持ち、空欄が無い | 対応項目2 | 3, 21 |
| AC-8 | 全数表が**「由来（旧 `jobs.kind`）」欄**を持ち、Outbox 行（`identity.passwordResetRequested`）の同欄に **`旧 send-mail`** と書かれている。`purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `reindex` / `migrate-bulk` / `rotate-encryption` / `finalize-withdrawal` / `resume-link` / `resume-signup` / `resume-credential-change` / `sweep-orphan-mapping` の11種が local job 行として存在し、由来欄は自分自身の名前である。**判定は「旧 `jobs.kind` 12種の集合 = 全数表の由来欄の集合」で行う**（`send-mail` はもう `jobs.kind` ではないので、識別子欄では突き合わせられない） | 受け入れ条件12 | 3, 5 |
| AC-9 | 分類の変更に「実行責任の所有者に基づく理由」が要ることが規則として書かれている | 受け入れ条件12 | 3 |
| AC-10 | `outbox_events` の共通 schema が `spec/database/index.md` に定義され、**event ID / type / payload / attempt / next attempt / published・quarantined 状態 / lease / 作成・完了時刻 / 保持期間**をすべて持つ。**作成時刻は `created_at` という独立の列**であり、`occurred_at`（ドメインが決めた発生時刻）で兼ねていない | 対応項目2 | 4 |
| AC-11 | `outbox_events` が User Data DO と Identity Directory DO の**それぞれの SQLite** に置かれ、専用 Outbox DO を作らないことが明記されている | 受け入れ条件4 | 1, 4 |
| AC-12 | 業務データ更新・FTS5 projection・`outbox_events` の追加が**同じ `transactionSync`** で確定することが `spec/database/index.md`（L29 の書き込み単位）・`spec/usecases/*` の共通事項・`CLAUDE.md` の3箇所で一致して書かれている | 受け入れ条件3 | 4, 9, 19 |
| AC-13 | Alarm が Outbox の代替ではなく **relay の起動契機**であることが明記され、`setAlarm(min(jobs, outbox))` と `alarm()` 内の順序（再武装 → migration ゲート → relay パス → jobs パス → 張り直し）、各パス独立の件数上限、両表が空のときだけ `deleteAlarm()` する規則、**lease 中の行（`running` / `publishing`）を `max(next_run_at, lease_until)` で算入する規則**が定義されている | 受け入れ条件5・13 | 5 |
| AC-14 | relay の3相（トランザクション内 claim → トランザクション外 publish → トランザクション内 finalize）が定義され、**Queue publish 直後に DO がリセットした場合に再送されること**が at-least-once の根拠として明記されている | 受け入れ条件7・14 | 5 |
| AC-15 | Outbox と `jobs` で**共通化する規約**（Alarm scheduler / backoff / lease / prune）と**分離する規約**（同一性と収束の有無 / 配送状態の値域）が明示的に列挙されている | 対応項目2 | 4, 5 |
| AC-16 | domain event / event draft の契約が `spec/domains/` に復元され、**イベント登録口が1つに固定**されている（UoW コンテキストの `enqueueEvent`。ドメインポートにしない） | 対応項目2 | 6, 9 |
| AC-17a | イベント登録口とスロットル窓ストアの追加に伴い、非集約ストアの全数（**7→9**）と書き込み口の全数（**6ストア7メソッド→8ストア9メソッド**）が、**数を書いている実在の5行すべてで**更新されている — `spec/database/index.md` L79 / L749 / L753 / L754 と `spec/domains/identity.md:378`（`grep -rn '非集約ストア' spec` の全**9**ヒットのうち数を書いている5行。残る4件は分類の話。`adr.md` AD-16） | 対応項目2 | 4, 6 |
| AC-17b | `CLAUDE.md:68` は登録点の**列挙**に `enqueueEvent`（両 DO クラス）が、非集約ストアの roster の**Identity Directory DO 側の列挙**に `resetThrottleStore` が加わり、**数の委譲文（`The per-table roster, and its count, lives in spec/database/index.md.`）はそのまま残っている。** `CLAUDE.md` に数を書き足していない | 対応項目2 | 19 |
| AC-18 | ドメインポートの同期契約の例外が `PasswordHasher` / `MailSender` の**2つのまま**であり、relay がドメインポートになっていない（`spec/domains/index.md:34` / `spec/domains/identity.md:369`） | 対応項目2 | 6 |
| AC-19 | 定義されたイベントがすべて consumer を持つ。consumer 不在かつ明示的な監査要件も無いイベントが1つも定義されていない。**User Data DO のイベント型が初期0件であること**が全数表に明示されている | 受け入れ条件11 | 3, 6, 7 |
| AC-20 | イベント payload に PII と再利用可能な秘密を載せない規則が定義され、ログと `terminal_reason` にも同じ制約が掛かっている。`send-mail` について、メールアドレスと生リセットトークンが payload・Queue メッセージ・DLQ・ログのいずれにも出ない経路が定義されている。**保証範囲が「載らない・永続化されない」であり、「DO の境界を出ない」とは書かれていない**（宛先と生トークンは送信材料 RPC の応答として境界を越える。`adr.md` AD-6）。**送信材料 RPC の呼び出しガード**が明記されている — 応答が `send` になるのは **1. event 行が存在し 2. `quarantined` でなく 3. 呼び出しの `owner_token` が行の値と一致する**ときだけであり、**`status` は照合条件に入れない**（at-least-once では consumer は relay が `published` に落とした後に到達するので、`status='publishing'` を条件にすると正常系が全滅する。二重送信の抑止は `providerIdempotencyKey` が担う。`adr.md` AD-6）。あわせて **`outbox_events` は終端時に `owner_token` を `NULL` にしない**（`jobs` と分離する規約）ことと、運用値の制約2本（`DLQ 保持期間 < トークン TTL` / `Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間`）が書かれている。**訂正（レビュー4周目・B-003）: 制約1 の左辺は `Queue 最大 retry + DLQ 保持期間` である。`DLQ 保持期間 < トークン TTL` とだけ書くと、同じ節が宣言する機能要件が導けない。判定条件そのもの（制約が2本であること）は動かない。** | 受け入れ条件15 | 3, 4, 5, 8 |
| AC-21 | FTS5 の更新が同期処理のままで、検索用イベントも indexer consumer も定義されていない。`spec/scenario/search.md:18` / `spec/domains/search.md:174` / `spec/usecases/search.md:74` の「反映待ちは存在しない」が3つとも残っている | 受け入れ条件8 | 7, 11 |
| AC-22 | 日本語・1〜2文字クエリ・topic 絞り込み・ゴミ箱除外の FTS5 要件（`spec/requirements.md` §4.4）が改訂前と同一である | 対応項目2 | 10, 21 |
| AC-23 | 要件に「検索インデックスは同一トランザクションで即時整合」「外部副作用とイベント配送は結果整合・at-least-once・順序保証なし」が**分離して**定義されている | 対応項目2 | 10 |
| AC-24 | Outbox 配送が at-least-once・順序保証なしであり、consumer が `event.id` を基準に冪等化されること、および**冪等性キーの保持先が consumer ごとに全数表で宣言される**ことが定義されている。mail consumer の `providerIdempotencyKey` が **DO 側で導出され送信材料 RPC の応答で渡される**（`outbox_events` の列ではない）ことが書かれている。**送信材料 RPC の応答が `send` / `nothing-to-send` の2分岐で全数であり、`nothing-to-send` が理由を載せない空であること**が `spec/` に書かれている（`superseded` / `no-recipient` という識別子が `spec/` に1件も現れない。`adr.md` AD-6） | 受け入れ条件7・対応項目2 | 3, 5 |
| AC-25 | poison / quarantine（発行元 DO 側）と Queue DLQ（consumer 側）の責務分界が「Queue に入る前か後か」の1本で定義され、それぞれの再駆動と operator 導線が書かれている。発行元 DO へ ack を書き戻さないことが明記されている | 対応項目2 | 4, 5 |
| AC-26 | `spec/inventory/` 4台帳（domain / usecase / adapter / test）が DO ローカル Outbox + local jobs 構成へ同期されている。`ADP-outbox-events-001` / `-002` と `ADP-reset-request-windows-001` が存在し（schema 行 22→25）、`ADP-jobs-001` / `-002` の列数・種別数・収束規則の記述と `ADP-credential-mappings-001` の濫用抑止の列挙が訂正されている。**relay / mail consumer / DLQ ハンドラの層帰属がアダプター層であることが1行で書かれ、`spec/inventory/usecase.md` に行が足されていない**（`adr.md` AD-17） | 対応項目2 | 12, 13, 14, 16 |
| AC-27 | transaction rollback / Alarm relay / Queue 再配送 / consumer 冪等性 / 順序逆転 / DO reset / backoff / lease / quarantine / DLQ / 再駆動 / prune のテストケースが `spec/testcases/` に定義されている | 受け入れ条件14 | 15 |
| AC-28 | マニュアルテストに Outbox backlog / quarantine / DLQ / 再駆動の確認手順が**既存カテゴリー `spec/manual-tests/account.md`** へ追加され（`adr.md` AD-20）、`spec/manual-tests/index.md` の件数表（`account.md` の行と合計）・spec バージョン行・L41 の実行記録テンプレートが更新されている。**新規カテゴリーは作らないので `spec/index.md:16` の「7カテゴリ」は改訂前後で不変**であり、`git diff` でその語が変わっていないことを確認できる | 対応項目2 | 17, 18 |
| AC-29 | `CLAUDE.md` の「Asynchronous execution contract」項1（`There is no domain-event transport.`）が3類型の判定規則へ差し替えられ、Outbox の項が Key concepts に追加され、`Reference runtime` の `no Queues` が訂正され、`Migration in progress` の節が **#51 だけを指し、`#37` という識別子を1件も含まない**（歴史は #37 の gh コメント側に置く。`adr.md` AD-21。これにより AC-35 と機械検査8 が例外条項なしで成立する） | 対応項目2・受け入れ条件2 | 19 |
| AC-30 | `spec/index.md` の成果物一覧・ADR 表・テーブル数（L25 の「User Data DO 16 テーブル / Identity Directory DO 5 テーブル」→ **17 / 7**。Identity Directory 側は `outbox_events` と `reset_request_windows` の2つが増える。`adr.md` AD-16）・テストケース件数（L15 / L26 の「54ユースケース・838ケース」）・マニュアルテスト件数（L16 / L27 の 204）が改訂後の実体と一致している。**ユースケースに属さない `spec/testcases/async/` が1ファイル増えたことが数え方の表記に出ている**（`adr.md` AD-15） | 対応項目2 | 18, 21 |
| AC-31 | #37 / PR #49 / #38 / #10 / #51 のそれぞれに、本 Issue での扱いを記録したコメントが付いている。#51 に本 Issue への依存が明記されている（既存本文で満たしている場合はその確認を記録する） | 受け入れ条件16・17 | 20 |
| AC-32 | 本 Issue の PR の差分が `.adr/` / `spec/` / `CLAUDE.md` / `.thread/50/` だけで、`packages/` / `apps/` / `infra/` / `*.toml` / migration SQL を1行も含まない（`git diff --name-only main` で確認可能） | 受け入れ条件18 | 22 |
| AC-33 | `pnpm lint` と `pnpm format:check` が通る | 受け入れ条件19 | 22 |
| AC-34 | **配送機構の契約と責務**が `spec/async/index.md` に定義されている — (a) Queue メッセージに載せるもの／載せないもの（宛先 DO の routing key を運ぶこと、PII と秘密を載せないこと）、(b) consumer の一覧と各 consumer の責務（初期は mail consumer 1つ）、(c) consumer の置き場が **request Worker の `queue()` ハンドラ**であること（`adr.md` AD-13）、(d) DLQ の扱いと operator 導線2本（DO の maintenance 経路 / DLQ ハンドラ）、(e) **fail-closed の DO へ送信材料 RPC を打った consumer が DLQ へ落ちること**（デプロイのスキュー期間に限る。復旧は DLQ の再駆動） | 受け入れ条件6 | 3, 5, 19 |
| AC-35 | **有効な `spec/` と `CLAUDE.md` に、CLOSED 済みの #37 を指す能動的な参照が1件も残っていない。** `grep -rn '#37' spec CLAUDE.md \| grep -v '/review/'` の**19件**（`spec/database/index.md` 10 / `CLAUDE.md` 5 / `spec/domains/identity.md` 1 / `spec/inventory/adapter.md` 1 / `spec/testcases/export/exportAllData.md` 1 / `spec/manual-tests/search.md` 1）がすべて #51 / #38 / #44 / #45 のいずれかへ付け替えられているか、参照ごと削除されている | 受け入れ条件2・16 | 5, 7, 14, 15, 17, 19, 21 |
| AC-36 | **「別ストアへ配送する経路は持たない」系の無限定の断言が0件である。** 判定は**総数の一致では行わない**（`adr.md` AD-22）。`grep -rn '配送する経路\|通知する経路\|外部 transport' spec \| grep -v '/review/'` は改訂前 **9件**、改訂後 **4件**を返す — **6箇所**（`spec/domains/index.md:35` / `spec/domains/memo.md:14` / `spec/domains/search.md:216` / `spec/usecases/memo.md:14` / `spec/usecases/knowledge.md:16` / `spec/usecases/identity.md:10`）を限定形へ直すが、そのうち5箇所は**指定文に置き換えると grep 対象の語句そのものが消える**ため、生き残るのは `spec/domains/search.md:216`（「外部 transport」を残して検索ドメインへ限定）だけである。判定は2本立て — (1) 無変更3件（`spec/database/index.md:162` / `spec/domains/trash.md:266` / `spec/inventory/adapter.md:45`）が `git diff` で1文字も変わっていない、(2) 改訂後の残存4件のいずれにも無限定の断言が無い。**限定形へ直した6箇所は同じバレットに `spec/async/index.md` への参照を持つ**（`memo.md` を含む。イベントを定義しないドメインでも「では誰が配送するのか」を1ホップで辿れるようにする） | 受け入れ条件2 | 6, 7, 9, 21 |
| AC-37 | **`requestPasswordReset` の4ケース経路一致と連打の窓比例が要件とテストの両方に落ちている。** (a) `spec/usecases/identity.md` に「**同じ窓の状態に対して4ケースは一様に落ちる — その窓での最初の依頼なら4ケースとも必ずちょうど1行、既に発行済みの窓なら4ケースとも1行も書かない。分岐の材料は窓ストアの状態だけで、登録有無・認証方式・宛先の存在を参照しない**」が要件として明記されている。(b) `spec/testcases/identity/requestPasswordReset.md` の**末尾に3ケースが append** されている — (i) 同一 canonical・同一窓へ2回依頼 → 有効なリンクを含むメールが1通（0通でも2通でもない）**かつ1通目のリンクが2回目の依頼後も有効である**（2回目は `issue()` を呼ばないので未使用トークンが置き換わらない。`adr.md` AD-7）、(ii) 新旧2件が逆順で consumer へ届く → 新しいほうが送信され古いほうは `nothing-to-send` で no-op、(iii) **未登録アドレスへ同一窓で2回依頼しても、測定対象が登録済みの場合と一致する。測定するのは (1) `outbox_events` の行数、(2) `reset_request_windows` の行数、(3) Alarm の起床の有無、(4) `sweep-reset-tokens` の投入の有無 の4つであり、「総書き込み行数」では測らない** — 登録済み側は `password_reset_tokens` の発行行を追加で書くので総数では一致しない（この非対称は `main` の spec にも既にある）。**訂正（レビュー2周目・W-005）: (b)(i) の「1通（0通でも2通でもない）」には射程がある。** 数えているのは**その窓で発行される有効なリンクの回数**であって、受信通数の上下限ではない（配送は at-least-once なので同じリンクのメールが複数回届きうる）。したがってケース (i) の前提には**その窓のイベント行の配送が正常であること**（`quarantined` にも DLQ にも落ちない）が付き、0通は配送が `quarantined` / DLQ へ落ちた場合にだけ生じる**運用側の失敗**である（正本は `spec/usecases/identity.md`「連打と窓」と `spec/database/index.md`「`reset_request_windows`」の窓内隔離の項）。**判定条件そのもの（3ケースが末尾に append されていること）は動かない。** | 受け入れ条件12・14 | 8, 15, 16 |
| AC-38 | **スロットル窓ストアが定義され、`jobs.kind` が11種のまま動いていない。** `spec/database/index.md` に `reset_request_windows`（Identity Directory DO）が定義され、キーが canonical の全長 HMAC + 窓で**登録の有無に関係なく行を作る**こと、掃除が既存の `sweep-reset-tokens` に同居すること、`credential_mappings.last_reset_requested_at` を落とすことが書かれている。全数表の `sweep-reset-tokens` の用途欄が「トークン行と窓行の両方の削除」になり、**投入点欄が「リセットトークン行または窓行を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」へ広がっている**（宛先の登録有無で投入を分けない。`adr.md` AD-16）。`.adr/010` の「正本の表と各投入ユースケースの両方に書く」に従い、同じ1文が `spec/async/index.md` / `spec/database/index.md` / `spec/usecases/identity.md` の3箇所にある。**`jobs.kind` は11種のまま動かない** | 対応項目2・受け入れ条件12 | 3, 4, 5, 8, 14 |
| AC-39 | **スロットル窓ストアのドメイン側契約が定義されている。** `spec/domains/identity.md` に `PasswordResetThrottlePort` の節があり、メソッドは `claimWindow(windowKey, now): boolean` の**1つだけ**（窓の最初の依頼なら行を作って `true`、既存なら `last_requested_at` を更新して `false`）で、判定と計上が分かれていない。`spec/inventory/domain.md` に対応する `DOM-identity-*` 行が append されている。同期契約なので `spec/domains/index.md:34` の Promise 例外は2件のまま動かない（`adr.md` AD-19） | 対応項目2 | 7, 12 |
| AC-40 | **`spec/usecases/identity.md:205` が条件付きに改訂されている。** 「発行はそのクレデンシャル宛の未使用トークンをすべて置き換える」という全置換の規則は維持したまま、**発行が起きるのは窓での最初の依頼のときだけ**であることが前提条件として書かれ、2回目以降の依頼は何も発行せず既存の未使用トークンを有効に保つと明記されている（`adr.md` AD-7）。**「L205 は無改訂で残す」という旧指示は撤回されている** | 受け入れ条件12・14 | 8, 15 |

## スコープ

### 含まれないもの

- **DO ローカル Outbox / Alarm relay / Queue consumer / binding / migration の実装** — #51 が行う。本 Issue は設計の確定まで。
- **PR #49 のコードを改修・取り込む作業** — クローズ済みの履歴として残す。参照はしてよいが、本 Issue の差分には入れない。
- **`main` に現存する D1 時代の Outbox 実装（`domain/common/event.ts` / `outboxRepository.ts` / `relayTrigger.ts` / `eventRelayWorker.ts` / `worker/cloudflare/{relay,consumer,pruner,dlq}.ts` / `processed_events` ほか）の削除・改修** — 同上。
- **検索 indexer consumer の復活** — FTS5 は同一トランザクションでの同期 projection のまま（`.adr/003` / `.adr/005`）。
- **ベクトル検索・意味検索・Vectorize・embedding・RRF の再導入** — `.adr/003` を維持する。
- **Outbox を専用 DO へ集約する構成** — `.adr/013` で不採用として記録するだけ。
- **exactly-once 配送とイベント間の順序保証** — at-least-once・順序保証なしを明示的に選ぶ。
- **`docs/runtime_cloudflare.md` / `docs/backend_implementation_example.md` / `docs/test.md` の書き換え** — #38（運用文書）と #51（実装例）の担当。本 Issue の受け入れ条件は `spec/` と `CLAUDE.md` に限定されている。
- **`README.md` の書き換え** — 現状の「D1 + Queues + Outbox」という記述は、**コードが D1 のままなので実物と一致している**。#51 完了後に #38 が同期する。
- **`.thread/34/design.md` の改訂** — #34 の作業ログ。`.adr/013` と `spec/async/index.md` を新しい正本にし、**`.adr/013` の中で第7.3 / 7.4 / 7.6 / 7.7 / 1.4 の5節の該当項を訂正した旨を宣言する**（`adr.md` AD-12。steps.md ステップ1 の「影響」と同じ全数であり、両者はこの5節で一致していなければならない）。**第7.6節は部分失効**で、境界の規則（トランザクションの中で外部 I/O をしない）と所有者・生トークン非搭載は有効なまま、「ダミージョブ行を書く」「スロットル中でもジョブ行は必ず書く」「同じ canonical への連打は `operationKey` でジョブ行1本に収束する」の3点だけを失効させる。
- **`spec/*/review/**` / `spec/review/cross-phase/**` の改訂** — 日付つきのゼロベースレビュー記録で追記型。旧 Outbox 前提の記述が残っているが記録なので直さない。
- **#45（cross-DO saga の自動回収）/ #44（鍵ローテーション）/ #13（OAuth `jti`）が持ち越している未決事項** — 本 Issue で決めない。
- **relay / consumer / DLQ の運用値（batch size / lease / retry 上限 / 保持期間）の確定** — #38 が定める。本 Issue は「値を持つこと」と「何を測って決めるか」まで。

## リスクと注意点

- **`send-mail` の Outbox 化が既存の安全性設計を壊しうる（最大のリスク）。** 現行の `send-mail` は (i) 登録済み / 未登録 / SSO 専用 / スロットル中の4ケースで処理経路を完全に一致させ（列挙オラクル対策。`spec/usecases/identity.md:203`）、(ii) 同一 canonical への連打を1行へ収束させ（`:208`）、(iii) 生トークンを載せず bucket の中で導出する（`:206`）。**Outbox は「1イベント1行・不変」なので (ii) をそのままの形では移せず、consumer は DO の外なので (iii) が素朴には成立しない。** `adr.md` AD-6 / AD-7 / AD-16 が、(ii) を「行の一意制約」から「**Identity Directory DO の専用窓ストア（`reset_request_windows`）を読むスロットル判定** + 送信時の再読」へ置き換える形で解いている。改訂時にこの3性質が落ちていないかを `spec/testcases/identity/requestPasswordReset.md` の該当ケースで必ず検証する（AC-37）。**特に「同一窓へ2回依頼 → 有効なリンクを含むメールが1通届く（0通でも2通でもない）」を新しいケースとして足す** — 旧 AD-7（`dedupe_key`）はここで0通になることが検出されて撤回された。**あわせて未登録アドレス側でも同じ計測をする** — 窓ストアを `credential_mappings` に相乗りさせる案は、未登録 canonical に行が無いために「登録済みは2回目以降書かない／未登録は毎回書く」となり、(i) を AD-7 自身が破ることが検出されて却下された（AD-16）。登録済み側だけを見るテストではこの破れを検出できない。
- **数え上げの同時修正義務。** 1つ直して1つ取り残す破れが `.thread/34/design.md` 第1.4節に4ラウンド分記録されている。**改訂で一斉にズレる数と、その実在箇所（実ファイルで確認済み）は steps.md ステップ21の「同時修正リスト」が全数を持つ。** ここでは所在だけを挙げる — テーブル数 / 非集約ストア数（5行）/ 非集約ストアの書き込み口 / `jobs` の列数と種別数 / 収束規則の「残る7種」/「ユースケースから投入する8種」/ 類型の数 / `spec/inventory/adapter.md` の schema 行数 / テストケース件数と slug 数 / マニュアルテスト件数。**スロットル窓ストアの新設（`adr.md` AD-16）がこのうち4つ（テーブル数・非集約ストア数・書き込み口・schema 行数）に追加で効く**ので、`outbox_events` のぶんだけを足した値で止めない。
- **`spec/inventory/test.md` の `#L{n}` アンカー。** テストケースファイルの途中に行を挿入すると、その下の全行のアンカーが狂う。**新規ケースは各表の末尾に append する**（同ファイル L5–7 の欠番規約）。
- **「反映待ちは無い」は3ファイルではなく7箇所ある。** 上流の3つ（`spec/scenario/search.md:18` / `spec/domains/search.md:174` / `spec/usecases/search.md:74`）に加えて、`spec/manual-tests/search.md:19` と `:154`、`spec/testcases/search/search.md:35`、`spec/inventory/test.md:707` にも同じ主張がある（**`grep -rn '反映待ち' spec | grep -v '/review/'` の全数 = 7。除外前の全ヒットは8件で、8件目は `spec/manual-tests/review/002.md:46` — 改訂対象外のレビュー記録である**）。**7箇所とも「検索については反映待ちが無い」を維持し、Outbox への言及を足すのは manual-tests の1箇所だけにする**（ステップ17）。片方だけ書き換えると乖離する。
- **`spec/domains/search.md:216` のグローバルな断言**（「外部 transport（キュー・ワーカー）は登場しない」）。**検索ドメインについてのみ真**へ限定しないと、Outbox 復活と正面衝突したまま残る。
- **`spec/domains/export.md:289` の「非同期は採用しない」**。export は同期生成のまま正しいが、再確認の1文を足さないと陳腐化して読める。
- **`.adr/010` の失効範囲は「正本の表の所在」だけでは足りない。** `jobs.kind` の全数表を `spec/async/index.md` へ移すので移設の宣言が要るのに加えて、`.adr/010` の決定にある「**外部プロバイダへ渡す冪等キーの導出**は生成 ID では成立しない」という項も帰属が変わる（AD-8 で `jobs` の関心事でなくなり、新しい導出元は生成 ID である `event.id` なので論法が反転する）。`.adr/013` が両方を宣言しないと、`.adr/010` を読んだ人が失効した論拠に到達する。
- **CLOSED 済みの #37 を指す能動的な参照が19箇所ある。** `CLAUDE.md` の「Migration in progress — #37」（L124 / 126 / 129 / 132）と L66 だけでなく、`spec/` 側に14箇所ある（内訳は AC-35）。どれも「これから誰かがやる」を宣言している参照なので、放置すると存在しない前提を指す文書になる。
- **consumer を request Worker に置く決定は、秘密の帰属を1件動かす。** `apps/web/.dev.vars.example` が宣言している秘密は `SESSION_SECRET` の1件だけで、メール provider の秘密は現時点でどこにも宣言されていない。現行 spec では `MailSender` を呼ぶのが DO の Alarm ジョブ（= state Worker）なので、**今日の帰属は state Worker 側である。** 本 Issue は `apps/web/` に触れない（AC-32）ので、帰属の変更は `.adr/013` の「影響」と #51 の引き継ぎとしてだけ書く（`adr.md` AD-13）。
- **`outbox_events` と `reset_request_windows` が 10 GB のストレージ上限を食う。** 後者は**未登録アドレス宛の依頼でも行が増える**ので、掃除（`sweep-reset-tokens` に同居）が止まると伸び続ける。 `spec/requirements.md:143` と `spec/database/index.md:20` の「本体データと全文検索インデックスの合計で見る」という数え方が不完全になる。
- **PITR で巻き戻すと `published` の行が `pending` に戻り、再 relay で重複配送になる。** at-least-once なので正しさは壊れないが、`spec/database/index.md` の PITR チェックリストに項目が要る。
- **fail-closed で止まっている DO は relay もしない。** outbox 行が滞留するが、**失われた配送ではない**（コード更新後の起床で流れる）ことを明記しないと、滞留を障害と読み違える。

## テスト方針

本 Issue は成果物がドキュメントのみなので、検証はテストコードではなく **(a) 記述の相互整合の機械検査** と **(b) `spec/testcases/` / `spec/manual-tests/` へのテスト方針の定義** の2本立てになる。

### (a) 本 Issue の PR に対する検証

- **全数表の相互整合検査。** `.thread/34/design.md` 第1.4節と同型の awk / grep ベースの検査を、新しい全数表に対して走らせる。**番号は steps.md ステップ21 の検査番号と一対一で対応させる**（別番号で呼ぶと「機械検査12」がどちらを指すか判別できなくなる）。検査項目:
  1. `spec/database/index.md` が言及する `kind` の集合が、`spec/async/index.md` の全数表に現れる `jobs.kind` の集合の**部分集合**である（差集合が空）。**一致ではなく部分集合で見る** — 移設後の `spec/database/index.md` には再武装5種と収束規則の例示しか残らないので、一致で検査すると恒常的に落ちて誰も見なくなる。**`spec/database/index.md` 自身が「`jobs.kind` ではない」と名指ししている識別子は集合から除外する** — `rotate-remap` と operator 専用 maintenance 経路の RPC 名6つの**計7つが除外の全数である**（除外を書かずに回すと差集合が `{rotate-remap}` になり false red を出す。**下の「集合演算の除外規則」は検査 2 / 4 / 5 / 15 に掛かるもので、この除外とは別物である**）
  2. 同じ識別子が2つの類型に現れない
  3. 発行点・投入点の欄に空欄が無い
  4. 全数表の `event.type` が `spec/domains/` のイベント定義と1対1で対応する
  5. 全数表の各 `event.type` に consumer 欄が埋まっている（AC-19 の機械検査）
  6. **同時修正リスト（steps.md ステップ21）の数を、宣言箇所と実体の両方からコマンドで出して比較する**（注記に数を書き写す形は採らない — `.thread/34/design.md` I-8）
  7. **維持すべき記述の非変更検査.** `git diff` で `spec/scenario/search.md:18` / `spec/domains/search.md:174` / `spec/usecases/search.md:74` / `spec/requirements.md` §4.4 / `spec/index.md:16` の「7カテゴリ」が変わっていないことを確認する
  8. `grep -rn '#37' spec CLAUDE.md | grep -v '/review/'` が0件（AC-35。**例外条項は置かない** — 歴史的言及も含めて `CLAUDE.md` から識別子を落とす。`adr.md` AD-21）
  9. `spec/` 本文に `send-mail` を `jobs.kind` として扱う記述が1件も残っていない（`jobs` 節と `spec/inventory/adapter.md` に `send-mail` の文字列が無い）
  10. `provider_idempotency_key` が `spec/` のどこにも列として現れない（`jobs` からも `outbox_events` からも落ちたことの検査。`adr.md` AD-8）
  11. `CLAUDE.md` に `event.type` / `jobs.kind` の識別子が1つも列挙されていない（`adr.md` AD-14）
  12. **無限定の「配送する経路は持たない」が0件**（AC-36）。`grep -rn '配送する経路\|通知する経路\|外部 transport' spec | grep -v '/review/'` は改訂前 **9件**・改訂後 **4件**。**総数の一致では判定しない**（`adr.md` AD-22） — (1) 無変更3件が `git diff` で1文字も変わっていないこと、(2) 残存4件のいずれにも無限定の断言が無いこと、の2本立てで見る
  13. **応答分岐の識別子 `` `superseded` `` / `no-recipient` が `spec/` と `CLAUDE.md` に1件も現れない**（`adr.md` AD-6 で2分岐へ固定した。3分岐の記述が取り残されていないことの検査）。`superseded` はバッククォートで囲んだ識別子表記に限定して数える — 素の grep は ADR のステータス語に改訂前から8件ヒットし、別物である（steps.md の検査13 に詳述）
  14. **`last_reset_requested_at` が `spec/` のどこにも列として現れない**（`adr.md` AD-16 で落とした。現在は `spec/database/index.md:582` と `spec/inventory/adapter.md:27` の2件）
  15. **旧 `jobs.kind` 12種の集合 == `spec/async/index.md` 全数表の「由来」欄の集合**（AC-8 の判定。識別子欄では突き合わせられない）
- **集合演算の除外規則.** 検査 2 / 4 / 5 / 15 は全数表の行を集合として扱うが、**AC-19 が要求する「User Data DO のイベント型は初期0件」の行は識別子欄も由来欄も持てないので、4つの検査すべてから明示的に除外する。** 除外を書かずに回すと、0件行を集合に入れて空文字列のズレを踏む。除外対象はこの1行だけであり、それが全数である。
- **差分範囲の検査.** `git diff --name-only main` の出力が `.adr/` / `spec/` / `CLAUDE.md` / `.thread/50/` だけであること（AC-32）。
- `pnpm lint` / `pnpm format:check`。

### (b) 本 Issue が **定義する** テスト方針（実装は #51）

`spec/testcases/` へ以下を定義する。

- **原子性**: 業務データ更新・FTS5 projection・`outbox_events` の3つが同じ `transactionSync` で確定し、**rollback すると3つとも巻き戻る**。
- **relay**: 実行可能な行が `nextRunAt` 順に claim され、件数上限で打ち切られ、上限に達しても jobs パスが飢えない。
- **at-least-once**: Queue publish に成功した直後に DO がリセットしたとき、lease 満了後に**再 claim され再 publish される**（重複配送）。consumer が `event.id` で冪等に吸収する。**再 claim で `owner_token` が変わるため、古い Queue メッセージを持った consumer の送信材料 RPC は呼び出しガードで弾かれ `nothing-to-send` に落ちる**（`adr.md` AD-6）。これも `nothing-to-send` として ack され、失敗ではない。
- **順序逆転**: **窓をまたいだ**新旧2依頼が発行順と逆順に consumer へ届いたとき、**新しいほうは送信され、古いほうは送信材料 RPC が `nothing-to-send` を返して no-op になる**（`spec/usecases/identity.md:205` の「新しい発行が未使用トークンを全置換する」がこれを保証する。**同一窓では発行が1回しか起きないので、この経路は窓をまたいだときにだけ生じる**。`adr.md` AD-7）。最終状態は「有効なリンクを含むメールが1通届いた」である。**期待値は「`nothing-to-send` が返る」までであり、「なぜ送らなかったか」は期待値に書けない** — 応答は理由を載せない空の1値で、supersede と宛先不在を consumer 側で区別する手段は存在しない（`adr.md` AD-6）。**順序に依存しない期待値をここまで書き下ろす** — 書かないと #51 が「payload だけで組み立てる素朴な consumer」へ退化しうる。
- **backoff / lease**: publish 失敗で `attempt` が進み `nextRunAt` が先送りされる。`lease_until` を過ぎた `publishing` の行が再 claim される。
- **quarantine**: 上限超過で `quarantined` + `terminal_reason` になり、実行可能集合から外れる。**他の行の配送を止めない。**
- **DLQ**: consumer の連続失敗が Queue の retry を経て DLQ へ落ちる。
- **再駆動**: quarantine された行を operator 経路から `pending` へ戻せる。DLQ のメッセージを再投入できる。
- **prune**: 保持期間を過ぎた `published` の行が有界件数だけ削除される。`quarantined` の行は残る。
- **PII / 秘密の非露出**: `outbox_events.payload` / Queue メッセージ / DLQ / ログ / `terminal_reason` のいずれにもメールアドレス・生リセットトークン・`userId` が出ない。**宛先と生トークンが現れてよいのは送信材料 RPC の応答と provider へのリクエストだけであり、そこでも永続化されない。**
- **fail-closed と DLQ の相互作用**: fail-closed になる前に publish 済みのメッセージを consumer が処理しようとすると、送信材料 RPC が migration ゲートで `SystemError` を返し、retry を焼き切って DLQ へ落ちる。**デプロイのスキュー期間に限られ、復旧は DLQ の再駆動である**（DO 側に滞留している行が「失われない」のとは非対称な挙動なので、両方を書く）。
- **FTS5 の即時性の維持**: 投稿直後（待ち時間なし）の検索で必ずヒットする（`TC-search-033` を維持）。
- **`requestPasswordReset` の4ケース経路一致**（AC-37a）: 登録済み / 未登録 / SSO 専用 / スロットル中で、**同じスロットル窓の状態に対して4ケースが一様に落ちる** — その窓での最初の依頼なら**4ケースとも必ずちょうど1行**（0行でも2行でもない）、既に発行済みの窓なら**4ケースとも1行も書かない**。**窓ストアの行のほうは登録の有無に関係なく必ず作られる**（`reset_request_windows`。`adr.md` AD-16）。同じ起床が張られ、同じ応答が返る。**違いは行の中身だけ。** 発行するか否かを決めるのはスロットル窓の状態だけで、登録有無・認証方式・宛先の存在を参照しない（`adr.md` AD-7）。**未登録アドレス側でも書き込み行数と起床の有無が登録済みの場合と一致することを別ケースとして測る** — 登録済み側だけでは一致を検証できない。
- **連打の収束**（AC-37b）: 同一 canonical・同一窓への連打で、**書き込みと起床が依頼回数ではなく窓の数に比例する**（2回目以降はイベント行を書かない。窓ストアの行も窓ごとに1行で、2回目以降は同じ行への冪等な更新であり新しい行も起床も作らない）。**2回依頼したときに届くのは「有効なリンクを含むメール1通」であり、0通でも2通でもない。** あわせて **2回目の依頼が `PasswordResetTokenPort.issue()` を呼ばないこと**（= 1通目のリンクが2回目の依頼後も有効であること）を期待値に含める（`adr.md` AD-7）。呼んでしまうと1通目のリンクが死に、旧 `dedupe_key` 案を撤回させたのと同じ破れが復活する。**訂正（レビュー2周目・W-005）: 上の「1通であり、0通でも2通でもない」には射程がある。** 数えているのは**その窓で発行される有効なリンクの回数**であって、受信通数の上下限ではない（配送は at-least-once なので同じリンクのメールが複数回届きうる）。**このケースが測るのは配送が正常な窓についてであり**、0通は配送が `quarantined` / DLQ へ落ちた場合にだけ生じる**運用側の失敗**である（正本は `spec/usecases/identity.md`「連打と窓」と `spec/database/index.md`「`reset_request_windows`」の窓内隔離の項）。
- **`sweep-reset-tokens` の投入の一様性**: 窓行を作る4ケースのどれでも `sweep-reset-tokens` が同じ形で投入される（宛先の登録有無で投入の有無が分岐しない）。**未登録アドレスだけを投げ続けた bucket でも窓行が掃除される**ことを、投入の有無として測る（`adr.md` AD-16）。
- **送信材料 RPC の呼び出しガード**: `published` に落ちた行に対する呼び出しが**通る**（`status` を照合しないことの検証。ここが通らないと正常系が1件も送られない）。`quarantined` の行、存在しない `event.id`、`owner_token` が一致しない呼び出しの3つは `nothing-to-send` になる。**prune で行が消えた後の DLQ 再駆動も `nothing-to-send` になる**ので、保持期間の下側制約（`Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間`）が満たされていることを運用値の前提として書く。

`spec/manual-tests/` へは、Outbox backlog の観測・quarantine 一覧・DLQ の確認・再駆動の実行手順を、**既存カテゴリー `account.md` に**追加する（新規カテゴリーを作らないので「7カテゴリ」は動かない。`adr.md` AD-20。**手段の実体は #38 が定める**という既存の書き方に揃える。`spec/manual-tests/trash.md:18–22` が先例）。**backlog の観測手順には fail-closed 由来の滞留の判別材料を1行入れる** — 「backlog が増えている DO の `schema_version` を診断エントリ（`read-schema-version`）で確かめる。コード側の期待より大きければ fail-closed による滞留であり、配送の失敗ではない（デプロイを進めれば流れる）」。書かないと運用者が滞留を障害と誤診する。

## 未解決事項

レビュー4周を経てもなお残る事項だけを書く。**3周目で決着した論点（送信材料 RPC の呼び出しガード / 窓が消費済みのときのトークン発行 / `sweep-reset-tokens` の投入点 / マニュアルテストの追加先）はここに残っていない** — それぞれ `adr.md` AD-6 / AD-7 / AD-16 / AD-20 が決定として持つ。

- **[P-002] `(event.id, owner_token)` の対が「送信材料を引ける持参人証」になる。**
  - 経緯: 呼び出しガードから `status` 照合を外した（`adr.md` AD-6）ことの直接の帰結である。照合を残すと **relay が `published` へ落とした後に来る consumer が全弾きになり、リセットメールが1通も送られない**ので、外す以外の選択肢が無かった。露出窓は lease の長さから `published` の保持期間へ広がる。対は Queue メッセージと DLQ を通るので、**DLQ を読める運用者はその窓のあいだリセットリンクを引ける。**
  - **訂正（レビュー4周目・W-007）: 露出窓を「`published` 行の保持期間ぶん」と量らない。** **露出窓は `published` 行の保持期間で上から押さえられているわけではない。** prune はジョブランナーの起動末尾でしか走らないので、**終端行しか残っていない DO は定義上 `deleteAlarm()` 済みで起床せず、保持期間を過ぎた `published` 行が次の投入まで残る。** ただし**実効的な上限はリセットトークンの TTL である** — 行が残っていても、TTL を過ぎたトークンについては送信材料 RPC が `nothing-to-send` を返すので宛先も生トークンも引けない。**「行の存在」は `published` の保持期間では有界でなく、「引ける材料」は TTL で有界である。**
  - **訂正（レビュー1周目・論点5 → `adr.md` AD-36 / AD-37）。** 当初この項は「**実効的な防壁は運用値の制約（`DLQ 保持期間 < リセットトークン TTL`）1本**」と書いていたが、レビューで**制約1は防壁ではない**ことが判明したため撤回する。不等式が意味するのは「DLQ に滞在しているあいだの再駆動が、まだ有効なリンクを届けられる」ことだけで、**持参人証そのものを無効化しない** — したがって制約1は**機能要件**であり、防壁の勘定に入らない（`.adr/013` の 6. と「影響」も同じ形へ直っている）。**防壁は次の2本で構成する。**
    1. **`owner_token` を到達させない禁止則**（論点1 A-1 = `adr.md` AD-36。正本は `spec/async/index.md` の衛生規則）— (i) **Queue メッセージ全体を含めてログへ出さない**（載せてよいのは `event.id` / `type` まで）、(ii) **DLQ のメッセージを外部の監視基盤・ログ集約先へ転送しない。**
    2. **DLQ への到達制御** — 誰が DLQ を読めるかを絞ることそのもの。**運用の設計であり #38 が持つ。**
  - 引き継ぎ: #38 は、(a) **`Queue 最大 retry + DLQ 保持期間 < トークン TTL`** を**機能要件として**満たすこと（満たしても持参人証は無効化されないので、これを防壁として数えないこと。**露出窓を短く保つのは `published` の保持期間ではなくトークンの TTL であり、休眠 DO では行そのものが保持期間を超えて残る**）、(b) **防壁2（DLQ への到達制御）を運用手順として実際に設計すること** — 値の決定と同じ担当に閉じており、置き忘れると防壁が禁止則1本だけになる。**引き継ぎ (a) の左辺は訂正（レビュー4周目・B-003）による** — 当初は `DLQ 保持期間 < トークン TTL` と書いていた。#51 は `owner_token` を再 claim ごとに必ず更新し（`adr.md` AD-4）、古い対が無効化される二次的な絞りを実装で落とさないこと。**DLQ のメッセージを外部の監視基盤へ転送する設計を足すなら、禁止則 (ii) の撤回に当たるので `adr.md` AD-36 / AD-37 へ戻ること。**

- **[P-003] 運用値の3制約が同時に満たせる値域の実在を、本 Issue では確認できない。**
  - 経緯: `.adr/013` が置く制約は **`Queue 最大 retry + DLQ 保持期間 < リセットトークン TTL`**（`adr.md` AD-6 の 3.）と `Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間`（同 4.）の2本で、これに Cloudflare Queues の retry / DLQ 保持期間の**プラットフォーム側の下限・上限**が外側から掛かる。**訂正（レビュー4周目・B-003）: 制約1 の左辺は当初 `DLQ 保持期間` だけと書いていた。** **2本は左辺が同じ `Queue 最大 retry + DLQ 保持期間` で、上限として置く相手だけが違う**（リセットトークンの TTL と `published` 行の保持期間）。相手は独立に決まる運用値なので片方から他方は導けず、**制約が2本で全数であることも不等式の方向も動かない。**本 Issue は成果物がドキュメントのみで、`wrangler.toml` にも運用値にも触らない（AC-32）ため、**プラットフォーム側の実際の可変域を確かめる手段が計画の中に無い。** 制約の向きと全数までを書いて渡す形で止めた。
  - 引き継ぎ: #38 が値を確定する際に、まず Queues の retry 上限と DLQ 保持期間の可変域を実測し、**3制約が同時に満たせないことが判明したら AD-6 の 3./4. へ差し戻す**（`published` 保持期間を延ばす、DLQ を使わずに consumer 側で quarantine する、などの再設計が要る）。#51 は実装時に、この2制約を設定値のバリデーションとして表現できるかを検討する。

- **[P-004] AC-36 の判定 (2)「残存ヒットに無限定の断言が無い」は完全には機械化できない。**
  - 経緯: 限定形へ直す6箇所のうち5箇所で grep 対象の語句そのものが消えるため、**総数の一致では判定できない**（`adr.md` AD-22）。総数を保つように書きぶりを歪める案は、検査のために本文を不自然にするので採らなかった。残るのは「改訂後の4件それぞれが失効済み・検索インデックス限定・検索ドメイン限定のいずれかであること」を目で確かめる部分である。
  - 引き継ぎ: 目視の範囲は**4件で有界**であり、その全数が AC-36 に名指しされている。実装フェーズではこの4件だけを確認し、**5件目が出たら改訂側のミスとして扱う**（新しい無限定の断言が生まれたか、直したはずの箇所が直っていない）。件数が増えたときにだけ人が考える形にしてある。

- **[P-005] リンクスキャンによる使い捨てリセットトークンの先読み消費。**
  - 経緯: リセットリンクは生トークンを URL に載せて届く。**メール事業者・セキュリティ製品のリンクスキャンがそのリンクを踏むと、利用者が到達する前に `verifyAndConsume` が走ってトークンが消費される** — 使い捨てトークンの契約と正面から当たり、利用者には「リンクが無効です」だけが見える。base URL をリクエスト由来にしない規則（レビュー4周目・W-013）とは別の露出面である。
  - 本 Issue で決められない理由: 対策（消費点を GET から POST へ移す / 中間確認画面を挟む / トークンの消費を確認操作まで遅らせる）はいずれも **presentation とユースケースの再設計を伴う**。本 Issue は成果物がドキュメントのみで実装に触れない（AC-32）ため、画面と消費点の設計をここで確定させられない。**新規 Issue は起こさない** — 実装の担当が既に #51 に立っている。
  - 引き継ぎ: **#51** は画面と消費点の設計時にこの経路を明示的に扱う（あわせて、リセット画面からの Referer 送出の抑止と、リダイレクト時にトークンを引き継がないことも presentation 側の要件として持つ）。**#38** は provider を選定する際にリンクスキャンの有無と挙動を確認する。

- **[P-006] `jobs` の収束規則 (2)(3) が `pending` へ戻す行の `completed_at` を定めていない（`main` から継承・本 PR の射程外）。**
  - 経緯: `jobs.completed_at` の列定義は「`pending` / `running` では `NULL`」を不変条件として宣言しているのに、`done` / `poison` → `pending` の逆向き遷移を定める収束規則 (2)(3) は書く列に `completed_at` を挙げていない。したがって復帰した行は終端時刻を保持したまま `pending` になり、`jobs_completed_idx (status, completed_at)` を材料にした運用診断が嘘をつく。**再武装する5種は投入点からの再投入が唯一の再起動手段なので、規則 (3) を通る `done → pending` は平常運転で毎回起きる。**
  - **本 PR の射程外である根拠:** 規則 (2) は `main` の `spec/database/index.md` と逐語で同一であり、本 PR は1文字も触っていない。規則 (3) の差分は「残る7種 → 残る6種」と根拠の例示の差し替えだけで、書く列の集合には触れていない。**`main` から継承した既存の穴であり、本 PR が作った破れではない。**
  - **本 PR が直したもの:** 本 PR が新設した `requeue-quarantined-event` の節にあった「`attempt` の 0 復帰と `completed_at` の `NULL` 復帰は `jobs` の収束規則 (2) と同じ形である」という**誤った相互参照だけ**は本 PR の責任なので訂正した（レビュー5周目・B-002）。`outbox_events` 側は再駆動で書く4列に `completed_at = NULL` を明示的に含んでおり、閉じている。
  - 引き継ぎ: **#51** が `jobs` の逆向き遷移を実装する際に、`completed_at` を `NULL` へ戻す形で閉じる（`outbox_events` の再駆動と同じ形）。`spec/database/index.md` の収束規則 (2)(3) への追記は、`jobs` 側を触る Issue（#51 または #38 の運用診断の整備）で行う。**本 PR で直すと、`main` から継承した規則の本文を Outbox の PR が書き換えることになり、差分の射程が「Outbox 配送の設計訂正」から外れる。**

- **[P-001] `send-mail` の Outbox 化 — 契約設計として解決済み。差し戻し条件だけを引き継ぐ。**
  - 決着: `send-mail` は Outbox に載せる。**Issue が初期値としてそう決めているから従うのではなく、契約をそう設計したので成立する。** 当初の懸念は「Outbox の『1イベント1行・不変』が現行の連打収束と両立しない」ことだったが、`adr.md` AD-7 が収束の実体を**行の一意制約から DO の transaction 内のスロットル判定へ**移し、その窓の置き場を **AD-16 が Identity Directory DO の専用ストア `reset_request_windows` として確定**させ、最新性を **AD-6 の送信時再読（`nothing-to-send` 分岐）**で保つ形に組み直したことで、Outbox の契約を1つも曲げずに現行の3性質（4ケース経路一致 / 窓の数に比例する資源消費 / 生トークン非搭載）がすべて成立する。`dedupe_key` という逸脱は撤回した。**代償はテーブル1つ（窓ストア）であり、`jobs.kind` は 11 種のまま動かない**（掃除は `sweep-reset-tokens` に同居させた）。
  - 残るコスト: 配送1件あたり RPC が1往復増える。**consumer が実際に担うのは provider 呼び出し1回だけ**なので、AD-1 の判定規則2「実行責任を独立した consumer へ委譲する」に照らすと委譲されている責任は薄い（`adr.md` AD-6 の Consequences）。これは分類のコストとして `.adr/013` の「影響」に記録する。
  - 引き継ぎ: 実装（#51）で RPC 往復のコストが想定を超えた場合、**AD-1 の規則3（完了責任が Identity Directory bucket 自身にある）を根拠に local job へ差し戻すことが規則上は可能である。** その場合は Outbox に載るイベントが0件になるので、`outbox_events` を置くこと自体の是非まで戻ることになる。**全数表の `send-mail` 行に、この差し戻しの条件を注記として残す**（ステップ3）。
