# レビュー 005 — 引き継ぎ性・成果物制約・ドキュメント品質

**対象:** PR #43（`issue/34/do-boundary-design`）/ Issue #34
**観点:** 後続 Issue（#35 / #37 / #38）への引き継ぎ性、成果物制約、ドキュメント品質
**方法:** ゼロベース。Issue #34 / #35 / #37 / #38 本文の全受け入れ条件照合、`.thread/34/design.md` 全文（1,975行）通読、`.adr/002〜004` / `spec/adr/005` / `.thread/1/adr.md` の差分検証、`.thread/34/testing.md` の機械検証手順17件を**実行**、および設計本文が主張する件数・パス・行番号の**実測突き合わせ**。

## 検証の結果（要約）

| 区分 | 結果 |
|---|---|
| 成果物制約（`.adr/` 3件 / `spec/adr/` 新規なし / `.thread/1/adr.md` / コード不変） | **すべて適合** |
| `.thread/34/testing.md` の機械検証17項目 | **17件すべて期待どおり** |
| 第11.1節の走査カバレッジ主張 | **実測と完全一致** |
| 節番号参照・パス参照・行番号引用 | **全件実在** |
| 第4.1.1節 ↔ 第5〜9章の整合 | **矛盾なし** |
| #35 の受け入れ条件7項目 / #37 の受け入れ条件13項目 | **すべて着手可能** |

---

### 引き継ぎ性・成果物制約・ドキュメント品質

#### Blockers

なし。

#### Warnings

- **[W-001]** 第1.1節の「実参照は31節ある」「実参照は14節ある」が実測と合わない
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:15`（#35 / 31節）、同 `:17`（#38 / 14節）。同じ「31節」は `:695` からも引用されている
  - 理由: 第11.1節が実際に参照している節は **41節**（`第10.1節` / `第11.3節` を含む distinct な `第N.M節`）、第11.3節は **19節**である。31 / 14 はいずれも改訂前の値のまま残っており、**この文書自身が「件数を書き換えるときは台帳を再走査する」（第4.3節末尾）「件数を書き換えるときは第11.4節の表を数え直す」（第11.2節）という規律を他の箇所では守っている**ので、ここだけ実測と外れているのは非対称である。#35 / #38 の着手を止めはしない（同じ文で「個別列挙は古びる」と断り、必ず要る節を名指ししているため）が、数字が実測であるという読み手の期待は裏切る
  - 再現:
    ```bash
    awk '/^### 11\.1/{f=1} /^### 11\.2/{f=0} f' .thread/34/design.md \
      | grep -ohE '第[0-9]+(\.[0-9]+)*節' | sort -u | wc -l   # => 41
    awk '/^### 11\.3/{f=1} /^### 11\.4/{f=0} f' .thread/34/design.md \
      | grep -ohE '第[0-9]+(\.[0-9]+)*節' | sort -u | wc -l   # => 19
    ```
  - 提案: 41 / 19 に直すか、そもそも数字を落として「起点の各行が指す節をすべて辿る」だけにする（この文の趣旨は件数ではなく「列挙しない」ことなので、数字を持たないほうが古びない）

- **[W-002]** `testing.md` の実測注記2件が現物と食い違う（改訂で design.md / adr.md が伸びた分が反映されていない）
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/testing.md:236`（確認項目7 手順4「走査時点の実測 864行」）、同 `:475`（確認項目16「実測 87件 / ADR-020〜ADR-087」）
  - 理由: 実行結果は前者が **906行**、後者が **95件**（`ADR-020` 以降は76件）である。**合否判定そのものは通る**（前者の判定条件は「0でない値」、後者は「19件から増えている」）が、testing.md は他の実測値（`.adr/` 42/38/42行 / PII 節15行 / ADP 85件 / `comm` 6件 / 判定なし0件 / design.md→`.adr/` 20行 など）をすべて現物と一致させているので、この2件だけ古いまま残っている。エッジケース1 が「実測と合わないときは commit 漏れを疑え」と指示しているため、値の乖離は誤ったデバッグを誘発しうる
  - 再現:
    ```bash
    awk '/^## 4\./,/^## 7\./' .thread/34/design.md | wc -l          # => 906（注記は 864）
    grep -cE '^## ADR-[0-9]{3}' .thread/34/adr.md                   # => 95（注記は 87）
    ```
  - 提案: 906 / 95 に更新する。または実測値を括弧書きから落として判定条件（「0でない値」「19件から増えている」）だけを残す

