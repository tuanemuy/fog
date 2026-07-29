# レビュー 001 — 後続 Issue への引き継ぎ性・ドキュメント品質

対象: PR #43（`issue/34/do-boundary-design`）/ Issue #34
主成果物: `.thread/34/design.md`、`.adr/002`〜`.adr/004`
検証した受け入れ基準: `.thread/34/plan.md` の AC-16 / AC-17 / AC-19

## 判定

| AC | 判定 | 根拠 |
|---|---|---|
| AC-16（#35 が着手できる） | **不合格** | B-001 / B-002 / B-003。必須ファイル一覧そのものは揃っているが、「影響なし」判定19件のうち18件が誤りで、`spec/idea.md` が判定対象から落ち、改訂内容が #35 の受け入れ条件を満たさない |
| AC-17（#37 が着手できる） | **条件付き不合格** | B-004 / B-005。削除・新設一覧と UoW 新旧対比は実装に落とせる粒度にある。一方で canonical 区切り子が確定できず、User Data DO → Directory DO の呼び出し経路が第5.5節と矛盾したまま残っている |
| AC-19（自己完結性） | **合格** | 先行ブランチ・`.thread/19/`・`.thread/1/adr.md` を開かないと読めない箇所は無い。先行案13件すべてに採否と採用内容の要旨がある。実測（trigram / bm25）も要旨が本文にある（ただし W-008） |

## 引き継ぎ性・ドキュメント品質

### Blockers

- **[B-001]** 第11.1節「影響なし（判定済み）」19件のうち18件が実際には改訂対象で、#35 が本書だけを見て作業すると Outbox / consumer 前提の記述が spec に残る
  - 場所: `.thread/34/design.md:986`
  - 理由: 判定の根拠として「ヒット語が『ゴミ箱に入れたメモは検索にヒットしない』等の**利用者から見た振る舞い**の記述であり、実現手段の変更に影響されない」と一括で書かれているが、実際のヒット内容は振る舞いではなく Outbox 行・consumer 挙動・検索方式名そのものである。全件を開いて確認した結果は次のとおり（`spec/adr/004-domain-boundaries.md` 以外はすべて誤判定）。
    - `spec/usecases/identity.md:10` `:47` `:95` — `collectEvents(eventDrafts)`（Outbox 経由）。第7.3節で `collectEvents` ごと廃止する
    - `spec/usecases/knowledge.md:16` `:79` `:122` — 同上
    - `spec/usecases/memo.md:51` `:232` `:396` `:434` `:474` — `collectEvents`（「Outbox へ。search consumer がインデックスに upsert する」）。本書は「非同期反映を前提にした期待値があれば直す」と条件付きで逃がしているが、`collectEvents` は条件ではなく確定で消える
    - `spec/testcases/identity/registerWithPassword.md:7` — 「`identity.userRegistered` イベントが Outbox に同一トランザクションで記録される」
    - `spec/testcases/identity/revokeAiClientConnection.md:8` — 「アダプター（イベント consumer）の挙動を確認する」。第7.3節・第5.4.1節 (b) で消える購読者そのもの
    - `spec/testcases/knowledge/createTopic.md:7` — 「`topic.created` イベントが同一 UoW で Outbox に記録される」
    - `spec/testcases/memo/{postMemo,post_memo,delete,softDeleteMemo,editMemo,rollbackMemo,update_memo}.md` の各 `:8`〜`:9` — いずれも「イベントが同一 UoW で Outbox に記録される」を期待値として持つ
    - `spec/testcases/trash/restoreMemo.md:9` — 「`memo.restored` により search consumer が再インデックス…する契機となる」
    - `spec/testcases/search/search.md:28` — 「インデックス更新（非同期 consumer）が未完了」。同期更新になるとケースごと成立しない
    - `spec/manual-tests/ai.md:50` / `spec/scenario/ai.md:19` / `spec/scenario/index.md:42` — いずれも検索を「ハイブリッド検索」と名指ししている。#35 の受け入れ条件「`spec/` にベクトル検索…前提の有効な設計が残っていない」に直接抵触する。#35 の Issue 本文も `spec/scenario/{index,search,ai}.md` と `spec/manual-tests/ai.md` を明示的に改訂対象に挙げている
  - 提案: 「影響なし」判定を全件やり直し、ヒット行を1行ずつ引用して判定する。少なくとも上記18件を「改訂する」表へ移し、`collectEvents` / Outbox 期待値の書き換え方針（イベント行の削除か、リビジョン記録への読み替えか）を第7.3節の結論と対応させて1行ずつ指示する。判定を一括の理由文で束ねない。

