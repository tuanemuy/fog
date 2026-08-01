# テストケース: editDocumentByAi

[usecases/knowledge.md](../../usecases/knowledge.md) の editDocumentByAi に対するテストケース（MCP `edit_document`。S-AI-04）。

| 前提条件 | 操作 | 期待結果 | 実装ステータス |
|---|---|---|---|
| 本文 `"AAA BBB CCC"` の active ドキュメントが存在する | `mode: "patch"`, `patches: [{ oldText: "BBB", newText: "XXX" }]`, `changeReason` 指定で編集する | 本文が `"AAA XXX CCC"` になり `changed: true`。`latestRevision + 1` の新リビジョン（AI クライアント actor・指定の変更理由）が積まれ、同じ `transactionSync` の中で当該ドキュメントのエントリが `search_entries` / `search_fts` に作り直される | |
| active ドキュメントが存在する | `mode` を省略して `patches` を渡す | 既定モード `patch` として適用される | |
| 本文 `"AAA BBB"` の active ドキュメントが存在する | hunks 2 件 `[{ oldText: "AAA", newText: "BBB" }, { oldText: "BBB BBB", newText: "CCC" }]` で編集する | hunks は配列順に逐次適用され、後続 hunk は前の置換結果を含む本文に対してマッチする（1 件目適用後の `"BBB BBB"` に 2 件目が一致し、最終本文は `"CCC"`） | |
| 本文 `"AAA BBB"` の active ドキュメントが存在する | `patches: [{ oldText: "BBB", newText: "" }]` で編集する | `newText` 空文字は該当箇所の削除として適用され、本文は `"AAA "` になる | |
| active ドキュメントが存在する | `mode: "replaceAll"`, `body`（新しい全文）, `changeReason` 指定で編集する | 受領した全文がそのまま `Document.edit` に渡り、新リビジョンが積まれる。タイトルは現行のまま維持される | |
| 本文が空文字の active ドキュメントが存在する（エッジケース: 空本文への AI 編集） | `mode: "replaceAll"`, `body: "初稿"` で編集する | 正常に編集される（`oldText` 非空必須のためパッチは空本文に適用不能であり、replaceAll が唯一の AI 編集経路） | |
| 本文が空文字の active ドキュメントが存在する | `mode: "patch"` で任意のパッチを適用する | `oldText` が空本文中に見つからず `BusinessRuleError(PatchTargetNotFound)` | |
| 本文非空の active ドキュメントが存在する | `mode: "replaceAll"`, `body: ""` で編集する | 空本文への置換として正常に受理され、新リビジョンが積まれる（境界値: replaceAll と空本文） | |
| active ドキュメントが存在する | 現在値と同一の結果になる編集（replaceAll で同一全文、または適用結果が同一のパッチ）を行う | `changed: false`。リビジョンは積まれず、インデックスエントリも作り直されない（不変条件 5） | |
| active ドキュメントが存在する | `changeReason` を省略して編集する | `ValidationError`。既定値は補完されない（requirements 4.5: AI は変更理由必須。S-AI-04 異常系） | |
| active ドキュメントが存在する | `changeReason` に空白のみ（trim 後空）を渡す | `ValidationError`（補完しない） | |
| 本文 `"AAA"` の active ドキュメント。AI の取得後に本文が変更され `oldText` が存在しない（エッジケース: パッチ 0 一致） | `patches: [{ oldText: "ZZZ", newText: "X" }]` で編集する | `BusinessRuleError(PatchTargetNotFound)`。ドキュメントは変更されない。AI は `get` で最新を取り直して再試行する | |
| 本文 `"AAA foo AAA"` の active ドキュメント（エッジケース: パッチ複数一致） | `patches: [{ oldText: "AAA", newText: "X" }]` で編集する | `BusinessRuleError(PatchTargetAmbiguous)`。ドキュメントは変更されない。AI は周辺文脈を含めた一意な `oldText` で再試行する | |
| 本文 `"AAA BBB"` の active ドキュメント（エッジケース: 部分適用なし） | hunks 2 件のうち 1 件目は一致、2 件目の `oldText` が不一致のパッチで編集する | パッチ全体が失敗し `BusinessRuleError(PatchTargetNotFound)`。1 件目の置換も反映されず、本文・リビジョンとも一切変更されない | |
| active ドキュメントが存在する | `patches: []`（空配列）で編集する | `BusinessRuleError(EmptyPatch)`（境界値: hunks は 1 件以上） | |
| active ドキュメントが存在する | `patches: [{ oldText: "", newText: "X" }]` で編集する | `BusinessRuleError(EmptyPatchOldText)`（空文字はマッチ位置を特定できない） | |
| 本文が上限近くの active ドキュメントが存在する | 適用結果が 1,000,001 文字になるパッチで編集する | 適用結果の `DocumentBody.create` で `BusinessRuleError(DocumentBodyTooLong)`（境界値） | |
| active ドキュメントが存在する | `mode: "replaceAll"`, `body` を 1,000,001 文字で編集する | `BusinessRuleError(DocumentBodyTooLong)` | |
| active ドキュメントが存在する | `changeReason` を改行入り / 201 文字で編集する | `BusinessRuleError`（`ChangeReasonMultiline` / `ChangeReasonTooLong`） | |
| active ドキュメントが存在する | `changeReason` をちょうど 200 文字で編集する | 正常に編集される（境界値） | |
| ドキュメントが存在しない ID | 編集する | `NotFoundError` | |
| ドキュメントがゴミ箱内 | 編集する | `NotFoundError`（ゴミ箱内は AI から「存在しない」扱い。存在事実も漏らさない。S-AI-04） | |
| 他ユーザー所有のドキュメント ID | 編集する | 到達可能性により `NotFoundError`（自分の Durable Object の中に他ユーザーの行が存在しない） | |
| — | `documentId` に空文字を渡す | `BusinessRuleError(InvalidDocumentId)` | |
| `findById` 後、並行する人間の `editDocument` が先にコミットした | 編集を実行する | `save` の 0 行更新または `insertRevision` の一意制約違反により `ConflictError` | |
| active ドキュメントが存在する | `DocumentRepository.save` で DB 例外が発生する | `SystemError(DatabaseError)`。UoW 全体がロールバックされる | |
