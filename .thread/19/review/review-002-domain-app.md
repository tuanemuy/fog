# PR #33 第2回レビュー — Domain / Application architecture

## 判定

**BLOCKED**

`IdentityCoordinator` の追加により signup の順序制御は application 層へ移ったが、公開入力から User Data / Account Home の partition key を選べる経路、同一 signup の再送不能、SSO・reset・link/unlink の未完の saga、不完全な RPC 境界が残っている。Issue #19 の AC-1〜3 と、計画で固定した domain/application の責務分離を満たすには修正が必要である。

## Blockers

### B-DA2-001 — 公開 `operationId` がそのまま `userId` / DO partition key になり、既存 Account Home へ credential を追加できる

- 場所:
  - `apps/web/app/components/auth/schema.ts:30-33`
  - `packages/core/src/application/identity/registerWithPassword.ts:44-60`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:37-81`
  - `packages/core/src/application/identity/coordinator.ts:94-159`
- 根拠:
  - signup の `operationId` はブラウザーが送る UUID であり、server は形式しか検証しない。
  - usecase は `UserId.create(stableOperationId)` により、外部入力を Account Home / User Data DO の名前へそのまま昇格する。
  - `AccountHomeStore.beginOperation` は、既存 account の `user_id` が一致すれば account がすでに `active` でも新しい signup operation を開始できる。
  - したがって既知の被害者 `userId` を `operationId` として signup を送ると、攻撃者の email/password locator が被害者 Account Home に追加され、その credential で被害者 `userId` の session を取得できる。
- 影響:
  - AC-1 の「外部入力から別ユーザーの DO ID を指定できない」に直接違反し、アカウント乗っ取りになる。
  - spec が要求する server 発行 UUIDv7 でもなく、現状は client 発行 UUIDv4 である（`spec/domains/identity.md:102`）。
- 修正案:
  - `operationId` と `userId` を分離し、`userId` は request Worker が `IdGenerator` で発行した値だけを使う。
  - 再送用には、server が発行・署名した `{ operationId, userId }` token、または server-side idempotency registry で対応関係を保持し、任意の userId を transport から注入できないようにする。
  - Account Home 側でも、既存 active account に未知の signup operation を開始することを拒否する。
  - 被害者 userId を operationId にした signup が既存 Account Home を変更できない security contract test を追加する。

### B-DA2-002 — 同一 signup の正常な再送でも password hash が変わり、保存済み phase から再開できない

- 場所:
  - `packages/core/src/application/identity/registerWithPassword.ts:44-60`
  - `packages/core/src/application/identity/coordinator.ts:91-113`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:37-45`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:58-73`
- 根拠:
  - usecase は呼び出しごとに password を再 hash する。
  - coordinator の `payloadDigest` はランダム salt を含む `passwordHash` を材料にしている。
  - 同じ operation ID、email、password を再送しても新しい hash により digest が変わり、`beginOperation` は `IDENTITY_OPERATION_PAYLOAD_CONFLICT` を返す。
  - 現在の integration test は同じ固定 `passwordHash` DTO を gateway に2回渡すだけで、実際の公開 usecase の再 hash を通していない。
- 影響:
  - Directory reserve 後、User Data 初期化後などで応答を失った利用者が同じ操作を再送しても回復できず、AC-3 と `spec/usecases/identity.md:49` に反する。
- 修正案:
  - idempotency digest は canonical email と、再送間で安定しつつ plaintext を保存しない server-side input fingerprint から作る。
  - operation の開始時に確定した password hash を保存し、再送では保存値を再利用するか、hash 前に operation を解決して既存 phaseへ復帰する。
  - `registerWithPassword` usecase を同じ operation/email/password で2回実行する test と、各 RPC fault point 後の再送 test を追加する。

### B-DA2-003 — SSO create は Directory activate 後の部分失敗と shard 間競合を回復できない

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:264-335`
  - `packages/core/src/application/identity/coordinator.ts:358-405`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:884-935`
- 根拠:
  - `lookupOrCreateSso` は provider mapping が `active` だと既存 login として早期分岐する。そのmappingが同じoperationでactivate済みでも、Account Homeがまだpendingなら `INVALID_SSO_CREDENTIAL` を返し、保存済みoperation phaseを再開しない。
  - provider locator のreserve後に、並行operationがemail locatorを先にactive化して後続reserveが競合した場合の補償 phaseもない。
  - reconciler は active account の進んだ operation、または deleting/deleted account しか処理せず、pending account の期限切れ reservation を activate/tombstone のどちらにも進めない。
- 影響:
  - AC-2/AC-3 の初回・再送・同時初回・同一 email 競合を決定的に扱えず、orphan reservation が credential を占有し続ける。
- 修正案:
  - lookup 結果に operation ID/state を保持し、同じ operation/user の reserved/initialized mapping は競合ではなく再開対象にする。
  - Account Home operation を権威として全 locator の予約結果・補償 phase を永続化し、途中競合時は決定的に tombstone/reclaim する。
  - provider reserve後、email reserve後、User Data初期化後、各generation activate後の fault injection と再送 test を追加する。

### B-DA2-004 — SSO link/unlink が論理 credential ではなく locator 単位で動き、pending credential が Account Home 確定前に login 可能になる

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:273-290`
  - `packages/core/src/application/identity/coordinator.ts:494-548`
  - `packages/core/src/application/identity/coordinator.ts:551-582`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:216-269`
- 根拠:
  - `linkSso` は Account Home に operation を開始せず、各 Directory mapping を `active` にしてから Account Home locator を追加する。
  - SSO login の既存 provider 分岐は Account Home が active かだけを確認し、provider locator が auth summary に含まれるか、mapping epoch が現行かを確認しない。そのため activate 後・Account Home 更新前の部分失敗でも新しい SSO credential が使える。
  - `unlinkCredential` の「最後の credential」判定は `authority.locators.length`、store 側は `COUNT(DISTINCT kind)` であり、active/previous generation、SSO provider locator、email alias locatorを別々の login credential と誤認する。
  - unlink は1 locatorしか tombstone化せず、1つの論理 SSO credential を全 generation/alias から一貫して解除できない。
- 影響:
  - pending link 中は確定済み Account Home summary だけを信頼する不変条件と、最後の login credential を unlink できない不変条件を保証できない。
- 修正案:
  - domain/application contract に logical credential ID/ref と、その credential に属する locator 群を表現する。
  - link/unlink を Account Home の再開可能 operation とし、Directory activate/tombstone と auth summary 更新の phase を永続化する。
  - login は provider mapping の locator・account epoch が Account Home の確定済み credential set と一致する場合だけ成功させる。
  - active/previous 2世代、password+SSO、SSO-only の link/unlink fault injection test を追加する。

### B-DA2-005 — password reset primitive が Account Home saga/credential authorityを持たず、部分更新と SSO-only account の password 化を許す

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:423-491`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:236-305`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:169-196`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:159-213`
- 根拠:
  - reset token 保存は locator 上の active mappingや user ownershipを確認せず、呼び出し側から渡された `userId` をそのまま保存する。
  - consume は全 generation の token を先に one-time consumeし、その後で Directory password hash と Account Home session epoch を順番に更新する。Account Home に reset operation/phaseを開始しないため、途中状態の権威と回復点がない。
  - `replacePassword` は対象 mapping の元の `kind` を確認せず `kind = 'password'` へ変更する。email alias が SSO mapping の SSO-only accountでも reset tokenを保存できるため、reset primitiveで暗黙に password credentialへ変換できる。
  - Account Home の完了記録は `addCredentialLocator` が作る固定 `"sso-link"` operation で、reset operationとしての payload/phaseを表現しない。
- 影響:
  - active/previous generation間で新旧 password hash が分裂し、旧session epochのままになる fault windowがある。
  - #19 が後続 #12 に提供するはずの one-time consume、再開可能 saga、SSO-only同一公開応答という contractを安全に固定できていない。
- 修正案:
  - reset request時に active password credentialをDirectoryから解決し、該当時だけ token/jobを保存する。外部入力の userId を信頼しない。
  - Account Homeに `password-reset` operation、payload digest、phaseを開始し、token consume、全 locator hash更新、session epoch更新を同じoperationから再開可能にする。
  - mapping kind/owner/epochを各更新で検証し、SSO-onlyは公開成功を返しつつ tokenを作らない contract testを追加する。

### B-DA2-006 — RPC の platform failure が retry/translationされず、versioned envelope も全 state RPC に適用されていない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:261-307`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:45-49`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:135-170`
  - `packages/core/src/application/search/contracts.ts:115-200`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:103-178`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:304-384`
