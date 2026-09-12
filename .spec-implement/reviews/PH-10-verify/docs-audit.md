# PH-10 Verify 補助: docs とアーキテクチャ監査の抜き取り

- 対象 HEAD: `de888b7`（ブランチ `feat/spec-implement`）
- 開始: 2026-09-11T14:13+09:00
- 方法: 読み取りのみ（grep / find / git / 個別 vitest）。コード・spec・docs は無変更

## 要約

- 完了: 2026-09-11T14:32+09:00
- **重大 2 / 軽微 9 / 情報 12**。重大の 2 件はどちらも docs の 1 文で、存在しないテスト・述語を名指しして保証を主張している（PH-10 以前の `3f7c501` から継承した文で、PH-10 の現状化で見落とされた）。監査（A-1〜A-5）には重大な違反なし
- 重大
  - B1-1 `docs/runtime_cloudflare.md:390`: タイムラインの seek / scan の `EXPLAIN QUERY PLAN` テストとして `stores/__tests__/memoRepository.integration.test.ts` を挙げるが、そのファイルは存在せず（git 履歴にも無い）、該当する計画テストも無い
  - B1-2 `docs/test.md:52`: 「`isDisplayableDocumentId` / `isDisplayableTopicId` の述語に unit test がある」とするが、どちらのシンボルもコードに無い（route は zod の params 検証 + feed 側の `KnowledgeNotFound`）
- 軽微
  - A1-1 packages/core 内の依存方向（domain → application/adapters 等）を固定するテストが無い（grep では違反 0）
  - A1-2 application の 2 procedure が `SqlStorage` で読み取り SQL を持つ（PH-10.md §5 の issue 候補。issue 0 件なので CLAUDE.md の「閉じるか追跡」は未履行）
  - A4-1 `errorResponseMiddleware.ts:109-118` は system / unknown のときエラーオブジェクト全体を logger に渡す（既存、PII は未観測）
  - B1-3 `docs/test.md:13` の命名例 `eventTypeRoster.test.ts` が存在しない
  - B2-1 §14 Known limits の 6 行は PH-10.md §5 の issue 候補で、issue 0 件の今は CLAUDE.md:14 / :68 の追跡の約束が未履行（Manager の起票待ち、§7 で判断済み）
  - B3-2 `.dev.vars.example` の帰属表のうち 7 変数の帰属行と「env 型の全キーが表にある」ことを固定するテストが無い（現状は過不足なく一致）
  - B4-2 `docs/runtime_cloudflare.md:624` 「failed it three times」→ 実際は `max_retries = 3` で 4 回失敗して DLQ（PH-10 実走ログも「after 4 failed attempts」）
  - B6-1 `docs/backend_implementation_example.md:99` のディレクトリ木で `scripts/` が `apps/web/app/` 直下に置かれている（実際は `apps/web/scripts/`）
  - B6-2 `docs/backend_implementation_example.md:384-407` の「shipped one」の `save` 抜粋が実コードと 2 箇所違う（`now` と inline の `ConflictError` / 実際は `user.updatedAt.getTime()` と `occConflict()`）
- 問題なし（抜き取りで一致を確認）: DOM 29 files と 29 行の対応、integration 32 files / 191 tests とファイル別件数の全行、secret の帰属表と env 型、README の必須 6 secret、operator entry 15 の名前・対象・引数・監査 id、`OPERATOR_TOKEN` の判定順（404 → 404 → 405 → 401 → 400、docs と実装が一致）、DLQ の 1 回再配送 → ack、AI スコープ 11 ツール・`AiToolContainer`・固定テスト、UoW の同期性（型で async を拒否することを scratchpad で実証）、`transactionSync` の呼び手が adapters だけ、ログの meta、catch の追加 0・error class の追加 0、frontend example の引用 7 箇所、backend example の主要シンボル

## 進捗ログ

- 14:13 開始。PH-10.md §2/§3/§5 を読んだ
- 14:15 A-1、14:16 A-2、14:17 A-3、14:18 A-4、14:19 A-5、14:22 B-1、14:23 B-2、14:25 B-3、14:26 B-4、14:28 B-5、14:30 B-6、14:32 完了（各節は確認直後に追記。見出しの時刻は追記時刻のおおよそ）

## A-1 依存方向（2026-09-11T14:15+09:00 頃）

見たもの: `apps/web/app/presentation/__tests__/adapterImports.test.ts`、`packages/core/src/adapters/cloudflare/__tests__/storageWriters.test.ts`、grep による独立列挙。

### adapterImports.test.ts の射程

- スキャン対象: `apps/web/app` 配下の `.ts` / `.tsx` 全部（`__tests__` ディレクトリだけ除外）。`components/`・`routes/`・`presentation/` を含む。除外は `server.cloudflare.ts` と `worker/cloudflare/` 配下全体
- 正規表現 `/from\s+["']@repo\/core\/adapters\//`: `import … from`・`import type … from`・`export … from`（再 export）を捕まえる。見逃すのは動的 `import("…")`、副作用 import（`import "@repo/core/adapters/…"`、`from` なし）、`require`、相対パスで `packages/core/src/adapters` を指す import、別パッケージを経由した再 export。docs/test.md:13 は「動的 `import()` と別パッケージ経由の再 export は射程外」と書いており、限界の記述はある（副作用 import・相対パスは未記載だが実例 0 なので情報扱い）
- 赤くなるか（ロジックから判断）: 除外外のファイルに `from "@repo/core/adapters/…"` があれば `offenders` に入り `toEqual([])` が落ちる。2 本目の it が `presentation/export/handler.ts` / `presentation/ai/oauth.ts` がスキャン対象に入っていることを確認しており、スキャンが空振りしていないことも固定している
- 独立 grep（`grep -rn "@repo/core/adapters" apps/web/app`、`__tests__` 除く）: 出現は `server.cloudflare.ts`（2）と `worker/cloudflare/{state,operatorHandlers,stateEnv.check,queueHandlers,diagnostics,ssoHandlers}.ts` だけ。許可リストの内側に収まる。`apps/web/app` 以外の `apps/web`（scripts 等）には 0。動的 import は `worker/cloudflare/__tests__/env.d.ts` の型位置 2 件だけ（テスト用の型宣言）

### packages/core 内の依存方向

- `domain/` → application / adapters: 0（相対パス含む）
- `application/` → adapters: `di/serverCloudflare.ts`・`di/secrets.ts` だけ（合成根）。PH-10.md §2 の判定と一致
- `lib/` → 各層: 0
- **軽微 A1-1**: packages/core の依存方向（domain → application/adapters、`application/`（`di/` 以外）→ adapters）を固定するテスト・lint は無い（scan テストは `apps/web/app` の 1 本だけ）。現状 grep で違反 0 なので実害なし。CLAUDE.md:41 "Dependencies point inward" は構成の説明で、docs/test.md も packages/core 側の scan を主張していないため「保証の記述に対するテスト欠落」とまでは言えない。issue 候補レベル

