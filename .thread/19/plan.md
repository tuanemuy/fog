# 実装計画 — Issue #19: Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

**Issue:** #19
**作成日:** 2026-07-28
**複雑度:** 中〜大規模

---

## 目的

本番実行経路を Cloudflare Workers と SQLite-backed Durable Objects に一本化し、利用者ごとの物理的なデータ分離を実現する。同時に検索を SQLite FTS5 の全文検索へ単純化し、上流要件・設計・実装・運用手順・関連 Issue を同じ前提へ同期する。

## 受け入れ基準

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | Cloudflare Worker が認証済み `userId` から唯一の User Data DO にルーティングし、外部入力から別ユーザーの DO ID を指定できない | Issue「User Data DO」 | 3, 7, 8 |
| AC-2 | 正規化メールまたは SSO provider/subject から `userId` を、秘密鍵付き決定的ルーティングと分割 Identity Directory DO で一意・冪等に解決できる。SSO は lookup/create primitive について初回、再送、同一メール競合、provider 境界、active/previous rotation を contract test で確認する | Issue「Identity Directory DO」 | 2, 4, 11 |
| AC-3 | 既存 #1 の登録と User Data DO 初期化の全 fault point とリトライ状態が永続化され、同一 operation ID の再送と Directory reconciler により、一意な credential mapping を保って orphan/二重 user なしに回復できる。password change/reset と SSO link/unlink はユーザー向け UI・完成 usecase を実装せず、将来実装が従う schema・primitive contract・saga・不変条件を設計と contract test で固定する | Issue「Identity Directory DO」 | 2, 4, 8, 11 |
| AC-4 | User Data DO の SQLite がユーザー設定、AI client connection、メモ、文書、トピック、履歴、ゴミ箱、FTS、冪等化、ジョブ状態を保持できるスキーマを持つ | Issue「User Data DO」 | 3, 6 |
| AC-5 | read/query 専用の最小 `SearchIndexPort` と、`SemanticCommitPort` だけへ渡す transaction-scoped `SearchProjectionPort`（upsert/remove）を分離する。最小 DO command harness のメモ・文書 create/update/remove/restore と FTS5 projection は同一 SQLite transaction に入り、順位、snippet、optional 単一 topic、ゴミ箱、種別 DTO、source links、topic 出典 memo、archive、UI/AI 同一検索契約を自動統合テストと local-only 手動 CLI で確認できる | Issue「DB・アダプター」 | 2, 3, 5, 11 |
| AC-6 | 日本語の3文字以上は FTS5 trigram、1〜2文字は安全にエスケープした短語フォールバックで検索でき、実 workerd 上の先行 spike と統合テストが通る | Issue「日本語検索」 | 0, 5, 6, 11 |
| AC-7 | Vectorize、embedding、RRF、ハイブリッド検索、`search_embeddings` を前提とする有効な要件・設計・テスト・台帳が `spec/` に残らない | Issue「specを上流から改訂」 | 1, 5 |
| AC-8 | D1 `PendingBatch` / `_occ_guard` / Outbox consumer を前提とせず、同期 SQL transaction と Alarm による直列処理・再試行設計になる | Issue「非同期処理」 | 1, 3, 5, 6, 9 |
| AC-9 | Node/libSQL、D1、AWS、GCP のエントリ、DI、アダプター、worker、infra、設定、依存、テスト経路が削除される | Issue「実装を撤去」 | 7, 11 |
| AC-10 | `dev` / `build` / `start` / test / deploy と Wrangler 設定が fog の request Worker と state/DO Worker の2 script構成を対象にする。local `pnpm dev` は request config を primary、state config を secondary とする公式 multi-config `wrangler dev -c <request-config> -c <state-config>` で協調起動し、ready/teardown/persist/generated types/Vite custom build を一つの経路で扱う。`SESSION_SECRET` / `DIRECTORY_ROUTING_SECRET` は request Worker にだけ、state Worker には外部 adapter 実行に必要な secret だけを最小配布する | Issue「既定スクリプトと設定」 | 7, 11, 15 |
| AC-11 | `UserDataDurableObject`、`IdentityDirectoryDurableObject`、`AccountHomeDurableObject` の3 class が独立した SQLite class として宣言され、各 schema version の lazy migration が再実行可能かつ forward-only である | Issue「schema migration」 | 3, 4, 7, 10, 11 |
| AC-12 | Alarm の at-least-once、lease expiry/reclaim、owner CAS、provider idempotency、poison、最大自動 retry 後の自前再設定、最早 alarm 競合、再起動、途中失敗が永続ジョブの統合テストで確認できる | Issue「非同期処理」 | 6, 9, 11 |
| AC-13 | staging での User Data/Identity Directory PITR 手動 smoke、Account Home restore を拒否する operator policy/admin tooling guard と contract test、ユーザー単位の逐次 export 運用手順、非 PII の Account Home tombstone/epoch を権威とする退会削除 saga、全固定 bucket の checkpoint scan による secret rotation、schema migration、個人情報を含まない routing/logging、指定の session secret 生成・投入コマンドが運用文書化される | Issue「ドキュメントとセキュリティ」 | 4, 11, 12 |
| AC-14 | `.issue/1/adr.md` と `spec/adr/005-search-index-via-outbox.md` に本文を保持した superseded ポインタが付き、現行規則が `spec/` と `CLAUDE.md` に反映される | Issue「旧 ADR」 | 1, 13 |
| AC-15 | Issue #10 が FTS5 単独、User Data DO 内同期更新、日本語・短語・topic・ゴミ箱を扱うチェックリストへ更新され、#19 依存を明記する | Issue「Issue #10」 | 14 |
| AC-16 | `pnpm typecheck`、lint、unit、workerd 上の DO SQLite integration test、Cloudflare build が成功する | Issue 受け入れ条件 | 11, 15 |
| AC-17 | 長寿命のランタイム、検索、非同期処理の判断が `.thread/19/adr.md` に記録され、片付け時に `.adr/` へ昇格される | Issue「永続 ADR」 | 13, 16 |

