# レビュー 007 — 最終確認（7周目・収束確認）

- **対象**: `git diff ffdc4c3~1..HEAD`（`ffdc4c3`）
- **PR**: #49 / ベース `main`
- **前提**: 5周目で APPROVED、6周目で Warning 2件（どちらも `.thread/37/adr.md` の記述精度・コード変更不要）を検出して対応済み
- **本ラウンドの性格**: 全面再レビューではなく**収束の確認**。差分の妥当性 / 過去6周の決着 / AC 30項目 / ブラウザ検証との整合 / 全ゲート / 作業ツリーの6点に限定する
- **差分の実質**: `stubGuard.integration.test.ts` に統合テスト1本追加 / `.thread/37/adr.md` の ADR-130・ADR-131 の文言訂正 / `.thread/37/review/triage.md` への追記。**プロダクションコードは無変更**（`serverCloudflare.ts` は `fd6d1f8` 時点から不変であることを確認した）

### 最終確認（7周目）

#### Blockers

**なし。**

#### Warnings

**[W-001]** 1周目 `adapter-infra W-002`（`fix` 判定）の spec 側の訂正が**片側だけに入っており、`spec/database/index.md` が自己矛盾している**
/ 場所: `spec/database/index.md:475`（`jobs.kind` の全数表の `reindex` 行）対 `spec/database/index.md:709`（本 PR で追記された段落）
/ 理由: 訂正は `reindex.ts` の JSDoc（`## Its reach is the tokenizer, not the normalisation rules`）と spec:709 に入ったが、**230行手前にある `kind` 全数表の `reindex` 行が旧記述のまま**で、追記した段落と正面から矛盾する。

| 場所 | 記述 |
|---|---|
| `:475` 投入点 | 「migration ゲート（**トークナイザ・正規化規則の変更を含む** `schema_version` の前進時）」 |
| `:475` 用途 | 「FTS5 の全件再構築（**トークナイザ・正規化規則の変更時**）」 |
| `:709`（本 PR で追記） | 「**ただし `reindex` の射程はトークナイザの変更に限る。** …**正規化規則の変更は `reindex` では反映されない**。反映するには原文から projection をやり直す必要があり、それらのリポジトリを持つ **#2〜#6** の担当である」 |

`:708` →`:709` は「担う → ただし射程は限る」と隣接しているので、その2行を続けて読む限り誤解は生じない。問題は `:475` のほうで、この表は spec 自身が「**本表が `spec/` 側の `kind` の全数である**」と宣言している正典であり、`reindex` の役割を調べる読者が最初に当たる場所である。ここだけを読むと「正規化規則を変えたら `reindex` が全件再構築してくれる」という、まさに W-002 が危険だと指摘した誤解に到達する。CLAUDE.md が `spec/database/index.md` を storage layout の正本と名指ししている以上、正典の表と本文が食い違ったまま残るのは望ましくない。

triage:19 は当初「`spec/database/index.md`:695 と steps.md の引き継ぎ文は担当ファイル範囲外なので未対応」と記録し、triage:46（`spec 同期2`）が spec 側を引き取ったが、**引き取ったのは散文1段落だけで表の行は対象外だった**。5周目の AC 検証も spec:709 の実在までしか見ていない。

/ 提案: `:475` の2セルから「正規化規則」を落とし、用途欄を「FTS5 の全件再構築（トークナイザ変更時。**正規化規則の変更は射程外** — 第7.x節）」等として `:709` へ参照を張る。**1行の編集で済み、コード・テスト・型に一切影響しない。**

**[W-002]** 4周目 `overall W-001`（`fix` 判定）の残りで、**PR 本文が ADR 本数について自己矛盾しており、どちらの数字も実測と合わない**
/ 場所: PR #49 本文 33行目 / 141行目
/ 理由: 実測して3つの値が食い違う。

| 場所 | 記述 | 実測 |
|---|---|---|
| 本文 33行目 | 「`.thread/37/adr.md`（設計判断**41本**）」 | — |
| 本文 141行目 | 「設計判断は `.thread/37/adr.md` に**82本**記録した」 | — |
| `grep -oE "^## ADR-[0-9]+" .thread/37/adr.md \| sort -u \| wc -l` | — | **84本**（重複なし、採番は ADR-131 まで非連続） |

