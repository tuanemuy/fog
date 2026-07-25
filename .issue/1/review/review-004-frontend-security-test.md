# PR #17 レビュー（ラウンド4） — Frontend / Security / Test

- 対象: `issue/1/skeleton-auth` @ `fd03fa7`（`gh pr diff 17`）/ Issue #1
- 範囲: `apps/web/app/` 全体、`packages/core/src/application/{di,identity}/`・`adapters/webcrypto/`・`infra/aws/`、テスト全体（unit 418 / integration node 39 / integration cf 104）
- 参照: CLAUDE.md / `docs/test.md` / `.issue/1/plan.md`（AC-9〜AC-16 / AC-18）/ `.issue/1/adr.md`（ADR-001〜049）/ `.issue/1/review/review-003-{frontend-security,test-plan}.md` / `triage.md`
- 前提（再指摘しない）: defer = rehash-on-login / レート制限 / CSRF Origin 検証（Issue #18）、wont-fix = `__Host-` プレフィックス
- 検証手段:
  - `pnpm typecheck`（3プロジェクト Done）/ `pnpm test:unit`（25 files・**418 passed**）/ `pnpm test:integration:node`（6 files・**39 passed**）/ `pnpm test:integration:cf`（9 files・**104 passed**）/ `pnpm lint`（error 0、info 22）/ `pnpm format:check`（exit 0）
  - `pnpm dev` + agent-browser（実ブラウザ操作 / axe-core 4.12.1 / `getComputedStyle` 実測）
  - `SESSION_SECRET` から手で署名した Cookie（正規 / 存在しない uid）による直接攻撃、`curl` による全ルートのヘッダー実測
  - `@tanstack/react-router@1.170.18` の `Match.js` / `CatchBoundary.js` のソース読解
  - **ミューテーションテスト**（`redactForClient` に `validation` を混ぜて R3 で追加されたテストが実際に落ちることを確認 → 復元済み）
  - `agent-browser network route --abort` による `readAuthStateFn` の障害注入

---

## 3ラウンド目指摘の解消状況

### Frontend（review-003-frontend-security）

| R3 ID | 内容 | 判定 | 根拠（実測） |
|---|---|---|---|
| W-001 | streaming リーフの失敗で認証後シェルごと未認証風エラー画面に差し替わる | **解消** | `_app.errorComponent` → `ShellErrorScreen`（ADR-048）。存在しない uid の署名済み Cookie で `/settings` を開くと、実測で `nav "グローバルナビゲーション"` + `h1 "設定"` + `h2 "エラーが発生しました"` + 「再読み込み」「タイムラインへ」。`main` は1個、axe violations 0。**さらに Cookie を正規のものに差し替えて「再読み込み」を押すと、フルロードなしでパネルが復帰することまで実測した**（`router.invalidate()` → `loadedAt` 更新 → `CatchBoundaryImpl.getResetKey` 変化）。ADR-048 が (b) `defaultErrorComponent` を採らなかった理由（認証前画面の `main` ランドマークが壊れる／シェル内で `<main>` が入れ子になる）も妥当 |
| W-002 | シート本文下端に safe-area が効かない | **解消** | `--sheet-pad-b: max(var(--space-2xl), calc(env(safe-area-inset-bottom,0px) + var(--space-lg)))` を tokens.css に追加し `pb-2xl` → `pb-(--sheet-pad-b)`。実測（inset なし）で `paddingBottom: "40px"` と `mainBottom === innerHeight === 633` を確認、非ノッチ環境の見た目は不変。他の4トークンと同形で生値・任意値構文なし（AC-18 維持）。ADR-041 の「全箇所」という記述も訂正済み |
| N-001 | `guardStreamedRender` の JSDoc が「復元できないのは status だけ」 | **解消** | 「status と `kind` の2つ」に訂正（`errorResponseMiddleware.ts:50-55`）。実測でも streaming 経路のエラーは `kind: "unknown"` に落ちて画面上は「エラーが発生しました」になり、記述と一致 |
| N-002〜N-008 | Note（直積型 `AuthErrorDisplay` / `Vary` 置換 / `Cache-Control` 棚卸し / コントラスト / `role="alert"` フォーカス / 到達不能分岐 / `pb-[calc()]`） | **未対応（想定どおり）** | triage 未登録の Note。実装は変化なし。→ 本ラウンド Frontend N-006 / N-007 に再掲 |

