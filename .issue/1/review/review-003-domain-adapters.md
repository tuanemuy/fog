# レビュー 003 — Domain / Use Case / Adapters

**対象:** PR #17（`issue/1/skeleton-auth`、`a214324`） / Issue #1
**ラウンド:** 3（ゼロベース再レビュー + ラウンド2指摘の解消確認）
**正とした spec:** `spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/database/index.md`
**参照:** `.issue/1/plan.md`（AC-1〜AC-8）、`.issue/1/adr.md`（ADR-001〜043）、`review-002-domain-usecase.md`、`review-002-adapters.md`、`triage.md`

## 検証の方法

読み合わせだけの推測と区別するため、指摘・判定の根拠にした実測を先に置く。

| 実測 | コマンド / 手順 | 結果 |
|---|---|---|
| 型検査 | `pnpm typecheck` | root + 3パッケージすべて **Done** |
| 単体テスト | `pnpm test:unit` | **23 files / 367 passed** |
| 統合テスト | `pnpm test:integration` | node **6 files / 39 passed** + cf **9 files / 104 passed** |
| **反復回数ピンが本当に効くか** | `packages/core/src/` に `const probe: typeof DUMMY_PASSWORD_HASH_ITERATIONS = 600_000` を置いて `tsgo` | **`error TS2322: Type '600000' is not assignable to type '210000'`**。ピンは生きている（プローブは削除済み） |
| **ピンの実行時依存** | `pbkdf2PasswordHasher.ts:2` の import 形式 | `import type` のみ。実行時のエッジは生じない |
| **application → adapters の import** | `grep -rn 'adapters/' packages/core/src/application` | `di/` 配下のみ（4本のランタイム配線 + **`secrets.ts`**）。`di/` 以外のアプリケーション層からアダプターへの import は **0 件** |
| **ADR 参照先の実在** | `ls spec/adr/` と `grep -oE 'ADR-[0-9]+' packages/core/src apps/web/app` の突合 | `spec/adr/` は **001〜006 のみ**。コードが参照する ADR-002/003/004/005/006 は**別内容の実在ファイルに解決し**、007 以降は解決しない → **B-001** |
| **完全 ARN 正規表現の判定** | `bin/app.ts:25-26` の正規表現を Node で直接評価 | `…:secret:session-secret`（`.env.aws.example` の例示値＝部分 ARN）が **`true`** → W-007 |
| **直和 CHECK が他の CHECK を含意するか** | `schema.ts:41` の論理式に `sso_provider='facebook'` / `sso_provider_subject=''` を代入 | どちらも**直和 CHECK を通過する**。「implied」は3本中2本で偽 → W-002 |
| マイグレーション2セットの一致 | `diff d1/migrations/0000_initial.sql libsql/migrations/0000_initial.sql` | **バイト一致** |
| スキーマ ↔ spec | 生成 SQL と `spec/database/index.md:41-75` を全10列 + CHECK 5本 + インデックス2本で突合 | 直和 CHECK の論理式は spec の SQL と**トークン単位で一致**。SQL DEFAULT を1つも置いていない点も spec どおり |
| リポジトリ d1 / libsql の同型性 | クラス名を正規化して `diff` | `toUser` / `toVersioned` / `findById` / `findByEmail` / `authColumns` / `toInsertValues` / `toUpdateValues` は**1文字も差が無い**。差は `PendingBatch` の実行モデル差（`db.batch()` vs interactive tx）と JSDoc の文言のみ |
| ダミーハッシュ陳腐化の検出 | `identity.integration.test.ts:635-671` | ユースケースが実際に渡した文字列を記録し、**本番パラメータの `createPbkdf2PasswordHasher()`** で verify させ、`^pbkdf2-sha256\$210000\$` を表明。実行される |

## ラウンド2指摘の解消状況

### review-002-domain-usecase

| R2 ID | triage | 結論 | 根拠 |
|---|---|---|---|
| W-001 ダミーハッシュ陳腐化が無音 | fix | **解消** | (a) `identity.integration.test.ts:635-671` が本番ハッシャーで実際に verify させ、`DEFAULT_PBKDF2_ITERATIONS` を含む形式まで表明。定数を export せず「ユースケースが渡した値」を記録する形（ADR-033）なので、値の作り方が変わっても表明が生き残る。(b) `burnVerificationTime` に `Logger` が渡り `logger.warn` が入った（`loginWithPassword.ts:60-73`） |
| W-002 反復回数の引き上げでオラクルが復活 | fix | **解消** | `DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS`（`pbkdf2PasswordHasher.ts:30`）。実測でドリフトが型エラーになることを確認。旧コストの保存行という残る限界は JSDoc（`:26-28`）と `progress.md:9-13` の両方に書かれている |
| W-003 `progress.md` の陳腐化 | fix | **部分解消 → 新 W-009** | 項目1は ADR-034 を反映した記述に書き換わり、spec-sync 節に ADR-023 / ADR-024 が転記された。ただし `adr.md` が spec-sync 対象と**自ら宣言している項目**はほかに3件あり、転記されていない |
| W-004 `sessionCodec` がユースケースから見える | fix | **解消** | `application/types.ts:13` の `UsecaseContainer = Omit<RequestContainer, "sessionCodec">`、`ServiceArgs.container` がそれ。`di/types.ts:49-53` に対応も書かれた。呼び出し側の変更ゼロで型検査が通ることも確認済み |

### review-002-adapters

