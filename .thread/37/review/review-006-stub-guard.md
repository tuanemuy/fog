# レビュー 006 — Stub ガードの修正（差分限定・6周目）

- **対象**: `git diff c79c952..HEAD`（`fd6d1f8` / `219428c`）
- **PR**: #49 / ベース `main`
- **前提**: 5周目で APPROVED（Blocker 0 / Warning 0 / AC 30項目 OK）。本ラウンドはブラウザ検証 TC-E03 で見つかった変更起因 FAIL とその修正差分に限定する
- **実質の対象コード**: `packages/core/src/application/di/serverCloudflare.ts`（`isThenable` 追加 + 分岐差し替え）/ `packages/core/src/application/di/__tests__/stubGuard.test.ts`（新規・unit 7ケース）/ `packages/core/src/application/di/__tests__/stubGuard.integration.test.ts`（新規・integration 1ケース）。ほかは作業ログ（`.thread/37/**`）のみ

### Stub ガードの修正

#### Blockers

なし。

#### Warnings

**[W-001]** ADR-131 の「統合環境では stub 呼び出し自体の非同期失敗を意図的に起こせない」は**誤り**。実測で起こせる。したがって「統合側は翻訳そのものを見ていない」という分担は、技術的制約ではなく選択である
/ 場所: `.thread/37/adr.md:2370`（ADR-131 Context）/ `.thread/37/adr.md:2384`（同 Consequences のトレードオフ）/ `packages/core/src/application/di/__tests__/stubGuard.integration.test.ts:26`
/ 理由: 挙げられている3つの根拠のうち2つは実測どおりだが、**3つ目が反例を持つ**。

| 主張 | 自分の実測 | 判定 |
|---|---|---|
| 未実装メソッド呼び出しは `@cloudflare/vitest-pool-workers` のラッパ由来 | `TypeError: The RPC receiver does not implement "…"` が `dist/worker/lib/cloudflare/test-internal.mjs:346 assertRPCPropertyAccessible` から出る。加えて `uncaught exception; source = Uncaught (in promise)` のノイズが1件出る | **主張どおり** |
| `Symbol.dispose` はラッパが露出していない | `typeof stub[Symbol.dispose]` / `[Symbol.asyncDispose]` ともに `"undefined"` | **主張どおり** |
| 非 cloneable 引数は workerd が stub 化して通す | **関数引数についてのみ正しい**。`getCurrentUser(() => "x", 1)` は stub 化されて通り、通常のエンベロープが解決した。しかし **`Symbol` 引数は stub 化できない** — `getCurrentUser(Symbol("nope"), 1)` は `JsRpcPromise` を返し、それが `DataCloneError: Symbol(nope) could not be cloned.` で**非同期に reject** する。ラッパ由来ではなく workerd の structured clone 由来で、`Uncaught (in promise)` のノイズも出ない | **反例あり** |

この経路は `guardStub` から見て「stub 呼び出しが非同期に失敗した」そのものなので、統合側で翻訳まで観測できる。実際に一時テストで確かめた（本レビュー後に削除済み）:

```ts
const facade = createTestContainer().userDataStubFactory(USER_ID);
await facade.getCurrentUser(Symbol("nope") as never, 1);
// => 修正後: SystemError(DATABASE_ERROR)  ✅ isSystemError === true
// => `instanceof Promise` へ戻すと: DataCloneError が素通り  ❌ 赤
```

つまりこの1本は **MUT-1 を検出する**（変異試験の節に実測を載せた）。現状の unit/integration の分担でも回帰は捕まる（後述のとおり MUT-1 / MUT-2 は unit 2本 + integration 1本が赤）ので**マージを止める理由にはならない**が、ADR は将来の判断根拠として残るものなので、事実と違う制約が書かれているのは直しておきたい。

/ 提案: どちらか一方。**(a)** ADR-131 の Context 3点目を「関数引数は stub 化されて通るが、`Symbol` 引数は `DataCloneError` として非同期に reject する」に訂正し、トレードオフ欄の「翻訳そのものは見ていない」を「見られるが unit と重複するので置いていない」へ改める。**(b)** `stubGuard.integration.test.ts` に上の1ケースを足し、トレードオフ欄ごと消す。(b) のほうが観測点として強い（フェイクの形が正しいことを前提にせず、本物の非同期失敗に対して翻訳が発火することを直接見る）が、`Symbol` を渡すのは facade の契約から外れた作為的な入力なので、その旨のコメントは要る。

