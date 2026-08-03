### Test

3周目のレビュー。焦点は「マージしてよいか」であり、**2周目 B-001（統合スイートの不安定性）の修正が本物かを自分で検証すること**に最も時間を割いた。修正エージェントの主張は鵜呑みにせず、遅延注入・陰性対照・変異試験・負荷試験をすべて自分で回した。

すべてローカル実測（2026-08-03）。**フルスイートの緑は通算25回**（連続6回 + シャッフル7シード + 遅延注入1回 + 高負荷10回 + 最終確認1回）。

| 実行 | 結果 |
|---|---|
| `pnpm test:integration` ×6（連続） | **6/6 緑**（19 files / 184 tests） |
| `pnpm test:integration:shuffle --sequence.seed=` ×7（31337 / 20260803 / 1 / 424242 / 999983 / 5 / 77） | **7/7 緑** |
| `pnpm test:integration` ×10（`yes` 8本で CPU を飽和させた状態） | **10/10 緑** |
| 遅延注入（実 RPC 直後に 2000ms、3ファイル4箇所） | **緑**（`--testTimeout=60000`） |
| 陰性対照（`disarm` を no-op へ + 同じ遅延） | **5本が赤**（resetToken 4 / identity 1） |
| ADR-110 の再現手順で `alarmEntry` を再現 | **`AssertionError: expected 2 to be 1` を決定的に再現**、`disarm` を戻すと緑 |
| DO 名衝突の強制（resetToken を identity と同一バケットの固定名へ） | **緑**（連続 + 2シード） |
| 自前の変異試験6本 | **6本とも狙いどおり**（うち1本は検出されず → W-001） |
| `pnpm typecheck` / `pnpm lint` / `pnpm format:check` | すべて通る |
| `pnpm test:unit` | 36 files / **525 passed**（2周目: 36 / 510） |
| `rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke` | 1 file / 2 passed |

**復元はすべてスナップショット + `cp`**（`git checkout` は、自分が `git show` で書き出した過去版を HEAD へ戻す用途にのみ使用）。全工程の後で `git status` は clean（未追跡は他観点の `review-003-*.md` のみ）。

---

#### Blockers

なし。

#### Warnings

- **[W-001]** AC-12 (iii)（RPC 経路で `setAlarm` が発火する）が **Identity Directory DO クラスについて担保されていない**。`entry()` から `runRpcEntry` を外し、arming を落とした手書きのゲート + envelope に差し替えても、統合スイート184件が**全部緑**になる
  - 場所: `apps/web/app/durable-objects/identityDirectory.ts:314-322`（`entry()`）。対になる User Data 側は `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts:82-86` が実 RPC 後の `getAlarm()` を assert しているので覆われている
  - 理由: **変異試験で実測**（MUT-6）。`entry()` の `return runRpcEntry(deps, this.now(), body);` を「`this.gate()` → `ok(body())` / `err(error)`」の手書きに置き換え、`armAfterRpc` を通さない形にしたところ、`pnpm test:integration` は **19 files / 184 passed のまま**だった。`rpcEntries.integration.test.ts` はゲートの有無しか見ていないので通り、`alarmEntry.integration.test.ts` は `disarm` の後に手で `alarm()` を駆動するので通る。共有実装（`runRpcEntry`）自体は `jobs/__tests__/alarm.integration.test.ts` の新設 describe が押さえており（MUT-1 / MUT-2 で確認済み）、壊れうるのは「Directory クラスがその共有実装を経由し続けること」の一点だけである。
    **これは2周目の修正が持ち込んだ穴ではない。** 修正前（`21fd944`）のテスト5ファイルへ戻したうえで同じ MUT-6 を当てても **180 passed で緑**だった（プラットフォーム配信は干渉として赤を出しただけで、arming の証拠にはなっていなかった）。したがって既存の欠落であって回帰ではないが、`disarm` の導入によって「実 RPC の後に武装が残らない」ことが規則化されたぶん、この観測点は今後も自然には戻ってこない。
  - 提案: `cleanup.integration.test.ts` と同じ型で1本足すのが最も安い。`getAlarm()` は「due 間近の武装」には `null` を返す（`alarmEntry.integration.test.ts:16-21` の実測）が、**遠い未来の武装には正しい値を返す**（`cleanup` の `ARMED_AT = 4_000_000_000_000` が現にそれを assert している）。すなわち Directory バケットへ `nextRunAt` を遠い未来にしたジョブを `enqueueJob` で直接入れ、ゲート付き RPC を1本叩き、`getAlarm()` がその時刻を返すことを見ればよい。プラットフォーム配信は起こりえないので `disarm` も要らない。

