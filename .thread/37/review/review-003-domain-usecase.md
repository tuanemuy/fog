# Domain / Use Case

PR #49（`origin/main...HEAD`、259ファイル）の**3周目**レビュー。焦点は「マージしてよいか」であり、2周目に出した W-001〜W-005 の修正が実際に入ったか、その修正が新しい問題を生んでいないかを検証した。表記の好みや軽微な改善提案は挙げない。

判定基準は `CLAUDE.md` / `spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/inventory/{domain,usecase}.md` と `.thread/37/plan.md`（受け入れ基準・スコープ）、`.thread/37/adr.md`（今回は ADR-090〜095 / 100〜103 / 110〜112）、`.thread/37/review/triage.md`。`wont-fix` と判定された指摘は再審議していない。

**2周目の5件（W-001〜W-005）はすべて解消していた。** いずれも triage の記述どおりの直し方で、コードの振る舞いを壊した箇所は見つからなかった。**Blocker・Warning ともに無い。**

### Blockers

なし。

### Warnings

なし。

### Notes

- **[N-001]** ADR-091（sliding → 窓番号）はドメイン層で正しく閉じている。判定式 `floor(last / windowMs) < floor(now / windowMs)` は `domain/identity/credentialMappingRules.ts` の1箇所だけにあり、`send-mail` の `operationKey` が持つ窓（`adapters/cloudflare/identityDirectory/resetRequestKeys.ts:41`）と**同じ `RESET_REQUEST_WINDOW_MS` を同じ `floor` で割っている**。ADR-043 の不変条件（適格な依頼の窓番号には行がまだ無い）が実際に保たれることも確認した — `recordResetRequested` が適格・非適格を問わず無条件に走るので、窓 k の依頼が適格である ⇔ 窓 k にそれ以前の依頼が無い、が成立する。DO エントリ（`apps/web/app/durable-objects/identityDirectory.ts:196`）が `this.now()` を1回だけ読み、`sendMailOperationKey` の導出と facade の適格判定の両方へ同じ値を渡しているので、窓が2箇所でずれる経路も無い。

  境界ケースを1つ記録する。未登録アドレスへの依頼が窓 k に `send-mail` 行を作った直後（同じ窓のうち）にそのアドレスが登録され、再度依頼されると、`lastResetRequestedAt` は `null`（写像行は依頼時に存在しなかったので何も書かれていない）なので適格になり、既存の窓 k の行へ収束する。収束規則 (2)(3) が `done` 行を復活させるので送信自体は起きる（adapter-infra 2周目 W-006 の修正でキーの置換も入っている）。**現状では実害に至らない**が、「適格な依頼の窓番号には行が無い」という言明の反例ではある — 成立しているのは「**同じ写像行に対して**」という限定つきである。

- **[N-002]** ADR-090 の `sweep-reset-tokens` 投入は UoW の契約を崩していない。`enqueueJob` は `IdentityDirectoryUnitOfWorkContext` のロスターに元からある登録点で、`payload: {}` の定数キーなので `payloadDigest` の不一致（`JOB_PAYLOAD_MISMATCH`）を起こす経路が無い。ハンドラ側の再武装は `{ kind: "rearm" }` の戻り値であって `enqueueJob` ではないので、こちらもキー衝突の対象にならない。`spec/usecases/identity.md`:203 の一様性の言明（「同じトランザクションで**送信ジョブの行を1行**書き」）は `send-mail` についての言明であり、掃除行が4ケースすべてで無条件に増えることと矛盾しない。

- **[N-003]** ADR-092 / ADR-094 はドメイン・ユースケース層に触れていない（導出は adapter、範囲検査は adapter の純関数）。ADR-093 は `domain/identity/ports/credentialMappingStore.ts` の `beginChange` の JSDoc に「0行は `ConflictError`」を足しただけで、シグネチャは変わっていない。ADR-100〜103 / 110〜112 は presentation / 設定 / テストに閉じており、`packages/core/src/domain` と `packages/core/src/application` への波及は無いことを差分で確認した。

