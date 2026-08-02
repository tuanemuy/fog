# 実装手順 — Issue #37

**正本の優先順位:** `spec/database/index.md` > `spec/domains/` > `.thread/34/design.md` > `.adr/` > 本ファイル。本ファイルが正本と食い違ったら正本を採り、本ファイルを直す。

**着手前に `plan.md` の「着手前に必ず反映する Issue 本文の訂正」を読むこと。**

---

## 設計

### ドメインモデルへの影響

#### 消えるもの

- **ドメインイベントという抽象そのもの。** `domain/common/event.ts`（`EventId` / `DomainEventDraftBase` / `DomainEventBase` / `DomainEvent` / `EventDraft` / `EventDecoder` / `WithEventDrafts` / `attachEventIds`）と `domain/identity/events.ts`（3イベント型 + `IdentityEvents` ファクトリ）が丸ごと消える（`.adr/004`）。エンティティのファクトリは `WithEventDrafts<...>` ではなくエンティティ単体を返す。
- **`UserRepository`。** `.adr/008` により `UserSettingsRepository`（User Data DO 側）と `CredentialMappingRepository`（Identity Directory 側）へ割れる。

#### 契約が変わるもの

- **`TransactionalRepository` を同期化する**（第8.2.1節の選択肢 (a)）。`insert(entity): void` / `findById(id): Versioned<TEntity> | null` / `save(entity, expectedVersion): void` / `delete(id, expectedVersion): void`。`Versioned<T>` / `ExpectedVersion<T>` はそのまま残す（OCC は残るため）。
- **`User` を判別共用体からクレデンシャル集合へ読み替える**（`.adr/008`）。`passwordHash` / `provider` / `providerSubject` は User Data DO 側のフィールドではなくなる。`addCredential` / `removeCredential` を置き、後者は「最後のログイン手段」の解除を拒否する。判定材料は `CredentialRef.usableForLogin` で、数え方は **`usableForLogin` が真の行の `credentialId` の異なり数**である。
- **`Email.create` の正規化部分を canonical 化へ差し替える**（第5.2.1節 (a)）。順序は `trim()` → 構造チェック（`@` を含む / local・domain が非空）→ 最後の `@` で分割 → **local 部の非 ASCII（`U+0080` 以上）を `BusinessRuleError(InvalidEmail)` で拒否** → local 部を lowercase → domain 部を NFKC 正規化 + lowercase、非 ASCII を含むなら punycode（IDNA ASCII 形式）へ変換 → 再結合 → **変換後の値で長さ 320 を再チェック**。`EMAIL_MAX_LENGTH = 320` と `EMAIL_PATTERN` は維持する。**NFKC を local 部に掛けない。**

#### 追加されるもの

- 値オブジェクト `CredentialId`（`domain/identity/valueObject.ts`。世代非依存のクレデンシャル同一性。第6.1.2節）。
- ポート8本（`spec/domains/identity.md` の定義をそのまま同期契約で写す。`CredentialMappingStore` だけは #37 が新設する — `spec/domains/identity.md` が「これらは `CredentialMappingRepository` のメソッドではない。…**実装形は `spec/database/index.md` と #37 が決める**」と明記して #37 に委ねている分である。adr.md ADR-012）:
  - `UserSettingsRepository` — `insert(user): void` / `save(user, expectedVersion): void` / `find(): Versioned<User> | null`。**`findById` を持たない。**
  - `AccountStore` — `find(): AccountState | null` / `advanceSessionEpoch(): void` / `advanceResetVersion(): number`。`AccountState = { status: "active"|"deleting"|"deleted"; sessionEpoch: number; resetVersion: number }`。`ExpectedVersion` を取らず `version` も進めない。
  - `CredentialLocatorStore` — `list()` / `findByCredentialId(credentialId)` / `record(locator)` / `advanceCredentialVersion(credentialId)` / `deleteByCredentialId(credentialId)`。`record` は `(credentialId, generation)` の upsert で、`credentialVersion` は**引数と既存値の大きいほう**、`usableForLogin` / `label` は引数で上書き。**no-op にしてはならない。**
  - `CredentialMappingRepository` — `findByEmail(email)` / `findBySsoIdentity(provider, subject)` / `findByCredentialId(credentialId)` の読み3本だけ。
    - **`spec/domains/identity.md` の署名は「ドメインから見た契約」であって、Directory DO 内の実装署名ではない。** mapping 行のキーは `(kind, 全長 hmac)` であり（`spec/database/index.md`）、HMAC の材料である `DIRECTORY_ROUTING_SECRET` は **request Worker にしか配らない**（第5.2.3節。ステップ17 の `StateEnv` にも入っていない）。したがって **`findByEmail(email: Email)` / `findBySsoIdentity(provider, subject)` を DO 内でそのまま実装することは原理的にできない。**
    - **読み替えを1行として固定する — DO 内の実装は `(kind: "email" | "sso", hmac: string)` を引数に取る 1本**（`findByLocatorKey(kind, hmac)`）にまとめ、`findByEmail` / `findBySsoIdentity` という**名前の区別は canonical を組み立てる request Worker 側（`Email.create` / `ssoCanonical` → `directoryLocator.forCanonical`）に属する。** 責務配置は「**canonical 化と HMAC 導出は request Worker、`(kind, hmac)` での引き当ては DO**」であり、**state Worker へ routing secret を配ってはならない**（AC-3 の非重複配布を壊す）。この読み替えを `credentialMappingRepository.ts` の JSDoc に明記する（adr.md ADR-016）。
  - `CredentialMappingStore` — `reserve` / `activate` / `cancel` / `beginChange` / `promote` / `delete` / `reportResult` の**書き込み7本**。すべて `operationId` / `payloadDigest` / `status` / `change_state` を条件に含む CAS で、`ExpectedVersion` を取らない（`credential_mappings` は `version` を持たない）。**`IdentityDirectoryUnitOfWorkContext` に載る**（adr.md ADR-012）。
  - `PasswordResetTokenPort` — `issue(credentialId, now): string` / `verifyAndConsume(token, now): UserId | null`（同期化）。
  - `RotationCheckpointStore` — `record(checkpoint): void` / `find(rotationKind, bucketIndex, generation): RotationCheckpoint | null`。置換キーは `(rotationKind, bucketIndex, generation)`。
  - `MailSender` — `sendPasswordResetMail(to: Email, resetToken: string): Promise<void>`。**唯一残る非同期ポートのうちの1本**（もう1本は `PasswordHasher`）。
- 型 `CredentialRef`（`User.credentials` の要素。`credentialId` / `kind` / `usableForLogin` / `label`）。

#### 変わらないもの

- `PasswordHasher` は `Promise` のまま（トランザクションの外で回す。第4.8節）。
- `BusinessRuleError` / `RehydrationError` / `CodedError` / `Version` / `Pagination` / `codePointLength`。

### ユースケース / アプリケーションロジック

#### UoW 契約（`packages/core/src/application/execution/unitOfWork.ts` を差し替える）

adr.md ADR-003 のとおり **DO クラスごとに2つのコンテキスト型**を置く。`run` は完全同期（`T extends Promise<unknown> ? never : T`）。**`run` の中で `run` を呼ばない**規約を JSDoc に置き、`UnitOfWorkContext` から `UnitOfWorkProvider` へ到達できない形にする。**非同期ポート（`MailSender` / `PasswordHasher` / DO stub factory / `fetch` を持つ任意のポート）をコンテキストに載せない。**

#### usecase の実行位置

- **usecase は DO の中で実行する。** 例外は4つ（パスワードのハッシュ化 / 検証、セッション・AI トークンの署名 / 検証、canonical → Directory locator の HMAC、export のレンダリングと zip）で、いずれも request Worker。
- **DO facade のメソッド署名はブランド型を取らない。** primitive（`string` / `number` / それらのプレーンなオブジェクト）だけを受け取り、DO の内側で値オブジェクトを再構築する。これが `CLAUDE.md`「validated at exactly two points」の2点目の実体になる。
- **RPC は `{ ok: true; value } | { ok: false; error: SerializedError }` の値エンベロープだけを返す。** DO 側の RPC エントリで catch し `toSerialized()` を値として返す。エンベロープに `version` を持たせる。

#### #37 が実装する usecase（6本 + saga）

| usecase | 実行位置 | 内容 |
|---|---|---|
| `registerWithPassword` | request Worker（saga オーケストレーション） | phase 0（採番 + canonical + hash）→ 1a（コーディネーター bucket 予約）→ 1b（残り bucket。パスワード signup では1件なので発生しない）→ 2（`initialize-account`）→ 3（`activate-reservation`）→ 4（`record-credential-locator` と `operations.phase='done'` を**同一 `transactionSync`**） |
| `loginWithPassword` | request Worker | step 1〜7（第5.3節）。RPC は3本（`lookup-credential` / `verify-login` / `report-login-result`）。照合失敗時は step 5 を飛ばして2本 |
| `getCurrentUser` | User Data DO 内 | epoch ガード → `userSettingsRepository.find()` + `credentialLocatorStore.list()` の射影 |
| `changeTrashRetentionDays` | User Data DO 内 | epoch ガード → `User.changeTrashRetentionDays` → `userSettingsRepository.save`（OCC）→ **同一 `transactionSync`** で `memos` / `topics` / `documents` の `purge_after` を再計算し `enqueueJob('purge-trash', …)`。**画面と server function の配線は #11**（#37 は RPC と再計算まで）。ADR-001 の「memo / knowledge のユースケースを作らない」は memo / knowledge の話であり、`user_settings` は #37 の範囲（`UserSettingsRepository` を作る）なので矛盾しない |
| `logout` | request Worker | セッション cookie の破棄のみ（epoch は進めない） |
| `requestPasswordReset` | request Worker → Directory bucket | `request-password-reset`。mapping の有無・スロットルの有無にかかわらず**必ずジョブ行を1行書き、同じ `setAlarm` を発行し、同じ応答を返す** |

**実装しない usecase**（`plan.md` のスコープ参照）: パスワード変更、リセット完了、SSO link / unlink、退会、AI クライアント接続、memo / knowledge / trash / search / export。

### アダプター / 永続化 / 外部連携

`packages/core/src/adapters/cloudflare/` に新設する。**`packages/core/src/adapters/d1/` は全削除。**

```
packages/core/src/adapters/cloudflare/
  sql/exec.ts                 SqlStorage の薄いラッパ（one / all / run / exists）
  sql/occ.ts                  conditionalUpdate: UPDATE ... RETURNING 1 の行有無 → ConflictError
  sql/errors.ts               DO 内: SQLITE_FULL → SystemError(StorageCapacityExceeded), SQLITE_CONSTRAINT* → ConflictError
  platform/stubErrors.ts      呼び出し側: .overloaded → SystemError(ServiceOverloaded), abort/reset → SystemError(DatabaseError)
  platform/envelope.ts        ok/err ヘルパだけ（型は lib/rpcEnvelope.ts、復元は application/rpc/restoreError.ts）
  platform/rpcEntry.ts        RPC エントリ共通ラッパ（ゲート → 本体 → 成功/失敗どちらでも armAfterRpc）
  schema/userData.ts          User Data DO の DDL v1（15テーブル + 索引 + FTS5。`_meta` は gate.ts が持つ）
  schema/identityDirectory.ts Identity Directory DO の DDL v1（4テーブル + 索引。同上）
  schema/types.ts             MigrationStep 型
  schema/gate.ts              runMigrationGate（同期・await ゼロ・fail-closed）
  search/normalize.ts         NFKC + trim
  search/projection.ts        upsertSearchEntry / removeSearchEntry / rebuildSearchEntry
  search/probe.ts             tokenizer 検証専用の最小の読み（#10 が吸収する）
  jobs/table.ts               enqueueJob / claim / complete / fail / prune / earliestNextRunAt / rearm
  jobs/runner.ts              runDueJobs（外側25件・除外集合・per-job try/catch）
  jobs/alarm.ts               armAlarm / disarmAlarm（sync() で永続化確認）
  jobs/registry.ts            JobKind → ハンドラの対応（7種）
  jobs/handlers/*.ts          purgeTrash / sendMail / sweepResetTokens / sweepReservations / resumeSignup / reindex / migrateBulk
  userData/unitOfWork.ts      UserDataUnitOfWorkProvider
  userData/userSettingsRepository.ts / accountStore.ts / credentialLocatorStore.ts
  userData/trashQuery.ts      findEarliestPurgeAfter / listItemsToPurge / recalcPurgeAfterChunk
  userData/facade.ts          User Data DO の RPC エントリ実装
  identityDirectory/unitOfWork.ts
  identityDirectory/credentialMappingRepository.ts
  identityDirectory/mappingOperations.ts   CredentialMappingStore 実装（reserve / activate / cancel / beginChange / promote / delete / reportResult）
  identityDirectory/opaqueBinding.ts       caller_token / change_auth_token の定数時間比較
  identityDirectory/resetTokenStore.ts / rotationCheckpointStore.ts
  identityDirectory/facade.ts
  directoryLocator.ts         request Worker: canonical → { generation, bucketIndex, hmac, doName }
  mailSender.ts               createBindingMailSender / NoopMailSender
```

**OCC の実現手段は条件付き UPDATE の0行検出**（第8.4節）。`UPDATE ... WHERE id = ? AND version = ? RETURNING 1` が返した行の有無で読む。単一行テーブル（`user_settings`）は `id` 述語を持たず `WHERE version = ?` だけ。`rowsWritten` は使わない。

### UI / プレゼンテーション

画面の見た目は変えない。変わるのは3点だけ。

1. `apps/web/app/presentation/currentUser.ts` の JSDoc から `requireUserId()` の「The authoritative guard」という位置づけを外す（認可の権威は DO 側の epoch ガード）。
2. `readAuthStateFn` は DO を叩かないままにする。代わりに**保護データを返す server 実行点が必ず DO を経由することをテストで固定**し、「DO を叩かない server function は保護データを返さない」を規約として同ファイルのコメントに置く。
3. server function / server component が `getContainer()` 経由で usecase を直接呼ぶ形から、コンテナの DO facade を呼ぶ形へ変わる。`serverAction.ts` / `errorResponseMiddleware.ts` / `validator.ts` の構造は保つ。

---

## 実装ステップ

依存方向の順（内側から）に並べる。**ステップ13〜19 は原子的な1ブロックで、途中では型検査が通らない。** それ以外のステップは末尾で `pnpm typecheck` が通る。

---

### 1. spike — プラットフォーム事実の再確認

- **対象ファイル:** `packages/core/src/adapters/cloudflare/__spike__/platform.integration.test.ts`、**`packages/core/src/adapters/cloudflare/__spike__/probeDo.ts`（新規。spike 専用の使い捨て DO クラス）**（どちらもこのステップ限りの一時ファイル。ステップ9 / 10 で常設テストへ吸収したら削除する）、`vitest.config.integration.ts`（一時的に **トップレベルの `main`** と `durableObjects` バインディングを足す）
- **spike が自己完結して走る形を先に作る（これが無いと1項目も実行できない）。** 12項目はすべて `ctx.storage.sql` / `transactionSync` を要求するので DO の中でしか実行できないが、**プロダクションの DO クラス（`UserDataDurableObject` / `IdentityDirectoryDurableObject`）を作るのはステップ6 であり、このステップの時点では存在しない。** したがって spike 専用の最小クラスを本ステップの中で置く。
  - `packages/core/src/adapters/cloudflare/__spike__/probeDo.ts`:
    ```ts
    import { DurableObject } from "cloudflare:workers";
    export class ProbeDurableObject extends DurableObject {}
    export default { fetch: () => new Response("not found", { status: 404 }) };
    ```
  - `vitest.config.integration.ts`（**既存の D1 / queue 設定は残したまま**、次を足す。ステップ7 で `main` を `apps/web/app/worker/cloudflare/state.ts` へ、バインディングを本番2本へ差し替え、本ステップの追加分は削除する）:
    ```ts
    cloudflareTest({
      // main は WorkersPoolOptions の「トップレベル」であって miniflare の中ではない
      main: "packages/core/src/adapters/cloudflare/__spike__/probeDo.ts",
      miniflare: {
        // …既存の D1 / queue 設定はこの時点では残す…
        durableObjects: { PROBE: { className: "ProbeDurableObject", useSQLite: true } },
      },
    })
    ```
  - **`main` の置き場所と `useSQLite: true` の必須性は、ステップ7 に書いた理由とまったく同じである**（`main` は `SourcelessWorkerOptions` に無く `miniflare` の中に書くと zod の `passthrough` で黙って無視される / `useSQLite` を落とすと KV バックエンドになり `ctx.storage.sql` が存在しない）。**このステップで落とすと12項目とも1つも通らず、しかも「FTS5 が動かないのか環境設定が違うのか」を切り分けられない。** ステップ1 は失敗したら `.adr/003` / 第8.4節という**最上流の設計判断に戻る**ステップなので、切り分け不能な赤を出してはならない。
  - **`packages/core` から DO の型を取るときは `@cloudflare/workers-types` から type-import する。** 実測で `packages/core/tsconfig.json` の `types` は `["node"]` だけなので、`SqlStorage` / `DurableObjectState` などは `import type { SqlStorage, DurableObjectState } from "@cloudflare/workers-types";` と書く（既存の `application/di/serverCloudflare.ts:1` と同じ形）。**ステップ4 / 5 / 10 / 15 でも同じ書き方をする。**
- **変更内容:** `@cloudflare/vitest-pool-workers` の DO 環境で次を確認し、結果を `.thread/37/adr.md` の末尾に「## 付録: spike の実測結果」として追記する。
  1. `CREATE VIRTUAL TABLE search_fts USING fts5(title, body, content='search_entries', content_rowid='rowid', tokenize='trigram')` が作れる（F-11）
  2. 「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件を投入し、`search_fts MATCH '東京駅'` が2件返る（F-11）
  3. `ORDER BY bm25(search_fts, 3.0, 1.0)` が例外を上げずに順位を返す（F-12）
  4. `instr(title, ?) > 0 OR instr(body, ?) > 0` に2文字の `東京` を渡して2件返る（短語フォールバック）
  5. `周辺` を `limit 1` で2ページに割ると1ページ目と2ページ目で別の項目が返る（ページング）
  6. `snippet()` / `highlight()` が使えるか（F-13。**設計はこれに依存しないので、使えなくても結論は動かない**）
  7. `transactionSync` のネストが可能か（F-14）
  8. `UPDATE ... RETURNING 1` が使えるか / `SELECT changes()` が直前の DML のマッチ行数を返すか（第8.4節。**`RETURNING` が使えれば `changes()` は不要**）
  9. 1クエリの結果セット合計サイズ上限（F-26。export 上限の根拠値 → #38）
  10. `sql.exec()` が `Date.now()` を進めるか（F-32b。**設計はこれに依存しない**）
  11. Alarm / RPC が CPU リセットの契機に当たるか（F-4b。保守的な読みが正しいかの確認のみ）
  12. `(iii-a)` 1,000行 / `(iii-b)` 20チャンクの初期値が現実的か（10万行規模の `purge_after` 一括更新を回して所要を見る）
- **理由:** `.adr/003` は「公式ドキュメントに記載の無い FTS5 の挙動が実行環境で動くことに依存しており、実装着手時に再確認する。再確認が覆れば本決定そのものが成立しない」と明記している。Issue の対応項目4「tokenizer を実環境で検証」と同じ作業なので独立した工数を足さない。**結果の書き戻し先は3つ** — `.thread/37/adr.md` の付録（このステップ）/ `spec/database/index.md`「FTS5 の tokenizer 方針」/ **`.adr/003` の「影響」欄**（後2者はステップ29）。
- **検証:** `pnpm vitest run --config vitest.config.integration.ts packages/core/src/adapters/cloudflare/__spike__` が全項目パス。3 と 8 が失敗したら**設計判断に戻る**（`.adr/003` / 第8.4節を再検討し、`adr.md` へ記録してから先へ進む）。

---

### 2. leaf モジュール（チューニング定数とジョブ種別）

- **対象ファイル:** `packages/core/src/lib/jobKind.ts`（新規）、`packages/core/src/lib/jobBudgets.ts`（新規）
- **変更内容:**
  - `jobKind.ts`（**import ゼロ**）:
    ```ts
    export const JOB_KINDS = [
      "purge-trash", "reindex", "migrate-bulk", "finalize-withdrawal",
      "sweep-orphan-mapping", "resume-link",
      "send-mail", "resume-signup", "resume-credential-change",
      "sweep-reservations", "sweep-reset-tokens", "rotate-encryption",
    ] as const;
    export type JobKind = (typeof JOB_KINDS)[number];
    export type DoClass = "userData" | "identityDirectory";
    export type RearmClass = "A" | "B" | "C";   // A=時刻駆動 / B=残件駆動 / C=一回性

    // 型注釈を直接付けず as const satisfies で宣言する（理由は下記）
    export const JOB_OWNER = { /* … */ } as const satisfies Readonly<Record<JobKind, DoClass>>;
    export const JOB_REARM = { /* … */ } as const satisfies Readonly<Record<JobKind, RearmClass>>;
    export const REARMING_KINDS: readonly JobKind[];  // A|B の5種
    ```
    - **`JOB_OWNER` / `JOB_REARM` は `as const satisfies …` で宣言し、型注釈（`: Readonly<Record<JobKind, DoClass>>`）を直接付けない。** 型注釈を付けると各値がリテラル型ではなく `DoClass` へ広がり、**ステップ10 の `JobKindOf<D>`（`(typeof JOB_OWNER)[K] extends D ? K : never`）が全 `kind` を返してしまう。** そうなるとレジストリのキー拘束が無効化され、`send-mail` を User Data 側へ登録できてしまう。**この食い違いはステップ2 の検証（キー集合・所有 6/6）ではどちらの形でも通り、ステップ10 の型テスト2件で初めて赤になる**ので、ここで正しい形を書く。
    値は `spec/database/index.md`「`kind` の全数」と第7.4節の表を逐語で写す。所有: User Data = `purge-trash` / `reindex` / `migrate-bulk` / `finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link`、Identity Directory = 残り6種。再武装分類: (A) = `purge-trash` / `sweep-reservations` / `sweep-reset-tokens`、(B) = `sweep-orphan-mapping` / `rotate-encryption`、(C) = 残り7種。
  - `jobBudgets.ts`（**import ゼロ**）: `MAX_JOBS_PER_ALARM = 25` / `MIN_RESUME_INTERVAL_MS` / `DEFAULT_LEASE_MS` / `DEFAULT_MAX_ATTEMPTS` / `DONE_RETENTION_MS` / `POISON_RETENTION_MS` / `SEND_MAIL_EMPTY_RETENTION_MS` / `PRUNE_ROW_LIMIT = 1000` / `CHUNK_BUDGETS: Readonly<Record<JobKind, { chunkRowLimit: number; maxChunks: number }>>`（出発点は 1,000行 / 20チャンク。ステップ1 の実測で調整）/ `backoffMs(attempt: number): number`（指数バックオフ + 上限）。**`JobKind` の型だけを `jobKind.ts` から type-import する（値の import はしない）。**
