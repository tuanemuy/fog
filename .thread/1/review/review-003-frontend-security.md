# PR #17 レビュー（ラウンド3） — Frontend / Security

- 対象: `issue/1/skeleton-auth` @ `a214324`（`gh pr diff 17`）/ Issue #1
- 範囲: `apps/web/app/` 全体、`packages/core/src/application/di/`・`adapters/webcrypto/`・`infra/aws/`
- 参照: CLAUDE.md「Frontend」節 / `.thread/1/plan.md`（AC-9〜AC-15 / AC-18）/ `.thread/1/adr.md`（ADR-035〜043）/ `.thread/1/review/review-002-{frontend,security}.md` / `triage.md` / `spec/design/{index,tokens}.md` / `spec/design/pages/*.html` / `spec/pages/index.md`
- 前提（再指摘しない）: defer = rehash-on-login / レート制限 / CSRF Origin 検証（Issue #18）、wont-fix = `__Host-` プレフィックス
- 検証手段: (a) `pnpm dev` + agent-browser（実ブラウザ操作 / axe-core 4.12.1 / `getComputedStyle` 実測 / デスクトップ・モバイル両ビューポート）、(b) `curl` による全ルート・全 server function のヘッダー実測、(c) `SESSION_SECRET` から手で署名した Cookie（正規 / 期限切れ / 改ざん / 存在しない uid）による直接攻撃、(d) `@tanstack/react-router@1.170.18` / `@tanstack/router-core@1.171.15` のソース読解、(e) `pnpm typecheck`（成功）/ `pnpm test`（367 + 39 + 104 = 510 件すべて green）/ `pnpm lint`（error 0、既存テンプレ由来の info 24 件のみ）

---

## 前ラウンド指摘の解消状況

### Frontend（review-002-frontend）

| R2 ID | 内容 | 判定 | 根拠（すべて実測） |
|---|---|---|---|
| B-001 | ログアウト後の戻るボタンで保護画面が復元される | **解消** | `noStoreMiddleware` を `readAuthStateFn` に載せ、`_app.beforeLoad` を通る全ドキュメントに適用。実測: `/` `/topics` `/search` `/trash` `/settings` すべて `cache-control: no-store, private` + `vary: cookie`。フルロードで履歴を作ってログアウト → 戻る → `/login?redirect=%2F` に着地（`navigation.type === "back_forward"`）。manual TC-23 が通る |
| B-002 | 新規遷移でスクロールが先頭に戻らない | **解消** | `<main data-scroll-restoration-id="app-sheet">` + `scrollToTopSelectors`（`router.tsx:13`）。実測: `main.scrollTop = 800` → `/settings` へ遷移で `0`、戻ると `800` に復元 |
| W-001 | `AuthSheet` に `main` ランドマークが無い | **解消** | `<main>` 化。axe 実測で `/login` `/signup` `/password-reset` `/404` すべて violations 0（`landmark-one-main` / `region` 消滅） |
| W-002 | `TextLink` がアクティブ時にスタイルを失う | **解消** | `TextLinkAnchor` が `className` をマージ（`TextLink/index.tsx:15-25`）。router が渡す `"active"` は末尾に付くだけ |
| W-003 | ブランドリンクにも `aria-current` | **解消** | `BrandLink`（`createLink` ラッパー）で `aria-current` を落とす。実測で `/` の `[aria-current]` は「タイムライン」1件のみ |
| W-004 | canonical が全ページ `/` | **解消** | `routeHead()` に共通化し `links` も返す。実測で 8 ルートすべて自 URL の canonical 1本（`__root` は canonical を出さず重複ゼロ）。`og:url` と一致 |
| W-005 | safe-area の手当てが発火しない | **解消（ただし1箇所漏れ）** | `viewport-fit=cover` を meta に追加、`--header-pad-t` / `--auth-pad-t` / `--auth-pad-b` を新設。ただしシート本文の下端が漏れている（→ 本ラウンド W-002） |
| W-006 | CLAUDE.md / docs が削除済み `todo` を指す | **解消** | CLAUDE.md の該当2段落を現存の基準形（`auth/{LoginForm,SignupForm}` / `settings/LogoutButton` / `routes/_app/settings.tsx` / `SettingsSkeleton`）に差し替え。`docs/frontend_implementation_example.md` は冒頭に「`todo` はテンプレのサンプルで削除済み。パスはパターンの図解として読め」という断り書き + 現存する基準形の一覧を追加 |
| W-007 | フォーム全体エラーでフォーカスが body に落ちる | **解消** | `FormMessage` に `tabIndex={-1}` + `useEffect` の第3分岐。実測（誤パスワード）: `document.activeElement` = `<p role="alert" tabindex="-1">`、Tab で `#login-email` へ抜けるのでフォーカストラップになっていない |

