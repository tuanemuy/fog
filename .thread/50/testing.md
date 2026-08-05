# 動作確認計画 — Issue #50: [設計訂正] User Data DO + DOローカルOutboxへ移行し、ドメインイベント配送を維持する

**Issue:** #50
**作成日:** 2026-08-06

---

## 確認環境

このIssueの変更を確認するために必要な手順のみ記載（プロジェクト全体のセットアップは省略）。

本 Issue の成果物は `.adr/013`（新規）・`spec/**`・`CLAUDE.md`・`.thread/50/**` の Markdown だけで、**プロダクションコード・wrangler 設定・DB migration には1行も触れない**（plan.md 前提節 / AC-32）。したがって確認はすべて、リポジトリルートでの `git` / `grep` / `ls` / `pnpm lint` / `pnpm format:check` と、ドキュメントの読み下しで完結する。

### 前提

- コマンドはすべてリポジトリルート（`/Users/hikaru/github.com/tuanemuy/fog`）で実行する。
- **成果物を commit した状態で検証する。** 本計画の非変更検査（確認項目11 / 12）と差分範囲検査（確認項目1）は `git diff main...HEAD` を基準にしており、commit 前に走らせると差分が空になって「証明ではなく空振り」で全部通ってしまう。
- 検査を回す前に、`.thread/50/` の作業ファイルが未 commit のまま残っていないことを確認する。

  ```bash
  git status --porcelain
  ```
- 本計画に載せた「改訂前の値」は、着手時点の `main` で実測した値である（確認項目14 の表を参照）。改訂前に同じコマンドを1度流して値が一致することを確かめてから改訂後の比較に入ると、コマンド自体の誤りと改訂の誤りを切り分けられる。

### 検証環境の起動

**なし。** 本 Issue はドキュメントのみの変更で、UI もサーバー挙動も変わらないため、アプリケーションを起動して確認する対象が存在しない。

- 差分に `apps/` / `packages/` / `infra/` / `*.toml` / migration SQL が1行も入らないことが受け入れ条件そのものである（AC-32）。起動して挙動が変わる対象は定義上ゼロ。
- 参考: このリポジトリでローカルにアプリを起動する手段は `pnpm dev`（= `pnpm dev:cf`）だけであり、`pnpm start` / `pnpm preview` は Issue #40 により起動しない（`README.md`「Development commands」/ `CLAUDE.md` Reference runtime 節に記載）。本 Issue の確認では**いずれも使わない**。
- 同じ理由で `pnpm typecheck` / `pnpm test` / `pnpm test:unit` / `pnpm test:integration` も本 Issue の合否には使わない（入力となるソースを1行も変更しないため）。実行しても改訂前と同じ結果しか出ない。

### デプロイ方法

**なし**（検証環境の起動も不要で、リポジトリ上の検査だけで確認できる）。

- `pnpm deploy:staging*` / `pnpm deploy:production*`・`pnpm db:migrate*` / `pnpm db:apply:*`・`pnpm cf:render:staging` / `cf:render:production` はいずれも本 Issue の差分に入力を与えない（AC-32 でそれらの設定ファイルへの変更を禁じている）。

---

## 確認項目

各項目の見出しに **【機械】**（コマンドの出力だけで合否が決まる）と **【読解】**（本文を読んで判断する）を付ける。両方を含む項目は **【機械+読解】**。

### 1. 差分範囲・lint・format 【機械】

- **対応する受け入れ基準:** AC-32 / AC-33
- **目的:** PR の差分がドキュメントに閉じており、プロダクションコード・wrangler 設定・DB migration を1行も含まないこと、および Biome が通ることを確認する
- **手順:**
  1. 差分に現れるパスの全数を見る

     ```bash
     git diff main...HEAD --name-only
     ```
  2. 禁止領域が1件も無いことを検査する

     ```bash
     git diff main...HEAD --name-only \
       | grep -vE '^(\.adr/|spec/|CLAUDE\.md$|\.thread/50/)' \
       && echo "NG: 対象外のパスがある" || echo "OK: 対象外パス 0件"
     ```
  3. 禁止領域を名指しでも確認する

     ```bash
     git diff main...HEAD --name-only \
       | grep -E '^(packages/|apps/|infra/)|\.toml$|migrations?/.*\.sql$' \
       && echo "NG" || echo "OK"
     ```
  4. Biome を通す

     ```bash
     pnpm lint
     pnpm format:check
     ```
- **期待結果:** 手順2・3 がどちらも `OK`（grep が1件も返さない）。手順4 は両方とも **exit 0**。改訂前の実測でも両方 exit 0（`pnpm lint` は `Checked 150 files ... Found 2 infos`、`pnpm format:check` は `Checked 167 files`）なので、**infos の件数が2から増えていないこと**も併せて見る
- **確認ポイント:** `pnpm lint` / `pnpm format:check` は Markdown 主体の差分ではほぼ無風になるが、**受け入れ条件19 に明記されている**ので必ず実行して exit 0 を記録する。手順1 の一覧に `.thread/50/` 以外の `.thread/` が現れたら、他 Issue の作業ログを巻き込んでいる

### 2. `.adr/013` の新設と supersede 範囲の限定 【機械+読解】

- **対応する受け入れ基準:** AC-1 / AC-2 / AC-3 / AC-4
- **目的:** 新 ADR が既存 ADR と同じ体裁で `013` として増えており、`.adr/004` の **Outbox 廃止部分だけ**を supersede していること、ローカル同期 commit（第1項）と機構そのもの、`.adr/002` の DO 集約、`.adr/003` / `.adr/005` の FTS5 同期更新を**巻き込んでいない**ことを確認する
- **手順:**
  1. 採番と件数を見る（改訂前は `001`〜`012` の12件）

     ```bash
     ls -1 .adr/ ; ls -1 .adr/ | wc -l
     git diff main...HEAD --name-status -- .adr/
     ```
  2. 節構成が既存 ADR と同一かを検査する

     ```bash
     diff <(grep '^## ' .adr/013-*.md) \
          <(printf '## ステータス\n## コンテキスト\n## 決定\n## 検討した代替案\n## 影響\n') \
       && echo "5節 OK"
     ```
  3. `.adr/004` / `.adr/005-search-projection-inside-write-transaction.md` / `spec/adr/005-search-index-via-outbox.md` が**ステータス節だけ**の変更であることを差分で見る

     ```bash
     git diff main...HEAD -- .adr/004-do-local-commit-and-alarm-jobs.md \
       .adr/005-search-projection-inside-write-transaction.md \
       spec/adr/005-search-index-via-outbox.md
     ```
  4. `.adr/013` の「検討した代替案」節を読み、Issue 本文の4案が全部あることを確認する
  5. `.adr/013` の「ステータス」節と「影響」節を読み、supersede の範囲と `.thread/34/design.md` の失効宣言5節を確認する
