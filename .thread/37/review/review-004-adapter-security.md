# Adapter / Infrastructure + Security（4周目）

PR #49 / base `main` / 契約 `.thread/37/plan.md` / 変更ファイル 265 件

3周目は Blocker ゼロ・5観点すべて「マージ可」で、残った Warning 3件（ADP-W-001 / ADP-W-002 / TEST-W-001）を `d71055a` が修正した。本レビューはその差分（16ファイル）を実装側で1件ずつ検証し、**新しい退行が入っていないか**と、修正エージェント自身が申告した **ADR-121 のユーザー可視の副作用を許容できるか**だけを見る。

**結論: Blocker 0 / Warning 0。ADR-121 の代償は妥当。マージ可。**

3周目 N-001 が残していた「清浄なツリーでの `pnpm test:integration` 1回」も本レビューで実施し、緑を確認した（N-001）。

---

## Blockers

なし。

---

## Warnings

なし。

3件の修正はいずれも申告どおりに実装され、変異試験で検出力も確認した（N-002）。修正が新たに作った経路（`armAfterRpc` の前倒し条件 / `reserve` の刻印 / 遠未来武装の観測）を一巡したが、**受け入れ基準に反するもの・実際に悪用できるもの・実装が壊れているものは見つからなかった。**

---

## ADR-121 の判定

**許容できる。この代償は妥当である。** 代替案は4つ検討したが、どれも「不変条件を保ちつつ代償を払わない」を達成せず、うち2つは列挙オラクルを壊す。

### 何を買って何を払ったか

払ったもの: `reserve` の直後（= サインアップ直後）から**その窓の残り最大15分**、当該アドレスへのパスワードリセット依頼が黙って非適格になる。応答はスロットル中と同一なので、利用者から見ると「メールが来ない」だけである。

買い戻したもの: 「適格な依頼は必ず未使用の `operationKey` に着地する」という**全称の**不変条件。これが破れていた経路では、トークンが発行され（= `issue` がその credential の未使用行を消し）、配送ジョブは `done` 行に衝突して立たない。つまり**黙って未達**であり、しかも `jobBudgets.ts` / `facade.ts` / `mappingOperations.ts` の3箇所が全称で断定していた宣言と食い違う。#12（リセット完了）と #44（ローテーション）はこの宣言を前提に読む。

### 許容と判断した根拠（5点）

1. **有界かつ自己修復する。** 影響は「行が生まれた窓」に閉じ、最大15分・平均7.5分。次窓の最初の依頼は必ず適格になる（ADR-091 の窓番号判定）。
2. **第三者が誘発できない。** 新しい刻印を書くのは `reserve` だけで、既存行があるときは1文も書かずに `alreadyRegistered` を投げる（`mappingOperations.ts:62-70`）。したがって**登録済みアドレスの適格性を外部から後ろへ倒す経路は無い**。影響を受けるのは「たった今自分でパスワードを設定した本人」に限られる。`cancel` / `delete` → `reserve` の作り直し経路も `operationId` + `callerToken` 束縛の内側にある。
3. **観測面が増えない。** 非適格ケースの応答・ジョブ行数・`next_run_at` は既にスロットル中と同一で、`sendMail.integration.test.ts` の4ケース一様性テストがそれを固定している。ここで「登録直後です」と区別可能な応答を返したら、それ自体が列挙オラクルになる。**黙っていることは副作用ではなく要件側の帰結である。**
4. **回避した失敗のほうが重い。** 未達は同じ15分でも、こちらは「トークンが発行済み・配送ジョブなし」という**状態の不整合**を残す。とくに削除→同一窓での再作成（#12 / #45 の経路）では、その窓の `send-mail` が実際に送信済みであり、`providerIdempotencyKey = SHA-256(operationKey)` は決定的なので**再投入してもプロバイダ側で重複破棄される** — つまり「発行するが絶対に届かないトークン」を作る。ADR-121 はその変種も同時に閉じる。
5. **本 PR 時点のユーザー可視コストは実質ゼロ。** `requestPasswordReset` はまだ外部到達不能で（`grep -rn requestPasswordReset apps/web` は DO クラスと統合テストのみ、3周目 security N-009 と同じ実測）、入口を作るのは #12 である。実際に利用者が踏むのは #12 以降であり、文言と併せて再考する余地も #12 に残っている。

