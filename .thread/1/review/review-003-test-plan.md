# レビュー 003 — Test / 計画整合 観点（PR #17 / Issue #1）

対象: `issue/1/skeleton-auth` (a214324)
レビュー範囲: 実装チェックリスト75行の完了度 / `spec/testcases/identity/` 39件の突き合わせ / テスト全体のゼロベース再レビュー / plan.md・adr.md・progress.md と実装の整合
前提: 1周目 `review-001-test.md` / 2周目 `review-002-test.md` / 仕分け `triage.md`

## 実測（本レビュー中に実行）

| コマンド | 結果 |
|---|---|
| `pnpm test:unit` | 23 files / **367 passed**（1.25s）※R2 時点 288 → +79 |
| `pnpm test:integration:node` | 6 files / **39 passed**（1.08s） |
| `pnpm test:integration:cf` | 9 files / **104 passed**（2.62s）※R2 時点 102 → +2 |
| `pnpm test:unit` を3回連続 | 367 passed × 3/3（フレークなし） |
| `pnpm typecheck` | 3プロジェクトとも Done |
| `pnpm lint` / `pnpm format:check` | ともに exit 0（24 infos はすべて `useLiteralKeys`、本 PR 非変更ファイル由来） |
| `grep TODO\|FIXME\|XXX\|HACK\|未実装\|仮実装` | `packages/core/src` / `apps/web/app` で **0件** |

## 実装チェックリスト75行の完了度

**75 / 75 完了。未完了・スタブ・未配線はゼロ。**

| 群 | 件数 | 判定 | 根拠 |
|---|---|---|---|
| DOM-* | 14 | 全件実装 | `packages/core/src/domain/identity/{entity,valueObject,events}.ts` / `ports/{userRepository,passwordHasher}.ts`。値オブジェクトは spec の制約（320文字・8〜128文字・`>= 1` 整数・provider 直和）を `codePointLength` で検証、`User` は判別可能ユニオン＋純関数ファクトリ＋`WithEventDrafts` |
| ADP-* | 10 | 全件実装 | drizzle schema `adapters/d1/schema.ts`（libsql は re-export の単一ソース）＋ `migrations/0000_initial.sql` が d1 / libsql でバイト単位一致。snapshot JSON との drift も無し。`users` は AC-5 が名指しする**名前付き CHECK 6本＋インデックス2本**を実際に持つ |
| UC-* | 4 | 全件実装 | `application/identity/{registerWithPassword,loginWithPassword,logout,getCurrentUser}.ts`。`logout` は「何もしない」が spec 定義そのもの（TC-logout-001）で、`logout.test.ts` の tripping container が「触っていないこと」を能動的に表明している |
| PAGE-* | 8 | 全件実装 | `routes/{login,signup,password-reset}.tsx` / `_app.tsx` / `components/auth/*` / `components/layout/AppShell`。**死んだリンク・無反応のダミーボタンはゼロ**（SSO は「置いて動かない」ではなく非描画で回避、`/password-reset` は実ルート＋「準備中」表示で ADR-007 の判断どおり） |
| TC-* | 39 | 全件カバー | 下表 |

### 39件の TC 突き合わせ

39 ID すべてがテスト名に埋め込まれており、かつ `spec/testcases/identity/*.md` の期待結果を実際に検証していることを1件ずつ確認した。**カバーが不十分と判断した ID はゼロ。**

| 配置 | TC |
|---|---|
| `application/identity/__tests__/identity.integration.test.ts`（実 DB 往復） | register-001/002/003/005/007/008/011/012/013/014/015/016、login-001〜011、getCurrentUser-001〜009 |
| `domain/identity/__tests__/valueObject.test.ts` / `.property.test.ts`（VO 境界） | register-004/006/009/010（＋005/007/008 を property で二重に） |
| `application/identity/__tests__/logout.test.ts` | logout-001 |
| `presentation/__tests__/{session,sessionCookie}.test.ts` | logout-002 / 003 |

TC-registerWithPassword-004 / 006 / 009 / 010 は VO 層のみだが、spec が求める「ユーザーは作成されない」は `registerWithPassword` が `Email.create` / `PlainPassword.create` を**リポジトリ到達前**に呼ぶ構造（`registerWithPassword.ts:40-41`）と、同経路を実 DB で通す TC-003（`expect(await userRows(container)).toHaveLength(0)`）で担保されている。妥当な配置。