## スコープ

### 含まれないもの

- ベクトル検索、意味検索、Vectorize、embedding、RRF。具体的な利用要求と評価データが得られた場合だけ別 Issue/ADR で再検討する。
- 共有、共同編集、テナント横断検索。User Data DO 境界と矛盾するため扱わない。
- #18 のレート制限、rehash、CSRF 実装と #20 のパスワードハッシュパラメータ変更。
- password change（#11）、password reset・SSO link/unlink と OAuth UI（#12）、ユーザー向け export 完成 usecase/UI（#15）。#19 は保存 schema、application port、再開可能な saga primitive、非公開 RPC contract、contract test、運用手順までを提供し、ユーザー機能としては既存 #1 の signup/login/current-user/logout だけを新基盤へ移行する。
- 未実装の #2/#5/#7〜#10 に属するメモ・文書の本番 UI と完成版 application usecase。ただし Issue #19 の受け入れ条件を満たすため、DO 内 application boundary から本体 repository と FTS projection を同一 transaction で実行する最小 command harness（create/update/remove/restore）を実装し、workerd integration と手動 CLI で lifecycle を確認する。後続 Issue はこの contract を本番 usecase/UI に接続する。
- 本番環境への実 deploy や既存本番データ移行。現時点で本番データはない。例外として PITR は local workerd 非対応のため、認証済み staging namespace に対する非破壊の手動 smoke だけを実施し、本番 deploy は行わない。

## 調査結果

- 関連ファイル: `spec/{idea,requirements,scenario,domains,usecases,database,testcases,inventory,manual-tests}/`、`packages/core/src/{domain,application,adapters}/`、`apps/web/app/server.*`、`apps/web/app/worker/`、`apps/web/scripts/`、`apps/web/wrangler*.toml`、`infra/`、`docs/runtime_*.md`、各 `package.json`。
- あるべきアーキテクチャ: presentation は application port/usecase に依存し、application は domain に依存し、Cloudflare adapter は内側で定義した port を実装する。DO/RPC/SQLite 型は domain に入れない。Worker は認証・検証・ルーティング、DO はユーザー単位の stateful application boundary と SQLite transaction を担当する。
- 既存実装の状態: #1 は Node/libSQL を既定として identity を実装し、Cloudflare は D1、非同期処理は複数 provider の Outbox/relay/consumer に分岐している。検索の実装は未着手だが、spec は Vectorize/embedding/RRF と D1 Outbox を前提にする。Issueの目標とは大きく乖離しているため、互換レイヤーを残さず単一構成へ置換する。
- 依存関係: #1/PR #17 は完了済み。#19 は #18 と #10 の前提であり、#10 本文もこの変更で同期する。メモ・文書の本実装は後続 Issue のため、FTS 統合点を最小 command harness と transaction contract test で先に固定する。
- 現行 Cloudflare 仕様: Wrangler 4.90.1 では SQLite-backed DO、SQL/FTS5、Alarm、PITR が利用できる。2026-07-04 公開の宣言的 `exports` class lifecycle を新規 namespace に採用し、`storage = "sqlite"` を明示する。
- 現行コードには REST API と MCP server surface は存在しない。既存 UI/server action と将来追加される REST/MCP の両方が、session/token から得た canonical `userId` だけを受ける共通 `AuthenticatedUserDataRouter` application port を経由し、transport 入力から DO ID・partition key を指定できない契約にする。

## 設計

### レイヤー / contract map

| 配置 | 所有するもの | 依存・禁止事項 |
|---|---|---|
| domain | account identity / credential の業務不変条件、Profile/Settings、memo/document/topic/trash の aggregate/value object | operation/reservation/locator/epoch/reconciler、framework、DO/RPC/SQLite、暗号 API を持たない |
| application | usecase、async prepare、`SemanticCommitPort`、read-only `SearchIndexPort`、transaction-scoped `SearchProjectionPort`、identity operation/reservation/locator/epoch/reconciler coordinator と永続化 port、`AuthenticatedUserDataRouter`、primitive DTO | domain にだけ依存し、Cloudflare/HMAC/bucket/checkpoint 型を公開しない |
| Cloudflare adapter | `transactionSync` repository/projection、HMAC、bucket/active・previous 世代/checkpoint、DO stub/RPC、Alarm job、external egress の port 実装 | application/domain の port を実装する。外部 I/O を同期 transaction に入れない |
| presentation / Worker entry | session/token 検証、transport validation、canonical `userId` 生成、routing、error envelope/HTTP-form 変換 | repository、transaction、DO ID を transport input として公開しない |

### ドメインモデルへの影響

