# ドメイン一覧

ドメイン境界の判断は [ADR-004](../adr/004-domain-boundaries.md) を参照。

| ドメイン | 責務（一文） | 主な集約 |
|---|---|---|
| [identity](./identity.md) | ユーザーの認証・AIクライアント認可・ユーザー設定を管理する | User, AiClientConnection |
| [memo](./memo.md) | タイムラインに積まれるメモとそのリビジョン履歴を管理する | Memo |
| [knowledge](./knowledge.md) | トピック・ドキュメント・出典リンクと、ドキュメントのリビジョン履歴を管理する | Topic, Document |
| [search](./search.md) | メモ・ドキュメント横断の全文検索の問い合わせを担う | （検索クエリ・結果の値オブジェクトとポートのみ） |
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

- identity の `UserId` はドメイン間で ID として参照されるが、**リポジトリ・ポートの引数には現れない**（ユーザー単位 Durable Object の選択で消費済み。下記「テナント分離」）
- knowledge は memo の `MemoId` を出典リンクとして参照する（ID参照のみ。エンティティ直接参照はしない）
- search / trash / export は memo・knowledge のエンティティをIDおよび読み取り専用ビューで扱う
- 循環依存はない

## 共通の横断事項

- **操作主体（Actor）**: リビジョンの「誰が」は、人間ユーザーまたはAIクライアント（トークン識別）を表す `Actor` として identity が定義し、memo / knowledge が利用する
- **テナント分離**: ユーザーのデータは本人にのみ属する（requirements 5.1）。**ユーザーのドメインデータはユーザー単位の SQLite-backed Durable Object に物理分離される**（requirements 5.1）。`userId` は Durable Object の選択で消費されるので、DO 内のリポジトリ・ポートは `userId` を引数に取らない。**構造的保証の在り処は「型（第一引数の `userId`）」ではなく「到達可能性」である** — 他ユーザーの Durable Object stub を得る経路が存在しないので、誤った `userId` を渡す経路そのものが無い。他ユーザーの ID を指定した操作は NotFound として扱う（DO の中に他ユーザーの行が原理的に存在しないので、結果は null / 空になる。存在の有無も漏らさない）。ユースケース層の追加検証（取得後の `entity.userId` 照合）に依存しない構造的保証とする。**例外は無い**
- **権限の非対称性**: ハードデリート・ゴミ箱操作・履歴閲覧はAIトークンのスコープに存在しない。この制約は二層で構造的に表現する（domains/identity.md「TokenScope」）: `actor` を入力に持つ人間 UI 専用（★）ユースケースは `actor` の型を `UserActor` に限定して型エラーで排除し、`actor` を持たない ★ ユースケースは application 層の公開範囲（AI 側 presentation に配線しない配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙で排除する
- **ポートの同期契約**: 全ドメインポートは同期契約である（`Promise` を返さない）。書き込みは Durable Object 内の単一の同期トランザクションで完結し、その中では `await` を挟めないためである。**例外は `PasswordHasher` と `MailSender` の2つで、これは列挙であって導出規則ではない** — 残る理由は「暗号計算と外部 I/O であり、実装できる API が非同期しか無い」ことである。**トランザクションの外で動くことは `Promise` の根拠にならない**（`ArchiveWriter.write` は Durable Object の外で動くが同期契約である。domains/export.md）。新しいポートを足すときは、この2つに並べてよいかを「非同期 API しか無いか」で判定する。**Outbox の relay（Queue への publish）はこの列挙を開かない** — `queue.send()` はアダプター（DO クラス）の内部実装であり、ドメインもユースケースも触らないからである（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。**スロットル窓の `PasswordResetThrottlePort` も同期契約なので列挙は2つのまま動かない**（identity.md）
- **派生データの更新**: 検索インデックスのような派生データは、本体を書くのと同一のトランザクションの中で更新する（[.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md)。`spec/adr/005`（superseded））。**派生データを別ストアへ非同期に反映する経路は持たない** — 検索 projection に indexer は存在せず、即時整合である（search.md「インデックスの維持」）。業務上の変更履歴はリビジョン（`memo_revisions` / `document_revisions`）が持つ
- **外部への配送**: 派生データの更新とは別に、**外部への配送は DO ローカル Outbox が担う**（`outbox_events` → Alarm relay → Queue → consumer → DLQ。[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。**登録口はドメインポートではなく UoW コンテキストの `enqueueEvent` 1つだけ**であり、業務データの書き込み・FTS5 projection の更新と同じ `transactionSync` の中でイベント行が追加される（rollback すると3つとも巻き戻る）。**どのドメインがどのイベントを発行するかの全数は [async/index.md](../async/index.md) が持つ** — 定義済みのイベント型は identity の1件だけで、memo / knowledge / search / trash / export はイベントを定義しない
- **ドメインイベントの契約**: ドメインが返すのは **identity-less な draft** である（`{ type, payload, occurredAt, aggregateId }`）。**`EventId` はアプリケーション層が付ける** — UoW 実装が `IdGenerator` から採番するので、ドメインは id 生成に触らない。**イベントを発行する**エンティティのファクトリ / 遷移は `{ entity, eventDrafts }` の形で draft を返し、ユースケースがそれを `enqueueEvent` へ渡す。**現状そのような遷移は1つも存在しない**ので、既存の「状態遷移は次状態のエンティティだけを返す」（memo.md / knowledge.md）は動かない — この形は将来イベントを発行する遷移が現れたときの契約であって、既存のファクトリのシグネチャを変える指示ではない。**エンティティ遷移を伴わないイベントは draft ファクトリから出す** — `{ entity, eventDrafts }` は遷移から出るイベント用の形なので、遷移しない発行点（現状は identity の1件だけで、`requestPasswordReset` は `User` も `CredentialMapping` も遷移させない）はそこに乗らない。**その場合もユースケースが draft をリテラルで組み立てることは無く、ドメインが持つ draft ファクトリ1本が `type` の文字列・`aggregateId` の選び方・payload の形を決める**（決めないと「行の形が一様であること」を保証する主体が誰も居なくなる）。**payload に PII と再利用可能な秘密を載せない**（衛生規則の正本は [async/index.md](../async/index.md)）。**配送のための識別子（`EventId` / 宛先 DO の routing key）は payload に入れない** — どちらもアプリケーション層 / アダプターが付ける。契約の詳細は identity.md「ドメインイベント」