### storageWriters.test.ts の射程

- スキャン: `packages/core/src` と `apps/web/app` の `.ts/.tsx`（`.d.ts`・`*.test/spec.ts(x)`・`__tests__` を除外）。`packages/core/src/adapters/` 以外に一致があれば赤
- 検出: 正規表現は **大文字小文字を区別**（`i` フラグなし）、表名は `[a-z_]+`（数字・引用符付き識別子・`${…}` は不一致）。`INSERT [OR x] INTO t (|VALUES|SELECT`、`REPLACE INTO t`、`DELETE FROM t`、`UPDATE t SET`（`UPDATE OR IGNORE t SET` は不一致）。`sql.exec` かどうかは見ず、ファイル本文のテキスト全体が対象（コメント中の SQL も一致する = 保守側に倒れる）
- 現スキーマの表名（CREATE TABLE から抽出: `_meta account ai_client_connections credential_locators … search_fts source_links topics user_settings`）はすべて小文字 + `_` で数字を含まないので、表名の文字クラスで漏れる表は現時点で無い
- 見逃す経路: 小文字の SQL、テンプレートで表名を組み立てる文、DO の KV API（`storage.put/delete`）、drizzle 等の builder。docs/test.md:13 は「読み取りと断片から組み立てた文は射程外」と記述（小文字 SQL・KV API は未記載）
- 独立 grep（大文字小文字無視、`UPDATE OR …` や引用符付きも許す広い正規表現）で adapters 外の書き込み SQL: **0**。adapters 外の `.exec(` / `storage.put|delete` / `transactionSync` / `drizzle`: SQL としては `application/identity/abandonAccount.ts:46-70` と `application/identity/rotation/recordRemappedLocator.ts:36-41` の `SqlStorage` 読み取りだけ（他は正規表現の `.exec` と JSDoc 文中）
- **軽微 A1-2（既知・PH-10.md §5 の issue 候補）**: application 層の 2 procedure が Cloudflare の `SqlStorage` 型を引数に取り `SELECT caller_token FROM account` / `SELECT kind, phase FROM operations` を直接実行する（`abandonAccount.ts:39,46-70`、`recordRemappedLocator.ts:36-41`）。application が SQLite の列名とプラットフォーム型を知る。読み取りのみで書き込み口の全数には影響しない。ただし `gh issue list --state all` は 0 件で、CLAUDE.md の「gap は閉じるか issue で追跡」をまだ満たしていない（Manager の起票待ち）。storageWriters.test.ts:10-11 のコメントと docs/test.md:13 は「読み取りは射程外」とテストの限界として書いており、gap の記録にはなっていない
- 情報 A1-3: `worker/cloudflare/` はディレクトリごと合成根扱いのため、`ssoHandlers.ts`（`devStubSsoProvider` / `ssoStateCodec` を import）や `operatorHandlers.ts`（`keyring` / `rotation/mappingRows` を import）のようなハンドラも adapter を直接名指しできる。CLAUDE.md の Entry points は request Worker の `queue()` ハンドラを entry point 側に置いているので規約違反ではない

結論: 依存方向は PH-10.md §2 の判定どおり合格（重大 0）。

## A-2 UoW の同期性（2026-09-11T14:16+09:00 頃）

- シグネチャ: `packages/core/src/application/execution/unitOfWork.ts:49` `run<T>(fn: (ctx: TCtx) => T extends Promise<unknown> ? never : T): T`、`:71-73` `UnitOfWorkRunner`（`runUnitOfWork` の形）も同じ条件型。CLAUDE.md の記述と一致
- 型で本当に拒否するか: 同じ形のインターフェースを scratchpad（`scratchpad/uow/check.ts`、リポジトリ外）に写して `tsgo --strict` で確認。`p.run(async (c) => c.a)` と `p.run((c) => Promise.resolve(c.a))` はどちらも `TS2322: Type 'Promise<number>' is not assignable to type 'never'`、同期 callback は通る
- **情報 A2-1**: この拒否を固定する型テスト（`// @ts-expect-error` で `run(async …)` を書くもの）はリポジトリに無い（`grep -rn "ts-expect-error"` で該当 0）。シグネチャから条件型を外しても落ちるテストは無く、保証は「型がそこにある」ことだけで保たれている。CLAUDE.md の原則「a test or a type that fails when it breaks」は型で満たしていると読めるが、型そのものの退行は検出されない
- 呼び出し箇所: `(unitOfWork|uow|provider).run(` / `runUnitOfWork(` / `run((` の非テスト出現は adapters 13 ファイル + application 3 ファイル（`revokeAllAiClientConnections.ts`、`trash/emptyTrash.ts`、`trash/pruneExpiredTrashItems.ts`）。`run(async` / `runUnitOfWork(async` は 0。application 3 ファイルの `await` は callback の外（`await run((ctx) => …)` の形で、callback 自体は同期）
- `transactionSync(` の呼び手（非テスト）: 11 ファイル、すべて `packages/core/src/adapters/cloudflare/`（`transactionSync` の語を含むファイルは adapters で 17、domain / application の出現は JSDoc 文中だけ）。PH-10.md §2 の「17 ファイル」は語の出現数で、呼び手は 11。どちらでも adapters 限定の結論は同じ
- ctx 型の Promise: `UserDataUnitOfWorkContext` / `IdentityDirectoryUnitOfWorkContext` の全メンバの port 定義 14 ファイルに `Promise` の出現 0。`enqueueJob` / `enqueueEvent` / `recordOperation` / `updateOperation` / `setMigrationCursor` はすべて `void`
- 入れ子: `createProvider().run`（`adapters/cloudflare/unitOfWork.ts:88-110`）に入れ子を検出する実行時ガードは無い。ctx は provider を露出しないので、入れ子にするには callback が外側の provider を閉包で掴む必要がある。確認した callback（application 3 ファイル、`jobs/finalizeWithdrawal.ts` の 4 箇所）に入れ子は無い。全数の静的証明はしていない（情報）
- 情報 A2-2（spec との細部）: `jobs/finalizeWithdrawal.ts:174-178` の最終 tx は `finishWithdrawalProcedure(ctx, now)` の後に `sql.exec("DELETE FROM oauth_consumed_codes")` を同じ `run` の中で実行する。adapter 内・adapter-owned 表なので CLAUDE.md の書き口規則には反しない。ただし `spec/database/index.md:986` は `oauth_consumed_codes` の「書き手は認可コード交換の RPC だけ」と書いており、退会の全削除という 2 人目の書き手が spec に無い（spec 側の記述漏れ。docs の範囲外なので情報）

