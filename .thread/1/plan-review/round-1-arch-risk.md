# レビュー round-1 — アーキテクチャ整合性・実現可能性・リスク

**対象:** `.thread/1/plan.md` / `.thread/1/adr.md`（Issue #1 [skeleton] 基盤＋アカウント登録・ログイン）
**視点:** プロジェクトのあるべきアーキテクチャとの整合性・実現可能性・リスク
**日付:** 2026-07-25

## 調査範囲

`CLAUDE.md` / `docs/{backend,frontend}_implementation_example.md` / `docs/test.md`、`spec/{requirements,scenario/account,pages/index,domains/identity,usecases/identity,database/index,manual-tests/account,inventory/*}.md`、および既存実装（`packages/core/src/{domain,application,adapters,lib}/**`、`apps/web/app/**`、`vitest.config*.ts`、`apps/web/drizzle*.config.ts`、`apps/web/package.json`、`packages/core/src/adapters/{d1,libsql}/migrations/**`、4本の DI ファクトリ、`__root.tsx` / `router.tsx`、テストハーネス一式）を実地確認した。

## 総評

計画の**設計品質は高い**。ドメイン → ユースケース → アダプター → presentation の責務分界は spec と CLAUDE.md にほぼ正確に沿っており、テンプレートの規約（ブランド VO・`WithEventDrafts`・`ExpectedVersion` の唯一のキャスト地点・UoW 経由の書き込み・イベントデコーダの `satisfies` 網羅性・`__root.tsx` の副作用 import）を漏れなく拾えている。特に「transport スキーマにパスワード最低長を書かない」「UoW flush 時にしか UNIQUE 違反が出ない」「`AppConfig` はクライアントへ渡る」の3点は、実装に入ってから初めて気づく類の罠を事前に潰しており、調査の質が高い。

一方で**実行可能性の面に、実際に手を動かすと確実に止まる箇所が複数残っている**。とくに (a) DI ファクトリの rest-spread による秘密鍵漏洩の構造、(b) todo 削除の波及ファイルの取りこぼし（`d1/__tests__/setup.ts`）、(c) マイグレーション再生成とテストハーネスのファイル名固定参照、(d) PBKDF2 210,000 回が**統合テストの実行環境そのもの**（Miniflare/workerd）で走るという事実、の4点は着手前に計画へ反映すべき。

---

## 問題点（要修正）

### **[P-001]** `SESSION_SECRET` は「`AppConfig` に入れない」だけでは漏れる — 4本の DI ファクトリの rest-spread が構造的な漏洩経路になっている

- 理由:
  4つの `createXxxRequestContainer` はいずれも次の形をしている（`packages/core/src/application/di/serverNode.ts:111-125`、Cloudflare / Aws / Gcp も同型）。

  ```ts
  export function createNodeRequestContainer(config: NodeRequestServerConfig): RequestContainer {
    const { db: _db, relayTrigger: _relayTrigger, ...appConfig } = config;
    return { ...buildSharedDeps(), config: appConfig satisfies AppConfig, ... };
  }
  ```

  `NodeRequestServerConfig = AppConfig & { db, relayTrigger }` に `sessionSecret` を足すと、**明示的に除外しない限り rest-spread で `appConfig` に入り、そのまま `container.config` になる**。`appConfig satisfies AppConfig` は変数に対する `satisfies` なので余剰プロパティ検査が効かず、**型エラーにならない**。そして `apps/web/app/routes/__root.tsx` の `loadAppContext` は `{ config: container.config }` をそのままクライアントへ返し、本番では `staleTime: Number.POSITIVE_INFINITY` でキャッシュされる。つまり「`AppConfig` に入れない」という原則を守ったつもりでも、`RequestServerConfig` に足した瞬間に HTML ペイロードへ乗る。plan.md はリスク節で原則を書いているが（L632）、この**具体的な機構**には触れていない。

- 提案:
  - ステップ11の変更内容に「4本すべてで `const { db: _db, relayTrigger: _relayTrigger, sessionSecret: _sessionSecret, ...appConfig } = config;` と明示除外する」を書く。
  - さらに構造的な防御として、`config` に混ぜず **`readXxxRequestServerConfig` の戻り値とは別引数**（`createNodeRequestContainer(config, { sessionSecret })`）にする、あるいは `RequestServerConfig` を `AppConfig & { db; relayTrigger; secrets: { sessionSecret: string } }` のようにネストして rest-spread の巻き込みを不可能にすることを検討する。後者なら将来の秘密追加でも同じ事故が起きない。
  - `loadAppContext` が返す値の型に対する回帰テスト（`config` のキー集合を表明する）をステップ22に1件足すと恒久的に守れる。

### **[P-002]** todo 削除の波及ファイル一覧に `d1/__tests__/setup.ts` が抜けている — D1 統合テストが**全滅**する

