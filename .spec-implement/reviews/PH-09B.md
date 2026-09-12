# PH-09B 検証報告（Verifier、2026-09-11 02:10〜02:22 JST）

対象 HEAD `5667348`（`3c79194` = PH-09A の M-1 / M-2 / M-3 対応、`a4c7129` core / `3206c06` web / `6c75d84` テスト / `5667348` fix。Manager の spec `6c08553` / `1b708f4`）。`6c08553..5667348` は 63 ファイル +5,997 / −182。作業ツリーは追跡ファイル clean。実装コード・`spec/`・管理ファイルは変更していない（`.dev.vars` は手順どおり書き換え、引き継ぎ状態は末尾）。

## 判定

| ID | 判定 | 根拠（詳細は下） |
|---|---|---|
| R-ROT-01 写像鍵の移送 + `rotate-encryption` | **合格** | dev で g2 → g3 の 2 世代手順を最初から再現した（§3）: keyring + コミットメントの対デプロイ → 既存ユーザーが previous プローブでログイン（02:14:16）→ 並存中の新規登録が g3 に着地（g3:b14）→ 並存中のリセット依頼が previous 側で完結し `[dev-mail]`（token `2.7.…`）→ `remap-chunk` × 16（1 チャンク 96〜108 ms、processed 29 / skipped 0 / conflicts 0、`lastCredentialId null`）→ `read-rotation-checkpoint {remap, 2}` 全 16 `previousCount 0`、g2 の `list-bucket-user-ids` 全 0 / g3 30 → 移送済みユーザーの再ログイン（active プローブ）→ previous 除去で `dir:g2:b0` は 400、ログイン可、`start-rotate-encryption` は暗号 previous 無しで拒否 → 暗号 keyring 2 世代で `start-rotate-encryption` × 16（全 `{ retiringGeneration: 2 }`）→ 12 秒後 `read-rotation-checkpoint {encryption, 2}` 全 0、`poison` 0 → 暗号 previous 除去でログイン可 + 移送前のメモが読める + P-13 にメール + 新規登録可 + リセットメール（token `3.3.…`）+ `start-rotate-encryption` 再拒否。負のケース（役割入れ替え / 偽鍵 / 世代不一致 / active を移送元 / `limit` 無し / 直列化）はすべて拒否され checkpoint は `null` のまま。dev / preview の全ログに鍵・digest・64 hex HMAC・verifier の出現 0。コードは spec の s1〜s6 / CAS 2 述語 / 正本判定 5 分岐 / 4 点照合 / 退役証明の無効化 / 直列化 / UPDATE 条件 / lookup 順序 / no-op 確定に一致（§2）。keyRotation.md 40 行のうち 35 行を固定、5 行は部分固定または該当経路なし（§1） |
| PH-09A M-1 / M-2 / M-3 対応 | **妥当** | M-1: `listBucketUserIds` が `enterRpc()` を呼ばず `isInitialized` で `[]`（dev: `read-schema-version dir:g3:b0` = `null` の未初期化 bucket に対しても診断が答え、初期化しない）。M-2: `SettingsFeed` が `guardStreamedRender` を 2 段に分け、読み失敗を `SettingsUnavailable`（`role=alert` + `LogoutButton`）に落とす。redirect / notFound は素通し。DOM 4 件。M-3: `DataIntegrityError` に変更、JSDoc に理由 |

**R-ROT-01 合格。** PH-01〜09A の 35 項目への影響なし（§4）。

### Manager の判断が必要な事項

