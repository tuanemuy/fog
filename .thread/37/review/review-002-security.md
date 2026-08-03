# Security（2周目）

PR #49 / base `main` / 契約: `.thread/37/plan.md`（AC-3 / AC-4 を主軸に確認）
1周目の指摘（B-001〜002 / W-001〜008）の修正検証と、修正が新たに作った穴の探索。

## Blockers

なし。

1周目の Blocker 2件（B-001 リセットトークンの保存形式 / B-002 ランナーのログ）は、いずれも実装・テストの両方で解消を確認した。詳細は「1回目指摘の修正検証」に書く。

## Warnings

- **[W-001]** `recordResetRequested` が**不適格な依頼でも無条件に窓を押し戻す**ため、未認証の第三者が窓ごとに1回叩き続けるだけで、被害者のパスワードリセットを恒久的に封じられる。ADR-043 が窓を 60 秒から 15 分へ広げたことで、必要な攻撃レートが 1/15 分まで下がった。
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts:299-316`（`recordResetRequested`、「it must run for a throttled request too, or a caller could hold the window open by retrying」）/ `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:320-322`（`eligible` を見ずに呼ぶ）/ `packages/core/src/domain/identity/credentialMappingRules.ts:84-85`（`lastResetRequestedAt + windowMs <= now`）/ `packages/core/src/lib/jobBudgets.ts:52`（`RESET_REQUEST_WINDOW_MS = 15分`）
  - 理由（攻撃シナリオ）: 攻撃者は被害者のアドレス宛に 14 分おきに `request-password-reset` を投げるだけでよい。行が存在する限り `last_reset_requested_at` が毎回 `now` へ更新されるので、`last + 15分 <= now` は**二度と成立しない**。最初に発行済みのトークン（TTL 2 時間）が切れた後は、被害者がリセットを依頼しても `eligible` が false のままで新しいトークンは発行されず、`send-mail` ジョブは live token を見つけられないので `done` で終わる。**応答は4ケースで同一に設計されている**ため、被害者にも運用にも「封じられている」ことが観測できない。パスワードを失念した被害者はアカウントを回復できない。
    これは机上の設計論ではなく、**同じファイルが 20 行上で真逆の結論を書いている**。`reportResult`（`:279-296`）は「Attempts made while already throttled do not advance the counter — without that, an attacker refreshes the lockout indefinitely」として、スロットル中は `next_attempt_allowed_at` を進めない述語を `WHERE` に入れている。`isResetRequestAllowed` の JSDoc も「the failed-login backoff must not gate recovery, or an attacker could lock a user out of the one path back in」と書いており、まさにその形をリセット側のスロットル自身が作っている。
    現時点では `requestPasswordReset` usecase を呼ぶルート／サーバ関数が無く（`grep -rn requestPasswordReset apps/web` の一致は DO クラスのみ）外部から到達しないので Blocker にはしないが、これは1周目 W-006 と同じ「到達不能だから弱くてよいわけではない」ケースであり、行はこの PR にある。
  - 提案: `reportResult` と同じ形にする — `recordResetRequested` の `UPDATE` に `AND (last_reset_requested_at IS NULL OR last_reset_requested_at + ? <= ?)` を足す。文の数はどのケースでも1本のままなので一様性は損なわれず、「発行できた依頼だけが窓を進める」という ADR-043 の等式（`last + window <= now` ⇒ `floor(now/window) > floor(last/window)`）もそのまま成り立つ。
    あわせて、`facade.ts:320` の `if (mapping !== null)` はこの UPDATE を**未登録アドレスのときだけ丸ごと省く**ので、実行される文の数が登録の有無で変わっている（他の3ケースは1本、未登録は0本）。述語を `WHERE` へ移して**無条件に1本発行する**ほうが、一様性の主張とも整合する。

- **[W-002]** `sweep-reset-tokens` を enqueue するコードが1行も無く、**このジョブは決して走らない**。期限切れ・使用済みのリセットトークン行が bucket に永久に残り、`change_auth_token` が平文で滞留する。
  - 場所: `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`（実装・登録はある）/ `packages/core/src/adapters/cloudflare/jobs/registry.ts:118` / `enqueueJob` 呼び出し点は `identityDirectory/facade.ts:200,207,333`・`userData/facade.ts:149`・`schema/gate.ts:55` の5箇所のみで、`sweep-reset-tokens` はどこからも投入されない
  - 理由: 対になる `sweep-reservations` は `reserveCredential` が同一トランザクションで投入している（`facade.ts:200-205`）のに、`issue` は同じことをしていない。結果として、(i) `verifyAndConsume` が `used_at` / `change_auth_token` を書いた行は誰も消さない。`change_auth_token` は `passwordResetTokenPort.ts:7-12` 自身が「the *only* binding a reset-initiated credential change can present」と書く再利用可能な秘密であり、これが `password_reset_tokens` に平文で無期限に残る。#12 が消費側で失効を掛け忘れると、ダンプ1回で任意の古い行の `change_auth_token` が恒久的な capability になる。(ii) 期限切れ行も残るので `spec/database/index.md` の 10 GB 上限に対して単調増加する。
    有効期限そのものは `verifyAndConsume` の `expires_at > ?` が効かせているので、いま直ちにトークンが使えるわけではない。問題は掃除経路の不在と、平文の `change_auth_token` の滞留である。
  - 提案: `resetTokenStore.issue` と同じトランザクションで `ctx.enqueueJob({ kind: "sweep-reset-tokens", operationKey: "sweep-reset-tokens", payload: {}, nextRunAt: <expires_at> })` を投入する（`sweep-reservations` と同型・bucket ごとに定数キー）。加えて `verifyAndConsume` が `change_auth_token` を書く行に有効期限を持たせるか、#12 へ「消費後に必ずクリアする」を JSDoc で引き継ぐ。

- **[W-003]** リセットメールのリンクに含まれる `{generation}.{bucket}` を、`parseResetToken` が**範囲検査なしの整数**として返し、その値を「消費エンドポイントが bucket を addressing するための座標」と契約している。#12 が素直に配線すると、**未認証・クライアント供給の値が `idFromName("dir:g{n}:b{m}")` へ到達する**。
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts:160-179`（`/^(\d+)\.(\d+)\.([0-9a-f]{64})$/`、`Number()` するだけ）/ `:143-152`（「the consumption endpoint can address the bucket back」）/ `packages/core/src/application/di/serverCloudflare.ts:153-162`（`directoryStubFactory` は `locator.doName` をそのまま `idFromName` へ渡す）
  - 理由: AC-4 の保証は「`idFromName` の呼び出し点が合成ルート1箇所に閉じており、外部入力がそこへ到達する経路が無い」である。いまはその通りで、到達する値は検証済みセッションの `userId` か `forCanonical` の出力に限られる（N-010 で再実測した）。リセット消費は本質的にトークンでルーティングせざるを得ないので、この経路だけが**唯一の例外**になる。範囲検査が無いと、攻撃者は `999999999.999999999.<64桁hex>` のような値を投げるだけで任意個の新規 Durable Object を生成でき、各生成でマイグレーションと `_meta` 書き込みが走る（課金・ストレージの増幅、および fail-closed 判定の実行）。`bucket` は生成ごとの `bucketCount` を超えてはならないが、その数は `DIRECTORY_ROUTING_SECRET` の keyring にしかなく、`parseResetToken` はそれを見ていない。
  - 提案: `parseResetToken` に keyring（もしくは `{generation, bucketCount}` の表）を渡し、`generation` が keyring の宣言に無い／`bucket >= bucketCount` なら `null` を返す。`null` は既に「解析不能なトークンは未知のトークンと同じ」に均されているので、応答の一様性は変わらない。最低でも JSDoc に「戻り値をそのまま DO 名にしてはならない。範囲検査は呼び出し側の責務」と書いて #12 へ引き継ぐこと。

