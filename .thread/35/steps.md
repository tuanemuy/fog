# 実装手順 — Issue #35

**この Issue はドキュメント改訂であり、コードは1行も変更しない。** 各ステップは「どのファイルのどの節をどう書き換えるか」の粒度で書く。

## design.md の読み方（全ステップ共通の前提）

`.thread/34/design.md` は 2651 行ある。**全部読む必要は無い。** 各ステップに「根拠節」を明記してあるので、そこだけを開く。ただし `.thread/34/handoff.md` 第4節が警告しているとおり、**表の1行だけを読んで書き換えてはならない** — 第11.1節の表は「何を消し何を足すか」の索引であり、書く内容の実体は根拠節にある。

**最初に必ず読むもの（合計 約 260 行）:**

| 節 | 行 | 何が書いてあるか |
|---|---|---|
| 第11.1節 | `2289-2490` | **本 Issue の作業指示そのもの。** 走査4手段、101ファイルの全数判定、ファイル別の削除 / 追加表 |
| `.thread/34/handoff.md` | 全115行 | #44 / #45 への切り出し（`spec/` に書いてはいけない範囲）と残余リスク |

**節と `spec/` 改訂対象の対応表（索引）:**

| design.md の節 | 行 | 反映先 |
|---|---|---|
| 第4.1.1節 テーブルの全数 | `524-577` | `spec/database/index.md` / `spec/inventory/adapter.md` |
| 第4.2節 ドメイン集約との対応 | `579-593` | `spec/domains/index.md` |
| 第4.3節 ユーザー境界に閉じないものの帰属 | `595-650` | `spec/inventory/adapter.md`（「不要になる」判定の全数） |
| 第4.5節 リポジトリ契約の変化 | `661-670` | `spec/domains/index.md`（テナント分離規約） |
| 第4.6節 容量とライフサイクル | `671-678` | `spec/requirements.md`（10 GB） |
| 第4.8節 DO 内の大きな CPU 仕事 | `700-710` | `spec/domains/export.md` / `spec/usecases/export.md` |
| 第5.4節 MCP / REST の認可経路 | `942-998` | `spec/testcases/identity/listAiClientConnections.md` / `spec/scenario/account.md` |
| 第5.5節 他ユーザーの DO を指定させない構造的保証 | `999-1018` | `spec/requirements.md` 非機能要件 / `spec/domains/index.md` |
| 第6.6節 SSO リンク / 解除 | `1387-1441` | `spec/domains/identity.md` / `spec/testcases/identity/getCurrentUser.md` |
| **第7.1節 FTS5 の同期更新** | `1601-1627` | **`spec/domains/search.md` / `spec/usecases/search.md` / `spec/database/index.md`** |
| **第7.2節 FTS5 のみで日本語全文検索が成立する根拠** | `1628-1641` | **`spec/database/index.md`（tokenizer 方針）** |
| **第7.2.1節 検索 API の仕様（#35 へ委譲）** | `1642-1652` | **`spec/domains/search.md`（検索の規則）** |
| 第7.3節 Outbox / relay / consumer / DLQ の廃止範囲 | `1653-1679` | `spec/domains/*.md` のイベント定義表全部 / `spec/testcases/` |
| 第7.4節 Alarm ジョブ | `1680-1883` | `spec/database/index.md`（`jobs` の12列） |
| 第7.5節 trash retention の期限処理 | `1884-1902` | `spec/domains/trash.md` / `spec/usecases/trash.md` / `spec/testcases/trash/` |
| 第7.6節 外部 I/O を永続ジョブに残す境界 | `1903-1933` | `spec/testcases/identity/requestPasswordReset.md` |
| **第7.7節 非同期実行契約（正文）** | `1934-1958` | **`CLAUDE.md`（そのまま写す）** |
| 第8.2節 新しい UoW 契約 | `1975-2035` | `CLAUDE.md`「Unit of Work」/ `spec/usecases/*.md` |
| 第8.2.1節 ポートの Promise 契約 | `2036-2071` | `CLAUDE.md`「Reference runtime」/ `spec/domains/*.md` の全ポート |
| 第8.3節 実行位置と Worker RPC | `2072-2123` | `spec/domains/export.md` |
| 第8.4節 OCC と Version の去就 | `2124-2141` | `CLAUDE.md`「Retry strategy」/ `spec/database/index.md` |
| **第9.1〜9.5節 schema version と lazy migration** | `2152-2252` | **`spec/database/index.md`** |
| 第10.1節 PITR / export / 退会削除 | `2255-2278` | `spec/database/index.md`（ロールバック方針） |

---

## 設計

### 全体の方向

**改訂は上流から下流へ一貫して行う。** 順序は `requirements → scenario → pages → domains → usecases → database → 横断（ADR 参照）→ inventory（4台帳）→ testcases → inventory/test.md → manual-tests → 目次・件数 → CLAUDE.md → Issue 本文`。

理由は3つ。(i) 下流（台帳・テストケース）は上流（ドメイン・DB）の記述から機械的に導かれるので、上流を先に固定しないと二度手間になる。(ii) **`spec/inventory/test.md` は `spec/testcases/**` の行番号（`#L{n}`）を参照している**ので、テストケースの行を触ったあと（ステップ13・14・15 の後）でしか閉じられない — ステップ15.5 に切り出してある。(iii) **目次・件数（`spec/index.md` / `spec/manual-tests/index.md`）は全編集の結果を数え直すもの**なので最後に置く — ステップ16.5。

### ドメインモデルへの影響（`spec/domains/`）

**search ドメインが最も変わる。** 「ハイブリッド検索とインデックス維持を担うドメイン」から「**FTS5 全文検索の問い合わせだけを担うドメイン**」へ縮む。

- `SearchIndexPort` は **`query` 1メソッド・同期契約**（第7.1節・第8.2.1節）。**Issue 本文の「query / upsert / remove」は誤りで、設計 第11.1節が「`query` 1本へ縮小する」と訂正している。**
- `IndexerReadPort` / `EmbeddingPort` / `SystemError(EmbeddingFailed)` は消える（第7.1節）。
- **書き込み側はポートにならない。** 「本体を書くトランザクションの中で projection を更新する」内部処理へ畳まれる。#10 が挙げている `SearchProjectionPort` は設計に存在しない（adr.md ADR-001）。
- `IndexEntry` は**消さない** — `search_entries` の1行に対応する projection の値として書き直す。
- 検索の規則に第7.2.1節の4点（optional 単一 topic filter / 安定順位 `timestamp DESC, type, id` / スナップショットページング / 事実 join）を足し、「非同期反映」条項を「**同一トランザクションで更新されるので投稿直後から必ずヒットする**」へ反転する。

**全ドメイン共通の変更**（第4.5節・第7.3節・第8.2.1節）:

- リポジトリの `userId` 第一引数が消える（DO 選択で消費済み）。テナント分離の根拠が**列条件から到達可能性へ変わり、例外条項（Outbox 経由の信頼済み内部イベント）は前提ごと消滅する**。
- 全ドメインポートから `Promise` が外れる（`PasswordHasher` / `MailSender` は例外的に `Promise` のまま）。
- **ドメインイベントの定義表が全ドメインから消える。** 業務上の変更履歴はリビジョン（`memo_revisions` / `document_revisions`）が既に持っている。
- identity は `User = PasswordUser | SsoUser` の判別共用体をやめ、**クレデンシャル集合**として書き直す（第6.6節）。`UserRepository` は「認証情報側（Directory）」と「ユーザー単位設定側（User Data DO）」の2つに割れる。
- trash は `TrashQueryPort.listExpiredItems` を落とし、**各 DO の Alarm による期限処理**（`purge_after` を保存し、復元時に `NULL` へ戻す）へ（第7.5節）。

### ユースケース / アプリケーションロジック（`spec/usecases/`）

- **`maintainSearchIndex` はユースケースごと消える**（第7.1節・第7.3節）。
- `pruneExpiredTrashItems` は Alarm 前提へ全面書き換え（第7.5節）。cron 起動・`batchSize`・ユーザー横断抽出という前提がすべて消える。
- 全ユースケース共通で `collectEvents(...)` 手順が消え、**「書き込みは `UnitOfWorkProvider.run` 内の同期コールバックで行う。ドメインイベントは発行しない」**へ（第8.2節）。`spec/usecases/memo.md` の `collectEvents` は**実測7箇所**（`grep -n 'collectEvents' spec/usecases/memo.md` で再現できる）。
- export は「DO は1回の `transactionSync` で読み出し、render と zip は request Worker」の分割と、**1回のエクスポートで返せる総バイト数の上限**を足す（第4.8節・第8.3節 (a)）。

### アダプター / 永続化（`spec/database/index.md`）

**403 行の前提（共有 SQLite + `user_id` 列による論理分離）ごと入れ替える。** 削除だけでなく追記のほうが重い。

- 全テーブルから `user_id` 列と先頭 `user_id` の複合索引が消える。`outbox` / `processed_events` / `_occ_guard` / `search_embeddings` の節と、期限切れ索引3本、D1 / libSQL / Turso の並列記述、「認証インフラテーブルはスコープ外」宣言（`:355-357`）も消える。
- **設計 第4.1.1節のテーブル全数を写す。** User Data DO 側16テーブル / Identity Directory DO 側5テーブル。認証・saga・ジョブ系は**列の全数まで**書く（第4.1.1節がその正本である）。
- `search_fts` を external-content 構成へ。`search_entries` の PK は `rowid INTEGER PRIMARY KEY`、`id TEXT` は UNIQUE の別列。
- **FTS5 tokenizer 方針**（第7.2節）と **schema version / lazy migration 方針**（第9.1〜9.5節）を新設する。
- OCC の `version` を持つテーブル / 持たないテーブルの区別を明記する（第4.1.1節末尾・第8.4節）。

### UI / プレゼンテーション（`spec/pages/` / `spec/inventory/frontend.md`）

- `spec/pages/index.md` P-11（検索）から「ハイブリッド / ベクトル」の語を落とす。**`PAGE-search-001`〜`004` の記述は全文検索でも変わらないので削除しない**（設計 第11.1節が明示）。
- **足すのは `PAGE-password-reset-*` と `PAGE-settings-*` の側。** リセット完了画面に必須導線2つ（クレデンシャル一覧 / AI クライアント接続一覧 +「すべて失効」）を置き、`PAGE-password-reset-004` 相当を新設する（第5.1節・第5.4節 (ii)）。`PAGE-settings-005` の「SSOのみのユーザーにはフォーム自体を非表示」はクレデンシャル集合による判定へ読み替える（第6.6節）。

---

## 実装ステップ

### 1. 走査を再実行し、改訂対象台帳を固定する

- **対象ファイル:** `.thread/35/coverage.md`（**新規作成**。判定台帳の実体）
- **変更内容:** 設計 第11.1節（`design.md:2291-2318`）の4手段を再実行し、`spec/` の非 review Markdown が **101 件**、語彙走査のヒットが **62 件**、未ヒットが **39 件**であることを確認する。差があればファイルが増減しているので、増えた分を第11.1節の判定表へ追加する。
  - **結果を `.thread/35/coverage.md` に materialize する。** 形式は `| ファイル | 判定（改訂 / 影響なし） | 対応ステップ | 拾った手段 |` の1行 = 1ファイルの表で、**101 行すべてを埋める**（判定は設計 第11.1節の一覧から写す）。
  - **ただし判定を1件だけ上書きする。** `spec/manual-tests/index.md` は設計では「影響なし」（`design.md:2487`）だが、adr.md **ADR-010** により「**改訂（ステップ16.5）**」と記録する。**設計の「改訂対象72件 / 影響なし29件」は、本 Issue では「改訂対象73件 / 影響なし28件」になる。** 上書きはこの1件だけで、他は設計の判定をそのまま写す。
  - `spec/testcases/search/maintainSearchIndex.md` の行には「**削除**」と書き、完了後のファイル数が **100** になることを表の冒頭に明記する。
  - `.thread/35/**` は AC-17 の差分ホワイトリストに入っているので、成果物制約に抵触しない。
