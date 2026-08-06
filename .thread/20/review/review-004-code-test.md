# レビュー round 4 — Code + Test（PR #53 / Issue #20）

対象: `origin/main...HEAD`（`32eb1c7`）。round 3 の修正は `git diff 06bb663..HEAD`。

## 前提の確認: round 3 の修正はコメントだけか

**確認済み。** `git diff 06bb663..HEAD -- packages apps` の追加・削除行から、コメント行（`//` / `*` / `/**` 始まり）を除いた残差は **0 行**。

```
git diff 06bb663..HEAD -- packages apps | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
  | grep -vE '^[+-]\s*(//|\*|/\*\*)'   # → 出力なし
```

アサーション・型注釈・実装ロジックはいずれも無変更。round 3 で触れたのは 4 ファイルのコメント／JSDoc のみ（`pbkdf2PasswordHasher.test.ts` / `pbkdf2PasswordHasher.ts` / `identity.integration.test.ts` / `loginWithPassword.ts`）。

## Code + Test

### Blockers

なし。

### Warnings

- **[W-001]** 「アルゴリズム差し替えは等時化を *cost nothing* にする」というコメントが、本 PR が新設した JSDoc と食い違う
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:635-641`（`// The burn above is only a burn if …` ブロック）
  - 理由: 該当コメントは「`burnVerificationTime` が throw を握り潰すので、**an algorithm swap**, an iteration count outside the accepted range or a typo in the constant would make the equalisation **cost nothing**」と書いている。ところが ADR-002 で `pbkdf2-sha256` を読み取り専用の枝として残した結果、**アルゴリズムを差し替えてダミーを取り残しても `parse` は成功し `verify` も成功する**。本 PR が新設した `loginWithPassword.ts:46-49` の JSDoc はまさにそれを「would still parse and still verify — no throw for `burnVerificationTime` to catch, no warning」と明記しており、同じ事象について片方が「コストがゼロになる」、もう片方が「verify は成立する（＝旧コストは払う）」と述べている。変異注入 M7b で後者が正しいことを実測で確認した（差し替え後もこのテストの `resolves.toBe(false)` は通り、落ちるのは正規表現の行だけ）。残差の実測値も ADR-002 が `SHA-256 @ 210k = 30.2ms` / `SHA-512 @ 210k = 127.2ms`（差 約 97ms）と記録しており、「ゼロ」ではない
  - なおこのコメントブロック自体は main から持ち越された既存テキストで、本 PR の diff では末尾3行しか触っていない。とはいえ「差し替えても読めてしまう」状態を作ったのは本 PR（ADR-002）なので、round 4 の主眼（コメントと実装の一致）に照らせば本 PR の射程内
  - 提案: 列挙の該当項を「読めなくなる差し替え」に限定するか、`cost nothing` を `stop costing what a real verification costs` 相当に緩める。1 行の文言修正で閉じる。**挙動・アサーションには影響しないので非ブロッキング**

- **[W-002]** ゲート対応表の第2行が、型検査も同時に赤くする事実を落としている
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:307-308`（`- drift in the adapter's own value: the unit tests in this file;`）
  - 理由: 「adapter 側の値のドリフト」のうち `ALGORITHM_ID` / `DEFAULT_PBKDF2_ITERATIONS` は `: typeof …` ピンが掛かっているので、**unit テストより先に `pnpm typecheck` が TS2322 で落ちる**（変異注入 M4a / M5 で実測）。型検査が盲目なのは `hashFor` の対応表と `SHIPPED_HASH` の側だけ（M4b / M6 で実測）。表の見出しが「How the gates divide the work」なので、この行だけ読むと「adapter 側の値は型検査では捕まらない」と読めてしまう
  - 表の最終文（`Dropping that annotation on its own is caught by nothing`）は排他性を主張しており、それは実測と厳密に一致している（M8）。問題はこの1行だけ
  - 提案: `the unit tests in this file (and, where a pin covers it, the type check)` 程度に1語足す。**非ブロッキング**