- **[W-004]** `providerIdempotencyKey` が `operationKey` と**同一文字列**なので、canonical アドレスの完全長 HMAC が `Idempotency-Key` ヘッダとして外部のメール送信経路へ出ていく。B-002 で DO のログから消した値が、より外側の境界から出ている。
  - 場所: `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts:342`（`providerIdempotencyKey: \`send-mail:${kind}:${hmac}:${window}\``）/ `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts:218` / `packages/core/src/adapters/cloudflare/mailSender.ts:38-43`（`headers: { "Idempotency-Key": providerIdempotencyKey }`）
  - 理由: CLAUDE.md の非同期実行契約 (3) は「External providers receive a `providerIdempotencyKey` **derived deterministically from** the job's `operationKey`」と書くが、実装は導出ではなく同値である。`MAIL_SENDER` は今はサービスバインディングだが、その Worker の存在意義はプロバイダへの中継（#38）であり、ヘッダはそのまま転送されるのが自然な形。プロバイダは宛先アドレスを平文で受け取るので「そのアドレス自体」は新情報ではないが、渡っているのは `lib/directoryLocator.ts:19` が「**Identity** — it is what a mapping row is keyed by」と呼ぶ値、すなわち mapping 行の主キーであり、`DIRECTORY_ROUTING_SECRET` の秘匿によって「候補アドレスから bucket を計算できない」という性質を支えているものである。(address, HMAC) の対応表が信頼境界の外に蓄積されると、その一部が漏れただけで当該利用者群の bucket 対応が確定する。ログ基盤より外側なので、B-002 と同じ論法がより強く当てはまる。
    1周目は N-003（`review-001-security.md`）でこれを「`operationKey` から決定的」と正しいものとして通しているが、決定性は SHA-256 でも保たれる。
  - 提案: `providerIdempotencyKey` を `SHA-256(operationKey)` の hex（もしくは先頭 16 バイト）にする。行に保存する値も同じにすれば、再配送をまたいだ安定性は変わらない。`sendMail.ts:218` の `?? row.operation_key` フォールバックも同時に落とすこと（フォールバックが生の `operation_key` を送る抜け道になっている）。