- **理由:** 設計 第11.1節が「#35 は同じ4つを再実行して、本節の一覧に漏れが無いことを確認する」と明示的に要求している（AC-16）。`.thread/35/research.md` 第3節に実測済みの結果があるので、差分だけを見ればよい。**台帳を手元のメモに留めるとステップ19 の項3 が事後に検証できない**ので、成果物として残す。

### 2. `spec/idea.md` / `spec/requirements.md` を改訂する（要件層）

- **対象ファイル:** `spec/idea.md` / `spec/requirements.md`
- **根拠節:** 第7.1節（`1601-1627`）/ 第7.2節（`1628-1641`）/ 第3.1節 / 第4.4節 / 第4.6節（`671-678`）/ 第5.5節（`999-1018`）。要旨は第11.1節「改訂する — 要件・体験側」（`design.md:2352-2362`）と「非機能要件に足す内容の要旨」（`:2337`）。
- **変更内容:**
  - `spec/idea.md:40` の「メモ・ドキュメント横断の**ハイブリッド検索**」→「メモ・ドキュメント横断の全文検索（SQLite FTS5）」。
  - `spec/idea.md:48`「Unit of Work + **Outbox / ドメインイベント**、ポート & アダプター構成」→「Unit of Work（DO ローカルの同期トランザクション）+ Alarm ジョブ、ポート & アダプター構成」。
  - `spec/requirements.md:87`「キーワード検索とベクトル検索のハイブリッドを単一の検索として提供する」→「**SQLite FTS5 による全文検索**を単一の検索として提供する」。**「検索方式の選択をAIに委ねない」は維持する**（単一の検索であることは変わらない）。
  - `spec/requirements.md:108`「search — ハイブリッド検索。トピックによる絞り込み可」→「search — 全文検索。トピックによる絞り込み可」。**区切りの em dash（`—`）と前後の空白を含めた `search — 全文検索` の形を保つ**（`P-11` の第2行がこの形で測る）。
  - **`:87` の「検索方式の選択をAIに委ねない」は同じ行の後半にある。** 行を書き換えるときに巻き添えで落とさない — **`P-11` の第1行（着手前 1 行 → 完了後も 1 行）が、`spec/` 全体で唯一この一文を守る検査である**（負の検証は「消えたこと」しか測れない）。
  - **`spec/requirements.md` 5.1 または 5.3 へ物理分離を追記する** — 「ユーザーのドメインデータはユーザー単位の SQLite-backed Durable Object に**物理分離**される。分離の保証は列条件（`user_id`）ではなく**到達可能性**（他ユーザーの DO stub を得る経路が存在しないこと）に依る。1 DO あたりのストレージ上限は 10 GB で、本体と FTS5 インデックスの合計で見る。」
- **理由:** 上流の要件が旧前提のままだと、下流のすべての改訂が根拠を持たない（AC-4 / AC-5）。

### 3. `spec/scenario/` を改訂する

- **対象ファイル:** `spec/scenario/search.md` / `spec/scenario/ai.md` / `spec/scenario/index.md`
- **根拠節:** 第7.1節（同期更新なので投稿直後から必ずヒットする）。要旨は第11.1節（`design.md:2358-2360`）。
- **変更内容:**
  - `spec/scenario/search.md` S-SE-01 手順2 の「キーワード検索とベクトル検索を組み合わせたハイブリッド検索が実行され」→「全文検索が実行され」。S-SE-03 の「同一のハイブリッド検索を search API として利用する」→「同一の全文検索を…」。**「投稿直後は検索にヒットしない場合がある」という非同期反映の前提があれば、「同期更新なので投稿直後から必ずヒットする」へ反転する。**
  - `spec/scenario/ai.md:19`「AIが search（**ハイブリッド検索**。必要ならトピック絞り込み）で…」→「AIが search（全文検索。…）で…」。
  - `spec/scenario/index.md:42`「キーワードでメモ・ドキュメントを横断検索する（**ハイブリッド検索**）」→「（全文検索）」。
  - **`FTS5` の語を書かない。** シナリオは利用者から見た振る舞いの層であり、実装語彙の落とし先ではない（design `:2358` も「全文検索へ置き換え」までしか要求していない）。**`P-1` の `spec/scenario/search.md` セルは `全文検索` で測る**（着手前 0 行。adr.md ADR-015）。
- **理由:** シナリオは利用者から見た振る舞いの正本であり、「必ずヒットする」への反転は下流のマニュアルテスト（TC-07）とテストケースの期待値を決める（AC-1）。

### 4. `spec/pages/index.md` を改訂する

- **対象ファイル:** `spec/pages/index.md`
- **根拠節:** 第11.1節（`design.md:2361`）+ 画面仕様として送られた4件（`:2341-2347`）。
- **変更内容:**
  - P-11（検索、`:178` 付近）からハイブリッド / ベクトルの語を落とし、全文検索の語に置き換える。**ページングの記述があれば「もっと読む」相当の不透明カーソル方式へ読み替える**（第7.2.1節。adr.md ADR-012）— 実測では `spec/pages/index.md` に `page` の語は 0 行なので、**page 番号を新たに書かない**ことだけが要件である（`V-10` の射程）。
  - **P-03（パスワードリセット）に完了時の必須導線を追記する** — クレデンシャル一覧と AI クライアント接続一覧（「すべて失効」つき）を**同じ画面に**提示する（第5.1節・第5.4節 (ii)）。この画面は第10.1節の PITR 復旧手順からも流用される。
  - **P-02（アカウント登録）に「メールアドレスの所有確認（verification）を行わない」ことを既知の前提として明記する**（第5.2.1節 (a)）。所有の唯一の証明はパスワードリセット経路である。
  - **P-02 の重複エラー文言を明示する** — 「このメールアドレスは既に登録されています」を出してよい（第6.3節。列挙オラクルであることを承知のうえでの受容判断）。**「秘匿すべきでは」と再検討しない。**
  - **P-13（設定）に「SSO 専用アカウントにはパスワードを設定する経路が無い」ことを明記する**（第7.6節）。パスワード変更フォームもリセット導線も出さない。判定は「クレデンシャル集合に `usableForLogin = true` の `kind = 'email'` 行があるか」。
- **理由:** 設計が断定形で書いた画面仕様4件の落とし先がここであり、次のステップ12 で `spec/inventory/frontend.md` に `PAGE-*` を採番する入力になる。

### 5. `spec/domains/search.md` を全面改訂する

- **対象ファイル:** `spec/domains/search.md`（271 行）
- **根拠節:** **第7.1節（`1601-1627`）と第7.2.1節（`1642-1652`）を必ず読む。** 第8.2.1節（`2036-2071`）でポートの同期契約を確認する。指示の表は第11.1節（`design.md:2367`）。
- **変更内容:**
  - `:3` の冒頭説明を書き換える — 「メモ・ドキュメントを横断する**全文検索（SQLite FTS5）**を担うドメイン。**インデックスは本体更新と同一トランザクションで維持する**」。`[ADR-005]` へのリンクを **`.adr/003-sqlite-fts5-only-search.md` / `.adr/004-do-local-commit-and-alarm-jobs.md`** へ差し替える（`spec/adr/005` は superseded であることを併記）。
  - 「ドメインサービス」節（`:129-134`）の「ハイブリッド検索の統合方式（RRF 等）」の条項を削除し、順位付けは `bm25` と安定した tie-breaker であることを書く。
  - 「検索の規則」節（`:136-149`）— `:141` のゴミ箱除外の根拠を「ソフトデリートイベントで remove する」から「**本体更新と同一トランザクションで projection を除去する**」へ。**`:149` の非同期反映条項を削除し、「投稿直後から必ずヒットする」へ反転する。** 第7.2.1節の4点（optional 単一 topic filter / 未知・ゴミ箱内トピックは `TOPIC_NOT_FOUND` / 安定順位 `timestamp DESC, type, id` / 期限付きスナップショットと不透明カーソルによるページング）を足す。
    - **第7.2.1節は「#35 へ委譲」と明記された節なので、`spec/` 側にしか正本が無い。** ここに書いて終わりにせず、**適用先まで届かせる**（adr.md ADR-012）— `TOPIC_NOT_FOUND` はステップ8 の `spec/usecases/search.md` エラーケース表へ、ページング方式はステップ8 の入力 DTO・ステップ13 の既存ケース・ステップ4 の P-11 へ。
    - **「期限付きスナップショット」を物理テーブルとして `spec/domains/search.md` に書かない。** ドメイン層に書くのは契約（同じカーソルからは同じ集合が読め、期限切れカーソルは拒否される）までで、**物理定義は `spec/database/index.md` にも置かず #37 へ預ける**（adr.md ADR-013）。設計 第4.1.1節（テーブル全数の正本）にスナップショットテーブルは無く、ここで17番目を勝手に足すと AC-7 の「第4.1.1節のテーブル全数」と矛盾する。**`jti` 一回性テーブルを #13 へ預けた形（ステップ10d）と同じ扱いにする。**
  - **`SearchIndexPort`（`:153-182`）を `query` 1メソッド・同期契約へ縮小する。** `upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` とその説明・冪等性の注記を削除し、代わりに「**書き込み側はポートではない。本体を書くトランザクション内の projection 処理へ畳まれる**」を書く。`SystemError(EmbeddingFailed)` を削除。
  - **`IndexerReadPort` 節（`:184-212`）を全削除。**
  - **「`EmbeddingPort` について」節（`:213-216`）を全削除。**
  - **「インデックス更新フロー」節（`:228-265`）を全削除。** 代わりに、external-content FTS5 の実装制約2点（(i) 更新・削除は「旧値で delete → 新値で insert」の2段、(ii) `search_entries` の PK を `rowid INTEGER PRIMARY KEY` にし `id TEXT` を UNIQUE の別列にする）と「整合は SQL トリガーではなく projection コードが担う」を書く。
  - `:264` の「indexer 専用の拡張ワーカーコンテナ」を削除。
  - 「ユースケース（概要）」節（`:266-271`）から `maintainSearchIndex` を落とす。
  - **`IndexEntry`（`:93-128`）は残す。** ベクトル・埋め込み由来のフィールドがあれば落とし、`search_entries` の1行に対応する projection の値として書き直す。
  - **`SearchQuery`（`:25-60`）のキーワード長上限は 500 文字のまま維持する**（adr.md ADR-002 の判断）。
- **やってはいけないこと:** **tokenizer の機構（`trigram` / `instr()` フォールバック / `NFKC` 正規化）をこのファイルに書かない。** 落とし先はステップ10d（`spec/database/index.md`）で、これは adr.md **ADR-004** の決定そのものである。ここに書くと実装機構が search ドメインへ漏れ、ADR-001 が狙った「search ドメインは問い合わせに一点集中」も崩れる。**`P-2` の `trigram` / `NFKC` / `instr(` のセルは `spec/database/index.md` だけを測る**（adr.md ADR-015）。本ファイルで `P-2` が測るのは `不透明カーソル` / `bm25|timestamp DESC` / `TOPIC_NOT_FOUND` の3本だけである。**「同一の埋め込み SQLite」という設計 第7.1節の言い回しをそのまま写さない**（`V-1` の走査語 `埋め込み` に当たる。adr.md ADR-016）— 「同一 DO 内の SQLite」と書く。
- **理由:** 本 Issue の中心。ここが固まらないと `spec/usecases/search.md` / `spec/database/index.md` / `spec/inventory/` / `spec/testcases/search/` のすべてが書けない（AC-6）。

### 6. `spec/domains/index.md` を改訂する

- **対象ファイル:** `spec/domains/index.md`（34 行）
- **根拠節:** 第4.2節（`579-593`）/ 第4.5節（`661-670`）/ 第5.5節（`999-1018`）/ 第7.3節（`1653-1679`）/ 第8.2.1節。指示は第11.1節（`design.md:2368`）。
- **変更内容:**
  - **テナント分離規約の例外条項**「例外は Outbox 経由の信頼済み内部イベントを契機とするワーカー（search の indexer consumer 等）のみ」を**削除する**（例外は無くなる）。
  - テナント分離の根拠を「`userId` 第一引数による構造的保証」から「**DO 選択で `userId` が消費済みであり、他ユーザーの DO stub を得る経路が存在しない（到達可能性）**」へ書き換える。
  - `:34` の横断事項「**ドメインイベント + Outbox**」の項を削除し、代わりに「**全ドメインポートは同期契約である**（`Promise` を返さない。例外は `PasswordHasher` / `MailSender`）」を置く。
  - search ドメインの説明を「全文検索の問い合わせ」へ同期する。
  - **`spec/adr/004-domain-boundaries.md` が定めたドメイン境界（identity / memo / knowledge / search / trash / export）は変更しない。** 変わるのは「その集約がどの物理境界に置かれるか」だけである（第4.2節）。
