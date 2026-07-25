# PR #17 レビュー（ラウンド2） — Security 観点

対象: `issue/1/skeleton-auth` @ `e805e4f`
参照: `.issue/1/plan.md`, `.issue/1/adr.md`（ADR-002 / 003 / 005 / 009 / 011 / 015 / 032）, `.issue/1/review/review-001-security.md`, `.issue/1/review/triage.md`

**検証方法**: コード読解に加えて、`pnpm dev`（開発ビルド）と `pnpm build && pnpm start`（本番ビルド）の両方を実際に起動し、`SESSION_SECRET` から手で署名した Cookie を使って `/settings`・`/_serverFn/*` を直接叩いて挙動を確認した。以下の指摘・否定はすべて実測に基づく（推測で書いた項目はない）。

結論: **Blocker なし**。1ラウンド目で fix と仕分けた7件のうち6件は解消を確認した。`Cache-Control: no-store`（W-005）だけは **SSR ドキュメント経路のみ解消**で、SPA 内遷移（server function 経路）は依然として無防備なので本ラウンドで再掲する。加えて、1ラウンド目の修正で新たに生じた問題を2件（例示 `SESSION_SECRET` の既定値、ダミーハッシュの定数結合）挙げる。

## 1ラウンド目 fix 項目の検証結果

| 指摘 | 判定 | 根拠 |
|---|---|---|
| W-001 タイミングオラクル | **解消** | 本番ビルドで実測。`test@example.com`（登録済み・パスワード誤り）平均 25.0ms / `nobody@example.com`（未登録）平均 23.7ms。差は測定ノイズ内。VO 弾きの経路（`notanemail`・7文字パスワード）は 1.0ms で、これは JSDoc が明示的に除外している「入力者が既に知っている情報しか漏れない」経路 |
| W-005 `Cache-Control` | **部分的に未解消** | `/settings` の**ドキュメント**応答には `cache-control: no-store, private` が付く（実測）。しかし SPA 内遷移で使われる `GET /_serverFn/<renderSettings>` の応答には**一切付かない**（本文にメールアドレスあり、実測）。→ 本ラウンド [W-001] |
| W-006 鍵ローテーション docs | 解消 | `docs/runtime_{node,cloudflare,aws,gcp}.md` の4本すべてに「Session secret rotation」節。「Rotating `SESSION_SECRET` is the only kill switch」と失効不能のトレードオフも明記 |
| W-007 CloudFront Cookie 転送 | 解消 | `infra/aws/lib/appStack.ts:249` に `originRequestPolicy: ALL_VIEWER_EXCEPT_HOST_HEADER`。`cachePolicy: CACHING_DISABLED` は維持され、コメントで「ここを `CACHING_OPTIMIZED` に変えると認証済みレスポンスが他人に配られる」と釘を刺している。→ [N-003] |
| W-008 起動時検証 | 解消 | Node / AWS / GCP は `read*RequestServerConfig` を boot 内で1回だけ呼ぶ（`server.node.ts:90`, `server.aws.ts:98`, `server.gcp.ts:97`）。CF のみ per-request だが `secrets.ts:45-50` の JSDoc がその理由（`env` が存在する boot 相がない）を明記。副次指摘だった `keyPromise` の JSDoc も実態（リクエスト単位）に合わせて書き直されている |
| W-009 制御文字 | 解消 | `redirectSearch.ts:30-36` の `hasControlCharacter`（C0 全域 + DEL）。`redirectSearch.test.ts` に CRLF / 素の LF / NUL / DEL の4ケース |
| W-010 `_serverFn` 復帰先 | 解消 | `redirectSearch.ts:25` の `/_` 拒否 + `currentUser.ts:51` で `getRequestUrl()` を `toSafeRedirect` に通す。本番ビルドで `POST /_serverFn/<logoutFn>` を無認証で叩くと `location: /login`（`?redirect=` なし）を実測 |

## Security

### Blockers

なし。

以下は Blocker 候補として実際に攻撃を組み立て、**成立しないことを確認した**もの。判断の根拠を残す。