- **理由:** #40 §3。合成ルート → 実装モジュールという逆向き依存を新構成で再生産しない（adr.md ADR-004）。
- **検証:** `packages/core/src/lib/__tests__/jobKind.test.ts` を追加し、(i) `JOB_KINDS.length === 12`、(ii) `JOB_OWNER` / `JOB_REARM` のキー集合が `JOB_KINDS` と一致、(iii) 所有が User Data 6 / Identity Directory 6、(iv) `REARMING_KINDS` が5要素で内容が固定値と一致、を assert。`pnpm test:unit` と `pnpm typecheck`。

---

### 3. `application/errors.ts` に SystemErrorCode を2値追加

- **対象ファイル:** `packages/core/src/application/errors.ts`
- **変更内容:** `SystemErrorCode` に `ServiceOverloaded: "SERVICE_OVERLOADED"` と `StorageCapacityExceeded: "STORAGE_CAPACITY_EXCEEDED"` を追加する。**`RETRYABLE_SYSTEM_CODES` は変更しない**（`NetworkError` / `ExternalApiError` の2値のまま。とくに `DatabaseError` を足さない）。
- **理由:** 第4.7節。DO のプラットフォームエラー翻訳表が要求する。どちらも `retryable: false`。
- **検証:** `pnpm typecheck`。`apps/web/app/presentation/errorResponse.ts` は**変更しない**（`HTTP_STATUS_BY_KIND` は `kind` 単位のままで、追加2コードは 500 で返る）ことを確認する。

---

### 4. SqlStorage の薄いラッパとエラー翻訳

- **対象ファイル:** `packages/core/src/lib/rpcEnvelope.ts`（新規）、`packages/core/src/adapters/cloudflare/sql/exec.ts` / `occ.ts` / `errors.ts` / `platform/stubErrors.ts` / `platform/envelope.ts`（すべて新規）、`packages/core/src/application/rpc/restoreError.ts`（新規）
- **変更内容:**
  - `exec.ts`:
    ```ts
    export type Sql = SqlStorage;
    export function run(sql: Sql, query: string, ...bindings: unknown[]): void;
    export function all<T>(sql: Sql, query: string, ...bindings: unknown[]): T[];
    export function one<T>(sql: Sql, query: string, ...bindings: unknown[]): T | null;
    export function exists(sql: Sql, query: string, ...bindings: unknown[]): boolean;
    ```
    すべて内部で `translateSqliteError` を通す。`bindings.length > 100` は開発時アサーション（`SystemError(DataIntegrityError)`）。
  - `occ.ts`:
    ```ts
    /** 0 行一致を ConflictError("OPTIMISTIC_LOCK_FAILURE") にする条件付き UPDATE */
    export function conditionalUpdate(sql: Sql, query: string, bindings: readonly unknown[], subject: string): void;
    ```
    `query` は末尾に `RETURNING 1` を含む前提。返った行が0件なら `ConflictError("OPTIMISTIC_LOCK_FAILURE", \`Optimistic lock failure while saving ${subject}\`)` を throw。**メッセージに ID・版番号以外の値を含めない。**
  - `errors.ts`: `SQLITE_FULL` → `SystemError(StorageCapacityExceeded)`、`SQLITE_CONSTRAINT_UNIQUE` / `PRIMARYKEY` → `ConflictError("UNIQUE_VIOLATION")`、`SQLITE_CONSTRAINT_FOREIGNKEY` → `ConflictError("FOREIGN_KEY_VIOLATION")`、その他の `SQLITE_CONSTRAINT*` → `ConflictError("CONSTRAINT_VIOLATION")`、それ以外 → `SystemError(DatabaseError)`。`ApplicationError` はそのまま再 throw。
  - `platform/stubErrors.ts`: `export function translateStubError(error: unknown): never` — `.overloaded === true` → `SystemError(ServiceOverloaded)`、それ以外の RPC 失敗（DO の消滅 / `ctx.abort()`）→ `SystemError(DatabaseError)`。**`ConflictError` へ写さない**（409 は再送を促す意味を持つため）。
  - **`lib/rpcEnvelope.ts`（新規・import ゼロに近い leaf。`./error` の `SerializedErrorBase` だけを type-import する）に、値エンベロープの「型」を置く。** ここが `adapters/` にあってはならない — 復元関数は application 層（`application/rpc/restoreError.ts`）に置くと決めており（下記）、そこから `adapters/cloudflare/platform/envelope.ts` の型を import すると **`application → adapters` の逆流**になって AC-25 の「逆流 import 0件」と衝突する。**これは `MIN_SESSION_SECRET_LENGTH` を `lib/secretLengths.ts` へ移すのとまったく同じ形の是正である**（ステップ13 (b)）。`CLAUDE.md`「Not a layer」が `lib/` を「全層が依存してよい構造的プリミティブ」と定義し、`SerializedErrorBase` が既にそこにある以上、値エンベロープはその定義にそのまま当てはまる（adr.md ADR-014）。
    ```ts
    // packages/core/src/lib/rpcEnvelope.ts
    import type { SerializedErrorBase } from "./error";
    export const RPC_ENVELOPE_VERSION = 1;
    export type SerializedErrorPayload = SerializedErrorBase & { readonly kind: string };
    export type RpcEnvelope<T> =
      | { readonly v: number; readonly ok: true; readonly value: T }
      | { readonly v: number; readonly ok: false; readonly error: SerializedErrorPayload };
    ```
    - **`SerializedError`（presentation の union）を型に取らない。** `SerializedError` は `apps/web/app/presentation/errorResponse.ts:29-37` で8バリアントの union として組み立てられており（実測）、`CLAUDE.md` も「The full `SerializedError` union is assembled here [presentation]」と書いている。`packages/core/` からそこへ依存すると依存方向が逆流する。
  - `platform/envelope.ts` — **型は持たず、`lib/rpcEnvelope.ts` から re-export もしない。** 置くのは `toSerialized()` を叩く構築ヘルパ2本だけである（`err` は `SerializableError` かどうかを構造的に判定するので `lib/error.ts` の `isSerializableError` に依存する = adapters → lib で内向き）。
    ```ts
    // packages/core/src/adapters/cloudflare/platform/envelope.ts
    import { RPC_ENVELOPE_VERSION, type RpcEnvelope } from "@repo/core/lib/rpcEnvelope";
    export function ok<T>(value: T): RpcEnvelope<T>;
    export function err(error: unknown): RpcEnvelope<never>;   // toSerialized() へ落とす
    ```
  - **`unwrap`（`kind` → 例外クラスの復元）は `packages/core/src/application/rpc/restoreError.ts`（新規）へ置く。** 復元表のキーは core 側の2つのモジュールだけで閉じる — `packages/core/src/application/errors.ts`（`notFound` / `conflict` / `unauthorized` / `forbidden` / `validation` / `system`）と `packages/core/src/domain/error.ts`（`business`）。presentation 専用の `unknown` バリアントは DO から出てこないので列挙に含めない。**型は `lib/rpcEnvelope.ts` から取る**（`adapters/` を import しない）。
    ```ts
    // packages/core/src/application/rpc/restoreError.ts
    import type { RpcEnvelope, SerializedErrorPayload } from "@repo/core/lib/rpcEnvelope";
    export function restoreError(payload: SerializedErrorPayload): Error;
    export function unwrap<T>(envelope: RpcEnvelope<T>): T;   // ok=false なら restoreError を throw
    ```
    - **未知の `kind` は黙って落とさない。** 復元表に無い `kind` は `SystemError(DataIntegrityError)` にする（新しいバリアントを足して復元表を直し忘れたときに、静かに潰れるのが最悪の失敗である）。
    - **復元表のキー集合が `SerializedError` の `kind` 集合と一致することを presentation 側の unit テストで固定する。** `errorResponse.ts` の `SERIALIZED_ERROR_KINDS`（`as const satisfies Record<SerializedErrorKind, true>`）と同じ形で、`apps/web/app/presentation/__tests__/errorResponse.test.ts` に「`restoreError` の表のキー ∪ `{"unknown"}` === `SERIALIZED_ERROR_KINDS` のキー」を書く。**この検査だけが presentation 側にあるのは正しい** — union の権威が presentation にあるためで、依存方向は presentation → application のまま。
- **理由:** 第4.7節（翻訳層は2箇所）・第8.3節 (d)（値エンベロープ）・第8.4節（OCC の実現手段）・`CLAUDE.md`「Not a layer」（`lib/` は全層が依存してよい構造的プリミティブ）と「エラーは値エンベロープで Worker ↔ DO を渡る」・adr.md ADR-014。AC-25。
- **検証:** `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts` / `envelope.test.ts`、`packages/core/src/application/rpc/__tests__/restoreError.test.ts`（Node プール unit。未知 `kind` が `SystemError(DataIntegrityError)` になることを含める）。**AC-25 の逆流検査を2本ともここで置く**（機械検証。以後ステップ32 の項目11 から参照する）:

  ```sh
  # (i) presentation を import していない（散文の言及は対象外）
  grep -rnE "from \"[^\"]*presentation|require\(\"[^\"]*presentation" packages/core/src
  # (ii) application → adapters の逆流（合成ルート di/ とテストハーネス __tests__/ を除く）
  grep -rnE "from \"(@repo/core/adapters/|\.\./+adapters/)" packages/core/src/application \
    --include='*.ts' | grep -v '/di/' | grep -v '/__tests__/'
  ```

  どちらも 0 件であること。**この2本は「落ちない形に確定してから AC に書く」（`COV-P-007` で `tanstack-start-template` の grep について確立した原則）に従って形を固定してある** — 実測で**現行リポジトリでも両方 0 件**であり、着手前・着手中・最終ゲート（ステップ32 項目11）のどの時点でも成立する。adr.md ADR-018。
  - **(i) を import 文に限る根拠:** 語としての `presentation` は実測で現在9件ヒットするが、**すべて JSDoc の散文**であり（`application/types.ts:8` / `di/types.ts:33,49` / `errors.ts:82,129,132` / `ports/sessionCodec.ts:5,10` / `ports/outboxRepository.ts:3`）、#37 で消えるのは `ports/outboxRepository.ts` の1件だけである。残る8件は**層の役割を正しく説明している記述**で、とくに `errors.ts:129` の「These live in the application layer (not presentation) because…」は AC-25 が守りたい規約そのものの説明にあたる。**語で検査すると「正しいコメントを消して grep を通す」か「AC を無視する」の二択になる。**
  - **(ii) が `di/` を除く根拠:** 合成ルートだけが具象アダプターを組み立てる唯一の正当な場所だからである（`CLAUDE.md`「Dependencies point inward … adapters implementing ports defined inward of them」）。
  - **(ii) が `__tests__/` を除く根拠:** **テストハーネスは合成ルートと同じ役割で具象を組み立てる場所**だからである。`packages/core/src/application/__tests__/helpers.ts` はステップ19 で DO ハーネスへ作り直すが、**ハーネスの目的が具象アダプターの組み立てである以上、作り直した後も `adapters/cloudflare/…` を value import する**（現行も `adapters/webcrypto/hmacSessionCodec` を import している）。除外しないと**最終状態でも 0 件にならない。** `COV-P-007` で `.thread/` と `spec/idea.md` の除外根拠を書いたのと同じ扱いに揃える。

  `pnpm test:unit` / `pnpm typecheck`。

---

### 5. スキーマ（DDL v1）と migration ゲート

- **対象ファイル:** `packages/core/src/adapters/cloudflare/schema/types.ts` / `userData.ts` / `identityDirectory.ts` / `gate.ts`（すべて新規）
- **変更内容:**
  - `types.ts`:
    ```ts
    export type MigrationStep = Readonly<{
      version: number;                        // このステップ適用後の schema_version
      statements: readonly string[];          // DDL。すべて再実行可能な形で書く
      enqueue?: readonly { kind: "reindex" | "migrate-bulk"; step: number }[];
    }>;
    export const USER_DATA_CODE_VERSION: number;         // steps の最大 version
    export const IDENTITY_DIRECTORY_CODE_VERSION: number;
    ```
  - `userData.ts`: `export const USER_DATA_STEPS: readonly MigrationStep[]` — **version 1 で15テーブル**（`spec/database/index.md`「テーブル一覧」の User Data DO 16テーブルから `_meta` を除いた数。除外の理由は下記）+ 全索引 + `search_fts` を作る。`spec/database/index.md` の各テーブルの節を**逐語**で写す（列・型・NOT NULL・CHECK・PK・索引名・部分索引の WHERE 句まで）。とくに落とさない点:
    - `account`: `caller_token` / `reset_version` / `version`、単一行制約
    - `user_settings`: `trash_retention_days` CHECK `>= 1`、`version`
    - `credential_locators`: PK `(credential_id, generation)`、`cl_hmac_uq` UNIQUE `(kind, hmac, generation)`、`usable_for_login` / `label`、`status` の値域は `'active'` の1値
    - `memos` / `topics` / `documents`: 直和 CHECK（trashed ⇔ `purge_after` 非 NULL）、`*_timeline_idx` / `*_trash_idx` / **`*_purge_idx`**、`documents.topic_id` に **FK を張らない**、`CHECK (trashed_with IS NULL OR trashed_with = topic_id)`
    - `memo_revisions`: 複合 PK `(memo_id, revision_number)`、Actor 直和 CHECK、FK ON DELETE CASCADE
    - `document_revisions`: 単一 TEXT PK + `doc_revs_doc_rev_uq` UNIQUE `(document_id, revision_number)`
    - `source_links`: 複合 PK `(document_id, memo_id)`、双方向 FK CASCADE、`source_links_memo_idx`
    - `search_entries`: **`rowid INTEGER PRIMARY KEY`**、`id TEXT NOT NULL` + `search_entries_id_uq` UNIQUE、`search_entries_topic_idx`（部分）、`search_entries_order_idx`
    - `search_fts`: `CREATE VIRTUAL TABLE search_fts USING fts5(title, body, content='search_entries', content_rowid='rowid', tokenize='trigram')`
    - `jobs`: 12列、`jobs_runnable_idx`（部分）/ `jobs_lease_idx`（部分）/ `jobs_completed_idx`
    - `operations`: `target_locators` / `terminal_reason`
    - `migration_progress`: PK `(target_version, step)`
    - `_meta`: `schema_version` / `self_locator`、単一行。**ただし `_meta` の DDL は `USER_DATA_STEPS` の version 1 に含めない** — 後述のとおり `_meta` を作るのはゲートのブートストラップだけであり、権威を1箇所に閉じる（ARCH レビュー S-006）。DDL 文字列は `gate.ts` が持つ
  - `identityDirectory.ts`: `export const IDENTITY_DIRECTORY_STEPS` — **version 1 で4テーブル**（Identity Directory DO の5テーブルから `_meta` を除いた数）+ 索引。`credential_mappings` は PK `(kind, hmac)`、`cm_credential_id_uq` UNIQUE `(credential_id)`、`cm_user_idx`、`cm_reservation_idx`（部分 `WHERE saga_committed IS NULL`）、`change_state` CHECK は**3値**（`IS NULL OR IN ('pending','advanced')`）、`change_origin` CHECK、`reserved_until` は **NOT NULL**。`password_reset_tokens` は `prt_token_hash_uq` / `prt_credential_idx` / `prt_expires_idx` と `change_auth_token` / `consumed_by_operation_id` / `token_key_generation`。`rotation_checkpoints` は置換キー `(rotation_kind, bucket_index, generation)`。
  - `gate.ts`:
    ```ts
    /**
     * DO の全 RPC エントリと alarm() の先頭で呼ぶ。
     * 同期関数であり、schema_version の読み取りから全 DDL の適用まで await を1つも挟まない。
     * これが input gate による排他の根拠である。
     */
    export function runMigrationGate(
      ctx: DurableObjectState,
      steps: readonly MigrationStep[],
      codeVersion: number,
      selfLocator: string,
    ): void;
    ```
    振る舞い: (i) `_meta` が無ければ `CREATE TABLE` + `INSERT`（`schema_version = 0` / `self_locator`）を**1つの `ctx.storage.transactionSync` で**行う（`spec/database/index.md`「適用とバージョン更新を同じトランザクションで」の趣旨をブートストラップにも適用する。作成と初期行が割れた中間状態を作らない）、(ii) `schema_version > codeVersion` なら `SystemError(DatabaseError, "Schema version is newer than this deployment")` を throw（**fail-closed**）、(iii) `schema_version` より大きい各ステップについて、`statements` の適用と `UPDATE _meta SET schema_version = ?` を**同一 `ctx.storage.transactionSync`** で確定し、`enqueue` があれば同じトランザクションで `jobs` 行を書く。**`blockConcurrencyWhile` を使わない。**
    - **このステップでは `enqueue` の実体を書かない（`MigrationStep.enqueue` は型だけ置く）。** `jobs` への投入口は**収束規則3つを持つ `enqueueJob` の1本だけ**であり、それができるのは**ステップ10**（`jobs/table.ts`）である。ここで生 SQL の `INSERT INTO jobs` を書くと投入口が2つになり、`spec/database/index.md`「非集約ストアへの書き込み口は6ストア・7メソッド」という**全数オラクルが実装で破れる**（`jobs` の口が `enqueueJob` だけ、という主張が嘘になる）。**ステップ10 で `enqueueJob` を差し込む**まで、ゲートは `enqueue` を読まない。v1 の `USER_DATA_STEPS` / `IDENTITY_DIRECTORY_STEPS` には `enqueue` を持つ段が無いので #37 の本番経路は踏まないが、**ステップ22 の擬似 v2 ステップは踏む**ので、そこまでに差し込みが済んでいることを確認する。
    - **`_meta` を作るのはこのブートストラップだけであり、`USER_DATA_STEPS` / `IDENTITY_DIRECTORY_STEPS` の version 1 には含めない。** 両方に書くと `spec/database/index.md` の DDL を逐語で写す突き合わせ作業が1テーブルだけずれる。**したがって version 1 の DDL は 15 / 4 テーブル、ゲートを通した後の最終状態は 16 / 5 テーブルであり、AC-1 / AC-2 が数えるのは後者である**（作り手がどちらでも AC の文面は変わらないが、実装指示としてはずれるので**先に決めておく**）。最終状態の数え方（FTS5 の shadow テーブルの除外）はステップ8 の検証1 を参照。
- **理由:** 対応項目6・第9.2節・第9.3節・第9.4節。DDL とバージョンの更新が同一トランザクションであることが「適用したがバージョンが進んでいない」状態を原理的に作れない根拠。
- **検証:** `pnpm typecheck`。DDL 文字列に `${` が無いこと（テンプレート補間で列名を組まない。adr.md ADR-009）を目視で確認。**module スコープで乱数・時刻・非同期 I/O を呼ばないこと**を確認（`grep -n "randomUUID\|Date.now\|fetch(" packages/core/src/adapters/cloudflare/schema/`）。

---

### 6. DO クラスの骨格と state Worker エントリ

- **対象ファイル:** `apps/web/app/durable-objects/userData.ts` / `identityDirectory.ts`（新規）、`apps/web/app/worker/cloudflare/state.ts`（新規）、**`apps/web/vite.config.state.ts`（新規）**、**`apps/web/package.json`（`build:cf` の2段化）**
- **変更内容:**
  - `userData.ts`:
    ```ts
    import { DurableObject } from "cloudflare:workers";
    export class UserDataDurableObject extends DurableObject<StateEnv> {
      // 現在の alarm 時刻を持つ AlarmCache（getAlarm() を呼ばないため。第7.4節 (2)）
      readonly #alarmCache = createAlarmCache();
      // constructor では ctx / env の保持だけを行い、I/O も乱数も触らない
      readSchemaVersion(): RpcEnvelope<number>          // ゲートを通さない診断エントリ
      // 以降のエントリはステップ16で足す
    }
    ```
    `selfLocator` は `ctx.id.name ?? _meta.self_locator` の順で解決する（F-6 の4条件に備える）。
  - **`AlarmCache` の型・生成・所有を1箇所に確定させる。** 型と `createAlarmCache()` は `packages/core/src/adapters/cloudflare/jobs/alarm.ts` が export する（実体はミュータブルな箱1つ `{ scheduledAt: number | null }`。未初期化 = `null` = 無条件に `setAlarm`）。**生成主体は DO クラスで、private field として1インスタンスだけ持つ。** `runRpcEntry`（ステップ16）と `alarm()` は**そのインスタンスを引数で受け取る**。DO クラスにテスト専用の public メソッド（`resetAlarmCache()` 等）を生やさない — テスト間のリセットは `evictAllDurableObjects()` が行う（ステップ23 / adr.md ADR-015）。**このステップでは `alarm.ts` がまだ無いので、型と生成関数の実体はステップ10 で作る。** ここでは field を置く場所と所有だけを固定し、ステップ10 で `createAlarmCache()` を差し込む。
  - `identityDirectory.ts`: 同形。診断エントリは `listBucketUserIds(cursor, limit)`。
  - `state.ts`: `export { UserDataDurableObject } from "../../durable-objects/userData"; export { IdentityDirectoryDurableObject } from "../../durable-objects/identityDirectory"; export default { fetch: () => new Response("not found", { status: 404 }) };` — **公開ルートを持たない**（到達は binding 経由の RPC だけ）。
  - `StateEnv` 型は `packages/core/src/application/di/stateCloudflare.ts` へ置く（ステップ17）が、このステップでは `apps/web/app/worker/cloudflare/state.ts` にローカル定義しておき、ステップ17 で差し替える。
  - **state Worker のビルド設定をここで作る**（adr.md ADR-017）。`apps/web/vite.config.state.ts` を新設し、`state.ts` を `build.lib` として `dist/state/index.js`（ESM・単一ファイル）へ出す。**TanStack Start のプラグイン鎖は request Worker のためのものなので、state Worker には掛けない。** `apps/web/package.json` の `build:cf` を **`vite build --config vite.config.cloudflare.ts && vite build --config vite.config.state.ts`** の2段にする（`outDir` が別なので `emptyOutDir` の既定で相互に消し合わないことを確認する）。
    - **この作業をステップ25 ではなくここに置く理由:** `dist/state/index.js` を最初に要求するのは**ステップ24 の起動スモークテスト**であり、ステップ25 より前にある。「state Worker のエントリを作ったステップがその成果物の作り方も持つ」形にすれば順序逆転が起きない。ステップ25 が扱うのは wrangler 設定側だけになる。
- **理由:** 第3.2節（Worker 分割）・第9.1節（`exports` で宣言する2クラス）・F-6（`ctx.id.name` のフォールバック）・adr.md ADR-015 / ADR-017・AC-22 / AC-23。
- **検証:** `pnpm typecheck`。`pnpm build:cf` の後に `dist/server/index.js` と **`dist/state/index.js`** の両方が存在する。`grep -n "randomUUID\|crypto.getRandomValues\|Date.now\|setTimeout\|fetch(" apps/web/app/durable-objects/ apps/web/app/worker/cloudflare/state.ts` が module スコープで 0 件（AC-23）。

---

### 7. 統合テスト環境に DO バインディングを足す（D1 と併存）

