# レビュー 001 — Test 観点（PR #17 / Issue #1）

対象: `origin/issue/1/skeleton-auth` (8eb58d8)
レビュー範囲: `domain/identity/__tests__` / `application/identity/__tests__` / `application/di/__tests__` / `adapters/webcrypto/__tests__` / `adapters/{d1,libsql}/__tests__` / `apps/web/app/presentation/__tests__` / todo から移植した共通基盤・relay / consumer 統合テスト

## 実測（レビュー中に実行したもの）

PR ブランチを worktree に取り出し、依存をインストールして実行した。

| コマンド | 結果 |
|---|---|
| `pnpm test:unit` | 14 files / **150 passed** (1.14s) |
| `pnpm test:integration:cf` | 9 files / **88 passed** (4.79s) |

さらに **TC-registerWithPassword-014 が本当にレース経路を通っているか**を捨てテストで実測した（`registerWithPassword` の事前検証経路は `cause` を持たず、ADR-008 の読み替え経路は `cause` に元の `ConflictError(UNIQUE_VIOLATION)` を持つ、という差で判別）。

```
RUN 0..9: fulfilled=1 rejected=1 paths=["RACE"]   （10/10）
```

**10 回すべてで「1件成功 / 1件が UNIQUE 制約違反経路で失敗」** となった。つまりこのテストは現状 ADR-008 の catch を実際に踏んでいる。ただし表明の側がそれを固定していない（→ W-001）。

## 39 件の TC 突き合わせ

全 39 ID がテスト名に埋め込まれていることは機械的に確認済み（欠落ゼロ）。以下は **中身が spec の期待結果を検証しているか**の判定。

| TC | テスト | 期待結果を検証しているか |
|---|---|---|
| register-001 | identity.integration.test.ts:133 | ○ users 行（version:0 / authMethod / sso 列 NULL）＋ outbox 行の payload 完全一致まで表明 |
| register-002 | valueObject.test.ts:50 / integration:165 | ○ VO と永続化列の両方 |
| register-003 | valueObject.test.ts:59 / integration:178 | ○ `code === IDENTITY_INVALID_EMAIL` ＋ users / outbox が空 |
| register-004 | valueObject.property.test.ts:36,55 | ○ 321 固定＋321..820 の property |
| register-005 | valueObject.property.test.ts:29,44 | **△ VO 層のみ**（spec の期待は「正常に登録される」）→ W-002 |
| register-006 | valueObject.test.ts:78 / property:84 | ○ |
| register-007 | valueObject.property.test.ts:93 | **△ VO 層のみ** → W-002 |
| register-008 | valueObject.property.test.ts:100 | **△ VO 層のみ** → W-002 |
| register-009 | valueObject.property.test.ts:107,150 | ○ |
| register-010 | valueObject.test.ts:85 | ○ |
| register-011 | integration:197 | ○ `ConflictError("EMAIL_ALREADY_REGISTERED")` ＋ 行数1 |
| register-012 | integration:219 | ○ 残存行が SSO のままであることも表明 |
| register-013 | integration:244 | ○ |
| register-014 | integration:270 | **△ 経路も件数も固定していない** → W-001 |
| register-015 | integration:294 | **△ スタブが投げた値をそのまま見ている** → W-003 |
| register-016 | integration:316 | ○ `DATABASE_ERROR` ＋ users / outbox 空。障害注入の設計も正しい（→ N-003） |
| login-001..007 | integration:356〜458 | ○ `isValidationError` ＋ `code` まで。006 / 007 は `isBusinessRuleError(error) === false` も明示 |
| login-008 | integration:463 | ◎ `toSerialized()` の完全一致（kind / code / message / retryable）を5経路で相互比較＋期待値固定 |
| login-009 | integration:499 | ○ 実 PBKDF2（1,000回）で8文字往復 |
| login-010 | integration:518 | ○ `SystemError(DATABASE_ERROR)` |
| login-011 | integration:536 | **△ W-003**（`isValidationError === false` の表明は良い） |
| logout-001 | logout.test.ts:47 | ◎ 全ポートを trip するコンテナで「触っていない」を能動的に表明 |
| logout-002 | sessionCookie.test.ts:44,58,73 / session.test.ts:9 | ◎ 属性集合の完全一致＋「発行時と同じ属性集合であること」まで |
| logout-003 | sessionCookie.test.ts:82,93 / session.test.ts:21,42 | ◎ `endSession` 実体＋`serializeError` が `kind:"system"` を返すところまで |
| getCurrentUser-001/005 | integration:558 | ○ view 全体を `toEqual` |
| getCurrentUser-002 | integration:578 | ○ |
| getCurrentUser-003 | integration:588 | ◎ キー集合の完全一致＋値の非包含 |
| getCurrentUser-004 | integration:609 | ◎ 同上（provider / subject 文字列の非包含も） |
| getCurrentUser-006 | integration:626 | ○ `changeTrashRetentionDays` → `save` → 再取得 |
| getCurrentUser-007 | integration:652 | ○ `NotFoundError("USER_NOT_FOUND")` |
| getCurrentUser-008 | valueObject.test.ts:34,41 | **△ VO 層のみ**（`getCurrentUser` を空 userId で呼ぶテストは無い）→ W-002 |
| getCurrentUser-009 | integration:667 | ○ |

