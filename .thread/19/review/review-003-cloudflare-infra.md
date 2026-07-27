# PR #33 Cloudflare / Infrastructure / Operations Review — Round 3

## Verdict

CHANGES_REQUESTED

- Blockers: 5
- Warnings: 5
- Notes: 3

## Blockers

### B-INFRA3-001: `tsx` が web package の依存に存在せず、必須 CI が再現性を持って失敗する

- 場所: `.github/workflows/ci.yml:64-68`, `apps/web/package.json:21-27,53-67`, `package.json:28`, `pnpm-lock.yaml:36-136`
- 影響: `lifecycle:run`、`pitr:operator`、`identity:operator` はすべて `tsx` を直接実行するが、`@repo/web` は `tsx` を dependency / devDependency に宣言していない。ローカルでは infra package や既存 install layout から偶然解決できる一方、fresh CI の filtered package script では解決できない。実際に current HEAD `502776e5a797fd042636164314755f1f5aa137d4` の run `30294626070` / job `90072484842` は `Local lifecycle acceptance` で `sh: 1: tsx: not found` となり、AC-16 と必須 branch check を満たしていない。PITR / maintenance の本番運用 CLI も clean install で同じ失敗条件を持つ。
- 修正案: `tsx` を `apps/web/package.json` の devDependencies に直接追加して lockfile を更新する。fresh `pnpm install --frozen-lockfile` 後に `pnpm --filter @repo/web lifecycle:run` と両 operator CLI の起動確認を CI で行い、sibling package の依存や hoist に依存しないことを固定する。

### B-INFRA3-002: PITR の restart failure と Directory authority conflict を成功扱いでき、restore 未適用でも smoke が完了する

- 場所: `apps/web/app/operator/pitr.ts:315-324`, `apps/web/scripts/pitr-operator.ts:80-98`, `packages/core/src/adapters/cloudflare/pitrOperator.ts:146-177`, `apps/web/app/durable-objects/UserDataDurableObject.ts:398-406`, `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:542-551`
- 影響:
  - HTTP handler は `restartPitrTarget()` の例外を理由に関係なく握り潰し、常に `202 restart-requested` を返す。期待する `ctx.abort()` による RPC 切断だけでなく、authority change、binding/network failure、RPC が対象 DO へ到達しなかった場合も成功になる。
  - restart が実際には起きなかった場合でも User Data の検証は `currentBookmark >= restoreBookmark` しか見ない。現在状態は過去の restore bookmark より新しいため、restore 未適用の同じ session がこの条件を満たす。Directory は bookmark の適用確認自体を行わず、現在 DB へ marker を書いて current bookmark を返す。
  - Directory CLI は `reconciliation.complete` だけで終了し、`conflicts > 0` でも exit 0 になる。各 page の conflict 数を receipt に累積しないため、途中 page の conflict は最終出力からも失われる。

  `onNextSessionRestoreBookmark()` は次 session で初めて restore するため、この false positive は「schedule → restart → restored-session verify → undo」を満たしたという誤った運用判断につながる。削除済み mapping の未照合や、実際には戻っていないデータを復旧済みと扱うため AC-13 の fail-closed 条件を満たさない。
- 修正案: restart RPC の期待された abort とそれ以外の失敗を区別し、未知の失敗は 409/非ゼロ終了にする。検証は schedule が返した undo bookmark、session incarnation nonce、または restore 前に書いた一意 sentinel が新 session で消えたことなど、restore 適用を証明できる値に結び付ける。Directory receipt に scanned/tombstoned/conflict の累積を保存し、全 cursor 完了かつ conflict 0 の場合だけ成功とする。restart 未到達、abort 以外の例外、同一 session、途中 page conflict を独立 contract test に追加する。

### B-INFRA3-003: Identity Directory の shard allowlist 検証より先に destructive restore を schedule する

