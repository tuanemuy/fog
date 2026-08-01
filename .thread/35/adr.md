# ADR — Issue #35: spec と CLAUDE.md を FTS5 全文検索 + Durable Objects 単独構成へ改訂する

## ADR-001: `SearchIndexPort` を `query` 1本へ縮小し、書き込み側をポートにしない

### Status

Proposed

### Context

Issue #35 の受け入れ条件3 は「`SearchIndexPort` の契約が **FTS5 の query / upsert / remove** に単純化されている」と書いている。一方 Issue #10 の実装チェックリストは `DOM-SEARCH-003 SearchIndexPort — read-only FTS5 query` と `DOM-SEARCH-004 SearchProjectionPort — transaction-scoped upsert/remove、単独DI禁止` の2ポートに分ける形を挙げている。3つ目の案として、`.thread/34/design.md` 第7.1節は「書き込み側は**独立したポートではなくなる**」と断定している。

選択肢は次の3つ。

- **(a) `query` + `upsert` / `remove` の1ポート**（Issue #35 本文の文言どおり）
- **(b) 読み取り `SearchIndexPort` + 書き込み `SearchProjectionPort` の2ポート**（Issue #10 の記載）
- **(c) 読み取り `SearchIndexPort` の `query` 1本のみ。書き込みはポートではなく、本体を書くトランザクション内の projection 処理**（design.md 第7.1節）

### Decision

**(c) を採る。** design.md 第11.1節が「#35 は Issue 本文の当該行を『`query` 1本へ縮小する』に訂正したうえで作業する」と明示的に指示しており、設計が正本である。

**(a) を採らない理由**は、`upsert` / `remove` をポートに残すと「本体更新と FTS5 更新が同一 `transactionSync` に入っていること」を型で保証する手段が無くなるからである。ポートは DI で単独注入できてしまうので、トランザクションの外から呼べる経路が構造的に残る。第7.1節が「external-content FTS5 は旧値 delete → 新値 insert の2段が必要で、踏み外すと**例外が上がらずインデックスだけが黙って壊れる**」と書いている以上、規約頼みの保証では足りない。

**(b) を採らない理由**は、`SearchProjectionPort` に「単独 DI 禁止」という**規約**を課す形になり、(a) と同じ弱さを名前の分離だけで隠すことになるからである。第8.2節が `UnitOfWorkContext` に対して採った態度（「載せてよいものを禁止の形で書く」「到達手段そのものを無くす」）と一致しない。

### Consequences

- 良い点: 「トランザクションの外から FTS5 を書く」経路が構造的に存在しなくなる。`spec/domains/search.md` が 271 行から大幅に縮み、search ドメインの責務が「問い合わせ」に一点集中する。
- トレードオフ: **projection の実装が memo / knowledge のリポジトリ実装側に散る。** search ドメインの `spec/` を読んでもインデックスの書き方が分からなくなるので、`spec/domains/search.md` に「書き込み側はポートではない。本体を書くトランザクション内の projection 処理へ畳まれる」という**行き先の明示**を必ず残す。
- 波及: **Issue #10 のチェックリストから `DOM-SEARCH-004 SearchProjectionPort` を削除する必要がある**（steps.md ステップ18）。

---

## ADR-002: 検索キーワードの長さ上限を 500 文字のまま維持する

### Status

Proposed

### Context

Issue #10 の実装チェックリストは `DOM-SEARCH-001 SearchQuery — NFKC、非空、**UTF-8 50-byte**、optional単一topic` と `ADP-UD-003 … **50-byte guard** …` を挙げている。現行の `spec/` は **500 文字**で統一されている（`spec/domains/search.md` の `SearchQuery`、`DOM-search-001`、`UC-search-001`、`spec/testcases/search/search.md` の境界値ケース2件、`spec/manual-tests/search.md` の TC-15 / TC-16）。

50 バイトという値の出どころは、`.thread/34/design.md` 第2.1節 F-16 が記録している **`LIKE` / `GLOB` パターンの 50 バイト上限**である。先行実装がその制約を短語フォールバックに引き継いでいた。

ところが同じ design.md 第7.2節は、フォールバックの機構を `LIKE` / `GLOB` ではなく **`instr()`** に決め切っており、そのうえで次のように断定している。

> **LIKE / GLOB パターンの 50 バイト上限（第2.1節 F-16）が `instr()` には掛からない** … したがって「UTF-8 の日本語は1文字3バイトなので実質16文字が上限」という導出は本設計には効かない。**上限を根拠にした入力長制限は置かない**（入力長の制限は transport 境界の DoS 対策として別途行う）。

### Decision

**現行の 500 文字を維持し、Issue #10 側を訂正する。**

50 バイトという値は「`LIKE` / `GLOB` を使う」という**採用されなかった実装選択**から導かれた数字であり、その前提が消えた時点で根拠を失っている。一方 500 文字は transport 境界の DoS 対策としての入力長制限であり、`CLAUDE.md`「Input validation」の「transport 境界（shape / DoS）と値オブジェクト構築（業務不変条件）の2点で検証する」という規約に素直に乗る。

**「値オブジェクトの上限を実装機構の制約から導かない」を原則として明示する。** 導くと、機構を替えるたびにドメインの契約が動く。

### Consequences

- 良い点: `spec/domains/search.md` / `spec/inventory/domain.md` / `spec/testcases/search/search.md` / `spec/manual-tests/search.md` の境界値ケースを**触らずに済む**（改訂量が減り、既存のテストケースが生き残る）。
- トレードオフ: **短語フォールバック（1〜2文字）は `instr()` の索引なし全走査である。** 500 文字のクエリがフォールバック経路へ落ちることは無い（フォールバックは1〜2文字のときだけ）ので走査量は増えないが、**「対象列とページサイズを制限する」という第7.2節の要求は spec に必ず書く。**
- 波及: **Issue #10 の `DOM-SEARCH-001` / `ADP-UD-003` の「50-byte」を 500 文字へ訂正する**（steps.md ステップ18）。

---

## ADR-003: Outbox consumer 経由のインデックス維持を廃止し、`maintainSearchIndex` をユースケースごと削除する

### Status

Proposed

### Context

Issue #35 の対応項目2 は「同一 User DO 内で本体データと FTS5 を同期更新できるため、**Outbox consumer を介したインデックス維持が本当に必要か再設計する（#34 の判断に従う）**」と書いており、#35 側に判断の余地があるかのように読める。

`.thread/34/design.md` 第7.1節・第7.3節は既に判断を下している — 「Outbox consumer を介したインデックス維持は不要になる」「relay / consumer / DLQ / pruner をすべて廃止する」「`UnitOfWorkContext.collectEvents` は廃止する」。

選択肢は2つ。

- **(a) `maintainSearchIndex` ユースケースと `spec/testcases/search/maintainSearchIndex.md` を残し、「Alarm ジョブで走る再インデックス」として書き換える**
- **(b) ユースケースごと削除し、テストケースファイルも削除する**

### Decision

**(b) を採る。** design.md 第11.1節の表が `spec/testcases/search/maintainSearchIndex.md` を「**(C) ファイルごと削除**」と指定している。

**(a) を採らない理由**は、`maintainSearchIndex` が「イベントを受けて対象を読み直し冪等に upsert / remove する」という**消滅した機構そのもの**の名前だからである。残る再インデックスの契機は次の2つで、どちらも `maintainSearchIndex` の契約とは別物である。

1. **通常の書き込み** — 本体を書く `transactionSync` の中の projection 更新。ユースケースではなくリポジトリ実装の内部処理（ADR-001）。
2. **`reindex` ジョブ** — tokenizer や正規化規則を変えたときの全件再構築（第9.2節）。**migration の一部**であり、application 層のユースケースではなくアダプター側の migration 機構に属する。

名前を残して中身を入れ替えると、`spec/inventory/usecase.md` の `UC-search-002` が「実体はどこにも無いユースケース」として残り、#10 / #37 の実装者が探すことになる。

### Consequences

- 良い点: `spec/usecases/search.md` が 151 行から `search` 1本に縮む。`spec/inventory/test.md` から `TC-maintainSearchIndex-*` 28 件が丸ごと消え、台帳の見通しが良くなる。
- トレードオフ: **`reindex` ジョブの spec 上の落とし先が `spec/database/index.md` の migration 節だけになる。** application 層の設計から見えなくなるので、`spec/domains/search.md` に「tokenizer / 正規化規則を変えたときの全件再構築は migration の `reindex` ジョブが担う（`spec/database/index.md`）」という導線を1行残す。
- 波及: `spec/inventory/usecase.md` の `UC-search-002` 削除、`spec/inventory/test.md` の 28 行削除。

---

## ADR-004: FTS5 の日本語対応は「方針と機構」まで spec に書き、実測値は #37 へ委ねる

### Status

Proposed

### Context

Issue #35 の対応項目3 は「日本語検索に使う FTS5 tokenizer の選定方針と短い検索語の扱いを記述する（**実環境での検証は実装 Issue で行い、結果を spec に反映する**）」と書いている。`spec/database/index.md` にどこまで書くかには幅がある。

- **(a) 方針だけ**（「日本語には trigram を使う」程度）
- **(b) 方針 + 機構の断定**（trigram / `instr()` フォールバック / `LIKE`・`GLOB` 不採用 / NFKC を index・query 両側 / スニペットは原文から）
- **(c) (b) + 閾値・重み・ページサイズの具体値**（`bm25(search_fts, 3.0, 1.0)` など）

### Decision

**(b) を採る。**

