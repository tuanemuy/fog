# レビュー 002: PR #17 — Domain / Use Case

対象レイヤー: `packages/core/src/domain/identity/` / `packages/core/src/domain/common/` / `packages/core/src/application/identity/` / `application/errors/index.ts` / `application/ports/sessionCodec.ts` / `application/execution/unitOfWork.ts` / `application/workers/eventRelayWorker.ts` / `application/di/`

正とした spec: `spec/domains/identity.md`、`spec/usecases/identity.md`、`spec/adr/004-domain-boundaries.md`
参照した設計文書: `.issue/1/plan.md`（AC-1〜AC-4 / AC-8）、`.issue/1/adr.md`（ADR-001〜032）、`.issue/1/review/review-001-domain-usecase.md`、`.issue/1/review/triage.md`

検証実績: `pnpm typecheck` 通過。`pnpm test:unit` 288 passed / 18 files、`pnpm test:integration` 39 + 102 passed / 15 files。いずれも green。

## ラウンド1指摘の解消状況

| R1 ID | 判定 | 根拠 | 結論 |
|---|---|---|---|
| W-001 `changeTrashRetentionDays` の no-op に WHY が無い | fix | `entity.ts:121-127` に6行の WHY（設定画面の再送信が OCC 競合を作る / 保持期限が動かないイベントを配らない / 呼び出し側は `entity === user` か空ドラフトで検出できる）。ADR-024 が (a)/(b) の選択理由も含めて記録 | **解消** |
| W-002 `getCurrentUser` の DTO が入れ子 | fix | `getCurrentUser.ts:10` が `GetCurrentUserOutput = CurrentUserView`。統合テスト `identity.integration.test.ts:689-694` が平坦形で `toEqual`、`CurrentUserPanel/index.tsx:33,39` も `user.email` / `user.authMethod` に追随 | **解消** |
| W-003 `reconstruct` のコメントと実装のドリフト | fix | `entity.ts:145-149` に `assertUnset` を新設し、`200-201`（password 行の SSO 列）/ `209`（sso 行の passwordHash）で相手側の列が NULL であることを表明。コメント `179-188` は「片方は VO の空文字拒否、もう片方は `assertUnset`」と検出手段まで正確に記述。`entity.test.ts:292-303` が逆方向3ケースを追加 | **解消**（コメント→実装の両方向で一致を確認） |
| W-004 長さ検証がコードユニット単位 | fix | `domain/common/text.ts` の `codePointLength` を新設し、`valueObject.ts:48`（Email 320）/ `:80`（PlainPassword 8〜128）/ `:153`（ClientName 100）が使用。`valueObject.test.ts:103-112` が絵文字4/8/128/129 で境界を表明。ADR-023 が `domain/common/` に置いた理由（後続の `MemoBody` と単位を共有）も記録 | **解消** |
| W-005 タイミングオラクル | fix | `loginWithPassword.ts:31-53` に固定ダミーハッシュと `burnVerificationTime`、`:89` / `:95` の2分岐で呼ぶ。応答同一性は無傷（`invalidCredentials()` 単一ファクトリのまま、TC-loginWithPassword-008 も無改変で green）。新分岐から例外は漏れない（ダミー verify は握り潰し、`findByEmail` の SystemError は従来どおり素通し） | **解消**（ただし新たな品質課題 → W-001 / W-002） |
| W-006 `RequestSecrets` のセンチネル | fix | `secrets.ts:19-32` に `SessionSecret` ブランド型、`:52-61` の `requireSessionSecret` が唯一の発行点。4ランタイムの `?? ""` は全滅（grep 済み）。ADR-025 が検証点を「コンテナ構築時→request config 構築時」へ1段上げた経緯も記録 | **解消** |

**未解消: なし。** 6件すべて実際にコードで解消されている。ADR-023〜026 が判断の根拠を残しており、triage の `fix` 判定と実装が一致する。

## 受け入れ基準の検証結果

