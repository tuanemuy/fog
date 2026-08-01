# ADR — Issue #35: spec と CLAUDE.md を FTS5 全文検索 + Durable Objects 単独構成へ改訂する

## ADR-001: `SearchIndexPort` を `query` 1本へ縮小し、書き込み側をポートにしない

→ `.adr/005-search-projection-inside-write-transaction.md` に昇格

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

→ `.adr/005-search-projection-inside-write-transaction.md` に昇格

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

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格（実測に依存する値を spec に固定しない規則として）

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

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

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

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

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

→ `.adr/006-opaque-cursor-search-pagination.md` に昇格

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

→ `.adr/006-opaque-cursor-search-pagination.md` に昇格

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

→ `.adr/006-opaque-cursor-search-pagination.md` に昇格

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

→ `.adr/007-tenant-isolation-inside-durable-object.md` に昇格

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

→ `.adr/008-identity-split-and-non-aggregate-stores.md` に昇格

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

→ `.adr/009-stored-purge-after-and-bulk-recalculation.md` に昇格

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

→ `.adr/005-search-projection-inside-write-transaction.md` に昇格

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

## ADR-024: `ADP-users-001` は行ごと削除せず、分裂の行き先を記録する行として残す

### Status

Proposed

### Context

steps.md ステップ12 は `spec/inventory/adapter.md` について「**`ADP-users-001` は第4.1.1節に対応テーブルが無く、`account` / `user_settings` / `credential_mappings` / `credential_locators` へ割れる**（行1 / 行2）— 行き先を台帳に明記する」と指示している。ところが**どこに明記するかを決めていない。**

- **(a) 行ごと削除し、行き先は4つの新設行（`ADP-account-001` ほか）が暗黙に示す**
- **(b) 行を残し、要点欄に「廃止。行き先は次の4つ」と書く**

(a) を採ると「行き先を台帳に明記する」という指示が満たされない。`users` テーブルが消えたことも、それが4つに割れたことも、台帳のどこにも書かれない状態になる。ADR-011 の欠番規約は「削除した ID を繰り上げない」ことを求めているだけで、「消えた要素を必ず行ごと削除する」とは言っていない。

### Decision

**(b) を採る。** `ADP-users-001` の要素欄を `schema: users（廃止・分裂）` にし、要点欄に4つの行き先とそれぞれの新 ID（`ADP-account-001` / `ADP-user-settings-001` / `ADP-credential-mappings-001` / `ADP-credential-locators-001`）を書く。「定義場所」欄は消えた `#users` から `spec/database/index.md#テーブル一覧` へ差し替える（`P-8` の DANGLING を避けるため）。

**同じ形を `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-occ-guard-001` / `ADP-search-embeddings-001` / `ADP-trash-004` / `ADP-search-002`〜`009` には適用しない。** あちらは**機構ごと消える**（行き先が無い）のに対し、`users` は**同じ責務が4つのテーブルへ分かれた**だけである。行き先のあるものだけ、行を残して行き先を書く。

### Consequences

- 良い点: 改訂後の台帳だけを読んで「旧 `users` の各責務が今どこにあるか」を辿れる。#37 が実テーブルを組むときの探索が1ホップで済む。
- トレードオフ: **台帳に「実在しないテーブルの行」が1行残る。** 要素欄の `（廃止・分裂）` がその印であり、`P-8` は「定義場所のアンカーが実在する」ことだけを見るので通る。
- 波及: 同じ判断が `ADP-identity-001`〜`005` にも効く（ADR-025）。

## ADR-025: `UserRepository` の分裂は既存 `ADP-identity-001`〜`005` の in-place 読み替えで表し、新設は末尾 append にとどめる

### Status

Proposed

### Context

steps.md ステップ12 は「`ADP-identity-001` / `-002`（`insert` / `save`）を Directory 側と User Data 側に割る（行11）。`ADP-identity-003`（`findById`）も同じ2つに割る（行7c）」「**`ADP-identity-004`（`findByEmail`）/ `-005`（`findBySsoIdentity`）は Directory へ移る**」と指示している。

「割る」を文字どおり読むと、1行が2行になる（= 5行が10行になる）。ところが ADR-019 が確定させた分裂先を実物と突き合わせると、**両側に対称なメソッドは存在しない。**

- ユーザー単位設定側（`UserSettingsRepository`）は `insert` / `save` / `find()` の3本。
- 認証情報側（`CredentialMappingRepository`）は `findByEmail` / `findBySsoIdentity` / `findByCredentialId` の3本で、**書き込みメソッドを持たない** — 予約の獲得と確定は単一メソッドに畳めない手続きとして usecases/identity.md に書かれている（domains/identity.md が明記）。

つまり `insert` / `save` の「Directory 側」に対応するポートメソッドが無い。10行に割ると、実体の無い行が2行生まれる。

### Decision

**既存5行を 1:1 で読み替え、増える分（`findByCredentialId`）だけを末尾へ append する。**

| 旧 | 新 | 置き場 |
|---|---|---|
| `ADP-identity-001` `UserRepository.insert` | `UserSettingsRepository.insert` | User Data DO |
| `ADP-identity-002` `UserRepository.save` | `UserSettingsRepository.save` | User Data DO |
| `ADP-identity-003` `UserRepository.findById` | `UserSettingsRepository.find` | User Data DO |
| `ADP-identity-004` `UserRepository.findByEmail` | `CredentialMappingRepository.findByEmail` | Identity Directory |
| `ADP-identity-005` `UserRepository.findBySsoIdentity` | `CredentialMappingRepository.findBySsoIdentity` | Identity Directory |
| （新設） | `ADP-identity-017` `CredentialMappingRepository.findByCredentialId` | Identity Directory |

**「割れた」という事実は要点欄に書く** — 各行の冒頭に「旧 `UserRepository.*` の◯◯側」と明示し、`ADP-identity-001` には「メール / SSO 主体の一意性はここでは判定しない。権威は Directory 側の予約獲得（`ADP-credential-mappings-001`）である」を添える。これで**割れた両側が台帳から辿れる**（ADR-024 と同じ形）。

**ID を繰り上げない・新設は末尾**という ADR-011 の規約は破っていない。既存 ID はどれも同じ責務の同じメソッドを指し続け、新規は `-017` として末尾に付く。

### Consequences

- 良い点: **#13 が参照する `ADP-identity-006`〜`011`（AiClientConnection 側の6本）が影響を受けない。** 途中に行を挿さないので採番がずれない。
- 良い点: 実体の無いポートメソッドの行を作らずに済む。
- トレードオフ: **「1行が2行に割れる」という steps.md の字面とは一致しない。** 一致させると実装の無い行が生まれるので、実物（ADR-019 が決めたポート構成）を正とした。
- 波及: 同じ理由で `spec/inventory/domain.md` の `DOM-identity-018`〜`022` も 1:1 の読み替えにした（`018`〜`020` が `UserSettingsRepository`、`021` / `022` が `CredentialMappingRepository`。新設の `findByCredentialId` は `DOM-identity-035`、`CredentialId` VO は `DOM-identity-034` として末尾に append）。**`DOM-identity-018`〜`022` は #10 / #13 のどちらからも参照されていない**ことを `gh issue view` で確認済みである。

## ADR-026: 両クラスに現れる `jobs` / `_meta` には DO クラスごとに別の `ADP-*` を採番する

### Status

Proposed

### Context

ADR-022 は `spec/database/index.md` について「列の全数は User Data DO 側に一度だけ書き、Identity Directory 側は差分だけを書く」と決め、見出しを `### jobs（Identity Directory DO）` / `### _meta（Identity Directory DO）` に分けた。**台帳側で何行にするかは決めていない。**

- **(a) テーブル名ごとに1行**（`ADP-jobs-001` / `ADP-meta-001` だけを置き、両クラスを1行で説明する）
- **(b) DO クラスごとに1行**（`ADP-jobs-001` / `ADP-jobs-002` / `ADP-meta-001` / `ADP-meta-002`）

### Decision

**(b) を採る。**

**(a) を採らない理由**は、台帳の「定義場所」欄が**1つのアンカーしか持てない**からである。1行にすると `#jobs` か `#jobsidentity-directory-do` のどちらかしか指せず、指さなかった側の節が台帳から到達不能になる。`P-8`（アンカー実在検査）は「指した先が実在する」ことしか見ないので、この取りこぼしは機械では検出できない。

**列の重複は起きない。** `ADP-jobs-002` / `ADP-meta-002` の要点欄は ADR-022 と同じ形で「User Data DO 側と同じ12列・同じインデックス・同じ規則。違うのは `kind` の値域だけ」と書き、列の全数は `ADP-jobs-001` / `ADP-meta-001` にだけ置く。正本は1つのままである。

### Consequences

- 良い点: `spec/database/index.md` の 21 セルすべてに台帳の行が1対1で対応する。#37 がどちらの節を読むべきかを台帳から決められる。
- 良い点: `P-10`（テーブル名の異なり数 19 で数える検査）とも矛盾しない — あちらは名前を数え、台帳はセルを数えるという役割の違いがそのまま残る。
- トレードオフ: **台帳の行数（86行）が第4.1.1節のテーブル数と一致しない。** スキーマ行は 21 セル + 廃止行1（`ADP-users-001`。ADR-024）で 22 行になる。

## ADR-027: `executePasswordReset.md` に濫用抑止3ケースを足さない

### Status

Proposed

### Context

設計 第11.1節のテストケース表は `spec/testcases/identity/executePasswordReset.md` の指示欄を「**同上**」とだけ書いている（`design.md:2423`）。直前の行は `changePassword.md` で、そこには (B) に加えて「credential 変更 saga の中間状態3値」「`sessionEpoch` の前進」「**濫用抑止のケースを3つ**（旧パスワードの照合失敗が `failedAttempts` を進める / `nextAttemptAllowedAt` 未到達の変更試行が明示的に拒否される / 照合成功で `failedAttempts` が0に戻る）」「前進不能時の終端」が並んでいる。

「同上」を字義どおり写すと、リセット経路にも濫用抑止3ケースを足すことになる。**ところがリセットには旧パスワードの照合が存在しない。** 本人確認を担うのはトークンであり（`spec/usecases/identity.md` の executePasswordReset 手順2）、`PasswordHasher.verify` を呼ぶ手順が1つも無い。設計 第6.2.2節 (a) も「`failedAttempts` を**進める**側の全数は2本」と断定し、その2本を **login step 7 の `report-login-result`** と**パスワード変更 phase 0 の `report-verify-result`** に限定している。リセットはそのどちらでもない。

### Decision

**「同上」を「(B) + 中間状態 + `sessionEpoch` の前進 + 終端」までと読み、濫用抑止3ケースは足さない。** 代わりに、リセット固有の観測結果である「`resetVersion` の前進による直近世代の AI クライアント接続の失効」を1ケース足す（第5.4節 (i)）。

**リセットは濫用抑止と無関係ではない** — 第6.2.2節 (a) は「リセットの完走が `failedAttempts` を0に戻す」を**脱出経路 (i)** として定義している。ただしこれは「進める側」ではなく「0へ戻す側」であり、しかも観測できるのは**ログイン側**である。したがって落とし先は `spec/manual-tests/account.md` の TC-40（ロックアウトと2本の脱出経路）であって、`executePasswordReset.md` ではない。

### Consequences

- 良い点: 存在しない手順（旧パスワード照合）に対する期待値をテストケースに書かずに済む。#37 が「リセットでも `verify` を呼ぶのか」と読む余地が消える。
- トレードオフ: **設計の「同上」と `spec/` の記述が1箇所ずれる。** ずれの根拠は本 ADR であり、PR 本文にも明記する（ADR-009 / ADR-010 / ADR-011 と同じ扱い）。
- 波及: 脱出経路 (i) の検証は `spec/manual-tests/account.md` TC-40 が負う（ステップ15c）。`spec/inventory/test.md` の `TC-executePasswordReset-017`〜`-020` は4件であって7件ではない。

## ADR-028: 設計の表が挙げていないイベント期待行にも (A) / (B) を適用する

### Status

Proposed

### Context

設計 第11.1節「改訂する — テストケース」の表は、ファイルごとに「ヒット行と内容」を挙げたうえで (A) / (B) / (C) を指定している。**この「ヒット行」は語彙走査（`V-3`）と `イベント` という語の目視で拾った行である。**

ところが実測すると、**イベント名を直接書いていて `イベント` という語も走査語も含まない行**が実在する。全数は次の11行である。

- `trash/emptyTrash.md:10`（`document.sourceLinksChanged` が発行される）
- `trash/hardDeleteTrashItem.md` の `:7` / `:8` / `:9` / `:11` / `:12`（`memo.hardDeleted` / `document.hardDeleted` / `topic.hardDeleted` / `memo.sourceLinksChanged` が収集される）
- `trash/restoreDocument.md` の `:22` / `:24` / `:37`（`topic.restored` / `document.restored` / `topic.created` が収集される）
- `trash/restoreTopic.md` の `:7` / `:10`（`topic.restored` / `document.restored` が収集される）

第7.3節は「イベントは transport としても業務表現としても残らない」と断定しているので、これらを残すと**改訂後の `spec/` にイベント期待が11行生き残る**。しかも `V-3` にも `イベント` の grep にも掛からないので、完了ゲートで検出できない。

### Decision

**設計の表の「ヒット行」を網羅と読まず、対象ファイルの全行をイベント期待の観点で読み直す。** 上の11行には、表と同じ基準で (A)（projection の期待へ読み替え）を適用した。**(C) は使わない** — いずれも業務上意味のある正常系であり、機構が消えるだけで振る舞いは残るからである。

判定に迷う余地はほぼ無い。**イベント名が指しているのは「そのトランザクションで何が起きたか」であり、DO 構成ではそれが projection の更新に1対1で対応する**（`spec/domains/search.md`「インデックスの維持」の契機表がその対応の正本である）。トピックだけは例外で、エントリを持たないので「projection の更新は発生しない」と書く。

### Consequences

- 良い点: 改訂後の `spec/testcases/**` にイベント期待が1行も残らない（`grep -rn 'イベント' spec/testcases` が 0 行）。
- 良い点: `.thread/35/step14-checklist.md` の該当行に「設計の表が挙げていない」と明記したので、レビューが設計と突き合わせたときに差分の理由が辿れる。
- トレードオフ: **ステップ14 の作業量が設計の表より増える。** 増えたのは**7ファイル15行**である（本 ADR が初版で挙げた上の4ファイル11行に、レビュー 001 B-001 が拾った knowledge 系3ファイル4行が加わる。ADR-035）。いずれも同じ表（インデックスの維持の契機表）から機械的に導ける。

