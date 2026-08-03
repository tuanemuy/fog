# PR Review #005 — 最終確認（収束判定）

PR #49 / base `main` / 契約 `.thread/37/plan.md`（受け入れ基準30項目）

4周目は Blocker 0・Warning 1（PR 本文の陳腐化のみ、コード変更不要）で2観点とも「マージ可」。その後の差分は `d71055a..HEAD` の4ファイル（`CLAUDE.md` 1行 + `.thread/37/review/` の記録3件）のみ。本ラウンドは**収束の確認**に絞り、差分の妥当性・過去4周の決着・AC 30項目・全ゲート・作業ツリーを確認した。

---

### 最終確認

#### Blockers

**なし。**

#### Warnings

**なし。**

#### Notes

**[N-001]** `d71055a..HEAD` の `CLAUDE.md` 追記は実態と一致している

`CLAUDE.md`:32 に足された `pnpm test:integration:shuffle` と「CI runs the shuffled variant with the run id as its seed, so a red is reproducible」は、次の3点と逐語で一致する。

- ルート `package.json`:`"test:integration:shuffle": "vitest run --config vitest.config.integration.ts --sequence.shuffle"` が実在する
- `.github/workflows/ci.yml`:69-70 が `pnpm test:integration:shuffle --sequence.seed=${{ github.run_id }}` を走らせる（plain な `test:integration` は CI に無い）
- `docs/test.md`:69 と同ファイルの Commands 表が同じ運用を説明している

実際に4シードで走らせて再現性も確認した（下記ゲート欄）。残る差分2件は `.thread/37/review/` への記録追記で、コードにもドキュメントにも影響しない。

**[N-002]** AC-26 は**実測が済んでおり本ラウンドで再現も確認した**。残るのは PR 本文への転記のみ

`.wrangler/deploy/config.json` が request 側（`../../dist/server/wrangler.json`）を指したまま、`cd apps/web && npx wrangler deploy -c wrangler.state.toml --dry-run` が **state Worker を Total Upload 114.16 KiB / バインディングは `USER_DATA`・`IDENTITY_DIRECTORY` の2本**でバンドルすることを本ラウンドで再実測した。redirect に引きずられていれば request 側の約1682 KiB になるので、AC-26 が求めた性質そのものが直接観測できている。request 側の実測（77 modules / 1682.23 KiB、redirect 経路と一致、警告ゼロ）は `.thread/37/adr.md` ADR-062 に記録済み。

**PR 本文は現時点でまだ更新されていない**（`pnpm test:unit` 461/31、`pnpm test:integration` 133+1 todo/15、ADR 41本、Browser Verification「Phase 4 で実施予定」のまま）。これは triage の `overall W-001（4周目）` として **fix 判定・メイン対応予定**の既知の残件であり、本ラウンドの新規指摘ではない。指示に従い「実測が済んでいるか」のみを判定対象とし、**済んでいる**と結論する。転記時の正しい実測値は下記ゲート欄のとおり。

**[N-003]** AC-17 の `worker-configuration.d.ts` は語の一致だけ見ると38件ヒットするが、AC の趣旨は満たしている

`grep "D1Database\|Queue" apps/web/worker-configuration.d.ts` は38件返るが、**すべて wrangler が生成するランタイム型面**（`interface Queue<Body>`、`QueueSendOptions`、`D1DatabaseSession` など、プロジェクトの設定と無関係にランタイム API を宣言する巨大ブロック）である。プロジェクト固有の `Env` は同ファイル:12-13 の `USER_DATA` / `IDENTITY_DIRECTORY`（どちらも `DurableObjectNamespace`）2本のみで、**D1 / Queue のバインディングは1本も無い**。AC-17 が守りたい「D1 と Queue のバインディングが残っていない」は満たされている。

**[N-004]** Pulumi CLI が本環境に無いため、rendered `.tpl` 経由の `--dry-run` は実行できなかった

