# レビュー 001 — Frontend

- 対象: PR #17（`issue/1/skeleton-auth`）
- 範囲: `apps/web/app/{routes,components,presentation,styles}`・`routeTree.gen.ts`
- 参照: CLAUDE.md「Frontend」節 / `.issue/1/plan.md`（AC-9〜AC-14・「設計 > UI / プレゼンテーション」）/ `.issue/1/adr.md`（ADR-005 / 007 / 016 / 017 / 018）/ `spec/pages/index.md`（P-01 / 02 / 03 / 04 / 13・共通レイアウト）/ `spec/inventory/frontend.md` / `spec/design/{index,tokens}.md` / `spec/design/pages/*.html`

---

## Frontend

### Blockers

- **[B-001]** `TextField` の入力欄にキーボードフォーカスリングが出ない（Tailwind v4 の `outline-none` と `outline-2` の組み合わせが `outline-style: none` に解決される）
  - 場所: `apps/web/app/components/ui/TextField/index.tsx:18`
  - 理由: クラス列が `focus:outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus` になっている。Tailwind v4.3.3（本リポジトリの解決バージョン）が生成する CSS を実際にコンパイルして確認した:

    ```css
    .focus\:outline-none:focus        { --tw-outline-style: none; outline-style: none; }
    .focus-visible\:outline-2:focus-visible { outline-style: var(--tw-outline-style); outline-width: 2px; }
    ```

    `outline-2` は `outline-style` を**リテラルで持たず** `--tw-outline-style` を読むだけなので、`:focus-visible` は必ず `:focus` も同時に成立する以上 `--tw-outline-style` は `none` に確定し、`outline-style: none` になる。つまりキーボード操作時に 2px のリングが**一切描画されない**。素の CSS で書かれた基準形（`spec/design/pages/login.html` の `.form-input:focus { outline: none }` → `.form-input:focus-visible { outline: 2px solid var(--color-focus) }`）は `outline` ショートハンドで style ごと再指定しているため成立しており、Tailwind への翻訳でこの性質が失われている。`focus:border-primary` による枠線色の変化だけが残るが、`spec/design/index.md`「フォーカスは常に見える — **すべてのインタラクティブ要素がフォーカスリングを持つ**」および WCAG 2.4.7 の要求を満たさない。同じクラス列を後続スライスがコピーすると全入力欄に伝播する
  - 提案: `focus:outline-none` を落とす（モダンブラウザの UA アウトラインは `:focus-visible` でしか出ないので、`outline-none` を置かなくても意図した見た目になる）。どうしても `:focus` 側を潰したいなら `focus-visible:outline-solid` を併記して `--tw-outline-style` を上書きするか、`focus:not-focus-visible:outline-none` にする。修正後は DevTools で `input:focus-visible` の算出 `outline-style` が `solid` になることを確認する

- **[B-002]** 送信失敗時にメールアドレス・パスワードの入力内容が消える（React 19 の form action 自動リセット）
  - 場所: `apps/web/app/components/auth/LoginForm/index.tsx:24-75`、`apps/web/app/components/auth/SignupForm/index.tsx:25-88`
  - 理由: 両フォームとも `<form action={formAction}>` に**非制御**の `TextField` を並べている。React 19（本リポジトリは `react-dom@19.2.8`）は関数を `action` に渡した `<form>` の送信時、アクション本体の実行前に必ずフォームリセットを予約する:

    ```js
    // react-dom-client.development.js:8940 startHostTransition
    null === action ? noop : function () { requestFormReset$1(formFiber); return action(formData); }
    ```

    成功・失敗で分岐しないので、`INVALID_CREDENTIALS` でも `EMAIL_ALREADY_REGISTERED` でも `PASSWORD_TOO_WEAK` でも、エラーを表示した時点で入力欄は空になる。ユーザーはメールアドレスから打ち直しになる。P-01 の「再入力可」、P-02 の「重複エラー…その旨とログインへの導線」（AC-10 / AC-12）が実質的に成立しない。テンプレートの基準形 `CreateTodoForm`（`git show main:apps/web/app/components/todo/CreateTodoForm/index.tsx:28,79-80,49`）は `useState` の**制御入力**にして失敗時に値を保持し、成功時にだけ `setTitle("")` していたので、これは基準形からの明確な後退。加えて `TextField` は `defaultValue` prop を持つのに**どこからも渡されていない**（`components/ui/TextField/index.tsx:11,69`）ため、意図はあったが配線が漏れたと読める
  - 提案: `FormState` に送信値を持たせ（`{ error, values: { email } }`）、`TextField` の `defaultValue` に流す（リセットは「現在の `defaultValue` に戻す」動作なので、再レンダー後の値に落ち着く）。パスワードは保持しない方針でもよいが、その場合もメールアドレスは必ず残す。あるいは基準形どおり制御入力にする。いずれの場合も「失敗後に入力が残る」ことを手動テスト（TC-14 / 15 / 34）の確認項目に加える