**(a) では足りない。** design.md 第7.2節は「`LIKE` / `GLOB` は採らない」「`snippet()` / `highlight()` に依存しない」という**棄却**を明示的に記録している。棄却を spec に落とさないと、#37 の実装者が「LIKE のほうが素直では」と設計を再開させる（design.md 第8.2.1節が `ctx.storage.transaction()` の棄却理由をわざわざ残しているのと同じ形）。

**(c) は採らない。** 重み（`bm25(search_fts, 3.0, 1.0)`）とページサイズは先行実装の実測値であり、第7.2節が「**実環境での再検証は #37**」と委ねている。spec に具体値を書くと、#37 が検証結果を反映するときに spec の改訂 Issue が改めて必要になる。**spec には「タイトルを本文より重く見る重み付けを行う」という規則だけを書き、値は書かない。**

**あわせて、裏付けの種別を spec に残す。** 第7.2節は各項目に「公式ドキュメントに記載があるか / 実測が唯一の根拠か」を明記している。trigram の可用性・`bm25`・短語フォールバックはいずれも**公式記載が無く実測が唯一の根拠**であり、これは workerd のバージョンが上がったときに再検証が要ることを意味する。**この但し書きを落とさない。**

### Consequences

- 良い点: #37 が「なぜ `LIKE` ではないのか」「なぜ `snippet()` を使わないのか」を spec から読める。実測値が spec に固定されないので、#37 の検証結果の反映が spec 改訂を伴わない。
- トレードオフ: **spec だけを読んでも検索の実際の順位が再現できない。** 値の置き場所が `spec/` の外（実装と #38 の運用値）になるので、`spec/database/index.md` に「重みとページサイズの実値は実装側が持ち、#37 で検証する」という所在の明示を残す。

---

## ADR-005: `CLAUDE.md` は実装に先行して新構成で断定し、移行中であることを1箇所に集約して注記する

### Status

Proposed

### Context

Issue #35 の対応項目6 は「Reference runtimes、Unit of Work、Outbox / domain events、DB 制約の各節を DO 単独構成へ書き換える。**実装の撤去は後続 Issue だが、ルールとしての記述は本 Issue で確定させる**」と書いている。

しかし `CLAUDE.md` は「このリポジトリで**いま**作業するためのガイド」でもある。#37 が入るまで実体は D1 + Queues のままで、`packages/core/src/adapters/d1/` も `apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq}.ts` も存在する。規則だけを新構成で断定すると、`CLAUDE.md` が現状の作業ガイドとして嘘になる。

選択肢は3つ。

- **(a) 書き換えを #37 へ先送りし、#35 では触らない**
- **(b) 新構成で断定し、現行実装との差分には触れない**
- **(c) 新構成で断定したうえで、移行中であることの注記を1箇所に集約して #37 を名指しする**

### Decision

**(c) を採る。**

**(a) は Issue の対応項目6 に正面から反する。** 「ルールとしての記述は本 Issue で確定させる」が明示の要求である。

**(b) は `CLAUDE.md` の役割を壊す。** `CLAUDE.md` には既に「`pnpm start` / `pnpm preview` が起動しない（#40）」という**現況の但し書き**が置かれており、「規則と現況を書き分ける」という前例がこのファイル自身にある。差分に触れずに断定すると、#35 と #37 のあいだに `CLAUDE.md` を読んだ人が `collectEvents` を探して見つからない、という状況が生まれる。

**注記を1箇所に集約する**のは、各節に「ただし現状は…」を散らすと **#37 の完了時に消し漏れが出る**からである。1箇所なら #37 の完了条件に「`CLAUDE.md` の移行注記を削除する」を1行足すだけで済む。

### Consequences

- 良い点: `CLAUDE.md` が規則としても現況ガイドとしても正しい状態を保てる。#37 の後始末が1箇所で済む。
- トレードオフ: **注記が消し忘れられると、実装が追いついた後も「移行中」と読まれ続ける。** #37 の Issue 本文へ「`CLAUDE.md` の移行注記を削除する」を追記して受け皿を作る（ただし #37 の本文編集は #35 のスコープ外なので、**PR 本文に引き継ぎとして書く**）。
- 波及: `CLAUDE.md`「Reference runtime」の節名は**単数形のまま維持する**（PR #39 の変更を戻さない）。`spec/database/index.md:3` の `CLAUDE.md「Reference runtimes」` という壊れた名指し参照はこの機会に解消する。

---

## ADR-006: `spec/database/index.md` に設計 第4.1.1節のテーブル全数を写す

### Status

Proposed

### Context

`.thread/34/design.md` 第4.1.1節は「**本表はテーブルの全数と、認証・saga・ジョブ系テーブルの列の全数の両方の正本である。#37 が実テーブルと実列を判断する根拠はこの表である**」と宣言している。同時に「集約テーブル（`memos` / `topics` / `documents` とその子）の列は **`spec/database/index.md` が正本**であり、本表は所在だけを示す」とも書いており、**正本が2つに割れている**。

`spec/database/index.md` にどこまで写すかの選択肢:

- **(a) 集約テーブルだけを書き、認証・saga・ジョブ系は design.md を参照させる**
- **(b) 全 21 テーブルを列まで写す**
- **(c) 全 21 テーブルを名前と用途まで書き、認証・saga・ジョブ系の列は design.md を参照させる**

### Decision

**(b) を採る。**

理由は3つ。

1. **`.thread/` は Issue 単位の作業ディレクトリであり、恒久ドキュメントではない。** `.thread/34/` は #34 が閉じたあとも残るが、`spec/` から `.thread/34/design.md` を名指しで参照する形にすると、`spec/` が単独で読めなくなる。`spec/index.md` の成果物一覧に `.thread/` は載っていない。
2. **`spec/inventory/adapter.md` の生成元が `spec/database/`** である（台帳ヘッダに明記）。認証・saga・ジョブ系テーブルの `ADP-*` を新設する（steps.md ステップ12）以上、その定義場所が `spec/database/index.md` に無いと台帳の「定義場所」欄が書けない。
3. **(a) / (c) は「認証インフラテーブルはスコープ外」宣言（現行 `:355-357`）を形を変えて残すことになる。** design.md 第7.3節は、その宣言のせいでトークン失効 consumer の書き込み先スキーマが存在しなかったことを問題として名指ししている。

**ただし写す範囲に上限を置く。** `.thread/34/handoff.md` により **#44（鍵ローテーションの手順）と #45（cross-DO saga の異常系の自動回収）は #34 の成果物ではない。** `rotation_checkpoints` は列と用途まで、`jobs.terminalReason` は「一様な終端（`poison` + operator エスカレーション）」までにとどめ、**記録の契機・巻き戻しの段構成・材料寿命を書かない。**

### Consequences

- 良い点: `spec/` が単独で読める。#37 が `spec/database/index.md` だけを開いて実テーブルを組める。台帳の「定義場所」欄が全行埋まる。
- トレードオフ: **正本が `spec/database/index.md` と `.thread/34/design.md` 第4.1.1節の2箇所になり、食い違いが起こりうる。** design.md 第4.1.1節が「本表と第6〜9章の本文が食い違ったら本表を直す」という優先規則を持っているのと同じ形で、**`spec/database/index.md` の冒頭に「本ファイルが `spec/` 側の正本であり、由来は #34 の設計である」を明記する。** 以後 `spec/` を直す側が正しい。
- トレードオフ: **`spec/database/index.md` の分量が増える**（現行 403 行 → 相当量の増加）。テーブル数が 9 + 共通基盤から 21 へ増えるため。節の並びを「User Data DO / Identity Directory DO」の2部構成にして、集約テーブルと非集約ストアを分ける。
- 波及: **写し切ったことを機械で測るのが plan.md の `P-10` である**（`TABLE-MISSING:` が 0 行。着手前は 10 行）。**21 は DO クラス別のセル数で、`jobs` と `_meta` が両クラスに現れるため名前の異なり数は 19** — `P-10` は後者を回す。この検査が無いと、10a の削除だけ済んで 10b / 10c の追記を飛ばした中間状態が完了ゲートを通過する。

---

## ADR-007: レビュー記録（`spec/**/review/`）を改訂対象から外す

### Status

Proposed

### Context

Issue #35 の背景節は旧前提が残っているファイル一覧に **`spec/usecases/review/002.md`** を挙げている。実測でも走査語に7件ヒットする。一方 Issue のコメント（PR #39 からの引き継ぎ）は `spec/database/review/002.md` / `003.md` について「レビュー記録＝過去の判断の記録なので、履歴として残すのが自然」と整理している。

`.thread/34/design.md` 第11.1節は走査の除外対象を **`spec/**/review/**` の 39 ファイルだけ**と定め、`spec/usecases/review/002.md` について「**改訂しない、と断定する**」「#35 は Issue 本文の当該行を『レビュー記録なので改訂対象から外す』と読み替えて着手する」と明示している。

### Decision

**`spec/**/review/` の 39 ファイルすべてを改訂対象から外す。** `spec/usecases/review/002.md` も含む。

理由は design.md の断定と同じ — **レビュー記録は「そのとき何を指摘したか」の履歴であり、後から本文を書き換えると記録としての意味が消える。**

**`spec/idea.md` に例外を認める**のは、あれが**現在の前提を述べる文書**であって履歴ではないためで（Issue の対応項目1 が名指しで改訂を要求している）、この論拠は `review/` には及ばない。