**カバーが不十分と判断した ID: TC-registerWithPassword-005 / 007 / 008、TC-getCurrentUser-008（VO 層止まり）、TC-registerWithPassword-014（表明の弱さ）、TC-registerWithPassword-015 / TC-loginWithPassword-011（トートロジー）。**

---

## Test

### Blockers

- **[B-001]** オープンリダイレクト防止（`redirectSearch.ts`）にテストが1件も無い
  - 場所: `apps/web/app/presentation/redirectSearch.ts:24-46`（テストファイル無し）／利用地点 `apps/web/app/presentation/currentUser.ts:41`
  - 理由: 本 PR が新規追加した唯一のオープンリダイレクト防御であり、`value.startsWith("/") && !value.includes("//") && !value.includes("\\") && !value.startsWith("/%2f")` という**細かい否定条件の組み合わせで成立している**。条件が1つ欠けても型検査・lint・既存テストのいずれにも引っかからず、`?redirect=//evil.example` が通る。plan.md「リスクと注意点」自身が「相対パス限定のバリデーションを `validateSearch` と server fn の両方に置く」と明記しているのに、その置いた結果を確認する自動テストが無い。`zod` スキーマの純関数で `server-only` を import しないため、node プール（既に `apps/web/app/presentation/__tests__/` が走っている）でゼロコストに書ける。他の presentation 純関数（`sessionCookie.ts`）にはテストがあるのに、より危険なこちらだけ空白なのは整合しない。
  - 提案: `apps/web/app/presentation/__tests__/redirectSearch.test.ts` を追加し、`toSafeRedirect` / `redirectPathSchema` について最低限次を表明する。
    - 通す: `/`、`/settings`、`/settings?tab=a`、`/a/b/c`
    - 弾く（`undefined` になる）: `//evil.example`、`https://evil.example`、`http:/evil`、`/\evil.example`、`\\evil.example`、`/%2f%2fevil.example`、`/%2F/evil`、`evil.example`（先頭 `/` 無し）、`""`、2049 文字
    - `redirectSearchSchema.parse({ redirect: "//evil" })` が **throw せず `{ redirect: undefined }`** に落ちること（`validateSearch` 用の `catch` 側の契約。ここが throw に変わるとルートごと壊れる）
    - あわせて `requireUserId()` が `?redirect=` に汚染された `getRequestUrl()` を渡しても安全な値しか載せないこと（`toSafeRedirect` に通していることの回帰ガード）

### Warnings

