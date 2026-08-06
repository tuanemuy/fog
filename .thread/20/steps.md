# 実装手順 — Issue #20

## 設計

### ドメインモデルへの影響

**なし。** `PasswordHasher` はドメインポートだが、`spec/domains/identity.md:574` が「アルゴリズム（Argon2id 等）とパラメータはアダプター実装の責務」と明示的に委譲している。`PasswordHash` は不透明文字列（`:274`）で、ドメインは中身を解釈しない。ポートのシグネチャも同期／非同期の別（`spec/domains/index.md:34` の例外2件）も動かない。

### ユースケース / アプリケーションロジック

`loginWithPassword` の**ダミーハッシュ定数だけ**が動く。ロジックは1行も変わらない。

このダミーは `spec/inventory/adapter.md:53`（ADP-identity-013)「対象行が無い場合もダミー材料で同じ計算量を通す」の実装であり、**「本番ハッシャーで読めること」と「本番ハッシャーと同じ計算量になること」の2つが同時に成立して初めて意味を持つ**。今のコードはこのうち**反復回数の一致だけ**を型で強制している（`DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS`）。案 A はアルゴリズムだけを動かす変更なので、**同じ `typeof` の仕掛けをアルゴリズム識別子にも掛けて穴を塞ぐ**のが本 Issue の設計上の中心。

定数の所在は application 層のまま動かさない。アダプターが application を型 import する現在の向き（内向き）が正しく、逆向きは依存方向違反になる。

### アダプター / 永続化 / 外部連携

`packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` が実質の全変更点。

**案 B なら定数2つ**（`DEFAULT_PBKDF2_ITERATIONS` とその JSDoc）で閉じる。

**案 A なら「書き出す形式は1種類・読める形式は複数」という非対称**を型で表現する形にする。**この非対称は「読み取り経路が部分関数・書き出し経路が全域」という形でコードに現れる**のが正しく、対応表（`Map` / object）を導入して書き出し側までそれを引かせると、`.get()` の戻り値に `undefined` が混ざって**書き出し経路まで部分関数になり、非対称が型から消える**（`CLAUDE.md`「Make illegal states unrepresentable at the type level before falling back to runtime checks」）。方式が2つしかない以上、表は不要。

- 読み取り側は**全域関数** `hashFor(algorithm: string): "SHA-256" | "SHA-512" | null`。`null` が「読めない識別子」で、`parse()` はそれを `SystemError(DataIntegrityError)` に落とす。表を持たないので**プロトタイプ由来のキーが真値を返す余地が構造的に無い**
- 書き出し側は `ALGORITHM_ID`（保存形式に書く識別子。ダミー側の定数へ `typeof` でピン留めする）と `SHIPPED_HASH`（WebCrypto に渡す `hash` 名。`as const` の単一値）の2つを直に持つ。**`hash()` は `hashFor()` を引かない**ので `undefined` / `null` が型に現れない
- 2つが食い違わないことは、アダプター単体テストで**リテラルを使って**固定する（`expect(hashFor("pbkdf2-sha512")).toBe("SHA-512")` と `expect(ALGORITHM_ID).toBe("pbkdf2-sha512")`）。`expect(hashFor(ALGORITHM_ID)).toBe(SHIPPED_HASH)` の形は**採らない** — 両辺を検査対象の定数から組み立てているので2つがそろって別方式へずれた場合に通ってしまい、ステップ7-1 が自ら禁じている自己言及そのものになる。なお**この穴は無音ではない**: 2つが食い違えば `hash()` が書いた値を `verify()` が別のダイジェストで導出することになり、既存の `pbkdf2PasswordHasher.test.ts:32-35`（`it("verifies a password it hashed")`）が必ず落ちる。したがって検出手段は「型ピン＋往復テスト」の二層で、リテラル検証はその意図を読み手に見せる3層目である
- `derive()` は `hash` 名を引数で受け取る。`hash()` は `SHIPPED_HASH` を、`verify()` は保存値から読んだ値を渡す
- `DERIVED_BITS = 256` / `SALT_BYTES = 16` / `MIN` / `MAX` は据え置き（SHA-512 でも 32 byte 出力は 1 ブロック）

永続化スキーマ・マイグレーション・DI 配線の変更は無い。`serverCloudflare.ts:145` は引数なしで既定値を取るので自動的に追随する。

### UI / プレゼンテーション

**なし。**

---

## 実装ステップ

### 1. workerd 実測プローブを設置し、G-0 をローカルで・比較を CI（x86）で取る

- **対象ファイル:** `packages/core/src/application/identity/__tests__/_probe.integration.test.ts`（新規・**この PR 内で削除する捨てファイル**）
- **設定ファイルは一切触らない。** このディレクトリは `vitest.config.integration.ts:79` の `include` 許可リスト（`packages/core/src/application/**/*.integration.test.ts`）に**既に載っている**。検証対象は webcrypto アダプターなので置き場所としては座りが悪いが、捨てファイルの配置の整合性より、恒久設定（`.adr/001` の決定）に一時的な穴を開けて戻し忘れないことを優先する
- **着手前の確認（1分）:** **初回本番デプロイが未実施であること**を確認する（plan.md「前提」）。本計画は「`pbkdf2-sha256$` 形式の行が本番に一度も存在しない」ことの上に立っており、成立していなければ移行が要る別の計画になる。確認できなければここで止め、#18（rehash-on-login）との統合として再設計する
- **先行実測（2026-08-07 / 計画確定時に、下記と同じ形のプローブをローカル workerd で設置・実行・撤去して取得）:**

  | 項目 | ローカル実測（Apple Silicon / vitest-pool-workers） |
  |---|---|
  | `G-0`（`SHA-512 @ 210k` の疎通） | **通過**（`supported=true`） |
  | `SHA-512 @ 210k` | 中央値 45〜47 ms |
  | `SHA-256 @ 600k` | 中央値 47〜49 ms |
  | 比 | **約 0.97〜0.99** |
  | `SHA-256 @ 210k` | 中央値 16.4 ms（ADR-003 の 16ms と一致） |

  **したがって `G-0` は確定済みとして扱う**（疎通は ISA に依存しないので、ローカルで足りる）。同時に R-2（workerd の時計が計算中に進まない）もこの実測で否定されているので、`G-0b` が発火する見込みは低い。**ただし案 A / 案 B の確定は依然として CI（x86）実測による** — 比が 0.99 と紙一重で、SHA-NI の有無で `G-1` ↔ `G-2` ↔ 案 B の境界をまたぎうるためである（`.thread/20/adr.md` ADR-001）。実装者はプローブを CI に載せるために自分でも1度ローカル実行することになるので、G-0 の再確認はその副産物として得られる
