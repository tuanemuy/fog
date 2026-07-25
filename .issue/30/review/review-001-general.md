# レビュー — PR #32 / Issue #30（縦余白を上向きに統一し `mb-*` を排除）

対象コミット: `design: 縦余白を上向きに統一し mb-* を排除`（branch `issue/30/spacing-direction-top`）
変更ファイル: `AppShell` / `CurrentUserPanel` / `SettingsSkeleton` / `AuthSheet` の 4 tsx + `.issue/30/{plan,adr,testing}.md`

---

## 検証の前提と方法

クラス名の付け替えは「値が同じ」だけでは等価性を保証しない。反転後の実際の描画は次の 3 つに依存する。

1. **フォーマッティングコンテキスト** — flex コンテナ内ではマージン相殺が起きず、ブロックコンテナ内では隣接兄弟・親子でマージンが相殺（= max であって和ではない）する
2. **親の padding / border の有無** — 親子相殺は親に上 padding / border がないときだけ起きる
3. **Tailwind クラスの合成** — テンプレートリテラルで共有定数と結合する場合、同一プロパティのクラスが衝突すると CSS のソース順で勝敗が決まる（Tailwind は後勝ちしない）

そこで全 6 箇所について「変更前の DOM ツリー」「変更後の DOM ツリー」を組み立て、各要素の `display` と親の padding まで追って解決値を突き合わせた。結果は N-001 の表にまとめてある。**6 箇所すべてで描画は変更前と一致する**（相殺・二重計上・消失なし）。

Tailwind の解決値も実ファイルで確認した。

- `--spacing-section: var(--space-section)` = 2.25rem = **36px**（`apps/web/app/styles/theme.css:82` → `tokens.css`、`spec/design/tokens.md:120`）
- `--spacing-2xl` = **40px**、`--spacing-md` = **14px**、`--spacing-sm` = **8px**、`--spacing-lg` = **24px**

`mt-section` は `--spacing-section` が `@theme` に登録済みなので実在するユーティリティ（`mb-section` が動いていた以上当然だが、`mt-*` は別ネームスペースではないことを確認済み）。

### Tailwind クラス合成の衝突チェック

指摘されていた 3 定数の中身を実際に読んだ。いずれも `m*` 系ユーティリティを含まないため、`${定数} mt-*` の合成でプロパティ衝突は起きない。

| 定数 | 実体 | `m*` の有無 |
|---|---|---|
| `LINK_FOCUS`（`AppShell/index.tsx:17`） | `focus-visible:outline-2 focus-visible:outline-focus focus-visible:-outline-offset-2` | なし |
| `NAV_ITEM`（`AppShell/index.tsx:22`） | `flex w-full items-center gap-sm px-xs py-row text-base font-medium text-neutral-900 ${LINK_FOCUS} focus-visible:rounded-md` | なし（`px-xs` は水平 padding） |
| `ROW`（`CurrentUserPanel/index.tsx:20` / `SettingsSkeleton/index.tsx:3`） | `flex items-center justify-between gap-md py-row` | なし |

---

## Blockers

なし。

---

## Warnings