**Frontend 未解消: 0 / 9。**

### Security（review-002-security）

| R2 ID | 内容 | 判定 | 根拠（すべて実測） |
|---|---|---|---|
| W-001 | `Cache-Control` が server function 経路に付かない | **解消** | `noStoreMiddleware`（`next()` の**前**にヘッダーを書く）を `readAuthStateFn` / `renderSettings` / `logoutFn` に配線。実測: `GET /_serverFn/<renderSettings>` → `cache-control: no-store, private` + `vary: cookie`、`GET /_serverFn/<readAuthStateFn>` も同じ。`noStoreMiddleware.test.ts` が「ヘッダーは handler より前に書かれる」を表明していて回帰も張られている |
| W-002 | 例示ファイルの既定 `SESSION_SECRET` | **解消** | `.env.example` / `.dev.vars.example` とも空に統一（AWS / GCP と同形）。`docs/runtime_{node,cloudflare}.md` に `openssl rand -base64 48` と「リポジトリに書かれた鍵は全員の鍵」の説明を追加 |
| W-003 | deferred RSC の throw が redaction 境界の外 | **解消** | `guardStreamedRender()` を新設し `CurrentUserPanel` が経由。実測（存在しない uid の署名済み Cookie で `GET /_serverFn/<renderSettings>`）: 流れてくるのは `E{"name":"AppServerError","message":"User not found: ghost-user-id","stack":[]}` で、**`AppServerError` の `delete this.stack` によりサーバースタックは空**。R2 で問題にした「開発マシンの絶対パス入りスタック」は消えている（残る絶対パスは React dev の owner stack で、prod ビルドには出ない React 側の機能） |
| W-004 | ダミーハッシュの反復回数ハードコード | **解消** | `DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS` の型ピンで**両方向とも型エラー**になる。加えて `identity.integration.test.ts:668` が `expect(dummy).toMatch(/^pbkdf2-sha256\$${DEFAULT_PBKDF2_ITERATIONS}\$/)` を実行時にも表明 |

**Security 未解消: 0 / 4。**

---

## Frontend

### Blockers

なし。

### Warnings

