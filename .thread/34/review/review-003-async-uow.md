# レビュー 003 — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design`
**主対象ファイル:** `.thread/34/design.md`（第7〜10章を中心に全文）/ `.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md`
**レビュー日:** 2026-07-30
**方針:** ゼロベース。前2ラウンドの指摘は前提にしない。Cloudflare / SQLite の公式ドキュメントを実際に取得して裏を取り、引用されている実装事実は実ファイル（および先行ブランチ `origin/issue/19/cloudflare-do-fts`）に当たって照合した。

## 非同期処理・UoW・migration

### Blockers

- **[B-001]** 外側チェックポイント予算の「累積経過時間10秒」は、Workers の `Date.now()` が I/O 時にしか進まないため CPU バウンドなジョブ列に対して発火しない。安全側論拠そのものが成立していない
  - 場所: `.thread/34/design.md:1085-1091`（bounded 処理の判定基準）/ `:1105-1112`（2階層の予算表と「CPU のほうが常に経過時間以下」）/ `:1348`（§9.2 が同じ値を `migrate-bulk` へ流用し「外側の累積10秒はチャンク間でしか評価できない」と述べる箇所）
  - 理由:
    - 公式（`/workers/reference/security-model/`）は **"The time value returned is not the current time. `Date.now()` returns the time of the last I/O. It does not advance during code execution."** と明記している。Spectre 緩和として意図的に凍結されており、Durable Objects もこの runtime の上で動く。
    - 本設計の支配的な失敗モードは「CPU 予算超過 → エビクションとリセット（例外は上がらない）」であり（第2.1節 #4 / #4b、`:1085`）、それを止める外側の保護は「ジョブ25件」と「累積経過時間10秒」の2つしかない。ところが `transactionSync` / `sql.exec()` は**同期**なので、`purge-trash` / `sweep-*` のようにローカル SQL だけで完結するジョブを25件連続で回しても `Date.now()` は1ミリ秒も進まない可能性がある。時間側の打ち切りは発火せず、実質「25件」だけが効く。
    - `:1112` の安全側論拠 —「**測っているのは経過時間であって CPU 時間ではない**ことを承知の上で、CPU のほうが常に経過時間以下であることを使って安全側に倒している」— は成立しない。成立するのは「CPU ≤ **実**経過時間」であって、`Date.now()` の差分は実経過時間ではなく**最後の I/O 時刻の差分**である。I/O 間に費やした CPU はこの測定値に現れないので、測定値が10秒未満であることは CPU が10秒未満であることを何も含意しない。
    - これは机上の懸念ではない。この2値は「先行案が採っていた値をそのまま引き継いだもの」（`:1112`）と明記されており、先行ブランチの実装は `apps/web/app/durable-objects/UserDataDurableObject.ts:514` で **`while (processed < 25 && Date.now() - startedAt < 10_000)`** と、まさに凍結する時計をそのまま使っている。#37 はこの形を引き継ぐ。
    - 第2.1節は「本節が設計の依拠する事実の正本である」と宣言しているが、**`Date.now()` の意味論の行が1つも無い**。#37 は公式保証だと誤認したまま実装できてしまう。
  - 提案:
    1. 第2.1節に行を足す。「`Date.now()` は最後の I/O の時刻を返し、コード実行中は進まない」（**公式記載**、出典 `/workers/reference/security-model/`）。効き先は 7.4 / 9.2。
    2. そのうえで外側の打ち切りを書き直す。選択肢は2つで、どちらかに倒す。
       - **(i) 時間軸を捨てる** — 外側を「ジョブ件数」だけにし、1ジョブあたりの上限は内側の行数上限に完全に委ねる。第7.4節 (iii) の行数上限を全 `kind` に義務化すれば、この形でも CPU は有界になる。
       - **(ii) 測定点を I/O へ固定する** — 「累積経過時間は `await ctx.storage.sync()` の直後にだけ再評価する」と定義し直す。第7.4節は既にチェックポイントごとの `sync()` を義務づけている（`:1091`）ので、チャンク境界を持つ `reindex` / `migrate-bulk` / `finalize-withdrawal` についてはこの形で時計が進む。ただし**チャンク境界を持たないジョブには測定点が無い**ので、(i) との併用が要る。
    3. `:1348` の「外側の「累積10秒」はチャンク間でしか評価できないので、内側の行数上限が無いと `migrate-bulk` に効く保護が実質的に存在しなくなる」は、上の結論に合わせて書き直す。現状は「外側10秒が効く」ことを前提に内側の必要性を導いているが、外側が効かないなら**内側の行数上限が唯一の保護**であり、それは1チャンクを縛るだけでチャンクの反復回数を縛らない。反復回数の上限も要る。
    4. `ctx.storage.sql.exec()` が clock を進める I/O に当たるかは公式に記載が無いので、第11.4節の spike 一覧（`transactionSync` のネスト可否 / `snippet()` と同じ枠）に足す。

