# レビュー 001 — Adapter / Infrastructure 観点

- 対象 PR: #53（`issue/20/pbkdf2-cost-parameters` → `main`）
- 契約: `.thread/20/plan.md` / `.thread/20/steps.md` / `.thread/20/adr.md`
- 判定: **Blocker 0 / Warning 6**

## Adapter / Infrastructure

### Blockers

**なし。**

レイヤー境界・ポート契約・エラー契約・後方互換・DI 配線のいずれにも、マージを止める逸脱は見つからなかった。検証の実測は「補足: 実際に確認したこと」に列挙する。

### Warnings

- **[W-001]** `SHIPPED_HASH` と `ALGORITHM_ID` / `hashFor` の対応が型で結ばれておらず、ADR-002 が退けた「表引き」には両方を満たす3択目がある
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:26-45`
  - 理由: 書き出し経路に `null` / `undefined` が現れないことは**型で保証されている**（`SHIPPED_HASH: "SHA-512"` → `derive(hash: "SHA-256" | "SHA-512")`）。ここは満点。残る穴は「`ALGORITHM_ID` が名乗る識別子と `SHIPPED_HASH` が実際に渡すダイジェストが一致すること」で、これは型に何も出ていない。`.thread/20/adr.md` ADR-002 は「型ピン＋往復テストの二層で検出できる」としてこれを許容しており、その主張自体は正しい（`ALGORITHM_ID` と `DUMMY_PASSWORD_HASH_ALGORITHM_ID` をそろえて `pbkdf2-sha256` へ倒すと typecheck は通るが、`hash()` が書いた値を `verify()` が別ダイジェストで導出するので `it("verifies a password it hashed")` が落ちる）。問題はその手前の選択肢の切り方で、ADR-002 / steps.md ステップ5 は表引きの検討を「素の object → プロトタイプキー」「`Map` → `.get()` の `undefined` が書き出し経路に乗る」の2択に閉じている。**`.get()` の `undefined` が書き出し経路に乗るのは、書き出し側が `string` 型のキーで表を引いた場合だけ**であり、リテラル型の定数で引けば起こらない。つまり `CLAUDE.md`「Make illegal states unrepresentable at the type level before falling back to runtime checks」に照らすと、テスト（＝runtime check）に落としきる前に取れる型の手が1つ残っている。
  - 提案: 対応を1箇所に集約し、`SHIPPED_HASH` をリテラル型のキーで引いて導出する。下記は本レビューで `tsc --strict` にかけて通ることを確認済み（`SHIPPED_HASH` が `"SHA-512"` に推論され、`ALGORITHM_ID` をダミーごと `pbkdf2-sha256` へ倒すと `SHIPPED_HASH` も自動で `"SHA-256"` になり、食い違いが表現できなくなる）。`hashFor` は引き続き**比較**で書くので、プロトタイプ由来キーが真値を返す穴も開かない。

    ```ts
    type Digest = "SHA-256" | "SHA-512";

    const ALGORITHMS = {
      "pbkdf2-sha512": "SHA-512",
      "pbkdf2-sha256": "SHA-256",
    } as const satisfies Record<string, Digest>;

    export const hashFor = (algorithm: string): Digest | null =>
      algorithm === "pbkdf2-sha512"
        ? ALGORITHMS["pbkdf2-sha512"]
        : algorithm === "pbkdf2-sha256"
          ? ALGORITHMS["pbkdf2-sha256"]
          : null;

    export const ALGORITHM_ID: typeof DUMMY_PASSWORD_HASH_ALGORITHM_ID = "pbkdf2-sha512";

    // 型: "SHA-512"。`hashFor()` を引かないという性質はそのまま。
    const SHIPPED_HASH = ALGORITHMS[ALGORITHM_ID];
    ```

    採らないなら採らないでよいが、その場合は ADR-002 の「表を持つ理由が無い」の根拠を「`Map.get()` は書き出し経路を部分関数にする」から「リテラル型キーで引けば全域にできるが、2方式では表の維持コストが上回る」へ直しておきたい。現在の根拠のままだと、次に方式が3つ目に増えたときに同じ判断が再現できない。

- **[W-002]** ログイン1回あたりの Worker CPU が実測 4.2 倍になったが、その影響が「30 秒の上限に収まる」以外の観点で記録されていない
  - 場所: `.thread/1/adr.md`（ADR-003 Consequences の訂正ブロック / 「実測結果（#20 / 2026-08-07）」節）、`packages/core/src/application/identity/loginWithPassword.ts:92-107`
  - 理由: 同一の CI（x86_64）実測で `SHA-256 @ 210,000` = 30.2ms（＝#20 以前の出荷値）に対し `SHA-512 @ 210,000` = 127.2ms。**約 4.2 倍**である。ADR の訂正ブロックは「Paid の既定 30 秒に対して数十〜百数十 ms は問題にならない」と結んでいるが、これは**1 invocation の CPU 上限**の話だけで、(a) Workers Paid は CPU 時間課金なので**ログイン試行あたりのコストがそのまま 4.2 倍**になること、(b) ADR-026 の等時間化により**未登録アドレス宛のログイン試行も同じ 127ms を必ず払う**こと、の2点が未評価のまま残っている。しかも `grep -rni "rate limit|ratelimit|throttle" packages/core/src apps/web/app` はヒット0で、**リポジトリにレート制限は存在しない**。ADR-026 の Consequences 自身が「未登録アドレスへのログイン試行も本物と同じ CPU を消費するので、レート制限の必要性はむしろ上がる。本 Issue の範囲外」と書いており、本 PR はその倍率を 4.2 倍に引き上げながら、その記述を更新していない。plan.md の R-6 も増分を「1 回あたり 2〜3 倍」と見積もっており、実測 4.2 倍と乖離している。方式選択（G-1）自体は事前定義のゲートどおりで、これは選択の妥当性への異議ではない。
  - 提案: ADR-003「実測結果」節の観測項目に「#20 以前の出荷構成（SHA-256 @ 210k = 30.2ms）比で 4.2 倍」の1行を足し、`.thread/1/progress.md` の「意図的にスコープ外とした項目」か既存の Issue（レート制限）へ**未認証経路の CPU 増幅が 4.2 倍になった事実**を送る。plan.md「含まれないもの」が「重さは別 Issue へ切り出す」を退路として用意しているので、それに乗せる形でよい。

- **[W-003]** `hashFor` の JSDoc が説明している WHY が、この実装では成立しない
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:17-21`
  - 理由: 「a `Map` would put `undefined` in the return type, which the write path would then have to cope with」と書いてあるが、**この実装の書き出し経路は `hashFor` を一切引かない**（`hash()` は `SHIPPED_HASH` を直参照する。43 行の JSDoc がそう明言している）。したがって `hashFor` が `Map` だろうと書き出し経路には何も届かない。表を避ける根拠として実際に成立しているのはプロトタイプキーの方だけである。`CLAUDE.md`「Add one only when the WHY is non-obvious」に従って残したコメントの WHY が、隣の定数の JSDoc と読み合わせると矛盾する状態になっている。
  - 提案: `Map` の一節を落とし、プロトタイプキーの根拠に絞る（あるいは W-001 の形を採るなら、根拠ごと書き直す）。

