# レビュー 002 — Test 観点（PR #17 / Issue #1）

対象: `issue/1/skeleton-auth` (e805e4f)
レビュー範囲: `packages/core/src/**/__tests__/` / `apps/web/app/**/__tests__/`
前提: 1周目 `.thread/1/review/review-001-test.md` / 仕分け `.thread/1/review/triage.md`

## 実測（本レビュー中に実行）

| コマンド | 結果 |
|---|---|
| `pnpm test:unit` | 18 files / **288 passed** (1.24s) |
| `pnpm test:integration:node` | 6 files / **39 passed** (0.89s) |
| `pnpm test:integration:cf` | 9 files / **102 passed** (2.49s) |
| `identity.integration.test.ts` を10回連続実行 | **34 passed × 10/10**（TC-014 のレース表明が厳格化された後もフレークなし） |

1周目は `test:integration:node`（libsql / node アダプター / node ランナー）が実行されていなかったが、本レビューで実行し全件 green を確認した。

## 1周目指摘の解消状況

| ID | 内容 | 判定 |
|---|---|---|
| B-001 | `redirectSearch` のテスト欠如 | **解消**（`redirectSearch.test.ts` 151行。提案された攻撃ベクタを全網羅し、さらに `_` 始まり・制御文字・二重エンコードまで追加。`ORIGIN` 解決の property テストは列挙より強い） |
| W-001 | TC-014 のレース経路が固定されていない | **解消**（`status` の集合一致で「両方失敗」を排除、`cause` の有無で ADR-008 の catch を踏んだことを固定。10回実測で安定） |
| W-002 | 境界 TC が transport を跨がない | **解消**（TC-005 / 007 / 008 / getCurrentUser-008 に統合テストを追加、`components/auth/__tests__/schema.test.ts` で `AUTH_FIELD_MAX_LENGTH` の緩さを恒久化） |
| W-003 | ハッシャー失敗系のトートロジー | **解消**（`pbkdf2PasswordHasher.test.ts` に `deriveBits` / `importKey` 失敗 × hash / verify の3ケース。`cause` 保持まで表明） |
| W-004 | 移植した OCC テストの弱い表明 | **一部未解消**（名指しされた5箇所は修正済み。ただし同一パターンが `eventRelayWorker.integration.test.ts` に4箇所残存 → W-001） |
| W-005 | `errorField` の無テスト | **解消**（`errorField.test.ts` 168行。AC-10 の文言を逐語で固定。ただし `errorDisplay` のラベル整形経路は依然無テスト → W-004） |
| W-006 | `startSession` の無テスト | **解消**（発行1回・Cookie 属性・sink 失敗の翻訳の3点） |
| W-007 | ハッシュ保存の実ハッシャー検証 | **解消**（`FakePasswordHasher` を FNV-1a ダイジェスト化し、TC-009 で `pbkdf2-sha256$1000$` プレフィックスと平文非包含を表明） |
| W-008 | `ALTER TABLE RENAME` の巻き込み | **解消**（テーブル名を定数化、2つの注入器がともに自前 `finally` を持つ。`hidden` フラグが「insert に到達したこと」の能動的表明にもなっている） |
| adapters W-005 | 制約の挙動テスト欠如 | **解消**（名前付き CHECK 6本を d1 / libsql の両方で raw insert から検証。AC-5 が初めてテストで担保された） |

## 39件の TC 突き合わせ

全 39 ID がテスト名に埋め込まれていること、および各テストが `spec/testcases/identity/*.md` の期待結果を実際に検証していることを1件ずつ確認した。**カバーが不十分と判断した ID はゼロ**。1周目に △ とされた7件はいずれも閉じている。

