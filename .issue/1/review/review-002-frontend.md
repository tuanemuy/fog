# レビュー 002 — Frontend

- 対象: PR #17（`issue/1/skeleton-auth`）/ Issue #1
- 範囲: `apps/web/app/{routes,components,presentation,styles}`
- 参照: CLAUDE.md「Frontend」節 / `.issue/1/plan.md`（AC-9〜AC-14 / AC-18）/ `.issue/1/adr.md`（ADR-005 / 007 / 016 / 017 / 028）/ `spec/pages/index.md`（共通レイアウト・P-01 / 02 / 03 / 04 / 13）/ `spec/inventory/frontend.md` / `spec/design/{index,tokens}.md` / `spec/design/pages/{login,signup,password-reset,timeline,settings}.html`
- 前ラウンド: `review-001-frontend.md`（B-001 / B-002 / W-001〜W-012）・`triage.md`（フロント該当分はすべて `fix` 判定）
- 検証手段: (a) `tailwindcss@4.3.3` の `compile()` にアプリ全体の候補を食わせた実 CSS の確認、(b) `pnpm dev` + agent-browser による実ブラウザ操作（ログイン / 登録 / ログアウト / ナビ / 戻るボタン / スクロール / axe 監査）、(c) `@tanstack/router-core@1.171.15` と `@tanstack/react-router@1.170.18` のソース読解、(d) `pnpm typecheck` / `pnpm build`（いずれも成功）

---

## 前ラウンド指摘の解消状況

| R1 ID | 内容 | 判定 | 根拠 |
|---|---|---|---|
| B-001 | フォーカスリングが描画されない | **解消** | `focus:outline-none` を削除。生成 CSS で `--tw-outline-style` の `@property` 初期値が `solid` のまま残ることを確認。実ブラウザで `input:focus-visible` の算出値が `outline: 2px solid oklch(0.63 0.13 292)` / `outline-offset: 2px`（= `--color-focus`）。`aria-[invalid=true]:border-error`（詳細度 0-2-0）が `focus:border-primary` より後に出力され、エラー時のフォーカスでも赤枠が勝つ |
| B-002 | 送信失敗で入力が消える | **解消** | `FormState = { error, email }` → `defaultValue`。react-dom は `recursivelyResetForms` を HostRoot の変異フェーズ**末尾**（入力 props 適用後）で走らせるので `form.reset()` は新しい `defaultValue` に着地する。実測: 誤パスワードで `email` 保持 / `password` 空、重複メールで `email` 保持 |
| W-001 | `/settings` がストリーミングでない | **解消** | `renderSettings()` が `renderServerComponent(...)` を **await せず**返し、ローダーが転送、`<Suspense fallback={<SettingsSkeleton/>}><Deferred/></Suspense>` で受ける。テンプレ基準形 `routes/todo/index.tsx` と同型。`Deferred` の参照ゼロも解消 |
| W-002 | `RoutePendingFallback` の生値 | **解消** | `--skeleton-line-h` / `--skeleton-title-h` / `--skeleton-line-w-short` を役割名で追加（ADR-028）。`apps/web/app` 全体を生値スキャンして残存ゼロ（AC-18 充足） |
| W-003 | transport 検証エラーが英語 | **解消** | `schema.ts` に日本語 `message`、`errorDisplay.ts` に `FIELD_LABELS`。実測で空送信 → 「メールアドレスを入力してください」「パスワードを入力してください」 |
| W-004 | 項目エラーの通知とフォーカス | **概ね解消** | エラー段落に `aria-live="polite"`、送信失敗時に該当フィールドへ `focus()`。実測で `document.activeElement` が `#signup-email` / `#signup-password` に移動。ただしフォーム全体エラーは対象外（→ W-007） |
| W-005 | ナビシートのフォーカス管理 | **解消** | 実測で (a) 開くと先頭リンクへフォーカス、(b) Escape でメニューボタンへ復帰、(c) 背面 `<div inert>` を確認 |
| W-006 | スクロールモデル | **解消（ただし副作用）** | `h-dvh` + `main flex-1 overflow-y-auto` で基準形と一致。ただしスクロール復元の手当てが無く新規不具合（→ B-002） |
| W-007 | `readAuthStateFn` の重複 | **解消** | `presentation/authState.ts` に 1 本化。3 ルートから import |
| W-008 | リンクのクラス重複 | **解消（ただし副作用）** | `components/ui/TextLink`（`createLink`）に集約。ただしアクティブ時にスタイルが飛ぶ（→ W-002） |
| W-009 | 認証後ルートの `head` | **解消（ただし不完全）** | 5 ルートに `head` を追加、`navItems.ts` の `navTitle()` でラベル二重管理を回避。ただし `links` を返さないため canonical が全ページ `/` のまま（→ W-004） |
| W-010 | エラー・404 画面 | **解消** | `AuthSheet` に載った日本語画面 + `router.invalidate()` の「再読み込み」+ `/` 導線。404 は HTTP 404 を返すことも確認 |
| W-011 | safe-area | **形式上のみ解消** | `--nav-sheet-pad-b` を追加したが `env()` が発火する条件が無い（→ W-005） |
| W-012 | 送信中の `disabled` | **解消** | 入力欄の `disabled` を撤去、無効化はボタンのみ |