- Domain は account identity / credential の一意性、最後の login credential、primary email といった業務不変条件だけを所有する。credential shard mapping の operation/reservation、Account Home の locator/epoch/reconciler は application coordinator と永続化 port の型へ分け、HMAC、bucket、active/previous 世代、rotation checkpoint は Cloudflare adapter に閉じ込める。User Data 側は `Profile` / `Settings` aggregate（表示情報、`trashRetentionDays`、各 version）を所有し、既存 `UserRepository` は bounded port へ置換する。
- SSO link/unlink のユーザー向け UI/完成 usecase は実装しない。将来の primitive RPC と状態機械だけを設計・contract test に置き、最後の login credential を unlink できない、credential と `(provider, subject)` は全 shard で一意、primary email は残存 email credential を指す、pending link/unlink 中の login は Account Home の確定済み auth summary に従う、成功時は session epoch を更新する、という不変条件を固定する。
- `SearchIndexPort` は全文検索 read/query だけの最小 application port として通常 usecase に提供する。upsert/remove は別の transaction-scoped `SearchProjectionPort` に限定し、通常 DI や検索 usecaseへ単独注入せず、`SemanticCommitPort` 実装の `transactionSync` callback 内だけで本体 repository と同期 commit する。transaction callback は Promise・暗号・RPC・メール等の外部 I/O を一切含まない。
- 認証済み利用者の `UserId` が User Data DO の唯一の partition key であることを不変条件とし、リクエスト DTO や公開 RPC に DO ID/userId の上書き入力を持たせない。
- credential shard と Account Home の application state ports は credential key の一意性と状態遷移（reserved → initialized → active、link/unlink/reset/delete pending 等）、account 全体の credential locator、auth summary、saga と deletion epoch を永続化する。これらは domain aggregate ではない。User Data DO は利用者個人のデータと設定を所有し、パスワードハッシュ、reset token、メール→userId 索引を所有しない。

### ユースケース / アプリケーションロジック

- request Worker は認証、transport validation、DO routing、RPC envelope の presentation error への変換だけを行う。User Data/Identity Directory の application usecase は各 DO 内で async prepare を実行し、同期 commit は semantic typed command を受ける DO 専用 `SemanticCommitPort` に限定する。既存の Promise-based `UnitOfWorkProvider.run` は DO SQLite commit に流用せず、repository/UoW やクロージャを RPC 越しに渡さない。
- request Worker と state/DO Worker の RPC は JSON/structured-clone 可能な primitive DTO と `{ ok: true, value } | { ok: false, error: SerializedError }` envelope に限定する。mutation は request 境界で生成・再利用する operation ID を必須とし、DO 側 idempotency table と対応させる。
- identity は既存 #1 の signup/login/current-user/logout を Account Home、credential shard、User Data DO の narrow RPC へ移行する。password change/reset、SSO link/unlink、export は完成 usecase/UIを作らず、保存 schema、再開可能な saga primitive、非公開 RPC contract と運用手順までに限定し、#11/#12/#15へ引き継ぐ。外部 I/O を SQLite transaction 内に保持せず、stable operation ID と `userId`/credential locator から進行中 operation を再取得し、各 fault point から再開する。
- SSO provider/subject の lookup/create primitive は OAuth UI なしで実装し、初回作成、同一 operation/credential の再送、同一メール競合、provider が異なる同一 subject の分離、active/previous key rotation 中の lookup/create を決定的 contract とする。password reset は token hash/expiry/one-time consume とメール job の schema/port/saga contract、および登録有無を漏らさない同一成功応答だけを固定する。
- 認証後、request Worker は session の canonical `userId` から Account Home を直接引いて primary email/auth summary を取得し、同じ `userId` の User Data DO から Profile/Settings を取得して current-user DTO を合成する。どちらかが unavailable/PITR 中なら古い片側だけで成功扱いにせず retryable infrastructure error とし、利用者入力で partition を切り替えない。
- trash retention と外部 I/O ジョブは永続 job table と単一 Alarm を使う。job は `leaseUntil`、`ownerToken`、attempt、nextRunAt、provider idempotency key、status/terminal reason を持ち、期限切れ lease の reclaim と owner token の CAS completion を行う。最大試行後は poison/terminal に隔離する。job mutation と最早 `nextRunAt` の再読は `transactionSync` の戻り値にし、commit 後にだけ `await ctx.storage.setAlarm(nextRunAt)` を実行する。`setAlarm` 失敗時は次の DO input gate で DB の最早時刻を再計算して再設定する。検索索引は外部 I/O ではないため同期更新し、Alarm へ送らない。

### アダプター / 永続化 / 外部連携