### 検討して採らなかった代替案

| 案 | 中身 | 採らない理由 |
|---|---|---|
| (A) `reserve` が当該窓の `done` な `send-mail` 行を掃除する | 提案どおり `operation_key = 'send-mail:{kind}:{hmac}:{k}'` を消す | (i) `reserve` の**発行文数が「その窓にそのアドレスへの依頼があったか」に依存する**ようになり、サインアップ側に新しい（弱い）オラクルを作る。(ii) **削除→再作成の変種を直せない** — その窓のキーは実際にプロバイダへ渡っており、再投入は `providerIdempotencyKey` の一致で破棄される。(iii) 消すのは at-least-once の記録そのもの |
| (B) 受信者が居なかった `send-mail` が自分の行を消す（`done` を残さない） | 遅延ゼロで穴が閉じる。実際、行が未実行なら衝突は起きず正しく配送される | **コードベースが既にこの案を明示的に否定している** — `jobs/table.ts` の `JobRetention` JSDoc は「`send-mail` の保持は *kind* スコープであり outcome スコープではない。受信者を見つけたか否かで寿命が変わったら、寿命自体が列挙オラクルになる」と書いている。加えて同一窓の再依頼が、未登録なら INSERT・登録済みなら no-op になり、**文数の非対称**が復活する |
| (C) `operationKey` の構成を変える（`credentialId` や写像ごとの連番を混ぜる） | 窓キーの衝突自体を無くす | 未登録アドレスには混ぜる値が存在しないので、**キーの形がケースで割れる**。`payload_digest` 不一致の `ConflictError` が「登録済みか」を答える ADR-029 のオラクルに戻る |
| (D) `send-mail` を再武装種にする | `done` 行が復活して配送が立つ | `table.ts` が明示的に拒否（起床回数が依頼数に比例する）。かつ**無意味** — 冪等キーが決定的なのでプロバイダ側で破棄される |
| (E) 条件付き刻印（当該窓のキーが使用済みのときだけ `created_at` を入れる） | 通常時は即時適格を維持できる | `reserve` の書き込み内容がデータ依存になり (A) と同じ弱いオラクルを作る。かつ**全称の不変条件を条件付きに戻す** — 今回の修正が消しに行ったものそのもの |

### 実装の検証

- バインドと列の対応を1つずつ数え直した（列26 / プレースホルダ17 / バインド17、順序一致）。`created_at` / `updated_at` と同じ `timestamp` を使うので行内で自己整合する（`mappingOperations.ts:72,101-119`）。
- `isResetRequestAllowed` は `isSettled`（`status === 'active'`）を先に見るので、**`reserved` 段階の行はそもそも適格になりえない**。刻印が効き始めるのは activate 以降で、窓の起点は予約時刻。設計意図どおり。
- `null` アーム（既存行の後方互換）は残っており、JSDoc がその射程を明記している（`credentialMappingRules.ts:97-101`）。
- `last_reset_requested_at` の読み手は `isResetRequestAllowed` だけ、書き手は `reserve` と `recordResetRequested` だけ（grep で全数確認）。他の判定を巻き込んでいない。
- 変異試験: バインドを `NULL` に戻すと `sendMail.integration.test.ts` の "does not let a mapping born mid-window spend a send-mail key an earlier request already used" **のみ**が赤（`expected 1 to be +0`）。ADR-121 の申告と一致。

### 引き継ぎの提案（Note 扱い、本 PR で必須ではない）

`spec/database/index.md` の列注記は**機構**を書いているが、**利用者に見える帰結**（登録直後の窓はリンクが届かない・応答はスロットル中と同一）は spec / usecase 側のどこにも無い。`application/identity/requestPasswordReset.ts` には既に「## Handoff to #44」の段落があるので、同じ形で #12 向けに1段落足しておくと、入口を作る側が文言を決める前に気づける。