- **[W-003]** #35 の対応項目4（`spec/adr/005` の**参照側**の更新）について、6箇所のうち2箇所しか改訂指示が無い
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:1799`（`spec/database/index.md` の行 — 「冒頭の `spec/adr/005-search-index-via-outbox.md` への参照を `.adr/003` / `.adr/004` へ差し替え」）と `:1800`（`spec/index.md` の行）。指示が無いのは `:1723`（`spec/domains/search.md`）/ `:1725`（`spec/domains/memo.md`）/ `:1726`（`spec/domains/knowledge.md`）/ `:1735`（`spec/usecases/search.md`）の4行
  - 理由: `spec/` 内で `005-search-index-via-outbox` を参照しているのは実測6箇所で、`testing.md:596-601` 自身がその6本を列挙している。ところが design.md 第11.1節の改訂表は、そのうち `spec/database/index.md` と `spec/index.md` の2本にしかポインタ差し替えを書いていない。残る4本（`spec/domains/memo.md:6` / `spec/domains/knowledge.md:6` の「関連 ADR」行、`spec/usecases/search.md:3` の上流参照、`spec/domains/search.md:3` の「インデックス更新は Outbox 経由の consumer が非同期で行う（[ADR-005]）」）は、#35 の**対応項目4**が「ADR 本文は書き換えず、参照側を更新する」と名指ししている対象そのものである。とくに `spec/domains/memo.md:6` / `spec/domains/knowledge.md:6` は「関連 ADR」のリンク列挙であり、当該ファイルの他の改訂指示（イベント定義表の削除・リポジトリ契約の同期化）を実行しても**この行には触れずに済んでしまう**。#35 は手を止めないが、supersede 済み ADR への無注記リンクが2本残る
  - 再現:
    ```bash
    grep -rn '005-search-index-via-outbox' spec --include='*.md' | grep -v '^spec/adr/005'   # => 6行
    ```
  - 提案: `spec/domains/memo.md` / `spec/domains/knowledge.md` / `spec/usecases/search.md` / `spec/domains/search.md` の各行の「追加・置換する記述」欄に「関連 ADR / 上流参照の `ADR-005` を `.adr/003` / `.adr/004` へ差し替える（`spec/adr/005` は superseded）」の1文を足す。あるいは改訂表の外に「`spec/adr/005` を参照する6箇所（`testing.md` の一覧と同じ）はすべて `.adr/003` / `.adr/004` を指すよう差し替える」という横断指示を1行置く

#### Notes

- **[N-001]** 成果物制約は4項目すべて機械的に適合していることを確認した
  - `.adr/` の新規追加は **002 / 003 / 004 の3件のみ**。`git diff --name-status main...HEAD -- .adr/` は `A` 3行だけで、`.adr/001-integration-tests-single-workers-pool.md` は `M` にも現れない
  - `spec/adr/` の差分は `M spec/adr/005-search-index-via-outbox.md` の1行のみ（`A` なし）。`git status --porcelain | grep 'spec/adr/'` も空。`## コンテキスト` 以降の本文は `git show main:` との全文 diff で**1文字も変わっていない**
  - `.thread/1/adr.md` は `git diff --numstat` が `2	0`（追加2 / 削除0）。挿入位置は `## ADR-004:` → `### Status` → `Proposed` → 空行 → ポインタ1行 → 空行 → `### Context` で、ADR-002 / ADR-015 にはハンクが立っていない
  - コード・コンフィグは1行も変わっていない。`git diff --name-only main...HEAD | grep -E '^(packages/core/|apps/web/app/|infra/)|\.(ts|tsx|toml|json|sql)$'` が空

