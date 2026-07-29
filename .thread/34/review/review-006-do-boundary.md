# レビュー 006 — DO 境界・ルーティング・cross-DO saga

**対象:** PR #43 / ブランチ `issue/34/do-boundary-design` / Issue #34
**レビュー観点:** DO 境界・ルーティング・cross-DO saga
**日付:** 2026-07-30
**方針:** 前回までの指摘を前提にせず、ゼロベースで再走査した。

## 検証の方法

1. `.thread/34/design.md` 全2,047行を通読。
2. `spec/inventory/adapter.md` の `ADP-*` 台帳を機械走査し、第4.3節の数値・ID・契約内容を全件照合。
3. design.md が引用する実装コードの事実48件を、実ファイル（パス + 行番号 + 行数 + 存在／不在）で照合。
4. Cloudflare 公式ドキュメント11ページを実際に取得し、第2.1節の事実表 F-1〜F-32 を原文と照合。
5. RPC エントリ表（第5.1節）・cross-DO 操作表（第6.4節）・締め出し経路一覧（第6.9節）・`jobs.kind` 全数表（第7.4節）・テーブル全数表（第4.1.1節）の相互整合を突き合わせ。

## DO 境界・ルーティング

### Blockers

- **[B-001]** `sweep-orphan-mapping` を投入する箇所が本文のどこにも無く、代替の再武装規則も適用できない。unlink の孤児 mapping が恒久的に回収されない。
  - 場所: `.thread/34/design.md:1001`（第6.6節 unlink 手順2）/ `.thread/34/design.md:1259`（第7.4節 cross-DO saga 前進ジョブの所有規則）/ `.thread/34/design.md:1275-1279`（第7.4節「周期・反復ジョブの再武装規則」(1) の駆動源表）/ `.thread/34/design.md:1312`（第7.4節 (iii) の `sweep-*` glob）
  - 理由: 他の cross-DO saga はいずれも起点手順で前進ジョブを明示的に投入している — link 手順1 は「同時に自 DO の job table へ `resume-link` を投入する」（`:981`）、退会 手順1 は「同時に `kind: 'finalize-withdrawal'` のジョブを投入する」（`:1017`）、credential 変更 phase 1 は「同時に自 bucket の job table へ `resume-credential-change` を投入する」（`:941`）。**unlink 手順2（`:1001`）だけがこの一文を持たない。** そのうえ第7.4節の中で `sweep-orphan-mapping` の分類が2箇所で食い違う — `:1259` は「cross-DO saga を前進させるジョブ（`finalize-withdrawal` / `sweep-orphan-mapping` / `resume-link` / …）」としてバックオフ駆動の前進ジョブ側に置くが、`:1312` は `sweep-*` glob に含めて「`sweep-*` は自分の駆動源（同節 (1) の表）を完了時に読み直して `nextRunAt` を設定する」と要求する。ところが (1) の駆動源表（`:1277-1279`）の行は `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` の3つだけで、`sweep-orphan-mapping` の行が無い。しかも同表の駆動源の定義は「作業述語から**時刻条件だけ**を外したもの」であり、`sweep-orphan-mapping` の作業述語（`operations` の未完了 unlink 行）には時刻条件が無いので、規則が構造的に当てはまらない。**結果として、投入点も再武装規則も本文が与えていない唯一のジョブになっている。**
    - 発火する失敗は本設計が Blocker 級と自認している経路そのものである。unlink 手順2 が完了して手順3 が落ちると、Directory に `active` な孤児 mapping が残る。login は第5.3節 step 5 (ii) の到達性検査で fail closed に拒否されるので認可は開かないが、**利用者は同じ SSO 主体を再 link できない**（link 手順2 の予約が `(kind, hmac)` の一意制約に当たる。`:982`）。第6.6節（`:977`）は link について同じ状態を「その SSO 主体の永久ロック」と呼び、第6.9節（`:1118`）は締め出し経路として登録している。第6.4節の cross-DO 操作表（`:891`）は片付ける主体を `sweep-orphan-mapping` と名指ししているので、**設計の意図としては塞がっているのに、そのジョブが起動する経路が本文に無い。**
    - `:1312` の指示どおりに実装しようとすると、#37 は (1) の表に自分の行が無いことに気づき、時刻列を持たないジョブに対して `min(...)` を発明することになる。逆に `:1259` に従えばバックオフ駆動の前進ジョブになるが、その場合でも投入点は本文に無い。
  - 提案: 2点を足す。**(1) 第6.6節 unlink 手順2（`:1001`）に「同時に自 DO の job table へ `sweep-orphan-mapping` を投入する」を明記する**（link 手順1・退会 手順1・credential 変更 phase 1 と同じ一文）。**(2) 第7.4節 (iii)（`:1312`）の `sweep-*` glob から `sweep-orphan-mapping` を外し、`:1259` の分類（saga 前進ジョブ = 通常のバックオフ／`attempt` 駆動）に一本化する。** (1) の駆動源表は時刻駆動の周期ジョブ専用であることを表の直前に1行で断っておくと、`rotate-encryption` についての同じ曖昧さ（N-003）も同時に閉じる。