- **理由:** ここの規約が全ドメイン・全テストケースの「他ユーザーの ID を指定すると `NotFoundError`」の根拠を一括して差し替える（設計 第11.1節が「読み取り系テストケース14件を触らない」と判定できるのはこの一括読み替えがあるため）。

### 7. `spec/domains/` の残り5ファイルを改訂する

- **対象ファイル:** `spec/domains/memo.md` / `knowledge.md` / `identity.md` / `trash.md` / `export.md`
- **根拠節:** 第7.3節（イベント廃止）/ 第7.5節（`1884-1902`。retention）/ 第6.6節（`1387-1441`。クレデンシャル集合）/ 第4.3節（`595-650`。`UserRepository` の分割）/ 第4.8節（`700-710`）/ 第8.3節 (a)（`2074-2090`）/ 第5.2.1節（`Email` の canonical 化規則）/ 第5.4節（`findActiveById`）。指示の表は第11.1節（`design.md:2369-2373`）。
- **変更内容:**
  - **イベント定義表は `## ドメインイベント` の見出しごと消す**（`memo.md` / `knowledge.md` / `identity.md` の3ファイル）。**表だけ消して見出しを残さない** — `spec/inventory/domain.md` の 24 行はこの見出しをアンカーに持つので、見出しが残ると `P-8`（アンカー実在検査）が dangling を検出できず、ステップ12 の削除漏れが最後まで拾えなくなる（adr.md ADR-011）。
  - **`memo.md`** — イベント定義表（`:249-268` 付近）を削除。`:14` の「検索インデックスの更新は…Outbox 経由で search の consumer が受けて行う（ADR-005）」を削除し、同一トランザクションの projection 更新へ。リポジトリ契約から `userId` 第一引数と `Promise` を落とす。`purge_after` を保存する retention（復元時に `NULL` へ戻す）を足す。`:6` の関連 ADR 行の `[ADR-005]` を差し替える（ステップ11 で一括処理してもよい）。
  - **`knowledge.md`** — 同上。`document.sourceLinksChanged` / `memo.sourceLinksChanged` の**イベント**としての定義（`:282` 付近）を、同一トランザクション内の projection 更新として書き直す。
  - **`identity.md`** — `identity.aiClientRevoked` の失効 consumer の記述とイベント定義表を削除。**`User = PasswordUser | SsoUser` の判別共用体をやめ、クレデンシャル集合として書き直す**（要素は `{ credentialId, kind, label }` の3つ組。第6.1.2節 (C5)）。`UserRepository` を「認証情報側（Directory）」と「ユーザー単位設定側（User Data DO）」の2ポートに割る。`findActiveById` を自己完結トークン前提に。`Email` の canonical 化規則を第5.2.1節へ差し替える（**長さ上限 320 と構造チェックは残す**）。`PasswordResetTokenPort.issue` の行き先が Directory であることを明記。
  - **`trash.md`** — `TrashQueryPort.listExpiredItems` を削除。`:239` の「pruner 専用の拡張ワーカーコンテナ」を削除。各 DO の Alarm による期限処理へ書き換え、`RetentionPolicy` の算出規則は維持しつつ「期限を `purge_after` に保存する」へ。**`:192` の「例: D1 上の UNION クエリ」を DO ローカルの UNION クエリへ書き換える** — この行は `listExpiredItems` だけでなく `listTrashItems` / `findTrashItem` の実装注記でもあるので、`listExpiredItems` を消すだけでは D1 の名指しが生き残る（V-2 のヒット）。
  - **`export.md`** — `ExportSourceReader.readAll`（`:264`）/ `ArchiveWriter.write`（`:275`）から `Promise` と `userId` 引数を落とす。**読み出しは DO 内の同期契約、zip エンコードは request Worker**（第4.8節・第8.3節 (a)）。`ExportRenderer.render`（`:249`）は純粋計算のまま。**このファイルは語彙走査では拾えない**（手段2 で拾われた）。
- **理由:** ドメイン層が固まらないと台帳（`spec/inventory/domain.md`）とテストケースが書けない（AC-3）。

### 8. `spec/usecases/search.md` を改訂する

- **対象ファイル:** `spec/usecases/search.md`（151 行）
- **根拠節:** 第7.1節 / 第7.3節。指示は第11.1節（`design.md:2379`）。
- **変更内容:**
  - **`maintainSearchIndex` 節（`:85-151`）をユースケースごと削除する。** `:93` の「indexer 専用の拡張ワーカーコンテナ」も一緒に消える。
  - `search` 節は残す。`:73` の「インデックス更新は非同期のため、書き込み直後の項目はヒットしない場合がある（ADR-005）」を削除し、「同期更新のため投稿直後から必ずヒットする」へ。
  - **エラーケース表（`:78-84`）に `TOPIC_NOT_FOUND`（未知・ゴミ箱内のトピック指定）の行を足す**（第7.2.1節。adr.md ADR-012）。実測で `TOPIC_NOT_FOUND` は `spec/` 全域に **0 件**の新規エラーコードであり、**ドメイン側（ステップ5）にだけ書くと usecase の契約に現れない。** `P-2` は domains / usecases を独立した2本で測る。
  - **入力 DTO の `page`（`:24`）を不透明カーソル方式へ書き換える**（第7.2.1節。adr.md ADR-012）— `page` を落として `cursor`（optional。未指定が先頭ページ）にし、**`limit`（`:25`）は方式に依らないので残す。** `:64` の `Pagination` 構築手順と `:82` の「page / limit が範囲外」も同じ読み替えを受ける。**行番号は実測で `:24` / `:25` である**（2周目レビューが `:20-21` と書いていたのは表ヘッダ行からの数え違い）。**`V-10`（`grep -nw 'page'`）が本ファイルで 0 行になること**が完了条件（着手前は `:24` / `:64` / `:82` の3行）。
  - `:3` の上流参照から「検索インデックスの維持（consumer）」への言及を外し、`[ADR-005]` を `.adr/003` / `.adr/004` へ差し替える。シナリオ参照は `S-SE-01〜03 / S-AI-02` のまま。**`:3` の「ハイブリッド検索」は「全文検索」へ置き換える** — `P-1` の本ファイルのセルは `全文検索` で測る（着手前 0 行）。**`FTS5` の語は要求しない**（tokenizer と同じ理由でユースケース層に実装語彙を置かない。adr.md ADR-015）。
- **理由:** AC-3 / AC-6b / AC-10 の起点。台帳（`UC-search-002`）とテストケースファイル削除の根拠になる。

### 9. `spec/usecases/` の残り5ファイルを改訂する

- **対象ファイル:** `spec/usecases/trash.md` / `identity.md` / `knowledge.md` / `memo.md` / `export.md`
- **根拠節:** 第7.5節 / 第8.2節（`1975-2035`）/ 第5.4.1節 (b)（失効の権威）/ 第4.8節。指示の表は第11.1節（`design.md:2380-2384`）。
- **変更内容:**
  - **`trash.md`** — `pruneExpiredTrashItems`（`:311` 以降）を Alarm 前提へ書き換え。`:315` の「pruner 専用の拡張ワーカーコンテナ」削除。`:264` の「検索インデックスからの除去・影響先の再構築は…search consumer が行う（ADR-005）」を同一トランザクションの projection 更新へ。
  - **`identity.md`** — `:10` の共通事項「イベントドラフトを `collectEvents` に渡す（Outbox に同一トランザクションでフラッシュされる）」を「**書き込みは `UnitOfWorkProvider.run` 内の同期コールバックで行う。ドメインイベントは発行しない**」へ。`:47` / `:95` / `:237` / `:280` / `:324` / `:434` / `:470` の `collectEvents(eventDrafts)` 手順を削除。`:411` の「`identity.aiClientRevoked` イベントの consumer として実行される」を「**失効の権威は `ai_client_connections.status` であり、次のリクエストの DO 内ガードが直読みする**」へ。`:150` のログアウト記述からイベントへの言及を落とす。
  - **`knowledge.md`** — `:16` の「**イベント**: … `collectEvents` に渡す（Outbox 経由。ADR-005）」を削除。`:79` / `:122` / `:268` / `:322` / `:387` / `:440` / `:493` / `:535` の `collectEvents(drafts)` 手順と `:267` / `:320` / `:534` のイベントドラフト取得を削除し、同一 UoW 内の projection 更新へ。`:321` の「イベントも発行しない」という但し書きは前提ごと消えるのでトピック touch の説明から落とす。
  - **`memo.md`** — `collectEvents(eventDrafts)` **実測7箇所**（`:51` / `:232` / `:359` / `:396` / `:434` / `:474` / `:572`。`grep -n 'collectEvents' spec/usecases/memo.md` で再現）と括弧内の「Outbox へ。search consumer が…upsert する」を削除し、「**同一 `transactionSync` の中で `search_entries` / `search_fts` の projection を更新する**」へ。`:48` / `:227` / `:354` / `:392` / `:470` の「UnitOfWork 内で」は同期コールバックの意味に読み替える。**`collectEvents` は条件付きではなく確定で消える。**
  - **`export.md`** — `:5` の「リポジトリ・UoW・ドメインイベントは登場しない」からドメインイベントへの言及を落とす。読み出しを DO 内の1回の `transactionSync` で完結させ、レンダリングと zip を request Worker で行う分割と、**1回のエクスポートで返せる総バイト数に上限があること**を足す。
- **理由:** AC-3。`collectEvents` は `spec/usecases/` に最も濃く残っており、ここを落とすと台帳・テストケースの改訂が根拠を失う。

### 10. `spec/database/index.md` を全面改訂する

- **対象ファイル:** `spec/database/index.md`（403 行）
- **根拠節:** **第4.1.1節（`524-577`）・第7.1節・第7.2節・第7.4節（`1680-1883`）・第9.1〜9.5節（`2152-2252`）・第8.4節（`2124-2141`）・第10.1節（`2255-2278`）を読む。** 追記内容の要旨は第11.1節（`design.md:2339` と `:2348`）、削除 / 置換の表は同（`:2443`）。
- **4つに分けて進める（中断・再開点の定義）。** 403 行の全面入れ替えに加えて `credential_mappings` のように第4.1.1節では1セルに数十項目が畳まれているテーブルを列の全数まで展開するため、本ステップは全体で最大である。**途中で力尽きると「削除だけ済んで追記が中途半端」（AC-2 は通るが AC-7 が通らない）という最悪の中間状態で止まる**ので、次の順で区切る。
  - **10a** 旧前提の削除と DO 一本化・冒頭参照の是正（下の「変更内容（削除）」の全項目）。**既存テーブル節の本文には手を入れず、`user_id` 列・先頭 `user_id` の複合索引・旧ランタイム前提の記述だけを落とす。**
  - **10b** User Data DO 16テーブル = **新設10テーブル（`account` / `user_settings` / `credential_locators` / `search_entries` / `jobs` / `operations` / `migration_progress` / `_meta` と `ai_client_connections` の列追加分・`search_fts` の external-content 化）の追加 + 既存節（`memos` / `memo_revisions` / `topics` / `documents` / `document_revisions` / `source_links`）の DO 見出し下への再編と `purge_after` 列の追加。** 10a で列を直したものを 10b で書き直さない — 10b が触るのは節の配置と新設分だけである。
  - **10c** Identity Directory DO 5テーブル（全部が新設。`credential_mappings` / `password_reset_tokens` / `jobs` / `rotation_checkpoints` / `_meta`）
  - **10d** FTS5 tokenizer 方針 + schema version / lazy migration + OCC の有無 + `jobs.kind` の全数表 + リレーション図・確認表の更新
  - **中間状態を検出する検査は `P-10`（テーブル名の実在検査）1本だけである。** `V-1`〜`V-10` と `P-1`〜`P-9` は 10a の削除側しか測らないので、**10b / 10c を丸ごと飛ばしても全部通る。** 10b / 10c を終えた時点で `P-10` を掛け、`TABLE-MISSING:` が 0 行になることを確認する（着手前は 10 行）。
