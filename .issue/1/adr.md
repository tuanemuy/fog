# ADR — Issue #1: [skeleton] 基盤＋アカウント登録・ログイン

## ADR-001: サンプル todo ドメインの削除と初期マイグレーションのリセット

### Status

Proposed

### Context

リポジトリは tanstack-start-template のテンプレート状態で、サンプルの `todo` ドメイン（domain / application / adapters / UI / ルート / 統合テスト）と `todos` テーブルが初期マイグレーション `0000_initial.sql`（d1 / libsql の2セット）に含まれている。

本 Issue は fog の **DB スキーマと共通基盤を固める** walking skeleton であり、fog の DB 設計（spec/database/index.md、9テーブル＋共通基盤）に `todos` は存在しない。選択肢は次の3つ。

1. `todo` を残したまま `users` を追加し、`todos` も初期マイグレーションに含まれ続ける
2. `todo` のコードは残し、マイグレーションからだけ `todos` を外す
3. `todo` ドメイン一式を削除し、初期マイグレーションを fog のものとして再生成する

制約: `todos` は `unitOfWork` / `occGuard` / `outboxRepository` の統合テスト（共通基盤の唯一の検証手段）の対象テーブルでもある。また `AllDomainEvents` / `defaultEventDecoderRegistry` は `satisfies` で網羅性が強制されており、ドメインの増減は必ずコンパイルエラーとして現れる。

### Decision

**3 を採る。** `todo` ドメイン一式（`domain/todo/`・`application/todo/`・`adapters/{d1,libsql}/repositories/todoRepository.ts`・`components/todo/`・`routes/todo/`・`routes/index.tsx`）を削除し、`0000_initial.sql`（d1 / libsql 双方）と libsql の `meta/` を破棄して fog の初期マイグレーションとして再生成する。`0001_*` を積むのではなくリセットするのは、fog がまだ一度もデプロイされておらず保護すべき既存データが存在しないため。

共通基盤の統合テスト（`unitOfWork` / `occGuard` / `outboxRepository`）は破棄せず、対象集約を `users` に置き換えて移植する。

コピー元としての参照価値は `docs/backend_implementation_example.md` / `docs/frontend_implementation_example.md` に残っており、コードを残す必要はない。

### Consequences

- 良い点:
  - fog の初期マイグレーションが spec/database と1対1になり、以後のスライスが不要なテーブルを引きずらない
  - `identity` が新しい基準形になり、後続スライス（memo / knowledge）のコピー元が fog 自身の実装になる
  - `/` と `/todo/*` のルート衝突・グローバルナビとの二重シェル構造を持ち込まずに済む
- 副作用（意図した変更として記録する）:
  - **d1 の migrations ディレクトリに `meta/` が生成される。** 現状の `d1/migrations/0000_initial.sql` は手書きで（コメント入り・`--> statement-breakpoint` なし）、`meta/` を持たない。`pnpm db:generate:cf` を回すと drizzle が `meta/_journal.json` と snapshot を作り、以後 d1 側も libsql と同じく drizzle 管理になる。`readD1Migrations` / `applyD1Migrations` は `.sql` を読むだけなので実行系への影響はない**はず**だが、`vitest.config.integration.ts` は `const migrations = await readD1Migrations(...)` を **config のトップレベルで await している**ため、ここが失敗すると D1 プールの統合テストが1件も起動しない。本リポジトリでは `meta/` がある状態を未実測なので、**断定せず plan.md ステップ7の完了条件で「起動すること」を確認する**（→ round-2 arch-risk S-004）
    - **実測（ステップ7完了時点）**: `pnpm db:generate:cf --name initial` により d1 側にも `meta/{_journal.json,0000_snapshot.json}` が生成された。その状態で `pnpm test:integration:cf` を実行し、**D1 プールは正常にブートした**（`readD1Migrations` のトップレベル await は `meta/` の有無に影響されない）。S-004 は解消。`pnpm db:migrate` でのローカル DB 再作成も成功し、`users` / `users_email_uq` / `users_sso_identity_uq` / 共通基盤3テーブルの存在を確認済み
  - **`libsql/__tests__/helpers.ts` の migration 適用方法を変える。** 現状は `../migrations/0000_initial.sql` をパス固定で `readFileSync` しており、`drizzle-kit generate` の生成ファイル名が変わると libsql 統合テストが全滅する。`meta/_journal.json` を走査して全 SQL を順に適用する形に書き換える（将来 `0001_*` を積んでも壊れない）
- トレードオフ:
  - 本 Issue の変更範囲が広がる。特に共通基盤の統合テスト（`unitOfWork` / `occGuard` / `outboxRepository` / `helpers.integration`）の移植は必須作業になる
  - 移植を怠ると OCC ガード・outbox・`mapDbError` の制約分類の検証が空洞化する。plan.md のリスク節に明記し、レビュー観点として固定する
  - 削除（plan.md ステップ3）と移植（ステップ13）を別ステップに割るため、その間は共通基盤の統合テストが存在しない状態になる。ステップ13を飛ばせないよう完了条件に明記する
  - **relay / consumer の統合テスト3本（`application/workers/__tests__/eventRelayWorker.integration.test.ts`・`apps/web/app/worker/{cloudflare,node}/__tests__/*.integration.test.ts`）も同じ扱いにする。** これらを「ドメイン非依存のその場イベント」に書き換えて維持することはできない: `EventDecoderRegistry = Partial<DefaultEventDecoderRegistry>` は `AllDomainEvents` に閉じているので空の期間はデコーダを1件も型安全に登録できず、`runRelayTick`（cloudflare `handlers.ts`）と node `runner.ts` はレジストリ差し込み口を持たないため常に `defaultEventDecoderRegistry` を使う。したがってステップ3で**削除**し、`AllDomainEvents` が `IdentityEvent` になるステップ12の後、**ステップ13で `identity.userRegistered` を seed イベントとして復活させる**。これは型エラーではなくテスト実行時にしか出ない失敗なので、順序でしか閉じられない（→ round-2 arch-risk P-002）

---

## ADR-002: セッション管理方式 — HMAC 署名付きステートレス Cookie

### Status

Proposed

### Context

テンプレートには認証・セッションの実装が一切ない（Cookie ヘルパー・セッションストア・認証ミドルウェアすべて不在）。一方 spec は明確に方針を持っている。

- セッションの生成・破棄・Cookie 管理は**アダプター / presentation 層の責務**でありドメインに置かない（spec/domains/identity.md「スコープに関する注意」、spec/usecases/identity.md 共通事項）
- セッション用テーブルは **DB 設計のスコープ外**であり、「採用する認証ライブラリ／基盤が要求するテーブルはアダプターのマイグレーションとして別途追加する」（spec/database/index.md「認証インフラテーブルはスコープ外」）

選択肢:

1. **署名付きステートレス Cookie**（HMAC-SHA256 で `{ userId, exp }` を署名）— テーブル不要・DB 往復なし・全ランタイムで同一実装
2. **不透明セッション ID + `sessions` テーブル** — サーバー側失効が可能。ただし d1 / libsql 2セットのスキーマ・リポジトリ・マイグレーションが増え、リクエストごとに DB 読み取りが入る
3. **外部認証ライブラリ（Lucia / Auth.js 等）の導入** — 依存が増え、テンプレートの DI / エラー契約・4ランタイム構成との整合を取る作業が発生する