**`spec/adr/` の6ファイル本文も同じ扱いにする**（Issue の対応項目4 が「ADR 本文は書き換えず、参照側を更新する」と定めている）。`spec/adr/004-domain-boundaries.md:25` の「単一のハイブリッド検索」という引用も残す — **引用元の要件が「単一の全文検索」へ変わっても、棄却理由（入口が分かれる）は成立し続ける。**

### Consequences

- 良い点: 履歴が保全される。改訂範囲が 140 ファイルから 101 ファイル（うち改訂 72 件）へ絞られる。
- トレードオフ: **完了ゲートの grep を素朴に書くと `review/` と `spec/adr/` がヒットして「旧前提が残っている」と誤判定される。** plan.md の V-1〜V-8 はすべて `grep -v '/review/' | grep -v '^spec/adr/'` で射程を絞る形にしてある。**この2つの除外を落とすと検証が機能しない。**
- 波及: **Issue #35 本文の背景節の旧前提ファイル一覧から `spec/usecases/review/002.md` を除いて読む。** PR 本文にこの読み替えを明記する。
- 波及: **「射程はファイル・行の単位で外し、走査語のほうは触らない」という本 ADR の形が、以後の除外の型になった。** `V-2b`（`spec/manual-tests/{search,trash}.md` をファイル単位で外し `V-2c` を当てる）と **ADR-014**（`spec/index.md` の ADR 一覧表の `005` 行1行を外し `V-5` を当てる）はどちらもこの型で、**外した先に必ず別の検査を当てる**ことで基準を緩めていない。

---

## ADR-008: #10 / #13 の Issue 本文を `spec/inventory/` の ID 体系に合わせる（逆ではない）

### Status

Proposed

### Context

Issue #35 の受け入れ条件7 は「改訂後の `spec/inventory/` と #10 の実装チェックリスト（`DOM-SEARCH-*` / `UC-SEARCH-*` / `ADP-UD-*` / `PAGE-search-*` / `TEST-*`）の ID・内容が一致しているか照合し、**ズレていれば #10 側を更新する**」と書いている。

実測すると、ズレは「内容の差」ではなく **ID 体系そのものの差**である。

| #10 の接頭辞 | `spec/inventory/` の接頭辞 | 一致 |
|---|---|---|
| `DOM-SEARCH-*` | `DOM-search-*`（小文字） | 不一致 |
| `UC-SEARCH-*` | `UC-search-*`（小文字） | 不一致 |
| `ADP-UD-*` | `ADP-{table\|domain}-*`（`ADP-UD-*` は台帳に存在しない） | 不一致 |
| `PAGE-search-*` | `PAGE-search-*` | **一致** |
| `TEST-DO-*` / `TEST-MAN-*` | `TC-{usecase}-{3桁}`（`TEST-*` は台帳に存在しない） | 不一致 |

#10 のチェックリストは「`spec/inventory/` 由来」と自称しているが、実際には改訂後の姿を先取りして**独自に採番されたもの**である（`ADP-UD-001`〜`004` の「UD」は User Data DO の略で、これは #34 の設計の語彙）。

### Decision

**`spec/inventory/` の既存体系（`DOM-{domain 小文字}-{3桁}` / `UC-{domain 小文字}-{3桁}` / `ADP-{table|domain}-{3桁}` / `PAGE-{page}-{3桁}` / `TC-{usecase}-{3桁}`）を維持し、#10 / #13 の本文を台帳に合わせて書き換える。**

**台帳側を #10 に合わせない理由**は3つ。

1. **台帳は `spec/` 全体の横断索引であり、6ドメイン分の ID が既にこの体系で採番されている。** 検索だけ大文字にすると体系が2つになる。
2. **`ADP-UD-*` は物理境界（User Data DO）による分類であり、台帳の分類軸（テーブル / ドメインポート）と直交する。** 物理境界での分類は `spec/database/index.md` の2部構成（ADR-006）が担う。
3. **`TEST-*` は `spec/testcases/` に対応するファイルを持たない。** 台帳の `TC-*` は `spec/testcases/{path}#L{n}` を「定義場所」に持つ形で、定義場所が実在することが台帳の不変条件になっている。

**Issue の受け入れ条件7 が「ズレていれば #10 側を更新する」と書いているのは、この結論と一致している。**

### Consequences

- 良い点: 台帳の体系が保たれ、#10 / #13 のチェックリストが実在する ID を指すようになる（`spec/inventory/` へ grep すれば全件ヒットする形になり、plan.md の AC-14 / AC-15 が機械検証できる）。
- トレードオフ: **#10 のチェックリストの粒度が変わる。** #10 は `ADP-UD-001`〜`004` の4行に User Data DO 側の全機構を畳んでいたが、台帳の `ADP-*` はテーブル / メソッド単位なので**行数が増える**。#10 の実装者から見ると項目が細かくなる。
- トレードオフ: **#10 の「検索仕様」節（チェックリストの外にある散文）には `ADP-UD-*` の粒度で書かれた内容が残る。** ここは ID を持たない説明文なので、内容が改訂後の spec と矛盾しないことだけを確認する（trigram / 短語フォールバック / bm25 / スナップショットページング / topic filter / ゴミ箱除外はすべて設計と一致している）。
- 波及: **#13 についても同じ扱いで、`DOM-identity-016` / `DOM-identity-017` / `TC-revokeAiClientConnection-002` を除く**（第7.3節でイベント transport と失効 consumer が消えるため）。

## ADR-009: cross-DO saga の終端について `spec/` に書けるのは「利用者から観測できる結果」までとする

### Status

Proposed

### Context

`.thread/34/handoff.md` は **cross-DO saga の異常系の「自動回収」を Issue #45 へ切り出す**と決めている（第2節）。#34 に残すのは一様な終端（`terminalReason` + `poison` + operator エスカレーション）だけで、段の順序・原子性境界・終端モードの印・後始末失敗時の規則・材料寿命・起点別の扱いは #45 が設計する。

**ところがこの切り出しはまだ `.thread/34/design.md` に反映されていない**（handoff 第2節末尾「この切り出しはまだ design.md に反映していない」、第3節ステップ1「次の担当者がやること」）。実測でも `design.md` に `#45` の言及は 0 件で、第6.4節 3-i〜3-iii の段構成・第6.6節 link の巻き戻し・第6.5.1節の終端規則がそのまま残っている。

その状態の design 第11.1節（`design.md:2422`）は #35 に対して、`spec/testcases/identity/changePassword.md` に「**`resume-credential-change` が前進不能を確定したときに `changeState` / `changeOrigin` / `pendingVerifier` / `operationId` が `null` へ戻り、旧パスワードでログインできる**」ケースを足せ、と指示している。

**これを額面どおり写すと #45 の射程を先取りする。** どの列がどう戻るかは巻き戻し手順そのものであり、handoff 第2節が #45 へ委譲したものの一部である。一方 plan.md のスコープ節は「`spec/` に書けるのは一様な終端までで、巻き戻し手順・段構成・材料寿命を書かない」と宣言している。**つまり実装者はステップ10 では境界を守り、ステップ14 で越えることになる。**

### Decision

**plan.md の宣言を正とし、steps.md ステップ14 の当該指示を訂正する。** `spec/` に書いてよいのは次の2つに限る。

1. **中間状態のあいだの観測結果** — `changeState` が `null` でない間（`'pending'` / `'advanced'`）は旧新どちらのパスワードも通らない。値域が3値であることと `'advanced'` が phase 2 の適用を記録する値であることは**材料の存在**として書いてよい（handoff 第3節が「#37 が落としてはいけない前方互換点」の4番目に挙げている）。
2. **終端後の観測結果** — 前進不能が確定して中間状態が解除されれば、旧パスワードでログインできる。

**書かないもの**（handoff 第2節「#45 へ委譲するもの」の裏返し）:

- どの列が `null` へ戻るかという**巻き戻し手順**（`changeState` / `changeOrigin` / `pendingVerifier` / `operationId` の列挙）
- 段の順序と原子性境界（3-i / 3-ii / 3-iii、コーディネーター行の除外単位）
- 終端モードの印の置き方（`jobs.terminalReason` の前倒し書き込み）
- 後始末そのものが失敗したときの規則と再試行上限
- 起点別の (i)/(ii) の使い分け（`changeOrigin = 'reset'` の併用）
- link の終端の巻き戻し手順

**`design.md` は書き換えない。** #34 の成果物であり、#35 の射程外である（handoff 第3節ステップ1 は反映を #34 の次の担当者の仕事としている）。#35 は「design の指示のうち #45 の射程に当たる部分を `spec/` へ写さない」という形で境界を守る。

### Consequences

- 良い点: **#45 がどう設計しても `spec/` を書き換えずに済む。** 観測結果の記述は巻き戻しの実現方法に依存しない。
- 良い点: **第6.9節の「どの中間状態でも認可は fail closed に倒れる」という宣言は `spec/` 側でも満たされる** — 中間状態で旧新どちらも通らないことを書くので、残るのは可用性の問題であって認可は開かない。
- トレードオフ: **`spec/` を読んだだけでは「前進不能がどう解消されるか」が分からない。** ステップ14 のケースには「終端の具体的な手順は #45」と1行残して dangling を避ける。
- トレードオフ: **design 第11.1節の指示と `spec/` の記述が1箇所ずれる。** ずれの根拠は本 ADR と handoff 第2節であり、PR 本文にも明記する。
- 波及: ステップ10 の `jobs.terminalReason` / `rotation_checkpoints` の記述、およびステップ10d の `jobs.kind` 全数表にも同じ線が効く（`rotate-remap` の実行主体と終端の段構成には踏み込まない）。

