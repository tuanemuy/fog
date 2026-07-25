# レビュー #002 — PR #32 / Issue #30（縦余白を上向きに統一し `mb-*` を排除）

**PR:** #32
**Date:** 2026-07-26
**Round:** 2回目（フルレビュー・ゼロベース）
**対象コミット:** `a52fba7` + `262e93d`（`7c48702` からの差分）
**変更ファイル（コード）:** `AppShell` / `CurrentUserPanel` / `SettingsSkeleton` / `AuthSheet` の 4 tsx

台帳（`.issue/30/review/triage.md`）で決着済みの 5 キーは再提出していない。特に `CurrentUserPanel` の 8px vs 設計 12px（defer）は本レビューでは扱わない。

---

## 検証の前提と方法

1 回目と同じく「クラス名が同じ値を指す」ことは等価性の証明にならないので、**変更後の DOM を組み直してフォーマッティングコンテキスト・親の padding・Tailwind クラス合成の 3 点まで追った**。2 回目は特に前回の修正で新たに入った 3 点を起点にしている。

- `AuthSheet` の children ラッパーが `mt-section flex flex-col` になったことによる利用側 5 箇所への影響
- `AppShell` のナビシートで `.map()` が `<div className="mt-md">` に包まれたことによる影響（フォーカス・`inert`・区切り線・キーボード）
- 追加された 2 つのコメント（`AuthSheet` の JSX インライン / `SettingsSkeleton` の JSDoc）

トークンの実値はソースから確認した（`apps/web/app/styles/tokens.css`）。

| トークン | 値 | 用途 |
|---|---|---|
| `--space-section` | `2.25rem` = **36px** | `mt-section` |
| `--space-2xl` | `2.5rem` = **40px** | `mt-2xl` |
| `--space-lg` | `1.5rem` = **24px** | `mt-lg` |
| `--space-md` | `0.875rem` = **14px** | `mt-md` / `pt-md` |
| `--space-sm` | `0.5rem` = **8px** | `mt-sm` |

`--spacing-section` / `--spacing-md` はいずれも `theme.css` の `@theme` ブロック内（`:82` / `:78`）に登録済みで、`mt-section` / `mt-md` は実在するユーティリティ。`styles/index.css` に `@layer base` の 2 ルール以外の独自 CSS はなく、Preflight が全要素の `margin` を 0 にしているので UA スタイル由来の相殺は起きない。

`pnpm typecheck`（4 パッケージすべて Done）／`pnpm lint`（exit 0、22 infos はすべて `biome.json` の deprecated 警告など既存分）／`pnpm format:check`（No fixes applied）を実行して確認済み。

---

## Blockers

なし。

コード上の描画結果・アクセシビリティ・キーボード操作のいずれにも回帰は見つからなかった。以下の Warning はすべて「今は正しく動くが、次に触る人が壊しやすい／記録が実装と食い違っている」種類のもの。

---

## Warnings

