# Search

メモ・ドキュメントを横断する全文検索（SQLite FTS5）を担うドメイン。エンティティは持たず、値オブジェクト・ポートが中心となる（[ADR-004](../adr/004-domain-boundaries.md)）。インデックスは本体更新と同一トランザクションで維持する（[.adr/003](../../.adr/003-sqlite-fts5-only-search.md) が根拠側、[.adr/004](../../.adr/004-do-local-commit-and-alarm-jobs.md) が方式側。`spec/adr/005`（superseded。根拠側は `.adr/003`、方式側は `.adr/004`））。

他ドメインの ID 型を参照する: `MemoId`（memo）、`DocumentId` / `TopicId`（knowledge）。エンティティ本体は参照せず、ID と読み取り専用の最新状態のみを扱う。

## ユビキタス言語

| 英語 | 日本語 | 定義 |
|---|---|---|
| Full-text Search | 全文検索 | キーワードの全文一致でメモとドキュメントを横断して返す単一の検索。方式の選択を利用者（人間・AI）に委ねない |
| Search Query | 検索クエリ | 検索の入力。キーワード・任意のトピック絞り込み・取得件数・任意のカーソルからなる |
| Search Cursor | 検索カーソル | ページの続きを読むための不透明な値。同じカーソルからは同じ集合が読め、有効期限を持つ |
| Search Result Item | 検索結果項目 | 検索結果の1件。事実データのみで構成され、要約・再構成を含まない |
| Snippet | スニペット | 結果項目に含める原文の抜粋。全文は返さない（短いメモは実質全文になり得る）。切り詰め方式は実装詳細 |
| Index Entry | インデックスエントリ | 検索対象1件に対応する projection の値。本体（メモ / ドキュメント）の最新状態から導かれる |
| Projection Update | projection 更新 | 本体を書くトランザクションの中で、対象のインデックスエントリを作り直す処理。独立したポートではなくリポジトリ実装の内部処理である |
| Scope Filter | スコープ絞り込み | `TopicId` による検索範囲の限定。そのトピック配下のドキュメントと、その出典メモに絞る |

## エンティティ

なし。検索は memo / knowledge のエンティティに対する読み取り専用の横断ビューであり、このドメインが所有する状態はインデックス（同一 DO 内の SQLite に置かれた projection）のみ。インデックスは常に「対象の最新状態から再構築可能な派生データ」であり、集約として管理しない。

## 値オブジェクト

### SearchQuery

検索の入力。application 層のユースケースが生成し、`SearchIndexPort.query` に渡す。

| フィールド | 型 | 制約 |
|---|---|---|
| keyword | `string` | required。trim 後に非空であること |
| topicId | `TopicId` | optional。指定時はスコープ絞り込みを行う |
| limit | `number` | required。1 以上 100 以下の整数 |
| cursor | `SearchCursor` | optional。未指定が先頭ページ。前のページが返した値をそのまま渡す |

検索範囲は引数ではなく到達可能性で閉じる。`userId` はフィールドに持たない — ユーザー単位 Durable Object の選択で消費済みであり、同じ DO の中に他ユーザーの行が原理的に存在しないためである（domains/index.md「テナント分離」）。

バリデーションルール:

- `keyword` は trim 後に空文字なら `BusinessRuleError(SearchErrorCode.EmptyKeyword)`（シナリオ S-SE-01: キーワード未入力の間は検索を実行しない、に対応する構造的な保証）
- `keyword` の最大長は 500 文字。超過は `BusinessRuleError(SearchErrorCode.KeywordTooLong)`。**これは transport 境界の DoS 対策としての入力長制限であり、索引の実装機構から導いた値ではない**（機構を替えても動かない）
- `limit` が範囲外ならバリデーションエラー
- `cursor` が不正または期限切れなら `BusinessRuleError(SearchErrorCode.InvalidCursor)`

等価性: 全フィールドの値が等しいとき同一。

```ts
export type SearchCursor = string;   // 不透明。中身の解釈は SearchIndexPort の実装に閉じる

export type SearchQuery = Readonly<{
  keyword: string;
  topicId?: TopicId;
  limit: number;
  cursor?: SearchCursor;
}>;

export const SearchQuery = {
  create: (params: {
    keyword: string;
    topicId?: TopicId;
    limit: number;
    cursor?: SearchCursor;
  }): SearchQuery => { /* keyword を trim して検証 */ },
};
```

### SearchResultItem

検索結果の1件。種別（メモ / ドキュメント）の直和型として定義し、種別ごとに持ち得るフィールドだけを表現する（「メモに所属トピックがある」等のあり得ない組み合わせを型上排除する）。