結論: 合格（重大 0）。

## A-3 AI スコープ（2026-09-11T14:17+09:00 頃）

- 許可リスト: `apps/web/app/presentation/ai/tools.ts:31-43` `AI_TOOL_NAMES` = `search, get, list_topics, recent_memos, post_memo, update_memo, create_topic, update_topic, create_document, edit_document, delete` の 11 個。`AI_TOOLS`（`:435`）は `Record<AiToolName, …>` なので名前の追加は型と表の両方を要する
- `AiToolContainer`（`packages/core/src/application/di/aiToolContainer.ts:11-13`）= `Needs<"memoGateway" | "knowledgeGateway" | "searchGateway">`。`trashGateway` / `exportGateway` / `identityGateway` を型で持たない。`toAiToolContainer`（`:15-23`）が 3 つだけを射影し、`presentation/ai/auth.ts:78` がそれを渡す
- 履歴系: `tools.ts` の import は memo 6 / knowledge 8 / search 1 の usecase（`rollbackDocument`・`list*Revisions`・trash 系・export 系は無い）。`latestRevision` の出現は DTO のフィールド名だけ
- MCP / REST が gateway を直接呼ばない: `grep -n "Gateway" presentation/ai/*.ts` で 0。`/mcp` と `/api/ai` の配線は `server.cloudflare.ts` から `presentation/ai/{router,mcp,rest}` を呼ぶだけ
- 固定するテスト（実在・今回 run で緑）:
  - `presentation/ai/__tests__/tools.test.ts:82` 11 個・順序一致、`:139` `presentation/ai/` の全ソースで `.xxxGateway` のメンバ参照と `XxxGateway` 型名が 0、`:153` application の usecase import が許可 17 モジュールに収まり、`application/trash/`・`Revision`・`rollback`・`application/export/`・`hardDelete` 等 17 断片を含まない
  - `presentation/ai/__tests__/handlers.test.ts:264-270` MCP `tools/call list_trash` → `-32601`、`:258` 不正引数 → `-32602`、`:319-332` REST `/api/ai/list_trash` → 404
  - `packages/core/src/application/knowledge/__tests__/usecases.test.ts:166,214` `editDocument` / `rollbackDocument` が型で人間の actor に限られる（`@ts-expect-error`）
- 射程の注記（情報）: gateway 名の scan は `presentation/ai/` 配下だけで、`// ` 行コメントは除去して見るがブロックコメント内の語も一致する（保守側）。`importsOf` は二重引用符の `from "…"` のみ（Biome の format が二重引用符を強制するので実害なし）
- 実行: `pnpm vitest run apps/web/app/presentation/ai/__tests__/tools.test.ts apps/web/app/presentation/__tests__/adapterImports.test.ts packages/core/src/adapters/cloudflare/__tests__/storageWriters.test.ts` → 3 files / 9 passed（14:16:59）

結論: 合格（重大 0）。

## A-4 ログ衛生（2026-09-11T14:18+09:00 頃）

コマンド: `grep -rnE "\b(logger|log|deps\.logger|this\.logger)\.(info|warn|error|debug)\(|console\.(log|info|warn|error|debug)\(" packages/core/src apps/web/app apps/web/scripts`（テスト除外）→ サーバ側 30 箇所強の meta を 1 件ずつ読んだ。

- job runner（`adapters/cloudflare/jobRunner.ts:217,239,254,270`）: `{ kind, operationKey, cause }`。`operationKey` は定数か `resume-*:${operationId}`（`application/identity/jobKeys.ts`）で PII を含まない。`cause` は `failureLabel`（`rowRunner.ts:87-95`）= `CodedError.code` か `Error.name` か固定文字列を切り詰めたもので、message を出さない
- relay（`outboxRelay.ts:106,117,140,154`）: `{ eventId, type, cause }` / `{ eventId, type }`。alarm（`durableObjectBase.ts:582-657`）: `{ cause }` だけ
- consumer / DLQ（`apps/web/app/worker/cloudflare/queueHandlers.ts:123,129,161,47`）: `{ eventId, type }`、`{ eventId, type, cause: error.name }`、`{ eventId, type, outcome }`。メッセージ全体（`message.body`）を渡す箇所は 0。`queueHandlers.ts:41` の `"Mail consumer is not configured"` は `cause: error.message` を出すが、発生元（`application/di/secrets.ts:53,96`、`serverCloudflare.ts:199`）のメッセージは変数名と最小長だけで値を含まない（`throw new …Error(\`…${email|token|secret|key|raw|value|input|canonical}…\`)` の grep で 0）
- 回転 / sweep: `remapChunk.ts:173`・`importRemappedMappings.ts:176` は `{ credentialId, cause }`、`sweepOrphanMapping.ts:147` は `{ operationId, cause }`、`aiClientConnectionRepository.ts:143` / `revokeAllAiClientConnections.ts:65` は `{ connectionId, … }`、trash 2 本は `{ kind, cause: error.name }`。email・token・`callerToken` / `ownerToken`・鍵・canonical を meta に入れる箇所は 0（`credentialId` は mapping 行の識別子）
- operator 監査（`operatorHandlers.ts:408-422`）: `{ entry, locator, id?, outcome }`。`id` は entry ごとの `auditId`（`eventId` / `operationKey` / `userId` / `afterCredentialId` 等、`:144-234`）。`operatorHandlers.test.ts:324-360` が形と「caller token が監査行に届かない」ことを固定
- DLQ ログの形は `queueHandlers.test.ts:203-275` が `{ eventId, type, outcome }` だけであることを `toEqual` で固定
- `[dev-mail]`: `adapters/mail/consoleMailSender.ts:19-30` は `sink !== "console"` なら `ConfigurationError` を投げ、`"console"` のときだけ `[dev-mail] to=… url=…` を出す。選択は `serverCloudflare.ts:180-181`（`MAIL_DEV_SINK` が定義されていれば console sink、不正値は構築時に失敗）。`wranglerConfig.test.ts:324-339` が `.dev.vars.example` に `MAIL_DEV_SINK=` / `SSO_DEV_STUB=` があり、deployed 4 設定（staging / production の request・state テンプレート）に無いことを固定。デプロイ済みの Worker に `wrangler secret put MAIL_DEV_SINK` される経路はテストの射程外（設定ファイルのテストなので当然。`.dev.vars.example:36` が local only と宣言）
- **軽微 A4-1**: `apps/web/app/presentation/errorResponseMiddleware.ts:109-113` は `system` / `unknown` 種別のサーバ関数エラーで `{ kind, code, message, cause: error }` と **エラーオブジェクト全体** を logger に渡す（`:116-118` のフォールバックも `original: error`）。`cause` の連鎖に platform のエラーメッセージが入るので、何が出るかはコードで制限されていない。今回の grep で PII を含む message を組み立てる throw は見つからず、PH-10 の dev ログ 1,682 行でも出現 0 なので実害は未観測。既存（PH-10 以前）の箇所で、CLAUDE.md の衛生規則を「型やテストで」保つ仕組みはここには無い（情報寄りの軽微）
- 情報 A4-2: `apps/web/app/presentation/errorDisplay.ts:233-236` は DEV のときだけエラー全体を `console.error`（本番は固定文字列）