- 理由:
  `packages/core/src/adapters/d1/__tests__/setup.ts` は `vitest.config.integration.ts` の**グローバル `setupFiles`** であり、`beforeEach` で無条件に

  ```ts
  await env.DB.batch([
    env.DB.prepare("DELETE FROM todos"),
    env.DB.prepare("DELETE FROM outbox_events"),
    env.DB.prepare("DELETE FROM processed_events"),
  ]);
  ```

  を実行する。`todos` テーブルが消えた瞬間、**D1 プールで走る全統合テストファイル**（`application/identity/__tests__/*.integration.test.ts` を含む）が `no such table: todos` で `beforeEach` に失敗する。plan.md ステップ12の対象ファイル一覧（L437）にこのファイルが無い。

  同じく一覧から漏れているもの:
  - `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts` — `todos` を **UNIQUE / PRIMARYKEY 衝突のフィクスチャ**として使い、`mapDbError` の制約分類（`SQLITE_CONSTRAINT_UNIQUE` → `ConflictError("UNIQUE_VIOLATION")`）を検証している唯一のテスト。P-005 の設計判断が依存する挙動なので、`users` へ移植する価値が高い
  - `packages/core/src/adapters/{d1,libsql}/__tests__/outboxRepository.integration.test.ts` — 変更内容の文章には「`outboxRepository` の統合テストは `users` を対象に書き換え」とあるが（L438）、対象ファイル一覧には入っていない
  - `packages/core/src/adapters/d1/__tests__/helpers.ts` — D1 側の `TestContainer`。`application/__tests__/helpers.ts` と `libsql/__tests__/helpers.ts` は挙げられているがこれだけ漏れている

- 提案:
  ステップ12の対象ファイルに上記4つ（`setup.ts` / `helpers.integration.test.ts` / d1・libsql の `outboxRepository.integration.test.ts` / `d1/__tests__/helpers.ts`）を追加し、`setup.ts` の `DELETE FROM todos` を `DELETE FROM users` に置き換えることを明記する。`_occ_guard` の `afterEach` 表明はそのまま維持する（共通基盤の検証の核なので消さない）。

### **[P-003]** マイグレーション再生成の実務が計画に落ちていない — ファイル名固定参照が壊れ、d1 側は `meta/` が存在しない

- 理由:
  2つの事実が計画の前提と食い違う。

  1. **`packages/core/src/adapters/libsql/__tests__/helpers.ts` は `0000_initial.sql` をパスで固定参照している。**

     ```ts
     const MIGRATION_PATH = path.resolve(import.meta.dirname, "../migrations/0000_initial.sql");
     ```

     `drizzle-kit generate` は `--name` を渡さないとランダムな名前（`0000_furry_wolverine.sql` 等）を付ける。plan.md ステップ7は「破棄して再生成する」としか書いておらず、この固定参照が壊れることに触れていない。libsql 統合テスト（`userRepository` / `unitOfWork` / `occGuard` / `outboxRepository`）が全部落ちる。

  2. **d1 の migrations ディレクトリには `meta/` が無く、`0000_initial.sql` は手書きである。**（コメント入り・`--> statement-breakpoint` 無し・libsql 版と文の順序が違う）。libsql 側にだけ `meta/_journal.json` と `0000_snapshot.json` がある（`drizzle-orm/libsql/migrator` が journal を要求するため）。したがって `pnpm db:generate:cf` を回すと d1 側に**新規に `meta/` が生成され**、以後は手書き運用ではなく drizzle 管理に切り替わる。これは妥当な選択だが、意図した変更として計画に書いておかないと「なぜ meta/ が生えたのか」がレビューで問題になる。

  加えて確認しておくべき生成物の妥当性:
  - `users` の直和 CHECK をテーブル制約1本で出す（`check("...", sql\`...\`)` で drizzle が `CONSTRAINT name CHECK(...)` を吐く）
  - 部分一意インデックス `uniqueIndex(...).where(sql\`sso_provider IS NOT NULL\`)` が `CREATE UNIQUE INDEX ... WHERE ...` として出る
  - `sso_provider_subject` の `length(...) > 0` CHECK（spec/database/index.md#users が要求）が計画のスキーマ定義に**書かれていない**（plan.md L252 はコメントのみ）

- 提案:
  - ステップ7に「`drizzle-kit generate --name initial` で名前を固定する」か「`libsql/__tests__/helpers.ts` を journal 走査（`meta/_journal.json` を読んで全 SQL を順に適用）に書き換える」のどちらかを明記する。後者のほうが将来 `0001_*` を積んだときに壊れないので推奨。
  - 「d1 側に `meta/` が生成され、以後 drizzle 管理になる」ことを ADR-001 の Consequences に1行追加する。
  - `sso_provider_subject` の非空 CHECK を schema.ts の定義に明示する（直和 CHECK に `AND length(sso_provider_subject) > 0` を畳み込むか、別 CHECK にするか）。
  - 生成後に `git diff` で d1 / libsql 両方の SQL を目視確認する手順をステップ7の完了条件に入れる（ADR-004 が言うとおり型検査では検出できない）。

### **[P-004]** PBKDF2 210,000 回は「CF 本番採用時の課題」ではなく、**本 Issue の統合テストが走る環境そのもの**の課題

- 理由:
  `vitest.config.integration.ts` の include は `packages/**/*.integration.test.ts`、exclude は libsql / node アダプターのみ。つまり計画が新設する `packages/core/src/application/identity/__tests__/identity.integration.test.ts` は **Miniflare（workerd）プールで走る**。ここで `registerWithPassword` / `loginWithPassword` が実 `PasswordHasher` を叩くと、210,000 回の PBKDF2 が workerd 上で実行される。

  2つの懸念がある。
  - workerd の WebCrypto は PBKDF2 の反復回数に上限（10万回程度）を課しているという報告がある。事実なら `deriveBits` が例外になり、TC-registerWithPassword-001 系・TC-loginWithPassword-001 系が**一件も通らない**。
  - 上限に抵触しなくても、登録・ログインを含む統合テストは20件超あり、1件あたり複数回ハッシュ計算が走る。CPU 時間で数十秒〜分単位の遅延になる可能性が高い。

  ADR-003 は「主ターゲットは Node のため本 Issue では問題にしない」（L122）としているが、**テスト実行環境が workerd である**以上この前提は成立しない。また ADR-003 は「反復回数は環境変数化せず定数とする」と決めているため、素直に読むとテスト側で下げる逃げ道が塞がれている。