## ADR-029: FTS5 新設ケースのうち「ゴミ箱除外」は既存ケースの書き換えで満たし、二重に作らない

### Status

Proposed

### Context

steps.md ステップ13 は `spec/testcases/search/search.md` に FTS5 の新しいケースを9系統足せと指示している。そのうち **(viii) ゴミ箱除外**は、実測で既存の `:17`（「キーワードに一致するメモ・ドキュメントがゴミ箱内にある → ヒットしない」。`TC-search-011`）と完全に同じ検証点である。違うのは根拠の書き方だけで、旧記述は「インデックスから remove 済み」、新設計では「ソフトデリートと同一トランザクションで projection から除去済み」になる。

同じ問題を ADR-012 が (vi)（ページ間の重複・欠落）について既に処理しており、steps.md も「(vi) は `:24` の読み替えの拡張として書き、二重に作らない」と明記している。

### Decision

**(viii) は既存 `TC-search-011` の根拠の書き換えで満たし、新設ケースを作らない。** 新設するのは (i)〜(vii) と (ix) に対応する **11ケース**（`TC-search-033`〜`-043`）で、内訳は「投稿直後のヒット」+ trigram / 短語フォールバック / NFKC 2件（全角半角・合成済み結合文字列）/ `bm25` / 安定順位 / 原文スニペット / `TOPIC_NOT_FOUND` 2件（未知・ゴミ箱内）/ 不正カーソルである。

**(vii) を2ケースに割った**のは、未知のトピックとゴミ箱内のトピックが別の状態（行が無い / 行はあるが `trashed`）から同じエラーへ落ちることを、片方だけの実装で通させないためである。

### Consequences

- 良い点: 同じ検証点の重複行が台帳に生まれない。`TC-search-011` の連番が動かないので、この行を参照する側（#10 の検索チェックリスト）が影響を受けない。
- トレードオフ: **steps.md の「9系統」と実際の新設数（11ケース）が一致しない。** 内訳の対応は本 ADR が正本である。

## ADR-030: `spec/manual-tests/account.md` の新規 TC は種別セクションの末尾へ置き、番号の単調性を犠牲にする

### Status

Proposed

### Context

ステップ15c は `spec/manual-tests/account.md` に3系統（ロックアウトの再現と2本の脱出経路 / リセット完了後の直近世代の接続の失効 / リセット完了画面の必須導線）を足す。**このファイルは `## 正常系` / `## 異常系` / `## 境界値` の3セクションに分かれており、`spec/manual-tests/index.md` の件数表がその3区分の内訳を持つ**（account は 11 / 22 / 4 = 37）。区分の集計元は各 TC の `**種別**:` 行である。

新設の3件は種別が割れる — 必須導線と自動失効は正常系、ロックアウトは異常系である。既存は TC-01〜TC-37 が文書順に単調増加しているので、次の2つを同時には満たせない。

- **(a) 番号を単調に保つ** — 新規3件を文書末尾（境界値セクションの後）へまとめて置く。種別セクションと種別ラベルが食い違う
- **(b) 種別セクションの整合を保つ** — 正常系2件を `## 正常系` の末尾（TC-11 の直後）に、異常系1件を `## 異常系` の末尾（TC-33 の直後）に置く。文書順は 01〜11, 38, 39, 12〜33, 40, 34〜37 になる

### Decision

**(b) を採る。** 理由は2つある。

1. **既存 TC の番号を1つも動かさない**（`ai.md` が `account.md` を手順の前提として参照しており、`index.md` の推奨実行順序もこのファイルを起点にしている）。番号を詰め直す案は採らない。
2. **セクションは実行順序の単位である。** マニュアルテストは上から順に実行する運用で、正常系を通してから異常系へ進む。正常系の TC を境界値セクションの後ろに置くと、実行順序そのものが崩れる。**番号は識別子であって順序ではない**（台帳 ID の欠番規約と同じ理屈。ADR-011）。

### Consequences

- 良い点: 件数表の3区分（ステップ16.5 が数え直す）が `**種別**:` の集計とそのまま一致する。**改訂後の実測は 40 件 = 正常系 13 / 異常系 23 / 境界値 4** である。
- トレードオフ: **文書内の TC 番号が単調でなくなる。** 目次を持たないファイルなので実害は小さいが、番号順に読もうとすると引っかかる。
- 波及: ステップ16.5 への申し送りは「account.md が 37 → 40（正常系 +2 / 異常系 +1）」である。合計は 192 → 195 に、実行記録欄の分母も同じ値になる（ステップ16 が `search.md` に足す分は別途加算する）。

## ADR-031: テストケースでは saga / 濫用抑止の列を camelCase で書き、`spec/database/index.md` の snake_case と対にする

### Status

Proposed

### Context

`P-7` は `spec/testcases/identity/loginWithPassword.md` に `credentialVersion|nextAttemptAllowedAt|changeState`、`listAiClientConnections.md` に `createdAtResetVersion`、`requestPasswordReset.md` に `operationKey` を要求する（すべて camelCase）。一方 `spec/database/index.md` は同じものを `credential_version` / `next_attempt_allowed_at` / `change_state` / `created_at_reset_version` / `operation_key` と snake_case の列名で定義している。**`spec/domains/identity.md` と `spec/usecases/identity.md` はどちらの綴りも持たず、「セッションの世代を進める」「ログイン失敗と同じ回数カウンタ」のように散文で書いている**（ステップ7・9 の担当者の判断）。

つまりテストケースが camelCase を導入すると、その語は `spec/` の中で `spec/database/index.md` の snake_case 列とだけ対応する。逆に snake_case で書くと `P-7` は通るが（`purge_after` の行は実際にそう書かれている）、テストケースの既存の書き方（`trashedWith` / `latestRevision` / `revokedAt` など、DTO・エンティティのフィールドはすべて camelCase）と揃わない。

### Decision

**保持期限だけ snake_case、それ以外は camelCase で書く。**

- **`purge_after`** は `spec/testcases/trash/listTrash.md` で snake_case のまま使う。`P-7` の第6行がその綴りで測っており、かつ **`purgeAfter`（保存された値そのもの。`expiresAt` に載る）と `purge_after`（再計算とインデックスの対象になる列）を書き分けられる**という利点がある。ADR-020 が `TrashedMemo` 等に `purgeAfter: Date` を足しているので、両方が同じ文脈に現れる。
- **`changeState` / `credentialVersion` / `nextAttemptAllowedAt` / `failedAttempts` / `sessionEpoch` / `resetVersion` / `createdAtResetVersion` / `operationKey`** は camelCase で書く。これらはテストケースの中では「利用者・実装者から見た状態の名前」として現れており、`trashedWith` 等と同じ扱いが自然である。

**綴りの対応表は作らない。** 対応は1対1で機械的（camelCase ↔ snake_case）であり、表を作るとその表自体が同期対象になる。

### Consequences

- 良い点: `P-7` の10本がステップの指示語のまま通る（ADR-015 の原則を崩さない）。
- トレードオフ: **`spec/` の中で同じものが2通りの綴りで現れる。** `spec/database/index.md` を単独で読む #37 が `changeState` を grep しても列定義に当たらない（当たるのは `change_state`）。両方を引くのは実装者にとって自然な操作なので受容する。
- 波及: `spec/inventory/test.md` の要点欄も同じ規則で書く（`purge_after` の再計算だけ snake_case、他は camelCase）。

## ADR-032: 手順書の新規文言で `少し待って` を使わず「時間をおいて」と書く

### Status

Proposed

### Context

ADR-016 は `V-1` の走査語 `埋め込み` について「新規に書く文言のほうを言い換える」と決めた。**同じ衝突が `V-7` でも起きる。**

`V-7`（非同期反映を利用者へ約束する記述）の走査語は `ヒットしない場合がある|反映は非同期|1〜2分待つ|少し待って` である。ステップ16 は `spec/manual-tests/search.md` の TC-07 を「投稿直後に必ずヒットする」へ反転させるが、**反転を確かめる確認ポイントとして最も自然な書き方が「『少し待ってから再検索』という案内が UI に出ないこと」**であり、これは走査語 `少し待って` に当たる。実際に一度そう書いて `V-7` が 1 行になった。

意味は正反対（旧: 待てとの案内をする / 新: 待てとの案内が出ないことを確かめる）だが、`V-7` は否定文脈を区別できない。

### Decision

**ADR-016 と同じく (b) 書く側で語を避ける。** 「時間をおいて再検索してください」と書き、`少し待って` を使わない。

`V-7` のパターンは触らない。ADR-016 が挙げた2つの理由がそのまま効く — 語を狭めると既存の残骸を取りこぼすおそれがあり、否定先読みは BSD grep（`-E`）で使えない。

**言い換えで情報は失われない。** 「時間をおいて再検索」は「少し待って再検索」と同じ UI 文言を指しており、確認ポイントとしての強さは変わらない。

### Consequences

- 良い点: `V-7` を触らずに済み、既存の残骸検出力が落ちない。
- トレードオフ: **「反転を書くと負の検証に当たる」という形は `V-7` に限らない。** 走査語が「利用者への約束の文言」そのものである検査は、その約束を否定する記述も同じ語で書けてしまう。**新規テキストを書いたら、そのファイルに対して負の検証を掛け直す**という運用でしか防げない（ステップ16 の「着手前に V-1〜V-3 を掛ける」を、着手後にも掛ける形へ広げた）。
- 波及: steps.md ステップ16 の注記、plan.md リスク欄（ADR-016 と同じ扱い）。

## ADR-033: `spec/manual-tests/search.md` の FTS5 新設 TC は4件とし、種別セクションの末尾へ置く

### Status

Proposed

### Context

steps.md ステップ16 は `spec/manual-tests/search.md` に「**FTS5 の新しい確認項目**（日本語 trigram / 短語 / 順位 / スニペットが原文であること）」を足せと指示し、ADR-010 は「独立した新規 `TC-NN` として足し、足した数をステップ16.5 へ申し送る」と決めている。決めるべき点が3つ残っていた。

1. **件数。** 指示の括弧内は4項目だが、`spec/testcases/search/search.md` 側（ステップ13）は ADR-029 により **11ケース**（NFKC 2件・`TOPIC_NOT_FOUND` 2件・不正カーソルなどを含む）を新設している。手順書側もその粒度に揃えるべきか。
2. **NFKC（全角・半角、合成済みと結合文字列）の扱い。** ステップ16 の括弧内には無いが、利用者から観測できる振る舞いであり、テストケース側には2件ある。
3. **番号の置き場。** このファイルも `## 正常系` / `## 異常系` / `## 境界値` の3セクションに分かれ、`spec/manual-tests/index.md` の件数表がその内訳を持つ（ADR-030 が `account.md` について扱ったのと同じ構造）。

### Decision

1. **新設は4件にとどめる。** `TC-18`（日本語 trigram）/ `TC-19`（順位付けとタイトル重み・安定順序）/ `TC-20`（原文スニペット）/ `TC-21`（1〜2文字の短語）である。**手順書はブラウザ UI から人が確認できるものだけを持つ**という本ファイルの性格を保つ — `TOPIC_NOT_FOUND` はトピック絞り込みが選択式である以上 UI から発生させられず（カバレッジ表で「対象外」とし、ゴミ箱内トピックが選択肢に出ないことを TC-12 手順3 に紐づけた）、不正カーソルも UI が前ページの応答をそのまま渡すため注入できない。**テストケース側の11件と1対1にしない**のは、両者の対象（API 契約 / UI 操作）が違うからである。
2. **NFKC は独立 TC にせず、`TC-18` の確認ポイントと `TC-20` の主線に畳む。** ADR-010 が却下した「件数を固定するために表現を歪める」形とは別である — 却下されたのは**指示にある4項目を既存 TC の確認ポイントへ逃がす**ことで、NFKC はそもそも指示の4項目に無い。加えて `TC-20`（原文スニペット）は全角で投稿したメモを半角で検索してヒットさせ、スニペットが全角のまま返ることを見る形になっており、**NFKC を独立させると同じ手順を2回書くことになる。**
3. **ADR-030 と同じく種別セクションの末尾へ置く。** `TC-18`〜`TC-20`（正常系）は `TC-07` の直後、`TC-21`（境界値）は `TC-17` の直後である。既存 TC の番号を1つも動かさず、件数表の3区分と `**種別**:` の集計が一致する。文書内の TC 番号は単調でなくなる。

### Consequences

- 良い点: **ステップ16.5 への申し送りが確定する** — `search.md` は 17 → **21**（正常系 7→10 / 異常系 7 / 境界値 3→4）。`account.md` の 37 → 40（ADR-030）と合わせて合計は 192 → **199** になる。
- 良い点: 手順書とテストケースの粒度差が「UI から起こせるか」という1つの基準で説明できる。カバレッジ表の「対象外」欄にその理由が残る。
- トレードオフ: **`TOPIC_NOT_FOUND` と不正カーソルはマニュアルテストで一度も踏まれない。** どちらも `spec/testcases/search/search.md` の自動テスト側（`TC-search-041`〜`-043` 相当）が受け持つ。
- 波及: テストデータに5件（M4 / M5 / M6 / D-A2 / D-A3）を足した。**いずれも `fogsearch` を含めない** — 含めると `TC-01` / `TC-04` / `TC-11` / `TC-17` が本文に列挙している期待結果の一覧が古くなるためである。

## ADR-034: `spec/index.md` の件数は台帳の実測行数を正本とし、概数表記をやめる

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

### Status

Proposed

### Context

ステップ16.5 は `spec/index.md` の転記数値を数え直せと指示するが、**数え方を決めていない。** 現行は「52ユースケース・**約**750ケース」「192ケース」で、ユースケース数とマニュアルテスト数は実数、テストケース数だけが概数である。

実測すると出どころが3つある。

- **ユースケース数** — `spec/inventory/usecase.md` の `UC-*` 行が **51**（`maintainSearchIndex` の削除で 52 → 51）。`spec/testcases/` のファイル数も 51 で一致する。
- **テストケース数** — `spec/inventory/test.md` の `TC-*` 行が **782**。`spec/testcases/**` のテーブル行を直接数えると 785 になるが、差の3行は `spec/testcases/trash/restoreDocument.md` が4つのテーブル（`restoreAlone` / `restoreWithTopic` / `selectDestination` / 共通・異常系）に分かれていることによる**ヘッダ行の重複計上**であり、実体は 782 で一致する。
- **マニュアルテスト数** — `grep -cE '^#+ TC-[0-9]+' spec/manual-tests/*.md` の合計が **199**。

### Decision

