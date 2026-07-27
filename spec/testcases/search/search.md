# テストケース: search

| Given | When | Then |
|---|---|---|
| activeなメモとドキュメントに同じ語がある | 検索する | 両種別が関連度順で返り、各DTOは種別固有フィールドだけを持つ |
| 同点の結果が複数ある | 複数回検索する | `bm25`, timestamp, type, idの順で安定した順序になる |
| ドキュメントにsource memoがある | 検索する | documentの`sourceMemoIds`とmemoの`sourceOfDocumentIds`が一致する |
| source memoがtrashed | 検索する | trashed memoはヒットせず、active documentのsource IDにも露出しない |
| archived topic配下のdocument | 検索する | documentはヒットしtopicのarchived状態が返る |
| trashed topic配下のdocument | 検索する | documentはヒットしない |
| optional topicを指定 | 検索する | 配下documentとそのactive source memoだけを返す |
| topicを指定しない | 検索する | User Data DO内の全active memo/documentを対象にする |
| 日本語3文字以上 | 検索する | FTS5 trigramで該当結果を返す |
| 日本語/ASCIIのUTF-8 1〜2 byte短語 | 検索する | 安全にエスケープした短語fallbackで該当結果を返す |
| `\"*() OR -` 等のFTS特殊文字 | 検索する | query構文注入やSQL errorを起こさず、literalとして扱う |
| 全角・互換文字を含む語 | NFKC等価の語で検索する | 同じ結果になる |
| keywordが空白のみ | 検索する | `SEARCH_EMPTY_KEYWORD` |
| NFKC後にUTF-8 50 byte | 検索する | 正常に検索する |
| NFKC後にUTF-8 51 byte以上 | 検索する | `SEARCH_KEYWORD_TOO_LONG` |
| cursor pageの途中 | 次pageを検索する | 同じsnapshotで重複・欠落がない |
| 不正cursor | 検索する | `ValidationError` |
| 0件 | 検索する | 空itemsの正常応答 |
| 人間UIとAI | 同じqueryを実行する | ヒット範囲・順位・除外規則が一致する |
| 別userのentity IDを外部入力へ混ぜる | 検索する | routing先DOを変更できず、別userの結果を返さない |