| AC | 判定 | 根拠 |
|---|---|---|
| AC-1（VO の制約・`BusinessRuleError<IdentityErrorCode>`） | 満たす | 8 VO + `Actor` がすべて `unique symbol` ブランド + `create`。長さ判定はコードポイント基準に統一（W-004 解消）。`TrashRetentionDays` は `Number.isInteger && >= 1`、`default()` が 30 |
| AC-2（`PasswordUser \| SsoUser` と4ファクトリ） | 満たす | `entity.ts:23-36` が spec のフィールド表と1対1。`changePassword` は `PasswordUser` 限定（`entity.test.ts:194` の `@ts-expect-error`）、4ファクトリとも `now` を引数で受ける純関数 |
| AC-3（識別子なしドラフト＋同一トランザクション outbox） | 満たす | `events.ts:30-40` が `EventDraft`（`id` なし）。`registerWithPassword.ts:56` の `collectEvents` が唯一の経路。`identity.integration.test.ts:184-191` が users 行と outbox 行を同一コミットで表明 |
| AC-4（`UserRepository` / `PasswordHasher` の宣言と OCC 規約） | 満たす | `ports/userRepository.ts:37-42` は `TransactionalRepository` を extends せず、`findById` のみが `ExpectedVersion<User>` の発行点。`PasswordHasher` は `hash` / `verify: Promise<boolean>` の2メソッドのまま（ダミー verify 導入でもポート面は広げていない） |
| AC-8（4ユースケースの処理フローとエラー契約） | 満たす | 下表 |

**AC-8 の処理フロー突き合わせ（ラウンド2時点）**

| ユースケース | spec | 実装 | 判定 |
|---|---|---|---|
| `registerWithPassword` | clock/idGen → VO → UoW 外で hash → UoW 内で `findByEmail` → `insert` → `collectEvents` | `registerWithPassword.ts:38-58` が同順。ADR-008 の読み替えは `code === "UNIQUE_VIOLATION"` に限定 | 一致 |
| `loginWithPassword` | 全失敗を `ValidationError("INVALID_CREDENTIALS")` に統一 | `loginWithPassword.ts:82,91,97,103` の4分岐すべてが `invalidCredentials()`。統合テストが5経路の `toSerialized()` を相互 `toEqual` | 一致（時間の同一化も追加。spec の要求を上回る） |
| `logout` | ドメイン操作なし・`void` | `logout.ts:21-25`。`logout.test.ts` が全ポートを trip 配線で「触っていない」ことまで表明 | 概ね一致（`UserId.create` の分は N-006 のとおり spec-sync 対象） |
| `getCurrentUser` | `UserId.create` → `findById` → 資格情報・SSO 主体を含めない平坦 view | `getCurrentUser.ts:23-32` + `view.ts:12-26` | **一致**（R1 の入れ子差分は解消） |

## 重点観点の検証結果

- **`getCurrentUser` の漏出**: `CurrentUserView` は `{ userId, email, authMethod, trashRetentionDays }` のみ。`passwordHash` / `provider` / `providerSubject` は射影されず、TC-getCurrentUser-003 / 004 がキー集合の完全一致に加え `JSON.stringify` への `not.toContain` まで表明。**合格**
- **`loginWithPassword` の失敗応答の同一性**: `kind` / `code` / `message` / `fieldErrors` なしで完全一致。ダミー verify 導入後も `invalidCredentials()` が単一の発行点であることは変わらず、新分岐（`:89` / `:95`）から別種の例外が漏れる経路は無い（`burnVerificationTime` は throw を握り潰し、その後同じファクトリで throw）。**合格**
- **ドメイン純粋性**: `domain/identity/` と `domain/common/text.ts` に I/O・`new Date()`・ID 生成は無い。`codePointLength` は副作用ゼロの純関数。**合格**
- **UoW 規約**: 書き込みは `run` の中だけ。`UnitOfWorkContext`（`unitOfWork.ts:4-15`）が `userRepository` と `collectEvents` しか露出せず、イベントの別経路が存在しない。**合格**
- **クロスレイヤー catch**: 明示された境界は3箇所。`registerWithPassword.ts:61-79`（ADR-008、`UNIQUE_VIOLATION` 限定）、`loginWithPassword.ts:78-83`（VO 生成2行だけの最小スコープ）、`loginWithPassword.ts:48-52`（ダミー verify の握り潰し）。3件目は新規だが JSDoc に「なぜ握り潰すか」が書かれており、CLAUDE.md の「明示された境界のみ」に収まる。ドメインエラーの再翻訳は無い。**合格**（ただし無音であることの是非 → W-001）
- **不正な状態の型表現**: `SessionSecret` ブランドで「秘密鍵未設定」が型から消えた点は R1 からの明確な改善。一方で `sessionCodec` の参照禁止は依然 JSDoc のみ（→ W-004）
- **イベントデコーダの網羅性**: `AllDomainEvents = IdentityEvent` + `satisfies DefaultEventDecoderRegistry` + `identityEventDecoders: IdentityEventDecoders` の二重で、イベント追加時に必ずコンパイルエラーになる。**合格**
- **JSDoc の質**: 自明な言い換えはほぼゼロ。`text.ts:1-9`（「なぜコードユニットでは駄目か」をパスワード最小長の実害まで書く）、`entity.ts:179-188`（検出手段を方向ごとに書き分ける）、`secrets.ts:21-32`（ブランドの目的）はいずれも将来この判断を壊す変更を止めるための WHY として機能している。**合格**