- **[W-001]** ラッパーが 36px を持ち切るという不変条件が、`AuthSheet` の JSDoc（= 利用側から見える唯一の説明）に書かれていない
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:10-15`（JSDoc） / `:31-34`（ラッパーとコメント）
  - 理由: 追加された JSX コメントの 1 文目「本文の上余白はシート側が持つ」は、まさに守ってほしい不変条件そのもの。しかしこのコメントを読むのは `AuthSheet` を**編集する人**であって、破るのは `AuthSheet` を**使う人**（`routes/*.tsx` で本文を書く人）。エディタ上で `<AuthSheet>` にホバーして出るのは JSDoc だけで、そこには余白の話が一切ない。

    しかも今回の `flex flex-col` 化で、破ったときの症状が「黙って消える」から「黙って倍になる」に変わった。ブロックのままなら親子相殺で `max(36, 子)` に収まっていたが、flex コンテナは子とマージン相殺しないので `36 + 子` の**和**になる。`spec/design/tokens.md:132` が並べて警戒している 2 つの失敗（相殺と二重計上）のうち、この PR は前者を潰して後者を有効化した形になっている。

    これは机上の心配ではない。設計 HTML は `.auth-form { margin-top: var(--space-section); display: flex; flex-direction: column; gap: var(--space-lg) }`（`spec/design/pages/login.html:147-152`）で、実装の `<form className="flex flex-col gap-lg">`（`LoginForm/index.tsx:64` / `SignupForm/index.tsx:65`）は**この 4 宣言のうち `margin-top` だけが欠けた形**をしている。プロジェクトは「設計 HTML に忠実に実装する」運用なので、新しい pre-auth 画面を足す人・既存フォームを設計と突き合わせる人が `mt-section` を補うのは自然な動きで、その瞬間に 36px が 72px になる。カード外周が `py-2xl`（40px）なので見た目にも崩れるが、原因は 2 ファイルにまたがるため追いにくい。
  - 提案: 台帳で `fix` 済みの「ラッパーを flex にする」判断そのものを覆す必要はない。JSDoc に 1 文足して、不変条件を**呼び出し側から見える場所**に置くだけでよい。例:

    ```
     * The body's top margin belongs to the sheet (`.auth-form { margin-top }`
     * in the design): `children` must not declare one of its own — this
     * container is a flex column, so a child's `margin-top` adds to the
     * sheet's 36px instead of collapsing into it.
    ```

    余力があれば `LoginForm` / `SignupForm` の `<form>` 側にも「`margin-top` は `AuthSheet` が持つので設計の `.auth-form` から意図的に落としている」と 1 行残すと、設計 HTML と突き合わせる作業で気づける。

- **[W-002]** 追加された `AuthSheet` のコメントが、マージン相殺の挙動を実際と逆に説明している
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:31-33`
  - 理由: 現在の文面は「flex にするのは、children 先頭が `mt-*` を持ったときに**親子マージン相殺で 36px が消えない**ため」。しかし親子相殺の結果は `max(36px, 子の値)` を親の外側に置いたものなので、**消えるのは子のマージンのほう**で、36px は（子が 36px 未満である限り）そのまま残る。失われるのは「和」であって 36px ではない。1 回目のレビュー（`review-001-general.md:47`）は「`max(36px, 子の値)` になり、和にならない」と正確に書いており、コードに落とす段で不正確な要約になった。

    メカニズムを説明するために書いたコメントがメカニズムを誤って述べていると、次に読む人が相殺の理解を間違えたまま別の箇所を触る。CLAUDE.md の「WHY が非自明なときだけ書く」を満たしていても、内容が誤りなら書かないより悪い。

    同じコメントに、時間とともに腐る記述が 2 つ入っている点も指摘しておく。
    - 「children は **5 画面**で形が不揃い」 — 現在ちょうど 5 箇所（`login` / `signup` / `password-reset` / `__root` の 404 と `ErrorScreen`）で正しいが、pre-auth 画面が 1 つ増えた時点で誰も直さないまま嘘になる。件数は WHY の成立に必要ない
    - 「**36px** が消えない」 — `--space-section` の値をコメントにハードコードしている。トークン名（`mt-section` / `--space-section`）で書けば追随不要
  - 提案: 3 行を次のように書き換える。件数を落とし、値をトークン名にし、相殺の向きを直す。

    ```
    {/* 本文の上余白はシート側が持つ。children の形は画面ごとに不揃いで、
        ErrorRetry は className を受け取らないため。flex にするのは、children
        先頭の mt-* が親子マージン相殺に飲まれて和にならないのを避けるため */}
    ```

- **[W-003]** `262e93d` の変更が `adr.md` / `plan.md` に反映されておらず、記録が実装と食い違っている
  - 場所: `.issue/30/adr.md:21`（ADR-001 Decision） / `.issue/30/plan.md:66,79,99,117`
  - 理由: `git diff a52fba7..262e93d --stat` で確認したところ、2 コミット目が触ったのは `review-001*.md` / `triage.md` と 3 つの tsx だけで、`adr.md` と `plan.md` は 1 コミット目のまま残っている。結果、次の 3 点が実装と一致しない。

    | 記録 | 実装 |
    |---|---|
    | `adr.md:21` — 「`AuthSheet` が `{children}` を `<div className="mt-section">` でラップする」 | `<div className="mt-section flex flex-col">` |
    | `plan.md:99` — 「先頭のナビ項目（`index === 0`）に `mt-md` を付ける」 | `.map()` 全体を `<div className="mt-md">` で包む |
    | `plan.md:117`（リスク） — 「ナビシート先頭項目に付ける `mt-md` は既存の `index === 0 ? …` と同じ条件分岐に乗る」 | もう乗っていない。境界線の分岐と直交させたのが今回の修正の主眼 |

    `.issue/` は `git ls-files` で確認したとおりリポジトリに追跡されており（`.issue/1/` 以下も同様）、`plan.md`／PR 本文の両方が「設計判断は `.issue/30/adr.md`」と読者を誘導している。ADR は「なぜこの形なのか」を後から辿る唯一の一次記録なので、採用されなかった案が Decision に残っているのは、Warning のなかで最も実害が出やすい。特に **flex 化の理由（相殺の罠）は ADR-001 の Consequences に一行もない** ため、将来「この裸の div は要らないのでは」「flex は無意味なので外そう」と判断される余地が残っている。`plan.md:117` に至っては、現在の実装と正反対のことを注意喚起している。
  - 提案: `adr.md` の ADR-001 に flex の記述を追記する（Decision の形を `flex flex-col` に直し、Consequences に「ブロックのままだと children 先頭の `mt-*` が相殺に飲まれる／flex なら和になるので children は上余白を持たない約束が要る」を足す）。`plan.md` はステップ 4 の記述とリスク節の該当 bullet を実装に合わせて更新する。あわせて ADR の Status が 2 件とも `Proposed` のままなので、マージ前に `Accepted` へ倒すこと。

- **[W-004]** `AppShell` の 2 箇所は設計 HTML から**意図的に**ずらしているのに、その理由がコードから辿れない
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:84-90`（サイドバー） / `:186-190`（ナビシート）
  - 理由: サイドバーは設計側が `.brand { padding: 0 var(--space-md) var(--space-2xl) }`（`spec/design/pages/timeline.html:140-149`）と **padding** で 40px を持っている。実装は `BrandLink` を `px-md` だけにして 40px を `<nav className="mt-2xl">` に移した。これは ADR-002 の「`BrandLink` は `createLink` で `<a>` を返す（`components/ui/BrandLink/index.tsx:19`）ので `pb-2xl` にするとクリック領域が下に 40px 広がる」という副作用回避が理由で、判断としては妥当。

    問題は、その理由が `.issue/30/adr.md` にしかないこと。コードだけを見ると「設計は `padding-bottom`、実装は次要素の `margin-top`」という素直でない対応になっていて、設計 HTML と実装を突き合わせる作業（`testing.md` がまさに指示している作業）をした人は「実装が設計とずれている」と読む。`pb-2xl` に戻せば `mb-*` も増えず typecheck も lint も通り、当たり判定だけが黙って 40px 広がる。

    1 回目の W-004（`AuthSheet` のラッパーに存在理由のコメントを、`fix` 判定）とまったく同じ構図 —— 「非自明な制約でこの形になっている／戻すと静かに壊れる」 —— なのに、`AuthSheet` にだけコメントが付いて `AppShell` は素通しになっており、扱いが非対称になっている。CLAUDE.md の「WHY が非自明なとき（隠れた制約）だけ書く」の条件を満たしているのは両方とも同じ。

    ナビシートの `<div className="mt-md">` も同種だが、こちらはハンドルの直後にあって「ハンドルとの間隔」と読めるので、優先度は低い。ただし 14px という値が設計の `.nav-sheet .handle + * { margin-top: 14px }` に対応していることは読み取れない。
  - 提案: `BrandLink` 側に 1 行足す。例: `{/* 設計は .brand の padding-bottom だが、BrandLink は <a> なので padding にするとクリック領域が 40px 下に広がる。余白は nav の mt-2xl が持つ */}`。ナビシートは任意だが、入れるなら `<div className="mt-md">` に「設計の `.nav-sheet .handle + *`」を指す 1 行。

