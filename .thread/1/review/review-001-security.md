# PR #17 レビュー — Security 観点

対象: `issue/1/skeleton-auth`（167 files / +9985 −3802）
参照: `.thread/1/plan.md`, `.thread/1/adr.md`（ADR-002 / 003 / 005 / 009 / 011 / 015）, `spec/usecases/identity.md`, `spec/domains/identity.md`, `spec/scenario/account.md`

結論から言うと、**認証・セッション基盤のコア（PBKDF2 のパラメータ、HMAC 検証、秘密鍵の隔離、Cookie 属性、オープンリダイレクト検証、認可ガードの権威点）はどれも実装として正しい**。悪用可能な欠陥は見つからなかった。指摘はすべて「運用・多層防御・スコープ外として残した既知の穴」に集中する。

## Security

### Blockers

なし。

以下は Blocker 候補として実際にコードを追って**否定した**もの。判断の根拠を残す。

| 疑い | 検証 | 結論 |
|---|---|---|
| 本番で `Secure` が付かない | `session.ts:32` は `secure: import.meta.env.PROD`。ビルド済み `apps/web/dist/server/rsc/assets/session-aOSZ2szG.js:56` が `buildSessionCookie(token, { secure: true })` にインライン化されているのを確認 | 否定 |
| `SESSION_SECRET` がクライアントへ漏れる | 4ランタイムすべての `createXxxRequestContainer` で `secrets` が rest-spread から除外され、`container.config` は `AppConfig` のみ。`loadAppContext`（`__root.tsx:29`）が返すのは `container.config` のみ。`requestContainerConfig.test.ts` がキー集合を**列挙**で表明（既知の漏出先の否定ではなく全キー一致）していて回帰も張られている | 否定 |
| 署名検証の迂回（アルゴリズム混同・型混同・truncation） | `hmacSessionCodec.ts:89` は HMAC 固定・`crypto.subtle.verify`（定数時間・長さ不一致で false）。ペイロードの `alg` 相当は存在せず、payload のパースは**署名検証後**（`:100`）。`parsePayload` が `uid: string` / `exp: number` を型で絞る | 否定 |
| オープンリダイレクト | 後述の攻撃ベクタ表で `//`・`\`・`%2f`・二重エンコード・スキーム相対をすべて試行し、すべて弾かれることを確認 | 否定 |
| 平文パスワードの漏出 | イベントペイロード（`domain/identity/events.ts`）・View（`application/identity/view.ts`）・エラーメッセージ（`valueObject.ts:81` は値を含まない）・ログ（`errorResponseMiddleware.ts:60` が渡す `cause` は WebCrypto の DOMException / driver error のみ）・URL（すべて POST body）を確認 | 否定 |
| SQL インジェクション | `userRepository`（libsql / d1 両方）は `eq()` / `and()` のみ。文字列連結による SQL 組み立てはゼロ | 否定 |
| XSS | `dangerouslySetInnerHTML` / `innerHTML` / `eval` は差分にも既存にも存在しない | 否定 |
| スタックトレース漏洩 | `AppServerError` が `delete this.stack`（`errorResponse.ts:122`）、`toSerialized()` は `cause` を含まない（`lib/error.ts`）、`system` / `unknown` は `redactForClient` で `code: null` / `"System error"` に潰れる | 否定 |
| セッション固定 | `loginFn` / `signupFn` はどちらも `startSession(userId)` で**必ず新規トークンを発行**し、`setResponseHeader`（append ではなく set）で上書きする。攻撃者が事前に植え付けられるのは自分の署名済みトークンだけで、ログイン時に無条件で置換される | 否定 |

### Warnings

- **[W-001]** ログイン失敗の**応答時間**でアカウントの存在が漏れる（ユーザー列挙オラクル）
  - 場所: `packages/core/src/application/identity/loginWithPassword.ts:46-58`
  - 理由: 未登録メール（`:49`）と SSO ユーザー（`:52`）は `passwordHasher.verify` に到達せず即座に返る。登録済みパスワードユーザーだけが 210,000 回の PBKDF2 を回す（`pbkdf2PasswordHasher.ts:14`）。実測で数百 ms オーダーの差が出るため、`kind` / `code` / `message` を完全一致させた（TC-loginWithPassword-003〜007 で表明済み）努力が**タイミング一発で無効化される**。「失敗理由を特定しない」という spec/usecases/identity.md loginWithPassword の意図に対して緩和が不完全。
  - Blocker にしない理由: `registerWithPassword` の `EMAIL_ALREADY_REGISTERED`（spec が UX 上の既知トレードオフとして明示的に許容）で**同じ列挙が正面から可能**なので、この経路が攻撃者に新しい能力を与えていない。ただし signup 側は CAPTCHA / レート制限で塞ぐのが定石なのに対し、こちらは塞いでも残る。
  - 提案: 固定のダミーハッシュ（起動時に1回 `hash()` して保持、あるいは定数として埋め込む）に対する verify を「ユーザー不在 / SSO」の分岐でも実行して経路長を揃える。`.thread/1/progress.md` の項目1に記録済みなので、フォローアップ Issue として起票し ADR に「本 Issue では見送る」判断を昇格させる。

- **[W-002]** PBKDF2 のコスト引き上げ経路（rehash-on-login）が実装されていない
  - 場所: `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts:108-111`, `packages/core/src/application/identity/loginWithPassword.ts:54-60`
  - 理由: 保存形式 `pbkdf2-sha256$<iterations>$<salt>$<hash>` は自己記述的で、`verify` が保存値から `iterations` を読み戻す（`:138`）ので**旧ハッシュの検証互換は確保されている**。しかし ADR-003 が謳う「ログイン成功時に新方式で再ハッシュする（rehash-on-login）」の**書き戻し側が存在しない**。JSDoc も「later adding an Argon2id branch and re-hashing on login」と将来形。したがって `DEFAULT_PBKDF2_ITERATIONS` を 210k から引き上げても、既存ユーザーは**永久に旧コストのまま**で誰も気づかない。「アップグレード経路が確保されている」は現状「壊れてはいない」に留まる。
  - 提案: 本 Issue では `PasswordHasher` に `needsRehash(hash): boolean` を足すだけでもよい（未使用でも契約が残る）。実際の書き戻しは `changePassword` スライス（`User.changePassword` + `save`）と一緒に入れるのが自然なので、そこまでは「引き上げ時は全ユーザーに強制リセットが要る」ことを ADR-003 の Consequences に明記する。

- **[W-003]** ログイン試行のレート制限・ブルートフォース対策が一切ない
  - 場所: `apps/web/app/components/auth/LoginForm/action.ts:7`, `apps/web/app/components/auth/SignupForm/action.ts:1`
  - 理由: `loginFn` / `signupFn` は未認証で無制限に叩ける。アカウントロックも試行回数カウントも IP スロットルも存在しない。`PlainPassword` の下限が 8 文字なので、辞書攻撃の対象として十分に現実的。
  - 併せて **CPU 増幅 DoS**: `registerWithPassword.ts:43` は重複チェック（`:53`）より**前に** 210k 回の PBKDF2 を回す。ADR-009 の「トランザクション内に CPU を持ち込まない」判断としては正しいが、結果として**未認証リクエスト1発で 100〜200ms の CPU を確実に消費させられる**。CF Workers の CPU 予算・Lambda の同時実行数に対しては特に効く。
  - 提案: spec / 受け入れ基準に要件がないので本 Issue のスコープ外で妥当。ただし「認証エンドポイントのレート制限」を**フォローアップ Issue として明示的に起票**すること（`progress.md` にも項目がない）。実装場所は presentation のミドルウェア（`IdempotencyStore` が既にあるので、同じテーブルを流用したカウンタでも成立する）。

- **[W-004]** CSRF 防御が `SameSite=Lax` 単独
  - 場所: `apps/web/app/start.ts:4-6`, `apps/web/app/presentation/sessionCookie.ts:42`
  - 理由: `progress.md` 項目2 のとおり `createStart` に CSRF 設定がない。実効性の評価としては**現状ほぼ塞がっている**：(a) `SameSite=Lax` によりクロスサイト POST に Cookie が乗らない、(b) TanStack Start のサーバー関数は JSON body でプリフライトが要る、(c) 変更系（`loginFn` / `signupFn` / `logoutFn`）はすべて `method: "POST"`。残るのは **login CSRF**（被害者を攻撃者アカウントにログインさせる）だが、Lax Cookie はクロスサイト POST のレスポンスでは原則セットされないため実害は薄い。
  - 提案: Blocker ではないが、Origin / Sec-Fetch-Site ヘッダの検証を server function ミドルウェアに1本入れておくと、将来 `SameSite` を `None` にせざるを得なくなった時（埋め込み・OAuth ポップアップ等、S-AC-05 の認可画面で現実味がある）に穴が開かない。`errorResponseMiddleware` と同じ配置で足せる。

- **[W-005]** 認証済みレスポンスに `Cache-Control: no-store` が付かない
  - 場所: リポジトリ全体（`Cache-Control` を設定している箇所がゼロ）
  - 理由: `/settings` の RSC ペイロードにはユーザーのメールアドレスが載る（`CurrentUserPanel/index.tsx:33`）。共有キャッシュへの混入は当面ない（AWS は CloudFront `CACHING_DISABLED`、CF は動的レスポンスを既定でキャッシュしない）が、**ブラウザの bfcache / ヒューリスティックキャッシュ**は塞げていない。ログアウト後の戻るボタン対策は `_app.tsx:19` の `staleTime: 0` と `LogoutButton/index.tsx:26-27` の `invalidate()` → `navigate({replace: true})` で**ルーターのメモリキャッシュに対しては**成立しているが、これは HTTP キャッシュ層の対策ではない。
  - 提案: 認証を要するレスポンス（少なくとも `requireUserId()` を通る server function / loader）に `Cache-Control: no-store, private` を付ける。`requireUserId()` 内で `setResponseHeader` を呼ぶのが最も漏れがない（ガードの権威点＝キャッシュ禁止の権威点になる）。

- **[W-006]** ステートレスセッションの失効不能が運用ドキュメントに落ちていない
  - 場所: `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:28-42`, `docs/runtime_node.md` ほか
  - 理由: ADR-002 のトレードオフ（サーバー側から能動的に失効できない）は妥当な判断だし、TTL 7日という緩和も適切。ただし帰結として、**Cookie が一度漏れたら最大7日間、誰にも止められない**。唯一のキルスイッチは `SESSION_SECRET` のローテーション（＝全ユーザー強制ログアウト）で、これは `.env.example:25` に1行あるだけで `docs/runtime_*.md` のどこにも運用手順がない。インシデント時に「何をすれば全セッションを切れるか」が探せない状態。
  - 提案: `docs/runtime_node.md` / `runtime_cloudflare.md` / `runtime_aws.md` / `runtime_gcp.md` に「セッション緊急失効 = `SESSION_SECRET` のローテーション（全ユーザーが再ログインになる）」を1節足す。`changePassword` スライスでペイロードに `passwordVersion` を持たせる案（ADR-002 が中間案として言及）は、そのスライスの ADR で再評価する。

- **[W-007]** AWS ランタイムでは CloudFront がセッション Cookie もクエリ文字列もオリジンへ転送しない
  - 場所: `infra/aws/lib/appStack.ts:234-241`
  - 理由: `defaultBehavior` は `cachePolicy: CachePolicy.CACHING_DISABLED` のみで **`originRequestPolicy` が未指定**。CloudFront がオリジンへ転送するのは「キャッシュポリシー ∪ オリジンリクエストポリシー」に含まれる値だけで、`CachingDisabled` は cookies / headers / query strings すべて `none`。したがって Lambda に `Cookie` ヘッダが届かず、**AWS ランタイムでは誰もログイン状態を維持できない**。`?redirect=` も server function のクエリ引数も同様に落ちる。
  - この Distribution 自体はテンプレート由来で本 PR の変更ではないが、**Cookie 認証に依存する機能を最初に載せたのが本 PR**なので、ADR-015 で AWS の秘密鍵配布まで作り込んだ意味が現状は成立しない（配った鍵で署名した Cookie が戻ってこない）。フェイルクローズなので脆弱性ではない。
  - 提案: `originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` を `defaultBehavior` に足す。**注意点として明記すべきは、ここで安易に `CACHING_OPTIMIZED` 等へ変えるとキャッシュキーに Cookie が入らないまま認証済みレスポンスがキャッシュされ、他人のセッションが配られる**こと。`CACHING_DISABLED` は維持したままオリジンリクエストポリシーだけ足すのが正解。

- **[W-008]** `SESSION_SECRET` の検証がリクエストごと（起動時ではない）
  - 場所: `apps/web/app/server.node.ts:102`, `server.aws.ts:108`, `server.gcp.ts:121`, `server.cloudflare.ts:43` / `packages/core/src/application/di/secrets.ts:31`
  - 理由: 4ランタイムとも `createXxxRequestContainer(config)` を**fetch ハンドラの中**で毎回呼ぶ。`requireSessionSecret` はその中にあるので、鍵が欠落・短すぎでも**プロセスは正常に起動し**、以後すべてのリクエストが 500 になる。`.thread/1/testing.md` の見出しは「起動時エラー」だが本文は「リクエスト処理時」で、本文が正しい。フェイルクローズなので安全側だが、デプロイのヘルスチェック次第では設定ミスがロールアウトを通過する。
  - 副次的に、`hmacSessionCodec.ts:52` の `keyPromise` メモ化（「importKey を毎リクエスト走らせない」ための最適化）が**コーデック自体が毎リクエスト作られるため一切効いていない**。JSDoc の主張と実装が食い違う。
  - 提案: `readXxxRequestServerConfig`（起動時に1回）の側で `requireSessionSecret` を呼ぶか、`sessionCodec` / `passwordHasher` をブート時に1回作って `config` 経由で渡す。後者なら `keyPromise` の意図も回復する。ADR-002 の「消費地点で検証する」という原則は、起動時に1回だけ組み立てるなら維持できる。

- **[W-009]** `redirect` パラメータが制御文字を拒否していない
  - 場所: `apps/web/app/presentation/redirectSearch.ts:21-32`
  - 理由: `?redirect=/a%0d%0aX:%20y` は search パラメータのデコードで `/a\r\nX: y` になり、`startsWith("/")` / `!includes("//")` / `!includes("\\")` をすべて通過する。これが `login.tsx:26` の `throw redirect({ href: search.redirect })` 経由で `Location` ヘッダに乗る。
  - **実害は否定した**: WHATWG `Headers` は CR/LF を含むヘッダ値を拒否して `TypeError` を投げるので、Node（undici）でも workerd でもレスポンス分割にはならず 500 になるだけ。理論上の懸念であって現時点の脆弱性ではない。
  - 提案: それでも多層防御として `.refine(v => !/[\x00-\x1f\x7f]/.test(v))` を1行足す価値はある。ランタイムのヘッダ実装に依存した安全性より、境界で潰したほうが監査しやすい。

- **[W-010]** `requireUserId()` の `redirect` 値が server function URL になりうる
  - 場所: `apps/web/app/presentation/currentUser.ts:40-45`
  - 理由: `getRequestUrl()` は「今処理しているリクエストの URL」なので、server function 経由（`renderSettings` → `CurrentUserPanel` → `requireUserId`、`logoutFn` → `requireUserId`）で未認証だった場合、`from` は画面 URL ではなく `/_serverFn/...` になる。ログイン後にそこへ戻され、POST 専用の server function を GET で叩く形になる。
  - 同一オリジンのパスなのでオープンリダイレクトではなく、`toSafeRedirect` も通る。実害は「ログイン後に真っ白な画面 / 405 に飛ぶ」という UX 劣化。
  - 提案: `/_serverFn` 等のフレームワーク内部パスを `toSafeRedirect` の拒否リストに入れるか、`requireUserId()` に呼び出し側が復帰先を渡せるオーバーロードを設ける。

- **[W-011]** セッション Cookie に `__Host-` プレフィックスがない
  - 場所: `apps/web/app/presentation/sessionCookie.ts:12`
  - 理由: 現状の属性セット（`Path=/` / `Secure`（本番）/ `Domain` 指定なし）は `__Host-` の要件を**すでに満たしている**ので、名前を `__Host-fog_session` にするだけでサブドメインからの Cookie 上書き（cookie shadowing / セッション固定の亜種）をブラウザ側で強制できる。今は同一サイト上の別サブドメインに XSS があると `fog_session` を上書きできてしまう。
  - 提案: 開発時に `Secure` が付かない（`__Host-` は `Secure` 必須）ため、名前も `import.meta.env.PROD` で切り替える必要がある。それを嫌うなら「開発でも常に `Secure` を付け、`localhost` は例外的に Secure Cookie を許容するブラウザ挙動に乗る」という手もある（Chrome / Firefox は `http://localhost` でも Secure Cookie を受け入れる）。後者のほうが**開発と本番で属性セットが揃う**という副次的な利点もある。

