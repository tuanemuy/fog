# PR #33 第3回レビュー — Identity / Security

**Date:** 2026-07-28
**Round:** 3回目

## Summary

- Blockers: 8
- Warnings: 3
- Notes: 3
- Verdict: **BLOCKED**

現在の `main...HEAD` をゼロから確認した。password login の Account Home
authority照合、session epoch、logical credential単位のlink/unlink、退会完了時の
Account Home最小化、request/state secret分離は実装されている。

一方、fresh requestでのsaga再送、初期化済みreservationのreconcile、
dual-write期間のrotation、PITR適用確認、password change/reset request契約、
RPC runtime validationに受け入れ条件との不整合が残る。既存identityテストは
greenだが、同じ時刻・hashを再利用するなど、実際の再送・eviction条件を再現して
いない。

## Blockers

### B-001 — signupのfresh retryがUser Data初期化のidempotency conflictになる

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:125`
  - `packages/core/src/application/identity/coordinator.ts:210`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:74`
- 影響:
  - `initialize()` のpayload digestに `now` を含めている。signupが
    `signup-after-initialize` で失敗し、ブラウザが同じoperation IDを再送すると、
    requestごとに `clock.now()` が変わるため、同じuserIdでも
    `IdempotencyConflict` になる。
  - specの「同じoperation IDで保存済みphaseから再開」とAC-3の全fault point回復を
    満たさない。Directoryにはinitialized mapping、Account Homeには
    `credential-reserved` が残り、公開signupを完了できない。
  - fault testは最初と再送で同じinput object（`now: 1`）を使うため、この障害を
    検出しない。
- 修正案:
  - initializeのidempotency identityをstableな `operationId + userId` に限定し、
    `now` は初回保存値として扱う。
  - 公開`registerWithPassword`を2回の別requestとして実行し、2回目のclock、
    server-generated proposed user、salt付きhashが変わるfault testを追加する。

### B-002 — credential競合の敗者にpending Account Homeが残る

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:151`
  - `packages/core/src/application/identity/coordinator.ts:160`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:47`
  - `.thread/19/plan.md:87`
- 影響:
  - signupはDirectory reservationより先に、新しいuserIdのAccount Homeへ
    operationとprimary emailを保存する。同じemailの同時初回でDirectory競合に
    負けても、Account Homeをcompensate/de-identifyする処理がない。
  - SSO createも同じ順序で、provider/email reservation競合の敗者にpending
    Account Homeが残る。
  - 「競合時は勝者を確定して敗者は補償を再開」「orphan/二重userなし」という
    plan/AC-3に違反し、PIIを含む到達不能なaccount stateが蓄積する。
  - 現在のidentity integration testには同一credentialの同時初回がない。
- 修正案:
  - Account Homeにpayload-digest付きcompensation phaseを設け、Directoryの勝者が
    別userなら敗者homeを非PII tombstoneへ収束させる。
  - password/SSOそれぞれで異なるoperation IDの`Promise.all`競合を実行し、
    mappingが1件、active Account Homeが1件、敗者PIIが0件であることを検証する。

### B-003 — reconcilerがUser Data初期化済みreservationをtombstoneにする

- 場所:
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:663`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1288`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1316`
  - `.thread/19/plan.md:89`
- 影響:
  - expiry scanは`reserved`だけでなく`initialized`も返すが、reconcilerが読むのは
    Account Home summary/operationだけで、User Dataの初期化状態を照会しない。
  - signupがUser Data初期化とDirectory `markInitialized` の後、
    Account Home advance前に停止すると、operationは
    `credential-reserved` のままである。期限後のreconcilerはこの正常に
    初期化済みのmappingをtombstone化し、同じoperationの再開を
    `RESERVATION_LOST` にする。
  - planが要求する「Account Home operation/epochとUser Data初期化状態を照会し、
    initializedを確定するか未初期化だけを回収する」を実装していない。
- 修正案:
  - reconciler portにUser Data initialization probeを追加する。
    initializedならAccount Home phaseを前進させてactivate、未初期化かつ期限切れの
    reservationだけをcompensateする。
  - `signup-after-initialize` の後にevictionとexpiryを挟み、operator
    `reconcile-page`からactiveへ収束するtestを追加する。

### B-004 — dual-write期間に作成したcredentialをrotationで排出できない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1043`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1435`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:82`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1243`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:535`
- 影響:
  - active/previous keyringで新規作成したcredentialは、最初から両generationに
    active mappingを持つ。rotationはprevious rowごとに新しいrotation operationで
    active locatorを`reserve()`するが、active側には元のsignup/link operationのrowが
    既にあるため `CREDENTIAL_ALREADY_REGISTERED` になる。
  - operatorはこれをconflict countにしてcursorを進め、最後のpageでは
    `completedAt`まで保存する。previous mappingはactiveのまま残り、previous secretを
    安全に破棄できない。
  - checkpoint保存はRPC operation IDを永続化せず、response lossによるretryで
    scanned/moved/conflict countを二重加算する。
  - 既存の2連続rotation testは各generationでactive locatorが存在しないaccountだけを
    移送しており、dual-write中に作成したcredentialを検証しない。
