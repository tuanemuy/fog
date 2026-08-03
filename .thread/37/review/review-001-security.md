# Security

PR #49 / base `main` / 契約: `.thread/37/plan.md`（AC-3 / AC-4 を主軸に確認）

## Blockers

- **[B-001]** パスワードリセットトークンの保存形式が「DB 漏えい時に使えない」という主張を満たしていない。`token_hash` が **同じ行に平文で並んでいる `token_id`** から導かれているため、行を読めた者はそのまま消費できる。
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:21-40`（`tokenHash`）/ `:58-82`（`issue` が `token_id` と `tokenHash(token_id)` を同じ行へ書く）/ `:84-104`（`verifyAndConsume` が `token_hash = tokenHash(引数)` で照合）、`packages/core/src/adapters/cloudflare/schema/identityDirectory.ts:53-65`（`token_id TEXT PRIMARY KEY` と `token_hash TEXT NOT NULL`）、`packages/core/src/domain/identity/ports/passwordResetTokenPort.ts:23-24`（「The raw token is never stored … so a database leak yields no usable link」）
  - 理由: 攻撃シナリオは2段ある。
    1. **平文併存による直接消費。** `issue()` は `token_id`（128bit 乱数）を **PK 列にそのまま**書き、`token_hash` にはその FNV-1a を書く。`verifyAndConsume(token)` は `tokenHash(token)` で引くので、**`token_id` 列の値をそのまま提出すれば必ず一致する**。バックアップ・PITR エクスポート・`sqlite_master` 経由のダンプなど「読みだけ」の漏えいで、生きている全リセットリンクがそのまま使える。`sendMail.ts:27-30` が謳う「dump lacks the key」は、リンクの *表示形* に対しては真だが、**照合経路は鍵を一切参照しない**ので防御になっていない。`resetTokenStore.ts:45-47` と `passwordResetTokenPort.ts:23-24` の JSDoc はどちらもこの点で事実に反しており、#12 の実装者はこの記述を根拠に安全性を仮定する。
    2. **FNV-1a-64 の第二原像。** 仮に 1. を塞いでも、`tokenHash` は鍵無し・64bit・各ステップが可逆（`h = (h ^ c) * 奇数素数`）な非暗号学的ハッシュで、しかも入力長も文字種も制約されていない（`charCodeAt` は 0..65535 を素通し）。`token_hash` を1つ知れば meet-in-the-middle で衝突入力を現実的な計算量で作れ、`prt_token_hash_uq` が1行に確定させるため「他人のトークンを1件狙い撃ちで消費する」に直結する。`verifyAndConsume` の戻り値は `userId` + `changeAuthToken`（＝クレデンシャル変更の唯一の束縛）なので、成立すればアカウント乗っ取りである。
    - 「同期ポートだから WebCrypto が使えない」は理由にならない。**同じ制約を同じリポジトリが別の場所で解いている** — `reserveCredential` は WebCrypto の封緘を `run()` の外（非同期な RPC エントリ）で済ませ、結果を値としてトランザクションへ渡している（`apps/web/app/durable-objects/identityDirectory.ts:92-109`、`identityDirectory/facade.ts:193-198`、`canonicalCipher.ts:140-164`）。
  - 提案: `requestPasswordReset` の RPC エントリ（`identityDirectory.ts:156-164`）を `reserveCredential` と同じ形にし、**エントリ側（非同期）で導出まで済ませてから同期ポートへ値で渡す**。具体的には
    1. エントリで `tokenId = 128bit 乱数` を生成し、`emitted = HMAC(IDENTITY_RESET_TOKEN_KEY[active], tokenId)`（`sendMail.ts:109-138` と同一の導出）と `hash = SHA-256(emitted)` を `crypto.subtle` で計算する。
    2. `PasswordResetTokenPort.issue(credentialId, tokenId, tokenHash, now)` へ契約を変え、行には `token_hash = SHA-256(emitted)` を書く。`verifyAndConsume(emitted, …)` は受け取った値の SHA-256 で引く（これも非同期エントリ側でダイジェスト化して同期ポートへ primitive で渡す）。
    3. これで (a) 行から `emitted` は再現できない（鍵が要る）、(b) `token_id` を提出しても一致しない、(c) 照合ハッシュが暗号学的、の3つが同時に成立する。
    4. 4ケース（登録済み / 未登録 / SSO 専用 / スロットル中）の一様性を壊さないよう、**導出はエントリで無条件に実行し、不適格なら結果を捨てる**こと。
    - 併せて `resetTokenStore.ts:45-47` と `passwordResetTokenPort.ts:23-24` の「生トークンは保存しない」という記述を、実際の保証（何が鍵で守られ、何が行に残るか）へ書き直す。`spec/database/index.md:627` / `:649` も同じ言い方をしているので、spec 側の訂正が要る。

- **[B-002]** ジョブランナーが `operation_key` と生の例外をそのままログへ出す。`send-mail` の `operation_key` は **canonical アドレスの完全長 HMAC を含む**ので、AC-3 の「HMAC がログに出ない」に真正面から違反している。
  - 場所: `packages/core/src/adapters/cloudflare/jobs/runner.ts:109-114`（`logger.error("job failed", { operationKey: row.operation_key, …, cause: error })`）、生成側は `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:335-341`（`operationKey: \`send-mail:${kind}:${hmac}\``）
  - 理由: AC-3 は「canonical / HMAC / locator / `passwordVerifier` / `callerToken` / `changeAuthToken` / リセットトークンが**ログ**・エラー・URL に出ない」を受け入れ条件にしている。`send-mail` が1回失敗するたびに、その利用者のメールアドレスの HMAC がログへ落ちる。HMAC は `lib/directoryLocator.ts:14-15` 自身が「**identity** — it is what a mapping row is keyed by」と書いている値で、行の主キーそのものであり、利用者を跨いで安定した擬似識別子である。ログ基盤（Workers Logs / 転送先 SIEM）は DO の信頼境界の外なので、そこへ出た時点で「bucket の外で canonical 由来の識別子を持たない」という設計上の性質が崩れる。
    さらに `cause: error` は例外オブジェクトをまるごと渡している。**同じファイルの `terminalReasonFor`（`runner.ts:40-45`）が「an arbitrary error string can contain a canonical address, an hmac, a locator, a caller token or a reset token」と明記して message を捨てている**のに、その 60 行下でその message をログへ流している。同一ファイル内で矛盾している。
    そしてこの穴はテストで意図的に見逃されている — `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts:296-299` が「The logger is a different matter … so only `terminal_reason` is asserted clean」とコメントして `lines` を `assertNoForbiddenValue` に掛けていない。AC-3 の検証手段（禁止語配列を一巡させる）が、実際に漏れている経路だけを除外している。
  - 提案:
    1. ログに出す識別子を `operation_key` から **`kind` + `operation_key` のハッシュ（もしくは `attempt` と `kind` だけ）** に変える。相関が必要なら、`operationKey` を SHA-256 して先頭 8byte だけ出す「相関 ID」を別に持たせる（ログ間の突き合わせには十分で、HMAC の復元にはならない）。
    2. `cause: error` を `terminalReasonFor(error)` と同じ射影（`name:code`）に落とす。生 message が要るなら、`ApplicationError` の `code` 以外を出さない allowlist にする。
    3. `runner.integration.test.ts` の当該ケースで `lines` も `assertNoForbiddenValue` に掛ける。あわせて `FORBIDDEN_VALUES` に「`send-mail:email:<hmac>` 形の operationKey」を入れて、除外ではなく検知にする。