- **[W-001]** streaming リーフの失敗が「認証後シェルごと未認証用のエラー画面に差し替わる」— `_app` / `/settings` に `errorComponent` が無く `defaultErrorComponent` も未設定
  - 場所: `apps/web/app/routes/_app.tsx:6-24`、`apps/web/app/routes/_app/settings.tsx:23-31`、`apps/web/app/router.tsx:5-21`、`apps/web/app/routes/__root.tsx:59-63`
  - 理由: `@tanstack/react-router@1.170.18` の `Match.js:78` は `ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment` で、`routeErrorComponent = route.options.errorComponent ?? router.options.defaultErrorComponent`。`/settings` にも `_app` にも `errorComponent` が無く `router.tsx` にも `defaultErrorComponent` が無いので、**両マッチには catch boundary が張られない**。`<Deferred>` の `use(promise)` が投げた例外はそのまま root まで上がり、`__root.errorComponent`（= `AuthSheet` に載った `ErrorScreen`）が `RootComponent` ごと置き換わる。実測（存在しない uid で署名した Cookie → `/settings`）:

    ```
    { hasNav: false, text: "fog / エラーが発生しました / 再読み込み / タイムラインへ" }
    ```

    R1 W-001 の修正で `/settings` が唯一の per-fragment streaming ルートになり、R3 で `guardStreamedRender` がその経路の redaction を回復した — が、**描画側の受け皿は誰も見ていなかった**。到達条件は「保護データの読み取りが失敗する」で、DB の一時障害・ユーザー行の消滅が該当する現実的な経路。ログイン中のユーザーがグローバルナビを失い、未ログイン画面と同じ体裁の画面に落ちるので「ログアウトされた」と誤解しうる。`spec/pages/index.md` 共通レイアウトの「通信エラーは共通のエラー表示（リトライ導線付き）」は満たすが、シェルの中に収まることを期待した表示ではない
  - 提案: `_app.tsx` に `errorComponent` を置き、`AppShell` の `<main>` の中に収まるエラー表示（`ErrorScreen` の中身を `AuthSheet` から切り出して共有）を返す。あるいは `router.tsx` に `defaultErrorComponent` を配線して「ルートエラーはシェル内」「rootエラーだけ全画面」の二段にする。次のスライスは streaming ルートが増えるので、土台側で決めておくのが安い

- **[W-002]** `viewport-fit=cover` を採ったのに、画面下端に接するもう1箇所（シート本文の下端）だけ safe-area を含まない
  - 場所: `apps/web/app/components/layout/AppShell/index.tsx:166-172`（`<main>` の内側 `pb-2xl`）、`apps/web/app/styles/tokens.css:162-181`、`.thread/1/adr.md` ADR-041
  - 理由: ADR-041 は safe-area トークンを4つ（`--header-pad-t` / `--auth-pad-t` / `--auth-pad-b` / `--nav-sheet-pad-b`）足して「**全箇所で** safe-area が算出値に反映されることを確認した」と書いているが、`<main>` はスクロールコンテナで、その内側の余白は `pb-2xl`（`--space-2xl` = 40px）の固定値のまま。実測:

    ```
    { mainBottom: 633, innerHeight: 633, innerPaddingBottom: "40px" }
    ```

    `main` の下端はビューポート下端と一致する（`h-dvh` + `flex-1`）。cover はレイアウトビューポートをホームインジケータ帯まで広げるので、ノッチ機の縦持ちでは最後の行とインジケータ帯（34px）の実クリアランスが **40px → 6px** に縮む。遮蔽ではないが、ホームインジケータはシステムのスワイプ領域でもあり、タイムラインスライスでここに本文やアクションが載ると体感差が出る。基準形 `timeline.html` の `.inner` が `padding-bottom: 150px` を持っていて露見しなかった箇所で、cover 採用の副作用として新たに生じた差分
  - 提案: 他の4つと同形の `--sheet-pad-b: max(var(--space-2xl), calc(env(safe-area-inset-bottom, 0px) + var(--space-lg)))` を tokens.css に足し、`pb-2xl` を `pb-(--sheet-pad-b)` に置き換える。合わせて ADR-041 の Consequences の「全箇所」を、扱った4トークンの列挙 +「左右インセットは扱わない」（既に明記済み）と同じ粒度に直す

### Notes