- **[N-004]** 2周目 N-007 (i) は未対応のまま残っている（Notes は triage の対象外なので想定どおり）。`spec/inventory/domain.md` DOM-identity-001 は `credentials` を「1件以上」と無条件で書いており、`spec/domains/identity.md`:44 が今回「**登録完了後は**1件以上」へ限定した書き分けと揃っていない。同じ行の後段が `initialize` の「クレデンシャル集合を引数に取らない」を明記しているので誤読の余地は小さく、Warning には数えない。

- **[N-005]** `CredentialMappingRepository` の spec 契約（`findByEmail(email: Email)` / `findBySsoIdentity(...)`）と実装（`findByLocatorKey(kind, hmac)`）の乖離は今も残るが、`domain/identity/ports/credentialMappingRepository.ts:32-49` が「spec の契約は**リクエスト Worker から見た形**であり、`DIRECTORY_ROUTING_SECRET` を state Worker へ配らないという ADR-016 の帰結として DO 側では実装できない」と理由つきで宣言している。1・2周目も同じ判断で通しており、再審議しない。

- **[N-006]** 機械的な健全性を再実測した（すべて #37 の最終状態）。
  - AC-25 (i) `presentation` への import 0件 / (ii) `application → adapters` の逆流 0件。
  - `packages/core/src/{domain,lib}` から `application` / `adapters` への import 0件。
  - `Promise` を返すドメインポートは `MailSender.sendPasswordResetMail` / `PasswordHasher.hash` / `PasswordHasher.verify` の3メソッド（2ポート）だけで、`CLAUDE.md` の列挙どおり。
  - `pnpm typecheck` 緑、`pnpm test:unit` 525件緑（36ファイル）。AC-29 のうちこの2つを実測で確認した（integration / smoke は test 観点の担当）。

### 2回目指摘の修正検証

- **W-001**（`LastLoginCredential` と spec の `LastCredentialRemoval` の食い違い）: **解消。** ADR-095 のとおりコード側を spec 名へ寄せた（`errorCode.ts:11` = `LastCredentialRemoval: "IDENTITY_LAST_CREDENTIAL_REMOVAL"`）。リポジトリ全体の grep で `LastLoginCredential` / `LAST_LOGIN_CREDENTIAL` は**0件**、`LastCredentialRemoval` はコード2件（定義 + `envelope.test.ts:39` の参照）と spec 6件（`usecases/identity.md` ×2 / `testcases/identity/unlinkSsoCredential.md` / `inventory/test.md` / `manual-tests/account.md` ×2）で、名前が1つに揃っている。指摘した `envelope.test.ts` の直書きも `IdentityErrorCode.LastCredentialRemoval` 参照へ変わっており、次に名前が動けばテストが追随する。`errorCode.ts` のコメントも「なぜ述語名ではなく spec 名か」を残していて、#12 が読む順序（spec → コード）と一致している。

- **W-002**（ADR-070 の `.adr/008` への書き戻しが無い）: **解消。** `.adr/008` の「影響」欄に1行が入り、(i) 「決定」欄の当該2文が取り消されていること、(ii) 取り消しの理由（`credentials` は射影で集約が書く遷移を持たない）、(iii) **`usableForLogin` を型に載せる決定自体は維持**され根拠が `loginCredentialCount` + `unlinkSsoCredential`（#12）へ移ったこと、の3点が書かれている。提案した内容を過不足なく満たしており、`.adr/003` への書き戻し（AC-9）と同じ作法になった。

- **W-003**（`credentialMappingRules` に spec のアンカーが無い）: **解消。** `spec/domains/identity.md` の「ドメインサービス」節に小節「認証情報の可否判定（credentialMappingRules）」が新設され、4述語の契約表とシグネチャがコードと1対1で一致する（`isSettled(mapping)` / `holdsPasswordVerifier(mapping)` / `isUsableForLogin(mapping, now)` / `isResetRequestAllowed(mapping, now, windowMs)`）。**指摘した「リセット可否をログインの backoff と別建てにする理由」も spec 本文に入った**（表の4行目 + 直下の箇条書き）。`spec/inventory/domain.md` に DOM-identity-045 が追加され、アンカー先が `spec/domains/identity.md#認証情報の可否判定credentialMappingRules` を指している。`grep` で spec 側6箇所がヒットし、2周目に0件だった状態は解消した。#18 が「条件を足す先」も台帳から辿れる。