## Warnings

- **[W-001]** `verifyAndConsume` の契約が、実際にメールされる値と噛み合っていない（B-001 の裏面）。
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts:84-104` と `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts:109-138`
  - 理由: 利用者が受け取るのは `{routingGen}.{bucket}.{HMAC(key, token_id)}` である。一方 `verifyAndConsume(token)` は `tokenHash(token)` で引くので、一致するのは `token === token_id` のときだけ。`token_id` から `emitted` へは一方向なので、**メールの値からは絶対に行へ辿り着けない**。`consume-reset-token` は #12 送りなので現時点では到達しないが、契約としては「誰も満たせない引数」を持ったまま出荷される。#12 の実装者が素朴に配線すると (a) 常に `null`（fail-closed なので事故にはならないが機能が死ぬ）か、(b) 「`token_id` をそのままメールする」方向へ直して B-001 を顕在化させる、のどちらかになる。
  - 提案: B-001 の修正と同時に契約を確定させる。修正しないまま #12 へ送るなら、少なくとも `PasswordResetTokenPort` の JSDoc に「`token` は `token_id` であり、メールされる値ではない。両者を繋ぐ導出は未実装」と明記する。

- **[W-002]** `SEND_MAIL_EMPTY_RETENTION_MS` が未使用で、リセットメールの再送が事実上 24 時間封鎖される。
  - 場所: `packages/core/src/lib/jobBudgets.ts:37-42`（定義。参照は 0 件）、`packages/core/src/adapters/cloudflare/jobs/runner.ts:158-164` と `jobs/table.ts:308-335`（prune は `DONE_RETENTION_MS` = 24h を一律に使う）、`jobs/table.ts:108-123`（`send-mail` は `REARMING_KINDS` に無いので `done` 行は再投入を弾く）
  - 理由: 「`done` 行が残っている間は再投入を弾く」ことでバースト増幅と列挙オラクルを同時に塞ぐ設計は正しい。ただし窓が意図（15 分）の 96 倍になっている。メールが届かなかった／リンクを失った利用者は 24 時間リセットできず、しかも応答は成功と区別できないので気づけない。`RESET_THROTTLE_MS`（60 秒、`facade.ts:349`）はトークン発行だけを律速していて、この窓には効かない。可用性の劣化がそのままアカウント回復不能に繋がるので、セキュリティ観点で見る価値がある。
  - 提案: `pruneCompleted` に kind 別保持を入れるか、`send-mail` の `done` 行を「recipient なしで終わったか否か」で保持時間を分ける。どちらを選ぶにせよ、**保持時間が結果に依存すると列挙オラクルになる**ので、`send-mail` は結果によらず一律 `SEND_MAIL_EMPTY_RETENTION_MS` にするのが安全（送った場合も送らなかった場合も 15 分で再送可能）。

- **[W-003]** `enqueueJob` の競合エラーメッセージが `operationKey` を埋め込み、`conflict` は `redactForClient` の対象外なのでクライアントへ到達しうる。
  - 場所: `packages/core/src/adapters/cloudflare/jobs/table.ts:126-131`、`apps/web/app/presentation/errorResponse.ts:86-96`（`system` / `unknown` のみ redact）
  - 理由: `send-mail` の `operationKey` は HMAC を含む。現状は payload が `operationKey` の関数（`{kind, hmac}`）なので `payload_digest` が食い違うことはなく到達不能だが、これは「たまたま」であって構造ではない。`jobs.kind` を1つ足して payload に可変値を入れた瞬間に、HMAC がブラウザまで届く。
  - 提案: メッセージから `operationKey` を落とし（`code` に `kind` だけ載せる）、あるいは `redactForClient` の対象を「`system` / `unknown`」ではなく「クライアントに見せてよい code の allowlist」へ反転させる。

- **[W-004]** `requestPasswordReset` が active 世代の locator しか見ない。ローテーション中は previous 世代 bucket にしか行の無い利用者がリセット不能になる。
  - 場所: `packages/core/src/application/identity/requestPasswordReset.ts:31-39`（`const locator = locators[0]`）
  - 理由: `loginWithPassword.ts:118-149` は `locators` を全世代走査し、`signupSaga.ts:209-223` も previous 世代を照会している。リセットだけが active 固定なので、鍵ローテーション中（`.adr/012` / #44 の想定）に「ログインはできるがリセットはできない」利用者が生まれる。しかも応答は4ケースで同一に設計されている（それ自体は正しい）ため、**当人にも運用にも観測できない**。回復経路の静かな喪失なので、可用性ではなくセキュリティの問題として扱うべき。
  - 提案: `loginWithPassword` と同じく全 locator を走査し、最初に「行があった」bucket へ投げる。一様性を保つため、行の有無で走査回数が変わらないよう **全 locator に対して常に `requestPasswordReset` を送る**（各 bucket が無条件に1行書くので、これでも4ケースの観測は一致する）。

- **[W-005]** AC-3 の非露出テストが、実際に漏れうる経路を検査していない。
  - 場所: `packages/core/src/application/di/__tests__/routingNonExposure.test.ts:101-127`、`packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts:13-25`
  - 理由: 3点ある。(i) 禁止語配列の locator 値は `"dir:g1:b0042"` だが、テストが実際に導出する `doName` は `bucketCount: 256` の `dir:g1:b{0..255}` なので、この語は**構造的に一度も一致しない**（＝locator の検査は空振りしている）。(ii) テストは実 `doName` を明示的に haystack から除外している（`:125`）ので、locator がログへ出ても落ちない。(iii) 禁止語配列の HMAC 値は固定文字列で、テストが導出する実 HMAC とは別物。結果として、この unit テストが実質検証しているのは「canonical 文字列そのものが出ないこと」だけである。B-002 がテストを素通りしたのはこの弱さの帰結。
  - 提案: 「固定の禁止語が含まれないこと」ではなく「**その実行で導出された `canonical` / `hmac` / `doName` の実値が含まれないこと**」を assert する形に変える（実値を配列に足してから `assertNoForbiddenValue` を掛ける）。ジョブランナーのログ経路（B-002）とメール送信経路も同じヘルパで一巡させる。

- **[W-006]** `activateReservation` だけが `callerToken` を検証せず、`operation_id` の一致だけで `user_id` を書き込む。束縛の強さがエントリ間で不揃い。
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts:100-118`、対比: `:120-151`（`cancel` は `matchOpaque(caller_token)`）、`packages/core/src/adapters/cloudflare/userData/facade.ts:315-327`（`recordCredentialLocator` は `matchCallerToken`）
  - 理由: `userData/facade.ts:311-314` が **その理由を自分で書いている** — 「The binding is `callerToken`, not `operationId`: the design permits `operationId` in unauthenticated logs, so binding a write to knowledge of it alone would turn a logged value into a capability」。`activateReservation` はまさにその形で、`operationId` を知るだけで予約行を任意の `userId` へ昇格できる。DO stub が合成ルート限定である以上、外部からは到達できないので Blocker ではないが、「到達不能だから弱くてよい」を1箇所だけ採ると、#12 / #45 で経路が増えたときにここだけが穴として残る。
  - 提案: `activate` の述語に `caller_token` の `matchOpaque` を足す（`activateReservation` の引数に `callerToken` を追加し、saga はすでに持っている）。加えて `user_id = ?` を `candidate_user_id` との一致条件にすると、`operationId` が合っても別の `userId` へは昇格できなくなる。