- **[N-002]** `.adr/` 3件は薄い台帳の粒度を保っており、design.md への参照もすべて実在する
  - 42 / 38 / 42行（既存 `.adr/001` は44行）。5節構成（ステータス / コンテキスト / 決定 / 検討した代替案 / 影響）が `.adr/001` と厳密一致
  - `CREATE TABLE` / `PRIMARY KEY` / `bucket` / `=> `/ `): Promise<` などの実装トークンのヒットが**0件**、コードフェンスも0件。DO の分割数（256）・saga の phase・migration 手順・スキーマ断片はいずれも `.adr/` 側に流れていない
  - 3件とも本文から `.thread/34/design.md` の**節番号付き**参照を持ち（002 は第3章 / 第3.1節 / 第4.8節 / 第5.1節、003 は第2.1節 / 第4.6節 / 第7.1〜7.2節 / 第11.2節、004 は第7.3節 / 第7〜9章 / 第8.2.1節）、すべて実在する見出しを指している。逆方向（design.md → `.adr/00[234]`）も20行ある
  - supersede の正本は新 ADR 側にある。`.adr/002` が `.thread/1/adr.md` ADR-004 を、`.adr/003` / `.adr/004` の**両方**が `spec/adr/005` を、それぞれステータス節で名指ししている

- **[N-003]** `testing.md` の機械検証17項目を実際に実行し、**全項目が期待結果どおり**であることを確認した
  - 確認項目1（`.adr/` 件数4 / `A` 3行 / H1 4件 OK / 5節 3件 OK）、2（禁止トークン0件・50行以内・フェンス0件）、3（supersede 正本）、4（`本文不変 OK`）、5（`2	0`）、6（3手順とも空）、7（未ラベル見出し0 / `Issue 要求36 + 派生24 + 参考5 = 65 = 総数` / 未決語0件 / 「従属」は許容1件）、8〜12、13（`MISSING` 0件・`判定なし` 0件・件数40）、14（`MISSING` 0件・`NOT FOUND` 0件・`10 24`）、16（95件 > 19件）、17（`MISSING` は文書化済みの6件のみ・無修飾 `ADR-NNN` は逐語引用1件のみ）
  - 前ラウンドで指摘されたとみられる `awk` の範囲式（`/A/,/B/` が1行に潰れる問題）は `awk '/^### .../{f=1;next} f&&/^### /{f=0} f'` 形へ直っており、実行して正しく範囲抽出できることを確認した。手順11 の「行き先列が空でないか」判定も、ホワイトリスト方式ではなく5列目の空判定になっており、`request Worker で回す` のような後から増えた行き先でも壊れない

- **[N-004]** 第11.1節の走査カバレッジ主張は**実測と完全に一致する**（前ラウンドからの回帰なし）
  - `spec/**/review/**` = **39ファイル**（内訳も database 3 / design 8 / domains 9 / manual-tests 7 / pages 3 / review 3 / scenario 3 / usecases 3 で一致）、非レビュー md = **101ファイル**、語彙走査ヒット = **62ファイル**、`comm -23` の残り = **39件**
  - その39件の内訳が主張どおりであることを1件ずつ照合した。手段2・3 が拾う3件（`spec/domains/export.md` / `spec/manual-tests/document.md` / `spec/manual-tests/settings.md`）と、手段4 の36件（改訂9件 + 影響なし27件）で**過不足なく39件を覆う**。36件はすべて実在し、いずれも語彙走査に掛かっていない
  - 改訂対象72 / 影響なし29 = 101 の内訳も整合する（62 − 2 + 3 + 9 = 72、2 + 27 = 29）
  - `spec/inventory/adapter.md` の distinct `ADP-*` は **85件**、design.md が引用する distinct は **53件**、差の **32件**は design 側に無い — 第4.3節末尾の主張どおり。逆に「design にあって台帳に無い `ADP-*`」は**0件**