## ADR-010: `spec/manual-tests/index.md` を「影響なし」判定から外し、目次・件数を最後に同期する

### Status

Proposed

### Context

設計 第11.1節は `spec/manual-tests/index.md` を**影響なし29件**の1つに数えている（`design.md:2487`）。理由は「**件数表と推奨実行順序だけを持つ。手順の実体は各ファイルにあり、そちらで改訂される**」。

**この判定は「件数が動かない」ことを前提にしている。** 実測すると本 Issue 自身の編集で動く。

- ステップ15 は `spec/manual-tests/account.md` にロックアウト再現・失効確認・必須導線の3系統を足す。
- ステップ16 は `spec/manual-tests/search.md` に FTS5 の確認項目（日本語 trigram / 短語 / 順位 / スニペット）を足す。
- 現行の件数表は `account 37 / timeline 37 / document 41 / search 17 / trash 25 / ai 23 / settings 12`、合計 **192**。実測（`grep -cE '^#+ TC-[0-9]+'`）と完全一致しているので、新規 `TC-NN` を足せば表も合計も実行記録欄の分母（`/192件 PASS`）も嘘になる。

同じ問題が `spec/index.md` にもある。「進捗」「成果物」節の転記数値 —「DB設計（**SQLite系・9テーブル＋共通基盤**）」「6ドメイン・**52ユースケース**」「**約750ケース**」「**192ケース**」— は、ステップ8（`maintainSearchIndex` の削除で 52 → 51）・ステップ10（21テーブル・DO 2部構成）・ステップ13〜15（ケース数の増減）で全部ずれる。**steps.md ステップ11 は `spec/index.md` の `:38-43`（ADR 一覧表）しか触らない。**

さらに悪いことに、**これらは V-1〜V-8 のどの語にも掛からない**（「SQLite系」「9テーブル」は走査語ではない）。AC-11 は「消える」側しか見ないので検出できない。**改訂を完璧にやっても `spec/` のトップページに AC-7 と正面から矛盾する記述が残る。**

### Decision

**設計の「影響なし」判定を上書きし、`spec/index.md` と `spec/manual-tests/index.md` を改訂対象へ格上げする。** 作業は独立したステップ16.5「目次・件数を同期する」に置き、**すべての `spec/` 編集が終わったあとに数え直す**。

検証は AC-18 として機械化する。

- `grep -n '9テーブル\|SQLite系\|52ユースケース\|192ケース\|約750ケース' spec/index.md` が **0 行**（着手前は 6 行）。
- `spec/manual-tests/index.md` の件数表の各行・合計・実行記録の分母が、`grep -cE '^#+ TC-[0-9]+' spec/manual-tests/{各}.md` の実測と一致する。

**「新規 `TC-NN` を作らず既存 TC の確認ポイントとして足す」という逃げ道は選ばない。** 件数を固定するために表現を歪めることになり、FTS5 の確認項目は独立した TC のほうが実行しやすい。件数が動くことを受け入れて、最後に数え直すほうが素直である。

### Consequences

- 良い点: **設計の「影響なし」判定と実物のズレが1件閉じる。** 判定の根拠（「件数表だけを持つ」）は正しいが、その件数が動くという前提の変化を捉えていなかった。
- 良い点: **AC-18 が機械検査になる。** 目次・件数は典型的に目視で見落とす領域で、`grep -c` による突き合わせは安価に再現できる。
- トレードオフ: **ステップ16.5 は他のすべての `spec/` 編集に依存する**ので、途中で戻って TC を足すと再実行が要る。ステップ15・16 から「足した数」を申し送る運用にする。
- 波及: `.thread/35/coverage.md` では `spec/manual-tests/index.md` の判定を「影響なし」ではなく「**改訂（ステップ16.5）**」と記録する。設計 第11.1節の影響なし29件は 28件になる。

## ADR-011: `spec/inventory/domain.md` のドメインイベント行 24 件を削除し、台帳 ID は欠番のまま繰り上げない

### Status

Proposed

### Context

設計 第7.3節は「Outbox をドメインイベントの transport として使うのをやめる」と決め、**イベントは transport としても業務表現としても残らない**と断定している。ステップ7 は `spec/domains/{memo,knowledge,identity}.md` のイベント定義表を丸ごと削除する。

**ところが `spec/inventory/domain.md` には「定義場所」欄が `spec/domains/*.md#ドメインイベント` の行が 24 件実在する**（実測: `DOM-identity-013`〜`017` 5件 / `DOM-memo-007`〜`012` 6件 / `DOM-knowledge-015`〜`027` 13件。`grep -c '#ドメインイベント' spec/inventory/domain.md` = 24）。ステップ7 が定義表を消せば、この 24 行は定義場所を失う。

**設計 第11.1節「改訂する — 台帳」の `spec/inventory/domain.md` 行（`design.md:2433`）はこの 24 件を挙げていない。** 挙げているのは「`IndexEntry` 系のうちベクトル・埋め込み由来のもの / identity の `User` 判別共用体 / trash の期限列挙」の3項目だけである。**表の1行だけを読んで書き換えると必ず取り残す** — `.thread/34/handoff.md` 第4節 罠1（正本だけを直して適用先へ届けない）が、正本の側の数え落としとして現れた形である。

**機械検査も当てにしすぎてはいけない。** 24 行は `V-3` に**全件掛かる**（走査語 `ドメインイベント` が「定義場所」欄に当たる。これは検証済みの事実であり、レビューが「21 行はどの負の検証にも掛からない」と書いていたのは誤りである）。しかし `V-3` が実装者に見せるのは「この行はヒットしている」までで、**要点欄とアンカーだけを書き換えれば `V-3` は 0 になる。** そのとき 24 行は定義場所を失ったまま残る。`P-8` は「アンカー先の見出しが実在するか」しか見ないので、ステップ7 が表だけ消して `## ドメインイベント` の見出しを残せば 0 行のまま通る。

**加えて AC-15 がこの削除を暗黙の前提にしている。** ステップ18 は #13 のチェックリストから `DOM-identity-016` / `-017` を除く指示を出している。台帳側を消さないと「#13 からは除いたが台帳には残っている」という非対称が生まれ、受け入れ条件7（#10 / #13 と台帳の一致）の趣旨に反する。

**削除すると連番の扱いが問題になる。** `DOM-identity-013`〜`017` の直後には `DOM-identity-018`〜`022`（`UserRepository` 5本）と `DOM-identity-023`〜`028`（`AiClientConnectionRepository` 6本）が並んでおり、**後者は #13 のチェックリストが参照している**（`gh issue view 13` で確認済み）。連番を詰めると 023〜028 が 018〜023 へずれ、**AC-14 / AC-15 の「実在する」検査を通ったまま別の要素を指す。**

### Decision

**設計 第11.1節の台帳表が落としている 24 件を、#35 が埋める。** ステップ12 の `spec/inventory/domain.md` の指示に「定義場所が `#ドメインイベント` の 24 行を**行ごと削除する**」を明記し、AC-9 の削除リストにも同じ 24 件を加える。要点欄の書き換えでは済まさない。

**あわせて台帳 ID の欠番規約をステップ12 に置き、ステップ15.5 から参照する。**

- **削除した行の ID は欠番のまま残し、後続 ID を繰り上げない。** 対象は `DOM-*` / `UC-*` / `ADP-*` / `PAGE-*` / `TC-*` のすべて。
- **新設する行は各表の末尾に append する。**

ステップ13 が `TC-*` について置いた規約（`spec/inventory/test.md` のヘッダが「連番はテーブルの行順に対応する」と宣言しているため）と同じ理屈を、台帳全体へ広げたものである。

### Consequences

- 良い点: **設計側の数え落としが1件閉じる。** 第7.3節（正本）とステップ7（適用）と台帳が同じ結論に揃う。
- 良い点: **#13 が参照する `DOM-identity-023`〜`028` が改訂前と同じ要素を指し続ける。** AC-15 の作業が「消える3件を除く」だけで済むという整理（`.thread/35/plan.md`）が維持される。
- トレードオフ: **台帳の連番が飛ぶ。** 読みづらくはなるが、ID は採番順の識別子であって順序に意味は無く、詰め直すコスト（#10 / #13 の全 ID の追随）のほうがはるかに高い。
- トレードオフ: **設計 第11.1節の表と `spec/` の記述が1箇所ずれる。** ずれの根拠は本 ADR であり、PR 本文にも明記する（ADR-009 / ADR-010 と同じ扱い）。
- 波及: ステップ7 は定義表だけでなく **`## ドメインイベント` の見出しごと**消す（見出しを残すと `P-8` が dangling を検出できなくなる）。

## ADR-012: 検索のページングを不透明カーソル方式に一本化し、第7.2.1節の4点を適用先まで届ける

### Status

Proposed

### Context

設計 第7.2.1節は「**#35 へ委譲**」と明記された節であり、`spec/` 側にしか正本が無い（`design.md:1642-1652`）。#35 への入力として送られているのは次の4点である。

1. topic filter は optional な単一トピック。**未知・ゴミ箱内のトピック指定は `TOPIC_NOT_FOUND`。**
2. 順位の同点は `timestamp DESC, type, id` で決定する。
3. **ページ間の変更で重複・欠落を出さないため、最初のクエリで結果 DTO を期限付きのスナップショットへ固定し、不透明なカーソルから同じ集合を読む。**
4. 検索エントリとトピックは正規化した事実の join で結ぶ。

