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
| User | ユーザー | fog のアカウント。ユーザー単位設定の所有者。認証手段は後述のクレデンシャル集合として持つ |
| Credential | クレデンシャル | ログインまたは本人到達に使える認証手段の1件。メール（パスワード検証材料を伴う）または SSO 主体。1ユーザーが複数持てる |
| CredentialId | クレデンシャルID | クレデンシャルの同一性を表す不透明な識別子。解除・照合はこの ID をキーにする |
| SSO | SSO | Google / Apple 等の外部 IdP による認証。プロバイダ種別とプロバイダ内主体IDの組で識別する |
| AI Client Connection | AIクライアント接続 | ユーザーが OAuth 2.1 の認可フローで自分の AI クライアントに許可を与えた「認可の事実」。1回の許可＝1接続 |
| Revoke | 失効（接続解除） | AIクライアント接続を無効化する不可逆操作。以後そのクライアントのトークンは認可エラーになる |
| Actor | 操作主体 | 「誰が」操作したか。人間ユーザー本人、またはユーザーの代理として動く AI クライアントのいずれか。全ドメインのリビジョン記録に使う |
| Token Scope | トークンスコープ | 操作主体に与えられる権限の範囲。human スコープと ai スコープは非対称（ai にはハードデリート・ゴミ箱・履歴の権限が存在しない） |
| Trash Retention Days | ゴミ箱保持日数 | ソフトデリート項目がハードデリートされるまでの日数。ユーザー設定。既定30日 |
| Password Reset | パスワードリセット | メール経由のトークンで本人確認し、新しいパスワードを設定する手続き |

## エンティティ

### User

fog のアカウント。**認証方式の判別可能ユニオンは持たない。** 1ユーザーが複数のクレデンシャル（メール / SSO）を同時に持てるので、認証手段は集合として表現する。

**原本と検証材料は本エンティティに載らない。** メールアドレスの原本もパスワードの検証材料も認証情報側（Identity Directory）が持ち、ユーザー単位設定側が持つのは**非 PII の要約**だけである。

#### フィールド

| 名前 | 型 | 制約 |
|---|---|---|
| id | `UserId` | required |
| credentials | `readonly CredentialRef[]` | required。保有クレデンシャルの要約（下記）。1件以上 |
| trashRetentionDays | `TrashRetentionDays` | required。既定 `TrashRetentionDays.default()`（30日） |
| version | `number` | required。OCC 用。生成時 0 |
| createdAt | `Date` | required |
| updatedAt | `Date` | required |

```ts
/** 保有クレデンシャルの非 PII 要約。設定画面の一覧に出せるのはこの3つだけ */
export type CredentialRef = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** kind: "sso" なら provider 名（"google" / "apple"）、kind: "email" なら空文字 */
  label: string;
}>;

export type User = Readonly<{
  id: UserId;
  credentials: readonly CredentialRef[];
  trashRetentionDays: TrashRetentionDays;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}>;
```

- **`email` はフィールドに持たない。** 原本は認証情報側に暗号化して保持され、本人が自分のアドレスを見る経路（設定画面）でだけ1件ずつ復号される
- **`passwordHash` / `provider` / `providerSubject` もフィールドに持たない。** パスワードの検証材料と SSO 主体は認証情報側の関心事である
- `credentials` は表示と解除操作の材料である。**解除操作を出してよいのは `kind: "sso"` の要素だけ**で、`kind: "email"` の解除経路は本設計に存在しない（後述の不変条件）

#### 振る舞い

```ts
export const User = {
  /** パスワード登録での初期化。最初のクレデンシャルは kind: "email" の1件 */
  registerWithPassword: (
    params: { id: string; credential: CredentialRef },
    now: Date,
  ): User;

  /** SSO 初回ログインでの自動作成。最初のクレデンシャルは kind: "sso" と kind: "email" の2件 */
  registerWithSso: (
    params: { id: string; credentials: readonly CredentialRef[] },
    now: Date,
  ): User;

  /** クレデンシャルの追加（SSO 連携）。同じ credentialId の要素があれば置き換える */
  addCredential: (user: User, credential: CredentialRef, now: Date): User;

  /**
   * クレデンシャルの解除。kind: "sso" のみ受け付ける。
   * 解除後に1件も残らない場合は BusinessRuleError(LastCredentialRemoval)。
   */
  removeCredential: (user: User, credentialId: CredentialId, now: Date): User;

  /** ゴミ箱保持日数の変更 */
  changeTrashRetentionDays: (
    user: User,
    retentionDays: TrashRetentionDays,
    now: Date,
  ): User;
};
```

