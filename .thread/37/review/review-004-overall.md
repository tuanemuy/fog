# PR Review #004 — 全体整合（Domain / Use Case / Test / Presentation / Config・Docs）

**PR:** #49
**ベース:** `main`（`96b6593`）／**HEAD:** `d71055a`
**契約:** `.thread/37/plan.md`（受け入れ基準30項目）
**Round:** 4回目（3回目は Blocker 0 / Warning 3、5観点すべて「マージ可」）
**Date:** 2026-08-03

## 全体整合

### Summary

- Blockers: **0**
- Warnings: **1**
- Notes: **6**
- AC 30項目: **OK 29 / NG 1**（AC-26 が部分未達。実体は検証済みで、記録先が PR 本文でないだけ）
- 3回目指摘の修正: **解消 3 / 不十分・未対応 0**
- **マージ可否: 可**（W-001 は PR 本文の編集だけで閉じる。コード変更は不要）

#### Blockers

**なし。**

3回目の3件はいずれも実装で解消しており、他の層への退行は見つからなかった。`d71055a` が触った16ファイルを全件精読し、変更点ごとに「呼び出し側 / spec / ドキュメント / テスト」の4方向へ波及を追ったうえでの判定である。

#### Warnings

**[W-001]** PR 本文が最終状態と食い違っており、AC-26 が要求する「PR 本文に実測結果がある」が未達である
/ 場所: PR #49 本文「Test plan > 自動テスト」および「Implementation Plan」
/ 理由:
  - AC-26 の文面は「`wrangler deploy -c wrangler.state.<stage>.toml --dry-run` が state Worker のエントリをバンドルすることを、**手順として検証済みで PR 本文に実測結果がある**」である。検証の実体は済んでいる — 3周目の presentation 観点が両経路の `--dry-run` を突き合わせて `Total (76 modules) 1137.25 KiB / Total Upload 1693.08 KiB` の一致を記録しており（`.thread/37/review/review-003-presentation-config.md`:52）、本ラウンドでも `.wrangler/deploy/config.json` が request 側（`../../dist/server/wrangler.json`）を指したまま `-c wrangler.state.toml --dry-run` が **state Worker を 114.16 KiB / DO バインディング2本でバンドルする**ことを再実測した。**しかしそれが PR 本文に載っていない。** AC が記録先を名指ししている以上、レビューログにあることは代替にならない。
  - あわせて PR 本文の実測値が3周分古い。「`pnpm test:unit` 461 passed / 31 files」→ 実測 **525 passed / 36 files**、「`pnpm test:integration` 133 passed + 1 todo / 15 files」→ 実測 **187 passed / 19 files**（`todo` は2周目に解消済みでゼロ）、「`.thread/37/adr.md`（設計判断41本）」→ 実測 **82本**。`plan.md`「テスト方針 > 数の記録」が「削除前後のテストファイル数・ケース数を実測して PR 本文に残す」を明示的な運用として置いているので、これも契約側の要求である。
/ 提案: PR 本文の「自動テスト」ブロックの3行を実測値へ更新し、`--dry-run` の実測（state / request 両方の module 数と Total Upload、redirect 経路との一致、警告ゼロ）を1段落足す。`.thread/37/adr.md` の本数も 82 に直す。**コード・テスト・spec の変更は不要**なので、マージの前提条件としては本文編集のみである。

#### Notes

**[N-001]** `.thread/37/review/triage.md` に3周目の3件の行が無い
/ 場所: `.thread/37/review/triage.md`（最終行は「test(2回目) W-006」）
/ 理由: 同ファイルは冒頭で「各エージェントが追記する。既存の行は消さず、追記だけすること」と運用を宣言しており、1周目・2周目は全件が行として残っている。3周目の ADP-W-001 / ADP-W-002 / TEST-W-001 は `adr.md` ADR-120〜122 とコミットメッセージに判断が残っているので追跡は可能だが、仕分け表としては3周目だけ穴が開いている。
/ 提案: 3行追記する。マージ後でも成立する。

