### Security（3周目）

PR #49 / base `main` / 契約: `.thread/37/plan.md`（AC-3 / AC-4 を主軸に確認）
2周目の W-001〜W-004 の修正検証と、修正が新たに作った穴の探索。焦点は「マージしてよいか」。

対象コミットは wave 3 の2本（`21fd944` レビュー2周目の指摘修正 / `e56785a` 統合スイートの安定化）。

#### Blockers

なし。

#### Warnings

なし。

2周目の W-001〜W-004 はいずれも実装・テストの両方で解消を確認した。新たに導入された経路（窓番号判定 / 無条件の掃除投入 / SHA-256 の冪等キー / キーリングによる座標検査 / redact 連動ログ / `ErrorSurface`）を一巡したが、**実際に悪用できるもの・受け入れ基準を満たさないものは見つからなかった。**

#### Notes

- **[N-001]** ADR-091 の窓番号判定は主張どおり恒久ロックアウトを塞いでいる。`isResetRequestAllowed`（`packages/core/src/domain/identity/credentialMappingRules.ts:97-109`）は `floor(last / w) < floor(now / w)` になり、`recordResetRequested`（`mappingOperations.ts:317-341`）は無条件のまま残り、`facade.ts:341` の `if (mapping !== null)` ガードが外れて**登録の有無によらず必ず1文**発行される。攻撃者が窓ごとに叩き続けても「その窓の最初の1回」は必ず適格になるので、登録済みアドレスには窓あたり1通のリンクが必ず届く。届く先は被害者のアドレスなので、攻撃者が発行させたリンクを被害者が使える。旧 sliding 形で成立していた「未認証の第三者が回復経路を恒久的に封じる」は成立しない。
- **[N-002]** 窓境界での挙動も確認した。(i) `last = 窓末尾 - 1ms` の直後に次窓が適格になる（unit テストが固定）。(ii) 境界をまたぐ2依頼が両方発行され直前のリンクが失効するのは ADR-091 が明記したトレードオフで、ADR-043 が既に受け入れている性質と同種。(iii) `now` は RPC エントリで1回だけ読み（`durable-objects/identityDirectory.ts:196`）、`operationKey` の窓・`providerIdempotencyKey`・`recordResetRequested` の刻印がすべて同じ値を使うので、窓がずれる経路は無い。
  ADR-091 が書く不変条件「適格な依頼の窓番号には行がまだ無い」には、**厳密には1つだけ穴がある** — mapping 行がまだ存在しない間の依頼は `recordResetRequested` が0行に当たるので `last` を進めず、同じ窓で行が作られた直後の依頼が適格になったとき、その窓の `send-mail` 行が既に `done` で存在しうる（収束規則 (3) が非再武装種を復活させないため、メールが出ない）。到達条件は「登録前の同一窓に同一アドレスへの依頼があったこと」で、被害は**次の窓まで（最大15分）リンクが届かないこと**に限られ自己修復する。悪用しても遅延以上のものは得られないので Warning には上げない。
