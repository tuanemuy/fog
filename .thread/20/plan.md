# 実装計画 — Issue #20: パスワードハッシュのコストパラメータを見直す（PBKDF2 反復回数の OWASP 取り違え / SHA-512 化）

**Issue:** #20
**作成日:** 2026-08-07
**複雑度:** 中〜大規模
**実装方針:** steps.md

---

## 目的

`DEFAULT_PBKDF2_ITERATIONS = 210_000` に付いた「OWASP の PBKDF2-HMAC-SHA256 推奨」というコメントは取り違えで、210,000 は OWASP の **SHA-512 の行**の数字である（SHA-256 は 600,000）。workerd での実測を経て案 A（SHA-512 + 210,000）／案 B（SHA-256 + 600,000）を確定し、実装・テスト・ADR-003 の記述を確定した方式へ揃える。**本番データが存在しないうちに閉じることで、ハッシュ移行を一切発生させない**。

## 前提

**初回本番デプロイが未実施であること。** 「移行処理が一切要らない」「旧 `pbkdf2-sha256$` 枝が守るのは開発用 D1 のデータだけ」「`pbkdf2-sha256$` 形式の行は本番に一度も存在しない」はいずれもこの前提の上に立っている。Issue が挙げた2つの期限のうち「PR #17 のマージ前」は既に経過しており（#17 は 2026-07-25 に main へマージ済み）、残っているのはこの一本だけである。**着手時に確認する**（steps.md ステップ1 の「着手前の確認」）。成立していなければ本計画は破棄し、#18（rehash-on-login）との統合として再設計する。adr.md ADR-002 の退役条件はこの前提と対になっている。