| 疑い | 検証（すべて本番ビルドで実測） | 結論 |
|---|---|---|
| ADR-032 の構造判定を騙して redaction を迂回できる | [N-001] 参照。`errorResponseMiddleware` は `isAppServerError` の判定結果に関わらず `redactForClient` を**必ず**通す構造なので、判定を騙しても redaction 境界は動く | 否定 |
| セッション Cookie の偽造・改ざん | ペイロード差し替え（署名は正規のまま）→ 307 redirect、別鍵で署名 → 307、期限切れ → 307、正規 → 200。すべて期待どおり | 否定 |
| 本番で Cookie 属性が緩む | 本番ビルドの signup 応答 `set-cookie: fog_session=…; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800; Secure`。logout 応答 `fog_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`（属性完全一致） | 否定 |
| `SESSION_SECRET` がクライアントへ漏れる | `apps/web/dist/client/**` と描画済み HTML を実値で grep して0件。`requestContainerConfig.test.ts` がキー集合の**完全一致**を4ランタイム分表明しているので回帰も張られている | 否定 |
| ログイン失敗応答の差異 | 未登録メール / パスワード誤りの応答が **1バイト単位で同一**（422 / `kind:"validation"` / `INVALID_CREDENTIALS` / `Invalid email or password`）。応答時間も [W-001 検証表] のとおり | 否定 |
| React `cache()` がリクエストを跨いでセッションを混線させる | `react@19.2.8` の `cache` 実装は dispatcher 不在時は素通し、存在時は `getCacheForType` 由来のレンダー単位キャッシュ。`getCurrentUserId` / `loadCurrentUser` ともリクエストを跨がない | 否定 |
| SQL インジェクション | `LibsqlUserRepository` / `D1UserRepository` とも drizzle の `eq()` / `and()` のみ。`sql.raw` も文字列連結もゼロ | 否定 |
| 未認証で保護データを読む経路 | 保護データを読む地点は `CurrentUserPanel`（`:22`）と `logoutFn`（`action.ts:9`）の2つだけで、両方 `requireUserId()` を通る。`/_app/` 配下の他4ルートはサーバーデータを読まないプレースホルダ。テンプレート由来の未認証 CRUD だった `/todo` 一式は本 PR で削除済み | 否定 |

### Warnings

- **[W-001]** 認証済みレスポンスの `Cache-Control: no-store` が **server function 経路に付かない** — R1 W-005 の修正がドキュメント経路しか覆っていない
  - 場所: `apps/web/app/presentation/currentUser.ts:36-45`, `apps/web/app/routes/_app/settings.tsx:11-20`
  - 実測（本番ビルド、`pnpm build && pnpm start`）:

    | 経路 | 応答ヘッダ | 本文にメールアドレス |
    |---|---|---|
    | `GET /settings`（ハードナビゲーション） | `cache-control: no-store, private` | あり |
    | `GET /_serverFn/<renderSettings>`（SPA 内遷移） | **`Cache-Control` なし・`Vary` なし** | **あり**（`test@example.com` を確認） |
    | `POST /_serverFn/<logoutFn>` | `cache-control: no-store, private` | — |
    | `GET /_serverFn/<readAuthStateFn>` | **`Cache-Control` なし** | セッション有無（`authenticated: true`） |

  - 理由: `renderSettings` は per-fragment streaming のため `renderServerComponent(...)` の promise を**await せずに**返す（`settings.tsx:19`、CLAUDE.md の規約どおり）。したがって `requireUserId()` は `CurrentUserPanel` の中、つまり**ハンドラが戻って応答ヘッダが確定した後**に走る。`setResponseHeader("cache-control", …)` はそのとき既に手遅れで、ヘッダに載らない。`logoutFn` は同じ `requireUserId()` を await するので載る — 上表がその対比になっている。ドキュメント経路で載っているのは、SSR 中は RSC レンダリング（実測 53ms）がシェルの flush に間に合っているためで、**保証ではなくレース**。DB が遅ければドキュメント側も落ちうる。
  - `currentUser.ts:39-42` のコメントは「ガードの権威点＝このレスポンスは per-user である権威点」と宣言しているが、**保護データを返す唯一の画面ではその宣言が成立していない**。宣言と実装が食い違っている点が、単なる欠落より重い。
  - 悪用可能性の評価: 出荷時の4ランタイム構成では**共有キャッシュに入らない**（AWS CloudFront は `CACHING_DISABLED`、CF は動的レスポンスを既定でキャッシュしない、GCP/CF の infra 定義に CDN なし）ので Blocker にはしない。残るのはブラウザの HTTP キャッシュと、将来 CDN/リバースプロキシを前段に置いたときの事故。`/_serverFn/<id>` の URL は**全ユーザーで同一**（クエリなし・id は静的）なので、キャッシュされた瞬間に他人のメールアドレスが配られる形になる。
  - 提案: ガード側の `setResponseHeader` は「await される server function」でしか効かないので、**権威点をリクエスト境界に移す**のが確実。具体的には `errorResponseMiddleware` と同じ位置に `no-store` を付けるミドルウェアを1本置き、`renderSettings` / `readAuthStateFn` のように認証状態に依存する server function に付ける（あるいはサーバーエントリで `/_serverFn/` 配下に一律で付ける）。`requireUserId()` 側の `setResponseHeader` は残してよいが、**それだけでは覆えない**ことをコメントに明記しないと、次に streaming ルートを足した人が同じ穴を開ける。併せて `Vary: Cookie` も付けておくと前段キャッシュを置いた時のフェイルセーフになる。

