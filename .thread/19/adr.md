# ADR — Issue #19: Cloudflare Workers + Durable Objects に集約し、検索設計を単純化する

## ADR-001: Cloudflare Workers とユーザー単位 SQLite-backed Durable Objects に集約する

### Status
Approved; promoted to `.adr/001`

### Context
既存実装は Node/libSQL、Cloudflare/D1、AWS/Turso、GCP/Turso の4実行経路を保守し、利用者データを共有 DB の `user_id` で論理分離している。一方 fog のデータは共有・共同編集・テナント横断検索を行わず、利用者単位で完結する。

### Decision
本番・開発・テストの実行経路を Cloudflare Workers に一本化する。request Worker と state/DO Worker は別 script とし、`SESSION_SECRET` と versioned `DIRECTORY_ROUTING_SECRET` keyring は request Worker だけに配布する。state Worker にこの2 secretは禁止し、Alarmが必要とする`MAIL_*`等のexternal adapter secretだけを対象bindingへ最小配布するか、secret-bearing egress Workerへ隔離する。request Worker は認証済み session/token の `userId` だけから `script_name` 付き binding 経由で state Worker の stub を解決し、各利用者のドメインデータは1つの SQLite-backed User Data Durable Object に置く。現コードにREST/MCP surfaceはないが、将来追加するtransportも共通`AuthenticatedUserDataRouter`を経由し、入力からDO ID/partitionを選べない。local `pnpm dev` は request configをprimary、state configをsecondaryにした単一の公式multi-config `wrangler dev -c apps/web/wrangler.request.toml -c apps/web/wrangler.state.toml` とし、request configのcustom buildからCloudflare用Vite buildを実行して生成Worker artifactを`main`へ接続する。types生成、両Worker ready、共通persist、teardownを同じdev scriptで管理する。deployはstateを先、requestを後とし、RPC version envelopeと新旧片側混在・rollbackを最低1リリースwindow互換にする。Node/libSQL、D1、AWS、GCP の実行経路と互換 adapter は削除する。Cloudflare PulumiはDNS/routesだけを残し、D1・events/DLQ Queue resource/output/stack referenceを削除して2 Workerのroute/config生成へ縮小する。

### Consequences
- 良い点: 保存領域が物理分離され、ユーザー内の更新をローカル SQLite transaction と DO の直列実行で扱える。実行経路と運用を単純化できる。
- トレードオフ: 2 script のdeploy順序、RPC互換window、binding/secret配布、object単位のschema migration、export/PITR/delete、1 objectの容量・throughputを運用設計する必要がある。Cloudflareへのvendor lock-inを受け入れる。

---

## ADR-002: 検索は SQLite FTS5 全文検索だけを採用する

### Status
Approved; promoted to `.adr/002`

### Context
spec はキーワードとベクトル検索の統合、Vectorize、embedding、RRF を要求しているが、ベクトル検索を必須とする利用上の根拠や評価データはない。User Data DO の SQLite は FTS5 をサポートし、本体データと索引を同じ transaction で更新できる。

### Decision
検索は User Data DO 内の SQLite FTS5 に限定する。applicationにはread/queryだけの最小`SearchIndexPort`を残し、upsert/removeは`SemanticCommitPort`実装だけへ渡すtransaction-scoped `SearchProjectionPort`へ分離する。queryはUnicode NFKCで正規化し、UTF-8 50 bytesを超えるpatternを拒否する。日本語を空白分割に依存せず扱うため trigram tokenizer を第一選択とし、1〜2文字はwildcard escape・対象列/page size制限を持つ SQL fallback で扱う。検索 entry と topic は正規化したfact/source joinで結び、filterはoptional単一topicとする。指定時は配下documentとactive source memoを返し、unknown/trashed topicは`TOPIC_NOT_FOUND`にする。順位同点は`timestamp DESC, type, id`で決定し、最初のqueryで結果DTOを期限付きsnapshot tableへ固定してopaque cursorから同じ集合を読むため、page間mutationがあっても重複・欠落させない。FTSは`search_entries.rowid`をexternal-content tableのrowidとして使い、更新時の全virtual table scanとFTS側の本文複製を避ける。ベクトル要素以外の既存契約であるmemo/document種別DTO、activeな双方向source IDs、topic配下documentの出典memo、archive済みtopic、UI/AIの同一検索挙動は保持し、source link変更も本体と同じtransactionで確定する。Vectorize、embedding、RRF、`search_embeddings` は設計と実装から削除する。

