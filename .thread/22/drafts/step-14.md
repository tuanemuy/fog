# ステップ 14 検索 — 下書き

## ステップ 14 の判断

### 検索中はモックのスピナー行で出し、Sk は検索欄とチップの行に使う

#### Context
search.html の状態例は「検索中（結果一覧の位置にローディング）」をスピナー行（`.loading-more`、「検索中」）で描いている。一方で ADR-005 は、スケルトンを実画面と同じ DOM で組み、文字だけを `Sk` で包むとしている。`/search` のストリーミングの断片（`SearchFeed`）は、結果だけでなく検索欄とチップも描く。そのため、今のスケルトン（結果の行だけの形）では、検索するたびに検索欄とチップが消える。`Suspense` はキーワードと絞り込みごとに key が変わるので、検索のたびにフォールバックが出る。

#### Decision
- `SearchSkeleton` は `SearchPanel` と同じ DOM を描く。検索欄は同じ `SearchBox` で、入力は無効にし、URL のキーワードを入れておく。チップの行は同じチップの箱で、名前を `Sk` で包み、行ごと `aria-hidden` にする（操作不能）
- 結果の位置には、モックの形のスピナー行（`SearchLoading`）を出す。キーワードがあれば「検索中」、無ければ（チップだけを読む）「読み込み中」にする。行は `role="status"`、スケルトンの根は `aria-busy="true"`
- ルート（`routes/_app/search.tsx`）は、フォールバックに `q` を渡す

#### Consequences
- 良い点: 検索のたびに検索欄とチップの行が同じ位置に残り、差し替えでずれない。検索中の表示はモックの状態例と同形
- トレードオフ: チップの本数は読み込むまで分からないので、代わりの 4 本からの差し替えで、チップの行の折り返しが変わりうる。結果の行は Sk で描かない（モックの状態例を優先した）

### 検索欄は送信ボタンを持たず、入力の名前をモックに合わせる

#### Context
今の検索欄は、フォームに「メモとドキュメントを検索」、入力に「キーワード」の名前を付け、「検索」の送信ボタンを持っていた。search.html の `.search-box` は、グリフと入力だけのピルで、入力の `aria-label` が「メモとドキュメントを検索」である。

#### Decision
- `SearchBox` はグリフと `type="search"` の入力だけを持つ。入力はフォームの唯一の項目なので、Enter で暗黙に送信される（`enterKeyHint="search"`）
- 名前は入力に「メモとドキュメントを検索」を付け、フォームには付けない（`<search>` の要素がランドマーク）
- フォーカスリングは箱（`focus-within`）に付ける。文字の指定はフォームに置き、入力は継承する（レイヤーの外にある旧 CSS の `input { font: inherit }` が、入力に付けたユーティリティより優先されるため）

#### Consequences
- 良い点: モックと同形になる
- トレードオフ: 送信の手段は Enter（モバイルは検索キー）だけになる。ステップ 17 までは、旧 CSS の `:focus-visible` が入力にも輪を描き、箱の輪と二重になる。`type="search"` なので、Chrome は入力の右端にネイティブの消去ボタンを出す（モックは `type="text"`）

### チップはリンクのまま、現在地の見た目は `activeProps` / `inactiveProps` で排他に付ける

#### Context
モックのチップは `aria-pressed` のボタンだが、実装の絞り込みは URL の `topic` を変える遷移で、チップは `Link` である。モックの `.chip:hover` は選択中のチップには効かない（後に書かれた `[aria-pressed="true"]` が勝つ）。完了済みトピックのチップには「完了」のバッジがあるが、モックにはバッジの描画が無い。

#### Decision
- チップは `Link` のまま、現在地を `aria-current="page"` で示す（`activeOptions: { exact: true }` は従来どおり）
- 選択中と非選択の見た目は、ルーターの `activeProps` / `inactiveProps` の `className` で排他に付け、ホバーは非選択の側にだけ付ける
- 「完了」のバッジは、memo-history.html の `.selection-badge`（カード地・`--radius-full`・`--text-xs`・`--weight-medium`）に寄せる。選択中のチップ（`--color-primary-lighter` の地）では `--color-primary-darker`、非選択では `--color-neutral-600` の文字にし、縦の余白は持たない（バッジのあるチップだけ背が高くならないように）。選択の状態は `Link` の children の関数から受ける