## 受け入れ基準 AC-1〜AC-18

| AC | 判定 | 根拠（抜粋） |
|---|---|---|
| AC-1〜AC-4 | ○ | `valueObject.test.ts` / `valueObject.property.test.ts` / `entity.test.ts`。`BusinessRuleError<IdentityErrorCode>` のコードまで表明 |
| AC-5 | ○ | `{d1,libsql}/__tests__/userRepository.integration.test.ts` の raw insert × 6 が制約**名**を driver メッセージから確認（→ N-003 に1点だけ弱い箇所） |
| AC-6 | ○ | OCC 0行更新 → `OPTIMISTIC_LOCK_FAILURE`、不整合行 → `DATA_INTEGRITY_ERROR`、レース → `EMAIL_ALREADY_REGISTERED`（TC-014 が `cause` の有無で ADR-008 の catch を踏んだことまで固定） |
| AC-7 | ○ | `pbkdf2PasswordHasher.test.ts`：不一致は `false`、計算失敗のみ `CRYPTO_ERROR`、`timingSafeEqual` は `encoding.test.ts` が全位置差分で表明 |
| AC-8 | ○ | 4ユースケースとも統合テストで実 DB 往復 |
| AC-9 | ○ | `redirectSearch.test.ts`（17拒否ケース＋自オリジン保存の性質）＋ `currentUser.test.ts`（リダイレクト先が `{ redirect: "/settings" }` になること） |
| AC-10 / AC-12 | ○ | `errorField.test.ts` が文言を逐語固定、`errorDisplay.test.ts` がラベル整形と非漏出を固定、`schema.test.ts` が transport 上限の**緩さ**を固定（→ ただし W-001） |
| AC-11 / AC-13 / AC-14 | ○ | ルート・リンクとも実在（`TextLink` は `createLink` 型付き `to` なので死んだリンクはコンパイルエラー） |
| AC-15 | ○ | `noStoreMiddleware.test.ts`（`next()` の**前**に書くことを表明）＋ `currentUser.test.ts`（ガード側の1行）＋ `_app.tsx` の `staleTime: 0` |
| AC-16 | ○ | 39/39 |
| AC-17 | ○ | 上の実測表のとおり全コマンド green |
| AC-18 | ○ | R2 frontend で確認済み。本ラウンドで新規の生値混入なし |

## 2周目指摘の解消状況

| ID | 内容 | 判定 |
|---|---|---|
| B-001 | ダミーハッシュ陳腐化の検出が Fake の上に乗っていた | **解消（提案を超えた）**。`identity.integration.test.ts:635-671` が「ユースケースが `verify` に渡した値」を記録し、本番パラメータの `createPbkdf2PasswordHasher()` に食わせて `resolves.toBe(false)` を表明。`:668` で `DEFAULT_PBKDF2_ITERATIONS` プレフィックスも固定。さらに `:677-692` が握り潰しの効果（未登録メールが 500 にならない）を単独で押さえた。定数を export せず記録方式を採った判断は ADR-033 に、`DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS` の型ピンは ADR-034 に記録済みで、**「形式の陳腐化＝テスト」「コストのずれ＝型検査」の二層**になっている |
| W-001 | relay の暗黙スキップ4箇所 / `unitOfWork` の `code` 未表明2箇所 | **解消**。`eventRelayWorker.integration.test.ts:343/369/422/470` が `expect(rows).toHaveLength(1)` ＋ `throw new Error("outbox row disappeared")` に統一。`{d1,libsql}/unitOfWork.integration.test.ts` は `code === "OPTIMISTIC_LOCK_FAILURE"` まで表明 |
| W-002 | 新設フェイルクローズのガード4本が無テスト | **解消**。`di/__tests__/secrets.test.ts`（新規：unset / 空 / プレースホルダ / floor-1 の4拒否＋**値を漏らさないこと**＋floor ちょうどの受理）、`hmacSessionCodec.test.ts:104-124`、`pbkdf2PasswordHasher.test.ts:132-184`（floor-1 / 0 / 負 / 小数 / NaN / Infinity ＋ floor ちょうど受理）。破損ハッシュ `it.each` に `MAX + 1`・空白付き・指数表記・16進の4行が追加され、天井ちょうどの受理は `deriveBits` をスタブして `parse` だけを対象に分離（`:166-185`）。「落ちる側と境界で通る側を対にする」という方針は ADR-033 に一般則として書かれた |
| W-003 | `Cache-Control` と無効セッション拒否が無テスト | **解消（指摘より一段深い）**。`currentUser.test.ts`（新規152行）が (a) 有効トークン → `["cache-control", "no-store, private"]` が1回、(b) codec が `null` を返す → `/login` へ `{ redirect: "/settings" }`、(c) Cookie 無しなら codec を**呼ばない**ことまで表明。さらに実装側が「ガードだけでは streaming 経路を覆えない」と気づいて権威点をリクエスト境界のミドルウェアに移し（ADR-038）、`noStoreMiddleware.test.ts` が**ヘッダが `next()` より前に書かれること**を固定した |
| W-004 | `errorDisplay` の `FIELD_LABELS` が到達不能 | **解消**。`errorDisplay.test.ts`（新規207行）がラベル整形・複数フィールド・未登録キー・`fieldErrors` 空配列のフォールバック・8種の kind 別文言・`system`/`unknown` の非漏出・`displayError`・`sanitizeRouteError` を網羅 |
| N-006 | 「1回ずつ」の内訳が未固定 | **解消**（`:617-624`。未登録とSSOが同一のダミーを焼き、パスワードアカウントだけ保存値を使うことまで表明） |
| N-003 / N-004 / N-005 / N-007 / N-008 | Note のため triage 未登録 | **未対応**（→ 本レビュー W-002 / N-003 / N-004 / N-005） |

