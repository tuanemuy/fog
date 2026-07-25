# 実装計画 — Issue #1: [skeleton] 基盤＋アカウント登録・ログイン

**Issue:** #1
**作成日:** 2026-07-25
**複雑度:** 中〜大規模

---

## 目的

fog の永続化スキーマ・共通基盤（outbox / OCC ガード）・認証セッション・グローバルナビ・起動導線をテンプレート状態から fog の実体へ移行し、パスワードによるアカウント登録 → ログイン → ログアウトを end-to-end で動かす walking skeleton を成立させる。

## 受け入れ基準

Issue のチェックリスト75行は「チェックリスト対応表」で1行ずつステップに紐づける。本表はそれを検証可能な単位に束ねたもの。

| # | 基準（検証可能な形で） | 由来 | 対応ステップ |
|---|---|---|---|
| AC-1 | `identity` ドメインの値オブジェクト（UserId / Email / PlainPassword / PasswordHash / TrashRetentionDays / Actor）が spec/domains/identity.md の制約どおり `create` で検証し、違反時に `BusinessRuleError<IdentityErrorCode>` を throw する（DOM-identity-003/005/006/007/010/011） | Issue チェックリスト | 4 |
| AC-2 | `User` エンティティが `PasswordUser \| SsoUser` の判別可能ユニオンで、`registerWithPassword` / `registerWithSso` / `changePassword`（PasswordUser 限定）/ `changeTrashRetentionDays` を純関数ファクトリとして提供し `WithEventDrafts` を返す（DOM-identity-001） | Issue チェックリスト | 5 |
| AC-3 | `identity.userRegistered` が識別子なしドラフトとして発行され、登録ユースケースと同一トランザクションで outbox に記録される（DOM-identity-013 / TC-registerWithPassword-001） | Issue チェックリスト | 5, 12, 24 |
| AC-4 | `UserRepository`（insert / save / findById / findByEmail）と `PasswordHasher`（hash / verify）がドメインのポートとして宣言され、OCC 規約（`ExpectedVersion` トークン）に従う（DOM-identity-018〜021 / 029 / 030） | Issue チェックリスト | 6 |
| AC-5 | `users` テーブルが**名前付き制約6本 + インデックス2本**（認証方式の直和 CHECK・`users_auth_method_valid`・`users_sso_provider_valid`・`users_sso_subject_nonempty`・**`users_trash_retention_positive`（`trash_retention_days >= 1`。どの直和 CHECK にも含まれない独立の不変条件）**・`users_email_uq`・部分一意 `users_sso_identity_uq`）を持ち、共通基盤テーブル（outbox / processed_events / _occ_guard）とともに fog の初期マイグレーションとして生成・適用できる（ADP-users-001 / ADP-outbox-001 / ADP-processed-events-001 / ADP-occ-guard-001） | Issue チェックリスト | 7 |
| AC-6 | `UserRepository` の実装が d1 / libsql 双方にあり、OCC 0行更新を `ConflictError("OPTIMISTIC_LOCK_FAILURE")`、不整合行を `SystemError(DataIntegrityError)` に翻訳する。**email 一意制約違反の `ConflictError("EMAIL_ALREADY_REGISTERED")` への翻訳点はリポジトリではなく `registerWithPassword` ユースケース境界**（遅延バッチ UoW では制約違反が flush 時にしか出ないため → ADR-008）。ユーザーから見た結果（重複メールで `EMAIL_ALREADY_REGISTERED` が返る）は事前検証経路・レース経路のどちらでも同じ（ADP-identity-001〜004） | Issue チェックリスト | 8, 12 |
| AC-7 | `PasswordHasher` の実装がタイミングセーフに照合し、不一致をエラーではなく `false` で返す（ADP-identity-012 / 013） | Issue チェックリスト | 10 |
| AC-8 | `registerWithPassword` / `loginWithPassword` / `logout` / `getCurrentUser` の4ユースケースが spec/usecases/identity.md の処理フロー・エラー契約どおりに動く（UC-identity-001 / 003 / 004 / 013） | Issue チェックリスト | 12 |
| AC-9 | 未ログインで `/` にアクセスすると `/login` へリダイレクトされ、ログイン成功後に元の URL（既定は `/`）へ戻る | spec/pages/index.md 共通レイアウト（**インベントリ ID 未採番**のため Issue チェックリストには現れない）・spec/scenario/account.md S-AC-03 / manual TC-22 | 15, 18, 21 |
| AC-10 | `/login` からメール＋パスワードでログインでき、失敗時は「メールアドレスまたはパスワードが正しくありません」を表示し再入力できる。送信中はボタン無効＋進行表示（PAGE-login-001 / 002） | Issue チェックリスト | 18 |
| AC-11 | `/login` に `/signup`・`/password-reset` への導線があり、双方とも遷移できる（PAGE-login-004 / 005） | Issue チェックリスト | 18, 20 |
| AC-12 | `/signup` からメール＋パスワードで登録でき、成功でタイムラインへ遷移する。メール形式不正・パスワード要件未満は項目ごとに、登録済みメールは重複エラー＋ログイン導線として表示される。**送信中はボタン無効＋進行表示となり、連打しても登録は1回だけ実行される**（PAGE-signup-001 / 002、manual TC-13 / 14 / 15 / 34 / 35 / 36） | Issue チェックリスト | 19, 25 |
| AC-13 | `/signup` に `/login` への導線があり遷移できる（PAGE-signup-004） | Issue チェックリスト | 19 |
| AC-14 | 認証後の全画面がグローバルナビ（タイムライン / トピック / 検索 / ゴミ箱 / 設定）を共有し、PC はサイドバー・モバイルは**下部タブ相当**（承認済みデザイン `spec/design/pages/timeline.html` の実装形はヘッダーのメニューから開く下部シート）で現在地を明示する。各項目から対応画面へ遷移できる（PAGE-common-001） | Issue チェックリスト | 21 |
| AC-15 | ログアウトするとセッションが破棄され `/login` に戻り、以後保護画面へアクセスできない（ブラウザの戻るボタンでも復元されない = manual TC-23）（UC-identity-004、S-AC-04） | Issue チェックリスト・spec/scenario/account.md | 15, 22, 25 |
| AC-16 | TC-registerWithPassword-001〜016 / TC-loginWithPassword-001〜011 / TC-logout-001〜003 / TC-getCurrentUser-001〜009 の各期待結果が自動テスト（一部は手動テスト）で確認できる | Issue チェックリスト | 24 |
| AC-17 | `pnpm typecheck && pnpm lint:fix && pnpm format && pnpm test` が通り、`pnpm db:migrate && pnpm dev` で起動導線が成立する。**各実装ステップの完了時点でも `pnpm typecheck` が通る**（ステップ順序はそのように組んである） | CLAUDE.md「Development Commands」 | 全ステップ |
| AC-18 | 新規に書く UI がデザイントークン外の生値（`bg-neutral-200` / `text-red-500` 等のテンプレート既定パレット由来クラス）を含まない。`Skeleton` を含む既存プリミティブもトークン差し替え後に視認できる | spec/design/index.md「トークン外の生値を書かない」 | 16, 17 |

## スコープ

### 対象シナリオ ID の読み替え

Issue 本文は対象シナリオを「S-AC-01 アカウント登録」「**S-AC-02** ログイン / ログアウト」と書いているが、`spec/scenario/account.md` の実体は **S-AC-02 = SSO による登録・ログイン**、**S-AC-03 = パスワードログイン**、**S-AC-04 = ログアウト**。チェックリストに `PAGE-login-003` / `PAGE-signup-003` / `UC-identity-002`（いずれも SSO）が存在しないことから、本スライスの対象は **S-AC-01 / S-AC-03 / S-AC-04** と解釈する。Issue 本文の「S-AC-02」表記は誤記として扱い、SSO の S-AC-02 はスコープ外。

### 含まれないもの

- **SSO（S-AC-02 / PAGE-login-003 / PAGE-signup-003 / UC-identity-002）** — チェックリストに含まれない。デザイン HTML（login.html / signup.html）には SSO ボタンがあるが、動かないボタンを置くのはデザイン方針（「UI は言葉で説明しない」＝嘘の導線を作らない）に反するため、本 Issue では SSO ボタン自体を描画しない。`SsoUser` の**型・スキーマ列・再水和**だけは TC-getCurrentUser-002 / 004 と `users` テーブル設計（ADP-users-001）が要求するので実装する
  - この判断は `spec/manual-tests/account.md` **TC-01 の確認ポイント「SSOボタン…が表示されている」と意図的に乖離する**。本スライスでは SSO 未実装のため、TC-01 は SSO ボタン以外の項目（メール欄・パスワード欄・「アカウント登録」導線・「パスワードをお忘れですか？」導線）だけを確認する。PR 説明と手動テスト結果に同じ注記を残す（→ ステップ25）
- **SSO 主体の一意制約違反（`SSO_IDENTITY_ALREADY_REGISTERED`）の翻訳** — `ADP-identity-001` / `DOM-identity-018` の要点はこの翻訳も含むが、SSO 登録ユースケース（UC-identity-002）を配線しない本スライスでは `users_sso_identity_uq` を発火させる経路が存在しない（`PasswordUser` の insert は sso 列が NULL なので部分一意インデックスの対象外）。両 ID は **email 制約側のみの実装**とし、SSO 制約側は SSO スライスで完了させる。制約を区別するための設計上の解は「設計」節と ADR-008 に記録した
- **テンプレート名の残滓の整理** — 次の2つはいずれも本 Issue では**変更しない**（影響範囲が本スライスと直交するため）
  - outbox テーブルの実名 `outbox_events`（spec/database は `outbox` と表記）— spec/database 自身が「テンプレート流儀にそのまま従い再定義しない」と明記しているので、**実装名 `outbox_events` を正とし spec 側の表記揺れとして維持する**。spec-sync の対象として別途拾う
  - `apps/web/wrangler.toml` / `.staging.toml.tpl` / `.production.toml.tpl` の D1 データベース名 `tanstack-start-template-d1*`、および `vitest.config.integration.ts` のキュー名 `tanstack-start-template-events*` — リネームは `db:migrate:cf` / `db:apply:*` / デプロイスクリプトに波及し、ADR-004（4ランタイム維持）の下では検証コストだけが増える。別 Issue に切り出す。ステップ11で fog 化するのは `packages/core/src/config.ts` の `content`（siteName / description）のみ
- **パスワードリセット本体（P-03 / UC-identity-005 / 006 / `password_reset_tokens` テーブル / MailSender）** — PAGE-login-005 が要求するのは「導線が機能する」ことのみ。`/password-reset` はプレースホルダールートに留める（→ ADR-007）
- **AiClientConnection 集約・そのリポジトリ・OAuth 認可（S-AC-05 / 06）・TokenScope VO** — チェックリスト外。ただし `Actor`（DOM-identity-011）が `AiClientActor` を持つため、その構成要素である `AiClientConnectionId` / `ClientName` VO のみ付随実装する
- **`changePassword` / `changeTrashRetentionDays` / `listAiClientConnections` 等のユースケース** — エンティティ側のファクトリは DOM-identity-001 の要件として実装するが、ユースケースは配線しない
- **memo / knowledge / search / trash / export の各ドメインとテーブル** — 後続スライス
- **`/topics`・`/search`・`/trash`・`/settings` の実画面** — グローバルナビの遷移先としてプレースホルダーのみ用意する（`/settings` はログアウトと `getCurrentUser` 表示だけ実装する）
- **タイムラインの実データ表示** — `/` は認証後シェル＋空状態のみ（Issue の「空でも可」に従う）
- **ランタイムの削除（cf / aws / gcp の撤去）** — 影響範囲が大きく本スライスと直交する（→ ADR-004）

## 調査結果

### 関連ファイル

**コア（テンプレートの規約源）**

| パス | 役割 |
|---|---|
| `packages/core/src/domain/todo/{valueObject,entity,events,errorCode}.ts` | ドメイン層の書き方の基準形（ブランド VO・判別可能ユニオン・`WithEventDrafts`） |
| `packages/core/src/domain/todo/ports/todoRepository.ts` | `TransactionalRepository<T, TId>` を extends する集約ポートの基準形 |
| `packages/core/src/domain/common/{transactionalRepository,event,version}.ts` | `ExpectedVersion` / `Versioned` / `EventDraft` / `Version` |
| `packages/core/src/domain/error.ts` | `BusinessRuleError` / `RehydrationError` |
| `packages/core/src/lib/error.ts` | `CodedError` / `SerializedErrorBase` / `FieldErrors` |
| `packages/core/src/application/errors/index.ts` | `NotFoundError` / `ConflictError` / `UnauthorizedError` / `ForbiddenError` / `SystemError` |
| `packages/core/src/application/execution/unitOfWork.ts` | `UnitOfWorkContext`（リポジトリスロットの唯一の増設点） |
| `packages/core/src/application/di/types.ts` | `SharedDeps` / `RequestContainer` / `WorkerContainer` / `AppConfig` |
| `packages/core/src/application/di/server{Node,Cloudflare,Aws,Gcp}.ts` | ランタイム別 DI ファクトリ（4本） |
| `packages/core/src/application/workers/eventRelayWorker.ts` | `AllDomainEvents` / `defaultEventDecoderRegistry`（新ドメイン追加時の必須更新点） |
| `packages/core/src/application/todo/{createTodo,listTodos,view,eventDecoders}.ts` | ユースケース・DTO 射影・イベントデコーダの基準形 |
| `packages/core/src/adapters/d1/schema.ts` | **全テーブル定義の唯一の出所**（`libsql/schema.ts` は `export * from "../d1/schema"`） |
| `packages/core/src/adapters/{d1,libsql}/unitOfWork.ts` | UoW 実装2本。リポジトリ生成の増設点 |
| `packages/core/src/adapters/{d1,libsql}/repositories/{todoRepository,helpers}.ts` | リポジトリ実装・`mapDbError` によるドライバ例外翻訳 |
| `packages/core/src/adapters/{d1,libsql}/migrations/0000_initial.sql` | 初期マイグレーション（現状 `todos` を含む） |
| `packages/core/src/config.ts` | `content`（siteName 等の AppConfig 既定値） |

**Web（TanStack Start）**

| パス | 役割 |
|---|---|
| `apps/web/app/presentation/serverAction.ts` | `loadServerDeps` / `serverData`（`serverAction` という export は**存在しない**） |
| `apps/web/app/presentation/errorResponse.ts` | `SerializedError` union の組み立て・`AppServerError`・`extractSerializedError`・`httpStatusFor` |
| `apps/web/app/presentation/errorResponseMiddleware.ts` | 唯一の redaction 境界。`isRedirect` / `isNotFound` はそのまま再 throw する |
| `apps/web/app/presentation/{validator,errorDisplay,head,pagination}.ts` | 入力検証・日本語エラー表示・head 生成・二重スキーマ（strict / coerce+catch）の基準形 |
| `apps/web/app/routes/__root.tsx` | `loadAppContext`（`match.context.config` の供給元）・`RootDocument`・**クライアント島の action モジュールの副作用 import** |
| `apps/web/app/routes/todo/{route,index,-action}.tsx` | レイアウトルート＋ストリーミングルートの基準形 |
| `apps/web/app/components/todo/CreateTodoForm/` | `useActionState` + `useServerFn` + `fieldErrors` のフォーム基準形 |
| `apps/web/app/components/todo/TodoShell/` | レイアウトルートの `component` にシェルを置く基準形 |
| `apps/web/app/styles/{index,tokens,theme}.css` | Tailwind v4。**テンプレート既定パレットのままで fog のトークンではない** |
| `apps/web/{drizzle.config.ts,drizzle.libsql.config.ts}` | マイグレーション生成設定（出力先は `packages/core/src/adapters/*/migrations`） |
| `apps/web/app/server.node.ts` / `scripts/{listen,migrate}.node.ts` | Node ランタイムの起動・マイグレーション導線 |
| `vitest.config.ts` / `vitest.config.integration.ts` / `vitest.config.integration.node.ts` | unit（node pool）/ integration（Miniflare D1 pool）/ integration（node pool・libsql） |

### あるべきアーキテクチャ

- ヘキサゴナル + DDD。依存は内向き（presentation → application → domain、adapters は内側で定義されたポートを実装）。`lib/` のみ層外の構造プリミティブ（CLAUDE.md）
- identity は「操作主体（Actor）と権限スコープの定義を一箇所に集約する」ドメイン（ADR-004）。`UserId` / `Actor` / `TrashRetentionDays` は他ドメインへ提供する横断定義であり、**identity 側の一箇所でのみ定義する**
- **セッション・OAuth のプロトコル詳細はドメインに置かない**（spec/domains/identity.md「スコープに関する注意」、spec/usecases/identity.md 共通事項）。ドメインが持つのは認可の事実と権限範囲のみ。Cookie / セッションはアダプター・presentation の責務で、DB 設計上もスコープ外（spec/database/index.md「認証インフラテーブルはスコープ外」）
- 入力検証は2点のみ：transport 境界（`inputValidator` / `validateSearch`）と VO 生成。ユースケースは静的型を信頼する
- 書き込みは必ず `UnitOfWorkProvider.run` 内。イベントは `collectEvents` 経由で同一トランザクションの outbox へ
- エラーは `kind` タグ付きシリアライズ形を各層が持ち、presentation が構造的に直列化する。HTTP ステータス割り当ては presentation のみ
- フロントは「サーバーコンポーネントで取得 → `"use client"` 島で操作 → React 19 プリミティブで即時フィードバック」の三層。フォームは `useActionState`、`router.invalidate()` で整合を取る
- スキーマは SQLite 型アフィニティ。ID は TEXT・日時は `integer(timestamp_ms)`・集約ルートに `version`・直和型は「判別タグ + nullable 列 + CHECK」（spec/database/index.md 共通方針）

### 既存実装の状態

**一致している（そのまま踏襲する）**

- ドメイン層の書き方（ブランド VO・`create` で throw・判別可能ユニオン・`reconstruct` の `RehydrationError` 包み）
- OCC 契約（`ExpectedVersion<T>` の phantom 型・`findById` が唯一の発行点・0行更新 → `ConflictError`）
- Outbox / relay / pruner / DLQ・`_occ_guard` による D1 バッチ abort・claim/lease — spec/database が「テンプレート流儀にそのまま従い再定義しない」と明記しており、そのまま使える
- 4層のエラー階層と presentation の直列化・redaction・ステータス割り当て
- フォーム／楽観更新の三層パターンとストリーミング＋スケルトンの分担

**乖離していて本 Issue で解消するもの**

| 乖離 | 現状 | 本 Issue での扱い |
|---|---|---|
| ドメインが `todo` サンプルのみ | `todos` テーブルが初期マイグレーションに含まれる。fog の DB 設計（9テーブル＋共通基盤）に `todos` は存在しない | `todo` ドメイン一式を削除し、初期マイグレーションを fog のものとして再生成する（→ ADR-001） |
| 認証・セッションが**完全に不在** | Cookie / セッション / パスワードハッシュのポートも実装も一切ない（`server.aws.ts` の cookie ヘッダー変換のみ） | `PasswordHasher`（ドメインポート）+ `SessionCodec`（アプリケーションポート）+ presentation の Cookie ヘルパーを新設（→ ADR-002 / ADR-003 / ADR-005） |
| `ValidationError` がアプリケーション層に無い | `docs/backend_implementation_example.md` は存在すると書くが実際は未定義。`kind: "validation"` は presentation の `InputValidationError` だけが持つ | アプリケーション層に `ValidationError` を追加（`loginWithPassword` の `INVALID_CREDENTIALS` に必須）（→ ADR-006） |
| デザイントークンがテンプレート既定 | `styles/tokens.css` は hue 250 の汎用パレット。fog は spec/design/tokens.md のソフトミニマリズム（hue 292 + accent 40） | `tokens.css` / `theme.css` を spec/design/tokens.md の値へ差し替える |
| UI プリミティブが実質ゼロ | `Skeleton` / `Deferred` / `RoutePendingFallback` のみ。Button / Input / Field が無い | 認証シート・フォームに必要な最小限を `components/ui/` に新設（基準形は `spec/design/pages/login.html`） |
| ルート構成がテンプレートのまま | `/` はテンプレート紹介ページ、`/todo/*` がサンプル | `/` を認証必須のタイムライン（空状態）に、`/login` `/signup` `/password-reset` を認証前ページとして新設 |
| `AppConfig` の既定値がテンプレート名 | `packages/core/src/config.ts` の siteName 等 | fog の値に更新（起動導線の一部） |
| 環境変数にセッション秘密鍵が無い | `NodeServerEnv` 等に `SESSION_SECRET` なし | 4ランタイムの env スキーマに **optional** で追加し、必須性の検証は `createXxxRequestContainer` に置く。`.env.example` / `.dev.vars.example` / `.env.aws.example` / `.env.gcp.example` と、`infra/aws` / `infra/gcp` の**アプリ実行地点の env 列挙**にも追加する |

**注意（乖離ではないが認識しておくこと）**

- outbox テーブルの実名は `outbox_events`（spec/database は `outbox` と書くが「テンプレート流儀に従う」と明記）。ADP-outbox-001 は既存実装で満たす。名称差は spec 側の記述揺れなので実装を変えない
- 統合テストの主戦場は Miniflare D1 プール（`application/**/*.integration.test.ts` はここで走る）。libsql / node の統合テストは別プール。**両方に手を入れる必要がある**
- `docs/frontend_implementation_example.md` は `getCurrentUser` を `packages/core/src/lib/server/currentUser.ts` に置く例を示すが、これは CLAUDE.md の「core はフレームワーク非依存」に反する（→ ADR-005 で配置を決める）
- **`apps/web` の単体テスト基盤（実地確認済み）**
  - ルート `vitest.config.ts` は `include` を持たない（vitest 既定の `**/*.test.ts` を使う）ため、`apps/web` 配下の `*.test.ts` は**設定変更なしで `pnpm test:unit` の対象に入る**。exclude は `node_modules` / `dist` / `.direnv` / `*.integration.test.ts` / `spec/**` のみ
  - ただし `apps/web` 配下に**非 integration の単体テストは現時点で1件も存在しない**（あるのは `app/worker/{cloudflare,node}/__tests__/*.integration.test.ts` の2件だけ）。したがって本 Issue の `sessionCookie.test.ts` が最初の1件になる
  - パスエイリアス解決は3つの config すべてが `resolve: { tsconfigPaths: true }` を使い、`apps/web/app/worker/**` の統合テストが `@repo/core/*`（`apps/web/tsconfig.json` の `paths` 由来）を実際に解決できているので、ディレクトリ直近の tsconfig を拾う挙動は既に効いている。**`@/*` エイリアスを使った node プール実行だけが未検証**
  - jsdom / RTL は無い。コンポーネント・ルートのテストは書けないので、PAGE-* の受け入れは手動テスト（spec/manual-tests/account.md）で担保する
  - この事実を踏まえ、TC-logout-002 / 003 の自動検証対象は「`server-only` を import しない純関数モジュール」に限定する（→ ステップ2 / ステップ15 / ADR-005）

