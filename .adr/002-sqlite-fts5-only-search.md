# ADR-002: 検索は SQLite FTS5 だけを採用する

## ステータス

承認済み

## コンテキスト

ベクトル検索を必須とする評価データはなく、User Data Durable ObjectのSQLiteは
FTS5を提供する。本体と索引を同じtransactionで更新できるため、外部indexとの
結果整合やembedding基盤を導入する根拠がない。

## 決定

検索はUser Data Durable Object内のSQLite FTS5に限定する。Unicode NFKC、
UTF-8 50 byte上限、trigram tokenizerを基本とし、1〜2文字だけを対象列と
page sizeを制限したSQL fallbackで扱う。

本体とFTS projectionは同じsemantic commitで確定する。topic filter、
trash除外、安定順位、snippet、source link、期限付きsnapshot paginationを
SQLite内で実現する。Vectorize、embedding、RRF、hybrid resultを設計と実装から
除外する。

## 検討した代替案

- FTS5とベクトル検索を統合する: 品質評価の根拠がなく、外部整合・費用・運用が増える。
- 外部全文検索を使う: 利用者単位SQLiteとの二重書き込みが必要になる。
- 空白tokenizerだけを使う: 日本語本文を十分に扱えない。

## 影響

- 検索の整合性、説明可能性、運用、費用が単純になる。
- 意味類似検索は提供しない。
- trigramのindex容量と短語fallbackの走査コストを上限で管理する。

この決定は `spec/adr/005-search-index-via-outbox.md` を置換する。