- **変更内容:**

  1. プローブを次の形で書く。**`vitest.config.integration.ts` は `globals` を設定していないので、`describe` / `it` / `expect` は明示的に import する**（テスト本体も `describe` で1つに束ねる）。

     ```ts
     import { describe, expect, it } from "vitest";

     const MARKER = "[#20-probe]"; // ログから grep するための目印
     const SALT = new Uint8Array(16);
     const SAMPLES = 3;
     const BATCH = 5;
     // it() の第3引数はタイムアウト（ミリ秒）。Vitest 4 の TestCollectorCallable は
     // (name, fn?, options?: number) と (name, options?, fn?) の2つしか持たないので、
     // オブジェクトをこの位置に置くと TS2345 で typecheck が落ちる。
     const TIMEOUT_MS = 120_000;

     // 全計測の結果をここに溜め、最後の REPORT テストが1つの Error に載せて投げる。
     const results: Record<string, unknown> = {};

     // workerd は Spectre 緩和で計算中に時計を進めない。タイムスタンプの
     // 直前に I/O を1回挟んで時計を更新させ、さらに BATCH 件をまとめて
     // 計ることで、1件あたりの分解能不足を吸収する。
     const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

     // importKey は計測に含めない（鍵をバッチ間で使い回している）。本番の
     // derive() は呼び出しごとに importKey + deriveBits を払うので、ここで
     // 出るのは 1 導出コストの下限であり、R-6 の増分見積もりには importKey
     // 分が上乗せされる。t_A / t_B の比較には影響しない。
     async function measure(hash: "SHA-256" | "SHA-512", iterations: number) {
       const key = await crypto.subtle.importKey(
         "raw", new TextEncoder().encode("probe"), "PBKDF2", false, ["deriveBits"],
       );
       const params = { name: "PBKDF2", hash, salt: SALT, iterations } as const;
       await crypto.subtle.deriveBits(params, key, 256); // warm-up
       const samples: number[] = [];
       for (let s = 0; s < SAMPLES; s += 1) {
         await tick();
         const started = Date.now();
         for (let i = 0; i < BATCH; i += 1) {
           await crypto.subtle.deriveBits(params, key, 256);
         }
         await tick();
         samples.push((Date.now() - started) / BATCH);
       }
       samples.sort((a, b) => a - b);
       const median = samples[Math.floor(SAMPLES / 2)] ?? 0;
       results[`${hash}@${iterations}`] = {
         min: samples[0], median, max: samples[SAMPLES - 1], samples,
       };
       expect(median).toBeGreaterThan(0); // R-2: 全計測 0ms を自動で赤にする
       return median;
     }
     ```

     テスト本体は5件で、`describe("#20 probe", …)` に束ねる。計測4件はすべて `TIMEOUT_MS` を**第3引数（数値）**で渡す（`it("…", async () => { … }, TIMEOUT_MS)`）。

     - `"G-0: derives PBKDF2+SHA-512 at 210k at all"` — `deriveBits({ hash: "SHA-512", iterations: 210_000 })` を1回だけ **try/catch で**叩き、`results["G-0"]` に結果を詰める。**このテストは throw しない**（G-0 の不成立はテストの失敗ではなくゲートの入力）。**`catch (e)` の `e` は `unknown` なので（`packages/core/tsconfig.json` の `strict: true` ＝ `useUnknownInCatchVariables`）、narrowing 込みで書かないと `TS18046` で `pnpm typecheck` が落ちる** — `loginWithPassword.ts:86` の既存パターンと同じ形にする:

       ```ts
       } catch (e) {
         results["G-0"] = {
           supported: false,
           name: e instanceof Error ? e.name : typeof e,
           message: e instanceof Error ? e.message : String(e),
         };
       }
       ```

     - `"measures SHA-512 @ 210k"` — `measure("SHA-512", 210_000)`（= `t_A`）
     - `"measures SHA-256 @ 600k"` — `measure("SHA-256", 600_000)`（= `t_B`）
     - `"measures SHA-256 @ 210k (current, for continuity)"` — `measure("SHA-256", 210_000)`。ADR-003 の 16ms / ADR-033 の 33ms との連続性の確認と、R-6 の増分見積もりに使う
     - `"REPORT (intentionally fails to surface the numbers)"` — **計測4件のあとに置き、`results` を JSON で埋め込んだ `Error` を故意に投げる**。タイムアウトは不要。

       ```ts
       it("REPORT (intentionally fails to surface the numbers)", () => {
         throw new Error(`${MARKER} ${JSON.stringify(results)}`);
       });
       ```

       **これが数値の回収チャネルである。** Vitest 4 の**暗黙の**既定レポーターは通ったテストの `console.log` を出力しない（`--reporter=default` を明示したときとは挙動が違う）ため、`console.log` に載せると CI でも読めない。CI ジョブは `run: pnpm test:integration:cf` 固定でフラグを足せず、`ci.yml` や `package.json` の一時編集は「恒久設定に一時的な穴を開けて戻し忘れる」を構造的に避けるという本計画の方針（`.thread/20/adr.md` ADR-001）に反する。**テストの失敗メッセージはどのレポーターでも必ず出力される**ので、故意の失敗が唯一フラグ不要で成立する経路になる

  2. **`expect(median).toBeGreaterThan(0)` と REPORT の役割分担。** 前者は **G-0b の自動検出**（0ms を「速い」と読ませない。R-2）、後者は**数値の回収**であって、両者は別の失敗である。したがって**失敗したテストの件数が読み取り情報になる** — REPORT の1件だけが赤なら計測は成功、計測側も赤なら G-0b の候補（`results` にはその時点までの値が入っているので、REPORT は変わらず数値を出す）
  3. **実行する（ローカル / CI 共通のコマンド）。**

     ```
     pnpm test:integration:cf packages/core/src/application/identity/__tests__/_probe
     ```

     パスフィルタを付けるのは R-1 の自動化のためで、**1件も拾わなければ vitest が "No test files found" で非ゼロ終了する**。目視ではなく終了コードで確認する。数値は `Failed Tests` セクションの `Error: [#20-probe] {…}` から読む（**ローカル計測と CI 計測で回収手段が分岐しない**のがこの方式の要点）。**ローカルの `t_A` / `t_B` は判定に使わない**（下記「理由」）
  4. **【CI / `t_A` と `t_B`】** push する前にローカルで `pnpm lint:fix && pnpm format && pnpm typecheck` を通しておく（整形前のコードをそのまま push すると `lint-typecheck-unit` ジョブの Format check / Typecheck が赤くなり、「どの赤が想定内か」が読めなくなる）。そのうえでプローブ入りのコミットを **main 宛の Draft PR** に載せて push する。`.github/workflows/ci.yml` の `integration` ジョブ（`runs-on: ubuntu-latest` ＝ x86_64 / `timeout-minutes: 15`）が `pnpm test:integration:cf` を走らせ、プローブも一緒に実行される。**`on.push.branches` は `[main, develop]` なので、フィーチャーブランチへ push しただけでは CI は走らない — PR が必要**

     **プローブを含むコミットでは `integration` ジョブが赤くなるのが想定内である。** REPORT テストが故意に失敗するのだから当然で、**これは計測失敗ではなく計測成功の印**である。Draft PR なのでマージには影響しない。**逆に `lint-typecheck-unit` ジョブの赤は想定外**なので、そちらが赤いときは push 前のローカルゲートを飛ばしている。プローブを撤去したコミット（ステップ3）で `integration` ジョブが緑に戻ることまで確認する（AC-3）

     **push は1回だけにして、数値を回収するまで追加コミットを push しない。** `ci.yml` の `concurrency` は `group: ${{ github.workflow }}-${{ github.ref }}` / `cancel-in-progress: ${{ github.event_name == 'pull_request' }}` なので、**PR では `cancel-in-progress` が true** になる。計測ランが走っている最中にステップ3（プローブ削除）やステップ4以降を push すると、計測ランはキャンセルされ、同時に HEAD からプローブが消えて再投入と再 push が要る。回収は `gh run list` の当該ランが `completed` になってから行う（誤ってキャンセルさせた場合は、プローブを戻して push し直すか `gh run rerun <run-id>` で撮り直す）
  5. **【CI から数値を取り出す】** 失敗メッセージは `integration` ジョブ（`name: Integration tests`）のログに出る。**`gh run view --job` はジョブ *ID* を取る**（`gh run view --help`: `-j, --job string   View a specific job ID from a run`）ので、ジョブ名では引けない。次のどちらかを使う。

     ```
     gh run list --workflow CI --branch <branch> --limit 5

     # A. ラン全体のログを取って MARKER で絞る（最も単純。これで足りる）
     gh run view <run-id> --log | grep -- "\[#20-probe\]"

     # B. ジョブ名からジョブ ID を解決してから絞る
     JOB=$(gh run view <run-id> --json jobs -q '.jobs[] | select(.name=="Integration tests") | .databaseId')
     gh run view --job "$JOB" --log | grep -- "\[#20-probe\]"
     ```

     **`gh run rerun` で撮り直した場合は `--attempt` を明示する**（`gh run view` は既定で最新 attempt を見るため、1回目と2回目のログを取り違えないように）:

     ```
     gh run view <run-id> --attempt 2 --log | grep -- "\[#20-probe\]"
     ```

     取れた JSON（`G-0` / `SHA-512@210000` / `SHA-256@600000` / `SHA-256@210000`）と**ワークフロー実行 URL**（`gh run view <run-id> --json url -q .url`）を控える（AC-1）。URL はステップ8で ADR-003 に載せる — 実行ランナーの個体は後から実行ログの `Set up job` セクションで辿れるので、これが「どのハードウェアで測ったか」の記録になる