### 依存関係

- `UnitOfWorkContext` にスロットを足すと **2つの UoW 実装（d1 / libsql）** の両方を更新する必要がある
- `RequestContainer` にポートを足すと **4つの DI ファクトリ** すべてを更新する必要がある（型エラーで検出される）
- `AllDomainEvents` / `defaultEventDecoderRegistry` は `satisfies` で網羅性が強制されるため、ドメイン追加と削除の両方でコンパイルエラーとして現れる
- `d1/schema.ts` の変更は `libsql/schema.ts` に自動伝播するが、マイグレーションは **2セット別々に生成**（`db:generate:cf` / `db:generate:node`）が必要
- `todo` 削除の波及先（実地確認して確定した全リスト）
  - `packages/core/src/domain/todo/`・`packages/core/src/application/todo/`（`__tests__/` 含む）
  - `packages/core/src/adapters/{d1,libsql}/repositories/todoRepository.ts`
  - `packages/core/src/adapters/{d1,libsql}/__tests__/{todoRepository,unitOfWork,occGuard,outboxRepository}.integration.test.ts`（4種 × 2ランタイム）
  - `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts` — `todos` を UNIQUE / PRIMARYKEY 衝突のフィクスチャに使い、`mapDbError` の制約分類（`SQLITE_CONSTRAINT_UNIQUE` → `ConflictError("UNIQUE_VIOLATION")`）を検証している**唯一の**テスト。ADR-008 の前提そのものなので `users` へ移植する
  - **`packages/core/src/adapters/d1/__tests__/setup.ts`** — `vitest.config.integration.ts` の**グローバル `setupFiles`**。`beforeEach` で `DELETE FROM todos` を無条件に実行するため、`todos` が消えた瞬間 **D1 プールの全統合テストが `no such table: todos` で落ちる**。`afterEach` の `_occ_guard` 空表明は共通基盤検証の核なので維持する
  - `packages/core/src/adapters/{d1,libsql}/__tests__/helpers.ts`（各ランタイムの `TestContainer`）・`packages/core/src/application/__tests__/helpers.ts`
  - `apps/web/app/worker/{cloudflare,node}/__tests__/*.integration.test.ts` — `TodoEvents` / `TodoId` / `TodoTitle` をイベントのフィクスチャとして import している。identity のイベントへ差し替える
  - `apps/web/app/components/todo/`・`apps/web/app/routes/todo/`・`apps/web/app/routes/index.tsx`・`apps/web/app/routes/__root.tsx` の副作用 import・`apps/web/app/routeTree.gen.ts`
- クライアント島からのみ参照される server function は RSC マニフェストに載らないため、`__root.tsx` に action モジュールの副作用 import を追加しないと動かない（既存の todo と同じ罠）
- **`routeTree.gen.ts` は TanStack Router の Vite プラグインが生成する**。ルートの増減は `pnpm typecheck` 単体では反映されないので、`pnpm dev` / `pnpm build` を1度回して再生成しないと型が合わない
- **`libsql/__tests__/helpers.ts` は `../migrations/0000_initial.sql` をパスで固定参照している**（`readFileSync` で DDL を流す）。`drizzle-kit generate` は `--name` を渡さないとランダム名（`0000_furry_wolverine.sql` 等）になるため、再生成のやり方によっては libsql 統合テストが全滅する
- **d1 の migrations ディレクトリには `meta/` が無く、`0000_initial.sql` は手書き**（コメント入り・`--> statement-breakpoint` なし）。libsql 側にだけ `meta/_journal.json` と `0000_snapshot.json` がある（`drizzle-orm/libsql/migrator` が journal を要求するため）。`pnpm db:generate:cf` を回すと **d1 側に新規に `meta/` が生成され、以後は drizzle 管理**に切り替わる
- **DI ファクトリの rest-spread は秘密を巻き込む**。`createXxxRequestContainer` は `const { db: _db, relayTrigger: _relayTrigger, ...appConfig } = config;` の形で、`appConfig satisfies AppConfig` は変数に対する `satisfies` なので**余剰プロパティ検査が効かない**。`RequestServerConfig` に `sessionSecret` を足すと型エラーなしで `container.config` に入り、`loadAppContext` 経由でクライアントの HTML ペイロードに載る
- **Cloudflare の `ServerEnv` は型宣言のみで zod スキーマを持たない**（Node / AWS / GCP は zod で検証する）。CF だけ `SESSION_SECRET` の欠落が起動時に検出されない

## 設計

### ドメインモデルへの影響

新しく `identity` ドメイン（`packages/core/src/domain/identity/`）を追加し、`todo` ドメインを削除する。

**値オブジェクト（`valueObject.ts`）** — すべて `unique symbol` ブランド + `create` ファクトリ、違反は `BusinessRuleError<IdentityErrorCode>`

| VO | 制約 | 備考 |
|---|---|---|
| `UserId` | trim 後非空 | ID 形式検証は `IdGenerator` の責務（todo の規約どおり） |
| `Email` | trim・小文字化の正規化後に `local@domain` 構造・320文字以下 | 正規化した値を返すのが本質。`InvalidEmail` |
| `PlainPassword` | 8〜128文字 | `PasswordTooWeak`。**漏出防止は実装せず、テスト＋レビュー観点で担保する**（→ 直下の段落 / ADR-011）。ブランド付き `string` なので `toString` / `toJSON` のオーバーライドは載せない |
| `PasswordHash` | 非空 | 照合は必ず `PasswordHasher.verify` 経由 |
| `TrashRetentionDays` | 1以上の整数、`default()` が 30 | `InvalidTrashRetentionDays`。**定義はここ一箇所のみ** |
| `SsoProvider` | `"google" \| "apple"` | `UnsupportedSsoProvider`。SsoUser 再水和に必要 |
| `AiClientConnectionId` | trim 後非空 | `Actor` の構成要素として付随実装 |
| `ClientName` | trim 後非空・100文字以下 | 同上 |
| `Actor` | `UserActor \| AiClientActor` の直和 + `Actor.user()` / `Actor.aiClient()` | 横断 VO。`clientName` はスナップショット |

**`PlainPassword` の漏出防止（DOM-identity-006 の要点の一部）は実装で担保しない。** `spec/inventory/domain.md` の DOM-identity-006 は「8〜128文字を検証」に加えて「ログ・イベント・永続化への漏出を防止する実装を持つ」を、`spec/domains/identity.md#PlainPassword` は「`toString` を無効化するなど漏出防止を**実装で担保する**」を要求している。しかし同じ spec が「フィールド: `string`（ブランド型）」とも書いており、ブランド付き `string` に `toString()` / `toJSON()` のオーバーライドは載せられない（載せるにはボックス化したオブジェクト VO にする必要があり、他の VO の書き方と不揃いになる）。**`PlainPassword` はブランド付き `string` のままとし、漏出防止は下の2つのテストで代替する**（→ ADR-011。spec の字面との差なので spec-sync 対象として記録する）。

| 代替の担保 | テスト | 何を縛るか |
|---|---|---|
| イベントへの漏出 | `domain/identity/__tests__/entity.test.ts` | `User.registerWithPassword(...)` が返す `identity.userRegistered` のペイロードのどの値にも平文が現れないこと（キー集合を表明し、値の再帰走査で平文文字列を含まないことも表明する） |
| View（レスポンス）への漏出 | `application/identity/__tests__/identity.integration.test.ts`（TC-getCurrentUser-003 と同じ表明） | `CurrentUserView` のキー集合が `{ userId, email, authMethod, trashRetentionDays }` に完全一致し、平文・`passwordHash` を含まないこと |

ログへの漏出だけはテストで縛れないので、**レビュー観点**（`PlainPassword` 型の値を `logger.*` の引数に渡さない）として PR チェックリストに残す。

**エンティティ（`entity.ts`）**

```
UserBase = { id: UserId; email: Email; trashRetentionDays: TrashRetentionDays;
             version: Version; createdAt: Date; updatedAt: Date }
PasswordUser = UserBase & { authMethod: "password"; passwordHash: PasswordHash }
SsoUser      = UserBase & { authMethod: "sso"; provider: SsoProvider; providerSubject: string }
User         = PasswordUser | SsoUser
```

`User = { isPasswordUser, isSsoUser, registerWithPassword, registerWithSso, changePassword, changeTrashRetentionDays, reconstruct }`。

- `registerWithPassword({ id, email, passwordHash }, now)` → `WithEventDrafts<PasswordUser, IdentityEvent>`。`version: Version.initial()`、`trashRetentionDays: TrashRetentionDays.default()`、イベント `identity.userRegistered`
- `changePassword` は `PasswordUser` のみ受ける（型で保証）。`changeTrashRetentionDays` は `User` を受ける
- `reconstruct(input)` は `auth_method` で分岐して再水和し、失敗を `RehydrationError` で包む（todo の規約どおり）。CHECK に反する行（`password` なのに `passwordHash` が null 等）はここで `RehydrationError` → アダプターが `SystemError(DataIntegrityError)` に翻訳する

`AiClientConnection` エンティティは本 Issue のスコープ外。

**ドメインイベント（`events.ts`）** — `identity.userRegistered { userId, authMethod }` / `identity.passwordChanged { userId }` / `identity.trashRetentionChanged { userId, retentionDays }` の3種。`IdentityEvent` union と `IdentityEvents` ドラフトファクトリ。AiClientConnection 系の2イベントはスコープ外。

**ポート（`ports/`）**

```ts
// domain/identity/ports/userRepository.ts
export interface UserRepository {
  insert(user: User): Promise<void>;
  save(user: User, expectedVersion: ExpectedVersion<User>): Promise<void>;
  findById(id: UserId): Promise<Versioned<User> | null>;
  findByEmail(email: Email): Promise<Versioned<User> | null>;
}
```

**`TransactionalRepository` は extends しない**（spec/domains/identity.md「ポート」の明記どおり。`delete` を持たず、後続スライスで `(userId, id)` 署名のメソッドが増える identity 系ポートとは両立しないため）。OCC 規約だけ同じ形に揃える。`findBySsoIdentity` は SSO スライスで追加する。

```ts
// domain/identity/ports/passwordHasher.ts
export interface PasswordHasher {
  hash(plain: PlainPassword): Promise<PasswordHash>;
  verify(plain: PlainPassword, hash: PasswordHash): Promise<boolean>;
}
```

**エラーコード（`errorCode.ts`）** — `IdentityErrorCode = { InvalidUserId, InvalidEmail, PasswordTooWeak, InvalidPasswordHash, UnsupportedSsoProvider, InvalidClientName, InvalidAiClientConnectionId, InvalidTrashRetentionDays }`。

### ユースケース / アプリケーションロジック

`packages/core/src/application/identity/` に4ユースケース + `view.ts` + `eventDecoders.ts`。

| ユースケース | UoW | 処理 | 主なエラー |
|---|---|---|---|
| `registerWithPassword` | 必要 | `clock.now()` / `idGenerator.next()` → `Email.create` / `PlainPassword.create` → **UoW 外で** `passwordHasher.hash` → UoW 内で `findByEmail` 事前検証 → `User.registerWithPassword` → `insert` → `collectEvents` | `BusinessRuleError(InvalidEmail / PasswordTooWeak)`、`ConflictError("EMAIL_ALREADY_REGISTERED")`（事前検証・一意制約レース双方）、`SystemError` |
| `loginWithPassword` | 不要（読み取りのみ） | VO 生成失敗も含め**すべて** `ValidationError("INVALID_CREDENTIALS")` に統一。`findByEmail` → 不在 / `SsoUser` / `verify` 不一致も同一エラー | `ValidationError("INVALID_CREDENTIALS")`、`SystemError` |
| `logout` | 不要 | ドメイン操作なし。`UserId.create(input.userId)` のみ行い `void` を返す。セッション破棄は presentation | なし |
| `getCurrentUser` | 不要 | `UserId.create` → `findById` → view 射影（`passwordHash` / SSO 主体 ID を含めない） | `BusinessRuleError`（UserId 空）、`NotFoundError("USER_NOT_FOUND")`、`SystemError` |

読み取り専用ユースケースを UoW に載せるか：テンプレートの `listTodos` は UoW 経由（純読み取り UoW はトランザクションをスキップする）だが、`UnitOfWorkContext` からしかリポジトリを取れない構造なので、`loginWithPassword` / `getCurrentUser` も **`unitOfWorkProvider.run` 経由で `userRepository` を取得する**。spec の「UoW 不要」は「トランザクションを張らない」の意であり、実装上は純読み取り UoW（トランザクションをスキップ）で satisfies する。→ **ADR-009**（spec の字面との差なので spec-sync 対象として記録する）

**`ValidationError` の追加**（`application/errors/index.ts`）— `kind: "validation"`、`fieldErrors?` を持つ `SerializedValidationError` をアプリケーション層に定義し、presentation はそれを import する（現在 presentation にローカル定義があるものを移す）。→ ADR-006

**`view.ts`** — `CurrentUserView = { userId: string; email: string; authMethod: "password" | "sso"; trashRetentionDays: number }`。プリミティブのみ。

**`eventDecoders.ts`** — `identityEventDecoders` を `buildEventDecoder` で3イベント分宣言し、`eventRelayWorker.ts` の `AllDomainEvents` を `IdentityEvent` に、`defaultEventDecoderRegistry` を `{ ...identityEventDecoders }` に更新する。

**横断ポート `SessionCodec`**（`application/ports/sessionCodec.ts`）

```ts
export interface SessionCodec {
  issue(userId: string, now: Date): Promise<string>;
  verify(token: string, now: Date): Promise<{ userId: string } | null>;
}
```

Cookie を知らない「トークンの発行と検証」だけのポート。clock / idGenerator / logger と同じ「横断的関心事をポートの背後に置く」原則（CLAUDE.md）に従い `RequestContainer` に載せる。→ ADR-002

**`UnitOfWorkContext`** に `userRepository: UserRepository` を追加し、`todoRepository` を削除する。
**`RequestContainer`** に `passwordHasher: PasswordHasher` と `sessionCodec: SessionCodec` を追加する。

### アダプター / 永続化 / 外部連携

**スキーマ（`packages/core/src/adapters/d1/schema.ts`）** — `todos` を削除し `users` を追加。共通基盤3テーブルは変更なし。

```
users(
  id TEXT PK,
  email TEXT NOT NULL UNIQUE,                -- 正規化済み
  auth_method TEXT NOT NULL,                 -- CHECK IN ('password','sso')
  password_hash TEXT,                        -- password のときのみ非 NULL
  sso_provider TEXT,                         -- CHECK NULL or IN ('google','apple')
  sso_provider_subject TEXT,                 -- CHECK NULL or length > 0
  trash_retention_days INTEGER NOT NULL,     -- CHECK >= 1
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
)
```

- 直和 CHECK をテーブル制約1本で（spec/database/index.md#users の SQL をそのまま）
- `sso_provider_subject` の**非空 CHECK**（spec/database/index.md#users が要求する `length(sso_provider_subject) > 0`）を明示的に置く。直和 CHECK に畳み込まず独立した `check("users_sso_subject_nonempty", sql\`sso_provider_subject IS NULL OR length(sso_provider_subject) > 0\`)` として定義し、違反時にどの不変条件が破れたかを制約名で判別できるようにする
- `sso_provider` の値域 CHECK（`sso_provider IS NULL OR sso_provider IN ('google','apple')`）も同様に独立した制約として置く
- **`auth_method` の値域 CHECK** — `check("users_auth_method_valid", sql\`auth_method IN ('password','sso')\`)`。直和 CHECK の論理和で実質は担保されるが、`spec/database/index.md#users` が列制約として明記しているので独立させ、違反時に制約名で判別できるようにする
- **`trash_retention_days >= 1` の CHECK** — `check("users_trash_retention_positive", sql\`trash_retention_days >= 1\`)`。**どの直和 CHECK にも含まれない独立の不変条件**で、抜けると `TrashRetentionDays`（DOM-identity-010）の不変条件が DB 側で守られなくなる
- `users_email_uq` = `uniqueIndex().on(email)`
- `users_sso_identity_uq` = `uniqueIndex().on(ssoProvider, ssoProviderSubject).where(sql\`sso_provider IS NOT NULL\`)` — 部分一意インデックス
- タイムスタンプに SQL DEFAULT は置かない（すべて `Clock` 由来）。`trash_retention_days` にも DB DEFAULT を置かない（既定値の補完は application）

**マイグレーション** — 既存の `0000_initial.sql`（d1 / libsql）と libsql の `meta/` を破棄し、`pnpm db:generate:cf` / `pnpm db:generate:node` で fog の初期マイグレーションとして再生成する。未リリースなので `0001_*` を積まずリセットする（→ ADR-001）。ローカルの `apps/web/data/app.db` は作り直す。実務上の要点は4つ（→ ステップ7）。

1. **生成ファイル名の固定参照を壊さない。** `libsql/__tests__/helpers.ts` は `../migrations/0000_initial.sql` を `readFileSync` で直接読む。恒久的な解として**このヘルパーを `meta/_journal.json` 走査（journal の `tag` 順に全 SQL を適用）に書き換える**。将来 `0001_*` を積んだときも壊れないのはこちらだけなので、`--name initial` でファイル名を固定するだけの対処は採らない（併用はする: 生成コマンドには `--name initial` を付けてファイル名の意味を保つ）
2. **`--name initial` は `apps/web` 内で直接実行して渡す。** ルートの `db:generate:cf` は `pnpm --filter @repo/web db:generate:cf` への委譲で、`apps/web` 側が `drizzle-kit generate --config=./drizzle.config.ts` を実行する2段構成。`pnpm db:generate:cf -- --name initial` は pnpm を2回通るため引数が `--filter` 側のフラグとして解釈される余地があり脆い。**`apps/web` ディレクトリの中で `pnpm db:generate:cf --name initial` / `pnpm db:generate:node --name initial` を直接実行する**（→ arch-risk S-005）
3. **d1 側に `meta/` が生える。** 現状の d1 `0000_initial.sql` は手書きで `meta/` を持たないが、`db:generate:cf` を回すと drizzle が `meta/_journal.json` と snapshot を生成し、以後 d1 側も drizzle 管理になる。これは意図した移行であり ADR-001 の Consequences に記録する。`readD1Migrations` / `applyD1Migrations` は `.sql` を読むだけなので `meta/` の有無に影響されない**はず**だが、`vitest.config.integration.ts` は `const migrations = await readD1Migrations(...)` を **config のトップレベルで await している**ため、ここが失敗すると D1 プールの統合テストが1件も起動しない。本リポジトリでは d1 に `meta/` が無い状態しか実測していないので、**断定せず生成後に起動を確認する**（→ ステップ7の完了条件 / arch-risk S-004）
4. **生成物を目視確認する。** 型検査では検出できないので、`git diff` で d1 / libsql 両方の SQL を確認する。項目はステップ7の (a)〜(h) を参照

**リポジトリ実装** — `adapters/d1/repositories/userRepository.ts` と `adapters/libsql/repositories/userRepository.ts`。テンプレートの `todoRepository.ts` を基準形とし：

- `toUser(row)`: `idGenerator.validate(row.id)` → 失敗なら `SystemError(DataIntegrityError)`。`User.reconstruct(row)` を try/catch し `isRehydrationError` → `SystemError(DataIntegrityError)`
- `toVersioned(row)`: `row.version as ExpectedVersion<User>` の**唯一の**キャスト地点
- 読み取り（`findById` / `findByEmail`）は即時実行、`mapDbError(...)` で包む。`findByEmail` は正規化済み `Email` をそのまま等値比較（`users_email_uq` を引く）
- 書き込みは `PendingBatch` にバッファ。`insert` は `pending.add(...)`、`save` は `pending.addOcc(update…where(and(eq(id), eq(version, expectedVersion))), () => { throw new ConflictError("OPTIMISTIC_LOCK_FAILURE", …) })`
- **email 一意制約違反の翻訳**: 既定の `mapDbError` は UNIQUE 違反を `ConflictError("UNIQUE_VIOLATION")` にする。しかも UoW 方式では違反は `insert` 呼び出しではなく **flush 時（`db.batch` / `tx`）** に出る。そのため `EMAIL_ALREADY_REGISTERED` への翻訳は `UserRepository.insert` の中では捕捉できない。→ **`registerWithPassword` ユースケース側で `unitOfWorkProvider.run(...)` の呼び出しを `catch` し、`isConflictError(e) && e.code === "UNIQUE_VIOLATION"` を `ConflictError("EMAIL_ALREADY_REGISTERED")` に読み替える**。これは「例外的な boundary での catch」に該当し、CLAUDE.md の catch ポリシーに反しない（レース検出という明示された境界）。TC-registerWithPassword-014 がこの経路を縛る。→ **ADR-008**（アダプター責務からの移設理由を正式な設計判断として記録する）
- **「制約を区別できない」問題への設計上の解**: 上の一括読み替えは、同一 flush に複数の一意制約が乗ったとき**どれが発火したかを復元できない**（`mapDbError` は制約名を捨てて `UNIQUE_VIOLATION` に潰す）。本スライスではこれが実害にならないことと、SSO スライスでの解消経路を先に決めておく。
  - **本スライスで発火し得る UNIQUE 制約は2つだけ**: (1) `users_email_uq`、(2) outbox 行の PK（`EventId`）。`registerWithPassword` が insert するのは `PasswordUser` で `sso_provider` は NULL なので、部分一意インデックス `users_sso_identity_uq` は**対象行にならず原理的に発火しない**。`EventId` は UUIDv7 で、同一 UoW 内の新規採番が衝突する確率は実質ゼロ。したがって「UNIQUE 違反 = email 重複」と読み替えて誤りになる経路が現時点で存在しない
  - **この前提を JSDoc に固定する**: `registerWithPassword` の catch に「この読み替えは『同一 UoW の書き込みが users への insert 1件 + outbox insert のみ』かつ『insert 対象が PasswordUser（sso 列 NULL）』という前提に依存する。UoW に別の一意制約を持つ書き込みを足すときは読み替えを外すこと」と明記する
  - **恒久解（SSO スライスで実施）**: `PendingBatch` は既に per-statement のハンドラ機構を持つ（d1 は `conflictHandlers` の FIFO + `firstConflictHandler()`、libsql は `stmt.kind === "occ"` + 直前ハンドラ）。ここに OCC 以外の「制約違反ハンドラ」を1種類足し、`UserRepository.insert` が `pending.add(query, { onConstraintViolation: (err) => never })` を登録できるようにすれば、**翻訳がアダプターに戻り**（CLAUDE.md「adapter → application: adapters translate driver errors」・`spec/inventory/adapter.md` の ADP-identity-001 と一致）、どの statement が落ちたかも FIFO で特定できる。同一 insert 文の中で email と sso identity のどちらの制約かを分けるところだけはドライバのメッセージ（D1 / libSQL とも `UNIQUE constraint failed: users.email` の形でテーブル.カラムを含む）を見る必要があるので、ハンドラにドライバ例外を渡す形にしておき、判別不能なら `UNIQUE_VIOLATION` へフォールバックする。本 Issue では**この機構を実装しない**（SSO の insert 経路が無く、動作を検証できるテストが書けないため）
