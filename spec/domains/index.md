# ドメイン一覧

ドメイン境界の判断は [ADR-004](../adr/004-domain-boundaries.md) を参照。

| ドメイン | 責務（一文） | 主な集約 |
|---|---|---|
| [identity](./identity.md) | credential不変条件・AIクライアント認可・User Data設定を管理する | AccountIdentity, Profile, Settings, AiClientConnection |
| [memo](./memo.md) | タイムラインに積まれるメモとそのリビジョン履歴を管理する | Memo |
| [knowledge](./knowledge.md) | トピック・ドキュメント・出典リンクと、ドキュメントのリビジョン履歴を管理する | Topic, Document |
| [search](./search.md) | メモ・ドキュメント横断のFTS5全文検索と同期検索射影を担う | （検索クエリ・結果・transaction-scoped portのみ） |
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
- **テナント分離**: ユーザーのデータは本人にのみ属する（requirements 5.1）。認証済みcanonical `userId`だけからUser Data DOを選び、外部入力にDO ID・partition key・userId overrideを持たせない。object内のrepositoryは別ユーザーを指定する引数を持たず、物理分離をユースケース層の事後照合に依存させない
- **権限の非対称性**: ハードデリート・ゴミ箱操作・履歴閲覧はAIトークンのスコープに存在しない。この制約は二層で構造的に表現する（domains/identity.md「TokenScope」）: `actor` を入力に持つ人間 UI 専用（★）ユースケースは `actor` の型を `UserActor` に限定して型エラーで排除し、`actor` を持たない ★ ユースケースは application 層の公開範囲（AI 側 presentation に配線しない配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙で排除する
- **同期検索射影**: memo/document本体とFTS5射影はUser Data DOの`SemanticCommitPort.transactionSync`で同時に確定する。domain eventを残す場合は監査または同一transaction内の業務反応に限定し、transportには使わない
- **永続ジョブ**: 外部I/OとretentionだけをAlarmで処理する。jobはlease expiry/reclaim、owner token CAS、provider idempotency、poison隔離を持つ