- **理由:** 再測定の唯一の目的は「x86 では SHA-NI が SHA-256 だけを加速して比が反転するか」であり、**ローカル（Apple Silicon / ARM）はこの問いに構造的に答えられない**。しかも M シリーズは ARMv8.2 の FEAT_SHA512 を持ちうるため、ローカル実測は **SHA-512 に系統的に有利な方向へ偏る**。`ubuntu-latest` は x86_64 で、SHA-256 はハードウェア加速され、SHA-512 の x86 命令拡張（Zen 5 / Arrow Lake 以降）を持つ個体が標準ランナーに含まれる見込みは低い。つまり **CI は案 A にとって保守側（不利側）の条件**であり、そこで案 A が勝つなら Cloudflare の実機でも成立する側に倒れる。ローカルに残す役目は G-0 だけで、それは先行実測で既に通過している
- **失敗時の扱い:**
  - **万一 G-0 が不成立だった場合（`results["G-0"].supported === false`）はここで打ち切る。** 先行実測では通過しているので想定していないが、ゲートの行である以上経路は残す — ステップ2 のゲート表 G-0 に当たって**案 B 確定**。CI 実測は行わず、例外の `name` / `message` を控えてステップ3へ進む
  - **タイムアウトで落ちた場合は G-0 ではない。** `TIMEOUT_MS`（120 秒）を超えたということなので、`SAMPLES` / `BATCH` を落として再測する。**タイムアウトを「SHA-512 が通らない」と読み替えて案 B を確定してはならない** — G-0 の不成立は try/catch が例外を捕まえて `results["G-0"].supported === false` を記録した場合だけ成立する
  - **`expect(median).toBeGreaterThan(0)` で赤くなった場合**（＝ REPORT 以外にも赤があり、その値の中央値が 0）は R-2（時計が進んでいない）。`BATCH` を 20 → 50 と上げて再測する（`TIMEOUT_MS` の 120 秒に収まる範囲で）。**それでも 0 なら計測失敗であって「速い」ではない** — これはステップ2 のゲート表の **G-0b** に当たり、案 B が確定する。`BATCH` をどこまで上げたか（＝上限）と 0 の事実を控えてステップ8-3 に記録する。ゲートの外で決める経路にはしない。**なおこれは CI ランについての記述である**（G-0b の入力は CI 実測に限る。ステップ2「入力の定義」）
  - **CI ジョブが 15 分でタイムアウトした場合**は `SAMPLES` / `BATCH` を落として再 push する。ワークフローの `timeout-minutes` は変更しない

### 2. 判定ゲートを適用して案 A / 案 B を確定する

- **対象ファイル:** なし（この PR の設計判断。結果はステップ8で ADR-003 に、根拠は `.thread/20/adr.md` ADR-001 に記録する）
- **変更内容:** ステップ1の実測値を次のゲートに機械的に当てはめる。

  **入力の定義**（ここ以外の数値を判定に使わない）:

  - `t_A` = **CI 実測**の `SHA-512 @ 210,000` の1導出あたり中央値
  - `t_B` = **CI 実測**の `SHA-256 @ 600,000` の1導出あたり中央値
  - G-0 の可否は**ローカル実測**でよい（疎通は ISA に依存しない）。**ステップ1 の先行実測で既に通過している**。ローカルの所要時間は判定に使わない
  - **G-0b の入力は CI 実測に限る** — 「CI ランで `BATCH` を上限まで上げても中央値が `0`」という観測そのもの（ステップ1「失敗時の扱い」）。**ローカル実行では G-0 の行だけを読み、`median > 0` のアサーションが赤くなっても無視してステップ1-4（CI）へ進む**。先行実測でローカルの時計は進むことが確認済みなので、ローカルの 0 は環境固有のノイズであって案を確定させる入力ではない
  - 4本目の `SHA-256 @ 210,000`（`t_now`）は**判定に使わない**。ADR-003 の 16ms / ADR-033 の 33ms との連続性の確認と R-6 の増分見積もり専用である

  | # | 条件 | 判定 |
  |---|---|---|
  | G-0 | `deriveBits({ hash: "SHA-512", iterations: 210_000 })` が例外になった（プローブが `supported=false` を出力した） | **案 B** |
  | G-0b | `BATCH` を上限まで上げても中央値が `0` のまま（ステップ1「失敗時の扱い」の再測を尽くした） | **案 B** |
  | G-1 | `t_A ≤ 2.0 × t_B` | **案 A** |
  | G-2 | 上のいずれにも当てはまらない（＝ `t_A > 2.0 × t_B`） | **案 B** |

  **この表がゲートの全文である。行は上から順に評価し、最初に一致した行で確定して以降を評価しない。表の外に追加条件を置かない。**

  **全域性**（ゲートである以上、入力の全域で答えが決まる必要がある）: G-0 と G-0b は `t_A` / `t_B` が取れない世界を先に吸収する。そこを抜けた時点で `t_A` / `t_B` は `expect(median).toBeGreaterThan(0)` により**正の実数**であり、`2.0 × t_B` は常に定義される。任意の正の実数 `t_A` / `t_B` は `t_A ≤ 2.0 × t_B` か否かのどちらか一方に必ず属するので、G-1 / G-2 は網羅かつ排他である。**未定義になる入力は無く、ゲートの外で案を決める経路も無い**（除算を使わないので `t_B = 0` による未定義も生じない）。

  **観測項目（判定には使わない）:** どちらの案でも `t_A` / `t_B` の中央値が **100 ms** を超えた場合は、その数値をステップ8-3 で ADR-003 の実測節に記録し、完了報告にも載せる。**ただし案の選択は変えない。** 絶対上限を判定ゲートに置かない理由は `.thread/20/adr.md` ADR-001（要点: このスコープでは上限に触れても取れる行動が「案 B を選ぶ」しかなく、そこでは相対比較が既に案 B を選んでいるので上限は判定に一度も寄与しない。加えて 100 ms は Apple Silicon 由来の数字なので、`ubuntu-latest` の実測に絶対値として当てると案がランナー速度で決まってしまう）。重さそのものが問題なら**別 Issue**として起票する（本 Issue では扱わない）。

  **ノイズが結論を決めていないことの確認**（これも機械的に判定する）:

  - 判定を反転させる線は **`2.0×` の1本だけ**なので、ノイズ確認もその近傍だけを見る。`t_A / t_B` が **2.0 の ±10%（1.8〜2.2）** に落ちた場合だけ、**CI をもう一度実行して2回目の中央値で判定し直す**（`gh run rerun <run-id>` → ステップ1-5 の `--attempt 2` で回収）。2回目も同じ判定なら確定、割れたら**案 B**（比がしきい値に張り付いており案 A の優越が示せていないため）
  - **これ以外は再実行しない。** レンジ（`[min, max]`）の重なりも発火条件にしない — 重なるのは `t_A ≈ t_B`（比 ≈ 1.0）のときで判定線から遠い。先行実測の比が 0.97〜0.99 である以上、この再実行経路が発火する見込みは低い。min / max は記録として ADR-003 に残す
  - **G-0b で確定した場合は `t_A` / `t_B` が存在しないので、ノイズ確認は適用対象外**

  **しきい値の根拠**（実装者が変えてよい数字ではない。変えるなら `.thread/20/adr.md` ADR-001 を書き直す）:

  - **`2.0×`** — **これは価値判断であって、実測から導かれる数字ではない**: 「SHA-512 の GPU / ASIC 耐性を買うために、ログイン1回あたりのサーバー CPU コストを**最大 2 倍まで**許容する」。既知の実測（Issue 本文の Node 24 / Apple Silicon が比 `0.82`、ステップ1 の先行実測が workerd / Apple Silicon で比 `0.97〜0.99`）はいずれも案 A 有利であり、このゲートが備えているのは x86 の SHA-NI が SHA-256 だけを加速して比が反転するケースである。**「同じ予算を SHA-256 の反復回数の上乗せに回すほうが有利」という対案を根拠にはしない** — その選択肢は plan.md「含まれないもの」で明示的にスコープ外にしてあり、選べない対案を根拠にしたしきい値は後から読むと理由が成立しないため
  - **これがゲートに載る唯一のしきい値である。** 比は同一ランの中で取った2つの数字の比なので、測定環境の速さが約分されて消える。絶対値のしきい値にはその性質が無い
