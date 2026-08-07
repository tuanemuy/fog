# 016. エラーの同一性判定を `Symbol.for()` ブランドと `serializedKind` の構造判定で行う

## ステータス

承認済み

## コンテキスト

SSR / RSC は module graph を分割するため、同一のソースファイルが複数回評価され、コンストラクタがグラフごとに別物になる。`instanceof` はコンストラクタ参照の同一性を見るので、グラフをまたいだ瞬間に無言で false を返す。`isConflictError` のようなガードがそこで壊れると、409 になるはずの失敗が 500 として出ていく。**コンストラクタ参照に依存しない同一性の担い手が要る**、というのが出発点だった。

案は2つあった。

- **案 A: 具象クラスごとに `Symbol.for()` ブランドを付ける** — 判定はブランド1つの有無で済む。代わりにブランド定数がクラスの数（エラークラスは現状12、うち抽象2・具象10。台帳は `lint/no-instanceof-error.grit`）だけ増え、クラスを足すたびに独立したステップとして追加を忘れうる
- **案 B: 基底クラスに1つブランドを置き、具象クラスは `serializedKind` プロパティで区別する** — 判定はブランド + 文字列比較の2段になる。代わりに新規クラスで足すのは `serializedKind` だけで、その値は `toSerialized()` の `kind` と揃える必要があるので、コピー元からの変更点として自然に意識される

## 前提

- **`Symbol.for()` は realm のシンボルレジストリを介するので、module graph が分かれても同一のシンボルを返す。** 逆に realm が分かれれば成立しない
- **ブランドは symbol-keyed own property なので、シリアライズ境界を越えない。** `structuredClone` / JSON / Worker ↔ Durable Object の RPC ホップを越えた先の契約は `SerializedError` エンベロープであり、そこでブランドを見ても常に false になる
- **ブランドは偽装可能である。** 同じキーで `Symbol.for` を呼べば誰でも立てられるので、ブランド一致が言えるのは「我々のエラークラス由来である」までで、信頼性ではない。認可や入力検証の判断材料にしてはならない

## 決定

**案 B を基本とし、「1つの kind に対応しない問い」だけを案 A の形で例外にする。**

1. **`CodedError` に `Symbol.for("@repo/core/CodedError")` を1つ置き、具象クラスは `readonly serializedKind` で自身を宣言する。** 各ガードは `hasSerializedKind` 1回の呼び出しに畳まれる。
2. **`abstract readonly serializedKind` の宣言位置は `CodedError` であって `ApplicationError` ではない。** `CodedError` を直接継承するクラス（domain の `BusinessRuleError`、presentation の `InputValidationError`）が実在するので、`ApplicationError` に置くとそれらが宣言なしで通り、ガードをすり抜ける。
3. **`serializedKind` はクラス同一性ではなく契約上の kind を指す。したがって per-kind ガードは全数が構造型を返す。** application の `ValidationError` と presentation の `InputValidationError` はどちらも `"validation"` を報告し、これは HTTP 422 を共有させるための意図的な多対一である。`serializedKind` の一致から具象クラスを主張することは原理的にできないので、戻り型は `CodedError & { readonly serializedKind: "validation"; toSerialized(): SerializedValidationError }` の形の構造型にする。**多対一が現に成立している kind だけでなく、per-kind ガード7本すべてに適用する。** 今日 2 クラスを持つ kind は `validation` だけだが、他の kind を1クラスに留める仕組みは型にも lint にもテストにも無く、破れたときの失敗モードは沈黙のまま不健全に narrowing することである。**型を実態に合わせる側の変更であり、多対一を解消する変更ではない。** application の6本は `hasSerializedKind` の上の薄い generic ファクトリ `kindGuard` から生成し、kind を `Serialized*Error["kind"]` として受け取ることで `hasSerializedKind` の呼び出し規約（リテラル直書きの禁止）を型で強制する。domain の `isBusinessRuleError` だけは手書きで、ファクトリを共有しない — 共有すると domain が application に外向きに依存する。
   **例外は `isAppServerError` の1本で、`value is AppServerError` というクラス主張を残す。** `createSerializationAdapter` の `test: (value: unknown) => value is TInput` に縛られており、構造型へ落とすには `TInput` 側、すなわちアダプターが往復させる型そのものを構造型にする必要がある。`AppServerError` は `CodedError` ではなく presentation が所有する1クラスなので、多対一の問題がそもそも生じない点でも他の7本と事情が違う。