- 各ファクトリの処理内容: `params` の生文字列から値オブジェクト（`UserId.create` 等）を構築し、`version: 0`（変更系は `version + 1`）、`createdAt` / `updatedAt` を設定して次状態を返す。`now` と `id` は引数で受け、ドメイン内で `new Date()` / ID生成は行わない
- **パスワードの変更・リセットは本エンティティの遷移ではない。** 検証材料を持つのは認証情報側なので、変更はそちらを書き換える手続き（usecases/identity.md）として表現される。ユーザー単位設定側の `User` は変わらない
- **SSO 初回登録でもメールのクレデンシャルが1件置かれる。** メールアドレスの一意性を認証方式をまたいで効かせるためであり、この要素は**ログイン手段ではない**（パスワードの検証材料を持たないため）

#### 不変条件

- メールアドレスは全ユーザー間で一意（S-AC-01 異常系）。一意性の権威は認証情報側の credential 行であり、登録は予約を取ってから進む。重複は `ConflictError("EMAIL_ALREADY_REGISTERED")`
- メール一意性は**認証方式をまたいで**適用する。SSO 初回サインイン時に IdP から得たメールが既存アカウントのものと一致する場合、既存アカウントへの自動リンクは行わず `EMAIL_ALREADY_REGISTERED` とする（UI はパスワードログインへの導線を示す）。逆も同様である
- `(provider, providerSubject)` の組も全ユーザー間で一意。重複は `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`
- **`credentials` は常に1件以上で、そのうち少なくとも1件はログイン手段である。** 最後のログイン手段を解除する操作は `BusinessRuleError` で拒否する。数えるのは要素数ではなく**ログイン手段になり得るクレデンシャルの `credentialId` の異なり数**である（同じクレデンシャルが移行中に複数の表現を持ちうるため、要素数で数えるとログイン手段が0のアカウントを作れてしまう）
- **`kind: "email"` の解除経路は存在しない**（`removeCredential` が `kind: "sso"` のみを受ける）。メールクレデンシャルを失うとアドレス表示・パスワードリセット・パスワード変更のすべてが成立しなくなり、追加し直す経路も無いため
- **SSO 専用アカウントにパスワードを設定する経路は無い。** メールの要素は一意性の予約としてのみ置かれており、ログイン手段へ昇格する遷移を本設計は持たない
- `trashRetentionDays` は常に有効値（1以上の整数）。`TrashRetentionDays` の生成時バリデーションで保証

#### ライフサイクル