- **期待結果:**
  - 手順1: `.adr/` が **13件**。差分は `A .adr/013-*.md` / `M .adr/004-*.md` / `M .adr/005-*.md` の**3行**。`.adr/001`〜`.adr/003` / `.adr/006`〜`.adr/012` に `M` が付かない。**`.adr/005` が `M` なのは、`.adr/013` が検索の更新方式に触れていないことを `.adr/005` 側からも辿れるようにステータス節へ注記を足したため**であり、本文（コンテキスト・決定・代替案・影響）は無改変である（手順3 で確認する）
  - 手順2: `5節 OK`
  - 手順3: 差分の追加行が**ステータス節の中にだけ**現れる。コンテキスト・決定・検討した代替案・影響の各節に `+` / `-` が1行も無い（AC-3）
  - 手順4: (1) 各業務 DO に Outbox + Alarm relay = **採用** / (2) 専用 Outbox DO = 不採用 / (3) すべて `jobs` + Alarm = 不採用 / (4) transaction 内で外部 I/O = 不採用 の**4案すべて**に不採用理由が書かれている。加えて撤回した旧案（`dedupe_key` / 3分岐応答 / `last_reset_requested_at` 相乗り / 窓掃除に新 `kind` / consumer を3本目の Worker / relay を `jobs.kind` に）も記録されている（AC-2）
  - 手順5: **supersede するのは `.adr/004` の決定第3項（ドメインイベント transport の廃止）と、第2項のうち「外部 I/O を伴う処理は必ずこちらに載る」という十分条件だけ**であり、**永続ジョブと Alarm という機構そのものと第1項（ローカル同期コミット）は有効**と明記されている。`.adr/002` の DO 集約と `.adr/003` の FTS5 単独検索・`.adr/005` のトランザクション内 projection を**維持する**と明記されている（AC-1）
  - `spec/adr/005` のステータス節に「**本 ADR を検索 indexer consumer の復活根拠に使わない**」が入っている（AC-4）
- **確認ポイント:** `.adr/004` の注記が「第2項は有効」とだけ書いて終わっていないか。第2項の十分条件も失効させないと、本 Issue が訂正した当の論点で「外部 I/O は必ず `jobs` に載る」という失効した根拠が生き残る（plan.md AC-3 / steps.md ステップ2）。`.thread/34/design.md` の失効宣言が **7.3 / 7.4 / 7.6 / 7.7 / 1.4 の5節**であり、plan.md「含まれないもの」の列挙と一致していること（7.6 は**部分失効**）

### 3. 3類型の判定規則と配送機構の契約 【読解】

- **対応する受け入れ基準:** AC-5 / AC-9 / AC-34
- **目的:** 同期実行 / Outbox event / local job の3類型が**実行責任の所有者**で判定される順序つき規則として書かれ、配送機構の責務分担が定義されていることを確認する
- **手順:**
  1. `spec/async/index.md` の判定規則の節を読む
  2. `CLAUDE.md` の Asynchronous execution contract 項1 を読み、同じ規則が置かれていることを確認する
  3. `spec/async/index.md` の「配送機構の契約と責務」の節を読む
- **期待結果:**
  - 3段の規則が**順序つき**で書かれている。「外部 I/O であること」「cross-DO RPC であること」が**単独では Outbox の条件にならない**ことが、`resume-*` / `finalize-withdrawal` / `sweep-orphan-mapping` を例に明記されている（AC-5）
  - 規則2の「独立」が**実行責任の独立**であって Worker の物理分離ではない、と書かれている（consumer は request Worker に同居するため）
  - 分類を変えるには**実行責任の所有者に基づく理由**が要る、と規則として書かれている（AC-9）
  - AC-34 の (a)〜(e) が5つとも `spec/async/index.md` にある — (a) Queue メッセージに載せるもの／載せないもの（宛先 DO の routing key を運ぶ／PII と秘密を載せない）、(b) consumer の一覧と責務（初期は mail consumer 1つ）、(c) consumer の置き場が **request Worker の `queue()` ハンドラ**、(d) DLQ の扱いと operator 導線2本、(e) **fail-closed の DO へ送信材料 RPC を打った consumer が DLQ へ落ちる**（デプロイのスキュー期間限定・復旧は DLQ 再駆動）
- **確認ポイント:** 判定規則が `spec/async/index.md` と `CLAUDE.md` の**両方**にあること（AC-5 は両方を要求している）。ただし `CLAUDE.md` 側に識別子を書いてはいけない（確認項目15 の機械検査11 と対）

### 4. 全数表の完全性 【機械+読解】

- **対応する受け入れ基準:** AC-6 / AC-7 / AC-8 / AC-19
- **目的:** `spec/async/index.md` の全数表が、すべての `event.type` とすべての `jobs.kind` を**ちょうど1回ずつ**覆い、欄に空きが無く、旧 `jobs.kind` 12種と1対1で辿れることを確認する（steps.md ステップ21 の機械検査 **1 / 2 / 3 / 4 / 5 / 15**）
- **手順:**
  1. **【検査1】** `spec/database/index.md` が言及する `kind` の集合が、全数表の `jobs.kind` 集合の**部分集合**であること（差集合が空）。**一致では検査しない** — 移設後の `spec/database/index.md` には再武装5種と収束規則の例示しか残らないので、一致で見ると恒常的に赤になる
  2. **【検査2】** 全数表の識別子欄で同じ識別子が2つの類型に現れないこと（識別子欄を切り出して `sort | uniq -d` が空）
  3. **【検査3】** 「発行点・投入点」欄に空欄が無いこと（AC-7 の他の欄 — owner DO / 実行責任者 / consumer / fan-out / payload / 冪等性キーとその保持先 — も同様に空欄が無いことを目視で確認する）
  4. **【検査4】** 全数表の `event.type` が `spec/domains/` のイベント定義と1対1であること（`grep -rn 'identity.passwordResetRequested' spec/domains/` と表の突き合わせ）
  5. **【検査5】** すべての `event.type` 行で consumer 欄が埋まっていること
  6. **【検査15】** **旧 `jobs.kind` 12種の集合 == 全数表の「由来」欄の集合**（**由来欄が `—` の行 = 同期実行4行 + 0件行 の計5行を除いて集合化する**。下の確認ポイント / `adr.md` AD-23）。12種は `send-mail` / `purge-trash` / `sweep-reservations` / `sweep-reset-tokens` / `reindex` / `migrate-bulk` / `rotate-encryption` / `finalize-withdrawal` / `resume-link` / `resume-signup` / `resume-credential-change` / `sweep-orphan-mapping`

     ```bash
     awk '/^## 全数表/{f=1;next} /^## /{f=0} f' spec/async/index.md \
       | awk -F'|' '/^\| /{gsub(/^ *| *$/,"",$3); if ($3!="由来（旧 `jobs.kind`）" && $3!="—") print $3}' \
       | sort -u
     ```
  7. 表の直後に、**User Data DO のイベント型が初期0件**であることを明示する行と、その行を集合演算から除外する旨の1行があることを読む
- **期待結果:**
  - 検査1 の差集合が空。検査2 の重複が0件。検査3 で空欄0。検査4 が1対1。検査5 で consumer 欄の空が0件。検査15 が**完全一致** — 手順6 のコマンドが返すのは**ちょうど12個**（`旧 send-mail` + local job 11種）で、旧 `jobs.kind` 12種と過不足なく一致する
  - Outbox 行の識別子は `identity.passwordResetRequested`、由来欄は **`旧 send-mail`**。local job 11種の由来欄は自分自身の名前（AC-8）
  - `sweep-reset-tokens` の用途欄が「トークン行と窓行の**両方**の削除」、投入点欄が「リセットトークン行**または窓行**を書くのと同じトランザクション（= `requestPasswordReset` の4ケースすべて）」になっている（AC-38）
  - **consumer 欄が空のイベントが1つも定義されていない**（AC-19）。User Data DO のイベント型は初期0件であることが表に明示されている