---

## Notes

- **[N-001]** 2 コミット目で入った 2 つのラッパーについて、描画が変わらないことをフォーマッティングコンテキストまで追って確認した。**両方とも変更前と一致する。**

  **(a) `AuthSheet` の `<div className="mt-section flex flex-col">`**

  | 利用側 | children のルート | ブロック時の幅 | flex アイテム時の幅 | 差分 |
  |---|---|---|---|---|
  | `routes/login.tsx` | `<>` → `<form className="flex flex-col gap-lg">` + `<div className="mt-section flex flex-col gap-sm">` | 100% | `align-items: stretch` で 100% | なし |
  | `routes/signup.tsx` | 同上 | 100% | 同上 | なし |
  | `routes/password-reset.tsx` | `<div className="text-center text-sm">` | 100% | 100% | なし |
  | `routes/__root.tsx` 404 | `<p className="text-center text-sm">` | 100% | 100% | なし |
  | `routes/__root.tsx` ErrorScreen | `ErrorRetry` → `<div className="flex gap-lg flex-col">` | 100% | 100% | なし |

  - **幅** — 5 箇所すべて `width: auto` なので `align-items: stretch`（既定）で親幅いっぱい。`ErrorRetry fullWidth` は `Button` に `w-full` を渡す実装（`components/ui/ErrorRetry/index.tsx:23-33`）で、ラッパーが 100% である限り従来どおり。plan.md がリスクに挙げていた点は解消。
  - **高さ** — ラッパーの高さは `auto`（親のカードがブロック）。主軸サイズが content ベースのとき flex アイテムは縮まないので `flex-shrink: 1` は発火しない。
  - **折り返し** — `flex-wrap: nowrap` の column なので縦積み。ブロックレイアウトと同じ。
  - **`LoginForm` / `SignupForm` の 2 子構成** — 変更前は `<form>` と `.form-links` がカード直下のブロック兄弟で、隣接兄弟相殺は `max(0, 36) = 36`。変更後は flex アイテムどうしで相殺なしの 36px。値は保存される。ラッパーに `gap` を付けていないので、`LoginForm/index.tsx:108-110` のコメントが警戒する「`gap-lg` と `mt-section` の二重取り」も起きない。
  - 唯一の理論上の差は「children に生の文字列や inline 要素を並べた場合、ブロックなら 1 行に流れるが flex では各々がブロック化して縦積みになる」点。現在の 5 箇所はすべてブロック要素を 1〜2 個渡しているので該当しない。

  **(b) `AppShell` ナビシートの `<div className="mt-md">`**

  - `<nav className="… px-lg pt-md pb-safe-b-2xl …">`（`:184`）は `pt-md` = 14px を持つので親子相殺は最初からブロックされている。ハンドル `<div className="mx-auto h-handle-h w-handle-w …">`（縦マージンなし）とラッパーは隣接兄弟で `max(0, 14) = 14px`。設計 `.nav-sheet .handle + * { margin-top: 14px }`（`timeline.html:879-881`）と一致。
  - ラッパー自身の `mt-md` と最初の `<Link>` の `margin-top` の親子相殺は、`<a>` 側が Preflight で 0 なので発火しない。
  - `NAV_ITEM` の `w-full` はラッパー（幅 auto = `<nav>` のコンテンツ幅）に対して 100% なので、リンク幅も従来どおり。
  - ハンドルの `mx-auto` は維持されており、中央揃えは崩れていない（`testing.md` の確認ポイントを満たす）。

