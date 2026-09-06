# C3 workflow / security 独立レビュー

## 判定

判定は **FAIL**。`CF04`、`CF05`、`CF06` の workflow 部分を受け入れない。

検証日時は 2026-09-06T04:49:00+09:00 から 2026-09-06T05:01:01+09:00。対象 manifest は 62 files すべて一致し、連結 SHA-256 は `4c44e87900349318f58e7684c0aac5491c2b945a32e0d3241b7ccb1be2c889e3` と一致した。

## Blocking findings

### B-C3-WF-001 production validator が実際の workflow job 一覧を拒否する

`apps/web/scripts/cloudflareGithub.node.ts:210` は `jobs` 配列の全要素に `name === "Deploy staging"`、`conclusion === "success"`、`head_sha === release SHA` を要求する。GitHub の `List jobs for a workflow run` は run 内の全 job を返すため、`Verify release candidate`、`Deploy staging`、`Release Please` を含む正常な応答は Zod parse で失敗する。

一時的な独立 Vitest fixture で、正常な3 job応答に成功済み `Deploy staging` を含めた。`validateReleaseCandidate()` は `jobs[0].name` と `jobs[2].name` の `invalid_value` で reject した。一時 test file は削除済みである。

通常 release と `workflow_dispatch` recovery は同じ validator を使う。どちらも production Environment へ進めない。全 job を一般形で parse し、`Deploy staging` の一致要素を `some` または `find` で検査する必要がある。