**[N-002]** ADR の連番は破綻していない（確認結果の記録）
/ 場所: `.thread/37/adr.md`
/ 理由: 見出しは **82本**で、001〜048 / 060〜064 / 070〜075 / 080〜086 / 090〜095 / 100〜103 / 110〜112 / 120〜122。**重複ゼロ**（`sort | uniq -d` が空）。さらに `packages/core/src` / `apps/web/app` / `spec/` / `docs/` / `.adr/` / `.thread/37/` に現れる `ADR-\d{3}` 参照のうち、**#37 の adr.md に定義が無いものはゼロ**である（リポジトリ全体を素で grep すると `.thread/34/adr.md`（〜ADR-158）と `.thread/35/adr.md` の別体系が混ざるので、射程を #37 に切って測った）。欠番はエージェントごとのブロック予約によるもので、宙に浮いた参照も番号の衝突も無い。

**[N-003]** ADR-121 は利用者から見た挙動を変えており、その記録は spec にあるが UI 側の言及は無い
/ 場所: `spec/database/index.md`:586 / `.thread/37/adr.md` ADR-121
/ 理由: 「登録直後の窓（最大15分）はリセット依頼が適格にならない」は仕様変更である。ただし (a) 応答は列挙オラクル対策で一様なので、利用者から見た表示は変わらない、(b) 修正前の挙動は「トークンだけ発行され配送ジョブが立たない」なので、届かないという結果自体は同じで、宙に浮いた有効トークンが残らないぶん改善である、(c) `spec/database/index.md` の列定義に理由まで書かれている。**#11 / #12 がリセット画面を作るときに読む場所は spec なので、引き継ぎとしては成立している。** 追加対応は不要と判断した。

**[N-004]** `credentialMappingRules.ts` の断定文と ADR-121 の例外が、同一 JSDoc の別段落に分かれている
/ 場所: `packages/core/src/domain/identity/credentialMappingRules.ts`:89-91 と :97-101
/ 理由: 前段の「a link therefore reaches the registered address at least once per window regardless of who asked for it」は、写像の生誕窓では成り立たない。直後の段落が例外を明示しているので JSDoc 全体を読めば矛盾しないが、断定文そのものには但し書きが無い。1語（"once activated and past its birth window"）で閉じられる。

**[N-005]** ADR-120 の「インスタンス再作成直後は必ず1回張るので安全側」は、厳密には最大1秒の後ろ倒しを含む
/ 場所: `packages/core/src/adapters/cloudflare/jobs/alarm.ts`:103-106
/ 理由: 新しいインスタンスは `cache.scheduledAt === null` なので guard を通り、due な行に対して `clamp` が返す `now2 + 1000` を書く。永続化済みの alarm が `now1 + 1000`（`now1 < now2`）だった場合、武装は最大1秒後ろへ動く。**ループはしない** — 押し出せるのはインスタンス生成あたり1回で、RPC のレートに比例しないため W-001 が指摘した「永久に走らない」形にはならない。実害は無いが、JSDoc の「always arms once, which is the safe direction」は「1回だけなので有界」の意味に読める形へ寄せたほうが正確である。

**[N-006]** `CLAUDE.md`「Development Commands」に `test:integration:shuffle` が無い
/ 場所: `CLAUDE.md`:32
/ 理由: `docs/test.md`（:69 と Commands 表）と `.github/workflows/ci.yml`:70 には入っており、CI が実際に走らせるのはこちらである。CLAUDE.md は `test` / `test:unit` / `test:integration` / `test:smoke` の4本だけを挙げている。「固定名 DO を足したときは自分で回す」という運用ルールが docs 側にしか無いので、CLAUDE.md にも1語足すと拾いやすい。

#### AC 30項目の検証結果

機械検証コマンドが書かれているものは**すべて実際に走らせた**。「実測」と書いた行が本ラウンドで実行した結果である。

