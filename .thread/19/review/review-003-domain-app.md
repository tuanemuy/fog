# PR #33 第3回レビュー — Domain / Application

## 判定

**BLOCKED**

対象: `main...502776e5a797fd042636164314755f1f5aa137d4`

`IdentityCoordinator` に saga の順序が集約され、論理 credential 単位の unlink 判定も追加された点は改善している。一方で、現行 spec の `AccountIdentity` が実装の権威になっておらず、application port に Cloudflare の generation/bucket/checkpoint が露出している。また、Issue #19 で固定するとした SSO 同時初回、password change/reset、全 fault point、transaction-scoped search projection、local-only harness の契約が未達である。

## Blockers

### B-DA3-001 — 現行 `AccountIdentity` と旧 `User` が矛盾し、domain が認証不変条件の権威になっていない

- 場所:
  - `packages/core/src/domain/identity/entity.ts:14-36,49-143`
  - `packages/core/src/domain/identity/accountIdentity.ts:4-45`
  - `packages/core/src/application/identity/coordinator.ts:907-919`
  - `packages/core/src/domain/identity/__tests__/entity.test.ts:34-250`
- 根拠:
  - 旧 `User` は password と SSO を排他的な union として持ち、email、password hash/provider subject、settings を一集約に混在させている。これは複数 credential と Profile/Settings 分離を定めた `spec/domains/identity.md:31-71` と矛盾する。
  - 新 `AccountIdentity` の credential は `{ id, kind }` だけで、password email、SSO provider/subject、primary email を裏付ける active email credential、session epoch を表現できない。
  - application は unlink の「残り1件」判定にだけ `AccountIdentity` を使い、link/create/reset の不変条件は adapter 由来 DTO と手続き的分岐で判定している。
  - domain test は旧 `User` の排他的 auth model を固定する一方、`AccountIdentity` のテストがない。
- 影響:
  - primary email、provider 境界、複数 credential、session epoch の不変条件を domain 単体で保証できず、将来 #11/#12 の usecase が旧 model と新 model のどちらを使うべきか決められない。
  - 「illegal states unrepresentable」と、Issue #19 が後続機能の domain contract を固定する目的を満たさない。
- 修正案:
  - 旧 `User` を現行境界へ置き換えるか削除し、完全な `AccountIdentity`、`Profile`、`Settings` を定義する。
  - logical credential に password email または SSO provider/subject を持たせ、primary email と active credential、last credential、session epoch の規則を domain operation と unit test で固定する。
  - coordinator は auth summary DTO を aggregate へ復元してから link/unlink/change/reset の判断を行う。

### B-DA3-002 — application contract に Cloudflare の routing/key-rotation/checkpoint 詳細が流出している

- 場所:
  - `packages/core/src/application/identity/contracts.ts:64-68,89-133`
  - `packages/core/src/application/identity/contracts.ts:198-323`
  - `packages/core/src/application/identity/contracts.ts:325-391`
  - `packages/core/src/application/identity/coordinator.ts:132-150`
- 根拠:
  - `CredentialLocator` が `generation`、`bucket`、`opaqueKey` を公開し、`AccountAuthSummary` も `userDataObjectName` と locator 一覧を持つ。
  - `CredentialDirectoryPort` は canonical credential の locator 化だけでなく、generation/bucket/cursor を指定する rotation/reconcile scan と checkpoint 保存まで application interface に含める。
  - coordinator 自身が generation/bucket/opaqueKey を payload digest に入れ、Cloudflare の active/previous key routing を業務 saga の入力として扱っている。
  - 計画は operation/reservation の順序を application、HMAC、bucket、active/previous generation、rotation checkpoint を Cloudflare adapter に置くと定めている。
- 影響:
  - application 層が Cloudflare の shard/key rotation topology に依存し、別 adapter では port を自然に実装できない。
  - routing secret rotationの変更が業務 operation digest と再送互換性へ波及する。
- 修正案:
  - application には logical credential と opaque な directory reference、業務上必要な saga result だけを公開する。
  - HMAC locator の展開、generation/bucket fan-out、scan/checkpoint は Cloudflare adapter 内の maintenance service に閉じる。
  - Account Home の summary から `userDataObjectName` と物理 locator を除き、認証に必要な logical authority だけを返す。