- **[N-005]** 第4.1.1節（テーブル / 列の全数の正本）と第5〜9章に矛盾は見つからなかった
  - 第5〜9章（design.md:405-1615）に現れるスネークケース識別子を全数抽出したところ、テーブル名として登場するのは `credential_locators` / `credential_mappings` / `password_reset_tokens` / `search_entries` / `search_fts` / `ai_client_connections` / `rotation_checkpoints` / `migration_progress` / `user_settings` / `source_links` / `memo_revisions` / `document_revisions` だけで、**すべて第4.1.1節に載っている**。唯一の例外は OAuth 認可コードの `jti` 一回性テーブルだが、第4.1.1節が「定義を #13 へ預けた唯一のテーブル」と明示し、預け先が #13 であることまで `gh issue view` で確認した旨を書いている
  - 前ラウンドで追加された5列（`credentialId` × 3テーブル / `usableForLogin` / `label` / `encryptionNonce` / `consumedByOperationId` / `callerToken`）は、第4.1.1節の列定義と、第5.1節の RPC ガード表・第6.1.1節 (R3)(R4)(R8)・第6.1.2節 (C1)〜(C6)・第6.3節 phase 4・第6.6節 unlink 手順1〜3・第6.8節 手順2 (2)・第11.2節の「新しく導入した列」表のすべてで同じ意味論で使われている
  - 第6.8節 手順2 (2) の上書き列リスト14列は、すべて第4.1.1節の `credential_mappings` の列に含まれる（`kind` / `hmac` / `generation` / `userId` は移送先の同一性を成すため上書き対象外で、これも整合する）
  - `jobs` の11列は第4.1.1節と第7.4節の列表が一致。`kind` の全数は User Data DO 6種 + Directory 6種 = 12種で両節一致し、第7.4節の「内部カーソルを持つ4種 + 残り8種 = 12」とも合う。`rotate-remap` を `kind` 表から外して maintenance 経路の同期 RPC に格下げした判断は、第4.1.1節・第5.1節・第6.8節・第7.4節の4箇所すべてに反映されている
  - 第5.1節の RPC エントリ表は実測でクラス(2) 10本 + クラス(3) 12本、うち「既定のガードが当てはまらない8本」の内訳（(3-b) 3本 + (3-d) 3本 + (3-c) 2本）も本文の記述と一致
  - 第6.9節の締め出し経路一覧は実測12行で、本文の「次の12経路がある」と一致

- **[N-006]** 節番号参照・パス参照・行番号引用を全件実測し、**外れは1件も無かった**
  - design.md / `.adr/` が使う `第N.M節` / `第N章` の distinct な参照 **69種**がすべて実在する見出しを指す（第7.7節・第9.4節・第10.2節・第11.4節・第2.1.1節・第6.1.1節・第6.1.2節など後から新設された節も含めて確認）
  - `spec/` 側の行番号引用: `spec/idea.md:40,:48` / `spec/requirements.md:87,:108` / `spec/database/index.md:350,:355-357` / `spec/domains/search.md:264` / `spec/usecases/search.md:93` / `spec/domains/trash.md:239` / `spec/usecases/trash.md:315` / `spec/domains/export.md:249,:264,:275` / `spec/index.md:38-43` / `spec/usecases/memo.md` の `collectEvents` 7箇所（`:51 :232 :359 :396 :434 :474 :572`）をすべて `sed -n` で確認し、引用内容と一致した
  - コード側の行番号引用: `valueObject.ts:47,:125,:142` / `currentUser.ts:17-26,:28-33`（"The authoritative guard" の JSDoc を実在確認）/ `authState.ts:18-23` / `server.cloudflare.ts:4,33,44` / `d1/unitOfWork.ts:39`（"Read-your-write within the same UoW is unsupported by design"）/ `d1/repositories/helpers.ts:55-69` / `d1/schema.ts:118`（`OCC_GUARD_CHECK_NAME = "occ_guard_positive"`）/ `errorResponse.ts:70` / `di/types.ts:53,:70` / `0000_initial.sql:46,47` / `handlers.ts:82,:120` をすべて確認し一致
  - 行数の主張: `adapters/d1/` 20ファイル / 2,514行、うち**プロダクションコード8ファイル / 914行**（実測: `client.ts 14 + pendingBatch.ts 98 + repositories/helpers.ts 102 + idempotencyStore.ts 26 + outboxRepository.ts 227 + userRepository.ts 172 + schema.ts 145 + unitOfWork.ts 130 = 914`）、`eventRelayWorker.ts` 301行、`outboxPrune.ts` 25行、`handlers.ts` 138行、`pendingBatch.ts` 98行、`application/execution/unitOfWork.ts` 19行、`wrangler.toml` 162行、`spec/domains/search.md` 271行、`spec/database/index.md` 403行、`.thread/1/adr.md` 1,664行 — **全件一致**
  - 契約の主張: `SessionCodec` が `issue(userId, now)` / `verify(token, now)` で epoch の口を持たないこと、`hmacSessionCodec` のペイロードが `{ uid, exp }` で `parsePayload` が `uid` / `exp` しか見ないこと、`SystemErrorCode` が6値であること、`UserRepository` が `insert` / `save` / `findById` / `findByEmail` の4本だけで `findBySsoIdentity` がコードに**0件**であること、`secrets.ts` の入れ子理由の JSDoc（`const { …, secrets, ...appConfig } = config` は `serverCloudflare.ts:131` に実在）、`.gitignore:16-17` の生成物指定、両 `.tpl` の21行目が `main = "app/server.cloudflare.ts"`、Pulumi の `// D1 is the system of record — refuse accidental destroy` + `{ protect: true }`、`vitest.config.integration.ts` の `readD1Migrations` / `d1Databases` / `queueProducers` / `queueConsumers` / `include` — **すべて実在を確認**
  - `apps/web/package.json` のスクリプト件数も `10 24`（db 系10本 / deploy 系24本）で第11.2節の主張と一致

