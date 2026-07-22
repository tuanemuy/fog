# ユースケース設計: identity

[domains/identity.md](../domains/identity.md) のユースケース概要を詳細化する。

共通事項:

- **公開面**: identity のユースケースは**すべて人間UI（★）専用**である。human スコープのみに配線し、AI 側の presentation（MCP / REST API）には存在させない（AI クライアントが自分の認可を操作することはない）
- **セッション・OAuth プロトコルの責務分界**: セッションの生成・破棄・Cookie 管理、OAuth 2.1 のプロトコル詳細（認可コード、PKCE、トークン発行・検証・失効反映、リダイレクト）はすべて**アダプター/presentation 層の責務**。ユースケースは「認可の事実の記録」「認証情報の照合」などドメイン操作のオーケストレーションに限定する
- 各ユースケースは `ServiceArgs<TInput>` で `container`（`clock` / `idGenerator` / `unitOfWorkProvider` / 各ポート）と `input` を受け取る。`now` / 新規 `id` はユースケース冒頭で解決し、ドメイン内では生成しない
- 書き込みは `UnitOfWorkProvider.run` 内で行い、ドメインファクトリが返すイベントドラフトを `collectEvents` に渡す（Outbox に同一トランザクションでフラッシュされる）
- エラー種別の使い分け: 入力・照合の失敗は `ValidationError`、対象不在は `NotFoundError`、一意性・OCC 競合は `ConflictError`、ドメイン規則違反（値オブジェクト生成失敗を含む）は `BusinessRuleError<IdentityErrorCode>`、基盤障害は `SystemError`
- `input` の `userId` はセッション由来の信頼済み ID（presentation 層が認証済みセッションから注入する）。外部入力として受けるのは `connectionId`（revokeAiClientConnection）等の明示したフィールドのみ
- 出力DTOのフィールドはプリミティブ型で表記する（ブランド型 VO はプリミティブに widen して射影する）

## registerWithPassword

### 概要

メールアドレスとパスワードでアカウントを登録する（S-AC-01）。登録済みメール（SSO ユーザー含む）との重複は明示エラーとし、自動リンクは行わない。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| email | `string` | required | `Email.create`（trim・小文字化後にメール形式、最大320文字） |
| password | `string` | required | `PlainPassword.create`（8文字以上128文字以下） |

### 出力DTO

| フィールド | 型 |
|---|---|
| userId | `string` |

セッションの確立は presentation 層が本出力の `userId` を用いて行う。

### 処理フロー

1. `container.clock.now()` で `now`、`container.idGenerator.next()` で新規 ID を解決する
2. `Email.create(input.email)` / `PlainPassword.create(input.password)` で値オブジェクトを構築する
3. `container.passwordHasher.hash(plainPassword)` で `PasswordHash` を得る（UoW 外で実行）
4. `unitOfWorkProvider.run` 内:
   1. `UserRepository.findByEmail(email)` で重複を事前検証する。既存ユーザー（認証方式を問わない）が居れば `ConflictError("EMAIL_ALREADY_REGISTERED")`
   2. `User.registerWithPassword({ id, email, passwordHash }, now)` で `PasswordUser` とイベントドラフト（`identity.userRegistered`）を得る
   3. `UserRepository.insert(user)` で永続化する（同時登録レースは DB の email 一意制約で捕捉）
   4. `collectEvents(eventDrafts)`
5. `userId` を返す

### エラーケース

| 条件 | エラー |
|---|---|
| メール形式不正 | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` |
| パスワード要件違反 | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` |
| メール登録済み（事前検証。SSO ユーザーとの重複含む） | `ConflictError("EMAIL_ALREADY_REGISTERED")` |
| 同時登録レース（insert の一意制約違反） | `ConflictError("EMAIL_ALREADY_REGISTERED")` |
| ハッシュ計算失敗・DB 例外 | `SystemError` |

## registerOrLoginWithSso

### 概要

SSO でログインする。初回はアカウントを自動作成し、2回目以降は既存アカウントへのログインになる（S-AC-02）。IdP のメールが既存パスワードユーザーと一致する場合は自動リンクせず明示エラー。

