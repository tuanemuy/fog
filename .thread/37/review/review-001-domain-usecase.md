# Domain / Use Case

PR #49（`origin/main...HEAD`、220ファイル）を Domain / Use Case の観点でレビューした。

判定基準は `CLAUDE.md` / `spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/database/index.md` と `.thread/37/plan.md`（受け入れ基準・スコープ）、および `.thread/37/adr.md` の ADR-001〜041。

全体としてポートの同期化・UoW の2型分割・エラーの層間ポリシーは非常に精度が高く、JSDoc が「なぜそうなのか」を残す水準も高い。以下は、その水準に対して**取り残された3箇所**と、モデルが不正状態を許している箇所の指摘である。

## Blockers

- **[B-001]** `application/di/facades.ts` が `adapters/` から型を import しており、`application → adapters` の逆流が復活している。本 PR が同じ問題を2度潰した直後の3度目の取りこぼし
  - 場所: `packages/core/src/application/di/facades.ts:1-12`
  - 理由:

    ```ts
    import type {
      LookupCredentialArgs, LookupCredentialResult, ReserveCredentialFacadeArgs,
    } from "@repo/core/adapters/cloudflare/identityDirectory/facade";
    import type {
      CurrentUserPayload, InitializeAccountArgs,
      RecordCredentialLocatorArgs, VerifyLoginArgs,
    } from "@repo/core/adapters/cloudflare/userData/facade";
    ```

    この7型は `UserDataFacade` / `IdentityDirectoryFacade` のシグネチャに現れ、それが `RequestContainer`（`di/types.ts:57-67`）に載り、`UsecaseContainer` を通って `signupSaga` / `loginWithPassword` / `getCurrentUser` / `requestPasswordReset` の**型に到達する**。つまりユースケースがアダプター層の所有する型で書かれている。

    本 PR は同じ形の逆流を2回、明示的に潰している — ADR-014 が `RpcEnvelope` を `lib/rpcEnvelope.ts` へ、ADR-027 が `DirectoryLocator` を `lib/directoryLocator.ts` へ移し、`platform/envelope.ts:8-12` はわざわざ「re-export すると `restoreError.ts` が別名でアダプターへ届いて ADR-014 の逆流が復活する」とまで書いて再輸出を禁じている。`facades.ts` はその隣で、同じ逆流を素通しにしている。

    さらに `facades.ts` 自身の JSDoc が事実と食い違う — 「Living in `di/` keeps `RequestContainer` free of any dependency on the state Worker's implementation modules while still naming the contract exactly」と書いてあるが、依存は消えておらず `import type` に化けているだけである。

    AC-25 の検証コマンドが 0 件で通るのは `grep -v '/di/'` に救われているからだが、その除外の根拠は plan.md AC-25 (b) に「**合成ルートだけが具象アダプターを組み立てる正当な場所だから**」と書かれている。`facades.ts` は何も組み立てていない契約定義モジュールで、この根拠の射程外である。機械検証が通ることと規約が守られていることが乖離している。

    `CurrentUserPayload` に至っては `application/identity/view.ts` の `CurrentUserView` と**構造が完全に同一**で、単なる二重定義になっている（`getCurrentUser.ts:26` は `CurrentUserView` を宣言し、実体はアダプター側の `CurrentUserPayload` を返している）。
  - 提案:
    1. `CurrentUserPayload` を廃し、`adapters/cloudflare/userData/facade.ts` 側が `application/identity/view.ts` の `CurrentUserView` を import する（adapters → application は正方向）。
    2. 残る6型（`InitializeAccountArgs` / `VerifyLoginArgs` / `RecordCredentialLocatorArgs` / `LookupCredentialArgs` / `LookupCredentialResult` / `ReserveCredentialFacadeArgs`）は `DirectoryLocator` / `RpcEnvelope` と同じ扱いにする。プリミティブだけの構造体で振る舞いを持たないので `packages/core/src/lib/rpcPayloads.ts`（仮）が素直。アダプター側の facade がそこから import する。
    3. AC-25 の grep から `/di/` 除外を外せるか、外せないなら「`di/` 除外は value import に限る」と根拠を書き直す。今の形だと次の Issue が同じ穴を通る。