`pnpm cf:render:staging` は `spawnSync pulumi ENOENT` で失敗する（`apps/web/scripts/render-wrangler.ts:50` がスタック出力を引く）。`plan.md` リスク欄のとおり `Pulumi.{staging,production}.yaml` は `REPLACE_WITH_CF_ACCOUNT_ID` のままでどのスタックも `up` されていないので、これは**設計どおりの状態**であって欠陥ではない。AC-26 の実質はローカル `wrangler.state.toml`（同じく `main = "dist/state/index.js"`）で確認済み（N-002）。`.tpl` 4本の静的検査（`main` が成果物を指す / `exports` の `type`・`storage` / `[[durable_objects.bindings]]` / `[env.*]` 不使用 / d1・queues ゼロ）は実施し、いずれも AC-19 の要求どおりだった。

**[N-005]** 前ラウンドの Note のうち fix 判定されなかったものは、いずれもマージ条件ではない

`overall N-004`（`credentialMappingRules.ts` の断定文に但し書きを1語足す提案）/ `overall N-005`（ADR-120 の JSDoc 表現を「有界」寄りにする提案）/ `adapter-security N-006`（`sweep-reset-tokens` の境界一致 warn ログ、3周目に #38 へ回付済み）。いずれも挙動・設計・AC の充足を損なわない文言/観測性の話で、triage でも fix 判定されていない。

**[N-006]** `pnpm lint` は exit 0 だが biome 設定の deprecation info が2件出る

`biome.json`:25 の `recommended` が将来 `preset` へ置き換わる旨と、biome のバージョン期待値（2.5.5）と実体（2.4.15）の差。`Found 2 infos.` でエラーではなく、`main` 時点から続く既存状態で本 PR とは無関係。

#### 過去4周の指摘の決着状況

**全件決着。fix と判定されて未対応のまま残っている指摘は無い。**

`.thread/37/review/triage.md` の全88行を判定別に数えると `fix` 86 / `wont-fix (担当範囲外)` 1 / `fix（記録のみ）` 1。担当ファイル範囲の制約で一旦保留された3件は、いずれも後続の「spec 同期」行が引き取って実ファイルに着地していることを確認した。

| 保留された指摘 | 引き取り先 | 着地の実測 |
|---|---|---|
| presentation-config W-003（`spec/` 側の暫定注記が範囲外） | spec 同期3 | `spec/database/index.md`:95 に「この再計算の置き場は暫定である」以下の段落が実在 |
| adapter-infra W-002（`spec/database/index.md`:695 が範囲外） | spec 同期2 | `spec/database/index.md`:709 に「`reindex` の射程はトークナイザの変更に限る」以下が実在 |
| security B-001 の spec 訂正（`wont-fix (担当範囲外)`） | spec 同期1 | `spec/database/index.md#password_reset_tokens` の導出鎖3段と `spec/inventory/adapter.md` / `spec/domains/identity.md` が ADR-042 へ追随済み |

4周目に fix 判定された3件の着地:

| ID | 内容 | 状態 |
|---|---|---|
| adapter-security N-005 | `triage.md` に3周目の3件が未追記 | **決着**。`（3周目）` 行が3本（adapter-infra W-001 / W-002 / test W-001）実在 |
| overall N-006 | `CLAUDE.md` の Commands に `test:integration:shuffle` が無い | **決着**。`CLAUDE.md`:32 に追記済み（N-001 で実態と照合） |
| overall W-001 | PR 本文が最終状態と食い違い、AC-26 の記録要求が未達 | **メイン対応予定の既知残件**。コード変更不要（N-002） |

3周目の3件（`armAfterRpc` の後ろ倒し / `reserve` の `last_reset_requested_at` 刻印 / AC-12 (iii) の Identity Directory 側）は4周目が変異試験つきで解消を確認済みで、本ラウンドでも退行は見つからなかった（統合187件が全シードで緑）。

その他、triage 上で「範囲外」と明記されて意図的に残されているものは `.thread/1/` / `.thread/37/review/` 配下の過去レビューログ中の生 NUL のみ。**ソースツリー側は clean** で、`grep -rlP "\x00" packages/core/src apps/web/app spec docs` は0件だった。

#### AC 30項目の検証結果