- **確認ポイント:** **検査 2 / 4 / 5 は「User Data DO のイベント型 0件」の行を明示的に除外して回す。** この行は識別子欄も由来欄も持てないので、除外せずに集合へ入れると空文字列のズレを踏む。**この3つの検査での除外対象はこの1行だけで、それが全数**（steps.md ステップ21 の除外規則）。**検査15 だけは除外の範囲が違う — 「由来欄が `—` の行」= 同期実行4行（FTS5 projection / retention のハードデリート / saga phase の前進 / `purge_after` の一括再計算）+ 0件行 = 5行を除外する**（`adr.md` AD-23。同期実行の行はもともとジョブではないので、由来欄に書ける旧 `jobs.kind` を持たず `—` が入る）。**0件行1行だけを除いて集合化すると `—` が13個目の要素として残り、12種との一致は必ず落ちる**（false red）。除いた後の集合はちょうど12個（`旧 send-mail` + local job 11種）になる。この2つの規則は `spec/async/index.md` の全数表の直後に2段落で並べて書かれているので、検査を書くときはそこを読む。また `send-mail` は識別子欄には現れない（もう `jobs.kind` ではない）ので、識別子欄での突き合わせは必ず失敗する — **判定は由来欄で行う**

### 5. `outbox_events` / `reset_request_windows` の物理定義 【機械+読解】

- **対応する受け入れ基準:** AC-10 / AC-11 / AC-15 / AC-38
- **目的:** 2つの新テーブルが `spec/database/index.md` に定義され、専用 Outbox DO を作らない構成になっていること、`jobs` と共通化／分離する規約が明示されていることを確認する
- **手順:**
  1. 節の新設を見る

     ```bash
     grep -n '^### outbox_events\|^### reset_request_windows' spec/database/index.md
     grep -n 'outbox_events\|reset_request_windows' spec/database/index.md | head -40
     ```
  2. `outbox_events` の列を読み、AC-10 が要求する項目が全部あることを確認する
  3. `reset_request_windows` の節を読む
  4. 共通化する規約 / 分離する規約の列挙を読む
- **期待結果:**
  - `### outbox_events`（User Data DO）と `### outbox_events（Identity Directory DO）`、`### reset_request_windows`（Identity Directory DO）の**3節**がある。テーブル一覧にも3行増えている。**専用 Outbox DO を作らない**ことが明記されている（AC-11）
  - `outbox_events` が event ID / type / payload / attempt / next attempt / published・quarantined 状態 / lease / 作成時刻 / 完了時刻 / 保持期間をすべて持つ。**作成時刻は `created_at` という独立の列**で、`occurred_at`（ドメインが決めた発生時刻）に兼ねさせていない（AC-10）
  - **共通化する規約:** Alarm scheduler / backoff / lease / prune。**分離する規約:** 同一性と収束の有無（`jobs` は `operation_key` で収束、`outbox_events` は1イベント1行・不変）/ 配送状態の値域 / **終端時に `owner_token` を `NULL` にしない**（`jobs` はする）（AC-15）
  - `reset_request_windows` が `window_key`（canonical の全長 HMAC + 窓。クライアントから受け取らない）/ `key_generation` / `first_requested_at` / `last_requested_at` / `expires_at` を持ち、**登録の有無に関係なく行を作る**と書かれている。索引 `rrw_expires_idx` を持ち、掃除は既存の `sweep-reset-tokens` に同居する。`credential_mappings.last_reset_requested_at` は落ちている（AC-38。列の消滅は確認項目13 で機械検査する）
  - **`jobs.kind` は11種のまま**で、窓掃除のために新しい `kind` を足していない（AC-38）
- **確認ポイント:** DDL 分類が3つとも書かれているか — `outbox_events` ×2 と `reset_request_windows` の追加は**単発適用**（空テーブルへの `CREATE TABLE` + `CREATE INDEX`）、`jobs` からの `provider_idempotency_key` 削除と `credential_mappings` からの `last_reset_requested_at` 削除は**列削除側**。新設側だけ書いて削除側を書かないと #51 が判断をやり直す

### 6. 同一トランザクションの記述が3箇所で一致する 【読解】

- **対応する受け入れ基準:** AC-12
- **目的:** 「業務データ更新・FTS5 projection・`outbox_events` の追加が同じ `transactionSync` で確定し、rollback すると3つとも巻き戻る」が3つの正本で一致して書かれていることを確認する
- **手順:**
  1. `spec/database/index.md` の書き込み単位の記述（改訂前 L29）を読む
  2. `spec/usecases/memo.md` / `spec/usecases/knowledge.md` / `spec/usecases/identity.md` の共通事項を読む
  3. `CLAUDE.md` の Unit of Work の項を読む
  4. 3箇所を並べて突き合わせる

     ```bash
     grep -rn 'transactionSync' spec CLAUDE.md | grep -v '/review/'
     ```
- **期待結果:** 3箇所とも「(1) 業務データの書き込み、(2) FTS5 projection の更新、(3) イベント行の追加」の**3つが1つのトランザクションで確定し、rollback すると3つとも巻き戻る**と読める。片方が2つしか挙げていない、あるいは「イベントは別トランザクション」と読める書き方が1箇所も無い
- **確認ポイント:** `spec/usecases/trash.md` L11（書き込みポートを持たない）と `spec/usecases/search.md` L74 は**変更しない**対象なので、ここに書き足していないこと

### 7. Alarm 多重化・relay の3相・quarantine と DLQ の分界 【読解】

- **対応する受け入れ基準:** AC-13 / AC-14 / AC-25
- **目的:** Alarm が Outbox の代替ではなく relay の起動契機として定義され、at-least-once の根拠と失敗の逃がし先が書かれていることを確認する
- **手順:**
  1. `spec/database/index.md` の Alarm 契約の節（`setAlarm` / `alarm()` の順序 / `deleteAlarm()`）を読む
  2. `spec/async/index.md` の relay の3相と DLQ の節を読む
- **期待結果:**
  - `setAlarm(min(jobs, outbox))` と、`alarm()` 内の順序 **(1) 再武装 → (2) migration ゲート → (3-a) relay パス → (3-b) jobs パス → (4) 張り直し** が定義されている。各パスが**独立の件数上限**を持ち、relay が上限に達しても jobs パスが飢えない。**両表の実行可能集合が空のときだけ** `deleteAlarm()` する。**lease 中の行（`running` / `publishing`）は `max(next_run_at, lease_until)` で算入**して空振り起床を作らない（AC-13）
  - relay が **トランザクション内 claim → トランザクション外 publish → トランザクション内 finalize** の3相で定義され、**Queue publish の直後に DO がリセットすると再送される**ことが at-least-once の根拠として明記されている（AC-14）
  - poison / quarantine（発行元 DO 側）と Queue DLQ（consumer 側）の分界が「**Queue に入る前か後か**」の1本で定義され、それぞれの再駆動と operator 導線が書かれている。**発行元 DO へ ack を書き戻さない**ことが明記されている（AC-25）
  - fail-closed の DO は relay もせず outbox 行が滞留するが**失われた配送ではない**こと、逆に fail-closed 前に publish 済みのメッセージを処理する consumer は migration ゲートに阻まれて DLQ へ落ちることの**両方**が書かれている
- **確認ポイント:** 「Alarm ゲートが `await` ゼロなので relay をゲートに入れられない」という限定が書かれているか。relay が `jobs.kind` になっていないこと（`rotate-remap` と同じ扱い）

### 8. ドメイン側の契約 — イベント登録口とスロットルポート 【機械+読解】

- **対応する受け入れ基準:** AC-16 / AC-18 / AC-39
- **目的:** イベント登録口が1つに固定され、ドメインポートの同期契約の例外が増えていないことを確認する
- **手順:**
  1. `spec/domains/index.md` のイベント契約のバレットを読む
  2. Promise 例外の件数を見る

     ```bash
     grep -n 'PasswordHasher\|MailSender' spec/domains/index.md spec/domains/identity.md | head
     ```
  3. `spec/domains/identity.md` の `PasswordResetThrottlePort` の節を読む
  4. `spec/inventory/domain.md` の append 行を見る

     ```bash
     grep -n 'DOM-identity-04[5-9]\|DOM-identity-05' spec/inventory/domain.md
     ```