- 根拠:
  - `retryRpc` が retryするのは `RpcResult` から作った `RemoteIdentityError` だけで、stub呼び出しそのものが throwする network/platform errorは即時に `translate` される。
  - `translate` は非 `RemoteIdentityError` の通常 `Error` をそのまま返すため、application の retryable `SystemError` にも変換されない。
  - User Data の initialize/search/commit/delete は `{ version, operationId?, payload }` envelopeではなく ad-hoc DTOを直接受ける。search command の `version` は optionalである。
  - Identity Directory/Account Homeにも version checkを迂回する legacy overloadが残り、未deployの新規namespace向け contractを二重化している。
- 影響:
  - 一時的な service binding failureが retryable errorとしてpresentationへ届かず、同一 operationの自動回復が働かない。
  - `spec/usecases/identity.md:3` と計画の全RPC primitive/versioned contractを満たさず、旧shapeが入力検証を迂回する。
- 修正案:
  - platform exceptionも分類して、冪等 query/mutation policyに従って bounded retryし、最終的に `SystemError(NetworkError)` へ変換する。
  - request/state RPCを共通 versioned envelopeへ統一し、legacy overload/optional versionを削除する。
  - version mismatch、platform throw、retryable envelope、overload、payload shape、SQLITE_FULLの contract testを追加する。

### B-DA2-007 — 実装された domain model が改訂specの aggregate境界と矛盾し、認証不変条件がdomainを迂回している