- **[B-002]** `spec/idea.md` を走査から除外しているが、#35 の対応項目1が明示的に改訂を要求している
  - 場所: `.thread/34/design.md:940`
  - 理由: 「`spec/*/review/**` と `spec/idea.md` は履歴文書なので除外」とだけ書かれ、除外の当否が判断されていない。しかし `spec/idea.md:40` は「人間用のグローバル検索画面を設ける（メモ・ドキュメント横断のハイブリッド検索）」であり、#35 の対応項目1の先頭が「`spec/idea.md`: 「ハイブリッド検索」を FTS5 による横断全文検索へ変更」と名指ししている。#35 の担当者は本書と Issue 本文で指示が食い違う状態に置かれ、どちらに従うか判断できない。
  - 提案: 「履歴文書として改訂しない」と決めるなら、その判断と #35 の Issue 本文との差分を第11.1節に明記する（#35 側で Issue を修正すべき旨まで書く）。改訂するなら「改訂する（要件・体験側）」の表に `spec/idea.md:40` を1行足す。除外理由を注記だけで済ませない。

- **[B-003]** 第11.1節の「改訂内容」が #35 の受け入れ条件をカバーしておらず、#35 が本書だけで作業を終えると受け入れ条件を満たせない
  - 場所: `.thread/34/design.md:946`（requirements の行）、`.thread/34/design.md:978`（database の行）
  - 理由: #35 の受け入れ条件と突き合わせると次が欠けている。
    - 「非機能要件にユーザー単位 DO の物理分離が入っている」— requirements の行は `:87` と `:108` の検索2箇所しか指示していない。#35 対応項目1の4つ目「非機能要件に『ユーザーデータはユーザー単位 DO に物理分離される』を反映」に対応する指示が無い
    - 「`spec/database/index.md` が…DO の schema version / lazy migration 方針を含む」— database の行は削除対象（`user_id` 列・`outbox` / `processed_events` / `_occ_guard`・`search_embeddings`・期限切れ索引）しか指示しておらず、第9章の内容を spec へ追加する指示が無い
    - 「日本語検索に使う FTS5 tokenizer の選定方針と短い検索語の扱いを記述する」（#35 対応項目3）— 第7.2節に材料はあるが、それを `spec/database/index.md` へ書けという指示が第11.1節に無い
    - DO 前提で**新設**されるテーブル（`jobs` / `operations` / `_meta` / `credential_mappings` / `credential_locators` / `migration_progress` / `account` / `user_settings`）を DB spec に足す指示が無い。第4.1節に名前は出るが、第11.1節は削除側しか書いていない
  - 提案: 第11.1節の表を「削除する記述」と「追加する記述」の2列にし、#35 の受け入れ条件7項目を左端に並べて、各項目を満たすために触るファイルと追加内容を対応づける。#35 が本書と Issue の受け入れ条件を突き合わせ直さないと欠落に気づけない構造をやめる。