R2 の Blocker 1 件・Warning 4 件は **全件解消**。残るのは Note の一部と、R2 の修正が新しく持ち込んだコードの無テスト（→ W-001）のみ。

---

## Test / 計画整合

### Blockers

なし

### Warnings

- **[W-001]** 送出側の **redaction 境界が丸ごと無テスト**。R2 の仕分けで `fix` と判定されて新設された `guardStreamedRender` も含めて1ケースも無い
  - 場所: `apps/web/app/presentation/errorResponse.ts:91-96`（`redactForClient`）／ `:112-114`（`httpStatusFor`）／ `apps/web/app/presentation/errorResponseMiddleware.ts:27-38`（`errorResponseMiddleware`）／ `:50-59`（`guardStreamedRender`）
  - 理由: 仕分け `deferred RSC の throw が middleware を通らない`(fix) への対応として本 PR が新設した `guardStreamedRender` は、streaming する RSC リーフ（`components/settings/CurrentUserPanel/index.tsx:24`）にとって**唯一の redaction / Logger 到達点**であり、ADR-039 自身が「呼び忘れは型では検出できないので規約として JSDoc に書いた」と限界を明記している。にもかかわらずテストが1件も無く、`toClientError` を経由するもう一方の入口（middleware）も同様に無テスト。
    影響が大きいのは `redactForClient` のほうで、これは3行の純関数だが **AC-10 / AC-12 の文言が「`validation` / `business` / `conflict` を素通しする」ことに直接依存している**。この分岐に `validation` が混ざれば `INVALID_CREDENTIALS` の `code` が `null`・`message` が `"System error"` に潰れ、`errorField.ts:52` の `FIELD_BY_CODE[error.code]` も `errorDisplay.ts` の `code` 引きも同時に外れて、ログイン失敗の文言が全部「システムエラーが発生しました」に化ける。ところが `errorField.test.ts` / `errorDisplay.test.ts` はどちらも `SerializedError` を**直接**渡すので、この退行を1件も検出できない。逆向き（`system` を redact 対象から外す）も、UI 文言は `renderErrorMessage` が kind で潰すので画面には出ず、**ワイヤ上だけ**ドライバ名・テーブル名・絶対パスが載る——ADR-039 が実測で消したはずの漏れがそのまま復活する。
    これは R2 が総評で名指しした「レビュー修正で足したコードにテストを足していない」形の**3ラウンド目の再発**であり、しかも今回は対象が redaction 境界そのもの。
  - 提案: node プールで数行。(a) `redactForClient` に3ケース（`system` / `unknown` は `code === null` かつ固定文言、`validation` は入力と `toEqual` で同一）。(b) `httpStatusFor` は `SERIALIZED_ERROR_KINDS` の全 kind を `it.each` で回し、`Object.keys(HTTP_STATUS_BY_KIND).sort()` が kind 集合と一致することも表明する（kind 追加時に写経漏れが落ちる）。(c) `guardStreamedRender` に3ケース — `redirect` / `notFound` は素通し、`SystemError` は `AppServerError` に包まれ `serialized.message === "System error"`、`ValidationError` は `code` が保たれる。`setResponseStatus` を触らないので `@tanstack/react-start/server` のモックすら不要（`isRedirect` / `isNotFound` は `@tanstack/react-router` の実物で足りる）。

