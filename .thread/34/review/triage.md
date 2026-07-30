# 指摘台帳 — Issue #34 / PR #43

判定: `fix`（この PR で直す） / `wont-fix`（直さない） / `defer`（別 Issue）

Key はファイル＋箇所＋問題カテゴリで正規化する。ラウンドをまたいで Key が一致する指摘は判定を継承し、再審議しない。

## Round 1

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md/NUL バイト混入` | R1 | fix | 機械検証が偽の合格になる。3層で重複検出 | 0 |
| `design.md:5.5/signup operationId の出所` | R1 | fix | 「外部入力が locator の材料にならない」という中核主張が未成立 | 0 |
| `design.md:6.4/未認証 signup が先に User Data DO を生成` | R1 | fix | 第6.2節の判断軸が User Data DO に当たっておらず濫用経路になる | 0 |
| `design.md:5.3/login 時の到達性検査の不在` | R1 | fix | unlink 後の孤児 mapping で実際にログインできる | 0 |
| `design.md/credential 更新の cross-DO saga 不在` | R1 | fix | パスワード変更後も古いセッションが生存する | 0 |
| `design.md:6.6/退会の削除順序と PII 孤児化` | R1 | fix | `encryptedCanonical` が回収不能かつ再登録が永久ロック | 0 |
| `design.md:5.2/メール暗号鍵の世代管理と暗号方式` | R1 | fix | AC-23 (c) が保持場所のみ決着で保護方式が未決 | 0 |
| `design.md:8.2/ctx.storage.transaction の代替案欠落` | R1 | fix | 公式 API を検討せずに同期 UoW を選んだ形になっている | 0 |
| `design.md:9.2/migration ゲートが alarm() に無い` | R1 | fix | dormant DO が alarm 経路で未 migrate のまま動く | 0 |
| `design.md:7.4/Alarm 再武装が finally` | R1 | fix | 自ら定義した支配的失敗モードで再武装が走らない | 0 |
| `design.md/User Data DO → Directory DO の呼び出し経路` | R1 | fix | 第5.5節の保証と第6.4/6.6/6.7節の手順が矛盾する | 0 |
| `design.md:11.1/「影響なし」判定の誤り` | R1 | fix | 19件中18件が実際は改訂対象。#35 が着手できない | 0 |
| `design.md:11.1/spec-idea.md の走査除外` | R1 | fix | #35 対応項目1が改訂を明示要求している | 0 |
| `design.md:11.1/#35 受け入れ条件の未カバー` | R1 | fix | 非機能要件・schema version・tokenizer・新設テーブルが落ちている | 0 |
| `.adr/004/ドメインイベント全廃が読み取れない` | R1 | fix | 波及の大きい帰結が永続台帳に残らない | 0 |
| `.adr/002/決定節の自己矛盾（2クラス構成の差し戻し）` | R1 | fix | 永続台帳に未来形の未確定が残る | 0 |
| `design.md:8.3/DO RPC が新しい信頼境界` | R1 | fix | ブランド型が境界で失われ「値オブジェクト構築で検証」が無効化 | 0 |
| `design.md/sessionEpoch と SessionCodec の引き継ぎ漏れ` | R1 | fix | #37 の変更対象に入っていない | 0 |
| `design.md:5.4/トークンの鍵分離・audience タグ` | R1 | fix | セッションと AI トークンの取り違えを型で防げない | 0 |
| `design.md:5.4/AI トークンの scope 自己完結` | R1 | fix | 権限縮小が exp まで反映されない | 0 |
| `design.md:5.4/リセットトークンの bucket index 露出` | R1 | fix | 「locator を URL に出さない」と矛盾 | 0 |
| `design.md:5.2/鍵ローテーション時のメール平文 bulk 転送` | R1 | fix | PII が保護規定なしで Worker 間を流れる | 0 |
| `design.md:6.3/未認証経路のレート制限` | R1 | fix | 標的型で任意 1 bucket を落とせる | 0 |
| `design.md:7.6/リセット依頼の記述矛盾` | R1 | fix | 同一段落で相反する記述。列挙オラクルになる | 0 |
| `design.md:5.1/PII 非露出規定の穴（passwordVerifier・userId ログ）` | R1 | fix | 未認証 login ログが列挙オラクルになる | 0 |
| `design.md:7.1/external-content FTS5 の効果と実装制約` | R1 | fix | 緩和効果の過大評価と必須制約（旧値 delete / 安定 rowid）の欠落 | 0 |
| `design.md:4.7/新規エラーコードと errors.ts の変更対象化` | R1 | fix | #37 が変更対象を特定できない | 0 |
| `design.md:2.1/CPU リセット契機の出典分類` | R1 | fix | 記載の不在からの推論を「公式記載」に混ぜている | 0 |
| `design.md:9.2/migration ゲートの排他条件` | R1 | fix | await を挟まない同期実行という前提が明示されていない | 0 |
| `design.md:6.4/予約 TTL 掃除と saga 再開の競合` | R1 | fix | 到達不能アカウントを作りうる | 0 |
| `design.md:4.2/WorkerContainer・workers の出典誤り` | R1 | fix | indexer / pruner 専用 container は実装に無い。consumer / DLQ も無い | 0 |
| `design.md:11.3/非同期実行契約の正文が散在` | R1 | fix | 至少一回・順序保証の契約が1箇所にまとまっていない | 0 |
| `design.md:2.2/実装状況の誤記（SSO・AiClientConnection）` | R1 | fix | 実物と不一致。設計が空振りする | 0 |
| `design.md:5.2/Email.create の記述誤り` | R1 | fix | 現行実装（320字上限＋regex）と不一致 | 0 |
| `design.md:7.2/短語フォールバックの結論が実測と不一致` | R1 | fix | LIKE/GLOB と実測の `instr()` が食い違い、50バイト制約の導出も無効 | 0 |
| `design.md:4.3/ADP-identity-014 の欠落` | R1 | fix | 「全数」を名乗る表の漏れ | 0 |
| `design.md:5.4/リセットトークンの世代欠落` | R1 | fix | 鍵ローテーションで到達不能になる | 0 |
| `design.md:10.1/PITR が sessionEpoch を巻き戻す` | R1 | fix | 失効済みセッションが再有効化される | 0 |
| `design.md:6.2/bucket 数 N の所在` | R1 | fix | 名前にも keyring にも無く世代変更で解決できない | 0 |
| `design.md:3.2/秘密配布表の AI トークン署名鍵欠落` | R1 | fix | 配布対象の漏れ | 0 |
| `design.md/実装引用の取り違え5件` | R1 | fix | 誤記は #37 の作業を誤らせる | 0 |
| `design.md:4.1/保持データ表と各章のテーブル不一致` | R1 | fix | どちらが正本か判断できない | 0 |
| `design.md/export 読み出し上限の決定主体の食い違い` | R1 | fix | #38 と #37 で担当が矛盾 | 0 |
| `design.md:7.4/CPU 予算の計測手段と具体値` | R1 | fix | 判定基準だけあって測り方も閾値も無い | 0 |
| `design.md:1.1/読者導線が実態と不一致` | R1 | fix | #35 / #37 が読むべき節を誤る | 0 |
| `design.md:11.1/網羅性が6語 grep 依存` | R1 | fix | pruner 前提の testcase 4件・manual-test 2件が漏れる | 0 |
| `design.md/Markdown スタイル違反` | R1 | fix | 区切り線11本・太字の見出し代用39箇所。プロジェクトのスタイル規約に反する | 0 |
| `design.md:11.2/削除対象表に削除しない行が混在` | R1 | fix | #37 が誤って削除する | 0 |
| `design.md:2.1/実測の出典と再現手順` | R1 | fix | 出典が現ブランチに無く、自己完結性（AC-19）に触れる | 0 |
| `design.md/epoch 無しトークンの移行` | R1 | fix | 既存セッションの扱いが未記述 | 0 |