- **[N-001]** streaming 経路のエラーは `kind` も失う（`guardStreamedRender` が回復するのは redaction とログだけ）。`errorResponseMiddleware.ts:47-48` の JSDoc は「復元できないのは HTTP ステータスだけ」と読めるが、実測では `notFound`（`User not found: …`）が画面上「エラーが発生しました」= `kind: "unknown"` の文言になる。RSC 境界を越えると `appServerErrorAdapter`（seroval）は通らず、クライアントは `serialized` を持たない素の Error を受け取るため `extractSerializedError` が `serializeError` にフォールバックする。**セキュリティ的にはむしろ安全側**（内部情報がさらに落ちる）で、現状 streaming するのは `/settings` だけなので実害は文言の粗さに留まる。JSDoc を「ステータスと `kind` は復元できない」に直すのが正確。
- **[N-002]** `AuthErrorDisplay`（`components/auth/errorField.ts:22-27`）は `email` / `password` / `form` を同時に持てる直積型で、不正な組み合わせが型で排除されていない。実際 transport 検証の分岐だけが `email` と `password` を同時に返す設計なので、`{ kind: "fields", email?, password? } | { kind: "form", message } | { kind: "none" }` のような直和にすると「フィールド別」と「フォーム全体」が排他であることが型に載る。CLAUDE.md「不正な状態を型で表現不能にしてから実行時チェックに落とす」に沿う。R2 N-005 と同系統。
- **[N-003]** `noStoreMiddleware` の `setResponseHeader("vary", "cookie")` は既存の `Vary` を**置換**する。実測で `no-store` が付いたレスポンスからは（フレームワークが付けていた）`Vary: Origin` が消える。`no-store` があるので共有キャッシュ・ブラウザキャッシュのどちらにも影響しないが、前段で CORS を扱う構成を足したときに気づきにくい。既存値への追記にするか、「`no-store` と同時に出るので `Vary` の他の値は意味を持たない」を JSDoc に一言足すと安全。
- **[N-004]** `Cache-Control` が付かない経路の棚卸し（いずれも実害なし、方針として1行あると迷わない）。`loadAppContext`（`__root.tsx:26`）は `noStoreMiddleware` を持たないが返すのは公開 `AppConfig` のみ（`requestContainerConfig.test.ts` がキー集合の完全一致を4ランタイム分表明）。`/password-reset` と 404 は `readAuthStateFn` を通らないので `Cache-Control` なし（認証状態に依存しない静的画面）。307 リダイレクト（未認証 → `/login`、認証済み `/login` → `/`）にも付かないが、307 は RFC 7231 §6.4.7 で既定キャッシュ不可。
- **[N-005]** サイドバーの非アクティブ項目のコントラストが AA をわずかに下回る。`--color-neutral-600`（`oklch(0.52 0.01 275)`）× `--color-bg-page`（`oklch(0.93 0.004 286)`）= **4.45:1**（グラデーション上端 `--color-bg-page-top` でも 4.82:1、実際の項目位置 y=157〜309px では 4.53 / 4.47 / 4.45 / 4.45）。15.2px / weight 500 は「大きな文字」に当たらないので AA 4.5:1 が要る。axe は背景がグラデーションのため `incomplete` 止まりで violation にはならない（実測: `/` は violations 0 / incomplete 1）。**本 PR の後退ではなく、承認済みデザイン `spec/design/pages/timeline.html:161-172` の `.side-link { color: var(--color-neutral-600) }` をそのまま写した結果**なので、直すならデザイン側（`spec/design/tokens.md` の「コントラスト規約」は白地しか想定していない）。`spec/design/index.md:72` の「トークンの役割分担に従っていれば自動的に満たされる」が、この組み合わせでは成り立たないことの記録。
- **[N-006]** `FormMessage` は `role="alert"`（暗黙 `aria-live="assertive"`）を持つ要素そのものにフォーカスを移す。live region の通知とフォーカス移動の読み上げが重なり、スクリーンリーダーによっては同じ文言が2回読まれる。実装としては「フォーカスは移る／読み上げは必ず起きる」が満たされているので害は小さいが、`role="alert"` を内側の `<span>` に移してフォーカス先は素の `<p tabindex="-1">` にすると一度で済む。
- **[N-007]** 型で閉じられる箇所の実行時フォールバックは R2 N-005 から変化なし。`navItems.ts:17-20` の `navTitle` は引数が `NavPath`（5リテラルの直和）なのに `item === undefined ? "fog"` の到達不能分岐を持つ（`Record<NavPath, string>` で消える）。`errorField.ts:16` の `FIELD_BY_CODE` と `errorDisplay.ts:48` の `FIELD_LABELS` は `Readonly<Record<string, …>>` = 全域関数を主張する部分関数（`noUncheckedIndexedAccess` 無効）。triage に載っていないので意図的な見送りと理解しているが、記録として残す。
- **[N-008]** `AuthSheet:22` の `pb-[calc(2*var(--space-2xl))]` は R2 N-009 から変化なし。ADR-028 / ADR-041 で「画面端に接する余白は役割名トークンで持つ」に倒したのに、ここだけ任意値構文で式を直書きしている（画面端に接する余白ではないので実害はない）。線引きを ADR に1行足すか `--auth-sheet-pad-b` に寄せると流儀が揃う。
- **[N-009]** 良かった点。(a) `noStoreMiddleware` のテストが「ヘッダーは `next()` の**前**に書かれる」という、レビューでは正しく見えて実行時に効かない失敗モードそのものを表明している。(b) `scrollToTopSelectors` は `getScrollToTopElements` が `if (element)` でガードしているので、認証前画面（セレクタが一致しない）でも安全に無視される — ソースを確認済み。(c) `BrandLink` / `TextLink` が「`createLink` のラッパーは router が渡す props を素通しにしない」という同じ形で書かれ、ADR-043 に理由（`activeProps` では消せない、`link.js:369` の展開順）まで残っている。(d) Escape でメニューボタンにフォーカスが戻る・背面が `inert`・`prefers-reduced-motion` で `transition-duration: 0s` になることをモバイルビューポート（390×844）で実測、axe violations 0。(e) `_app` の `staleTime: 0` と `router.invalidate()` + `replace: true` の組み合わせで、ルーターのメモリキャッシュ側の TC-23 も閉じている。

