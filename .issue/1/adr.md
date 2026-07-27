# ADR — Issue #1: [skeleton] 基盤＋アカウント登録・ログイン

> **Superseded pointer（Issue #19、2026-07-28）**
>
> このファイルの本文はIssue #1実装時の判断履歴として保持する。ADR-004を含むNode/libSQL主経路、複数runtime、共有DB transaction、非同期イベント配送に関する判断はIssue #19で置換された。現行設計はCloudflare request Worker + state/DO Worker、User Data / Identity Directory / Account Homeの3 SQLite-backed Durable Object class、同期FTS5 projection、Alarm永続job、identity saga primitivesである。参照先: [`spec/database/index.md`](../../spec/database/index.md)、[`spec/domains/identity.md`](../../spec/domains/identity.md)、[`spec/domains/search.md`](../../spec/domains/search.md)、[`.thread/19/adr.md`](../../.thread/19/adr.md)。

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

---

## ADR-016: `?redirect=` の二重スキーマを `presentation/redirectSearch.ts` に置く

### Status

Proposed

### Context

plan.md「UI / プレゼンテーション」は `?redirect=` を「`/` で始まり `//` を含まない」に限定し、`paginationSearchSchema` と同じ二重スキーマ（`validateSearch` は `catch` 付き / server fn 側は strict）で扱うと定めているが、その置き場所は指定していない。候補は2つあった。

- (a) `apps/web/app/components/auth/schema.ts` — 認証まわりの transport スキーマを1ファイルにまとめる
- (b) `apps/web/app/presentation/redirectSearch.ts` — 既存の `presentation/pagination.ts` と同じ扱いにする

`?redirect=` を組み立てるのは `presentation/currentUser.ts` の `requireUserId()` と `routes/_app.tsx` の `beforeLoad` であり、消費するのは `routes/login.tsx`。**`components/auth/` を参照しない地点が発生源**なので、(a) を選ぶと presentation → components の逆向き参照が生まれる。

### Decision

**(b) を採る。** `REDIRECT_MAX_LENGTH` / `redirectPathSchema`（strict）/ `redirectSearchSchema`（`catch(undefined)` 付き）/ `toSafeRedirect()` / `DEFAULT_REDIRECT_PATH` を `apps/web/app/presentation/redirectSearch.ts` に置く。URL 検索パラメータの transport スキーマを presentation に置くのは `pagination.ts` が既に敷いた流儀であり、CLAUDE.md の「presentation = TanStack Start 固有の横断ユーティリティ」の定義にも一致する。

`components/auth/schema.ts` はフォーム本文（email / password）の shape / DoS 検証だけを持つ。

拒否条件は「`/` で始まる」「`//` を含まない」に加えて **バックスラッシュを含まない**（ブラウザが `/\evil.example` を `//evil.example` に正規化するため）と **`/%2f` で始まらない**（デコード後に `//` になるため）も含める。

### Consequences

- 良い点: 依存の向きが内向きのまま保たれ、`?redirect=` を使う新しい画面が増えても参照先が1つに定まる
- トレードオフ: 認証まわりの transport 検証が2ファイルに分かれる。役割（URL 検索パラメータ / フォーム本文）で分かれているので混同はしにくい

---

## ADR-017: デザイントークンの Tailwind 投影と、tokens.md に無い派生トークンの追加

### Status

Proposed

### Context

`spec/design/tokens.md` は CSS カスタムプロパティとしてトークンを定義しているが、実装は Tailwind v4 であり、ユーティリティを生やすには `@theme` の名前空間（`--color-*` / `--text-*` / `--spacing-*` / `--radius-*` / `--shadow-*` / `--font-weight-*` / `--leading-*` / `--tracking-*`）へ投影する必要がある。一方で `--pad-btn` / `--icon-md` / `--border-input` / `--content-max` / `--sidebar-w` のように**対応する名前空間が存在しない**トークンもある。

また、承認済みモック（`spec/design/pages/*.html`）には tokens.md に無い生値がいくつか現れる（body 背景グラデーションの停止位置 240px、`.form-input` の `padding: 12px 16px`、`.auth-sheet` の `max-width: 26rem`、ブランドの点 6px、ナビの現在地マーク 5px、ボトムシートのハンドル 36×4px、ヘッダーとシートが共有する横フレーム幅の式）。「生値を書かない」という一貫性ルール（spec/design/index.md）を守るには、これらを (a) 実装側でその都度書く か (b) 役割名を持つトークンとして追加する のどちらかを選ぶ必要がある。

### Decision

- **投影**: `tokens.css` は spec の値をそのまま持つ（レイヤー無しの `:root`）。`theme.css` は `@theme` へ**名前空間のあるものだけ**を投影する。名前空間の無いトークンは `p-(--pad-btn)` / `size-(--icon-md)` / `[border:var(--border-input)]` のような Tailwind の任意値構文で消費する — 値は依然としてトークン経由で、生値は書かれない
- **半段階の削除**: テンプレートが `@theme` に持っていた `--color-neutral-{150,250,…,850}` は spec に存在しないので削除する（放置すると未定義参照が8個残る）
- **`--color-bg-section` の削除**: spec が「使用しない（面の分割は罫線で行う）」と明記しているトークンをユーティリティとして露出させると、使えてしまう
- **派生トークンの追加**: モックの生値は spec/design/index.md が示す (b)「トークン化すべき意図的な新しい役割」として `tokens.css` に**役割名で追加**する。追加したのは次の8つ
  - `--gradient-page`（ページ背景。停止位置を各画面へ散らさないため1つの役割にする）
  - `--pad-input`（入力欄の内側余白。`--pad-btn` と同じ「コンポーネント余白」系列）
  - `--auth-sheet-max`（認証シートの最大幅）
  - `--sheet-w` / `--sheet-w-md`（ヘッダーとシートが共有する横フレーム幅）・`--nav-sheet-inset`（ボトムシートの左右位置）
  - `--size-dot` / `--size-mark` / `--size-handle-w` / `--size-handle-h`（「点」として置く小さな図形の寸法）
  - `--duration-fast` / `--duration-default`（`--transition-fast` / `--transition-default` を Tailwind の `duration-*` が要求する形に分解したもの。shorthand 側がこれらを参照するので値は1箇所）
- **`--bp-*` は追加しない**。spec のブレークポイント（640/768/1024/1280/1536）は Tailwind v4 の既定値と完全に一致するので、`sm:` / `lg:` をそのまま使う

追加した8トークンは `spec/design/tokens.md` に**まだ存在しない**ため、spec-sync の対象として記録する。

### Consequences

- 良い点:
  - 実装のどこにも hex / px の生値が現れず、AC-18 を機械的に確認できる（`bg-neutral-200` / `text-red-500` 等のテンプレート既定パレット由来クラスも全滅している）
  - `theme.css` と `tokens.css` が lockstep になり、「トークンに無い名前のユーティリティ」は生成されない
- トレードオフ:
  - 実装のトークン集合が spec/design/tokens.md より8つ多い状態が一時的に生じる。spec-sync で tokens.md 側に取り込むまでは、モックと実装のどちらを見ても値は一致する（値はモックから採っている）
  - 名前空間の無いトークンは `p-(--pad-btn)` という書き方になり、素の Tailwind に比べて冗長になる

---

## ADR-018: 認証画面に SSO ボタンを描画せず、パスワードのヘルパー文もモックから変える

### Status

Proposed

### Context

plan.md のスコープ節は「動かない SSO ボタンは置かない」と決めている。実装時に、同じ理由でモックと乖離させるべき箇所がもう1つ見つかった: `spec/design/pages/signup.html` のパスワード欄のヘルパー文が「**8文字以上。大文字・小文字・数字を含む**」となっている。しかし `PlainPassword`（DOM-identity-006 / spec/domains/identity.md）の制約は **8〜128文字だけ**で、文字種の要件は存在しない。モックのまま書くと、UI が実際には課されない規則をユーザーに要求することになる。

### Decision

- SSO ボタン（`.sso-group` / `.divider-text`）は `/login` `/signup` のどちらにも描画しない（plan.md のスコープ節どおり）
- パスワード欄のヘルパー文は「**8文字以上128文字以下**」とし、ドメインの制約と一致させる。`PlainPassword` の制約が変われば同時に変える1箇所として `SignupForm` に置く
- `/login` 側にはヘルパー文を置かない（ログイン時に規則を示しても操作の助けにならない。spec/design/index.md「UI は言葉で説明しない」）

### Consequences

- 良い点: 画面が課す規則と実装が課す規則が一致し、`IDENTITY_PASSWORD_TOO_WEAK` の日本語文言（「パスワードは8文字以上128文字以下で入力してください」）とも矛盾しない
- トレードオフ: 承認済みデザイン HTML との差分が2箇所（SSO ブロック・ヘルパー文）になる。どちらも「実装が仕様に合わせた」差分なので、SSO スライスとあわせて spec-sync / デザイン更新の対象として記録する

---

## ADR-019: 統合テストの障害注入は「ポートのスタブ」と「テーブルの一時 rename」で行う

### Status

Accepted（実装時に決定）

### Context

失敗系の TC が5件あり、どれも「実 DB / 実アダプターの経路で失敗を再現する」ことを要求する。

| TC | 再現すべき失敗 |
|---|---|
| TC-registerWithPassword-015 | `PasswordHasher.hash` の失敗 |
| TC-registerWithPassword-016 | `UserRepository.insert` の DB 例外（ロールバック・イベント未記録つき） |
| TC-loginWithPassword-010 | `findByEmail` の DB 例外 |
| TC-loginWithPassword-011 | `PasswordHasher.verify` の計算失敗 |
| TC-getCurrentUser-009 | `findById` の DB 例外 |

DB 側の障害を「制約違反」で作ることはできない。`mapDbError` は `SQLITE_CONSTRAINT*` をすべて `ConflictError` に分類し、さらに UNIQUE / PK は `constraintViolationCode` が同じ `UNIQUE_VIOLATION` に潰すので、ADR-008 の読み替えを通って `EMAIL_ALREADY_REGISTERED` に化ける。`SystemError` には到達しない。

### Decision

**ハッシャー系はポートのスタブ、DB 系はテーブルの一時 rename** で注入する。

1. **`PasswordHasher` の失敗**（015 / 011）— `createTestContainer({ passwordHasher })` に `SystemError(CryptoError)` を投げるスタブを渡す。**この形なので、テストが表明しているのは「ユースケースがアダプター由来の `SystemError` を握り潰さず・翻訳もせずそのまま通す」ことである**（`PasswordHasher` ポートの契約上、失敗を `SystemError` にするのはアダプターの責務であって、ユースケースは何もしないのが正しい）。あわせて「ユーザー行が作られない」「outbox が空」も表明し、単なる再送ではないことを担保する。
2. **読み取りの DB 障害**（010 / 009）— `ALTER TABLE users RENAME TO users_hidden` で読み取り対象を消し、`finally` で戻す。非制約系なので `mapDbError` は `SystemError(DATABASE_ERROR)` に落とす（`d1/__tests__/helpers.integration.test.ts` の「非制約系は DATABASE_ERROR」と同じ経路）。
3. **insert の DB 障害**（016）— rename を**ユースケース呼び出しの前に置くと `findByEmail`（事前検証の読み）で落ちてしまい、insert を検証したことにならない**。そこで `UnitOfWorkContext` をラップし、`userRepository.insert` が実 insert を pending batch に登録した**直後に** rename する `UnitOfWorkProvider` をテスト内で組む。UoW は遅延バッチなので実際の失敗は flush 時に起き、「insert の書き込みが DB 例外で落ちる」形になる。ロールバックは `users` / `outbox_events` がともに空であることで表明する。

### Consequences

- 良い点:
  - 5件すべてが実アダプター・実 DB の経路を通る。リポジトリのフェイクを持ち込まずに済み、`docs/test.md` の「リポジトリのフェイクは置かない」方針と整合する
  - 016 が「事前検証の読み」ではなく「書き込み」の失敗を実際に検証できる
  - rename は `try / finally` で必ず戻すので、`d1/__tests__/setup.ts` の `beforeEach` TRUNCATE（`DELETE FROM users`）を壊さない