---

## 3回目指摘の修正検証

| ID | 判定 | 根拠 |
|---|---|---|
| **ADP-W-001** `armAfterRpc` が既存 Alarm を後ろへずらせる | **解消** | `alarm.ts:116-118` で `cache.scheduledAt !== null && cache.scheduledAt <= at` なら `persist` しない。`settleAlarm` / `rearmBeforeWork` / `rearmFailClosed` は無条件のまま。ADR-120 の「後ろへ倒したい正当な経路はすべて `alarm()` の内側」は**自分で確認した** — `setAlarm` / `deleteAlarm` の本番呼び出し点は `alarm.ts:41` / `:74` の2箇所だけ（grep 全数）で、`armAfterRpc` を呼ぶのは `rpcEntry.ts:53` 1箇所、他の3経路は `alarm()` からしか呼ばれない（`durable-objects/{userData,identityDirectory}.ts` の4箇所）。前倒しは通る（遠い武装があるところへ due な行が来ると `at < cache` で `persist` する）ことも式で確認した。変異試験でこの条件を外すと該当テスト1本だけが赤 |
| **ADP-W-002** 写像行の生成をまたいで不変条件が破れる | **解消** | 上記「ADR-121 の判定」参照。宣言側（`jobBudgets.ts:54-59` / `credentialMappingRules.ts:97-101` / `mappingOperations.ts:101-110`）と `spec/database/index.md`:586 も同時に更新され、**断定と実装が一致した**。宣言だけ直った形ではなく、変異試験に検出力がある |
| **TEST-W-001** AC-12 (iii) が Identity Directory クラスで未担保 | **解消** | `rpcEntries.integration.test.ts` に1本追加。**自分で変異試験を実施した** — `identityDirectory.ts` の `entry()` を「`gate()` → `ok(body())` / `err(error)`」の手書き（arming 無し）に置き換えると、統合187件のうち**この1本だけ**が `expected null to be 4000000000000` で赤。3周目が「既存の欠落」と実測した MUT-6 が検出されるようになっている。遠未来（`4_000_000_000_000`）にしたことで `getAlarm()` が値を返すこと、RPC 前の `getAlarm() === null` を陰性対照に置いていることも妥当（`enqueueJob` 自身が張った可能性を排除している） |

**新たな退行: なし。** 3つの変更はいずれも列挙オラクル・冪等性・収束規則・OCC・migration ゲート・秘密の配布境界のどれにも触れていない。機械検証も再実行して AC-4（`idFromName` / `getByName` は `serverCloudflare.ts:149,159` の2件のみ）、AC-5（両 facade で生 `sql` 0件）、AC-23（本番コードの `Date.now()` はコメント2件のみ）がいずれも維持されていることを確認した。

---

## Notes

### **[N-001]** 清浄なツリーでの AC-29 全量確認（3周目 N-001 の宿題）

作業ツリーが `git status --porcelain` で空であることを確認した上で実行し、すべて緑:

- `pnpm typecheck` — 3プロジェクト
- `pnpm lint` / `pnpm format:check` — 220 / 239 ファイル
- `pnpm test:unit` — **36 files / 525 tests**
- `pnpm test:integration` — **19 files / 187 tests**
- `pnpm build` → `pnpm test:smoke` — **1 file / 2 tests**（request / state の両成果物）

3周目 N-001 が「別エージェントの未コミット実験のせいで清浄な全量実行ができなかった」と残した1点はこれで閉じる。`pnpm lint` が出す `2 infos` は `biome.json` の `$schema` が 2.4.15、解決される CLI が 2.5.5 という環境側の不一致で、`biome.json` は本 PR の変更対象外（265件に含まれない）。lint 自体は 0 で終了する。

### **[N-002]** 変異試験3本（すべて「修正前は赤・修正後は緑」を再現）

復元はスナップショット + `cp`（`git checkout` は使っていない）。各変異とも**赤になったのは狙ったテスト1本だけ**で、巻き添えも空振りも無い。

