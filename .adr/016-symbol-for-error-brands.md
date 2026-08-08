# 016. エラーの同一性判定を `Symbol.for()` ブランドと `serializedKind` の構造判定で行う

## ステータス

承認済み

## コンテキスト

SSR / RSC は module graph を分割するため、同一のソースファイルが複数回評価され、コンストラクタがグラフごとに別物になる。`instanceof` はコンストラクタ参照の同一性を見るので、グラフをまたいだ瞬間に無言で false を返す。`isConflictError` のようなガードがそこで壊れると、409 になるはずの失敗が 500 として出ていく。**コンストラクタ参照に依存しない同一性の担い手が要る**、というのが出発点だった。

案は2つあった。

- **案 A: 具象クラスごとに `Symbol.for()` ブランドを付ける** — 判定はブランド1つの有無で済む。代わりにブランド定数がエラークラスの数（台帳は `lint/no-instanceof-error.grit` の ban リスト）だけ増え、クラスを足すたびに独立したステップとして追加を忘れうる
- **案 B: 基底クラスに1つブランドを置き、具象クラスは `serializedKind` プロパティで区別する** — 判定はブランド + 文字列比較の2段になる。代わりに新規クラスで足すのは `serializedKind` だけで、その値は `toSerialized()` の `kind` と揃える必要があるので、コピー元からの変更点として自然に意識される

## 前提

- **`Symbol.for()` は realm のシンボルレジストリを介するので、module graph が分かれても同一のシンボルを返す。** 逆に realm が分かれれば成立しない
- **ブランドは symbol-keyed own property なので、シリアライズ境界を越えない。** `structuredClone` / JSON / Worker ↔ Durable Object の RPC ホップを越えた先の契約は `SerializedError` エンベロープであり、そこでブランドを見ても常に false になる
- **ブランドは偽装可能である。** 同じキーで `Symbol.for` を呼べば誰でも立てられるので、ブランド一致が言えるのは「我々のエラークラス由来である」までで、信頼性ではない。認可や入力検証の判断材料にしてはならない

## 決定

**案 B を基本とし、「1つの kind に対応しない問い」だけを案 A の形で例外にする。**

1. **`CodedError` に `Symbol.for("@repo/core/CodedError")` を1つ置き、具象クラスは `readonly serializedKind` で自身を宣言する。** 各ガードは `hasSerializedKind` 1回の呼び出しに畳まれる。
2. **`abstract readonly serializedKind` の宣言位置は `CodedError` であって `ApplicationError` ではない。** `CodedError` を直接継承するクラス（domain の `BusinessRuleError`、presentation の `InputValidationError`）が実在するので、`ApplicationError` に置くとそれらが宣言なしで通り、ガードをすり抜ける。
3. **`serializedKind` はクラス同一性ではなく契約上の kind を指す。したがって per-kind ガードは全数が構造型を返す。** application の `ValidationError` と presentation の `InputValidationError` はどちらも `"validation"` を報告し、これは HTTP 422 を共有させるための意図的な多対一である。`serializedKind` の一致から具象クラスを主張することは原理的にできないので、戻り型は `Omit<CodedError, "toSerialized"> & { readonly serializedKind: "validation"; toSerialized(): SerializedValidationError }` の形の構造型にする。`toSerialized` を交差で上書きせず `Omit` で外すのは、メソッド構文の交差型がシグネチャを2本残し、呼び出し時のオーバーロード解決が基底の広い宣言を選ぶためである — 交差のまま書くと絞り込みのこの半分が無言で無効になる。**多対一が現に成立している kind だけでなく、per-kind ガード全数に適用する。** 今日 2 クラスを持つ kind は `validation` だけだが、他の kind を1クラスに留める仕組みは型にも lint にもテストにも無く、破れたときの失敗モードは沈黙のまま不健全に narrowing することである。**型を実態に合わせる側の変更であり、多対一を解消する変更ではない。**
   **この構造型が主張するのは実行時が検査するより広い。** 実行時条件は `serializedKind === kind` だけで、`toSerialized()` が本当にその variant を返すことは検証していない。今日健全なのは各 `Serialized*Error` が基底に任意プロパティしか足していないからであり、いずれかの variant に必須フィールドが増えた時点で、コンパイルエラーを伴わずに型が嘘をつく。
   application の per-kind ガードは `hasSerializedKind` の上の薄い generic ファクトリ `kindGuard` から生成し、kind を `Serialized*Error["kind"]` として受け取ることで `hasSerializedKind` の呼び出し規約（リテラル直書きの禁止）を型で強制する。domain の `isBusinessRuleError` だけは手書きで、ファクトリを共有しない。`kindGuard` は `lib/` のプリミティブ（`hasSerializedKind` と `SerializedErrorBase`）にしか依存しないので `lib/` へ移して domain の1本も同じファクトリから生成することはでき、**`application/errors.ts` に置いているのは配置の選択であって制約ではない。** 移して消えるのは同じ戻り型を2箇所に書くコストだけで、本決定そのものはどちらでも変わらない。
   **per-kind ガードの中に例外は無い。** クラスを主張する述語は他にもあるが（`isCodedError` / `isApplicationError` / `isRehydrationError` / `isAppServerError`）、いずれも判定の根拠は `serializedKind` ではなくブランドであり、ブランドはクラス階層と1対1なのでこの論証に抵触しない。うち `isAppServerError` にだけ注記が要るのは、構造型へ落とす選択肢自体が無いためである — `createSerializationAdapter` の `test: (value: unknown) => value is TInput` に縛られており、落とすにはアダプターが往復させる `TInput` 側を構造型にする必要がある。