### B-DA3-003 — SSO lookup/create が caller 提供 `proposedUserId` に依存し、同時初回の決定的収束を固定していない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:403-425`
  - `packages/core/src/application/identity/coordinator.ts:319-435`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:98-120,231-251`
- 根拠:
  - spec の入力は `{ operationId, provider, subject, verifiedEmail }` だが、実装は `proposedUserId` を必須とし、それを Account Home/User Data の identity に採用する。
  - provider reservation より前の失敗では、再送側が同じ proposed ID を知り続けることが前提になる。server-side に operation/provider/subject と発行済み userId の対応を確定する contract がない。
  - test は1操作の fault replayとprovider境界だけで、異なる operation/user候補が同じ provider/subject を同時に初回作成するケースを実行していない。
- 影響:
  - 非公開 primitive の caller が partition identity を選べ、`spec/usecases/identity.md:90-103` の server 管理入力と一致しない。
  - 同時初回で片方を既存 user の成功結果へ収束させるのか conflict にするのかが application contract とテストで確定せず、AC-2 を満たさない。
- 修正案:
  - primitive input から `proposedUserId` を除き、request/application 側で userId を一度だけ発行・永続化する idempotency registry または Account Home bootstrap contract を設ける。
  - 同じ provider/subject に異なる operation が同時到達する contract test を追加し、両 caller が同じ userId を得る決定規則を固定する。

### B-DA3-004 — password change/reset の将来 primitive contract が受け入れ基準まで実装されていない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:166-175,257-275`
  - `packages/core/src/application/identity/contracts.ts:412-433`
  - `packages/core/src/application/identity/coordinator.ts:558-723`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:282-320,458-498`
- 根拠:
  - `password-change` は operation kind に文字列があるだけで、port、coordinator saga、session epoch 更新、contract test がない。
  - reset request は caller に `userId` を要求し、application が email lookup から対象を解決する contract になっていない。
  - 登録の有無や credential 種別にかかわらず返す同一 success envelopeが表現されず、該当時の mail job enqueue / provider idempotency contract もない。
  - test は直接 token を保存して consume する内部 happy pathを確認するだけで、未登録、SSO-only、userId不一致、mail job、公開応答の同一性を固定していない。
- 影響:
  - AC-3 と `spec/usecases/identity.md:105-110` が #19 の成果物とした将来 schema・primitive・saga・不変条件が不足し、#11/#12 が再設計を必要とする。
- 修正案:
  - password change の再開可能 command/phaseと session epoch 更新を application port/coordinator/test に追加する。
  - reset request は emailだけから対象を解決し、常に同じ success result を返し、該当時だけ token保存と mail job enqueueを同じ業務 operation として確定する。
  - mail job port と provider idempotency key、未登録/SSO-onlyを含む contract test を追加する。

### B-DA3-005 — search port が spec の capability 境界と異なり、transport DTO と adapter 実装を application contract にしている

- 場所:
  - `packages/core/src/application/search/contracts.ts:71-78,108-119`
  - `packages/core/src/application/search/contracts.ts:121-173`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:215-239`
- 根拠:
  - application の `SearchQuery` に RPC `version` と raw page/limit/cursor が入り、domain の `{ keyword, topicId, pagination }` と transport validation が分離されていない。
  - `SearchIndexPort.query` は同期戻り値、`SearchProjectionPort` は汎用 `apply`、`SemanticCommitPort` は `commit(command)` であり、spec の async read port、`upsert/remove`、transaction-scoped repositories/projection callback と一致しない。
  - semantic command 自体も RPC version/operation IDと persistence DTOを一体化しており、async prepare後の typed application command になっていない。
- 影響:
  - `SearchProjectionPort` を commit callbackだけへ capability confinementできず、後続の本番 memo/document usecase が同一 transaction を強制する application abstractionを再利用できない。
  - AC-5 と `spec/domains/search.md:108-161` の主要設計契約を満たさない。
- 修正案:
  - RPC envelope decoder、domain `SearchQuery`、application command、adapter DTOを分離する。
  - `SearchIndexPort.query(): Promise<...>`、`SearchProjectionPort.upsert/remove`、`SemanticCommitPort.transactionSync(command, callback)` を spec 通り定義し、projection capabilityを callback外へ持ち出せない構成にする。