- **[N-007]** #35 の担当者としての着手可否 — **受け入れ条件7項目すべてについて着手できる**
  - AC1（ベクトル / D1 前提の残存ゼロ）: 第11.1節が `spec/` 非レビュー md **101件全数**に「改訂する / 影響なし」の判定を付けており、改訂側は削除する記述と置換後の記述が行番号つきで並んでいる。走査の4手段が再実行可能な形（走査語の正規表現・`comm` の再現手順）で記録されているので、#35 は「漏れが無いこと」を自分で再証明できる
  - AC2（4.4 の再定義 + 非機能要件）: `:87` / `:108` の置換文と、非機能要件へ足す文言の**要旨そのもの**が本文にある
  - AC3（`SearchIndexPort` の単純化）: Issue 本文が「query / upsert / remove」と書いているのに対し設計の結論は `query` 1本であることを検出し、**「#35 は Issue 本文の当該行を訂正したうえで作業する」と明示している**。同種の訂正指示が第9.1節（`new_sqlite_classes` → `exports`）と第11.2節（UoW 契約は「維持」ではなく「差し替え」）にもあり、Issue 本文と設計が食い違う箇所が漏れなく先回りされている
  - AC4（`spec/database/index.md` の一本化 + schema version / lazy migration）: 足す内容の要旨 (i)〜(vi) が列挙され、テーブル全数は第4.1.1節を参照している
  - AC5（`spec/inventory/` / `testcases/search/` / `manual-tests/`）: 台帳4本・テストケース33ファイル・マニュアルテスト6ファイルが個別行として並び、テストケースは (A)(B)(C) の3書き換え方式が定義されている
  - AC6（`CLAUDE.md`）: 第7.7節が「非同期実行契約の**正文**」として7項目にまとまっており、「#35 は本節を `CLAUDE.md` へ写す」と書かれている。写す先の節（Reference runtime / Key concepts / Retry strategy）も指定済み
  - AC7（#10 との照合）: 入力が改訂後の `spec/inventory/` であることに加え、**#13 も照合対象に足すべき理由**（OAuth 認可コードの置き場所と `identity.aiClientRevoked` の失効 consumer 消滅）が2点の具体的入力として書かれている
  - 加えて #35 の対応項目1〜7 のうち受け入れ条件に現れない指示（tokenizer 選定方針、画面仕様3件、`spec/usecases/review/002.md` を改訂対象から外す判断）にも明示の結論がある

- **[N-008]** #37 の担当者としての着手可否 — **「ここで手が止まる」箇所は見つからなかった**
  - 実装に必要な確定値がすべて揃っている: DO クラス2つと責務分界、Worker 2本の秘密配布境界（6秘密の所在と単一鍵 / keyring の別）、テーブル全数と列（第4.1.1節）、RPC エントリ全数22本とガード（第5.1節）、UoW の新契約（TypeScript シグネチャつき）、FTS5 projection の実装制約2点、`jobs` の11列 / 12 `kind` / 3階層の件数予算（25件・20チャンク・1,000行の出発点つき）、lazy migration のゲート関数と `alarm()` 先頭の順序（(1) 再武装 + `sync()` → (2) ゲート → (3) 仕事）、bucket 数 256、変更対象22行（削除5 / 作り直す4 / 改修13）と新設対象
  - **未決事項が第11.4節の9件に限定され、9件すべてに「決める主体」と「いつ」が割り当てられている。**「本設計への影響」欄で7件が「無い」と明記され、残る2件（`snippet()` ではなく実測2件の再確認 / チェックポイント予算の値）も再確認手順（第2.1.1節）または出発点の値まで書かれている。**保留・TBD で終わる節は機械走査でも0件**
  - 設計が依拠する事実に「公式記載 / 実測 / 未確認」の種別が付き、未確認7件はいずれも「推論が外れても結論は安全側に倒れる」ことが個別に論証されている（F-4b / F-13 / F-14 / F-26 / F-27b / F-32b）。#37 が spike の結果に応じて設計を再開させる必要が無い
  - #36 からの引き継ぎ H-1〜H-8 に個別の後継が割り当てられ、H-7 だけが対象外である理由も書かれている。`.thread/36/plan.md` は現物が存在する（untracked）
  - Issue #37 本文と設計が食い違う2箇所（`new_sqlite_classes` / UoW 契約の「維持」）に**訂正指示**が置かれており、Issue のチェックリストどおりに実装すると wrangler の設定検証で弾かれることまで説明されている
  - 未コミットの `apps/web/wrangler.{request,state}.{staging,production}.toml` 4本について「先行ブランチの残骸なので使わず `.tpl` 経路で作り直す」と明示。参照先の `apps/web/app/server.state.ts` が現ブランチに存在しないことも実測で確認した

