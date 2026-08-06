# レビュー 002 — Security

対象: PR #53（`issue/20/pbkdf2-cost-parameters` → `main`） / round 2 / ゼロベース

判定基準: `CLAUDE.md`（Input validation / Error handling / Cross-layer catch policy）、`spec/domains/identity.md`（`PasswordHash` / `PasswordHasher` — アルゴリズムとパラメータはアダプター責務と明示的に委譲）、`.thread/20/plan.md`（AC-4 / AC-5 / AC-6 / AC-7 / AC-8 / AC-9、R-3 / R-5 / R-9）。

## Security

### Blockers

なし。

round 1 の Blocker 2 件が扱っていた核心（アルゴリズム側の型ピン欠落）は解消しており、**変異注入で実際に効くことを確認した**（下記「検証記録」）。認証バイパス・ダウングレード・情報漏洩の経路は見つからなかった。

### Warnings

- **[W-001]** ダミーハッシュと出荷ハッシャーの照合が、**反復回数は実定数どうしのクロスチェック／アルゴリズムはハードコードのリテラル**という非対称になっている。結果、アダプター側の `: typeof …` ピンを外したうえでアルゴリズムだけを動かすと、この検証点は緑のまま通る
  - 場所: `packages/core/src/application/identity/__tests__/identity.integration.test.ts:645-655`（アサーションは `:653-655`、根拠のコメントは `:647-652`）。関連するコメントの主張は `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts:319-329`
  - 理由: 現在の正規表現は

    ```ts
    new RegExp(`^pbkdf2-sha512\\$${DEFAULT_PBKDF2_ITERATIONS}\\$`)
    ```

    で、**反復回数側はアダプターから import した `DEFAULT_PBKDF2_ITERATIONS` と、application 側で組み立てられた `dummy` の実値との突き合わせ**になっている（＝真のクロスチェック）。一方**アルゴリズム側はリテラル `pbkdf2-sha512` なので、突き合わせ相手は `dummy`（application 側）だけ**であり、アダプターの `ALGORITHM_ID` を一度も参照しない。変異注入で非対称を確認した:

    | 変異（いずれも `: typeof …` 注釈を外したうえで） | このテスト |
    |---|---|
    | `DEFAULT_PBKDF2_ITERATIONS` を 600,000 へ | **落ちる**（"burns against a hash the production hasher derives from" が唯一の失敗） |
    | `ALGORITHM_ID` / `SHIPPED_HASH` を SHA-256 へ | **通る**（失敗するのは別テスト TC-loginWithPassword-009 だけ） |

    後者で `verify(...).resolves.toBe(false)` も通ってしまうのは、旧 `pbkdf2-sha256` 読み取り枝が残っている以上、古いダミーが parse も verify も成功するからで、これは plan.md **R-3 が名指しした無音退行そのもの**である。そのため `identity.integration.test.ts:648-651` の「this is the only check left standing once the adapter's `: typeof …` pin is dropped」という記述は**事実として誤り**で、その役を実際に果たしているのは `:702` の `/^pbkdf2-sha512\$1000\$/`（保存された実ハッシュ側）である。同じ誤りが `pbkdf2PasswordHasher.test.ts:324-328` の「三層の分担」の説明にも入っている。コメントが守備範囲を過大に述べていると、将来 `:702` のほうが「重複」として整理される余地が残る
  - 提案: リテラルを残したまま、**アダプター側の実定数との突き合わせを1行足す**のが安全側かつ最小。`dummy` は application 側の `DUMMY_PASSWORD_HASH_ALGORITHM_ID` 由来、`ALGORITHM_ID` はアダプター側の別リテラルなので、**これは自己言及ではない**（`.thread/20/adr.md` ADR-002 が退けた `expect(hashFor(ALGORITHM_ID)).toBe(SHIPPED_HASH)` はアダプター内部で両辺を組み立てる形であり、別物）。反復回数側と対称になる

    ```ts
    expect(dummy).toMatch(new RegExp(`^pbkdf2-sha512\\$${DEFAULT_PBKDF2_ITERATIONS}\\$`));
    expect(dummy.split("$")[0]).toBe(ALGORITHM_ID); // 追加
    ```

    あわせて `identity.integration.test.ts:648-651` と `pbkdf2PasswordHasher.test.ts:324-328` のコメントを実態に合わせる（「only check left standing」の主体は `:702`）。**なお本 PR が出荷する構成では型ピンが効いているので、これは第2防護線の話であり実害はない。**