## Blockers

なし。

## Warnings

- **[W-001]** ダミーハッシュ定数の陳腐化が完全に無音になる（テスト無し・ログ無し・例外は握り潰し）
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:31-32`（定数）/ `:44-53`（`burnVerificationTime`）
  - 理由: この等時間化は「`DUMMY_PASSWORD_HASH` が現行アダプターで**パースでき、実際に鍵導出が走る**」ことに全面的に依存している。ところがその前提が壊れたときの検出手段が1つも無い。(1) `catch { /* deliberately ignored */ }` が例外を飲む、(2) `logger` を持っているのに何も記録しない、(3) 定数が実ハッシャーで有効であることを見るテストが存在しない（`grep DUMMY_PASSWORD_HASH` の結果は当該ファイル1件のみ）。統合テストの「pays for one verification on every credential path」（`identity.integration.test.ts:581-610`）は `FakePasswordHasher` に対する **呼び出し回数** しか数えておらず、`FakePasswordHasher.verify` は文字列比較なので `pbkdf2-sha256$...` を渡されても素通りで `false` を返す。つまりアルゴリズムを差し替えても、`DEFAULT_PBKDF2_ITERATIONS` を上げてこの定数だけ据え置いても、base64 を1文字書き換えても、**全テストが green のまま緩和策だけが静かに消える**。ADR-026 は「劣化してもログインは動き続ける」ことを意図として書いているが、意図された劣化と事故による劣化を区別する手段が無いのは別問題である。アダプターの保存形式（`pbkdf2-sha256$210000$...`）をアプリケーション層のリテラルとして抱えている点も、`ports/passwordHasher.ts:3-7` の「エンコーディングは完全にアダプターの business」という自分で書いた契約と食い違う
  - 提案: ポートを広げない範囲での最小対応として2点。(a) `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts` に「`createPbkdf2PasswordHasher().verify(anyPassword, DUMMY_PASSWORD_HASH)` が throw せず `false` に解決する」1本を足す（定数を `export` するだけで済み、陳腐化した瞬間に赤くなる）。(b) `burnVerificationTime` に `container.logger` を渡し、`catch` で `logger.warn`（例外そのものではなく「ダミー検証が失敗した = 等時間化が無効」という事実）を1行出す。ADR-026 が退けたポート拡張案（`PasswordHasher` に `dummyHash: PasswordHash` を持たせ、各アダプターが自分のエンコーディングで供給する）は、型で強制できる点で本来こちらが筋だが、(a)+(b) で実害はほぼ塞げるので判断は残す

- **[W-002]** 等時間化は「全保存ハッシュの反復回数がダミーの宣言値と一致している間」しか成立せず、その前提がどこにも書かれていない
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:23-32` / `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:14`（`DEFAULT_PBKDF2_ITERATIONS`）
  - 理由: `verify` は保存ハッシュから反復回数を読む（`pbkdf2PasswordHasher.ts:170-171`）。これは「反復回数を上げても既存ハッシュが検証できる」ための設計で、JSDoc（`:132-136`）が明示的に**サポートされた運用**として謳っている。ところがダミー定数は 210,000 固定なので、`DEFAULT_PBKDF2_ITERATIONS` を将来 600,000 に上げると、新規登録ユーザーの誤パスワード経路は 600k、未登録アドレス経路は 210k となり、**「速い方が未登録」というオラクルが元の向きのまま復活する**。逆にダミーだけ 600k に再生成すれば、まだ再ハッシュされていない既存ユーザー（210k）より未登録の方が遅くなり、向きが反転したオラクルになる。ADR-026 の Decision は「保存ハッシュは自己記述形式なので、テスト用に低い反復回数のハッシャーを差し替えてもダミーは宣言どおりのコストで検証される」とだけ書いており、この**本番側の反復回数引き上げ**という逆方向のケースに触れていない。今日は4ランタイムとも `createPbkdf2PasswordHasher()` を引数なしで呼ぶので実害は無いが、緩和策の有効期限が誰にも見えない状態になっている
  - 提案: `DEFAULT_PBKDF2_ITERATIONS` の JSDoc に「この値を上げるときは `loginWithPassword` のダミーハッシュも同じ反復回数で再生成し、かつ旧コストの保存ハッシュが残っている間は等時間化が不完全になることを承知すること（rehash-on-login = #18 が入るまで）」を1行足す。W-001 の (a) のテストを「宣言されている反復回数が `DEFAULT_PBKDF2_ITERATIONS` と一致する」まで強めれば、コメントに頼らず機械的に止められる