- 提案:
  - **着手前に最小の実測を行う**: workerd プールで `crypto.subtle.deriveBits({ name: "PBKDF2", iterations: 210000, ... })` を1回だけ叩く捨てテストを書き、成功可否と所要時間を測る。これはステップ9より前に置ける独立作業。
  - 反復回数は**環境変数ではなくファクトリ引数**にする: `createPbkdf2PasswordHasher({ iterations = 210_000 })`。ADR-003 の意図（環境ごとに強度が変わらない・ハッシュ形式に反復回数を埋め込む）は保たれたまま、テストだけ低い値を注入できる。保存形式に `iterations` が入っているので verify の互換性も壊れない。ADR-003 の「環境変数化しない」の一文をこの形に更新する。
  - 実測の結果 workerd で動かない場合の分岐（identity の統合テストだけ node プールへ移す／反復回数を10万に下げる）を ADR-003 に代替案として残しておく。

### **[P-005]** `SSO_IDENTITY_ALREADY_REGISTERED` へのマッピングが計画に無く、ユースケース側での `UNIQUE_VIOLATION` 一括読み替えは制約の区別を**原理的に不可能**にする

- 理由:
  Issue のチェックリストに含まれる `DOM-identity-018` / `ADP-identity-001` は、いずれも **「email / (provider, providerSubject) の一意制約違反を `EMAIL_ALREADY_REGISTERED` / `SSO_IDENTITY_ALREADY_REGISTERED` にマップする」** と定義されている（`spec/inventory/{domain,adapter}.md`）。plan.md は前者だけを扱い、後者に一切言及していない。SSO 登録ユースケースを配線しない本スライスでは後者の制約は発火しないので実害は無いが、**チェックリスト項目の完了条件を満たしていない**状態で「75/75 カバレッジ・未カバーなし」と主張しているのは正確でない。

  より本質的なのは設計の含意のほうで、plan.md L273 の方針——`registerWithPassword` 側で `unitOfWorkProvider.run(...)` を catch し `isConflictError(e) && e.code === "UNIQUE_VIOLATION"` を `EMAIL_ALREADY_REGISTERED` に読み替える——は、次の理由で拡張性が無い。

  - `mapDbError` は制約名を捨てて `UNIQUE_VIOLATION` に潰す（`constraintViolationCode` は `SQLITE_CONSTRAINT_UNIQUE` と `SQLITE_CONSTRAINT_PRIMARYKEY` を同じコードにする）。よって**どの制約が発火したかを呼び出し側で復元する手段が無い**。SSO スライスが来た時点で `registerOrLoginWithSso` も同じ catch を書くことになるが、そこでは email 制約と sso_identity 制約を区別する必要があり、この方式では対応できず設計をやり直すことになる。
  - 同じ UoW の flush には **outbox の INSERT も含まれる**（`LibsqlOutboxRepository` / D1 版とも `PendingBatch` を共有）。EventId の PK 衝突（UUIDv7 なので実質起きないが）も `UNIQUE_VIOLATION` になり `EMAIL_ALREADY_REGISTERED` に化ける。
  - `spec/inventory/adapter.md` の `ADP-identity-001` は明確に**アダプターの責務**として翻訳を定義している。CLAUDE.md の「adapter → application: adapters catch driver-specific errors and translate them into the shared error contracts」とも一致する。ユースケースへの移設は spec からの逸脱であり、少なくとも ADR として明示的に記録すべき判断。

- 提案（どちらかを選ぶ）:
  - **(a) アダプター側に戻す（推奨）**: `PendingBatch` は既に per-statement のハンドラ機構を持っている（d1 は `conflictHandlers` の FIFO、libsql は `stmt.kind === "occ"` + `handlerRef`）。ここに OCC 以外の「制約違反ハンドラ」を1種類足し、`UserRepository.insert` が `pending.add(query, { onUniqueViolation: () => { throw new ConflictError("EMAIL_ALREADY_REGISTERED", ...) } })` を登録できるようにする。D1 は最初の失敗文で止まるので FIFO の先頭ハンドラ、libsql は直前ハンドラという既存の割り当てロジックがそのまま使える。翻訳がアダプターに残り、SSO スライスでは同じ `insert` に2つ目のハンドラを足すだけで済む。
  - **(b) 現方針を維持するなら**、(1) SSO 制約の翻訳を本スライスで扱わないことを plan.md の「含まれないもの」に明記し、`DOM-identity-018` / `ADP-identity-001` を「部分実装（email 側のみ）」としてチェックリスト対応表に書く、(2) 読み替えの catch を「`findByEmail` 事前検証を通過した後にのみ有効」なスコープに限定する（`insert` 直後の flush だけを包むのは構造上できないので、少なくとも JSDoc でこの前提を書く）、(3) ADR を1本足してアダプター責務からの移設理由（flush 時にしか発火しない）を正式な設計判断として残す、の3点を行う。

### **[P-006]** `apps/web` 側の単体テスト基盤が未検証のまま TC-logout-002/003 のカバレッジ主張の土台になっている