- **[W-002]** 未認証経路の CPU 増幅が 4.2 倍になったまま、レート制限が無い状態で出荷される
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:92-107`（`burnVerificationTime`）/ 記録は `.thread/1/adr.md`「実測結果（#20 / 2026-08-07）」節
  - 理由: ADR-026 の等時間化により、**未登録アドレスへのログイン試行にも1導出が課される**。CI x86_64 実測で 30.2ms → 127.2ms なので、**アカウントの存在すら不要な未認証リクエスト1本あたりの CPU が 4.2 倍**になる。ADR-003 がこの点を自ら記録し、受け皿を #18（「認証基盤のセキュリティ強化（レート制限 / rehash / CSRF 多層防御）」— レート制限を含むことを確認済み）としている点は妥当で、`spec/domains/identity.md` の `failedAttempts` / `nextAttemptAllowedAt` も未実装のまま
  - 提案: **本 PR での対応は不要**（受容済み・追跡先あり）。ただし「初回本番デプロイ前に閉じる」という本 Issue の前提の裏返しとして、**#18 のレート制限は初回デプロイまでにという期限を #18 側に明記しておく**ことを勧める。現状 #20 側の記録は「スコープ外・#18 へ」で止まっており、デプロイとの前後関係が書かれていない

- **[W-003]** `parse()` は salt / derived の**長さ**を検証しないので、`pbkdf2-sha512$1000$$` のような行が `SystemError(DataIntegrityError)` ではなく `verify → false` になる
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:143-188`
  - 理由: `atob("")` は throw しないため空文字列の salt / derived が `fromBase64` を通過する。`deriveBits` は 0 長 salt を受け付ける（node/workerd の WebCrypto で確認済み: 32 byte を返す）ので、その先の `timingSafeEqual(32 byte, 0 byte)` が長さ不一致で `false` を返す。**認証バイパスにはならない**（fail-closed であり、正しい導出結果を空にはできない）。また 32 byte の正しい derived を書ける攻撃者は DB 書き込み権限を持つので、それは既に別のゲームである
  - 提案: 契約としては「`parse()` はエンコードの検証、値の妥当性は `false`」で一貫しているので**そのままでよい**。plan.md の R-9 / AC-6 が言う「未知の識別子・不正な反復回数・不正な base64・フィールド数」はすべて `SystemError(DataIntegrityError)` に落ちることを確認済みで、長さはその列挙に含まれていない。もし埋めるなら `salt.length === SALT_BYTES && derived.length === DERIVED_BITS / 8` を `parse()` に足すが、**旧形式のフィクスチャや既存の拒否ケース表（`c2FsdA==$aGFzaA==`）の意味が変わる**ので、本 PR のスコープでは触らないことを勧める

### 確認した点（問題なし）

- **タイミングオラクル / 型ピンの実効性** — 変異注入4件すべてで検出された（下記「検証記録」M1・M2・M4・M5）。特に依頼にあった「**アルゴリズムと反復回数の両方がずれた場合**」（M4）は、`ALGORITHM_ID` と `DEFAULT_PBKDF2_ITERATIONS` の**2つの型エラーが独立に**出る。ピンは双方向で、application 側の定数を `: string` へ広げる編集（M5）も `@ts-expect-error` の TS2578 で落ちる
- **ダミーの計算量** — `pbkdf2-sha512$210000$` を宣言し、salt 16 byte / derived 32 byte（base64 デコードで確認）。出荷ハッシャーと同一の `SHA-512 @ 210,000` を1回導出する。`DERIVED_BITS = 256` 据え置きで PBKDF2 のブロック数は `ceil(32/64) = 1`（AC-5）
- **旧 `pbkdf2-sha256$` 枝にダウングレード経路は無い** — 書き出しは `hash()` の1経路だけで、常に `ALGORITHM_ID` + `SHIPPED_HASH`（`pbkdf2-sha512` / `SHA-512`）を使う。「verify 成功後に旧形式で書き戻す」経路は存在せず、`hashFor` の sha256 分岐は読み取り専用。リポジトリ全体を grep しても `pbkdf2-sha256` を**書く**コードは残っていない（残ったヒットは domain / d1 テストの不透明フィクスチャと JSDoc のみ、plan.md でスコープ外と明記）
- **`parse()` の入力検証** — フィールド数 4 以外（過少・過多・空文字列）、未知識別子、`constructor` / `__proto__`、非数値・0・上限超過・空白付き・指数表記・16進、不正 base64 のすべてが `SystemError(DataIntegrityError)`。`hashFor` が `===` 比較の全域関数なのでプロトタイプ由来キーは構造的に通らない（R-5 の (a)(b) 双方が閉じている）。**資格情報エラーへ潰れる経路は無い**: `verify` の throw は `burnVerificationTime` の外（`loginWithPassword.ts:161`）なので握り潰されず `SystemError` のまま伝播する
- **定数時間比較** — `timingSafeEqual` は長さ一致時に全バイトを `|=`/`^` で走査し早期 return しない。長さでの早期 return は encoding が長さを固定するため秘密ではなく、JSDoc に理由が書かれている。呼び出しは `verify` の1箇所のみ
- **golden vector の妥当性を独立検証** — `node:crypto.pbkdf2Sync` で再計算し、旧形式フィクスチャが SHA-256 由来（SHA-512 では不一致）、新形式フィクスチャが SHA-512 由来（SHA-256 では不一致）であることを確認。**両者ともアルゴリズムを判別する力を実際に持っている**。フィクスチャの平文はテスト用 `password123` のみで、秘密の混入は無い
- **`ALGORITHM_ID` / `SHIPPED_HASH` のドリフト** — 型では結ばれていないが、往復テストが検出する（M1 で 4 件失敗）。`.thread/20/adr.md` ADR-002 の主張どおり
- **秘密の漏洩** — `SystemError` のメッセージは保存値を一切エコーしない（`"Stored password hash is not in a recognised encoding"` 等の定型文のみ）。`toSerialized()` は `kind` / `code` / `message` / `retryable` だけを載せ `cause` を落とすので、`atob` / WebCrypto の native エラーも境界を越えない。`burnVerificationTime` のログは `cause instanceof Error ? cause.name : typeof cause` の射影で、値も平文パスワードも載らない（JSDoc に理由あり）。ラッチにより isolate ごと1回
- **本番配線** — `application/di/serverCloudflare.ts:145` は `createPbkdf2PasswordHasher()` を引数なしで呼ぶので既定値経路。型ピンが本番構成に対して効いている（`.thread/1/adr.md` が記録する「ファクトリ引数で構築した場合はピンが掛からない」残穴は、この配線を守る限り現実化しない）
- **spec からの逸脱なし** — `spec/domains/identity.md` の `PasswordHash` / `PasswordHasher` はアルゴリズムとパラメータをアダプター責務として明示的に委譲しており、方式変更は spec 違反にならない（plan.md「含まれないもの」と一致）
- **`.thread/1/progress.md` / `.thread/20/testing.md`** — 残差の向きだけでなく**大きさ（約 97ms）**を数字で記録し、「ノイズに埋もれるから安全」と書かずに「本番に旧形式の行が存在しない」を受容根拠に据えている。セキュリティ記述として正確