- `UnitOfWorkContext` への差し込みは `adapters/{d1,libsql}/unitOfWork.ts` の2箇所

**新規アダプター（ランタイム非依存・WebCrypto）** — `packages/core/src/adapters/webcrypto/`

| ファイル | 内容 |
|---|---|
| `pbkdf2PasswordHasher.ts` | `PasswordHasher` 実装。PBKDF2-HMAC-SHA256 / 16byte ランダム salt / 32byte 出力。`pbkdf2-sha256$<iterations>$<saltB64>$<hashB64>` 形式で `PasswordHash` にエンコード。`verify` は保存値からパラメータを読み、定数時間比較。計算失敗は `SystemError`。**反復回数はファクトリ引数** `createPbkdf2PasswordHasher({ iterations = 210_000 })`。→ ADR-003 |
| `hmacSessionCodec.ts` | `SessionCodec` 実装。`<payloadB64url>.<hmacB64url>`（payload = `{ uid, exp }` の JSON）。`verify` は署名を定数時間比較 → 期限判定 → `{ userId }`。改ざん・期限切れは `null`。→ ADR-002 |

WebCrypto（`globalThis.crypto.subtle`）は Node 20+ / Workers / Lambda / Cloud Run すべてで利用でき、依存追加ゼロで4ランタイムに配れる。

**反復回数と統合テストの実行環境** — `vitest.config.integration.ts` の include は `packages/**/*.integration.test.ts` で、exclude は libsql / node アダプターのみ。したがって新設する `application/identity/__tests__/identity.integration.test.ts` は **Miniflare（workerd）プールで走り、実 `PasswordHasher` を叩けば 210,000 回の PBKDF2 が workerd 上で実行される**。「主ターゲットは Node だから CF の CPU 予算は本 Issue の問題ではない」は成立しない。対処は3段構え（→ ステップ10 / ADR-003）。

1. 反復回数を**ファクトリ引数**にする（環境変数にはしない。環境ごとに強度が揺れるのを防ぐという ADR-003 の意図は保つ）。保存形式に `iterations` が埋まっているので `verify` の互換性は壊れない
2. ステップ10の先頭で **workerd 実測**（`deriveBits` を 210,000 回で1度だけ叩く捨てテスト）を行い、成功可否と所要時間を測る
3. ユースケースの統合テストには**フェイクハッシャー**（`hash` = `` `fake$${plain}` ``、`verify` = 文字列比較）を注入し、実アルゴリズムの検証は `adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts`（node プールの単体テスト）に寄せる。TC-loginWithPassword-009（8文字パスワードでの照合）のように「実ハッシャーで往復する」ことに意味があるケースだけ低い反復回数（例: 1,000）の実ハッシャーを使う

**DI 配線** — `application/di/server{Node,Cloudflare,Aws,Gcp}.ts` の4本すべてで：

- env スキーマに `SESSION_SECRET` を追加する。ただし **zod スキーマ側では optional にし、必須性（32文字以上）の検証は `createXxxRequestContainer`（＝秘密鍵を実際に使う唯一の地点）で行い、不足時に throw する**。4ランタイムで同じ意味論に揃える（→ round-3 arch-risk S-001）
  - 理由: `readAwsServerEnv()` / `readGcpServerEnv()` は request パスだけでなく **`apps/web/app/worker/{aws,gcp}/handlers.ts` からも呼ばれる**。zod スキーマに必須キーを足すと、セッションを一切扱わない relay / consumer / pruner / dlq の4ワーカーが `SESSION_SECRET` 無しでは**起動できなくなる**。しかも `infra/aws/lib/appStack.ts` の `sharedEnv` は `Record<string, string>` なので `AwsServerEnv` の必須キーが増えても `pnpm typecheck` は通り、**デプロイして初めて zod の parse エラーで落ちる**（`infra/gcp/example/services/*` も同様に Terraform 変数で env を明示列挙している）
  - これは Cloudflare について既に採っている方針（`ServerEnv` は型宣言のみで zod スキーマを持たないので `readRequestServerConfig` / `createRequestContainer` で明示検証する）を4ランタイムに一般化したもので、「秘密の到達範囲を DI ファクトリ1箇所に閉じる」という下の方針とも噛み合う。結果として **セッションを使う経路だけが秘密鍵を要求する**
  - デプロイ側の env 列挙も**アプリ実行地点にだけ**足す: `infra/aws/lib/appStack.ts` は `sharedEnv`（5 Lambda 共通）ではなく **`appFn` の `environment` に直接**（Secrets Manager 参照が妥当なら `DATABASE_AUTH_TOKEN_SECRET_ARN` と同じ流儀で）、`infra/gcp/example/services/{main.tf,variables.tf}` は `local.shared_env` ではなく **`google_cloud_run_v2_service.app` の `merge(...)` 側**に足す
- `createXxxRequestContainer` に `passwordHasher: createPbkdf2PasswordHasher()` と `sessionCodec: createHmacSessionCodec({ secret, ttlMs })` を追加

**`sessionSecret` の漏洩経路を構造的に塞ぐ** — 「`AppConfig` に入れない」という原則だけでは守れない。4本の `createXxxRequestContainer` はいずれも

```ts
// Node / AWS / GCP
const { db: _db, relayTrigger: _relayTrigger, ...appConfig } = config;
// Cloudflare は分解するキーが違う（binding / relay / waitUntil）
const { binding: _binding, relay, waitUntil, ...appConfig } = config;

return { ...buildSharedDeps(), config: appConfig satisfies AppConfig, … };
```

の形をしており、`RequestServerConfig` に `sessionSecret` を足すと **rest-spread が拾って `container.config` に入り、`loadAppContext` 経由でクライアントの HTML ペイロードに載る**。`appConfig satisfies AppConfig` は変数に対する `satisfies` なので余剰プロパティ検査が効かず型エラーにならない。対処は次の形にする（→ ステップ11）。

- `RequestServerConfig` に `secrets: { sessionSecret: string }` を**ネストして**足し、4本とも**既存の分解に `secrets` を1つ追加する**。`RequestServerConfig` の実体はランタイムごとに違う（Node / AWS / GCP は `AppConfig & { db; relayTrigger }`、**Cloudflare は `AppConfig & { binding; relay?; waitUntil? }`**）ので、分解の形も揃っていない — 1つの書き方を4本に写すと CF で存在しないプロパティを分解することになる。正しくは:
  - Node / AWS / GCP: `const { db: _db, relayTrigger: _relayTrigger, secrets, ...appConfig } = config;`
  - Cloudflare: `const { binding: _binding, relay, waitUntil, secrets, ...appConfig } = config;`（`relay` / `waitUntil` は `ServiceBindingRelayTrigger` の構築に使うので `_` を付けない）
  - こうしておけば、将来別の秘密を足しても `secrets` の中に入るだけで同じ事故が起きない（→ arch-risk S-001）
- 秘密鍵は `createHmacSessionCodec({ secret, ttlMs })` の構築にだけ使い、**`RequestContainer` には載せない**。presentation を含む上位は `container.sessionCodec` というポート越しにしか触れないので、秘密鍵の到達範囲が DI ファクトリ1箇所に閉じる
- `loadAppContext` が返す `config` のキー集合を表明する回帰テストを1件足す（→ ステップ24）

### UI / プレゼンテーション

**デザイン基盤**

- `apps/web/app/styles/tokens.css` を spec/design/tokens.md の値で全面置換（カラー / タイポ / スペーシング / 角丸 / 影 / トランジション / コンテナ）。`theme.css` は `tokens.css` と **lockstep で全面書き直し**（Tailwind v4 の `@theme`）。`prefers-reduced-motion` の無効化を base に追加
- 基準形は `spec/design/pages/login.html`（認証シート・フォーム）と `spec/design/pages/timeline.html`（共通シェル：ヘッダー・サイドバー・下部シートナビ）
- **差し替えで壊れる既存参照（実地確認済み・「壊れないか確認する」では足りない）**
  - `theme.css` は `--color-neutral-{150,250,350,450,550,650,750,850}` の**半段階**を `@theme` にマップしているが、`spec/design/tokens.md` に半段階は存在しない。`tokens.css` だけ差し替えると8個の未定義参照が残る → 半段階のマップを削除し、spec が追加するトークン（`--color-*-dark` / `--color-*-bg` / `--pad-*` / `--icon-*` / `--content-max` 等）を新たに露出する
  - `components/ui/Skeleton/index.tsx` は `bg-neutral-200` を使うが、spec の `--color-neutral-200` は `--color-bg-page` と**同一値**。差し替え後スケルトンがページ背景に溶けて**不可視**になる（クラス名は解決するので型エラーにもビルドエラーにもならない）→ `--color-neutral-300` 相当へ変更する
  - `text-red-500` が `CreateTodoForm` / `TodoBoard` にある（削除対象だが、新規フォームのコピー元にすると生値が持ち込まれる）→ 新規フォームのエラー表示は `--color-error` 由来のクラスを使う（AC-18）

**新規 UI プリミティブ**（`apps/web/app/components/ui/`）

`Button`（primary / outline のピル）、`TextField`（label + input + helper + error、`aria-invalid` / `aria-describedby` 配線）、`FormMessage`（`role="alert"` のフォーム上部エラー）、`AuthSheet`（ブランド + タイトル + 中央寄せシート）。tokens 由来のクラスのみで組み、生値を書かない。

**セッション / 認証ガード**（`apps/web/app/presentation/`）

| ファイル | 内容 |
|---|---|
| `sessionCookie.ts` | **フレームワーク import を一切持たない純関数モジュール**。`SESSION_COOKIE_NAME` と `buildSessionCookie(token \| null, opts): string`（`token === null` で `Max-Age=0` の失効 Cookie）。属性は `HttpOnly; Secure（本番）; SameSite=Lax; Path=/; Max-Age=<ttl>` |
| `session.ts` | `import "@tanstack/react-start/server-only";`。`startSession(userId)` / `endSession()` / `readSessionToken()`。Cookie 文字列は `sessionCookie.ts` に委譲し、ここはヘッダーの読み書きだけを行う |
| `currentUser.ts` | `getCurrentUserId(): Promise<string \| null>`（`cache()` で同一リクエスト内デデュープ。`getContainer()` を直接叩く一行ポートアクセスの escape hatch）、`requireUserId(): Promise<string>`（未認証なら `throw redirect({ to: "/login", search: { redirect } })`） |

配置は `apps/web/app/presentation/`（`docs/frontend_implementation_example.md` の `packages/core/src/lib/server/` ではない）→ ADR-005。

`sessionCookie.ts` を分けるのは**テスト可能性のため**（→ coverage S-002 / arch-risk P-006）。TC-logout-002 の唯一の自動検証手段が `server-only` モジュールの node プール読み込みに依存すると、そこが落ちた時点でカバレッジ主張ごと崩れる。純関数側にだけテストを置けばこの依存が消える。

**セッション破棄失敗（TC-logout-003）の扱い** — 実装上、`endSession()` は「Cookie 文字列を組み立ててレスポンスヘッダーに載せる」だけなので通常は失敗しない。それでも `SystemError` への変換を明示するのは、現行の `serializeError` が **`isSerializableError` でない throw を `kind: "unknown"` にフォールバックする**ため、素の例外を投げると `kind: "system"` にならず TC-logout-003 の期待（アダプター層で `SystemError` として扱われる）を満たせないからである。したがって:

- **`SystemErrorCode` に `SessionError: "SESSION_ERROR"` を1エントリ追加する**（`packages/core/src/application/errors/index.ts`）。`DatabaseError` を流用しない: 同ファイルの `SystemErrorCode` の JSDoc は「**外部リソースごとに1エントリ足せ**」「`DatabaseError` は *the storage layer threw*（接続断・ロックタイムアウト）の意」「コードを分けるのはログ／アラートのルーティングを分けるため」と明記しており、Cookie ヘッダー書き込みの失敗を `DATABASE_ERROR` として記録するとルーティングがノイズを拾う。`RETRYABLE_SYSTEM_CODES` には**入れない**（再試行しても直らない）。→ **ADR-010**
- `endSession()` / `startSession()` は、ヘッダー書き込みを行う内部関数を `try / catch` で包み、未知の例外を `SystemError(SystemErrorCode.SessionError, "Failed to end session", cause)` に翻訳して throw する。これは CLAUDE.md の「broad catch は明示された境界のみ」の許容範囲（server-function 直下の presentation 境界）
- 翻訳そのものは `toSessionSystemError(cause): SystemError` という**純関数**として `sessionCookie.ts` 側に置き、`session.ts` から呼ぶ。こうしておくとステップ2の疎通確認で `server-only` を含むモジュールが node プールから読めないと判明した場合でも、TC-logout-003 の自動検証対象が純関数モジュールに残る（→ ステップ2 の分岐 (c)）
- 失敗注入のため、Cookie ヘッダー設定を `setCookieHeader` という**差し替え可能な引数**（既定値はフレームワークの実装）として受け取る形にする。単体テストは throw するスタブを渡して `SystemError` になることを表明する
- `redactForClient` が `kind: "system"` の `code` を潰すので、コードを増やしてもクライアント表示は変わらない
- 将来 `SessionCodec` をテーブル方式へ差し替えたときの DB 障害は、その時点で `DatabaseError`（storage layer 由来）として区別できる

**ルート構成**

```
routes/
  __root.tsx                （既存を更新：クライアント島 action の副作用 import・fog の head）
  login.tsx                 P-01。validateSearch で ?redirect= を安全な相対パスに限定
  signup.tsx                P-02
  password-reset.tsx        P-03 プレースホルダー（→ ADR-007）
  _app.tsx                  認証必須のレイアウトルート。beforeLoad で requireSessionFn → 未認証は /login へ redirect
  _app/index.tsx            P-04 タイムライン（空状態のみ）
  _app/topics.tsx           プレースホルダー
  _app/search.tsx           プレースホルダー
  _app/trash.tsx            プレースホルダー
  _app/settings.tsx         P-13 の最小形（getCurrentUser の email 表示 + ログアウト）
```

- `login.tsx` / `signup.tsx` は認証済みなら `beforeLoad` で redirect（二重ログイン導線を作らない）。**遷移先は `search.redirect ?? "/"`** — `?redirect=` を持ったまま到達したケースで元 URL を捨てないため（`signup.tsx` は `?redirect=` を受けないので `/` 固定）（→ arch-risk S-003）
- `_app.tsx` の `component` に `AppShell`（`"use client"`）を置き、`<Outlet/>` を描画する。**シェルをリーフの `renderServerComponent(...)` に含めない**（テンプレートの `TodoShell` と同じ規約）
- `?redirect=` はオープンリダイレクト防止のため「`/` で始まり `//` を含まない」に制限（`paginationSearchSchema` と同じ二重スキーマの流儀：`validateSearch` は catch 付き、server fn 側は strict）

**認証ガードの権威の所在**（→ ADR-005 を同じ表現に揃える）

`_app.tsx` の `beforeLoad` とヘルパー `requireUserId()` の二重経路になるので、役割を先に確定させる。

- **`beforeLoad` はナビゲーション体験のための先回りリダイレクト**であり、セキュリティ境界ではない。クライアントサイドナビゲーションではブラウザで走るため、遷移ごとにセッション検証の server fn 往復が入る。ここを通ったかどうかにデータ保護を委ねない
- **権威あるガードは各サーバー実行地点の `requireUserId()`**。保護対象のデータを読む server component / server function は必ず自分で `requireUserId()` を通す。`beforeLoad` を素通りしても実データは出ない
- **TC-23（ログアウト後に戻るボタンで保護画面が復元されない）の対策**: `_app.tsx` に `staleTime: 0` を置いてルーターキャッシュからの復元を防ぎ、ログアウト時は `router.invalidate()` → `router.navigate({ to: "/login", replace: true })` の順で遷移する（`replace` で履歴に保護画面を残さない）。bfcache 由来の復元は Cookie が失効しているため実データ取得の時点で `/login` に落ちる

**コンポーネント**（`apps/web/app/components/`）

| パス | 種別 | 内容 |
|---|---|---|
| `auth/schema.ts` | — | `loginSchema` / `signupSchema`。**shape / DoS のみ**（email: 非空・**1024文字以下**、password: 非空・**1024文字以下**）。**最低長8も上限128も書かない** — 長さ判定はすべて `Email` / `PlainPassword` の `BusinessRuleError` に一本化する（TC-registerWithPassword-006 / 009）。transport 側に 128 を書くと129文字入力が `PasswordTooWeak`（business）ではなく `validation` になり、UI 上のエラー種別だけが仕様と食い違う。transport の上限は「DoS 防止のための明確に大きい値」という役割に限定する |
| `auth/LoginForm/{index.tsx,action.ts}` | `"use client"` + server fn | `useActionState<FormState, FormData>` + `useServerFn(loginFn)`。成功で `router.navigate({ to: redirect })` → `router.invalidate()` |
| `auth/SignupForm/{index.tsx,action.ts}` | 同上 | 成功で `/` へ |
| `auth/errorField.ts` | — | `SerializedError` → 表示先フィールドのマッピング表（`IDENTITY_INVALID_EMAIL` → email、`IDENTITY_PASSWORD_TOO_WEAK` → password、`EMAIL_ALREADY_REGISTERED` → email + ログイン導線、それ以外はフォーム上部） |
| `layout/AppShell/index.tsx` | `"use client"` | グローバルナビ。lg 以上は常設サイドバー、未満はヘッダーのメニュー → ボトムシート。`aria-current="page"` で現在地を明示 |
| `settings/LogoutButton/{index.tsx,action.ts}` | `"use client"` + server fn | `logoutFn` → `router.navigate({ to: "/login" })` |

**server function の形**（すべて呼び出し箇所にインライン宣言・`errorResponseMiddleware` を毎回付ける）

```ts
export const loginFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(loginSchema))
  .handler(async ({ data }) => {
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/loginWithPassword"),
    );
    const { userId } = await module.loginWithPassword({ container, input: data });
    const { startSession } = await import("@/presentation/session");
    await startSession(userId);
    return { ok: true } as const;
  });
```

`logoutFn` は `logout` ユースケース呼び出し → `endSession()`。セッション破棄で throw した場合は `SystemError` として上がる（TC-logout-003）。

**エラー表示の日本語**（`presentation/errorDisplay.ts`）— 「文言を追加する」だけでは効かない。現行実装は `kind: "business"` で `error.message`（ドメインが throw した英語メッセージ）をそのまま返し、`kind: "validation"` も `fieldErrors` が無ければ `error.message` を返す。したがって **code を見る分岐の構造そのものを足す**（既存の `renderConflictMessage` と同型）。

| kind | 追加する関数 | code → 文言 |
|---|---|---|
| `conflict` | 既存 `renderConflictMessage` に追加 | `EMAIL_ALREADY_REGISTERED` → 「このメールアドレスは登録済みです」（既存の `UNIQUE_VIOLATION` / `OPTIMISTIC_LOCK_FAILURE` / `FOREIGN_KEY_VIOLATION` 分岐はそのまま） |
| `validation` | `renderValidationMessage(code)` を新設し `validation` 分岐から呼ぶ（`fieldErrors` があるときは従来どおりフィールド整形を優先） | `INVALID_CREDENTIALS` → 「メールアドレスまたはパスワードが正しくありません」。既定は従来どおり `error.message` |
| `business` | `renderBusinessMessage(code)` を新設し `business` 分岐から呼ぶ | `IDENTITY_PASSWORD_TOO_WEAK` → 「パスワードは8文字以上128文字以下で入力してください」／`IDENTITY_INVALID_EMAIL` → 「メールアドレスの形式が正しくありません」。既定は従来どおり `error.message` |

この3つが揃わないと Issue の「検証」節（重複メール・**弱パスワード**のエラー表示）と AC-12 を満たせない。`IdentityErrorCode` の値は `errorCode.ts` の定義（`IDENTITY_*` プレフィクス）と一致させる。

## 実装ステップ