結論: 合格（重大 0、軽微 1 は既存箇所）。

## A-5 エラー契約（2026-09-11T14:19+09:00 頃）

- `git diff 9bec53e..de888b7 -- apps packages | grep -n "catch"`: 5 行ヒット。うち 4 行（`components/settings/RetentionForm/index.tsx`、`components/trash/TrashBoard/index.tsx` ×3）は diff の **文脈行**（先頭が `+` / `-` でない）で、今回追加された catch ではない。残り 1 行は `errorDisplay.ts` 周辺のコメント文脈。`^[+-]` で絞ると catch の追加・削除は 0。PH-10.md §2-7「broad catch の追加なし（trash の notFound 分岐は既存の catch 内の表示分岐）」と一致
- 追加された `queue()`（`packages/core/src/adapters/cloudflare/__tests__/testWorker.ts`）は `batch.ackAll()` だけのテスト用 Worker で catch を持たない
- 新しいクラス宣言: `git diff 9bec53e..de888b7 -- apps packages lint infra | grep -nE "^[+-].*\bclass\s+\w+"` → 0。`new AppServerError(` の追加 2 件は dom テスト内の既存クラスの使用。新しい port `application/ports/aiTokenCodec.ts`（+97）もクラス宣言なし
- `lint/` は範囲内で無変更。`pnpm vitest run lint/banList.test.ts lint/pluginWiring.test.ts` → 2 files / 20 passed（14:19:19）
- `errorDisplay.ts` の差分は `blankFieldMessage` の抽出（文言の単一化）と、存在しない issue を指していたコメントの削除。`application/errors.ts` は `(#64)` の削除のみ

結論: 合格（重大 0、指摘 0）。

## B-1 名指しされたパス・シンボルの実在（2026-09-11T14:22+09:00 頃）

方法: 7 ファイル（docs 4 本・README・CLAUDE.md・`.dev.vars.example`）のバッククォート内トークンを scratchpad の Python で抽出し、パスらしいもの（`/` を含むか既知の拡張子）を repo root と主要 prefix（`apps/web/`・`packages/core/src/` 等）で `os.path.exists`。見つからないものは `git ls-files` の末尾一致で再照合。さらに camelCase / PascalCase の識別子 331 個を `apps packages lint infra` の全ソース + vitest 設定 + `.dev.vars.example` の本文で `grep -w`、ヒットしないものはファイル basename として再照合。

- パス: 469 トークン中、存在 263、プレースホルダ / glob 45（`<stage>`・`${domain}`・`{provider}`・`todo/…` 等の例示。展開できるものは実在を確認: `presentation/__tests__/{currentUser,session,errorResponseMiddleware}.test.ts`、`infra/cloudflare/pulumi/{resources,routes}/Pulumi.{staging,production}.yaml`、`apps/web/wrangler.{staging,production}.toml.tpl`）。残りは basename・パッケージ名・`spec/manual-tests/*.md`（`account.md` 等、実在）・生成物（`.wrangler/state`、git-ignored の `wrangler.staging.toml` 等 — docs 自身が「→ … (git-ignored)」と生成物として書いている）・「存在しない」ことを述べる文（`runtime_cloudflare.md:63` の「there is no `packages/core/src/adapters/d1/`」は事実どおり）
- DOM テストの 29 行（`docs/test.md:23-51`）は `apps/web/app/components/<dir>/__tests__/<name>.dom.test.tsx` と 1 対 1 で完全一致（`diff` で差分 0）

### 不一致

- **重大 B1-1** `docs/runtime_cloudflare.md:390` / 記述: 「`EXPLAIN QUERY PLAN` のテストは … `__tests__/alarmSchedule.integration.test.ts`（Alarm の再武装）、`__tests__/rowRunner.integration.test.ts`（claim の SELECT）、**`stores/__tests__/memoRepository.integration.test.ts` for the timeline seeks and scans**」/ 実際: `packages/core/src/adapters/cloudflare/stores/__tests__/` には `bindChunks.test.ts`・`searchCursor.test.ts`・`searchSnippet.test.ts` しか無く、`memoRepository.integration.test.ts` はこのリポジトリの git 履歴に一度も存在しない（`git log --all -- <path>` 空、文は `3f7c501` の前ビルドからの継承）。`planAssertions.ts`（`queryPlan` / `expectIndexSeek`）を使うのは alarmSchedule と rowRunner の 2 本だけで、タイムラインの seek / scan の計画を固定するテストは無い。docs が存在しないテストで保証を主張している（CLAUDE.md「a test … or its limit stated」にも反する）
- **重大 B1-2** `docs/test.md:52` / 記述: 「The routes' own refusals of an undisplayable id (`isDisplayableDocumentId` / `isDisplayableTopicId` → no feed → the not-found screen) **have a unit test for the predicate**」/ 実際: `isDisplayableDocumentId` / `isDisplayableTopicId` はコードに 0 件（`git log -S` でもこのリポジトリに実装が入った履歴は無く、`3f7c501` の docs 継承のみ）。現在の route は `z.string().min(1).max(200)` の params 検証（例: `routes/_app/documents_.$documentId.tsx:14`）と feed 側の `KnowledgeNotFound` で、述語も述語の unit test も無い。PH-10 で DOM 節（同じ節の 22-51 行）を現状化したが、この文は残った
- **軽微 B1-3** `docs/test.md:13` / 記述: 命名の例に `eventTypeRoster.test.ts` / 実際: そのファイルは無い（全数表の固定は `packages/core/src/application/delivery/__tests__/{jobKinds,rosterGrep}.test.ts`）。「e.g.」の命名例なので誤解は小さいが、実在名に置き換えるのが現状の記述（`entity.test.ts`・`tuning.test.ts` は実在）
- 情報: 識別子のうち `leaseUntil`（CLAUDE.md:82、列 `lease_until` の camelCase 表記、`jobs` / `outbox_events` の列として実在）、`testTimeout`（docs/test.md:96 は「必要なら設定せよ」で、未設定であることと整合）、`findPage` / `fooProcedure` / `FooId` / `useServerAction` 等は例示コード（backend / frontend example の Foo / todo）で対象外