### 検証記録（変異注入）

いずれも実行後に `git checkout` で復旧し、`git status --short` が空であることを確認済み。ベースラインは unit 417 passed / integration 104 passed。

| # | 変異 | 反応 |
|---|---|---|
| M1 | `SHIPPED_HASH` → `"SHA-256"`（`ALGORITHM_ID` は据え置き） | `pnpm test:unit` 4 件失敗（往復・floor など） |
| M2 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID` → `"pbkdf2-sha256"` 単独 | typecheck TS2322（`ALGORITHM_ID`）+ TS2578（`@ts-expect-error`） |
| M4 | アダプターを SHA-256 @ 600,000 へ（**アルゴリズムと反復回数の同時ドリフト**） | typecheck TS2322 が**2件独立**（`ALGORITHM_ID` / `DEFAULT_PBKDF2_ITERATIONS`） |
| M5 | `DUMMY_PASSWORD_HASH_ALGORITHM_ID: string` へ型を広げる | typecheck TS2578（`ALGORITHM_ID` の `@ts-expect-error`） |
| M6 | `: typeof …` 注釈を外して SHA-256 へ | integration 1 件失敗（**TC-loginWithPassword-009 のみ**。burn テストは通過 → W-001） |
| M7 | `: typeof …` 注釈を外して 600,000 へ | integration 1 件失敗（**burn テスト**。→ W-001 の非対称の対照） |

### カバレッジ

- 確認: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`, `packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`, `packages/core/src/application/identity/loginWithPassword.ts`, `packages/core/src/application/identity/__tests__/identity.integration.test.ts`, `.thread/1/adr.md`, `.thread/1/progress.md`, `.thread/20/adr.md`, `.thread/20/plan.md`, `.thread/20/testing.md`
- 差分外で参照: `packages/core/src/adapters/webcrypto/encoding.ts`（`timingSafeEqual` / `fromBase64`）, `packages/core/src/application/errors.ts`（`toSerialized` の漏洩面）, `packages/core/src/application/di/serverCloudflare.ts`（本番配線）, `spec/domains/identity.md`
- スキップ: `.thread/20/review/review-001-{adapter,docs,security,test}.md`, `.thread/20/review/triage.md` — round 1 のレビュー成果物（Phase 8 で削除予定 / ゼロベース指示）
- スキップ: `.thread/20/steps.md` — 実装手順書。Security 観点の判定材料は plan.md / adr.md / 実コードで完結しており、手順の正しさは adapter・test 観点の担当
