# Identity

ユーザーの認証・AIクライアント認可・ユーザー設定を管理するドメイン。

操作主体（Actor）と権限スコープ（TokenScope）の定義は全ドメインの前提となるため、本ドメインが一箇所で定義し、memo / knowledge / trash 等の他ドメインへ提供する（→ [ADR-004](../adr/004-domain-boundaries.md)）。

## スコープに関する注意

OAuth 2.1 / セッション管理のプロトコル詳細（アクセストークン・リフレッシュトークンの形式、PKCE、認可コードフロー、セッションCookie等）は**アダプター/インフラ層の関心事**であり、本ドメインには置かない。ドメインが持つのは次の2つだけである。

- **接続（AiClientConnection）**: 「ユーザーがこのAIクライアントに自分のデータへのアクセスを許可した」という認可の事実
- **スコープ（TokenScope）**: その接続（またはセッション）に与えられる権限の範囲

トークンの発行・検証・失効反映のタイミングはアダプターの責務だが、「失効済み接続のトークンは無効」という規則の根拠（接続の失効状態）はドメインが持つ。

## ユビキタス言語

| 英語名 | 日本語名 | 定義 |
|---|---|---|
| User | ユーザー | fog のアカウント。メールアドレスで一意に識別され、パスワード認証または SSO で認証される |
| Auth Method | 認証方式 | ユーザーの認証手段。パスワード認証と SSO のいずれか（排他） |
| SSO | SSO | Google / Apple 等の外部 IdP による認証。プロバイダ種別とプロバイダ内主体IDの組で識別する |
| AI Client Connection | AIクライアント接続 | ユーザーが OAuth 2.1 の認可フローで自分の AI クライアントに許可を与えた「認可の事実」。1回の許可＝1接続 |
| Revoke | 失効（接続解除） | AIクライアント接続を無効化する不可逆操作。以後そのクライアントのトークンは認可エラーになる |
| Actor | 操作主体 | 「誰が」操作したか。人間ユーザー本人、またはユーザーの代理として動く AI クライアントのいずれか。全ドメインのリビジョン記録に使う |
| Token Scope | トークンスコープ | 操作主体に与えられる権限の範囲。human スコープと ai スコープは非対称（ai にはハードデリート・ゴミ箱・履歴の権限が存在しない） |
| Trash Retention Days | ゴミ箱保持日数 | ソフトデリート項目がハードデリートされるまでの日数。ユーザー設定。既定30日 |
| Password Reset | パスワードリセット | メール経由のトークンで本人確認し、新しいパスワードを設定する手続き |

## エンティティ

### User

fog のアカウント。認証方式（パスワード / SSO）を判別可能ユニオンで表現し、「SSOユーザーがパスワードハッシュを持つ」「パスワードユーザーがプロバイダIDを持つ」といったあり得ない状態を型で排除する。

#### フィールド

共通部（`UserBase`）:

| 名前 | 型 | 制約 |
|---|---|---|
| id | `UserId` | required |
| email | `Email` | required。全ユーザー間で一意（一意性の検証はユースケース＋リポジトリで行う） |
| trashRetentionDays | `TrashRetentionDays` | required。既定 `TrashRetentionDays.default()`（30日） |
| version | `number` | required。OCC 用。生成時 0 |
| createdAt | `Date` | required |
| updatedAt | `Date` | required |

判別可能ユニオン:

```ts
export type PasswordUser = UserBase &
  Readonly<{
    authMethod: "password";
    passwordHash: PasswordHash;
  }>;

export type SsoUser = UserBase &
  Readonly<{
    authMethod: "sso";
    provider: SsoProvider;        // "google" | "apple"
    providerSubject: string;      // IdP 内の主体ID（sub）。空文字不可
  }>;

export type User = PasswordUser | SsoUser;
```

#### 振る舞い