4. **層の境界を問うガードには専用ブランドを与える。** `ApplicationError` は抽象クラスであって1つの kind に対応しないので、`serializedKind` では書けない。`Symbol.for("@repo/core/ApplicationError")` を持たせ、`isApplicationError` は `isCodedError` の上にそのブランドの有無を重ねる — 層の問いに答えるのはブランドで、narrow 先が約束する契約の形は `isCodedError` 側が検査する（`CodedError` を継承しない `RehydrationError` では `message` の最小 shape 検査が同じ役を担う）。`BusinessRuleError` / `InputValidationError` には false を返す。「`CodedError` に翻訳済みか」を層と無関係に問いたい呼び出し元（`mapDbError`）には `isCodedError` を新設して差し替えた。
5. **`CodedError` を継承しない `RehydrationError` / `AppServerError` はそれぞれ専用ブランドを持つ。** `AppServerError` はブランドに加えて `serialized` payload を `asSerializedError` で検証する。**根拠は前提3（ブランドは偽装可能）である。** ブランドが立っていることは payload が我々由来であることの証拠にならない。とくに `appServerErrorAdapter` は対称であり、その `fromSerializable` は受信方向でも走る — `handleServerAction` はこのプラグインを載せてリクエストボディを解釈するので、クライアントが `$TSR/t/AppServerError` タグ付きノードを POST すれば、`inputValidator` が動く前にブランド付きの `AppServerError` が構築されうる。その値の `kind` は HTTP ステータスを決め、`redactForClient` と `system` / `unknown` のログ分岐が走るかどうかまで決める。したがって**検証はブランドではなく payload に置く**。前提2の下では「ブランドが残ったまま payload だけ失った残骸」は到達不能なので、それを根拠にはできない。
   **検証は payload の出所を信じない3箇所に置く: 受信方向の `fromSerializable`、送信方向の `toSerializable`、分類経路の `extractSerializedError` である。** `extractSerializedError` はブランドを一切見ない — ブランドはシリアライズ境界を越えず（前提2）、越えた側では偽装可能である（前提3）以上、この関数にとって必要でも十分でもないからで、ブランド照合は `isAppServerError`（= アダプターの `test`）の責務に寄せた。送信方向の `toSerializable` も `value.serialized` を `asSerializedError` で再構築してから渡す。`test` が事前に同じ検証を通しているが、**`test` が保証するのは payload が妥当であることまでで、最小であることは保証しない** — 余剰キーを持つ `AppServerError` は `test` を通過する。したがって余剰キーの遮断を「`AppServerError` の構築点の全数が再構築済みか余剰キーを持たない」という列挙の維持に依存させず、送信方向自身の再構築で構造的に保証する。**不正な payload は fail-closed に倒し、投げない。** 投げるとペイロード解釈全体が中断し、送信方向では表現できないエラー1件がクライアント側のパース失敗に化けるので、`kind: "unknown"` の既定値へ落とす。あわせて `asSerializedError` は**既知キーのみで値を再構築する** — `redactForClient` は payload をスプレッドするため、便乗した未知プロパティがリダクションを生き延びてクライアントへ渡る経路が閉じる。

