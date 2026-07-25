# レビュー round-2 — アーキテクチャ整合性・実現可能性・リスク

**対象:** `.issue/1/plan.md`（改訂版・全24ステップ）／`.issue/1/adr.md`（ADR-001〜009）
**視点:** プロジェクトのあるべきアーキテクチャとの整合性・実現可能性・リスク
**日付:** 2026-07-25

## 調査範囲

1周目の指摘（`round-1-arch-risk.md` P-001〜P-007 / S-001〜S-012、`round-1-coverage.md` P-001〜P-004 / S-001〜S-006）が実際に plan.md / adr.md に反映されているかを、宣言ではなく**実コードで**照合した。確認したもの:

- `packages/core/src/application/di/{types,serverNode,serverCloudflare,serverAws,serverGcp,containerStore}.ts` と `di/__tests__/serverCloudflare.test.ts`
- `packages/core/src/application/execution/unitOfWork.ts`、`adapters/{d1,libsql}/{unitOfWork,pendingBatch}.ts`、`adapters/d1/repositories/helpers.ts`
- `packages/core/src/application/workers/eventRelayWorker.ts` と `__tests__/eventRelayWorker.integration.test.ts`、`apps/web/app/worker/{cloudflare,node}/{handlers,runner}.ts` および同 `__tests__/`
- `packages/core/src/adapters/{d1,libsql}/__tests__/{setup,helpers}.ts`、`application/__tests__/helpers.ts`
- `adapters/{d1,libsql}/migrations/**`（d1 に `meta/` が無いこと・libsql の `_journal.json`）、`adapters/d1/schema.ts`、`apps/web/drizzle*.config.ts`、`package.json` の db スクリプト
- `vitest.config.ts` / `vitest.config.integration.ts` / `vitest.config.integration.node.ts`、ルートおよび `apps/web` / `packages/core` の `tsconfig.json`
- `apps/web/app/presentation/{errorResponse,errorDisplay,validator,serverAction}.ts`、`routes/__root.tsx`、`router.tsx`、`components/ui/{Skeleton,RoutePendingFallback}`
- `spec/database/index.md#users`、`spec/usecases/identity.md#registerWithPassword`、`spec/inventory/{domain,adapter,frontend}.md`、`spec/design/{index,tokens}.md`
- 実行検証: `sqlite3` で drizzle 生成形の `CONSTRAINT "occ_guard_positive" CHECK("_occ_guard"."n" > 0)` が SQLite で有効かつ制約名がエラーメッセージに乗ることを実測（→ ステップ7の再生成は `isOccGuardViolation` を壊さない）

## 総評

1周目の7件の問題点は**すべて計画本文に落ちており、宣言と実体の乖離はほぼ無い**。とくに P-001（rest-spread 漏洩）は「除外する」ではなく `secrets` へのネストという構造的な封じ方に変わっており、P-005 は ADR-008 という正式な設計判断に昇格し、限界と恒久解の移行経路まで書かれている。P-004 は ADR-003 本体の Decision を書き換えて実測手順・フェイクハッシャー・代替案2つに具体化されており、指摘の意図を正確に汲んでいる。P-002 の波及リストは実際に grep で追い直したが、**import 参照の取りこぼしはゼロ**（残るのは JSDoc / コメント中の "Todo" 文字列だけ）。

残る問題は3件で、いずれも**1周目の修正がもう一段だけ足りていない箇所**である。

- P-007（各ステップで型検査が通る）は組み替えの原則自体は正しいが、**ステップ10で `RequestContainer` に必須メンバを足す一方、その構築点4本（ステップ13）とテストコンテナ2本（ステップ12）が後回し**になっており、ステップ10〜12で型検査が落ちる。ステップ8で「スロット追加と UoW 実装2本を同一ステップに置く」と正しく判断したのと同じ規律が、ステップ10には適用されていない。
- ステップ3の「relay / consumer 統合テストをドメイン非依存のその場イベントに置き換える」は、`AllDomainEvents` を空にしている期間中は**型として実行不能**（デコーダを1件も登録できない）。
- ステップ7のスキーマ／目視確認リストから spec が要求する CHECK が2本落ちている。

## 1周目指摘の解消状況