計画は当初この4点を `spec/domains/search.md`（ステップ5）にだけ落とす形になっていた。実物と突き合わせると2つが宙に浮く。

- **`TOPIC_NOT_FOUND` は `spec/` 全域に 0 件の新規エラーコードである。** `spec/usecases/search.md` のエラーケース表（`:78-84`）に行が要るが、ステップ8 の指示は「`search` 節は残す。`:73` を削除。`:3` を差し替える」だけだった。
- **page 番号方式が下流に残る。** `spec/usecases/search.md` の入力 DTO は `page` / `limit`（`:24`）、処理フローは `Pagination` 構築（`:64`）、エラーケースは「page / limit が範囲外」（`:82`）。`spec/testcases/search/search.md` は `grep -nw 'page'` が6行ヒットし、うち `:24`（「`page: 1` → `page: 2` で重複しない」）はまさに置き換え対象の期待値である。**domains にだけカーソル方式を書くと、改訂後の `spec/` に2つのページング方式が同居する。**

### Decision

**第7.2.1節の4点の落とし先を、ドメインだけでなく適用先まで確定させる。**

| 点 | 落とし先 | ステップ |
|---|---|---|
| topic filter と `TOPIC_NOT_FOUND` | `spec/domains/search.md`「検索の規則」**と** `spec/usecases/search.md` のエラーケース表 | 5・8 |
| 安定順位 `timestamp DESC, type, id` | `spec/domains/search.md`「検索の規則」 | 5 |
| 不透明カーソルによるページング | `spec/domains/search.md`（契約）/ `spec/usecases/search.md`（入力 DTO・処理フロー・エラーケース）/ `spec/testcases/search/search.md`（既存ケースの読み替え）/ `spec/pages/index.md` P-11 | 5・8・13・4 |
| 事実 join | `spec/domains/search.md` | 5 |

**page 番号方式は残さない。** `spec/usecases/search.md` の `page` を `cursor`（optional。未指定が先頭ページ）へ置き換え、`limit` は方式に依らないので残す。`spec/testcases/search/search.md` の扱いは行ごとに決める — `:24` / `:27` は **(A) カーソル方式へ読み替え**、`:34`（`page: 0`）/ `:35`（`page: 1.5`）は **(C) 削除**して「不正・期限切れのカーソルはバリデーションエラー」を1ケース足す、`:7` / `:25` は主題が page ではないので `page: 1` の記述だけを落とす。**`limit` の境界ケース（`:26` / `:36` / `:37`）はそのまま残す。**

検証は次の2本で機械化する。

- **`V-10`**（負）— `grep -nw 'page' spec/usecases/search.md spec/testcases/search/search.md spec/pages/index.md` が **0 行**（着手前は 9 行）。
- **`P-2`**（正）— `TOPIC_NOT_FOUND` を `spec/domains/search.md` と `spec/usecases/search.md` の**独立した2本**で測る（束ねると domains 側にだけ書いて通る）。

### Consequences

- 良い点: **「正本だけを直して適用先の散文に届けない」という handoff 第4節の破れ方を、第7.2.1節について構造的に塞ぐ。** 落とし先が表になっているので、どれか1つを飛ばすと `V-10` か `P-2` のどちらかが落ちる。
- 良い点: **`spec/testcases/search/search.md` の既存ケースが (A)/(C) のどちらかに明示的に割り当てられる。** ステップ13 が「新設ケースを足す」としか書いていなかったせいで既存ケースが宙に浮いていた状態が解消する。
- トレードオフ: **`:24` の新旧が重なる。** ステップ13 が足す新設ケース (vi)（ページ間に重複・欠落が出ないこと）は `:24` の読み替えと役割が重なるので、(vi) は `:24` の拡張として書き、二重に作らない。
- 波及: `spec/usecases/search.md` の出力 DTO も `PaginationResult`（`count` を持つ）のままでよいかが問題になる。**カーソル方式でも総件数は返せる**（スナップショットに固定した集合の件数）ので DTO の形は変えない、と決める。これも第7.2.1節が #35 へ委譲した領分である。

## ADR-013: 検索スナップショットの物理定義は `spec/` で確定させず #37 へ預ける

### Status

Proposed

### Context

ADR-012 が採った不透明カーソル方式は、設計 第7.2.1節の文言では「**期限付きのスナップショットテーブル**」に結果 DTO を固定する形になっている。**ところがこのテーブルの置き場が決まらない。**

- 設計 **第4.1.1節はテーブル全数の正本**であり、「#37 が実テーブルと実列を判断する根拠はこの表である」と自分で断定している。その表の User Data DO 16テーブル（`account` / `user_settings` / `credential_locators` / `ai_client_connections` / `memos` / `memo_revisions` / `topics` / `documents` / `document_revisions` / `source_links` / `search_entries` / `search_fts` / `jobs` / `operations` / `migration_progress` / `_meta`）に**スナップショットテーブルは無い。**
- 一方 adr.md **ADR-006** は「`spec/database/index.md` に第4.1.1節のテーブル全数を写す」と決めている（AC-7）。

**したがって書けば AC-7 の「第4.1.1節のテーブル全数」と矛盾し、書かなければ `spec/` に定義の無いテーブル名が残る。** 後者は ADR-006 が避けたかった「`spec/` を単独で読む #37 の実装者にとって dangling な語」そのものである（ステップ10d が `jobs.kind` の全数表を置いた理由と同じ問題）。

### Decision

**物理定義は `spec/` で確定させない。** `spec/domains/search.md` に書くのは**契約**まで、`spec/database/index.md` に書くのは**預け先の注記1行**までとする。

- **`spec/domains/search.md`（ステップ5）** — 「同じカーソルからは同じ集合が読める」「カーソルには有効期限があり、期限切れのカーソルは拒否される」という**利用者から観測できる契約**を書く。「テーブル」という語で物理を断定しない。
- **`spec/database/index.md`（ステップ10d）** — 「**不透明カーソルが指す期限付きスナップショットの物理形は #37 が決める**」を1行残す。テーブル名も列も確定させない。
- **第4.1.1節の16 + 5 テーブルは動かさない。** AC-7 の「テーブル全数」は第4.1.1節の全数のままである。

**手本は `jti` 一回性テーブルを #13 へ預けた形である**（第4.1.1節 `573-575`「テーブル定義は #13 の範囲であり、本書では名前を確定させない」）。あちらと同じく、**預け先を名指しした1行があることが dangling を防ぐ唯一の手段**である。

預け先を #37 にするのは、adr.md **ADR-004** が FTS5 の日本語対応について採った線（「方針と機構まで `spec` に書き、実測値は #37 へ委ねる」）と同じである。スナップショットの寿命・粒度・退避先（テーブルか DO storage か）は実測とストレージ上限（1 DO あたり 10 GB）に依存する判断であり、`spec/` が先に決めると #37 が実測で覆すことになる。

### Consequences

- 良い点: **AC-7 と `P-2` が両立する。** テーブル全数は第4.1.1節のまま、カーソル契約は `spec/domains/search.md` に載るので `P-2` のカーソル行もヒットする。
- 良い点: **#37 が実測でスナップショットの形を選べる。** 期限付きテーブル / DO storage の一時キー / クエリ再実行 + tie-breaker による安定化のどれを採っても `spec/` を書き換えずに済む。
- トレードオフ: **`spec/` を読んだだけでは「スナップショットがどこに置かれるか」が分からない。** 注記1行で預け先（#37）を指すことで dangling は避ける。
- トレードオフ: **第7.2.1節の文言（「スナップショットテーブル」）をそのまま写さない。** 写さない判断の根拠は本 ADR であり、ADR-009 / ADR-011 と同じく PR 本文に明記する。
- 波及: plan.md の `P-2` は「スナップショット**テーブル**」ではなく **`不透明カーソル`** を探す形にしてある（テーブルという語を要求しない）。**`スナップショット` 単独は検査語にしない** — 既存のリビジョン記述に6行当たり（`spec/database/index.md:183,184,292,295,380` / `spec/domains/search.md:15`）着手前 0 にならないためで、2周目の相互整合チェックで狭めた。**カーソルの契約が書かれたことを測るのは `不透明カーソル` の2セル（`spec/database/index.md` / `spec/domains/search.md`）だけである。**

## ADR-014: `spec/index.md` の ADR 一覧表の `005` 行はリンクごと残し、`V-3` の射程からその1行だけを外す

### Status

Proposed

### Context

`V-3`（Outbox / イベント transport の負の検証）は `Outbox` を `-i` で走査する。**`spec/adr/005-search-index-via-outbox.md` というファイル名がこの語を含む**ので、`spec/` の中でこのファイルへリンクしている行はすべて `V-3` にヒットする。実測で6行あり、そのうち5本はステップ11 が本文ごと差し替えるので消える。**残る1本が `spec/index.md:42` の ADR 一覧表の行**である。

```
| [005](./adr/005-search-index-via-outbox.md) | 検索インデックスの更新方式 |
```

この行は消せない。design `:2444` は「`:38-43` の ADR 一覧表に `spec/adr/005-search-index-via-outbox.md` の superseded を**反映し**、`.adr/002`〜`.adr/004` への導線を足す」と指示しており、AC-13 も「注記つきで残す」形になっている。ADR 本文もファイル名も本 Issue では変えない（対応項目4・ADR-007）。**つまり改訂を完璧にやってもこの1行は残り、AC-3 の「`V-3` が 0 行」は構造的に達成不可能である。**

選択肢は3つ。

