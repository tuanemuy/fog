# レビュー: PR #17 — Domain / Use Case

対象レイヤー: `packages/core/src/domain/identity/` / `packages/core/src/application/identity/` / `application/errors` / `application/ports/sessionCodec.ts` / `application/execution/unitOfWork.ts` / `application/workers/eventRelayWorker.ts` / `application/di/` / `domain/common/` の変更分

正とした spec: `spec/domains/identity.md`、`spec/usecases/identity.md`、`spec/adr/004-domain-boundaries.md`、`spec/inventory/domain.md`、`spec/inventory/usecase.md`、`spec/testcases/identity/*`
参照した設計文書: `.issue/1/plan.md`（受け入れ基準 AC-1〜AC-4 / AC-8、設計節）、`.issue/1/adr.md`（ADR-001〜020）

## Domain / Use Case

### 受け入れ基準の検証結果

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1（VO の制約・`BusinessRuleError<IdentityErrorCode>`） | 満たす | `valueObject.ts` の8 VO + `Actor` がすべて `unique symbol` ブランド + `create`。`UserId`/`AiClientConnectionId`/`ClientName` は trim 後非空、`Email` は正規化→320→構造パターン、`PlainPassword` は 8〜128、`TrashRetentionDays` は `Number.isInteger && >= 1`（NaN / Infinity も弾く）、`default()` が 30。`PasswordHash` は非空のみ。すべて `IdentityErrorCode` の定数を throw する（ただし長さ単位に留保 → W-004） |
| AC-2（`PasswordUser \| SsoUser` の判別可能ユニオンと4ファクトリ） | 満たす | `entity.ts:23-36` が spec のフィールド表と1対1。`changePassword` は `PasswordUser` を引数型で限定（`entity.test.ts:183` が `@ts-expect-error` 相当で表明）、`changeTrashRetentionDays` は `User`。4ファクトリとも `now` を引数で受け `WithEventDrafts` を返す純関数（ただし no-op 分岐に留保 → W-001） |
| AC-3（`identity.userRegistered` の識別子なしドラフト＋同一トランザクション outbox） | 満たす | `events.ts:30-40` が `EventDraft<...>`（`id` なし）を返し、`registerWithPassword.ts:56` の `collectEvents` 経由でのみ outbox に載る。`identity.integration.test.ts:133` が users 行と outbox 行を同一コミットで表明 |
| AC-4（`UserRepository` / `PasswordHasher` のポート宣言と OCC 規約） | 満たす | `ports/userRepository.ts:37-42` は spec どおり `TransactionalRepository` を extends せず、`findById` のみが `ExpectedVersion<User>` の発行点。phantom 型は `domain/common/transactionalRepository.ts:13` のまま流用され、`Versioned<User>` を返す。`PasswordHasher` は `hash` / `verify: Promise<boolean>` の2メソッド |
| AC-8（4ユースケースの処理フローとエラー契約） | 満たす | 下表 |

**AC-8 の処理フロー突き合わせ**

| ユースケース | spec の処理フロー | 実装 | 判定 |
|---|---|---|---|
| `registerWithPassword` | clock/idGen → VO → **UoW 外で** hash → UoW 内で `findByEmail` → `User.registerWithPassword` → `insert` → `collectEvents` | `registerWithPassword.ts:38-58` が同順。hash は `run` の外（38-43）、事前検証・insert・collectEvents は `run` の中 | 一致 |
| `loginWithPassword` | VO 生成失敗も含め全失敗を `ValidationError("INVALID_CREDENTIALS")` に統一 | `loginWithPassword.ts:39-58` の4分岐すべてが同一ファクトリ `invalidCredentials()` を throw | 一致 |
| `logout` | ドメイン操作なし・`void` | `logout.ts:21-25`（`UserId.create` のみ → N-006） | 概ね一致 |
| `getCurrentUser` | `UserId.create` → `findById` → 資格情報・SSO 主体を含めない view | `getCurrentUser.ts:25-34` + `view.ts:19-26` | 一致（出力の入れ子だけ差異 → W-002） |

### 重点観点の検証結果