#### Notes

- **[N-001]** **2周目 B-001 の修正は本物である。** 再現・修正・陰性対照の三点セットを自分で再実行して確認した。とくに `alarmEntry` は ADR-110 が書いている手順（数える窓を 2000ms 開けたまま、事前の `fire(stub)` ドレインを外す＝ RPC が張った `now+1000` が生きている状態で窓を開く）で **`expected 2 to be 1` をレビュー報告と同一メッセージで決定的に再現**でき、`disarm` を戻すと緑になった。最初に自分で試した「事前ドレインを残したまま窓を広げる」形では再現しなかったが、それは `fire(stub)` の再武装がプラットフォームの配信予定（+1秒）を2時間先へ上書きしてしまうためで、修正エージェントの説明と矛盾しない。
- **[N-002]** **`disarm` の呼び忘れを機械的に検出する仕組みは無い**（修正エージェント自身の懸念）。現時点で偽の緑は生んでいない — 実 RPC を叩いたうえでキューを読む／駆動するテストを全数当たった結果、`disarm` を通していないのは `identity.integration.test.ts:634-698`（`changeTrashRetentionDays` の2本）と `cleanup.integration.test.ts` だけで、前者は assert が `operation_key` / `kind` と行数0なのでプラットフォームが `purge-trash` を走らせても形が変わらず（`purge-trash` は再武装種別なので行が消えない）、後者は `ARMED_AT` を遠い未来に置くことで配信そのものを起こさない設計になっており、その理由がコメントに明記されている（`:37-40`）。規則は `docs/test.md`「Timeout / flakiness」と `disarm` の JSDoc の両方にあるので、いまは運用で足りていると判断した。
- **[N-003]** **`resetToken.integration.test.ts` の DO 名 `dir:g1:b7${seq}` は実害を持たない。** 依頼にあった「実 locator と衝突しうる」点を強制して確かめた — 5本すべてを固定名 `dir:g1:b119`（`user-1@example.com` が実際に落ちるバケット。HMAC を自分で計算して特定した）へ変えても、連続実行とシャッフル2シードで **184 passed**。`setup.ts` の `afterEach` が毎テスト `reset()` で全バインディングを消すため、ファイル内の固定名でもファイル間の衝突でも状態は持ち越さない。有効な locator 形（`dir:g{gen}:b{index}`、`index < bucketCount`）を保つ制約は本物（`_meta.self_locator` がそのまま reset token の routing 座標として parse される）なので、**現状のままで対処不要**と判断した。
- **[N-004]** 2周目 W-002 / W-003 / W-006 の是正は、いずれも自前の変異試験で検出力を確認した（下表 MUT-1 / 2 / 3 / 4 / 5）。とくに W-006 の「ハーネス側で一括 assert」は 12ケース中 **11本**が反応する（残る1本はハンドラを呼ばない enqueue のテスト）ので、修正エージェントの報告と一致する。
- **[N-005]** 2周目 W-001（`cleanup.integration.test.ts` の JSDoc）は解消。現在は「`reset()` alone does both」「`evictAllDurableObjects()` は保険」と書かれ、`setup.ts:21-32` と同じ判断になっている。両者が割れてはいけない旨も明記された。
- **[N-006]** 2周目 W-004 / W-005 も解消を確認した。`test:integration:shuffle` はルート `package.json` に実在し、CI の integration ステップは `pnpm test:integration:shuffle --sequence.seed=${{ github.run_id }}`（`.github/workflows/ci.yml:70`）。`docs/test.md`:52 は「Every suite but three」で `cleanup` / `gate` / `binding` の内訳付きになっている。
- **[N-007]** AC-29 のゲートは全部通る — `typecheck` / `lint`（2 infos、エラーなし）/ `format:check` / `test:unit`（525）/ `test:integration`（184）/ `test:smoke`（2、`rm -rf dist` からのクリーンビルドで実測）。

---

#### 2回目指摘の修正検証