- **[B-002]** `User.credentials` が読み取り時の射影である一方、集約が `addCredential` / `removeCredential` を公開しており、`UserSettingsRepository.save` はクレデンシャル集合を**書かない**。spec が指示する手順どおりに書くと version だけ進んで変更が黙って消える
  - 場所: `packages/core/src/domain/identity/entity.ts:77-119` / `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts:40-65` / `packages/core/src/domain/identity/ports/userSettingsRepository.ts`
  - 理由: `find()` は `credential_locators` から `credentials` を射影して `User` を組み立てるが（`userSettingsRepository.ts:67-102`）、`insert` / `save` が触るのは `user_settings` の `trash_retention_days` / `version` / `updated_at` だけである。

    一方 `spec/usecases/identity.md` は次の2箇所で明示的に「集約を変えて `save` する」手順を指示している。

    - `:537` `User.addCredential(user, credential, now)` → `UserSettingsRepository.save(user, expectedVersion)`（linkSsoCredential）
    - `:583` `User.removeCredential(user, credentialId, now)` → `UserSettingsRepository.save(user, expectedVersion)`（unlinkSsoCredential）

    この手順を #12 がそのまま実装すると、`version` が1つ進み `updated_at` が動き、**クレデンシャル集合は1ビットも変わらない**。しかも `find()` が返す `credentials` は `credential_locators` 由来なので、テストで確認しても「正しく見える」— 実際に効いたのは `CredentialLocatorStore` 側の別の呼び出しである、という状態になる。壊れ方が観測しにくい。

    そして**ドメインポート側にはこの事実がどこにも書かれていない**。`ports/userSettingsRepository.ts` の JSDoc は `findById` を持たない理由・単一行なので `id` 述語が無いこと・エラーケースまで丁寧に書いているのに、「`credentials` は書かれない」だけが無い。書いてあるのは `adapters/cloudflare/userData/userSettingsRepository.ts:28-34`（"Only the first is written here"）で、#12 の実装者が読むのはポートと spec であってアダプターではない。

    `spec/domains/identity.md:530` は「**`User.credentials` はこのストアの射影である**」と宣言しているので、射影という設計判断自体は spec 側にある。矛盾しているのは spec の usecase 側と、それを追認してしまった実装の集約 API である。
  - 提案: どちらかに倒し、倒した側を明文化する。
    - (a) **射影に倒す（推奨）**: `User` から `addCredential` / `removeCredential` を落とし、クレデンシャル集合の遷移は `CredentialLocatorStore.record` / `deleteByCredentialId` だけにする。「最後のログイン手段か」の検査は `User.loginCredentialCount` を述語として残せば足りる（現に `removeCredential` はその述語しか使っていない）。あわせて `spec/usecases/identity.md:537,583` の訂正を #12 へ引き継ぐ。
    - (b) **集約に倒す**: `save` が `credential_locators` の `usable_for_login` / `label` を書き戻す。ただし「判定の権威は認証情報側」（`spec/domains/identity.md:529`）と衝突するので (a) のほうが筋が良い。
    - いずれにせよ `.thread/37/adr.md` に ADR を1本足し、`ports/userSettingsRepository.ts` の JSDoc に1行入れること。ADR-025（`AccountStore` に2本足す）と同じ粒度の判断が、ここだけ無記録で通っている。

## Warnings

- **[W-001]** `User` の不変条件「`credentials` は1件以上、うち1件以上が `usableForLogin: true`」がどこにも強制されていない
  - 場所: `packages/core/src/domain/identity/entity.ts:62-74`（`initialize`）/ `:198-214`（`reconstruct`）/ 呼び出し側 `packages/core/src/adapters/cloudflare/userData/facade.ts:236`
  - 理由: `spec/domains/identity.md:124` が不変条件として明記しているが、`initialize(params: { id: string; credentials: readonly CredentialRef[] })` は空配列を受け付け、`reconstruct` も件数を見ない。実際 `facade.ts:236` が `User.initialize({ id, credentials: [] }, new Date(now))` で呼んでいる。

    saga の phase 2 時点でロケータ行がまだ無いのは設計上正しいので、「一時的に0件を通る」こと自体は妥当な判断でありうる。問題は**その判断がどこにも書かれていない**ことと、`removeCredential` だけが `loginCredentialCount === 0` を見て、`initialize` と `reconstruct` は見ない、という非対称が説明なしに存在することである。`entity.test.ts:49` も id の検証しかしておらず、空集合はテストで固定すらされていない。

    加えて spec は `registerWithPassword({ id, credential })`（**単数**）/ `registerWithSso({ id, credentials })` の2ファクトリを定義しており、前者は型で1件を強制していた。単一の `initialize(readonly CredentialRef[])` へ畳んだことで、その型レベルの保証が失われている。
  - 提案: 不変条件を維持するなら `initialize` の引数を `readonly [CredentialRef, ...CredentialRef[]]` にして phase 2 の呼び出しを組み直す。0件を通す設計に変えたのなら、`entity.ts` の JSDoc と `spec/domains/identity.md:124` を訂正し、ADR を残す。今は「spec に不変条件があり、コードには無い」だけの状態になっている。