---

## Security

### Blockers

なし。

以下は Blocker 候補として実際に攻撃を組み立て、**成立しないことを確認した**もの。判断の根拠を残す。

| 疑い | 検証（すべて実測） | 結論 |
|---|---|---|
| ログアウト後に保護画面がブラウザキャッシュから復元される | 5ルートすべて `cache-control: no-store, private`。フルロードで履歴を作ってログアウト → 戻る → 307 `/login?redirect=%2F` | 否定 |
| `no-store` の適用漏れ経路がある | 保護ドキュメントは全て `_app.beforeLoad` → `readAuthStateFn` を通り、保護データを返す server function は `renderSettings` / `logoutFn` の2つで両方 `noStoreMiddleware` を持つ。`loginFn` / `signupFn` は POST（既定でキャッシュ不可）。`/_serverFn/<renderSettings>` を直に叩いても `no-store` が付く | 否定 |
| streaming リーフから内部情報が漏れる | 存在しない uid の署名済み Cookie で `renderSettings` を直接叩き、ストリームに `"stack":[]`（`AppServerError` が `delete this.stack`）を確認。`system` / `unknown` は `redactForClient` で `"System error"` に潰れる。届く `notFound` メッセージは**そのセッションの持ち主本人の uid** のみ | 否定 |
| 未認証で `renderSettings` から保護データを取れる | `CurrentUserPanel:24-26` は `guardStreamedRender(async () => loadCurrentUser(await requireUserId()))` で、`requireUserId()` を await してからでないと `loadCurrentUser` に到達しない。Cookie 無しで直接叩くと RSC ストリームに redirect が乗るだけでデータは出ない | 否定 |
| セッション Cookie の偽造・改ざん・期限切れ | 改ざんペイロード → 307 `/login?redirect=%2Fsettings`、期限切れ → 307、正規 → 200。すべて実測 | 否定 |
| `SESSION_SECRET` のクライアント漏出（4ランタイム） | `RequestSecrets` のネストにより rest スプレッドが届かない構造（`secrets.ts:21-23` の JSDoc が理由を明記）。`requestContainerConfig.test.ts` が cloudflare / node / aws / gcp の4つで `Object.keys(config)` の**完全一致**と `JSON.stringify(config)` に秘密が含まれないことを表明。`server.aws.ts` は `SESSION_SECRET_ARN` を cold start で解決し、CDK は app Lambda にだけ渡す（`appStack.ts:173-181`） | 否定 |
| オープンリダイレクト | 実測: `//evil.example` / `https://evil.example` / `/_serverFn/x` / `/a\r\nX: y` / `/\\evil` はいずれも `.catch(undefined)` で落ち、ルーターが `?redirect=` を剥がした `/login` へ 307。`/x/%2f%2fevil.example` / `/%252f%252fevil.example` は受理されるがブラウザはパスとして扱うので同一オリジン | 否定 |
| XSS / インジェクション | `dangerouslySetInnerHTML` / `innerHTML` / `eval(` はリポジトリ全体でゼロ。リポジトリは drizzle の `eq()` / `and()` のみで `sql.raw` も文字列連結もなし | 否定 |
| ログイン失敗応答の差異 | R2 で 1バイト単位の同一性と応答時間（23.7ms vs 25.0ms）を実測済み。本ラウンドは退行が無いことを確認（`loginWithPassword` の差分は JSDoc とダミー定数の型ピンのみ） | 否定 |
| タイミング均等化の陳腐化 | `DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS` で両方向とも型エラー。加えて `identity.integration.test.ts:668` が実行時にダミーの反復回数を表明し、`:654-664` が「本番パラメータのハッシャーがダミーを実際にパースできる」ことまで見ている | 否定 |