IdP との認証フロー（リダイレクト・トークン交換・メール検証）はアダプターの責務。本ユースケースは検証済みの IdP 主体情報を受け取ってからのドメイン操作のみを担う。プロバイダ側キャンセル・認証失敗はアダプターで完結し、本ユースケースには到達しない。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| provider | `string` | required | `SsoProvider` のいずれか（`"google" \| "apple"`） |
| providerSubject | `string` | required | 非空（IdP の `sub`。アダプターが検証済み） |
| email | `string` | required | `Email.create`（IdP から取得した検証済みメール） |

### 出力DTO

| フィールド | 型 |
|---|---|
| userId | `string` |
| isNewUser | `boolean` |

セッションの確立は presentation 層が行う。

### 処理フロー

1. `now` / 新規 ID を解決し、`SsoProvider` / `Email.create(input.email)` で値オブジェクトを構築する
2. `unitOfWorkProvider.run` 内:
   1. `UserRepository.findBySsoIdentity(provider, providerSubject)` で既存アカウントを検索する。存在すればその `userId` と `isNewUser: false` を返す（ログイン。書き込みなし）
   2. 不在なら `UserRepository.findByEmail(email)` でメール重複を検証する。既存ユーザーが居れば `ConflictError("EMAIL_ALREADY_REGISTERED")`（自動リンクしない。UI はパスワードログインへの導線を示す）
   3. `User.registerWithSso({ id, email, provider, providerSubject }, now)` で `SsoUser` とイベントドラフト（`identity.userRegistered`）を得る
   4. `UserRepository.insert(user)`（同時初回サインインのレースは DB の (provider, providerSubject) 一意制約で捕捉）
   5. `collectEvents(eventDrafts)`
3. `userId` と `isNewUser: true` を返す

### エラーケース

| 条件 | エラー |
|---|---|
| 未対応プロバイダ | `BusinessRuleError(IdentityErrorCode.UnsupportedSsoProvider)` |
| メール形式不正 | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` |
| 既存パスワードユーザーとメール一致 | `ConflictError("EMAIL_ALREADY_REGISTERED")` |
| 同時初回サインインのレース（insert の一意制約違反） | `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` |
| DB 例外 | `SystemError` |

## loginWithPassword

### 概要

メールアドレスとパスワードでログインする（S-AC-03）。失敗理由は特定しない（メール・パスワードのどちらが誤りかを明かさない）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| email | `string` | required | `Email.create` |
| password | `string` | required | `PlainPassword.create` |

### 出力DTO

| フィールド | 型 |
|---|---|
| userId | `string` |

セッションの確立は presentation 層が行う。

### 処理フロー

1. `Email.create(input.email)` / `PlainPassword.create(input.password)` で値オブジェクトを構築する。生成失敗は認証情報全体の誤りとして `ValidationError("INVALID_CREDENTIALS")` に変換する（形式エラーを個別に返すと登録有無の推測材料になるため）
2. `UserRepository.findByEmail(email)` で検索する（読み取りのみ。UoW 不要）
3. 不在、または `authMethod: "sso"` のユーザーの場合は `ValidationError("INVALID_CREDENTIALS")`
4. `PasswordUser` なら `container.passwordHasher.verify(plainPassword, user.passwordHash)` で照合する（タイミングセーフな照合はアダプター実装の責務）。不一致は `ValidationError("INVALID_CREDENTIALS")`
5. `userId` を返す

### エラーケース

| 条件 | エラー |
|---|---|
| メール未登録 / SSO ユーザー / パスワード不一致 / 入力形式不正 | `ValidationError("INVALID_CREDENTIALS")`（すべて同一メッセージ。どれが原因かを明かさない） |
| DB 例外・照合計算失敗 | `SystemError` |

## logout

### 概要

ログアウトする（S-AC-04）。セッションの破棄はアダプター（presentation 層のセッション管理）の責務であり、identity ドメインにはログアウトに対応する状態・イベントが存在しない。

本ユースケースはアプリケーション層の公開面を揃えるための入口であり、ドメイン操作・永続化を行わない（実装上は presentation 層のセッション破棄処理のみで完結してよい。その場合は本ユースケースを設けない判断も許容する）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |

### 出力DTO

なし（`void`）。

### 処理フロー

1. ドメイン操作なし。呼び出し後、presentation 層がセッションを破棄する

### エラーケース

なし（セッション破棄の失敗はアダプター層で `SystemError` として扱う）。

## requestPasswordReset

### 概要

パスワードリセットを依頼する（S-AC-07）。リセットトークンを発行しメールを送る。登録有無・認証方式を応答から明かさない: 未登録メール、および SSO ユーザーのメールに対してはトークンを発行せずメールも送らないが、応答は常に「登録されていれば送信された」旨のみとする。

公開面: ★ 人間UI専用（未ログインでアクセス可能）

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| email | `string` | required | `Email.create` |

### 出力DTO

なし（`void`）。成功・未登録・SSO ユーザーのいずれでも同一の成功応答とする。

### 処理フロー

1. `container.clock.now()` で `now` を解決し、`Email.create(input.email)` で値オブジェクトを構築する
2. `UserRepository.findByEmail(email)` で検索する（読み取りのみ。UoW 不要）
3. 不在、または `authMethod: "sso"` のユーザーの場合は何もせず正常終了する（未登録メールと同じ扱い）
4. `PasswordUser` なら `PasswordResetTokenPort.issue(user.id, now)` でリセットトークンを発行する
5. `MailSender.sendPasswordResetMail(email, resetToken)` でリセットメールを送る（リセット URL の組み立てはアダプターの責務）

### エラーケース

| 条件 | エラー |
|---|---|
| メール形式不正 | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` |
| トークンストア障害・送信基盤障害 | `SystemError`（ただし宛先の実在性に起因する失敗を応答に反映してはならない） |
| メール未登録 / SSO ユーザー | エラーにしない（正常応答。登録有無を明かさない） |

