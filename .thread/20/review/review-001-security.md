# レビュー 001 — Security（PR #53 / Issue #20）

対象: `origin/main...HEAD`（`issue/20/pbkdf2-cost-parameters`、3 コミット）
基準: `CLAUDE.md` / `spec/domains/identity.md` / `.thread/20/plan.md`

## Security

### Blockers

なし。

`PBKDF2-HMAC-SHA256 @ 210,000` → `PBKDF2-HMAC-SHA512 @ 210,000` の切り替えは、コスト面でも入力検証面でも後退していない。以下の3点は**実際に手を動かして確認した**（下記「検証の実施記録」）。

- タイミング等時化の型ピンは**双方向に効く**（ダミー側を動かしても、ピンを `string` へ広げても `pnpm typecheck` が落ちる）
- `ALGORITHM_ID` と `SHIPPED_HASH` のドリフトは往復テスト4件が確実に赤くする（ADR-002 の「二層で検出」という主張は実測で正しい）
- 旧形式のリグレッションフィクスチャは**本物**（`pbkdf2-sha256$1000$5faRifbz4tbABUNj0fGHwg==$…` が `password123` を実際に導出した値であることを独立に再計算して一致を確認）

### Warnings

- **[W-001]** 旧 `pbkdf2-sha256$` 行に対するタイミング残差が「実質ゼロ」から「実測で約 4.2 倍」に変わったが、その大きさがどこにも記録されていない
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:69-71`（JSDoc）/ `.thread/1/progress.md:9-13` / `.thread/20/adr.md:123`（ADR-002 Consequences）
  - 理由: 3箇所とも「残差は既存のものと**同じ向き**であり新種のチャネルではない」と書いて閉じている。向きの評価は正しいが、**大きさが桁で変わっている**。変更前は `progress.md` 自身が「反復回数を一度も上げていない現状では差は生じない」と書いていたとおり残差は文字どおりゼロだった。変更後は、本 PR が `.thread/1/adr.md` の実測節に自分で記録した CI 実測（`SHA-256 @ 210k = 30.2ms` / `SHA-512 @ 210k = 127.2ms`）から、**旧形式アカウントへの誤パスワードは未登録アドレスより約 97ms 速い**。これはネットワークノイズに埋もれる量ではなく、「そのアドレスは登録済みで、かつ #20 以前に作られた」を判別できる実用的な列挙オラクルである。`.thread/20/testing.md:225` が「残差は体感で区別できない」と書いているのは**変更前の前提**の記述で、97ms には当てはまらない
  - この残差が受容可能なのは「本番に `pbkdf2-sha256$` の行が1行も存在しない」という前提（plan.md「前提」/ steps.md ステップ1「着手前の確認」）が成立している場合に限られる。前提そのものは testing.md:58 で明言されているが、**「着手前の確認」を実施した記録が PR 成果物のどこにも無い**（AC-1/AC-2 は実測節に記録が残ったのに、前提確認だけ痕跡が無い）。ADR-002 の退役条件も「開発用 D1 の寿命が尽きた時点」という観測不能な条件と #18 の2択で、追跡先が付いていない
  - 提案: (a) `.thread/20/adr.md` ADR-002 の Consequences と `.thread/1/progress.md` の残差記述に、実測値（30.2ms vs 127.2ms、差 ~97ms）を数字で書く。「同じ向き」だけで済ませない。(b) 着手前の確認を実施した旨を1行どこかに残す。(c) 退役条件を #18 に紐付けて、#18 のチェックリストに「`hashFor` の `pbkdf2-sha256` 枝を削除する」を足す（ADR-002 は「削除に全ユーザーのログイン確認は要らない」と結論まで出しているので、行き先を付けるだけで閉じる）

- **[W-002]** 型ピンが覆っているのは `DEFAULT_PBKDF2_ITERATIONS`（既定値）であって、**ファクトリ引数で構築されたハッシャー**ではない。本番配線が `iterations` を渡した瞬間に等時化が無音で壊れる
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:214-222`（`options.iterations ?? DEFAULT_PBKDF2_ITERATIONS`）/ `packages/core/src/application/di/serverCloudflare.ts:145`
  - 理由: R-3 と AC-9 が塞いだのは「定数どうしのドリフト」で、実際その経路は完全に塞がっている（検証済み）。しかし等時化の成立条件は「ダミーの宣言コスト == **実際に配線されたハッシャー**のコスト」であり、`createPbkdf2PasswordHasher({ iterations: 50_000 })` を本番 DI に書けばダミー（210,000）のほうが**高くなって**オラクルが反転する。この経路は型検査にもテストにも一切引っかからない — アルゴリズムのほうは引数が無いので同じ穴は無く、反復回数だけが残っている。`.thread/1/adr.md:196` は「本番の配線は既定値をそのまま使い引数を渡さない**運用にする**」と書いており、防護は運用規約のみ。現状 `serverCloudflare.ts:145` は引数なしで正しいが、それを固定しているものが何も無い
  - 本 PR が導入した欠陥ではない（引数は以前から存在した）。ただし本 PR は「ピンで無音の退行を構造的に潰す」ことを主眼にした変更であり、**その主張の唯一の残穴**なので警告として挙げる
  - 提案: 安価な順に (a) `serverCloudflare.ts` の配線が引数を渡さないことを1件のテストで固定する（`createPbkdf2PasswordHasher` を spy して呼び出し引数が `undefined` であることを見る、あるいは組み上がったコンテナの `passwordHasher.hash()` の出力の2フィールド目が `String(DEFAULT_PBKDF2_ITERATIONS)` であることを見る）。(b) ファクトリ引数の存在理由が「テストのため」であることを型で示す（`createPbkdf2PasswordHasherForTests` を分離し、本番用は引数を取らない）。(a) だけでも「4本の DI ファクトリ」の運用規約が検証可能になる