### Warnings

- **[W-001]** `/settings` がブロッキングローダーで、per-fragment streaming を使っていない
  - 場所: `apps/web/app/routes/_app/settings.tsx:16,21-22`
  - 理由: `loader: () => renderSettings()` は `renderServerComponent(...)` を **await 済みの promise** として返すため、ルーターがローダーを待ち、ナビゲーションがブロックする。CLAUDE.md は「per-fragment streaming は URL と 1:1 のコンテンツ（一覧・詳細）向け。ローダーは `renderServerComponent(...)` の promise を **await せずに** 転送し、`<Suspense fallback={<Skeleton/>}>` の下で流し込む」と規定し、`routes/todo/index.tsx` をその基準形としていた。`/settings` のアカウント情報はまさに URL と 1:1 の内容で、DB 往復（`getCurrentUser`）を含む。本 PR ではその基準形が丸ごと消え、代わりに route-level pending（`RoutePendingFallback`）が唯一のローディング表現になっている。結果として `Deferred`（`components/ui/Deferred/index.tsx`）はリポジトリ内で**参照ゼロ**になり、テンプレートが用意した2種類のフォールバックの使い分けがこのスライスから失われた
  - 提案: `loader: () => ({ panel: renderSettings() })` の形（await しない）にし、`<Suspense fallback={<SettingsSkeleton/>}><Deferred promise={panel}/></Suspense>` で受ける。スケルトンは実 DOM の形（見出し + 2 行 + ボタン）に合わせて `components/settings/` に置く。少なくとも「なぜ `/settings` だけブロックさせるのか」を plan / ADR に明記して、後続スライスが誤ってコピーしないようにする

- **[W-002]** 唯一のローディング UI である `RoutePendingFallback` がトークン外の生値クラスで組まれている
  - 場所: `apps/web/app/components/ui/RoutePendingFallback/index.tsx:16-21`
  - 理由: `space-y-4` / `p-4` / `h-8` / `w-48` / `h-4` / `max-w-2xl` / `max-w-xl` / `max-w-lg` はいずれも Tailwind 既定スケール（`--spacing: 0.25rem` と既定 `--container-*`）由来で、`tokens.css` にも `theme.css` にも存在しない値。AC-18 の「テンプレート既定パレット由来クラスを含まない」と同じ問題が spacing 側に残っている。しかも W-001 の結果、この画面が `/settings` 遷移時に実際に表示される（`defaultPendingMs: 200` を超えれば）ので、ユーザーに見える面である。`Skeleton` の `bg-neutral-200 → neutral-300` と `rounded → rounded-(--radius-sm)` はきちんと直っているだけに、こちらだけ取り残されている
  - 提案: `p-lg` / `gap-md` / `h-(--icon-lg)` 相当や `max-w-(--content-max)` などトークン由来の値に置き換える。高さのように tokens.md に対応する役割がないものは、ADR-017 の流儀で役割名トークンを 1 つ足してから使う

- **[W-003]** transport 境界の検証エラーが英語の zod メッセージとフィールドキーのまま画面に出る
  - 場所: `apps/web/app/presentation/errorDisplay.ts:46-56`、`apps/web/app/components/auth/errorField.ts:42-48`
  - 理由: `toAuthErrorDisplay` は `fieldErrors.email?.[0]` をそのまま項目直下の文言として使い、`renderErrorMessage` の `validation` 分岐も `formatFieldErrors` が `` `${field}: ${first}` `` を組み立てる。`components/auth/schema.ts` のフィールドはメッセージ指定なしの `z.string().min(1).max(1024)` なので、実際に出る文字列は `Too small: expected string to have >=1 characters` や `email: Too big: ...` になる。日本語 UI（`spec/design/index.md`「スコープ外: 多言語対応（日本語 UI のみ）」）で英語＋内部フィールド名が露出する。`business` / `validation` / `conflict` については code を見る分岐を丁寧に足しているのに、その手前の transport 分岐だけ素通しになっている
  - 提案: `loginSchema` / `signupSchema` に日本語 `message` を与えるか、`formatFieldErrors` 側でフィールドキー → 日本語ラベルの対応表と既定文言を持つ。少なくとも `field:` の生キー連結はやめる