| ID | 内容 | 判定 |
|---|---|---|
| **B-001** | 統合スイートの不安定性（プラットフォーム自身の Alarm 配信が第二の駆動者になる） | **解消**。`disarm(stub)` は荷重あり。遅延注入で緑・no-op 化で赤（陰性対照5本）。`alarmEntry` は ADR-110 の手順で報告と同一メッセージを決定的に再現し、修正で緑。フルスイート25回（高負荷10回・7シード含む）すべて緑 |
| **W-001** | `cleanup.integration.test.ts` の JSDoc が `evictAllDurableObjects()` を荷重ありと断定 | **解消**。`setup.ts` と同じ判断（`reset()` が唯一の荷重・evict は保険）に書き直され、割れてはいけない旨も書かれた |
| **W-002** | AC-12 (iii) が未検証（`runRpcEntry` を通るテストが0件） | **解消**。`jobs/__tests__/alarm.integration.test.ts` に describe「the RPC entry wrapper」が新設され4本。**変異試験で確認** — `armAfterRpc` を `try` の中へ移すと4本が赤（新設の2本 + `cleanup` の2本）、武装失敗の `return err` を潰すと「reports an arm it could not persist as a failed call」だけが赤。**ただし Directory DO クラス経由の担保は残っている**（W-001） |
| **W-003** | `requestPasswordReset` の行数テストがバケット衝突に脆い | **解消**。**変異試験で確認** — `bucketCount` を 1 にして全アドレスを衝突させたとき、新クエリ（`instr(operation_key, 'send-mail:email:{hmac}:') = 1`）は緑、`kind` だけの旧クエリへ戻すと `expected [...] to have a length of 1 but got 2` で赤。「別の行であること」の witness も入っている |
| **W-004** | `docs/test.md` の shuffle 主張が運用に無い | **解消**（別エージェント対応）。スクリプトと CI ステップの実在を確認 |
| **W-005** | 「固定名スイートは2本」が実際は3本 | **解消**（別エージェント対応）。`docs/test.md`:52 が内訳付きで3本に |
| **W-006** | `purgeTrash` の `lines` JSDoc「every case below asserts it」が実際は一部 | **解消**。`Io` から `lines` を外し、ハーネスが全ケース後に `expect(lines).toEqual([])`。**変異試験で確認** — ハンドラ先頭に無条件 `logger.warn` を入れると 12ケース中 **11本**が赤 |

**解消 7 / 不十分・未対応 0。** 新たに見つかった問題は W-001 の1件で、これは2周目の修正が持ち込んだものではなく既存の欠落である（修正前のツリーでも同じ変異が検出されないことを実測した）。

---

#### 自分で行った検証

**安定性（フルスイート、すべて 19 files / 184 tests）**

| 条件 | 回数 | 結果 |
|---|---|---|
| `pnpm test:integration` 連続 | 6 | 6緑 |
| `pnpm test:integration:shuffle --sequence.seed=` | 7（31337 / 20260803 / 1 / 424242 / 999983 / 5 / 77） | 7緑 |
| `pnpm test:integration`（`yes` 8本で CPU 飽和） | 10 | 10緑 |
| 最終確認（全復元後） | 1 | 緑 |
| **合計** | **24 + 遅延注入1回** | **25緑 / 0赤** |

シード 31337 は2周目レビューで赤になった値を意図して再実行した。

**遅延注入（依頼された「実 RPC 直後に 2000ms」）**

| 注入箇所 | `disarm` | 結果 |
|---|---|---|
| `alarmEntry` `request()` / `resetToken` `request()` / `identity` `askForResetLink()` の3ヘルパ末尾に 2000ms | 実装のまま | **緑**（184 passed。`--testTimeout=60000`。既定の5秒だと burst テストが 4×2s で時間切れになるためタイムアウトのみ引き上げ） |
| 同上 | **no-op へ潰す（陰性対照）** | **5本が赤** — `identity > sends the link to the address the signup itself sealed` / `resetToken > composes…` / `refuses the same link twice` / `stores nothing a database dump could redeem` / `refuses routing coordinates the keyring does not declare` |
| 同上、遅延を 700 / 800 / 900 / 950 / 1000 / 1100ms で掃引 | no-op | 同じ5本が赤。`alarmEntry` はどの値でも緑 → **配信が RPC 直後に落ちる限り `alarmEntry` の算術は成立する** |
| ADR-110 の手順（`fireCountingDeletes` の窓を 2000ms 開け、事前の `fire(stub)` ドレインを外す） | 実装のまま | **緑** |
| 同上 | **no-op（陰性対照）** | **`does not delete its alarm when the schema is fail-closed` が赤 — `AssertionError: expected 2 to be 1`**（2周目レビューの報告と同一メッセージ） |