**未解消: 0 / 14。** ただし W-006 / W-008 / W-009 / W-011 の修正が新たな問題を生んでいる（下記 B-002 / W-002 / W-004 / W-005）。

---

## Frontend

### Blockers

- **[B-001]** ログアウト後に戻るボタンで保護画面が復元される（`_app` 配下の**文書レスポンス**に `Cache-Control` が付かない）
  - 場所: `apps/web/app/presentation/currentUser.ts:43`（`no-store` を付ける唯一の箇所）、`apps/web/app/presentation/authState.ts:16-21`、`apps/web/app/routes/_app.tsx:9`
  - 理由: R1 の「認証済みレスポンスの `Cache-Control`」は `requireUserId()` の中でだけ `setResponseHeader("cache-control", "no-store, private")` を呼ぶ形で入った。`requireUserId()` を呼ぶのは `CurrentUserPanel`（`/settings`）と `logoutFn` だけなので、実測したヘッダは次のとおり:

    ```
    /          → (Cache-Control なし)
    /topics    → (Cache-Control なし)
    /search    → (Cache-Control なし)
    /trash     → (Cache-Control なし)
    /settings  → cache-control: no-store, private
    ```

    `_app.tsx` の `beforeLoad` は `readAuthStateFn()` を通るが、こちらはヘッダを付けない。結果として **manual TC-23 が実際に落ちる**。以下は再現手順と実測値（dev / Chromium）:

    1. `/login` からログイン → `/` を**フルロード**で開く → `/settings` をフルロードで開く
    2. 「ログアウト」→ `/login`（`replace: true`）へ遷移。Cookie は消えている（`document.cookie` 空、`/` を再読み込みすると `/login` へ 307）
    3. 戻るボタン → **`/` が復元され、`document.title === "タイムライン"`、ナビ付きの保護シェルが描画されたまま留まる**
    4. `performance.getEntriesByType("navigation")[0].type === "back_forward"` かつ、遷移前に仕込んだ `window.__mark` は消えている → bfcache のヒープ復元ではなく、**`Cache-Control` が無いために HTTP の back/forward cache から SSR 済み HTML が再利用**されている。ハイドレーション時は SSR の dehydrated match を信用するので `_app` の `beforeLoad` も走らない

    現状の `/` は中身が空なので情報漏えいは無いが、タイムラインスライスが入った瞬間に「ログアウト後の他人の端末でメモ本文が戻ってくる」になる。`staleTime: 0` と `router.invalidate()` はルーターのメモリキャッシュしか制御しないので、ブラウザキャッシュ側の手当てが要る
  - 提案: 認証済みの文書レスポンス全体に `no-store, private` を付ける。最小の変更は `readAuthStateFn` の handler で認証済みのときに `setResponseHeader("cache-control", "no-store, private")` を呼ぶこと（SSR 中はサーバ関数がインプロセスで走るので文書レスポンスに乗る。`requireUserId()` と同じ仕組み）。「保護画面の応答は必ずこの1点を通る」という不変条件を JSDoc に書き、`testing.md` の TC-23 に上記4手順（フルロードで履歴エントリを作る）を明記すること — SPA 内遷移だけで試すと再現しない