- **[W-004]** 項目単位のエラーがスクリーンリーダーに通知されず、失敗後のフォーカス誘導もない
  - 場所: `apps/web/app/components/ui/TextField/index.tsx:76-80`（`role` / `aria-live` なし）、`apps/web/app/components/auth/{LoginForm,SignupForm}/index.tsx`（送信後のフォーカス操作なし）
  - 理由: `FormMessage` はフォーム上部用に `role="alert"` を持つが、`TextField` のエラー段落は `aria-describedby` で紐づくだけで live region ではない。送信失敗後にフォーカスは移動しない（むしろ後述 W-005 のとおり `disabled` で `<body>` に落ちる）ので、SR 利用者は「メールアドレスの形式が正しくありません」が出たことを知る手段がない。テンプレートの `CreateTodoForm` はフィールドエラー段落に `aria-live="polite"` を置いていた（`git show main:.../CreateTodoForm/index.tsx:87`）ので、ここも基準形からの後退
  - 提案: `TextField` のエラー段落に `aria-live="polite"`（またはフォーム送信起点なら `role="alert"`）を付ける。加えて、送信失敗時に最初の不正フィールドへフォーカスを移すと B-002 の修正とも噛み合う

- **[W-005]** モバイルのナビシートにフォーカス管理がない
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:56-63,147-182`
  - 理由: Escape での閉じるは実装されている（良い）が、(a) 開いたときにシート内へフォーカスが移らない、(b) 閉じたときにメニューボタンへフォーカスが戻らない、(c) 背後のページが `inert` / `aria-hidden` にならない、(d) シートは DOM 上いちばん後ろにあるので、メニューボタンから Tab すると**ページ本文とオーバーレイボタンを全部通過してから**ようやくナビ項目に到達する。視覚的にはモーダルなのに、キーボードでは「画面の一番下にある普通のリンク集」として振る舞う。`spec/design/index.md`「タッチを第一級に」「フォーカスは常に見える」と、AC-14 の「現在地を明示する」ナビの操作性の両方に関わる
  - 提案: 開いたときに最初のナビ項目（またはシート要素自体）へフォーカスし、閉じたときにトリガーへ戻す。背景の `<div>` に `inert`（`navOpen` のとき）を付ける。Tab のループを完全に閉じないまでも、(a)(b)(c) だけで実用上は成立する

- **[W-006]** シェルのスクロールモデルが基準形と異なり、PC のサイドバーが「常設」にならない
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:67,139`
  - 理由: 承認済みデザインの共通シェルは `.app { height: 100dvh; display: flex }` + `.sheet { flex: 1; overflow-y: auto }`（`spec/design/pages/timeline.html:113-115,332-334`）で、**サイドバーとヘッダーは固定されシートだけがスクロールする**構造。実装は `flex min-h-dvh` + `main ... flex-1`（`overflow-y` 指定なし）なので、ページ全体がスクロールし、コンテンツが伸びるとサイドバーもヘッダーも一緒に流れて消える。AC-14 / PAGE-common-001 の「PC はサイドバー（常設）」と、`spec/design/index.md`「1画面=1シート … シートは画面下端まで伸び」の意図から外れる。本スライスは中身が空なので見た目には現れないが、これは全認証後画面が乗る土台なので、タイムラインスライスで直すより今直すほうが安い
  - 提案: 外側を `h-dvh`、`main` を `flex-1 overflow-y-auto` にして基準形と同じスクロールコンテナ構成にする（`overflow-y-auto` を入れる場合はシート内スクロール時の `scrollRestoration` の挙動も併せて確認する）