- 修正案:
  - active locatorが同じlogical credential/user/epoch/canonical valueで既にactiveなら
    冪等な移送済みとしてAccount Home reverse locator更新とprevious tombstoneへ進む。
  - conflictが残るbucketをcompletedにせず、解決可能なcheckpoint stateを保存する。
    checkpoint mutation自体もoperation IDでexactly-onceにする。
  - active+previous構成でpassword signup/SSO create/linkしてからoperator route経由で
    rotateし、全bucketのprevious mapping/reverse locatorが0になるtestを追加する。

### B-005 — PITR verifyはrestore適用前でも成功する

- 場所:
  - `packages/core/src/adapters/cloudflare/pitrOperator.ts:120`
  - `packages/core/src/adapters/cloudflare/pitrOperator.ts:146`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:398`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:542`
- 影響:
  - receiptにはrestore予約時に返る`undoBookmark`があるが、verifyは古い
    `restoreBookmark`だけをDOへ渡す。
  - User Dataは`current >= restoreBookmark`だけを確認する。restore前の現在位置は
    過去bookmarkより新しいため、restart/restoreが起きていなくてもこの条件を満たす。
  - Identity Directoryは比較すらせず、verify呼出し自身でmarkerを書いてcurrent
    bookmarkを返すため、未適用を必ず成功として扱える。
  - Cloudflare公式仕様では`onNextSessionRestoreBookmark()`の戻り値は
    「recovery直前（現時点ではfuture）のbookmark」である。この`undoBookmark`と
    restored sessionのcurrent bookmarkを比較するのが、少なくともrestart適用済みを
    区別できる境界である。
- 修正案:
  - verifyへreceiptの`undoBookmark`も渡し、currentがそのfuture boundary以降である
    ことを確認する。User Dataは加えてrunbookのrecognizable stateを検証できる
    operator probeを持たせる。
  - schedule直後・restart前のverifyが失敗し、restart後だけ成功するcontract testを
    追加する。
  - 参考: [Cloudflare SQLite-backed DO PITR API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api)

### B-006 — password changeとreset request/mail jobのprimitive契約が未実装

- 場所:
  - `spec/usecases/identity.md:105`
  - `spec/domains/identity.md:181`
  - `.thread/19/plan.md:78`
  - `packages/core/src/application/identity/contracts.ts:418`
  - `packages/core/src/application/identity/coordinator.ts:558`
- 影響:
  - `IdentityPrimitivePort`にはpassword change methodがなく、
    `IdentityOperationKind`の文字列以外に再開可能なchange saga/RPC/testがない。
  - resetはcallerが`email + userId`を渡す`storePasswordReset()`とconsumeだけで、
    登録有無/credential種別を隠す同一success reset-request primitiveがない。
  - specが要求する`IdentityJobPort`、reset mail job、provider idempotency keyとの
    接続も存在しない。generic User Data job runnerはreset requestから呼ばれない。
  - #11/#12へUIを延期することは許されているが、#19の成果物は
    schema/application port/restartable saga/private RPC/contract testまでであり、
    現状はその引継ぎ境界を満たさない。
- 修正案:
  - password changeとreset requestを`IdentityPrimitivePort`へ追加し、Account Home
    operationを権威に全locator更新・session epoch bumpを再開可能にする。
  - reset requestは常に同じsuccess envelopeを返し、password credentialがある場合
    だけtoken保存とprovider-idempotent mail jobをatomicに確定する。
  - unknown email、SSO-only、password accountのpublic response/work profile、
    job replay、各RPC前後faultをcontract testにする。

### B-007 — identity RPCのper-method runtime validationが閉じていない

- 場所:
  - `packages/core/src/application/identity/rpc.ts:40`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:243`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:274`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:350`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:410`
- 影響:
  - 共通validatorはversion、object payload、operation IDしか検証しない。
    `add/remove/replaceCredentialLocator`、deletion、reset token、scan/checkpoint等は
    payloadをruntime parseせず、TypeScript上の型をそのまま信頼する。
  - 欠落field、巨大token/cursor/generation、NaN/負数timestamp・count、不正kindは
    validation envelopeで拒否されず、SQLite/VO例外をretryable infrastructure errorへ
    誤分類するか、意図しないstateを保存する。
  - `advanceOperation`はstate名がunion内かだけを見ており、operation kindごとの合法な
    transition tableをRPC/storeで強制しない。
  - integration testはunknown versionを1件確認するだけで、planの
    primitive RPC/input/limits contractを満たさない。