- **[B-002]** `main` をスクロールコンテナにしたことで、ナビゲーション後にスクロール位置が先頭へ戻らず前ページの位置を持ち越す
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:164`、`apps/web/app/router.tsx:8`
  - 理由: R1 W-006 の修正で `overflow-y-auto` を `<main>` に入れたが、`scrollRestoration` 側の手当てが入っていない（R1 の提案文で「`overflow-y-auto` を入れる場合は `scrollRestoration` の挙動も併せて確認する」と明記されていた箇所）。`@tanstack/router-core@1.171.15` の `setupScrollRestoration` を読むと:

    - キャプチャフェーズの `scroll` リスナで任意の要素を追跡し、`data-scroll-restoration-id` が無ければ `nth-child` の構造セレクタで保存する → **戻る/進むの復元は動く**
    - 一方で新規遷移時のトップ復帰は `if (!windowRestored) scrollTo({top:0})` と `scrollToTopSelectors` の列挙しかなく、`router.options.scrollToTopSelectors` は**既定値を持たない**（`router.tsx` でも未設定）。さらに `scroll.restoring && fromCacheKey !== cacheKey` の分岐が **遷移元のスクロール位置を遷移先のキャッシュエントリへコピー**する

    実測（`/` の `main` を高さ 3000px にして `scrollTop = 800` → サイドバーの「設定」をクリック）:

    ```
    { path: "/settings", mainScrollTop: 800 }   ← 先頭に戻らない
    ```

    戻るボタンでの復元（`/settings` → `/` で 800 に復帰）は正しく動くので、壊れているのは「新しい画面を開いたら先頭から」だけ。本スライスは全画面が1画面に収まるため露見しないが、無限スクロールのタイムライン（次スライス）で確実に踏む。シェルは全認証後画面が乗る土台なので、ここで直すのがいちばん安い
  - 提案: `<main data-scroll-restoration-id="app-sheet">` を付け、`router.tsx` に `scrollToTopSelectors: ['[data-scroll-restoration-id="app-sheet"]']` を追加する（構造セレクタ依存もこれで外れる）。修正後は上記の再現手順（遷移前に `main` をスクロール → 別ルートへ遷移 → `main.scrollTop === 0`／戻ると復元）をそのまま検証項目にできる

### Warnings

- **[W-001]** 認証前の全画面に `main` ランドマークが無く、axe が違反 2 件を出す
  - 場所: `apps/web/app/components/ui/AuthSheet/index.tsx:17-36`
  - 理由: `AuthSheet` は `<div>` 2枚だけで、`<main>` も `role="main"` も持たない。実測（axe-core 4.12.1、`/signup`）:

    ```
    [moderate] landmark-one-main : Document should have one main landmark (1 node)
    [moderate] region            : All page content should be contained by landmarks (5 nodes)
    ```

    `/login` `/signup` `/password-reset` に加え、`__root.tsx` の `errorComponent` / `notFoundComponent` も `AuthSheet` に載っているので、**未ログイン時に到達しうる全画面**が該当する（`_app` 側は `AppShell` が `<main>` を持つので違反ゼロ）。スクリーンリーダーの「メインコンテンツへ飛ぶ」操作が効かない
  - 提案: `AuthSheet` の外側 `<div>` を `<main>` にする（内側のシートは `<div>` のまま）。1行で `landmark-one-main` と `region` の両方が消える

- **[W-002]** `TextLink` はアクティブになった瞬間にスタイルとフォーカスリングを全部失う
  - 場所: `apps/web/app/components/ui/TextLink/index.tsx:11-13`
  - 理由: `TextLinkAnchor` は `className={TEXT_LINK}` を書いた**後ろ**で `{...props}` を展開している。`createLink` が渡す props には、リンクがアクティブなとき `className` が含まれる:

    ```js
    // @tanstack/react-router/dist/esm/link.js:243-249, 374
    const resolvedActiveProps = isActive ? functionalUpdate(activeProps, {}) ?? STATIC_ACTIVE_OBJECT : STATIC_EMPTY_OBJECT;
    const resolvedClassName = [className, resolvedActiveProps.className, resolvedInactiveProps.className].filter(Boolean).join(" ");
    ...
    var STATIC_ACTIVE_OBJECT = { className: "active" };
    ```

    呼び出し側は `className` を渡していないので、アクティブ時の `resolvedClassName` は `"active"` 単独になり、`TEXT_LINK`（色・ホバー・`focus-visible:outline-*`）を**丸ごと上書き**する。結果、アクティブな `TextLink` は既定の青リンク色・フォーカスリング無しで描画される。今日は `__root.tsx` の `ErrorScreen` が `/` で踏まれたときだけ露見する潜在バグだが、R1 W-008 で「クラス列の事故が散るのを防ぐ」ために作ったプリミティブ自身が同種の事故を1箇所に固定化しているのは筋が悪い。`spec/design/index.md`「すべてのインタラクティブ要素がフォーカスリングを持つ」に反する
  - 提案: `function TextLinkAnchor({ ref, className, ...props })` として `className={`${TEXT_LINK} ${className ?? ""}`}` にマージする（`AppShell` の `Link` は自前で `className` を渡しているのでこの問題を持たない — その差分を潰す形になる）

- **[W-003]** サイドバーのブランドリンクにも `aria-current="page"` が付き、`/` で「現在地」が2箇所になる
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:90-95`
  - 理由: `<Link to="/">` は `createLink` 系と同じく、アクティブ時に `STATIC_ACTIVE_PROPS = { "data-status": "active", "aria-current": "page" }` を自動で展開する（`link.js:379-381`）。ワードマークは `to="/"` なので、タイムライン表示中は**ナビ項目とブランドの2つ**が現在地として公開される。実測:

    ```
    /          → [{href:"/", txt:"fog"}, {href:"/", txt:"タイムライン"}]
    /settings  → [{href:"/settings", txt:"設定"}]
    ```

    `spec/design/index.md`「どちらも現在地を明示する」が期待するのはナビ側の1点で、ロゴが「現在のページ」と読み上げられるのはノイズ。`AppShell` は 5 項目に対して明示的に `aria-current` を配線しているのに、ブランドだけ暗黙の既定値が漏れている
  - 提案: ブランドの `Link` に `activeProps={{}}`（または `aria-current={undefined}`）を渡して自動付与を止める

