# design — 実装で確定した共有契約

`spec/` が正本。ここには `spec/` の該当箇所への参照と、`spec/` が定めない実装レベルの決定だけを置く。`spec/` に反映した決定は参照へ置き換える。根拠となる調査は `phases/PH-00.md`。

## 要件 → ドメイン / ポートの対応

| 要件 | 実現するドメイン・ポート（`spec/domains/*.md`） | DO |
|---|---|---|
| S-AC-* | identity: `User` / `AiClientConnection`、`CredentialMappingRepository`（Reader / Writer / AttemptRecorder）、`UserSettingsRepository`、`AccountStore`、`CredentialLocatorStore`、`PasswordHasher`、`PasswordResetTokenPort`、`PasswordResetThrottlePort`、`MailSender`、`AiClientConnectionRepository` | Identity Directory（写像・トークン・窓）/ User Data（settings・account・locators・connections） |
| S-TL-* | memo: `Memo` / `MemoRevision`、`MemoRepository`（timeline / revisions / summaries） | User Data |
| S-DT-* | knowledge: `Topic` / `Document` / `DocumentRevision` / `SourceLink`、`TopicRepository` / `DocumentRepository` | User Data |
| S-SE-* | search: `SearchQuery` / `SearchResult`、`SearchIndexPort`（読みのみ。projection は memo / knowledge のリポジトリが同一 tx で書く） | User Data |
| S-TR-* / S-ST-01 | trash: `TrashQueryPort`、復元・ハードデリートは memo / knowledge のリポジトリ経由、`purge-trash` ジョブ | User Data |
| S-ST-02 | export: `ExportSourceReader`、`ArchiveWriter`（同期） | User Data（読み）+ request Worker（zip） |
| S-AI-* | identity の `TokenScope` / `AiClientActor` + 各ドメインの AI 用ユースケース（`spec/usecases/*.md` の「AI API 用」） | request Worker（認可）→ User Data |

## 決定事項

### D-01 lockfile / D-02 biome

- `pnpm-lock.yaml` は PH-01 の最初のコミットで `package.json` に追随させる。`biome migrate` も同時に行う。

### D-03 DI コンテナとゲートウェイ（PH-00 4-g）

- `RequestContainer`（`packages/core/src/application/di/types.ts`）は既存テストが固定する形を採る: `{ config: AppConfig; identityGateway; identityTuning; memoGateway; knowledgeGateway; passwordHasher; sessionCodec; clock; idGenerator; logger }`。フェーズが進むごとに `searchGateway` / `trashGateway` / `exportGateway` を**同じ階層に**足す（ドメインごとに 1 ゲートウェイ。User Data DO をまとめた単一ゲートウェイにはしない）。ゲートウェイの `tripping*` フェイクは総称実装（メソッド追加で赤くなる）とし、`application/__tests__/fakes/` に置く。
- `AppConfig` は `head.ts` が読む 6 フィールド。`@repo/core/config` は `content`（`appUrl` を除く定数）を export する。
- `application/di/serverCloudflare.ts`: `readRequestServerConfig(env)` / `createRequestContainer(config)` / `createQueueContainer(env)`。秘密は `RequestSecrets` にネストする（`secrets.ts` の規約）。
- `IdentityTuning` の既定値は `docs/runtime_cloudflare.md` 12.2 / 12.4 の値を採る。`PasswordHasher` は WebCrypto PBKDF2-SHA256（`createPbkdf2PasswordHasher({ iterations })`、既定 100,000。docs に値があればそれを優先）。

### D-04 AI API（PH-00 4-a）— PH-07 で実装