- **理由:** 実装者が実測を見て主観で選ぶ余地を残さないため。AC-2 は「確定した」ことではなく「実測値とゲートの行番号の対応として説明できる」ことを求めている

### 3. プローブを撤去し、（案 A なら）旧形式フィクスチャを先に採取する

- **対象ファイル:** `packages/core/src/application/identity/__tests__/_probe.integration.test.ts`（削除）
- **変更内容:**
  1. ファイルを1つ消す（AC-3）。**設定ファイルには最初から手を入れていないので、戻すものは無い**（`git diff vitest.config.integration.ts .github/workflows/ci.yml` が空であることをここで一度確認しておく）
  2. **【案 A が確定した場合のみ】** ステップ6-9 の旧形式リグレッションテストに埋め込むフィクスチャを、**まだ現行実装が `pbkdf2-sha256$` を書き出せるこの時点で**採取する。**ステップ5でアダプターの方式を差し替えると、この形式を書き出す経路がコード上から消える**ので、順序どおり進めた実装者がステップ6 で生成手段を失わないようにここで採る（`git stash` や旧リビジョンの checkout で復旧はできるが、それを前提にしない）。

     - **採り方:** `pbkdf2PasswordHasher.test.ts` に一時的なテストを1件足し、**同ファイルに既にある `hasher`（`iterations: 1_000`）と `PASSWORD`** で `await hasher.hash(PASSWORD)` した結果を **`throw new Error(...)` に載せて**出力させ、`pnpm test:unit packages/core/src/adapters/webcrypto` を1回回す。**`console.log` は使わない** — ステップ1-1 と同じ理由（暗黙の既定レポーターが握り潰す）で読めない。採取したらその一時テストは消す。リポジトリにスクリプト実行の口は無く、`hash()` は `PlainPassword`（ブランド型）を取るので素の文字列も渡せない以上、これが最短の実行手段である
     - **控えるのは「出力文字列」と「その平文」の2つ。** ステップ6-9 のリグレッションテストは `verify(<この平文>, <採取したフィクスチャ>) === true` を固定するので、平文（`PASSWORD` ＝ `password123`）が分からないとフィクスチャが使えない
- **理由:** 実測値はステップ8で ADR-003 に文章として（CI 実行 URL 付きで）残るので、プローブを残す理由が無い。本 Issue は「webcrypto アダプターの統合テスト」という恒久の受け皿を作る決定をしていない。フィクスチャの採取をここに置くのは、ステップ4以降が依存方向の内→外に並ぶのに対し、この作業だけは**時間方向の前提**（旧実装がまだ生きていること）を持つため

---

**ここから先は確定した案によって分岐する。ステップ4以降は依存方向の内側（application）から外側（adapters → tests → docs）の順に並ぶ。**

### 4. 【案 A】ダミーハッシュ側の定数をアルゴリズムまで含めて宣言する

> 案 B の場合はこのステップを飛ばし、ステップ5の【案 B】へ進む。