#### Consequences
- 良い点: チップの見た目の分岐がホバーとの順序に依存しない。バッジは選択中でも読める
- トレードオフ: バッジはモックに無い形で、寄せ先は別画面の役割（版の選択バッジ）

### 0 件は一文にし、絞り込み中だけ解除の導線を添える

#### Context
今の 0 件と「絞り込みのトピックが見つからない」は、`h2` と説明文の 2 段だった。search.html の状態例は、どちらも空状態の一文とテキストのボタン（`.empty-clear`）1 つで、0 件の例には「絞り込みを解除」が付いている。解除は、絞り込みがあるときにしか意味を持たない。

#### Decision
- 0 件は `EmptyState` の一文「「{キーワード}」に一致するメモ・ドキュメントは見つかりませんでした」にする。トピックで絞り込んでいるときだけ、`ButtonLink`（`text`）の「絞り込みを解除」を添え、キーワードだけの検索へ遷移する
- トピック不在は「絞り込みのトピックが見つかりません」と「絞り込みを解除して検索」にする。モックは文にトピック名を入れるが、トピックはゴミ箱へ入っていてチップのスナップショットにも無いので、名前を持てない
- 入力待ちは「キーワードでメモとドキュメントを探せます」の一文にする
- 3 つとも従来どおり `role="status"` で包む

#### Consequences
- 良い点: 空状態がほかの画面と同じ形になる
- トレードオフ: トピック不在の文は、モックと違ってトピック名を含まない

### 追加読み込みの読み込み中と失敗は、「もっと読む」の位置に置き換えて出す

#### Context
今の「もっと読む」は、読み込み中にボタンの文言を「読み込み中…」に変えて無効にし、失敗はサーバーのエラー文言（`displayError`）と「再試行」を `fog-error` で出していた。search.html は、続きの読み込み中を「もっと読む」の位置のスピナー行で描く。追加読み込みの失敗は search.html に例が無く、timeline.html の状態例（「過去のメモを読み込み中」の位置に、空状態の一文「読み込めませんでした」とテキストの「再試行」、`role="alert"`）がある。

#### Decision
- 読み込み中は、ボタンをスピナー行「読み込み中」に置き換える。読み込みを始める操作が画面に残らないので、二重に始まらない
- 失敗は timeline.html の形に寄せ、`role="alert"` の `EmptyState`「読み込めませんでした」と `Button`（`text`）の「再試行」にする。サーバーの文言は出さない
- スナップショットの期限切れ（`INVALID_CURSOR`）は、同じ形で「検索結果の続きを読めなくなりました」と「もう一度検索」（ローダーの読み直し）にする
- 再試行を押したら、失敗の表示をトランジションの外で先に消し、スピナー行に替える
- 「もっと読む」は `Button` の `outline` の段にする。モックの `.more-btn` は `--color-primary-dark` の文字だが、ADR-016 の段に無い色なので段に寄せた（文字は `--color-neutral-900`）

#### Consequences
- 良い点: 追加読み込みの 3 状態が、タイムラインと同じ位置と形で出る
- トレードオフ: 失敗の原因（ネットワークかサーバーか）は文言で区別されない（`RouteError` と同じ）

### 結果の行は `RowLink` と `RowList` に載せる

#### Context
今の結果行は `fog-result-row` で、ホバー面が行の幅に張り出さず、区切り線は行の上辺にあり、ジャンプ矢印は中立色だった。