## B-2 issue 番号・`.thread/`・TODO・"not yet"・"Reality: None" の残り（2026-09-11T14:23+09:00 頃）

コマンド: `grep -nE "(^|[^&A-Za-z0-9/])#[0-9]+\b"`、`grep -n "\.thread"`、`grep -niE "TODO|FIXME|not yet|未実装|Reality|tracked|tracking|\bissue"`、`grep -niE "when it lands|future|later slice|planned|\byet\b|until that|waits"` を 7 ファイルに。`gh issue list --state all` → 0 件（PR は #1 / #2 の 2 件、どちらも closed）。

- `#N` の issue 番号: 0。`.thread/`: 0。TODO / FIXME / not yet / 未実装: 0（`todo` は frontend example が冒頭 `:5` で「例示で、このリポジトリには無い」と明示している例示ドメイン）
- "Reality: None" は 2 箇所で、どちらも現在形の事実:
  - `docs/runtime_cloudflare.md:283` 「None for the request Worker half」— `:298` が原因（TanStack Start の仮想モジュールを wrangler が解決できない）を事実として述べる。README の `pnpm start` の記述（HEAD `f14fcd8` で再確認）と一致
  - `docs/runtime_cloudflare.md:715` 「Nothing rate-limits by origin today」
- `runtime_cloudflare.md:22` は「spec との食い違いは issue tracker に置き、ここには書かない」と自己規定し、`:1004-1017` §14 Known limits は各行の記述先の節を示す一覧
- **軽微 B2-1（追跡の約束の未履行。Manager の起票待ち）**: §14 Known limits の 8 行のうち 6 行（デプロイ不能 / Pulumi の D1 残骸 / DLQ ログの非保持 / PITR 4 手順の entry 無し / 滞留の非通知 / origin rate limit 無し）は、PH-10.md §5 で Implementer 自身が「issue 候補」としている項目で、docs からは「tracked in #NN」を外した。記述自体は現在形の事実で docs として正しいが、CLAUDE.md:14「gap は閉じるか issue で追跡、docs に記録しない」と CLAUDE.md:68「Where the code has not caught up with a rule yet, an open issue tracks the gap」は、issue が 0 件の今は成り立っていない（どれが spec との gap でどれが実装の限界かの仕分けも issue 起票時に要る）。`:717`「What to put in place when it lands, as a WAF rule」はそのまま将来の設計の記述で、runtime doc 自身の「None の節は手順を全部持つ」規則（`:20`）には沿うが、gap の記録に近い。受け入れ条件「docs が現状を述べる」は満たしている。PH-10.md §7 の Manager 判断（起票はユーザー確認のうえ Manager、docs から番号を外した対応は据え置き）で扱い済みの事項として軽微
- 情報: `runtime_cloudflare.md:910-914` §12.4「Values with no reader yet」は「no rule exists」と事実だけ

## B-3 件数と secret の列挙（2026-09-11T14:25+09:00 頃）

### テスト件数

- DOM: `find apps/web/app/components -path "*/__tests__/*.dom.test.ts*"` → **29 files**。`docs/test.md:22`「the 29 files under `apps/web/app/components/*/__tests__/`」と一致し、`:23-51` の 29 行とファイル名が 1 対 1（B-1）。`apps/web/app` の components 以外に `.dom.test` は 0。`vitest.config.dom.ts:37-38` の `setupFiles` / `include` と `domSetup.ts:8` の `asyncUtilTimeout: 5_000` も `docs/test.md:18,21` どおり
- integration: `find packages apps -name "*.integration.test.ts"` → **32 files**。`^\s*(it|test)(\.skip|\.only|\.each(...))?\(` の数を合計して **191**（`it.each` は 0 件なので展開の差は無い）。`docs/test.md:61-68` の「32 files, 191 tests」とディレクトリ別・ファイル別の括弧内件数（alarm 3、alarmSchedule 3、migrationGate 2、occ 2、operatorEntries 5、rotation 14、rotationLifecycle 5、rowRunner 2、schema 2、selfLocator 2、jobTerminal 4、recovery 12、rotateEncryption 3、exportAllData 4、aiClientConnections 5、lookupGeneration 4、passwordReset 9、signupSaga 9、sso 7、documents 11、editDocumentByAi 3、sourceLinks 3、topics 5、trashKnowledge 3、aiMemo 4、editMemo 7、revisions 5、softDeleteMemo 3、timeline 4、timelineWindow 10、search 18、trash 18）が **全行一致**
- `vitest.config.do.ts:72-80` の `include` 3 ディレクトリは `docs/test.md:60` の記述と一致。「three state-Worker secrets as literal bindings」（`:57`）も `vitest.config.do.ts:58-66` の 3 つと一致
- 情報 B3-1: `vitest.config.do.ts:74-77` のコメント「their integration suites belong to this pool and **not to the D1 one**」は存在しない D1 pool を指す（`docs/runtime_cloudflare.md:63` は「no Vitest project for it」と正しく書いている）。docs ではなくコードコメントの残骸

### secret の列挙

