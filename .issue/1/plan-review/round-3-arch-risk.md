# レビュー round-3（最終） — アーキテクチャ整合性・実現可能性・リスク

**対象:** `.issue/1/plan.md`（全24ステップ）／`.issue/1/adr.md`（ADR-001〜011）
**視点:** プロジェクトのあるべきアーキテクチャとの整合性・実現可能性・リスク
**日付:** 2026-07-25

## 調査範囲

2周目の指摘（arch-risk P-001〜003 / S-001〜006、coverage P-001〜002 / S-001〜003）が**宣言ではなく実体として**解消されているかを実コードで照合した。あわせて、組み替え後の24ステップの各完了時点で `pnpm typecheck` / `pnpm test` が本当に通るかを依存を追って検証した。確認したもの:

- `packages/core/src/application/di/{types,serverNode,serverCloudflare,serverAws,serverGcp,containerStore,env}.ts` と `di/__tests__/serverCloudflare.test.ts`（`envWith` が `ServerEnv` リテラルを組むことを再確認）
- `RequestContainer` / `ServerEnv` の**全参照点を grep で列挙**し、リテラル構築地点（＝型を広げると落ちる地点）を確定
- `packages/core/src/adapters/d1/__tests__/helpers.ts`・`application/__tests__/helpers.ts`（どちらも `RequestContainer` を含むリテラル）、`adapters/libsql/__tests__/helpers.ts`（独自形・`RequestContainer` を含まない）
- `packages/core/src/application/workers/eventRelayWorker.ts`（`AllDomainEvents` → `DefaultEventDecoderRegistry` → `EventDecoderRegistry` の連鎖、`decodeEntry` の単一キャスト地点、`processOutboxBatch` の `options.decoderRegistry ?? defaultEventDecoderRegistry`）
- `apps/web/app/worker/cloudflare/{handlers,relay,consumer}.ts`・`worker/node/runner.ts`・`worker/{aws,gcp}/handlers.ts`（レジストリ差し込み口の有無を再確認 → aws / gcp のみ `registry` 引数を持つ）
- `apps/web/app/worker/cloudflare/__tests__/{env.d.ts,handlers.integration.test.ts}`（`env as unknown as RelayEnv` の**キャスト**であってリテラルではないこと）
- `packages/core/src/adapters/d1/__tests__/setup.ts`（グローバル `setupFiles`・`DELETE FROM todos`・`_occ_guard` 空表明）
- `packages/core/src/application/errors/index.ts`（`SystemErrorCode` が定数オブジェクト・`RETRYABLE_SYSTEM_CODES` が `Set` で網羅性強制が無いこと → `SessionError` の追加が既存を壊さない）
- `apps/web/app/presentation/errorResponse.ts`（`SerializedValidationError` のローカル定義・`SerializedError` union・`HTTP_STATUS_BY_KIND` に既に `validation: 422` があること）
- `spec/database/index.md#users`（列制約6種・直和 CHECK・インデックス2本）と plan ステップ7の目視リスト (a)〜(h) の突き合わせ
- `vitest.config.ts` / `vitest.config.integration.ts` / `vitest.config.integration.node.ts`（include / exclude / `setupFiles` / トップレベル `await readD1Migrations`）
- 全 `*.test.ts` / `*.integration.test.ts` の棚卸し（ステップ3の削除後に残る統合テストを確定）
- `todo` 参照の全ファイル走査（残るのは JSDoc / コメント中の文字列のみであることを再確認）
- `apps/web/app/routes/__root.tsx`（`<Link to="/todo">` は無く、副作用 import 2本のみ）・`router.tsx`
- `infra/aws/lib/appStack.ts`（`sharedEnv` の列挙）・`infra/gcp/example/services/{main.tf,variables.tf}`・`apps/web/{.env.example,.dev.vars.example,.env.aws.example}`
- 既存アダプターのポート import 規約（`D1IdempotencyStore implements IdempotencyStore`、`InProcessRelayTrigger = RelayTrigger & {…}`、`D1OutboxRepository` の `import type { OutboxRepository }`）