## 検討した代替案

**案 A を全面採用する** — 判定が1ステップになり `serializedKind` が要らない。採らなかったのは、ブランド定数がクラスごとに増えて追加忘れが起きやすいためである。ただし決定 4 のとおり、抽象クラス1つへのブランド追加は定数が具象クラスの数だけ増えるという懸念に当たらないので、そこだけは案 A の形を採っている。

**`ApplicationError` に専用ブランドを与えず、`CodedError` のブランドだけで `isApplicationError` を書く** — その場合 `isApplicationError` は `BusinessRuleError` にも true を返すので、呼び出し側に「`isBusinessRuleError` を先に評価する」という分岐順の規約を課す必要が出る。採らなかったのは、正しさが呼び出し側の記述順に宿り、`CLAUDE.md` に規約を1行増やしても破れたことを機械的に検出できないためである。**評価順に依存する正しさを規約で支えるより、述語を健全にするほうが安い。** 決定 4 はこの代替案を退けた結果である。

**`name` の文字列比較で判定する** — シリアライズ境界も越えられる。採らなかったのは、任意のオブジェクトが `name: "AppServerError"` を名乗れるためである。境界を越えた残骸は `extractSerializedError` が payload の構造から拾うので、ガード側を緩める必要がない。

**`instanceof` の禁止をドキュメントだけで宣言する** — 実効性がない。`lint/no-instanceof-error.grit`（ルートの `biome.json` が読む GritQL プラグイン）で lint 時に落とす。

**Biome の `style/useThrowOnlyError` を有効化して非 `Error` 値の throw を禁止する** — 検討し不採用。ワイヤ由来のプレーンオブジェクトを re-throw する形の破れは落とせるが、`Error` サブクラスに外部ペイロードを載せ替える偽装形は防げず、既存 throw サイト全域への波及（違反の洗い出しと書き換え）が得られる便益に勝るためである。

## 影響