## 受け入れ基準

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `PBKDF2 + SHA-512 @ 210,000` の疎通可否（G-0）が確定していること（**ローカル workerd での先行実測により既に「通過」で確定済み** — steps.md ステップ1。実装者の再実行でも同じ結果が得られる）。そのうえで、**G-0 / G-0b のいずれかで案が確定した場合**はその事実（G-0 なら例外の `name` / `message`、G-0b なら `BATCH` を上限まで上げても中央値が 0 だった観測）が記録されていること。**それ以外の場合**は **CI（`.github/workflows/ci.yml` の `integration` ジョブ / `runs-on: ubuntu-latest` ＝ x86_64）の実測**で `SHA-512 @ 210k` / `SHA-256 @ 600k` の min / 中央値 / max が取れていて、**CI のワークフロー実行 URL とともに**記録されていること。数値の回収はプローブが故意に投げる `Error` のメッセージ（`[#20-probe] {…}`）から行い、**ローカルと CI で回収手段は同一**である | Issue「⚠️ 決める前に workerd で実測する」1-3 | 1, 8 |
| AC-2 | 実測値を steps.md の判定ゲートに当てはめた結果として案 A / 案 B のどちらかが確定し、**採否の理由が実測値とゲートの行番号（G-0 / G-0b / G-1 / G-2）の対応として説明できる**（実装者の主観判断が入らない。ゲート表の外に追加条件が無い — 100 ms は判定に使わない観測項目であり、ゲートには現れない）。その対応がステップ8-3 の実測節に書かれている | Issue「対応項目」1 | 2, 8 |
| AC-3 | 捨てプローブ `packages/core/src/application/identity/__tests__/_probe.integration.test.ts` が撤去されている（`git status` にも `git diff --stat` にも現れない）。**設定ファイルの一時編集はそもそも発生していない**（`vitest.config.integration.ts` と `.github/workflows/ci.yml` の diff が空）。さらに**プローブ撤去後の CI ランで `integration` ジョブが緑に戻っている**（プローブ入りのコミットでは REPORT テストが故意に失敗するため赤くなるのが想定内であり、その赤が残っていないこと） | Issue「⚠️」4 | 3, 10 |
| AC-4 | 出荷されるハッシュのアルゴリズムと反復回数が確定した案どおりである（`createPbkdf2PasswordHasher()` の出力の先頭2フィールドで確認でき、その表明がアダプター単体テストに置かれている） | Issue「対応項目」2 / Issue 5-2 | 4, 5, 6 |
| AC-5 | `DERIVED_BITS` が 256 のままで、`hash()` の出力の derived が base64 デコードして 32 byte である | Issue「出力長についての注意」 | 5, 6 |
| AC-6 | **案 A の場合のみ**: `parse()` が `pbkdf2-sha512$` を読めて、書き出す識別子は `pbkdf2-sha512` の1種類だけである。かつ **`hashFor()` が対応しない識別子（`constructor` などプロトタイプ由来のキーを含む）は `SystemError(DataIntegrityError)` になる**（拒否ケース表に1件ある）。さらに **書き出す識別子と実際に WebCrypto へ渡す hash 名の一致が、リテラルを使ったアダプター単体テストで固定されている**（`hashFor("pbkdf2-sha512") === "SHA-512"` と `ALGORITHM_ID === "pbkdf2-sha512"`。定数どうしを突き合わせる形は自己言及になるので採らない） | Issue「対応項目」3 / R-5 | 5, 6 |
| AC-7 | **案 A の場合のみ**: 既存の `pbkdf2-sha256$` 形式のハッシュが引き続き `verify` でき、その振る舞いを固定するテストがある（→ adr.md ADR-002 で「残す」を選択）。フィクスチャは方式を差し替える前に採取したもの | Issue「対応項目」3-1 | 3, 5, 6 |
| AC-8 | `loginWithPassword` のダミーハッシュが確定した方式で `PasswordHasher.verify` に**読める**（`SystemError` を投げない）状態であり、かつ**本番ハッシャーと同じ計算量を burn する** | `spec/inventory/adapter.md:53`（ADP-identity-013）/ ADR-026 | 4, 5, 7 |
| AC-9 | ダミーハッシュと出荷ハッシャーの**アルゴリズム識別子**の一致が、テストではなく**型検査**で強制されている（反復回数について既にある `typeof` ピンと同じ形。ピンは application 側の定数とアダプター側の宣言の**両側がそろって初めて成立する**。案 A のみ） | research.md D-2 | 4, 5, 6 |
| AC-10 | 取り違えた主張を固定している記述（テスト名・期待値・コメント）が `pbkdf2PasswordHasher.test.ts` に残っていない — 具体的には `it("defaults to the OWASP iteration count")`（88-90 行）、23-25 行のコメント「Production strength is 210k iterations」、`it("takes the OWASP default when given no argument")`（157-160 行）の3箇所。検証は `grep -n "OWASP\|210k" packages/core/src/adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts` の残存ヒットが、**確定した方式と組になった記述だけ**であること | Issue「対応項目」5-1 | 6 |
| AC-11 | `pnpm typecheck` が通る（`@ts-expect-error` が「抑制すべきエラーが無い」で落ちないことを含む） | research.md D-5 | 6, 10 |
| AC-12 | ADR-003（`.thread/1/adr.md` の `## ADR-003` セクション）が、(a) OWASP 引用の取り違え、(b) CF の CPU 予算（Free 10ms / Paid 既定 30 秒）、(c) workerd 実測結果の追記、の3点について訂正されている。加えて **(d) 同一ファイル内で数字が矛盾する状態が残っていない** — 検証は `grep -n "210,000\|210_000\|210000\|pbkdf2-sha256\|PBKDF2-HMAC-SHA256\|PBKDF2-SHA256" .thread/1/adr.md` の残存ヒット（既知 21 行）が、**ステップ8-5 (ii) で本文を直した行、または (i) の訂正注記ブロックが「#20 以前の事実」として一括で覆う歴史的記述**のどちらかに収まっていること | Issue「対応項目」4 / R-8 | 8, 10 |
| AC-13 | `.thread/1/progress.md` の**2箇所**が確定した方式に整合している — (a) 82 行の spec-sync 記録（`ADP-identity-012` の項）の方式名、(b) 9-13 行「**意図的にスコープ外とした項目** 1. 旧コストの保存ハッシュが残る間の等時間化」の記述（案 A ではピンがアルゴリズムにも掛かった旨と残余チャネルが「コストまたはアルゴリズム」に広がった旨、案 B では 13 行「反復回数を一度も上げていない現状では差は生じない」が偽になる旨）。**ADR-034 が「この限界は JSDoc と `progress.md` の2箇所に書いた」と明記しているので、アダプター JSDoc 側（ステップ5）と対で直っていること** | Issue「spec への影響: なし」節 / `.thread/1/adr.md:1221` | 9 |
| AC-14 | `pnpm test:unit` / `pnpm test:integration` / `pnpm lint` / `pnpm format:check` がすべて通る（CI の `lint-typecheck-unit` ジョブが Lint と Format check を別ステップで走らせるので、`format:check` をローカルゲートに含めないと CI で初めて落ちる） | 全般 | 10 |
| AC-15 | `pbkdf2PasswordHasher.ts` の JSDoc から OWASP 反復回数の**誤った帰属**が消えている — `grep -n "SHA-256\|SHA256" packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` の残存ヒットが、案 A なら**旧読み取り枝の説明だけ**、案 B なら**正しく 600,000 と組になった記述だけ**である。案 A では 22-24 行（「nothing else in the dummy needs regenerating」）・26-28 行（残余チャネル）・138-150 行（ファクトリ JSDoc）の訂正も含む | Issue「背景」の引用（research.md D-1 / D-3） | 5 |