- **[W-007]** 同一の `readAuthStateFn` が 3 ルートに逐語コピーされている
  - 場所: `apps/web/app/routes/login.tsx:12-17`、`apps/web/app/routes/signup.tsx:9-14`、`apps/web/app/routes/_app.tsx:7-12`
  - 理由: 3 つとも本体が完全に同一だが、`createServerFn` の呼び出しが 3 箇所にあるので**別々の server function 3 本**として登録される。セッション判定の定義がバラけると、片方だけ直して片方が残る事故（例: 将来 `getCurrentUserId` の戻りに `authMethod` を足す）が起きる。plan の「UI / プレゼンテーション」も 1 本の想定で書かれている
  - 提案: `apps/web/app/presentation/authState.ts`（あるいは `components/auth/authState.ts`）に 1 本だけ置いて 3 ルートから import する。ルートモジュール外に出す場合は `__root.tsx` の副作用 import 対象になるか（= どこから参照されるか）を確認する

- **[W-008]** リンクのスタイル文字列が 4 ファイル 6 箇所に重複していて、`.form-link` に対応するプリミティブがない
  - 場所: `apps/web/app/components/auth/LoginForm/index.tsx:89,95`、`SignupForm/index.tsx:69,102`、`apps/web/app/routes/password-reset.tsx:28`（+ `AppShell` の `LINK_FOCUS` 系）
  - 理由: `rounded-(--radius-sm) text-primary-dark transition-colors hover:text-primary-darker focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus` が丸ごと 5 回コピペされている。基準形 `spec/design/pages/login.html` は `.form-link` という 1 クラスで定義しており、`spec/design/index.md`「パターンは基準形から写す」「値はトークンから選ぶ」の運用に照らすと、`Button` / `TextField` / `FormMessage` を切り出したのに `TextLink` だけ切り出していないのは不整合。B-001 と同じ種類のクラス列の事故が複数箇所に散る原因にもなる
  - 提案: `components/ui/TextLink`（`Link` をラップし `to` を透過）を追加して置き換える

- **[W-009]** 認証後ルートに `head` がなく、全画面が同じ `<title>` になる
  - 場所: `apps/web/app/routes/_app/{index,topics,search,trash,settings}.tsx`
  - 理由: `/login` `/signup` `/password-reset` は `buildHead(config, { title, path })` でページ別のタイトル・パスを出しているのに、`_app` 配下の 5 画面はどれも `head` を持たず root の既定に落ちる。AppShell のヘッダーには「タイムライン / トピック / …」が出るので、タイトルの元データは既にある。ブラウザのタブ・履歴・共有時に区別できない
  - 提案: 各ルートに `head` を足す（`AppShell` の `NAV_ITEMS` と同じラベル表を使うと二重管理にならない）

- **[W-010]** ルートのエラー画面・404 画面が未スタイルで、共通レイアウトが要求するリトライ導線もない
  - 場所: `apps/web/app/routes/__root.tsx:51-65`
  - 理由: `spec/pages/index.md` 共通レイアウトは「通信エラーは共通のエラー表示（**リトライ導線付き**）で扱う」と規定している。実装は素の `<h1>Something went wrong</h1>` + `<pre>` で、英語・トークン外・リトライもホームへの導線もない。デザイン方針（面は2階層・タイポで階層を作る）ともまったく接続していない。テンプレート由来の未着手部分だが、`errorComponent` は今回追加した認証フローの失敗時に実際に踏まれうる出口である
  - 提案: 少なくとも `AuthSheet` 相当の器に載せ、日本語文言 + 「再読み込み」（`router.invalidate()`）と `/` への導線を置く。本スライス外と判断するなら、共通エラー表示の実装 Issue を切って plan の「含まれないもの」に明記する