**Frontend 未解消（Warning 以上）: 0 / 2。**

### Security（review-003-frontend-security）

R3 の Security は Blocker / Warning ともゼロ。Note 5件のうち `guardStreamedRender` の redirect（N-001）・React dev owner stack（N-002）・二重エンコード（N-003）・応答同一性（N-004）・セッション固定と #18（N-005）は、いずれも本ラウンドで退行が無いことを確認した。

### Test / 計画整合（review-003-test-plan）

| R3 ID | 内容 | 判定 | 根拠 |
|---|---|---|---|
| W-001 | 送出側 redaction 境界が丸ごと無テスト | **解消（提案を上回る）** | `errorResponse.test.ts`（新規146行・**36件**）と `errorResponseMiddleware.test.ts`（新規324行・**13件**）。提案の (a)(b)(c) すべてに加えて、(1) `SAMPLES` を実クラスから組み立てて `satisfies Record<SerializedErrorKind, SerializedError>` で全域性を型で強制、(2) `redactForClient` の**通す側**を kind ごとに回したうえで `validation` だけリテラルで二重に固定、(3) `httpStatusFor` の期待値も `satisfies Record<...>` にして kind 追加時に写経漏れを型で落とす、(4) middleware 側は `redirect` / `notFound` の**同一性**（`toBe(thrown)`）・status の呼び出し列（`toEqual([422])` 等）・`FakeLogger` の生ログ内容まで表明、(5) 「既に `AppServerError` に包まれた生ペイロードも境界で redact される」という二重防御まで押さえている。**ミューテーションテストで実効性を確認**: `redactForClient` の分岐に `validation` を足すと 4件が落ちる（`errorResponse` 2件 + `errorResponseMiddleware` 2件）。トートロジーは検出できなかった |
| W-002 | `plan.md` の `changePassword` ランタイム記述 | **解消** | `plan.md:909` が「（型レベルのみ。判別可能ユニオンでコンパイルエラーになるのでランタイムガードは置かない）」に訂正。`entity.test.ts:184-205` も `expect(typeof call).toBe("function")` を落として `void call;` + 「このディレクティブが表明の本体」というコメントに置き換え、テスト名も `rejects an SSO account at compile time` に変更 |
| W-003 | `docs/test.md` の Fake policy 陳腐化 | **解消** | "two" → "three"、`FakePasswordHasher` の項（平文を埋めない理由まで）と「Fake を足してよい基準」を追記 |
| N-007 | 存在しないスクリプトの案内 / `f0...` プレフィックス | **解消** | Commands 表を `test:integration:cf` / `test:integration:node` / 単一ファイル指定に差し替え、`ffffffff-...` に訂正。実際のスクリプトと `fakeIdGenerator.ts:28` に一致することを確認 |
| N-002 | `burnVerificationTime` の `logger.warn` が無テスト | **未対応** | → 本ラウンド Test N-003 |
| N-003 / N-004 / N-005 / N-006 | Note（`users_auth_method_valid` 単独 / `eventDecoders` の `toThrow()` / FNV-1a 32bit / `cache()` 前提） | **未対応（想定どおり）** | → 本ラウンド Test N-004 |

**Test 未解消（Warning 以上）: 0 / 3。**

### 追加で確認したこと

- `@ts-expect-error` を表明の本体にした3箇所（`entity.test.ts` / `pbkdf2PasswordHasher.test.ts` の `DEFAULT_PBKDF2_ITERATIONS` ピン / `requestContainerConfig.test.ts` の `UsecaseContainer` ピン）は、`apps/web/tsconfig.json` の `include: ["**/*"]` と `packages/core/tsconfig.json` の `include: ["src/**/*"]` に含まれるので `pnpm typecheck` が実際に踏む。**死んだ表明ではない**ことを確認した。
- ADR 参照44箇所の `.issue/1/adr.md` 修飾は出荷ソース全体に行き渡っている（`grep -rn "ADR-0" packages/core/src apps/web/app` で未修飾は残っていない）。

---

## Frontend

### Blockers

なし。

### Warnings

なし。

### Notes