## 2周目指摘の解消状況

| 2周目 ID | 状態 | 実コードでの根拠 |
|---|---|---|
| arch P-001 ステップ分断による型検査崩れ | **解消** | ステップ10（ポート定義のみ・コンテナに触らない）と新ステップ11（`RequestContainer` 拡張 + DI 4本 + テストコンテナ2本 + `di/__tests__/serverCloudflare.test.ts`）に分割済み。構築地点を grep で全列挙したところ、**計画の7地点が過不足なく一致**した（`server.{node,cloudflare,aws,gcp}.ts` は `createXxxRequestContainer` の戻り値を受けるだけでリテラルを組まないので対象外、`presentation/serverAction.ts` も型注釈のみ）。`libsql/__tests__/helpers.ts` が `RequestContainer` を含まない独自形であることも実コードどおり。「順序の原則」に一般則として1行昇格させた点も含めて完全 |
| arch P-002 relay 統合テストの成立不能 | **解消** | ステップ3で3ファイルを**削除**、ステップ12で `AllDomainEvents = IdentityEvent`、ステップ13で `identity.userRegistered` を seed に復活、という順序に書き直されている。`EventDecoderRegistry = Partial<DefaultEventDecoderRegistry>` が `AllDomainEvents` に閉じていること、`runRelayTick` / node `runner.ts` が `registry` 引数を持たない（持つのは aws / gcp のみ）ことを再確認。削除後に残る統合テストを棚卸ししたところ **d1 / libsql の `idempotencyStore.integration.test.ts` 2本のみ**で、どちらも `todos` にも decode 経路にも依存しない → **ステップ3の完了条件（`pnpm test:integration` 全緑）は実際に成立する**。ADR-001 の Consequences にも復活ステップが追記済み |
| arch P-003 CHECK 制約の欠落 | **解消** | 設計節に `users_auth_method_valid` / `users_trash_retention_positive` が制約名付きで追加され、ステップ7の変更内容が「名前付き6本 + インデックス2本」と数え上げられ、目視リストが (a)〜(h) の8項目に拡張されている。`spec/database/index.md#users` の要求（`auth_method` 値域 / `sso_provider` 値域 / `sso_provider_subject` 非空 / `trash_retention_days >= 1` / 直和 / `users_email_uq` / `users_sso_identity_uq`）と**1対1で対応**することを突き合わせて確認した。リスク節にも独立不変条件としての注記あり（ただし AC-5 だけ未追随 → 本稿 S-002） |
| arch S-001 rest-spread のランタイム差 | **解消** | 設計節・ステップ11の両方に Node/AWS/GCP と Cloudflare の分解が書き分けられている。`serverCloudflare.ts` の実体が `{ binding, relay, waitUntil }` であること、`relay` / `waitUntil` が `ServiceBindingRelayTrigger` の構築に使われるので `_` を付けないという但し書きまで正確 |
| arch S-002 `DatabaseError` の流用 | **解消** | **ADR-010** として昇格。`SystemErrorCode` が `as const` の定数オブジェクトで、`RETRYABLE_SYSTEM_CODES` は `Set` に列挙するだけ（`Record<SystemErrorCode, …>` のような網羅性強制が無い）ため、`SessionError` の追加が既存コードを1行も壊さないことを確認した。`redactForClient` が `kind: "system"` の `code` を潰す前提も実コードどおり |
| arch S-003 `?redirect=` 無視 | **解消** | ステップ17と設計節のルート構成の両方に `search.redirect ?? "/"`。`signup.tsx` が `?redirect=` を受けないので `/` 固定という書き分けも入っている |
| arch S-004 `meta/` 生成後の D1 プール起動 | **解消** | ステップ7の完了条件2として独立。`vitest.config.integration.ts` がトップレベルで `await readD1Migrations(...)` していること、断定を検証に格下げしたことを ADR-001 にも反映済み |
| arch S-005 `--name initial` の渡し方 | **解消** | 設計節とステップ7の両方に「`apps/web` の中で直接実行する」。ルートの `db:generate:cf` が `pnpm --filter` への委譲であることを `package.json` で再確認 |
| arch S-006 `Skeleton` の確認手段 | **解消** | ステップ15の完了条件が (a) `RoutePendingFallback` の一時直描画 / (b) DevTools でのトークン解決値比較の2択に具体化され、半段階 neutral の grep も足されている |
| coverage P-001 / P-002・S-001〜003 | **解消**（P-001 は1箇所だけ取りこぼし → 本稿 P-002） | ADR-011 の新設、カバレッジ注記4点目、対応表セル、ステップ2 分岐(c) の書き換え、`toSessionSystemError` の4箇所統一、手動 TC-34/35/36、TC-016 の非制約系注入、AC 表の「24」追加をすべて本文で確認した |