4周目の対応で141行目を「82本」へ更新したが**33行目は「41本」のまま**放置され、さらに6周目に ADR-130 / ADR-131 が増えたため141行目も陳腐化した。同一本文内に 41 と 82 が併存している状態である。

AC-26 が求める `--dry-run` の実測結果と Browser Verification 節は本文に入っており、**AC 上の要求は満たされている**（後述の AC 検証を参照）。これは本文の内部整合の問題に留まる。

/ 提案: 33行目を「設計判断84本」に、141行目を「84本」に揃える。**リポジトリの成果物ではなく PR 説明文の編集のみ。**

#### Notes

**[N-001]** 追加された統合テストは検出力を持つ。変異試験で実測した（下記の節）。とくに**新ケース単独で MUT-1 を検出する**ことを確認した — `isSystemError(error)` が false になり、生の `DataCloneError` が翻訳されずに素通りする形で赤くなる。6周目 W-001 の提案 (b)（統合側で本物の非同期失敗に対して翻訳が発火することを直接見る）が、意図どおり成立している。

**[N-002]** ADR-130 / ADR-131 の訂正後の記述は**実態と一致している**。6周目レビューの指摘内容とも一致する。自分で本物の stub に対して両方の主張を実測した（下記の節）。訂正の対応関係は次のとおり。

| 6周目の指摘 | 訂正後の記述 | 判定 |
|---|---|---|
| W-001: 「統合環境で非同期失敗を起こせない」は誤り。`Symbol` 引数で起こせる | ADR-131 Context を「起こせる経路は限られる」+「**ただし `Symbol` 引数だけは通らない**: …`DataCloneError` で非同期に reject する」へ / Decision 2 を2ケース構成へ / Consequences のトレードオフを「翻訳そのものは見ていない」から「**作為的入力に依存する**」へ | **一致**。レビューは (a) か (b) のどちらかを求めていたが、実装は **(b) を採ったうえで (a) の文言訂正も入れており**、提案より厚い |
| W-002: 「union の同期側が消える」は根拠として事実と違う | ADR-130 Decision 2 を「**ガードは stub の戻り値を作り変えない**という不変」へ差し替え、「**この union 自体に production の要求は無い**」と MUT-4 の実測を明記 | **一致**。レビューが提案した文言（不変の観測点 / union に production の要求なし）を両方とも反映している |

Consequences の変異試験の件数も「integration 1本 → 2本」「同じ3本 → 4本」へ更新されており、**自分の実測（unit 2 + integration 2）と一致する**。

**[N-003]** 6周目の N-001（ADR-130 Decision 3 に MUT-5 の実測を1行足すと、将来 `result.then(undefined, translateStubError)` へ戻すのを止められる）は**未反映**である。Decision 3 の文言は変わっていない。**ただしこれは Note であって `fix` 判定を受けていない**（triage にも W-001 / W-002 の2行しか追記されていない）ので、対応漏れではなく判断どおりである。指摘として立てない。

**[N-004]** 1周目 `adapter-infra W-002` が求めた**もう一方の引き継ぎ先（`.thread/37/steps.md` ステップ30 外部アクション (e)）は最後まで入らなかった**。実測で、steps.md:1117 の (e) は projection 呼び出しの引き継ぎのみで、`reindex` の正規化規則の射程には触れていない。#2〜#6 へ実投稿されたコメント（AC-30 (e)）も projection の件だけである。

ただし**実害は小さい**と判断した。(i) steps.md は実行済みの実装手順を凍結した作業ログであり、いま追記すると当時の記録が事実でなくなる。(ii) 引き継ぎの実質は `spec/database/index.md:709` が「**#2〜#6 の担当である**」と名指しで持っており、#2〜#6 の実装者が読む正本はそちらである。(iii) `reindex.ts` の JSDoc にも同じ内容がある。W-001 を直せば正典側の記述が完全になるので、この経路は閉じる。