- **[W-002]** `.env.example` / `.dev.vars.example` が **32文字の下限を満たす既知の `SESSION_SECRET`** を同梱している
  - 場所: `apps/web/.env.example:26`, `apps/web/.dev.vars.example:21`（ともに `dev-only-session-secret-change-me-0123456789`、44文字）
  - 理由: `requireSessionSecret`（`secrets.ts:52-61`）の検査は「未設定でないこと」と「32文字以上」だけなので、この値は**素通りする**。`.env.example` をコピーしてそのまま本番に出た瞬間、リポジトリを読んだ誰でも任意の `uid` で署名済み Cookie を作れる — つまり**全アカウントのなりすまし**が1行の値の見落としで成立する。ADR-002 が「不在を `""` で表せないよう型で塞ぐ」ところまで作り込んでいるのに、**実在するが公開されている鍵**という一番現実的な失敗モードだけが検知されない。
  - 一貫性の欠落として: `.env.aws.example:33` と `.env.gcp.example:31` は `SESSION_SECRET=`（空）で、起動時に落ちる正しい形になっている。既定値を置いているのは Node と CF だけで、方針が揃っていない。なお本リポジトリのローカル `apps/web/.env` は実際にこの既定値のままである（ローカル開発なので実害はないが、「コピーしてそのまま使われる」ことの実例にはなっている）。
  - 提案: `requireSessionSecret` に例示値そのものの拒否を1行足すのが最も安い（`if (secret === EXAMPLE_SESSION_SECRET) throw …`）。値は `secrets.ts` に定数で持ち、`.env.example` 側からその定数を参照するコメントを書けば二重管理にならない。それを嫌うなら AWS / GCP に揃えて空にし、`docs/runtime_node.md` / `runtime_cloudflare.md` の初回セットアップ手順に `openssl rand -base64 48` を1行入れる。どちらでもよいが、**「32文字以上」という検査だけでは公開鍵の投入を止められない**という穴は塞ぐべき。

- **[W-003]** deferred RSC レンダリング内で throw されたエラーは `errorResponseMiddleware` を通らない
  - 場所: `apps/web/app/routes/_app/settings.tsx:11-20`, `apps/web/app/presentation/errorResponseMiddleware.ts:27-48`
  - 実測: 存在しない `uid` で署名した Cookie を渡して `GET /_serverFn/<renderSettings>` を叩くと、
    - **開発ビルド**: HTTP 200 + RSC ストリーム内に `E{"digest":"","name":"NotFoundError","message":"User not found: ghost-user-id","stack":[["getCurrentUser","/Users/…/packages/core/src/application/identity/getCurrentUser.ts",29,11,…]]}` — 例外名・メッセージ・**開発マシンの絶対パスを含むサーバースタック**がそのまま応答に載る。
    - **本番ビルド**: HTTP 200 + `E{"digest":""}` のみ。**メッセージもスタックも出ない**（React の RSC が本番でメッセージを digest に潰すため）。
  - したがって**情報漏洩は本番では成立しない**ので Blocker にはしない。ただし帰結として以下が崩れている:
    - HTTP ステータスが `httpStatusFor` の写像を通らず常に 200。
    - `redactForClient` を通らない。今回は React 側が握り潰しているだけで、**redaction 境界がこの経路を覆っていない**のは事実（React の本番挙動に依存した安全性になっている）。
    - `errorResponseMiddleware` の `logServerError`（＝注入された `Logger`）に届かない。実測では React の既定 `onError` が `console.error` に落としていたので完全な失聴ではないが、`system` / `unknown` のみを構造化ログに送るという設計方針の外にいる。
  - 提案: streaming を使う限りこの経路は構造的に middleware の外なので、`renderServerComponent(...)` に `onError` を渡して `serializeError` → `redactForClient` → `logger.error` を通す（あるいは `CurrentUserPanel` 側に error boundary を置く）。少なくとも「per-fragment streaming ルートのエラーは `errorResponseMiddleware` を通らない」ことを `errorResponseMiddleware` の JSDoc か CLAUDE.md の該当節に書いておかないと、`redactForClient` が全経路を覆っていると読める現状の記述が誤情報になる。

