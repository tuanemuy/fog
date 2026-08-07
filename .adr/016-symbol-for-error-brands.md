# 016. エラーの同一性判定を `Symbol.for()` ブランドと `serializedKind` の構造判定で行う

## ステータス

承認済み

## コンテキスト

SSR / RSC は module graph を分割するため、同一のソースファイルが複数回評価され、コンストラクタがグラフごとに別物になる。`instanceof` はコンストラクタ参照の同一性を見るので、グラフをまたいだ瞬間に無言で false を返す。`isConflictError` のようなガードがそこで壊れると、409 になるはずの失敗が 500 として出ていく。**コンストラクタ参照に依存しない同一性の担い手が要る**、というのが出発点だった。

案は2つあった。

- **案 A: 具象クラスごとに `Symbol.for()` ブランドを付ける** — 判定はブランド1つの有無で済む。代わりにブランド定数がエラークラスの数（現状10個前後）だけ増え、クラスを足すたびに独立したステップとして追加を忘れうる
- **案 B: 基底クラスに1つブランドを置き、具象クラスは `serializedKind` プロパティで区別する** — 判定はブランド + 文字列比較の2段になる。代わりに新規クラスで足すのは `serializedKind` だけで、その値は `toSerialized()` の `kind` と揃える必要があるので、コピー元からの変更点として自然に意識される

## 前提

- **`Symbol.for()` は realm のシンボルレジストリを介するので、module graph が分かれても同一のシンボルを返す。** 逆に realm が分かれれば成立しない
- **ブランドは symbol-keyed own property なので、シリアライズ境界を越えない。** `structuredClone` / JSON / Worker ↔ Durable Object の RPC ホップを越えた先の契約は `SerializedError` エンベロープであり、そこでブランドを見ても常に false になる
- **ブランドは偽装可能である。** 同じキーで `Symbol.for` を呼べば誰でも立てられるので、ブランド一致が言えるのは「我々のエラークラス由来である」までで、信頼性ではない。認可や入力検証の判断材料にしてはならない

## 決定

**案 B を基本とし、「1つの kind に対応しない問い」だけを案 A の形で例外にする。**

1. **`CodedError` に `Symbol.for("@repo/core/CodedError")` を1つ置き、具象クラスは `readonly serializedKind` で自身を宣言する。** 各ガードは `hasSerializedKind(error, "conflict")` の1行に畳まれる。
2. **`abstract readonly serializedKind` の宣言位置は `CodedError` であって `ApplicationError` ではない。** `CodedError` を直接継承するクラス（domain の `BusinessRuleError`、presentation の `InputValidationError`）が実在するので、`ApplicationError` に置くとそれらが宣言なしで通り、ガードをすり抜ける。
3. **`serializedKind` はクラス同一性ではなく契約上の kind を指す。** application の `ValidationError` と presentation の `InputValidationError` はどちらも `"validation"` を報告し、これは HTTP 422 を共有させるための意図的な多対一である。したがって `serializedKind` の一致から具象クラスを主張することは原理的にできず、`isValidationError` の戻り型は `CodedError & { readonly serializedKind: "validation"; toSerialized(): SerializedValidationError }` という構造型にする。**型を実態に合わせる側の変更であり、多対一を解消する変更ではない。**
4. **層の境界を問うガードには専用ブランドを与える。** `ApplicationError` は抽象クラスであって1つの kind に対応しないので、`serializedKind` では書けない。`Symbol.for("@repo/core/ApplicationError")` を持たせ、`isApplicationError` はそのブランドだけを見る。`BusinessRuleError` / `InputValidationError` には false を返す。「`CodedError` に翻訳済みか」を層と無関係に問いたい呼び出し元（`mapDbError`）には `isCodedError` を新設して差し替えた。
5. **`CodedError` を継承しない `RehydrationError` / `AppServerError` はそれぞれ専用ブランドを持つ。** `AppServerError` はブランドに加えて `serialized` payload が union の `kind` を持つことまで検証する（ブランドだけでは、シリアライズ境界を越えて payload を失った残骸を有効な `AppServerError` と誤認する）。

**当初案にあった「`isBusinessRuleError` を先に評価する分岐順の規約」は撤回する。** それは `isApplicationError` がブランドだけを見て `BusinessRuleError` にも true を返す前提の回避策であり、決定 4 で述語が健全になったので規約自体が不要になった。**評価順に依存する正しさを規約で支えるより、述語を健全にするほうが安い。**

## 検討した代替案

**案 A を全面採用する** — 判定が1ステップになり `serializedKind` が要らない。採らなかったのは、ブランド定数がクラスごとに増えて追加忘れが起きやすいためである。ただし決定 4 のとおり、抽象クラス1つへのブランド追加は「定数が10個」の懸念に当たらないので、そこだけは案 A の形を採っている。

**`name` の文字列比較で判定する** — シリアライズ境界も越えられる。採らなかったのは、任意のオブジェクトが `name: "AppServerError"` を名乗れるためである。境界を越えた残骸は `extractSerializedError` の第2段が payload の構造から拾うので、ガード側を緩める必要がない。

**`instanceof` の禁止をドキュメントだけで宣言する** — 実効性がない。`lint/no-instanceof-error.grit`（ルートの `biome.json` が読む GritQL プラグイン）で lint 時に落とす。

## 影響

- module graph をまたいでも全ガードが正しく判定する。
- 新規エラークラスは `serializedKind` の宣言を `CodedError` の abstract がコンパイル時に強制する。宣言は `readonly serializedKind: SerializedConflictError["kind"] = "conflict"` の形で対応する `Serialized*Error` に型で結ばれるので、`toSerialized()` の `kind` と乖離すれば型エラーになる。
- `serializedKind` を見ないガードが4本残る。`isCodedError` / `isApplicationError` / `isRehydrationError` はブランドのみ、`isAppServerError` はブランド + payload 検証である。**「ブランド + `serializedKind`」は全ガードの形ではない。**
- `lint/no-instanceof-error.grit` に ban リストの保守義務が付く。識別子の完全一致で照合するため、新しいエラークラスは名前を足すまで対象外であり、エイリアス import と名前空間アクセスはすり抜ける（`instanceof Error` の正当な用途を巻き込まないためのトレードオフとして受容）。
