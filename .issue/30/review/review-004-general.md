# レビュー #004 — PR #32 / Issue #30（縦余白を上向きに統一し `mb-*` を排除）

**PR:** #32
**Date:** 2026-07-26
**Round:** 4回目（フルレビュー・ゼロベース）
**対象:** `origin/main...HEAD` = `a52fba7` + `262e93d` + `5f2e172` + `cab40ae`
**変更ファイル（コード）:** `AuthSheet` / `AppShell` / `CurrentUserPanel` / `SettingsSkeleton` / `LoginForm` / `SignupForm` の 6 tsx

台帳（`.issue/30/review/triage.md`）で決着済みの 13 キーは再提出していない。特に次の 2 件は本レビューでも扱わない。

- `CurrentUserPanel` の 8px vs 設計 `.section-head + *` 12px（**defer** — Phase 5 で別 Issue）
- ADR の Status を `Accepted` に倒す提案（**wont-fix** — `.issue/1/adr.md` の慣習に合わせる）

---

## 検証の前提と方法

ゼロベースで組み直した。今回の主眼は収束判定なので、次の 4 点を実ファイルに突き合わせて 1 つずつ潰した。

1. `AuthSheet` の JSDoc が述べる不変条件が、CSS の親子マージン相殺の実挙動と正確に一致するか（相殺のペアは「親と先頭 in-flow 子」だけ、という点）
2. JSDoc / JSX インラインコメント / `LoginForm`・`SignupForm` のコメントの三者に矛盾が残っていないか
3. `.issue/30/adr.md` / `plan.md` / `testing.md` / PR 本文が現在の実装と一致するか
4. 余白の値と向きが設計 HTML と一致するか、`apps/web/app` に `mb-*` / `my-*` が残っていないか

静的チェックは実行して確認済み。

- `pnpm typecheck` — 4 パッケージすべて Done
- `pnpm lint` — **exit 0**（22 infos はすべて `biome migrate` 系の既存分、本 PR 由来なし）
- `pnpm format:check` — Checked 224 files, No fixes applied
- `grep -rE '\b(mb|my)-' apps/web/app` — **0 件**。`\b` を外した緩い `(mb|my)-`（`-mb-` / `mb-[…]` も拾う）でも 0 件。`margin-bottom` / `marginBottom` / `margin-block-end` / `space-y-*` を `apps/web/app` + `apps/web/scripts` に対して検索しても 0 件

---

## Blockers

**なし。**

---

## Warnings

**なし。**

**問題点ゼロ。** 実装・コメント・記録（ADR / plan / testing / PR 本文）のいずれにも、今回新たに指摘すべき点は見つからなかった。R1〜R3 の 13 キーはすべて `fix` / `defer` / `wont-fix` の判定どおりに着地しており、修正の副作用として持ち込まれた新しい不整合もない。以下は検証の記録。

---

## Notes

- **[N-001]** **重点確認 (1): `AuthSheet` の JSDoc は CSS の実挙動と一致している。**

  現在の文面（`apps/web/app/components/ui/AuthSheet/index.tsx:16-20`）:

  ```
   * The body's top margin belongs to the sheet (`.auth-form { margin-top }` in
   * the design): the *first* child must not declare one of its own — the
   * wrapper is a flex column, so its `margin-top` would add to the sheet's
   * `--space-section` instead of collapsing into it. Margins between the
   * children themselves are theirs to own (`.form-links` in the design).
  ```

  | 主張 | 検証 | 判定 |
  |---|---|---|
  | 制約の対象は「**先頭の**子」 | 親子マージン相殺の候補は「親の `margin-top` と先頭 in-flow 子の `margin-top`」のペアのみ。2 番目以降の子の `margin-top` は元からラッパーの余白と融合しない | ✓ R3 W-001 の指摘どおりスコープが閉じた |
  | flex column なので子の `margin-top` は「加算」される | flex コンテナと flex アイテムの間でマージン相殺は起きない（相殺はブロックフォーマッティングコンテキスト内の現象）。`36px + 子の値` になる | ✓ |
  | ブロックなら「collapsing into it」だった | ラッパーは border / padding を持たず BFC も作らないので、ブロックなら親子相殺が発火し `max(--space-section, 子の値)` が親の外側に出る＝和にならない | ✓ 反実仮想として正確 |
  | 「Margins between the children themselves are theirs to own（`.form-links`）」 | `LoginForm:113` / `SignupForm:119` の `.form-links` 相当 `<div className="mt-section …">` は 2 番目の子で、設計 `login.html:299-305` の `.form-links { margin-top: var(--space-section) }` と 1:1。JSDoc の免除範囲に正しく入る | ✓ リポジトリ自身の実装が不変条件に違反して見える問題は解消 |

  実利用 5 箇所の先頭子はすべて `margin-top: 0`（`<form className="flex flex-col gap-lg">` ×2 / `<div className="text-center text-sm">` / `<p className="text-center text-sm">` / `ErrorRetry` の `<div className="flex gap-lg flex-col">`）で、不変条件は現時点で全箇所守られている。