- **[B-002]** `alarm()` 先頭で必ず alarm を武装する規則に対して、due job が無くなったときに alarm を**消す**手順が無い。文書中に `deleteAlarm` が1度も現れず、literal に実装すると全 User Data DO がチェックポイント予算間隔（10秒）で永久に起き続ける
  - 場所: `.thread/34/design.md:1093-1100`（Alarm の再設定規則）
  - 理由:
    - 新しい規則は「**`alarm()` の先頭で、仕事を始める前に…`now + チェックポイント予算` へ `setAlarm` し、続けて `await ctx.storage.sync()` で永続化を確認してから仕事を始める**」（`:1095`）である。つまり `alarm()` が走るたびに、必ず10秒後の alarm が**永続化まで確認された状態で**張られる。
    - 正常完了時の規則は「**DB の最早 `nextRunAt` へ張り直す**」（`:1099`）だけで、**最早 `nextRunAt` が存在しない場合が未定義**である。素直に「無ければ `setAlarm` を呼ばない」と実装すると、先頭で張った10秒後の alarm がそのまま残る。10秒後に `alarm()` が起き、先頭でまた10秒後を張り、due job ゼロで完了し、また残る —— **恒久ループ**になる。
    - 帰結は小さくない。`setAlarm()` 1回は1行の書き込みとして課金され（第2.1節 #24）、第10.2節は「コストの主要因は rows written」「`setAlarm` が算入される」を明示している。1ユーザーあたり毎日約8,600回の書き込みと、それに伴う DO の起動が、**一度でもジョブを走らせた全ユーザー分**、恒久的に発生する。同時に第7.5節が retention 方式の利点として掲げる「dormant な DO は Alarm でだけ起きる」も崩れる。
    - **これは先頭再武装へ倒したことで新たに生まれた穴である。** 先行ブランチは `finally` + `ensureAlarm()` 方式で、`ensureAlarm` は `nextRunAt() === null` のとき何もせずに return する（`apps/web/app/durable-objects/UserDataDurableObject.ts:648-656`）。プラットフォームが handler 起動時に alarm を消費する挙動に乗っていたので、idle 時に alarm が残らなかった。先頭で先に張る本設計はその前提を失っている。なお同ブランチは `deleteAlarm()` を明示的に呼ぶ経路も持っている（同 `:420`、`IdentityDirectoryDurableObject.ts:253`）ので、消す手段の存在自体は既知である。
  - 提案:
    - 第7.4節の再設定規則に1行足す。「**正常完了時、DB の最早 `nextRunAt` が存在しなければ `deleteAlarm()` する。** 先頭で張った予算 alarm を残さないことがこの規則の一部である」。
    - あわせて、第9.4節の fail-closed 経路（`:1375`）が「ジョブを実行せずに一定間隔で `setAlarm` を張り直す」＝**意図的に消さない**経路であることを対比として明記する。現状は「張り直しは第7.4節の…同じ規則に乗る」と書かれているので、第7.4節に削除規則を足すと矛盾して読める。fail-closed だけは例外である、と書き分ける。

### Warnings