- **[W-011]** ボトムシートに safe-area の考慮がない
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:159`
  - 理由: 基準形は `padding-bottom: max(40px, env(safe-area-inset-bottom, 0px) + 24px)`（`spec/design/pages/timeline.html:846-847`）。実装は `pb-2xl`（= 40px 相当）のみで `env(safe-area-inset-bottom)` を持たない。ホームインジケータのある iPhone では最後の項目「設定」がインジケータ帯に重なる。モバイルが主対象（モバイルファースト）である以上、単なる装飾差ではない
  - 提案: `pb-[max(var(--space-2xl),calc(env(safe-area-inset-bottom)+var(--space-lg)))]` 相当、または `--nav-sheet-pad-b` を役割名トークンとして `tokens.css` に足して使う（ADR-017 の流儀）

- **[W-012]** 送信中に入力欄を `disabled` にするためフォーカスが `<body>` に落ちる
  - 場所: `apps/web/app/components/auth/LoginForm/index.tsx:59,73`、`SignupForm/index.tsx:60,85`
  - 理由: 基準形（`spec/design/pages/login.html`）で `:disabled` を定義しているのは `.btn-primary` だけで、入力欄は無効化していない。フォーカス中の要素を `disabled` にするとフォーカスが body へ移り、失敗後に戻す先が失われる。AC-10 / AC-12 が求めるのは「**ボタン**無効＋進行表示」であって入力欄の無効化ではない。W-004（通知なし）と重なると、キーボード / SR 利用者は「送信した後どこにいるのか分からない」状態になる
  - 提案: 入力欄の `disabled={isPending}` を外し（`readOnly` にする手もあるが不要）、無効化はボタンだけにする

### Notes

- **[N-001]** ミューテーションの三層構造は正しく守られている。`LoginForm` / `SignupForm` は `useActionState` + `useServerFn` + `isPending` によるボタン無効・ラベル差し替え（`Button` の `pending` / `pendingLabel` / `aria-busy`）、`LogoutButton` は `useTransition` + 進行ラベル + `role="alert"` のエラー表示。`<form>` に server fn を直結して pending も optimistic もない失敗パターンには**なっていない**。本スライスには list-membership の変更が存在しないので `useOptimistic` を使わない判断も妥当（所有権の議論が発生する対象がない）。連打対策も `isPending` によるボタン無効で AC-12 を満たす。
- **[N-002]** ログアウトの順序（`logoutFn` → `router.invalidate()` → `router.navigate({ to: "/login", replace: true })`）と `_app.tsx` の `staleTime: 0` が揃っていて、TC-23（戻るボタンで保護画面が復元されない）の対策として筋が通っている。理由もコメントで 1 行だけ残っており、CLAUDE.md の「WHY が非自明なときだけコメント」の運用と一致する。
- **[N-003]** トークン運用は全体として非常に良い。`tokens.css` / `theme.css` の名前集合を機械的に突き合わせたところ、`spec/design/tokens.md` に対する差分は「`--bp-*` 5 本と `--color-bg-section` を意図的に持たない」「派生 12 名（`--gradient-page` / `--pad-input` / `--auth-sheet-max` / `--sheet-w` / `--sheet-w-md` / `--nav-sheet-inset` / `--size-dot` / `--size-mark` / `--size-handle-w` / `--size-handle-h` / `--duration-fast` / `--duration-default`）を足す」の 2 点のみで、**ADR-017 の記述と完全に一致**していた。新規 UI に hex / px の生値はなく、`pb-[calc(2*var(--space-2xl))]`（モックの 80px）や `[inset-inline:var(--nav-sheet-inset)]` のように、名前空間のないトークンも任意値構文でトークン経由に閉じている。`Button` の `disabled:bg-neutral-200` はテンプレート既定パレットに見えるが、モック `.btn-primary:disabled { background: var(--color-neutral-200) }` の忠実な写しで正しい。
- **[N-004]** 入力検証は 2 点に正しく閉じている。`components/auth/schema.ts` はパスワード最低長 8 も上限 128 も書かず、DoS 用の 1024 のみ。その理由（129 文字が `validation` ではなく `PasswordTooWeak`（business）として出るべき）が JSDoc に書かれていて、後から緩む余地が小さい。`errorDisplay.ts` の 3 分岐（`renderBusinessMessage` / `renderValidationMessage` / `renderConflictMessage`）はすべて `code` を見ており、`redactForClient` が潰すのは `system` / `unknown` の code だけなので、`IDENTITY_*` / `INVALID_CREDENTIALS` / `EMAIL_ALREADY_REGISTERED` はクライアントまで届く。日本語文言は plan の表どおり。
- **[N-005]** オープンリダイレクト防御は妥当。`redirectPathSchema` は「`/` 始まり・`//` を含まない・`\` を含まない・`/%2f` 始まりでない・2048 文字以下」で、発生源（`requireUserId()` / `_app.tsx` の `beforeLoad`）は `toSafeRedirect()`、消費側（`login.tsx`）は `validateSearch` の catch 付きスキーマを通す。ADR-016 の「presentation に 1 箇所」も守られている。なお `?redirect=` を受け取る server function は存在しないので、ADR-016 が言う strict 側は今のところ `toSafeRedirect()` が担っている（server fn へ渡す経路が増えたときに strict を使う、という前提が残っている点だけ意識しておくとよい）。
- **[N-006]** `__root.tsx` にクライアント島の action モジュール 3 本（`LoginForm/action` / `SignupForm/action` / `LogoutButton/action`）がすべて副作用 import されている。`readAuthStateFn` / `renderSettings` はルートモジュール内宣言なので登録不要で、漏れはない。`routeTree.gen.ts` も 8 経路（`/` `/login` `/signup` `/password-reset` `/topics` `/search` `/trash` `/settings`）が載っており、`_app` がレイアウトルートとして正しく親になっている。
- **[N-007]** `spec/design/index.md`「ホバーはポインタ環境だけの強化（`@media (hover: hover)`）」は、Tailwind v4 が `hover:` バリアントを既定で `@media (hover: hover)` にラップするため、追加の手当てなしで満たされている（モックが手書きしている `@media (hover: hover)` と等価）。
- **[N-008]** `LoginForm` は `router.invalidate()` → `router.navigate({ href: redirectTo })` の順で呼ぶが、`invalidate()` の時点で `/login` 自身の `beforeLoad` が再実行され、そこで既に認証済みと判定されて `redirect({ href: search.redirect ?? "/" })` が投げられる。結果として遷移は 2 回分ディスパッチされる（最終的な着地点は同じなので不具合ではない）。`redirectTo` と `search.redirect ?? DEFAULT_REDIRECT_PATH` が同値なので今は無害だが、片方だけ変えると挙動が割れる。
- **[N-009]** `components/ui/Deferred/index.tsx` は本 PR 後リポジトリ内から一度も参照されていない（W-001 の裏返し）。テンプレートのプリミティブとして残す判断ならそれでよいが、その旨を JSDoc か plan に一言残しておくと、後続スライスが「使うべき道具」だと気づける。
- **[N-010]** `/` の空状態文言「まだメモがありません」は、P-04 の「空: 最初のメモを促す案内」に対しては状態の報告に留まっている（投稿を促していない）。PAGE-timeline-001 は本スライスのチェックリスト外なので指摘には数えないが、タイムラインスライスで文言を見直す対象として記録しておく。
- **[N-011]** サイドバー / ボトムシート双方に `aria-current="page"` が配線され、アイコンのみのボタン（メニュー・オーバーレイ）に `aria-label` があり、`aria-expanded` / `aria-controls` も対になっている。`Brand` の点と `Mark` は `aria-hidden` で、意味を色だけに載せない（現在地はウェイト差でも表現）という `spec/design/index.md` のアクセシビリティ方針に沿っている。`AppShell` が `openedAt`（開いた場所）を状態に持ち、`navOpen = openedAt === pathname` で導出することで「遷移したら閉じる」を effect なしに表現しているのは、状態のモデル化として素直で良い。

