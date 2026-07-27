# PR #33 Search / Data Integrity / Performance Review

## Verdict

CHANGES_REQUESTED

- Blockers: 10
- Warnings: 5
- Notes: 3

## Blockers

### B-SDP-001 — semantic command の冪等性が payload を識別せず、別 mutation を成功扱いで捨てる

- 場所: `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:15-23,45-50`、`packages/core/src/adapters/cloudflare/user-data/schema.ts:77-81`、`apps/web/app/durable-objects/UserDataDurableObject.ts:27-61`
- 理由: `idempotency` の主キーは `operation_id` だけで、既存行があれば command kind / entity / payload を比較せず return する。同じ ID で異なる本文や remove を再送しても `{ ok: true }` になり、変更は消失する。さらに `initialize()` も同じ table を使うため、初期化と content mutation の operation ID が偶然同じ場合も content 側が黙って no-op になる。`spec/testcases/search/maintainSearchIndex.md` が要求する「同一 operationId・異なる payload は conflict」と AC-5 の冪等 command contract に反する。
- 提案: namespace/version/command kind/canonical payload digest/result を idempotency record に保存する。同じ digest の再送だけ保存済み結果を返し、異なる digest は副作用なしの typed conflict にする。初期化と semantic command の namespace 衝突も型または複合キーで排除し、workerd contract test を追加する。

### B-SDP-002 — command harness が memo/document lifecycle と revision を表現せず、本体データ契約を満たさない

- 場所: `packages/core/src/application/search/contracts.ts:56-82`、`packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:25-43,54-136`、`packages/core/src/adapters/cloudflare/user-data/schema.ts:39-57`
- 理由: create/update と memo/document を区別しない `upsert-content` 1種類で、既存 ID の kind すら上書きできる。`content_revisions` は作るだけで一度も insert されず、restore の `restoredAt` も無視される。`SearchProjectionEntry.trashedAt` を伴う upsert は `content.trashed_at` だけを更新して `trash` row を作らず、active upsert は既存 `trash` row を消さないため、公開型が不整合状態を作れる。AC-4/5 と plan の「memo/document create/update/remove/restore の本体 repository + FTS を同一 transaction」に未達である。
- 提案: create/update/rollback/trash/restore/hard-delete を entity kind ごとの discriminated command にし、存在条件、kind 不変、revision 追加、trash row、時刻を同じ transaction で確定する。projection DTO から本体 lifecycle 用の `trashedAt` を除き、違法な組合せを型で表現不能にする。

### B-SDP-003 — source link が片方向かつ参照整合性なしで、削除済み memo を検索結果へ恒久露出する

- 場所: `packages/core/src/adapters/cloudflare/user-data/schema.ts:58-63`、`packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:78-90,125-135`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:120-128`
- 理由: `content_sources` に FK がなく、存在しない／trashed memo ID も保存できる。memo `m1` の hard delete は `WHERE content_id = 'm1'` しか消さず、document 行の `memo_id = 'm1'` は残るため、document の `sourceLinks` に削除済み memo が返り続ける。memo 側の `sourceOfDocumentIds` は契約型にも保存形にもなく、source 追加・削除時に相手側を再射影する処理もない。これは search spec の「active な相手だけ」と ADR-003、AC-5 の双方向 source DTO に直接反する。
- 提案: document→memo の正規 link tableを本体 FK と lifecycle 規則つきで管理し、semantic commit で影響する両側を同時に再射影する。memo delete/trash、document delete/trash、link add/remove の各ケースで両 DTO と孤児0件を表明する。

### B-SDP-004 — topic 絞り込み・archive/trash の検索意味を schema/command/query が実装できない

- 場所: `packages/core/src/adapters/cloudflare/user-data/schema.ts:31-49`、`packages/core/src/application/search/contracts.ts:8-18,56-78`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:75-96`
- 理由: query は `c.topic_id = ?` だけなので、指定 topic 配下 document の active source memo を返さない。存在しない topic も `TOPIC_NOT_FOUND` ではなく0件になる。`topics` に `trashed_at` がなく topic mutation command もないため、trashed topic 配下 document の FTS rowを除外できない。archive は `content.topic_archived` という caller 提供の複製値で、topic の現状態と同期する経路がなく stale になる。現テストも topic row を作らず、任意の `topicId/topicArchived` を content に直書きして通している。
- 提案: topic 本体を権威にし、document topic FK、topic trash/archive command、source join を semantic commit に含める。topic filter は「document + active source memo」を一括 query し、missing topic、archive/unarchive、trash/restore/hard-delete を統合テストする。

### B-SDP-005 — Search contract が種別 DTO と事実データを失い、spec と非互換

