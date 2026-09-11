# ステップ 12 ドキュメント — 下書き

## ドキュメント閲覧の h1 はシート内のタイトルにし、編集・新規はヘッダーの h1 のまま残す

### Context
document.html はシート内の `doc-title` を `h1` にし、ヘッダーの `document` は見出しではない。document-edit.html のシートには見出しが無い（タイトルは入力欄）。ステップ 6 は戻る付きの 4 ルートを暫定で `h1: "header"` と宣言した（ADR-023）。

### Decision
- `/documents/$documentId` の宣言を `h1: "sheet"` に変え、`DocumentFeed` がタイトルを `h1` で描く（`article` の名前もこの `h1`）
- 編集（`/documents/$documentId/edit`）と新規（`/topics/$topicId/documents/new`）は `"header"` のまま。シートに見出しになる要素が無く、ヘッダーの `document` がページの `h1` になる
- スケルトンのタイトル行は見出しにしない（`p`）。実際のタイトルが届くまで、見出しの構造に仮の文を入れない

### Consequences
- 良い点: 閲覧ページの `h1` が 1 つだけで、固有名になる（DOM テストが本番のルート宣言で確かめる）
- トレードオフ: 閲覧ページは、読み込み中・ドキュメント不在・ルートエラーの間 `h1` が無い（ヘッダーの `document` はラベルで、`RouteError` / 空状態の一文はアプリシェルでは段落のまま、ADR-029）。トピック詳細・ドキュメント履歴も `"sheet"` にすると同じになる。解消には `components/layout` か `components/ui` の変更が要る（下の「担当外への変更要望」）

---

## 画面の操作と保存はヘッダーの操作スロットへ移し、画面内の取消リンクを撤去する

### Context
document.html はヘッダーに編集・履歴・削除のアイコン、document-edit.html はヘッダー右端に塗りの「保存」を置く。実装は、シート内のテキストリンク（編集 / 履歴 / 削除）と、フォーム内のツールバー（「編集をやめる」「やめる」と「保存」）だった。

### Decision
- 閲覧: `DocumentActions` が `HeaderActions` へ `IconButtonLink`（`edit`「編集」、`history`「履歴を表示」）と `IconButton`（`delete`「削除」、`tone="danger"`）を差し込む。3 つはヘッダーの操作列の flex 項目になり、間隔はヘッダーが持つ
- 編集・新規: `DocumentEditor` が `HeaderActions` へ `Button`（`fill-sm`、`type="submit"`）を差し込み、`form` 属性でフォームに結び付ける（ポータルなので DOM ではフォームの外にある）。文言は「保存」「保存中…」「そのまま保存」
- 「編集をやめる」「やめる」は撤去する。戻るボタンの既定の戻り先が同じ場所（閲覧 / トピック詳細）を指す

### Consequences
- 良い点: モックと同じ位置に操作が出る。保存ボタンの押下・Enter による暗黙の送信・`fireEvent.submit` のどれも、同じフォームのアクションを通る（DOM テストがヘッダーのボタンの `form` とクリックでの送信を確かめる）
- トレードオフ: 操作と保存はハイドレーション後に出る（ADR-006）。取消はブラウザの戻る / ヘッダーの戻るだけになる

---

## 保存・削除の失敗はシート先頭の InlineAlert に出し、再試行は同じ操作をもう一度走らせる

### Context
document-edit.html は保存失敗を「シート先頭にエラーと再試行」、競合をシート先頭の警告で示す。削除の失敗にはモックが無い。実装は `fog-error` の段落をフォームの下や操作の下に出していた。

### Decision
- 保存の失敗は `InlineAlert tone="error"` をフォームの先頭（トピック名の上）に出し、「再試行」は `form.requestSubmit()` で同じ送信を繰り返す。文言は `displayError` のまま（モックの「保存できませんでした」に固定しない。タイトル長超過などの理由を失わないため）
- 削除の失敗も同じ形で閲覧シートの先頭に出す（`DocumentActions` を `article` の先頭に置く）。「再試行」は確認を経ずに削除を再実行する（確認はすでに済んでいる）
- 競合は `InlineAlert tone="warning"` を同じ場所に出す。複数出るときは警告・エラーの順に縦に並べ、次の要素との間を `next-sibling:mt-lg` で空ける

### Consequences
- 良い点: 失敗の出る位置が 1 つに決まり、入力はそのまま残る
- トレードオフ: 検証エラー（タイトル長超過）にも「再試行」が出る（押しても同じ失敗になるだけで、害は無い）

---

## 保存と削除の成功はトーストで知らせる

### Context
document-edit.html は保存成功を「保存しました」のトーストで示し、画面は P-08 へ戻る。削除の成功にはモックが無い。design/index.md は成功を消えるトーストにする（ADR-010）。

### Decision
- 作成・編集の保存成功（`unchanged` を含む）で「保存しました」を出してから P-08 へ遷移する
- 削除の成功で「ドキュメントを削除しました」を出してからトピックへ遷移する。文言は timeline.html の「メモを削除しました」に揃えた

