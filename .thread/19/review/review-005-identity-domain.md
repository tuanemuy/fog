# Identity / Domain / Security Review #005

**PR:** #33
**Date:** 2026-07-28
**Round:** 5回目
**Scope:** Identity / Domain / Security

## Summary

- Blockers: 0（5件修正済み）
- Warnings: 0（2件修正済み）
- Notes: 1
- Verdict: **RESOLVED**

## Resolution

- B-IDDS5-001: routing keyと独立したHMAC payload fingerprintとregistry専用暗号鍵を導入し、signup/SSO replayを旧routing key削除後も認証可能にした。
- B-IDDS5-002: reset requestのsecret/hash/expiryをoperation registryへ初回永続化し、locator/mailの部分成功後も同一secretで再開可能にした。
- B-IDDS5-003: 全identity sagaで`AccountIdentity`遷移を初回永続化前に評価し、completed replayのpayload認証とdomain結果・Account Home結果の一致検証を追加した。deleteも`markDeleting`/`markDeleted`を通す。
- B-IDDS5-004: Account Homeへgeneration別active locator count RPCを追加し、rotation checkpointへ集計した。statusはDirectory activeとAccount Home activeがともに0の場合だけ`retirementReady`を返す。
- B-IDDS5-005: mail claim前expiry terminal化、provider非呼出、completed/poison時のemail/secret ciphertext消去、24時間後のterminal row purgeを追加した。
- W-IDDS5-001: registry/reset mail/Account Home mutationのscalar、byte長、enum、時刻、locator validationを強化した。
- W-IDDS5-002: signup/SSO/reset registryのlookup/prepare transactionで期限切れrowを削除するlazy TTL cleanupを追加した。

検証結果:

- Identity integration: 40/40
- Identity domain/application unit: 70/70
- State integration: 84/84
- Core/Web typecheck: pass
- lint / format / `git diff --check`: pass

## Blockers

### B-IDDS5-001 — 暗号化operation registryがstable replayを判定できない

- 場所:
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:528-562,588-628`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:237-370`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:856-895,1096-1170`
  - `.thread/19/plan.md:77-79,176`
  - `spec/domains/identity.md:196-200`
- 根拠:
  - SSO prepareは再送ごとにrandom IVのAES-GCM ciphertextを作るが、storeは保存済み`subject`/`email` ciphertextとの文字列一致を要求する。同じoperation/provider/subject/emailをmapping作成前のfaultから再送してもciphertextが変わるため`IDENTITY_OPERATION_PAYLOAD_CONFLICT`になる。
  - password prepareは旧envelope generationを復号できない場合、email比較を丸ごと省略して既存entryを返す。同じoperation IDを異なるemailで再送しても、旧key削除後はpayload conflictを検出しない。
  - 追加されたSSO winner testはstoreの`reserve`を直接呼ぶため、公開`lookupOrCreateSso`の同時初回、prepare直後のfault、同一payload replayを通らず、この破綻を検出しない。
- 影響:
  - AC-2/AC-3が要求する同一operationの決定的再送が、process crash位置やkey retirement有無で失敗または異payload受理になる。
  - caller-controlled operation IDに対するidempotency payload bindingが成立しない。
- 提案:
  - registryにPIIを復元できないkeyed payload fingerprintを暗号文とは別に保存し、再送比較をfingerprintで行う。
  - SSO registryにもlookup RPCを用意し、初回のuserId/payload/時刻を再利用する。
  - prepare成功直後から最初のreserve前までのfault、同一payload再送、異payload拒否、旧key削除後を公開gateway testで固定する。

### B-IDDS5-002 — password reset requestは同一operationを再開できない

- 場所:
  - `packages/core/src/application/identity/coordinator.ts:636-685`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:529-567`
  - `packages/core/src/application/identity/contracts.ts:286-305,419-437`
  - `.thread/19/plan.md:77-79`
  - `spec/domains/identity.md:202-204`