- **[W-007]** `listBucketUserIds` が migration gate の外にあり、bucket 内の全 `userId` を列挙できる RPC として facade 型にも載っている。
  - 場所: `apps/web/app/durable-objects/identityDirectory.ts:173-199`、`packages/core/src/application/di/facades.ts:93-97`
  - 理由: `readSchemaVersion` と並べて「オペレータ診断」とされているが、返す値の性質が違う。`readSchemaVersion` は整数1つ、こちらは **その bucket に属する利用者 ID の全数**（`limit` は 1..1000 に丸めるだけで、`cursor` でページングして全走査できる）。`userId` は `signupSaga.ts:22-25` 自身が「an attacker who learned somebody's `userId` … could then write into their Durable Object without authenticating」と書いている値であり、それを bucket 単位で吐く口である。呼び出し元が合成ルート限定なので現状は安全だが、gate の外＝fail-closed の DO でも応答する口なので、防御の層が1枚少ない。
  - 提案: 最低限 `facades.ts` の `IdentityDirectoryFacade` から外し（合成ルートが握る型に載せる必要はない）、DO クラス側にだけ残す。可能なら運用トークン（`StateEnv` の秘密）による束縛を付けて #38 へ引き継ぐ旨を JSDoc に書く。

- **[W-008]** `Email.create` の非 ASCII ドメイン経路が、ポート・パス・クエリを **拒否ではなく黙って切り捨てる**。
  - 場所: `packages/core/src/domain/identity/valueObject.ts` の `toAsciiDomain`（`new URL(\`http://${domain}\`).hostname`）
  - 理由: 構造チェック `^[^\s@]+@[^\s@]+$` は `:` `/` `?` を通すので、`a@日本.com/x` `a@日本.com:8080` はいずれも `a@xn--wgv71a.com` に潰れる。canonical は「一意性の権威の入力」かつ「リセットメールの宛先」なので、**入力とアドレスの1対1が崩れる位置**である。方向としては merge（分裂ではない）なので直ちに乗っ取りにはならず、そもそも署名時のアドレス所有確認が無い（設計上の既知）ため新たな穴とは言えないが、「境界で検証する」原則からは切り捨てではなく拒否が正しい。
  - 提案: `toAsciiDomain` の中で、`URL` から取り出した `hostname` が入力の `domain` と一致しない場合は `invalidEmail` を投げる（`port` / `pathname !== "/"` / `search` が空でない場合も同様）。