- **W-004**（`getCurrentUser` の DTO に `email` が残る）: **解消。** `spec/usecases/identity.md` の出力 DTO 表の `email` 行に「**#12 で入る**。… #37 が返すのは3つで、`email` の欠落は実装漏れではない」、処理フロー手順3に「**この手順の実装は #12**」が入り、`spec/inventory/usecase.md` UC-identity-013 にも同じ注記が入った。実装側（`application/identity/view.ts` の `CurrentUserView`）が `userId` / `credentials` / `trashRetentionDays` の3フィールドであることと突き合わせて矛盾が無い。`implement-audit` / `spec-sync` が「1フィールド足りない未検出の実装漏れ」として拾う形は消えている。

- **W-005**（`dedupeByCredentialId` のコメントと実装の食い違い）: **解消。** 推奨した (a) を採用。関数 JSDoc が「**`usableForLogin` は世代間の OR であって last-write ではない**」と述べ、その理由（ローテーション移送中に片方の世代がまだ再写像されていなくても「ログイン手段でない」と数えて締め出さない）と、`label` は勝った行のものであること・世代間で値が変わらない前提・#44 が変えるならそこが見直し点であることまで書かれている。条件式の直前にも1行（`>` は OR であって last-write-wins ではない）が入り、コードとコメントが同じ規則を述べている。実装（`row.usable_for_login > existing.usable_for_login`）は変更されておらず、挙動の変化は無い。

**新たな問題を生んだ指摘: なし。** ADR-090〜095 の変更のうちドメイン層に触れたのは `credentialMappingRules.isResetRequestAllowed` の判定式（ADR-091）と `credentialMappingStore` / `errorCode` の JSDoc・定数名だけで、ポート契約の同期性・UoW コンテキストのロスター・依存方向・値オブジェクトの境界検証はいずれも 2周目時点から後退していない。

### マージ可否

**可。** Domain / Use Case 観点でのブロッカーは無い。

### カバレッジ

一覧259件に対し、**確認60件 / スキップ199件（合計259件）**。

2周目の確認54件は最終状態で再点検した（`packages/core/src/{domain,lib}` と `packages/core/src/application` については、個別の読み直しに加えて依存方向・ポート同期性・エラーコード名の機械検査をリポジトリ全体に掛け直している。N-006）。新規6件を確認側に足した内訳は、W-002 の検証対象（`.adr/008`）、自分の観点の2周目レビューと総括（`review-002-domain-usecase.md` / `review-002.md`）、および ADR-090 / 092 でドメイン規則と定数を読む側になった3ファイル（`resetRequestKeys.ts` / `sweepResetTokens.ts` / `jobBudgets.ts`）である。

#### 確認（60件）