- **期待結果:**
  - domain event / event draft の契約が `spec/domains/` にある（`EventId` は application 層が付ける／ドメインは identity-less な draft を返す）。**イベント登録口は UoW コンテキストの `enqueueEvent` ただ1つ**で、ドメインポートにしていない（AC-16）
  - ポートの同期契約の例外は `PasswordHasher` / `MailSender` の**2つのまま**。relay の `queue.send()` はアダプター内部でドメインポートではない、と明記されている（AC-18）
  - `PasswordResetThrottlePort` の節があり、メソッドは **`claimWindow(windowKey, now): boolean` の1つだけ**。窓の最初の依頼なら行を作って `true`、既存なら `last_requested_at` を更新して `false`。**判定と計上が2メソッドに分かれていない**。同期契約なので Promise 例外は2件から動かない（AC-39）
  - `spec/inventory/domain.md` の identity セクション末尾に `DOM-identity-045` 以降が **append** されている（既存連番を詰めていない）
- **確認ポイント:** `claimWindow` が2メソッドに割れていないこと。割れると「4ケースが一様に落ちる」が2つの呼び出しの組み合わせの性質になり、順序を誤ると一様性が静かに壊れる

### 9. PII / 秘密の非露出と送信材料 RPC の契約 【読解】

- **対応する受け入れ基準:** AC-20 / AC-24
- **目的:** PII と再利用可能な秘密が payload・Queue メッセージ・DLQ・ログ・`terminal_reason` に出ない規則が書かれ、送信材料 RPC の応答と呼び出しガードが仕様として確定していることを確認する
- **手順:**
  1. `spec/async/index.md` の payload / `terminal_reason` の衛生規則の節を読む
  2. 同じファイルの送信材料 RPC の節を読む
  3. `CLAUDE.md` の Key concepts の Outbox の項を読む
- **期待結果:**
  - payload・ログ・`terminal_reason` に **PII と再利用可能な秘密を載せない**規則がある。`send-mail`（= `identity.passwordResetRequested`）について、**メールアドレスと生リセットトークンが payload・Queue メッセージ・DLQ・ログのいずれにも出ない**経路が定義されている
  - **保証範囲が「載らない・永続化されない」**であり、「DO の境界を出ない」とは書かれていない（宛先と生トークンは送信材料 RPC の応答として境界を越え、配送の瞬間だけ consumer のメモリに載る）（AC-20）
  - **呼び出しガードが3条件** — (a) その `event.id` の行が存在し (b) `quarantined` でなく (c) 呼び出しの `owner_token` が行の値と一致する。**`status` は照合条件に入れない**ことと、その理由（`published` へ落とした後に consumer が到達するので `status='publishing'` を条件にすると正常系が全滅する／二重送信の抑止は `providerIdempotencyKey` が担う）が書かれている（AC-20）
  - 応答は **`send` / `nothing-to-send` の2分岐で全数**であり、`nothing-to-send` は**理由を1つも載せない空**である（AC-24）
  - **`outbox_events` は終端時に `owner_token` を `NULL` にしない**こと、運用値の制約2本（`Queue 最大 retry + DLQ 保持期間 < リセットトークン TTL` / `Queue 最大 retry + DLQ 保持期間 ≤ published 保持期間`）が書かれている（AC-20）。**2本は左辺が同じ `Queue 最大 retry + DLQ 保持期間` で、上限として置く相手だけが違う（リセットトークンの TTL と `published` 行の保持期間）。2本という数は動かない**（`plan.md` AC-20 の訂正注記と対）
  - 配送が **at-least-once・順序保証なし**で、consumer が `event.id` を基準に冪等化されること、**冪等性キーの保持先が consumer ごとに全数表で宣言される**ことが定義されている。mail consumer の `providerIdempotencyKey` は **DO 側で導出され送信材料 RPC の応答で渡される**（`outbox_events` の列ではない）（AC-24）
- **確認ポイント:** 「二重送信対策として `status` を照合する」に戻る記述が1箇所も無いか。応答の3分岐（`superseded` / `no-recipient`）が取り残されていないか（確認項目13 で機械検査する）

### 10. `requestPasswordReset` の安全性3性質 【読解】

- **対応する受け入れ基準:** AC-37 / AC-40
- **目的:** Outbox 化で最も壊れやすい既存の安全性設計（4ケース経路一致 / 連打の収束 / 生トークン非搭載）が、形を変えつつ一字も緩んでいないことを確認する
- **手順:**
  1. `spec/usecases/identity.md` の `requestPasswordReset` の節（改訂前 L185 / L203〜L208）を読む
  2. `spec/testcases/identity/requestPasswordReset.md` の末尾に append された3ケースを読む
  3. 表の途中に行が挿入されていないことを差分で確認する

     ```bash
     git diff main...HEAD -- spec/testcases/identity/requestPasswordReset.md
     ```
- **期待結果:**
  - **(a) 要件側:** 「**同じ窓の状態に対して4ケースは一様に落ちる — その窓での最初の依頼なら4ケースとも必ずちょうど1行、既に発行済みの窓なら4ケースとも1行も書かない。分岐の材料は窓ストアの状態だけで、登録有無・認証方式・宛先の存在を参照しない**」が明記されている。**窓ストアの行は登録の有無に関係なく必ず作る**。「送らない側」の payload も形が同一である（`tokenId` を nullable にしない）（AC-37a）
  - **(b) L205 の改訂:** 全置換の規則（「発行はそのクレデンシャル宛の未使用トークンをすべて置き換える」）は**維持**したまま、**発行が起きるのは窓での最初の依頼のときだけ**という前提条件が足され、2回目以降は何も発行せず既存の未使用トークンを有効に保つと明記されている。発行判断と窓判定が**同じ1つの分岐**（`claimWindow` の戻り値）であると書かれている（AC-40）
  - **(c) テストケース:** 末尾に3ケースが **append** されている — (i) 同一 canonical・同一窓へ2回依頼 → **有効なリンクを含むメールが1通**（0通でも2通でもない）**かつ1通目のリンクが2回目の依頼後も有効**、(ii) 窓をまたいだ新旧2件が逆順で届く → 新しいほうが送信され古いほうは `nothing-to-send` で no-op（**期待値は「`nothing-to-send` が返る」までで、理由は期待値に書けない**）、(iii) **未登録アドレスへ同一窓で2回依頼しても測定対象が登録済みの場合と一致する。測定するのは (1) `outbox_events` の行数、(2) `reset_request_windows` の行数、(3) Alarm の起床の有無、(4) `sweep-reset-tokens` の投入の有無 の4つ**（AC-37b）
  - 窓行を書くのと同じトランザクションで **`sweep-reset-tokens` を4ケースすべてで投入**することが、`spec/async/index.md` / `spec/database/index.md` / `spec/usecases/identity.md` の**3箇所に同じ1文**で書かれている（AC-38 / `.adr/010` の規則）
- **確認ポイント:** (iii) の測定対象が「**総書き込み行数**」になっていないこと — 登録済み側は `password_reset_tokens` の発行行を追加で書くので総数では一致せず、文字どおりに読むと成立しない命題になる。また (iii) を落とさないこと（未登録側だけで破れる設計が過去に2度検出されている）

### 11. 検索の即時整合が維持されている（非変更検査） 【機械】