**Round 1 集計**: fix 49 / wont-fix 0 / defer 0（生指摘 B17 + W40 = 57 件を 49 Key に正規化）

## Round 2

Round 1 の Key と一致する既出指摘はゼロ（1ラウンド目の 49 件はすべて解消済み）。以下はすべて新規。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md:5.1/epoch ガード非通過の網羅性が偽` | R2 | fix | login step 5・saga 前進・退会前進が epoch を持ちえない | 0 |
| `design.md:6.3/signup saga のコーディネーター所有者` | R2 | fix | メール + SSO で bucket が2つになり跨ぐ DO が3つ以上になる | 0 |
| `design.md:6.6/SSO link 部分失敗の前進ジョブ不在` | R2 | fix | active な孤児 mapping が恒久的に回収されない | 0 |
| `design.md:5.4/リセットトークンの範囲検査不在` | R2 | fix | 未認証入力から任意の Directory DO を生成でき、判断軸 (iv) が無効化 | 0 |
| `design.md:6.8/鍵ローテーション中の一意性` | R2 | fix | 世代をまたいだ重複アカウント・到達性の奪取が起きる | 0 |
| `design.md:5.4/発行済みリセットトークンの無効化手段` | R2 | fix | credential 変更後もトークンが生き残る | 0 |
| `design.md:5.2.1/メール local 部の NFKC + lowercase 正規化` | R2 | fix | 登録者の所有しないメールボックスにアカウントを紐づけうる | 0 |
| `design.md:5.1/epoch ガードと現行認可ゲートの不整合` | R2 | fix | #37 引き継ぎが必要な修正を明示的に禁じている | 0 |
| `design.md:6.2.2/濫用抑止が標的型ロックアウトに転用可能` | R2 | fix | 脱出経路（リセット）も同じ設計で塞がれている | 0 |
| `design.md:4.7/.overloaded の翻訳場所` | R2 | fix | DO 内で捕捉不能なものを「DO 側で翻訳」と断定している | 0 |
| `design.md:7.4/alarm 先頭の再武装と write-buffer` | R2 | fix | CPU 超過エビクションで再武装が失われる | 0 |
| `design.md:6.2.2 vs 7.6/レート制限時のジョブ行` | R2 | fix | 正面から矛盾し、塞いだはずの列挙オラクルが開く | 0 |
| `design.md:11.1/走査カバレッジ主張が事実と不一致` | R2 | fix | #35 が本設計に矛盾する spec を取りこぼす | 0 |
| `design.md:4.1.1/credential_mappings の列定義不一致` | R2 | fix | 予約 TTL 列が未定義で `sweep-reservations` の述語が組めない | 0 |
| `.adr/003/FTS5 非公式挙動への依存がトレードオフに無い` | R2 | fix | 影響節の欠落。判断を覆すときの材料になる | 0 |
| `.adr/002/ADR-002 の去就が条件形のまま` | R2 | fix | design.md で決着済みなのに永続台帳が未確定に見える | 0 |
| `.adr/002/直列化のトレードオフが無い` | R2 | fix | 1利用者のリクエストが1オブジェクトに直列化する帰結は波及が大きい | 0 |
| `design.md:6.8/ローテーション中の login fail closed 窓` | R2 | fix | 移送済みユーザーがログインできない窓ができる | 0 |
| `design.md/epoch を進める操作一覧の食い違い` | R2 | fix | SSO link の扱いが節ごとに異なる | 0 |
| `design.md:6.1/failedAttempts の更新経路` | R2 | fix | 照合が request Worker 側なので login 手順に更新が無い | 0 |
| `design.md:5.4/OAuth 認可コード・PKCE の置き場所` | R2 | fix | token エンドポイントには根拠が当てはまらない | 0 |
| `design.md:4.3/表に現れない件数と行数の誤り` | R2 | fix | 実測34件・33行と食い違う | 0 |
| `design.md:2.1/Free の per-object 上限` | R2 | fix | 公式は 1 GB と明記しており事実に反する | 0 |
| `design.md:4.3/行27・ADP-export-001 の欠落` | R2 | fix | 結論を書いている行に根拠 ID が無い | 0 |
| `design.md:6.8/rotate-remap 再実行の巻き戻し` | R2 | fix | 新しい `passwordVerifier` が巻き戻る | 0 |
| `design.md:7.6/生リセットトークンの置き場所` | R2 | fix | `jobs.payload` へ恒久化する方向になっている | 0 |
| `design.md:3.2/新設3秘密と secrets.ts の構築境界` | R2 | fix | ブランド型・入れ子によるクライアント漏えい防止を引き継いでいない | 0 |
| `design.md:6.6/退会と PITR 30日窓` | R2 | fix | 「bucket 側に何も残さない」と両立しない旨が未記載 | 0 |
| `design.md:5.4/AI トークン非失効の補償` | R2 | fix | 補償が「ドキュメント」のみで実効性が無い | 0 |
| `design.md:8.2/トランザクション内でジョブ行を書く経路` | R2 | fix | `collectEvents` 廃止後の UoW 契約に無い | 0 |
| `design.md:9.2/ジョブ内部のチェックポイント刻み幅` | R2 | fix | `migrate-bulk` / `reindex` の刻みが未定義 | 0 |
| `design.md:7.1/surrogate rowid の UNIQUE・索引` | R2 | fix | 要求が無く、引用元の第4.4節に該当記述も無い | 0 |
| `design.md:7.7/非同期実行契約の正文が二重記述` | R2 | fix | 一方向宣言で第7.4/7.6節と重複している | 0 |
| `design.md:10.1/PITR の対象 DO 特定手段` | R2 | fix | 事実表 #5（列挙 API 不在）と衝突する | 0 |
| `design.md:1.1/読む順序リストの食い違い` | R2 | fix | 第4.1.1節が #35 の読む節リストから漏れている | 0 |
| `design.md:11.1/spec-inventory-frontend.md の欠落` | R2 | fix | #35 の受け入れ条件7の照合対象 | 0 |
| `design.md/Markdown スタイル（コードフェンス・疑似見出し）` | R2 | fix | コードフェンスの言語指定は必ず直す。太字はリスト内の用語強調を許容し、行頭単独の疑似見出しのみ直す | 0 |
| `design.md:8.2/OCC の変更行数取得` | R2 | fix | `rowsWritten` は課金単位。`changes()` を明示する | 0 |

**Round 2 集計**: fix 38 / wont-fix 0 / defer 0

## Round 3

Round 1 / 2 の Key と一致する既出指摘はゼロ。今ラウンドの指摘は2ラウンド目で新しく書いた節（鍵ローテーション・cross-DO saga・Alarm チェックポイント）の内部整合に集中しており、3軸に集約される。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md:6.8/ローテーションと credential 変更・signup 予約の相互作用` | R3 | fix | 旧パスワード復活と恒久ロックアウトが同時に成立する | 0 |
| `design.md:6.6/unlink の最後のログイン手段検査` | R3 | fix | 行数ベースの検査が2世代行・SSO の予約行を数え、自己ロックアウトする | 0 |
| `design.md:6.6/unlink の削除が2世代・2 bucket を覆わない` | R3 | fix | 解除済みクレデンシャルでログインできる | 0 |
| `design.md:5.1/クラス (3) に CAS も phase 条件も無い` | R3 | fix | `read-own-canonical` が PII 復号オラクル、`delete-mapping` がロックアウト原始関数になる | 0 |
| `design.md:5.1/RPC エントリ表の欠落（operator・OAuth token）` | R3 | fix | 「全数」を謳う表の漏れ | 0 |
| `design.md:5.1/RPC エントリ表の欠落（signup saga 再開・補償）` | R3 | fix | 同上。3エントリ不足 | 0 |
| `design.md:6.5.1/credential 変更 saga の locator 解決` | R3 | fix | 旧検証材料の取得経路が無く、ローテーション中の世代解決も無い | 0 |
| `design.md:6.8/rotate-remap を bucket の Alarm ジョブにする問題` | R3 | fix | 一時注入した routing key が Alarm 実行時に存在せず、秘密の配布境界が壊れる | 0 |
| `design.md:6.3/複数クレデンシャル signup の phase 3 部分成功` | R3 | fix | active 孤児 mapping が残り、その credential が恒久的に再登録不能 | 0 |
| `design.md:4.1.1/OCC の version 列が無い` | R3 | fix | 第8.4節「OCC は残す」が実装不能。列の正本を名乗る表の欠落 | 0 |
| `design.md:7.4/チェックポイント予算の経過時間が凍結する` | R3 | fix | Workers の `Date.now()` は I/O でしか進まず、CPU バウンドなジョブ列で発火しない | 0 |
| `design.md:7.4/due job が無いときに alarm を消す手順` | R3 | fix | 全 User Data DO が10秒間隔で永久に起き続ける | 0 |
| `design.md:4.1.1/OAuth 引き取り先 Issue 番号の誤り` | R3 | fix | #12 は OAuth 認可を持たない。#37 が誤った場所を探しに行く | 0 |
| `.adr/003/実測件数の食い違い` | R3 | fix | 「実測1件」と design.md の「実測2件」がずれている | 0 |
| `design.md:5.5/idFromName に渡せる経路の数え落とし` | R3 | fix | login step 5 が漏れている | 0 |
| `design.md:6.1/previous 世代への書き込みは削除だけ が誤り` | R3 | fix | 上記ローテーション Blocker の根本原因 | 0 |
| `design.md:6.2.2/ロックアウト脱出経路が rotation 中に成立しない` | R3 | fix | 脱出できない窓が開く | 0 |
| `design.md:4.3/deleteSourceLinksByMemo の署名` | R3 | fix | spec と食い違う | 0 |
| `design.md/内部自己参照の行番号ずれ` | R3 | fix | 第6.5.1節の参照が古い行を指す | 0 |
| `design.md:10.1/PITR 復旧後に AI 接続が復活する` | R3 | fix | 必須手順が `sessionEpoch` のみで失効済み接続を塞げていない | 0 |
| `design.md:5.2.1/local 部 lowercase と NFKC 却下論拠の衝突` | R3 | fix | 同じ節の中で論拠が矛盾している | 0 |
| `design.md:6.3/signup 重複エラーの列挙オラクル受容判断` | R3 | fix | 受容するなら受容と記録する（未記録は判断の欠落） | 0 |
| `design.md:5.4/generation 記号の二重使用` | R3 | fix | routing 世代と導出鍵の世代が同一記号で取り違えを誘発 | 0 |
| `design.md:7.6/「行が増えない」の断定が広すぎる` | R3 | fix | 同一 canonical に限った話 | 0 |
| `design.md:5.3/SSO login の IdP アサーション検証点` | R3 | fix | 設計に現れず、応答均一化も SSO 行に効かない | 0 |
| `design.md:8.4/SELECT changes() が spike 一覧に無い` | R3 | fix | 未検証のまま結論に使っている | 0 |
| `design.md:7.4/enqueueJob → setAlarm の実行主体と原子性` | R3 | fix | 回復策が dormant DO に効かない | 0 |
| `design.md:7.4/jobs の prune に kind も所有者も無い` | R3 | fix | 全数の正本を名乗る2表からの欠落 | 0 |
| `design.md:7.7/operationKey の収束が2つの意味を持つ` | R3 | fix | `send-mail` と `purge-trash` で相反する | 0 |
| `design.md:2.1/#27 の裏付け種別` | R3 | fix | 禁止規定の不在による推論を「公式記載」に分類している | 0 |
| `design.md:7.7/正文参照の自己記述が第8.4節で不成立` | R3 | fix | 自己記述が事実と食い違う | 0 |
| `design.md:9.1/exports 方式と #37 Issue 本文の矛盾` | R3 | fix | #35 の AC3 には訂正指示があるのに #37 側に無い | 0 |
| `design.md:11.2/#36 の引き継ぎ項目の取りこぼし` | R3 | fix | H-1〜H-8・`handlers.integration.test.ts`・`.tpl` の `main` 修正が落ちている | 0 |
| `design.md:5.1/check-previous-generation とクラス (3) の定義の食い違い` | R3 | fix | 未認証の request Worker から呼ばれるのにクラス (3) に置かれている | 0 |
| `design.md:4.1.1/AES-GCM nonce の置き場所` | R3 | fix | 列の全数の正本に無い | 0 |
| `design.md:7.4/alarm 先頭の再武装と migration ゲートの前後関係` | R3 | fix | 両方が「先頭」と書かれていて順序が未定 | 0 |
| `design.md:11.1/spec-usecases-review-002.md の判断` | R3 | fix | #35 Issue 本文が名指ししているのに走査除外の判断が無い | 0 |
| `design.md:1.1/読み順ガイドの自己矛盾` | R3 | fix | 「一覧に載っていない4つ」と「取り込んである」が衝突 | 0 |
| `design.md/#N 記法が事実番号と Issue 番号で衝突` | R3 | fix | #8 / #10 / #12 が両方の意味で使われている | 0 |
| `design.md/細かい引用のずれ2件` | R3 | fix | `spec/database/index.md:92` → `:90`、db スクリプト列挙の漏れ2本 | 0 |