- **[N-003]** ADR-090 の無条件投入は列挙オラクルを壊していない。`requestPasswordReset`（`facade.ts:321-370`）は4ケースすべてで **同じ `run()`・同じ2本の `enqueueJob`（`send-mail` + `sweep-reset-tokens`）・同じ `recordResetRequested` 1文・同じ応答** を通り、分岐は `resetTokenStore.issue` の1本だけ（適格なときのみ）である。`material` と `providerIdempotencyKey` はエントリ側で無条件に導出されるので WebCrypto の回数も4ケースで等しい。`sweep-reset-tokens` は bucket ごとの定数キー・payload `{}` なので `payload_digest` は不変、収束規則 (1) は `next_run_at` を早める方向にしか動かない（`table.ts:180-191`）から、既に武装済みの掃除を後ろへ倒すこともない。掃除自体は `expires_at < now` を消すので、**消費済み行（`used_at` と平文の `change_auth_token` を持つ行）も TTL 経過後に消える** — 2周目 W-002 の本体はこれで解消している。
- **[N-004]** ADR-092 は完全長 HMAC の外部流出を止めている。`providerIdempotencyKey` は `SHA-256(operationKey)` の hex 64桁（`identityDirectory/resetRequestKeys.ts:50-60`）で、組み立てとハッシュが1モジュールに閉じ、facade（`facade.ts:354`）と RPC エントリ（`identityDirectory.ts:205-207`）が同じ関数を読む。`sendMail.ts:145-148` の `?? row.operation_key` フォールバックは消え、NULL は `terminal(SEND_MAIL_IDEMPOTENCY_KEY_MISSING)` になる（この terminal reason 自体に PII も秘密も無い）。プロバイダ側から `hmac` を復元するには SHA-256 の原像が要り、候補アドレスから同じキーを再計算するには `DIRECTORY_ROUTING_SECRET` が要るので、(address, HMAC) 対応表が外部に蓄積する経路は閉じた。
- **[N-005]** ADR-094 は AC-4 の構造保証を守る形になっている。`parseResetToken(token, routing)` は `routing` を**必須引数**にし（#12 が「後で足す」を選べない）、宣言に無い `generation` と `bucket >= bucketCount` を `null` に落とす（`resetTokenCrypto.ts:199-213`）。`\d+` を `Number()` するので巨大入力は `Infinity` になり `>= bucketCount` で弾かれる。先頭ゼロは数値へ正規化されるが、DO 名は数値から組み立てられるので同じ座標に収束するだけで名前空間の分裂は起きない。`null` は「解析不能なトークン」と同じ答えなので新しい観測点も増えていない。**現時点で消費エントリは存在せず（`grep parseResetToken` の一致はモジュール自身とテストのみ）**、AC-4 の実測は変わらず `serverCloudflare.ts:149` / `:159` の2件だけである。
- **[N-006]** ADR-100 は秘密をログへ漏らしていない。ログ条件が `redactsMessage(kind)` に連動した結果、`notFound` / `conflict` / `unauthorized` / `forbidden` の raw が `logServerError` へ回る（`errorResponseMiddleware.ts:68-73`）。この4 kind で `message` に値を補間しているのは、リポジトリ全体で `userData/facade.ts:106` / `:126` の `User not found: ${id}`（`userId`）と `sql/occ.ts:33` の `${subject}`（テーブル名相当の定数）だけである。`JOB_PAYLOAD_MISMATCH` は wave 1 で `kind` のみへ書き換え済みで `operationKey` を含まない。`userId` は `FORBIDDEN_VALUES`（canonical / hmac / locator / `callerToken` / `changeAuthToken` / verifier / reset token）に属さず、AC-3 の禁止語でもない。**サーバ側ログのみで、クライアントには `redactForClient` が `REDACTED_MESSAGE` を返す**ので、露出面は増えていない。なお `logServerError` が `cause: error` を生で出す点は2周目 N-011 のとおり変わらず（#38 で `errorIdentity` へ寄せる引き継ぎ）、この経路に禁止値を埋めるものは今も無い。
- **[N-007]** ADR-102 はエラー情報の露出を増やしていない。`ErrorSurface` は `message` を受け取って描くだけで、両呼び出し側（`routes/_app.tsx` / `routes/_app/settings.tsx`）とも渡す値は従来どおり `sanitizeRouteError(error)` = `renderErrorMessage(extractSerializedError(error))` である。抽出前後で分岐も文言も増えておらず、差は `className`（余白）1つに閉じている。
- **[N-008]** `SEND_MAIL_RETENTION_MS = RESET_REQUEST_WINDOW_MS` の等式は荷重がある。`done` 行の prune は `completed_at + retention` なので、窓の中で完了した行が**その窓のうちに消えることは起きない**（`completed_at ≥ 窓頭` かつ `retention = 窓幅` より `completed_at + retention ≥ 窓末`）。もし短くすると、同一窓の2回目の依頼が pruned 済みキーで新しい行を作り、まだ生きているリンクを再送する経路が開く。等式であること自体が防御になっている（`lib/jobBudgets.ts:78-86` / `jobs/table.ts:371-396`）。
- **[N-009]** リセット依頼の経路は本 PR ではまだ外部到達不能である（`grep -rn requestPasswordReset apps/web` の一致は DO クラスとその統合テストのみで、ルート / サーバ関数は無い）。上の N-002 の残存エッジを含め、実際に叩かれる面は #12 が入口を作った時点で初めて生じる。
- **[N-010]** ADR-093（`beginChange` の `RETURNING 1`）はセキュリティ側でも妥当。0行を `CREDENTIAL_CHANGE_NOT_STARTABLE` の1文言に均し、「飛行中の変更がある」と「その credential が無い」を割らないので、bucket の中身を報告しない（`notActivatable()` と同じ線）。ポート JSDoc も8つの書き込みの全数分類に書き直され、`recordResetRequested` が「absent is success」側である理由（列挙オラクル）が明記された。
- **[N-011]** 秘密の配布境界は wave 3 でも崩れていない。`.dev.vars.example` の分割宣言（request: `SESSION_SECRET` / `AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET`、state: `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY`）は不変で、値はすべて空。wave 3 が request `.tpl` へ足したのは `no_bundle` / `[[rules]]` とコメントだけで、binding / vars / secret には触れていない。`vite.config.cloudflare.ts` の `strictPort: true` はリセットメールの絶対 URL が実在しないポートを指す事故を防ぐ側の変更である。
- **[N-012]** 本番経路のログ発火点は11箇所で、可変値を渡しているのは `status`（HTTP ステータス）/ `job`（`SHA-256(operation_key)` 先頭8バイト）/ `kind` / `attempt` / `cause: errorIdentity(...)` / migration 定数のみ。ADR-045 の規則は wave 3 でも崩れていない（`jobs/runner.ts:122-127` / `jobs/alarm.ts:138,146`）。