- トレードオフ:
  - 016 のラッパーは `UnitOfWorkContext` のメソッドを1つずつ委譲するので、ポートにメソッドが増えるとこのテストも足す必要がある（型検査で検出される）
  - `finally` の rename が失敗すると同一ファイルの後続テストが道連れになる。`ALTER TABLE` は D1 でも同期的に成功する単純な DDL なので許容する

---

## ADR-020: `session.ts`（`server-only`）を node プールの単体テストで直接の対象にする

### Status

Accepted（実装時に決定）

### Context

plan.md のテスト方針は TC-logout-003 に条件付きの指示を置いていた: 「ステップ2の疎通確認で `server-only` の import が node プールで通らないと判明した場合は、`session.test.ts` を置かず `sessionCookie.test.ts` 側で純関数 `toSessionSystemError` を対象にする」。

実測したところ、`apps/web/app/presentation/session.ts` は `@tanstack/react-start/server-only` と `@tanstack/react-start/server` を import しているにもかかわらず、ルートの node プール（`vitest.config.ts`）で問題なく読み込め、`endSession(setCookieHeader)` を直接呼べた。

### Decision

**両方を置く。**

- `sessionCookie.test.ts` — Cookie 組み立ての純関数と `toSessionSystemError` 単体（TC-logout-002 / 003 の受け皿部分）
- `session.test.ts` — throw する `setCookieHeader` スタブを渡した `endSession` が `SystemError(SessionError)` を投げ、`serializeError` が `kind: "system"` を返すこと（TC-logout-003 の本体）

`toSessionSystemError` は「node プールで読めなかった場合の受け皿」として作られたが、読めた今も残す。`session.ts` の `catch` 節が「なぜ握り潰さずに包み直すのか」を1箇所に閉じ込める役割は変わらないため。

### Consequences

- 良い点: TC-logout-003 が「翻訳する純関数」ではなく「実際に翻訳が起きる関数（`endSession`）」で検証される。plan.md が代替案として許容していた範囲より強い
- トレードオフ: `apps/web` 配下の単体テストが `server-only` の解決可能性に依存する。TanStack Start のバージョン更新で解決が壊れると `session.test.ts` だけが落ちるが、そのときは受け皿（`sessionCookie.test.ts` 側の `toSessionSystemError` テスト）がそのまま代替になる

---

## ADR-021: 暗号アダプターのファクトリで自分の引数を検証する

### Status

Accepted（レビュー指摘 review-001-adapters W-004 / W-006 への対応）

### Context

`createHmacSessionCodec({ secret })` と `createPbkdf2PasswordHasher({ iterations })` はどちらも引数を無検査で受けていた。鍵長32文字以上という不変条件は `application/di/secrets.ts` の `requireSessionSecret` にしかなく、反復回数の下限はどこにも無い。したがってアダプターを直接構築する経路（テストヘルパー、将来の `apps/*` パッケージ、新しいエントリポイント）は不変条件を1つも通らない。

CLAUDE.md は「Validate at the boundaries（transport in, value-object construction）」と定めており、ファクトリはこれらのアダプターにとっての construction boundary である。ADR-003 は反復回数をファクトリ引数にした帰結として「呼び出し側が誤って低い値を渡す余地」を認めつつ、運用上の約束だけで塞いでいた。

あわせて `verify` の `parse()` は保存ハッシュの反復回数に下限（`>= 1`）しか課しておらず、`Number()` が `" 12 "` のような非正規表現も受理していた。桁の異常な値は1回のログインを CPU バウンドで事実上ハングさせる。

### Decision

- `MIN_SESSION_SECRET_LENGTH = 32` を `hmacSessionCodec.ts` に置き、ファクトリが下回る `secret` を throw する。`di/secrets.ts` の同名定数は**共有せず二重に持つ**。DI 側は「env の欠落を運用者に読める言葉で伝える」役割、アダプター側は「構築境界の不変条件」で、目的が違う。`packages/core` の内部依存を application → adapters の向きに増やさない利点もある（現状 DI がアダプターを import する向きしかない）
- `MIN_PBKDF2_ITERATIONS = 1_000` を置き、整数でない／下回る `iterations` を throw する。本番強度ではなくテスト実行可能性を残す高さに取る（ADR-003 が「テストが払えるコストで動かすための引数」と定めているため）
- `parse()` に `MAX_PBKDF2_ITERATIONS = 10_000_000` の上限と `/^\d+$/` の事前検査を足し、逸脱を既存の `DataIntegrityError` に落とす。ADR-014 の「保存値が読めない = データの問題」の分類をそのまま使う

throw は素の `Error`。到達するのは配線の誤りだけで、ユーザーに見せるエラーコードを名乗る意味がない（ADR-012 の `reconstruct` と同じ整理）。

### Consequences

- 良い点:
  - 不変条件が「秘密を実際に使う地点」に移り、DI を経由しない構築経路でも守られる
  - 上限検査により、破損行1件が1リクエストを無期限に占有する経路が閉じる
- トレードオフ:
  - `MIN_SESSION_SECRET_LENGTH` が2箇所に存在する。値が食い違うと DI 側だけが緩い状態になりうるが、厳しい側（アダプター）が最後に効くのでフェイルクローズ
  - `MIN_PBKDF2_ITERATIONS` は 210,000 に対して3桁低く、「安全な下限」ではない。防いでいるのは `0` / `1` のような明らかな誤配線だけである点を JSDoc に明記した
  - 既存テスト `pbkdf2PasswordHasher.test.ts` が反復回数の読み戻しを 500 / 2,000 で表明していたので、1,000 / 2,000 に変更した（表明の内容は変わらない）

---

## ADR-022: AWS の CloudFront は Cookie / クエリを転送し、部分設定のステージは synth で失敗させる

### Status

Accepted（レビュー指摘 review-001-security W-007 / review-001-adapters W-002 への対応）

### Context

2つとも「AWS ランタイムでだけ、設定の不在が無症状で現れる」種類の問題である。

1. `appStack.ts` の `defaultBehavior` は `cachePolicy: CachePolicy.CACHING_DISABLED` だけを持ち `originRequestPolicy` を指定していなかった。CloudFront がオリジンへ転送するのは「キャッシュポリシー ∪ オリジンリクエストポリシー」に含まれる値だけで、`CachingDisabled` は cookies / headers / query strings のすべてが `none` である。したがって Lambda に `Cookie` が届かず、**AWS ではログイン状態が維持できない**。`?redirect=` も同様に落ちる。テンプレート由来の設定だが、Cookie 認証を最初に載せたのが本 Issue なので本 Issue で閉じる
2. `bin/app.ts` は ADR-015 で `SESSION_SECRET_ARN_<STAGE>` を必須化したが、未設定のステージは既存の `continue` で黙って synth から消える。`docs/runtime_aws.md` は3変数しか列挙していなかったため、手順どおりに `cdk deploy` した人はスタックが生成されない理由に到達できない

### Decision

- `defaultBehavior` に `originRequestPolicy: OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER` を足す。**`cachePolicy` は `CACHING_DISABLED` のまま維持する** — ここを `CACHING_OPTIMIZED` 等に変えると、キャッシュキーに Cookie が入らないまま認証済みレスポンスがキャッシュされ、他人のセッションが配られる。この理由をコードのコメントに残す。`Host` を除外するのは API Gateway オリジンの名前解決を壊さないため
- `bin/app.ts` は「4変数すべて未設定 = そのステージを使わない」だけをスキップとして扱い、**一部だけ設定されているステージは missing 変数名を挙げて throw する**。部分設定は意思表示ではなく設定漏れであり、黙って消えると「cdk deploy が何もしなかった」という追跡不能な形で現れる
- `docs/runtime_{node,cloudflare,aws}.md` に `SESSION_SECRET` の記載を足す（Node は環境変数表、CF は `wrangler secret put`、AWS は stage-keyed 変数・synth 例・秘密の表）。ADR-015 の「4ワーカーには配らない」も各所に1行添える

### Consequences

- 良い点:
  - AWS ランタイムでセッション Cookie が往復し、ADR-015 で作り込んだ秘密鍵配布が実際に機能する
  - 認証済みレスポンスが共有キャッシュに載らない性質は変わらない（`CACHING_DISABLED` を維持したため）
  - ステージ設定漏れがデプロイ前に、変数名付きで検出される
- トレードオフ:
  - `ALL_VIEWER_EXCEPT_HOST_HEADER` は全ビューアヘッダーを転送するので、`/assets/*` 以外はキャッシュヒット率を論じる余地が最初から無くなる。動的レスポンスのみを通す経路なので実害はない
  - 「未設定ステージは黙ってスキップ」という**テンプレート由来の挙動を一部変更した**。完全未設定のステージのスキップは維持しているので、staging だけを配線する使い方は従来どおり成立する

---

## ADR-023: 値オブジェクトの長さ制約は Unicode コードポイントで数える

### Status

Accepted（レビュー指摘 review-001-domain-usecase W-004 への対応）

### Context

`PlainPassword`（8〜128）・`Email`（320）・`ClientName`（100）はいずれも `String.prototype.length`、すなわち UTF-16 コードユニット数で長さを検証していた。`spec/domains/identity.md` は単位を書かず「8文字以上128文字以下」とだけ書くが、同じ spec 群の他ドメインは単位を明示しており、`DOM-memo-004` は「10,000 **コードポイント**上限」、`spec/testcases/memo/postMemo.md` は「UTF-16 コード単位数ではない」とまで書いている。

コードユニット基準はサロゲートペアを2として数えるので、絵文字4個（4文字）のパスワードが最小長8を通過する。パスワード強度の下限に直接効く実効的な緩和であり、上限側も逆向きに厳しくなる。

### Decision

**コードポイント基準に統一する。** `packages/core/src/domain/common/text.ts` に `codePointLength` を置き、identity の3つの VO がこれを使う。`for...of` はサロゲートペアを1回で回すため、`[...value].length` と違って中間配列を作らない。

`domain/common/` に置いたのは、この単位が identity 固有ではなく「spec の『N 文字』はコードポイントである」というドメイン横断の約束だからで、後続スライスの `MemoBody`（10,000）・エクスポートのスラッグ切り詰め（50）が同じ関数を共有する。

### Consequences

- 良い点:
  - 「文字」の定義が1箇所に集まり、memo / export スライスが単位を再発明しない
  - パスワード最小長が非 BMP 文字でも要件どおりに効く
- トレードオフ:
  - 書記素クラスタ（結合文字・ZWJ 絵文字）は依然として複数と数える。人間の見た目の「1文字」とは一致しないが、spec が採る単位はコードポイントであり、`Intl.Segmenter` に踏み込む理由は今のところない
  - `spec/domains/identity.md` の各 VO に単位の明記が無い点は spec 側の更新対象として残る（spec-sync 対象）

---

## ADR-024: `changeTrashRetentionDays` の同値 no-op を戻り値の形ではなくコメントで表明する

### Status

Accepted（レビュー指摘 review-001-domain-usecase W-001 への対応）

### Context

`User.changeTrashRetentionDays` は現在値と同じ値を渡されたとき、version を進めず・イベントも出さず・受け取った `user` をそのまま返す。`spec/testcases/identity/changeTrashRetentionDays.md` は「現在と同じ値 → 正常終了する（同一値の禁止規則は存在しない）」としか書いておらず、version とイベントの扱いを規定していない。

memo / knowledge の spec は同じ状況を戻り値で明示する設計になっている（`newRevision: null` / `changed: false`）。identity だけ暗黙で、しかも根拠がコードに無かった。

選択肢は (a) WHY コメントを足す、(b) `changed: boolean` 相当を戻り値に載せる、の2つ。

### Decision

**(a) を採る。** `spec/domains/identity.md#User` はこのファクトリの戻り値を `WithEventDrafts<User, IdentityEvent>` と型まで書いており、(b) は spec からの逸脱になる。no-op の判定は `entity === user`（同値なら同一参照）か `eventDrafts.length === 0` で呼び出し側から観測でき、UC-identity-012 を配線するときに `save` をスキップする判断はそれで足りる。判定手段があることも含めてコメントに書いた。

### Consequences

- 良い点: 空更新で version を進めない理由（設定画面の再送信が OCC 競合を作らない・保持期限を動かさないイベントを購読者に配らない）がコードの隣に残る
- トレードオフ: 「変わったか」が型に現れないので、呼び出し側が無条件に `save` を呼ぶ実装は依然として書ける。UC-identity-012 は本スライス外なので、配線時にこのコメントが読まれることに依存している
- `spec/domains/identity.md#User` への no-op 規則の追記は spec-sync 対象として残る

