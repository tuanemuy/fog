# ADR-005: Durable Object class lifecycleは宣言的exportsで管理する

## ステータス

承認済み

## コンテキスト

fogには保護すべき既存Durable Object namespaceがなく、導入時点のWranglerは
classの現状態を宣言する`exports`を提供している。従来の順序付きmigration履歴を
新規namespaceへ持ち込む理由がない。

## 決定

User Data、Identity Directory、Account Homeの3 classを、すべての環境で
`type = "durable-object"`、`storage = "sqlite"`の宣言的exportsとして管理する。
class lifecycleと各object内部のforward-only lazy schema migrationは別に扱い、
後者には再実行・新しすぎるversion・rollbackのテストを置く。

## 検討した代替案

- 従来の`migrations`配列を使う: 既存namespaceがなく、履歴を積む利点がない。
- 環境ごとに方式を変える: staging/localとproductionの構成差が増える。

## 影響

- classの現状態とSQLite backendが設定から直接分かる。
- 初回deploy後に旧migration方式へ戻す場合は、新しいADRと移行計画が必要になる。
- platform class lifecycleとobject内schema versionを別々に保守する。