#### Decision
- 結果は `RowList`（`ordered`）の `<li>` に `RowLink` を置く。ホバー面・区切り線・余白・末尾の紫のジャンプ矢印は、プリミティブが持つ
- 行の中身は search.html の `.result-main` を写す。種別は枠線のピル、スニペットは本文の段、メタは `--text-xs` の `--color-neutral-400` で、トピック名だけ `--color-neutral-500`。`<a>` の中なので、要素は `span` で組む
- 一致箇所の `<mark>` は `--color-primary-lighter` の地に `--color-primary-darker`・`--weight-medium`・`--radius-sm`。モックの `2px 4px` の余白は `--space-xs` に寄せた（tokens.md の寄せ方）
- 件数は `--text-xs`・`--weight-medium`・`--tracking-label` の `--color-neutral-400` で、次の要素との間を `next-sibling:mt-md` で持つ。検索欄・チップの行・結果の間は、根の縦並びの `gap-lg`

#### Consequences
- 良い点: 行リストの形が document.html の基準形と同じ定義から来る
- トレードオフ: メモの行は所属トピックを出さない（`SearchResultItemView` のメモは所属トピックを持たない。モックはメモの行にもトピック名を出している）

## spec / docs への反映が必要な点

- `docs/test.md` の DOM「What is covered」の `search/searchPanel`: 次を書き足す。0 件で絞り込み中だけ「絞り込みを解除」、選択中と非選択のチップとバッジの見た目、結果が `<ol>` のジャンプ行、「もっと読む」の位置のスピナー行、追加読み込みの失敗の一文と再試行（期限切れはもう一度検索）、`SearchSkeleton`（無効の検索欄に URL のキーワード、Sk のチップの行は支援技術から隠す、「検索中」/「読み込み中」、`aria-busy`）。ファイル数（45）は変わらない（スケルトンのテストを同じファイルに置いた）
- `docs/frontend_implementation_example.md` の 98 行目: `SearchSkeleton` が汎用 `Skeleton` から組まれているという記述は、もう当たらない（ステップ 17 の docs の直しに含める）
- `spec/pages/index.md` P-11: 「結果0件: 「見つからなかった」表示」に、絞り込み中なら解除の導線を添えることを足すか判断する（search.html の状態例は添えている。タイムライン P-04 の「絞り込み結果0件」は解除導線を持つ）
- 日時の書式: search.html は「7月20日 12:30」、実装は `presentation/time.ts` の `formatDateTime`（「2026/09/08 10:00」、年つき）のまま。検索は年をまたぐので年を残すか、モックに合わせる書式を `presentation/time.ts` に足すかを決める（担当外なので変えていない）

## 担当外への変更要望

- **`components/ui/Icon` がどのコミットにも入っていない（最優先）**: ユーザーのグローバル gitignore（`~/.config/git/ignore` の `Icon`。macOS の `Icon\r` 用の行）が `apps/web/app/components/ui/Icon/` に当たり、`4bd4470` を含むブランチに `Icon/index.tsx` が無い。`IconButton`・`RowLink` などが import しているので、ブランチを新しく checkout すると typecheck と build が落ちる。この作業では、元の作業ツリー（`/Users/hikaru/github.com/tuanemuy/fog/apps/web/app/components/ui/Icon/index.tsx`）から ignore されたままの複製を置いて検証した（コミットには含めていない）。`.gitignore` に `!apps/web/app/components/ui/Icon/` などの否定を足すか、`git add -f` でコミットする必要がある
- `components/ui` にバッジのプリミティブ: 検索のチップの「完了」、トピック詳細の「完了」、ゴミ箱の種別、履歴の「比較元 / 比較先」が、それぞれ `fog-badge` か画面ごとの定義を持つ。検索では画面内の `ArchivedBadge` で近似した（`.selection-badge` に寄せた形、選択中 / 非選択の 2 トーン）。語も「完了」と「完了済み」（topics.html / topic-detail.html）に揺れている
- `components/ui` にスピナー行のプリミティブ: search.html は timeline.html の `.loading-more` と同形と書いている。検索では画面内の `SearchLoading` で描いた（ステップ 10 のタイムラインも同じものを持つはず）
- 「もっと読む」の段: モックの `.more-btn` は `--border-input` の枠に `--color-primary-dark` の文字で、ADR-016 の `outline`（`--color-neutral-900` の文字）と色が違う。`outline` に寄せた。モックの色を正とするなら `Button` の段の改修になる