**変異試験**

| # | 対象 | 壊し方 | 結果 |
|---|---|---|---|
| MUT-1 | `platform/rpcEntry.ts` | `armAfterRpc` を `try` ブロックの中へ移す | **赤4本** — `arms the alarm even when the body throws after committing` / `arms the alarm when the gate refuses before the body runs` / `cleanup (1 of 2)` / `(2 of 2)` |
| MUT-2 | `platform/rpcEntry.ts` | 武装失敗の `return err(error)` を握り潰す | **赤1本** — `reports an arm it could not persist as a failed call` |
| MUT-3 | `jobs/handlers/purgeTrash.ts` | ハンドラ先頭に無条件 `logger.warn` | **赤11本 / 12本中**（残る1本はハンドラを呼ばない enqueue のテスト） |
| MUT-4 | `application/__tests__/helpers.ts` | `bucketCount` を 256 → 1（全アドレスを1バケットへ衝突させる） | **緑**（25 passed）— 新しい `jobsFor` は衝突に耐える |
| MUT-5 | MUT-4 + `identity.integration.test.ts` | `jobsFor` を `kind` だけの旧クエリへ戻す | **赤1本** — `writes exactly one job row whether or not the address is registered`（`expected … to have a length of 1 but got 2`） |
| MUT-6 | `apps/web/app/durable-objects/identityDirectory.ts` | `entry()` の `runRpcEntry` を、arming の無い手書きゲート + envelope へ置換 | **緑（184 passed）— 検出されない。W-001** |
| MUT-6' | 同上 + テスト5ファイルを修正前（`21fd944`）へ戻す | 同上 | **緑（180 passed）— 修正前でも検出されない**（既存の欠落であって回帰ではないことの確認） |

**DO 名衝突の検証（依頼分）**

`resetToken.integration.test.ts` の `dir:g1:b7${seq}`（実測 `b71`〜`b75`）は、`identity.integration.test.ts` の `user-71@example.com` が落ちるバケット `71` と実際に重なりうる。最悪ケースを強制するため、5本すべてを**固定名** `dir:g1:b119`（`user-1@example.com` が落ちるバケット。ルーティング鍵 `test-directory-routing-secret-0123456789` から HMAC を自分で計算して特定）へ変え、連続実行 + シャッフル2シードを回した → **すべて 184 passed**。`setup.ts` の `afterEach` が毎テスト `reset()` で全バインディングを消すので、同一 DO 名でも状態は持ち越さない。**対処不要**と判断した（N-003）。

**復元手順**: 触った全ファイル（`doHarness.ts` / `alarmEntry` / `resetToken` / `identity` / `helpers.ts` / `rpcEntry.ts` / `handlers/purgeTrash.ts` / `identityDirectory.ts` / `jobs/__tests__/alarm`）をスクラッチパッドへ `cp` でスナップショットし、各試験の後に `cp` で書き戻した。最終状態で `git status` は clean、フルスイートは緑。

---

#### カバレッジ

確認 27 件 / スキップ 232 件（合計 **259** 件、変更ファイル一覧と1対1）。

**確認の粒度**: 2周目の修正コミット `e56785a` が触った11ファイルはすべて差分と現物を読み、うちテストは実行・変異試験・遅延注入で検証した。加えて、W-001 の判断に必要な `identityDirectory.ts` / `rpcEntries.integration.test.ts` / `cleanup.integration.test.ts`、およびロケータ導出の再計算に使った `directoryLocator.ts` / `lib/directoryLocator.ts` / `application/__tests__/helpers.ts` を読んだ。テスト設定（`vitest.config.integration.ts` / `package.json` / `ci.yml`）と `docs/test.md` / `.adr/001` / `plan.md` / `adr.md`（ADR-110〜112）/ `triage.md` は正本として全文ないし該当節を読んだ。**それ以外は 1・2周目で審査済みかつ `e56785a` に差分が無い**ため、再審議していない。