#### 2回目指摘の修正検証

- **W-001**（不適格な依頼でも窓を押し戻すため、未認証の第三者がリセットを恒久的に封じられる）: **解消**。ADR-091 のとおり判定式を窓番号比較へ変え、無条件記録は `operationKey` の窓一意性の根拠として残した（コメントも「retry で窓を開けたままにされる」から「無条件性が窓一意性を成立させている」へ反転）。あわせて `facade` の `if (mapping !== null)` ガードが外れ、**実行される文の数が登録の有無で変わらなくなった**（レビューが追加提案した2点目もそのまま採用されている）。unit テスト2本（境界直前 / 窓の 1/16 間隔で 160 回叩いて適格数＝窓数）が検出力を持つ。副作用の探索結果は N-001 / N-002。
- **W-002**（`sweep-reset-tokens` の投入点が無く、平文の `change_auth_token` が無期限に滞留する）: **解消**。ADR-090 のとおり `requestPasswordReset` の同一トランザクションで定数キー・`nextRunAt = now + RESET_TOKEN_TTL_MS` で無条件投入。ハンドラは `expires_at < now` を消すので消費済み行も TTL 後に消え、`min(expires_at)` で自走する。統合テストが**投入経路を通す**形（ハンドラ直呼びではない）になっている。列挙オラクルへの影響は N-003 のとおり無い。
- **W-003**（`parseResetToken` が座標を範囲検査しない）: **解消**。ADR-094 のとおり必須引数のキーリング照合。提案した「最低でも JSDoc で #12 へ引き継ぐ」より強い、型で強制する側が採られている。N-005。
- **W-004**（`providerIdempotencyKey` が `operationKey` と同値で完全長 HMAC が外部へ出る）: **解消**。ADR-092 のとおり `SHA-256(operationKey)`、フォールバック撤去。N-004。