- **[W-001]** OCC の変更行数を `SELECT changes()` で読む決定が未検証で、しかも #37 の spike 一覧に入っていない。workerd 上で実測があるのは棄却した側（`rowsWritten`）である
  - 場所: `.thread/34/design.md:1307`（第8.4節）/ `:1670`（新旧対比表）/ `:1700-1709`（第11.4節の未決事項一覧）
  - 理由: `rowsWritten` を棄却した論拠（公式に「索引の1行更新も追加の1行として数える」「最終値は SQL の課金に使われる」と定義されており、マッチ行数ではない）は公式ドキュメントと一致しており正しい。しかし先行ブランチの Cloudflare アダプターは**全箇所で `cursor.rowsWritten` を使って CAS を判定しており**（`packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts` の `assertCas` 12箇所、`identity-directory/store.ts:775,802`、`user-data/jobs.ts:221,249,272,366`）、workerd 上で通っている実測があるのはそちらである。`changes()` は core SQLite 関数なので動く公算は高いが、`sql.exec()` をまたいだときに直前の DML の結果を返すか（workerd が exec ごとに新しい prepared statement を用意する実装であっても connection 単位の `changes()` は保持されるか）は未確認である。OCC の正しさが直接これに懸かるのに、`transactionSync` のネスト可否や `snippet()` と違って「未確認」フラグも spike 割り当ても無い。
  - 提案: 第11.4節に「`sql.exec("SELECT changes()")` が直前の条件付き UPDATE のマッチ行数を返すこと」を #37 の着手時 spike として足す。あわせて第8.4節に代替を1つ書いておく — `UPDATE ... WHERE id = ? AND version = ? RETURNING 1` の行の有無で判定する形なら、課金単位でもグローバル関数の状態でもなく**その文が返した行**を見るので意味論が閉じる（先行ブランチも `INSERT ... RETURNING rowid` を使っており `RETURNING` 自体は動く実績がある）。

- **[W-002]** RPC 経路の「`enqueueJob` → `setAlarm`」の実行主体と原子性が未指定で、示されている回復策（次の DO 入力で再計算）が dormant な User Data DO には効かない
  - 場所: `.thread/34/design.md:1100`（通常の DO 入力での再設定規則）/ `:1192`（`UnitOfWorkContext.enqueueJob` の署名）/ `:1204`（「ジョブ投入は本体更新と同一 `transactionSync` に入っていなければ意味がない」）
  - 理由:
    - `enqueueJob` は `UnitOfWorkContext` の**同期**メソッドでトランザクション内に閉じる。一方 `setAlarm` はトランザクションの外である（`transactionSync` のコールバックは Promise を返せないので、素直には書けない）。**その `setAlarm` を誰がいつ呼ぶかが設計に書かれていない** — UoW プロバイダなのか DO facade のラッパーなのか、`run()` の戻り後どのタイミングかが不定である。
    - `:1100` の規則は「既存 alarm より早い場合だけ `setAlarm` する。…**設定に失敗したら次の DO 入力で DB から最早時刻を再計算する**」だが、この回復策は dormant な User Data DO には効かない。第7.4節自身が `finally` を棄却した根拠がまさにこれで（`:1095`「**dormant な User Data DO では次の DO 入力が来ないので、その `purge-trash` は恒久的に停止し、ゴミ箱の保持期限が誰にも気づかれずに無期限へ伸びる**」）、同じ穴が RPC 経路側に残っている。「利用者がメモをゴミ箱に入れて二度と戻ってこない」は典型ケースである。
    - 「既存 alarm より早い場合だけ」を素直に実装すると `getAlarm()` を読む必要があり、`@cloudflare/workers-types` 上は `Promise` を返す（先行ブランチも `getAlarm(): Promise<number | null>` として `await` している）。commit と `setAlarm` のあいだに `await` が入ると、書き込みバッファのフラッシュ単位が2つに割れうる。第2.1節 #28 の「すべての書き込みが保存されているか1つも保存されていないか」はバッファ内容についての保証であって、`await` を跨いだ2回のフラッシュを1単位にする保証ではない。第7.4節が `sync()` を義務づけた論拠がここにも同じ形で跳ね返る。
    - なお `getAlarm()` / `deleteAlarm()` の戻り値も alarms ページ（`number | null` / `void`）と storage API ページ（`Promise`）で食い違っている。第2.1節 #30 が `setAlarm` について記録している公式内不整合と同種であり、同じ扱いにするのが一貫する。
  - 提案:
    - 第7.4節に規約を1行置く。「**`run()` の戻り後、`await` を1つも挟まずに `setAlarm` を発行する**」。既存 alarm との比較が必要なら、`getAlarm()` を呼ばずに DO インスタンスのフィールドに現在の alarm 時刻を保持して比較する（DO は1インスタンス1ユーザーなので保持できる）。
    - 「設定に失敗したら次の DO 入力で再計算する」が dormant な User Data DO をカバーしないことを明記し、`purge-trash` の投入経路に限っては失敗時に RPC 自体を失敗させる（利用者にリトライさせる）か、`sync()` で確定させるかを断定する。
    - 実行主体（UoW プロバイダ / DO facade ラッパーのどちら）を第8.2節または第7.4節で名指しする。