- 場所: `apps/web/app/operator/pitr.ts:211-240`, `packages/core/src/adapters/cloudflare/pitrOperator.ts:63-86,120-135`, `packages/core/src/adapters/cloudflare/identityGateway.ts:1335-1368`, `apps/web/app/operator/__tests__/pitr.test.ts:80-122`
- 影響: `resolveDirectory()` が restore 前に確認するのは文字列が `^(.*):([0-9]+)$` に一致することだけで、generation が active/previous keyring に属するか、bucket が固定 bucket 数内かを確認しない。keyring/bucket の検証は `operatorReconcileRestoredPage()`、つまり `onNextSessionRestoreBookmark()` を対象 object に送った後で初めて行われる。operator の typo や改ざん receipt により、未使用 object を作るだけでなく、意図していない実 shard に destructive PITR を予約してから「invalid shard」と失敗できる。テストも active generation の happy path だけで、未知 generation / 範囲外 bucket が restore RPC へ到達しないことを保証していない。
- 修正案: Directory target を schedule/bookmark より前に keyring の configured generation と `0 <= bucket < bucketCount` で canonicalize/allowlist 検証する。可能なら対象を自由形式 `shard` 文字列で受けず `{generation,bucket}` の validated DTO とし、restore object name は内部生成する。未知 generation、負数、上限値、巨大 bucket、余分な区切り、active/previous 撤去後 receipt が `operatorRestoreBookmark()` を一度も呼ばないテストを追加する。

### B-INFRA3-004: routing-key rotation が conflict を残したまま checkpoint を前進・完了し、再試行不能になる

- 場所: `packages/core/src/adapters/cloudflare/identityGateway.ts:1224-1269`, `packages/core/src/adapters/cloudflare/identity-directory/store.ts:535-593`, `docs/runtime_cloudflare.md:144-158`
- 影響: page 内の `ConflictError` は count されるだけで、その row を未完了として保持せず `page.nextCursor` まで checkpoint を進める。最終 page なら conflict が1件以上でも `completedAt` を設定し、次回呼び出しは `scanned: 0, conflicts: 0, completed: true` を返す。そのため原因を解消しても失敗 row を再処理する operator 経路がない。runbook は `completed` が false の間だけ反復する一方、最後に要求する「Directory mapping と Account Home reverse locator の previous generation 参照がゼロ」を機械的に列挙・再試行するコマンドもない。旧 locator が残ったまま previous secret を撤去するとログイン不能、残したままなら key rotation 未完了となる。
- 修正案: conflict row を永続 retry queue/checkpoint に残すか、conflict がある page では cursor/completedAt を確定しない。checkpoint の累積 conflict と未解決 locator を operator status で取得し、Directory mapping と Account Home reverse locator の双方がゼロになるまで `completed` を返さない。conflict → 中断 → 原因解消 → 同 row 再試行 → 全 bucket 0件の integration test を追加する。

### B-INFRA3-005: 設計上の Directory Alarm/reconcile job がなく、signup 部分失敗の回復が人手実行に依存する

- 場所: `spec/database/index.md:215-221`, `.thread/19/plan.md:79-89,143-164`, `packages/core/src/adapters/cloudflare/identity-directory/schema.ts:4-89`, `apps/web/app/durable-objects/IdentityDirectoryDurableObject.ts:110-118,517-532`, `apps/web/app/operator/identity-maintenance.ts:112-119`, `docs/runtime_cloudflare.md:213-229`
- 影響: spec は `directory_reconcile_jobs` に phase/attempt/next-run/last-error を永続化し、Directory Alarm が Account Home operation/epoch と User Data 初期化状態を照合して部分失敗を再開すると定義している。実 schema に同 table はなく、Identity Directory DO に `alarm()` もない。現在の回復手段は operator が generation/bucket を知って `reconcile-page` を手動反復するだけで、次回 schedule、全 bucket の進捗、失敗 attempt、再開 checkpoint を永続化しない。operator が呼ばれない、途中で止まる、対象 bucket を漏らすと reservation/orphan が無期限に残り、AC-3 の「全 fault point が retry/reconciler で収束」と active-path spec が成立しない。
- 修正案: spec どおり bounded な Directory reconcile job + Alarm を実装し、operator は監視・再駆動面にする。手動 operator-only を意図するなら、Issue/plan/spec/acceptance を先にその運用 SLO へ改訂し、全固定 bucket の durable checkpoint、次回実行保証、失敗 attempt/error、完了 gate を orchestration Worker等で実装する。DO eviction、途中停止、100件超、対象 bucket 漏れから自動再開する integration test を追加する。