- **[N-002]** **重点確認 (2): JSDoc とインラインコメントの矛盾は解消している。**

  R3 W-002 は「JSDoc は加算を失敗モードとして禁止し、インラインは和になることを目的として説明している」という正面衝突だった。現在のインラインコメント（`:37-38`）は

  ```
  {/* 本文の上余白はシート側が持つ。ErrorRetry は className を
      受け取らないため利用側には配れない */}
  ```

  で、**メカニズム（相殺 / 加算）の説明を一切持たず、ラッパーが存在する理由だけ**を述べている。R3 W-002 の「インラインは 2 行に削ってメカニズムを JSDoc に一本化」案どおりの着地で、同じ話を 1 ファイル 2 箇所で保守する状態も解消した。ADR-001 の Context（`ErrorRetry` が `className` を受け取らない）とも一致する。

  `LoginForm:64-65` / `SignupForm:65-66` の「設計の `.auth-form` から margin-top だけ意図的に落としている。本文の上余白は AuthSheet 側のラッパーが持つ」も、JSDoc の「The body's top margin belongs to the sheet」と同じことを利用側から述べているだけで矛盾しない。設計 `.auth-form` の 4 宣言（`display` / `flex-direction` / `gap` / `margin-top`）と実装 `flex flex-col gap-lg` の差分の記述としても過不足がない。

  なお `AppShell:84-86`（`BrandLink` の hit area）/ `:193-195`（`.handle + *` のアンカー）も内容を実装で裏取りして正確。追加された 5 つのコメントに px 値・件数のハードコードは残っていない。

- **[N-003]** **重点確認 (3): 記録と実装の一致。**

  | 記録 | 実装 | 判定 |
  |---|---|---|
  | `adr.md:27` — ラッパーは `<div className="mt-section flex flex-col">`、裸のブロックだと `max(--space-section, 子の値)` になり和にならない | `AuthSheet:39` | ✓（相殺の向きの説明も正確） |
  | `adr.md:35` — 「**children 先頭は**上余白を持たない」という約束を JSDoc に明記、`LoginForm` / `SignupForm` にもコメント | JSDoc `:16-20` / `LoginForm:64-65` / `SignupForm:65-66` | ✓ `cab40ae` でスコープが「先頭」に閉じ、`plan.md:120` と表現も揃った |
  | `plan.md:99,117` — `.map()` 全体を `<div className="mt-md">` で包む／項目側の条件分岐には戻さない | `AppShell:196` | ✓ |
  | `plan.md:98` — `BrandLink` の `mb-2xl` を削除し `<nav>` に `mt-2xl` | `AppShell:87,92` | ✓ |
  | PR 本文 Summary 4 番目 — 「ナビシートのハンドル下は `.map()` を包むラッパーの `mt-md` へ移した（設計の `.nav-sheet .handle + *` と同じアンカー。`mx-auto` は維持）」 | 同上 | ✓ R3 W-003 は解消 |
  | PR 本文 Test plan — 36/36、36/24/36、40px、14px、8px、`grep` 0 件 | N-004 の実測どおり | ✓ |
  | `testing.md` — 確認項目 1〜6 + エッジケース 2 件 | 「フォームは `AuthSheet` が挿入したラッパー `div` の `margin-top` で押し下げられる」「ラッパー `div` を挟んだことでボタンが内容幅に縮んでいないか」など、ラッパー化後の実装を前提に書かれている | ✓ 撤回済みの「先頭項目の `mt-md`」への言及も残っていない |

  `adr.md:48` の `<BrandLink className="mb-2xl px-md …">` は Context 節の「変更前の状態」の記述なので、実装と食い違っているわけではない。