- 場所: `packages/core/src/application/search/contracts.ts:1-46`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:27-36,101-117`、`spec/domains/search.md:39-68`、`spec/usecases/search.md:27-53`
- 理由: 実装は全結果へ `title/topicArchived/sourceLinks` を持たせる単一型で、memo/document の discriminated DTO、timestamp、memo の `sourceOfDocumentIds`、document の topic name と `sourceMemoIds` を返せない。ページも page/limit/totalCount/nextCursor を持たない。後続 UI/AI がこの port を使っても、AC-5 の「種別 DTO、source links、topic 出典 memo、archive、UI/AI 同一契約」を実装できない。
- 提案: spec の `MemoSearchResultItem | DocumentSearchResultItem` を application contract に反映し、検索用 fact table/source join/topic join から一括構築する。UI/AI の2 adapterが同じ port resultをそのまま射影する contract test を置く。

### B-SDP-006 — 順位とページングが不安定で、ページ間の重複・欠落を防げない

- 場所: `packages/core/src/application/search/contracts.ts:24-46`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:70-97,114-117`、`spec/domains/search.md:98-106`
- 理由: order は `bm25, id` だけで、規定の `timestamp DESC, type, id` tie-break がない。ページングは integer offset であり snapshot/cursor を保持しないため、1ページ目の後に上位 hit が追加・更新・削除されると2ページ目に重複または欠落が出る。テストは mutation なしで隣接2ページの ID が違うことしか見ておらず、「同一 snapshot」を証明していない。
- 提案: score/timestamp/type/id と snapshot identity を含む opaque cursor、または DO 内で契約した snapshot pagination を実装する。tie、途中 insert/update/delete を挟むテストで全IDが重複・欠落なく一度ずつ返ることを表明する。

### B-SDP-007 — snippet が一致箇所・原文を保証せず、NFKC/短語/title hit で壊れる

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:54-60,87-108`
- 理由: FTS table には NFKC + trim 済み本文を保存し、その table の `snippet()` を返すため、互換文字や空白を含む「原文抜粋」ではない。短語 fallback は未正規化の `content.body` に正規化済み query を `replace` するので、本文 `①` を query `1` でヒットさせても mark が付かない。title だけに短語がある場合も body 全文を無印で返し、長語でも `snippet(..., 3, ...)` が body 列固定のため title-only hit の一致箇所を示さない。
- 提案: 正規化検索用テキストと表示原文の位置対応を定義し、title/body の実ヒット列から安全な原文 snippet を生成する。NFKC互換文字、title-only、body-only、1/2/3文字、先頭/末尾、長文のケースを追加する。

### B-SDP-008 — query/RPC boundary と SQLite error translation がなく、規定エラーと limits guard を満たさない

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:64-84`、`apps/web/app/durable-objects/UserDataDurableObject.ts:99-130`、`packages/core/src/adapters/cloudflare/sql.ts:26-30`、`packages/core/src/application/errors.ts:187-210`
- 理由: 空語は `SEARCH_EMPTY_KEYWORD` でなく正常0件、51 byte は typed business error でなく raw `RangeError`、missing topic は0件、不正 limit/offset は validation error でなく clamp（`NaN`/非整数は SQL 例外）になる。SQLite/FTS 例外を `DatabaseError` へ、`SQLITE_FULL` を non-retryable `StorageCapacityExceeded` へ変換するコードがなく、後者の error code 自体もない。title/body/source数/job payload/SQL回数/処理時間の guard もなく、AC-5/6 と plan の Cloudflare limits 条件を満たさない。
- 提案: versioned RPC input validator と domain query value object を通し、adapter 境界で SQLite code を共通 typed errorへ翻訳する。容量、payload、source count、batch/CPU budget の上限を定数と test で固定し、50/51 byte、NaN/小数/過大値、SQLITE_FULL を検証する。

### B-SDP-009 — job enqueue の `INSERT OR IGNORE` が id/payload/provider-key の衝突をすべて成功扱いにする

- 場所: `packages/core/src/adapters/cloudflare/user-data/jobs.ts:15-39`、`packages/core/src/adapters/cloudflare/user-data/schema.ts:82-96`
- 理由: 同じ job ID に異なる kind/payload、または別 job ID に同じ provider idempotency key を渡しても行は無言で無視され、RPC は success を返す。caller は意図した job が永続化されたと誤認し、外部処理が恒久的に失われる。provider idempotency key の一意性は「同一作用の再送」を表すべきで、異なる作用の衝突まで成功に畳んではならない。
- 提案: canonical payload digestを保存し、同一 ID/key + 同一 digest のみ冪等成功、異なる digest は conflict にする。ID衝突、provider-key衝突、同一再送、transaction後の最早 alarm を個別テストする。

### B-SDP-010 — Alarm/job の受け入れ保証が未検証で、現テストは「binding 不在で1回失敗」しか見ない

