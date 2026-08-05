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
/**
 * 保有クレデンシャルの非 PII 要約。
 * 同一性を表す値として設定画面の一覧に出せるのは credentialId / kind / label の3つだけで、
 * usableForLogin はそれ自体が識別子ではない可否フラグである（原本も主体 ID も含まない）
 */
export type CredentialRef = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** kind: "sso" なら provider 名（"google" / "apple"）、kind: "email" なら空文字 */
  label: string;
  /** 単独でログイン手段として成立するか。kind: "sso" は常に true、kind: "email" は検証材料を持つときだけ true */
  usableForLogin: boolean;
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
- **`usableForLogin` は「その要素だけでログインできるか」を表す。** 判定の権威は認証情報側（パスワードの検証材料を持つか）にあり、要約はその結果を写す。**`false` から `true` へ遷移させる経路は本設計に存在しない**（SSO 専用アカウントにパスワードを設定する経路が無いため。後述の不変条件）。この値があることで「最後のログイン手段か」の判定が `User` の状態だけで決まり、パスワード変更 UI の表示判定（pages P-13）も同じ材料で行える

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
   * 解除後に usableForLogin が true の要素が1件も残らない場合は
   * BusinessRuleError(LastCredentialRemoval)。
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
- **SSO 初回登録でもメールのクレデンシャルが1件置かれる。** メールアドレスの一意性を認証方式をまたいで効かせるためであり、この要素は**ログイン手段ではない**（パスワードの検証材料を持たないため。`usableForLogin: false`）

#### 不変条件

- メールアドレスは全ユーザー間で一意（S-AC-01 異常系）。一意性の権威は認証情報側の credential 行であり、登録は予約を取ってから進む。重複は `ConflictError("EMAIL_ALREADY_REGISTERED")`
- メール一意性は**認証方式をまたいで**適用する。SSO 初回サインイン時に IdP から得たメールが既存アカウントのものと一致する場合、既存アカウントへの自動リンクは行わず `EMAIL_ALREADY_REGISTERED` とする（UI はパスワードログインへの導線を示す）。逆も同様である
- `(provider, providerSubject)` の組も全ユーザー間で一意。重複は `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`
- **`credentials` は常に1件以上で、そのうち少なくとも1件は `usableForLogin: true` である。** 最後のログイン手段を解除する操作は `BusinessRuleError` で拒否する。数えるのは要素数ではなく**`usableForLogin` が真である要素の `credentialId` の異なり数**である（同じクレデンシャルが複数の表現を持ちうるため、要素数で数えるとログイン手段が0のアカウントを作れてしまう。`usableForLogin` を見ないと SSO 専用アカウントのメール要素まで数に入る）
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
| userId | `UserId` | required。許可を与えたユーザー（ID参照）。**値は所属する Durable Object の同一性そのものであり、行ごとの絞り込みには用いない**（domains/index.md「テナント分離」） |
| clientName | `ClientName` | required。認可リクエストが名乗るクライアント表示名 |
| connectedAt | `Date` | required。許可した日時 |
| lastUsedAt | `Date \| null` | optional。この接続のトークンで最後に API が呼ばれた日時。未使用なら null |
| createdAtResetVersion | `number` | required。**作成時点の `resetVersion`**（後述の `AccountStore`）。リセット完了時の自動失効の射程を決める材料で、生成後は変わらない |
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
    params: {
      id: string;
      userId: UserId;
      clientName: string;
      createdAtResetVersion: number;   // 呼び出し時点の AccountStore の resetVersion
    },
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
- `createdAtResetVersion` は生成時に固定され、以後の遷移で書き換わらない。**リセット完了を契機とする自動失効の対象は `createdAtResetVersion` が前進前の `resetVersion` と等しい接続だけ**であり、それより後に作られた接続は残る（通常のパスワード変更では `resetVersion` が動かないので対象が空になる）
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

すべてドメイン型を受け渡す。外部データのデコード（検証・変換）はアダプター境界の責務。リポジトリはテンプレートの `TransactionalRepository<TEntity, TId>` と同じ OCC 規約（insert / save + `ExpectedVersion` トークン、0 行更新 → Conflict）に従う。**全メソッドは同期契約であり `Promise` を返さない。例外は `PasswordHasher` と `MailSender` の2つだけで、これは列挙であって導出規則ではない**（domains/index.md「ポートの同期契約」）。

**`UserRepository` は2つに割れる。** `User` 集約が「認証情報の所有者」と「ユーザー単位設定の所有者」の2つの関心事を抱えていたためで、物理境界が分かれた以上ポートも分かれる。

| ポート | 置き場 | 持つもの |
|---|---|---|
| `CredentialMappingRepository` | 認証情報側（Identity Directory） | メール・SSO 主体の一意性、パスワードの検証材料、`userId` の解決 |
| `UserSettingsRepository` | ユーザー単位設定側（User Data DO） | `User`（クレデンシャル集合の要約・`trashRetentionDays`・OCC） |