| 1周目 ID | 状態 | 根拠 |
|---|---|---|
| arch P-001 `SESSION_SECRET` 漏洩 | **解消** | ステップ13で `RequestServerConfig` を `secrets: { sessionSecret }` にネスト、秘密は `createHmacSessionCodec` の構築にのみ使用、`RequestContainer` に載せない、ステップ23で `config` キー集合の回帰テスト。4本の factory が `...appConfig` + 変数への `satisfies` である事実は実コードで再確認済み（波及の記載漏れ1件 → 本稿 P-001） |
| arch P-002 todo 削除の波及 | **解消** | `grep -rn "domain/todo\|application/todo\|components/todo\|routes/todo"` の結果とステップ3の一覧が完全一致。`d1/__tests__/setup.ts` はステップ7で `todos`/migrations/`setup.ts` を3点セットで差し替える判断に変わっており、これは1周目の提案より正しい（先に消すと D1 プールが全滅する） |
| arch P-003 マイグレーション再生成 | **概ね解消** | journal 走査への書き換え・`--name initial`・d1 に `meta/` が生えること・`git diff` 目視をステップ7と ADR-001 に記載。`_occ_guard` の CHECK 形が drizzle 生成形でも壊れないことは実測で確認。ただし目視項目に CHECK 2本の欠落（→ 本稿 P-003） |
| arch P-004 PBKDF2 と workerd | **解消** | ADR-003 の Decision を書き換え、ファクトリ引数化・着手時実測・フェイクハッシャー注入・代替案2つを明記。`vitest.config.integration.ts` の include/exclude で identity 統合テストが workerd プールに入る事実も再確認 |
| arch P-005 SSO 制約の区別不能 | **解消** | ADR-008 として独立。前提（`PasswordUser` の insert では部分一意インデックスが原理的に発火しない）・JSDoc での固定・恒久解（`PendingBatch` の制約違反ハンドラ）まで記録。推奨案(a)を見送った理由（検証テストが書けない）も妥当 |
| arch P-006 `apps/web` テスト基盤 | **解消** | ステップ2として独立した疎通確認タスク。ルート `vitest.config.ts` に `include` が無く `resolve.tsconfigPaths: true` であること、`apps/web` 配下の非 integration テストがゼロであることを実コードで確認。`sessionCookie.ts` 分離により `server-only` の可否に依存しない設計になっている |
| arch P-007 ステップ順序 | **部分解消** | 「削除 → 追加」への組み替えとステップ3への前倒しは正しい。ただしステップ10〜12で型検査が落ちる（→ 本稿 P-001）、ステップ3の完了条件が満たせない（→ 本稿 P-002） |
| arch S-001〜S-012 | **全件反映**（S-003 / S-011 は理由付きで限定、P-005 推奨案(a)は理由付きで見送り） | ステップ10 の JSDoc 2件、ADR-007 の判断基準、AC-14 の「下部タブ相当」訂正、`errorResponse.ts` の再エクスポート、CF の zod スキーマ不在、`todoRepository.ts` の誤コメント注意まで確認 |
| coverage P-001〜P-004 / S-001〜S-006 | **全件反映** | AC-6 の書き換え・ADR-008 / ADR-009 の新設・AC-12 の送信中表示・`renderValidationMessage` / `renderBusinessMessage` の新設・`auth/schema.ts` の上限1024・付随実装表を確認 |

---

## 問題点（要修正）

### **[P-001]** ステップ10で `RequestContainer` に必須メンバを足す一方、その構築点（DI ファクトリ4本・テストコンテナ2本・既存 DI テスト1本）の更新がステップ12 / 13 に分かれている — ステップ10〜12で `pnpm typecheck` が落ち、AC-17 の前提が崩れる