- トランスポート: **MCP Streamable HTTP（stateless、JSON 応答、SSE なし）を `POST /mcp`** に置く。`GET /mcp` は 405。JSON-RPC（`initialize` / `ping` / `tools/list` / `tools/call`）は**自前実装**（`@modelcontextprotocol/sdk` は入れない。zod 版の衝突と Workers 互換の確認コストを避ける）。
- 置き場所: `apps/web/app/server.cloudflare.ts` の `fetch` で `/mcp`、`/oauth/*`、`/.well-known/oauth-*`、`/api/ai/*` を TanStack Start へ渡す前に自前ルーティングする。ハンドラ本体は `apps/web/app/presentation/ai/`。
- OAuth 2.1: `/oauth/authorize`（GET。未ログインは `/login?redirect=` 経由で P-14 へ。許可で `code` 付きリダイレクト、拒否で `error=access_denied`）、`/oauth/token`（`authorization_code` + PKCE S256 必須、`refresh_token` あり）、`/oauth/register`（stateless DCR: `client_id` = 署名済みメタデータ blob。`redirect_uri` は登録済みと完全一致）、`/.well-known/oauth-authorization-server`（RFC 8414）と `/.well-known/oauth-protected-resource`（RFC 9728）。
- トークン: HMAC 署名の自己完結値。access `{ userId, connectionId, scope: "ai", exp }` TTL 1 時間、refresh TTL 30 日。鍵は `AI_CLIENT_TOKEN_SECRET`（request Worker。`.dev.vars.example` に追記）。認可コードは署名済み自己完結値（`jti`、PKCE challenge、`clientId`、`redirectUri`、`userId`、`connectionId`、`exp` 10 分）。
- 交換済みコードの `jti` 表: User Data DO に `oauth_consumed_codes (jti TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`（adapter-owned。`spec/database/index.md` L985 が名前未確定としている表）。交換 RPC の同一 tx で期限切れ行を削除する（新しい `jobs.kind` は足さない）。→ Manager が `spec/database/index.md` に反映する（PH-07）。
- 認可ミドルウェア: 毎回 `AiClientConnectionRepository.findActiveById` を引き、失効済みは 401。`recordUsage` は best-effort。許可ユースケースの列挙は `apps/web/app/presentation/ai/tools.ts` に置き、`spec/usecases/*.md` の 11 ツール（`search` / `get` / `list_topics` / `recent_memos` / `post_memo` / `update_memo` / `create_topic` / `update_topic` / `create_document` / `edit_document` / `delete`）と一致することをテストで固定する。
- REST: `POST /api/ai/<tool>`（Bearer、JSON body = ツール引数）を MCP と同じ配線で出す。
- テストクライアント: `apps/web/scripts/ai-client.ts`（Node 24 の型ストリップで実行。DCR → 認可 URL → code → token → `tools/call`）。

### D-05 永続化（PH-00 4-h）

- DO 内は生 SQL（`sql.exec` + `updateMatchedRow`）で統一。drizzle は使わない。
- D1 一式（`packages/core/src/adapters/d1/*`、`apps/web/drizzle.config.ts`、`drizzle-orm` / `drizzle-kit` 依存、`wrangler*.toml` の `[[d1_databases]]`、`vitest.config.d1.ts` と `vitest.config.integration.ts` の該当 project、root / web の `db:*` スクリプト）を PH-01 で削除する。Pulumi の D1 リソースは対象外なので触らない（`README.md` にその旨を書く）。
- 両 DO の `MigrationPlan` v1 は `adapters/cloudflare/schema/userDataPlan.ts` / `identityDirectoryPlan.ts`。初回デプロイ前なので v1 を in-place で拡張する（`spec/database/index.md`）。**PH-01 で両 DO の全表の DDL（`spec/database/index.md` の 24 表）を v1 に入れる。** ストア・リポジトリは各フェーズで足す。
- UoW コンテキスト（`application/execution/unitOfWork.ts`）の roster は `spec/database/index.md` の宣言に合わせて**フェーズごとに増やす**。PH-01 では未実装のポート（knowledge の 2 リポジトリ等）をコンテキストから外してよい（仮実装のスタブは置かない）。

### D-06 表示ライブラリ（PH-00 4-e）

- Markdown: `react-markdown` + `remark-gfm`（RSC で React 要素へ描く。raw HTML は描かない）。
- 差分: `diff`（jsdiff）を直接依存に昇格し、`diffLines` の結果を `spec/design/pages/memo-history.html` の行単位 unified 形式で自前描画する。
- `DocumentPatch`（AI の部分編集）はドメイン内の文字列置換。ライブラリなし。

### D-07 開発用アダプター（PH-00 4-b / 4-c / 4-d）