**順序の原則:** 本 Issue は新規追加ではなく**置換**（todo → identity）なので、「内側 → 外側」だけで並べると中間状態が必ず壊れる（`UnitOfWorkContext` からスロットを消した瞬間に UoW 実装2本が、スキーマから `todos` を消した瞬間にリポジトリとユースケースがコンパイルエラーになる）。そこで **「削除 → 追加」の順に組み替え、各ステップの完了時点で `pnpm typecheck` と `pnpm test` が通る**ようにする（AC-17）。削除（ステップ3）と共通基盤・relay 統合テストの `users` / identity イベントへの移植（ステップ13）は別ステップに割る — 後者はスキーマ・リポジトリ・identity イベントが揃わないと書けないため。

適用する一般則を4つ明示しておく。後続スライスでも同じ事故が起きないようにするため。

1. **共有型（コンテナ型・コンテキスト型）を広げるステップは、その型を構築するすべての地点の更新を同一ステップに含める。** `packages/core/tsconfig.json` の `include` は `["src/**/*"]` なので `__tests__/` 配下も `pnpm typecheck` の対象であり、テストヘルパーやテスト内のリテラルも「構築地点」に数える。`UnitOfWorkContext` のスロット追加と UoW 実装2本（ステップ8）、`RequestContainer` の拡張と DI ファクトリ4本＋テストコンテナ2本＋`di/__tests__/serverCloudflare.test.ts`（ステップ11）はいずれもこの則の適用結果
2. **型では守られない実行時依存（デコーダレジストリなど）を一時的に空にするステップは、その依存を通るテストを同時に削除する。** `AllDomainEvents` を空にすると `EventDecoderRegistry` が `{}` になりデコーダを1件も型安全に登録できないため、decode 経路を通るテストは「ドメイン非依存に書き直す」ことができない（→ ステップ3 / ステップ13）
3. **型付きリンク（`Link` / `navigate` / `redirect`）で相互参照するルート群は、ファイルの作成と `routeTree.gen.ts` の再生成を先に一括で済ませる。** `router.tsx` の `declare module` によって `to` は生成された literal union に対して静的検査されるので、ルートを1本ずつ作りながら中身を書くと必ず前方参照で `pnpm typecheck` が落ちる。しかも `routeTree.gen.ts` の生成は Vite プラグイン経由で、`pnpm typecheck` 単体では走らないため「ファイルを作った＝ union に載った」ではない（→ ステップ14。後続スライス（memo / knowledge / trash の画面追加）でも同じ形を採る）
4. **ポート定義はその実装より前のステップに置く。** 本リポジトリのアダプターは例外なくポート型を import して実装するので、ポートが無い状態で実装を書くと存在しないモジュールの import になる（→ ステップ9 → ステップ10。後続スライスの `MailSender` / `PasswordResetTokenPort` でも同じ構図が再来する）

### 1. アプリケーション層のエラー契約を補う

- **対象ファイル:** `packages/core/src/application/errors/index.ts`、`apps/web/app/presentation/errorResponse.ts`
- **変更内容:** `SerializedValidationError`（`kind: "validation"`, `fieldErrors?`）と `ValidationError` クラス・`isValidationError` を application 層に追加。presentation の `errorResponse.ts` はローカル定義をやめて application から import する。**`errorResponse.ts` に `export type { SerializedValidationError }` の再エクスポートを残す** — `apps/web/app/presentation/validator.ts` が `./errorResponse` から同型を import しているため、これがあれば `validator.ts` は無変更で済む。`SerializedError` union の構成は変わらない
- **完了条件:** `pnpm typecheck` が通る
- **理由:** `loginWithPassword` の `ValidationError("INVALID_CREDENTIALS")`（UC-identity-003 / TC-loginWithPassword-003〜008）がアプリケーション層のエラー型を要求する。現状はテンプレートに存在しない（→ ADR-006）

### 2. `apps/web` 単体テスト基盤の疎通確認（独立した検証タスク）

- **対象ファイル:** `apps/web/app/presentation/__tests__/_probe.test.ts`（**確認後に削除する捨てファイル**）
- **変更内容:** 次の3点を `pnpm test:unit` で実測する。(a) ルート `vitest.config.ts`（`include` 無し・node 環境）が `apps/web` 配下の `*.test.ts` を拾うか、(b) `@/presentation/...` の `@/*` エイリアス（`apps/web/tsconfig.json` の `paths`）が node プールで解決されるか、(c) `import "@tanstack/react-start/server-only";` を含むモジュールを node プールから import できるか
- **分岐:**
  - (a)/(b) が失敗した場合 → ルート `vitest.config.ts` に `apps/web` を含む projects もしくは `resolve.alias` を追加する（この作業を本ステップに含める）
  - (c) が失敗した場合 → 想定どおり。回避策は TC ごとに違うので、**両方が純関数モジュール（`presentation/sessionCookie.ts`）で自動検証できることを確認してから先へ進む**（ステップ15）
    - **TC-logout-002** は `sessionCookie.ts` の `buildSessionCookie(null)` で担保できる（`server-only` を含まない）
    - **TC-logout-003** は `sessionCookie.ts` に置く `toSessionSystemError(cause)`（`endSession` の `SystemError` 翻訳部分を切り出した純関数）を対象にする。`sessionCookie.ts` に**限定するだけ**では TC-logout-003 は自動検証できない — 翻訳は `endSession` 側にあり、`session.ts` は `server-only` を import するため
  - (c) が成功した場合 → `session.test.ts` で `endSession` に throw する `setCookieHeader` スタブを渡す形（テスト方針の記述）をそのまま採る。`toSessionSystemError` の切り出しは (c) の成否に関わらず行う（受け皿を先に作っておく）
- **完了条件:** `pnpm test:unit` が `apps/web` 配下のテストを1件実行して緑になる。捨てファイルを削除する
- **理由:** `apps/web` 配下に非 integration の単体テストは現時点で**1件も無い**。TC-logout-002 / 003 のカバレッジ主張がこの未検証の土台に乗っているので、設計を確定させる前に事実を確認する（→ arch-risk P-006）

### 3. todo サンプル一式の削除（置換の土台づくり）

- **対象ファイル:**
  - `packages/core/src/domain/todo/`（`__tests__/` 含む一式）、`packages/core/src/application/todo/`（`__tests__/` 含む一式）
  - `packages/core/src/adapters/{d1,libsql}/repositories/todoRepository.ts`
  - `packages/core/src/adapters/{d1,libsql}/__tests__/{todoRepository,unitOfWork,occGuard,outboxRepository}.integration.test.ts`（**削除**。`users` を対象にした再実装はステップ13）
  - `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts`（同上。`mapDbError` の制約分類テストなので必ずステップ13で復活させる）
  - `packages/core/src/adapters/{d1,libsql}/__tests__/helpers.ts`、`packages/core/src/application/__tests__/helpers.ts`（`TestContainer` から todo 依存を除去）
  - `packages/core/src/application/execution/unitOfWork.ts`（`todoRepository` スロット削除）、`packages/core/src/adapters/{d1,libsql}/unitOfWork.ts`（構築の削除）
  - `packages/core/src/application/workers/eventRelayWorker.ts`（`AllDomainEvents` / `defaultEventDecoderRegistry` を一時的に空へ。`AllDomainEvents = never` になるので `DefaultEventDecoderRegistry` は `{}`、`defaultEventDecoderRegistry` も `{} satisfies …` で型検査は通る）
  - `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts`、`apps/web/app/worker/{cloudflare,node}/__tests__/*.integration.test.ts` — **3ファイルとも削除する**（identity のイベントを seed に使う形での復活はステップ13）。**「テストファイル内でその場のイベントドラフトを定義してドメイン非依存にする」ことはできない**: (1) `EventDecoderRegistry = Partial<DefaultEventDecoderRegistry>` は `AllDomainEvents` に閉じているので、空にした期間は**デコーダを1件も型安全に登録できない**、(2) `apps/web/app/worker/cloudflare/handlers.ts` の `runRelayTick` と `apps/web/app/worker/node/runner.ts` は `processOutboxEvents(container, dispatch, tuning)` を**レジストリ差し込み口なしで**呼ぶため常に `defaultEventDecoderRegistry` を使い、空レジストリでは `No decoder registered for event type "…"` で relay 成功系が落ちる（`registry` 引数を持つのは aws / gcp の `handlers.ts` だけ）。これは**型エラーではなくテスト実行時にしか出ない失敗**なので、削除で確実に閉じる（→ arch-risk P-002）
  - `apps/web/app/components/todo/`、`apps/web/app/routes/todo/`、`apps/web/app/routes/index.tsx`、`apps/web/app/routes/__root.tsx`（todo の action 副作用 import を削除）、`apps/web/app/routeTree.gen.ts`
- **変更しないもの:** `packages/core/src/adapters/d1/schema.ts` の `todos` 定義と `{d1,libsql}/migrations/0000_initial.sql`、`d1/__tests__/setup.ts` の `DELETE FROM todos`。この3つは**互いに整合したまま**にしておき、ステップ7で一括して差し替える（ここで `todos` だけ先に消すと D1 プールのグローバル `setupFiles` が `no such table: todos` で全統合テストを落とす）
- **完了条件:** `pnpm dev` を1度回して `routeTree.gen.ts` を再生成 → `pnpm typecheck` → `pnpm test:unit` → `pnpm test:integration` がすべて通る（削除したテストは実行対象から消えるので全緑は成立する。残る統合テストは `d1/__tests__/setup.ts` が維持する共通基盤側だけになる）。`/` は一時的に存在しないルートになるが、この時点ではまだ画面が無いので許容する
- **理由:** fog の初期マイグレーションを `todos` 抜きで生成するための前提であり、以後のステップをすべて「追加のみ」にして中間状態を壊さないための土台（→ ADR-001 / arch-risk P-002 / P-007）
- **注意:** このステップ完了時点から**ステップ13までの間、outbox / relay / consumer の統合検証は一時的に存在しない**。ステップ13を飛ばすと共通基盤の検証が空洞化したまま PR に乗るので、レビュー項目として明示する（→ ADR-001 の Consequences）

### 4. identity の値オブジェクトとエラーコード

- **対象ファイル:** `packages/core/src/domain/identity/errorCode.ts`、`packages/core/src/domain/identity/valueObject.ts`
- **変更内容:** `IdentityErrorCode` 定数オブジェクト（`IDENTITY_*` プレフィクス）と、UserId / Email / PlainPassword / PasswordHash / TrashRetentionDays / SsoProvider / AiClientConnectionId / ClientName / Actor を実装。Email は trim + 小文字化した値を返す
- **完了条件:** `pnpm typecheck`
- **理由:** DOM-identity-003 / 005 / 006 / 007 / 010 / 011。すべての上位レイヤーの前提

### 5. User エンティティとドメインイベント

- **対象ファイル:** `packages/core/src/domain/identity/entity.ts`、`packages/core/src/domain/identity/events.ts`
- **変更内容:** `PasswordUser | SsoUser` の判別可能ユニオン、4ファクトリ（`registerWithPassword` / `registerWithSso` / `changePassword` / `changeTrashRetentionDays`）、`reconstruct`、`IdentityEvent` union（userRegistered / passwordChanged / trashRetentionChanged）と `IdentityEvents` ドラフトファクトリ
- **完了条件:** `pnpm typecheck`
- **理由:** DOM-identity-001 / 013

### 6. identity のポート

- **対象ファイル:** `packages/core/src/domain/identity/ports/userRepository.ts`、`packages/core/src/domain/identity/ports/passwordHasher.ts`
- **変更内容:** `UserRepository`（insert / save / findById / findByEmail、`TransactionalRepository` を extends しない）と `PasswordHasher`
- **完了条件:** `pnpm typecheck`
- **理由:** DOM-identity-018〜021 / 029 / 030

### 7. スキーマと初期マイグレーションの fog 化

- **対象ファイル:** `packages/core/src/adapters/d1/schema.ts`、`packages/core/src/adapters/{d1,libsql}/migrations/`、`packages/core/src/adapters/libsql/__tests__/helpers.ts`、`packages/core/src/adapters/d1/__tests__/setup.ts`、`apps/web/data/app.db`
- **変更内容:**
  1. `d1/schema.ts` から `todos` を削除し `users` を追加。制約は**名前付きで6本 + インデックス2本**: 直和 CHECK 1本（テーブル制約）・`users_auth_method_valid`（`auth_method IN ('password','sso')`）・`users_sso_provider_valid`（`sso_provider IS NULL OR sso_provider IN ('google','apple')`）・`users_sso_subject_nonempty`（`sso_provider_subject IS NULL OR length(sso_provider_subject) > 0`）・`users_trash_retention_positive`（`trash_retention_days >= 1`）・`users_email_uq`（`uniqueIndex().on(email)`）・部分一意 `users_sso_identity_uq`
  2. 既存の `0000_initial.sql`（d1 / libsql 双方）と libsql の `meta/` を破棄し、**`apps/web` ディレクトリの中で** `pnpm db:generate:cf --name initial` / `pnpm db:generate:node --name initial` を直接実行して再生成する（未リリースなので `0001_*` を積まずリセットする）。ルートの `pnpm db:generate:cf -- --name initial` は `pnpm --filter @repo/web …` への委譲を経由する2段構成で、引数が `--filter` 側のフラグとして解釈される余地があるため使わない（→ arch-risk S-005）
  3. **`libsql/__tests__/helpers.ts` を `meta/_journal.json` 走査に書き換える** — 現在は `../migrations/0000_initial.sql` を `readFileSync` で固定参照しており、生成ファイル名が変われば libsql 統合テストが全滅する。journal の `tag` 順に全 SQL を読んで `--> statement-breakpoint` で分割・順次適用する形にすれば、将来 `0001_*` を積んでも壊れない
  4. **`d1/__tests__/setup.ts` の `DELETE FROM todos` を `DELETE FROM users` に置き換える**（グローバル `setupFiles`。ここを直さないと D1 プールの全統合テストが落ちる）。`afterEach` の `_occ_guard` 空表明は**そのまま維持**する（共通基盤検証の核）
  5. `pnpm db:migrate` でローカル DB（`apps/web/data/app.db`）を作り直す
- **完了条件:**
  1. **`git diff` で d1 / libsql 両方の生成 SQL を目視確認する。** 型検査では検出できないので目視が唯一の関門。確認項目は次の8点（→ arch-risk P-003）
     - (a) 認証方式の直和 CHECK がテーブル制約1本として出ている
     - (b) `CREATE UNIQUE INDEX users_sso_identity_uq … WHERE sso_provider IS NOT NULL`（部分一意）が出ている
     - (c) `users_sso_subject_nonempty`（`sso_provider_subject` の非空）CHECK が出ている
     - (d) `users_sso_provider_valid`（`sso_provider` 値域）CHECK が出ている
     - (e) **`users_auth_method_valid`（`auth_method` 値域）CHECK が出ている**
     - (f) **`users_trash_retention_positive`（`trash_retention_days >= 1`）CHECK が出ている** — どの直和 CHECK にも含まれない独立の不変条件なので、抜けるとノーガードになる
     - (g) **`users_email_uq`（`email` の UNIQUE）が出ている** — ADR-008 の読み替えが依存する制約
     - (h) 共通基盤3テーブル（`outbox_events` / `processed_events` / `_occ_guard`）と `idx_outbox_pending` の部分インデックス、`_occ_guard` の `occ_guard_positive` CHECK が欠けていない
  2. **d1 に `meta/` が生成された後も D1 プールがブートすることを確認する** — `vitest.config.integration.ts` は `const migrations = await readD1Migrations(…)` を **config のトップレベルで await している**ため、ここが失敗すると D1 プールの統合テストが1件も起動しない。`pnpm test:integration:cf` を回し、**テスト内容の成否と無関係に「起動する」ことだけ**を確認する（→ arch-risk S-004）
  3. `pnpm db:migrate` でローカル DB が作り直せる
  4. d1 側に新たに生成される `meta/` はコミットする（以後 drizzle 管理に切り替わる。→ ADR-001）
- **理由:** ADP-users-001 / ADP-outbox-001 / ADP-processed-events-001 / ADP-occ-guard-001（→ ADR-001 / arch-risk P-003 / S-004 / S-005）

### 8. UserRepository のアダプター実装と UoW スロットの復活

- **対象ファイル:** `packages/core/src/adapters/{d1,libsql}/repositories/userRepository.ts`、`packages/core/src/adapters/{d1,libsql}/unitOfWork.ts`、`packages/core/src/application/execution/unitOfWork.ts`
- **変更内容:** `UnitOfWorkContext` に `userRepository: UserRepository` を追加し、UoW 実装2本で構築する。リポジトリは削除済み `todoRepository.ts`（git 履歴 / `docs/backend_implementation_example.md`）を基準形とし、再水和・`ExpectedVersion` の唯一のキャスト地点・`mapDbError` / `pending.addOcc` の流儀を踏襲する。`d1/repositories/todoRepository.ts` にあった「PK 衝突は `SystemError` になる」というコメントは**実装と食い違っている**（実際は `ConflictError("UNIQUE_VIOLATION")`）ので引き継がない
- **完了条件:** `pnpm typecheck`
- **理由:** ADP-identity-001〜004。スロット追加と実装を同一ステップにするのは、片方だけでは型検査が通らないため

### 9. `SessionCodec` ポートの定義（型の追加のみ）

- **対象ファイル:** `packages/core/src/application/ports/sessionCodec.ts`（新規）
- **変更内容:** `SessionCodec`（`issue` / `verify`）インターフェースを定義する。**このステップでは `RequestContainer` を触らない** — コンテナ型を広げるのは、その構築地点をすべて同時に更新できるステップ11でまとめて行う
  - `sessionCodec.ts` の library-level JSDoc: 「このポートは **presentation 層専用**である。ユースケースから参照してはならない。セッションの生成・破棄・Cookie 管理は presentation の責務（spec/domains/identity.md「スコープに関する注意」）」（→ arch-risk S-002 / ADR-002）
- **完了条件:** `pnpm typecheck`（新規ファイルの追加だけなので当然通る）
- **理由:** **ステップ10（`hmacSessionCodec.ts`）の前提。** 本リポジトリのアダプターは例外なくポート型を import して実装する（`D1IdempotencyStore implements IdempotencyStore`、`D1OutboxRepository` の `import type { OutboxRepository }`、`InProcessRelayTrigger = RelayTrigger & {…}`）。この規約どおりに書く以上、`SessionCodec` が未定義のまま `hmacSessionCodec.ts` を書くと存在しないモジュールの import で **TS2307** になり、ステップ10の完了条件（`pnpm typecheck`）が満たせない。ポート定義は単独で型検査を壊さないので、前倒ししてもコストがゼロである一方、`RequestContainer` の拡張（ステップ11）とは引き続き分離する（→ 順序の原則 4 / round-3 arch-risk P-001）

### 10. WebCrypto アダプター（PasswordHasher / SessionCodec）

- **対象ファイル:** `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`、`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`
- **変更内容:**
  1. **先に workerd 実測を行う** — Miniflare プールで `crypto.subtle.deriveBits({ name: "PBKDF2", iterations: 210_000, … })` を1回だけ叩く捨てテストを書き、成功可否と所要時間を測る（workerd が反復回数に上限を課すという報告があるため）。結果を PR 説明に残し、捨てテストは削除する
  2. `createPbkdf2PasswordHasher({ iterations = 210_000 })` — **反復回数をファクトリ引数**にする（環境変数にはしない）。PBKDF2-HMAC-SHA256 / 16byte salt / 32byte 出力 / `pbkdf2-sha256$<iterations>$<saltB64>$<hashB64>` 形式・定数時間比較。計算失敗は `SystemError`、照合不一致は `false`
  3. `createHmacSessionCodec({ secret, ttlMs })` — HMAC-SHA256 署名付きトークン。改ざん・期限切れは `null`。**ステップ9で定義した `SessionCodec` を import して実装する**（`PasswordHasher` はステップ6、`PlainPassword` / `PasswordHash` はステップ4で既に揃っている）
  4. 実測で workerd が 210,000 回を扱えない場合は、ADR-003 の代替案（identity の統合テストだけ node プールへ移す／反復回数を10万に下げる）から選び、選択理由を ADR-003 に追記する
- **完了条件:** `pnpm typecheck`。実測結果を ADR-003 に記録
- **理由:** ADP-identity-012 / 013 とセッション基盤（→ ADR-002 / ADR-003 / arch-risk P-004）

### 11. コンテナ型の拡張・DI 配線・環境変数（構築地点を一括更新）

**このステップは分割できない。** `RequestContainer` に必須メンバを足すと、その型をオブジェクトリテラルで構築しているすべての地点が不足プロパティで型エラーになる。`packages/core/tsconfig.json` の `include` は `["src/**/*"]` なので `__tests__/` 配下も `pnpm typecheck` の対象であり、テストヘルパーとテスト内のリテラルも構築地点に数える（→ arch-risk P-001 / 順序の原則 1）。

