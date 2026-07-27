# PR #33 Cloudflare / Infrastructure / Operations Review — Round 2

## Verdict

CHANGES_REQUESTED

- Blockers: 4
- Warnings: 5
- Notes: 3

## Blockers

### B-INFRA-001: staging dry-run が Pulumi Service 認証に依存し、現在の必須 CI が red

- 場所: `.github/workflows/ci.yml:67-93`, `apps/web/package.json:31-34`, `apps/web/scripts/render-wrangler.ts:23-50`
- 影響: `deploy:staging:dry` の pre-script は必ず `render-wrangler.ts` を実行する。`stackOutputs()` は `pulumi` executable が存在しない `ENOENT` の場合だけ committed YAML へ fallback するため、依存として Pulumi CLI が存在する CI では認証なしの `pulumi stack output` を実行して失敗する。実際に PR #33 の run `30291176870` / job `90061059810` は `PULUMI_ACCESS_TOKEN must be set` で失敗しており、AC-16 の必須 gate を満たさない。さらに後段の legacy / traceability audit も実行されない。
- 修正案: render の入力を明示的に分離する。CI/dry-run は committed stage config を読む `--offline`（または値を引数で渡す）経路を使い、実 deploy だけが認証済み `pulumi stack output` を使うようにする。CLI の有無や偶然の login 状態で経路を切り替えない。offline render、未解決 placeholder、authenticated stack-output render をそれぞれ test し、CI を green にする。

### B-INFRA-002: overdue Alarm を constructor / 通常 RPC が未来へ再設定し、starvation が残っている

- 場所: `apps/web/app/durable-objects/UserDataDurableObject.ts:36-42,101,106-108,146-158,231-262,351-358`, `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:175-201`
- 影響: `ensureAlarm()` は platform alarm が `current <= Date.now()` のときも `Date.now() + 1_000` へ `setAlarm()` する。Cloudflare は DO を Alarm で起こす際にも先に constructor を実行し、既存 alarm に対する `setAlarm()` は時刻を上書きする。このため、期限到来後に constructor または高頻度の `getProfile()` / `search()` が入ると due alarm を毎回1秒先へ動かし続けられ、retention job が実行されない。現テストは未来の alarm がより遅くならないことしか確認せず、このケースを検出しない。
- 修正案: 通常入力では `current === null || target < current` のときだけ設定し、overdue/imminent alarm を上書きしない。Alarm handler 内だけは `getAlarm() === null` となる仕様を前提に、処理後の最早 DB 時刻を再設定する。constructor wakeup、期限後の連続 read RPC、Alarm handler 後の再設定を `runDurableObjectAlarm` / eviction を使う独立 test で固定する。Cloudflare の注意事項: https://developers.cloudflare.com/durable-objects/api/alarms/

### B-INFRA-003: routing-key rotation / Directory reconciler に実行面がなく、checkpoint も再開に使われない

- 場所: `packages/core/src/adapters/cloudflare/identityGateway.ts:794-939`, `packages/core/src/adapters/cloudflare/identity-directory/store.ts:307-369`, `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:474-529`, `docs/runtime_cloudflare.md:122-134,189-191`
- 影響: `rotatePreviousGeneration()` と `reconcileExpiredReservations()` は adapter の public method と統合テストからしか参照されず、operator HTTP/CLI、Cron、Alarm のいずれからも呼べない。runbook の「operator-only checkpoint scan」を実行するコマンドが存在しない。また rotation は保存済み checkpoint を読む契約を持たず、毎回全 bucket を cursor 未指定から1 request内で走査する。大規模 bucket で中断・CPU超過した際に cursor から再開できず、記録した `rotation_checkpoints` は累計値を書くだけで運用制御に使われない。expired reservation も1 bucket 100件までを1回見るだけで、次回実行を保証する主体がない。前世代 secret の安全な撤去と signup 部分失敗の自動収束という AC-2/3/13 を運用できない。
- 修正案: 認証済み operator surface と CLI（または専用 orchestration Worker）を追加し、1 invocation を「1 bucket の bounded page」に制限する。checkpoint の read RPC を追加して保存 cursor から再開し、全 bucket 完了・conflict・旧 reverse locator 0件を機械的に報告する。reconciler も永続 checkpoint/次回 schedule を持ち、1 batchを超える reservation と途中停止からの再開を workerd test する。