### 変異注入による主張の検証

分離ワークツリー（`git worktree add`、`node_modules` はシンボリックリンク）で実施。ゲートは 3 本 — `packages/core` の `tsgo`、`pbkdf2PasswordHasher.test.ts`（unit / node プール）、`identity.integration.test.ts`（integration / workerd プール）。ベースラインは typecheck=0 / unit 38 passed / integration 36 passed。終了後にワークツリーは削除済み。

| # | 変異 | 主張 | 実測 | 判定 |
|---|---|---|---|---|
| M1 | `DUMMY_PASSWORD_HASH_ITERATIONS: number` | 型検査が赤 | typecheck TS2578 @ `pbkdf2PasswordHasher.test.ts:318` / unit 緑 / integration 緑 | ✅ 一致 |
| M2 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: string` | 型検査が赤 | typecheck TS2578 @ `:333` / unit 緑 / integration 緑 | ✅ 一致 |
| M3 | 同上を `"pbkdf2-sha512" \| "pbkdf2-sha256"`（まだ読めるユニオン） | 型検査が赤 | typecheck TS2578 @ `:333` / 他は緑 | ✅ 一致 |
| M3b | `DUMMY_PASSWORD_HASH_ITERATIONS: 210_000 \| 600_000` | 型検査が赤 | typecheck TS2578 @ `:318` / 他は緑 | ✅ 一致 |
| M4a | adapter `ALGORITHM_ID` の値を `pbkdf2-sha256` へドリフト | このファイルの unit が赤 | unit 7 件失敗（往復4件 + `writes one identifier …` + 既定値2件） | ✅ 一致（ただし typecheck TS2322 と integration TC-009 も同時に赤 → W-002） |
| M4b | `hashFor("pbkdf2-sha512") → "SHA-256"`（型検査が見えないドリフト） | unit が赤 | typecheck 緑 / unit 6 件失敗 / integration 1 件失敗 | ✅ 一致 |
| M5 | adapter `DEFAULT_PBKDF2_ITERATIONS` を 600,000 へ | unit が赤 | unit `declares the OWASP count …` 1 件 / typecheck TS2322 / integration `burns against …` 1 件 | ✅ 一致（W-002 と同じ注記） |
| M6 | `SHIPPED_HASH` を `"SHA-256"` へ（`ALGORITHM_ID` からドリフト） | 往復テストが赤 | typecheck 緑 / unit **往復4件のみ**失敗（`verifies a password it hashed` / `draws a fresh salt …` / `reads the iteration count back …` / `accepts exactly the floor …`）/ integration は往復の TC-009 のみ | ✅ 一致（ADR-002 の「往復テスト4件」とも数まで一致） |
| M7a | 両ピンの `: typeof …` を外し、**かつ** app 側 `DUMMY_PASSWORD_HASH_ITERATIONS` を 600,000 へ | `identity.integration.test.ts` の `burns against a hash the production hasher derives from` **だけ**が赤 | typecheck 緑 / unit 38 passed / integration **その1件のみ**失敗 | ✅ 厳密に一致 |
| M7b | 同上、app 側 `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `pbkdf2-sha256` へ | 同上 | typecheck 緑 / unit 38 passed / integration **その1件のみ**失敗 | ✅ 厳密に一致 |
| M8 | **`: typeof …` 注釈を外すだけ** | どのゲートも検出しない | typecheck 緑 / unit 38 passed / integration 36 passed | ✅ 厳密に一致（この主張が最重要） |
| M9 | `derive()` の鍵素材を変更（`plain` に pepper を連結） | golden vector 2件だけが赤 | typecheck 緑 / unit **2件のみ**失敗（`still verifies a hash written in the pre-#20 SHA-256 encoding` / `verifies a SHA-512 hash it did not write itself`）/ integration 緑 | ✅ 厳密に一致 |
| M10 | app 側の2定数をドリフト（ピンは残したまま） | 片方だけ動かすとコンパイルが通らない | typecheck が TS2322 ×2（adapter の両宣言）+ TS2578 ×2 | ✅ 一致 |