```ts
export type MemoSearchResultItem = Readonly<{
  type: "memo";
  id: MemoId;
  snippet: string;
  timestamp: Date;                      // メモの投稿日時
  sourceOfDocumentIds: readonly DocumentId[]; // このメモを出典とするドキュメントのID群（なければ空配列）
}>;

export type DocumentSearchResultItem = Readonly<{
  type: "document";
  id: DocumentId;
  snippet: string;
  timestamp: Date;                      // ドキュメントの最終更新日時
  topicId: TopicId;                     // 所属トピック（ドキュメントは必ずトピックに属する）
  sourceMemoIds: readonly MemoId[];     // 出典メモのID群（なければ空配列）
}>;

export type SearchResultItem = MemoSearchResultItem | DocumentSearchResultItem;
```

バリデーションルール:

- `snippet` は非空。切り詰め方式（文字数・一致箇所周辺の抽出・ハイライト等）は実装詳細であり、要件・ドメインでは規定しない（要件 4.4）
- 検索結果は事実データのみで構成する。要約・言い換え・再構成をこのドメイン（およびアダプター）で行うことは禁止。加工は AI クライアントの責務

等価性: `type` と `id` が等しいとき同一項目とみなす（同一検索結果内で `id` は重複しない）。

### SearchPage

`SearchIndexPort.query` の戻り値。共通の `PaginationResult`（`domain/common/pagination.ts`）に、続きを読むためのカーソルを添えた形である。

```ts
export type SearchPage = PaginationResult<SearchResultItem> & Readonly<{
  nextCursor?: SearchCursor;            // 続きが無ければ undefined
}>;
```

- `count` はスナップショットに固定した集合の総件数であり、カーソル方式でも意味を保つ
- `nextCursor` は不透明である。利用者・ユースケースは中身を解釈せず、次の要求へそのまま渡す

### IndexEntry

インデックスの1エントリ（`search_entries` の1行に対応する projection の値）。本体を書くトランザクションの中で対象の最新状態から構築する。種別の直和型とする。

```ts
export type MemoIndexEntry = Readonly<{
  type: "memo";
  memoId: MemoId;
  content: string;                      // メモ本文（最新リビジョンの全文）
  timestamp: Date;                      // 投稿日時
  sourceOfDocumentIds: readonly DocumentId[];
}>;

export type DocumentIndexEntry = Readonly<{
  type: "document";
  documentId: DocumentId;
  topicId: TopicId;
  title: string;
  content: string;                      // ドキュメント本文（最新リビジョンの全文）
  timestamp: Date;                      // 最終更新日時
  sourceMemoIds: readonly MemoId[];
}>;

export type IndexEntry = MemoIndexEntry | DocumentIndexEntry;
```

バリデーションルール:

- `content` はインデックス対象として空を許容する（空本文のエンティティは存在しない前提だが、エントリ構築時に再検証はしない。真正性は memo / knowledge の不変条件が保証する）
- ソフトデリート済み・ハードデリート済みの対象から `IndexEntry` を構築してはならない。それらはエントリを作り直す対象ではなく、同一トランザクションで除去する対象である（後述の「インデックスの維持」）
- **`sourceOfDocumentIds` / `sourceMemoIds` には、出典リンクの相手側が active なものの ID のみを含める**。ゴミ箱内（ソフトデリート済み）・ハードデリート済みの相手の ID は含めない。含めると AI が検索結果経由でゴミ箱内項目の ID（存在の事実）を観測できてしまい、「ゴミ箱の中身は AI から見えない世界」（requirements 4.5 / trash.md）に反する。projection 更新はエントリ構築時に出典リンクの相手側の現在状態を確認して active のみを採用する

等価性: `type` と対象 ID（`memoId` / `documentId`）が等しいとき同一対象のエントリとみなす。作り直しはこの同一性キーで行う。

## ドメインサービス

なし。

- 順位付けは全文一致のスコア（`bm25`。タイトルを本文より重く見る重み付けを行う）と安定した tie-breaker で決まる。重みの実値は実装側が持つ実測値であり、ドメインの規則としては持たない。ドメインが保証するのは「単一のクエリで単一の結果が返ること」（要件 4.4: 検索方式の選択を AI に委ねない）と、同点時の順位が安定していること（後述の「検索の規則」）である
- 検索対象の除外規則（ゴミ箱・アーカイブ）は後述の「検索の規則」としてポートの契約に含め、サービスとしては切り出さない

## 検索の規則

`SearchIndexPort.query` の実装（アダプター）と projection 更新が共同で守るべきドメインルール。人間 UI と AI クライアント（search API）で挙動は完全に一致する（シナリオ S-SE-03）。

