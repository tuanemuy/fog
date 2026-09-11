# ステップ 11 トピック — 下書き

ステップ 11（`components/topics/*`・`components/knowledge/*`）で決めたこと、近似したこと、担当外への変更要望。番号は付けない。

## トピック詳細の `h1` は、宣言を `"header"` のまま据え置く（担当外への変更要望）

### Context
topic-detail.html では、シート内のトピック名（`.topic-title`）が `h1` で、ヘッダーの英語タイトル `topic` は見出しではない。ADR-023 は、固有名を `h1` に上げる画面ステップが自分のルートの宣言を `"sheet"` に切り替えると決めている。一方、`components/layout/__tests__/appShell.dom.test.tsx` の「marks the topics item current under a topic and draws its back header」は、本番のルートの宣言（`PRODUCTION_STATIC_DATA`）で `/topics/$topicId` を描き、`h1` が `topic` であることを表明している。宣言を `"sheet"` にするとこの表明が落ちるが、`components/layout/` はこのステップの変更対象外である。

### Decision
- `routes/_app/topics_.$topicId.tsx` の宣言は `h1: "header"` のまま残し、トピック名は `h2` で描く（ADR-023 の移行中の形）。見た目（`--text-xl`・`--weight-bold`）はモックの `.topic-title` に合わせてある
- 切り替えは、次の 3 点を 1 つの変更で行う（統合担当への要望）
  - `appShell.dom.test.tsx` の上記テストの `h1` の表明を、`"sheet"` の宣言に合わせて「ヘッダーに `h1` が無く、`topic` は見出しでないラベル」に変える（またはテスト専用の宣言で描く）
  - `topics_.$topicId.tsx` の宣言を `h1: "sheet"` にする
  - `TopicHeader` の `<h2 className={TOPIC_TITLE_CLASS}>` を `<h1 …>` に、`KnowledgeSection` と `OriginList` の `level` を `2` にする（`TopicDetailFeed` で `level={2}` を渡す）。DOM テストの `heading level 2 / 3` の表明を `1 / 2` に上げる
  - あわせて、`h1: "sheet"` のルートでは「トピックが見つかりません」（`KnowledgeNotFound`）が唯一の見出し候補になるので、`EmptyState` の `asPageHeading` で一文を `h1` にするかを決める（ADR-029 の「枠が `h1` を描かない」場合に当たる）

### Consequences
- 良い点: このステップのコミットは、担当外のファイルに触れずにテストが通る
- トレードオフ: 切り替えまでは、トピック詳細の `h1` は英語の `topic` で、トピック名は `h2` のまま（ADR-023 のトレードオフの状態が続く）

## 一覧の末尾の作成導線の行を、画面側の `AddRow` で持つ（担当外への変更要望）

### Context
topics.html の「新しいトピック」と topic-detail.html の「新しいドキュメント」は同じ `.add-item`（行と同じ縦余白・ホバー面の張り出し・`--color-primary` のプラス・`--color-primary-dark` の文字）である。ADR-017 は、新規作成の導線の行を `RowLink` / `Row` の 2 種に入れず「要るならステップ 11・13 で段を足す」とした。段を足すのは `components/ui` の改修で、このステップの対象外である。

### Decision
- `components/topics/AddRow` に、ボタン版（`AddRowButton`、その場で作成フォームに置き換わる）とリンク版（`AddRowLink`、`createLink`）を置く。`className` / `style` は受けない
- 行は一覧の最後の `<li>` に置き、上の区切り線は `RowList` に引かせる。一覧が空なら先頭の項目になるので、線は出ない（モックの `.empty-state + .add-item::before` と `.section-label + .add-item::before` の打ち消しと同じ結果）
- ボタンは負のマージンで幅が伸びないので、ラッパーが `-mx-md` を持ち、ボタンが `w-full` で埋める
- 要望: `components/ui` に行の 3 種目（作成導線の行。ボタン版とリンク版）として移す。document-edit.html の「出典を追加」（`.add-origin`）が同じ役割かは、ステップ 12 と合わせて判断する

### Consequences
- 良い点: 2 画面の作成導線が 1 つの定義から来る
- トレードオフ: `components/ui` の外にある行の形なので、`RowLink` の箱（`-mx-md px-md py-row`）を変えても追従しない。作成導線の行を `<ul>` の中に置くので、一覧の項目数に作成導線が 1 つ数えられる

## シート内のセクション（セクション間隔＋区切り線＋ラベル）を `KnowledgeSection` で持つ（担当外への変更要望）