### Consequences
- 良い点: 遷移先の画面でも、操作が済んだことが数秒読める
- トレードオフ: 削除のトーストの文言にはモックが無い（spec/design のモックに状態例を足すかは Phase 5 で判断）

---

## 競合警告はモックの一文にし、相手の現在の内容は画面に出さない

### Context
実装の競合警告は、相手の名前・日時・変更理由と、現在のタイトル・本文の全文を出していた。document-edit.html と timeline.html の警告は「編集中に {相手} がこのドキュメントを更新しました。そのまま保存すると、自分の内容が新しいリビジョンになります。」の一文である。P-09 の状態は「警告を表示。そのまま保存すると自分の内容が新リビジョンになる」だけを求めている。

### Decision
モックの一文にする。相手の名前は `actorLabel`（`timeline/MemoEntry`）で出す。`ConflictView` の `currentTitle` / `currentBody` / 日時 / 変更理由は画面に出さない（`currentVersion` だけを次の送信の OCC トークンに使う）。

### Consequences
- 良い点: モックと同じ文で、警告が 1 行で読める
- トレードオフ: 上書きする前に相手の内容を画面で確かめる手段が無くなる（保存後も相手の版は P-10 の履歴に残る）。spec/usecases/knowledge.md の「警告表示に必要な情報を一往復で返す」は、今は相手の名前と `currentVersion` だけが使われている

---

## 出典の選択は「出典を追加」を検索欄に置き換え、開いた時点で直近のメモを出す

### Context
document-edit.html の出典の選択は、「出典を追加」を押すとボタンの位置が検索欄（検索のグリフ・入力・「検索を閉じる」のピル）に置き換わり、その下に候補の行（「出典に追加」の `+`）が並ぶ。検索ボタンは無い。実装は、トグルのボタンと、見出し「出典を追加」・入力・「検索」ボタンの別領域で、「検索」を押すまで候補が出なかった（空欄で押すと直近 20 件、△-2）。

### Decision
- `SourceMemoPicker` が開閉を持ち、閉じているときは `Button outline`（`plus` のグリフ＋「出典を追加」）、開いているときは検索欄を同じ位置に描く。フォーカスは開くと入力へ、閉じるとボタンへ移す（初回の描画ではボタンへ移さない）
- 開いた時点で空欄の検索（直近 20 件）を走らせ、以後は Enter でキーワード検索する。IME の変換確定の Enter では検索しない。Enter はフォームの送信（保存）にならない
- 候補は `Row`＋`IconButton`（`plus`「出典に追加」、追加済みは `check`「出典に追加済み」で無効）。0 件は `EmptyState`「一致するメモはありません」、検索の失敗は `InlineAlert tone="error"` と「再試行」（同じキーワードで再検索）
- 選んだ出典は `Row`＋`IconButton`（`close`「出典から外す」）。0 件のときの「出典メモはまだありません」は撤去し、ラベルと「出典を追加」だけにする

### Consequences
- 良い点: モックの構造のまま、空欄で直近のメモを探す操作（△-2）が、検索ボタン無しでも最初から見える
- トレードオフ: ピッカーを開くたびに 1 回の読み込みが走る。spec/manual-tests/document.md の手順（「検索」を押す・候補のボタンが「追加済み」になる）は文言が変わる（manual-tests はスコープ外。Phase 5 で判断）

---

## 編集モードの出典は、反応しない行にする

### Context
document-edit.html は編集モードの出典を読み取り専用の行（リンクでもボタンでもなく、ジャンプ矢印も無い）で描く。実装は閲覧と同じ `OriginList`（行全体のリンク）を使っていた。

### Decision
編集モードは `RowList` の `Row`（操作なし）に `SourceMemoLine`（投稿日時＋2 行までの本文）を置く。削除済みのメモは「削除済みのメモ」を `neutral-400` で出す。出典が 0 件なら領域ごと出さない（閲覧と同じ）。

### Consequences
- 良い点: 編集中にうっかりタイムラインへ遷移しない
- トレードオフ: `SourceMemoLine` の時刻と本文の組み方は、`knowledge/OriginRow` の行の中身と同じ形を別に書いている（下の「担当外への変更要望」）

---

## モックの形がプリミティブに無い箇所は、既存のプリミティブで近似する

### Context
ADR-004 は画面からプリミティブの見た目を変えさせない。document-edit.html には、プリミティブの段に無い形がある。

### Decision
次を近似する。
- 「出典を追加」（`.add-origin`: 枠つき・`--color-primary-dark` の文字・`xs` のグリフ）→ `Button outline`（文字は `neutral-900`）に `Icon plus xs` を子に置く
- 変更理由のラベル（`.reason .o-label`: セクションラベルの見た目の `label`）→ `TextField` の可視ラベル（フォームのラベルの見た目）。区切り線・上余白の区画は画面が持つ
- 本文の最小高さ（`min-height: 10em`）→ `min-h-[5lh]`（`em` は margin だけに認める、ADR-014。行間 2 なので同じ高さ）

### Consequences
- 良い点: プリミティブに段を足さずに載せられる
- トレードオフ: 3 箇所とも px では一致しない（「同形」は構造の一致、ADR-003）。「出典を追加」の色を合わせるなら `Button` に段を足す改修になる