- **[W-001]** TC-registerWithPassword-014 の表明が「レース経路を通ったこと」も「1件だけ成功すること」も固定していない
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:279-290`
  - 理由: 実測では 10/10 でレース経路（`cause` 付き）を通っており現状は有効だが、表明は `expect(rejected.length).toBeGreaterThanOrEqual(1)` と `userRows.length === fulfilled.length` だけなので、次の2つの退行を検出できない。
    1. **両方失敗しても green**（`fulfilled=0 / rejected=2` なら users 0件・outbox 0件で全表明が成立する）。「誰も登録できない」という致命的な退行がテストを通り抜ける。
    2. **事前検証経路に落ちても green**。`findByEmail` が相手の書き込みを見えるようになった（read-your-write の変化、UoW のフラッシュ順序の変化）場合、ADR-008 の `UNIQUE_VIOLATION → EMAIL_ALREADY_REGISTERED` 読み替えは一度も実行されなくなるが、ユーザーから見えるコードは同じなのでテストは通る。**この catch を踏む唯一のテストがこれ**（011/012/013 はすべて事前検証経路、`userRepository.integration.test.ts` は `UNIQUE_VIOLATION` までしか見ない）なので、ADR-008 の実装が丸ごと死んでも誰も気づかない。
  - 提案: 次の2行を足す。実測どおり決定的なので厳しくして問題ない。
    ```ts
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    // 事前検証経路は cause を持たない。ADR-008 の読み替えを通ったことの証拠。
    expect(isConflictError(failure.reason) && failure.reason.cause).toBeDefined();
    ```
    もし将来的に非決定になるなら、`cause` の有無での分岐（`RACE` なら cause あり）を許容しつつ「少なくとも1回はレース経路を通る」ことを N 回ループで確認する形にする。

- **[W-002]** 境界の「正常に登録される」系 TC が VO 層でしか検証されておらず、transport 境界を跨いだ経路が自動テストに存在しない
  - 場所: `packages/core/src/domain/identity/__tests__/valueObject.property.test.ts:29,93,100` / `valueObject.test.ts:34,41`（対応する統合テストが無い）
  - 理由: spec/testcases の期待は **「320文字のメールで登録する → 正常に登録される」「128文字のパスワードで登録する → 正常に登録される」「userId に空文字を指定して取得する → BusinessRuleError」** とユースケース層の操作で書かれている。現状の自動テストは `Email.create` / `PlainPassword.create` / `UserId.create` が受理・拒否することしか見ていない。plan.md 自身が「transport スキーマにパスワードの長さ制約を書くとエラー種別が変わる」を最大級のリスクとして挙げ、`AUTH_FIELD_MAX_LENGTH = 1024` に留めているのに、**その 1024 が 128 や 255 に書き換わったことを検出する自動テストが1件も無い**（`apps/web/app/components/auth/schema.ts` は無テスト）。現状は手動テスト TC-34/35/36 だけが関門で、AC-16 の「自動テストで確認できる」を満たしていない箇所が3件残る。
  - 提案: `identity.integration.test.ts` に3ケース足す（いずれも数行）。
    - 正規化後ちょうど320文字のメールで `registerWithPassword` が成功し、`users.email` が320文字で保存されること（TC-005）
    - ちょうど8文字 / ちょうど128文字のパスワードで登録が成功すること（TC-007 / 008。008 は実ハッシャーである必要はない）
    - `getCurrentUser({ input: { userId: "   " } })` が `BusinessRuleError(InvalidUserId)` を投げること（TC-getCurrentUser-008。`logout.test.ts:62` が同じ形をすでに持っているので写せる）
    - 加えて `components/auth/schema.ts` に対し「128文字パスワード / 320文字メールが `loginSchema.parse` を通る」「1025文字は弾く」だけの単体テストを置くと、transport 上限の退行が型検査を待たずに落ちる

- **[W-003]** ハッシャー失敗系（TC-registerWithPassword-015 / TC-loginWithPassword-011）の `code` 表明がトートロジーで、実アダプターの `CryptoError` 翻訳は無テスト
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:66-79`（スタブ）, `:307`, `:552` ／ 未テストの実装 `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:50-56`
  - 理由: スタブ自身が `new SystemError(SystemErrorCode.CryptoError, ...)` を投げているので、`expect(error.code).toBe("CRYPTO_ERROR")` は「スタブに書いた値がスタブから出てきた」ことしか言っていない。spec の期待は `SystemError` なので TC としては満たすが、**「WebCrypto が throw したら `SystemError(CryptoError)` になる」という実際の翻訳（`derive()` の catch）はどのテストでも実行されていない**。`pbkdf2PasswordHasher.test.ts` は形式不正（`DataIntegrityError`）側は5ケース網羅しているのに、`CryptoError` 側は0ケース。ADR-014 が分けた2種類のうち片方が空洞になっている。
  - 提案: `pbkdf2PasswordHasher.test.ts` に `vi.spyOn(crypto.subtle, "deriveBits").mockRejectedValue(new Error("boom"))`（または `importKey`）で `hash` / `verify` が `SystemError(CRYPTO_ERROR)` を投げ `cause` を保つことを表明するケースを足す。これで「アダプターが翻訳する → ユースケースは素通しする」の鎖が両端とも閉じる。