**[N-005]** ブラウザ検証の記録に、**本 PR の範囲外として宙ぶらりんのまま Issue 化されていない事項が1件**ある（`manual-test/results/TC-E05.md:43-58`）。正しく署名された存在しない `userId` で空の User Data DO が16テーブルごと新規作成され、退会後に有効な cookie でアプリを開くと `finalize-withdrawal` が消したはずの DO が復活しうる、という観察である。記録自身が「`.thread/37` の範囲外の判断なので事実の記録に留める」と結んでおり、`gh issue list` で確認した限り対応する Issue は無い（#45「cross-DO saga の異常系」が近いテーマだが本文には含まれていない）。

**本 PR の受け入れ基準にも変更差分にも関わらない**（退会・saga の5種はハンドラも投入点も未実装で、#12 / #45 の担当であることが spec に明記されている）ので指摘としては立てないが、**マージ後に #45 へコメントするか別 Issue を切っておくと落ちない。**

**[N-006]** `pnpm dev`（:3000、PID 7690）は本レビュー中に停止していない。稼働継続を確認済み（`GET /login` → 200）。PID ファイルは変更していない。

#### 自分で行った変異試験

復元はすべて `git checkout` ではなく**スナップショット（`scratchpad/snap/serverCloudflare.ts.orig`）からの `cp`**。復元後に `shasum` で原本一致を確認した（`3a64fdaa3330fc80c9f1eb931166b47eb594a7ef`、変異前と一致）。

##### 変異

| # | 変異 | 期待 | 実測 | 判定 |
|---|------|------|------|------|
| MUT-1 | `serverCloudflare.ts:145-147` の `isThenable(result) ? Promise.resolve(result).catch(translateStubError) : result` を `result instanceof Promise ? result.catch(translateStubError) : result` へ戻す（6周目に直した不具合の再導入） | 赤 | **integration 2本 + unit 2本が赤。**<br>integration: `interposes on the handle workerd returns, which is not a Promise`（`expected false to be true`）/ **`translates a real asynchronous failure of the call itself`**（`expected false to be true` @ `:72` = `isSystemError(error)` が false）<br>フルスイート: integration `2 failed \| 187 passed (189)` / unit `2 failed \| 530 passed (532)`。unit の内訳は ADR 記載どおり `translates a failure that arrives as a rejected RPC result` / `carries the overloaded marker through the asynchronous path` | **検出** |

**本ラウンドで追加された1本は、単独で MUT-1 を検出する。** 赤の出方が `isSystemError(error) === false`、すなわち**生の `DataCloneError` が翻訳されずに素通りしている**という不具合そのものの形であり、間接的な指標ではない。ADR-131 Consequences が更新後に主張する「integration 2本が赤」とも件数まで一致した。

##### 実測プローブ（ADR-131 の訂正後の記述の裏取り）

一時テスト（`di/__tests__/zzProbe.integration.test.ts`、**確認後に削除済み**。削除後 `git status --porcelain` が空であることを確認）で、本物の DO stub に対して ADR の2つの主張を直接測った。

| 主張（ADR-131 訂正後） | 実測 | 判定 |
|---|---|---|
| 「`Symbol` 引数は structured clone できないので、返ってきたハンドルが `DataCloneError` で**非同期に reject** する」 | `getCurrentUser(Symbol("nope"), 1)` の戻り値は `[object JsRpcPromise]` / `instanceof Promise === false` で**同期 throw はせず**、`await` で `DataCloneError: Symbol(nope) could not be cloned.` が reject | **主張どおり** |
| 「非 cloneable 引数のうち**関数**は workerd が stub 化して通してしまう」 | `getCurrentUser(() => "x", 1)` は throw せず、**呼び出しが DO へ到達して通常の値エンベロープ**が解決（`{"v":1,"ok":false,"error":{"kind":"forbidden","code":"ACCOUNT_NOT_ACTIVE",…}}`）。stub 呼び出し自体の失敗ではない | **主張どおり** |