- **M-1（判断事項 (5) `IMPORT_ROWS_PER_CALL = 3`）**: `floor(100 / (25 + 2)) = 3` はコードと一致し（`mappingRows.ts`、`SQL_MAX_BIND_PARAMETERS = 100`、列 25 + 条件付き INSERT の bind 2）、`5667348` で HTTP 面が `max(IMPORT_ROWS_PER_CALL)` に揃い unit が 3 行 200 / 4 行 400 を固定。△-18 の「4」は `phases/PH-09.md` B-1 §4.4 s4 の記述（「24 列」「4 行」）だけが古い。判断は閉じている
- **M-2（引き継ぎ `.dev.vars`）**: 指示は「変えたら元に戻す」だが、g2 → g3 を回した結果 DO の行は写像 g3 / 暗号世代 3 になっており、バックアップ（`scratchpad/dev.vars.9b-phase4.bak` = g2 のみ）に戻すと dev の全ユーザーが到達不能になる。**現状は g3 の phase 4（3 変数とも active g3 のみ）で残した**（DO 状態と整合。g3 の鍵は `scratchpad/rot9b-keys.json`。バックアップ + DO 状態の作り直しで g2 に戻せる）。この扱いでよいか
- **M-3（軽微・spec との差）**: no-op 確定の単位。spec は「退避座標の各世代について削除が確定したとき」と世代ごとに読めるが、`deletionRoundConfirms` は 1 巡を丸ごと判定する（2 世代を含み 1 つでも no-op なら全座標を再発行）。安全側で挙動差は再発行の 1 回だけ。据え置きでよいと考えるが、spec の文言と合わせるなら注記が要る
- **M-4（PH-09A M-5 の持ち越し）**: `docs/runtime_cloudflare.md` は今回も無変更（§8 / §10 は「未実装・到達不能」のまま、rotation の 5 entry も「no」）。PH-10 予定のままなら、少なくとも issue を立てて「docs が実装より古い」状態を追跡してほしい

## 1. 自動テスト（自分で実行）

`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` を HEAD `5667348` で（`scratchpad/checks9b.log`、02:10:07〜02:10:31）: すべて exit 0（lint warning 3 は既存）。unit+dom **126 files / 1,586 passed + 2 skipped**、integration **32 files / 188 passed** — 報告と一致。R-REC-01 の 3 suite（`recovery` / `jobTerminal` / `operatorEntries`）を単独再実行: 3 files / 21 passed（02:21:46）。

### keyRotation.md 40 行の対応（B-3 の実績の確認）

テスト名と assertion を読んで確認した（`rotation.integration` 921 行 / `rotationLifecycle` 438 行 / `rotateEncryption` 323 行 / `lookupGeneration` 300 行 / `migrationGate` 231 行 / unit 4 ファイル）。

- 固定（35 行）: 1（unit 6 形 + integration の役割入れ替え `forged(ACTIVE, { role: "previous" })` 361 行目）、2 / 33、3 / 29、4（3 条件個別 + `rotateEncryption` の暗号 previous）、5 / 19、6 / 7（`password_reset_tokens` 同 tx 削除 282 行目）/ 21（`readCurrentUser` 不変 306 行目）/ 25（予約直後の `caller_token` と暗号列 212〜215 行目）/ 39（`record` の max 317 行目）、8 / 9 / 32、10 / 24（`rotationLifecycle` 286 / 342 行目。24 は 2 世代 no-op の再発行 → `done`）、11〜14 / 23、15、16 / 35 / 36 / 40（040 は plain object の stub ラッパで probe 順 g2 → g1 → g2 を観測）、17 / 31、18 / 30（unit `retirement`）、20 / 27（巻き戻し + import / 再予約の checkpoint 削除 + `rotateEncryption` の `(encryption, i, active)` 削除）、22（unit `rotationCheckpointWriters` = `rotation_checkpoints` を書く SQL は store と DDL だけ + 本報告 §3.6 のログ検査）、34
- **部分固定（4 行）**: 28（entry-level 拒否で s6 未記録までは固定。チャンク途中の DO リセットは再現不能）、37（「既に active 世代の行は選ばれず不変」まで。読み書き間の割り込みは再現不能）、38（unit `transfer.test.ts` が `authenticationStateUnchanged` の 4 列を固定。割り込みそのものは再現不能）、22 の「RPC の引数・戻り値ロギングを有効化する構成の禁止」はレビュー項目（wrangler config 6 本に `[observability]` / ロギング設定は無い。PH-09A 報告どおり）
- **該当経路なし（1 行）**: 26（△-16。`6c08553` で spec が「世代ガードは request 経路のみ」に改訂済み。コードにも `GENERATION_MISMATCH` は無い）

