# Export ユースケース

export ドメインのユースケース定義。対応する上流成果物: [domains/export.md](../domains/export.md)、シナリオ S-ST-02、画面 P-13、ADR-002、ADR-004。

export ドメインはエンティティを持たないため、リポジトリと UoW は登場しない。ユースケースは読み取り専用ポート（`ExportSourceReader`）・純関数のドメインサービス（`ExportRenderer`）・エンコードポート（`ArchiveWriter`）のオーケストレーションに徹する。

**実行位置が2つに分かれる。** 読み出しはユーザー単位 Durable Object の中で1回の `transactionSync` として行い、レンダリングと zip エンコードはリクエストを受ける側で行う（domains/export.md）。

## exportAllData ★（人間 UI 専用）

### 概要

対象ユーザーの全データ（メモ・ドキュメント・トピック）を Markdown ファイルツリーの zip アーカイブとして同期生成し、ダウンロード可能なバイナリを返す。エクスポート範囲は ADR-002 に従う（完了済みトピックを含む全件・各項目は最新リビジョンのみ・ゴミ箱内とリビジョン履歴は含めない）。

- Web UI 専用（P-13）。AI トークンには公開しない（requirements.md 4.5 の公開インターフェースに含まれない）。本ユースケースは `actor` を入力に持たないため型による強制は主張せず、AI 側 presentation（MCP / REST）に配線しないこと（application 層の公開範囲 = 配線分離）＋ AI トークンの認可ミドルウェアの許可ユースケース列挙に含めないことで構造的に排除する（domains/identity.md「TokenScope」の二層防壁、domains/index.md「権限の非対称性」）
- 同期生成。ユースケースはリクエスト内で「読み出し → レンダリング → zip 化」を完了し、レスポンスとしてバイナリを返す。UI はリクエスト進行中に「生成中」を表示し、完了レスポンスでダウンロードさせる（S-ST-02 エッジケース対応。domains/export.md「生成フロー」）。**DO ローカル Outbox が加わった後も同期生成のままである** — export はイベントを1つも発行せず、ジョブも投入しない（[async/index.md](../async/index.md)）

### 入力DTO

`ExportAllDataInput`

| フィールド | 型 | 必須 | バリデーション |
|---|---|---|---|
| userId | string | 必須 | 認証済みセッションのユーザー ID。`UserId.create` で妥当な ID 形式であること |
| timezone | string | 必須 | IANA タイムゾーン名（例: `Asia/Tokyo`）として解決可能であること。空文字不可。UI がブラウザのタイムゾーンを渡す |

- `userId` はハンドラーが認証済みセッションから解決して渡す。外部入力の他ユーザー ID を受け付ける経路はない（テナント分離）
- `timezone` の検証は `ExportRequest` 値オブジェクトの構築時に行う（バリデーションロジックはドメイン層に置く）

### 出力DTO

`ExportAllDataOutput`（`ArchiveBinary` の投影。フィールドはプリミティブ）

| フィールド | 型 |
|---|---|
| filename | string（`fog-export-YYYYMMDD.zip`。日付は `exportedAt` を `timezone` で表記） |
| contentType | string（`application/zip` 固定） |
| data | Uint8Array（zip バイナリ） |

ハンドラーはこれをダウンロード応答（`Content-Disposition: attachment; filename=...`）として返す。

### 処理フロー

1. `now = container.clock.now()` で生成時刻 `exportedAt` を解決する（ドメインは `new Date()` を呼ばない）
2. `UserId.create(input.userId)`・`ExportRequest.create({ userId, timezone })` で値オブジェクトを構築する。`timezone` が IANA タイムゾーン名として解決できなければ `BusinessRuleError(ExportErrorCode.InvalidTimezone)`
3. `input.userId` で対象のユーザー単位 Durable Object を選び、その中で `ExportSourceReader.readAll()` を1回の `transactionSync` として実行してスナップショット `ExportSource` を読み出し、値として受け取る。範囲規則（ゴミ箱除外・最新リビジョンのみ・`sourceMemoIds` からハードデリート済みメモ ID を除外）の充足はポート実装の契約。**分割して読まない** — 分けるとスナップショットの一貫性が失われるためで、代わりに**1回のエクスポートで返せる総バイト数に上限を置き、超過は拒否する**（`SystemError` 系）
4. **リクエストを受ける側で** `ExportRenderer.render(source, exportedAt, request.timezone)` により `ExportArchive` を導出する（純関数）。マニフェスト・メモ日別ファイル・トピックメタ・ドキュメントファイルの生成、スラッグ導出・衝突解決、日別グルーピング、出典の相対パス解決、`ExportSource` の防衛的検査（OrphanDocument）を含む
5. 同じくリクエストを受ける側で `ArchiveWriter.write(archive)` により zip エンコードし `ArchiveBinary` を得る（CPU を長く使うので Durable Object の中では回さない）
6. `ArchiveBinary` を出力 DTO に投影して返す

ビジネスロジック（アーカイブ構成・スラッグ規則・出典リンク解決）はすべて `ExportRenderer` と値オブジェクトに置き、ユースケースはポートとドメインサービスを順に呼ぶだけとする。

### エラーケース

| 条件 | エラー | 種類 |
|---|---|---|
| `timezone` が空文字、または IANA タイムゾーン名として解決できない | `BusinessRuleError(ExportErrorCode.InvalidTimezone)` | ビジネスルール違反（値オブジェクト構築時） |
| `userId` が ID として不正な形式 | `ValidationError` | バリデーションエラー（通常は認証済みセッション由来のため発生しない） |
| `ExportSource` 内に `topics` に存在しない `topicId` を持つドキュメントがある | `BusinessRuleError(ExportErrorCode.OrphanDocument)` | ビジネスルール違反（`ExportRenderer.render` の防衛的検査） |
| 生成した `ExportFile.path` が不正（先頭 `/`・`..` セグメント・空セグメント・拡張子違反等） | `BusinessRuleError(ExportErrorCode.InvalidArchivePath)` | ビジネスルール違反（内部不変条件。発生すれば実装バグ） |
| `ExportArchive.files` 内で `path` が重複 | `BusinessRuleError(ExportErrorCode.DuplicateArchivePath)` | ビジネスルール違反（内部不変条件。発生すれば実装バグ） |
| 読み出し結果の総バイト数が上限を超える | `SystemError` 系 | 容量制約（上限値は実装側が持つ運用値） |
| スナップショット読み出し時の DB 障害 | `SystemError(DatabaseError)` | 外部サービスエラー（`ExportSourceReader`） |
| zip エンコード失敗 | `SystemError(ArchiveEncodingError)` | 外部サービスエラー（`ArchiveWriter`） |

エラーにならないケース:

- **データが 0 件**（メモ・トピック・ドキュメントすべて空）はエラーではない。`ExportRenderer` はマニフェスト（`index.md`、counts はすべて 0）のみを含むアーカイブを生成し、空アーカイブの zip を正常応答として返す。メモが 0 件なら `memos/` を、トピックが 0 件なら `topics/` を出力しない規則の帰結
- 出典メモがソフトデリート済み（`sourceMemoIds` の ID が `source.memos` に見つからない）のもエラーではない。当該出典は `deleted: true` として frontmatter に出力する