- SSO: presentation 専用ポート `SsoIdentityProvider`（`application/ports/ssoIdentityProvider.ts`。`SessionCodec` と同じく usecase から参照禁止）: `buildAuthorizationUrl(provider, state)` / `exchangeCode(provider, code)` → `{ providerSubject, email } | "cancelled"`。開発用スタブは `SSO_DEV_STUB="true"`（`.dev.vars` のみ。deployed configs には置かず `wranglerConfig.test.ts` で固定）で有効になり、`/__dev/sso/:provider/authorize` に subject / email の入力フォーム（許可 / キャンセル）を出して `/auth/sso/:provider/callback` へ戻す。`state` は署名付き cookie。実 IdP アダプターは資格情報があるときだけ走る契約テストを置く。
- MailSender: 開発用 console sink。`MAIL_DEV_SINK="console"`（`.dev.vars` のみ）のときだけ `[dev-mail] to=<addr> url=<reset url>` を 1 行出す。**これは `spec/async/index.md` の衛生規則の意図的な例外**なので、Manager が PH-06 で同ファイルへ「開発専用 sink」として宣言を追加する。deployed configs では無効（`wranglerConfig.test.ts` で固定）。本番 provider アダプターは資格情報があるときだけ走る契約テスト。
- セッション: `apps/web/app/presentation/currentUser.ts` に `getCurrentUserId()`（cookie → `sessionCodec.verify` → `identityGateway.readAccountState` → `sessionEpoch` 比較。未初期化・不一致・失効はすべて `null`）と `requireUserId()`（`redirect({ to: "/login", search: { redirect } })`）。`readAccountState` は `SystemError(NotInitialized)` をそのまま通し、**畳むのは認証ミドルウェア（`currentUser.ts`）だけ**（`spec/usecases/identity.md` getCurrentUser のエラーケース。PH-01 検証 F-1 で訂正）。`getCurrentUser` の `USER_NOT_FOUND` は初期化済み DO に settings 行が無い場合に限る。Cookie / codec TTL は既存の 7 日。保護ルートは `apps/web/app/routes/_app.tsx` の `beforeLoad` でガードし、`noStoreMiddleware` を付ける。

### D-08 ユースケースの実行位置と DO facade（PH-00 4-f）

- VO の再構築・ドメイン遷移・リポジトリ操作は **DO 内の `runUnitOfWork`** で走る（`CLAUDE.md`「RPC hop は第三の検証点ではない」）。`application/<domain>/<usecase>.ts` に request 側関数（`ServiceArgs<TInput>` → gateway → View）と DO 側 `xxxProcedure(ctx, input, now, ids)`（同期）を並置し、DO クラスの facade メソッドが `this.envelope(() => this.runUnitOfWork(ctx => xxxProcedure(...)))` を呼ぶ。
- facade はユースケースごとに 1 メソッド。引数は primitives のみ、戻りは `RpcEnvelope<T>`。
- スタブ選択: `adapters/cloudflare/doStubs.ts`（`userId` → `USER_DATA.idFromName(userId)`、canonical → `deriveLocator` → `IDENTITY_DIRECTORY.idFromName("dir:g{gen}:b{idx}")`）と `callDurableObject`（envelope 展開 → `rebuildRpcError`、スタブ呼び出し自体の失敗 → `SystemError(DatabaseError)`）。
- `jobRegistry` / `terminalStage` は各 DO クラスのコンストラクタで束ねる。saga ジョブが cross-DO RPC を打つので `wrangler.state.toml` に自己参照の DO bindings を足す（`wranglerConfig.test.ts` を更新）。
- 実行時 ID: request 側で採番するのは DO 選択前に要る `userId` / `credentialId` / `operationId`（`spec/usecases/identity.md` の手順どおり）だけ。エンティティ ID と `EventId` は DO 側の UoW 実装が `IdGenerator` で採番する（PH-01 J-04）。
- 乱数トークン: `application/ports/tokenGenerator.ts` の `TokenGenerator { next(): string }`（128 bit 以上の暗号論的乱数）。WebCrypto アダプターと `FakeTokenGenerator`。`caller_token`（PH-01）、リセットトークン（PH-06）、認可コードの `jti`（PH-07）が使う。application 層で `crypto.getRandomValues` を直接呼ばない（PH-01 J-05）。

### D-09 その他