- **[W-004]** 移植した OCC ガード / UoW テストに、暗黙スキップと型を見ない表明が残っている
  - 場所: `packages/core/src/adapters/libsql/__tests__/occGuard.integration.test.ts:54,78,99` / `packages/core/src/adapters/libsql/__tests__/unitOfWork.integration.test.ts:87` / `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts:84`
  - 理由: `if (!found) return;` は `findById` が null を返した瞬間に**何も検証せずテストが green で終わる**。OCC 失敗経路・`_occ_guard` 空表明・outbox ロールバックという、このファイルが存在する理由そのものが丸ごとスキップされる。さらに `occGuard.integration.test.ts:88-99` は `let threw = false; ... expect(threw).toBe(true)` で、**どんな例外でも通る**（スキーマ破壊で `no such table` が出ても green）。同ファイルの d1 側（`unitOfWork.integration.test.ts:107`）は `isConflictError(caught)` まで見ているので、libsql 側だけ弱い。テンプレートからの持ち越しであり検証力は「移植前と同等」だが、ADR-001 の Consequences が「移植を怠ると OCC ガードの検証が空洞化する」を明示的なレビュー観点に指定している以上、移植のタイミングで閉じるべき穴。同 PR 内の新規テスト（`userRepository.integration.test.ts:135,160`、`identity.integration.test.ts:636`）は `throw new Error("seeded user disappeared")` に正しく改めてあり、そちらが基準形になっている。
  - 提案: 5箇所の `if (!found) return;` を `if (!found) throw new Error("seeded user disappeared");`（新規テストと同じ形）に揃える。`expect(threw).toBe(true)` は `expect(isConflictError(caught)).toBe(true)` ＋ `expect(caught.code).toBe("OPTIMISTIC_LOCK_FAILURE")` に置き換える。