**総評:** 2周目の14件は宣言に留まらず実体を伴って反映されており、とくに P-001（構築地点の一括更新）と P-002（削除 → 復活の順序）は**実コードでの再検証に耐えた**。残る指摘は2件で、いずれも「2周目の修正が別の1箇所に届いていない」タイプであり、設計の作り直しを要求するものではない。

---

## 問題点（要修正）

### **[P-001]** ステップ9（`hmacSessionCodec.ts` の実装）がステップ10（`SessionCodec` ポート定義）より前に置かれている — 実装が先・インターフェースが後という逆順で、ステップ9の完了条件（`pnpm typecheck`）が満たせない

- 理由:
  ステップ9の対象ファイルは `adapters/webcrypto/{pbkdf2PasswordHasher,hmacSessionCodec}.ts` の2本で、完了条件は `pnpm typecheck`。一方 `SessionCodec` ポート（`application/ports/sessionCodec.ts`）が作られるのは**ステップ10**である。

  本リポジトリのアダプターは**例外なくポート型を import して実装する**規約になっている（実コードで確認）。

  - `packages/core/src/adapters/d1/repositories/idempotencyStore.ts` — `import type { IdempotencyStore } … class D1IdempotencyStore implements IdempotencyStore`
  - `packages/core/src/adapters/d1/repositories/outboxRepository.ts` — `import type { ClaimPendingArgs, …, OutboxRepository } from "@repo/core/application/ports/outboxRepository"`
  - `packages/core/src/adapters/node/inProcessRelayTrigger.ts` — `export type InProcessRelayTrigger = RelayTrigger & { stop(): Promise<void> }`

  ADR-002 の Decision も「`SessionCodec` ポート（…）を定義し、WebCrypto HMAC-SHA256 による**実装**（`adapters/webcrypto/hmacSessionCodec.ts`）を…配線する」と、両者をポート／実装の関係として明示している。この規約どおりに書けば `hmacSessionCodec.ts` は存在しないモジュールを import することになり、**TS2307 でステップ9の完了条件が落ちる**。

  規約を外して構造的型付けだけに頼れば（ポート型を import せず、`issue` / `verify` を持つオブジェクトを返す factory として書けば）ステップ9は通るが、それは「ポートを実装する」という repo 全体の書き方から `hmacSessionCodec.ts` だけを外す判断になり、ステップ10で定義したポートとの結び付きが型で追えなくなる。どちらに転んでも、AC-17 の「各実装ステップの完了時点でも `pnpm typecheck` が通る（ステップ順序はそのように組んである）」という主張か、規約の一貫性のどちらかが崩れる。

  なお `pbkdf2PasswordHasher.ts` 側は問題ない — `PasswordHasher` ポートはステップ6、`PlainPassword` / `PasswordHash` はステップ4で、いずれもステップ9より前にある。**`SessionCodec` だけが順序から漏れている**。