- **(a) 一覧表の `005` 行からリンクを外し、テキストだけにする**
- **(b) `V-3` の射程からこの1行だけを外す**（`V-2b` が `spec/manual-tests/{search,trash}.md` を外したのと同じ形）
- **(c) 走査語 `Outbox` を弱める**

### Decision

**(b) を採る。除外はこの1行だけで、パターンは行頭のセルの形に一致させる。**

```bash
| grep -v '^spec/index\.md:[0-9]*:| \[005\]'
```

**(a) を採らない理由**は、`spec/index.md` の ADR 一覧が `spec/` から `spec/adr/` へ到達する唯一の索引だからである。リンクを外すと **supersede された ADR に `spec/` 側から到達する導線が1本も無くなる** — superseded は「読まなくてよい」ではなく「なぜ覆されたかを読む価値がある」記録であり、#38 のドキュメント Issue で必ず蒸し返される。

**(c) を採らない理由**は、`Outbox` が `V-3` の中核語だからである。弱めると `spec/` に残った本物の Outbox 記述を落とす。ADR-007 が「除外2つ（`review/` と `spec/adr/`）を落とすと検証が機能しない」と決めたのと同じ理由で、**射程はファイル・行の単位で外し、語のほうは触らない。**

**基準は緩めていない。** 外した行の内容は `V-5`（無注記の `ADR-005` 参照が 0 行）が**同一行に `superseded` の注記があること**で測る。除外したうえで注記を書き忘れれば `V-5` で落ちるので、この行に対するゲートは1本残る。

**あわせて、併記の書き方を1つに決める。** 併記をリンク形式（`[ADR-005](../adr/005-search-index-via-outbox.md)（superseded）`）で書くと、**`V-5` は通るのに `V-3` が落ちる**行を実装者が何本でも作れてしまう。したがってステップ11 は「**併記はファイル名を書かないプレーンテキスト**（`spec/adr/005`（superseded。根拠側は `.adr/003`、方式側は `.adr/004`））」で行い、**文字列 `005-search-index-via-outbox` を残してよいのは ADR 一覧表の1行だけ**とする。

### Consequences

- 良い点: **AC-3 が達成可能になる。** 1周目 coverage/P-001（`\bD1\b` が `D-D1` に当たる）と同じクラスの問題を同じ形（射程をファイル・行で外し、外した先に別の検査を当てる）で閉じられる。
- 良い点: `spec/adr/005` への導線が残るので、#38 が索引を作り直す必要が無い。
- トレードオフ: **除外パターンが `spec/index.md:42` の行の書式に依存する。** セルを組み替える（打ち消し線を入れる・リンクを2列目へ動かす）と除外が外れて `V-3` が 1 行残る。**ステップ11 に「行頭のセルの形を保つ」を明記して固定した。**
- 波及: plan.md の `V-3` ベースラインが 297 → **296**（除外後）。AC-3 の文言と steps.md ステップ11・19 に反映済み。

## ADR-015: 正の検証のセルは「そのファイルを担当するステップが実際に書く語」でだけ測る

### Status

Proposed

### Context

2周目に `P-1` / `P-2` をファイル別へ割った（coverage/P-005 への対応）。ところが割った先のセルとステップの指示を突き合わせていなかったため、**どのステップの指示でも書かれない語を要求するセル**が残った。3周目レビューが実測で見つけたのは次の3系統である。

- **`P-2` の `spec/domains/search.md` 側の `trigram` / `NFKC`** — ステップ5（`spec/domains/search.md` の全面改訂）は tokenizer に一言も触れていない。tokenizer 方針の落とし先はステップ10d（`spec/database/index.md`）であり、それは **ADR-004** の決定そのものである。
- **`P-1` の `spec/scenario/search.md` / `spec/usecases/search.md` の `FTS5`** — ステップ3 の指示は「ハイブリッド検索 → 全文検索」の置換で、design `:2358` も全文検索への置き換えまでしか要求していない。ステップ8 の指示（`maintainSearchIndex` 削除 / `TOPIC_NOT_FOUND` / カーソル化 / `:3` の差し替え）にも `FTS5` は現れない。
- **`P-7` の第8・第9行** — `spec/manual-tests/account.md` の `所有確認|verification` は design 第11.1節の指示では **scenario 側**（第7行）の要求であり、手順書側の指示は「ロックアウト / 脱出経路 / 失効 / 必須導線 / TC-29 の理由差し替え」の4点である。`spec/testcases/export/exportAllData.md` の `総バイト` も、ステップの文言は「上限超過」なので一致しない。

**放置すると、実装者はゲートを通すためだけに語を挿すことになる。** その挿し先が問題で、`spec/domains/search.md` に `trigram` / `NFKC` を書けば **ADR-004 が `spec/database/index.md` へ一本化した実装機構が search ドメインへ漏れ**、ADR-001 が狙った「search ドメインは問い合わせに一点集中」も崩れる。`spec/scenario/search.md` に `FTS5` を書くのは、利用者から見た振る舞いだけを書く層に実装語彙を持ち込む形になる。

### Decision

**検査セルのほうを、実際の落とし先に合わせて訂正する。ステップの指示は歪めない。ADR-004 のレイヤ配置を正とする。**

| セル | 変更前 | 変更後 | 根拠 |
|---|---|---|---|
| `P-2` `spec/database/index.md` | `trigram` / `NFKC` / `不透明カーソル` | 変更なし | ADR-004（機構はここ） |
| `P-2` `spec/domains/search.md` | `trigram` / `NFKC` / `不透明カーソル` | **`不透明カーソル` のみ** | ドメインに書くのは契約まで（ADR-013） |
| `P-1` `spec/scenario/search.md` | `FTS5` | **`全文検索`** | シナリオは利用者から見た振る舞いの層 |
| `P-1` `spec/usecases/search.md` | `FTS5` | **`全文検索`** | ステップ8 の実際の書き換え対象は `:3` の「ハイブリッド検索」 |
| `P-7` 第8行 | `所有確認\|verification` | **`ロックアウト`** | design の manual-tests/account.md 行 (i) |
| `P-7` 第9行 | `総バイト\|上限を超え` | **`上限\|transactionSync`** | design の exportAllData.md 行（上限超過ケース + 実行位置の分割） |

**完了検出の強さは落ちていない** — 変更後の語はいずれも**着手前 0 行**である（`全文検索` は6ファイルすべてで 0、`ロックアウト` / `上限` / `transactionSync` も 0）。

**原則として言い換えると、正の検証は「ステップの指示文に実在する語」でしか書かない。** 検査語がステップの指示に無いときは、(i) ステップに書かせるのが設計上正しいならステップへ1行足す、(ii) そうでないなら検査語をステップの語へ合わせる — の二択であり、**どちらでもないまま残すと実装者が層をまたいで語を挿す。**

### Consequences

- 良い点: **完了ゲートを通す作業が、そのままステップの作業になる。** 「ゲートのために語を挿す」という抜け道が消える。
- 良い点: ADR-004 / ADR-001 のレイヤ配置が検査側からも支持される（検査が配置を破る方向へ押さなくなる）。
- トレードオフ: **`spec/domains/search.md` に tokenizer が書かれていないことは、もう機械では検出できない。** ADR-004 の配置が正なので検出する必要も無いが、逆向きの誤り（ドメインへ機構が漏れる）は `V-*` にも `P-*` にも掛からない。**ステップ5 の「やってはいけないこと」に明記して目視の対象にした。**
- 波及: plan.md の `P-1` / `P-2` / `P-7` のコマンドとベースライン表、steps.md ステップ3・5・8・15 の記述。

## ADR-016: 新規に書く文言では `埋め込み` を使わず「DO 内の SQLite」と書く

### Status

Proposed

### Context

`V-1`（ベクトル検索の負の検証）は `埋め込み` を走査語に持つ。既存の `spec/` では「埋め込みベクトル」「埋め込み生成」の形で使われており、走査語として正しい。

一方、設計 第7.1節は FTS5 の同期更新の根拠を次のように書いている。

> User Data DO の `search_entries` / `search_fts` は本体テーブル（`memos` / `documents`）と**同一の埋め込み SQLite** に置かれる。

ここでの「埋め込み」は embedded（DO に内蔵された）の意味で、ベクトルとは無関係である。**ステップ10 / 5 がこの言い回しをそのまま写すのは自然だが、写すと `V-1` が正しい記述を「ベクトル残存」として検出する。** #35 が新しく書く文言と検査パターンの衝突であり、既存の残骸の問題ではない。

選択肢は2つ。

- **(a) `V-1` のパターンを精緻化する**（`埋め込み(?!.*SQLite)` 相当、あるいは `埋め込みベクトル|埋め込み生成` へ狭める）
- **(b) 書く側で語を避ける**

### Decision

**(b) を採る。** 新規テキストでは「**DO 内蔵の SQLite**」「**同一 DO 内の SQLite**」と書き、`埋め込み` を使わない。

**(a) を採らない理由**は2つある。1つは、`埋め込み` を `埋め込みベクトル|埋め込み生成` へ狭めると**既存の残骸を取りこぼす**ことである — 実測で `spec/` の `埋め込み` は「埋め込みテーブル」「埋め込み由来」「埋め込み再生成込み」など語形が揺れており、2語に狭めると `V-1` が落とすべき行を見逃す。もう1つは、否定先読みが **BSD grep（`-E`）で使えない**ことである。`grep -P` は macOS の標準 grep には無く、検証バッテリー全体が「手元でそのまま実行できる」という前提（1周目からの方針）を崩す。