- **対象ファイル:** `packages/core/src/application/identity/loginWithPassword.ts`
- **変更内容:**

  1. `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を新設して export する。

     ```ts
     export const DUMMY_PASSWORD_HASH_ALGORITHM_ID = "pbkdf2-sha512";
     ```

     JSDoc に「`DUMMY_PASSWORD_HASH_ITERATIONS` と同じ理由でここに在る — 出荷ハッシャーの `ALGORITHM_ID` がこの定数へ `typeof` でピン留めされており、片方だけ動かすとコンパイルが通らない」ことを書く
  2. `DUMMY_PASSWORD_HASH` をこの定数から組み立てる。**salt と derived の base64 はそのまま流用する**（JSDoc が明言するとおり任意のバイト列で、長さも 16 / 32 byte で既に正しい）

     ```ts
     const DUMMY_PASSWORD_HASH =
       `${DUMMY_PASSWORD_HASH_ALGORITHM_ID}$${DUMMY_PASSWORD_HASH_ITERATIONS}$IPASLZIobSfU953IiVIH2Q==$A5VaiykJ+nWoXmrMVC5ewoE8QX2KddgLOL5qBfMJSRA=` as PasswordHash;
     ```

     `DUMMY_PASSWORD_HASH` の JSDoc「Only the declared cost has to be current」も「宣言されたアルゴリズムとコストの2つが現行であればよい」に直す
  3. `DUMMY_PASSWORD_HASH_ITERATIONS` の JSDoc に、ピンがアルゴリズム側にも掛かったことを追記する
- **理由:** R-3 の直接の対策。案 A は反復回数を動かさないので、既存の反復回数ピンでは取り残しを検出できない。ダミーが取り残されたまま `pbkdf2-sha256$` 分岐を残すと、**古いダミーは parse も verify も成功して警告ラッチすら発火せず、タイミングオラクルが無音で復活する**。application 層に置くのは、依存方向を `adapters → application`（内向き）に保つため

### 5. アダプターの方式を差し替える

- **対象ファイル:**
  - `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`（案 A / 案 B 共通）
  - `packages/core/src/application/identity/loginWithPassword.ts`（**案 B のみ** — 案 A ではダミー側の編集はステップ4で済んでいる）

#### 【案 B】の場合

- **変更内容:**
  1. `DEFAULT_PBKDF2_ITERATIONS` を `600_000` に、`loginWithPassword.ts` の `DUMMY_PASSWORD_HASH_ITERATIONS` も `600_000` にする。**型ピンがあるので片方だけ変えるとコンパイルが通らない**（この2つは同じコミットで動かす。AC-8 を案 B 経路で満たすのはこの1項目）
  2. JSDoc 14-15 行を「OWASP's recommendation for PBKDF2-HMAC-SHA256」＝ 600,000 と正しく書き直す。`210_000` は SHA-512 の行の数字だった旨を残す必要は無いが、**なぜ 600,000 なのか（どの行の数字か）を明記する**。**OWASP の表の2つの数字は防御側の所要時間がおおむね揃うようにキャリブレートされたものだ、という以上の意図を OWASP に帰属させない**（`.thread/20/adr.md` ADR-001 Context）

     **訂正（2026-08-07 / #20 レビュー round 2）— この項目の「キャリブレートされたもの」という前提は誤りである。** そもそも案 A が確定したので【案 B】のこのステップは実行していないが、指示としては次の項目5・ステップ8-1 と同じ誤りを含んでいる。採るべき言い回しは `.thread/20/adr.md` ADR-001 Context（「**ただし『各アルゴリズムで防御側の所要時間が揃うようにキャリブレートされている』という言い方も採らない**」）と `.thread/1/adr.md` ADR-003 の訂正ブロック（「チートシート自身はこれらの設定を（防御側にとって）等価な選択肢として並べているだけで、…という説明は我々の読みであり、出典の文言ではない」）にある。**この手順書を将来引く読み手は、キャリブレーションの断定を書き戻さないこと。**
  3. `ALGORITHM_ID` / `derive()` / `parse()` / `DERIVED_BITS` は無変更
  4. ダミーの salt / digest も無変更（`verify` は保存値が宣言したコストで導出するため）
- **理由:** SHA-256 のまま OWASP 推奨のコストへ揃える。変更が定数に閉じる

#### 【案 A】の場合

- **変更内容:**
  1. 読み取り経路（部分関数）と書き出し経路（全域）を分ける。**対応表は持たない。**

     ```ts
     import type { DUMMY_PASSWORD_HASH_ALGORITHM_ID } from "@repo/core/application/identity/loginWithPassword";

     /**
      * 読める識別子 → WebCrypto の hash 名。`null` は「読めない識別子」。
      * `pbkdf2-sha256` は #20 以前に書かれた行のために残す読み取り専用の枝で、書き手はもう居ない。
      */
     export const hashFor = (algorithm: string): "SHA-256" | "SHA-512" | null =>
       algorithm === "pbkdf2-sha512"
         ? "SHA-512"
         : algorithm === "pbkdf2-sha256"
           ? "SHA-256"
           : null;

     /** 書き出す識別子は常にこの1つ。ダミーハッシュの識別子へピン留めする。 */
     export const ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID = "pbkdf2-sha512";

     /** `hash()` が WebCrypto へ渡す hash 名。`hashFor()` を引かないので `null` が書き出し経路に現れない。 */
     const SHIPPED_HASH = "SHA-512" as const;
     ```

     **`hashFor` と `ALGORITHM_ID` はどちらも `export` する。** ステップ6-7 / 6-10 のアダプター単体テストが両方を直接呼ぶため、export が無いとテストがコンパイルできない。**「テストのためだけに export を増やす」ことの是非はステップ6-10 の判断に従い、`hashFor` にも同じ理由が及ぶ** — 検査したいのは「アダプターが書き出す／読める識別子」というアダプター内部の対応関係であり、既存の `DEFAULT_PBKDF2_ITERATIONS` が同じ理由で export されている前例がある。

     **`Map` / 素の object の表引きにしない**（R-5）。素の object を `obj[algorithm]` で引けば `constructor` などプロトタイプ由来のキーが真値を返して拒否をすり抜けるし、`Map.get()` にすればそれは塞げても戻り値に `undefined` が乗り、**それを `hash()`（書き出し）が引く時点で書き出し経路まで部分関数になる** — 「読める形式は複数・書く形式は1つ」という非対称が型から消え、起こり得ない `undefined` に `!` / `??` / throw を書くことになる。方式は2つしかないので、全域な `hashFor()` と直参照の `SHIPPED_HASH` で両方を構造的に消す
  2. `derive(plain, salt, iterations, hash: "SHA-256" | "SHA-512")` に引数を1つ足し、`crypto.subtle.deriveBits` の `hash` へ渡す
  3. `StoredHash` に `hash: "SHA-256" | "SHA-512"` を足し、`parse()` が `hashFor()` の結果を詰める。**`null` なら既存の「not in a recognised encoding」と同じ `SystemError(DataIntegrityError)`**（`CLAUDE.md`「Input validation」の第2境界とエラー契約を崩さない）
  4. `hash()` は `SHIPPED_HASH` を、`verify()` は `stored.hash` を `derive` へ渡す。**`hash()` は `hashFor()` を呼ばない**
  5. `DEFAULT_PBKDF2_ITERATIONS` は `210_000` のまま。**JSDoc 14-15 行の帰属を直す**（数字ではなく「どの行の数字か」が誤っていた）: 210,000 は OWASP Password Storage Cheat Sheet（2023 版）の **PBKDF2-HMAC-SHA512 の行**の数字である。**「OWASP が SHA-512 の反復回数を低く設定したのは GPU / ASIC 耐性のためだ」とは書かない** — 表の2つの数字は防御側コストがおおむね揃うようにキャリブレートされたもので、SHA-512 は1反復あたりの CPU コストが高いから回数が少ない。GPU / ASIC 耐性は**我々が SHA-512 を選ぶ理由**であって OWASP の設定理由ではない（`.thread/20/adr.md` ADR-001 Context。ここで誤帰属を書くと、本 Issue が是正している取り違えを形を変えて再生産する）

     **訂正（2026-08-07 / #20 レビュー round 2）— 「表の2つの数字は防御側コストがおおむね揃うようにキャリブレートされたもの」を事実として書け、という上記の指示は誤りである。** この指示に忠実に従った結果、`pbkdf2PasswordHasher.ts` の JSDoc に `the table calibrates each algorithm to roughly the same defender cost` が入り、round 2 の Blocker になった。キャリブレーションという説明は**出典の文言ではなく我々の読み**であり、`.thread/20/adr.md` ADR-001 Context がそれを「**その言い方も採らない**」と名指しで退けている（`.thread/1/adr.md` ADR-003 の訂正ブロックも同じ — 「チートシート自身はこれらの設定を（防御側にとって）等価な選択肢として並べているだけ」）。**書いてよいのは「1反復あたりの CPU コストがこの順に高くなるから回数がこの順に少ない」までで、それを超える意図を OWASP に帰属させない。** GPU / ASIC 耐性を我々の採用理由として書き分ける点（上記後半）は正しく、そのまま有効である。
  6. **`DEFAULT_PBKDF2_ITERATIONS` の JSDoc 22-24 行を訂正する。** 「nothing else in the dummy needs regenerating, since `verify` derives at whatever cost the stored value declares」はコスト変更でのみ成立する主張で、アルゴリズム変更では成立しない。アルゴリズム識別子も別の `typeof` ピンで覆われたこと、salt と digest だけが任意のままであることに書き換える
  7. 同 JSDoc 26-28 行の残余チャネルの記述を「an earlier cost」から「an earlier cost **or algorithm**」に広げる。旧 SHA-256 の行に対する誤パスワードは新しいダミーより**安い**ので、既存の記述と同じ向きの残差である。**この記述には対がある** — `.thread/1/adr.md:1221`（ADR-034）が「この限界は `DEFAULT_PBKDF2_ITERATIONS` の JSDoc と `progress.md` に書いた」と明記しているので、**ステップ9で `.thread/1/progress.md` 9-13 行を同じ広がりで直すまでがこの項目**。片方だけ広げると対が壊れる
  8. `createPbkdf2PasswordHasher` の JSDoc（138-150 行）の「PBKDF2-HMAC-SHA256」「`pbkdf2-sha256$…`」を新形式へ直し、**「読める形式は複数・書く形式は1つ」であることと、`pbkdf2-sha256` が読み取り専用の枝であること**を明記する
  9. 仕上げに `grep -n "SHA-256\|SHA256\|sha256" packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` を流し、**残ったヒットが `hashFor()` の旧読み取り枝とその説明だけ**であることを確認する（AC-15。案 A では訂正箇所が 14-15 / 22-24 / 26-28 / 138-150 の4箇所に散っており、基準が無いと取りこぼす）
- **理由:** ADR-003 が謳っていた「識別子付きエンコードによる無停止移行」を初めて行使する変更。旧枝を残す判断の根拠は `.thread/20/adr.md` ADR-002

### 6. アダプター単体テストを更新する

- **対象ファイル:** `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`
- **変更内容:**

  **両案共通:**
  1. `it("defaults to the OWASP iteration count")`（88-90 行）を**方式と反復回数を組にして述べる名前**へ直す。例: `it("defaults to the OWASP count for the algorithm it ships")`。期待値は確定した反復回数。**アルゴリズムも同じテストで確認する**（`hash()` の出力の先頭フィールド）ことで、名前と期待値が再びずれない形にする（AC-10 / **AC-4 の「表明がアダプター単体テストに置かれている」を満たすのはこの1件**）
  2. 23-25 行のコメント「Production strength is 210k iterations」を確定した方式と値の組へ直す（AC-10）
  3. `it("takes the OWASP default when given no argument")`（157-160 行）のテスト名の「OWASP default」も同様に扱う（AC-10）。

      1〜3 の仕上げに `grep -n "OWASP\|210k" packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts` を流し、**残ったヒットが確定した方式と組になった記述だけ**であることを確認する（AC-10。訂正箇所が 23-25 / 88-90 / 157-160 の3箇所に散っているので、基準が無いと取りこぼす）
  4. `expect(atob(derived ?? "")).toHaveLength(32)`（59 行）は**変更しない**（AC-5）

  **案 A のみ:**
  5. `expect(algorithm).toBe("pbkdf2-sha256")`（55 行）→ `"pbkdf2-sha512"`
  6. `it.each` の拒否ケース表（92-111 行）の `pbkdf2-sha256$` フィクスチャを `pbkdf2-sha512$` に置換する。**ただし `["unknown algorithm", "argon2id$…"]` はそのまま**
  7. 拒否ケースに **`["prototype key as algorithm", "constructor$1000$c2FsdA==$aGFzaA=="]` を追加する**（R-5 / AC-6）。全域な `hashFor()` ではこのケースは実装上そもそも通らないが、**AC-6 の検証点として、また将来 `parse()` が表引きに戻ったときの回帰網として残す**（実装が `hashFor` / `Map` / `Object.hasOwn` のどれでも同じ基準で検証できる）

      あわせて **書き出し識別子と書き出し hash 名の対応を、リテラルで1件固定する**（AC-6）。

      ```ts
      expect(ALGORITHM_ID).toBe("pbkdf2-sha512");
      expect(hashFor("pbkdf2-sha512")).toBe("SHA-512");
      ```

      **`expect(hashFor(ALGORITHM_ID)).toBe(SHIPPED_HASH)` の形は採らない** — 両辺を検査対象の定数から組み立てているので、2つがそろって別方式へずれた場合に通ってしまう。これはステップ7-1 が「定数から組み立てると自己言及になり検証力を失う」として自ら禁じている書き方そのものである。なお**この食い違いは無音ではない**: `hash()` が書いた値を `verify()` が別のダイジェストで導出することになり、既存の `it("verifies a password it hashed")`（32-35 行）が必ず落ちる。したがって検出は「型ピン＋往復テスト」の二層で押さえられており、このリテラル検証はその意図を読み手に見せる3層目である

  8. 「ceiling」テスト（180 行）のフィクスチャも `pbkdf2-sha512$` に
  9. **旧形式のリグレッションテストを新設する**（AC-7）。`pbkdf2-sha256$<低コスト>$<salt>$<derived>` をハードコードしたフィクスチャで `verify` が `true` を返すことを固定する。**フィクスチャはステップ3-2 で採取済みのものを埋め込む**（ステップ5で旧形式を書き出す経路が消えているので、ここで生成しようとしても手段が無い）。**書き手が居なくなる形式なので、このテストが旧枝の唯一の生存確認になる**旨をコメントで書く
  10. `DEFAULT_PBKDF2_ITERATIONS` のピン検査（234-247 行）と**同じ形のアルゴリズム版**を足す。`// @ts-expect-error` + `const drifted: typeof ALGORITHM_ID = "pbkdf2-sha256";` 相当。**`ALGORITHM_ID` をアダプターから export して、アダプター側の値に対して検査する**（ステップ5【案 A】1 で `hashFor` ともども `export` を付ける）。`DUMMY_PASSWORD_HASH_ALGORITHM_ID` 側に検査を置く案は採らない — 検査したいのは「アダプターが書き出す識別子」であり、`ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID` と宣言されている以上、application 側の定数が将来 `: string` に広げられてもアダプター側の検査なら拾える。**「テストのためだけに export を増やす」ことの是非は、既存の `DEFAULT_PBKDF2_ITERATIONS` が同じ理由で export されている（`pbkdf2PasswordHasher.test.ts:235-240` のコメントがその理由を説明している）という前例に従う。この判断は `hashFor`（ステップ6-7 が呼ぶ）にもそのまま及ぶ。** ADR-001 が「実装者に主観の余地を残さない」ことを主題にしている以上、AC-9 の達成形を2つに割らない

  **案 B のみ:**
  11. **`@ts-expect-error` のドリフト対照値（244 行）を `600_000` 以外へ差し替える**（R-4 / AC-11）。`600_000` が正しい値になった以上、`@ts-expect-error` は抑制すべきエラーを失って typecheck を落とす。`210_000` など**現行値でない任意のリテラル**にし、なぜ「現行値でなければ何でもよい」のかをコメントに残す