**`spec/inventory/` の台帳行数を正本とし、`spec/index.md` には実数を書く。** 「約750ケース」という概数表記はやめて **782ケース** と書く。

理由は2つ。

1. **台帳は既に「`spec/testcases/{path}#L{n}` が実在する ⇔ 台帳に行がある」の双方向を不変条件にしている**（`spec/inventory/test.md` のヘッダ・plan.md の `P-8`）。索引の数値をそこから引けば、以後の増減が台帳の更新に自動的に追随する。
2. **概数は嘘になったことを検出できない。** 「約750」は 782 でも 700 でも成立してしまうので、AC-18 のような機械検査の対象にならない。実数なら `grep -c` で突き合わせられる。

**`spec/database/index.md` の行は「DB設計（ユーザー単位 SQLite-backed Durable Objects。User Data DO 16 テーブル / Identity Directory DO 5 テーブル）」とする。** 設計 第4.1.1節の DO クラス別セル数（16 + 5 = 21）をそのまま書き、`P-10` が数える「名前の異なり数 19」は書かない — 索引が示すべきは構成であって検査の内部単位ではない（ADR-006 / ADR-022 の整理と同じ）。

### Consequences

- 良い点: AC-18 の `grep -n '9テーブル\|SQLite系\|52ユースケース\|192ケース\|約750ケース' spec/index.md` が 0 行になり、置き換え後の数値もすべて `grep -c` で再現できる。
- トレードオフ: **`spec/index.md` がテストケースを1件足すたびに古くなる。** 概数のほうが寿命は長かった。ただし台帳（`spec/inventory/test.md`）を直さずにテストケースだけ足す運用は既に禁じられているので、索引の更新はその作業に1行足すだけである。
- 波及: ステップ16.5 の実行結果（51 / 782 / 199）。**`spec/index.md` の Phase 3 行と成果物節の両方**を同じ数値で直す（片方だけ直すと同じファイルの中で食い違う）。
- 続報（1ラウンド目）: **ユースケースが2つ増えた**（ADR-051）ため、上の 51 / 782 は古くなった。あわせて成果物節の `43シナリオ` も実測（`grep -rhoE 'S-[A-Z]{2}-[0-9]{2}' spec/scenario/*.md | sort -u | wc -l` = **39**）と合っていない — こちらは本 Issue 以前からの旧値だが、本 ADR が定めた「台帳の実測を正本とする」規約の射程にある。
- 続報（2ラウンド目）: `linkSsoCredential` の新設（ADR-062）でさらに動いた。**確定値は 54ユースケース / 838ケース / 39シナリオ / 204マニュアルケース**で、`spec/index.md` はこの値に同期済みである。**この行が示すとおり、数値の続報は実測が動くたびに古くなる** — 参照するときは `spec/index.md` と `.thread/35/plan.md` の AC-18 を正本とし、本 ADR の履歴は判断の経緯としてのみ読むこと。

## ADR-035: イベント名だけを書いた期待値4行にも (A) / (B) を適用し、ADR-028 の全数を訂正する

### Status

Proposed

### Context

レビュー 001（`review-001-testcases.md` B-001 / `review-001-domain-usecase.md` B-001）が、ステップ14 の取り残しを4行検出した。

- `spec/testcases/knowledge/updateTopic.md:8` — 「`topic.updated` が記録される」
- `spec/testcases/knowledge/updateTopic.md:12` — 「`topic.archived` / `topic.unarchived` が各 1 件記録される」
- `spec/testcases/knowledge/trashTopic.md:9` — 「`document.trashed` は発行されない」
- `spec/testcases/knowledge/editDocumentByAi.md:7` — 「`document.edited` が記録される」

4行とも `V-3` の走査語（`Outbox` / `collectEvents` / … / `ドメインイベント`）を1つも含まないので、AC-3 の負の検証は 0 行のまま通っていた。**しかも `spec/inventory/test.md` の対応4行（`:276` / `:395` / `:407` / `:411`）は既に projection の表現へ同期済みで、台帳とテストケース本体が正面から食い違っていた。** #10 / #13 の実装チェックリストは台帳 ID 由来なので、実装者は台帳を見て通したつもりで本文を読むと別のことが書いてある — ADR-011 が防ごうとした静かな取り違えと同じ事故形である。

ADR-028 は同じ形（イベント名だけで走査語に掛からない行）を trash 系 11 行についてだけ洗い出しており、knowledge 系を射程に入れていなかった。

### Decision

**ADR-028 の基準をそのまま適用する。** 台帳側の表現に本文を合わせる形で、`editDocumentByAi.md:7` は (A)（同じ `transactionSync` の中でエントリが作り直される）、残り3行は (B)（イベント期待を落とす。`updateTopic.md:8` と `trashTopic.md:9` には「エントリを持たない / 配下が 0 件なので projection の更新は発生しない」を添える）とした。

**あわせて ADR-028 の「増えたのは4ファイル11行」を「7ファイル15行」へ訂正する。** 実数は emptyTrash 1 + hardDeleteTrashItem 5 + restoreDocument 3 + restoreTopic 2 + editDocumentByAi 1 + trashTopic 1 + updateTopic 2 = 15 行 / 7 ファイルである。`.thread/35/step14-checklist.md:49` の「3ファイル」も同じ数え違いだったので同時に直した（列挙は初版から4ファイルあった）。

### Consequences

- 良い点: 台帳とテストケース本体の食い違いが消え、`spec/domains/knowledge.md` に定義の無い識別子を期待値に持つ行が 0 になる。
- トレードオフ: `V-3` はこの再発を検出できない。**イベント名を直接走査する検査（`V-3b`）を完了ゲートに足す必要がある**が、`.thread/35/testing.md` は本作業の担当範囲外なので追加は別担当へ送る。
- 波及: `.thread/35/step14-checklist.md` の #19 / #22 / #23 の「実際に適用したもの」欄と「台帳」欄。台帳（`spec/inventory/test.md`）は既に正しいので変更しない。

## ADR-036: `userId スコープ` の書き換えを読み取り専用ユースケースのテストケースにも及ぼす

→ `.adr/007-tenant-isolation-inside-durable-object.md` に昇格

### Status

Proposed

### Context

設計 第11.1節は読み取り系14件を「影響なし」と判定し、「`userId` スコープの読み替えは `spec/domains/index.md` の改訂で一括して効くので個々のテストケースは触らない」としていた。ところが改訂後の `spec/domains/index.md` は「DO 内のリポジトリ・ポートは `userId` を引数に取らない」「構造的保証の在り処は**到達可能性**である」「**例外は無い**」と書き切っている。

一方で本 PR は `spec/testcases/trash/listTrash.md:19` / `search/search.md:19` / `identity/revokeAiClientConnection.md:8` を到達可能性の表現へ**書き換えている**。結果として同じ保証の説明が corpus 内で2通りになり、境界は「設計の表に載っていたか」でしかなかった。しかも残っていた 18 行のうち 10 行は**書き込み系**で、設計の免除理由（「読み取り専用でイベント・インデックス・非同期反映のいずれにも触れない」）がそもそも当たらない。

### Decision

**`spec/testcases/**` の 18 行と `spec/inventory/test.md` の 15 行を、すべて到達可能性の表現へ書き換える。** 手本は `listTrash.md:19` の「保証は列条件ではなく到達可能性による — 自分の Durable Object の中に他ユーザーの行が原理的に存在しない」である。読み取り専用ユースケースの8ファイル（`knowledge/{getDocument,getTopic,listDocumentRevisions,listDocumentSourceMemos,listDocumentsReferencingMemo,diffDocumentRevisions}.md` / `memo/{getTimeline,diffMemoRevisions}.md`）も対象に含める — **これらは旧テナント分離機構を本文に持つので「影響なし」は誤判定である。**

`spec/usecases/memo.md:369` の同種の1行は上流であり本作業の担当範囲外なので、報告に回す。

### Consequences

- 良い点: 「消えた機構（第一引数の `userId`）」を期待値の根拠に名指しする行が `spec/testcases/**` と `spec/inventory/test.md` から消え、#37 が存在しない引数付きクエリを探す事故が無くなる。
- トレードオフ: 設計の「影響なし」判定を8ファイル分上書きするので、`.thread/35/coverage.md` の判定と AC-16 のファイル数内訳（改訂 73 / 影響なし 28 → 改訂 81 / 影響なし 20）が同時に動く。**`coverage.md` は担当範囲外なので、是正は報告に回す。**
- 波及: 語彙走査で拾えない形なので、完了ゲートに `grep -rn 'userId スコープ' spec --include='*.md' | grep -v /review/` を1本足すと再発を防げる。

## ADR-037: `trashed ⇔ purgeAfter` の検証は設定側4件・解除側3件を末尾 append で足す

### Status

Proposed

### Context

`spec/domains/memo.md:76`（不変条件 8）と `spec/domains/trash.md:187` が新設した「`trashed` であることと `purgeAfter` を持つことは同値。ソフトデリートで設定し、復元で必ず `null` へ戻す」に、テストケースが1件も無かった（`review-001-domain-usecase.md` W-003）。`grep -rn 'purgeAfter' spec/testcases` は identity / trash の一部（`changeTrashRetentionDays` / `pruneExpiredTrashItems` / `listTrash`）にしか当たらない。

`spec/domains/trash.md:240` は「戻さないと駆動源が過去へ固定され、起床が止まらなくなる」と、落とし忘れが機能停止に直結すると自ら書いている箇所である。

### Decision

**同値の両側を1件ずつ測る。** 設定側4件（`memo/softDeleteMemo.md` / `memo/delete.md` / `knowledge/trashDocument.md` / `knowledge/trashTopic.md`）に「`purgeAfter` に `RetentionPolicy.expiresAt(now, retentionDays)` の算出結果が保存される」を、解除側3件（`trash/{restoreMemo,restoreDocument,restoreTopic}.md`）に「復元で `purgeAfter` が落ちる」を足す。

**片側だけにしない。** 「復元で落ちる」だけを測ると設定漏れ（`purge-trash` が永久に起きない）を、「設定される」だけを測ると解除漏れ（起床が止まらない）を取り逃す。不変条件が同値である以上、検査も両側に要る。

**配置は各表の末尾 append**（ADR-011 / ADR-030 と同じ規約）。`restoreDocument.md` は4つの表を持つが、`purgeAfter` の解除は3分岐すべてに共通なので「共通・異常系」の表の末尾に置く。台帳の新規 ID は `TC-softDeleteMemo-012` / `TC-delete-013` / `TC-trashDocument-011` / `TC-trashTopic-014` / `TC-restoreMemo-012` / `TC-restoreDocument-034` / `TC-restoreTopic-014`。

### Consequences

- 良い点: `spec/inventory/test.md` の行数が 782 → 788 になり（W-001 の削除1件を含む）、`purge-trash` の駆動源に関わる不変条件が実装チェックリストに現れる。
- トレードオフ: 正常系のケースが表の末尾（異常系のあと）に並ぶので、表の内部で種別が単調でなくなる。ADR-030 と同じトレードオフを受け入れる — 既存行を動かさないことのほうが台帳 ID の安定に効く。
- 波及: 追加はすべて表の末尾なので、既存行の `#L` は1つも動かない。

## ADR-038: マニュアルテストの TC 番号は振り直さず、実行順の規則を目次に1行置く

### Status

Proposed

### Context

`spec/manual-tests/search.md` は TC-18〜20 が TC-01〜07 の直後（正常系の末尾）に、`account.md` は TC-38 / TC-39 が正常系の末尾に、TC-40 が異常系の末尾に入っている。種別セクションへの配置も件数表も正しいが、**文書内の並び順と番号順が一致しない**ため「TC-08 を飛ばしたか？」の疑いが実行のたびに発生する（`review-001-testcases.md` W-003）。

提案は (a) 文書順に振り直す / (b) 目次に「記載順に実行する」と1行足す、の二択だった。

### Decision

**(b) を採る。** 理由は3つ。

1. **振り直しは相互参照を広く動かす。** `account.md` の TC-38 は `:169` / `:593` / `:629` から、TC-40 は `:24` / `:590` から参照されており、`search.md` も同様にカバレッジ表を持つ。番号を詰めると同一 PR 内で機械的に追随できるとはいえ、**既存 TC の番号が全部動く**ので、実行記録を持っている読み手が過去の記録と突き合わせられなくなる。
2. **別観点のレビューは末尾採番を「規約どおり」と評価している**（`review-001-requirements.md` の「TC 番号の採番規約も守られている…既存 TC の番号は1つも動いていない」）。振り直すと片方の指摘を直しながらもう片方を壊す。
3. **番号は台帳と紐づいていない**ので、どちらを選んでも静かな取り違えは起きない。であれば変更量の小さいほうを採る。

`spec/manual-tests/index.md` の「実行順序の推奨」の直後に「各ファイルの中は番号順ではなく記載順に実行する。飛んでいる番号は同じファイルの別セクションにある」を1段落だけ置く。

### Consequences

- 良い点: 「番号順とも記載順とも読める」状態が消える。件数表・実行記録の分母（199）は動かない。
- トレードオフ: 追加ケースが増えるほど番号の飛びは増える。飛びが読み手の負担になったら、そのときに一度だけ全ファイルを振り直す（そのコストは今払わない）。

## ADR-039: 読み取り専用ユースケースのテストケースから書き込み期待を外し、受け皿は既存のマニュアルテストに求める

### Status

Proposed

### Context

`spec/testcases/identity/listAiClientConnections.md:17` は「リセット完了画面から**「すべて失効」を実行する** → すべて `revoked` になる」を期待値に置いていた。しかし `listAiClientConnections` は `spec/usecases/identity.md` で「読み取りのみ。UoW 不要」「エラーケースは DB 例外のみ」と定義されており、**この契約では実行も検証もできないケースが台帳 ID 付きで固定される**（`review-001-requirements.md` W-001）。設計 `design.md:2462` がこのファイルへ指示したのはリセット完了による**自動失効の観測**であり、他3行（`:14`〜`:16`）はその指示どおりである。

### Decision

**当該行を削除し、`TC-listAiClientConnections-011` を欠番のまま残す**（ADR-011）。

**受け皿は新設しない。** `spec/manual-tests/account.md` の TC-38 手順3（「(b) の一覧で「すべて失効」を実行する → 一覧の全接続が失効済みになる」）が同じ振る舞いを既に検証しており、`:223` の「自動失効が切るのは直近世代だけである。必要なら TC-38 の「すべて失効」で利用者が明示的に切る」が TC-39 との関係も説明している。**一括失効のユースケースが `spec/usecases/` に無い**という指摘（`review-001-requirements.md` B-002）は上流の担当であり、そこが決まるまで下流にテストケースを置かないほうが食い違いを増やさない。