- **対応する受け入れ基準:** AC-21 / AC-22 / AC-23
- **目的:** FTS5 の同期更新が維持され、**検索 indexer consumer が復活していない**こと、検索要件が改訂されていないことを確認する（steps.md ステップ21 の機械検査 **7**）
- **手順:**
  1. 上流3件が1文字も変わっていないことを見る

     ```bash
     git diff main...HEAD -- spec/scenario/search.md spec/domains/search.md spec/usecases/search.md
     ```

     `spec/scenario/search.md:18` / `spec/domains/search.md:174` / `spec/usecases/search.md:74`（いずれも「反映待ちは存在しない」）の行が差分に現れないことを確認する
  2. 検索要件が無改訂であることを見る

     ```bash
     git diff main...HEAD -- spec/requirements.md
     ```

     §4.4（日本語・1〜2文字クエリ・topic 絞り込み・ゴミ箱除外）に `+` / `-` が1行も無いこと
  3. 検索テストケースが無変更であることを見る

     ```bash
     git diff main...HEAD --name-only -- spec/testcases/search/
     ```
  4. 「反映待ち」の全数が動いていないことを見る（改訂前 **7件**）

     ```bash
     grep -rn '反映待ち' spec | grep -v '/review/' | wc -l
     ```
  5. `spec/requirements.md` §5.3 に追加された2バレットを読む
- **期待結果:**
  - 手順1・2 で該当行に差分が無い（AC-21 / AC-22）
  - 手順3 が空（`spec/testcases/search/search.md` は無変更。`TC-search-033` が生きている）
  - 手順4 が **7**（件数は改訂前後で動かない）。限定の1行を足すのは `spec/manual-tests/search.md:19` の1箇所だけで、残り6箇所は無変更
  - 手順5: 「**検索インデックスは本体更新と同一トランザクションで確定する（即時整合）**」と「**外部副作用とイベント配送は結果整合である。配送は at-least-once・順序保証なしで、同じ通知が複数回届きうる**」が**別々のバレット**として書かれている（AC-23）
  - `spec/domains/search.md` の projection 契機11行の表の直後に「**この11の契機はイベントではない。検索用イベントと indexer consumer を置かない**」が明記されている（AC-19 / AC-21）
- **確認ポイント:** `spec/domains/search.md` は L216（外部 transport の限定。確認項目12 の対象）だけが変わり、**L174 / L194 / L246 は動かない**。手順1 の差分に L174 が現れたら検索側の断言を巻き込んでいる

### 12. 無限定の「配送する経路は持たない」が残っていない 【機械+読解】

- **対応する受け入れ基準:** AC-36
- **目的:** 「Outbox は無い」と「Outbox がある」が同じ `spec/` に同居する状態が残っていないことを確認する（steps.md ステップ21 の機械検査 **12**）
- **手順:**
  1. ヒット数を数える（改訂前 **9件**・改訂後 **4件**）

     ```bash
     grep -rn '配送する経路\|通知する経路\|外部 transport' spec | grep -v '/review/'
     grep -rn '配送する経路\|通知する経路\|外部 transport' spec | grep -v '/review/' | wc -l
     ```
  2. **無変更であるべき3件**が1文字も変わっていないことを見る

     ```bash
     git diff main...HEAD -- spec/database/index.md spec/domains/trash.md spec/inventory/adapter.md \
       | grep -E '^[+-].*(配送する経路|通知する経路|外部 transport)' \
       && echo "NG: 無変更3件に手が入っている" || echo "OK"
     ```
  3. 改訂後に残る4件を1件ずつ読み、それぞれが「失効済み」「検索インデックスに限定」「検索ドメインに限定」のいずれかであることを確かめる
  4. 限定形へ直した**6箇所**（`spec/domains/index.md:35` / `spec/domains/memo.md:14` / `spec/domains/search.md:216` / `spec/usecases/memo.md:14` / `spec/usecases/knowledge.md:16` / `spec/usecases/identity.md:10`）が、同じバレットに `spec/async/index.md` への参照を持つことを確認する

     ```bash
     grep -n 'spec/async/index.md\|async/index.md' spec/domains/index.md spec/domains/memo.md \
       spec/domains/search.md spec/usecases/memo.md spec/usecases/knowledge.md spec/usecases/identity.md
     ```
- **期待結果:** 手順1 が **4**。手順2 が `OK`。手順3 で4件とも限定つき（無限定の断言が0件）。手順4 で6ファイルすべてに参照がある（`memo.md` のようにイベントを定義しないドメインも例外にしない）
- **確認ポイント:** **総数の一致では判定しない。** 限定形へ直す6箇所のうち5箇所は置換で grep 対象の語句そのものが消えるため、9件のままにはならない（生き残るのは `spec/domains/search.md:216` だけ）。**5件目の無限定断言が出たら改訂側のミス**として扱う

### 13. 失効した識別子が1件も残っていない 【機械】

- **対応する受け入れ基準:** AC-8 / AC-24 / AC-38
- **目的:** `jobs` から離脱した／落とした識別子が spec のどこかに取り残されていないことを確認する（steps.md ステップ21 の機械検査 **9 / 10 / 13 / 14**）
- **手順:**
  1. **【検査9】** `send-mail` が `jobs.kind` として残っていないこと（改訂前は `spec/` に5件、うち `spec/inventory/adapter.md` に2件、`CLAUDE.md` に2件）

     ```bash
     grep -rn 'send-mail' spec CLAUDE.md | grep -v '/review/'
     ```
  2. **【検査10】** `provider_idempotency_key` が列として現れないこと（改訂前 **3件** — `spec/database/index.md:24` / `:441` / `spec/inventory/adapter.md:23`）

     ```bash
     grep -rn 'provider_idempotency_key' spec | grep -v '/review/'
     ```
  3. **【検査14】** `last_reset_requested_at` が列として現れないこと（改訂前 **2件** — `spec/database/index.md:582` / `spec/inventory/adapter.md:27`）

     ```bash
     grep -rn 'last_reset_requested_at' spec | grep -v '/review/' | wc -l
     ```
  4. **【検査13】** 送信材料 RPC の応答の**3分岐案**が取り残されていないこと

     ```bash
     grep -rn 'no-recipient' spec CLAUDE.md
     grep -rn '`superseded`' spec CLAUDE.md | grep -v '/review/'
     ```
- **期待結果:**
  - 手順1: 残るのは **`spec/async/index.md` の3件だけ** — 全数表の由来欄（`旧 send-mail`）/ `—` の突き合わせ規則の説明（「`旧 send-mail` + local job 11種」）/ P-001 の差し戻し条件の注記（ステップ3 が明示的に置けと指示したもの）。`spec/database/index.md` の `jobs` 節と `spec/inventory/adapter.md` に `send-mail` が1件も無い（`ADP-jobs-002` の6種の逐語列挙からも落ちている）。**`.adr/013` はこのコマンドの射程外である**（検索対象は `spec` と `CLAUDE.md` で `.adr/` を含まない）ので、期待結果に挙げない。**判定に使うのは「`jobs` 節と `spec/inventory/adapter.md` が0件」であり、`spec/async/index.md` 側の件数ではない**（同ファイルは検査15 の判定材料を持つので、由来欄を消してはいけない。エッジケース8）
  - 手順2 が **0件**、手順3 が **0**
  - 手順4: `no-recipient` が **0件**。`` `superseded` ``（バッククォート付きの識別子表記）も **0件**
- **確認ポイント:** **検査13 を素の `grep -rn 'superseded' spec CLAUDE.md` で回してはいけない。** 改訂前の実測で **8件**ヒットするが、その8件はすべて **ADR のステータス語**（`spec/index.md:42` / `spec/database/index.md:6` / `spec/adr/005-*.md:5` / `spec/domains/{search,knowledge,memo,index}.md` / `spec/usecases/search.md`）であり、AD-6 が禁じている応答分岐の識別子とは別物である。**識別子としての `superseded`（バッククォート囲み、または `nothing-to-send` と並記された文脈）だけを見る**か、8件が改訂前と同一のファイル・同一の文脈であることを差分で確認する形にする