- **対象ファイル:** `vitest.config.integration.ts`、**`packages/core/src/adapters/cloudflare/__tests__/env.d.ts`（新規）**
- **変更内容:** `cloudflareTest({ ... })` に次を足す。**この時点では D1 側の設定を消さない**（旧テストが動き続ける必要がある）。
  ```ts
  cloudflareTest({
    // main は WorkersPoolOptions の「トップレベル」であって miniflare の中ではない
    main: "apps/web/app/worker/cloudflare/state.ts",
    miniflare: {
      // …既存の D1 / queue 設定はこの時点では残す…
      durableObjects: {
        USER_DATA: { className: "UserDataDurableObject", useSQLite: true },
        IDENTITY_DIRECTORY: { className: "IdentityDirectoryDurableObject", useSQLite: true },
      },
    },
  })
  ```
  - **`main` の置き場所を間違えない。** 実測（`node_modules/@cloudflare/vitest-pool-workers@0.16.20/dist/pool/index.d.mts:9-19`）で `main: z.ZodOptional<z.ZodString>` は `WorkersPoolOptionsSchema` の**トップレベル**にあり、JSDoc が「Entrypoint to Worker run in the same isolate/context as tests. This is required to use `import { exports } from "cloudflare:workers"`, **or Durable Objects without an explicit `scriptName`**」と明記している。一方 `miniflare` に渡せるのは `SourcelessWorkerOptions = Omit<WorkerOptions, "script"|"scriptPath"|"modules"|"modulesRoot">`（同 :74-80）で `main` を持たない。**`miniflare` の中に書くと、zod は `passthrough` なので実行時に黙って無視され、`scriptName` 無しの DO バインディングが解決できない形になる。**
  - **`useSQLite: true` は必須であり、文字列ショートハンド（`USER_DATA: "UserDataDurableObject"`）を使ってはならない。** 実測で、pool-workers 0.16.20 が厳密ピンしている **`miniflare@4.20260625.0`**（`dist/src/index.d.ts:3200-3210`）の `durableObjects` は `Record<string, string | { className; remoteProxyConnectionString?; scriptName?; useSQLite?; unsafeUniqueKey?; unsafePreventEviction?; container? }>` で、`useSQLite` は**省略可のブーリアン**である（既定は KV バックエンド。内部表現では `enableSql` に正規化される）。**`DurableObjectOptions` という型名は存在しない**（値型は上記の匿名 union）。KV バックエンドの DO には `ctx.storage.sql` が存在しないので、**この1行を落とすと本 Issue の DO SQLite 統合テストが1本も動かない。** プロダクション側は wrangler の `exports` が `storage = "sqlite"` を宣言するので取り違えが起きない（adr.md ADR-006 の「backend の取り違えが起きない」は**デプロイ経路の話**である）が、**テスト環境は別系統でありその保証は効かない。** AC-1 / AC-2 / AC-7 / AC-9 / AC-10〜AC-13 / AC-16 / AC-21 が全部この1行に乗っている。
    - **版の出所を取り違えない。** リポジトリには `miniflare` が2版入っており（実測）、`4.20260625.0` を引くのが `@cloudflare/vitest-pool-workers@0.16.20` と `wrangler@4.105.0`、`4.20260722.0` を引くのが `wrangler@4.114.0`（`apps/web` の `wrangler: ^4.90.1` が解決した版）である。**テストが使うのは前者**であり、`node_modules/miniflare` はトップレベルに存在しない。
  - **設定オブジェクトを別変数へ切り出さない。** `WorkersPoolOptions` は型として export されていない（実測。`dist/pool/index.d.mts:132` の export リストに無い）ので、切り出すと型検査が効かなくなる。`cloudflareTest(...)` の引数位置に直接書く旨をコメントに残す。
  - `scriptName` は付けない。**テストの `main` が export する DO クラスを直接束ねる形**（上のとおり `main` を `state.ts` に向けて `scriptName` を省く）が、上の JSDoc が名指しする正規の形である。
  - `include` に `packages/core/src/adapters/cloudflare/**/*.integration.test.ts`（既にある）と `apps/web/app/durable-objects/**/*.integration.test.ts` を足す。
  - **`Cloudflare.Env` に DO バインディングを宣言する `.d.ts` を core 側に新設する。** `packages/core/src/adapters/cloudflare/__tests__/env.d.ts` に `USER_DATA: DurableObjectNamespace` / `IDENTITY_DIRECTORY: DurableObjectNamespace` / `APP_URL: string` を宣言する。**これが無いとステップ12 / 19 / 32 の `pnpm typecheck` が `env.USER_DATA` で落ちる。** 現在この宣言を持っているのは `packages/core/src/adapters/d1/__tests__/env.d.ts`（実測で `DB` / `EVENTS_QUEUE?` / `RELAY?` / `APP_URL` / `OUTBOX_*` / `MIGRATIONS` だけ）で、**ステップ19 の `adapters/d1/` 一括削除で消える。** 旧ファイルの冒頭コメントが説明しているとおり `packages/core` は `apps/web/worker-configuration.d.ts`（web の生成物）を参照できないので、**core 側に独自の `.d.ts` が要る** — その理由をコメントとして引き継ぐ。`apps/web/app/durable-objects/**` 側のテストは `worker-configuration.d.ts` を使えるので追加は不要。
- **理由:** 対応項目9・AC-21。`.adr/001` が「`include` はディレクトリの明示的な許可リスト」と決めているので、新設ディレクトリは同じ変更で追記する。
- **検証:**
  - `pnpm test:integration` が既存104ケースを維持したまま通る。
  - `pnpm typecheck` が通る（新 `env.d.ts` が効いていることの確認）。
  - **バインディング形が正しいことを単独で確認する** — `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts` を1本置き、`runInDurableObject(stub, (_, ctx) => ctx.storage.sql.exec("SELECT 1"))` が例外なく通ることを USER_DATA / IDENTITY_DIRECTORY の両方で assert する。**ステップ8 のテーブル集合検証より前にこれを緑にする** — ステップ8 が落ちたときに原因が DDL なのかバインディングなのかを切り分けられるようにするため。

---

### 8. スキーマ / migration ゲートの統合テスト

- **対象ファイル:** `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts`（新規）、`packages/core/src/adapters/cloudflare/__tests__/doHarness.ts`（新規。DO 内で `SqlStorage` を直接触るテスト用ヘルパ）
- **変更内容:** 次を検証する。
  1. 初回のゲート通過で User Data DO の**16テーブル**と全索引が作られる。**`sqlite_master` をそのまま数えてはならない** — 除外条件を明示した集合比較にする。

     ```sql
     SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'          -- sqlite_sequence 等
        AND name NOT LIKE 'search_fts\_%' ESCAPE '\'   -- FTS5 の shadow テーブル
      ORDER BY name
     ```

     - **理由（実測。SQLite 3.51.0 で `content='search_entries'` の外部コンテンツ FTS5 を作って `sqlite_master` を確認した）:** shadow テーブルとして `search_fts_data` / `search_fts_idx` / `search_fts_docsize` / `search_fts_config` の**4つ**が `type='table'` として現れる（external-content なので `search_fts_content` は作られない）。除外しないと集合は 16 ではなく **20** になり、**AC-1 の検証が必ず落ちる。**
     - **除外条件が空振りしていないことも1度 assert する** — 上の除外パターンに一致する行がちょうど4件あり、その名前が `search_fts_config` / `search_fts_data` / `search_fts_docsize` / `search_fts_idx` であること。**空振りしていると「shadow テーブルが作られていない ＝ external-content になっていない」ことに気づけない。**
     - **索引名の集合も同じ形で比較する** — `SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' AND name NOT LIKE 'sqlite_%'`。実測で、インラインの `PRIMARY KEY` / `UNIQUE`（`INTEGER PRIMARY KEY` を除く）は `sqlite_autoindex_{table}_{n}` を自動生成するので、除外しないと固定値との比較が落ちる。
  2. Identity Directory DO の**5テーブル**と索引が作られる（FTS5 が無いので除外は `sqlite_%` だけでよい。索引側の `sqlite_autoindex_%` 除外は同じく要る）
  3. ゲートが冪等（2回呼んでも `schema_version` が進まず DDL が失敗しない）
  4. `_meta.self_locator` が `ctx.id.name` から書かれる
  5. `schema_version` をコードの最大版より大きくすると、以降の RPC が `SystemError` を返す（**fail-closed**）
  6. fail-closed の DO の `alarm()` がジョブを実行せず、`deleteAlarm()` もせず、一定間隔で `setAlarm` を張り直す（ステップ10 / 16 の後に有効化する。このステップでは skip を置いてよい）
  7. `search_fts` が external-content 構成で作られていること。**判定は `sqlite_master.sql` の文字列一致で行う** — `SELECT sql FROM sqlite_master WHERE name='search_fts'` が `content='search_entries'` / `content_rowid='rowid'` / `tokenize='trigram'` の3つを含むこと（検証1 の shadow テーブル4件の存在と対で見る）
  8. 各テーブルの全列に1回ずつ INSERT / SELECT が通る（adr.md ADR-009 の「列名のタイポが実行時まで出ない」への対策）
- **理由:** AC-1 / AC-2 / AC-16。
- **検証:** `pnpm test:integration`。

---

### 9. FTS5 projection と tokenizer 検証

- **対象ファイル:** `packages/core/src/adapters/cloudflare/search/normalize.ts` / `projection.ts` / `probe.ts`（新規）、`packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts` / `tokenizer.integration.test.ts`（新規）、`packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts`（新規・unit）
- **変更内容:**
  - `normalize.ts`: `export function normalizeForIndex(value: string): string` — `value.normalize("NFKC").trim()`。**インデックス側とクエリ側の両方で通す。**
  - `projection.ts`:
    ```ts
    export type SearchProjectionRow = Readonly<{
      id: string; type: "memo" | "document"; topicId: string | null;
      title: string; body: string; timestamp: number; sourceIds: readonly string[];
    }>;
    /** 本体を書く transactionSync の中から呼ぶ。旧値 delete → 新値 insert の2段を発行する */
    export function upsertSearchEntry(sql: Sql, row: SearchProjectionRow): void;
    /** ソフトデリート・ハードデリート時に呼ぶ。旧値 delete → search_entries の行削除 */
    export function removeSearchEntry(sql: Sql, id: string): void;
    ```
    実装の要点:
    - 既存行を `SELECT rowid, title, body FROM search_entries WHERE id = ?` で読む
    - 存在すれば `INSERT INTO search_fts(search_fts, rowid, title, body) VALUES('delete', ?, ?, ?)` を**旧値で**発行する（**`DELETE FROM search_fts WHERE rowid = ?` と書かない**）
    - `search_entries` を `INSERT ... ON CONFLICT(id) DO UPDATE` で書き、`RETURNING rowid` で rowid を得る
    - `INSERT INTO search_fts(rowid, title, body) VALUES (?, ?, ?)` を新値で発行する
    - `title` / `body` は `normalizeForIndex` を通した値を入れる。**原文は入れない**
    - `sourceIds` は JSON 配列文字列。**active な相手だけを入れる**（呼び出し側の責務。JSDoc に明記）
    - **モジュール JSDoc に「`search_entries` / `search_fts` への唯一の書き込み点である」と明記する**（`.adr/005`）。あわせて「`memos` / `documents` / `topics` の本体行を書くリポジトリ実装は、**同じ `transactionSync` の中でこのモジュールを呼ばなければならない**。呼び忘れても例外は上がらず索引だけが黙って壊れる」を書く。ADR-001 により #37 には memo / knowledge のリポジトリが存在しないので、**この規約を守らせる主体は #2〜#6 である** — 引き継ぎはステップ30 の外部アクションで行う（COV レビュー S-004）
  - `probe.ts`: adr.md ADR-008 のとおり `matchFts(sql, keyword, limit, offsetCursor?)` と `matchShortKeyword(sql, keyword, limit, offsetCursor?)` の2本。**#10 が `SearchIndexPort` を実装するときに吸収するか削除する**旨を JSDoc に書く。
  - 統合テスト `projection.integration.test.ts`:
    - `memos` 行の INSERT と `upsertSearchEntry` を**同一 `transactionSync`** で発行し、コミット後に両方が見えること
    - 同じトランザクションの途中で throw すると `memos` にも `search_entries` にも `search_fts` にも何も残らないこと
    - 本文を更新したあと**旧本文のキーワードでヒットしない**こと（`'delete'` コマンド構文が正しいことの検証。`DELETE FROM search_fts` に書き換えると落ちるテストであること）
    - ソフトデリート・ハードデリートで `search_entries` の行が消え、FTS からもヒットしなくなること
    - 復元で再び作られること
    - `documents` についても同じ5点
  - 統合テスト `tokenizer.integration.test.ts`: ステップ1 の spike 項目 1〜5 を常設テストとして移植する。
- **理由:** 対応項目4・`.adr/003` / `.adr/005`・AC-7 / AC-9。「踏み外すと例外が上がらず索引だけが黙って壊れる」ので、テストは「文が発行されたこと」ではなく「旧値でヒットしないこと」を見る。
- **検証:** `pnpm test:integration` / `pnpm test:unit` / `pnpm typecheck`。ステップ1 の `__spike__` から 1〜5 を移植し終えたら該当部分を削除する。

---

### 10. job table・ジョブランナー・Alarm

- **対象ファイル:** `packages/core/src/adapters/cloudflare/jobs/table.ts` / `runner.ts` / `alarm.ts` / `registry.ts`（新規）、**`packages/core/src/domain/identity/ports/mailSender.ts`（新規。ポート定義だけを本ステップへ前倒しする。実装2本はステップ11）**、`packages/core/src/adapters/cloudflare/jobs/__tests__/*.integration.test.ts`（新規）、`apps/web/app/durable-objects/{userData,identityDirectory}.ts`（ステップ6 で置いた `AlarmCache` field に `createAlarmCache()` を差し込む）
- **変更内容:**
  - `table.ts`（`spec/database/index.md` の `jobs` の節と第7.4節を逐語で実装する）:
    ```ts
    export type EnqueueJobArgs = Readonly<{
      kind: JobKind; operationKey: string; payload: unknown;
      nextRunAt: number; providerIdempotencyKey?: string;
    }>;
    export function enqueueJob(sql: Sql, now: number, args: EnqueueJobArgs): void;
    export function claimJob(sql: Sql, operationKey: string, now: number, ownerToken: string, leaseMs: number): boolean;
    export function listRunnable(sql: Sql, now: number, limit: number, exclude: readonly string[]): JobRow[];
    export function completeJob(sql: Sql, operationKey: string, ownerToken: string, now: number, nextRunAt: number | null): void;
    export function failJob(sql: Sql, operationKey: string, ownerToken: string, now: number, attempt: number, nextRunAt: number): void;
    export function poisonJob(sql: Sql, operationKey: string, ownerToken: string, now: number, terminalReason: string): void;
    export function releaseJob(sql: Sql, operationKey: string, ownerToken: string): void;   // (iii-b) の中断
    export function earliestNextRunAt(sql: Sql): number | null;
    export function pruneCompleted(sql: Sql, now: number, limit: number): number;
    ```
    `enqueueJob` の収束規則3つ（**順序が重要。(2)(3) が (1) に優先する**）:
    1. 行が無ければ INSERT（`status='pending'` / `attempt=0`）
    2. `status='poison'` → `kind` によらず `pending` へ戻し、`attempt=0`、`next_run_at` / `payload` / `payload_digest` を引数の値で置換。**`terminal_reason` は残す。別行を作らない**
    3. `status='done'` → **`REARMING_KINDS`（A/B の5種）に限り** `pending` へ戻す（更新の形は 2 と同じ）。**それ以外の7種は何も書かずに成功を返す**
    4. `status IN ('pending','running')` → `payload_digest`（**`next_run_at` を除いた payload** の digest）が違えば `ConflictError`。一致するなら `status='pending'` のときだけ `next_run_at` を**早める方向にのみ**更新する。**`status='running'` の行の `next_run_at` は書き換えない**
    `completeJob` / `poisonJob` は**同じ文で** `completed_at = now`、`lease_until` / `owner_token` / `next_run_at` を `NULL` にする（`nextRunAt` が非 NULL のときは再武装なので `status='pending'` へ戻し `completed_at` は書かない）。
    `claimJob` の述語: `WHERE operation_key = ? AND (status='pending' OR (status='running' AND lease_until < ?))`。**第2の選言に `status='running'` を必ず含める。**
  - `registry.ts` — **`JobContext` は DO クラスごとに2型へ分ける**（ADR-003 と同じ形）。`env: unknown` は置かない。
    ```ts
    type JobContextBase = Readonly<{
      /** transactionSync の唯一の入口。ハンドラはトランザクションの外で走るので自分で開く */
      ctx: DurableObjectState;
      sql: Sql; now: number; ownerToken: string;
      logger: Logger; idGenerator: IdGenerator;
    }>;
    export type UserDataJobContext = JobContextBase;
    export type IdentityDirectoryJobContext = JobContextBase &
      Readonly<{ mailSender: MailSender; appUrl: string }>;
    export type JobOutcome =
      | { readonly kind: "done" }
      | { readonly kind: "rearm"; readonly nextRunAt: number }
      | { readonly kind: "yield" };            // (iii-b) の中断
    export type JobHandler<TCtx> = (ctx: TCtx, row: JobRow) => Promise<JobOutcome>;

    /** JOB_OWNER から所有 DO クラス別の kind 集合を導く。表を二重管理しない */
    export type JobKindOf<D extends DoClass> =
      { [K in JobKind]: (typeof JOB_OWNER)[K] extends D ? K : never }[JobKind];

    export const USER_DATA_JOB_HANDLERS:
      Partial<Record<JobKindOf<"userData">, JobHandler<UserDataJobContext>>>;
    export const IDENTITY_DIRECTORY_JOB_HANDLERS:
      Partial<Record<JobKindOf<"identityDirectory">, JobHandler<IdentityDirectoryJobContext>>>;
    ```
    - **レジストリのキーを所有 DO クラスで型拘束する。** `Partial<Record<JobKind, …>>` のままだと `send-mail`（Identity Directory 所有）を User Data 側のレジストリへ登録できてしまう。ステップ2 で `JOB_OWNER: Readonly<Record<JobKind, DoClass>>` を**型として**持つと決めた以上、そこから条件型で絞れる（`CLAUDE.md`「Make illegal states unrepresentable at the type level before falling back to runtime checks」）。**`JOB_OWNER` は `as const satisfies Readonly<Record<JobKind, DoClass>>` で宣言し、リテラル型が保たれるようにする** — `Readonly<Record<JobKind, DoClass>>` の型注釈を直接付けると `JobKindOf` が全 kind を返してしまう。
    - **ハンドラ本体の側も所有クラスで割れることを利用する。** `UserDataJobContext = JobContextBase` / `IdentityDirectoryJobContext = JobContextBase & {…}` は構造的部分型なので、**User Data 用ハンドラを Identity Directory 側のレジストリへ登録するのは引数の反変性で通る。** これはキー拘束で塞ぐ（登録できる `kind` が割れているので、通ってもキーが無い）。**この非対称を registry.ts の JSDoc に1行残す。**
    - **`JobContext` に載せてよいものの禁止則は `UnitOfWorkContext` とは別である**旨を JSDoc に明記する。ジョブはトランザクションの**外**で走るので `MailSender` のような非同期ポートを持ってよい。混同すると `UnitOfWorkContext` 側の「非同期ポートを載せない」という禁止則が緩む。
    - **`ctx: DurableObjectState` を持たせるのは `transactionSync` を開くためである。** `sql` だけではステップ20 が要求する「メモのハードデリートの (i)〜(iv) を同一 `transactionSync`」も、ステップ20 の「チャンク反復上限で `yield` を返し `releaseJob` と進捗を同じトランザクションでコミット」も書けない。
    - **`MailSender` は名前で受ける。** adr.md ADR-007 が「state Worker の合成ルートが `env.MAIL_SENDER` の有無で選ぶ」と決めている以上、選ばれた実装がハンドラまで届く経路が型で要る。`env: unknown` からのキャストは ADR-007 を骨抜きにするうえ、`CLAUDE.md`「Make illegal states unrepresentable at the type level」に正面から反する。
      - **したがって `MailSender` の型がこのステップで要る。** `packages/core/src/domain/identity/ports/mailSender.ts`（`sendPasswordResetMail(to: Email, resetToken: string): Promise<void>`）を**本ステップの対象に前倒しする** — ステップ11 に置いたままだと `registry.ts` が未定義の型を参照して `pnpm typecheck`（本ステップの検証）が通らない。**ステップ11 に残すのは実装2本（`createBindingMailSender` / `NoopMailSender`）だけである。**
    - 未登録 `kind` は `terminalReason: "UNIMPLEMENTED_JOB_KIND"` で `poison`（adr.md ADR-002）。
  - `runner.ts`: `export async function runDueJobs<TCtx extends JobContextBase>(ctx: TCtx, handlers: Partial<Record<JobKind, JobHandler<TCtx>>>, now: number): Promise<void>` —
    - 外側の上限は `MAX_JOBS_PER_ALARM = 25`
    - 1件ずつ claim → 実行 → 結果を1件ごとにコミット
    - **`yield` を返したジョブの `operationKey` を除外集合へ入れ、同じ起動では再 claim しない**（除外集合は揮発値。`jobs` に列を足さない）
    - **各ジョブを `try / catch` で包む**（`CLAUDE.md`「worker → root」で許される唯一の広い catch）。失敗は `attempt` を進めてバックオフ、上限超過で `poison` + `terminal_reason`。**`terminal_reason` に載せるのは終端の理由と `operationId` だけで、PII と再利用可能な秘密（canonical / `hmac` / locator / `callerToken` / `changeAuthToken` / `passwordVerifier` / リセットトークン）を載せない**
    - `ConflictError` は握り潰さず `terminal_reason` へ落とす（第7.7節 項6）
    - 末尾で `pruneCompleted`（`done` / `poison` を別々の保持期間で、最大 `PRUNE_ROW_LIMIT` 行）
    - **`alarm()` から throw しない**
  - `alarm.ts`:
    ```ts
    /** DO インスタンスが持つ現在の alarm 時刻。null は未初期化（無条件に setAlarm） */
    export type AlarmCache = { scheduledAt: number | null };
    export function createAlarmCache(): AlarmCache;

    /** alarm() の先頭で、仕事の前に呼ぶ。now + MIN_RESUME_INTERVAL_MS を張って sync() で永続化を確認する */
    export async function rearmBeforeWork(ctx: DurableObjectState, now: number): Promise<void>;
    /** 正常完了時。実行可能集合が空なら deleteAlarm、あれば最早 next_run_at へ張り直す。どちらも sync() で確認する */
    export async function settleAlarm(ctx: DurableObjectState, sql: Sql, now: number, cache: AlarmCache): Promise<void>;
    /** RPC 経路。run() の戻り後、await を1つも挟まずに呼ぶ */
    export async function armAfterRpc(ctx: DurableObjectState, sql: Sql, now: number, cache: AlarmCache): Promise<void>;
    ```
    - **`getAlarm()` を呼ばない。** DO インスタンスのフィールド（`AlarmCache`）に現在の alarm 時刻を保持して比較する。未初期化なら無条件に `setAlarm`。**`AlarmCache` の生成主体は DO クラスであり、`alarm.ts` の3関数と `runRpcEntry`（ステップ16）は引数で受け取るだけである**（ステップ6 で置き場を確定済み）。**DO クラスにテスト専用の public メソッドを生やさない** — テスト間のリセットは `evictAllDurableObjects()` が行う（ステップ23 / adr.md ADR-015）
    - **`setAlarm` の戻り値に依拠しない。** 永続化の確認は `await ctx.storage.sync()` だけ
    - `sync()` が失敗したら RPC 自体を失敗させる
    - 過去・現在時刻の due job はプラットフォーム側の alarm だけを `now + 1000` へ clamp する（DB の `next_run_at` は変えない）
    - **`armAfterRpc` は `run()` を呼ばない RPC エントリでも発火する**（射程は全 RPC エントリ。例外は `read-schema-version` / `list-bucket-user-ids` の2本のみ）
  - **`ownerToken` はハンドラ側で `idGenerator.next()` から採番して引数で渡す**（#40 §2 / AC-24）。module スコープで採番しない。
  - 統合テスト（`jobs/__tests__/`）— H-2 / H-3 が要求する後継:
    - 同じ `operationKey` の重複投入が行1本に収束する
    - 再投入が `nextRunAt` を早める方向にのみ動かし、遅い値では何も書かない
    - `status='running'` の行への再投入が `next_run_at` を書き換えない
    - `payload_digest` の不一致が実行可能集合の行でだけ `ConflictError` になり、`done` / `poison` では収束規則が優先する
    - `done` からの復帰が (A)(B) の5種でだけ起きる／(C) の7種では起きない
    - `poison` からの復帰が `kind` によらず起き、`terminal_reason` が残る
    - lease 満了の行が再 claim できる（**DO 再起動の代理**）。`done` / `poison` の行が過去の `lease_until` を持っていても再 claim されない
    - 失敗が `attempt` を進めてバックオフし、上限超過で `poison` + `terminal_reason` になる
    - 1つのジョブが throw しても他のジョブが実行され、`alarm()` から例外が出ない
    - ハンドラ先頭の再武装が、その後の処理が落ちても残っている
    - 実行可能集合が空になったとき `deleteAlarm` が呼ばれる（fail-closed の DO では呼ばれない）
    - `yield` を返したジョブが同じ起動で再 claim されない
    - `terminal_reason` に禁止値が載らない（禁止語の配列で assert）。**配列は `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts` に置き、ステップ17 のログ非露出テスト（AC-3）と共有する**