- 生成: パスワード登録（S-AC-01）または SSO 初回ログイン（S-AC-02）で生成される
- 状態遷移: クレデンシャル集合は SSO 連携の追加・解除で増減する。パスワードの有無は集合の内容で決まり、アカウントの型を分けない
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
  ): ActiveAiClientConnection;

  /**
   * 接続の失効（S-AC-06）。active のみ受け付ける（失効済みの再失効は型エラー）。
   * revoked への遷移は不可逆。
   */
  revoke: (
    connection: ActiveAiClientConnection,
    now: Date,
  ): RevokedAiClientConnection;

  /**
   * 最終利用日時の更新。AI からの API 呼び出しの認可検証時にアダプター経由で呼ばれる。
   * active のみ（失効済み接続で API は呼べないため）。
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

### CredentialId

クレデンシャルの同一性。**認証情報の保管方式や鍵の世代が変わっても値が変わらない**ことが本 VO の目的である。

- フィールド: `string`（ブランド型）
- バリデーション: UserId と同様（不透明な非空文字列）。値は `IdGenerator` が採番し、メールアドレスからも鍵からも導出しない
- 等価性: 文字列一致
- 用途: 保有クレデンシャルの照合・解除対象の指定・リセットトークンの対象指定。**設定画面へ出してよい非 PII の値である**

### Email

- フィールド: `string`（ブランド型）
- バリデーション: 次の順序で行う。違反は `IdentityErrorCode.InvalidEmail`
  1. `trim()`
  2. **構造チェック**（`@` を含むこと、local 部・domain 部がいずれも空でないこと）を正規化より**前**に置く。「最後の `@` で分割」が `@` の存在を前提にするため
  3. 最後の `@` で local 部と domain 部に分割する
  4. **local 部に非 ASCII（`U+0080` 以上）を含む入力は拒否する。** SMTPUTF8 には対応しない。local 部はオクテット単位で不透明であり、正規化すると利用者が打鍵した実アドレスが復元不能になるため
  5. **local 部は lowercase 化するが、NFKC は掛けない。** 全角英数・合字を畳むと配送先が別のメールボックスへ変わりうる。lowercase 化だけを残すのは、区別する設計のほうが「同じアドレスで重複アカウントができる」というより頻度の高い害を生むという受容判断である
  6. **domain 部は NFKC 正規化して lowercase 化し、非 ASCII を含む場合は punycode（IDNA、ASCII 形式）へ変換する**
  7. `local + "@" + domain` に再結合する
  8. **長さ上限 320（RFC 5321 のパス長）を正規化の前後で2回見る。** punycode 変換は文字列を伸ばしうるので、超過は変換後の値で判定して拒否する
- 等価性: 正規化後の文字列一致
- **本 VO が canonical 化の唯一の出所である。** 認証情報側の一意性判定も本人到達の判定も、ここで得た値だけを入力にする

### PlainPassword

ユーザーが入力した生パスワード。ハッシュ化前のパスワード要件（S-AC-01 異常系「最低長等」）をドメインの規則としてここで検証する。

- フィールド: `string`（ブランド型）
- バリデーション: 8文字以上128文字以下。違反は `IdentityErrorCode.PasswordTooWeak`
- 等価性: 文字列一致（ただしログ・永続化には決して含めない。`toString` を無効化するなど漏出防止を実装で担保する）

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

## ドメインサービス

なし。

- パスワードの照合・ハッシュ化は暗号計算であり `PasswordHasher` ポートに置く
- メール一意性・SSO主体一意性の検証はリポジトリへの問い合わせを伴うため、登録ユースケースが行う
- 複数エンティティにまたがるビジネスロジックは現状存在しない

## ポート

すべてドメイン型を受け渡す。外部データのデコード（検証・変換）はアダプター境界の責務。リポジトリはテンプレートの `TransactionalRepository<TEntity, TId>` と同じ OCC 規約（insert / save + `ExpectedVersion` トークン、0 行更新 → Conflict）に従う。**全メソッドは同期契約であり `Promise` を返さない。例外は `PasswordHasher` と `MailSender` の2つだけである**（どちらもトランザクションの外で動く。domains/index.md「ポートの同期契約」）。

**`UserRepository` は2つに割れる。** `User` 集約が「認証情報の所有者」と「ユーザー単位設定の所有者」の2つの関心事を抱えていたためで、物理境界が分かれた以上ポートも分かれる。

| ポート | 置き場 | 持つもの |
|---|---|---|
| `CredentialMappingRepository` | 認証情報側（Identity Directory） | メール・SSO 主体の一意性、パスワードの検証材料、`userId` の解決 |
| `UserSettingsRepository` | ユーザー単位設定側（User Data DO） | `User`（クレデンシャル集合の要約・`trashRetentionDays`・OCC） |

### CredentialMappingRepository

- 目的: クレデンシャルの一意性の権威と、`userId` が未確定の経路からの解決
- 置き場: 認証情報側。**ユーザー単位 Durable Object の外にある唯一のリポジトリである**

```ts
export interface CredentialMappingRepository {
  /** canonical 化済みのメールアドレスから解決する。登録時の一意性検証・パスワードログイン・リセット依頼に使う */
  findByEmail(email: Email): CredentialMapping | null;

  /** SSO 主体で解決する。SSO ログイン時の既存アカウント判定に使う */
  findBySsoIdentity(
    provider: SsoProvider,
    providerSubject: string,
  ): CredentialMapping | null;

  /** credentialId で引く（解除・リセットトークンの対象特定用） */
  findByCredentialId(credentialId: CredentialId): CredentialMapping | null;
}
```

- `CredentialMapping` は `{ credentialId, userId, kind, usableForLogin }` と検証材料からなる。**検証材料の照合そのものはこのポートでは行わない** — 計算は `PasswordHasher` が担い、実行位置はトランザクションの外である
- エラーケース:
  - 一意性違反 → `ConflictError("EMAIL_ALREADY_REGISTERED")` / `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`。**事前チェックではなく予約の獲得で判定する**（同時登録のレースはこちらで捕捉される）
  - DB 例外 → `SystemError(DatabaseError)`
  - 該当なしはエラーではなく `null`
- **登録・変更・解除の手順そのものは単一のメソッドに畳めない。** 認証情報側とユーザー単位設定側の2つを跨ぐため、順序と再開の規則を持つ手続きとして usecases/identity.md に書く

### UserSettingsRepository

- 目的: ユーザー単位設定側の `User` の永続化と読み取り

```ts
export interface UserSettingsRepository {
  // --- 書き込み（TransactionalRepository と同じ OCC 規約） ---
  insert(user: User): void;
  save(user: User, expectedVersion: ExpectedVersion<User>): void;