- `.adr/008-identity-split-and-non-aggregate-stores.md`
- `.thread/37/adr.md`
- `.thread/37/plan.md`
- `.thread/37/review/review-001-domain-usecase.md`
- `.thread/37/review/review-002-domain-usecase.md`
- `.thread/37/review/review-002.md`
- `.thread/37/review/triage.md`
- `.thread/37/steps.md`
- `CLAUDE.md`
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx`
- `apps/web/app/durable-objects/identityDirectory.ts`
- `apps/web/app/durable-objects/userData.ts`
- `packages/core/src/adapters/cloudflare/directoryLocator.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetRequestKeys.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- `packages/core/src/adapters/cloudflare/jobs/table.ts`
- `packages/core/src/adapters/cloudflare/userData/facade.ts`
- `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts`
- `packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts`
- `packages/core/src/application/di/facades.ts`
- `packages/core/src/application/di/secrets.ts`
- `packages/core/src/application/di/serverCloudflare.ts`
- `packages/core/src/application/di/stateCloudflare.ts`
- `packages/core/src/application/di/types.ts`
- `packages/core/src/application/errors.ts`
- `packages/core/src/application/execution/jobs.ts`
- `packages/core/src/application/execution/unitOfWork.ts`
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- `packages/core/src/application/identity/__tests__/requestPasswordReset.test.ts`
- `packages/core/src/application/identity/getCurrentUser.ts`
- `packages/core/src/application/identity/loginWithPassword.ts`
- `packages/core/src/application/identity/registerWithPassword.ts`
- `packages/core/src/application/identity/requestPasswordReset.ts`
- `packages/core/src/application/identity/signupSaga.ts`
- `packages/core/src/application/identity/view.ts`
- `packages/core/src/domain/common/transactionalRepository.ts`
- `packages/core/src/domain/identity/__tests__/credentialMappingRules.test.ts`
- `packages/core/src/domain/identity/__tests__/entity.test.ts`
- `packages/core/src/domain/identity/__tests__/valueObject.test.ts`
- `packages/core/src/domain/identity/credentialMappingRules.ts`
- `packages/core/src/domain/identity/entity.ts`
- `packages/core/src/domain/identity/errorCode.ts`
- `packages/core/src/domain/identity/ports/accountStore.ts`
- `packages/core/src/domain/identity/ports/credentialLocatorStore.ts`
- `packages/core/src/domain/identity/ports/credentialMappingRepository.ts`
- `packages/core/src/domain/identity/ports/credentialMappingStore.ts`
- `packages/core/src/domain/identity/ports/mailSender.ts`
- `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts`
- `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts`
- `packages/core/src/domain/identity/ports/userSettingsRepository.ts`
- `packages/core/src/domain/identity/valueObject.ts`
- `packages/core/src/lib/errorIdentity.ts`
- `packages/core/src/lib/jobBudgets.ts`
- `spec/domains/identity.md`
- `spec/inventory/domain.md`
- `spec/inventory/usecase.md`
- `spec/testcases/identity/unlinkSsoCredential.md`
- `spec/usecases/identity.md`

#### スキップ（199件）

**他観点のレビューファイル・作業ログ（10件）** — 自分の観点の1・2周目レビューと triage / steps / 総括以外は他レビュアーの担当。

- `.thread/37/review/review-001-adapter-infra.md`
- `.thread/37/review/review-001-presentation-config.md`
- `.thread/37/review/review-001-security.md`
- `.thread/37/review/review-001-test.md`
- `.thread/37/review/review-001.md`
- `.thread/37/review/review-002-adapter-infra.md`
- `.thread/37/review/review-002-presentation-config.md`
- `.thread/37/review/review-002-security.md`
- `.thread/37/review/review-002-test.md`
- `.thread/37/testing.md`

**恒久 ADR（2件）** — `.adr/008` は W-002 の検証対象なので確認側へ移した。残る2件の変更差分は検索・テスト構成の観点。

- `.adr/001-integration-tests-single-workers-pool.md`
- `.adr/003-sqlite-fts5-only-search.md`

**削除された D1 アダプター群・Outbox 機構・旧 Worker 群（28件）** — 対象消滅の削除。ドメイン契約側の変更（同期化・イベント撤去）は「確認」側で見ており、削除物そのものはアダプター観点。

- `apps/web/app/worker/cloudflare/__tests__/env.d.ts`
- `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`
- `apps/web/app/worker/cloudflare/consumer.ts`
- `apps/web/app/worker/cloudflare/dlq.ts`
- `apps/web/app/worker/cloudflare/handlers.ts`
- `apps/web/app/worker/cloudflare/pruner.ts`
- `apps/web/app/worker/cloudflare/relay.ts`
- `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`
- `packages/core/src/adapters/d1/__tests__/env.d.ts`
- `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/helpers.ts`
- `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/setup.ts`
- `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts`
- `packages/core/src/adapters/d1/client.ts`
- `packages/core/src/adapters/d1/migrations/0000_initial.sql`
- `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json`
- `packages/core/src/adapters/d1/migrations/meta/_journal.json`
- `packages/core/src/adapters/d1/pendingBatch.ts`
- `packages/core/src/adapters/d1/repositories/helpers.ts`
- `packages/core/src/adapters/d1/repositories/idempotencyStore.ts`
- `packages/core/src/adapters/d1/repositories/outboxRepository.ts`
- `packages/core/src/adapters/d1/repositories/userRepository.ts`
- `packages/core/src/adapters/d1/schema.ts`
- `packages/core/src/adapters/d1/unitOfWork.ts`

