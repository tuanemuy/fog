# レビュー 001 — Test（PR #53 / Issue #20）

対象: `origin/main...HEAD`（`issue/20/pbkdf2-cost-parameters`、3 コミット）
基準: `CLAUDE.md` / `docs/test.md` / `.thread/20/plan.md`（受け入れ基準・テスト方針）/ `.thread/20/steps.md`（ステップ3・6・7）

このレビューは**読解だけで済ませていない**。型ピンが本当に assertion として機能するか、どのテストがどの退行を捕まえるかは、**実際にコードへ変異を注入して `pnpm typecheck` / `pnpm test:unit` / `pnpm test:integration` を回して確認した**（末尾「変異注入による検証記録」）。すべて実行後に復元済みで、`git status` はクリーン。

## Test

### Blockers

**なし。**

plan.md の AC-4 / AC-5 / AC-6 / AC-7 / AC-9 / AC-10 / AC-11 / AC-14 は、いずれも**テストまたは型検査で実際に担保されていることを確認した**（実行結果は末尾）。特に次の3点は、書かれているとおりに機能することを変異注入で実証できた。

- **旧形式フィクスチャは本物である。** `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=` を `node:crypto` で独立に再計算したところ、`pbkdf2Sync("password123", salt, 1000, 32, "sha256")` と**バイト一致**した。同じ入力の SHA-512 導出（`Wa/Q1Ufv+…`）とは当然一致しないので、このテストは**確かに SHA-256 枝を踏んでいる**（AC-7）。誤パスワード `password124` が `false` になることまで固定されている点も要件どおり
- **`@ts-expect-error` の2本は「抑制すべきエラーが無い」で誤って赤くなることも、ピンが外れたのに緑のままになることも無い。** `DUMMY_PASSWORD_HASH_ALGORITHM_ID` に `: string` を付けると `TS2578: Unused '@ts-expect-error'` で落ち（変異2）、値だけ動かすと `TS2322` で落ちる。対照値の選び方も妥当で、`600_000`（案 A では正しい値にならない）も `"pbkdf2-sha256"`（システム内で唯一の他の識別子で、`: string` と「読める2つのユニオン」という**もっともらしい widening 2種**をどちらも捕まえる）も適切
- **`SHIPPED_HASH` は型ピンの外にあるが無音ではない。** `"SHA-256"` へ落とすと往復テスト4件が確実に赤くなる（変異3）。`ALGORITHM_ID` / `hashFor` をリテラルで固定するテスト（`:101-104`）と往復テストの組み合わせで、`hash()` が実際に SHA-512 を渡していることが**自己言及なしに**固定されている。ADR-002 が「二層で検出」と主張しているとおりだった

**本番強度（210,000 回）の実導出を踏むテストは 2 件のままで増えていない**（`pbkdf2PasswordHasher.test.ts:190-194` と `identity.integration.test.ts:641-646`）。新設された3件（`:91-96` / `:101-104` / `:110-119`）はすべて低コスト（1,000 回）または導出なし。1導出あたりのコストは実測で 23.4ms → 49.5ms（約 2.1 倍、`node:crypto` @ 210k）なので**スイート全体の増分は +50ms 程度**にとどまる。実測でも unit 609ms / integration 765ms（tests 時間）で、`docs/test.md` の「unit は数〜十数 ms」に対して問題になる水準ではない。

**捨てプローブは完全に撤去されている。** ワークツリー（`find` で 0 件）・`git ls-tree -r HEAD`（0 件）・`git diff --stat origin/main...HEAD`（10 ファイル中に無し）のいずれにも現れない。`vitest.config.integration.ts` と `.github/workflows/ci.yml` の diff も空で、AC-3 の「設定ファイルの一時編集はそもそも発生していない」も満たしている（→ 情報として I-001）。