  /** 自分の Durable Object の User を取得する。初期化前なら null */
  find(): Versioned<User> | null;
}
```

- **`findById(id)` を持たない。** `userId` は Durable Object の選択で消費済みであり、その DO の中には1人分の設定しか存在しないため（domains/index.md「テナント分離」）
- エラーケース:
  - `save` の OCC 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
  - DB 例外 → `SystemError(DatabaseError)`

### AiClientConnectionRepository

- 目的: AiClientConnection 集約の永続化と検索

```ts
export interface AiClientConnectionRepository {
  // --- 書き込み（TransactionalRepository と同じ OCC 規約） ---
  insert(connection: ActiveAiClientConnection): void;
  save(connection: AiClientConnection, expectedVersion: ExpectedVersion<AiClientConnection>): void;

  /** 単体取得（設定画面からの失効操作 S-AC-06 等）。不在は null */
  findById(id: AiClientConnectionId): Versioned<AiClientConnection> | null;

  /** 接続一覧（S-AC-06）。connectedAt 降順 */
  listByUserId(): readonly AiClientConnection[];

  /**
   * active な接続のみ取得。API 呼び出しの認可検証（認可ミドルウェア）専用。
   * 失効済み・存在しない場合は null（呼び出し側で認可エラーに変換する）
   */
  findActiveById(id: AiClientConnectionId): Versioned<ActiveAiClientConnection> | null;

  /**
   * 最終利用日時のベストエフォート更新（AiClientConnection.recordUsage の永続化用）。
   * OCC を伴わない単独 UPDATE（version は進めない）。並行呼び出しは後勝ち。
   * 対象不在・失敗時も throw せず、呼び出し元の本処理（API 呼び出し）を失敗させない（ログのみ）
   */
  recordUsage(id: AiClientConnectionId, lastUsedAt: Date): void;
}
```

- **`findActiveById` は `userId` を取らない。** AI クライアントトークンは `userId` を自己完結で運ぶので、対象の Durable Object は呼び出し前に確定している。かつてこのメソッドが全ユーザー横断の PK 素引きだったのは、トークンから `userId` を引けなかったためである
- **失効の権威は本リポジトリが読む `status` である。** 失効を別ストアへ伝播させる経路は存在せず、次のリクエストのガードが直接読む
- エラーケース:
  - `save` の OCC 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`（例: 一覧画面の二重解除操作）
  - DB 例外 → `SystemError(DatabaseError)`
  - `findActiveById` は失効済みを `null` として返す。「失効済み」と「存在しない」を区別しない（外部に接続の存在有無を漏らさない）
  - `findById` は不在を `null` として返す（存在の有無も漏らさない）

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
- **置き場は認証情報側（Identity Directory）である。** `issue` も `verifyAndConsume` も、トークン行が認証情報側にあることから行き先が決まる。**`issue` が `userId` を引数に取ることは置き場の根拠にならない** — トークンから対象を引ける形にしておかないと、リセットリンクを踏んだ未認証リクエストが誰のものか決められないからである