**Round 3 集計**: fix 40 / wont-fix 0 / defer 0（生指摘 B13 + W26 + Notes 由来2 = 41 件を 40 Key に正規化）

## Round 4

### 再指摘の集約 — 構造的修正へ切り替える

`design.md:6.x/鍵ローテーション中の2世代並存` を根とする指摘が **R2・R3・R4 の3ラウンド連続**で別角度から出ている。

| ラウンド | 指摘 |
|---|---|
| R2 | security B-001（世代をまたいだ一意性）/ do-boundary W-001（移送中の login fail closed） |
| R3 | do-boundary B-001・W-002 / security B-002・B-003・B-005・B-006 |
| R4 | do-boundary B-001・B-002 / security B-001・B-002 / handoff B-001 |

本台帳の運用規則（`fix` 済みの箇所が別角度から3回以上再指摘されたら個別修正で追いかけず設計の問題として扱う）に該当する。**根本原因は「`hmac` が世代依存の値であるにもかかわらず、credential の世代非依存な同一性として使われていること」**（do-boundary N-005 が特定）。個別パッチではなく、**世代非依存の `credentialId` を導入する構造的修正**で R4 の Blocker 5件をまとめて解く。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md:6.x/hmac を世代非依存の credential 同一性に使っている（構造）` | R2 | fix（構造） | 3ラウンド連続の再指摘。世代非依存の `credentialId` 導入で B-001 / B-002 / B-004 / B-005 を同時に解く | 3 |
| `design.md:6.8/移送先の陳腐化を区別しない` | R4 | fix | リセット完了が旧世代 bucket に着地すると旧 `passwordVerifier` が正本に戻る | 0 |
| `design.md:7.4/反復・周期ジョブの再武装規則` | R4 | fix | 収束規則が再武装を構造的に禁じ、ゴミ箱の保持期限が無期限に伸びる | 0 |
| `design.md:5.1/(3-a) の守りが saga 開始エントリに成立しない` | R4 | fix | 読みだけ `callerToken` で束縛され、より強い書きが無束縛 | 0 |
| `design.md:5.1/reserve-credential の呼び出し元欠落` | R4 | fix | 「全数」を宣言する表の漏れ | 0 |
| `design.md:6.1.1/(R5) が SSO link を誤分類` | R4 | fix | link の対象は新 credential なので永続化済み locator が存在しない | 0 |
| `design.md:5.1/callerToken の脅威モデルの食い違い` | R4 | fix | request Worker へ返す設計と「request Worker 陥落に効く2層目」が矛盾 | 0 |
| `design.md:2.1/F-4b の裏付け種別` | R4 | fix | limits ページ FAQ が明示している。結論は不変 | 0 |
| `design.md:7.4/チャンク反復上限中断時の状態遷移` | R4 | fix | claim の CAS と食い違う | 0 |
| `design.md:6.8/ローテーション巻き戻し時の credential_locators` | R4 | fix | 恒久的な `credentialVersion` 不一致でログイン不能になりうる | 0 |
| `design.md:11.2/spike 件数の誤り` | R4 | fix | 「4件」と書いて実際は6件列挙、第11.4節は9行 | 0 |
| `testing.md/確認項目7・11 の期待結果が成立しない` | R4 | fix | 検証手順が現物に対して通らない | 0 |
| `design.md:11.1/collectEvents 行番号の欠落` | R4 | fix | 実測7箇所に対し6件 | 0 |
| `design.md:11.3/#37 対応項目3 の訂正指示欠落` | R4 | fix | 他2件には訂正指示があるのにここだけ無い | 0 |
| `design.md:5.3/report-login-result のガードが実装不能` | R4 | fix | bucket 側に照合材料が無い（悪用可能な差は無し） | 0 |