- 根拠:
  - `requestPasswordReset`は呼び出すたびに`crypto.randomUUID()`で別secret/hashを生成する。
  - `reset_tokens.operation_id`はuniqueで、同operationの既存rowは同じtoken hashを要求する。1 locator保存後、残りlocatorまたはmail enqueue前に失敗すると、再送は新hashになり最初のlocatorでpayload conflictになる。
  - secret/hashをoperation IDから再取得するprepare registryがなく、`Promise.all`の部分成功から回復できない。
- 影響:
  - reset requestのpartial failureが永久に再開不能になり、AC-3の再開可能saga primitiveとstable operation ID契約を満たさない。
- 提案:
  - operation ID単位で最初のreset secret/hash/expiryを暗号化prepareし、全locator保存とmail enqueueが完了するまで同じ値を再利用する。
  - secret生成はapplicationのambient cryptoではなくCSPRNG portへ置き、prepare後、各locator後、mail enqueue前後のfault testを追加する。

### B-IDDS5-003 — `AccountIdentity`は依然として状態遷移の権威ではない

- 場所:
  - `packages/core/src/domain/identity/accountIdentity.ts:27-103,107-219`
  - `packages/core/src/application/identity/coordinator.ts:272-290,576-594,774-797,919-942,1189-1216`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:489-568`
  - `.thread/19/plan.md:66-72`
- 根拠:
  - `AccountIdentity`はstatusとnullable primary emailの直積型のままで、不正状態を型で排除するdiscriminated unionではない。
  - signup/SSO create/change/resetのdomain callは永続化完了後に実行され、戻り値も破棄される。domain invariantが失敗してもDirectory/Account Homeは既に更新済みで、遷移を決定していない。
  - deleteは`markDeleting`/`markDeleted`を一度も呼ばず、storeが直接status/session epochを更新する。
  - domain側も`replacePassword`がactive状態を要求せず、`markDeleting`は既にdeletingのaccountでsession epochを再度増やすため、そのまま権威へ昇格できる状態機械ではない。
- 影響:
  - create/change/reset/deleteの業務不変条件をadapter手続きが迂回でき、domain testがgreenでも実sagaの正当性を保証しない。
  - domain validationがpost-commitで失敗すると、呼び出しはerrorでも永続状態だけ進む。
- 提案:
  - status別の直和型と明示的なidempotent遷移へ再構成する。
  - Account Home snapshotからdomain aggregateを復元し、domain operationの結果を永続化commandへ変換してから副作用を開始する。
  - signup、SSO create/link/unlink、change/reset、deleteの全経路でdomain結果と永続結果の一致をcontract testにする。

### B-IDDS5-004 — secret retirementに必要なAccount Home側zero集計が存在しない

- 場所:
  - `apps/web/app/operator/identity-maintenance.ts:12-78,118-143`
  - `packages/core/src/adapters/cloudflare/identityGateway.ts:1935-1948`
  - `packages/core/src/adapters/cloudflare/account-home/store.ts:437-485`
  - `apps/web/app/durable-objects/__tests__/identity.integration.test.ts:820-854`
  - `.thread/19/plan.md:87-88`
  - `docs/runtime_cloudflare.md:161-179`
- 根拠:
  - operatorの`status`はDirectory shardのauthority statusだけを返し、Account Home reverse locatorをgeneration別に列挙・集計するAPIがない。
  - rotation testは1 accountのauthority locator数とDirectory旧shardの`active: 0`だけを確認する。全Account Homeの旧generation active referenceが0であることは検査しない。
  - runbookはDirectory mappingとAccount Home reverse locatorの双方がzeroになってからprevious secretを削除すると要求するが、現在のtoolingでは後者を証明できない。
- 影響:
  - Account Homeに旧referenceが残ったままprevious keyを削除でき、authority/reconcile/後続rotationの参照不能を見逃す。
- 提案:
  - rotation対象userをcheckpoint付き台帳へ記録し、各Account Homeのgeneration別active countを集約するoperator contractを追加する。
  - previous generationのDirectory active countとAccount Home active reverse countの双方が全bucketで0でなければretirement gateを失敗させる。

### B-IDDS5-005 — reset delivery secretを期限後も送信・無期限保持する

- 場所:
  - `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:110-151`
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:570-724`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:375-476,904-984`
  - `spec/domains/identity.md:181-183,202-204`
- 根拠:
  - mail jobにはpayload expiry/terminal retention列がなく、`expiresAt`は暗号化JSON内だけにある。
  - runnerは復号した`expiresAt`と現在時刻を比較せず、retryがtoken expiryを越えてもproviderへsecretを送る。
  - completedはstate/leaseだけを更新し、暗号化email/reset secretを消さない。poison rowにも同じpayloadが残り、terminal prune処理がない。
- 影響:
  - 利用不能な期限切れsecretを外部providerへ送信する。
  - mail encryption keyが利用可能な限り、完了・poison済みreset secretとemailを目的なく無期限復号でき、短寿命delivery payloadというdata minimization契約を満たさない。
- 提案:
  - claim前または送信前にexpiryを検証し、期限切れはproviderを呼ばずterminal化する。
  - completion時にdelivery ciphertext/emailを消去し、必要なら非PII idempotency tombstoneだけを限定期間保持する。
  - poisonを含むterminal retention/prune Alarmとexpiry越えno-delivery testを追加する。

## Warnings

### W-IDDS5-001 — Identity RPCのscalar/bounds検証がmethodごとに欠落している

- 場所:
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:486-617,904-984`
  - `apps/web/app/durable-objects/AccountHomeDurableObject.ts:264-278,319-415,418-466`