### Consequences

- 良い点: 読み取り専用ユースケースの期待値表から書き込み操作が消える。振る舞い自体の検証は失われない（マニュアルテスト側に残る）。
- トレードオフ: 一括失効の自動テストは、B-002 の受け皿が決まるまで存在しない。**受け皿ができたら `TC-listAiClientConnections-011` ではなく新しいユースケースの表へ採番する**（欠番は復活させない）。
- 続報: **受け皿は `TC-revokeAllAiClientConnections-002` に決まった。** 本ラウンドで `revokeAllAiClientConnections` が新設された（ADR-051）ことで B-002 が解消したため、当該期待値をそのユースケースの表へ置き直した（ADR-058）。`TC-listAiClientConnections-011` は欠番のままである。

## ADR-040: 主キーの形は3通りと単一行の4分類で書き、複合 UNIQUE を PK へ昇格させる

### Status

Proposed

### Context

改訂で共通方針の「**ID**: すべて `TEXT` 主キー」に「例外は `search_entries`」という排他句を新設したが、実際に単一 `TEXT` 主キーを持たないテーブルは 9〜10 ある（複合 PK 4つ・単一行3つ・`credential_locators` / `credential_mappings`）。さらに後者2つは節に主キーの宣言が1行も無く、**共通方針だけを読んだ #37 が `id TEXT PK` を発明しうる**状態だった。設計 第4.1.1節は列の全数を宣言しているので、そこに無い列を足すと同一性の権威が二重になる。

### Decision

1. **共通方針の排他句を「主キーの形は3通り（単一 `TEXT` / 複合キー / `search_entries` の `rowid INTEGER PRIMARY KEY`）＋単一行はそもそも置かない」へ書き替え、各テーブルの節を正本と明記する。** あわせて「節に無いサロゲートの `id` 列を足してよいという読み方はしない」を断定する。
2. **`credential_locators` の `cl_credential_uq`（`credential_id`, `generation`）と `credential_mappings` の `cm_credential_uq`（`kind`, `hmac`）を UNIQUE から PRIMARY KEY へ昇格させる。** どちらも設計 第4.1.1節が「一意性はこの組で取る」と決めた組であり、同一性そのものである。
3. **索引名は変えない。** 昇格させても表の「名前」欄には `cl_credential_uq` / `cm_credential_uq` を残し、台帳と「主要クエリとインデックスの対応」からの参照を生かす（名前付きの主キー制約として読む）。

### Consequences

- 良い点: 「例外は `search_entries` だけ」という誤った排他宣言が消え、9〜10 テーブルすべてが共通方針と矛盾しなくなる。
- 良い点: **`credential_locators` / `credential_mappings` に主キーの宣言ができる。** #37 が設計に無い `id` 列を発明する経路が閉じる。
- トレードオフ: SQLite では複合 PK が自動索引（`sqlite_autoindex_*`）になるので、名前で参照し続ける書き方は厳密には制約名の宣言に依存する。実装が別名を採る場合でも spec の参照先は「その組の一意制約」であって索引の物理名ではない。
- 波及: `spec/inventory/adapter.md` の `ADP-credential-locators-001` / `ADP-credential-mappings-001`、`spec/database/index.md` の主要クエリ表2行。

## ADR-041: 非集約ストアの書き込み口を各テーブルの節と台帳に置き、`resetTokenStore` の別名を spec 側で対応させる

→ `.adr/008-identity-split-and-non-aggregate-stores.md` に昇格（非集約ストアの契約とポート名の扱いとして）

### Status

Proposed

### Context

`CLAUDE.md` は UoW コンテキストが持つ書き込み口（`enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor` と `credentialLocatorStore` / `resetTokenStore` / `rotationCheckpointStore`）を「これが全数である」と断定しているが、**この7語は `spec/` に1件も無い**。とくに `credential_locators` は「到達性検査の権威」と宣言されながら、行を書く経路が spec のどこにも無かった。ADR-006 は「`spec/` が単独で読める」ことを目標に置いている。加えて `resetTokenStore` は spec 側では `PasswordResetTokenPort` という別名で存在し、同じものに2つの名前が並んでいた。

### Decision

1. **非集約ストア6つの各節に「書き込み口」を1行ずつ置く**（`jobs` / `operations` / `migration_progress` / `credential_locators` / `password_reset_tokens` / `rotation_checkpoints`）。内容は設計 第4.1.1節の非集約ストア表と同じで、書き込み箇所の全数もそこに書く。**`_meta` は「口を持たない唯一の非集約ストア」と明記する。**
2. **「OCC の `version` を持つ / 持たない」節に全数の1行を置く** — 口を持つのは6ストア・7メソッドである（`operations` だけ2つ）。
3. **`resetTokenStore` の節に「ドメイン側のポート名は `PasswordResetTokenPort` で、同じものを指す」を書く。** 名前を片方へ寄せるのではなく対応を1行で示す（ドメイン層のポート名を DB 側の都合で変えない）。

### Consequences

- 良い点: #37 が `spec/` だけを読んで「どの経路がこの表に行を書くか」を決められる。
- 良い点: 同じものに2つの名前が並ぶ状態が、対応関係の明示で閉じる。
- トレードオフ: **口の名前が `spec/database/index.md` と `CLAUDE.md` の2箇所に載る。** 全数の宣言は `CLAUDE.md` 側に残るので、口を足すときは両方を直す必要がある。
- 波及: `spec/inventory/adapter.md` の該当6行。**`spec/domains/identity.md` に `credential_locators` の書き込みポートが無い件と、`spec/usecases/identity.md` に locator を記録する段が無い件は本 ADR の射程外**（別担当への申し送り）。

## ADR-042: `jobs` の再投入収束規則3つを spec に置き、再武装する5種は名指しで列挙する

→ `.adr/010-job-enqueue-points-and-reenqueue-rules.md` に昇格

### Status

Proposed

### Context

`spec/database/index.md` は `operation_key` の欄に「同じキーの再投入は既存行に収束する」としか書いておらず、設計 第7.4節が「それだけでは `kind` によって逆向きの更新が要求される」と自ら書いて置いた3規則のうち、(1) 早める方向のみ しか spec に着地していなかった。(2) `poison` の復帰と (3) `done` の復帰対象は spec 全域に無い。同節は claim の CAS 文・backoff・prune・再武装まで同じ深さで書いているので、線引きの問題ではなく取り残しである。

### Decision