- 提案:
  ステップ9とステップ10を入れ替える（または `SessionCodec` ポートの定義をステップ9の先頭項目として吸収する）。ステップ10自身が「新規ファイルの追加だけなので当然通る」と書いているとおり、ポート定義は**単独で前倒ししてもコストがゼロ**であり、`RequestContainer` 拡張（ステップ11）から分離するという2周目の判断は前倒ししても保たれる。あわせて「順序の原則」に一般則として「**ポート定義はその実装より前のステップに置く**」を1行足しておくと、後続スライス（MailSender / PasswordResetTokenPort など、同じ構図が確実に再来する）で同じ事故が起きない。

### **[P-002]** 設計節の値オブジェクト表（plan.md 182行）が `PlainPassword` について「`toString` / `toJSON` を無効化して漏出を防ぐ」と書いており、8行下の本文・ADR-011・対応表・カバレッジ注記の「実装しない」と真っ向から矛盾している

- 理由:
  同じ設計節の中で次の2つが並んでいる。

  | 箇所 | 記述 |
  |---|---|
  | 182行（VO 表のセル） | `PlainPassword` … 「`PasswordTooWeak`。**`toString` / `toJSON` を無効化して漏出を防ぐ**」 |
  | 190行（直後の段落） | 「**`PlainPassword` の漏出防止（DOM-identity-006 の要点の一部）は実装で担保しない。**」「ブランド付き `string` に `toString()` / `toJSON()` のオーバーライドは載せられない」 |

  2周目 coverage P-001 の修正は、段落（190行）・ADR-011・対応表セル（737行）・カバレッジ注記4点目（834行）の**4箇所には落ちているが、VO 表のセルだけ旧記述のまま残っている**。表は実装者が VO を書くときに最初に見る一覧であり、ここだけを読むと「`PlainPassword` はボックス化したオブジェクト VO にする」という、ADR-011 が明示的に**却下した選択肢1**へ実装が流れる。しかもその実装は「他の VO と書き方が不揃いになる」以外に型エラーもテスト失敗も出さないので、レビューまで誰も気づかない。

  これは round-2 arch-risk が「良い点」として挙げた「型で守れないものを正直に扱っている」という計画の美点が、まさにその箇所で自己矛盾している状態である。

- 提案:
  182行のセルを「`PasswordTooWeak`。**漏出防止は実装せずテスト＋レビュー観点で担保する（→ 190行 / ADR-011）**」に書き換える。表の他のセル（`PasswordHash` の「照合は必ず `PasswordHasher.verify` 経由」など）と同じく、参照先を1つ付けておけば読み違いが閉じる。

---

## 改善提案（検討推奨）

### **[S-001]** `SESSION_SECRET` を4ランタイムの env スキーマに**必須**で足すと、(1) セッションを使わない worker 経路の起動要件になり、(2) デプロイ側の env 列挙（`infra/aws` / `infra/gcp`）が計画の対象ファイルに入っていないため AWS / GCP が boot 時に落ちる

- 理由:
  ステップ11は「4本の env スキーマに `SESSION_SECRET`（32文字以上）を追加」とし、対象ファイルに `.env.example` / `.dev.vars.example` / `.env.aws.example` / `.env.gcp.example` を挙げているが、実コードでは env の消費点が request パスに閉じていない。

  - `apps/web/app/worker/aws/handlers.ts` は `readAwsServerEnv()` を、`worker/gcp/handlers.ts` は `readGcpServerEnv()` を呼ぶ。zod スキーマに必須キーを足すと、**relay / consumer / pruner / dlq の4 Lambda（および GCP の各ワーカー）が SESSION_SECRET 無しでは起動できなくなる**。これらはセッションを一切扱わない
  - `infra/aws/lib/appStack.ts` の `sharedEnv: Record<string, string>` は `DATABASE_URL` / `DATABASE_AUTH_TOKEN_SECRET_ARN` / `APP_URL` / `EVENTS_QUEUE_URL` の4つを列挙し、5つの Lambda すべてに配っている。**型は `Record<string, string>` なので、`AwsServerEnv` に必須キーが増えても `pnpm typecheck` は通る**（`AwsServerEnv` として型付けされていない）。同様に `infra/gcp/example/services/{main.tf,variables.tf}` も `APP_URL` を Terraform 変数として明示的に渡している
  - つまり「型検査でも `pnpm test` でも検出できず、デプロイして初めて zod の parse エラーで落ちる」という、計画自身が繰り返し警戒しているクラスの見落としになる

  ADR-004 は「4ランタイム構成は維持する」と明言しているので、片方の runtime だけ起動不能になる変更は ADR-004 と整合しない。なお fog は未デプロイ（ADR-001 の前提）なので**実害は無く、本 Issue の検証（Node ランタイム）も通る**。ブロッカーではない。