- **[W-002]** `removeCredential` が `kind: "sso"` に限定されていない。spec が2箇所で要求する `BusinessRuleError` が実装されておらず、テストが逆の挙動を固定している
  - 場所: `packages/core/src/domain/identity/entity.ts:96-119` / `packages/core/src/domain/identity/__tests__/entity.test.ts:115-122`
  - 理由: `spec/domains/identity.md:104,125` は「解除。`kind: "sso"` のみ受け付ける」「`kind: "email"` の解除経路は存在しない」と書き、`spec/usecases/identity.md:596` はエラーケース表に「対象が `kind: "email"` → `BusinessRuleError`（`User.removeCredential` が `kind: "sso"` しか受けない）」を持つ。

    実装は `credentialId` だけで filter しており `kind` を見ない。さらに `entity.test.ts:115` の `"removes an address-only entry without complaint"` は `ADDRESS_ONLY = credential("cred-email", { usableForLogin: false })`（つまり `kind: "email"`）の解除が成功することを**assert している**。禁止されている経路がテストで固定された状態になっている。

    spec が禁止する理由（「メールクレデンシャルを失うとアドレス表示・パスワードリセット・パスワード変更のすべてが成立しなくなり、追加し直す経路も無い」）は SSO 専用アカウントにもそのまま当てはまる — 予約行としてのメール要素を消せば、そのアドレスが他人に取られうる。
  - 提案: `removeCredential` の先頭に `kind !== "sso"` のガードを足す（`spec/usecases/identity.md:596` の期待どおり `BusinessRuleError`）。意図的に緩めたのなら該当テストのコメントに理由を書き、spec 2箇所の訂正を #12 へ引き継ぐこと。#12 が `unlinkSsoCredential` をこのメソッドの上に建てるので、ガードの所在は今決まる。