- 修正案:
  - methodごとにonly-keys、bounded UTF-8 length、finite/safe integer、enum、
    locator整合を検証するschemaを置く。
  - Account Home storeにoperation kind別transition matrixとowner/epoch CASを実装し、
    malformed inputは必ずnon-retryable validation envelopeにする。
  - 全RPC methodへtable-driven malformed/unknown-field/limit testを追加する。

### B-008 — account deletionはUser Data eviction後に再開不能になり得る

- 場所:
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:325`
  - `apps/web/app/durable-objects/UserDataDurableObject.ts:442`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:911`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:500`
- 影響:
  - `deleteAll()`は全SQLiteを削除する。直後の同一sessionではgatewayが
    `no such table: profile`を成功扱いできるが、eviction後はconstructor migrationが
    空の`profile` tableを再作成する。
  - その状態で再送すると`profile().one()`は「tableなし」ではなく「rowなし」で失敗し、
    gatewayのcatch条件（NotFoundまたは`no such table`）に一致しない。
  - fault testはdelete直後に同じstubへ再送するだけでevictionを挟まないため、
    Account Homeが永久に`deleting`となるproduction faultを検出しない。
- 修正案:
  - User Data deletionをowner/operation ID付きの永続的なdeletion markerとして扱うか、
    空で初期化済みのDBも同じdelete operationの成功として判定できる狭いRPCを設ける。
  - `delete-after-user-data` の後にDO eviction/reconstructionを挟み、同じoperation/epochで
    Directory purgeとAccount Home completionまで到達するtestを追加する。

## Warnings

### W-001 — Directory PITRのshard allowlist検証がrestore予約より後になる

- 場所:
  - `apps/web/app/operator/pitr.ts:211`
  - `apps/web/app/operator/pitr.ts:224`
  - `packages/core/src/adapters/cloudflare/pitrOperator.ts:120`
- 影響:
  - `resolveDirectory()`は`generation:number`形式だけを確認して任意名のDOを選び、
    configured generation/bucket範囲の検証はverify後のreconcileで初めて行う。
    typoやretired generationにもrestoreを予約した後でしか失敗しない。
- 修正案:
  - schedule/bookmark/restart前のtarget解決時にkeyring generationとbucket countへ照合する。

### W-002 — request/state integration harnessがsession epochを照合しない

- 場所:
  - `apps/web/app/testing/request.integration.worker.ts:117`
  - `apps/web/app/testing/request.integration.worker.ts:132`
  - `apps/web/app/presentation/currentUser.ts:18`
- 影響:
  - productionの`requireUserId()`はAccount Home status/session epochを確認するが、
    integration workerのcurrent/logoutはHMAC token verifyだけでusecaseへ進む。
    reset/link/unlink/delete後の旧session拒否をrequest→state boundary testが証明しない。
- 修正案:
  - test harnessでもproduction auth guardを共有し、epoch bump後の旧cookieが401になる
    request-level testを追加する。

### W-003 — restored Directory reconcileのconflict完了条件が明確でない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1370`
  - `packages/core/src/adapters/cloudflare/pitrOperator.ts:160`
  - `apps/web/scripts/pitr-operator.ts:80`
- 影響:
  - pageのconflict countが非zeroでもcursorがnullならCLIはrestore verification完了とする。
    一時的なauthority競合を「全mapping照合済み」と誤認しやすい。
- 修正案:
  - conflictを再試行可能checkpointとして残すか、operatorの完了条件を
    `cursor === null && conflicts === 0` としてrunbookにも明記する。

## Notes

### N-001 — password loginとprotected sessionはAccount Home authorityをfail closedで照合する

- 場所:
  - `packages/core/src/application/identity/loginWithPassword.ts:146`
  - `apps/web/app/presentation/currentUser.ts:18`
- password mappingのhash、locator、operation epochと、Account Homeのactive status、
  session epochを照合している。pending/deleting/deletedや旧sessionは拒否される。

### N-002 — logical credential単位のlink/unlinkと退会後最小化は改善されている

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:866`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:246`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:429`
- active/previous locatorを1 logical credentialとしてunlinkし、last credentialを二重に
  guardしている。退会完了時はlocatorと不要operationを削除し、email/auth methodを
  nullにしている。

### N-003 — 実行した既存testはgreenだが、本指摘のfresh retry/eviction条件は未検証

- 実行結果:
  - identity DO integration: 27 passed
  - identity application/operator/security unit: 25 passed
- テスト成功は現行happy/fault fixtureの結果であり、B-001、B-003、B-004、B-005、
  B-008のproduction条件を否定しない。