- **ドメイン純粋性**: `domain/identity/` 配下に I/O・`new Date()`・ID 生成は一切なし。`now` は全ファクトリが引数で受け、`UserId` は `params.id` を受けるだけ。`clock.now()` / `idGenerator.next()` はユースケース冒頭のみ（`registerWithPassword.ts:38-39`）。**合格**
- **UoW 規約**: 書き込みは `unitOfWorkProvider.run` の中だけ。イベントは `collectEvents` 以外の経路を持たない（`UnitOfWorkContext` が `outboxRepository` を露出していない）。読み取り専用の2ユースケースが `run` を通るのは ADR-009 の記録どおりで、`LibsqlUnitOfWorkProvider.run` の `pending.isEmpty()` 分岐により実際にトランザクションを張らないことを確認した。**合格**
- **クロスレイヤー catch**: 明示された境界は2箇所のみ。`registerWithPassword.ts:61-79`（ADR-008 のレース読み替え。`code === "UNIQUE_VIOLATION"` だけを読み替え、それ以外は素通し）と `loginWithPassword.ts:39-44`（VO 生成2行だけを包む最小スコープ、spec 133 行が要求）。ドメインエラーの再翻訳・握り潰しは他に無い。**合格**
- **`loginWithPassword` の失敗応答の同一性**: `kind: "validation"` / `code: "INVALID_CREDENTIALS"` / `message: "Invalid email or password"` / `fieldErrors` なしで完全一致。`identity.integration.test.ts:463-495` が5つの失敗経路の `toSerialized()` を相互に `toEqual` で突き合わせており、表明として最も強い形。**合格**（タイミング差だけ残る → W-005）
- **`getCurrentUser` の漏出**: `CurrentUserView` は `{ userId, email, authMethod, trashRetentionDays }` のみ。`passwordHash` / `provider` / `providerSubject` は射影されず、TC-getCurrentUser-003 / 004 がキー集合の完全一致で表明。**合格**
- **イベントデコーダの網羅性**: `AllDomainEvents = IdentityEvent`（`eventRelayWorker.ts:46`）+ `satisfies DefaultEventDecoderRegistry`（同 60-62）+ `identityEventDecoders: IdentityEventDecoders`（マップ型注釈, `eventDecoders.ts:20-26`）の二重で、イベント追加時にコンパイルエラーが必ず出る。**合格**
- **JSDoc**: 自明な言い換えはほぼゼロ。`registerWithPassword.ts:62-74`（ADR-008 の安全性前提を列挙）、`sessionCodec.ts:1-19`（「ユースケースから参照してはならない」）、`di/types.ts:40-52`（`passwordHasher` を例外として置く理由）は、いずれも将来この判断を壊す変更を止めるための WHY として機能している。**合格**

### Blockers

なし。

### Warnings

- **[W-001]** `User.changeTrashRetentionDays` の「同値なら no-op」分岐が spec にも ADR にも無く、WHY コメントも無い
  - 場所: `packages/core/src/domain/identity/entity.ts:121-123`
  - 理由: `spec/domains/identity.md#User` の `changeTrashRetentionDays` にも `spec/usecases/identity.md#changeTrashRetentionDays` の処理フローにも no-op 分岐は存在せず、`spec/testcases/identity/changeTrashRetentionDays.md` の「現在と同じ値 → 正常終了する（同一値の禁止規則は存在しない）」も version・イベントの扱いまでは規定していない。実装は version を据え置きイベントも出さないが、この判断が読み手に伝わる手掛かりがコード上に無い（テスト `entity.test.ts:228` が存在するだけ）。さらに戻り値の型 `WithEventDrafts<User, IdentityEvent>` は「変わったか」を表現しないので、UC-identity-012 を配線するときに spec の処理フローどおり `save(user, expectedVersion)` を無条件で呼ぶと、version が進まないまま UPDATE が1本流れる空更新になる。memo / knowledge の spec は同じ状況を `newRevision: null`（DOM-memo-001）や `changed: false`（UC-knowledge-008）と**戻り値で明示**する設計になっており、identity だけ暗黙になっている
  - 提案: (a) 分岐の直上に「同値変更で version を進めるとゴミ箱の保持期限計算に無意味な OCC 競合を作るため」等の WHY を1行入れる、(b) 可能なら memo / knowledge に倣って `changed: boolean` 相当を戻り値に載せ、UC-identity-012 側が `save` をスキップできる形にする、(c) いずれにせよ spec-sync 対象（`spec/domains/identity.md#User` に no-op 規則を追記）として `progress.md` に残す

- **[W-002]** `getCurrentUser` の出力 DTO が spec の平坦な形と異なり `{ user: ... }` に入れ子になっている
  - 場所: `packages/core/src/application/identity/getCurrentUser.ts:10-12`
  - 理由: `spec/usecases/identity.md#getCurrentUser` の出力 DTO 表は `userId` / `email` / `authMethod` / `trashRetentionDays` を**トップレベル**に並べており、`UC-identity-013` の要点も同じ。実装は1段ネストしている。同じ PR 内の `registerWithPassword` / `loginWithPassword` は spec どおり平坦（`{ userId }`）なので、identity の中でも規約が揃っていない。ADR にも記録が無く、「spec と違うが意図的」なのか「なんとなく」なのかが判別できない
  - 提案: `GetCurrentUserOutput = CurrentUserView` に平坦化して spec と揃える（`CurrentUserPanel` 側の1行修正で済む）。将来フィールドを足す余地を残したくてネストしたのなら、ADR か JSDoc にその理由を1行書いて spec-sync 対象として記録する