| # | 判定 | 根拠 |
|---|---|---|
| AC-1 | OK | `gate.integration.test.ts`:17-33 が16テーブルを列挙し :98 で一致検証。数え方は `doHarness.ts`:79-86（`sqlite_%` と `search_fts_%` を除外）、:106 で shadow 4件の実在も assert（除外が空振りしていない）。索引は `sqlite_%` 除外で24本を :118 で検証。DDL 側は独立実測でも15（`schema/userData.ts` 14 + `jobsDdl.ts` 1）、`_meta` は `schema/gate.ts`:75 のブートストラップ |
| AC-2 | OK | `gate.integration.test.ts`:63-68（5テーブル）/ :70-80（10索引）/ :218。DDL 側は独立実測でも4（`schema/identityDirectory.ts` 3 + `jobsDdl.ts` 1）。`ssoCanonical` は `valueObject.ts`:313-325。SSO 解決は `ssoResolution.integration.test.ts`:150/171/196/231、正規化メール解決は `identity.integration.test.ts`:210/304/461。saga 部分失敗・再試行の冪等性は同 :743 describe（:779/:818/:860） |
| AC-3 | OK | `routingNonExposure.test.ts` がフェイク `Logger` で `directoryLocator.forCanonical` → stub factory ラッパ → `translateStubError` を一巡し、`FORBIDDEN_VALUES` に加え**当該実行で導出された値**（canonical / hmac / doName）でも assert。陽性コントロールと locator 形状ガードつき。同配列を `runner.integration.test.ts`:328（`terminal_reason`）と `mailSender.test.ts`:81 が共有 |
| AC-4 | OK | 機械検証を実行。`grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app \| grep -v '/__tests__/'` が **2件**、どちらも `application/di/serverCloudflare.ts`:149/:159 |
| AC-5 | OK | 機械検証を実行。`grep -n "storage\.sql\|ctx\.storage\|\bsql\b"` が両 facade で **0件**。UoW の同期化は `pnpm typecheck` 緑が担保 |
| AC-6 | OK | `#26` に 2026-08-02 付「本 Issue の2件はどちらも対象消滅」コメントが実在。DO 側 OCC は `occ.integration.test.ts` の5ケース（版が古い / 行が無い / 他文の成功を自分の判定に流用しない / 先行書き込みのロールバックと敗者の特定 / 成功経路に guard 状態を残さない） |
| AC-7 | OK | `search/projection.ts`:5-26 の JSDoc が「唯一の書き込み点」を宣言し #2〜#6 への義務を明記。引き算は :57 の `VALUES('delete', …)` 特殊コマンド構文。`projection.integration.test.ts` が memo / document 対称に「コミットで両方 / throw でどちらも動かない」を :35/:60/:88/:129/:174 と :220/:242/:263/:287/:305 で固定 |
| AC-8 | OK | 機械検証を実行。`grep -rn "outbox\|processed_events" packages/core/src apps/web/app` が **0件** |
| AC-9 | OK | 常設スイート `tokenizer.integration.test.ts`（3文字ヒット :98 / bm25 3.0,1.0 :108 / 2文字は `MATCH` 0件 :118 / `instr()` フォールバック :126,:131 / ページング :136,:149）。記録は3箇所すべて — `.thread/37/adr.md`:1039-1044、`spec/database/index.md`:697-718、`.adr/003`「影響」:38（2026-08-03 に再確認済みと明記） |
| AC-10 | OK | `handlers/purgeTrash.ts`:129-142 が再計算未了なら `{kind:"yield"}` を返し、:145 の削除フェーズは再計算が空の起床でだけ到達。自己消尽述語は `userData/trashQuery.ts`:109。保持日数変更は `userData/facade.ts`:138-155 で同一トランザクション。`purge_after` の NULL 往復は DDL の CHECK（`schema/userData.ts`:96-97/:141-144/:172-174）で構造的に担保。テストは `purgeTrash.integration.test.ts`:260/:295/:314/:339/:356/:370 |
| AC-11 | OK | `jobs/handlers/` 配下で外部 I/O に触れるのは `sendMail.ts`:224 のみ。E2E は `alarmEntry.integration.test.ts`:125（RPC enqueue → `alarm()` → `done`）。4ケース一致は `sendMail.integration.test.ts`:346 が kind / status / `next_run_at` / sweep の `next_run_at` を突き合わせ、差は応答後の送信回数のみ |
| AC-12 | OK | (i) `userData.ts`:157-158 / `identityDirectory.ts`:282-283（`alarm.integration.test.ts`:40,:49）(ii) `jobs/alarm.ts`:74-75、fail-closed 例外は :191 と `alarmEntry.integration.test.ts`:203 (iii) `platform/rpcEntry.ts`:44-56 が `body()` 直後に `await` を挟まず発行、ok/err 両経路（:130,:258,:283,:318）(iv) `table.integration.test.ts`:54 と `alarm.integration.test.ts`:154 (v) `table.integration.test.ts`:37 と `alarmEntry.integration.test.ts`:146 |
| AC-13 | OK | at-least-once/重複 `alarmEntry`:161・`sendMail`:532、lease reclaim `runner`:310・`table`:217（終端行の reclaim 拒否 :244）、backoff→poison+`terminalReason` `runner`:153/:227、`alarm()` 非 throw `runner`:120・`alarmEntry`:172（fail-closed）/:233（ストレージ自体の失敗） |
| AC-14 | OK | 機械検証を実行。列挙された14パス（4 worker + `handlers.ts` + `workers/` + `events/` + ports 3本 + event 2本 + `di/env.ts` + `serviceBindingRelayTrigger.ts`）が**全て不在**。`OUTBOX_` の設定・変数も **0件** |
| AC-15 | OK | `MailSender` はドメインポート `domain/identity/ports/mailSender.ts`:15、実装は `adapters/cloudflare/mailSender.ts`:23/:69。合成ルートは import のみ（`di/stateCloudflare.ts`:95-96）。`grep -rn "EventDispatcher"` が全リポジトリで 0件 |
| AC-16 | OK | (i) `platform/rpcEntry.ts`:45 経由で全 RPC エントリ（`userData.ts`:184-201 / `identityDirectory.ts`:314-331）と両 `alarm()` 先頭（:159 / :284）。例外は `readSchemaVersion` と `listBucketUserIds` の2本のみで、`rpcEntries.integration.test.ts`:176/:215 がメソッド集合を網羅 assert するのでゲート漏れは赤になる (ii) `schema/gate.ts` にコメント外の `await` ゼロ (iii) 適用と `schema_version` 更新が :46-62 の同一 `transactionSync` (iv) :45 の `if (step.version <= current) continue;` で forward-only (v) `handlers/migrateBulk.ts`:89-99 (vi) :32-42 で `SystemError`、`deleteAlarm()` は `settleAlarm` にしか無く fail-closed は到達しない |
| AC-17 | OK | `adapters/d1/` 不在 / `apps/web/drizzle.config.ts` 不在 / `drizzle-orm`・`drizzle-kit` がどの `package.json` にも無く `pnpm-lock.yaml` にも 0件 / `vitest.config.integration.ts` に禁止4キー 0件 / Pulumi `resources/index.ts` に `D1Database`・`Queue` 0件。`worker-configuration.d.ts` は語で38件ヒットするが全てランタイム型面で、`Env` のバインディングは DO 2本のみ（N-003） |
| AC-18 | OK | `db:*` はルート0本・`@repo/web` 0本。`deploy:*` は両側12本ずつ（合計24）で内訳も規定どおり — 役割別8本（`deploy:{request,state}:{staging,production}` とその `:dry`）+ 合成4本（`deploy:{staging,production}` とその `:dry`、いずれも state → request の順に連鎖）。対応表右辺の12本が全て実在。`test:smoke` / `dev:state` も実在 |
| AC-19 | OK | ローカル `wrangler.toml`:11 は `main = "app/server.cloudflare.ts"`（ソースエントリ）、`wrangler.state.toml`:9 と `.tpl` 4本は成果物（`dist/{server,state}/index.js`）。`.tpl` の state 側2本に `type = "durable-object"` / `storage = "sqlite"` が各2ブロック。`USER_DATA` / `IDENTITY_DIRECTORY` のバインディングは4本すべてに存在（request 側は `script_name` つき）。`[[d1_databases]]` / `[[queues.*]]` は toml・tpl 合わせて 0件、`[env.*]` も 0件 |
| AC-20 | OK | 規定の除外つき機械検証を実行して **0件** |
| AC-21 | OK | `vitest.config.integration.ts`:43-50 が `durableObjects` をオブジェクト形式で宣言し両バインディングに `useSQLite: true`。`main` は :33 でトップレベル。`include` :68-72 に `apps/web/app/durable-objects/**` を含む3ディレクトリ、`setupFiles` :74 が DO 用 setup（`reset()` + `evictAllDurableObjects()`）。`handlers.integration.test.ts` は削除済みで後継5本が実在 |
| AC-22 | OK | `vitest.config.smoke.ts` が独立スイート。`apps/web/__tests__/boot.smoke.test.ts` が miniflare に `scriptPath` で request / state の両成果物を渡し、`nodejs_compat` つき2 worker 構成で「応答が返る」「`Disallowed operation called within global scope` を投げない」だけを主張。`build:cf` は2段（`apps/web/package.json`:13）。CI は `ci.yml`:92 → :99 で同一ジョブ内実行。**本ラウンドでクリーンビルド後に実測して緑**（下記ゲート欄） |
| AC-23 | OK | `Date.now()` はプロダクションコードに**呼び出しゼロ**（2件のヒットは両方コメント）。module スコープの `crypto.randomUUID` / `Math.random` / タイマー / top-level await も無し。`crypto.getRandomValues` の4箇所は全て関数本体内、`new Date()` は `SystemClock` のアロー本体内。実行時側は AC-22 のスモークが担保 |
| AC-24 | OK | `ownerToken` は `userData.ts`:165 / `identityDirectory.ts`:290 の両ハンドラで `this.container.idGenerator.next()` から採番して引数で渡る。下流（`jobs/runner.ts`:74/:155、`jobs/table.ts` の各バインド）は読むだけ |
| AC-25 | OK | 機械検証2本をそのまま実行して**両方 0件** — (i) `presentation` の import 0件 (ii) `application` → `adapters` の逆流（`/di/` と `/__tests__/` 除外）0件 |
| AC-26 | OK（実測） | 本ラウンドで再現確認 — redirect が request 側を指したまま `-c wrangler.state.toml --dry-run` が state Worker を 114.16 KiB / DO バインディング2本でバンドルした。request 側の実測は ADR-062 に記録済み。**PR 本文への転記のみメイン対応待ち**（N-002。指示により「実測が済んでいるか」のみを判定） |
| AC-27 | OK | (i) `userData/unitOfWork.ts`:121-146 の部分更新で `target_locators` は消えず、唯一の呼び出し（`facade.ts`:325）も `{phase:"done"}` のみ (ii) `handlers/resumeSignup.ts`:70 は予約行に触れず terminal を返す。TTL 経路の `DELETE` は `saga_committed` を除外する別ジョブ (iii) `account.caller_token` は `accountStore.ts`:86-97 の `initialize` でのみ書かれ、消す経路が無い (iv) `schema/identityDirectory.ts`:21-23 の3値 CHECK と `CredentialChangeState` 型、両遷移も実装済み。終端の一様性は `jobs/table.ts`:317-327 が `completeJob`（:257-266）と同形。`terminal_reason` は定数識別子か `errorIdentity()`（`name:code` のみ、メッセージ不出力） |
| AC-28 | OK | `CLAUDE.md` に「Migration in progress」節も `#37` の言及も**0件**。エントリポイント一覧は request / state の2 Worker 構成（:122-123）へ更新済み。Cross-layer catch policy に migration ゲートの項が追加され（5項目）、`explicit boundaries` の列挙（:101）も4つ目として追随。`docs/test.md` は3スイート構成へ全面更新済み。`docs/backend_implementation_example.md` 冒頭に `> [!WARNING]` の #38 引き継ぎブロックあり（`docs/runtime_cloudflare.md` にも同種のブロックが入っている） |
| AC-29 | OK | 7ゲートすべて緑（下記ゲート欄。`pnpm install --frozen-lockfile` は `Already up to date`） |
| AC-30 | OK | `gh issue view` で5件すべて 2026-08-02 付コメントを確認 — (a) #26「本 Issue の2件はどちらも対象消滅」(b) #10「不透明カーソルのスナップショット物理形は #10 へ委譲」(c) #37「本文の誤り2点の訂正（着手前に確定したもの）」(d) #38「本文の誤り1点の訂正と、#37 が #38 へ送った項目」(e) #2 / #3 / #4 / #5 / #6 すべてに「本体行を書くリポジトリは同一 `transactionSync` で projection を呼ぶこと」 |

