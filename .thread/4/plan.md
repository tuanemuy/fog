# 実装計画 — Issue #4: Pulumi の resources stack に使われない D1 と render の placeholder が残っている

**Issue:** #4
**作成日:** 2026-09-25
**規模:** 小（インフラ定義・描画スクリプト・文書。UI なし）

## 目的

ランタイムが読まない D1 を、Pulumi の `resources` stack と wrangler 設定の描画から取り除く。stack が作るもの・出力するもの・描画が埋めるものを、ランタイムと下流が実際に使うものだけにする。

## 方針

- `infra/cloudflare/pulumi/resources/index.ts` から `cloudflare.D1Database` とその出力 `databaseId` / `databaseName` を削除する。stack は Zone・events queue・DLQ だけを作る。`protect` を持つリソースは無くなる
- `apps/web/scripts/render-wrangler.ts` から `D1_DATABASE_ID` / `D1_DATABASE_NAME` の置換を削除する
- 描画の placeholder とその出どころを `apps/web/scripts/lib/wranglerTemplate.ts` の 1 つの定数 `WRANGLER_PLACEHOLDER_SOURCES` にデータとして置く。各 placeholder は `{ from: "stackOutput" | "env", name }` で、出どころはタグ `from` の 1 つの値で決まる（両方を持つエントリは書けない）。placeholder の型はこの定数のキーから導く
- 「stack の出力と環境変数 → 置換表」を lib の純関数 `stageSubstitutions(stackOutputs, env)` にする。戻り値の型は placeholder 型をキーに持つ。stack 出力は `pulumi stack output --json` の生の JSON（`Record<string, unknown>`）で受け、文字列でない値・無い値は `undefined` にする（境界での検証）。`render-wrangler.ts` はこれを呼ぶだけにし、JSDoc の placeholder 一覧は定数への参照に置き換える
- テンプレートから placeholder を拾う関数 `placeholdersIn(template)` を lib に置き、`renderWranglerTemplate` と同じ正規表現を共有する。TOML に通さず生テキスト全体（コメント行を含む）に掛ける。描画もコメント行の placeholder を置換するため
- 描画の中断メッセージを 1 つにする: 置換表にキーが無いときも値が `undefined` のときも「値が無い」とし、placeholder 名・テンプレート名・値を持つ placeholder の一覧を挙げる。従来の「Unknown placeholder … Known: …」は、stack 出力の欠落でも「未知」と言い、値の無い名前を「既知」に数えていた
- `deployBundle.deploy.test.ts` の描画を `stageSubstitutions` 経由にする。期待値は固定値のリテラルと照らしたままにし、出力名の対応の取り違えで deploy スイートも赤になるようにする
- `infra/cloudflare/pulumi/resources/Pulumi.yaml` の説明文を実際のリソース（Zone、Queues）に合わせる
- `docs/runtime_cloudflare.md` の `protect` 段落と unprotect 手順は削除する。どのステージの stack も `up` されていない（第 5 章の前提）ので、既存 stack から保護付き D1 を外す移行手順の読み手はいない。残るリソースに `protect` を付けるかは本 Issue の範囲外として起票する
- 文書を変更後の姿に合わせる（AC-6）

## 受け入れ基準

