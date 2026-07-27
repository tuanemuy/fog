# PR #33 第5回レビュー — Infra / Operations / Tests / Spec / Acceptance

## 判定

**CHANGES_REQUESTED**

対象: `main...43ecf369de219aecbe5c2a6be33dcbe3d9cd4209`

- Blockers: 2
- Warnings: 3
- Notes: 3

第4回で指摘した CLI の restore→undo 契約、両 DO class の構造化証跡、
rotation の旧世代参照ゼロ、production entry の実 HTTP 経路、login work
profile、current-user partial failure、RPC compatibility、reporter artifact
による CI traceability は修正済みであり、再掲しない。

現 HEAD の PR CI は3 jobとも成功している。一方、PITR release gate は入力
JSONの内容を検査するだけで、それが指定された保護 workflow の artifact
であることを検証しない。加えて、リポジトリには文書が前提とする
`staging-pitr` environment がまだ存在しない。このため、現時点の
canonical deploy gateは「承認済みの実 staging PITR 成功」へ信頼可能に
結び付いていない。

## Blockers

### B-IT5-001 — PITR release gateは保護artifactの出所を検証せず、ローカルで作ったJSONでも解錠できる

- 場所:
  - `apps/web/scripts/release-preflight.ts:79-144,182-232,247-267`
  - `apps/web/scripts/__tests__/release-preflight.test.ts:33-183`
  - `docs/runtime_cloudflare.md:98-103,293-298,357-365`
- 根拠:
  - `PITR_EVIDENCE_PATH` は任意のローカルパスであり、repository外の絶対
    パスや `..` も `resolve()` 後にそのまま読める。
  - `runUrl` は GitHub Actions URLらしい文字列であることだけを正規表現で
    検査する。owner/repository、workflow名、workflow file、run conclusion、
    event、environment deployment/approval、artifact ID/name/digestのいずれも
    GitHub APIまたはattestationで照合しない。
  - unit test自身も、テスト内で組み立てたJSON objectと任意の
    `actions/runs/123456789` を渡して成功することを期待している。つまり
    class、receipt、SHA、TTLの形だけを満たす手編集JSONは、実workflowを
    一度も実行しなくても同じvalidatorを通る。
  - その後のsecret inventoryとWrangler dry-runが成功する環境では、この
    JSONだけで `deploy:{staging,production}` のPITR条件を解錠できる。
- 影響:
  - TEST-OPS-001 / AC-13が要求する実 staging のUser Data・Identity
    Directory restore/verify/undoを省略しても、本番を含むcanonical deployを
    進められる。第4回で追加したclass別receiptは内容証明にはなったが、
    「保護された実行由来」の証明にはなっていない。
- 修正案:
  - release時にrun IDとartifact IDを入力し、GitHub API/OIDC attestation等で
    repository、HEAD SHA、`staging-pitr-smoke.yml`、成功conclusion、
    `workflow_dispatch`、承認済みenvironment deployment、未失効artifact名と
    digestを照合してから内容を読む。
  - 少なくとも任意ファイルを正本にせず、固定workflowから
    `actions/download-artifact` したartifact metadata/digestと結び付け、
    別repositoryのrun URLや手編集JSONを拒否するnegative testを追加する。

### B-IT5-002 — 「protected staging-pitr environment」は実リポジトリに存在せず、workflowを実行可能なrelease gateにできていない

- 場所:
  - `.github/workflows/staging-pitr-smoke.yml:30-43`
  - `docs/runtime_cloudflare.md:293-298`
  - GitHub repository settings / environments
- 根拠:
  - workflowは `environment: staging-pitr` とenvironment secrets
    `PITR_OPERATOR_URL` / `PITR_OPERATOR_TOKEN` を前提にする。
  - 2026-07-28の確認で
    `GET /repos/tuanemuy/fog/environments/staging-pitr` は404、
    `GET /repos/tuanemuy/fog/environments` は
    `{"total_count":0,"environments":[]}` だった。
  - したがって、文書が要求するenvironment secrets、required reviewers、
    deployment branch/tag policyは現在設定されておらず、「protected」と
    いう記述は実状態と一致しない。PITR artifactも現 HEADには存在しない。
- 影響:
  - 現在のworkflowは必要なenvironment secretを受け取れず、TEST-OPS-001を
    完了できない。後からenvironment名だけ作っても、required reviewer等を
    明示設定しなければ承認境界にはならない。
- 修正案:
  - `staging-pitr` environmentを作成し、environment secret、required
    reviewer、許可branch/tagを設定する。設定をrepository運用台帳または
    IaC/管理手順に記録し、APIで保護ルールを確認するrelease checklistを
    追加する。
  - 設定完了後、exact HEADのdisposable staging対象でworkflowを実行し、
    B-IT5-001の真正性検査を通るartifactを確定する。

## Warnings

### W-IT5-001 — 破壊的なPITR workflowに対象単位のconcurrency lockがない

- 場所:
  - `.github/workflows/staging-pitr-smoke.yml:3-43,59-88`