- **[N-004]** **重点確認 (4): 余白の値と向きは 6 箇所すべて設計と一致している。**

  トークン実値（`apps/web/app/styles/tokens.css` / `theme.css` の `@theme`）: `--space-section` 2.25rem=36px / `--space-2xl` 2.5rem=40px / `--space-lg` 1.5rem=24px / `--space-md` 0.875rem=14px / `--space-sm` 0.5rem=8px。

  | # | 区間 | 設計 CSS | 実装 | コンテキスト | 判定 |
  |---|---|---|---|---|---|
  | 1 | `AuthSheet` ブランド → h1 | `.page-title { margin-top: var(--space-section) }`（`login.html:138-144`） | `h1.mt-section`（`:29`） | カード div はブロックだが `py-2xl` があり親子相殺は不発火。ブランド div とは隣接兄弟で `max(0,36)` | 36px ✓ |
  | 2 | h1 → 説明文 | `.page-description { margin-top: var(--space-lg) }`（`password-reset.html:144-150`） | `p.mt-lg`（`:33`） | 同上 | 24px ✓ |
  | 3 | 見出し/説明文 → 本文 | `.auth-form { margin-top: var(--space-section) }`（`login.html:147-152`） | ラッパー `div.mt-section.flex.flex-col`（`:39`） | 隣接兄弟。先頭子はすべて `margin-top: 0` | 36px ✓ |
  | 4 | `CurrentUserPanel` h2 → 先頭行 | `.section-head + *`（`settings.html:329-331`） | `div.${ROW}.mt-sm`（`:33`） | `<section>` 内の隣接兄弟 | 向き ✓（値 8px vs 12px は台帳で defer 済み） |
  | 5 | `SettingsSkeleton` ラベル → 先頭行 | #4 と対 | `div.${ROW}.mt-sm`（`:18`） | `Skeleton` は `<span class="block">`。`sr-only` の span は `position: absolute` でフロー外 | 8px ✓（#4 と同型） |
  | 6a | `AppShell` ブランド → サイドナビ | `.brand { padding: 0 var(--space-md) var(--space-2xl) }`（`timeline.html:140-148`） | `nav.mt-2xl`（`:92`）+ `BrandLink` は `px-md` のみ | `<aside>` は `lg:flex` + `flex-col` で両者は flex アイテム | 40px ✓（当たり判定も不変） |
  | 6b | `AppShell` ハンドル → 先頭項目 | `.nav-sheet .handle + * { margin-top: 14px }`（`timeline.html:879-881`） | ラッパー `div.mt-md`（`:196`） | `<nav>` の `pt-md` で親子相殺はブロック済み。ハンドルとは隣接兄弟 | 14px ✓ |

  Tailwind クラス合成の衝突も再確認。`ROW` / `BAR` / `NAV_ITEM` / `SIDE_LINK` / `LINK_FOCUS` のいずれも `m*` 系ユーティリティを含まないので、`${定数} mt-sm` などの合成でマージンのプロパティ衝突は起きない。

  カード / セクションの下端は、反転で最終子の下マージンが消えたぶん `py-2xl` / `pb-lg` / `pb-safe-b-2xl` がそのまま効く形になり、`tokens.md` の「最後の子の下余白はコンテナの `padding-bottom` に足される」という失敗が構造的に消えている。

- **[N-005]** 受け入れ基準の検証結果。**AC-1〜AC-8 はコード上すべて満たしている**（AC-3〜AC-7 の実機計測は `testing.md` に従って別途）。

  | AC | 結果 |
  |---|---|
  | AC-1 | ✓ 0 件（緩いパターン・CSS 側・`scripts/` まで確認。詳細は冒頭） |
  | AC-2 | ✓ `AuthSheet:29` は固定クラスの `mt-section`。三項演算子は消えている |
  | AC-3 | ✓ N-004 #1・#3。`login.html` / `signup.html` と一致 |
  | AC-4 | ✓ N-004 #1〜#3。`password-reset.html` と一致。`__root.tsx:65-74`（404）・`:86-96`（`ErrorScreen`）は同じ `AuthSheet` を通る |
  | AC-5 | ✓ h2 は余白なし、`mt-sm` は先頭行だけ。2 行目 `${ROW} border-t`（`:39`）に `mt` はなく二重計上なし |
  | AC-6 | ✓ 両者とも「ラベル要素は余白なし + 直後の行に `mt-sm`」で同型。JSDoc にも対で維持する不変条件が入っている |
  | AC-7 | ✓ N-004 #6a・#6b |
  | AC-8 | ✓ typecheck 4/4 Done、lint exit 0、format:check No fixes applied |

  Issue #30 の完了条件「例外に当たる箇所があれば理由コメント付き」は **例外 0 件が正しい**。`tokens.md` の例外 2 つのうち `display: none` 系はナビシートが該当しそうに見えるが、実装は `navOpen ? … : null` の条件付きアンマウント（`AppShell:182`）で閉じている間は DOM 自体が存在せず、「閉じても上余白が残る」問題は起きない。`em` 指定は `apps/web/app` に存在しない。