---

## ADR-025: `SESSION_SECRET` の検証を request config の構築時に寄せ、検証済みの型で持ち回る

### Status

Accepted（レビュー指摘 review-001-domain-usecase W-006 / review-001-adapters W-007 / review-001-security W-008 への対応）

### Context

3つのレビューが同じ `application/di/secrets.ts` を指していた。

- `RequestSecrets.sessionSecret` の型が `string` なので、4ランタイムの `readXxxRequestServerConfig` がすべて `env.SESSION_SECRET ?? ""` というセンチネルを噛ませていた。「秘密鍵が無い」が `""` という一見有効な値に化けている
- `requireSessionSecret` を呼ぶのは `createXxxRequestContainer` であり、これは**リクエスト毎**に走る。設定ミスは「起動は成功、全リクエストが素の 500」という形で現れ、PR 説明の「起動時エラー」とも食い違う
- Node ではその throw が `storage.run(...)` の前に出るので `errorResponseMiddleware`（redaction 境界）を通らない

ADR-004 の「env スキーマは optional、必須性は消費地点で」という判断自体は維持したい。ワーカー用のエントリポイントが同じ env リーダーを共有しており、必須にすると起動できなくなるためである。

### Decision

**検証を「コンテナ構築時」から「request config 構築時」へ1段上げ、結果をブランド型で持ち回る。**

- `SessionSecret = string & { readonly [sessionSecretBrand]: true }` を新設し、`requireSessionSecret` だけがこれを返す。`RequestSecrets.sessionSecret` の型をこれにする
- 4本の `readXxxRequestServerConfig` が `requireSessionSecret(env.SESSION_SECRET)` を呼ぶ。`?? ""` は消える
- `createXxxRequestContainer` は `secrets.sessionSecret` をそのまま `createHmacSessionCodec` に渡す（再検証しない）

Node / AWS / GCP は request config を boot / コールドスタートで**1回だけ**組むので、これで検証が起動時に移る。Cloudflare は `env` が fetch の引数として初めて現れる構造上リクエスト毎のままだが、ADR-004 の「消費地点で検証する」は変わらず成立する。

throw は素の `Error` のまま据え置く。到達するのは配線の誤りだけであり、値ではなく変数名しか含まないメッセージなので redaction を要しない（ADR-021 と同じ整理）。

### Consequences

- 良い点:
  - 「秘密鍵が未設定」という不正状態が `RequestSecrets` の型から消える。センチネルを4箇所から削除でき、将来 `secrets` を別経路から読む配線が増えても未検証値が入らない
  - Node / AWS / GCP では設定ミスがプロセス起動失敗として現れ、デプロイのヘルスチェックで捕まる
  - 検証が1リクエスト1回から1プロセス1回になる
- トレードオフ:
  - Cloudflare だけは依然としてリクエスト毎の検証で、起動時には検出されない。`.issue/1/testing.md` と PR 説明の「起動時エラー」はランタイム別に書き分ける必要がある
  - `RequestSecrets` をテストから組むには `requireSessionSecret` を通す必要がある（`requestContainerConfig.test.ts` を1行変更した）。ブランド型の狙いどおりの摩擦なので受け入れる

---

## ADR-026: ログインのタイミングオラクルを固定ダミーハッシュへの verify で潰す

### Status

Accepted（レビュー指摘 review-001-domain-usecase W-005 への対応）

### Context

`loginWithPassword` は失敗応答を `kind` / `code` / `message` まで完全に同一化しているが、応答時間は同一化していなかった。未登録アドレス・SSO アカウントは `verify` を呼ばずに即 throw し、登録済み＋パスワード誤りは PBKDF2 210,000 回を回してから throw する。同一化の目的が「登録有無の推測材料を与えない」ことである以上、数十 ms の差はその目的に対する穴である。

### Decision

**未登録・SSO の分岐でも `PasswordHasher.verify` を1回走らせてから同じエラーを投げる。** 照合先はモジュール定数のダミーハッシュで、アダプターの本番パラメータ（PBKDF2-HMAC-SHA256 / 210,000 回）で生成した固定値。保存ハッシュは自己記述形式なので、テスト用に低い反復回数のハッシャーを差し替えても、このダミーは自分の宣言どおりのコストで検証される（テストの既定は `FakePasswordHasher` なので実コストは発生しない）。

ダミー verify の**例外は握り潰す**。アルゴリズム差し替えでこの定数が読めなくなったときに、未登録アドレスへのログインが 500 に化けてはいけないためである。その場合は等時間化が今日の挙動まで劣化するだけで、ログインは動き続ける。

VO 生成失敗（メール形式不正・パスワード長違反）の経路は対象外とした。ストレージに触れないので登録有無を何も語らず、呼び出し側が自分で入力した内容しか反映しない。

### Consequences

- 良い点:
  - `spec/usecases/identity.md#loginWithPassword` が要求する「失敗応答の同一性」が、内容だけでなく所要時間についても成立する
  - 既存の失敗応答の同一性（TC-loginWithPassword-008）は変更していない
  - 「どの資格情報経路も verify を1回払う」ことを統合テストで表明した。時間そのものを測る表明は不安定なので、観測可能な代理として verify 呼び出し回数を数えている
- トレードオフ:
  - アプリケーション層のモジュール定数がアダプターの保存形式（`pbkdf2-sha256$...`）を1つ抱える。ポートに「ダミーハッシュ」を生やす案もあったが、spec が定義するポートの面（`hash` / `verify`）を実装都合で広げるほうが害が大きいと判断した。定数の役割と失効時の挙動は JSDoc に書いてある
  - 未登録アドレスへのログイン試行も本物と同じ CPU を消費するので、認証エンドポイントのレート制限の必要性は（N-005 の指摘どおり）むしろ上がる。本 Issue の範囲外

---

## ADR-027: `FakePasswordHasher` を「平文を含まないダイジェスト」にし、CHECK 制約は名前で表明する

### Status

Accepted（レビュー指摘 review-001-test W-007 / review-001-adapters W-005 への対応）

### Context

2つの独立した指摘が、同じ形の問題を指していた — **表明が実際には何も縛っていない**。

1. `FakePasswordHasher.hash` は `` `fake$${plain}` `` を返していた。つまり既定コンテナでの `users.password_hash` は**平文を部分文字列として含む**。ADR-011 が「永続化への漏出は `users` に平文列が無いことで構造的に閉じている」と言うのは正しいが、「hash の結果を保存している（平文をそのまま入れていない）」という別の性質は、`expect(passwordHash).not.toBe(PASSWORD)` では前置詞1つで必ず真になるため縛れていなかった
2. `users` の名前付き CHECK 6本と部分一意インデックスは、証拠が生成 SQL のテキストだけだった。`mapDbError` は `SQLITE_CONSTRAINT_CHECK` をすべて `ConflictError("CONSTRAINT_VIOLATION")` に潰すので、**どの CHECK が消えてもユースケースからの見え方は変わらない**（無症状の退行）

### Decision

- **`FakePasswordHasher` を FNV-1a ダイジェストに変える**（`fake$<8桁hex>`）。レビューが挙げた2案のうち、TC-001 の表明だけを `not.toContain` に直す案ではなく、フェイク自体を直す案を採る。前者は1テストしか強くならないのに対し、後者は**フェイクを使う全テストで「平文が列に入らない」が効く**。あわせて TC-registerWithPassword-001 の表明を `not.toContain(PASSWORD)` に、境界パスワードの登録（TC-007 / 008）にも同じ表明を置いた
- **実ハッシャーでの担保を1件足す**。TC-loginWithPassword-009 は実 PBKDF2（1,000回）を注入する唯一のテストなので、そこで `users.password_hash` が `pbkdf2-sha256$1000$` で始まり平文を含まないことを表明する。フェイクの側で縛れるのは「フェイクの出力が保存されている」ことまでで、「実アダプターの出力形式が保存されている」ことは実物でしか見られない
- **CHECK 制約は「拒否されること」ではなく「どの制約名で拒否されたか」を表明する**。ドライバの例外メッセージは制約名を含むが、drizzle が文だけを名乗る例外で包むので、`cause` を辿って連結した文字列に対して制約名の正規表現をあてる（`causeChain()`）。行はドメインを迂回した生 insert で作る — ドメイン経由では作れない行を DB が拒むことこそが検証対象だからである
- 制約名を1つに特定できるよう、**violating row は1本の CHECK だけに触れるように組む**。例外は `users_auth_method_valid` で、`auth_method` が値域外なら直和 CHECK も必ず同時に落ちるため、そこだけ `users_auth_method_(sum|valid)` を許容する

### Consequences

- 良い点:
  - 「平文が永続化されない」が、構造（列が無い）だけでなく**振る舞い**としても全統合テストで縛られる
  - AC-5 の「名前付き制約6本＋インデックス2本」が、生成 SQL の目視ではなく実行で確認される。とくに ADR-008 の安全性論拠が依存する `users_sso_identity_uq` の**部分性**（password 行を巻き込まないこと）が、d1 / libsql 双方で表明された
  - フェイクの JSDoc に「出力に平文を埋め込んではならない」と理由付きで書いたので、次に触る人が元の形へ戻す事故を防げる
- トレードオフ:
  - `causeChain()` はドライバの例外メッセージ文言に依存する。SQLite 系の「`CHECK constraint failed: <name>`」は d1 / libsql とも安定しているが、ドライバを替えるとこの6件が落ちる。落ち方は「制約が消えた」と区別できないので、そのときは失敗の読み替えが要る
  - フェイクのダイジェストは 32bit なので原理的には衝突しうる。テストが使うパスワードは十数種で実害は無いが、フェイクを「暗号的に正しい」と読まないこと

---

## ADR-028: レビュー 001 で追加した役割名トークン（skeleton / nav-sheet-pad-b）

### Status

Accepted（レビュー修正時に決定）

### Context

レビュー 001（frontend W-002 / W-011）が2件の生値を指摘した。

- `RoutePendingFallback` の `space-y-4` / `p-4` / `h-8` / `w-48` / `max-w-2xl` — いずれも Tailwind 既定スケール（`--spacing` / `--container-*`）由来で、`tokens.css` にも `theme.css` にも無い値。W-001 の修正で `/settings` に per-fragment のスケルトンを足すと、同じ寸法が2箇所に必要になる
- ボトムシートの `pb-2xl` — 基準形 `spec/design/pages/timeline.html` は `max(40px, env(safe-area-inset-bottom, 0px) + 24px)` で、safe-area 分が落ちている

`spec/design/index.md` は「生の値を書きたくなったら (a) 既存トークンに寄せるべき思いつきか、(b) トークン化すべき意図的な新しい役割のどちらか。後者なら役割の名前で追加してから使う」と定めている。スケルトンの行の高さは既存のどのトークン（`--icon-*` は「アイコン寸法」、`--space-*` は「余白」）とも役割が違うので (b)。

### Decision

ADR-017 の流儀（tokens.md に無い派生トークンは役割名で `tokens.css` に足す）に従い、次の4本を追加する。

| トークン | 値 | 役割 |
|---|---|---|
| `--skeleton-line-h` | `1rem` | プレースホルダーの本文1行分の高さ |
| `--skeleton-title-h` | `2rem` | プレースホルダーの見出し・ボタン1つ分の高さ |
| `--skeleton-line-w-short` | `12rem` | 短い行（ラベル・末尾行）の幅 |
| `--nav-sheet-pad-b` | `max(--space-2xl, calc(env(safe-area-inset-bottom, 0px) + --space-lg))` | ボトムシートの下端。ホームインジケータ帯を避ける |

`--nav-sheet-pad-b` は基準形の `40px` / `24px` を `--space-2xl` / `--space-lg` に置き換えた同値で、`env()` を含む式をトークン側に閉じ込めている（利用側は `pb-(--nav-sheet-pad-b)` の1語になり、任意値構文で `env()` を書き散らさない）。いずれも `theme.css` には投影しない — 対応する Tailwind の名前空間が無く、`h-(--skeleton-line-h)` の形で参照すればトークン経由が保たれるため（`--pad-*` / `--icon-*` と同じ扱い）。

### Consequences

