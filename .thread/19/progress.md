# Issue #19 残存課題

## staging PITR smoke

ローカル workerd では SQLite-backed Durable Objects の PITR を実行できないため、User Data / Identity Directory の実 restore は未実施。`docs/runtime_cloudflare.md` の手順に従い、Cloudflare 認証情報と disposable staging object を用意したリリース作業で実施する。

自動検証済みの範囲:

- Account Home 指定を Durable Object RPC より前に拒否する operator HTTP / workflow contract
- User Data / Identity Directory の class allowlist と restore 前後の Account Home status / epoch 照合順序
- request main Worker → `script_name` → state auxiliary Worker の generated binding 境界
- local-only lifecycle Worker/CLI と production entry/config/bundleへの非包含audit

未検証のままリリースゲートに残る範囲:

- staging の実bookmark取得・restore・undo restore
- staging secret inventory gate（Cloudflare認証情報が必要）