- **理由:** 対応項目5・第7.4節・H-2 / H-3・AC-12 / AC-13 / AC-15（`MailSender` ポートのドメイン側定義）/ AC-24 / AC-27。
- **検証:** `pnpm test:integration` / `pnpm typecheck`。**`pnpm typecheck` が通るのはこのステップで `MailSender` ポートを持つからである**（実装はステップ11 だが、型が無いと `IdentityDirectoryJobContext` が定義できない）。ハンドラレジストリのキー拘束を型テストで固定する — `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts` に「`USER_DATA_JOB_HANDLERS` へ `"send-mail"` を登録すると `// @ts-expect-error` になる」「`IDENTITY_DIRECTORY_JOB_HANDLERS` へ `"purge-trash"` を登録すると `// @ts-expect-error` になる」の2件を置く。あわせて adr.md ADR-002 が要求する「レジストリのキー集合 = 7種」の unit テストを**所有クラス別（User Data 3 / Identity Directory 4）に割った形**で書く。

---

### 11. プラットフォーム境界のアダプター（MailSender の実装2本）

- **対象ファイル:** `packages/core/src/adapters/cloudflare/mailSender.ts`（新規）
- **ポート定義（`packages/core/src/domain/identity/ports/mailSender.ts`）はステップ10 で作成済み。** `registry.ts` の `IdentityDirectoryJobContext` がその型を要求するため前倒しした（ステップ10 単独で `pnpm typecheck` を通すための最小の前倒しであり、実装2本はここに残す）。**このステップはステップ10 に依存しない**ので、順序を入れ替えても成立する。
- **変更内容:** adr.md ADR-007 のとおり。ポートはドメイン側（`spec/domains/identity.md` の定義）、実装は `adapters/cloudflare/`。`createBindingMailSender(fetcher: Fetcher, appUrl: string, logger: Logger): MailSender` と `NoopMailSender(logger: Logger): MailSender`。`providerIdempotencyKey` は `Idempotency-Key` ヘッダで運ぶ。**リセットリンク URL の組み立てはアダプターの責務**（`spec/domains/identity.md`）。
- **理由:** H-6（「残す永続ジョブ側で同種の抽象が必要なら `application/ports/` に置き実装は `adapters/cloudflare/` へ」）。`MailSender` はドメインが既に定義しているので `domain/identity/ports/` に置く。
- **検証:** `pnpm typecheck` / `pnpm test:unit`（`NoopMailSender` が logger.warn を出すこと）。

---

### 12. イベント機構の撤去（原子ブロックの前段。単独で typecheck-clean）

- **対象ファイル:**
  - **削除（ディレクトリごと）:** `packages/core/src/application/workers/`、`packages/core/src/application/events/`
  - **削除（ファイル）:** `packages/core/src/domain/common/event.ts`、`packages/core/src/domain/identity/events.ts`、`packages/core/src/application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts`、`packages/core/src/application/di/env.ts`、`packages/core/src/application/di/__tests__/serverCloudflare.test.ts`（`readRelayTuning` / `readPruneTuning` の検証。移植先が無い）、`packages/core/src/application/identity/{eventDecoders.ts,__tests__/eventDecoders.test.ts}`、`packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`、**`packages/core/src/adapters/d1/repositories/{outboxRepository,idempotencyStore}.ts`**、**`packages/core/src/adapters/d1/__tests__/{outboxRepository,idempotencyStore}.integration.test.ts`**、`apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq,handlers}.ts`、`apps/web/app/worker/cloudflare/__tests__/{handlers.integration.test.ts,env.d.ts}`
  - **改修:** `packages/core/src/domain/identity/entity.ts`（ファクトリの戻り値を `WithEventDrafts<User>` → `User` に。**この時点では `User` の形そのものは変えない**）、`packages/core/src/application/execution/unitOfWork.ts`（`UnitOfWorkContext` から `collectEvents` を外す。**`run` はまだ非同期のまま**）、**`packages/core/src/application/di/serverCloudflare.ts`（部分改修。下記）**、**`packages/core/src/application/ports/idGenerator.ts`（JSDoc の "outbox" 言及を削除。実測 `:21`）**、`packages/core/src/adapters/d1/unitOfWork.ts`（outbox 行の書き込みと **`relayTrigger` コンストラクタ引数**を外す）、**`packages/core/src/adapters/d1/schema.ts`（`outboxEvents` / `processedEvents` のテーブル定義を削除）**、**`packages/core/src/adapters/d1/__tests__/{helpers.ts,setup.ts,unitOfWork.integration.test.ts,occGuard.integration.test.ts}`（下記）**、`packages/core/src/application/identity/registerWithPassword.ts`（`collectEvents` 呼び出しを削除）、**`packages/core/src/application/identity/__tests__/loginWithPassword.test.ts`（フェイク UoW コンテキストから `collectEvents` を落とす。下記）**、**`packages/core/src/application/identity/__tests__/identity.integration.test.ts`（outbox アサーションの除去。下記）**、`packages/core/src/application/di/types.ts`（`WorkerContainer` を削除し、`collectEvents` を説明する段落を削除）、`packages/core/src/application/__tests__/helpers.ts`（`D1OutboxRepository` / `D1IdempotencyStore` / `WorkerContainer` の組み立てを外す。**DO ハーネス化はステップ19**）、`apps/web/app/server.cloudflare.ts`（`RELAY` Service Binding の参照を落とす）、`apps/web/wrangler.toml`（`[env.relay]` / `[env.consumer]` / `[env.pruner]` / `[env.dlq]` の4ブロックと `[[services]] RELAY` と `OUTBOX_*` を削除。**D1 のブロックはこの時点では残す**）、**`packages/core/src/adapters/d1/__tests__/env.d.ts`（`OUTBOX_*` 4行と `RELAY?` を削除。下記）**、**`apps/web/wrangler.staging.toml.tpl` / `apps/web/wrangler.production.toml.tpl`（`[env.relay]` / `[env.consumer]` / `[env.pruner]` / `[env.dlq]` の4ブロックと `[[services]] RELAY` を削除。下記）**、ルート `package.json` / `apps/web/package.json`（`deploy:*:{relay,consumer,pruner,dlq}{,:dry}` の16本を削除し、**`deploy:{staging,production}:all{,:dry}` の中身を `pnpm deploy:{staging,production}{,:dry}` 1本へ縮める**。`deploy:{staging,production}{,:dry}` と `:all{,:dry}` の8本という**本数**は**ステップ26 まで残す**）
- **変更内容:** **ドメインイベントという抽象そのものを消す。** `.adr/004` の決定を、`User` の形の作り直し（ステップ13）とリポジトリの同期化（ステップ14〜15）から**切り離して**先に実行する。この撤去は `User` のフィールド構成にもポートの `Promise` 契約にも触らないので、**このステップ単独で `pnpm typecheck` / `pnpm test:unit` / `pnpm test:integration` が通る。ただしそれが成立するのは、削除するモジュールを import している「消し残し」を同じステップで全部処理したときだけである。** 実測で残っていた7経路（下記 (i)〜(v) と、`d1/unitOfWork.ts` の `relayTrigger` / `ports/idGenerator.ts` の JSDoc）を明示的に対象へ入れてある。**`collectEvents` の全参照を実測で洗い直したところ 10ファイルで、すべて本ステップの削除・改修リストに入っている**（`adapters/d1/{unitOfWork.ts,repositories/outboxRepository.ts,__tests__/unitOfWork.integration.test.ts}` / `application/{execution/unitOfWork.ts,di/types.ts,ports/outboxRepository.ts,workers/__tests__/eventRelayWorker.integration.test.ts}` / `application/identity/{registerWithPassword.ts,__tests__/identity.integration.test.ts,__tests__/loginWithPassword.test.ts}`）。
  - `entity.ts` は戻り値の包み（`WithEventDrafts<T>` → `T`）だけを外し、`attachEventIds` の呼び出しを削除する。**`credentials` への読み替えはステップ13 で行う。**
  - `unitOfWork.ts` は `collectEvents` をコンテキストから外すだけで、署名（`run<T>(fn: (ctx) => Promise<T>): Promise<T>`）は据え置く。**`enqueueJob` の導入はステップ14。**
  - **(i) `adapters/d1/` の outbox / idempotency 実装を落とす。** 実測で `adapters/d1/repositories/outboxRepository.ts:1-10` は `application/ports/outboxRepository` と `domain/common/event` を、`adapters/d1/repositories/idempotencyStore.ts:1-3` は `application/ports/idempotencyStore` と `domain/common/event` を import しており、**このステップで削除するモジュールに依存している。** 2ファイルと対応する統合テスト2本を削除し、`adapters/d1/schema.ts` から `outboxEvents` / `processedEvents` を、`adapters/d1/__tests__/helpers.ts` から `D1OutboxRepository` / `D1IdempotencyStore` の組み立てを外す。`adapters/d1/__tests__/setup.ts` の `DELETE FROM outbox_events` の1行も落とす（**テーブル DDL 自体は `migrations/0000_initial.sql` に残るので他の TRUNCATE は動く**）。`adapters/d1/__tests__/{unitOfWork,occGuard}.integration.test.ts` から outbox を主張するケースを削除する（実測で `unitOfWork.integration.test.ts:52` / `:71` の2ケースと `occGuard.integration.test.ts:102-126` のブロック。**残さないと「UoW が outbox 行を書く」を主張するテストが赤になる**）。**`adapters/d1/` 全体の削除はステップ19 のまま。**
  - **(ii) `application/di/serverCloudflare.ts` をこの時点で部分改修する。** 実測で `ServiceBindingRelayTrigger` / `NoopRelayTrigger` / `RelayTrigger` / `TuningEnv` / `readRelayTuning` / `readPruneTuning` / `WorkerContainer` / `D1OutboxRepository` / `D1IdempotencyStore` を**すべて value import**しており、`createWorkerContainer` を export している。落とすのは `createWorkerContainer` / `RelayTrigger` の組み立て / `readRelayTuning` / `readPruneTuning` / `TuningEnv` の再 export / `ServerEnv` の `RELAY` と `OUTBOX_*` 4本 / `RequestServerConfig` の `relay` と `waitUntil` / `WorkerContainer` の型 re-export である。**唯一の呼び出し元だった `apps/web/app/worker/cloudflare/handlers.ts` は同じステップで削除される**（実測で `createWorkerContainer` の参照は同ファイルの4箇所だけ）。**stub factory 化（`binding: D1Database` → `userDataStubFactory` / `directoryStubFactory`）はステップ17 のままで、ここでは触らない。**
  - **(iii) `application/identity/__tests__/loginWithPassword.test.ts` のフェイク UoW から `collectEvents` を落とす。** 実測で同ファイル `:45-57` の `container()` ヘルパ（`collectEvents` は `:55`）が `unitOfWorkProvider.run` のフェイクとして `fn({ userRepository: absentUser, collectEvents: () => { throw new Error("login must not enqueue events"); } })` を**オブジェクトリテラルで直接**渡している。`UnitOfWorkContext` から `collectEvents` を外すとこの引数は**リテラルの超過プロパティ（TS2353）**になり、**本ステップの検証1つ目（`pnpm typecheck`）が落ちる。** `collectEvents` のプロパティだけを削除し、**`userRepository` はステップ13 まで残す**（`UserRepository` の分割はステップ13 の作業であり、ここで触ると原子ブロックの境界が崩れる）。「login はイベントを積まない」という元の主張は、イベント機構そのものが消えるので対象消滅である。
  - **(iv) `application/identity/__tests__/identity.integration.test.ts` から outbox アサーションを外す。** 実測で `:163-164` の `outboxRows` ヘルパと `:188-195` / `:225` / `:268` / `:373` / `:391` / `:412` の assert が `schema.outboxEvents` を読んでいる。**`schema.users` の参照（`:162`）と `drizzle-orm` の `sql`（`:29`）はこの時点では残す** — このファイル自体の処遇（削除 → ステップ21 で作り直し）は**ステップ19** である。
  - **(v) `OUTBOX_*` の env 宣言を、このステップで全数落とす。** 実測で `grep -rn "OUTBOX_" . --include='*.ts' --include='*.toml' --include='*.tpl'`（`.thread/` を除く）は **8ファイル・49行**あり、内訳は `apps/web/wrangler.toml` 5行 / `di/env.ts` 12行 / `di/serverCloudflare.ts` 5行 / `di/__tests__/serverCloudflare.test.ts` 14行 / `application/workers/outboxPrune.ts` 1行（**ここまでは上の削除・改修で消える**）/ **`packages/core/src/adapters/d1/__tests__/env.d.ts` 4行** / **`apps/web/wrangler.staging.toml.tpl` 4行** / **`apps/web/wrangler.production.toml.tpl` 4行**である。後ろ3ファイルは上の5経路のどれにも入っておらず、**`env.d.ts` が消えるのはステップ19（`adapters/d1/` 一括削除）、`.tpl` 2本が消えるのはステップ25（作り直し）**なので、対象へ入れないと**本ステップとステップ19 の両方で `OUTBOX_` の grep が 0 件にならない。**
    - `packages/core/src/adapters/d1/__tests__/env.d.ts`: `Cloudflare.Env` から `OUTBOX_BATCH_SIZE?` / `OUTBOX_LEASE_MS?` / `OUTBOX_MAX_ATTEMPTS?` / `OUTBOX_RETENTION_MS?` の4行と `RELAY?: Fetcher` を削除する。**`DB` / `EVENTS_QUEUE?` / `APP_URL` / `MIGRATIONS` と冒頭の `/// <reference types="@cloudflare/vitest-pool-workers/types" />` は残す**（ステップ19 まで D1 統合テストが動き続ける必要がある。後継ファイルはステップ7 で新設済み）。ファイルごと消えるのはステップ19 のままである。
    - `.tpl` 2本: `[env.relay]` / `[env.consumer]` / `[env.pruner]` / `[env.dlq]` の4ブロック（`OUTBOX_*` はこの中にある）と、トップレベルの `[[services]] RELAY` を削除する。**`.tpl` はステップ25 でどのみち4本へ作り直すので、ここで env だけ落としても矛盾しない**（D1 / Queue のプレースホルダはこの時点では残す。撤去はステップ25）。**冒頭コメントの「(+ each `--env <role>`)」「every `[env.*]` block re-declares them」もあわせて落とす** — 存在しない env を案内する手順書になるため。
    - **これで AC-14 の「`OUTBOX_*` の env / vars がどの設定にも残っていない」の担保点が本ステップ1箇所で閉じ**、ステップ19 / 25 の同じ grep も自動的に 0 件のまま通る。
  - `adapters/d1/unitOfWork.ts` は outbox 行の deferred 書き込みと `relayTrigger` 引数を外す。`_occ_guard` / `PendingBatch` は**この時点では残す**（削除はステップ19 の `adapters/d1/` 全削除で行う）。
  - **`deploy:{staging,production}:all{,:dry}` の中身を縮める。** 実測で `:all` は `pnpm deploy:staging && pnpm deploy:staging:relay && …` と5本を連鎖しており、本ステップで後ろ4本が消えると**壊れたスクリプトがステップ26 まで残る。** CI もテストも叩かないので実害は無いが、中身を `pnpm deploy:staging`（`:all:dry` は `pnpm deploy:staging:dry`）へ縮めておけば途中で誰かが叩いても壊れない。**スクリプトそのものの削除はステップ26 のままである。**
- **理由:** `.adr/004`（イベント機構の廃止）は `.adr/008`（identity の分割）とは**別の決定**であり、両者を1コミットに畳むとレビュー粒度が判断の粒度と合わない。加えて型検査の効かない窓が7ステップから6ステップへ縮み、`OUTBOX_*` の env と `[env.*]` 4ブロックの撤去を前倒しできるので、ステップ25 / 26 の設定変更が軽くなる。**分割の唯一の価値は「単独で typecheck-clean」なので、上の (i)〜(v) を削ると分割の意味そのものが消える。** AC-8 / AC-14 / AC-15 / AC-25。
- **検証:**
  - `pnpm typecheck` が通る
  - `pnpm test:unit` が通る（削除したテストの件数を実測して記録）
  - `pnpm test:integration` が通る（`adapters/d1/__tests__/setup.ts` はまだ生きているので実行可能。`handlers.integration.test.ts` / `outboxRepository` / `idempotencyStore` の削除分だけケース数が減る）
  - 次が 0 件であること。**`migrations/` を除外するのは、`0000_initial.sql` と `meta/0000_snapshot.json` に `outbox_events` / `processed_events` の DDL が残るためである** — テーブル定義は D1 の履歴であり、削除は `adapters/d1/` ごと消えるステップ19 で起きる（同ステップの grep は除外を持たない）。

    ```sh
    grep -rn "collectEvents\|EventDispatcher\|RelayTrigger\|outbox\|Outbox\|idempotencyStore\|IdempotencyStore\|WithEventDrafts\|DomainEvent" \
      packages/core/src apps/web/app --exclude-dir=migrations
    ```

  - `grep -rn "OUTBOX_" . --include='*.ts' --include='*.toml' --include='*.tpl'` が 0 件。**この検証が成立するのは上の (v) を実施したときだけである** — 実測で現在 8ファイル・49行あり、そのうち `adapters/d1/__tests__/env.d.ts` と `.tpl` 2本（計12行）は本ステップの他の作業では消えない。`--include` が `*.md` を含まないので `.thread/` は掛からない

---

## ステップ13〜19 — 原子的なカットオーバーブロック

**この7ステップは1つの作業単位である。** ドメインの `User` の形とリポジトリの `Promise` 契約を変えると D1 アダプターと既存ユースケースが同時に壊れるため、途中で型検査を通す方法が無い。**13 に着手したら 19 まで進めてから `pnpm typecheck` を実行する。** 各ステップの検証欄には、型検査の代わりに確認できる項目を書く。

**イベント機構の撤去はこのブロックに含まれない**（ステップ12 で完了済み）。ブロックが原子である根拠は `User` の形とポートの同期化だけであり、それ以外を巻き込まない。

---

### 13. ドメイン層の作り直し

- **対象ファイル:**
  - 削除: `packages/core/src/domain/identity/ports/userRepository.ts`（`domain/common/event.ts` / `domain/identity/events.ts` は**ステップ12 で削除済み**）
  - 改修: `packages/core/src/domain/common/transactionalRepository.ts`、`packages/core/src/domain/identity/entity.ts`、`packages/core/src/domain/identity/valueObject.ts`、`packages/core/src/domain/identity/errorCode.ts`、`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`、`packages/core/src/application/di/secrets.ts`、`packages/core/src/application/di/__tests__/secrets.test.ts`、`packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts`
  - 新規: `packages/core/src/lib/{passwordHashing,secretLengths}.ts`、`packages/core/src/domain/identity/ports/{userSettingsRepository,accountStore,credentialLocatorStore,credentialMappingRepository,credentialMappingStore,passwordResetTokenPort,rotationCheckpointStore}.ts`
- **変更内容:** 上の「設計 > ドメインモデルへの影響」のとおり。加えて:
  - `transactionalRepository.ts`: 全メソッドから `Promise` を外す。`Versioned<T>` / `ExpectedVersion<T>` は据え置き。
  - `entity.ts`: `User = { id; credentials: readonly CredentialRef[]; trashRetentionDays; version; createdAt; updatedAt }`。`User.initialize(params, now): User`（`credentials: []`）/ `User.addCredential(user, ref, now): User` / `User.removeCredential(user, credentialId, now): User`（**`usableForLogin` が真の `credentialId` の異なり数が1のとき `BusinessRuleError(LastLoginCredential)` を投げる**）/ `User.changeTrashRetentionDays(user, days, now): User`（no-op なら同一エンティティ）/ `User.reconstruct(input): User`。**戻り値に `WithEventDrafts` を使わない。**
  - `valueObject.ts`: `CredentialId` を追加。`Email.create` を canonical 化へ差し替え。`PasswordHash` は `credential_mappings.password_verifier` の型として残す。
  - **`valueObject.ts` に SSO canonical の組み立てを足す**（第5.2.1節 (c)）。これが無いと `kind='sso'` の canonical を作るコードが計画上どこにも生まれず、**AC-2 / 受け入れ条件3 の「SSO provider + subject から `userId` を解決できる」半分が実施も検証もされないまま緑になる。**
    ```ts
    /** SSO canonical。provider は lowercase 化し、subject は trim のみ（正規化しない） */
    export function ssoCanonical(provider: SsoProvider, providerSubject: string): string;
    ```
    - 規則: `provider.toLowerCase()` + **区切り子** + `providerSubject.trim()`。**subject に NFKC も lowercase も掛けない**（provider 由来の opaque 値であり、正規化すると provider 側の同一性判定とずれる）。
    - **区切り子はソースに JS のエスケープ表記で書く** — バックスラッシュ + `u0000` の**エスケープ文字列リテラル**（`SEP` という名前付き定数1つに閉じる）として書き、生の NUL バイトをファイルへ埋め込まない。埋め込むと `grep` がそのファイルをバイナリ扱いして無言で0件を返し、機械検証と引き継ぎ項目の検索が同時に壊れる（`plan.md` のリスク欄・第5.2.1節 (c)）。
    - `SsoProvider = "google" | "apple"` という閉じた列挙なので区切りは一意に決まる（provider 名が `U+0000` を含みえない）。
    - **`registerOrLoginWithSso` / OIDC フロー / link / unlink は #37 のスコープ外**（#12）。#37 が作るのは**既存の SSO クレデンシャルから `userId` を解決する経路**だけで、その構成要素は `ssoCanonical`（本ステップ）+ `directoryLocator.forCanonical`（ステップ17。canonical の種別に依存しない）+ `lookupCredential` の `kind='sso'` 対応（ステップ16）である。
  - `errorCode.ts`: `LastLoginCredential` / `InvalidCredentialId` を追加。
  - **逆流依存2件を両方断つ。** 実測で存在するのは次の2件で、**向きも定数も別である**（片方だけ動かしても他方は残る）。
    - (a) `adapters/webcrypto/pbkdf2PasswordHasher.ts:2` が `application/identity/loginWithPassword` から `DUMMY_PASSWORD_HASH_ITERATIONS` を type-import している（adapters → application）。→ `packages/core/src/lib/passwordHashing.ts`（新規・**import ゼロの leaf**）へ `DUMMY_PASSWORD_HASH_ITERATIONS = 210_000` を移し、`pbkdf2PasswordHasher.ts` の `DEFAULT_PBKDF2_ITERATIONS` と `loginWithPassword.ts` の両方がそこを読む。
    - (b) `application/di/secrets.ts:5` が `adapters/webcrypto/hmacSessionCodec` から `MIN_SESSION_SECRET_LENGTH` を value-import している（application → adapters）。→ 同じ `packages/core/src/lib/` の leaf（`packages/core/src/lib/secretLengths.ts`、新規）へ `MIN_SESSION_SECRET_LENGTH = 32` を移し、`hmacSessionCodec.ts` / `di/secrets.ts` / 両者のテスト2本がそこを読む。**ステップ17 で `secrets.ts` を書き直すときにリテラル `32` を再掲しない** — `secrets.test.ts` 冒頭コメントが守っている「長さはアダプターの export 定数から読む。ここで 32 を再掲するとフロアが上がったときに2つの検査が割れる」という不変条件を、置き場を `lib/` へ移したうえで維持する。