## Warnings

### W-INFRA3-001: maintenance の reconcile/status は bucket 上限を検証せず、typo で任意の空 DO を作成できる

- 場所: `apps/web/app/operator/identity-maintenance.ts:27-44,112-125`, `packages/core/src/adapters/cloudflare/identityGateway.ts:1272-1293,1405-1418`, `packages/core/src/adapters/cloudflare/identityGateway.ts:689-713`
- 影響: transport は bucket を `>= 0` としか検証しない。rotation は gateway 内で bucketCount を検証するが、reconcile/status は configured generation の一部しか確認せず、`forBucket(generation,bucket)` で範囲外名の DO stub を作る。operator の typo が新しい空 SQLite DO をactivation/migrationし、`examined: 0` や全 count 0を正しい shard の完了結果と誤認させる。巨大整数を繰り返せば不要 object も増える。
- 修正案: 3 action 共通で keyring の configured generation/bucketCount を検証してから stub を取得する。上限境界と、invalid input で namespace `get/getByName` が呼ばれないテストを追加する。

### W-INFRA3-002: previous routing secret の「削除」が remote secret deletion を実行せず、inventory も余分な request secret を許容する

- 場所: `docs/runtime_cloudflare.md:136-158`, `apps/web/scripts/validate-secrets.ts:17-31,77-89`
- 影響: runbook の step 6 は previous key/generation を config から除いて再 deploy するだけだが、既存 Worker secret は明示的な `wrangler secret delete` なしでは remote binding に残り得る。inventory は required secret の欠落と state Worker の禁止 secretだけを検査し、request Worker の予期しない旧 `DIRECTORY_ROUTING_SECRET_PREVIOUS` を成功扱いする。rotation 後も旧 HMAC key が request runtime へ配布された状態が残り、key破棄という AC-13 の終了条件を保証しない。
- 修正案: zero-reference gate 後に stage configを指定した `wrangler secret delete DIRECTORY_ROUTING_SECRET_PREVIOUS` を手順へ追加する。request inventory に rotation mode別 allowlistを持たせ、通常時は previous secret/generation の残存を失敗させる。削除後の inventory 結果を release evidence に記録する。

### W-INFRA3-003: test result record が current HEAD/CI と一致せず、失敗中の lifecycle を passed と記録している

- 場所: `.thread/19/test-results.json:2-20`, `.thread/19/progress.md:15-21`, `.thread/19/testing.md:7-15`
- 影響: results は `baseCommit: 1e716a...`, `workingTree: true` のローカル実行を正本としているが、current HEAD は `502776e...` であり、その HEAD の CI lifecycle は B-INFRA3-001 で失敗している。それでも `pnpm test:lifecycle:cli: passed`、`CI実行` と記録されているため、release gate が stale/false-positive になる。
- 修正案: 修正後の committed HEAD SHA と GitHub Actions run/job URLを記録し、working-tree evidence と committed-CI evidence を別フィールドにする。必須 check が red の間は `passed` ではなく `failed/pending` に更新し、CI completion後だけ正本を確定する。

### W-INFRA3-004: shared zone の参照が resources/routes stack 間で独立し、同一 zone 制約を検証しない