## Notes

- **[N-001]** ADR-042 の導出鎖は**主張どおり成立している**。`tokenId --HMAC(keyring[gen])--> secret --SHA-256--> token_hash` が `resetTokenCrypto.ts` の1モジュールに閉じ、発行（`identityDirectory.ts:181-208`）・配送（`sendMail.ts:205-213`）・検証（`resetTokenStore.ts:73-93` + `parseResetToken` → `resetTokenDigest`）の3者が同じ関数を読む。「DB 読み取り漏えいだけではリンクを作れない/消費できない」は、(a) `token_id` から `secret` を作るには state Worker 側の keyring が要る、(b) `token_hash` から `secret` を作るには SHA-256 の原像が要る、(c) `token_id` も `token_hash` もそのまま提出すると `SHA-256` を1段余分に通って一致しない、の3点で成立する。`__tests__/resetToken.integration.test.ts` の "stores nothing a database dump could redeem" が (a)(b)(c) を**実際の DO クラス・実際のメール本文**で確認し、末尾で本物のリンクが通ることを陽性対照にしている。検出力のあるテストである。
- **[N-002]** 同期 UoW 契約は壊れていない。導出は非同期な RPC エントリ（`identityDirectory.ts:181-197`）で完了し、`run()` へ渡るのは `{tokenId, tokenHash, tokenKeyGeneration}` という primitive のみ。`PasswordResetTokenPort` は同期のままで、`ResetTokenIssueMaterial` の JSDoc が「derived by the caller, never here」と契約として明文化している。`reserveCredential` の `SealedCanonical` と同型で、例外を作っていない。
- **[N-003]** 二重消費・有効期限・列挙オラクルの3点も確認した。消費は `used_at IS NULL AND expires_at > ?` を述語に持つ**単一の条件付き `UPDATE` + `RETURNING`** で、`transactionSync` の中なので2つの同時消費は必ず1つに収束する（テスト "refuses the same link twice" が固定）。照合は SQL の等価比較なので定数時間ではないが、比較対象は攻撃者が自分で計算できる SHA-256 ダイジェストであり、タイミングから漏れうる前置一致情報は `secret` の逆算に使えない（セッショントークンをハッシュで引く一般的な形と同じ）。4ケースの一様性は `mintResetTokenMaterial` の無条件実行＋不適格なら破棄（`facade.ts:317-319`）、`enqueueJob` の無条件実行、payload が要求そのものだけ、で保たれている。ADR-043 の時間窓は `operation_key` / `provider_idempotency_key` にしか現れず、`floor(now/window)` は依頼した本人の時刻の関数であって行の有無の関数ではないので、**新しい観測点にはなっていない**（外部へ出る点だけが W-004）。`SEND_MAIL_RETENTION_MS` を「結果によらず一律」にした判断も正しい。
- **[N-004]** `IDENTITY_RESET_TOKEN_KEY` 未設定時の `SystemError(CryptoError)` はアドレスの登録有無を漏らさない。`requireResetTokenKeyring` は `readStateSecretsOrNull(this.env)` の結果だけを見て `hmac` を一切参照しないので、失敗はデプロイの属性であって宛先の属性ではない。クライアントには `redactForClient` が `system` を `code: null` / "System error" に潰すので、`CryptoError` という文字列すら届かない。
- **[N-005]** ADR-045 は効いている。`runner.ts:122-127` は `job: SHA-256(operation_key)[0..8]` / `kind` / `attempt` / `cause: errorIdentity(error)` だけを出す。`errorIdentity`（`lib/errorIdentity.ts`）は `CodedError` なら `Name:CODE`、素の `Error` なら `name` のみで、**message を構造的に持ち出せない**。`grep -rn 'logger\.(info|warn|error)\('` で全ログ点（本番経路は11箇所）を一巡し、可変値を渡しているのは `status`（HTTP ステータス）・`targetVersion` / `step`（マイグレーション定数）・`earliest`（時刻）・相関 ID だけであることを確認した。`alarm()` 側も同じ helper を共有している（ADR-044）。
- **[N-006]** ADR-046 の非露出テストは**空振りしなくなっている**。`assertNoForbiddenValue(recorded, extra)` にその実行が導出した `CANONICAL` / `locator.hmac` / `locator.doName` を渡し、haystack を「namespace に渡された名前（＝陽性対照）」と「ログ・エラー文言（＝検査対象）」に分離したので、1周目に指摘した「実 `doName` を除外していた」構造が消えた。禁止語配列の locator 形（0 詰め無し・256 未満）自体を検査するテストが1本増えており、配列が再び構造的に一致不能な形へ劣化することも防いでいる。`runner.integration.test.ts` の該当ケースも「除外」から「`assertNoForbiddenValue(lines, [operationKey])` で検知」へ反転している。
- **[N-007]** ADR-047 の3束縛は塞がっている。`activate` は `operation_id` の一致・`matchOpaque(caller_token)`（定数時間）・`candidate_user_id === userId` の3つを read-then-CAS で確認し、最後の `UPDATE ... RETURNING 1` で0行を `ConflictError` にする。失敗理由は `notActivatable()` の1文言に均されているので、bucket の中身を報告しない。冪等な再実行（`status === 'active' && user_id === userId`）だけを成功として抜くのも妥当で、`operationId` と `callerToken` の両方を通過した後にしか到達しない。`signupSaga.ts:153-158` が `callerToken` を渡していることも確認した。
- **[N-008]** ADR-061 の3分類は妥当。`redactForClient` は網羅 `switch` なので kind の追加時に選択を強制する。`code` を残す4 kind（`notFound` / `conflict` / `unauthorized` / `forbidden`）はすべてリポジトリ内で著述された定数で、`grep` で確認した限り値を補間するものは無い。`business` / `validation` は message を通すが、補間されるのは上限値のような定数か利用者自身の入力だけである。`conflict` の `code` を残すことで `EMAIL_ALREADY_REGISTERED` はサインアップの列挙オラクルとして残るが、これは #37 が作ったものではなく、アドレス所有確認を持たない設計の既知のトレードオフである。
- **[N-009]** `listBucketUserIds` の対応は十分。`IdentityDirectoryFacade`（`application/di/facades.ts:94-98`）から外れ、`directoryStubFactory` が `as unknown as IdentityDirectoryFacade` でキャストして返すので、合成ルートを経由する限りリクエスト経路の型からは到達できない。DO クラス側にのみ残り、gate 外である点は `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts` が反射でエントリ表の全数を固定して確認している。運用トークンによる束縛の #38 引き継ぎも両側の JSDoc にある。
- **[N-010]** AC-4 は再実測でも保たれている。`grep -rn "\.idFromName(\|\.getByName(" packages/core/src apps/web/app | grep -v '/__tests__/'` の一致は `application/di/serverCloudflare.ts:148` / `:159` のみ。W-003 はこの性質に将来空く穴の話であって、現状の違反ではない。
- **[N-011]** リクエスト Worker 側のログ sink だけが `errorIdentity` の規則の外にある。`apps/web/app/presentation/errorResponseMiddleware.ts:84-89` は `system` / `unknown` に対して `message: serialized.message` と `cause: error` を生で出し、`envelope.ts:23-27` は「The raw message stays in: this hop is server-to-server, and `redactForClient` … strips it before a client sees it」とクライアント側だけを根拠にしている。現時点で DO から来る `system` 系 message に禁止値を埋めるものは無い（`NotFoundError` の `User not found: ${id}` は `notFound` なのでこの経路を通らない）ので指摘には上げないが、ADR-045 が DO 側に課した規則の対称形はここには無い。#38 で `errorIdentity` に寄せると全体が揃う。両ファイルとも本 PR の変更対象外。
- **[N-012]** リセットリンクは `{routingGeneration}.{bucketIndex}.{secret}` を URL クエリに載せるので、locator の bucket index が URL に出る。routing secret 無しには候補アドレスから bucket を計算できないため確認オラクルにはならず、`DIRECTORY_ROUTING_SECRET` を state Worker へ渡さないための設計上の代償として妥当だが、AC-3 の「locator が URL に出ない」という文言とは字面が食い違う。spec 側に例外として明記しておくのが正確。あわせて、トークンをクエリ文字列に置く形は Referer / アクセスログに載りやすいので、#12 が `/reset-password` を作るときに `Referrer-Policy: no-referrer` と即時消費を入れることを引き継ぐとよい。
- **[N-013]** 秘密の配布境界は wave 2 でも崩れていない。`RequestSecrets` / `StateSecrets` の非重複が型（`di/secrets.ts:20-29`）・env 宣言（`serverCloudflare.ts:46-58` / `stateCloudflare.ts:30-38`）・`.tpl` の手順欄・`.dev.vars.example` の4箇所で一貫し、`StateSecrets` の二重定義も re-export に解消済み（1周目 N-009）。レンダリング後の `wrangler.*.{staging,production}.toml` が `.gitignore:19-20` で無視されることも確認した。`.dev.vars.example` の全項目は空のまま。
- **[N-014]** `Email.create` は1周目 W-008（非 ASCII 経路の切り捨て）と2周目の domain-usecase W-006（ASCII 経路の非対称）の両方が塞がれている。`toAsciiDomain` が `port` / `pathname` / `search` / `hash` の非空を `invalidEmail` にし、punycode 後に `assertDomainSyntax` を両経路へ掛ける形になったので、`a@example.com/evil` のような入力が canonical へ落ちる経路が消えた。非 ASCII local part を**拒否**して正規化しない判断（`ａ` と `a` を別アカウントにしない／リセットメールを別人へ届けない）も、理由込みで JSDoc に書かれている。