## 2. コードレビュー

- **(a) keyring / コミットメント**: `mappingKeyringFromEnv(json, single)` は JSON 配列（zod: `role` / `generation ≥ 1` / `key` / `bucketCount`）→ `createMappingKeyring`（active ちょうど 1 / previous ≤ 1 / 世代重複なし / 鍵 ≥ 32 文字 / bucketCount は 2 の冪）、未設定なら単一変数から `{ active, g1, 16 }`。配列設定時は単一変数を読まない（unit 209 / 219 行目）。`encryptionKeyringFromEnv` も同形（DO 内なので `SystemError(ConfigurationError)`）。`keyCommitmentFromEnv` は未設定で `null`（ガード恒等）、設定時は `[{ role, generation, keyDigest(64 hex), bucketCount }]`。`verifyKeyEntryAgainstCommitment(entry, commitment, expectedRole)` は `committed = find(role === expectedRole)` を取り、`entry.role === expectedRole` / `generation` / `bucketCount` / `keyDigest`（SHA-256 hex の定数時間比較）の 4 点をまとめて 1 つの `ConfigurationError`（内容を名指さない）。エラー文は変数名だけで値を含まない。Directory DO は keyring / コミットメントを毎回 env から読み、インスタンスにも SQLite にも持たない（C2）。`operatorBuckets(env)` が keyring の全世代の `{ generation, bucketCount }` を locator 検査に渡す
- **(b) 移送 s1〜s6**: `runRemapChunk` — (i) `commitment === null` → 拒否、active / previous を 4 点照合、(ii) `bucket.generation !== previous.generation` → 拒否、(iii) 暗号 keyring に previous / `encryption_generation != active` の行あり / `done` でない `rotate-encryption` 行あり → 拒否。s1 `selectMappingRowsAfter(after, limit)`（`credential_id` 昇順、exclusive cursor）で `status !== 'active' || changeState !== null || userId === null` → skipped。s2 `openCanonical` → `deriveLocator(active)`（tx 外）。s3 `record-remapped-locator`（`callerToken` = 行の値、`usableForLoginOf(kind, passwordVerifier)`、`credentialLabelOf(kind, canonical)`）→ `skipped` なら次へ。s4 `readMappingRowByKey` で読み直し `authenticationStateUnchanged`（`status` / `changeState` / `credentialVersion` / `passwordVerifier`）でなければ skipped → `importRow` 1 行 → `e` は conflict、`rejected` は skipped。s5 `deleteSourceRowIfUnchanged`（述語 2 = `status='active' AND change_state IS NULL AND credential_version = s1 の値`、`password_reset_tokens` 同 tx）。s6 `rotationCheckpointStore.replace({ remap, index, 自世代, previousCount = count(*), 衝突 3 列 = チャンク snapshot })`。行単位の例外は catch して skipped + `credentialId` のみログ。`importRemappedMappings` — (i) 照合、(ii) `bucket.generation !== active.generation` → 拒否、行数 > 3 → `ValidationError(TOO_MANY_ROWS)`、行ごと (iv) `encryptionGeneration !== active` → `rejected`、(iii) 復号 + 再 HMAC = 行の `hmac` かつ index = 自 index かつ `row.generation === active` でなければ `rejected` → UoW 内で `judgeCanonicalRow`（null → a / userId 不一致 → e / version 比較 b・c・d）、(a) は `INSERT … SELECT … WHERE NOT EXISTS` の条件付き INSERT で外れたら再判定（2 pass）、(c)(d) は述語 1（`status='active' AND change_state IS NULL AND credential_version = 移送先の読み出し値`）の CAS で 0 行なら `b` に縮退、書けたら同 tx で `(remap, index, active)` と `(encryption, index, 行の暗号世代)` を削除（(v)）。`recordRemappedLocatorProcedure` — `account` 無し / `caller_token` NULL・規定長未満 / 引数規定長未満 / 定数時間不一致 / `status !== 'active'` / `listByCredentialId` 0 件 → 一律 `skipped`、通れば `credentialLocatorStore.record`（`max(credential_version)` との `Math.max`、`ON CONFLICT (credential_id, generation)` upsert）。直列化ガードは `remap-chunk` (iii) と `startRotateEncryption`（コミットメントに previous → 拒否）の両向き
- **(c) lookup / 予約ガード**: `identityGateway.locate` は `keyring.entries`（probe 順 = active → previous）を回し、全外れで `activeKey` をもう 1 回（71〜87 行目）。`reserveCredentialProcedure` は `activeGeneration !== null && locator.generation !== activeGeneration` → `SystemError(ConfigurationError)`（呼び手は facade `reserveCredential` だけ。`activeMappingGeneration()` = コミットメントの active、未設定なら `null` で恒等）。通過時に `(remap, index, 世代)` と `(encryption, index, sealed の暗号世代)` を削除（退役証明の無効化）
- **(d) `rotate-encryption`**: `startRotateEncryption` は引数なし、コミットメントに previous → 拒否、暗号 previous 無し → 拒否、`enqueueJob({ operationKey: "rotate-encryption", payload: { retiringGeneration } })` → `runUnitOfWork` の `rearm`。handler は `jobsMaxChunkIterations` × `jobsMaxRowsPerChunk` で `encryption_generation != active` の行を読み、tx 外で `openCanonical` → `sealCanonical`（active）、tx 内で `UPDATE … WHERE kind=? AND hmac=? AND encryption_generation = <読み出した退役世代>`（0 行は完了）+ `(encryption, index, active)` 削除 + `(encryption, index, previous)` を残行数で置換。残 0 で `finished`、残あり `yield`。1 行も復号できないチャンクは `DataIntegrityError` → backoff → `poison`（判断事項 3）。退役条件 `isRetired(checkpoints, kind, generation, bucketCount)` は kind / generation で絞り `0..bucketCount-1` 全 bucket が `previousCount 0`（unit 4 件）
- **(e) no-op 確定**: `confirmDeletion` — 1 巡が単一世代または全部実削除なら即確定、2 世代で no-op を含めば `noopSince = now`（1 巡目の全発行完了時点）を記録して `reissue-after(at = now + 60 s)`、2 巡目は `now − noopSince ≥ 60 s` で確定。記録先は `operations.target_locators` 要素の `noopSince`（`sweep-orphan-mapping` は `updateOperation(phase 'deleting')`、request 側の `unlinkSsoCredential` は `finishUnlink({ noopSince })`）、退会は初回起床で `operations(operation_id 'withdrawal', kind 'withdrawal', phase 'deleting', target_locators = credential_locators の snapshot)` を `recordOperation` で作り、以後はその行を読む。`deleteNoopReissueDelayMs = 60_000` は JSDoc に「platform の上限を引用できない判断値」と限界を明記。`spec/database` `operations.kind` の `withdrawal` 記述（`1b708f4`）とコードは一致
- **(f) `reindex` / `migrate-bulk`**: `MigrationStep.bulk?: { name, run(sql, cursor, limit) }`、`migrateBulkStep(version, name)` = `migrate-bulk:<v>:<name>`、`operation_key` は `reindex:<targetVersion>` / `migrate-bulk:<targetVersion>`。`reindex` は `migration_progress(targetVersion, 'reindex')` の JSON cursor（`{type,id}` → memos → documents → `{done:true}`）で `reprojectMemo` / `projectDocument` を 1 行ずつ、チャンクごとに `setMigrationCursor` を同 tx。`migrate-bulk` は `version <= target && bulk` の step を順に `{at}` / `{done}` cursor で。integration `migrationGate`（テスト専用 plan v2 で RPC 経由 / `alarm()` 経由の 2 形: seed → Alarm → 完走 → 索引再構築 → bulk 1 回）。fail-closed は PH-09A の `operatorEntries` が固定（本フェーズで変更なし）
- **(g) operator HTTP 面 +5**: `start-rotate-encryption`（directory、`{}`）/ `remap-chunk`（`active` / `previous` = `keyEntrySchema`、`limit 1..500`、`afterCredentialId?`。監査 id = `afterCredentialId`）/ `import-remapped-mappings`（`rows` 1..3 の全列 schema）/ `record-remapped-locator`（user、`callerToken` + `credentialLocator`。監査 id = `credentialId`）/ `read-rotation-checkpoint`（`rotationKind` / `generation`）。`deps.buckets ?? operatorBuckets(env)` で退役世代の locator は 400（dev: `dir:g1:b0` → 400、退役後の `dir:g2:b0` → 400）。unit が「監査に鍵・verifier・暗号文・token・HMAC が出ない」を固定（339〜350 行目）、§3.6 のログ検査でも 0 件。CLI `--inject-keyring` は `.dev.vars` から読んで body に足すので鍵はコマンドラインに出ない
- **(h) M-1 / M-2 / M-3**: 上表のとおり。M-1 の副作用として `operatorEntries` / `alarm` / `schema` などの suite が bucket 初期化に `readDeliveryBacklog` を使う形へ変更（`3c79194` の diff）
- **(i) 秘密の帰属**: `.dev.vars.example` の帰属表に 3 変数（keyring = request、コミットメント / 暗号 keyring = state）、`secret put` の config 3 行、末尾に 3 変数の例と「対でデプロイ」「移送完了後に暗号 previous を足す」の注記。tpl（staging / production）に「ローテーション中だけ」の 3 行。`wranglerConfig.test.ts` が帰属表・`secret put` の宛先 config・6 config の `[vars]` 不在を固定。`ServerEnv.DIRECTORY_ROUTING_KEYRING?`、`StateWorkerEnv.DIRECTORY_KEY_COMMITMENT?` / `IDENTITY_MAIL_ENCRYPTION_KEYRING?`
- **(j) ban list / lint**: 新しい `class … Error` 無し（rotation 配下 / jobs 3 本を grep）。`lint/` 無変更。warning 3 は既存