**[W-002]** `guardStub` を async にしない判断の**根拠が事実と違う**。「`readSchemaVersion` の union の同期側が消える」と書かれているが、その union は現状どこからも要求されていない
/ 場所: `.thread/37/adr.md:2339`（ADR-130 Decision 2）
/ 理由: 3点を実測した。

1. **union を潰しても型検査は通る。** `facades.ts:51` を `readSchemaVersion(): Promise<RpcEnvelope<number>>;` に狭めて `pnpm typecheck` → 3パッケージすべて Done。
2. **DO クラスのインスタンスを `UserDataFacade` として渡している箇所は無い。** `UserDataFacade` / `IdentityDirectoryFacade` の全出現を grep した結果、facade 型が付くのは合成ルート（`serverCloudflare.ts:174/184`）と、**すでにガード済みの stub を包み直す**テストヘルパ（`identity.integration.test.ts:765` の `withInitializeAccount`、`readSchemaVersion: () => real.readSchemaVersion()`）だけ。`rpcEntries.integration.test.ts:206/250` は `as unknown as UserDataDurableObject` で DO クラス型に落としており facade を経由しない。
3. **union の出自に記録が無い。** `git log -S` で追うと初出はカットオーバー commit `2793a22` で、当時の ADR に理由の記載が無い。ADR-130 の説明は事後の再構成である。

実験として `guardStub` を async 化（`return async (...args) => { try { return await method(...args); } catch (e) { return translateStubError(e); } }`）してテストを回すと、**赤くなるのは本 PR で新設した `leaves a synchronously returned envelope synchronous` 1本だけ**で、integration 188件は全緑だった。つまり async 版も動作としては等価であり、いま同期側を守っているのは「同期側を守るために書かれたテスト」1本である。

/ 提案: **コードは変えなくてよい。** 現行の非 async 版は正しく、差分も最小で、`Promise.resolve` 版を選んだ判断は W-003 のとおり別の（そして本物の）制約に支えられている。直すべきは ADR-130 Decision 2 の文言で、「union が消える」ではなく「**ガードは stub の戻り値を作り変えない**（非 thenable はそのまま返す）という不変を保つほうが、プロキシとして侵襲が小さい。`readSchemaVersion` の union はその不変が観測できる唯一の場所である」といった、実際に成り立っている理由に置き換えること。あわせて「この union に production の要求は無い」を1文添えると、将来 union を消すときの判断材料になる。

#### Notes

**[N-001]** ADR-130 Decision 3 が退けた `result.then(undefined, translateStubError)` は、「戻り値の契約が弱い」どころか**そもそも動かない**。自分で置き換えて計測したところ、workerd が `TypeError: Failed to execute 'then' on 'JsRpcPromise': parameter 1 is not of type 'Function'.` を投げ、統合テストが 26件赤になった（`stubGuard.integration.test.ts` + `identity.integration.test.ts` 25件）。`Promise.resolve(result).catch(...)` を選んだのは好みではなく**唯一の選択肢**である。ADR にこの実測を1行足しておくと、将来「元のハンドルの `then` を使えばよいのでは」と誰かが戻すのを止められる。

**[N-002]** `Promise.resolve(...)` で adopt することによる副作用は見当たらない。stub メソッドの呼び出し点は production に8箇所（`signupSaga.ts:138/153/233/257/295`・`getCurrentUser.ts:28`・`loginWithPassword.ts:141/166`・`requestPasswordReset.ts:61`）で**すべて `await` されており**、fire-and-forget も `Promise.all` / `waitUntil` による並列も無い（grep 実測、`Promise.all` は `presentation/serverAction.ts:13` の1件のみで stub 無関係）。したがって「adopt した派生 Promise が unhandled rejection になる」経路は無く、あったとしても修正前（生の `JsRpcPromise` が unhandled になる）と件数は同じで退行ではない。

**[N-003]** `isThenable` の判定そのものは正しい。`value !== null` は `typeof null === "object"` を弾くために必須（外すと `null.then` で TypeError）、`undefined` は `typeof` で落ちる、`typeof === "function"` の枝が本物の `Rpc.Result` を拾う（統合テストが `[object JsRpcPromise]` として実測）。`then` を持つ偽陽性は facade の契約上ありえない。JSDoc が「両方の近道がなぜ効かないか」を書いており、コメント方針（WHY のみ）にも沿っている。

