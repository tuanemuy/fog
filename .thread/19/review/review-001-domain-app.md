### Domain / Application

#### Blockers

- **B-DA-001 — identity のユースケース／状態機械が adapter に流出しており、計画した依存方向になっていない**
  - 場所: `packages/core/src/application/identity/registerWithPassword.ts:33-63`、`packages/core/src/adapters/cloudflare/identityGateway.ts:118-210`、`packages/core/src/adapters/cloudflare/{account-home,identity-directory}/store.ts`
  - 理由: application usecase は hash 後に粗い `IdentityApplicationPort` を1回呼ぶだけで、signup の順序、再試行、saga 遷移は Cloudflare adapter と SQLite store が所有している。計画は operation/reservation/locator/epoch/reconciler coordinator を application に置き、adapter は narrow RPC／永続化 port を実装すると定めている。また本番経路は既存の `User` aggregate を使わなくなった一方、domain には password hash・SSO subject・settings を一体所有する旧 aggregate が残り、`spec/domains/identity.md` の `AccountIdentity` / `Profile` / `Settings` 境界とも一致しない。業務状態遷移が外側の実装詳細に埋まり、domain/application 単体で不変条件を保証できない。
  - 提案: application に signup/SSO/link/unlink/reset/delete の coordinator と状態遷移を置き、`CredentialDirectoryPort`、`AccountHomePort`、`UserDataIdentityPort` を分離する。store は永続化と driver error 変換だけに縮め、domain model は現行 spec の所有境界へ更新する。

- **B-DA-002 — 公開 signup 経路が stable operation ID / user ID を再利用できず、部分失敗から回復できない**
  - 場所: `apps/web/app/components/auth/SignupForm/action.ts:7-20`、`packages/core/src/application/identity/registerWithPassword.ts:5-8,37-52`、`packages/core/src/adapters/cloudflare/identityGateway.ts:126-210`
  - 理由: transport input に `operationId` がなく、usecase は呼び出しごとに `userId` と `operationId` を新規生成する。reserve 後や User Data 初期化後に RPC が失敗すると、ユーザーの再送は別 operation/user になり、残った reservation を `CREDENTIAL_ALREADY_REGISTERED` として扱う。さらに gateway は Account Home に operation を永続化する前に Directory を reserve し、`reclaimExpired` は Account Home / User Data を照会せず予約を削除するため、AC-3 の「全 fault point、同一 operation 再送、reconciler、orphan/二重 user なし」を満たさない。
  - 提案: request 境界で一度作った idempotency key を再送可能な入力にし、Account Home に operation ID・user ID・入力 digest・phase を最初に保存する。保存済み phase から再開する coordinator と、Account Home epoch / User Data 状態を確認して activate/reclaim する reconciler を実装し、各 RPC 境界の fault injection test を追加する。