- **[W-003]** `LookupCredentialResult` が「使える資格情報」と「一様なダミー応答」を同じ形で返すので、ユースケースが不正状態を手作業で埋めている
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:147-160` / `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:52-65`
  - 理由:

    ```ts
    if (found.userId === null || found.passwordVerifier === null) continue;
    const matches = await container.passwordHasher.verify(
      plainPassword, found.passwordVerifier as PasswordHash,
    );
    ...
    credentialId: found.credentialId ?? "",
    ```

    `userId` / `credentialId` / `passwordVerifier` が独立に nullable なので、「`passwordVerifier` はあるが `credentialId` は null」という起こりえない組み合わせが型上は表現できてしまい、`?? ""` で塗り潰している。空文字は `verifyLogin` の中で `CredentialId.create("")` に到達し、`BusinessRuleError(InvalidCredentialId)` になる — 全ての失敗を `ValidationError("INVALID_CREDENTIALS")` に揃えるという本ユースケースの中心的な契約を、この1経路だけが破る。

    `as PasswordHash` も同種で、ブランド型への無検証キャストになっている（`PasswordHash.create` を通していない）。
  - 提案: `LookupCredentialResult` を判別可能ユニオンにする。

    ```ts
    export type LookupCredentialResult =
      | { readonly outcome: "usable"; readonly userId: string;
          readonly credentialId: string; readonly passwordVerifier: string;
          readonly credentialVersion: number; readonly usedLocator: …; }
      | { readonly outcome: "none"; readonly credentialVersion: number;
          readonly usedLocator: …; };
    ```

    これで `?? ""` も `as PasswordHash` も消える。RPC 境界を渡るのは変わらずプリミティブなので構造化クローンに支障はない。

- **[W-004]** `signupSaga` が「起こりえない状態」を素の `Error` で守っている。型で表現可能なうえ、素の `Error` は `kind` を持たないので transport 境界で 500 になる
  - 場所: `packages/core/src/application/identity/signupSaga.ts:96-98`（`"A signup must present at least one credential"`）/ `:284-290`（`activeLocator` の `"The routing keyring produced no active locator"`）
  - 理由: `CLAUDE.md`「Error handling」は「Errors are class hierarchies that each carry their own `kind`-tagged serialized form」と定めており、素の `Error` は presentation の `unknown` バリアントに落ちて 500 になる。そして両方とも実行時チェックが不要な形にできる — `credentials: readonly SignupCredentialInput[]` は `readonly [SignupCredentialInput, ...SignupCredentialInput[]]` に、`DirectoryLocatorResolver.forCanonical` の戻り値は `Promise<readonly [DirectoryLocator, ...DirectoryLocator[]]>` にできる（実装は必ず active 世代を先頭に置くので、契約としても正しい）。

    レビュー観点の「`if (!x) throw` はモデルが不正状態を許すシグナル」がそのまま当てはまる箇所である。
  - 提案: 上記2つを非空タプル型にして `throw` を削除する。`requestPasswordReset.ts:35-36` の `if (locator === undefined) return;` も同じ変更で消える（今は「locator が引けなかったら黙って何もしない」という、AC-11 の一様応答を静かに破りうる分岐になっている）。

- **[W-005]** ドメインポートに `readonly unknown[]` がある。同じ概念が application 層に `LocatorRef`、ドメインに `CredentialLocator` として二重定義されている
  - 場所: `packages/core/src/domain/identity/ports/credentialMappingStore.ts:45`（`locators?: readonly unknown[]`）
  - 理由: 実際に渡る値は `readonly LocatorRef[]`（`application/execution/jobs.ts:44-50`）だが、ドメインは application を import できないので `unknown` に潰れている。しかも `LocatorRef`（`credentialId` / `kind` / `hmac` / `generation` / `bucketIndex`）は、同じ PR がドメインに置いた `CredentialLocator`（`ports/credentialLocatorStore.ts:3-16`。上記5フィールド＋`credentialVersion` / `usableForLogin` / `label`）の部分集合そのものである。

    `CLAUDE.md` の第一原則が「Prioritize type safety; lean on TypeScript's type system fully」なので、ドメインポートの引数が `unknown[]` なのは筋が通らない。`unknown` のまま `reserve` → アダプター → `JSON.stringify` と流れるので、形の誤りはどこでも検出されない。
  - 提案: ロケータ参照の形（5フィールド）をドメイン側の名前付き型として1つ定義し（`domain/identity/ports/credentialLocatorStore.ts` に `CredentialLocatorRef` を置いて `CredentialLocator` がそれを拡張する形が自然）、`application/execution/jobs.ts` の `LocatorRef` をその別名にする。`locators?: readonly CredentialLocatorRef[]` になる。

- **[W-006]** `Email.create` の canonical 化が ASCII ドメインと非 ASCII ドメインで非対称。domain 部の構文検査が実質存在しない
  - 場所: `packages/core/src/domain/identity/valueObject.ts:95-108`（`toAsciiDomain`）/ `:145-165`（`create`）
  - 理由: `EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/` は空白と `@` しか弾かないので、`/` `:` `?` `#` を含む domain 部が構造チェックを通過する。その後の分岐が非対称になっている。

    - ASCII 経路: `toAsciiDomain` を通らないので `a@example.com/evil` はそのまま canonical になり、そのまま HMAC の入力・一意性キー・リセットメールの宛先になる。届かないアドレスで登録できる。
    - 非 ASCII 経路: `new URL("http://" + domain).hostname` を通るので path / port / query が**黙って落ちる**。`a@ドメイン.com/x` と `a@ドメイン.com:8080` と `a@ドメイン.com` が同じ canonical に潰れる。

    NFKC の適用範囲・local 部の非 ASCII 拒否・punycode 後の再チェックは spec の手順1〜8どおりで、テストも1手順ずつ揃っている（`valueObject.test.ts:84-155`）。壊れているのは「構造チェック」の中身だけである。canonical が一意性の権威かつ HMAC 入力である以上、ここは弱い。
  - 提案: 分割後に domain 部のラベル構文を検査する（各ラベルが `[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?`、`.` 区切り、最長63、全体253以下）。punycode 変換の**後**に掛ければ両経路が同じ検査を通り、`toAsciiDomain` が `hostname` を切り落とす副作用にも依存しなくなる。