### Notes

- **[N-001]** PBKDF2 のパラメータは現代的な水準にある。反復回数 210,000（OWASP 2023 の PBKDF2-HMAC-SHA256 推奨値そのもの）、salt 16 byte / `crypto.getRandomValues`、出力 256 bit、アルゴリズム識別子を含む自己記述的エンコード（`pbkdf2-sha256$<iterations>$<salt>$<hash>`）。`parse()` は 4 フィールドちょうど・識別子一致・`iterations >= 1` の整数を要求し、いずれの逸脱も `DataIntegrityError` にする（`pbkdf2PasswordHasher.ts:59-94`、テストで5パターン表明）。**反復回数を環境変数にしなかった判断（ADR-003）はセキュリティ的に正しい** — 環境ごとに強度が揺れる設定は「どのハッシュがどの強度か」を運用から見えなくする。

- **[N-002]** `verify` の契約が正しい。不一致は例外ではなく `false`（`pbkdf2PasswordHasher.ts:139` → `timingSafeEqual`）、計算失敗だけが `SystemError`。比較は短絡しない XOR 累積（`encoding.ts:32-37`）で、長さ不一致の早期 return もエンコードで長さが固定される以上妥当。テストも「wrong password は throw ではなく false」を明示的に表明している。

- **[N-003]** HMAC セッションの検証順序が正しい。`crypto.subtle.verify`（定数時間比較、長さ不一致で false）→ 成功して初めてペイロードを JSON パース → `uid: string`（非空）/ `exp: number`（有限）を型で絞る → `exp <= now` で期限判定（`hmacSessionCodec.ts:82-103`）。**署名前にペイロードを信用する経路が存在しない**。`alg` フィールドを持たないので JWT 系のアルゴリズム混同（`alg: none`、HMAC/RSA 取り違え）は構造的に成立しない。全拒否パスが `null` を返し、理由が呼び出し側に漏れないのも良い。クロックは `container.clock.now()`（サーバー時刻）で、クライアント由来の時刻は一切見ていない。

