# PR #33 第4回レビュー — Identity / Security + Domain / Application

## 判定

**BLOCKED**

対象: `main...e2ec1ace9c15b281a120ee577a56c23ec4d0936e`

Issue #19、`spec/`、`.thread/19/plan.md`、受け入れ基準と実装をゼロベースで照合した。第3回後に fresh retry、reconciler、User Data identity RPC、削除 marker、Account Home transition matrixは改善されている。

一方、credential の物理 routing は application contract と Account Home authority に残り、domain aggregate は本番判断の権威になっていない。また password reset mail は write-only jobで、配送に必要な秘密も持たない。credential PII の平文保持、同時初回の非決定性も現行設計と不一致である。第3回の「locator隠蔽済み」はトップレベルfieldの削除だけを見た false positive だった。

## Blockers

### B-IDDA4-001 — Cloudflare の generation / bucket が application contract と Account Home authority に残っている

- 場所:
  - `packages/core/src/application/identity/contracts.ts:64-74,89-119,123-131,210-277`
  - `packages/core/src/application/identity/coordinator.ts:668-713,717-780`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:572-612`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:145-161`
  - `spec/domains/identity.md:3-14`
  - `.thread/19/plan.md:59-67`
- 根拠:
  - `CredentialLocator` は `generation`、`bucket`、`opaqueKey` を公開し、`CredentialDirectoryPort` の全 mutation がこの物理 locator を受け取る。
  - `AccountAuthSummary.credentials[].locators` も同型を保持し、coordinator は password change/reset/link/unlink の業務判断で locator fan-out と世代一致を直接扱う。
  - integration testも Account Home authorityから `generation-1` / `generation-2` が見えることを契約として固定している。
  - 第3回後に `userDataObjectName`、トップレベル `locators`、maintenance scan/checkpoint method は除かれたが、nested locator と通常operationの物理routing依存は残っている。
- 影響:
  - application/domain-facing contractがCloudflareのkey rotation topologyに依存し、世代やbucket protocolの変更が業務operation、authority DTO、再送互換性へ波及する。
  - 計画が定める「applicationはCloudflare/HMAC/bucket/checkpoint型を公開しない」を満たさない。
- 修正案:
  - applicationにはlogical credential ID/kindとopaqueなdirectory reference/capabilityだけを公開する。
  - generation展開、bucket routing、active/previous fan-out、reverse locator管理をCloudflare adapter内の通常operation/maintenance serviceへ閉じる。
  - Account Home auth summaryとapplication testから物理generation/bucketを除く。

### B-IDDA4-002 — `AccountIdentity` が本番の認証不変条件の権威ではなく、active accountの不正状態も表現できる

- 場所:
  - `packages/core/src/domain/identity/accountIdentity.ts:27-33,45-98,101-223`
  - `packages/core/src/application/identity/coordinator.ts:668-780,1125-1143`
  - `packages/core/src/domain/identity/__tests__/entity.test.ts:13-135`
  - `spec/domains/identity.md:31-53`
- 根拠:
  - production codeで使われるdomain operationは `AccountIdentity.canUnlink()` だけで、coordinatorは `{ status, credentials: [{ id, kind }] }` という縮退projectionを組み立てて呼ぶ。
  - `create`、`addCredential`、`unlink`、`replacePassword`、`markDeleting`、`markDeleted` はdomain test以外の本番applicationから呼ばれない。link/create/change/reset/deleteの不変条件はadapter DTOに対する手続き的分岐で判定される。
  - `AccountIdentity.primaryEmail` は `null` を許し、`create()` はactive accountについてcredentialが1件以上あることしか必須にしない。したがって `{ status: "active", primaryEmail: null, credentials: [...] }` がdomain上validになる。一方specはactiveなemail credentialを指すprimary emailを必須としている。
  - Account Home summaryにはpassword email/hashやSSO provider/subjectがなく、完全なaggregateを復元する契約にもなっていない。
- 影響:
  - domain unit testがgreenでも本番operationはaggregateを迂回でき、primary email、canonical credential一意性、session epoch更新の規則を一箇所で保証できない。
  - Issue #19が#11/#12向けに固定するdomain contractとして不十分である。
- 修正案:
  - active/deleted状態をdiscriminated unionにし、activeはnon-null primary emailと完全なlogical credential集合を必須にする。
  - Account Home/Directoryから物理routingを含まない `AccountIdentity` snapshotを復元できるportを定義する。
  - create/link/unlink/change/reset/deleteはdomain operationで状態遷移を決定し、その結果をapplication sagaが永続化する。

### B-IDDA4-003 — password reset mail jobは永続化されるだけで、利用者へreset secretを配送できない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:278-295,400-418`
  - `packages/core/src/application/identity/coordinator.ts:668-714`
  - `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:110-125`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:483-530`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:206-340,763-813`
  - `spec/domains/identity.md:181-183`
  - `.thread/19/plan.md:78,99-100`
- 根拠:
  - `identity_mail_jobs` にはenqueue実装しかなく、lease/claim、provider invocation、CAS completion、retry、poison処理が存在しない。
  - Directoryの `alarm()` は `directory_reconcile_jobs` だけを処理し、mail jobをclaimしない。enqueue後にmail用alarmを設定する経路もない。
  - jobが持つのは `token_hash` だけである。one-way hashから利用者へ送るplaintext reset token/URLは構築できない。
  - APIもserver生成secretではなくcaller提供 `tokenHash` を要求するため、将来presentationが安全な生成・配送境界を再設計しなければならない。