### 指摘（不具合なし。観察）

- **O-1（M-3）**: no-op 確定の判定単位が 1 巡単位（spec は世代ごと）。安全側
- **O-2（情報）**: `start-rotate-encryption` は完走後にもう 1 回叩くと 200 を返し（収束規則 (3) の revive）、handler は退役対象の行が無いので即 `finished`。dev で確認（02:18 の再起動）。実害なし。runnable 行がある間に別の `retiringGeneration` で叩くと `JOB_PAYLOAD_MISMATCH` の `ConflictError` が envelope で返る（意図どおりの拒否だが code は `ConflictError`）
- **O-3（情報）**: `rotate-encryption` の残行に active でも previous でもない暗号世代の行があると復号できず、`remaining` に数え続けるので `previousCount` が 0 にならない（退役は塞がれる = fail safe）。復号できる行が尽きた時点で `DataIntegrityError` → `poison`
- **O-4（情報）**: `operatorBuckets(env)` は keyring JSON が組めないとき黙って g1 だけに退化する。request 経路は同じ変数で起動時に落ちるので実害はないが、operator 面だけ「g1 しか指定できない」形の誤設定が見えにくい
- **O-5（情報）**: `read-rotation-checkpoint` / `remap-chunk` は `enterRpc()` で未初期化 bucket を初期化する（Implementer の追加観察どおり。dev でも `dir:g3:b*` が走査で全て初期化された）。spec は bucket の初期化を制限しないので違反ではない
- **O-6（情報）**: `phases/PH-09.md` B-1 §4.4 s4 の「24 列 / 4 行」は実装（25 列 / 3 行）と食い違う文書上の残り