- 理由:
  `packages/core/tsconfig.json` の `include` は `["src/**/*"]` なので、**`__tests__/` 配下も `pnpm typecheck` の対象**である。`RequestContainer` に `passwordHasher` / `sessionCodec` を必須で足すと、次のすべてがオブジェクトリテラルの不足プロパティで型エラーになる。

  - `packages/core/src/application/di/{serverNode,serverCloudflare,serverAws,serverGcp}.ts` の `createXxxRequestContainer`（4本） — 更新は**ステップ13**
  - `packages/core/src/adapters/d1/__tests__/helpers.ts`（`TestContainer = RequestContainer & WorkerContainer & { db }` を返す `createTestContainer()`） — 更新は**ステップ12**
  - `packages/core/src/application/__tests__/helpers.ts`（同上） — 更新は**ステップ12**

  さらに、ステップ13が `ServerEnv`（Cloudflare）に `SESSION_SECRET` を必須で足すと、**計画のどこにも挙がっていない**次のファイルも落ちる。

  - `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` — `function envWith(overrides): ServerEnv { return { DB: …, APP_URL: …, ...overrides }; }` が `ServerEnv` のリテラルを組み立てている。`SESSION_SECRET` を必須にすると不足プロパティで型エラー

  計画はステップ8で「スロット追加と実装を同一ステップにするのは、片方だけでは型検査が通らないため」と**正しい規律を明示している**のに、ステップ10には同じ規律が適用されていない。AC-17 の「各実装ステップの完了時点でも `pnpm typecheck` が通る（ステップ順序はそのように組んである）」という主張が、ここだけ事実と食い違う。

- 提案:
  - ステップ10を「`SessionCodec` ポート定義 + `RequestContainer` 拡張 + **4本の DI ファクトリの配線** + **テストコンテナ3本の更新**」まで含む1ステップに拡張する（＝現ステップ13の 3〜4項と現ステップ12の TestContainer 拡張部分を前倒しする）。あるいは順序を **9 → 10（型）→ 13（DI 配線）→ 12（テストコンテナ + 共通基盤テスト移植）→ 11（ユースケース）** に組み替える。
  - どちらを採るにせよ、ステップ13の対象ファイルに `packages/core/src/application/di/__tests__/serverCloudflare.test.ts` を追加する（`envWith` に `SESSION_SECRET` を足す）。
  - 一般則として plan.md のステップ順序の原則に「**コンテナ型／コンテキスト型を広げるステップは、その型を構築するすべての地点の更新を同一ステップに含める**」を1行足しておくと、後続スライスでも同じ事故が起きない。

### **[P-002]** ステップ3の「relay / consumer 統合テストをその場のイベントドラフトに置き換える」は、`AllDomainEvents` を空にしている期間中は成立しない — ステップ3の完了条件（`pnpm test:integration` が通る）を満たせない

- 理由:
  `packages/core/src/application/workers/eventRelayWorker.ts` の型は次の連鎖になっている。

  ```ts
  type AllDomainEvents = TodoEvent;
  export type DefaultEventDecoderRegistry = {
    readonly [K in AllDomainEvents["type"]]: EventDecoder<Extract<AllDomainEvents, { type: K }>>;
  };
  export type EventDecoderRegistry = Partial<DefaultEventDecoderRegistry>;
  ```

  ステップ3で `AllDomainEvents` を「一時的に空へ」すると（`never`）、`DefaultEventDecoderRegistry` は `{}` になり、`EventDecoderRegistry` も `{}` になる。つまり**その期間はデコーダを1件も型安全に登録できない**。

  一方、置き換え対象の3ファイルは decode 経路を実際に通る。

  - `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts` — `createTodo` / `changeTodoStatus` / `deleteTodo` で outbox を seed し、`processOutboxEvents` の結果に `["todo.created","todo.toggled","todo.deleted"]` と**デコード済み payload のブランド値**を表明している。ドメイン非依存に書き換えても、デコーダが登録できない以上 decode に失敗して全行 failure になる
  - `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` / `apps/web/app/worker/node/__tests__/runner.node.integration.test.ts` — `runRelayTick`（`apps/web/app/worker/cloudflare/handlers.ts`）も node の `runner.ts` も `processOutboxEvents(container, dispatch, {...})` を**レジストリ差し込み口なしで**呼ぶため、常に `defaultEventDecoderRegistry` を使う。空レジストリでは `No decoder registered for event type "..."` になり、relay 成功系のケースが落ちる（`aws` / `gcp` の `handlers.ts` だけは `registry` 引数を持つ）

  つまり「テストファイル内でその場のイベントドラフトを定義すればドメイン非依存にできる」という前提が、レジストリ側の型と実行経路の両方で成立しない。