- **対象ファイル:**
  - 型: `packages/core/src/application/di/types.ts`
  - DI ファクトリ4本: `packages/core/src/application/di/server{Node,Cloudflare,Aws,Gcp}.ts`
  - **テストコンテナ2本**: `packages/core/src/adapters/d1/__tests__/helpers.ts`、`packages/core/src/application/__tests__/helpers.ts`（どちらも `TestContainer = RequestContainer & WorkerContainer & { db }` を**リテラルで**返す）
  - **既存 DI テスト1本**: `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — `function envWith(overrides): ServerEnv { return { DB: …, APP_URL: …, ...overrides }; }` が `ServerEnv` のリテラルを組み立てている。`SESSION_SECRET` を **optional** で足す方針（下記2）なら型エラーにはならないが、コンテナ生成を通る既存テストが秘密鍵検証で落ちないよう、`envWith` の既定値に32文字以上のダミーを入れておく
  - 設定・環境変数: `packages/core/src/config.ts`、`apps/web/.env.example`、`apps/web/.env`、`apps/web/.dev.vars.example`、`apps/web/.env.aws.example`、`apps/web/.env.gcp.example`
  - **デプロイ側の env 列挙**: `infra/aws/lib/appStack.ts`（`sharedEnv` ではなく `appFn` の `environment` にだけ足す。`sharedEnv` は `Record<string, string>` なので**型検査では漏れを検出できない**）、`infra/gcp/example/services/{main.tf,variables.tf}`（`local.shared_env` ではなく `google_cloud_run_v2_service.app` の `merge(...)` 側と、対応する `variable "session_secret"`）（→ round-3 arch-risk S-001）
  - `packages/core/src/adapters/libsql/__tests__/helpers.ts` は `TestContainer` が独自の `Readonly<{…}>` で `RequestContainer` を含まないため**このステップでは変更不要**（フェイクハッシャー差し替え口が要るのはステップ13）
- **変更内容:**
  1. `RequestContainer` に `passwordHasher: PasswordHasher` と `sessionCodec: SessionCodec` を追加。`types.ts` の `RequestContainer` の JSDoc に「ドメインポートは原則 `UnitOfWorkContext` からのみ取得する。`passwordHasher` はその**意図的な例外**であり、理由は非トランザクショナルであること・UoW 外での実行を spec/usecases/identity.md が要求していること」を書く（→ arch-risk S-001）
  2. env スキーマに `SESSION_SECRET` を追加するが、**zod 側は optional にとどめ、必須性（32文字以上）の検証は `createXxxRequestContainer` で行い不足時に throw する**。4ランタイムで同じ意味論に揃える（Cloudflare の `ServerEnv` は型宣言のみで zod スキーマを持たないため、もともとこの形しか採れない）。必須にしない理由は、`readAwsServerEnv()` / `readGcpServerEnv()` を **`apps/web/app/worker/{aws,gcp}/handlers.ts` も呼ぶ**ため、セッションを扱わない relay / consumer / pruner / dlq が起動できなくなること、そして `infra/aws` / `infra/gcp` の env 列挙漏れが**型検査でもテストでも検出できずデプロイ時にしか出ない**こと（→ round-3 arch-risk S-001 / ADR-004）
  3. `RequestServerConfig` に `secrets: { sessionSecret: string }` を**ネスト**して足し、4本の `createXxxRequestContainer` の rest-spread に `secrets` を1つ追加する。**分解の形はランタイムで異なる**ので写経しない
     - Node / AWS / GCP: `const { db: _db, relayTrigger: _relayTrigger, secrets, ...appConfig } = config;`
     - Cloudflare: `const { binding: _binding, relay, waitUntil, secrets, ...appConfig } = config;`（→ arch-risk S-001）
     - `appConfig satisfies AppConfig` は変数への `satisfies` なので余剰プロパティ検査が効かず、**ネストしない限り秘密は型エラーなしで `container.config` → クライアントの HTML ペイロードへ流れる**
  4. 秘密鍵は `createHmacSessionCodec({ secret, ttlMs })` の構築にだけ使い、`RequestContainer` には載せない
  5. 4本の request コンテナに `passwordHasher: createPbkdf2PasswordHasher()` / `sessionCodec: createHmacSessionCodec(…)` を配線
  6. テストコンテナ2本に同じ2スロットを足す（この時点では実装をそのまま入れてよい。フェイクハッシャーの差し替え口はステップ13で足す）
  7. `di/__tests__/serverCloudflare.test.ts` の `envWith` の既定値に `SESSION_SECRET: "…"`（32文字以上のダミー）を足す（コンテナ生成地点の検証で落ちないようにするため）
  7-2. `infra/aws/lib/appStack.ts` の `appFn.environment` と `infra/gcp/example/services/{main.tf,variables.tf}` の app サービス側に `SESSION_SECRET` を足す。**ワーカー（4 Lambda / 3 Cloud Run サービス）には配らない** — 秘密の配布範囲をセッションを使う実行地点に限定する
  8. `config.ts` の `content` を fog のサイト名・説明に更新
  9. wrangler では `SESSION_SECRET` を `[vars]` に置かず **secret（`wrangler secret put` / `.dev.vars`）として扱う**（`wrangler.toml` は `[env.*]` 間で `vars` を継承しないため、`[vars]` に置くと1ファイル5ブロック × 3ファイルの追記になるうえ秘密が平文で入る）
- **完了条件:** `pnpm typecheck` と `pnpm test` が通る。`.env` に `SESSION_SECRET` を入れて `pnpm dev` が起動する
- **理由:** ユースケースは `container.passwordHasher` を使う。セッションは presentation が使うが秘密鍵を握るのは DI。起動導線でもある（→ ADR-002 / ADR-004 / arch-risk P-001）

### 12. identity ユースケースと DTO・イベントデコーダ

- **対象ファイル:** `packages/core/src/application/identity/{registerWithPassword,loginWithPassword,logout,getCurrentUser,view,eventDecoders}.ts`、`packages/core/src/application/workers/eventRelayWorker.ts`
- **変更内容:** 4ユースケースを spec/usecases/identity.md の処理フローどおりに実装。`registerWithPassword` は UoW 外で hash → UoW 内で `findByEmail` 事前検証 → `insert` → `collectEvents`。UoW flush 時の `ConflictError("UNIQUE_VIOLATION")` を `EMAIL_ALREADY_REGISTERED` に読み替え、**その catch に前提条件を JSDoc で明記**する（「同一 UoW の書き込みが users への insert 1件 + outbox insert のみ」かつ「insert 対象が PasswordUser（sso 列 NULL）なので `users_sso_identity_uq` は発火し得ない」。前提が崩れる書き込みを足すときは読み替えを外すこと。→ ADR-008）。`loginWithPassword` は全失敗を `ValidationError("INVALID_CREDENTIALS")` に統一。`loginWithPassword` / `getCurrentUser` は純読み取り UoW 経由でリポジトリを取る（→ ADR-009）。`CurrentUserView` は資格情報を含めない。**`AllDomainEvents` を `IdentityEvent` に、`defaultEventDecoderRegistry` を `{ ...identityEventDecoders }` に埋め直す** — ここで初めてデコーダを型安全に登録できるようになるので、ステップ3で削除した relay / consumer 統合テストの復活（ステップ13）がこのステップに依存する
- **完了条件:** `pnpm typecheck`
- **理由:** UC-identity-001 / 003 / 004 / 013

### 13. 共通基盤・relay / consumer 統合テストの復活

- **対象ファイル:**
  - 共通基盤（`users` へ移植）: `packages/core/src/adapters/{d1,libsql}/__tests__/{unitOfWork,occGuard,outboxRepository}.integration.test.ts`、`packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts`
  - relay / consumer（identity イベントへ移植）: `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts`、`apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`、`apps/web/app/worker/node/__tests__/runner.node.integration.test.ts`
  - ヘルパー: `packages/core/src/adapters/{d1,libsql}/__tests__/helpers.ts`、`packages/core/src/application/__tests__/helpers.ts`
- **変更内容:**
  1. ステップ3で削除した共通基盤テストを、対象集約を `users` に置き換えて**書き直す**（git 履歴の todo 版が下敷き）。`helpers.integration.test.ts` は `users_email_uq`（UNIQUE）と `users` の PK を衝突フィクスチャとして `mapDbError` の制約分類（`SQLITE_CONSTRAINT_UNIQUE` / `SQLITE_CONSTRAINT_PRIMARYKEY` → どちらも `ConflictError("UNIQUE_VIOLATION")`）と `isOccGuardViolation` の検出を検証する
  2. ステップ3で削除した relay / consumer 統合テストを、seed イベントを `TodoEvents.created(...)` から **`IdentityEvents.userRegistered(...)`** に置き換えて書き直す。`AllDomainEvents` がステップ12で `IdentityEvent` になっているので、`defaultEventDecoderRegistry` が `identity.userRegistered` のデコーダを持ち、`runRelayTick` / node `runner.ts`（レジストリ差し込み口を持たない）の経路でも decode が成立する（→ arch-risk P-002）
  3. `TestContainer` ヘルパー3本（d1 / libsql / application）に**フェイクハッシャーの差し替え口**を追加する（`createTestContainer({ passwordHasher })` のような任意引数）。libsql の `TestContainer` は `RequestContainer` を含まない独自形なので、必要なスロットだけ足す
- **完了条件:** `pnpm test:integration` が通る（削除期間に落ちていた relay / consumer / 共通基盤の検証がすべて戻る）
- **理由:** ADP-occ-guard-001 / ADP-outbox-001 の実効的な検証。ここを落とすと共通基盤の検証が空洞化する（本 Issue の目的そのもの → ADR-001 / arch-risk P-002）

### 14. ルートファイルの骨組みと `routeTree.gen.ts` の先行生成

- **対象ファイル:** `apps/web/app/routes/{login,signup,password-reset}.tsx`、`apps/web/app/routes/_app.tsx`、`apps/web/app/routes/_app/{index,topics,search,trash,settings}.tsx`、`apps/web/app/routeTree.gen.ts`
- **変更内容:**
  1. 上記9本のルートファイルを **中身のない骨組みとして一括作成する** — `createFileRoute(...)({ component: … })` の宣言と、`null`（または見出し1行）を返すコンポーネントだけ。`beforeLoad` / `validateSearch` / `loader` / フォーム・シェルの実装は書かない（ステップ18〜22で中身を埋める）。`_app.tsx` だけは `<Outlet/>` を描画する（子ルートが解決しなくなるため）
  2. **`pnpm dev`（または `pnpm build`）を1度回して `routeTree.gen.ts` を再生成し、差分をコミットする** — 生成は TanStack Router の Vite プラグイン経由なので `pnpm typecheck` 単体では走らない。ステップ3で `routes/index.tsx` を消して以降、`to` の literal union から `'/'` が消えたままになっているのをここで戻す
- **完了条件:** `routeTree.gen.ts` の `to` union に `/login` / `/signup` / `/password-reset` / `/`（`_app/index`）/ `/topics` / `/search` / `/trash` / `/settings` の8経路が載り、`pnpm typecheck` が通る
- **理由:** `apps/web/app/router.tsx` が `declare module "@tanstack/react-router" { interface Register … }` でルーターを登録しているため、`<Link to>` / `router.navigate({ to })` / `redirect({ to })` の `to` は **`routeTree.gen.ts` が生成する literal union に対して静的に検査される**。ルートを1本ずつ「作りながら中身を書く」順に並べると、ステップ15（`requireUserId()` が `redirect({ to: "/login" })` を投げる）・ステップ18（`/signup` / `/password-reset` へのリンクと `search.redirect ?? "/"`）・ステップ19（成功時に `/` へ遷移）・ステップ21（`AppShell` から `/settings` へのリンク）がいずれも**まだ存在しないルート**を指し、その時点で `pnpm typecheck` が落ちて AC-17 の宣言と食い違う。骨組みを先に一括生成すればこの前方参照が消え、以後のステップは「中身を書く」だけになる（→ 順序の原則 3 / round-3 coverage P-001）

### 15. セッション Cookie と認証ガード（presentation）

- **対象ファイル:** `apps/web/app/presentation/sessionCookie.ts`（新規・純関数）、`apps/web/app/presentation/session.ts`、`apps/web/app/presentation/currentUser.ts`、`packages/core/src/application/errors/index.ts`
- **変更内容:**
  - `errors/index.ts`: `SystemErrorCode` に **`SessionError: "SESSION_ERROR"`** を追加する（`RETRYABLE_SYSTEM_CODES` には入れない）。同ファイルの JSDoc が「外部リソースごとに1エントリ足せ」「`DatabaseError` は storage layer が throw した意」と明記しているので、Cookie ヘッダー書き込み失敗に `DATABASE_ERROR` を流用しない（→ ADR-010 / arch-risk S-002）
  - `sessionCookie.ts`: `SESSION_COOKIE_NAME`、`buildSessionCookie(token | null, opts)`、**`toSessionSystemError(cause): SystemError`**（`SystemError(SystemErrorCode.SessionError, …, cause)` を返す純関数）。**フレームワーク import を持たない**（`server-only` を含めない）ので node プールの単体テストから読める。`toSessionSystemError` をここに置くのは、ステップ2の分岐 (c) が成立した場合でも TC-logout-003 の自動検証手段を純関数モジュールに残すため（→ coverage S-002 / P-002 / arch-risk P-006）
  - `session.ts`: `import "@tanstack/react-start/server-only";` + `startSession` / `endSession` / `readSessionToken`。Cookie 文字列は `sessionCookie.ts` に委譲。**ヘッダー書き込みを `setCookieHeader` という差し替え可能な引数**（既定はフレームワーク実装）で受け取り、`try / catch` で未知の例外を `toSessionSystemError(cause)` に翻訳して throw する。素の例外だと presentation の `serializeError` が `kind: "unknown"` にフォールバックし、TC-logout-003 の期待（`SystemError` として扱われる）を満たせないため
  - `currentUser.ts`: `getCurrentUserId()`（`cache()` でリクエスト内デデュープ・`getContainer()` 直呼びの escape hatch）、`requireUserId()`（未認証は `redirect({ to: "/login", search: { redirect } })`）
- **完了条件:** `pnpm typecheck`
- **理由:** UC-identity-004 の「セッション破棄は presentation 責務」、AC-9 / AC-15、TC-logout-002 / 003（→ ADR-005 / ADR-010 / coverage P-003 / P-002 / arch-risk S-002 / S-007）

### 16. デザイントークンの差し替え

- **対象ファイル:** `apps/web/app/styles/tokens.css`、`apps/web/app/styles/theme.css`、`apps/web/app/styles/index.css`、`apps/web/app/components/ui/Skeleton/index.tsx`
- **変更内容:**
  1. `tokens.css` を spec/design/tokens.md の値で全面置換（カラー / タイポ / スペーシング / 角丸 / 影 / トランジション / コンテナ / ボーダー / アイコン寸法）
  2. `theme.css` を `tokens.css` と **lockstep で全面書き直し** — 現行がマップしている `--color-neutral-{150,250,…,850}` の**半段階は spec に存在しない**ので削除し、spec が追加するトークン（`--color-*-dark` / `--color-*-bg` / `--pad-*` / `--icon-*` / `--content-max` 等）を新たに `@theme` へ露出する。放置すると8個の未定義参照が残る
  3. `Skeleton` の背景を `bg-neutral-200` から `--color-neutral-300` 相当へ変更 — spec の `--color-neutral-200` は `--color-bg-page` と**同一値**で、差し替え後はスケルトンが背景に溶けて**不可視**になる（クラス名は解決するので型・ビルドエラーにはならない）
  4. `prefers-reduced-motion: reduce` でトランジションを無効化する指定を base に追加
- **完了条件:**
  1. `pnpm dev` でページが破綻しない（この時点のルートはステップ14の**空の骨組み**なので、`__root.tsx` のシェルだけで確認する）
  2. **`Skeleton` の背景がページ背景と異なることを確認する。** ステップ3で `components/todo/TodoListSkeleton` が消えているので、この時点で `Skeleton` を描画するのは `components/ui/RoutePendingFallback`（`router.tsx` の `defaultPendingComponent`）**だけ**であり、それも `defaultPendingMs: 200` を超えてブロックするローダーがある画面でしか出ない。つまり「`pnpm dev` で眺める」では確認できない。実在する確認手段は次のいずれか（→ arch-risk S-006）
     - (a) `RoutePendingFallback` を `__root.tsx` に一時的に直接描画して目視し、確認後に戻す
     - (b) DevTools で `--color-neutral-300`（`Skeleton` の新しい背景）と `--color-bg-page` の解決値を読み、**異なる値であることを確認する**
  3. 新旧トークンの差分確認: `theme.css` に `--color-neutral-{150,250,…,850}` の半段階参照が残っていないこと（grep）
- **理由:** PAGE-login-001 / PAGE-signup-001 / PAGE-common-001 を spec/design に忠実に実装する前提。トークン外の生値を書かないという一貫性ルール（spec/design/index.md → arch-risk S-005 / S-006）

### 17. UI プリミティブ

- **対象ファイル:** `apps/web/app/components/ui/{Button,TextField,FormMessage,AuthSheet}/index.tsx`
- **変更内容:** `spec/design/pages/login.html` の `.btn` / `.btn-primary` / `.btn-outline` / `.form-group` / `.form-label` / `.form-input` / `.field-error` / `.error-message` / `.auth-sheet` に対応する最小プリミティブ。フォーカスリング・`aria-invalid` / `aria-describedby` を組み込む。**エラー表示に `text-red-500` のようなテンプレート既定パレット由来のクラスを使わず、`--color-error` 由来のクラスを使う**（AC-18）。`Button` は `disabled` と進行表示（スピナー or ラベル差し替え）を props で持つ（AC-10 / AC-12 の送信中表示で使う）
- **完了条件:** `pnpm typecheck` / `pnpm lint:fix`
- **理由:** 認証2画面と設定プレースホルダーで再利用する。基準形から写す（spec/design/index.md）

### 18. `/login`（P-01）

- **対象ファイル:** `apps/web/app/routes/login.tsx`、`apps/web/app/components/auth/schema.ts`、`apps/web/app/components/auth/errorField.ts`、`apps/web/app/components/auth/LoginForm/{index.tsx,action.ts}`、`apps/web/app/presentation/errorDisplay.ts`
- **変更内容:** ルートは `validateSearch` で `?redirect=`（`/` 始まり・`//` を含まない）を受け、認証済みなら `beforeLoad` で redirect する。**遷移先は `search.redirect ?? "/"`**（`validateSearch` で検証済みの値）— `?redirect=/settings` を持ったまま `/login` に到達したケース（別タブで先にログイン済み・戻るボタン）で元 URL を捨てないため。AC-9 の「ログイン後に元の URL へ戻る」と経路をそろえる（→ arch-risk S-003）。`LoginForm` は `useActionState` + `useServerFn(loginFn)`、**送信中は `isPending` でボタンを無効化し進行表示**、失敗は「メールアドレスまたはパスワードが正しくありません」をフォーム上部に表示。成功で `router.navigate({ to: redirect })` → `router.invalidate()`。`/signup` と `/password-reset` へのリンクを置く。`auth/schema.ts` は shape / DoS のみ（長さ上限は 1024。最低長8も上限128も書かない）。`errorDisplay.ts` に **`renderValidationMessage(code)` を新設**して `validation` 分岐から呼び、`INVALID_CREDENTIALS` の文言を割り当てる（`fieldErrors` があるときは従来どおりフィールド整形を優先）
- **完了条件:** `pnpm dev` で `/login` が表示され、失敗時に日本語文言が出る
- **理由:** PAGE-login-001 / 002 / 004 / 005（→ coverage P-004 / arch-risk S-004）

### 19. `/signup`（P-02）

- **対象ファイル:** `apps/web/app/routes/signup.tsx`、`apps/web/app/components/auth/SignupForm/{index.tsx,action.ts}`、`apps/web/app/presentation/errorDisplay.ts`
- **変更内容:** `signupFn` → `registerWithPassword` → `startSession` → `/` へ遷移。**送信中は `isPending` でボタンを無効化し進行表示**（連打しても登録は1回だけ実行される。manual TC-15）。`errorField.ts` のマッピングで `IDENTITY_INVALID_EMAIL` / `IDENTITY_PASSWORD_TOO_WEAK` を項目直下に、`EMAIL_ALREADY_REGISTERED` はメール欄のエラー＋ログインへの導線として表示。`/login` へのリンクを置く。`errorDisplay.ts` に **`renderBusinessMessage(code)` を新設**して `business` 分岐から呼び（`IDENTITY_PASSWORD_TOO_WEAK` →「パスワードは8文字以上128文字以下で入力してください」、`IDENTITY_INVALID_EMAIL` →「メールアドレスの形式が正しくありません」）、既存 `renderConflictMessage` に `EMAIL_ALREADY_REGISTERED` →「このメールアドレスは登録済みです」を追加する
- **完了条件:** `pnpm dev` で登録が成立し、弱パスワード・メール形式不正・重複メールがそれぞれ日本語で表示される
- **理由:** PAGE-signup-001 / 002 / 004（→ coverage P-002 / P-004）

### 20. `/password-reset` プレースホルダー

- **対象ファイル:** `apps/web/app/routes/password-reset.tsx`
- **変更内容:** ステップ14で作った骨組みの中身を書く。認証シートの中に「準備中」と `/login` への戻り導線のみを置く最小ルート
- **理由:** PAGE-login-005 の「導線が機能する」を型安全なリンクで成立させるため（→ ADR-007）。ルート自体はステップ14で存在しているので、このステップは表示内容だけを担う

### 21. 認証必須レイアウトとグローバルナビ

- **対象ファイル:** `apps/web/app/routes/_app.tsx`、`apps/web/app/routes/_app/{index,topics,search,trash}.tsx`、`apps/web/app/components/layout/AppShell/index.tsx`
- **変更内容:** ステップ14で作った骨組み（`_app.tsx` / `_app/{index,topics,search,trash}.tsx`）の中身を書く。`_app.tsx` の `beforeLoad` でセッション検証用 server fn を呼び、未認証は `/login?redirect=…` へ redirect（**先回りリダイレクトであって権威あるガードではない** — データを読む各サーバー実行地点は自分で `requireUserId()` を通す）。`_app.tsx` に `staleTime: 0` を置き、ログアウト後の戻るボタンでルーターキャッシュから保護画面が復元されないようにする（manual TC-23）。`component` は `AppShell`（`"use client"`、`<Outlet/>` を内包）。`AppShell` は lg 以上で常設サイドバー、未満ではヘッダーのメニューから開く下部シート（spec/pages は「下部タブ相当」と表現するが、承認済みデザイン `spec/design/pages/timeline.html` の実装形が `aria-controls="nav-sh"` のメニュー → `.nav-sheet` なのでデザイン成果物に従う。表現差は spec-sync 対象）。5項目に `aria-current="page"` を配線。`_app/index.tsx` は空状態のタイムライン、`topics` / `search` / `trash` はプレースホルダー
- **完了条件:** 5項目すべてから遷移でき、現在地が示される
- **理由:** PAGE-common-001、AC-9（→ arch-risk S-008 / S-012）

### 22. `/settings` の最小形とログアウト