- 場所: `apps/web/app/durable-objects/UserDataDurableObject.ts:187-226`、`packages/core/src/adapters/cloudflare/user-data/jobs.ts:41-156`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:319-343`
- 理由: AC-12 が要求する provider idempotency、lease expiry/reclaim、owner CAS、poison/max attempts、最早 alarm 競合、再起動、途中失敗、batch/time budget の自動テストがない。唯一の test は `JOB_EGRESS` 不在で1回 retryするだけで、success path も2件目以降も通らない。handler は25件を外部 fetch へ直列送信し、alarm開始時の単一 `now` を全件の lease/completion/retryに使うため、遅い provider 下で後半jobの leaseが処理前に期限切れになり、retry時刻も過去になり得るが検出できない。
- 提案: controllable auxiliary egress Worker、eviction/alarm helpers、fake clock相当の決定的時刻で全 AC-12 matrix を実装する。claim件数だけでなく時間budgetを各job間で確認し、completion/retry時刻は実際の処理完了時刻を使う。

## Warnings

### W-SDP-001 — FTS upsert/remove が `UNINDEXED content_id` を走査するため、編集コストが全件数に比例する

- 場所: `packages/core/src/adapters/cloudflare/user-data/schema.ts:70-76`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:43-61`
- 理由: FTS5 の `UNINDEXED` 列には通常 index を張れず、`DELETE FROM search_fts WHERE content_id = ?` は各更新で virtual table scan になる。ユーザー内コンテンツ増加に伴い semantic commit の CPU/rows-read が線形化し、DO input gate を長く塞ぐ。
- 提案: spec の `search_entries.rowid` mappingを実装し、既知 rowid に対する FTS delete/insertにする。件数を増やしたテストで rows-read/時間が全件走査にならないことを確認する。

### W-SDP-002 — 検索結果ごとに source query を発行する N+1 構造

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:101-128`
- 理由: limit 100 の1ページで本体 query 1回 + source query最大100回になる。DO SQLite はローカルでも statement/CPU budgetを消費し、source数上限もない。
- 提案: page ID集合に対する1回の join/batch queryで sourceを取得してgroup化する。100件×複数sourceの statement数を表明する性能contractを置く。

### W-SDP-003 — FTS が本文を複製保存し、spec の contentless 設計より容量を余分に消費する

- 場所: `packages/core/src/adapters/cloudflare/user-data/schema.ts:39-49,70-76`、`spec/database/index.md:145-163`
- 理由: default FTS5 table はtitle/bodyの原文コピーも保持するため、`content` と合わせて本文を二重保存する。ユーザー単位DOの容量上限がリスクとして明記されている一方、contentless/external-content設計から逸脱する容量評価がない。
- 提案: fact table + contentless/external-content FTSのrowid同期に寄せるか、二重保存を選ぶならADRと容量試算・上限testを追加する。

### W-SDP-004 — lease reclaim 用 index がなく、job数に比例して毎 claim が全 leased 集合を走査する

- 場所: `packages/core/src/adapters/cloudflare/user-data/schema.ts:82-96`、`packages/core/src/adapters/cloudflare/user-data/jobs.ts:47-67`
- 理由: index は `(status,next_run_at)` だけだが、reclaim predicate は `(status,lease_until)`。completed/poison rowのpruneもないため、長期運用ほどjob tableとscanコストが増える。
- 提案: `(status,lease_until)` indexとcompleted/poison retentionを追加し、query planまたは大件数testで確認する。

### W-SDP-005 — `includeTrash` は禁止された検索意味を公開しつつ、実際には一件も返せない

- 場所: `packages/core/src/application/search/contracts.ts:24-30`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:48-52,75-96`
- 理由: spec はゴミ箱項目を常に除外するがportは `includeTrash` を公開する。一方trash時にFTS row自体を削除するので、trueでもhitしない。callerに存在しない能力を約束するdead contractである。
- 提案: `includeTrash` を削除する。将来ゴミ箱内検索が必要なら別usecaseとして射影・権限・snippet規則を設計する。

## Notes

### N-SDP-001 — 本体・FTS・idempotency の transaction 境界そのものは同期かつ rollback する

- 場所: `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:15-51`、`apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:257-293`
- 内容: `transactionSync` 内で content、source、FTS、idempotency を更新し、FTS tableを落とした障害注入では content write がrollbackした。projectionをAlarm/Outboxへ配送していない点も現行方針と整合する。上記Blockerは、この原子的な箱の中で確定すべき状態と契約が不足している問題である。

### N-SDP-002 — NFKC・UTF-8 byte guard・FTS query escaping の基本実装は安全側

- 場所: `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:15-24,54-83`
- 内容: storage/query双方をNFKC化し、50 byte判定は`TextEncoder`、SQL値はbound parameter、3文字以上のFTS literalはquoteを二重化している。`"*() OR -` を含むphraseもSQLite FTS5上で構文注入せずliteral扱いになることを確認した。B-SDP-007/008の表示・typed errorと境界testは別途必要。

### N-SDP-003 — active spec から vector/embedding/RRF の前提は除去されている

- 場所: `spec/**`
- 内容: 残存語は「採用しない」という現行説明と、本文保持が要件のsuperseded ADR、過去review記録に限られる。inventoryにもactiveなVectorize/search_embeddings要素は見つからなかった。

## Verification performed

- `gh pr diff 33` は20,000行上限でHTTP 406のため、`git diff main...HEAD` と対象ファイルの実体で確認した。
- `pnpm test:integration -- apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts .thread/19/spike/fts5.integration.test.ts` — 2 files / 9 tests PASS。
- search contract、User Data schema、FTS adapter、semantic commit、job store、User Data DO、workerd tests、search/database/usecase/testcase specを相互照合した。
- active spec のVectorize/embedding/RRF/outbox残存と、search/job error/limits guardのrepository-wide `rg` 監査を行った。