- **書くときの語の注意:** **設計 第7.1節の「本体テーブルと同一の埋め込み SQLite に置かれる」をそのまま写さない。** `V-1` は `埋め込み` を走査語に持つので、正しい記述がベクトル残存として誤検出される。**「DO 内蔵の SQLite」「同一 DO 内の SQLite」と書く**（adr.md ADR-016）。
- **変更内容（削除）:**
  - `:3` の冒頭説明から「SQLite 系ランタイム（libSQL / D1 / Turso。**CLAUDE.md「Reference runtimes」**）」を削除し、「**Cloudflare Workers + ユーザー単位 SQLite-backed Durable Objects**（`CLAUDE.md`「Reference runtime」）」へ。**同じ行の `packages/core/src/adapters/{drizzleSqlite|d1}/schema.ts` という実装先の記述も直す**（`drizzleSqlite` は `main` 時点でも存在せず、`libsql` も PR #39 で削除済み）。
  - `:6` の関連 ADR 行の `[ADR-005]` を差し替える。
  - **全テーブルの `user_id` 列と、先頭 `user_id` の複合索引を削除する。** 論理分離の前提そのものが消える。
  - **`:12` の「D1（interactive tx なし）では `_occ_guard` の CHECK 制約でバッチ全体を abort する（テンプレート流儀）」を削除する**（OCC の条件付き更新と 0 行検出だけを残す。第8.4節）。
  - **`:16` の「D1 のバッチ実行では実行順にも依存するため」を削除する** — FK と PRAGMA の方針（一次的な担保はアプリケーション層、FK は defense-in-depth）そのものは維持し、**根拠から D1 の名指しだけを落とす。**
  - **`:33` のテーブル一覧から `| _occ_guard | 共通基盤 | D1 バッチの OCC abort 用（テンプレート流儀） |` の行を削除する。**
  - **`:35` を書き換える。この行はどの負の検証にも掛からない**（`V-1`〜`V-10` のどの語にも当たらない）。2つの宣言が同居している — (i)「trash / **search** / export ドメインは自前のテーブルを持たない（ADR-004）」は **search が `search_entries` / `search_fts` を持つようになる**ので search を外し、trash / export だけを残す（trash の射影と export の読み取り専用は変わらない。ドメイン境界そのものは変えない — ステップ6）、(ii)「セッション・OAuth トークン等の**認証インフラは本設計のスコープ外**（後述）」は `:355-357` と同じ失効した宣言なので**削除する**（認証系テーブルの記述先がこのファイルになる）。**この行を残すと AC-7 と正面から矛盾する記述がファイル内に生き残る。**
  - **`outbox` / `processed_events` / `_occ_guard` の節（`:335-344`）を全削除。**
  - **`search_embeddings`（`:350`）と `:351` の RRF / 埋め込み生成への言及、`:384` のリレーション図の `search_embeddings` を削除。**
  - `:347` の「ランタイムごとに実装を差し替え得るため、本設計では候補構成のみ規定する」と `:349` の「（libSQL / Turso / D1 いずれも利用可）」、`:353` の「選定したランタイムのアダプターのマイグレーションとして管理し」を削除（**前提そのものが失効している**）。
  - 期限切れ索引3本（`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx`）を削除。
  - **`:355-357` の「認証インフラテーブルはスコープ外」宣言を削除する**（認証系テーブルの記述先がこのファイルになる）。
- **変更内容（追記）:**
  - **設計 第4.1.1節のテーブル全数を写す。** User Data DO: `account` / `user_settings` / `credential_locators` / `ai_client_connections` / `memos` / `memo_revisions` / `topics` / `documents` / `document_revisions` / `source_links` / `search_entries` / `search_fts` / `jobs` / `operations` / `migration_progress` / `_meta`。Identity Directory DO: `credential_mappings` / `password_reset_tokens` / `jobs` / `rotation_checkpoints` / `_meta`。**認証・saga・ジョブ系は列の全数まで書く**（第4.1.1節がその正本）。
  - **`search_fts` を external-content 構成へ** — `content='search_entries'`、`content_rowid` は既定の `rowid`。`search_entries` の PK は `rowid INTEGER PRIMARY KEY`、`id TEXT` は UNIQUE 制約付きの別列。
  - **`purge_after` 列**（`memos` / `topics` / `documents`）と DO ローカルの索引。
  - **FTS5 tokenizer 方針**（第7.2節）— `tokenize='trigram'`。**1〜2文字のクエリは `instr(title, ?) > 0 OR instr(body, ?) > 0` へフォールバックし、`LIKE` / `GLOB` は採らない。** フォールバックは索引を使えない全走査なので対象列とページサイズを制限する。正規化はインデックス側・クエリ側の両方で NFKC + `trim()`、**スニペットは正規化前の原文から組み立てる**（SQL の `snippet()` / `highlight()` に依存しない）。**実環境での再検証は #37 が行い、結果を spec に反映する。**
  - **schema version / lazy migration 方針**（第9.1〜9.5節）— (i) DO ごとの `_meta.schema_version` と、**全 RPC エントリおよび `alarm()` の先頭に置く冪等なゲート関数**、(ii) **`blockConcurrencyWhile` を使わず、ゲート関数を同期実行にして input gate に排他させる**条件、(iii) **forward-only** と `migration_progress`（PK `(targetVersion, step)`）による部分適用の記録（**任意の最適化ではなく必須**）、(iv) **「コードより新しい version」への fail-closed**、(v) **データのロールバックを行わず PITR を代替手段とする方針**。分割が必要な DDL の条件（`CREATE INDEX` と CHECK 制約付き列追加・列削除はデータ量に依存する）と、`CREATE INDEX` の回避策（索引つき新テーブル → `migrate-bulk` でコピー → 参照切替 → 旧表 drop）も書く。**FTS5 の `'rebuild'` は使わず `reindex` が projection の全行再実行で行う。**
  - **OCC の `version` を持つテーブル / 持たないテーブルの区別**（第4.1.1節末尾・第8.4節）— 持つのは集約ルートのみ（`account` / `user_settings` / `ai_client_connections` / `memos` / `topics` / `documents`）。非集約ストア7つと `credential_mappings` は持たない。
  - **`jobs.kind` の全数表**（第7.4節の12種 / 第7.7節の4類型）を `jobs` テーブルの節に置く。**所有 DO クラス別（User Data DO 側 / Identity Directory DO 側）に分けて全数を書く。** 置き場が `spec/` 内に無いと、ステップ9 / 14 / 16 が名指しする `purge-trash`、ステップ10d の migration 方針が名指しする `reindex` / `migrate-bulk` が、**`spec/` を単独で読む #37 の実装者にとって dangling な語になる**（ADR-006 の「`spec/` が単独で読める」に反する）。**12種の内訳は User Data DO 側 `purge-trash` / `reindex` / `migrate-bulk` / `finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link`、Identity Directory DO 側 `send-mail` / `resume-signup` / `resume-credential-change` / `sweep-reservations` / `sweep-reset-tokens` / `rotate-encryption` である**（`rotate-remap` は Alarm ジョブではないので12種に入らない）。**同じ12種がステップ17 で `CLAUDE.md` の4類型表にも載る** — 設計 第7.7節 項2 が「4類型が12種を漏れなく1回ずつ覆う」を第1.4節 I-7 の不変条件にしており、改訂後はこれが2ファイルに分かれるので、`P-9` で両側を突き合わせる。
  - **検索のスナップショットの物理テーブル定義は書かない**（adr.md ADR-013）。第4.1.1節（テーブル全数の正本）に無いものを17番目として足すと AC-7 と矛盾する。**「不透明カーソルが指す期限付きスナップショットの物理形は #37 が決める」ことを1行だけ残す** — `jti` 一回性テーブルを #13 へ預けた形と同じで、注記が無いと `spec/domains/search.md` の「スナップショット」が `spec/` 内で dangling になる。
  - **operator 専用 maintenance 経路が存在することを1行残す。** `.thread/34/handoff.md` 第3節「残すもの（消してはならない）」の7項目のうち、`spec/` に落ちないのは**この1つだけ**である — `purge-user-mappings`（退会の最後の砦。第6.7節）と `cancel-reservation`（signup 敗北時の敗者補償。第6.4節）は `jobs.kind` の12種に入らないので、上の全数表にも現れない。ステップ10 は `jobs.terminalReason` を「一様な終端（`poison` + operator エスカレーション）」まで書くと決めているので、**注記が無いとエスカレーション先が `spec/` に一切名前を持たない。** 書くのは「この2つの operator 経路が存在する」ことと「**到達制御・監査ログ・運用手順の実体は #38**」までで、**呼び出し規約・ガードの具体には踏み込まない**（ADR-009 の線とは別次元だが、#38 の射程を先取りしない）。
  - **OAuth 2.1 の `jti` 一回性テーブルの定義が #13 へ預けられていることを1行残す。** 第4.1.1節（`573-575`）が「テーブル定義は #13 の範囲であり、本書では名前を確定させない」と明示している。**注記が無いと「User Data DO のテーブルは16で全部」と読まれ、#37 がそこで手を止める。** ステップ18 で #13 に追記する内容と対になる。
  - 「リレーション図」と「主要クエリとインデックスの対応（確認表）」を DO 前提へ更新する。
- **やってはいけないこと:** **#44（鍵ローテーションの手順）と #45（cross-DO saga の自動回収）の具体を書かない。** `rotation_checkpoints` は列と用途まで、`jobs.terminalReason` は「一様な終端（`poison` + operator エスカレーション）」までにとどめる。**`jobs.kind` の全数表も同様で、`rotate-remap` の実行主体や終端の段構成には踏み込まない**（adr.md ADR-009）。
- **理由:** AC-2 / AC-7 / AC-8。旧ランタイム前提が最も濃く残っているファイルであり、`spec/inventory/adapter.md` の生成元でもある。

### 11. `spec/adr/005` への参照を一括で差し替える（横断指示）

- **対象ファイル:** リンク6本（`spec/index.md:42` / `spec/database/index.md:6` / `spec/domains/search.md:3` / `spec/domains/knowledge.md:6` / `spec/domains/memo.md:6` / `spec/usecases/search.md:3`）と、**ステップ5〜10 の射程内にある本文中の `ADR-005` の言及**（`spec/domains/{memo,knowledge,search,index}.md` / `spec/usecases/{search,trash,knowledge}.md`）
- **本ステップの射程に入れないもの（後続ステップが処理する）:** `spec/inventory/domain.md:53`（`DOM-memo-007` の要点欄）は**ステップ12**、`spec/inventory/test.md:644`（`TC-search-022`）は**ステップ15.5**、`spec/manual-tests/search.md:128` は**ステップ16**、`spec/testcases/search/search.md:28` は**ステップ13**。**この4件はステップ11 の時点では必ず残っている**ので、下の「残っていないことを確認する」を適用してはならない（適用すると消し漏れと誤認して先に手を入れることになり、とくに `test.md` に触るとステップ15.5 の `#L` 一括更新とぶつかる）。横断ゲートは最終ゲートの `V-5` が受け持つ。
- **根拠節:** 第7.1節（supersede の根拠）。横断指示は第11.1節（`design.md:2350`）。
- **変更内容:**
  - リンク6本の指し先を **`.adr/003-sqlite-fts5-only-search.md`（根拠側）と `.adr/004-do-local-commit-and-alarm-jobs.md`（方式側）** へ差し替え、`spec/adr/005` が superseded であることを併記する。
  - **併記にファイル名 `005-search-index-via-outbox` を書かない。** 文字列 `outbox` が `V-3`（`-i`）の走査語に当たるので、`[ADR-005](../adr/005-search-index-via-outbox.md)（superseded）` の形で書くと **`V-5` は通るのに `V-3` が落ちる。** 書き方は **`spec/adr/005`（superseded。根拠側は `.adr/003`、方式側は `.adr/004`）** のように**リンクを張らないプレーンテキスト**にする。**改訂後の `spec/`（`review/` と `spec/adr/` を除く）に文字列 `005-search-index-via-outbox` を残してよいのは、次の ADR 一覧表の1行だけである。**
  - **`spec/index.md:38-43` の ADR 一覧表に `005` の superseded を反映し、`.adr/002`〜`.adr/004` への導線を足す。** **`005` の行はリンクを外さない** — ここは ADR 索引であり、リンクを消すと `spec/` から `spec/adr/005` へ到達する導線が1本も無くなる（adr.md ADR-014）。**行頭のセルは `| [005](./adr/005-search-index-via-outbox.md) |` の形をそのまま保ち、注記は2列目以降に足す。** `V-3` はこの形に一致する1行だけを射程から外すので、セルを組み替える（打ち消し線を入れる・リンクを2列目へ動かす等）と除外が外れて `V-3` が 1 行残る。
  - **ステップ5〜10 の射程内**の本文中の `ADR-005` の言及は、その文ごと消えているはずなので、**残っていないことを確認する**（残っていたら消し漏れ）。**上の「射程に入れないもの」4件はここでは数えない。**
  - **`spec/adr/005-search-index-via-outbox.md` の本文は書き換えない。** ステータス行の supersede ポインタは #34 で既に付いている。