- **[N-004]** 秘密鍵をネスト構造で隔離した設計（ADR-002 / `di/secrets.ts:1-14`）は、この PR で一番良い判断。「`satisfies` を変数に対して書くと余剰プロパティ検査が効かない」という TypeScript の穴を正しく理解した上で、**原則ではなく構造で塞いでいる**。しかも `requestContainerConfig.test.ts` は「既知の漏出候補を含まないこと」ではなく「キー集合が `AppConfig` と完全一致すること」を4ランタイム分表明しているので、**今後どんな秘密を足しても自動的に検出される**。回帰テストとして十分。

- **[N-005]** AWS の秘密鍵配布（ADR-015）が適切。ARN だけを `appFn.environment` に載せ（`appStack.ts:180`）、`sharedEnv` には入れないので relay / consumer / pruner / dlq の4 Lambda には配られない。`sessionSecret.grantRead(appFn)`（`:268`）のみで IAM も最小権限。値が CloudFormation テンプレートにも Lambda コンソールにも平文で残らない。GCP 側も `sensitive = true`（`variables.tf:36`）で app サービスのみに付与（`main.tf:43`）。CF は `[vars]` ではなく `.dev.vars` / `wrangler secret put`（`.dev.vars.example:74-79`）。**4ランタイムすべてで「秘密として扱われている」**。