- 提案: 次のどちらか。
  - (a) ステップ11の対象ファイルに `infra/aws/lib/appStack.ts`（`sharedEnv` へ追加、Secrets Manager 参照が妥当なら `DATABASE_AUTH_TOKEN_SECRET_ARN` と同じ流儀で）と `infra/gcp/example/services/{main.tf,variables.tf}` を足す
  - (b) **Cloudflare で採る方針を4ランタイムに揃える** — env スキーマ側では optional のままにし、`createXxxRequestContainer`（＝秘密鍵を実際に使う唯一の地点）で長さ検証して不足時に throw する。計画は CF について既に「`ServerEnv` は zod スキーマを持たないので `readRequestServerConfig` / `createRequestContainer` で明示検証する」と書いており、これを一般則にすれば「セッションを使う経路だけが秘密鍵を要求する」という意味論が4ランタイムで一致し、infra 側の追随も不要になる

  どちらでも構わないが、(b) のほうが「秘密の到達範囲を DI ファクトリ1箇所に閉じる」（ADR-002 / ステップ11-4）という既に採っている方針とも噛み合う。

### **[S-002]** 受け入れ基準 AC-5 が、2周目 P-003 で追加した2本の CHECK に追随していない

- 理由:
  AC-5 は `users` の制約を「認証方式の直和 CHECK・`sso_provider_subject` の非空 CHECK・`users_email_uq`・部分一意 `users_sso_identity_uq`」と列挙しているが、2周目 P-003 で追加された `users_auth_method_valid` と `users_trash_retention_positive` が入っていない。設計節（298〜299行）・ステップ7の変更内容（「名前付き6本 + インデックス2本」）・目視リスト (e)(f)・リスク節にはすべて反映されているので**実作業には影響しないが**、受け入れ基準表は冒頭で「チェックリスト75行を検証可能な単位に束ねたもの」と位置づけられており、AC を根拠に完了判定する読み方をすると `trash_retention_days >= 1` の欠落が基準側では拾えない。この CHECK は計画自身が「どの直和 CHECK にも含まれない独立の不変条件で、抜けても型検査・テストのどちらでも検出できない」と書いている唯一のものなので、基準側にも名前を残す価値がある。

### **[S-003]** ADR-009 の Decision が「`RequestContainer` にドメインポートが増えていく圧力を作らない」と書く一方、ステップ11 は `passwordHasher`（ドメインポート）を `RequestContainer` に追加する — ADR 単体で読むと矛盾して見える

- 理由:
  plan.md 側はステップ11-1 で「`passwordHasher` はその**意図的な例外**であり、理由は非トランザクショナルであること・UoW 外での実行を spec/usecases/identity.md が要求していること」を `types.ts` の JSDoc に書く、と手当てしている。ADR-009 の論旨（リポジトリの取得口は `UnitOfWorkContext` ただ1つ）は `userRepository` に限れば正しく、`passwordHasher` はリポジトリではないので実質の矛盾ではない。ただし ADR は plan.md と切り離して読まれる文書なので、ADR-009 の Consequences（または Decision の末尾）に「なお `passwordHasher` は非トランザクショナルなドメインポートとして `RequestContainer` に載せる例外を作る（理由は plan.md ステップ11 / `di/types.ts` の JSDoc）」を1行足しておくと、ADR-002 / ADR-009 / ステップ11 の3点が単体読みでも閉じる。