| R2 ID | triage | 結論 | 根拠 |
|---|---|---|---|
| W-001 AWS 部分設定検出の空文字誤判定 | fix | **解消（残課題2件 → 新 W-006 / W-007）** | `bin/app.ts:17-20` の `read()` で `""` を `undefined` に畳み、`missing` と `stageEnv` が同じ規則になった。あわせて完全 ARN 検査も追加された |
| W-002 `fromBase64Url` の JSDoc が実態より広い | fix | **解消** | `encoding.ts:50-52` が「**Acceptance is narrower than `atob`'s, not wider**」と書き換わり、理由（長さからパディングを計算するので空白・余剰 `=` が4の倍数を外す）まで正確。`encoding.test.ts:80-87` が受理/拒否の境界を4ケースで固定 |
| W-003 3つのガードにテストが無い | fix | **解消** | `pbkdf2PasswordHasher.test.ts:102-111`（上限・空白・指数・16進）、`:132-160`（下限の拒否側7ケース + 境界の受理側）、`hmacSessionCodec.test.ts:104-124`（鍵長の拒否側3 + 境界の受理側）、`encoding.test.ts`（新規120行） |
| W-004 削除した todo を docs が参照 | fix | **解消** | `CLAUDE.md:58,60,62` が `auth/{LoginForm,SignupForm}` / `settings/LogoutButton` / `routes/_app/settings.tsx` / `SettingsSkeleton` に張り替え済み。`docs/frontend_implementation_example.md:5` に断り書き。コード側の todo 残滓は 0 件 |
| W-005 セッション鍵最小長の二重定義 | fix | **解消（JSDoc 残 → 新 W-005）** | `secrets.ts:5` がアダプターの `MIN_SESSION_SECRET_LENGTH` を import。定数は1つになり、`di/__tests__/secrets.test.ts:1` と `webcrypto/__tests__/hmacSessionCodec.test.ts:5` が同じ定数を参照する |

### その他（triage の R2 行）

| Key | 結論 |
|---|---|
| `.env.example の既定 SESSION_SECRET` | **解消**。両ファイルとも空。生成コマンドを直上に置き、4ランタイム docs の手順（`docs/runtime_node.md:26,31` / `runtime_cloudflare.md:27,32`）と揃っている。**起動導線は壊れていない** — Node は `server.node.ts:90` の boot 検査で変数名入りのメッセージを出して落ち、CF は `.dev.vars.example` と docs が「every request fails until it is set」と予告している |
| `test/ダミーハッシュ陳腐化の検出` | **解消**（上の W-001 と同じ） |
| `infra/aws/部分設定検出の空文字誤判定` | **解消**（上と同じ） |

**判定 `fix` の R2 指摘で未解消のものは無い。** 以下は今回のゼロベース再走査で新たに見つけたもの、および R2 で Note に留めたため triage に上がらなかったものの追跡である。

## 受け入れ基準の検証結果

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1（VO の制約・`BusinessRuleError<IdentityErrorCode>`） | **満たす** | 8 VO + `Actor` がすべて `unique symbol` ブランド + `create`。`spec/domains/identity.md:203-260` と1件ずつ突合し、UserId（trim 後非空）/ Email（正規化 + `local@domain` + 320）/ PlainPassword（8〜128）/ PasswordHash（非空）/ SsoProvider（`google`\|`apple`）/ ClientName（trim 後非空・100）/ TrashRetentionDays（整数 >= 1、`default()` = 30）/ AiClientConnectionId すべて一致。長さはコードポイント基準（`domain/common/text.ts`） |
| AC-2（`PasswordUser \| SsoUser` と4ファクトリ） | **満たす** | `entity.ts:14-34` が spec のフィールド表と1対1。4ファクトリとも `now` / `id` を引数で受ける純関数で、`new Date()` / ID 生成なし。`changePassword` は `PasswordUser` 限定（`entity.test.ts:194` の `@ts-expect-error`） |
| AC-3（識別子なしドラフト＋同一トランザクション outbox） | **満たす** | `events.ts:30-62` が `EventDraft`（`id` なし）。`registerWithPassword.ts:56` の `collectEvents` が唯一の経路で、`UnitOfWorkContext` が `userRepository` と `collectEvents` しか露出しない |
| AC-4（ポートの宣言と OCC 規約） | **満たす**（記述に誤りあり → W-001） | `ports/userRepository.ts:37-42` が4メソッド、`TransactionalRepository` を extends せず理由も JSDoc にある。`PasswordHasher` は `hash` / `verify` の2メソッドのまま。`save` の WHERE は `id = ? AND version = ?`、0行更新は `_occ_guard` で batch 全体を abort（d1 / libsql とも） |
| AC-5（`users` の名前付き制約 + インデックス2本、共通基盤3テーブル） | **満たす** | 生成 SQL に CHECK 5本 + `users_email_uq` + 部分一意 `users_sso_identity_uq`。直和 CHECK の論理式は spec の SQL とリテラル一致。共通基盤は `outbox_events`（`idx_outbox_pending` 部分索引つき）/ `processed_events` / `_occ_guard`。d1 / libsql はバイト一致 |
| AC-6（d1 / libsql 両実装、OCC / 不整合行 / 翻訳点） | **満たす** | 両リポジトリの再水和・OCC・検索メソッドは正規化 diff で**完全同型**。`toUser` は行オブジェクトを `User.reconstruct` にそのまま渡すので列の取り違えが構造的に起きない。`RehydrationError` → `SystemError(DataIntegrityError)`、`SQLITE_CONSTRAINT_UNIQUE`/`_PRIMARYKEY` → `UNIQUE_VIOLATION`、それ以外の制約 → `CONSTRAINT_VIOLATION`、非制約 → `SystemError(DatabaseError)`。`ApplicationError` の再スローガードで二重変換も防いでいる。`EMAIL_ALREADY_REGISTERED` の翻訳点はユースケース境界 |
| AC-7（タイミングセーフ照合、不一致は `false`） | **満たす** | `pbkdf2PasswordHasher.ts:185-189` が `timingSafeEqual`（`encoding.ts:65-70`、短絡なし）で比較し `boolean` を返す。throw は `CryptoError` と `DataIntegrityError` のみで両方にテストがある。`encoding.test.ts:105-119` が位置0/1/2/15/31 と1ビット差まで表明 |
| AC-8（4ユースケースの処理フローとエラー契約） | **満たす** | 下表 |