- **[B-004]** SSO canonical の区切り子として生の NUL バイト（0x00）が Markdown 本文に埋め込まれており、読み手が区切り子を確定できない
  - 場所: `.thread/34/design.md:352`（第5.2.1節 (c)）、`.thread/34/design.md:448`（第6.1節 (b)）
  - 理由: ファイルの実バイト列は `provider + "<0x00>" + subject` で、括弧内の理由文だけが「区切りに NUL を使う」と説明している。ところが Markdown としてレンダリングしても、エディタや Read ツールで開いても、NUL は空白または不可視文字として表示される。#37 の担当者が見るのは `provider + " " + subject`（空白区切り）または `provider + "" + subject`（区切り無し）で、**理由文と本文が食い違って見える**。canonical 規則は HMAC の入力そのものであり、一意性・bucket ルーティング・鍵ローテーションの再写像がすべてこれに依存する。しかも第5.2.1節 (d) が「規則の変更は鍵ローテーションと同格の移行作業」と定めているため、実装時に取り違えると後から直せない。副作用として、`grep` / `ugrep` / `rg` がこのファイルをバイナリ判定してスキップする（`command grep` は "binary file matches" を返し、`-a` を付けないと検索できない）。#35 / #37 が design.md を検索して引き継ぎ項目を拾う運用が壊れる。
  - 提案: NUL バイトを本文から取り除き、`` `provider + "\0" + subject`（区切りは U+0000 の NUL、1バイト） `` のようにエスケープ表記と明示的な説明で書く。あわせて `perl -0777 -ne 'print scalar(() = /\x00/g)'` 相当で成果物全体に制御文字が残っていないことを確認する（現状 design.md の2箇所のみ、他の成果物は0件）。

- **[B-005]** User Data DO から Identity Directory DO を呼ぶ経路が設計されておらず、第5.5節の構造的保証と第6章の手順が矛盾する
  - 場所: `.thread/34/design.md:434`（第5.5節 1）と `.thread/34/design.md:521`（第6.4節）/ `.thread/34/design.md:553`（第6.6節 unlink 手順3）/ `.thread/34/design.md:566`（第6.7節 手順4）
  - 理由: 第5.5節 (1) は「`idFromName` を呼ぶのは request Worker の1モジュール（DO stub factory）だけにする」と断定している。一方で次の手順はいずれも User Data DO の側から Directory bucket を操作することを要求している。
    - 第6.4節「phase 3 の途中 / phase 4 の途中 / phase 5 の直前 → User Data DO の Alarm が saga を**前進**させる」。phase 2 と phase 4 は Directory bucket 上の操作である
    - 第6.6節 unlink 手順3「Directory bucket の mapping 行を削除する」、および末尾「残った mapping は User Data DO の Alarm が reverse locator との突き合わせで検出し、削除を再試行する」
    - 第6.7節 退会 手順4「Directory bucket の mapping 行を物理削除する」
    さらに第3.2節の秘密配布表と第3.3節の binding 概念図は、request Worker からの `USER_DATA` / `IDENTITY_DIRECTORY` の2本しか描いておらず、state Worker 側（DO 実行環境）に `IDENTITY_DIRECTORY` binding があるかどうかを述べていない。加えて、DO の内側から他 DO を `await` すると input gate が開いて他リクエストが割り込む（本書が第2.1節 #18 で自ら挙げている事実）が、saga 前進中の再入可否がどこにも書かれていない。#37 はここで手が止まる — binding を足すか、Alarm から request Worker へ折り返すか、Directory 側から pull させるかで、wrangler 設定・DI・saga の再入設計がすべて変わる。
  - 提案: 第3.2節・第3.3節に「state Worker は `IDENTITY_DIRECTORY` binding を持つ / 持たない」を明記し、第5.5節 (1) を「locator を**外部入力から**導出するのは request Worker だけ。DO 側は `credential_locators` に記録済みの locator しか使わない」のように、第6章の手順と両立する形へ言い直す。あわせて DO 内から他 DO を await する区間の input gate 再入について、トランザクション外であること・phase の永続化後であることを第6.9節に1段落で足す。

### Warnings