- **[W-005]** AC-10 / AC-12 の文言とフィールド振り分けを担う presentation の純関数が無テスト
  - 場所: `apps/web/app/components/auth/errorField.ts:37-92`（`toAuthErrorDisplay`）／ `apps/web/app/presentation/errorDisplay.ts:22-45`（`renderBusinessMessage` / `renderValidationMessage`）
  - 理由: AC-10 は「失敗時は『メールアドレスまたはパスワードが正しくありません』を表示」、AC-12 は「メール形式不正・パスワード要件未満は項目ごとに、登録済みメールは重複エラー＋ログイン導線」を要求している。これを実際に決めているのはこの2つの**純関数**で、依存は `SerializedError` だけ。`jsdom` も RTL も要らず node プールで直接呼べるのに、検証は手動テストだけに委ねられている。`FIELD_BY_CODE` から1エントリ落ちても、`showLoginLink` が常に false になっても、型検査もテストも通る。`docs/test.md` の「Frontend はミニマム」は Conform / React 19 の挙動に依存する部分を指しており、自前のマッピングテーブルまで免除する趣旨ではない。
  - 提案: `toAuthErrorDisplay` に対し (a) `business/IDENTITY_INVALID_EMAIL` → email フィールド、(b) `business/IDENTITY_PASSWORD_TOO_WEAK` → password フィールド、(c) `conflict/EMAIL_ALREADY_REGISTERED` → email ＋ `showLoginLink: true`、(d) `validation/INVALID_CREDENTIALS` → form（`showLoginLink: false`）、(e) `fieldErrors` 付き validation → 各フィールド、の5ケースを表明する単体テストを置く。(d) の文言一致は AC-10 の直接の担保になる。

- **[W-006]** `startSession` が無テスト（`endSession` だけ検証されている）
  - 場所: `apps/web/app/presentation/session.ts:41-51`（テストは `endSession` のみ: `apps/web/app/presentation/__tests__/session.test.ts`）
  - 理由: ADR-020 の実測で `server-only` を含むこのモジュールが node プールから読めることは確認済みで、`setCookieHeader` が注入可能な設計になっている。にもかかわらずログイン成功時の Cookie 発行側は一度も実行されていない。`buildSessionCookie(token, ...)` に `null` を渡してしまう / `Max-Age` を付け忘れる、といった変更が自動テストで検出できない（発行側の属性表明は `sessionCookie.test.ts` の純関数レベルにしか無く、`startSession` が本当にそれを呼ぶかは未検証）。`getContainer()` の解決が要るぶん `endSession` より手間だが、`sessionCodec` をスタブに差し替えた `RequestContainer` を積む形で書ける。
  - 提案: `startSession(userId, sink)` が (1) `sessionCodec.issue(userId, clock.now())` を1度だけ呼び、(2) その戻り値を値に持つ Cookie を sink に1本書き、(3) sink が throw したら `SystemError(SESSION_ERROR)` になることを表明する。(3) は `endSession` と同じ `writeSessionCookie` を通るので、分岐が共有されていることの回帰ガードにもなる。

- **[W-007]** 「平文ではなくハッシュが保存される」を実ハッシャーで確認するテストが無く、TC-001 の該当表明は Fake 下でほぼ無内容
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:152` / `packages/core/src/application/__tests__/fakes/fakePasswordHasher.ts:15-17`
  - 理由: `FakePasswordHasher.hash` は `` `fake$${plain}` `` を返すので、既定コンテナでの `users.password_hash` は **平文を部分文字列として含む**。`expect(users[0]?.passwordHash).not.toBe(PASSWORD)` は `fake$` が前置されている限り必ず真になり、実質何も縛っていない。ADR-011 が「永続化への漏出は `users` に平文列が無いことで構造的に閉じている」と言うのは正しいが、**「hash を呼んだ結果を保存している（平文をそのまま入れていない）」という別の性質**は、実ハッシャーを使う唯一のテスト（TC-loginWithPassword-009）が列を覗かないため、どこでも確認されていない。
  - 提案: TC-loginWithPassword-009 のコンテナ（実 PBKDF2 / 1,000 回）を使って `users.password_hash` が `pbkdf2-sha256$1000$` で始まり平文を含まないことを1行足す。あるいは TC-001 の該当行を `expect(users[0]?.passwordHash).not.toContain(PASSWORD)` に変えたうえで Fake を `sha-ish` なダイジェスト風の値（平文を含まない形）に改めると、Fake を使う全テストで「平文が列に入らない」が効くようになる。後者のほうが波及効果が大きい。

- **[W-008]** 統合テストの障害注入がスキーマ（`ALTER TABLE users RENAME`）を触るため、失敗時にファイル全体を巻き込む
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:82-92`（`withUsersTableHidden`）, `:99-124`（`providerBreakingAtInsert`）, `:331-333`（テスト側の `finally`）
  - 理由: rename が戻らないと、グローバル `setupFiles`（`packages/core/src/adapters/d1/__tests__/setup.ts:14-20`）の `DELETE FROM users` が `no such table: users` で落ち、**D1 プールの後続テストが全滅する**（ADR-019 も「`finally` の rename が失敗すると同一ファイルの後続テストが道連れになる」と認めている）。加えて rename 先の文字列 `users_hidden` が3箇所にリテラルで散っており、TC-016 では wrapper と test 本体の**2箇所に分かれて**戻し処理が置かれている（wrapper が rename し、test の `finally` が戻す）。この非対称は読み手に「wrapper 側が戻すのか test 側が戻すのか」を追わせる。
  - 提案: rename / 復帰の対を1つのヘルパーに閉じ、`providerBreakingAtInsert` 版も「注入したら必ず自分で戻す」形（`finally` をヘルパー内に持つ）に揃える。テーブル名も定数化する。ADR-019 の設計自体は妥当なので、変更は堅牢化に留めてよい。