- 理由:
  ステップ22は `apps/web/app/presentation/__tests__/session.test.ts` を新設し、TC-logout-002 を「`buildSessionCookie(null)` が失効 Cookie を返すこと」で担保するとしている。しかし:

  - ルートの `vitest.config.ts` は `include` を持たず（デフォルトの `**/*.test.ts`）、`environment: "node"`、`resolve: { tsconfigPaths: true }`。現在 `apps/web` 配下に**非 integration の単体テストは1件も存在しない**ため、これが最初の1件になる。ルート `tsconfig.json` は `include: ["*.ts"]` で `paths` を持たず、`@/*` エイリアスは `apps/web/tsconfig.json` にしかない。ルートから起動した Vitest がファイルごとに最寄りの tsconfig を拾ってエイリアス解決できるかは**未検証**。
  - `presentation/session.ts` はファイル先頭に `import "@tanstack/react-start/server-only";` を置く設計（ADR-005 / plan L308）。これを node 環境の Vitest から import したときの挙動も未検証。
  - `docs/test.md` はフロントについて「the bare minimum」としか書いておらず、jsdom / RTL も入っていない。

  この不確実性のうえに「カバレッジ 75/75・未カバーなし」（L611）が乗っている。

- 提案:
  - **純関数を server-only を持たない別モジュールへ分離する**: `apps/web/app/presentation/cookie.ts`（`buildSessionCookie` / `SESSION_COOKIE_NAME` のみ、フレームワーク import なし）と `apps/web/app/presentation/session.ts`（`server-only` + `startSession` / `endSession` / `readSessionToken`）に割る。テスト対象は前者だけになり、`@tanstack/react-start/server-only` の import 可否問題が消える。CLAUDE.md の「presentation は TanStack Start 固有の横断ユーティリティ」にも反しない。
  - ステップ22の前に「`apps/web` 配下に単体テストを1件置いて `pnpm test:unit` が拾えることを確認する」という**5分の検証タスク**を独立させる。拾えない場合の代替（`vitest.config.ts` に `apps/web` を含む projects/alias を足す）を計画に書いておく。

### **[P-007]** 実装ステップの中間状態が型検査を通らない — todo 削除（ステップ12）が遅すぎる

- 理由:
  ステップは「依存方向の順（内側 → 外側）」で並べられているが、本 Issue は新規追加ではなく**置換**なので、この順序では中間状態が常に壊れる。具体的には:

  - ステップ5で `UnitOfWorkContext` の `todoRepository` を削除した瞬間、`adapters/{d1,libsql}/unitOfWork.ts` が両方コンパイルエラー（`todoRepository` を無条件に構築している）。復旧はステップ8。
  - ステップ7で `d1/schema.ts` から `todos` を消した瞬間、`{d1,libsql}/repositories/todoRepository.ts` と `application/todo/listTodos.ts` がエラー。復旧はステップ12。
  - `AllDomainEvents` / `defaultEventDecoderRegistry` は `satisfies` で網羅性が強制されるので、ステップ10まで `TodoEvent` と `IdentityEvent` の整合が取れない。

  ステップ間で `pnpm typecheck` を回して進捗を確認する運用（AC-17 が全ステップに紐づいている）と矛盾する。

- 提案:
  ステップ12（todo 一式の削除）を**ステップ2の直前**に前倒しする。順序は「1. アプリケーション層のエラー契約 → 2. todo 一式の削除（`UnitOfWorkContext` / UoW 実装 / スキーマ / イベントレジストリ / ルート / `__root.tsx` を含む一時的な空状態まで一気に）→ 3. identity ドメイン → …」。共通基盤統合テストの `users` への移植だけはスキーマとリポジトリが要るのでステップ8以降に残す（「削除」と「移植」を2つのステップに割る）。こうすれば `identity` を足していく過程で毎ステップ型検査が通る。

---

## 改善提案（検討推奨）

### **[S-001]** `PasswordHasher` を `RequestContainer` に載せることは、既存の「ドメインポートは UoW 経由でのみ触れる」という不変条件を破る — 意図的な例外として JSDoc に残す

- 理由:
  現行の `RequestContainer` は `SharedDeps`（clock / idGenerator / logger — いずれもアプリケーション層のポート）+ `config` + `unitOfWorkProvider` だけで、**ドメインポート（`TodoRepository`）は `UnitOfWorkContext` からしか取れない**構造になっている。その意図は `types.ts` の JSDoc に明示されている。`PasswordHasher` はドメインポートだがトランザクション対象でなく（かつ UoW 外で実行することを spec が要求している）、`UnitOfWorkContext` には置けない。したがって `RequestContainer` へ載せる判断は spec/usecases/identity.md（`container.passwordHasher`）とも整合し正しいが、**既存の不変条件の例外**であることは記録が必要。

- 提案: ステップ6の変更内容に「`RequestContainer` の JSDoc を更新し、`passwordHasher` が UoW を経由しないドメインポートである理由（非トランザクショナル・UoW 外実行が spec 要件）を明記する」を追加する。

### **[S-002]** `SessionCodec` の `application/ports/` 配置は妥当だが、「アプリケーション層の誰も使わないポート」になる — 規約を JSDoc で固定する

- 理由:
  依存方向として `application/ports/` は正しい（presentation → application は許される向き。逆に presentation に定義すると DI が core にあるため参照できない）。ただし `clock` / `idGenerator` / `logger` と違い、**アプリケーション層のどのユースケースもこのポートを使わない**。放置すると後続スライスで「セッションを触るユースケース」が生まれて `spec/usecases/identity.md` の責務分界（セッションは presentation）が崩れる余地がある。

- 提案: `sessionCodec.ts` の library-level JSDoc に「このポートは presentation 層専用である。ユースケースから参照してはならない。セッションの生成・破棄・Cookie 管理は presentation の責務（spec/domains/identity.md「スコープに関する注意」）」と明記する。ADR-002 の Decision にも1行足す。

### **[S-003]** `spec/manual-tests/account.md` TC-01 は「SSO ボタンが表示されている」ことを確認項目に含む — SSO ボタン非描画の判断と正面衝突する