## 1回目指摘の修正検証

- **B-001**（リセットトークンの保存形式）: **解消**。ADR-042 のとおり `resetTokenCrypto.ts` に導出鎖を一本化し、行に載るのは `SHA-256(secret)` のみ。`token_id` / `token_hash` のいずれを提出しても一致しないことを E2E 統合テストが実証している。FNV-1a-64 は消滅。JSDoc（`passwordResetTokenPort.ts:50-58` / `resetTokenStore.ts:22-42`）も実際の保証へ書き直されている。ただし派生の未処理が2件残った（W-002 の掃除経路、W-003 の座標の範囲検査）。
- **B-002**（`operation_key` と生例外のログ出力）: **解消**。`runner.ts` は相関 ID（SHA-256 先頭8バイト）と `errorIdentity` のみを出し、テストは「除外」から「検知」へ反転済み。ただし同じ値が `Idempotency-Key` として外へ出る経路が残っている（W-004）。1周目が見落とした別経路であって、修正が作った穴ではない。
- **W-001**（`verifyAndConsume` の契約が噛み合わない）: **解消**。`verifyAndConsume(tokenHash, …)` が「リンクの secret 部の SHA-256」を取ることが契約として明文化され、#12 が何を計算するかまで JSDoc に書かれている。統合テストの `redeem()` が「#12 がやること」を実際に通している。
- **W-002**（`SEND_MAIL_EMPTY_RETENTION_MS` の死にコード）: **解消**。`RESET_REQUEST_WINDOW_MS` 1本が発行スロットルと `operationKey` の窓を決め、`pruneCompleted` が種別別保持を取る形になった。「保持時間が結果に依存すると列挙オラクルになる」という指摘は `SEND_MAIL_RETENTION_MS` の JSDoc と `table.ts:355-363` に理由付きで反映されている。**ただし副作用として新しい問題が生じた** — 窓が 60 秒から 15 分になったことで、W-001 のリセット封じに必要な攻撃レートが 1/15 分まで下がった。
- **W-003**（`enqueueJob` の競合メッセージ）: **解消**。adapter 側は `A ${kind} job is already queued with a different payload` になり `operationKey` を含まない。presentation 側も `redactForClient` の3分類で `conflict` の message が落ちる（N-008）。
- **W-004**（リセット依頼が active 世代のみ）: **解消**。`requestPasswordReset.ts:48-54` が全 locator へ**無条件に**ファンアウトし、ヒット判定をしないので一様性も保たれている。unit テスト（`__tests__/requestPasswordReset.test.ts`）が世代順と各世代自身の hmac を固定している。
- **W-005**（非露出テストの空振り）: **解消**。N-006 のとおり実導出値の検査になり、haystack が分離され、禁止語配列の形自体を検査するテストが増えた。検出力は本物。
- **W-006**（`activate` が `callerToken` 非束縛）: **解消**。N-007 のとおり3束縛 + `RETURNING 1`。
- **W-007**（`listBucketUserIds` が facade 型に載る）: **解消**。N-009 のとおり。
- **W-008**（`Email.create` の切り捨て）: **解消**、かつ2周目の domain-usecase W-006 で ASCII 経路まで拡張された（N-014）。
- **N-009**（`StateSecrets` の二重定義）: **解消**。`stateCloudflare.ts:46` が `secrets.ts` からの re-export になった。

