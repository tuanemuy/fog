# PH-09A 検証報告（Verifier、2026-09-09 19:46〜20:07 JST）

対象 HEAD `6c08553`（実装 `afca4e7` core / `ee62636` web / `b93173c` テスト。`6995c6d` / `6c08553` は Manager の spec 変更のみ）。`28653c9..b93173c` は 30 ファイル +3,309 / −106。作業ツリーは追跡ファイル clean（未追跡は `.claude/` / `.codex/` / `.spec-implement/` のみ）。実装コード・`spec/`・管理ファイルは変更していない。

## 判定

| ID | 判定 | 根拠（詳細は下） |
|---|---|---|
| R-REC-01 終端モードと後始末 | **合格** | 7 契機と 6 値語彙は `failureOutcome` の純関数（unit 5 件）と integration（`recovery` 12 件 / `jobTerminal` 4 件更新）で固定。突入は `attempt = 0` / `pending` / `completed_at` なし / `next_run_at = now + backoff(0)`、`ConflictError` はその起床で確定、後始末の失敗は backoff で理由不変、上限で `cleanup-exhausted:<forward>`、材料喪失は `attempt` によらず `cleanup-material-lost:<forward>`、完走は `done` で理由を残す、再確定は差し替え、冠の付け替えは `forwardTokenOf` で 6 値に閉じる（§2(a)）。S1〜S4 / L1〜L3 / C1 と `abandon-account` の 6 段、`finalize-withdrawal` の消す範囲と投入点の収束はコードと integration の両方で確認（§2(b)）。`poison` は prune されない（integration 22 行目 + `pruneCompleted` は `completedStatus` のみ）。dev では sqlite シードの poison 行を `list` → `requeue`（次の起床で前進完走 `done`、理由保持）→ `delete`（true / false）で確認（§3.2） |
| R-OPS-01 operator 経路 + DLQ + fail-closed | **合格（判断事項 M-1 あり）** | 10 entry が両クラス（`purge-user-mappings` / `list-bucket-user-ids` は Directory のみ）に届き、`requeue-*` だけ `rearm`、`delete-*` は `rearm` しない、一覧は keyset で `payload` / `owner_token` / `aggregate_id` を出さない、`OPERATOR_TOKEN` 未設定 404 / 誤り 401 / GET 405 / 未知 entry 404 / locator・schema 400、監査ログは `entry` / `locator` / `id` / `outcome` だけ（§3.1–3.3）。DLQ は dev で実物を踏んだ: 4 回失敗 → DLQ → `dlq { eventId, type, outcome: 'unserved' }` 1 行 → ack（§3.5）。fail-closed: `schema_version = 99` の User Data DO / bucket が全 entry で `SCHEMA_VERSION_AHEAD`（500、`ok: false`）、`read-schema-version` は 99 を返す、行は不変、1 に戻すと回復（§3.4）。**ただし `list-bucket-user-ids` は fail-closed bucket で `SCHEMA_VERSION_AHEAD` になる**（spec は診断 2 本をゲートの射程外と定める。M-1、PH-06 からの既存挙動）。Alarm 保持は integration で固定、dev では手動で武装できず未観測（§3.4） |

**R-REC-01 合格、R-OPS-01 合格（M-1 は spec との既存の食い違いで、PH-09A の変更点ではない）。** PH-01〜08 の 33 項目への影響なし（§4）。

### Manager の判断が必要な事項