## 3. 実走（dev = :3000、preview = :4173、自分で実行）

環境: 起動していた dev / preview を止め、`.dev.vars` を `scratchpad/rot9b.mjs`（g3 鍵の生成・digest・書き換えだけを行うスクリプト。鍵は `rot9b-keys.json` に保存し、本報告には載せない）で段階ごとに書き換えて再起動（4 回）。preview は HEAD `5667348` を `pnpm build` して起動。agent-browser: `verify09c`（`ph09b-rot@example.com` / `ph09b-rotate-pass!`、Implementer が g1 で登録し g2 へ移送済みのユーザー）、`verify09d`（`ph09v-rotnew@example.com` / `verify09rot-pass!`、並存中に登録）、`verify09e`（`ph09v-final@example.com` / `verify09final-pass!`、退役後に登録）。CLI は `node scripts/operator.ts …`。ログ `scratchpad/dev9b-v1〜v4.log`、`preview9b-v.log`、`remap9b-v.txt`。開始状態: 3 変数とも active g2 のみ（Implementer の phase 4）。

### 3.1 phase 1 — 写像鍵 g2 → g3 の並存（02:12:44 再起動）

| 時刻 | 操作 | 結果 |
|---|---|---|
| 02:12:44 | `DIRECTORY_ROUTING_KEYRING` = active g3（新鍵）/ previous g2、`DIRECTORY_KEY_COMMITMENT` = 対応する digest 2 件、暗号 keyring は active g2 のまま | `read-schema-version`: `dir:g3:b0` → `{ schemaVersion: null }`（未初期化、作らない）、`dir:g2:b0` → 1、`dir:g1:b0` → 400（退役世代） |
| 02:14:16 | `ph09b-rot` でログイン（行は g2 = previous） | `/` に着地、P-13 に `ph09b-rot@example.com` |
| 02:14:41 | `ph09v-rotnew` を新規登録 | `/` に着地。`list-bucket-user-ids`: g2 合計 28（不変）、g3 合計 1（`b14`）= 予約は active 世代に |
| 02:15:12 | `ph09b-rot` のリセット依頼 | `?sent=1` → `[dev-mail] to=ph09b-rot@example.com …token=2.7.…`（previous 側の bucket で完結。K36 の未移送側） |
| 02:14:52 | 役割入れ替え / previous の世代を 1 に偽装 / active 鍵の末尾 1 文字改変で `remap-chunk dir:g2:b0` | いずれも 500 `CONFIGURATION_ERROR`「not one this Identity Directory committed to」、`read-rotation-checkpoint {remap,2}` は `null` のまま（1 行も動かない） |
| 02:13:55 | `remap-chunk dir:g3:b0`（active を移送元に）/ `--limit` 無し / `start-rotate-encryption dir:g3:b0` | 500「not the mapping-key generation being retired」/ 400（zod）/ 500「A mapping-key rotation is open」 |
| 02:15:31〜33 | `remap-chunk --inject-keyring --limit 100` を `dir:g2:b0..b15` | 全 16 が 200、**96〜108 ms / チャンク**（0〜4 行）、processed 合計 29、skipped 0、conflicts 0、`remaining 0`、`lastCredentialId null` |
| 02:15:35 | `read-rotation-checkpoint {remap, 2}` × 16 | 全 `previousCount 0`。`list-bucket-user-ids`: g2 合計 0、g3 合計 30（29 + 新規 1） |
| 02:16:17 | 旧 bucket 宛のリセットリンク（`token=2.7.…`）でパスワード設定 | フォームは出るが送信で `role=alert`（トークン行は s5 で消えている = 前提 7 の受容） |
| 02:16:17 | `ph09b-rot` を logout → login | `/`（行は g3、active プローブ） |