```ts
export const User = {
  /** パスワード登録。ハッシュ化はユースケースが PasswordHasher ポートで済ませてから渡す */
  registerWithPassword: (
    params: { id: string; email: string; passwordHash: PasswordHash },
    now: Date,
  ): WithEventDrafts<PasswordUser, IdentityEvent>;

  /** SSO 初回ログインでの自動作成 */
  registerWithSso: (
    params: { id: string; email: string; provider: SsoProvider; providerSubject: string },
    now: Date,
  ): WithEventDrafts<SsoUser, IdentityEvent>;

  /**
   * パスワード変更。PasswordUser のみ受け付ける（SSOユーザーの変更は型エラー）。
   * 現在パスワードの照合はユースケースが PasswordHasher.verify で行う。
   */
  changePassword: (
    user: PasswordUser,
    newPasswordHash: PasswordHash,
    now: Date,
  ): WithEventDrafts<PasswordUser, IdentityEvent>;

  /** ゴミ箱保持日数の変更。両認証方式で可能なため User を受ける */
  changeTrashRetentionDays: (
    user: User,
    retentionDays: TrashRetentionDays,
    now: Date,
  ): WithEventDrafts<User, IdentityEvent>;
};
```

- 各ファクトリの処理内容: `params` の生文字列から値オブジェクト（`UserId.create`、`Email.create` 等）を構築し、`version: 0`（変更系は `version + 1`）、`createdAt` / `updatedAt` を設定して、対応するイベントドラフトと共に返す。`now` と `id` は引数で受け、ドメイン内で `new Date()` / ID生成は行わない
- パスワードリセット実行（`resetPassword`）は `changePassword` と同じ遷移（新しい `passwordHash` への置換）であり、エンティティ上は `changePassword` を共用する。現在パスワード照合の代わりにリセットトークン検証を行う点だけがユースケースの差分

#### 不変条件

- `email` は全ユーザー間で一意（S-AC-01 異常系）。エンティティ単体では検証できないため、登録ユースケースが `UserRepository.findByEmail` で事前検証する
- メール一意性は**認証方式をまたいで**適用する。SSO 初回サインイン時に IdP から得たメールが既存のパスワードユーザーと一致する場合、既存アカウントへの自動リンクは行わず `ConflictError("EMAIL_ALREADY_REGISTERED")` の明示エラーとする（UI はパスワードログインへの導線を示す）。逆に、パスワード登録時に同一メールの SSO ユーザーが既に存在する場合も同様に `EMAIL_ALREADY_REGISTERED` とする。アカウントリンク（既存アカウントへの認証方式の追加・統合）は現段階のスコープ外
- `authMethod: "password"` のとき `passwordHash` を必ず持ち、`provider` / `providerSubject` を持たない（型で保証）
- `authMethod: "sso"` のとき `(provider, providerSubject)` の組は全ユーザー間で一意。email と同様に事前チェック + DB 制約の二重防御とする: ユースケースが `UserRepository.findBySsoIdentity` で事前検証し、同時初回 SSO サインインのレースは `insert` 時の DB 一意制約で捕捉する（アダプターが制約違反を `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` にマッピングする）
- パスワード変更・リセットは `PasswordUser` に対してのみ可能（S-AC-07 エッジケース。型で保証）
- `trashRetentionDays` は常に有効値（1以上の整数）。`TrashRetentionDays` の生成時バリデーションで保証

#### ライフサイクル

- 生成: パスワード登録（S-AC-01）または SSO 初回ログイン（S-AC-02）で生成される
- 状態遷移: `authMethod` はアカウントの生成時に決まり、以後変わらない（認証方式の追加・切替は現段階のスコープ外）
- 削除: アカウント削除は現段階のスコープ外（要件・シナリオに存在しない）

### AiClientConnection

OAuth 2.1 の認可フローでユーザーが AI クライアントに許可を与えた「認可の事実」。失効状態を直和型で表現する。

#### フィールド

共通部（`AiClientConnectionBase`）:

| 名前 | 型 | 制約 |
|---|---|---|
| id | `AiClientConnectionId` | required |
| userId | `UserId` | required。許可を与えたユーザー（ID参照） |
| clientName | `ClientName` | required。認可リクエストが名乗るクライアント表示名 |
| connectedAt | `Date` | required。許可した日時 |
| lastUsedAt | `Date \| null` | optional。この接続のトークンで最後に API が呼ばれた日時。未使用なら null |
| version | `number` | required。OCC 用。生成時 0 |
| createdAt | `Date` | required |
| updatedAt | `Date` | required |

判別可能ユニオン:

```ts
export type ActiveAiClientConnection = AiClientConnectionBase &
  Readonly<{ status: "active" }>;

export type RevokedAiClientConnection = AiClientConnectionBase &
  Readonly<{ status: "revoked"; revokedAt: Date }>;

export type AiClientConnection =
  | ActiveAiClientConnection
  | RevokedAiClientConnection;
```

`revokedAt` は `revoked` 状態にのみ存在する（「active なのに revokedAt を持つ」状態を型で排除）。

#### 振る舞い

```ts
export const AiClientConnection = {
  /** 認可画面で「許可する」が押されたときに生成（S-AC-05） */
  create: (
    params: { id: string; userId: UserId; clientName: string },
    now: Date,
  ): WithEventDrafts<ActiveAiClientConnection, IdentityEvent>;

  /**
   * 接続の失効（S-AC-06）。active のみ受け付ける（失効済みの再失効は型エラー）。
   * revoked への遷移は不可逆。
   */
  revoke: (
    connection: ActiveAiClientConnection,
    now: Date,
  ): WithEventDrafts<RevokedAiClientConnection, IdentityEvent>;

  /**
   * 最終利用日時の更新。AI からの API 呼び出しの認可検証時にアダプター経由で呼ばれる。
   * active のみ（失効済み接続で API は呼べないため）。イベントは発行しない。
   */
  recordUsage: (
    connection: ActiveAiClientConnection,
    now: Date,
  ): ActiveAiClientConnection;
};
```

- `recordUsage` の永続化は `TransactionalRepository.save`（OCC）には乗せない。並行する AI API 呼び出し同士で `lastUsedAt` 更新が `OPTIMISTIC_LOCK_FAILURE` を起こし得るためで、専用リポジトリメソッド `AiClientConnectionRepository.recordUsage`（後述）による**ベストエフォートの単独更新**とする。更新に失敗しても本処理（API 呼び出し自体）は継続し、並行呼び出し間は後勝ちでよい

#### 不変条件

- `status: "revoked"` は終端状態。失効した接続を再有効化することはできない。再利用したい場合は新しい認可フローで新しい接続を作る（S-AC-06 エッジケース。`revoke` が `ActiveAiClientConnection` しか受けないことで型保証）
- `lastUsedAt` は `connectedAt` 以降の日時（`recordUsage` が単調に進める）
- 失効済み接続に紐づくトークンでの API 呼び出しは認可エラーになる。この判定はアダプター（認可ミドルウェア）が `AiClientConnectionRepository.findActiveById` の結果に基づいて行う

#### ライフサイクル

```
（認可フローで「許可する」）─→ active ─ revoke ─→ revoked（終端）
```

- 生成: OAuth 認可画面での許可（S-AC-05）。「拒否する」の場合は接続エンティティを一切作らない（拒否の事実はドメインに残さず、アダプターがプロトコル上の拒否応答を返すのみ）
- 失効しても行は残す（設定画面の一覧に「解除済み」を出すかは UI の判断だが、監査可能性のため事実は保持する）

## 値オブジェクト

すべて `unique symbol` によるブランド型＋`create` ファクトリで実装し、不正値は `BusinessRuleError<IdentityErrorCode>` を throw する。等価性は特記なき限り値の完全一致。

### UserId

- フィールド: `string`（ブランド型）
- バリデーション: trim 後に空文字でないこと。ID形式（UUIDv7等）の検証は `IdGenerator` ポートの実装責務
- 等価性: 文字列一致

### AiClientConnectionId

- フィールド: `string`（ブランド型）
- バリデーション: UserId と同様（不透明な非空文字列）
- 等価性: 文字列一致

### Email

- フィールド: `string`（ブランド型）
- バリデーション: trim・小文字化の正規化後、メールアドレス形式（`local@domain` 構造、最大320文字）であること。違反は `IdentityErrorCode.InvalidEmail`
- 等価性: 正規化後の文字列一致

### PlainPassword

ユーザーが入力した生パスワード。ハッシュ化前のパスワード要件（S-AC-01 異常系「最低長等」）をドメインの規則としてここで検証する。

- フィールド: `string`（ブランド型）
- バリデーション: 8文字以上128文字以下。違反は `IdentityErrorCode.PasswordTooWeak`
- 等価性: 文字列一致（ただしログ・イベント・永続化には決して含めない。`toString` を無効化するなど漏出防止を実装で担保する）

### PasswordHash