**集計: OK 30 / NG 0。**（AC-26 は「実測済み」として OK。PR 本文への転記はメイン対応予定の既知残件で、コード・テスト・spec の変更を要さない）

#### 全ゲートの実行結果

すべて本ラウンドで実際に実行した。

| ゲート | 回数・条件 | 結果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 1回 | **OK**（`Already up to date` / 4 workspace projects） |
| `pnpm typecheck` | 1回 | **OK**（`tsgo` + `packages/core` / `apps/web` / `infra/cloudflare/pulumi` の3プロジェクト） |
| `pnpm lint` | 1回 | **OK**（220 files / エラー0。`Found 2 infos` は biome 設定の deprecation、N-006） |
| `pnpm format:check` | 1回 | **OK**（239 files / No fixes applied） |
| `pnpm test:unit` | 1回 | **OK — 36 files / 525 tests passed** |
| `pnpm test:integration` | **3回**（連続） | **3回とも OK — 19 files / 187 tests passed** |
| `pnpm test:integration:shuffle` | **4シード**（`--sequence.seed=` 11111 / 24680 / 99991 / 777777） | **4シードとも OK — 19 files / 187 tests passed** |
| クリーンビルド → `pnpm test:smoke` | 1回（`rm -rf apps/web/dist && pnpm build:cf` の後） | **OK** — build 成功で `dist/server/index.js` 569.16 KiB / `dist/state/index.js` 175.62 KiB の2成果物、smoke **1 file / 2 tests passed** |
| `wrangler deploy -c wrangler.state.toml --dry-run`（AC-26 の追加実測） | 1回 | **OK** — Total Upload 114.16 KiB、バインディングは `USER_DATA` / `IDENTITY_DIRECTORY` の DO 2本。redirect（`.wrangler/deploy/config.json` → request 側）に引きずられていない |
| `git status` | 全ゲート実行後 | **clean**（`git status --porcelain` が空。クリーンビルドも統合テストも追跡対象を汚さない＝成果物は ignore 済み。本ファイル追加前の時点） |