- **[W-002]** `plan.md` の記述が実装と食い違ったまま残っている（R2 N-004 の再指摘、triage 未登録）
  - 場所: `.thread/1/plan.md:909` ／ 実装 `packages/core/src/domain/identity/entity.ts:94-98` ／ テスト `packages/core/src/domain/identity/__tests__/entity.test.ts:188-198`
  - 理由: plan.md は「`changePassword` が `PasswordUser` のみを受けること（**型レベル＋ランタイム**）」をテスト計画として書いているが、実装のコメントは逆に「`the discriminated union makes that a compile error rather than a runtime guard`」と明記しており、ランタイムガードは存在しない。テスト側も `@ts-expect-error` を置いた上で `expect(typeof call).toBe("function")` という**純粋なトートロジー**で締めていて、`call` は一度も呼ばれない。実際の表明は `@ts-expect-error` のほうだけ。
    R2 が「読み手に『ランタイムでも守られている』と誤読させる形が一番よくない」と指摘した箇所で、Note 扱いだったため triage に載らず素通りしている。実装判断としては型レベルのみで正しい（CLAUDE.md「不正状態は型で表現不能にしてから実行時検査に落ちる」に合致）ので、**直すべきは plan.md の字面**。
  - 提案: `plan.md:909` の「（型レベル＋ランタイム）」を「（型レベル）」に直す。あわせて `entity.test.ts:197` の `expect(typeof call).toBe("function")` は消し、`@ts-expect-error` が表明の本体であることをコメントで明示する（`biome-ignore` が要るなら `void call;` で足りる）。

- **[W-003]** `docs/test.md` の Fake policy が本 PR によって陳腐化した。しかも本 PR は同じファイルを編集している
  - 場所: `docs/test.md:33`（"Currently the following **two** are the only fakes kept under `packages/core/src/application/__tests__/fakes/`"）／ 実体 `packages/core/src/application/__tests__/fakes/index.ts`（3本）
  - 理由: 本 PR が `FakePasswordHasher` を新設した（`git diff main -- packages/core/src/application/__tests__/` で新規37行）ことで「2つだけ」は事実と食い違う。`docs/test.md` は本 PR が `todo` → `identity` の例示差し替えのために**実際に編集しているファイル**（3箇所6行）なので、単なる既存の陳腐化ではなく「触ったのに更新しなかった」形。
    `FakePasswordHasher` は「なぜ Fake なのに平文を含まないダイジェストなのか」（ADR-011 / ADR-027、`users.password_hash` に平文が入らないことを Fake 利用の**全**テストで表明可能にするため）という、この文書が説明すべき典型的な判断を持っている。同節が「リポジトリ / UoW / Clock の Fake は意図的に持たない」と書いている以上、「何を Fake にしてよいか」の基準を示す文書としても更新が要る。
  - 提案: `docs/test.md` の Fake policy に `FakePasswordHasher` の項を1つ足し、"two" → "three" に直す。記述内容は `fakePasswordHasher.ts:17-28` の JSDoc がすでに持っているので転記でよい。

### Notes

- **[N-001]** テストの決定性・独立性は良好。`pnpm test:unit` を3回連続で回して 367/367 が安定。`identity.integration.test.ts` の `withUsersTableHidden` / `withInsertBreakingProvider` はともに自前 `finally` を持ち、テーブル名も `HIDDEN_USERS_TABLE` 1箇所に集約されている。`hidden` フラグ（`:154` の `expect(hidden).toBe(true)`）が「usecase が本当に insert に到達した」ことの能動的表明を兼ねている点も引き続き良い。`valueObject.property.test.ts` の fast-check は v4 の既定 unit が `grapheme-ascii` なので、`s.length`（コードユニット）でフィルタしつつ実装が `codePointLength`（コードポイント）で数える差はサンプル空間に現れない — フレーク要因にならないことを確認した（コードポイント計測そのものは `valueObject.test.ts:103-112` の絵文字ケースが別途固定している）。