- **理由:** `.adr/008`（identity の分割）・第8.2.1節（同期化）・第5.2.1節 (a)(c)（canonical 化）・adr.md ADR-016・AC-2。イベント機構の撤去（`.adr/004`）はステップ12 で完了している。
- **検証:** `packages/core/src/domain/identity/__tests__/` の既存テストを新しい形へ書き直し、`pnpm vitest run packages/core/src/domain` が通ること（ドメイン層だけなら他レイヤーの破損に影響されない）。canonical 化の unit テストに次を必ず含める。
  - **メール（5件）** — 全角 local 部（`ａｂｃ@example.com`）が拒否される / 大文字 local 部が畳まれる / domain 部の全角が NFKC で畳まれる / 日本語ドメインが punycode 化される / punycode 後に 320 を超える入力が拒否される。
  - **SSO（4件）** — `ssoCanonical("Google", "sub-1")` が `ssoCanonical("google", "sub-1")` と一致する（provider の lowercase 化）/ subject の全角・大文字が**畳まれない**（正規化しない）/ subject の前後空白だけが落ちる / **provider が違えば同じ subject でも canonical が異なる**。あわせて **ソースに生の NUL バイトが無いことを機械検証する** — (i) `grep -c 'u0000' packages/core/src/domain/identity/valueObject.ts` が 1 以上（区切り子がエスケープ表記で書かれている）、(ii) `grep -Il . packages/core/src/domain/identity/valueObject.ts` が当該ファイルを出力する（`-I` はバイナリ扱いのファイルを黙って落とすので、**出力が空なら生の NUL が埋まっている**）。

---

### 14. UoW 契約とジョブ関連の application 型

- **対象ファイル:** `packages/core/src/application/execution/unitOfWork.ts`（差し替え）、`packages/core/src/application/execution/jobs.ts`（新規）
- **変更内容:** adr.md ADR-003 の2コンテキスト型と `UnitOfWorkProvider<TContext>`。`jobs.ts` に `EnqueueJobArgs` / `RecordOperationArgs` / `OperationPatch` / `OperationKind`（`"signup" | "link" | "unlink" | "credential-change" | "withdrawal"`）/ `OperationPhase` / `LocatorRef`（`{ credentialId; kind; hmac; generation; bucketIndex }`。**ブランド型を含めない**）を置く。
  - `recordOperation` / `updateOperation` / `setMigrationCursor` は **User Data DO 側のコンテキストにだけ**置く。
  - `operations.created_at` / `migration_progress.updated_at` は引数に取らない（アダプターが書く）。
  - **`IdentityDirectoryUnitOfWorkContext` に `credentialMappingStore: CredentialMappingStore` を置く**（adr.md ADR-012）。ドメイン側の読み取りポート `CredentialMappingRepository`（読み3本）はそのまま残し、**書き込みだけを別ポートに分ける**。
    - **コンテキスト型に載せる読み取りポートの「型」は DO 側の読み取り形である**（adr.md ADR-016）。`spec/domains/identity.md` の `findByEmail(email: Email)` / `findBySsoIdentity(provider, subject)` は**ドメインから見た契約**であって DO 内の実装署名ではなく、そのままコンテキスト型に使うと ADR-016 自身が「原理的に実装できない」と書いた形になる（`DIRECTORY_ROUTING_SECRET` は state Worker に配らないので、DO 内で `Email` から hmac を導けない）。**したがって `IdentityDirectoryUnitOfWorkContext` が持つのは `findByLocatorKey(kind: "email" | "sso", hmac: string)` / `findByCredentialId(credentialId)` / `checkPreviousGeneration(...)` の形であり**、その型を `packages/core/src/domain/identity/ports/credentialMappingRepository.ts` に**DO 側の読み取り形として**宣言する（ドメイン契約の3本は同ファイルの JSDoc に「request Worker 側から見た契約」として残す）。メソッドは `reserve` / `activate` / `cancel` / `beginChange` / `promote` / `delete` / `reportResult` の**7本ですべて `void` を返す CAS**（戻り値で分岐が要るものは `boolean`）。ポートの定義位置は `packages/core/src/domain/identity/ports/credentialMappingStore.ts`、実装はステップ15 の `identityDirectory/mappingOperations.ts`。**これで facade が `run()` の外で生の `sql` を掴む必要が無くなり、「予約行の書き込み + `enqueueJob` を同一 `transactionSync`」が UoW コンテキストだけで合成できる。**
- **理由:** 第8.2節。`collectEvents` が占めていた「トランザクション内の唯一の副作用登録点」というスロットを `enqueueJob` が引き継ぐ。`credentialMappingStore` を足しても `spec/database/index.md`「非集約ストアへの書き込み口は6ストア・7メソッド」の全数は崩れない — 同ファイルの分類表が `credential_mappings` を「非集約ストア7つ」ではなく**「CAS で直列化」という独立した区分**（:749-:750）に置いているためである。
- **検証:** 型定義のみ。**`async` コールバックを渡す型テストを `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts` に置き、`// @ts-expect-error` で拒否されることを固定する**（`pnpm typecheck` がステップ19 で通ればこの固定も効く）。

---

### 15. DO 内アダプター（identity）

- **対象ファイル:** `packages/core/src/adapters/cloudflare/userData/{unitOfWork,userSettingsRepository,accountStore,credentialLocatorStore,trashQuery}.ts`、`packages/core/src/adapters/cloudflare/identityDirectory/{unitOfWork,credentialMappingRepository,mappingOperations,resetTokenStore,rotationCheckpointStore}.ts`（すべて新規）
- **変更内容:**
  - `userData/unitOfWork.ts`: `createUserDataUnitOfWorkProvider(ctx: DurableObjectState, clock: Clock, idGenerator: IdGenerator): UnitOfWorkProvider<UserDataUnitOfWorkContext>`。`run` は `ctx.storage.transactionSync(() => fn(context))` を返すだけ。**`run` の中で `run` を呼べないように、コンテキストからプロバイダへ到達させない。**
  - `userSettingsRepository.ts`: `save` は `UPDATE user_settings SET ... WHERE version = ? RETURNING 1`（**単一行なので `id` 述語を持たない**）。`find()` は `user_settings` の単一行 + `credential_locators` の射影から `User` を組む。未初期化は `null`。不整合行は `SystemError(DataIntegrityError)`。
  - `accountStore.ts`: `advanceSessionEpoch` は `UPDATE account SET session_epoch = session_epoch + 1`（**OCC 条件を付けない**）。`advanceResetVersion` は `UPDATE ... SET reset_version = reset_version + 1 RETURNING reset_version` で**前進後の値を返す**（読み直さない）。
  - `credentialLocatorStore.ts`: `record` は `(credential_id, generation)` の upsert で `credential_version = max(既存, 引数)`、`usable_for_login` / `label` は上書き。**no-op にしない。** `advanceCredentialVersion` / `deleteByCredentialId` は `WHERE credential_id = ?` の単独文で**全世代に効く**（`generation` を条件に含めない）。
  - `trashQuery.ts`: `findEarliestPurgeAfter(sql): number | null`（`memos` / `topics` / `documents` の `WHERE status='trashed'` の `min(purge_after)` の最小）、`listItemsToPurge(sql, now, limit)`、`recalcPurgeAfterChunk(sql, retentionDays, limit): number`（**自己消尽する述語** `WHERE status='trashed' AND purge_after <> <新値>`。返すのは更新行数）。
  - `identityDirectory/mappingOperations.ts`: **ステップ14 で定義した `CredentialMappingStore` の実装**である（`createCredentialMappingStore(sql: Sql, now: number): CredentialMappingStore`）。メソッドは `reserve` / `activate` / `cancel` / `beginChange` / `promote` / `delete` / `reportResult` の7本と、読み取り側の `checkPreviousGeneration`（`credentialMappingRepository.ts` に置く）。**すべて `operationId` / `payloadDigest` / `status` / `change_state` を条件に含む CAS**。`credential_mappings` は `version` を持たないので `conditionalUpdate` は使わない。**facade はこのモジュールを直接 import せず、`identityDirectory/unitOfWork.ts` が組んだコンテキスト経由でだけ触る**（ARCH レビュー P-003 / ADR-012）。
    - `reserveCredential` は UNIQUE 違反を `ConflictError("EMAIL_ALREADY_REGISTERED")` / `ConflictError("SSO_IDENTITY_ALREADY_REGISTERED")` へ**アダプターで**翻訳する（第8.5節。usecase の `catch` を作らない）。
    - `cancelReservation` は `status` を問わず削除し、**`operationId` 一致に加えて `callerToken` の定数時間比較**を必須にする。
    - **不透明値による束縛の共通規則を1関数に集約する** — `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts` に `matchOpaque(rowValue: string | null, argument: string | null | undefined): boolean` を置き、(i) 行側が `NULL` なら常に不一致、(ii) 引数が欠落・空文字なら比較前に拒否、(iii) それ以外は定数時間比較（`timingSafeEqual`）とする。**射程は `caller_token` と `change_auth_token` の2列。**
  - `identityDirectory/unitOfWork.ts`: `createIdentityDirectoryUnitOfWorkProvider(ctx: DurableObjectState, clock: Clock, idGenerator: IdGenerator): UnitOfWorkProvider<IdentityDirectoryUnitOfWorkContext>`。`run` は `ctx.storage.transactionSync(() => fn(context))` を返すだけ。コンテキストに載せるのは `credentialMappingRepository`（読み3本。**署名は DO 側の読み取り形** `findByLocatorKey(kind, hmac)` / `findByCredentialId` / `checkPreviousGeneration` であり、`spec/domains/identity.md` の `findByEmail` / `findBySsoIdentity` は request Worker 側から見たドメイン契約である。ステップ14 / adr.md ADR-016）/ `credentialMappingStore`（書き7本）/ `resetTokenStore` / `rotationCheckpointStore` / `enqueueJob` の5つで、**それが Identity Directory DO のトランザクション内書き込み口の全数である**。`sql` をコンテキストに載せない。
  - `resetTokenStore.ts`: `issue` は `token_id` を**暗号論的乱数**（`crypto.getRandomValues`、128ビット以上。**module スコープでは呼ばない**）で採番し、`token_hash` を保存して生トークンを返す。**同じトランザクションでその `credential_id` の未使用行を全削除する。** `verifyAndConsume` は `token_hash` 一致 + `used_at IS NULL` + `expires_at > now` の条件付き UPDATE。0行なら `null`。消費時に `change_auth_token` を採番して行に保存し戻り値で返す。
  - `rotationCheckpointStore.ts`: 置換キー `(rotation_kind, bucket_index, generation)` の upsert。**#37 の実装からは1度も書かれない**（書き手は移送経路＝#44）が、口と列は実装する。
  - **前方互換点4つ（AC-27）を落とさない。** `operations.target_locators` を空にする実装を書かない。コーディネーター予約行を終端で消す実装を書かない。`account.caller_token` を消す経路を退会完走以外に作らない。`change_state` を3値で扱う。
- **理由:** `.adr/008` / 第6章 / 第8.4節 / 第8.5節 / 第5.1節 (3-a)〜(3-d)。
- **検証:** 型検査はステップ19 まで通らない。個々のアダプターの統合テストはステップ19 の後に書く（ステップ21 で消化）。このステップでは `spec/inventory/adapter.md` の ADP-account-001 / ADP-user-settings-001 / ADP-credential-locators-001 / ADP-credential-mappings-001 / ADP-password-reset-tokens-001 / ADP-identity-001〜025 の要点欄と実装を1件ずつ突き合わせるチェックリストを PR 本文に残す。

---

### 16. DO facade（RPC エントリ）と DO クラス本体

- **対象ファイル:** `packages/core/src/adapters/cloudflare/userData/facade.ts` / `identityDirectory/facade.ts`（新規）、`apps/web/app/durable-objects/userData.ts` / `identityDirectory.ts`（本体を実装）
- **変更内容:** 第5.1節の RPC エントリ表のうち、**#37 が実装するもの**を実装する。**すべて primitive 引数・値エンベロープ戻り**。すべてのエントリは (1) 先頭で `runMigrationGate` を通し（例外は診断2本）、(2) **成功・失敗のどちらの経路でも `armAfterRpc` を通す**（例外は診断2本）。
  - **(2) の実現形:** 各エントリを直接書かず、`packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`（新規）の共通ラッパ `runRpcEntry<T>(ctx, sql, cache, now, body: () => T): RpcEnvelope<T>` を通す。ラッパは `body()` を `try / catch` で囲み、**成功なら `ok(value)`、throw されたら `err(error)` を組んだうえで、どちらの場合も `armAfterRpc` を呼んでから返す**。`plan.md` の「`finally` に再武装を置かない」という注意は **CPU エビクション**（isolate ごと殺されるので `finally` が走らない）についてのものであって、**例外経路の話ではない** — エビクションは `finally` で救えないが例外は救える。**射程が違うので混同しない**旨を `rpcEntry.ts` の JSDoc に1行書く。この catch は `CLAUDE.md`「Cross-layer catch policy」の "the Durable Object's RPC entry points" にあたる既定の広い catch である。
  - 例外経路でも再武装が要る理由は、**トランザクションはコミットされたが後続で例外**というパターンが実在するためである（`runMigrationGate` の `enqueue`、`reserveCredential` の `sweep-reservations` 投入）。末尾実行だけだと投入したジョブが次の RPC まで起きない。
  - **User Data DO**
    | エントリ | クラス | ガード |
    |---|---|---|
    | `getCurrentUser(userId, epoch)` | (1) | epoch ガード + `account.status='active'` |
    | `changeTrashRetentionDays(userId, epoch, days)` | (1) | 同上。同一トランザクションで全項目の `purge_after` を再計算し `enqueueJob('purge-trash', …)` |
    | `initializeAccount(args)` | (2) | 第5.1節の (i)〜(iv) の4分岐。`callerToken` を引数で受けて `account` に書く |
    | `verifyLogin(args)` | (2) | `account.status='active'` + `credentialId` の到達性検査 + `credentialVersion` の**全行一致**。3つ通ったときだけ `sessionEpoch` を返す |
    | `recordCredentialLocator(args)` | (3) | `callerToken` の定数時間比較 + `operationId` / `payloadDigest` の CAS。**`credential_locators` の記録と `operations.phase='done'` を同一 `transactionSync`** |
    | `readSchemaVersion()` | (3-c) | 到達制御のみ。**ゲート・fail-closed・arming を通さない** |
  - **Identity Directory DO**
    | エントリ | クラス | ガード |
    |---|---|---|
    | `lookupCredential(args)` | (2) | 引数は **`(kind, hmac)`**（canonical 化と HMAC 導出は request Worker の責務。ADR-016）。**`kind` は `'email'` / `'sso'` の両方を受ける** — 一意性は `(kind, hmac)` で取るので、同じ bucket に別 `kind` の行が同居してよい（第6.1節 (b)）。無条件応答 + 中身の均一化（未登録 / `status != 'active'` / `change_state` が非 NULL / `next_attempt_allowed_at` 未到達をすべてダミー材料へ倒す）。**`kind='sso'` の行は `password_verifier` を持たないので均一化すべき計算量が無く、返るのは `userId` / `credentialId` / `credentialVersion` / `usedLocator` である**（第5.3節「SSO login」3 の但し書き）。**AC-2 の「SSO provider + subject → `userId` の解決」を満たすのはこのエントリである** |
    | `reportLoginResult(args)` | (2) | `usedLocator` が自 bucket に実在すること。無ければカウンタを更新せず成功を返す。**応答を返す前に完了させる** |
    | `reserveCredential(args)` | (2) | 一意制約 + `operationId` / `payloadDigest` の CAS。`credentialId` / `callerToken` / `reservedUntil` / （email かつパスワード signup なら）`passwordVerifier` を予約行に書く。**1回の `uow.run(ctx => { ctx.credentialMappingStore.reserve(...); ctx.enqueueJob({ kind: "sweep-reservations", … }); if (isCoordinator) ctx.enqueueJob({ kind: "resume-signup", … }); })` に収める** — 予約行の書き込みとジョブ投入が同一 `transactionSync` になるのはこの形による（ADR-012） |
    | `activateReservation(args)` | (3-a) | 予約行の `operationId` 一致 |
    | `cancelReservation(args)` | (3-a) | `operationId` 一致 + `callerToken` の定数時間比較。`status` を問わない |
    | `checkPreviousGeneration(args)` | (3-c) | 追加の束縛なし。返すのは真偽1ビット |
    | `requestPasswordReset(args)` | (2) | レート制限と応答均一化のみ。**mapping の有無・スロットルの有無にかかわらず必ずジョブ行を1行書く** |
    | `listBucketUserIds(cursor, limit)` | (3-c) | 到達制御 + 件数上限 + **返す `userId` をログに出さない**。**ゲート・fail-closed・arming を通さない** |
  - `alarm()` の順序を**(1) `rearmBeforeWork` + `sync()` → (2) `runMigrationGate` → (3) `runDueJobs` → (4) `settleAlarm`** で固定する。**(2) は `try / catch` で包む** — ゲートは fail-closed のとき `SystemError` を throw する（ステップ5 (ii)）ので、包まないと `alarm()` から例外が漏れて `CLAUDE.md`「Never throw out of `alarm()`」に反する。捕まえたら (3)(4) を飛ばして戻る（**`deleteAlarm()` しない**）。(1) の再武装は既に済んでいるので、これで `spec/database/index.md` の fail-closed が要求する「一定間隔で張り直して戻る」が満たされる。**この catch はジョブランナーの per-job catch とは別物である** — 許される広い catch の4つ目としてステップ29 で `CLAUDE.md` に追記する（ARCH レビュー S-002）。
  - **実装しないエントリ**（#12 / #44 / #45）: `readOwnCanonical`（(3-b)。設定画面のメール表示 → **#12**）/ `deleteMapping`（(3-b)。退会 手順3・unlink 手順3・`sweep-orphan-mapping` → **#12 / #45**）/ `lookupCredentialByLocator`（(2) → #12）/ `reportVerifyResult`（(2) → #12）/ `beginCredentialChange`（(2) → #12）/ `consumeResetToken`（(2) → #12）/ `exchangeAuthzCode`（(2) → #13）/ `advanceCredentialChange`（(3-d) → #12）/ `promoteVerifier`（(3-d)。**`'advanced'` だけを通すガードも #12** → #12）/ `propagateSagaCommitted`（(3) → #45）/ `abandonAccount`（(3-a) → #45）/ `purgeUserMappings`（(3) → #45）/ `rotateEncryption` の起動（(3) → #44）。
  - **JSDoc の全数表は第5.1節の表と同じ26行（クラス (1) 1行 + (2) 11行 + (3) 14行）で書く。** クラス (1) の1行は**個別エントリではなく「利用者データの usecase facade 全部」というカテゴリ行**であり、#37 はそのうち `getCurrentUser` / `changeTrashRetentionDays` の2本を実装する。したがって**名前付きエントリの数は (2) 11 + (3) 14 = 25 で、内訳は実装12本・未実装13本**である（実測。クラス (3) の内訳は `advance-credential-change` / `record-credential-locator` / `activate-reservation` / `promote-verifier` / `check-previous-generation` / `read-own-canonical` / `delete-mapping` / `cancel-reservation` / `abandon-account` / `propagate-saga-committed` / `purge-user-mappings` / `list-bucket-user-ids` / `read-schema-version` / `rotate-encryption` の起動 の14本で、守り群 (3-a) 5 + (3-b) 2 + (3-c) 5 + (3-d) 2 と一致する）。**未実装の行にも担当 Issue を書く。** `delete-mapping` の行には「退会 手順3 / unlink 手順3 / `sweep-orphan-mapping` の唯一の削除経路であり、**AC-27 (iii)（`account.caller_token` を退会完走時以外に消さない）の理由そのもの**である」を1行添える — 全数表から落ちると #12 / #45 が「なぜ `caller_token` を残すのか」を再発見する羽目になる。
- **理由:** 第5.1節・第9.2節（ゲートを通さない2本）・第7.4節 (4)（arming の射程）・**AC-16**（(i) ゲートが全 RPC エントリと `alarm()` の先頭にあり例外は診断2本のみ / (vi) fail-closed が `alarm()` にも掛かり `deleteAlarm()` しない、の**実装点はこのステップにしか無い**）・AC-2（`lookupCredential` の `kind='sso'` 対応）・AC-5 / AC-10 / AC-12 / AC-13 / AC-27。
- **検証:** 型検査はステップ19 まで通らない。次を確認する。
  - 診断2本（`readSchemaVersion` / `listBucketUserIds`）以外のすべてのエントリが `runRpcEntry` を通っており、`runRpcEntry` が `runMigrationGate` と `armAfterRpc` を呼んでいる（**目視。AC-16 (i)**）
  - `alarm()` が (1)〜(4) の順序で、(2) を `try / catch` で包み、捕まえたら (3)(4) を飛ばして `deleteAlarm()` せずに戻る（**目視。AC-16 (vi)**）
  - **`facade` が `run` の外で生の `sql` を掴んでいないことの機械検証**（AC-5 の最後の句。ADR-012 の目的そのもの。他の句が検証手段を持つのに、この句だけが目視に委ねられていた）:

    ```sh
    grep -n "storage\.sql\|ctx\.storage\|\bsql\b" \
      packages/core/src/adapters/cloudflare/userData/facade.ts \
      packages/core/src/adapters/cloudflare/identityDirectory/facade.ts
    ```

    ヒットが 0 件であること（`sql` はコンテキスト経由でだけ触る）。**唯一の例外は `runRpcEntry(ctx, sql, cache, now, body)` へ渡すために facade がラッパへ引き回す引数だが、それは DO クラス本体（`apps/web/app/durable-objects/*.ts`）が渡す形にして facade 側には現れさせない** — 現れさせると検証が成立しない。
  - **JSDoc の全数表の行数が、クラス (2) について11、クラス (3) について14であること**（`.thread/34/design.md` 第5.1節と機械的に一致させる）
  - 名前付きエントリについて、実装12本 + 未実装13本 = 25 = 11 + 14 が成立すること（クラス (1) はカテゴリ行なのでこの数え方に含めない）