補足: シャッフル耐性の前提である「固定名スイートは3本」も実測で裏づけた — 統合19ファイル中16ファイルが module スコープの `let seq = 0;` から名前を導出し、持たないのは `cleanup` / `gate` / `binding` の3本。`docs/test.md`:52 の記述と一致する。

#### マージ可否

**可。**

- **Blocker 0 / Warning 0。** 4周目からの差分は `CLAUDE.md` 1行と作業ログ3件のみで、追記内容は `package.json` / `ci.yml` / `docs/test.md` の実態と逐語一致していることを実行して確認した。
- **AC 30項目すべて充足。** 機械検証コマンドが書かれている11項目（AC-4 / 5 / 8 / 14 / 17 / 18 / 20 / 23 / 25 / 26 / 29）はすべて実際に走らせ、規定どおりの件数になった。
- **過去4周の指摘は全件決着。** fix 判定で未対応のまま残っているものは無く、担当範囲の都合で保留された3件も後続の spec 同期行が実ファイルへ着地させている。
- **全ゲート緑。** 統合スイートは素の順序3回・シャッフル4シードの計7回すべて 187/187 で、順序依存の兆候は無い。クリーンビルドからのスモークも緑で、`#40` の global scope 制約は再発していない。
- 唯一の残件は **PR 本文の更新**（実測値の反映と `--dry-run` 結果の転記）で、triage の `overall W-001（4周目）` としてメインが対応予定。**コード・テスト・spec の変更を要さない**ので、本文編集をもってマージしてよい。