本 Issue が満たすべき要件は S-AC-01 / S-AC-03 / S-AC-04（登録・パスワードログイン・ログアウト・保護 URL のガード・ログイン後の元 URL 復帰。Issue 本文の「S-AC-02」表記は誤記で、実体の S-AC-02 は SSO → plan.md「対象シナリオ ID の読み替え」）に限られ、「全デバイスからログアウト」「管理者によるセッション失効」は要件・シナリオに存在しない。AI クライアントのトークン失効（S-AC-06）は `ai_client_connections.status` を根拠とする別経路であり、人間のセッションとは独立している。

### Decision

**1 を採る。** `SessionCodec` ポート（`packages/core/src/application/ports/sessionCodec.ts`）を `issue(userId, now)` / `verify(token, now)` の2メソッドで定義し、WebCrypto HMAC-SHA256 による実装（`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`）を全ランタイムの `RequestContainer` に配線する。Cookie の読み書き（`HttpOnly` / `SameSite=Lax` / `Secure` / `Max-Age`）は `apps/web/app/presentation/session.ts` に閉じ込め、ポートは Cookie を知らない。

秘密鍵は `SESSION_SECRET` 環境変数（32文字以上）として4ランタイムの env スキーマに追加し、**`AppConfig` には入れない**（`loadAppContext` が `container.config` をクライアントへ返すため）。さらに「入れない」という原則だけでは守れないので構造的に塞ぐ: `RequestServerConfig` に `secrets: { sessionSecret }` としてネストし、4本の `createXxxRequestContainer` の rest-spread（`const { db, relayTrigger, ...appConfig } = config`）が拾えないようにする。`appConfig satisfies AppConfig` は変数に対する `satisfies` なので余剰プロパティ検査が効かず、平置きすると型エラーなしでクライアントの HTML ペイロードに載る。秘密鍵は `createHmacSessionCodec` の構築にだけ使い、**`RequestContainer` には載せない**（上位はポート越しにしか触れない）。

`SessionCodec` は `application/ports/` に置くが、**アプリケーション層のどのユースケースも使わない presentation 専用ポート**である。放置すると後続スライスで「セッションを触るユースケース」が生まれて spec/usecases/identity.md の責務分界（セッションは presentation）が崩れるので、`sessionCodec.ts` の library-level JSDoc に「ユースケースから参照してはならない」と明記する。

ログアウトは Cookie の失効（`Max-Age=0`）で完結する。

### Consequences

- 良い点:
  - DB 設計に手を入れずに済み、spec の「認証インフラはスコープ外」と正面から整合する
  - d1 / libsql 双方のスキーマ・リポジトリ・マイグレーションが増えない（本 Issue で一番コストの高い二重化を回避できる）
  - 4ランタイムすべてで同一実装が動く（WebCrypto は Node 20+ / Workers / Lambda / Cloud Run で共通）
  - `SessionCodec` をポートにしてあるため、テーブル方式への差し替えはアダプター1本の交換で済む
- トレードオフ:
  - **サーバー側からの能動的な失効ができない**。トークンは TTL 満了まで有効で、パスワード変更時に既存セッションを一括無効化する手段がない
  - 緩和として TTL を短め（既定 7日程度）に設定し、将来「全セッション失効」が要件化した際は `SessionCodec` の実装をテーブル方式へ差し替える。ペイロードに `passwordVersion` を含める中間案も取り得るが、本 Issue のスコープ（changePassword なし）では不要なので導入しない
  - 秘密鍵のローテーションは全ユーザーの再ログインを強制する（複数鍵の検証は実装しない）

---

## ADR-003: パスワードハッシュ方式 — WebCrypto PBKDF2-HMAC-SHA256

### Status

Proposed

### Context

`PasswordHasher` はドメインポートで、アルゴリズムはアダプターの責務と明記されている（spec/domains/identity.md「PasswordHash」「PasswordHasher」）。spec の記述は「Argon2id 等」であり Argon2id を強制していない。

前提となる制約:

- 実行環境は Node（主ターゲット）に加え Cloudflare Workers / AWS Lambda / Cloud Run。ネイティブアドオン（`bcrypt`）は Workers で動かない
- `packages/core` の依存は現状 drizzle / zod / uuid / 各クラウド SDK のみで、暗号ライブラリを持たない
- WASM 版 Argon2 は Workers でも動くがバンドルサイズと CPU 時間の制約が厳しく、依存を1つ増やす

選択肢: (a) Argon2id（WASM 依存を追加）、(b) bcrypt（Node 専用・ネイティブ）、(c) scrypt（`node:crypto` 専用）、(d) PBKDF2-HMAC-SHA256（WebCrypto、依存ゼロ、全ランタイム共通）。

### Decision

**(d) WebCrypto PBKDF2-HMAC-SHA256 を採る。** パラメータは 16 byte のランダム salt・32 byte 出力・**既定**反復回数 210,000（OWASP の PBKDF2-SHA256 推奨）。保存形式は

```
pbkdf2-sha256$<iterations>$<saltBase64>$<hashBase64>
```

とし、`verify` は保存値からアルゴリズム識別子とパラメータを読んで検証する（定数時間比較）。この「識別子付きエンコード」により、将来 Argon2id へ移行する際は `verify` に分岐を1本足し、ログイン成功時に新方式で再ハッシュする（rehash-on-login）だけで無停止移行できる。

計算失敗は `SystemError`、照合の不一致はエラーではなく `false`（spec の契約どおり）。

**反復回数はファクトリ引数にする** — `createPbkdf2PasswordHasher({ iterations = 210_000 })`。**環境変数では設定できないようにする**（環境ごとに強度が揺れ、どのハッシュがどの強度で作られたか運用上追えなくなるため）。ファクトリ引数にする理由は、統合テストの実行環境そのものが制約になるからである。

- `vitest.config.integration.ts` の include は `packages/**/*.integration.test.ts` で、exclude は libsql / node アダプターのみ。したがって `application/identity/__tests__/*.integration.test.ts` は **Miniflare（workerd）プールで走る**。「主ターゲットは Node なので CF の CPU 予算は本 Issue では問題にならない」は成立しない
- workerd の WebCrypto は PBKDF2 の反復回数に上限（10万回程度）を課すという報告がある。事実なら `deriveBits` が例外になり、登録・ログイン系の統合テストが一件も通らない
- 上限に触れなくても、20件超の統合テスト × 複数回のハッシュ計算で CPU 時間が問題になる

対処の順序（plan.md ステップ10）:

1. 着手時に workerd プールで `deriveBits(… iterations: 210_000 …)` を1回叩く捨てテストを書き、成功可否と所要時間を実測する
2. ユースケースの統合テストには**フェイクハッシャー**を注入し、実アルゴリズムの検証は node プールの単体テスト（`adapters/webcrypto/__tests__/`）に寄せる。実ハッシャーで往復することに意味があるケース（TC-loginWithPassword-009）だけ低い反復回数（例: 1,000）を注入する
3. 実測で workerd が 210,000 回を扱えなかった場合の代替案:
   - (i) identity の統合テストだけ `vitest.config.integration.node.ts`（node プール・libsql）へ移す
   - (ii) 本番の反復回数を 100,000 に下げる（OWASP 推奨を下回るのでセキュリティ上の後退。採るなら理由を ADR に追記する）
   - 選択した案と実測値は本 ADR に追記する

