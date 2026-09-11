# ステップ 15（ゴミ箱）の下書き

## 担当外への変更要望

### フォームを持つダイアログのプリミティブ

- **必要な変更:** `components/ui/ConfirmDialog` の枠（`<dialog>`・カード・見出し・一文・縦に積む 2 つのボタン）を、本文に任意の子要素を置ける形でも使えるようにする（例: `FormDialog`、または `ConfirmDialog` に `children` の段を足す）。取消ボタンの見た目（`.dialog-cancel`）も、その中で持つ
- **理由:** 復元先の選択（trash.html「復元先選択」）は、確認ダイアログと同じ `.dialog-box` の中にラジオの一覧と「新しいトピックを作成」の入力欄を持つ。今の `ConfirmDialog` は説明を文字列でしか受けず、取消ボタンの見た目は外に出ていない
- **近似:** `RestoreDestinationDialog` は、`ConfirmDialog` と同じトークンのユーティリティで枠を組み、確定を `Button` の `fill-sm`、取消を `Button` の `outline`（枠つきのピル。文字色が neutral-900 で、`.dialog-cancel` の neutral-600 とは違う）で描いた。枠の定義が 2 箇所にあるので、上の変更で 1 つにしたい

### docs/test.md の DOM の「What is covered」

- **必要な変更:** `trash/trashBoard` の行を今の分岐に直し、`trash/trashSkeleton` を足す（ファイル数も 45 → 46）
  - `trash/trashBoard` — days rounded up and "imminent" past the deadline, set nesting under the topic, the one-sentence empty state with a bare 空にする disabled, every kind with its badge and days left only (no deletion time), the set as an indent and a set document on another page as a row of its own, icon buttons named by the row, only the acted row busy with what is in flight in place of its days left, a set's documents disabled while their topic is acted on without taking its label, optimistic restore with a toast holding nothing to press and the failure under the row with 「リトライ」, set restore behind a confirmation counting the set when its topic is loaded, the destination picker (radio per topic plus a new one, blank new name refused on its field, 「候補を読み直す」 only for a stale candidate), hard delete naming the set for a topic only, a partial empty split into a toast and an alert with 再試行, a row that vanished elsewhere answered with an alert, no toast and 「一覧を読み直す」, the next page's loading and its failure with 再試行.
  - `trash/trashSkeleton` — one busy status whose only words are its label; the header and three rows from the board's parts, every text laid over by `Sk`, both buttons of each row disabled, nothing animated.

## 判断

### ゴミ箱の説明文は保持日数を出さない

#### Context
trash.html の説明文は「ここにある項目は30日後に完全に削除されます。」である。保持期限は設定（P-13）で変えられ、ゴミ箱の一覧（`TrashListView`）は保持日数を持たない。ゴミ箱の画面で日数を出すには、一覧のユースケースか画面の読み込みに設定の読み出しを足す必要があり、plan.md のスコープ外（ユースケース・サーバー関数の挙動変更）になる。

#### Decision
説明文は今の「ここにある項目は保持期限を過ぎると完全に削除されます。」のままにする。モックの 30 は既定値の例として読む。

#### Consequences
- 良い点: 保持期限を変えた利用者に誤った日数を見せない
- トレードオフ: 文言がモックと一致しない。一致させるなら、`listTrash` の結果に保持日数を足す起票が要る（spec/design の判断）

### 行の中身は種別と残り日数だけにし、セット関係はインデントで示す

#### Context
012fbbf で、ゴミ箱の行は残り日数だけを出し、セット関係はインデントで示す形になった（削除日時・「ドキュメントN件」・「トピックとセットで削除」を撤去）。所属トピックが同じページに無いセット削除のドキュメント（`TRASH_PAGE_LIMIT` 100 件を超えるときだけ起きる）は、トピックの下に置けない。

#### Decision
- 上位の行は種別のピルと「残りN日」（期限切れは「まもなく削除」）、トピックの下のドキュメントはタイトルだけにする
- 所属トピックが別ページのドキュメントは、普通のドキュメントの行として出す（セット関係の文言を足さない）。復元すれば、サーバーがセット復元の確認を返すので、関係はそこで分かる。その確認の件数は、トピックが読み込まれていれば出し、無ければ省く

#### Consequences
- 良い点: モックと同じ行の形になり、残り日数の他に読む情報が無い
- トレードオフ: 別ページに分かれたセットの関係は、一覧の上では見えない。spec/pages/index.md の P-12「セット関係が分かる表示」は、この場合をインデントでは満たさない（100 件を超えるゴミ箱に限る）

### 成功はトースト、行の失敗は行の下、一覧の失敗は見出しの下

