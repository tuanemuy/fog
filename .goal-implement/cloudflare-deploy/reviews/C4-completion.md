# C4 completion / gate review

## 判定

**FAIL — ローカル成果物は大部分が整合しているが、完成ゲートは受け入れない。**

- `main` push から `staging-fog.DOMAIN`、Release PR merge から `fog.DOMAIN` へ至る workflow、Workers runtime、migration、secret sync、deploy、smoke、provenance、recovery の局所実装は接続されている。
- ただし、Release Please の既定 token で Release PR を作れないことが分かっている repository 設定に対する実行可能な初期設定手順と、任意 secret `FOG_AI_CLIENTS` の削除収束が欠ける。CF06 と最終 CF07 を FAIL とする。
- 実 Cloudflare/Turso/Google/GitHub resource は未設定であり、staging/production の実配備は未実施である。局所修正後も、実環境 gate を通るまで元依頼の公開結果は完了しない。

監査日時は 2026-09-06 JST。product、manager、phase、既存 review、GitHub、Cloudflare、Turso、Google の状態は変更していない。このファイル以外の永続変更は行っていない。

## Baseline integrity

`.goal-implement/cloudflare-deploy/phases/C4.md` の manifest を独立に解析し、記載された 64 path の存在と SHA-256 をすべて再計算した。

- path 数: 64
- path/hash 不一致: 0
- manifest digest: `1349656447860181b48759580718c399846357e924e2c6ec5675f3447fd74b9b`
- 基準 digest との比較: PASS

したがって、このレビューは指定された C4 snapshot を対象とする。

## Blocking findings

### B-C4-001: Release Please の初回実行手順が現在の repository 設定では成立しない

**Severity: Blocker / CF06**

`docs/runtime_cloudflare.md:54` は原則として既定の `github.token` を使い、branch policy が Release PR 作成または後続 workflow を妨げる場合だけ `RELEASE_PLEASE_TOKEN` を使うとしている。しかし read-only inventory では次を確認した。

- Actions default workflow permission: `read`
- `can_approve_pull_request_reviews`: `false`
- repository secret `RELEASE_PLEASE_TOKEN`: 未登録
- remote default branch に Cloudflare delivery workflow: 未導入

GitHub の repository setting は `GITHUB_TOKEN` による pull request の作成・承認を明示的に制御する。現在値では、`docs/runtime_cloudflare.md:91` が前提とする Release Please による Release PR 作成が既定 token で成功しない。一方、fallback token の説明には token 種別、必要な repository permissions、期限・rotation の契約がなく、管理者が安全に同じ構成を再現できない。

修正要求:

1. 既定 token を採用するなら、repository の Actions 設定で pull request 作成を許可する具体手順と確認方法を運用文書に追加する。
2. custom token を採用するなら、repository 限定の GitHub App token または fine-grained PAT、`contents: write`、`pull requests: write`、`issues: write`、有効期限・rotation、`RELEASE_PLEASE_TOKEN` への格納手順を明記する。
3. 選択した経路を hostile fixture または validator で再現し、Release PR 作成と release-created 後続 run の双方を確認する。`GITHUB_TOKEN` 由来イベントが後続 workflow を開始しない制約のため、release の連鎖には既存 workflow の明示的な `workflow_dispatch` が引き続き必要である。

根拠:

- [GitHub: Managing GitHub Actions settings for a repository](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository?apiVersion=2022-11-28)
- [Release Please Action: permissions and token behavior](https://github.com/googleapis/release-please-action)

### B-C4-002: `FOG_AI_CLIENTS` を設定解除しても Worker の既存 secret が削除されない

**Severity: Blocker / CF06 / security**

`docs/runtime_cloudflare.md:78-80` は `FOG_AI_CLIENTS` を任意とし、使わない場合は未登録にする。ところが実装は次の挙動になる。

- `apps/web/scripts/cloudflareStage.ts:372-388` は環境値がある optional secret だけを `runtimeSecrets` に含める。
- `apps/web/scripts/cloudflareSecrets.node.ts:17-51` はその object をそのまま `wrangler secret bulk` に渡す。
- Cloudflare の bulk secret update は merge semantics であり、payload にない secret は維持される。削除には値 `null` の明示が必要である。

したがって、一度 `FOG_AI_CLIENTS` を配備した後で GitHub Environment から削除して再配備しても、Worker には旧値が残る。失効させたつもりの AI client credential または redirect URI が認可されたままになるため、単なる文書上の不一致ではなく credential revocation の欠落である。

修正要求:

1. 未指定時に `FOG_AI_CLIENTS: null` を bulk payload に含めるか、対象 Worker の secret inventory を照合して明示削除する。
2. secret payload の型を `string | null` に合わせ、必須 secret は削除できないこと、任意 secret は present → absent で削除されることを test double と hostile test で固定する。
3. 運用文書に追加、rotation、revocation の手順と、配備後に secret 名だけを確認する read-only check を追加する。

根拠:

- [Cloudflare: Bulk secrets API supports deleting secrets with `null`](https://developers.cloudflare.com/changelog/post/2026-06-03-bulk-secrets-api/)
- [Cloudflare Wrangler commands: `wrangler secret bulk`](https://developers.cloudflare.com/workers/wrangler/commands/workers/)

## Warning

### W-C4-001: Cloudflare authority の実検証より先に DB migration が進む

workflow の副作用順序は migration → secret sync → deploy → smoke であり、schema expand を先に適用する設計自体は正しい。しかし build の Wrangler dry-run は Cloudflare credential を使わず、preflight は `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` の非空だけを確認する。token が期限切れ、対象 account/Worker/zone scope が不足、または account ID が誤っている場合、remote DB migration の後で初めて Cloudflare 操作が失敗する。

現行 migration は expand-only、identity marker で stage/DB の誤接続を拒否し、retry 可能なので Blocker にはしない。初回運用手順には、migration 前に `wrangler whoami` 相当の read-only authority check と対象 account/zone/Worker permission の照合を追加すべきである。部分状態が生じた場合は同じ SHA で再実行し、DB を巻き戻さない。

## Requirement verdicts

| 要件 | 局所判定 | 実環境判定 | 根拠 |
| --- | --- | --- | --- |
| CF01 Workers 基盤 | PASS | 未検証 | module worker entry、Node listener 非依存 HTTP adapter、static asset、cron/export、stage config が接続済み。generated artifact に `node:fs`、`node:net`、`node:tls`、`listen.node`、SMTP、signal、interval、migration/backup runner の混入なし。 |
| CF02 remote libSQL | PASS | 未検証 | remote-only URL/TLS、DB identity marker、bootstrap、migration lease/heartbeat、bounded crypto が実装・検証済み。実 Turso の auth、PITR、5 秒 transaction、concurrency は未確認。 |
| CF03 Workers services | PASS（条件付き） | 未検証 | cron lease、mail lease/retry、Cloudflare Email binding が接続済み。Cloudflare Email Sending の対象 account/domain/任意宛先可否を確認し、利用不能なら設計済みの HTTPS mail provider adapter が別途必要。 |
| CF04 Release Please | PASS | 未導入 | root release config/manifest、current action pin、root output と head SHA の一致、release exact-one/attempt/status が局所検証済み。remote main には workflow 自体がまだない。 |
| CF05 staging/production workflow | PASS | 未設定 | main push のみ staging、Release Please root output 経由のみ production、通常 PR/tag/release_created は production false、stage concurrency `cancel-in-progress: false`、production environment approval、recovery dispatch、SHA/provenance が局所検証済み。GitHub Environments と branch policy は未作成。 |
| CF06 operation/runbook | **FAIL** | 未設定 | B-C4-001、B-C4-002。backup/restore、rollback、recovery、bootstrap、logs、credential inventory は概ね記載済みだが、Release Please 初期権限と optional secret revocation が実行可能な閉路になっていない。 |
| CF07 acceptance/completion | **FAIL** | 未実施 | manifest と局所 tests は PASS だが、上記 Blocker と必須外部 gate が残る。main→staging と Release PR merge→production の実 run、custom domain、mail/OAuth/AI/cron、recovery drill は未実施。 |

## Workflow hostile audit

次を独立に再確認した。

- trigger は `push` to `main` と必須入力付き `workflow_dispatch` のみ。
- `verify` と `staging` は push のみ。release job は staging 成功後のみ。production は Release Please の `release_created == true`、root release tag/sha、staging output、exact release/tag provenance の一致を要求する。
- 通常 PR、通常 tag push、通常 GitHub Release event、release 未作成の main push、曖昧な multiple release、attempt/status 不一致から production へ到達しない。
- recovery は既存 GitHub Release、完全 SHA、tag peeled commit、main ancestry、successful staging deployment、workflow/run/attempt/environment/status を照合する。
- production secret を参照する job は `environment: production` の approval 後だけ開始する。public provenance validator は secret を持たない。
- workflow top-level permission は空、job permission は用途別。checkout は 40 桁 SHA pin、`persist-credentials: false`。全 action pin は current stable major の公式 release tag の peeled commit と一致する。
- migration → secret sync → deploy → smoke/status の順序、stage 別 fixed concurrency、`cancel-in-progress: false`、failure/cancel deployment status を確認した。
- fork/PR には workflow trigger がなく Environment secret へ到達しない。

この局所 semantics は PASS。ただし `workflow_dispatch` の trusted-workflow boundary は production Environment の deployment branch policy `main` に依存する。現在 Environment 自体がないため、production approval を行う前に必ず policy を作成し、main 以外からの dispatch が environment に入れないことを UI/API で再確認する。

## Independent verification results

| 検証 | 結果 |
| --- | --- |
| 64-file manifest path/hash + manifest digest | PASS: 64/64、digest 一致 |
| `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts apps/web/scripts/cloudflareDelivery.test.ts` | PASS: 2 files / 102 tests |
| `pnpm exec vitest run --config vitest.config.integration.cloudflare.ts apps/web/app/worker/cloudflare/runtime.cloudflare.test.ts` | PASS: 1 file / 5 tests。終了時の workerd connection-close diagnostic は exit 0 の既知 teardown 出力 |
| actionlint v1.7.12 | PASS: official Darwin arm64 checksum `aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f` 一致、2 workflow で diagnostics 0 |
| workflow command/config wiring | PASS: workflow 内 pnpm command 13/13 が root scripts に接続、参照 secret 8/8 と vars 3/3 が runbook に記載、production revalidation が secret/config 使用より前、public validator は secret なし |
| generated Worker artifact scan | PASS: Node listener/SMTP/signal/timer/migration/backup 経路なし。provenance は production/現 HEAD。共有 worktree が dirty のため local artifact の `gitClean` は false だが、side-effect preflight は clean checkout を必須化する |
| `pnpm typecheck` | PASS |
| `pnpm lint` | PASS。既存 test の string concatenation に non-error info 1 件、変更なし |
| `pnpm format:check` | PASS |
| production file placeholder/TODO/empty-catch scan | PASS: `/todo` route、一時 artifact path、意図的な rejection/error 文言、example config/test fixture 以外の未接続・仮実装なし |

actionlint の一時 directory と検証用生成物は削除済みで、live process/session は残していない。

## Read-only external inventory

2026-09-06 JST に secret 値を取得せず確認した。

- repository: `tuanemuy/fog`、public、default branch `main`
- remote workflow: `ci.yml` のみ
- GitHub Environments: 0
- repository Actions variables: 0
- repository Actions secrets: 0
- default workflow permissions: `read`
- Actions による PR 作成・承認: disabled
- `main` branch protection: 未設定
- Wrangler authentication: なし
- Turso CLI: なし

Cloudflare account/zone/Workers Paid plan、custom domain、Worker、Email Service、Turso DB/PITR/token、Google OAuth client はローカルまたは GitHub inventory から存在を確認できない。値を表示する probe、外部 resource 作成、secret 登録、deploy、commit、push、通知は行っていない。

## Real-environment-only gates

次は mock/local test で完了判定できない。

1. Cloudflare Workers Paid の CPU/memory/connection limit 下での scrypt queue、concurrent HTTP、cron、mail dispatch。
2. distinct staging/production Worker、custom domain、zone、route、account ownership と token scope。
3. Cloudflare Email Sending の認証済み sender、allowed destination、任意ユーザー宛配信、retry/重複許容。
4. distinct Turso DB、TLS、最小権限 token、PITR、5 秒以内 transaction、lease contention、restore drill。
5. stage 別 Google OAuth client と callback URI の完全一致。
6. GitHub Environment reviewer/self-review/branch policy、approval 前 secret 非参照、deployment records、workflow chaining。
7. `main` push の staging smoke、Release PR merge の tag/release/prod approval/smoke、同じ release を使う recovery dispatch。
8. mail recovery、AI OAuth/client credentials、scheduler の end-to-end 動作。

## Minimal blockers requiring user or administrator input

局所 Blocker の修正後、実配備へ進むために最低限必要な決定・値は次のとおり。

1. apex `DOMAIN` と、それを管理する Cloudflare account/zone、Workers Paid plan。
2. staging/production 用の別 Worker 名、route、remote Turso DB、DB URL/token/identity、PITR 契約。
3. Cloudflare Email Sending が要件を満たすかの確認。満たさない場合は採用する HTTPS mail provider と credential。
4. staging/production 用 Google OAuth client ID/secret と exact callback URI。
5. production approver と main-only deployment policy。
6. Release Please の token 方針。既定 token の PR 作成許可を有効にするか、repository 限定 custom token を発行するか。
7. `FOG_AI_CLIENTS` を有効にするか。利用する場合は stage 別 client/redirect URI/credential、利用しない場合は削除収束を直した実装。

## Concrete path to deployment

1. B-C4-001 と B-C4-002 を product/runbook/tests で修正し、manifest を更新して C4 verifier を再実行する。
2. Cloudflare account/zone/plan、Email Sending、Turso DB/PITR、Google OAuth client を stage ごとに準備し、権限と識別子を read-only command で照合する。
3. GitHub に `staging` と `production` Environment を作る。production は required reviewer、self-review disabled、deployment branch `main` only にする。
4. runbook の vars/secrets を各 Environment に登録する。stage 間で Worker、DB、OAuth、AI client を共有しない。選択した Release Please token 経路も登録する。
5. Cloudflare delivery と release workflow を review/merge し、`DATABASE_IDENTITY_BOOTSTRAP=true` の staging で main push を実行する。migration → secrets → deploy → smoke と deployment record を確認後、bootstrap flag を削除する。
6. Release Please の PR 作成を確認し、production resource/secret/bootstrap を準備する。Release PR を merge して tag/root SHA/staging deployment を照合し、production を承認する。
7. production smoke と DB marker を確認して bootstrap flag を削除する。cron、recovery mail、Google OAuth、AI client を実利用条件で確認する。
8. 同じ release tag/SHA で recovery dispatch を rehearsal し、wrong SHA、non-main SHA、failed staging、attempt mismatch が拒否されることを確認する。
9. backup/restore、secret rotation/revocation、Cloudflare token failure 後の同一 SHA retry を rehearsal し、記録を残す。

この順序を完了するまで、`staging-fog.DOMAIN` と `fog.DOMAIN` は「実装済み」ではあっても「配備・運用確認済み」ではない。