- 秘密の追加時期: `AI_CLIENT_TOKEN_SECRET`（request、PH-07）、`IDENTITY_RESET_TOKEN_KEY`（state、PH-06）。追加時に `.dev.vars.example` の帰属表を更新する。
- エクスポート zip: `fflate` の `zipSync`（`ArchiveWriter` は同期契約）。
- カーソル: base64url の JSON。タイムラインは keyset（`posted_at DESC, id DESC`）、検索は snapshot cursor（`spec/domains/search.md`）。
- FTS5 `tokenize='trigram'` は workerd 1.20260508.1（miniflare 4.20260508.0）で動作を実測済み（PH-01 報告、2026-09-08T01:46+09:00）。`spec/database/index.md` の方針どおり採用。
- vite dev では RSC を含む SSR ストリームが閉じずハイドレートしないため、ストリーミングルートは共有定数（`apps/web/app/presentation/streamingRoute.ts`）で dev のみ `ssr: false` にする（PH-01 J-01）。**限界: dev のブラウザ検証は SSR ストリーミング経路を通らない。** SSR 経路の確認は `pnpm build && pnpm preview` で行う。
- `components/ui/Deferred` は `use(useDeferredValue(promise))`（`router.invalidate()` で loader の promise が差し替わってもフォールバックへ落ちず、解決済み内容を保持して re-base する。PH-01 J-02）。
- operator 経路の HTTP 面（`/__operator/<entry>`）は PH-09。ローカル保護は `OPERATOR_TOKEN`。
- ブラウザのタイムゾーンはエクスポートフォームの hidden 入力で渡す。
- 新しい `*Error` クラスは `lint/no-instanceof-error.grit` の ban list に追記する（`lint/banList.test.ts`）。
- 終端モード（`spec/recovery/index.md`）の `terminal_reason` 6 値語彙・接頭辞付与・材料喪失の即 `poison` は `jobRunner` の拡張が要る（PH-00 3.2）。PH-09 で `JobHandlerResult` に `poison` 分岐を足す。
- `docs/*.md` の前回ビルド由来の記述（`Promise` を返す旧 `TransactionalRepository`、`lib/server/currentUser.ts`、fakes の roster、`RequestContainer` の形、D1 / drizzle）は PH-10 で現状に合わせる。

### D-10 PH-03 ナレッジの判断（`phases/PH-03.md` △-1〜△-9）

- △-1: `DocumentBody` の transport 上限は zod `.max(800_000)`（UTF-16 単位。コードポイント上限 400,000 の 2 倍）。業務上限は VO だけが判定する。
- △-2: P-09 新規モードの出典メモ検索は PH-02 の `getTimeline`（keyword 絞り込み、limit 20）を `loadTimelinePageFn` 経由で再利用する。PH-04 後も差し替えない。
- △-3: 新規作成では変更理由欄を出さない（application が「作成」を補完）。編集モードのみ欄を出し、省略時は「手動編集」。
- △-4: `spec/domains/knowledge.md`（出典は作成時のみ）を正とし、編集モードの出典欄は読み取り専用。`spec/design/pages/document-edit.html` の編集モードにある「出典から外す / 追加」は Manager が spec 側を直す（PH-03 受け入れ時）。
- △-5: P-10 は P-05 と同じ二点選択。1 点目（比較元）を選んだ時点で最新との差分を出し、2 点目で切り替える。「この内容に戻す」は比較元に対して出す。
- △-6: 完了済み（archived）トピック配下へのドキュメント作成は許可し、P-07 の「新しいドキュメント」は archived でも出す。
- △-7: `listDocumentsReferencingMemo` は usecase / facade / gateway / integration テストまで実装し、画面からは呼ばない（消費者候補は P-05 ヘッダ。PH-10 で決める）。
- △-8: `ActorView` / `toActorView` は `application/identity/view.ts` に置き、memo / knowledge が import する（`memo/view.ts` は再 export で互換）。
- △-9: 関連メモ / 出典メモの `snippet` は `lib/text.ts` の `snippetOf` を使う（既存の 140 コードポイント + `…`。改行は空白に畳む拡張を同関数に入れる）。新しい定数は作らない。

### D-11 PH-04 検索の判断（`phases/PH-04.md` △-1〜△-3）