### Consequences
- 良い点: 外部 index と非同期整合性が不要になり、検索結果の説明可能性、運用、コストが単純になる。
- トレードオフ: 意味類似検索は提供しない。trigram は index サイズが増え、短語 fallback は FTS より高コストなので対象列・page sizeを制限する。

---

## ADR-003: ローカル更新は同期 transaction、外部 I/O と retention は Durable Object Alarm で処理する

### Status
Approved; promoted to `.adr/003`

### Context
既存構成は D1 Outbox、relay、consumer、DLQ を各ランタイム向けに持つ。User Data DO 内の本体と FTS index は同じ SQLite にあり、分散 delivery を挟む理由がない。一方、外部 I/O と期限付き trash retention は request transaction から分離し、失敗後も回復する必要がある。

### Decision
本体と FTS index は同一 SQLite transaction で同期更新する。DO application usecaseは外部I/Oなしのasync prepareを先に完了してsemantic typed commit commandを作り、`SemanticCommitPort`だけが`transactionSync`で本体repositoryとtransaction-scoped `SearchProjectionPort`を同期commitする。transaction callbackにはPromise、暗号、RPC、メール等の外部I/Oを入れず、read/query用`SearchIndexPort`からwrite capabilityへ到達させない。domain event は内向きの業務表現として必要なものだけ保持し、外部配送用 transport Outbox/relay/consumer/DLQ は削除する。外部 I/O と retention だけを永続 job table に記録し、単一の DO Alarm で due job を処理する。jobはoperation key、canonical payload digest、attempt、nextRunAt、statusに加えて`leaseUntil`、`ownerToken`、provider idempotency key、terminal/poison reasonを持つ。同じID/keyの異payloadはconflictとし、期限切れleaseを専用indexからreclaimしてowner tokenのCASで完了する。現在producerが存在するjobはUser Data内で完結するtrash retentionだけなので、汎用enqueue RPCや未設定egress bindingは公開せず、既知の`purge-trash` executorだけを配線する。将来外部I/O jobを追加するときは同じリリースで実executor/secret-bearing egressとproducerを追加する。Alarmは1件ずつclaimして最大25件・10秒のbudgetを各job間で確認し、実完了時刻でcomplete/retryする。job mutationとDBの最早`nextRunAt`読取は`transactionSync`の戻り値にする。通常のDO inputでは既存alarmより早い場合だけ`await ctx.storage.setAlarm(nextRunAt)`し、Alarm handlerの`finally`ではretry/terminal cleanupを継続するためDBの最早時刻へ必ず再設定する。過去または現在時刻のdue jobは同じinput中の即時Alarm発火と競合しないよう、DBの`nextRunAt`は変えずplatform alarmだけを現在時刻の1秒後へclampする。設定失敗時は次のDO input gateでDBから最早時刻を再計算する。completed/poison rowは異なるretention期間でpruneし、長期scanをboundedにする。

### Consequences
- 良い点: 検索の結果整合性と relay/consumer/DLQ 運用を除去でき、非同期処理の状態が利用者データと同じ場所に残る。
- トレードオフ: Alarm は厳密時刻や exactly-once を保証しない。外部 I/O adapter はprovider idempotency keyを扱い、lease監視、poison job、Alarm再設定の運用手順が必要になる。

---

## ADR-004: Identity Directory は秘密鍵付き決定的キーで分割し、DO間操作は冪等 saga とする