保存形式に `iterations` が埋まっているので、反復回数を変えても既存ハッシュの `verify` は壊れない。

### 実測結果（plan.md ステップ10 / 2026-07-25）

捨てテスト `packages/core/src/adapters/webcrypto/__tests__/_probe.integration.test.ts` を Miniflare（workerd）プールで実行し、`crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", iterations: 210_000 }, key, 256)` を1回計測した（確認後に削除済み）。

- **成功。所要時間 16ms。** workerd の WebCrypto は 210,000 回に上限を課さない
- したがって Decision の代替案 (i)（identity 統合テストの node プール移設）／(ii)（反復回数を10万に下げる）は**いずれも不要**。本番の反復回数は既定の 210,000 のまま
- ただしフェイクハッシャー注入の方針は維持する。1回16ms は許容範囲でも、登録・ログインを繰り返す統合テスト全体では無視できない累積になるため、`createTestContainer` / `setupTestContainer` の `passwordHasher` 既定値は `FakePasswordHasher` とし、実ハッシャーが要るテストだけが明示的に注入する

### Consequences

- 良い点:
  - 依存追加ゼロで4ランタイム同一実装。`packages/core` のフレームワーク非依存性を保てる
  - 識別子付きエンコードにより、アルゴリズム変更が後方互換のまま可能
  - WebCrypto はテスト環境（Node pool / Miniflare pool）双方で使えるため、統合テストの実行環境を選ばない
- トレードオフ:
  - **Argon2id と比べてメモリハード性がなく、GPU/ASIC による総当たりに対する耐性は劣る**。パスワード最低長8文字（spec の要件）と組み合わせると、弱いパスワードのオフライン攻撃耐性は Argon2id 採用時より低い
  - 反復回数 210,000 は Cloudflare Workers の CPU 予算（無料プランで数十 ms）を超える可能性がある。**これは「CF を本番採用したら考えること」ではなく、統合テストが workerd プールで走る以上、本 Issue の実行可能性に直結する**（上記 Decision の実測手順を参照）。CF ランタイムを本番採用する場合は反復回数の見直し、または Argon2id(WASM) への移行を検討する
  - 反復回数を**ファクトリ引数**にしたことで、呼び出し側が誤って低い値を渡す余地が生まれる。既定値を持たせたうえで、本番の配線（4本の DI ファクトリ）は既定値をそのまま使い引数を渡さない運用にする。環境変数からは設定できないままなので、「環境ごとに強度が揺れない」という当初の意図は保たれている

---

## ADR-004: ランタイム選定 — Node + libSQL を主ターゲットとし4ランタイム構成は維持する

### Status

Proposed

### Context

テンプレートは Node + libSQL / Cloudflare Workers + D1 + Queues / AWS Lambda + Turso + SQS / GCP Cloud Run + Pub/Sub の4ランタイムを同梱しており、CLAUDE.md は「ひとつ選んで他は消す」方針を示している。一方で spec/database/index.md は「SQLite 系ランタイム（libSQL / D1 / Turso）を前提」とし、特定ランタイムを指定していない。

本 Issue で決めるべきは (1) 動作検証の主ターゲット、(2) 未採用ランタイムを本 Issue で削除するか。

観測された事実:

- `pnpm dev` / `build` / `start` の既定は Node（`dev:node`）
- 統合テストの主戦場は Miniflare D1 プール（`application/**/*.integration.test.ts` はここで走る）。libsql / node は別プール
- スキーマは `d1/schema.ts` が唯一の出所で `libsql/schema.ts` は再エクスポート。したがってスキーマ作業は1回で両対応
- 二重化が必要なのはリポジトリ実装（d1 / libsql の2本）とマイグレーション生成（2セット）
- DI ファクトリは4本あり、`RequestContainer` にポートを足すと4本すべての更新が必要（ただし型エラーで検出される）

### Decision

- **主ターゲットは Node + libSQL** とする。`pnpm dev` / `pnpm db:migrate` の既定であり、手動検証（spec/manual-tests/account.md）はこの構成で行う
- **本 Issue では cf / aws / gcp を削除しない。** 4本の DI ファクトリと2本のリポジトリ実装・2セットのマイグレーションを維持し、すべてがビルド・型検査を通る状態を保つ
- 新規アダプター（`PasswordHasher` / `SessionCodec`）は WebCrypto ベースのランタイム非依存実装1本に統一し、二重化を持ち込まない（→ ADR-002 / ADR-003）
- 未採用ランタイムの削除は**別 Issue に切り出す**

### Consequences

- 良い点:
  - 削除という不可逆かつ広範囲の変更を、認証機能の実装と混ぜずに済む（レビュー単位が明確になる）
  - D1 プールでの統合テストがそのまま使えるため、テスト基盤の作り直しが不要
  - スキーマの単一出所と WebCrypto 実装により、二重化コストは「リポジトリ実装2本 + マイグレーション2セット」に限定される
- トレードオフ:
  - `UserRepository` を d1 / libsql の2本書く必要がある（テンプレートの `todoRepository` と同じ構図なので追加の設計負債ではない）
  - **マイグレーション2セットの再生成漏れは型検査で検出できない**。plan.md のリスク節に明記し、`pnpm db:generate:cf` / `pnpm db:generate:node` の両実行をチェック項目にする
  - 4ランタイム分の env スキーマ・env サンプルに `SESSION_SECRET` を足す手間が発生する
  - **その `SESSION_SECRET` は zod スキーマ側では optional にとどめ、必須性の検証は `createXxxRequestContainer` に置く。** `readAwsServerEnv()` / `readGcpServerEnv()` は `apps/web/app/worker/{aws,gcp}/handlers.ts` からも呼ばれるので、必須にするとセッションを扱わない relay / consumer / pruner / dlq が起動できなくなり、「4ランタイムすべてが動く状態を保つ」という本 ADR の決定に反する。さらに `infra/aws/lib/appStack.ts` の `sharedEnv` は `Record<string, string>`、`infra/gcp/example/services/*` は Terraform 変数で env を列挙しており、**列挙漏れは型検査でもテストでも検出できずデプロイ時にしか出ない**。infra 側の追加はアプリ実行地点（`appFn` / `google_cloud_run_v2_service.app`）にだけ行う（→ plan.md ステップ11 / round-3 arch-risk S-001）

---

## ADR-005: 認証ヘルパー（`getCurrentUserId` / `requireUserId`）の配置

### Status

Proposed

### Context

`docs/frontend_implementation_example.md`「Shared server logic (authentication helper)」は、`getCurrentUser()` / `requireCurrentUser()` を **`packages/core/src/lib/server/currentUser.ts`** に置く例を示している。しかしこの実装は `@tanstack/react-start/server-only` / `getRequestHeaders()` / `redirect()` を使うフレームワーク依存コードであり、CLAUDE.md の「`packages/core` は framework-free」および「`lib/` は全層が拡張してよい構造プリミティブ」という定義と矛盾する。

また `createMiddleware` を使う案もあるが、同ドキュメントは「RSC とは単純なヘルパーのほうが噛み合う」として明確にヘルパー方式を推している。