**`User` 集約に畳まないストアが2つある。** `AccountStore`（アカウントの状態と失効の権威）と `CredentialLocatorStore`（保有クレデンシャルの逆引き）で、どちらも `User` の一部ではないので `UserSettingsRepository` には畳まない。**ただし `spec/database/index.md` の「非集約ストア」の分類に入るのは `CredentialLocatorStore` の側だけである** — `account` は OCC の `version` を持つ集約ルート側のテーブルで、非集約ストアの全数（`jobs` / `outbox_events` / `operations` / `migration_progress` / `credential_locators` / `password_reset_tokens` / `reset_request_windows` / `rotation_checkpoints` / `_meta` の9つ）にも、その書き込み口の全数（8ストア・9メソッド）にも入らない。**畳まないことと非集約であることは別である。** 物理的な置き場と列は `spec/database/index.md` が正本で、本節が定めるのは**ドメインから見た名前と契約**である。

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

- `CredentialMapping` が持つのは次のフィールドである。**検証材料の照合そのものはこのポートでは行わない** — 計算は `PasswordHasher` が担い、実行位置はトランザクションの外である

  | フィールド | 意味 |
  |---|---|
  | `credentialId` | 世代に依存しないクレデンシャルの同一性（`CredentialId`） |
  | `userId` | 写像先のユーザー |
  | `kind` | `"email"` / `"sso"` |
  | `usableForLogin` | 単独でログイン手段として成立するか。判定はこちら側が権威で、`CredentialRef` と `CredentialLocatorStore` はその結果を写す |
  | `credentialVersion` | クレデンシャルの世代番号。パスワードの差し替えごとに1つ進み、ログイン時の到達性検査で `CredentialLocatorStore` 側の値と一致することを要求する |
  | `changeState` | 変更手続きの中間状態。`null`（進行中でない）/ `"pending"`（旧材料を無効化済み）/ `"advanced"`（ユーザー単位設定側への反映が済んだ）の3値 |
  | `changeOrigin` | 変更手続きの起点。`"password-change"`（パスワード変更）/ `"reset"`（リセット完了）。**手続きの途中で再開しても起点が決まる**ように行へ永続化する |
  | `failedAttempts` / `nextAttemptAllowedAt` | 濫用抑止の試行回数と次に試行できる時刻。ログイン失敗と現在パスワード照合の失敗が同じカウンタを進める |

- **濫用抑止には3つの規則を課す。** カウンタの単位はクレデンシャルであって発信元ではないので、被害者のメールアドレスを知る攻撃者は誤ったパスワードを投げ続けるだけで `nextAttemptAllowedAt` を先送りできる。素朴に組むと正規利用者が正しいパスワードを入れても「成功時のリセット」に到達できない恒久的な締め出しになるため、次の3つを規則として置く（**具体値**（天井の秒数・減衰の係数・初期のバックオフ幅）**は運用側で決める**）。
  1. **天井を置く。** `nextAttemptAllowedAt` の先送り幅には上限があり、一定時間で頭打ちになる。無限に伸びる指数バックオフは採らない
  2. **時間減衰を置く。** 最後の失敗からの経過時間に応じて `failedAttempts` を減らす。成功だけがリセットの契機である設計にしない
  3. **試行が制限されている間の照合はカウンタを進めない。** `nextAttemptAllowedAt` が未到達の照合は `failedAttempts` に触らずに終わる。これが無いと攻撃者が先送りを無限に更新できるので、天井と減衰があっても意味を持たない
- **脱出経路は2本ある。** (i) パスワードリセットの完走は `failedAttempts` に影響されない別経路であり、完走時に `failedAttempts` を 0 に、`nextAttemptAllowedAt` を過去へ戻す（`promoteVerifier`）。(ii) SSO は別クレデンシャルなのでカウンタが独立しており、**パスワードの制限が SSO ログインを巻き込まない**

- エラーケース:
  - 一意性違反 → `ConflictError("EMAIL_ALREADY_REGISTERED")` / `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`。**事前チェックではなく予約の獲得で判定する**（同時登録のレースはこちらで捕捉される）
  - DB 例外 → `SystemError(DatabaseError)`
  - 該当なしはエラーではなく `null`