---

## 補足: 検証に使った手段

- **B-001**: `tailwindcss@4.3.3` の `compile()` を直接呼び、`focus:outline-none` / `focus-visible:outline-2` を含むクラス集合をビルドして出力 CSS を確認した（`--tw-outline-style` の初期値は `@property` で `solid`、`outline-none` がこれを `none` に書き換える）。
- **B-002**: `react-dom@19.2.8` の `react-dom-client.development.js` を読み、`startHostTransition` がアクション実行の直前に無条件で `requestFormReset$1(formFiber)` を呼ぶことを確認した。
- **デザイン忠実度**: `spec/design/pages/{login,signup,timeline,settings,password-reset}.html` の CSS と実装のクラス列を役割単位で突き合わせた（`.auth-sheet` / `.form-group` / `.form-input` / `.btn-primary` / `.form-links` / `.side-link` / `.nav-item` / `.nav-sheet` / `.text-btn` / `.section-head`）。W-006 / W-011 以外の寸法・色・余白は基準形と一致するか、トークンの粒度に丸めた許容範囲だった（`.side-nav { gap: 2px }` → `gap-xs`、`.side-link { gap: 10px }` → `gap-sm`、`.nav-item { padding-inline: 2px }` → `px-xs` など。いずれもモック側が生値を書いている箇所で、実装がトークンに寄せた判断として妥当）。
- **トークン集合**: `spec/design/tokens.md` と `apps/web/app/styles/tokens.css` のカスタムプロパティ名を抽出して `comm` で差分を取り、ADR-017 の宣言と照合した。
- **生値の走査**: `apps/web/app` 配下を `#hex` / `NNpx` / `text-red-*` / `bg-neutral-200` / 数値スケールユーティリティで grep し、残存は W-002 の 1 ファイルのみであることを確認した。