- module graph をまたいでも全ガードが正しく判定する。
- 新規エラークラスに `serializedKind` の宣言を強制するのは `CodedError` の abstract である。宣言の型 `abstract readonly serializedKind: ReturnType<this["toSerialized"]>["kind"];` は基底がサブクラス自身の `toSerialized()` の戻り型から導出するが、**型がドリフトを落とすのは、サブクラスが `toSerialized()` の戻り型を自分の `kind` リテラルまで絞ったときに限る。** 戻り型注釈を省いた場合（`kind` が `string` に広がる）と基底と同形に注釈した場合（`{ kind: string; … }`）は束縛が `string` に退化し、乖離が TS2416 で落ちない。3形とも一時クラスで実測した。`serializedKind` 側の注釈（`readonly serializedKind: SerializedConflictError["kind"] = "conflict"`）は有無が結果を変えず、意図の記述である。
- **`serializedKind` と `toSerialized().kind` の一致を実効的に守っているのは実行時テストである。** `serializedKind === toSerialized().kind` の走査が、今日は具象 `CodedError` を全数覆っている — `packages/core/src/application/__tests__/errors.test.ts`（application の各クラスと `BusinessRuleError`）、`packages/core/src/domain/__tests__/error.test.ts`（`BusinessRuleError`）、`apps/web/app/presentation/__tests__/validator.test.ts`（`InputValidationError`）。ただし対象は手書きの表なので、新しいクラスが自動で入ることはない。エラークラスを足したらこの走査にも足すこと — 上の型の抜け道を踏むのはそのときである。
- `serializedKind` を比較するのは per-kind ガードだけである。それ以外は `isCodedError`（ブランド + narrow 後に呼び出し元が読む `toSerialized` / `serializedKind` / `code` / `message` の形。`Error` 性と `name` / `stack` / `cause` は未検証でブランドに乗る）、`isApplicationError` / `isRehydrationError`（専用ブランドのみ）、`isAppServerError`（ブランド + payload 検証）、`isSerializableError`（**ブランドを見ず `toSerialized()` の有無だけを問う**。`serializeError` の分岐がこれである）。**「ブランド + `serializedKind`」も「必ずブランドから始まる」も全ガードの形ではない。**
- **ブランドの有無を `in` で見るか `Object.hasOwn` で見るかは慣用の差であって健全性の差ではない。** ブランドはクラスフィールドなので実在インスタンスはどちらでも通り、prototype に植えた偽装は残る契約検査を通せない。`lib` / `application` / `domain` は `in`、presentation の `isAppServerError` は隣の `isSerializedErrorKind` に合わせて `Object.hasOwn` を使う。
- `kindGuard` が `hasSerializedKind` の呼び出し規約を型で強制できるのは、型引数の既定を `never` に置いているためである。`TSerialized["kind"]` は indexed access なので推論が効かず、既定が無ければ制約の `string` に落ちて任意の文字列を受け付ける。`application/errors.ts` の `@ts-expect-error` 型ピンがこれを固定している。
- `serializeError` は `toSerialized()` の throw・非オブジェクト応答・getter の throw をすべて `kind: "unknown"` へ fail-closed で畳む。**残余が1つある** — 畳んだ先の `errorMessage(error)` は `Error` の `message` を読むので、`message` 自身が throw する getter だけは抜ける。サーバ側は `toClientError` の最後の catch が受け、クライアント側の呼び出し元は「catch する値が transport でデコード済みのプレーンデータである」ことに乗っている。
- `SerializedError` の union は presentation が各層の variant を集約して組む場所であり、`lib` から参照すると依存方向が逆行する。したがって `CodedError.toSerialized()` の戻り型は `{ kind: string }` までしか縛れず、**union 外の `kind` の受け皿として `serializeError` の最終分岐（`kind: "unknown"` へ畳む）が構造的に必要になる**。型で塞ぐことはできないので、テストで固定する。
- `lint/no-instanceof-error.grit` に ban リストの保守義務が付く。識別子の完全一致で照合するため、新しいエラークラスは名前を足すまで対象外であり、エイリアス import と名前空間アクセスはすり抜ける（`instanceof Error` の正当な用途を巻き込まないためのトレードオフとして受容）。追加忘れは `lint/banList.test.ts` が落とす — `apps` / `packages` / `infra` / `lint` の `class` 宣言を export の有無を問わず走査し、ban リストと片方にしかない名前を挙げる。**ただし走査は宣言をテキストで読むので、届かない宣言形式が3形ある** — 無名の `export default class extends Error {}`、エイリアスした基底を継承する非 `*Error` 名、そして呼び出しでラップされたクラス式（`export const X = mixin(class extends CodedError {})` — 束縛 `X` は安定識別子なので手で ban リストに載せればプラグインは禁止できるが、走査が名前を拾わない）である。したがって ban リストがエラークラス台帳の正本として使えるのは、走査が届く宣言形式についてである。届く範囲と届かない3形はどちらも `banList.test.ts` の直接ケースが固定しており、限界の正本は `no-instanceof-error.grit` ヘッダの KNOWN LIMITS にある。
- ban リストの同期は、プラグインの配線そのものが外れれば無意味になる（`biome.json` の `plugins` 行を消しても `register_diagnostic(...)` を落としても同期テストは緑のままで、`pnpm lint` も exit 0 になる）。`lint/pluginWiring.test.ts` が使い捨ての fixture を lint して `category: "plugin"` の診断が返ることを assert し、その穴だけを閉じる。