## Notes

- **[N-001]** 秘密の配布境界（request 側3本 / state 側2本）は**4箇所すべてで非重複が一貫している** — 型（`application/di/secrets.ts:20-29`）、env 宣言（`serverCloudflare.ts:46-58` / `stateCloudflare.ts:30-38`）、デプロイ用 `.tpl`（`wrangler.request.*.tpl` / `wrangler.state.*.tpl` の手順欄）、`.dev.vars.example`。`DIRECTORY_ROUTING_SECRET` を state 側へ渡さないことが「bucket が自分の名前をアドレスから再構成できない」という性質の担保である、という理由も4箇所すべてに書かれている。`RequestSecrets` / `StateSecrets` をネストして rest-spread での流出を構造的に封じている点（`secrets.ts:3-19`、`serverCloudflare.ts:137-140`）も良い。`.dev.vars.example` に実鍵は入っておらず、全項目が空。ローカルだけ境界が崩れる点も明示されている。
- **[N-002]** AC-4 は実測で満たされている。`grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app | grep -v '/__tests__/'` の一致は `application/di/serverCloudflare.ts:148` と `:158` のみ。`userDataStubFactory` / `directoryStubFactory` の呼び出し点は5モジュール12箇所で、いずれも引数は**検証済みセッション由来の `userId`**（`getCurrentUser.ts:25-29`）か **`directoryLocator.forCanonical` の出力**（`loginWithPassword.ts:118`、`requestPasswordReset.ts:31`、`signupSaga.ts:83`）か **サーバ採番の `userId`**（`signupSaga.ts:68,143`）であり、外部入力が `doName` / `userId` に到達する経路は無い。
- **[N-003]** 冪等性キーの出自は正しい。`operationId` / `userId` / `callerToken` / `credentialId` はすべて `container.idGenerator.next()`（`signupSaga.ts:67-76`）、`providerIdempotencyKey` は `operationKey` から決定的（`facade.ts:340`、`sendMail.ts:223`）。クライアント由来の冪等キーを受け取る口は存在しない。`signupSaga.ts:16-27` の「なぜクライアント由来にできないか」の記述（`idFromName` の引数になる）は的確。
- **[N-004]** `canonicalCipher.ts` の AES-256-GCM の使い方は妥当。nonce は書き込みごとに `crypto.getRandomValues(12)` で新規（`:121`）、専用列に保持して連結しない、AAD は `(kind, credentialId, generation)` で **`hmac` を意図的に外す**（ローテーションで bucket が動いても復号できる／行の入れ替え攻撃は `credentialId` が押さえる）、復号は行が宣言した世代の鍵で行い（`keyMaterial`）失敗は fail-closed（`:171-195`）、鍵未設定は無音の NULL 書き込みではなく `SystemError`（`sealCanonical:140-157`）。任意長の passphrase を SHA-256 で 32byte に広げる点も標準的。
- **[N-005]** セッションは fail-closed。`parsePayload`（`hmacSessionCodec.ts:45-62`）は `typ` / `ep` の欠落を既定値にせず拒否し、`ep` の型・整数性・非負まで見る。MAC 検証は `crypto.subtle.verify` なので定数時間、拒否理由は呼び出し元へ漏れない。失効の権威は DO 側の `requireActiveSession`（`userData/facade.ts:103-119`）にあり、`currentUser.ts:41-50` と `authState.ts` の JSDoc が「cookie 検査は権威ではない」と明記している。`matchOpaque`（`opaqueBinding.ts:28-38`）も NULL / 空を先に落としてから `timingSafeEqual`。
- **[N-006]** 列挙オラクル対策は設計として一貫している。`requestPasswordReset`（`facade.ts:286-343`）は mapping の有無・スロットルの有無によらず **job 行を必ず1行**書き、payload には要求そのもの（`{kind, hmac}`）以外を入れず、`recordResetRequested` はスロットル中でも実行し、`send-mail` 側（`sendMail.ts:140-226`）は4ケースすべて `done` で終える。`reportResult`（`mappingOperations.ts:212-247`）が「行が無くても成功を返す」形なのも同じ理由で正しい。`lookupCredential`（`facade.ts:115-155`）が `status` / `changeState` / スロットルの3条件をまとめて「材料なし」に均す点も適切。B-002 / W-002 はこの設計の実装側の綻びであって、設計そのものへの指摘ではない。
- **[N-007]** SQL injection 面は問題なし。DO 側の SQL 発行は `sql/exec.ts` の 4 関数に集約され全て bind parameter 経由、動的なテーブル名は `trashQuery.ts` の閉じたリテラル tuple のみ、`updateOperation`（`userData/unitOfWork.ts:121-146`）の動的 SET も固定文字列の連結。FTS5 の削除も特殊コマンド構文（`search/projection.ts:54-62`）で、`MATCH` / `instr()` は正規化後の値を bind している。`assertBindings` のエラーメッセージにクエリ本文が載るが、クエリは全て静的文字列なので PII は含まない。
- **[N-008]** `sendMail.ts:190` の `logger.warn("password reset mail has no recoverable recipient")` が `userId` すら出さない理由を「unauthenticated flow だから」と書いている点、`createNoopMailSender`（`mailSender.ts:69-78`）が宛先を出さない点、`createBindingMailSender` が失敗時に status だけを出しレスポンス body を出さない点（`:50-58`）は、いずれも AC-3 の趣旨に沿っている。B-002 との落差が大きいだけに、ランナー側を揃えれば全体が締まる。
- **[N-009]** `StateSecrets` が `application/di/secrets.ts:26-29` と `application/di/stateCloudflare.ts:40-43` に二重定義されている。現状は構造的に同一なので実害は無いが、片方だけに鍵を足すと `registry.ts` が参照する型（前者）と DO が構築する値（後者）が黙って割れる。片方を re-export にすることを推奨。