```ts
export interface PasswordResetTokenPort {
  /** リセットトークンを発行する。有効期限の起点として now を受ける */
  issue(credentialId: CredentialId, now: Date): string;

  /**
   * トークンを検証し、有効なら消費（使い捨て）して対象ユーザーを返す。
   * 無効・期限切れ・使用済みは null
   */
  verifyAndConsume(token: string, now: Date): UserId | null;
}
```

- **発行は対象クレデンシャル単位である。** 同じクレデンシャルに新しいトークンを発行すると、そのクレデンシャル宛の未使用トークンはすべて置き換わる（古いリンクは以後効かない）
- **クレデンシャルの解除・パスワードの変更でも、そのクレデンシャル宛の未使用トークンは同じトランザクションで無効化する**（解除したのにリセットリンクが生きている状態を作らない）
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

- ★ registerWithPassword — パスワードでアカウント登録（S-AC-01）。メール重複・パスワード要件・メール形式のエラーを含む。同一メールのクレデンシャルが既に存在する場合も `EMAIL_ALREADY_REGISTERED`（自動リンクしない）
- ★ registerOrLoginWithSso — SSO でのログイン。初回は自動でアカウント作成（S-AC-02）。ただし IdP から得たメールが既存アカウントのものと一致する場合は自動リンクせず `EMAIL_ALREADY_REGISTERED` の明示エラーとし、UI はパスワードログインへの導線を示す（アカウントリンクは現段階のスコープ外）
- ★ loginWithPassword — メールアドレスとパスワードでログイン（S-AC-03）。失敗理由は特定しない
- ★ logout — セッションの破棄（S-AC-04。セッション自体はアダプター管理）
- ★ requestPasswordReset — リセット依頼。トークン発行とメール送信。登録有無を明かさない（S-AC-07）。**SSO 専用アカウント（メールのクレデンシャルがログイン手段になっていない）にはトークンを発行せずメールも送らない**（未登録メールと同じ扱い。判定は「クレデンシャルの有無」ではなく「パスワードの検証材料の有無」で行う）。レスポンスはいずれの場合も「登録されていれば送信された」旨のみとし、登録有無・認証方式を明かさない（S-AC-07 の情報漏えい防止と同じ扱い）
- ★ executePasswordReset — リセット実行。トークン検証・消費と新パスワード設定（S-AC-07）。トークン検証後の対象クレデンシャルが万一パスワードの検証材料を持たない場合は、防衛的に `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` とする（requestPasswordReset が SSO 専用アカウントにトークンを発行しないため、正常運用ではこの分岐に到達しない）
- ★ changePassword — ログイン中のパスワード変更。現在パスワードの照合を伴う。パスワードのクレデンシャルを持つアカウントのみ（S-AC-07）
- ★ approveAiClientAuthorization — OAuth 認可の許可。AiClientConnection を作成する（S-AC-05）
- ★ denyAiClientAuthorization — OAuth 認可の拒否。接続は作らず、拒否をアダプターへ伝える（S-AC-05 異常系）
- ★ listAiClientConnections — 接続済み AI クライアントの一覧（S-AC-06）
- ★ revokeAiClientConnection — 接続の失効（S-AC-06）。対象 `connectionId` は設定画面からの外部入力だが、引くのは自分の Durable Object の中だけなので `AiClientConnectionRepository.findById(connectionId)` で足りる。不在は NotFound（到達可能性による構造的保証。ユースケース側の `connection.userId` 照合は不要）。取得結果が active なら `AiClientConnection.revoke` → `save`
- ★ changeTrashRetentionDays — ゴミ箱保持期限の変更（S-ST-01）
- ★ getCurrentUser — 現在のユーザー情報の読み取り（設定画面 P-13 の表示用）。email・**保有クレデンシャルの一覧**（要素は `credentialId` / `kind` / `label` の3つ組。パスワード変更 UI の表示判定にも使う: `kind: "email"` のログイン手段が無ければ非表示 S-AC-07）・trashRetentionDays を返す。人間 UI 専用の読み取りユースケース

補足: getCurrentUser の戻り値は表示用 DTO（view）であり、パスワードの検証材料等の資格情報は含めない。**`provider` / `providerSubject` も返さない**（`label` は provider 名までで subject を含まない）。`email` の取得は認証情報側の原本を本人の自己参照として1件だけ復号する経路であり、一覧表示のために複数件をまとめて復号する経路は開かない。