dev 停止中（02:17:01）の sqlite: `dir:g3:b14` の `resume-signup:01a08c50…` は `done`（`terminal_reason NULL`、R-AC-01）、`credential_mappings` は `active` 2 行（移送 1 + 新規 1）; `dir:g2:b7`（リセット依頼を受けた bucket）は写像 0 / トークン 0。

### 3.2 phase 2 — g2 退役（02:17:01 再起動）

keyring / コミットメントとも active g3 のみ。`dir:g2:b0` → 400、`dir:g3:b0` → 200、`start-rotate-encryption` → 500「carries no previous generation to retire」。`verify09c` / `verify09d` の P-13 がそれぞれのメールアドレスを表示。preview（HEAD build）: `read-schema-version dir:g3:b0` 200 / `dir:g2:b0` 400 / `read-rotation-checkpoint` 200 / 誤 token 401 / `remap-chunk` body 無し 400。

### 3.3 phase 3 — 暗号鍵 g2 → g3（02:17:59 再起動）

`IDENTITY_MAIL_ENCRYPTION_KEYRING` = active g3（新鍵）/ previous g2。`ph09v-rotnew` の logout → login 成功（行はまだ暗号世代 2）。`start-rotate-encryption dir:g3:b0..b15`（02:18:10〜12）: 全 `{ retiringGeneration: 2 }`。12 秒後 `read-rotation-checkpoint {encryption, 2}` × 16 全 `previousCount 0`、`list-poisoned-jobs` × 16 合計 0、ログに `Job execution failed` / `poison` 無し。完走後の再 `start` は 200（O-2）。