### Status
Approved; promoted to `.adr/004`

### Context
login 前は `userId` が分からないため、正規化メールまたは SSO provider/subject から利用者を解決する directory が必要である。単一 global DO はボトルネックになり、生メールや subject を DO name に使うと identifier やログから個人情報が漏れる。Directory shard と User Data DO を跨ぐ atomic transaction は利用できない。

### Decision
Domainはaccount identity/credentialの一意性、最後のlogin credential、primary emailといった業務不変条件だけを所有する。operation ID、reservation、locator、epoch、reconcilerはapplication coordinatorとその永続化portへ分離し、HMAC、bucket、active/previous世代、rotation checkpointはCloudflare adapterに閉じる。`IdentityDirectoryDurableObject`はcredential shard mappingを、独立した`AccountHomeDurableObject`はcanonical `userId`から引くaccount summary/coordinator stateを永続化する。canonical valueはrotationの再HMACに使うsensitive fieldで、DO name/ID・ログ・監査イベントには出さない。

credential key は request Worker だけが持つ active/previous version付き `DIRECTORY_ROUTING_SECRET` keyring で HMAC-SHA-256 し、version付き固定 bucketへ写像する。requestがoperation IDとcanonical `userId`を先に生成し、Account Homeがactive/previousを含む全locatorを安定ソートして決定順に予約する。同時競合は既存active mappingまたは最小operation IDを勝者とし、敗者のreservationを冪等補償する。lookupはactive→previousとする。rotationはpublic endpointを持たないoperator-only maintenance bindingが全固定bucketをcheckpoint付きscanし、canonical valueをrequest-side keyringで再HMACしてactive shardへ移送する。mappingとAccount Home locatorを更新し、全bucketのprevious mapping/reverse locatorが0件になった後だけ旧鍵を破棄する。

既存#1のsignupとUser Data初期化はstable operation ID付きの再開可能なsagaとし、login/current-user/logoutを新DOへ移行する。password change（#11）、password reset・SSO link/unlink/OAuth UI（#12）、export完成usecase/UI（#15）は実装せず、#19ではschema、port、再開可能なsaga primitive、非公開RPC contract、運用手順までを定義する。SSO provider/subject lookup/create primitiveは初回、再送、同一メール競合、provider境界、active/previous rotationを扱う。link/unlinkは最後のlogin credentialをunlink不可、global uniqueness、primary email整合、pending中login、session epoch更新を不変条件とする。loginは未登録・SSO-only・誤password・不正形式でdummy verifyを実行し、同一public errorを返す。resetは登録有無を問わず同一success contractとし、PIIをログへ出さない。

退会はAccount Homeに`deleting` tombstoneと単調増加epochを先に永続化してlogin/reuse/linkを止め、credential locatorをtombstone化し、User Data delete確認後にmappingをpurgeする。削除完了後のAccount Homeにはcredential/email/auth summary/locatorを残さず、opaque account key、tombstone status、epoch、完了時刻だけを非PIIの権威記録として残す。Account HomeはPITR restore対象外とするoperator policyを採用し、admin tooling guardで対象指定を拒否する。Identity Directory/User Dataのrestoreは常に現在のAccount Home tombstone/epochを事前・事後に照合し、削除済みmapping/dataを復活させない。生credentialをUser Dataへ複製しない。

### Consequences
- 良い点: lookup を水平分割でき、PII の推測耐性と一意性を両立できる。部分失敗を明示的に回復できる。
- トレードオフ: Account Home coordinatorとcredential shard間は分散sagaになり、一時状態・決定順reservation・補償が必要になる。Account Homeをrestoreできないoperator制約とadmin tooling guard、canonical credentialのaccess policy、secret keyring併用期間、全bucket scan、期限切れreservation、復旧時のtombstone照合を運用する。

---

## ADR-005: 新規 Durable Object namespace は宣言的 class exports で管理する

### Status
Approved; promoted to `.adr/005`