| # | 判定 | 根拠 |
|---|---|---|
| AC-1 | OK | `gate.integration.test.ts` の `USER_DATA_TABLES` が16件で `tableNames(sql)` と `toEqual`。除外の空振り対策も別テストで、`ftsShadowTableNames` が `search_fts_{config,data,docsize,idx}` の4件と一致することを assert。索引は `USER_DATA_INDEXES` 24件（`sqlite_autoindex_%` 除外）。DDL ステップ側は `_meta` 抜きの15件 |
| AC-2 | OK | `DIRECTORY_TABLES` 5件 / `DIRECTORY_INDEXES` 10件。SSO 解決経路は `identityDirectory/__tests__/ssoResolution.integration.test.ts`。saga の部分失敗・再試行は `identity.integration.test.ts`「the signup saga under partial failure」3本 |
| AC-3 | OK | `application/di/__tests__/routingNonExposure.test.ts` 5本。`forbiddenValues.ts` は実導出値（`locator.hmac` / `locator.doName`）を受ける形。生 NUL はソース全体でゼロ（`noRawNul.test.ts` が TS 全体を走査） |
| AC-4 | OK | **実測**: `grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app \| grep -v '/__tests__/'` → `application/di/serverCloudflare.ts:149` / `:159` の2件のみ |
| AC-5 | OK | **実測**: `grep -n "storage\.sql\|ctx\.storage\|\bsql\b"` を両 facade に当てて **0件**。`unitOfWork.typetest.ts` の `@ts-expect-error` 3本が `async` / `Promise` 返しを弾く（`pnpm typecheck` 緑＝抑止対象が実在）。`pendingBatch.ts` / `_occ_guard` / `adapters/d1/` は不在 |
| AC-6 | OK | #26 に 2026-08-02T22:30:29Z のコメント（「本 Issue の2件はどちらも対象消滅」）。`userData/__tests__/occ.integration.test.ts` が「行が無い」と「版が古い」を同一 `OPTIMISTIC_LOCK_FAILURE` に落とすこと・他行の結果を流用しないことを固定 |
| AC-7 | OK | `search/projection.ts`:57 が `INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)`。`projection.integration.test.ts` 11本。JSDoc に「索引への唯一の書き込み点」。呼び出し側の義務は #2〜#6 へコメント済み |
| AC-8 | OK | **実測**: `outbox` / `processed_events` を `packages/core/src` + `apps/web/app` に大小無視で grep → 0件 |
| AC-9 | OK | `search/__tests__/tokenizer.integration.test.ts` が常設。`.adr/003` の「影響」欄に 2026-08-03 の再確認（trigram / 3文字ヒット / `bm25(search_fts, 3.0, 1.0)` / 2文字は MATCH 0件 → `instr()` フォールバック / ページング）が書き戻し済み |
| AC-10 | OK | `purgeTrash.integration.test.ts` 12本。再計算フェーズ未了時に削除へ進まないこと・自己消尽する作業述語・短縮/延長の両方向・復元時の `purge_after` 戻しをそれぞれ固定 |
| AC-11 | OK | `jobs.kind` の外部 I/O は `send-mail` 1種（`lib/jobKind.ts` の `JOB_OWNER` / `JOB_REARM` と `CLAUDE.md` の4分類表が一致）。`sendMail.integration.test.ts` が enqueue → Alarm 実行 → `done` の E2E と4ケースの経路一致を保持 |
| AC-12 | OK | `alarm.integration.test.ts` に (i)〜(v) が名前つきで揃う。(iii) は「the RPC entry wrapper」4本＋本ラウンドで追加された `rpcEntries.integration.test.ts` の Directory 版で両 DO クラスとも担保 |
| AC-13 | OK | `runner.integration.test.ts` 11本（backoff → poison / lease reclaim / 未登録 kind の poison / `alarm()` から throw しない）。`alarmEntry.integration.test.ts` が fail-closed でも throw せず `deleteAlarm` を呼ばないことを数え上げで固定 |
| AC-14 | OK | **実測**: 列挙された14パスすべて不在。`OUTBOX_` は `.ts` / `.toml` / `.tpl` / `.json` で 0件 |
| AC-15 | OK | `domain/identity/ports/mailSender.ts`（ポート）＋ `adapters/cloudflare/mailSender.ts`（実装）。`EventDispatcher` はキュー境界ごと消滅 |
| AC-16 | OK | `gate.integration.test.ts` + `migration.integration.test.ts` が (i)〜(vi) を網羅（1トランザクションでの適用＋版更新 / 部分適用の `migration_progress` 記録と再開 / コードより新しい版の fail-closed / `alarm()` でも throw せず `deleteAlarm` しない）。免除は `read-schema-version` / `list-bucket-user-ids` の2本のみで `rpcEntries.integration.test.ts` が反射で全数を固定 |
| AC-17 | OK | **実測**: `adapters/d1/` / `drizzle.config.ts` 不在、`drizzle` は全 `package.json` と `pnpm-lock.yaml` で 0件、`vitest.config.integration.ts` に `readD1Migrations` / `d1Databases` / `queue*` が 0件、`resources/index.ts` に `D1Database` / `Queue` が 0件。`apps/web/worker-configuration.d.ts` は `.gitignore`:12 で untracked（`wrangler types` の生成物なので変更ファイル一覧にも入らない）だが、生成済みの実物を読んで確認した — **Env バインディング（`__BaseEnv_Env`）は `ASSETS` / `APP_URL` / 秘密4本 / `USER_DATA` / `IDENTITY_DIRECTORY` の9項目のみで `D1Database` / `Queue` は無い**。grep のヒットはすべて `// Begin runtime types` 以降の workerd 型ライブラリ本体（`interface Queue<Body>` などの定義そのもの）で、AC-17 の射程外である |
| AC-18 | OK | **実測**: 両 `package.json` の `db:*` = **0本**、`deploy:*` = **12本ずつ**（役割別8＋合成4）。`test:smoke` / `dev:state` あり。対応表は `README.md`「Deployment」に4行残っており、右辺に現れる12本がすべて実在 |
| AC-19 | OK | **実測**: `.toml` / `.tpl` 全体で `d1_databases` / `queues.` が 0件、`[env.` が 0件。`exports` は `wrangler.state.toml` と state 側 `.tpl` 2本に `type = "durable-object"` / `storage = "sqlite"` で2クラス分。`main` は経路で分離 — ローカル `wrangler.toml` のみ `app/server.cloudflare.ts`、他4本は `dist/{server,state}/index.js` |
| AC-20 | OK | **実測**: 指定の grep（`.thread/` 除外・`spec/idea.md` 除外）で **0件** |
| AC-21 | OK | `vitest.config.integration.ts` の `durableObjects` が両バインディングとも `{ className, useSQLite: true }`、`main` はトップレベル。`include` は3ディレクトリで、**リポジトリ内の `*.integration.test.ts` にこの3つの外へ出ているものは無い**（実測）。`setupFiles` は `adapters/cloudflare/__tests__/setup.ts`。旧 `worker/cloudflare/__tests__/handlers.integration.test.ts` は削除済み |
| AC-22 | OK | **実測**: `rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke` → **2 passed / 1 file**。`boot.smoke.test.ts` が request / state 両方に `scriptPath` + `dispatchFetch`、`Disallowed operation called within global scope` を検知。CI は build ジョブで `build:cf` → `test:smoke` |
| AC-23 | OK | **実測**: プロダクションコードの `Date.now()` ヒットは2件でどちらも**コメント本文**（`reindex.ts`:118 / `jobBudgets.ts`:104）。`crypto.getRandomValues` 4件はすべて関数本体の内側。`randomUUID` / `setTimeout` / `setInterval` は 0件。実行時の裏づけは AC-22 のスモーク緑 |
| AC-24 | OK | `apps/web/app/durable-objects/{userData,identityDirectory}.ts` がいずれも `ownerToken: this.container.idGenerator.next()` でハンドラ側採番 |
| AC-25 | OK | **実測**: (i) `presentation` への import 文 0件、(ii) `application` → `adapters` の逆流 0件（`di/` と `__tests__/` 除外）。加えて `di/__tests__/noAdapterBackflow.test.ts` がファイル名単位の機械検査を常設 |
| AC-26 | **NG（部分）** | **実体は満たしている** — 本ラウンドで `.wrangler/deploy/config.json` が `../../dist/server/wrangler.json`（request 側）を指したまま `-c wrangler.state.toml --dry-run` を実行し、**state Worker が 114.16 KiB / `USER_DATA` + `IDENTITY_DIRECTORY` の DO バインディング2本でバンドルされる**ことを確認した（redirect に引きずられていない）。3周目は `.tpl` からレンダリングした `wrangler.{request,state}.staging.toml` でも両経路の一致を実測済み。**未達なのは記録先だけ**で、AC が名指しする PR 本文に載っていない → W-001 |
| AC-27 | OK | (i) `operations.target_locators` は終端でも消えない（`userData/unitOfWork.ts` の `updateOperation` に該当代入なし）、(ii) 予約行の終端削除なし、(iii) `caller_token` を NULL 化する `UPDATE` は**実測ゼロ**、(iv) `schema/identityDirectory.ts`:21-22 に `change_state IS NULL OR change_state IN ('pending','advanced')` の CHECK。一様な終端は `jobs/table.ts` の `poisonJob` が `status` / `terminal_reason` / `completed_at` / `lease_until` / `owner_token` / `next_run_at` を1文で確定。PII 非混入は `runner.integration.test.ts`「keeps PII and reusable secrets out of terminal_reason and the log」 |
| AC-28 | OK | `CLAUDE.md` に「Migration in progress」節は**不在**。エントリポイント一覧は request / state の2本立て、Key concepts の UoW 節は `recalcTrashPurgeAfter` / `findOperation` の位置づけまで含む、Cross-layer catch policy に「migration gate → `alarm()`」が4つ目として追加済み。`docs/test.md` は3スイート構成へ全面更新（DO バインディング・`useSQLite`・`test:integration:cf` の廃止・shuffle 運用）。`docs/backend_implementation_example.md` と `docs/runtime_cloudflare.md` の双方に `> [!WARNING]` ブロック＋ #38 への委譲 |
| AC-29 | OK | **実測（本ラウンド）**: `pnpm install --frozen-lockfile` = Already up to date / `pnpm typecheck` = 0 / `pnpm lint` = 0（infos 2、エラー0） / `pnpm format:check` = 0 / `pnpm test:unit` = **525 passed / 36 files** / `pnpm test:integration` = **187 passed / 19 files を3回** / `pnpm test:integration:shuffle` = **5シード緑** / クリーンビルド後の `pnpm test:smoke` = **2 passed** |
| AC-30 | OK | 5件とも実施済みを GitHub で確認 — (a) #26（2026-08-02T22:30:29Z）、(b) #10（22:30:51Z）、(c) #37 本文の誤り2点（22:31:14Z）、(d) #38（22:31:45Z）、(e) #2 / #3 / #4 / #5 / #6（22:32:15〜22:32:20Z、5件とも同題） |