- 理由:
  TC-01 の確認ポイントは「メールアドレス欄・パスワード欄・**SSOボタン**・「アカウント登録」への導線・「パスワードをお忘れですか？」の導線が表示されている」。plan.md はスコープ節（L41）で「SSO ボタン自体を描画しない」と決めており、その判断自体は `PAGE-login-003` がチェックリスト外である以上正しい。しかし**ステップ23の手動確認リストに TC-01 が入っている**ため、計画どおりに実装すると自分の検証手順を1つ落とす。

- 理由の補足: TC-05 / TC-06 / TC-12〜16 / TC-19 / TC-20 / TC-22 / TC-23 は**すべて設定画面（P-13）のログアウトを手順に含む**（例: TC-12 手順1「ログイン中の場合は設定画面（P-13）からログアウトする」）。ステップ20で `/settings` のログアウトを実装する判断はこの意味でも正しい。TC-22 は「元のアクセス先である**設定画面**へ戻る」ことを確認するので、`?redirect=/settings` が実際に動く必要がある。

- 提案: ステップ23に「TC-01 の SSO ボタン表示の確認項目は本スライスでは対象外（SSO は後続スライス）」と明記する。PR 説明にも同じ注記を入れる。

### **[S-004]** `errorDisplay.ts` の `validation` 分岐は `code` を見ていない — `renderValidationMessage(code)` の追加が必要

- 理由:
  現行の `renderErrorMessage` は `kind: "validation"` のとき `fieldErrors` があればそれを整形し、無ければ `error.message` をそのまま返す（`apps/web/app/presentation/errorDisplay.ts:43-49`）。`ValidationError("INVALID_CREDENTIALS")` はフィールドを持たないので、アプリケーション層が付けた生メッセージが UI に出る。plan.md は「`errorDisplay.ts` に `INVALID_CREDENTIALS` の文言を追加」と書いているが、追加先の構造が無い。また `EMAIL_ALREADY_REGISTERED` は `kind: "conflict"` なので `renderConflictMessage` 側の追加になる（現状は default に落ちて「他の操作と競合しました」と表示される）。

- 提案: ステップ16/17の変更内容を「`renderConflictMessage` に `EMAIL_ALREADY_REGISTERED` を追加し、`renderValidationMessage(code)` を `renderConflictMessage` と同型で新設して `validation` 分岐から呼ぶ」と具体化する。`fieldErrors` がある場合は従来どおりフィールド整形を優先する。

### **[S-005]** デザイントークン差し替えは「壊れないか確認する」では足りない — `Skeleton` は**不可視**になり、`theme.css` は未定義参照になる

- 理由:
  実地確認した具体的な事実:
  - `apps/web/app/components/ui/Skeleton/index.tsx` は `bg-neutral-200` を使う。`spec/design/tokens.md` の `--color-neutral-200` は `--color-bg-page` と**同一値**なので、差し替え後はスケルトンがページ背景に完全に溶けて見えなくなる（クラス名は解決するので型エラーにもビルドエラーにもならない）。
  - `apps/web/app/styles/theme.css` は `--color-neutral-{150,250,350,450,550,650,750,850}` を `@theme` にマップしているが、spec のトークンには**半段階が存在しない**。`tokens.css` だけ差し替えると8個の未定義参照が残る。
  - `RoutePendingFallback` / `TodoListSkeleton` はレイアウトユーティリティのみで、リスクは `Skeleton` 経由のみ。
  - `text-red-500` が `CreateTodoForm` / `TodoBoard` にある（削除対象だが、新規フォームがコピー元にするとトークン外の生値が持ち込まれる）。

- 提案: ステップ14の変更内容に「`theme.css` は `tokens.css` と lockstep で全面書き直し（半段階 neutral の削除、spec が追加する `--color-*-dark` / `--color-*-bg` / `--pad-*` / `--icon-*` / `--content-max` 等の露出）」「`Skeleton` の背景を `--color-neutral-300` 相当へ変更」を明記する。新規フォームでは `text-red-500` ではなく `--color-error` 由来のクラスを使うこともステップ15に書く。

### **[S-006]** `routeTree.gen.ts` の再生成手順がステップ化されていない — ステップ23の `pnpm typecheck` が stale なルートツリーで落ちる

- 理由:
  ルートの増減（`routes/index.tsx` 削除、`login` / `signup` / `password-reset` / `_app` 系の追加、`routes/todo/` 削除）は `apps/web/app/routeTree.gen.ts` に反映されないと型が合わない。生成は TanStack Router の Vite プラグイン経由なので、`pnpm typecheck` 単体では走らない。plan.md はリスク節で「`routeTree.gen.ts` の再生成…は実行時にしか出ない」と触れているが（L627）、手順としてはどこにも無い。

- 提案: ステップ21（ルート・起動導線の仕上げ）に「`pnpm dev`（または `pnpm build`）を1度回して `routeTree.gen.ts` を再生成し、差分をコミットする」を追加し、ステップ23の品質ゲートを「routeTree 再生成 → `pnpm typecheck` → …」の順に書く。

### **[S-007]** TC-logout-003（セッション破棄失敗 → `SystemError`）の再現手段が定義されていない

- 理由:
  ステップ22は「`endSession` 内の throw が `SystemError` になること」を単体テストで担保するとしているが、`endSession` は `Set-Cookie` ヘッダーを組み立てるだけで**失敗しようがない**。何を「破棄失敗」と見なすか（`getContainer()` が取れない／レスポンスヘッダー設定 API が throw する／将来テーブル方式に差し替えたときの DB 障害）が未定義のまま、`SystemError` への変換責務だけが宣言されている。また presentation から `SystemError`（アプリケーション層のエラー）を throw する形になるので、CLAUDE.md のエラー階層上どこが投げ主体かを決めておく必要がある。

