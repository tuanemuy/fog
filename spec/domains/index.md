# ドメイン一覧

ドメイン境界の判断は [ADR-004](../adr/004-domain-boundaries.md) を参照。

| ドメイン | 責務（一文） | 主な集約 |
|---|---|---|
| [identity](./identity.md) | ユーザーの認証・AIクライアント認可・ユーザー設定を管理する | User, AiClientConnection |
| [memo](./memo.md) | タイムラインに積まれるメモとそのリビジョン履歴を管理する | Memo |
| [knowledge](./knowledge.md) | トピック・ドキュメント・出典リンクと、ドキュメントのリビジョン履歴を管理する | Topic, Document |
| [search](./search.md) | メモ・ドキュメント横断のハイブリッド検索と検索インデックスの維持を担う | （検索クエリ・結果の値オブジェクトとポートのみ） |
| [trash](./trash.md) | ソフトデリート済み項目の横断閲覧・復元・ハードデリート・保持期限の規則を定める | （横断ビューとドメインサービス。項目自体の削除状態は各ドメインが持つ） |
| [export](./export.md) | ユーザーの全データを可搬形式（Markdown）で書き出す | （エクスポート生成サービスとポート） |

## ドメイン間の依存方向

```
identity ←─ memo ←─ knowledge
   ↑          ↑        ↑
   └── search ┘────────┘
   └── trash（memo, knowledge に依存）
   └── export（memo, knowledge に依存）
```

- すべてのドメインは identity の `UserId` を参照する（ID参照のみ）
- knowledge は memo の `MemoId` を出典リンクとして参照する（ID参照のみ。エンティティ直接参照はしない）
- search / trash / export は memo・knowledge のエンティティをIDおよび読み取り専用ビューで扱う
- 循環依存はない

## 共通の横断事項

- **操作主体（Actor）**: リビジョンの「誰が」は、人間ユーザーまたはAIクライアント（トークン識別）を表す `Actor` として identity が定義し、memo / knowledge が利用する
- **テナント分離**: ユーザーのデータは本人にのみ属する（requirements 5.1）。リポジトリの読み書きは常に `userId` でスコープし、外部入力の ID を受けるメソッドは `userId` を第一引数に取る。他ユーザーの ID を指定した操作は NotFound として扱う（ID が実在しても所有者が異なれば「存在しない」= null / 空。存在の有無も漏らさない）。ユースケース層の追加検証（取得後の `entity.userId` 照合）に依存しない構造的保証とする。例外は Outbox 経由の信頼済み内部イベントを契機とするワーカー（search の indexer consumer 等）のみで、外部入力 ID を扱わないため専用の読み取り経路を用いる
- **権限の非対称性**: ハードデリート・ゴミ箱操作・履歴閲覧はAIトークンのスコープに存在しない。この制約は二層で構造的に表現する（domains/identity.md「TokenScope」）: `actor` を入力に持つ人間 UI 専用（★）ユースケースは `actor` の型を `UserActor` に限定して型エラーで排除し、`actor` を持たない ★ ユースケースは application 層の公開範囲（AI 側 presentation に配線しない配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙で排除する
- **ドメインイベント + Outbox**: エンティティの作成・更新・削除はドメインイベントを発行し、検索インデックスの更新（search）は outbox 経由の consumer が行う（ADR-005）