つまり ADR-131 が新たに書いた「関数引数は通るが `Symbol` 引数だけは通らない」という区別は、**両方向とも実測で裏が取れている**。テスト内のコメント（`stubGuard.integration.test.ts:54-63`）が「契約外の作為的な入力である」旨を明記している点も、6周目レビューが (b) の条件として求めたとおりである。

#### 過去6周の指摘の決着状況

`.thread/37/review/` の全レビューファイルと `triage.md`（データ行94行）を突き合わせた。

| 項目 | 結果 |
|---|---|
| Blocker / Warning の総数 | **91件**（Blocker 14 / Warning 77）。ラウンド別: 1周目 12/47、2周目 2/24、3周目 0/3、4周目 0/1、5周目 0/0、6周目 0/2 |
| triage.md への台帳漏れ | **なし。** 91件すべてが対応行を持つ（複数レビュアーが独立収束した6件は1行に合流しているが、ID は行内に全数明記） |
| `defer` 判定 | **0件** |
| `wont-fix` 判定 | 1件のみ。理由が明記されており、結果的に `spec 同期1` で解消 |
| 「別担当へ引き継ぎ」系の記述 | 10件を追跡し、**9件は後続ラウンド・後続行で決着**（`presentation-config W-003` → `spec 同期3` / `security B-001` → `spec 同期1` / `security W-003` → adapter 側 / `test W-005` → test 2周目 W-001 ほか）。**残る1件が W-001 / N-004 の `adapter-infra W-002`** |
| 6周目の2件 | **決着**（N-002 のとおり、W-001 は提案 (b) + (a) の両方、W-002 は文言差し替えで対応） |

**未決着: 1件（W-001。`fix` 判定の spec 訂正が表の行に届いていない）。** ほかに `fix` 判定の残滓が1件（W-002。PR 本文の ADR 本数）。**残る89件はすべて決着している。**

なお5周目のサマリ（`review-005.md`）は「全件決着（未対応ゼロ）」と書いているが、`review-005-final.md:35,71,141` は `overall W-001`（PR 本文）を既知残件として名指ししており、サマリ側の記述のほうが不正確である。台帳の行数の数え方（88行 vs 実データ92行）にも当時から齟齬があるが、いずれも記録の精度の問題で、決着そのものには影響しない。

#### AC 30項目の検証結果

`.thread/37/plan.md` の受け入れ基準表を1行ずつ確認した。**検証コマンドが明記されているものは記載どおり実行した。**

**集計: OK 30 / NG 0。**

主要な機械検証の実行結果:

| AC | コマンド / 検証 | 結果 |
|---|---|---|
| AC-4 | `grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app \| grep -v '/__tests__/'` | `serverCloudflare.ts:178` / `:188` の**2行のみ**（同一ファイル）→ OK |
| AC-5 | `grep -n "storage\.sql\|ctx\.storage\|\bsql\b" .../userData/facade.ts .../identityDirectory/facade.ts` | **0件** → OK。`UnitOfWorkProvider.run` の同期契約は `unitOfWork.typetest.ts` の `@ts-expect-error` 2本、OCC は `sql/occ.ts:22-35` の `RETURNING 1` |
| AC-8 / AC-14 | `outbox` / `processed_events` / `OUTBOX_` / relay / consumer / `EventDispatcher` の全数 grep | **0件**。`application/workers` / `application/events` / `di/env.ts` / `domain/common/event.ts` 等いずれも不在 → OK |
| AC-17 | `adapters/d1/` 不在 / `drizzle.config.ts` 不在 / `drizzle` が `package.json`・`pnpm-lock.yaml` に 0件 / `vitest.config.integration.ts` の禁止4キー 0件 / Pulumi `resources/index.ts` 0件 | OK。`worker-configuration.d.ts` の `D1Database` / `Queue` ヒットは **wrangler が常時生成するランタイム型面**で、`__BaseEnv_Env` のバインディングは DO 2本のみ（5周目 N-003 で判定済み） |
| AC-18 | ルート / `@repo/web` 両側の `db:*` と `deploy:*` の本数 | `db:*` 0本、新 `deploy:*` は片側12本。README:142-149 の対応表の右辺12本がすべて実在 → OK |
| AC-20 | plan.md 記載の `tanstack-start-template` grep（除外2つ込み）をそのまま実行 | **0件（EXIT 1）** → OK |
| AC-23 | steps.md ステップ32 の grep | 実行文4件はすべて関数本体内（`mailSender.ts:38` / `resetTokenStore.ts:16` / `resetTokenCrypto.ts:60` / `canonicalCipher.ts:121`）、残りはコメントとテスト → OK |
| AC-25 | plan.md 記載の2本をそのまま実行 | (i) presentation import **0件** / (ii) `application → adapters` 逆流 **0件** → OK |
| AC-26 | PR 本文の `--dry-run` 実測 | OK。state 側は `-c wrangler.state.toml`（`main = dist/state/index.js`）での実測。**stage 版が使えないのは `Pulumi.{staging,production}.yaml` が未 `up` で `cf:render:staging` が `ENOENT` になるため**で、設計どおりの状態（5周目 N-002 / N-004 で判定済み）。redirect に引きずられない性質は 114.16 KiB vs 1682 KiB の差で直接観測されている |
| AC-29 | 全ゲート | 下記の節のとおり**全て緑**（`pnpm install --frozen-lockfile` を含む） |
| AC-30 | `gh issue view {26,10,37,38}` + #2〜#6 | **5件とも実施済み**を実コメントで確認（2026-08-02T22:30〜22:32）。(a) #26 クローズ提案 / (b) #10 委譲 / (c) #37 本文の誤り2点 / (d) #38 へ同訂正 + docs 帰属 / (e) #2〜#6 へ projection 引き継ぎ |