- **[W-007]** 「そのクレデンシャルはログイン手段として成立するか」というドメイン規則が、アダプター層に微妙に異なる形で3回書かれている
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:132-136`（`lookupCredential` の `usable`）/ `:312-318`（`requestPasswordReset` の `eligible`）/ `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts:158-162`
  - 理由: 3つとも `spec/domains/identity.md:634` の「判定は『クレデンシャルの有無』ではなく『パスワードの検証材料の有無』で行う」という同一の規則を実装しているが、条件の組み合わせがそれぞれ違う（`usable` は status + changeState + nextAttemptAllowedAt、`eligible` はそれに `passwordVerifier !== null` と reset throttle、`sendMail` は `password_verifier === null` のみ）。`CredentialMapping` はドメイン型なので、この述語は純関数としてドメイン側に置ける。3箇所に散っている限り、#12 / #18 が条件を1つ足すときに揃って直る保証が無い。
  - 提案: `domain/identity/ports/credentialMappingRepository.ts` の隣に `isUsableForLogin(mapping: CredentialMapping, now: number): boolean` と `holdsPasswordVerifier(mapping): boolean` を純関数として置き、3箇所がそれを呼ぶ。throttle の窓（#18 / #38 に委譲された定数）だけを引数で渡す形にすれば、委譲の境界も崩れない。

- **[W-008]** `dedupeByCredentialId` の戻り値型が実際には検証していないことを主張している
  - 場所: `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts:110-135`
  - 理由: 末尾の `as CredentialRef[]` が、`row.kind: string` を `"email" | "sso"` に、`row.credential_id: string` を `CredentialId` に無検証で昇格させている。実際の検証は直後の `User.reconstruct` → `reconstructCredential` で行われるので今は無害だが、`ReconstructInput` が要求するのは緩い形（`kind: string`）なので、この `as` は付ける必要がそもそも無い。宣言型が「検証済み」を主張しているぶん、次に触る人を誤らせる。
  - 提案: 戻り値型を `readonly { credentialId: string; kind: string; label: string; usableForLogin: boolean }[]` にして `as` を落とす。検証点は `reconstruct` の1箇所に残る（これが正しい配置）。

## Notes

- **[N-001]** ポートの同期契約は徹底されている。`packages/core/src` 全体で `Promise` を返すドメインポートは `PasswordHasher` と `MailSender` の2つだけで、`CLAUDE.md` の enumeration が実際に守られている。`ports/mailSender.ts:3-12` がその enumeration を「導出規則ではなく列挙である」と書き、かつ「だから UoW コンテキストに載せてはならない」まで書いているのは良い。`domain/common/transactionalRepository.ts:56-61` が「Cloudflare のロックインがドメイン層に届く点」を明示したのも、`CLAUDE.md`「Reference runtime」の記述と整合している。

- **[N-002]** UoW の同期契約が型で強制され、それがビルドゲートになっている。`application/execution/__tests__/unitOfWork.typetest.ts` の3ケース（同期は通る / `async` は `@ts-expect-error` / `Promise` 返しも `@ts-expect-error`）は、`T extends Promise<unknown> ? never : T` を緩めた瞬間に `pnpm typecheck` が落ちる形になっている。規約をテストで守る例として良い。

  実装側も規約どおりだった — `run(` の呼び出し12箇所（`identityDirectory/facade.ts` 7 / `userData/facade.ts` 5）はすべて同期アロー、コールバック内に `await` は1つも無く、`run` の入れ子も無い。

- **[N-003]** UoW コンテキストの DO クラス別ロスターが `CLAUDE.md` Key concepts と一致している。`UserDataUnitOfWorkContext` が `credentialLocatorStore` / `recordOperation` / `updateOperation` / `setMigrationCursor` を持ち、`IdentityDirectoryUnitOfWorkContext` が `resetTokenStore` / `rotationCheckpointStore` を持ち、両方が `enqueueJob` を持つ。`unitOfWork.ts:88-92` が「`operations` / `migration_progress` は User Data DO にあるので、対応する登録点は**存在して throw するのではなく不在にする**」と書いているのは、まさに illegal state を型で消す判断で、ADR-003 の意図どおり。

- **[N-004]** cross-layer catch policy が守られている。広い `catch` は `platform/rpcEntry.ts:44-57`（DO の RPC エントリ）、`jobs/runner.ts:68-86`（ジョブランナー）、`sql/exec.ts` / `mappingOperations.ts` / `userSettingsRepository.ts`（ドライバ例外の翻訳）だけで、`CLAUDE.md` が許可した境界と一致する。ドメインエラーがユースケース境界で再翻訳されている箇所も見つからなかった。

  特に `registerWithPassword` の UNIQUE 違反 `catch` がアダプターへ戻された件（`registerWithPassword.ts:22-27` の JSDoc）は plan.md のリスク欄が名指しした項目で、正しく処理されている。「同期 commit では `insert` のその場で上がるので翻訳点をアダプターへ戻す」という理由も残っている。

- **[N-005]** `restoreError` の未知 `kind` 分岐が `SystemError(DataIntegrityError)` で、黙って潰さない形になっている（`application/rpc/restoreError.ts:57-66`）。さらに `RESTORABLE_ERROR_KINDS` と presentation の `SERIALIZED_ERROR_KINDS` を突き合わせるテストが `apps/web/app/presentation/__tests__/errorResponse.test.ts:154-158` に置かれており、union の権威が presentation にあるという理由で検査もそちらに置いたのは正しい配置。

- **[N-006]** `Email` VO の手順が spec §Email の1〜8と逐語で一致し、各段にテストがある（非 ASCII local 部の**拒否**、local 部だけ lowercase で NFKC 無し、domain の NFKC + punycode、変換後の長さ再チェック）。`ssoCanonical` の区切り子を生の NUL ではなくエスケープで書き、それを `__tests__/noRawNul.test.ts` で機械的に固定したのも、plan.md が警告した grep 破壊への正しい対処。

- **[N-007]** `AccountStore.matchCallerToken(token): boolean` を getter ではなく述語として公開した設計（`ports/accountStore.ts:54-66`）は、「返さない値はうっかりログや DTO に載せられない」という形で秘密の漏出を型で潰しており、illegal state を表現不能にする原則の良い適用例。ADR-025 で判断が記録されているのも良い（B-002 に同じ扱いが無いのが惜しい）。

- **[N-008]** スコープ逸脱は見つからなかった。plan.md が委譲した項目はいずれも未実装で、かつ**未実装であることが表として残っている** — `userData/facade.ts:24-40` と `identityDirectory/facade.ts:11-38` の RPC エントリ表が、各エントリの担当 Issue（#12 / #13 / #44 / #45 / #2〜#10）まで書いている。`promoteVerifier` の `'advanced'` 限定ガード（#12）、`rotate-encryption` / `finalize-withdrawal` / `resume-link` / `resume-credential-change` / `sweep-orphan-mapping` のハンドラ（ADR-002）、`RotationCheckpointStore` の書き手（#44）はいずれも不在で、ADR-002 / ADR-013 / ADR-031 と一致する。

  #18 に委譲されたレート制限の具体値も、`FAILED_ATTEMPT_BACKOFF_MS = 30_000`（`mappingOperations.ts:270-274`）と `RESET_THROTTLE_MS = 60_000`（`identityDirectory/facade.ts:348-349`）の両方に「placeholder。天井と減衰と実値は #18 / #38」というコメントが付いており、規則3（制限中の照合はカウンタを進めない）だけが SQL の述語として実装されている。委譲の線引きが正確。

## 補足: `digestOf` について（指摘には数えない）

`signupSaga.ts:305-313` の `payloadDigest` は `JSON.stringify` に FNV-1a/32 を掛けた8桁hexである。ADR-023 が `jobs.payload_digest` について非暗号学的ハッシュで足りると判断しているが、こちらは `operations.payload_digest` で、`initializeAccount` の4分岐（`facade.ts:196-220`）の「同じ digest → no-op / 違う digest → `ConflictError`」を決める値である。

ただし `operationId` は毎回サーバ側で新規採番される（`signupSaga.ts:19-27` の JSDoc が「re-send across requests はこの saga に存在しない概念」と明言）ので、同じ `operationId` に異なる locator 集合が来る経路が今は無い。したがって衝突は実害を持たず、指摘には数えない。

ただ、この digest が実際には何も区別していないことは記録に値する — #45 が自動回収（同じ `operationId` での再駆動）を足した時点で初めてこの比較が意味を持ち始め、その時に32ビットで足りるかを判断し直す必要がある。ADR-024（Directory 側は `operationId` だけで判定し `payloadDigest` を条件に含めない）と対で、User Data DO 側は含める形になっているので、非対称の理由もあわせて #45 へ引き継ぐと良い。

## カバレッジ

一覧220件に対し、確認98件 / スキップ122件（合計220件）。

### 確認（98件）
- `.thread/37/adr.md`
- `.thread/37/plan.md`
- `CLAUDE.md`
- `README.md`
- `apps/web/app/components/auth/LoginForm/action.ts`
- `apps/web/app/components/auth/SignupForm/action.ts`
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx`
- `apps/web/app/components/settings/LogoutButton/action.ts`
- `apps/web/app/presentation/__tests__/currentUser.test.ts`
- `apps/web/app/presentation/__tests__/errorResponse.test.ts`
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts`
- `apps/web/app/presentation/__tests__/session.test.ts`
- `apps/web/app/presentation/authState.ts`
- `apps/web/app/presentation/currentUser.ts`
- `apps/web/app/presentation/errorResponse.ts`
- `apps/web/app/presentation/session.ts`
- `packages/core/src/adapters/cloudflare/directoryLocator.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts`
- `packages/core/src/adapters/cloudflare/platform/envelope.ts`
- `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts`
- `packages/core/src/adapters/cloudflare/schema/userData.ts`
- `packages/core/src/adapters/cloudflare/userData/accountStore.ts`
- `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts`
- `packages/core/src/adapters/cloudflare/userData/facade.ts`
- `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts`
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`
- `packages/core/src/application/__tests__/helpers.ts`
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts`
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts`
- `packages/core/src/application/di/__tests__/secrets.test.ts`
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts`
- `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts`
- `packages/core/src/application/di/containerStore.ts`
- `packages/core/src/application/di/env.ts`
- `packages/core/src/application/di/facades.ts`
- `packages/core/src/application/di/secrets.ts`
- `packages/core/src/application/di/serverCloudflare.ts`
- `packages/core/src/application/di/stateCloudflare.ts`
- `packages/core/src/application/di/types.ts`
- `packages/core/src/application/errors.ts`
- `packages/core/src/application/events/buildDecoder.ts`
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts`
- `packages/core/src/application/execution/jobs.ts`
- `packages/core/src/application/execution/unitOfWork.ts`
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts`
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts`
- `packages/core/src/application/identity/__tests__/logout.test.ts`
- `packages/core/src/application/identity/eventDecoders.ts`
- `packages/core/src/application/identity/getCurrentUser.ts`
- `packages/core/src/application/identity/loginWithPassword.ts`
- `packages/core/src/application/identity/registerWithPassword.ts`
- `packages/core/src/application/identity/requestPasswordReset.ts`
- `packages/core/src/application/identity/signupSaga.ts`
- `packages/core/src/application/identity/view.ts`
- `packages/core/src/application/ports/idGenerator.ts`
- `packages/core/src/application/ports/idempotencyStore.ts`
- `packages/core/src/application/ports/outboxRepository.ts`
- `packages/core/src/application/ports/relayTrigger.ts`
- `packages/core/src/application/ports/sessionCodec.ts`
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts`
- `packages/core/src/application/rpc/restoreError.ts`
- `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts`
- `packages/core/src/application/workers/__tests__/outboxPrune.test.ts`
- `packages/core/src/application/workers/eventRelayWorker.ts`
- `packages/core/src/application/workers/outboxPrune.ts`
- `packages/core/src/domain/common/event.ts`
- `packages/core/src/domain/common/transactionalRepository.ts`
- `packages/core/src/domain/identity/__tests__/entity.test.ts`
- `packages/core/src/domain/identity/__tests__/noRawNul.test.ts`
- `packages/core/src/domain/identity/__tests__/valueObject.test.ts`
- `packages/core/src/domain/identity/entity.ts`
- `packages/core/src/domain/identity/errorCode.ts`
- `packages/core/src/domain/identity/events.ts`
- `packages/core/src/domain/identity/ports/accountStore.ts`
- `packages/core/src/domain/identity/ports/credentialLocatorStore.ts`
- `packages/core/src/domain/identity/ports/credentialMappingRepository.ts`
- `packages/core/src/domain/identity/ports/credentialMappingStore.ts`
- `packages/core/src/domain/identity/ports/mailSender.ts`
- `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts`
- `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts`
- `packages/core/src/domain/identity/ports/userRepository.ts`
- `packages/core/src/domain/identity/ports/userSettingsRepository.ts`
- `packages/core/src/domain/identity/valueObject.ts`
- `packages/core/src/lib/__tests__/jobKind.test.ts`
- `packages/core/src/lib/directoryLocator.ts`
- `packages/core/src/lib/jobBudgets.ts`
- `packages/core/src/lib/jobKind.ts`
- `packages/core/src/lib/passwordHashing.ts`
- `packages/core/src/lib/rpcEnvelope.ts`
- `packages/core/src/lib/secretLengths.ts`
- `spec/database/index.md`

### スキップ（122件）

いずれも Domain / Use Case の観点外と判断した。理由は分類ごとに一行で示す。

**削除された D1 アダプター群・Outbox 機構（20件）** — 対象消滅の削除。ドメイン契約の変更（同期化・イベント撤去）は確認済みで、削除物そのものはアダプター観点。

- `packages/core/src/adapters/d1/__tests__/env.d.ts`
- `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/helpers.ts`
- `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/setup.ts`
- `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts`
- `packages/core/src/adapters/d1/client.ts`
- `packages/core/src/adapters/d1/migrations/0000_initial.sql`
- `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json`
- `packages/core/src/adapters/d1/migrations/meta/_journal.json`
- `packages/core/src/adapters/d1/pendingBatch.ts`
- `packages/core/src/adapters/d1/repositories/helpers.ts`
- `packages/core/src/adapters/d1/repositories/idempotencyStore.ts`
- `packages/core/src/adapters/d1/repositories/outboxRepository.ts`
- `packages/core/src/adapters/d1/repositories/userRepository.ts`
- `packages/core/src/adapters/d1/schema.ts`
- `packages/core/src/adapters/d1/unitOfWork.ts`

**削除された旧 Worker 群（8件）** — relay / consumer / pruner / dlq / handlers とそのテスト。AC-14 の消滅確認のみで、実装内容はアダプター観点。

- `apps/web/app/worker/cloudflare/__tests__/env.d.ts`
- `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`
- `apps/web/app/worker/cloudflare/consumer.ts`
- `apps/web/app/worker/cloudflare/dlq.ts`
- `apps/web/app/worker/cloudflare/handlers.ts`
- `apps/web/app/worker/cloudflare/pruner.ts`
- `apps/web/app/worker/cloudflare/relay.ts`
- `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`

**Cloudflare アダプター実装（28件）** — SQL 実行・スキーマ DDL・ジョブ実行部・検索 projection・暗号・alarm。ドメイン契約に触れる facade / store / mappingOperations は「確認」側に入れ、残る駆動部と DDL はアダプター観点。

- `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts`
- `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- `packages/core/src/adapters/cloudflare/jobs/registry.ts`
- `packages/core/src/adapters/cloudflare/jobs/runner.ts`
- `packages/core/src/adapters/cloudflare/jobs/table.ts`
- `packages/core/src/adapters/cloudflare/mailSender.ts`
- `packages/core/src/adapters/cloudflare/platform/stubErrors.ts`
- `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts`
- `packages/core/src/adapters/cloudflare/schema/gate.ts`
- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts`
- `packages/core/src/adapters/cloudflare/schema/types.ts`
- `packages/core/src/adapters/cloudflare/search/normalize.ts`
- `packages/core/src/adapters/cloudflare/search/probe.ts`
- `packages/core/src/adapters/cloudflare/search/projection.ts`
- `packages/core/src/adapters/cloudflare/sql/errors.ts`
- `packages/core/src/adapters/cloudflare/sql/exec.ts`
- `packages/core/src/adapters/cloudflare/sql/occ.ts`
- `packages/core/src/adapters/cloudflare/userData/trashQuery.ts`
- `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts`

**アダプター / 統合テスト（25件）** — DO バインディング・alarm・job table・FTS5・migration ゲートの検証。テスト観点かつアダプター観点。

- `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts`
- `packages/core/src/adapters/cloudflare/__tests__/env.d.ts`
- `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/setup.ts`
- `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts`
- `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts`
- `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts`
- `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts`
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts`

**DO クラス定義・Worker エントリ・起動スモーク（5件）** — RPC エントリの配線とビルド成果物の起動確認。エントリポイント / ビルド観点。

- `apps/web/__tests__/boot.smoke.test.ts`
- `apps/web/app/durable-objects/identityDirectory.ts`
- `apps/web/app/durable-objects/userData.ts`
- `apps/web/app/server.cloudflare.ts`
- `apps/web/app/worker/cloudflare/state.ts`

**ビルド / デプロイ / インフラ設定（25件）** — wrangler・vite・Pulumi・package.json・CI・lockfile・.dev.vars。インフラ観点。

- `.github/workflows/ci.yml`
- `apps/web/.dev.vars.example`
- `apps/web/drizzle.config.ts`
- `apps/web/package.json`
- `apps/web/scripts/render-wrangler.ts`
- `apps/web/vite.config.cloudflare.ts`
- `apps/web/vite.config.state.ts`
- `apps/web/wrangler.production.toml.tpl`
- `apps/web/wrangler.request.production.toml.tpl`
- `apps/web/wrangler.request.staging.toml.tpl`
- `apps/web/wrangler.staging.toml.tpl`
- `apps/web/wrangler.state.production.toml.tpl`
- `apps/web/wrangler.state.staging.toml.tpl`
- `apps/web/wrangler.state.toml`
- `apps/web/wrangler.toml`
- `infra/cloudflare/pulumi/resources/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.yaml`
- `infra/cloudflare/pulumi/resources/index.ts`
- `infra/cloudflare/pulumi/routes/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.yaml`
- `package.json`
- `packages/core/package.json`
- `pnpm-lock.yaml`

**テスト構成（3件）** — vitest の3スイート分割設定。テスト基盤観点。

- `vitest.config.integration.ts`
- `vitest.config.smoke.ts`
- `vitest.config.ts`

**ドキュメント（8件）** — ADR・作業ログ・docs・spec のうち、ドメイン契約の判定に使わなかったもの。ドキュメント観点。

- `.adr/001-integration-tests-single-workers-pool.md`
- `.adr/003-sqlite-fts5-only-search.md`
- `.thread/37/steps.md`
- `.thread/37/testing.md`
- `docs/backend_implementation_example.md`
- `docs/test.md`
- `spec/inventory/adapter.md`
- `spec/manual-tests/search.md`