- request path と DO class は別 Worker script にする。request Worker だけに `SESSION_SECRET` と versioned `DIRECTORY_ROUTING_SECRET` keyring を設定し、`script_name` 付き DO binding/service binding で state/DO Worker へ接続する。state Worker にこの2つの routing/session secretは禁止し、Alarm の外部 I/O に必要な `MAIL_*` 等の external adapter secret だけを対象 binding に最小配布する。より厳格な環境では secret-bearing egress Worker の service binding に隔離する。
- `UserDataDurableObject` はユーザー単位 SQLite、application usecase、semantic commit adapter、FTS、job runner、export/delete の低レベル primitive を提供する。`IdentityDirectoryDurableObject` は credential shard mapping を、独立 SQLite class の `AccountHomeDurableObject` は `userId` 単位の account summary、application coordinator state、非 PII tombstone/epoch を保持する。3 class それぞれに exports、binding、forward-only lazy migration と contract/integration test を置く。
- routing key は request Worker の active/previous version付き keyring で HMAC-SHA-256 し、正規化メールや SSO subject を DO name・ID・構造化ログへ直接入れない。credential shard mapping には rotation 用の canonical credential value を sensitive field として保存するが、DO name/ID、ログ、監査イベントへは出さない。新規登録・移送は Account Home が active/previous 全 locator を安定ソートして決定順に予約し、競合時は既存 active mapping または最小 operation ID を勝者として補償を再開する。
- rotation は public endpoint を持たない operator-only maintenance binding から全固定 bucket を checkpoint 付きで走査し、canonical value を request-side keyring で再 HMAC して active shard へ移送する。mapping と Account Home reverse locator の双方を冪等更新し、bucket別 scanned/moved/conflict count と checkpoint を監査する。全 bucket の previous mapping/reverse locator が0件になった後だけ previous keyを破棄する。固定 shard 数の変更も同じ protocol とする。
- 複数 Directory shard と User Data DO を跨ぐ操作は分散 transaction にしない。Account Home が saga の権威となり、決定順 reservation と operation ID で再試行する。credential shard の Alarm/reconciler は Account Home の operation/epoch と User Data 初期化状態を照会してから `initialized` を確定するか、未初期化かつ期限切れの reservation だけを回収する。
- 退会は Account Home に `deleting` tombstone と単調増加 operation epoch を先に永続化して login・credential 再利用・新規 link を遮断し、全 locator を tombstone 化してから User Data `deleteAll()` の確認を取り、最後に mapping を purgeする。削除完了後の Account Home には credential、email、auth summary、locatorを残さず、非 PII の `userId` 相当 opaque key、tombstone status、epoch、完了時刻だけを権威記録として残す。
- Account Home は PITR restore 対象外とする operator policy を採用し、admin tooling は class/namespace を allowlist で拒否する。Identity Directory/User Data を復旧するときは常に現在の Account Home tombstone/epoch を事前・事後に照合し、古い mapping/data を有効化しない。Account Home restore の拒否を wrapper contract、admin tooling integration、staging 手順で検証する。
- 3 DO schema はそれぞれ `schema_migrations` を持ち、constructor の `blockConcurrencyWhile` で forward-only migration を `transactionSync` 実行する。失敗は rollback され、次回起動で再実行する。
- 検索 query は Unicode NFKC で正規化し、UTF-8 で50 bytesを超える patternを境界で拒否する。1〜2文字は LIKE wildcard escape・対象列/page size 制限を行う SQL fallback、3文字以上は FTS5 trigram の `MATCH`/`bm25`/`snippet` と ID tie-breaker を使う。topic filter は optional 単一 topic とし、指定時は content が持つ多対多 relation にその topic が含まれる場合だけ一致、未指定は全 topic、unknown topic は空結果とする。page/offset の決定順と重複・欠落保証は1回の SQLite snapshot 内だけで、別 RPC page 間の同時更新までは保証しない。
- ベクトル要素を除く既存検索契約は維持する。`SearchResultItem` の memo/document 種別 DTO、active な `sourceOfDocumentIds` / `sourceMemoIds`、topic 配下 document の出典 memo を含む絞り込み、archive 済み topic の包含、UI と AI client で同じ `SearchIndexPort` query semantics を使うことを spec・projection・contract test に残す。source link の追加・削除も本体と同じ transaction で projection へ反映する。
- RPC adapter は `.retryable === true` の冪等 operationだけを新しい stub で上限付き指数 backoff し、`.overloaded` は即座に明示的 infrastructure error として返す。mutation retry は同じ operation ID を保持する。
- DO class lifecycle は Wrangler の宣言的 `exports` と `storage = "sqlite"` を使う。binding は request Worker にのみ公開し、RPC は narrow interface にする。SQLite 10 GB、CPU 30秒、SQL bound parameter 100、LIKE/GLOB pattern 50 bytes を guard/test に落とし、Alarm は batch/time budget、export は pagination/streaming、`SQLITE_FULL` は adapter error 変換で扱う。

### UI / プレゼンテーション

- 画面レイアウトの新設・変更はない。既存 signup/login/settings の server action を新しい Cloudflare context と identity saga に接続する。
- セッションから得た `userId` を request Worker 内で解決し、User Data DO の primitive RPC を呼ぶ。client/URL/form から DO routing key を受け取らない。
- REST/MCP surface は現コードに存在しないため実装対象外とするが、将来追加時も UI と同じ `AuthenticatedUserDataRouter` を必須とする architecture/contract test を置く。
- メモ・文書 lifecycle と検索は新規画面を追加せず、最小 command harness を integration test と local test Worker からのみ起動する。手動 CLI は `auxiliaryWorkers` の test-only binding 経由に限定し、本番 artifact/route/exported RPC から除外する。

## 実装ステップ

### 0. FTS5 の workerd spike で実行可能性を先に固定する

- **対象ファイル:** `.thread/19/spike/`, 最小の `vitest` / workerd fixture
- **変更内容:** SQLite FTS5 trigram table の生成、日本語3文字、1〜2文字の escaped fallback、`bm25` / `snippet`、MATCH の quote/operator escape、同点時の ID tie-breaker、pagination の重複・欠落を最小 schema で確認する。trigram が利用不能なら Step 1 以降へ進まず、代替 tokenizer と受け入れ条件への影響を ADR に記録して再計画する。
- **理由:** Cloudflare 固有の前提を大量の spec 改訂と実装より前に確定するため。