- **[W-003]** `progress.md` の残存課題が R1 修正後の実装と矛盾したまま残っている
  - 場所: `.issue/1/progress.md:9-13`（「1. `loginWithPassword` のタイミングサイドチャネル」）
  - 理由: 「未登録メールの場合 `passwordHasher.verify` をスキップする」「塞ぐにはダミーハッシュに対するダミー verify が必要」「JSDoc に既知の制限として明記済み」と書かれているが、そのダミー verify は ADR-026 で実装済みであり、JSDoc の当該記述も既に「限界」から「対策」に書き換わっている（`loginWithPassword.ts:66-70`）。この Issue のスコープ外項目一覧はマージ後に「何が残っているか」を読む唯一の入口なので、解決済み項目が残っていると次の担当者が二重に対応するか、逆に「まだ穴がある」と誤認する。あわせて、末尾の「spec-sync 対象（実装と spec の字面差）」節も R1 修正で増えた差分を拾えていない — ADR-023（`spec/domains/identity.md` の各 VO に長さの単位が未記載）・ADR-024（`#User` に no-op 規則が未記載）はどちらも自身の Consequences で「spec-sync 対象として残る」と宣言しているのに、`progress.md` 側には転記されていない
  - 提案: 項目1を削除するか「解決済み（ADR-026）」に書き換え、代わりに W-001 / W-002 の残課題（ダミー定数の陳腐化検出）を残存課題として起こす。spec-sync 節に ADR-023 / ADR-024 の2件を転記する

- **[W-004]** 「`sessionCodec` はユースケースから参照禁止」が JSDoc だけの規約で、型では止まっていない
  - 場所: `packages/core/src/application/types.ts:3-6`（`ServiceArgs.container: RequestContainer`）/ `packages/core/src/application/ports/sessionCodec.ts:3-8`
  - 理由: ポートの JSDoc は「**Presentation-layer port. No usecase may reference it.**」と太字で禁止しているが、全ユースケースが受け取る `ServiceArgs.container` の型は `RequestContainer` そのもので、`sessionCodec` が普通に生えている。`container.sessionCodec.issue(...)` を書いてもコンパイルは通り、レビューでしか止まらない。同じ PR が `SessionSecret` ブランドで「秘密鍵未設定という不正状態を型から消す」（ADR-025）ことをやってのけた直後なので、CLAUDE.md の「Make illegal states unrepresentable at the type level before falling back to runtime checks」に照らすと、ここだけ判断が非対称になっている。しかも `di/types.ts:54-60` は `outboxRepository` / `idempotencyStore` / リポジトリ群を「載せない」ことで構造的に排除しており、`sessionCodec` だけがコメント頼みである
  - 提案: `application/types.ts` に `type UsecaseContainer = Omit<RequestContainer, "sessionCodec">` を置き `ServiceArgs.container` をそれにする。presentation 側は `getContainer()` が返す `RequestContainer` をそのまま渡せる（変数の代入には excess property check が効かないため呼び出し側は無変更で通る）ので、変更は2行に収まる。実際に `logout.test.ts:34-37` が `sessionCodec` を trip 配線でスタブせざるを得ないのは、この型が広すぎることの現れでもある

## Notes

