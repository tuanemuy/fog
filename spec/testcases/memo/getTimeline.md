# テストケース: getTimeline

[usecases/memo.md](../../usecases/memo.md) の getTimeline に対するテストケース。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| active なメモが複数存在する | `cursor: null`（既定値）で取得する | 最新から `postedAt` 降順で `limit` 件（既定 50）の `TimelineItemView` と、過去方向の続きを指す `nextCursor` が返る（S-TL-02） | |
| メモが limit 件より多く存在する | 返却された `nextCursor` を `cursor` に指定し `direction: "older"` で続きを取得する | 前ページより古いメモが `postedAt` 降順で返り、重複・欠落がない | |
| 過去位置のカーソルを保持している | 同じカーソルから `direction: "newer"` で取得する | カーソル位置より新しい側のメモが `postedAt` 降順で返る。`nextCursor` は新しい方向の続きを指す（両方向無限スクロール。S-TL-02） | |
| 最古のメモまで読み切った | さらに `direction: "older"` で取得する | `items` に残りが返り `nextCursor: null`（終端） | |
| 最新のメモまで読み切った | `direction: "newer"` で取得する | `nextCursor: null`（新しい側の終端） | |
| 同一 `postedAt` のメモが複数存在する | ページ境界をまたいで取得する | 順序が id で安定化され、ページ間で重複・欠落がない（境界値: 同時刻の安定ソート） | |
| メモに `"買い物"` を含むものと含まないものがある | `keyword: "買い物"` で取得する | 本文に部分一致するメモのみ返る（S-TL-03 の絞り込み） | |
| メモが存在する | `keyword: "  "`（trim 後空）で取得する | 絞り込みなし（`null` と同義）として全件対象で返る | |
| keyword に一致するメモがない | `keyword` を指定して取得する | `items: []` を返しエラーにしない（「見つからなかった」表示は presentation の責務） | |
| メモが 1 件も存在しない | 取得する | `items: []`・`nextCursor: null` | |
| メモがドキュメントの出典になっている | 取得する | 該当 `TimelineItemView.sourceDocuments` に `{ documentId, title, isTrashed: false }` が含まれる（S-TL-07 の「→ ドキュメントX」導線） | |
| 1 つのメモが複数ドキュメントの出典になっている | 取得する | `sourceDocuments` に全リンク先が含まれる（1 ページ分を 1 クエリで一括逆引き。N+1 にしない） | |
| 出典リンク先ドキュメントが trashed | 取得する | `sourceDocuments` の該当要素が `isTrashed: true` で返る（「削除済みのドキュメント」の遷移不可表示用。表示制御は presentation の責務） | |
| 出典リンク先ドキュメントがハードデリート済み | 取得する | 該当リンクは `sourceDocuments` に現れない（リンク自体が同期消去済み。ADR-003） | |
| trashed のメモが存在する | 取得する | trashed のメモは `items` に含まれない（active のみ） | |
| 他ユーザーのメモが存在する | 取得する | 他ユーザーのメモは含まれない（テナント分離: リポジトリの userId スコープ） | |
| メモが存在する | `limit: 1` で取得する | 1 件だけ返る（境界値: 下限） | |
| メモが存在する | `limit: 100` で取得する | 最大 100 件返る（境界値: 上限） | |
| — | `limit: 0` で取得する | `ValidationError`（境界値: 下限未満） | |
| — | `limit: 101` で取得する | `ValidationError`（境界値: 上限超過） | |
| — | `limit` に非整数（`1.5`）を指定する | `ValidationError` | |
| — | `cursor` にデコード不能な文字列を指定する | `ValidationError`（アダプター境界でマップ） | |
| — | `direction: "newer"` かつ `cursor: null` で取得する | `ValidationError`（newer は cursor 必須） | |
| — | `cursor` に空文字を指定する | `BusinessRuleError(InvalidCursor)`（`TimelineCursor.create` は非空を要求） | |
| — | `findTimelinePage` で DB 例外が発生する | `SystemError(DatabaseError)` | |