### 1. 上流要件・シナリオ・技術設計を単一 DO/FTS5 前提へ改訂する

- **対象ファイル:** `spec/idea.md`, `spec/requirements.md`, `spec/scenario/`, `spec/domains/index.md`, `spec/domains/{identity,memo,knowledge,trash,search}.md`, `spec/usecases/{identity,memo,knowledge,trash,search}.md`, `spec/database/`, `spec/testcases/`, `spec/inventory/`, `spec/manual-tests/`
- **変更内容:** hybrid/vector/D1/transport Outbox の有効な記述を削除し、account/credential の業務不変条件と application coordinator state を分離する。#19 は既存 #1 の signup/login/current-user/logout 移行、password change/reset・SSO link/unlink・export の schema/port/saga primitive/contract/運用手順、3つの独立 DO、read-only `SearchIndexPort`、transaction-scoped `SearchProjectionPort`、optional 単一 topic、非ベクトル検索契約、Alarm、migration、PITR policy を上流から下流へ定義する。完成 usecase/UI の #11/#12/#15 への引継ぎと、memo/document の最小 command harness 境界を正本へ明記する。identity spec には未登録・SSO-only・誤 password・不正形式で dummy verify を実行して同一公開エラーを返す login と、登録有無を問わず同一成功応答を返す reset contract、PII 非ログ出力を含める。
- **理由:** 実装の正となる設計を先に確定し、削除・置換の判断基準にするため。

### 2. domain と application の identity/search contract を先に定義する

- **対象ファイル:** `packages/core/src/domain/{identity,search}/`, `packages/core/src/application/{identity,search,execution}/`
- **変更内容:** domain は account/credential の業務不変条件だけに限定する。operation ID・reservation・locator・epoch・reconciler は application coordinator と `IdentityDirectoryPort` / `AccountHomePort` / `UserDataPort` へ分離し、HMAC/bucket/generation/checkpoint を持ち込まない。SSO provider/subject lookup/create、password change/reset、SSO link/unlink、退会、export の primitive DTO/state contract と、既存 #1 current-user 合成、login enumeration 耐性を定義する。検索は read/query 専用の最小 `SearchIndexPort`、`SemanticCommitPort` 実装だけが受け取る transaction-scoped `SearchProjectionPort`（upsert/remove）、typed command DTO を定義し、種別 DTO/source links/topic 出典 memo/archive/UI・AI 同一挙動を保持する。
- **理由:** adapter 実装より先に内向き contract を固定し、業務規則と分散処理・Cloudflare routing の実装都合を分離するため。

### 3. User Data DO の schema、migration、transaction adapter を作る

- **対象ファイル:** `packages/core/src/adapters/cloudflare/user-data/`, `apps/web/app/durable-objects/UserDataDurableObject.ts`
- **変更内容:** Step 2 の port/DTO に従い、`schema_migrations`、profile/settings、AI connection、memo/document/topic/revision/source/trash、FTS entry/topic/source join、idempotency/job tables と forward-only lazy migrationを実装する。DO usecase の async prepare は semantic typed commit command を作り、`SemanticCommitPort` が `transactionSync` 内で本体と transaction-scoped `SearchProjectionPort` を同期 commit する。projection capabilityは単独DI不可とし、本体失敗・projection失敗双方のrollback testを置く。create/update/remove/restore の最小 command harness を作る。
- **理由:** ユーザー単位の物理分離とローカル atomicity を実装の土台にするため。

### 4. Identity Directory DO、Account Home DO と秘密鍵付き shard routing を作る

- **対象ファイル:** `packages/core/src/adapters/cloudflare/{identity-directory,account-home}/`, `apps/web/app/durable-objects/{IdentityDirectoryDurableObject,AccountHomeDurableObject}.ts`, request Worker の routing adapter
- **変更内容:** Step 2 の application port に従い、`IdentityDirectoryDurableObject` と独立 SQLite class の `AccountHomeDurableObject` を実装する。request Worker の HMAC keyring、bucket/generation/checkpoint は adapter に閉じ、credential mapping、password/reset/SSO provider-subject schema、reservation/reconciler state、opaque locator、非 PII deletion tombstone/epoch、primitive envelope の冪等 RPCを永続化する。SSO lookup/create primitive は初回/再送/メール競合/provider境界/rotationを扱う。password change/reset・link/unlinkは非公開 primitiveまでとする。operator-only maintenance bindingで全bucketをcheckpoint scanし、Account Home restore はadmin tooling guardで拒否する。
- **理由:** login 前に userId を安全に解決し、単一 global DO のボトルネックと PII 漏えいを避けるため。

### 5. SearchIndex/FTS5 adapter を実装する

- **対象ファイル:** `packages/core/src/domain/search/`, `packages/core/src/application/search/`, `spec/domains/search.md`, `spec/usecases/search.md`
- **変更内容:** Step 2 の `SearchIndexPort` read query と transaction-scoped `SearchProjectionPort` を FTS5 adapter で実装する。vector/embedding/RRF を排除し、全文 search、page、optional単一topic、trash visibility、NFKC、UTF-8 50-byte guard、同一 snapshot の pagination を実装する。種別 DTO、source links、topic 出典 memo、archive 済み topic、UI/AI 同一 query semantics を保ち、source link の upsert/remove も semantic commit に含める。
- **理由:** 検索の利用要求に必要な能力だけを内側の契約に残すため。

