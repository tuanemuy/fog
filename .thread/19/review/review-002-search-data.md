# PR #33 Search / Data Integrity / Jobs Review — Round 2

## Verdict

CHANGES_REQUESTED

- Blockers: 6
- Warnings: 5
- Notes: 4

## Blockers

### B-SDJ-001: 34件以上ヒットする検索が Cloudflare の SQL binding 上限で失敗する

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:298-333,421-440`
- 影響: Durable Objects の SQLite-backed storage は1 queryあたり最大100 bound parameterである。一方、snapshot item の一括 INSERT は1件につき3 parameterを使いながら100件単位で組み立てるため、34件で102 parameterとなる。さらに source の batch query も同じ ID 群を2回 bindするため、51件で102 parameterとなる。公開契約は最大5,000件を snapshot 化できるとしているが、実際には34件以上の通常検索が `DATABASE_ERROR` になる。現テストは最大3件なので検出しない。Cloudflare limit: https://developers.cloudflare.com/durable-objects/platform/limits/
- 修正案: parameter数から安全な batch sizeを導出し、snapshot insertを最大33件以下に分割する。source取得はIDを一時表へ入れる、CTE/JSON tableを使う、または最大50 IDごとに分割して結果をmergeする。34/50/51/100/5,000件境界を workerd integration testで固定する。

### B-SDJ-002: topic の trash/restore/remove が集合ゴミ箱 semantics を実装せず、active dataを直接破壊できる

- 場所: `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:357-396,437-499`, `apps/web/app/durable-objects/UserDataDurableObject.ts:278-317`, `packages/core/src/adapters/cloudflare/user-data/schema.ts:26-46,73-82`
- 影響: `trash-topic` は topic の `trashed_at` と document のFTS projectionだけを変更し、配下 documentを `trashed_with_topic_id` 相当で集合trash化せず、trash rowもretention jobも作らない。`restore-topic` は独立してtrash済みだった documentまで、`content.trashed_at IS NULL` なら再射影する。`remove-topic` はtopicがactiveでも実行でき、配下documentを状態に関係なく全件hard deleteする。memo/documentの `remove-*` も `assertExists` だけなのでactive itemを直接hard deleteできる。これは `spec/domains/trash.md` / `spec/usecases/trash.md` の「hard deleteはtrash済みのみ」「topic trash/restoreは集合操作」「独立trashはrestoreしない」と不整合で、復元不能なデータ損失を許す。
- 修正案: topic配下documentに `trashed_with_topic_id` 等の由来を永続化し、topic trash/restoreと各documentのtrash row、projectionを同一transactionで更新する。hard deleteは対象がtrash済みかつretention到来済みであることを必須にし、topic purgeは集合由来のdocumentだけを処理する。active remove、独立trash済みdocument、topic trash→restore→purgeを統合テストする。

### B-SDJ-003: RPC mutation boundary が未知commandを成功扱いし、旧unsafe commandも本番契約に残っている

- 場所: `packages/core/src/application/search/contracts.ts:115-200`, `apps/web/app/durable-objects/UserDataDurableObject.ts:361-376`, `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:158-223,501-624`
- 影響: runtime validatorは `operationId` と `type` がstringか、任意の `version` が一致するかしか確認しない。未知の `type` はvalidatorを通り、`execute()` のdefaultがないため何もせずにidempotency successを記録する。既知commandでもnested DTO、ID、配列、timestamp、本文型は境界で検証されず、TypeErrorやSQLite errorがvalidationではなく `DATABASE_ERROR` になる。またversionは省略可能で、`upsert-content` 等のlegacy commandも公開unionとexecutorに残り、phantom topic/memo生成、caller指定 `trashedAt` の直書き、typed lifecycleを迂回したmutationが可能である。versioned typed semantic commandというAC-5の境界が成立していない。
- 修正案: versionを必須にし、全discriminatorをexhaustiveに検証するruntime schemaをRPC入口へ置く。未知commandと余剰/欠落/不正型を副作用なしのtyped validation errorにする。legacy command/queryは本番portから削除し、必要ならtest-only adapterへ隔離する。未知type、空/過長ID、不正timestamp、非string本文、非配列source、legacy typeをcontract testへ追加する。

### B-SDJ-004: source relation が trashed topic と参照整合性を無視し、検索結果へ非active relationを返す

- 場所: `packages/core/src/adapters/cloudflare/user-data/schema.ts:26-34,48-56`, `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:421-480`, `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:437-477`
- 影響: source batch queryはdocument/memoの `trashed_at` のみを確認し、documentのtopicがactiveかをjoinしない。B-SDJ-002の実装ではtopic trash後もdocument本体はactiveのままなので、global memo resultの `sourceOfDocumentIds` にtrashed topic配下のdocument IDが残る。topic source memoもFKがなく、memo hard delete後に `topics.source_memo_id` がdanglingになる。`content_sources` の2列は共にgeneric `content` FKで、DB上はdocument→memoというkind制約を保証しない。現テストはtopic trash後の結果typeだけを見ており、memo側source IDを表明しない。
- 修正案: source queryをactive topicまでjoinし、topic trash/restore/remove時に双方向DTOを検証する。topic source memoには参照規則を設け、memo trash/delete時の解除・拒否・topic連動のどれかをdomain契約として実装する。relationの両端kindはschemaまたはsemantic transaction内の必須invariantにする。

### B-SDJ-005: search snapshot が件数・容量・個数無制限で、通常の検索連打だけでUser Data DOを枯渇させられる

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:254-333`
- 影響: cursorが不要な1ページ目、0件検索を含む全新規queryが永続snapshotを作り、最大5,000件分の完全DTO JSONを保存する。期限切れsnapshotの削除は次回search時だけで、user単位のsnapshot数・bytes・同時件数quotaがない。keywordを変えた検索を短時間に連打すると15分間蓄積し、本文由来snippetとsource配列を含む行がUser Data DO容量を圧迫する。`SQLITE_FULL` 後は同じDOのcontent mutationまで失敗し得るため、AC-6のCloudflare limits guardとして不十分である。
- 修正案: next pageが存在する場合だけsnapshotを作り、userあたりsnapshot数/総item数/推定bytesのhard capを設ける。新規作成前に期限切れと超過分をtransaction内でpruneし、snapshotにはページングに必要な最小factだけを保存する。多数の異なるqueryをburstさせても上限が一定であることをtestする。