- △-1: snapshot cursor はカーソル自体に順位順の ID 集合（type 1 byte + UUID 16 byte）を base64url で埋め込む。集合の上限 500 件、期限 30 分。表を増やさず、読みで書かない。→ `spec/database/index.md`「決めていないこと」に反映する（PH-04 受け入れ時）。
- △-2: キーワードは入力全体を 1 フレーズとして FTS5 に引用して渡す部分一致（演算子・`*` を解釈させない）。3 文字未満は `instr()` フォールバック。
- △-3: 集合を 500 で切り、`count` は切った後の件数。
- 共有契約: `RequestContainer.searchGateway`、`UserDataUnitOfWorkContext.searchIndex`（読み取り専用）、`SystemErrorCode.SearchIndexUnavailable`。

### D-12 PH-05 ゴミ箱の判断（`phases/PH-05.md` △-1〜△-9）

- すべて推奨案を採用: ナビ「ゴミ箱」は検索と設定の間（design HTML の全ページに既にあるので spec 側の変更なし）、P-12 は先頭 100 件 + もっと読む、残り日数は `ceil((expiresAt − now) / 日)` で 0 以下は「まもなく削除」、保持日数はドメイン上限なし・zod 36,500・UI に max なし、復元先トピック候補はダイアログを開いた時点で遅延取得、excerpt は `snippetOf`、`emptyTrash` / `purge-trash` は項目ごとに逐次の `run`（入れ子禁止）、ハードデリートは FTS5 の delete コマンドを含めて同一 tx（10 GB 逼迫時は項目単位で巻き戻る限界を JSDoc に明記）、`documentRepository.delete` の既存 cascade を再利用。

### D-13 PH-06 認証の残りの判断（`phases/PH-06.md` △-1〜△-8）

- △-1: 本番 `MailSender` は Resend の REST（`Idempotency-Key` = `providerIdempotencyKey`）。差出人 `MAIL_FROM_ADDRESS` は request Worker の var。契約テストは `MAIL_PROVIDER_API_KEY` と `MAIL_CONTRACT_TEST_TO` が無ければ skip。
- △-2: `ai_client_connections` への最小ストア `aiClientConnectionRevoker`（`revokeCreatedAtResetVersion` / `revokeAll`）を UoW ctx に置き、PH-07 の repository で置き換える。`revokeAllAiClientConnections` は本フェーズで usecase まで。
- △-3: SSO state cookie の鍵は `SESSION_SECRET` から用途ラベル `"fog:sso-state"` で派生した鍵（同じバイト列を別用途に使わない）。
- △-4: リセット URL は `${APP_URL}/password-reset?token=<raw>`。再設定画面は no-referrer、送信後は `/password-reset/done` へ遷移して token を落とす。
- △-5: 変更 / リセットの saga は request 側が全 phase を同期に試み、落ちたら `resume-credential-change` が引き取る。
- △-6: SSO callback の結果は URL クエリで運ぶ（`/login?sso_error=…`、`/settings?sso=linked` / `?sso_error=already_used`）。
- △-7: `changePassword` の `TOO_MANY_ATTEMPTS` はフォームがそのまま「試行が制限されています」と出す（P-01 は隠す）。
- △-8: dev / preview の「メールが届く」は console sink の `[dev-mail]` 行で確認。Mailpit は置かない。
- spec との差（承認済み、受け入れ時に spec へ反映）: `PasswordResetTokenPort.verifyAndConsume` の戻り値を `{ userId, credentialId, changeAuthToken } | null` に拡張。生トークンは `${generation}.${bucketIndex}.<secret>` の形で request 側が先頭 2 区画から bucket を選ぶ。

### D-14 PH-07 AI 接続の判断（`phases/PH-07.md` △-1〜△-12）

- すべて推奨案を採用: `AI_CLIENT_TOKEN_SECRET` 1 本から用途ラベルで 5 鍵を派生。refresh token は一回性にせず（表を足さない）access 1 時間 / refresh 30 日・交換ごとに新 refresh・失効は `status` で即時。`client_id` 検証不能 / `redirect_uri` 不一致は P-14 のエラー状態、他の不正は `redirect_uri?error=`。認可ミドルウェアは `authorizeAiClient` 1 RPC（`findActiveById` + best-effort `recordUsage`）。MCP は `2025-06-18` の stateless Streamable HTTP、batch は 400、`Origin` 検査、`z.toJSONSchema`。ツールの業務エラーは `isError: true` の JSON、REST は HTTP ステータス + `{ error }`。検索カーソルは署名しない（PH-04 O-2 を閉じる）。接続一覧は active のみ。`revokeAll` は spec の `{ revokedCount, failedCount }`。scope は `"ai"` 固定。`client_id` は無期限、`redirect_uris` は https か loopback の完全一致。リセット時の自動失効はリポジトリ経由で PH-06 の revoker を置き換える。