- **理由:** AC-13。設計 第11.1節が「supersede 済みの ADR へ**無注記で**リンクしている参照は1本も残さない」と要求している。表の行の他の指示を実行しても「関連 ADR」のリンク行には触れずに済んでしまうため、独立したステップにする。

### 12. `spec/inventory/` の4台帳を改訂する（`test.md` を除く）

- **対象ファイル:** `spec/inventory/domain.md` / `usecase.md` / `adapter.md` / `frontend.md`（**`test.md` はステップ15.5 で閉じる**）
- **根拠節:** **第4.3節（`595-650`。「不要になる」判定の全数）**・第4.1.1節（新設テーブル）・第7.5節・第6.6節。指示の表は第11.1節「改訂する — 台帳」（`design.md:2431-2437`）。
- **着手前に必ず読むこと:** **第11.1節（`:2434`）の削除リストは台帳 ID だけを並べているので、リストだけを読むとスキーマ行の全削除に読める。** 第4.3節の「不要になる」判定を採るときは、**必ず同節の表の「箇所」欄を開いて、消えるのがテーブルなのか索引なのかを確かめる。** 行9 / 行16 / 行17 / 行22 / 行24 は行全体が消えて正しいが、**行18 だけは例外である**（下記）。`.thread/34/handoff.md` 第4節が警告した「正本だけを読んで適用先を書き換える」破れ方が実際に起きる箇所。
- **台帳 ID の共通規約（ステップ12・15.5 に等しく効く）:** **削除した行の ID は欠番のまま残し、後続 ID を繰り上げない。** 台帳は `DOM-{domain}-{連番}` / `UC-*` / `ADP-*` / `PAGE-*` / `TC-*` を採番順で並べているだけで、連番に意味は無い。繰り上げると **#10 / #13 が参照する ID が別の要素を指す** — たとえば下の `DOM-identity-013`〜`017` を消して詰めると、その先の `DOM-identity-018`〜`022`（`UserRepository` 5本）が 013〜017 へ、**#13 が参照する `DOM-identity-023`〜`028`（`AiClientConnectionRepository` 6本）が 018〜023 へ**ずれる。AC-14 / AC-15 は「実在する」ことしか見ないので**静かに取り違わる**（ステップ13 が `TC-*` について置いた規約と同じ理屈。adr.md ADR-011）。**新設する行は各表の末尾に append する。**
- **変更内容:**
  - **`domain.md`** — `DOM-search-005`〜`012`（`upsertMemo` / `upsertDocument` / `removeMemo` / `removeDocument` / `IndexerReadPort` 4本）を削除。`DOM-search-004` を `query` 1本・同期契約へ書き換え。`DOM-search-003`（`IndexEntry`）から埋め込み由来の記述を落とす。identity の `User` 判別共用体をクレデンシャル集合へ、trash の期限列挙を `purge_after` へ。
  - **`domain.md`（ドメインイベント行 24 件の削除）** — **「定義場所」欄が `spec/domains/*.md#ドメインイベント` の 24 行を行ごと削除する**（`DOM-identity-013`〜`017` 5件 / `DOM-memo-007`〜`012` 6件 / `DOM-knowledge-015`〜`027` 13件。実測で `grep -c '#ドメインイベント' spec/inventory/domain.md` = 24）。第7.3節は「イベントは transport としても業務表現としても残らない」と断定し、**ステップ7 が `spec/domains/{memo,knowledge,identity}.md` のイベント定義表を丸ごと削除する**ので、これらの行は定義場所を失う。**設計 第11.1節の台帳表（`design.md:2433`）はこの 24 件を挙げていない — 表の1行だけを読むと必ず取り残す**（adr.md ADR-011）。
    - **要点欄の書き換えで済ませない。** 24 行は `V-3` に全件掛かる（走査語 `ドメインイベント` が「定義場所」欄に当たる）が、`V-3` が見せるのは「この行はヒットしている」までである。要点欄とアンカーだけを直すと **24 行が定義場所を失ったまま残り**、`P-8`（見出しの実在検査）は `## ドメインイベント` の見出しが消えていれば DANGLING を出すが、ステップ7 が表だけ消して見出しを残せば 0 行のまま通る。
    - **AC-15 はこの削除を前提にしている** — ステップ18 は #13 のチェックリストから `DOM-identity-016` / `-017` を除く指示を出しているので、台帳側を消さないと「#13 からは除いたが台帳には残っている」という非対称が生まれ、受け入れ条件7 の趣旨に反する。
    - **連番は上の共通規約どおり欠番のまま残す。**
  - **`usecase.md`** — `UC-search-002`（`maintainSearchIndex`）を削除。`UC-search-001` からハイブリッド / RRF の語を落とす。`UC-trash-007`（`pruneExpiredTrashItems`）を Alarm 前提へ書き換え。**`collectEvents` を含む全行**（identity / memo / knowledge）を同期コールバックの記述へ。
  - **`adapter.md`（行ごと削除するもの）** — `ADP-search-002`〜`005`（`SearchIndexPort` の書き込み4本。第4.3節 行16）/ `ADP-search-006`〜`009`（`IndexerReadPort`。行9）/ `ADP-outbox-001` / `ADP-processed-events-001` / `ADP-occ-guard-001`（行22）/ `ADP-search-embeddings-001`（行24）/ `ADP-trash-004`（`listExpiredItems`。行17）。
  - **`adapter.md`（行は残して記述だけ差し替えるもの）** — **`ADP-search-001`（`:99`。`SearchIndexPort.query`）の要点欄を書き換える。** 現行は「キーワード + **ベクトル**を **RRF** 等で統合した単一結果を関連度順で返し、**userId 境界**…」で、**Issue 対応項目5 が名指しした3つの ID の1つ**である（残る2つ `ADP-search-embeddings-001` / `ADP-occ-guard-001` は上の行ごと削除群）。**行は残る** — `SearchIndexPort.query` は改訂後も唯一残るメソッドだからである（ADR-001）。要点を「FTS5 の全文一致を `bm25` と安定 tie-breaker で順位付けして返し、ゴミ箱除外・topic スコープ絞り込み・事実データのみの規則を満たす。0 件は空 `PaginationResult`」へ差し替え、**`userId` 境界は到達可能性の読み替え**（ステップ6）に合わせる。ドメイン側の同じ役割の行（`DOM-search-004`）と対称にする。
  - **`adapter.md`（行は残して記述だけ差し替えるもの・続き）** — **`ADP-memos-001` / `ADP-topics-001` / `ADP-documents-001` を行ごと削除してはならない。** これらは `memos` / `topics` / `documents` の**スキーマ行そのもの**であり、DO 化後も残るテーブルである。第4.3節 行18 の「箇所」欄が指しているのは **`memos_expired_idx` / `topics_expired_idx` / `docs_expired_idx` の3本と `users` との全ユーザー JOIN** であって、テーブルではない（備考も「行17 のスキーマレベルの実現手段なので**道連れになる**」と書いている）。**行は残し、期限切れ部分索引3本の記述・`user_id` 列・先頭 `user_id` の複合索引・`users` との JOIN 前提を落として `purge_after` 索引へ差し替える。** 行ごと消すと `spec/inventory/adapter.md` から主要3テーブルが消え、`purge_after` 列の追加先も台帳から失われて AC-9 / AC-14 の照合が壊れる。
  - **`adapter.md`（分裂・移動するもの）** — `ADP-identity-001` / `-002`（`insert` / `save`）を Directory 側と User Data 側に割る（行11）。`ADP-identity-003`（`findById`）も同じ2つに割る（行7c。認証情報側は `credential_mappings`、設定側は `user_settings` / `account` を読む）。**`ADP-users-001` は第4.1.1節に対応テーブルが無く、`account` / `user_settings` / `credential_mappings` / `credential_locators` へ割れる**（行1 / 行2）— 行き先を台帳に明記する。**`ADP-identity-004`（`findByEmail`）/ `-005`（`findBySsoIdentity`）は Directory へ移る**（行5 / 行6）。**`ADP-password-reset-tokens-001` は Directory へ移る**（行3 / 行19）。`ADP-identity-014` / `-015`（`issue` / `verifyAndConsume`）も Directory（行7b / 行7）。
  - **`adapter.md`（その他）** — 残る行から `userId` 第一引数と `Promise` を落とす。**`ADP-knowledge-027`（`deleteSourceLinksByMemo`）の契約から「`userId` スコープは documents 側 JOIN で行う」という規則を撤回する**（行25b）。**`ExportRenderer.render` に `ADP-*` ID を採番する**（現在は台帳から漏れている）。**第4.1.1節の新設テーブル群（`credential_mappings` / `credential_locators` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` / `_meta` / `password_reset_tokens` / `account` / `user_settings`）に対応する `ADP-*` を新設する。** `ADP-search-fts-001` は external-content 構成へ書き換え、`ADP-search-entries-001` を新設する。
  - **「定義場所」欄のアンカーを追従させる。** 台帳は `spec/database/index.md#users` / `#outbox--processed_events--_occ_guard共通基盤` / `#検索インデックスの永続化アダプター実装詳細` / `spec/domains/search.md#indexerreadport` のような**節見出し由来のアンカー**を持つ。ステップ10 が `spec/database/index.md` を DO 2部構成へ組み替えるので、**残す行のアンカーもほぼ全部が指し先を失う。** plan.md の `P-8`（アンカー実在の機械検査。着手前は 0 件）を掛けながら直す。
  - **`frontend.md`** — **`PAGE-search-001`〜`004`（`:55-58`）と `PAGE-document-edit-002`（`:50`）は削除しない**（全文検索でも記述が変わらない。この5行が AC-14 の照合対象である）。**追加するのは `PAGE-password-reset-*` と `PAGE-settings-*` の側** — リセット完了画面の必須導線（クレデンシャル一覧 + AI クライアント接続一覧 +「すべて失効」）に対応する `PAGE-password-reset-004` 相当を新設する。`PAGE-settings-005`（パスワード変更）の「SSOのみのユーザーにはフォーム自体を非表示」をクレデンシャル集合による判定へ読み替える。
  - **各台帳ヘッダの「最終同期: 2026-07-25」を改訂日へ更新する**（`test.md` はステップ15.5 で）。
- **理由:** AC-9 / AC-14。台帳は #10 / #13 の実装チェックリストの出典であり、これが固まらないとステップ18 が実行できない。**`test.md` の `#L` 更新はステップ13・14・15 のすべてが終わるまで確定しない**（15 も6ファイルにケースを追加する）ので、本ステップでは `domain` / `usecase` / `adapter` / `frontend` の4台帳だけを閉じ、`test.md` は独立したステップ15.5 に切り出す。