### Decision

- ヘルパーは **`apps/web/app/presentation/currentUser.ts`** に置く（`packages/core` ではない）。CLAUDE.md がプレゼンテーション層を「TanStack Start 固有の横断ユーティリティ」と定義しており、認証ガードはまさにそれに該当する
- Cookie の読み書きは `apps/web/app/presentation/session.ts` に分離し、`currentUser.ts` は「トークンを読む → `container.sessionCodec.verify` → userId」だけを担う
- `getCurrentUserId()` は `cache()` でリクエスト内デデュープする。ユースケースモジュールを伴わない一行ポートアクセスなので、`serverData` を経由せず `getContainer()` を直接呼ぶ escape hatch を使い、ファイル先頭に `import "@tanstack/react-start/server-only";` を置く
- **ガードの権威は `requireUserId()`**。保護対象のデータを読む server component / server function は必ず自分で `requireUserId()` を通す。認証方式は `createMiddleware` ではなくヘルパー方式を採る（`docs/frontend_implementation_example.md` が「RSC には単純なヘルパーのほうが噛み合う」として推している方式）
- **`routes/_app.tsx` の `beforeLoad` は「先回りリダイレクト」であってセキュリティ境界ではない**。未認証ユーザーに保護画面のシェルを一瞬でも見せないためのナビゲーション体験の仕掛けであり、クライアントサイドナビゲーションではブラウザで走る。ここを通ったかどうかにデータ保護を委ねない。ガードの付け忘れを構造的に防ぐという意味での「集約点」は `_app.tsx` だが、実効的な防御は各サーバー実行地点にある
- Cookie の読み書きは `apps/web/app/presentation/session.ts`、Cookie 文字列の組み立ては**フレームワーク import を持たない** `apps/web/app/presentation/sessionCookie.ts` に分ける。純関数側にだけテストを置くことで、`server-only` モジュールが node プールの Vitest から読めるかどうかに TC-logout-002 のカバレッジが依存しなくなる
- ログアウト後に戻るボタンで保護画面が復元されないよう（manual TC-23）、`_app.tsx` に `staleTime: 0` を置き、ログアウトは `router.invalidate()` → `router.navigate({ to: "/login", replace: true })` の順で行う

### Consequences

- 良い点:
  - `packages/core` のフレームワーク非依存性が保たれ、将来 MCP サーバー / CLI を `apps/*` として足すときにコアが汚れていない
  - 保護対象の追加は「`routes/_app/` 配下に置く」だけになり、ガードの付け忘れが構造的に起きにくい
- トレードオフ:
  - `docs/frontend_implementation_example.md` の記述と実装が食い違う。ドキュメント側の更新は本 Issue のスコープ外なので、spec-sync / docs 更新の対象として別途拾う必要がある
  - MCP サーバー等の別 app を足す際、認証ヘルパーは `apps/web` にあるため再利用できない（そちらは OAuth トークン経由の別経路になるため、実際には共有すべきでない）

---

## ADR-006: アプリケーション層への `ValidationError` 追加と `SerializedValidationError` の所在

### Status

Proposed

### Context

spec/usecases/identity.md は `loginWithPassword` の全失敗を `ValidationError("INVALID_CREDENTIALS")` に統一すると規定し、`docs/backend_implementation_example.md` のエラー設計表も `ValidationError` をアプリケーション層に列挙している。しかし実装 `packages/core/src/application/errors/index.ts` には `ValidationError` が存在しない。`kind: "validation"` を持つのは presentation の `validator.ts` にある `InputValidationError`（transport 境界の shape 検証専用）だけで、`SerializedValidationError` 型も `apps/web/app/presentation/errorResponse.ts` にローカル定義されている。

選択肢:

1. presentation の `InputValidationError` をユースケースから使う — 依存方向（application → presentation）が逆流する。不可
2. `BusinessRuleError` で代用する — `kind: "business"` になり、spec が意図的に分けている「入力・照合の失敗（validation）」と「ドメイン規則違反（business）」の区別が壊れる。TC-loginWithPassword-006 / 007 は「`BusinessRuleError(InvalidEmail)` ではなく `ValidationError` に変換される」ことを明示的に要求している
3. アプリケーション層に `ValidationError` を追加する

### Decision

**3 を採る。** `packages/core/src/application/errors/index.ts` に

```ts
export type SerializedValidationError = SerializedErrorBase & {
  kind: "validation";
  fieldErrors?: FieldErrors;
};
export class ValidationError extends ApplicationError { /* toSerialized() → kind: "validation" */ }
export function isValidationError(error: unknown): error is ValidationError;
```

を追加し、`apps/web/app/presentation/errorResponse.ts` はローカル定義をやめて application から `SerializedValidationError` を import する（`SerializedError` union の構成は変わらない）。presentation の `InputValidationError` はそのまま残し、同じ `kind` / 同じシリアライズ形を共有する。`fieldErrors` は optional なので、`InputValidationError`（フィールド単位）とユースケース由来（フィールドなし）の両方を1つの型で表せる。

HTTP ステータスの割り当て（validation → 422）は既に presentation にあり変更不要。

### Consequences

- 良い点:
  - spec が意図する `business` / `validation` の使い分けが型レベルで保たれる
  - `SerializedError` union と `httpStatusFor` に変更が入らない（既に `validation` を含んでいる）
  - `docs/backend_implementation_example.md` の記述と実装が一致する（ドキュメント側のほうが正しかったケース）
- トレードオフ:
  - 「同じ `kind` を出すエラークラスが2つ（application の `ValidationError` と presentation の `InputValidationError`）」になる。役割は明確に分かれている（前者は照合失敗、後者は transport shape 違反）が、命名が近いので JSDoc で境界を明記する

---

## ADR-007: 未実装スライスへの導線をプレースホルダールートで用意する

### Status

Proposed

### Context

本 Issue のチェックリストは `PAGE-login-005`（パスワードリセットへの導線が機能する）と `PAGE-common-001`（グローバルナビの5項目から各画面へ遷移する）を要求するが、遷移先である P-03 / P-06 / P-11 / P-12 / P-13 は後続スライスの担当で存在しない。TanStack Router は型付きリンクなので、存在しないルートへの `<Link to>` はそもそもコンパイルが通らない。

選択肢:

1. 遷移先が無いナビ項目を `<span aria-disabled>` にして非リンク化する
2. 遷移先のプレースホルダールートを作る（空ページ）
3. ナビ項目自体を実装済みのものだけに絞る

### Decision

**2 を採る。** `/password-reset`・`/topics`・`/search`・`/trash` を「見出しのみ／準備中の一文」を持つ最小ルートとして作成し、`/settings` は本 Issue で必要な範囲（`getCurrentUser` による email 表示 + ログアウト）だけを実装する。

理由:

- `PAGE-login-005` / `PAGE-common-001` の完了条件は「導線が機能する」ことであり、非リンク化（1）や項目削除（3）は条件を満たさない
- 後続スライスは「プレースホルダーの中身を書く」だけになり、ルート追加・ナビ配線・シェルとの整合という毎回同じ作業が1回で済む
- 空状態の見せ方はデザイン方針が「余白とテキストで表現する」と規定しており、プレースホルダーもその範囲に収まる