- **[N-006]** `PlainPassword` の漏出は ADR-011 の判断（型では守らない）どおりテストとレビューに委ねられているが、コードを追った限り**実際に漏れていない**。イベントペイロードは `{ userId, authMethod }` のみ（`domain/identity/events.ts:9`）、`CurrentUserView` は4フィールド固定で `passwordHash` も SSO subject も持たない（`application/identity/view.ts:12-17`）、`users` テーブルに平文列がない（`0000_initial.sql`）、`PlainPassword.create` のエラーメッセージは長さ制約のみで値を含まない（`valueObject.ts:81`）、`errorResponseMiddleware` が logger に渡す `cause` は WebCrypto / driver の例外で入力を含まない、フォームは POST body で URL に載らない。ADR-011 の「型で守れないものを守れているふりをしない」という姿勢自体も支持できる。

- **[N-007]** オープンリダイレクト検証（`redirectSearch.ts:21-32`）を実際に攻撃ベクタで潰した結果。`validateSearch`（`login.tsx:20`）と `toSafeRedirect`（`currentUser.ts:41` / `_app.tsx:25`）の**両方**が同じスキーマを共有しているので、片方だけ緩いという事故が起きない。

  | 入力 | 判定 | 根拠 |
  |---|---|---|
  | `//evil.example` | 拒否 | `startsWith("/")` は通るが `includes("//")` |
  | `https://evil.example` | 拒否 | `startsWith("/")` |
  | `/\evil.example` | 拒否 | `includes("\\")` |
  | `/%2f/evil.example` | 拒否 | `startsWith("/%2f")` |
  | `/%2F%2Fevil.example` | 拒否 | `startsWith("/%2F")` |
  | `/%252f%252fevil.example` | 拒否 | 1回デコードされて `/%2f...` になり同上 |
  | `%2F%2Fevil.example` | 拒否 | デコードで `//evil.example` |
  | `/%09//evil.example` | 拒否 | `includes("//")` |
  | `/settings?x=1` | 許可 | 同一オリジンのパス |

  さらに `redirectSearchSchema` が `.catch(undefined)` なので、不正値はルートを 500 にせず「リダイレクトなし」に**フェイルクローズ**する（`:35`）。`_app.tsx:25` で `location.href` 全体を通しているため、現在 URL のクエリに `//` が含まれるだけで復帰先が落ちるが、これも安全側。