### Warnings

- **[W-001]** `rotate-remap` の競合分岐が `poison` / `terminalReason` を要求しているが、同じ節が「`rotate-remap` は `jobs` 行も `operations` 行も持たない」と決めているため、記録先が存在しない。
  - 場所: `.thread/34/design.md:1066`（第6.8節 手順2 (2) の第2分岐）。矛盾する相手は `.thread/34/design.md:255`（第4.1.1節 Directory `jobs` の `kind` 全数）/ `:1048`・`:1257`（`rotate-remap` は Alarm ジョブではない）/ `:1087`（ローテーション経路は `operations` 行を作らない）
  - 理由: `:1066` は「**行があって `userId` が異なる** → 移送せず `poison` にし、`terminalReason` を残して運用へエスカレーションする」と書く。`poison` は `jobs.status` の値、`terminalReason` は `jobs` / `operations` の列である（`:1234` / `:1238` / `:250`）。ところが本設計は改稿で `rotate-remap` を Alarm ジョブから operator の maintenance 経路が駆動する同期 RPC へ変更し、`jobs.kind` の全数表からも第4.1.1節の Directory `jobs` 行からも明示的に外している（`:255` / `:1257`）。さらに `:1087` が「ローテーション経路は `operations` 行を作らない、と決め切る」と断定している。`rotation_checkpoints`（`:256`）が持つ列は `bucketIndex` / `generation` / `previousCount` / `scannedAt` の4つだけで、`terminalReason` に相当する列が無い。**つまりこの分岐は書ける先を1つも持たない。** 改稿前（Alarm ジョブだった時点）の記述が残った箇所と読める。
    - 実害は限定的である。この分岐は第6.1節 (c) の世代跨ぎ一意性検査が既に破れている場合にしか発火せず、記録できずにスキップしても `previousCount` が0にならないので退役条件（`:1088`）が満たされず、ローテーションが可視的に停止する（安全側）。ただし「自動で解決しない」ケースの運用受け口が未定義のまま #38 へ流れる。
  - 提案: 記録先を1つ決める。`rotation_checkpoints` に `conflictCount` / `lastConflictAt`（あるいは bucket 単位の `terminalReason`）を足して第4.1.1節の当該行を更新するか、maintenance 経路の同期 RPC が値エンベロープで衝突を返して operator 側のログに残す形にするか、のいずれか。**`poison` / `terminalReason` という語は `jobs` 専用なので、この分岐からは外す。**

- **[W-002]** 第2.1節 F-1 が出典の構造を実際と異なる形で描写している（結論は変わらない）。
  - 場所: `.thread/34/design.md:103`（F-1 の直後の補足段落）。関連: `:67`（F-1 の行）
  - 理由: 本文は「limits ページの表は 10 GB を "Storage per Durable Object" として **Workers Paid 列**に置く一方、同じページの storage-full の説明が…」と書くが、公式の limits ページを実際に取得して確認したところ、SQLite-backed の表は **`Feature` / `Limit` の2列**でありプラン別の列は存在しない。該当行は `Storage per Durable Object | 10 GB` に脚注3が付き、その脚注3は「Accounts on the Workers Free plan are limited to 5 GB total Durable Objects storage」= **アカウント合計**についての注記である。
    - **「表と本文のあいだに公式内の不整合がある」という結論そのものは正しい** — 表は per-object 10 GB を無条件に提示し、本文（storage-full の節）は「10 GB on Workers Paid, or 1 GB on the Free plan」と per-object の Free 値を述べているからである。したがって「ローカル / Free での検証時は 1 GB が先に当たる」という #37 / #38 への指示も有効なままである。誤っているのは出典の描写だけだが、第2.1節は「本節が設計の依拠する事実の正本である」と宣言し、種別（公式記載／実測／未確認）の区別を落とさないことを自ら要求しているので、出典の描き方の誤りは同節の性格上そのまま残せない。
  - 提案: `:103` の「Workers Paid 列に置く」を「プラン列を持たない表に無条件の値として置く」へ直す。数値（Paid per-object 10 GB / Free per-object 1 GB / Free account 5 GB / Paid account 無制限、上限到達時は書き込みだけが `SQLITE_FULL` で落ち読みと `DELETE` は通る）はいずれも原文どおりで、訂正は不要。