**判断基準（SSO ボタンを描画しないこととの整合）**: 本 Issue はスコープ節で「動かない SSO ボタンは置かない」と決めている一方、「準備中」のプレースホルダーページは許容する。基準は「**リンク先が実在し、遷移した先で状態を正直に伝えるもの**」と「**押しても何も起きないコントロール**」の区別に置く。前者はユーザーの期待を裏切らず（遷移は必ず成功する）、後者は機能があるように見せて何も起きないため嘘の導線になる。この基準で SSO ボタン非描画とプレースホルダールートは両立する。

ログアウト UI を `/settings` に置くのは、spec/pages/index.md が P-13 の機能として明記しているため（本 Issue のチェックリストに `PAGE-settings-006` は無いが、Issue の「検証」節がログアウトの動作確認を要求しており、置き場所は spec に従う）。

### Consequences

- 良い点:
  - グローバルナビが本当に機能する状態で完成し、`PAGE-common-001` を偽らずに満たせる
  - 後続スライスの着地点が先に用意され、ルーティングの再設計が発生しない
- トレードオフ:
  - 「準備中」の画面が一時的に4つ増える。実装済みかどうかが画面から判別しづらくなるが、walking skeleton の性質上許容する
  - プレースホルダーが放置されるリスクがある。後続 Issue（各スライス）が同じパスを担当するため、Issue 一覧側でトレースできる

---

## ADR-008: `EMAIL_ALREADY_REGISTERED` の翻訳点をユースケース境界に置く

### Status

Proposed

### Context

`spec/inventory/adapter.md` の `ADP-identity-001`（および `spec/inventory/domain.md` の `DOM-identity-018`）は「`insert` が email / (provider, providerSubject) の一意制約違反を `EMAIL_ALREADY_REGISTERED` / `SSO_IDENTITY_ALREADY_REGISTERED` にマップする」と定義しており、CLAUDE.md の「adapter → application: adapters catch driver-specific errors and translate them into the shared error contracts」とも一致する。素直に読めば翻訳はアダプターの責務。

しかし実装を読むと、テンプレートの UoW は**遅延バッチ方式**である。

- D1: リポジトリの書き込みは `PendingBatch` に積まれ、`fn` が返った後の `db.batch()` で一括 flush される（D1 に対話的トランザクションが無いため）
- libSQL: 同じく `PendingBatch` に積み、`db.transaction` 内で順に実行する

したがって **UNIQUE 制約違反は `UserRepository.insert` の呼び出し時ではなく flush 時に出る**。`insert` の内側で `try / catch` しても捕捉できない。加えて `mapDbError` は制約名を捨てて `UNIQUE_VIOLATION` に潰す（`constraintViolationCode` は UNIQUE と PRIMARYKEY を同じコードにする）ため、呼び出し側でどの制約が発火したかを復元する手段が無い。

選択肢:

1. `PendingBatch` に per-statement の「制約違反ハンドラ」を新設し、翻訳をアダプターに残す
2. `registerWithPassword` ユースケース側で `unitOfWorkProvider.run(...)` を `catch` し、`UNIQUE_VIOLATION` を `EMAIL_ALREADY_REGISTERED` に読み替える

### Decision

**本 Issue では 2 を採る。** ただし前提と限界を明示し、恒久解（1）への移行経路を先に決めておく。

- `registerWithPassword` の `catch` は「レース検出という明示された境界」であり、CLAUDE.md の「broad catch は境界のみ」に反しない
- **読み替えが安全である前提**（JSDoc に明記する）: 同一 UoW の書き込みが「`users` への insert 1件 + outbox insert」だけであること、および insert 対象が `PasswordUser`（`sso_provider` が NULL）なので部分一意インデックス `users_sso_identity_uq` が**原理的に発火しないこと**。`EventId` は UUIDv7 なので outbox 側の PK 衝突は実質起こらない。**`users.id` の PK 衝突も `constraintViolationCode` が `SQLITE_CONSTRAINT_PRIMARYKEY` を `UNIQUE_VIOLATION` に潰すため同じ読み替えを通るが、`UserId` も UUIDv7 なので実質起こらない**（前提の列挙はこれで閉じる）。この前提が崩れる書き込みを UoW に足すときは読み替えを外す
- **副作用（テスト側の注意）**: この読み替えがあるため、TC-registerWithPassword-016（insert DB 例外 → `SystemError`）を**制約違反で注入することはできない**。`mapDbError` は `SQLITE_CONSTRAINT*` をすべて `ConflictError` にし、UNIQUE / PK はここで `EMAIL_ALREADY_REGISTERED` に化ける。非制約系の DB 障害（テーブルの drop / rename、DB ハンドルのクローズ）で注入すること（→ round-2 coverage S-002）
- **`SSO_IDENTITY_ALREADY_REGISTERED` の翻訳は本 Issue では実装しない。** SSO 登録ユースケース（UC-identity-002）が無く、制約を発火させるテストが書けないため。`DOM-identity-018` / `ADP-identity-001` は「email 制約側のみの実装」としてチェックリスト対応表に記録する
- **恒久解（SSO スライスで実施）**: `PendingBatch` は既に per-statement のハンドラ機構を持つ（d1 は `conflictHandlers` の FIFO + `firstConflictHandler()`、libsql は `stmt.kind === "occ"` + 直前ハンドラ）。ここに OCC 以外の制約違反ハンドラを1種類足し、`insert` が `pending.add(query, { onConstraintViolation: (err) => never })` を登録できるようにすれば、翻訳がアダプターに戻り、どの statement が落ちたかも FIFO で特定できる。同一 insert 文の中で email と sso identity のどちらの制約かを分ける部分だけはドライバのメッセージ（D1 / libSQL とも `UNIQUE constraint failed: users.email` の形でテーブル.カラムを含む）に依存するので、ハンドラにドライバ例外を渡す形にし、判別不能なら `UNIQUE_VIOLATION` へフォールバックする

### Consequences

- 良い点:
  - 遅延バッチ UoW の制約の中で、ユーザーから見た振る舞い（重複メールなら `EMAIL_ALREADY_REGISTERED`）を事前検証経路・レース経路のどちらでも一致させられる（TC-registerWithPassword-011 / 014）
  - `PendingBatch` の API を本 Issue で変更しないので、共通基盤（OCC ガード・outbox）の挙動に手を入れずに済む
- トレードオフ:
  - **`spec/inventory/adapter.md` の記述（アダプター責務）と実装レイヤーが食い違う。** spec-sync の対象として明示的に残す
  - 読み替えが「同一 UoW に他の一意制約が無い」という前提に依存する。前提は JSDoc とテスト（TC-registerWithPassword-014）でしか守られない
  - SSO スライスで `PendingBatch` の拡張とユースケース側の catch 撤去がセットで必要になる（作業が後ろ倒しになる）

---

## ADR-009: 読み取り専用ユースケースも純読み取り UoW 経由でリポジトリを取得する

### Status

Proposed

### Context

`spec/usecases/identity.md` は `loginWithPassword` / `getCurrentUser` / `logout` を「読み取りのみ。UoW 不要」と明記している。一方テンプレートの構造では、**リポジトリは `UnitOfWorkContext` からしか取得できない**（`RequestContainer` にはドメインポートを載せない設計で、その意図が `di/types.ts` の JSDoc に書かれている）。

