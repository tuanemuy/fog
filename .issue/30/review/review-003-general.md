# レビュー #003 — PR #32 / Issue #30（縦余白を上向きに統一し `mb-*` を排除）

**PR:** #32
**Date:** 2026-07-26
**Round:** 3回目（フルレビュー・ゼロベース）
**対象:** `origin/main...HEAD` = `a52fba7` + `262e93d` + `5f2e172`
**変更ファイル（コード）:** `AuthSheet` / `AppShell` / `CurrentUserPanel` / `SettingsSkeleton` / `LoginForm` / `SignupForm` の 6 tsx

台帳（`.issue/30/review/triage.md`）で決着済みの 10 キーは再提出していない。特に次の 2 件は本レビューでは扱わない。

- `CurrentUserPanel` の 8px vs 設計 12px（**defer** — Phase 5 で別 Issue）
- ADR の Status を `Accepted` に倒す提案（**wont-fix** — `.issue/1/adr.md` の慣習に合わせる）

---

## 検証の前提と方法

ゼロベースで組み直した。「クラス名が同じ値を指す」ことは等価性の証明にならないので、変更後の DOM を再構成し、**フォーマッティングコンテキスト / 親の padding・border / Tailwind クラス合成**の 3 点まで追った。加えて 3 ラウンド目の主眼として、**追加された 5 つのコメントの内容が CSS の実挙動と一致するか**を、コメント 1 文ずつ実装に突き合わせた。

トークンの実値（`apps/web/app/styles/tokens.css:90-96` / `theme.css:76-93`）:

| トークン | 値 | `@theme` 登録 | 用途 |
|---|---|---|---|
| `--space-section` | `2.25rem` = **36px** | `--spacing-section`（`theme.css:82`） | `mt-section` |
| `--space-2xl` | `2.5rem` = **40px** | `theme.css:81` | `mt-2xl` |
| `--space-lg` | `1.5rem` = **24px** | `theme.css:79` | `mt-lg` |
| `--space-md` | `0.875rem` = **14px** | `theme.css:78` | `mt-md` / `px-md` / `pt-md` |
| `--space-sm` | `0.5rem` = **8px** | `theme.css:77` | `mt-sm` |

静的チェックは実行して確認済み。

- `pnpm typecheck` — 4 パッケージすべて Done
- `pnpm lint` — exit 0（22 infos はすべて `biome migrate` 系の既存分、本 PR 由来なし）
- `pnpm format:check` — No fixes applied
- `grep -rE '\b(mb|my)-' apps/web/app` — **0 件**。`\b` を外した緩い `(mb|my)-`（`-mb-` / `mb-[…]` も拾う）でも 0 件。`margin-bottom` / `marginBottom` / `margin-block-end` / `space-y-*` を `apps/web/app` + `apps/web/scripts` で検索しても 0 件

---

## Blockers

**なし。**

描画結果・アクセシビリティ・キーボード操作のいずれにも回帰は見つからなかった（N-001 / N-002）。以下の Warning は 3 件とも「コードは正しく動くが、その正しさを説明している文章が不正確」という同一の性質を持つ。

---

## Warnings

