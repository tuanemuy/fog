# ADR-001: Cloudflare Workers と利用者単位 Durable Objects に集約する

## ステータス

承認済み

## コンテキスト

fog のデータは共有・共同編集・テナント横断検索を行わず、利用者単位で完結する。
Node/libSQL、D1、AWS、GCP の複数経路と共有 DB の論理分離を保守するより、
利用者ごとの物理分離と単一 runtime を選ぶ方がデータ特性に合う。

## 決定

本番・開発・テストを Cloudflare Workers に一本化し、request Worker と
state Worker を分離する。state Worker は SQLite-backed の User Data、
Identity Directory、Account Home Durable Object を export する。

request Worker だけが session と directory routing の secret を持ち、
認証済み `userId` から binding 経由で state Worker を呼ぶ。公開入力から
DO ID、object name、partition key を選ばせない。local development は2つの
Wrangler configを同時起動し、deployはstateを先、requestを後に行う。
RPC envelopeは片側deployとrollbackに必要な互換windowを持つ。

Node/libSQL、D1、AWS、GCP のruntime/adapterは削除し、Cloudflare Pulumiは
DNSとrouteだけを管理する。

## 検討した代替案

- 複数runtimeを維持する: 運用・migration・テストの重複がデータ特性に見合わない。
- D1の共有DBを使う: `user_id`による論理分離が残り、利用者内transactionも
  remote databaseに依存する。
- 単一Workerにまとめる: request-only secretとstate classの配布境界が曖昧になる。

## 影響

- 利用者データを物理分離し、利用者内更新をローカルSQLite transactionで扱える。
- Cloudflareへのvendor lock-inを受け入れる。
- 2 Workerのdeploy順、RPC互換、object単位migration、容量・PITR・export・deleteを
  運用する必要がある。