選択肢:

1. 読み取り用に `RequestContainer` へ `userRepository` を直接載せる
2. 読み取り専用ユースケースも `unitOfWorkProvider.run(...)` 経由でリポジトリを取る

### Decision

**2 を採る。** `libsql/unitOfWork.ts` には「Pure-read UoW: skip the transaction.」の分岐が実在し、D1 版も `pending.isEmpty()` なら `db.batch()` を呼ばずに返る。つまり**純読み取りの UoW は実際にトランザクションを張らない**ので、spec の「UoW 不要」（＝トランザクションを張らない）は満たされる。

`spec` の字面（「UoW 不要」）と実装（`unitOfWorkProvider.run` を通る）に差が出るため、**spec-sync の対象**として記録する。spec 側を「読み取り専用ユースケースはトランザクションを張らない（純読み取り UoW を通ってよい）」と改める提案を別途行う。

### Consequences

- 良い点:
  - 「リポジトリの取得口は `UnitOfWorkContext` ただ1つ」という既存の不変条件を壊さない。`RequestContainer` にドメインポートが増えていく圧力を作らない
    - **例外の明示**: `passwordHasher`（ドメインポート）だけは `RequestContainer` に載せる（plan.md ステップ11）。本 ADR が守っているのは**リポジトリ**の取得口の一元化であり、`passwordHasher` はリポジトリではなく、非トランザクショナルで UoW 外での実行を `spec/usecases/identity.md` の処理フローが要求している（hash は UoW を開く前に済ませる）。この例外は `application/di/types.ts` の `RequestContainer` の JSDoc に理由付きで書く。ADR 単体で読んだときに矛盾に見えないよう、ここに併記しておく（→ round-3 arch-risk S-003）
  - 読み取り専用ユースケースを後から書き込みへ拡張するときにシグネチャが変わらない
- トレードオフ:
  - spec の字面とは一致しないので、レビューや spec-sync で「spec 違反」と誤検出されうる。本 ADR がその判断の記録になる
  - 読み取り1回でも UoW のセットアップ（リポジトリ生成）を通るわずかなオーバーヘッドがある

---

## ADR-010: セッション操作の失敗に `SystemErrorCode.SessionError` を新設する

### Status

Proposed

### Context

TC-logout-003（セッション破棄失敗）は、破棄に失敗したケースが `SystemError` として扱われることを要求する。実装上 `endSession()` は「Cookie 文字列を組み立ててレスポンスヘッダーに載せる」だけなので通常は失敗しないが、`presentation` の `serializeError` は `isSerializableError` でない throw を `kind: "unknown"` にフォールバックするため、素の例外を投げると `kind: "system"` にならず期待を満たせない。したがって明示的な翻訳が要る。

問題は**どのコードを使うか**。1周目の計画は `SystemErrorCode.DatabaseError` を流用していたが、`packages/core/src/application/errors/index.ts` の `SystemErrorCode` の JSDoc は次を明記している。

- 「Add a new entry per external resource you integrate」（外部リソースごとに1エントリ足せ）
- 「`DatabaseError` は *the storage layer threw*（接続断・ロックタイムアウト）の意」／`DataIntegrityError` との区別は「ログ・アラートを別ルーティングにするため」

Cookie ヘッダーの書き込み失敗を `DATABASE_ERROR` として記録すると、この JSDoc が挙げているルーティング用途がノイズを拾う（「`DATABASE_ERROR` の急増 = DB 障害」という運用上の読みが崩れる）。

選択肢:

1. `DatabaseError` を流用し、理由（将来テーブル方式に差し替えたときの DB 障害を同一経路に載せる）を `session.ts` の JSDoc に残す
2. `SystemErrorCode` に `SessionError: "SESSION_ERROR"` を1エントリ足す

### Decision

**2 を採る。** `SystemErrorCode` に `SessionError: "SESSION_ERROR"` を追加し、`RETRYABLE_SYSTEM_CODES` には**入れない**（Cookie ヘッダーの書き込みは再試行しても直らない）。コード表の JSDoc が「外部リソースごとに1エントリ」と明示的に拡張を促している以上、流用より追加のほうが表の意図に沿う。

翻訳自体は `toSessionSystemError(cause): SystemError` という**純関数**として `apps/web/app/presentation/sessionCookie.ts`（`server-only` を import しないモジュール）に置き、`session.ts` の `startSession` / `endSession` から呼ぶ。こうすると TC-logout-003 の自動検証対象が純関数側に残るので、`server-only` を含むモジュールが node プールから読めない場合でもカバレッジが崩れない（plan.md ステップ2の分岐 (c) / ステップ15）。

将来 `SessionCodec` をテーブル方式（サーバーサイドセッション）へ差し替えたときの DB 障害は、その時点で storage layer 由来なので `DatabaseError` として区別できる。同一経路に載せる必要はない。

### Consequences

- 良い点:
  - ログ・アラートのルーティングが `DATABASE_ERROR` の意味を保ったままセッション障害を分離できる
  - `redactForClient` が `kind: "system"` の `code` を潰すので、コードを増やしてもクライアント側の表示・情報漏洩には影響しない
  - `toSessionSystemError` の切り出しにより、TC-logout-003 の検証手段が `server-only` の読み込み可否に依存しなくなる
- **層の字面差（spec-sync 対象）**: `spec/inventory/test.md` と `spec/testcases/identity/logout.md#L11` は TC-logout-003 を「**アダプター層で** `SystemError` として扱われれば PASS」と書くが、本実装の翻訳地点は presentation（`apps/web/app/presentation/{sessionCookie,session}.ts`）である。セッションを扱うアダプターが存在しない以上ほかに置き場がなく、同じ spec が TC-logout-002 で「セッション破棄は presentation 責務」と書いているので、**presentation 側に寄せて spec の内部不整合を解消した**。ADR-009 / ADR-011 と同じく spec-sync 対象として記録する（→ round-3 coverage S-001）
- トレードオフ:
  - テンプレートが提供する `SystemErrorCode` の値集合に fog 固有のエントリが1つ増える（テンプレート追従時の差分になる）。JSDoc 自身が拡張を前提にしているので許容する
  - `SESSION_ERROR` を送出する箇所が本 Issue では `session.ts` の2関数だけで、実際に発火する経路がほぼ無い（テストの失敗注入でのみ通る）

### 実測結果（plan.md ステップ2 / 2026-07-25）

捨てテスト `apps/web/app/presentation/__tests__/_probe.test.ts` で3点を計測し、**(a)(b)(c) すべて成功**した（確認後に削除済み）。

- (a) ルート `vitest.config.ts` は設定変更なしで `apps/web` 配下の `*.test.ts` を拾う
- (b) `@/*` エイリアスは node プールで解決される
- (c) **`import "@tanstack/react-start/server-only";` を含むモジュールは node プールから問題なく import できる**

したがって plan.md ステップ2の分岐は **(c) 成功パス**を採る: ステップ15では `session.test.ts` で `endSession` に throw する `setCookieHeader` スタブを渡す形をそのまま書ける。ただし `toSessionSystemError` の純関数としての切り出しは本 ADR の Decision どおり実施する（(c) の成否に関わらず行う、と定めてあるため）。ルート `vitest.config.ts` への projects / alias 追加は不要。

