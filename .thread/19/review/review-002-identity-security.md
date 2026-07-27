# PR #33 第2回レビュー — Identity / Security

## 判定

**CHANGES REQUIRED**

password login の Account Home authority照合、session epoch、routing keyring検証、PITR HTTP wrapperは第1回から改善された。しかし公開signupのpartition選択、SSO authority、reset/link/unlinkの複数shard saga、退会後データ最小化、PITR対象とauthorityの束縛、rotation/reconcilerの実行経路にBlockerが残る。

## Blockers

### B-IS2-001 — client指定 `operationId` が `userId` になり、既存 accountへ攻撃者credentialを追加できる

- 場所:
  - `apps/web/app/components/auth/schema.ts:30-33`
  - `apps/web/app/components/auth/SignupForm/index.tsx:26-43`
  - `packages/core/src/application/identity/registerWithPassword.ts:44-60`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:37-81`
  - `packages/core/src/application/identity/coordinator.ts:115-159`
- 根拠:
  - signup inputの `operationId` はbrowserが指定でき、server側はUUID形式しか検証しない。
  - usecaseはその値を `UserId.create(stableOperationId)` でそのままAccount Home/User Data DO keyにする。
  - `AccountHomeStore.beginOperation` は同じuserIdのaccountが既にactiveでも、新しいsignup operationを挿入できる。
  - 被害者userIdをoperationIdとして送ると、攻撃者のemail/password mappingを被害者Account Homeへ追加し、login後に被害者userIdのsessionを発行できる。
- 影響:
  - account takeoverであり、Issue #19の「外部入力から別ユーザーDOを指定できない」に直接違反する。
- 修正案:
  - userIdはrequest WorkerがUUIDv7で発行し、外部入力から独立させる。
  - stable retryにはserver署名済み `{ operationId, userId }` tokenまたはserver-side registryを使う。
  - active Account Homeに未知signup operationを開始できないguardを加え、victim userId注入testを追加する。

### B-IS2-002 — 公開signupの同一再送がsalt付きhashの差で衝突し、全fault point回復契約を満たさない

- 場所:
  - `packages/core/src/application/identity/registerWithPassword.ts:44-60`
  - `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:176-183`
  - `packages/core/src/application/identity/coordinator.ts:91-113`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:37-45`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:58-73`
- 根拠:
  - retryごとに新しいrandom saltでpassword hashを作り、そのhash自体をAccount Home payload digestへ含める。
  - 同じoperation/email/passwordでもdigestが変わり、`IDENTITY_OPERATION_PAYLOAD_CONFLICT`になる。
  - integration testは公開usecaseを通さず、同じ固定hash DTOをgatewayへ2回渡しているため検出できない。
- 影響:
  - response lossやDirectory/User Data RPC後の一時障害から同じ操作を再開できず、reservation/orphanが残る。
- 修正案:
  - hash前のcanonical inputから安全なstable fingerprintを作り、初回確定hashをoperationから再取得可能にする。
  - 公開usecaseを通したreplayと、各RPC前後でのfault injectionを追加する。

### B-IS2-003 — SSO loginがAccount Homeの確定locator/epochを照合せず、unlinked・PITR復活・partial link credentialを受け入れる

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:264-290`
  - `packages/core/src/application/identity/coordinator.ts:494-548`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:164-167`
- 根拠:
  - provider mappingがDirectoryでactiveなら、SSO lookupはAccount Homeのstatusだけを確認してsession epochを返す。
  - password loginが行うlocator membershipと`accountEpoch`照合をSSOは行わない。
  - `linkSso` はDirectoryをactiveにしてからAccount Homeへlocatorを追加するため、その間のfailureでも既存active accountなら新credentialでloginできる。
  - unlink後やPITRで復活した古いactive mappingも、Account Homeがactiveである限り認証される。
- 影響:
  - 明示的にunlinkしたSSO credentialの再利用、未確定linkの利用、古いPITR stateの再活性化が可能になる。
- 修正案:
  - SSO lookup resultにもlocator/account epochを必須化し、Account Homeのactive logical credential setと完全一致する場合だけloginする。
  - linkはAccount Home operationを先に開始し、Directory activate後もAccount Home確定前はlogin不可にする。
  - partial link、unlink後、old epoch、PITR復活mappingのcontract testを追加する。

### B-IS2-004 — link/unlinkがcaller指定locatorを信頼し、logical credentialの所有・last credential・epoch不変条件を守れない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:371-377`
  - `packages/core/src/application/identity/coordinator.ts:494-582`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:159-269`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:199-215`
