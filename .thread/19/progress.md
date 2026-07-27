# Issue #19 残存課題

## staging PITR smoke

ローカル workerd では SQLite-backed Durable Objects の PITR を実行できないため、User Data / Identity Directory の実 restore は未実施。`docs/runtime_cloudflare.md` の手順に従い、Cloudflare 認証情報と disposable staging object を用意したリリース作業で実施する。

自動検証済みの範囲:

- Account Home restore の operator guard
- restore 前後の Account Home status / epoch 一致契約
- User Data / Identity Directory だけを restore 対象にできる class allowlist
- lazy migration、export pagination、deletion tombstone の local workerd contract