- **[W-004]** `head` が `meta` だけを返すため、canonical が全ページ `/` のまま
  - 場所: `apps/web/app/routes/_app/{index,topics,search,trash,settings}.tsx`、`apps/web/app/routes/{login,signup,password-reset}.tsx`（いずれも `buildHead(...).meta` のみ返す）
  - 理由: `__root.tsx:51-52` が `buildHead(config)` の `links`（= `{ rel: "canonical", href: appUrl + "/" }`）をベースに積み、子ルートは `links` を返さないので上書きされない。実測（`/login` と `/settings` の SSR HTML）:

    ```html
    <meta property="og:url" content="http://localhost:3000/settings"/>
    ...
    <link rel="canonical" href="http://localhost:3000/"/>
    ```

    `og:url` はページ別なのに canonical だけホームを指すので、両者が矛盾する。テンプレの基準形 `routes/todo/index.tsx` は `const { meta, links } = buildHead(...); return { meta, links }` と両方返していたので、R1 W-009 の修正でここが落ちた形
  - 提案: 各ルートで `const { meta, links } = buildHead(config, {...}); return { meta, links };` にする。`head` の定型が 8 ルートに逐語コピーされているので、`presentation/head.ts` に `routeHead(match, overrides)` のような 1 関数を足して配線ごと共通化するのが望ましい（`if (!config) return {}` の分岐も含めて 8 箇所同型）