---

### 17. request / state 側の合成ルートと秘密

- **対象ファイル:** `packages/core/src/application/ports/sessionCodec.ts`、`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`、`packages/core/src/application/di/secrets.ts`、`packages/core/src/application/di/types.ts`、`packages/core/src/application/di/serverCloudflare.ts`（作り直し）、`packages/core/src/application/di/stateCloudflare.ts`（新規）、`packages/core/src/adapters/cloudflare/directoryLocator.ts`（新規）、**`packages/core/src/application/di/__tests__/requestContainerConfig.test.ts`（改修）**、**`packages/core/src/application/di/__tests__/secrets.test.ts`（改修）**、`packages/core/src/application/di/__tests__/stateContainerConfig.test.ts`（新規）
- **変更内容:**
  - `sessionCodec.ts`: `issue(userId: string, epoch: number, now: Date): Promise<string>` / `verify(token: string, now: Date): Promise<{ userId: string; epoch: number } | null>`。
  - `hmacSessionCodec.ts`: ペイロードを `{ typ: "session", uid, ep, exp }` へ広げる。`parsePayload` は **`typ` の厳密一致と `ep` の存在を要求**し、欠落は `verify` が `null`（**fail closed**）。`createHmacTokenCodec({ secret, typ, ttlMs })` を一般形として切り出し、セッション用はその薄いラッパとする（`typ: "aiClient"` の codec の**実体化は #13**）。
  - `secrets.ts`:
    ```ts
    export type RequestSecrets = Readonly<{
      sessionSecret: SessionSecret;
      aiClientTokenSecret: AiClientTokenSecret;
      directoryRoutingKeyring: DirectoryRoutingKeyring;
    }>;
    export type StateSecrets = Readonly<{
      mailEncryptionKeyring: MailEncryptionKeyring;
      resetTokenKeyring: ResetTokenKeyring;
    }>;
    ```
    単一鍵の最小長は **`packages/core/src/lib/secretLengths.ts` の `MIN_SESSION_SECRET_LENGTH` を読む**（ステップ13 で `lib/` へ移した leaf。**リテラル `32` を再掲しない** — `secrets.test.ts` 冒頭コメントが守っている「フロアが上がったときに2つの検査が割れる」を維持するため）。keyring は `{ generation, key, bucketCount? }[]` を JSON で受け、**構築時に (i) `generation` の一意性、(ii) `active` がちょうど1件、(iii) `previous` が0〜1件、(iv) `DIRECTORY_ROUTING_SECRET` は各エントリの `bucketCount >= 1`** を検査する。**検査を通した値しか型を得られない形にする。** 容器（`StateSecrets`）は秘密として数えない。**フラットに置かない**（rest-spread が `AppConfig` へ運ばないため）。
  - `types.ts`: `RequestContainer` から `unitOfWorkProvider` を外し、`userDataStubFactory: (userId: string) => UserDataFacade` と `directoryStubFactory: (locator: DirectoryLocator) => IdentityDirectoryFacade` を足す（`WorkerContainer` と `collectEvents` の段落は**ステップ12 で削除済み**）。JSDoc の「リポジトリはコンテナに載せない。`UnitOfWorkContext` が唯一の発行点」を維持したうえで「DO facade はトランスポートであってリポジトリではない」を1文足す。
  - `serverCloudflare.ts`（request 側）: `ServerEnv = { USER_DATA: DurableObjectNamespace; IDENTITY_DIRECTORY: DurableObjectNamespace; ASSETS: Fetcher; APP_URL: string; SESSION_SECRET?: string; AI_CLIENT_TOKEN_SECRET?: string; DIRECTORY_ROUTING_SECRET?: string }`。`createRequestContainer` は stub factory・`passwordHasher`・`sessionCodec`・`directoryLocator` を組む。**`unitOfWorkProvider` を持たない。** **stub factory が返すのは生の stub ではなく、`platform/stubErrors.ts` の翻訳を掛けた facade ラッパである。**
  - `stateCloudflare.ts`（DO 側）: `StateEnv = { USER_DATA; IDENTITY_DIRECTORY; MAIL_SENDER?: Fetcher; APP_URL: string; IDENTITY_MAIL_ENCRYPTION_KEY?: string; IDENTITY_RESET_TOKEN_KEY?: string }` と `createUserDataContainer(ctx, env)` / `createIdentityDirectoryContainer(ctx, env)`。DO クラスの constructor から呼ぶ。**ALS を使わない**（1インスタンス = 1ユーザー / 1 bucket）。`MAIL_SENDER` 未設定なら `NoopMailSender` を選び `logger.warn` を出す。
  - `directoryLocator.ts`: `createDirectoryLocator(keyring): { forCanonical(canonical: string): DirectoryLocator[]; }` — active → previous の順に `{ generation, bucketIndex, hmac, doName }` を返す。`bucketIndex` は **HMAC-SHA-256 出力の先頭2バイトを big-endian で読み、その世代の `bucketCount` で剰余**。`doName` は `dir:g{generation}:b{bucketIndex}`。**mapping 行のキーには全長 64 hex を使う。**
  - **`containerStore.ts` は request 側専用のまま残す。** `getContainer()` を DO 側から呼ばない。
  - **秘密漏えいの恒久ガードを新しい秘密の本数へ拡張する。** `requestContainerConfig.test.ts`（65行）は冒頭コメントが宣言しているとおり「秘密が rest-spread で `container.config` に載って SSR ペイロードでブラウザへ出ることを防ぐ恒久ガード」であり、**`secrets.ts` を「フラットに置かない」と決めている根拠そのものである。** 現行は `createRequestContainer({ ...content, appUrl, binding: {} as never, secrets: { sessionSecret } })` を直接呼んでいるので、`RequestServerConfig` から `binding` を落として stub factory 中心へ作り変えると**必ず壊れる**。`APP_CONFIG_KEYS` の列挙を維持したまま、**新しい3秘密（`sessionSecret` / `aiClientTokenSecret` / `directoryRoutingKeyring`）が `container.config` へ1つも載らないこと**を固定し直す。
  - **`stateContainerConfig.test.ts` を同形で1本足す** — `createUserDataContainer` / `createIdentityDirectoryContainer` の戻り値に `StateSecrets`（`mailEncryptionKeyring` / `resetTokenKeyring`）が載らないこと。
  - `secrets.test.ts` は `requireSessionSecret` の検査を、3秘密 + keyring 検査（`generation` の一意性 / `active` ちょうど1件 / `previous` 0〜1件 / `bucketCount >= 1`）へ広げる。`MIN_SESSION_SECRET_LENGTH` の import 元を `@repo/core/lib/secretLengths` へ差し替える。
- **理由:** 第3.2節・第5.1節・第5.2.2節・第5.2.5節・第8.3節 (b)(c)(e)。
- **検証:** 型検査はステップ19 まで通らない。次を確認する。
  - `grep -rn "getContainer" packages/core/src/adapters/cloudflare apps/web/app/durable-objects` が 0 件
  - **`grep -rn "idFromName\|getByName" packages/core/src apps/web/app` の一致が `application/di/serverCloudflare.ts`（とそのテスト）だけであること**（AC-4。DO の選択点が合成ルート1箇所に閉じていることの機械検証）
  - **logger に禁止値を渡していないことの unit テスト**を `packages/core/src/adapters/cloudflare/__tests__/noSecretLogging.test.ts` に置く（AC-3）。フェイク `Logger` を注入して `directoryLocator` / `stubErrors` / stub factory ラッパを一巡させ、記録された全メッセージ・全メタデータを1本の文字列に落として、**禁止語の配列**（canonical のメールアドレス / `hmac` の全長値 / `doName` / `callerToken` / `changeAuthToken` / `passwordVerifier` / リセットトークン）のいずれも含まないことを assert する。**ステップ10 の `terminal_reason` の禁止語テストと同じ形にし、配列を共有の `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts` へ切り出す。**

---

### 18. usecase の再構成

- **対象ファイル:** `packages/core/src/application/identity/{registerWithPassword,loginWithPassword,getCurrentUser,logout,view}.ts`、`packages/core/src/application/identity/requestPasswordReset.ts`（新規）、`packages/core/src/application/identity/signupSaga.ts`（新規）
- **変更内容:**
  - `signupSaga.ts`: 第6.3節の phase 0〜4 を request Worker 側のオーケストレーションとして実装する。
    - phase 0: `idGenerator.next()` で `operationId` / 候補 `userId` / `callerToken` / credential ごとの `credentialId` を**それぞれ新規に採番**する（**クライアントから受け取らない**）。canonical を確定し、locator を `(kind, 全長 hmac)` の辞書順（`'email' < 'sso'`）で安定ソートしてコーディネーターを決める。パスワード signup は `PasswordHasher.hash` をここで回す
    - phase 1a: コーディネーター bucket で `checkPreviousGeneration` → `reserveCredential`
    - phase 1b: 残り bucket（パスワード signup では発生しない）
    - phase 2: `initializeAccount`
    - phase 3: `activateReservation`
    - phase 4: `recordCredentialLocator`（**locator の記録と `operations.phase='done'` を同一 `transactionSync`**。2本の RPC に分けない）
    - **再送では毎回新しい `operationId` と候補 `userId` を採番する**（跨リクエストの再送という概念を持ち込まない）
  - `registerWithPassword.ts`: `signupSaga` を呼ぶだけにする。**UNIQUE 違反の `catch` を削除**（翻訳点はアダプター）。`collectEvents` の呼び出しは**ステップ12 で削除済み**。
  - `loginWithPassword.ts`: 第5.3節の step 1〜7。ダミー検証材料での計算量均一化は維持する。`DUMMY_PASSWORD_HASH_ITERATIONS` の import 元を `packages/core/src/lib/passwordHashing.ts` へ変更。
  - `getCurrentUser.ts`: `container.userDataStubFactory(userId).getCurrentUser(userId, epoch)` を呼び、`CurrentUserView` を返す。`view.ts` の `CurrentUserView` から `authMethod` を落とし、`credentials: readonly { credentialId; kind; usableForLogin; label }[]` を足す。
  - `logout.ts`: そのまま（`UserId.create` のみ）。**epoch は進めない。**
  - `requestPasswordReset.ts`: Directory bucket の `requestPasswordReset` を呼ぶだけ。
  - `application/types.ts`: `UsecaseContainer = Omit<RequestContainer, "sessionCodec">` は維持。
- **理由:** 第5.3節・第6.3節・第8.5節。
- **検証:** 型検査はステップ19 まで通らない。

---

### 19. 旧スタックの削除と apps/web の切り替え（ブロックの締め）

- **対象ファイル:**
  - **削除（ディレクトリごと）:** `packages/core/src/adapters/d1/`
  - **削除（ファイル）:** `apps/web/drizzle.config.ts`、**`packages/core/src/application/identity/__tests__/identity.integration.test.ts`**（下記）（`application/workers/` / `application/events/` / `ports/{outboxRepository,relayTrigger,idempotencyStore}.ts` / `di/env.ts` / `serviceBindingRelayTrigger.ts` / `adapters/d1/repositories/{outboxRepository,idempotencyStore}.ts` / worker 5本とそのテストは**ステップ12 で削除済み**）
  - **新規（削除より前に作る。下記「作業順序」を参照）:** `packages/core/src/adapters/cloudflare/__tests__/setup.ts`
  - **作り直し:** `packages/core/src/application/__tests__/helpers.ts`（`D1UnitOfWorkProvider` を組み立てるハーネス → DO ハーネスへ。outbox / idempotency / `WorkerContainer` 分はステップ12 で除去済み）
  - **改修:** `vitest.config.integration.ts`（`setupFiles` の差し替えのみ）、`apps/web/app/server.cloudflare.ts`、`apps/web/app/presentation/{currentUser.ts,authState.ts}`、`apps/web/app/components/**/action.ts`（`startSession` に epoch を渡す経路）、`apps/web/app/presentation/session.ts`、**`apps/web/app/presentation/__tests__/{errorResponse.test.ts,errorResponseMiddleware.test.ts}`**（下記）、`packages/core/package.json`、`apps/web/package.json`、`pnpm-lock.yaml`
- **作業順序（この順を守らないとステップ20〜22 の検証が実行不能になる）:**
  1. **先に `packages/core/src/adapters/cloudflare/__tests__/setup.ts` を作り、`vitest.config.integration.ts` の `setupFiles` を `["packages/core/src/adapters/d1/__tests__/setup.ts"]` から `["packages/core/src/adapters/cloudflare/__tests__/setup.ts"]` へ差し替える。** 新 setup が持つのは DO 側のテスト間クリーンアップだけで、D1 のマイグレーション適用は持たない（`beforeAll` の `readD1Migrations` 適用はここで消える）。**中身は次の2行の `afterEach` だけである**（詳細と根拠はステップ23 / adr.md ADR-015）:
     ```ts
     import { evictAllDurableObjects, reset } from "cloudflare:test";
     afterEach(async () => {
       await reset();                     // 全バインディングのデータ削除（自動では走らない）
       await evictAllDurableObjects();    // インスタンスを破棄して AlarmCache を初期化する
     });
     ```
  2. そのうえで `packages/core/src/adapters/d1/` をディレクトリごと削除する。
  3. **`application/identity/__tests__/identity.integration.test.ts` を削除する**（作り直しは**ステップ21**）。実測でこのファイルは `import * as schema from "@repo/core/adapters/d1/schema"` と `import { sql } from "drizzle-orm"` を持ち、`UnitOfWorkContext` / `UnitOfWorkProvider` の**旧契約**を型で使っている。**残すと、このステップのブロックゲート3つ（`pnpm typecheck` / `pnpm test:integration` / `grep drizzle = 0`）がどれも通らない。** `application/__tests__/helpers.ts` の DO ハーネス化と同じ扱いに揃うので追加の判断は要らない。
  4. **presentation テストの D1 フィクスチャを差し替える。** 実測で `errorResponse.test.ts:23` と `errorResponseMiddleware.test.ts:38` が `"D1_ERROR: no such table: users (…/adapters/d1/userRepository.js:120)"` を持ち、`errorResponse.test.ts:113` が `not.toContain("D1_ERROR")` を assert している。**テストの意図（内部詳細を漏らさない）は #37 後も有効なので残す** — 文字列だけを DO 側の現実（`SQLITE_FULL` / stub の `.overloaded` / `Durable Object reset because its code was updated`）へ差し替え、`not.toContain` の対象語も同じく差し替える。ステップ19 / 26 の grep はどれもこの語を拾わない（`D1Database` にも `tanstack-start-template` にも一致しない）ので、**明示しないと確実に残り、次の読者が「まだ D1 が居る」と誤読する。**
  - **理由:** 実測で `vitest.config.integration.ts:82` の `setupFiles` は `packages/core/src/adapters/d1/__tests__/setup.ts` を指している。**`setupFiles` の解決に失敗すると vitest はスイート全体を起動できない**ので、先に消すとステップ20（`purge-trash`）/ 21（Directory 側ジョブと saga）/ 22（`reindex` / `migrate-bulk`）の「検証: `pnpm test:integration`」が3ステップ連続で実行不能になる。`plan.md` のリスク欄が「DO 用の setup へ差し替えるまで削除しない」と書いているのはこの順序のことである。`d1Databases` / `queueProducers` / `queueConsumers` / `readD1Migrations` / `bindings.MIGRATIONS` の除去と `include` の最終形整理は**ステップ23 のまま**でよい（残っていても DO テストの実行を妨げない）。
- **変更内容:**
  - `server.cloudflare.ts`: ALS の Symbol を `Symbol.for("@fog/request-als")` へ、`containerStore.ts` の Symbol も `Symbol.for("@fog/container-store")` へ改名する。`readRequestServerConfig(env, ctx)` の新シグネチャに合わせる。
  - `session.ts`: `startSession(userId, epoch)` へ変更（`sessionCodec.issue` が epoch を要求するため）。`loginWithPassword` / `signupSaga` の戻り値に `sessionEpoch` を足して presentation へ運ぶ。
  - `currentUser.ts`: JSDoc から「The authoritative guard」を外し、「トークン真正性の前段チェック。認可の権威は DO 側の epoch ガード」と書き換える。`getCurrentUserId()` の戻り値に `epoch` を足す（`{ userId, epoch } | null`）。
  - `authState.ts`: DO を叩かないままにし、「**DO を叩かない server function は保護データを返さない**」を規約としてコメントに置く。
  - `packages/core/package.json` から `drizzle-orm` を、`apps/web/package.json` から `drizzle-kit` / `drizzle-orm` を削除し、**`pnpm install` を実行して `pnpm-lock.yaml` を更新する。** 実測で lockfile には `drizzle-kit@0.31.10` / `drizzle-orm@0.45.2` / `@drizzle-team/brocli@0.10.2` が載っており、**CI は3ジョブとも `pnpm install --frozen-lockfile` なので lockfile を再生成しないと全ジョブ落ちる。** ステップ24 で `miniflare` を devDependency に足すときも同じ手当てが要る。
- **理由:** 対応項目7・第7.3節・第11.2節の変更対象一覧・#40 §1（Symbol 名を含む `tanstack-start-template` の一掃はステップ26 で仕上げる）。
- **検証（ブロック全体のゲート）:**
  - `pnpm install --frozen-lockfile` が成功する（lockfile が再生成済みであることの確認）
  - `pnpm typecheck` が通る
  - `pnpm lint:fix && pnpm format`
  - `pnpm test:unit` が通る（削除したテストの件数を実測して記録）
  - **`pnpm test:integration` が通る** — この時点で存在する DO 統合テスト（ステップ8 / 9 / 10 で書いたもの）が全部緑になること。`setupFiles` の差し替えが済んでいることの確認でもある
  - `grep -rn "outbox\|Outbox\|relayTrigger\|RelayTrigger\|collectEvents\|EventDispatcher\|_occ_guard\|PendingBatch\|D1Database\|drizzle" packages/core/src apps/web/app` が 0 件（**ステップ12 で必要だった `--exclude-dir=migrations` はここでは不要** — `adapters/d1/` ごと消えている）
  - `grep -rn "D1_ERROR" apps/web/app` が 0 件（作業順序4 の確認）
  - `grep -rn "OUTBOX_" . --include='*.ts' --include='*.toml' --include='*.tpl'` が 0 件（**ステップ12 の (v) で全数落としているので、ここは回帰していないことの確認である。** `.tpl` 2本の env ブロックがステップ12 で消えていないと、`adapters/d1/` を消したこのステップでもまだ 0 件にならない）

---

### 20. `purge-trash` ジョブ

- **対象ファイル:** `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`（新規）、`packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts`（新規）
- **変更内容:** 第7.5節を逐語で実装する。
  - `operationKey` は **DO ごとの定数**（`"purge-trash"`）
  - **フェーズは2つで、順序が固定である** — (1) `purge_after` の再計算（`recalcPurgeAfterChunk` を `CHUNK_BUDGETS["purge-trash"]` の範囲で回す。**述語は自己消尽する形**）、(2) 削除（`listItemsToPurge` → 展開 → ハードデリート）。**再計算の残件が空になった起床でだけ削除フェーズへ進む**
  - 展開規則: トピックはセットの配下ドキュメントも対象（`WHERE topic_id = ? AND trashed_with = topic_id`）。メモのハードデリートは (i) `source_links` から影響ドキュメント ID を確定 → (ii) メモ削除 → (iii) `deleteSourceLinksByMemo` → (iv) 影響先ドキュメントの projection 更新、の順で**同一 `transactionSync`**
  - 削除・復元・ハードデリートはいずれも `removeSearchEntry` / `upsertSearchEntry` を同じトランザクションで発行する
  - 完了時の再武装は **(1-A)** — 駆動源は `WHERE status='trashed'` の `min(purge_after)`（3テーブルの最小）。集合が空のときだけ `done`。**「早める方向にのみ」を再武装には適用しない**
  - 安全弁: 再計算した `nextRunAt` が現在時刻以前で、かつその起床の作業対象が0件なら `MIN_RESUME_INTERVAL_MS` でクランプし、クランプの発火をログに出す
  - チャンク反復上限に達したら `yield` を返し、`releaseJob` で `status='pending'` へ戻して `lease_until` / `owner_token` を解放する
- **理由:** 対応項目5・第7.5節・`.adr/009`・AC-10。
- **検証:** `pnpm test:integration`。テストに次を含める — 期限到達分だけが消える / 未到達分は残り再武装で次の期限が張られる / 復元で `purge_after` が `NULL` に戻り駆動源から外れる / 保持日数の短縮が既存項目に遡及して前倒しされる / 保持日数の**延長**では `enqueueJob` が何も書かず、既存の早い時刻で1回空振りしてから再武装が正しい時刻を書く / 再計算の残件があるあいだ削除フェーズが走らない（**延長方向で誤削除が起きない**）/ トピックのセット削除で配下ドキュメントも消える / メモ削除で影響先ドキュメントの projection が作り直される。

---

### 21. Directory 側のジョブと signup / login / reset の統合テスト