- README.md:66「Six secrets ship empty … and must be filled before the first `pnpm dev`: `SESSION_SECRET`, `DIRECTORY_ROUTING_SECRET`, `IDENTITY_MAIL_ENCRYPTION_KEY`, `PROVIDER_IDEMPOTENCY_KEY`, `IDENTITY_RESET_TOKEN_KEY`, `AI_CLIENT_TOKEN_SECRET`」: 各々の必須性をコードで確認 — `serverCloudflare.ts:108-109`（`requireSessionSecret` / `requireAiClientTokenSecret`）、`crypto/keyring.ts:253-258`（routing secret、keyring が空なら単一変数が必須）、`:312`（mail encryption key）、`identityDirectoryDurableObject.ts:206-210,538-542`（reset token key / provider idempotency key）。`.dev.vars.example` で空のまま出荷される他の変数（`MAIL_PROVIDER_API_KEY`・`GOOGLE_*`・keyring 2 本・commitment・`OPERATOR_TOKEN`）は `MAIL_DEV_SINK` / `SSO_DEV_STUB` / 単一変数へのフォールバック / operator 面を使うときだけ、で README の書き分けと一致
- `.dev.vars.example:18-37` の帰属表 vs コードの env 型: request 側 `ServerEnv`（`serverCloudflare.ts:40-80`）の秘密 9 個（`SESSION_SECRET`・`DIRECTORY_ROUTING_SECRET`・`DIRECTORY_ROUTING_KEYRING`・`AI_CLIENT_TOKEN_SECRET`・`OPERATOR_TOKEN`・`MAIL_PROVIDER_API_KEY`・`GOOGLE_CLIENT_ID/_SECRET`）+ 非秘密 5 個（`APP_URL`・`DIAGNOSTICS_ENABLED`・`MAIL_FROM_ADDRESS`・`MAIL_DEV_SINK`・`SSO_DEV_STUB`）、state 側 `StateWorkerEnv`（`durableObjectBase.ts:56-71`）の 5 個（`PROVIDER_IDEMPOTENCY_KEY`・`IDENTITY_MAIL_ENCRYPTION_KEY(RING)`・`DIRECTORY_KEY_COMMITMENT`・`IDENTITY_RESET_TOKEN_KEY`）。**表と env 型は過不足なく一致し、帰属も一致**。`.dev.vars.example` の実エントリ（`^[A-Z_]+=`）15 行も表と一致
- `wranglerConfig.test.ts` が固定しているもの: `AI_CLIENT_TOKEN_SECRET`・`OPERATOR_TOKEN`（帰属行・`wrangler secret put`・`[vars]` に無いこと）、rotation 3 変数（帰属・`--config` 付きの secret put）、`APP_URL` / `DIAGNOSTICS_ENABLED`（非秘密として表にあり `=` 行が無い）、`MAIL_DEV_SINK` / `SSO_DEV_STUB`（local only）
- **軽微 B3-2**: 残る 7 変数（`SESSION_SECRET`・`MAIL_PROVIDER_API_KEY`・`DIRECTORY_ROUTING_SECRET`・`IDENTITY_MAIL_ENCRYPTION_KEY`・`PROVIDER_IDEMPOTENCY_KEY`・`IDENTITY_RESET_TOKEN_KEY`・`GOOGLE_*`）の帰属行、および「env 型の全キーが表にある」ことを固定するテストは無い。CLAUDE.md「Hosting the consumers in the request Worker puts the mail provider's secrets on the request Worker; which secret belongs to which Worker is declared in `apps/web/.dev.vars.example`」と `.dev.vars.example:39-44`「DIRECTORY_ROUTING_SECRET と IDENTITY_MAIL_ENCRYPTION_KEY は反対の Worker に配る… nothing in the code would notice」は、限界を自ら述べている（後者）ので原則違反ではない。`.dev.vars.example:55-58`「This table is the roster of secrets declared so far, not a promise that it is complete」は現時点では完全（上記）で、将来の完全性はテストされないという限界の記述として読める。今は一致しているので軽微

## B-4 operator entry・DLQ・`OPERATOR_TOKEN`（2026-09-11T14:26+09:00 頃）

### entry 表（`docs/runtime_cloudflare.md:735-753` §10、15 行）vs `apps/web/app/worker/cloudflare/operatorHandlers.ts`

- `OPERATOR_ENTRIES` のキーと `targets` を抽出（`\n  "<name>": {\n    targets: …`）: 15 個、名前・順序・対象クラスが表と全行一致（both 8 = read-schema-version / read-delivery-backlog / list・requeue・delete-quarantined / list・requeue・delete-poisoned、directory 6 = list-bucket-user-ids / purge-user-mappings / start-rotate-encryption / remap-chunk / import-remapped-mappings / read-rotation-checkpoint、user 1 = record-remapped-locator）
- 本文の引数: `eventId`（requeue / delete-quarantined）、`operationKey`（poison 2 本）、`userId`（purge）、`active` / `previous` / `limit` / `afterCredentialId?`（remap-chunk）、`active` / `rows`（import、`.max(IMPORT_ROWS_PER_CALL)`、`mappingRows.ts:77` の式 = `floor(100 / (列数 + 2))`、`operatorHandlers.test.ts:379` が `toBe(3)` を固定）、`callerToken` / `credentialLocator`（record-remapped-locator）、`rotationKind` / `generation`（checkpoint）、`cursor?`（list 2 本）。表の「Body」列と一致
- gate の外: `list-bucket-user-ids` は `identityDirectoryDurableObject.ts:732-735` で `isInitialized` でなければ `[]`（初期化しない）。表どおり
- 監査 id（§8.2 (c)、`:546`）: `eventId` / `operationKey` / `userId` / `afterCredentialId` / `credentialId` — `operatorHandlers.ts` の `auditId`（`:144-234`）と一致

### `OPERATOR_TOKEN` の判定順（§8.2 (a)、`:542`）

- docs: 404（秘密が未設定または 32 文字未満）→ 404（未知の entry）→ 405（POST 以外）→ 401（bearer 不一致、定数時間比較）→ 400（locator 不受理・body が object でない・schema 不一致）
- 実装 `handleOperator`（`operatorHandlers.ts:336-392`）: `token === undefined || length < MIN` → 404、`OPERATOR_ENTRIES[entryName] === undefined` → 404、`method !== "POST"` → 405（`allow: POST`）、`Bearer` 不一致 → 401（`tokenMatches`）、JSON 不正 / 非 object → 400、`parseLocator` 失敗 or 対象外クラス → 400、`entry.schema.safeParse` 失敗 → 400。**順序は docs と一致**（依頼文の「404/401/405/400」ではなく、docs も実装も 405 が 401 より先）
- 情報 B4-1: 401 と 400 の間に、`DIRECTORY_ROUTING_KEYRING` が使えないとき 500（`"DIRECTORY_ROUTING_KEYRING is not usable"`、`:371-376`）がある。docs §8.2 は触れていない（設定不備の応答で、判定順の主張と矛盾はしない）

### DLQ（§8.6、`:620-640`）vs `queueHandlers.ts`

- 「each message once, then acks it」: `handleDlqBatch`（`queueHandlers.ts:139-169`）は各メッセージで `deliverOnce` を 1 回、例外は `outcome = "failed"`、`logger.warn("dlq", { eventId, type, outcome })`、`message.ack()`、最後に `batch.ackAll()`。docs どおり。`queueHandlers.test.ts:203-275` が固定
- **軽微 B4-2** `docs/runtime_cloudflare.md:624` / 記述: 「A message is in the DLQ because the events consumer **failed it three times**」/ 実際: events consumer は `max_retries = 3`（`wrangler.toml:68`）で、初回 + 再試行 3 回 = 4 回失敗して DLQ に移る。PH-10 の実走（`reviews/PH-10-manual/account.md:104`）でも miniflare のログは「after 4 failed attempts」。「failed it four times」か「exhausted its three retries」が現状
- 情報 B4-3: consumer の組み立て自体が失敗する場合（`queueHandlers.ts:36-53`、例: `MAIL_DEV_SINK` 不正値や provider key 無し）、DLQ 側は `deliverOnce` を呼ばずに `outcome: "failed"` で `ackAll()` する（再配送 0 回）。§8.6 の「runs every message through the same `deliverOnce`」はこの経路を述べていない。PH-10 TC-46 はまさにこの経路で観測している。受け入れ条件に響くほどではない
- 情報 B4-4: §8.6「The DLQ has no DLQ of its own, so there is no second attempt」と、DLQ consumer の `max_retries = 1`（`wrangler.toml:77`、§12.1 `dlqMaxRetries` 1「a retry is one redelivery then permanent discard」）は、handler が全メッセージを ack するので実際には再配送が起きないという意味で整合する（handler が ack 前に落ちたときだけ 1 回）