- **[W-005]** safe-area の手当て（R1 W-011 の修正）が発火しない — `viewport-fit=cover` が無い
  - 場所: `apps/web/app/styles/tokens.css:163-166`、`apps/web/app/presentation/head.ts:55`
  - 理由: `--nav-sheet-pad-b: max(--space-2xl, calc(env(safe-area-inset-bottom, 0px) + --space-lg))` を足したが、viewport meta は `width=device-width, initial-scale=1` のままで `viewport-fit=cover` を含まない。WebKit / Blink は `viewport-fit` が `contain`（既定）のとき `env(safe-area-inset-*)` を**すべて 0 に解決**する（レイアウトビューポート自体が safe area に収まっているため）。実測でも算出 `padding-bottom` は `40px` = `--space-2xl` ちょうどで、修正前と同値:

    ```
    { sheetPadB: "40px", sheetInset: "max(14px, 50% - 440px)" }
    ```

    つまり「ホームインジケータ帯に最後の項目が重なる」問題は、`viewport-fit=cover` を入れない限り起きないし、入れた瞬間に**ボトムシート以外も全部**手当てが要る（基準形 `timeline.html` の `header.top { padding: max(20px, env(safe-area-inset-top,0px) + 12px) ... }` に対応する上端の手当ては実装に無い）。`head.ts` は `apple-mobile-web-app-capable: yes` を出していてスタンドアロン起動を想定しているので、放置すると PWA 化した時点で上端がステータスバーに潜る
  - 提案: どちらかに倒す。(a) `viewport-fit=cover` を meta に追加し、ヘッダーにも `pt-[max(var(--space-lg),calc(env(safe-area-inset-top,0px)+var(--space-md)))]` 相当を入れて基準形に揃える。(b) 当面 cover にしないと決め、`--nav-sheet-pad-b` の `env()` は「cover にしたときの前倒し」である旨を ADR-028 に一言足す（現状の ADR-028 は「ホームインジケータ帯を避ける」と効果を断定している）

- **[W-006]** CLAUDE.md と `docs/frontend_implementation_example.md` が、本 PR で削除した基準形を指し続けている
  - 場所: 削除分 `apps/web/app/components/todo/**`（11ファイル）・`apps/web/app/routes/todo/**`（4ファイル）／ 参照元 `CLAUDE.md:58,60`、`docs/frontend_implementation_example.md:30,72,95,108,258,313,371,421,482,532,556,635,734`
  - 理由: CLAUDE.md「Frontend」節は本リポジトリのフロントエンド規約そのもので、`apps/web/app/components/todo/` を「is the reference for all of this」、`apps/web/app/routes/todo/index.tsx` を per-fragment streaming の基準形、`TodoListSkeleton` をスケルトンの基準形として名指ししている。本 PR でそれらが全て消え、**`useOptimistic` はリポジトリ内で参照ゼロ**になった。CLAUDE.md が要求する三層構造の第3層と、list-membership 変更の所有権ルール（まさに次のタイムラインスライスが必要とする論点）を写す先が無い。ドキュメントとコードの乖離であると同時に、次スライスの実装品質に直結する
  - 提案: 削除自体は妥当（`todos` は fog の DB 設計に無い）なので、CLAUDE.md の該当 2 段落の参照先を差し替える。本スライスに存在する基準形は「per-fragment streaming = `routes/_app/settings.tsx` + `components/settings/SettingsSkeleton`」「route-level pending = `components/ui/RoutePendingFallback`」「三層ミューテーション（非リスト）= `components/auth/LoginForm`」。`useOptimistic` の基準形は本スライスに存在しないので、その旨を明記するかタイムラインスライスの Issue に「基準形の再設置」を積む。`docs/frontend_implementation_example.md` は spec-sync / 別 Issue でよいが、CLAUDE.md は本 PR で直すのが筋

- **[W-007]** フォーム全体エラー（`INVALID_CREDENTIALS` 等）では送信後にフォーカスが `<body>` へ落ちる
  - 場所: `apps/web/app/components/auth/LoginForm/index.tsx:53-57`、`SignupForm/index.tsx:54-58`、`apps/web/app/components/ui/Button/index.tsx:39`
  - 理由: R1 W-004 / W-012 の修正で「項目エラーなら該当フィールドへ `focus()`」は入ったが、`display.form` に落ちるエラー（ログイン失敗、`system` / `unknown`、`conflict` の既定文言）はどのフィールドも指さないので `useEffect` が何もしない。一方で送信ボタンは `pending` の間 `disabled` になるため、フォーカス中の要素が無効化されてフォーカスは `<body>` へ移り、そのまま戻らない。実測（誤パスワードでログイン）:

    ```
    { active: "BODY", alerts: ["メールアドレスまたはパスワードが正しくありません"] }
    ```

    `FormMessage` の `role="alert"` があるので読み上げ自体は起きる（WCAG 3.3.1 は満たす）が、キーボード利用者は Tab をページ先頭からやり直すことになり、P-01 の「認証エラー: …再入力可」の体感が悪い。W-012 が「入力欄を無効化するとフォーカスが body に落ちる」と指摘した現象が、ボタン側の無効化として残っている
  - 提案: `display.form !== undefined` のとき `FormMessage` 自体（`tabIndex={-1}` を付ける）か最初の入力欄へフォーカスを移す。`toAuthErrorDisplay` の戻り値は既に `email` / `password` / `form` の直和になっているので、`useEffect` に 3 分岐目を足すだけで済む