- **[W-004]** ダイジェスト名のユニオンが3箇所に手書きで、`StoredHash.hash` はこのモジュールの `hash` という語の他の用法と衝突している
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:26`（`hashFor` の戻り）、`:97`（`StoredHash.hash`）、`:107`（`derive` の第4引数）
  - 理由: このモジュールで `hash` は既に3つの意味を持つ ―― ポートのメソッド名 `hash()`、`verify(plain, hash: PasswordHash)` の引数、そして今回足された「WebCrypto のダイジェスト名」。`stored.hash` が `PasswordHash` ではなく `"SHA-512"` を指すのは読み手の負担になる。ユニオン自体も名前を持たないまま3箇所に散っており、`CLAUDE.md`「Prioritize type safety; lean on TypeScript's type system fully」の趣旨からは1つの名前付き型にまとめたい（Argon2id 枝を足すときに触る箇所がそのまま3箇所になる）。
  - 提案: `type Digest = "SHA-256" | "SHA-512"` を1つ置いて3箇所から参照し、`StoredHash.hash` は `digest` へ、`derive` の引数も `digest` へ改名する。`crypto.subtle.deriveBits` へ渡すときだけ `{ hash: digest }` と書けば、WebCrypto 側の語彙とアダプター内部の語彙の境界がはっきりする。

- **[W-005]** `it("defaults to the OWASP count for the algorithm it ships")` は**既定値で作ったハッシャーを観測していない**
  - 場所: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:91-96`
  - 理由: このテストが `hash()` を呼んでいるのはファイル先頭の `hasher`（`iterations: 1_000`）であって `createPbkdf2PasswordHasher()` ではない。したがって「defaults」を実証しているのは `expect(DEFAULT_PBKDF2_ITERATIONS).toBe(210_000)` の定数比較だけで、`hash.split("$")[0]` の側は 55 行の `it("encodes algorithm, iterations, salt and derived key")` と同じ対象・同じ期待値の重複になっている。steps.md ステップ6-1 は「AC-4 の『表明がアダプター単体テストに置かれている』を満たすのはこの1件」と名指ししているが、AC-4 の本文は「`createPbkdf2PasswordHasher()` の出力の先頭2フィールドで確認でき」であり、それを実際に満たしているのは **190-193 行の `it("takes the OWASP default for its algorithm when given no argument")`**（引数なしで作ったハッシャーの先頭2フィールドを両方見ている）である。AC-4 は満たされているが、満たしている場所が契約の指名先とずれており、指名先の方は名前と検証内容が一致していない ―― これは本 Issue がまさに是正した「テスト名と期待値のずれ」の小型版である。
  - 提案: 91-96 行から `hasher.hash()` 呼び出しを落として `DEFAULT_PBKDF2_ITERATIONS` のピンだけにする（名前も `"defaults to the OWASP count for SHA-512"` 等へ）か、逆に `createPbkdf2PasswordHasher()` を使って本物の既定値経路を観測する。後者を採るなら 190-193 行と統合してしまってよい。