### 14. 数え上げの同時修正 【機械】

- **対応する受け入れ基準:** AC-17a / AC-17b / AC-26 / AC-30
- **目的:** 「1つ直して1つ取り残す」破れが無いことを、**宣言箇所と実体の両方をコマンドで出して**確認する（steps.md ステップ21 の機械検査 **6** と「同時修正リスト」）
- **手順:** 下表の各行について、改訂前の値（実測済み）から改訂後の値へ**全箇所そろって**動いていることを確認する。

  | 数 | 改訂前 | 改訂後 | 再測定コマンド／実在箇所 |
  |---|---|---|---|
  | User Data DO のテーブル数 | 16 | **17** | `spec/index.md:25` / `spec/database/index.md` のテーブル一覧の行数 |
  | Identity Directory DO のテーブル数 | 5 | **7** | 同上（`outbox_events` と `reset_request_windows` の2つ） |
  | 非集約ストア数 | 7 | **9** | `grep -rn '非集約ストア' spec \| wc -l` = **9**（改訂前実測）。うち**数を書いている5行**（`spec/database/index.md` L79 / L749 / L753 / L754、`spec/domains/identity.md:378`）が全部 9 になる。残り4件は分類の話で数を持たない。**改訂後は総ヒットが 11 になる**（実測。新設した `outbox_events` / `reset_request_windows` の節がそれぞれ「OCC の `version` は持たない（非集約ストア）」を持つので、数を持たない行が 4→6 に増える）。**判定に使うのは総ヒット数ではなく、数を書いている5行がすべて 9（書き込み口は 8ストア・9メソッド）であること** — 総ヒット数は節が増えるたびに動くので合否の材料にならない。改訂後の5行の所在は `spec/database/index.md` 4行 + `spec/domains/identity.md` 1行のままだが、**行番号は改訂でずれるので `grep` で取り直す** |
  | 非集約ストアの書き込み口 | 6ストア・7メソッド | **8ストア・9メソッド** | `spec/database/index.md:754` / `spec/domains/identity.md:378`。増えるのは `enqueueEvent` と `resetThrottleStore` |
  | `spec/inventory/adapter.md` の schema 行数 | 22 | **25** | `ADP-outbox-events-001` / `-002` / `ADP-reset-request-windows-001` の3行を append |
  | `jobs` の列数 | 12 | **11** | `grep -rn '12列' spec \| wc -l` = **4**（改訂前実測）。**4行すべて**が 11 へ |
  | `jobs.kind` の種別数 | 12（UD 6 / ID 6） | **11（UD 6 / ID 5）** | `spec/database/index.md` L48 / L54 / L468 / L485 / L654 / L759、`spec/inventory/adapter.md:29` |
  | 収束規則 (3) の「残る7種」 | 7 | **6** | `grep -rn '残る7種' spec \| wc -l` = **3**（改訂前実測。`spec/database/index.md` L457 は同一行内に2回）。L457 は**根拠の例示（`send-mail` の同窓連打）も差し替える** |
  | 「ユースケースから投入する8種」 | 8 | **7** | `spec/database/index.md:468` |
  | `jobs.kind` の類型数 | 4 | **3類型 + local job の3サブ類型** | `grep -rn '4類型\|類型は4つ' spec \| wc -l` = **1**（改訂前実測） |
  | テストケース件数 | 838 | **838 + 新規** | `grep -c '^\| TC-' spec/inventory/test.md` と `spec/index.md` L15 / L26 |
  | テストケースの slug 数 | 54 | **55** | `ls spec/testcases/*/*.md \| wc -l` = **54**（改訂前実測）。**slug 数 = テストケースファイル数**が不変条件 |
  | マニュアルテスト件数 | 204 | **204 + 新規** | `grep -n '204' spec/manual-tests/index.md` は **L22 / L41 の2件**（L9 は日付行なので拾えない）。`spec/index.md` L16 / L27 |
  | マニュアルテストのカテゴリ数 | 7 | **7（不変）** | `spec/index.md:16`。**`grep -rn '7カテゴリ' spec` は2件返すが、L21 はシナリオの数で対象外** |
  | `#37` の参照件数 | 19 | **0** | 確認項目15 |
  | 無限定の断言 | 6 | **0** | 確認項目12 |

  実行例:

  ```bash
  grep -rn '非集約ストア' spec | wc -l
  grep -rn '12列' spec
  grep -rn '残る7種' spec
  grep -rn '4類型\|類型は4つ' spec
  grep -c '^| TC-' spec/inventory/test.md
  ls spec/testcases/*/*.md | wc -l
  grep -o '^| TC-[A-Za-z_0-9]*-[0-9]\{3\}' spec/inventory/test.md \
    | sed 's/^| TC-//; s/-[0-9]\{3\}$//' | sort -u | wc -l
  grep -n '204' spec/manual-tests/index.md
  grep -rn '7カテゴリ' spec
  ```
- **期待結果:** 表の各行で、**宣言箇所の値と実体のカウントが一致する**。特に slug 数（`grep` 由来）と テストケースファイル数（`ls` 由来）が**同じ値**になる。`spec/index.md` の「7カテゴリ」が**改訂前後で不変**（AC-28 / AC-30）
- **確認ポイント:**
  - **スロットル窓ストアの新設が4行（テーブル数・非集約ストア数・書き込み口・schema 行数）に追加で効く。** `outbox_events` のぶんだけを足した値で止めると赤になる
  - **`CLAUDE.md` には数を書き足さない**（AC-17b）。L68 に `enqueueEvent`（両 DO クラス）と `resetThrottleStore`（Identity Directory DO 側の roster）が**列挙として**加わり、数の委譲文 `The per-table roster, and its count, lives in spec/database/index.md.` は**そのまま残る**
  - `spec/index.md` のテストケース件数は、**`spec/testcases/async/` がユースケースに属さない**ことが数え方の表記に出ていること（「54ユースケース + async 1ファイル」の形）。L24 の「6ドメイン・54ユースケース」は `spec/usecases/` の数え上げなので**変更しない**

### 15. `#37` 参照の一掃と `CLAUDE.md` の改訂 【機械+読解】

- **対応する受け入れ基準:** AC-29 / AC-35
- **目的:** CLOSED 済みの Issue を指す能動的な参照が消え、`CLAUDE.md` が新しい契約に揃っていることを確認する（steps.md ステップ21 の機械検査 **8 / 11**）
- **手順:**
  1. **【検査8】** 改訂前 **19件**（`spec/database/index.md` 10 / `CLAUDE.md` 5 / `spec/domains/identity.md` 1 / `spec/inventory/adapter.md` 1 / `spec/testcases/export/exportAllData.md` 1 / `spec/manual-tests/search.md` 1）

     ```bash
     grep -rn '#37' spec CLAUDE.md | grep -v '/review/'
     grep -rn '#37' spec CLAUDE.md | grep -v '/review/' | wc -l
     ```
  2. 付け替え先が妥当であることを見る

     ```bash
     grep -rn '#51\|#38\|#44\|#45' spec CLAUDE.md | grep -v '/review/'
     ```
  3. **【検査11】** `CLAUDE.md` に `event.type` / `jobs.kind` の識別子が1つも列挙されていないこと（改訂前は L83〜L85 の4類型表に11種が列挙されている）

     ```bash
     grep -n 'purge-trash\|sweep-reservations\|sweep-reset-tokens\|reindex\|migrate-bulk\|rotate-encryption\|finalize-withdrawal\|resume-link\|resume-signup\|resume-credential-change\|sweep-orphan-mapping\|send-mail\|passwordResetRequested' CLAUDE.md
     ```
  4. `CLAUDE.md` の改訂点を読む