### 6. Alarm 永続ジョブを User Data DO に実装する

- **対象ファイル:** `packages/core/src/adapters/cloudflare/user-data/search*.ts`, `packages/core/src/adapters/cloudflare/user-data/jobs*.ts`, `apps/web/app/durable-objects/UserDataDurableObject.ts`
- **変更内容:** job は leaseUntil/owner token/attempt/nextRunAt/provider idempotency key/poison reasonを持ち、期限切れreclaim、owner CAS completion、Cloudflare最大retry後の自前再設定を実装する。job mutationとDBの最早`nextRunAt`読取を`transactionSync`の戻り値にし、commit後に`await setAlarm`する。設定失敗時は次のDO input gateで最早時刻を再計算する。SQL parameter数、CPU/batch時間、容量超過をguardし、`SQLITE_FULL`を共通adapter errorへ変換する。
- **理由:** 検索を同期一貫にし、外部 I/O/retention だけを at-least-once 非同期処理へ限定するため。

### 7. request Worker と state/DO Worker の entry、binding、DI を構成する

- **対象ファイル:** `apps/web/app/server.cloudflare.ts`, state Worker entry, `apps/web/app/durable-objects/`, `packages/core/src/application/di/`, request/state 用 `apps/web/wrangler*.toml`, `apps/web/vite.config.cloudflare.ts`, root/web scripts, `infra/cloudflare/pulumi/{resources,routes}/`, `infra/cloudflare/package.json`
- **変更内容:** request path と3 DO class exportsを別 scriptに分離し、全 class を `script_name` 付き bindingで接続する。local `pnpm dev` は request configをprimary、state configをsecondaryにした単一の `wrangler dev -c apps/web/wrangler.request.toml -c apps/web/wrangler.state.toml` multi-configへ統一する。request configのcustom buildから `pnpm vite build --config apps/web/vite.config.cloudflare.ts --mode development` を呼び、`main`をその生成Worker artifactへ向けてからWranglerがrequest/stateを協調起動する。types生成→build→両Worker ready、共通persist directory、SIGINT/失敗時の両Worker teardownをscript/contract testで固定する。request secret隔離、state先→request後deploy、RPC互換windowを定義する。Cloudflare PulumiはDNS/routesだけ残し、resources/routesのD1・events/DLQ Queue outputsとstack referenceを削除する。`@repo/infra-cloudflare`と`cf:render:*`を2 Workerのroute/config生成へ更新する。
- **理由:** Worker script 単位の env 配布で request secret を DO から隔離し、RPC 越しに transaction closure を渡さない実行境界を作るため。

### 8. 既存 identity UI を DO-backed identity/application context へ接続する

- **対象ファイル:** `apps/web/app/components/auth/`, `apps/web/app/presentation/`, `apps/web/app/routes/`, `packages/core/src/application/di/serverCloudflare.ts`
- **変更内容:** 既存 #1 の signup/login/current user/logout だけを新しい saga と primitive DO RPC に接続し、公開入力から partition 指定を排除する。password changeは#11、password reset/SSO/OAuth UIは#12、export UIは#15へ残す。loginは未登録・SSO-only・誤password・不正形式の全分岐でdummy verifyを実行し、同じpublic error envelopeを返す。reset primitiveは登録有無を問わず同一success envelopeとし、PIIをログへ出さない。current user合成、REST/MCP共通router、error translationも移行する。
- **理由:** #1 の既存機能を単一ランタイム移行後も維持するため。

### 9. Outbox/relay/consumer/pruner/DLQ を同期 transaction/Alarm に置換する

- **対象ファイル:** `packages/core/src/application/events/`, `packages/core/src/adapters/cloudflare/`, `apps/web/app/worker/cloudflare/`
- **変更内容:** domain event は aggregate/usecase 内の監査・同一 transaction reaction を表す内向き契約として必要なものだけ保持し、外部配送を表す transport Outbox/`OutboxRepository`/relay/consumer/DLQ は削除する。ローカル FTS projection は domain event transport に載せず typed transaction operation とし、retention/外部 I/O だけを永続 job と Alarm handler に残す。
- **理由:** 同一 User DO 内で完結する処理に分散非同期基盤を持ち込まないため。

### 10. legacy 削除前に DO/workerd test harness を成立させる

- **対象ファイル:** `vitest.config*`, `packages/core/src/**/*.test.ts`, `apps/web/**/*.test.ts`, `test/` または既存 integration test 配置、手動 CLI
- **変更内容:** request Workerをtest worker、state Workerを`auxiliaryWorkers`として読み込み、3 DO classのgenerated types、exports/binding、各schema migration、RPC version contract、DO direct helper testと境界越しtestを分ける。Alarmは`runDurableObjectAlarm`、evictionは`evictDurableObject`、`.overloaded`/`.retryable`はsynthetic auxiliary workerで検証する。最小 lifecycle CLI はlocal test worker/auxiliary bindingだけを呼び、本番artifact/routeから除外する。物理分離、semantic commit rollback、memo/document lifecycleとFTS同期、3 class migration、identity happy pathがgreenになるまでlegacy adapterを削除しない。
- **理由:** 比較可能なテスト経路を保持したまま実行基盤を置換するため。