- **[N-001]** `DUMMY_PASSWORD_HASH` が `PasswordHash.create(...)` ではなく `as PasswordHash` で作られている（`loginWithPassword.ts:32`）。`PasswordHash` は「非空」しか検証しないので実効的な差は無いが、このリポジトリはブランド型の発行点を smart constructor 1箇所に絞る方針（`requireSessionSecret` が `SessionSecret` の唯一の発行点であることを ADR-025 がわざわざ書いている）で通しており、ここだけ生キャストになっている。`PasswordHash.create(...)` に置き換えれば規約が揃う。
- **[N-002]** `Email` の JSDoc（`valueObject.ts:39-42`）は「Length is capped at the RFC 5321 path limit」と書くが、RFC 5321 の 320 は**オクテット**上限であり、実装は W-004 の修正でコードポイント計測になった。ASCII アドレスでは差が出ないので実害は無いものの、コメントの根拠と実装の単位がずれた状態になっている。「spec が採る単位はコードポイント（ADR-023）で、320 という数字の出所が RFC である」と書き分けるか、`Email` だけ単位を octet に戻すかを一度決めておくとよい。
- **[N-003]** `valueObject.property.test.ts:115-133` の PlainPassword プロパティテストは `fc.string({ minLength, maxLength })` + `.filter(s => s.length >= 8 && ...)` と、**`.length`（UTF-16 コードユニット）** で絞り込んでいる。fast-check v4 の `fc.string()` は既定が ASCII 系ユニットなので今は偽陽性も偽陰性も出ないが、W-004 が変えたまさにその軸（非 BMP）をプロパティテストが一切踏んでいないことは意識しておきたい。担保は `valueObject.test.ts:103-112` の絵文字4ケースだけである。ジェネレータを非 BMP を含む形にし、フィルタを `codePointLength` に揃えれば、ADR-023 の不変条件がランダム入力でも守られる。
- **[N-004]** `reconstruct` は直和 CHECK の2方向を別々のイディオムで守っている — 「相手側の列が埋まっている」は `assertUnset`（明示）、「自分側の列が NULL」は `?? ""` を VO に食わせて空文字で弾く（暗黙）。コメント（`entity.ts:183-188`）がその非対称をきちんと説明しているので誤読はしないが、W-006 で `?? ""` センチネルを DI から追放した直後にドメイン側で同じ形を残しているのは読み手に一瞬の引っかかりを与える。`assertSet(value, column): string` を対にすれば両方向が同じ形で読め、`PasswordHash.create("")` が投げる `InvalidPasswordHash`（「ハッシュが空」）ではなく「列が NULL」という実際の原因がそのまま `cause` に残る。
- **[N-005]** `reconstruct` は `createdAt` / `updatedAt` を素通しする（`entity.ts:196-197`）。ドライバが不正な整数を `new Date(NaN)` にして返した場合、`RehydrationError` にならず `Invalid Date` を持った `User` が組み上がる。`UserId` / `Email` / `Version` / `TrashRetentionDays` がすべて再検証されている中でここだけ検証が無いのは非対称で、`Version.create` と同じ粒度で `Number.isNaN(date.getTime())` を見るだけで揃う。R1 の W-003 で「同じ関数は createdAt / updatedAt の妥当性も検証していない」と言及されたが triage に上がらなかったので、判断として残っているかを確認したい。
- **[N-006]** `burnVerificationTime` の `catch {}` は `PasswordHasher` 由来の例外だけでなく、配線ミス（`passwordHasher` が undefined）や実行環境の異常も等しく飲む。ダミー verify の主旨からは「何が起きても未登録アドレスを 500 にしない」で正しいが、W-001 の (b)（`logger.warn`）を入れればこの副作用も同時に可視化される。
- **[N-007]** `MIN_SESSION_SECRET_LENGTH = 32` が `application/di/secrets.ts:34` と `adapters/webcrypto/hmacSessionCodec.ts:16` の2箇所に別々に定義されている。後者は `export` されているので前者から参照できるが、`secrets.ts` を意図的にアダプター非依存に保っている（ADR-002 の「署名済みブロブかセッションテーブルの鍵かはアダプターの business」）なら重複は妥当な判断でもある。どちらの意図かがコードから読めないので、`secrets.ts` 側に「アダプターの最小長とは独立に、アプリケーション層が要求する下限」である旨を1行添えるか、参照に寄せるかを決めておきたい。
- **[N-008]** 未実装の spec 要素は前回同様 plan.md のスコープ節と一致していることを再確認した: `UserRepository.findBySsoIdentity`、`TokenScope`、`AiClientConnection` 一式、`IdentityErrorCode.PasswordNotSupported`。R1 の N-005（登録エンドポイントのレート制限）は triage で `defer`（#18）、N-006（`logout` の `UserId.create` と spec の「エラーケース: なし」の字面差）と N-007（`NotFoundError` メッセージへの userId 埋め込み）は据え置きで、いずれも判断として妥当。ダミー verify の導入で「未登録アドレスへのログイン試行も本物と同じ CPU を払う」ようになったため、#18 のレート制限の優先度は R1 時点より上がっている（ADR-026 の Consequences も同じ指摘をしている）。