---

## ADR 全体（001〜011）の相互整合

**矛盾は見当たらない。** 3周目に新規追加された2本を含めて確認した。

| ADR | 判断 | 所見 |
|---|---|---|
| **ADR-010** `SystemErrorCode.SessionError` 新設 | **妥当** | `packages/core/src/application/errors/index.ts` を実コードで確認した結果、`SystemErrorCode` は `as const` の定数オブジェクト、`SystemErrorCode` 型はその値の union、`RETRYABLE_SYSTEM_CODES` は `ReadonlySet<SystemErrorCode>` への列挙のみ。`Record<SystemErrorCode, …>` のような**網羅性を強制する参照点は1つも無い**ので、エントリ追加は既存コードを1行も壊さない。`SerializedSystemError` は `kind: "system"` 固定で `code` に型制約が無いため、`errorResponse.ts` の `SerializedError` union / `HTTP_STATUS_BY_KIND` / `redactForClient` にも波及しない。JSDoc の「Add a new entry per external resource you integrate」に沿った拡張であり、`DatabaseError` の意味（storage layer が throw した）を保つという判断も表の意図どおり。`toSessionSystemError` を `sessionCookie.ts`（`server-only` を持たない純関数モジュール）に置くことで TC-logout-003 の検証手段が `server-only` の読み込み可否から独立する、という設計上の副産物も正しい。`spec/testcases/identity/logout.md` の期待（「アダプター層で `SystemError` として扱われる」）に対し、実装地点が presentation になる点は spec の字面との差だが、同 spec 自身が「セッション破棄は presentation/アダプター層の責務」と両方を挙げているので齟齬にならない |
| **ADR-011** `PlainPassword` の漏出防止 | **妥当**（ただし plan.md 側に取りこぼし → 本稿 P-002） | spec の内部矛盾（「フィールド: `string`（ブランド型）」と「`toString` を無効化する」の同居）を正面から指摘したうえで、VO の書き方の一貫性を優先する判断は筋が通っている。代替の担保2本のうち「イベントペイロードの再帰走査」は実際に平文の混入を検出できる形になっており、`CurrentUserView` のキー集合表明は TC-getCurrentUser-003 と重複するのでコスト増もほぼ無い。「ログへの漏出だけはテストで縛れない」と正直に書き、レビュー観点に落とした点も含めて、型で守れない範囲の扱いとして適切。永続化は `users` に平文列が無いことで構造的に閉じている、という論拠も `spec/database/index.md#users`（`password_hash` のみ）と一致 |
| ADR-001〜009 | **前回同様に妥当** | ADR-001 の Consequences に relay / consumer テスト3本の削除 → ステップ13復活が追記され、ADR-002 の `secrets` ネスト、ADR-003 の反復回数ファクトリ引数化と workerd 実測、ADR-005 の「`beforeLoad` は先回りリダイレクトで権威ではない」、ADR-006 の `ValidationError` 追加（`errorResponse.ts` の `SerializedError` union / `HTTP_STATUS_BY_KIND` が既に `validation` を持つことを実コードで再確認）、ADR-007 の「リンク先が実在するもの／押しても何も起きないコントロール」の判別基準、ADR-008 の前提列挙（PK 衝突も `UNIQUE_VIOLATION` に潰れる点まで閉じた）、ADR-009 の純読み取り UoW — いずれも実装事実に裏付けられている |

ADR 間で緊張がある組み合わせ（ADR-002 の「`SessionCodec` は `application/ports/` だが presentation 専用」、ADR-008 の「翻訳をユースケース境界へ」と CLAUDE.md の adapter → application 原則、ADR-009 と S-003）は、いずれも理由・限界・移行経路が明記されており、設計判断として成立している。