- 良い点: `apps/web/app` から Tailwind 既定スケール由来のクラスが消え、AC-18 が spacing 側でも成立する。スケルトンの寸法が2箇所（route-level / settings）で自動的に揃う
- トレードオフ: `spec/design/tokens.md` に無いトークンが4本増える（ADR-017 の12本と合わせて16本）。tokens.md への昇格は、他の画面でも同じ役割が必要になった時点で判断する

---

## ADR-029: 認証フォームの入力値保持は制御入力ではなく `FormState` + `defaultValue` で行う

### Status

Accepted（レビュー修正時に決定）

### Context

レビュー 001（frontend B-002）のとおり、React 19 は `action` に関数を渡した `<form>` の送信時、アクション本体の実行前に無条件でフォームリセットを予約する。したがって非制御の `TextField` を並べた `LoginForm` / `SignupForm` は、失敗時にもメールアドレスが消える。テンプレートの基準形 `CreateTodoForm` は `useState` の制御入力でこれを回避していた。

選択肢は (1) 基準形どおり制御入力にする、(2) `FormState` に送信値を持たせて `defaultValue` に流す（リセットは「現在の `defaultValue` に戻す」動作なので、再レンダー後の値に落ち着く）。

### Decision

**(2) を採り、保持するのはメールアドレスだけとする。**

- 制御入力にすると `TextField` に `value` / `onChange` を足すことになり、プリミティブが「フォームの状態を知っている」側へ寄る。`defaultValue` は `TextField` が既に持っていた prop で、配線が漏れていただけだった
- パスワードは保持しない。`defaultValue` に流すと平文が DOM 属性として残るうえ、失敗の主因（`INVALID_CREDENTIALS` / `PASSWORD_TOO_WEAK`）はパスワードの打ち直しを促すのが正しい。AC-10 / AC-12 が要求する「再入力できる」の対象はメールアドレスで満たす
- あわせて、失敗後に**項目エラーを持つ最初のフィールドへフォーカスを移す**（W-004）。`TextField` に `inputRef` を足し、`useActionState` の state 更新を契機に移す。項目に帰属しないエラー（フォーム全体のバナー）ではフォーカスを動かさない — `FormMessage` の `role="alert"` が読み上げるので、移すと入力位置を奪うだけになる
- 送信中の入力欄 `disabled` は外す（W-012）。無効化はボタンだけで、`disabled` によってフォーカスが `<body>` に落ちる問題ごと消える

### Consequences

- 良い点: 失敗しても打ち直しはパスワードだけで済み、キーボード / SR 利用者はフォーカス移動でエラーの所在を知る。`TextField` は非制御のままなので、後続スライスのフォームも同じ形で書ける
- トレードオフ: 「送信値を state に持つ」ことを各フォームが自前で書く（共通化しない）。フォームが3つ4つに増えたら `useFormValues` 相当に括る判断が要る
- 副作用: `defaultValue` を state から与えるため、成功時に `initialState` を返す経路が「入力欄を空に戻す」役割も兼ねる（現状は成功後に必ず遷移するので視認できない）

---

## ADR-030: 認証後シェルを `h-dvh` + シート内スクロールにする

### Status

Accepted（レビュー修正時に決定）

### Context

レビュー 001（frontend W-006）のとおり、承認済みデザインの共通シェルは `.app { height: 100dvh; display: flex }` + `.sheet { flex: 1; overflow-y: auto }` で、**サイドバーとヘッダーは固定されシートだけがスクロールする**。実装は `min-h-dvh` + `main` に `overflow-y` 指定なしで、ページ全体がスクロールしていた。本スライスは中身が空なので見た目には現れないが、全認証後画面が乗る土台である。

### Decision

外側を `h-dvh`、`main` を `flex-1 overflow-y-auto` にして基準形と同じスクロールコンテナ構成にする。

**含意（後続スライスへの申し送り）**: ウィンドウがスクロールしなくなるため、`router.tsx` の `scrollRestoration: true`（window スクロールの復元）は認証後画面では実質的に無効になる。タイムラインのように長い一覧を持つ画面で「戻ったときのスクロール位置」が要るときは、TanStack Router の要素スクロール復元（`useElementScrollRestoration` + スクロールコンテナへの `data-scroll-restoration-id`）を `main` に配線する。本スライスはスクロールする内容を持たないので配線しない。

### Consequences

- 良い点: PC のサイドバーとヘッダーが常設になり、AC-14 / PAGE-common-001 の「PC はサイドバー（常設）」と `spec/design/index.md` の「1画面=1シート」が実装として成立する。土台の修正がタイムラインスライスより前に済む
- トレードオフ: 上記のとおりスクロール復元の配線が別途必要になる。モバイル Safari の動的ツールバーに対しては `dvh` が基準形と同じ挙動になる（基準形も `100dvh`）

---

## ADR-031: `requireUserId()` をキャッシュ禁止の権威点にし、`/_` 始まりを復帰先から除く

### Status

Accepted（レビュー修正時に決定）

### Context

security レビュー 001 の W-005 / W-009 / W-010。

- 認証を要するレスポンスに `Cache-Control` が付いていない。ルーターのメモリキャッシュ側（`_app.tsx` の `staleTime: 0` + ログアウト時の `invalidate()` → `replace: true`）は塞いであるが、ブラウザの履歴 / ヒューリスティックキャッシュは HTTP ヘッダーでしか塞げない
- `?redirect=` が制御文字（`%0d%0a`）を素通しする。WHATWG `Headers` が CR/LF を拒否するので実害は無いが、ランタイム実装への依存が残る
- `requireUserId()` の復帰先は `getRequestUrl()`（= 処理中のリクエスト URL）なので、server function 経由で未認証だと `/_serverFn/...` になる。ログイン後に POST 専用エンドポイントへ GET で飛ばされる

### Decision

- **`Cache-Control: no-store, private` は `requireUserId()` の成功パスで付ける。** ガードの権威点をキャッシュ禁止の権威点と同じにすると、「保護データを読むのにヘッダーを付け忘れる」経路が構造的に作れない。逆に、保護データを読まないレスポンス（空のタイムライン等）には付かない — 付ける根拠が無いため
- **`/_` 始まりのパスを `redirectPathSchema` の拒否リストに入れる。** fog の公開 URL に `_` 始まりは存在せず、フレームワーク内部パス（`/_serverFn/...`）だけが該当する。`toSafeRedirect()` が `undefined` を返すので、復帰先は既定のランディング（`/`）に落ちる。呼び出し側にオーバーロードを足す案は、`requireUserId()` を呼ぶ地点すべてに「正しい復帰先」を書かせることになり、付け忘れが復活する
- **制御文字（C0 + DEL）を同じ `refine` で拒否する。** 正規表現ではなくコードポイント走査にしたのは、制御文字リテラルを含む正規表現が lint 対象になるため。ADR-016 の「二重スキーマは presentation の1箇所」は保たれる

### Consequences

- 良い点: ログアウト後の戻るボタンが HTTP キャッシュ層でも成立する（`/settings` の実測で `cache-control: no-store, private` を確認）。オープンリダイレクト防御の判定が引き続き1関数に閉じ、監査点が増えない
- トレードオフ:
  - `/_` 始まりを一律に拒否するので、将来 `_` 始まりの公開 URL を作ると復帰しなくなる。デザイン・IA 上その予定は無く、拒否リストの理由はコメントに残した
  - `no-store` は `requireUserId()` を通るレスポンスにしか付かない。保護データを読むのに `requireUserId()` を通らない実行地点を作ればヘッダーも落ちるが、それは ADR-005 のガード自体の違反であり、そちらのレビュー観点で捕まえる

---

## ADR-032: `AppServerError` の同定を `instanceof` から構造判定に切り替える

### Status

Accepted（実行時バグ修正時に決定）

### Context

`/login` でログインに失敗すると、サーバー側は 422 と `ValidationError("INVALID_CREDENTIALS")` を正しく組み立てているのに、レスポンス本文が `{"c":"$TSR/Error","s":{"message":"Invalid email or password"}}` になり、`kind` / `code` が落ちていた。クライアントは `kind: "unknown"` として扱い、AC-10 の「メールアドレスまたはパスワードが正しくありません」も AC-12 の各文言も**実行時に一度も表示されない**。PR #17 由来ではなく、テンプレートの配線に元からあった不具合。

`dev` サーバーに一時プローブを仕込んで確認した観測結果:

- `appServerErrorAdapter.test` は**呼ばれている**（アダプター登録は生きている）。ただし `hit: false`, `sameCtor: false`, `ctorName: "AppServerError"`
- 中間層とアダプターが握る `AppServerError` は別のクラスオブジェクト（`sameAsAdapter: false`）

原因は module graph の分割。server function は `?tss-serverfn-split` として **rsc 環境の graph** にコンパイルされ、そこで `errorResponseMiddleware` が `AppServerError` を throw する。一方 `start.ts`（= アダプター）は `createStartHandler` が `#tanstack-start-entry` として **ssr 環境の graph** から読む。同一プロセス内に同じソースから作られた別クラスが2つ存在するため、`test: value instanceof AppServerError` が必ず false になり、seroval が既定の `Error` プラグインへフォールバックして `serialized` を丸ごと捨てていた。`extractSerializedError` の「アダプター迂回」フォールバックも、`$TSR/Error` が `message` しか運ばないので機能しない。

### Decision

`AppServerError` の同定を**構造判定**にする。`isAppServerError(value)` を `errorResponse.ts` に置き、`name === "AppServerError"` かつ `serialized` が既知の `kind` を持つことで判定する。`appServerErrorAdapter.test` と `errorResponseMiddleware` はこれを使う。

- **クラス実体の二重ロードを避けるモジュール配置の修正は採らない。** どの graph に何が入るかはフレームワークのコンパイラが決めており、こちらが配置で制御しても次のバージョンで壊れる。「graph が分かれても壊れない判定」のほうが前提が少ない
- **アダプター登録の場所・タイミングの修正も採らない。** 観測のとおり登録は正しく効いている
- CLAUDE.md の「presentation layer serializes structurally — no `instanceof` enumeration of concrete classes」に照らしても、`instanceof` を残すほうが規約から外れている。`kind` タグを見る構造判定は既存の `serializeError` / `asSerializedError` と同じ流儀

判定を `name` だけに緩めないのは、`serialized` の妥当性まで見ないと `toSerializable` が壊れた値を通してしまうため。逆に `serialized` だけを見ないのは、他人のオブジェクトが偶然 `serialized` を持つ場合に取り違えるため。

### Consequences

- 良い点: `kind` / `code` がクライアントまで届き、AC-10 / AC-12 の文言が実際に表示される（ブラウザで4ケースとも確認）。判定が graph 構成・バンドラ設定から独立する
- トレードオフ: `name` 文字列という規約に寄りかかる。`AppServerError` を継承して `name` を上書きするクラスを作ると外れるが、このクラスは transport 境界専用で継承する用途が無い
- 回帰検出: `apps/web/app/presentation/__tests__/appServerErrorAdapter.test.ts` が、`?dup` クエリで別 module instance を作って「別 graph の `AppServerError`」を再現し、アダプターが同定できること・`extractSerializedError` が `kind` を拾えること・アダプターが start インスタンスに登録されていることを検証する。`instanceof` に戻すとこのテストが落ちる

---

## ADR-033: タイミングオラクル対策の検証を「定数の export」ではなく「ユースケースが渡した値の記録」で行う

### Status

Accepted（レビュー 002 修正時に決定）

### Context

レビュー 002 test の B-001。`loginWithPassword` の `burnVerificationTime` は未登録メール / SSO ユーザーの経路でも鍵導出1回分のコストを払うことで応答時間を均す（ADR-026）。ところがこの関数は `hasher.verify` の throw を**意図的に握り潰す**。したがって `DUMMY_PASSWORD_HASH` が実ハッシャーの `parse()` を通らなくなった瞬間（アルゴリズム識別子の変更、反復回数が受理範囲を外れる、定数のタイポ）、`derive()` に到達する前に例外が出て握り潰され、**対策は死ぬが型検査もテストも実行時エラーも出ない**。

唯一の検証テストは `FakePasswordHasher`（保存形式を一切 parse しない）の上で `verify` の呼び出し回数を数えるだけだったため、定数が壊れていても常に green だった。テスト名が主張する「1回分の検証コストを払う」に対し、実際に固定できていたのは「`verify` が呼ばれる」だけである。