- **期待結果:**
  - 手順1 が **0件**（**例外条項は置かない**。`Migration in progress` の節も #51 だけを指し、`#37` という識別子を1件も含まない）
  - 手順3 が **0件**。4類型表は識別子を持たない形（類型名 + `spec/async/index.md` への参照 + 追加時の手続き）へ縮んでいる。「`kind` を足したらここにも足す」は**削除**されている（AC-29）
  - 手順4:
    - Asynchronous execution contract 項1（`There is no domain-event transport.`）が**3類型の判定規則へ差し替え**られている
    - Key concepts に **Outbox の項**が新設されている（at-least-once / 順序保証なし / `event.id` で冪等化 / 冪等性キーの保持先は consumer ごと / トランザクション内で外部 I/O をしない / Outbox は発行元 DO にある / Alarm は relay の起動契機 / 秘密と PII は送信材料 RPC の応答としてのみ境界を越える）
    - Reference runtime の **`no Queues` が訂正**され、「Two Workers」は維持されたまま request Worker の責務に Queue consumer（mail consumer と DLQ ハンドラ）が足されている。deploy 順序（state 先）の記述は不変
    - 項3 の `providerIdempotencyKey` の導出元が **`event.id` から DO が導出して送信材料 RPC の応答で渡す**形へ訂正されている
    - Error handling の catch 境界の列挙と Cross-layer catch policy に **relay の per-row catch と consumer 側の catch 境界**が足されている
    - `L129` 相当の「`#37` が outbox と processed-events を消す」という記述が訂正され、**`processed_events` は消えるが outbox は消えず DO ローカルへ移る**と書かれている。worker の列挙が `relay` / `consumer` / `pruner` / `dlq` の4本であることは維持
- **確認ポイント:** `#37` の置換で `.thread/` 配下や `spec/*/review/**` を巻き込んでいないこと（レビュー記録は改訂対象外）。`CLAUDE.md` の Key concepts 前置き（改訂前 L66）の `#37` を落とし忘れると、`Migration in progress` だけ直しても検査8 が赤になる

### 16. 台帳4件・テストケース・マニュアルテストの同期 【機械+読解】

- **対応する受け入れ基準:** AC-26 / AC-27 / AC-28
- **目的:** `spec/inventory/` の4台帳とテスト定義が新構成へ同期され、アンカー規約が壊れていないことを確認する
- **手順:**
  1. 台帳の差分を見る

     ```bash
     git diff main...HEAD -- spec/inventory/
     grep -n 'ADP-outbox-events-001\|ADP-outbox-events-002\|ADP-reset-request-windows-001' spec/inventory/adapter.md
     ```
  2. `spec/inventory/usecase.md` に `UC-*` 行が増えていないことを見る

     ```bash
     git diff main...HEAD --stat -- spec/inventory/usecase.md
     ```
  3. 新規テストケースファイルを見る

     ```bash
     ls spec/testcases/async/
     git diff main...HEAD --stat -- spec/testcases/
     ```
  4. マニュアルテストの追加先とカテゴリ数を見る

     ```bash
     git diff main...HEAD --name-only -- spec/manual-tests/
     sed -n '13,22p' spec/manual-tests/index.md
     ```
- **期待結果:**
  - `spec/inventory/adapter.md` の schema 行が **22 → 25**。`ADP-jobs-001` / `-002` の列数（12→11）・種別数（6種 / 5種）・収束規則（残る7種→6種）が訂正され、`ADP-credential-mappings-001` の濫用抑止の列挙から `last_reset_requested_at` が落ちている。`ADP-identity-016`（`MailSender`）の呼び手が **request Worker の `queue()` ハンドラ（mail consumer）**、生トークンの導出が**送信材料 RPC の中（DO 側）**へ訂正され、`spec/domains/identity.md` の `MailSender` の記述と**一字レベルで揃っている**（AC-26）
  - **relay / mail consumer / DLQ ハンドラの層帰属がアダプター層**であることが1行で書かれ、**`spec/inventory/usecase.md` に行が足されていない**（AC-26）。手順2 の `--stat` は **`2 insertions(+), 2 deletions(-)`** — 差分は `UC-identity-005` の1行と `生成元: spec/usecases/（最終同期: …）` の同期日行の**2行だけ**で、**`UC-*` 行は1本も増えていない**（同期日行は他の台帳と同じ扱いで更新される）。**「1行だけ」を期待すると false red になる**
  - `spec/testcases/async/outboxDelivery.md` が存在し、plan.md「テスト方針 (b)」の機構側12項目（原子性 / relay / at-least-once / 順序逆転 / backoff / lease / quarantine / DLQ / 再駆動 / prune / PII 非露出 / fail-closed × DLQ）がケースに落ちている（AC-27）
  - マニュアルテストの追加先が **`spec/manual-tests/account.md`** で、**新規カテゴリーは作られていない**（件数表の行数が7のまま）。backlog 観測手順に **fail-closed 由来の滞留の判別材料**（`schema_version` を `read-schema-version` で確認）が1行入っている。`spec/manual-tests/index.md` の L9（spec バージョン行）・L22（合計）・L41（実行記録テンプレートの `/204件`）の**3箇所**が更新されている（AC-28）
- **確認ポイント:** **新規ケースは表の末尾に append する**（`spec/inventory/test.md` の `#L{n}` アンカー規約）。途中挿入すると下の全行のアンカーが狂う。手順1・3 の差分で、既存行の行番号がまとめてずれていないかを見る

### 17. 関連 Issue / PR のコメント同期 【機械】

- **対応する受け入れ基準:** AC-31
- **目的:** 本 Issue での扱いが関連 Issue / PR に記録され、#51 に依存が明記されていることを確認する
- **手順:**

  ```bash
  gh issue view 37 --comments | tail -40
  gh pr view 49 --comments | tail -30
  gh issue view 38 --comments | tail -30
  gh issue view 10 --comments | tail -20
  gh issue view 51 --comments | tail -40
  ```
- **期待結果:** #37 / PR #49 / #38 / #10 / #51 の**5件すべて**に本 Issue でのコメントが付いている。#51 のコメントに `.adr/013` と `spec/async/index.md` の所在、P-001 の差し戻し条件、`apps/web/` 側の引き継ぎ2件（`.dev.vars.example` へのメール provider 秘密の追加 / `wrangler*.toml` の全面書き換え）が書かれている。#51 本文に本 Issue への依存が明記されている（既存本文で満たしている場合は、その確認がコメントに記録されている）
- **確認ポイント:** #37 のコメントに「歴史（何をしようとして、なぜ CLOSED になり、何が引き継がれたか）」が置かれていること — `CLAUDE.md` から `#37` の識別子を落とす代わりの置き場がここである（確認項目15 と対）

---

## エッジケース・異常系

### 1. commit 前に検査を回して空振りする

差分ベースの検査（確認項目1 / 2 手順3 / 11 / 12 手順2 / 16）は、未 commit の状態では `git diff main...HEAD` が空を返すため**全部「変更なし」で通ってしまう**。着手前の実測値（`.adr/` 12件 / `#37` 19件 / 「配送する経路」9件）と一致したままなら、改訂が反映されていないことを疑う。検査に入る前に `git status --porcelain` が空であることを必ず確認する。

### 2. `superseded` の素の grep が ADR ステータス語を拾う