- 提案:
  次のどちらかに書き換える。

  - **(a) 他の統合テストと同じ扱いにする（推奨）** — ステップ3では3ファイルを**削除**し、identity のイベントが揃うステップ11の後（ステップ12 または 23）に `identity.userRegistered` を seed イベントとして復活させる。ステップ3の完了条件から `pnpm test:integration` の全緑を外し、「削除した統合テストはステップ12 / 23で復活させる」ことを ADR-001 の Consequences（既に「削除と移植を別ステップに割る」と書いてある箇所）に追記する。
  - **(b) 空にしない** — ステップ3では `AllDomainEvents` / `defaultEventDecoderRegistry` を空にせず、ステップ11で `TodoEvent` → `IdentityEvent` へ**置換**する。この場合はステップ3で `domain/todo/events.ts` と `application/todo/eventDecoders.ts` だけ残すことになり、「todo 一式削除」の意味が濁るので (a) のほうが素直。

  いずれにせよ、`EventDecoderRegistry` が `AllDomainEvents` に閉じている（＝空にすると登録不能になる）ことを plan.md のリスク節に1行残すこと。ここは型エラーではなく**テスト実行時にしか出ない**失敗である。

### **[P-003]** ステップ7のスキーマ定義／目視確認リストから、spec が要求する CHECK が2本落ちている — 型検査でも `git diff` の確認項目でも拾えない

- 理由:
  `spec/database/index.md#users` は列制約として次を要求している。

  | 列 | spec が要求する制約 | plan の記載 |
  |---|---|---|
  | `auth_method` | `CHECK (auth_method IN ('password','sso'))` | スキーマ疑似コードの**コメントにのみ**あり。設計節の箇条書き（直和 CHECK / `sso_provider` 値域 / `sso_provider_subject` 非空 の3本）にも、ステップ7の目視確認リスト (a)〜(d) にも無い |
  | `trash_retention_days` | `CHECK (trash_retention_days >= 1)` | 同上（疑似コードのコメントのみ） |

  ステップ7の完了条件は「型検査では検出できないので目視が唯一の関門」と明言しているのに、**その目視リストに載っていない制約は事実上ノーガード**になる。`users_email_uq` も同様に目視リストから漏れている（部分一意インデックスだけが挙げられている）。

  `auth_method` の値域は直和 CHECK の論理和で実質担保されるので実害は小さいが、`trash_retention_days >= 1` は**どの CHECK にも含まれない独立の不変条件**で、抜けると `TrashRetentionDays`（DOM-identity-010）の不変条件が DB 側で守られなくなる。ADP-users-001 の完了条件（spec/database の users を実装する）にも直接効く。

- 提案:
  - 設計節「アダプター / 永続化」の箇条書きに `check("users_trash_retention_positive", sql\`trash_retention_days >= 1\`)` と `check("users_auth_method_valid", sql\`auth_method IN ('password','sso')\`)` を明示的に追加する（他の CHECK と同じく**制約名を付けて独立させる**方針に揃える。違反時にどの不変条件が破れたか制約名で判別できるという、計画自身が採った理由がそのまま当てはまる）。
  - ステップ7の目視確認リストを (a) 直和 CHECK / (b) `users_sso_identity_uq` 部分一意 / (c) `sso_provider_subject` 非空 CHECK / (d) `sso_provider` 値域 CHECK / (e) `auth_method` 値域 CHECK / (f) `trash_retention_days >= 1` CHECK / (g) `users_email_uq` / (h) 共通基盤3テーブル + `idx_outbox_pending` に拡張する。

---

## 改善提案（検討推奨）

### **[S-001]** ステップ13の rest-spread の書き方が Cloudflare に当てはまらない — ランタイム別に正しい形を書く

- 理由:
  plan.md ステップ13 は「4本の `createXxxRequestContainer` の rest-spread を `const { db: _db, relayTrigger: _relayTrigger, secrets, ...appConfig } = config;` にする」と書いているが、実コードでは Node / AWS / GCP が `{ db, relayTrigger }` なのに対し、**Cloudflare だけ `{ binding, relay, waitUntil }`** である（`packages/core/src/application/di/serverCloudflare.ts` の `createRequestContainer`）。この一文をそのまま写すと CF で存在しないプロパティを分解することになり、手戻りになる。
