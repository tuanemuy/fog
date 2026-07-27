# ADR-003: ローカル更新は同期commit、外部処理はAlarm jobに分ける

## ステータス

承認済み

## コンテキスト

本体とFTS indexは同じSQLiteにある一方、外部I/Oとretentionはrequest処理から
分離し、再起動後も回復する必要がある。transport Outboxを全更新へ使うと、
同じ保存領域の整合まで非同期化してしまう。

## 決定

usecaseは外部I/Oのないasync prepareでtyped commandを作り、
`SemanticCommitPort`だけが`transactionSync`内で本体repositoryと
transaction-scoped projectionを同期更新する。transaction callbackへPromise、
暗号、RPC、メールを持ち込まない。

外部I/Oとretentionだけを永続job tableへ記録し、単一のDurable Object Alarmで
処理する。jobはoperation key、payload digest、attempt、`nextRunAt`、lease、
owner token、provider idempotency key、poison reasonを持つ。claimと完了は
owner tokenのCASで守り、期限切れleaseをreclaimする。Alarmは件数と時間を
boundedにし、処理後と失敗後の両方でDBの最早時刻へ再設定する。

## 検討した代替案

- 全更新をOutbox経由にする: 本体とFTSが一時不整合になる。
- transaction内で外部I/Oする: latencyと障害をSQLite commitへ持ち込む。
- インメモリqueueを使う: evictionや再起動で処理を失う。

## 影響

- 本体と検索はcommit成功時だけ同時に変わる。
- 外部副作用はat-least-onceとなり、provider idempotency、lease監視、poison運用が
  必要になる。
- domain eventは業務・監査の表現に限定され、transportとして扱わない。
