# レビュー 002 — 非同期処理・UoW 契約・migration 設計

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design`
**主成果物:** `.thread/34/design.md`（1,439行）/ `.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md`
**観点:** FTS5 同期更新 / UoW 契約 / Outbox 廃止境界 / Alarm / lazy migration / エラー翻訳
**実施日:** 2026-07-29（2ラウンド目・ゼロベース）

## 検証方法

- Cloudflare 公式ドキュメント（`/durable-objects/api/sqlite-storage-api/`・`/api/state/`・`/api/alarms/`・`/platform/limits/`・`/platform/pricing/`・`/best-practices/rules-of-durable-objects/`）を実際に取得し、第2.1節の事実表27行と突き合わせた。
- SQLite 公式 `fts5.html`（external content / `content_rowid` / `'delete'` コマンド / trigram）を取得し、第7.1節・第7.2節と突き合わせた。
- 引用されている実装の事実（行数・シグネチャ・JSDoc 位置・エラーコード集合）を実ファイルで照合した。
- 第8.2節の `UnitOfWorkProvider` 型を実際に `tsc` に通して成立を確認した。

## 非同期処理・UoW・migration

### Blockers

- **[B-001]** `.overloaded` と DO リセットは DO の中では原理的に捕捉できないのに、翻訳の実行場所が「DO 側」に断定されている
  - 場所: `.thread/34/design.md:336-351`（第4.7節の表・行1 / 行3）と `.thread/34/design.md:1074`（第8.3節 (d)「第4.7節のプラットフォームエラー翻訳表は **DO 側で適用する** — request 側に届く時点で既に共有エラー契約になっている」）
  - 理由: 第4.7節の4行のうち2行は、**DO のコードが1行も走らない状況で発生する**。
    - 行1（`.overloaded`）は「1オブジェクト 1,000 req/s の soft limit 超過」であり、超過分は DO に配送されない。エラーを受け取るのは stub を叩いた request Worker である。
    - 行3（`ctx.abort()` / DO のリセット）も同様に、DO が消滅した結果として RPC の promise が reject する形でしか観測できない。公式も output gate の説明で「If the write fails, the system will reset the Object, **discard all outgoing messages**, and respond to any clients with errors instead」としており、DO 側に catch する場所が残らないことを明言している。
    - DO 側で捕捉できるのは行2（`SQLITE_FULL`）と行4（条件付き UPDATE の0行一致）の2行だけである。
  - この断定に従うと、#37 は request Worker 側に翻訳層を置かない。結果として生のプラットフォームエラーが `apps/web/app/presentation/errorResponse.ts` の `serializeError`（:70）へ素通りし、`kind: "unknown"` として 500 に落ちる。`CLAUDE.md`「adapter → application: アダプターが driver 固有エラーを共有エラー契約へ翻訳する。アプリケーションコードは provider ネイティブのエラーを見ない」が破れる。しかも第4.7節が行1に与えた **retryable false・リトライ禁止**という最も重要な情報が失われ、「`kind: unknown` なので何が起きたか分からない」状態で運用に出る。
  - 提案:
    1. 第4.7節の表に「**捕捉する側**」列を追加する。行1・行3 → **request Worker 側の DO stub アダプター**、行2・行4 → **DO 内アダプター**。
    2. 第8.3節 (d) の当該文を「値エンベロープに載る `SerializedError` は DO 側で作る。**ただし DO へ到達しなかった／DO が消滅した場合のプラットフォームエラーは DO の中に catch 点が無いので、stub 呼び出しを包む request 側アダプターが翻訳する。**」へ差し替える。エンベロープの `{ ok: false, error }` と「stub 呼び出し自体が throw する」は別経路であることを明記する。
    3. 第11.2節の新設対象「`packages/core/src/adapters/cloudflare/*` — …プラットフォームエラー翻訳（第4.7節）」（:1387）を、**DO 側と request 側の2箇所**であると書き分ける。第8.3節 (b) の「request 側 DI に残るもの」に DO stub factory があるので、翻訳はそのファクトリが返す facade ラッパーの責務になる。

- **[B-002]** `alarm()` 先頭での再武装が、`setAlarm()` が write buffer 操作であることを踏まえていない。設計が自ら定義した支配的失敗モードでその書き込みごと失われる
  - 場所: `.thread/34/design.md:906-912`（第7.4節「Alarm の再設定規則」第1項・第5項）
  - 理由: 第7.4節は「`alarm()` の先頭で `setAlarm` しておけば、**黙ってリセットされても alarm は武装済みのまま残る**」(:908) を本規則の中核に据えているが、この前提は公式仕様上そのままでは成立しない。
    - 公式 API は **`setAlarm(scheduledTimeMs: number): void`** で Promise を返さない。await できない。
    - 公式は「Alarms are modified using the Storage API, and **alarm operations follow the same rules as other storage operations**」としている。そのストレージ書き込みは「writes to an **in-memory write buffer that is flushed to disk asynchronously**」であり、「In case of a machine failure, **either all of the writes will have been stored to disk or none of the writes will have been stored to disk**」である。
    - 第7.4節・第9.2節が自ら定義した支配的失敗モードは「例外ではなく **CPU 予算超過 → エビクションとリセット**」(:902, :1134) である。そのモードでは isolate が同期実行の途中で殺されるので、**バッファのフラッシュに必要なイベントループの一巡が起きない**。すなわち先頭の `setAlarm` はディスクに届いていない可能性がある。
    - 第7.4節が `finally` を棄却した論拠（「isolate ごと殺されるので `finally` は走らない」）は、そのまま「先頭の `setAlarm` もまだバッファ上にしかない」に跳ね返る。防ごうとした帰結 —— 「dormant な User Data DO の `purge-trash` が恒久的に停止し、ゴミ箱の保持期限が誰にも気づかれずに無期限へ伸びる」(:908) —— がそのまま残る。
    - 出力ゲートも救わない。output gate が保証するのは「**外向きネットワークメッセージ**を書き込み確定まで止める」ことであって、送信の無い CPU 専従の `alarm()` には効かない。
  - 提案:
    1. 第7.4節の再設定規則の第1項を「先頭で `setAlarm` し、**`await ctx.storage.sync()` で永続化を確認してから**仕事を始める」に直す。`sync()` は公式に「Synchronizes any pending writes to disk. … the returned promise will resolve when they complete」と定義されており、`setAlarm` を await できない問題に対する公式の受け皿である。この `await` は `transactionSync` の外なので第8.2節の同期契約とは衝突しない。
    2. 第2.1節の事実表に2行足す。「`setAlarm()` は `void` を返し、他のストレージ書き込みと同じく write buffer 経由で非同期にフラッシュされる（公式記載）」「`ctx.storage.sync()` が pending write のフラッシュ完了を待つ唯一の手段（公式記載）」。効き先は 7.4 / 9.4。
    3. 同じ規則が第9.4節の fail-closed 時の張り直し（:1163「一定間隔（バックオフ付き）で `setAlarm` を張り直して戻る」）にも掛かることを1行で書く。fail-closed の DO は仕事をしないので実害は小さいが、規則を2箇所に分岐させない。
    4. 第7.4節「チェックポイント予算の測り方」(:915) に、チェックポイントごとの `sync()` も同じ理由で必要であることを含める（カーソルを進めてコミットしても、バッファのままリセットされれば進捗は残らない）。

### Warnings

- **[W-001]** `collectEvents` を廃止した後、「トランザクション内でジョブ行を書く」経路が UoW 契約に定義されていない
  - 場所: `.thread/34/design.md:984-1003`（第8.2節の `UnitOfWorkContext` スケッチと決定事項）、`.thread/34/design.md:1401`（第11.2節 新旧対比の「イベント登録」行）
  - 理由: 現行の `packages/core/src/application/execution/unitOfWork.ts:4-15` は `UnitOfWorkContext { userRepository; collectEvents(drafts): void }` で、`CLAUDE.md` はこれを「the only path to enqueue domain events」と位置づけている。設計は `collectEvents` を廃止する一方で、**ジョブ投入は本体更新と同一 `transactionSync` に入っていなければ意味がない**ことを複数箇所で要求している。
    - 第7.5節 (:926)「ソフトデリート時に『`purge_after` の最小値』を求め、…`purge-trash` ジョブを投入する」
    - 第7.6節 (:935)「外部 I/O は必ず『トランザクションでジョブ行を書く → コミット後に Alarm が拾って実行する』形になる」
    - 第7.6節 (:947)「mapping の有無にかかわらず (i) **同じ `transactionSync` でジョブ行を1行書き**」
    - 第9.2節 (:1130)「ジョブ投入もゲートの中では同期の1行書き込みで済み」
  - ところが第8.2節のスケッチは「その DO が持つ集約のリポジトリ」しか列挙せず、さらに決定事項が「`UnitOfWorkContext` には**リポジトリしか載せない**」(:1001) と閉じている。`jobs` は集約ではない —— 第4.2節 (:249) が「ジョブ / 冪等化状態」を集約の表とは別行で扱い、第4.1.1節 (:226) が `jobs` / `operations` / `migration_progress` を「集約テーブル」と並べつつ用途で区別している。`operations`（第6.5節の RPC 冪等キー）と `migration_progress`（第9.3節）にも同じことが当たる。
  - `collectEvents` が占めていた「トランザクション内の唯一の副作用登録点」というスロットが空いたまま、その後継が指名されていない。これは Issue 対応項目4 が本 Issue に決めさせた「UoW 契約」の中核部分である。#37 は (a) `jobRepository` をリポジトリの一種として載せる、(b) `enqueueJob(...)` を専用メソッドとして載せる、(c) usecase から `ctx.storage.sql` を直接触る（レイヤー違反）の3択を自分で決めることになる。
  - 提案: 第8.2節の決定事項に1行を足して断定する。推奨は (b) —— 「`UnitOfWorkContext` はドメイン集約のリポジトリに加えて、`jobs` への投入口 `enqueueJob(kind, operationKey, payload, nextRunAt)` と `operations` の CAS を配る。`collectEvents` が占めていた『トランザクション内の唯一の副作用登録点』の位置をこれが引き継ぐ」。あわせて「リポジトリしか載せない」の1文を「非同期ポート（`MailSender` / `PasswordHasher` / DO stub factory）を載せない」という**禁止の形**に書き換える（現在の肯定形は許可対象を過度に狭めている）。第11.2節の新旧対比表の「イベント登録」行も、`ctx.collectEvents(drafts) → outbox 行` の対向を「廃止」ではなく「`ctx.enqueueJob(...)` → `jobs` 行」に直す —— 現在の「廃止」だけを読むと、後継が無いように読める。

- **[W-002]** チェックポイント予算がジョブランナー粒度にしか無く、`migrate-bulk` / `reindex` / 退会一括削除の**ジョブ内部**の刻み幅が未定義。しかも第9.2節が正しい解を明示的に閉じている
  - 場所: `.thread/34/design.md:904`（第7.4節 (i)(ii)(iii)）、`.thread/34/design.md:915`（予算の測り方と初期値）、`.thread/34/design.md:1136`（第9.2節「migration 専用の別閾値は置かない」）
  - 理由: 予算「ジョブ25件 または 累積経過時間10秒のいずれか早い方」はジョブランナーのループ条件として定義されている。しかし設計が本当に守りたい対象 —— 第4.8節が「DO 内。ただし Alarm でチェックポイント分割する」と結論づけた **FTS5 全件再インデックス**と **bulk migration**、および第6.7節 手順2 の退会時一括削除 —— は、いずれも `jobs` テーブル上の**1レコード**である。
    - 「25件」はジョブ件数の上限なので、1件の巨大ジョブには一度も発火しない。
    - 「累積10秒」はループの反復間でしか評価できない。第7.4節 (iii) は「ジョブ自身が内部カーソルを持ち、カーソルを進めてコミットしてから次の Alarm を張る」としているが、**1回のカーソル前進で何行処理するか**がどこにも書かれていない。上限が無ければ「全行を1チャンクで書き換える」実装が規約に違反せずに書けてしまい、第9.2節 (:1134) が「途中まで進んで黙ってリセットされる」と警告したまさにその失敗モードに落ちる。
    - 第9.2節はさらに「`migrate-bulk` は `jobs` テーブルの1レコードとして同じジョブランナーが回すので、そこに閾値が2系統あると打ち切り条件が二重になる」として **migration 専用の閾値を明示的に禁止**している。禁止の論拠（二重の打ち切り条件を避ける）は妥当だが、その結果として `migrate-bulk` に効く上限が「累積10秒」1本だけになり、それがチャンク間でしか評価されない以上、実効的な保護が存在しない状態になっている。
  - 提案: 予算を**2階層**として明記し、階層が違うので二重にはならないことを書く。
    - 外側（ジョブランナー）: 現行どおり「25件 または 累積10秒」。
    - 内側（1ジョブの1回の起動で進めるカーソル）: 「**行数の上限**（例: 1,000行）と、チャンクごとに累積経過時間を再評価する」ことを規約にする。第7.4節 (iii) に「カーソルを進める1ステップの行数上限をジョブ種別ごとに持つ。上限値の初期値は #37 が spike で出し、#38 が運用値として確定する」を足す（第4.8節の export 上限が既に採っている2段階の分担と揃う）。
    - 第9.2節の「migration 専用の別閾値は置かない」は「**外側の**打ち切り条件を migration 専用に分岐させない」の意味だと限定する。

- **[W-003]** external-content FTS5 の surrogate rowid 列に UNIQUE / 索引の要求が無く、根拠として引いた第4.4節に該当記述が無い
  - 場所: `.thread/34/design.md:807`（第7.1節 実装制約2）
  - 理由: SQLite 公式を確認した範囲では、`content_rowid` に指定する列が INTEGER PRIMARY KEY であることは明文の要求ではない（「By default, `<content_rowid>` is replaced by the literal text 'rowid'. Or, if the 'content_rowid' option is set …, by the value of that option.」）。したがって surrogate 列を採る方針そのものは成立する。ただし2点が抜けている。
    1. **一意性と索引の要求が書かれていない。** 公式は「Whenever column values are required by FTS5, it queries the content table」としており、FTS5 は `search_entries` に対して `WHERE <content_rowid> = ?` で引く。`AUTOINCREMENT ではなく単調増加の採番でよい` としか書かれていないため、UNIQUE 制約も索引も無い INTEGER 列として実装されうる。その場合、列値取得が発生する経路（`fts5vocab`、将来の `snippet()` 導入、整合性検査）で毎回テーブル全走査になる。
    2. **引用元が実在しない。** 「第4.4節は全テーブルの PK を単一列 TEXT の `id` と決めているので」とあるが、第4.4節（:308-316）にその記述は無い。当該の主張は第4.3節の述語 (b)（:259「設計上すべてのテーブルが単一列 TEXT の `id` を PK にしている」）にある。しかも第4.2節（:243）は「`source_links` は複合 PK のまま」としており、「全テーブル」は事実と食い違う。#37 が根拠を辿ると空振りする。
  - なお、`'delete'` に旧値が要るという記述（制約1）と「例外が上がらずインデックスだけが黙って壊れる」という警告は公式と完全に一致している（「If the values 'inserted' … are not the same as those currently stored …, the results may be unpredictable … This can leave the full-text index in an unpredictable state.」）。制約1 は問題ない。
  - 提案: 制約2 を「`search_entries` に `rowid INTEGER PRIMARY KEY` を持たせ、`id TEXT` は UNIQUE 制約付きの別列にする（`content_rowid` は既定の `rowid` のままでよい）」に強める。INTEGER PRIMARY KEY は真の rowid alias なので VACUUM でも再採番されず、「安定した INTEGER rowid」という要求を最も直接に満たす。surrogate 列を採るなら **UNIQUE + 索引を必須**と書く。引用は第4.3節 (b) へ直し、`source_links` の複合 PK が例外であることを1語添える。

- **[W-004]** 非同期実行契約の「正文」が一方向の宣言に留まり、同じ規則が第7.4節・第7.6節に二重記述されている
  - 場所: `.thread/34/design.md:952-963`（第7.7節）
  - 理由: 第7.7節は「**本節が正文であり**、第7.3節・第7.4節・第7.6節・第8.2節・第8.4節はここへ帰着する」と宣言しているが、逆向きのポインタが1つも無い。第7.3節・第7.4節・第7.5節・第7.6節・第8.2節・第8.4節の本文に「第7.7節」の文字列は現れず、第7.7節を指しているのは第11.2節の新旧対比表の1セル（:1404）だけである。
  - さらに実際に規則が二重化している。「`alarm()` から throw しない / 個々のジョブの失敗を `try / catch` で吸収し `attempt` と `nextRunAt` を進める」は第7.4節 (:911) と第7.7節 項5 (:960) の両方に、`providerIdempotencyKey` を `operationKey` から決定的に導く規則は第7.6節 (:942) と第7.7節 項3 (:958) の両方にある。片方だけが改訂されると「正文」が正文でなくなる。
  - 実害は限定的である（第1.1節の読み順で #37 は第3〜9章を通読する）。ただし `CLAUDE.md`「Outbox / domain events」の置き換え本文としてこの節が #35 に写される以上、正文の一意性は維持されているほうがよい。
  - 提案: 第7.3節・第7.4節・第7.6節・第8.2節・第8.4節の該当箇所に「（契約の正文は第7.7節）」を1行ずつ入れる。二重記述の少なくとも2箇所（第7.4節の throw 禁止、第7.6節の冪等キー）は、第7.7節の項番号を参照する形（「第7.7節 項5 を DO の Alarm に適用したもの」）へ畳む。

- **[W-005]** ロールバックの代替として PITR を挙げているが、影響 DO を特定する手段が書かれていない。事実表 #5 と正面から衝突する
  - 場所: `.thread/34/design.md:1169-1177`（第9.5節）
  - 理由: 第9.5節は「スキーマを進める migration を含むリリースは、ロールバック不可のリリースとして扱う」「代替手段は PITR（object 単位・過去30日）」と断定し、「復旧単位は DO 1個で、複数 DO を同一時点へ戻す手段は無い」と限界も書いている。ここまでは正しい。抜けているのは**その1個をどう選ぶか**である。
    - 第2.1節の事実 #5 は「Worker から DO namespace の ID / 名前を列挙する API は存在しない。REST の List Objects が返すのは16進の object ID と `hasStoredData` だけ」と確定させている。
    - `UserDataDurableObject` の locator は `idFromName(userId)`（第5.2.2節 (a)）なので、16進 object ID から `userId` へは戻せない。
    - したがって「不良 migration が N 人分の User Data DO を壊した」ときに、**壊れた DO の集合を列挙する手段が設計上どこにも接続されていない**。PITR は「対象を知っている場合の復旧手段」であって、「対象を発見する手段」ではない。
  - 列挙路そのものは設計内に存在する。第6.7節の operator 経路（「256 bucket の走査」）と第6.8節の bucket 走査は、Directory bucket の `credential_mappings.userId` を舐めれば全 `userId` を列挙できることを前提にしている。第9.5節と第11.3節がこれに接続していないだけである。
  - 提案: 第9.5節に1段落足す。「PITR の対象を特定する唯一の経路は Identity Directory bucket の全走査（`credential_mappings.userId`）である。したがって不良 migration の影響範囲は『`_meta.schema_version` が特定値の User Data DO』としてしか表現できず、その判定には全ユーザー分の RPC が要る。**現実的な防御線は PITR ではなく第9.4節の fail-closed と第9.3節の部分適用記録であり、PITR は個別救済の最後の手段である**」を断定として置く。第11.3節の「PITR の手順」（:1416）にも「対象 DO の特定手段（Directory bucket 走査）」を1項目として足す。

### Notes

- **[N-001]** 第8.2節の `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` は**実際にコンパイル検証で成立する**。TypeScript 6.0.3 で試したところ、同期コールバックは `T` が正しく推論され（戻り値が `number` として通る）、`async` コールバックと `Promise` を返すコールバックはどちらも `Type 'Promise<number>' is not assignable to type 'never'` で拒否された。条件型がパラメータ位置にあるため推論が壊れる懸念があったが、そうはならない。本設計で最も高価な決定（ドメインポートから `Promise` を剥がす）を支える機構なので、成立を確認できたことを記録しておく。#37 は追加の工夫なしにこの署名をそのまま採れる。

- **[N-002]** 第9.2節が `schema_version` を `_meta` テーブル（SQL 側）に置いた判断は、公式が要求している対応そのものである。`/durable-objects/best-practices/rules-of-durable-objects/` は「**`PRAGMA user_version` is not supported by Durable Objects SQLite storage. You must use an alternative approach to track your schema version.**」と明記している。設計は「migration の適用とバージョンの更新を同じ `transactionSync` で確定させるため」という別の論拠で同じ結論に着いており、判断は正しい。第2.1節の事実表に「`PRAGMA user_version` は非対応。公式が代替手段を要求している（公式記載）」を1行足すと、#37 が `PRAGMA user_version` を試して詰まる回り道を消せる。

- **[N-003]** 第9.2節が migration ゲートを **`alarm()` にも掛けた**判断（:1124-1126）は、この設計で最も効いている決定の1つである。dormant な User Data DO は次に起きる契機が `purge-trash` の Alarm しか無いという指摘は正しく、ゲートを RPC だけに置くと第7.5節の「利用者がアクセスしていなくても期限処理は走る」という retention 方式の利点そのものが未 migrate の DO で壊れる。第9.4節の fail-closed を `alarm()` にも広げた判断（:1163）も対で正しい。両方とも「片方だけ掛けると意味が半分になる」理由まで書かれており、#37 が省略できない形になっている。

- **[N-004]** `blockConcurrencyWhile` を棄却し、**同期ゲート関数 + input gate** で排他を取る判断（:1130）は公式仕様と整合している。公式は `blockConcurrencyWhile` について「30秒のタイムアウト、超過で DO をリセット」「If the callback throws an exception, **the object will be terminated and reset**」とし、さらに「For regular request handling, you rarely need `blockConcurrencyWhile`. **SQLite storage operations are synchronous and do not yield the event loop, so they execute atomically without it.**」と、まさに本設計が採った方向を推奨している。`await` を1つも挟まないという排他条件も「Input gates block new events while synchronous JavaScript execution is in progress」と一致する。

- **[N-005]** 第8.4節の「条件付き `UPDATE` の変更行数が0なら `ConflictError`」は、取得手段を1語添えたほうがよい。`SqlStorageCursor.rowsWritten` は公式に「every row update of an **index** counts as an additional row」「The final value is used for SQL billing」と定義されており、**マッチした行数ではなく課金単位**である。0 / 非0 の判定にだけ使うなら安全だが、`changes()` を明示するほうが誤用の余地が無い。第8.4節に「変更行数は `sql.exec("SELECT changes()")` で読む（`rowsWritten` は索引行を含む課金単位なのでマッチ行数ではない）」を1行足すことを勧める。

- **[N-006]** 第8.2.1節 (c) の棄却（`ctx.storage.transaction(closure)` を使わない）は、公式の原文と完全に一致している。公式は「**Explicit transactions are no longer necessary. Any series of write operations with no intervening `await` will automatically be submitted atomically**」「When using the SQLite-backed storage engine, the `txn` object is **obsolete**. Any storage operations performed directly on the `ctx.storage` object, including SQL queries using `ctx.storage.sql.exec()`, will be considered part of the transaction」と述べており、「原子性の条件は `await` の不在の側にあり、`transaction()` はそれを緩めない」という設計の読みは正確である。「#37 が着手時にこの API を見つけて設計を再開させないよう理由を残す」という意図（:1024）も、実際にこの棄却が最も再燃しやすい論点なので妥当である。

- **[N-007]** 事実表と実装への参照は照合した範囲ですべて実物と一致していた。`adapters/d1/unitOfWork.ts:39` の "Read-your-write within the same UoW is unsupported by design"（行番号ちょうど39）、`application/execution/unitOfWork.ts` が19行で `UnitOfWorkContext { userRepository; collectEvents }` / `UnitOfWorkProvider { run }` のみ、`TransactionalRepository` / `UserRepository` の全メソッドが `Promise` 返し、`SystemErrorCode` が6値で `RETRYABLE_SYSTEM_CODES` が `NetworkError` / `ExternalApiError` の2つ、`HTTP_STATUS_BY_KIND` が `kind` のみを見ること、`containerStore.ts` が `globalThis` の Symbol スロットだけで `AsyncLocalStorage` を import していないこと、`eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行、`handlers.ts` の `handleQueue`:82 / `handleDlq`:120、`adapters/d1/` が20ファイル 2,514行でうちプロダクション TS 8ファイル 914行 —— いずれも実測と一致した。Cloudflare 側の事実表27行も、#4b / #13 / #14 / #26 の「未確認」表示を含めて公式記載と食い違う行は見つからなかった。

- **[N-008]** 参考情報。`deleteAll()` は compatibility date `2026-02-24` 以降で **active な alarm も削除する**（それ以前の compat date では削除しない）。第6.7節 手順2 の退会一括削除は消すテーブルを明示列挙しており、`account` / `credential_locators` / `jobs` を残す必要がある以上 `deleteAll()` は使えない構成になっているので現状は無害である。ただし #37 が「どうせ全部消すので `deleteAll()` が速い」と最適化すると、`jobs` / `_meta` / 武装済み alarm ごと消えて `finalize-withdrawal` が二度と前進しなくなる。第6.7節 手順2 に「`deleteAll()` は使わない（alarm と `jobs` / `_meta` を巻き込む）」の1行を置いておくと安い。

- **[N-009]** 第2.1節 #1 の脚注（:94）「Free の 5 GB は Storage per account の値であり、…**矛盾は無い**」は、公式ページ内の別の記述と食い違う。同じ limits ページの storage-full の説明が「When a SQLite-backed Durable Object reaches its maximum storage limit (**10 GB on Workers Paid, or 1 GB on the Free plan**)」と、per-object の Free 値（1 GB）を明示している。つまり公式ドキュメント自体が内部で不整合であり、「矛盾は無い」ではなく「**公式内に不整合があるが、fog は Workers Paid 前提なので設計に影響しない**」と書くのが正確である。本 Issue のスコープには効かないので Note に留める。

## 総評

前回からの改善は明確で、とくに次の4点は #37 が判断を差し戻す余地なく着手できる形になっている。

- **UoW 契約が完全同期で決着し、代替案 (b) / (c) の棄却理由が公式原文で裏付けられている**（第8.2節・第8.2.1節）。`async` を型で排除することで「`await` が構文エラーになる」という言語レベルの保証に落とした発想は、コマンド機構より強く実行時コストがゼロで、実際にコンパイル検証でも成立する（N-001）。
- **`CLAUDE.md`「ランタイム swap で domain / application / presentation は無傷」が破れる点が隠されていない**（design.md:1037 / `.adr/004-do-local-commit-and-alarm-jobs.md`:41）。`.adr/` 側にも仕組みを書かない1行として残っており、`.adr/` しか読まない読み手に見える。
- **`PendingBatch` / `_occ_guard` / OCC / `ConflictError("OPTIMISTIC_LOCK_FAILURE")` の去就が全部決着している**（第8.1節・第8.4節・第11.2節の新旧対比）。OCC は「残す・手段だけ条件付き UPDATE の0行検出へ変える・リトライデコレーターは置かない」で `CLAUDE.md`「Retry strategy」と整合している。
- **Outbox 廃止の境界が購読者2つの単位で示され、残す側（外部 I/O = メール送信1件のみ）まで確定している**（第7.3節・第7.6節）。ドメインイベントを「業務・監査の表現としても残さない」という踏み込みにも3つの理由が付いている。

Blocker 2件はいずれも「決めていない」ではなく「決めた内容が公式仕様と1点ずれている」種類で、修正はどちらも数行で足りる。B-001 は翻訳の実行場所を2箇所に分ける、B-002 は再武装の直後に `await ctx.storage.sync()` を要求する、である。Warning 5件のうち W-001（ジョブ投入口）と W-002（ジョブ内部の刻み幅）は #37 が実装時に必ず突き当たる箇所なので、本 Issue で断定しておくほうが受け入れ条件9（#37 が成果物だけを見て着手できる）に忠実である。

AC-5（断定形）と AC-21（Account Home の採否）は、本レビューの射程（第7章・第8章・第9章の `［Issue 要求］` / `［派生］` 全節）について満たされている。「今後検討」「TBD」が結論位置にある節は無く、第11.4節の未決4件はいずれも「本設計への影響: 無い」または「値だけが2段階で決まる」として決定主体と時期が割り当てられている。