## スコープ

### 含まれないもの

- **#18「ログイン時の rehash」の実装** — 本 Issue を初回デプロイ前に閉じれば旧コストの行がそもそも生まれないため不要。逆方向の依存も無い
- **Argon2id(WASM) への移行** — ADR-003 が将来の選択肢として挙げているが本 Issue の2案には含まれない
- **`MIN_PBKDF2_ITERATIONS` / `MAX_PBKDF2_ITERATIONS` / `SALT_BYTES` / `DERIVED_BITS` の変更** — 案 A / 案 B のどちらでも据え置きで成立する（`MAX` の 10,000,000 は 600,000 に対しても十分な余裕がある）
- **反復回数を OWASP 推奨より下げること** — 実測が想定より重くても採らない。セキュリティ上の後退であり、採るなら独立した ADR と Issue が要る（steps.md ステップ2「しきい値の根拠」を参照）。**このスコープ固定が、絶対上限を判定ゲートに置かない理由でもある** — 上限に触れても取れる行動は「案 B を選ぶ」しかなく、そこでは相対比較が既に案 B を選んでいるので、上限は判定に一度も寄与しない（adr.md ADR-001）。確定した案の中央値が重かった場合は数値を ADR-003 に記録し、重さは別 Issue へ切り出す
- **`spec/` の修正** — `spec/domains/identity.md:274` / `:574` と `spec/inventory/adapter.md:52` がアルゴリズムとパラメータをアダプターの責務として明示的に委譲しているため、方式変更は spec 違反にならない（research.md で裏取り済み）
- **ドメインテストのフィクスチャ差し替え** — `domain/identity/__tests__/{entity,valueObject}.test.ts` の `pbkdf2-sha256$1$…` はドメインが解釈しない不透明文字列として使われており、出荷アルゴリズムが何であっても有効
- **`.thread/1/plan.md` / `.thread/1/review/*` / `.thread/1/plan-review/*` / `.thread/34/*` の更新** — 当時の事実の作業ログなので遡って書き換えない（現在の実装を語る `progress.md` の記述と、現在の実装を語る `adr.md` の記述だけが更新対象。書き分け規則は R-7）。`.thread/34/{adr,design}.md` は #34（DO 移行設計）の作業ログで、`PBKDF2 210,000 回` を当時の前提として引いている。いずれもステップ10-5 の総ざらい grep でヒットするので棚卸しに載せてある
- **`vitest.config.integration.ts` の変更（恒久・一時とも）** — 捨てプローブは**既に `include` 許可リストに載っている** `packages/core/src/application/**` 配下へ置くので、設定ファイルを触る必要が最初から無い。許可リストの運用方針は `.adr/001` の決定であり、そこに一時的な穴を開けて戻し忘れるリスクを構造的に消す
- **`.github/workflows/ci.yml` の変更** — CI での実測は、プローブ入りのコミットを **main 宛の PR** に載せれば既存の `integration` ジョブがそのまま x86 で走るので、ワークフロー定義の編集は不要（`on.push.branches` は `[main, develop]` なので、フィーチャーブランチへの push だけでは走らない点に注意）
- **#51（DO 移行）との調整** — `PasswordHasher` はトランザクション外で動く非同期ポートで UoW にもコンテキストにも載らず、本 Issue は D1 時代のコードのままで閉じられる

## リスクと注意点