- 確認: `.adr/001-integration-tests-single-workers-pool.md`
- スキップ: `.adr/003-sqlite-fts5-only-search.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- スキップ: `.adr/008-identity-split-and-non-aggregate-stores.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- 確認: `.github/workflows/ci.yml`
- 確認: `.thread/37/adr.md`
- 確認: `.thread/37/plan.md`
- スキップ: `.thread/37/review/review-001-adapter-infra.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-domain-usecase.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-presentation-config.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-security.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001-test.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-001.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-002-adapter-infra.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-002-domain-usecase.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-002-presentation-config.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/review/review-002-security.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- 確認: `.thread/37/review/review-002-test.md`
- スキップ: `.thread/37/review/review-002.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- 確認: `.thread/37/review/triage.md`
- スキップ: `.thread/37/steps.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- スキップ: `.thread/37/testing.md` — 他観点のレビューログ／作業記録。テスト観点の正本は plan.md と triage.md で確認済み
- 確認: `CLAUDE.md`
- スキップ: `README.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- スキップ: `apps/web/.dev.vars.example` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- 確認: `apps/web/__tests__/boot.smoke.test.ts`
- スキップ: `apps/web/app/components/auth/LoginForm/action.ts` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/auth/SignupForm/action.ts` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/settings/CurrentUserPanel/index.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/settings/LogoutButton/action.ts` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/settings/SettingsSkeleton/index.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/components/ui/ErrorSurface/index.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/durable-objects/__tests__/env.d.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts`
- 確認: `apps/web/app/durable-objects/identityDirectory.ts`
- スキップ: `apps/web/app/durable-objects/userData.ts` — DO クラス。エントリ表の全数と fail-closed は rpcEntries.integration.test.ts が実行検査している
- スキップ: `apps/web/app/presentation/__tests__/currentUser.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `apps/web/app/presentation/__tests__/errorResponse.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts`
- スキップ: `apps/web/app/presentation/__tests__/session.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `apps/web/app/presentation/authState.ts` — 実装側。対応テストは 1・2周目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/currentUser.ts` — 実装側。対応テストは 1・2周目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/errorResponse.ts` — 実装側。対応テストは 1・2周目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/errorResponseMiddleware.ts` — 実装側。対応テストは 1・2周目に審査済みで今回差分なし
- スキップ: `apps/web/app/presentation/session.ts` — 実装側。対応テストは 1・2周目に審査済みで今回差分なし
- スキップ: `apps/web/app/routes/_app.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/routes/_app/settings.tsx` — UI 実装。フロントは「最小限」方針（docs/test.md）のため観点外
- スキップ: `apps/web/app/server.cloudflare.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/app/worker/cloudflare/__tests__/env.d.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/consumer.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/dlq.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/handlers.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/pruner.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/relay.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/app/worker/cloudflare/state.ts` — Worker エントリ。起動可否は boot.smoke.test.ts で確認済み
- スキップ: `apps/web/drizzle.config.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/package.json` — パッケージ定義。テストスクリプトはルート package.json 側で確認済み
- スキップ: `apps/web/scripts/render-wrangler.ts` — ビルド設定・スクリプト。成果物が起動するかは boot.smoke.test.ts で確認済み
- スキップ: `apps/web/vite.config.cloudflare.ts` — ビルド設定・スクリプト。成果物が起動するかは boot.smoke.test.ts で確認済み
- スキップ: `apps/web/vite.config.state.ts` — ビルド設定・スクリプト。成果物が起動するかは boot.smoke.test.ts で確認済み
- スキップ: `apps/web/wrangler.production.toml.tpl` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/wrangler.request.production.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.request.staging.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.staging.toml.tpl` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `apps/web/wrangler.state.production.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.state.staging.toml.tpl` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.state.toml` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `apps/web/wrangler.toml` — デプロイ／実行時設定。テスト環境の設定は vitest.config.* 側で確認済み
- スキップ: `docs/backend_implementation_example.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- スキップ: `docs/runtime_cloudflare.md` — ドキュメント。テスト構成の正本は docs/test.md と .adr/001 で確認済み
- 確認: `docs/test.md`
- スキップ: `infra/cloudflare/pulumi/resources/Pulumi.production.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/resources/Pulumi.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/resources/index.ts` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/routes/Pulumi.production.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml` — IaC 定義。テストスイートから参照されない
- スキップ: `infra/cloudflare/pulumi/routes/Pulumi.yaml` — IaC 定義。テストスイートから参照されない
- 確認: `package.json`
- スキップ: `packages/core/package.json` — パッケージ定義。テストスクリプトはルート package.json 側で確認済み
- 確認: `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/directoryLocator.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts`
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/env.d.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/adapters/cloudflare/__tests__/setup.ts`
- スキップ: `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/adapters/cloudflare/directoryLocator.ts`
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/mappingOperations.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/resetRequestKeys.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/payloadDigest.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts`
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/jobs/alarm.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- 確認: `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/registry.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/runner.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/jobs/table.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/mailSender.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/platform/envelope.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- 確認: `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- スキップ: `packages/core/src/adapters/cloudflare/platform/stubErrors.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/schema/gate.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/schema/types.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/schema/userData.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/search/normalize.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/search/probe.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/search/projection.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/cloudflare/sql/errors.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/sql/exec.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/sql/occ.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/cloudflare/userData/accountStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/userData/facade.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/userData/trashQuery.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/d1/__tests__/env.d.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/helpers.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/setup.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/client.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/migrations/0000_initial.sql` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/migrations/meta/_journal.json` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/pendingBatch.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/helpers.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/idempotencyStore.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/outboxRepository.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/repositories/userRepository.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/schema.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/d1/unitOfWork.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- 確認: `packages/core/src/application/__tests__/helpers.ts`
- スキップ: `packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/di/__tests__/routingNonExposure.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/di/__tests__/secrets.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/di/containerStore.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/di/env.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/di/facades.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/di/secrets.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/di/serverCloudflare.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/di/stateCloudflare.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/di/types.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/errors.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/events/buildDecoder.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/execution/jobs.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/execution/unitOfWork.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/identity/__tests__/eventDecoders.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- 確認: `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- スキップ: `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/identity/__tests__/logout.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/identity/__tests__/requestPasswordReset.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/identity/eventDecoders.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/identity/getCurrentUser.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/identity/loginWithPassword.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/identity/registerWithPassword.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/identity/requestPasswordReset.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/identity/signupSaga.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/identity/view.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/ports/idGenerator.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/application/ports/idempotencyStore.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/ports/outboxRepository.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/ports/relayTrigger.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/ports/sessionCodec.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/application/rpc/__tests__/restoreError.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/application/rpc/restoreError.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/workers/__tests__/outboxPrune.test.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/workers/eventRelayWorker.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/application/workers/outboxPrune.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/domain/common/event.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/domain/common/transactionalRepository.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/domain/identity/__tests__/credentialMappingRules.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/domain/identity/__tests__/entity.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/domain/identity/__tests__/noRawNul.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/domain/identity/__tests__/valueObject.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `packages/core/src/domain/identity/credentialMappingRules.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/domain/identity/entity.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/domain/identity/errorCode.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/domain/identity/events.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/domain/identity/ports/accountStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/credentialLocatorStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/credentialMappingRepository.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/credentialMappingStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/mailSender.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/ports/userRepository.ts` — 削除ファイル（D1 / イベント機構の撤去）。対象消滅で等価テストは不要、後継の十分性は 1・2周目に判定済み
- スキップ: `packages/core/src/domain/identity/ports/userSettingsRepository.ts` — ポート型定義。振る舞いを持たずテスト対象にならない
- スキップ: `packages/core/src/domain/identity/valueObject.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/lib/__tests__/jobKind.test.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- 確認: `packages/core/src/lib/directoryLocator.ts`
- スキップ: `packages/core/src/lib/errorIdentity.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/lib/jobBudgets.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/lib/jobKind.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/lib/passwordHashing.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/lib/rpcEnvelope.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `packages/core/src/lib/secretLengths.ts` — 実装側。対応するテストの有無と十分性は __tests__ 側で判定済み（1・2周目）
- スキップ: `pnpm-lock.yaml` — 生成物。依存の増減は package.json 側で確認済み
- スキップ: `spec/database/index.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/domains/identity.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/inventory/adapter.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/inventory/domain.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/inventory/usecase.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/manual-tests/search.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/testcases/identity/unlinkSsoCredential.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- スキップ: `spec/usecases/identity.md` — 仕様書。オラクルとして参照はしたが差分審査は他観点
- 確認: `vitest.config.integration.ts`
- スキップ: `vitest.config.smoke.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
- スキップ: `vitest.config.ts` — テスト／テスト設定。1・2周目に審査済みで、今回の修正コミット e56785a に差分が無い