**AC-8 の処理フロー突き合わせ**

| ユースケース | spec | 実装 | 判定 |
|---|---|---|---|
| `registerWithPassword` | clock/idGen → VO → UoW 外で hash → UoW 内で `findByEmail` → `insert` → `collectEvents` | `registerWithPassword.ts:38-58` が同順。`catch` は `code === "UNIQUE_VIOLATION"` 限定で、安全性の前提（この UoW が書くのは users 1件 + outbox 1件だけ）が JSDoc に列挙されている | 一致 |
| `loginWithPassword` | 全失敗を `ValidationError("INVALID_CREDENTIALS")` に統一 | `:102 / :114 / :124 / :131` の4分岐すべてが `invalidCredentials()` 単一ファクトリ。統合テスト `:560-580` が5経路の `toSerialized()` の相互一致を表明 | 一致（時間の同一化は spec の要求を上回る） |
| `logout` | ドメイン操作なし・`void` | `logout.ts:21-25`。`logout.test.ts` が全ポートを trip 配線で「触っていない」ことまで表明 | 一致（`UserId.create` の分は spec との字面差。ADR に記録済み） |
| `getCurrentUser` | `UserId.create` → `findById` → 資格情報・SSO 主体を含めない平坦 view | `getCurrentUser.ts:23-32` + `view.ts:12-26`。`CurrentUserView` は `{ userId, email, authMethod, trashRetentionDays }` のみ | 一致 |

読み取り専用ユースケースが `unitOfWorkProvider.run` を通る点は spec の「UoW 不要」と字面が異なるが、ADR-009 のとおり純読み取り UoW はトランザクションを張らないので実質は満たしている。

## 重点観点の検証結果

- **レイヤー分離と依存方向** — アプリケーション層からアダプターへの import は `di/` 配下に限られる（実測）。`di/` はこのリポジトリの合成ルート（CLAUDE.md も「新しい app は自分の DI 配線を持つか `application/di/` のものを再利用する」と書く）なので、`secrets.ts:5` の新しい import も既存の4本のランタイム配線と同じ位置づけであり、**新たな依存の反転は生じていない**。逆向き（アダプター → アプリケーション）の新規 import は `pbkdf2PasswordHasher.ts:2` の1本だけで、`import type` なので実行時のエッジも無い。**合格**（所在の妥当性 → N-006 / N-007）
- **`loginWithPassword` の失敗応答の同一性** — `invalidCredentials()` が単一の発行点であることは変わらず、新分岐から別種の例外が漏れる経路も無い（`burnVerificationTime` は throw を握り潰し、その後同じファクトリで throw）。等時間化は「ダミーが読める」＋「宣言コストが現行値と一致」の2条件に依存し、前者はテスト、後者は型で押さえられている。**合格**
- **ドメイン純粋性** — `domain/identity/` と `domain/common/text.ts` に I/O・`new Date()`・ID 生成は無い。**合格**
- **UoW 規約 / クロスレイヤー catch** — 書き込みは `run` の中だけ。明示された catch は `registerWithPassword.ts:61-79`（`UNIQUE_VIOLATION` 限定）、`loginWithPassword.ts:98-103`（VO 生成2行だけ）、`:65-72`（ダミー verify の握り潰し・ログ付き）の3箇所で、いずれも CLAUDE.md の「明示された境界のみ」に収まる。ドメインエラーの再翻訳は無い。**合格**
- **リポジトリ実装の正しさ** — 再水和は行をそのまま `reconstruct` に渡す形で、`ReconstructInput` の10フィールドと `UserRow` が名前・null 許容・`Date` 射影まで一致。`?? ""` フォールバックは必ず VO 側の拒否に落ちるので null の握り潰しは起きない。OCC トークンの `as` キャストは `toVersioned` の1箇所に閉じている。`OCC_GUARD_CHECK_NAME` は schema から共有され、名前 drift が起きない。**合格**
- **不正な状態の型表現** — `SessionSecret` ブランド、`UsecaseContainer` の `Omit`、`DEFAULT_PBKDF2_ITERATIONS` の literal ピン、`AllDomainEvents` の網羅チェック、`changePassword` の `PasswordUser` 限定と、この PR は型で止める判断を一貫して積み上げている。**合格**（型ガード自身の退行検出 → W-008）
- **JSDoc の質** — R2 で指摘された2件（`fromBase64Url` の受理範囲、`keyPromise` のメモ化スコープ）はどちらも実測と一致する記述に直っており、`encoding.ts:50-52` は反直感的な事実とその原因まで書いている。`text.ts:1-9`、`entity.ts:179-188`（両方向の検出手段まで正確であることを確認）、`registerWithPassword.ts:62-74` はいずれも良い WHY である。**一方で、実態と食い違う記述が新たに4件見つかった**（B-001 / W-001 / W-002 / W-005）。3ラウンド連続で同じクラスの問題が出ており、ここが本 PR の弱点である

---

### Domain / Use Case / Adapters

#### Blockers