- **[N-008]** 認可ガードの権威点の置き方が正しい。`_app.tsx:20-21` のコメントが「これはセキュリティ境界ではない。クライアントサイド遷移ではブラウザで走る」と明記し、`currentUser.ts:31-35` が「すべてのサーバー実行地点が自分で `requireUserId()` を呼ぶ」と宣言している（ADR-005）。実装もそのとおりで、保護データを読む地点は `CurrentUserPanel`（`:22`）と `logoutFn`（`action.ts:9`）の2箇所しかなく、**両方が `requireUserId()` を通っている**。`/_app/` 配下の他4ルートは現状プレースホルダでサーバーデータを読まないため、ガード漏れの影響もない。

- **[N-009]** `logoutFn` / `getCurrentUser` がリクエスト元セッションを正しく信頼している。どちらも `userId` を**クライアント入力から受け取らない** — `logoutFn` は引数なしで `requireUserId()` の戻り値を使い（`LogoutButton/action.ts:9,14`）、`getCurrentUser` も `CurrentUserPanel:22` の `requireUserId()` 由来。`getCurrentUser` の JSDoc（`:18-19`）が「`userId` は検証済みセッション由来であってリクエストボディではない」と契約として明記している。**他人の userId を渡して他人の情報を読む経路は存在しない**。