### Warnings

なし。

### Notes

- **[N-001]** `guardStreamedRender` の catch は `isRedirect(error)` を素通しするが、streaming 経路では **redirect が redirect として機能しない**（レスポンスは既に 200 でコミット済み、RSC 越しにはただの Error になる）。実際に踏むのは「Cookie 無しで `/_serverFn/<renderSettings>` を直に叩く」場合だけで、通常経路では `_app.beforeLoad` が同一リクエストの先で必ず弾くため到達しない。データは出ないので安全側だが、`errorResponseMiddleware.ts:56` の `if (isRedirect(error) || isNotFound(error)) throw error;` が「redirect は正しく飛ぶ」と読める点だけ記録しておく。
- **[N-002]** 開発ビルドの RSC ストリームには依然として開発マシンの絶対パスが載る（`"stack":[["Object.eval [as serverFn]","/Users/…/settings.tsx",…]]`）。これは **React の dev owner stack** で、こちらが投げた `AppServerError` のスタックではない（そちらは空）。prod ビルドでは出ない React 側の機能なので指摘ではないが、R2 W-003 の「絶対パスが出る」との差分を明確にするための記録。
- **[N-003]** `redirectPathSchema` が受理する `/x/%2f%2fevil.example` 系（パーセント二重エンコード）は同一オリジンのパスに解決される。`redirectSearch.test.ts` が「どの入力でも解決先が自オリジンを出ない」という**性質**で表明しているので、個別ケースの追加は不要。
- **[N-004]** `errorField.ts` の `INVALID_CREDENTIALS` は `FIELD_BY_CODE` に載らないので必ずフォーム上部のバナーに出る（= どちらのフィールドが間違っているかを示唆しない）。R3 で追加したフォーカス移動もバナー自身を向くので、応答同一性が UI 層まで一貫している。`FormState` にパスワードを持ち帰らない判断も維持されている（実測: 失敗後 `#login-password` は空、`#login-email` は保持）。
- **[N-005]** セッション固定（攻撃者が victim のブラウザに自分のトークンを仕込む）とログイン CSRF は、Issue #18 の CSRF Origin 検証で塞がる範囲。ステートレス HMAC なので「サーバー側でセッション ID を再生成する」という古典的対策は取れず、対策は CSRF 側に一本化されている — #18 の設計時に「セッション固定もここで閉じる」ことを明示しておくと漏れない。同様に `encoding.ts` の非正規 base64url 受理（R2 N-006）も、#18 でレート制限やセッション失効をトークン文字列でキーイングしないという制約として残る。

---

## 受け入れ基準の検証結果