**M7b は同時に「アダプター内でアルゴリズムを差し替えてダミーを取り残しても `parse` は成功するので throw しない」の直接の実証になっている。** このテストは正規表現の行より前に `createPbkdf2PasswordHasher().verify(plain, PasswordHash.create(dummy))` が `false` に解決することを要求しており、ダミーが `pbkdf2-sha256$210000$…` になった M7b でもそこは通過して、落ちたのは正規表現の行だけだった（＝旧枝で parse も verify も成立し、throw も警告も発生していない）。`loginWithPassword.ts:46-49` の新 JSDoc の主張は成立する。

### golden vector の外部照合

コメントが「node:crypto `pbkdf2Sync("password123", salt, 1000, 32, "sha512")` で生成し、同じ入力の SHA-256 導出とは異なることを確認した」と書いているので、`node:crypto` で再計算して照合した。

- `pbkdf2-sha512$1000$xV4JrROqj4l6BU/mz+2B9g==$…` → 再計算値が **完全一致**、同入力の SHA-256 導出は `vRCtX0Mo…` で**別物**（コメントの主張どおり）
- 旧形式 `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$…` → 再計算値が **完全一致**
- ダミーの salt / derived は 16 / 32 byte（JSDoc「長さは既に正しい」と一致）

### JSDoc・コメントの逐行照合（W-001 / W-002 以外）

- `loginWithPassword.ts:34-36`「A second pin of the same shape covers the algorithm」— 実装は独立2本のピン。M10 で両方が独立に TS2322 を出すことを確認。✅
- `loginWithPassword.ts:44-49`「the shipped hasher's `ALGORITHM_ID` is declared as `typeof` this constant, so moving one without the other stops compiling」— M4a / M10 で双方向を確認。✅
- `loginWithPassword.ts:77-86` の catch の説明（「a different `PasswordHasher` adapter being wired」）— リポジトリ内に別実装（`FakePasswordHasher`、テストの `throwingHasher`）が実在し、DI コンテナ差し替えで `verify` が throw する経路は現に `keeps an unknown address at INVALID_CREDENTIALS when the burn itself throws` が踏んでいる。round 3 以前の「an algorithm swap that leaves this constant stale」が誤りだったのに対し、新しい例は成立する。✅
- `pbkdf2PasswordHasher.ts:26-34`（旧枝の退役条件）— 「`#18` の rehash-on-login は旧枝で verify して旧行を書き換えるので、枝は #18 より長く生きる必要がある」という論理が JSDoc と `.thread/20/adr.md` ADR-002 の条件2で**同じ結論**になっている（ADR 側は「条件2を『#18 が入った時点』と書いてはならない」と明示）。論理としても正しい。✅
- `pbkdf2PasswordHasher.ts:14-24`（`hashFor` の全域性・表引きを採らない理由）/ `:52-54`（`SHIPPED_HASH` を直に持つ理由）/ `:56-100`（`DEFAULT` / `MIN` / `MAX`）/ `:194-215`（ファクトリ）— いずれも実装と一致。`MAX_PBKDF2_ITERATIONS` の「guards data corruption rather than an attacker」も ADR-002 の据え置き根拠と整合。✅
- `pbkdf2PasswordHasher.test.ts:91-93` / `:98-100` / `:107-110` / `:122-129` / `:143-145` / `:149-155` / `:159-162` / `:189-192` / `:225-227` / `:249-253` / `:297-302` / `:326-331` — すべて対応するテストの実体と一致。✅
- `identity.integration.test.ts:648-654`（round 3 で書き直した末尾）— 「What this catches is drift in the dummy's own constants」は M5 / M7a / M7b で成立を確認。参照先（`DEFAULT_PBKDF2_ITERATIONS` 上の対応表）も実在。✅