### Decision

**ユースケースが `verify` に渡したハッシュ文字列をスタブで記録し、その値を実ハッシャー（本番パラメータ）に食わせて `resolves.toBe(false)` を表明する。**

- **定数を `export` して直接検証する案は採らない。** 記録方式は「どう作られた値か」に依存しないので、定数がリテラルでも設定値からの導出でも実行時計算でも同じ表明が成立する（実際、本レビュー期間中に `DUMMY_PASSWORD_HASH` はリテラルから `DUMMY_PASSWORD_HASH_ITERATIONS` 由来の組み立てへ変わったが、テストは無変更で追随した）。また `export` は「テストのためだけの公開 API」を1つ増やす
- **表明は `throw しないこと` ではなく `false に解決すること`。** parse 成功と derive 成功の両方を1つの表明で押さえられる。`parse` だけを見る形にすると、`derive` に到達しない退行を見逃す
- **あわせて経路ごとの内訳（各1回）と、握り潰しの効果も固定する。** 合計3回だけでは「ある経路が2回・別の経路が0回」で通る。握り潰し側は `throwingHasher("verify")` × 未登録メールで `ValidationError(INVALID_CREDENTIALS)` になること（JSDoc が明示的に約束している「未知のアドレスを 500 にしない」）を1ケース

同じ形の判断をフェイルクローズのガード（`requireSessionSecret` / `MIN_SESSION_SECRET_LENGTH` / `MIN_PBKDF2_ITERATIONS` / `MAX_PBKDF2_ITERATIONS`）にも適用する。**「落ちる側」と「ちょうど境界で通る側」を対にして踏む**ことで、条件が `<` から `<=` にずれる退行も検出できる。DI 側の `requireSessionSecret` のテストが長さをアダプターの `MIN_SESSION_SECRET_LENGTH` から取っているのは意図的で、二重定義が将来ずれたときにテストが落ちる（レビュー 002 adapters W-005）。

### Consequences

- 良い点: 定数の陳腐化が1ケースで落ちる（実測: 反復回数を 21,000,000 に書き換えると `DATA_INTEGRITY_ERROR` で失敗する）。実ハッシャーでの検証コストは本番パラメータ 210,000 回でも workerd 上で 33ms なので、統合スイートの実行時間に影響しない
- トレードオフ: テストがスタブ経由の間接観測になるため、記録した値が「ユースケースが実際に渡したもの」であることは `burnt).toHaveLength(1)` に依存する。未登録メール経路は `verify` を1回しか呼ばないので、この前提が崩れると件数表明のほうが先に落ちる
- 波及: `FakePasswordHasher` は依然として parse しないので、「本番ハッシャーが読めること」を見る表明はこの1箇所にしか置けない。ダミーハッシュの形式を変えるときはこのテストが唯一の関門になる

---

## ADR-034: ダミーハッシュの反復回数をアダプター既定値と型で結び、握り潰しに警告を足す

### Status

Accepted（レビュー指摘 review-002-domain-usecase W-001 / W-002、review-002-security W-004 への対応）

### Context

ADR-026 の等時間化は `DUMMY_PASSWORD_HASH`（`pbkdf2-sha256$210000$…` の文字列定数）に verify を1回走らせることで成立している。ここに2つの穴が残っていた。

- 反復回数がリテラルなので、`DEFAULT_PBKDF2_ITERATIONS` を上げると未登録アドレスだけが旧コストのままになり、オラクルが元の向きで復活する。ダミーだけ上げれば向きが反転する
- ダミーが読めなくなったときの唯一の挙動が `catch {}` で、ログも出ない。等時間化が死んでも観測点が1つも無い

「設定値から導出する」には `loginWithPassword` が `DEFAULT_PBKDF2_ITERATIONS` を import する必要があるが、これはユースケース → アダプターの依存で、CLAUDE.md の依存方向に反する。ポートに `dummyHash` を生やす案は ADR-026 で退けたとおり spec のポート面（AC-4）を実装都合で広げる。

### Decision

**結合を型で表明し、向きはアダプター → アプリケーションに取る。**

- ユースケース側に `DUMMY_PASSWORD_HASH_ITERATIONS = 210_000` を置き、ダミー文字列をそこから組み立てる。反復回数の記述箇所はユースケース内で1つになる
- アダプター側は `export const DEFAULT_PBKDF2_ITERATIONS: typeof DUMMY_PASSWORD_HASH_ITERATIONS = 210_000` と宣言する。`import type` なので実行時の依存は生じず、依存の向きも内向きのまま。片方だけ動かすと**その行で型エラーになる**（実測: 600,000 に変えると `Type '600000' is not assignable to type '210000'`）
- `burnVerificationTime` に `Logger` を渡し、握り潰す前に `warn` を1行出す。リクエストの結果は変えないので、ログが唯一の signal になる

salt と digest は再生成不要にした。`verify` は保存値が宣言するコストで導出するので、一致しないバイト列のままで意図どおり働く。

### Consequences

- 良い点: 反復回数の引き上げが型検査で止まり、テストの実行を待たずに気づける。ダミーの陳腐化（形式そのものが読めなくなる側）は ADR-033 のテストが拾い、コストのずれは型が拾う、と検出手段が二層になる
- トレードオフ: アダプターの既定値の型がアプリケーション層の定数に縛られる。数値としては同じものなので実害は無いが、`DEFAULT_PBKDF2_ITERATIONS` の型が `number` ではなくリテラルになる
- 残る限界: 引き上げ前に書かれた保存ハッシュは旧コストのままなので、その行に対する誤パスワードは未登録アドレスより安い。rehash-on-login（#18）まで解消しない。この限界は `DEFAULT_PBKDF2_ITERATIONS` の JSDoc と `progress.md` に書いた

---

## ADR-035: ユースケースが受け取るコンテナから `sessionCodec` を型で外す

### Status

Accepted（レビュー指摘 review-002-domain-usecase W-004 への対応）

### Context

`SessionCodec` の JSDoc は「Presentation-layer port. No usecase may reference it.」と禁止しているが、`ServiceArgs.container` の型は `RequestContainer` そのもので、`container.sessionCodec.issue(...)` はコンパイルを通る。同じ PR で `SessionSecret` ブランドを入れて「未設定の秘密鍵」を型から消した直後であり、`RequestContainer` が `outboxRepository` / リポジトリ群を「載せない」ことで構造的に排除しているのと比べても、ここだけコメント頼みだった。

### Decision

`application/types.ts` に `UsecaseContainer = Omit<RequestContainer, "sessionCodec">` を置き、`ServiceArgs.container` をそれにする。presentation は `getContainer()` の戻り値（`RequestContainer`）をそのまま渡せる — 変数の代入には excess property check が働かないため、呼び出し側・テストヘルパーとも無変更で通る（実測: 4パッケージの型検査が変更0行で Done）。

### Consequences

- 良い点: 「ユースケースはセッションに触れない」が型エラーになる。責務のドリフトがレビュー待ちにならない
- トレードオフ: コンテナ型が2つになる。`RequestContainer` は「リクエスト境界が組み立てるもの」、`UsecaseContainer` は「ユースケースが見てよい面」という役割の違いなので、`di/types.ts` の JSDoc に対応を書いた
- 将来: presentation 専用のポートが増えるたびに `Omit` の対象が増える。3つ目が出たら `Pick` 側で書くか、コンテナを2本に分ける判断をする

---

## ADR-036: セッション鍵の最小長はアダプターを唯一の出所にする

### Status

Accepted（レビュー指摘 review-002-adapters W-005 への対応）

### Context

`MIN_SESSION_SECRET_LENGTH = 32` が `application/di/secrets.ts`（非公開）と `adapters/webcrypto/hmacSessionCodec.ts`（公開）に別々にあった。ずれたときの壊れ方が悪い — アダプター側だけ上げると、DI は下限を満たさない秘密に `SessionSecret` ブランドを付けて通し、その後 `createHmacSessionCodec` が素の `Error` を投げる。Cloudflare ではこの throw が `errorResponseMiddleware` の外（`createRequestContainer` の中）で起きるので、ADR-025 で潰した「起動は成功、全リクエストが素の 500」に戻る。

### Decision

`secrets.ts` がアダプターの `MIN_SESSION_SECRET_LENGTH` を import する。値の出所は**構築境界を持つ側**、つまり HMAC 鍵長の不変条件を実際に強制するアダプターとする。`application/di/` は既に4本のランタイム配線でアダプターを import しており、依存の向きは変わらない（`d1/schema.ts` の `OCC_GUARD_CHECK_NAME` を検出器と共有しているのと同じ形）。

### Consequences

- 良い点: 定数が1つになり、アダプター側を上げれば DI の検査も同時に上がる。`di/__tests__/secrets.test.ts` と `webcrypto/__tests__/hmacSessionCodec.test.ts` が同じ定数を参照するので、境界も1つの数字で表明される
- トレードオフ: `secrets.ts` がアダプターに依存する。セッションの実装方式（署名済みブロブ / セッションテーブル）を差し替えるときは、この import 先も差し替え対象になる。差し替えの範囲はこの1本だけではなく、`createHmacSessionCodec` を呼ぶ DI 配線4本（`di/server{Node,Cloudflare,Aws,Gcp}.ts`）とテストハーネスを含む合成ルート全体である（review-004-backend W-001 で数え落としが判明したため明示。ポートの呼び出し側は変わらない）

---

## ADR-037: 例示ファイルの `SESSION_SECRET` は値を置かず空にする

### Status

Accepted（レビュー指摘 review-002-security W-002 への対応）

### Context

`apps/web/.env.example` と `.dev.vars.example` が `dev-only-session-secret-change-me-0123456789`（44文字）を同梱していた。`requireSessionSecret` の検査は「未設定でない」「32文字以上」だけなので、この値はそのまま通る。コピーして本番に出た瞬間、リポジトリを読んだ誰でも任意の `uid` の署名済み Cookie を作れる。`.env.aws.example` / `.env.gcp.example` は空だったので、方針も揃っていなかった。

### Decision

**両ファイルとも空にし、生成コマンド（`openssl rand -base64 48`）をコメントで示す。** レビューが挙げたもう一方の案（`requireSessionSecret` に例示値の拒否リストを持たせる）は採らない — 塞げるのは「この文字列を使った場合」だけで、例示値をコピーして1文字変えた鍵は素通りする。値を置かないことは「弱い鍵の網羅的な検出」を要求せず、失敗形も「起動時 / 初回リクエストで落ちる」という既存の経路に収まる。

### Consequences

- 良い点: 4つの例示ファイルで方針が揃う。公開された鍵が本番に出る経路が、検出ではなく不在によって閉じる
- トレードオフ: `cp .env.example .env` の直後は起動しない。生成コマンドを `SESSION_SECRET=` の直上に置き、各ランタイム docs のセットアップ手順と揃えることで、失敗から復帰までを1コマンドにした

---

## ADR-038: キャッシュ禁止の権威点をガードからリクエスト境界のミドルウェアへ移す

### Status

Accepted（レビュー指摘 review-002-frontend B-001 / review-002-security W-001 への対応。ADR-031 を更新する）

### Context

ADR-031 は `requireUserId()` を「このレスポンスは per-user である」権威点と定め、そこで `Cache-Control: no-store, private` を付けた。しかし `requireUserId()` を呼ぶのは `CurrentUserPanel` と `logoutFn` だけで、実測したヘッダは `/settings` にしか付いていなかった（`/`・`/topics`・`/search`・`/trash` は無し）。結果として **manual TC-23 が実際に落ちる** — ログアウト後の戻るボタンで、ブラウザの back/forward キャッシュから SSR 済みの保護シェルが再利用される。

さらに `/settings` に付いていたのも保証ではなくレースだった。per-fragment streaming のリーフは**ハンドラが戻ってヘッダが確定した後**に描画されるので、`setResponseHeader` はその時点で手遅れになりうる。実際 SPA 内遷移で使う `GET /_serverFn/<renderSettings>`（本文にメールアドレスを含む）にはヘッダが一切付いていなかった。

### Decision