### 13. `spec/testcases/search/` を改訂する

- **対象ファイル:** `spec/testcases/search/maintainSearchIndex.md`（**削除**）/ `spec/testcases/search/search.md`
- **根拠節:** 第7.1節 / 第7.2節 / 第7.2.1節。指示は第11.1節（`design.md:2396-2397`）。
- **変更内容:**
  - **`maintainSearchIndex.md` をファイルごと削除する**（対象ユースケースが消滅するため。書き換え方 (C)）。
  - `search.md:12`「同一項目がキーワード検索・**ベクトル検索**の双方にヒットする」ケースを **(C) 削除**（統合対象が無い）。
  - `search.md:28`「メモを書き込んだ直後で、インデックス更新（非同期 consumer）が未完了」ケースを **(C) 削除**し、代わりに「**投稿直後の検索で必ずヒットする**」ケースを新設する。
  - **FTS5 の新しいケースを足す**（Issue 対応項目5）— (i) 3文字以上の日本語 trigram 一致、(ii) 1〜2文字の短語フォールバック、(iii) NFKC 正規化（全角 / 半角・合成済み / 結合文字列の差が響かない）、(iv) `bm25` による順位とタイトル重み付け、(v) 同点時の安定順位 `timestamp DESC, type, id`、(vi) スナップショットページングでページ間に重複・欠落が出ないこと、(vii) topic 絞り込み（未知・ゴミ箱内トピックは `TOPIC_NOT_FOUND`）、(viii) ゴミ箱除外、(ix) スニペットが原文から組み立てられること。
  - **既存の page 番号方式のケースを不透明カーソル方式へ読み替える**（第7.2.1節。adr.md ADR-012）。**放置すると改訂後の `spec/` に page 番号方式とカーソル方式が同居する。** 実測で `grep -nw 'page'` は本ファイルに **6 行**ヒットする。行ごとの扱いは次のとおり（`limit` は方式に依らないので **`:26` / `:36` / `:37` の3ケースはそのまま残す**）。
    - `:24`「`page: 1` → `page: 2` で重複しない」 — **(A) 読み替え**。まさに置き換え対象の期待値なので、「1ページ目のカーソルで2ページ目を読む」形に書き直す。**ステップ13 が足す新設ケース (vi)（ページ間に重複・欠落が出ないこと）と役割が重なるので、(vi) はこのケースの拡張として書き、二重に作らない。**
    - `:27`「`page: 5`（総件数を超えるページ）で空ページ」 — **(A) 読み替え**。「最終ページのカーソルでさらに読むと空になる」へ。
    - `:34`「`page: 0`」/ `:35`「`page: 1.5`」 — **(C) 削除**し、代わりに「**不正・期限切れのカーソルはバリデーションエラー**」を1ケース足す（page の範囲検証という概念自体が消える）。
    - `:7` / `:25` — 期待値の主題は page ではない（DTO の形 / `limit` 下限）。**`page: 1` の記述だけを落とす。**
    - 完了条件は本ファイルで `V-10` が **0 行**になること（着手前は 6 行）。
  - **既存の 500 文字境界ケース（`:23`「trim 後ちょうど 500 文字」と `:31`「trim 後 501 文字 → `KeywordTooLong`」）は維持する**（adr.md ADR-002）。**`:17` は「ゴミ箱内の項目はヒットしない」、`:25` は「`limit: 100`（上限ちょうど）」で 500 文字とは無関係である** — 守るべき行を取り違えないこと。
- **ケース追加の共通規約（ステップ13・14・15 に等しく効く）:** `spec/inventory/test.md` のヘッダは「**連番はテーブルの行順（上から下）に対応する**」と宣言している。**新設ケースは各表の末尾に append し、既存ケースの行順を入れ替えない。(C) で削除したケースの連番は欠番のまま残す。** 表の途中に挿入すると後続の `TC-{usecase}-{連番}` が別のケースを指すようになり、#10 / #13 の参照 ID が静かに取り違わる（AC-14 / AC-15 は「実在する」ことしか見ないので検出できない）。
- **理由:** AC-10。

### 14. `spec/testcases/` の残りからイベント期待を消す

- **対象ファイル:** 設計 第11.1節「改訂する — テストケース」（`design.md:2394-2428`）の表に載る全ファイル — `spec/testcases/trash/{pruneExpiredTrashItems,emptyTrash,hardDeleteTrashItem,restoreDocument,restoreMemo,restoreTopic}.md` / `spec/testcases/memo/{postMemo,post_memo,editMemo,update_memo,rollbackMemo,softDeleteMemo,delete}.md` / `spec/testcases/knowledge/{createTopic,createDocument,editDocument,editDocumentByAi,rollbackDocument,trashDocument,trashTopic,updateTopic}.md` / `spec/testcases/identity/{registerWithPassword,registerOrLoginWithSso,revokeAiClientConnection,changePassword,executePasswordReset,changeTrashRetentionDays,approveAiClientAuthorization,denyAiClientAuthorization,logout}.md`
- **根拠節:** 第7.3節（イベントは transport としても業務表現としても残らない）/ 第7.5節 / 第5.4.1節 (b) / 第6.5.1節 / 第6.2.2節 (a)。**書き換え方の指示は第11.1節の表の行ごとに違う。**
- **変更内容:** **書き換え方は3通りしかなく、どれを選ぶかは第11.1節の表が個別に指定している。一律に処理しない。**
  - **(A) イベント期待を projection の期待へ読み替える** — 「`memo.created` イベントが Outbox に記録される」→「同一トランザクションで `search_entries` / `search_fts` に該当エントリが作られる」。
  - **(B) イベント期待を落とす** — 変更履歴はリビジョンが既に持つのでそちらへ寄せる。
  - **(C) ケースごと削除する** — 対象機構が消滅する場合。
  - **競合相手の差し替え** — 「並行する pruner」は「並行する `purge-trash` ジョブ」へ。
  - **`changePassword.md` の「前進不能時の終端」ケースは #45 の境界で切る。** 設計 第11.1節（`design.md:2422`）は「`resume-credential-change` が前進不能を確定したときに **`changeState` / `changeOrigin` / `pendingVerifier` / `operationId` が `null` へ戻り**、旧パスワードでログインできる」ケースを足せと書いているが、**`.thread/34/handoff.md` は #45 の切り出しがまだ design.md に反映されていないと明言している**（第2節末尾・第3節ステップ1）。**書いてよいのは利用者から観測できる結果までである** — 「中間状態のあいだは旧新どちらのパスワードも通らない」「終端が確定して中間状態が解除されれば旧パスワードでログインできる」の2点。**どの列が `null` へ戻るかという巻き戻し手順、段の順序、原子性境界、終端モードの印、後始末失敗時の再試行上限、起点別の (i)/(ii) の使い分けは書かない**（adr.md ADR-009）。
  - **設計が明示的に「ケースを足せ」と言っている箇所**: `changePassword.md`（credential 変更 saga の中間状態 3値 / `sessionEpoch` の前進 / 濫用抑止3ケース / 前進不能時の終端 — **上の境界に従う**）、`registerOrLoginWithSso.md`（signup saga の phase 順）、`revokeAiClientConnection.md`（`:8` を **(C)** にして「`status = 'revoked'` の次のリクエストで DO 内ガードが拒否する」へ置き換え）、`changeTrashRetentionDays.md`（変更と同一トランザクションで全項目の `purge_after` を再計算し Alarm を張り直す）、`pruneExpiredTrashItems.md`（起動契機を cron から `purge-trash` ジョブへ、`listExpiredItems` を自 DO の `purge_after` 索引へ、ユーザー横断ケースを **(C)** 削除）。
- **適用結果の記録:** **30行ぶんのチェックリストを `.thread/35/step14-checklist.md` に作り、ファイル・行・設計の指定（(A)/(B)/(C)）・実際に適用したもの・`spec/inventory/test.md` 側の要点欄も直したか、を1行ずつ埋める。** 「(A) にすべき行を (B) で処理した」（= projection の期待が抜けた）は V-3 では絶対に落ちないので、これが唯一の防御になる。**最後の列はステップ15.5 の入力である** — (A) / (B) で生き残ったケースにも台帳側に `Outbox` / `pruner` を持つ要点欄が実測で7件ある（`spec/inventory/test.md` の `:138` `TC-registerWithPassword-001` / `:165` `TC-revokeAiClientConnection-002` / `:396` `TC-delete-002` / `:503` `TC-postMemo-003` / `:516` `TC-post_memo-003` / `:569` `TC-softDeleteMemo-002` / `:754` `TC-restoreDocument-032`）。
- **ケース追加の共通規約:** ステップ13 の「新設ケースは表の末尾に append する」に従う。
- **理由:** AC-3。イベントを期待値に持つケースは全件が対象になるが、一律 (C) にすると業務上意味のある正常系まで消える。

### 15. 手段4 でのみ拾える9ファイルを改訂する

- **対象ファイル:** `spec/testcases/identity/requestPasswordReset.md` / `loginWithPassword.md` / `getCurrentUser.md` / `listAiClientConnections.md` / `spec/testcases/export/exportAllData.md` / `spec/testcases/trash/listTrash.md` / `spec/scenario/account.md` / `spec/manual-tests/account.md` / `spec/inventory/frontend.md`
- **根拠節:** 第7.6節（`1903-1933`）/ 第5.3節（`908-941`）/ 第6.6節 / 第5.4節 / 第4.8節 / 第7.5節 / 第5.2.1節 (a) / 第6.3節 / 第6.2.2節。**指示の表は第11.1節「改訂する — 手段4 でのみ拾えたもの」（`design.md:2453-2468`）で、9行それぞれに具体的な期待値の書き方が指定されている。**
- **3つに分けて進める（中断・再開点の定義）。** 本ステップは9ファイル・6ファイルへのケース追加・562行の手順書書き換えを含み、計画自身が【最大リスク】と呼び、`P-7` の10本すべての充足責任を負う。**ここで力尽きると `P-7` が半分だけヒットする状態で止まり、AC-16 / AC-19 のどちらも判定不能になる**ので、`P-7` の各行と1対1に対応する形で次のとおり区切る。
  - **15a** `spec/testcases/identity/{requestPasswordReset,loginWithPassword,getCurrentUser,listAiClientConnections}.md`（`P-7` の第1〜5行）
  - **15b** `spec/testcases/export/exportAllData.md` / `spec/testcases/trash/listTrash.md`（`P-7` の第6・第9行）
  - **15c** `spec/scenario/account.md` → `spec/manual-tests/account.md` の順（`P-7` の第7・第8行。scenario を先に固めないと手順書が書けない）
  - `spec/inventory/frontend.md`（`P-7` の第10行）はステップ12 で処理済みなので本ステップでは触らない。