**言い換えで情報は失われない。** 設計が「埋め込み SQLite」で言いたいのは「別ストアではないので分散させる理由が無い」ことであり、「DO 内蔵の SQLite」「同一 DO 内の SQLite」はその意味を過不足なく運ぶ。むしろ **DO 単独構成へ改訂したあとの `spec/` では後者のほうが正確**である（何に内蔵されているかが明示される）。

### Consequences

- 良い点: `V-1` を触らずに済むので、既存の残骸検出力が1文字も落ちない。
- 良い点: 検査バッテリーが BSD grep のままで動き続ける。
- トレードオフ: **設計 第7.1節の原文と `spec/` の文言が一語ずれる。** 意味は同じだが、原文と突き合わせる読者が引っかかりうるので、ステップ10 / 5 に「写さない語」として明記した。
- 波及: steps.md ステップ5・10 の注記、plan.md リスク欄。**同種の衝突が他の走査語で起きていないかは3周目に一巡して確認した** — `V-1` の他の語（`ベクトル` / `ハイブリッド` / `RRF` / `Vectorize` / `意味検索`）と `V-3` の語は、いずれも新構成の記述で使う必要が無い。`V-3` の `Outbox` だけは ADR 一覧表のファイル名として避けられないので ADR-014 で別に処理した。

## ADR-017: 検索の出力に不透明カーソルを1フィールド足す

### Status

Proposed

### Context

ADR-012 は不透明カーソル方式に一本化し、波及の項で「出力 DTO も `PaginationResult`（`count` を持つ）のままでよい …… DTO の形は変えない、と決める」と書いている。ところがステップ4 で `spec/pages/index.md` P-11 に「前のページで受け取った不透明カーソルをそのまま次の要求に渡す」を書いた時点で、**カーソルを返す場所が `spec/` のどこにも無い**ことが表面化した。

`PaginationResult<T>` は `{ items, count }` の2フィールドで、カーソルを載せる余地が無い。選択肢は3つある。

- **(a) 何も足さない**（ADR-012 の文言どおり）
- **(b) `PaginationResult` 自体に `nextCursor` を足す**
- **(c) 検索の出力だけ `PaginationResult` に1フィールドを添える**

### Decision

**(c) を採る。** ドメイン側に `SearchPage = PaginationResult<SearchResultItem> & { nextCursor?: SearchCursor }` を置き、ユースケースの `SearchOutput` も同じ形にする。

**(a) は成立しない。** 利用者がカーソルを受け取れないなら、`spec/pages/index.md` P-11 の追加取得も `spec/usecases/search.md` の入力 `cursor` も呼び出し方が定義できない。ADR-012 の「DTO の形は変えない」は**`count` を落とさない**（カーソル方式でも総件数は返せる）という趣旨であり、フィールドを1つも足さないという趣旨ではない、と読む。

**(b) を採らない理由**は、`Pagination` / `PaginationResult` が trash の `listTrashItems` と共有されている共通型だからである。検索だけの都合で共通型を広げると、カーソルを持たない読み取りにも `nextCursor` が生える。

**あわせて2つを新設する。** `SearchCursor`（不透明な文字列。中身の解釈は `SearchIndexPort` の実装に閉じる）と、エラーコード `SearchErrorCode.InvalidCursor`。後者はステップ13 が「不正・期限切れのカーソルはバリデーションエラー」というケースを足すと決めており、**受け皿となるコードがドメインに無いと書けない**。

### Consequences

- 良い点: `spec/pages/index.md` → `spec/usecases/search.md` → `spec/domains/search.md` の3層でカーソルの往復が閉じる。`V-10`（page 番号方式が残っていないこと）と `P-2`（`不透明カーソル`）が両立する。
- トレードオフ: **`SearchOutput` が厳密には `PaginationResult<SearchResultItemDto>` そのものではなくなる。** 共通形は保つが、検索だけ1フィールド多い。
- 波及: `spec/inventory/domain.md` の `DOM-search-*` に `SearchCursor` / `SearchPage` の行を、`spec/testcases/search/search.md` に `InvalidCursor` のケースを要する（ステップ12・13）。

## ADR-018: エンティティの `userId` フィールドは残し、落とすのはポート引数だけにする

### Status

Proposed

### Context

第4.5節は「`userId` は DO 選択で消費され、DO 内のリポジトリは `userId` を取らない」と決めており、ステップ7 の指示も「リポジトリ契約の `userId` 第一引数と `Promise` を落とす」である。一方で第4.4節は**スキーマから `user_id` 列を削る**と決めている。列が無いなら `Memo.userId` / `Topic.userId` / `Document.userId` というエンティティのフィールドはどこから来るのか、という問いが残る。

- **(a) エンティティからも `userId` を落とす**（列の消滅に忠実）
- **(b) フィールドは残し、ポート引数だけ落とす**

### Decision

**(b) を採る。**

理由は2つある。1つは**指示の範囲**で、設計 第11.1節の memo / knowledge の行が挙げているのは「リポジトリ契約の `userId` 第一引数と `Promise`」だけであり、第11.2節（#37 への変更対象一覧）にも memo / knowledge のエンティティは1行も現れない（挙がっているのは `identity/entity.ts` だけである）。もう1つは**波及の大きさ**で、(a) を採ると `Memo.create({ id, userId, ... })` の引数、`spec/inventory/domain.md` の該当行、`spec/testcases/` の多数のケースが同時に動く。それらを直す指示はステップ12〜15 のどこにも無い。

**ただし列との食い違いを黙って残さない。** `spec/domains/memo.md` のフィールド表に「値は所属する Durable Object の同一性そのものであり、**行ごとの絞り込みには用いない**」を1行足した。第4.4節が `_meta` の `userId` について「行データの絞り込みには使わない」と限定しているのと同じ線である。

### Consequences

- 良い点: ステップ7 の射程で閉じ、下流（台帳・テストケース）に予定外の改訂を波及させない。
- トレードオフ: **`spec/database/index.md`（ステップ10）が `memos` から `user_id` 列を落としたとき、ドメイン側にフィールドが残る。** 上記の1行がその橋渡しであり、#37 は「行に持つのではなく DO の同一性から与える」と読む。
- 波及: identity だけは例外で、`User` から `email` / `passwordHash` / `provider` / `providerSubject` が実際に落ちる（第6.6節がエンティティの改修を明示している。ADR-019）。

## ADR-019: `UserRepository` の分割先を `CredentialMappingRepository` / `UserSettingsRepository` と命名し、パスワード変更をエンティティ遷移から外す

### Status

Proposed

### Context

ステップ7 は `spec/domains/identity.md` について「`UserRepository` を『認証情報側（Directory）』と『ユーザー単位設定側（User Data DO）』の2ポートに割る」と指示するが、**名前を与えていない**。台帳（ステップ12）が `ADP-identity-001` 〜 を割り当て直す入力になるので、名前が無いと下流が書けない。

もう1つ、`User = PasswordUser | SsoUser` をクレデンシャル集合へ読み替えると `User.changePassword(user, newPasswordHash, now)` が宙に浮く。`passwordHash` はもうエンティティのフィールドではないので、この遷移は定義できない。

### Decision

**名前は第8.2節の `UnitOfWorkContext` に現れる語に合わせる。** 同節は `userSettingsRepository`（User Data DO）と `credentialMappingRepository`（`UserRepository` を割った認証情報側）を名指ししている。したがって `UserSettingsRepository` / `CredentialMappingRepository` とする。新語を作らない。

**`User.changePassword` はエンティティの振る舞いから外す。** パスワードの変更は認証情報側の検証材料を差し替える手続きであり、ユーザー単位設定側の `User` は変わらない。代わりにクレデンシャル集合を操作する `addCredential` / `removeCredential` を置く（`removeCredential` は `kind: "sso"` のみを受け、最後のログイン手段の解除を拒否する）。

**`UserSettingsRepository` は `findById(id)` を持たない。** その DO の中には1人分の設定しか存在しないので `find()` で足りる。`findById` を残すと「他の `userId` を渡せる」という読み方が残る。

### Consequences

- 良い点: 第8.2節の契約と `spec/domains/identity.md` の語彙が一致する。台帳の分裂（`ADP-identity-001` / `-002` / `-003`）に行き先の名前を書ける。
- トレードオフ: **`spec/usecases/identity.md` の registerWithPassword / registerOrLoginWithSso / executePasswordReset / changePassword の処理フローが、単一の `unitOfWorkProvider.run` に収まらなくなる。** 2つの物理境界をまたぐので、順序と「中間状態・終端で何が観測されるか」を書く形へ変えた。**巻き戻し手順・段構成・再試行上限は書いていない**（ADR-009 の線）。
- 波及: `spec/inventory/{domain,adapter,test}.md` と `spec/testcases/identity/*` の `authMethod` / `SsoUser` / `PasswordUser` 前提（ステップ12・14・15）。

## ADR-020: 保持期限の保存化を `TrashQueryPort` と `softDelete` のシグネチャまで届かせる

### Status

Proposed

### Context

第7.5節は「期限を保存せず毎回算出する」現行設計を「`purge_after` に保存する」へ変えると決めている。ステップ7 の指示は `spec/domains/trash.md` について「`TrashQueryPort.listExpiredItems` を削除」「Alarm による期限処理へ書き換え」「`RetentionPolicy` の算出規則は維持しつつ期限を `purge_after` に保存する」までである。