**`noStoreMiddleware` を1本置き、認証状態に依存する server function に付ける。** ミドルウェアは `next()` の**前**にヘッダを立てるので、ハンドラが promise を await せず返す streaming 経路も覆う。付ける先は `readAuthStateFn`（`_app` 配下の全文書がここを通る）・`renderSettings`・`logoutFn`。SSR 中は server function がインプロセスで走るため、同じ1点が文書レスポンスにも乗る。`Vary: Cookie` も併せて立てる — `/_serverFn/<id>` の URL は全ユーザーで同一なので、前段にキャッシュを置いたときのフェイルセーフになる。

`requireUserId()` 側の `setResponseHeader` は残すが、コメントを「これだけでは streaming 経路を覆えない」に書き換えた。ADR-031 の「ガードが唯一の権威点」という表現は本 ADR で置き換わる。

### Consequences

- 良い点: 保護データを返す経路が文書・server function とも1つの宣言で覆われる。実測で `/`・`/topics`・`/search`・`/trash`・`/settings` の文書と `readAuthStateFn` / `renderSettings` の server function 応答すべてに `no-store, private` + `vary: cookie` が乗り、ログアウト後の戻るボタンで保護画面が復元されないこと（TC-23）をブラウザで確認した
- トレードオフ: `/login` の文書にも `no-store` が乗る（`beforeLoad` が `readAuthStateFn` を通るため）。未認証ページの再訪が毎回サーバー往復になるが、認証フォームは元よりキャッシュしたい対象ではない
- 次に streaming ルートを足す人への要求: 保護データを返すなら `noStoreMiddleware` を付ける。ガードを呼ぶだけでは足りない

---

## ADR-039: streaming する RSC リーフを redaction 境界の内側に入れる

### Status

Accepted（レビュー指摘 review-002-security W-003 への対応）

### Context

`errorResponseMiddleware` は「serialize → redact → status → Logger」の唯一の権威点として設計されている。しかし per-fragment streaming のリーフは**ハンドラが戻った後**に描画されるので、そこでの throw は middleware の `catch` に届かない。実測では開発ビルドで `E{"name":"NotFoundError","message":"User not found: …","stack":[[…,"/Users/…/packages/core/src/application/identity/getCurrentUser.ts",…]]}` が RSC ストリームに載り、開発マシンの絶対パスを含むサーバースタックがそのまま応答に出ていた。本番で漏れないのは React が message を digest に潰すからで、**redaction 境界がこの経路を覆っていない**という事実は変わらない。

`renderServerComponent` は `onError` を受け取らない（`RscCssEnvelopeOptions` のみ）ため、レビューが挙げた「`renderServerComponent` に `onError` を渡す」案は API 上取れない。RSC ツリー内の error boundary はクライアントコンポーネントを要求するので、リーフを Suspense 境界の外から包むこともできない。

### Decision

**`errorResponseMiddleware` から redaction / ログの本体を `toClientError` に括り出し、`guardStreamedRender(load)` として同じ境界を streaming リーフに公開する。** `CurrentUserPanel` はデータ取得をこれで包む。middleware と同じ関数を通るので、redaction と Logger の分岐は1箇所のまま。

HTTP ステータスだけは復元できない（描画時点で応答は確定済み）ので、`guardStreamedRender` の JSDoc に「これは戻せない」と明記した。CLAUDE.md「domain → application はそのまま流す」「boundary でだけ catch する」の方針とは整合する — ここは transport 境界そのものが2つに割れている構造的な事情で、リーフ側が2つ目の境界になる。

### Consequences

- 良い点: 実測で RSC ストリームのエラーフレームが `E{"name":"AppServerError","message":"User not found: …","stack":[]}` になり、内部フレーム（`packages/core/**` の絶対パス）が消えた。`system` / `unknown` は本番同様に `System error` へ潰れ、Logger にも届く
- トレードオフ: streaming リーフは「middleware に任せる」だけでは済まなくなり、`guardStreamedRender` を明示的に呼ぶ必要がある。呼び忘れは型では検出できないので、規約として JSDoc に書いた
- `notFound` は従来どおり redact されない（ADR 外の既存判断。届く相手はそのセッションの持ち主本人）

---

## ADR-040: canonical は各ルートが持ち、root は出さない

### Status

Accepted（レビュー指摘 review-002-frontend W-004 への対応）

### Context

各ルートの `head` が `buildHead(...).meta` だけを返していたため、canonical は `__root` が出す `/` のまま全ページで固定され、ページ別の `og:url` と矛盾していた。

修正にあたって、`meta` と `links` で TanStack Router の合成規則が違うことが分かった。`meta` は `name` / `property` をキーに**深いマッチが勝つ**が、`links` は全マッチ分を**そのまま連結**する（`headContentUtils.tsx` の `appendUniqueUserTags` は完全一致のみ排除）。したがって「root がベースを出して子が上書きする」は canonical では成立せず、実測でも `<link rel="canonical" href="…/"/>` と `<link rel="canonical" href="…/login"/>` が2本並んだ。

### Decision

**`__root` は `meta` だけを返し、canonical は各ルートが `routeHead(match, {...})` で出す。** `head` の定型（`config` の有無で分岐して `buildHead` を呼ぶ）が8ルートに逐語コピーされていたので、`presentation/head.ts` に `routeHead` を1本足して配線ごと共通化した。`__root` の `links` はサイトアセットとスタイルシート（ページ非依存で1本しか無いもの）に限る。

### Consequences

- 良い点: canonical が1ページ1本になり、`og:url` と一致する。`head` の分岐が8箇所から1箇所になり、片方だけ直す事故が消える
- トレードオフ: `head` を持たないルート（現状は無い。404 / エラー画面がこれに当たる）には canonical が付かない。索引対象でないので許容する

---

## ADR-041: `viewport-fit=cover` を採り、safe-area を役割名トークンで持つ

### Status

Accepted（レビュー指摘 review-002-frontend W-005 への対応。ADR-028 を補う）

### Context

ADR-028 で `--nav-sheet-pad-b` に `env(safe-area-inset-bottom)` を足したが、viewport meta が `viewport-fit=contain`（既定）のままだったため `env()` は常に 0 に解決され、修正は**一度も発火していなかった**（実測 `padding-bottom: 40px` = `--space-2xl` ちょうど）。レビューは (a) cover を入れて上端も手当てする / (b) cover にしないと決めて ADR に注記する、の二択を示した。

### Decision

**(a) を採る。** `head.ts` の viewport meta に `viewport-fit=cover` を足し、画面端に接する余白を役割名トークンにした（`--header-pad-t` / `--auth-pad-t` / `--auth-pad-b`。既存の `--nav-sheet-pad-b` と同形）。`head.ts` は `apple-mobile-web-app-capable: yes` を出していてスタンドアロン起動を想定しているので、(b) を選ぶと「PWA 化した時点で上端がステータスバーに潜る」を将来へ先送りするだけになる。

各トークンは `max(既定値, calc(env(...) + 余白))` の形で、cover でない環境では既定値がそのまま残る。基準形 `timeline.html` の `header.top` / `login.html` の `.auth-container` に対応する。左右のインセット（横向きのノッチ）は基準形も扱っていないので、本スライスでも扱わない。

### Consequences

- 良い点: CDP の `Emulation.setSafeAreaInsetsOverride`（top 59 / bottom 34）で実測し、**この ADR で足した4トークンすべて**で safe-area が算出値に反映されることを確認した（`--header-pad-t` 24px → 73px、`--auth-pad-t` / `--auth-pad-b` 30px → 73px / 48px、`--nav-sheet-pad-b` 40px → 58px）。左右インセットは上記のとおり扱わない
- **訂正（review-003-frontend W-002）**: 当初この行は「全箇所で反映されることを確認した」と書いていたが、**画面端に接する余白は4トークンで尽きていなかった**。シート本文の下端（`AppShell` の `<main>` 内側の `pb-2xl`）が固定値のまま残っており、実測は 40px（= `--space-2xl`）で変化しなかった。5つ目のトークン `--sheet-pad-b` は .issue/1/adr.md ADR-049 で足している。「全箇所」と書けるのは棚卸しの根拠を示せるときだけ、という記録として残す
- トレードオフ: cover はレイアウトビューポートを画面全体に広げるので、以後**画面端に接する余白を足すたびに safe-area を考える**必要がある。生値ではなく役割名トークン経由にしたのは、その判断を tokens.css の1箇所に集めるため

---

## ADR-042: シートのスクロールリセットは `scrollToTopSelectors` で明示する

### Status

Accepted（レビュー指摘 review-002-frontend B-002 への対応。ADR-030 を補う）

### Context

ADR-030 で `<main>` をスクロールコンテナにした結果、新規ナビゲーションでスクロール位置が先頭に戻らなくなった。`@tanstack/router-core` の `setupScrollRestoration` は、戻る / 進むの復元は任意の要素を追跡して行う一方、**新規遷移のトップ復帰は window と `scrollToTopSelectors` の列挙しか見ない**。`scrollToTopSelectors` は既定値を持たない。加えて `scroll.restoring && fromCacheKey !== cacheKey` の分岐が遷移元の位置を遷移先のエントリへコピーするため、放置すると前画面の位置を持ち越す。

### Decision

**`<main data-scroll-restoration-id="app-sheet">` と `scrollToTopSelectors: ['[data-scroll-restoration-id="app-sheet"]']` を対で置く。** id を付けることでスクロールキャッシュのキーが `nth-child` の構造セレクタから外れる副次効果もある（DOM 構造を変えても保存済みの位置が迷子にならない）。

### Consequences

- 良い点: 実測で「`main` を 800px スクロール → `/settings` へ遷移 → `scrollTop === 0`」「戻る → 800 に復元」を確認した。無限スクロールのタイムラインが載る前に土台側で閉じている
- トレードオフ: スクロールコンテナを増やすたびに `scrollToTopSelectors` への追加が要る。シェルが1つのスクロール領域を持つ設計（ADR-030）である限り、追加は起きない

---

## ADR-043: ブランドリンクの `aria-current` は `createLink` のラッパーで落とす

### Status

Accepted（レビュー指摘 review-002-frontend W-003 への対応）

### Context

`<Link>` はアクティブ時に `aria-current="page"` を自動付与するため、`to="/"` のワードマークがタイムライン表示中に「現在地」として公開され、ナビ項目と合わせて2箇所になっていた。レビューの提案は `activeProps={{}}` を渡すことだったが、`@tanstack/react-router` の `useLinkProps` は `...isActive && STATIC_ACTIVE_PROPS` を `activeProps` の**後**に展開する（`link.js:369`）ので、`activeProps` でも呼び出し側の `aria-current={undefined}` でも消せない。

### Decision

**`createLink` でラップした `BrandLink` を作り、ラッパーの引数で `aria-current` を落とす。** `createLink(Comp)` は解決済み props を `Comp` に渡すので、ここが唯一 `aria-current` に触れる位置になる。同じ理由で `TextLink` は `className` をマージするようにした（アクティブ時に router が渡す `className="active"` が固定クラス列を上書きしていた）— どちらも「`createLink` のラッパーは router が渡す props を素通しにしない」という同じ形。

### Consequences

- 良い点: 実測で `/` の `aria-current="page"` が「タイムライン」1件だけになった。`data-status="active"` は残るので、将来ロゴにアクティブ表現を足す余地は消えていない
- トレードオフ: ワードマークが `Link` ではなくラッパー経由になる。ラッパーの存在理由をコメントで固定した

---

## ADR-046: 出荷コードからの ADR 参照は `.issue/1/adr.md` をパスで明示する

### Status

Accepted（レビュー指摘 review-003-domain-adapters B-001 への対応）

### Context

`packages/core/src` / `apps/web/app` のコメントには本 Issue の判断を指す `ADR-NNN` 参照が44箇所ある（本 ADR 制定時点。その後の修正で増え、本 PR 完了時点では `grep -rnoE 'ADR-[0-9]+' packages/core/src apps/web/app infra` が52箇所）。ところがリポジトリには `spec/adr/001〜006` という長命な ADR が既に実在し、`spec/domains/identity.md:5` が `[ADR-004](../adr/004-domain-boundaries.md)` と相対リンクしているため、「ADR-NNN」は既に `spec/adr/NNN` を意味する語彙として確立している。結果、無修飾の `ADR-002`（意図はセッション方式）は `spec/adr/002-export-scope.md` に解決し、007 以降はどこにも解決しない。