- **[W-003]** `jobs` の `done` / `poison` 行を prune する処理に `kind` も所有者も割り当てられていない
  - 場所: `.thread/34/design.md:1083`（「`done` と `poison` は別々の保持期間で prune し、走査を bounded に保つ」）/ `:1061-1078`（`kind` の全数表）/ `:244` `:250`（第4.1.1節の `jobs` 行の `kind` 列挙）
  - 理由: 第7.4節は prune を要求しているのに、第7.4節の「`kind` の**全数**」表にも、第4.1.1節（「テーブルの全数と…列の全数の**両方の正本**」と宣言している表）の `kind` 列挙にも、prune ジョブが存在しない。User Data DO 側は `purge-trash` / `reindex` / `migrate-bulk` / `finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link` の6種、Directory 側は `send-mail` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-remap` / `rotate-encryption` の7種で、いずれも自分の仕事しかしない。ジョブランナー内でインラインに掃除するのか専用 `kind` を1つ足すのかが #37 に丸投げされており、どちらを採るかで第7.4節の claim 述語（`status='pending' OR leaseUntil < ?`）の索引設計が変わる。`sweep-reset-tokens` という「自 DO の期限切れ行を掃除する」ジョブが Directory 側に存在するのに、`jobs` 自身の掃除だけが無いのは非対称でもある。
  - 提案: 「ジョブランナーが1回の起動の末尾で保持期間切れの `done` / `poison` を N 行だけ削除する（専用 `kind` は置かない）」と断定するか、`prune-jobs` を両クラスの `kind` に足して第4.1.1節と第7.4節の両方を更新する。どちらでもよいが、全数の正本を名乗る表に載っていない処理を残さない。

- **[W-004]** `operationKey` の「同じキーの再投入は既存行に収束する」が、`kind` によって2つの異なる更新を意味してしまう
  - 場所: `.thread/34/design.md:1049`（`operationKey` の定義）/ `:1052`（`payloadDigest` 不一致は `ConflictError`）/ `:1123-1124`（`purge-trash` の投入と retention 変更時の張り直し）/ `:1148`（`send-mail` の連打が行1本に収束する）
  - 理由: `send-mail` では「収束」＝**重複を捨てて既存行を保つ**が正しい（同じ窓で2通目を送らないことが目的）。ところが `purge-trash` では、`trashRetentionDays` を短くしたとき（`:1124`「変更したトランザクションの中で…最早値を求めて Alarm を張り直す」）に**既存行の `nextRunAt` を早める**必要がある。同じ「収束する」という規則の下で、片方は既存行を保ち、片方は既存行を更新しなければならない。さらに `payload` が変わると `payloadDigest` が変わるので `:1052` の規則では `ConflictError` になる。#37 はどちらかの意味論しか実装できず、落ちたほうが黙って壊れる（`purge-trash` 側が落ちると retention 短縮が既存項目に効かず、`spec/testcases/trash/listTrash.md` の「遡及適用」期待が実際に破れる — 第11.1節 `:1593` が「結果は変わらない」と断定している箇所と直接衝突する）。
  - 提案: 第7.4節の `operationKey` の説明に、収束時の更新規則を1文で書く。たとえば「**再投入は `nextRunAt` を早める方向にのみ更新し、遅らせない。`payloadDigest` の照合は `nextRunAt` を除いた payload に対して行う**」と決めれば両方の用途が同じ規則で説明できる。

- **[W-005]** 第2.1節 #27 の裏付け種別が実態と合わない。「`transaction()` のコールバックを `async` にできる」は公式記載ではなく、禁止の記載が無いことによる推論である
  - 場所: `.thread/34/design.md:92`（第2.1節 #27 の「種別: 公式記載」）
  - 理由: `/durable-objects/api/storage-api/` を実際に取得して確認したところ、**「コールバックは同期で完了しなければならず、`async` 宣言も Promise 返却も不可」と明記されているのは `transactionSync()` の節だけ**である。`transaction()` の節は「Runs the sequence of storage operations called on `txn` in a single transaction…」と述べたうえで「Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically…」と続くだけで、コールバックが `async` でよいとは一言も書いていない。つまり #27 前半の「コールバックを `async` にできる」は **`transactionSync` にある禁止文が `transaction` には無い**ことからの推論であり、#4b（「Alarm が CPU リセットの契機に当たるか」）や #5（「namespace 列挙 API の不在」）で正しく行っている「記載の不在による推論」というラベルが必要な行である。第2.1節は「種別を取り違えると #35 / #37 が公式保証だと誤認する」ことを自ら理由に掲げているので、この1行だけラベルが緩いのは節の趣旨に反する。なお #27 後半（原子性の条件が `await` の不在の側にあること、`txn` が SQLite-backed では obsolete であること）は**逐語で公式のとおり**であり、第8.2.1節が (c) を棄却する論拠は #27 前半に依存していないので、結論は動かない。
  - 提案: #27 の種別を「公式記載（ただし『コールバックを `async` にできる』は禁止規定の不在による推論）」に分けるか、行を2つに割る。

- **[W-006]** 第7.7節の自己記述「上の5節はそれぞれ**冒頭に**「契約の正文は第7.7節」を持ち」が第8.4節について成立していない
  - 場所: `.thread/34/design.md:1155`（第7.7節の参照双方向性の宣言）/ `:1301-1309`（第8.4節）
  - 理由: 第7.3節（`:1022`）・第7.4節（`:1043`）・第7.6節（`:1130`）・第8.2節（`:1183`）はいずれも節の冒頭で正文を指しているが、**第8.4節は冒頭が「残す。」で始まり、正文への参照は節末（`:1309`）にある**。第7.7節はこの「冒頭に持つ」という性質を「規則を改訂するときは本節だけを直す」の担保として使っているので、実態とずれていると担保が1件分ゆるむ。実害は小さいが、この文書は自己記述の正確さで運用される設計になっている。
  - 提案: 第8.4節の冒頭に「（OCC の非リトライ方針の正文は第7.7節 項6）」を移すか、第7.7節の記述を「上の5節はそれぞれ第7.7節を正文として参照しており」に緩める。

### Notes

- **[N-001]** 第2.1節のプラットフォーム事実31件を公式ドキュメントに当たって照合したところ、**W-005 の1件を除いて全件が一致した。** とくに次の3点は、実際に公式内に存在する不整合を正しく捉えている。
  - #30 — `setAlarm` の戻り値が alarms ページで `setAlarm(scheduledTimeMs number): void`、storage API ページで `setAlarm(scheduledTime, options?): Promise` と食い違うこと。これを根拠に「`setAlarm` を `await` すれば永続化が確認できる」に依拠せず `ctx.storage.sync()` を唯一の手段とした判断（`:1097`）は正しい。`sync()` の定義（"Synchronizes any pending writes to disk." / pending write があればその完了時に解決）も逐語で一致した。
  - `:98` — Free プランの per-object 上限。limits ページの表は 10 GB を Workers Paid 列に置く一方、同ページの storage-full の本文は "(10 GB on Workers Paid, or 1 GB on the Free plan)" と書いており、表と本文が食い違うという指摘はそのとおりだった。account 合計が Workers Paid 無制限 / Free 5 GB であることも一致。
  - #3 — Alarm ハンドラの wall time 15分の出典が limits ページの "Wall time limits by invocation type" であり、**alarms ページには duration / wall time の記載が一切無い**こと。alarms ページを取得して確認したが、実際に一言も無かった。
  - このほか #1（`SQLITE_FULL` 時も読みと `DELETE` は成功）/ #2（1 DO 1 alarm・`setAlarm` は上書き・throw 時に2秒からの指数バックオフで最大6回）/ #4（既定30秒・最大5分・着信 HTTP / WebSocket ごとにリセット・超過でエビクションの可能性が高まる）/ #6（`ctx.id.name` の undefined 4条件、1,024 バイト、2026-03-15 以前の Alarm）/ #7 / #8 / #9 / #10（公式に載る SQLite 拡張は FTS5 本体 + `fts5vocab` / JSON / 数学関数の3つだけで、`bm25` / `snippet` / `highlight` / trigram は一語も無い）/ #15 / #16 / #17 / #18 / #19（`.overloaded` はリトライしてはならない）/ #20（PITR 30日・復旧単位は object 1個で SQL データと KV `put()` を含む DB 全体・ローカル開発では利用不可、`ctx.abort()` も `wrangler dev` では不可）/ #21（`exports` と `[[migrations]]` は排他で両方含む設定は検証で拒否・常に SQLite backend・ストレージ種別は不変・Trash 無し・`migrations` へ戻せない）/ #22（`waitUntil` は DO では効かない）/ #23（`blockConcurrencyWhile` は30秒でタイムアウトし DO をリセット）/ #28 / #29 / #31 をいずれも確認した。

- **[N-002]** 第7.1節の external-content FTS5 の実装制約2点は SQLite 公式（`sqlite.org/fts5.html`）と一致する。「旧値で delete → 新値で insert」は "In order to use this command to delete a row, the text value 'delete' must be inserted into the special column…**The values inserted into the other columns must match the values currently stored in the table.**" と対応し、`content_rowid` の既定が `'rowid'` であること、FTS5 が列値を要求するたびに `SELECT <content_rowid>, <cols> FROM <content> WHERE <content_rowid> = ?` で content テーブルを引くこと（→ surrogate 列を使うなら UNIQUE と索引が必須、という `:988` の帰結）も公式どおりである。`INTEGER PRIMARY KEY` が真の rowid alias で VACUUM でも再採番されないという `:987` の論拠も正しい。**「external-content で消えるのは `%_content`（容量）であって rows written の主要因（`%_data`）ではない」**（`:982`）という但し書きは、第4.6節・第10.2節のコスト見積りと矛盾なく噛み合っており、精度が高い。

- **[N-003]** 第8.2節が提示している同期 commit の型は、リポジトリ同梱の TypeScript（`node_modules/typescript` 6.0.3）で**実際に期待どおり動くことを実測で確認した。**
  - `run<T>(fn: (ctx: Ctx) => T extends Promise<unknown> ? never : T): T` に対し、`p.run(async () => "x")` と `p.run(() => Promise.resolve(1))` はいずれも `TS2322: Type 'Promise<string>' is not assignable to type 'never'` で拒否される。
  - 同期コールバックからは `T` が正しく推論される（`() => "hello"` → `string`、`() => ({ id: 1 })` → `{ id: number }`、`() => { return; }` → `void`）。条件型がパラメータ位置にあるため T の推論が `unknown` へ落ちて戻り値型が壊れるのではないか、という懸念は当たらなかった。
  - したがって第8.2.1節が (b)（`SemanticCommitPort` 方式）を棄却する論拠 —「同じ保証が `async` の排除だけで達成でき、しかもそちらのほうが強い（非 `async` 関数の中では `await` が構文エラーになる）」— は、この点について成立している。

- **[N-004]** 引用されている既存実装の事実は**照合した全件が実物と一致した。**
  - `packages/core/src/adapters/d1/unitOfWork.ts:39` の JSDoc "Read-your-write within the same UoW is unsupported by design"（行番号まで一致）/ `pendingBatch.ts` 98行 / `schema.ts:118` の `OCC_GUARD_CHECK_NAME = "occ_guard_positive"` / `repositories/helpers.ts:55-69` の `isOccGuardViolation` が `String.includes` で CHECK 名だけを照合し、コメント自身が degrade を自認していること。
  - `application/execution/unitOfWork.ts` 19行で `UnitOfWorkContext { userRepository; collectEvents }` と `run<T>(fn): Promise<T>` だけを持ち、スコープ引数が構造上存在しないこと。
  - `application/workers/` が `eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行の2本だけで consumer / DLQ を含まないこと。`apps/web/app/worker/cloudflare/handlers.ts` 138行で `handleQueue` が `:82`、`handleDlq` が `:120` にあること。
  - `application/ports/` に `outboxRepository.ts` / `relayTrigger.ts` / `idempotencyStore.ts` が実在すること。`application/errors.ts` の `SystemErrorCode` が6値で `ServiceOverloaded` / `StorageCapacityExceeded` を持たず、`RETRYABLE_SYSTEM_CODES` が `NetworkError` / `ExternalApiError` の2件であること。
  - `application/ports/sessionCodec.ts` が `issue(userId, now)` / `verify(token, now): Promise<{ userId } | null>` で epoch を運ぶ口を持たないこと。`di/types.ts` が `RequestContainer`（:53）と `WorkerContainer`（:70）の2つだけを定義し、indexer / pruner 専用コンテナが実装に存在しないこと。`presentation/errorResponse.ts:70` の `serializeError` と `:101` の `HTTP_STATUS_BY_KIND` が `kind` だけを見ること。
  - `adapters/d1/` が20ファイル / 2,514行、うちプロダクションコード8ファイル / 914行であること（第11.2節の数値と完全一致）。`spec/inventory/adapter.md` の distinct な `ADP-*` が85件であること。
  - 第2.1.1節が根拠に挙げる `.thread/19/spike/fts5.integration.test.ts` が先行ブランチに実在し、内容も記述どおりであること（「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件投入、`東京駅` で2件、2文字の `東京` で2件、`周辺` を `limit 1` で2ページに割って別項目が返る、スニペットに `<mark>` が入る）。先行ブランチの `packages/core/src/adapters/cloudflare/user-data/schema.ts:94` に `tokenize='trigram'`、`searchIndex.ts:465` に `bm25(search_fts, 3.0, 1.0)`、`:379` / `:451` に `instr(e.title, ?) > 0 OR instr(e.body, ?) > 0` が実在することも確認した（#11 / #12 と第7.2節の短語フォールバックの根拠が実在する）。
  - `:1112` の「外側の2値は先行案が採っていた値をそのまま引き継いだもの」も、先行ブランチ `UserDataDurableObject.ts:514` の `while (processed < 25 && Date.now() - startedAt < 10_000)` として実在する（ただし B-001 のとおり、その測定手段が問題である）。