### Notes

- **[N-001]** ミューテーション三層構造・トークン運用・オープンリダイレクト防御は R1 の評価どおり良好で、後退は無い。実ブラウザで確認した挙動: `?redirect=/settings` → ログイン → `/settings` に着地／`?redirect=//evil.example` → `/` に着地（オープンリダイレクト遮断）／`/settings` 未認証アクセス → `307 Location: /login?redirect=%2Fsettings`（AC-9）／`/login` ⇄ `/signup` ⇄ `/password-reset` の相互遷移（AC-11 / AC-13）／サイドバー・ボトムシート双方から 5 画面へ遷移し `aria-current` が付く（AC-14）。AC-10 / AC-12 は上表 B-002 の欄のとおり。`pnpm typecheck` / `pnpm build`（Node ランタイム）ともに成功。
- **[N-002]** `/settings` に `staleTime` が無く、既定 0 のため再訪のたびにローダーが新しい promise を作り、`SettingsSkeleton` が再表示される。テンプレの基準形 `routes/todo/index.tsx` はこの現象を JSDoc で説明したうえで `staleTime: import.meta.env.DEV ? 0 : Number.POSITIVE_INFINITY` を置いていた。設定画面はログイン直後の鮮度が欲しいので 0 のままでも設計判断として成立するが、基準形から意図的に外した箇所なので理由を1行残しておくと後続が迷わない（`defaultPreload: "intent"` のホバー先読みで実害はほぼ隠れる）。
- **[N-003]** `TextField` のエラー段落は `error !== undefined` のときだけマウントされるので、`aria-live="polite"` の live region が「生成と同時に中身が入る」形になり、多くのスクリーンリーダーは読み上げない。実際に読み上げを成立させているのは同時に入った `focus()` 移動（`aria-describedby` 経由）のほう。害は無いが、`aria-live` が効いているつもりで将来 `focus()` を外すと通知が消える。段落を常設して中身だけ差し替えるか、`aria-live` は保険である旨をコメントに残すとよい。
- **[N-004]** `_app` の `staleTime: 0`（TC-23 対策）により、保護ルート間の遷移が毎回 `readAuthStateFn` のサーバ往復でブロックする（実測: `/` → `/topics` で `loadAppContext` + `readAuthStateFn` の 2 リクエスト。`__root` は prod では `staleTime: Infinity` なので実質 1 往復）。`defaultPendingMs: 200` を超えると `RoutePendingFallback` が出るが、実測ではシェル（サイドバー・ヘッダー）は残り `<main>` の中だけが差し替わることを確認した（`defaultPendingMs` を 0 にして観測）。想定どおりの挙動なので指摘ではないが、B-001 を「文書に `no-store` を付ける」形で直せば `staleTime: 0` を緩める余地が出る、という関係だけ記録しておく。
- **[N-005]** 型で閉じられる箇所に実行時フォールバックが残っている。`navItems.ts:17-20` の `navTitle` は引数が `NavPath`（5 リテラルの直和）なのに `NAV_ITEMS.find(...)` + `item === undefined ? "fog"` で到達不能な分岐を持つ。`components/auth/errorField.ts:16` の `FIELD_BY_CODE: Readonly<Record<string, "email"|"password">>` と `presentation/errorDisplay.ts:48` の `FIELD_LABELS: Readonly<Record<string, string>>` は、`noUncheckedIndexedAccess` が無効（`tsconfig.json`）なので**型としては全域関数を主張しながら実際は部分関数**で、`errorDisplay.ts:60-61` は `label === undefined` を見るのに型上はその値が来ない。`Record<NavPath, string>` / `Partial<Record<IdentityErrorCodeValue, ...>>` のように定義域を型で閉じれば、CLAUDE.md「不正な状態を型で表現不能にしてから実行時チェックに落とす」に沿う。
- **[N-006]** `AppShell:136` の `onClick={() => (navOpen ? closeNav() : openNav())}` の `closeNav()` 側は到達不能。`navOpen` が true のときメニューボタンは `inert` な `<div>` の中にあるのでクリックもフォーカスも届かない（実測で確認）。同じ理由で `aria-expanded` / `aria-controls` は「開いている間だけ支援技術から見えない」状態になる — シート側にフォーカスが移るので実害は無いが、開閉トグルとしての表現は成立していない。`onClick={openNav}` に単純化し、`aria-expanded` を残す理由（または外す判断）をコメントにするのが素直。
- **[N-007]** ボトムシートに基準形（`timeline.html:847-856` の `transform: translateY(105%)` → `0`、`--transition-default`）のスライドインが無く、条件レンダリングで瞬時に現れる。一方で条件レンダリングは「閉じているシート内のリンクがタブ順に居座らない」というアクセシビリティ上の利点があり、モックの `visibility: hidden` 方式より正しい。`spec/design/index.md`「動きは控えめに」の範囲でどちらを採るかは判断だが、基準形から意図的に外した点として ADR に1行あるとよい。
- **[N-008]** `errorDisplay.ts:46-47` のコメント「A key with no entry here is dropped rather than shown raw」は実装（`parts.push(label === undefined ? first : ...)` — キーだけ落としてメッセージは出す）と読み違えうる。「未知のキーはラベルを付けずメッセージだけ出す」と書くほうが正確。
- **[N-009]** `AuthSheet:18` の `pb-[calc(2*var(--space-2xl))]`（基準形の 80px）は、R2 で `--nav-sheet-pad-b` を役割名トークンにした流儀（ADR-028）と揃っていない。同じ「基準形の生値をトークン式で表す」ケースなので、`--auth-sheet-pad-b` として tokens.css に寄せるか、ADR-028 に「式が単純な場合は任意値構文に留める」線引きを書くとよい。
- **[N-010]** 送信失敗時にパスワードは保持されない（コメントに明記された意図的判断）。`PasswordTooWeak` の場合、ユーザーは「何を入力したか」を見られないまま条件だけ提示される。`helperText`「8文字以上128文字以下」が常設されているので実用上は成立するが、P-02 の「パスワード要件未満を項目ごとに表示」の体感としては再入力コストが残る。マニュアルテスト側の確認項目として記録しておく。
- **[N-011]** `LoginForm:38-39` の `router.invalidate()` → `router.navigate({ href: redirectTo })` は R1 N-008 のとおり `/login` 自身の `beforeLoad` で先に redirect が投げられ、遷移が2回ディスパッチされる（着地点は同じ）。plan の記述は `navigate` → `invalidate` の順。今は無害だが、`redirectTo` と `search.redirect ?? DEFAULT_REDIRECT_PATH` が同値であることに依存している点は変わっていない。
- **[N-012]** R1 で良いとされた点は維持されている。追加で確認できた良い点: `Skeleton` の `neutral-300` 選択理由（`neutral-200` = `--color-bg-page` と同値）が JSDoc に残っている／`TextField` の「なぜ `outline-none` を訳さないか」が B-001 の再発防止コメントとして書かれている（`focus:outline-none` はリポジトリ全体で他に1件も無いことを grep で確認）／`AppShell` の `restoreFocus` ref で「明示的に閉じたときだけトリガーへ戻す」を表現しているのは、`openedAt` による navOpen 導出と合わせて状態モデリングとして素直／`--color-focus-danger` がログアウトボタンにだけ効いていることを実測で確認（算出 `outline-color: oklch(0.55 0.19 27)`）。