- **理由:** Issue が「テスト名と期待値がまさに取り違えた主張を固定している」と指摘しているとおり、テストは誤りの共犯者になっている。単体テストが実アルゴリズムの権威（`docs/test.md`）なので、方式・形式・拒否ケースの固定はすべてここに集約する

### 7. identity 統合テストを更新する

- **対象ファイル:** `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- **変更内容:**
  1. 650 行の `new RegExp(\`^pbkdf2-sha256\\$${DEFAULT_PBKDF2_ITERATIONS}\\$\`)` のアルゴリズム部分を確定した識別子へ直す。**アルゴリズム名はリテラルで書く**（`ALGORITHM_ID` から組み立てると自己言及になり、ダミーの取り残しを検出できなくなる）
  2. 698 行の `/^pbkdf2-sha256\$1000\$/` も同様（案 A のみ）
  3. 642 行の `createPbkdf2PasswordHasher()`（引数なし＝本番強度）は**変更しない**。JSDoc 上のコメント「Production parameters, since it is the shipped hasher that has to survive the constant」がまさにこの Issue の検証点であり、コストを下げると検証力を失う
- **理由:** AC-8。このテストは「ダミーハッシュが本番ハッシャーに読める」ことを確かめる唯一の場所で、`burnVerificationTime` が throw を握り潰す以上、ここが赤くならないと取り残しに誰も気づけない

### 8. ADR-003 を訂正する

- **対象ファイル:** `.thread/1/adr.md` の `## ADR-003: パスワードハッシュ方式 — WebCrypto PBKDF2-HMAC-SHA256`（92 行〜）
- **変更内容:**
  1. **OWASP 引用の取り違えを訂正する**（112 行の「反復回数 210,000（OWASP の PBKDF2-SHA256 推奨）」）。210,000 は OWASP Password Storage Cheat Sheet（**2023 版**）の **PBKDF2-HMAC-SHA512 の行**の数字であり、SHA-256 の行は 600,000 であること。**訂正であることが読み取れるマーカー**（例: `**訂正（2026-08-07 / #20）**`）を付ける。
     **訂正文の書き方に条件がある**: この表の2つの数字は**防御側の所要時間がおおむね揃うようにキャリブレートされた**もので、SHA-512 は1反復あたりの CPU コストが SHA-256 より高いから回数が少ない、という事実として書く。**「OWASP が GPU / ASIC 耐性を理由に SHA-512 の回数を低く設定した」とは書かない** — その帰属は誤りで、ここでそれを書けば本 Issue が是正している取り違えを別の形で再生産する（`.thread/20/adr.md` ADR-001 Context / 4 の追記節が採用理由を書く場所）

     **訂正（2026-08-07 / #20 レビュー round 2）— 上記の条件のうち「キャリブレートされたもの、という事実として書く」の部分は誤りである。** 「GPU / ASIC 耐性を OWASP に帰属させない」という後半の条件は正しく、そのまま有効。誤っているのは**その代わりに置く説明としてキャリブレーションを事実の断定にした**点で、これは未出典の断定を別の未出典の断定に置き換えているにすぎない。実際に書かれた訂正文（`.thread/1/adr.md` ADR-003 の訂正ブロック）はこの指示に従わず「チートシート自身はこれらの設定を（防御側にとって）等価な選択肢として並べているだけで、『各アルゴリズムで防御側の所要時間が揃うようにキャリブレートした』という説明は我々の読みであり、出典の文言ではない」と書いており、**そちらが正しい**（`.thread/20/adr.md` ADR-001 Context が同じ判断を「その言い方も採らない」として明示している）。
  2. **CPU 予算の記述を訂正する**（155 行「無料プランで数十 ms」）。Free は **10ms**、Paid の既定は **30 秒**（#34 で CF Paid 確定）。同じ Consequences 行の「反復回数 210,000 は CPU 予算を超える可能性がある」という懸念そのものが、Paid 前提では成立しなくなっていることも書く
  3. **実測節（139-145 行）に workerd 再測定の結果を追記する。** 日付と Issue 番号を付けた小節にし、次を書く（AC-1 / AC-2）。**プローブの置き場所が今回は `packages/core/src/application/identity/__tests__/` であり、`:141` が記録している 2026-07-25 のプローブ（`adapters/webcrypto/__tests__/`）とは異なること、その理由（`.adr/001` 以降の `include` 許可リスト）**も1行添える。
     - **G-0**（`SHA-512 @ 210k` の疎通可否）。ステップ1 の**先行実測（ローカル workerd / Apple Silicon）で通過済み**である旨と、CI ランでも `supported=true` が出たこと。失敗した場合は例外の `name` / `message` も
     - **`t_A` / `t_B` の min / 中央値 / max**（CI 実測）と、参考の `SHA-256 @ 210k`。ADR-003 の 16ms / ADR-033 の 33ms との連続性にも触れる。**`G-0b` で確定した場合は、`BATCH` をどこまで上げたかと中央値が 0 だった事実**を代わりに書く
     - **測定環境**: GitHub Actions `ubuntu-latest`（x86_64）の `integration` ジョブ、**ワークフロー実行 URL**。ローカル（Apple Silicon）の数字を比較に使っていないこと、その理由（ARM は FEAT_SHA512 を持ちうるため SHA-512 に有利側へ偏る）も1行。**先行実測（ローカル workerd で比 0.97〜0.99）も参考値として併記し、CI 実測との差がそのまま ISA の効果である**ことが読めるようにする
     - **判定ゲートのどの行（G-0 / G-0b / G-1 / G-2）に当たって案が確定したか**。再実行して2回目で判定した場合はその旨も
     - **観測項目**: 中央値が 100 ms を超えた場合はその数値。**判定には使っていない**旨も明記する（`.thread/20/adr.md` ADR-001）
  4. **案 A の場合のみ**: 方式変更を**日付入りの追記節**として書く（Decision 本文を黙って書き換えない）。見出し（92 行）の「WebCrypto PBKDF2-HMAC-SHA256」も SHA-512 へ直し、保存形式（115 行）も `pbkdf2-sha512$…` に直したうえで、**旧形式が読み取り専用として残ること**を明記する。**SHA-512 を選んだ理由（64bit 演算主体で GPU / ASIC の並列効率が低い）はここに「我々の判断」として書く**。1 で OWASP に帰属させないのと表裏
  5. **`.thread/1/adr.md` 内の他 ADR の数字合わせ（案 B 限定ではない）。** `grep -n "210,000\|210_000\|210000\|pbkdf2-sha256\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256" .thread/1/adr.md` の実ヒットは **21 行**で、ADR-003 / 014 / 021 / 026 / 027 / 033 / 034 の7本に散っている。うち 1〜4 が `:92` / `:112` / `:115` / `:155` を扱う。**残りは1件ずつ triage せず、次の2つで閉じる。**

     - **(i) 訂正注記ブロックを1つ置く。** ADR-003 の冒頭（`:92` の見出し直下）に、日付と Issue 番号を付けた注記を1ブロック置き、**「本ファイル内で `210,000` / `pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` に言及する記述（ADR-003 / 014 / 021 / 026 / 027 / 033 / 034）は、下記 (ii) で本文を直した行を除き、いずれも #20 以前の事実・当時の決定であって現行値ではない。現行の方式と反復回数は ADR-003 の #20 追記節（上記 3 / 4）を見よ」**と宣言する。R-7 の書き分け規則（**当時観測した状況・当時下した決定そのもの**を述べる行は原文を残す）を1行ずつ個別のマーカーで表現する代わりに、ファイル単位で1回宣言する形にしたもので、得られる効果は同じ（残存ヒットが「歴史的記述である」ことが読み手に機械的に伝わる）。`.thread/1/adr.md` が `.adr/` へ昇格していない `Status: Proposed` の thread ローカル作業ログである以上、これで足りる

       **訂正（2026-08-07 / #20 レビュー round 3）— 上記 (i) が「こう宣言せよ」として掲げている文面は誤りである。** 一括宣言を1ブロック置くという方針そのものは正しく、そのまま有効。誤っているのは**宣言の中身**で、実際に置かれた注記（`.thread/1/adr.md` ADR-003 の見出し直下）は次の3点で上記の指示から外れており、**そちらが正しい**。**この手順書を将来引く読み手は、上記の文面のほうを書き戻さないこと。**

       - **`210,000` を「現行値ではない」の側に含めた点が誤り**（round 1 の Blocker）。#20 が動かしたのは**アルゴリズムだけ**で、**反復回数 210,000 は #20 の後も現行値である**。誤っていたのは「これが SHA-256 に対する OWASP の推奨である」という帰属だけなので、宣言の射程は**アルゴリズム識別子だけ**に掛かる
       - **ADR リストが実態より広い**（round 2 W-002）。方式名（`pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` / `PBKDF2-SHA256`）を実際に含むのは **ADR-003 / 014 / 026 / 027 / 034 の5本**で、**ADR-021 / 033 は該当ゼロ**である
       - **(ii) の表の書き分けは、最終的に「節の性格」で1本化した。** *Context / Decision*（当時の観測・当時の決定）を述べる行は**原文を残し括弧書きで現行値を添える**、*Consequences* など**今も有効な仕組み・今も参照される定義**を述べる行は本文を現行値へ直す、という規則である。したがって下表が「本文修正」と指示している ADR-026 Decision（`:961`）と ADR-034 Context（`:1200`）は、実際には括弧書きで実装されている。**例外は ADR-014 Context の `verify` 失敗の2分類**で、当時の観測ではなく今も有効な失敗分類の定義なので本文を直してある
     - **(ii) 索引として誤りになる行だけ本文を直す**（＝**今も有効な仕組み・今も参照される定義**を述べており、放置すると現在の設計の索引として偽になる行）。確定した案の列に印のある行を洗う。

       | 行 | ADR / 節 | 記述 | 案 A | 案 B |
       |---|---|---|---|---|
       | `:569` | ADR-014 / Context | 「保存済みハッシュが `pbkdf2-sha256$<iterations>$<salt>$<hash>` 形式として読めない」 | ● | — |
       | `:818` | ADR-021 / Consequences | 「`MIN_PBKDF2_ITERATIONS` は 210,000 に対して3桁低く」 | — | ● |
       | `:961` | ADR-026 / Decision | 「アダプターの本番パラメータ（**PBKDF2-HMAC-SHA256 / 210,000 回**）で生成した固定値」 | ●（方式名） | ●（回数） |
       | `:974` | ADR-026 / Consequences | 「アダプターの保存形式（`pbkdf2-sha256$...`）」 | ● | — |
       | `:1200` | ADR-034 / Context | 「`DUMMY_PASSWORD_HASH`（`pbkdf2-sha256$210000$…` の文字列定数）」 | ● | ● |
       | `:1211` | ADR-034 / Decision | 「ユースケース側に `DUMMY_PASSWORD_HASH_ITERATIONS = 210_000` を置き」 | — | ● |

     - **(iii) `:1186`（ADR-033 / Consequences「本番パラメータ 210,000 回でも workerd 上で 33ms」）だけは本文を残したまま相互参照を1行足す。** 当時の実測なので直すと事実のほうが偽になるが、**3 の新しい実測節と数字が直接ぶつかる**唯一の行なので、(i) の一括宣言に加えて個別に「#20 の実測節を見よ」を添える
     - 上記に現れない残存ヒット（`:108` / `:122` / `:130` / `:132` / `:141` / `:143` / `:144` / `:957` / `:995` / `:1212`）は**当時の事実・当時の決定として原文のまま残す**（(i) の宣言がこれらを覆う）。**特に `:141`**（2026-07-25 のプローブが `adapters/webcrypto/__tests__/` にあり `hash: "SHA-256", iterations: 210_000` を計測した記録）については、上記 3 の実測節が「今回のプローブは `application/identity/__tests__/` に置いた」こととその理由を書くので、そこが実質の相互参照になる
- **理由:** AC-12（(a)(b)(c) に加えて (d)）。Issue が明示的に要求している3点に加え、R-7（事実の訂正と決定の変更の書き分け）と R-8（同一ファイル内の数字の矛盾）を守る。R-8 が自ら立てた「同一ファイル内で数字が矛盾する状態を残さない」という規範は、残り 17 行を1件ずつ分類しなくても **(i) の一括宣言 + (ii) の6行 + (iii) の1行**で満たせる — 編集点が減っても AC-12 (d) の grep 検証は同じように機械的に通るので、Issue の規模に対して1件ずつの triage は過剰である
- **注意:** 訂正対象は **`.thread/1/adr.md`** であって、Issue 本文が書いている `.issue/1/adr.md` ではない（`.issue/` は存在しない）。またリポジトリルートの `.adr/003-sqlite-fts5-only-search.md` は FTS5 検索の無関係な ADR なので**絶対に触らない**

### 9. `.thread/1/progress.md` の生きた記述を2箇所更新する

- **対象ファイル:** `.thread/1/progress.md` の **82 行**と **9-13 行**
- **変更内容:**
  1. **82 行（spec-sync 記録 / `ADP-identity-012` の項）** — 「実装は WebCrypto PBKDF2-HMAC-SHA256（ADR-003）」の方式名を確定した方式へ直す。**「spec が『Argon2id 等』と例示するのに対し実装はこれ／spec がアダプター責務と明記しているため乖離ではない」という記録の趣旨は保つ**（この判断そのものは本 Issue で変わっていない）
  2. **9-13 行（「意図的にスコープ外とした項目 1. 旧コストの保存ハッシュが残る間の等時間化」）** — ここも過去のログではなく現在の残課題を語る生きた記述で、**アダプター JSDoc（ステップ5【案 A】6-7）と対になっている**（`.thread/1/adr.md:1221` が「この限界は `DEFAULT_PBKDF2_ITERATIONS` の JSDoc と `progress.md` に書いた」と明記）。片方だけ直すと対が壊れる。
     - **案 A の場合**: 11 行の「ダミーの反復回数は `DEFAULT_PBKDF2_ITERATIONS` と型で結ばれている（ADR-034）」を、ピンが**アルゴリズム識別子にも**掛かったこと（本 Issue の AC-9）へ広げる。「**引き上げ前に書かれた行は旧コストのまま**残る」も「旧コスト**または旧アルゴリズム**のまま残る」へ広げる。13 行「反復回数を一度も上げていない現状では差は生じない」は、**本番データが存在しない現時点では依然として真**だが、根拠が「一度も上げていない」から「本番に行が1つも無い」へ変わるので、そう書き直す
     - **案 B の場合**: 13 行「**反復回数を一度も上げていない現状では差は生じない**」が本 Issue で直接偽になる（210,000 → 600,000 に上げるため）。ここを「本番データが存在しないうちに上げたので、旧コストの行はそもそも生まれない」へ直す。11 行は反復回数の記述のみなので構造の変更は不要
- **理由:** AC-13。この2箇所は過去の作業ログではなく**現在の実装・現在の残課題についての生きた記述**なので、方式が変われば陳腐化する。82 行だけを生きた記述とする根拠は無い。同じファイル内の他の項目や `.thread/1/plan.md` / `.thread/1/review/*` / `.thread/1/plan-review/*` / `.thread/34/*` は当時の事実の記録なので触らない

### 10. 全体検証

- **対象ファイル:** なし
- **変更内容:**
  1. `pnpm typecheck` — **`@ts-expect-error` が「抑制すべきエラーが無い」で落ちないこと**を特に確認する（AC-11 / R-4）
  2. `pnpm lint:fix && pnpm format` のあと **`pnpm lint && pnpm format:check`** で確認する（CI の `lint-typecheck-unit` ジョブは Lint と Format check を別ステップで走らせるので、書き換え側だけを回すと AC-14 と CI のゲートが1対1にならない）
  3. `pnpm test:unit` / `pnpm test:integration`
  4. `git status` と `git diff --stat` で、`_probe.integration.test.ts` が**差分にもワークツリーにも現れないこと**、および `vitest.config.integration.ts` / `.github/workflows/ci.yml` の diff が**空**であることを確認する。あわせて、**プローブ撤去後の CI ランで `integration` ジョブが緑に戻っていること**を確認する（ステップ1-4 で意図的に赤くしたものが残っていない）（AC-3）
  5. 次の grep を流し、**残っているヒットを1件ずつ「意図的か」判定する**。

     ```
     grep -rn "pbkdf2-sha256\|210_000\|210,000\|210000\|210k\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256" \
       --include="*.ts" --include="*.md" \
       --exclude-dir=node_modules --exclude-dir=.git .
     ```

     **`--exclude-dir` は必須**（付けないとリポジトリ直下から `node_modules` を再帰し、出力が実用にならない）。**`210k` を選択肢に足してある**のは、`pbkdf2PasswordHasher.test.ts:23` のコメントがこの表記で、他のパターンではどれにも一致しないため（AC-10 の検証点が網の外に落ちる）。事前の棚卸しは次のとおりで、**これ以外のヒットが出たらその場で判断せず、上記の各ステップの取り残しを疑う**。

     **変更不要（`PasswordHasher` を通らない不透明フィクスチャ。ドメインは中身を解釈しないので出荷アルゴリズムが何であっても有効）:**

     - `packages/core/src/domain/identity/__tests__/valueObject.test.ts:111-112` — `pbkdf2-sha256$1$c2FsdA==$aGFzaA==`
     - `packages/core/src/domain/identity/__tests__/entity.test.ts:17` — 同上
     - `packages/core/src/domain/identity/__tests__/entity.test.ts:164` — `pbkdf2-sha256$2$c2FsdA==$bmV3aA==`（`$1$` ではなく `$2$`。`MIN_PBKDF2_ITERATIONS` を下回るが、`PasswordHash.create` は形式しか見ないので問題にならない）
     - `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts:15` — `pbkdf2-sha256$1$c2FsdA==$aGFzaA==`
     - `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts:19` — 同上

     **変更不要（当時の事実の作業ログ。遡って書き換えない。plan.md「含まれないもの」）:**

     - `.thread/1/plan.md` / `.thread/1/review/*` — Issue #1 当時の計画・レビュー
     - `.thread/1/plan-review/*` — **`round-1-arch-risk.md`（6件）/ `round-1-coverage.md`（2件）/ `round-2-coverage.md`（1件）の計9件**。Issue #1 当時の計画レビュー。棚卸しに載っていないと必ず立ち止まりを生むので明示する
     - `.thread/34/adr.md`（`:796` / `:2587`）/ `.thread/34/design.md:706` — #34（DO 移行設計）が `PBKDF2 210,000 回` を当時の前提として引いている箇所
     - `.thread/20/*` 自身（本計画・レビュー・ADR。案の記述として 210,000 / 600,000 / `pbkdf2-sha256` を大量に含む）

     **意図的に残るヒット:**

     - **両案共通:** ステップ8-5 (i) の訂正注記ブロックが覆う `.thread/1/adr.md` の歴史的記述
     - **案 A の場合:** `pbkdf2PasswordHasher.ts` の `hashFor()` の旧読み取り枝とその JSDoc / 旧形式リグレッションテストのフィクスチャ（ステップ6-9）/ 拒否ケース表の旧形式フィクスチャ
     - **案 B の場合:** `.thread/1/progress.md:82` — ステップ9-1 で方式名を確定した方式へ直した結果、案 B では `PBKDF2-HMAC-SHA256` が**正しい記述として残る**

     **`.thread/1/adr.md` を grep の対象に必ず含める**（ステップ8-5 の答え合わせになる。**既知のヒットは 21 行**なので、それ以外が出たら取り残しである。AC-12 (d)）

     なお `.thread/36/*` は**現在ヒット0**なので棚卸しに載せない（実 grep で確認済み）。

     なお `docs/test.md:37` は `PBKDF2` / `createPbkdf2PasswordHasher` を含むが、**上記パターンのどれにも一致しない**（反復回数もアルゴリズム識別子も書いていない）ので陳腐化しない。棚卸しに載せる必要も無い
- **理由:** 本 Issue の変更は「取り残しが型検査でもテストでも赤くならない」箇所（R-3）を含むため、grep による総ざらいを最後に置く。棚卸しを先に書いておくことで、突き合わせが機械的に済む（実装者がその場で `$1$` や `$2$` を見て判断し直さずに済む）