選択肢は3つあった。(a) `.issue/1/adr.md` の判断を `spec/adr/007-*.md` 以降として切り出す。(b) コード側の参照を全件パス付きに直す。(c) `.issue/1/adr.md` の採番を 100 番台へ振り直す。

### Decision

**(b) を採る。** 44箇所すべてを `.issue/1/adr.md ADR-NNN` の形にした（`(ADR-008)` → `(.issue/1/adr.md ADR-008)`）。1行に複数の兄弟参照がある場合は先頭だけを修飾する（`(.issue/1/adr.md ADR-005 / ADR-010)`）。

(a) が筋であることには同意するが、それは「どの判断が長命でどれが issue ローカルか」の仕分けと `spec/adr/` の文書体裁への書き換えを伴う設計作業であり、本レビューラウンドの範囲を超える。まず参照が一意に解決する状態を作り、切り出しは別途行う。

### Consequences

- 良い点: `grep -rnoE 'ADR-[0-9]+' packages/core/src apps/web/app infra` の全ヒットが、直前のパスによって一意に解決する。番号空間の衝突は解消した（本 PR 完了時点で52箇所すべてが `.issue/1/adr.md ` 直後に現れることを実測）
- トレードオフ: 出荷コードが issue 単位の作業ディレクトリを参照し続ける歪みは残る。`.issue/1/adr.md` を `spec/adr/007-*.md` 以降へ切り出す作業は未了で、その時点で52箇所の再置換が必要になる

---

## ADR-047: ダミーハッシュ読み取り失敗の警告はプロセス単位でラッチする

### Status

Accepted（レビュー指摘 review-003-domain-adapters W-003 / W-004 への対応）

### Context

`burnVerificationTime` の `logger.warn`（ADR-034）は、ログイン試行1回につき1行出る。しかし報告している事実は「このデプロイのハッシャーがダミーを読めない」というプロセス単位の静的な事実であり、しかもこの分岐に入るのは未登録アドレスと SSO アカウント宛の試行、つまり未認証トラフィックが自由に量を作れる経路である。レート制限は #18 に defer されているため保護もない。Workers はログをサンプリングし、CloudWatch は取り込み量で課金するので、量が増えるほど「唯一の signal」が読めなくなる・高くつく。

あわせて、`cause` をそのまま `logger` に渡していた点も問題だった。ADR-011 は「`PlainPassword` を `logger.*` に渡さない」をレビュー観点として残しているが、`PasswordHasher` の契約は例外に何を載せてよいかを何も言っていない。

### Decision

- **モジュールスコープの `boolean` ラッチ**で警告をプロセス（isolate）単位に1回へ絞る。「アプリケーション層は stateless」原則とはわずかに緊張するが、この状態はログの抑制だけに使われ、ユースケースの返り値・エラー・永続化のいずれにも影響しない。Logger デコレータ側に「同一メッセージの抑制」を寄せる案は、DI 4本すべてに配線が要るうえ抑制ポリシーが呼び出し側から見えなくなるため採らなかった
- **`PasswordHasher` のポート JSDoc に禁止条項を書く**（W-004 提案 (a)）: 「`hash` / `verify` が投げるエラーは `PlainPassword` を message / cause / 入れ子のフィールドに含めてはならない」。ADR-011 のレビュー観点を「ポートが禁止した」に格上げする
- あわせて `logger.warn` に渡すメタを**非推移的な射影**に絞る（同 (b)）: `{ cause: cause instanceof Error ? cause.name : typeof cause }`。等時間化が死んだ事実を知るのに必要なのは種別だけで、スタックは要らない

### Consequences

- 良い点: 攻撃トラフィックで警告行数が増えなくなり、ADR-034 の signal が量に埋もれない。契約と実装の二重で平文がログに出る経路を閉じた
- トレードオフ: ラッチが立った後は「何回起きたか」が分からない。頻度が要るなら Logger 側のカウンタで足す話であって、per-request ログに戻す理由にはならない
- トレードオフ: プロセスが再起動するまでラッチは降りない。長命な Node プロセスでは、原因を直したあとも「直った」ことがログからは分からない

---

## ADR-048: エラー表示の受け皿を「シェル内」と「全画面」の二段にする

### Status

Accepted（レビュー指摘 review-003-frontend W-001 への対応。ADR-039 を補う）

### Context

`/settings` を per-fragment streaming にした結果（ADR-039）、streaming リーフ `CurrentUserPanel` の例外は `<Deferred>` の `use(promise)` からレンダー中に投げられる。ところが `@tanstack/react-router@1.170.18` の `Match.js` は `ResolvedCatchBoundary = routeErrorComponent ? CatchBoundary : SafeFragment`（`routeErrorComponent = route.options.errorComponent ?? router.options.defaultErrorComponent`）で、`/settings` にも `_app` にも `errorComponent` がなく `defaultErrorComponent` も未配線だったため、**保護画面のマッチには catch boundary が1つも張られていなかった**。例外は root まで上がり、`__root.errorComponent`（`AuthSheet` = 未認証画面と同じ体裁）が `RootComponent` ごと置き換わる。実測 `{ hasNav: false }`：ログイン中のユーザーがグローバルナビを失い「ログアウトされた」と誤解しうる。

選択肢は2つ。(a) `_app` に `errorComponent` を置く。(b) `router.tsx` に `defaultErrorComponent` を配線する。

### Decision

**(a) を採る。** `_app.errorComponent` が `AppShell` を張り直し、その `<main>` の中にエラー表示（見出し + メッセージ + リトライ導線）を出す。`__root.errorComponent` は「シェルの外」＝未認証画面と、root 自身の `beforeLoad`（`loadAppContext`）の失敗のための全画面表示として残し、二段構成にした。`Match.js` の `match.status === "error"` は**そのマッチ自身の** `errorComponent` を使うので、`_app` の `beforeLoad` / `loader` の失敗は `_app` が捕まえる（root には落ちない）。リトライ導線（`再読み込み` + `タイムラインへ`）は `components/ui/ErrorRetry` に切り出して両者で共有する。

(b) を採らなかった理由は landmark にある。`defaultErrorComponent` は**全ルートに一律**で効くので、`/login` などの認証前ルートでも `AuthSheet`（= `main` ランドマークの持ち主）が差し替わり、review-002-frontend W-001 で入れた「認証前画面にも `main` がある」が壊れる。逆に `defaultErrorComponent` を `AuthSheet` 版にすると、シェル内で `<main>` が入れ子になる。**ランドマークの持ち主が2種類ある以上、受け皿も2種類要る。**

`_app` に置いたのは、次のスライスで増える streaming ルートが**何も書かなくても**この受け皿を得るため。リーフ単位の粒度（他のフラグメントを残したまま片方だけエラーにする）が要るルートは、そのルートに `errorComponent` を足せば内側の boundary が先に捕まえる。

### Consequences

- 良い点: 実測（`users` 行を消して streaming リーフを `notFound` で失敗させる）で `{ hasNav: true, mains: 1, h1: "設定", h2: "エラーが発生しました" }`。グローバルナビ・ヘッダー・現在地マークが保たれ、axe violations 0。行を戻して「再読み込み」を押すと、`router.invalidate()` が `loadedAt` を更新して `CatchBoundaryImpl` の `getResetKey` が変わり、フルロードなしでパネルが復帰することも実測した
- 良い点: root の受け皿が「シェルの外の失敗」に用途を絞れた。`loadAppContext`（root の `beforeLoad`）を落として実測すると、従来どおり全画面の `AuthSheet` に落ちる
- トレードオフ: `errorComponent` はそのルート自身の `component` を置き換えるので、`_app` の受け皿は `AppShell` を自分で描き直す。`AppShell` は表示物をすべて `pathname` から導くので同じ見た目に戻るが、ナビシートの開閉状態のような shell 内 state はエラー時にリセットされる
- トレードオフ: `_app` の `beforeLoad`（`readAuthStateFn`）が失敗した場合もこの受け皿が出るため、認証状態が不明のままナビが見える。ナビはリンクにすぎず、遷移すれば `beforeLoad` が再実行されて未認証なら `/login` へ飛ぶので、保護境界（ADR-005）には影響しない

---

## ADR-049: シート本文の下端にも safe-area トークンを置く

### Status

Accepted（レビュー指摘 review-003-frontend W-002 への対応。ADR-041 の抜けの修正）

### Context

ADR-041 で `viewport-fit=cover` を採り、画面端に接する余白を4つの役割名トークンにした。しかし棚卸しが漏れていた箇所がある：`AppShell` の `<main>` は `h-dvh` + `flex-1` のスクロールコンテナで、**下端がビューポート下端と一致する**（実測 `mainBottom === innerHeight === 844`）。その内側の余白は `pb-2xl`（`--space-2xl` = 40px）の固定値のままだった。cover はレイアウトビューポートをホームインジケータ帯まで広げるので、ノッチ機の縦持ちでは最後の行と帯（34px）の実クリアランスが **40px → 6px** に縮む。遮蔽ではないが、帯はシステムのスワイプ領域でもあり、タイムラインスライスで本文やアクションがここに載ると体感差が出る。

基準形 `timeline.html` の `.inner` は `padding-bottom: 150px` を持っており、この差分はデザイン側では露見しない（実装のシート高さの取り方に固有）。

### Decision

**他の4つと同形の `--sheet-pad-b: max(var(--space-2xl), calc(env(safe-area-inset-bottom, 0px) + var(--space-lg)))` を tokens.css に足し、`pb-2xl` を `pb-(--sheet-pad-b)` に置き換える。** 生値も任意値構文も足さず、safe-area の判断を tokens.css の1箇所に集める ADR-041 の形をそのまま踏襲する。

### Consequences

- 良い点: CDP の `Emulation.setSafeAreaInsetsOverride`（bottom 34）で実測し、シート本文の下端が 40px → 58px（= `max(40px, 34px + 24px)`）。ホームインジケータ帯との実クリアランスが 6px → 24px（`--space-lg`）に戻った。override なしでは 40px のままで、非ノッチ環境の見た目は変わらない
- トレードオフ: safe-area トークンが5つになった。「画面端に接する余白」の棚卸しは目視に頼っており、`<main>` のようにスクロールコンテナ越しに画面端へ接する箇所は見落としやすい。ADR-041 の「全箇所」という書き方が実際に見落としを隠していたので、同 ADR の Consequences も訂正してある

---

## ADR-050: 型レベルの表明は「守りたい境界そのもの」に当てる

### Status

Accepted（レビュー指摘 review-004-backend W-002 への対応。ADR-035 が型で引いた境界を守るテストの直し）

### Context

`requestContainerConfig.test.ts` は「ユースケースからセッション codec に手が届かない」ことを `@ts-expect-error` で表明していたが、その対象が型エイリアス `UsecaseContainer` そのものだった。

```ts
// @ts-expect-error
const reach = (c: UsecaseContainer) => c.sessionCodec;
```

この形が固定しているのは `Omit<RequestContainer, "sessionCodec">` の定義だけである。**実測**：`application/types.ts` の `ServiceArgs.container` を `UsecaseContainer` → `RequestContainer` に戻して `pnpm typecheck` を回すと、root + 3パッケージすべて Done で通る。`UsecaseContainer` の定義が残っている限り `c.sessionCodec` は型エラーのままなので、ディレクティブは使われ続け、退行は素通りする。R3 W-008 が塞ぐよう求めたのはまさにこの経路だった。

### Decision

**表明の対象を型エイリアスではなく、ユースケースが実際に受け取る引数（`ServiceArgs<unknown>`）にする。**

```ts
// @ts-expect-error usecases must not be able to reach the session codec
const reach = (args: ServiceArgs<unknown>) => args.container.sessionCodec;
```

一般則としては「`@ts-expect-error` は、壊れてほしくない境界を**通る式**に当てる」。型エイリアスに当てるとエイリアスの定義しか固定できず、その定義を**使う地点**が差し替わったことは検出できない。

### Consequences

- 良い点: 2つの退行がどちらも検出される。**実測で確認**した — (1) `ServiceArgs.container` を `RequestContainer` に戻す → `requestContainerConfig.test.ts(100,5): error TS2578: Unused '@ts-expect-error' directive.` で落ちる、(2) `UsecaseContainer` の `Omit` を外す → 同じ位置・同じコードで落ちる（どちらも実測後 revert 済み）
- 良い点: 表明が1行のままで、以前の表明範囲も失われていない
- トレードオフ: 型境界のみで、実行時オブジェクトは依然 codec を持つ。意図的な `as RequestContainer` は今も通る（コメントに明記）