- **[N-009]** 自己矛盾の探索結果 — `.adr/` と design.md の間、および design.md 内部に食い違いは見つからなかった
  - `.adr/002` の影響節「ベンダーロックインの適用範囲は従来『アダプターと実行エントリだけ』と説明してきた範囲を超える」→ `.adr/004` の「ドメインポートの `Promise` 契約が変わる」→ design.md 第8.2.1節「`CLAUDE.md`「Reference runtime」の明言が実際に破れる箇所がここである」→ 第11.1節の `CLAUDE.md` 改訂行、の4点が一貫している
  - `.adr/003` と `.adr/004` の supersede 分担（根拠側 / 方式側）が両 ADR・`spec/adr/005` のステータス行・design.md 第7.1節の4箇所で同じ説明になっている
  - `.adr/002` が「セッション方式を扱う別 ADR は起こさない」と書き、design.md 第3.1節・第5.1節・第5.4.1節 (c) が同じ判断を3箇所で同じ理由づけで支えている（`.adr/` に不要な ADR を増やさない判断としても正しい）
  - 設計内部で過去に矛盾していた箇所は、いずれも「初版は〜と書いていたが誤りである」の形で明示的に撤回されたうえ、正本節（第5.1節の RPC 表 / 第6.1.1節の (R1)〜(R9) / 第6.1.2節の `credentialId` / 第7.7節の非同期実行契約 / 第4.1.1節のテーブル全数）へ集約されている。各正本節に「本文と食い違ったら本表を直す / 本文が正本である」という優先順位まで書かれており、次の改訂で再び分岐しない構造になっている
  - 第6.2.2節 (b)（リセット依頼のレート制限）と第7.6節（ダミージョブ行を必ず書く）の矛盾、第7.4節の収束規則（「早める方向にのみ」）と第7.5節の retention 延長の矛盾は、どちらも本文中で矛盾として名指しされたうえで解消規則が置かれている

- **[N-010]** `credential_locators.status` の値域と遷移がどの節にも定義されていない（低影響）
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:244`（第4.1.1節の `credential_locators` 行に `status` が列として載っている）
  - 第4.1.1節は「認証・saga・ジョブ系は列の全数」の正本を名乗り、他の列には値域を添えている（`kind`（`email` / `sso`）、`account.status`（`active` / `deleting` / `deleted`）など）が、`credential_locators.status` だけは値域の記載が無い。読み側は第5.3節 step 5 (ii) / 第6.6節 unlink 手順1 の「active な行」だけで、書き側（第6.3節 phase 4 / 第6.6節 link 手順4 / 第6.8節 手順2 (1) の `record-credential-locator`）はいずれも記録・上書きする列として `status` を挙げていない。削除は物理削除（unlink 手順2 / 退会 手順4）なので、実質的に値は `active` 固定になる
  - **#37 が手を止める箇所ではない**（insert 時に `active` を書けば全記述と整合する）ため Warning にはしない。第4.1.1節が「列の全数の正本」を名乗る以上、`status`（現状 `active` のみ。除去は物理削除で行うので他の値を取らない）の1語を添えると、#37 が「revoked のような論理削除状態を足すべきか」を迷わずに済む