- **[N-001]** SSR 中に**リーフのローダーが失敗した場合だけ**、`_app.errorComponent` を経由せずフレームワーク既定の `ErrorComponent` が出る。
  - 場所: `@tanstack/react-router@1.170.18` `dist/esm/Match.js` の `MatchInner` — `isServer` 分岐は `if (match.status === "error") return jsx((route.options.errorComponent ?? router.options.defaultErrorComponent) || ErrorComponent, …)` で、**そのマッチ自身**の errorComponent を返して親へ投げない。クライアント分岐は `throw match.error` なので親（= `_app`）の `CatchBoundary` に上がる。`/settings`（`apps/web/app/routes/_app/settings.tsx:24-27`）は唯一ローダーを持つルートで、`errorComponent` も `router.tsx` の `defaultErrorComponent` も無い。
  - 影響: SSR では英語・無スタイルの `Something went wrong! [Show Error]` がシェルの中に出て、ハイドレーション後にクライアント側で `ShellErrorScreen` に差し替わる（同じ失敗に対して2つの見た目）。ただし本スライスでは `renderSettings()` が拒否する現実的経路がほぼ無い（動的 import の失敗のみ。DB 障害は root の `loadAppContext` が先に落ちる）ため、**到達しないと判断した**。実際、streaming リーフの失敗（本 PR の主眼）はローダーではなくレンダー中に起きるので `_app` が正しく捕まえることを実測済み。
  - 記録として残す理由: 次のスライスは「ブロックするローダー」を持つルートを増やす。そのとき `errorComponent` を書き忘れると、クライアント遷移では `ShellErrorScreen`・初回ロードでは英語の既定画面という非対称が黙って入る。ADR-048 が `defaultErrorComponent` を採らなかった理由（ランドマーク）は妥当なので、対処は「`_app` 配下の各リーフにも `errorComponent` を置く」か「`_app` 側の受け皿でよい旨を ADR に一行足す」のどちらか。