4. **層の境界を問うガードには専用ブランドを与える。** `ApplicationError` は抽象クラスであって1つの kind に対応しないので、`serializedKind` では書けない。`Symbol.for("@repo/core/ApplicationError")` を持たせ、`isApplicationError` はそのブランドだけを見る。`BusinessRuleError` / `InputValidationError` には false を返す。「`CodedError` に翻訳済みか」を層と無関係に問いたい呼び出し元（`mapDbError`）には `isCodedError` を新設して差し替えた。
5. **`CodedError` を継承しない `RehydrationError` / `AppServerError` はそれぞれ専用ブランドを持つ。** `AppServerError` はブランドに加えて `serialized` payload を `asSerializedError` で検証する。**根拠は前提3（ブランドは偽装可能）である。** ブランドが立っていることは payload が我々由来であることの証拠にならない。とくに `appServerErrorAdapter` は対称であり、その `fromSerializable` は受信方向でも走る — `handleServerAction` はこのプラグインを載せてリクエストボディを解釈するので、クライアントが `$TSR/t/AppServerError` タグ付きノードを POST すれば、`inputValidator` が動く前にブランド付きの `AppServerError` が構築されうる。その値の `kind` は HTTP ステータスを決め、`redactForClient` と `system` / `unknown` のログ分岐が走るかどうかまで決める。したがって**検証はブランドではなく payload に置く**。前提2の下では「ブランドが残ったまま payload だけ失った残骸」は到達不能なので、それを根拠にはできない。
   検証は payload を信じる箇所すべてに置く: 送信方向の `test`（= `isAppServerError`）、受信方向の `fromSerializable`、`extractSerializedError` の第1段（ブランド経路）と第2段（残骸経路）。**不正な payload は fail-closed に倒し、投げない。** 投げるとペイロード解釈全体が中断し、送信方向では表現できないエラー1件がクライアント側のパース失敗に化けるので、`kind: "unknown"` の既定値へ落とす。あわせて `asSerializedError` は**既知キーのみで値を再構築する** — `redactForClient` は payload をスプレッドするため、便乗した未知プロパティがリダクションを生き延びてクライアントへ渡る経路が閉じる。

## 検討した代替案

**案 A を全面採用する** — 判定が1ステップになり `serializedKind` が要らない。採らなかったのは、ブランド定数がクラスごとに増えて追加忘れが起きやすいためである。ただし決定 4 のとおり、抽象クラス1つへのブランド追加は定数が具象クラスの数だけ増えるという懸念に当たらないので、そこだけは案 A の形を採っている。

**`ApplicationError` に専用ブランドを与えず、`CodedError` のブランドだけで `isApplicationError` を書く** — その場合 `isApplicationError` は `BusinessRuleError` にも true を返すので、呼び出し側に「`isBusinessRuleError` を先に評価する」という分岐順の規約を課す必要が出る。採らなかったのは、正しさが呼び出し側の記述順に宿り、`CLAUDE.md` に規約を1行増やしても破れたことを機械的に検出できないためである。**評価順に依存する正しさを規約で支えるより、述語を健全にするほうが安い。** 決定 4 はこの代替案を退けた結果である。

**`name` の文字列比較で判定する** — シリアライズ境界も越えられる。採らなかったのは、任意のオブジェクトが `name: "AppServerError"` を名乗れるためである。境界を越えた残骸は `extractSerializedError` の第2段が payload の構造から拾うので、ガード側を緩める必要がない。

**`instanceof` の禁止をドキュメントだけで宣言する** — 実効性がない。`lint/no-instanceof-error.grit`（ルートの `biome.json` が読む GritQL プラグイン）で lint 時に落とす。

## 影響

- module graph をまたいでも全ガードが正しく判定する。
- 新規エラークラスは `serializedKind` の宣言を `CodedError` の abstract がコンパイル時に強制する。宣言の型は `abstract readonly serializedKind: ReturnType<this["toSerialized"]>["kind"];` として**基底がサブクラス自身の `toSerialized()` の戻り型から導出する**ので、`toSerialized()` が出す `kind` と乖離した値は TS2416 で落ちる。サブクラス側の `readonly serializedKind: SerializedConflictError["kind"] = "conflict"` という注釈は任意であり、束縛ではなく意図の記述である（注釈の有無を問わずドリフトが落ちることは実測で確認した）。
- ガードは全12本で、`serializedKind` を比較するのは per-kind の7本のみ。残る5本は `isCodedError`（ブランド + 契約に答えられる形か）、`isApplicationError` / `isRehydrationError`（専用ブランドのみ）、`isAppServerError`（ブランド + payload 検証）、`isSerializableError`（**ブランドを見ず `toSerialized()` の有無だけを問う**。`serializeError` の分岐がこれである）。**「ブランド + `serializedKind`」も「必ずブランドから始まる」も全ガードの形ではない。**
- `SerializedError` の union は presentation が各層の variant を集約して組む場所であり、`lib` から参照すると依存方向が逆行する。したがって `CodedError.toSerialized()` の戻り型は `{ kind: string }` までしか縛れず、**union 外の `kind` の受け皿として `serializeError` の最終分岐（`kind: "unknown"` へ畳む）が構造的に必要になる**。型で塞ぐことはできないので、テストで固定する。
- `lint/no-instanceof-error.grit` に ban リストの保守義務が付く。識別子の完全一致で照合するため、新しいエラークラスは名前を足すまで対象外であり、エイリアス import と名前空間アクセスはすり抜ける（`instanceof Error` の正当な用途を巻き込まないためのトレードオフとして受容）。ただし**追加忘れは沈黙しない** — `lint/banList.test.ts` が `apps` / `packages` / `infra` の export されたエラークラスを走査して ban リストと突き合わせ、片方にしかない名前を挙げて落ちる。この同期テストがあることで、ban リストがエラークラス台帳の正本として使える。
