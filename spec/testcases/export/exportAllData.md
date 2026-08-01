# テストケース: exportAllData

[usecases/export.md](../../usecases/export.md) の exportAllData に対するテストケース。アーカイブ構成・スラッグ規則・frontmatter は [domains/export.md](../../domains/export.md)、エクスポート範囲は ADR-002、ハードデリート済み出典の扱いは ADR-003 に従う。

**実行位置の前提。** `ExportSourceReader.readAll` はユーザー単位 Durable Object の中の**1回の `transactionSync`** で完結し、その1回で全データの一貫したスナップショットを読み出す。`ExportRenderer.render` と `ArchiveWriter.write` は request Worker で回る（単一スレッドの Durable Object を長い CPU 仕事で占有させないため）。**1回のエクスポートで返せる総バイト数には上限があり、超過は拒否する。**

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メモ2件（`timezone` 基準で別日）・トピック1件（ドキュメント2件）が存在する | `timezone: "Asia/Tokyo"` でエクスポートする | `filename: fog-export-YYYYMMDD.zip`（日付は `exportedAt` の Asia/Tokyo 表記）・`contentType: "application/zip"`・zip バイナリが返る。ルートは `fog-export-YYYYMMDD/` で、`index.md`・`memos/`（日別2ファイル）・`topics/{topic-slug}/`（`index.md` + ドキュメント2ファイル）を含む | |
| 上記のアーカイブが生成済み | ルートの `index.md` を検査する | frontmatter は `type: manifest`・`exportedAt`（timezone のオフセット付き ISO 8601）・`timezone`・`counts`（memos: 2, topics: 1, documents: 2）。本文に対象範囲（完了済みトピックを含む・最新リビジョンのみ）と非対象（ゴミ箱・リビジョン履歴）の説明がある | |
| `postedAt` が Asia/Tokyo で同日となるメモ3件が存在する（うち2件は同一分） | エクスポートし `memos/YYYY-MM-DD.md` を検査する | 1ファイルに3メモが `postedAt` 昇順で並ぶ。見出しは `## HH:mm (memoId)` で、同一分の2件もそれぞれ別見出し・それぞれの ID。本文は最新リビジョンがそのまま（エスケープなし）出力される | |
| UTC では同日・Asia/Tokyo では別日となる `postedAt` のメモ2件が存在する（例: 14:00Z と 16:00Z） | `timezone: "Asia/Tokyo"` でエクスポートする | 日別グルーピングが timezone 基準で行われ、2件は別の日別ファイル（例: `2026-07-01.md` と `2026-07-02.md`）に分かれる | |
| 本文に `##` で始まる行を含むメモが存在する | エクスポートする | 本文はエスケープされずそのまま出力される（見出しとの衝突は許容仕様） | |
| トピック（`description` あり）が存在する | エクスポートし `topics/{topic-slug}/index.md` を検査する | frontmatter は `type: topic`・`topicId`・`name`（引用符で囲む）・`archived: false`・`createdAt`（オフセット付き ISO 8601）。本文に description が出力される | |
| `description` が null のトピックが存在する | エクスポートする | トピックメタは frontmatter のみで本文なし | |
| 出典メモ2件（存命）を持つドキュメントが存在する | エクスポートし `topics/{topic-slug}/{document-slug}.md` を検査する | frontmatter は `type: document`・`documentId`・`title`・`topic`（所属トピック名）・`createdAt`・`updatedAt`・`sources`。各 source は `memoId`・`postedAt`・`file`（当該メモが載る日別ファイルへの相対パス `../../memos/YYYY-MM-DD.md`）を持つ。本文は最新リビジョンのみで、メタデータは本文に挿入されない | |
| `sourceMemoIds` に `source.memos` に存在しない ID（ソフトデリート済み出典）を含むドキュメントが存在する | エクスポートする | 当該 source は `memoId` と `deleted: true` のみで出力され、`file`・`postedAt` は出力されない。他の存命出典は通常どおり出力される | |
| 出典メモがハードデリート済み（`ExportSourceReader` の契約により `sourceMemoIds` に ID が含まれない）のドキュメントが存在する | エクスポートする | 当該出典は `sources` にエントリ自体が出力されない（ADR-003）。出典が全てハードデリート済みなら `sources` は空で、ドキュメント本文には影響しない | |
| `archived: true` の完了済みトピック（ドキュメント1件付き）が存在する | エクスポートする | 完了済みトピックもエクスポートに含まれ（ADR-002）、`index.md` の frontmatter に `archived: true` が出力される | |
| ゴミ箱内のメモ・ドキュメント・トピック、および複数リビジョンを持つ項目が存在する（`ExportSourceReader` はゴミ箱除外・最新リビジョンのみを返す契約） | エクスポートする | ゴミ箱内の項目はアーカイブに現れず、各項目は最新リビジョンの内容のみ。リビジョン履歴はどこにも出力されない。マニフェストの counts もゴミ箱を除いた件数 | |
| ドキュメント0件のトピックが存在する | エクスポートする | `topics/{topic-slug}/index.md` は出力される（ドキュメント0件でも index.md は出す） | |
| メモ・トピック・ドキュメントが全て0件（エッジケース: データなし） | エクスポートする | エラーにならない。`index.md`（counts すべて 0）のみを含む空アーカイブの zip が正常応答として返る。`memos/`・`topics/` ディレクトリは出力されない | |
| メモ0件・トピックあり | エクスポートする | `memos/` は出力されず、`topics/` は出力される | |
| トピック名が `A/B:C*?"<>\|#` のように禁止文字を含む | エクスポートする | スラッグから `/ \ : * ? " < > \| #` と制御文字が除去されたディレクトリ名になる | |
| トピック名が空白の連続・前後空白・NFC 未正規化文字を含む | エクスポートする | NFC 正規化・前後空白除去・空白連続の `-` 1つへの置換が行われたスラッグになる | |
| トピック名が禁止文字と空白のみで、スラッグ導出結果が空になる | エクスポートする | スラッグは `untitled` になる | |
| ドキュメントタイトルの先頭・末尾が `.` や `-` になる（例: `.hidden-`） | エクスポートする | 先頭・末尾の `.` と `-` が除去されたスラッグになる | |
| トピック名がちょうど50コードポイント | エクスポートする | 切り詰めなしでそのままスラッグになる（境界値） | |
| トピック名が51コードポイント以上（サロゲートペアを含む） | エクスポートする | コードポイント単位で50文字に切り詰められる | |
| 同名のトピック2件が存在する（エッジケース: スラッグ衝突） | エクスポートする | `createdAt` 昇順で1件目は素のスラッグ、2件目は `-2` 付き。3件目以降は `-3`, … | |
| 同一トピック内に同タイトルのドキュメント2件が存在する | エクスポートする | 同一階層でのみ衝突解決され、2件目に `-2` が付く。別トピック配下の同名ドキュメントには連番が付かない | |
| 切り詰め後に衝突する長いタイトル2件、またはスラッグ `x` と `x-2` が元から並存し連番付与で再衝突する | エクスポートする | 切り詰め後・連番付与後の再衝突も同じ規則で解決され、`ExportArchive.files` 内の `path` は一意になる | |
| 日本語のトピック名・ドキュメントタイトル | エクスポートする | 非 ASCII 文字は除去されず、日本語のままスラッグになる | |
| 複数のファイルを含むデータ一式 | エクスポートする | `ExportArchive.files` は `path` の辞書順にソートされ、全ファイル UTF-8・改行 LF | |
| 同一のデータ一式・同一 `exportedAt`・同一 `timezone`（エッジケース: 決定性） | エクスポートを2回実行する | 2回のアーカイブはバイト同一（`ExportRenderer` の決定性契約） | |
| 妥当な入力 | `timezone: ""`（空文字）でエクスポートする | `BusinessRuleError(ExportErrorCode.InvalidTimezone)`。`ExportSourceReader` は呼ばれない | |
| 妥当な入力 | `timezone: "Invalid/Zone"`（IANA として解決不能）でエクスポートする | `BusinessRuleError(ExportErrorCode.InvalidTimezone)` | |
| — | `userId` が ID として不正な形式でエクスポートする | `ValidationError`（通常は認証済みセッション由来のため発生しないが、値オブジェクト構築で防衛） | |
| `ExportSource` 内に `topics` に存在しない `topicId` を持つドキュメントがある（不整合スナップショット） | `ExportRenderer.render` を実行する | `BusinessRuleError(ExportErrorCode.OrphanDocument)`（防衛的検査）。zip は生成されない | |
| 生成された `ExportFile.path` が不正になる（先頭 `/`・`..` セグメント・空セグメント・`.md` 以外の拡張子。内部不変条件の検査） | `ExportFile` を構築する | `BusinessRuleError(ExportErrorCode.InvalidArchivePath)`（発生すれば実装バグ） | |
| `ExportArchive.files` 内で `path` が重複する（内部不変条件の検査） | `ExportArchive` を構築する | `BusinessRuleError(ExportErrorCode.DuplicateArchivePath)`（発生すれば実装バグ） | |
| `ExportSourceReader.readAll` で DB 障害が発生する | エクスポートする | `SystemError(DatabaseError)`。レンダリング・zip 化は行われない | |
| `ArchiveWriter.write` で zip エンコードが失敗する | エクスポートする | `SystemError(ArchiveEncodingError)` | |
| ユーザー A が認証済み、ユーザー B のデータが存在する（テナント分離） | ユーザー A としてエクスポートする | アーカイブにはユーザー A のデータのみが含まれる。他ユーザー ID を外部入力で指定する経路はない | |
| AI トークンで認証している | exportAllData を呼び出す | 公開インターフェースに含まれず呼び出せない（Web UI 専用。人間セッション以外には公開されない） | |
| 読み出したデータの総バイト数が1回のエクスポートの上限を超える | エクスポートする | `SystemError` 系で拒否される。zip は生成されず、部分的なアーカイブも返らない（上限値そのものは実装側が持ち、#37 → #38 で決まる） | |
| 上限に収まるデータ量 | エクスポートする | 読み出しが Durable Object 内の1回の `transactionSync` で完結し、レンダリングと zip 化が request Worker で実行される。読み出し中に他の書き込みが挟まってもアーカイブの内容は一貫している | |