- **[W-001]** `AuthSheet` の JSDoc が書いている不変条件が実際より広く、リポジトリ自身の主要な利用箇所がそれを破っている
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:16-19`（あわせて `.issue/30/adr.md:35`）
  - 理由: 追加された JSDoc は次のとおり。

    ```
    * The body's top margin belongs to the sheet (`.auth-form { margin-top }` in
    * the design): `children` must not declare one of its own. The wrapper is a
    * flex column, so a child's `margin-top` adds to the sheet's
    * `--space-section` instead of collapsing into it.
    ```

    2 文目の「**a child's** `margin-top` adds to the sheet's `--space-section`」が成り立つのは**先頭の子だけ**。裸のブロックだったときに相殺の候補になるのは「親（ラッパー）の `margin-top` と先頭の in-flow 子の `margin-top`」のペアであって、2 番目以降の子の `margin-top` は元から相殺の対象外で、ブロックでも flex でも「兄弟間の間隔」として同じ 1 回だけ効く。シートの 36px には**加算されない**。

    これは机上の区別ではない。`LoginForm` / `SignupForm` は `<>` を返すので、ラッパーの直接の子は `<form>` と `.form-links` の 2 つになる。

    ```tsx
    // apps/web/app/components/auth/LoginForm/index.tsx:113
    <div className="mt-section flex flex-col gap-sm text-center text-sm text-neutral-600">
    ```

    つまり **`children` は「自分の `margin-top`」を宣言している**（設計 `login.html:299-305` の `.form-links { margin-top: var(--space-section) }` に対応した、意図どおりの 36px）。JSDoc を字義どおり読むと、この PR のリファレンス実装 2 つが文書化された不変条件に違反していることになる。`AuthSheet` を使う人（＝ JSDoc を読む人）が `.form-links` を見て「じゃあこの `mt-section` は消すべきだ」と判断すると、フォームとリンク群がくっついて壊れる。逆に「2 番目の子でも加算されるらしい」と誤解すると、正しい書き方を避けてしまう。

    なお `plan.md:120` は「children **先頭**が `mt-*` を持つとラッパーの `mt-section` に加算される」と正確にスコープを切っている。実装コードのコメントと ADR の Consequences（`adr.md:35`「『children は上余白を持たない』という約束」）だけが、より弱いはずの制約を無条件の禁止として記述している。
  - 提案: 不変条件を「先頭の子」に閉じる。1 語足すだけで足りる。

    ```
    * The body's top margin belongs to the sheet (`.auth-form { margin-top }` in
    * the design): the *first* child must not declare one of its own — the
    * wrapper is a flex column, so its `margin-top` would add to the sheet's
    * `--space-section` instead of collapsing into it. Margins between the
    * children themselves are theirs to own (`.form-links` in the design).
    ```

    `adr.md:35` の「『children は上余白を持たない』という約束」も同様に「children 先頭は上余白を持たない」に直す（`plan.md:120` の表現に揃う）。

- **[W-002]** 同じファイルの JSDoc と JSX インラインコメントが、`flex` を選んだ理由を**互いに逆向き**に説明している
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:36-38`（JSDoc は `:16-19`）
  - 理由: 2 つのコメントの主張を並べると噛み合っていない。

    | | 文面 | 読み取れる規範 |
    |---|---|---|
    | JSDoc `:18-19` | 「flex column なので子の `margin-top` はシートの `--space-section` に**加算される**」＋「children は上余白を持つな」 | **加算が失敗モード**。だから禁止する |
    | インライン `:37-38` | 「flex にするのは、children 先頭の `mt-*` が親子マージン相殺に飲まれて**和にならないのを避ける**ため」 | **和になることが目的**。だから flex にする |

    インラインコメントの CSS の記述自体は正しい（flex コンテナは子とマージン相殺しないので、確かに和になる）。R2 の W-002 が指摘した「相殺で消えるのは子側」という向きの誤りは解消している。問題は**目的の記述**で、この 1 文だけを読んだ人は「children 先頭は `mt-*` を持ってよく、むしろ正しく足されるように flex にしてある」と理解する。JSDoc の禁止と正面から衝突し、13 行しか離れていない同じファイルの中で読者がどちらを信じるかに賭ける形になっている。

    ADR-001（`adr.md:27`）が挙げている実際の理由はそのどちらでもない。

    > 裸のブロックにすると、children 先頭が `mt-*` を宣言したときに親子マージン相殺が起きてラッパーの `mt-section` と融合し、**シートの余白が children の中身に左右されてしまう**（相殺の結果は `max(--space-section, 子の値)`）。flex コンテナは子とマージン相殺しないので、**ラッパーの余白は children の形に関わらず保存される**。

    守りたいのは「ラッパー自身の 36px が children の中身に依存しないこと」であって、「子の余白が足されること」ではない。実際、`children` 先頭が `mt-*` を持たないという不変条件が守られている限り、インラインコメントが避けたいと言っている事象（相殺で和にならない）は**そもそも起きない** — 理由として空振りしている。

    CLAUDE.md の「WHY が非自明なときだけ書く」を満たしていても、書いてある WHY が実際の WHY と別物なら、次に触る人はその別物を前提に判断する。R2 の指摘（内容が誤りなら書かないより悪い）と同じ性質の問題が、修正後の文面に形を変えて残っている。
  - 提案: どちらか一方に寄せる。ADR の理由をそのまま短く写すのが素直。

    ```tsx
    {/* 本文の上余白はシート側が持つ。children の形は画面ごとに不揃いで、
        ErrorRetry は className を受け取らないため。flex にするのは、裸の
        ブロックだと先頭の子との親子マージン相殺でラッパーの mt-section が
        children 依存になるため（不変条件は JSDoc 参照） */}
    ```

    あるいは、W-001 の修正で JSDoc に相殺の話が正確に入るなら、インラインは「本文の上余白はシート側が持つ。`ErrorRetry` は `className` を受け取らないため利用側には配れない」の 2 行に削ってメカニズムの説明を JSDoc に一本化するほうが、同じ話を 1 ファイル 2 箇所で保守しなくて済む（CLAUDE.md の「Default to no comments」の趣旨にも近い）。