---

## 受け入れ基準の検証結果（AC-9〜AC-14）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-9 | **条件付き充足** | 未認証 `/settings` → `307 /login?redirect=%2Fsettings`、ログイン後 `/settings` に着地、`?redirect=//evil.example` は `/` へ丸められる（すべて実測）。ただし**ログアウト後の戻るボタンで保護画面が復元される**（B-001）ため、manual TC-22 は通るが TC-23 が落ちる |
| AC-10 | **充足** | 実測: 誤パスワードで `role="alert"` に「メールアドレスまたはパスワードが正しくありません」、メール値保持、`isPending` 中はボタン無効 + 「ログイン中…」+ `aria-busy`。成功で `/`（または `?redirect=` 先）へ遷移 |
| AC-11 | **充足** | `/login` → `/signup`（title「アカウント登録」）／`/login` → `/password-reset`（title「パスワードリセット」）を実測 |
| AC-12 | **充足** | 実測: 重複メール → `#signup-email` に「このメールアドレスは登録済みです」+ `aria-invalid="true"` + `aria-describedby` + 「このメールアドレスでログインする」リンク + 該当フィールドへフォーカス移動。弱パスワード → `#signup-password` に「パスワードは8文字以上128文字以下で入力してください」。空送信（transport） → 日本語のフィールド別メッセージ。送信中はボタン無効 + 「登録中…」 |
| AC-13 | **充足** | `/signup` → `/login` を実測 |
| AC-14 | **条件付き充足** | 5 項目がサイドバー（`lg` 以上）／ボトムシート（`lg` 未満）で共有され、遷移・`aria-current` ともに動作。フォーカス管理（開く→先頭リンク、Escape→トリガー復帰、背面 `inert`）も実測。ただし (a) `/` でブランドリンクにも `aria-current="page"` が付く（W-003）、(b) シートのスクロールモデル変更が新規遷移のスクロールリセットを壊している（B-002） |
| AC-18 | **充足** | `apps/web/app` 全体を hex / `NNpx` / 数値スケールユーティリティ / テンプレ既定パレットで grep して残存ゼロ（`min-w-0` の誤検出のみ）。生成 CSS 側でも `--skeleton-*` / `--nav-sheet-pad-b` / `--pad-*` が任意値構文で正しくユーティリティ化されていることを確認 |