機械検査13 を `grep -rn 'superseded' spec CLAUDE.md` で回すと、**改訂前の実測で8件ヒットする**。8件はすべて「`spec/adr/005`（superseded）」という ADR のステータス語であり、AD-6 が禁じた応答分岐の識別子ではない。素の grep で 0件を期待すると**必ず赤になり、その赤を消そうとして ADR のステータス表記を壊す**。識別子表記（バッククォート囲み、`nothing-to-send` との並記）に限定して検査する。

### 3. 数え上げの片側だけ直る

同時修正リストの各行は**複数の実在箇所に同じ数が散っている**。特に踏みやすいのは次の4つ。

- `12列` は **4箇所**あり、`spec/inventory/adapter.md:23` は「Alarm ジョブの多重化テーブル（12列）」という括弧つきの形なので目視で落ちる
- `残る7種` は **2ファイル3箇所**（`spec/database/index.md` L457 は同一行内に2回）。L457 は数だけでなく**根拠の例示（`send-mail` の同窓連打）ごと差し替える**必要がある — 直さないと、存在しない `kind` を根拠にした規則が残る
- `204` は `spec/manual-tests/index.md` で **grep が2件しか拾えない**（L9 は日付行）。更新点は3箇所
- `7カテゴリ` は `spec/index.md` に **2件**あるが、L21 はシナリオの数で対象外。両方直すと逆に壊す

### 4. 断言の書き換え漏れ（片方向だけ直る）

「Outbox は無い」と「Outbox がある」が同じ `spec/` に同居するのが本 Issue で最も避けたい破れ。**AC-36 を総数の一致で判定すると必ず誤診する** — 限定形へ直す6箇所のうち5箇所は語句そのものが消えるため、9件が4件へ減るのが正常である。判定は (1) 無変更3件が1文字も変わっていない、(2) 残存4件のいずれにも無限定の断言が無い、の2本立てで行う。**5件目が出たら改訂側のミス**。

### 5. 行アンカーのずれ

- `spec/database/index.md` はステップ4 が3節と3行を挿入するため、**ステップ5 が挙げる L428 以降のアンカーはその時点で別の行を指す**。行番号ではなく検索文字列（`同じ12列` / `残る7種` / `ユースケースから投入する 8 種`）で対象を特定したかを、差分の内容で確認する
- `spec/inventory/test.md` の `#L{n}` アンカーは、テストケースファイルの**途中**に行を挿入すると下の全行が狂う。新規ケースが**末尾に append** されていることを差分で確認する（確認項目16）

### 6. 集合演算に0件行を混ぜる／検査15 の除外範囲を狭く取る

全数表の「User Data DO のイベント型: 0件」の行は識別子欄も由来欄も持てない。機械検査 **2 / 4 / 5 / 15** の4つすべてから除外しないと、空文字列を集合に入れてズレを踏む。**検査 2 / 4 / 5 での除外対象はこの1行だけで、それが全数**。

**検査15 だけは除外の範囲が広い。** 由来欄は同期実行の4行（FTS5 projection / retention のハードデリート / saga phase の前進 / `purge_after` の一括再計算）でも `—` である — もともとジョブではないので、書ける旧 `jobs.kind` を持たない（`spec/async/index.md` の全数表の直後 / `adr.md` AD-23）。**検査15 が除外するのは「由来欄が `—` の行」= 同期実行4行 + 0件行 = 5行**であり、0件行1行だけを除いて集合化すると `—` が13個目の要素として残って**12種との一致が必ず落ちる**（false red を出し、実装側は正しいのに直しに行くことになる）。除外を書いていない検査スクリプトは、通っても信用できない。

### 7. 相互参照の切れ

- `spec/index.md` の成果物一覧に `spec/async/index.md` が載っていない → 新しい正本へ辿り着けない
- `spec/index.md` の ADR 表に `.adr/013` の行が無い、`.adr/004` の行の注記が部分 supersede の形へ更新されていない
- 限定形へ直した6箇所のどれかで `spec/async/index.md` への参照が落ちている（確認項目12 手順4）
- `.adr/013` が `.adr/010` について宣言する失効範囲が**3項**（全数表の所在の移設 / 「外部プロバイダへ渡す冪等キーの導出は生成 ID では成立しない」の帰属変更 / **主キーの例外 (b) の射程が「生成せず決定的に導く同一性キー」へ広がること。例外の数は2つのまま動かない**）そろっているか — 1項でも欠けると `.adr/010` を読んだ人が失効した論拠に到達する

### 8. `send-mail` を消しすぎる

機械検査9 を「`spec/` 全体で0件」に強めると、**全数表の由来欄（`旧 send-mail`）まで消える**。由来欄は AC-8 の判定材料なので、消すと検査15 が成立しなくなる。検査9 の射程は **`jobs` 節と `spec/inventory/adapter.md`** に限る。

### 9. `#37` の一括置換が対象外を巻き込む

`sed -i` 的な一括置換をすると `.thread/` 配下や `spec/*/review/**`（日付つきレビュー記録。改訂対象外）まで書き換わる。検査8 の grep は `/review/` を除外しているので**気づかずに通る**。確認項目1 の差分範囲検査で `.thread/50/` 以外が現れないことと併せて見る。

---

## 既存機能への影響確認

本 Issue はドキュメントのみの変更なので、実行時の挙動に対する影響はゼロである。確認するのは「**維持すると宣言したものが本当に維持されているか**」の1点に尽きる。

- **FTS5 の同期更新と検索要件** — 確認項目11。上流3件・`spec/requirements.md` §4.4・`spec/testcases/search/` が無変更で、「反映待ちは存在しない」が7箇所とも生きていること。検索 indexer consumer は復活しない
- **`jobs` 機構そのもの** — `.adr/004` の第1項（ローカル同期コミット）と永続ジョブ + Alarm という機構は**有効なまま**（確認項目2）。`jobs.kind` は **11種**で、窓掃除のために新 `kind` を足していない（確認項目5 / 14）。再武装する5種と収束規則3つは維持され、規則 (3) は根拠の例示だけが差し替わる
- **Unit of Work の契約** — `run` の同期性、非集約ストアの roster と書き込み口の全数（7→9 / 6ストア7メソッド→8ストア9メソッド）が `spec/database/index.md` と `spec/domains/identity.md` と `CLAUDE.md` で一貫していること（確認項目14）。`CLAUDE.md` は列挙だけを更新し、数の委譲文は残す
- **ドメインポートの同期契約** — Promise 例外は `PasswordHasher` / `MailSender` の**2件のまま**（確認項目8）。`PasswordResetThrottlePort` は同期契約なので例外を増やさない
- **`requestPasswordReset` の列挙オラクル対策** — 確認項目10。4ケースの経路一致・連打の収束・生トークン非搭載の3性質が形を変えつつ維持されていること。特に未登録アドレス側の測定を落とさないこと
- **`spec/manual-tests/` のカテゴリ構成** — 7カテゴリのまま（確認項目14 / 16）。追加先は既存の `account.md`
- **実行時コード・設定** — `packages/` / `apps/` / `infra/` / `*.toml` / migration SQL が1行も変わらないことを確認項目1 で機械的に保証する。したがって `pnpm typecheck` / `pnpm test` / `pnpm build` の結果は改訂前と同一であり、本 Issue の合否判定には用いない
- **対象外ドキュメント** — `docs/runtime_cloudflare.md` / `docs/backend_implementation_example.md` / `docs/test.md` / `README.md` は #38 / #51 の担当であり、差分に現れないこと（確認項目1 手順1 で `docs/` と `README.md` が出ないことを見る）