**削除されたイベント機構・旧ポート（13件）** — AC-14 / AC-8 の消滅確認のみ。ドメインからイベント型が消えたことは `domain/identity/entity.ts` 側で確認済み。

- `packages/core/src/application/events/buildDecoder.ts`
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts`
- `packages/core/src/application/identity/eventDecoders.ts`
- `packages/core/src/application/ports/idempotencyStore.ts`
- `packages/core/src/application/ports/outboxRepository.ts`
- `packages/core/src/application/ports/relayTrigger.ts`
- `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts`
- `packages/core/src/application/workers/__tests__/outboxPrune.test.ts`
- `packages/core/src/application/workers/eventRelayWorker.ts`
- `packages/core/src/application/workers/outboxPrune.ts`
- `packages/core/src/domain/common/event.ts`
- `packages/core/src/domain/identity/events.ts`
- `packages/core/src/domain/identity/ports/userRepository.ts`

**Cloudflare アダプター実装（38件）** — SQL 実行・スキーマ DDL・ジョブ実行部・検索 projection・暗号・alarm・リセットトークン導出鎖。ドメイン契約に触れる facade / rules 呼び出し点と ADR-090 の投入先ハンドラは「確認」側に入れ、残る駆動部と DDL はアダプター観点（ADR-042 / 092 / 094 の導出鎖と範囲検査は security / adapter 担当）。

- `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts`
- `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts`
- `packages/core/src/adapters/cloudflare/jobs/registry.ts`
- `packages/core/src/adapters/cloudflare/jobs/runner.ts`
- `packages/core/src/adapters/cloudflare/mailSender.ts`
- `packages/core/src/adapters/cloudflare/platform/envelope.ts`
- `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- `packages/core/src/adapters/cloudflare/platform/stubErrors.ts`
- `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts`
- `packages/core/src/adapters/cloudflare/schema/gate.ts`
- `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts`
- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts`
- `packages/core/src/adapters/cloudflare/schema/types.ts`
- `packages/core/src/adapters/cloudflare/schema/userData.ts`
- `packages/core/src/adapters/cloudflare/search/normalize.ts`
- `packages/core/src/adapters/cloudflare/search/probe.ts`
- `packages/core/src/adapters/cloudflare/search/projection.ts`
- `packages/core/src/adapters/cloudflare/sql/errors.ts`
- `packages/core/src/adapters/cloudflare/sql/exec.ts`
- `packages/core/src/adapters/cloudflare/sql/occ.ts`
- `packages/core/src/adapters/cloudflare/userData/accountStore.ts`
- `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts`
- `packages/core/src/adapters/cloudflare/userData/trashQuery.ts`
- `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts`
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`

**アダプター / 統合・単体テスト（32件）** — DO バインディング・alarm・job table・FTS5・migration ゲート・クリーンアップ・禁止語配列の検証。テスト観点かつアダプター観点（ADR-110〜112 の不安定性対応を含む）。

