# Identity

認証 credential の業務不変条件、User Data 内の profile/settings、AI client connection を定義する。分散配置、operation/reservation/locator/epoch/reconciler は application の coordinator state であり、domain entity には含めない。

## 配置境界

| 境界 | 所有する情報 |
|---|---|
| Identity Directory DO | 正規化 email または `(provider, subject)` の credential mapping、reservation、rotation state |
| Account Home DO | userId 単位の auth summary、credential reverse locator、identity saga、session/deletion epoch、非PII tombstone |
| User Data DO | profile、settings、AI client connection、個人コンテンツ |
| request Worker | session/token 検証、versioned HMAC keyring、credential→Directory bucket routing、認証済み userId→User Data routing |

DO/RPC/SQLite/HMAC/bucket/checkpoint は domain 型へ持ち込まない。外部入力から DO ID、partition key、任意の userId を受け取らない。

## ユビキタス言語

| 英語 | 日本語 | 定義 |
|---|---|---|
| Account | アカウント | fog 上の1利用者。canonical `UserId` で識別する |
| Credential | 認証資格 | password email または SSO provider/subject |
| Credential Mapping | credential mapping | credential locator から userId を引く Directory の状態 |
| Account Home | Account Home | account全体の認証要約と分散操作の権威 |
| Profile | プロフィール | User Data に属する表示情報 |
| Settings | 設定 | User Data に属する `trashRetentionDays` 等 |
| Identity Operation | identity operation | signup/change/reset/link/unlink/delete の再開可能な saga |
| Deletion Epoch | 削除epoch | 古い復旧データより優先する単調増加値 |

## ドメイン型

### AccountIdentity

```ts
export type CredentialKind =
  | Readonly<{ kind: "password"; email: Email }>
  | Readonly<{ kind: "sso"; provider: SsoProvider; subject: SsoSubject }>;

export type AccountIdentity = Readonly<{
  userId: UserId;
  primaryEmail: Email;
  credentials: readonly CredentialKind[];
  sessionEpoch: number;
}>;
```

不変条件:

- credential key は全 Directory shard で一意
- `(provider, subject)` は provider 境界を含めて一意
- primary email は active な email credential を指す
- account は少なくとも1つの login credential を持ち、最後の credential は unlink できない
- pending link/unlink 中の login は Account Home の確定済み auth summary に従う
- password change/reset、link/unlink 成功時は session epoch を更新する

### Profile / Settings

```ts
export type Profile = Readonly<{
  userId: UserId;
  displayName: string | null;
  version: number;
}>;

export type Settings = Readonly<{
  userId: UserId;
  trashRetentionDays: TrashRetentionDays;
  version: number;
}>;
```

`Profile` / `Settings` は User Data DO にあり、password hash、reset token、credential locator を持たない。

### AiClientConnection

```ts
export type AiClientConnection =
  | Readonly<{
      status: "active";
      id: AiClientConnectionId;
      userId: UserId;
      clientName: ClientName;
      connectedAt: Date;
      lastUsedAt: Date | null;
      version: number;
    }>
  | Readonly<{
      status: "revoked";
      id: AiClientConnectionId;
      userId: UserId;
      clientName: ClientName;
      connectedAt: Date;
      lastUsedAt: Date | null;
      revokedAt: Date;
      version: number;
    }>;
```

AI client connection は User Data DO に属する認可の事実であり、実 token material は外部 token adapter が所有する。

## 値オブジェクト

- `UserId`: UUIDv7。request Workerが発行し、User Data DO の唯一の partition keyになる
- `Email`: trim + Unicode/ASCII規則に従い小文字正規化。320文字以下
- `PlainPassword`: 8〜128文字。password hash parameterの変更は #20
- `PasswordHash`: algorithm identifier と parameter を含む不透明文字列
- `SsoProvider`: `"google" | "apple"`
- `SsoSubject`: 空でない provider 内主体ID
- `TrashRetentionDays`: 1以上の整数、既定30
- `Actor`: human user または AI client
- `TokenScope`: human/AI の非対称な権限

## ドメインイベント

domain event を残す場合は監査または同一 transaction 内の業務反応だけに使う。外部配送の契約ではない。