- **[N-010]** ログアウト時の Cookie 失効が正しい。`buildSessionCookie(null, ...)` は空値 + `Max-Age=0` を**発行時と同一の属性セット**（`Path=/` / `HttpOnly` / `SameSite=Lax` / `Secure`）で返す（`sessionCookie.ts:30-47`）。属性が一致しないとブラウザが元の Cookie を落とさないという点まで理解されていて、テストが「発行時と失効時の属性差分がゼロ」「明示 `maxAgeSeconds` が失効側に漏れない」を表明している（`sessionCookie.test.ts:58-77`）。トークン値は `encodeURIComponent` されるので `;` / `=` による Cookie 値の脱出も塞がっている（`:39`、テスト `:26`）。

- **[N-011]** エラーの redaction が新しいエラー種別でも効いている。`redactForClient` は `kind` ベースの構造判定（`errorResponse.ts:91-96`）なので、`SystemErrorCode.SessionError` / `CryptoError` を足しても自動的に `code: null` / `"System error"` に潰れる。`SerializedErrorKind` は `satisfies Record<SerializedErrorKind, true>`（`:50`）で網羅性が型検査され、`httpStatusFor` も `Record<SerializedErrorKind, number>` なので**kind を足して redaction / status のどちらかを書き忘れると型エラーになる**。`ValidationError` の `toSerialized()` も `cause` を含まない。`sanitizeRouteError`（`errorDisplay.ts:88-95`）は `unknown` を定数メッセージへ落とすので、ルートエラー境界からも内部詳細が出ない。

- **[N-012]** 入力検証の二段構えが spec どおり。transport 境界（`auth/schema.ts:18-21`）は `AUTH_FIELD_MAX_LENGTH = 1024` の DoS ガードのみで、意味を持つ長さ（パスワード 8〜128、メール 320）は VO 側に置かれている。その理由（129文字のパスワードを transport の `validation` にすると利用者に誤った説明をすることになる）が JSDoc に書かれていて、判断として妥当。**上限 1024 も適切** — PBKDF2 は bcrypt のような 72 byte 制限を持たないので、`PlainPassword` の 128 文字上限（`valueObject.ts:6`）はハッシュ関数の入力制限とは独立に決めてよく、実際 128 文字（UTF-16 単位。最悪 512 byte）が KDF に渡っても問題ない。`PlainPassword.create` は login / register の**両方**で走るので、1024 と 128 の間の値が KDF に到達する経路もない。