### B-SDJ-006: overdue Alarm を通常RPCが先送りでき、期限到来済みretention jobがstarvationする

- 場所: `apps/web/app/durable-objects/UserDataDurableObject.ts:101,106-108,146-158,231-262,351-358`
- 影響: `ensureAlarm()` は既存alarmが `current <= Date.now()` の場合にも `Date.now() + 1_000` へ再設定する。Alarm wakeup前のconstructorや高頻度のprofile/search/commit RPCが入るたびにdue alarmを未来へ移せるため、trash purgeが実行されない。これはCloudflare/infra reviewの `B-INFRA-002` と同じ根本原因だが、jobのat-least-once実行保証にも直接影響する。
- 修正案: 通常入力ではalarm未設定または既存より早いjobが入った場合だけ設定し、overdue alarmを上書きしない。constructor wakeup、期限後の連続read、Alarm処理後の次job再設定をeviction込みのworkerd testで検証する。

## Warnings

### W-SDJ-001: terminal job retention は自動実行されず、最後のcompleted/poison rowが恒久残留する

- 場所: `packages/core/src/adapters/cloudflare/user-data/jobs.ts:108,135,197-291`, `apps/web/app/durable-objects/UserDataDurableObject.ts:231-262,351-358`
- 影響: 7日/30日のprune定数はあるが、pruneは次のenqueue/claimまたは明示呼び出し時だけである。最後のjobがcompleted/poisonになると `nextRunAt()` はnullになりalarmも設定されないため、その後jobが来ないDOではterminal rowが削除されない。
- 修正案: terminal retention期限も `nextRunAt`/alarm対象に含めるか、completion/poison時にcleanup alarmを予約する。最終job完了後に時刻を進め、追加enqueueなしで削除されるtestを追加する。

### W-SDJ-002: trash retention がtrash時点の設定へ固定され、設定変更を既存itemへ反映できない