**Round 4 集計**: fix 15 / wont-fix 0 / defer 0（生指摘 B6 + W11 + Notes 由来1 = 18 件を 15 Key に正規化。うち1件は3ラウンド分の再指摘を集約した構造的修正）

## Round 5

R4 の構造的修正（`credentialId` 導入）は4層すべてが独立に「目的を達成」と確認。`design.md:6.x/hmac を世代非依存の credential 同一性に使っている（構造）` は**解決済み**として以降のラウンドで再審議しない。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md:6.4/signup phase 2 の無条件拒否と冪等性の矛盾` | R5 | fix | 応答喪失で正常なアカウントが `abandon-account` される | 0 |
| `design.md:7.4/再武装の駆動源クエリが作業述語と一致しない` | R5 | fix | どちらの読み方でも収束しない（恒久ループ or 1回で停止） | 0 |
| `design.md:6.8/巻き戻しが移送先行を無条件破棄する` | R5 | fix | (R7)「両側を CAS で守る」に反し、移送先に着地した中間状態を壊す | 0 |
| `design.md:4.1.1/credential_mappings.credentialId の非一意根拠` | R5 | fix | DO 命名規則（世代ごとに別 DO）と矛盾。UNIQUE を付ける | 0 |
| `design.md:6.6/unlink のガードが kind を見ない` | R5 | fix | `kind='email'` を解除でき、リセット経路を恒久的に失う | 0 |
| `design.md:7.7/正文 項2 と kind 全数表の矛盾` | R5 | fix | 「外部 I/O だけ／1件だけ」が12種の実態と食い違う | 0 |
| `design.md:9.x/CREATE INDEX がデータ量に依存しない は誤り` | R5 | fix | 単発適用の断定が大きな DO をブリックしうる | 0 |
| `design.md:8.2/recordOperation で targetLocators を書けない` | R5 | fix | 署名と代替経路の禁止が噛み合っていない | 0 |
| `design.md:11.2/ドメイン層イベント抽象が変更対象一覧に無い` | R5 | fix | Outbox 廃止で消えるのに #37 が拾えない | 0 |
| `design.md:5.4/リセットトークン tokenId のエントロピー要件` | R5 | fix | 鍵単独漏えいでトークンを偽造できる | 0 |
| `design.md:10.1/PITR restore が消費済みリセットトークンを復活させる` | R5 | fix | 乗っ取り復旧を巻き戻す。第6.9節の fail closed 宣言への反例 | 0 |
| `design.md:1.1/実参照の節数が実測と不一致` | R5 | fix | 31/14 に対し実測 41/19 | 0 |
| `testing.md/実測注記の乖離` | R5 | fix | 864行→906行、87件→95件（合否判定自体は通る） | 0 |
| `design.md:11.1/spec-adr-005 の参照側更新が2/6箇所` | R5 | fix | #35 の対応項目4 を満たさない | 0 |
| `design.md:5.1/read-own-canonical の選択キー` | R5 | fix | 認可は閉じているが実装が決まらない | 0 |
| `design.md:5.1/exchange-authz-code のガード列挙` | R5 | fix | `redirect_uri` 検証が無いまま完結集合として宣言している | 0 |
| `design.md:4.1.1/credential_locators.status の値域` | R5 | fix | 値域が未定義 | 0 |

**Round 5 集計**: fix 17 / wont-fix 0 / defer 0（生指摘 B2 + W12 + Notes 由来3 = 17 件）

## Round 6

### 再指摘の集約 — 2件目の構造的修正

`design.md/「全数」を名乗る表どうしが同期しない` を根とする指摘が **R3・R5・R6 の3ラウンド**で別角度から出ている。

| ラウンド | 指摘 |
|---|---|
| R3 | handoff B-003（第4.1.1節の列定義が第6章と不一致）/ async W-003（`jobs` の prune が2表に不在） |
| R5 | async W-001（第7.7節の正文と `kind` 全数表12種の矛盾）/ handoff N-010（`status` の値域未定義） |
| R6 | B-001（`jobs` の完了時刻列が2表に不在）/ B-002（駆動源クエリ表の2行欠落）/ B-003（`sweep-orphan-mapping` の投入点不在）/ B-005（ローテーション経路がクラス (3) の分類から漏れる）/ W-001（UoW 書き込み口が7分類中3つ）/ W-002（`.adr/004` が正文と食い違う）/ W-003（投入点の欠落2件）/ W-007（秘密の個数が実数と不一致） |

本台帳の運用規則に該当する。**根本原因は「全数」を名乗る表が7つあり、互いの整合を人手でしか確認できないこと。** 個別パッチではなく、**表どうしの整合を機械検証できる形にする構造的修正**で対処する。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md/「全数」表どうしの相互整合（構造）` | R3 | fix（構造） | 3ラウンド分の再指摘。整合の不変条件を明文化し機械検証できる形にして B-001〜B-003・B-005・W-001〜W-003・W-007 をまとめて解く | 3 |
| `design.md:7.5/retention 延長時に nextRunAt を後ろへ動かせない` | R6 | fix | 収束規則の適用範囲・第4.1節・第7.5節の3箇所が矛盾する | 0 |
| `design.md:6.8/rotate-remap の競合分岐に記録先が無い` | R6 | fix | `poison` / `terminalReason` を要求するが `jobs` 行も `operations` 行も持たない | 0 |
| `design.md:5.1/cancel-reservation の status 非依存削除` | R6 | fix | `operationId` のログ出力許可と組み合わさり恒久ロックアウト原始関数になる | 0 |
| `design.md:11.1/SSO 専用アカウントへのリセットメール` | R6 | fix | 未決のままだと「メール到達性だけでパスワードを設定できる」経路が開く | 0 |
| `design.md:2.1/F-1 の表構造の描写` | R6 | fix | limits ページの表にプラン列は無い（不整合という結論自体は正しい） | 0 |
| `design.md:2.1/F-21 の日付と F-5 の API 一覧` | R6 | fix | changelog 日付が実際と異なり、`getByName` / `jurisdiction` が欠落 | 0 |
| `design.md:5.5/locator 出所の例示` | R6 | fix | `operations.targetLocators` を覆っていない（総則は覆っている） | 0 |
| `design.md:11.3/.thread/36 が未 commit` | R6 | fix | #37 の入力として名指ししているのにリポジトリに存在しない | 0 |
| `testing.md/確認項目14・17 の期待結果` | R6 | fix | 実行して不一致（2件検出 / 実測7件） | 0 |

