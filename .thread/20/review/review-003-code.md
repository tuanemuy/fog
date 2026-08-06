# レビュー003 — Code (Adapter / Infrastructure + Security)

**PR:** #53 / **Issue:** #20 / **ベース:** main / **HEAD:** `06bb663`
**ラウンド:** 3（ゼロベース）
**日付:** 2026-08-07

---

## 総評

**実装（アダプター / ユースケース / テスト）は収束している。** 2ラウンドで手が入った箇所を実装と1行ずつ照合し、加えて分離ワークツリーで6通りの変異注入を行って「タイミングオラクルが無音で復活する経路」を実際に探したが、**どの経路も型検査かテストのいずれかが必ず赤くする**ことを実測で確認した（下記「変異注入の結果」）。フィクスチャ3件も `node:crypto` で独立に再計算して一致を確認済み。

Blocker は無い。Warning は3件で、いずれも**コメント／JSDoc の記述が実装や実測と食い違っている**類であり、コードの挙動を変える必要は無い。3件とも本 PR が新しく書いた／新しく成立しなくなった文である。

---

## Blockers

なし。

---

## Warnings

- **[W-001]** `burnVerificationTime` の JSDoc が挙げる例が、同じファイルで本 PR が新たに書いた JSDoc と正面から矛盾している（実装は後者が正しい）
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:77-79`（矛盾相手は同ファイル `:46-49`）
  - 理由: `:77-79` は
    > a hasher that cannot parse {@link DUMMY_PASSWORD_HASH} (**an algorithm swap that leaves this constant stale**) must not turn an unknown address into a 500.

    と、「アルゴリズムの差し替えでダミーが取り残される」ことを **parse 失敗＝throw の実例**として挙げている。ところが本 PR が追加した `DUMMY_PASSWORD_HASH_ALGORITHM_ID` の JSDoc（`:46-49`）は、**同じシナリオについて逆のことを書いている**:
    > Without that pin an algorithm swap that leaves the dummy behind **would still parse and still verify — no throw for `burnVerificationTime` to catch**, no warning

    実装を見ると後者が正しい。`hashFor` が `pbkdf2-sha256` を読み取り専用の枝として残しているため、このアダプターの中でアルゴリズムを差し替えてダミーを取り残しても、ダミーは**読めてしまう**。変異注入 F（`ALGORITHM_ID` のピンを外し、ダミーだけ `pbkdf2-sha256` へ動かす）で実測したところ **throw は起きず**、`SystemError` を投げないまま統合テストの正規表現だけが赤くなった。さらに現状はピンが効いているので、この差し替え自体がそもそもコンパイルを通らない。
    つまり `:77-79` の括弧書きは、**(a) ピンによってコンパイル不能になったシナリオを、(b) 実際には throw を生まない例として**挙げていることになる。`burnVerificationTime` の `catch` 自体は依然として正当（別のアダプター実装 — Argon2id や bcrypt — が DI で差し込まれれば、そのアダプターの `parse` は pbkdf2 エンコードを読めず throw する）なので、**誤っているのは括弧書きの例示だけ**である。round 1 / round 2 が1件ずつ見つけた「実装と噛み合わない根拠」と同じ系統で、しかも**本 PR が隣に書いた文が falsify している**という点でこのラウンド固有の問題。
  - 提案: 括弧書きを、ピンがカバーしない実際に残っているシナリオへ差し替える。例:
    > (a **different** `PasswordHasher` adapter being wired — the `typeof` pin only ties this constant to `createPbkdf2PasswordHasher`, not to whatever the container hands over)

    こうすると `:46-49` と役割分担が付き（ピン内＝コンパイルエラー、ピン外＝この `catch`）、2つの JSDoc が矛盾しなくなる。

- **[W-002]** `describe("ALGORITHM_ID")` が主張する「3層目」の帰属が、実測と食い違っている（同じファイル内にある本命の網に触れていない）
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:322-327`
  - 理由: コメントは
    > Three layers divide the work and only the first is type checking: this directive …; the round-trip tests above …; and **the literal `pbkdf2-sha512` regex in `identity.integration.test.ts`** for the adapter's `: typeof …` annotation being dropped outright

    と書いている。分離ワークツリーで実際にその状況（`ALGORITHM_ID` の `: typeof …` を外し、`ALGORITHM_ID` と `SHIPPED_HASH` を `pbkdf2-sha256` へ動かす＝変異注入 D）を作ると、赤くなったのは次のとおり:

    | 反応した検査 | 場所 |
    |---|---|
    | `pnpm typecheck`（TS2578 / 想定外に**赤くなる**） | `pbkdf2PasswordHasher.test.ts:330` |
    | `encodes algorithm, iterations, salt and derived key` | 同ファイル `:58` |
    | **`writes one identifier and derives with the digest it names`** | 同ファイル **`:102`** |
    | `takes the OWASP default for its algorithm when given no argument` | 同ファイル `:220` |
    | `TC-loginWithPassword-009` | `identity.integration.test.ts:704` |
    | ~~`burns against a hash the production hasher derives from`~~ | `identity.integration.test.ts:656` — **緑のまま** |

    問題は2点。**(1) 指し先が曖昧で、素直に読むと外れのほうを指す。** `identity.integration.test.ts` には `pbkdf2-sha512` のリテラル正規表現が**2つ**ある。`:656`（ダミー用）と `:704`（TC-009 / 保存行用）で、アダプター側のドリフトに反応するのは **`:704` だけ**である。にもかかわらず `:656` のほうが `ALGORITHM_ID` を名指しで論じるコメント（"Never rebuild the `pbkdf2-sha512` literal from `ALGORITHM_ID`"）を持っているので、「the literal `pbkdf2-sha512` regex」はそちらを指しているように読める。しかも `:649-655` 側は「drift on the adapter's side falls to the unit tests and to **TC-loginWithPassword-009** below」と正しく書いているため、2つのコメントが互いに違うことを言っている。
    **(2) 同じファイルの `:102` が第一の網なのに挙がっていない。** 実際に最初に赤くなるのはこのファイルの `expect(ALGORITHM_ID).toBe("pbkdf2-sha512")` である。コメントが「3層目は統合テスト」と書いているせいで、将来「`:102` はピンと重複だから消してよい」と読まれる余地がある。それは最も直接的な網を落とす編集になる。
    （なお細かい点として「only the first is type checking」も厳密ではない。ディレクティブの右辺リテラルが `"pbkdf2-sha256"` そのものなので、ピンを外して `pbkdf2-sha256` へ動かした場合は **`pnpm typecheck` も TS2578 で落ちる**。`argon2id` のような第三の値へ動かした場合だけ型検査が緑になる。）
  - 提案: 3層目を `TC-loginWithPassword-009`（`identity.integration.test.ts:704`）と**テスト名で**名指しし、`:102` のリテラル表明を第一の網として1句添える。例:
    > … and, if it drifts to a value this directive does not name, the literal assertions in this file (`writes one identifier and derives with the digest it names`) plus `TC-loginWithPassword-009` in `identity.integration.test.ts`, which reads the identifier back out of the stored row.