### 11. DO/workerd 統合テストを完成させて legacy runtime を撤去する

- **対象ファイル:** Step 10 の test harness、`apps/web/app/server.{node,aws,gcp}.ts`, `apps/web/app/worker/{node,aws,gcp}/`, `packages/core/src/adapters/{libsql,d1,node,aws,gcp}/`, `infra/{aws,gcp}/`, `infra/cloudflare/pulumi/{resources,routes}/`, `@repo/infra-cloudflare`, runtime別 config/script/docs, workspace/package manifests
- **変更内容:** identity はメール signup の各 fault pointに加え、SSO provider/subject lookup/createの初回、同一再送、同時初回、同一メール競合、別providerの同一subject境界、active/previous rotationを検証する。password change/reset、link/unlink、exportはprimitive/schema/contractだけを確認する。未登録・SSO-only・誤password・不正形式でdummy verifyと同一public error、resetの同一success、PII非ログを決定的に検証する。3 classのexports/binding/migration/fault injection、Account Home restore拒否、Directory/User Data restore前後の現行tombstone/epoch照合、FTSの種別DTO/source links/topic出典memo/archive/UI・AI同一契約、Alarmのcommit後setAlarmと失敗後input gate再計算を含める。Cloudflare PulumiのD1/Queue resource/output/stack referenceを削除しDNS/routesのみ残す。harnessをgreenに保って旧経路を削除する。
- **理由:** legacy test 経路の削除で回帰検出を失わず、Cloudflare固有挙動を固定したうえで保守対象を一つにするため。

### 12. 運用・セキュリティ文書を DO 単独構成へ更新する

- **対象ファイル:** `CLAUDE.md`, `README.md`, `docs/runtime_cloudflare.md`, `.dev.vars.example`, Cloudflare secret/config docs
- **変更内容:** multi-config local dev、state先→request後のdeploy/binding、RPC互換window、secret隔離、rotation、3 class migration、逐次export運用手順、退会削除、Alarm/reconciler障害対応を記載する。session secretの指定コマンドも維持する。PITRはUser Data/Identity Directoryだけをdisposable staging objectでsmokeし、Account Homeはrestore対象外であること、admin toolingが対象指定を拒否すること、復旧前後に現在の非PII tombstone/epochを常に照合することをrunbookと復旧マトリクスにする。password change/reset/SSO/export完成usecaseの#11/#12/#15への引継ぎを明記する。
- **理由:** 現行規則を ADR だけに閉じず、実運用可能にするため。

### 13. ADR を記録し旧 ADR を supersede する

- **対象ファイル:** `.thread/19/adr.md`, `.issue/1/adr.md`, `spec/adr/005-search-index-via-outbox.md`
- **変更内容:** ランタイム/配置、FTS5、Alarm、Directory shard、DO lifecycle の判断を記録し、旧本文を保持した pointer を追加する。
- **理由:** 過去判断と現行判断の履歴を追跡可能にするため。

### 14. Issue #10 を改訂後 inventory と同期する

- **対象ファイル:** GitHub Issue #10
- **変更内容:** FTS5 単独の目的・チェックリスト・依存関係へ本文を更新し、vector関連項目を削除する。
- **理由:** 後続実装が廃止済み設計を再導入しないようにするため。

### 15. 全体検証と旧前提の残存監査を行う

- **対象ファイル:** リポジトリ全体
- **変更内容:** typecheck、lint、unit、DO integration、Cloudflare build/dry-run、local-only lifecycle CLI、staging PITR smokeを実行する。通常の`pnpm dev`が単一multi-config Wranglerでrequest primary/state secondaryを起動し、Vite custom build、generated types、ready、persist、teardownを通して既存#1 identity smokeへ到達することを確認する。3 class exports/migration、Account Home restore拒否、Cloudflare PulumiのDNS/routes以外のD1/Queue output不在、secret隔離、CLI/REST/MCP境界を検証し、D1/libSQL/AWS/GCP/Vectorize/embedding/RRF/hybrid/transport Outboxのactive pathをallowlist監査する。
- **理由:** 大量削除後の構成整合性と設計同期を機械的に確認するため。

### 16. ADR を昇格して成果物を片付ける

- **対象ファイル:** `.adr/`, `.thread/19/`
- **変更内容:** 寿命テスト・波及テストを満たす判断を連番 ADR に昇格し、review 中間ファイルだけを削除する。
- **理由:** Issue の明示的な永続 ADR 受け入れ条件を満たすため。

## 設計判断

- 2 Worker構成、検索/typed projection、非同期処理、Identity Directory application coordinator/saga/key rotation、DO class lifecycle、DO内usecase/RPC、最小command harness、PITR検証環境の判断は `.thread/19/adr.md` を参照する。

## リスクと注意点

