# ユースケース設計: identity

本番経路は request Worker と3つの SQLite-backed Durable Object に限定する。RPCはversioned primitive DTO/envelopeを使い、mutationにはstable `operationId`を必須とする。

## 公開機能の範囲

#19でユーザー向けに接続するのは既存 #1 の次の4機能だけ。

- `registerWithPassword`
- `loginWithPassword`
- `getCurrentUser`
- `logout`

password change は #11、password reset / SSO OAuth / link / unlink は #12、export完成usecase/UIは #15。#19はこれら将来機能が従うschema・primitive RPC・saga・不変条件・contract testまでを提供する。

## 共通ルーティング

1. request Worker がtransport入力を検証する
2. login前は正規化credentialをversioned HMAC keyringでlocator化し、固定bucketのIdentity Directory DOへ送る
3. login後はsession/tokenから得たcanonical `userId`だけでAccount Home/User Data DOへ送る
4. `AuthenticatedUserDataRouter`はUIと将来のREST/MCPが共有する
5. transport DTOにDO ID、partition key、userId overrideを持たせない

RPCは `{ version, operationId?, payload }` と `{ ok: true, value } | { ok: false, error: SerializedError }` に限定し、callback/repository/custom errorを渡さない。自動retryは冪等mutationだけに行う。

## registerWithPassword

### 入力

```ts
type RegisterWithPasswordInput = Readonly<{
  operationId: string;
  email: string;
  password: string;
}>;
```

### 処理

1. Email/PlainPasswordを検証し、request Workerで`userId`を一度だけ生成する
2. passwordをtransaction外でhashする
3. Account Homeにsignup operationを冪等開始する
4. active/previous email locatorを安定ソートしDirectoryへ予約する
5. credential mappingとpassword hashを保存する
6. User DataのProfile/Settingsを冪等初期化する
7. Directory mappingをactive化し、Account Home auth summary/primary emailを確定する
8. sessionを発行する

同じoperation IDの再送は保存済みphaseから再開し、同じuserIdを返す。全fault pointでDirectory reconcilerがoperation/epoch/User Data状態を照合して回復できる。

### エラー

- 正規化email競合: `ConflictError(EMAIL_ALREADY_REGISTERED)`
- 不正email/password: `BusinessRuleError`
- reservation競合: 勝者を確定して敗者は同じconflictへ収束
- 一時障害: retryable `SystemError`。operation stateは保持

## loginWithPassword

### 処理

1. 入力形状を検証する。形式不正でも列挙耐性のためdummy verify経路へ進む
2. active/previous keyringでemail locatorを計算してDirectory lookupする
3. mappingがpassword credentialなら保存hashをverifyする。それ以外はdummy verifyする
4. Account Homeがactiveでmapping/epochが現行か確認する
5. 成功時だけsessionを発行する

未登録、SSO-only、誤password、不正形式は同じ回数のverify/dummy verifyを行い、すべて同じ `ValidationError(INVALID_CREDENTIALS)` とpublic messageを返す。PIIをログへ出さない。

## getCurrentUser

認証済みsessionのcanonical `userId`からAccount HomeとUser Dataを並行取得し、次を合成する。

```ts
type CurrentUserView = Readonly<{
  userId: string;
  email: string;
  authMethods: readonly ("password" | "sso")[];
  displayName: string | null;
  trashRetentionDays: number;
}>;
```

片側がunavailable/PITR中なら古い片側だけで正常応答せずretryable infrastructure error。Account Homeがdeleting/deletedまたはsession epoch不一致ならunauthorized。

## logout

Cookie/session tokenをpresentationで失効する。Account Home/Directory/User Dataの書き込みは行わない。

## SSO lookup/create primitive

OAuth UIなしの非公開contract。

```ts
type LookupOrCreateSsoInput = Readonly<{
  operationId: string;
  provider: "google" | "apple";
  subject: string;
  verifiedEmail: string;
}>;
```

contract testで初回、同一再送、同時初回、同一email競合、別providerの同一subject、active/previous rotationを確認する。同一credentialは同じuserIdへ収束し、provider境界を跨いで衝突させない。既存emailへの自動linkはしない。

## password change/reset primitive

- change: 現credentialを確認し、new hash保存とsession epoch更新を再開可能sagaで行う
- reset request: 登録有無/credential種別にかかわらず同一success envelope。該当時だけtoken hash/expiryを保存しmail jobをenqueue
- reset consume: tokenをone-time consumeし、password mapping更新とsession epoch更新を同じoperationで再開
- mail送信はAlarm job。provider idempotency keyを使い、SQLite transaction内では送らない

## SSO link/unlink primitive

- linkは新credentialをreservation→initialized→activeへ遷移させてからauth summaryを更新する
- unlinkはlast login credentialを拒否する
- primary emailが残存active email credentialを指すことを維持する
- pending中のloginは確定済みAccount Home auth summaryだけを信頼する
- 成功時にsession epochを更新する

## AI client connection

connectionの認可事実はUser Data DOに置く。approve/list/revokeは認証済み`userId`から同じDOへroutingする。実tokenの削除等の外部I/Oが必要ならprovider idempotency key付きAlarm jobへenqueueし、connection state変更とjob保存を同じtransactionで確定する。

## changeTrashRetentionDays

User Data DOのSettingsを同期transactionで更新する。最早retention job時刻を同じtransactionの戻り値として取得し、commit後にAlarmを設定する。

## Account deletion primitive

1. Account Homeに`deleting` tombstoneと増加epochを保存
2. login/new linkを遮断
3. 全Directory locatorをtombstone
4. User Data `deleteAll`を確認
5. mappingをpurgeし、Account Homeを非PII tombstoneだけに縮退

再送は同じoperation ID/epochから再開する。古いDirectory/User Data PITRは現行tombstone/epochより優先しない。

## Alarm/reconciler

Directory reconcilerと外部I/O jobはat-least-once。jobはlease expiry/reclaim、owner token CAS、attempt、nextRunAt、provider idempotency、poison reasonを永続化する。Cloudflareの最大自動retry後も必要なら自前でAlarmを再設定する。job mutationと最早時刻はtransactionで確定し、`setAlarm`はcommit後にawaitする。