- **[N-002]** ADR-034 が「等時間化が死んだときの唯一の signal」と位置づけた `logger.warn` が無テスト
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:67-72` ／ テスト `identity.integration.test.ts:677-692`（同じ経路を通るが log を見ていない）
  - `burnVerificationTime` は throw を握り潰すので、リクエストの結果は何も変わらない。ADR-034 が明示的に「ログが唯一の signal になる」と書いた以上、その1行が消えても誰も気づかない状態は惜しい。`:677` のテストはすでに `throwingHasher("verify")` で握り潰し経路を通っているので、`createTestContainer` の `TestContainerOverrides` に `logger` を1つ足して `FakeLogger` を差し込み、`byLevel("warn")` が1件であることを表明すれば同じテスト内で閉じる（`FakeLogger` は既に `byLevel` を持っている）。W-001 と違って実害は観測性の欠落のみなので Note。

- **[N-003]** R2 N-003 の再掲 — `users_auth_method_valid` を単独で狙う行が無い
  - 場所: `packages/core/src/adapters/{d1,libsql}/__tests__/userRepository.integration.test.ts` の `["an unknown auth method", { authMethod: "ldap" }, /users_auth_method_(sum|valid)/]`
  - `authMethod: "ldap"` は `users_auth_method_sum` の直和どちらの枝も満たさないので、SQLite の宣言順評価により `sum` が決定的に先に落ちる。したがって `users_auth_method_valid` を削除しても全6ケースが通る。AC-5 が名指しする6制約のうち、独立に固定されていないのはこの1本だけ。交替をやめて `users_auth_method_sum` に固定し、`valid` 単独を狙う行を別に立てると閉じる。migration snapshot との突き合わせが drift の第二の関門になっているため実害は小さく、Note に留める。

- **[N-004]** R2 N-005 の再掲 — `eventDecoders.test.ts:97-104` の `toThrow()` が kind / code を見ていない
  - 場所: `packages/core/src/application/identity/__tests__/eventDecoders.test.ts:97`
  - このテストの主張は直前の `it.each`（スキーマ不一致 = `SystemError(DATA_INTEGRITY_ERROR)`）との**対比** — 形は合っているが値が不正なら値オブジェクトの `BusinessRuleError` がそのまま出る — なので、`isBusinessRuleError(caught)` ＋ `code === "IDENTITY_INVALID_TRASH_RETENTION_DAYS"` まで見ないと対比が成立しない。現状は `SystemError` が出ても通る。上の `it.each` が `capture` 相当の形をすでに持っているので、同じ形に揃えるだけ。

- **[N-005]** R2 N-007 の再掲 — `FakePasswordHasher` の FNV-1a は32ビットなので原理的に衝突しうる
  - 場所: `packages/core/src/application/__tests__/fakes/fakePasswordHasher.ts:8-15`
  - 現行テストは全て固定文字列なので決定的でフレークにならない。ただし将来 property テストや生成入力と組み合わせると成立しない前提なので、JSDoc に「固定入力専用」を1行足しておくと安全（W-003 の `docs/test.md` 更新と同時にやると効率が良い）。

- **[N-006]** `currentUser.test.ts` が `verifyCalls` の件数を表明しており、React の `cache()` がレンダー外でメモ化しないことに依存している
  - 場所: `apps/web/app/presentation/__tests__/currentUser.test.ts:97 / 107 / 120`
  - R2 の提案は「`cache()` のメモ化は実装詳細なので呼び出し回数までは表明しない」だったが、実装は逆に件数を固定した。判断としてはこちらのほうが強い — `:107` の `expect(verifyCalls).toEqual([])` は「Cookie を読まずに codec を叩いていない」（＝Cookie 読みが飾りでない）を能動的に表明しており、`:120` は「拒否されたトークンでも codec には渡っている」を固定している。ただし React が `cache()` にレンダー外のフォールバック・メモ化を入れた場合、`beforeEach` を跨いだ最初のテストの結果が残って2番目以降が落ちる。3回連続実行では安定を確認済みなので現状のままでよいが、React の major 追従時にここが落ちたら**実装の退行ではなく前提の変化**として読むべき、というコメントを1行残しておくと後任が迷わない。

- **[N-007]** `docs/test.md` の Commands 表が存在しないスクリプトを案内している
  - 場所: `docs/test.md:69-70`（`TEST_DOMAIN=identity pnpm test:domain` / `pnpm test:domain-layer`）
  - `test:domain` / `test:domain-layer` はルート・`apps/web`・`packages/core` のどの `package.json` にも存在しない（grep 実測）。main 時点から `TEST_DOMAIN=todo` として壊れていた既存の陳腐化だが、**本 PR がこの2行を編集している**（`todo` → `identity`）ので、動かないことに気づく機会はあった。W-003 と同時に、行を落とすかスクリプトを足すかを決めたい。同様に `docs/test.md:35` の「prefix は `f0...`」も実装（`ffffffff-ffff-7fff-8fff-`）と不一致（これは main 由来で本 PR 無関係）。

- **[N-008]** GitHub Issue #1 本文のチェックボックスが75行とも `[ ]` のまま。実装は全件完了しているので、マージ時に一括チェックするか、PR 本文で「75/75 完了」を明示しておくと、Issue を見た人が進捗を誤読しない。`.thread/1/progress.md:5` は「実装チェックリスト75行はすべて実装済み」と正しく書けている。

- **[N-009]** `progress.md` は R2 の陳腐化指摘が解消され、実装の現状と一致していることを確認した。「spec-sync 対象」節の6項目（TC-logout-003 の層 / トークン派生値 / ヘルパー文 / ADP-identity-012 のハッシュ方式 / 長さの単位 / `changeTrashRetentionDays` の no-op）はいずれも実装と一致し、対応する ADR も存在する。本レビューの独立調査で新たに見つかった spec 未反映は「`registerWithPassword.ts` が `EMAIL_ALREADY_REGISTERED` の翻訳点である（ADR-008）」「`PlainPassword` の `toString` 無効化が型的に不可能（ADR-011）」「outbox の実テーブル名が `outbox_events`」の3点だが、いずれも `progress.md:71-78` にすでに記載済みか ADR に記録済みで、**乖離の記録漏れは無い**。`UserRepository.findBySsoIdentity`（spec は5メソッド・実装は4）も `plan.md:231` に「SSO スライスで追加する」と明記されている。

---

## 総評

**Blocker はゼロ。マージ可（W-001 のみ条件付き）。**

2周目の Blocker 1件・Warning 4件は全件解消しており、しかも複数箇所で提案の水準を超えている。とくに B-001 への対応は、指摘が示した2案（定数を export する／渡された値を記録する）のうち後者を選び、その理由を ADR-033 に「記録方式は値の作られ方に依存しないので、定数がリテラルから組み立てに変わってもテストが無変更で追随する」と書き残した上で、実際にその変更（ADR-034 の `DUMMY_PASSWORD_HASH_ITERATIONS` 導入）を同じラウンドで通している。W-003 への対応はさらに良く、指摘が求めた「ガードにテストを足す」で止めず、**ガードが streaming 経路を覆えないという実装側の欠陥を発見してキャッシュ禁止の権威点をリクエスト境界に移した**（ADR-038）。テストの追加が設計の欠陥を炙り出した形で、レビューループが機能している。

実装チェックリスト75行は全件完了。TODO / FIXME / 空実装は全リポジトリで0件、型だけあって中身が無いメソッドも無く、`UserRepository.save` と `Actor` に production の呼び出し元が無いのは後続スライスに使う側があるだけで、いずれも実 DB 往復のテストを持っている。39件の TC は形式・実質ともに全件カバーされ、テスト名に ID が埋まっている。**「見せかけの実装」「見せかけのカバー」に該当するものは検出できなかった。**

残る W-001 は、3ラウンド連続で現れている「レビュー修正で足したコードにテストを足していない」形の再発で、今回はその対象が redaction 境界そのものである点だけが従来と違う。`redactForClient` は3行の純関数、`guardStreamedRender` は9行、`httpStatusFor` は1行の表引きで、いずれも node プールで依存ゼロに近く書けるため、閉じるコストは低い。W-002 / W-003 は plan.md と docs/test.md の字面修正で、実装への変更を伴わない。

**マージ判断: 条件付き可。** 条件は W-001 の (a) `redactForClient` 3ケースと (c) `guardStreamedRender` 3ケースを足すこと（(b) は任意）。W-002 / W-003 / N-007 のドキュメント修正は同じコミットで済ませられる。N-002〜N-006 は本 Issue の完了条件外なので、次スライスまたは spec-sync に送ってよい。