- **[W-003]** `User.reconstruct` のコメントが「`users` の直和 CHECK 違反行は同じ経路（`RehydrationError`）に落ちる」と読めるが、実際に検出できるのは片方向だけ
  - 場所: `packages/core/src/domain/identity/entity.ts:166-172`（コメント）/ `183-199`（分岐）
  - 理由: 検出できるのは「必要な列が NULL」方向（`password` なのに `passwordHash` が null → `PasswordHash.create("")` が throw、`sso` なのに `ssoProvider` が null → `SsoProvider.create("")` が throw）だけである。逆方向、たとえば `auth_method='password'` の行に `sso_provider` / `sso_provider_subject` が入っている場合、`reconstruct` は SSO 列を**黙って捨てて**正常な `PasswordUser` を返す。`users_auth_method_sum` CHECK が本当に効いていればどちらも起こらないが、コメントの「and so on」は実装が持っていない保証まで含意しており、防御の二重化がどこまで効いているかを読み違えさせる。同じ関数は `createdAt` / `updatedAt` の妥当性（`new Date(NaN)` 等）も検証していない
  - 提案: (a) コメントを「NULL 方向の drift のみ検出する。相手側の列が埋まっている drift は DB の直和 CHECK が唯一の防波堤」と正確に書き直す、または (b) 各分岐で相手側の列が NULL であることを表明して両方向を `RehydrationError` に落とす。`SsoUser` の再水和が TC-getCurrentUser-002 / 004 の土台であること、SSO スライスで `findBySsoIdentity` が入ると読み出し経路が増えることを考えると (b) が望ましい

- **[W-004]** VO の長さ検証がすべて UTF-16 コードユニット長で、spec の「文字」の定義と一致していない
  - 場所: `packages/core/src/domain/identity/valueObject.ts:79`（`PlainPassword` 8〜128）、`:47`（`Email` 320）、`:151`（`ClientName` 100）
  - 理由: `spec/domains/identity.md#PlainPassword` は「8文字以上128文字以下」とだけ書くが、同じ spec 群の memo / knowledge は単位を明示している（`DOM-memo-004`「10,000 **コードポイント**上限」）。`.length` はサロゲートペアを2として数えるので、絵文字4個（4文字・8ユニット）のパスワードが最小長を通過し、絵文字65個（65文字・130ユニット）が上限で弾かれる。最小長側は「8文字以上」という要件の実効的な緩和であり、パスワード強度の下限に直接効く
  - 提案: 単位を決めて1箇所に寄せる。コードポイント基準にするなら `[...raw].length`（`MemoBody` を実装する後続スライスと同じ関数を共有できる）。UTF-16 基準を意図的に選ぶなら `PlainPassword` の JSDoc にその旨と理由を書き、spec 側にも単位を明記する提案を spec-sync 対象に載せる

- **[W-005]** `loginWithPassword` に未登録アドレス判定のタイミングオラクルが残っている
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:30-31`（既知の限界として記載）/ `49-58`
  - 理由: 未登録・SSO ユーザーの場合は `verify` を呼ばずに即 throw するのに対し、登録済み＋パスワード誤りの場合は PBKDF2 210,000 回（本番既定）を回してから throw する。応答の同一性（`kind` / `code` / `message`）は完全に満たしているが、`spec/usecases/identity.md#loginWithPassword` が同一化を要求している目的は「登録有無の推測材料を与えない」ことなので、数十 ms 単位の差はその目的に対して穴になっている。JSDoc が既知の限界として明記している点は評価するが、限界を書くだけでは閉じない
  - 提案: 未登録・SSO 分岐でも固定のダミーハッシュに対して `verify` を1回走らせてから同じエラーを投げる（実装は数行）。本 Issue で入れないなら、`progress.md` の残存課題に「ログインのタイミングオラクル」として起票しておく