## レイヤー分離・キーコンセプトへの適合（再確認）

- **依存方向**: `SessionCodec` は `application/ports/`（presentation → application は順方向）、認証ヘルパーは `apps/web/app/presentation/`（core の framework-free を維持）、`ValidationError` は application に置き presentation が import。`adapters/webcrypto/` が `application/ports/` と `domain/identity/ports/` を import するのは既存アダプター（`d1/repositories/*` が `application/ports/outboxRepository` を import する）と同じ形で、内向き依存を崩さない
- **Unit of Work**: 書き込みは `unitOfWorkProvider.run` 内、イベントは `collectEvents` 経由。読み取り専用も純読み取り UoW（ADR-009）。`registerWithPassword` の hash を UoW 外に出すのは spec の処理フローどおり
- **outbox / domain events**: `AllDomainEvents` / `defaultEventDecoderRegistry` を identity の3イベントで埋め直す。共通基盤3テーブルはテンプレート流儀のまま維持し、`d1/__tests__/setup.ts` の `_occ_guard` 空表明（共通基盤検証の核）も維持
- **リトライ戦略**: アプリケーション層に OCC リトライを足していない。ADR-008 の catch は「レース検出」という明示された境界に限定
- **入力検証2点主義**: `auth/schema.ts` は shape / DoS（1024）のみ、長さ判定は `Email` / `PlainPassword` に一本化。`?redirect=` は `validateSearch`（catch 付き）と server fn（strict）の二重スキーマ。`serverData` に外部入力を通す設計は無い
- **クロスレイヤー catch ポリシー**: broad catch は (1) `registerWithPassword` のレース検出、(2) `session.ts` のヘッダー書き込み、(3) worker の per-row の3箇所のみ

## 各ステップ完了時点の型検査・テスト（依存追跡の結果）

依存を追った結果、**P-001（ステップ9 → 10）以外に順序上の破綻は見つからなかった。** 主要な遷移の検証結果:

- **ステップ3（削除）** — 削除後に残る統合テストを棚卸ししたところ `adapters/{d1,libsql}/__tests__/idempotencyStore.integration.test.ts` の2本のみ。d1 側はグローバル `setup.ts`（`todos` / migrations / schema を3点セットで温存する判断のおかげで無傷）に依存し、libsql 側は `helpers.ts` の `0000_initial.sql` 固定参照（ステップ7まで変えない）に依存する。**どちらも todo にも decode 経路にも依存しないので `pnpm test:integration` は全緑になる**。`AllDomainEvents = never` にしたときの `{ readonly [K in never["type"]]: … }` は `{}` に解決され、`{} satisfies {}` も通る（`never` への property access は TS で許容され `never` を返す）
- **ステップ7（スキーマ・マイグレーション）** — `d1/schema.ts` から `todos` を消す時点で参照元は既にゼロ（ステップ3で `todoRepository.ts` と UoW の構築を削除済み）。`setup.ts` の `DELETE FROM todos` → `DELETE FROM users` を同一ステップに含めているので D1 プールが落ちない。libsql helpers の journal 走査化も同一ステップ
- **ステップ10 → 11 → 12 → 13** — 2周目 P-001 / P-002 の修正どおりに成立する。ステップ11で `RequestContainer` を広げた瞬間に落ちる7地点が同一ステップに入っており、`ServerEnv` に `SESSION_SECRET` を足したとき唯一落ちるリテラル（`di/__tests__/serverCloudflare.test.ts` の `envWith`）も明示されている。`apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts` は `env as unknown as RelayEnv` の**キャスト**なのでリテラル構築地点ではなく、そもそもステップ3で削除されているので二重に問題にならない。ステップ11の完了条件「`pnpm test` が通る」は、この時点で decode 経路を通るテストが1本も残っていないため成立する
- **ステップ22（routeTree 再生成）** — `__root.tsx` を実コードで確認したところ `<Link to="/todo">` の類は無く、副作用 import 2本のみ。`router.tsx` も `routeTree.gen.ts` と `RoutePendingFallback` しか参照しないので、ステップ3で `/` が一時的に消えてもルーター側の型は壊れない