**NG は AC-26 の1件のみ。** 中身は検証済みで、PR 本文への転記が残っているだけである。

#### 3回目指摘の修正検証

| ID | 判定 | 検証内容 |
|---|---|---|
| ADP-W-001（`armAfterRpc` が既存 Alarm を後ろへずらせる） | **解消** | `alarm.ts`:116-118 が `const at = clamp(now, earliest); if (cache.scheduledAt !== null && cache.scheduledAt <= at) return;` の前倒し専用ガード。**他3経路に置いていないのが正しい** — `settleAlarm` は実行可能集合が空なら `deleteAlarm()` してキャッシュを `null` にし、非空なら正しい時刻へ**後ろ倒しする必要がある**ので、ここに同じガードを置くと「早すぎる武装が永久に居座って毎回空振りする」逆の病気になる。`rearmBeforeWork` / `rearmFailClosed` は `alarm()` の内側の権威ある書き込み。キャッシュと実値の乖離も追った — 武装を消す本番経路は `settleAlarm` だけで、そこがキャッシュを `null` にするので乖離しない。配信直後は `rearmBeforeWork` が先頭で張り直してキャッシュを更新し、そこが throw しても `rearmAfterFailure` → `rearmFailClosed` が同じ `persist` を通る。テストは「due な行に対し `now` を進めながら3回叩き、`setAlarm` の書き込みが `[BASE+2000]` の1回だけ」 |
| ADP-W-002（写像行の生成をまたぐと窓一意性が破れる） | **解消** | `mappingOperations.ts` の `reserve` が `last_reset_requested_at` に `timestamp`（= その行の `created_at`）をバインド。**バインド順を17個すべて列順と目視照合した** — `credential_id / kind / hmac / generation / password_verifier / encrypted_canonical / encryption_generation / encryption_nonce / last_reset_requested_at / operation_id / candidate_user_id / reserved_until / locators / coordinator_locator / caller_token / created_at / updated_at` で完全一致（ここがずれると型は通るのに列が入れ替わるので、テスト緑だけでは足りないと判断した）。不変条件の断定は3箇所（`lib/jobBudgets.ts`:54-59 / `credentialMappingRules.ts`:97-101 / `spec/database/index.md`:586）で相互に整合。**プロダクションで `credential_mappings` に INSERT する経路は `reserve` 1本だけ**であることも確認済み（残るヒットはすべて `__tests__/`）。窓 k-1 に予約 → 窓 k に activate という順序でも不変条件が閉じることを手で追った（予約行は窓 k-1 から存在するので、窓 k の先行依頼は `recordResetRequested` の無条件記録で `last` を k へ進める） |
| TEST-W-001（Directory クラスの `runRpcEntry` 経由が未観測） | **解消** | `rpcEntries.integration.test.ts` に1本追加。`ARMED_AT = 4_000_000_000_000` で `enqueueJob` → `getAlarm()` が `null`（陰性対照）→ ゲート付き RPC 1本 → `getAlarm()` が `ARMED_AT`。`getAlarm()` を使えるのが「遠未来だから」であることと、`disarm` が不要な理由が JSDoc に明記されている（ADR-110 の測定と矛盾しない） |