ハッシュ化済みパスワード。**ハッシュ化アルゴリズム（Argon2id 等）はドメイン外の関心事**であり、生成は必ず `PasswordHasher` ポート経由で行う。ドメインは不透明な文字列として保持するだけ。

- フィールド: `string`（ブランド型）
- バリデーション: 非空であること（ハッシュ形式の検証はアダプターの責務）
- 等価性: 照合は文字列比較では行わず、必ず `PasswordHasher.verify` を使う

### SsoProvider

- フィールド: `"google" | "apple"`（文字列リテラルユニオン）
- バリデーション: 上記いずれかであること。違反は `IdentityErrorCode.UnsupportedSsoProvider`
- 等価性: リテラル一致
- プロバイダ追加時はこのユニオンに追記する

### ClientName

- フィールド: `string`（ブランド型）
- バリデーション: trim 後に非空、100文字以下。認可リクエスト由来の外部入力なので長さを制限する
- 等価性: 文字列一致

### TrashRetentionDays

- フィールド: `number`（ブランド型）
- バリデーション: 1以上の整数であること（S-ST-01 異常系「0以下等は保存できない」）。違反は `IdentityErrorCode.InvalidTrashRetentionDays`
- 既定値: `TrashRetentionDays.default()` が 30 を返す
- 等価性: 数値一致
- trash ドメインが保持期限の計算（`softDeletedAt + retentionDays` 経過でハードデリート対象）に利用する。**定義は identity のこの VO の一箇所のみ**であり、trash 側に同概念の VO（旧 `RetentionDays`）やエラーコードを重複定義しない（依存方向は trash → identity で循環しない）

### Actor

操作主体。**全ドメインがリビジョンの「誰が」に使う横断的な値オブジェクト**であり、identity が定義して memo / knowledge へ提供する（→ domains/index.md 横断事項）。

```ts
export type UserActor = Readonly<{
  kind: "user";
  userId: UserId;
}>;

export type AiClientActor = Readonly<{
  kind: "aiClient";
  userId: UserId;                        // 代理される人間ユーザー
  connectionId: AiClientConnectionId;    // どの接続（トークン識別）か
  clientName: ClientName;               // リビジョン表示用のスナップショット
}>;

export type Actor = UserActor | AiClientActor;
```

- バリデーション: 構成する各値オブジェクトの生成時バリデーションに委ねる。`Actor.user(userId)` / `Actor.aiClient(userId, connectionId, clientName)` のファクトリを提供する
- 等価性: `kind` と全フィールドの一致
- `clientName` をスナップショットとして持つのは、リビジョン履歴の「どのAIが」表示（S-AI-04）を接続エンティティへの再問い合わせなしに成立させるため。接続が失効・改名されても当時の名前で記録が残る

### TokenScope

権限の非対称性を型で表現する。**ai スコープにはハードデリート・ゴミ箱操作・履歴閲覧の権限が存在しない**（要件 4.5 / 5.2）。「AI に権限フラグを false で持たせる」のではなく、権限の型自体を分けることで、AI トークンにこれらの権限を与えるコードを書けなくする。

```ts
/** ai スコープに許される操作 */
export type AiPermission = "read" | "write";

/** human スコープに許される操作。AiPermission の上位集合 */
export type HumanPermission =
  | AiPermission
  | "hardDelete"   // ハードデリート・ゴミ箱を空にする
  | "trash"        // ゴミ箱の閲覧・復元
  | "history";     // 履歴の閲覧・ロールバック

export type HumanScope = Readonly<{ type: "human" }>; // HumanPermission すべてを持つ
export type AiScope = Readonly<{ type: "ai" }>;       // AiPermission のみを持つ

export type TokenScope = HumanScope | AiScope;

export const TokenScope = {
  human: (): HumanScope;
  ai: (): AiScope;
  /** scope が permission を許すか。human は全許可、ai は AiPermission のみ */
  allows: (scope: TokenScope, permission: HumanPermission): boolean;
};
```