- **[W-001]** 第4.1節の保持データ表と第6〜9章のテーブルが一致しない
  - 場所: `.thread/34/design.md:190`（第4.1節の表）
  - 理由: 第4.1節は「Issue 列挙7項目の対応表」として User Data DO のテーブル群を列挙する位置づけだが、`trash_schedule`（次の期限）はこの表にしか現れず、第7.5節は期限を `purge_after` 列に持ち Alarm は `jobs` の `nextRunAt` で駆動すると書いている。逆に第6.3節以降で使う `credential_locators`、第9.3節の `migration_progress` は第4.1節の表に無い。#37 はどれが実テーブルか判断できない。
  - 提案: 第4.1節の表を第6〜9章の結論に合わせて更新し、`trash_schedule` を落とすか `purge_after` との関係を明示する。`credential_locators` / `migration_progress` を追加する。

- **[W-002]** export 読み出し上限の決定主体が2箇所で食い違う
  - 場所: `.thread/34/design.md:309`（第4.8節「具体値は #38 で決める」）と `.thread/34/design.md:1057`（第11.4節の表「決める主体: #37」）
  - 理由: 未決事項の表は「誰がいつ決めるか」を割り当てることが目的の節なので、本文と食い違うと割り当てが機能しない。
  - 提案: どちらかに寄せる。spike の値が入力なら「#37 が spike で上限の根拠値を出し、#38 が運用値として確定する」のように役割を分けて両方に同じ文を置く。

- **[W-003]** bounded 処理の判定基準を CPU 予算に置き換えた結果、実装可能な計測手段も具体値も残っていない
  - 場所: `.thread/34/design.md:689`（第7.4節）、`.thread/34/design.md:867`（第9.2節）
  - 理由: 「判定基準は wall time ではなく CPU 予算で書く」と繰り返し断定しているが、Workers / DO には残り CPU 時間を実行時に読む API が無い（本書もそれを示していない）。実際の指示は「1回の Alarm で処理する件数と累積の**経過時間**に上限を置き」となっており、宣言した基準と実装手段が逆を向いている。さらに第1.3節では先行案の「25件・10秒の budget」を**採用**と書きながら、第7.4節では数値が消えている。#37 は初期値を自分で決めるしかなく、その根拠が成果物に無い。
  - 提案: 「CPU 予算が真の制約だが実行時に観測できないので、チェックポイント間隔は保守的な固定値（件数 N / 経過時間 T）で近似する」と書き、N / T の初期値と、決め直す契機（エビクションの発生をどう検知するか）を第7.4節に置く。第1.3節の「採用」ラベルもその内容に合わせる。

- **[W-004]** 第1.1節の読者導線が本文の実態と合っていない
  - 場所: `.thread/34/design.md:15`
  - 理由: 「#35 は第11.1節だけを開けば着手できる」と書かれているが、第11.1節の各行は第4.5節 / 第5.2.1節 / 第5.4.1節 / 第7.1節 / 第7.2.1節 / 第8.2.1節を参照しており、参照先を読まないと「何にどう書き換えるか」が決まらない。「#37 は第4〜9章と第11.2節を読めば着手できる」も、第11.2節が第3.2節を根拠に挙げ、設計全体が第2.1節のプラットフォーム事実表に依存しているため成立しない。導線を信じて読むと必要な節を読み飛ばす。
  - 提案: 「#35 は第11.1節を起点に、そこから参照される第4.5 / 5.2.1 / 5.4.1 / 7.1 / 7.2.1 / 8.2.1 節を読む」「#37 は第2.1節（前提事実）→ 第3〜9章 → 第11.2節」のように、実際の依存に沿って書き直す。