- 場所: `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:357-380`, `apps/web/app/durable-objects/UserDataDurableObject.ts:278-317`
- 影響: `purge_after` とjob `next_run_at` をtrash時に固定し、settings変更時の再計算・job再予約経路がない。retention日数を短縮しても既存itemは旧期限まで残り、延長しても旧jobが先に削除し得る。`spec/domains/trash.md` の動的retention規則と一致しない。
- 修正案: purge判定時に現設定と `trashed_at` から期限を計算し、設定変更時に最早alarmを再評価する。短縮・延長の両方向をtestする。

### W-SDJ-003: idempotency/search digest に非暗号学的FNV-1a 64-bitを使い、衝突時に異なるpayloadを同一扱いする

- 場所: `packages/core/src/adapters/cloudflare/user-data/canonical.ts:15-22`, `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:85-115`, `packages/core/src/adapters/cloudflare/user-data/jobs.ts:60-91`
- 影響: idempotency conflict判定が64-bit FNV digestだけに依存するため、衝突する異なるpayloadはreplayとして受理される。偶発確率は低いが、RPC入力を選べるcallerに対する改ざん検出用途としては適さない。
- 修正案: canonical payload自体を比較用に保存するか、境界でSHA-256を計算してtransactionへ渡す。少なくともdigest algorithm/versionをrecordへ含める。

### W-SDJ-004: NFKC一致の位置対応がgrapheme単位でなく、結合文字のsnippet highlightが欠落する

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:31-80`
- 影響: index/queryは文字列全体をNFKC化する一方、原文位置mapは各code pointを個別にNFKC化する。半角カナ+濁点や分解済み結合文字など、複数code pointをまとめて正規化するケースでは検索hitしても原文側の一致位置を復元できず、markなしsnippetを返す。
- 修正案: grapheme/segment単位または正規化前後のincremental boundary mapを使う。半角濁点、combining mark、互換文字、emoji sequenceをtestする。

### W-SDJ-005: cursorがpage sizeを拘束せず、途中でlimitを変えるとpage metadataの意味が変わる

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:283-296,485-530`
- 影響: cursor digestはkeyword/topicだけで、limitを含まない。cursor再利用時にlimitを変更すると同じoffsetから異なる幅を読み、`page` と後続cursorの進み方が初回queryのページング契約と一致しなくなる。
- 修正案: snapshot metadataまたはcursorへlimitを固定し、不一致はtyped invalid cursorにする。limit変更ケースをcontract testへ追加する。

## Notes

### N-SDJ-001: semantic commit のtransactionと冪等性namespaceは第1回指摘から改善された

- `content`、revision、source、FTS、idempotency resultは `transactionSync` 内で更新され、同一namespace/operationIdの異payloadはconflictになる。initializeとのnamespace衝突も複合keyで分離された。

### N-SDJ-002: external-content FTS5のrowid mappingと基本rankingは改善された

- `search_entries.rowid` を権威にしたFTS delete/insertになり、第1回のUNINDEXED全走査を解消した。queryは `score, updated_at DESC, kind, id` の決定的順序を持ち、topic filterもactive source memoを含める。

### N-SDJ-003: typed result DTO、revision、基本validation/error translationは追加された

- memo/document別result、topic fact、双方向source IDs、snapshot cursor、title/body/source件数上限、SQLite容量error translationが実装された。残る問題はB-SDJ-003/004のruntime境界とrelation lifecycleである。

### N-SDJ-004: job store単体のlease/CAS/retry/poison/idempotency indexは妥当

- expired lease reclaim、owner token CAS、attempt上限、ID/provider-keyのpayload conflict、due/reclaim/terminal indexは実装され、store-level integration testも追加された。B-SDJ-006とW-SDJ-001はscheduler/retention lifecycle側の不足である。

## Verification performed

- `git diff main...HEAD` と現在の実体からsemantic command、schema、FTS query/snapshot、source join、job store、Alarm executorを全差分レビューした。
- `spec/domains/search.md`、`spec/usecases/search.md`、`spec/domains/trash.md`、`spec/usecases/trash.md`、`spec/database/index.md`、search/job testcaseと実装を相互照合した。
- Cloudflare Durable Objects SQLiteの100 bound-parameter制約と実装のbatch sizeを照合した。
- 現HEADの `pnpm test:integration` は6 files / 26 tests PASS。既存search testは最大3 hitのためB-SDJ-001を通らず、topic trash後のmemo側source IDs、未知command、active hard-delete、terminal cleanupも未検証である。