- **対象ファイル:** `packages/core/src/adapters/cloudflare/jobs/handlers/{sendMail,sweepResetTokens,sweepReservations,resumeSignup}.ts`（新規）、`packages/core/src/adapters/cloudflare/identityDirectory/__tests__/*.integration.test.ts`、`packages/core/src/adapters/cloudflare/userData/__tests__/*.integration.test.ts`、`packages/core/src/application/identity/__tests__/identity.integration.test.ts`（作り直し）
- **変更内容:**
  - `sendMail.ts`: `payload` に載せるのは `tokenId` だけ（**生トークンを載せない**。送信直前に `HMAC(IDENTITY_RESET_TOKEN_KEY[generation], tokenId)` から導出する）。`providerIdempotencyKey` は `operation_key` から決定的に導く。宛先を持たない行は**何も送らずに `done`**。分類 (C) なので完走したら `done` で終わり。
  - `sweepResetTokens.ts`: 分類 (A)。作業述語 `WHERE expires_at < ?`、駆動源 `password_reset_tokens` 全行の `min(expires_at)`。
  - `sweepReservations.ts`: 分類 (A)。作業述語 `WHERE status='reserved' AND reserved_until < ? AND saga_committed IS NULL`、駆動源は時刻条件を外したもの。**`saga_committed` 印のある行は作業述語からも駆動源からも外す。**
  - `resumeSignup.ts`: 分類 (C)。コーディネーター予約行から phase を読んで 1b → 2 → 3 → 4 を前進させる。前進不能が確定したら **一様な終端**（`poison` + `terminal_reason`）。**自動回収（巻き戻し）は実装しない**（#45）。**`operations.target_locators` / コーディネーター予約行 / `account.caller_token` を終端で消さない。**
  - 統合テスト:
    - **`send-mail` の E2E（H-4）**: `requestPasswordReset` → ジョブ行が書かれる → Alarm 実行 → `MailSender` フェイクが1回呼ばれる → `done`。**登録済み / 未登録 / SSO 専用（`password_verifier` を持たない `kind='email'` 行）/ スロットル中の4ケースで、書き込み行数・`setAlarm` の有無・応答が完全に一致する**こと。同じ窓での連打がジョブ行1本に収束し、`setAlarm` の回数が増えないこと
    - **signup saga**: phase 2 の再送が `payloadDigest` 一致で no-op になる / 不一致で `ConflictError` / phase 1 で敗北したら phase 2 に進まない / phase 4 の2作用が原子的（片方だけ書かれた状態が観測できない）/ `resume-signup` が phase の途中から再開できる / 予約行が TTL で掃除される
    - **login**: 到達性検査（`credential_locators` に対応行が無いと拒否）/ `credentialVersion` の不一致で拒否 / 未登録・変更中・`status != 'active'` の予約行がすべてダミー材料へ倒れる / `report-login-result` が成功・失敗のどちらでも1回発行される
    - **SSO クレデンシャルからの `userId` 解決（AC-2 / 受け入れ条件3 の後半）**: `kind='sso'` の mapping 行を直接投入したうえで、(i) `ssoCanonical(provider, subject)` → `directoryLocator.forCanonical` → `lookupCredential(kind, hmac)` の経路で `userId` に解決すること、(ii) **同じ subject でも provider が違えば canonical が異なり、別の hmac・別の bucket・別の行になる**（片方を投入しても他方は未登録として返る）、(iii) provider の大文字小文字が畳まれて同じ行に解決する、(iv) `kind='email'` と `kind='sso'` の行が**同じ bucket に同居しても混線しない**（一意性は `(kind, hmac)` で取る）、の4件。**行の投入は `credential_mappings` への直接 INSERT でよい** — SSO signup / link の saga は #12 のスコープであり、#37 が実装するのは解決の読み経路だけである（`plan.md` のスコープ節）
    - **epoch ガード**: `advanceSessionEpoch` の後に旧 epoch のトークンで RPC を叩くと拒否される / `ep` を持たないトークンが `verify` で `null` になる
- **理由:** 対応項目5・対応項目2 前段・H-4・第6.3節・第5.3節（SSO login の 2〜3）・第7.6節・AC-2 / AC-11 / AC-27。
- **検証:** `pnpm test:integration` / `pnpm typecheck`。

---

### 22. `reindex` / `migrate-bulk` ジョブ

- **対象ファイル:** `packages/core/src/adapters/cloudflare/jobs/handlers/{reindex,migrateBulk}.ts`（新規）、`packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts`（新規）
- **変更内容:**
  - `reindex.ts`: **`INSERT INTO search_fts(search_fts) VALUES('rebuild')` を使わない。** projection の全行再実行（1行ずつ「旧値 delete → 新値 insert」）として実装し、進捗は `migration_progress` の `(target_version, step)` カーソルに載せる（`setMigrationCursor`）。
  - `migrateBulk.ts`: 同じく `migration_progress` にカーソルを持つ。データ書き換えを伴う段の受け皿。**#37 の v1 では投入する段が無いので、テストは合成した v2 ステップで検証する。**
  - 統合テスト: v1 → v2 の擬似ステップ（列を1つ足して backfill する形）を用意し、(i) DDL 部分が単発で適用され `schema_version` が進む、(ii) `migrate-bulk` が投入されて Alarm で走る、(iii) チャンク反復上限で中断しても次の起床で再開する、(iv) `migration_progress` に進捗が残る、(v) 途中状態でもリクエストが受け付けられる（両対応の読み取り）、を検証する。**この擬似ステップはテストにだけ置き、プロダクションの `USER_DATA_STEPS` には入れない。**
- **理由:** 対応項目6・第9.2節 条件2・第9.3節・AC-16。
- **検証:** `pnpm test:integration`。

---

### 23. 統合テスト設定から D1 を除去する

- **対象ファイル:** `vitest.config.integration.ts`、`packages/core/src/adapters/cloudflare/__tests__/setup.ts`（**ステップ19 で新設済み**。ここでは中身を最終形にする）
- **変更内容:** `readD1Migrations` / `d1Databases` / `queueProducers` / `queueConsumers` / `bindings.MIGRATIONS` と `path` / `migrationsPath` の import を削除し、トップレベルの `main` と `miniflare.durableObjects`（`useSQLite: true` 付き）だけにする（形はステップ7 のとおり。**`main` は `miniflare` の中ではない**）。**`setupFiles` の差し替えはステップ19 で完了しているのでここでは触らない。** `include` を最終形へ整理する:
  ```
  packages/core/src/adapters/cloudflare/**/*.integration.test.ts
  packages/core/src/application/**/*.integration.test.ts
  apps/web/app/durable-objects/**/*.integration.test.ts
  ```
  冒頭コメントの「`env.DB`（インメモリ D1）を使う」という説明を DO 前提へ書き換え、`.adr/001` の「`include` は明示的な許可リスト」という運用ルールの記述は維持する。`singleWorker` に言及していた旧 setup のコメント（実在しない設定への言及）は引き継がない。
- **テスト間クリーンアップを `cloudflare:test` の実在 API で書く（`setup.ts` の最終形。adr.md ADR-015）。**
  - **`isolatedStorage` というオプションは現行版に存在しない。** 実測で、解決版は `@cloudflare/vitest-pool-workers@0.16.20`（root / `apps/web` とも specifier は `^0.16.4`）であり、パッケージ全体を grep して `isolatedStorage` は **0 件**（sourcemap 込み）。`dist/pool/index.d.mts:9-73` の `WorkersPoolOptionsSchema` のトップレベルは `main` / `remoteBindings` / `additionalExports` / `miniflare` / `wrangler` の**5つだけ**で、ストレージのスタック機構も残っていない。**したがって「既定に乗る（明示クリアを置かない）」は成立せず、明示クリアが必須である。**
  - **`setup.ts` は `afterEach` で次の2本を呼ぶ**（`cloudflare:test` の `types/cloudflare-test.d.ts` に実在。実測）:
    - **`reset(): Promise<void>`** — 「Deletes all data from all attached bindings.」。**自動では呼ばれない**ので、置かないと DO の SQLite 状態がテスト間で持ち越され、ステップ8〜10 / 20〜22 のテストが順序依存で不安定になる。
    - **`evictAllDurableObjects(options?): Promise<void>`** — 「durable storage は保ったままインスタンスを破棄して**インメモリ状態をリセット**する」。**`AlarmCache` の初期化はこれで行う。** `listDurableObjectIds` + `runInDurableObject` で `resetAlarmCache()` を呼ぶ形は不要になり、**プロダクションの DO クラスにテスト専用の public メソッドを生やさずに済む。**
  - **順序は `reset()` → `evictAllDurableObjects()`** とする（データを消してからインスタンスを畳む）。**なぜ2本とも要るのかを setup 冒頭のコメントに書く** — 片方はストレージ、もう片方はインメモリ状態で、**射程が違う**（`.adr/001` の「理由を説明できない設定を残さない」と同じ論法）。
  - 参考: `abortAllDurableObjects()` は同じことを非 graceful に行う版であり、in-flight を待たないので**採らない**。
- **理由:** 対応項目7・対応項目9・adr.md ADR-015・AC-17 / AC-21。
- **検証:** `pnpm test:integration` が通り、`grep -n "D1\|d1\|queue" vitest.config.integration.ts` が 0 件。

---

### 24. 起動スモークテスト（別レイヤー）

- **対象ファイル:** `vitest.config.smoke.ts`（新規）、`apps/web/__tests__/boot.smoke.test.ts`（新規）、`apps/web/package.json` / ルート `package.json`（`test:smoke` スクリプト）、`.github/workflows/ci.yml`
- **前提:** `dist/state/index.js` を作るビルド設定（`apps/web/vite.config.state.ts` と `build:cf` の2段化）は**ステップ6 で完了している**（adr.md ADR-017）。このステップは成果物を消費するだけで、ビルド設定には触らない。**`miniflare` を devDependency に足すのはこのステップ**で、pool-workers が引くのとは別インスタンスになる（実測で `node_modules/miniflare` はトップレベルに存在せず、`@cloudflare/vitest-pool-workers@0.16.20` は `miniflare@4.20260625.0` を、`wrangler@4.114.0` は `4.20260722.0` を引いている）。**バージョンは `wrangler` 側に揃える**（スモークが起動するのはビルド成果物であり、デプロイと同じ workerd 世代で見るほうが目的に合う）。
- **変更内容:** adr.md ADR-005 のとおり。`miniflare` を devDependency に追加する（**`pnpm install` で `pnpm-lock.yaml` を更新する**。CI は `--frozen-lockfile`）。`vitest.config.smoke.ts` の `include` は `apps/web/__tests__/**/*.smoke.test.ts`、`vitest.config.ts`（unit）の `exclude` に `**/*.smoke.test.ts` を足す。冒頭コメントに **`.adr/001` の「Workers プール1本」は統合テストについての決定であり、本スイートは別レイヤーである**旨を書く。
  - **Miniflare のオプションを具体化する。** 断片ではなく次の3点を満たす形で書かないと「起動しないのに緑」または「起動するのに赤」になる。
    1. **`compatibilityDate` / `compatibilityFlags` を明示する。** `server.cloudflare.ts` は `node:async_hooks` を import しているので、`nodejs_compat` が無いとモジュール解決で落ち、**global scope 制約とは無関係の理由で赤くなる。** 値は `vitest.config.integration.ts` と揃える（実測で `compatibilityDate: "2026-05-01"` / `compatibilityFlags: ["nodejs_compat"]`）。
    2. **2 worker 構成にする。** request Worker の DO バインディングは state Worker のクラスを指すので、
       ```ts
       new Miniflare({
         compatibilityDate: "2026-05-01",
         compatibilityFlags: ["nodejs_compat"],
         scriptPath: "apps/web/dist/server/index.js",
         modules: true,
         workers: [{ name: "state", modules: true, scriptPath: "apps/web/dist/state/index.js",
                     compatibilityDate: "2026-05-01", compatibilityFlags: ["nodejs_compat"] }],
         durableObjects: {
           USER_DATA: { className: "UserDataDurableObject", scriptName: "state", useSQLite: true },
           IDENTITY_DIRECTORY: { className: "IdentityDirectoryDurableObject", scriptName: "state", useSQLite: true },
         },
         bindings: { APP_URL: "http://localhost:8787", SESSION_SECRET: "…32文字以上…" },
       })
       ```
    3. **アサーションを緩く定義する。** 主張は「**`dispatchFetch("http://localhost/")` が応答を返すこと（ステータスは問わない）**」と「**Miniflare の起動が `Disallowed operation called within global scope` を投げないこと**」の2つである。`ASSETS` バインディングが無い状態で TanStack Start の SSR ルートを叩けば 500 になりうるが、それでも「モジュール評価は成功した」ので目的は達成している。ステータスを 200 に固定すると誤検出する。
- **理由:** #40 §4・AC-22 / AC-23。型検査・lint・Workers プール統合テストのいずれでも #40 を検知できなかった。
- **検証:** `pnpm build:cf && pnpm test:smoke` が通る。**意図的に module スコープへ `crypto.randomUUID()` を1行足すと落ちることを1度確認してから戻す**（上の緩いアサーション定義でこそ意味を持つ手順である — 「起動が例外を投げないこと」だけを見ているので、注入が確実に赤を出す）。

---

### 25. wrangler 設定と render-wrangler の2次元化

- **対象ファイル:** `apps/web/wrangler.toml`（作り直し）、`apps/web/wrangler.state.toml`（新規）、`apps/web/wrangler.request.{staging,production}.toml.tpl` / `apps/web/wrangler.state.{staging,production}.toml.tpl`（新規）、`apps/web/wrangler.{staging,production}.toml.tpl`（削除）、`apps/web/scripts/render-wrangler.ts`、`apps/web/worker-configuration.d.ts`（**再生成**）
- **state Worker のビルド設定（`apps/web/vite.config.state.ts` と `build:cf` の2段化）はステップ6 で完了している**（adr.md ADR-017）。本ステップが扱うのは wrangler 設定側だけであり、`vite.config.*` には触らない。
- **最初の作業（着手時に必ずこの順で行う）:**
  1. **`exports` が pinned wrangler で通ることを最小構成で確かめる。** `apps/web/wrangler.state.toml` に `name` / `main` / `compatibility_*` / **`[exports.*]` の2ブロック + `script_name` 無しの `[[durable_objects.bindings]]` 2本（self-binding）**だけを書いた最小ファイルを作り、`cd apps/web && npx wrangler deploy -c wrangler.state.toml --dry-run --outdir=/tmp/state-dry` を通す。実測で `wrangler` は `^4.90.1`（解決版 4.114.0）、`.thread/34/design.md` F-21 の出典（changelog "Declare Durable Object class lifecycle with `exports`"）は公開日 2026-07-04 なので時期は合っているが、**ADR-006 / ADR-011 / AC-19 / AC-26 と本ステップ・ステップ27 が全部この1点に乗っている。**
     - **self-binding を最小構成に含める理由:** 本ステップが書く `wrangler.state.toml` は、同一 Worker で `exports` によるクラス宣言と `script_name` 無しの自己バインディング2本を**同時に**持つ形になる（第3.2節の DO 間 RPC 用）。`[[migrations]]` との排他は F-21 で確認済みだが、**`exports` × self-binding の組み合わせまでは未確認である。** 巻き戻しの判断は「最初の1回で確定する」と決めた以上（`plan.md` 未解決事項）、最小構成にこれが入っていないと、後から失敗したときに巻き戻せない。
  2. **通らなかった場合の巻き戻し手順**（判断は最初の1回で確定する。**`exports` をデプロイした後に `[[migrations]]` へ戻せない**が、逆方向にはその制約が効かないので「先に `[[migrations]]` を試して後から `exports` へ移る」ことはできない）:
     - (i) `[[migrations]]` + `new_sqlite_classes`（= Issue 本文どおり）へ倒す
     - (ii) `plan.md` 冒頭の訂正表2行目と adr.md ADR-006 / ADR-011 を同時に書き換える
     - (iii) AC-19 の「`exports` による SQLite class 宣言がある」を「`[[migrations]]` の `new_sqlite_classes` に2クラスが宣言されている」へ差し替える
  3. **`main` の値を経路ごとに決める（下記）。**
- **`main` はローカル `wrangler.toml` だけソースエントリのままにする（実測で確定済み）。**
  - `apps/web/vite.config.cloudflare.ts` の `cloudflare()` プラグインは `apps/web/wrangler.toml` を自動発見し、**その `main` を vite のエントリモジュールとして解決する。** 実測で `@cloudflare/vite-plugin@1.47.0` の `maybeResolveMain` は、`main` が `.js` / `.ts` などで終わる場合に絶対パスへ解決し、**ファイルが存在しなければ `The provided Wrangler config main field (…) doesn't point to an existing file` を throw する。**
    - 検証1（成果物なし）: `main = "dist/server/index.js"` にして `dist/server/index.js` を退避 → `npx vite build --config vite.config.cloudflare.ts` が上記メッセージで即座に失敗した。**クリーンな clone には `dist/` が無いので、この形は `pnpm dev` / `pnpm build:cf` をブートストラップ不能にする。**
    - 検証2（古い成果物あり）: 同じ設定で成果物を戻して再実行 → プラグインが**前回のビルド出力をエントリとして扱い**（`\0virtual:cloudflare/worker-entry ← dist/server/index.js`）、`UNRESOLVED_IMPORT: Could not resolve '../rsc/index.js'` でビルドが失敗した。
  - **したがって `apps/web/wrangler.toml`（vite プラグインが読む唯一のファイル）は `main = "app/server.cloudflare.ts"` のまま据え置く。** Issue #37 の2番目のコメントが要求しているのは「**redirect が効かない経路**（`wrangler deploy --dry-run` / `.tpl` からレンダリングした設定の直接利用）で設定単体が成立すること」であって、vite プラグインが読むローカル設定まで成果物へ向けろとは言っていない。
  - **成果物を指すのは次の3つだけ** — `apps/web/wrangler.state.toml`（vite プラグインの管轄外。`wrangler dev -c wrangler.state.toml` で別に上げる）と、`.tpl` からレンダリングする `wrangler.request.<stage>.toml` / `wrangler.state.<stage>.toml`。
  - **AC-19 の `main` に関する条件は「role」ではなく「経路」で分ける**（plan.md 側も同じ文言に揃える）。
- **変更内容:** adr.md ADR-006 のとおり。
  - **request 側（ローカル `wrangler.toml`）:**
    ```toml
    name = "fog"
    # vite プラグインが読むのでソースエントリのまま。理由は上の「main の値を経路ごとに決める」を参照
    main = "app/server.cloudflare.ts"
    compatibility_date = "2026-05-01"
    compatibility_flags = ["nodejs_compat"]

    [assets]
    directory = "./dist/client"
    binding = "ASSETS"

    [vars]
    APP_URL = "http://localhost:8787"

    [[durable_objects.bindings]]
    name = "USER_DATA"
    class_name = "UserDataDurableObject"
    script_name = "fog-state"

    [[durable_objects.bindings]]
    name = "IDENTITY_DIRECTORY"
    class_name = "IdentityDirectoryDurableObject"
    script_name = "fog-state"
    ```
  - **state 側（ローカル `wrangler.state.toml`）:**
    ```toml
    name = "fog-state"
    main = "dist/state/index.js"
    compatibility_date = "2026-05-01"
    compatibility_flags = ["nodejs_compat"]

    [vars]
    APP_URL = "http://localhost:8787"

    [exports.UserDataDurableObject]
    type = "durable-object"
    storage = "sqlite"

    [exports.IdentityDirectoryDurableObject]
    type = "durable-object"
    storage = "sqlite"

    # state Worker からの DO 間 RPC 用。両方の binding を自分にも配線する（第3.2節）
    [[durable_objects.bindings]]
    name = "USER_DATA"
    class_name = "UserDataDurableObject"

    [[durable_objects.bindings]]
    name = "IDENTITY_DIRECTORY"
    class_name = "IdentityDirectoryDurableObject"
    ```
    実際の `exports` の TOML 表記は wrangler のバージョンに依存するので、**上の「最初の作業」1. で通る形を確認し、通った形をコメントに残す**こと。`[[migrations]]` / `new_sqlite_classes` は**書かない**。
  - `.tpl` 4本は `main` を**ビルド成果物**（`dist/server/index.js` / `dist/state/index.js`）に向ける。プレースホルダは `${RESOURCE_PREFIX}` / `${APP_URL}` だけを持つ（D1 / Queue のプレースホルダは消える）。**`[env.*]` の named environment を使わない。**
  - **`worker-configuration.d.ts` を再生成する。** tracked な生成物で、`postinstall` / `predev:cf` の `wrangler types` が作る。現行ファイルは実測で `DB: D1Database` / `EVENTS_QUEUE?: Queue` と `[env.*]` 由来の4ブロックを含んでおり、再生成しないと **`DurableObjectNamespace` 型が入らないまま `pnpm typecheck`（AC-29）に当たる**。加えて AC-17 / AC-19 の grep も ステップ19 の grep（射程は `packages/core/src apps/web/app`）もこのファイルを見ないので、古い D1 型が tracked ファイルに残っても誰も気づかない。
    - **state Worker 側の env 型は生成しない。** `StateEnv` はステップ17 で `application/di/stateCloudflare.ts` に手書きし、そちらが正本である（`wrangler types -c wrangler.state.toml` を足すと同じ型が2箇所に現れる）。この判断を `stateCloudflare.ts` の JSDoc に1行残す。
    - 検証に `grep -n "D1Database\|Queue<\|EVENTS_QUEUE" apps/web/worker-configuration.d.ts` が 0 件、`grep -n "DurableObjectNamespace" apps/web/worker-configuration.d.ts` が `USER_DATA` / `IDENTITY_DIRECTORY` の2件を含むこと、を足す。
  - `render-wrangler.ts`: 引数を `<stage>` から `<stage>` のみに保ったまま、**`role ∈ {request, state}` の2ファイルを出力する**ループへ拡張する。`templatePath = wrangler.${role}.${stage}.toml.tpl`、`outPath = wrangler.${role}.${stage}.toml`。substitution map から `D1_DATABASE_ID` / `D1_DATABASE_NAME` / `EVENTS_QUEUE_NAME` / `DLQ_QUEUE_NAME` を削除する（未知のプレースホルダは throw するので、`.tpl` 側と同時に直すこと）。
- **理由:** 対応項目8・第9.1節・第3.2節・#40 §5・AC-19 / AC-26。
- **検証:**
  - `cd apps/web && npx wrangler deploy -c wrangler.state.toml --dry-run --outdir=/tmp/state-dry` が成功し、**バンドルの入口が state Worker のエントリであること**をログで確認する（#40 §5 の踏み方をしていないことの確認 = AC-26）。`pnpm cf:render:staging` の後に `wrangler.request.staging.toml` / `wrangler.state.staging.toml` の2本でも同じ `--dry-run` を通す
  - `pnpm build:cf` の後に `dist/server/index.js` と `dist/state/index.js` が存在する（**2段化はステップ6 で済んでいるので、ここでは回帰していないことの確認である**）
  - `pnpm dev` でアプリが起動し、ログイン・サインアップが通る（**ローカル `wrangler.toml` の `main` がソースエントリであることの確認でもある**）
  - `rm -rf apps/web/dist && pnpm build:cf` が成功する（**クリーンな clone からブートストラップできることの確認**。`main` を成果物に向けるとここで落ちる）
  - `grep -n "d1_databases\|queues\|new_sqlite_classes\|\[env\." apps/web/wrangler*.toml apps/web/*.tpl` が 0 件
  - `grep -n "D1Database\|Queue<\|EVENTS_QUEUE" apps/web/worker-configuration.d.ts` が 0 件

---

### 26. スクリプトと名前の整理