2周目に挙げた Note のうち、N-011（リクエスト Worker のログ sink が `errorIdentity` の外）と N-012（リセットリンクの bucket index が URL に出る／`Referrer-Policy` の引き継ぎ）は #38 / #12 への引き継ぎとして残っている。前者は ADR-100 でログ対象 kind が増えたので射程がわずかに広がったが、N-006 のとおり禁止値は乗らない。

**新たに生まれた問題として本レビューが挙げるものは無い。**

#### カバレッジ

##### 確認

- `.adr/008-identity-split-and-non-aggregate-stores.md`
- `.github/workflows/ci.yml`
- `.thread/37/adr.md`
- `.thread/37/plan.md`
- `.thread/37/review/review-002-security.md`
- `.thread/37/review/triage.md`
- `apps/web/.dev.vars.example`
- `apps/web/app/components/ui/ErrorSurface/index.tsx`
- `apps/web/app/durable-objects/identityDirectory.ts`
- `apps/web/app/presentation/errorResponse.ts`
- `apps/web/app/presentation/errorResponseMiddleware.ts`
- `apps/web/app/presentation/session.ts`
- `apps/web/app/routes/_app.tsx`
- `apps/web/app/routes/_app/settings.tsx`
- `apps/web/vite.config.cloudflare.ts`
- `apps/web/wrangler.request.production.toml.tpl`
- `apps/web/wrangler.request.staging.toml.tpl`
- `package.json`
- `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetRequestKeys.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts`
- `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- `packages/core/src/adapters/cloudflare/jobs/runner.ts`
- `packages/core/src/adapters/cloudflare/jobs/table.ts`
- `packages/core/src/adapters/cloudflare/mailSender.ts`
- `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts`
- `packages/core/src/adapters/cloudflare/userData/facade.ts`
- `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts`
- `packages/core/src/application/di/serverCloudflare.ts`
- `packages/core/src/application/identity/loginWithPassword.ts`
- `packages/core/src/application/identity/requestPasswordReset.ts`
- `packages/core/src/domain/identity/credentialMappingRules.ts`
- `packages/core/src/domain/identity/errorCode.ts`
- `packages/core/src/domain/identity/ports/credentialMappingRepository.ts`
- `packages/core/src/domain/identity/ports/credentialMappingStore.ts`
- `packages/core/src/lib/directoryLocator.ts`
- `packages/core/src/lib/jobBudgets.ts`

##### スキップ

- `.adr/001-integration-tests-single-workers-pool.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.adr/003-sqlite-fts5-only-search.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-001-adapter-infra.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-001-domain-usecase.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-001-presentation-config.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-001-security.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-001-test.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-001.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-002-adapter-infra.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-002-domain-usecase.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-002-presentation-config.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-002-test.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/review/review-002.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/steps.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `.thread/37/testing.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `CLAUDE.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `README.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `apps/web/__tests__/boot.smoke.test.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/components/auth/LoginForm/action.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/components/auth/SignupForm/action.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/components/settings/LogoutButton/action.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/components/settings/SettingsSkeleton/index.tsx` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/durable-objects/__tests__/env.d.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/durable-objects/userData.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/presentation/__tests__/currentUser.test.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/presentation/__tests__/errorResponse.test.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/presentation/__tests__/session.test.ts` — テスト。対応する本体を直接確認した
- `apps/web/app/presentation/authState.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/presentation/currentUser.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/server.cloudflare.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/app/worker/cloudflare/__tests__/env.d.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/consumer.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/dlq.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/handlers.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/pruner.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/relay.ts` — 削除の確認のみ（対象消滅）
- `apps/web/app/worker/cloudflare/state.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `apps/web/drizzle.config.ts` — 削除の確認のみ（対象消滅）
- `apps/web/package.json` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `apps/web/scripts/render-wrangler.ts` — テンプレート展開スクリプト。展開先の内容を直接確認した
- `apps/web/vite.config.state.ts` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `apps/web/wrangler.production.toml.tpl` — 削除の確認のみ（対象消滅）
- `apps/web/wrangler.staging.toml.tpl` — 削除の確認のみ（対象消滅）
- `apps/web/wrangler.state.production.toml.tpl` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `apps/web/wrangler.state.staging.toml.tpl` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `apps/web/wrangler.state.toml` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `apps/web/wrangler.toml` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `docs/backend_implementation_example.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `docs/runtime_cloudflare.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `docs/test.md` — 規約・作業記録の文書。断定と実装の一致は該当モジュールで確認した
- `infra/cloudflare/pulumi/resources/Pulumi.production.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/resources/Pulumi.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/resources/index.ts` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/routes/Pulumi.production.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `infra/cloudflare/pulumi/routes/Pulumi.yaml` — Pulumi のリソース / ルート定義。秘密は wrangler secret 側で、テンプレートを直接確認した
- `packages/core/package.json` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/directoryLocator.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/env.d.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/setup.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/directoryLocator.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/mappingOperations.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/payloadDigest.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/jobs/registry.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/platform/envelope.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/platform/stubErrors.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/schema/gate.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/schema/types.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/schema/userData.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/search/normalize.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/search/probe.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/search/projection.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/adapters/cloudflare/sql/errors.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/sql/exec.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/sql/occ.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/cloudflare/userData/accountStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/userData/trashQuery.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
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
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/__tests__/helpers.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/di/__tests__/secrets.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/di/containerStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/di/env.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/di/facades.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/di/secrets.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/di/stateCloudflare.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/di/types.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/errors.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/events/buildDecoder.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/execution/jobs.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/execution/unitOfWork.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/identity/__tests__/logout.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/identity/__tests__/requestPasswordReset.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/identity/eventDecoders.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/identity/getCurrentUser.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/identity/registerWithPassword.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/identity/signupSaga.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/identity/view.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/ports/idGenerator.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/ports/idempotencyStore.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/ports/outboxRepository.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/ports/relayTrigger.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/ports/sessionCodec.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/application/rpc/restoreError.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/workers/__tests__/outboxPrune.test.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/workers/eventRelayWorker.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/application/workers/outboxPrune.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/common/event.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/common/transactionalRepository.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/__tests__/credentialMappingRules.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/domain/identity/__tests__/entity.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/domain/identity/__tests__/noRawNul.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/domain/identity/__tests__/valueObject.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/domain/identity/entity.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/events.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/identity/ports/accountStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/ports/credentialLocatorStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/ports/mailSender.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/ports/userRepository.ts` — 削除の確認のみ（対象消滅）
- `packages/core/src/domain/identity/ports/userSettingsRepository.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/domain/identity/valueObject.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/lib/__tests__/jobKind.test.ts` — テスト。対応する本体を直接確認した
- `packages/core/src/lib/errorIdentity.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/lib/jobKind.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/lib/passwordHashing.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/lib/rpcEnvelope.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `packages/core/src/lib/secretLengths.ts` — 1・2周目で確認済みで、wave 3 の修正コミット（21fd944 / e56785a）では変更されていない
- `pnpm-lock.yaml` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `spec/database/index.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/domains/identity.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/inventory/adapter.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/inventory/domain.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/inventory/usecase.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/manual-tests/search.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/testcases/identity/unlinkSsoCredential.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `spec/usecases/identity.md` — 仕様文書。実装との一致は該当モジュールで確認した
- `vitest.config.integration.ts` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `vitest.config.smoke.ts` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した
- `vitest.config.ts` — ビルド・デプロイ構成。秘密は含まれず、request / state の分離はテンプレートで確認した

**確認 44 + スキップ 215 = 259**
