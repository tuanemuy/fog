# PR #33 Cloudflare Adapter / Infrastructure / Operations Review

## Verdict

CHANGES_REQUESTED

- Blockers: 6
- Warnings: 4
- Notes: 3

## Blockers

### B-001: CI が削除済みランタイムの script を実行するため必ず失敗する

- 場所: `.github/workflows/ci.yml:45-95`, `package.json:10-34`
- 理由: integration matrix に `node`、build matrix に `node` / `aws` / `gcp` が残っている一方、対応する `test:integration:node` と `build:{node,aws,gcp}` script は削除されている。実行確認でも `pnpm test:integration:node` と `pnpm build:node` はともに exit 1 (`Command ... not found`) になった。AC-9 の legacy 撤去と AC-16 の CI gate を同時に満たせない。
- 提案: matrix を Cloudflare 単独へ変更し、`pnpm test:integration` と `pnpm build`（必要なら `pnpm deploy:staging:dry`）を直接実行する。削除済み runtime 名が workflow に残らないことを allowlist 監査へ追加する。

### B-002: 通常の読み取りが既存 Alarm を未来へ上書きし、継続トラフィック下で job が永久に飢餓状態になり得る

- 場所: `apps/web/app/durable-objects/UserDataDurableObject.ts:25-28,67,71-72,104-105,109-110,226,243-247`
- 理由: `getProfile()` / `search()` を含むほぼ全 RPC が `ensureAlarm()` を呼び、due な `next_run_at` を毎回 `Date.now() + 1_000` へ clamp して `setAlarm()` する。Cloudflare の `setAlarm()` は既存時刻を置き換えるため、1秒未満間隔で入力が続く hot object では Alarm が毎回先送りされる。at-least-once 処理、retention、最大 retry 後の自前再設定という AC-12 の根幹を破る。
- 提案: `getAlarm()` で現在の platform alarm を読み、未設定または DB の最早時刻より遅い場合だけ前倒し設定する。overdue job について既存の imminent alarm を後ろへ動かさない。高頻度 RPC を Alarm 発火前に連続投入しても発火する workerd test を追加する。

### B-003: state Worker に `JOB_EGRESS` binding が一つもなく、永続 job は本番でも必ず retry 後 poison になる

- 場所: `apps/web/app/durable-objects/UserDataDurableObject.ts:13-15,187-226`, `apps/web/wrangler.state.toml:1-33`, `apps/web/wrangler.state.{staging,production}.toml.tpl:1-31`
- 理由: Alarm handler は全 job で `env.JOB_EGRESS` を必須とするが、local/staging/production のどの state config にも service binding はない。現在のテストも binding 不在による失敗を「再スケジュール」として確認するだけで、成功経路、provider idempotency、poison、retention executor を検証しない。つまり外部 I/O job を投入できても完了できる deploy 構成が存在しない。
- 提案: 実際の job kind ごとの executor を state Worker に配線する。外部 service を使うなら全 stage に明示的な service binding と最小 secret を追加し、local には成功/重複/失敗を制御できる auxiliary Worker を置く。未提供機能なら公開 `enqueueJob()` を残さず、job producer と executor を同じ slice で完成させる。

### B-004: Directory reconciler と routing-key rotation checkpoint が schema/文書だけで、運用可能な実装がない

- 場所: `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:36-45`, `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:20-89`, `docs/runtime_cloudflare.md:111-123,178-180`
- 理由: `rotation_checkpoints` table は作られるが読み書きするコードがなく、全 bucket scan、旧 mapping の active generation への移送、Account Home reverse locator 更新、resume/conflict 集計を行う RPC/CLI/operator binding がない。Directory reconciler も存在せず、予約回収は未呼び出しの `reclaimExpired()` RPC だけである。前世代 secret を外すと旧 generation にだけ存在する利用者は login 不能になり、部分失敗の orphan を自動収束できない。AC-2/3/13 と testing.md 5 の手順を実行できない。
- 提案: 認証された operator surface から固定 64 bucket を checkpoint 付きで走査する実装と、永続 operation state を再開する reconciler を追加する。active/previous の同時 signup、途中停止からの再開、conflict、全旧参照ゼロを auxiliary Worker/workerd contract で検証する。

### B-005: PITR の runbook が参照する operator wrapper/admin guard は deploy artifact に存在しない

- 場所: `docs/runtime_cloudflare.md:200-225`, `packages/core/src/adapters/cloudflare/pitrPolicy.ts:1-35`, `packages/core/src/adapters/cloudflare/__tests__/pitrPolicy.test.ts:1-25`
- 理由: runbook は operator-only wrapper 経由で `getCurrentBookmark()` / `onNextSessionRestoreBookmark()` を呼ぶとしているが、その wrapper、認証境界、object 選択、restore 前後の Account Home 照合を行う tooling がない。`assertRestorableClass()` と `assertRestoreAuthority()` はどの entry/script からも呼ばれない純粋関数で、Account Home restore を実際の restore 呼出し前に拒否できない。AC-13 の「admin tooling guard」と staging smoke の手順は未実装である。
- 提案: operator-only Worker/CLI を明示的に用意し、class allowlist → before authority → restore → after authority の順序をコード上で不可分な workflow にする。Account Home 指定時に Cloudflare restore API/DO RPC が一度も呼ばれない contract test を追加する。実 staging smoke 未実施は `progress.md` に残してよいが、実行主体となる wrapper は PR 内で完成させる。

### B-006: 2 Worker/RPC/Alarm/migration の acceptance test が計画された境界を実際には通っていない