- ハードデリート・ゴミ箱・履歴系のユースケース（trash / memo / knowledge の ★ ユースケース）の排除は二層で保証する。方針は「型で守れるところは型で守り、残りは配線分離」:
  - **型による強制（`actor` を入力に持つ ★ ユースケース）**: editMemo / rollbackMemo / editDocument / rollbackDocument 等、人間 UI 専用で `actor` を入力に持つユースケースは、入力 DTO の `actor` の型を `Actor` ではなく `UserActor`（`{ kind: "user" }` バリアント）に限定して定義する。`AiClientActor`（AiScope 由来の主体）を渡すことは型エラーであり、実行時チェックに依存しない
  - **配線分離 + 認可の許可リスト（`actor` を入力に持たない ★ ユースケース）**: listTrash / restore 系 / hardDeleteTrashItem / emptyTrash / listMemoRevisions / diff 系 / getTopic 等の読み取り・削除系は、AI 側 presentation（MCP / REST）に配線しないことで構造的に排除する。加えて AI トークンの認可ミドルウェアは、AiScope の許可ユースケース列挙（許可リスト方式）にこれらを含めない
- `Actor` との対応は固定: `UserActor` ⇔ `HumanScope`、`AiClientActor` ⇔ `AiScope`。この導出はアダプター（認証・認可ミドルウェア）が行う
- MCP / REST API の presentation 層には ai スコープのユースケースしか配線しない（application 層のユースケース公開範囲による構造的表現。→ domains/index.md 横断事項）。上記の二層で「AI が何をしてもハードデリート・ゴミ箱・履歴に到達できない」を保証する

## ドメインイベント

| イベント | ペイロード | 発生契機 |
|---|---|---|
| `identity.userRegistered` | `{ userId, authMethod }` | User.registerWithPassword / registerWithSso |
| `identity.passwordChanged` | `{ userId }` | User.changePassword（リセット実行含む） |
| `identity.trashRetentionChanged` | `{ userId, retentionDays }` | User.changeTrashRetentionDays |
| `identity.aiClientConnected` | `{ connectionId, userId }` | AiClientConnection.create |
| `identity.aiClientRevoked` | `{ connectionId, userId }` | AiClientConnection.revoke |

いずれも識別子なしドラフトとしてファクトリから返し、EventId の採番は application 層（UoW の `collectEvents`）が行う。`identity.aiClientRevoked` はアダプター側のトークン失効処理（トークンストアからの削除等）のトリガーとして consumer が購読できる。

## ドメインサービス

なし。

- パスワードの照合・ハッシュ化は暗号計算であり `PasswordHasher` ポートに置く
- メール一意性・SSO主体一意性の検証はリポジトリへの問い合わせを伴うため、登録ユースケースが行う
- 複数エンティティにまたがるビジネスロジックは現状存在しない

## ポート

すべてドメイン型を受け渡す。外部データのデコード（検証・変換）はアダプター境界の責務。リポジトリはテンプレートの `TransactionalRepository<TEntity, TId>` と同じ OCC 規約（insert / save + `ExpectedVersion` トークン、0 行更新 → Conflict）に従うが、**extends はしない**: テンプレートの `TransactionalRepository` は userId スコープなしの契約のため、`(userId, id)` シグネチャのメソッド（`AiClientConnectionRepository.findById` 等）とは両立しない。memo / knowledge の各リポジトリと同方式で、独立したインターフェースとして必要なメソッドのみ自前宣言する（契約の互換部分は同じ規約に従う）。

### UserRepository

- 目的: User 集約の永続化と検索

```ts
export interface UserRepository {
  // --- 書き込み（TransactionalRepository と同じ OCC 規約。extends はしない） ---
  insert(user: User): Promise<void>;
  save(user: User, expectedVersion: ExpectedVersion<User>): Promise<void>;

  /** ID で取得。セッション / 認可済みトークン由来の信頼済み ID を扱う。該当なしは null */
  findById(id: UserId): Promise<Versioned<User> | null>;

  /** メールアドレスで検索。登録時の一意性検証・パスワードログイン・リセット依頼に使う */
  findByEmail(email: Email): Promise<Versioned<User> | null>;

  /** SSO 主体で検索。SSO ログイン時の既存アカウント判定に使う */
  findBySsoIdentity(
    provider: SsoProvider,
    providerSubject: string,
  ): Promise<Versioned<SsoUser> | null>;
}
```