**Round 6 集計**: fix 10 / wont-fix 0 / defer 0（生指摘 B5 + W11 + Notes 由来3 = 19 件を 10 Key に正規化。うち1件は3ラウンド分の再指摘を集約した構造的修正で8指摘を含む）

## Round 7

R6 の構造的修正（第1.4節の不変条件 I-1〜I-8 と機械検査）は4層すべてが検査1〜7 を実行して全項目パスを確認。`design.md/「全数」表どうしの相互整合（構造）` は**解決済み**として再審議しない。ただし検査に3つの穴が残っており、今ラウンドの Blocker 2件と W-001 がそこをすり抜けたので、検査自体を補強する。

| Key | 初出 | 判定 | 理由（一行） | 再指摘 |
|---|---|---|---|---|
| `design.md:6.8/rotation_checkpoints を2種のローテーションが共有` | R7 | fix | 片方の完了記録が他方の旧鍵破棄条件を誤成立させる。B-002 と同根 | 0 |
| `design.md:6.8/移送が古い encryptionGeneration の行を完走済み bucket へ運ぶ` | R7 | fix | 再武装経路が無いまま暗号化旧鍵が退役しうる | 0 |
| `design.md:1.4/検査の穴3件（I-2 重複・I-4 逆向き・散文の数え上げ）` | R7 | fix | 今ラウンドの Blocker 2件と W-001 がここをすり抜けた。再発防止として検査を補強する | 0 |
| `design.md:1.3/先行案の件数と保留ゼロの主張` | R7 | fix | 表14行および #19 の実体と不一致 | 0 |
| `design.md:9.3/reindex の内部カーソルの永続先` | R7 | fix | E-1 の `jobs` 12列にも `migration_progress` にも第8.2節の口にも無い | 0 |
| `design.md:7.4/claim の CAS 述語と deleteAlarm の発火条件` | R7 | fix | `done`/`poison` 行を再 claim しうる。発火条件が節内で2通り | 0 |
| `design.md:4.7/retryable 欄が実装と食い違う` | R7 | fix | `RETRYABLE_SYSTEM_CODES` の実体と不一致 | 0 |
| `design.md:6.8/previous 世代の鍵の所持証明が鍵漏えい時に成立しない` | R7 | fix | 漏えい鍵の失効手段を漏えい鍵の保持者が無効化できる | 0 |
| `design.md:5.4/AI 接続の自動失効が最頻の乗っ取り系列で空振り` | R7 | fix | `createdAtCredentialVersion` 1世代分では接続作成→パスワード変更を覆えない | 0 |
| `design.md:7.7/類型名と第7.4節 (iii) の対象集合が別の軸` | R7 | wont-fix | レビュアー自身が「必須ではない」と明記。両者が別の軸であることは本文から読み取れる | 0 |

**Round 7 集計**: fix 9 / wont-fix 1 / defer 0（生指摘 B2 + W6 + 検査の穴3 + Notes 由来1 = 12 件を 10 Key に正規化）