- **対象ファイル:** `apps/web/app/routes/_app/settings.tsx`、`apps/web/app/components/settings/{CurrentUserPanel,LogoutButton}/`
- **変更内容:** サーバーコンポーネントで `requireUserId()` → `getCurrentUser` を呼び email / 認証方式を表示（UC-identity-013 の実呼び出し地点）。`LogoutButton` は `logoutFn`（`logout` ユースケース + `endSession()`）を叩き、`router.invalidate()` → `router.navigate({ to: "/login", replace: true })` の順で遷移する（`replace` で履歴に保護画面を残さない）
- **完了条件:** ログアウト後に戻るボタンで保護画面へ戻れない（manual TC-23）
- **理由:** UC-identity-004・AC-15。spec/pages/index.md がログアウトを P-13 に置いている（手動テストの大半が「設定画面からログアウトする」を手順に含むため、この画面が無いと TC-05 / 06 / 12〜16 / 19 / 20 / 22 / 23 が実行できない）

### 23. ルート・起動導線の仕上げ

- **対象ファイル:** `apps/web/app/routes/__root.tsx`、`apps/web/app/routeTree.gen.ts`、`apps/web/app/router.tsx`
- **変更内容:** `__root.tsx` に `@/components/auth/LoginForm/action` / `SignupForm/action` / `@/components/settings/LogoutButton/action` の副作用 import を追加（クライアント島からのみ参照される server fn を RSC マニフェストに載せるため）。head / lang / アセットは既存のまま。**`pnpm dev`（または `pnpm build`）をもう1度回して `routeTree.gen.ts` を再生成する** — ルート集合はステップ14で確定しているので**差分が出ないのが正常**であり、ここで差分が出たらステップ14以降にルートファイルを増減させた（＝骨組みの一括生成から漏れた）ことを意味する。差分が出た場合はコミットする
- **完了条件:** `routeTree.gen.ts` に `/login` `/signup` `/password-reset` `_app/*` が載っており（ステップ14で載る）、再生成しても差分が出ない。`pnpm typecheck` が通る
- **理由:** テンプレート既知の罠。ここを忘れると server function が実行時に見つからず、routeTree が stale だと型が合わない（→ arch-risk S-006）

### 24. テスト

- **対象ファイル:** `packages/core/src/domain/identity/__tests__/{valueObject,entity,events}.test.ts` + `*.property.test.ts`、`packages/core/src/application/identity/__tests__/{identity.integration.test.ts,eventDecoders.test.ts,logout.test.ts}`、`packages/core/src/adapters/{d1,libsql}/__tests__/userRepository.integration.test.ts`、`packages/core/src/adapters/webcrypto/__tests__/{pbkdf2PasswordHasher,hmacSessionCodec}.test.ts`、`apps/web/app/presentation/__tests__/sessionCookie.test.ts`、`apps/web/app/presentation/__tests__/session.test.ts`、`packages/core/src/application/di/__tests__/*.test.ts`
- **変更内容:** 「テスト方針」の対応表どおりに実装。加えて **`loadAppContext` が返す `config` のキー集合を表明する回帰テスト**を1件足し、`SESSION_SECRET` が `container.config` に混入しないことを恒久的に守る（→ arch-risk P-001）
- **理由:** TC-* 39件（+ TC-logout-002 / 003 の一部手動）

### 25. 品質ゲート

- **対象ファイル:** —
- **変更内容:** `routeTree.gen.ts` 再生成 → `pnpm typecheck && pnpm lint:fix && pnpm format` → `pnpm test:unit` → `pnpm test:integration` → `pnpm db:migrate && pnpm dev` で spec/manual-tests/account.md の **TC-01 / 02 / 05 / 06 / 12 / 13 / 14 / 15 / 16 / 19 / 20 / 22 / 23 / 34 / 35 / 36** を手動確認
  - **境界値3件（TC-34 / 35 / 36）を含める理由**（→ coverage S-001）
    - **TC-34（パスワード 7文字 / 8文字）** — Issue の「検証」節が名指しする「**弱パスワードのエラー表示**」の、spec 上の手動検証手段そのもの。他のリスト項目（TC-12 = 必須項目未入力、TC-13 = メール形式不正）は弱パスワードを UI で確認しない
    - **TC-35（パスワード 128文字 / 129文字）** — `auth/schema.ts` の上限を 128 → **1024** に変えた判断の**唯一の UI 検証手段**。この変更の目的は「129文字が transport の `validation` ではなくドメインの `PasswordTooWeak`（business）として項目直下に出ること」であり、自動テスト（VO の property テスト / ユースケース直呼び）は transport 層を通らないので検証できない
    - **TC-36（メール 320文字 / 321文字）** — 同じ理由で email 上限 1024 の妥当性を UI 側で閉じる
    - この3件を足すと AC-12 の「メール形式不正・パスワード要件未満は項目ごとに表示」が spec の手動 ID で完全に閉じる
  - **TC-01 の「SSOボタンが表示されている」は本スライスでは対象外**（SSO 未実装のため意図的に描画しない）。それ以外の確認項目（メール欄・パスワード欄・「アカウント登録」導線・「パスワードをお忘れですか？」導線）だけを確認し、乖離を PR 説明と手動テスト結果に明記する
  - **TC-37（リセット時の新パスワード境界）と事後処理節（TC-11 でパスワードを戻す）は実行不能**（パスワードリセット / パスワード変更が本スライス外）。SSO / OAuth / パスワードリセット本体に関する TC も同様に対象外として PR に明記する
- **理由:** AC-17、および Issue の「検証」節

## チェックリスト対応表

Issue 本文の実装チェックリスト75行と実装ステップの対応。**ステップ番号は改訂後（全25ステップ）のもの。**

### ドメイン（14件）

| ID | 要素 | ステップ |
|---|---|---|
| DOM-identity-001 | User エンティティ | 5 |
| DOM-identity-003 | UserId | 4 |
| DOM-identity-005 | Email | 4 |
| DOM-identity-006 | PlainPassword | 4（8〜128文字の検証）+ 24（漏出防止のテスト）。**要点のうち「ログ・イベント・永続化への漏出を防止する実装を持つ」は型で表現できないため実装しない** — ブランド付き `string` に `toString` / `toJSON` は載せられない。代替として (1) `identity.userRegistered` のペイロードに平文が現れないこと（`entity.test.ts`）、(2) `CurrentUserView` のキー集合に平文・ハッシュが無いこと（TC-getCurrentUser-003 と同じ表明）をテストで縛り、ログへの漏出はレビュー観点で担保する（→ 設計節 / ADR-011） |
| DOM-identity-007 | PasswordHash | 4 |
| DOM-identity-010 | TrashRetentionDays | 4 |
| DOM-identity-011 | Actor | 4 |
| DOM-identity-013 | identity.userRegistered イベント | 5 |
| DOM-identity-018 | UserRepository.insert | 6（ポート宣言）+ 12（`EMAIL_ALREADY_REGISTERED` への翻訳）。**`SSO_IDENTITY_ALREADY_REGISTERED` 側は SSO 登録経路が本スライスに無く到達不能のため SSO スライスで完了**（→ スコープ節 / ADR-008） |
| DOM-identity-019 | UserRepository.save | 6 |
| DOM-identity-020 | UserRepository.findById | 6 |
| DOM-identity-021 | UserRepository.findByEmail | 6 |
| DOM-identity-029 | PasswordHasher.hash | 6 |
| DOM-identity-030 | PasswordHasher.verify | 6 |

### アダプター（10件）

| ID | 要素 | ステップ |
|---|---|---|
| ADP-users-001 | schema: users | 7 |
| ADP-outbox-001 | schema: outbox | 7, 13（7 = 既存 `outbox_events` を fog 初期マイグレーションへ引き継ぎ・再生成して検証。実テーブル名は `outbox_events` のまま維持する → スコープ節。13 = `users` へ移植した `outboxRepository.integration.test.ts` / relay 統合テストによる**実効的な検証** → 13, 24） |
| ADP-processed-events-001 | schema: processed_events | 7, 13（同上。13 = 移植した consumer / relay 統合テストが `processed_events` の冪等性経路を通る → 13, 24） |
| ADP-occ-guard-001 | schema: _occ_guard | 7, 13（同上。`d1/__tests__/setup.ts` の `afterEach` 空表明を維持し、移植した OCC 統合テストで検証 → 13, 23） |
| ADP-identity-001 | UserRepository.insert | 8（リポジトリ実装）+ 12（`EMAIL_ALREADY_REGISTERED` への翻訳はユースケース境界 → ADR-008）。**SSO 制約側は DOM-identity-018 と同じ理由で SSO スライス** |
| ADP-identity-002 | UserRepository.save | 8 |
| ADP-identity-003 | UserRepository.findById | 8 |
| ADP-identity-004 | UserRepository.findByEmail | 8 |
| ADP-identity-012 | PasswordHasher.hash | 10 |
| ADP-identity-013 | PasswordHasher.verify | 10 |

### ユースケース（4件）

| ID | 要素 | ステップ |
|---|---|---|
| UC-identity-001 | registerWithPassword | 12 |
| UC-identity-003 | loginWithPassword | 12 |
| UC-identity-004 | logout | 12（ユースケース）+ 15, 22（セッション破棄） |
| UC-identity-013 | getCurrentUser | 12（ユースケース）+ 22（呼び出し地点） |

### フロントエンド（8件）

| ID | 要素 | ステップ |
|---|---|---|
| PAGE-login-001 | ログインページ | 14（ルート骨組み）, 16, 17, 18 |
| PAGE-login-002 | メール＋パスワードログイン送信 | 18（+ 15 のリダイレクト復帰） |
| PAGE-login-004 | アカウント登録への導線 | 18, 19 |
| PAGE-login-005 | パスワードリセットへの導線 | 18, 20 |
| PAGE-signup-001 | アカウント登録ページ | 14（ルート骨組み）, 16, 17, 19 |
| PAGE-signup-002 | メール＋パスワード登録送信 | 19（送信中表示・二重送信防止を含む。manual TC-15 → 25） |
| PAGE-signup-004 | ログインへの導線 | 19, 18 |
| PAGE-common-001 | グローバルナビゲーション | 14（ルート骨組み）, 16, 21 |

### テストケース（39件）— すべてステップ24で実装

| ID | 内容 | テスト種別・実装先 |
|---|---|---|
| TC-registerWithPassword-001 | 登録の正常系（version:0・イベント同一TX） | 統合（application/identity） |
| TC-registerWithPassword-002 | メール正規化 | 単体（Email VO）+ 統合 |
| TC-registerWithPassword-003 | メール形式不正 | 単体（Email VO）+ 統合 |
| TC-registerWithPassword-004 | メール321文字 | 単体（property: 境界） |
| TC-registerWithPassword-005 | メール320文字境界 | 単体（property: 境界） |
| TC-registerWithPassword-006 | パスワード7文字 | 単体（PlainPassword VO） |
| TC-registerWithPassword-007 | パスワード8文字境界 | 単体（property: 境界） |
| TC-registerWithPassword-008 | パスワード128文字境界 | 単体（property: 境界） |
| TC-registerWithPassword-009 | パスワード129文字 | 単体（property: 境界） |
| TC-registerWithPassword-010 | パスワード空文字 | 単体 |
| TC-registerWithPassword-011 | 同一メールの重複登録 | 統合（事前検証経路） |
| TC-registerWithPassword-012 | SsoUser とのメール重複 | 統合（SsoUser をリポジトリ直挿入で用意） |
| TC-registerWithPassword-013 | 正規化後一致の重複検出 | 統合 |
| TC-registerWithPassword-014 | 同時登録レース | 統合（`Promise.all` で同時実行 → UNIQUE 違反経路） |
| TC-registerWithPassword-015 | hash 失敗 | 統合（`passwordHasher` を throw するスタブに差し替えたコンテナ） |
| TC-registerWithPassword-016 | insert DB 例外 | 統合（**非制約系の DB 障害を注入する**。テーブルを drop / rename する、DB ハンドルを閉じる等。制約違反（UNIQUE / PK / CHECK / NOT NULL）では `mapDbError` が `ConflictError` にしてしまい `SystemError` に到達しない — さらに UNIQUE / PK は `constraintViolationCode` が同じ `UNIQUE_VIOLATION` に潰すので ADR-008 の読み替えを通って `EMAIL_ALREADY_REGISTERED` に化ける）＋ロールバック確認・outbox 空 |
| TC-loginWithPassword-001 | ログイン正常系 | 統合 |
| TC-loginWithPassword-002 | メール正規化後の一致 | 統合 |
| TC-loginWithPassword-003 | 未登録メール | 統合 |
| TC-loginWithPassword-004 | パスワード不一致 | 統合 |
| TC-loginWithPassword-005 | SSO ユーザーへの試行 | 統合 |
| TC-loginWithPassword-006 | メール形式不正の変換 | 統合（BusinessRuleError にならないこと） |
| TC-loginWithPassword-007 | 短いパスワードの変換 | 統合 |
| TC-loginWithPassword-008 | 失敗応答の同一性 | 統合（003〜007 の `kind` / `code` / `message` が完全一致することを表明） |
| TC-loginWithPassword-009 | 8文字パスワードでの照合 | 統合 |
| TC-loginWithPassword-010 | findByEmail DB 例外 | 統合（DB を閉じる／不正状態にして SystemError） |
| TC-loginWithPassword-011 | verify 計算失敗 | 統合（throw するスタブ hasher） |
| TC-logout-001 | ログアウト正常系 | 単体（ドメイン操作・永続化が発生しないこと） |
| TC-logout-002 | セッション破棄は presentation 責務 | 単体（`presentation/sessionCookie.ts` の `buildSessionCookie(null)` が `Max-Age=0` の失効 Cookie を返す。**`server-only` を import しない純関数モジュール**なので node プールで確実に読める）+ 手動（manual-tests TC-06） |
| TC-logout-003 | セッション破棄失敗 | 単体（`endSession` に throw する `setCookieHeader` スタブを渡し、`SystemError` に翻訳されること = `serializeError` で `kind: "system"` になること）+ 手動 |
| TC-getCurrentUser-001 | PasswordUser の取得 | 統合 |
| TC-getCurrentUser-002 | SsoUser の取得 | 統合（SsoUser を直挿入） |
| TC-getCurrentUser-003 | 資格情報の非露出 | 統合（View のキー集合を表明） |
| TC-getCurrentUser-004 | SSO 主体情報の非露出 | 統合（同上） |
| TC-getCurrentUser-005 | 保持日数の既定値（30） | 統合 |
| TC-getCurrentUser-006 | 保持日数変更の反映 | 統合（`User.changeTrashRetentionDays` → `save` → 取得） |
| TC-getCurrentUser-007 | セッション有効・ユーザー不在 | 統合（NotFoundError） |
| TC-getCurrentUser-008 | userId 空文字 | 単体（UserId VO） |
| TC-getCurrentUser-009 | findById DB 例外 | 統合 |

**カバレッジ:** 75/75。未カバーなし。ただし次の5点を明示しておく。

- **TC-logout-002 / 003** は自動テストで直接検証できるのが「Cookie 組み立ての純関数」と「`setCookieHeader` スタブ（または純関数 `toSessionSystemError`）による失敗注入」までで、実際の破棄動作は手動テスト（spec/manual-tests/account.md TC-06 / TC-23）で補完する
- **DOM-identity-018 / ADP-identity-001** は要点のうち **email 制約側のみ**の実装。`SSO_IDENTITY_ALREADY_REGISTERED` の翻訳は SSO 登録経路（UC-identity-002）が本スライスに存在せず**発火させるテストが書けない**ため SSO スライスで完了させる（→ スコープ節 / ADR-008）
- **DOM-identity-006（PlainPassword）** は要点のうち「8〜128文字の検証」を実装するが、**「ログ・イベント・永続化への漏出を防止する実装を持つ」は実装しない**。ブランド付き `string`（spec 自身が指定する形）に `toString` / `toJSON` のオーバーライドを載せられないため。代替として (1) `identity.userRegistered` のペイロードに平文が現れないこと（`entity.test.ts`）、(2) `CurrentUserView` のキー集合に平文・`passwordHash` が無いこと（TC-getCurrentUser-003 と同じ表明）の2つをテストで縛り、ログへの漏出は PR レビュー観点で担保する。spec の字面との差は **spec-sync 対象**（→ 設計節 / ADR-011）
- **TC-logout-003 の「層」は spec と実装で字面が異なる**。`spec/inventory/test.md` / `spec/testcases/identity/logout.md#L11` は「**アダプター層で** `SystemError` として扱われれば PASS」と書くが、本実装の翻訳地点は presentation（`apps/web/app/presentation/{sessionCookie,session}.ts` の `toSessionSystemError`）である。セッションを扱うアダプターが存在せず、同じ spec が TC-logout-002 で「セッション破棄は presentation 責務」と書いている以上、presentation 側に寄せて解決するのが唯一整合する読み方。**spec 側の内部不整合なので spec-sync 対象**として記録する（→ ADR-010 / round-3 coverage S-001）
- **AC-9（保護 URL リダイレクトとログイン後の復帰）に対応するインベントリ ID は存在しない**（`spec/pages/index.md` 共通レイアウトの要件だが `spec/inventory/frontend.md` に未採番）。そのため Issue のチェックリスト75行には現れないが、S-AC-03 / manual TC-22 が要求するので受け入れ基準へ独自に引き上げている。同様に「通信エラーは共通のエラー表示（リトライ導線付き）で扱う」も ID 未採番で、本スライスでは扱わない。**インベントリへの ID 追加は spec-sync / 別 Issue の対象**

### 付随実装（本 Issue のチェックリスト外・後続 Issue で再実装しない）

チェックリストに無いが、上記 ID の要求から必然的に実装されるもの。後続スライスの Issue で「未実装」と誤認して作り直さないための記録。

| ID | 要素 | 実装される理由 | ステップ |
|---|---|---|---|
| DOM-identity-004 | AiClientConnectionId | `Actor`（DOM-identity-011）の `AiClientActor` の構成要素 | 4 |
| DOM-identity-008 | SsoProvider | `SsoUser` の再水和（TC-getCurrentUser-002 / 004）と `users` の値域 CHECK に必要 | 4 |
| DOM-identity-009 | ClientName | DOM-identity-004 と同じく `AiClientActor` の構成要素 | 4 |
| DOM-identity-014 | identity.passwordChanged イベント | `User.changePassword`（DOM-identity-001 の要件）が発行する | 5 |
| DOM-identity-015 | identity.trashRetentionChanged イベント | `User.changeTrashRetentionDays`（同上）が発行する。TC-getCurrentUser-006 でも使う | 5 |

## 設計判断

詳細は `.issue/1/adr.md` を参照。

- **ADR-001** サンプル todo ドメインの削除と初期マイグレーションのリセット
- **ADR-002** セッション管理方式 — HMAC 署名付きステートレス Cookie
- **ADR-003** パスワードハッシュ方式 — WebCrypto PBKDF2-HMAC-SHA256（アルゴリズム識別子付きエンコード・反復回数はファクトリ引数）
- **ADR-004** ランタイム選定 — Node + libSQL を主ターゲットとし4ランタイム構成は維持する
- **ADR-005** 認証ヘルパー（`getCurrentUserId` / `requireUserId`）の配置とガードの権威の所在
- **ADR-006** アプリケーション層への `ValidationError` 追加と `SerializedValidationError` の所在
- **ADR-007** 未実装スライスへの導線をプレースホルダールートで用意する
- **ADR-008** `EMAIL_ALREADY_REGISTERED` の翻訳点をユースケース境界に置く
- **ADR-009** 読み取り専用ユースケースも純読み取り UoW 経由でリポジトリを取得する
- **ADR-010** セッション操作の失敗に `SystemErrorCode.SessionError` を新設する（`DatabaseError` を流用しない）
- **ADR-011** `PlainPassword` の漏出防止を実装ではなくテスト＋レビュー観点で担保する

## リスクと注意点