- **[W-001]** `AuthSheet` の children ラッパーが素のブロック要素なので、children 側が `mt-*` を持った瞬間にマージン相殺で 36px が黙って食われる
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:31`
  - 理由: `<div className="mt-section">{children}</div>` は padding も border も持たず、BFC も作らないブロック要素。ブロックコンテナの親子マージンは相殺するので、children の**先頭要素**が `mt-*` を宣言すると `max(36px, 子の値)` になり、和にならない。現状は 5 箇所すべて先頭要素が `<form>` / `<div>` / `<p>` で `margin-top: 0`（Tailwind preflight）なので**今は壊れていない**。問題は、本 Issue が「縦余白はすべて `margin-top` で書く」というルールを全画面に敷いたことで、children の先頭に `mt-*` が付く確率が今後上がる点にある。`LoginForm` はすでに `mt-section` を持つ要素を含んでおり（`components/auth/LoginForm/index.tsx:107`）、たまたま 2 番目の子なので無事なだけ。これは `spec/design/tokens.md:132` が「値を見ても実際の間隔がわからなくなる」と書いている失敗そのもので、ルールを入れた PR が同じ罠を新設しているのは筋が悪い
  - 提案: ラッパーを `<div className="mt-section flex flex-col">` にする。flex コンテナは子とマージン相殺しないので上記の罠が構造的に消え、かつ設計側の `.auth-form { display: flex; flex-direction: column; margin-top: var(--space-section) }`（`spec/design/pages/login.html:147-152`）と形も一致する。利用側 5 箇所への影響も確認済みで安全 —— `align-items: stretch` が既定なので `<form>` / `<p>` / `<div>` / `ErrorRetry` の幅は現状どおり 100%、`gap` は付けないので `LoginForm` / `SignupForm` の `<form>` と `.form-links` の間は今までどおり `.form-links` の `mt-section`（36px）が効く（flex アイテムのマージンは相殺しないので値も保存される）

- **[W-002]** ナビシート先頭項目の `index === 0 ? "mt-md" : "border-t …"` は、ハンドルとの間隔の「アンカー」を設計と別物にしている
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:197-199`
  - 理由: 設計側は `.nav-sheet .handle + * { margin-top: 14px }`（`spec/design/pages/timeline.html:879-881`）で、**ハンドルの次に来るもの**に紐づいている。実装は **`NAV_ITEMS` の 0 番目**に紐づいた。NAV_ITEMS の並べ替え・増減に対しては壊れないが（index 0 は常に先頭）、ハンドルとリストの間に要素が入った瞬間（シート見出し、閉じるボタン、区切り線など）に 14px が新要素ではなくナビ 1 項目目に残り、間隔が黙って消える。しかも `mt-md` の宣言はハンドルの JSX から 10 行離れた `.map()` の中にあるため、その要素を足す人がここを見る動機がない。加えて「境界線」と「ハンドルとの間隔」は本来直交する関心事で、三項演算子に相乗りさせたことで「先頭項目に境界線も付けたい」といった将来の変更が単純な追記でできなくなっている
  - 提案: `.map()` 全体を `<div className="mt-md">…</div>` で包み、`index === 0 ? "" : "border-t border-neutral-100"` を元の形に戻す。アンカーが「ハンドルの次のブロック」になって設計の `+ *` と一致し、境界線の分岐も独立に戻る。ハンドル（`mx-auto` のみ、縦マージンなし）とラッパーは隣接兄弟で、ラッパーは flex コンテナでない親（`<nav>`、`pt-md` あり）の中の通常ブロックなので 14px はそのまま出る。DOM が 1 段増えるのが嫌なら、最低限「この `mt-md` はハンドルとの間隔であって項目間の余白ではない」ことを 1 行のコメントで残すこと

- **[W-003]** `ROW` 定数が `CurrentUserPanel` と `SettingsSkeleton` に独立コピーされたままで、AC-6 の不変条件（両者の DOM 形状一致）を守る仕組みが JSDoc の文章しかない
  - 場所: `apps/web/app/components/settings/CurrentUserPanel/index.tsx:20` / `apps/web/app/components/settings/SettingsSkeleton/index.tsx:3`
  - 理由: 両ファイルとも `const ROW = "flex items-center justify-between gap-md py-row";` を別々に宣言している。今回この 2 ファイルは「先頭行に `mt-sm`」という**新しい共有の約束**を追加した（`CurrentUserPanel:33` / `SettingsSkeleton:16`）ので、揃えなければならないトークンが 1 つ増え、ドリフト面が広がっている。片方だけ `mt-sm` を `mt-md` に変えてもコンパイルも lint も通り、症状はストリーミング差し替え時の数 px のガタつきという、気づきにくく再現もしにくい形で出る。CLAUDE.md の「illegal states unrepresentable」を CSS クラスに適用するならここは型ではなく共有定数で守るべき箇所
  - 提案: `components/settings/` 直下に行クラス（`ROW` と先頭行の `mt-sm` を含む）の単一の出どころを置き、両者から import する。少なくとも `SettingsSkeleton` の JSDoc に「`CurrentUserPanel` の余白の持ち方（先頭行 `mt-sm`）と対で維持する」ことを明記して、次に触る人が対の存在に気づけるようにする