---

## ADR-011: `PlainPassword` の漏出防止を実装ではなくテスト＋レビュー観点で担保する

### Status

Proposed

### Context

`spec/inventory/domain.md` の DOM-identity-006 は `PlainPassword` の要点を「8〜128文字を検証（違反は PasswordTooWeak）。**ログ・イベント・永続化への漏出を防止する実装を持つ**」と定義し、`spec/domains/identity.md#PlainPassword` も「等価性: 文字列一致（ただしログ・イベント・永続化には決して含めない。**`toString` を無効化するなど漏出防止を実装で担保する**）」と書いている。

しかし**同じ spec が「フィールド: `string`（ブランド型）」とも書いている**。ブランド付き `string` は実体がプリミティブなので、`toString()` を `"[REDACTED]"` に、`toJSON()` を `undefined` にするオーバーライドを載せる先が無い。載せるには `PlainPassword` だけをボックス化したオブジェクト VO にする必要があり、fog の他の VO（`UserId` / `Email` / `PasswordHash` …）がすべてブランド付きプリミティブである規約と不揃いになる。つまり spec の内部に緊張がある。

選択肢:

1. `PlainPassword` だけオブジェクト VO にして `toString` / `toJSON` をオーバーライドする
2. ブランド付き `string` のままとし、漏出防止をテストとレビュー観点で担保する

### Decision

**2 を採る。** VO の書き方の一貫性（ブランド付きプリミティブ）を崩さず、漏出防止は次の2つのテストで縛る。

| 代替の担保 | テスト | 何を縛るか |
|---|---|---|
| イベントへの漏出 | `domain/identity/__tests__/entity.test.ts` | `User.registerWithPassword(...)` が返す `identity.userRegistered` のペイロードのキー集合を表明し、値の再帰走査で平文文字列を含まないことも表明する |
| View（レスポンス）への漏出 | `application/identity/__tests__/identity.integration.test.ts`（TC-getCurrentUser-003 と同じ表明） | `CurrentUserView` のキー集合が `{ userId, email, authMethod, trashRetentionDays }` に完全一致し、平文・`passwordHash` を含まないこと |

永続化への漏出は、`users` テーブルに平文列が存在しない（`password_hash` のみ）ことで構造的に閉じている。**ログへの漏出だけはテストで縛れない**ので、「`PlainPassword` 型の値を `logger.*` の引数に渡さない」を PR レビュー観点として残す。

DOM-identity-006 は「8〜128文字の検証」を実装し「漏出防止の実装」を持たない**部分実装**であることを、チェックリスト対応表のセルとカバレッジ注記の両方に明記する（DOM-identity-018 / ADP-identity-001 の「email 制約側のみ」と同じ扱い）。spec の字面との差は **spec-sync 対象**として残し、spec 側を「ブランド付きプリミティブのため漏出防止はテストで担保する」と改める提案を別途行う。

### Consequences

- 良い点:
  - VO の書き方が全 identity で1つに揃う。`PlainPassword` だけ生成・取り回しが違うという例外を作らない
  - 「型で守れないものを守れているふりをしない」— 実際に漏出を止めているのはテストとレビューであることが計画上明示される
  - 表明するテストが TC-getCurrentUser-003 と重なるので、追加コストがほぼ無い
- トレードオフ:
  - `console.log(plainPassword)` のようなコードは型検査で止まらない。レビューでしか防げない
  - spec の字面と食い違うので、レビューや spec-sync で「spec 違反」と誤検出されうる。本 ADR がその判断の記録になる

---

## ADR-012: SSO `providerSubject` の検証をエンティティに置き、専用エラーコードを追加する

### Status

Accepted（実装時に決定）

### Context

`plan.md`「設計」節の `IdentityErrorCode` 列挙は8コード（`InvalidUserId` / `InvalidEmail` / `PasswordTooWeak` / `InvalidPasswordHash` / `UnsupportedSsoProvider` / `InvalidClientName` / `InvalidAiClientConnectionId` / `InvalidTrashRetentionDays`）で、`providerSubject` の検証コードを持たない。一方 `spec/domains/identity.md#User` は `providerSubject: string // IdP 内の主体ID（sub）。空文字不可` と明記し、`spec/database/index.md#users` も `users_sso_subject_nonempty`（`length(sso_provider_subject) > 0`）を要求する。

また `providerSubject` は VO ではなく素の `string` として型定義されている（同 spec のフィールド表）ので、他フィールドのように「VO の `create` が検証する」経路が存在しない。検証の置き場所が決まっていない。

選択肢:

1. 検証しない（DB の CHECK だけに任せる）
2. `providerSubject` を VO 化する
3. エンティティ（`registerWithSso` / `reconstruct`）に検証を置き、専用エラーコードを1つ追加する

### Decision

**3 を採る。** `entity.ts` にモジュール内プライベート関数 `createProviderSubject(raw): string` を置き、`registerWithSso` と `reconstruct` の SSO 分岐の両方から通す。違反は新設の `IdentityErrorCode.InvalidSsoProviderSubject`（`"IDENTITY_INVALID_SSO_PROVIDER_SUBJECT"`）。

- 1 は不可: `users_sso_subject_nonempty` は防御の二重化として置いたものであり、一次の担保をアプリケーション側に持たないと ADR-008 と同じ「遅延バッチ UoW では制約違反が flush 時にしか出ない」問題で、空文字が `ConflictError` として返る
- 2 は spec のフィールド型（`string`）と食い違ううえ、SSO スライスまで使い道のない VO が1つ増える。VO 化が必要になったらそのときに引き上げればよい（検証ロジックは1関数に閉じているので移設コストは小さい）

あわせて `reconstruct` の未知 `auth_method` は `BusinessRuleError` ではなく素の `Error` を throw する。`reconstruct` の catch がすべてを `RehydrationError` で包み、アダプターが `SystemError(DataIntegrityError)` に翻訳するため、ここでユーザー向けのエラーコードを名乗る意味がない。

### Consequences

- 良い点:
  - `spec/domains/identity.md` の「空文字不可」が SSO スライスを待たずに実装で担保され、`SsoUser` の再水和（TC-getCurrentUser-002 / 004）が構造的に安全になる
  - 検証点が1関数に集約され、`registerWithSso` と `reconstruct` で規則がずれない
- トレードオフ:
  - `IdentityErrorCode` が plan.md の列挙より1つ多くなる。`errorDisplay.ts` の日本語文言（plan.md ステップ17）には現れない — 本スライスで `IDENTITY_INVALID_SSO_PROVIDER_SUBJECT` がユーザーに到達する経路が無い（SSO 登録ユースケースを配線しないため）。SSO スライスで文言を足す

---

## ADR-013: `Email` の形式検証は構造的パターンに留める

### Status

Accepted（実装時に決定）

### Context

`spec/domains/identity.md#Email` は「trim・小文字化の正規化後、メールアドレス形式（`local@domain` 構造、最大320文字）であること」とだけ書く。`spec/testcases/identity/registerWithPassword.md` が挙げる不正例は「`@` なし」「`local@` のみ」の2つで、正常系には「正規化後ちょうど320文字の有効なメールアドレス」が含まれる。