- **[W-006]** `RequestSecrets.sessionSecret: string` に「不在」を空文字で詰めており、不正な状態が型に現れない
  - 場所: `packages/core/src/application/di/secrets.ts:16` / `serverNode.ts:115`・`serverCloudflare.ts:116`・`serverGcp.ts:119`・`serverAws.ts:136`（いずれも `env.SESSION_SECRET ?? ""`）
  - 理由: `requireSessionSecret` は `string | undefined` を受けられるのに、呼び出し側の型 `RequestSecrets` が `string` なので4本すべてが `?? ""` というセンチネルを噛ませている。「秘密鍵が設定されていない」という状態が `""` という**一見有効な値**に化けており、CLAUDE.md の「不正な状態を型で表現不能にする」から見ると一段弱い。今は `requireSessionSecret` が唯一の消費点なので実害は無いが、将来 `secrets` を別の場所から読む配線が増えると `""` が素通りする余地が生まれる
  - 提案: `RequestSecrets = Readonly<{ sessionSecret: string | undefined }>` にして `?? ""` を4箇所から消す。`requireSessionSecret` のシグネチャは既にそれを受けられる

### Notes

- **[N-001]** ADR-008 の読み替えの「安全である前提」が `registerWithPassword.ts:62-74` にコード直下のコメントとして列挙されている点が良い。同一 UoW の書き込みが `users` insert + outbox insert だけであること、`PasswordUser` なので部分一意インデックス `users_sso_identity_uq` が原理的に発火しないこと、`users.id` / `EventId` が UUIDv7 なので PK 衝突が実質起こらないこと、そして「他の一意制約を持つ書き込みをこの UoW に足したら読み替えを外せ」という将来への指示まで書かれている。この種の「前提に依存した catch」は前提が失われた瞬間に誤動作するので、前提の置き場所として最適な位置に置かれている。
- **[N-002]** TC-loginWithPassword-008 の表明（`identity.integration.test.ts:463-495`）が、5つの失敗経路の `toSerialized()` を互いに `toEqual` で突き合わせたうえで期待値リテラルとも比較している。「メッセージだけ一致を確認する」よりも強く、`fieldErrors` の有無や `retryable` の差も検出できる形になっている。ユーザー列挙防止の要件に対する回帰テストとして十分。
- **[N-003]** `sessionCodec` を `application/ports/` に置きつつ「ユースケースから参照してはならない」を JSDoc で明示（`ports/sessionCodec.ts:1-19`）し、実際にユースケース側からの参照がゼロであることを確認した（参照は `apps/web/app/presentation/{currentUser,session}.ts` の2箇所のみ）。`spec/usecases/identity.md` 共通事項の「セッションは presentation の責務」が構造として保たれている。
- **[N-004]** `di/types.ts:40-52` が `passwordHasher` を `RequestContainer` に載せる例外の理由（リポジトリではない・ストレージに触れない・spec が UoW 外でのハッシュ計算を要求している）を書いている。ADR-009 が守っているのは「リポジトリの取得口は `UnitOfWorkContext` ただ1つ」であることが、ADR を読まなくても型定義の場所で分かる。
- **[N-005]** `registerWithPassword` は spec の処理フローどおりメール重複の事前検証**より先に** PBKDF2 を回す。攻撃者が未登録アドレスを投げれば同じ計算を強制できるので順序を入れ替えても緩和にはならず、実質はレート制限の問題である。本 Issue の範囲外だが、認証エンドポイントのレート制限は別 Issue として残しておくとよい。
- **[N-006]** `logout` は `spec/usecases/identity.md#logout` が「エラーケース: なし」と書くのに対し、`UserId.create(input.userId)` で空 ID を `BusinessRuleError` にする。plan.md の設計表がそう定めており JSDoc にも理由（壊れたセッションはここで気付くべき）があるので妥当だが、spec の字面との差なので ADR-009 / 011 と同様に spec-sync 対象として記録しておくのが一貫している。
- **[N-007]** `getCurrentUser` の `NotFoundError` メッセージが `User not found: ${userId}` と ID を含む（`getCurrentUser.ts:31`）。`redactForClient` は `notFound` を redact しないためクライアントに届くが、値はそのセッション自身の ID なので情報漏洩にはならない。指摘というより確認事項。
- **[N-008]** 未実装の spec 要素はいずれも plan.md のスコープ節と一致していることを確認した: `UserRepository.findBySsoIdentity`（DOM-identity-022）、`TokenScope`（DOM-identity-012）、`AiClientConnection` 一式（DOM-identity-002 / 016 / 017 / 023〜028）、`IdentityErrorCode.PasswordNotSupported`（UC-identity-006 / 007 が要求）。`PlainPassword` の漏出防止を実装で持たない件（DOM-identity-006 の部分実装）も ADR-011 の判断どおりで、代替のテスト2本（`entity.test.ts:70` のイベントペイロード再帰走査、TC-getCurrentUser-003 のキー集合一致）が実在する。`logger.*` に `PlainPassword` を渡している箇所が無いことも全文検索で確認済み。