- **[W-005]** 第11.1節の網羅性が6語の grep に依存しており、DO 化で確実に無効化される spec が一覧から漏れる
  - 場所: `.thread/34/design.md:940`
  - 理由: 走査語は `Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド` の6語で、`collectEvents` / `pruner` / `D1` / `libSQL` / `Turso` / `Vectorize` / `RRF` / `PendingBatch` / `occ_guard` / `UnitOfWork` が入っていない。実測すると次が一覧から漏れる。
    - `spec/testcases/trash/emptyTrash.md:12` `:15` / `hardDeleteTrashItem.md:17` / `restoreDocument.md:55` / `restoreTopic.md:18` — いずれも「pruner との並行実行」を前提にした競合ケース。pruner は第7.5節で消える
    - `spec/manual-tests/timeline.md:29-33` / `spec/manual-tests/settings.md` — 共有 DB への直接 SQL 更新を前提にした準備手順。本書が `spec/manual-tests/trash.md` の pruner 起動口について指摘したのとまったく同じ性質の前提で、DO 化で手段が変わる
  - 提案: 走査語を上記まで広げて再走査し、ヒット全件に判定を付ける。走査語そのものを第11.1節に記録して、#35 が同じ走査を再実行できるようにする。

- **[W-006]** Markdown のスタイルが `markdown-style` の原則から外れている
  - 場所: `.thread/34/design.md` 全体
  - 理由: 章間の区切り線 `---` が11本、太字だけで1行を占める見出し代用が39箇所ある（`**決定事項**` `:758` / `**手順**` `:574` / `**改訂する（要件・体験側）**` `:942` / `**削除対象**` `:992` など）。加えて `**できる。本体更新と FTS5 の更新を同一 SQLite トランザクションで確定させる。**`（`:607`）のように文全体を太字にする箇所が多く、強調が効かなくなっている。見出し代用はアウトラインにも目次にも乗らないため、1,059行の文書を節番号で参照する本書の運用と噛み合わない。
  - 提案: 区切り線を削り、太字の擬似見出しを `####` 以下の見出しへ格上げする（そうすると第11.1節の「改訂する（要件・体験側）」などが節として参照可能になり、W-004 の導線改善にもつながる）。文全体の太字は結論の要点だけに絞る。

- **[W-007]** 第11.2節「削除対象」の表に、削除しない行が混在している
  - 場所: `.thread/34/design.md:992`
  - 理由: 表題は「削除対象」だが、`application/execution/unitOfWork.ts`（新契約に置き換える）、`apps/web/app/presentation/` の一部（「server-function エントリとエラー応答ミドルウェアは残る」）、`render-wrangler.ts` + `.tpl`（2系統に増やす）、ローカル `wrangler.toml`（構成を反映する）は改修対象である。#37 が表題だけを見て削除しかねない。
  - 提案: 「削除する」「作り直す」「改修する」の3区分に分ける。少なくとも各行に区分の列を足す。

- **[W-008]** FTS5 単独構成の唯一の根拠である実測の出典が、現ブランチから到達できない
  - 場所: `.thread/34/design.md:77`（第2.1節 #11 / #12）
  - 理由: 出典が `.thread/19/spike/fts5.integration.test.ts` ほか先行ブランチの統合テストで、現ブランチには存在しない（`ls` で確認）。要旨（「東京駅」で2件、2文字の「東京」でも2件、`bm25(search_fts, 3.0, 1.0)`）は第7.2節に書かれているので AC-19 の自己完結性は満たすが、trigram / bm25 は公式ドキュメントに記載が無い（本書 #10 が明記）ため、実測が唯一の根拠である。#37 が再検証したいときの手順が成果物に無い。
  - 提案: 第11.4節または第11.2節に「trigram / bm25 の可用性は #37 の着手時に最小 spike で再確認する（再現手順: 3件投入 → `東京駅` / `東京` / ページング）」を1行足す。#37 の Issue が要求する tokenizer 実環境検証と同じ作業なので、そこへ紐づけるだけでよい。