- 影響:
  - password accountへのrequestは `{ accepted: true }` を返すが、メールは永久に送信されず、jobはpendingのまま残る。
  - provider idempotency、Alarm at-least-once、restart/retryというAC-3/AC-12の契約を満たさない。
- 修正案:
  - server側でplaintext reset secretを生成し、reset token tableにはhashだけを保存する。
  - mail jobには暗号化した短寿命delivery payload、またはsecretを露出しないprovider template入力を保存する。
  - Alarm runnerでdue jobをleaseし、provider idempotency key付き送信、owner-token CAS completion/retry/poison、次alarm再設定まで実装する。
  - provider副作用回数、eviction/replay、retry、unknown/SSO-only時のno-jobをcontract testにする。

### B-IDDA4-004 — Directoryにcanonical email / SSO subject等のcredential PIIを平文で永続化している

- 場所:
  - `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:5-29,55-73,127-136`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:85-165,170-243,245-290`
  - `spec/database/index.md:190-213`
  - `spec/domains/identity.md:210-215`
- 根拠:
  - `credential_mappings.canonical_value`、`verified_email`、`signup_operations.email`、`sso_create_operations.subject/email` は平文列である。
  - reserve/prepare実装も正規化email、provider subject、verified emailをそのまま保存する。
  - specのcredential schemaはrotation用sensitive fieldを `canonical_value_encrypted` と定めている。
  - signup/SSO operation registryにはpurge/TTL経路がなく、完了後もemail、subject、password hashを保持し続ける。
- 影響:
  - routing shardまたはoperation registryの漏えいで、opaque locatorから隠したはずのemail/SSO identityが直接開示される。
  - データ最小化とsecret rotationの対象が定義されず、削除後・operation完了後も不要なPIIが残る。
- 修正案:
  - canonical/verified値をrotation-aware envelope encryptionで保護し、generation/kind等のmetadataをauthenticated dataにする。
  - operation registryは完了後にcanonical payloadを消去するか、期限付き・暗号化された最小replay recordへ縮退する。
  - migration、key rotation、退会/expiry後の消去をintegration testで固定する。

### B-IDDA4-005 — 同一credentialの同時初回winnerが最小operation IDではなく到着順で決まる

- 場所:
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:85-167`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:164-201,281-300`
  - `spec/database/index.md:210-213`
  - `spec/domains/identity.md:140`
  - `.thread/19/plan.md:18-19,87`
- 根拠:
  - `reserve()` はrowがなければ即INSERTし、後続の異なるoperationを無条件に `CREDENTIAL_ALREADY_REGISTERED` にする。operation IDの比較・arbitrationはない。
  - password同時signup testは成功が1件であることしか表明せず、specが定める最小operation ID winnerを確認しない。
  - SSO testはprovider境界/email conflictのみで、同一provider/subjectの同時初回を実行しない。
- 影響:
  - winnerがWorker/DOへの配送順に依存し、同じ入力集合でもscheduleによって結果が変わる。
  - AC-2の決定的lookup/create contractと、同時初回の再送収束を固定できていない。
- 修正案:
  - credential単位のarbitration registryまたは明示したCAS protocolで、競合operationを決定順に比較し最小IDへ収束させる。
  - passwordと同一provider/subject SSOのbarrier付き並行testを追加し、winner user、loser補償、全generation、再送結果を表明する。

## Warnings

### W-IDDA4-001 — reset requestは応答だけ同じで、存在有無による処理量の差を検証していない

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:668-714`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:377-404`
  - `spec/domains/identity.md:179,202-204`
- 理由:
  - unknown emailはDirectory lookup直後にreturnするが、password accountはAccount Home lookup、複数token write、mail enqueueまで進む。
  - testは最終値 `{ accepted: true }` の一致だけを確認し、SSO-only、dependency call profile、ログ、時間差を検証しない。
- 提案:
  - unknown/SSO-only/password accountを固定コストの非同期受付境界へ揃えるか、少なくとも公開boundaryからcall profileとenumeration-resistant envelopeをcontract testにする。

### W-IDDA4-002 — fault injection hookがproduction classとadapter APIに残っている

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:112-134`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1096-1112`
- 理由:
  - constructor引数からは外れたが、production classにmutable hook、checkpoint、public static `withFaultInjectionForTest()` がコンパイルされる。
  - 第3回の「test-only decorator/fakeへ分離」は未完了である。
- 提案:
  - portを前後で失敗させるtest-only fake/decoratorへ移し、production coordinator/gatewayからhookとtest factoryを削除する。

## Notes

### N-IDDA4-001 — 第3回から実質的に改善した点

- User Data identity RPCはversioned envelopeになり、削除後再送用markerが追加された。
- signup fresh retryは保存済み `preparedAt` を再利用する。
- Directory reconcilerはUser Data初期化状態とAccount Home operation/epochを照合する。
- Account Homeはoperation kind別transitionとcreate競合時のde-identificationを持つ。
- top-level `userDataObjectName` とmaintenance scan/checkpointはapplication contractから除かれた。

これらは有効な修正だが、上記Blockerを代替しない。

### N-IDDA4-002 — レビュー方法

- 第3回の修正済み判定を前提にせず、`main...HEAD`、Issue #19の受け入れ基準、`spec/domains/identity.md`、`spec/database/index.md`、`.thread/19/plan.md`を静的に再照合した。
- 本レビューではコード変更、commit、push、テスト再実行を行っていない。