**退行の有無 — `signedUpInAnEarlierWindow()` は「テストを実装に合わせて弱めた」形ではない。** 重点で名指しされた点なので、以下を個別に確かめた。

- ヘルパが触るのは `credential_mappings.last_reset_requested_at` の**1列だけ**で、`encrypted_canonical` / `encryption_generation` / `encryption_nonce` には一切触れない。したがって当該テスト（"sends the link to the address the signup itself sealed"）が担保していた性質 — **signup が封じた暗号文から受信者を復元する ADR-030 → ADR-036 の閉ループ** — はそのまま残っている。`expect(await deliverDueMail(email)).toEqual([email])` が依然としてその主張であり、seed も注入もされていない。
- **陰性対照も残っている** — 同テスト末尾の「未登録アドレスは同じジョブ行を作るが受信者ゼロ」（`deliverDueMail(unknown)` が `[]`）は無変更。
- ヘルパが均した前提（生誕窓では非適格）は**捨てられておらず、別テストで直接固定されている** — `sendMail.integration.test.ts` の新規1本「does not let a mapping born mid-window spend a send-mail key an earlier request already used」が、`request → drain → register（`reserve` + `activate` の実経路） → request` の順で「同窓ではジョブ行1本のまま `done`・トークン0本」、次窓では「行2本・送信1・トークン1」を assert する。ADR-121 にはバインドを `null` に戻すと `expected 1 to be +0` で赤になる変異試験の記録がある。
- 均さずに残っている隣接テスト（"writes exactly one job row whether or not the address is registered"）は**適格性に依存しない**主張（列挙オラクル対策の無条件 enqueue）なので、ヘルパ無しで正しく成立している。`facade.requestPasswordReset` を読んで、`ctx.enqueueJob` が `eligible` の外にあることを確認した。
- **`credentialMappingRules.ts` / `jobBudgets.ts` / `spec/database/index.md` の3点は整合している。** ADR-121 が「不変条件を全称に戻すための書き込み」であることを3箇所とも同じ向きで説明しており、`isResetRequestAllowed` の `null` 分岐が「この書き込み以前の既存行のため」に残されている理由も一致する。唯一の粗さは N-004（同一 JSDoc 内の断定と例外が段落で分かれている）。