- **[N-002]** ナビシートの周辺挙動（タスクで名指しされた 4 点）はいずれも壊れていない。

  | 対象 | 判定 | 根拠 |
  |---|---|---|
  | フォーカス移動 `sheetRef.current?.querySelector("a")?.focus()`（`:72`） | ✓ | `querySelector` は子孫セレクタなので `<div>` を 1 段挟んでも先頭 `<a>` を拾う。ハンドルは `<div aria-hidden>` で `<a>` ではないので、拾う要素は変更前と同じ「タイムライン」リンク |
  | `inert`（`:82`） | ✓ | シートの外側（`<div inert={navOpen}>`）に付いており、今回の変更範囲と交わらない |
  | 区切り線 | ✓ | `index === 0 ? "" : "border-t border-neutral-100"` が元の形に戻り、設計の `.nav-item + .nav-item { border-top }`（`timeline.html:884-886`）と 1:1。先頭項目に線が付かないことも保たれている |
  | キーボード操作 | ✓ | Escape ハンドラ（`:57-66`）・`aria-expanded` / `aria-controls` / `aria-label`・`restoreFocus` の復帰（`:70-78`）はいずれも無改修。Tab 順は DOM 順のままで、非セマンティックな `<div>` を挟んでも変わらない |

  `<nav>` 直下に `<div>` を挟むことによる支援技術への影響もない（元からリスト要素は使っておらず、`<div>` はロールを持たない）。

