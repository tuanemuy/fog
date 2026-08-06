# Export

ユーザーの全データ（メモ・ドキュメント・トピック）を可搬形式（Markdown のファイルツリー）で書き出すドメイン。エンティティは持たず、値オブジェクト・ドメインサービス・ポートで構成する（ADR-004）。

対応する上流成果物: requirements.md 5.3、シナリオ S-ST-02、画面 P-13、ADR-002。

## ユビキタス言語

| 英語 | 日本語 | 定義 |
|---|---|---|
| Export | エクスポート | ユーザーの全データを可搬形式で書き出す操作。範囲は ADR-002 に従う |
| Export Scope | エクスポート範囲 | 全メモ・全ドキュメント・全トピック（完了済みトピックを含む）。各項目は最新リビジョンのみ。ゴミ箱内の項目とリビジョン履歴は含めない |
| Export Source | エクスポート対象データ | エクスポート範囲を満たす、ある時点のデータの読み取り専用スナップショット |
| Export Archive | エクスポートアーカイブ | Markdown ファイルツリーとして構成された出力物。zip 化前の論理表現 |
| Manifest | マニフェスト | アーカイブのルートに置く `index.md`。エクスポート日時・件数・範囲の説明を記す |
| Slug | スラッグ | トピック名・ドキュメントタイトルから導出する、ファイルシステム安全なディレクトリ名・ファイル名 |
| Source Link | 出典リンク | ドキュメントの出典メモへの参照。アーカイブ内では frontmatter の `sources` として、メモ日別ファイルへの相対パスで表現する |
| Archive Binary | アーカイブバイナリ | Export Archive を zip エンコードした、ダウンロード可能なバイナリ |

## エンティティ

なし。エクスポートは既存データからの純粋な導出であり、それ自体の永続状態を持たない（ADR-004）。生成ジョブの状態も持たない（後述「生成フロー」参照）。

## 値オブジェクト

他ドメインの型は ID 参照のみ（`UserId` は identity、`MemoId` は memo、`TopicId` / `DocumentId` は knowledge の値オブジェクト）。

### ExportRequest

エクスポートの実行指示。

| フィールド | 型 | 説明 |
|---|---|---|
| userId | UserId | エクスポート対象ユーザー |
| timezone | string | IANA タイムゾーン名（例: `Asia/Tokyo`）。メモの日別分割と日時表記に使う。UI がブラウザのタイムゾーンを渡す |

- バリデーション: `timezone` は IANA タイムゾーン名として解決可能であること（`Intl.DateTimeFormat` で解決できない値は `BusinessRuleError(ExportErrorCode.InvalidTimezone)`）。空文字は不可
- 等価性: 全フィールドの値の一致

### ExportSource

`ExportSourceReader` が返す読み取り専用スナップショット。エクスポート範囲（ADR-002）を満たしていることはポート実装（アダプター）の契約とし、ドメイン側は再検査しない。

| フィールド | 型 | 説明 |
|---|---|---|
| memos | readonly MemoExportEntry[] | ゴミ箱内を除く全メモ |
| topics | readonly TopicExportEntry[] | ゴミ箱内を除く全トピック（完了済みを含む） |
| documents | readonly DocumentExportEntry[] | ゴミ箱内を除く全ドキュメント |

- バリデーション: `documents[].topicId` は `topics` のいずれかに存在すること（不整合は `BusinessRuleError(ExportErrorCode.OrphanDocument)`。「ドキュメントは必ずトピックに属する」の防衛的検査）
- 等価性: 内容の一致（実用上は比較しない）

#### MemoExportEntry

| フィールド | 型 | 説明 |
|---|---|---|
| memoId | MemoId | |
| content | string | 最新リビジョンの本文（非構造テキスト） |
| postedAt | Date | 初版の投稿日時 |
| updatedAt | Date | 最新リビジョンの日時 |

#### TopicExportEntry

| フィールド | 型 | 説明 |
|---|---|---|
| topicId | TopicId | |
| name | string | |
| description | string \| null | |
| archived | boolean | 完了済みか |
| createdAt | Date | |