新たに生まれた問題として本レビューが挙げるのは W-001（W-002 の修正の副作用）と W-002 / W-003（B-001 の修正が導入した新しい面）である。W-004 は1周目が見落としていた既存の経路。

## カバレッジ

### 確認

- `.github/workflows/ci.yml`
- `.thread/37/adr.md`
- `.thread/37/plan.md`
- `.thread/37/review/review-001-security.md`
- `.thread/37/review/triage.md`
- `apps/web/.dev.vars.example`
- `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts`
- `apps/web/app/durable-objects/identityDirectory.ts`
- `apps/web/app/durable-objects/userData.ts`
- `apps/web/app/presentation/authState.ts`
- `apps/web/app/presentation/currentUser.ts`
- `apps/web/app/presentation/errorResponse.ts`
- `apps/web/app/presentation/session.ts`
- `apps/web/app/worker/cloudflare/state.ts`
- `apps/web/scripts/render-wrangler.ts`
- `apps/web/wrangler.request.production.toml.tpl`
- `apps/web/wrangler.state.production.toml.tpl`
- `apps/web/wrangler.state.toml`
- `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- `packages/core/src/adapters/cloudflare/directoryLocator.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- `packages/core/src/adapters/cloudflare/jobs/runner.ts`
- `packages/core/src/adapters/cloudflare/jobs/table.ts`
- `packages/core/src/adapters/cloudflare/mailSender.ts`
- `packages/core/src/adapters/cloudflare/platform/envelope.ts`
- `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- `packages/core/src/adapters/cloudflare/search/probe.ts`
- `packages/core/src/adapters/cloudflare/sql/occ.ts`
- `packages/core/src/adapters/cloudflare/userData/facade.ts`
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts`
- `packages/core/src/application/di/facades.ts`
- `packages/core/src/application/di/secrets.ts`
- `packages/core/src/application/di/serverCloudflare.ts`
- `packages/core/src/application/di/stateCloudflare.ts`
- `packages/core/src/application/identity/__tests__/requestPasswordReset.test.ts`
- `packages/core/src/application/identity/loginWithPassword.ts`
- `packages/core/src/application/identity/requestPasswordReset.ts`
- `packages/core/src/application/identity/signupSaga.ts`
- `packages/core/src/domain/identity/credentialMappingRules.ts`
- `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts`
- `packages/core/src/domain/identity/valueObject.ts`
- `packages/core/src/lib/errorIdentity.ts`
- `packages/core/src/lib/jobBudgets.ts`