- **変更内容（要点のみ。詳細は第11.1節の表の当該行を読む）:**
  - **`requestPasswordReset.md`** — 期待値を「**登録済み / 未登録 / SSO のみ / スロットル中の4ケースで処理経路が完全に一致する**（同じ `transactionSync` でジョブ行を1行書き、同じ `setAlarm` を発行し、同じ応答を返す。違うのは行の中身だけ）」へ。**「SSO のみ」は送らない側**で、判定は「mapping の有無」ではなく「`passwordVerifier` の有無」。`operationKey` による連打の収束、ジョブ行に載るのは `tokenId` だけ（生トークンは載らない）、新トークンの発行が未使用トークンを全部置き換えることをケースに足す。
  - **`loginWithPassword.md`** — 6ケースを足す（到達性検査 / `credentialVersion` 不一致 / `changeState` が `null` でない間のダミー材料 / `nextAttemptAllowedAt` 未到達 / step 7 の報告 / 鍵ローテーション中の両世代並存）。「同一メールの `SsoUser`」ケースをクレデンシャル集合へ読み替える。
  - **`getCurrentUser.md`** — `authMethod` を**保有クレデンシャルの種別集合**（要素は `{ credentialId, kind, label }` の3つ組）へ読み替え。**一覧には `kind = 'email'` も出すが解除操作を出してよいのは `kind = 'sso'` だけ。** `email` の取得が第6.2.1節 (c) の復号許可経路 (4) に当たることを明記し、`provider` / `providerSubject` を返さない期待は維持。
  - **`listAiClientConnections.md`** — リセット完了による自動失効ケースを足す（`createdAtResetVersion` 基準。**変更を挟んでも失効すること**と、通常のパスワード変更では失効しないことも）。
  - **`exportAllData.md`** — 上限超過で `SystemError` 系になるケースを足す。読み出しが DO 内の1回の `transactionSync`、render / zip が request Worker であることを前提の欄に明記。
  - **`listTrash.md`** — `:16` / `:17` の `expiresAt` の**根拠**を「照会時算出・遡及適用」から「**変更と同一トランザクションで全項目の `purge_after` が再計算され Alarm が張り直される**」へ差し替える（結果は変わらない）。`:19` の「他ユーザーのゴミ箱」を到達可能性の読み替えへ。
  - **`spec/scenario/account.md`** — S-AC-01 に「メールアドレスの所有確認を行わない」を既知の前提として明記。S-AC-02 に Directory bucket 2つを跨ぐ予約の異常系を反映。S-AC-07 のリセット完了に必須導線2つを足す。「SSO のみのユーザーにパスワード変更を出さない」をクレデンシャル集合の判定へ。
  - **`spec/manual-tests/account.md`（562行）** — 上の scenario の変更を手順へ落とす。ロックアウトの再現と2本の脱出経路、リセット完了後の直近世代 AI クライアント接続の失効、リセット完了画面の必須導線、TC-29 の対象外理由を「応答も処理経路も同一なので UI からは区別できない」へ差し替え。
  - **`spec/inventory/frontend.md`** — ステップ12 で処理済み。
- **ケース追加の共通規約:** ステップ13 の「新設ケースは表の末尾に append する」に従う。**このステップは `spec/testcases/identity/{requestPasswordReset,loginWithPassword,getCurrentUser,listAiClientConnections}.md` / `export/exportAllData.md` / `trash/listTrash.md` の6ファイルの行を増やす**ので、`spec/inventory/test.md` の `#L` 往復対象に含まれる（ステップ15.5）。
- **検証:** 完了後に plan.md の `P-7` を実行し、全行がヒットすることを確認する（AC-19）。**着手前はすべて 0 行**なので、0 行のまま残っていればこのステップが実行されていない。**第8行（`spec/manual-tests/account.md`）は `ロックアウト`、第9行（`spec/testcases/export/exportAllData.md`）は `上限|transactionSync` で測る** — どちらも上の指示に実際に現れる語である（3周目レビューまで `所有確認|verification` / `総バイト` を要求していたが、前者は scenario 側の指示（第7行）、後者はステップの文言と一致しない語だった。adr.md ADR-015）。
- **理由:** **【最大リスク】このステップを飛ばすと AC-16 / AC-19 が満たせない。** 9件はいずれも本設計が**足した**振る舞いに触れているため、旧語彙の grep には1件もヒットしない。

### 15.5. `spec/inventory/test.md` を閉じる

- **対象ファイル:** `spec/inventory/test.md`（779 行）
- **担当範囲（ここで一箇所に定義する）:** **`spec/inventory/test.md` を触るステップは本ステップだけである。** ステップ11（`ADR-005` の一括差し替え）・ステップ12（4台帳）はこのファイルを射程に含めない。したがって本ステップは**このファイルの完了ゲート全部**を負う — 行の出入り（削除 / 新設 / 採番）だけでなく、**`V-1`（実測 2 行）/ `V-3`（実測 35 行。全ファイル中で最多）/ `V-4`（実測 12 行）/ `V-5`（`:644` の `TC-search-022`）を 0 にするところまで**が担当範囲である。AC-1 / AC-3 / AC-6 / AC-9 の対応ステップ欄に 15.5 が入っているのはこの意味である。
- **根拠節:** 第11.1節「改訂する — 台帳」（`design.md:2436`）+ ステップ13・14・15 の実施結果。
- **変更内容:**
  - `TC-maintainSearchIndex-*` **28件**を削除。`TC-pruneExpiredTrashItems-*` **17件**を Alarm 前提へ書き換え。
  - **ステップ13・14 で (C) にした個別ケース**を台帳からも落とす（連番は欠番のまま残す。ステップ12 の「台帳 ID の共通規約」）。
  - **(A) / (B) で生き残ったケースの「要点」欄も同期する。** 行の出入りだけを扱うステップではない。実測で `TC-maintainSearchIndex-*` / `TC-pruneExpiredTrashItems-*` 以外に `V-3` を持つ行が **7 件**ある — `:138` `TC-registerWithPassword-001`（「`userRegistered` イベントが同一 TX で **Outbox** に記録されれば PASS」）/ `:165` `TC-revokeAiClientConnection-002`（ステップ14 で (C)）/ `:396` `TC-delete-002` / `:503` `TC-postMemo-003` / `:516` `TC-post_memo-003` / `:569` `TC-softDeleteMemo-002` / `:754` `TC-restoreDocument-032`（「**pruner** 等との並行競合」）。**照合の入力は `.thread/35/step14-checklist.md` の最終列である。**
  - **ステップ13・14・15 で新設したケース全件に `TC-*` を採番して行を追加する。** 対象は、ステップ13 の FTS5 新ケース9系統 +「投稿直後に必ずヒットする」、ステップ14 の `changePassword`（中間状態3値 / `sessionEpoch` / 濫用抑止3件 / 終端）・`registerOrLoginWithSso`・`revokeAiClientConnection` の置き換え・`changeTrashRetentionDays`、ステップ15 の `loginWithPassword` 6ケース・`requestPasswordReset` の均一化と `operationKey` 収束・`listAiClientConnections` の自動失効・`exportAllData` の上限超過。**台帳の不変条件は「`spec/testcases/{path}#L{n}` が実在する ⇔ 台帳に行がある」の双方向**であり、削除だけ反映すると片側が崩れる。**新 ID はステップ18（#10 / #13 のチェックリスト）の入力でもある。**
  - **`#L{行番号}` を改訂後の実際の行へ更新する**（ステップ13・14・15 で行を触ったすべてのファイルが対象）。
  - ヘッダの「最終同期: 2026-07-25」を改訂日へ更新する。
- **検証:** 「新設ケース数 = `test.md` の追加行数」を突き合わせる。plan.md の `P-8`（アンカー実在検査）が 0 行であること。**本ファイル単体で `V-1` / `V-3` / `V-4` / `V-5` を掛けて 0 行**であること。
- **理由:** AC-1 / AC-3 / AC-6 / AC-9。**`#L` はステップ15 の行追加まで確定しない**ので、ステップ12 から切り出して 13・14・15 のあとに置く。ここを 12 の中に残すと、15 の6ファイルの行増加が台帳へ届かない。

### 16. `spec/manual-tests/` を改訂する

- **対象ファイル:** `spec/manual-tests/search.md` / `ai.md` / `document.md` / `trash.md` / `timeline.md` / `settings.md`（`account.md` はステップ15 で処理済み）
- **根拠節:** 第7.1節 / 第7.5節。指示の表は第11.1節（`design.md:2445-2450`）。代替手段の実体は第11.3節（#38）。
- **着手前に:** **対象ファイルごとに plan.md の V-1〜V-3 を掛けてから着手する。** 設計 第11.1節の表に挙がっていない残骸が実在する（下の `search.md:247` がその例）。最終ゲートでは捕まるが、ここで拾えば手戻りが減る。
- **変更内容:**
  - **`search.md`** — `:17` の環境前提「検索インデックス更新用のワーカー（非同期 consumer）が起動している」を**削除**（consumer は存在しない）。`:5` の「ハイブリッド検索」を全文検索へ。`:69` の「キーワード検索・ベクトル検索の統合結果が単一リストになっている」確認項目を削除。`:266` のカバレッジ表の同趣旨の行を書き換え。**TC-07「投稿直後のメモが非同期インデックス反映後にヒットする」を「投稿直後のメモが即座にヒットする」へ反転する。** `:128` の「（ADR-005）」を削除。**`:247` の「（maintainSearchIndex は worker 内部処理のため UI からの直接検証対象外。非同期反映の振る舞いは TC-07・TC-11・TC-12 で間接的に検証する）」も書き換える** — 設計 第11.1節の当該行はこの行を挙げていないが、V-3 にヒットする残骸である。**FTS5 の新しい確認項目**（日本語 trigram / 短語 / 順位 / スニペットが原文であること）を足す。**確認項目の見出しか前提に `FTS5` の語を含める** — `P-1` は本ファイルのセルを `FTS5` で測る（着手前 0 行）。**500 文字境界の TC-15 / TC-16 は維持する。**
    - **FTS5 の確認項目は独立した新規 `TC-NN` として足し、足した数をステップ16.5 へ申し送る。** 「既存 TC の確認ポイントとして足して件数を動かさない」という逃げ道は **adr.md ADR-010 が明示的に却下している**（件数を固定するために表現を歪めることになり、FTS5 の確認項目は独立した TC のほうが実行しやすい）。**新規 `TC-NN` を足すと `spec/manual-tests/index.md` の件数表（検索 17 / 合計 192）が嘘になる**ので、ステップ16.5 が数え直す。
  - **`ai.md`** — `:50`「AI の search（**ハイブリッド検索**）が…」→「AI の search（全文検索）が…」。
  - **`document.md`** — `:25`「検索インデックス更新ワーカーが起動していること。インデックス反映は非同期のため…1〜2分待つ」と `:131` の同趣旨を**待ち時間の指示ごと削除**する。**語彙走査では拾えなかったファイルである**（「consumer」ではなく「ワーカー」と書かれている）。
  - **`trash.md`** — `pruner` は実測で **`:18` / `:204` / `:212` / `:218` / `:351` の5行**にある。すべて **Alarm の強制発火に相当する手段**へ置き換える（`:218`「DB更新・pruner手動起動ができない環境では、本ケースの手順4〜6は対象外とし…」が漏れやすい）。`:211` / `:335` / `:348` の「テスト環境の DB で `trashedAt` を直接更新できること」は共有 DB が無くなるので成立しない（`wrangler d1 execute` 相当も不可）。**時計の巻き戻しに相当する手段**へ置き換える。**`:18` と `:218` は1行に2つの前提が同居している** — `:18` は「pruner ワーカーを手動起動できること、**または**テスト環境の DB で `trashedAt` を直接更新できること」、`:218` は「DB更新・pruner手動起動ができない環境では…」であり、**pruner 群と DB 直接更新群の両方の書き換えを受ける。** これで `V-2c` の「テスト環境の DB」4行（`:18` / `:211` / `:335` / `:348`）と指示が1対1に対応する。
  - **`timeline.md`** — `:29-33` の「テスト環境の DB を直接更新」手順（`UPDATE memos SET posted_at = ...`）を、**ユーザー単位 DO 内の SQLite に対する手段**（DO 単位のシード投入、または開発用の RPC）へ置き換える。
  - **`settings.md`** — `:37-44` / `:93` の同趣旨の DB 直接更新手順を同上へ。**語彙走査では拾えなかったファイルである。**
  - **代替手段の具体的なコマンドは書かない。** 実体は #38（第11.3節）なので、「Alarm の強制発火に相当する手段（実体は #38 で定める）」までにとどめる。
- **理由:** AC-11。マニュアルテストの「環境前提」は語彙走査に掛からない手段の前提なので、手段3 で拾われた2件（`document.md` / `settings.md`）を落としやすい。

### 16.5. 目次・件数を同期する