1. **`jobs` の節に収束規則3つを置く。** (1) `next_run_at` は早める方向にのみ / (2) `poison` は `pending` へ戻して `attempt` を 0 に / (3) `done` を戻すのは再武装する5種だけ。**`status` 別の (2)(3) が (1) に優先する**ことも書く（`done` / `poison` は `next_run_at` が `NULL` なので方向が定義されない）。
2. **5種は `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `sweep-orphan-mapping` / `rotate-encryption` と名指しで書く。** レビューは「類型欄から引ける」としていたが**実際には引けない** — 全数表の類型は4類型（外部 I/O / 期限処理 / 一括処理 / cross-DO saga の前進）であり、`sweep-orphan-mapping` は cross-DO saga、`rotate-encryption` は一括処理に分類されているので、期限処理3種しか拾えない。
3. **既存の再武装の1行も同じ5種の名指しへ書き替える。** 改訂前は「期限処理と一部の一括処理は」と書いており、`sweep-orphan-mapping` が落ちていた。

### Consequences

- 良い点: 設計が失敗モードまで書いた2件（(A)(B) の周期ジョブが1回完走で停止する / `send-mail` の同窓連打で起床回数が依頼回数に比例する）が spec 側で閉じる。
- 良い点: 再武装する5種の全数が、類型欄の読み替えではなく名指しで固定される。
- トレードオフ: 12種の分類が「4類型」と「再武装するか否か」の2軸になるので、`kind` を足すときに見る表が1つ増える。
- 波及: `spec/inventory/adapter.md` の `ADP-jobs-001`。

## ADR-043: `purge-trash` の再計算フェーズの自己消尽述語は `user_settings` の節に置く

→ `.adr/009-stored-purge-after-and-bulk-recalculation.md` に昇格

### Status

Proposed

### Context

`migration_progress` の節は「`purge-trash` は作業述語そのものが進捗を表す」と結論だけを断定していたが、設計 第7.5節はその根拠を「再計算の述語を**自己消尽する形**で書くこと」に置いている。spec 側には述語の形も「自己消尽しない UPDATE を足してはならない」という禁止も無く、素朴に `WHERE status = 'trashed'` で回すと述語が縮まずに完了しない。あわせて「保持期間を変えると同一トランザクションで全件再計算する」（`user_settings`）と「ジョブに再計算フェーズがある」（`kind` 全数表）をつなぐ「件数が大きい場合はチャンク分割へ落ちる」の一文も欠けていた。

### Decision

**述語は `user_settings` の節に置く。** 再計算の契機（`trash_retention_days` の変更）を書いている節が、`memos` / `topics` / `documents` の3つに分散させずに済む唯一の場所だからである。内容は (a) 件数が大きい場合はチャンク分割へ落ちる、(b) 述語は `WHERE status = 'trashed' AND purge_after <> <新しい値で算出した値>`、(c) 述語が単調に縮むことが永続カーソルを持たない唯一の根拠、(d) 自己消尽しない UPDATE を足してはならない、の4点。**`kind` 全数表の用途欄と `migration_progress` の節から参照する。**

### Consequences

- 良い点: 「結論だけがあって根拠が無い」状態が閉じ、`migration_progress` の除外根拠が spec の中で自己完結する。
- トレードオフ: ジョブの作業述語が `jobs` の節ではなく `user_settings` の節にある。参照を2箇所から張ることで補う。
- 波及: `spec/inventory/adapter.md` の `ADP-user-settings-001` / `ADP-migration-progress-001`。

## ADR-044: `search_entries` の物理形は `spec/database/index.md` を正本とし、`'delete'` の構文もここに置く

→ `.adr/005-search-projection-inside-write-transaction.md` に昇格（物理形の正本の所在として）

### Status

Proposed

### Context

external-content FTS5 の更新は「旧値で delete → 新値で insert」と書かれているが、**その delete が特殊コマンド構文**（`INSERT INTO search_fts(search_fts, rowid, ...) VALUES('delete', ...)`）であることは spec のどこにも無かった。素直に `DELETE FROM search_fts WHERE rowid = ?` と書くと、同じ節が警告している「例外が上がらず索引だけが黙って壊れる」に落ちる。加えて `search_entries` の PK の形が `spec/domains/search.md` と `spec/database/index.md` の二重管理になっており、片方だけを直すと静かに食い違う（ADR-004 / ADR-015 が tokenizer について一本化したのと同じ理由が当たる）。

### Decision

1. **`search_fts` の節に `'delete'` の構文を SQL フェンスでそのまま置き、`DELETE FROM ...` と書くと壊れることを明記する。**
2. **`search_entries` の節に「この表の物理形（主キーの取り方・列の型・索引）を決めるのは本ファイルであり、`spec/domains/search.md` ではない」と書く。** あわせて `rowid INTEGER PRIMARY KEY` を採る理由（安定した INTEGER rowid / VACUUM で再採番されない）と、別列を surrogate にする場合の UNIQUE + 索引の必須要件、`rowid` を DO の外の DTO に出さないことを置く。

### Consequences

- 良い点: 実行時に何のシグナルも出さない失敗モードに対して、踏み外さないための具体が spec に載る。
- 良い点: 物理形の正本が1箇所に決まる。
- 波及: **`spec/domains/search.md:224-227` の「制約2（PK の形）」は参照へ落とす必要がある**（別担当）。制約1（旧値 delete → 新値 insert）はドメイン側の projection 契約として残してよい。`spec/inventory/adapter.md` の `ADP-search-fts-001`。

## ADR-045: コーディネーター予約行と `account.caller_token` の寿命を否定形で書く

### Status

Proposed

### Context

`.thread/34/handoff.md` 第3節は「#37 が落としてはいけない前方互換点」を4点挙げ、落とすと **#45 がどう設計しても後から入れられなくなる**と書いている。1番目（`operations.target_locators`）と4番目（`change_state` の3値）は spec に着地していたが、**2番目（コーディネーター予約行を終端の各段が終わるまで消さない）はどのファイルにも無く**、消す側の規則（`cm_reservation_idx` を作業述語に持つ `sweep-reservations`）だけが書かれていた。3番目（`account.caller_token`）は肯定形「退会の完走時に消す」だけで、「それ以外では消さない」を言っていなかった。

### Decision

1. **`credential_mappings` の節に「終端の後始末が終わるまで予約行を消さない」を1行置く。** 材料は `locators` / `candidate_user_id` / `caller_token` であることを明記し、**掃除と終端の関係の具体（どの段でどの行を消すか）は #45 が決めるので本ファイルには書かない**と続ける。`operations.target_locators`（既存）と同じ形である。
2. **`account.caller_token` の説明を否定形へ揃える** — 「消すのは退会の完走時だけであり、それ以外の経路では消さない」。

### Consequences

- 良い点: handoff が名指しした4点が spec 側で揃う。予約行を先に消す実装を spec が止められるようになる。
- 良い点: **#45 の射程には触れていない** — 巻き戻し手順・段構成・終端モードの印・材料寿命の具体・再試行上限・受け口の割り当てはいずれも書いていない。
- トレードオフ: 「終端の後始末」が何段あるかを spec は言わないので、#37 は「消さない」だけを守る形になる。#45 が決まるまでは予約行が期限後も残りうる（可用性ではなく容量の問題であり、認可は開かない）。
- 波及: `spec/inventory/adapter.md` の `ADP-credential-mappings-001` / `ADP-account-001`。

---

## ADR-046: 期限切れ項目の列挙を `TrashQueryPort.listItemsToPurge` として置き直す

→ `.adr/009-stored-purge-after-and-bulk-recalculation.md` に昇格

### Status

Proposed

### Context

ADR-020 は `TrashQueryPort.listExpiredItems` を削除した（全ユーザー横断のバッチが消えたため）。ところが `spec/usecases/trash.md` の `pruneExpiredTrashItems` 手順3 は「自分の Durable Object の索引から `purgeAfter < now` のゴミ箱項目を `chunkLimit` 件まで取得する」を要求し続けており、**その読み取りに対応するポートがどこにも無い**。`spec/domains/{trash,memo,knowledge}.md` は3ドメイン一致で「期限切れ列挙メソッドを置かない」と拒否しているので、application 層がポート無しで DB を引く形が残っていた。`spec/testcases/trash/pruneExpiredTrashItems.md` には「列挙自体が DB 例外で失敗する」というエラーケースだけが存在する。

### Decision

**`TrashQueryPort` に自 DO スコープの列挙を戻す。名前は `listItemsToPurge(now, limit)` とする。**

- **`listExpiredItems` という旧名には戻さない。** plan.md の負の検証 `V-4` が走査語に `listExpiredItems` を持っており、旧名で戻すと「全ユーザー横断のポートが復活した」ことと区別できない。**走査語を落とすより名前を変えるほうが安い** — 検査は「旧設計が残っていないこと」を測る道具であり、新設計の都合で緩めるものではない。
- **置き場は `TrashQueryPort` である。** memo / knowledge 側に戻すと3ドメインの「置かない」宣言と正面から衝突し、ゴミ箱の横断ビューを読む契約が二重定義になる。`listTrashItems` / `findTrashItem` と同じく、UNION で射影するアダプターの1メソッドとして自然に収まる。
- あわせて起床時刻の材料として **`findEarliestPurgeAfter()`** も置く。ソフトデリート・保持日数変更・ジョブ完了時の再武装が「ゴミ箱内の `purgeAfter` の最小値」を読むと3箇所で書かれているのに、その読み取りにも契約が無かった。

### Consequences

- 良い点: `pruneExpiredTrashItems` の全手順がポート契約から辿れるようになり、`TC-pruneExpiredTrashItems-016`（列挙の失敗）が指す呼び出しが実在する。
- 良い点: **`userId` を取らないことと「横断して舐めない」ことが署名に現れる。**
- トレードオフ: `TrashQueryPort` のメソッドが3本から5本に増える。読み取り専用という性質は変わらない。
- 波及: `spec/inventory/domain.md` に `DOM-trash-008` / `DOM-trash-009` を末尾 append した。**`spec/inventory/adapter.md` 側にも `TrashQueryPort` の実装行（`ADP-trash-004` は欠番のため新規採番）が要る** — 本 ADR の担当範囲外なので引き継ぐ。

---

## ADR-047: `purgeAfter` の一括再計算の書き込み口を memo / knowledge の3リポジトリに置く

→ `.adr/009-stored-purge-after-and-bulk-recalculation.md` に昇格

### Status

Proposed

### Context

ADR-020 は保持日数の変更を「同一トランザクションでゴミ箱内全項目の `purgeAfter` を一括再計算する」と決めたが、**その一括更新に対応する書き込み経路がどのポートにも無かった**。`MemoRepository` / `TopicRepository` / `DocumentRepository` は `save(entity, expectedVersion)`（OCC 付きの単体上書き）しか持たず、全項目を `find` → `save` で回すと項目ごとに OCC トークンが要る。`CLAUDE.md` の Unit of Work は書き込み経路を閉じた集合として宣言しているので、規約上この操作を書く場所が存在しない状態だった。

### Decision

**3リポジトリに `recalculatePurgeAfter(retentionDays, limit): { updatedCount, hasMore }` を置く。**

- **trash 側に書き込みポートを新設する形は採らない。** `spec/domains/trash.md`「書き込みポートについて（設計判断）」が「削除状態の所有者は memo / knowledge であり、書き込み経路を各ドメインに一本化する」と決めており、例外を作ると同一テーブルへの書き込み契約が二重定義になる。**再計算は削除状態に属する派生値（`purgeAfter`）の更新なので、この原則の例外にする理由が無い。**
- **OCC トークンを取らず `version` も進めない。** 保持日数の変更に追随する派生値の書き換えであって業務上の変更ではないので、リビジョンにも OCC にも乗せない。
- **残件の置き場は作らない。進捗は作業述語が表す。** 「まだ再計算していない項目」＝「`purgeAfter` が新しい保持日数からの算出値と一致しない項目」であり、更新した行はその場で述語から外れる。したがってカーソルを永続化する必要が無く、`hasMore` だけで次のチャンクが決まる。**再計算の途中で保持日数がもう一度変わっても先頭からやり直しにならない**（述語が新しい値に対して定義され直される）。
- **算出規則の正本は `RetentionPolicy.expiresAt` に置いたままにする。** アダプターは一括更新のために同じ規則を持つので、規則を変えるときは両方を動かす。**この二重持ちは明示的に受容し、ドメイン側に書き残す。**

### Consequences

- 良い点: `changeTrashRetentionDays` と `pruneExpiredTrashItems` の再計算フェーズが、どちらも同じ3メソッドを呼ぶ形に揃う。
- 良い点: **「残件のカーソルがどこにも無い」という指摘が「作らないことが正しい」に変わる。** 預け先の名指しが不要になるので dangling も生じない。
- トレードオフ: **算出規則が2箇所（ドメインの純関数とアダプターの一括更新）に現れる。** 単体の算出とチャンク一括更新を1つの実装で書く手段が無いための受容である。
- 波及: `spec/inventory/domain.md` に `DOM-memo-026` / `DOM-knowledge-056` / `DOM-knowledge-057` を末尾 append した。`spec/inventory/adapter.md` 側の実装行は引き継ぐ。

---

## ADR-048: `CredentialRef` に `usableForLogin` を足す

→ `.adr/008-identity-split-and-non-aggregate-stores.md` に昇格

### Status

Proposed

### Context

`spec/domains/identity.md` の不変条件は「`credentials` は常に1件以上で、そのうち少なくとも1件はログイン手段である。数えるのは**ログイン手段になり得るクレデンシャルの `credentialId` の異なり数**」と書いているのに、`CredentialRef` は `{ credentialId, kind, label }` の3つしか持たず、**「ログイン手段になり得るか」を表す情報が型に無かった**。SSO 専用アカウントは `[sso, email（ログイン手段ではない）]` の2件を持つので、`kind` でも要素数でも判定できない。`spec/pages/index.md` P-13 と `spec/inventory/frontend.md` の `PAGE-settings-005` は既に「`usableForLogin = true` の `kind = 'email'` の要素があるか」で判定すると書いており、**上流に存在しない語を下流が使っている**状態だった。

設計 第6.1.2節 (C5) は「設定画面のクレデンシャル一覧に出すのは `credentialId` / `kind` / `label` の3つだけ」と断定している。

### Decision

**`CredentialRef` に `usableForLogin: boolean` を足し、`getCurrentUser` の出力 DTO にも載せる。**

(C5) の断定と衝突しない、と判断した。(C5) が閉じているのは**同一性を表す値の露出**（SSO subject もメールアドレスも出さない）であって、フィールド数そのものではない。`usableForLogin` は識別子ではなく可否フラグで、`credential_locators.usable_for_login`（第4.1.1節）と1対1に対応する非 PII の真偽値である。

**判定文言を `kind` だけで決まる形へ書き換える案（不変条件を「`kind: "sso"` の要素が2件以上あるときだけ解除できる」にする）は採らない。** 設計 第6.1.1節 (R4) が「数えるのは `usableForLogin = true` かつ active な行の distinct な `credentialId` の個数である」と正本で決めており、`kind` に倒すと (R4) と食い違う。**上流と下流のどちらを動かすかは、正本がどちらを支持しているかで決まる。**

### Consequences

- 良い点: 不変条件が `User` の状態だけで決定可能になり、`removeCredential` が純関数のまま「最後のログイン手段か」を判定できる。
- 良い点: P-13 / `PAGE-settings-005` の判定条件が、画面へ届く材料と一致する。**SSO 専用アカウントにパスワード変更フォームが出てしまう**破れが閉じる。
- トレードオフ: `getCurrentUser` の DTO が1フィールド増える。`usableForLogin` の `false → true` の遷移は本設計に存在しないので、値の意味は静的である。
- 波及: `spec/domains/identity.md`（`CredentialRef` / 不変条件 / `removeCredential` / ユースケース概要）、`spec/usecases/identity.md`（登録2本の要約生成・`getCurrentUser` の DTO と処理フロー）、`spec/inventory/{domain,usecase,frontend}.md`。**`spec/pages/index.md` P-13 は別担当が本 ADR のフィールド名に合わせる。**

---

## ADR-049: 非集約ストアをドメイン側の契約として置き、中間状態の語彙に上流のアンカーを与える

→ `.adr/008-identity-split-and-non-aggregate-stores.md` に昇格

### Status

Proposed

### Context

`spec/database/index.md` は `account`（`session_epoch` / `reset_version` / `caller_token`）と `credential_locators`（`credential_version` / `usable_for_login` / `label`）を定義し、`spec/testcases/identity/**` は同じものを camelCase（`sessionEpoch` / `resetVersion` / `credentialVersion` / `createdAtResetVersion` / `changeState` / `changeOrigin` / `failedAttempts` / `nextAttemptAllowedAt`）で期待値に書いている。ところが **`spec/domains/` と `spec/usecases/` はどちらの綴りも持たず**、「セッションの世代を進める」「作成時点のリセット世代」と散文で書いていた（ADR-031 の記録どおり）。結果として、テストケースが**物理スキーマにしか定義が無い名前**で期待値を書く形になっていた。

同じ穴が書き込み側にもあった。`credential_locators` は「到達性検査の権威・唯一の逆引き情報」と宣言されながら、**書き込みポートも usecase 手順も `spec/` に存在しない**。`CLAUDE.md` の Unit of Work だけが `credentialLocatorStore` を挙げている。

### Decision

**`spec/domains/identity.md` のポート節に非集約ストアを2つ置く。**

- **`AccountStore`** — `status` / `sessionEpoch` / `resetVersion` と、`advanceSessionEpoch()` / `advanceResetVersion()`。
- **`CredentialLocatorStore`** — `credentialId` / `kind` / 不透明な写像材料 / `credentialVersion` / `usableForLogin` / `label` と、`list` / `findByCredentialId` / `record`（upsert・単調非減少）/ `advanceCredentialVersion` / `deleteByCredentialId`。

**`UserSettingsRepository` に畳まない。** `User` 集約は「設定の所有者」であり、失効の権威（`sessionEpoch`）はその一部ではない。畳むと OCC の対象に入り、セッション失効がユーザー設定の更新と競合する。

**`CredentialMapping` のフィールド（`changeState` / `changeOrigin` / `credentialVersion` / `failedAttempts` / `nextAttemptAllowedAt`）も名前付きで書く。** 認証情報側の物理列と1対1だが、ドメインから見た意味（3値であること・起点を行に永続化する理由・カウンタの共有）はここが正本である。

**書ける範囲は「一様な終端」までに留める。** 中間状態の名前と、そこから観測できる結果（旧新どちらのパスワードでもログインできない）は書くが、**巻き戻し手順・段構成・終端モードの印・材料寿命・再試行上限は書かない**（ADR-009 の線）。終端の具体は #45 を名指しで預ける。

### Consequences

- 良い点: **8語すべてが camelCase 側のアンカーを持つ。** `spec/database/index.md` の snake_case と対になり、#10 / #13 の実装者が値域や意味を確かめるために物理スキーマまで降りる必要が無くなる。
- 良い点: `credential_locators` に書き込み口ができ、signup / SSO 登録 / パスワード変更 / リセット完了 / SSO 解除の各手順がどのメソッドを呼ぶかを spec だけで辿れる（ADR-006 の狙い）。
- トレードオフ: **ドメインのポートが5つ増える**（`AccountStore` 3本 + `CredentialLocatorStore` 5本 のうち台帳化したのは7行）。集約ではないストアをドメイン層の契約として書くことになるが、`spec/database/index.md` に契約を預ける形（もう1つの選択肢）だと依存方向が外向きになる。
- 波及: `spec/inventory/domain.md` に `DOM-identity-036`〜`044` を末尾 append した。**`CLAUDE.md:68` の非集約ストアの列挙に `account` の書き込み口が無く、`resetTokenStore` は spec 側で `PasswordResetTokenPort` という別名を持つ** — どちらも `CLAUDE.md` 側の担当へ引き継ぐ。

---

## ADR-050: 不透明カーソルの検証を「形式」と「中身・期限」に分ける

→ `.adr/006-opaque-cursor-search-pagination.md` に昇格

### Status

Proposed

### Context

`spec/domains/search.md` は3つのことを同時に書いていた。(i) `SearchCursor` は不透明で「中身の解釈は `SearchIndexPort` の実装に閉じる」、(ii) `SearchQuery` のバリデーションルールは「`cursor` が不正**または期限切れ**なら `InvalidCursor`」、(iii) `SearchQuery.create` は `now` を受け取らない。`CLAUDE.md` の「Domain — No I/O, no framework, no ambient time」の下では、`create` は復号もできず現在時刻も持てないので**期限判定は原理的に不可能**である。同じ判定が `SearchIndexPort.query` のエラーケースにも重複して置かれていた。

### Decision

**責務を分けて両方に書く。**

- **`SearchQuery.create` が見るのは形式だけ**（非空の不透明文字列であること）。
- **中身と有効期限は `SearchIndexPort.query` が判定する。**
- **どちらも同じ `BusinessRuleError(SearchErrorCode.InvalidCursor)` を返す。** 利用者から見た結果（先頭から検索し直す）は変わらないので、`spec/pages/index.md` P-11 の文言も `spec/testcases/search/search.md` の期待値も分ける必要が無い。

**「期限判定を丸ごとポートへ寄せ、`SearchQuery` から `cursor` の規則を消す」形は採らない。** 空文字のカーソルが transport 境界を通ってポートまで届く経路が残り、値オブジェクトが「構築できた時点で最低限の形が保証される」という性質を失う。

### Consequences

- 良い点: ADR-013（スナップショットの物理形は #37 が決める）と整合する。物理形を知らない層が期限を判定しない。
- 良い点: **エラーの種類が増えない。** 層が2つになっても利用者が観測する結果は1つである。
- トレードオフ: 同じエラーコードを返す箇所が2つになる。どちらが返したかは呼び出し側から区別できないが、区別する必要が無い（対処は同じ）。
- 波及: `spec/domains/search.md`（バリデーションルール・検索の規則・ポートのエラーケース・ユビキタス言語）、`spec/usecases/search.md`（入力 DTO・処理フロー2/3）、`spec/inventory/domain.md`（`DOM-search-001` / `DOM-search-004` / `DOM-search-013`）、`spec/inventory/usecase.md`（`UC-search-001`）。

---

## ADR-051: 「すべて失効」と「SSO 連携の解除」を独立したユースケースとして新設する

→ `.adr/013-sso-credential-linking-scope.md` に昇格（画面が約束した操作の受け皿と一括操作の扱いとして）

### Status

Proposed

### Context

`spec/pages/index.md` P-03 のリセット完了画面と P-13 の設定画面が、本 Issue で2つの操作を新たに約束した — 「覚えの無い SSO 連携をその場で解除できる」と「AI クライアント接続をすべて失効させる」。設計 `design.md:2344` はこの2導線を「画面仕様として #35 へ送る」と決めており、**画面側に書いたこと自体は正しい**。ところが受け皿が無かった — `spec/usecases/identity.md` にあるのは `revokeAiClientConnection`（単体・`connectionId` 必須）だけで、SSO 解除は `User.removeCredential` がドメインにあるだけである。結果として **#10 / #13 型の実装チェックリスト（`spec/inventory/` 由来）にこの2操作が1行も現れない**。

### Decision

**注記で預けず、ユースケースを2本新設する。**

- **`revokeAllAiClientConnections`** — 「`revokeAiClientConnection` の反復適用である」と1行書いて済ませない。**部分失敗の扱い**（1件の競合を記録して続行し、全体を中断しない）と件数の返却が要り、それは反復の呼び出し側が持つ契約だからである。`emptyTrash` が同じ構成の先例になっている。
- **`unlinkSsoCredential`** — 2つの物理境界をまたぐ手続きで、**順序（ユーザー単位設定側 → 認証情報側）と、その向きにする理由**（逆順は次の連携を誤判定させる／この向きなら残った写像でログインしようとしても到達性検査が拒否する）を書く。ドメイン側の2検査（`kind: "sso"` であること・最後のログイン手段でないこと）も usecase の手順に明示する。

**書ける範囲は ADR-009 の線を守る。** 中間状態から観測できる結果（解除後はその SSO でログインできない）と一様な終端までで、回収の具体は #45 を名指しで預ける。

### Consequences

- 良い点: 画面が約束した操作が台帳に載り、`PAGE-password-reset-004` / `PAGE-settings-007` から受け皿を辿れる。
- 良い点: `spec/testcases/identity/listAiClientConnections.md` に置かれていた「すべて失効」の期待（読み取り専用ユースケースの契約では実行も検証もできない）に、正しい寄せ先ができる。
- トレードオフ: **ユースケース数が 51 → 53 に増える。** `spec/index.md` の件数（ADR-034 で実数にした）と `spec/inventory/test.md` の新規ケースが追随を要する。**どちらも本 ADR の担当範囲外なので引き継ぐ。**
- 波及: `spec/usecases/identity.md`（2節を追加）、`spec/domains/identity.md`（ユースケース概要）、`spec/inventory/usecase.md`（`UC-identity-014` / `UC-identity-015` を末尾 append）、`spec/inventory/frontend.md`（該当2行から参照先を辿れるようにした）。

---

## ADR-052: 「ポートの同期契約」の例外は列挙であって導出規則ではない、と書く

→ `.adr/011-synchronous-port-contract-exceptions.md` に昇格

### Status

Proposed

### Context

`spec/domains/index.md` の「ポートの同期契約」は「例外は `PasswordHasher` と `MailSender` の2つで、**どちらもトランザクションの外（request Worker / ジョブ実行）で動くので** `Promise` のまま残る」と書いていた。結論は設計 第8.2.1節の表と一致しているが、**「ので」の部分が判定基準として機能しない** — `ArchiveWriter.write` も Durable Object の外で動くのに同期契約である（`spec/domains/export.md` / `DOM-export-011`）。`spec/` だけを読む #37 がこの一文を基準として適用すると、`ArchiveWriter.write` を `Promise` へ戻す。

### Decision

**理由を実際の線へ差し替え、例外が列挙であることを明記する。**

残る理由は「**暗号計算と外部 I/O であり、実装できる API が非同期しか無い**」ことである。あわせて「**トランザクションの外で動くことは `Promise` の根拠にならない**」を反例（`ArchiveWriter.write`）つきで書き、新しいポートを足すときの判定を「非同期 API しか無いか」に固定する。

### Consequences

- 良い点: 判定基準が実際に判定できる形になり、`spec/domains/export.md` と食い違わなくなる。
- 良い点: 例外を増やしたくなったときの問いが「外で動くか」ではなく「同期で書けるか」になる。後者のほうが厳しい。
- 波及: `spec/domains/index.md`（横断事項）、`spec/domains/identity.md`（ポート節の冒頭が同じ言い回しを持っていた）、`CLAUDE.md`（Key concepts の Unit of Work 項が同じ「外で動くから `Promise`」の言い回しを持っていた。2ラウンド目で「非同期ポートを context に載せない」という禁止形へ寄せた）、`spec/inventory/domain.md`（ポート行の要点欄が同じ理由づけを写していた。2ラウンド目で判定基準ごと差し替えた）。

## ADR-053: `search_entries` の物理形はデータベース設計に一本化する

→ `.adr/005-search-projection-inside-write-transaction.md` に昇格

### Status

Proposed

### Context

`spec/domains/search.md` の実装制約2 と `spec/database/index.md` の `search_entries` 節が、**同じ主キー設計を両方で宣言していた。** 一方 `spec/database/index.md` は「この表の物理形を決めるのは本ファイルであり `spec/domains/search.md` ではない」と既に明記している。宣言が2箇所にあると、片方だけを直したときに**どちらが正本か文面からは判定できない**。ADR-004 / ADR-015 が tokenizer について一本化したのと同じ形の二重管理である。

### Decision

**ドメイン側から実装制約2 を削除し、「物理形の正本は `spec/database/index.md`」という1段落に置き換える。** projection 契約（旧値で delete → 新値で insert）はドメイン側に残す — これは「インデックスの維持」の契機と1対1で対応する**契約**であって物理形ではない。

### Consequences

- 良い点: DDL の変更が1箇所で閉じる。`spec/database/index.md` を直せばドメイン側は自動的に追随する。
- トレードオフ: ドメイン側から `rowid` の語が消えるので、`spec/domains/search.md` だけを読んでも主キーの形は分からない。ただし `ADP-search-entries-001` / `ADP-search-fts-001` が同内容をアンカー付きで保持しているので、台帳から1ホップで辿れる。
- 波及: `spec/domains/search.md`（実装制約2）。

## ADR-054: `CLAUDE.md` は非集約ストアの員数を数値で持たない

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

### Status

Proposed

### Context

`CLAUDE.md` に「6ストア・7メソッド」と**員数を焼き込む**と、`spec/database/index.md` の全数表と食い違ったときに**両方が嘘になる**。どちらが正本かは文面からは決まらず、片方を直した人がもう片方の存在に気づかない限り差は残り続ける。

### Decision

**`CLAUDE.md` には3つだけを書く** — (1) ストアの列挙、(2) 例外構造（`operations` が2本・`_meta` が0本）、(3)「全数の正本は `spec/database/index.md`」。**員数は書かない。**

`jobs.kind` について既に採っている書き方（種別を列挙し、全数表は `spec/database/index.md` 側に置く）と同じ形である。

### Consequences

- 良い点: 名簿が動いても `CLAUDE.md` が嘘にならない。追加・削除で直すのは列挙1箇所だけになる。
- トレードオフ: `CLAUDE.md` を読んだだけでは「これで全部か」を数で確認できない。正本へのポインタで代替する。
- 波及: `CLAUDE.md`（Key concepts）。**本 ADR は `CLAUDE.md` を担当する別ステップへの申し送りであり、`.thread/35/` 側では記録だけを持つ。**

## ADR-055: 試行制限の開示方針の非対称を画面仕様の断定として置く

### Status

Proposed

### Context

設計が #35 へ渡した画面文言（試行制限に達したことと再試行可能時刻を**利用者に開示する**）は、`spec/testcases/identity/changePassword.md` にしか降りていなかった。ところが**未認証のログイン経路（P-01）は逆に非開示**である（存在推測を与えないため）。開示方針が反転していることがどこにも書かれていないと、実装者は先に読んだほう（P-01）の文言へ倒れる。

### Decision

**`spec/pages/index.md` P-13 の状態に「P-01 とは開示方針が反転する」まで明示的に書く。** 目的は非対称そのものの記録ではなく、**実装者が P-01 の文言へ倒れるのを止めること**である。理由（P-13 は認証済みの本人しか到達できないので、開示しても他人の存在を漏らさない）も1行添える。

### Consequences

- 良い点: 開示方針の非対称が仕様として保護される。テストケース側（`changePassword.md`）と画面仕様が同じことを言う。
- トレードオフ: 画面仕様に認可の理屈が1行入る。P-13 の状態記述が純粋な表示仕様でなくなる。
- 波及: `spec/pages/index.md` P-13。

## ADR-056: `CLAUDE.md` の「Key concepts」導入文を、実体のある項と `spec/` が正本の項に分ける

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

### Status

Proposed

### Context

ADR-005 は「`CLAUDE.md` は実装に先行して新構成で断定する」と決めた。その結果、Key concepts の導入文「Each of these is enforced in code and documented in library-level JSDoc at the relevant module」が、**改訂後の項の大半について嘘になっている。** 読者は JSDoc を探して空振りする。

**「実体のある項」と「#37 未着地の項」は、項の境界では割れない。** 改訂後の Key concepts は **Unit of Work / Retry strategy / Input validation / Storage limits の4項と「Asynchronous execution contract」節**で構成される（本 PR は Outbox 項を削除したので、Outbox はもう項として存在しない）。このうち

- **Storage limits と Asynchronous execution contract は丸ごと #37 未着地**である（`CLAUDE.md` の移行注記が「Nothing named Durable Object, `jobs` or Alarm exists in the code yet」と書いている）。
- **Unit of Work も未着地側である。** 改訂後の項は「コールバックは完全同期で、`run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` が `async` を型で弾く」と断定するが、同じファイルの移行注記が「`UnitOfWorkProvider.run` is still asynchronous and its context still exposes `collectEvents`」と明言している。**現在の code / JSDoc はこの項の正本ではない。**
- **Retry strategy は項の内部で割れる。** 「OCC のミスマッチは再試行候補ではなく呼び出し元に見える信号」「アプリ層の OCC リトライデコレータを置かない」は今日の `packages/core/src/adapters/d1/unitOfWork.ts` にそのまま当たるが、`version` による条件付き `UPDATE` の形とジョブランナーは #37 側である。
- **Input validation はほぼ実体がある**が、「DO への RPC ホップは第3の検証点ではない」という一文だけが未着地である。

移行中注記（`### Migration in progress — #37`）は**何が消えるか**を書く節であり、**どこに正本があるか**は書いていない。役割が違うので同じ注記では覆えない。

### Decision

**導入文に例外句を足し、#37 が未着地の部分は `spec/` が唯一の正本であることを明示する。ただし項名を列挙しない。** 上のとおり分割線が項の境界と一致しないので、列挙すると「列挙に載っていない項は全部 code が正本」という誤った読み方を許してしまう。代わりに「`#37` 待ちのものは規則を述べるだけで裏づけとなるモジュールも JSDoc も無い」と条件で書き、**現況の全数は移行中注記へポインタで渡す**（`see "Migration in progress" under Reference runtime for what is and is not in the code today`）。

現況の列挙を1箇所に閉じるのは ADR-054（員数は書かず正本を指す）と同じ形である。

### Consequences

- 良い点: 読者が JSDoc を探して見つからない空振りが無くなる。ADR-005 の「先行して断定する」は維持したまま、断定の**根拠の所在**だけを正しくする。
- 良い点: 項の増減や項内の一文の移動で導入文が嘘にならない。現況の全数を持つのは移行中注記だけになる。
- トレードオフ: 導入文だけを読んでも「どの項が未着地か」は分からず、移行中注記まで辿る必要がある。**#37 完了時に導入文を戻す作業が1つ増える**が、移行中注記の撤去と同じタイミングなので、その手順に1行足す形で済む。
- 波及: `CLAUDE.md`（Key concepts の導入文）。ADR-054 と同じく `CLAUDE.md` 担当への申し送りである。

## ADR-057: 削除済み `ADP-trash-004` は欠番のまま残し、新設2メソッドを `-005` / `-006` として末尾 append する

### Status

Proposed

### Context

`ADP-trash-004`（旧 `listExpiredItems`）は ADR-020 で削除された。そこへ ADR-046 が新設した `TrashQueryPort.listItemsToPurge` と `findEarliestPurgeAfter` の2メソッドを載せる必要がある。申し送りは「`004` は欠番なので新規採番に使える」としていたが、**ADR-011 は「削除した ID は欠番のまま繰り上げない／新設は末尾 append」を全台帳 ID に適用すると宣言している。** 欠番へ別の要素を入れるのは繰り上げと同じ事故（同じ ID が別の要素を指す）を起こす。

### Decision

**ADR-011 の規約を申し送りより優先する。** `ADP-trash-004` を欠番のまま空け、`listItemsToPurge` = `ADP-trash-005`、`findEarliestPurgeAfter` = `ADP-trash-006` を**末尾に append** する。

### Consequences

- 良い点: **#10 / #13 のチェックリストが参照する既存 ID が1つも動かない。** 欠番へ別内容を入れると、旧 `ADP-trash-004`（`listExpiredItems`）を指していた参照が静かに別メソッドを指すことになる。
- トレードオフ: 連番が飛ぶ（`004` が空く）。ADR-011 が既に受け入れているトレードオフである。
- 波及: `spec/inventory/adapter.md`。

## ADR-058: `TC-listAiClientConnections-011` の受け皿を新設ユースケースの表に採る

### Status

Proposed

### Context

ADR-039 は読み取り専用ユースケース `listAiClientConnections` の期待値表から書き込み期待（「すべて失効」を実行するとすべて `revoked` になる）を外し、**受け皿が決まるまで欠番のまま残す**と決めた。本ラウンドで ADR-051 が `revokeAllAiClientConnections` を独立したユースケースとして新設したので、受け皿が確定した。

### Decision

**`TC-revokeAllAiClientConnections-002` として置き直す。** `TC-listAiClientConnections-011` は**欠番のまま**（ADR-011。欠番は復活させない）。

### Consequences

- 良い点: 読み取り専用ユースケースの期待値表に書き込み操作が戻らない。振る舞いの自動検証は新設ユースケース側で復活する。
- 波及: `spec/testcases/identity/revokeAllAiClientConnections.md` / `spec/inventory/test.md`。ADR-039 の Consequences に続報として追記済み。

## ADR-059: 新設ユースケースのテストケースは新規ファイルで足し、`spec/` のファイル数を増やす

### Status

Proposed

### Context

plan.md AC-16 は「着手前 101 / **完了後 100**」を固定値のゲートにしていた。この数は「新設ファイルは無い」という前提に立っている（差の1件は `spec/testcases/search/maintainSearchIndex.md` の削除だけ）。ところが本ラウンドで ADR-051 がユースケースを2つ新設したので、前提が崩れた。

`spec/testcases/` は「**1ユースケース1ファイル**」の構成で、`spec/inventory/usecase.md` の `UC-*` 行数と `spec/testcases/` のファイル数が一致することを不変条件にしている。

### Decision

**構成を崩さず2ファイルを新設する**（`spec/testcases/identity/{revokeAllAiClientConnections,unlinkSsoCredential}.md`）。既存ファイルへ相乗りさせない。**AC-16 の期待値を 100 → 102 へ更新する。**

### Consequences

- 良い点: 「ユースケース数 = テストケースファイル数」の不変条件が維持される（**53 = 53**）。
- トレードオフ: 固定値のゲートを1つ書き換えることになる。ただし AC-16 が測っているのは「判定の無いファイルが無いこと」であり、数値はその補助である。
- 波及: plan.md AC-16・「カバレッジの再走査」節、`.thread/35/coverage.md`（新設2ファイルの判定行と総数）、`.thread/35/testing.md`。
- **続報（2ラウンド目）:** ADR-062 が `linkSsoCredential` を足したので、同じ規約により新設ファイルは3件になった。**不変条件は 54 = 54、`spec/` のファイル数は 103、AC-16 の期待値も 103 である。** 本 ADR が決めたのは数値ではなく「1ユースケース1ファイルを崩さず新規ファイルで足す」という規約なので、決定そのものは変わらない。

## ADR-060: DB 層の規則のうち、ユースケースから観測できないものにはテストケースを置かない

### Status

Proposed

### Context

本ラウンドで DB 層に4つの規則が確定した — (1) `search_fts` の external-content 更新が「旧値で delete → 新値で insert」の引き算であること（ADR-044）、(2) `purge-trash` の再計算フェーズの自己消尽述語（ADR-043）、(3) `jobs` の再投入収束規則（ADR-042）、(4) `jobs` の複合主キー（ADR-040）。このうち **(3) と (4) は usecase の入出力に一切現れない** — 再投入の収束はジョブ実行機構の内部であり、複合主キーは同じ効果を単一主キー + UNIQUE でも実現できる。

`spec/testcases/` は **usecase 単位**の構成である。観測点を持たない規則をここへ置くと、「どのユースケースを呼ぶと何が起きるか」を書けないまま行だけが増える。

### Decision

**観測点を持つ2件だけをテストケース化する**（(1) は `spec/testcases/search/search.md`、(2) は `spec/testcases/trash/pruneExpiredTrashItems.md`）。**残る2件は台帳（`spec/inventory/adapter.md`）の要点欄に閉じる。**

### Consequences

- 良い点: `spec/testcases/` が usecase 単位である構成を保つ。期待値の書けない行が入らない。
- トレードオフ: **スキーマ規則の検証が `spec/` の自動テスト定義から漏れる。** 引き取り先は #37 の実装テスト（アダプター層）である。
- 波及: `spec/inventory/adapter.md` の要点欄。

## ADR-061: リセット完了時に新しいセッションを確立する

→ `.adr/012-new-session-on-password-reset-completion.md` に昇格

### Status

Proposed

### Context

`spec/pages/index.md` P-03（リセット完了画面）は必須導線を4本持つ — `getCurrentUser` / `listAiClientConnections` / `unlinkSsoCredential` / `revokeAllAiClientConnections`。**4本ともセッション由来の `userId` を要求する**（`spec/usecases/identity.md` の全体宣言）。ところが完了画面は未ログインで到達する画面であり、しかも `executePasswordReset` の手順6-1 が `sessionEpoch` を前進させるので、**リセット前に張っていた旧セッションも同時に死ぬ。** つまり4導線は誰からも呼べない。

### Decision

**`executePasswordReset` が `{ userId }` を返し、presentation 層が `sessionEpoch` の前進**後**にセッションを張る。** 扱いは `loginWithPassword` と同じである。

**設計 第6.5.1節が却下した案とは別物である。** 却下されたのは「リセット完了**前**にセッションを発行する」案で、これは中間状態で発行したセッションが旧世代のまま生き残る。本決定は前進の後に張るので、生き残るのは新しいセッションだけになる。

### Consequences

- 良い点: 完了画面が認証済み画面になり、「`userId` はセッション由来」という全体宣言に**例外を書かずに済む**。
- 良い点: `spec/pages` / `spec/scenario` / 手順書 / テストケースから「ログインし直す」が消える。導線の到達可能性が仕様の上で閉じる。
- トレードオフ: ユースケースの出力が void から `{ userId }` へ増え、presentation 層に「世代を進めた後に張る」という順序の責務が乗る。順序を守らないと新しいセッションも旧世代として弾かれる。
- 波及: `spec/usecases/identity.md`（`executePasswordReset` の手順と出力）、`spec/pages/index.md` P-03、`spec/scenario/account.md`、`spec/manual-tests/account.md`、`spec/testcases/identity/executePasswordReset.md`、`spec/inventory/usecase.md`。

## ADR-062: SSO 連携の追加（`linkSsoCredential`）を spec に載せる

→ `.adr/013-sso-credential-linking-scope.md` に昇格

### Status

Proposed

### Context

設計 第6.6節は SSO 連携の追加（link）を**4手順の cross-DO saga として全設計しており**、`spec/database/index.md` も `jobs.kind` に `resume-link` を既に持っている。ところが `spec/domains/identity.md` の「アカウントリンクはスコープ外」という一文が **blanket に読める**形で残っていた。結果として、本ラウンドで新設した `unlinkSsoCredential`（ADR-051）の**正常系が構造的に到達不能**になる — 解除できる SSO クレデンシャルを作る経路が spec のどこにも無いためである。`resume-link` も投入点を持たないジョブとして残り、設計 第7.4節 (7) の「投入点の無い周期・反復ジョブは1回完走した時点で恒久停止する」に当たる。

### Decision

**スコープ外なのは「サインイン時の自動リンク」だけであると限定し、`linkSsoCredential` を新設する。** 自動リンク（IdP のメールが既存アカウントと一致したときに黙って紐づける）を行わない判断は `registerOrLoginWithSso` の側にそのまま残す。利用者が設定画面から明示的に開始する連携追加は別物であり、設計が全設計している以上 spec に載る。

### Consequences

- 良い点: `unlinkSsoCredential` の正常系に到達する唯一の経路ができ、`resume-link` に投入点ができる。`User.addCredential` にも呼び出し元ができる（それまでドメイン側にメソッドだけがあった）。
- 良い点: 「スコープ外」の射程が blanket ではなく1つの具体的な振る舞いに縮み、`spec/` だけを読む #37 が誤って link 全体を落とすことがなくなる。
- トレードオフ: **ユースケースが 54 に増え、テストケースファイルが1件増える**（`spec/` は 103 ファイル）。`spec/pages/index.md` P-13 に機能が1つ増える。
- 波及: `spec/domains/identity.md`（スコープ外の限定）、`spec/usecases/identity.md`（`linkSsoCredential` 節）、`spec/testcases/identity/linkSsoCredential.md`（新設）、`spec/pages/index.md` P-13、`spec/inventory/{usecase,test,frontend}.md`、`spec/manual-tests/account.md`、`.thread/35/{plan,coverage,testing}.md`（件数とファイル数）。

## ADR-063: リセット完了時の AI 接続一括失効に専用ポートを置かない

→ `.adr/009-stored-purge-after-and-bulk-recalculation.md` に昇格（一括操作に専用メソッドを置くかを規模で決める規則として）

### Status

Proposed

### Context

`executePasswordReset` の手順6-4 は「`createdAtResetVersion` が前進前の値と等しい active な接続をすべて失効させる」。同じ形の一括操作について、`purgeAfter` の再計算には **`recalculatePurgeAfter` という専用メソッドを新設して閉じた前例**がある（ADR-047）。同じ前例をここにも適用するなら `AiClientConnectionRepository` に条件付き一括失効を足すことになる。

### Decision

**専用ポートを置かず、呼び出し列（`listByUserId` → `findById` → `revoke` → `save`）で書く。** 前例と扱いを分ける根拠は件数である — 対象が「**前回のリセット完了以降に作られた接続**」に限られるので上限が小さく、`recalculatePurgeAfter` が相手にする「ゴミ箱内の全項目」のような有界反復を要する規模にならない。ドメインの `revoke` を1件ずつ通すほうが不変条件の適用も自然である。

### Consequences

- 良い点: `AiClientConnectionRepository` が**6メソッドのまま**動かない。**#13 の実装チェックリストが参照する `DOM-identity-023`〜`028` が指す要素が変わらない**（AC-9 / AC-15 の前提そのものである）。
- 良い点: 「一括操作は専用メソッド」という規則を件数の根拠つきで例外化したので、次に同じ判断が要るときの問いが「規模が有界反復を要するか」に固定される。
- トレードオフ: ユースケースの手順が1行から4段になり、`spec/usecases/identity.md` の記述が長くなる。
- 波及: `spec/usecases/identity.md`（`executePasswordReset` 手順6-4）、`spec/inventory/usecase.md`。

## ADR-064: `account` の OCC `version` に本 spec の範囲では書き手を置かない

### Status

Proposed

### Context

`AccountStore` は3メソッド（`find` / `advanceSessionEpoch` / `advanceResetVersion`）で **`save` 相当を持たない。** `account` テーブルの `status` / `deleted_at` / `caller_token` を書く操作も `spec/usecases/**` に1つも無い。退会は要件にもシナリオにも存在せず、#35 の受け入れ基準にも入っていない。この状態のまま OCC の全数表に `account` を載せておくと、「規則はあるが適用する操作が無い」列として残る。

### Decision

**`version` 列は落とさない。** 設計 第4.1.1節が集約ルート3つの `version` を確定させており、列の有無は本 Issue の裁量ではない。代わりに **「本 spec の範囲では `account` に条件付き更新を発行する操作が無い」と明記する。** 書き手が現れるのは #37 の DO RPC 側（退会・コーディネーター予約の確定）である。

### Consequences

- 良い点: `P-10` と OCC の全数表が維持され、テーブル定義の全数宣言に穴が開かない。
- 良い点: **#37 が「使う規則はあるが使う操作が無い」で手を止めない。** 書き手の所在が spec の側から名指しされる。
- トレードオフ: spec に「今は誰も書かない列」の説明が1段落増える。#37 が着地したら消す記述である。
- 波及: `spec/database/index.md`（`account` の節と OCC 全数表）、`spec/domains/identity.md`（`AccountStore` の契約）。

## ADR-065: 濫用抑止の3規則を `spec/domains/identity.md` に置き、具体値は運用側へ送る

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格（具体値を運用側へ送る規則として）

### Status

Proposed

### Context

設計 第6.2.2節 (a) は「**3つの存在自体は本節で固定する**」と書いている（天井・時間減衰・非加算）。ところが `spec/` 側にこの3つが1つも無く、**マニュアルテストの TC-40 だけが先行して「ロックアウト」を検証する形**になっていた。手順書が仕様の正本になっている状態である。

### Decision

**`spec/domains/identity.md` の `CredentialMapping` の項に3規則と脱出経路2本を置く。** 具体値（何回で天井か、減衰の時定数はいくつか）は書かず、運用側の調整項目として送る。設計が固定したのは「3つが存在すること」であって値ではないためである。

### Consequences

- 良い点: 手順書 TC-40 に仕様上の根拠ができ、`spec/manual-tests/` が仕様の正本になっている状態が解消される。
- 良い点: 値を書かないので、運用調整のたびに spec を直す義務が生まれない。
- トレードオフ: spec だけを読んでも実装に必要な数値は決まらない。#37 は運用側の設定として持つ必要がある。
- 波及: `spec/domains/identity.md`（`CredentialMapping`）、`spec/manual-tests/account.md`（TC-40 の根拠参照）、`spec/inventory/domain.md`。

## ADR-066: `purge-trash` の投入点を「ソフトデリート4 + 保持日数変更1」の5つとして全数で固定する

→ `.adr/010-job-enqueue-points-and-reenqueue-rules.md` に昇格

### Status

Proposed

### Context

`purge-trash` の起床を張る記述は、正本（`spec/database/index.md`）と `changeTrashRetentionDays` にしか無く、**ソフトデリート4本（メモ / トピック / ドキュメント / 個別ハードデリート起点の再計算）に届いていなかった。** 設計 第7.4節 (7) は「**投入点の無い周期・反復ジョブは1回完走した時点で恒久停止する**」と断定している。書き落としがそのまま「ゴミ箱が二度と空にならない」に化ける形である。

### Decision

**投入点を数え上げ可能な全数（5つ）として、正本と適用先の両方に書く。** 投入口は UoW コンテキストの `enqueueJob`、材料は `TrashQueryPort.findEarliestPurgeAfter()`、投入は**早める方向にのみ効く**（既存の起床より遅い時刻では張り直さない）。

### Consequences

- 良い点: **書き落としが全数宣言との突合で検出できる。** 「5つ」と宣言したうえで5箇所に書くので、片方だけ増減すると矛盾が読み取れる。
- トレードオフ: **投入点が増減したら5箇所と全数宣言を同時に直す義務が生まれる。** 機械検査は無く、レビューでしか守れない。
- 波及: `spec/database/index.md`（`jobs.kind` の全数表の投入点欄）、`spec/usecases/{memo,knowledge,identity}.md`（5箇所）、`spec/domains/trash.md`、`spec/inventory/usecase.md`。

## ADR-067: 「trash は書き込みポートを持たない」原則と起床の投入を両立させる

→ `.adr/010-job-enqueue-points-and-reenqueue-rules.md` に昇格

### Status

Proposed

### Context

ADR-066 が確定させた投入は**書き込み**である。素直に読むと trash 側に書き込み口が要ることになるが、trash ドメインは「書き込みポートを持たず、実体の書き込みは memo / knowledge の各リポジトリが担う」という原則で設計されている。ここに書き込みポートを1本足すと、その一本化が崩れる。

### Decision

**投入口を UoW コンテキストの `enqueueJob` に置き、trash 側は読み側の `findEarliestPurgeAfter` だけを持つ。** 投入を実行するのは memo / knowledge / identity のユースケースであって、trash のユースケースではない。trash が提供するのは「いつ起こすべきか」の材料だけである。

### Consequences

- 良い点: 「trash は書き込みポートを持たない」原則が無傷のまま、投入点の全数（ADR-066）が成立する。
- 副次的な効果: **`enqueueJob` が `spec/usecases/**` に初めて呼び出し箇所を持つ。** それまでは `UnitOfWorkContext` の定義側にしか現れない名前だった。
- トレードオフ: 「起床を張るのは誰か」がドメインの名前からは読めない（trash の材料で memo のユースケースが張る）。全数表の投入点欄（ADR-072）がこれを補う。
- 波及: `spec/domains/trash.md`（`TrashQueryPort` は読み側のみ）、`spec/domains/index.md`（`enqueueJob` の位置づけ）、`spec/usecases/{memo,knowledge,identity}.md`。

## ADR-068: `purge-trash` の再計算フェーズを「起床をまたいで収束する有界反復」に確定する

→ `.adr/009-stored-purge-after-and-bulk-recalculation.md` に昇格

### Status

Proposed

### Context

同じ反復について3者が食い違っていた — `spec/database/index.md` は「有界」、ドメイン・ユースケースは「空になるまで」、テストケースは「有限回の起床で」。1起床の中で空になるまで回すと読むと、大量のゴミ箱項目で Alarm が時間切れになる。

### Decision

**設計 第7.4節 (iii-b) を正とし、「空になるまで」は起床をまたいだ収束と読む。**

- 1起床の反復は **`maxChunks` で打ち切る**。
- **削除フェーズへ進むのは、再計算の残件が空になった起床だけ**である。
- 入力 DTO に `maxChunks` を新設し、既存の `chunkLimit` は**1チャンクの行数**に限定する（2つの上限が別物であることを名前で分ける）。

### Consequences

- 良い点: 3者が同じことを言うようになる。1起床の作業量に上限があるので Alarm の時間切れが構造的に起きない。
- 良い点: **誤削除防止（保持期限を延ばす方向の変更）が「削除は残件0の起床でのみ」で保たれる。** 再計算が途中の状態で削除フェーズに入る経路が無い。
- トレードオフ: `pruneExpiredTrashItems` の入力 DTO が1フィールド増える。呼び出し側（Alarm ハンドラ）が2つの上限を渡すことになる。
- 波及: `spec/database/index.md`、`spec/domains/trash.md`、`spec/usecases/trash.md`、`spec/testcases/trash/pruneExpiredTrashItems.md`、`spec/inventory/{usecase,test}.md`。

## ADR-069: trash の読み取り系ユースケースからユーザー実在確認を外す

→ `.adr/007-tenant-isolation-inside-durable-object.md` に昇格

### Status

Proposed

### Context

`TrashQueryPort` から `retentionDays` が落ちた結果、trash の読み取り系は `UserRepository.findById` を経由しなくなった。ところが**エラーケース表の「ユーザー不在は `NotFoundError`」の行だけが残っていた。** 到達できない発生源が表に載っている状態である。

### Decision

**実在確認は行わないと明文化する。** 未初期化の Durable Object は**空のゴミ箱として振る舞う** — `listTrash` は空配列、`emptyTrash` は `deletedCount: 0` を返す。

### Consequences

- 良い点: **テナント分離を到達可能性に寄せた設計と整合する。** DO のスタブが選ばれた時点で分離は済んでおり、中で「そのユーザーが居るか」を再検査する理由が無い。
- 良い点: `NotFoundError` の発生源が trash の読み取り系から消え、エラーケース表が実際に到達し得るものだけになる。
- トレードオフ: 存在しないユーザー ID で呼んでも成功応答が返る。認証済みセッション由来の `userId` しか入らないので実害は無いが、防御的なコードを書く実装者には直感に反する。
- 波及: `spec/usecases/trash.md`（エラーケース表）、`spec/domains/trash.md`、`spec/testcases/trash/{listTrash,emptyTrash}.md`、`spec/inventory/{usecase,test}.md`。

## ADR-070: `jobs.operation_key` を「単一 TEXT 主キー = UUIDv7」規則の第2の例外として明示する

→ `.adr/010-job-enqueue-points-and-reenqueue-rules.md` に昇格

### Status

Proposed

### Context

1ラウンド目の修正で ID 規則が**排他形**（「単一 TEXT 主キーは UUIDv7 である」）になり、例外は `password_reset_tokens.token_id` **だけ**と全数で宣言された。ところが `jobs.operation_key` も単一 TEXT 主キーであり、しかも**決定的導出値**（ジョブの同一性から導く）である。宣言が嘘になっている。

### Decision

**例外を2件の全数とし、`operation_key` は「生成せず、ジョブの同一性から決定的に導く」と定める。**

### Consequences

- 良い点: **収束規則 (1)(2)(3) と `provider_idempotency_key` の導出、`requestPasswordReset` の連打収束が実装可能になる。** どれも「同じ入力から同じキーが出る」ことに依存しており、UUIDv7 では成立しない。
- 良い点: 例外が全数宣言のまま保たれる。3件目が要るときは同じ場所を直すことになる。
- トレードオフ: ID 規則の宣言に例外が2件並ぶ。1件のときより「規則」としての強さが下がる。
- 波及: `spec/database/index.md`（ID 規則と `jobs` の節）。

## ADR-071: `payload_digest` の射程を実行可能集合に限定し、収束規則の優先を digest 規則へも及ぼす

→ `.adr/010-job-enqueue-points-and-reenqueue-rules.md` に昇格

### Status

Proposed

### Context

`payload_digest` の列定義が**無条件形**（「同じ `operation_key` で `payload` が違えば弾く」）で書かれており、1ラウンド目で足した収束規則 (2)(3)（`done` / `poison` からの再投入を許す規則）と**同じ入力に逆の指示を出していた。** どちらに従うかが文面から決まらない。

### Decision

**digest 規則の射程を `status IN ('pending','running')` に限定する。** `done` / `poison` への再投入は収束規則 (2)(3) が定めるものであり、digest の不一致で弾かない。あわせて優先規則を「収束規則は (1) と digest 規則の**両方に**優先する」へ拡張する。

### Consequences

- 良い点: **`poison` からの復旧手順が一意に決まる。** 別ペイロードでの再投入が規則の衝突なく通る。
- 良い点: digest 規則が本来の役割（実行待ち・実行中の行に対する取り違え防止）に収まる。
- トレードオフ: 列定義に状態条件が入り、読み手は `status` の意味を先に知っている必要がある。
- 波及: `spec/database/index.md`（`jobs.payload_digest` の列定義と収束規則の節）。

## ADR-072: `jobs.kind` の全数表に投入点欄を持たせ、欄の非空を不変条件とする

→ `.adr/010-job-enqueue-points-and-reenqueue-rules.md` に昇格

### Status

Proposed

### Context

投入点の全数を「表へ委譲する」と決めていたのに、**表にその欄が無かった。** 実測で `purge-trash` と `sweep-orphan-mapping` の投入点は `spec/` 全域で 0 件だった。設計 第7.4節 (7) の断定（投入点の無い反復ジョブは1回で恒久停止する）に照らすと、この2種は仕様上「起きないジョブ」である。

### Decision

**設計 第7.4節の正本表と同じく、`spec/database/index.md` の `kind` 全数表に投入点を欄として持たせる。`kind` を足したら欄も同時に埋める**（欄の非空を不変条件とする）。

### Consequences

- 良い点: **「投入されるが二度と起きないジョブ」が表の空白として検出できる。** 散文に散らしていたときは、どこにも書かれていないことが読み取れなかった。
- 良い点: ADR-066 / ADR-067 が確定させた投入点（`purge-trash` の5つ、`sweep-orphan-mapping` の1つ）の置き場が決まる。
- トレードオフ: 表が1列広くなり、投入点が複数ある `kind` はセルが長くなる。
- 波及: `spec/database/index.md`（`jobs.kind` 全数表）、`CLAUDE.md`（4類型の表は種別だけを持つ — 全数と投入点の正本は `spec/database/index.md` 側。ADR-054 と同じ形）。

## ADR-073: 前方互換点3本の材料寿命は DB spec が持ち、#45 への委譲は巻き戻し手順に限る

### Status

Proposed

### Context

`spec/database/index.md` が「材料の寿命は書かない（#45 へ委譲する）」と宣言する一方、**同じファイルが寿命規則を3本持っていた。** 宣言と実態が矛盾している。ADR-009 が引いた線（`spec/` に書けるのは一様な終端と利用者から観測できる結果まで）を、寿命規則に対して過剰に適用した結果である。

### Decision

**宣言側を実態に合わせる。** 材料の寿命は前方互換点の一部であり、テーブル定義と同じ場所に持つのが正しい。**#45 の射程は「段の順序・原子性境界・終端モードの印・後始末の再試行上限」に限る。**

### Consequences

- 良い点: `.thread/34/handoff.md` 第3節の4点が**すべて spec に残る。** 委譲の宣言で消える材料が無くなる。
- 良い点: **#45 の射程は狭まらない。** 巻き戻し手順そのものは引き続き #45 が持つ。
- トレードオフ: 「#45 へ委譲する」の意味が「一切書かない」から「巻き戻し手順だけ書かない」に変わるので、#45 側が受け取る前提を読み直す必要がある。
- 波及: `spec/database/index.md`（委譲宣言と前方互換点3本）。

## ADR-074: `CLAUDE.md` の UoW コンテキスト名簿は DO クラス別に書く

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

### Status

Proposed

### Context

設計 第4.3節の対応表は「DO クラス」列を持つ。ところが `CLAUDE.md` への転記でこの列が落ち、**2つの DO クラスのストアが1つのコンテキストの名簿として並んでいた。** 同じ項が「`run` takes no scope argument: **the Durable Object is the scope**」と断定しているので、**同じ文の中で衝突する** — 1つのスコープに2クラス分のストアが載ることになる。

### Decision

**名簿を DO クラス別に分けて書く**（User Data DO は `credentialLocatorStore`、Identity Directory DO は `resetTokenStore` と `rotationCheckpointStore`）。**全数の正本は `spec/database/index.md`** であり、`CLAUDE.md` は列挙と構造だけを持つ（ADR-054）。

### Consequences

- 良い点: 宣言（DO がスコープである）と名簿が同じ文の中で整合する。
- トレードオフ: **ストア名簿には機械検査が無い。** `P-9` / `P-10` に相当する検査を作れないので、**この整合はレビューでしか守れない。**
- 波及: `CLAUDE.md`（Key concepts の Unit of Work 項）。

## ADR-075: `CLAUDE.md` の OCC 形は per-table の形を断定せず `spec/database/index.md` を指す

→ `.adr/014-spec-and-claude-md-source-of-truth.md` に昇格

### Status

Proposed

### Context

`CLAUDE.md` の Retry strategy が **`WHERE id = ? AND version = ?` を唯一の形として断定**していた。ところが単一行テーブル（`account` / `user_settings`）には `id` が無く、この形は当てはまらない。テーブルの形が増えるたびに `CLAUDE.md` が嘘になる構造である。

### Decision

**`CLAUDE.md` には「`version` で条件づける／`id` はテーブルが持つ場合のみ」までを書き、per-table の形は `spec/database/index.md` を正本として指す。** ADR-054（員数を書かず正本を指す）と同じ形である。

### Consequences

- 良い点: テーブルの形が増えても `CLAUDE.md` が嘘にならない。直すのは正本1箇所になる。
- トレードオフ: `CLAUDE.md` だけを読んでも具体的な `UPDATE` 文の形は決まらない。
- 波及: `CLAUDE.md`（Key concepts の Retry strategy 項）。

## ADR-076: 新設ユースケースの台帳 ID は末尾 append（`UC-identity-016`）にする

### Status

Proposed

### Context

`linkSsoCredential`（ADR-062）は `spec/usecases/identity.md` の**節の並びでは `unlinkSsoCredential` の直前**に置くのが読み下しとして自然である（連携を追加してから解除する）。ところが台帳 ID をそこへ挿入すると `UC-identity-015`（`unlinkSsoCredential`）以降が全部ずれる。

### Decision

**節の並び順と台帳 ID の採番は別物として扱う。** ADR-011 に従い、identity 群の**末尾へ append** して `UC-identity-016` とする。

### Consequences

- 良い点: **`UC-identity-015` が指す要素が動かない。** #10 / #13 の参照が静かに取り違わることがない（AC-14 / AC-15 は「実在する」ことしか見ないので、ずれても検出できない）。
- トレードオフ: 台帳の並びと `spec/usecases/identity.md` の節の並びが一致しなくなる。ADR-011 が既に受け入れているトレードオフである。
- 波及: `spec/inventory/usecase.md`。

## ADR-077: マニュアルテストの SSO 連携追加は2つ目の Google アカウントを要求する

### Status

Proposed

### Context

`linkSsoCredential`（ADR-062）の手順書を書くにあたり、既存 TC が使っている Google アカウントをそのまま連携追加に使うと、**必ず `SSO_IDENTITY_ALREADY_REGISTERED` になる**（その主体は既にアカウントに紐づいている）。正常系が1本も組めない。

### Decision

**テストデータに「SSO 連携追加用 Google アカウント（既存とは別）」を追加し、正常系と重複拒否を別々の TC が担当する。** 用意できない場合は当該 TC を対象外として備考に記録する運用を、**前提条件に明記する。**

### Consequences

- 良い点: 正常系と異常系がどちらも実行可能な手順として書ける。
- トレードオフ: **環境要件が1つ増える。** 実行者が2つ目の Google アカウントを用意できないと当該 TC が回らない。対象外として記録する運用でこれを吸収する。
- 波及: `spec/manual-tests/account.md`（前提条件・テストデータ・TC）、`spec/manual-tests/index.md`（件数）。

## ADR-078: `#L` を動かさない編集方針（行内書き換えと末尾 append に限る）

### Status

Proposed

### Context

`spec/inventory/test.md` の「定義場所」欄は `#L{行番号}` を持ち、その参照は **838 件**ある。テストケースファイルの途中に行を挿入すると、**以降の全参照がずれる。** 2ラウンド目は既存ケースの修正と新設の両方を含むので、編集の形を決めておかないと台帳側の追従が全面的な再計算になる。

### Decision

**既存ケースの修正はすべて行内書き換えで行い、新設は各表の末尾 append に限定する（途中挿入をしない）。** ADR-011 の欠番規約（削除した ID は繰り上げない）と同じ思想を、行番号に対して適用したものである。

### Consequences

- 良い点: **台帳側の追従が「要点欄の書き換え」と「末尾行の追加」だけで済む。** 既存の `#L` は動かないので、機械検証（`P-8`）で全件一致を確認できる。
- 良い点: 差分が小さくなり、レビューで実際の変更点が読める。
- トレードオフ: テストケースファイルの中で、ケースの並びが論理的な順序と一致しなくなることがある（新設は必ず末尾に付く）。
- 波及: `spec/testcases/**`、`spec/inventory/test.md`。