### Notes

- **[N-001]** 39 件すべてがテスト名に TC ID を持ち、機械的な突き合わせで欠落ゼロ。実行も unit 150 / cf 88 がすべて green（本レビューで実測）。ID をテスト名に埋める方針は spec ↔ テストの追跡を容易にしていて良い。

- **[N-002]** TC-registerWithPassword-016 の障害注入設計が良い。`UnitOfWorkContext` をラップして `insert` が pending batch に積んだ**直後**に rename する形なので、事前検証の `findByEmail` は必ず成功済みであることが構造的に保証される。しかも「rename が起きていなければ test の `finally` の `ALTER TABLE users_hidden RENAME TO users` が失敗して落ちる」ため、`finally` が実質的な「insert に到達したこと」の表明として機能している（意図的でないなら、この性質はコメントに残す価値がある）。ロールバックを users / outbox の**両方**が空であることで見ている点も、単なる「エラーが出た」より一段強い。

- **[N-003]** TC-loginWithPassword-008 が本レビューの重点観点をきちんと満たしている。`error.toSerialized()` を5経路ぶん集めて相互に `toEqual` したうえで、`{ kind: "validation", code: "INVALID_CREDENTIALS", message: "Invalid email or password", retryable: false }` と期待値も固定している（`identity.integration.test.ts:476-494`）。`kind` / `code` / `message` の完全一致要求に対して過不足がない。

- **[N-004]** TC-logout-001 の `trippingContainer`（`logout.test.ts:13-43`）は「何も起きないこと」を**能動的に**検証する形になっている。`unitOfWorkProvider` / `passwordHasher` / `sessionCodec` の全メソッドを throw + 記録に差し替えたうえで `expect(touched).toEqual([])` を見るので、将来ユースケースが余計な依存に触れた瞬間に落ちる。「永続化が発生しないこと」を DB 行数で見る受動的な書き方より強い。

- **[N-005]** `requestContainerConfig.test.ts` が **4ランタイム分をキー集合の列挙**（`expect(Object.keys(config).sort()).toEqual(APP_CONFIG_KEYS)`）で縛っているのは、plan.md が指摘した rest-spread の穴（`satisfies` が余剰プロパティ検査をしない）に対する正しい恒久ガード。既知の犯人を `not.toContain` するだけの形にしていない点が良い。`loadAppContext` 自体は未テストだが、供給元である `container.config` を押さえるほうが構造的に正しく、ここは追加不要と判断する。

- **[N-006]** `d1/__tests__/helpers.integration.test.ts` は移植で**検証力が上がっている**（PK 衝突に加えて `users_email_uq` 違反ケースが新設され、ADR-008 が依存する分類が2方向から押さえられた）。`libsql` / `d1` の `userRepository.integration.test.ts` も片方が sed で置換できるレベルの構造一致になっており、2アダプターが同じ契約を満たすことのペア検証として読める。