### Context
topic-detail.html の `.section-label`（ドキュメント・関連メモ）と document.html の `.origin`（出典）は、どちらも `--space-section` の上余白・`--space-lg` の上 padding・ヘアライン 1 本を持つセクションの頭である。`SectionLabel` は「区切り線はセクションが持ち、ラベルは持たない」としているので、線と余白を持つ側が要る。topics.html の「完了済み」の開閉（`.section-toggle`）も、同じ上余白と線を持つボタンである。

### Decision
- `components/knowledge/KnowledgeSection` に、`aria-label` 付きの `<section>`（`mt-section border-t border-neutral-100 pt-lg`）と `SectionLabel` を置き、P-07 のドキュメント・関連メモと、P-08 の出典（`OriginList`）がこれを使う。見出しレベルは `level`（既定 3）で受ける
- 「完了済み」の開閉は、`TopicList` の中にボタンとして書く（同じ余白と線、`SectionLabel` と同じ文字、`chevron-right` の回転）。`SectionLabel` は見出しで、ボタンにならないため
- 要望: `components/ui` に「セクション」（線と間隔を持つ枠）と「開閉するセクションラベル」を置く。トピック一覧・トピック詳細・ドキュメント・設定が同じ形を使う

### Consequences
- 良い点: 区切り線の持ち主がセクションに決まり、ラベルを単体で使っても線が付いてこない
- トレードオフ: 開閉のボタンの文字の指定が `SectionLabel` の複製で、`SectionLabel` の見た目を変えても追従しない

## 削除済みの出典行は、リンクでない `RowLink` 形を画面側で組む（担当外への変更要望）

### Context
「削除済みのメモ」の行（`.origin-row.deleted`）は、`RowLink` と同じ並び（時刻・本文・行末のジャンプ矢印）で、リンクにならず、矢印が `--color-neutral-300` になる。`RowLink` はリンクだけで、遷移しない状態を持たない。

### Decision
- `OriginRow` の中で、`RowLink` の箱からホバー面と張り出しを除いた形（`flex items-center gap-md py-row`、矢印は `text-neutral-300`）を組む。反応しない行なので、tokens.md の「張り出しはインタラクティブ行だけ」に従って負のマージンを持たない。文字は `RowLink` の padding が戻す位置と同じ列に乗る
- 要望: `RowLink` と対になる「遷移しない行」を `components/ui` に置く（ドキュメント閲覧・トピック詳細・ドキュメント編集の出典が使う）

### Consequences
- 良い点: 生きている行と削除済みの行の文字の位置が揃う
- トレードオフ: `RowLink` の箱を変えても、削除済みの行は追従しない

## 行の削除の失敗は行の下の `RowError` にし、再試行の文言は「リトライ」にする

### Context
トピックの削除は一覧の持ち主が楽観的に行を消し、失敗すると行が戻る。これまでは一覧の上に「再試行」付きの `fog-error` を出していた。ADR-020 は行の失敗を `Row` の `error` の `RowError` とし、再試行の文言を呼び出し側に委ねた。モックの `.row-error`（trash.html）は「リトライ」、コンポーザーとルートエラーは「再試行」である。topics.html には行の失敗の状態例が無い。

### Decision
- 失敗は、戻った行の `Row` の `error` に `RowError` で出す。付け先は失敗したトピックの行だけ
- 文言は行のエラーの基準形（trash.html）に合わせて「リトライ」にする

### Consequences
- 良い点: 失敗が項目に帰属し、どの行の失敗かが位置で分かる
- トレードオフ: 画面内に「リトライ」（行）と「再試行」（コンポーザー・ルートエラー）が並ぶ。持ち場ごとの文言として spec に書くか、どちらかに寄せるかは統合で決める（ステップ 15 のゴミ箱と揃える）

## 作成フォームと編集フォームの形とエラーの持ち場

### Context
これまでの作成フォームは、名前の入力と「追加」を常に出し、説明は「説明を追加」を押すと現れた。topics.html では、一覧末尾の「新しいトピック」を押すとその位置が作成フォーム（トピック名・説明（任意）・キャンセル・追加）になる。名前が空のときの状態例は、エラーの一文と押せない「追加」を並べる。topic-detail.html の編集も同じ形（トピック名・説明・キャンセル・保存）である。