- 場所: `vitest.config.integration.ts:9-29`, `apps/web/app/durable-objects/__tests__/durableObjects.integration.test.ts:34-344`, `.thread/19/testing.md:124-184`
- 理由: integration test は state entry を test Worker 本体として直接読み、local namespace に3 class を登録しているだけで、request Worker → `script_name` → auxiliary state Worker の境界を通らない。RPC version envelope/synthetic mismatch、3 class の migration 再実行・途中失敗、eviction/restart、lease reclaim、owner CAS、poison、setAlarm 失敗、batch/time limit、`SQLITE_FULL` translation のケースもない。`durableObjects.integration.test.ts` の Alarm test は binding 不在の1回失敗だけである。設定 typo や互換 window、AC-11/12 を green test が保証しない。
- 提案: request entry を main、state entry を `auxiliaryWorkers` として読み、生成 binding と同じ cross-script RPC を使う harness にする。testing.md 7/8 と edge 1/2 の各ケースを独立 test として実装し、3 class 全ての migration version と rollback を確認する。

## Warnings

### W-001: migration runner が version ごとの migration を表現できない

- 場所: `packages/core/src/adapters/cloudflare/{user-data,identity-directory,account-home}/schema.ts`
- 理由: 単一の `VERSION` と全 DDL の `statements` 配列だけで、version を上げると過去を含む `statements.slice(1)` をすべて再実行する。初期 `CREATE ... IF NOT EXISTS` では動くが、将来 `ALTER TABLE` や data migration を追加すると次 version で再実行不能になりやすく、「各 schema version の forward-only/idempotent lazy migration」という運用契約を維持できない。
- 提案: `{ version, up }[]` の ordered migration にし、`current < version` の entry だけを同一 transaction で適用して各 version を記録する。v0→vN、vN再起動、途中失敗 rollback を各 class でテストする。

### W-002: dry-run は required secret 不在でも成功するため、secret 準備済みの deploy gate にはならない

- 場所: `apps/web/wrangler.request.{toml,staging.toml.tpl,production.toml.tpl}:6-7`, `.thread/19/testing.md:43-53`
- 理由: `pnpm deploy:staging:dry` は `SESSION_SECRET` / `DIRECTORY_ROUTING_SECRET_ACTIVE` がない状態で warning を出しつつ exit 0 になった。binding の非露出確認には使えるが、本番/staging request Worker が起動可能な secret inventory を保証しない。
- 提案: dry-run の役割を binding/bundle 検証に限定して文書化し、release checklist では対象 script の secret inventory を確認する read-only check、または authenticated staging smoke を別 gate にする。secret 値はログへ出さない。

### W-003: `test:lifecycle:cli` は CLI ではなく単一 Vitest case の別名

- 場所: `package.json:27`, `.thread/19/testing.md:80-89`
- 理由: script は `"commits lifecycle"` test を `-t` で選ぶだけで、operator が fixture を投入し結果を確認できる local-only CLI/test Worker route ではない。手動 lifecycle 確認、artifact 非公開性、失敗時の個別操作を検証できない。
- 提案: 名称を contract test に正すか、計画どおり local/test 専用 Worker/CLI を実装し、本番 bundle/route に含まれないことを検査する。

### W-004: stage build が Vite plugin 内では local request config を固定参照している

- 場所: `apps/web/vite.config.cloudflare.ts:12-24`, `apps/web/wrangler.request.{staging,production}.toml.tpl:9-11`
- 理由: staging/production の custom build でも plugin の `configPath` は常に `./wrangler.request.toml` である。外側の Wrangler deploy は stage binding を適用するため現状 dry-run は通るが、build 中には local worker 名/vars/config が読み込まれ、実行ログにも local config の warning が出る。将来 compatibility flag、assets、binding type が stage 間で変わると bundle と deploy config が食い違う。
- 提案: mode/stage から Vite plugin の config path を選択するか、stage 非依存の build config と deploy-only config の責務を明確に分け、生成 artifact の config と外側の deploy config の整合 test を置く。

## Notes

### N-001: 3 class export と cross-script binding の dry-run 解決は成功した

- 場所: `apps/web/app/server.state.ts:1-9`, `apps/web/wrangler.state.toml:11-33`, `apps/web/wrangler.request.toml:21-34`
- 内容: state Worker dry-run は3つの SQLite DO export/binding を認識し、staging request dry-run も `fog-staging-state` の3 class を解決した。state → request の deploy script 順序も正しい。

### N-002: local secret filter は Wrangler の required-secret set で成立している

- 場所: `apps/web/wrangler.request.toml:6-7`, `apps/web/wrangler.state.toml:6-9`, `apps/web/.dev.vars.example:1-27`
- 内容: 現行 Wrangler は `[secrets].required` がある場合に `.dev.vars` から列挙済み key だけを取り込むため、request の2 secret と state の空集合の local 分離は意図どおりである。remote に過去設定済みの secret を削除する機構ではない点は運用上区別する必要がある。

### N-003: legacy 実装の撤去自体は概ね完了している

- 場所: repository-wide active-source audit
- 内容: Node/libSQL/D1/AWS/GCP の entry/adapter/infra は削除され、active source/config で確認できた実害のある残存は B-001 の CI matrix だった。Pulumi も D1/Queue resource/output を除き、Zone/custom domain に縮小されている。

## Verification performed

- `gh pr diff 33` は GitHub の 20,000 行上限で HTTP 406 になったため、同一 head branch の `git diff main...HEAD` で全463ファイルを確認した。
- `pnpm --filter @repo/web exec wrangler deploy --config wrangler.state.toml --dry-run`
- `pnpm deploy:staging:dry`
- `pnpm test:integration:node`（期待どおりではなく exit 1）
- `pnpm build:node`（期待どおりではなく exit 1）
- legacy/runtime/binding/operator-tooling の repository-wide `rg` 監査