- **[W-003]** PR 本文の Summary が実装と食い違っており、しかもそれは R1 で**撤回した**書き方を指している
  - 場所: PR #32 本文 Summary の 4 番目の bullet
  - 理由: 現在の PR 本文はこう書いている。

    > `AppShell`: サイドバーのブランド下は `<nav>` の `mt-2xl` へ、ナビシートのハンドル下は**先頭項目の `mt-md`** へ移した（`mx-auto` は維持）

    実装は `.map()` 全体を `<div className="mt-md">` で包む形で（`AppShell/index.tsx:196`）、先頭項目には何も付いていない。「先頭項目に `mt-md`」は R1 の W-002（台帳キー `AppShell/index.tsx:ナビシート先頭項目/余白のアンカー`、**fix** 判定）で明示的に否定され、`262e93d` で撤回された案そのもの。`5f2e172` で `adr.md` / `plan.md` は実装に追随したが、PR 本文だけが 1 コミット目のまま取り残されている。

    R2 の W-003（`.issue/30/adr.md・plan.md` の食い違い）とはファイルが異なるので同一キーではない。実害の出方も違って、PR 本文は (1) マージ時のレビュアーが最初に読む要約であり、(2) squash merge ならコミットメッセージとして履歴に永久に残る。`git log` から「なぜこの形なのか」を辿った人が、レビューで却下されたほうの設計を正解として読むことになる。
  - 提案: PR 本文を実装に合わせる。例:「ナビシートのハンドル下は `.map()` を包むラッパーの `mt-md` へ移した（設計の `.nav-sheet .handle + *` と同じアンカー。`mx-auto` は維持）」。あわせて Test plan の「区切り線が先頭項目に付いていないこと」はそのままでよい（実装と一致している）。

---

## Notes