- **登録・変更・解除の手順そのものは単一のメソッドに畳めない。** 認証情報側とユーザー単位設定側の2つを跨ぐため、順序と再開の規則を持つ手続きとして usecases/identity.md に書く。**ただし各段が呼ぶ書き込み操作の名前と契約はここで固定する** — 畳まないことと契約を書かないことは別である。

  | 操作 | 段 | 効果 | 冪等性・条件 |
  |---|---|---|---|
  | `reserveCredential` | 予約の獲得 | canonical に対する予約行を書き、`credentialId` を確定する | 既存の有効な行があれば `ConflictError`。同じ手続き ID の再送は同じ行に収束する |
  | `activateReservation` | 予約の確定 | 予約行を有効な写像へ昇格し、`usableForLogin` を確定する | 同じ手続き ID の行にだけ効く |
  | `cancelReservation` | 予約の取り消し | 敗北した手続きの予約行を取り除く | 「無ければ成功」の冪等操作 |
  | `beginCredentialChange` | 検証材料の差し替え開始 | 新しい検証材料を保留として書き、`changeState` を `"pending"` に、`changeOrigin` を起点の値にする。**同じトランザクションでそのクレデンシャル宛の未使用リセットトークンをすべて無効化する** | 旧検証材料での照合はこの瞬間から拒否される |
  | `promoteVerifier` | 検証材料の昇格 | 保留の検証材料を正本にし、`credentialVersion` を揃え、`changeState` / `changeOrigin` を `null` へ戻す。**同じトランザクションで `failedAttempts` を 0 に、`nextAttemptAllowedAt` を過去へ戻す**（濫用抑止からの脱出経路） | `changeState` が `"advanced"` のときだけ通す |
  | `deleteMapping` | 解除・退会 | 対象 `credentialId` の写像行と、そのクレデンシャル宛のリセットトークン行を消す | 「無ければ成功」の冪等操作 |

  **これらは `CredentialMappingRepository` のメソッドではない。** 手続きの各段が認証情報側へ発行する操作であり、`find*` の3本のようにドメイン型を返す読み取りとは性質が違う（実装形は `spec/database/index.md` と #51 が決める）。ここで固定するのは名前・効果・冪等性の3つだけである。

  **中間状態のあいだは旧新どちらのパスワードでもログインできない**（fail closed）。前進不能が確定した場合の終端は一様である（記録を残して運用へエスカレーションする）。**終端の具体的な手順は [#45](https://github.com/tuanemuy/fog/issues/45) が定める。**

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
- **単一行なので `save` の条件付き更新に `id` 述語を持たない**（条件は OCC の `version` だけである。`spec/database/index.md`）
- エラーケース:
  - `save` の OCC 不一致 → `ConflictError("OPTIMISTIC_LOCK_FAILURE")`
  - DB 例外 → `SystemError(DatabaseError)`

### AccountStore

- 目的: アカウントの状態と失効の権威を保持する。**`User` 集約の一部ではない** — セッションの失効は設定の変更ではないためである
- 置き場: ユーザー単位設定側（User Data DO）。単一行。**`account` テーブルは OCC の `version` を持つ側であり、非集約ストアには数えない**（`spec/database/index.md`）

```ts
export type AccountState = Readonly<{
  status: "active" | "deleting" | "deleted";
  /** セッション失効の唯一の権威。単調増加 */
  sessionEpoch: number;
  /** パスワードリセットの完了だけで進む単調増加カウンタ */
  resetVersion: number;
}>;

export interface AccountStore {
  find(): AccountState | null;

  /** セッションの世代を1つ進める（既存セッションは次のリクエストで失効する） */
  advanceSessionEpoch(): void;

  /** リセット世代を1つ進める。進めた後の値を返す */
  advanceResetVersion(): number;
}
```

- **`sessionEpoch` を進める操作は4つだけである** — パスワードの変更、パスワードリセットの完了、SSO 連携の解除、退会。**SSO 連携の追加では進めない**（認証手段が増えるだけで既存セッションの信頼性が下がらないため）
- **`resetVersion` はリセットの完了だけで進む。** 通常のパスワード変更・SSO の連携と解除では進めない。AI クライアント接続の自動失効の射程がこの値で決まるので、`sessionEpoch` で代用しない（侵害と復旧のあいだにパスワード変更が1回でも挟まると、失効させたい接続が対象から外れる）
- **セッションの照合そのものはアダプター（認証ミドルウェア）の責務である。** ドメインが持つのは「世代を進める」という遷移と、その値が失効の唯一の権威であるという規則だけである
- **2つの前進メソッドは `ExpectedVersion` を取らず `version` も進めない。** 単調増加カウンタの前進であって設定の更新ではないので、OCC の条件を付けない単独文で書く（`ai_client_connections` の `recordUsage` と同じ扱い。`spec/database/index.md`）
- **`AccountState` は `version` を持たず、本ポートは `save` に相当するメソッドも持たない。** `account` テーブルは OCC の `version` 列を保持するが、**本 spec の範囲には条件付き更新を発行する操作が無い**。`status` の `"deleting"` / `"deleted"` への遷移を書くのは退会の手続きであり、**退会は要件・シナリオに存在しないため本 spec の範囲外である**（本ドメインの `User` ライフサイクルも「アカウント削除は現段階のスコープ外」と宣言している）。`status` を型に残すのは、ログインとリセットのガードが `"active"` であることを読む側の権威だからである
- **`advanceResetVersion()` の戻り値は前進後の値である。** 失効の射程となる前進前の値はこの戻り値から導き、**`find()` で読み直さない** — 読み直しと前進を分けると、並行実行で射程がずれる
- エラーケース: DB 例外 → `SystemError(DatabaseError)`

### CredentialLocatorStore

- 目的: 保有クレデンシャルの逆引き。**ログインの到達性検査の権威**であり、SSO 連携の解除・退会のときに認証情報側の写像を消すための唯一の逆引き情報でもある。原本（メールアドレス）も検証材料も持たない
- 置き場: ユーザー単位設定側（User Data DO）

```ts
export type CredentialLocator = Readonly<{
  credentialId: CredentialId;
  kind: "email" | "sso";
  /** 認証情報側の行へ辿り着くための不透明な写像材料。中身の解釈はアダプターに閉じる（spec/database/index.md） */
  mapping: string;
  credentialVersion: number;
  usableForLogin: boolean;
  label: string;
}>;

export interface CredentialLocatorStore {
  /** 自分の Durable Object の保有クレデンシャルを全件返す */
  list(): readonly CredentialLocator[];

  /** credentialId で引く。不在は null */
  findByCredentialId(credentialId: CredentialId): CredentialLocator | null;

  /** 記録（upsert）。既存があれば credentialVersion / usableForLogin / label を上書きする */
  record(locator: CredentialLocator): void;

  /** その credentialId の credentialVersion を1つ進める */
  advanceCredentialVersion(credentialId: CredentialId): void;

  /** その credentialId の行をすべて消す。「無ければ成功」の冪等操作 */
  deleteByCredentialId(credentialId: CredentialId): void;
}
```

- **到達性の照合は `credentialId` だけを見る。** 写像材料の世代を判定に含めない — 同じクレデンシャルについて複数の写像材料が並存しうるためである。**`record` / `advanceCredentialVersion` / `deleteByCredentialId` はいずれも `credentialId` 単位で、その credential のすべての行に同時に効く**（1つだけ更新すると認証情報側との食い違いが残る）
- **`credentialVersion` は `credentialId` 単位で単調非減少である。** `record` は引数の値と既存の最大値のうち大きいほうを書く。**既存行があれば何もしない no-op にしてはならない** — 記録が空振りすると到達性検査が利用者を締め出す
- **`usableForLogin` / `label` は引数の値でそのまま上書きする**（判定の権威は認証情報側にある）
- **`User.credentials` はこのストアの射影である。** `usableForLogin` が真である行の `credentialId` の異なり数が「ログイン手段の数」であり、`User` の不変条件が数えるのと同じ値である
- エラーケース: DB 例外 → `SystemError(DatabaseError)`

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
  /**
   * リセットトークンを発行する。有効期限の起点として now を受ける。
   * 生トークンと、それを指す tokenId を返す。
   */
  issue(credentialId: CredentialId, now: Date): { token: string; tokenId: string };

  /** どのトークンも指さない tokenId を1つ採る（送らない側の payload 用） */
  mintDecoyTokenId(): string;

  /**
   * トークンを検証し、有効なら消費（使い捨て）して対象ユーザーを返す。
   * 無効・期限切れ・使用済みは null
   */
  verifyAndConsume(token: string, now: Date): UserId | null;
}
```

- **`issue` は生トークンと `tokenId` の両方を返す。** 生トークンは**アダプターの外へ出るが、ユースケースはこれを読まない・保持しない・どこへも渡さない**（現状の読み手は0件であり、送信時は送信材料 RPC が `tokenId` から導出し直す。**URL の組み立てとメール本文のレンダリングは RPC の側では行わない** — それは `MailSender` アダプターの責務である。下の `MailSender`）。返し続けるのは、payload の必須項目である `tokenId` を同じ戻り値で得るためである — **`tokenId` を返さない形にすると、ユースケースが payload の必須項目を手に入れる経路が無くなる**
- **したがって `token` は「戻り値に居るが読み手が0件の値」である。** ログ・DTO・イベント payload・Queue メッセージのいずれにも載せない。**この禁止は signature が守ってくれないので、実装レビューの確認項目として残す**（`spec/async/index.md`「payload と `terminal_reason` の衛生規則」）
- **`mintDecoyTokenId` は「送らない側」（未登録 / SSO 専用）の payload に置くデコイを採る唯一の口である。** 行を1つも書かず、`verifyAndConsume` で解決できる値も返さない
- **4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）で `tokenId` の生成器が同一であることが契約である。** `issue` が返す `tokenId` と `mintDecoyTokenId` が返す値は、同じ CSPRNG・同じ長さ・同じ符号化で採る。**生成器が割れると、送らない側の payload だけが別の形になり、payload そのものが列挙オラクルになる**（`.adr/013`）
- **`IdGenerator` を使わない。** ユースケースが使える唯一の採番口である `container.idGenerator.next()` は UUIDv7 等の**時刻由来**の値で、`token_id` の生成規則（連番・rowid・時刻由来を使わない。`spec/database/index.md`）と正面から食い違う。デコイ側だけがそれを使うと上記の割れがそのまま起きるので、**両方をこのポートに閉じる**
- **同期契約である。** メソッドが3つに増えても domains/index.md の `Promise` 例外2件（`PasswordHasher` / `MailSender`）は動かない
- **発行は対象クレデンシャル単位である。** 同じクレデンシャルに新しいトークンを発行すると、そのクレデンシャル宛の未使用トークンはすべて置き換わる（古いリンクは以後効かない）
- **クレデンシャルの解除・パスワードの変更でも、そのクレデンシャル宛の未使用トークンは同じトランザクションで無効化する**（解除したのにリセットリンクが生きている状態を作らない）
- エラーケース:
  - 無効・期限切れ・使用済みトークンはエラーではなく `null`（ユースケースが `ValidationError("RESET_TOKEN_INVALID")` 等に変換し、S-AC-07 の「期限切れの場合は再送をやり直せる」表示につなげる）
  - ストア障害 → `SystemError`

### PasswordResetThrottlePort

- 目的: リセット依頼のスロットル窓の判定と計上（S-AC-07）。**「その窓で既に依頼を受け付けたか」を1回の呼び出しで判定し、同時に計上する**
- **置き場は認証情報側（Identity Directory）である。** 窓のキーは対象クレデンシャルではなく canonical 化したメールアドレスから導くので、**未登録の宛先でも成立する**必要がある。物理形は `reset_request_windows`（`spec/database/index.md`）で、UoW コンテキスト側のハンドル名は `resetThrottleStore` である（`resetTokenStore` / `PasswordResetTokenPort` と同じ「ハンドル名とポート名が別」の形）

```ts
export interface PasswordResetThrottlePort {
  /**
   * その窓の最初の依頼なら行を作って true、
   * 既存の窓なら最終依頼時刻だけを更新して false を返す。
   */
  claimWindow(windowKey: string, now: Date): boolean;
}
```

- **メソッドは1つだけであり、これが全数である。** 判定と計上を2メソッドに分けない — 分けると「4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）が一様に落ちる」が2つの呼び出しの組み合わせの性質になり、呼び出し順序を誤ると一様性が静かに壊れる。1メソッドなら**単一の呼び出しの性質**として書ける
- **戻り値の `boolean` が「イベント行を書くか」と「リセットトークンを発行するか」の両方を決める唯一の分岐である。** 発行判断と窓判定は同じ1つの分岐であって、2つの独立した条件ではない（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）
- **`windowKey` は呼び出し側が導出して渡す** — 対象 canonical の全長 HMAC と依頼の窓から決定的に導く（**導出規則の正本は `spec/database/index.md` の `reset_request_windows` の節**）。**クライアントからは受け取らない。** ポートは導出鍵を知らない
- **導出主体は次のとおりである。** `windowKey` は **bucket 選択のために canonical の全長 HMAC を既に計算しているアダプター（Identity Directory の stub を選ぶ側）が、その同じ値を DO facade へプリミティブとして渡し**、ユースケースが窓と合成して組み立てる。**導出鍵はその stub 選択アダプターの中にあり、ユースケースにもポートにも渡らない。** facade が受け取る HMAC は server-side で導出された値であって外部入力ではないので、`CLAUDE.md`「Input validation」の第3の検証点にはならない（**クライアントからは受け取らない**）。合成は keyed な再導出を行わない（鍵付きの部分は HMAC 側で済んでいる）ので、`transactionSync` の中に暗号処理を持ち込まない
  - **HMAC を返すドメインポートは足さない。** bucket 選択のために既に計算されている値を捨てて計算し直さないので、本ファイルのポートの数え上げも domains/index.md の `Promise` 例外2件（`PasswordHasher` / `MailSender`）も動かない
- **窓の長さは引数に現れないが、2層が同じ値を読む。** 呼び出し側は `windowKey` の合成（HMAC + 窓）のために、アダプターは窓行の `expires_at`（窓の終端 + 猶予）の算出のために、それぞれ窓の長さを知る必要がある。**正本は単一の設定値であり、`spec/database/index.md` の `reset_request_windows` の節が持つ**（実値の確定は #38）。**2箇所に別々の定数を置かない** — アダプター側が短いと、まだ有効な窓の行が `sweep-reset-tokens` に消され、`claimWindow` が同じ窓で2度目の `true` を返す（同節が写像鍵の世代跨ぎに限って明示的に許容している破れが、設定ミスで恒常化する）
- **登録の有無に関係なく行を作る。** 行の有無が観測可能な差にならないことが、このポートを置いた理由そのものである
- **同期契約である**（`transactionSync` の中で呼ぶ）。domains/index.md の `Promise` 例外2件は動かない
- エラーケース:
  - ストア障害 → `SystemError`

### MailSender

- 目的: ユーザーへのメール送信。現状はパスワードリセットメールのみ

```ts
export interface MailSender {
  /**
   * リセットリンク（トークン込みURL）を届ける。URL の組み立てはアダプターの責務。
   * providerIdempotencyKey は provider へそのまま渡す二重送信抑止のキー。
   */
  sendPasswordResetMail(
    to: Email,
    resetToken: string,
    providerIdempotencyKey: string,
  ): Promise<void>;
}
```

- **`providerIdempotencyKey` は at-least-once 下で重複メールを止める唯一の機構である。** 配送は少なくとも1回であり、同じ `event.id` が2回届いてどちらも呼び出しガードを通る経路が正常系として存在する（async/index.md）。抑止は配送状態（`status`）ではなくこのキーが担うので、**引数として受け取れない signature では機構そのものが成立しない**
- **値は consumer が組み立てず、送信材料 RPC の応答として発行元 DO から受け取る**（`event.id` から DO 側で決定的に導く。async/index.md）。`outbox_events` の列ではない
- **引数が1つ増えても、非同期ポートの例外は `PasswordHasher` / `MailSender` の2件のまま動かない**（domains/index.md「ポートの同期契約」）。例外の判定基準は「実装できる API が非同期しか無いか」であって引数の数ではない
- **呼ぶのは Alarm ジョブではなく、request Worker の `queue()` ハンドラ（mail consumer）である**（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。consumer は `identity.passwordResetRequested` のメッセージを受けて発行元 Identity Directory bucket へ**送信材料 RPC** を打ち、応答が `send` のときだけ本ポートを呼ぶ（`nothing-to-send` なら no-op して ack する）。**宛先の復号と生トークンの導出は DO の中に閉じたまま**であり、`to` / `resetToken` は RPC の応答としてのみ consumer に渡り、どこにも永続化されない（async/index.md「送信材料 RPC」）
- **`send` が持つのは宛先・生リセットトークン・`providerIdempotencyKey` の3つである。URL の組み立てとメール本文のレンダリングは本ポートのアダプター（request Worker）の責務**であり、DO はテンプレートも base URL も持たない。**DO の中に閉じるのは復号と HMAC 導出であって、レンダリングではない**（`CLAUDE.md` の「CPU-bound work は request Worker」）。上の signature に本文を受け取る引数が無いのはこの帰結である
- **リセット URL の base URL は Worker の設定値（環境変数）だけから取り、リクエスト由来のホスト情報（`Host` / `X-Forwarded-Host` / `Origin` など）からは導かない。** consumer は `queue()` ハンドラで動くので受信リクエストがそもそも存在しないが、規則として書く — 導くと攻撃者が制御するホストへ生トークンを載せたリンクをメールさせられる（リセットリンクのポイズニング）。**リセット画面からの Referer 送出の抑止と、リダイレクト時にトークンを引き継がないことは presentation 側の要件であり、#51 が担う。**
- エラーケース:
  - 送信基盤の失敗 → `SystemError`。ただしリセット依頼ユースケースは「登録されていれば送信された」旨のみ返すため（S-AC-07 異常系）、宛先実在性に起因する失敗をユーザー応答に反映してはならない。**依頼の応答は配送の成否を待たない** — 配送は結果整合であり、送信の失敗は Queue の retry → DLQ で扱う
  - **エラーの翻訳時に、宛先・組み立て済み URL・生トークン・provider の応答本文を `SystemError` のメッセージにも詳細にも載せない。ログに載せてよいのは provider 側のステータスと `providerIdempotencyKey` の有無までである**（async/index.md の配送機構3コンポーネントに掛かる許可リストと同じ射程）。**生トークン入りの URL と宛先を実際に保持するのは本アダプターだけである。**

## ドメインイベント

**イベント型を定義するドメインは identity だけである**（全数は [async/index.md](../async/index.md)）。契約の骨格は全ドメイン共通で、domains/index.md「ドメインイベントの契約」が上位の規約を持つ。

### 共通の契約

| 契約 | 形 | 補足 |
|---|---|---|
| `EventId` | 不透明な非空文字列 | 形式（UUIDv7 等）は `IdGenerator` の責務。ドメインは形式を知らない |
| イベント draft | `{ type, payload, occurredAt, aggregateId }` | **`EventId` を持たない。** ドメインが identity-less な draft を返し、アプリケーション層（UoW 実装）が採番して付ける |
| イベント | draft + `{ id: EventId }` | UoW が `outbox_events` へ書く形 |
| ファクトリ / 遷移の戻り値 | `{ entity, eventDrafts }` | **イベントを発行する**ファクトリ / 遷移だけがこの形を採り、状態遷移とイベントの発生を1つの戻り値で表す。**本 spec に該当する遷移は無い** — `registerWithPassword` / `addCredential` / `removeCredential` 等はすべて `): User;` のままであり、memo.md / knowledge.md の「状態遷移は次状態のエンティティだけを返す」も動かない。将来イベントを発行する遷移が現れたときの契約である |

- **ドメインは `IdGenerator` にも時計にも触らない。** `occurredAt` は引数として受けた `now` を使う
- **登録口は UoW コンテキストの `enqueueEvent(drafts)` 1つだけ**であり、ドメインポートではない（domains/index.md）。ユースケースが draft を渡し、`outbox_events` への INSERT は業務データの書き込みと同じ `transactionSync` の中で起きる
- **payload に PII と再利用可能な秘密を載せない。** メールアドレス・生トークン・`userId` は payload にも `terminal_reason` にもログにも出さない（衛生規則の正本は [async/index.md](../async/index.md)）

### identity.passwordResetRequested

| 項目 | 内容 |
|---|---|
| `type` | `identity.passwordResetRequested` |
| 発行点 | `requestPasswordReset` のトランザクション。**その窓での最初の依頼のときだけ、4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）とも必ずちょうど1行**。既に発行済みの窓なら4ケースとも1行も書かない（usecases/identity.md） |
| `aggregateId` | **スロットル窓のキー**（`PasswordResetThrottlePort.claimWindow` に渡した `windowKey`）。4ケースのどれでも同じ導出で決まる唯一の識別子であり、鍵付きハッシュ済みなので原本を含まない。**`credentialId` は使えない** — 未登録の宛先には存在せず、有無が観測可能な差になる |
| payload | `tokenId` / メール種別の**2つだけ**。**宛先 DO の routing key は payload に入れない** — routing key は relay が publish 時に Queue メッセージへ押す項目であって、ドメインの payload ではない（`EventId` と同じ扱い。relay は自分の DO の routing key を自明に知っている）。**Queue メッセージが運ぶ routing key は、発行元 DO 自身の locator である**（Identity Directory では `_meta.self_locator` と同じ `dir:g{世代}:b{番号}` の bucket 名。多数の利用者で共有される粒度なので個人を指さない）。**クレデンシャル単位の内部キー（canonical の全長 HMAC）は載せない** — 窓で切れない仮名になり、`aggregate_id`（窓キー）を外した理由（DLQ 上での宛先相関）をそのまま無効化する（正本は async/index.md「Queue メッセージ」） |
| consumer | mail consumer（1つ。request Worker の `queue()` ハンドラ） |

- **`tokenId` を nullable にしない。** 未登録 / SSO 専用ではトークンが発行されないが、**宛先の有無から独立に生成した不透明値**（トークンと同じ形・同じ長さ）を置く。`NULL` か否かが観測できると payload そのものが列挙オラクルになる。**行の形が4ケースで一字も違わないことが、経路一致の実体である**
- **consumer は payload から送信内容を組み立てない。** 宛先・生リセットトークン・`providerIdempotencyKey` は発行元 DO への送信材料 RPC で取得する（async/index.md）。**本文はこの3つに含まれない** — URL の組み立てとレンダリングは `MailSender` アダプターが行う
- **メール種別の値域は `"password-reset"` の1値であり、これが全数である。** draft ファクトリはこれを union 型で受け、裸の `string` にしない（下の draft ファクトリ）。**現時点でこの値を読んで分岐する主体は無い** — consumer は業務判断を1つも持たず（async/index.md「consumer の一覧と責務」）、送信材料 RPC 側にも今は分岐が無い。載せているのは**2つ目のメール種別が現れたときに送信材料 RPC が分岐する材料**にするためであり、値域を増やす変更は同時に RPC 側の分岐を定めることを条件とする。**payload が「`tokenId` / メール種別の2つだけ」であることは動かさない**
- **他のイベント型を定義しない。** 登録・パスワード変更・ゴミ箱保持期限の変更はいずれも consumer を持たず、`spec/requirements.md` に監査要件も無い。**consumer が存在せず明示的な監査要件も無いイベントは定義しない**（判定規則2 は「独立した consumer へ委譲する」を要求するので、consumer が無いイベントは類型を名乗れない）

#### draft ファクトリ

`identity.passwordResetRequested` は**エンティティ遷移から出ないイベント**である（`requestPasswordReset` は `User` も `CredentialMapping` も遷移させない）。したがって `{ entity, eventDrafts }` の形では出せないので、**draft ファクトリを1本置き、ユースケースはその戻り値を `enqueueEvent` へ渡すだけにする**（domains/index.md「ドメインイベントの契約」）。

```ts
/** メール種別の値域。現状は1値でこれが全数 */
export type MailKind = "password-reset";