- エラーケース:
  - `save` の OCC 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
  - `insert` の email 一意制約違反 → `ConflictError("EMAIL_ALREADY_REGISTERED")`（事前チェックと DB 制約の二重防御。競合登録のレースはこちらで捕捉する）
  - `insert` の (provider, providerSubject) 一意制約違反 → `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`（email と同様、事前チェック（`findBySsoIdentity`）と DB 制約の二重防御。同時初回 SSO サインインのレースはこちらで捕捉し、アダプターが制約違反を `ConflictError` にマッピングする）
  - DB 例外 → `SystemError(DatabaseError)`
  - `findByEmail` / `findBySsoIdentity` の該当なしはエラーではなく `null`

### AiClientConnectionRepository

- 目的: AiClientConnection 集約の永続化と検索

```ts
export interface AiClientConnectionRepository {
  // --- 書き込み（TransactionalRepository と同じ OCC 規約。extends はしない） ---
  insert(connection: ActiveAiClientConnection): Promise<void>;
  save(connection: AiClientConnection, expectedVersion: ExpectedVersion<AiClientConnection>): Promise<void>;

  /**
   * 外部入力の ID を受ける単体取得（設定画面からの失効操作 S-AC-06 等）。
   * userId を第一引数に取り、アダプターは常に userId でスコープしたクエリを発行する。
   * 他ユーザー所有・不在は null（テナント分離。他ユーザーの接続 ID を渡しても「存在しない」となり、
   * ユースケース層の connection.userId 照合に依存しない構造的保証とする）
   */
  findById(
    userId: UserId,
    id: AiClientConnectionId,
  ): Promise<Versioned<AiClientConnection> | null>;

  /** ユーザーの接続一覧（S-AC-06）。connectedAt 降順 */
  listByUserId(userId: UserId): Promise<readonly AiClientConnection[]>;

  /**
   * active な接続のみ取得。API 呼び出しの認可検証（認可ミドルウェア）専用:
   * 引数の ID はトークン由来の信頼済み ID であり、外部入力経路（revoke 等）では使わない。
   * 外部入力の ID は userId スコープ付きの findById で引くこと。
   * 失効済み・存在しない場合は null（呼び出し側で認可エラーに変換する）
   */
  findActiveById(
    id: AiClientConnectionId,
  ): Promise<Versioned<ActiveAiClientConnection> | null>;

  /**
   * 最終利用日時のベストエフォート更新（AiClientConnection.recordUsage の永続化用）。
   * OCC を伴わない単独 UPDATE（version は進めない）。並行呼び出しは後勝ち。
   * 対象不在・失敗時も throw せず、呼び出し元の本処理（API 呼び出し）を失敗させない（ログのみ）
   */
  recordUsage(id: AiClientConnectionId, lastUsedAt: Date): Promise<void>;
}
```

- エラーケース:
  - `save` の OCC 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`（例: 一覧画面の二重解除操作）
  - DB 例外 → `SystemError(DatabaseError)`
  - `findActiveById` は失効済みを `null` として返す。「失効済み」と「存在しない」を区別しない（外部に接続の存在有無を漏らさない）
  - `findById` は他ユーザー所有・不在を `null` として返す（区別しない。存在の有無も漏らさない）

### PasswordHasher

- 目的: パスワードのハッシュ化と照合。アルゴリズム（Argon2id 等）とパラメータはアダプター実装の責務

```ts
export interface PasswordHasher {
  hash(plain: PlainPassword): Promise<PasswordHash>;
  /** タイミングセーフに照合する */
  verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean>;
}
```

- エラーケース:
  - ハッシュ計算の失敗（リソース不足等）→ `SystemError`
  - `verify` の不一致はエラーではなく `false`（「どちらが誤りか明かさない」メッセージへの変換はユースケース以降の責務）

### PasswordResetTokenPort

- 目的: パスワードリセットトークンの発行・検証・消費（S-AC-07）。トークンの形式・署名・保存方式はアダプターの責務。ドメイン/アプリケーションは不透明文字列として扱う

```ts
export interface PasswordResetTokenPort {
  /** リセットトークンを発行する。有効期限の起点として now を受ける */
  issue(userId: UserId, now: Date): Promise<string>;