- **[N-003]** 受け入れ基準の検証結果。**AC-1〜AC-8 はコード上すべて満たしている**（AC-3〜AC-7 の実機計測は `testing.md` に従って別途実施が必要）。

  | AC | 内容 | 結果 |
  |---|---|---|
  | AC-1 | `grep -rE '\b(mb\|my)-' apps/web/app` が 0 件 | ✓ 0 件。`\b` なしの緩い `(mb\|my)-` でも 0 件（`-mb-` / `mb-[…]` も拾う形）。加えて `space-y-*` / `marginBottom` / `margin-bottom` / `margin-block-end` を `apps/web/app` と `apps/web/scripts` で検索して 0 件、`styles/index.css` の独自 CSS にも下余白なし |
  | AC-2 | `description === undefined ? …` の分岐削除 | ✓ `AuthSheet/index.tsx:23` は固定の `mt-section` |
  | AC-3 | ログイン / 登録が 36px / 36px | ✓ ブランド div（余白なし）→ h1 `mt-section` 36px、→ ラッパー `mt-section` 36px。`login.html:127-152` と一致 |
  | AC-4 | リセット / 404 / エラーが 36 / 24 / 36 | ✓ h1 `mt-section` → p `mt-lg`(24px) → ラッパー `mt-section`。`password-reset.html:125-158` と一致。`__root.tsx` の 2 経路も同じ `AuthSheet` を通る |
  | AC-5 | 設定の見出し下 8px、担い手が次要素へ | ✓ h2 は余白なし、`<div className={`${ROW} mt-sm`}>` が 8px を持つ。2 行目 `${ROW} border-t` には `mt` がなく二重計上なし |
  | AC-6 | スケルトンと実 DOM の余白の持ち方が一致 | ✓ 両者とも「ラベル要素は余白なし + 直後の行に `mt-sm`」。`Skeleton` は `<span className="block …">`（`ui/Skeleton/index.tsx:14-18`）でブロックなので、`<h2>` との置換でフローは変わらない |
  | AC-7 | サイドバー 40px / ナビシート 14px | ✓ `<aside>` は `lg:flex` + `flex-col` なので `BrandLink` と `<nav>` は flex アイテム（相殺なし）で `mt-2xl` = 40px がそのまま出る。ナビシートは N-001(b) |
  | AC-8 | `typecheck` / `lint` / `format` | ✓ 実行して確認。typecheck 4/4 Done、lint exit 0（本 PR 由来の指摘なし）、`format:check` は No fixes applied |

  Tailwind クラス合成の衝突も再確認した。`ROW`（`flex items-center justify-between gap-md py-row`）・`BAR`（`h-skeleton-line w-full max-w-skeleton-short`）・`NAV_ITEM`・`SIDE_LINK`・`LINK_FOCUS` のいずれも `m*` 系ユーティリティを含まないので、`${定数} mt-sm` / `${定数} …` の合成でマージンのプロパティ衝突は起きない。

- **[N-004]** Issue #30 の完了条件のうち「例外に当たる箇所があれば理由コメント付き」は、**例外 0 件が正しい**ことを再確認した。`tokens.md:140-143` の例外は (1) `display: none` で開閉する要素 (2) `em` で余白を持つ要素の 2 つ。ナビシートは `display: none` ではなく `navOpen ? … : null` の条件付きアンマウント（`AppShell:179`）で、閉じている間は DOM 自体が無いので「閉じても上余白が残る」問題は構造的に起きない。余白はすべて `rem` ベースのトークン経由で、`em` 指定は `apps/web/app` に存在しない。

- **[N-005]** `SettingsSkeleton` の JSDoc 追記（`:9-11`）は内容が実装と一致しており、書き方も適切。「the leading row's `mt-sm`, not a margin under the label」と**どちらに余白が付くか**まで名指ししているので、片方だけ書き換えたときに気づける。CLAUDE.md の「Library-level JSDoc on exported APIs is welcome」にも「不変条件は書いてよい」にも合致する。共有定数への抽出（1 回目の W-003 の本命案）は見送られたが、台帳で「共有定数の抽出はスコープ外」と決着済みなので妥当な着地。