### Context
Cloudflare は2026年7月に Durable Object class lifecycle の宣言的 `exports` を公開し、従来の順序付き `migrations` 配列を置換できるようにした。fog はまだ本番 DO namespace を持たず、既存データを移行する必要がない。

### Decision
lockfileで解決した Wrangler 4.114.0 の `exports` で `UserDataDurableObject`、`IdentityDirectoryDurableObject`、`AccountHomeDurableObject` の3 classを `type = "durable-object"`、`storage = "sqlite"` として宣言する。staging/production/local の全設定を同方式に揃え、3 classそれぞれのbinding、forward-only lazy migration、fault injection testを用意する。

### Consequences
- 良い点: class の現状態が設定の source of truth になり、SQLite backend を明示できる。
- トレードオフ: 一度 `exports` を deploy した後は旧 `migrations` 配列へ戻せない。Cloudflare class lifecycle と各 object 内 schema migration を別々に管理する必要がある。

---

## ADR-006: application usecase と Unit of Work は DO 内で実行し、RPC は値の envelope に限定する

### Status
Approved; promoted to `.adr/006`

### Context
現行 `UnitOfWorkProvider.run(fn)` の callback と repository は RPC 越しに運べず、Workers RPC の custom error伝搬も既存 `CodedError` の構造的serialize契約を保証しない。request Workerでusecaseを実行してremote repositoryを注入すると、DO SQLite transactionの範囲とapplication transactionが一致しない。

### Decision
User Data/Identity Directory/Account Home の application usecase は各 DO 内で実行するが、既存のPromise-based callback UoWをDO SQLite commitに流用しない。usecaseはasync prepareで外部I/Oなしの処理を終えてsemantic typed commandを作り、DO専用`SemanticCommitPort`の同期adapterが`transactionSync`でcommitする。read/query用`SearchIndexPort`はapplication usecaseへ提供するが、upsert/removeを持つ`SearchProjectionPort`はtransaction-scoped capabilityとして`SemanticCommitPort`実装だけへ渡す。narrow RPCはprimitive DTOと明示的な `{ ok: true, value } | { ok: false, error: SerializedError }` だけを返し、repository、closure、transaction capability、custom error instanceを境界外へ出さない。

### Consequences
- 良い点: async application処理と同期SQLite transactionの境界が明確になり、Promise/外部I/Oの混入とFTS適用漏れを型で防ぎ、error contractとretry条件をtransport境界で型付けできる。
- トレードオフ: application usecaseのDIがrequest/state Workerに分かれ、read modelの合成とserialized error mappingがrequest側に必要になる。

---

## ADR-007: #19 の memo/document 受け入れ確認は最小 DO command harness で行う

### Status
Approved; retained as Issue-specific verification history

### Context
Issue #19 はmemo/documentのcreate/update/remove/restoreとFTS整合を要求するが、本番UIと完成版usecaseは後続Issueの範囲で、現時点では操作画面がない。adapter fixtureだけではtransaction contractを検証できず、受け入れ条件を後続へ移すとIssueの意図を下げる。

### Decision
#19 では本番UIや完成版memo/document usecaseを作らず、User Data DO内application boundaryからsemantic typed commandを同期commitする最小command harnessを実装する。create/update/remove/restore、optional単一topic、trash除外をworkerd integration testとlocal test Worker/`auxiliaryWorkers`経由の手動CLIで検証し、このcontractを後続Issueが本番usecase/UIへ接続する。CLI用binding/RPC/routeはproduction artifactから除外し、ブラウザ操作項目が存在しないことはtesting文書に明記する。

### Consequences
- 良い点: 後続機能のスコープを先食いせず、Issue #19 のlifecycle/FTS atomicityを実際のcommand境界で検証できる。
- トレードオフ: harness/CLIは本番ユーザー機能ではなく、後続実装時に同じtransaction contractへ接続する追跡が必要になる。

---

## ADR-008: PITR は staging 手動 smoke、local は wrapper contract で検証する