### 3.4 phase 4 — 暗号 g2 退役（02:18:59 再起動）

暗号 keyring active g3 のみ。`start-rotate-encryption` → 500（previous 無し）。`ph09b-rot`: タイムラインに移送前のメモ 1 件が読める、P-13 にメール。`ph09v-final` を新規登録 → `/`、リセット依頼 → `[dev-mail] …token=3.3.…`（R-AC-07 を g3 で再実行）。

### 3.5 R-AC-09（SSO、退役後）

`ph09b-rot` の P-13「SSO 連携を追加（Google）」→ 開発用 SSO スタブ（subject `dev-subject-1`）で許可 → `/settings?sso=linked`、「外部アカウント（google）/ ログインに使用 / 解除」→ logout → `/login`「Google で続行」→ スタブで許可 → `/` → P-13 に `ph09b-rot@example.com`（02:21:43）。

### 3.6 ログの鍵検査

`dev9b-v1〜v4.log` / `preview9b-v.log` に対し、g2 / g3 の写像鍵と暗号鍵 4 本・その SHA-256 digest・コミットメントの digest（計 8 値）の出現 0 件、64 hex の連続文字列 0 件、`pbkdf2 / $argon / passwordVerifier` 0 件。監査行は `entry / locator / (id) / outcome` のみ（v1 154 行、v3 49 行）。

## 4. 受け入れ済み PH-01〜09A の 35 項目への影響

- `IdentityGateway.deleteMapping` の戻り `void` → `{ deleted, generation }`: 呼び手は `unlinkSsoCredential`（`deletionRoundConfirms` で `finishUnlink` の形を分ける）/ `sweepOrphanMapping` / `finalizeWithdrawal` と unit `linkUnlinkSso.test.ts` の 1 箇所。単一世代では `generations.size ≤ 1` で従来どおり即 `done`。§3.5 の SSO 連携 → （解除は未実行）
- `reserveCredentialProcedure` の `activeGeneration`: コミットメント未設定（CI / 単一世代）は `null` で恒等。`rotationCheckpointStore.delete` 2 本は「無ければ成功」
- UoW ctx の追加（`rotationCheckpointStore` / `setMigrationCursor`）と `UnitOfWorkRunner` 型は加算のみ。`durableObjectBase` は env 型 2 行の追加のみ。`operationsStore` は `readTargetLocators` の追加のみ。`credentialLabel.ts` への移動は `resumeSignup.ts` の diff で同じ式（`kind === 'sso' ? provider : ''`、`sso || verifier !== null`）
- `sweepOrphanMapping` の再武装は record ごとの `min(nextRunAt)`（失敗時は従来の `now + jobsBackoffBaseMs`）。`finalizeWithdrawal` は初回に `operations(withdrawal)` 行を作る — `recovery.integration` の期待値 2 箇所更新済み（PH-09A で私が固定した結果と整合、再実行 21 件緑）
- 2 回の全走（Implementer 02:08、本検証 02:10）で PH-01〜09A の suite はすべて緑。再実行: **R-AC-01**（並存中と退役後の新規登録、`resume-signup` は `done`）、**R-AC-07**（並存中は previous 側で、退役後は g3 で `[dev-mail]`）、**R-AC-09**（§3.5）、**R-REC-01**（3 suite 21 件）