### 受け入れ基準（コード・テストで担保されるもの）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-3 | ✅ | `_probe.integration.test.ts` は作業ツリーにも `git status` にも存在しない（`__tests__/` の中身は 4 ファイル）。`vitest.config.integration.ts` / `.github/workflows/ci.yml` は `origin/main...HEAD` の diff に現れない。**CI ランの緑確認はメイン側の Phase で行う項目** |
| AC-4 | ✅ | `takes the OWASP default for its algorithm when given no argument` が既定パスの先頭2フィールドを検証 |
| AC-5 | ✅ | `DERIVED_BITS = 256` 据え置き、`encodes algorithm, iterations, salt and derived key` が derived 32 byte を検証 |
| AC-6 | ✅ | `hashFor` は `===` の全域関数。拒否ケース表に `constructor` / `__proto__` の2行。`ALGORITHM_ID === "pbkdf2-sha512"` と `hashFor("pbkdf2-sha512") === "SHA-512"` をリテラルで固定（自己言及なし） |
| AC-7 | ✅ | 旧形式フィクスチャのテストが存在し、`node:crypto` で真正性まで照合済み |
| AC-8 | ✅ | `burns against a hash the production hasher derives from` が本番強度のハッシャーで `resolves.toBe(false)`（= throw しない）+ `^pbkdf2-sha512$210000$` を固定 |
| AC-9 | ✅ | 両側の `: typeof …` と `@ts-expect-error` 2件。M1 / M2 / M3 / M3b / M4a / M5 / M10 で型検査が実際に赤くなることを実測 |
| AC-10 | ✅ | `grep -n 'OWASP\|210k'` の残存4ヒットはいずれも SHA-512 と組になった記述（`:25` / `:92` / `:94` / `:218`） |
| AC-11 | ✅ | `packages/core` の `tsgo` = 0、ルート `tsgo` = 0、`apps/web` も生成済み `worker-configuration.d.ts` のあるツリーで 0（分離ワークツリーでの `Env.DB` エラーは gitignore された生成物の欠落によるもので、PR とは無関係） |
| AC-14 | ✅（ローカル分） | `biome lint` / `biome format` とも指摘なし（infos 2 件は既存の `biome migrate` 案内）。unit 38 / integration 36 とも緑 |
| AC-15 | ✅ | `grep -n 'SHA-256\|SHA256' pbkdf2PasswordHasher.ts` の残存は `Digest` ユニオンの定義と旧読み取り枝の2行だけ |

AC-1 / AC-2 / AC-12 / AC-13 は ADR・progress.md 側の担保なので Docs 視点へ委ねる。

### カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `packages/core/src/application/__tests__/fakes/fakePasswordHasher.ts`, `.thread/20/adr.md`（ADR-002 / ADR-003）, `.thread/20/plan.md`, `.thread/20/review/triage.md`
- スキップ: `.thread/1/adr.md` / `.thread/1/progress.md` / `.thread/20/steps.md` / `.thread/20/testing.md` — Docs 視点の担当範囲（AC-12 / AC-13）。本レビューでは JSDoc との整合が問われた ADR-002 の退役条件だけを読んだ
- スキップ: `packages/core/src/domain/identity/__tests__/*` と `packages/core/src/adapters/d1/__tests__/*` の `pbkdf2-sha256$1$…` フィクスチャ — plan.md「含まれないもの」でドメインが解釈しない不透明文字列として明示的にスコープ外。実際にドメイン層は文字列を解釈していない
- スキップ: 実機タイミングの実測 — `.thread/20/testing.md` の手動確認手順の担当

## 判定

**マージ可能**（Blocker 0。W-001 / W-002 はいずれも 1 行のコメント文言で、挙動・型・アサーションに影響しないため、このマージを止める理由にはならない）。