## 良い点

- **2周目の指摘に対して、レビューが挙げた根拠を実コードで再確認したうえで反映している。** P-001 の構築地点7つは grep で全列挙して照合したが**過不足ゼロ**、P-003 の CHECK は `spec/database/index.md#users` の要求と1対1で対応していた。とくに「`libsql/__tests__/helpers.ts` は `RequestContainer` を含まない独自形なのでステップ11では不要、フェイクハッシャー差し替え口が要るのはステップ13」という書き分けは、レビューが指定しなかった粒度まで自力で確認した結果であり、調査の質が高い。
- **修正が「その場しのぎ」ではなく一般則に昇格している。** 2周目 P-001 / P-002 への対応が、個別ステップの並べ替えに留まらず「順序の原則」の2条（共有型の構築地点を同一ステップに含める／型で守られない実行時依存を空にするステップはその依存を通るテストを同時に削除する）として明文化されている。後続スライスで同じ事故を防ぐという意味で、指摘の射程を超えた反映になっている。
- **ステップ3の完了条件が「削除すれば成立する」ことまで検算されている。** 「削除したテストは実行対象から消えるので全緑は成立する。残る統合テストは `d1/__tests__/setup.ts` が維持する共通基盤側だけになる」という記述は、本レビューで棚卸しした結果と一致した。削除の副作用を「テストが減る」ではなく「何が残るか」で書いているのが正確。
- **ADR-010 / ADR-011 がどちらも「実装しない／既存を流用しない」判断の記録として機能している。** ADR-010 は流用（`DatabaseError`）を退けた理由をコード表の JSDoc の意図に紐づけ、ADR-011 は spec の内部矛盾を指摘したうえで代替の担保を検証可能な形に固定している。どちらも spec-sync 対象として明示されており、後続の監査で「spec 違反」と誤検出されない形になっている。
- **「型検査を通ったから安全」という誤った安心を一貫して作っていない。** マイグレーション2セットの内容は目視が唯一の関門、`Skeleton` の不可視化はクラス名が解決するので型・ビルドエラーにならない、`AllDomainEvents` の空レジストリはテスト実行時にしか出ない、`PlainPassword` の漏出は型で止まらない — 検出手段が無い箇所を4つとも名指しし、それぞれに代替の関門（目視リスト / DevTools 確認 / 順序 / テスト＋レビュー観点）を割り当てている。
- **3周を通してチェックリスト75/75 とステップ番号の整合が一度も壊れていない。** 24ステップへの組み替えと 10 → 10/11 の再分割という2度の大きな番号変更を経ても、受け入れ基準表・対応表・付随実装表・カバレッジ注記・リスク節・テスト方針・ADR の相互参照が追随している。

## 実装フェーズへの移行可否

**条件付き可。** 次の2点を修正すれば着手してよい。どちらも1〜2行の書き換えで閉じ、設計の作り直しを一切要求しない。

1. **P-001** — ステップ9とステップ10を入れ替える（またはポート定義をステップ9の先頭項目に吸収する）。ポート定義の前倒しはコストゼロで、ステップ11との分離という2周目の判断も保たれる
2. **P-002** — plan.md 182行の `PlainPassword` のセルを ADR-011 の結論（漏出防止は実装しない）に合わせる

S-001〜S-003 は着手をブロックしない。S-001 は fog が未デプロイのため実害が無く、実装中に (a)(b) のどちらを採るか決めれば足りる。S-002 / S-003 は文書整合のみ。

計画の骨格（スコープ・ステップ順序・レイヤー分離・ADR 群）は3周のレビューで十分に検証されており、**これ以上のレビュー周回は不要**と判断する。