- **[W-003]** 未認証エンドポイントの CPU 増幅係数が約 4.2 倍になったが、ログイン試行のレート制限は spec に定義がありながら**実装が存在しない**
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:139-159`（`burnVerificationTime` は未登録アドレスにも1導出を払わせる）/ `spec/domains/identity.md:412`
  - 理由: `spec/domains/identity.md:412` は `failedAttempts` / `nextAttemptAllowedAt` を `CredentialMapping` のフィールドとして定義し、天井・時間減衰・制限中の非カウントという3規則まで固定している。しかし `grep -rn "failedAttempts\|nextAttemptAllowedAt" packages apps` のヒットは**0件**で、コード上に抑止機構は一切無い（発信元単位のレート制限も `.adr/013:243` と `spec/database/index.md:785` が transport 境界の責務として #38/#51 へ送っており未実装）。この状態で、1リクエストあたりの実測 CPU が CI x86 で 30.2ms → 127.2ms になった。しかも `burnVerificationTime` の設計上、**存在しないアドレスを投げるだけで**この 127.2ms を消費させられるので、増幅にアカウントの存在すら要らない
  - CF Paid の CPU 予算（30 秒）に対して1リクエストは問題にならないという ADR-003 の訂正は正しく、これは「1リクエストが死ぬ」問題ではなく「同時実行と課金の増幅」の問題である。受け皿は既に #18（認証基盤のセキュリティ強化 / レート制限・rehash・CSRF）にあり、`.thread/1/adr.md:1017` も「レート制限の必要性はむしろ上がる。本 Issue の範囲外」と書いているので**スコープ判断としては妥当**
  - 提案: 数字を受け皿に残す。`.thread/1/adr.md` の「実測結果（#20 / 2026-08-07）」節（既に 127.2ms を記録している）に「この値が未認証リクエスト1本あたりの CPU コストであり、#20 で 30.2ms から 4.2 倍になった」を1行足し、#18 にコメントで同じ数字を渡す。#18 の優先度判断の入力が変わったのに、その事実がどちらの側にも書かれていないのが問題

### 観点別の結論（依頼された6点）

1. **タイミングオラクル / 無音の退行** — 出荷ハッシャーとダミーの**アルゴリズムと反復回数の両方**が型で結ばれており、片側だけ動かす変更は `pnpm typecheck` で止まる。実際に2種類の変異を注入して確認した（検証の実施記録を参照）。ピンを `: string` に広げるという「もっともらしいリファクタリング」も `@ts-expect-error` の未使用で落ちる。R-3 が名指しした「案 A はピンをすり抜ける」経路は塞がっている。残る無音の退行経路は W-002 の1本だけ
2. **旧 `pbkdf2-sha256$` の読み取り専用の枝 / ダウングレード** — **ダウングレード経路は増えていない。** `PasswordHash` が構築されるのは (i) `hash()` の出力、(ii) `DUMMY_PASSWORD_HASH` のモジュール定数、(iii) `entity.ts:205` の DB 行からの復元、の3箇所だけで、transport 境界から利用者入力が `parse()` に届く経路は存在しない（`PasswordHash.create` / `as PasswordHash` の全出現を確認）。`parse()` が受け入れる集合は `{sha256} × [1, MAX]` から `{sha256, sha512} × [1, MAX]` へ広がったが、広がったのは**より強い側**であり、弱い側（`sha256 @ 1` を含む低コスト行）は変更前から受け入れられていた。DB 書き込み権限を持つ攻撃者は変更前から任意のハッシュへ差し替えられるので、脅威モデル上の新しい能力は生まれていない。残るのは W-001 のタイミング残差だけ
3. **`parse()` の入力検証** — 4つの拒否軸すべてが `SystemError(DataIntegrityError)` に落ちることをコードとテスト表で確認した。プロトタイプ由来キー（`constructor$1000$…`）は `hashFor` が全域関数（`===` の2段比較）なので構造的に `null` を返し、テスト表にも1件ある。未知識別子・非数値/ゼロ/上限超/空白/指数/16進の反復回数・不正 base64 もすべて同じ型に落ちる。**「資格情報エラーに潰れる」経路は無い** — `verify` の throw は `burnVerificationTime` の `try` の**外**（`loginWithPassword.ts:161`）で起きるので握り潰されず、`testing.md` の異常系2がこれを実機手順としても持っている。`parse` は `parts.length !== 4` より先に `hashFor` を評価するが、両者は同一の `||` 式で同一のエラーになるので観測差は無い
4. **定数時間比較** — `timingSafeEqual` の実装も使い方も差分に無く、変更されていない（`packages/core/src/adapters/webcrypto/encoding.ts`）。長さ早期リターンは残るが、`DERIVED_BITS = 256` が据え置きで候補は**アルゴリズムに関係なく常に 32 byte**なので、SHA-512 化によって長さ比較が新しい情報を漏らすことはない。ダミーの digest も 32 byte、salt も 16 byte であることを独立にデコードして確認した（AC-5）
5. **コスト** — 210,000 は OWASP Password Storage Cheat Sheet の PBKDF2-HMAC-SHA512 の行と一致しており、取り違えの是正として正しい。JSDoc と `.thread/20/adr.md` ADR-001 が「OWASP の2つの数字は防御側コストのキャリブレーションであって、GPU/ASIC 耐性が理由ではない」と明示的に書き分けている点は特に良い（同種の誤帰属を訂正版に再生産していない）。DoS 面は W-003。CF Paid 30 秒予算に対する1リクエストの余裕は十分
6. **秘密の漏洩** — 問題なし。`SerializedErrorBase` は `{code, message, retryable}` のみで `cause` を運ばないので、`derive()` が包んだ WebCrypto 例外も `parse()` の `atob` 例外もクライアントへ渡らない。エラーメッセージにハッシュ値も平文も含まれない。`burnVerificationTime` は `cause.name` だけを投影してログに出す（`loginWithPassword.ts:104`）という既存の防御を維持している。テストフィクスチャの `password123` とその 1,000 回導出値はテスト専用の低コスト値で、本番の再利用可能素材ではない。ダミーハッシュの salt/digest を「任意のバイト列」のまま流用した判断（ADR-003）も正しい — 真正な導出を埋めると後の読み手が意味のある値だと誤解する

### 検証の実施記録

レビュー中に実際に実行して確認した項目（すべて実行後にワーキングツリーを復元済み。`git status` はクリーン）。

| # | 注入した変異 | 期待 | 結果 |
|---|---|---|---|
| 1 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID` を `"pbkdf2-sha256"` へ（ダミーの取り残しを再現） | typecheck が落ちる | **落ちた** — `TS2322: Type '"pbkdf2-sha512"' is not assignable to type '"pbkdf2-sha256"'` ＋ `TS2578: Unused '@ts-expect-error'` の2件 |
| 2 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: string` と型注釈を付ける（ピンの無音の無効化を再現） | typecheck が落ちる | **落ちた** — `TS2578: Unused '@ts-expect-error'`。`ALGORITHM_ID` 側の代入は通ってしまうので、**このケースを捕まえているのはテストファイルの `@ts-expect-error` 1本だけ**である点は認識しておく価値がある（テストを消すとピンが無音で死ぬ） |
| 3 | `SHIPPED_HASH` を `"SHA-256"` へ（`ALGORITHM_ID` は据え置き） | typecheck は通り、往復テストが赤くなる | **そのとおり** — typecheck 通過、ユニットテスト4件が FAIL（`verifies a password it hashed` ほか）。ADR-002 の「型ピン＋往復テストの二層」という主張は正しい |
| 4 | 旧形式フィクスチャの再計算（`pbkdf2Sync("password123", salt, 1000, 32, "sha256")`） | 埋め込み値と一致 | **一致**。フィクスチャは捏造ではなく実際に採取された値 |
| 5 | ダミーハッシュの salt / derived を base64 デコード | 16 byte / 32 byte | **16 / 32**（AC-5） |
| 6 | `pnpm vitest run …/pbkdf2PasswordHasher.test.ts` | 全通過 | **34 passed** |
| 7 | `pnpm --filter @repo/core typecheck` | 通過 | **通過**（AC-11） |
| 8 | プローブの撤去確認 | `git diff --stat` にも作業ツリーにも現れない | **撤去済み**。`vitest.config.integration.ts` / `.github/workflows/ci.yml` の diff も空（AC-3） |
| 9 | レート制限の実装有無 | — | `failedAttempts` / `nextAttemptAllowedAt` のコード上のヒット **0件**（W-003） |

### スコープ確認

`plan.md`「含まれないもの」を越えた変更は見つからなかった。

- `MIN_PBKDF2_ITERATIONS` / `MAX_PBKDF2_ITERATIONS` / `SALT_BYTES` / `DERIVED_BITS` はいずれも据え置き（diff で確認）
- rehash-on-login は混入していない — `verify` は読み取りのみで、書き込み経路は増えていない
- `spec/` への変更なし。`spec/domains/identity.md` の `PasswordHash` 節が「ハッシュ形式の検証はアダプターの責務」、`PasswordHasher` 節が「アルゴリズムとパラメータはアダプター実装の責務」と明示的に委譲しているので、方式変更は spec 違反にならないという plan.md の判断は正しい
- `vitest.config.integration.ts` / `.github/workflows/ci.yml` は無変更

## カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `.thread/20/plan.md`, `.thread/20/adr.md`, `.thread/20/steps.md`, `.thread/20/testing.md`, `.thread/1/adr.md`, `.thread/1/progress.md`
- スキップ: なし（10件すべて確認）

差分外で判断材料として読んだファイル: `packages/core/src/adapters/webcrypto/encoding.ts`（`timingSafeEqual` / `fromBase64` が無変更であることと、その挙動の確認）, `packages/core/src/lib/error.ts` / `packages/core/src/application/errors.ts`（`cause` がシリアライズされないことの確認）, `packages/core/src/application/di/serverCloudflare.ts`（本番配線が既定値を使うことの確認）, `packages/core/src/domain/identity/valueObject.ts` / `entity.ts`（`PasswordHash` の構築点の網羅）, `spec/domains/identity.md`。