- 提案: 「本スライスのステートレス Cookie 方式では `endSession` は失敗しない。TC-logout-003 は『失敗経路が存在しないため N/A（テーブル方式へ差し替えた時点で有効化）』として plan.md に記録し、カバレッジ表を 74/75 + 1件 N/A に改める」か、「`endSession` を `try/catch` で包み未知の例外を `SystemError(SystemErrorCode.DatabaseError)` に翻訳する箇所を明示して、その関数に fault injection 可能な引数を持たせる」のいずれかを選ぶ。前者のほうが正直で、後者は CLAUDE.md の「broad catch は境界のみ」に照らすとやや過剰。

### **[S-008]** 認証ガードが `_app.tsx` の `beforeLoad`（server fn）と `requireUserId()` ヘルパーの二重経路になる — どちらが権威かを決める

- 理由:
  - `docs/frontend_implementation_example.md` は明確にヘルパー方式（`await requireCurrentUser()` をサーバーコンポーネント／server fn から呼ぶ）を推しており、`beforeLoad` によるガードはドキュメントにもリポジトリにも前例が無い（既存の `beforeLoad` は `__root.tsx` の `loadAppContext` のみ）。ADR-005 は「保護ルートのガードは `routes/_app.tsx` の `beforeLoad` に集約する」としつつ「認証方式は `createMiddleware` ではなくヘルパー方式を採る」とも書いており、2つの決定が並立している。
  - `beforeLoad` はクライアントサイドナビゲーションでは**ブラウザで走る**ため、遷移ごとに認証確認の server fn 往復が入る。UX 上のコストであると同時に、これは**セキュリティ境界ではない**（実データ取得は必ずサーバー側で `requireUserId()` を通す必要がある）。
  - `spec/manual-tests/account.md` TC-23 は「ログアウト後、ブラウザの戻るボタンで保護画面が操作可能な状態に復元されないこと」を確認する。TanStack Router のルーターキャッシュ（`staleTime`）と bfcache の扱いを設計しておかないとここで落ちる。

- 提案:
  - plan.md の「UI / プレゼンテーション」節に「`beforeLoad` はナビゲーション体験のための先回りリダイレクトであり、権威あるガードは各サーバー実行地点の `requireUserId()` である」という一文を足す。ADR-005 の Decision も同じ表現に揃える。
  - `_app.tsx` に `staleTime: 0`（またはログアウト時の `router.invalidate()` + `router.navigate({ to: "/login", replace: true })`）を置き、TC-23 の戻るボタン挙動を確認項目としてステップ20に明記する。

### **[S-009]** Issue 本文のシナリオ ID と `spec/scenario/account.md` の ID がズレている — SSO をスコープ外とする根拠として明記しておく

- 理由:
  Issue 本文は対象シナリオを「S-AC-01 アカウント登録」「**S-AC-02** ログイン / ログアウト」としているが、`spec/scenario/account.md` の実体は S-AC-02 = **SSO 登録・ログイン**、S-AC-03 = パスワードログイン、S-AC-04 = ログアウト。plan.md は AC-9 / AC-15 で正しく S-AC-03 / S-AC-04 を参照しており解釈は妥当だが、その読み替えを明示していない。SSO をスコープ外にする判断の根拠が「チェックリストに PAGE-login-003 が無い」だけになっており、Issue 本文の字面（S-AC-02）と衝突して見える。

- 提案: plan.md の「スコープ」節に「Issue 本文の『S-AC-02』は spec/scenario/account.md では SSO を指す。チェックリスト（PAGE-login-003 / PAGE-signup-003 / UC-identity-002 が不在）から、本スライスの対象は S-AC-01 / S-AC-03 / S-AC-04 と解釈する」を1行足す。

### **[S-010]** `spec/inventory/frontend.md` には保護 URL リダイレクトの ID が存在しない — チェックリスト由来の受け入れ基準だけでは AC-9 が落ちる

- 理由:
  `spec/pages/index.md` の共通レイアウトにある「未ログインで保護画面にアクセスした場合はログイン画面へリダイレクトし、ログイン後に元のURLへ戻る」には**インベントリ ID が振られていない**（`PAGE-common-001` はグローバルナビのみ）。したがって Issue のチェックリスト75行にはこの要件が現れない。plan.md は AC-9 として独自に受け入れ基準へ引き上げており**これは正しい判断**だが、由来欄が「Issue チェックリスト・spec/scenario/account.md」となっていて、インベントリの欠落であることが分からない。

- 提案: AC-9 の由来を「spec/pages/index.md 共通レイアウト（インベントリ ID 未採番）」と正し、`spec/inventory/frontend.md` へ ID を追加する作業を別 Issue / spec-sync の対象として plan.md に1行残す。同様に「通信エラーは共通のエラー表示（リトライ導線付き）で扱う」も ID 未採番で、本スライスでは扱わない旨を明記しておくと後続で拾える。

### **[S-011]** `outbox` / `outbox_events` の名称差、`wrangler` の D1 データベース名など「テンプレート残滓」の扱いを1箇所にまとめる

- 理由:
  - plan.md は outbox 実名の差（spec は `outbox`、実装は `outbox_events`）を正しく「spec 側の記述揺れ」と判断しているが、判断の記録先が plan.md の注意書きだけになっている。
  - `apps/web/wrangler.toml` / `.staging.toml.tpl` / `.production.toml.tpl` の D1 データベース名は `tanstack-start-template-d1*` のままで、`db:migrate:cf` / `db:apply:*` スクリプトもこの名前を参照している。ステップ11は `config.ts` の `content` を fog 化するとしているが、こちらは対象外。