#### DocumentExportEntry

| フィールド | 型 | 説明 |
|---|---|---|
| documentId | DocumentId | |
| topicId | TopicId | 所属トピック |
| title | string | |
| content | string | 最新リビジョンの本文（Markdown 互換の構造化テキスト） |
| sourceMemoIds | readonly MemoId[] | 出典メモ。ハードデリート済みメモの ID は含まない（ADR-003 に整合。ソフトデリート済みメモの ID は含み、出典としては `deleted: true` で出力する） |
| createdAt | Date | |
| updatedAt | Date | 最新リビジョンの日時 |

### ExportFile

アーカイブ内の 1 ファイル。

| フィールド | 型 | 説明 |
|---|---|---|
| path | string | アーカイブルートからの相対パス（`/` 区切り） |
| content | string | UTF-8 の Markdown テキスト |

- バリデーション: `path` は空でなく、先頭 `/`・`..` セグメント・空セグメントを含まない。拡張子は `.md`。違反は `BusinessRuleError(ExportErrorCode.InvalidArchivePath)`
- 等価性: `path` と `content` の一致

### ExportArchive

出力物の論理表現。ファイルツリー構造は後述の「アーカイブ構成」に従う。

| フィールド | 型 | 説明 |
|---|---|---|
| rootDirName | string | ルートディレクトリ名。`fog-export-YYYYMMDD`（`exportedAt` を `timezone` で表記） |
| files | readonly ExportFile[] | `path` の辞書順にソート済み |
| exportedAt | Date | 生成時刻 |

- バリデーション: `files` 内で `path` が一意であること（重複は `BusinessRuleError(ExportErrorCode.DuplicateArchivePath)`）
- 等価性: 全フィールドの一致。同一の `ExportSource`・`exportedAt`・`timezone` からは常にバイト同一のアーカイブが導出される（決定性。テスト容易性のための契約）

### ArchiveBinary

`ArchiveWriter` の出力。

| フィールド | 型 | 説明 |
|---|---|---|
| filename | string | `{rootDirName}.zip` |
| contentType | string | `application/zip` 固定 |
| data | Uint8Array | zip バイナリ |

- バリデーション: なし（アダプターが生成する終端の値）
- 等価性: 実用上比較しない

## アーカイブ構成

`ExportRenderer` が生成するファイルツリー。実装者はこの節の規則どおりに出力すること。

```text
fog-export-20260720/
├── index.md                     マニフェスト
├── memos/
│   ├── 2026-07-01.md            日別のメモ（timezone 基準の日付）
│   └── 2026-07-02.md
└── topics/
    ├── {topic-slug}/
    │   ├── index.md             トピックのメタ情報
    │   ├── {document-slug}.md
    │   └── {document-slug}.md
    └── {topic-slug}/
        └── index.md             ドキュメント 0 件でも index.md は出力する
```

- メモが 0 件なら `memos/` を、トピックが 0 件なら `topics/` を出力しない
- 全ファイル UTF-8・改行 LF。ファイル間の並びは `path` の辞書順

### スラッグ規則

トピック名・ドキュメントタイトルから次の手順で導出する。

1. Unicode NFC 正規化し、前後の空白を除去する
2. 空白の連続を `-` 1 つに置換する
3. `/ \ : * ? " < > | #` と制御文字を除去する（日本語などの非 ASCII 文字はそのまま残す）
4. 先頭・末尾の `.` と `-` を除去する
5. 結果が空なら `untitled` とする
6. 50 文字（コードポイント）を超える場合は 50 文字で切り詰める
7. 同一階層で衝突した場合、`createdAt` 昇順で 2 件目以降に `-2`, `-3`, … を付す（切り詰め後に再衝突しても同様）

### マニフェスト（`index.md`）

```markdown
---
type: manifest
exportedAt: 2026-07-20T09:30:00+09:00
timezone: Asia/Tokyo
counts:
  memos: 128
  topics: 9
  documents: 21
---

# fog エクスポート

- 対象: すべてのメモ・ドキュメント・トピック（完了済みトピックを含む）。各項目は最新リビジョンのみ
- 含まれないもの: ゴミ箱内の項目、リビジョン履歴
```