- **[W-003]** 旧枝の退役条件2（「#18 が入った時点」）が、rehash-on-login の成立条件と循環している
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:26-31`（原典は `.thread/20/adr.md:131-134`）
  - 理由: JSDoc は
    > the branch may be deleted once the development D1's remaining rows are gone **or #18's rehash-on-login lands, whichever comes first**

    と書いている。しかし **#18 の rehash-on-login は、旧枝が生きていることを前提にしか動かない** — ログインで旧形式の行を `verify` できて初めて「新方式で書き直す」に進めるからである。したがって「#18 が入った**時点**で削除してよい」は、#18 が旧行を掃き出す仕組みそのものを、掃き出しが終わる前に取り上げることになる。正しい条件は「#18 が入り、**かつ**残った旧形式の行が掃けた時点」で、これは条件1と実質同じものに収束する。`whichever comes first`（早いほう）という書き方が、この前倒しを明示的に許可してしまっている点が問題。
    影響は本番ゼロ行の前提が立っている限り開発用 D1 に閉じる（再登録で回復可能）ので Warning 止まりだが、**JSDoc は将来の読み手への恒久的な指示**であり、`.thread/20/adr.md:131-134` にも同じ形で書かれているので直すなら両方。
  - 提案: 条件2を落として条件1に一本化するか、「#18 が入り、旧形式の行が残っていないことを確認した時点」に直す。ADR 側の「削除に『全ユーザーが一度ログインしたか』の確認は要らない — 対象の行が**本番**に存在しないため」という根拠は本番については正しいので、条件を**本番向け（即削除可）と開発用 D1 向け（掃けたら削除可）に分けて書く**のが最も素直。
    あわせて同 JSDoc が指す `.thread/20/adr.md` ADR-002 は Phase 8 で `.adr/` 昇格の判定にかかる（triage 裁定4）。昇格した場合は参照先が動くので、Phase 8 のチェックリストに「この JSDoc の参照先の更新」を1行入れておくとよい。

---

## 変異注入の結果（分離ワークツリーで実施 / 実施後 `git worktree remove` 済み）

`git worktree add --detach HEAD` した独立ツリーで実施。共有ワークツリーは一切書き換えていない。

| # | 変異 | `typecheck` | unit | integration |
|---|---|---|---|---|
| A | `SHIPPED_HASH` だけ `SHA-256` へ（`ALGORITHM_ID` からドリフト） | 緑 | **×4**（往復テスト） | — |
| B | `ALGORITHM_ID` / `SHIPPED_HASH` / ダミー識別子を**そろって** `sha256` へ（協調ダウングレード） | **× TS2578** | **×3** | — |
| C | 反復回数ピンを外し、`DEFAULT_PBKDF2_ITERATIONS` を 400,000 へ（アダプター側ドリフト） | 緑 | **×1**（`declares the OWASP count …`） | **×1**（`burns against a hash …`） |
| D | アルゴリズムピンを外し、アダプターを `pbkdf2-sha256` へ | **× TS2578** | **×3** | **×1**（**TC-009**。`:656` は緑） |
| E | 反復回数ピンを外し、**ダミーだけ** 100,000 へ | 緑 | 緑 | **×1**（`burns against a hash …` が唯一の網） |
| F | アルゴリズムピンを外し、**ダミーだけ** `pbkdf2-sha256` へ（throw は起きない） | 緑 | 緑 | **×1**（`burns against a hash …` が唯一の網） |

**結論: タイミングオラクルが無音で復活する経路は見つからなかった。** ピンを外した状態でも、コスト・アルゴリズムのどちらのドリフトも必ず1件以上が赤くなる。特に E / F は「統合テストのランタイム比較が唯一の網になる」という `DEFAULT_PBKDF2_ITERATIONS` 側コメント（`:296-307`）と `identity.integration.test.ts:649-655` の記述をそのまま裏付けており、**この2つのコメントは実装と一致している**。食い違っていたのは W-002 の1箇所だけ。

なお C は `identity.integration.test.ts:649-655` の「drift on the adapter's side falls to the unit tests and to TC-009」を厳密には広げる（この統合テスト自体も赤くなる）が、**書かれていることが偽になるわけではない**（不足の記述であって誤りではない）ので指摘には挙げない。

## フィクスチャの独立検証

`node:crypto` で再計算し、テスト内のリテラルと一致することを確認した。

- SHA-512 golden vector（`:132`）: `pbkdf2Sync("password123", salt, 1000, 32, "sha512")` と一致 ✓、かつ同じ入力の SHA-256 導出とは**異なる**ことも確認 ✓（コメントの主張どおり、SHA-512 の枝が実際に走っている）
- 旧 SHA-256 リグレッションフィクスチャ（`:113`）: `pbkdf2Sync("password123", salt, 1000, 32, "sha256")` と一致 ✓（真正な旧形式であり、差し替え後にでっち上げたものではない）
- ダミーハッシュ（`loginWithPassword.ts:63`）: salt 16 byte / digest 32 byte ✓（`SALT_BYTES` / `DERIVED_BITS` と整合。中身はどのパスワードにも一致しない任意バイトで正しい）

## セキュリティ観点の確認

いずれも問題なし。

- **`parse()` の入力検証** — 未知識別子・空識別子・`constructor` / `__proto__`・過剰フィールド（5個）・不足フィールド・非数値／空白付き／指数表記／16進の反復回数・上限超過・不正 base64 のすべてが `SystemError(DataIntegrityError)` に落ち、**メッセージが経路ごとに同一**なので識別子の当てずっぽうに情報を返さない。`hashFor` が `===` の全域関数なのでプロトタイプ由来キーは構造的に入らない（表引きに戻したときの回帰網としてテストが残っているのも妥当）。salt / derived の長さ未検証は fail-closed（不一致は `false`）で裁定済み、再提案しない
- **定数時間比較** — `timingSafeEqual` は非短絡。ダイジェスト長が変わっても `derived` は常に 32 byte（`DERIVED_BITS` 据え置き）なので長さの早期 return が秘密を漏らさない前提も維持されている
- **ダウングレード経路** — 旧 `pbkdf2-sha256` の行を書き込むには DB 書き込み権限が要る（`hash()` は `ALGORITHM_ID` しか書かない）。`MAX_PBKDF2_ITERATIONS` の最悪ケースが SHA-512 化で約 1.4 秒 → 約 6.0 秒に伸びる件は同じ脅威モデル（DB 書き込み権限）に立つので定数据え置きの裁定に同意する。`parse()` に到達する文字列は「DB の列」と「ダミー定数」の2つだけで、リクエスト由来のものは無い
- **秘密の漏洩** — `PlainPassword` は `derive()` の `TextEncoder` 経由でしか使われず、`SystemError` のメッセージにも `cause` にも載らない。`burnVerificationTime` は `cause.name` / `typeof` しかログに出さず、警告はプロセス単位のラッチで1回。未認証トラフィックで信号を水増しできない
- **残差チャネル** — 旧 SHA-256 行への誤パスワードが未登録アドレスより約 97ms 速い件は、`.thread/1/progress.md` と `.thread/20/adr.md` ADR-002 に数値と向きつきで記録され、JSDoc 側は向きだけを「コストまたはアルゴリズム」へ広げている（数値は測定環境依存なので JSDoc に置かない、という切り分けは妥当）。#18 への引き渡しも明記されている

## レイヤー境界・依存方向・契約の確認

いずれも問題なし。

- **依存方向** — `adapters → application` の `import type` 1本のみ（`DUMMY_PASSWORD_HASH_ALGORITHM_ID` / `DUMMY_PASSWORD_HASH_ITERATIONS`）。plan.md R-10 の規定どおりで逆向きは無い。`import type` なのでランタイムの循環も生じない
- **ポート契約** — `PasswordHasher` のシグネチャは不変。不一致は `false`、計算失敗のみ `SystemError`。`spec/domains/identity.md`「PasswordHasher」がアルゴリズムとパラメータをアダプター責務と明示しているので spec 変更は不要（plan.md の判断どおり）。ドメインの `PasswordHash` は「非空」しか検証しない不透明文字列のままで、形式検証はアダプターに閉じている
- **エラー契約** — `parse()` の全拒否経路が `SystemErrorCode.DataIntegrityError`、`derive()` の失敗が `SystemErrorCode.CryptoError`。既存の分類を崩していない
- **公開 API の増分** — `hashFor` / `ALGORITHM_ID` の2つ。`@repo/core` はフラットな `"./*"` exports なので export はそのまま公開 API になるが、どちらもテストが直接呼ぶ（`:102-104`）ので根拠がある。round 2 で `Digest` の `export` が落ちたのも妥当で、`noEmit: true` なので宣言出力で非公開型が問題になることも無い（`packages/core/tsconfig.json` で確認）
- **`SHIPPED_HASH` を型で結ばない件** — 裁定1どおり現状維持。変異注入 A で「往復テスト4件が必ず赤くなる」ことを実測で再確認した。JSDoc（`:20-24`）の文言も裁定の指定どおり ADR-002 Decision（`.thread/20/adr.md:111`）と同一

## 受け入れ基準の検証

| AC | 判定 | 根拠 |
|---|---|---|
| AC-4 | ✓ | `takes the OWASP default for its algorithm when given no argument`（`:218-222`）が先頭2フィールドを表明 |
| AC-5 | ✓ | `DERIVED_BITS = 256` 据え置き。`:62` が `atob(derived)` の 32 byte を表明 |
| AC-6 | ✓ | `hashFor` は全域。拒否ケース表に `constructor` / `__proto__` の2行。`ALGORITHM_ID === "pbkdf2-sha512"` / `hashFor("pbkdf2-sha512") === "SHA-512"` をリテラルで固定（自己言及を避けた形になっている） |
| AC-7 | ✓ | 旧形式リグレッションテスト（`:106-118`）。フィクスチャの真正性を `node:crypto` で独立検証済み |
| AC-8 | ✓ | ダミーは `pbkdf2-sha512$210000$…`。統合テストが本番ハッシャーで実際に `verify` して `false` を返すことを確認している |
| AC-9 | ✓ | `ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID`。両側そろってピンが成立していることを変異注入 B / D / F で実測 |
| AC-10 | ✓ | `grep -n "OWASP\|210k\|210_000"` の残存ヒット5件はすべて SHA-512 と組になった記述 |
| AC-11 | ✓ | `tsgo` 緑（`@ts-expect-error` 2件とも「抑制すべきエラーあり」で成立） |
| AC-14 | ✓ | unit 417 passed / integration 104 passed / `biome lint` 緑 / `biome format` 緑（下記） |
| AC-15 | ✓ | `grep -n "SHA-256\|SHA256\|sha256"` の残存ヒット5件はすべて旧読み取り枝の説明 |

AC-1 / AC-2 / AC-3 / AC-12 / AC-13 は実測記録・ADR・進捗ドキュメントの領域なので Docs レビュアーの担当。AC-3 のうち**コード側で確認できる分**（`_probe.integration.test.ts` が `git diff --stat` にも `git status` にも現れないこと、`vitest.config.integration.ts` と `.github/workflows/ci.yml` の diff が空であること）は確認済み ✓。CI ラン URL の確認はこのレビューの範囲外。

## 品質ゲートの実行結果（分離ワークツリー / HEAD `06bb663`）

| コマンド | 結果 |
|---|---|
| `tsgo`（root / `packages/core` / `infra/cloudflare/pulumi`） | 緑 |
| `tsgo`（`apps/web`） | 本ワークツリーでは `Property 'DB' does not exist on type 'Env'` ×3 が出るが、これは `.gitignore` された生成物 `apps/web/worker-configuration.d.ts`（`pnpm cf:types` 生成）が新規ワークツリーに無いだけ。**本体ワークツリーでは緑**であることを確認済み。PR とは無関係 |
| `biome lint` | 緑（infos 2件は `biome.json` のスキーマ版ずれと `recommended` の非推奨警告で、PR と無関係な既存事象） |
| `biome format` | 緑 |
| `pnpm test:unit` 相当 | 24 files / **417 passed** |
| `pnpm test:integration` 相当 | 9 files / **104 passed** |

---

## カバレッジ

- **確認:**
  - `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`（全文 + JSDoc 1行ずつの照合 + 変異注入6件）
  - `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`（全文 + コメントの主張を実測で検証 + フィクスチャの暗号学的再計算）
  - `packages/core/src/application/identity/loginWithPassword.ts`（全文 + JSDoc 照合）
  - `packages/core/src/application/identity/__tests__/identity.integration.test.ts`（差分周辺 `:620-710` と関連コメント）
  - `.thread/20/plan.md`（受け入れ基準・スコープ・R-1〜R-10 の検証）
  - `.thread/20/adr.md`（ADR-002 全文 — 退役条件・前提確認・残差の記録。W-003 の原典）
  - `.thread/1/progress.md`（差分全体 — 残差チャネルの記録がセキュリティ観点に直結するため）
  - 参照のみ: `packages/core/src/adapters/webcrypto/encoding.ts`, `packages/core/src/domain/identity/valueObject.ts`, `packages/core/tsconfig.json`, `spec/domains/identity.md`, `spec/inventory/adapter.md`, `docs/test.md`, `CLAUDE.md`
- **スキップ:**
  - `.thread/20/review/**`（9ファイル） — 過去ラウンドのレビュー成果物。`triage.md` の `## 裁定メモ` のみ読了し、裁定済み事項（`SHIPPED_HASH` の表引き / ファクトリ引数のテスト / `parse()` の長さ検証 / レート制限・rehash-on-login）は再提案していない
  - `.thread/20/steps.md` / `.thread/20/testing.md` — 実装手順書と動作確認計画。Docs / Test レビュアーの担当領域で、コード観点で追加できる知見が無い
  - `.thread/1/adr.md` — 訂正注記・ADR-003 の実測節を数値の裏取りのため参照したが（OWASP の3行 1,300,000 / 600,000 / 210,000 が公式表と一致することは確認）、**訂正の網羅性・分類規則の一貫性の判定は Docs レビュアーの担当**としてスキップ

---

## 判定

**マージ可能。** Blocker は無く、Warning 3件はいずれもコメント／JSDoc の文言修正のみで挙動に影響しないため、マージ前に直すのが望ましいが、ブロックはしない。