- 提案: 「テンプレート名の残滓の扱い」を plan.md のスコープ節に1つ足し、(a) `outbox_events` は実装優先で spec-sync 対象、(b) wrangler の D1 名変更は ADR-004（4ランタイム維持）に従い**本 Issue では変更しない**、と明示的に決める。どちらも判断自体は妥当なので、明記して以後の揺り戻しを防ぐことが目的。

### **[S-012]** `PAGE-common-001` は「PC はサイドバー、モバイルは**下部タブ相当**」— plan.md の「下部シート相当」と表現が違う

- 理由:
  `spec/pages/index.md` / `spec/inventory/frontend.md` はいずれも「モバイルでは下部タブ相当」。plan.md は AC-14 で「モバイルは下部シート相当」、ステップ19では「ヘッダーメニュー → ボトムシート」としており、**常時見える下部タブ**と**メニューから開くシート**では到達性が違う（`PAGE-common-001` の完了条件は「選択で各画面へ遷移する」なのでどちらでも満たせるが、spec の記述からは離れる）。

- 提案: `spec/design/pages/timeline.html` の実装（デザイン基準形）を確認したうえで、spec 側の「下部タブ相当」と一致させるか、デザイン成果物が既にシート方式ならその旨を根拠として plan.md に書く（デザイン成果物が spec/pages より新しいなら spec-sync 対象）。

---

## ADR 個別所見

| ADR | 判断 | 所見 |
|---|---|---|
| **ADR-001** todo 削除＋初期マイグレーションリセット | **妥当** | 選択肢3つの比較・共通基盤テストの移植を必須作業として明記した点まで含めて良い。ただし波及範囲の落とし込みが不完全（→ P-002）、および d1 側に `meta/` が生える副作用が未記載（→ P-003）。`routeTree.gen.ts` / 4ランタイムの DI / `__root.tsx` については plan.md 側で拾えている（DI は型エラーで検出される旨も正しい） |
| **ADR-002** HMAC 署名 Cookie | **妥当** | `spec/requirements.md` を grep した結果、**セッション有効期限・失効・remember-me に関する要件は spec に一切存在しない**（session 関連の記述は identity.md「スコープに関する注意」と database/index.md「認証インフラテーブルはスコープ外」で明示的にスコープ外）。よって「サーバー側失効不可」のトレードオフは本スライスでは要件違反にならない。ログアウト（S-AC-04 / TC-06 / TC-23）は Cookie 失効で満たせる。`Max-Age` を置く設計なので TC-02「再読込でログイン状態が維持される」も満たす。`SessionCodec` の `application/ports/` 配置も依存方向として正しい（→ S-002 で JSDoc 補強を提案）。将来 `changePassword`（TC-32）スライスが来た時点でセッション一括失効の要否が再浮上する点は ADR に既に書かれている |
| **ADR-003** PBKDF2 210,000 回 | **要修正** | 「Node が主ターゲットなので本 Issue では問題にしない」は、**統合テストが workerd で走る**という事実を見落としている（→ P-004）。識別子付きエンコードによる将来移行の設計は優れている。「反復回数を環境変数化しない」の一文は、ファクトリ引数化（テスト注入）まで禁じる読み方ができるので緩める必要がある |
| **ADR-004** 4ランタイム維持 | **妥当** | 「削除という不可逆かつ広範囲の変更を認証実装と混ぜない」は正しい判断。`SESSION_SECRET` の追加点は実測で最低12箇所（4本の env 型 + 3本の zod スキーマ ※CF は型のみでスキーマ無し + 4本の container factory + env サンプル4種 + `.dev.vars.example` + wrangler の secret 宣言）。CF の `ServerEnv` には zod スキーマが存在しないため、**CF だけ秘密鍵欠落が実行時に検出されない**点は plan.md ステップ11に注記すべき |
| **ADR-005** 認証ヘルパーを `apps/web/app/presentation/` に置く | **妥当** | `docs/frontend_implementation_example.md` が示す `packages/core/src/lib/server/currentUser.ts` は `@tanstack/react-start/*` と `react` を core に持ち込む例で、CLAUDE.md の「core は framework-free」と明確に矛盾する。presentation への移設は正しく、ドキュメント側が誤りというのも正しい判定（同ドキュメントの `container.authProvider` / `domain/user/entity` は実在しない架空例）。ただしガード方式の記述が `beforeLoad` 集約とヘルパー方式で二重になっている（→ S-008） |
| **ADR-006** `ValidationError` をアプリケーション層へ | **妥当** | `docs/backend_implementation_example.md` のエラー設計表は既に `ValidationError` をアプリケーション層に列挙しており（実装側が欠けていた）、ドキュメントのほうが正しかったという判定は事実と一致。`SerializedError` union / `httpStatusFor` は既に `validation` を含むので波及はほぼゼロ。波及として**唯一漏れているのは `apps/web/app/presentation/validator.ts` が `SerializedValidationError` を `./errorResponse` から import している**点で、`errorResponse.ts` 側に `export type { SerializedValidationError }` の再エクスポートを残すかたちにすれば `validator.ts` は無変更で済む。ステップ1の変更内容にこの1行を足すこと。`FieldErrors` は `lib/error.ts` にあるのでアプリケーション層から参照可能（層違反にならない） |
| **ADR-007** プレースホルダールート | **概ね妥当** | `PAGE-login-005` / `PAGE-common-001` の完了条件（「導線が機能する」）に照らして選択肢2は正しい。ただし plan.md のスコープ節が SSO ボタンを「動かないボタンを置くのはデザイン方針に反する」として排除しているのに対し、「準備中」ページ4枚は許容しており、内部で基準が揺れている。ADR-007 に「リンク先が存在し状態を正直に伝えるプレースホルダーは、押しても何も起きないボタンとは別扱いとする」という判断基準を1行書いておくと一貫する |