- **[R-1] 捨てテストが無言でスキップされる。** `packages/core/src/adapters/webcrypto/**` は現行の `vitest.config.integration.ts` の `include` 許可リストに無い（`.adr/001` で `packages/**` から許可リストへ絞られた）。そこに置くと unit（サフィックスで exclude）でも integration（include 非該当）でも走らず、**「テストが 0 件 pass」を「実測できた」と誤読する**。**対策: プローブを既に許可リスト済みの `packages/core/src/application/identity/__tests__/` へ置き、設定を触らない**（steps.md ステップ1）。これでこのリスクは構造的に消えるが、実行コマンドはパスフィルタ付きにして「1件も拾わなければ vitest が非ゼロ終了する」形にし、**目視ではなく終了コードで**確認する
- **[R-1b] ローカル実測は問いに答えられない。** 再測定の唯一の目的は「x86 で SHA-NI により比が反転するか」だが、ローカルは Apple Silicon（ARM）で、しかも M シリーズは ARMv8.2 の FEAT_SHA512 を持ちうるため **SHA-512 に系統的に有利な方向へ偏る**。ローカルで取ってよいのは G-0（SHA-512 が workerd でそもそも通るか）だけで、`t_A` / `t_B` の**比較は CI（`ubuntu-latest` ＝ x86_64）の実測で確定する**（steps.md ステップ1）
- **[R-2] workerd の時計が計算中に進まない可能性。** Workers は Spectre 緩和として `Date.now()` / `performance.now()` を I/O 境界でしか進めない。**steps.md ステップ1 の先行実測でこの形のプローブが非ゼロの中央値を返すことは確認済み**だが、**全計測が 0ms を返したら計測は失敗**であり、その 0 を「速い」と解釈してはならない。バッチ計測とタイムスタンプ前の I/O 挿入で回避する（steps.md ステップ1）
- **[R-2b] 計測値は `console.log` では回収できない。** Vitest 4 の**暗黙の**既定レポーターは通ったテストの `console.log` を出力せず、CI ジョブは `run: pnpm test:integration:cf` 固定でレポーターフラグを足せない。設定ファイル / `package.json` の一時編集は「恒久設定に穴を開けて戻し忘れる」を構造的に避けるという本計画の方針に反する。**対策: プローブは全計測の完了後に、測定値を JSON で埋め込んだ `Error` を故意に throw する**（steps.md ステップ1-1 の REPORT テスト）。失敗メッセージはどのレポーターでも必ず出力されるので、これがローカルと CI に共通の唯一の回収チャネルになる。**その結果プローブ入りのコミットでは `integration` ジョブが赤くなるが、これは想定内であり計測成功の印である**（Draft PR なのでマージには影響しない）
- **[R-3] 案 A のアルゴリズム変更はコンパイル時ピンをすり抜ける。** 現在のピン `DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS` は反復回数だけを覆う。案 A は反復回数を動かさずアルゴリズムだけを動かすので、**ダミーハッシュを取り残しても型検査もテストも赤くならない経路がある**。しかも `pbkdf2-sha256$` 分岐を残すと古いダミーは parse も verify も成功するため `burnVerificationTime` の catch も警告ラッチも発火せず、**タイミングオラクルが無音で復活する**。AC-9（アルゴリズムの型ピン）はこのリスクへの直接の対策であり、省略できない
- **[R-4] `@ts-expect-error` の対照値。** `pbkdf2PasswordHasher.test.ts:244` はドリフト例として `600_000` を使う。**案 B では `600_000` が正しい値になり、抑制すべきエラーが消えて typecheck が落ちる**。案 B なら別の値へ差し替える（案 A なら `600_000` のままでよい）
- **[R-5] 識別子の対応を「表引き」で書くと2種類の穴が同時に空く。** (a) 素の object を `obj[algorithm]` で引くと `obj["constructor"]` が truthy を返し、`constructor$1000$…` という保存値が未知アルゴリズムの拒否をすり抜ける。(b) `Map.get()` は `"SHA-256" | "SHA-512" | undefined` を返すので、**書き出し経路（`hash()`）まで部分関数になり、起こり得ない `undefined` に `!` / `??` / throw を書く羽目になる** — `CLAUDE.md`「Make illegal states unrepresentable at the type level」に反し、「読める形式は複数・書く形式は1つ」という非対称を型で失う。**対策: 2方式しかないので表を持たず、読み取り側は全域な判別関数 `hashFor(algorithm): "SHA-256" | "SHA-512" | null` にし、書き出し側は `SHIPPED_HASH` を直参照する**（steps.md ステップ5【案 A】）。これで (a)(b) の両方が構造的に消える。プロトタイプ由来キーの拒否ケースは**それでもテスト表に1件残す**（防御の証跡として安く、実装が将来表引きに戻っても同じ基準で検証できる。AC-6）
- **[R-6] 本番強度の実導出を踏むテストが2箇所ある。** `pbkdf2PasswordHasher.test.ts:157-160`（node プール）と `identity.integration.test.ts:642`（workerd プール）が `createPbkdf2PasswordHasher()` を引数なしで呼ぶ。どちらの案でも 1 回あたり 2〜3 倍になる。**破綻はしないが、`docs/test.md` の「unit は数〜十数 ms」という記述に対する増分**として意識する。実測（ステップ1）でこの増分も見積もれる
- **[R-7] ADR-003 は `Status: Proposed` の thread ローカル ADR。** `.adr/` へ昇格していないので本文の訂正は許容されるが、**「事実の誤りの訂正」と「決定そのものの変更」は書き分ける**。前者（OWASP 引用・CPU 予算）は訂正マーカー付きでインライン修正、後者（方式変更）は日付入りの追記節にする。リポジトリルートの `.adr/003-sqlite-fts5-only-search.md` は無関係な別 ADR なので絶対に触らない
- **[R-8] 陳腐化するのは ADR-003 だけではない。** Issue 本文は ADR-003 しか挙げていないが、`.thread/1/adr.md` 内で `210,000` / `pbkdf2-sha256` / `PBKDF2-HMAC-SHA256` を前提に書かれた ADR は **ADR-003 / 014 / 021 / 026 / 027 / 033 / 034 の7本**に及ぶ（実ヒットは 21 行）。**「案 B のときだけ 2 箇所」は誤り**で、案 A でも ADR-014 / 026 / 034 が陳腐化する。同一ファイル内で数字が矛盾する状態を残さない。ただし**その規範を満たすのに 21 行を1件ずつ分類する必要は無い** — R-7 の書き分け規則（**当時観測した状況・当時下した決定そのもの**を述べる行は原文を残し、**今も有効な仕組み・今も参照される定義**を述べる行だけ本文を直す）は、ファイル冒頭の訂正注記1ブロックで前者をまとめて宣言し、後者に当たる行（索引として偽になる 6 行 + 新しい実測節と直接ぶつかる `:1186`）だけを本文修正すれば同じ効果が得られる（steps.md ステップ8-5）。`.thread/1/adr.md` は `.adr/` へ昇格していない `Status: Proposed` の thread ローカル作業ログであり、Issue の規模に対して1件ずつの triage は過剰である
- **[R-9] `parse()` は保存値という外部データのデコード地点。** 多方式化しても未知の識別子は `SystemError(DataIntegrityError)` に落とすという既存の契約を崩さない（`CLAUDE.md`「Input validation」の第2境界とエラー契約）
- **[R-10] 依存方向。** ダミーハッシュ側の定数は application 層、アダプターは adapters 層。`adapters → application` の import は内向きで合法だが、**逆（application が `ALGORITHM_ID` を adapters から import する）は依存方向違反**。既存の `import type { DUMMY_PASSWORD_HASH_ITERATIONS }` と同じ向きを保つ