- **[N-001]** 6 箇所すべてについて、設計 CSS が指定する値と実装の解決値が一致することを、レイアウトのコンテキストまで追って確認した。**すべて一致。**

  | # | 区間 | 設計 CSS | 実装 | コンテキストと相殺の扱い | 判定 |
  |---|---|---|---|---|---|
  | 1 | `AuthSheet` ブランド → h1 | `.page-title { margin-top: var(--space-section) }`（`login.html:138-144`） | `h1.mt-section`（`:28`） | カード div はブロックだが `py-2xl` があるので親子相殺は発火せず。ブランド div とは隣接兄弟で `max(0, 36) = 36` | 36px ✓ |
  | 2 | h1 → 説明文 | `.page-description { margin-top: var(--space-lg) }`（`password-reset.html:144-150`） | `p.mt-lg`（`:32`） | 同上 | 24px ✓ |
  | 3 | 見出し/説明文 → 本文 | `.auth-form { margin-top: var(--space-section) }`（`login.html:147-152` / `password-reset.html:153-158`） | ラッパー `div.mt-section.flex.flex-col`（`:39`） | 隣接兄弟。ラッパー先頭の子はいずれも `margin-top: 0`（Preflight） | 36px ✓ |
  | 4 | `CurrentUserPanel` h2 → 先頭行 | `.section-head + * { margin-top: 12px }`（`settings.html:329-331`） | `div.${ROW}.mt-sm`（`:33`） | `<section>`（ブロック）内の隣接兄弟 | 8px（設計 12px との差は台帳で defer 済み。**向き**は設計と同型） |
  | 5 | `SettingsSkeleton` ラベル → 先頭行 | #4 と対 | `div.${ROW}.mt-sm`（`:18`） | `Skeleton` は `<span class="block">`（`ui/Skeleton/index.tsx:15-18`）でブロック。`sr-only` の span は `position: absolute` なのでフローに影響しない | 8px ✓（#4 と同型） |
  | 6a | `AppShell` ブランド → サイドナビ | `.brand { padding: 0 var(--space-md) var(--space-2xl) }`（`timeline.html:140-148`） | `nav.mt-2xl`（`:92`）＋ `BrandLink` は `px-md` のみ | `<aside>` は `lg:flex` + `flex-col` なので両者は flex アイテム（相殺なし） | 40px ✓（当たり判定も変更前と同一。ADR-002 の狙いどおり） |
  | 6b | `AppShell` ハンドル → 先頭項目 | `.nav-sheet .handle + * { margin-top: 14px }`（`timeline.html:879-881`） | ラッパー `div.mt-md`（`:196`） | `<nav>` は `pt-md` を持つので親子相殺は最初からブロック済み。ハンドル（縦マージンなし）とは隣接兄弟 | 14px ✓ |

  Tailwind クラス合成の衝突も再確認した。`ROW`（`flex items-center justify-between gap-md py-row`）・`BAR`・`NAV_ITEM`・`SIDE_LINK`・`LINK_FOCUS` のいずれも `m*` 系ユーティリティを含まないので、`${定数} mt-sm` の合成でマージンのプロパティ衝突は起きない。

- **[N-002]** 変更後の DOM で、幅・フォーカス・支援技術への影響がないことを確認した。

  | 対象 | 判定 | 根拠 |
  |---|---|---|
  | `AuthSheet` の 5 利用箇所の幅 | ✓ | ラッパーは `flex flex-col`（`align-items: stretch` 既定）。`<form>` / `<div>` / `<p>` / `ErrorRetry` のルート（`ErrorRetry/index.tsx:23-25`）はすべて `width: auto` なので親幅 100%。`ErrorRetry fullWidth` は `Button` に `w-full` を渡すだけ（`:26-32`）なので、plan.md がリスクに挙げていた縮みは構造上起きない |
  | `LoginForm` / `SignupForm` の 2 子構成 | ✓ | ラッパーに `gap` を付けていないので、`.form-links` の `mt-section` がそのまま 36px として効く。`LoginForm:110-112` のコメントが警戒する「`gap-lg` との二重取り」も発生しない |
  | ナビシートのフォーカス移動 | ✓ | `sheetRef.current?.querySelector("a")`（`:72`）は子孫セレクタなので `<div>` を 1 段挟んでも先頭 `<a>` を拾う。ハンドルは `<div aria-hidden>` で `<a>` ではない |
  | ナビシートの区切り線 | ✓ | `index === 0 ? "" : "border-t border-neutral-100"`（`:205`）が余白の分岐から独立した形に戻っており、設計の `.nav-item + .nav-item`（`timeline.html:898-900`）と 1:1 |
  | `inert` / Escape / `aria-*` | ✓ | `:82` / `:57-66` / `:132-134` はいずれも無改修。Tab 順は DOM 順のままで、ロールを持たない `<div>` の挿入では変わらない |

