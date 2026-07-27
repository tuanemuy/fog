# Issue #19 残存課題

## staging PITR smoke

ローカル workerd では SQLite-backed Durable Objects の PITR を実行できないため、User Data / Identity Directory の実 restore は未実施。`docs/runtime_cloudflare.md` の手順に従い、Cloudflare 認証情報と disposable staging object を用意したリリース作業で実施する。

自動検証済みの範囲:

- User DataをAccount Homeのcanonical user IDからだけ解決し、
  schedule→restart→verify→undoをfail closedで進めるoperator contract
- Identity Directoryを単一account照合せず、100件単位の全mapping authority
  reconcileとreceipt cursorで完了まで再開するcontract
- rotation checkpoint再開、expired reservation reconcileの認証済み
  bounded operator HTTP/CLI
- production authenticated user routingによる2 accountのUser Data物理分離
- v1 fixtureから実migration失敗rollback、retry、eviction後lazy no-op
- request main Worker → `script_name` → state auxiliary Worker のgenerated binding境界
- local-only lifecycle Worker/CLIの13操作と各直後検索assert、CI必須step化、
  production entry/config/bundleへの非包含audit
- offline Pulumi fixtureによるstate→request staging dry-run
- machine-readable TEST ID evidenceの実ファイル・test名・suite include監査

このworking tree自体のcommitted CI runは未作成であり、
`test-results.json`ではpendingとしている。

未検証のままリリースゲートに残る範囲:

- staging の実bookmark取得・restore・verify・undo restore
- staging secret inventory gate（Cloudflare認証情報が必要）

基準commit、実行コマンド、件数は
[`test-results.json`](./test-results.json) に記録する。