- 検索範囲は常にそのユーザーのデータに閉じる。保証は列条件ではなく到達可能性による（domains/index.md「テナント分離」。要件 5.1）
- ゴミ箱内（ソフトデリート済み）の項目は検索にヒットしない。ソフトデリートと**同一トランザクションで projection からエントリを除去する**ことにより保証する
  - 「ゴミ箱内の項目は get でも取得できない」は AI スコープの規則であり、memo / knowledge のユースケース公開範囲と identity のトークンスコープが担う。search ドメインの責務ではない（ここではヒットしないことのみ保証する）
  - ゴミ箱内項目の **ID も検索結果に露出させない**: 結果項目の `sourceOfDocumentIds` / `sourceMemoIds` は active な相手のみを含む（IndexEntry の構築規則と、相手側の削除・復元時に同一トランザクションで相手のエントリを作り直すことで保証する）
- アーカイブ（完了）済みトピック配下のドキュメントとその出典メモは検索にヒットする（要件 4.2 / 4.4）。トピックのアーカイブフラグ変更は projection 更新の契機にならない
- 検索結果は事実データのみ（ID・種別・スニペット・タイムスタンプ・所属トピック・出典リンク先 ID）を返し、一切加工しない。要約・再構成は AI クライアントの責務
- 全文は返さない。切り詰め方式は実装詳細。原文の完全性が必要な場合は memo / knowledge の単体取得（get）を使う
- **トピック絞り込みは optional な単一トピックである。** 指定時はそのトピック配下のドキュメントと、その出典になっている active なメモに結果を絞る（シナリオ S-SE-02）。**未知のトピック・ゴミ箱内のトピックを指定した場合は `TOPIC_NOT_FOUND` で拒否する**（空結果を返さない。存在しないトピックを指定したことが利用者に伝わる必要があるため）
- **検索エントリとトピックは正規化した事実の join で結ぶ。** トピック名をエントリ側に複製せず、問い合わせ時に join で解決する。トピックのリネームが検索結果に即座に反映されるのはこのためである
- **順位の同点は `timestamp DESC, type, id` で決定する。** 全文一致のスコアが等しい項目の並びが実行ごとに揺れないことを保証する規則であり、ページ間の重複・欠落を防ぐ前提でもある
- **ページングは期限付きスナップショットと不透明カーソルで行う。** 最初のクエリで結果の集合を固定し、以後は前のページが返したカーソルから同じ集合の続きを読む。契約は次の3点である
  - 同じカーソルからは同じ集合が読める（ページ間に本体の変更があっても重複・欠落が出ない）
  - カーソルには有効期限があり、期限切れのカーソルは拒否される（利用者は先頭から検索し直す）
  - カーソルは不透明であり、利用者・ユースケースは中身を解釈しない。ページ番号を指定して任意の位置へ飛ぶ操作は提供しない
  - **スナップショットの物理形（どこに何を置いて固定するか）はこのドメインでは確定させない。** 上の3点が守られる限り実現方法を問わない（`spec/database/index.md`）
- 一致する結果がない場合は空の結果を返す（エラーではない）
- **インデックスは本体更新と同一トランザクションで維持されるため、投稿・編集した項目は直後の検索から必ずヒットする。** 反映待ちは存在しない

## ポート

### SearchIndexPort

- 目的: 全文検索インデックスへの問い合わせ。索引の構成・トークナイズ・順位付け・スニペットの組み立てはすべてこのポートの実装に隠蔽する
- 配置: `packages/core/src/domain/search/ports/searchIndexPort.ts`
- **同期契約である**（`Promise` を返さない）。問い合わせは Durable Object 内の SQLite に対して同期で行われる（domains/index.md「ポートの同期契約」）

```ts
export interface SearchIndexPort {
  query(query: SearchQuery): SearchPage;
}
```

メソッド:

- `query(query: SearchQuery): SearchPage` — 全文一致を実行し、`bm25` と安定した tie-breaker で順位付けした単一結果を返す。検索の規則（ユーザー境界・除外規則・スコープ絞り込み・事実データのみ・安定順位・カーソル）を満たすこと。結果0件は空の `SearchPage`

**書き込み側はポートではない。** インデックスの更新は本体（メモ / ドキュメント）を書くトランザクションの中の projection 処理へ畳まれており、memo / knowledge のリポジトリ実装が担う（後述の「インデックスの維持」）。独立したポートにしないのは、ポートにすると DI で単独注入でき、本体更新と同じトランザクションの外から呼べる経路が構造的に残るためである。

エラーケース:

- `NotFoundError(TOPIC_NOT_FOUND)` — `topicId` が未知、またはゴミ箱内のトピックを指している
- `BusinessRuleError(SearchErrorCode.InvalidCursor)` — `cursor` が不正、または有効期限を過ぎている
- `SystemError(SearchIndexUnavailable)` — インデックスへの問い合わせ失敗・タイムアウト。retryable。利用者にエラーが返る

## エラーコード

```ts
export const SearchErrorCode = {
  EmptyKeyword: "EMPTY_KEYWORD",
  KeywordTooLong: "KEYWORD_TOO_LONG",
  InvalidCursor: "INVALID_CURSOR",
} as const;
```

`SearchIndexUnavailable` はドメインエラーではなく application 層の `SystemError` のコード、`TOPIC_NOT_FOUND` は同じく application 層の `NotFoundError` のコードとして扱う。

## インデックスの維持

**本体を書くトランザクションの中で projection を更新する。** 別ストアではないので配送する必要が無く、外部 transport（キュー・ワーカー）は登場しない。

1. memo / knowledge の書き込みユースケースが、エンティティの永続化と同じ同期トランザクションの中で対象のインデックスエントリを作り直す
2. エントリの構築材料は「そのトランザクションで確定した最新状態」だけである。対象が active ならエントリを作り直し、ソフトデリート済み・ハードデリート済みならエントリを除去する
3. 出典リンクの相手側（`sourceOfDocumentIds` / `sourceMemoIds`）も同じトランザクションの中で作り直す。相手側の削除・復元が自分の結果表示に効くのはこのためである

**整合は SQL トリガーではなく projection コードが担う。** 本体を書くリポジトリと同じトランザクションの中で projection 関数が明示的に更新を発行する。整合の責任の所在をコード側に置くほうが、両対応の読み取りや全件再構築と噛み合うためである。

**external-content 構成の FTS5 を採るための実装制約が2つある。** どちらも成否ではなく実装の正しさに直結し、踏み外すと例外が上がらずインデックスだけが黙って壊れる。

1. **更新・削除は「旧値で delete → 新値で insert」の2段で行う。** external-content の FTS5 は本体行の内容を自分で保持しないので、本体を書き換える前に旧内容をインデックスから引き算する必要がある。旧値の読み出しは同じトランザクションの中で行う
2. **`search_entries` の PK を `rowid INTEGER PRIMARY KEY` にし、`id TEXT` を UNIQUE 制約付きの別列にする。** 素直に単一列 TEXT の `id` を PK にすると、delete コマンドに渡す安定した INTEGER rowid を組み立てられない。`id` と rowid の対応は `search_entries` の中に閉じ、**DO の外の DTO には rowid を出さない**

projection 更新の契機は次のとおりである。いずれも本体の書き込みと同一トランザクションで起きる。

| 契機 | projection の更新 |
|---|---|
| メモの投稿・編集 | 対象メモのエントリを作り直す |
| メモの復元 | 対象メモのエントリを作り直し、そのメモを出典とするドキュメントのエントリも作り直す（`sourceMemoIds` にこのメモの ID が戻る） |
| メモのソフトデリート | 対象メモのエントリを除去し、そのメモを出典とするドキュメントのエントリを作り直す（`sourceMemoIds` からこのメモの ID が外れる） |
| メモのハードデリート | 対象メモのエントリを除去し、出典リンクが消えた相手ドキュメントのエントリを作り直す |
| ドキュメントの作成 | 対象ドキュメントのエントリを作り直し、出典メモのエントリも作り直す（`sourceOfDocumentIds` の反映） |
| ドキュメントの編集 | 対象ドキュメントのエントリを作り直す |
| ドキュメントの復元 | 対象ドキュメントのエントリを作り直し、出典メモのエントリも作り直す |
| ドキュメントのソフトデリート | 対象ドキュメントのエントリを除去し、出典メモのエントリを作り直す |
| ドキュメントのハードデリート | 対象ドキュメントのエントリを除去し、出典リンクが消えた相手メモのエントリを作り直す |
| トピックの作成・更新・アーカイブ | 何もしない（トピックはエントリを持たず、検索結果のトピックは join で解決するため） |
| トピックのソフトデリート・復元 | 配下ドキュメント単位の更新として同一トランザクションで行われる（トピック自体の契機を別に持たない） |

**トークナイザや正規化規則を変えたときの全件再構築は、migration の `reindex` ジョブが担う**（`spec/database/index.md`）。ドメイン側にユースケースを持たない。

## ユースケース（概要）

詳細はユースケース設計フェーズで定義する。

- 検索する（search）— `SearchQuery` を構築して `SearchIndexPort.query` を呼ぶ。人間 UI（検索画面）と AI クライアント（search API / MCP ツール）で共通の単一ユースケース