- **[N-006]** 幅・フォーカス・支援技術への影響がないことを再確認した。

  | 対象 | 判定 | 根拠 |
  |---|---|---|
  | `AuthSheet` 5 利用箇所の幅 | ✓ | ラッパーは `flex flex-col`（`align-items: stretch` 既定）。children ルートはすべて `width: auto` なので親幅 100%。`ErrorRetry fullWidth` は `Button` に `w-full` を渡すだけ（`ErrorRetry/index.tsx:21-33`）なので縮みは構造上起きない |
  | `LoginForm` / `SignupForm` の 2 子構成 | ✓ | ラッパーに `gap` を付けていないので `.form-links` の `mt-section` がそのまま 36px。`LoginForm:110-112` のコメントが警戒する `gap-lg` との二重取りも起きない |
  | ナビシートのフォーカス移動 | ✓ | `sheetRef.current?.querySelector("a")`（`:72`）は子孫セレクタなので `<div>` を 1 段挟んでも先頭 `<a>` を拾う。ハンドルは `<div aria-hidden>` |
  | ナビシートの区切り線 | ✓ | `index === 0 ? "" : "border-t border-neutral-100"`（`:205`）が余白の分岐から独立し、設計の `.nav-item + .nav-item`（`timeline.html:896-898`）と 1:1 |
  | `inert` / Escape / `aria-*` | ✓ | `:82` / `:57-66` / `:132-134` は無改修。Tab 順は DOM 順のままで、ロールを持たない `<div>` の挿入では変わらない |

- **[N-007]** JSDoc `:17-18` の「the wrapper is a flex column, so **its** `margin-top` would add …」の `its` は、直前の名詞（the wrapper）ではなく「the *first* child」を指す。文法的には最近接の名詞に引かれる余地があるが、直前の主節「the *first* child must not declare one of its own」で対象が一意に定まっているため、読み違えても不変条件の理解は変わらない。実害はないので指摘には数えない（次に触るときに `a child's margin-top` のように明示できれば理想、程度）。

- **[N-008]** 良い点。

  - 三項演算子の削除（`AuthSheet:29`）は単なる `mb`→`mt` の置換ではなく、「下向きだから次に何が来るかを知る必要があった」という因果そのものを解いている。`AuthSheet` は `description` の有無を余白の判断材料にしなくなり、Issue が意図した設計改善がコードに現れている
  - ナビシートは R1 の指摘後に「先頭項目に `mt-md`」を撤回して `.map()` ごとラップし、余白（`.handle + *`）と境界線（`.nav-item + .nav-item`）という直交する 2 つの関心事を設計と同じ分割に戻している
  - ADR-002 は設計 HTML の `padding-bottom` に機械的に追随せず、「`BrandLink` は `<a>` なので当たり判定が 40px 広がる」という副作用を見つけて `margin-top` を選び、その理由をコード（`AppShell:84-86`）と ADR の両方に残している
  - 4 ラウンドを通じて、コメントは「増やす」方向だけでなく `AuthSheet` のインラインのように**削って一本化する**方向にも動いており、CLAUDE.md の「Default to no comments / WHY が非自明なときだけ」に沿った収束の仕方になっている
  - CLAUDE.md のレイヤー規約への違反なし。変更は `apps/web/app/` のプレゼンテーション層に閉じており `packages/core` に一切触れていない。`AuthSheetProps` は不変で、`AuthSheet` の利用側 5 箇所は無改修

- **[N-009]** 本 PR とは無関係の既存乖離（余白の「値」の話でスコープ外、後続 #2〜#9 の材料としてのみ記録）。R3 の N-009 から変化なし。

  | 箇所 | 実装 | 設計 |
  |---|---|---|
  | サイドバーのナビ項目間 | `gap-xs` = 4px | `.side-nav { gap: 2px }` |
  | サイドリンクのアイコン間 | `gap-sm` = 8px | `.side-link { gap: 10px }` |
  | ナビシート項目の左右 padding | `px-xs` = 4px | `.nav-item { padding: var(--pad-row) 2px }` |
  | ナビシート項目のアイコン間 | `gap-sm` = 8px | `.nav-item { gap: 10px }` |
  | `SettingsSkeleton` のラベル高 | `h-skeleton-line` = 16px | 実 DOM の `<h2 class="text-xs">` は約 17.3px（1.3px 差、本 PR 以前から） |

---

## まとめ

| 区分 | 件数 |
|---|---|
| Blockers | 0 |
| Warnings | 0 |
| Notes | 9 |

**問題点ゼロ。収束したと判断する。**

R3 で残っていた 3 件（JSDoc の不変条件スコープ / JSDoc とインラインの逆向き / PR 本文の食い違い）はいずれも解消を確認した。実装は 6 箇所すべてで設計と同じ向き・同じ値に揃い、AC-1〜AC-8 を満たし、コメントと記録（ADR / plan / testing / PR 本文）も現在の実装と一致している。残る差分は台帳で `defer` 済みの「設定の見出し下 8px vs 設計 12px」と、`mb-*` とは無関係な既存の値の乖離（N-009）だけで、どちらも本 PR のスコープ外。