---

## 良い点

- **チェックリスト75行 → 実装ステップの対応表が完備**しており、受け入れ基準（AC-1〜AC-17）が検証可能な粒度に束ねられている。カバレッジ主張が数字で追える形になっているのは、この規模の Issue では例外的に良い。
- **「transport スキーマにパスワード最低長を書かない」**（L337 / L631）は、CLAUDE.md の「入力検証は transport 境界と VO 生成の2点のみ」を正しく運用に落とした判断。ここを間違えると `PasswordTooWeak`（business）が `validation` に化けて TC-registerWithPassword-006 が通らない、という因果まで書けている。
- **UoW 方式では UNIQUE 違反が `insert` 呼び出しではなく flush 時に出る**という指摘（L273）は、実際に `PendingBatch` / `unitOfWork.ts` を読まないと分からない事実で、実装前に見抜けているのは調査が実コードに届いている証拠。翻訳先の選択には異論があるが（→ P-005）、問題の把握は正確。
- **`AppConfig` がクライアントへ渡ることに気づいている**（L291 / L632）。`loadAppContext` の実装を読まないと分からない。機構の詳細（rest-spread）まで詰めれば P-001 は解消する。
- **`__root.tsx` の副作用 import**（クライアント島からのみ参照される server fn が RSC マニフェストに載らない罠）を独立したステップ21として立てている。これはドキュメント化されておらずコード中のコメントにしか存在しない知識で、忘れると実行時にしか気づけない。
- **`UserRepository` が `TransactionalRepository` を extends しない**という spec/domains/identity.md の明記を正しく拾い、理由（`delete` を持たず `(userId, id)` 署名と両立しない）まで再現している。
- **`libsql` の read-your-write 非対応**をリスクとして挙げ、`findByEmail`（読）→ `insert`（書）の順序が安全であることまで確認している。
- **ドメイン層から設計を起こしている**。値オブジェクト表 → エンティティ（判別可能ユニオン） → イベント → ポート → ユースケース → アダプター → UI の順で、ロジックのユースケース／アダプターへの漏れは見当たらない。`TrashRetentionDays` を identity 一箇所に置く（trash へ重複定義しない）、`Actor` を横断 VO として identity に置く、といった spec の依存方向の指示も守れている。
- **`PlainPassword` の漏出防止を型で完全には守れないことを正直に書き、テストで縛る**と決めている（L162）。「型で守れないものを守れたことにしない」姿勢は良い。
- **スコープの「含まれないもの」が判断理由付きで列挙**されている。とくに SSO を落としつつ `SsoUser` の型・列・再水和だけ残す判断は、TC-getCurrentUser-002/004 と `ADP-users-001`（直和 CHECK + 部分一意インデックス）の要求を正確に読んでいる。

---

## 補足（実装時に効く実測メモ）

レビュー中に確認した、plan.md に書かれていないが実装で効く事実を記録しておく。

- `packages/core/package.json` には `exports` / `main` / `types` が**無い**。`@repo/core/adapters/webcrypto/*` / `@repo/core/application/ports/sessionCodec` の追加に **package.json の変更は不要**（tsconfig `paths` + Vite の `resolve.tsconfigPaths` のみで解決される）。
- ただし `packages/core` に暗号系依存は無く、`globalThis.crypto.subtle` に依存することになる。CF 経路に載るモジュールに `node:` import を混ぜないこと（`containerStore.ts` / `server.cloudflare.ts` のコメントが明示的に警告している）。WebCrypto ならこの制約は満たせる。
- `getContainer()` は AsyncLocalStorage 自体ではなく `Symbol.for(...)` 経由のインダイレクション。**リクエストスコープ外で呼ぶと throw する**（`storage.run(...)` の外／モジュールトップレベル／worker スコープ）。`currentUser.ts` を RSC・server fn から呼ぶ限り安全。`WorkerContainer` はこのストアに install されていない。
- `wrangler.toml` は `[env.*]` 間で `vars` / `d1_databases` を継承しない（ファイル冒頭に明記）。`SESSION_SECRET` を `[vars]` に置くなら**1ファイルあたり5ブロック × 3ファイル**の追記になる。秘密なので `[vars]` ではなく `wrangler secret put` / `.dev.vars` が正しい（ADR-002 の判断どおり）。
- 統合テストのプール割り当て: `vitest.config.integration.ts` の include は `apps/web/app/**/*.integration.test.ts` と `packages/**/*.integration.test.ts`、exclude は libsql / node アダプターと `apps/web/app/worker/node/**` のみ。よって `packages/core/src/adapters/webcrypto/__tests__/*.integration.test.ts` を作ると **workerd プールに入る**（node プールではない）。webcrypto のテストは `*.test.ts`（単体）に留めるのが計画どおりで正しい。
- `d1/repositories/todoRepository.ts:130-132` のコメント（「PK 衝突は `SystemError` になる」）は実装と食い違っている（実際は `ConflictError("UNIQUE_VIOLATION")`）。`userRepository.ts` を写経元にするときにこのコメントを引き継がないこと。
- `docs/test.md` の `TEST_DOMAIN=todo pnpm test:domain` 等のコマンド行は `package.json` に存在しない（stale）。テスト実行は `pnpm test:unit` / `pnpm test:integration` のみ。