- **[W-004]** ラッパー `<div className="mt-section">` の存在理由がコードから読めない
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:31`
  - 理由: 意味を持たない裸の `div` は、次に触る人から見ると「消せる」「クラスを利用側に移せる」に見える。実際には ADR-001 のとおり「`ErrorRetry` が `className` を受け取らない」「シート内の縦リズムを利用側 5 箇所に漏らさない」という非自明な理由で存在している。ADR は `.issue/30/` にあってコードからは辿れない。CLAUDE.md のコメント方針は「WHY が非自明なとき（隠れた制約・不変条件）だけ書く」で、これはまさにその条件に当たる。同じ判断のコメントは `LoginForm/index.tsx:104-106`（`.form-links` を `<form>` の外に出す理由）に前例がある
  - 提案: ラッパーに 1 行、または `AuthSheet` の JSDoc に 1 文追加する。例: 「本文の上余白はシートが持つ。children は 5 画面で形が不揃いで、`ErrorRetry` は `className` を受け取らないため（`spec/design/pages/login.html` の `.auth-form { margin-top }` に相当）」

- **[W-005]** 設定画面の「見出し → 先頭行」は 8px のままで、設計の 12px との乖離が残る
  - 場所: `apps/web/app/components/settings/CurrentUserPanel/index.tsx:33`
  - 理由: 設計側は `.section-head + * { margin-top: 12px }`（`spec/design/pages/settings.html:329-331`）。実装は `mt-sm` = 8px。plan.md のスコープ除外（「向きの反転のみ、値は現行維持」）と AC-5（「変更前と同じ 8px」）に照らせば**この PR としては正しい**が、Issue #30 の完了条件には「4 画面をブラウザで確認し、設計と余白が一致すること」も入っており、設定画面だけはこの PR 後も一致しない。「余白の向きを揃えた」ことで残った値の差が今後「揃っているはず」と誤認されやすくなった点が気になる
  - 提案: 本 PR で直す必要はない。plan.md のスコープ節にはすでに書かれているので、あとは PR の説明か Issue のコメントに「設定の見出し下は 12px（設計）に対し 8px のまま。値の追随は別 Issue」と 1 行残して、後続の画面実装（#2〜#9）で設定画面に触るときに拾えるようにすること

---

## Notes

- **[N-001]** 6 箇所すべてで描画が変更前と一致することを、フォーマッティングコンテキストまで追って確認した。

  | # | 箇所 | 変更前 | 変更後 | 親のコンテキスト | 解決値 |
  |---|---|---|---|---|---|
  | 1 | `AuthSheet` ブランド → h1 | ブランド div `mb-section` | h1 `mt-section` | カード div（ブロック・`py-2xl` あり） | 36px → 36px ✓ |
  | 2 | `AuthSheet` h1 → 説明文 | h1 `mb-lg`（三項） | p `mt-lg` | 同上 | 24px → 24px ✓ |
  | 3 | `AuthSheet` 説明文/h1 → 本文 | p `mb-section` / h1 `mb-section` | ラッパー `mt-section` | 同上 | 36px → 36px ✓ |
  | 4 | `CurrentUserPanel` h2 → 先頭行 | h2 `mb-sm` | 行 `${ROW} mt-sm` | `<section>`（ブロック） | 8px → 8px ✓ |
  | 5 | `SettingsSkeleton` ラベル → 先頭行 | Skeleton `mb-sm` | 行 `${ROW} mt-sm` | `<section>`（ブロック） | 8px → 8px ✓ |
  | 6a | `AppShell` ブランド → サイドナビ | `BrandLink mb-2xl` | `<nav> mt-2xl` | `<aside>`（`lg:flex` の flex column、相殺なし） | 40px → 40px ✓ |
  | 6b | `AppShell` ハンドル → 先頭項目 | ハンドル `mb-md` | 先頭 Link `mt-md` | `<nav>`（ブロック・`pt-md` あり） | 14px → 14px ✓ |

  マージン相殺の検証ポイントは 2 つで、どちらも問題なし。(a) #6b は隣接兄弟の相殺だが、反転後は片側が 0 なので `max(0, 14) = 14` で値が保存される。(b) #3 のラッパーは親子相殺の候補だが、現状 children の先頭要素はすべて `margin-top: 0` なので発火しない（将来の危険は W-001）。カード / シートの下端も、反転で最終子の下マージンが消えたぶん `py-2xl` / `pb-*` がそのまま効く形になり、`spec/design/tokens.md:136` の狙いどおりになっている。

- **[N-002]** 受け入れ基準の検証結果。

  | AC | 内容 | 結果 |
  |---|---|---|
  | AC-1 | `grep -rE '\b(mb\|my)-' apps/web/app` が 0 件 | ✓ 0 件。`\b` 抜きの `(mb\|my)-` でも 0 件、`styles/*.css` に `margin-bottom` / `margin: X 0` もなし |
  | AC-2 | `description === undefined ? …` の分岐削除 | ✓ `AuthSheet/index.tsx:23` は固定クラスの `mt-section` |
  | AC-3 | ログイン / 登録が 36px / 36px | ✓ N-001 #1・#3。`login.html:138-152` と一致 |
  | AC-4 | リセット / 404 / エラーが 36 / 24 / 36 | ✓ N-001 #1〜#3。`password-reset.html:136-158` と一致。`__root.tsx` の 2 経路（404・`ErrorScreen`）も同じ `AuthSheet` を通る |
  | AC-5 | 設定の見出し下 8px、担い手が次要素へ | ✓ N-001 #4。ただし設計値との差は W-005 |
  | AC-6 | スケルトンと実 DOM の余白の持ち方が一致 | ✓ 両者とも「ラベル要素は余白なし + 直後の行に `mt-sm`」。構造的なリスクは W-003、既存の微差は N-004 |
  | AC-7 | サイドバー 40px / ナビシート 14px を維持 | ✓ N-001 #6a・#6b |
  | AC-8 | `typecheck` / `lint` / `format` | ✓ 実行して確認。`pnpm typecheck` は 4 パッケージすべて Done、`pnpm lint` は exit 0（検出は既存の info のみで、本 PR 由来のものはない） |

- **[N-003]** plan.md がリスクに挙げていた「`ErrorRetry fullWidth` がラッパー越しに幅を失わないか」は、コード上は**発生しない**ことを確認した。`ErrorRetry` のルートは `<div className="flex gap-lg flex-col">`（`components/ui/ErrorRetry/index.tsx:23-25`）で、`fullWidth` は `Button` に伝播して `w-full` になる。ラッパー・カードともブロック要素なので、`<div>` の幅は変更前後どちらも親の 100%。W-001 の `flex flex-col` 化を採ったとしても `align-items: stretch` が既定なので同じ。実機確認は残しておくに越したことはないが、リスクの優先度は下げてよい。

- **[N-004]** `SettingsSkeleton` のラベル相当 `Skeleton`（`h-skeleton-line` = `--skeleton-line-h: 1rem` = 16px）と `CurrentUserPanel` の `<h2 className="text-xs">`（`--text-xs: 0.72rem` ≈ 11.5px × preflight の `line-height: 1.5` ≈ 17.3px）で **1.3px 前後の高さ差**がある。差し替え時に理論上その分だけ下がガタつくが、これは本 PR 以前から存在する差で、今回の変更は両者に同じ扱いをしているので悪化も改善もしていない。AC-6 の「レイアウトシフトが起きない」を厳密に取るならここも対象だが、本 Issue のスコープ（余白の向き）外なので指摘には数えない。

- **[N-005]** サイドバーのナビ項目間は実装 `gap-xs` = 4px、設計 `.side-nav { gap: 2px }`（`spec/design/pages/timeline.html:150-154`）で 2px 差がある。既存の乖離で本 PR は触っていない。W-005 と同じく、後続の画面実装で設計値へ寄せるかを判断する材料としてだけ記録しておく。

- **[N-006]** `CurrentUserPanel` / `SettingsSkeleton` の `mt-sm` は「見出しの次の要素」ではなく「メールアドレス行」という**特定の行**に紐づいた。設計の `.section-head + *` は位置に紐づくセレクタなので、行を並べ替えたり見出しの直後に別の行を挿入したりすると挙動が分かれる（`mt-sm` が誤った行に付いてくる）。Tailwind に隣接兄弟バリアントの素直な書き方がなく、`[&>h2+*]:mt-sm` のような任意バリアントは可読性を大きく損なうので、**現状の書き方は妥当な選択**だと判断する。W-002 と同種の「アンカーの差」だが、あちらと違ってこちらは要素間の距離が近く（隣接する 2 行）、壊れたときに目に付きやすいので、指摘ではなく記録に留める。

- **[N-007]** 良い点。三項演算子の削除（`AuthSheet/index.tsx:23`）は、単に `mb` を `mt` に置換したのではなく「下向き余白だから次に何が来るかを知る必要があった」という因果を解いた結果になっていて、Issue が意図していた設計改善がそのままコードに現れている。`AuthSheet` は description の有無を余白の判断材料にしなくなり、新しい pre-auth 画面を足すときに考えることが 1 つ減った。ADR-002 も、設計 HTML が `padding-bottom` で持っていることに機械的に追随せず「`BrandLink` はリンクなので padding にするとクリック領域が 40px 広がる」という副作用を見つけて `margin-top` を選んでいる。設計との 1:1 対応をあえて崩す判断とその理由が ADR に残っており、判断の質が高い。

- **[N-008]** CLAUDE.md の規約への準拠を確認した。変更はすべて `apps/web/app/` のプレゼンテーション層に閉じており、`packages/core` には一切触れていない（レイヤー分離 ✓）。型定義・props の変更はなし（`AuthSheet` の `AuthSheetProps` は不変で、既存 5 箇所の呼び出しは無改修 ✓）。不要なコメントの追加もなし（コメント方針 ✓ — ただし W-004 は「足りない」側の指摘）。Issue の完了条件「例外に当たる箇所があれば理由コメント付き」については、`display: none` で開閉する要素・`em` で余白を持つ要素のどちらにも該当する箇所が実装側になく（ナビシートは `display: none` ではなく条件付きアンマウント、余白は全て `rem` ベースのトークン）、例外コメントが 0 件なのは正しい。

- **[N-009]** アクセシビリティ・既存挙動への影響なし。`inert`（`AppShell:82`）、`aria-expanded` / `aria-controls` / `aria-label`、Escape での閉じ、`sheetRef.current?.querySelector("a")?.focus()` によるシート先頭リンクへのフォーカス移動（`AppShell:70-78`）はいずれも変更されていない。`querySelector("a")` はハンドル（`<div aria-hidden>`）を飛ばして先頭 `<Link>` を拾う実装で、ハンドルから `mb-md` を外しても DOM 上の順序は不変なので影響しない。クリック領域も #6a が margin↔margin の移動（ADR-002 が padding を避けた狙いどおり）、#6b がマージンで当たり判定に含まれない領域どうしの移動なので変化なし。`AuthSheet` のラッパー `div` はロールを持たないので、`<main>` ランドマークと `<h1>` の関係も変わらない。