## 補足: 検証に使った手段の詳細

- **B-001（前ラウンド）**: `tailwindcss@4.3.3` の `compile()` に `apps/web/app` 全ファイルから抽出した候補（括弧・角括弧を含む形）を渡して実 CSS を生成し、`@property --tw-outline-style { initial-value: solid }` が生き残ること、`.focus-visible\:outline-2:focus-visible { outline-style: var(--tw-outline-style) }` が解決すること、`.aria-\[invalid\=true\]\:border-error[aria-invalid="true"]`（L726）が `.focus\:border-primary:focus`（L684）より後に出力されることを確認。さらに実ブラウザで算出値を測定（トランジション中の値を拾わないよう待機してから測定した — 直後に測ると `transition-colors` の途中値 `currentColor` が返る）。
- **B-002（本ラウンド）**: `main` に `min-height: 3000px` を注入して `scrollTop = 800` にしてから遷移し、`main.scrollTop` を測定。戻る側の復元も測定して「復元は動く／トップ復帰だけ壊れている」を切り分けた。`router-core` の `setupScrollRestoration` / `getScrollRestorationSelector` / `scrollToTopSelectors` を読んで機序を特定。
- **B-001（本ラウンド）**: フルロードで履歴エントリを作ったうえでログアウト → 戻る、を実施。`window.__mark` の消失と `navigation.type === "back_forward"` から bfcache ヒープ復元ではなく HTTP キャッシュ再利用であることを確認。`curl` で 5 ルートの `Cache-Control` を突き合わせた。
- **アクセシビリティ**: axe-core 4.12.1 を `/`（認証後）・`/settings`・`/signup` で実行。認証後は violations 0、認証前は 2 件（W-001）。`aria-current` の重複、フォーカス移動、`inert`、`--color-focus-danger` はすべて `document.activeElement` / `getComputedStyle` の実測で確認。
- **デザイン忠実度**: `spec/design/pages/{login,signup,timeline,settings}.html` の CSS と実装のクラス列を役割単位で突き合わせ、`/login`・`/nope-404`・モバイル `/`（ナビシート展開）のスクリーンショットを基準形と比較。寸法・余白・色は R1 で確認済みの範囲から後退なし。
- **副作用の確認**: `h-dvh` + `main` スクロールについて `position: sticky` 利用箇所が無いこと、`scrollRestoration` の挙動（B-002）、`RoutePendingFallback` がシェルを巻き込まないこと（`defaultPendingMs` を実行時に 0 にして観測）を確認。`inert` については背面のフォーカス到達不能とメニューボタンの到達不能（N-006）を確認。