## 5. Implementer の判断 4 点

- (1) △-16 `GENERATION_MISMATCH` を実装しない: spec `6c08553` と一致。ジョブ経路に予約の書き込みが無いことは `reserveCredentialProcedure` の呼び手が facade `reserveCredential` だけであることで確認。妥当
- (2) △-17 `withdrawal` 行と `noopSince`: spec `1b708f4` と一致。妥当。単位の解釈だけ M-3
- (3) `deleteNoopReissueDelayMs = 60 s`: JSDoc が「導出ではなく判断値、spec の出口（有界回数の再発行）は採らない」を明記しており、CLAUDE.md の「限界を併記」を満たす。妥当（実値は運用設計の材料）
- (4) `IMPORT_ROWS_PER_CALL = 3` に HTTP 面を揃えた: M-1 のとおり閉じている

## 追加観察（完了条件外）

- `remap-chunk` 1 チャンクの実測は 96〜108 ms（0〜4 行、s3 / s4 の RPC 込み）。Implementer 報告の 121〜146 ms より速いが同オーダー
- 並存中に旧 bucket へ発行されたリセットリンクは、移送後もフォームは描画され、送信で初めて拒否される（トークン検証が送信時）。spec の受容範囲内だが、リンクを開いた時点で「無効」と出す方が親切
- dev の DO 状態: 全ユーザーが写像 g3 / 暗号世代 3。g1 / g2 の bucket DO（各 16）は空のまま残っている（写像 0、checkpoint 行と `sweep-*` の `done` 行のみ）

## 検証環境の引き継ぎ状態

- dev（:3000、`dev9b-v4.log`）/ preview（:4173、HEAD `5667348` の build、`preview9b-v.log`）とも起動中。停止は `lsof -t -i :3000 -i :4173 | xargs kill`
- `.dev.vars`: **g3 の phase 4**（`DIRECTORY_ROUTING_KEYRING` = active g3 のみ / `DIRECTORY_KEY_COMMITMENT` = g3 のみ / `IDENTITY_MAIL_ENCRYPTION_KEYRING` = active g3 のみ。他の変数は無変更）。バックアップ `scratchpad/dev.vars.9b-phase4.bak`（Implementer の g2 phase 4）、g3 鍵 `scratchpad/rot9b-keys.json`、書き換えスクリプト `scratchpad/rot9b.mjs`（`map-open` / `map-retire` / `enc-open` / `enc-retire`）。次の再検証は g3 → g4 で同じ手順が回せる
- agent-browser: `verify09c`（`ph09b-rot`、Google 連携済み、ログイン中）/ `verify09d`（`ph09v-rotnew`）/ `verify09e`（`ph09v-final`）。PH-09A の `verify09` / `verify09b` はそのまま
- 追跡ファイルに変更なし。ログ / 中間ファイルは `scratchpad/`（`checks9b.log`、`build9b-v.log`、`dev9b-v1〜v4.log`、`preview9b-v.log`、`remap9b-v.txt`、`rec9b-rerun3.log`）