- **[N-005]** AC-5 / AC-21 は本観点の範囲で満たしている。
  - AC-5 — 第7〜9章の ［Issue 要求］/［派生］節はすべて断定形で終わっている。第7.1節「**できる。**」/ 第7.2節「**成立する。**」/ 第7.3節「relay / consumer / DLQ / pruner をすべて廃止する」/ 第7.5節「各 User Data DO の Alarm に置き換える」/ 第7.6節「現時点で該当するのは**メール送信の1件だけ**である」/ 第8.2節「`run` を**完全同期**にする」/ 第8.2.1節「採るのは **(a)** である」/ 第8.4節「残す。」/ 第8.5節「戻せる。」/ 第9.2節「`blockConcurrencyWhile` は使わない」/ 第9.3節「**forward-only にする。**」/ 第9.4節「**fail-closed にする。**」/ 第9.5節「データのロールバックは**行わない**」。結論位置に「今後検討」「TBD」は無い。委譲を宣言しているのは ［参考］ ラベルの第7.2.1節だけで、plan の定義どおり。
  - AC-21 — 第3.1節が「**Account Home DO は採用しない。**」と断定し、3つの対価を理由として挙げている。第11.4節の未決事項表に Account Home は1度も現れない。
  - 第11.4節の6行はいずれも「結論に影響しない再確認」または「決着済みの決定に対する値決め」であり、非同期・UoW・migration の観点で #37 が着手できない節は無い（B-001 / B-002 の2点を除く）。とくに #4b（Alarm / RPC が CPU リセットの契機か）を「含まれない」と保守的に読み、推論が外れても安全側に倒れることを明示している扱いは適切である。