**[N-004]** リポジトリ初の `biome-ignore`（`stubGuard.test.ts:55`）は**必要**。外して `pnpm lint` を回すと `lint/suspicious/noThenProperty` が 1 error で落ちることを確認した。回避策（`Object.defineProperty` / 計算プロパティキー）はルールを潜り抜けるだけで意図が読めなくなるので、`biome-ignore` + 理由コメントのほうが良い。Biome 自身の但し書き（"unless you intentionally need a thenable object"）にも該当する。`biome-ignore` は現時点でリポジトリ全体でこの1件のみ（grep 実測）。

**[N-005]** AC-4 / AC-25 は動いていない。plan.md の検証手段をそのまま実行した。
- AC-4: `grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app | grep -v '/__tests__/'` → `serverCloudflare.ts:178` / `:188` の2件のみ。新規統合テストの `ns.idFromName(USER_ID)`（`stubGuard.integration.test.ts:22`）は `__tests__/` 配下で ADR-028 の除外範囲内、かつテスト自身が「テストだけが許される直接アドレッシング」とコメントしている
- AC-25 (i): `presentation` の import 0件 / (ii): `application → adapters` の逆流 import 0件（`di/` と `__tests__/` を除外して）。新規 unit テストの import は `application/errors` / `config` / `../secrets` / `../serverCloudflare` のみで逆流無し

**[N-006]** CLAUDE.md のエラーハンドリング節に対する退行なし。
- value envelope の契約（DO 内部の失敗は `{ ok: false, error }`、stub 呼び出し自体の失敗は呼び出し側アダプタが翻訳）は**修正後に初めて非同期経路でも実際に成立した**。この差分は規約への準拠を回復するものであって、逸脱を増やしていない
- cross-layer catch policy: 新しい broad catch は追加されていない。`guardStub` の `try/catch` は既存のもので位置も範囲も不変。`translateStubError`（`adapters/cloudflare/platform/stubErrors.ts`、戻り型 `never`）を `application/di/` から呼ぶのは AC-25 が明示的に除外している合成ルート経路
- HTTP ステータスは修正前後とも 500。クライアントへ返る `SerializedError` に `retryable` が乗るようになった分だけ情報が増え、内部文言の漏洩は TC-E03 の再検証で grep 確認済み

**[N-007]** テスト配置は正しい。`stubGuard.test.ts` は node pool（`vitest.config.ts`、`*.integration.test.ts` を除外）、`stubGuard.integration.test.ts` は Workers pool の allow-list `packages/core/src/application/**/*.integration.test.ts` に一致する。変異試験中に両方が実際に収集・実行されていることを実測で確認した（unit 7ケース / integration 1ケース）。「どちらのスイートにも入らない」事故は起きていない。

**[N-008]** 変異試験の途中で `pnpm test:smoke` が一度赤になったが、これは**自分の作業由来**である（ファイル復元で mtime が dist より新しくなり、`boot.smoke.test.ts:148` の陳腐化ガードが発火した）。`AssertionError: … is older than the sources it was built from; re-run pnpm build:cf`。ガードが設計どおり働いた証拠であり、再ビルド後は緑。差分の問題ではない。

#### 自分で行った変異試験

復元はすべて `git checkout` ではなくスナップショット（`scratchpad/snap/*.orig`）からの `cp`。各回のあとに `shasum` で原本一致を確認した。