**その他の層への波及も確認した。** `d71055a` の3件はいずれも Presentation / DI / ドメイン契約の形を変えていない（`credentialMappingRules.ts` と `jobBudgets.ts` の変更は**コメントのみ**、`spec/database/index.md` は1行、残りは adapters とテスト）。`pnpm typecheck` / `lint` / `format:check` と3スイートが全緑であることに加え、AC-4 / 5 / 14 / 17 / 20 / 23 / 25 の構造 grep を再実行して**3周目と同じ 0件**であることを確かめた。

#### 検証コマンドの実行記録（本ラウンド）

| コマンド | 回数 | 結果 |
|---|---|---|
| `pnpm install --frozen-lockfile` | 1 | Already up to date |
| `pnpm typecheck` | 1 | exit 0（`tsgo` + `packages/core` + `apps/web` + `infra/cloudflare/pulumi`） |
| `pnpm lint` | 1 | exit 0（220 files / infos 2 / エラー0） |
| `pnpm format:check` | 1 | exit 0（239 files） |
| `pnpm test:unit` | 1 | **525 passed / 36 files** |
| `pnpm test:integration` | **3** | 3回とも **187 passed / 19 files** |
| `pnpm test:integration:shuffle --sequence.seed=<s>` | **5シード**（`1` / `31337` / `424242` / `987654` / `20260803`） | 5シードとも **187 passed / 19 files**。2周目に赤だった `31337` を含む |
| `rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke` | 1（クリーンビルド） | build exit 0（`dist/server/index.js` 569k / `dist/state/index.js` 176k）、smoke **2 passed / 1 file** |
| `npx wrangler deploy -c wrangler.state.toml --dry-run` | 1 | state Worker を **114.16 KiB** でバンドル。バインディングは `USER_DATA` / `IDENTITY_DIRECTORY` の DO 2本 + `APP_URL`。`.wrangler/deploy/config.json` が request 側を指したままでも引きずられない（AC-26 の実体） |
| AC 構造 grep（AC-4 / 5 / 8 / 14 / 17 / 18 / 19 / 20 / 23 / 25 / 27） | 各1 | すべて期待どおり（内訳は AC 表） |
| ADR 連番検査（重複 / 未定義参照） | 1 | 重複0・#37 射程での未定義参照0 |