- **[W-009]** `sessionEpoch` をセッショントークンに署名する変更の移行が書かれていない
  - 場所: `.thread/34/design.md:332`（第5.1節）
  - 理由: epoch ガードは「セッショントークンに発行時の `sessionEpoch` を署名しておく」ことを前提にしているが、現行 `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` のペイロードに epoch は無い。移行期に流通する epoch 無しトークンをどう扱うか（拒否するか、epoch 0 とみなすか）が書かれていない。第3.2節が「片側デプロイ・ロールバックの互換ウィンドウを最低1リリース分確保する」と定めているのに、その対象からセッショントークンが漏れている。
  - 提案: 第5.1節に「既存トークン（epoch 無し）の扱い」を1行加える。fail closed に倒すなら全ユーザー再ログインが発生する旨も書く。

### Notes

- **[N-001]** 第8.2節の型ガードは実際に機能することを確認した。`run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` に対し、`async` コールバックと `Promise` を返す非 async コールバックの両方が `Type 'Promise<number>' is not assignable to type 'never'` で落ちる（リポジトリの `tsgo` で検証）。「コマンド機構より強い保証がゼロコストで得られる」という第1.3節の棄却理由は成立している。
- **[N-002]** 第4.3節の網羅性の取り方は検証に耐える。`spec/inventory/adapter.md` の `ADP-*` はユニーク85件で本文の主張と一致し、第4.3節が引用する `ADP-*` ID は**全件が台帳に実在する**。第11.1節の「grep で40件」も再現でき（`spec/*/review/**` 14件と `spec/idea.md` を除いた41件から `spec/adr/005` を別扱いにして40件）、件数の主張は正しい。誤りは件数ではなく判定内容（B-001）に限られる。
- **[N-003]** 本文が引用する行番号は全件実在する。`spec/requirements.md:87` `:108`、`spec/usecases/search.md:85`、`spec/usecases/trash.md:311` `:315`、`spec/manual-tests/search.md:17` `:69` `:266`、`spec/manual-tests/trash.md:18` `:204` `:212` `:351`、`spec/pages/index.md:180`、`spec/scenario/search.md:6` `:25`、`spec/domains/search.md:264`、`packages/core/src/application/di/types.ts:70` を実測で確認した。ファイルパス参照も、先行ブランチ由来の2件（`.thread/19/adr.md` / `.thread/19/spike/fts5.integration.test.ts`。W-008）を除き全件実在する。
- **[N-004]** 未決の残り方は良い。「TBD」「暫定」「要検討」「未定」は0件。第2.1節の「未確認」3件（`snippet()` / `highlight()` の可用性、`transactionSync` のネスト可否、結果セットサイズ上限）はいずれも第11.4節で主体（#37）・時期（着手時の spike）・本設計への影響（前2件は「無い」と断定、3件目は値のみ待ち）が割り当てられている。裏付けの種別（公式記載 / 実測 / 未確認）を事実表の全行に付けた設計は、#35 / #37 が「公式保証」と誤認するのを防ぐ実効的な工夫である。
- **[N-005]** 重複記述の正本が明示されている。`.thread/34/adr.md` ADR-012 が「plan.md と design.md の重複は design.md が正本」と決め、plan.md 側にも4箇所（`:126` プラットフォーム事実 / `:157` 境界に閉じない処理 / `:217` D1 カットオーバー / `:257` 先行案との差分）に正本ポインタが実際に置かれている。supersede も新 ADR 側が正本で、`.thread/1/adr.md` の差分は1行追記のみ・本文改変なし、`spec/adr/005` はステータス行のみの変更であることを diff で確認した。Issue の「本文は書き換えない」制約を守っている。
- **[N-006]** 第1.3節の先行案の扱いは AC-19 の要求を超えている。13行すべてに採否ラベルと採用内容の要旨があり、保留ゼロ。棄却した3件（`SemanticCommitPort` / Account Home DO / #19 固有の検証手段）はいずれも棄却理由が本文の該当節を指しており、先行ブランチを開かずに追える。未コミットの `apps/web/wrangler.{request,state}.{staging,production}.toml` 4本を「先行ブランチの残骸。#37 は『既にあるから使える』と誤認しない」と明記した点（`:55`）は、実際に踏みやすい罠を先回りできている。