- **[N-006]** 第4.7節のエラー翻訳の配置は、捕捉可能性の観点で正しく導かれている。
  - `.overloaded` は「超過分は DO へ配送されない」ので DO の中に catch 点が無い、`ctx.abort()` / DO リセットは「RPC の promise が reject する形でしか観測できない」ので同じく DO の中に catch 点が無い —— という判定から翻訳層を2箇所（DO 内アダプター / DO stub factory が返す facade ラッパー）に置く結論は、公式の記述と整合する。`/durable-objects/best-practices/error-handling/` は `.overloaded` について "should not be retried … retrying will worsen the overload and increase the overall error rate" と明記しており、`retryable: false` にして `ConflictError("OPTIMISTIC_LOCK_FAILURE")` のようなリトライ可能系へ写さないという注記も正しい。
  - HTTP status を `kind` 単位のまま 500 に据え置き、`overloaded` に 429 / 503 を割り当てないという判断（`CLAUDE.md`「HTTP status mapping is presentation-only, driven by the serialized `kind`」を崩さないため、かつ「後で再試行せよ」を意味する status がむしろ有害だから）は、契約の維持と挙動の正しさが同じ方向を向いており良い。`errorResponse.ts` を「**変更しない、が結論である**」と #37 への明示的な決定として書いてあるのも、暗黙の非変更より事故が少ない。
  - なお `CLAUDE.md`「adapter → application」との整合も保たれている — 第11.2節の新設対象が facade ラッパーを `packages/core/src/adapters/cloudflare/*` に置くと明記しているので、翻訳がアダプター層の外へ漏れない。