| TC | 状態 |
|---|---|
| register-005 / 007 / 008 | △→○ `registerWithPassword` の成功経路を統合で確認（`users.email` が320文字で保存されること、`outbox` 1件まで） |
| getCurrentUser-008 | △→○ `getCurrentUser({ userId: "" / "   " })` が `IDENTITY_INVALID_USER_ID` を投げることを `it.each` で |
| register-014 | △→◎ 経路（`cause`）と件数（fulfilled 1 / rejected 1）の両方を固定 |
| register-015 / login-011 | △→○ スタブの表明自体はトートロジーのままだが、実アダプター側の `CryptoError` 翻訳が W-003 の修正で埋まったため「アダプターが翻訳する → ユースケースは素通しする」の鎖が両端とも閉じた（→ N-002） |

---

## Test

### Blockers

- **[B-001]** タイミングオラクル対策（`burnVerificationTime` / `DUMMY_PASSWORD_HASH`）の**唯一の検証テストが、その失敗形を構造的に再現できない Fake の上で書かれている**
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:31-53` ／ テスト `packages/core/src/application/identity/__tests__/identity.integration.test.ts:577-610`
  - 理由: 1周目の仕分け `application/identity/loginWithPassword/タイミングオラクル`(fix) で入った対策は、未登録メール / SSO ユーザーの経路でも**鍵導出1回分のコストを実際に払う**ことで成立している。ところがその実体は `hasher.verify(plainPassword, DUMMY_PASSWORD_HASH)` の1行で、実装は**この呼び出しの throw を意図的に握り潰す**（`catch { /* deliberately ignored */ }`）。したがって `DUMMY_PASSWORD_HASH` が実ハッシャーの `parse()` を通らなくなった瞬間に——アルゴリズム識別子の変更、`MAX_PBKDF2_ITERATIONS` の引き下げ、定数のタイポ——`derive()` に到達する前に例外が出て握り潰され、**対策は完全に死ぬが型検査もテストも実行時エラーも一切出ない**。
    現在この経路を見ている唯一のテストが `:581` の "pays for one verification on every credential path" だが、これは `FakePasswordHasher`（FNV-1a・`parse` を一切行わない）を差し込んだコンテナで `verify` の**呼び出し回数だけ**を数えている。Fake は保存形式を解釈しないので、定数が壊れていても常に3回カウントされて green になる。実ハッシャーで `loginWithPassword` の未登録メール経路を通るテストは suite 内に存在しない（実ハッシャーを使うのは TC-loginWithPassword-009 のログイン成功経路のみ）。
    つまり「1回分の検証コストを払う」というテスト名の主張に対し、実際に固定できているのは「`verify` が呼ばれる」だけで、**コストを払っているかは誰も見ていない**。本レビューで捨てテストを書いて確認したところ現時点の定数は有効（`verify` が `false` を返す）だが、それを固定する表明がどこにもない。重点観点が言う「見せかけのカバー」に該当する。
  - 提案: 次のいずれか（両方が望ましい）。
    - `DUMMY_PASSWORD_HASH` を export し、`identity.integration.test.ts` か新規の単体テストで `createPbkdf2PasswordHasher({ iterations: 210_000 }).verify(anyPassword, DUMMY_PASSWORD_HASH)` が **throw せず `false` に解決する**ことを表明する（1ケース・約200ms）。これが定数の陳腐化に対する直接のガード。
    - export したくない場合は、`verify` に渡された hash を記録するスタブで未登録メール経路を通し、記録された値を実ハッシャーに食わせて `resolves.toBe(false)` を表明する（定数を公開せずに同じ性質を押さえられる）。
    - あわせて「握り潰しが効いていること」も1ケース: `throwingHasher("verify")` のコンテナで**未登録メール**にログインすると `SystemError` ではなく `ValidationError(INVALID_CREDENTIALS)` になること。JSDoc が明示的に約束している挙動（「未知のアドレスを500にしてはならない」）なのに、現在の TC-loginWithPassword-011 は登録済みメールの経路しか通っていないので未検証。

### Warnings

- **[W-001]** 1周目 W-004 の `if (!found) return;` パターンが `eventRelayWorker.integration.test.ts` に4箇所残っており、そちらは**直前の件数表明も無い**
  - 場所: `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts:344, 369, 421, 468`
  - 理由: 1周目は libsql の `occGuard` / 両アダプターの `unitOfWork` の5箇所を名指しし、そこは `throw new Error("seeded user disappeared")` に正しく直っている。しかし同じ移植対象である relay のテストは手つかずで、しかも形が悪い。`outboxRepository.integration.test.ts` の同種2箇所（d1:88 / libsql:99）は**直前に `expect(rows).toHaveLength(1)` があるため単なる型ナローイング**で無害だが、relay 側の4箇所は `const rows = await container.db.select()...; const row = rows[0]; if (!row) return;` と件数を見ずに書かれている。行が消えた／seed が入らなかった場合、**リトライのバックオフ・`last_error` の切り詰め・quarantine（`failedAt` / `nextAttemptAt` / 再ピックされないこと）という、そのテストが存在する理由そのものを一切検証せずに green で終わる**。ADR-001 の Consequences が「移植を怠ると検証が空洞化する」をレビュー観点に指定している対象そのもの。
  - 提案: 4箇所を `expect(rows).toHaveLength(1);` ＋ `const row = rows[0]; if (!row) throw new Error("outbox row disappeared");` に揃える（新規テスト側が既に基準形を持っている）。
  - あわせて: `unitOfWork.integration.test.ts` の d1:106 / libsql:108 は `expect(isConflictError(caught)).toBe(true)` 止まりで、1周目が提案した `code === "OPTIMISTIC_LOCK_FAILURE"` が入っていない。同じ UoW から `UNIQUE_VIOLATION` が出ても通ってしまう（`occGuard.integration.test.ts` は libsql 側だけ `code` まで見ており、こちらが基準形）。

- **[W-002]** 1周目の修正で新設された**フェイルクローズのガードが4本とも無テスト**
  - 場所: `packages/core/src/application/di/secrets.ts:52-61`（`requireSessionSecret`）／ `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:61-65`（`MIN_SESSION_SECRET_LENGTH`）／ `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:154-158`（`MIN_PBKDF2_ITERATIONS`）／ 同 `:96-105`（`MAX_PBKDF2_ITERATIONS`）
  - 理由: いずれも仕分けで `fix` と判定された指摘（`application/di/secrets/センチネル文字列` / `生 Error の throw` / `adapters/webcrypto/ファクトリ引数の検証` / `pbkdf2/反復回数の上限検査`）への対応として本 PR が**新規に足した `throw`** だが、テストは全部「通る側」しか踏んでいない。
    - `requireSessionSecret` はテストからも `requestContainerConfig.test.ts:26` で**正常値で1回呼ばれるだけ**。`undefined` / 31文字が throw することは1件も表明されていない。これは「`SESSION_SECRET` 未設定のまま起動して全セッションが偽造可能になる」を防ぐ唯一の関門で、`if` の条件が緩む退行は型検査にもテストにも出ない。
    - `pbkdf2PasswordHasher.test.ts` の破損ハッシュ `it.each` は `"zero iterations"` を持つが、新設された**上限**（`> MAX_PBKDF2_ITERATIONS`）のケースが無い。上限チェックが消えても既存6ケースは全部通る。
    - `createHmacSessionCodec` / `createPbkdf2PasswordHasher` のファクトリ引数検証も同様に0ケース。
  - 提案: 各1〜2行で閉じる。`expect(() => requireSessionSecret(undefined)).toThrow()` / `expect(() => requireSessionSecret("a".repeat(31))).toThrow()`、`expect(() => createHmacSessionCodec({ secret: "short" })).toThrow()`、`expect(() => createPbkdf2PasswordHasher({ iterations: 999 })).toThrow()`、そして `it.each` に `["iterations above the ceiling", `pbkdf2-sha256$${MAX_PBKDF2_ITERATIONS + 1}$c2FsdA==$aGFzaA==`]` を1行足す。境界値（ちょうど 32 / ちょうど 1_000 / ちょうど `MAX`）も受理側で押さえると、上下どちらの方向のずれも落ちる。

- **[W-003]** AC-15 / manual TC-23 を実際に担保している `Cache-Control: no-store, private` と、**無効セッションの拒否**が無テスト
  - 場所: `apps/web/app/presentation/currentUser.ts:43`（`setResponseHeader`）／ `:19-28`（`getCurrentUserId`）。テストは `apps/web/app/presentation/__tests__/redirectSearch.test.ts:117-150` の未ログイン経路のみ
  - 理由: 仕分け `認証済みレスポンスの Cache-Control`(fix) で入った1行が、「ログアウト後に戻るボタンで保護画面が復元されない」（AC-15 / manual TC-23）の唯一のコード上の根拠。ところがテストが踏むのは**必ず `userId === null` になる経路**（`getCookie` を `undefined` に固定したモック）だけなので、この `setResponseHeader` は一度も実行されていない。同様に `getCurrentUserId` の「トークンはあるが `sessionCodec.verify` が `null` を返す（改ざん / 期限切れ）」経路も未検証で、`verified?.userId ?? null` が `verified.userId` に書き換わっても誰も気づかない。
    ハーネスは既に揃っている: 同ファイルが `@tanstack/react-start/server` をモックしており（`getCookie` / `setResponseHeader` とも差し替え可能）、`session.test.ts` が `installContainerStore` でコンテナを積む形を示している。`getCurrentUserId` が `react` の `cache()` 越しでも node プールで動くことは既存テストで実証済み。
  - 提案: `redirectSearch.test.ts`（または `currentUser.test.ts` を新設）に3ケース。(a) 有効トークン + `verify` が `{ userId }` を返すコンテナ → `requireUserId()` が userId を返し、`setResponseHeader` が `("cache-control", "no-store, private")` で1回呼ばれること。(b) `verify` が `null` を返す → リダイレクトすること。(c) `cache()` の同一リクエスト内メモ化に依存しているので、`verify` の呼び出し回数までは表明しない（実装詳細）。

- **[W-004]** `errorDisplay.ts` のフィールドラベル整形（1周目修正で新設）が**どのテストからも到達しない**
  - 場所: `apps/web/app/presentation/errorDisplay.ts:46-64`（`FIELD_LABELS` / `formatFieldErrors`）
  - 理由: 仕分け `presentation/errorDisplay/transport 検証エラーの表示`(fix) は「英語 zod メッセージと生フィールドキーが出る」への対応で、`{ email: [...] }` を `メールアドレス: …` に整形するテーブルを新設した。ところが唯一のテスト経路である `toAuthErrorDisplay` は `fieldErrors.email` / `fieldErrors.password` があると `renderErrorMessage` を呼ぶ**前に** return する（`errorField.ts:42-48`）ので、ラベル付き整形は一度も実行されない。`errorField.test.ts:126` の "falls back to the banner…" は `{ redirect: [...] }` すなわち**ラベル未登録キー**のケースで、通るのは `label === undefined` 側の分岐だけ。結果として `FIELD_LABELS` から `email` / `password` のエントリが落ちても、`parts.join(" / ")` が壊れても、全テストが green のまま。実際にこの整形が効くのは `__root.tsx` のエラーバウンダリ（`displayError` / `sanitizeRouteError`）経由で、そちらも無テスト。
  - 提案: `errorDisplay` に対する単体テストを1本置き、`renderErrorMessage({ kind: "validation", code: "INVALID_INPUT", message: "Invalid input", fieldErrors: { email: ["必須です"], password: ["短すぎます"] } })` が `"メールアドレス: 必須です / パスワード: 短すぎます"` になること、未登録キーは生メッセージのみになること、`kind: "system"` / `"unknown"` が内部メッセージを出さないことを表明する。`SerializedError` しか依存が無いので node プールで数行。

### Notes

- **[N-001]** `redirectSearch.test.ts` の設計が良い。列挙した17の拒否ケースに加えて「`toSafeRedirect` の結果を自オリジンに resolve したとき `destination.origin` が変わらない」という**性質**を全ケース＋二重エンコード2件に対して回している（`:82-93`）。列挙は必ず漏れるがこの性質は漏れないので、条件が1つ落ちたときに列挙側とは独立に落ちる。`requireUserId` の配線ガード（`?redirect=` に汚染された `getRequestUrl()` を `toSafeRedirect` に通していること）まで含めた点も1周目の提案どおり。

- **[N-002]** TC-registerWithPassword-015 / TC-loginWithPassword-011 の `expect(error.code).toBe("CRYPTO_ERROR")` は、スタブが投げた値をそのまま見ているという意味では依然トートロジー。ただし W-003 の修正で `pbkdf2PasswordHasher.test.ts:117-157` が「WebCrypto が reject → `SystemError(CRYPTO_ERROR)` に翻訳され `cause` が保たれる」を3経路で押さえたため、**翻訳（アダプター）と素通し（ユースケース）の鎖は両端とも閉じている**。spec の期待は `SystemError` なので TC としても満たす。このまま据え置いてよい。

- **[N-003]** 名前付き制約の挙動テスト（`userRepository.integration.test.ts` の `it.each` × 2アダプター）はドライバのメッセージ文言に依存するが、**失敗方向が「落ちる」側**（`causeChain` が空 / 別名なら `toMatch` が失敗）なので、文言変更が黙って通ることはない。本レビューで D1（Miniflare/workerd）と libSQL の両方で実行し green を確認した。1点だけ弱いのが `["an unknown auth method", { authMethod: "ldap" }, /users_auth_method_(sum|valid)/]` の交替で、どちらの不変条件が発火したのかを固定していない。SQLite は CHECK を宣言順に評価するので `users_auth_method_sum` が決定的に先に落ちる（`authMethod: "ldap"` は直和のどちらの枝も満たさない）。交替をやめて `users_auth_method_sum` に固定し、`users_auth_method_valid` 単独を狙う行は `{ authMethod: "ldap", passwordHash: null }` 等で別に立てるほうが、`valid` 制約が消えたことを検出できるようになる（現状は `sum` があれば `valid` が消えても通る）。

- **[N-004]** `entity.test.ts:194-198` の `expect(typeof call).toBe("function")` は純粋なトートロジー。実際の表明は `@ts-expect-error` のほうで、`call` は一度も呼ばれない。これ自体は無害だが、`plan.md:909` が「`changePassword` が `PasswordUser` のみを受けること（**型レベル＋ランタイム**）」と書いているのに対し `entity.ts:99-114` にランタイムガードは存在しない。plan の字面と実装が食い違っているので、(a) この行を消して「型レベルのみ」と plan を直す（spec-sync 対象）か、(b) ランタイムガードを足して `expect(() => call()).toThrow()` にするか、どちらかに寄せたい。読み手に「ランタイムでも守られている」と誤読させる形が一番よくない。

- **[N-005]** `eventDecoders.test.ts:97-104` の `expect(() => …).toThrow()` は kind / code を見ていない。このテストの主張は直前の `it.each`（スキーマ不一致 = `SystemError(DATA_INTEGRITY_ERROR)`）との**対比**——形は合っているが値が不正なら値オブジェクトの `BusinessRuleError` がそのまま出る——なので、`isBusinessRuleError(caught)` ＋ `code` まで見ないと対比が成立しない。現状は `SystemError` が出ても通る。

- **[N-006]** `identity.integration.test.ts:581` の "pays for one verification…" は合計3回しか見ていないため、経路ごとの内訳（各1回）を固定していない。ある経路が2回・別の経路が0回でも通る。`counted` は hash 値を記録しているので、`expect(counted.slice(0, 2)).toEqual([DUMMY, DUMMY])` の形にすれば「未登録 / SSO の2経路がダミーで焼いた」ことまで言える（B-001 の修正と同時にやると効率が良い）。

- **[N-007]** `FakePasswordHasher` の FNV-1a は32ビットなので、`verify` は原理的にハッシュ衝突で `true` を返しうる。現行テストはすべて固定文字列を使っているため決定的で、フレークにはならない。ただし将来 property テストや生成入力と組み合わせる場合は成立しない前提なので、JSDoc に「固定入力専用」を1行足しておくと安全。ダイジェスト化そのものは W-007 の対応として正しく、`users.password_hash` に平文が入らないことが Fake を使う**全**テストで効くようになった点は効果が大きい。

- **[N-008]** `errorResponseMiddleware`（`redactForClient` / `httpStatusFor` を呼ぶ唯一の地点）が無テスト。`business` / `validation` が誤って redact される変更が入ると **AC-10 / AC-12 の文言が全部「System error」に化ける**が、`errorField.test.ts` は `SerializedError` を直接渡すので検出できない。`appServerErrorAdapter.test.ts` が別 module graph 問題（1周目に発覚した実バグ）を構造的に押さえた形は良いので、その隣に `redactForClient` の3ケース（`system` / `unknown` は code / message が落ちる、`validation` はそのまま）を置くと境界が閉じる。TC 要求外なので Warning にはしない。

- **[N-009]** 決定性・独立性は良好。`identity.integration.test.ts` を10回連続で回して全件安定（TC-014 の厳格化後も）。`withUsersTableHidden` / `withInsertBreakingProvider` はともに自前 `finally` を持ち、テーブル名も定数1箇所に集約されたので、1周目 W-008 が懸念したファイル横断の汚染リスクは実務上消えている。`hidden` フラグが「insert に到達したこと」の能動的な表明を兼ねている点（`:149`）も良い。

- **[N-010]** `schema.test.ts` が transport 上限を「**具体値ではなく緩さ**」で縛っている設計が良い。`AUTH_FIELD_MAX_LENGTH` を 1024 と直接比較せず、「129文字パスワード / 321文字メールが通る」「320 / 128 は通る」「> 320 である」で表明しているので、DoS 上限を 2048 に上げても落ちず、128 や 320 に下げた瞬間に落ちる。plan.md が最大級のリスクとして挙げた「エラー種別が business から validation に化ける」退行に正確に対応している。

---

## 総評

1周目の指摘は Blocker 1件・Warning 8件のうち**7.5件が解消**（W-004 のみ、名指しした5箇所は直ったが同種のパターンが relay の移植テストに残った）。とくに `redirectSearch.test.ts` と `errorField.test.ts` は提案の水準を超えており、前者の「自オリジンに resolve する」性質テストと後者の AC-10 逐語固定は、列挙型テストが構造的に持つ漏れを埋めている。39件の TC は形式・実質ともに全件カバーされ、1周目に △ だった7件はすべて閉じた。**カバー不十分と判断した TC は無い**。

一方で、**1周目の修正が持ち込んだコードに穴が寄っている**という新しい形が出た。B-001（タイミングオラクル対策の検証が Fake の上に乗っており、失敗形を再現できない）、W-002（新設されたフェイルクローズのガード4本が全部「通る側」しか踏まれていない）、W-003（`Cache-Control` の1行）、W-004（ラベル整形テーブルが到達不能）は、いずれも「R1 で足したコードに対応するテストを足していない」という同じ形をしている。B-001 だけは、テスト名が主張している性質と実際に固定できている性質がずれている（見せかけのカバー）ため Blocker とした。

残る表明の弱さは W-001（relay の暗黙スキップ4箇所、`unitOfWork` の `code` 未表明2箇所）と N-003 / N-005 / N-006 で、いずれも数行で閉じる。