- **todo 削除の波及が広い** — `AllDomainEvents` / `defaultEventDecoderRegistry` / `UnitOfWorkContext` / `TestContainer` / ルート / `__root.tsx` の副作用 import まで連鎖する。型エラーで大半は検出されるが、次の3つは実行時にしか出ない: `routeTree.gen.ts` の再生成漏れ、`__root.tsx` の副作用 import 漏れ、**`d1/__tests__/setup.ts` の `DELETE FROM todos`**（グローバル `setupFiles` なので D1 プールの全統合テストが道連れになる）
- **共通基盤の統合テスト（occGuard / unitOfWork / outboxRepository / helpers）を `users` へ移植し損ねると、OCC ガードと `mapDbError` の制約分類の検証が空洞化する** — 削除（ステップ3）と移植（ステップ13）を別ステップに割った以上、移植の完了を明示的にレビュー項目にする。とくに `d1/__tests__/helpers.integration.test.ts` は制約分類を検証する唯一のテストで、ADR-008 の前提そのもの
- **`EventDecoderRegistry` は `AllDomainEvents` に閉じている** — `AllDomainEvents` を空にすると `Partial<DefaultEventDecoderRegistry>` が `{}` になり、**デコーダを1件も型安全に登録できなくなる**。しかも `apps/web/app/worker/cloudflare/handlers.ts` の `runRelayTick` と `apps/web/app/worker/node/runner.ts` はレジストリ差し込み口を持たず常に `defaultEventDecoderRegistry` を使うため、空レジストリでは relay 系のテストが `No decoder registered for event type "…"` で落ちる。**これは型エラーではなくテスト実行時にしか出ない**。ステップ3で3ファイルを削除し、ステップ12で `AllDomainEvents` が `IdentityEvent` になってからステップ13で復活させる順序でしか閉じない（→ arch-risk P-002）
- **コンテナ型を広げるステップは構築地点をすべて同時に更新しないと typecheck が落ちる** — `packages/core/tsconfig.json` の `include` は `["src/**/*"]` なので `__tests__/` 配下も対象。`RequestContainer` の拡張（ステップ11）は DI ファクトリ4本・テストコンテナ2本・`di/__tests__/serverCloudflare.test.ts` の計7地点を同一ステップで更新する（→ arch-risk P-001）
- **`users` の独立 CHECK は目視でしか守れない** — `trash_retention_days >= 1` はどの直和 CHECK にも含まれない独立の不変条件で、生成 SQL から抜けても型検査・テストのどちらでも検出できない。ステップ7の目視リスト (a)〜(h) が唯一の関門
- **マイグレーション再生成でファイル名固定参照が壊れる** — `libsql/__tests__/helpers.ts` が `0000_initial.sql` をパスで直接読んでいる。ステップ7で journal 走査へ書き換えないと libsql 統合テストが全滅する
- **email 一意制約違反の翻訳点** — UoW 方式では違反が flush 時に出るため、リポジトリ内では捕まえられない。ユースケース側の読み替えを忘れると TC-registerWithPassword-014 が `UNIQUE_VIOLATION` のまま UI に出る。読み替えは「同一 UoW の一意制約が email だけ」という前提に依存するので、UoW に別の書き込みを足すときは前提を再確認する（→ ADR-008）
- **`libsql` の UoW は「同一 UoW 内の read-your-write 非対応」** — `registerWithPassword` の `findByEmail`（読み）→ `insert`（書き）は順序が正しく問題ないが、後続で「書いた直後に読む」を書くと静かに壊れる
- **transport スキーマにパスワードの長さ制約を書くとエラー種別が変わる** — 最低長8も上限128も `validation` に化けて `PasswordTooWeak`（business）にならず、TC-registerWithPassword-006 / 009 の期待および AC-12 の表示と乖離する。`auth/schema.ts` の上限は DoS 目的の明確に大きい値（1024）に留める
- **`SESSION_SECRET` は「`AppConfig` に入れない」だけでは漏れる** — 4本の DI ファクトリが `const { db, relayTrigger, ...appConfig } = config` の rest-spread で `container.config` を作っており、`satisfies` は変数に対しては余剰プロパティ検査をしない。`RequestServerConfig` に平置きした瞬間、型エラーなしで `loadAppContext` 経由の HTML ペイロードに載る。`secrets` にネストして構造的に塞ぐ（→ ステップ11。**分解の形は CF だけ `{ binding, relay, waitUntil }` で異なるので写経しない**）。`loadAppContext` のキー集合を表明する回帰テストで恒久化する（→ ステップ24）
- **`SESSION_SECRET` を env スキーマに必須で足すとワーカーが起動できなくなる** — `readAwsServerEnv()` / `readGcpServerEnv()` は `apps/web/app/worker/{aws,gcp}/handlers.ts` からも呼ばれるので、必須キーを増やすとセッションを扱わない relay / consumer / pruner / dlq が落ちる。さらに `infra/aws/lib/appStack.ts` の `sharedEnv` は `Record<string, string>` で、`infra/gcp/example/services/*` は Terraform 変数で env を列挙しているため、**列挙漏れは型検査でもテストでも出ずデプロイ時に初めて落ちる**。zod 側は optional にし、検証は `createXxxRequestContainer`（秘密鍵を使う唯一の地点）で行う（もともと Cloudflare の `ServerEnv` は型宣言のみで zod スキーマを持たず、この形しか採れない）。infra 側は**アプリ実行地点にだけ**配る（→ ステップ11 / round-3 arch-risk S-001）
- **PBKDF2 210,000 回は統合テストの実行環境そのものの問題** — `application/**/*.integration.test.ts` は Miniflare（workerd）プールで走る。workerd の WebCrypto が反復回数に上限を課すという報告があり、事実なら登録・ログイン系の統合テストが**一件も通らない**。上限に触れなくても20件超 × 複数回のハッシュ計算で CPU 時間が問題になる。ステップ10冒頭の実測とフェイクハッシャー注入で対処する（→ ADR-003）
- **`?redirect=` のオープンリダイレクト** — 相対パス限定のバリデーションを `validateSearch` と server fn の両方に置く
- **デザイントークン全面置換は「壊れないか確認する」では足りない** — `theme.css` の半段階 neutral（8個）が未定義参照になり、`Skeleton` の `bg-neutral-200` は新トークンではページ背景と同一値で**不可視**になる。どちらも型・ビルドエラーにならないので、ステップ16で明示的に手当てする
- **`4ランタイム × 2 DB アダプター`の同時更新漏れ** — DI 4本・UoW 2本・リポジトリ 2本・マイグレーション 2セット。`pnpm typecheck` は DI と UoW を検出するが、**マイグレーション2セットの再生成漏れと生成 SQL の内容は検出できない**（ステップ7の `git diff` 目視が唯一の関門）
- **フロントの自動テスト基盤が無い** — jsdom / RTL が無く、`apps/web` 配下に非 integration の単体テストは現時点でゼロ。PAGE-* の受け入れは手動テスト依存になる。ステップ2で疎通だけ先に確認し、`pnpm dev` での確認手順を PR 説明に残す
- **手動テスト TC-01 と意図的に乖離する** — TC-01 は SSO ボタンの表示を確認項目に含むが、本スライスは SSO 未実装のためボタンを描画しない。PR 説明と手動テスト結果に明記する（→ スコープ節 / ステップ25）

## テスト方針

`docs/test.md` の分類（unit = 純粋ロジック / integration = 実 DB / property = 境界と不変条件）に従う。なお `docs/test.md` の `TEST_DOMAIN=todo pnpm test:domain` 等のコマンド行は `package.json` に存在しない（stale）。実行は `pnpm test:unit` / `pnpm test:integration` のみ。

- **単体（`pnpm test:unit`, node pool）**
  - `domain/identity/__tests__/valueObject.test.ts` — 各 VO の正常・異常。Email の正規化、UserId 空文字（TC-getCurrentUser-008）
  - `domain/identity/__tests__/valueObject.property.test.ts` — Email 320/321、PlainPassword 7/8/128/129 の境界（TC-registerWithPassword-004〜009）を fast-check で
  - `domain/identity/__tests__/entity.test.ts` — 各ファクトリの `version` / タイムスタンプ / イベントドラフト、`changePassword` が `PasswordUser` のみを受けること（型レベル＋ランタイム）、`reconstruct` の不整合行が `RehydrationError` になること、**`identity.userRegistered` のペイロードに平文パスワードが含まれないこと**（キー集合の表明＋値の再帰走査で平文文字列を含まないことの表明。`PlainPassword` の漏出防止を型で守れない分の担保 → ADR-011）
  - `application/identity/__tests__/eventDecoders.test.ts` — 3イベントの往復とスキーマ不一致時の `SystemError(DataIntegrityError)`
  - `application/identity/__tests__/logout.test.ts` — TC-logout-001（永続化・イベントが発生しない）
  - `adapters/webcrypto/__tests__/pbkdf2PasswordHasher.test.ts` — hash → verify 往復、誤パスワードで `false`、エンコード形式、同一入力でも salt が異なること、**ファクトリ引数の `iterations` が保存形式に反映され、異なる反復回数で作ったハッシュも verify できること**
  - `adapters/webcrypto/__tests__/hmacSessionCodec.test.ts` — 発行 → 検証、改ざん・期限切れ・別秘密鍵で `null`
  - `apps/web/app/presentation/__tests__/sessionCookie.test.ts` — `buildSessionCookie(token)` / `buildSessionCookie(null)` の属性（HttpOnly / SameSite / Path / Max-Age=0）（TC-logout-002）と `toSessionSystemError(cause)` が `SystemError(SessionError)` を返し `cause` を保つこと。**`server-only` を import しない純関数モジュールを対象にする**
  - `apps/web/app/presentation/__tests__/session.test.ts` — throw する `setCookieHeader` スタブを渡したとき `endSession` が `SystemError(SystemErrorCode.SessionError)` を投げ、`serializeError` が `kind: "system"` を返すこと（TC-logout-003）。**ステップ2の疎通確認 (c) で `server-only` の import が node プールで通らないと判明した場合は、このファイルを置かず `sessionCookie.test.ts` 側で `toSessionSystemError(cause)`（`endSession` の翻訳部分を切り出した純関数）を対象にする** — `sessionCookie.ts` に「限定する」だけでは TC-logout-003 は検証できないので、受け皿となる純関数をステップ15で必ず作る（→ coverage P-002）
  - `application/di/__tests__/*.test.ts` — 4本の request コンテナが返す `config` のキー集合に `sessionSecret` / `secrets` が含まれないこと（AC 表外の恒久ガード）
- **統合（`pnpm test:integration`）**
  - D1 プール（`packages/core/src/application/identity/__tests__/identity.integration.test.ts`）— 4ユースケースの代表経路と TC 表の統合系すべて。`setupTestContainer()` を拡張して `passwordHasher` / `sessionCodec` を注入する。**既定はフェイクハッシャー**（workerd の CPU 予算対策）で、実ハッシャーが必要なケース（TC-loginWithPassword-009）だけ低い反復回数の実装を渡す。失敗系はスタブ差し替えで再現する
  - D1 / libsql 双方の `userRepository.integration.test.ts` — 再水和（password / sso）、`findByEmail` の正規化一致、OCC 成功 / 失敗、email 一意制約違反、不整合行の `SystemError(DataIntegrityError)`
  - 移植する共通基盤テスト（ステップ13）— `unitOfWork` / `occGuard` / `outboxRepository` / `helpers`（対象を `todos` から `users` へ）。ADP-occ-guard-001 / ADP-outbox-001 の実効的な検証と、ADR-008 が依存する `mapDbError` の制約分類の検証
  - 移植する relay / consumer テスト（ステップ13）— `application/workers/__tests__/eventRelayWorker.integration.test.ts` と `apps/web/app/worker/{cloudflare,node}/__tests__/*.integration.test.ts`。seed イベントを `identity.userRegistered` に差し替える。`AllDomainEvents` が identity で埋まった後でないとデコーダを登録できないので、ステップ12より前には書けない
  - TC-registerWithPassword-016（insert DB 例外）は**非制約系の障害**（テーブルの drop / rename、DB ハンドルのクローズ）で注入する。制約違反では `mapDbError` が `ConflictError` を投げ、UNIQUE / PK は ADR-008 の読み替えを通って `EMAIL_ALREADY_REGISTERED` になり `SystemError` に到達しない
  - 同時登録レース（TC-registerWithPassword-014）は `Promise.all` で2件同時実行し、片方が `ConflictError("EMAIL_ALREADY_REGISTERED")` になることを（D1 のバッチ abort と libsql のトランザクション失敗の**どちらの失敗形でも通る**ゆるさで）表明する
- **手動（`spec/manual-tests/account.md`）** — TC-01（未ログインで `/` → ログイン画面。**SSO ボタンの確認項目は対象外**）、TC-02（登録 → タイムライン、再読込で維持）、TC-05（ログイン）、TC-06（ログアウト）、TC-12〜14 / 16（入力エラー・重複・正規化）、TC-15（連打で二重登録されない）、TC-19 / 20（原因を明かさない）、TC-22（保護 URL 直アクセス後の復帰。`?redirect=/settings` が実際に動くこと）、TC-23（ログアウト後アクセス不可・戻るボタンでも復元されない）、**TC-34（パスワード 7/8 文字 = Issue「検証」節の「弱パスワードのエラー表示」の spec 上の手動 ID）**、**TC-35（パスワード 128/129 文字 = transport 上限 128 → 1024 変更の唯一の UI 検証手段）**、**TC-36（メール 320/321 文字）**。SSO / OAuth / パスワードリセット関連の TC（TC-37 と事後処理節を含む）は本スライス対象外として PR に明記する

## レビュー履歴

### 1周目

レビュー: `.issue/1/plan-review/round-1-coverage.md`（要件カバレッジ視点）／`.issue/1/plan-review/round-1-arch-risk.md`（アーキ・リスク視点）。指摘は**両視点の問題点11件すべてと改善提案18件すべて**を検討し、うち16件を取り込み、2件を限定対応とした。

**修正した点（問題点 P-*）**:

- **[coverage P-001]** AC-6 が「リポジトリが `EMAIL_ALREADY_REGISTERED` に翻訳する」と書いており設計本文・実装ステップと逆だった。AC-6 を「翻訳点はアダプターではなく `registerWithPassword` ユースケース境界」と実態に合わせて書き換え、判断を **ADR-008** として切り出した。あわせて `SSO_IDENTITY_ALREADY_REGISTERED` の翻訳が本スライスでは到達不能であることをスコープ節とチェックリスト対応表に明記した
- **[coverage P-002]** PAGE-signup-002 の「送信中表示」が AC にもステップにも無かった。AC-12 に「送信中はボタン無効＋進行表示となり、連打しても登録は1回だけ実行される」を追加し、ステップ19に `isPending` によるボタン無効化を明記。ステップ25の手動確認リストに manual TC-15 を追加した
- **[coverage P-003 / arch-risk S-007]** TC-logout-003 の検証手段が実装ステップに無く、しかも `serializeError` が `isSerializableError` でない throw を `kind: "unknown"` にフォールバックするため素の例外では `SystemError` にならないことを確認した。ステップ15で `endSession` / `startSession` にヘッダー書き込みの差し替え可能な引数（`setCookieHeader`）を持たせ、未知の例外を `SystemError` に翻訳することを設計・ステップ・テスト方針の3箇所に落とした。S-007 が提案した「N/A としてカバレッジを 74/75 + 1 に改める」案は**採らない**（失敗注入で自動検証できるため、75/75 を落とす必要がない）
- **[coverage P-004 / arch-risk S-004]** `errorDisplay.ts` の `business` / `validation` 分岐が code を見ず `error.message`（ドメインの英語メッセージ）を返す実装であることを確認した。「文言を追加する」では効かないので、`renderValidationMessage(code)` / `renderBusinessMessage(code)` を `renderConflictMessage` と同型で新設する設計に具体化し、4つの code（`INVALID_CREDENTIALS` / `EMAIL_ALREADY_REGISTERED` / `IDENTITY_PASSWORD_TOO_WEAK` / `IDENTITY_INVALID_EMAIL`）の日本語文言を確定した
- **[arch-risk P-001]** `SESSION_SECRET` の漏洩経路（4本の DI ファクトリの rest-spread ＋ 変数への `satisfies` で余剰プロパティ検査が効かないこと）を実コードで確認した。ステップ11（2周目の組み替え前はステップ13）で `RequestServerConfig` を `secrets: { sessionSecret }` にネストして構造的に塞ぎ、秘密鍵を `RequestContainer` に載せない（`createHmacSessionCodec` の構築でだけ使う）方針に変更。ステップ24に `loadAppContext` の `config` キー集合を表明する回帰テストを追加した
- **[arch-risk P-002]** todo 削除の波及ファイルに `d1/__tests__/setup.ts`（グローバル `setupFiles`。`DELETE FROM todos` で D1 プールの全統合テストを道連れにする）・`d1/__tests__/helpers.integration.test.ts`・d1/libsql の `outboxRepository.integration.test.ts`・`d1/__tests__/helpers.ts` を追加。さらにレビューに挙がっていなかった `application/workers/__tests__/eventRelayWorker.integration.test.ts` と `apps/web/app/worker/{cloudflare,node}/__tests__/*.integration.test.ts`（`TodoEvents` / `TodoId` / `TodoTitle` をフィクスチャに使っている）も実地確認して追加した
- **[arch-risk P-003]** `libsql/__tests__/helpers.ts` の `0000_initial.sql` 固定参照と、d1 側に `meta/` が存在しない（手書き運用）ことを確認。ステップ7を「journal 走査への書き換え」「`--name initial` の付与」「d1 に `meta/` が生成され drizzle 管理に移ること」「生成 SQL の `git diff` 目視を完了条件にすること」に具体化し、ADR-001 の Consequences に副作用として記録した。あわせて計画のスキーマ定義から漏れていた `sso_provider_subject` の非空 CHECK を追加した
- **[arch-risk P-004]** `vitest.config.integration.ts` の include / exclude を確認し、identity の統合テストが workerd プールで走ることを裏付けた。**ADR-003 を修正**して反復回数をファクトリ引数化（環境変数化はしない方針は維持）し、着手時の workerd 実測・フェイクハッシャー注入・実測が失敗した場合の代替案2つを Decision に追記した
- **[arch-risk P-005]** ユースケース側の `UNIQUE_VIOLATION` 一括読み替えでは制約を区別できない問題に対し、(1) 本スライスでは `PasswordUser` の insert が `users_sso_identity_uq` を原理的に発火させないため実害が無いこと、(2) 前提を JSDoc で固定すること、(3) 恒久解として `PendingBatch` の per-statement 制約違反ハンドラ（d1 の `conflictHandlers` FIFO / libsql の直前ハンドラの既存機構を流用）で翻訳をアダプターへ戻すこと、を設計節と ADR-008 に書いた。**推奨案 (a) の即時実装は採らない** — SSO の insert 経路が本スライスに無く、ハンドラの動作を検証するテストが書けないため
- **[arch-risk P-006]** `apps/web` の単体テスト基盤を実地確認した。ルート `vitest.config.ts` は `include` を持たないので `apps/web` 配下の `*.test.ts` は**設定変更なしで対象に入る**が、非 integration の単体テストは現時点でゼロであること、`@repo/core/*` のエイリアス解決は `apps/web/app/worker/**` の統合テストで既に効いていること、未検証なのは「node プールでの `@/*` 解決」と「`server-only` の import 可否」であることを「既存実装の状態」に事実として書き直した。そのうえでステップ2に疎通確認タスク（捨てテスト1件＋失敗時の分岐）を独立させ、`buildSessionCookie` を `server-only` を持たない `sessionCookie.ts` へ分離する設計を確定した
- **[arch-risk P-007]** 実装ステップを「削除 → 追加」の順に組み替え、各ステップ完了時点で `pnpm typecheck` が通るようにした。todo 削除は旧ステップ12から**ステップ3**へ前倒し（`UnitOfWorkContext` のスロット削除と UoW 実装2本の更新を同一ステップに含める）。ただしレビューの提案どおりに全部を前倒しすると D1 のグローバル `setupFiles` が壊れるため、**スキーマ定義とマイグレーションと `setup.ts` の3点セットはステップ7で一括差し替え**とし、共通基盤テストの `users` への移植は（スキーマとリポジトリが要るので）別ステップ（2周目の組み替え後はステップ13）に分離した。全23ステップ → **全24ステップ**

**取り込んだ改善提案**:

- **[coverage S-001 / arch-risk S-009 / S-010]** スコープ節に「対象シナリオ ID の読み替え」を新設（Issue 本文の S-AC-02 は実体では SSO。本スライスは S-AC-01 / S-AC-03 / S-AC-04）。AC-9 の由来を「spec/pages/index.md 共通レイアウト（**インベントリ ID 未採番**）」に訂正し、ID 未採番であること・「通信エラーの共通表示」も同様であることをカバレッジ節に注記した
- **[coverage S-002 / arch-risk P-006]** `buildSessionCookie` を `presentation/sessionCookie.ts`（フレームワーク import 無し）に分離し、`session.ts` から使う構成にした
- **[coverage S-003 / arch-risk P-004]** PBKDF2 反復回数のファクトリ引数化（上記 P-004 参照）
- **[coverage S-004]** チェックリスト外の付随実装（DOM-identity-004 / 008 / 009 / 014 / 015）を対応表に「付随実装（後続 Issue で再実装しない）」の表として明記した
- **[coverage S-005]** `auth/schema.ts` の password 上限をドメインと同値の 128 から **1024**（DoS 目的の明確に大きい値）へ変更。長さ判定を `PlainPassword` 一箇所に寄せる理屈を上限側にも適用した。email も同様に 1024 とした
- **[coverage S-006]** 読み取り専用ユースケースを純読み取り UoW 経由にする判断を **ADR-009** として記録し、spec の字面との差を spec-sync 対象と明示した
- **[arch-risk S-001]** `RequestContainer` の JSDoc に、`passwordHasher` が「ドメインポートは UoW 経由でのみ触れる」という既存不変条件の意図的な例外である理由を書くことをステップ11（2周目の組み替え前はステップ10）に追加
- **[arch-risk S-002]** `sessionCodec.ts` の library-level JSDoc に「presentation 層専用。ユースケースから参照してはならない」を書くことをステップ9に追加し、ADR-002 の Decision にも1行足した
- **[arch-risk S-005]** デザイントークン差し替えの手当てを具体化。`theme.css` を lockstep で全面書き直し（半段階 neutral 8個の削除・spec 追加トークンの露出）、`Skeleton` の背景を `--color-neutral-300` 相当へ変更、新規フォームで `text-red-500` を使わないことをステップ16 / ステップ17に落とし、AC-18 を新設した
- **[arch-risk S-006]** `routeTree.gen.ts` の再生成をステップ3（削除直後）とステップ23（ルート追加後）の完了条件に明記し、ステップ25の品質ゲートを「routeTree 再生成 → typecheck → …」の順に書き直した
- **[arch-risk S-008]** 認証ガードの二重経路を整理。「`beforeLoad` は先回りリダイレクトでセキュリティ境界ではない／権威は各サーバー実行地点の `requireUserId()`」を設計節と ADR-005 の両方に同じ表現で書き、TC-23 対策（`_app.tsx` の `staleTime: 0` ＋ ログアウト時の `router.invalidate()` → `navigate({ replace: true })`）をステップ21 / ステップ22に落とした
- **[arch-risk S-012]** AC-14 の「下部シート相当」を spec の表現に合わせて「**下部タブ相当**」に訂正。承認済みデザイン `spec/design/pages/timeline.html` の実装形がヘッダーメニュー → `.nav-sheet` であることを確認済みなので、実装はデザイン成果物に従い、表現差は spec-sync 対象とステップ21に注記した
- **[arch-risk ADR-006 所見]** `apps/web/app/presentation/validator.ts` が `SerializedValidationError` を `./errorResponse` から import している事実を確認し、ステップ1に「`errorResponse.ts` に再エクスポートを残す（`validator.ts` は無変更）」を追加した
- **[arch-risk ADR-004 所見]** Cloudflare の `ServerEnv` に zod スキーマが無い（型宣言のみ）ことを確認し、CF だけ `SESSION_SECRET` の欠落が検出されないためコンテナ生成時に明示検証することをステップ11（2周目の組み替え前はステップ13）に追加した
- **[arch-risk ADR-007 所見]** 「リンク先が実在し状態を正直に伝えるプレースホルダー」と「押しても何も起きないボタン」を分ける判断基準を ADR-007 に追記し、SSO ボタン非描画との整合を明示した
- **[arch-risk 実測メモ]** `d1/repositories/todoRepository.ts` のコメント（「PK 衝突は `SystemError` になる」）が実装と食い違う点を、写経元にする際の注意としてステップ8に明記した