| AC | 判定 | 根拠（実測） |
|---|---|---|
| AC-9 | **充足** | 未認証 `/` `/topics` `/search` `/trash` `/settings` → いずれも `307 /login?redirect=<path>`。ログイン後 `?redirect=` 先へ着地。`//evil.example` 等は `?redirect=` ごと剥がされて `/login` へ。R2 で条件付きだった原因（B-001）は解消 |
| AC-10 | **充足** | 誤パスワードで `role="alert"` に「メールアドレスまたはパスワードが正しくありません」、メール値保持・パスワード空、送信中は `disabled` + `aria-busy` + 「ログイン中…」。成功で `/` へ遷移 |
| AC-11 | **充足** | `/login` → `/signup`（title「アカウント登録」）／`/login` → `/password-reset`（title「パスワードリセット」）を実測 |
| AC-12 | **充足** | R2 で実測済み（重複メール → `#signup-email` + ログイン導線 + フォーカス移動、弱パスワード → `#signup-password`、空送信 → 日本語のフィールド別メッセージ、送信中はボタン無効）。本ラウンドで退行なし |
| AC-13 | **充足** | `/signup` → `/login` を実測 |
| AC-14 | **充足** | 5項目がサイドバー（`lg` 以上）／ボトムシート（390×844 で実測）で共有され、`aria-current` は常に1件のみ。シートは開くと先頭リンクへフォーカス、Escape でメニューボタンへ復帰、背面 `inert`。R2 で条件付きだった原因（W-003 / B-002）はどちらも解消 |
| AC-15 | **充足** | ログアウトで `document.cookie` 空・`Max-Age=0`、`/login` へ `replace: true`。戻るボタンで `/` を要求 → 307 `/login?redirect=%2F`（`no-store` によりブラウザの履歴キャッシュから復元されない）。manual TC-23 が通る |
| AC-18 | **充足** | `apps/web/app` 全体を hex / `[NNpx]` / `[N.Nrem]` / テンプレ既定パレット（`text-red-500` 等の Tailwind 標準カラー名）で grep して残存ゼロ。`neutral-N` は `theme.css` 経由でデザイントークンに束ねられたクラスで、生値ではない |

## 補足: 本ラウンドで実際に叩いた経路

| 経路 | 結果 |
|---|---|
| `GET /` `/topics` `/search` `/trash` `/settings`（正規 Cookie） | 200 / `cache-control: no-store, private` / `vary: cookie` / canonical は各自の URL |
| 同上（Cookie 無し） | 307 `/login?redirect=<path>` |
| `GET /login` `/signup`（正規 Cookie） | 307 `/` |
| `GET /_serverFn/<renderSettings>`（正規） | 200 / `no-store, private` / `vary: cookie` / 本文にメールアドレス |
| `GET /_serverFn/<renderSettings>`（存在しない uid の署名済み） | 200 / `no-store` / `E{"name":"AppServerError","message":"User not found: ghost-user-id","stack":[]}` |
| `GET /_serverFn/<readAuthStateFn>` | 200 / `no-store, private` / `vary: cookie` |
| `GET /_serverFn/<loadAppContext>` | 200 / `Cache-Control` なし / 公開 `AppConfig` のみ |
| `GET /settings`（期限切れ / 改ざんペイロード） | いずれも 307 `/login?redirect=%2Fsettings` |
| `GET /login?redirect=<12 種の攻撃ベクタ>` | 拒否は 307 `/login`（`?redirect=` 剥奪）、受理は 200 かつ同一オリジンパス |
| ブラウザ: ログイン → `/` を 800px スクロール → `/settings` → 戻る | `scrollTop` 0 → 800 |
| ブラウザ: フルロードで履歴生成 → ログアウト → 戻る | `/login?redirect=%2F`、`navigation.type === "back_forward"` |
| axe-core 4.12.1: `/` `/settings` `/login` `/signup` `/password-reset` `/404`（PC・モバイル両方） | violations 0（incomplete は色コントラストのみ → N-005） |