- `apps/web/app/durable-objects/__tests__/env.d.ts`
- `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/directoryLocator.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts`
- `packages/core/src/adapters/cloudflare/__tests__/env.d.ts`
- `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/setup.ts`
- `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/mappingOperations.integration.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/payloadDigest.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts`
- `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts`
- `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts`
- `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts`
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts`

**application 層の残りテスト・合成ルート補助（16件）** — 1・2周目に確認済みで、`21fd944` / `e56785a` が触れていないか、触れていても他観点（テスト / 設定）の担当。

- `packages/core/src/application/__tests__/helpers.ts`
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts`
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts`
- `packages/core/src/application/di/__tests__/secrets.test.ts`
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts`
- `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts`
- `packages/core/src/application/di/containerStore.ts`
- `packages/core/src/application/di/env.ts`
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts`
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts`
- `packages/core/src/application/identity/__tests__/logout.test.ts`
- `packages/core/src/application/ports/idGenerator.ts`
- `packages/core/src/application/ports/sessionCodec.ts`
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts`
- `packages/core/src/application/rpc/restoreError.ts`
- `packages/core/src/domain/identity/__tests__/noRawNul.test.ts`

**`lib/` の leaf モジュール（6件）** — 層の外の構造的プリミティブ。1周目に全数確認済みで、`21fd944` が触れた `jobBudgets.ts` は確認側へ移した。

- `packages/core/src/lib/__tests__/jobKind.test.ts`
- `packages/core/src/lib/directoryLocator.ts`
- `packages/core/src/lib/jobKind.ts`
- `packages/core/src/lib/passwordHashing.ts`
- `packages/core/src/lib/rpcEnvelope.ts`
- `packages/core/src/lib/secretLengths.ts`

**presentation 層・フロントエンド（16件）** — presentation-config 担当（ADR-100 / 102 の `ErrorSurface` 抽出と `errorResponseMiddleware` のログ条件を含む）。

- `apps/web/app/components/auth/LoginForm/action.ts`
- `apps/web/app/components/auth/SignupForm/action.ts`
- `apps/web/app/components/settings/LogoutButton/action.ts`
- `apps/web/app/components/settings/SettingsSkeleton/index.tsx`
- `apps/web/app/components/ui/ErrorSurface/index.tsx`
- `apps/web/app/presentation/__tests__/currentUser.test.ts`
- `apps/web/app/presentation/__tests__/errorResponse.test.ts`
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts`
- `apps/web/app/presentation/__tests__/session.test.ts`
- `apps/web/app/presentation/authState.ts`
- `apps/web/app/presentation/currentUser.ts`
- `apps/web/app/presentation/errorResponse.ts`
- `apps/web/app/presentation/errorResponseMiddleware.ts`
- `apps/web/app/presentation/session.ts`
- `apps/web/app/routes/_app.tsx`
- `apps/web/app/routes/_app/settings.tsx`

**ビルド / デプロイ / インフラ / エントリポイント（29件）** — wrangler・vite・Pulumi・package.json・CI・lockfile・Worker エントリ・起動スモーク。インフラ / 設定観点（ADR-101 / 103 を含む）。

- `.github/workflows/ci.yml`
- `README.md`
- `apps/web/.dev.vars.example`
- `apps/web/__tests__/boot.smoke.test.ts`
- `apps/web/app/server.cloudflare.ts`
- `apps/web/app/worker/cloudflare/state.ts`
- `apps/web/drizzle.config.ts`
- `apps/web/package.json`
- `apps/web/scripts/render-wrangler.ts`
- `apps/web/vite.config.cloudflare.ts`
- `apps/web/vite.config.state.ts`
- `apps/web/wrangler.production.toml.tpl`
- `apps/web/wrangler.request.production.toml.tpl`
- `apps/web/wrangler.request.staging.toml.tpl`
- `apps/web/wrangler.staging.toml.tpl`
- `apps/web/wrangler.state.production.toml.tpl`
- `apps/web/wrangler.state.staging.toml.tpl`
- `apps/web/wrangler.state.toml`
- `apps/web/wrangler.toml`
- `infra/cloudflare/pulumi/resources/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.yaml`
- `infra/cloudflare/pulumi/resources/index.ts`
- `infra/cloudflare/pulumi/routes/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.yaml`
- `package.json`
- `packages/core/package.json`
- `pnpm-lock.yaml`

**テスト構成（3件）** — vitest の3スイート分割設定。テスト基盤観点。

- `vitest.config.integration.ts`
- `vitest.config.smoke.ts`
- `vitest.config.ts`

**ドキュメント・DB / アダプター spec（6件）** — `docs/` は #38 / presentation-config 担当。`spec/database/index.md` と `spec/inventory/adapter.md` は物理スキーマとアダプター台帳で、リセットトークンの導出鎖・投入点の同期は security / adapter 担当。`spec/manual-tests/search.md` は検索の手順書。

- `docs/backend_implementation_example.md`
- `docs/runtime_cloudflare.md`
- `docs/test.md`
- `spec/database/index.md`
- `spec/inventory/adapter.md`
- `spec/manual-tests/search.md`