  /**
   * トークンを検証し、有効なら消費（使い捨て）して対象ユーザーを返す。
   * 無効・期限切れ・使用済みは null
   */
  verifyAndConsume(token: string, now: Date): Promise<UserId | null>;
}
```

- エラーケース:
  - 無効・期限切れ・使用済みトークンはエラーではなく `null`（ユースケースが `ValidationError("RESET_TOKEN_INVALID")` 等に変換し、S-AC-07 の「期限切れの場合は再送をやり直せる」表示につなげる）
  - ストア障害 → `SystemError`

### MailSender

- 目的: ユーザーへのメール送信。現状はパスワードリセットメールのみ

```ts
export interface MailSender {
  /** リセットリンク（トークン込みURL）を届ける。URL の組み立てはアダプターの責務 */
  sendPasswordResetMail(to: Email, resetToken: string): Promise<void>;
}
```

- エラーケース:
  - 送信基盤の失敗 → `SystemError`。ただしリセット依頼ユースケースは「登録されていれば送信された」旨のみ返すため（S-AC-07 異常系）、宛先実在性に起因する失敗をユーザー応答に反映してはならない

## ユースケース（概要）

詳細はユースケース設計フェーズで定義する。★ は Web UI 専用（human スコープのみに配線し、AI 側の presentation には存在させない）。identity のユースケースはすべて ★ である（AI クライアントが自分の認可を操作することはない）。

- ★ registerWithPassword — パスワードでアカウント登録（S-AC-01）。メール重複・パスワード要件・メール形式のエラーを含む。同一メールの SSO ユーザーが既に存在する場合も `EMAIL_ALREADY_REGISTERED`（自動リンクしない）
- ★ registerOrLoginWithSso — SSO でのログイン。初回は自動でアカウント作成（S-AC-02）。ただし IdP から得たメールが既存のパスワードユーザーと一致する場合は自動リンクせず `EMAIL_ALREADY_REGISTERED` の明示エラーとし、UI はパスワードログインへの導線を示す（アカウントリンクは現段階のスコープ外）
- ★ loginWithPassword — メールアドレスとパスワードでログイン（S-AC-03）。失敗理由は特定しない
- ★ logout — セッションの破棄（S-AC-04。セッション自体はアダプター管理）
- ★ requestPasswordReset — リセット依頼。トークン発行とメール送信。登録有無を明かさない（S-AC-07）。`UserRepository.findByEmail` の結果が `SsoUser` の場合はトークンを発行せずメールも送らない（未登録メールと同じ扱い）。レスポンスはいずれの場合も「登録されていれば送信された」旨のみとし、登録有無・認証方式を明かさない（S-AC-07 の情報漏えい防止と同じ扱い）
- ★ executePasswordReset — リセット実行。トークン検証・消費と新パスワード設定（S-AC-07）。トークン検証後に取得したユーザーが万一 `SsoUser` の場合は、防衛的に `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` とする（requestPasswordReset が SSO ユーザーにトークンを発行しないため、正常運用ではこの分岐に到達しない）
- ★ changePassword — ログイン中のパスワード変更。現在パスワードの照合を伴う。PasswordUser のみ（S-AC-07）
- ★ approveAiClientAuthorization — OAuth 認可の許可。AiClientConnection を作成する（S-AC-05）
- ★ denyAiClientAuthorization — OAuth 認可の拒否。接続は作らず、拒否をアダプターへ伝える（S-AC-05 異常系）
- ★ listAiClientConnections — 接続済み AI クライアントの一覧（S-AC-06）
- ★ revokeAiClientConnection — 接続の失効（S-AC-06）。対象 `connectionId` は設定画面からの外部入力のため、`AiClientConnectionRepository.findById(userId, connectionId)`（操作主体の userId でスコープ）で取得する。他ユーザー所有・不在は NotFound（テナント分離の構造的保証。ユースケース側の `connection.userId` 照合は不要）。取得結果が active なら `AiClientConnection.revoke` → `save`
- ★ changeTrashRetentionDays — ゴミ箱保持期限の変更（S-ST-01）
- ★ getCurrentUser — 現在のユーザー情報の読み取り（設定画面 P-13 の表示用）。email・認証方式（authMethod。パスワード変更 UI の表示判定用: SSO のみのユーザーには非表示 S-AC-07）・trashRetentionDays を返す。人間 UI 専用の読み取りユースケース

補足: getCurrentUser の戻り値は表示用 DTO（view）であり、`passwordHash` 等の資格情報は含めない。認証方式は User の直和タグ（password / sso）から導出する。