- 場所: `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml:2-5`, `infra/cloudflare/pulumi/resources/Pulumi.production.yaml:2-5`, `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml:2-5`, `infra/cloudflare/pulumi/routes/Pulumi.production.yaml:2-5`, `apps/web/scripts/__tests__/cloudflare-config.test.ts:50-70`
- 影響: resources は `REPLACE_WITH_SHARED_CF_ZONE_ID`、routes は別の `REPLACE_WITH_CF_ZONE_ID` をstageごとに手入力し、StackReferenceも共通 config sourceもない。テストは resources staging/production の一致だけを見て routes を照合しないため、custom domain を別 zone IDへ適用する drift を preview/deploy 前に検出できない。runbook の「同じ既存 shared zone」という前提が設定契約になっていない。
- 修正案: organization/shared configから zone IDを一元供給するか、render/release preflightで resources/routes の stage別 accountId/zoneId/hostnameを照合する。少なくとも4 stack fixtureの shared zone一致を unit testに追加する。

### W-INFRA3-005: canonical deploy command が secret inventory と remote PITR gate を実行せず、release gateを容易に迂回できる

- 場所: `apps/web/package.json:26-43`, `docs/runtime_cloudflare.md:78-103,105-131,163-177`, `.thread/19/progress.md:23-26`
- 影響: `pnpm deploy:staging` / `deploy:production` は authenticated render → state deploy → request deployだけを行い、`secrets:check:*`、current config/zone preflight、PITR smoke evidence を要求しない。runbookではこれらを release gate と呼ぶ一方、現在も staging inventory/PITRは pending で、canonical aggregate commandを実行すればそのまま bypassできる。current Wrangler は request の `secrets.required` 欠落自体はdeploy時に拒否するが、state Workerに残った禁止secret、W-INFRA3-002の余分な旧secret、zone drift、remote restore protocolの実動作までは検査しない。
- 修正案: initial bootstrapと通常releaseを分けた release script/workflowを用意し、通常releaseは render → config/zone audit → secret inventory → dry-run → state → request → routes → smoke/evidence の順で fail closedにする。PITR smokeを毎deployで必須にしない場合も、直近成功 evidenceのstage/namespace/期限を明示して gate判定する。

## Notes

### N-INFRA3-001: request/state の local secret filter は current Wrangler の実装契約と一致する

- Wrangler 4.114 の `secrets.required` は `.dev.vars` / process env から listed keyだけをbindingへ入れる。state configの空集合はlocal request-only secretを除外し、state dry-runにも3 DO binding以外のsecretは表示されなかった。Round 2の型分離修正とsource auditもこの境界を補強している。

### N-INFRA3-002: offline render、shared zone ownership、declarative SQLite exports は前回指摘から改善された

- CIのbuild/configuration audit jobはcurrent HEADでgreenであり、offline fixture renderはPulumi Service認証なしでstate→request dry-runを完了する。
- resources stackはzoneを作成せず既存zone IDのmetadataだけをexportし、state configは3 classをdeclarative `exports` + `storage = "sqlite"` で宣言している。

### N-INFRA3-003: remote-only release evidence は未完了として明示されている

- stagingの実 bookmark/restore/verify/undo と secret inventory は `.thread/19/progress.md` / `test-results.json` で pending。ローカル workerdがPITR/`ctx.abort()`を提供しないため保留理由自体は妥当だが、B-INFRA3-002/003を修正したうえでmerge/release前に実環境で完了させる必要がある。

## Verification performed

- `git diff main...HEAD` の CI、Wrangler、Vite、Pulumi、DO exports/binding/migration/Alarm、PITR、maintenance、secret、deploy/runbook 全差分をゼロベースで確認
- Issue #19、`.thread/19/plan.md`、`spec/database/index.md`、`docs/runtime_cloudflare.md` と実装を照合
- `gh pr checks 33` と run `30294626070` / job `90072484842` の failure logを確認
- `pnpm --filter @repo/web exec wrangler deploy --config wrangler.state.toml --dry-run` — pass、3 SQLite DO bindingsを確認
- current Wrangler schema/runtime implementationで `[secrets].required = []` のlocal env filteringを確認
- Cloudflare公式 PITR契約（`onNextSessionRestoreBookmark()` は次sessionで適用、通常は `ctx.abort()` でrestart、bookmarkは辞書順比較可能）と `ctx.abort()` のremote-only semanticsを照合
- コード変更、commit、pushは未実施