- **[N-006]** コメントの言語について。`AuthSheet` の追加分は JSX インライン・日本語で、`LoginForm/index.tsx:108-110` / `SignupForm/index.tsx:116-118` の既存 JSX コメント（日本語）と揃っている。一方 `AppShell/index.tsx:114-118,156-159` の JSX コメントは英語なので、リポジトリ全体では JSX インラインが日本語 3 / 英語 2 の混在。JSDoc は全ファイル英語で一貫（`AuthSheet` / `SettingsSkeleton` / `Skeleton` / `BrandLink` / `ErrorRetry`）。今回の追加は「JSX インライン=日本語 / JSDoc=英語」という多数派の慣習に沿っており、**新たな不整合は持ち込んでいない**。ただし W-001 の提案どおり JSDoc に不変条件を足す場合は、既存に合わせて英語で書くこと。

- **[N-007]** 良い点。

  - 1 回目の指摘 4 件がすべて**言われたとおりではなく、指摘の狙いに沿った形**で入っている。特にナビシートは「先頭項目に `mt-md`」を撤回して `.map()` ごとラップし、設計の `.handle + *` と同じアンカー（= ハンドルの次に来るブロック）に戻したうえで、境界線の `index === 0` 分岐を元の独立した形に復元している。余白と境界線という直交する 2 つの関心事が再び分離され、「先頭項目にも線を付けたい」といった将来の変更が単純な追記でできる状態に戻った。
  - 三項演算子の削除（`AuthSheet:23`）は単なる `mb`→`mt` の置換ではなく、「下向きだから次に何が来るかを知る必要があった」という因果そのものを解いている。`AuthSheet` は `description` の有無を余白の判断材料にしなくなり、Issue が意図した設計改善がコードに現れている。
  - ADR-002 が設計 HTML の `padding-bottom` に機械的に追随せず、「`BrandLink` は `<a>` なので当たり判定が 40px 広がる」という副作用を自力で見つけて `margin-top` を選んでいる。設計との 1:1 対応をあえて崩す判断とその根拠が残っているのは質が高い（記録場所の問題は W-003 / W-004）。
  - CLAUDE.md のレイヤー規約への違反なし。変更は `apps/web/app/` のプレゼンテーション層に閉じており `packages/core` に一切触れていない。`AuthSheetProps` は不変で、利用側 5 箇所は無改修。

- **[N-008]** 本 PR とは無関係の既存乖離を、後続の画面実装（#2〜#9）の材料として記録しておく。**どれも本 PR で直す必要はない**（余白の「向き」ではなく「値」の話で、スコープ外）。

  | 箇所 | 実装 | 設計 |
  |---|---|---|
  | サイドバーのナビ項目間 | `gap-xs` = 4px | `.side-nav { gap: 2px }`（`timeline.html:150-154`） |
  | サイドリンクのアイコン間 | `gap-sm` = 8px | `.side-link { gap: 10px }`（`timeline.html:155-157`） |
  | ナビシート項目の左右 padding | `px-xs` = 4px | `.nav-item { padding: var(--pad-row) 2px }`（`timeline.html:883`） |
  | ナビシート項目のアイコン間 | `gap-sm` = 8px | `.nav-item { gap: 10px }`（`timeline.html:882`） |

  設定画面の「見出し → 先頭行」8px vs 設計 12px は台帳で defer 済み（Phase 5 で別 Issue）なので、上表には含めていない。

---

## まとめ

| 区分 | 件数 |
|---|---|
| Blockers | 0 |
| Warnings | 4 |
| Notes | 8 |

コードの描画結果・アクセシビリティ・キーボード操作に回帰はなく、AC-1〜AC-8 はすべて満たしている。Warning 4 件はいずれも「今は動くが記録・説明が実装に追いついていない」類で、W-003（ADR / plan の更新）と W-001（不変条件を JSDoc へ）はマージ前に片付けておく価値がある。W-002 は文面の修正のみ、W-004 は 1 行のコメント追加で足りる。