| # | 基準 | 観測方法 |
|---|---|---|
| AC-1 | `resources` stack のプログラムが宣言するリソースは Zone（`zone`）・Queue（`events`）・Queue（`dlq`）の 3 つちょうどで、D1 を宣言しない | 自動テスト（ソースから名前空間の有無を問わず `new <型>("<名前>"` を集めて集合一致）＋ `pnpm typecheck`（infra）。変異: D1 を戻すと赤 |
| AC-2 | `resources` stack が export する出力の集合は、描画（`WRANGLER_PLACEHOLDER_SOURCES` の `stackOutput`）と `routes` stack（`requireOutput` / `getOutput` の引数）が読む出力名の和集合とちょうど一致する。読むのに export されていない出力も、export されているのに誰も読まない出力も無い | 自動テスト。変異: `databaseId` の export を戻すと赤／描画側の出力名を export の無い名前に変えると赤／routes が読む出力の export を消すと赤。既存の出力どうしの入れ替えは集合が変わらないのでこのテストでは出ず、AC-4 の正常系と deploy スイートが捕まえる |
| AC-3 | 描画の placeholder の集合は、4 本のテンプレートの生テキスト全体に現れる placeholder の集合とちょうど一致する（`APP_URL`・`MAIL_FROM_ADDRESS`・`EVENTS_QUEUE_NAME`・`DLQ_QUEUE_NAME`・`RESOURCE_PREFIX`）。`D1_DATABASE_ID` / `D1_DATABASE_NAME` は無い | 自動テスト＋型。変異: 定数に D1 を戻すと赤／テンプレートに未知の placeholder を足すと赤 |
| AC-4 | `stageSubstitutions` は各 placeholder に、対応する stack 出力または環境変数の値を入れる。出力が無い・文字列でない、または環境変数が未設定のとき、その placeholder は `undefined` になり、`renderWranglerTemplate` と組み合わせた描画はその placeholder 名を挙げて中断する | 自動テスト（正常系、出力欠落、非文字列の出力、`MAIL_FROM_ADDRESS` 未設定の 4 通り）。変異: 文字列判定の削除・反転で赤 |
| AC-5 | 既存テスト（unit・dom・integration・do）と `pnpm test:deploy` が通る。deploy スイートは `stageSubstitutions` を経由して 4 本を描画する | コマンド出力 |
| AC-6 | 文書が変更後の姿を述べる。`docs/runtime_cloudflare.md` の第 1 章（D1 の段落。直後の staleness check の段落が前提を失わないこと）・第 2 章（描画の説明は placeholder の出どころを定数への参照で述べ、数と一覧を重複して持たない。Pulumi の表・`protect` 段落・unprotect 手順）・第 3 章の `[vars]` 行（`APP_URL` の出どころを stack 出力に直す）・前提条件の API トークンのスコープ（D1 を外す）・§14 の #4 行、`render-wrangler.ts` の JSDoc、`Pulumi.yaml` の説明文。#4 への参照が残らず、`docs/`・`infra/`・`apps/web/scripts/` に残る D1 の言及は第 1 章の「D1 はランタイムにもインフラにも無い」旨の段落と staleness check の段落だけになる | コマンド出力（grep）＋差分の読み |
| AC-7 | ゲート（`pnpm typecheck`・`pnpm lint`・`pnpm format:check`・`pnpm test`・`pnpm test:deploy`）が通る | コマンド出力 |

## 観測の限界

- Cloudflare アカウントと Pulumi の stack がこの環境に無いので、`pulumi preview` / `pulumi up` と実際の `pulumi stack output` は実行しない。stack プログラムはソースを読むテストと型検査で固定する。ソースを読むテストが拾うのは `new <型>("<名前>"`（名前空間の有無を問わない）・`export const <名前>`・`requireOutput("<名前>")` / `getOutput("<名前>")` の字面だけで、変数経由の名前や別ファイルからの宣言は拾わない。この限界はテストの冒頭と `docs/runtime_cloudflare.md` 第 2 章（Pulumi）に書く
- `render-wrangler.ts` の本体（`pulumi` の呼び出し → `stageSubstitutions` → ファイルの書き出し）はどのテストも実行しない。純関数と、それを経由した描画（deploy スイート）までを観測とする

## スコープ

### 含まれるもの

- `infra/cloudflare/pulumi/resources/index.ts`、`Pulumi.yaml` の説明文
- `apps/web/scripts/render-wrangler.ts`、`apps/web/scripts/lib/wranglerTemplate.ts`、`apps/web/scripts/__tests__/` のテスト、`deployBundle.deploy.test.ts` の固定値
- AC-6 の文書

### 含まれないもの

- Zone や Queue への `protect` の付与など、残るリソースの設定変更（起票する）
- `routes` stack の変更（出力名の照合の対象には入る）
- ランタイム（wrangler 設定・アダプター）。D1 は既にランタイムに無い
- §14 の他の行