- **[N-003]** 受け入れ基準の検証結果。**AC-1〜AC-8 はコード上すべて満たしている**（AC-3〜AC-7 の実機計測は `testing.md` に従って別途）。

  | AC | 結果 |
  |---|---|
  | AC-1 | ✓ 0 件（検証の詳細は冒頭。緩いパターン・CSS 側・`scripts/` まで確認） |
  | AC-2 | ✓ `AuthSheet:28` は固定クラスの `mt-section`。三項演算子は消えている |
  | AC-3 | ✓ N-001 #1・#3。`login.html:127-152` と一致 |
  | AC-4 | ✓ N-001 #1〜#3。`password-reset.html:136-158` と一致。`__root.tsx:63-74`（404）と `:85-96`（`ErrorScreen`）は同じ `AuthSheet` を通る |
  | AC-5 | ✓ h2 は余白なし、`mt-sm` は先頭行だけ。2 行目 `${ROW} border-t`（`:39`）に `mt` はなく二重計上なし |
  | AC-6 | ✓ 両者とも「ラベル要素は余白なし + 直後の行に `mt-sm`」で同型 |
  | AC-7 | ✓ N-001 #6a・#6b |
  | AC-8 | ✓ typecheck 4/4 Done、lint exit 0、format:check No fixes applied |

  Issue #30 の完了条件「例外に当たる箇所があれば理由コメント付き」は、**例外 0 件が正しい**ことを再確認した。`tokens.md:140-143` の例外 2 つのうち、`display: none` で開閉する要素はナビシートが該当しそうに見えるが、実装は `navOpen ? … : null` の条件付きアンマウント（`AppShell:182`）で閉じている間は DOM 自体が存在しないため、「閉じても上余白が残る」問題は構造的に起きない。`em` 指定は `apps/web/app` に存在しない。

- **[N-004]** R2 の W-003（記録と実装の食い違い）は `5f2e172` で解消済み。`adr.md:27,35-36` に flex 化の理由と加算のトレードオフが入り、`plan.md:66,79,99,117,120` はナビシートのラッパー化と flex 化に追随している。特に `plan.md:117` は「余白を項目側の条件分岐に戻すと 2 つの関心事が再び混ざるので戻さないこと」と、R1 で得た結論を将来向けの注意として残す形に書き換わっていて、記録として質が上がっている。残る食い違いは PR 本文だけ（W-003）。

- **[N-005]** `AppShell` に追加された 2 つのコメントは、内容を実装で裏取りして**いずれも正確**だった。

  - `:84-86`「`BrandLink` renders an `<a>`, so padding would stretch the hit area down by `--space-2xl`」 — `BrandLink` は `createLink(BrandLinkAnchor)` で、`BrandLinkAnchor` は `<a>` を返す（`ui/BrandLink/index.tsx:13-25`）。`px-md` は設計 `.brand` の左右 padding（`var(--space-md)`）と一致しており、落としたのは `padding-bottom` だけという記述とも整合する
  - `:193-195`「The design's `.nav-sheet .handle + *` gap. The wrapper owns it rather than the first item, so it stays orthogonal to that item's `border-t` branch」 — 設計 `timeline.html:879-881` と一致。「ラッパーが `+ *` のアンカーに 1:1 対応する」という主張も、設計側でハンドルの次に来るのが `.nav-item` 群であることと合っている

  値（40px / 14px）をコメントに直書きせず `--space-2xl` / セレクタ名で書いているのも、R2 W-002 の指摘（腐りやすい記述を残さない）に沿っている。件数の直書きも `AuthSheet` から落ちており、追加された 5 つのコメントに px 値・件数のハードコードは残っていない（`LoginForm:110-112` / `SignupForm:116-118` の px 直書きは本 PR 以前からの既存分で、今回の変更対象外）。

- **[N-006]** コメントの言語は既存の慣習どおりで、**新たな不整合は持ち込んでいない**。

  | 種別 | 言語 | 該当 |
  |---|---|---|
  | JSDoc | 英語 | `AuthSheet:10-20`（追加分含む）/ `SettingsSkeleton:6-12`（追加分含む）/ `Skeleton` / `BrandLink` / `ErrorRetry` |
  | `AppShell` の JSX インライン | 英語 | 既存 `:117-121,159-162` / 追加 `:84-86,193-195` |
  | `LoginForm` / `SignupForm` / `AuthSheet` の JSX インライン | 日本語 | 既存 `LoginForm:110-112` / `SignupForm:116-118` / 追加 `LoginForm:64-65`・`SignupForm:65-66`・`AuthSheet:36-38` |

  ファイル単位でも矛盾はない（`AuthSheet` は JSDoc 英語 / インライン日本語で、リポジトリ全体の多数派と同じ切り分け）。