| # | 変異 | 結果 |
|---|---|---|
| MUT-1 | `alarm.ts:117` の前倒し条件を削除 | `never pushes an existing arm later from an RPC entry` のみ赤（186 passed / 1 failed） |
| MUT-2 | `reserve` の `last_reset_requested_at` を `NULL` に戻す | `does not let a mapping born mid-window spend a send-mail key an earlier request already used` のみ赤 |
| MUT-3 | `identityDirectory.entry()` を手書きゲート + envelope（arming 無し）へ | `arms the alarm its queue asks for on the way out of a gated entry` のみ赤 |

MUT-2 で他が1本も落ちないことは、**旧 NULL 挙動に暗黙に依存しているテストが残っていない**ことの裏返しでもある（`identity.integration.test.ts` の `signedUpInAnEarlierWindow` による均しが効いている）。

### **[N-003]** `AlarmCache` の非単調性は実害を持たない — ただし残る乖離を1つだけ言語化しておく

依頼された点なので明示的に書く。`AlarmCache` は「このインスタンスが張ったと信じている値」であって、ストレージの実値ではない。両者が乖離しうる本番経路を全数で洗い出した:

- **配信された** — 直後に `alarm()` の `rearmBeforeWork` が `persist` してキャッシュを更新する（`identityDirectory.ts:282` / `userData.ts:157`。`try` の最初の文）。乖離しない。
- **`deleteAlarm()`** — 本番では `settleAlarm` の1箇所だけで、同じ関数が `cache.scheduledAt = null` を書く。乖離しない。
- **インスタンス再生成** — キャッシュは `null` に戻り、次の RPC が必ず1回張る（安全側）。
- **残る1つ**: 配信された後に `rearmBeforeWork` と `rearmAfterFailure` → `rearmFailClosed` が**両方**失敗した場合（= 書き込みを拒否する DO。10 GB 上限）。ストレージには alarm が無く、キャッシュには過去の値が残る。この状態で RPC が来ると前倒し条件に当たって `armAfterRpc` が何もしない。
  - ただし**この状態で `setAlarm` は成功しない**ので、ADR-120 以前も武装は復旧しなかった。差分は「RPC が `err` を返す」か「`ok` を返す」かだけで、DO が起床しない事実は同じである。書き込みが恒久的に拒否される DO はどのみち運用介入（#38）の対象で、インスタンスがエビクトされればキャッシュが `null` に戻って自然に復旧する。
  - `disarm()` がキャッシュを触らずに alarm を消す件は**テスト専用**（`doHarness.ts:68` のみ。本番コードに `disarm` は無い）。ADR-120 の下では「`disarm` 後の同一インスタンスへの RPC はもう張り直さない」という副作用が加わるが、`disarm` の JSDoc は「武装そのものが観測対象のスイートでは使うな」と既に書いており、実際に武装を観測する2ファイル（`jobs/__tests__/alarm.integration.test.ts` / `rpcEntries.integration.test.ts`）は使っていない。

したがって **ADR-120 の「他の3経路には置かない」判断は正しく、非単調性が実害を持つ経路は無い。** 強いて言えば `doHarness.ts` の `disarm` JSDoc の「`AlarmCache` を触らない」の段落に、ADR-120 以後の帰結（以降の RPC も張り直さない）を1文足しておくと、次に読む人が誤読しない。

### **[N-004]** ADR-122 は AC-12 (iii) を担保している — ただし担保の分担は3ファイルにまたがる

新テストが押さえるのは「**Identity Directory クラスが共有実装 `runRpcEntry` を経由し続ける**」の1点で、成功経路である。AC-12 (iii) が要求する「成功・失敗のどちらの経路でも発火する」の**失敗側**は `jobs/__tests__/alarm.integration.test.ts` の "the RPC entry wrapper" 4本（2周目 test W-002 の成果）が共有実装に対して押さえている。両者を合わせて (iii) は全数になる — MUT-3 が示すとおり、クラス側が共有実装を外れれば新テストが必ず落ちるので、共有実装に対する検証がクラスへ伝播する構造になっている。分担が3ファイル（`alarm` / `cleanup` / `rpcEntries`）に散っている点だけは、次に触る人のために ADR-122 の Context に書いてあるとおりで、追加の対応は不要。