### B-INFRA-004: PITR wrapper は restore を完了させず、Account Home 照合対象と restore 対象も結び付いていない

- 場所: `apps/web/app/operator/pitr.ts:23-28,80-107,142-161`, `packages/core/src/adapters/cloudflare/pitrOperator.ts:8-51`, `apps/web/app/durable-objects/UserDataDurableObject.ts:223-229`, `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:532-538`, `docs/runtime_cloudflare.md:211-256`
- 影響:
  - API は `objectName` と `accountId` を独立に受け取り、任意の active Account Home を照合しながら別 User Data object を restore できる。User Data の object name がその account の canonical user ID であることを強制していない。
  - Identity Directory object は複数 account を含む shard だが、任意の1 Account Homeだけを前後照合するため、restore で復活する他 account の tombstone/epoch を保護できない。
  - `onNextSessionRestoreBookmark()` は次回 session への restore を予約する API だが、DO RPC は予約して値を返すだけで restart/abort phase を持たない。2回目の authority read も restore 後ではなく「予約直後」である。runbook は「Restart the disposable object session」とだけ書き、実行可能な手段も post-restore reconciliation も提供しない。

  この状態では staging smoke を手順どおり完了できず、誤った object/account の組み合わせや shard 内の削除済み identity を復活させ得るため AC-13 を満たさない。PITR の platform semantics: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#pitr-point-in-time-recovery-api
- 修正案: class別の workflow に分ける。User Data は外部入力の `objectName` を廃止し、検証済み account ID から対象を内部導出する。Identity Directory は単一 account 照合を使わず、対象 shard を隔離したうえで restored mapping 全件を Account Home authority に再照合・tombstone/reconcileしてから利用可能にする。schedule → restart → restored session確認 → post-restore authority/reconcile → undo の実行可能な operator protocol と staging手順を作り、無関係な account/object ペアが restore RPCへ到達しない contract test を追加する。

## Warnings

### W-INFRA-001: migration test は旧 version からの lazy upgrade を実際には通していない

- 場所: `apps/web/app/testing/__tests__/migrations.integration.test.ts:41-118`, `packages/core/src/adapters/cloudflare/migrations.ts:26-49`
- 影響: `runInDurableObject()` に入る前に各 constructor が最新 migration を完了しているため、test 内の `migrate()` 2回はどちらも no-op である。synthetic な「latest + 1 の壊れた SQL」は atomic rollback を確認するが、Identity Directory / Account Home の実 v1 schema と fixture data を作って v2へ上げる経路、upgrade後の読み取り互換性、eviction後再実行は確認しない。`docs/test.md:24,35-36` の migration/restart 記述が実測より強い。
- 修正案: migration runner を class constructor から切り離して直接 v1まで適用できる fixtureを用意し、v1 data → v2、失敗 → v1維持、再試行 → v2、eviction → no-op を各2-version classで確認する。

### W-INFRA-002: Alarm/job の文書化された acceptance coverage が実 suite より広い

- 場所: `docs/test.md:31-37`, `.thread/19/testing.md:128-137,183-189`, `apps/web/app/durable-objects/__tests__/userDataJobs.integration.test.ts:34-202`, `apps/web/app/durable-objects/__tests__/userDataSearch.integration.test.ts:407-439`
- 影響: suite は store level の lease/CAS/poison/batch と retention Alarm 1回を確認するが、eviction/restart、Alarm scheduling failure、retry上限後の再設定、time budget、synthetic `SQLITE_FULL`、downstream providerへの idempotency key伝播は実行していない。B-INFRA-002 の starvationも残る。テスト台帳とリリース判断が false positive になり得る。
- 修正案: 実装するケースだけを文書へ記録し、不足分は独立 integration test として追加する。外部 I/O jobを今は提供しない判断なら「provider idempotency 実行」を acceptance から外し、local retention job の at-least-once不変条件へ正規化する。