テストによる担保を要求する AC（AC-1 / AC-2 / AC-7 / AC-9〜AC-13 / AC-16 / AC-21 / AC-22 / AC-27）は、該当テストファイルとケース名・assert 内容まで開いて確認し、すべて実在を確認した。

**W-001（spec:475 の矛盾）は AC のどの行の要求にも抵触しない** — AC 表に `reindex` の射程に関する項目は無く、AC-9（FTS5 / tokenizer）も tokenizer の実測記録のみを要求している。**W-002（PR 本文の ADR 本数）も AC-26 の要求（`--dry-run` の実測結果が本文にあること）は満たしている。** したがって AC は 30項目とも OK である。

#### ブラウザ検証との整合

`.thread/37/manual-test/results/` の**全17ファイル**（TC-C01〜C10 / TC-E01〜E07。`testing.md` の確認項目10 + エッジケース7 と1:1、欠落なし）を確認した。

**FAIL: 0件 / SKIP: 0件。**

- 全17ケースが PASS。記録上の FAIL は **TC-E03 手順6 の1件のみ**で、これが6周目の起点となった変更起因 FAIL である。
- **TC-E03 の再検証は実際に行われている。** `TC-E03.md:88` 以降に「修正後の再検証」節があり、修正前後の A/B 実測が同一手順・同一環境で取られている — 修正前 `kind:unknown / code:null / message:'Worker "fog-state" not found…'` → 修正後 `kind:system / code:DATABASE_ERROR / message:'Durable Object call failed'`、クライアント側 `SerializedError` に `retryable:false` が付く。HTTP は前後とも500、内部文言の漏洩は前後とも grep で無しを確認。初回 FAIL の記録は意図的に残されており、冒頭に `PASS（初回 FAIL → 修正後に再検証して PASS）` と両論併記されている。**「FAIL の記録だけ残って再検証が無い」状態ではない。**
- 手順の一部を代替実施したものが3件あるが、いずれも**ツール制約または設計上の不可能性**に起因し、検出目的は別手段で達成されている（TC-C05 手順1: agent-browser にスロットリング機能が無く MutationObserver で DOM 遷移を実測 / TC-C06 手順1〜3: dev サーバー共有のため停止せず、別プロセスが作った DO を現行プロセスが読めるかで代替 / TC-E05 手順4: `CurrentUserPanel` が PII を出さないため A/B が文字列として完全一致し、肯定的な観測点が実装上存在しない）。**「時間が無い」「難しい」類の理由による SKIP は1件も無い。**
- 本ラウンドの差分（統合テスト1本 + ADR 文言）は**ブラウザ経路に一切触れない**ので、Phase 4 の結果を無効化しない。TC-E03 が検証した修正そのものは `fd6d1f8` で入っており、本ラウンドはその修正に対するテストを足しただけである。