- **[N-007]** `LoginForm` / `SignupForm` に追加されたコメント「設計の `.auth-form` から margin-top だけ意図的に落としている」は、設計 `login.html:147-152` の 4 宣言（`display` / `flex-direction` / `gap` / `margin-top`）と実装 `<form className="flex flex-col gap-lg">` を突き合わせると**過不足なく正確**。設計 HTML と実装を並べる作業（`testing.md` が指示している作業）で `mt-section` を補いたくなる動機を、その作業をする人が必ず開くファイルで先回りして止めている。置き場所としても適切。

- **[N-008]** 良い点。

  - 三項演算子の削除（`AuthSheet:28`）は単なる `mb`→`mt` の置換ではなく、「下向きだから次に何が来るかを知る必要があった」という因果そのものを解いている。`AuthSheet` は `description` の有無を余白の判断材料にしなくなり、Issue が意図した設計改善がコードに現れている
  - ナビシートは R1 の指摘後に「先頭項目に `mt-md`」を撤回して `.map()` ごとラップし、余白（`.handle + *`）と境界線（`.nav-item + .nav-item`）という直交する 2 つの関心事を設計と同じ分割に戻している。「先頭項目にも線を付けたい」といった将来の変更が単純な追記でできる状態
  - ADR-002 は設計 HTML の `padding-bottom` に機械的に追随せず、「`BrandLink` は `<a>` なので当たり判定が 40px 広がる」という副作用を見つけて `margin-top` を選び、その判断理由をコードとレコードの両方に残している
  - CLAUDE.md のレイヤー規約への違反なし。変更は `apps/web/app/` のプレゼンテーション層に閉じており `packages/core` に一切触れていない。`AuthSheetProps` は不変で、`AuthSheet` の利用側 5 箇所は無改修

- **[N-009]** 本 PR とは無関係の既存乖離（余白の「値」の話でスコープ外、後続 #2〜#9 の材料としてのみ記録）。R2 の N-008 から変化なし。

  | 箇所 | 実装 | 設計 |
  |---|---|---|
  | サイドバーのナビ項目間 | `gap-xs` = 4px | `.side-nav { gap: 2px }`（`timeline.html:150-154`） |
  | サイドリンクのアイコン間 | `gap-sm` = 8px | `.side-link { gap: 10px }`（`timeline.html:155-158`） |
  | ナビシート項目の左右 padding | `px-xs` = 4px | `.nav-item { padding: var(--pad-row) 2px }` |
  | ナビシート項目のアイコン間 | `gap-sm` = 8px | `.nav-item { gap: 10px }`（`timeline.html:882-885`） |
  | `SettingsSkeleton` のラベル高 | `h-skeleton-line` = 16px | 実 DOM の `<h2 class="text-xs">` は約 17.3px（1.3px 差、本 PR 以前から） |

---

## まとめ

| 区分 | 件数 |
|---|---|
| Blockers | 0 |
| Warnings | 3 |
| Notes | 9 |

コードは 6 箇所すべてで設計と同じ向き・同じ値に揃っており、AC-1〜AC-8 はすべて満たしている。3 件の Warning はいずれも**実装ではなく実装を説明する文章**の問題で、W-001（JSDoc の不変条件が実際より広く、リポジトリ自身の `.form-links` がそれに違反して見える）と W-002（JSDoc とインラインコメントが `flex` の理由を逆向きに説明）は同じファイルの数行を書き直すだけで片付く。W-003 は PR 本文の 1 行修正。

R2 で指摘した「相殺の向きの誤り」「件数・px の直書き」「`adr.md` / `plan.md` の食い違い」はいずれも解消を確認した。残っているのは、その修正で入った新しい文面のスコープと目的の記述精度である。