## executePasswordReset

### 概要

リセットトークンを検証・消費し、新しいパスワードを設定する（S-AC-07）。

公開面: ★ 人間UI専用（未ログインでアクセス可能。トークンが本人確認を担う）

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| token | `string` | required | 非空（形式検証は `PasswordResetTokenPort` の責務。不透明文字列として扱う） |
| newPassword | `string` | required | `PlainPassword.create`（8文字以上128文字以下） |

### 出力DTO

なし（`void`）。再ログインは UI 側の導線で行う。

### 処理フロー

1. `now` を解決し、`PlainPassword.create(input.newPassword)` で値オブジェクトを構築する（トークン消費前に検証し、要件違反でトークンを浪費しない）
2. `PasswordResetTokenPort.verifyAndConsume(input.token, now)` でトークンを検証・消費する。`null` なら `ValidationError("RESET_TOKEN_INVALID")`（期限切れ・使用済み・改ざんを区別しない。UI は再送導線を示す）
3. `container.passwordHasher.hash(newPlainPassword)` で新しい `PasswordHash` を得る
4. `unitOfWorkProvider.run` 内:
   1. `UserRepository.findById(userId)` で取得する。不在なら `NotFoundError("USER_NOT_FOUND")`
   2. 取得結果が `SsoUser` の場合は防衛的に `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)`（requestPasswordReset が SSO ユーザーにトークンを発行しないため、正常運用では到達しない）
   3. `User.changePassword(user, newPasswordHash, now)` で更新後エンティティとイベントドラフト（`identity.passwordChanged`）を得る
   4. `UserRepository.save(user, expectedVersion)`
   5. `collectEvents(eventDrafts)`

### エラーケース