| イベント | ペイロード |
|---|---|
| `identity.accountInitialized` | `{ userId, authMethod }` |
| `identity.passwordChanged` | `{ userId }` |
| `identity.trashRetentionChanged` | `{ userId, retentionDays }` |
| `identity.aiClientConnected` | `{ connectionId, userId }` |
| `identity.aiClientRevoked` | `{ connectionId, userId }` |

## Application ports

以下は domain repository ではなく、application coordinator が使う永続化契約。

### CredentialDirectoryPort

```ts
export interface CredentialDirectoryPort {
  lookup(input: CredentialLookup): Promise<CredentialLookupResult>;
  reserve(input: CredentialReservation): Promise<CredentialReservationResult>;
  markInitialized(input: InitializedCredential): Promise<void>;
  activate(input: ActivateCredential): Promise<void>;
  tombstone(input: TombstoneCredential): Promise<void>;
}
```

credential lookup/create primitive は email と SSO の双方で、初回、同じoperationの再送、同時初回、同一メール競合、provider境界、active/previous key rotationを決定的に扱う。

### AccountHomePort

```ts
export interface AccountHomePort {
  getAuthSummary(userId: UserId): Promise<AuthSummary | null>;
  beginOperation(input: BeginIdentityOperation): Promise<IdentityOperation>;
  advanceOperation(input: AdvanceIdentityOperation): Promise<IdentityOperation>;
  listCredentialLocators(userId: UserId): Promise<readonly OpaqueLocator[]>;
  beginDeletion(input: BeginDeletion): Promise<DeletionTombstone>;
}
```

Account Home は saga の権威であり、同じ operation ID を同じ phase から再開する。

### UserDataIdentityPort

```ts
export interface UserDataIdentityPort {
  initialize(input: InitializeUserData): Promise<void>;
  getProfile(userId: UserId): Promise<Profile | null>;
  getSettings(userId: UserId): Promise<Settings | null>;
  deleteAll(input: DeleteUserData): Promise<void>;
}
```

adapter は引数の userId と routing先が一致することを保証し、公開 transport から userId を受け取らない。

### PasswordHasher

```ts
export interface PasswordHasher {
  hash(plain: PlainPassword): Promise<PasswordHash>;
  verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean>;
  dummyVerify(plain: PlainPassword): Promise<void>;
}
```

未登録、SSO-only、誤password、不正形式の全分岐で dummy または実 verify を1回行い、同じ public error envelope とする。

### IdentityJobPort

reset mail 等の外部 I/O を User Data/Directory の永続 job と Alarm に載せる。provider idempotency key を必須とし、同期 transaction 内で外部 I/O を行わない。

## Saga

### password signup

1. request境界で stable `operationId` と `userId` を作る
2. Account Home に operation を開始する
3. active/previous 全 locator を決定順に Directory へ reservation する
4. password hash と mapping を保存する
5. User Data の Profile/Settings を冪等初期化する
6. Directory mapping を initialized→active にし、Account Home auth summary を確定する

各 fault point の後に同じ operation ID で再送できる。Directory reconciler は Account Home operation/epoch と User Data 初期化状態を照会し、orphan/二重 user を作らない。

### SSO lookup/create primitive

OAuth UIは #12。#19は lookup/create primitive、schema、saga contractだけを固定する。同じ provider/subject の再送は同じ userId を返し、別providerの同じsubjectは別credential。同一emailの既存accountへの自動linkは行わず conflict とする。

### password change/reset・SSO link/unlink

ユーザー向けUIと完成usecaseは #11/#12。#19は再開可能 operation、token hash/expiry/one-time consume、link/unlink不変条件、非公開RPC contractだけを提供する。reset request は登録有無にかかわらず同一success envelopeを返す。

### deletion

Account Home に `deleting` tombstone と新epochを先に保存し、login/linkを遮断する。全locatorをtombstone化し、User Data `deleteAll`確認後にmappingをpurgeする。完了後のAccount Homeには非PIIのopaque key、status、epoch、時刻だけを残す。

## 復旧規則

- User Data / Identity Directory のPITR前後に現行Account Home tombstone/epochを照合する
- Account Home restoreは禁止し、operator toolingも対象指定を拒否する
- current user は Account Home のprimary email/auth summaryとUser DataのProfile/Settingsを合成する。片側 unavailable/PITR 中なら古い片側だけで成功させず retryable error
- ログとrouting IDにemail、SSO subject、password/reset tokenを含めない