**ところが保存化の影響は `listExpiredItems` の削除に留まらない。** `TrashQueryPort.listTrashItems` / `findTrashItem` は `retentionDays` を引数に取り、`expiresAt` を照会のたびに算出する契約になっている。保存値になれば渡す必要が無い。同じことがエンティティ側にもあり、`Memo.softDelete(memo, now)` / `Document.softDelete(document, trashedWith, now)` / `TopicTrashService.trashTopicSet(topic, documents, now)` は保存すべき値を受け取る口を持たない。

### Decision

**シグネチャまで届かせる。**

- `TrashQueryPort` から `retentionDays` 引数を落とす（`listTrashItems(pagination)` / `findTrashItem(ref)`）。`expiresAt` には保存済みの `purgeAfter` がそのまま載る
- `softDelete` 系と `trashTopicSet` に `purgeAfter: Date` を1つ足す。**算出は application 層が `RetentionPolicy.expiresAt` で行う**（ドメインは `now` から日数を掛ける計算を持つが、`trashRetentionDays` を読む I/O は持たない）
- `TrashedMemo` / `TrashedTopic` / `TrashedDocument` に `purgeAfter: Date` を足し、**`trashed` であることと `purgeAfter` を持つことを同値**にする（復元で必ず落とす）

**引数を足さずに済ませる形（`softDelete` の中で `retentionDays` を受けて算出する）は採らない。** 保持日数はユーザー設定の読み取りを伴い、その読み取りはトランザクションの中で1回だけ行いたい（トピックのセット削除では配下ドキュメント全件に同じ値を使う）。算出済みの1つの値を配る形のほうが、セット内で期限がずれないことを型に近い形で保証できる。

### Consequences

- 良い点: 「照会時算出」を前提にした記述が `spec/domains/trash.md` から一掃され、`expiresAt` の出どころが1つになる。
- 良い点: **遡及適用（保持日数を短くすると既存項目にも効く）という利用者から見た結果は変わらない。** 変わるのは実現手段（毎回算出 → 変更と同一トランザクションで一括再計算）だけである。
- トレードオフ: **ソフトデリート系のユースケースに「保持日数を読む」手順が1つ増える。** `spec/usecases/{memo,knowledge}.md` の該当箇所に `UserSettingsRepository.find()` を足した。
- 波及: `spec/inventory/{domain,adapter}.md` の `TrashQueryPort` / `softDelete` 系の行（ステップ12）、`spec/testcases/trash/listTrash.md` の `expiresAt` の根拠（ステップ15）。

## ADR-021: `user_id` を先頭から落とした索引は名前からも `user` を外す

### Status

Proposed

### Context

設計 第4.4節は「`memos_timeline_idx` などの複合索引も先頭の `user_id` が落ちて単純になる」と書いているだけで、**索引名をどうするかを決めていない。** 実物には列名を名前に畳んだ索引が4本ある — `acc_user_connected_idx`（`user_id`, `connected_at`）/ `topics_user_live_idx`（`user_id`, `status`, `name`）/ `docs_user_updated_idx`（`user_id`, `updated_at`）/ `prt_user_idx`（`user_id`）。列が消えたあとも名前を残すと、`spec/database/index.md` を単独で読む #37 が「まだ `user_id` 列がある」と読む余地が残る。

一方 `memos_timeline_idx` / `memos_trash_idx` / `docs_topic_active_idx` のように名前に `user` を含まない索引は、列が減っても名前が嘘にならない。

### Decision

**名前に `user` を含む4本だけを改名する。** `acc_user_connected_idx` → `acc_connected_idx` / `topics_user_live_idx` → `topics_live_idx` / `docs_user_updated_idx` → `docs_updated_idx` / `prt_user_idx` → `prt_credential_idx`（こちらは引き方そのものが `user_id` から `credential_id` へ変わるので、名前も引き方に合わせる）。**`user` を含まない索引名は変えない** — 設計 第4.4節が `memos_timeline_idx` を名指しで「そのまま残る索引」として扱っている。

**期限切れ索引3本（`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`）は改名ではなく置き換えである。** 全ユーザー横断の JOIN ごと消え、代わりに自 DO の `purge_after` を引く `memos_purge_idx` / `topics_purge_idx` / `docs_purge_idx` が入る（設計 第7.5節）。

### Consequences

- 良い点: 索引名が引き方と一致し、`spec/database/index.md` だけを読んで実テーブルを組める（ADR-006 の狙い）。
- トレードオフ: **`spec/inventory/adapter.md` の索引名を含む行がステップ12 の更新対象に増える。** 実測で `ADP-ai-client-connections-001` / `ADP-topics-001` / `ADP-documents-001` / `ADP-password-reset-tokens-001` / `ADP-identity-009` / `ADP-knowledge-006` の6行が旧名を持つ。**ただしこれらの行は `user_id` 列の記述も持つのでどのみち改訂対象であり、新規に増える作業ではない。**
- 波及: ステップ12（`spec/inventory/adapter.md` の要点欄）。

## ADR-022: 両クラスに現れる `jobs` / `_meta` は User Data DO 側に一度だけ定義し、Identity Directory 側は差分だけを書く

### Status

Proposed

### Context

設計 第4.1.1節は `jobs` と `_meta` を **User Data DO と Identity Directory DO の両方**に置いている（21セル / 名前の異なり数は 19）。`spec/database/index.md` を DO 2部構成にすると、同じテーブルの節が2つできる。

素朴に両方へ全列を書くと、(i) 12列の表が2つになって片方だけ直される事故が起きる、(ii) 見出しが重複してアンカーが曖昧になり `P-8`（台帳の「定義場所」欄の実在検査）の指し先が決まらない。

### Decision

**列の全数は User Data DO 側の節に一度だけ書き、Identity Directory 側の節は「同じ12列・同じインデックス・同じ規則」と述べたうえで違う点（`kind` の値域・自 locator の形）だけを書く。** 見出しは `### jobs（Identity Directory DO）` / `### _meta（Identity Directory DO）` とし、無印の `### jobs` / `### _meta` と衝突させない。

**`jobs.kind` の全数表は `jobs` の節に置き、所有 DO クラスを列に持たせる**（12種を1つの表で覆う）。設計 第4.1.1節は `kind` を DO クラス別に2箇所へ分けて書いているが、`spec/` 側で分けると `P-9`（12種が `CLAUDE.md` と本ファイルの両方にあること）の突き合わせ先が2つになり、第7.7節 項2 の「4類型が12種を漏れなく1回ずつ覆う」という不変条件も表をまたいで確認する形になる。

### Consequences

- 良い点: 12列の正本が1つに保たれる。`P-10` の `jobs` / `_meta` は名前の異なり数で数えるので、この形でも通る。
- 良い点: `jobs.kind` の全数が1つの表になり、`CLAUDE.md` の4類型表（ステップ17）と1対1で突き合わせられる。
- トレードオフ: **Identity Directory DO の節だけを読むと `jobs` の列が分からない。** 節に「User Data DO 側と同じ12列」と明記して参照先を固定した。

## ADR-023: `search_entries` の列は本ファイルで確定させ、原文とトピック名は持たせない

### Status

Proposed

### Context

設計 第4.1.1節は `search_entries` について「FTS5 projection（external-content）。`search_entries` の PK は `rowid INTEGER PRIMARY KEY`、`id TEXT` は UNIQUE 制約付きの別列」としか書いていない。**列の全数を design 側の正本が持つのは認証・saga・ジョブ系だけ**なので、`search_entries` の列は `spec/database/index.md` が決めることになる。決めるべき点が3つあった。

1. インデックスに入れるテキストは NFKC 正規化後の値だが、**スニペットは正規化前の原文から組み立てる**（設計 第7.2節）。原文をどこから引くか。
2. トピック名を projection に複製するか（第7.2.1節は「正規化した事実の join で結ぶ」と決めている）。
3. `sourceOfDocumentIds` / `sourceMemoIds`（active な相手のみ）の置き場。現行 `spec/database/index.md` は「FTS 側の付随カラムまたは併設テーブル」と両論併記で残していた。

### Decision

- **原文は持たない。** `search_entries.title` / `body` には NFKC 正規化 + `trim()` 済みの値だけを入れ、スニペットの材料になる原文は本体テーブル（`memos.body` / `documents.title` / `documents.body`）から引く。同じ DO の中にあるので追加の往復が発生しない。
- **トピック名は複製しない。** `topic_id` だけを持ち、問い合わせ時に `topics` と join する（第7.2.1節の「事実 join」）。トピックのリネームが検索結果へ即座に反映されるのはこのためである。
- **出典リンクの相手側 ID は `search_entries.source_ids`（JSON 配列）に持つ。** 併設テーブル案は採らない — 第4.1.1節がテーブル全数の正本であり、そこに無いテーブルを17番目として足すと AC-7 と矛盾する（ADR-013 がスナップショットについて採った線と同じ）。索引を張らない付随カラムなので、テーブルを増やす理由が無い。

### Consequences

- 良い点: `search_entries` が「1エントリ1行」に閉じ、テーブル数が第4.1.1節の全数から動かない。
- 良い点: **domains/search.md の `IndexEntry` の各フィールドに対応する列が1対1で決まる**ので、ステップ12 が `ADP-search-entries-001` の要点欄を書ける。
- トレードオフ: **`source_ids` は JSON 文字列なので SQL からは絞り込めない。** 結果 DTO への載せ替え専用の列であり、絞り込みに使う必要が無いことは domains/search.md の検索の規則から確認できる（絞り込みは topic だけである）。
- 波及: ステップ12（`spec/inventory/adapter.md` に `ADP-search-entries-001` を新設し、`ADP-search-fts-001` を external-content 構成へ書き換える）。
