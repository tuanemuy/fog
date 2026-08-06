# レビュー2周目 — Test 観点

**対象:** PR #53 / `issue/20/pbkdf2-cost-parameters`（HEAD `825b700`）
**方針:** ゼロベース。round 1 の指摘内容は前提にせず、最終状態のみを見る。

**検証環境の注意:** レビュー中、作業ツリーが他エージェントによって断続的に書き換えられていた（`git status` が数秒単位で変動）。変異注入は衝突を避けるため `git worktree` で分離したコピー（`node_modules` は symlink で共有）に対して実施し、最後に `git worktree remove` / `prune` で撤去した。本リポジトリの作業ツリーには一切書き込んでいない（この review ファイルを除く）。

---

## Test

### Blockers

なし。

### Warnings

- **[W-001]** プローブ撤去後の CI ランが1度も完了しておらず、AC-3 の最後の条件が現時点で満たせていない
  - 場所: `.thread/20/plan.md:24`（AC-3）/ ブランチ `issue/20/pbkdf2-cost-parameters` の CI 実行履歴
  - 理由: AC-3 は「**プローブ撤去後の CI ランで `integration` ジョブが緑に戻っている**（プローブ入りのコミットでは REPORT テストが故意に失敗するため赤くなるのが想定内であり、その赤が残っていないこと）」を要求している。実際のランは次の2件しかない。
    - `3144e15`（プローブ入り）→ `completed / failure`（run `31121514993`）。これは想定内の赤。
    - `e5894bd`（プローブ撤去・SHA-512 化）→ **`queued` のまま**（run `31125267563`、2026-08-06T18:10 に作成されて以降ステータス変化なし）。

    さらに `a4d1138`（レビュー1周目反映）と `825b700`（testing.md 修正）にはランが1件も紐付いていない。つまり**このブランチで最後に完了した CI ランは赤のまま**で、AC-3 の「その赤が残っていないこと」は書面上まだ閉じていない。コードの欠陥ではなく CI キューの問題（ランナー確保失敗は attempt 3→4 の再実行でも起きている）だが、AC としては未達である。
  - 提案: `gh run rerun 31125267563` もしくは HEAD への空 push で `integration` ジョブを1回完走させ、緑になったランの URL を完了報告（またはステップ10 の記録）に残す。ローカルでは `pnpm test:unit`（417 pass / 24 files）・`pnpm test:integration`（104 pass / 9 files）・`biome check`・`biome format` がすべて通ることは本レビューで確認済みなので、残るのは x86_64 での1回の完走だけ。

- **[W-002]**（低優先度）`identity.integration.test.ts` のコメント「this is the only check left standing」が方向を限定していない
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:648-652`
  - 理由: 変異注入で確かめた結果、この文が正しいのは **ダミー側（application 層の定数）が単独でずれた場合**だけである。
    - 変異 M7（アダプターの `: typeof …` 注釈を落とす + `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `"pbkdf2-sha256"` へ）→ typecheck 緑・**unit 87件すべて緑**・この統合テスト1件だけが赤。文の主張どおり。
    - 変異 M9（同注釈を落とす + `DUMMY_PASSWORD_HASH_ITERATIONS` を `220_000` へ）→ 同じくこの1件だけが赤。
    - 変異 M8（同注釈を落とす + アダプター側 `ALGORITHM_ID` を `"pbkdf2-sha3"` へ）→ **unit 10件が赤**、統合側はこの検証ではなく `TC-loginWithPassword-009` の `/^pbkdf2-sha512\$1000\$/` が赤。つまりアダプター側のドリフトはこの行では捕まらないし、捕まる必要もない。

    カバレッジの穴ではない（両方向とも別のテストが確実に捕まえる）。ただし無限定に「the only check」と読むと、アダプター側のドリフトも本行が守っていると誤解しうる。なお `pbkdf2PasswordHasher.test.ts:316-328` の3層コメントのほうは正しく限定されている。
  - 提案: 「the only check left standing **for the dummy's own drift** once the adapter's `: typeof …` pin is dropped」程度に一語足すだけでよい。優先度は低い。

---

## 検証の詳細（記録）

### 1. Golden vector の独立再計算

`node:crypto` で自前に再導出し、両フィクスチャとも**バイト一致**を確認した。

| フィクスチャ | 場所 | `pbkdf2Sync("password123", salt, 1000, 32, …)` |
|---|---|---|
| `pbkdf2-sha256$1000$5faRif…$6hroV6…` | `pbkdf2PasswordHasher.test.ts:113` | `"sha256"` で一致 / `"sha512"` では不一致（`Wa/Q1Ufv…`） |
| `pbkdf2-sha512$1000$xV4JrR…$i5P8QP…` | `pbkdf2PasswordHasher.test.ts:132` | `"sha512"` で一致 / `"sha256"` では不一致（`vRCtX0Mo…`） |