### Status
Approved; promoted to `.adr/007`

### Context
SQLite-backed Durable ObjectsのPITRはlocal developmentで利用できず、workerd integration testでrestoreを確認できない。またDirectoryとUser Dataは別DOのため、単一DOのPITRだけではidentity saga全体の整合性は戻らない。

### Decision
local/workerdの自動品質ゲートはPITR wrapperの入力、error変換、migration/export/deleteとの契約までとする。実restoreは認証済みstaging namespaceのdisposableなUser Data/Identity Directory object/bookmarkだけで確認する。Account Homeはrestore対象外とするoperator policyを採用し、wrapperとadmin toolingがclass/namespace指定を拒否するcontract/integration testを置く。User Data/Identity Directory復旧の前後には現在のAccount Homeに残る非PII tombstone/epochを必ず照合し、古いcredential mapping/dataを有効化しない。対象bookmark、実施日時、照合結果、後片付けを記録する。

### Consequences
- 良い点: 実行不能なlocalテストを要求せず、Cloudflare実環境で運用経路を確認できる。
- トレードオフ: staging資格情報と手動実施記録がリリースゲートに必要になり、Account Homeの誤restoreを防ぐ権限・tooling guardと、DO間reconciliation手順の継続保守が必要になる。

---

## ADR-009: #19 は既存 identity 移行と将来 primitive の確立までに限定する

### Status
Approved; retained as Issue-specific scope history

### Context
#19 の目的はCloudflare DOへの保存・所有境界の移行であり、既存#1のsignup/login/current-user/logoutは維持する必要がある。一方、password change、password reset/SSO、user exportの完成usecase/UIは#11/#12/#15の縦スライスである。

### Decision
#19でユーザー向けに移行するのは既存#1のsignup/login/current-user/logoutだけとする。password change/reset、SSO link/unlink、exportは必要なschema、application port、再開可能なsaga primitive、非公開RPC contract、contract test、運用手順までを実装し、完成usecase/UIは#11/#12/#15へ引き継ぐ。ただしSSO provider/subjectの一意なdirectory解決を保証するlookup/create primitiveは#19の基盤契約として実装・検証し、OAuth UIは作らない。

### Consequences
- 良い点: 基盤移行の受け入れ条件を満たしながら、後続Issueのユーザー体験と完成usecaseを先取りしない。
- トレードオフ: primitiveが存在しても公開UIからは利用できず、後続Issueで認可・presentation・完全なシナリオテストを接続する必要がある。

---

## ADR-010: Account Home を identity saga と session のオンライン権威にする

### Status
Approved; promoted to `.adr/008`

### Context
Directory mapping だけで login を成立させると、signup の部分失敗、退会処理中、Directory PITR、credential mutation 後の旧 session を区別できない。複数 DO の一時状態を stateless session token だけで失効させることもできない。

### Decision
signup transport は再送中保持する stable operation ID を生成し、その値を proposed user ID として一度だけ確定する。application の `IdentityCoordinator` は Account Home に operation kind・payload fingerprint・phase・epoch を最初に保存し、Directory reservation、User Data 初期化、Directory active 化、Account Home active 化を保存済み phase から再開する。adapter は versioned value envelope の routing／永続化 primitive と typed retry だけを所有する。

login は active/previous Directory lookup と password verify の後、Account Home の `active` status、reverse locator、operation epochを照合する。session tokenには発行時 `sessionEpoch` を署名し、すべての protected execution pointの共通guardが現在の Account Home status/epochと照合する。password reset、link/unlink、deletionは同じoperationの再送ではepochを一度だけ進め、古いtokenを拒否する。

### Consequences
- 良い点: Directory の一時状態や古い復旧データだけで認証が成立せず、部分失敗と再送を同じoperationへ収束できる。
- トレードオフ: protected requestごとにAccount Home RPCが1回必要になる。Account Home unavailable時は古いtokenを信頼せずfail closedにする。