## B-5 新しく書かれた保証とそれを固定するテスト（2026-09-11T14:28+09:00 頃）

| 保証（docs / CLAUDE.md） | 固定するもの | 確認 |
|---|---|---|
| scan テスト 2 本: adapters の外に書き込み SQL が無い / `apps/web/app` で entry point 以外が adapter を import しない（docs/test.md:13） | `packages/core/src/adapters/cloudflare/__tests__/storageWriters.test.ts`、`apps/web/app/presentation/__tests__/adapterImports.test.ts`。どちらも「スキャン対象に既知のファイルが入っている」ことも固定（空振り防止） | 実在・14:16 に緑。射程の限界は docs/test.md:13 に書いてある（A-1 の補足: 小文字 SQL・KV API・副作用 import・相対パスは未記載だが実例 0） |
| alarm の 2 pass の独立上限と `leaseUntil` の再武装（docs/test.md:62、CLAUDE.md 非同期契約 3） | `packages/core/src/adapters/cloudflare/__tests__/alarm.integration.test.ts:115-188`（relay 上限 + 2 行・jobs 上限 + 2 行を積み、1 回の wake-up で published = relayLimit・done = jobsLimit・残り各 2 を `toBe` で固定、次の wake-up で 0）、`:190-240`（claim 済み行だけの DO は過去の `next_run_at` ではなく最早の `lease_until` に再武装） | 実在・`pnpm vitest run --config vitest.config.integration.ts …/alarm.integration.test.ts` → 3 passed（14:27:41）。片方の pass がもう片方の予算を食えば done / published の件数が崩れるので赤になる |
| DLQ は各メッセージを 1 回だけ再配送して ack（CLAUDE.md:71 Retry strategy、非同期契約 5、docs §8.6） | `apps/web/app/worker/cloudflare/__tests__/queueHandlers.test.ts:203`「re-drives each message once through the same delivery, then acks with only id, type and outcome logged」 | 実在。B-4 の軽微 B4-2（「three times」）と情報 B4-3（組み立て失敗時は再配送 0 回）を参照 |
| `AiTokenCodec` は presentation 専用 port（CLAUDE.md:110） | 型: UoW ctx 2 型のメンバに無い（A-2）。利用箇所は `presentation/ai/{auth,oauth}.ts` と合成根（`di/serverCloudflare.ts`・`di/secrets.ts`）だけで DO 側の adapters から参照 0。`Promise` を返す port の全数（`domain` + `application/ports`）= `PasswordHasher`・`MailSender`・`SessionCodec`・`SsoIdentityProvider`・`AiTokenCodec` で、CLAUDE.md の 2 群の列挙と過不足なく一致 | 現状は一致。**情報 B5-1**: この列挙（非同期 port が 5 つで、UoW から届くのは 2 つ）を固定するテストは無い。新しい非同期 port を足しても何も赤くならない。CLAUDE.md 自身が「that list is an enumeration, not a derived rule」と書いているので、列挙を手で保つ前提は明示されている |
| `deleteNoopReissueDelayMs` の 1 回だけの再発行（CLAUDE.md:71、90281ae で追加） | `application/identity/rotation/__tests__/deletionConfirmation.test.ts:9,31`、`adapters/cloudflare/__tests__/rotationLifecycle.integration.test.ts:342` | 実在 |

### CLAUDE.md の差分の各文

- `git diff 9bec53e..de888b7 -- CLAUDE.md`: 1 行（`CLAUDE.md:110`）で、presentation 専用 port の列挙に `AiTokenCodec` を追加しただけ。対応コードは上表（`application/ports/aiTokenCodec.ts`、`adapters/webcrypto/aiTokenCodec.ts`、`presentation/ai/pkce.ts`）。Manager 承認済み（PH-10.md §7）
- `git show 90281ae -- CLAUDE.md`（4 段落）:
  - Retry strategy に「DLQ handler の 1 回の再配送」と「`deleteNoopReissueDelayMs` 後の 1 回の再発行は retry ではない」→ 上表のとおりコードとテストあり
  - 非同期契約 5 の「the queue's retry and then the DLQ」→「the queue's retry, the DLQ handler's single automatic re-drive」の 2 語差し替え → `queueHandlers.ts:139-169`
  - broad catch の境界の列挙（bare request handlers = `/__operator/*`・SSO callback・AI の OAuth / MCP / REST・`/export`・session 検証、per-item = `sweep-orphan-mapping`・`emptyTrash`・`pruneExpiredTrashItems`・`revokeAllAiClientConnections`・`remap-chunk`・`import-remapped-mappings`、saga の補償 catch = signup / link、`loginWithPassword` の fold）→ 各々に catch が実在（`operatorHandlers.ts`・`ssoHandlers.ts`・`presentation/ai/{oauth,mcp,rest,auth}.ts`・`presentation/export/handler.ts`・`presentation/{session,requestSession,currentUser}.ts`・`jobs/sweepOrphanMapping.ts:147`・`trash/emptyTrash.ts:79`・`trash/pruneExpiredTrashItems.ts:118`・`revokeAllAiClientConnections.ts:65`・`rotation/remapChunk.ts:173`・`rotation/importRemappedMappings.ts:176`・`signupSaga.ts:100-104`（予約を取り消してから再 throw）・`linkSsoCredential.ts:73-75`（`finishLink` してから再 throw）・`loginWithPassword.ts`）
  - 情報 B5-2: 非テストの catch は約 90 ファイル。列挙に名前が無いのは (a) adapter の翻訳 catch（`RehydrationError` への包み直し、unique 違反 → OCC 等。CLAUDE.md の adapter → application 規則が認める形）、(b) 狭い parse の catch（`domain/identity/valueObject.ts:90` の URL 解析、`domain/export/valueObject.ts:15` の `Intl` タイムゾーン検証、zod の `.catch(default)`）、(c) `apps/web/app/components/**` の `"use client"` 島が server function の reject を受けてエラー UI を出す catch（約 35 ファイル）。(c) は CLAUDE.md の Frontend 節（leaf が error UI を持つ）が前提にしている形だが、Error handling 節の「Use it only at explicit boundaries:」の閉じた列挙には入っていない。PH-10 以前からの記述の粒度の問題で、今回の差分では増えていない