**変異試験は本ラウンドでは実施していない。** 3周目までに各観点が実施済みで、`d71055a` の3件についても ADR-120 / 121 / 122 が変異とその赤メッセージを個別に記録している（`entry()` から arming を外す / バインドを `null` へ戻す / guard を外す）。本ラウンドはその記録の内容が実装と一致するかを読み合わせる形で確認した（スナップショット + `cp` による復元は不要だった）。

#### カバレッジ

**確認 62 + スキップ 203 = 265。**

**確認（62件）**

| 区分 | 件数 | 内容 |
|---|---|---|
| `d71055a`（3周目修正）の差分 | **16** | 全件を差分または全文で精読。内訳は production 4（`jobs/alarm.ts` / `identityDirectory/mappingOperations.ts` / `domain/identity/credentialMappingRules.ts` / `lib/jobBudgets.ts`）、テスト4（`rpcEntries` / `alarm` / `sendMail` / `identity` の各 integration test）、spec 1（`spec/database/index.md`）、作業ログ7（`adr.md` + `review-003*` 6本） |
| 契約・ドキュメントの正本 | 8 | `CLAUDE.md` / `README.md` / `docs/test.md` / `docs/runtime_cloudflare.md` / `.adr/001` / `.adr/003` / `.adr/008` / `.thread/37/plan.md` |
| 設定・ビルド・CI | 12 | `package.json` / `apps/web/package.json` / `vitest.config.integration.ts` / `.github/workflows/ci.yml` / `apps/web/wrangler.toml` / `wrangler.state.toml` / `.tpl` 4本 / `apps/web/scripts/render-wrangler.ts` / `pnpm-lock.yaml` |
| AC 検証で内容を参照した実装・テスト | 24 | `schema/{userData,identityDirectory}.ts` と `schema/__tests__/gate.integration.test.ts`、`jobs/table.ts`、`search/projection.ts` と `search/__tests__/projection.integration.test.ts`、`execution/unitOfWork.ts` と `__tests__/unitOfWork.typetest.ts`、`lib/jobKind.ts`、`di/serverCloudflare.ts` と `di/__tests__/routingNonExposure.test.ts`、`userData/{accountStore,unitOfWork}.ts`、`identityDirectory/{facade,credentialMappingRepository,resetTokenStore,resetTokenCrypto,canonicalCipher}.ts`、`jobs/handlers/reindex.ts`、`webcrypto/pbkdf2PasswordHasher.ts`、`durable-objects/{userData,identityDirectory}.ts`、`apps/web/__tests__/boot.smoke.test.ts`、`infra/cloudflare/pulumi/resources/index.ts`、`.thread/37/steps.md`、`.thread/37/review/triage.md` |