- 根拠:
  - unlink primitiveはlogical credential IDではなくraw `CredentialLocator`を入力として受ける。
  - coordinatorはそのlocatorがAccount Homeに属するかを確認せず、単に配列から除いた後の件数を見る。未知locatorでも既存locatorがあればDirectory tombstoneへ進む。
  - Directory tombstoneはuserId/operationId ownershipを検証せず、locatorとepochだけでmappingを更新する。
  - active/previous generation、SSO provider locator、email alias locatorを別credentialとして数える一方、storeは`COUNT(DISTINCT kind)`で数えるため、last credential判定が層間で一致しない。
  - `addCredentialLocator` / `removeCredentialLocator` はoperation IDが既に何かのoperationに存在すればpayload/kindを比較せずreplay扱いし、locator mutationだけ行ってsession epoch更新をskipする。
- 影響:
  - locator漏えい・配線ミス時のcross-account tombstone、credentialの一部だけが残るunlink、operation ID再利用による旧session継続が起きる。
- 修正案:
  - Account Homeが所有するlogical credential refから全locatorを解決し、callerにraw locatorを選ばせない。
  - Directory mutationはexpected user/operation/epochを全てCAS条件に含める。
  - link/unlinkをpayload digest付きの再開可能Account Home operationにし、成功時のsession epoch bumpを一度だけ保証する。

### B-IS2-005 — password resetは複数shardでone-time consumeを保証せず、SSO mappingをpasswordへ変換できる

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:423-491`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:236-305`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:169-196`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:159-213`
- 根拠:
  - token保存は対象locatorにactive password mappingが存在するか、mapping ownerがinput userIdかを検証しない。
  - active/previous shardを順番にconsumeするため、1 shard consume後に次のRPCが失敗すると、別operationが残りのshardで同じtokenをconsumeできる。
  - hash置換とsession epoch更新を管理するAccount Home reset operation/phaseがなく、途中状態を単一authorityから再開できない。
  - `replacePassword` は元mappingのkindを検証せず、SSO email aliasも`kind='password'`へ更新する。SSO-only accountでもreset tokenを保存できる。
  - Account Home側の完了記録は固定kind `"sso-link"` であり、reset payload/idempotencyを表現しない。
- 影響:
  - one-time tokenの二重operation利用、generation間の新旧password分裂、session revocation漏れ、意図しないSSO-only accountのpassword化が起こる。
- 修正案:
  - reset requestでactive password credentialをserver側解決し、該当時だけtoken/mail jobを作る。
  - Account Homeをreset saga authorityとし、token claim・全locator hash更新・epoch bumpを同一operation/phaseから再開する。
  - first shard consume直後のfailure、別operation再送、SSO-only、operation ID collisionをtestする。

### B-IS2-006 — 退会途中にUser Data削除後で再起動すると再開不能で、完了後Account Homeにもlocator/operation履歴が残る

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:585-610`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:169-185`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:675-690`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:314-388`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:425-486`
- 根拠:
  - `deleteAll()` 後、Account Home finish前にfailureしてUser Data DOが再起動するとschemaは再作成されるがprofile rowはない。再送の`profile()`は「tableなし」ではなく「rowなし」で失敗し、gatewayの限定的catchではidempotent成功にできない。
  - 現在のtestはdelete saga完了後の再送だけで、deleteAll直後のfaultを注入しない。
  - `finishDeletion` はaccountのemail/auth methodをnullにするだけで、`credential_locators` と過去の `identity_operations` を削除しない。
  - SSO operation digestはunkeyed fingerprint of provider/subject/email/userIdであり、退会後もdictionary照合可能なpseudonymous PIIになり得る。
- 影響:
  - Account Homeが永久にdeletingとなるfault pointがあり、Issueの「同じoperation/epochで再開」に反する。
  - 完了後はopaque account key/tombstone/epoch/timeだけを残すというdata minimization要件を満たさない。
- 修正案:
  - User Dataにowner非依存のdeletion marker/idempotency recordを設け、空DB・再activation後も同じoperationを成功として再開する。
  - deletion完了transactionでlocator rowsと不要operation rows/payloadを消去し、非PII tombstoneだけを残す。
  - deleteAll直後、Directory purge途中、finish直前のrestart/fault testと残存列監査を追加する。

### B-IS2-007 — PITR operatorの `objectName` と `accountId` が無関係で、実restore後のauthorityも確認していない

- 場所:
  - `apps/web/app/operator/pitr.ts:23-29`
  - `apps/web/app/operator/pitr.ts:80-107`
  - `packages/core/src/adapters/cloudflare/pitrOperator.ts:39-51`
  - `docs/runtime_cloudflare.md:222-254`
- 根拠:
  - operator inputはrestore対象objectと照合用Account Homeを独立した任意文字列として受ける。
  - User Dataでは `objectName === accountId` を検証しないため、別のactive accountIdを添えてdeleted accountのUser Dataをrestoreできる。
  - Identity Directory objectは複数accountを含むbucketだが、任意の1 Account Homeだけを確認してbucket全体をrestoreする。
  - `onNextSessionRestoreBookmark` は次のobject sessionでrestoreを適用する予約APIなのに、operatorは予約直後にAccount Homeを再読して「after restore」checkと見なす。実restoreまでにdelete/epoch変更があっても検出しない。
- 影響:
  - deleted/unlinked account data・credential mappingを誤って復活させ、Directory shard内の他ユーザーへも影響する。B-IS2-003により復活したSSO mappingはloginにも利用できる。
- 修正案:
  - User Data targetはcanonical accountIdと同一であることを強制する。
  - Directory restoreは対象bucket内の全mapping user/epochをbounded scanし、各Account Home authorityへ照合・reconcileする専用workflowにする。
  - restore適用完了を確認した後にauthorityを再読し、変更時は対象を公開せずundo/reconcileする。
  - mismatched target、restore予約後delete、shared shard複数accountをintegration testする。

### B-IS2-008 — rotation/reconcilerはproductionから呼べず、旧key除去とreservation回復を運用できない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:794-939`
  - `apps/web/app/operator/pitr.ts:110-169`
  - `apps/web/scripts/pitr-operator.ts:9-46`
  - `docs/runtime_cloudflare.md:122-134`
  - `docs/runtime_cloudflare.md:189-191`