RFC 5322 準拠の完全な文法を実装するか、spec の字面どおり構造だけを見るかで、境界の広さが変わる。厳しすぎるパターンは正当なアドレス（`user@localhost`、新 gTLD、quoted local part 等）を弾き、緩すぎるパターンは spec の不正例を通してしまう。

### Decision

**`/^[^\s@]+@[^\s@]+$/` + 320文字上限**に留める。ドメイン部に `.` を要求しない。

理由: spec が定義する構造は `local@domain` であり、それ以上の制約は spec に書かれていない。アドレスが実在するかの最終的な権威はメールの到達可否であって正規表現ではないので、spec を超えて厳しくすると「仕様にない理由で登録できないユーザー」を作る。spec の挙げる不正例2つはこのパターンで両方とも弾ける。

### Consequences

- 良い点: spec の字面と1対1で、テストケースの期待と一致する。境界値（320文字ちょうど）も素直に通る
- トレードオフ: `user@example`（ドット無しドメイン）が有効として通る。実運用でメール到達性が要るのはパスワードリセット（P-03、後続スライス）であり、そこで送信基盤が弾く。より厳しい検証が必要になった場合は `EMAIL_PATTERN` 1箇所の差し替えで済む

---

## ADR-014: パスワードハッシュ計算の失敗に `SystemErrorCode.CryptoError` を新設する

### Status

Accepted（実装時に決定）

### Context

`spec/usecases/identity.md` と plan.md ステップ10 は「ハッシュ計算失敗は `SystemError`」と定めるが、どの `SystemErrorCode` を使うかは決めていない。既存のコード表は `DatabaseError` / `DataIntegrityError` / `NetworkError` / `ExternalApiError` の4つで、WebCrypto の `importKey` / `deriveBits` が throw したケースに当てはまるものが無い。

同ファイルの `SystemErrorCode` の JSDoc は「Add a new entry per external resource you integrate」と拡張を明示的に促しており、ADR-010（`SessionError` の新設）が既に同じ判断を採っている。

なお `verify` の失敗には**性質の異なる2種類**がある。

1. 保存済みハッシュが `pbkdf2-sha256$<iterations>$<salt>$<hash>` 形式として読めない（形式不正・base64 破損・反復回数が非整数）
2. 計算そのものが失敗した（WebCrypto が throw した）

### Decision

- `SystemErrorCode` に **`CryptoError: "CRYPTO_ERROR"`** を追加する（`RETRYABLE_SYSTEM_CODES` には入れない）。`hash` / `verify` のうち **2（`importKey` / `deriveBits` の throw）** をこのコードに翻訳する
- **1（保存値が読めない）は `DataIntegrityError` を使う。** JSDoc が `DataIntegrityError` を "stored data violates the shape we expect" と定義しており、まさにこのケースに一致する。`users.password_hash` に schema-skew した値が入っている＝マイグレーションかデータ移行の破綻であって、暗号サブシステムの障害ではない。両者を分けることでログ・アラートのルーティングが「CRYPTO_ERROR の急増 = ランタイムの暗号実装の問題」「DATA_INTEGRITY_ERROR の急増 = データの問題」と読める

### Consequences

- 良い点:
  - 「保存値が壊れている」と「計算できない」が運用上区別できる。前者はデータ修復、後者はランタイム調査と対処が異なる
  - `redactForClient` が `kind: "system"` の `code` を潰すので、コードを増やしてもクライアント表示・情報漏洩には影響しない
  - 将来 Argon2id(WASM) へ移行しても、WASM のロード失敗・メモリ不足は同じ `CryptoError` に収まる
- トレードオフ:
  - テンプレートが提供する `SystemErrorCode` の値集合に fog 固有のエントリが（ADR-010 の `SessionError` に続いて）もう1つ増える。テンプレート追従時の差分になるが、JSDoc 自身が拡張を前提にしている
  - 実際に発火する経路は本スライスでは存在しない（WebCrypto が throw する状況をテストで再現しない限り通らない）

---

## ADR-015: AWS の `SESSION_SECRET` は Secrets Manager 参照で配る

### Status

Accepted（実装時に決定）

### Context

plan.md ステップ11-7-2 は「`infra/aws/lib/appStack.ts` の `appFn.environment` に足す（Secrets Manager 参照が妥当なら `DATABASE_AUTH_TOKEN_SECRET_ARN` と同じ流儀で）」と、2つの実現手段を選択肢として残していた。

- (a) 平文の環境変数として `appFn.environment.SESSION_SECRET` に載せる
- (b) `DATABASE_AUTH_TOKEN_SECRET_ARN` と同じく ARN を渡し、Lambda のコールドスタート時に `loadSecretsIntoEnv` で解決する

(a) は CDK の変更だけで閉じるが、値が CloudFormation テンプレートと Lambda コンソールに平文で残る。(b) は `apps/web/app/server.aws.ts` の `boot()` に binding を1つ足す必要がある（plan.md ステップ11の対象ファイル一覧には含まれていない）。

### Decision

**(b) を採る。** 追加は次の4点。

- `AppStackProps` に `sessionSecretArn` を追加し、`bin/app.ts` が `SESSION_SECRET_ARN_{STAGE}` から読む（未設定のステージは既存の `continue` でスキップされる）
- `appFn.environment.SESSION_SECRET_ARN` にだけ載せる。**`sharedEnv` には入れない**ので relay / consumer / pruner / dlq の4 Lambda には配られない
- `sessionSecret.grantRead(appFn)` のみ付与する（他の Lambda には付与しない）
- `server.aws.ts` の `boot()` が `SESSION_SECRET_ARN` を既存の `secretBindings` 配列に追加し、`SESSION_SECRET` として `process.env` に展開してから `readAwsServerEnv()` を呼ぶ

`server.aws.ts` への波及は6行で、既存の Turso トークンと同じ配列に1エントリ足すだけ。plan.md の対象ファイル一覧を1本超えるが、(b) を選ぶ以上この配線なしには値が届かない。

GCP 側は Terraform 変数（`sensitive = true`）のまま据え置く。Cloud Run は Secret Manager のマウントが標準機能として存在し、`DATABASE_AUTH_TOKEN_SECRET_NAME` の既存コメントも「Cloud Run's built-in secret mounting usually removes the need for this」と書いている。ここで独自のブートストラップ経路を増やすより、変数を露出させて運用側にマウントの選択を委ねるほうがランタイムの流儀に合う。

### Consequences

- 良い点:
  - セッション鍵が CloudFormation テンプレート・スタック差分・Lambda コンソールのどこにも平文で現れない
  - 秘密の配布範囲がリクエストパスの1関数に限定され、IAM 上も `grantRead` が1つだけになるので「誰が読めるか」が監査で一目でわかる
  - Turso トークンと同じ流儀なので、運用手順（Secrets Manager にシークレットを作り ARN を env で渡す）が1つで済む
- トレードオフ:
  - コールドスタートに Secrets Manager 呼び出しが1回増える（Turso トークンと同一の `loadSecretsIntoEnv` 呼び出しにまとまるので往復自体は増えない）
  - `bin/app.ts` の必須 env が1つ増える。未設定のステージは synth からスキップされるだけなので、気づかず不完全なスタックが出る心配はない