## B-6 example docs の実コード引用の突き合わせ（2026-09-11T14:30+09:00 頃）

### docs/frontend_implementation_example.md（一致）

- `:176-190` `postMemoFn`（`// apps/web/app/components/timeline/actions.ts`）: `actions.ts:15-28` と `createServerFn({ method: "POST" })` → `.middleware([errorResponseMiddleware, noStoreMiddleware])` → `.inputValidator(validateInput(postMemoSchema))` → `requireUserId` → `loadServerDeps(() => import(".../memo/postMemo"))` → `module.postMemo({ container, input: { userId, body: data.body, actor: await userActorOf(userId) } })` まで逐語一致
- `:226-255` `DocumentFeed`（`components/documents/DocumentFeed/index.tsx`）: `loadDocument = serverData(() => import(".../knowledge/getDocument"), async ({ container }, { getDocument }, userId, documentId) => getDocument(...))`（`:11-14`）、`guardStreamedRender` → `extractSerializedError(error).kind === "notFound"` → `<KnowledgeNotFound subject="ドキュメント" />`（`:37-50`）まで一致（本文の `<article>` は抜粋）
- `:165-168` `serverData(loadModule, run)` / `loadServerDeps(loadModule)`: `presentation/serverAction.ts:10,22` の 2 export だけ
- `:216` `routes/_app/index.tsx` の `validateSearch: (search) => timelineSearchSchema.parse(search)`（`:30`）、`renderTimeline` の `inputValidator(validateInput(timelineSearchSchema))`（`:16-18`）、`TimelineFeed` の `loadPage` / `loadDay` / `loadAround`（`:8,22,39`）— 一致
- `:96-101` `streamingRouteOptions` の `pendingComponent: () => null` / `ssr: !import.meta.env.DEV`（`streamingRoute.ts:19-20`）、`Deferred` の `use(useDeferredValue(promise))`（`ui/Deferred/index.tsx:29`）、`router.tsx:15-19` の `defaultPendingComponent: RoutePendingFallback` / `defaultPendingMs: 200` / `defaultPendingMinMs: 300`、Skeleton 8 種すべて実在 — 一致
- `:108-` `TimelineBoard` の `fetchPage = useServerFn(loadTimelinePageFn)` と `useTransition()`（`:161,175`）、`readServerFnResult(value, guard, name)`（`serverFnResult.ts:18-21`、code `UNEXPECTED_SERVER_FN_RESULT`）、`isPostMemoResult`（`timeline/schema.ts:43`）— 一致
- `:272-274` `_app.tsx` の `beforeLoad` → `readAuthStateFn` → `toSafeRedirect`（`routes/_app.tsx:14-17`、`authState.ts:18`、`redirectSearch.ts:59`）、`routeHead`（`head.ts:103`）— 一致

### docs/backend_implementation_example.md

- 一致: `presentation/errorResponse.ts` の 7 export（`AppServerError`・`serializeError`・`extractSerializedError`・`asSerializedError`・`isAppServerError`・`redactForClient`・`httpStatusFor`）、`errorDisplay.ts` の `displayError` / `sanitizeRouteError`、`JOB_KIND_POLICY`（`application/delivery/types.ts:69`）、`TerminalStageSelector`（`jobRunner.ts:131`）、`envelope` / `enterRpc`（`durableObjectBase.ts:175,195`）と「unclassified は `failureLabel` の射影で message を取らない」（`serializeRpcError`、`:719-724`）、alarm の順序と fail-closed で `deleteAlarm` しないこと（`:560-660`）、operator entry 15 の分担、`translate()`（`unitOfWork.ts:61-75`）、`rehydrate()`（`stores/memoRepository.ts:116`）
- **軽微 B6-1** `docs/backend_implementation_example.md:99` / 記述: ディレクトリ木で `└── scripts/  operator.ts … ai-client.ts … render-wrangler.ts` を `apps/web/app/` の直下（`presentation/`・`worker/cloudflare/` と同列）に置いている / 実際: `apps/web/app/scripts/` は無く、3 本は `apps/web/scripts/`。PH-10 の前任の現状化 `02676d3` で入った行
- **軽微 B6-2** `docs/backend_implementation_example.md:384-407` / 記述: 「`createUserSettingsRepository` (`…/stores/userSettingsRepository.ts`) is the shipped one」として `save` の抜粋を示し、`updated_at` に `now`、不一致時に `throw new ConflictError("OPTIMISTIC_LOCK_FAILURE", "Optimistic lock failure: the user was modified concurrently")` / 実際（`userSettingsRepository.ts:39-49`）: `user.updatedAt.getTime()` を束縛し、不一致時は `throw occConflict()`（`stores/occ.ts:4-9`、message「The row was modified by another operation」）。形（`updateMatchedRow` → `WHERE version = ?` → `expectedVersion as number` → 0 行で `OPTIMISTIC_LOCK_FAILURE`）と要点の説明は正しいが、「shipped one」と言う抜粋が実コードと 2 箇所違う。また同じ段落の冒頭「guarded on `id` **and** `version`」は直後に「single-row なので `version` だけ」と言い直しており、一般形と実例の区別が読み取りにくい（誤りではない）
- 情報 B6-3: `:52-58` の `stores/` の列挙に `trashQueryPort.ts` が無い（実在 26 モジュール中、列挙外はこれだけ）。「one module per table or projection」の全数表としては 1 件漏れ

## 追補（2026-09-11T14:31+09:00 頃）

- 情報 B1-4 `docs/runtime_cloudflare.md:931` / 記述: 「`rowRunner.integration.test.ts` の `EXPLAIN QUERY PLAN` が index 名 **and that `next_run_at` is an index constraint** を assert する」/ 実際: `rowRunner.integration.test.ts:26-40` は `expectIndexSeek(plan, "jobs_runnable_idx" | "outbox_runnable_idx")`（`planAssertions.ts`: `INDEX <name>` の行があり `SCAN` 行が無い）で、`next_run_at` が制約に現れることは直接は見ていない（`SCAN … USING INDEX` は落ちるので、index を先頭列で引いていることは間接的に固定される）。わずかな言い過ぎ
- 実行したテスト（すべて緑）: `adapterImports` / `storageWriters` / `presentation/ai/__tests__/tools.test.ts`（3 files / 9、14:16:59）、`lint/banList` / `lint/pluginWiring`（2 files / 20、14:19:19）、`alarm.integration`（1 file / 3、14:27:41）
- scratchpad に置いたもの（リポジトリ外）: `uow/check.ts`（型の拒否の確認）、`paths.py` / `paths.out`（パス抽出）、`idents.txt` 等。リポジトリで書いたのはこのファイルだけ