### B-DA3-006 — local-only semantic command harness が production Durable Object artifact に公開される

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:215-229`
  - `apps/web/app/server.state.ts:1-3`
  - `apps/web/wrangler.state.toml:11-25`
  - `apps/web/wrangler.request.production.toml.tpl:22-23`
  - `apps/web/app/testing/lifecycle.integration.worker.ts:30,167`
- 根拠:
  - raw semantic `commit` method は本番で export される `UserDataDurableObject` classそのものに実装されている。
  - local lifecycle worker以外の production request/state configも同じ class/bindingを使用し、environment capability guardやproduction buildからの除外がない。
  - `spec/usecases/search.md:77-103` と計画は、この harness を local workerd test / local-only CLI だけから呼び、本番 route/artifactへ公開しないと明記する。
- 影響:
  - 後続 usecaseの認可・domain ruleを通さず memo/document/topic を変更できる test command surfaceがproduction service bindingに残る。
  - AC-5 の検証用 harness と本番 application boundary の分離を満たさない。
- 修正案:
  - local専用 entry/classへ harnessを分離し、production Wrangler artifactではexport/bindしない。
  - production `UserDataDurableObject` は完成usecaseが必要とするversioned primitiveだけを公開する。
  - build artifact/config testで production exportに harness methodが存在しないことを固定する。

### B-DA3-007 — fault injection matrix が実際の Directory activate 境界を網羅していない

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:184-264`
  - `packages/core/src/application/identity/coordinator.ts:815-862`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:74-96,377-411`
- 根拠:
  - signup は `directory.activate` と Account Home の `directory-active` 更新の間に checkpoint がなく、testの3点は reserve、initialize、全完了後だけである。
  - link の `link-after-activate` checkpoint は実際には `markInitialized` 直後、`directory.activate` より前に置かれている。
  - linkの実 activate後から Account Home advanceまでにも checkpointがない。
- 影響:
  - Directoryはactiveだが Account Homeは未確定、という最重要の部分失敗を再送で回復できる証拠がない。
  - test名が実際と異なり、AC-3 の「全 fault point」を満たしたように見える偽陽性になる。
- 修正案:
  - initialized後とactivate後を別 checkpointにし、signup/linkとも各 generation のactivate後とAccount Home advance前を注入対象にする。
  - 失敗直後の Directory/Account Home状態をassertしてから同一operationを再送し、authorityとsession epochが一度だけ確定することを検証する。

### B-DA3-008 — User Data identity RPC が共通 versioned envelope 契約から外れている

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:326-342`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:125-129,186-213,325-350`
- 根拠:
  - Identity Directory/Account Home は `IdentityRpcQuery/Mutation` を使う一方、User Data の `initialize`、`getProfile`、`deleteAll` は ad-hoc payloadを直接受ける。
  - version mismatchやmutation envelopeの operation ID検証を共通 input gateで拒否できない。`deleteAll` は application portの `{ operationId, userId }` を adapterで `{ expectedUserId }` へ変換し、operation IDをRPC先へ渡さない。
  - `spec/usecases/identity.md:1-24` は3 DOを含む全RPCをversioned primitive envelopeに限定する。
- 影響:
  - request/state Workerのdeploy skew時に User Data identity callだけ互換性判定がなく、削除RPCの再送識別もDO側に残らない。
  - AC-3 の安定 operationと primitive RPC contractが3 DO間で一貫しない。
- 修正案:
  - User Data identity RPCも `{ version, operationId?, payload }` と `RpcResult` に統一し、共通decoderを通す。
  - `deleteAll` は operation ID、expected user、payload digestを保存して同一再送/異payload conflictをDO側で保証する。

## Warnings

### W-DA3-001 — fault injection hook が production application API に混在している

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:36-59,111-121`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:950-964`
- 影響:
  - test-only concern が本番 constructor と全 saga branchに残り、composition誤りで任意 phaseを失敗させられる。
- 修正案:
  - faulting fake port/decoratorまたはtest-only coordinator wrapperへ移し、production APIからhookを除く。

### W-DA3-002 — application search contract が domain ID と transport primitiveを区別しない

- 場所:
  - `packages/core/src/application/search/contracts.ts:21-65,71-106,121-164`
- 影響:
  - memo/document/topic/operation/cursorがほぼ全て `string` で、異種IDの取り違えをcompile時に検出できない。RPC serialization表現が内側のcommandまで侵入している。
- 修正案:
  - 内側では branded ID、Date、Pagination、discriminated commandを使い、RPC boundaryだけstring/number DTOへ変換する。

## Notes

### N-DA3-001 — saga ordering を application coordinator に集約した方向は妥当

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:107-121`
- 評価:
  - signup/SSO/link/unlink/reset/deleteのphase orderingがCloudflare storeからapplicationへ移り、adapterがport実装を担当する依存方向は第1回時点より明確になった。
  - 上記 blockerはこの方向を維持しつつ、物理routing詳細を外へ戻し、domain aggregateと将来primitive契約を完成させる修正で解消できる。

### N-DA3-002 — unlink は active/previous locatorを論理credentialとしてまとめて扱うよう改善されている

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:890-955`
- 評価:
  - locator数やkind数ではなく `credentialId` 単位でtargetを求め、全locatorをtombstoneした後にauthorityを一度更新するため、rotation中の同一login credentialを重複カウントする問題は解消方向にある。