- 理由:
  - `workflow_dispatch` の2 runが同じUser Data objectまたはDirectory shardを
    指定して同時実行できる。restoreとundoはrun間でatomicではなく、
    片方が取得したundo bookmarkをもう片方のrestore後に適用すると、各runが
    成功しても最終状態がsmoke前ではなく途中のbookmarkになる可能性がある。
  - `namespace` は証跡ラベルにしか使われず、同一対象の直列化や一意性を
    強制しない。
- 提案:
  - class/targetを含む `concurrency.group` と
    `cancel-in-progress: false` で同一対象を直列化する。あわせてdisposable
    targetの予約・使用中・解放を記録し、異なるnamespace labelで同じ対象を
    重複指定できないようにする。

### W-IT5-002 — production entry acceptanceがdevelopment modeのbundleを実行している

- 場所:
  - `apps/web/package.json:14,21`
  - `vitest.config.production-entry.ts:5-22`
  - `apps/web/vite.config.cloudflare.ts:8-14`
- 理由:
  - `test:integration:prepare` は `build:request` を呼び、その実体は
    `vite ... --mode development` である。
  - `production-entry` suiteはその `apps/web/dist/server/index.js` を実行する
    ため、production source entry/defaultEntry/server-fnの回帰は検査するが、
    `wrangler.request.production.toml` を使ったproduction-mode bundleそのもの
    は実行しない。
  - staging dry-runとproduction configの静的検査はあるが、mode固有のVite
    config/build差分が実HTTP経路で壊れるケースはこのacceptanceを通る。
- 提案:
  - production acceptance専用outdirへ `--mode production` でbuildし、その
    artifactをMiniflareのmainにする。通常のdevelopment integration artifactと
    混用せず、reporter evidenceもproduction-mode buildに結び付ける。

### W-IT5-003 — committed handoff記録が現HEAD/CIと矛盾している

- 場所:
  - `.thread/19/test-results.json:2-6,56-60`
  - `.thread/19/progress.md:23-24`
- 理由:
  - 現 HEADは `43ecf36...`、CI runは `30300833748` で成功しているが、
    `test-results.json` は `baseCommit: e2ec1ac...`、
    `source: working-tree`、`workingTree: true` のまま、committed CIも旧run
    `30297557438` を指す。
  - `progress.md` も「このworking tree自体のcommitted CI runは未作成」と
    記録しており、現実と逆になっている。実行traceability auditはActionsの
    reporter artifactを正本にしたためCI自体は正しくgreenだが、人間向け
    handoffと残存課題の判断を誤らせる。
- 提案:
  - Actions artifactを唯一のcurrent automation evidenceとして明記し、
    committed JSONは履歴snapshotとしてcommit/runの適用範囲を明示するか、
    CIから生成・公開してrepositoryへ固定しない。少なくともprogressは現
    HEAD/runへ更新する。

## Notes

### N-IT5-001 — 現HEADのPR CIは全必須job成功

- `Lint / Format / Typecheck / Unit tests`: pass
- `Cloudflare integration tests`: pass
- `Cloudflare build and configuration audit`: pass
- Run: `30300833748`
- Head SHA: `43ecf369de219aecbe5c2a6be33dcbe3d9cd4209`

unit/integration reporter artifactのupload/download、HEAD/run URL/clean
checkout fingerprintの照合もCI内で成功している。第4回の自己申告だけの
traceability問題は、通常CIについては解消した。

### N-IT5-002 — remote release gateは未完了としてfail-closed

staging PITR artifactとauthenticated secret inventoryは未実施のまま正しく
pendingであり、現時点の手順をそのまま実行すれば外部credential不足で停止
する。これはlocal CI failureではないが、B-IT5-001/002を解消して実runを
確定するまではrelease-readyではない。

### N-IT5-003 — 第4回の主要acceptance補強は実行経路へ接続済み

- production `defaultEntry` とbuilt signup/login/logout server-fnをworkerd上の
  実HTTPで実行するsuiteが追加された。
- old/new RPC組合せとrequest rollbackのcompatibility suiteが必須integrationへ
  接続された。
- PITR CLIのstdout roundtripはfake operator serverを起動するsubprocess testへ
  移り、両class証跡writerもunit testされている。
- current-userのAccount Home/User Data個別unavailable、login 4分岐の
  verify/authority/log profileがunit testへ追加された。

## 確認内容

- Issue #19、`.thread/19/plan.md`、testing/progress/test-results、第4回reviewと
  triage、active spec/test inventoryを現HEADへ再照合
- `main...HEAD` と第4回修正commit `e2ec1ac...43ecf36` のCI、Wrangler、
  release/PITR、operator、migration/Alarm、production entry、traceabilityを
  ゼロベースで確認
- `gh pr checks 33` / Actions run `30300833748` — 3 job pass
- GitHub environments API — `staging-pitr` 404、environment total 0
- GitHub artifacts API — 現HEADはunit/integration reporter artifactのみ、
  staging PITR artifactなし
- コード変更、commit、pushは未実施
