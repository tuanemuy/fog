# テストケース: maintainSearchIndex

[usecases/search.md](../../usecases/search.md) の maintainSearchIndex に対するテストケース。契機イベントと処理の対応は [domains/search.md](../../domains/search.md)「インデックス更新フロー」に基づく。at-least-once・順序保証なしの配信を前提とした冪等 consumer の検証。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| メモ M が active で存在する | `memo.created`（targetId: M）を処理する | M の最新状態が indexer 専用読み取りで読み直され、`MemoIndexEntry` で `upsertMemo` が呼ばれる。`IndexEntry.userId` は読み直した M 自身の `userId`。成功後に `markProcessed(eventId)` が呼ばれ ack される | |
| メモ M が編集済みで、イベント発生後にさらに本文が更新されている | `memo.edited`（targetId: M）を処理する | イベントペイロードの本文ではなく、読み直した**最新**の本文で `upsertMemo` が呼ばれる（古いペイロードによる巻き戻り防止） | |
| メモ M が active で、M を出典とする active なドキュメント D1・D2 がある | `memo.restored`（targetId: M）を処理する | `upsertMemo(M)` に加え、逆引き（`listSourceLinksByMemo` 相当）で D1・D2 が列挙され、各々読み直して `upsertDocument` される（`sourceMemoIds` に M の ID が戻る。ファンアウト） | |
| メモ M がソフトデリート済みで、M を出典とする active なドキュメント D がある | `memo.trashed`（targetId: M）を処理する | `removeMemo(M)` に加え、逆引きで D が読み直され `upsertDocument` される。D のエントリの `sourceMemoIds` から M の ID が外れる（ゴミ箱内 ID を検索結果に露出させない。ファンアウト） | |
| メモ M がハードデリート済み（レコードが存在しない） | `memo.hardDeleted`（targetId: M）を処理する | `removeMemo(M)` のみ呼ばれる。ファンアウトは行わない（出典リンク側の再構築は同一 UoW で発行される `document.sourceLinksChanged` が担う） | |
| メモ M が active で、出典リンクの構成が変化している | `memo.sourceLinksChanged`（targetId: M）を処理する | M を読み直して `upsertMemo`。エントリの `sourceOfDocumentIds` に現在の active な相手のみが反映される | |
| ドキュメント D が active で、出典メモ M1・M2 がある | `document.created`（targetId: D）を処理する | `upsertDocument(D)` に加え、逆引き（`listSourceLinksByDocument` 相当）で M1・M2 が読み直され各々 `upsertMemo` される（`sourceOfDocumentIds` の反映。ファンアウト） | |
| ドキュメント D が active で存在する | `document.edited`（targetId: D）を処理する | D の最新状態を読み直して `upsertDocument` が呼ばれる | |
| ドキュメント D が active で、出典メモ M がある | `document.restored`（targetId: D）を処理する | `upsertDocument(D)` に加え、逆引きで M が再 `upsertMemo` される（`sourceOfDocumentIds` に D の ID が戻る。ファンアウト） | |
| ドキュメント D がソフトデリート済みで、出典メモ M が active | `document.trashed`（targetId: D）を処理する | `removeDocument(D)` に加え、逆引きで M が再 `upsertMemo` される。M のエントリの `sourceOfDocumentIds` から D の ID が外れる（ファンアウト） | |
| ドキュメント D がハードデリート済み | `document.hardDeleted`（targetId: D）を処理する | `removeDocument(D)` のみ呼ばれる。ファンアウトは行わない（`memo.sourceLinksChanged` が同一 UoW で担う） | |
| ドキュメント D が active で、出典リンクの構成が変化している | `document.sourceLinksChanged`（targetId: D）を処理する | D を読み直して `upsertDocument`。エントリの `sourceMemoIds` に現在の active な相手のみが反映される | |
| upsert 対象のメモ M の出典先ドキュメントの一部がゴミ箱内・一部がハードデリート済み | M への upsert 契機イベントを処理する | 構築される `MemoIndexEntry.sourceOfDocumentIds` には active な相手の ID のみ含まれる。ソフトデリート済み・ハードデリート済みの相手の ID は含まれない | |
| upsert 対象のドキュメント D の出典メモの一部がゴミ箱内 | D への upsert 契機イベントを処理する | 構築される `DocumentIndexEntry.sourceMemoIds` には active な出典メモの ID のみ含まれる | |
| — | `topic.created` / `topic.updated`（targetId: TopicId）を処理する | インデックス操作は一切行われず、no-op として `markProcessed` され ack される（トピック名は index に持たず query 時に解決するため） | |
| — | `topic.trashed` / `topic.restored` を処理する | no-op として ack される（配下ドキュメントのカスケードは knowledge が `document.trashed` / `document.restored` として発行し、そちらで受ける） | |
| アーカイブ済みトピック配下にインデックス済みドキュメントがある | `topic.archived` / `topic.unarchived` を処理する | no-op として ack される。配下ドキュメントのインデックスは変更されない（アーカイブ済みもヒットするため） | |
| — | 契機イベント表にない未知のイベント種別（例: `memo.futureEvent`）が購読チャネルに流れてくる | no-op として `markProcessed` され ack される。デコード失敗として隔離（quarantine）に落とさない。インデックス操作もリトライも発生しない | |
| `eventId` E が `IdempotencyStore` で処理済み | 同一 `eventId` E のイベントが再配信される | 手順 1 の処理済みチェックでスキップされ、インデックス操作なしで ack される（重複配信のスキップ） | |
| 前回処理でハンドラーは成功したが `markProcessed` 前にプロセスがクラッシュした（スタンプ未完了） | 同一イベントが再配信される | 処理済みチェックを通過して冪等な upsert / remove が再実行され、インデックスの最終状態は不変。成功後に `markProcessed` され ack される | |
| メモ M は既にソフトデリート済み（`memo.trashed` 処理済み）だが、古い `memo.created`（targetId: M）が逆順到達する | 遅延した `memo.created` を処理する | 読み直しで「ソフトデリート済み」と判定され、upsert ではなく `removeMemo` に正規化される。インデックスは最新状態（除去済み）に収束する | |
| 対象メモ M が読み直し時点で存在しない（ハードデリート済み。逆順到達） | upsert 契機のイベント（`memo.edited` 等）を処理する | エラーにせず `removeMemo(M)` に正規化して成功する。`markProcessed` され ack される | |
| インデックスに存在しない ID に対する remove 契機イベント | `memo.trashed` / `document.hardDeleted` 等を処理する | `removeMemo` / `removeDocument` は存在しない ID でも冪等に成功し、正常に ack される | |
| ファンアウトを伴うイベント（例: `memo.trashed` で相手ドキュメント D1・D2）の処理中、D1 の upsert 成功後に D2 の upsert が失敗する | イベントを処理する | `markProcessed` は呼ばれずに throw し、Outbox の再配信リトライに乗る（stamp-after-success）。再配信時は D1 への upsert も再実行されるが冪等のため結果不変で、全体成功後に初めて `markProcessed` される | |
| インデックスストアが接続失敗またはタイムアウトする | 任意の upsert / remove 契機イベントを処理する | `SystemError(SearchIndexUnavailable)` が throw され、`markProcessed` は呼ばれない。Outbox のリトライ（backoff + jitter）で再配信され、復旧後の再処理で成功する | |
| 埋め込み生成（外部 API）が失敗する | upsert 契機のイベントを処理する | `SystemError(EmbeddingFailed)` が throw され、`markProcessed` は呼ばれない。Outbox のリトライで再配信され、復旧後の再処理で成功する（remove 系では発生しない） | |
| イベントペイロードの構造が壊れていて対象 ID を取り出せない | 壊れたイベントが配信される | デコード失敗としてリトライ経路に乗り、`maxAttempts` 到達で隔離（quarantine）される。スキーマ修正後の再キックで再配信される | |
| 同一イベントが短時間に複数回並行配信される | 同一 `eventId` を並行に処理する | `IdempotencyStore` によるスキップ、または冪等な upsert / remove の再実行のいずれかに落ち、インデックスの最終状態は対象の最新状態に収束する（エラーにしない） | |