- **[N-007]** `entity.test.ts:80` の `expect(containsString(eventDrafts, PLAINTEXT)).toBe(false)` は**原理的に落ちない**。`User.registerWithPassword({ id, email, passwordHash }, now)` に平文を渡す引数が存在せず、`PLAINTEXT` はテスト内で独立に作られた値だからである。ADR-011 が期待した「イベントへの漏出防止」を実効的に担保しているのは、同ファイル :76-79 のキー集合表明と、`identity.integration.test.ts:161` の outbox payload 完全一致（`toEqual({ userId, authMethod })`）のほう。`containsString(eventDrafts, HASH)` は HASH が実際に引数として渡っているので意味がある。害はないが、「これが漏出を止めている」と読まれないよう注記しておく価値がある。

- **[N-008]** `identity` に entity の property テストが無い（`domain/todo/__tests__/entity.property.test.ts` は削除されたまま）。`docs/test.md` は property の対象に「エンティティの状態遷移・冪等性」を挙げており、`changeTrashRetentionDays` の冪等性（同値なら version 据え置き・イベントなし）は現在 `entity.test.ts:228` の1例のみ。TC 要求ではないので必須ではないが、後続スライスで memo / knowledge のエンティティが増えるときの基準形として1本あってもよい。

- **[N-009]** `valueObject.property.test.ts` の boundary 設計が丁寧。`fc.string({ minLength, maxLength })` の生成単位と `String.length` がずれうる点を `.filter((s) => s.length >= 8 && s.length <= 128)` で明示的に潰しており（:118-127, :139-140）、境界を「ランダム生成に任せる」のではなく `emailOfLength(320)` / `"a".repeat(129)` の**固定ケースを別に置いたうえで** property を補助として使っている。320/321・7/8/128/129 はすべて固定ケースで直撃しており、重点観点の懸念は当たらない。

- **[N-010]** テストの決定性は良好。`Clock` はテスト内の定数 `Date` か `SystemClock`（時刻に依存する表明が無い）、id は `FakeIdGenerator` か実 UUIDv7（値を表明しない）で、乱数依存の表明は無い。並行実行を使うのは TC-014 と `outboxRepository` の claim 競合のみで、いずれも実測で安定。ファイル間の共有状態は D1 の単一バインディングだが `setup.ts` の `beforeEach` TRUNCATE と `afterEach` の `_occ_guard` 空表明で閉じている（後者を残した判断は良い）。唯一の懸念が W-008 の rename。

---

## 総評

39 件の TC は形式的にも実質的にも**ほぼカバーされている**。とくに TC-loginWithPassword-008（失敗応答の同一性）、TC-getCurrentUser-003 / 004（非露出）、TC-logout-001 / 002 / 003 は、重点観点が要求する強度（キー集合・シリアライズ形の完全一致・能動的な非接触検証）をきちんと満たしており、「テスト名に ID があるだけ」の見せかけは無い。TC-registerWithPassword-016 の障害注入も、事前検証で落ちない構造になっていることを確認した。

一方で、**テストが存在しないところに穴が寄っている**。`redirectSearch.ts`（オープンリダイレクト）はテストゼロで、これは本 PR が新規に持ち込んだセキュリティ境界なので Blocker とした。次いで、実アダプターの `CryptoError` 翻訳（W-003）、AC-10 / AC-12 を実際に決めている presentation の純関数（W-005）、`startSession`（W-006）が、いずれも「node プールで数行書けば閉じるのに空白」という共通の形をしている。

表明の強度で直すべきは TC-014（W-001）と移植した OCC ガード（W-004）の2つ。前者は ADR-008 の catch を踏む唯一のテストなのに経路を固定していない、後者は `if (!found) return;` の暗黙スキップが残っている。どちらも数行の変更で閉じる。