- **M-1（spec 逸脱・既存・中）**: `IdentityDirectoryDurableObject.listBucketUserIds` は `enterRpc()` を通る（`identityDirectoryDurableObject.ts:529-534`、JSDoc「Passes the gate」）。spec/database「fail-closed」は「射程から外れるのは診断エントリ 2 本」、spec/recovery「例外群 (a) ゲートを通らない診断エントリ（`read-schema-version` / `list-bucket-user-ids`）」、docs §11.3 の PITR 手順（`list-bucket-user-ids` で `userId` を集めて `read-schema-version` で確かめる）はいずれも fail-closed bucket でも答えることを前提にしている。dev で再現: `dir:g1:b12` を 99 にして `list-bucket-user-ids` → `{ ok: false, code: SCHEMA_VERSION_AHEAD }`（19:58:10）。PH-06 以来の挙動で PH-09A は触っていないが、R-OPS-01 の完了条件「fail-closed の DO は Alarm を残して次回起床で回復する」の運用面（止まった DO の影響範囲を bucket 走査で作る）に直接効く。ゲートを外す（spec どおり）か、spec/docs 側を「`read-schema-version` だけが射程外」に改めるかの決定が要る。副次: ゲートを外す場合、未初期化 bucket を `[]` で返す（初期化しない）挙動になる点も spec と一致する
- **M-2（判断事項 1: `purge-user-mappings` を active アカウントに打った場合）**: dev で再現した。purge 後もセッションは生きたまま（`/signup` は `/` へリダイレクト）、P-13 は `role=alert`「読み込めませんでした / エラーが発生しました」（server function `DATA_INTEGRITY_ERROR`「The account's email address c…」）で、**P-13 上にログアウト導線が描画されない**（snapshot に button は devtools のみ）。利用者側から抜ける手段が cookie 削除しか無い。docs §8 に「退会の最後の砦にだけ使う」を書く候補は妥当だが、`account.status` を bucket 側から読めない以上コードでは防げないので、P-13 が canonical を解決できない場合でもログアウトを描く（degrade）か、issue で追跡するかを決めてほしい。再登録自体は通る（新 `userId` が b0 に現れ、旧 DO はマッピング無しの `active` アカウントとして残る = spec が「発見不能な残渣」と呼ぶ形そのもの。`list-bucket-user-ids` からは到達できない）
- **M-3（判断事項 2: `abandon-account` (3) の code）**: `SystemError(ConfigurationError, "abandon-account: the caller binding does not match")`。spec は「`SystemError`」のみなので契約違反ではないが、`ConfigurationError` はログで「設定不備」と読まれる code で、実体（束縛不一致 = 材料の欠落 / 別 saga）と合わない。後始末は backoff → `cleanup-exhausted:*` で焼き切れるので挙動は同じ。`DataIntegrityError` か専用 code のほうが operator の切り分けに向く。任意
- **M-4（判断事項 3: `terminal_reason` の形）**: `6995c6d` で spec/database の `jobs.terminal_reason` が「6 値トークン + 空白 1 つ + `operationId`、`outbox_events.terminal_reason` は relay の code のまま」に更新済みで、コード（`terminalReason()` / `parseTerminalReason()`）と一致。dev の実値: `forward-exhausted`（`sweep-orphan-mapping`、`operationId` 無し）、`cleanup-material-lost:forward-conflict 01a0-verify-op`、`PUBLISH_FAILED`（outbox）。追加の判断は不要
- **M-5（判断事項 4: docs 反映）**: `docs/runtime_cloudflare.md` は `28653c9..6c08553` で無変更。§8.2〜8.5 の「Reality: None ([#80]/[#74]) … unreachable / not implemented」、§8.6「The DLQ handler records and discards」、§10 の表（`read-delivery-backlog` / `delete-*` / `list-poisoned-jobs` / `requeue-poisoned-job` / `purge-user-mappings` / `list-bucket-user-ids` = no）は現在のコードと逆方向に食い違う（実装済み・到達可能なものを「無い」と書いている）。CLAUDE.md「gap は docs に記録しない」の裏返しで、docs が実装より古い状態。design.md は PH-10 で反映とあるが、`OPERATOR_TOKEN` の位置づけ（§8.2 (b)(iii)「Not adopted on its own」→ 実装は token を必須の前段として持つ）と DLQ 自動 1 回は、PH-09B の着手前に直すか issue を立てるのが安全

## 1. 自動テスト（自分で実行）

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` を HEAD `6c08553` で実行（`scratchpad/checks9a.log`、19:46:06〜19:46:23）: typecheck / lint（warning 3 は既存）/ format は exit 0。**1 回目の `pnpm test` は unit+dom で 1 件失敗**: `apps/web/app/components/settings/__tests__/aiConnectionsList.dom.test.tsx > a failure puts the row back with its reason`（`Unable to find an element with the text: Cursor`。PH-07 の DOM テストで PH-09A の変更外）。単独で 3 回連続 pass、**2 回目の `pnpm test` 全走（19:46:50〜19:47:16、`test9a-run2.log`）は unit+dom 121 files / 1,525 passed + 2 skipped、integration 27 files / 160 passed で exit 0** — 報告と一致。1 回目の失敗は並列負荷下の flaky と判断（O-6）。

### 新テストと spec/testcases/recovery/sagaRecovery.md（53 行）の対応

固定している行（番号は表の行順。T = unit、I = integration）:

- 1 突入の列: T `jobRunnerFailure`（`ConflictError` 即確定 / 上限、段あり → enter-terminal）、I `recovery` C1 ケース（上限で突入し `pending` / `completed_at NULL`）。**`ConflictError` 形の突入は unit のみ**（integration で前進 handler から実 `ConflictError` を投げる経路を組んでいない）。`next_run_at = backoff(0)` の値は未検証
- 2 終端モードでは後始末だけ: I S1〜S4 / L1〜L3 / C1 の各ケース（結果から間接的に。前進が走らないことを直接は固定していない）
- 3 後始末の失敗 backoff・理由不変: I「cannot reach its account backs off」
- 4 焼き切れ `cleanup-exhausted:<forward>`: I（`forward-conflict` 形のみ）+ T（両形）
- 5 完走 `done` で理由保持: I（S4 / L3 / C1 の 3 kind）
- 6 語彙と `operationId` だけ: T `terminalReason`（6 値の往復、`operationIdOf`）+ I の完全一致文字列
- 8 S1 の材料喪失: I（`credential_id` 不一致。**「行が無い」形は同じ分岐だが個別には未再現**）
- 9 S4 の同 tx: I（写像行の消滅 + `done`。**リセットトークン行の削除は S4 ケースで未 assert**。原子性そのものはテスト不能）
- 10 / 11 未初期化 DO → `nothing-to-abandon`、0 バイト: I `abandon-account`（`schemaVersion null` を確認）。**後始末がそれを成功として S3 へ進む形は未再現**
- 12 token 4 形 → `SystemError`、(1)(2) が照合より前: I
- 13 `abandoned` の効果・2 回目・行の収束: I
- 15 L2 が `reserved` 行を消す: I（**`active` な孤児写像の形は未再現**）
- 16 L3 同 tx・`target_locators` 残す: I
- 17 / 18 / 19 C1・`advanced` は `poison`・後勝ち 0 行 → `done`: I
- 21 後始末なし → 即 `poison`: I（`sweep-orphan-mapping` のみ。**`finalize-withdrawal` の `poison` は未再現**）
- 22 `poison` は prune されない: I
- 23 / 24 `list-poisoned-jobs` 5 列・順序・keyset・`payload` 非露出、`requeue` の 4 列 + `getAlarm()` 非 null: I `operatorEntries`
- 25 後始末ありの再駆動は後始末から: I（`cleanup-material-lost` の再駆動が S1 を再実行）
- 28 退会完走後: I（`readAccountState` が `deleted`。**cookie / epoch 拒否の経路は未再現**）
- 31 完走 saga → `already-completed`・無傷: I
- 34 未使用 bucket の初期化: I `jobTerminal`（世代 8002 の bucket が `listBucketUserIds` で初期化される）
- 37 後始末なしの再駆動は前進から: I
- 38 再確定で理由差し替え: T（現在値と別の理由に差し替え）。I は `forward-exhausted` → `forward-exhausted` で同値のため差し替えを観測できない
- 39 退会完走後の S2 は (2) で `abandoned`: I（`deleting` の DO に不一致 token）
- 41 別 saga の行 → `credential_id` 不一致で `poison`・何も消さない: I
- 42 最初の起床は前進: I `jobTerminal`（前進を上限まで試してから突入）
- 46 / 47 / 52 link record 不在 → material-lost、再駆動しても同じ、6 値のまま: I + T `forwardTokenOf`

**未固定の行（20 行）**: 7（S2 → S3 の順序。integration は RPC 呼び出し順を記録せず、S3 の対象も 0 件）、14（SSO 2 canonical の別 bucket、`credentialId` による除外）、20（`cancel-reservation` と同 tx のリセットトークン削除。PH-06 のストアテストの範囲）、26（予約 TTL の不等式 — 運用値。テスト不能で docs の値の確認事項）、27 / 29 / 32（PH-06 の migration ゲート・`operations` ライフサイクル。本フェーズの suite には無い）、30（後始末前のリセット依頼が fail closed）、33（`'pending'` 窓での版不一致 → リセットで回復）、35（`operation_id` が上書きされても PK で引ける）、36（`'advanced'` の再駆動が phase 2 を再発行せず完走）、40（旧 saga の前進が `operationId` 不一致で `done`）、43 / 44（`cancel-reservation` の CAS 2 条件 — PH-06 の範囲）、45（完走 saga の行が退会・解除で消えた形の material-lost）、48（投入点からの再投入 = `jobWriter` 収束規則 (2) — PH-06 の範囲）、49 / 50 / 51（`finalize-withdrawal` が未完了 link / unlink を `cancel-reservation` → `phase='done'` で引き取る形、有無の個別再現、link 終端後に退会が始まる順序）、53（`'advanced'` の前進で逆引き行が消えた → backoff → 再確定）。**このうち 49〜51 は退会側 3 要求そのもので、`finalizeWithdrawal.ts` の duty (2) がコード上は満たしているが未固定**（§2(b)）。

### outboxDelivery.md との対応（PH-09A が触る行）

16（`requeue` → 隔離を抜ける、`owner_token` 再採番）: I `operatorEntries`（**quarantine の `requeue` 後の `getAlarm()` 非 null は poison 側でしか assert していない**）。17（`published` だけ prune）: PH-06 + I（`jobs` 側）。18（prune 後の DLQ 再駆動 → `nothing-to-send`）: T `queueHandlers` DLQ（`nothing-to-send` を ack）。19（consumer 失敗 → DLQ、DO 不変）: T（retry）。20（fail-closed で relay に到達せず Alarm を残す）: I `operatorEntries`。21（fail-closed 前の publish 済み → `SystemError` → DLQ）: T（`failed` を ack）。15（上限超過の打ち切り）: **50 件超の一覧は未再現**（cursor は 4 行で手動指定）。

## 2. コードレビュー

- **(a) `jobRunner`**: 分岐は `failureOutcome(facts)` に閉じる。`stageRan`（この起床で段を実行した）→ 上限未満 backoff / 上限で `cleanup-exhausted:${forwardTokenOf(current)}`（`ConflictError` も backoff を使い切る。設計 (b) どおり）。前進 → `!exhausted && !isConflictError` なら backoff、それ以外は確定: `currentReason === null && hasStage()` → **enter-terminal**（`UPDATE jobs SET status='pending', attempt=0, terminal_reason=?, next_run_at = now + backoffDelayMs(0), lease_until=NULL, owner_token=NULL WHERE operation_key=? AND owner_token=?` — `completed_at` を書かない、待ちを挟まない）/ それ以外 → `finalizeRow(..., "failed", reason)` で `poison`（終端モードの行は現在の理由で差し替え。`finalizeStatement` の `COALESCE(?, terminal_reason)` に非 null を渡す）。結果側: `finished` は `commit?.(sql)` を `finalizeRow` と同じ `transactionSync` で走らせ `null` を渡すので理由が残る（`done`）、`poison` 結果は `stage === null` なら `SystemError(UnclassifiedError)` に読み替えて失敗扱い（前進 handler が材料喪失を宣言できない）、段からの `poison` は `attempt` によらず `cleanup-material-lost:${forwardTokenOf(row.terminal_reason)}`。`rearm` / `yield` は `releaseWithBackoff` / `releaseForNextWakeUp` で `terminal_reason` に触れない。段の選択は `row.terminal_reason !== null ? selectTerminalStage(row, sql) : null`、`?? registry[kind]` の 2 段。`alarm()` は (1) rearm → (2) ゲート（失敗時は `setAlarm(now + failClosedRearmIntervalMs)` して return、`deleteAlarm` しない）→ relay → jobs → prune → rearm の各段を個別に catch し、投げない。`terminalReason()` は `operationId === null ? token : `${token} ${operationId}``、`forwardTokenOf` は解釈不能を `forward-exhausted` に倒す（RC-9 を破らない）。
- **(b) 後始末**: `signupCleanup.ts` S1 = PK（`kind`, `hmac`）で読み `credential_id !== locator.credentialId` → `poison(material-lost)`（`user_id ?? candidate_user_id` が NULL でも同じ扱い。spec の 2 類に無い 3 つ目の条件 — O-2）→ S2 `USER_DATA.abandonAccount({ operationId, callerToken })` → `already-completed` は `finished`（commit 無し = 何も消さない）→ S3 `locators.filter(credentialId !== coordinator)` を要素ごとに（自 bucket は `cancelLocally` をローカル `transactionSync`、他は `cancelReservation` RPC。1 つでも throw で backoff）→ S4 は `finished.commit` に `cancelLocally(locator, callerToken)`（`DELETE … WHERE kind=? AND hmac=? AND credential_id=? AND caller_token=?` + その `credential_id` の `password_reset_tokens` 全削除）を載せ、runner の `done` と同 tx。順序 S2 → S3 → S4 はコード順で固定。`abandonAccount.ts` は (1) を facade（`isInitialized` をゲートの**前**に評価 — spec の「ゲートを通ったうえで」とは順序が逆だが、`allowInitialize: false` の DO では未初期化を通せるゲートが無いので同値。書き込み 0 は integration で確認）、(2) `status !== 'active'` → `abandoned`、(3) `CALLER_TOKEN_MIN_LENGTH` 未満 / NULL / 長さ差 / XOR 不一致 → `SystemError(ConfigurationError)`（M-3）、(4) `operations WHERE operation_id=?` 無し or `kind !== 'signup'` → `nothing-to-abandon`、(5) `phase === 'done'` → `already-completed`、(6) `accountStore.beginDeletion()`（`WHERE status='active'`、`session_epoch + 1`）+ `enqueueJob({ operationKey: "finalize-withdrawal", kind, payload: {} })` を `runUnitOfWork` の 1 tx で。`linkCleanup.ts` L1 = `operation_id` + `kind='link'`、無し → material-lost、`done` → `finished`、`account.caller_token` NULL → `finished`（退会完走後）、L2 全要素へ `cancelReservation`、L3 `UPDATE operations SET phase='done' WHERE … AND phase != 'done'` を commit（0 行も成功、`target_locators` 不変）。`credentialChangeCleanup.ts` C1 = commit で `pending_verifier / change_state / change_origin / operation_id = NULL WHERE kind=? AND hmac=? AND change_state='pending' AND operation_id=?`（RPC なし）。段の実在判定 `credentialChangeHasCleanup` は `change_state='pending' AND operation_id = payload.operationId` を要求する（spec は `'pending'` のみで C1 の CAS が 0 行）— 後勝ちで差し替えられた行は「段なし」→ 前進が走り、前進の先頭で `operation_id` 不一致 → `finished` → `done` になるので結果は同じ（O-3）。`finalizeWithdrawal.ts`: `status !== 'deleting'` → `finished`；duty (2) `operations WHERE kind IN ('link','unlink') AND phase != 'done'` の各行の `target_locators` 全要素へ `cancelReservation` → 行ごとに `phase='done'`；`credential_locators` 全行へ `deleteMapping`（bucket は locator の世代 / index）；最終 tx（`provider().run`）で `credential_locators` 全削除、`ai_client_connections` を `revoked`（`version + 1`）、`oauth_consumed_codes` 全削除、`account SET status='deleted', caller_token=NULL, deleted_at, session_epoch+1 WHERE status='deleting'`。メモ・トピック・文書・`search_*`・`operations` には触れない。段なし（User Data の `terminalStage` は `resume-link` だけ）なので確定は即 `poison`。投入点は `abandonAccountProcedure` の `enqueueJob` だけ（`beginWithdrawalProcedure` は未作成 — △-3 の「用意するにとどめる」も未実施だが利用者向け退会は範囲外なので閉じている）。`operation_key` は定数 `FINALIZE_WITHDRAWAL_OPERATION_KEY`。`cancelReservation` ストア（PH-06）は CAS が `kind / hmac / credential_id / caller_token`（`status` / `operation_id` を含まない）で `password_reset_tokens` を同 tx で消し、`callerToken` が規定長未満なら何もせず成功。
- **(c) 全 kind への影響**: ジョブ経路で `ConflictError` が発生しうる箇所は `callDurableObject` が envelope から再構成するもの（`initializeAccount` → `operationsStore` の `OPERATION_PAYLOAD_MISMATCH`）と DO 内の `enqueueJob`（`jobWriter` の `JOB_PAYLOAD_MISMATCH`）だけ — どちらも digest 不一致で恒久なので即確定は正しい向き。`credentialMappingStore:163`（`EMAIL_ALREADY_REGISTERED`）は予約 = request 経路のみ、`credentialChangeSaga.ts` の `OPTIMISTIC_LOCK_FAILURE` は request 側の saga で、`resumeCredentialChange.ts` は 0 行を `SystemError(DataIntegrityError)` で投げる（backoff → 上限）。`purge-trash` は `pruneExpiredTrashItems` が OCC 競合を item 単位で先送り（`yield`）するので runner に届かない。`sweep-*` は生 SQL。`resume-link` / `resume-signup` の前進 handler に `ConflictError` の throw は無い。したがって PH-06 の 4 kind の挙動差は「`terminal_reason` が error code → `forward-exhausted <op>`」のみ（`jobTerminal` 更新済み）。`resume-credential-change` の上限は従来 `poison` → 今は `'pending'` なら終端モード → C1 → `done`、`resume-link` の上限は L1〜L3 → `done`（同 suite で固定）。
- **(d) operator 経路**: `OPERATOR_ENTRIES` 10 entry、`targets` は `BOTH` / `["directory"]`。順序: token 未設定 or 32 文字未満 → 404 → entry 不明 → 404 → `POST` 以外 405 → `Authorization: Bearer` を SHA-256 digest 同士の定数時間比較（不一致 401、body 無し）→ JSON / object 400 → locator（`dir:g\d+:b\d+` は `buckets`（既定 g1 × `INITIAL_DIRECTORY_BUCKET_COUNT`）の範囲内、`userId` は UUID 形式）と `entry.targets` → zod schema → `callDurableObject` → `{ ok: true, result }` / `{ ok: false, error: serializeError(error) }` + `httpStatusFor`。監査は `logger.info("operator", { entry, locator, id?, outcome })` で応答本文を写さない（`id` は `eventId` / `operationKey` / `userId`）。`DIAGNOSTICS_ENABLED` の参照なし（grep 0 件）。`server.cloudflare.ts` は `/__diagnostics/` の直後、SSO / AI / export より前に `isOperatorRoute` を先取り。facade: `listPoisonedJobs` は `(completed_at, operation_key)` keyset、`limit + 1` 件で `nextCursor`、`requeuePoisonedJob` は 4 列 + `WHERE status='poison'` → matched なら `rearm`、`deletePoisonedJob` / `deleteQuarantinedEvent` は `DELETE … AND status='poison'|'quarantined'` で `rearm` なし、`readDeliveryBacklog` は `pending` / `publishing` の count と `min(created_at)`。`purgeUserMappings` は `credential_mappings.user_id = ?` の行（`reserved` 行は `user_id` NULL なので対象外 = spec の「`candidateUserId` しか持たない予約行には届かない」と一致）とその `credential_id` の `password_reset_tokens` を 1 tx で消して件数を返す。**405 が 401 より前**なので未認証の GET で entry の存在（405 / 404）が分かる（O-4、entry 名は docs 公開なので実害なし）。
- **(e) DLQ**: `handleDlqBatch` は各メッセージを `deliverOnce`（consumer と同じ関数）→ `sent | nothing-to-send | unserved | "failed"` → `logger.warn("dlq", { eventId, type, outcome })` → `message.ack()`（例外は握る）→ `batch.ackAll()`。`retry()` は無い。`createQueueContainer` 失敗時も DLQ は `failed` で全 ack。メッセージ全体・`ownerToken`・`payload` はどのログにも出ない（unit が `"o".repeat(32)` の非出現を固定）。
- **(f) fail-closed**: `enterRpc()` が全 operator entry と `runUnitOfWork` の先頭でゲートを通す（`readSchemaVersion` だけ通さない。`listBucketUserIds` は通す — M-1）。`alarm()` の (2) で `runMigrationGate` が投げると `failClosedRearmIntervalMs`（300 s）で `setAlarm`、backoff 無し、`deleteAlarm` 無し。integration が `getAlarm()` ≥ `+295 s`、行 `pending / attempt 0` 不変、1 に戻して次の起床で `purge-trash` が `done` を固定。
- **(g) 秘密の帰属**: `.dev.vars.example` の帰属表に `OPERATOR_TOKEN — request Worker`、`wrangler secret put OPERATOR_TOKEN --config wrangler.staging.toml`、末尾に生成方法（`openssl rand -base64 48`、≥ 32 文字、未設定なら 404、本番は Cloudflare Access が前段）。`wrangler.{staging,production}.toml.tpl` の secret 一覧に 1 行。`wranglerConfig.test.ts` が「帰属表に request Worker」「request 2 config に `secret put`」「6 config のどれにも `OPERATOR_TOKEN =` の `[vars]` 無し」を固定。`ServerEnv.OPERATOR_TOKEN?`（request）、`StateWorkerEnv` には無い。
- **(h) ban list / lint**: 新しい `class … Error` 無し（`SystemErrorCode` の追加も無し）。`lint/` に変更なし。lint warning 3 は既存。`banList.test.ts` / `pluginWiring.test.ts` は 2 回目の全走で緑。
- その他: `DeliveryTuning.listPoisonedJobsLimit = 50`、`delivery/types.ts` に 4 型、`jobKeys.FINALIZE_WITHDRAWAL_OPERATION_KEY`。`abandonAccount` / `purgeUserMappings` / `listPoisonedJobs` / `requeuePoisonedJob` は `IdentityGateway`（`application/identity/gateway.ts` / `identityGateway.ts`）に無い（grep: DO 2 クラス + `signupCleanup.ts` + `operatorHandlers.ts` のみ）。

### 指摘（不具合 / 逸脱）

- **B-1（M-1）**: `list-bucket-user-ids` が fail-closed bucket で `SCHEMA_VERSION_AHEAD`。再現: dev 停止 → `sqlite3 <b12>.sqlite "UPDATE _meta SET schema_version = 99"` → 起動 → `node scripts/operator.ts list-bucket-user-ids --locator dir:g1:b12` → 期待（spec）`{ ok: true, result: [] }`、実際 `500 { ok: false, error: { code: "SCHEMA_VERSION_AHEAD" } }`（19:58:10、`dev9c.log`）。`read-schema-version` は `{ schemaVersion: 99 }` を返す。
- **O-1（低）**: `finalizeWithdrawal.ts` の最終 tx は `account` を生 SQL で更新し `AccountStore` を経由しない（`version` を進めない、`session_epoch` を `beginDeletion` に続けてもう 1 回進める）。`ai_client_connections` は `version + 1` を書く。`provider().run` を tx の入れ物としてだけ使い `ctx` は `void`。spec 違反ではないが、`account` は OCC の集約ルートなので `version` の不整合が読み手（`readAccountState`）に見える可能性がある。
- **O-2（低）**: S1 で `user_id ?? candidate_user_id` が NULL のとき `material-lost` に落とす。spec の材料喪失 2 類（行が無い / `credential_id` 不一致）に無い条件で、正常系では起きないが、起きたときの `terminal_reason` は「材料喪失」で運用者の行動（明示削除）を誘導する。
- **O-3（情報）**: `credentialChangeHasCleanup` が `operation_id` 一致を段の実在条件に含める（spec は C1 の CAS 側に置く）。結果は同じ（前進が 0 行で `done`）。
- **O-4（情報）**: HTTP 面で 405 の判定が 401 より前。
- **O-5（情報・既存）**: `resumeLink.ts` の前進に `account.status != 'active'` の判定が無い（spec は「既存規則」として前提にする）。突入前の退会競合は `finalize-withdrawal` の duty (2)（`phase='done'`）と L1 の `caller_token NULL → finished` が閉じるので、実害は無い。
- **O-6（情報）**: `aiConnectionsList.dom.test.tsx` の flaky（§1）。
- **O-7（情報）**: `operatorEntries.integration.test.ts` の「reserved or active」は `active` 行 1 件しか置いていない（`reserved` 行は `user_id` NULL なので `purge-user-mappings` の対象外。テスト名だけの不一致）。

## 3. 実走（自分で実行、dev = :3000、preview = :4173）

環境: 両方停止していたので `pnpm dev`（19:49）/ `pnpm build`（exit 0）→ `pnpm preview`（19:51）を自分で起動。agent-browser `verify09`（`verify09a@example.com` / `verify09pass!` を新規登録）、`verify09b`（purge 後の再登録、`verify09pass2!`）。operator CLI は `apps/web` で `node scripts/operator.ts <entry> --locator … [--json …] [--base …]`（`.dev.vars` の `OPERATOR_TOKEN`、58 文字）。sqlite のシードは dev / preview を止めて行い、都度再起動（4 回）。稼働中の DO ファイルは `-readonly` で開けず、`immutable=1` は WAL を反映しないので、DB の確定値は停止中にだけ読んだ。ログ: `scratchpad/dev9a〜9f.log`、`preview9c/9e/9f.log`。

### 3.1 HTTP 面（19:52:22）

| 操作 | 期待 | 結果 |
|---|---|---|
| `POST /__operator/read-schema-version` に `Authorization` なし / 誤 token | 401 | 401 / 401 |
| `GET /__operator/read-schema-version`（正 token） | 405 | 405（`allow: POST`） |
| `POST /__operator/nope` | 404 | 404 |
| locator `dir:g1:b99` / `dir:g2:b0` / `not-a-locator`、`list-bucket-user-ids` に userId | 400 | 400 `{"error":"locator is not one this entry accepts"}` |
| body が JSON でない | 400 | 400 `{"error":"The body must be JSON"}` |
| `requeue-poisoned-job` に `operationKey` なし | 400 | 400 `{"error":"Invalid arguments","issues":[…]}` |
| `.dev.vars` の `OPERATOR_TOKEN` をコメントアウトして再起動（19:56:32）→ 正 token で POST / GET | 404 / 404 | 404 / 404。その後 `.dev.vars` を復元（backup と `diff` 一致）して再起動 |
| preview: 誤 token → 401、`read-schema-version dir:g1:b0` → 200 `{ schemaVersion: 1 }`、GET → 405 | | すべて期待どおり（19:52 / 19:58:47） |

### 3.2 poison 行（dev、`01a085cc…` = verify09a の User Data DO）

停止中に `jobs` へ `ph09v-poison-1`（`sweep-orphan-mapping`、`attempt 5`、`forward-exhausted`、`completed_at` = −60 min）と `ph09v-poison-2`（`cleanup-material-lost:forward-conflict 01a0-verify-op`、−30 min）を INSERT（19:56:24）。

| 時刻 | 操作 | 結果 |
|---|---|---|
| 19:57:58 | `list-poisoned-jobs` | 2 行、`completedAt` 昇順（poison-1 → poison-2）、列は `operationKey / kind / attempt / completedAt / terminalReason` の 5 つ、`payload` なし、`nextCursor: null` |
| 19:58:01 | `requeue-poisoned-job ph09v-poison-1` | `{ requeued: true }`。3 秒後の一覧から消えている（前進が走って `done`）。停止後の sqlite: `ph09v-poison-1 | done | attempt 0 | terminal_reason 'forward-exhausted' | completed_at 19:58:01`（理由保持、`done`） |
| 19:58:05 | `delete-poisoned-job ph09v-poison-2` ×2 | `{ deleted: true }` → `{ deleted: false }` |
| | `requeue-poisoned-job nope` | `{ requeued: false }` |
| | 監査ログ（`dev9c.log`） | `operator { entry, locator, id, outcome: 'ok' }` のみ。本文・`terminalReason` は無い |

### 3.3 quarantined 行と `purge-user-mappings`（bucket `dir:g1:b0`）

停止中に `outbox_events` へ `ph09v-q1` / `ph09v-q2`（`identity.passwordResetRequested`、`quarantined`、`PUBLISH_FAILED`、`owner_token 'ph09v-old-owner'`）を INSERT。

| 時刻 | 操作 | 結果 |
|---|---|---|
| 19:58:05 | `list-quarantined-events` | 2 行（q1 → q2）、6 列（`eventId / type / attempt / createdAt / completedAt / terminalReason`）、`payload` / `owner_token` / `aggregate_id` なし |
| 19:58:05 | `requeue-quarantined-event ph09v-q1` | `{ requeued: true }` → 4 秒後の一覧は q2 だけ、`read-delivery-backlog` は 0 / 0 / null、dev ログ `QUEUE tanstack-start-template-events 1/1 (16ms)`（consumer が `nothing-to-send` で ack。トークン行が無いので `[dev-mail]` は出ない = 期待どおり）。停止後の sqlite: `ph09v-q1 | published | owner_token 1858480b…（再採番）| terminal_reason PUBLISH_FAILED（保持）` |
| 19:58:09 | `delete-quarantined-event ph09v-q2` ×2 | `true` → `false` |
| 19:59:00 | `purge-user-mappings dir:g1:b0 { userId: 01a085cc… }` ×2 | `{ deletedMappings: 1, deletedTokens: 1 }`（19:53 のリセット依頼で発行されたトークン行が消えた）→ `{ 0, 0 }`。`list-bucket-user-ids b0` から当該 `userId` が消える |
| 19:59:58 | `verify09b` で `verify09a@example.com` を再登録 | `/` へ。b0 に新 `userId 01a085d3…` が現れ、その `resume-signup` は `done`（20:00:58、理由 NULL） |
| 19:59:20 | purge 後の `verify09`（旧セッション）で `/settings` | 「読み込めませんでした / エラーが発生しました」、ログアウト導線なし、`/signup` は `/` へリダイレクト（M-2） |

### 3.4 fail-closed（User Data `01a080a1…` と bucket `dir:g1:b12`、後で `dir:g1:b14`）

| 時刻 | 操作 | 結果 |
|---|---|---|
| 19:56:24 | 停止中に `_meta.schema_version = 99`（2 DO） | |
| 19:58:10 | `read-schema-version` | `{ schemaVersion: 99 }`（両方） |
| | `list-poisoned-jobs` / `read-delivery-backlog` / `requeue-poisoned-job` / `list-quarantined-events`（user）、`list-bucket-user-ids` / `list-poisoned-jobs` / `purge-user-mappings`（b12） | すべて `500 { ok: false, error: { kind: "system", code: "SCHEMA_VERSION_AHEAD", retryable: false } }`。監査 `outcome: 'SCHEMA_VERSION_AHEAD'`。preview でも同じ（19:58:47） |
| 20:00:43 | 停止中に 1 へ戻す → 起動 | `list-poisoned-jobs` / `read-delivery-backlog` / `list-bucket-user-ids` が通常応答（20:00:58） |
| 20:00:47 | b14 を 99 にし `pending` の `sweep-reservations` 行（`next_run_at` 過去）を INSERT、`metadata.sqlite` の `_cf_ALARM` に +4 s の Alarm を手で書いて起動 | workerd が「SQLite alarm handler canceled with requestScheduledAlarm … localAlarmState = 0ns」で手書きの Alarm を無効化し `alarm()` は走らなかった。RPC は `SCHEMA_VERSION_AHEAD`、行は `pending / attempt 0` のまま不変（20:03:23 に確認）。**Alarm の固定間隔再武装は dev で観測できず**（15 分内に武装させる手段が無かった）。integration `operatorEntries`「fail-closed」ケース（`getAlarm()` ≥ +295 s、行不変、1 に戻して `purge-trash` が `done`）で固定されている。b14 は 1 に戻し seed 行を削除 |

### 3.5 DLQ（dev、20:04〜20:06）

User Data DO `01a085cc…` に `quarantined` の outbox 行 `ph09v-dlq` を停止中に INSERT → 起動 → `requeue-quarantined-event`（20:04:17）→ relay が publish（routing key = `userId` なので consumer は `unserved`）→ `Unserved event { eventId, type }` ×4 と `QUEUE … 0/1` ×4 → `Moving message … to dead letter queue "tanstack-start-template-events-dlq" after 4 failed attempts` → **`dlq { eventId: 'ph09v-dlq', type: 'identity.passwordResetRequested', outcome: 'unserved' }` → `QUEUE tanstack-start-template-events-dlq 1/1 (24ms)`**（20:06:52）。ログにメッセージ本体 / `ownerToken` / `payload` は出ない。DO 側の行は `published` のまま。

## 4. 受け入れ済み PH-01〜08 の 33 項目への影響

- `git diff 28653c9..b93173c --stat`: 変更は `jobRunner.ts`（`JobHandlerResult` に `poison` / `finished.commit` を**追加**、`runJobsPass` の `terminalStage` は任意引数、既存 handler は無変更で通る）、`durableObjectBase.ts`（メソッド 5 本と `terminalStage` 設定の**追加**のみ。`alarm()` の段の順序は不変）、両 DO クラス（コンストラクタに `terminalStage`、facade 追加）、`queueHandlers.ts`（`deliverOnce` の切り出し + `handleDlqBatch(batch, container)`。呼び手は `runQueueBatch` だけで、`handleEventsBatch` の 5 unit は不変で緑）、`server.cloudflare.ts`（`/__operator/` 先取り 1 分岐。`/__diagnostics/` / SSO / AI / export とプレフィックスが重ならない）。ルート・コンポーネント・usecase・ゲートウェイ・スキーマ plan・`alarmSchedule` / `outboxRelay` / `rowRunner` に変更なし。
- 全 kind に効く変更は「`terminal_reason` の値域」と「`ConflictError` 即確定」の 2 つで、§2(c) のとおり PH-06 の 4 kind で挙動差は語彙のみ、他の kind にジョブ経路の `ConflictError` は無い。
- 再実行: **R-AC-01** — `verify09a@example.com` を登録（19:53:06）→ `/` に着地、User Data の `operations(signup) = done`、b0 の `resume-signup:01a085cc…` が 19:54:07 に `done`（`terminal_reason NULL`、attempt 0）。再登録分も 20:00:58 に `done`。**R-AC-07** — `/password-reset` で依頼（19:53:40）→ `?sent=1` → relay → Queue → consumer → `[dev-mail] to=verify09a@example.com url=…?token=…` + `QUEUE … 1/1`（19:54 までに）。**R-TR-04** — メモを投稿してゴミ箱へ（19:55）→ 停止中に `trashed_at −40 日 / purge_after −10 日` と `purge-trash.next_run_at` を過去に → 再起動後、2 つ目のメモをゴミ箱へ入れて再武装（19:58:34）→ ゴミ箱には 2 つ目だけ、停止後の sqlite で 1 つ目の `memos` 行が無く `memo_revisions` は 2 つ目の 1 件、`purge-trash` は `pending`（次の期限に再武装、`terminal_reason NULL`）。
- 2 回目の `pnpm test` 全走（integration 27 files / 160）で PH-01〜08 の suite はすべて緑。

## 5. Implementer の判断事項 4 点

M-2 / M-3 / M-4 / M-5 に書いた。要約: (1) active アカウントへの `purge-user-mappings` は再現し、P-13 が壊れてログアウトも描かれないので docs だけでなく degrade か issue を勧める、(2) `ConfigurationError` は挙動上は問題ないが code の意味が実体と合わない、(3) `terminal_reason` の形は spec 反映済みでコードと一致、(4) docs §8 / §10 は実装と逆方向に古く、PH-09B 前の更新か issue が要る。

## 追加観察（完了条件外）

- `purge-user-mappings` 後の旧 DO `01a085cc…`（ファイル `8db31e94…`）は `account.status = 'active'` / `credential_locators` 1 行のまま残り、bucket 走査から到達できない。dev の残渣として残してある（spec が「発見不能な残渣」と呼ぶ状態の実物。必要なら `.wrangler/state` ごと捨てる）。
- `signupCleanup` の S3 は自 bucket 宛を RPC にせずローカルで消す（設計差分 (c)）。`cancelReservation` ストアには「コーディネーター行を消したら対応する `resume-signup` 行を `done` にする」PH-06 の副作用があるが、S4 は生 SQL なのでこれを踏まない（踏んでも `done` は runner の `done` と衝突しない）。
- `listPoisonedJobs` の `completed_at ?? 0` は quarantine 一覧と同じ限界（JSDoc あり）。
- 監査ログの 4 項目目は `id`（`eventId` / `operationKey` / `userId` を畳む）。docs §8.2 (c) の「`eventId` for the entries that take one」より広い。

## 検証環境の引き継ぎ状態

- dev（:3000、`dev9f.log`）/ preview（:4173、`preview9f.log`、build は HEAD）とも起動中。停止は `lsof -t -i :3000 -i :4173 | xargs kill`。
- agent-browser: `verify09`（purge 済み旧アカウントのセッション。P-13 がエラーになる状態のまま）、`verify09b`（`verify09a@example.com` / `verify09pass2!`、新 `userId 01a085d3…`、b0）。
- DO 状態: 全 39 DO の `schema_version = 1` に復元済み。seed の残り: `01a085cc…` の `jobs` に `ph09v-poison-1`（`done`）、`outbox_events` に `ph09v-dlq`（`published`）、b0 の `outbox_events` に `ph09v-q1`（`published`）— いずれも保持期間後に prune される。`ph09v-poison-2` / `ph09v-q2` / b14 の `ph09v-fc` は削除済み。
- `.dev.vars` は backup（`scratchpad/dev.vars.backup`）と `diff` 一致。追跡ファイルに変更なし。
- ログ / 中間ファイルは `scratchpad/`（`checks9a.log`、`test9a-run2.log`、`build9a.log`、`dev9a〜9f.log`、`preview9c/9e/9f.log`、`buckets-*.txt`）。