## テスト方針

- **実測（ステップ1）は捨てテストであり、恒久のテストではない。** 成果物は計測値の出力で、確認後に削除する。ただし**「静かに間違った結論へ誘導する」2つの失敗モードだけはアサーションに落とす** — (a) ファイルが1件も拾われなかった（R-1）はパスフィルタ付きコマンドの非ゼロ終了で、(b) 全計測が 0ms（R-2）は `expect(median).toBeGreaterThan(0)` で、いずれも自動で赤くする。人間の目視に頼らない。**(b) が CI で再測を尽くしても解消しない場合は判定ゲートの G-0b に当たり、案 B が確定する** — 打ち切り経路もゲートの行であって、ゲートの外の但し書きにはしない
- **プローブは最後に故意に失敗する（R-2b）。** 計測4件のあとに置く REPORT テストが `results` を JSON で載せた `Error` を投げ、それが数値の唯一の回収チャネルになる。**`expect(median).toBeGreaterThan(0)` と REPORT は役割が別**で、前者は G-0b の自動検出、後者は数値の回収である。したがって「赤いテストが REPORT の1件だけか、計測側も赤いか」がそのまま G-0b の判定材料になる
- **プローブの置き場所は `packages/core/src/application/identity/__tests__/`。** 検証対象は webcrypto アダプターなので置き場所としては座りが悪いが、このディレクトリは既に `vitest.config.integration.ts` の `include` 許可リストに載っており、**設定ファイルを触らずに済むほうが優先する**（1 PR の寿命しかない捨てファイルの配置の整合性より、恒久設定に一時的な穴を開けて戻し忘れるリスクのほうが高くつく）
- **プローブの各 `it` に 120 秒のタイムアウトを明示する。** 既定の `testTimeout` は 5000ms で、本番強度の導出を数十回踏むプローブは確実に超える。**渡し方は `it(name, fn, 120_000)` の第3引数（数値）**にする — Vitest 4 の `TestCollectorCallable` は `(name, fn?, options?: number)` と `(name, options?, fn?)` の2オーバーロードしか持たず、**オブジェクトを第3引数に置くと `pnpm typecheck` が落ちる**。同じ理由で **`catch (e)` の `e` は `unknown`** なので、`e.name` / `e.message` を直接読むと `TS18046` で落ちる（`e instanceof Error` で narrowing する）。プローブは `packages/core/tsconfig.json` の `include` に入るため、どちらも CI の `lint-typecheck-unit` を赤くする — **`integration` ジョブの赤は想定内（R-2b）だが `lint-typecheck-unit` の赤は想定外**という切り分けが崩れる。`vitest.config.integration.ts` の `testTimeout` は触らない（恒久設定の変更になる）。**タイムアウトによる失敗は G-0（SHA-512 が通らない）と読み替えない** — G-0 は例外を try/catch で捕まえて記録した場合だけ成立する
- **アダプター単体テスト（node プール）が実アルゴリズムの権威。** 方式・反復回数・エンコード形式・`parse()` の拒否ケースはすべてここで固定する。反復回数は `MIN_PBKDF2_ITERATIONS` 近傍の低コストを注入し、本番強度を踏むのは既定値の確認1件だけに留める（現状の方針を維持）
- **案 A なら旧形式のリグレッションテストを足す。** ハードコードした `pbkdf2-sha256$<低コスト>$…` フィクスチャを `verify` できることを固定する。**このフィクスチャは書き手が居なくなる形式なので、テストが唯一の生存確認になる**
- **`parse()` の拒否ケース表に「プロトタイプ由来のキー」を1件足す**（案 A のみ）。実装は全域な `hashFor()` なのでこのケースは実装上そもそも通らないが、**AC-6 の検証点として、また将来 `parse()` が表引きに戻ったときの回帰網として残す**（R-5）
- **統合テスト（workerd プール）は「ダミーハッシュが本番ハッシャーに読めること」の検証点を維持する。** `identity.integration.test.ts` の「burns against a hash the production hasher derives from」は、アルゴリズム識別子を**リテラルで**書いた正規表現で固定する（定数から組み立てると自己言及になり検証力を失う）
- **型検査もテストである。** `@ts-expect-error` によるピンの検査（既存の反復回数ぶんと、案 A で追加するアルゴリズムぶん）は `pnpm typecheck` で赤くなることが assertion 本体
- 仕上げに `pnpm typecheck && pnpm lint:fix && pnpm format` と `pnpm test`（unit + integration）を通す

## 未解決事項

**なし。** 3周のレビューで挙がった指摘はすべて反映済みで、着手を妨げる未決事項は残っていない。ただし**計画の性質上、実装時にしか埋まらない空欄が1つだけある** — 案 A / 案 B の確定である。これは未解決事項ではなく設計どおりで、steps.md ステップ2 の判定ゲートが CI 実測を入力として機械的に埋める（ゲートは全域なので、どの実測値でも案が1つに決まる）。

意図的に本 Issue のスコープ外へ置いた項目（#18 の rehash-on-login、Argon2id 移行、旧 `pbkdf2-sha256$` 枝の削除、確定した案が本番に対して重すぎた場合の扱い）は「含まれないもの」と adr.md ADR-002 の退役条件に、それぞれ行き先つきで記録してある。