- #1 の identity は shared DB transaction と単一 `User` aggregate を前提にしている。domain の account/credential 業務規則、application の CredentialShardMapping / AccountHome coordinator state、User Data の Profile/Settings への分割を spec と fault injection test で先に固定する。
- FTS5 trigram と日本語短語の挙動は SQLite build に依存する。workerd テストで利用不能なら実装を進めず、tokenizer 選定を ADR に再記録する。
- RPC は callback UoW や custom error class を透過できない。primitive DTO/envelope 以外を公開 contract に入れず、operation ID を持つ冪等 mutation 以外は自動 retry しない。
- secret は script 単位で配布される。request/state script の binding を統合すると隔離が破れるため、生成された Wrangler config と deploy dry-run で state Worker env に request secret がないことを検査する。
- 宣言的 `exports` は新しい Wrangler lifecycle で、従来 `migrations` へ戻せない。未 deploy の新規 namespace であることを確認し、全環境を同一方式に揃える。
- DO SQLite は object ごとの migration なので、一括 migration 完了を前提にできない。旧 schema を読むコードと新 schema への lazy migration の互換期間を管理する。
- PITR は local workerd では検証できず、Directory/User Data DO 間の整合性も一括復旧しない。local は wrapper contract、staging は手動 smoke、DO間は復旧後 reconciler で責務を分ける。
- SQLite DO の容量、CPU、SQL parameter/pattern 上限は利用者データ量と検索・Alarm・export に影響する。入口 guard、bounded batch、streaming、容量超過の error translation を実装し、巨大ユーザーへの shard 分割は別 ADR/Issue とする。
- 大量の削除で package lock、generated type、route/build config に残存参照が出やすい。レイヤーごとの小さなコミットと最終残存監査で制御する。
- domain event と transport Outbox を混同すると廃止経路が再導入される。domain event は内向きの業務表現、FTS は typed local projection、外部 I/O は永続 job と明示して監査する。

## テスト方針

- domain unit test で account/credential の業務不変条件を、application unit test で coordinator/saga/reconciler、reset primitive、query normalization、RPC/job policy を検証する。versioned HMAC keyring、bucket/checkpoint は Cloudflare adapter test で検証する。
- workerd integration test で request test worker/state `auxiliaryWorkers` binding、generated types、異なる userId の物理分離、primitive RPC/version envelope、同一 operation ID、semantic commit rollback、lazy migration 冪等性、PITR wrapper contract、Cloudflare limits guardを確認する。
- identity fault injection test でactive/previous locator競合、signup各fault、SSO lookup/createの初回/再送/同時初回/メール競合/provider境界/rotation、将来用change/reset/link/unlink/export primitive、非PII tombstone/epoch、reconciler再起動を確認する。Account Home restoreを拒否し、Directory/User Data復旧より常に現行Account Homeを照合する。
- FTS transaction contract test で最小 command harness の memo/document create/update/remove/restore、本体/FTS各失敗時のrollback、NFKC、日本語、短語、順位、snippet、topic、trash、paginationに加え、種別DTO、source links変更、topic出典memo、archive済みtopic、UI/AI同一query semanticsを確認する。
- Alarm test で at-least-once、provider idempotency key、lease expiry/reclaim、owner CAS、poison、commitで返した最早`nextRunAt`をcommit後`await setAlarm`すること、失敗後の次input gate再計算、再起動、batch/time budgetを確認する。
- presentation regression test で既存#1のsignup/login/current user合成/logout、未登録・SSO-only・誤password・不正形式のdummy verify/同一public error、reset primitiveの同一success、unauthorized routing、RPC error translation、REST/MCP不在と将来の共通routing contractを確認する。
- 手動 CLI はlocal test Worker/auxiliaryWorkers経由だけでmemo/document lifecycleと検索結果を確認し、本番artifact/routeから除外されることを検査する。認証済み staging のdisposable objectでPITR smokeを行い、local workerdにrestoreの合否を求めない。
- `pnpm typecheck`、`pnpm lint`、`pnpm test:unit`、DO integration、`pnpm build`、2 Worker の Wrangler dry-run、legacy allowlist監査を最終ゲートにする。

## レビュー履歴

- 1周目（2026-07-28）: 全指摘を反映。request/state Worker の分離と secret 隔離、DO 内 usecase/local UoW と primitive RPC envelope/retry、identity aggregate 分割・password reset・全 fault point/reconciler/key rotation/reverse reference、typed FTS projection と複数 topic、先行 workerd spike、最小 lifecycle command harness + manual CLI、identity/memo/knowledge/trash spec同期、staging PITR、legacy allowlist、domain event/transport Outbox境界、Cloudflare limits guard、legacy削除前test harnessを計画化した。改善提案も同じ実装・テスト・運用ステップへ取り込んだ。
- 2周目（2026-07-28）: 全指摘を反映。async prepare→`SemanticCommitPort.transactionSync`、CredentialShardMapping/AccountHome coordinator、SSO link/unlinkの設計限定と不変条件、current-user合成、state Workerのsecret最小化、deletion tombstone/epoch、job lease/CAS/poison/alarm競合、operator-only全bucket rotation、REST/MCP共通routing契約、指定secretコマンド、local-only CLI、optional単一topic、layer map、`auxiliaryWorkers`/synthetic helper、snapshot/NFKC/50-byte guard、2 Worker deploy/RPC/rollbackを実装・検証可能な契約へ固定した。
- 3周目（2026-07-28）: 全指摘を反映。独立`AccountHomeDurableObject`を含む3 class、read-only `SearchIndexPort`とtransaction-scoped `SearchProjectionPort`、#1移行と#11/#12/#15引継ぎ、SSO lookup/create契約、非ベクトル検索契約、domain/application/adapter責務分離、Account Home restore拒否、内側優先の実装順、Wrangler multi-config local devとVite custom build、login列挙耐性、Cloudflare Pulumi縮小、commit後`setAlarm`を受け入れ・実装・テスト・運用条件へ固定した。未解決指摘はない。