**限定した提案とその理由**:

- **[arch-risk S-011]（テンプレート残滓の扱い）** — 「1箇所にまとめて明記する」提案は取り込み、スコープ節に「含まれないもの」として集約した。ただし**実際のリネームは行わない**: (a) outbox の実名 `outbox_events` は spec/database 自身が「テンプレート流儀に従う」と書いているので実装名を正とし spec 側の表記揺れとして維持する、(b) wrangler の D1 データベース名 `tanstack-start-template-d1*` と vitest のキュー名の変更は `db:migrate:cf` / `db:apply:*` / デプロイスクリプトに波及し、本スライス（認証の縦切り）と直交するため別 Issue に切り出す
- **[arch-risk S-003]（manual TC-01 の SSO ボタン）** — 計画の判断（SSO ボタンを描画しない）を**維持する**。`PAGE-login-003` がチェックリスト外である以上、動かないボタンを置く方がデザイン方針に反する。代わりに「spec/manual-tests/account.md TC-01 の期待と意図的に乖離する。本スライスでは SSO 未実装のため」をスコープ節・リスク節・ステップ25に記録し、PR 説明と手動テスト結果にも明記することにした

**見送った提案とその理由**:

- **[arch-risk P-005 の推奨案 (a)]** — `PendingBatch` に制約違反ハンドラを足して翻訳をアダプターへ戻す案は、**本 Issue では実装しない**（SSO の insert 経路が無く動作を検証するテストが書けない。email 側だけのために共通基盤の API を広げると、検証されないコードが残る）。設計・移行経路は ADR-008 に記録済みで、SSO スライスで実施する
- **[arch-risk S-007 の第1案]** — 「TC-logout-003 を N/A としてカバレッジを 74/75 + 1件 N/A に改める」案は見送り、第2案（失敗注入で `SystemError` への翻訳を自動検証する）を採った。理由は上記 coverage P-003 のとおり

**カバレッジの確認**: Issue 本文のチェックリスト75 ID は対応表にすべて残っており（ドメイン14 / アダプター10 / ユースケース4 / フロントエンド8 / テストケース39 = 75）、ステップ番号のみ改訂後の24ステップに追随させた。**75/75 を維持**。

### 2周目

レビュー: `.issue/1/plan-review/round-2-coverage.md`（要件カバレッジ視点・P-001〜002 / S-001〜003）／`.issue/1/plan-review/round-2-arch-risk.md`（アーキ・リスク視点・P-001〜003 / S-001〜006）。**問題点5件・改善提案9件の計14件すべてを実コードで裏付けたうえで全件取り込んだ。見送りはゼロ。**

**修正した点（問題点 P-*）**:

- **[coverage P-001]** DOM-identity-006（PlainPassword）の要点のうち「ログ・イベント・永続化への漏出を防止する実装を持つ」を実装しない判断が、対応表とカバレッジ注記に反映されていなかった（同種の部分実装である DOM-identity-018 / ADP-identity-001 は両方に明記されているのに片方だけ不可視だった）。設計節の該当段落を「何を実装し、何をテストで縛るか」の表に書き直し、対応表の DOM-identity-006 セルとカバレッジ注記の4点目に同じ内容を落とし、判断を **ADR-011** として記録した（spec-sync 対象）。担保するテストは (1) `entity.test.ts` の `identity.userRegistered` ペイロード、(2) `CurrentUserView` のキー集合（TC-getCurrentUser-003 と同じ表明）の2つに固定した
- **[coverage P-002]** ステップ2の分岐 (c) が「TC-logout-002 / 003 の対象を `sessionCookie.ts` に限定すれば回避できる」と書いていたが、TC-logout-003 が要求する `SystemError` 翻訳は `session.ts`（`server-only` を import する側）の `endSession` にあるため、限定するだけでは自動検証できない。テスト方針（旧821行）の正しい代替（翻訳部分を純関数として切り出す）と食い違っていた。**`toSessionSystemError(cause)` を `sessionCookie.ts` に置く**ことを設計節・ステップ2の分岐 (c)・ステップ15・テスト方針の4箇所に同じ表現で書き、(c) の成否に関わらず切り出すことにして記述を統一した
- **[arch-risk P-001]** 旧ステップ10の `RequestContainer` 拡張と、その構築点（DI ファクトリ4本・テストコンテナ2本・`di/__tests__/serverCloudflare.test.ts`）の更新が旧ステップ12 / 13 に分断されており、旧ステップ10〜12で `pnpm typecheck` が落ちる（`packages/core/tsconfig.json` の `include` が `["src/**/*"]` で `__tests__/` も型検査対象であることを実コードで確認）。**ステップを分割して組み替えた**（全24ステップは維持）
  - 新ステップ10 = `SessionCodec` ポート定義のみ（コンテナ型に触らない → 単独で型検査が通る）
  - 新ステップ11 = `RequestContainer` 拡張 + DI ファクトリ4本 + env スキーマ + `secrets` ネスト + テストコンテナ2本 + `di/__tests__/serverCloudflare.test.ts` の `envWith` を**一括更新**（旧ステップ13の全内容を吸収）。`serverCloudflare.test.ts` は計画のどこにも挙がっていなかったので対象ファイルに明記した。`libsql/__tests__/helpers.ts` の `TestContainer` は `RequestContainer` を含まない独自形なのでこのステップでは不要であることも確認して書き分けた
  - 新ステップ12 = identity ユースケース（旧11）／新ステップ13 = 共通基盤・relay 統合テストの復活（旧12 + relay 系）
  - あわせて「順序の原則」に一般則 **「共有型を広げるステップは、その型を構築するすべての地点（テストヘルパー・テスト内リテラルを含む）の更新を同一ステップに含める」** を追加した
- **[arch-risk P-002]** ステップ3の relay / consumer 統合テストの「ドメイン非依存化」は成立しない。`EventDecoderRegistry = Partial<DefaultEventDecoderRegistry>` が `AllDomainEvents` に閉じているため空の期間はデコーダを1件も登録できず、さらに `apps/web/app/worker/cloudflare/handlers.ts` の `runRelayTick` と `apps/web/app/worker/node/runner.ts` はレジストリ差し込み口を持たない（`registry` 引数があるのは aws / gcp のみ）ことを実コードで確認した。**推奨案 (a) を採り、ステップ3では3ファイルを削除**（削除すれば `pnpm test:integration` の全緑という完了条件は成立する）、`AllDomainEvents` が `IdentityEvent` になる**ステップ12の後、ステップ13で `identity.userRegistered` を seed イベントとして復活させる**手順に書き直した。「型エラーではなくテスト実行時にしか出ない失敗」であることをリスク節と順序の原則に残し、ADR-001 の Consequences にも復活ステップを追記した
- **[arch-risk P-003]** ステップ7のスキーマ／目視確認リストに `trash_retention_days >= 1` の CHECK・`auth_method` 値域の CHECK・`users_email_uq` が無かった。設計節のスキーマ箇条書きに `users_trash_retention_positive` / `users_auth_method_valid` を制約名付きで追加し、ステップ7の変更内容を「名前付き制約6本 + インデックス2本」と数え上げ、目視確認リストを (a)〜(h) の8項目に拡張した。`trash_retention_days >= 1` はどの直和 CHECK にも含まれない独立の不変条件なので、抜けると DOM-identity-010 が DB 側でノーガードになる旨をリスク節にも追加した

**取り込んだ改善提案**:

- **[coverage S-001]** ステップ25の手動確認リストに **manual TC-34 / 35 / 36** を追加した。TC-34 は Issue「検証」節の「弱パスワードのエラー表示」の spec 上の手動 ID（既存リストの TC-12 / 13 は弱パスワードを扱わない）、TC-35 は `auth/schema.ts` の上限を 128 → 1024 に変えた判断の唯一の UI 検証手段、TC-36 は email 上限側の同種。テスト方針の手動節にも同じ3件と理由を書き、`spec/manual-tests/account.md` の TC-37・事後処理節が実行不能（本スライス外）であることも明記した
- **[coverage S-002]** TC-registerWithPassword-016 の失敗注入方法を「**非制約系の DB 障害**（テーブルの drop / rename、DB ハンドルのクローズ）」と明記した。`adapters/d1/repositories/helpers.ts` を確認し、`mapDbError` が `SQLITE_CONSTRAINT*` をすべて `ConflictError` にすること、`constraintViolationCode` が UNIQUE と **PRIMARYKEY を同じ `UNIQUE_VIOLATION` に潰す**ことを裏付けたうえで、制約違反では ADR-008 の読み替えを通って `EMAIL_ALREADY_REGISTERED` に化け `SystemError` に到達しないことをテスト表とテスト方針の2箇所に書いた。ADR-008 の前提にも `users.id` の PK 衝突が `UNIQUE_VIOLATION` に潰れる（UUIDv7 なので実質起こらない）ことを1行足した
- **[coverage S-003]** 受け入れ基準表の「対応ステップ」列に手動検証のステップ25を追加した（AC-12 = 「19, 25」、AC-15 = 「15, 22, 25」。数字は3周目の再採番後）。AC-12 の由来欄には S-001 で追加した manual TC-13 / 14 / 34 / 35 / 36 も並べた
- **[arch-risk S-001]** ステップ13（現ステップ11）の rest-spread の書き方が Cloudflare に当てはまらない点を修正した。実コードで **Node / AWS / GCP は `{ db, relayTrigger }`、Cloudflare だけ `{ binding, relay, waitUntil }`** であることを確認し、設計節とステップ11の両方にランタイム別の正しい分解を書いた（CF は `relay` / `waitUntil` を `ServiceBindingRelayTrigger` の構築に使うので `_` を付けない）。リスク節にも「写経しない」と1行足した
- **[arch-risk S-002]** セッション破棄失敗に `SystemErrorCode.DatabaseError` を流用するのをやめ、**`SessionError: "SESSION_ERROR"` を新設**する判断に変えた（**ADR-010**）。`packages/core/src/application/errors/index.ts` の `SystemErrorCode` の JSDoc が「外部リソースごとに1エントリ足せ」「`DatabaseError` は storage layer が throw した意」「コードを分けるのはログ／アラートのルーティングのため」と明記していることを確認したうえでの判断。`RETRYABLE_SYSTEM_CODES` には入れない。ステップ15の対象ファイルに `errors/index.ts` を追加した
- **[arch-risk S-003]** ステップ18の「認証済みなら `/` へリダイレクト」を **`search.redirect ?? "/"`** に変更した（`validateSearch` で検証済みの値を使う）。設計節のルート構成の箇条書きにも同じ表現を入れ、`signup.tsx` は `?redirect=` を受けないので `/` 固定であることを書き分けた
- **[arch-risk S-004]** `vitest.config.integration.ts` が `const migrations = await readD1Migrations(...)` を**config のトップレベルで await している**ことを確認し、「`meta/` の有無に影響されない」という断定を検証に格下げした。ステップ7の完了条件に「`meta/` 生成後に `pnpm test:integration:cf` が（テスト内容の成否と無関係に）**起動する**ことを確認する」を追加した
- **[arch-risk S-005]** ルートの `db:generate:cf` が `pnpm --filter @repo/web db:generate:cf` への委譲であることを `package.json` で確認し、**`apps/web` の中で `pnpm db:generate:cf --name initial` / `pnpm db:generate:node --name initial` を直接実行する**手順に書き換えた（設計節のマイグレーション要点とステップ7の両方）
- **[arch-risk S-006]** ステップ16の完了条件「`Skeleton` が視認できる」の確認手段を具体化した。ステップ3で `TodoListSkeleton` が消えるため `Skeleton` を描画するのは `RoutePendingFallback`（`router.tsx` の `defaultPendingComponent`）だけになり、`defaultPendingMs: 200` を超えてブロックするローダーがある画面でしか出ないことを実コードで確認。実在する手段として (a) `RoutePendingFallback` を `__root.tsx` に一時的に直接描画して目視、(b) DevTools で `--color-neutral-300` と `--color-bg-page` の解決値が異なることを確認、の2択に書き換え、`theme.css` の半段階 neutral 残存 grep も完了条件に足した

**見送った提案とその理由**: なし（14件すべて取り込んだ）。

**ステップ番号の追随**: 旧ステップ10 → 新10 / 11 の分割と、旧11 → 12・旧12 → 13・旧13 → 11 の組み替えに伴い、受け入れ基準表（AC-3 / 6 / 8 / 12 / 15）・チェックリスト対応表（DOM-identity-018 / ADP-occ-guard-001 / ADP-identity-001 / UC-identity-001 / 003 / 004 / 013）・スコープ節・設計節・リスク節・テスト方針・1周目レビュー履歴・`adr.md`（ADR-001 の Consequences）の**すべての「ステップNN」参照を追随させた**。1周目の履歴に残る旧番号は「2周目の組み替え前は…」と併記して指す先が曖昧にならないようにした。**全24ステップ**（変わらず）。

**カバレッジの確認**: Issue 本文のチェックリスト75 ID は対応表にすべて残っている（ドメイン14 / アダプター10 / ユースケース4 / フロントエンド8 / テストケース39 = 75）。**75/75 を維持**。DOM-identity-006 は「8〜128文字の検証は実装、漏出防止はテスト＋レビュー観点で代替」という部分実装であることを対応表セルとカバレッジ注記に明示したうえでカバー済みとして数えている（DOM-identity-018 / ADP-identity-001 と同じ扱い）。

### 3周目（最終）

レビュー: `.issue/1/plan-review/round-3-coverage.md`（要件カバレッジ視点・P-001 / S-001〜002）／`.issue/1/plan-review/round-3-arch-risk.md`（アーキ・リスク視点・P-001〜002 / S-001〜003）。**問題点3件・改善提案5件の計8件すべてを実コードで裏付けたうえで全件取り込んだ。見送りはゼロ。** 3周のレビューループはこれで完了とし、実装フェーズへ移行する。

**修正した点（問題点 P-*）**:

- **[coverage P-001]** 型付きリンクの前方参照で、ステップ14 / 17 / 18 / 20（旧番号）の完了時点に `pnpm typecheck` が落ちる問題。`apps/web/app/router.tsx` の `declare module "@tanstack/react-router" { interface Register … }` と、現行 `apps/web/app/routeTree.gen.ts` の `to: '/' | '/todo/about' | '/todo'` を実コードで確認し、`to` が生成 union に対して静的検査されること・`'/'` が `routes/index.tsx` 由来（ステップ3で消える）であることを裏付けた。推奨案 (a) を採り、**新しいステップ14「ルートファイルの骨組みと `routeTree.gen.ts` の先行生成」を挿入**した（`login` / `signup` / `password-reset` / `_app` / `_app/{index,topics,search,trash,settings}` の9本を空コンポーネントで一括作成 → `pnpm dev` で routeTree を再生成）。挿入位置はレビューの提案（旧16と旧17の間）より**前倒しして旧ステップ14（セッション Cookie と認証ガード）の直前**にした — `requireUserId()` が `redirect({ to: "/login" })` を投げる旧ステップ14自身が前方参照の1つであり、旧16と旧17の間に置いたのでは解消しないため。あわせて「順序の原則」に一般則3（**型付きリンクで相互参照するルート群はファイル作成と routeTree 再生成を先に一括で済ませる**／`routeTree.gen.ts` の生成は Vite プラグイン経由で `pnpm typecheck` 単体では走らない）を追加し、旧ステップ19（`/password-reset`）・旧ステップ20（`_app/*`）・旧ステップ22（routeTree 再生成）を「骨組みは既にある前提で中身を書く」形に書き直した。ステップ23の完了条件は「再生成しても**差分が出ない**こと（出たら骨組みの一括生成から漏れている）」に変えた。**全24ステップ → 全25ステップ**
- **[arch-risk P-001]** ステップ9（`hmacSessionCodec.ts` の実装）がステップ10（`SessionCodec` ポート定義）より前に置かれていた逆順。`D1IdempotencyStore implements IdempotencyStore` / `D1OutboxRepository` の `import type { OutboxRepository }` / `InProcessRelayTrigger = RelayTrigger & {…}` を実コードで確認し、本リポジトリのアダプターが例外なくポート型を import する規約であること（＝ポートが無いと TS2307 で完了条件が落ちること）を裏付けたうえで、**ステップ9と10を入れ替えた**（新9 = `SessionCodec` ポート定義、新10 = WebCrypto アダプター）。`RequestContainer` 拡張（ステップ11）からポート定義を分離するという2周目の判断はそのまま保たれている。「順序の原則」に一般則4（**ポート定義はその実装より前のステップに置く**）を追加し、後続スライスの `MailSender` / `PasswordResetTokenPort` でも同じ構図が再来することを明記した
- **[arch-risk P-002]** 設計節の値オブジェクト表の `PlainPassword` セルが「`toString` / `toJSON` を無効化して漏出を防ぐ」という旧記述のまま、直下の段落・ADR-011・対応表・カバレッジ注記の「実装しない」と矛盾していた（2周目 coverage P-001 の修正が4箇所に落ちて表のセルだけ取り残されていた）。セルを「**漏出防止は実装せず、テスト＋レビュー観点で担保する**（→ 直下の段落 / ADR-011）。ブランド付き `string` なので `toString` / `toJSON` のオーバーライドは載せない」に書き換え、他のセルと同じく参照先を1つ付けた

**取り込んだ改善提案**:

- **[coverage S-001]** TC-logout-003 の「層」の字面差（spec: アダプター層 / 実装: presentation 層）を spec-sync 対象として記録した。カバレッジ注記に5点目として追加し、ADR-010 の Consequences にも同じ内容を書いた（ADR-009 / ADR-011 と記録の粒度が揃う）。判断そのもの（セッションを扱うアダプターが存在しない以上 presentation に置くしかなく、同じ spec の TC-logout-002 が「presentation 責務」と書いている）は変えない
- **[coverage S-002]** 対応表の ADP-outbox-001 / ADP-processed-events-001 のセルを「7」から「**7, 13**」に変えた。ステップ13の理由欄が「ADP-occ-guard-001 / ADP-outbox-001 の実効的な検証」と書いているのに ID → ステップの逆引きが片方向でしか閉じていなかったため。ADP-occ-guard-001 のセルも「7, 13」に揃えた
- **[arch-risk S-001]** `SESSION_SECRET` を4ランタイムの env スキーマに**必須**で足す方針を撤回し、提案 (b)（**Cloudflare で採る方針を4ランタイムに揃える**）に変更した。`apps/web/app/worker/{aws,gcp}/handlers.ts` が `readAwsServerEnv()` / `readGcpServerEnv()` を呼ぶこと、`infra/aws/lib/appStack.ts` の `sharedEnv` が `Record<string, string>` で5 Lambda 全部に配られること、`infra/gcp/example/services/main.tf` が `local.shared_env` を4サービスに配ることを実コードで確認した。zod 側は optional にとどめ、必須性（32文字以上）の検証は `createXxxRequestContainer`（秘密鍵を使う唯一の地点）で行う。あわせて**対象ファイルの漏れも補い**、`infra/aws/lib/appStack.ts`（`sharedEnv` ではなく `appFn` の `environment`）と `infra/gcp/example/services/{main.tf,variables.tf}`（`google_cloud_run_v2_service.app` の `merge(...)` 側）をステップ11の対象ファイルに追加した — 秘密はセッションを使う実行地点にだけ配る。設計節・ステップ11・リスク節・「既存実装の状態」の乖離表・ADR-004 の Consequences の5箇所を同じ内容に揃えた
- **[arch-risk S-002]** AC-5 を2周目 P-003 で追加した2本の CHECK に追随させた。「名前付き制約6本 + インデックス2本」と数え上げ、`users_auth_method_valid` と **`users_trash_retention_positive`（`trash_retention_days >= 1`。どの直和 CHECK にも含まれない独立の不変条件）** を明記した。設計節・ステップ7の目視リスト (a)〜(h)・リスク節と表現が揃う
- **[arch-risk S-003]** ADR-009 の Consequences に「`passwordHasher` は `RequestContainer` に載せる**意図的な例外**である（本 ADR が守るのはリポジトリの取得口の一元化であり、`passwordHasher` はリポジトリではない・非トランザクショナル・UoW 外での実行を spec/usecases/identity.md が要求している）」を1行足した。ADR-002 / ADR-009 / ステップ11 が ADR 単体読みでも閉じる

**見送った提案とその理由**: なし（8件すべて取り込んだ）。

**ステップ番号の追随**: 新ステップ14の挿入と旧9 / 10 の入れ替えに伴い、`9 → 10`・`10 → 9`・`14〜24 → 15〜25` の対応で plan.md / adr.md の**すべての「ステップNN」参照と、番号だけで書かれている表のセル**（受け入れ基準表の対応ステップ列 AC-3 / 7 / 9〜16 / 18、チェックリスト対応表の DOM-identity-006 / ADP-outbox-001 / ADP-processed-events-001 / ADP-occ-guard-001 / ADP-identity-012 / 013 / UC-identity-004 / 013 / PAGE-* 8件、テストケース節の見出し）を機械的に洗い出して追随させた。1周目・2周目のレビュー履歴に残る旧番号は「旧ステップNN」「（2周目の組み替え前はステップNN）」と併記して指す先が曖昧にならないようにしてある。**古い番号を指したままの参照はゼロ**（`ステップ[0-9]+` を全件列挙して確認）。**全25ステップ**。

**カバレッジの確認**: Issue 本文のチェックリスト75 ID は対応表にすべて残っている（ドメイン14 / アダプター10 / ユースケース4 / フロントエンド8 / テストケース39 = 75）。**75/75 を維持**。部分実装の3件（DOM-identity-006 / DOM-identity-018 / ADP-identity-001）は従来どおり対応表セル・カバレッジ注記・スコープ節・ADR の4箇所で限定を明示したうえでカバー済みとして数えている。

**未解決事項**: なし（3周を通じて指摘された問題点・改善提案は全件取り込み済み）。