宙ぶらりんの記述として N-005（TC-E05 の空 DO 生成）を挙げたが、本 PR の範囲外であり指摘として立てない。

#### 全ゲートの実行結果

作業ツリーは変異試験の復元後・一時テスト削除後ともに `git status --porcelain` が**空**であることを確認した。以下は最終状態での実行結果。

| ゲート | 回数 | 結果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 1 | **exit 0**（`Already up to date`、4 workspace projects） |
| `pnpm typecheck` | 1 | **緑**（`@repo/core` / `@repo/web` / `@repo/infra-cloudflare` すべて Done） |
| `pnpm lint` | 1 | **exit 0**（222 files。`Found 2 infos` は biome.json の設定移行に関する既存の info であり error ではない） |
| `pnpm format:check` | 1 | **exit 0**（241 files） |
| `pnpm test:unit` | 1 | **緑 37 files / 532 tests** |
| `pnpm test:integration` | **3** | **3回とも緑 20 files / 189 tests**（6周目の 188 から +1。本ラウンドの追加分と一致） |
| `pnpm test:integration:shuffle` | **3シード**: `20260803` / `4711` / `90210` | **3シードとも緑 20 files / 189 tests** |
| `rm -rf apps/web/dist && pnpm build:cf` | 1 | **成功**。2成果物を出力（`dist/server/index.js` 570.17 kB / `dist/state/index.js` 175.62 kB） |
| `pnpm test:smoke`（クリーンビルド後） | 1 | **緑 1 file / 2 tests** |
| `git status --porcelain` | 最終 | **空**（作業ツリー clean） |

変異試験中に一時的に赤くしたのは MUT-1 の1回のみで、スナップショットからの `cp` で復元し `shasum` 一致を確認済み。6周目で報告された `test:smoke` の mtime 起因の偽陽性は、本ラウンドではクリーンビルド → smoke の順に回したため発生していない。

#### マージ可否

**可（Blocker 0）。**

本ラウンドの差分は健全である。追加された統合テスト1本は**変異試験で単独の検出力を実測できた** — MUT-1 を当てると `isSystemError(error)` が false になり、生の `DataCloneError` が素通りする形で赤くなる。これは6周目 W-001 が提案 (b) に求めた「フェイクの形が正しいことを前提にせず、本物の非同期失敗に対して翻訳が発火することを直接見る」がそのまま成立していることを意味する。ADR-130 / ADR-131 の訂正も、6周目の指摘内容と一致しているだけでなく、**訂正後の記述が実態と合っていることを本物の stub に対する実測プローブ2本で裏取りした**（`Symbol` 引数 → `DataCloneError` の非同期 reject / 関数引数 → stub 化されて DO へ到達）。プロダクションコードは無変更で、退行の余地が無い。

全ゲートは緑である。integration は3回 + 3シードのシャッフルすべてで 189/189、クリーンビルド後の smoke も緑、`--frozen-lockfile` も通り、作業ツリーは clean。AC は30項目すべて OK で、機械検証コマンドが書かれているものは実際に走らせて確認した。ブラウザ検証は17ケース全 PASS・未解決 FAIL 0件で、6周目の起点だった TC-E03 は A/B 実測つきで再検証されている。

Warning 2件は**どちらもドキュメントの記述精度に関するもので、コード・テスト・型・設定のいずれにも影響しない**。W-001 は `spec/database/index.md` の表1行の編集、W-002 は PR 説明文の数字2箇所の編集で、いずれも1分で片付く。**マージをブロックしない**が、W-001 は「`fix` 判定を受けた指摘の訂正が正典の表に届いていない」という性質のもので、放置すると `reindex` の射程について spec が読者に誤った答えを返し続けるため、**マージ前に直しておくことを推奨する**。