export function passwordResetRequestedDraft(input: {
  windowKey: string;
  tokenId: string;
  mailKind: MailKind;
  now: Date;
}): EventDraft; // = { type, payload, occurredAt, aggregateId }（上の共通の契約）
```

- **`type` の文字列・`aggregateId` の選び方・payload の形を決める唯一の場所である。** ユースケースがオブジェクトリテラルで組み立てる形にすると、「4ケースで一字も違わない行」を保証する主体が誰も居なくなる
- `aggregateId` には `windowKey` をそのまま入れる。`occurredAt` には引数の `now` を使う（ドメインは時計にも `IdGenerator` にも触らない）
- **`tokenId` の出所はファクトリの外である** — 送る側は `PasswordResetTokenPort.issue` の戻り値、送らない側は `mintDecoyTokenId()` で、どちらも同じ生成器から採る。ファクトリは受け取った値を検査せず、**形が同一であることの担保はポート側の契約が持つ**
- **`mailKind` は `MailKind` の union で受け、裸の `string` にしない。** 値域は1値なので、型が「4ケースで同じ値が入る」ことをそのまま守る（上の payload 欄）
- **routing key は取らない。** ドメインは自分がどの DO に載っているかを知らない（上の payload 欄）
- **4ケースのどれでも同じ引数の形で呼ぶ。** 呼ぶか呼ばないかを決めるのは `claimWindow` の戻り値だけで、登録有無・認証方式・宛先の存在では分岐しない（usecases/identity.md）

## ユースケース（概要）

詳細はユースケース設計フェーズで定義する。★ は Web UI 専用（human スコープのみに配線し、AI 側の presentation には存在させない）。identity のユースケースはすべて ★ である（AI クライアントが自分の認可を操作することはない）。

- ★ registerWithPassword — パスワードでアカウント登録（S-AC-01）。メール重複・パスワード要件・メール形式のエラーを含む。同一メールのクレデンシャルが既に存在する場合も `EMAIL_ALREADY_REGISTERED`（自動リンクしない）
- ★ registerOrLoginWithSso — SSO でのログイン。初回は自動でアカウント作成（S-AC-02）。ただし IdP から得たメールが既存アカウントのものと一致する場合は自動リンクせず `EMAIL_ALREADY_REGISTERED` の明示エラーとし、UI はパスワードログインへの導線を示す。**スコープ外なのは「サインイン時の自動リンク」だけ**であり、利用者が設定画面から明示的に開始する SSO 連携の追加は `linkSsoCredential` が担う
- ★ loginWithPassword — メールアドレスとパスワードでログイン（S-AC-03）。失敗理由は特定しない
- ★ logout — セッションの破棄（S-AC-04。セッション自体はアダプター管理）
- ★ requestPasswordReset — リセット依頼。トークン発行とメール送信。登録有無を明かさない（S-AC-07）。**SSO 専用アカウント（メールのクレデンシャルがログイン手段になっていない）にはトークンを発行せずメールも送らない**（未登録メールと同じ扱い。判定は「クレデンシャルの有無」ではなく「パスワードの検証材料の有無」で行う）。レスポンスはいずれの場合も「登録されていれば送信された」旨のみとし、登録有無・認証方式を明かさない（S-AC-07 の情報漏えい防止と同じ扱い）
- ★ executePasswordReset — リセット実行。トークン検証・消費と新パスワード設定（S-AC-07）。トークン検証後の対象クレデンシャルが万一パスワードの検証材料を持たない場合は、防衛的に `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` とする（requestPasswordReset が SSO 専用アカウントにトークンを発行しないため、正常運用ではこの分岐に到達しない）
- ★ changePassword — ログイン中のパスワード変更。現在パスワードの照合を伴う。パスワードのクレデンシャルを持つアカウントのみ（S-AC-07）
- ★ approveAiClientAuthorization — OAuth 認可の許可。AiClientConnection を作成する（S-AC-05）
- ★ denyAiClientAuthorization — OAuth 認可の拒否。接続は作らず、拒否をアダプターへ伝える（S-AC-05 異常系）
- ★ listAiClientConnections — 接続済み AI クライアントの一覧（S-AC-06）
- ★ revokeAllAiClientConnections — active な接続をすべて失効させる（リセット完了画面の必須導線。pages P-03）。`revokeAiClientConnection` を一覧の全件へ適用する形だが、部分失敗の扱い（記録して続行し、全体を中断しない）を持つので独立したユースケースとして定義する
- ★ linkSsoCredential — SSO 連携の追加（pages P-13。S-AC-02 エッジケース）。`User.addCredential` の遷移と、認証情報側の予約獲得・確定、`CredentialLocatorStore` への逆引き記録からなる手続きである。追加できるのは `kind: "sso"` の要素だけで、**`unlinkSsoCredential` が解除する対象を作る唯一の経路**である。`sessionEpoch` は進めない
- ★ unlinkSsoCredential — SSO 連携の解除（pages P-03 / P-13）。`User.removeCredential` の遷移と、`CredentialLocatorStore` / 認証情報側の写像の除去からなる手続きである。対象が `kind: "sso"` であることと、最後のログイン手段でないことをドメイン側で検査する
- ★ revokeAiClientConnection — 接続の失効（S-AC-06）。対象 `connectionId` は設定画面からの外部入力だが、引くのは自分の Durable Object の中だけなので `AiClientConnectionRepository.findById(connectionId)` で足りる。不在は NotFound（到達可能性による構造的保証。ユースケース側の `connection.userId` 照合は不要）。取得結果が active なら `AiClientConnection.revoke` → `save`
- ★ changeTrashRetentionDays — ゴミ箱保持期限の変更（S-ST-01）
- ★ getCurrentUser — 現在のユーザー情報の読み取り（設定画面 P-13 とリセット完了画面 P-03 の表示用）。email・**保有クレデンシャルの一覧**（要素は `credentialId` / `kind` / `label` / `usableForLogin`。パスワード変更 UI の表示判定にも使う: `usableForLogin` が真の `kind: "email"` の要素が無ければ非表示 S-AC-07）・trashRetentionDays を返す。人間 UI 専用の読み取りユースケース

補足: getCurrentUser の戻り値は表示用 DTO（view）であり、パスワードの検証材料等の資格情報は含めない。**`provider` / `providerSubject` も返さない**（`label` は provider 名までで subject を含まない）。`email` の取得は認証情報側の原本を本人の自己参照として1件だけ復号する経路であり、一覧表示のために複数件をまとめて復号する経路は開かない。