## カバレッジ

### 確認

- `.github/workflows/ci.yml`
- `.thread/37/plan.md`
- `CLAUDE.md`
- `README.md`
- `apps/web/.dev.vars.example`
- `apps/web/app/components/auth/LoginForm/action.ts`
- `apps/web/app/components/auth/SignupForm/action.ts`
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx`
- `apps/web/app/components/settings/LogoutButton/action.ts`
- `apps/web/app/durable-objects/identityDirectory.ts`
- `apps/web/app/durable-objects/userData.ts`
- `apps/web/app/presentation/authState.ts`
- `apps/web/app/presentation/currentUser.ts`
- `apps/web/app/presentation/errorResponse.ts`
- `apps/web/app/presentation/session.ts`
- `apps/web/app/server.cloudflare.ts`
- `apps/web/app/worker/cloudflare/__tests__/env.d.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/consumer.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/dlq.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/handlers.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/pruner.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/relay.ts`（削除を確認）
- `apps/web/app/worker/cloudflare/state.ts`
- `apps/web/drizzle.config.ts`（削除を確認）
- `apps/web/package.json`
- `apps/web/scripts/render-wrangler.ts`
- `apps/web/vite.config.cloudflare.ts`
- `apps/web/vite.config.state.ts`
- `apps/web/wrangler.production.toml.tpl`（削除を確認）
- `apps/web/wrangler.request.production.toml.tpl`
- `apps/web/wrangler.request.staging.toml.tpl`
- `apps/web/wrangler.staging.toml.tpl`（削除を確認）
- `apps/web/wrangler.state.production.toml.tpl`
- `apps/web/wrangler.state.staging.toml.tpl`
- `apps/web/wrangler.state.toml`
- `apps/web/wrangler.toml`
- `infra/cloudflare/pulumi/resources/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.yaml`
- `infra/cloudflare/pulumi/resources/index.ts`
- `infra/cloudflare/pulumi/routes/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.yaml`
- `package.json`
- `packages/core/package.json`
- `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- `packages/core/src/adapters/cloudflare/directoryLocator.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- `packages/core/src/adapters/cloudflare/jobs/registry.ts`
- `packages/core/src/adapters/cloudflare/jobs/runner.ts`
- `packages/core/src/adapters/cloudflare/jobs/table.ts`
- `packages/core/src/adapters/cloudflare/mailSender.ts`
- `packages/core/src/adapters/cloudflare/platform/envelope.ts`
- `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- `packages/core/src/adapters/cloudflare/platform/stubErrors.ts`
- `packages/core/src/adapters/cloudflare/schema/gate.ts`
- `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts`
- `packages/core/src/adapters/cloudflare/search/normalize.ts`
- `packages/core/src/adapters/cloudflare/search/probe.ts`
- `packages/core/src/adapters/cloudflare/search/projection.ts`
- `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`（削除を確認）
- `packages/core/src/adapters/cloudflare/sql/errors.ts`
- `packages/core/src/adapters/cloudflare/sql/exec.ts`
- `packages/core/src/adapters/cloudflare/sql/occ.ts`
- `packages/core/src/adapters/cloudflare/userData/accountStore.ts`
- `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts`
- `packages/core/src/adapters/cloudflare/userData/facade.ts`
- `packages/core/src/adapters/cloudflare/userData/trashQuery.ts`
- `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts`
- `packages/core/src/adapters/d1/__tests__/env.d.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/helpers.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/setup.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts`（削除を確認）
- `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts`（削除を確認）
- `packages/core/src/adapters/d1/client.ts`（削除を確認）
- `packages/core/src/adapters/d1/migrations/0000_initial.sql`（削除を確認）
- `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json`（削除を確認）
- `packages/core/src/adapters/d1/migrations/meta/_journal.json`（削除を確認）
- `packages/core/src/adapters/d1/pendingBatch.ts`（削除を確認）
- `packages/core/src/adapters/d1/repositories/helpers.ts`（削除を確認）
- `packages/core/src/adapters/d1/repositories/idempotencyStore.ts`（削除を確認）
- `packages/core/src/adapters/d1/repositories/outboxRepository.ts`（削除を確認）
- `packages/core/src/adapters/d1/repositories/userRepository.ts`（削除を確認）
- `packages/core/src/adapters/d1/schema.ts`（削除を確認）
- `packages/core/src/adapters/d1/unitOfWork.ts`（削除を確認）
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts`
- `packages/core/src/application/di/containerStore.ts`
- `packages/core/src/application/di/env.ts`（削除を確認）
- `packages/core/src/application/di/facades.ts`
- `packages/core/src/application/di/secrets.ts`
- `packages/core/src/application/di/serverCloudflare.ts`
- `packages/core/src/application/di/stateCloudflare.ts`
- `packages/core/src/application/di/types.ts`
- `packages/core/src/application/errors.ts`
- `packages/core/src/application/events/buildDecoder.ts`（削除を確認）
- `packages/core/src/application/execution/jobs.ts`
- `packages/core/src/application/identity/eventDecoders.ts`（削除を確認）
- `packages/core/src/application/identity/getCurrentUser.ts`
- `packages/core/src/application/identity/loginWithPassword.ts`
- `packages/core/src/application/identity/registerWithPassword.ts`
- `packages/core/src/application/identity/requestPasswordReset.ts`
- `packages/core/src/application/identity/signupSaga.ts`
- `packages/core/src/application/ports/idGenerator.ts`
- `packages/core/src/application/ports/idempotencyStore.ts`（削除を確認）
- `packages/core/src/application/ports/outboxRepository.ts`（削除を確認）
- `packages/core/src/application/ports/relayTrigger.ts`（削除を確認）
- `packages/core/src/application/rpc/restoreError.ts`
- `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts`（削除を確認）
- `packages/core/src/application/workers/__tests__/outboxPrune.test.ts`（削除を確認）
- `packages/core/src/application/workers/eventRelayWorker.ts`（削除を確認）
- `packages/core/src/application/workers/outboxPrune.ts`（削除を確認）
- `packages/core/src/domain/common/event.ts`（削除を確認）
- `packages/core/src/domain/identity/events.ts`（削除を確認）
- `packages/core/src/domain/identity/ports/credentialMappingStore.ts`
- `packages/core/src/domain/identity/ports/mailSender.ts`
- `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts`
- `packages/core/src/domain/identity/ports/userRepository.ts`（削除を確認）
- `packages/core/src/domain/identity/valueObject.ts`
- `packages/core/src/lib/directoryLocator.ts`
- `packages/core/src/lib/jobBudgets.ts`
- `packages/core/src/lib/jobKind.ts`
- `packages/core/src/lib/passwordHashing.ts`
- `packages/core/src/lib/rpcEnvelope.ts`
- `packages/core/src/lib/secretLengths.ts`
- `spec/database/index.md`

### スキップ

- `.adr/001-integration-tests-single-workers-pool.md` — テストプール構成の ADR で、認可・秘密・PII のいずれにも触れない
- `.adr/003-sqlite-fts5-only-search.md` — 検索エンジン選定の ADR で、索引内容の露出範囲は `projection.ts` 側で確認済み
- `.thread/37/adr.md` — 作業ログ。参照している決定（ADR-016 / 029 / 030 / 036）は各モジュールの JSDoc とコードで実体を確認した
- `.thread/37/steps.md` — 作業手順書で、成果物そのものではない
- `.thread/37/testing.md` — テスト計画のメモで、実際のテスト内容は該当ファイルで確認した
- `apps/web/__tests__/boot.smoke.test.ts` — 起動が例外を投げないことのみを主張するテストで、セキュリティ上の主張を持たない
- `apps/web/app/presentation/__tests__/currentUser.test.ts` — 本体の `currentUser.ts` を直接確認したため
- `apps/web/app/presentation/__tests__/errorResponse.test.ts` — `redactForClient` の実装を直接確認したため
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts` — 境界での redact 適用は `errorResponse.ts` 側で確認したため
- `apps/web/app/presentation/__tests__/session.test.ts` — codec 本体（`hmacSessionCodec.ts`）を直接確認したため
- `docs/backend_implementation_example.md` — 旧構成の例に警告ブロックを足すだけの変更で、実行経路を持たない
- `docs/test.md` — テスト構成の説明文書で、実行経路を持たない
- `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts` — Alarm 起動セマンティクスの検証で、本体（`alarm.ts` / `rpcEntry.ts`）を直接確認したため
- `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts` — テスト環境のバインディング疎通確認
- `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts` — テストハーネス。プロダクション経路に載らない
- `packages/core/src/adapters/cloudflare/__tests__/env.d.ts` — 型宣言のみ
- `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts` — `envelope.ts` / `restoreError.ts` を直接確認したため
- `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts` — `mailSender.ts` を直接確認し、非露出 assert の有無も grep で把握したため
- `packages/core/src/adapters/cloudflare/__tests__/setup.ts` — テスト間クリーンアップのみ
- `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts` — `stubErrors.ts` を直接確認したため
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts` — SSO 読み経路の検証で、canonical 組み立てと `lookupCredential` の本体を直接確認したため
- `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts` — 鍵ローテーション進捗の記録のみで、移送経路は #44。列構成は DDL 側で確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts` — Alarm の再武装検証で、観点外
- `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts` — sweep 系ジョブの動作検証で、ハンドラ本体を直接確認したため
- `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts` — 保持期限の2フェーズ検証で、観点外
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts` — kind と所有 DO の全数検証で、観点外
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts` — 型レベル検証のみ
- `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts` — 収束規則・CAS の検証で、本体（`table.ts`）を直接確認したため
- `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts` — fail-closed の検証で、`gate.ts` を直接確認したため
- `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts` — migration 適用の検証で、観点外
- `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts` — 現時点で bulk step は空で、実行される変換が存在しない
- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts` — `jobs` テーブルの DDL のみ。列の意味は `table.ts` 側で確認した
- `packages/core/src/adapters/cloudflare/schema/types.ts` — migration step の型定義のみ
- `packages/core/src/adapters/cloudflare/schema/userData.ts` — User Data DO の DDL。秘密・認証material を持つ列が無く、テナント分離は構造側で担保される
- `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts` — 正規化関数の検証で、観点外
- `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts` — 索引整合の検証で、観点外
- `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts` — tokenizer 実測の検証で、観点外
- `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts` — OCC の誤帰属検証で、`occ.ts` を直接確認したため
- `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts` — 保持日数など非機密の設定のみを扱い、認可は facade 側の epoch ガードが持つ
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — codec 本体を直接確認したため
- `packages/core/src/application/__tests__/helpers.ts` — テストハーネス。プロダクション経路に載らない
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` — 秘密が `container.config` に載らない恒久ガード。本体（`secrets.ts` のネスト）を直接確認したため
- `packages/core/src/application/di/__tests__/secrets.test.ts` — keyring 検証の本体を直接確認したため
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — 削除（対象消滅）
- `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts` — state 側の同形ガード。本体を直接確認したため
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts` — 型レベル検証のみ
- `packages/core/src/application/execution/unitOfWork.ts` — コンテキストの型定義。実際の書き込み口はアダプター側の `unitOfWork.ts` 2本で確認した
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts` — usecase 本体を直接確認したため
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` — 同上
- `packages/core/src/application/identity/__tests__/logout.test.ts` — 同上
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts` — 削除（対象消滅）
- `packages/core/src/application/identity/view.ts` — DTO 射影。露出する項目は `CurrentUserPanel` と `userData/facade.ts` の payload で確認した
- `packages/core/src/application/ports/sessionCodec.ts` — ポートのシグネチャのみ。実装（`hmacSessionCodec.ts`）を直接確認した
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts` — 復元表の本体を直接確認したため
- `packages/core/src/domain/common/transactionalRepository.ts` — 同期契約への変更のみで、認可・秘密に触れない
- `packages/core/src/domain/identity/__tests__/entity.test.ts` — クレデンシャル集合の不変条件の検証で、観点外
- `packages/core/src/domain/identity/__tests__/noRawNul.test.ts` — ソースに生 NUL が無いことの機械検査で、`grep` 破壊の予防が目的
- `packages/core/src/domain/identity/__tests__/valueObject.test.ts` — canonical 化の検証。本体（`valueObject.ts`）を直接確認したため
- `packages/core/src/domain/identity/entity.ts` — 「最後のログイン手段を外せない」不変条件が中心で、到達可能性による分離には関与しない
- `packages/core/src/domain/identity/errorCode.ts` — エラーコードの列挙のみ
- `packages/core/src/domain/identity/ports/accountStore.ts` — ポートのシグネチャのみ。実装を直接確認した
- `packages/core/src/domain/identity/ports/credentialLocatorStore.ts` — 同上
- `packages/core/src/domain/identity/ports/credentialMappingRepository.ts` — 同上
- `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts` — 同上（移送経路は #44）
- `packages/core/src/domain/identity/ports/userSettingsRepository.ts` — 同上。`findById` を持たない設計は `.adr/008` どおり
- `packages/core/src/lib/__tests__/jobKind.test.ts` — kind 全数の検証で、観点外
- `pnpm-lock.yaml` — 依存削除（drizzle 系）に伴う機械生成の更新
- `spec/inventory/adapter.md` — アダプター台帳の更新で、実行経路を持たない
- `spec/manual-tests/search.md` — 手動テスト手順の更新で、実行経路を持たない
- `vitest.config.integration.ts` — テスト実行設定
- `vitest.config.smoke.ts` — テスト実行設定
- `vitest.config.ts` — テスト実行設定