- **[B-001]** 出荷されるソースコメントが、リポジトリに**既存の `spec/adr/` と番号空間が衝突する** ADR を無修飾で参照している。ADR-002〜006 は「実在するが内容の異なる文書」に解決する
  - 場所: `packages/core/src` / `apps/web/app` に計40箇所超。代表例 —
    `packages/core/src/application/ports/sessionCodec.ts:14`（"(ADR-002)"）、
    `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:43`（同）、
    `packages/core/src/application/di/types.ts:53`（同）、`:47`（"(ADR-009)"）、
    `packages/core/src/application/di/secrets.ts:19`（"(ADR-002)"）、`:48`（"(ADR-004)"）、
    `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:141`（"(ADR-003)"）、
    `packages/core/src/domain/identity/valueObject.ts:71`（"see ADR-011"）、
    `packages/core/src/domain/identity/ports/userRepository.ts:35`（"see ADR-008"）、
    `packages/core/src/adapters/{d1,libsql}/repositories/userRepository.ts:32/:31`（"(ADR-008)"）、
    `apps/web/app/presentation/{session,sessionCookie,currentUser,authState}.ts`（"ADR-005" / "ADR-010"）ほか
  - 理由: このリポジトリには **ADR の番号空間が2つ**ある。長命な設計 ADR が `spec/adr/001〜006`（実測: `001-restore-document-without-topic.md` / `002-export-scope.md` / `003-source-link-after-hard-delete.md` / `004-domain-boundaries.md` / `005-search-index-via-outbox.md` / `006-memo-fulltext-update.md` の6件）に、本 PR の判断が `.issue/1/adr.md` の ADR-001〜043 にある。**そして両者は 001〜006 で完全に重なっている。** `spec/domains/identity.md:5` が `[ADR-004](../adr/004-domain-boundaries.md)` と相対リンクで書いている以上、このリポジトリで「ADR-NNN」は既に `spec/adr/NNN` を意味する語彙として確立している。したがって —
    - `sessionCodec.ts:14` の「(ADR-002)」を追った読者は `spec/adr/002-export-scope.md`（エクスポート範囲の話）に着く。意図は `.issue/1/adr.md` の「セッション管理方式 — HMAC 署名付きステートレス Cookie」である
    - `secrets.ts:48` の「(ADR-004)」は `spec/adr/004-domain-boundaries.md`（ドメイン境界）に着く。意図は「ランタイム選定」である
    - `pbkdf2PasswordHasher.ts:141` の「(ADR-003)」は `spec/adr/003-source-link-after-hard-delete.md` に着く。意図は「パスワードハッシュ方式」である
    - 007 以降（ADR-008 / 009 / 010 / 011 / 014 / 019 / 030 …）は `spec/adr/` に解決先が無い

    これは「コメントが曖昧」ではなく**参照が別文書に解決する**問題である。しかも参照先の `.issue/1/adr.md` は issue 単位の作業ディレクトリにあり、次の Issue が `.issue/2/adr.md` で ADR-001 から採番し直せば、出荷済みコードの「ADR-008」は三重に曖昧になる。本 PR は3ラウンドにわたって「判断の根拠は ADR に残っているから良い」を品質の根拠にしてきた（R2 の domain-usecase レビューは「ADR-023〜026 が判断の根拠を残しており」と結論づけている）。その根拠へのポインタが壊れていると、レビューが積み上げた価値がマージ後に失われる。修正は機械的で、いま直すのが最も安い
  - 提案: 3案のいずれか。(a) **`.issue/1/adr.md` の ADR を `spec/adr/007-*.md` 以降として切り出す** — 番号空間が1つになり既存の相対リンク規約にも乗る。長命にすべき判断（ADR-002 セッション方式、ADR-003 ハッシュ方式、ADR-008 翻訳点、ADR-009 純読み取り UoW、ADR-011 漏出防止）はもともと issue のスコープを超えるので、これが筋。(b) コード側の参照を全件パス付きに直す（`(.issue/1/adr.md ADR-002)`）— 安いが、issue ディレクトリを出荷コードから参照し続ける歪みは残る。(c) `.issue/1/adr.md` の採番を 100 番台などに振り直して衝突だけ解消する — 最小だが解決先の発見性は上がらない。**(a) を推す。** いずれの案でも、`grep -oE 'ADR-[0-9]+' packages/core/src apps/web/app` の全件が解決することを確認して閉じたい

#### Warnings

- **[W-001]** `UserRepository` の JSDoc「`findById` が `ExpectedVersion<User>` の唯一の発行点」が偽。**同じファイルの型宣言が自らそれを否定している**
  - 場所: `packages/core/src/domain/identity/ports/userRepository.ts:11-13` vs `:41`（`findByEmail(email: Email): Promise<Versioned<User> | null>`）。実装側の同趣旨の記述は `packages/core/src/adapters/d1/repositories/userRepository.ts:34-37` と `packages/core/src/adapters/libsql/repositories/userRepository.ts:26-27`
  - 理由: `findByEmail` も `Versioned<User>` を返し、d1 / libsql とも `findById` と**同じ `toVersioned`**（d1 `:67-72` / libsql `:61-66`）を経由してトークンを鋳造している。つまり発行点は2メソッドある。波及もある —
    - `packages/core/src/domain/common/transactionalRepository.ts:6-7` の「Adapters mint these inside `findById` (the only legitimate construction site…)」が、`UserRepository` については成立しない。ports 側が「Follows the same OCC convention」と宣言しているので、規約の記述としても不正確になる
    - d1 と libsql が**どちらも**「This file is the only legitimate construction site of the token」と書いている（d1 `:35-37` / libsql `:27`）。`as ExpectedVersion<User>` のキャストは実測で2箇所あり、両者の主張は相互に排他的である
    - R2 の domain-usecase レビューは AC-4 の根拠として「`findById` のみが `ExpectedVersion<User>` の発行点」とこの JSDoc をそのまま引用している。**誤った記述がレビューの結論にまで伝播した**実例であり、重点観点「JSDoc が事実と違う」の中でもっとも実害のある形
  - 提案: 事実に合わせる。「`findById` / `findByEmail` が `ExpectedVersion<User>` の発行点で、`save` がそれを消費する」。`transactionalRepository.ts:6-7` の「the only legitimate construction site」も「adapters mint these inside their lookup methods」に緩める。アダプター側の「This file is the only…」は「the `toVersioned` helper is this adapter's only construction site」と、主語をファイルから helper に落とせば d1 / libsql 両方で真になる。なお**振る舞いは正しい** — `findByEmail` の戻り値でトークンが得られること自体は `registerWithPassword` の事前検証で必要で、設計として妥当。直すのは記述だけでよい