日時表記はすべて `timezone` によるオフセット付き ISO 8601（`YYYY-MM-DDTHH:mm:ss±hh:mm`）とする。

### メモ日別ファイル（`memos/YYYY-MM-DD.md`）

`postedAt` を `timezone` で日付に丸めてグルーピングする。ファイル内は `postedAt` 昇順。

```markdown
---
type: memos
date: 2026-07-01
---

## 09:12 (01HZX3Q8KJ...)

メモ本文をそのまま出力する。

## 21:04 (01HZX9A2MP...)

別のメモの本文。
```

- 見出しは `## HH:mm (memoId)`。`memoId` を見出しに含めることで、出典リンクからの照合とアプリへの逆引きを可能にする
- 本文は最新リビジョンをそのまま出力する（エスケープしない。メモ内の `##` 行が見出しと衝突し得ることは許容する）
- 同一分に複数メモがある場合も 1 メモ 1 見出し（`postedAt` 昇順、ID はそれぞれのもの）

### トピックメタ（`topics/{topic-slug}/index.md`）

```markdown
---
type: topic
topicId: 01HZXA...
name: "読書メモ"
archived: false
createdAt: 2026-06-01T10:00:00+09:00
---

トピックの説明文（description）。null なら本文なし。
```

### ドキュメント（`topics/{topic-slug}/{document-slug}.md`）

```markdown
---
type: document
documentId: 01HZXB...
title: "エクスポート設計の論点"
topic: "読書メモ"
createdAt: 2026-07-01T10:00:00+09:00
updatedAt: 2026-07-15T18:30:00+09:00
sources:
  - memoId: 01HZX3Q8KJ...
    postedAt: 2026-07-01T09:12:00+09:00
    file: ../../memos/2026-07-01.md
  - memoId: 01HZW0...
    deleted: true
---

本文（最新リビジョン）をそのまま出力する。
```

- メタデータはすべて frontmatter に置き、本文には一切挿入しない（本文の可搬性を守る）
- 出典リンクは `sources` 配列で表現する。`file` は当該メモが載る日別ファイルへの相対パス。読み手は `file` を開き、見出しの `(memoId)` で該当メモを特定する
- 出典メモがソフトデリート済み（ゴミ箱内）の場合、そのメモはアーカイブに存在しないため `file` を出力せず `deleted: true` を付す。ハードデリート済みの出典はエントリ自体を出力しない（ADR-003 の表示規則に整合）
- frontmatter の文字列値は YAML として安全に引用符で囲む

## ドメインサービス

### ExportRenderer

- 責務: エクスポート対象データのスナップショットから Export Archive を導出する純関数
- 依存するポート: なし（純関数。I/O を行わない）

| メソッド | 引数 | 戻り値 | 処理概要 |
|---|---|---|---|
| render | source: ExportSource, exportedAt: Date, timezone: string | ExportArchive | 「アーカイブ構成」の規則に従い、マニフェスト・メモ日別ファイル・トピックメタ・ドキュメントファイルを生成する。スラッグ導出・衝突解決・日別グルーピング・出典の相対パス解決を含む。`ExportSource` の防衛的検査（OrphanDocument）もここで行う |

- `exportedAt` は引数で受け取る（ドメインは `new Date()` を呼ばない。docs/backend_implementation_example.md の規約）
- 出典の相対パス解決: `sourceMemoIds` の各 ID を `source.memos` から引き、見つかればその `postedAt` から日別ファイルパスを算出する。見つからない ID はソフトデリート済みとみなし `deleted: true` とする

## ポート

### ExportSourceReader

- 目的: エクスポート範囲（ADR-002）を満たすスナップショットを一括で読み出す

memo / knowledge のリポジトリ（`TransactionalRepository` ベース）は再利用しない。理由: それらは集約単位の読み書きと OCC のための契約であり、全件横断のスナップショット読みには不適。また export → memo / knowledge の依存は「ID および読み取り専用ビュー」に限る（ADR-004、domains/index.md）。専用の読み取りポートを export ドメインに定義し、アダプターが memo / knowledge の永続化テーブルを直接読んで `ExportSource` に組み立てる。