### **[N-005]** `triage.md` に3周目の3件が追記されていない

`triage.md` 冒頭は「各エージェントが追記する」と定めているが、表は2周目の項目で終わっており、ADP-W-001 / ADP-W-002 / TEST-W-001 の行が無い。記録自体は adr.md の ADR-120 / 121 / 122 とコミットメッセージにあるので**情報は失われていない**が、次のラウンドが `triage.md` だけを読むと3周目の判定が見えない。5周目が不要（マージ）なら実害は無いので、Note に留める。

### **[N-006]** `sweep-reset-tokens` の境界一致警告（3周目 N-007）は未対応のまま

`handlers/sweepResetTokens.ts:58-63` の `logger.warn("clamping the re-arm")` は境界ちょうどの起床で無害に1回出る。3周目が #38（可観測性）へ回した項目で、今回の3件とは無関係。挙動は正しい（有界・自己回復）ので再掲のみ。

---

## カバレッジ

確認 **182** 件 / スキップ **83** 件 = **265** 件。

**読み方**: 変更ファイル一覧が3周目の 259 件と完全一致することを機械確認した上で（`git diff --name-only origin/main...HEAD` と付与された一覧が完全一致。差分の 6 件は `review-003-*.md` 6本のみ）、3周目の確認 178 / スキップ 81 を土台にし、`d71055a` が実際に動かした16ファイルは差分を全文で読み直した。加えて依存先（`jobs/table.ts` の収束規則・`JobRetention` / `platform/rpcEntry.ts` / `handlers/sendMail.ts` / `identityDirectory/facade.ts` / `__tests__/doHarness.ts` / `durable-objects/{userData,identityDirectory}.ts` / `schema/identityDirectory.ts`）を再照合した。

3周目からの移動は2つだけ:

- **追加（+6）** — `review-003-adapter-infra.md` / `review-003-security.md` / `review-003.md` を確認（+3）、`review-003-{domain-usecase,presentation-config,test}.md` をスキップ（+3、他観点の担当）
- **スキップ → 確認（+1 / −1）** — `packages/core/src/application/identity/__tests__/identity.integration.test.ts`（`signedUpInAnEarlierWindow` の追加が ADR-121 の副作用を直接受ける箇所なので本観点で読んだ）

### スキップ（83）

**他観点のレビュー成果物（13）** — `triage.md` / `review-003.md` で該当項目のみ参照
`.thread/37/review/review-001-{domain-usecase,presentation-config,security,test}.md`, `.../review-001.md`, `.../review-002-{domain-usecase,presentation-config,security,test}.md`, `.../review-002.md`, `.../review-003-{domain-usecase,presentation-config,test}.md`

**作業ログ・手順書（2）** — 判定の契約は `plan.md` の受け入れ基準に一本化
`.thread/37/steps.md`, `.thread/37/testing.md`

**利用者向けドキュメント（4）** — AC-20 の grep で機械確認済み／#38 の担当
`README.md`, `docs/backend_implementation_example.md`, `docs/runtime_cloudflare.md`, `docs/test.md`

**ADR の書き戻し（1）** — Domain / Usecase 観点の担当
`.adr/008-identity-split-and-non-aggregate-stores.md`

**presentation 層（17）** — Presentation / Config 観点の担当
`apps/web/app/components/auth/{LoginForm,SignupForm}/action.ts`, `.../settings/CurrentUserPanel/index.tsx`, `.../settings/LogoutButton/action.ts`, `.../settings/SettingsSkeleton/index.tsx`, `.../ui/ErrorSurface/index.tsx`, `apps/web/app/routes/_app.tsx`, `apps/web/app/routes/_app/settings.tsx`, `apps/web/app/presentation/{authState,currentUser,errorResponse,errorResponseMiddleware,session}.ts`, `apps/web/app/presentation/__tests__/{currentUser,errorResponse,errorResponseMiddleware,session}.test.ts`