- 根拠:
  - `rotatePreviousGeneration` と `reconcileExpiredReservations` はgateway methodとして存在するが、request containerは`IdentityApplicationPort`に狭められ、operator endpoint/CLI/Alarmから一度も呼ばれない。
  - 文書の「operator-only checkpoint scan」に対応するコマンドはなく、既存operatorはPITR bookmark/restoreだけである。
  - reconcilerはpending Account Homeの期限切れreservationをactivate/tombstone/reclaimせず、そのまま残す。
  - rotation checkpointは保存するだけで読み出されず、RPC replay時のcount加算にもoperation IDを使わない。
- 影響:
  - previous keyを安全に外せず、partial signup/SSO reservationのorphanを運用回復できない。文書手順を実行しても受け入れ条件を確認できない。
- 修正案:
  - 認証・allowlist付きoperator maintenance boundaryまたはAlarmを実装し、全bucket checkpoint/resume/zero-reference auditを接続する。
  - pending operationをAccount Home phaseとUser Data状態からresumeまたはcompensateするreconcilerへ拡張する。
  - process restart、checkpoint RPC response loss、conflict残存、2連続rotationをproduction boundary経由でtestする。

### B-IS2-009 — RPC validation/retryがfail closedでなく、platform exceptionとlegacy shapeがtyped security boundaryを迂回する