- **[W-002]** `schema.ts` のコメント「以下の3つの CHECK は直和 CHECK の帰結」が**3本中2本で偽**。実際にはその2本が唯一の防御である
  - 場所: `packages/core/src/adapters/d1/schema.ts:43-45`（"The three checks below are implied by the sum constraint's disjuncts but kept separate so a violation names the invariant it broke rather than reporting the whole union as failed."）
  - 理由: 直和 CHECK（`:41`）は SSO 分岐について `sso_provider IS NOT NULL AND sso_provider_subject IS NOT NULL` しか要求していない。**値集合にも長さにも一切言及していない。** したがって —

    | CHECK | 直和 CHECK から含意されるか | 反例 |
    |---|---|---|
    | `users_auth_method_valid` | **される** | — |
    | `users_sso_provider_valid` | **されない** | `('sso', NULL, 'facebook', 'sub-1')` は直和 CHECK を通過する |
    | `users_sso_subject_nonempty` | **されない** | `('sso', NULL, 'google', '')` は直和 CHECK を通過する |

    つまりこの2本は「冗長だが診断のために残した」ものではなく、**外すと不変条件そのものが消える必須の制約**である。コメントは実際の防御力を過小に、しかも誤って説明している。将来「冗長だから」と整理する変更を招く形で、`spec/domains/identity.md:243`（`SsoProvider` は `google`/`apple` のみ）と `spec/database/index.md:48`（`length(sso_provider_subject) > 0`）が DB 側で守られなくなる。SSO スライスが入るまで到達経路が無いので実害は先送りされるが、その頃にこのコメントを疑う人はいない
  - 提案: 「`users_auth_method_valid` は直和 CHECK の帰結だが、違反したときに壊れた不変条件を名指しさせるために分けてある。残る2本は帰結ではない — 直和 CHECK は SSO 列が NULL でないことしか言わないので、値集合（`google`/`apple`）と非空はこの2本だけが守っている」と書き分ける。`users_trash_retention_positive` には既に「Independent of the sum constraint」と正しく書けているので、同じ書き方に揃えればよい

- **[W-003]** `burnVerificationTime` の警告ログが「未認証入力で駆動できる per-request ログ」になっている
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:60-73`（`logger.warn`）/ 呼び出しは `:109-113` と `:119-123`
  - 理由: 報告している事実は「このデプロイのハッシャーがダミーを読めない」という**プロセス単位の静的な事実**であるのに、ログはログイン試行1回につき1行出る。しかもこの分岐に入るのは**未登録アドレスと SSO アカウント宛のログイン試行**、つまり攻撃者が自由に量を作れる経路である。等時間化が壊れているデプロイでクレデンシャルスタッフィングを受けると、警告行数は攻撃トラフィックに比例して増える。Cloudflare Workers はログを取りこぼす（Tail Workers のサンプリング）し、CloudWatch は取り込み量で課金される — どちらも「ADR-034 が唯一の signal と位置づけたもの」が、量が増えるほど読めなくなる・高くつくという向きに働く。レート制限は #18 に defer されているので、この経路が保護される見込みも当面ない
  - 提案: 発火をプロセス（isolate）単位に latch する。初回だけ `warn` する形が事実の粒度と一致する。モジュールスコープの可変状態は「アプリケーション層は stateless」という原則とわずかに緊張するので、それを避けたいなら DI で組む Logger デコレータ側に「同一メッセージの抑制」を寄せてもよい。いずれにせよ「1リクエスト1行」でない形にしたい

- **[W-004]** `PasswordHasher` が投げた例外オブジェクトをそのまま `logger` に渡しており、ポート契約が「例外に平文を載せない」ことを保証していない
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:66-71`（`hasher.verify(plainPassword, …)` の `cause` を `logger.warn(msg, { cause })` へ）/ 契約は `packages/core/src/domain/identity/ports/passwordHasher.ts:3-14`
  - 理由: ADR-011（`.issue/1/adr.md:477`）は「**ログへの漏出だけはテストで縛れない**ので、`PlainPassword` 型の値を `logger.*` の引数に渡さないことを PR レビュー観点として残す」と明記している。本 PR はその観点が効く**最初のコード**を追加した。同梱アダプターについては安全であることを確認した — `derive()` は WebCrypto の rejection を `SystemError(CryptoError, "Failed to derive password hash", cause)` で包むだけで入力を載せず、`parse()` の3つのメッセージも保存値・平文のいずれも含まない。したがって**今日の漏出は無い**。問題は契約側で、`PasswordHasher` の JSDoc は「アルゴリズム・パラメータ・エンコーディングは完全にアダプターの business」と広く委ねる一方、**例外に何を載せてよいかを何も言っていない**。入力を message に含める実装（デバッグ用ラッパー、サードパーティ製ハッシャー）を差し込んだ瞬間、平文パスワードがそのままログに出る。ADR-011 が「テストで縛れない」と書いた穴が、まさにその形で1つ開いた状態になっている
  - 提案: どちらか一方で足りる。(a) `ports/passwordHasher.ts` の JSDoc に1行 —「`hash` / `verify` が投げるエラーは `PlainPassword` を message / cause に含めてはならない（呼び出し側がログに出す）」。(b) 渡すメタを非推移的な射影に絞る — `{ cause: cause instanceof Error ? cause.name : typeof cause }`。等時間化が死んだ事実を知るのに必要なのは種別だけで、スタックは要らない。(a) を採れば ADR-011 のレビュー観点を「ポートが禁止した」に格上げできる