#### Context
ADR-010 は成功をトーストにし、ゴミ箱の「タイムラインで見る」を撤去すると決めた。ゴミ箱には、行に帰属する失敗（復元・完全削除）と、行が無い失敗（空にするの失敗・部分失敗、別の画面で消えた行）がある。モックの行の失敗は `.row-error`（「リトライ」）で、行の無い失敗のモックは無い。

#### Decision
- トーストの文言: 「メモを復元しました」「ドキュメントを復元しました」「トピックを復元しました」「トピックごと復元しました」「完全に削除しました」「ゴミ箱を空にしました」。項目名を入れず、同じ操作を続けたときに ADR-021 の置き換えが効く形にする
- 行の失敗は `Row` の `error` に `RowError`（「リトライ」）。文は「復元できませんでした: 理由」で、理由（`displayError`）を残す。競合や業務エラーでは、再試行しても直らないことが理由から分かるようにするため
- 行の無い失敗は、見出し（説明文と「空にする」）の下に `InlineAlert` の error（「再試行」、別の画面で消えた行は「一覧を読み直す」）
- 空にするの部分失敗は分割する。消えた件数はトースト（「N件を完全に削除しました」）、残った件数は `InlineAlert`（「N件は削除できませんでした」＋再試行）
- 続きの読み込み（「もっと読む」）は、search.html と同じく読み込み中はボタンの位置にスピナーと「読み込み中」を出し、失敗は同じ位置に `InlineAlert`（「続きを読み込めませんでした: 理由」＋再試行）

#### Consequences
- 良い点: 失敗は消えずに付け先に残り、成功は画面に居座らない。モックの「リトライ」と「再試行」の揺れを、行（`RowError`）と面（`InlineAlert`）の持ち場で分けて保つ
- トレードオフ: 復元したメモへの近道が無くなる（ADR-010 のとおり）。行の失敗の文は、理由の分だけモックより長い

### 操作中の行は、残り日数の位置に進行中の操作を出す

#### Context
trash.html の「操作中」は、対象の行だけ `aria-busy` にしてボタンを無効にし、ピルの隣にスピナーと「復元中…」を出す。これまでの実装は、行を無効にするだけで、何が進んでいるかを出していなかった。

#### Decision
- 楽観的な状態（`useOptimistic`）を、行のキーから「復元中…」「削除中…」への対応にする。上位の行は残り日数の代わりに進行中の操作を出し、トピックの下の行はタイトルの下に出す
- トピックに操作が進んでいる間、その下の行はボタンを無効にするが、進行中の表示は操作した行にだけ出す

#### Consequences
- 良い点: どの行の何が進んでいるかが読める。ほかの行は操作できる（モックのとおり）
- トレードオフ: トピックの下の行の進行中の表示にはモックが無い（ブラウザ確認で見る）

### 行のアイコンボタンのアクセシブルネームは行の名前を含む

#### Context
trash.html の行のボタンは `aria-label="復元"` / `"完全に削除"` で、全行が同じ名前になる。ボタンの一覧で移動する支援技術の利用者には、どの行のボタンかが分からない。

#### Decision
`IconButton` の `label` を「{タイトル} を復元」「{タイトル} を完全に削除」にする（これまでの名前を保つ）。見た目はモックと同じアイコンだけ。

#### Consequences
- 良い点: ボタンの名前だけで対象が分かる
- トレードオフ: アクセシブルネームがモックの属性値と違う（見た目の構造は同じ）

### 復元先の選択は、トピックごとのラジオと「新しいトピックを作成」にする

#### Context
これまでは「既存のトピックへ / 新しいトピックを作る」のラジオと、既存の中から選ぶ `<select>` の 2 段だった。trash.html は、トピックを 1 行ずつのラジオで並べ、最後に「新しいトピックを作成」を置く。新しいトピックの名前の入力はモックに無いが、spec は既存と新規作成の両方を求める。

#### Decision
- 見出し「復元先のトピック」、一文「元のトピックは完全に削除されています。」、ラジオの一覧（完了済みのトピックは「（完了）」を添える）、「新しいトピックを作成」を選んだときだけ `TextField`（トピック名）と `TextAreaField`（説明（任意））を出す
- 既定の選択は先頭のトピック。選べるトピックが無ければ「新しいトピックを作成」だけを出して選んでおく
- 前回の選択が拒まれた理由は、フォームの先頭（一文の下）に `InlineAlert` で出す。候補が消えた場合だけ「候補を読み直す」を付ける。空の名前は、送信前に名前の項目のエラーにする

#### Consequences
- 良い点: モックと同じ 1 段の選択になり、選択肢がすべて見えたまま選べる
- トレードオフ: トピックが多いと、ダイアログが縦に長くなる（`<dialog>` の中でスクロールする）。完了済みの印と入力欄の見た目はモックに無い