### Notes

- **[N-001]** 第2.1節の出典精度で軽微な差が2件ある。いずれも結論に影響しない。
  - **F-21 の changelog 日付**（`.thread/34/design.md:88`、第1.3節からも参照）— 宣言的 `exports` の changelog は **2026-07-04**（"Declare Durable Object class lifecycle with `exports`"）で、本文の「2026-06-30」ではない（6/30 は memory usage metrics の別エントリ）。内容側の4主張（`exports` と `migrations` は排他で両方含む設定は検証で拒否される / `exports` の namespace は常に SQLite backend / storage type は生成後不変 / `exports` 経由の削除に Trash は無く tombstone デプロイ前に退避が要る）は**すべて原文で確認できた**。
  - **F-5 の namespace API 一覧**（`.thread/34/design.md:72`）— 本文は「`idFromName` / `idFromString` / `newUniqueId` / `get`」の4つを挙げるが、実際の namespace ページは `getByName` と `jurisdiction` を含む6メソッドである。**列挙手段が無いという結論は変わらない**（追加の2つも列挙メソッドではない）。同じ文書の F-6（`:73`）が `getByName()` に言及しているので、内部でも4つ列挙のほうが古い。
  - それ以外の F-2 / F-3 / F-4 / F-4b / F-6〜F-10 / F-15〜F-20 / F-22〜F-25 / F-27 / F-27b / F-28〜F-32 は、原文（引用文を含む）まで一致することを確認した。とくに F-4b の2文（FAQ の "HTTP request, WebSocket message, or Alarm" と footnote 4 の "Each incoming HTTP request or WebSocket message resets…"）、F-29 の "Alarms are modified using the Storage API, and alarm operations follow the same rules as other storage operations."、F-30 の戻り値不整合、F-32 の3文は逐語で再現できた。F-10 の否定側（`bm25` / `snippet(` / `highlight(` / `trigram` / `tokenizer` が sqlite-storage-api ページに1語も現れないこと、仮想テーブルの一般的禁止規定も存在しないこと）も機械的に確認した。

- **[N-002]** 第5.5節 1 の「DO 側が使ってよい locator」の例示が、SSO link 手順2 / `resume-link` の経路を覆っていない。
  - 場所: `.thread/34/design.md:663`
  - 理由: 総則は「呼び出し側の DO が自分の SQLite に**永続化済みの locator**だけである」で、これは `operations.targetLocators` を含むので保証そのものは破れていない。ただし直後の例示が「User Data DO → Directory bucket は **`credential_locators` に記録済みの locator**、Directory bucket → User Data DO は `credential_mappings` 行が持つ `userId`」の2つだけで、**link 手順2 の対象 credential はまだ `credential_locators` に無い**（記録は手順4）。出所は手順1 で書いた `operations.targetLocators` である（`:981`）。第6.1.1節 (R5)(iii)（`:712`）は「link の起点では検証済みアサーション由来の `subject` が request Worker の手元にある」と明示しており設計としては閉じているが、本節が「列挙から漏れると #37 が本項を型・モジュール境界へ落とした時点で login が書けなくなる」と自ら警告している性格の一覧なので、`operations.targetLocators` を例示に1つ足しておくと `resume-link` の実装で迷わない。

- **[N-003]** 周期・反復ジョブの初回投入点と `rotate-encryption` の再武装も本文に明示が無い（B-001 と同型だが実害は小さい）。
  - 場所: `.thread/34/design.md:1275-1279`（(1) の駆動源表）/ `:1312`
  - 理由: `sweep-reservations` / `sweep-reset-tokens` は (1) の駆動源表に行を持つので、一度動けば自力で再武装できる。初回投入点（予約行を書いた時点 / トークン行を書いた時点）は本文に無いが、`operationKey` が定数で収束規則（`:1265`）が効くため、実装上の自由度が残っているだけで矛盾ではない。`rotate-encryption` は `:1312` で「1回の起動で処理する行数に (iii-a) と同じ上限を掛け、残りを次の起動へ回す」の対象に入っているが、続く一文が駆動源の読み直しを `sweep-*` にしか課しておらず、(1) の表にも行が無い。B-001 の提案（(1) の表を時刻駆動の周期ジョブ専用と断る）を採れば、`rotate-encryption` は `previousCount > 0` を残件条件とする自前の再武装として書ける。