- **[W-005]** `hmacSessionCodec` の JSDoc が「codec の差し替えは1ファイルの変更」と主張しているが、ADR-036 の修正でその主張が成立しなくなった
  - 場所: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:47-48`（"Swapping in a table-backed codec later is a one-file change because callers only see this port."）
  - 理由: `packages/core/src/application/di/secrets.ts:5` が**このファイルから** `MIN_SESSION_SECRET_LENGTH` を import するようになった。ADR-036 の Consequences 自身が「セッションの実装方式を差し替えるときは、この import 先も差し替え対象になる」とトレードオフを認めているのに、**アダプター側の JSDoc は更新されていない**。加えて意味論のずれもある — この定数は「HMAC 鍵として使える下限」というアルゴリズム固有の不変条件だが、`requireSessionSecret` はそれを「`SESSION_SECRET` が使える」という一般的な規則として提示する。テーブル方式の codec に差し替えたら `SESSION_SECRET` という変数自体が無くなるので、下限の出所としては噛み合わない
  - 提案: 文を実態に合わせる（「…one-file change **plus the DI floor that references this constant**」）。より筋を通すなら、下限を codec 中立な場所に出して双方がそこを見る形にする。R2 で `fromBase64Url` に対して行った「実態にコメントを合わせる」判断と同じ扱いでよい

- **[W-006]** `bin/app.ts` に新設した `read()` が、**その直前の2行**（`CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION`）に適用されていない
  - 場所: `infra/aws/bin/app.ts:7-8`（`process.env[...]` を直接読む）vs `:17-20`（`read()` の定義）と `:12-16`（その意図を書いたコメント）
  - 理由: `read()` を入れた理由は `:12-16` に「CI では未設定のシークレットが**空文字**で届くので `""` も unset として扱わなければならない」と書かれている。ところが `CDK_DEFAULT_ACCOUNT` / `CDK_DEFAULT_REGION` は同じ規則の外に置かれたままで、しかもこの2つこそ GitHub Actions で `${{ secrets.AWS_ACCOUNT_ID }}` / `${{ vars.AWS_REGION }}` から渡される典型である。`CDK_DEFAULT_ACCOUNT=""` だと `:84` の `account !== undefined` が true になり `env: { account: "" }` が CDK に渡る。`CDK_DEFAULT_REGION=""` だと `?? "us-east-1"` が発火せず `region` が空文字になる。どちらも R2 W-001 の修正が潰したかった「変数名を名指ししないエラーで後段が落ちる」形に戻る
  - 提案: 2行を `read()` に寄せる。`const account = read("CDK_DEFAULT_ACCOUNT");` / `const region = read("CDK_DEFAULT_REGION") ?? "us-east-1";`。ファイル内で env の読み方が1通りになる

- **[W-007]** 完全 ARN の正規表現が部分 ARN を通すケースがあり、**リポジトリ自身の例示値がそれに該当する**
  - 場所: `infra/aws/bin/app.ts:25-26`（`COMPLETE_SECRET_ARN`）/ 例示値は `apps/web/.env.aws.example` の `#SESSION_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789012:secret:session-secret`
  - 理由: 実測した。正規表現末尾の `.+-[A-Za-z0-9]{6}$` は、Secrets Manager が付ける6文字サフィックスの有無ではなく「最後のハイフン以降が6文字の英数か」しか見ていない。`…:secret:session-secret` は `.+` = `session`、`-`、`secret`（6文字）と読めて **`true` になる**。つまり6文字サフィックスの無い部分 ARN が検査を素通りし、`Secret.fromSecretCompleteArn`（`appStack.ts:74`）が `«Only» must use only one of secretCompleteArn or secretPartialArn` という**変数名を一切名指ししないエラー**で落ちる。これは `:22-24` のコメントが「a name or a partial ARN fails the same nameless way an empty string does」と書いて防ごうとした失敗そのものである。同じファイルのもう一方の例示値 `…:secret:turso-auth-token` は `false`（末尾が5文字）になるので、**2つの例示値のうち片方だけが検査を通る**という一貫しない状態でもある
  - 提案: 名前にハイフンが使える以上、正規表現でサフィックスの有無を厳密に判定することは原理的にできない。(a) `.env.aws.example` の例示 ARN を完全 ARN の形（末尾に `-AbCdEf` のような6文字サフィックス）に直し、(b) 正規表現の脇に「これはヒューリスティックで、名前が `-` + 6英数で終わる部分 ARN は通ってしまう」と1行書く。厳密さを取るなら (c) 正規表現をやめ、`AppStack` の構築を `try/catch` で包んで CDK 側のエラーを「どの変数の ARN が不正か」を名指しするメッセージに詰め替える