- **[N-013]** ログイン失敗メッセージが UI 上でも1本化されている。`INVALID_CREDENTIALS` は `FIELD_BY_CODE`（`auth/errorField.ts:16-20`）に載っていないため email / password のどちらのフィールドにも紐づかず、必ずフォーム上部のバナーに「メールアドレスまたはパスワードが正しくありません」として出る（`errorDisplay.ts:39-41`）。**どちらが間違っているかを UI 側で暗示してしまう**という、この手のフォームでよくある取りこぼしがない。

- **[N-014]** 登録時の重複エラー（`EMAIL_ALREADY_REGISTERED` + ログイン導線、`errorField.ts:51`）がユーザー列挙を許すのは、`spec/scenario/account.md:11`「既に登録済みのメールアドレスの場合、その旨が表示され、ログインへの導線が示される」の**明示的な要求**であり、spec の意図と整合している。ADR-008 の「事前チェックに負けた並行登録も同じ答えを返す」処理も、レースの勝敗で応答が変わらないという点で一貫性がある。`registerWithPassword.ts:66-74` の「この読み替えが安全なのは、この UoW が書くのが users 1行 + outbox 1行だけで、他の一意制約が絡まないから」という条件付けが明記されているのも良い（条件が崩れたら translation を消せ、と書いてある）。

---

## 補足: 攻撃シナリオの検討

以下は「実際に成立するか」をコードで追った結果の記録。

**シナリオA: 署名済み Cookie の偽造でなりすます** — 不成立。`SESSION_SECRET`（32文字以上必須）を知らずに HMAC-SHA256 を通すことはできず、payload 改ざんは署名検証で落ちる（`hmacSessionCodec.test.ts:32-45` が表明）。期限だけを延ばす改ざんも同様（`exp` は署名対象に含まれる）。

**シナリオB: 他人の userId で `getCurrentUser` を呼ぶ** — 不成立。`getCurrentUser` を呼ぶ経路は `CurrentUserPanel` のみで、`userId` は `requireUserId()` の戻り値に固定されている。server function の入力として `userId` を受け取る口が存在しない。

**シナリオC: クライアントガードを迂回して保護データを読む** — 不成立。`_app.tsx` の `beforeLoad` を無視して `/_serverFn/...` を直接叩いても、`renderSettings` → `CurrentUserPanel` → `requireUserId()` がサーバー側で走る。

**シナリオD: ログアウト後に戻るボタンで保護画面を見る** — ルーターキャッシュ経由は不成立（`staleTime: 0` + `invalidate()` + `replace: true`）。HTTP キャッシュ / bfcache 経由は W-005 のとおり未対策だが、そこから**追加のリクエストは一切通らない**（Cookie は既に消えている）ので、見えるのは自分自身の直前の画面のスナップショットのみ。共有端末シナリオでのみ問題になる。

**シナリオE: クロスサイトからログアウトさせる / 操作させる** — 不成立。`SameSite=Lax` で Cookie が乗らず、JSON body のサーバー関数はプリフライトを要求する（W-004）。

**シナリオF: `?redirect=` で外部サイトへ飛ばす** — 不成立（N-007 の表を参照）。

**シナリオG: エラー応答から内部構造を推測する** — 不成立。`system` / `unknown` は単一の `"System error"` に潰れ、`code` も `null` になる。スタックは `AppServerError` で削除済み。DB のドライバメッセージ（`UNIQUE constraint failed: users.email` 等）は `ConflictError` の `cause` に入るが `toSerialized()` が `cause` を出力しないのでクライアントへは届かない。

**シナリオH: 応答時間でアカウントの有無を判定する** — **成立**（W-001）。ただし signup 側の重複エラーで同じ情報が正面から取れるため、攻撃者の能力を実質的に増やしていない。

**シナリオI: 未認証リクエストで CPU を枯渇させる** — **成立**（W-003）。`/signup` を叩き続けるだけで 1リクエスト = 210k 回の PBKDF2。