- 提案: 「4本とも既存の分解に `secrets` を1つ足す（CF は `const { binding: _binding, relay, waitUntil, secrets, ...appConfig }`）」と書き換える。

### **[S-002]** `SystemErrorCode.DatabaseError` をセッション破棄失敗に流用するのは、コード表の JSDoc の意図とずれる

- 理由:
  ステップ14は `endSession` の未知例外を `SystemError(SystemErrorCode.DatabaseError, "Failed to end session", cause)` に翻訳するとしている。`packages/core/src/application/errors/index.ts` の `SystemErrorCode` の JSDoc は「外部リソースごとに1エントリを足せ」「`DatabaseError` は storage layer が throw した意」と明記しており、Cookie ヘッダー書き込み失敗を `DATABASE_ERROR` として記録すると、ログ・アラートのルーティング（同 JSDoc が挙げている用途）がノイズを拾う。
- 提案: `SystemErrorCode` に1エントリ足す（例: `SessionError: "SESSION_ERROR"`）か、`DatabaseError` を使う理由（将来テーブル方式に差し替えたときの DB 障害を同一経路に載せるため）を `session.ts` の JSDoc に1行残す。`redactForClient` が `kind: "system"` の `code` を潰すのでクライアント側の表示には影響しない。

### **[S-003]** `/login` の「認証済みなら `/` へリダイレクト」が `?redirect=` を無視する

- 理由:
  ステップ17は「認証済みなら `beforeLoad` で `/` へ redirect」としているが、`?redirect=/settings` を持ったまま `/login` に到達したケース（別タブでログイン済み・戻るボタン）で元 URL が失われる。AC-9 の「ログイン後に元の URL へ戻る」の趣旨からは、`redirect` があればそちらへ送るほうが一貫する。
- 提案: ステップ17に「認証済みの場合の遷移先は `search.redirect ?? "/"`（`validateSearch` で検証済みの値）」と1行足す。

### **[S-004]** d1 に `meta/` が生成された後も D1 プールがブートすることを、ステップ7の完了条件に明示する

- 理由:
  `vitest.config.integration.ts` はトップレベルで `await readD1Migrations(packages/core/src/adapters/d1/migrations)` を実行しており、**config 読み込み時点で失敗すると D1 プールの統合テストが1件も起動しない**。計画は「`readD1Migrations` / `applyD1Migrations` は `.sql` を読むだけなので `meta/` の有無に影響されない」と断定しているが、これは本リポジトリでは未実測（`meta/` がまだ d1 に存在しないため）。断定を検証に格下げしておくほうが安全。
- 提案: ステップ7の完了条件に「`meta/` 生成後に `pnpm test:integration:cf` が（テスト内容の成否と無関係に）**起動する**ことを確認する」を1行足す。

### **[S-005]** `--name initial` をルートのネストした pnpm スクリプト経由で渡すのは脆い

- 理由:
  ルートの `db:generate:cf` は `pnpm --filter @repo/web db:generate:cf` への委譲で、`apps/web` 側が `drizzle-kit generate --config=./drizzle.config.ts`。`pnpm db:generate:cf -- --name initial` は2段の pnpm を通るため、引数が `--filter` 側のフラグとして解釈される余地がある。計画は「恒久解は journal 走査で、`--name` は併用（ファイル名の意味を保つため）」と正しく整理しているので、実行方法だけ明確にしておけばよい。
- 提案: ステップ7に「生成は `apps/web` 内で `pnpm db:generate:cf --name initial` / `pnpm db:generate:node --name initial` を直接実行する」と書く。

### **[S-006]** ステップ15の完了条件「`Skeleton` が視認できる」の確認手段を明示する

- 理由:
  ステップ3で `components/todo/TodoListSkeleton` が消えるため、ステップ15の時点で `Skeleton` を描画するのは `components/ui/RoutePendingFallback`（`router.tsx` の `defaultPendingComponent`）**だけ**になる。これは `defaultPendingMs: 200` を超えてブロックするローダーがある画面でしか出ないので、「`pnpm dev` で見る」だけでは確認できない。