- 場所:
  - `packages/core/src/application/identity/rpc.ts:39-76`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:261-307`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:103-178`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:443-470`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:96-155`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:304-384`
- 根拠:
  - 共通validatorはversion、payloadがobject、operationId非空しか見ず、per-methodのenum、bounded string、finite timestamp、user/locator対応を網羅しない。
  - Account Home `advanceOperation` 等はruntimeで任意state/kindを受け、identity operation state列にもCHECKがない。
  - legacy overloadはversion validatorを通らずraw mutationを受ける。
  - stub自体がthrowしたnetwork/platform errorは `RemoteIdentityError` でないためretryされず、`translate`もraw Errorのまま返す。
- 影響:
  - deploy skewやmalformed internal callがinvalid stateを作る、または一時障害がuntyped 500となる。retry前提のidentity sagaが回復しない。
- 修正案:
  - 全RPCをversioned discriminated schemaでruntime parseし、legacy overloadは必要なrollout versionとして明示的に検証するか削除する。
  - platform exceptionをbounded retry後 `SystemError(NetworkError)` へ変換し、mutationはpayload digest付きidempotencyを強制する。
  - invalid state/kind/timestamp/locator、unknown version、platform throw、response-loss replayをcontract testする。

## Warnings

### W-IS2-001 — idempotency digestに独自64-bit非暗号hashを使う

- 場所: `packages/core/src/application/identity/coordinator.ts:33-43`
- 影響: operation payloadの同一性というsecurity boundaryで意図的衝突耐性を期待できず、SSO digestは低entropy PIIのdictionary照合にも弱い。
- 修正案: canonical payloadへSHA-256/HMACを用い、退会時に不要digestを削除する。

### W-IS2-002 — cross-generation password mappingのhash/epoch不一致をfail closedにしない

- 場所: `packages/core/src/application/identity/coordinator.ts:227-242`
- 影響: 同じuserIdなら先頭mappingを採用し、hash/account epochの不一致を検知しない。partial resetやPITR drift時にgenerationの並び次第で旧passwordが使える。
- 修正案: active/previous結果のowner/hash/epoch整合を検証し、不一致は認証失敗＋内部data-integrity signalにする。

### W-IS2-003 — login timing testが実際のDirectory/Account Home呼出回数とpublic envelopeを比較していない

- 場所:
  - `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts:67-151`
  - `packages/core/src/application/identity/__tests__/loginAuthority.test.ts:60-86`
- 影響: 現テストはdummy hash warningとauthority statusを別々のfakeで見るだけで、unknown/SSO-only/wrong password/active/previousが全locator lookup・1verify・1authority lookup・同一public errorになることを保証しない。
- 修正案: gateway/usecase/actionを通すcall-count contract testを追加し、active/previous順序とfailure envelopeを比較する。wall-clock自体ではなくwork profileをassertする。

### W-IS2-004 — session/PITR secret checkは文字数だけで、型も通常のstringへ戻る

- 場所:
  - `packages/core/src/application/di/serverCloudflare.ts:29-39`
  - `packages/core/src/application/di/secrets.ts:46-54`
  - `apps/web/app/operator/pitr.ts:119-129`
- 影響: 低entropyの反復文字列でも32文字なら通り、`RequestServerConfig.sessionSecret` は検証後もbranded typeでない。運用文書はrandom生成を指示するが、code boundaryは誤設定を十分表現しない。
- 修正案: validated branded secretをconfig型に保持し、PITR tokenも同じfactoryで検証する。entropy測定ではなく、base64 decoded byte length/formatとsecret manager生成手順をcontract化する。

### W-IS2-005 — operator endpointの成功・失敗responseに明示的な`no-store`がない

- 場所: `apps/web/app/operator/pitr.ts:110-169`
- 影響: POSTは通常cacheされないが、bookmarkや内部error codeを返す管理面はintermediary/client cacheに依存せず機密扱いすべきである。
- 修正案: 全operator responseへ `Cache-Control: no-store, private` を付与する。

### W-IS2-006 — SSO subject、operation ID、operator object名に一貫した長さ上限がない

- 場所:
  - `packages/core/src/application/identity/contracts.ts:18-29`
  - `packages/core/src/application/identity/contracts.ts:341-348`
  - `apps/web/app/operator/pitr.ts:64-77`
- 影響: 現在は非公開/認証済みcaller中心だが、巨大key/payloadをHMAC、SQLite key、DO nameへ渡せる。
- 修正案: domain/application VOとtransport schemaでbyte/code-point上限を統一する。

### W-IS2-007 — identity fault/security testsがhappy path中心で、実装したreconciler/link/unlinkを一度も通さない

- 場所: `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:57-276`
- 影響: signup replayは固定hash、deletion replayは完了後、rotationは直接gateway呼出しだけであり、B-IS2-001〜009の多くを検出できない。`linkSso`、`unlinkCredential`、`reconcileExpiredReservations`、PITR target bindingのtestがない。
- 修正案: 各sagaのRPC前後fault matrixとsecurity invariantsをpublic/operator boundaryから実行する。

## Notes

### N-IS2-001 — password loginとprotected guardはAccount Home authority/session epochを照合する

- 場所:
  - `packages/core/src/application/identity/loginWithPassword.ts:146-166`
  - `apps/web/app/presentation/currentUser.ts:18-37`
  - `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:28-45,96-146`
- pending/deleting/deleted、locator/operation epoch不一致、古いsession epochを拒否する経路は実装された。

### N-IS2-002 — keyring lookupとsecret配置は安全側へ改善された

- 場所:
  - `packages/core/src/adapters/cloudflare/identityRouting.ts:13-42,81-108`
  - `apps/web/wrangler.request.toml:6-33`
  - `apps/web/wrangler.state.toml:6-32`
- active/previous locatorを常に全件計算し、秘密鍵長・generation/secret重複をfail fastする。request/stateのdeclarative secret bindingも分離され、state dry-runにはrequest secret bindingが出ない。

### N-IS2-003 — cookie・error redaction・PII loggingの基本姿勢は維持されている

- 場所:
  - `apps/web/app/presentation/sessionCookie.ts:29-45`
  - `apps/web/app/presentation/errorResponse.ts:58-95`
  - `packages/core/src/application/identity/loginWithPassword.ts:78-93`
- session cookieはHttpOnly/SameSite=Lax/production Secureで、client向けsystem errorはredactされる。dummy verify failure logもerror typeだけでpassword/cause detailを出さない。検索範囲ではemail/subject/tokenを直接logするproduction codeは見つからなかった。

## Summary

- Blockers: 9
- Warnings: 7
- Notes: 3

公開signupのaccount takeover、SSO authority bypass、複数shard resetのone-time破壊、退会/PITR後の復活防止が未解決のため承認不可。
