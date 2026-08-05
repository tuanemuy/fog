# ユースケース設計: identity

[domains/identity.md](../domains/identity.md) のユースケース概要を詳細化する。

共通事項:

- **公開面**: identity のユースケースは**すべて人間UI（★）専用**である。human スコープのみに配線し、AI 側の presentation（MCP / REST API）には存在させない（AI クライアントが自分の認可を操作することはない）
- **セッション・OAuth プロトコルの責務分界**: セッションの生成・破棄・Cookie 管理、OAuth 2.1 のプロトコル詳細（認可コード、PKCE、トークン発行・検証・失効反映、リダイレクト）はすべて**アダプター/presentation 層の責務**。ユースケースは「認可の事実の記録」「認証情報の照合」などドメイン操作のオーケストレーションに限定する
- 各ユースケースは `ServiceArgs<TInput>` で `container`（`clock` / `idGenerator` / `unitOfWorkProvider` / 各ポート）と `input` を受け取る。`now` / 新規 `id` はユースケース冒頭で解決し、ドメイン内では生成しない
- 書き込みは `UnitOfWorkProvider.run` 内の**同期**コールバックで行う（`await` を挟めない）。**(1) 業務データの書き込み、(2) FTS5 projection の更新、(3) `enqueueEvent` によるイベント行の追加、の3つを同じ `transactionSync` の中で一度に確定できる**（rollback すると3つとも巻き戻る。[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。**イベントを発行するユースケースの全数は [async/index.md](../async/index.md) が持つ** — identity では `requestPasswordReset` の1つだけである。認証情報側（Identity Directory）とユーザー単位設定側（User Data DO）の両方に書く操作は、単一のトランザクションに収まらないので順序と再開の規則を持つ手続きとして各ユースケースに書く
- エラー種別の使い分け: 入力・照合の失敗は `ValidationError`、対象不在は `NotFoundError`、一意性・OCC 競合は `ConflictError`、ドメイン規則違反（値オブジェクト生成失敗を含む）は `BusinessRuleError<IdentityErrorCode>`、基盤障害は `SystemError`
- `input` の `userId` はセッション由来の信頼済み ID（presentation 層が認証済みセッションから注入する）。外部入力として受けるのは `connectionId`（revokeAiClientConnection）等の明示したフィールドのみ。**リセット完了画面（pages P-03）から呼ぶものも例外ではない** — `executePasswordReset` は完走時に新しいセッションを確立するので（後述）、完了画面は認証済みの画面であり、そこから呼ぶ `getCurrentUser` / `listAiClientConnections` / `unlinkSsoCredential` / `revokeAllAiClientConnections` の `userId` もそのセッション由来である
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
4. **認証情報側**でメールの予約を取る（`CredentialMappingRepository.findByEmail(email)` で重複を検証し、`reserveCredential` で予約行を書く）。既に使われていれば `ConflictError("EMAIL_ALREADY_REGISTERED")`
5. 予約に勝った場合だけ、**ユーザー単位設定側**の `unitOfWorkProvider.run` 内で初期化する:
   1. `User.registerWithPassword({ id, credential }, now)` で `User` を得る（`credential` は採番済みの `credentialId` と `kind: "email"`、`usableForLogin: true` の要約）
   2. `UserSettingsRepository.insert(user)` で永続化する
6. 認証情報側の予約を確定させ、パスワードの検証材料を記録する（`activateReservation`）
7. **ユーザー単位設定側**で保有クレデンシャルの逆引きを記録する（`CredentialLocatorStore.record`。`usableForLogin` / `label` は認証情報側が判定した値を写す）。**この記録が済むまでログインは通らない** — ログインの到達性検査がこのストアを読むためである
8. `userId` を返す

**手順4〜7は2つの物理境界をまたぐので、単一のトランザクションには収まらない。** 途中で落ちた場合は前進させる仕組みが引き取る。**利用者から観測できるのは次の2点だけである** — 中間状態のあいだはそのメールで登録もログインもできず、前進不能が確定した場合は一様な終端（記録を残して運用へエスカレーションする）に落ちる。**終端の具体的な手順は [#45](https://github.com/tuanemuy/fog/issues/45) が定める**

### エラーケース

| 条件 | エラー |
|---|---|
| メール形式不正 | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` |
| パスワード要件違反 | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` |
| メール登録済み（事前検証。SSO ユーザーとの重複含む） | `ConflictError("EMAIL_ALREADY_REGISTERED")` |
| 同時登録レース（認証情報側の予約獲得に敗北） | `ConflictError("EMAIL_ALREADY_REGISTERED")` |
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
2. **認証情報側**で `CredentialMappingRepository.findBySsoIdentity(provider, providerSubject)` により既存アカウントを検索する。存在すればその `userId` と `isNewUser: false` を返す（ログイン。書き込みなし）
3. 不在なら **SSO 主体とメールの両方**に予約を取る（`CredentialMappingRepository.findByEmail(email)` でメール重複も検証し、`reserveCredential` を2本走らせる）。**メールの一意性は SSO 登録にも掛かる**。どちらかが既に使われていれば `ConflictError("EMAIL_ALREADY_REGISTERED")` / `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`（自動リンクしない。UI はパスワードログインへの導線を示す）
4. 両方の予約に勝った場合だけ、**ユーザー単位設定側**の `unitOfWorkProvider.run` 内で初期化する:
   1. `User.registerWithSso({ id, credentials }, now)` で `User` を得る（`credentials` は `kind: "sso"`（`usableForLogin: true`）と `kind: "email"`（**`usableForLogin: false`**。一意性の予約としてだけ置かれ、パスワードの検証材料を持たない）の2件の要約）
   2. `UserSettingsRepository.insert(user)`
5. 認証情報側の予約を確定させる（`activateReservation`）
6. **ユーザー単位設定側**で2件の逆引きを記録する（`CredentialLocatorStore.record`。`usableForLogin` は認証情報側の判定をそのまま写すので、メール側は偽になる）
7. `userId` と `isNewUser: true` を返す

**registerWithPassword と同じく2つの物理境界をまたぐ。** 中間状態と終端についての保証も同じである

### エラーケース

| 条件 | エラー |
|---|---|
| 未対応プロバイダ | `BusinessRuleError(IdentityErrorCode.UnsupportedSsoProvider)` |
| メール形式不正 | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` |
| 既存パスワードユーザーとメール一致 | `ConflictError("EMAIL_ALREADY_REGISTERED")` |
| 同時初回サインインのレース（認証情報側の予約獲得に敗北） | `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` |
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
2. **認証情報側**で `CredentialMappingRepository.findByEmail(email)` により対象クレデンシャルを解決する（読み取りのみ）
3. 不在、またはパスワードの検証材料を持たない（SSO 専用アカウントのメールクレデンシャル）場合は `ValidationError("INVALID_CREDENTIALS")`。**ここで応答を早めない** — 存在しない場合もダミーの検証材料で同じ計算量を通し、登録有無を計算時間から推測できないようにする
4. `container.passwordHasher.verify(plainPassword, verifier)` で照合する（タイミングセーフな照合はアダプター実装の責務。**計算は Durable Object の外で行う** — 単一スレッドの DO を長く占有させないため）。不一致は `ValidationError("INVALID_CREDENTIALS")`
5. **到達可能性を検査する**: `CredentialLocatorStore.findByCredentialId(credentialId)` で対象ユーザー側に行があることと、その `credentialVersion` が認証情報側の値と一致することを確認する。**照合は `credentialId` だけを見て写像材料の世代を含めない**（domains/identity.md）。行が無い・`credentialVersion` が食い違う場合は `ValidationError("INVALID_CREDENTIALS")`（片方だけが残った中間状態でログインを通さない）
6. `userId` を返す

### エラーケース

| 条件 | エラー |
|---|---|
| メール未登録 / SSO ユーザー / パスワード不一致 / 入力形式不正 | `ValidationError("INVALID_CREDENTIALS")`（すべて同一メッセージ。どれが原因かを明かさない） |
| DB 例外・照合計算失敗 | `SystemError` |

## logout

### 概要

ログアウトする（S-AC-04）。セッションの破棄はアダプター（presentation 層のセッション管理）の責務であり、identity ドメインにはログアウトに対応する状態遷移が存在しない。

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

パスワードリセットを依頼する（S-AC-07）。リセットトークンを発行し、**リセットメールの配送を Outbox のイベントとして登録する**（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)。実際の送信は Alarm relay → Queue → mail consumer を経る。契約は [async/index.md](../async/index.md)）。登録有無・認証方式を応答から明かさない。**「送らない」は「何も書かない」ではない** — 未登録メールと SSO 専用アカウント（メールのクレデンシャルがログイン手段になっていない）に対してはトークンを発行せずメールも送らないが、**処理経路は登録済みの場合と完全に一致させる**（後述の処理フロー3。**一致が測定できる対象は処理フロー4 に挙げた4つ**であり、トークン発行の差だけは残存する）。応答は常に「登録されていれば送信された」旨のみとする。**依頼の応答は配送の成否を待たない**（配送は結果整合・at-least-once）。

公開面: ★ 人間UI専用（未ログインでアクセス可能）

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| email | `string` | required | `Email.create` |

### 出力DTO

なし（`void`）。成功・未登録・SSO ユーザーのいずれでも同一の成功応答とする。

### 処理フロー

1. `container.clock.now()` で `now` を解決し、`Email.create(input.email)` で値オブジェクトを構築する
2. **認証情報側**で `CredentialMappingRepository.findByEmail(email)` により対象クレデンシャルを解決する
3. **イベントを発行するか否かは、スロットル窓の状態だけで決める。** 窓のキー（`windowKey`）は**対象 canonical の全長 HMAC と依頼の窓から決定的に導く**（`jobs.operation_key` と同じ導出。**クライアントから受け取らない**）。窓の状態は Identity Directory DO の `reset_request_windows`（UoW コンテキストの `resetThrottleStore`。ドメイン側の契約は `PasswordResetThrottlePort`）が持ち、**判定と計上は `claimWindow(windowKey, now)` の1回の呼び出しで原子的に行われる** — その窓の最初の依頼なら行を作って `true`、既存の窓なら `last_requested_at` だけを更新して `false` を返す。**窓行は登録の有無に関係なく必ず書く**（行の有無が観測可能な差にならないことが、この窓ストアを置いた理由そのものである）。読み取りと計上、イベント行の追加、ジョブの投入はすべて**同じ `transactionSync`** の中で行う
4. **同じ窓の状態に対して、登録済み / 未登録 / SSO 専用 / スロットル中の4ケースは一様に落ちる。** その窓での**最初の依頼なら4ケースとも必ずちょうど1行**（0行でも2行でもない）イベント行を書き、**既に発行済みの窓なら4ケースとも1行も書かない。** どちらでも同じ起床を張り、同じ応答を返す。**分岐の材料は `claimWindow` の戻り値だけであり、（イベント行と窓行の書き込みについて）クレデンシャルの登録有無・認証方式・宛先の存在を一切参照しない** — 参照すると行の書き込みそのものが測定可能な差になり、登録済みメールの列挙オラクルになる
   - **射程の外にある差は残存する。** トークンの発行だけは検証材料の有無で分岐するので、送る側だけが `password_reset_tokens` への発行と未使用行の全削除を追加で行う。**測定可能な等価性の対象は `outbox_events` の行数 / `reset_request_windows` の行数 / Alarm の起床の有無 / `sweep-reset-tokens` の投入の有無の4つである**（「総書き込み行数」では測らない。[testcases/identity/requestPasswordReset.md](../testcases/identity/requestPasswordReset.md) と同じ4つ）
   - **注記: 4ケースは互いに素な分割ではない。** 4ケース目の「スロットル中」は**窓が消費済みである状態**そのものを指し、クレデンシャルの3状態（登録済み / 未登録 / SSO 専用）と直交しない — 実際の分割は**クレデンシャル3状態 × 窓2状態**である。上の一様性は**窓の状態を固定したうえでの命題**として読む（「スロットル中でありながらその窓での最初の依頼」という組は存在しない）
5. **`claimWindow` が `true` を返した場合だけ、トークンを発行しイベント行を書く。**
   - 送る側に倒すのは「パスワードの検証材料を持つクレデンシャル」がある場合だけである。**判定は「クレデンシャル行の有無」ではなく「検証材料の有無」で行う** — SSO 登録でもメールのクレデンシャル行は置かれるので、行の有無では決まらない
   - 送る側では `PasswordResetTokenPort.issue(credentialId, now)` でリセットトークンを発行し、戻り値の `{ token, tokenId }` から **payload に載せるのは `tokenId` だけである** — 生トークン `token` はイベント行にも Queue メッセージにも載せず、送信時に DO の中で導出し直す（手順7）。**発行はそのクレデンシャル宛の未使用トークンをすべて置き換える**（古いリンクは以後効かない）。**この全置換が起きるのは窓での最初の依頼のときだけである**（後述「連打と窓」）
   - 送らない側（未登録 / SSO 専用）ではトークンを発行しないが、**イベント行の形は送る側と一字も違わない** — payload の `tokenId` は nullable にせず、**宛先の有無から独立に生成した不透明値**（トークンと同じ形・同じ長さ）を置く。形が割れると payload そのものが列挙オラクルになる
   - **その不透明値は `PasswordResetTokenPort` のデコイ採番メソッド（`mintDecoyTokenId()`）から採る。`container.idGenerator.next()` を使わない** — `IdGenerator` は UUIDv7（時刻由来）で、`token_id` の生成規則（CSPRNG 由来の不透明値。`spec/database/index.md`）と形が割れる。**4ケースで `tokenId` の生成器が同一であること**がポートの契約であり、生成器はアダプター（bucket）に閉じる（domains/identity.md「PasswordResetTokenPort」）
   - `enqueueEvent` で `identity.passwordResetRequested` の draft を1件登録する（`aggregateId` は `windowKey`。**payload は `tokenId` / メール種別の2つだけである** — **発行元 bucket の routing key は payload に入れない。** routing key は relay が publish 時に Queue メッセージへ押す項目であって、ドメイン／ユースケースの契約ではない（`EventId` と同じ扱い。[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md) の「配送機構をドメインへ出さない」）。**メールアドレス・生トークン・`userId` を載せない**。domains/identity.md「ドメインイベント」）
6. **`enqueueJob` により `sweep-reset-tokens` を投入する。投入点は「リセットトークン行または窓行を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」であり、宛先の登録有無で投入を分けない。** 窓行は4ケースすべてで書かれるので、投入も4ケースすべてで起きる — 分けると (a) 未登録アドレスだけを投げられた bucket で掃除が一度も投入されず窓行が単調増加し、(b) `enqueueJob` の有無が4ケースで割れて起床が観測可能な差になる。同ジョブは期限切れのリセットトークン行と**期限切れの窓行の両方**を掃除する（`jobs.kind` は増やさない。[async/index.md](../async/index.md) / `spec/database/index.md`）
7. 配送は Alarm relay が担う。**生のトークンはイベント行にも Queue メッセージにも載せず**、mail consumer が発行元 bucket へ打つ**送信材料 RPC** の中（= DO の中）で `tokenId` から導出する。consumer は応答が `send` のときだけ `MailSender.sendPasswordResetMail(to, resetToken, providerIdempotencyKey)` を呼び（`providerIdempotencyKey` は `event.id` から導く。**ユースケースはこのポートを呼ばない** — 呼ぶのは consumer である）、`nothing-to-send` なら no-op して ack する（[async/index.md](../async/index.md)）

**連打と窓.** 同一 canonical・同一窓への連打では、**2回目以降はイベント行もリセットトークンも書かない。** 収束を担うのは行の一意制約ではなく `claimWindow` の判定であり、**書き込みと起床は依頼回数ではなく時間の窓の数に比例する**（登録済みでも未登録でも同じ）。窓行のほうは窓ごとに1行で、2回目以降は同じ行への冪等な更新であり新しい行も起床も作らない。

- **発行判断と窓判定は同じ1つの分岐である**（`claimWindow` の戻り値）。2つの独立した条件ではない — 分けて「2回目でも `issue()` は呼ぶ」にすると、**1通目が未送信なら送信時の再読が `nothing-to-send` に落ちて0通になり、1通目が送信済みなら利用者の手元のリンクが死ぬ**
- したがって**同一窓への連打で届くのは「現在有効なトークンのリンク1通」である**（0通でも2通でもない）。**1通目のリンクは2回目の依頼後も有効なままである**
- **supersede が生じるのは窓をまたいだときだけである。** 新しい窓の最初の依頼が未使用トークンを全置換するので、窓をまたいで積まれた古いイベント行は送信材料 RPC が `nothing-to-send` を返して no-op になる

### エラーケース

| 条件 | エラー |
|---|---|
| メール形式不正 | `BusinessRuleError(IdentityErrorCode.InvalidEmail)` |
| トークンストア・窓ストア障害 | `SystemError`（ただし宛先の実在性に起因する失敗を応答に反映してはならない） |
| メール未登録 / SSO 専用アカウント / スロットル中 | エラーにしない（正常応答。登録有無も認証方式も明かさない） |
| 送信基盤の失敗 | **依頼の応答には現れない**（配送はトランザクションの外で結果整合に行われ、失敗は Queue の retry → DLQ が扱う。async/index.md） |

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

| フィールド | 型 |
|---|---|
| userId | `string` |

**セッションの確立は presentation 層が本出力の `userId` を用いて行う**（`loginWithPassword` と同じ扱い）。**確立は手順6-1 の世代前進より後なので、新しく張られたセッションだけが生き残る** — 侵害者が握っていた旧セッションは失効済みである。**完了画面（pages P-03）の必須導線はこのセッションの上で動くので、再ログインを挟まない。**

### 処理フロー

1. `now` を解決し、`PlainPassword.create(input.newPassword)` で値オブジェクトを構築する（トークン消費前に検証し、要件違反でトークンを浪費しない）
2. `PasswordResetTokenPort.verifyAndConsume(input.token, now)` でトークンを検証・消費する。`null` なら `ValidationError("RESET_TOKEN_INVALID")`（期限切れ・使用済み・改ざんを区別しない。UI は再送導線を示す）
3. `container.passwordHasher.hash(newPlainPassword)` で新しい `PasswordHash` を得る
4. 対象クレデンシャルがパスワードの検証材料を持たない場合は防衛的に `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)`（requestPasswordReset が SSO 専用アカウントにトークンを発行しないため、正常運用では到達しない）
5. **認証情報側**で検証材料を新しいものへ差し替え、そのクレデンシャル宛の未使用トークンをすべて無効化する（同一トランザクション。`beginCredentialChange`）
6. **ユーザー単位設定側**で、同じトランザクションの中で次を行う:
   1. `AccountStore.advanceSessionEpoch()` で**セッションの世代を進める**（既存セッションは次のリクエストで失効する。**リセットは侵害からの復旧手順なので、侵害者のセッションをここで切る**）
   2. `CredentialLocatorStore.advanceCredentialVersion(credentialId)` で対象クレデンシャルの世代を進める（認証情報側の値と揃え、到達性検査が通り続けるようにする）
   3. `AccountStore.advanceResetVersion()` で**リセット世代を進める**。戻り値は**前進後**の値なので、失効の射程となる前進前の値はそこから導く（**`AccountStore.find()` で読み直さない** — 読み直しと前進を分けると並行実行で射程がずれる。domains/identity.md）
   4. `AiClientConnectionRepository.listByUserId()` から `status: "active"` かつ `createdAtResetVersion` が前進前の値と等しい接続を絞り、対象ごとに `findById` → `AiClientConnection.revoke` → `AiClientConnectionRepository.save` を同じトランザクションで実行する。**条件付き一括失効の専用メソッドは置かない** — 対象は前回のリセット完了以降に作られた分だけで件数が小さいためである
7. 認証情報側で新しい検証材料を正本へ昇格させる（`promoteVerifier`）
8. `userId` を返す

**手順5〜7は2つの物理境界をまたぐ。** 中間状態のあいだは旧新どちらのパスワードでもログインできず、前進不能が確定した場合は一様な終端（記録を残して運用へエスカレーションする）に落ちる。**終端の具体的な手順は [#45](https://github.com/tuanemuy/fog/issues/45) が定める。** **リセット完了に限り、前回のリセット完了以降に作られた AI クライアント接続が失効する**（通常のパスワード変更では `resetVersion` を進めないので対象が空になる。domains/identity.md）

### エラーケース

| 条件 | エラー |
|---|---|
| パスワード要件違反 | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` |
| トークン無効・期限切れ・使用済み | `ValidationError("RESET_TOKEN_INVALID")` |
| トークンが指すユーザーが不在 | `NotFoundError("USER_NOT_FOUND")` |
| 対象クレデンシャルがパスワードの検証材料を持たない（防衛的） | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| ハッシュ計算失敗・トークンストア障害・DB 例外 | `SystemError` |

## changePassword

### 概要

ログイン中のユーザーが現在のパスワードを照合したうえで新しいパスワードに変更する（S-AC-07）。**パスワードのクレデンシャルを持つアカウントのみ可能**（SSO 専用アカウントには UI 上パスワード変更の項目自体を表示しない。表示判定は getCurrentUser が返すクレデンシャル一覧の `usableForLogin` を用いる）。

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
2. **認証情報側**で対象のメールクレデンシャルと検証材料を取得する。パスワードの検証材料を持たなければ `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)`
3. `container.passwordHasher.verify(currentPlainPassword, verifier)` で現在パスワードを照合する（計算は Durable Object の外）。不一致は `ValidationError("CURRENT_PASSWORD_MISMATCH")`。**照合の失敗はログイン失敗と同じ回数カウンタ（`failedAttempts` と `nextAttemptAllowedAt`）を進める**（認証済み経路でも総当たりの足場にさせない）。**試行が制限されている間は検証材料を渡さず、明示的に拒否する**（未認証のログイン経路と違い、認証済み経路では制限中であることを隠さない）
4. `container.passwordHasher.hash(newPlainPassword)` で新しい `PasswordHash` を得る
5. **認証情報側**で検証材料を差し替え、そのクレデンシャル宛の未使用トークンをすべて無効化する（同一トランザクション。`beginCredentialChange`）
6. **ユーザー単位設定側**で、同じトランザクションの中で `AccountStore.advanceSessionEpoch()` により**セッションの世代を進め**、`CredentialLocatorStore.advanceCredentialVersion(credentialId)` で対象クレデンシャルの世代を進める（既存セッションは次のリクエストで失効する）
7. 認証情報側で新しい検証材料を正本へ昇格させる（`promoteVerifier`）

**手順5〜7は2つの物理境界をまたぐ。** 中間状態のあいだは旧新どちらのパスワードでもログインできず、前進不能が確定した場合は一様な終端（記録を残して運用へエスカレーションする）に落ちる。**終端の具体的な手順は [#45](https://github.com/tuanemuy/fog/issues/45) が定める。** **`resetVersion` は進めず、AI クライアント接続も失効しない**（パスワードの変更が連携の取り消し意思を意味しないため。domains/identity.md）

### エラーケース

| 条件 | エラー |
|---|---|
| パスワード要件違反（新パスワード） | `BusinessRuleError(IdentityErrorCode.PasswordTooWeak)` |
| ユーザー不在 | `NotFoundError("USER_NOT_FOUND")` |
| 対象クレデンシャルがパスワードの検証材料を持たない（SSO 専用アカウント） | `BusinessRuleError(IdentityErrorCode.PasswordNotSupported)` |
| 現在パスワード不一致 | `ValidationError("CURRENT_PASSWORD_MISMATCH")` |
| 試行が制限されている（`nextAttemptAllowedAt` が未到達） | `ValidationError("TOO_MANY_ATTEMPTS")`（**未認証のログイン経路と違い、制限中であることを隠さない** — 画面に「試行が制限されている」を出せる必要がある） |
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
2. `unitOfWorkProvider.run` 内で `AccountStore.find()` から現在の `resetVersion` を読み、`AiClientConnection.create({ id, userId, clientName, createdAtResetVersion }, now)` で `ActiveAiClientConnection` を得る。**作成時点のリセット世代を接続に写す**（リセット完了時の自動失効の射程を決める材料である。domains/identity.md）
3. 同じトランザクションで `AiClientConnectionRepository.insert(connection)`
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

ユーザーの AI クライアント接続の一覧を返す（S-AC-06）。設定画面（pages P-13）の「接続済みAIクライアント」表示と、**リセット完了画面（pages P-03）の必須導線の接続一覧**に使う。失効済み接続も事実として返す（一覧に出すかは UI の判断）。

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
2. `AiClientConnectionRepository.listByUserId()` で接続一覧を取得する（connectedAt 降順。読み取りのみ。UoW 不要）
3. view に射影して返す（0件は空配列。エラーではない）

### エラーケース

| 条件 | エラー |
|---|---|
| DB 例外 | `SystemError` |

## revokeAiClientConnection

### 概要

AI クライアント接続を失効させる（S-AC-06）。以後そのクライアントのトークンは認可エラーになる。失効は不可逆で、再利用には新しい認可フロー（S-AC-05）が必要。

**失効の権威は `ai_client_connections.status` そのものである。** 失効を別ストアへ伝播させる経路は持たず、**次のリクエストで対象 Durable Object 内のガードが直接読んで拒否する**。本ユースケースは失効状態の記録のみを担う。

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
   1. `AiClientConnectionRepository.findById(connectionId)` で取得する（自分の Durable Object の中だけを引くので、他ユーザーの接続 ID は不在として null で返る = 到達可能性による構造的保証。ユースケース側の `connection.userId` 照合は不要）。null なら `NotFoundError("CONNECTION_NOT_FOUND")`
   2. `status: "revoked"` の場合は何もせず正常終了する（冪等。既に失効済み）
   3. `AiClientConnection.revoke(connection, now)` で `RevokedAiClientConnection` を得る
   4. `AiClientConnectionRepository.save(connection, expectedVersion)`

### エラーケース

| 条件 | エラー |
|---|---|
| 接続不在・他ユーザー所有（区別しない） | `NotFoundError("CONNECTION_NOT_FOUND")` |
| OCC 不一致（例: 一覧画面からの二重解除操作の競合） | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 例外 | `SystemError` |

## revokeAllAiClientConnections

### 概要

active な AI クライアント接続をすべて失効させる。**リセット完了画面の必須導線**であり（pages P-03）、自動失効が切らない接続（前回のリセット完了より前に持ち込まれたもの）を利用者の判断で切るための操作である。**呼び元は P-03 だけである** — 設定画面（P-13）は接続の単体解除しか持たない。

`revokeAiClientConnection` を一覧の全件へ適用した形だが、**部分失敗の扱いを持つ**ので独立したユースケースとして定義する（`emptyTrash` と同じ構成である）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |

### 出力DTO

| フィールド | 型 |
|---|---|
| revokedCount | `number`（このリクエストで失効させた件数） |
| failedCount | `number`（競合等で失効できず、再実行に委ねた件数） |

### 処理フロー

1. `now` を解決し、`UserId.create(input.userId)` で値オブジェクトを構築する
2. `AiClientConnectionRepository.listByUserId()` で接続一覧を取得し、`status: "active"` のものだけを対象にする
3. 対象ごとに `unitOfWorkProvider.run` で `findById` → `AiClientConnection.revoke` → `save` を実行する。**既に `revoked` のものは no-op として数えない**（冪等）
4. 1 件の失敗（OCC 競合等）は記録（logger）して次へ進み、全体は中断しない。残件は再実行で消化できる（既に失効した接続は対象に現れない）

**接続が0件でもエラーにせず `revokedCount: 0` を返す。**

### エラーケース

| 条件 | エラー |
|---|---|
| 個別接続の OCC 不一致 | `ConflictError`（記録して続行。全体は中断しない） |
| DB 例外（一覧取得の失敗） | `SystemError` |

## linkSsoCredential

### 概要

ログイン中のユーザーが自分のアカウントに SSO 連携を追加する（S-AC-02 エッジケース。pages P-13）。**追加できるのは `kind: "sso"` の要素だけである** — メールクレデンシャルを追加する経路は存在しない（domains/identity.md の不変条件）。

IdP との認証フロー（リダイレクト・アサーション検証）は `registerOrLoginWithSso` と同じくアダプターの責務であり、本ユースケースは検証済みの IdP 主体情報を受け取ってからのドメイン操作のみを担う。

**SSO 初回サインイン時の自動リンクとは別物である。** 自動リンク（IdP のメールが既存アカウントと一致したときに黙って紐づける）は行わない（`registerOrLoginWithSso`）。本ユースケースは利用者が設定画面から明示的に開始する操作であり、**`unlinkSsoCredential` が解除する対象を作る唯一の経路**でもある。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |
| provider | `string` | required | `SsoProvider` のいずれか（`"google" \| "apple"`） |
| providerSubject | `string` | required | 非空（IdP の `sub`。アダプターが検証済み） |

**メールアドレスは受け取らない。** 連携が確保するのは SSO 主体の一意性だけで、メールの一意性には触れない（触ると連携先アカウント自身のメール予約と衝突する）。

### 出力DTO

| フィールド | 型 |
|---|---|
| credentialId | `string` |

### 処理フロー

1. `now` と新規 `credentialId` を解決し、`UserId.create(input.userId)` / `SsoProvider` を構築する
2. **ユーザー単位設定側**の `unitOfWorkProvider.run` 内で手続きを開始する:
   1. `UserSettingsRepository.find()` で `User` を取得する。不在なら `NotFoundError("USER_NOT_FOUND")`
   2. `recordOperation` で手続きを記録し、連携先を特定する写像材料を控える。**同じトランザクションで `enqueueJob` により `resume-link` を投入する** — 途中で落ちたときに手続きの存在を知っているのはこの記録だけなので、**これが前進の唯一の投入点である**
3. **認証情報側**で SSO 主体の予約を取る（`reserveCredential`）。既に使われていれば `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")`（**自分のアカウントで連携済みの場合も同じ**。連携は重複を拒否する）
4. 認証情報側の予約を確定させる（`activateReservation`）
5. **ユーザー単位設定側**の `unitOfWorkProvider.run` 内で、同じトランザクションで次を行う:
   1. `User.addCredential(user, credential, now)` → `UserSettingsRepository.save(user, expectedVersion)`（`credential` は採番済みの `credentialId` と `kind: "sso"`、`usableForLogin: true`、`label` は provider 名）
   2. `CredentialLocatorStore.record(locator)` で逆引きを記録する。**この記録が済むまでその SSO ではログインできない** — ログインの到達性検査がこのストアを読むためである
   3. `updateOperation` で手続きの記録を完了にする
6. `credentialId` を返す

**`sessionEpoch` は進めない。** 連携は認証手段を増やすだけで既存セッションの信頼性を下げないためである。**既存クレデンシャルの `credentialVersion` にも触れない**（credential ごとのカウンタなので、連携が他のクレデンシャルでのログインを巻き添えにしない。domains/identity.md）

**手順2〜5は2つの物理境界をまたぐので、単一のトランザクションには収まらない。** 途中で落ちた場合は前進させる仕組み（`resume-link`）が引き取る。**利用者から観測できるのは次の2点だけである** — 連携が完了するまでその SSO ではログインできず、前進不能が確定した場合は一様な終端（記録を残して運用へエスカレーションする）に落ちる。**終端の具体的な手順は [#45](https://github.com/tuanemuy/fog/issues/45) が定める**

### エラーケース

| 条件 | エラー |
|---|---|
| 未対応プロバイダ | `BusinessRuleError(IdentityErrorCode.UnsupportedSsoProvider)` |
| その SSO 主体が既に使われている（自分のアカウントを含む） | `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` |
| ユーザー不在 | `NotFoundError("USER_NOT_FOUND")` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 例外 | `SystemError` |

## unlinkSsoCredential

### 概要

SSO 連携を解除する（pages P-03 リセット完了画面 / P-13 設定画面）。**覚えの無い連携をその場で解除できる**ことが侵害からの復旧手順の一部である。

解除は不可逆で、同じ SSO 主体を再度連携するには `linkSsoCredential` をやり直す（新しい `credentialId` が採番される）。**メールクレデンシャルの解除経路は存在しない**（domains/identity.md の不変条件）。

公開面: ★ 人間UI専用

### 入力DTO

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | `string` | required | セッション由来の信頼済み ID |
| credentialId | `string` | required | `CredentialId.create`（非空。設定画面・リセット完了画面からの**外部入力**） |

### 出力DTO

なし（`void`）。

### 処理フロー

1. `now` を解決し、`UserId.create(input.userId)` / `CredentialId.create(input.credentialId)` で値オブジェクトを構築する
2. **ユーザー単位設定側**の `unitOfWorkProvider.run` 内で:
   1. `UserSettingsRepository.find()` で `User` を取得する。不在なら `NotFoundError("USER_NOT_FOUND")`
   2. **2つの検査をこの順に通す。どちらもドメイン側の権威であり、UI の出し分けには委ねない** — (i) 対象 `credentialId` の要素が存在し `kind: "sso"` であること（`kind: "email"` は `BusinessRuleError`）、(ii) 解除後も `usableForLogin` が真の要素が残ること（残らなければ `BusinessRuleError(LastCredentialRemoval)`）。**(ii) が数えるのは要素数ではなく `usableForLogin` が真である要素の `credentialId` の異なり数である**（SSO 専用アカウントのメール要素を数に入れない。domains/identity.md）
   3. `User.removeCredential(user, credentialId, now)` → `UserSettingsRepository.save(user, expectedVersion)`
   4. `CredentialLocatorStore.deleteByCredentialId(credentialId)` で逆引きを消す。**消す前に、その `credentialId` の写像材料を全世代分、`recordOperation` が書く手続きの記録へ退避する**（消した後は認証情報側の行へ辿り着けなくなる。1世代分だけ控えると回収されない世代が残る）
   5. `AccountStore.advanceSessionEpoch()` でセッションの世代を進める
   6. **同じトランザクションで `enqueueJob` により `sweep-orphan-mapping` を投入する** — 手順3 が落ちたときに認証情報側へ残る写像を回収する**唯一の投入点**であり、これが無いと孤児の写像が残り続けて同じ SSO 主体を二度と連携できなくなる
3. **認証情報側**で控えた写像材料をもとに `deleteMapping` を発行し、写像行とそのクレデンシャル宛のリセットトークン行を消す（「無ければ成功」の冪等操作）

**手順2〜3は2つの物理境界をまたぐ。** 順序はこの向きに固定する — 逆順にすると、途中で落ちたときに「ユーザー単位設定側には残っているが引けない」状態になり、次の連携で「既に使われている」と誤判定させる。**この向きなら片方向にしか壊れない** — 残った写像でログインしようとしても、手順2-4 で逆引きが消えているのでログインの到達性検査が拒否する（「解除したのにログインできる」は起きない）。**利用者から観測できるのは「解除後はその SSO でログインできない」ことだけで**、認証情報側に残った行の回収は前進させる仕組みが引き取る。前進不能が確定した場合は一様な終端（記録を残して運用へエスカレーションする）に落ちる。**終端の具体的な手順は [#45](https://github.com/tuanemuy/fog/issues/45) が定める**

### エラーケース

| 条件 | エラー |
|---|---|
| 対象クレデンシャルが不在 | `NotFoundError("CREDENTIAL_NOT_FOUND")` |
| 対象が `kind: "email"` | `BusinessRuleError`（`User.removeCredential` が `kind: "sso"` しか受けない） |
| 最後のログイン手段の解除 | `BusinessRuleError(LastCredentialRemoval)` |
| ユーザー不在 | `NotFoundError("USER_NOT_FOUND")` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
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
   1. `UserSettingsRepository.find()` で取得する。不在なら `NotFoundError("USER_NOT_FOUND")`
   2. `User.changeTrashRetentionDays(user, retentionDays, now)` で更新後エンティティを得る
   3. `UserSettingsRepository.save(user, expectedVersion)`
   4. **同じトランザクションでゴミ箱内の全項目の `purgeAfter` を再計算する** — `MemoRepository.recalculatePurgeAfter` / `TopicRepository.recalculatePurgeAfter` / `DocumentRepository.recalculatePurgeAfter` を、それぞれ残件が無くなるまで呼ぶ（domains/trash.md「保持期限」）。件数が大きく1回のトランザクションで終わらない場合は残件を残したまま抜け、続きは `purge-trash` の再計算フェーズが引き取る（**残件の置き場はカーソルではなく作業述語である** — 「`purgeAfter` が新しい保持日数から算出される値と一致しない項目」が残件そのものなので、別途カーソルを永続化しない）
   5. `TrashQueryPort.findEarliestPurgeAfter()` で新しい最も早い期限を求め、その時刻へ `purge-trash` の起床を張り直す

### エラーケース

| 条件 | エラー |
|---|---|
| 許容範囲外の値（0以下・非整数） | `BusinessRuleError(IdentityErrorCode.InvalidTrashRetentionDays)` |
| ユーザー不在 | `NotFoundError("USER_NOT_FOUND")` |
| OCC 不一致 | `ConflictError("OPTIMISTIC_LOCK_FAILURE")` |
| DB 例外 | `SystemError` |

## getCurrentUser

### 概要

現在のユーザー情報を読み取る（設定画面 pages P-13 と**リセット完了画面 pages P-03** の表示用）。**保有クレデンシャルの一覧**はパスワード変更 UI の表示判定（`usableForLogin` が真の `kind: "email"` の要素が無ければ非表示。S-AC-07 エッジケース）と SSO 連携の解除操作に使う。資格情報や SSO 主体 ID は含めない。

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
| credentials | `{ credentialId: string; kind: "email" \| "sso"; label: string; usableForLogin: boolean }[]`（保有クレデンシャルの要約。`label` は SSO なら provider 名、メールなら空文字。`usableForLogin` はその要素だけでログインできるかで、パスワード変更フォームの表示判定に使う） |
| trashRetentionDays | `number` |

### 処理フロー

1. `UserId.create(input.userId)` で値オブジェクトを構築する
2. `UserSettingsRepository.find()` でクレデンシャル要約と設定を取得する（読み取りのみ。UoW 不要）。不在なら `NotFoundError("USER_NOT_FOUND")`
3. **認証情報側**からメールアドレスの原本を1件だけ復号して取得する（本人の自己参照であり、一覧のために複数件をまとめて復号する経路は開かない）
4. view に射影して返す。**解除操作を出してよいのは `kind: "sso"` の要素だけである**（`kind: "email"` の解除経路は存在しない。権威はドメイン側にあり、UI の出し分けは二重の防波堤である）。**パスワード変更フォームの表示判定は `usableForLogin` が真の `kind: "email"` の要素があるかで行う** — SSO 専用アカウントにもメールの要素は置かれるので、`kind` だけでは決まらない

### エラーケース

| 条件 | エラー |
|---|---|
| ユーザー不在（セッションはあるがユーザーが消えている等） | `NotFoundError("USER_NOT_FOUND")` |
| DB 例外 | `SystemError` |