- **[W-008]** 型で入れた2つのガードに、それが効いていることを表明する `@ts-expect-error` が無い。特に反復回数ピンは**無言で死にうる**
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:30`（`typeof` ピン）/ `packages/core/src/application/types.ts:13`（`Omit`）
  - 理由: ピンが成立しているのは `DUMMY_PASSWORD_HASH_ITERATIONS` が**型注釈を持たない `const`** で、推論結果が literal 型 `210000` だからである。誰かが可読性のつもりで `export const DUMMY_PASSWORD_HASH_ITERATIONS: number = 210_000` と書いた瞬間、`typeof` は `number` に広がり、**型エラーも警告も出さずにピンだけが消える**。そのあと `DEFAULT_PBKDF2_ITERATIONS` を上げても誰も気づかず、R2 W-002 で指摘したオラクル復活がそのまま起きる。`Omit` 側も同様で、`ServiceArgs.container` を `RequestContainer` に戻す変更を止めるものが何も無い。R2 の adapters W-003 が「値のガードに実行が1件も無いのは一貫していない」と指摘して修正された直後に、**同じ理屈が当たる型のガードだけが無検証**で残っているのは対称性を欠く。このリポジトリには既に `entity.test.ts:194` という前例のイディオムがある
  - 提案: 既存のテストファイルに2行足すだけで両方が固定できる。
    ```ts
    // @ts-expect-error the adapter default is pinned to the literal the usecase declares
    const _iterationsDrift: typeof DEFAULT_PBKDF2_ITERATIONS = 600_000;
    // @ts-expect-error usecases must not be able to reach the session codec
    const _codecReach = (c: UsecaseContainer) => c.sessionCodec;
    ```
    どちらも型が緩んだ瞬間に `@ts-expect-error` が unused になって型検査が落ちる

- **[W-009]** `progress.md` の spec-sync 節が、`adr.md` が自ら宣言している spec-sync 対象を取りこぼしている（R2 W-003 の部分解消）
  - 場所: `.issue/1/progress.md:71-79` / 取りこぼし元は `.issue/1/adr.md:357`（ADR-008）・`:382`（ADR-009）・`:477`（ADR-011）
  - 理由: R2 W-003 は「`progress.md` はマージ後に何が残っているかを読む唯一の入口」だと述べたうえで ADR-023 / ADR-024 の転記を求め、その2件は転記された。しかし `grep -n "spec-sync" .issue/1/adr.md` を全件見ると、**自身の Consequences で「spec-sync 対象として残す」と宣言している項目**がほかに3件ある — ADR-008（`spec/inventory/adapter.md` が翻訳点をアダプター責務と書いているが実装はユースケース境界）、ADR-009（spec の「UoW 不要」と実装が `unitOfWorkProvider.run` を通ること）、ADR-011（DOM-identity-006 が漏出防止の実装を欠く部分実装であること）。名指しされた2件だけを足したのでは、R2 が問題にした構図はそのまま残る
  - 提案: 台帳を人手の記憶ではなく `grep` で作る。`grep -n "spec-sync" .issue/1/adr.md` の全ヒットを spec-sync 節に転記し、以後 ADR を追加したら同じ grep を回す運用にする

#### Notes

- **[N-001]** `DUMMY_PASSWORD_HASH` が `PasswordHash.create(...)` ではなく `as PasswordHash` の生キャストで作られている（`loginWithPassword.ts:45-46`）。R2 N-001 と同じ指摘で triage には上がっていない。`PasswordHash` は非空しか見ないので実効差は無いが、このリポジトリはブランド型の発行点を smart constructor 1箇所に絞る方針（ADR-025 が `requireSessionSecret` について明示）で通しており、ここだけ例外になっている。テンプレートリテラルを `PasswordHash.create(...)` で包むだけで揃う。

- **[N-002]** `Email` の JSDoc（`valueObject.ts:39-42`）が「Length is capped at the RFC 5321 path limit」と書くが、RFC 5321 の 320 は**オクテット**上限で、実装は `codePointLength` によるコードポイント計測（ADR-023）。R2 N-002 で挙がって未対応。ASCII アドレスでは差が出ないので実害は無いが、W-005 と同じ「JSDoc の根拠と実装の単位がずれている」系である。「320 の出所は RFC 5321、単位は spec の方針に従いコードポイント」と書き分ければ済む。

- **[N-003]** `reconstruct` が `createdAt` / `updatedAt` を素通しする（`entity.ts:196-197`）。`UserId` / `Email` / `Version` / `TrashRetentionDays` がすべて再検証される中でここだけ検証が無く、ドライバが不正な整数を `new Date(NaN)` にして返した場合 `RehydrationError` にならず `Invalid Date` を持った `User` が組み上がる。R1 W-003 の言及 → R2 N-005 と2度挙がって triage に上がっていないので、**据え置きが判断なのかを一度確定させたい**。`Number.isNaN(date.getTime())` を見るだけで `Version.create` と粒度が揃う。

- **[N-004]** `users_sso_identity_uq` を部分インデックスにした理由の説明が誤っている。`schema.ts:60-61` は「Partial: `PasswordUser` rows leave both SSO columns NULL and **must not collide with each other**」と書くが、SQLite（および標準 SQL）の UNIQUE インデックスは NULL を互いに相異なるものとして扱うので、`WHERE sso_provider IS NOT NULL` が**無くても** `(NULL, NULL)` 行同士は衝突しない。部分化の実利はインデックスサイズと意図の明示であって、衝突回避ではない。**スキーマ自体は spec `:73,75` どおりで正しい**ので直すのは理由の記述だけ。あわせて `d1/__tests__/userRepository.integration.test.ts:214`（"keeps password accounts out of the partial SSO identity index"）は、部分句の有無に関わらず通る性質を検証していることになる。

- **[N-005]** d1 と libsql で OCC ハンドラの帰属ロジックが異なり、d1 側の根拠コメントが誤っている。`d1/pendingBatch.ts:43-47` は「a batch can carry multiple OCC writes …, but D1 stops at the first failure. The guard at index `i` is the one that fired, so … the head handler is the right one to throw」と書くが、`firstConflictHandler()`（`:89-97`）は常に `conflictHandlers[0]` を返す。「最初に失敗した文」と「最初の OCC 書き込み」は別物で、`[updA, guardA, updB, guardB]` で `updB` だけが0行更新なら abort するのは `guardB` なのにハンドラ A が発火し、**衝突していない集約の id と expectedVersion** をメッセージに載せる。libsql（`unitOfWork.ts:83-96`）は `handlerRef.current` で直近の OCC 書き込みを追うので正しい。**本 PR 由来ではない**（`pendingBatch.ts` は無変更）うえ、OCC 対象集約が `users` だけで1 UoW に2件の save を行うユースケースが存在しないため現状到達不能で、エラーコード（`OPTIMISTIC_LOCK_FAILURE`）も変わらない。ただしコメントが「複数 OCC 書き込み」を明示的に正当化しているので、2つ目の OCC 集約を足すスライスでは**コードとコメントの両方**を直す必要がある。両アダプターとも「1 UoW に複数の OCC 書き込み」のテストが無いのが、この差が3ラウンド検出されなかった理由。

- **[N-006]** アダプターがユースケースのモジュールから型を import している（`pbkdf2PasswordHasher.ts:2` → `application/identity/loginWithPassword`）。向きは内向きで `import type` なので実行時の依存は生じない（実測済み）が、**汎用の暗号アダプターが特定の1ユースケースのファイルに結び付く**形になった。`DUMMY_PASSWORD_HASH_ITERATIONS` は本来「パスワード検証のワークファクター」というアダプター側の概念で、置き場が `application/identity/` なのは「依存が内向きでなければならない」制約から逆算した結果である。第2の消費者（別のユースケース、将来の Argon2id アダプター）が現れたときは `application/ports/passwordHasher` 側の定数として括り出す形を検討したい。

- **[N-007]** `application/di/secrets.ts` → `adapters/` は形式上アプリケーション層からアダプターへの外向き import だが、`di/` 配下は既に4本のランタイム配線がアダプターを import しており合成ルートとして機能している。したがって**新たな違反ではない**。ただし CLAUDE.md の「Layers」節は `di/` が合成ルートである旨をどこにも書いていないため、`architecture-audit` を回せば確実に違反として拾われる。CLAUDE.md に1行（「`application/di/` は合成ルートで、アダプターを import してよい唯一の場所」）を足しておく価値がある。

- **[N-008]** `UsecaseContainer` は型だけの制約で、実行時のオブジェクトには `sessionCodec` が載ったままである（presentation が `getContainer()` の戻り値をそのまま渡すため）。したがって `(container as RequestContainer).sessionCodec` や、`ServiceArgs` を使わず自前で引数型を書いたユースケースは素通りする。ADR-035 の意図（「レビュー待ちにしない」）に対しては十分だが、`SessionSecret` ブランドのような「発行点を1つに絞る」型ではない点は認識しておきたい。W-008 の2行目がこの型の退行だけは止める。

- **[N-009]** GCP だけセッション鍵の受け渡しが平文 env である。`infra/gcp/example/services/main.tf:36-43` は `SESSION_SECRET = var.session_secret` を Cloud Run の通常の `env` として展開しており、AWS が Secrets Manager ARN 経由で解決する（`appStack.ts:181` → `server.aws.ts` の `boot()`）のと非対称。変数自体は `sensitive = true` なので plan 出力には出ないが、値は tfstate と Cloud Run のリビジョン仕様に平文で残り、README の手順（`-var "session_secret=$SESSION_SECRET"`）はシェル履歴・CI ログにも露出しうる。変数の description が「Prefer sourcing it from Secret Manager」と勧めているのにモジュール側が `value_source.secret_key_ref` を提供していないのは片手落ちである。`infra/gcp/example/` は例示モジュールなので Note に留めるが、AWS と同じ扱いに揃える価値はある。

- **[N-010]** R2 の Note のうち3件が未対応のまま。triage に上がっていないので必須ではないが、「記述が実態と一致しているか」を重点観点に置く以上、追跡だけしておく。(a) ADR-015 の Consequences（`adr.md:623`）が「未設定のステージは synth からスキップされるだけなので、気づかず不完全なスタックが出る心配はない」と書いたままで、ADR-022 の変更（部分設定は throw）と矛盾する。(b) `apps/web/.env.aws.example` の `SESSION_SECRET` が参照先を「`infra/aws/lib/appStack.ts` — `appFn.environment`」と書くが、そこに載るのは `SESSION_SECRET_ARN`（`appStack.ts:181`）であって `SESSION_SECRET` ではない。正確には `apps/web/app/server.aws.ts` の `boot()` を指す。(c) `docs/runtime_aws.md:3` が CloudFront を「静的アセット用」と書くが、既定ビヘイビアは API Gateway オリジンで動的リクエストも通る（今回修正した Cookie 転送バグの原因がまさにこの認識だった）。

- **[N-011]** ダミー陳腐化検出テストの作り（`identity.integration.test.ts:635-671`）は良い。定数を export して比較するのではなく「ユースケースが実際に `verify` へ渡した文字列」を記録し、それを**本番パラメータの `createPbkdf2PasswordHasher()`** に食わせているので、定数の作り方が変わっても表明が生き残る。あわせて `^pbkdf2-sha256\$210000\$` を表明しているため、テスト用の低コストで作り直した定数に置き換わった場合も落ちる。ADR-033 の判断（export ではなく記録）が実装に正しく現れている。

- **[N-012]** `.dev.vars.example` の `SESSION_SECRET=""` は Cloudflare では「起動は成功するが全リクエストが不透明な 500」という形で失敗する（`requireSessionSecret` の throw が `server.cloudflare.ts:43` の `fetch` 内、`errorResponseMiddleware` の外側で起きるため）。`.dev.vars.example` と `docs/runtime_cloudflare.md:32` の両方が「every request fails until it is set」と予告しており、変数名入りのメッセージは `wrangler dev` のコンソールに出るので開発者は辿れる。Node は boot 時に落ちるのでより良い失敗形になっている。この非対称は ADR-025 / ADR-036 が既に認識しているとおりで、本ラウンドで変更を求めるものではない。

- **[N-013]** 未実装の spec 要素は前ラウンド同様 plan.md のスコープ節と一致していることを再確認した: `UserRepository.findBySsoIdentity`、`TokenScope`、`AiClientConnection` 一式、`IdentityErrorCode.PasswordNotSupported`、`SSO_IDENTITY_ALREADY_REGISTERED` の翻訳。等時間化の導入で未登録アドレスへのログイン試行も本物と同じ CPU を払うようになったため、#18 のレート制限の優先度は上がったままである（W-003 のログ増幅も同じ経路に乗る）。