| 条件 | エラー |
|---|---|
| パスワード要件違反 | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` |
| トークン無効・期限切れ・使用済み | `ValidationError("RESET_TOKEN_INVALID")` |
| トークンが指すユーザーが不在 | `NotFoundError("USER_NOT_FOUND")` |
| 対象が SSO ユーザー（防衛的） | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ハッシュ計算失敗・トークンストア障害・DB 例外 | `SystemError` |

## changePassword

### 概要

ログイン中のユーザーが現在のパスワードを照合したうえで新しいパスワードに変更する（S-AC-07）。`PasswordUser` のみ可能（SSO のみのユーザーには UI 上パスワード変更の項目自体を表示しない。表示判定は getCurrentUser の `authMethod` を用いる）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |
| currentPassword | `string` | required | `PlainPassword.create` |
| newPassword | `string` | required | `PlainPassword.create` |

### 出力DTO

なし（`void`）。

### 処理フロー

1. `now` を解決し、`PlainPassword.create` で `currentPassword` / `newPassword` の値オブジェクトを構築する
2. `UserRepository.findById(userId)` で取得する。不在なら `NotFoundError("USER_NOT_FOUND")`
3. `authMethod: "sso"` の場合は `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)`
4. `container.passwordHasher.verify(currentPlainPassword, user.passwordHash)` で現在パスワードを照合する。不一致は `ValidationError("CURRENT_PASSWORD_MISMATCH")`
5. `container.passwordHasher.hash(newPlainPassword)` で新しい `PasswordHash` を得る
6. `unitOfWorkProvider.run` 内:
   1. `User.changePassword(user, newPasswordHash, now)` で更新後エンティティとイベントドラフト（`identity.passwordChanged`）を得る
   2. `UserRepository.save(user, expectedVersion)`
   3. `collectEvents(eventDrafts)`

### エラーケース

| 条件 | エラー |
|---|---|
| パスワード要件違反（新パスワード） | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` |
| ユーザー不在 | `NotFoundError("USER_NOT_FOUND")` |
| SSO ユーザー | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` |
| 現在パスワード不一致 | `ValidationError("CURRENT_PASSWORD_MISMATCH")` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ハッシュ計算失敗・DB 例外 | `SystemError` |

## approveAiClientAuthorization

### 概要

OAuth 認可画面で「許可する」が押されたとき、AI クライアントへの認可の事実として `AiClientConnection` を作成する（S-AC-05）。

認可リクエストの検証（改ざん・期限切れ・PKCE）、認可コード・トークンの発行、クライアントへのリダイレクトはすべてアダプターの責務。不正な認可リクエストは本ユースケースに到達する前にアダプターで弾かれる。本ユースケースが担うのは「認可の事実の記録」のみである。

公開面: ★ 人間UI専用（認可画面はログイン済みの人間が操作する）

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |
| clientName | `string` | required | `ClientName.create`（trim 後に非空、100文字以下。認可リクエスト由来の外部入力） |

### 出力DTO

| フィールド | 型 |
|---|---|
| connectionId | `string` |

アダプターは本出力の `connectionId` に紐づけてトークンを発行する。

### 処理フロー

1. `now` / 新規 ID を解決し、`UserId.create(input.userId)` / `ClientName.create(input.clientName)` で値オブジェクトを構築する
2. `AiClientConnection.create({ id, userId, clientName }, now)` で `ActiveAiClientConnection` とイベントドラフト（`identity.aiClientConnected`）を得る
3. `unitOfWorkProvider.run` 内:
   1. `AiClientConnectionRepository.insert(connection)`
   2. `collectEvents(eventDrafts)`
4. `connectionId` を返す

### エラーケース

| 条件 | エラー |
|---|---|
| クライアント名不正（空・100文字超） | `BusinessRuleError`（`ClientName` の生成時バリデーション） |
| DB 例外 | `SystemError` |

## denyAiClientAuthorization

### 概要

OAuth 認可画面で「拒否する」が押されたときの処理（S-AC-05 異常系）。接続エンティティは一切作らず、拒否の事実はドメインに残さない。プロトコル上の拒否応答（クライアントへのエラーリダイレクト）はアダプターの責務。

本ユースケースはドメイン操作・永続化を行わない。承認（approve）と対になる公開面をアプリケーション層に揃えるための入口であり、実装上は presentation 層の拒否応答のみで完結してよい（その場合は本ユースケースを設けない判断も許容する）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |

### 出力DTO

なし（`void`）。呼び出し後、アダプターがプロトコル上の拒否応答を返す。

### 処理フロー

1. ドメイン操作なし。接続エンティティを作らないことを保証する（何も永続化しない）

### エラーケース

なし。

## listAiClientConnections

### 概要

ユーザーの AI クライアント接続の一覧を返す（S-AC-06）。設定画面の「接続済みAIクライアント」表示に使う。失効済み接続も事実として返す（一覧に出すかは UI の判断）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |

### 出力DTO

| フィールド | 型 |
|---|---|
| connections | `AiClientConnectionView[]` |

`AiClientConnectionView`:

| フィールド | 型 |
|---|---|
| connectionId | `string` |
| clientName | `string` |
| status | `"active" \| "revoked"` |
| connectedAt | `Date` |
| lastUsedAt | `Date \| null` |
| revokedAt | `Date \| null`（`status: "revoked"` のときのみ非 null） |

### 処理フロー

1. `UserId.create(input.userId)` で値オブジェクトを構築する
2. `AiClientConnectionRepository.listByUserId(userId)` で接続一覧を取得する（connectedAt 降順。読み取りのみ。UoW 不要）
3. view に射影して返す（0件は空配列。エラーではない）

### エラーケース

| 条件 | エラー |
|---|---|
| DB 例外 | `SystemError` |

## revokeAiClientConnection

### 概要

AI クライアント接続を失効させる（S-AC-06）。以後そのクライアントのトークンは認可エラーになる。失効は不可逆で、再利用には新しい認可フロー（S-AC-05）が必要。

トークンストアからの実トークン削除等の失効反映はアダプターの責務であり、`identity.aiClientRevoked` イベントの consumer として実行される。本ユースケースは失効状態の記録のみを担う。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |
| connectionId | `string` | required | `AiClientConnectionId.create`（非空。設定画面からの**外部入力**） |

### 出力DTO

なし（`void`）。

### 処理フロー

1. `now` を解決し、`UserId.create(input.userId)` / `AiClientConnectionId.create(input.connectionId)` で値オブジェクトを構築する
2. `unitOfWorkProvider.run` 内:
   1. `AiClientConnectionRepository.findById(userId, connectionId)` で取得する（userId スコープ付き。他ユーザー所有・不在は null で返る = テナント分離の構造的保証。ユースケース側の `connection.userId` 照合は不要）。null なら `NotFoundError("CONNECTION_NOT_FOUND")`
   2. `status: "revoked"` の場合は何もせず正常終了する（冪等。既に失効済み）
   3. `AiClientConnection.revoke(connection, now)` で `RevokedAiClientConnection` とイベントドラフト（`identity.aiClientRevoked`）を得る
   4. `AiClientConnectionRepository.save(connection, expectedVersion)`
   5. `collectEvents(eventDrafts)`

### エラーケース

| 条件 | エラー |
|---|---|
| 接続不在・他ユーザー所有（区別しない） | `NotFoundError("CONNECTION_NOT_FOUND")` |
| OCC 不一致（例: 一覧画面からの二重解除操作の競合） | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 例外 | `SystemError` |

## changeTrashRetentionDays

### 概要

ゴミ箱の保持日数を変更する（S-ST-01）。変更後の値は以後のソフトデリート項目と既にゴミ箱にある項目の両方に適用される（適用は trash ドメインが保持期限計算時に本設定を参照することで実現する）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |
| retentionDays | `number` | required | `TrashRetentionDays.create`（1以上の整数） |

### 出力DTO

なし（`void`）。

### 処理フロー

1. `now` を解決し、`UserId.create(input.userId)` / `TrashRetentionDays.create(input.retentionDays)` で値オブジェクトを構築する
2. `unitOfWorkProvider.run` 内:
   1. `UserRepository.findById(userId)` で取得する。不在なら `NotFoundError("USER_NOT_FOUND")`
   2. `User.changeTrashRetentionDays(user, retentionDays, now)` で更新後エンティティとイベントドラフト（`identity.trashRetentionChanged`）を得る
   3. `UserRepository.save(user, expectedVersion)`
   4. `collectEvents(eventDrafts)`

### エラーケース

| 条件 | エラー |
|---|---|
| 許容範囲外の値（0以下・非整数） | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` |
| ユーザー不在 | `NotFoundError("USER_NOT_FOUND")` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 例外 | `SystemError` |

## getCurrentUser

### 概要

現在のユーザー情報を読み取る（設定画面 P-13 の表示用）。`authMethod` はパスワード変更 UI の表示判定（SSO のみのユーザーには非表示。S-AC-07 エッジケース）に使う。資格情報（`passwordHash`）や SSO 主体 ID は含めない。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |

### 出力DTO

| フィールド | 型 |
|---|---|
| userId | `string` |
| email | `string` |
| authMethod | `"password" \| "sso"`（User の直和タグから導出） |
| trashRetentionDays | `number` |

### 処理フロー

1. `UserId.create(input.userId)` で値オブジェクトを構築する
2. `UserRepository.findById(userId)` で取得する（読み取りのみ。UoW 不要）。不在なら `NotFoundError("USER_NOT_FOUND")`
3. view に射影して返す（`authMethod` は判別可能ユニオンのタグをそのまま用いる）

### エラーケース

| 条件 | エラー |
|---|---|
| ユーザー不在（セッションはあるがユーザーが消えている等） | `NotFoundError("USER_NOT_FOUND")` |
| DB 例外 | `SystemError` |