---

## タイトルと本文は枠もフォーカスリングも持たない入力にする

### Context
document-edit.html のタイトルと本文は「枠なしで地続き」で、`outline: none`。ADR-019 は、タイトル・本文の箱をそれぞれの画面ステップが持つとした。

### Decision
`components/documents/styles.ts` に `TITLE_INPUT_CLASS`（`doc-title` と同じ組版）と `BODY_INPUT_CLASS`（`leading-loose`・`field-sizing-content`・`resize-none`）を置き、フォーカスリングは描かない（キャレットがフォーカスの位置を示す）。タイトルの項目エラーは `FieldError` を入力の下に置き、`aria-describedby` / `aria-invalid` を画面が結ぶ。閲覧・編集・スケルトンは同じ文字列を読む。

### Consequences
- 良い点: モックの地続きのエディタになり、スケルトンからの差し替えで行がずれない
- トレードオフ: フォーカスリングが無い（モックの判断のまま）。ステップ 17 までは旧 CSS の `button, input, textarea { font: inherit }`・`:focus-visible`・`button:disabled { opacity }`（レイヤーの外）がユーティリティに勝ち、タイトル入力の文字サイズ・保存ボタンの無効時の見た目は最終形にならない（ADR-018 の限界。ブラウザ確認をステップ 17 より前に行うと、タイトル入力が本文と同じ文字サイズに見える）

---

## スケルトンは閲覧と編集の 2 形にする

### Context
3 ルートが 1 つの `DocumentSkeleton`（汎用バーの並び）を共有していた。document.html と document-edit.html の読み込み中は、形が違う（閲覧は更新日時の行があり、編集はタイトル入力と本文入力の行）。

### Decision
`DocumentSkeleton` に `mode: "read" | "edit"` を持たせ、閲覧ルートは `read`、編集・新規ルートは `edit` を渡す。領域は `RoutePendingFallback` と同じ `role="status"`・`aria-busy`・sr-only の「読み込み中」、行は実画面と同じクラスに `Sk` を被せる。

### Consequences
- 良い点: どのルートでも、差し替えで行がずれない
- トレードオフ: 新規ルートは読み込むのがトピック名だけだが、編集と同じ形を出す（差し替え後の形は同じ）

---

## spec / docs への反映が要る点

- `spec/pages/index.md` P-08 は領域名を「元になったメモ」と書くが、モックと実装の見出しは「出典」。P-08 の文言を「出典」に揃えるか、領域名として残すかを決める
- `docs/test.md` の DOM 節: `documents/documentActions`（ヘッダーのアイコン、確認の文言、削除のトースト、シート先頭の失敗と再試行）、`documents/documentEditor`（ヘッダーの保存がフォームを送る、保存中の表示、トースト、シート先頭の失敗と再試行、ピッカーの開閉・フォーカス・直近の検索・IME の Enter・0 件・失敗と再試行、読み取り専用の出典、出典 0 件）を書き直し、`documents/documentFeed`（本番の宣言でタイトルがページで唯一の `h1`、トピックへのリンク、本文の組版、出典の有無、スケルトンの 2 形）を足す
- 削除成功のトーストの文言（「ドキュメントを削除しました」）と、ピッカーを開いた直後の状態に、モックの状態例が無い

## 担当外への変更要望

- `components/knowledge/OriginRow`（ステップ 11）: P-08 は `OriginList` に `label="出典"` を渡す。topic-detail.html と document.html の出典 / 関連メモは同じ区画（`mt-section`・`border-t border-neutral-100`・`pt-lg`・`SectionLabel`）なので、区画は `OriginList` が持ってほしい。P-08 はタイトルが `h1` になったので、ラベルは `h2`（`SectionLabel` の既定）が要る（今の `h3` は段を飛ばす）。行の中身（時刻＋2 行の本文）は `components/documents/SourceMemoLine` と同じ形なので、統合時に 1 つにできる
- `components/knowledge/KnowledgeNotFound`（ステップ 11）: `DocumentFeed` / `DocumentEditorFeed` / `DocumentComposerFeed` の不在はこれを使う。モックの形は `EmptyState`「ドキュメントが見つかりません」（新規モードは「トピックが見つかりません」）＋ `ButtonLink fill`「トピック一覧へ」。`knowledge/__tests__/knowledgeFeeds.dom.test.tsx` の `h2` の表明も一緒に変わる
- `components/timeline/MemoEntry` の `actorLabel`（ステップ 10）: `DocumentEditor` が競合警告で使う。移すなら import を直す
- `h1: "sheet"` のルートで本体がまだ無いとき（スケルトン・不在・ルートエラー）に `h1` が無い（上の 1 つ目の判断）。`components/layout/PageHeader` か `components/ui/PageHeading` の側で、シートに `h1` が描かれていない間はヘッダーの英語名を `h1` にする、などの手当てが要る。ステップ 11（トピック詳細）・13（履歴）も同じ
- ブランチの先端 4bd4470 に `components/ui/Icon` が無かった（グローバルの gitignore の `Icon` に隠れていた）。コーディネーターの 21f4d5b で解消済み