| メソッド | 引数 | 戻り値 | 処理概要 |
|---|---|---|---|
| readAll | （なし） | ExportSource | 全メモ・全トピック・全ドキュメントを読み出す。ソフトデリート済み（ゴミ箱内）の項目を除外し、各項目は最新リビジョンの内容で返す。`sourceMemoIds` にはハードデリート済みメモの ID を含めない |

- **同期契約である**（`Promise` を返さない）。`userId` はユーザー単位 Durable Object の選択で消費済みなので引数に取らない（domains/index.md「テナント分離」「ポートの同期契約」）
- エラー: DB 障害は `SystemError(DatabaseError)`。範囲規則（ゴミ箱除外・最新リビジョンのみ）の充足はこのポート実装の契約
- **Durable Object 内の1回のトランザクションで読み切り、値として返す。** 分割して読むとスナップショットの一貫性が失われるので採らない。エクスポート内の相互参照が一時点で整合していることをこれで保証する
- **1回のエクスポートで返せる総バイト数には上限がある。** 超過は拒否する（`SystemError` 系）。上限値そのものは実装側が持つ運用値であり、ドメインの規則としては「上限があること」「超過は拒否されること」までを定める

### ArchiveWriter

- 目的: Export Archive を zip バイナリにエンコードする

| メソッド | 引数 | 戻り値 | 処理概要 |
|---|---|---|---|
| write | archive: ExportArchive | ArchiveBinary | `rootDirName/` 配下に各 `ExportFile` を格納した zip を生成し、`{rootDirName}.zip` として返す |

- エラー: エンコード失敗は `SystemError(ArchiveEncodingError)`
- **実行位置は Durable Object の外（リクエストを受ける側）である。** zip エンコードは CPU を長く使うので、単一スレッドの Durable Object の中で回すとそのユーザーの他のリクエストが止まる
- 内部でストリーミング生成するか一括生成するかは実装詳細であり、ポート契約に含めない

## 生成フロー

同期生成とする。ユースケースはリクエスト内で「読み出し → レンダリング → zip 化」を行い、レスポンスとしてバイナリを返す。UI（P-13）はリクエスト進行中に「生成中」を表示し、完了レスポンスでダウンロードさせる。これで S-ST-02 のエッジケース「生成中の表示が出る → 完了を待って受け取れる」を満たす。

**実行位置は2つに分かれる。** 読み出し（`ExportSourceReader.readAll`）はユーザー単位 Durable Object の中で1回のトランザクションとして行い、レンダリング（`ExportRenderer.render`）と zip エンコード（`ArchiveWriter.write`）はリクエストを受ける側で行う。分ける理由は上限と CPU の2つで、**読み出しを分割せずに済ませるために総バイト数の上限を置き、超過は拒否する**。

非同期（ジョブ投入 → ポーリング → ダウンロード URL 発行）は採用しない。理由: ジョブ状態の永続化にエンティティが必要になり「export はエンティティを持たない薄いドメイン」（ADR-004）に反すること、対象が個人スコープのテキストデータでありリクエスト内で完了する規模であること。将来、同期生成が実行時間制限に収まらなくなった場合に ADR を起こして再検討する。

**DO ローカル Outbox が加わった後も export は同期生成のままである**（[.adr/013](../../.adr/013-do-local-outbox-and-alarm-relay.md)）。export はイベントを定義せず、`outbox_events` にも `jobs` にも行を作らない — 生成の完了責任はリクエスト自身が持ち、委譲する consumer が無いからである（全数は [async/index.md](../async/index.md)）。

## ユースケース（概要）

詳細は Phase 4 で定義する。

- exportAllData ★（人間 UI 専用）— `ExportRequest` を受け、`ExportSourceReader.readAll` → `ExportRenderer.render` → `ArchiveWriter.write` の順で `ArchiveBinary` を返す。Web UI 専用（P-13）。AI トークンには公開しない（requirements.md 4.5 の公開インターフェースに含まれない）