### Decision
- 「新しいトピック」でフォームを開き、名前の欄へフォーカスを移す。キャンセルと作成の成功で閉じて、下書きを消し、フォーカスを「新しいトピック」に戻す
- 説明は常に出す（「説明を追加」は撤去）
- 空の名前で送ると `TextField` の `error` で「トピック名を入力してください」を出し、名前を書き直すまで「追加」「保存」を押せなくする
- 送信の失敗は `FormError` でフォームの先頭に出す。キャンセルで閉じた失敗は、次に開いたときに出さない
- トピック詳細の「完了にする / 完了を解除」と削除の失敗は、見出しブロックの下の `InlineAlert`（エラー）に出す。フォームではなく、付け先はトピックそのもののため
- 入力の箱は `TextField` / `TextAreaField` にする（ADR-019 のとおり、`.edit-field` の単一行と、編集時の名前の大きな文字（`.edit-field.name`）は形が変わる）

### Consequences
- 良い点: 作成・編集・一覧の行の失敗が、それぞれ持ち場のプリミティブに出る
- トレードオフ: 作成中に一覧を見る場合も、フォームは一覧の末尾に置かれる（作成した行は楽観的に一覧の先頭に出る）

## 削除の確認文は保持期限の日数を書かない

### Context
topics.html / topic-detail.html の確認ダイアログは「トピックとそのドキュメントはゴミ箱に移動し、30日後に完全に削除されます。」である。保持期限は設定で変えられる（requirements.md「既定30日、設定可能」）。

### Decision
「トピックとそのドキュメントはゴミ箱に移動し、保持期限を過ぎると完全に削除されます。」とする。モックの語（「トピックとそのドキュメント」）に合わせ、日数だけを保持期限の語に置き換える。

### Consequences
- 良い点: 保持期限を変えた利用者に誤った日数を示さない
- トレードオフ: モックと文言が一致しない。モック側の「30日後」を直すか、設定値を読んで日数を出すかは、ほかの画面の確認文（メモ・ドキュメント）と合わせて統合で決める

## スケルトンの近似

### Context
ADR-005 は、実画面と同じ DOM に `Sk` を被せる形を求める。topic-detail.html の状態例は、アウトラインのボタンを枠の無いピルの塊（`.outline-btn.sk`）にし、セクションラベルも `Sk` で覆う。`Sk` は角丸と見た目を変えられず、`SectionLabel` は文字列だけを受ける。

### Decision
- 「完了にする」は、本物の `Button`（`outline`、無効）の中に `Sk` を入れ、支援技術から隠したラッパーに置く。箱の寸法が読み込み後と同じになる
- セクションラベル「ドキュメント」は定数なので、`KnowledgeSection` をそのまま使って文字を出す
- 行の文字の指定は `components/topics/styles.ts` の定数を実画面と共有する。トピック名の行は見出しにしない（`p`）

### Consequences
- 良い点: 差し替えで箱と行高がずれない
- トレードオフ: ボタンの塊は薄い枠線が残り、ラベルは読み込み中から見える（モックと px では一致しない）

## `components/knowledge` をステップ 12 と共有する点（統合の注意）

- `KnowledgeNotFound` の API（`subject`）と `OriginList` の API（`memos`・`label`）は変えていない。`OriginList` に `level`（既定 3）を足した。ドキュメント閲覧が `h1: "sheet"` に切り替わるときは `level={2}` を渡す
- `OriginList` の見た目（区切り線・行・削除済みの行）は document.html の `.origin` に合わせてあり、ドキュメント閲覧・編集の出典にもそのまま効く
- `knowledge/__tests__/knowledgeFeeds.dom.test.tsx` は `DocumentFeed` の見つからない表示も表明している。`KnowledgeNotFound` が一文（`p`）と塗りのボタンになったので、`DocumentFeed` の表明も `h2` から段落へ直した。ステップ 12 が同じファイルを直している場合は、ここで衝突する

## プリミティブの `min-w-0` が CSS を生成していない（担当外への変更要望）

### Context
ADR-018 は、`--spacing` を消したので `p-0` などの値 0 は何も生成せず、任意値（`[0]`）で書くと決めた。`components/ui` の `Row`・`RowLink`・`RowError`・`InlineAlert`・`ComposerError`・`TextField/styles.ts` は `min-w-0` と書いていて、ビルドした CSS に `.min-w-0` の規則が無い。flex の子の `min-width: 0` が効かないので、空白の無い長い語（URL、英数字の続くトピック名など）が行の文字の列を押し広げうる。

### Decision
- このステップの画面側のコードは `min-w-[0]` で書いた
- 要望: `components/ui` の上記 6 か所の `min-w-0` を `min-w-[0]` に直す。ADR-018 のとおり落ちるテストが無いので、`lint/designTokens.test.ts` に「生成されない候補名（値 0 の既定スケール）を書いたら落ちる」検査を足すかも合わせて決める

### Consequences
- 良い点: 行の文字の列が、長い語でも行の幅に収まる
- トレードオフ: 検査を足さない限り、同じ書き方が再び入っても検出されない