- 提案: ステップ15の完了条件を「`RoutePendingFallback` を一時的にルートで直接描画するか、DevTools で背景色トークンの解決値を確認して、`Skeleton` の背景がページ背景と異なることを確かめる」と具体化する。

---

## ADR 個別所見（新規・改訂分）

| ADR | 判断 | 所見 |
|---|---|---|
| **ADR-003（改訂）** PBKDF2 + ファクトリ引数 | **妥当** | 「環境変数化しない（環境ごとに強度が揺れない）」という当初の意図を保ったままテスト注入の道を開いており、1周目の指摘の意図を正確に汲んでいる。保存形式に `iterations` を埋めているので低反復で作ったハッシュとの互換も崩れない。実測の分岐（node プールへ移す／10万へ下げる）を Decision に残したのも良い。Consequences の「呼び出し側が誤って低い値を渡す余地」への手当（本番配線は既定値を使い引数を渡さない）も現実的 |
| **ADR-008** `EMAIL_ALREADY_REGISTERED` の翻訳点 | **妥当** | 前提の記述が実コードと一致することを確認した。`mapDbError` は `constraintViolationCode` で UNIQUE と PRIMARYKEY を同じ `UNIQUE_VIOLATION` に潰し、UoW の flush 全体を包む（d1 は `db.batch`、libsql は `db.transaction`）ので `insert` 内では捕捉できない、というのは事実。`PasswordUser` の insert で `users_sso_identity_uq` が発火し得ない（`sso_provider` が NULL なので部分一意インデックスの対象外）という論拠も正しい。恒久解として挙げた `PendingBatch` のハンドラ機構（d1 の `conflictHandlers` FIFO + `firstConflictHandler()`、libsql の `handlerRef`）も実在する。spec/inventory との乖離を spec-sync 対象として明示している点も含めて、記録として十分 |
| **ADR-009** 純読み取り UoW | **妥当** | `libsql/unitOfWork.ts` の `if (pending.isEmpty()) { /* Pure-read UoW: skip the transaction. */ return result; }` と、d1 版の同等分岐（「D1 rejects empty batches」）を実コードで確認。spec の「UoW 不要」＝「トランザクションを張らない」という読み替えは事実に裏付けられている。`RequestContainer` にドメインポートを増やす圧力を作らないという理由付けも `di/types.ts` の JSDoc の意図と一致する |
| **ADR-001（改訂）** | **妥当** | d1 に `meta/` が生える副作用と `libsql/__tests__/helpers.ts` の journal 走査書き換えが Consequences に入った。drizzle 生成形の `_occ_guard` CHECK（`CHECK("_occ_guard"."n" > 0)`）が SQLite で有効かつ制約名 `occ_guard_positive` がエラーメッセージに出ることを実測したので、再生成が `isOccGuardViolation`（制約名の部分一致で判定）を壊さないことも確認済み |
| **ADR-002（改訂）** | **妥当** | `secrets` へのネストと「`RequestContainer` に載せない」の追記で、1周目 P-001 の構造的な穴が塞がった。`sessionCodec.ts` の JSDoc で「presentation 専用・ユースケースから参照しない」を固定する判断も、`RequestContainer` が usecase に渡る以上必要 |
| **ADR-005（改訂）** | **妥当** | 「`beforeLoad` は先回りリダイレクトでセキュリティ境界ではない／権威は各サーバー実行地点の `requireUserId()`」という整理が plan.md と同一表現で入り、1周目の二重経路の曖昧さが消えた。`sessionCookie.ts` / `session.ts` の分離もテスト可能性の観点から正しい |
| **ADR-007（改訂）** | **妥当** | 「リンク先が実在し状態を正直に伝えるもの」と「押しても何も起きないコントロール」を分ける基準が入り、SSO ボタン非描画との内部矛盾が解消した |

**ADR 間の矛盾は見当たらない。** ADR-002（`SessionCodec` を `application/ports/` に置くが presentation 専用）と ADR-005（ヘルパーは `apps/web/app/presentation/`）、ADR-008（翻訳をユースケース境界へ）と CLAUDE.md の「adapter → application」原則の緊張は、いずれも理由と移行経路が明示されているので設計判断として成立している。

## レイヤー分離・キーコンセプトへの適合