- **[W-006]** 書き手の居なくなった `pbkdf2-sha256` 読み取り枝の退役条件が、コードからも `.adr/` からも辿れない
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:23-24`, `:197-200`
  - 理由: JSDoc は「kept for rows written before #20; nothing writes it any more」までしか言っておらず、いつ消してよいかが書かれていない。退役条件（開発用 D1 のデータの寿命が尽きた時点、または #18 の投入時点）は `.thread/20/adr.md` ADR-002 にだけあり、そこは `Status: Proposed` の thread ローカル文書で `.adr/` へ昇格していない。`.thread/` は作業ログとして扱う運用（plan.md「含まれないもの」/ R-7）なので、**恒久コードが残す唯一の死に枝の退役条件が、恒久の参照先を持たない**。この枝を踏むのは `__tests__/pbkdf2PasswordHasher.test.ts:110` のリグレッションテスト1件だけなので、条件を知らない将来の読み手には「消してよいのか分からない枝」として残り続ける。
  - 提案: 23-24 行の JSDoc に退役条件そのもの（1行で足りる: 「開発用 D1 の既存行が尽きるか #18 の rehash-on-login が入れば削除してよい ―― 本番にこの形式の行は存在しない」）を書くか、`.thread/20/adr.md` ADR-002 を `.adr/` へ昇格させて JSDoc からそれを参照する。#50 で `.thread/1/adr.md` の判断を `.adr/013` へ昇格させた前例があるので、後者はこのリポジトリの既定の作法に乗る。

## 補足: 実際に確認したこと

Warning に上げるほどではないが、観点として名指しされていた項目の検証結果を残す。

- **レイヤー境界 / 依存方向 ―― 問題なし。** アダプターから application への参照は `import type` の2件（`DUMMY_PASSWORD_HASH_ALGORITHM_ID` / `DUMMY_PASSWORD_HASH_ITERATIONS`）で、型のみ・実行時のエッジは生まれない。逆向きは無い（`loginWithPassword.ts:1-10` の import は domain / `../errors` / `../ports` / `../types` のみで、`ALGORITHM_ID` を adapters から引いてはいない ―― plan.md R-10 の要求どおり）。`adapters → application` は `CLAUDE.md`「adapters implementing ports defined inward of them」に照らして内向きで合法。
- **ポート契約 ―― 崩れていない。** 不一致は `timingSafeEqual` の `false`（`verify` は `parse` / `derive` 以外に throw する経路を持たない）、計算失敗は `SystemError(CryptoError)`。ダミーの digest は 32 byte、SHA-512 から 256 bit 導出した候補も 32 byte なので `timingSafeEqual` は長さ不一致で早期に崩れず設計どおり `false` を返す。`PasswordHasher` の「例外に `PlainPassword` を載せない」条項も、`derive` の catch が `cause` に WebCrypto 例外を載せるだけで平文に触れていない（既存どおり）。
- **エラー契約 ―― 既存の使い分けどおり。** 未知の識別子は `hash === null` として既存の「not in a recognised encoding」に合流し `SystemError(DataIntegrityError)`。`CryptoError` は `derive` の catch だけ。`application/errors.ts:189-193` のコメント（「`DataIntegrityError` は*保存された*ハッシュが読めないときのもの」）と一致している。plan.md R-9 の要求を満たす。
- **後方互換 ―― 実データで検証した。** テストに埋め込まれた旧形式フィクスチャ `pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$6hroV6AYx3/sZCNZ2b6b5dEvGwem7QxDxqru/lNUeiQ=` を Node の `crypto.pbkdf2Sync("password123", salt, 1000, 32, "sha256")` で独立に再計算し、**base64 が完全一致**することを確認した（AC-7 の「方式を差し替える前に採取したもの」が事実であることの裏取り）。保存形式の文字列長も不変（`pbkdf2-sha256` と `pbkdf2-sha512` は同じ 13 文字、salt 16 byte / derived 32 byte も据え置き）なので、D1 のスキーマ・マイグレーションへの影響は無い。
- **`DERIVED_BITS = 256` は SHA-512 でも正しい。** PBKDF2 のブロック数は `ceil(dkLen / hLen)` = `ceil(32 / 64)` = 1 なので、SHA-256 のときと同じく 1 ブロック。反復回数が実効的に倍になる（`ceil` が 2 以上になる）罠は踏んでいない。
- **DI 配線 ―― 取りこぼし無し。** `createPbkdf2PasswordHasher` の本番呼び出しは `packages/core/src/application/di/serverCloudflare.ts:145` の1箇所のみで、引数なし＝既定値なので自動追随する。環境変数・wrangler の設定値・シードデータのいずれにもハッシュ方式は現れない（`grep -rn "pbkdf2|PBKDF2"` の全ヒットを確認し、残りはテストとドメインの不透明フィクスチャだけ）。
- **公開 API の増加 ―― 許容範囲。** `@repo/core` の `exports` は `"./*": "./src/*.ts"` なので `hashFor` / `ALGORITHM_ID` は外部から到達可能になる。ただし既に `DEFAULT_PBKDF2_ITERATIONS` / `MIN` / `MAX` が同じ理由（テストからの参照）で export されている前例があり、steps.md ステップ6-10 がその前例に従うと明示している。`hashFor` は純関数、`ALGORITHM_ID` はリテラル定数で、どちらも外部から呼ばれても状態を壊さない。**ただし** ポート契約（`domain/identity/ports/passwordHasher.ts`）は「エンコードは完全にアダプターの business」と宣言しているので、presentation などから `ALGORITHM_ID` を引いて保存値を分岐する使い方は契約違反になる。将来この2つに外部の読み手が現れたら、その時点でレビューで止める前提だけは共有しておきたい。
- **`spec/` への影響 ―― 無し（plan.md の主張どおり）。** `spec/domains/identity.md:274` / `:574` と `spec/inventory/adapter.md:52` はいずれもアルゴリズムを「アダプター実装の責務」として委譲しており、`Argon2id 等` としか書いていない。方式変更は spec 違反にならない。なお `ADP-identity-012` の「実行位置は Durable Object の外」という制約は、1 導出 127ms になったことで**むしろ重みを増した**（#51 の DO 移行時に効いてくる）。
- **AC-15 の grep 基準について。** 残存する `SHA-256` ヒットのうち `:52`（「The SHA-256 row of the same table is 600,000」）は、AC-15 の文言「案 A なら旧読み取り枝の説明だけ」の literal な範囲からは外れる。ただし内容は正しく、かつ本 Issue が是正した誤帰属の再発防止として機能しているので、逸脱ではなく AC-15 の文言の方が実装より狭かったと読むべきだと考える。指摘としては挙げない。
- **ローカル実行での確認。** `pnpm typecheck` 通過（`@ts-expect-error` 2件がいずれも「抑制すべきエラーあり」で成立していること＝ AC-9 / AC-11 の裏取りを含む）。`vitest run packages/core/src/adapters/webcrypto` は 83 件通過・テスト実時間 92ms（本番強度の導出を踏むのは 190-193 行の1件だけなので、plan.md R-6 が懸念した `docs/test.md` の「unit は数〜十数 ms」への増分は実害無し）。`vitest run --config vitest.config.integration.ts packages/core/src/application/identity` は 36 件通過（AC-8 の workerd 上での裏取り）。捨てプローブ `_probe.integration.test.ts` は `git diff --stat` にも作業ツリーにも存在せず、AC-3 の撤去も確認した。

## カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`
- 確認: `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`
- 確認: `packages/core/src/application/identity/loginWithPassword.ts`
- 確認: `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- 確認: `.thread/20/plan.md`（受け入れ基準 AC-4〜AC-9 / AC-15 とスコープ「含まれないもの」を本観点の判定基準として使用）
- 確認: `.thread/20/adr.md`（ADR-001 の判定ゲートと実測値、ADR-002 の枝保持と型ピンの根拠）
- 確認: `.thread/20/steps.md`（設計節・ステップ5・ステップ6 と実装の一致を照合。実装は steps.md の指定どおり）
- 確認: `.thread/20/testing.md`（保存ハッシュの目視確認手順が新形式・旧形式の両方を覆っていることのみ確認。手動テスト計画そのものの妥当性は本観点の対象外）
- 確認: `.thread/1/adr.md`（ADR-003 の実測結果節・CPU 予算の訂正・ADR-026 / 034 の方式名追随 ―― W-002 の根拠）
- 確認: `.thread/1/progress.md`（`ADP-identity-012` の方式名と残余チャネルの記述が JSDoc と対で広がっているか）
- スキップ: なし（変更ファイル10件すべてを確認した）