- **対象ファイル:** `spec/index.md` / `spec/manual-tests/index.md`
- **根拠:** Issue 対応項目5「設計から自動生成・転記された全参照を検索し…残存を解消する」。**設計 第11.1節は `spec/manual-tests/index.md` を「影響なし」（`design.md:2487`）と判定しているが、その理由は「件数表と推奨実行順序だけを持つ。手順の実体は各ファイルにあり、そちらで改訂される」であり、件数が動かないことを前提にしている。** 本 Issue 自身の編集で件数が動くため、判定を上書きする（adr.md ADR-010）。
- **変更内容:**
  - **`spec/index.md`** — 本 Issue の編集で嘘になる転記数値を数え直す。`:15`「52ユースケース・約750ケース」（ステップ8 で `maintainSearchIndex` が消えて 51。ケース数はステップ13〜15 で増減）/ `:16`「7カテゴリ・192ケース」/ `:24`「6ドメイン・52ユースケース」/ **`:25`「DB設計（SQLite系・9テーブル＋共通基盤）」→「DB設計（SQLite-backed Durable Objects・User Data 16 + Identity Directory 5 テーブル）」**（ステップ10）/ `:26`「52ユースケース・約750ケース」/ `:27`「192ケース」。
  - **`spec/manual-tests/index.md`** — `:15-22` のカテゴリ別件数表（正常系 / 異常系 / 境界値の内訳を含む）と `:22` の合計行、および実行記録欄の分母（`/192件 PASS`）を数え直す。
  - **これらは V-1〜V-8 のどの語にも掛からない**（「SQLite系」「9テーブル」は走査語ではない）。**AC-18 の grep で機械検査する。**
- **検証:** plan.md「目次・件数の同期（AC-18）」のコマンドを実行する。`grep -n '9テーブル\|SQLite系\|52ユースケース\|192ケース\|約750ケース' spec/index.md` が 0 行（着手前は 6 行）。件数表の各行と合計が `grep -cE '^#+ TC-[0-9]+' spec/manual-tests/{各}.md` の実測と一致すること。
- **理由:** AC-18。`spec/` のトップページと目次に、AC-7 と正面から矛盾する数値が残るのを防ぐ。**すべての `spec/` 編集が終わったあとでしか数えられない**ので、ステップ16 の直後・CLAUDE.md（17）の前に置く。

### 17. `CLAUDE.md` を改訂する

- **対象ファイル:** `CLAUDE.md`
- **根拠節:** **第7.7節（`1934-1958`）を正文としてそのまま写す。** 加えて第8.2節（`1975-2035`）/ 第8.2.1節（`2036-2071`）/ 第8.4節（`2124-2141`）/ 第2.1節 F-17 / 第4.4節。指示は第11.1節（`design.md:2451`）。
- **変更内容:**
  - **「Key concepts」の Outbox / domain events の項全体を削除し、第7.7節の7項目を写す** — (1) ドメインイベントという transport は存在しない、(2) 外部 I/O を伴う処理は必ず永続ジョブに載せる（**ただし「載るのは外部 I/O だけ」と書いてはならない**。期限処理・チェックポイント分割を要する一括処理・cross-DO saga の前進も同じ `jobs` と Alarm で駆動する）、(3) ジョブ実行は at-least-once で実装は冪等でなければならない、(4) ジョブ間に順序保証は無い（**種別の異なるジョブの相対順序に依存する設計を書かない**）、(5) リトライはジョブランナーが持ちプラットフォームには委ねない（`alarm()` から throw しない。これが `worker → root` で許されている唯一の広い catch）、(6) OCC 競合は再試行しない、(7) リクエスト跨ぎの冪等キーをクライアントに持たせない。
    - **項2 の4類型表は `kind` の名前ごと写す。** 設計 第7.7節 項2 は「**4類型が第7.4節の12種を漏れなく1回ずつ覆う**」を第1.4節 I-7 の機械検査つき不変条件にしている。改訂後はこの不変条件が `CLAUDE.md`（4類型）と `spec/database/index.md`（`kind` 全数表。ステップ10d）に**分かれる**ので、両側に同じ12種が載っていることを `P-9` で押さえる（着手前は 12 行の `KIND-MISSING:`、完了時は 0 行）。**#37 が `kind` を足したときの取り残しはこの1本で防ぐ。**
  - **「Key concepts」の Unit of Work の項を第8.2節の同期契約へ** — `run` は完全同期（戻り値型 `T extends Promise<unknown> ? never : T` で `async` を型排除する）、スコープ引数を取らない（DO そのものがスコープ）、`collectEvents` の位置は `enqueueJob` / `recordOperation` / `updateOperation` / `setMigrationCursor` が引き継ぐ、`UnitOfWorkContext` に非同期ポートを載せない、`run` の中で `run` を呼ばない。
    - **現行の「the only path to enqueue domain events」を置き換える以上、「唯一の経路」の全数を落とさない。** 第8.2節（`2023-2025`）は**非集約ストアへの書き込み口の全数は (ii) と (iii) である**と断定し、初版が3ストアしか覆えていなかったことを名指しで訂正している。**(ii) の `credentialLocatorStore` / `resetTokenStore` / `rotationCheckpointStore` を落とすと同じ誤りを再生産する**（7ストアのうち6つが口を持ち、`_meta` だけが持たない）。
  - **「Key concepts」の Retry strategy から D1 固有の記述を削除する。** `SQLITE_BUSY` / `SQLITE_LOCKED` と D1 binding への言及、`packages/core/src/adapters/d1/unitOfWork.ts` の名指しを外し、**OCC 非リトライの方針（アプリケーション層の OCC リトライデコレーターを置かない）はそのまま維持する**（第7.7節 項6 が明示的に「`CLAUDE.md`「Retry strategy」の方針をそのまま維持する」と書いている）。
  - **「Reference runtime」から「To target a different runtime … the inward layers stay put」「`domain` / `application` / `presentation` stay intact across such a swap」という明言を削除する。** 第8.2.1節が「これは実際に破れる」と名指ししているため。代わりに **`.adr/002` が受け入れた Cloudflare へのロックインの具体的な現れ方**（ドメイン層のポート契約が同期に変わり、非同期 I/O を前提とするランタイムでは実装できなくなる）を書く。**節名は `## Reference runtime`（単数形）のまま維持する**（PR #39 の変更を戻さない）。
  - **DB 制約の記述を第2.1節 F-17 と第4.4節へ**（DO の SQLite 制約と 10 GB の上限）。
  - **移行中であることの注記を1箇所に集約する**（adr.md ADR-005 の判断）。実体は #37 が入るまで D1 + Queues のままなので、規則を新構成で断定したうえで「実装の移行は #37」を明記する。
  - **「Reference runtime」のエントリポイント一覧（`apps/web/app/worker/cloudflare/{relay,consumer,pruner,dlq}.ts`）は残す。** #37 が入るまで実在するファイルであり、`CLAUDE.md` の現況記述としてまだ正しい。**集約した移行注記から「この4本は #37 で消える」ことを指す**形にして、一覧そのものは書き換えない。
- **やってはいけないこと:** **`pnpm dev` / `pnpm start` / `pnpm preview` と #40 の記述を消さない**（本 Issue と無関係の現況記述であり、まだ有効。#40 の段落は `eventRelayWorker.ts` を名指しする）。
- **検証:** plan.md の `V-9` を実行する。**射程は節に限定する**（`sed -n '/^## Key concepts/,/^## Error handling/p'`）— 全文 grep は使えない。上の2点で `relay` / `pruner` / `eventRelayWorker.ts` が `CLAUDE.md` に**正しく**残るためである。着手前は 2 行（`:69` の Outbox 項・`:70` の `SQLITE_BUSY` / `adapters/d1`）、完了時は 0 行。
- **理由:** AC-12。Issue 対応項目6 が「実装の撤去は後続 Issue だが、ルールとしての記述は本 Issue で確定させる」と要求している。

### 18. Issue #10 / #13 の実装チェックリストを台帳と一致させる

- **対象ファイル:** GitHub Issue #10 / #13 の本文（`gh issue edit`）
- **根拠節:** 第11.1節の受け入れ条件7 の行（`design.md:2331`）と #13 への追加指示（`:2333`）。
- **変更内容:**
  - **#10 のチェックリストの ID をすべて改訂後の `spec/inventory/` の実在 ID へ置き換える。** 現状は体系が違う（`DOM-SEARCH-001` / `ADP-UD-001` / `TEST-DO-004` / `TEST-MAN-002` / `UC-SEARCH-001`）。台帳は `DOM-search-*` / `UC-search-*` / `ADP-*` / `PAGE-search-*` / `TC-*` を使う。**一致しているのは `PAGE-search-001`〜`004`（+ `PAGE-document-edit-002`）の5行だけである。**
  - **#10 の `DOM-SEARCH-004 SearchProjectionPort` を削除する**（設計 第7.1節に存在しないポート。adr.md ADR-001）。
  - **#10 の「UTF-8 50-byte」「50-byte guard」を 500 文字へ訂正する**（adr.md ADR-002）。
  - **#13 のチェックリストから `DOM-identity-016` / `DOM-identity-017`（`identity.aiClientConnected` / `aiClientRevoked` イベント）と `TC-revokeAiClientConnection-002`（失効イベントでのトークン削除）を除く**（第7.3節でイベント transport と失効 consumer が消えるため）。**代わりに「`status = 'revoked'` の次のリクエストで DO 内ガードが拒否する」に対応する `TC-*` を入れる。**
  - **#13 に OAuth 2.1 の認可コード / PKCE / `jti` 一回性テーブルが User Data DO に置かれること**を追記する（第4.1.1節・第5.4.1節。**#12 ではなく #13 の範囲である**）。認可コードのペイロードに `redirectUri` を載せて署名し、token エンドポイントで完全一致を検証する。
- **理由:** AC-14 / AC-15。**必ず最後に行う** — 台帳が固まる前に編集すると二度手間になり、外部副作用（Issue 本文の書き換え）なのでやり直しが目立つ。

### 19. 完了ゲートを通す

- **対象ファイル:** なし（検証のみ）
- **変更内容:** plan.md「テスト方針」の grep バッテリーを全件実行する。
  1. **負の検証 V-1〜V-10（V-2c を含む）** — すべて 0 行。**V-5 は「無注記の参照が 0 行」を測る形なので、`ADR-005` の文字列自体は6本の参照に併記として正しく残る。** **V-3 は `spec/index.md` の ADR 一覧表の `005` 行1行だけを射程から外した形で実行する**（adr.md ADR-014。除外前の着手前ベースラインは 297、除外後は 296）。
  2. **正の検証 P-1〜P-11** — P-1〜P-7 と P-11 はすべてヒットする（**P-1 / P-2 はファイルごとに数え、全ファイルが 1 以上**であること。束ねた形では着手前から通ってしまう。**P-11 の `検索方式の選択をAIに委ねない` は「残っていること」を測る唯一の検査**である）。**P-8 / P-9 / P-10 は 0 行**（P-8 はアンカーの実在検査なのでヒット = dangling、P-9 は `KIND-MISSING:`、**P-10 は `TABLE-MISSING:` の検出で、ステップ10b / 10c の追記が中途半端なまま止まっていないかを測る唯一の検査である**）。
  3. **カバレッジ再走査** — `spec/` の非 review Markdown が **100 件**（着手前 101 から `maintainSearchIndex.md` の削除1件を引いた数）で、`.thread/35/coverage.md` に判定の付いていないファイルが無い（`NO-VERDICT:` が 0 行）。**判定の内訳は改訂対象73件 / 影響なし28件**（設計の 72 / 29 から `spec/manual-tests/index.md` を1件移した数。ADR-010）。
  4. **目次・件数の同期（AC-18）** — `spec/index.md` の転記数値 grep が 0 行。`spec/manual-tests/index.md` の件数表・合計・実行記録の分母が実測と一致。
  5. **#10 / #13 の ID 照合** — `MISSING:` が 0 行。
  6. **機械ゲート** — `pnpm lint` / `pnpm format:check` が exit 0。`git diff --name-status main...HEAD` が `spec/**/*.md` / `CLAUDE.md` / `.thread/35/**` 以外を含まない。
  7. **目視レビュー** — ステップ15 の9ファイル（`P-7` の裏づけつき）、`.thread/35/step14-checklist.md` の30行が全件埋まっていること（**最終列「台帳の要点欄も直したか」を含む**）、`spec/inventory/test.md` の `#L` 抜き取り10件、`spec/domains/search.md` の残った節が削った節を参照していないこと。
- **結果を PR 本文に貼る。**
- **理由:** AC-1〜AC-3 / AC-16 / AC-17 / AC-18 / AC-19。「旧前提が残っていない」は目視では保証できない。