- **[N-007]** `CLAUDE.md` の不変条件が破れる箇所が隠されていないことを確認した。第8.2.1節 `:1245` が「**`CLAUDE.md`「Reference runtime」の明言が実際に破れる箇所がここである。**『ランタイムを差し替えても `domain` / `application` / `presentation` は無傷』は成立しなくなる」と正面から書き、`.adr/002` が受け入れた Cloudflare ロックインの具体的な現れ方として位置づけ、改訂を #35 へ割り当てている。「Unit of Work」「Outbox / domain events」「Retry strategy」については、第8.2節（同期契約 + `enqueueJob` が `collectEvents` のスロットを引き継ぐ）・第7.7節（Outbox 契約の置き換えの正文）・第8.4節 + 第7.7節 項6（OCC 非リトライの維持）で、それぞれ後継が明示されている。第11.1節の `CLAUDE.md` 行が「第7.7節を正文としてそのまま写す」と書き先まで指定しているので、#35 が判断をやり直す必要が無い。

---

## 総評

非同期処理・UoW 契約・migration の観点で、**技術的に成立しない結論や事実誤りはほぼ無い。** 第2.1節のプラットフォーム事実31件は公式ドキュメントとの逐語照合に耐え、引用されている既存実装の事実も行番号・行数レベルで全件一致した。FTS5 同期更新の可否、external-content の実装制約、`ctx.storage.transaction()` の棄却理由、OCC の残置、forward-only + fail-closed の組み合わせは、いずれも根拠と結論が対応している。第8.2節の型による同期強制も実測で機能することを確認した。

残る Blocker は2件で、どちらも**「Alarm 駆動の CPU 予算をどう有界にするか」という同じ一点に集まっている。**

- B-001 は、外側の予算の片方（累積経過時間10秒）が Workers の凍結時計のせいで発火しないこと。CPU 超過が例外ではなくエビクションとして現れる以上、保護が1本減ることの帰結が「黙って途中で止まる」になるので、この設計が最も避けたい失敗モードに直結する。
- B-002 は、`finally` から先頭再武装へ倒した副作用として、due job が無いときに alarm を消す手順が落ちたこと。先行実装には存在した手順なので、記述の追加1行で閉じる。

いずれも設計方針の変更を要さず、第7.4節への追記で解決する。Warning 6件は #37 が実装時に判断を強いられる箇所（`changes()` の未検証、RPC 経路の武装主体と原子性、prune の所有者、`operationKey` の収束意味論）と、文書の自己記述の精度（#27 の裏付け種別、第7.7節の参照位置）である。