| # | 変異 | 期待 | 実測 | 判定 |
|---|------|------|------|------|
| MUT-1 | `isThenable(result) ? Promise.resolve(result).catch(…)` を `result instanceof Promise ? result.catch(…)` へ戻す（不具合の再導入） | 赤 | **unit 2本**（`translates a failure that arrives as a rejected RPC result` / `carries the overloaded marker through the asynchronous path`）+ **integration 1本**（`interposes on the handle workerd returns…`、`expected false to be true` @ `:40`）が赤 | **検出** |
| MUT-2 | `isThenable` を `typeof value === "object"` だけに狭める | 赤 | 同じ **unit 2本 + integration 1本**が赤 | **検出** |
| MUT-3 | 同期 catch の翻訳を無効化（`return translateStubError(error)` → `throw error`） | 赤 | unit 1本（`still translates a failure thrown by the call itself`）が赤 | **検出** |
| MUT-4 (= ADR 未記載) | `guardStub` を async 化（`return await result` + catch で翻訳） | — | **integration 188件は全緑**、赤は unit 1本（`leaves a synchronously returned envelope synchronous`）のみ → W-002 の根拠 | 参考 |
| MUT-5 (= ADR 未記載) | ADR-130 が退けた代替 `result.then(undefined, translateStubError)` へ差し替え | — | **integration 26件が赤**。原因は `TypeError: Failed to execute 'then' on 'JsRpcPromise': parameter 1 is not of type 'Function'.` → N-001 の根拠 | 参考 |
| MUT-6 | フェイク `rpcResult` を本物の `Promise`（`Promise.resolve().then(settle)`）に差し替える（フェイクの陳腐化を模す） | 赤 | unit 1本（`keeps the fixture shaped like a real RPC result, not like a Promise`、`expected true to be false` @ `:118`）が赤 | **検出**（陰性対照が機能している） |
| PROBE-1 | ADR-131 の3根拠を本物の stub で個別に実測（未実装メソッド / `Symbol.dispose` / 非 cloneable 引数） | — | 3つ目に反例（`Symbol` 引数 → `DataCloneError` の非同期 reject） → W-001 の根拠 | 参考 |
| PROBE-2 | PROBE-1 の反例をガード越しに検証し、さらに MUT-1 を当てる | — | 修正後は `SystemError(DATABASE_ERROR)`、MUT-1 下では `DataCloneError` が素通りして赤 → **統合側でも翻訳を観測でき、かつ検出力がある**ことを確認 | 参考 |

ADR-131 が Consequences に書いている変異試験2本（MUT-1 / MUT-2 相当）は**記載どおり再現した**。記載の「unit 2本 + integration 1本」も件数まで一致する。

#### 全ゲートの結果

作業ツリーは全変異の復元後 `git status --porcelain` が空であることを確認済み。以下は最終状態での実行結果。

| ゲート | 回数 | 結果 |
|---|---|---|
| `pnpm typecheck` | 2（変異前 / 復元後） | 緑（`@repo/core` / `@repo/web` / `@repo/infra-cloudflare` すべて Done） |
| `pnpm lint` | 3 | exit 0（`Found 2 infos` は biome.json の設定移行に関する既存の info で、error ではない） |
| `pnpm format:check` | 2 | exit 0（241 files） |
| `pnpm test:unit` | 2（変異前 / 復元後） | 緑 37 files / **532 tests** |
| `pnpm test:integration` | 3 | 緑 20 files / **188 tests**（3回とも同数） |
| `pnpm test:integration:shuffle` | 3 シード: `20260803` / `4711` / `90210` | 3シードとも緑 188/188 |
| `rm -rf apps/web/dist && pnpm build:cf` → `pnpm test:smoke` | 2（変異前 / 復元後） | 両方とも緑 1 file / 2 tests（間に1度赤が出たが N-008 のとおり自分の mtime 起因） |

`pnpm dev`（:3000）は本レビュー中に停止していない。稼働継続を確認済み（PID 7690 / `GET /login` → 200）。PID ファイルは変更なし。

#### マージ可否

**可（Blocker 0）。**

修正は正しい。`isThenable` は本物の `Rpc.Result`（`typeof === "function"`、`[object JsRpcPromise]`）と作り物の thenable の両方を捉え、`Promise.resolve(...).catch(...)` による adopt は — MUT-5 の実測どおり — 代替案が workerd に拒否される以上、唯一の実装可能な形である。副作用（fire-and-forget / unhandled rejection / pipelining の喪失）はいずれも実害が無いことを呼び出し点の全数で確認した。追加テストは MUT-1 / MUT-2 / MUT-3 / MUT-6 の4方向で検出力を実測できた。AC-4 / AC-25 は grep で無傷、CLAUDE.md のエラーハンドリング節はむしろ**この差分で初めて実際に成立した**。

W-001 / W-002 はどちらも `.thread/37/adr.md` の文面の正確さに関する指摘で、コードの変更を要さない。ADR は将来の判断根拠として残るものなので、マージ前に文言を直すか、(W-001 のみ) 統合テストを1本足すことを推奨するが、いずれもマージをブロックしない。
