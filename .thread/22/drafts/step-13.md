# ステップ 13 履歴 — 設計判断と申し送りの下書き

## 版の行は画面側の 1 実装にし、行全体のトグルボタンをプリミティブに足す要望を残す

### Context
履歴の版の行は、行全体が 1 つの選択ボタンで、押された状態の面（`--color-primary-lighter`）と「比較元」「比較先」のバッジを持つ（memo-history.html / document-history.html の `.revision-row`）。ADR-017 の `RowLink`（行全体がリンクで末尾にジャンプ矢印）にも `Row`（独立ボタンを持ち、行にホバー面が無い）にも入らない。ADR-017 は「要るならステップ 11・13 で段を足す」としたが、画面ステップは `components/ui/` を変えない。

### Decision
- 行は `components/memoHistory/RevisionList` に置き、`RowList`（`ordered`）の `<li>` の中に描く。区切り線は `RowList` のまま（張り出しに追従しない）
- 見た目は `RowLink` の組み立てを写す。`-mx-md` の張り出し、`px-md py-row`、`rounded-md`、`hover:bg-neutral-50`、内側 2px のフォーカスリング。`<li>` を縦並びの flex にして、張り出した行を `<li>` の幅いっぱいに伸ばす
- 版が 1 件のときは同じ箱を `div` で描き、何も反応しない
- メモ履歴とドキュメント履歴は、この一覧と `RevisionDiff`（差分の領域）・`RollbackControl`（戻す操作）・`RevisionHistorySkeleton` を共有する。ドキュメント側は `components/memoHistory/*` を読み込む（既存の `DiffView` と同じ向き）

### Consequences
- 良い点: 2 画面の行・差分・戻す操作が 1 つの実装になる
- トレードオフ: 行全体のボタンの見た目が `components/ui` の外にある。**要望（担当外: `components/ui/`）**: `RowToggle`（行全体の `aria-pressed` ボタン、選択時の面とバッジの枠）をプリミティブに足し、`RevisionList` をそれで置き換える。理由は、行全体のボタンが今後ほかの画面に出たときに画面ごとの再定義に戻らないため

## 版の呼び名を時刻にし、成功と「既に同じ」はトースト、失敗はその場に残す

### Context
モックは版を時刻で呼ぶ（行・「比較元 · 7月18日 09:05」・「7月18日 09:05 → 7月20日 12:31 の差分」・確認文「7月18日 09:05 の内容で新しいリビジョンを作ります。これまでの履歴は残ります。」）。現行は「リビジョン N」で呼び、選択の手順を説明する文（「比較元のリビジョンを選んでください」）と、シート内の戻るリンク（「← タイムラインへ戻る」「← タイトル」）を持っていた。ロールバックの結果は、成功は遷移だけ、同内容はインラインの `fog-notice`、失敗は `fog-error` だった。

### Decision
- 行・差分の見出し・操作の対象・確認文から「リビジョン N」を外し、時刻（`formatDateTime`）で呼ぶ。手順の説明文とシート内の戻るリンクは撤去する（戻るはヘッダー）
- 戻す成功はトースト「<時刻> の内容に戻しました」を、遷移の後に出す（ADR-010 の成功）。現在の内容と同一だったとき（`unchanged` / `changed: false`）もトースト「現在の内容は既にこのリビジョンと同じです」にする（付け先の無い一度きりの知らせ）。文言はモックに無いので、成功は既存の動詞「戻す」と確認文の時刻から組んだ
- 戻すの失敗は、操作の行の下に `InlineAlert`（error、再試行なし）で残す。ボタンはそのまま押し直せる
- 差分の取得失敗は、差分の領域に `InlineAlert`（error）と「再試行」で残す（新しい分岐。再試行は同じ二点を取り直す）
- 差分の読み込み中は、差分の箱を `Sk` の行で描く（ADR-005）
- `RollbackControl` は比較元で key を張り、比較元が変わると失敗の表示を消す

### Consequences
- 良い点: 2 画面の文言がモックと一致し、成功と失敗の持ち場が ADR-010 / ADR-020 どおりになる
- トレードオフ: 同じ分に作られた 2 つの版は、画面上で同じ時刻に見える（区別はバッジと並び順だけ）。時刻の書式は `presentation/time.ts` の `formatDateTime`（`2026/07/20 12:42`）のままで、モックの「7月20日 12:42」とは違う（`presentation/time.ts` は共有で、書式の変更は担当外）

## ドキュメント履歴はタイトルを `h1` にして宣言を `"sheet"` にし、メモ履歴は `"header"` のまま

### Context
ADR-023 どおり、document-history.html はシート内の `.doc-title` が `h1` で、memo-history.html はヘッダーの `memo` が `h1` である。