**webcrypto（3）** — 逆流依存の解消（定数移動）のみ。DO / SQLite 観点に接しない
`packages/core/src/adapters/webcrypto/{hmacSessionCodec.ts,pbkdf2PasswordHasher.ts,__tests__/hmacSessionCodec.test.ts}`

**application の DI / 型・テストハーネス（10）** — Usecase / Security 観点の担当
`application/__tests__/helpers.ts`, `application/di/__tests__/{noAdapterBackflow,requestContainerConfig,routingNonExposure,secrets,serverCloudflare(D)}.test.ts`, `application/di/{containerStore,types}.ts`, `application/execution/__tests__/unitOfWork.typetest.ts`, `application/ports/idGenerator.ts`

**application identity の usecase 側（10）** — Domain / Usecase 観点の担当
`application/identity/__tests__/{eventDecoders(D),loginWithPassword,logout}.test.ts`, `application/identity/{eventDecoders(D),getCurrentUser,loginWithPassword,registerWithPassword,view}.ts`, `application/ports/sessionCodec.ts`, `application/rpc/__tests__/restoreError.test.ts`

**domain 層（15）** — Domain 観点の担当（`credentialMappingRules.ts` / `credentialMappingStore.ts` / `passwordResetTokenPort.ts` は確認側）
`domain/common/transactionalRepository.ts`, `domain/identity/__tests__/{credentialMappingRules,entity,noRawNul,valueObject}.test.ts`, `domain/identity/{entity,errorCode,valueObject}.ts`, `domain/identity/ports/{accountStore,credentialLocatorStore,credentialMappingRepository,mailSender,rotationCheckpointStore,userSettingsRepository,userRepository(D)}.ts`

**lib のうち定数移動のみ（2）**
`packages/core/src/lib/{passwordHashing.ts,secretLengths.ts}`

**spec のうち他観点の正本（6）**
`spec/domains/identity.md`, `spec/inventory/{domain,usecase}.md`, `spec/manual-tests/search.md`, `spec/testcases/identity/unlinkSsoCredential.md`, `spec/usecases/identity.md`

### 確認（182）

上記スキップ83件を除く残り全件。3周目の確認178件（内訳は `review-003-adapter-infra.md`「カバレッジ」節と同一）に、`review-003-adapter-infra.md` / `review-003-security.md` / `review-003.md` / `application/identity/__tests__/identity.integration.test.ts` の4件を加えたもの。

うち `d71055a` で実際に動き、**差分を全文で読んだ11件**は次のとおり:

`.thread/37/adr.md`（ADR-120 / 121 / 122）, `spec/database/index.md`（`last_reset_requested_at` 行）,
`packages/core/src/adapters/cloudflare/jobs/alarm.ts`, `.../identityDirectory/mappingOperations.ts`, `packages/core/src/domain/identity/credentialMappingRules.ts`, `packages/core/src/lib/jobBudgets.ts`,
`.../jobs/__tests__/{alarm,sendMail}.integration.test.ts`, `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`,
`.thread/37/review/review-003-adapter-infra.md`

---

## マージ可否

**可。** Blocker 0 / Warning 0。

- 3周目の3件は実装・宣言・テストの3点が揃って解消し、変異試験で検出力も確認した（自分で3本実施、いずれも狙った1本だけが赤）。
- **ADR-121 が持ち込んだ「サインアップ直後の最大15分間、リセットが黙って効かない」は許容できる** — 有界・自己修復・第三者から誘発不能・観測面の増加なし。代替案4つはいずれも列挙オラクルを壊すか、削除→再作成の変種を直せないか、条件付き不変条件へ戻す。
- 新しい退行は見つからなかった。AC-4 / AC-5 / AC-23 の機械検証も再実行して維持を確認した。
- AC-29 は清浄なツリーで全量確認済み（typecheck / lint / format:check / unit 525 / integration 187 / smoke 2）。3周目が残した唯一の宿題はこれで閉じている。

Note 6件はいずれも #38 / #12 への引き継ぎか、次に読む人向けの1文追記の提案であり、マージの条件ではない。