- **依存方向**: `SessionCodec` を `application/ports/` に置く（presentation → application は順方向）、認証ヘルパーを `packages/core` ではなく `apps/web/app/presentation/` に置く（core の framework-free を守る）、`ValidationError` を application に置き presentation が import する — いずれも内向き依存を崩していない。
- **UoW**: 書き込みは `unitOfWorkProvider.run` 内、イベントは `collectEvents` 経由。`registerWithPassword` の hash を UoW 外に出すのは spec の処理フローどおりで、`passwordHasher` を `RequestContainer` に載せる例外は JSDoc で理由付きに固定される。
- **outbox / domain events**: `AllDomainEvents` / `defaultEventDecoderRegistry` の網羅性を identity の3イベントで埋め直す。共通基盤（outbox / processed_events / `_occ_guard`）はテンプレート流儀のまま維持し、統合テストは `users` へ移植する。
- **リトライ戦略**: アプリケーション層に OCC リトライを足していない。ADR-008 の catch は「レース検出という明示された境界」に限定されている。
- **入力バリデーション2点主義**: `auth/schema.ts` は shape / DoS（1024）のみ、長さ判定は `Email` / `PlainPassword` に一本化。`?redirect=` は `validateSearch`（catch 付き）と server fn（strict）の二重スキーマ。`serverData` に外部入力を通す設計は無い。
- **クロスレイヤー catch ポリシー**: broad catch は (1) `registerWithPassword` のレース検出、(2) `session.ts` のヘッダー書き込み、(3) worker の per-row の3箇所だけで、いずれも境界と理由が明記されている。

## 良い点

- **1周目の指摘に対して「宣言だけ足す」対応をしていない。** P-001 は「除外リストに1語足す」ではなく `secrets` へのネストという構造的な封じ方に、P-004 は ADR 本体の Decision 書き換えに、P-005 は ADR-008 の新設に昇格している。取り込まなかった2件（P-005 推奨案(a) / S-007 第1案）も、理由が「検証できるテストが書けない」「自動検証できるのでカバレッジを落とす必要がない」と具体的で、判断の質が高い。
- **1周目の提案をそのまま呑まず、実装上の制約で修正している。** P-007 の「todo 削除を全部前倒しせよ」に対し、「スキーマ／マイグレーション／`d1/__tests__/setup.ts` の3点セットだけはステップ7で一括差し替え（先に `todos` を消すとグローバル `setupFiles` が D1 プールを全滅させる）」と分割したのは、レビューより計画側のほうが正しい。
- **波及ファイルの調査が実コードに届いている。** `grep` で追い直した結果、todo への import 参照の取りこぼしはゼロだった。レビューに挙がっていなかった `application/workers/__tests__/eventRelayWorker.integration.test.ts` と `apps/web/app/worker/{cloudflare,node}/__tests__/` を自力で追加している点も含めて、調査の網羅性は高い。
- **「型で守れないもの」を正直に扱っている。** `PlainPassword` の漏出防止をテストで縛る、マイグレーション2セットの内容は目視が唯一の関門、`Skeleton` の不可視化はクラス名が解決するので型・ビルドエラーにならない — いずれも「型検査を通ったから安全」という誤った安心を作らない書き方になっている。
- **ADR-008 / ADR-009 が「spec の字面と実装が食い違う理由」の記録として機能している。** どちらも spec-sync 対象と明示されており、後続のレビューや監査で「spec 違反」と誤検出されない形になっている。ADR-008 は恒久解の移行経路（`PendingBatch` の per-statement ハンドラ）まで書いてあるので、SSO スライスの着手コストが下がる。
- **デザイン成果物との整合を実体で取っている。** `spec/design/index.md` の基準形表が共通シェルを「ヘッダー・サイドバー・ボトムシートナビ」と定義していることと、AC-14 の実装形（ヘッダーメニュー → 下部シート）が一致する。spec/pages の「下部タブ相当」との表現差を spec-sync 対象として残す判断も正しい。
- **チェックリスト75/75 の維持とステップ番号の追随が破綻していない。** 24ステップへの組み替え後も対応表・付随実装表・カバレッジ注記の3つが整合しており、ID 単位で追跡できる状態が保たれている。
