# PR #33 第6回レビュー — Infra / Operations / Tests / Spec / Acceptance

## 判定

**APPROVED**

対象: `main...29b9ebd29511d3ca58d36fcacf03f7b1286e9e80`

- Blockers: 0
- Warnings: 0
- Notes: 5

第5回の Blocker 2件・Warning 3件を起点にしつつ、PR差分、release/PITR、
Cloudflare構成、CI、reporter evidence、test inventory、spec、acceptanceを
ゼロベースで再確認した。新規・残存のBlocker/Warningはない。

## Blockers

なし。

## Warnings

なし。

## Notes

### N-IT6-001 — PITR release gateは保護workflow artifactへ結び付いた

- 任意の`PITR_EVIDENCE_PATH`は拒否され、数値の`PITR_EVIDENCE_RUN_ID`
  だけを受け付ける。
- Actions APIからrepository、exact commit、`main`、`workflow_dispatch`、
  workflow file、成功conclusion、run URLを取得して照合する。
- `staging-pitr` environmentのrequired reviewer、run approval history、
  `main`だけのdeployment branch policyを検査する。
- exact runの未失効`staging-pitr-<SHA>` artifactをAPIから取得し、
  artifact metadataのrun/SHAとGitHub SHA-256 digestを照合する。
- archiveは単一の`staging.json`だけを許可し、release preflight自身が
  download・検証した内容だけを読む。別repository、別workflow、手編集JSON、
  digest不一致を解錠経路にできない。

### N-IT6-002 — protected environmentは実repository設定と一致する

2026-07-28のAPI再確認結果:

- environment: `staging-pitr`、ID `18840085455`
- required reviewer: `tuanemuy`、user ID `22880537`
- custom deployment branch policy: `main` branchのみ、policy ID `55774806`
- request/state復旧jobは同environmentを使い、同一対象を
  target-keyed concurrencyと`cancel-in-progress: false`で直列化する

environment secretはまだ0件であり、disposable targetとexact-HEADの実PITR
runも未実施である。この状態は`test-results.json`と`progress.md`で
release-gate pendingとして明示され、canonical deployはfail closedで停止する。

### N-IT6-003 — production acceptanceはproduction-mode artifactを実行する

`test:integration` / `test:integration:evidence`はproduction entry suiteの直前に
production Pulumi fixtureをrenderし、`--mode production`でrequest Workerを
buildする。suiteはその`dist/server/index.js`をworkerdへ読み込み、
`defaultEntry`とbuilt signup/login/logout server functionsを実HTTPで実行する。

Actions run `30302877643`のlogでもproduction用RSC/SSR/client buildと
production reporter生成を確認した。

### N-IT6-004 — 現HEADのGitHub CIとmachine-readable evidenceは成功

Actions run:
`https://github.com/tuanemuy/fog/actions/runs/30302877643`

- `Lint / Format / Typecheck / Unit tests`: success
- `Cloudflare integration tests`: success
- `Cloudflare build and configuration audit`: success
- unit: 35 files / 426 tests
- request integration: 2 files / 6 tests
- production entry integration: 1 file / 1 test
- state integration: 6 files / 84 tests
- lifecycle CLI: 13 operations、`assertionsPassed: true`
- legacy audit: 282 active files、production artifact inputs clean
- traceability audit: 34 TEST IDs、current Actions run / clean checkoutへ結合

unit/integration artifactのAPI digestとdownloadしたarchiveのSHA-256は一致した。
各evidenceはPR merge commit
`5290dcd18508c91bdd7c9735cb3516ce00e6cb4c`、run `30302877643`、
`workingTreeFingerprint: clean`へ結び付いている。merge commitの親には
review対象HEAD `29b9ebd29511d3ca58d36fcacf03f7b1286e9e80`が含まれる。

### N-IT6-005 — test/spec handoffは履歴snapshotとcurrent automationを分離する

`test-results.json`は基準commit `43ecf369...`上の第5回working-tree検証を
履歴snapshotとして、base commit、working-tree状態、旧CI runの適用範囲を
明記する。現HEADのcurrent automation evidenceは上記Actions runとその
reporter artifactであり、値の適用範囲は混同されない。

TEST-MAN-002、TEST-OPS-001/002の実staging PITR、TEST-OPS-003のauthenticated
secret inventoryはpendingのままだが、いずれも設計どおりmanual/release gate
であり、自動テスト成功への偽装やrelease-ready扱いはされていない。

## 確認内容

- PR #33、Issue #19、`main...HEAD`、第5回review/triage、Round 5修正commitを
  ゼロベースで照合
- PITR workflow、operator/evidence writer、release preflight、negative unit
  tests、runtime runbook、repository environment APIを照合
- production Vite/Wrangler mode、production entry acceptance、request/state
  binding、secret inventory、deploy順序を照合
- test inventory 34件、machine-readable evidence、CI upload/download、
  working-tree/run binding、pending release/manual evidenceを照合
- `gh pr checks 33`、Actions run `30302877643`、artifact metadata/digestを確認
- targeted release/config unit tests: 2 files / 14 tests pass
- staging PITR workflow YAML parse pass
- 実装コードの変更、commit、pushは未実施