- **B-DA-003 — password login が Account Home の権威状態を確認せず、削除中／削除済みアカウントを認証できる**
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:125-143`、`packages/core/src/adapters/cloudflare/identityGateway.ts:212-227`
  - 理由: login は Directory の active mapping と password hash だけで成功し、Account Home の `status`、確定済み auth summary、credential locator、operation/session epoch を読まない。退会 saga は Account Home を先に `deleting` にする設計なので、Directory tombstone までの間は正しい password で新規 session を発行できる。`spec/usecases/identity.md` の login 手順5と削除遮断不変条件に反する。
  - 提案: application の authenticate usecase で Directory lookup/verify 後に Account Home authority を必ず照合し、active・現行 locator/epoch の場合だけ成功させる。deleting/deleted/pending は公開上同じ `INVALID_CREDENTIALS` に収束させる contract test を追加する。

- **B-DA-004 — Issue #19 が固定すべき identity primitive / saga contract が実行可能な application API になっていない**
  - 場所: `packages/core/src/application/identity/contracts.ts:56-96`、`packages/core/src/adapters/cloudflare/identityGateway.ts:118-245`、`apps/web/app/durable-objects/{IdentityDirectoryDurableObject,AccountHomeDurableObject}.ts`
  - 理由: `IdentityPrimitivePort.reserveSsoCredential` は実装がなく、SSO test は HMAC locator、email conflict、Account Home、active/previous rotation を通らず単一 Directory store の `reserve` を直接呼ぶだけである。password change、reset saga、SSO link/unlink の operation/phase・last credential・primary email・session epoch contract もない。削除は Account Home の局所メソッドだけで、Directory の `tombstone` / `purge` は RPC に公開されず、返す locator も generation/bucket を失うため coordinator が対象 shard を選べない。AC-2、AC-3、AC-13 の primitive contract を後続 usecase が利用できない。
  - 提案: versioned application command/result と各 saga の phase transition port を定義し、SSO lookup/create、reset、link/unlink、deletion を coordinator から最後まで実行可能にする。provider/email競合、last credential、session epoch、全 locator、rotation/deletion epoch を型と contract test で固定する。

- **B-DA-005 — RPC envelope、error translation、retry contract が名目上だけで機能していない**
  - 場所: `packages/core/src/application/identity/contracts.ts:3-14`、`apps/web/app/durable-objects/*.ts`、`packages/core/src/adapters/cloudflare/identityGateway.ts:84-115,135-208`
  - 理由: `IDENTITY_RPC_VERSION` はどの request にも含まれず、DO methods は ad-hoc 引数を直接受けるため version mismatch を拒否できない。SQL/migration/store の例外は `RpcResult` に変換されず platform exception のまま漏れる。また `retryIdempotent` は stub 呼び出しだけを囲み、`unwrap` はその外なので、`{ kind: "infrastructure", retryable: true }` envelope は一度も retry されないうえ、`unwrap` は retryable/code を失う。計画の primitive/versioned RPC、adapter→application error 変換、冪等 mutation retry を満たさない。
  - 提案: 全 RPC を `{ version, operationId?, payload }` に統一し、DO input gate で version/shape を検証する。adapter 境界で driver/platform error を構造化し、`unwrap` を retry closure 内へ入れて retryability を保った application error へ変換する。version mismatch、retryable、overloaded、SQLITE_FULL を contract test 化する。

- **B-DA-006 — SemanticCommit の冪等性と lifecycle contract が破れている**
  - 場所: `packages/core/src/application/search/contracts.ts:56-82`、`packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:15-51,54-136`
  - 理由: 完了済み `operationId` を見つけると payload を比較せず無条件 return するため、同じ ID の異なる command が成功扱いで捨てられる。これは `spec/testcases/search/maintainSearchIndex.md` の idempotency conflict 条件に直接反する。さらに `upsert-content` が create/update を区別せず revision を一件も保存せず、restore は `restoredAt` を状態へ反映しないため、計画した memo/document create/update/remove/restore の本体 repository contract を表していない。
  - 提案: version・command kind・canonical payload digest と保存済み result を idempotency record に保持し、異なる payload は conflict にする。create/update/restore を別 typed command として表現し、本体・revision・source/topic・projection・result を同一 transaction で確定する contract test を追加する。

- **B-DA-007 — Search application contract が現行 spec/受け入れ基準と非互換**
  - 場所: `packages/core/src/application/search/contracts.ts:1-54`、`packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:64-128`
  - 理由: 結果が memo/document の discriminated DTO ではなく、timestamp、memo の `sourceOfDocumentIds`、totalCount/snapshot cursor を持たない。順位は `bm25,id` だけで timestamp/type tie-break がなく、offset を新しい snapshot に適用するためページ間の重複・欠落を防げない。topic filter は `c.topic_id = ?` だけなので「topic 配下 document と active source memo」を返せず、projection 型は trashed topic と source link の双方向関係を表現できない。`includeTrash` は application contract にある一方、trash 時に FTS row を削除するため true でも返らない。AC-5 と `spec/domains/search.md` / `spec/usecases/search.md` の共通検索契約を満たさない。
  - 提案: spec の memo/document DTO、timestamp、topic、双方向 source IDs、安定 cursor を application port に反映する。同一 snapshot を識別する cursor と規定 tie-break、topic/source join、trashed topic 除外を query contract と統合テストで固定し、不要な `includeTrash` は削除する。

#### Warnings

- **W-DA-001 — application/RPC contract が識別子をほぼ全て素の `string` で表し、取り違えを型で防げない**
  - 場所: `packages/core/src/application/identity/contracts.ts`、`packages/core/src/application/search/contracts.ts`
  - 理由: user ID、operation ID、content ID、topic ID、opaque key が同型で、特に複数 DO/saga の配線ミスが compile 時に検出されない。リポジトリ原則「illegal states unrepresentable」に弱い。
  - 提案: application 内は branded ID と discriminated command を使い、RPC serialization boundary だけ primitive DTO に射影する。

- **W-DA-002 — `CurrentAccount` が Account Home と User Data の所有データを混在させ、Account Home が偽の設定値を返す**
  - 場所: `packages/core/src/application/identity/contracts.ts:42-48`、`packages/core/src/adapters/cloudflare/account-home/store.ts:117-143`
  - 理由: Account Home が所有しない `trashRetentionDays` を常に30で返し、gateway が後から上書きしている。局所 RPC の返り値だけを見ると事実でない DTO になり、将来の caller が誤用しやすい。
  - 提案: `AccountAuthSummary` と `UserDataProfile/Settings` を別 contract にし、application projection でのみ `CurrentUserView` を合成する。

- **W-DA-003 — semantic commit が ambient clock を使用し、restore の時刻を無視している**
  - 場所: `packages/core/src/adapters/cloudflare/user-data/semanticCommit.ts:34-38,45-50,117-123`
  - 理由: `Date.now()` は deterministic な application command という設計に反し、再送・テストで同じ結果を再現できない。`restoredAt` は受け取るだけで `updated_at` に書かれない。
  - 提案: prepared command に確定時刻を含め、transaction 内はその値だけを使用する。

#### Notes

- **N-DA-001 — Cloudflare/SQLite 型は domain 本体には追加されておらず、技術依存は adapter・composition root・DO entry に概ね閉じている**
  - 場所: `packages/core/src/domain/**`、`packages/core/src/adapters/cloudflare/**`、`apps/web/app/durable-objects/**`
  - 理由: 物理ランタイム依存の配置方向自体は hexagonal boundary と整合する。上記 Blocker は主に、内側に置くべき coordinator／不変条件が外側へ移ったことと、contract が未完成なことにある。
  - 提案: 現在の依存方向を維持したまま、application port と coordinator を内側へ引き戻す。