**取り違えた主張を固定する名前も残っていない。** `grep -n "OWASP\|210k" pbkdf2PasswordHasher.test.ts` の残存4ヒット（`:25` / `:91` / `:95` / `:190`）はすべて「SHA-512 と 210,000 の組」として述べられており、AC-10 の判定基準を満たす。

### Warnings

- **[W-001]** **`derive()` の鍵素材の扱いを守っているテストが、退役予定の旧形式フィクスチャ1件しか無い。** 出荷形式 `pbkdf2-sha512$` には外部固定ベクター（golden vector）が存在しない
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:110-119` / `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:112`
  - 理由: `derive()` の `new TextEncoder().encode(plain)` を `encode(\`x${plain}\`)`（ペッパー混入・正規化追加・エンコーディング変更を代表する変異）に差し替えて全スイートを回したところ、**赤くなったのは `still verifies a hash written in the pre-#20 SHA-256 encoding` の1件だけ**だった（unit 82 passed / integration 36 passed）。往復テストも統合テストも型ピンも、この変異には**構造的に反応できない** — `hash()` 側と `verify()` 側が一緒に動くので往復は常に成立するからである。本番では「保存済みの全ハッシュが検証不能になる」という最も高くつく壊れ方をするクラスの変更が、テスト1件だけに支えられている
  - そのうえ**その1件は削除が予定されている。** `.thread/20/adr.md` ADR-002「退役条件」が「#18（rehash-on-login）が入った時点で削除してよい」と明記し、アダプター JSDoc（`:23`）も「`pbkdf2-sha256` is a read-only branch … nothing writes it any more」と書いている。旧枝を消すときにこのテストも一緒に消えるのが自然な流れで、そのとき**出荷形式の導出は往復テストだけになる**。旧枝の生存確認（AC-7）という役割と、`derive()` の外部固定という役割が1件のテストに同居していて、片方の寿命がもう片方を巻き込む
  - 提案: 出荷形式の golden vector を1件足す。旧枝の寿命から独立するので、退役時に安全に旧フィクスチャだけ落とせる。既存の legacy テストの直下に置けば意図も並ぶ

    ```ts
    // The shipped format's external fixture: a round trip cannot see a change
    // to what `derive` feeds WebCrypto, since both sides move together.
    // Generated with node:crypto pbkdf2Sync("password123", salt, 1000, 32, "sha512").
    it("verifies a SHA-512 hash it did not write itself", async () => {
      const fixture = PasswordHash.create(
        "pbkdf2-sha512$1000$p0KaacPbzJDYqwBsnPJ4RQ==$G4jFkmf9Ax2xFQkUqAn+PTzShSMrq5yvKqYaLAVjmp8=",
      );
      await expect(hasher.verify(PASSWORD, fixture)).resolves.toBe(true);
      await expect(
        hasher.verify(PlainPassword.create("password124"), fixture),
      ).resolves.toBe(false);
    });
    ```

    （上の値は `pbkdf2Sync("password123", salt, 1000, 32, "sha512")` で生成して現行実装で `true` になることを確認済み。採用するなら実装者の手元で再生成してよい）。あわせて ADR-002 の退役条件に「旧枝を消すときに `derive()` の外部固定が失われないことを確認する」を1行足すと、判断が将来の読み手に引き継がれる

- **[W-002]** **`parse()` の拒否ケース表に、フィールド数の「過剰」側・空識別子・`__proto__` が無い**
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:121-158`（特に `:122` と `:127`）
  - 理由: 3点ある。
    1. `["wrong field count", "pbkdf2-sha512$1000$c2FsdA=="]` は**3フィールド（不足）だけ**を踏む。実装は `parts.length !== 4` なので過剰側も落ちるが、テストは片側しか歩いていない。`PasswordHash.create` は非空文字列なら何でも通すので `pbkdf2-sha512$1000$c2FsdA==$aGFzaA==$extra` は構築可能であり、**base64 の中に `$` が現れないことに依存した契約**（`toBase64` は `+/=` しか使わないので現に安全）が、その依存を明示するテストなしで成立している
    2. 空の識別子（`"$1000$c2FsdA==$aGFzaA=="`）が無い。`parse()` は `algorithm === undefined ? null : hashFor(algorithm)` という **`undefined` だけを特別扱いする形**（`:140`）になっており、空文字列は `hashFor("")` に落ちる。この分岐の形を固定するテストが無い
    3. プロトタイプ由来キーが `constructor` 1件のみ。このケースの存在理由は R-5 / ADR-002 が明記するとおり「将来 `parse()` が表引きに戻ったときの回帰網」だが、**素の object の表引きで最も有名に漏れるのは `__proto__`** であり、`constructor` とは挙動の質が違う（`obj["__proto__"]` は `Object.prototype` を返す）。回帰網として置くなら両方あって初めて意図した網になる
  - 提案: `it.each` の表に3行足す。実装を1行も変えずに済み、実行コストも導出を踏まないので事実上ゼロ

    ```ts
    ["too many fields", "pbkdf2-sha512$1000$c2FsdA==$aGFzaA==$extra"],
    ["empty algorithm", "$1000$c2FsdA==$aGFzaA=="],
    ["__proto__ as algorithm", "__proto__$1000$c2FsdA==$aGFzaA=="],
    ```

    あわせて、新しく `export` された `hashFor` の `null` 側を**直接**1行で固定しておくと、公開 API の契約（`"SHA-256" | "SHA-512" | null`）が `parse()` 経由の間接的な観測だけに頼らなくなる（`:101-104` の隣に `expect(hashFor("argon2id")).toBeNull();`）

- **[W-003]** **`it("defaults to the OWASP count for the algorithm it ships")` の本体が、名前の「defaults」を踏んでいない**
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:91-96`
  - 理由: 追加された `await hasher.hash(PASSWORD)` の `hasher` は**モジュール先頭の `iterations: 1_000`** で作られたハッシャー（`:30`）であって、既定値のハッシャーではない。つまりこのテストが「既定」について述べているのは `expect(DEFAULT_PBKDF2_ITERATIONS).toBe(210_000)` の1行だけで、アルゴリズム側の assertion は既定経路を1ミリも通らない。しかもその assertion は `:58` の `expect(algorithm).toBe("pbkdf2-sha512")` と**同じハッシャーの同じ性質を二度**見ている。一方 `:190-194` は `createPbkdf2PasswordHasher()`（引数なし＝既定）に対して識別子と反復回数の**両方**を固定しており、AC-4 が要求する「`createPbkdf2PasswordHasher()` の出力の先頭2フィールドで確認できる」を実際に満たしているのはこちらである。steps.md 6-1 は「アルゴリズムも同じテストで確認する」としか書いていないので逸脱ではないが、**AC-4 の権威がどちらのテストなのかが読んで分からなくなっている**
  - 提案: `:91-96` からは `hash()` 呼び出しを落として定数の assertion だけに戻し（`async` も外れる）、AC-4 の表明は `:190-194` に一本化する。名前も `it("declares the OWASP count for the algorithm it ships")` のように「既定を踏む」と読めない形にすると、`:190` との役割分担が名前から見える。本番強度を踏む件数を増やさずに済む点でも R-6 に沿う

- **[W-004]** **型ピンについてのコメントが、`pnpm typecheck` が実際に覆う範囲を過大に述べている**
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:268-274`（既存）/ `:283-289`（本 PR で追加）
  - 理由: `:273-274` は「The directive below is the whole assertion: it goes unused the moment the pin is gone」と書き、`:286-289` も同じ枠組みで「アダプター側の宣言に対して検査する」と説明している。しかし**アダプター側の `: typeof …` 注釈を外す**（＝ピンを断つ）と、`ALGORITHM_ID` / `DEFAULT_PBKDF2_ITERATIONS` は同じリテラル型に推論されるので `@ts-expect-error` は**依然として「使用中」のまま**で、`pnpm typecheck` は緑のままだった（変異4）。さらにその状態で `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `"pbkdf2-sha256"` へ動かしても、**typecheck も `pnpm test:unit`（83 passed）も両方緑**になる。「ピンが消えた瞬間に directive が unused になる」は成り立たない
  - **ただし実害は無い。** その状態を捕まえるのは `identity.integration.test.ts:649-651` の**リテラルで書かれた正規表現**で、実際に走らせると当該1件だけが赤くなることを確認した（変異5）。plan.md テスト方針が「アルゴリズム識別子をリテラルで書いた正規表現で固定する」と決めた判断は、まさにこの経路を守っていて正しい。問題は防御の実体とコメントの説明がずれていること — コメントを読んだ将来の実装者が「型検査が全部見ている」と信じて統合テストの正規表現を定数から組み立て直すと、**そのときに防御が本当に消える**
  - 提案: 両ブロックのコメントを実態に合わせる。「この directive が捕まえるのは application 側の定数が `string`（や読める識別子のユニオン）へ広げられたケースで、アダプター側の `: typeof …` 注釈そのものが外れたケースは `identity.integration.test.ts` のリテラル正規表現が最後の砦である」と書けば、3層（型ピン / `@ts-expect-error` / 統合テストのリテラル）の役割分担が正確に伝わる。加えて統合テスト側にも「この正規表現を定数から組み立て直さないこと」を一言残すと、W-004 が指す将来の退行が構造的に防げる

### 情報（Blocker / Warning ではない）

- **[I-001]** 捨てプローブは **HEAD のツリーからは消えているが、ブランチの中間コミット `3144e15` には残っている**。AC-3 が要求しているのは `git status` / `git diff --stat` に現れないことなので**基準は満たしている**。ただし PR をマージコミットで取り込むと、意図的に赤くしたテストを含むコミットが `main` の履歴に入る。squash merge なら問題にならないので、マージ方式だけ意識しておけばよい
- **[I-002]** DI 配線（`serverCloudflare.ts`）が `createPbkdf2PasswordHasher()` を引数なしで呼んでいることを固定するテストが無い、という点は security 観点の [W-002] が既に挙げている。Test 観点からも同意見だが、指摘としては重複するのでここでは再掲しない。テストで閉じるなら「組み上がったコンテナの `passwordHasher.hash()` 出力の2フィールド目が `String(DEFAULT_PBKDF2_ITERATIONS)` である」を1件置くのが最も安い
- **[I-003]** `.thread/20/testing.md` は AC → 確認項目の対応が明示され、「対象外（実機では確認しないこと）」で自動テスト・型検査に委ねる範囲を先に切っている点が良い。特に異常系1の「正直な限界」節が、等時間化そのものは実機手順では検証できないと明言し、`identity.integration.test.ts` と警告ログへ委譲しているのは、テスト設計として正しい書き分けである。確認項目5 が単体テストと**同一のフィクスチャ**を実機経路でも踏ませる設計になっているのも、単体と実機の突き合わせとして筋が良い

## 変異注入による検証記録

すべて実行後に `git checkout --` で復元し、`git status --short` で確認済み。

| # | 注入した変異 | 期待 | 結果 |
|---|---|---|---|
| 1 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: string`（application 側ピンの widening） | `pnpm typecheck` が落ちる | **落ちた** — `pbkdf2PasswordHasher.test.ts(291,5): TS2578: Unused '@ts-expect-error'` |
| 2 | `DUMMY_PASSWORD_HASH_ITERATIONS: number` | `pnpm typecheck` が落ちる | **落ちた** — `(276,5): TS2578` |
| 3 | `SHIPPED_HASH` を `"SHA-256"` へ（`ALGORITHM_ID` 据え置き） | typecheck は通り往復テストが赤 | **そのとおり** — unit 4 failed（`verifies a password it hashed` 他） |
| 4 | アダプター側の `: typeof …` 注釈を2本とも削除（ピンの切断）→ さらに `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `"pbkdf2-sha256"` へ | typecheck が落ちてほしい | **落ちなかった** — typecheck 緑・`pnpm test:unit` 83 passed（→ W-004） |
| 5 | 同上の状態で統合テストを実行 | どこかが赤くなる | **赤くなった** — `burns against a hash the production hasher derives from` の1件のみ FAIL（リテラル正規表現が最後の砦） |
| 6 | `derive()` の鍵素材を `encode(\`x${plain}\`)` へ（ペッパー混入相当） | 複数のテストが赤 | **1件のみ** — `still verifies a hash written in the pre-#20 SHA-256 encoding`。integration は 36 passed（→ W-001） |
| 7 | 旧形式フィクスチャの独立再計算（`pbkdf2Sync("password123", salt, 1000, 32, "sha256")`） | 埋め込み値と一致 | **一致**。SHA-512 導出（`Wa/Q1Ufv+…`）とは不一致で、SHA-256 枝を実際に踏んでいる |
| 8 | 210k @ SHA-256 / SHA-512 の1導出コスト計測（`node:crypto`、5回中央値） | 増分の見積り | 23.4ms → 49.5ms（約 2.1 倍）。本番強度を踏むテストは 2 件のままなので増分は約 +50ms |

## 実行したコマンドと結果（AC-11 / AC-14）

| コマンド | 結果 |
|---|---|
| `pnpm typecheck` | **通過**（root / `@repo/core` / `@repo/web` / `infra`）|
| `pnpm test:unit` | **413 passed / 24 files**（tests 609ms）。6 回連続で実行して安定 |
| `pnpm test:integration` | **104 passed / 9 files**（tests 765ms）|
| `pnpm lint` | **通過**（`Found 2 infos`、本 PR 由来ではない）|
| `pnpm format:check` | **通過** |

## 受け入れ基準の担保状況（Test 観点で見た分）

| AC | 担保箇所 | 判定 |
|---|---|---|
| AC-4 | `pbkdf2PasswordHasher.test.ts:190-194`（既定ハッシャーの先頭2フィールド）。`:91-96` は既定を踏んでいない（→ W-003） | ✅ |
| AC-5 | `:62` `expect(atob(derived ?? "")).toHaveLength(32)`（未変更）。salt 16 byte も `:61` | ✅ |
| AC-6 | `:101-104`（リテラル対応の固定・自己言及なし）/ `:127`（プロトタイプ由来キーの拒否）/ `hash()` が `SHIPPED_HASH` 直参照で1種類のみ書く | ✅（`__proto__` 等の網は W-002）|
| AC-7 | `:110-119`。フィクスチャは独立再計算で本物と確認、誤パスワードの `false` も固定済み | ✅ |
| AC-9 | `pbkdf2PasswordHasher.ts:38`（`ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID`）＋ `:283-296` の `@ts-expect-error` | ✅（覆う範囲の説明は W-004）|
| AC-10 | `grep -n "OWASP\|210k"` の残存4ヒットがすべて SHA-512 と 210,000 の組 | ✅ |
| AC-11 | `pnpm typecheck` 通過。両 directive が「使用中」であることを変異1・2 で確認 | ✅ |
| AC-14 | unit / integration / lint / format:check すべて通過 | ✅ |
| AC-3（テスト成果物として） | プローブがワークツリー・`git ls-tree -r HEAD`・`git diff --stat` のいずれにも無し。設定2ファイルの diff も空 | ✅（→ I-001）|

## カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `.thread/20/plan.md`, `.thread/20/steps.md`, `.thread/20/testing.md`, `.thread/20/adr.md`
- スキップ: `.thread/1/adr.md` — ADR-003 ほかの記述訂正（AC-12）で、テストコードにも型検査にも掛からないため Test 観点外
- スキップ: `.thread/1/progress.md` — 同上（AC-13 の記述訂正）。Test 観点で読むべき記述を含まない

（確認 8 件 + スキップ 2 件 = 変更ファイル一覧 10 件）