- **[N-004]** 観点内で確認できた良い点（指摘ではない）。
  - **ルーティングの構造的保証は成立している。** `idFromName` に到達できる `userId` の出所3経路（署名済みトークンの検証結果 / signup で `IdGenerator` が採番した候補値 / Directory の RPC 戻り値）はいずれも「サーバーが採番して永続化した値」で、外部入力が到達する経路は見当たらなかった。第6.3節が `operationId` / 候補 `userId` のクライアント供給を明示的に棄却し、その代わりに「リクエスト跨ぎの再送という概念を signup に持ち込まない」へ倒しているのは、`idFromName` の引数汚染を根から断つ形になっている。
  - **未認証経路からの DO 生成は塞がっている。** リセットトークンの `{generation}.{bucketIndex}` に対する範囲検査を「locator を導出する**前に** transport 境界で」行い、検査を通らないトークンは DO を一切叩かずに拒否する（第6.1節 (d)）ことで、第6.2節の判断軸 (iv) が実際に成立する。User Data DO 側についても、判断軸 (iv) を当て直して signup の phase 順を「Directory 予約 → User Data 初期化」へ入れ替えている。
  - **`callerToken` の脅威モデルが誇張されていない。** 「request Worker 内でコード実行を得た攻撃者に対しては防壁にならない」「1層目が破られた時点で `callerToken` も同時に破られる」と正直に書いたうえで、それでも `SESSION_SECRET` を持たない binding 保有者に対しては実効があるから廃止しない、という結論の出し方になっている。`purge-user-mappings` を「本表で最も危険なエントリ」と名指しし、束縛不能な理由（トークンが失われた行と一緒に消える）まで書いているのも同様。
  - **鍵ローテーション中の2世代並存の規則が1箇所（第6.1.1節 R1〜R9）に集約され、各手順から一貫して参照されている。** 削除（R3）・数え上げ（R4）・locator 解決（R5）・移送スキップ（R6）・両側 CAS（R7）・全世代同時更新（R8）・新旧比較（R9）が、第6.3節 / 第6.4節 / 第6.5.1節 / 第6.6節 / 第6.7節 / 第6.8節のどの手順からも `credentialId` をキーとして参照されており、`(kind, hmac)` を世代非依存の同一性として使っている箇所は残っていない（第6.9節の後半4行がその根を明示している）。`credential_locators` の一意性 `(credentialId, generation)` と `credential_mappings` の bucket 内 `credentialId` UNIQUE が、DO 名に世代が入るという自分の決定と整合していることも確認した。
  - **台帳との突き合わせが実測どおりだった。** 第4.3節が主張する数値はすべて再現できた — 台帳の distinct `ADP-*` = **85**、表が引用する distinct = **53**、表に現れないのは **32**、表の実行数 **35行**（枝番込み）。引用されている53件はすべて台帳に実在し、契約内容も一致した。表に現れない32件（identity 2 / memo 9 / knowledge 18 / trash 3）を全件リストアップして述語 (a)(b)(c) を当て直したが、**ユーザー境界に閉じないのに表から漏れている行は1件も無かった**。行25b の `ADP-knowledge-027` の「documents 側 JOIN」規則、行29 / 行30 の4つの行番号参照、`ExportRenderer.render` が台帳から漏れているという指摘も、いずれも実ファイルで確認できた。
  - **引用している実装の事実48件が、行番号・行数・存在／不在まで実物と一致していた。** `currentUser.ts:17-26/28-33`、`authState.ts:18-23`、`errorResponse.ts:70`、`valueObject.ts:45-62/47/125/142`、`entity.ts:36/52/77/103/120`、`d1/unitOfWork.ts:39` の JSDoc 原文、`schema.ts:118`、`helpers.ts:55-69`、`0000_initial.sql:46,47` と実在テーブル4つ、`di/types.ts:53/70`、`server.cloudflare.ts:4,33,44`、各ファイルの行数（`entity.ts` 227 / `event.ts` 81 / `events.ts` 62 / `buildDecoder.ts` 37 / `eventRelayWorker.ts` 301 / `outboxPrune.ts` 25 / `pendingBatch.ts` 98 / `handlers.ts` 138 / `wrangler.toml` 162 / d1 20ファイル2,514行）まで一致。不在の主張（`findBySsoIdentity` / `AiClientConnection` 型 / `TokenScope` / OAuth 実装 / `server.state.ts` / `wrangler.toml` の DO バインディング）も0件で確認できた。
  - **RPC エントリ表（第5.1節）は本文が導入したエントリを漏らしていなかった。** クラス (2)(3) の全数宣言に対し、本文（第5.3節・第5.4.1節・第6.3〜6.8節）から RPC を洗い出して突き合わせたが、表に無いエントリは見つからなかった。`begin-credential-change` がクラス (2) の行を持ちながら守りの分類は (3-d) である、という食い違いも本文側に明記されている。