### スキップ

- `.adr/001-integration-tests-single-workers-pool.md` — テストプール構成 / 検索エンジン選定の ADR。認可・秘密・PII に触れない
- `.adr/003-sqlite-fts5-only-search.md` — テストプール構成 / 検索エンジン選定の ADR。認可・秘密・PII に触れない
- `.thread/37/review/review-001-adapter-infra.md` — 他観点の1周目レビュー記録。指摘の突き合わせは triage.md で行った
- `.thread/37/review/review-001-domain-usecase.md` — 他観点の1周目レビュー記録。指摘の突き合わせは triage.md で行った
- `.thread/37/review/review-001-presentation-config.md` — 他観点の1周目レビュー記録。指摘の突き合わせは triage.md で行った
- `.thread/37/review/review-001-test.md` — 他観点の1周目レビュー記録。指摘の突き合わせは triage.md で行った
- `.thread/37/review/review-001.md` — 1周目の統合レビュー記録。個別指摘は観点別ファイルと triage.md で突き合わせた
- `.thread/37/steps.md` — 作業手順・テスト計画のメモで、成果物そのものではない
- `.thread/37/testing.md` — 作業手順・テスト計画のメモで、成果物そのものではない
- `CLAUDE.md` — 規約文書。記述と実装の一致は該当モジュールで確認した
- `README.md` — 規約文書。記述と実装の一致は該当モジュールで確認した
- `apps/web/__tests__/boot.smoke.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `apps/web/app/components/auth/LoginForm/action.ts` — サーバ関数の配線のみ。入力検証と再定義は `serverAction` / usecase 側で確認した
- `apps/web/app/components/auth/SignupForm/action.ts` — サーバ関数の配線のみ。入力検証と再定義は `serverAction` / usecase 側で確認した
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx` — 表示コンポーネント。露出する項目は `toCurrentUserView`（`userData/facade.ts`）側で確認した
- `apps/web/app/components/settings/LogoutButton/action.ts` — サーバ関数の配線のみ。入力検証と再定義は `serverAction` / usecase 側で確認した
- `apps/web/app/components/settings/SettingsSkeleton/index.tsx` — スケルトンの DOM のみ
- `apps/web/app/durable-objects/__tests__/env.d.ts` — ビルド・テスト構成 / 型宣言のみ
- `apps/web/app/presentation/__tests__/currentUser.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `apps/web/app/presentation/__tests__/errorResponse.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `apps/web/app/presentation/__tests__/session.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `apps/web/app/routes/_app/settings.tsx` — `errorComponent` と断片分割の変更。保護データの取得点は `currentUser.ts` / facade 側で確認した
- `apps/web/app/server.cloudflare.ts` — エントリ点。合成ルートと秘密の読み出しは `serverCloudflare.ts` で確認した
- `apps/web/app/worker/cloudflare/__tests__/env.d.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/consumer.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/dlq.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/handlers.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/pruner.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/relay.ts` — 削除の確認のみ（対象消滅）
- `apps/web/drizzle.config.ts` — 削除の確認のみ（対象消滅）
- `apps/web/package.json` — スクリプト定義のみ
- `apps/web/vite.config.cloudflare.ts` — ビルド構成のみ
- `apps/web/vite.config.state.ts` — ビルド構成のみ
- `apps/web/wrangler.production.toml.tpl` — 削除の確認のみ（対象消滅）
- `apps/web/wrangler.request.staging.toml.tpl` — production 版と同形で、そちらを直接確認した
- `apps/web/wrangler.staging.toml.tpl` — 削除の確認のみ（対象消滅）
- `apps/web/wrangler.state.staging.toml.tpl` — 同上（state 側）
- `apps/web/wrangler.toml` — ローカル dev 用。秘密は `.dev.vars` 側で、こちらには含まれない
- `docs/backend_implementation_example.md` — 解説文書で、実行経路を持たない
- `docs/runtime_cloudflare.md` — 解説文書で、実行経路を持たない
- `docs/test.md` — 解説文書で、実行経路を持たない
- `infra/cloudflare/pulumi/resources/Pulumi.production.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/resources/Pulumi.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/resources/index.ts` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/routes/Pulumi.production.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/routes/Pulumi.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `package.json` — ビルド・テスト構成 / 型宣言のみ
- `packages/core/package.json` — ビルド・テスト構成 / 型宣言のみ
- `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/__tests__/directoryLocator.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/__tests__/env.d.ts` — ビルド・テスト構成 / 型宣言のみ
- `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/__tests__/setup.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/mappingOperations.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/payloadDigest.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts` — JSDoc の射程注記のみの変更
- `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/jobs/registry.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/platform/stubErrors.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/schema/gate.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/schema/types.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/schema/userData.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/search/normalize.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/search/projection.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/cloudflare/sql/errors.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/sql/exec.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/adapters/cloudflare/userData/accountStore.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/userData/trashQuery.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts` — 非機密の設定のみを扱い、認可は facade 側の epoch ガードが持つ
- `packages/core/src/adapters/d1/__tests__/env.d.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/helpers.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/setup.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/client.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/migrations/0000_initial.sql` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/migrations/meta/_journal.json` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/pendingBatch.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/repositories/helpers.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/repositories/idempotencyStore.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/repositories/outboxRepository.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/repositories/userRepository.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/schema.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/d1/unitOfWork.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/__tests__/helpers.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/di/__tests__/secrets.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/di/containerStore.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/di/env.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/di/types.ts` — コンテナの型定義。秘密が `container.config` に載らないことは `secrets.ts` の入れ子で確認した
- `packages/core/src/application/errors.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/events/buildDecoder.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/execution/jobs.ts` — `EnqueueJobArgs` / `LocatorRef` の型定義のみ
- `packages/core/src/application/execution/unitOfWork.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/application/identity/__tests__/logout.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/identity/eventDecoders.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/identity/getCurrentUser.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/identity/registerWithPassword.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/identity/view.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/ports/idGenerator.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/ports/idempotencyStore.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/ports/outboxRepository.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/ports/relayTrigger.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/ports/sessionCodec.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/application/rpc/restoreError.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/workers/__tests__/outboxPrune.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/workers/eventRelayWorker.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/workers/outboxPrune.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/common/event.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/common/transactionalRepository.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/domain/identity/__tests__/credentialMappingRules.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/domain/identity/__tests__/entity.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/domain/identity/__tests__/noRawNul.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/domain/identity/__tests__/valueObject.test.ts` — テスト。対応する本体を直接確認した（wave 2 で変更あり）
- `packages/core/src/domain/identity/entity.ts` — クレデンシャル集合を射影に倒した変更（ADR-070）。到達可能性による分離には関与しない
- `packages/core/src/domain/identity/errorCode.ts` — エラーコードの列挙のみ
- `packages/core/src/domain/identity/events.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/identity/ports/accountStore.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/domain/identity/ports/credentialLocatorStore.ts` — ポートのシグネチャのみ。実装を直接確認した
- `packages/core/src/domain/identity/ports/credentialMappingRepository.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/domain/identity/ports/credentialMappingStore.ts` — ポートのシグネチャのみ。`activate` の3束縛は実装（`mappingOperations.ts`）で確認した
- `packages/core/src/domain/identity/ports/mailSender.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/domain/identity/ports/userRepository.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/identity/ports/userSettingsRepository.ts` — ポートのシグネチャのみ。実装を直接確認した
- `packages/core/src/lib/__tests__/jobKind.test.ts` — テスト。対応する本体を直接確認した（wave 2 で未変更）
- `packages/core/src/lib/directoryLocator.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/lib/jobKind.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/lib/passwordHashing.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/lib/rpcEnvelope.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `packages/core/src/lib/secretLengths.ts` — 1周目で確認済みで、wave 2 の修正コミットでは変更されていない
- `pnpm-lock.yaml` — ビルド・テスト構成 / 型宣言のみ
- `spec/database/index.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/domains/identity.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/inventory/adapter.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/inventory/domain.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/inventory/usecase.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/manual-tests/search.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/testcases/identity/unlinkSsoCredential.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/usecases/identity.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `vitest.config.integration.ts` — ビルド・テスト構成 / 型宣言のみ
- `vitest.config.smoke.ts` — ビルド・テスト構成 / 型宣言のみ
- `vitest.config.ts` — ビルド・テスト構成 / 型宣言のみ