- **対象ファイル:** ルート `package.json`、`apps/web/package.json`、`apps/web/app/server.cloudflare.ts` / `packages/core/src/application/di/containerStore.ts`（Symbol 名）、`apps/web/.dev.vars.example`、**`README.md`**
- **変更内容:**
  - **削除:** `db:migrate` / `db:migrate:cf` / `db:generate` / `db:generate:cf` / `db:apply:{local,staging,production}` / `db:execute:{local,staging,production}` の **10本（ルート・`@repo/web` の両方。合計20本）** と `deploy:*` の **24本（ルート・`@repo/web` の両方。合計48本）**。数え方は実測（`Object.keys(scripts)` を数えた結果、ルート 24本 / `apps/web` 24本）。**`deploy:*:{relay,consumer,pruner,dlq}{,:dry}` の16本はステップ12 で削除済み**なので、ここで消えるのは残りの `deploy:{staging,production}{,:dry}` / `:all{,:dry}` の8本（両側で16本）である。
  - **追加: 新 `deploy:*` は片側12本（ルート・`@repo/web` の両方で合計24本）。** 内訳を数として固定する（AC-18 と同じ数え方）:
    - **役割別8本** — `deploy:request:{staging,production}` / `deploy:state:{staging,production}` とその `:dry` 変種。
    - **合成4本** — `deploy:{staging,production}` とその `:dry`。**デプロイ順序は state が先、request が後**なので、中身は `pnpm deploy:state:X && pnpm deploy:request:X`（`:dry` も同順）。これが旧 `deploy:{stage}:all` の受け皿であり、下の対応表3行目の右辺そのものである。
    - あわせて `test:smoke`、`dev:state`（`wrangler dev -c wrangler.state.toml`）。**`build:cf` の2段化はステップ6 で、`test:smoke` はステップ24 で済んでいるのでここでは触らない**（このステップで足すのは `deploy:*` 12本と `dev:state` である）。
    - **旧24本 → 新12本**であり、**AC-18 が数えるのもこの12本**である。対応表の右辺に現れるスクリプトが12本すべて実在することを確認する。
  - **旧 `deploy:*` ↔ 新スクリプトの対応表を `apps/web/package.json` の直上コメント（README の該当節）に残す:**

    | 旧 | 新 |
    |---|---|
    | `deploy:{stage}` / `:dry` | `deploy:request:{stage}` / `:dry` |
    | `deploy:{stage}:relay` / `:consumer` / `:pruner` / `:dlq`（+ `:dry`） | **対象消滅**（worker ごと削除） |
    | `deploy:{stage}:all` / `:all:dry` | `deploy:{stage}` / `:dry`（= state → request の順） |
    | — | `deploy:state:{stage}` / `:dry`（新規） |
  - `test:integration` / `test:integration:cf` の冗長（`.adr/001` の影響欄が「スクリプト名の整理は #37 に委ねる」と書いている）を解消し、`test:integration` 1本にする。
  - ルート `package.json` の `"name"` を `fog` に、`apps/web/package.json` の worker 名参照を `fog` / `fog-state` に。ALS / container store の Symbol を `Symbol.for("@fog/request-als")` / `Symbol.for("@fog/container-store")` に。
  - `.dev.vars.example` に `SESSION_SECRET` / `AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET`（JSON keyring の例）/ `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY` を書き、**request 側3つと state 側2つの配布境界が非重複であること**をコメントで明示する。
  - **`README.md` を書き換える。** 実測で `README.md:1` が `# tanstack-start-template`、`:18` が Outbox pattern の説明、`:39` が `worker/ # background-worker entries (relay / consumer / pruner / dlq)`、`:51` が「Cloudflare Workers + D1 + Queues」、`:69` / `:81` / `:121` / `:123` / `:126` が `db:*` と D1 / queues の案内である。見出しを `# fog` にし、アーキテクチャ節を **DO + Alarm**（request / state の2 Worker、User Data DO / Identity Directory DO、job table + Alarm、FTS5 は同一トランザクション projection）へ、コマンド節を新スクリプト（`deploy:{request,state}:*` / `test:smoke` / `dev:state`）へ差し替える。**D1 / Queues / outbox / relay / consumer / pruner / DLQ / `idempotencyStore` / `db:*` への言及を残さない。**
- **理由:** 対応項目8・`.adr/001` の影響欄・AC-18 / AC-20。
- **検証:**
  - **AC-20 の grep（落ちない形に確定済み）** — 次が 0 件であること。

    ```sh
    grep -rn "tanstack-start-template" . \
      --include='*.json' --include='*.toml' --include='*.tpl' --include='*.yaml' \
      --include='*.ts' --include='*.md' \
      --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.thread \
      --exclude-dir=dist --exclude-dir=.direnv \
      | grep -v 'spec/idea\.md'
    ```

    **除外の根拠を2つとも明示する** — (i) `.thread/` は過去の作業ログであり、書き換えると当時の記録が嘘になる。(ii) `spec/idea.md:42` は**着想時点の技術スタック欄**という歴史文書なので書き換えない。実測で、この2つを除いた残存は `README.md` / `apps/web/{package.json,wrangler.toml}` / ルート `package.json` / `apps/web/app/server.cloudflare.ts` / `packages/core/src/application/di/containerStore.ts` / `vitest.config.integration.ts` / Pulumi の6 yaml / 削除済みの `handlers.integration.test.ts` の**すべてがステップ12 / 23 / 25 / 26 / 27 の対象**であり、上のコマンドは本ステップとステップ27 の完了後に 0 件になる。
  - `grep -n "D1\|Queues\|outbox\|relay\|consumer\|pruner\|DLQ\|db:" README.md` が 0 件
  - `pnpm typecheck` / `pnpm dev` の起動確認

---

### 27. Pulumi

- **対象ファイル:** `infra/cloudflare/pulumi/resources/index.ts`、`infra/cloudflare/pulumi/resources/Pulumi.yaml` / `Pulumi.{staging,production}.yaml`、`infra/cloudflare/pulumi/routes/index.ts` / `Pulumi.yaml` / `Pulumi.{staging,production}.yaml`、`infra/cloudflare/pulumi/package.json`
- **変更内容:**
  - `resources/index.ts` から `cloudflare.D1Database`（`{ protect: true }` ごと）と `cloudflare.Queue` ×2 を削除し、export から `databaseId` / `databaseName` / `eventsQueueName` / `dlqQueueName` を落とす。残るのは `Zone` と `exportedAppUrl` / `exportedAppHostname` / `exportedPrefix` / `zoneId`。**DO namespace は `exports` でデプロイ時に作られるので Pulumi では provision しない**（adr.md ADR-011）。
  - `routes/index.ts` の `WorkersDomain` の `service` は request Worker（`${prefix}`）のまま。state Worker は公開ルートを持たないので何も足さない。
  - Pulumi プロジェクト名を `fog-cf-resources` / `fog-cf-routes` へ、`resourcePrefix` を `fog-staging` / `fog-production` へ、`resourcesStackRef` を `organization/fog-cf-resources/{staging|production}` へ変更する（どのスタックも `up` されていないので安全。`plan.md` のリスク欄参照）。
  - `render` スクリプトはステップ25 で拡張済み。
- **理由:** 対応項目7・AC-17 / AC-20。
- **検証:** `pnpm --filter @repo/infra-cloudflare typecheck`。`grep -n "D1\|Queue\|databaseId\|eventsQueue\|dlqQueue" infra/cloudflare/pulumi/**/*.ts` が 0 件。

---

### 28. CI

- **対象ファイル:** `.github/workflows/ci.yml`
- **変更内容:** `build` ジョブの末尾に `pnpm test:smoke` を足す（`pnpm build:cf` の後）。`integration` ジョブのコマンドを `pnpm test:integration` に揃える。
- **理由:** AC-22。
- **検証:** `npx actionlint .github/workflows/ci.yml`（無ければ YAML の構文確認）。PR で3ジョブが緑になること。

---

### 29. CLAUDE.md / spec / `.adr/` / docs の更新

- **対象ファイル:** `CLAUDE.md`、`spec/database/index.md`、`.adr/001-integration-tests-single-workers-pool.md`、**`.adr/003`**（FTS5 tokenizer の決定）、**`docs/test.md`**、**`docs/backend_implementation_example.md`**（警告ブロックのみ）
- **変更内容:**
  - `CLAUDE.md` の「### Migration in progress — [#37](…)」節を**節ごと削除**する（同節が「When #37 lands, delete this subsection」と明記）。
  - 同ファイルの「Entry points」を新構成へ更新する: `apps/web/app/server.cloudflare.ts`（request Worker fetch）、`apps/web/app/worker/cloudflare/state.ts`（state Worker / DO クラス）、`apps/web/app/durable-objects/{userData,identityDirectory}.ts`、`packages/core/src/application/di/{serverCloudflare,stateCloudflare}.ts`。「`pnpm start` / `pnpm preview` が起動不能（#40）」の段落を削除する（#40 は解消済み）。
  - 「Development Commands」から `db:*` への言及を削除し、`pnpm test:smoke` を足す。
  - **「Workspace layout」節の `apps/web` の説明を新構成へ直す。** 実測で `CLAUDE.md:19` は「…the Cloudflare server entry **and workers**, `scripts/`, and all runtime configs (vite / wrangler / **drizzle**)」であり、#37 完了時点で **`apps/web/drizzle.config.ts` は削除され（AC-17）、`apps/web/app/worker/cloudflare/` に残るのは `state.ts` だけ**になるので、この1行は事実と食い違う。「the Cloudflare request-Worker entry and the state Worker (Durable Object classes), `scripts/`, and all runtime configs (vite / wrangler)」の形へ書き換え、`apps/web/app/durable-objects/` にも触れる。**この行は下の検証 grep 4本（`Migration in progress` / `fail to boot` / `D1|Outbox|relay|consumer|pruner|DLQ` / `alarm()`）のどれにも一致しないので、明示しないと確実に残る**（ARCH レビュー S-003）。
  - **同節の `pnpm start` / `pnpm preview` の但し書きを削除する。** 実測で `CLAUDE.md:29` が「(`pnpm preview` serves the build output through `vite preview`; **it and `pnpm start` currently fail to boot** — see Reference runtime below; use `pnpm dev`)」と書いている。**#40 の原因（`eventRelayWorker.ts` の module-scope `crypto.randomUUID()`）はステップ12 で消えるので、#37 の完了時点でこの記述は事実と食い違う。** この括弧書きは `db:*` でも `D1|Outbox|relay|consumer|pruner|DLQ` でもないため、下の検証 grep 2本のどちらにも掛からずに残る（COV レビュー S-004）。**削除する前に、ステップ24 のスモークテスト（request / state の両方が起動する）が緑であることを根拠として確認する。**
  - **「Key concepts」節は変更不要であることを確認する。** #35 が既に新構成（UoW / 再試行戦略 / 入力検証 / ストレージ上限 / 非同期実行契約）へ改訂済みで、AC-28 が求めるのは「新構成と一致していること」であって書き換えではない。**一致を確認した旨を PR 本文に1行残す**（AC-28 の4項目のうち唯一「作業なし」で閉じる項目なので、確認したことが残らないと落としたのか通したのか区別できない）。
  - **「Cross-layer catch policy」に4つ目の許容点を足す** — 「**`alarm()` の migration ゲート（fail-closed の検出）**」。現行の列挙は "server-function serialization / the Durable Object's RPC entry points / per-job tolerance in the job runner" の3つで、ステップ16 が置く**ゲートを包む catch はどれにも当たらない**（ジョブランナーの per-job catch とは別物）。列挙が全数を名乗っている以上、足さないと規約違反が1件残る（ARCH レビュー S-002）。
  - `spec/database/index.md`「FTS5 の tokenizer 方針」に、ステップ1 / 9 の実測結果（trigram の可否・`bm25` の重みとページサイズの実値・短語フォールバックの閾値）を追記する。
  - `spec/database/index.md`「本ファイルで定義しないテーブル」の「検索の不透明カーソルが指す期限付きスナップショットの物理形は #37 が決める」を **#10 へ委譲**と書き換える（adr.md ADR-008）。#10 へのコメントはステップ30。
  - `spec/database/index.md`「1回の起動で触る量」の「値は #37 が spike で出して #38 が運用値として確定する」に対し、#37 が出した初期値を追記する。
  - `.adr/001` の「影響」に、起動スモークテストが別レイヤーとして加わったこと（`.adr/001` の射程は統合テストであること）を1項足す。
  - **`.adr/003` の「影響」に再確認の結果を書き戻す。** 同 ADR は「本決定は、公式ドキュメントに記載の無い FTS5 の挙動が実行環境で動くことに依存している。…**実装着手時に再確認する。再確認が覆れば本決定そのものが成立しない**」と書いており、**ステップ1 の spike がまさにその再確認である。** 「#37 の spike で再確認済み（日付・`tokenize='trigram'` の可否・`bm25` の実測・短語フォールバックの閾値・常設テストのパス `search/__tests__/tokenizer.integration.test.ts`）」を1項足す（COV レビュー S-007。AC-9 の記録先にも `.adr/003` を含める）。
  - **`docs/test.md`（79行）を書き換える。** 実測で `:17` が「Drizzle SQLite アダプター」、`:18` が「in-memory Miniflare D1 binding」、`:19` / `:50` が `_occ_guard` の CHECK、`:46` が `pnpm test:integration:cf` と `packages/core/src/adapters/d1/__tests__/setup.ts`、`:47` が `env.DB` からの container、`:61` / `:62` が D1 の deferred batch を前提にした記述である。**ステップ26 が `test:integration:cf` を消すので、直さないと存在しないコマンドを案内するドキュメントになる。** `.adr/001` の「影響」欄自身が「この運用ルールは `vitest.config.integration.ts` 冒頭のコメントと `docs/test.md` に記載」と書いているので、`.adr/001` だけ直して `docs/test.md` を放置すると片肺になる。**3スイート構成（unit / integration = Workers プール + DO バインディング / smoke = Node プール + miniflare `scriptPath`）へ書き換え、OCC の記述を `UPDATE … RETURNING 1` の0行検出へ差し替える。**
  - **`docs/backend_implementation_example.md`（456行）は #38 へ送る。** 実測で `outbox` 20件 / `collectEvents` 12件 / `PendingBatch` 8件 / `processed_events` / `idempotencyStore` を含み、全面改訂は #37 の分量に見合わない。**ただし「触れない」は選ばない** — `CLAUDE.md`「Examples」節がこのファイルを名指ししているので、放置すると**新しい CLAUDE.md が古い手本を指す**。冒頭に「本書は D1 + Outbox 時代の例であり、#37 で撤去された機構（Outbox / `collectEvents` / `PendingBatch` / `_occ_guard` / D1）を前提にしている。**書き換えは #38**」という警告ブロックを1つ足し、`CLAUDE.md` の「Examples」節にも同じ但し書きを1行添える。
- **理由:** Issue の指示（CLAUDE.md 本文が削除を明記）・AC-9 / AC-28・`.adr/003` の「影響」欄・`.adr/001` の「影響」欄。
- **検証:**
  - `grep -n "Migration in progress" CLAUDE.md` が 0 件
  - `grep -n "fail to boot" CLAUDE.md` が 0 件（`:29` の括弧書きと Reference runtime の段落の両方が消えていることの確認）
  - `grep -n "D1\|Outbox\|relay\|consumer\|pruner\|DLQ" CLAUDE.md` が 0 件（`docs/backend_implementation_example.md` への但し書きだけは例外として許す。その1行に `#38` が含まれることを目視で確認する）
  - `grep -n "alarm()" CLAUDE.md` が catch policy 節に1件ある
  - **`grep -n "drizzle\|Drizzle" CLAUDE.md` が 0 件**（Workspace layout 節の書き換えの確認。実測で現在 `:19` の1件だけがヒットする）
  - `grep -n "test:integration:cf\|_occ_guard\|drizzle\|Drizzle\|outbox" docs/test.md` が 0 件
  - `grep -n "#38" docs/backend_implementation_example.md` が冒頭に1件ある

---

### 30. 外部アクション（GitHub Issue へのコメント）と OCC 誤帰属テスト

- **対象ファイル:** `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts`（新規）、および GitHub Issue #26 / #10 / #37 / #38 / #2〜#6（外部アクション）
- **変更内容:**
  - **テスト:** DO 側の OCC が誤帰属を起こさないことを検証する。
    1. 版が古い `save` が `ConflictError("OPTIMISTIC_LOCK_FAILURE")` になる
    2. 同一トランザクションで**別の行の更新が成功していても**、対象行の0行一致が正しく検出される（D1 の `_occ_guard` が「バッチ内のどの文の失敗か」を区別できなかったのに対し、`RETURNING 1` は文の中で閉じることの検証）
    3. 同一トランザクションで**2つの OCC 更新**があり、後者だけが失敗した場合に、前者の書き込みもロールバックされ、投げられるエラーが後者の主体を指している
    4. 成功パスで「ガード用の中間状態」が一切残らない（`_occ_guard` に相当するテーブルが存在しないことを `sqlite_master` で確認する）
  - **外部アクション (a) — #26 へコメントする**（`gh issue comment 26 --body-file <file>`）。
    - 「D1 の OCC 競合誤帰属」は #37 で `packages/core/src/adapters/d1/` ごと削除され、`_occ_guard` / `PendingBatch` / `isOccGuardViolation`（メッセージ部分一致）の機構が消滅した
    - DO 側の OCC は `UPDATE ... WHERE ... RETURNING 1` の行有無で判定するため、判定が1文の中で閉じ、他の文の結果に依存しない
    - 上記4項目の統合テストで誤帰属が起きないことを固定した（テストのパスを添える）
    - **`.thread/36/plan.md` の引き継ぎ表 H-7 が指した「正しい参照実装（libSQL `PendingBatch.addOcc` の per-statement conflict handler）の喪失」も、誤帰属の実体だった D1 側の `firstConflictHandler()` が本 Issue で消えることで解消する。** つまり #26 は**参照実装側・誤帰属側の両方が対象消滅**である
    - GCP `/prune` の無認証は #36 の GCP 撤去で対象消滅している（#26 のもう1件）。**3件とも対象消滅なので #26 のクローズを提案する**
  - **外部アクション (b) — #10 へコメントする**（`gh issue comment 10 --body-file <file>`）。「不透明カーソルが指す期限付きスナップショットの物理形は #37 → **#10 へ委譲**。`spec/database/index.md`「本ファイルで定義しないテーブル」の当該行はステップ29 で書き換え済み。#37 が置いたのは `adapters/cloudflare/search/probe.ts`（tokenizer 検証専用の最小の読み2本）だけで、`SearchIndexPort` の実装は無い。`probe.ts` は #10 が吸収するか削除してよい」（adr.md ADR-008 / plan.md「未解決事項」が約束している外部アクション）。
  - **外部アクション (c) — Issue #37 本文の誤りを訂正する**（`gh issue comment 37 --body-file <file>`。可能なら本文編集も行う）。`.thread/34/design.md`:2192 / :2610 が**2箇所で「#37 は Issue 本文の当該行を訂正してから着手する」と指示している。** PR 本文だけでは、Issue 本文を読む次の担当者に誤りが残る。内容は `plan.md` 冒頭の訂正表と同じ2点 — (i) 対応項目3 の「UoW 契約は維持したまま」は誤りで**契約ごと差し替える**、(ii) 対応項目8・受け入れ条件9 の `new_sqlite_classes` は誤りで**宣言的 `exports` を採る**（`[[migrations]]` 配列と排他で、両方あると wrangler の設定検証で弾かれる）。
  - **外部アクション (d) — #38 へコメントする**（`gh issue comment 38 --body-file <file>`）。**同じ `new_sqlite_classes` の誤りが #38 の対応項目1 にも伝播している**（"`wrangler*.toml` の SQLite class 定義（`new_sqlite_classes`）と migration tag の運用"）ので、(c) と同じ訂正を渡して再発を防ぐ。あわせて `docs/` 配下の帰属（`docs/backend_implementation_example.md` の全面改訂・`docs/runtime_cloudflare.md`・Pulumi の `protect: true` 解除手順・fail-closed / `poison` の検知）が #38 であることを1本にまとめて残す。
  - **外部アクション (e) — #2〜#6 へ引き継ぐ**（各 Issue へ同文をコメント、または #2 に代表して1本）。「**`memos` / `documents` / `topics` の本体行を書くリポジトリ実装は、同じ `transactionSync` の中で `packages/core/src/adapters/cloudflare/search/projection.ts` を呼ぶこと。** #37 は projection モジュールと `search_entries` / `search_fts` の DDL までを提供し、呼び出し側は持たない（adr.md ADR-001）。**呼び忘れても例外は上がらず索引だけが黙って壊れる**ので、AC-7 の統合テストは projection を呼んだ経路しか守れない」。これが無いと、#37 のリスク欄が挙げた「FTS5 の踏み外し」を #2〜#6 の側で回収できない（COV レビュー S-004）。
- **理由:** 対応項目3（「#26 にその旨をコメントし、DO 側の OCC で同種の誤帰属が起きないことをテストで確認する」）・AC-5（`_occ_guard` に相当するテーブルが存在しないことの確認）・AC-6・AC-30・adr.md ADR-008・`.thread/34/design.md`:2192 / :2610 の訂正指示。**H-5(b) は Issue #37 の3番目のコメントで取り下げられているので根拠に挙げない**（作業自体は AC-5 / AC-17 の範囲で正当化できる。COV レビュー S-006）。
- **検証:** `pnpm test:integration`。`gh issue view {26,10,37,38} --json comments` にそれぞれコメントが載っていること。#2〜#6 のうちコメントした Issue 番号を PR 本文に列挙する。

---

### 31. spec / inventory との突き合わせ

- **対象ファイル:** `spec/inventory/adapter.md`（更新が要れば）、PR 本文
- **変更内容:** `spec/inventory/adapter.md` の ADP-* 99件のうち **#37 の範囲のもの**（schema 系の全テーブル、identity 系の ADP-identity-001〜025、`ADP-search-fts-001`、`ADP-trash-005` のうちジョブ側）について、実装との対応表を PR 本文に作る。実装しなかったものは担当 Issue を明記する。**spec 側に誤りが見つかった場合は spec を直す**（`spec/database/index.md` が正本）。
- **理由:** #47 が「改訂後の spec/inventory と実装 Issue のチェックリストの対応に残る穴」を追っているので、#37 が埋めた分を明示する。
- **検証:** 台帳の行が「実装済み / 担当 Issue」のどちらかに割り当てられ、未割り当てが 0 件。

---

### 32. 全ゲート

- **対象ファイル:** —
- **変更内容:** 次を順に実行し、すべて緑にする。
  1. `pnpm install --frozen-lockfile`
  2. `pnpm typecheck`
  3. `pnpm lint:fix && pnpm format`
  4. `pnpm lint && pnpm format:check`
  5. `pnpm test:unit`
  6. `pnpm test:integration`
  7. `rm -rf apps/web/dist && pnpm build:cf && pnpm test:smoke`（クリーンな状態からブートストラップできることを含めて確認する）
  8. `pnpm dev` を起動し、サインアップ → ログイン → 設定画面 → ログアウトが通ることをブラウザで確認する
  9. `cd apps/web && npx wrangler deploy -c wrangler.toml --dry-run --outdir=/tmp/req-dry` と `... -c wrangler.state.toml --dry-run --outdir=/tmp/state-dry` が成功する
  10. **module スコープの禁止操作を grep で固定する**（AC-23 の時刻取得ぶん。スモークテストは乱数生成・非同期 I/O・タイマー設定しか検知しない）:

      ```sh
      grep -rn "randomUUID\|getRandomValues\|Date\.now\|setTimeout\|setInterval\|fetch(" \
        packages/core/src/adapters/cloudflare apps/web/app/durable-objects \
        apps/web/app/worker/cloudflare/state.ts
      ```

      ヒットした行が**すべて関数本体の中**にあり、module トップレベルの初期化式に無いことを1件ずつ確認する（件数ではなく所在で判定する）。
  11. AC 表の全 30 項目を1件ずつ確認し、検証コマンドと結果を PR 本文に残す
  12. テストファイル数・ケース数の増減を実測して PR 本文に残す（削除 / 追加 / 移植の内訳）
- **理由:** 受け入れ条件11・AC-23 / AC-29。
- **検証:** 上記そのもの。