### W-INFRA-003: state DO の型が request-only secret を参照可能で、型レベルの隔離が崩れている

- 場所: `apps/web/package.json:20`, `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:95-100`, `apps/web/app/durable-objects/AccountHomeDurableObject.ts:88-93`
- 影響: `wrangler types -c request -c state` の生成 `Cloudflare.Env` は primary request config の `SESSION_SECRET` / directory routing secret / PITR token を含む。Identity Directory と Account Home はその `Cloudflare.Env` を constructor型に使うため、将来 state code が request-only secret を読んでも型検査で検出できない。現時点の remote binding分離は成立しているが、AC-10 の最小権限を継続的に守る guard が弱い。
- 修正案: User Data と同様に明示的な `StateEnv` を3 classへ適用し、state専用生成型を分けるか、source auditで state entry graph に request-only key が現れたら失敗させる。

### W-INFRA-004: stage別 resources stack が同じ DNS zone をそれぞれ作る構成になっている

- 場所: `infra/cloudflare/pulumi/resources/index.ts:4-18`, `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml:1-6`, `infra/cloudflare/pulumi/resources/Pulumi.production.yaml:1-6`, `docs/runtime_cloudflare.md:70-89`
- 影響: committed example は staging/production とも `example.com` を指定する一方、各 stack が `new cloudflare.Zone("zone")` で zone 自体を所有する。runbookどおり両 stackを適用すると、同一 account/domain の二重作成または別 stack ownershipになりやすい。「zone metadata」とする文書とも一致しない。
- 修正案: zoneを共有 stackで一度だけ所有するか、既存 `zoneId` / lookupをresources configへ渡してstage stackは app metadataだけを扱う。少なくとも同一zoneの staging→production previewをCI fixtureで検証する。

### W-INFRA-005: legacy audit が ignored `infra/aws/` の再出現を検出できない

- 場所: `.gitignore:3`, `scripts/audit-legacy.mjs:4-9,39-50`
- 影響: AWS infraは削除されたが `infra/aws/` 自体を ignoreし続け、audit は `git ls-files` だけを見る。そのため generator等が同 pathを再生成してもローカル監査は成功し、レビューにも現れない。削除保証として弱い。
- 修正案: 不要な ignoreを削除し、audit は明示した generated/cache除外を使って filesystem上の legacy rootも確認する。

## Notes

### N-INFRA-001: 第1回の CI matrix / Vite stage config / broken JOB_EGRESS は解消された

- `.github/workflows/ci.yml` は Cloudflare単独の integration/buildへ整理され、Viteはmodeごとの request configを選ぶ。永続 jobは現スコープの local `purge-trash` executorだけになり、存在しない `JOB_EGRESS` bindingを要求しない。

### N-INFRA-002: cross-script binding と3 SQLite class export は workerd/dry-runで解決する

- `pnpm test:integration` は request test Worker → `fog-state` auxiliary Worker を通り、6 files / 26 testsが成功した。
- local `pnpm build`、staging dry-run、legacy/traceability auditは手元の認証済み/fallback環境では成功し、state/request dry-runは3 class bindingを解決した。ただし CI の staging dry-runは B-INFRA-001 により失敗している。

### N-INFRA-003: ordered migration runner と実行可能な local lifecycle CLI は追加された

- schemaは `{ version, up }[]` の連番 migrationへ移行し、将来の forward-only差分を表現できる。
- `pnpm test:lifecycle:cli` は local-only Workerを起動し、memo/document lifecycleと検索観測を出力して終了した。production source/config/bundleへの非包含 auditも通る。

## Verification performed

- `git diff main...HEAD` の Cloudflare/infra/CI/deploy/PITR/migration/Alarm関連差分を確認
- `pnpm test:integration` — pass（request boundary 3 tests、state 23 tests）
- `pnpm build` — pass（required secret/deprecation/CSS conflict warningあり）
- `pnpm deploy:staging:dry` — local pass
- `pnpm audit:legacy && pnpm audit:test-traceability` — pass
- `pnpm test:lifecycle:cli` — pass
- `gh pr checks 33` / failed job log — build/configuration auditのみ `PULUMI_ACCESS_TOKEN` 不在で fail