根拠: [GitHub REST workflow jobs](https://docs.github.com/en/rest/actions/workflow-jobs?apiVersion=2026-03-10)

### B-C3-WF-002 全 action が current stable major ではない

全 `uses:` は40桁 commit SHAで固定され、指定 SHA は公式 repository に存在する。固定方法は正しいが、4 action すべてが 2026-09-06 時点の current stable major より古い。

| action | 現在の指定 | current stable release / commit | 判定 |
| --- | --- | --- | --- |
| `actions/checkout` | v6 / `d23441a48e516b6c34aea4fa41551a30e30af803` | [v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) / `3d3c42e5aac5ba805825da76410c181273ba90b1` | FAIL |
| `actions/setup-node` | v4 / `49933ea5288caeca8642d1e84afbd3f7d6820020` | [v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) / `820762786026740c76f36085b0efc47a31fe5020` | FAIL |
| `pnpm/action-setup` | v4 / `b906affcce14559ad1aafd4ab0e942779e9f58b1` | [v6.0.10](https://github.com/pnpm/action-setup/releases/tag/v6.0.10) / `0977fd99725f1db4007ccb2928dbb4e90d06cc86` | FAIL |
| `googleapis/release-please-action` | v4 / `5c625bfb5d1ff62eadeeb3772007f7f66fdcf071` | [v5.0.0](https://github.com/googleapis/release-please-action/releases/tag/v5.0.0) / `45996ed1f6d02564a971a2fa1b5860e934307cf7` | FAIL |

公式 release page が示す release commit を40桁で確認した。`pnpm/action-setup` v6.0.10 は署名付き annotated tag の peeled commit が `0977fd99725f1db4007ccb2928dbb4e90d06cc86` である。fog は pnpm 11 を使うため、公式が後継として案内する `pnpm/setup` への移行も選択肢となる。

直接の `git ls-remote` は実行環境のネットワーク process が30秒応答せず、sessionを中断した。current major と release commit の根拠は公式 GitHub release pageで確定した。

### B-C3-WF-003 default `GITHUB_TOKEN` の Release Please 権限が不足する

`.github/workflows/cloudflare-delivery.yml:163` の release job は `contents: write` と `pull-requests: write` だけを付与する。Release Please の公式 workflow 契約は `issues: write` も要求する。`release-please-config.json` は `skip-labeling` を有効にしていない。

`RELEASE_PLEASE_TOKEN || github.token` の fallback 自体は正しい。repository secret が未設定の通常経路は権限不足となる。release job に `issues: write` を加えるか、ラベルを使わない構成を明示する必要がある。PAT または GitHub App tokenを使う場合も repository限定、期限付き、必要権限だけの設定を外部 gate で確認する。

根拠: [Release Please workflow permissions](https://github.com/googleapis/release-please-action#workflow-permissions)

## Semantics matrix

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| YAML / expression | PASS | checksum検証済み actionlint v1.7.12で2 workflows、diagnostics 0 |
| trigger | PASS | `push.branches: [main]` と必須入力付き `workflow_dispatch` のみ。通常 PR、tag push、`release.created` は起動しない |
| normal main push | PASS | `release_created != 'true'` なら public production validation と production jobは起動しない |
| release path | FAIL | job一覧 parse defectにより正常 provenanceを拒否する |
| recovery path | FAIL | trusted `main` validator、入力のenv受け渡し、tag/SHA/main/staging再検証は正しいが、同じ job一覧 parse defectで停止する |
| `needs` / `if` / outputs | PASS | verify → staging → release → validate-production → production。dispatchは `always()` でskip済み releaseを越え、pushは release job successとroot `release_created == 'true'` を要求する |
| Release Please root outputs | PASS | root `release_created`、`tag_name`、`sha` を正規化し、release作成時は staged SHAとの一致を要求する |
| environment / concurrency | PASS | `staging` と `production` を分離。groupは `fog-staging` / `fog-production`、両方 `cancel-in-progress: false` |
| production approval前のsecret | PASS | public validatorに `environment` と `secrets.*` がない。production secretsは production job内の必要stepだけが参照する |
| fork / PR secret exposure | PASS | delivery workflowにPR系triggerがない。CIは `permissions: {}` と job `contents: read` だけで、secret参照がない |
| checkout | PASS | 全 checkout に `persist-credentials: false`。staging/release/productionは明示 SHAを使い、dispatch validatorだけが trusted `refs/heads/main` を使う |
| staging side-effect順序 | PASS | record → migration → secret sync → deploy → smoke → success status。record後の失敗は failure statusを設定する |
| production side-effect順序 | PASS | approval後再検証 → config → build/provenance → dry-run → migration → secret sync → deploy → smoke |
| permissions | FAIL | workflow defaultは空、各 read/writeは概ね最小。Release Pleaseの `issues: write` が欠ける |
| action supply chain | FAIL | SHA pinはPASS。current stable major要件は4 actionすべてFAIL |

Production secretsが approval 前に使えないことは [GitHub environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments) の契約とも一致する。

## 検証結果

| 検証 | 結果 |
| --- | --- |
| 62-file manifest再計算 | PASS。62/62一致、block digest一致 |
| 独立 YAML parse / trigger / needs / if / environment / concurrency / pin / checkout検査 | PASS |
| actionlint v1.7.12 | PASS。公式 Darwin arm64 asset SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f` 一致、2 workflows diagnostics 0 |
| `pnpm exec vitest run apps/web/scripts/cloudflareDelivery.test.ts` | PASS。1 file / 24 tests |
| 現実的な複数job GitHub API fixture | FAIL。B-C3-WF-001を再現 |
| action current-major照合 | FAIL。B-C3-WF-002 |
| Release Please default-token permission照合 | FAIL。B-C3-WF-003 |

既存24 testsは単一の `Deploy staging` jobだけを fixtureに入れるため、B-C3-WF-001を検出しない。修正後は複数job応答を恒久 regression test に加える必要がある。

## CF 判定

| ID | 判定 | 理由 |
| --- | --- | --- |
| CF04 | FAIL | main → checks → staging の構造はPASS。current-major action要件を満たさない |
| CF05 | FAIL | production provenance validatorが正常なrunを拒否する。Release Please default-token権限とaction majorも不足する |
| CF06 workflow部分 | FAIL | secret隔離、権限default空、SHA pinはPASS。Release Please権限とaction更新が未完了 |

## 未検証

- GitHub-hosted runner上の実run、staging deployment record、Environment approval、実 repositoryのdefault-token/PAT挙動は未検証。
- Cloudflare、Turso、DNS、OAuth、Email、HTTPS endpointは未変更・未検証。
- production required reviewers、自分自身による承認禁止、deployment branch policyの外部設定は未検証。

製品コード、管理ファイル、GitHub、Cloudflare、Turso、DNS、OAuth、Emailは変更していない。永続変更はこのレビュー文書だけである。

## 最終再検証

検証日時は 2026-09-06T05:28:00+09:00 から 2026-09-06T05:40:21+09:00。最終判定は **PASS**。この判定は上記の初回 FAIL を置き換える。

### Manifest

`.goal-implement/` を除く HEAD 差分と untracked files を path 順に再計算した。62 files で、manifest block digest は `99b1b5fc5daeeb039c7af8de53613642c113b603f5c4f014a4b8678412d3e59b`。C3 記録と一致した。

### Blocking finding の解消

| ID | 最終判定 | 根拠 |
| --- | --- | --- |
| B-C3-WF-001 | PASS | workflow-attempt jobs を一般形で parse し、exact `Deploy staging` を一意に選択する。実際型の verify / staging / release 複数job応答は成功し、exact job の0件・複数、SHA不一致、failure、payload/run attempt不一致を拒否する。jobs API は payload に結び付いた `/actions/runs/{run_id}/attempts/{run_attempt}/jobs` を使い、run 自身の `run_attempt` も同値に限定する。 |
| B-C3-WF-002 | PASS | 全19個の `uses:` は40桁 SHA pin。一意な action は checkout v7.0.1 / setup-node v7.0.0 / pnpm/action-setup v6.0.10 / release-please-action v5.0.0 で、2026-09-06時点の公式 current stable release。公式 tag の commit、annotated tag の場合は peeled commit と完全一致した。 |
| B-C3-WF-003 | PASS | release job は `contents: write` / `issues: write` / `pull-requests: write` に限定。`secrets.RELEASE_PLEASE_TOKEN || github.token` により custom token と default token の両経路を保持する。 |

Action tag の `git ls-remote` 結果は次のとおり。`pnpm/action-setup` の左側は annotated tag object、`^{}` は workflowが pinする peeled commitである。

| action release | 公式 tag commit |
| --- | --- |
| [`actions/checkout` v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1) | `3d3c42e5aac5ba805825da76410c181273ba90b1` |
| [`actions/setup-node` v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0) | `820762786026740c76f36085b0efc47a31fe5020` |
| [`pnpm/action-setup` v6.0.10](https://github.com/pnpm/action-setup/releases/tag/v6.0.10) | tag `ff378ebe6b225b0680b81c1ad4498ae0d1d3a5e3` / peeled `0977fd99725f1db4007ccb2928dbb4e90d06cc86` |
| [`googleapis/release-please-action` v5.0.0](https://github.com/googleapis/release-please-action/releases/tag/v5.0.0) | `45996ed1f6d02564a971a2fa1b5860e934307cf7` |

各 tag の公式 `action.yml` で、checkout の `ref` / `persist-credentials`、setup-node の `node-version` / `cache`、pnpm/action-setup の `version`、release-please-action の `token` / `target-branch` / `config-file` / `manifest-file` 入力が現行 major で有効なことを確認した。Release Please の公式契約は root component の `release_created` / `tag_name` / `sha` と `contents` / `issues` / `pull-requests` write 権限を示している。根拠: [Release Please outputs and permissions](https://github.com/googleapis/release-please-action#outputs)

### Workflow semantics

| 項目 | 最終判定 | 根拠 |
| --- | --- | --- |
| trigger / production gate | PASS | delivery は main push と必須入力付き dispatch のみ。通常PR、tag push、`release.created`、main pushの `release_created=false`、release job failure でproductionは起動しない。Release Please PR merge後のmain pushで root releaseが作成された場合と明示dispatch recoveryだけが通過する。 |
| `needs` / `if` / outputs | PASS | verify → staging → release → public validation → production。dispatchは `always()` でskipされたrelease jobを越える。root outputsを正規化し、release作成時の `sha === staged SHA` を強制する。 |
| environment / concurrency | PASS | environmentは `staging` / `production`、concurrencyは `fog-staging` / `fog-production`、どちらも `cancel-in-progress: false`。 |
| secret / approval / fork | PASS | public validationは environmentと `secrets.*` を持たない。production secretは production Environment jobのapproval後stepだけが参照する。deliveryにPR/fork triggerはなく、CIは read-only token・secret非参照。 |
| permissions / checkout | PASS | workflow defaultは `{}`。job単位の必要な contents/actions/deployments/pull-requests/issues だけを付与。全checkoutは `persist-credentials: false`。deploy経路は検証済みSHA、recovery validatorは trusted `refs/heads/main` をcheckoutする。 |
| side-effect order | PASS | stagingはrecord → migration → secret sync → deploy → smoke → status。productionはapproval後再検証 → migration → secret sync → deploy → smoke。 |
| recovery | PASS | 入力tag/SHA、GitHub Release、tag peel、main ancestor、最新staging deployment/status、bot creator、run repository/event/path/SHA/attempt、exact staging jobを検証する。approval後に公開provenance全項目の不変性を再検証する。 |

### 検証実績

| 検証 | 結果 |
| --- | --- |
| 62-file manifest | PASS。62/62、digest完全一致 |
| actionlint v1.7.12 | PASS。公式 Darwin arm64 SHA-256 `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f` 一致、2 workflows diagnostics 0 |
| 独立 YAML / expression / scenario assertion | PASS。19 action refs、trigger、needs、if、outputs、permissions、environment、concurrency、checkout、secret隔離、side-effect順序、通常main/release merge/recovery/PR/tagを再解釈 |
| `pnpm exec vitest run apps/web/scripts/cloudflareDelivery.test.ts` | PASS。1 file / 60 tests |
| semantic hostile fixtures | PASS。実際型の複数job、exact job一意性、attempt不一致、最新deployment/status、pagination、provenance変更、通常PR/tag/release falseを拒否 |

### CF 最終判定

| ID | 最終判定 | 理由 |
| --- | --- | --- |
| CF04 | PASS | main checks、staging deploy、順序、current-major immutable action pin、failure statusが一貫する |
| CF05 | PASS | Release Please v5、root outputs/SHA equality、正常releaseとrecoveryの公開provenance検証、production approval後再検証が一貫する |
| CF06 workflow部分 | PASS | default-deny permissions、secret隔離、fork/PR非露出、checkout認証情報非保持、SHA pin、最小job権限が一貫する |

実 GitHub-hosted runner、repository Environment approval設定、custom PAT/GitHub App tokenのrepository制限・期限・実権限、Cloudflare/Turso/DNS/OAuth/Emailはこのworkflow再検証では未検証。GitHub、Cloudflare、Turso、DNS、OAuth、Emailへの変更と通知は行っていない。製品・管理ファイルは変更せず、永続変更はこのレビュー文書への最終追記だけである。