したがって申告（「`node:crypto` で独立生成」「SHA-256 導出とは異なることを確認済み」）はどちらも**事実**であり、2件とも**ダイジェストを識別する力を持つ**（枝を取り違えれば必ず落ちる）。salt はどちらも 16 byte、derived は 32 byte で `DERIVED_BITS = 256` の据え置きとも整合する。

出荷形式の fixture が round-trip（`hash()` → `verify()`）と独立に置かれている点も妥当で、コメントが挙げる「pepper / 正規化 / 別のテキストエンコーディングの混入は round-trip では見えない」という理由づけは正しい（`hash` と `verify` が同じ `derive()` を共有しているため）。

### 2. 型ピン2本の変異注入（`packages/core` の `tsgo` 単体で判定）

| # | 変異 | 期待 | 実測 |
|---|---|---|---|
| M1 | `DUMMY_PASSWORD_HASH_ITERATIONS: number` に広げる | typecheck 赤 | **赤**（exit 2） |
| M2 | アダプターの `DEFAULT_PBKDF2_ITERATIONS` から `: typeof …` を外す | 緑（コメントの主張どおり「射程外」） | **緑** |
| M3 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: string` に広げる | typecheck 赤 | **赤**（exit 2） |
| M4 | 同定数を `"pbkdf2-sha512" \| "pbkdf2-sha256"`（＝読める側の union）に広げる | typecheck 赤 | **赤**（exit 2） |
| M5 | アダプターの `ALGORITHM_ID` から `: typeof …` を外す | 緑 | **緑** |

- ベースライン（無変異）で `tsgo` は exit 0。つまり**2本の `@ts-expect-error` はいま実際にエラーを抑制している**（「抑制すべきエラーが無い」で誤って赤くなってはいない）。M1 / M3 / M4 で赤くなることから、**外れたときに赤くなる**ことも確認できた。
- M4 は特に重要で、`ALGORITHM_ID` 側のコメントが名指しする「a union that still reads」＝ 読めてしまう別識別子への緩和も確かに捕まる。
- M2 / M5 が緑であることは**コメントの主張そのもの**（「Removing the adapter's own `: typeof …` annotation is outside its reach」）であり、記述と守備範囲が一致している。

### 3. 3層コメント（`pbkdf2PasswordHasher.test.ts:323-328`）の突き合わせ

| 層 | コメントの主張 | 変異 | 実測 |
|---|---|---|---|
| 1 | 型検査が application 側定数の緩和を捕まえる | M3 / M4 | typecheck 赤 ✔ |
| 2 | round-trip テストが `SHIPPED_HASH` の `ALGORITHM_ID` からの乖離を捕まえる | M6: `SHIPPED_HASH = "SHA-256"`（`ALGORITHM_ID` はそのまま） | typecheck 緑・**unit 4件赤**（`verifies a password it hashed` ほか）・統合 `TC-loginWithPassword-009` も赤 ✔ |
| 3 | `identity.integration.test.ts` のリテラル正規表現が「注釈を落とした後のドリフト」を捕まえる | M7 / M9 | typecheck 緑・**unit 全緑**・統合の当該1件だけ赤 ✔ |

3層の分業は**実際の守備範囲と一致している**。ただし層3の記述の限定不足は W-002 のとおり。

### 4. 自己言及性

自己言及的な期待値は見当たらない。

- `expect(ALGORITHM_ID).toBe("pbkdf2-sha512")` / `expect(hashFor("pbkdf2-sha512")).toBe("SHA-512")` / `expect(hashFor("argon2id")).toBeNull()` — すべてリテラル。`expect(hashFor(ALGORITHM_ID)).toBe(SHIPPED_HASH)` の形は採られていない（plan.md「テスト方針」の要求どおり）。
- 統合側の `new RegExp(\`^pbkdf2-sha512\\$${DEFAULT_PBKDF2_ITERATIONS}\\$\`)` は、識別子がリテラル、反復回数が**アダプター側**の定数。検査対象はダミー（application 側の定数から組み立てられる値）なので、**別々の定数を突き合わせる形**になっており自己言及にならない。M9 でこれが実際に赤くなることも確認済み。
- `takes the OWASP default for its algorithm when given no argument` は `String(DEFAULT_PBKDF2_ITERATIONS)` と突き合わせるが、その定数自体は同ファイルの `declares the OWASP count for the algorithm it ships` がリテラル `210_000` で錨を打っている。AC-4 の権威を「既定値経路を実際に歩く1件」に一本化し、定数の値は別テストで固定するという分担は妥当で、コメント（`:91-93`）の説明とも一致する。

### 5. `parse()` 拒否ケースの追加分

追加3行（`too many fields` / `empty algorithm` / `prototype key as algorithm` + `__proto__`）はいずれも実際に `SystemError(DATA_INTEGRITY_ERROR)` に落ちる（全13行が pass）。

- `PasswordHash.create()` が先に弾いてしまえば `isSystemError(caught)` が false になって落ちるので、**これらが `parse()` に到達していること自体もテストが保証している**。
- `"$1000$c2FsdA==$aGFzaA=="` → `split("$")` は `["", "1000", …]` の4要素で、`hashFor("")` が `null` を返す枝を踏む。空識別子は `parts.length` ではなく `hashFor` 側で落ちるという実装の形と一致する。
- `constructor` / `__proto__` の2行は AC-6 と R-5 が明示的に要求している防御の証跡。現実装（全域関数）では素通りしないが、将来の表引き回帰への網として意味がある旨がコメントに書かれており、意図が読める。

### 6. 本番強度（210,000 回）の実導出を踏むテスト件数 — R-6

リポジトリ全体で引数なしの `createPbkdf2PasswordHasher()` をテストから呼ぶのは**ちょうど2箇所**で、R-6 が名指しした位置と一致する（据え置き）。

- `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:219`（node プール、実測 **50ms**）
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts:642`（workerd プール）

round 1 で `declares the OWASP count for the algorithm it ships` から `hash()` 呼び出しが外れているため、**件数は増えていない**。SHA-512 化による1件あたりの増分は `--reporter=verbose` の実測で 50ms（ローカル ARM）で、unit スイート全体は 417 件 / tests 806ms のまま。`docs/test.md` の更新を要求する AC は無い。

### 7. 捨てプローブの撤去 — AC-3

- `packages/core/src/application/identity/__tests__/` に `_probe.integration.test.ts` は存在しない。`git diff origin/main...HEAD --name-only` にも現れない。
- `git diff origin/main...HEAD -- vitest.config.integration.ts .github/workflows/ci.yml` は**空**。設定ファイルの一時編集は発生していない（AC-3 後段）。
- CI 実測の回収チャネル（`[#20-probe] {…}` の故意の throw）は run `31121514993` のログに実在し、`{"SHA-512@210000":{"median":127.2},"SHA-256@600000":{"median":86.2},"SHA-256@210000":{"median":30.2}}` が `.thread/1/adr.md:177-193` の記載と**完全に一致**する。数値の捏造・転記ミスは無い。
- 残るのは W-001（撤去後ランの完走）だけ。

### 8. AC ごとの担保状況（テストで閉じるべきもの）

| AC | 担保 | 判定 |
|---|---|---|
| AC-3 | プローブ・設定ファイルとも差分ゼロを確認。CI 完走のみ未達 | △（W-001） |
| AC-4 | `takes the OWASP default for its algorithm when given no argument`（先頭2フィールドをリテラル + 定数で固定）＋ `declares the OWASP count…`（定数をリテラルで固定） | ✔ |
| AC-5 | `encodes algorithm, iterations, salt and derived key` の `atob(derived).length === 32` | ✔ |
| AC-6 | `writes one identifier and derives with the digest it names`（リテラル）＋ 拒否ケース表13行（`constructor` / `__proto__` を含む） | ✔ |
| AC-7 | `still verifies a hash written in the pre-#20 SHA-256 encoding`。フィクスチャが本当に SHA-256 由来であることを独立再計算で確認 | ✔ |
| AC-8 | `burns against a hash the production hasher derives from, not just any string`（本番強度で実導出 + リテラル正規表現） | ✔ |
| AC-9 | `ALGORITHM_ID` の `@ts-expect-error` ピン。M3 / M4 で赤くなることを確認 | ✔ |
| AC-10 | `grep -n "OWASP\|210k\|210_000"` の残存ヒットは 5 行で、すべて SHA-512 と組になった記述（`:25` `:92` `:94` `:95` `:218`） | ✔ |
| AC-11 | `pnpm typecheck` 緑（ベースライン exit 0）。`@ts-expect-error` が「抑制すべきエラー無し」で落ちていない | ✔ |
| AC-14 | unit 417 pass / 24 files、integration 104 pass / 9 files、`biome check` exit 0（infos 2 のみ）、`biome format` exit 0 | ✔（ローカル） |
| AC-15 | `grep -n "SHA-256\|sha256"` の残存ヒットは 6 行で、旧読み取り枝の説明（`:14` `:26` `:34` `:35` `:204`）と 600,000 の正しい帰属（`:57`）のみ | ✔ |

---

## カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `.thread/20/plan.md`, `.thread/20/testing.md`, `.thread/20/steps.md`（ステップ1 / 3 / 4 / 5 のテスト関連節）, `docs/test.md`, `.github/workflows/ci.yml`（差分ゼロの確認）, `vitest.config.integration.ts`（差分ゼロの確認）
- スキップ: `.thread/20/review/*.md`（5ファイル） — round 1 のレビュー成果物（Phase 8 で削除予定）
- スキップ: `.thread/20/adr.md`, `.thread/1/adr.md`, `.thread/1/progress.md` — 設計判断・ドキュメント観点の担当範囲。ただし `.thread/1/adr.md` の実測節（`:165-194`）だけは、プローブが出した CI ログの実値との突き合わせのために読んだ（一致を確認）