- 根拠:
  - signup prepareは`opaqueOperationKey`、`emailEncrypted`の型・長さを検査せず、SSO prepareも`opaqueOperationKey`と`emailEncrypted`を検査しない。
  - reset mail enqueueはemailの型・長さ・VO validationと`expiresAt > now`を検査しない。
  - Account Homeのadd/remove/replace/beginDeletion/finishDeletionはshapeだけを検査し、`now`、`epoch`、boolean、credential IDの型・範囲を統一して検査しない。
- 影響:
  - service bindingの型を迂回したmalformed/巨大payloadがstorage errorへ誤分類されるかSQLiteへ到達し、versioned RPCのfail-closed/DoS境界が不均一になる。
- 提案:
  - method別の手書き検査を共通decoderへ集約し、全string byte上限、integer、boolean、enum、時刻関係を境界で検証する。
  - unknown fieldだけでなくinvalid scalarと上限±1を全RPC table testへ追加する。

### W-IDDS5-002 — operation registryのTTLはAlarm実行だけに依存する

- 場所:
  - `packages/core/src/adapters/cloudflare/identity-directory/store.ts:237-263,313-370`
  - `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:219-244,486-617`
- 根拠:
  - lookup/prepare queryは`expires_at`を条件に含めず、request input gateでも先に期限切れrowをpurgeしない。
  - Alarmが遅延・失敗して期限を越えた場合、次のprepareは期限切れregistryをreplayとして返す。
- 影響:
  - TTLが論理的な上限ではなくbest-effort cleanup時刻になり、古いoperation IDのuser/hash/PII bindingが予定より長く有効になる。
- 提案:
  - lookup/prepare transaction内で`expires_at <= now`を無効化・削除してから判定し、Alarmは物理cleanupの補助に限定する。

## Notes

### N-IDDS5-001 — 確認範囲

- Issue #19、PR #33、`.thread/19/plan.md`、Identity domain/usecase/database設計、Round 4 triage、`main...HEAD`差分と現在のworking treeを再照合した。
- 既に修正済みのopaque routing境界、login work profile、production fault hook除去、credential envelope encryption、reconcile backoff/poisonは再掲していない。
- コード変更、commit、pushは行っていない。