### Decision
- ドキュメント履歴はタイトルを `h1` で描き、ルートの宣言を `h1: "sheet"` に切り替える。その下の履歴は `.history-section`（`mt-section`・ヘアライン・`pt-lg`）で始める
- メモ履歴は宣言を `"header"` のまま保ち、シートは「履歴」のセクションラベル（`h2`）から始める

### Consequences
- トレードオフ: ドキュメント履歴の読み込み中（スケルトン）・見つからない・ルートエラーの間は、ページに `h1` が無い。スケルトンのタイトルは `Sk` だけで名前を持たないので `p` にした。見つからない表示は `knowledge/KnowledgeNotFound`（ステップ 11 の担当）を使い、ルートエラーはアプリシェルの枠（`"frame"`）で段落になる。**要望（担当外: ステップ 11 と `components/ui/`）**: 宣言が `"sheet"` のページで、見つからない表示とルートエラーの一文を `h1` にする経路（`KnowledgeNotFound` に `asPageHeading` を渡す、または ADR-029 のコンテキストをルートの宣言から配る）を決める。同じことはドキュメント閲覧・トピック詳細にも当てはまる

## モックとの差として残したもの

### Context
モックには、実装に無いものと、実装にあってモックに描かれていないものがある。

### Decision
- メモ履歴の「現在の内容」（`.list-label` とメモ本文）は置かない。P-05 に無く、`listMemoRevisions` はメモ本文を返さない（本文を足すのはユースケースの変更で、plan.md のスコープ外）。削除済みメモの履歴も読めるので、`getMemo`（ゴミ箱のメモは存在しない扱い）では代わりにならない
- ドキュメント履歴の「1 回目の選択で最新との差分を出す」（決定 △-5）は保つ。モックの 1 回目の選択の例には差分が無い。差分の見出しは、比較先が暗黙の最新のとき「（最新）」を付ける
- 「この内容に戻す」は 1 回目の選択から出す（P-05「比較元の版の『この内容に戻す』」）。モックは 2 回目の選択の例にだけ描いている
- 差分の記号の列幅は、モックの 16px を `--icon-sm`（`w-icon-sm`）に寄せた。記号は行頭のグリフの役割として扱った
- スケルトンの「履歴」のラベルは、`Sk` で包まず本物の文字で描く。`SectionLabel` の `children` は `string` だけで、`Sk` を載せられない（画面の固定の語で、読み込むデータではない）

### Consequences
- spec / docs への反映の候補: P-05 に「現在の内容」を載せるかどうか（載せるならユースケースに本文が要る）、P-05 / P-10 の「ロールバック成功」に「成功はトーストで知らせる」と、「現在の内容と同一なら何も積まず、トーストで知らせて留まる」を足す。モックの 1 回目の選択（ドキュメント）と操作の行の出る時点を実装に合わせるかは、デザイン側の判断
- **要望（担当外: `components/ui/SectionLabel`）**: スケルトンでラベルを `Sk` で包めるようにする（`children` に `Sk` を許すか、`skeleton` の段を持つ）

## 担当外で見つけたこと

### Context
載せ替えの途中で、担当外のファイルに次の点を見つけた。どれも変更していない。

### Decision
記録だけにする。

### Consequences
- `components/ui` の `min-w-0`（`RowLink`・`Row`・`RowError`・`InlineAlert`・`ComposerError`・`TextField` の styles）は、ADR-018 のとおり何も生成しない（ビルドの CSS に `.min-w-0` が無いことを確認した）。長い語で行の本文の列が縮まない。`min-w-[0]` にする必要がある（担当外: `components/ui/`）
- `ConfirmDialog` の保留中の文言は `${confirmLabel}中…` で、履歴では「戻す中…」になる（担当外: `components/ui/ConfirmDialog`）
- ロールバックの成功は、`staleTime: Infinity` のルート（`/documents/$documentId`）へ `router.invalidate()` なしで遷移する（既存の挙動のまま）。先に開いていたドキュメントがキャッシュに残っていると、戻す前の内容が出うる。CLAUDE.md の「Every mutation reconciles with `router.invalidate()`」との差で、Issue で追うかを判断してほしい（メモ側のタイムラインも `staleTime: Infinity` で、同じ `?memo=` の URL を先に開いていれば同じことが起きうる。どちらもブラウザでは確かめていない）
- `docs/test.md` の DOM「What is covered」: `memoHistory/revisionHistory` と `documents/documentRevisionHistory` の記述を、時刻で呼ぶ版・トースト・差分の再試行と読み込み中・シートの `h1` に直し、`memoHistory/memoHistoryFeed`（見つからない表示と、それ以外の失敗を通すこと）と `memoHistory/revisionHistorySkeleton`（busy の status と `Sk` の行、ドキュメントのタイトル行）を足す（ファイル数 +2）