**スキップ（203件）**

`d71055a` 以降**1バイトも変わっておらず**、1〜3周目に5観点（Domain / Use Case・Adapter / Infrastructure・Security・Test・Presentation / Config）すべてが Blocker ゼロで通したファイル群である。本ラウンドの射程（3周目修正の退行・AC 30項目・ドキュメント整合・成果物）に照らして個別の再読を要しないと判断した。

| 領域 | 件数 |
|---|---|
| `packages/core/src/adapters/` | 78 |
| `packages/core/src/application/` | 37 |
| `apps/web/app/` | 27 |
| `packages/core/src/domain/` | 19 |
| `.thread/37/`（1・2周目のレビューログ・`testing.md`） | 13 |
| ルート直下の設定・スクリプト | 9 |
| `spec/` | 7 |
| `infra/cloudflare/pulumi/` | 6 |
| `packages/core/src/lib/` | 6 |
| `docs/` | 1 |
| **計** | **203** |

このうち **46件は削除**（`adapters/d1/` 一式・relay / consumer / pruner / dlq の4 Worker・イベント機構・drizzle 設定など）で、**存在しないことは AC-14 / AC-17 の機械検証で全パス確認済み**である。

**確認申告ゼロのファイルは無い** — 上記62件に加え、203件のうちソースファイルはすべて `pnpm typecheck` / `lint` / `format:check` と3スイート（unit 525 / integration 187 × 8回 / smoke 2）の実行対象に入っており、削除済み46件は不在を機械検証している。

## マージ可否の判定

**可。**

- Blocker ゼロ。3周目の3件は実装・テスト・spec・ADR の4方向すべてで閉じており、他層への退行は見つからなかった。とくに重点で指定された `signedUpInAnEarlierWindow()` は、担保していた性質（ADR-030 → ADR-036 の暗号文ループ）を維持したうえで前提だけを均すヘルパであり、**均した前提そのものは別ファイルの新規テストが直接固定している**。テストが実装に合わせて弱められた形ではない。
- 唯一の未達 AC-26 は、**検証の実体は済んでいて記録先が PR 本文でないだけ**である。コード・テスト・spec の変更を要さないので、マージ前に PR 本文へ実測値（`--dry-run` の結果、unit 525 / integration 187 / smoke 2、ADR 82本）を転記すれば閉じる。
- Warning 1件・Note 6件はいずれも文書と記録の粒度に関するもので、**動作・設計・受け入れ基準の充足を損なうものは無い。**