- **[N-002]** `__root.tsx` の `ErrorScreen` の JSDoc と ADR-048 の Decision 節が、実際の分担と食い違っている。
  - 場所: `apps/web/app/routes/__root.tsx:77-83`（「for failures outside the signed-in shell (the pre-auth screens, **and the shell's own layout route**)」）／ `.issue/1/adr.md` ADR-048 Decision（「`__root.errorComponent` は …… 未認証画面と **`_app` 自身の失敗**のための全画面表示として残し」）
  - 実測: `agent-browser network route "**/_serverFn/…authState.ts*" --abort` で `readAuthStateFn` だけを落として `/` → `/settings` をクライアント遷移すると、出るのは **`_app` の `ShellErrorScreen`**（`h2` + グローバルナビ健在）で、root の `AuthSheet`（`h1` のみ・ナビ無し）ではない。`Match.js` の `match.status === "error"` はそのマッチ自身の `errorComponent` を使うので、`_app` の `beforeLoad` / `loader` の失敗も `_app` が捕まえる。root に落ちるのは「root 自身の `beforeLoad`（`loadAppContext`）が失敗」か「`ShellErrorScreen` のレンダー自体が投げる」場合だけ。
  - なお **ADR-048 の Consequences 最終項は正しく書けている**（「`_app` の `beforeLoad`（`readAuthStateFn`）が失敗した場合もこの受け皿が出るため、認証状態が不明のままナビが見える」）。同じ ADR の中で Decision と Consequences が矛盾している形なので、直すのは Decision 節と `__root.tsx` の1語（「and the shell's own layout route」を「and a failure of the root's own `beforeLoad`」に）。R3 が「JSDoc が事実より広い保証を書いている」を4箇所直したのと同じカテゴリで、R3 の修正が新しく持ち込んだもの。挙動には影響しない。

- **[N-003]** ルートエラーの受け皿（`ShellErrorScreen` / `ErrorScreen`）がフォーカスもライブリージョンも持たない。
  - 場所: `apps/web/app/routes/_app.tsx:51-62`、`apps/web/app/routes/__root.tsx:84-95`
  - クライアント遷移でエラー画面に入れ替わったとき、実測で `document.activeElement` は `<body>`。`role="alert"` も `aria-live` も無いので、スクリーンリーダー利用者には「押したリンクの結果、何が起きたか」が伝わらない。R1 W-001 / R2 W-007 でフォーム系のフォーカスとライブリージョンは詰め切ったのに、ルートエラーだけ手当てが無い。`<h2 tabIndex={-1}>` + `useEffect` でマウント時にフォーカスを移すだけで揃う（`FormMessage` と同形）。
  - Warning にしない理由: 到達条件が障害時に限られ、フォーカスが `<body>` に落ちるのは「エラー前の状態を保てない」という一般則の範囲。既存の後退ではない（従来も同じだった）。

- **[N-004]** `ErrorRetry` をシェル内で使うと「タイムラインへ」がサイドバー／ボトムシートの「タイムライン」と重複し、`/`（タイムライン）自身でエラーになったときは自分自身へのリンクになる。
  - 場所: `apps/web/app/components/ui/ErrorRetry/index.tsx:36-38`
  - 全画面版（`AuthSheet` 側）ではナビが無いので唯一の脱出口として要るが、シェル内では冗長。`fullWidth` と同じ props でリンクの有無も切り替えるか、`useRouterState` で現在地が `/` のときだけ落とすと自己参照が消える。実害は無い。

- **[N-005]** `--sheet-pad-b` と `--nav-sheet-pad-b` は式が1バイトも違わない（`max(var(--space-2xl), calc(env(safe-area-inset-bottom,0px) + var(--space-lg)))`）。役割が別なので分けたのは ADR-028 の流儀どおりで正しいが、safe-area トークンが5本になり「画面端に接する余白」の棚卸しは相変わらず目視依存（ADR-049 の Consequences が自らそう書いている）。次に下端へ接する要素を足すときは、既存5本のどれかを流用できないかを先に見ると増殖が止まる。

- **[N-006]** R3 の Frontend Note のうち実装が変わっていないもの（記録のみ、いずれも triage 未登録）。`AuthErrorDisplay` の直積型（R3 N-002）、`noStoreMiddleware` の `Vary` 置換（R3 N-003）、サイドバー非アクティブ項目のコントラスト 4.45:1（R3 N-005 — 本ラウンドも axe は `incomplete` 1件のみで violation にならないことを `/` `/settings` の両方で再実測、承認済みデザイン由来なので直すならデザイン側）、`FormMessage` の `role="alert"` + フォーカスの二重読み上げ（R3 N-006）、`navTitle` / `FIELD_BY_CODE` / `FIELD_LABELS` の到達不能分岐と部分関数（R3 N-007）、`AuthSheet:22` の `pb-[calc(2*var(--space-2xl))]`（R3 N-008）。

- **[N-007]** 良かった点。
  - (a) ADR-048 が **採らなかった選択肢の理由をランドマークで説明している**（`defaultErrorComponent` は全ルート一律なので認証前画面の `main` が壊れる／`AuthSheet` 版にするとシェル内で `<main>` が入れ子になる）。「受け皿が2種類要るのは、ランドマークの持ち主が2種類あるから」という言語化は、次のスライスで受け皿を増やすときの判断基準として再利用できる。
  - (b) `ShellErrorScreen` の JSDoc が「`errorComponent` はそのルートの `component` を置き換えるので `AppShell` を描き直す必要がある」「`AppShell` は表示物をすべて `pathname` から導くので同じ見た目に戻る」と、**再マウントが許される理由**まで書いている。ADR-048 の Consequences にはその代償（ナビシートの開閉状態がリセットされる）も書かれていて、隠していない。
  - (c) ADR-049 が CDP の `Emulation.setSafeAreaInsetsOverride` で 40px → 58px を実測した数字を残しており、`env()` を使ったトークンという「ローカルでは常に既定値に解決されて検証したつもりになれる」箇所に対して正しい検証を当てている。
  - (d) AC-10 / AC-12 をブラウザで再実測して退行なし（誤パスワード → `role="alert"` にフォーカス・メール保持・パスワード空、重複メール → `#signup-email` に `aria-invalid=true` + `aria-describedby` + ログイン導線 + フィールドへフォーカス、弱パスワード → `#signup-password`）。弱パスワード試行後に `users` が2行のままであることも DB で確認した。

---

## Security

### Blockers

なし。

### Warnings

なし。

以下は Blocker / Warning 候補として実際に攻撃または障害を組み立て、**成立しないことを確認した**もの。

| 疑い | 検証（すべて実測） | 結論 |
|---|---|---|
| R3 で追加した `_app.errorComponent` が未認証者にシェルを見せる | `_app.beforeLoad`（`readAuthStateFn`）の失敗で `ShellErrorScreen` が出るのは事実（ADR-048 が自ら記録）。だが (1) 出るのはリンクだけで保護データはゼロ、(2) どのリンクを踏んでも `_app.beforeLoad` が再実行され未認証なら 307 `/login`、(3) 未認証者の初回ロードでこの分岐に入るには `readAuthStateFn` だけが落ちる必要があるが、両者とも `getContainer()` を通るので root の `loadAppContext` が先に落ちて root の全画面エラーになる。保護境界（ADR-005）は無傷 | 否定 |
| `ShellErrorScreen` 経由で内部情報が出る | `sanitizeRouteError` → `renderErrorMessage` は `system` / `unknown` を固定文言に潰す。streaming 経路は RSC 境界で `serialized` を失って `kind: "unknown"` になるため、実測でも画面に出るのは「エラーが発生しました」のみ（`h2` テキストで確認）。`business` / `validation` のフォールバックはレイヤーが書いた英文メッセージで、ドライバ名・テーブル名は載らない | 否定 |
| streaming リーフの redaction が退行した | 存在しない uid の署名済み Cookie で `/settings` を SSR させ、返る HTML の `data-msg` が `User not found: ghost-user-id`（= **そのセッションの持ち主本人の uid**）で `AppServerError` のスタックは空。`system` / `unknown` は `guardStreamedRender` が `"System error"` に潰す（`errorResponseMiddleware.test.ts:285-306` が表明）。開発ビルドに残る絶対パスは React dev の owner stack（R3 N-002 と同じ） | 否定 |
| `Cache-Control` の適用漏れ | 正規 Cookie で `/` `/topics` `/search` `/trash` `/settings` すべて `cache-control: no-store, private` + `vary: cookie`。ログアウト → 戻るボタンで `/login?redirect=%2F` に着地し `navigation.type === "back_forward"`、`document.cookie` は空（manual TC-23） | 否定 |
| オープンリダイレクト / ヘッダーインジェクション | 正規 Cookie 付きで `GET /login?redirect=<12種>` の `Location` を実測。`//evil.example` / `https://evil.example` / `/_serverFn/x` / `/%2f%2fevil.example` / `/\evil.example` / `////evil.example` / `/..//evil.example` はすべて `?redirect=` ごと剥がされて `/login`。受理される `/x/%2f%2fevil.example` / `/%252f%252fevil.example` はブラウザがパスとして扱うので同一オリジン | 否定 |
| ログイン失敗応答の差異（R3 からの退行） | `identity.integration.test.ts` の5経路 `toSerialized()` 一致表明、1回ずつの verify 内訳、本番パラメータのハッシャーでダミーをパースする表明がいずれも green。`loginWithPassword` の R3 差分はラッチと例外の射影のみで、応答の形は不変 | 否定 |
| `SESSION_SECRET` のクライアント漏出 | `requestContainerConfig.test.ts` が4ランタイムで `Object.keys(config)` の完全一致と `JSON.stringify(config)` の非包含を表明。R3 で追加された `UsecaseContainer` の `@ts-expect-error` ピンにより、`sessionCodec` をユースケースから触れるように広げると型検査が落ちる（`pnpm typecheck` がテストを含むことを確認済み） | 否定 |
| XSS / インジェクション | `dangerouslySetInnerHTML` / `innerHTML` / `eval(` はリポジトリ全体でゼロ。R3 で新設した `ErrorRetry` / `ShellErrorScreen` もテキストノードのみ | 否定 |

### Notes

- **[N-001]** `dummyHashUnreadableReported`（`packages/core/src/application/identity/loginWithPassword.ts:54`）はモジュールレベルの可変状態で、**一度立つと同じ isolate では二度と警告が出ない**。
  - 意図（未認証トラフィックでログを水増しさせない）は妥当で WHY も書かれている。ただし「ダミーが読めない」は静的な事実だという前提に乗っているので、**一過性の失敗**（WebCrypto の一時的な拒否、メモリ逼迫でのアボート）で先にラッチが立つと、その後に本物の陳腐化が起きても ADR-034 が「唯一の signal」と位置づけた1行が二度と出ない。実害の大きさは「等時間化が死んだことに気づくのが遅れる」に留まり、リクエストの結果は変わらない。
  - CLAUDE.md の「application 層はステートレス / 純関数を優先」からの逸脱でもある。ラッチをコンテナ（`Logger` のデコレータや `RequestContainer`）側に持たせると、層の原則とテスト容易性（→ Test N-003）が同時に片づく。
- **[N-002]** `redirectPathSchema` は**デコード済みの C0 / DEL**（`hasControlCharacter`）を弾くが、スペース（0x20）は通す。実測で `?redirect=/a%0d%0aX: y` は `Location: /a%0d%0aX: y` として通り、ヘッダー値にリテラルのスペースが載る。`%0d%0a` はパーセントエンコードのまま（デコードされない）ので **CRLF インジェクションは成立しない**し、スペースはヘッダー値として正当な文字。記録のみ。
- **[N-003]** `MIN_SESSION_SECRET_LENGTH = 32` は**文字数**であってエントロピーではない。`docs/runtime_{node,cloudflare}.md` と `.env.example` が `openssl rand -base64 48` を案内しているので運用としては足りているが、`"a".repeat(32)` はチェックを通る。ブランド型が保証するのは「長さの検査を通った」までで、それ以上ではないという記録（`secrets.test.ts:45-49` が floor ちょうどの受理を意図的に固定しているので、これは仕様どおりの挙動）。
- **[N-004]** `/signup` の重複メール応答によるユーザー列挙は、`spec/scenario/account.md` の明示要求（AC-12）で R1 N-014 が既に「spec の意図と整合」と結論している。ログイン側の応答同一化・等時間化がここまで丁寧に作られているぶん、**Issue #18 のレート制限が `/login` だけを対象にすると列挙経路は開いたまま**になる。#18 の設計時に「対象は `/login` と `/signup` の両方」と書いておくと漏れない（R3 Security N-005 の「セッション固定も #18 で閉じる」と同じ趣旨の申し送り）。

---

## Test

### Blockers

なし。

### Warnings

なし。

### Notes

- **[N-001]** R3 W-001 で追加された redaction 境界のテスト（36 + 13 = 49件）は、**ミューテーションテストで実効性を確認した**。`redactForClient` の分岐に `|| serialized.kind === "validation"` を足すと `errorResponse.test.ts` 2件（`hands validation to the client as-is` / `keeps the code and field errors a login failure is rendered from`）と `errorResponseMiddleware.test.ts` 2件（`carries a validation failure to the client with its code intact` ほか）の計4件が落ち、元に戻すと 189/189 green。R3 が懸念した「レビュー修正で足したコードにテストを足さない」形の再発は無く、しかも**期待値を fixture から導出せずリテラルで二重に固定**しているため、fixture 側が一緒に壊れて緑のままになる経路も塞がっている。表明の強度としては本 PR で最も強い部類。
- **[N-002]** `currentUser.test.ts:124-130` のコメントが ADR-038 に追随していない。
  - 「The guard is the authoritative "this response carries protected data" point (.issue/1/adr.md **ADR-031**), so the header … is emitted **here and nowhere else**」と書かれているが、ADR-038 が「ADR-031 の『ガードが唯一の権威点』という表現は本 ADR で置き換わる」と明記しており、実装側（`currentUser.ts:40-43`「Belt to `noStoreMiddleware`'s braces. This alone does NOT cover a per-fragment streaming route」）とも矛盾する。R3 の ADR パス修飾の際に改行だけ入り直して意味は据え置かれた（`// reach the` / `// browser's history` の折り返しが崩れているのも同じ編集の跡）。テストコメントなので挙動には影響しないが、**この PR で一番読まれるであろう「なぜこの1行が要るのか」の説明が、既に置き換わった ADR を指している**。参照を ADR-038 に、「here and nowhere else」を「belt-and-braces alongside `noStoreMiddleware`」に直すだけ。
- **[N-003]** `burnVerificationTime` の `logger.warn` は依然として無テスト（R3 N-002 の再掲）。加えて R3 で入ったモジュールレベルのラッチにより、**テストを書く難度が上がった**（`vi.resetModules()` か `logger` を差し替えたうえでの実行順依存になる）。ADR-034 が「等時間化が死んだときの唯一の signal」と位置づけた1行が、消えても誰も気づかない状態が続いている。Security N-001 の「ラッチをコンテナ側に移す」で両方が同時に片づく。
- **[N-004]** R3 の Test Note のうち実装が変わっていないもの（記録のみ）。`users_auth_method_valid` を単独で狙う行が無く `sum` が先に落ちる（R3 N-003 — `d1` / `libsql` とも `/users_auth_method_(sum|valid)/` の交替のまま）、`eventDecoders.test.ts:97-104` の `toThrow()` が kind / code を見ていない（R3 N-004）、`FakePasswordHasher` の FNV-1a が32ビットで原理的に衝突しうる旨の JSDoc 一行が無い（R3 N-005 — `fakePasswordHasher.ts:17-28` は「平文を埋めない理由」までは書いたが「固定入力専用」は未記載）、`currentUser.test.ts` が `cache()` のレンダー外非メモ化に依存している（R3 N-006）。いずれも triage 未登録の Note で、本 Issue の完了条件外。
- **[N-005]** DOM テスト環境が存在しない（`vitest.config.ts` は `environment: "node"` 固定、`@testing-library/*` / `jsdom` / `happy-dom` はいずれも依存に無い）ため、R3 で新設した `ShellErrorScreen` / `ErrorRetry` にユニットテストは**構造的に書けない**。`docs/test.md` の Coverage 節が「Frontend: the bare minimum」と宣言しているので方針としては整合しており、本レビューでは代わりに実ブラウザで (1) ナビが保たれること、(2) 「再読み込み」が `router.invalidate()` でフルロードなしに復帰すること、(3) axe violations 0、を実測して代替した。次のスライスで「エラー受け皿のテストがある」と誤解しないよう記録しておく。
- **[N-006]** 決定性・独立性は良好。`pnpm test:unit` を単独・全体で複数回実行して 418/418 が安定。`errorResponseMiddleware.test.ts` は `beforeEach` で `mocks.statuses` と `installContainerStore` の両方をリセットし、コンテナの未使用ポートをすべて `trip()`（投げる）で塞いでいるので、「テストが意図しないポートに触れた」ことが受動的に見逃されない。`FakeLogger.entries` を `toEqual([])` で見る happy-path 表明も、`system` / `unknown` 以外でログを出さないという契約の裏側をきちんと押さえている。
- **[N-007]** 良かった点。`errorResponse.test.ts` の `SAMPLES` を**実際のエラークラスから組み立てて** `satisfies Record<SerializedErrorKind, SerializedError>` で受けている設計は、「`SerializedError` に union メンバーが増えたらここがコンパイルエラーになる」という**型による網羅性の門番**になっている。`httpStatusFor` の `EXPECTED` も同じ形なので、R3 の提案（`Object.keys(HTTP_STATUS_BY_KIND)` の集合一致を実行時に見る）より強い形に落ちている。同様に `@ts-expect-error` を「表明の本体」として使った3箇所も、`pnpm typecheck` がテストファイルを含むことを確認したうえで機能している。

---

## 受け入れ基準の検証結果（AC-9〜AC-16 / AC-18）

| AC | 判定 | 根拠（本ラウンドの実測） |
|---|---|---|
| AC-9 | **充足** | 未認証で `/` `/topics` `/search` `/trash` `/settings` → すべて `307 /login?redirect=<path>`（curl 実測）。ログイン後 `?redirect=` 先へ着地。攻撃ベクタ12種は `?redirect=` ごと剥がされる |
| AC-10 | **充足** | 誤パスワードで `role="alert"` に「メールアドレスまたはパスワードが正しくありません」、`document.activeElement` がそのバナー、`#login-email` は保持・`#login-password` は空。送信中はボタン `disabled` + `aria-busy` + 「ログイン中…」 |
| AC-11 | **充足** | `/login` に `/signup`（`アカウント登録`）と `/password-reset`（`パスワードを忘れた`）のリンクが実在し、両方とも実ルート。`TextLink` は `createLink` の型付き `to` なので死んだリンクはコンパイルエラー |
| AC-12 | **充足** | 重複メール → `#signup-email-error` に「このメールアドレスは登録済みです」、`aria-invalid=true` + `aria-describedby=signup-email-error`、「このメールアドレスでログインする」リンク、フォーカスは `#signup-email`。弱パスワード → `#signup-password-error` に「パスワードは8文字以上128文字以下で入力してください」、フォーカスは `#signup-password`。失敗後も `users` は2行のまま（DB 確認） |
| AC-13 | **充足** | `/signup` に `/login` へのリンクが実在（スナップショットで確認） |
| AC-14 | **充足** | 5項目がサイドバー（`lg` 以上）で共有され `aria-current` は「設定」1件のみ。モバイルの下部シート（フォーカス移動 / `inert` / Escape 復帰）は R3 で 390×844 実測済みで、本 PR の差分は `<main>` 内側の `pb-` のみなので退行経路が無い |
| AC-15 | **充足** | ログアウトで `document.cookie` が空・`/login` へ `replace: true`。戻るボタンで `/login?redirect=%2F` に着地し `navigation.type === "back_forward"`。5ルートすべてに `no-store, private` + `vary: cookie`（manual TC-23） |
| AC-16 | **充足** | TC ID 39件がテストソースに埋め込まれ、`spec/testcases/identity/` の4ファイル（registerWithPassword 16 / loginWithPassword 11 / getCurrentUser 9 / logout 3 = 39）と件数が一致。過不足ゼロ |
| AC-18 | **充足** | `apps/web/app` 全体を hex / `[Npx]` / `[N.Nrem]` / テンプレ既定パレット（`text-red-500` 等）で grep して残存ゼロ。任意値構文は `AuthSheet:22` の `pb-[calc(2*var(--space-2xl))]`（トークンの式であり生値ではない、R3 N-008）1箇所のみ。R3 で追加した `--sheet-pad-b` / `ErrorRetry` / `ShellErrorScreen` もすべて役割名トークン |

参考: AC-17 も本ラウンドで再確認（`pnpm typecheck` 3プロジェクト Done / `pnpm test:unit` 418 / `pnpm test:integration:node` 39 / `pnpm test:integration:cf` 104 / `pnpm lint` error 0 / `pnpm format:check` exit 0 / `pnpm dev` で起動して全画面を操作）。

---

## 総評

**Blocker 0 / Warning 0 / Note 15（Frontend 7・Security 4・Test 7 のうち重複記録を除く）。マージ可。**

3ラウンドで指摘された Blocker / Warning は**全件解消**しており、本ラウンドで新たに Warning 以上と判断した事柄は無い。R3 の2つの Frontend Warning はどちらも実ブラウザで修正後の挙動を確認できた — とくに W-001 は「エラーになること」だけでなく「ナビが残ること」「リトライがフルロードなしに復帰すること」まで実測で閉じている。R3 Test W-001（redaction 境界）への対応は、ミューテーションテストで**意図した退行を実際に検出できる**ことを確認した唯一のケースであり、写経でもトートロジーでもない。

本ラウンドで新たに見つけたものはすべてドキュメント／観測性／将来のスライスへの申し送りに属する。実装の挙動を変える必要があるものはゼロ。強いて優先順位を付けるなら、コストが最も低くリターンが明確なのは次の2つ:

1. **Frontend N-002 / Test N-002** — `__root.tsx` の JSDoc 1語、ADR-048 Decision 節の1文、`currentUser.test.ts` のコメント参照を ADR-031 → ADR-038 に。いずれも「事実と食い違う説明」で、R3 が同じカテゴリを4箇所直した直後に残ってしまったもの。マージ前の同一コミットで済む。
2. **Frontend N-001** — 次のスライスがブロックするローダーを増やす前に、`_app` 配下のリーフに `errorComponent` を置くのか `_app` の受け皿でよしとするのかを ADR-048 に一行足す。

Security / Test の残りの Note（ラッチのテスト容易性、`users_auth_method_valid`、`eventDecoders` の `toThrow()`、#18 のレート制限対象に `/signup` を含めること）は本 Issue の完了条件外で、次スライスまたは Issue #18 / spec-sync に送ってよい。

**マージ判断: 可。** 上記1のドキュメント修正は推奨だが、マージの条件にはしない。