- 場所:
  - `packages/core/src/domain/identity/entity.ts:14-36`
  - `packages/core/src/domain/identity/entity.ts:49-143`
  - `packages/core/src/application/identity/coordinator.ts:494-582`
  - `spec/domains/identity.md:31-72`
- 根拠:
  - domain の `User` は email、password/SSO credential、trash retentionを1 aggregateにまとめ、auth methodを password/SSO の排他的unionにしている。
  - 改訂specは複数 credentialを持つ `AccountIdentity` と、User Data DO所有の `Profile` / `Settings` を分離する。
  - 本番 coordinator/store はこの `User` aggregateを使わず、last credential、primary email、session epochなどの業務不変条件を生の locator配列とSQL countで判定している。その判定が B-DA2-004 のとおり誤っている。
- 影響:
  - domain unit testは本番経路の不変条件を検証せず、specと実装の双方に別のidentity modelが存在する。
  - 後続 #11/#12 が旧 `User` を使うか新 coordinator stateを使うか決められず、依存方向の再崩壊を招く。
- 修正案:
  - domainを `AccountIdentity` / logical credential invariants と User Data側 `Profile` / `Settings` に再構成するか、#19でdomain実装対象外なら矛盾する旧entityを削除してapplication contractに責務を明示する。
  - coordinatorはdomain operationでlast credential/primary email不変条件を判定し、adapter/storeは永続化とCASだけに限定する。

## Warnings

### W-DA2-001 — idempotency fingerprint が衝突耐性のない独自64-bit hash

- 場所: `packages/core/src/application/identity/coordinator.ts:33-43`
- 理由: operation payloadの同一性というセキュリティ境界に、2本の32-bit非暗号hashを連結した値を使っている。攻撃者が operation ID とpayloadを制御できる経路では意図的衝突を前提にできない。
- 提案: request境界でSHA-256/HMAC等の標準プリミティブを用いてcanonical payload digestを作り、applicationには完成したdigestを渡す。

### W-DA2-002 — application 配下の composition root / secret validation が adapter と Cloudflare型へ依存する

- 場所:
  - `packages/core/src/application/di/serverCloudflare.ts:1-5`
  - `packages/core/src/application/di/secrets.ts:1-5`
- 理由: 計画のlayer mapはapplicationがdomainだけに依存するとしているが、application directory内からCloudflare typesとadapter実装をimportしている。composition rootであること自体は妥当でも、配置によりdependency audit上application層が外側へ依存して見える。
- 提案: runtime compositionをadapter/app側へ移し、secret長のpolicyは内側のport optionまたは共有config contractへ置く。

### W-DA2-003 — `AuthenticatedUserDataRouter` は型宣言だけで、実装も contract testもない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:385-389`
  - `spec/inventory/test.md:57`
- 理由: 検索結果は宣言箇所以外に利用がなく、inventoryはtypecheckで検証済みとしている。実際のUser Data adapterは独自private `forUser`を使い、UI/将来REST/MCPが共有するrouting contractになっていない。
- 提案: canonical userIdだけを受ける実装をcomposition rootへ組み込み、transport DTOからpartition/user overrideを渡せないtype/runtime contract testを置く。

### W-DA2-004 — current-user projection が欠落した primary email を空文字にして正常応答する

- 場所: `packages/core/src/application/identity/getCurrentUser.ts:27-38`
- 理由: active accountのprimary emailはdomain/spec上の必須不変条件だが、`null`を `""` に変換して破損を隠す。
- 提案: active authorityでprimary emailが欠落していれば `DataIntegrityError` とし、正常DTOには常にvalid Emailだけを入れる。

### W-DA2-005 — SSO subject と operation ID の application value validation が弱い

- 場所:
  - `packages/core/src/application/identity/contracts.ts:18-29`
  - `packages/core/src/application/identity/contracts.ts:341-348`
  - `packages/core/src/application/identity/coordinator.ts:264-268`
- 理由: domainには長さ・NFKCを保証する `SsoSubject` があるが、primitiveは素のstringを受けて独自normalizeだけを行う。`OperationId`も非空以外の長さ/形式上限がなく、将来の非公開binding callerが巨大値をDB keyへ送れる。
- 提案: application inputでdomain VO/専用bounded VOへ変換し、RPC境界でも同じ上限を検証する。

## Notes

### N-DA2-001 — signup coordinatorの配置と current-userの所有データ分離は第1回指摘から改善された

- `IdentityCoordinator` が signup phase順序を所有し、adapterは `CredentialDirectoryPort` / `AccountHomePort` / `UserDataIdentityPort` 実装へ分かれた。
- `CurrentAccount` も Account Home auth summary と User Data profileに分離され、Account Homeが偽のretention値を返す問題は解消している。

### N-DA2-002 — password login と session guard は Account Home authority/epochを照合する

- 場所:
  - `packages/core/src/application/identity/loginWithPassword.ts:146-166`
  - `apps/web/app/presentation/currentUser.ts:18-37`
- `deleting/deleted` account、古い locator/operation epoch、古い session epochを拒否する基本経路は実装されている。SSO側にも同じ locator/epoch照合を適用すれば、認証方式間のauthority規則を統一できる。