- **[W-004]** `DUMMY_PASSWORD_HASH` が反復回数をハードコードしていて、`DEFAULT_PBKDF2_ITERATIONS` を上げると**タイミング均等化が静かに逆転する**
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:31-32`, `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:14`
  - 理由: ダミーは `pbkdf2-sha256$210000$…` という**文字列定数**で、`verify` は保存値から反復回数を読み戻す（`pbkdf2PasswordHasher.ts:171`）。つまりダミー verify のコストは 210,000 回に固定されている。`pbkdf2PasswordHasher.ts` の JSDoc は「`iterations` を上げる（あるいは Argon2id 分岐を足す）」ことを明示的な将来計画として書いており、それをやると**未登録メールの経路だけが旧コストのまま**になる。W-001 で塞いだオラクルが、方向を反転させて復活する（「速い＝存在しない」）。しかも 210,000 → 600,000 のような引き上げでは差が数百 ms に開くので、元より読み取りやすいオラクルになる。
  - 既存テスト（`identity.integration.test.ts:581` 「pays for one verification on every credential path」）は verify の**呼び出し回数**しか見ていないので、この退行を検出しない。実際 `counted` には第2引数のハッシュ文字列を push しているのに、長さしか表明していない。
  - 提案: モジュール初期化時に `DEFAULT_PBKDF2_ITERATIONS` からダミーを組み立てる（塩と derived はランダムでよい — 一致する必要はなく、パースが通ってコストが一致すればよい）。定数のまま行くなら、既存テストに `expect(counted[0]).toContain(\`$${DEFAULT_PBKDF2_ITERATIONS}$\`)` を1行足せば結合が明示され、引き上げ時に必ず落ちる。後者なら差分1行で済む。

### Notes

- **[N-001]** ADR-032（`instanceof` → 構造判定）で redaction 境界が壊れていないことを、依頼のあった観点で個別に確認した。
  - **判定を騙せるか**: `isAppServerError`（`errorResponse.ts:172-179`）は `name === "AppServerError"` かつ `serialized` が `SERIALIZED_ERROR_KINDS` に載る `kind` を持つことを要求する。これを満たすオブジェクトをクライアントが**投げさせる**経路は存在しない — server function が throw する値はすべてサーバー側コード由来（usecase / VO / `validateInput`）で、リクエストボディ由来の値を `throw` する箇所はリポジトリ全体にない。
  - **仮に騙せても漏れない**: `errorResponseMiddleware:35-45` は `isAppServerError` の分岐で `rawSerialized` の**取得元**を変えるだけで、その後 `redactForClient(rawSerialized)` を**無条件に**通してから新しい `AppServerError` を作り直して投げる。つまり判定を騙せる場合に攻撃者が得られるのは「自分が仕込んだ `kind` で redaction が走る」ことだけで、**サーバー内部の値を `validation` に化けさせる**ことはできない（内部の値は `toSerialized()` が決めるもので、攻撃者が触れない）。
  - **`kind` の網羅性**: `SERIALIZED_ERROR_KINDS` は `satisfies Record<SerializedErrorKind, true>`、`HTTP_STATUS_BY_KIND` は `Record<SerializedErrorKind, number>` なので、`kind` を足して redaction / status のどちらかを書き忘れると型エラーになる。`asSerializedError` が `kind` / `message` の型まで見てから `isSerializedError` に渡しているので、`{kind: "not-a-kind"}` は `unknown` に落ちる（テスト `appServerErrorAdapter.test.ts:60-66` で表明済み）。
  - **実測**: 本番ビルドで `POST /_serverFn/<loginFn>` にパスワード誤りを投げると、応答は 422 + `"c":"$TSR/t/AppServerError"` タグ付きで `kind:"validation"` / `code:"INVALID_CREDENTIALS"` が届く。R1 修正中に発覚した「`kind` が transport で落ちて AC-10 / AC-12 の文言が出ない」問題は実際に解消している。
  - 逆方向（クライアント → サーバー）で seroval アダプタの `fromSerializable` が呼ばれて `new AppServerError(任意の値)` が構築されうる点は残るが、その値は server function の入力として `inputValidator`（zod）に落とされて弾かれるだけで、認証・認可には触れない。

- **[N-002]** `burnVerificationTime` の例外握り潰し（`loginWithPassword.ts:48-52`）は新しい漏洩・DoS 経路を作っていない。
  - `DUMMY_PASSWORD_HASH` は salt 16 byte / derived 32 byte の正しい base64 で、`parse()`（4フィールド・識別子一致・`1 <= iterations <= 10,000,000`）を通る。テスト用の `FakePasswordHasher.verify` も文字列比較で `false` を返すだけで throw しない。したがって**現状 catch が発火する経路はない**。
  - 発火するのは WebCrypto 自体が壊れたときだけで、その場合「未登録メールは `INVALID_CREDENTIALS`、登録済みメールは 500」という差が出る。ただし WebCrypto が死んでいる状況では正規ログインも全滅するので、攻撃者に有用な状態ではない。
  - DoS 側の変化: 未登録メールでのログイン試行が「ほぼ 0ms」から「210,000 回の PBKDF2（実測 24ms）」になった。これは**タイミング均等化の代償として不可避**で、判断としては正しい。ただし未認証 CPU 消費経路が `/signup` だけでなく `/login` にも広がったことは事実。Issue #18 の対応項目1が `/login` と `/signup` の両方を明記しているので、スコープとしては既にカバーされている（#18 の本文を確認済み）。

- **[N-003]** AWS の CloudFront 設定は「Cookie は届くがキャッシュはされない」を正しく満たしている。`CachePolicy.CACHING_DISABLED` は min/default/max TTL がすべて 0 なので、オリジンが `Cache-Control: max-age` を返しても CloudFront 側では保持されない。`OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` は転送対象を広げるだけでキャッシュキーには影響しない（キャッシュキーはキャッシュポリシー側が決める）ため、**この2つの組み合わせで「認証済みレスポンスがキャッシュされない」は保証される**。`appStack.ts:239-249` のコメントが、次にここを触る人が踏みやすい罠（`CACHING_OPTIMIZED` への変更）を先回りして書いている点も良い。`/assets/*` の別ビヘイビアは S3 オリジン + ハッシュ付きファイル名なので `CACHING_OPTIMIZED` で問題ない。

- **[N-004]** `redirectPathSchema` の `/_` 拒否と制御文字拒否は、新しい迂回路を残していない。実際に攻撃ベクタを流して確認した結果:

  | 入力 | 判定 | 根拠 |
  |---|---|---|
  | `/_serverFn/...` | 拒否 | `startsWith("/_")`（新規） |
  | `/a\r\nX-Injected: y` / `/a\nb` / `/a b` / `/ab` | 拒否 | `hasControlCharacter`（新規） |
  | `//evil.example` / `/\evil.example` / `\\evil.example` | 拒否 | `includes("//")` / `includes("\\")` |
  | `/%2f%2fevil.example` / `/%2F/evil` | 拒否 | `startsWith("/%2f")` / `/%2F` |
  | `/%252f%252fevil.example` | 許可されるが同一オリジン | ブラウザは1回しかデコードしないのでパスのまま。テストが `new URL(...).origin` で表明している |
  | `http:/evil` / `evil.example` / `""` | 拒否 | `startsWith("/")` |

  `/_` を弾く判定が `startsWith("/")` の**後**にあるので、`/_` で始まらない同一オリジンパスは従来どおり通る。`_app.tsx:17` の `toSafeRedirect(location.href)` と `login.tsx:12` の `validateSearch` が同じスキーマを共有しているので片側だけ緩い事故も起きない。`redirectSearchSchema` の `.catch(undefined)` によるフェイルクローズも維持されている。テストは受理6件・拒否17件 + 「どの入力でも解決先が自オリジンを出ない」という性質表明という構成で、**個別ケースではなく性質を守っている**点が良い。

- **[N-005]** `SessionSecret` ブランド型（`secrets.ts:19-32`）の設計は正しい。`requireSessionSecret` を通す以外にこの型を得る手段がないので、「未設定を `""` で表す」不正状態が型で排除されている。Cloudflare だけ per-request のままである影響も限定的で、(a) `readRequestServerConfig` は `fetch` の**最初の行**で呼ばれるためリクエスト処理の前に落ちる、(b) 失敗はフェイルクローズ（全リクエスト 500）で認証が緩む方向には倒れない、(c) エラーメッセージは変数名と最小長しか含まず**値を含まない**（`secrets.ts:56-58`）。JSDoc がその非対称の理由（CF には `env` が存在する boot 相がない）を書いているので、判断としても追跡可能。

- **[N-006]** セッショントークンの**非正規 base64url が受理される**ことを実測した。署名バイト列を標準 base64（`+` / `/` / パディング付き）で表現したトークンでも `/settings` が 200 を返す。これは `encoding.ts:38-49` の JSDoc が「decoding is not canonical」と明示している既知の挙動で、**署名は依然として必要なので偽造には繋がらない**（実害なし）。ただし JSDoc の警告どおり「トークン文字列を同一性の鍵に使わない」という制約は将来のスライスでも守る必要がある — 例えば #18 でレート制限やセッション失効リストをトークン文字列でキーイングすると、同一セッションが別キーになって回避される。**#18 の設計時に思い出すべき制約**として記録しておく。

- **[N-007]** `getCurrentUser` の `NotFoundError` メッセージが `User not found: ${userId}` と id を含む（`getCurrentUser.ts:29`）。`notFound` は `redactForClient` の対象外なので、この文字列はクライアントへ届く。ただし届く相手は**そのセッションの持ち主本人**（`userId` は検証済みセッション由来で、他人の id を渡す口がない）で、`CurrentUserView` にも `userId` が入っている以上、新規に漏れる情報はない。指摘というより「`notFound` は redact されない」という事実の記録。

- **[N-008]** 認証まわりの応答同一性が UI 層まで一貫している。`INVALID_CREDENTIALS` は `FIELD_BY_CODE`（`errorField.ts:16-20`）に載らないので email / password のどちらのフィールドにも紐づかず、必ずフォーム上部のバナーに出る。`LoginForm` / `SignupForm` の失敗時再表示はメールアドレスのみを `FormState` に持ち帰り、**パスワードは意図的に持ち帰らない**（コメントで明記）。1ラウンド目の「送信失敗時の入力保持」修正が、平文パスワードをクライアント state に置く形にならなかったのは適切。

---

## 補足: 本ラウンドで実際に叩いた経路

再現手順として残す（`SESSION_SECRET` から `HMAC-SHA256(base64url(JSON))` を手で計算したトークンを Cookie に載せ、`x-tsr-serverFn: true` ヘッダ付きで server function を直接叩く）。

| 経路 | 結果 |
|---|---|
| `GET /settings`（正規トークン） | 200 / `cache-control: no-store, private` / 本文にメールアドレス |
| `GET /settings`（期限切れ・改ざん・別鍵署名） | いずれも 307 → `/login?redirect=%2Fsettings` |
| `GET /_serverFn/<renderSettings>`（正規トークン） | 200 / **`Cache-Control` なし** / 本文にメールアドレス → [W-001] |
| `GET /_serverFn/<renderSettings>`（存在しない uid） | 200 / 本番は `E{"digest":""}` のみ・開発はスタック込み → [W-003] |
| `GET /_serverFn/<readAuthStateFn>` | 200 / **`Cache-Control` なし** / `authenticated: true` → [W-001] |
| `POST /_serverFn/<loginFn>`（未登録メール vs パスワード誤り） | 応答バイト列が同一（422 / `INVALID_CREDENTIALS`）、平均応答時間 23.7ms vs 25.0ms |
| `POST /_serverFn/<loginFn>`（不正形式メール / 7文字パスワード） | 1.0ms（VO 弾き。JSDoc が明示的に除外している経路） |
| `POST /_serverFn/<signupFn>` | `Set-Cookie` に `HttpOnly; SameSite=Lax; Secure; Path=/; Max-Age=604800` |
| `POST /_serverFn/<logoutFn>`（正規トークン） | 200 / `cache-control: no-store, private` / `Max-Age=0` かつ発行時と属性完全一致 |
| `POST /_serverFn/<logoutFn>`（無認証） | 200 / `location: /login`（`?redirect=` なし）→ W-010 の修正が実際に効いている |