### D-15 PH-08 エクスポートの判断（`phases/PH-08.md` △-1〜△-10）

- すべて推奨案を採用: DO 側で本文バイト合計を先に集計し 24 MiB 超は `SystemError(ExportTooLarge)`（`retryable: false`、P-13 に個別文言）、`POST /export` は bare handler で `presentation/requestSession.ts` を SSO と共用、UI は fetch + Blob + `<a download>`（form POST の progressive enhancement）、zip は `mtime = exportedAt` で決定的、P-13 の「データ」節は「ゴミ箱の保持期限」の直後、DTO の日時は epoch ms、ファイル名は ASCII 固定、多日メモは integration で固定、`_meta.self_locator` はアーカイブに載せない（spec/database の用途文言を訂正済み）。`SystemErrorCode` に `ExportTooLarge` / `ArchiveEncodingError` を追加。

### D-16 PH-09 の判断（`phases/PH-09.md` △-0〜△-15）

- すべて推奨案を採用。要点: PH-09A（recovery + jobRunner + operator + DLQ）→ PH-09B（rotation + reindex / migrate-bulk）の 2 サブフェーズ。`terminal_reason` は 6 値トークン + 空白 + `operationId`。`ConflictError` はその起床で前進不能を確定。`finalize-withdrawal` は放棄経路（`abandon-account`）からのみ駆動し、退会の起点 usecase は範囲外（`beginWithdrawalProcedure` を用意するにとどめる）。退会で消すのはアカウントの到達性のみ（tombstone を残す）。`terminalStage(row, sql)`。keyring / コミットメント / 暗号 keyring は JSON 変数 3 つ（`DIRECTORY_ROUTING_KEYRING` / `DIRECTORY_KEY_COMMITMENT` / `IDENTITY_MAIL_ENCRYPTION_KEYRING`）、未設定なら従来の単一変数から単一世代。起動 RPC は `start-rotate-encryption`。DLQ は自動 1 回再配送 → ack。`OPERATOR_TOKEN`（request、≥32 文字、未設定なら `/__operator/*` は 404）。operator 一覧は keyset、page 50。`reindex` は `migration_progress` のカーソル、`migrate-bulk` は `MigrationStep.bulk`。`purge-user-mappings` は bucket RPC。世代ガード落ちの再予約は `ConflictError("GENERATION_MISMATCH")` で終端モードへ。`record-remapped-locator` の `usableForLogin` / `label` は移送元行から。
- spec / docs への反映（PH-09 受け入れ時に Manager）: `terminal_reason` の区切り、`start-rotate-encryption`、DLQ 自動 1 回、`OPERATOR_TOKEN`、keyring 変数名、withdrawal の消す範囲、`GENERATION_MISMATCH`。

## `spec/` への反映待ち

| 決定 | 反映先 | 時期 |
|---|---|---|
| `oauth_consumed_codes` 表（D-04） | 反映済み（`spec/database/index.md`「本ファイルで定義しないテーブル」） | — |
| 開発用 mail console sink の例外宣言（D-07） | 反映済み（`spec/async/index.md` 衛生規則） | — |
| `verifyAndConsume` の戻り値と生トークンの形（D-13） | 反映済み（`spec/domains/identity.md` PasswordResetTokenPort） | — |
| PH-09 の決定 7 点（D-16） | spec は反映済み（`terminal_reason` の形 / DLQ 自動 1 回 / withdrawal の範囲 / keyring 変数と `start-rotate-encryption` / `GENERATION_MISMATCH`）。`OPERATOR_TOKEN` と操作手順は `docs/runtime_cloudflare.md`（PH-10） | PH-10 |
| snapshot cursor の物理形（D-11 △-1） | 反映済み（`spec/database/index.md`「本ファイルで定義しないテーブル」の節） | — |
| FTS5 trigram の実測結果（D-09） | 反映不要（spec の方針どおり動作。実測の記録は本ファイルと `phases/PH-01.md`） | — |
| P-09 編集モードの出典操作を外す（D-10 △-4） | 反映済み（`spec/design/pages/document-edit.html` に新規作成モード限定の注記） | — |