---

## ADR-051: モジュールスコープのラッチは `vi.resetModules()` で表明する

### Status

Accepted（レビュー指摘 review-004-backend N-001 / review-004-frontend-security-test N-003 への対応。ADR-047 の残課題）

### Context

ADR-047 で `burnVerificationTime` の警告をモジュールスコープの `boolean` ラッチで isolate 単位1回に絞ったが、その振る舞いを表明するテストが1件も無かった。ADR-034 が「等時間化が死んだときの唯一の signal」と位置づけた1行が、消えても誰も気づかない状態が続いていた。ラッチがあるためテストは実行順に依存し、素直には書けない。

### Decision

**`vi.resetModules()` + 動的 import でユースケースモジュールごと作り直し、テストごとに新品のラッチを得る**（`application/identity/__tests__/loginWithPassword.test.ts`）。ラッチ自体をコンテナ（`Logger` デコレータ等）へ移す案は ADR-047 で既に退けた判断なので蒸し返さず、テスト側でモジュール境界を切る。

固定するのは4点：(1) 読めないダミーで警告が1回出ること、(2) メタが `cause` の**型名だけ**を運ぶこと（`{ cause: "UnreadableDummyError" }` を完全一致で）、(3) 同一モジュール上では**コンテナを新しくしても**2回目以降が黙ること、(4) ダミーが読める場合は何も出ないこと。(4) が無いと「毎回 warn する実装」でも (1)(3) が緑になりうる。

DB は要らない（`findByEmail` が `null` を返すスタブで十分）ので、CF pool の統合テストではなく node pool の単体テストに置く。

### Consequences

- 良い点: ミューテーションで実効性を確認した。ラッチの2行を削ると (3) が落ち、`cause` の射影を生のまま渡す形に戻すと2件が落ちる（424件中 422 passed。いずれも実測後 revert 済み）
- 良い点: `PasswordHasher` の「例外に平文を載せない」契約（ADR-047）の消費側の守り方が、初めてテストで固定された
- トレードオフ: `vi.resetModules()` を使うテストはモジュールグラフを作り直すので、静的 import した型ガード（`isValidationError` 等）とはインスタンスが別になる。このスイートはログだけを見て例外の同一性を見ないことでそれを回避している。ラッチ以外の `loginWithPassword` の表明は従来どおり `identity.integration.test.ts` が持つ

---

## ADR-052: 認証シートは縦中央に置き、内側の隙間を外周の余白より狭くする

### Status

Accepted（ユーザー要望「ログイン画面などを中央寄せにしたい」への対応。デザインモックと実装を同時に改訂）

### Context

認証画面（login / signup / password-reset / oauth-authorize）はシートを横中央には置いていたが、縦は上寄せだった。縦中央へ動かすと、シート内側の余白が 上 40px / 下 80px の非対称なので、シートの中で中身が上へずれて見える。

対称化して縦中央に置いたあと、内側の隙間が外周の余白を超えている箇所が2つ見つかった（実測）。**(1) `登録する` → `ログイン` が 60px** — モックでは `.form-links` が `<form>` の兄弟で `margin-top: --space-section`（36px）だけが効くのに、実装は `<form className="flex flex-col gap-lg">` の中に入れて `gap-lg`(24px) と二重取りしていた。実装だけの逸脱。**(2) `fog` → 見出しが 40px** — 外周と同値なのでルール上はセーフだが、見出しの `--leading-tight` 1.5 の分だけ光学的には 51.9px となり、上の余白 44.7px より広く見える（こちらはモックと実装が一致していた）。

この 80px は認証画面固有の意図ではない。`spec/design/review/005.md` 方針2「シート内側の上下余白を拡大（上 40px / 下 80px〜、コンポーザー画面は 140px〜）」が全14ページへ一斉展開されたもので、アプリ画面のシートが**下端をビューポート下端に一致させるスクロールコンテナ**であること（ADR-049 と同じ前提）に由来する — 最終行がボトムナビやホームインジケータ帯に張り付かないための逃げ幅。

### Decision

**`.auth-container` に `justify-content: center` を足し、認証シートに限って内側の上下余白を `--space-2xl` の対称にする**（実装は `AuthSheet` の `justify-center` と `py-2xl`）。認証シートはスクロールしない自己完結カードなので逃げ幅が働く場面が無く、横断ルールから外す理由が立つ。逸脱であることは `spec/design/index.md`「余白と区切り」と `AuthSheet` の JSDoc の両方に理由付きで残す。

縦中央化は `min-height: 100dvh` の上で行うため、中身がビューポートより高い場合はコンテナが伸びて `justify-content` が無効化され、上端は切れない。外側の safe-area 余白（ADR-041 の `--auth-pad-t` / `--auth-pad-b`。ADR-053 で `--space-safe-t-xl` / `--space-safe-b-xl` に改名）はそのまま効く。

あわせて **「内側の隙間は外周の余白を超えない」を明文化し**（`spec/design/index.md`「余白と区切り」）、認証シートを 外周 40px > セクション区切り 36px > フォーム内 24px の3段に整理する。(1) はリンクを `<form>` の**外**へ出してモックと同じ兄弟構造にする（`mt-section` 単独で 36px）。(2) はブランド下を `--space-2xl` → `--space-section` に落とす（モック4枚の `.brand` と `AuthSheet` の両方）。

### Consequences

- 良い点: 実測で確認した — 1280x800 の `/login` `/password-reset` と 375x667 の `/signup` が縦横中央に載り、375x**380**（意図的に潰した高さ）では `scrollY: 0` / シート上端 `top: 30px`（= 上の safe-area 余白の既定値 `--space-xl`）/ `scrollHeight: 631 > innerHeight: 380` となり、上端の欠けなくスクロールで全体に到達できる
- 良い点: 最終的な `/signup` の実測は 外周 上下 40px / ブランド下 36px / 見出し下 36px / フォーム内 24px / ボタン→リンク 36px（60px から解消）。モック `login.html` 側も 40 / 36 / 40 で一致する
- 良い点: モック4枚と実装が同じ構造のまま揃う（`.auth-container` / `.auth-sheet` / `.form-links` ↔ `AuthSheet` / `LoginForm` / `SignupForm`）
- トレードオフ: 認証シートだけが全シート共通の「下 80px」から外れる。`spec/design/index.md` に例外として明記したが、新しい認証系画面を足すときは基準形 `pages/login.html` を写す前提が以前より重要になる
- トレードオフ: ブランド下 36px でも光学的には 47.9px で、上の余白 44.7px をまだ 3px 上回る。完全に釣り合わせるには 30px（`--space-xl`）まで落とす必要があるが、トークンの段数を増やしてまで詰める差ではないと判断した

---

## ADR-053: トークンは名前空間に載せられる限り載せ、safe-area 余白は役割名をやめてスケールの段にする

### Status

Accepted（ユーザー要望「ドメイン専用トークンより汎用トークンを優先したい」への対応。ADR-017 の「名前空間の無いトークンは任意値構文で消費する」を、**本当に名前空間が無いものだけ**に狭める）

### Context

ADR-017 は `@theme` へ投影するのを「Tailwind の名前空間があるトークン」に限り、残りは `p-(--pad-btn)` / `size-(--icon-md)` / `max-w-(--content-max)` の任意値構文で消費すると決めた。しかしこの線引きは実際より厳しかった。Tailwind v4 の `--spacing-*` は**スケールの段でなくても単値なら載る**（`--spacing-sidebar: 200px` → `w-sidebar`）し、`max-w-*` は `--container-*` を読む。任意値構文が必要なのは、名前空間が無い値 — 複合値の `--pad-btn` / `--pad-input` / `--pad-menu` と、border shorthand の `--border-input` — に限られる。棚卸しの結果、42 箇所の任意値構文のうち**残す必要があるのは 6 箇所だけ**だった。

もう一方の問題は safe-area 余白の役割名。ADR-028 / ADR-041 / ADR-049 で `--nav-sheet-pad-b` → `--header-pad-t` / `--auth-pad-t` / `--auth-pad-b` → `--sheet-pad-b` と、画面が増えるたびに1本ずつ足して5本になった。review-004 N-005 が「`--sheet-pad-b` と `--nav-sheet-pad-b` は式が1バイトも違わない」「次に下端へ接する要素を足すときは既存を流用できないか先に見ると増殖が止まる」と指摘しているが、**役割名である限り流用は名前と矛盾する**ので指摘は守りにくい。加えて `--auth-*` は認証というドメイン名を UI プリミティブに持ち込んでいる。

### Decision

**(1) 名前空間に載せられるトークンはすべて載せる。** `--spacing-*` に単値の役割寸法（`--pad-row` / `--sheet-w` / `--sidebar-w` / `--icon-*` / `--size-*` / `--skeleton-*` / `--nav-sheet-inset`）を、`--container-*` に max-width（`--content-max` / `--container-max` / `--narrow-max`）を投影する。`tokens.css` 側の名前は変えず、`theme.css` が投影名を与える。`--container-max` の投影名だけは `page` にする — `max-w-max` は Tailwind 組み込みの `max-width: max-content` と衝突するため。

**(2) safe-area 余白は役割名をやめ、余白スケールの段の変種にする。** 5本を4本へ:

| 旧（役割名） | 新（スケールの段） | 式 |
|---|---|---|
| `--header-pad-t` | `--space-safe-t-lg` | `max(--space-lg, env(top) + --space-md)` |
| `--auth-pad-t` | `--space-safe-t-xl` | `max(--space-xl, env(top) + --space-md)` |
| `--auth-pad-b` | `--space-safe-b-xl` | `max(--space-xl, env(bottom) + --space-md)` |
| `--nav-sheet-pad-b` / `--sheet-pad-b` | `--space-safe-b-2xl` | `max(--space-2xl, env(bottom) + --space-lg)` |

値は1つも変えない。同値だった2本が同じ名前になることで review-004 N-005 の重複が解消し、以後は「下端に接する要素を足す → 既存の段を選ぶ」が名前と矛盾しなくなる。

**(3) ドメイン名の排除。** `--auth-sheet-max` → `--narrow-max`（投影名 `max-w-narrow`）。26rem は「狭い単一カラムのカードの最大幅」であって認証固有の値ではない。

段の基準値が lg / xl / 2xl の3種、内側余白が md / lg の2種でばらついているのは既存のままにした。規則で揃えると算出値が変わり（ノッチ機で 73px → 83px 等）、名前の一貫性のために見た目を動かすことになるため。

### Consequences

- 良い点: 任意値構文が 42 箇所 → 6 箇所（`p-(--pad-btn)` ×1 / `p-(--pad-input)` ×2 / `p-(--pad-menu)` ×1 / `[border:var(--border-input)]` ×2）。`[inset-inline:var(--nav-sheet-inset)]` も `inset-x-sheet-inset` になり、ブラケット構文は border shorthand だけになった
- 良い点: **safe-area が改名後も発火することを CDP で実測**した（`Emulation.setSafeAreaInsetsOverride` top 59 / bottom 34）。認証シート 30px → 73px / 30px → 48px、ヘッダー 24px → 73px、シート本文下端 40px → 58px。ADR-041 が記録した数値と完全に一致する
- 良い点: 生成 CSS 側で新ユーティリティ 21 本すべての規則を確認した（`.inset-x-sheet-inset { inset-inline: var(--spacing-sheet-inset) }` など。`lg:max-w-page` / `md:w-sheet-md` のレスポンシブ変種を含む）。算出値も改名前と一致（サイドバー 200px、本文 800px、行 16px/16px、ハンドル 36x4px、ボトムシート inset 14px、認証シート max-width 416px）
- トレードオフ: `tokens.css` の名前と `theme.css` の投影名が一致しない組が増えた（`--content-max` → `max-w-content`、`--container-max` → `max-w-page`、`--size-dot` → `size-dot`）。theme.css の冒頭コメントが対応表の役割を負う
- トレードオフ: `pt-safe-t-xl` は `t` が重複して見えるが、`--spacing-*` は上下どちらの余白にも使える名前空間なので、参照する inset の向きは名前に残す必要がある（`pb-safe-t-xl` と書けてしまうのは防げないが、目視で気づける）
