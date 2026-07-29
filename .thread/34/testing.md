# 動作確認計画 — Issue #34: [設計] Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**Issue:** #34
**作成日:** 2026-07-29

---

## 確認環境

このIssueの変更を確認するために必要な手順のみ記載（プロジェクト全体のセットアップは省略）。

本 Issue の成果物は `.adr/002〜004` の3件・`.thread/34/design.md`・旧 ADR 2箇所への supersede ポインタで、**コードもコンフィグも1行も変更しない**（plan.md 目的節 / AC-20）。したがって確認はすべて **リポジトリルートでの `git` / `ls` / `grep` と、ドキュメントの読み下し**で完結する。

### 前提

- 成果物を **commit した状態**で検証する。plan.md 実装ステップ10 が定めるとおり、置き場所の判定は `git diff --name-status main...HEAD` と `git status --porcelain` の2コマンドの出力だけで行う。commit 前に実行すると `git diff main...HEAD` が空になり、AC-2 / AC-3 / AC-7 / AC-8 / AC-9 / AC-20 が「証明ではなく空振り」で通ってしまう（エッジケース1）。
- レビュー往復のあいだに `.thread/34/review/` と改訂後の `design.md` / `testing.md` が後から増えるので、機械検証に入る直前に次が空であることを確かめる。

  ```bash
  git status --porcelain | grep '\.thread/34/'
  ```
- 以下のコマンドはすべてリポジトリルート（`/Users/hikaru/github.com/tuanemuy/fog`）で実行する。

### 検証環境の起動

**なし。** 本 Issue はドキュメントのみの変更で、アプリケーションの起動を伴わない。

- 成果物は `.adr/` / `.thread/34/` / `spec/adr/005-search-index-via-outbox.md` / `.thread/1/adr.md` の Markdown のみで、`packages/core/` / `apps/web/app/` / `infra/` のコードにも `*.toml` にも触れない（AC-20）。動かして挙動が変わる対象が存在しない。
- 参考: ローカルでアプリを起動する手段は `pnpm dev`（= `pnpm dev:cf` = `vite dev --config vite.config.cloudflare.ts`）のみだが、本 Issue の確認では使わない。`pnpm start` / `pnpm preview` はそもそも起動しない（Issue #40。`README.md` / `CLAUDE.md` の Reference runtime 節に記載）。

### デプロイ方法

**なし。** デプロイ対象の成果物が無い。

- `pnpm deploy:staging*` / `pnpm deploy:production*`（非 dry 12本 / dry を含めて24本）はいずれも Worker のビルドと `wrangler deploy` であり、本 Issue はそのどれにも入力を与えない。
- `pnpm db:migrate` 系・`pnpm cf:render:staging` / `cf:render:production` も同様に対象外（スキーマも wrangler テンプレートも変更しない）。

---

## 確認項目

### 1. `.adr/` の件数・採番・書式

- **対応する受け入れ基準:** AC-1 / AC-2 / AC-3
- **目的:** 新規 ADR がちょうど3件で、採番が `001` の続きから始まり、既存 `.adr/001` を上書き・改番していないこと、各ファイルが既存 ADR と同じ和文5節構成であることを確認する
- **手順:**
  1. 件数と一覧を見る

     ```bash
     ls -1 .adr/
     ls -1 .adr/ | wc -l
     ```
  2. commit 済み差分で `.adr/` 配下の操作種別を見る

     ```bash
     git diff --name-status main...HEAD -- .adr/
     ```
  3. H1 の書式を全件チェックする

     ```bash
     for f in .adr/*.md; do
       head -1 "$f" | grep -qE '^# 00[1-9]\. .+' && echo "$f: H1 OK" || echo "$f: H1 NG"
     done
     ```
  4. 5節の見出しが既存 `.adr/001` と同一かを厳密比較する

     ```bash
     for f in .adr/00[234]-*.md; do
       if diff -q <(grep '^## ' "$f") \
                  <(printf '## ステータス\n## コンテキスト\n## 決定\n## 検討した代替案\n## 影響\n') >/dev/null
       then echo "$f: 5節 OK"; else echo "$f: 5節 NG"; grep -n '^## ' "$f"; fi
     done
     ```
- **期待結果:** `ls -1 .adr/ | wc -l` が **4**。手順2 の出力が `A .adr/002-*.md` / `A .adr/003-*.md` / `A .adr/004-*.md` の**3行のみ**で、`.adr/001-integration-tests-single-workers-pool.md` の行が **1行も現れない**。手順3 は4件すべて `H1 OK`。手順4 は3件すべて `5節 OK`
- **確認ポイント:** 先行ブランチ `issue/19/cloudflare-do-fts` の `.adr/` は `001` から始まる8件なので、機械的にコピーすると `001` を上書きし件数も8になる（AC-2 / AC-3 を同時に破る。plan.md リスク節）。手順2 に `M .adr/001-*.md` や `.adr/005-*.md` が現れたら失敗。**着手前の実測は 1件（`001` のみ）で `git diff --name-status main...HEAD` は空**なので、手順1 が 1 のまま・手順2 が空なら「まだ commit していない」ことを疑う

### 2. `.adr/` 3件に実装レベルの詳細が流れ込んでいない

- **対応する受け入れ基準:** AC-6
- **目的:** DO の分割数・saga 手順・migration 手順・スキーマ断片・テーブル定義・関数シグネチャといった詳細が `.adr/` ではなく design.md 側に置かれていることを確認する
- **手順:**
  1. 禁止トークンを走査する

     ```bash
     grep -nEi 'CREATE TABLE|INSERT INTO|SELECT .* FROM|PRIMARY KEY|UNIQUE INDEX|bucket|=>|\): Promise<' .adr/00[234]-*.md
     ```
  2. 行数を見る

     ```bash
     wc -l .adr/00[234]-*.md
     ```
  3. コードフェンスの有無を見る

     ```bash
     grep -n '^```' .adr/00[234]-*.md
     ```
- **期待結果:** 手順1 のヒットが0件（exit 1）。手順2 は3件とも **50行以内**（参考: 既存 `.adr/001` は44行）。手順3 のヒットが0件、または出てもファイル名・パスの引用に留まる
- **確認ポイント:** 「bucket 数の具体値」は数字だけでも該当する。ヒットが出た場合は削除ではなく **design.md 側に同じ内容があるか**を先に確認する（内容を捨てずに移すのが plan.md の方針）。定量判定は目安なので、50行をわずかに超えた場合は人間判断項目 H-4 で粒度そのものを見る

### 3. supersede の正本が新 ADR 側にある

- **対応する受け入れ基準:** AC-10
- **目的:** 「何を supersede したか」の本文が新 `.adr/` 側に書かれていることを確認する（旧側は1行ポインタのみ、が plan.md の方針）
- **手順:**
  1. `.adr/002` が `.thread/1/adr.md` の ADR-004 を名指ししているか

     ```bash
     grep -n '\.thread/1/adr\.md' .adr/002-*.md
     ```
  2. `.adr/003` / `.adr/004` が `spec/adr/005` を名指ししているか

     ```bash
     grep -n 'spec/adr/005' .adr/003-*.md .adr/004-*.md
     ```
  3. ヒット行がステータス節か影響節の中にあるかを、見出し位置と突き合わせる

     ```bash
     for f in .adr/00[234]-*.md; do echo "--- $f"; grep -nE '^## |supersede|スーパーシード|置き換え' "$f"; done
     ```
- **期待結果:** 手順1 が1件以上ヒットし、supersede した旨が読める。手順2 は `.adr/003` と `.adr/004` の**両方**でヒットする。手順3 でヒット行が `## ステータス` または `## 影響` の範囲に入っている
- **確認ポイント:** `.adr/004` の影響節には、D1 固有物（`PendingBatch` / `_occ_guard` / 遅延バッチ UoW）が不要になること、ドメインポートの `Promise` 契約が変わりうることの2行が入る想定（plan.md ステップ6）。`.adr/002` の影響節には `.thread/1/adr.md` ADR-002 のトレードオフに関する1行が入る想定（同ステップ4）

### 4. `spec/adr/005` はステータス節だけが変わり、新規ファイルが増えていない

- **対応する受け入れ基準:** AC-7 / AC-9
- **目的:** 本文（コンテキスト以降）を保持したまま superseded ポインタが付き、`spec/adr/` に新規 ADR が作られていないことを確認する
- **手順:**
  1. `spec/adr/` 配下の差分種別を見る

     ```bash
     git diff --name-status main...HEAD -- spec/adr/
     ```
  2. 未コミットの新規追加も塞ぐ

     ```bash
     git status --porcelain | grep 'spec/adr/'
     ```
  3. 差分そのものを見る

     ```bash
     git diff main...HEAD -- 'spec/adr/005-*.md'
     ```
  4. `## コンテキスト` 以降が1文字も変わっていないことを機械判定する

     ```bash
     diff <(git show main:spec/adr/005-search-index-via-outbox.md | sed -n '/^## コンテキスト/,$p') \
          <(git show HEAD:spec/adr/005-search-index-via-outbox.md | sed -n '/^## コンテキスト/,$p') \
       && echo "本文不変 OK"
     ```
  5. ポインタ先が両方を指しているか

     ```bash
     sed -n '/^## ステータス/,/^## コンテキスト/p' spec/adr/005-search-index-via-outbox.md
     ```
- **期待結果:** 手順1 が `M	spec/adr/005-search-index-via-outbox.md` の**1行のみ**（`A` が無い）。手順2 の出力が空。手順4 が `本文不変 OK` を出す。手順5 のステータス節に **`.adr/003` と `.adr/004` の両方**への参照があり、「承認済みであった事実」が残っている
- **確認ポイント:** ステータス行の**書き換え**なので `git diff` に削除行が出るのは正常（AC-7 が禁じているのは本文の改変であって削除行そのものではない）。判定は手順4 の本文比較で行う。`spec/index.md:38-43` の ADR 一覧表の更新は #35 のスコープなので、ここで一緒に直っていたら AC-20 違反

### 5. `.thread/1/adr.md` は1行ポインタの追記だけ

- **対応する受け入れ基準:** AC-8
- **目的:** 1,662行（追記後 1,664行）の作業ログの本文を1文字も壊さずに supersede ポインタが入っていることを確認する
- **手順:**
  1. 追加行数・削除行数を数える

     ```bash
     git diff --numstat main...HEAD -- .thread/1/adr.md
     ```
  2. 差分の中身を見る

     ```bash
     git diff main...HEAD -- .thread/1/adr.md
     ```
  3. 挿入位置を確認する

     ```bash
     grep -n -A 8 '^## ADR-004:' .thread/1/adr.md | head -14
     ```
- **期待結果:** 手順1 の出力が `2	0	.thread/1/adr.md`（追加2 / 削除0）。手順2 の `-` 行（`--- a/...` を除く）がゼロで、追加は空行1行 + supersede ポインタ1行のみ。手順3 で `### Status` → `Proposed` → 空行 → ポインタ行 → 空行 → `### Context` の並びになっている
- **確認ポイント:** 削除行が1本でも出たら失敗。追加が3行以上ある場合は、ポインタを複数行に分けたか本文を書き換えたかのどちらか。**ADR-002（セッション）と ADR-015（AWS の `SESSION_SECRET`）にはポインタを付けない**（plan.md ステップ8）ので、`git diff` のハンクが ADR-004 以外の場所に現れていないかも見る

### 6. コードもコンフィグも変更されていない

- **対応する受け入れ基準:** AC-20
- **目的:** 差分がドキュメントのみに収まり、commit 漏れも無いことを確認する
- **手順:**
  1. 全差分をホワイトリストで濾す

     ```bash
     git diff --name-status main...HEAD \
       | grep -vE '^[AM][[:space:]]+(\.adr/00[234]-.*\.md|\.thread/34/.*|spec/adr/005-.*\.md|\.thread/1/adr\.md)$'
     ```
  2. コード・コンフィグの拡張子が現れないことを直接見る

     ```bash
     git diff --name-only main...HEAD | grep -E '^(packages/core/|apps/web/app/|infra/)|\.(ts|tsx|toml|json|sql)$'
     ```
  3. 未コミットの変更が既知の untracked だけであることを確認する

     ```bash
     git status --porcelain \
       | grep -vE '^\?\? (\.artifacts/|\.thread/36/|apps/web/wrangler\.(request|state)\.(production|staging)\.toml)$'
     ```
- **期待結果:** 手順1・手順2・手順3 のいずれも**出力が空**（exit 1）
- **確認ポイント:** 手順3 のホワイトリストは着手時点の実測（`.artifacts/` / `.thread/36/` / `apps/web/wrangler.{request,state}.{production,staging}.toml` の計6エントリ）に一致させてある。**`.thread/34/` は成果物として commit されるのでホワイトリストに入れていない** — 未 commit のものが残っていると `?? .thread/34/review/` や ` M .thread/34/design.md` として出る（`.thread/34/` 直下の4ファイルを先に commit したあとレビュー往復で `review/` が増えるため、`?? .thread/34/` 1行にはならない）。これは検査の失敗ではなく「まだ commit していない」のサインなので、commit してから再実行する。逆に `.thread/36/` や wrangler 4本が**差分側**（手順1）に現れたら、触らないはずのものを commit してしまっている

### 7. design.md の全節にラベルが付き、対象節が断定形で終わっている

- **対応する受け入れ基準:** AC-5
- **目的:** 「検討する」で終わる節が残っていないこと、AC-5 の射程（`［Issue 要求］` / `［派生］` の全節）がラベルで機械的に定義されていることを確認する
- **手順:**
  1. ラベルが付いていない節見出しを洗い出す

     ```bash
     grep -nE '^#{2,3} ' .thread/34/design.md | grep -vE '［(Issue 要求|派生|参考)］'
     ```
  2. ラベル別の節数を数える。あわせて `##` / `###` の総数と、ラベル付き節数の合計が一致することを見る

     ```bash
     for l in 'Issue 要求' '派生' '参考'; do
       printf '%s: %s\n' "$l" "$(grep -cE "^#{2,3} .*［${l}］" .thread/34/design.md)"
     done
     grep -cE '^#{2,3} ' .thread/34/design.md
     ```
  3. 未決を示す語を全文走査する

     ```bash
     grep -nE '検討する|今後検討|TBD|要検討|未定[^義]|決めきれない|〜次第|次第である|見込み|暫定|保留とする' .thread/34/design.md
     ```
  4. 前方依存の解消を確認する（第4〜6章に暫定表現が残っていないか）。**範囲抽出が壊れて空振りするのを防ぐため、抽出行数を先に見る**

     ```bash
     awk '/^## 4\./,/^## 7\./' .thread/34/design.md | wc -l
     awk '/^## 4\./,/^## 7\./' .thread/34/design.md | grep -nE '暫定|見込み|次第'
     awk '/^## 4\./,/^## 7\./' .thread/34/design.md | grep -nE '従属'
     ```
- **期待結果:** 手順1 の出力が**空**（`##` / `###` の節見出しは全件がラベル付き）。手順2 は3ラベルとも1以上で、3ラベルの合計が総数と一致する（実測: Issue 要求 36 / 派生 24 / 参考 5 = 65 = 総数）。手順3 の出力が**空**。手順4 は1本目が0でない値（走査時点の実測 864行。範囲抽出が壊れると0になり、以降の grep が空振りで通る）を返し、2本目が空。3本目（`従属`）は**未確定の前方依存を示す用法**（「第7章の結論に従属する」型）が0件であればよく、設計上の記述としての「従属」は許容する（実測1件 — `report-login-result` の成功報告が request Worker の照合結果に従属するという第5.1節の記述）
- **確認ポイント:** ラベルは **`##`（章）と `###`（節）にだけ付ける運用**で、`####` の小見出しは親節のラベルを継承するため手順1 の射程から外してある（`^#{2,4}` にすると `#### コーディネーターの選び方と役割` のような番号なし小見出しが全件かかり、判定が成立しない）。手順3 の `未定[^義]` は「未**定義**」への誤ヒットを避けるためで、`未定` 単体にすると設計上正しい記述が2件かかる。手順3 でヒットが出た場合はファイル名だけでは判定できないので、必ず**その行がどの節に属するか**を見る — 許容できるのは `［参考］` ラベルの節と、第11.4節「未決事項」の表のうち**引き取り先 Issue が併記されている行**だけである。とくに次の7箇所は AC-5 が名指しで対象に含めているので、結論位置に未決語があってはいけない — 「FTS5 の同期更新」「Outbox / relay / consumer / DLQ の廃止範囲」「Alarm ジョブ」「trash retention の期限処理」「外部 I/O を永続ジョブに残す境界」「UoW 契約」章・「スキーマバージョン管理と lazy migration」章、加えて「FTS5 のみで日本語全文検索が成立する根拠」と「分割方式」（`.adr/003` と #37 の前提がここに懸かる）。意味レベルの断定判定は人間判断項目 H-5 で行う

### 8. User Data DO の保持データ範囲とドメイン対応

- **対応する受け入れ基準:** AC-4（User Data DO の部分）/ AC-11
- **目的:** Issue が列挙した7項目がすべて対応表の行として現れ、既存ドメイン集約との対応が取られていることを確認する
- **手順:**
  1. 章の存在を確認する

     ```bash
     grep -nE '^## .*User Data DO' .thread/34/design.md
     grep -nE '^### 4\.' .thread/34/design.md
     ```
  2. 7項目のキーワードが「保持データ範囲」節の表に現れるか走査する（範囲は「見出しの次行から次の `###` の直前まで」。`awk '/A/,/B/'` の範囲式は開始行が終了パターンにも一致すると**その1行だけ**になるので使わない）

     ```bash
     awk '/^### .*保持データ範囲/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -nE 'ユーザー単位設定|AI client|AiClientConnection|memo|revision|topic|document|source link|trash|retention|FTS5|冪等'
     ```
- **期待結果:** 手順1 で「User Data DO」章と 4.1〜4.8 相当の節が出る。手順2 で7項目（ユーザー単位設定 / AI client connections / memos・memo revisions / topics・documents・document revisions・source links / trash・retention 状態 / FTS5 インデックス / 冪等化・非同期処理状態）すべてに対応する行が確認できる（実測: 対応表の7行が `| 1 |` 〜 `| 7 |` として順に出る）
- **確認ポイント:** 「対応表がある」だけでは足りず、**各行に既存ドメイン集約（`domain/identity/` など spec 上の集約名）が対置されている**ことを見る。実装済みが `identity/User` だけであることを理由に空欄になっている行が無いか

### 9. ルーティング / PII / canonical 化

- **対応する受け入れ基準:** AC-4（ルーティングの部分）/ AC-12 / AC-14 / AC-23
- **目的:** `userId` → DO locator の経路、外部入力が locator に到達しない構造的担保、PII 非露出、canonical 化まわりの4前提が結論として書かれていることを確認する
- **手順:**
  1. 章・節の存在を見る

     ```bash
     grep -nE '^## .*ルーティング|^### 5\.|^#### 5\.' .thread/34/design.md
     ```
  2. 経路の記述を確認する

     ```bash
     grep -nE 'sessionCodec|requireUserId|getCurrentUserId|locator|idFromName' .thread/34/design.md | head -20
     ```
  3. PII 3点（生値を使わない / HMAC・hash を使う / ログ・URL・エラーに出さない）を走査する

     ```bash
     awk '/^### .*DO ID \/ routing key と PII/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -nE 'HMAC|ハッシュ|hash|ログ|URL|エラーメッセージ|生値|生メール'
     ```
  4. canonical 化の4項目に対応する節があるか

     ```bash
     grep -nE 'canonical 化の定義|locator 鍵の分離|ハッシュ衝突の扱い|canonical credential の保持と保護' .thread/34/design.md
     ```
- **期待結果:** 手順1 で「ルーティング」章と 5.1〜5.5 相当の節が出る。手順2 で session / token → `userId` → DO locator の経路が追える。手順3 が0件でなく（実測15行）、(a)(b)(c) の3点が結論として書かれている。手順4 で4つの節タイトルがすべてヒットする（実測: `canonical 化の定義` / `locator 鍵の分離` / `ハッシュ衝突の扱い` / `canonical credential の保持と保護` の4見出し）
- **確認ポイント:** AC-23 (b) は「鍵ローテーションの対象が credential 由来 locator に限られ、User Data DO の同一性に波及しない」ことが読み取れる必要がある。`userId` 由来 locator と credential 由来 locator を分けずに「世代付き secret で HMAC」とだけ書かれていたら不足（plan.md リスク節「鍵ローテーションがデータ本体の移送になる」）。また `ctx.id.name` は DO の内側から可読なので、生クレデンシャルを DO 名に使わない方針が PII 節と整合しているかも見る

### 10. Identity Directory DO の5論点と分散トランザクション非前提

- **対応する受け入れ基準:** AC-4（Identity Directory DO の部分）/ AC-13 / AC-15
- **目的:** 解決責務 (a)〜(d)・分割方式・部分失敗・冪等性・SSO リンク／解除の5点が個別の結論として書かれ、DO 間分散トランザクションを前提としない宣言と代替（saga + 冪等な補償）があることを確認する
- **手順:**
  1. 節の存在を見る（本文中の言及ではなく**見出し**で数える）

     ```bash
     grep -nE '^### .*(解決責務|分割方式|部分失敗|冪等|SSO リンク|分散トランザクション)' .thread/34/design.md
     ```
  2. 解決責務の4サブ項目を確認する

     ```bash
     awk '/^### .*解決責務/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -nE '正規化メール|findByEmail|SSO|providerSubject|findBySsoIdentity|一意性|パスワードリセット|所有境界'
     ```
  3. 分割方式が決め切られているかを見る

     ```bash
     awk '/^### .*分割方式/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -nE '採用|採らない|決定|単一グローバル|bucket|credential 単位|#37'
     ```
- **期待結果:** 手順1 で6論点すべての節見出しがヒットする（実測: 解決責務 / 分割方式 / 部分失敗と補償 / リトライ時の冪等性 / SSO リンク・解除の整合性 / DO 間分散トランザクションを前提としない宣言 の6件）。手順2 で (a) 正規化メール → `userId` / (b) SSO provider + subject → `userId` / (c) メール・SSO 主体の一意性 / (d) パスワード認証・リセットの認証情報の所有境界 が個別の結論として読める。手順3 で3案（単一 / 固定 bucket / credential 単位 DO）が4軸で比較され、**採用案が断定されている**（実測: `(a) を採らない理由` / `(c) を採らない理由` が明示され、(b) が採用される）
- **確認ポイント:** 「(b) が有力だが最終決定は #37」で終わっていたら AC-5 / AC-13 の失敗（plan.md が名指しで禁じている）。「単一グローバル DO」を無条件採用していないこと、既存実装（`users_email_uq` / `users_sso_identity_uq` / `findByEmail` / `findBySsoIdentity`）を「どう移すか」として書かれていることも見る

### 11. ユーザー境界に閉じない処理の全数棚卸し

- **対応する受け入れ基準:** AC-22
- **目的:** `spec/inventory/adapter.md` の `ADP-*` 台帳を走査した結果として、述語に該当する全件が design.md の表に行として存在し、各行に行き先が入っていることを確認する
- **手順:**
  1. 台帳の総数を確認する（主判定の母集団）

     ```bash
     grep -oE 'ADP-[a-z0-9-]+-[0-9]{3}' spec/inventory/adapter.md | sort -u | wc -l
     ```
  2. design.md の表が参照している `ADP-*` を抜き出す

     ```bash
     grep -oE 'ADP-[a-z0-9-]+-[0-9]{3}' .thread/34/design.md | sort -u > /tmp/adp-design.txt
     grep -oE 'ADP-[a-z0-9-]+-[0-9]{3}' spec/inventory/adapter.md | sort -u > /tmp/adp-ledger.txt
     comm -13 /tmp/adp-design.txt /tmp/adp-ledger.txt   # 台帳にあって design.md に無いもの
     ```
  3. 述語の定義が表より前に書かれているか

     ```bash
     awk '/^### .*ユーザー境界に閉じないものの帰属/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md | head -12
     ```
  4. 表の各行に行き先が入っているか（補助）。**行き先の語をホワイトリストで数えると新しい行き先が増えるたびに壊れる**ので、「行き先列（5列目）が空でないこと」を見る

     ```bash
     awk '/^### .*ユーザー境界に閉じないものの帰属/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -cE '^\| [0-9]+ \|'
     awk '/^### .*ユーザー境界に閉じないものの帰属/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -E '^\| [0-9]+ \|' \
       | awk -F'|' '{ s=$6; gsub(/^[ \t]+|[ \t]+$/, "", s); if (s == "") print "行き先が空: " substr($0, 1, 80) }'
     ```
- **期待結果:** 手順1 が **85**（実測値。台帳が更新されていれば数は動く）。手順2 の `comm` 出力に残る `ADP-*`（実測32件）が、**述語に該当しない（＝ユーザー境界に閉じる）ものだけ**である。手順3 で述語 (a)(b)(c) の定義が表の前に置かれている。手順4 は1本目が**0でない値**を返し（行数そのものは主判定ではない。走査時点の実測は30〜35行で、design.md の改訂ごとに動く）、2本目の出力が**空**（＝全データ行に行き先がある）
- **確認ポイント:** **主判定は手順2 の走査そのもの**であって行数ではない。plan.md の表は8カテゴリ29行だが、これは走査の結果であって目標値ではない（1周目7件 → 2周目16行 → 3周目25行 → 29行 → 35行と拡大し続けている）。行き先は「User Data DO に閉じる / Directory / 不要になる」の3種類に限られない — 実測では `request Worker で回す`（CPU 予算の理由で DO の外へ出すもの）も行き先として使われている。手順2 で残った `ADP-*` は1件ずつ述語を当て直す — (a) `userId` を第一引数に取らないポート（引数オブジェクトの中に `userId` がある場合も該当）、(b) 引き方の経路に `user_id` が入っていないテーブル、(c) 台帳の粒度で捕まらない次元（DI 構成・ジョブ・spec 上の未設計領域）

### 12. Account Home DO の採否が結論づけられている

- **対応する受け入れ基準:** AC-21
- **目的:** 「未決事項」に落とさず本 Issue で決着していることを確認する
- **手順:**
  1. 結論の所在を見る

     ```bash
     awk '/^### .*クラス構成と責務分界/{f=1;next} f&&/^### /{f=0} f' .thread/34/design.md \
       | grep -nE 'Account Home|採用|採らない|畳む|2クラス|3クラス'
     ```
  2. 未決事項の節に現れないことを確認する

     ```bash
     awk '/^### .*未決事項/{f=1} f' .thread/34/design.md | grep -n 'Account Home'
     ```
- **期待結果:** 手順1 に「採用する / しない」の断定と理由がある（実測: 冒頭が `2クラス構成を採る。**Account Home DO は採用しない。**`、続けて採らない理由3点と「採らないことで失うもの」）。手順2 の**出力が空**
- **確認ポイント:** Account Home を採る場合は、`.thread/1/adr.md` ADR-002 のトレードオフ（DB を触らずに検証する / サーバー側失効の手段が無い）が実質的に覆ることと、「セッション方式そのものを扱う別 ADR を起こす必要があるか」の判断結果が第5.1節相当の節に書かれている必要がある（#37 に投げていないこと）

### 13. #35 への引き継ぎ表の網羅性

- **対応する受け入れ基準:** AC-16（機械検証できる範囲）
- **目的:** 改訂対象の spec ファイルが一覧化され、AC-16 が名指しした必須項目が漏れていないことを確認する
- **手順:**
  1. 必須パスが引き継ぎ表に現れるかを機械チェックする

     ```bash
     for p in spec/requirements.md spec/domains/search.md spec/domains/memo.md spec/domains/knowledge.md \
              spec/domains/identity.md spec/domains/trash.md spec/domains/index.md spec/database/index.md \
              spec/usecases/search.md spec/usecases/trash.md \
              spec/testcases/search/maintainSearchIndex.md spec/testcases/trash/pruneExpiredTrashItems.md \
              spec/inventory/domain.md spec/inventory/adapter.md spec/inventory/usecase.md spec/inventory/test.md \
              spec/index.md spec/scenario/search.md spec/manual-tests/search.md spec/manual-tests/trash.md \
              spec/pages/index.md CLAUDE.md; do
       grep -q "$p" .thread/34/design.md || echo "MISSING in design.md: $p"
     done
     ```
  2. 網羅性の裏取り走査（plan.md ステップ3 と同じ手）

     ```bash
     grep -rlE 'Outbox|outbox|consumer|ベクトル|埋め込み|ハイブリッド' spec \
       | grep -vE '/review/|spec/idea\.md' | sort > /tmp/spec-hits.txt
     wc -l < /tmp/spec-hits.txt
     while read -r p; do grep -q "$p" .thread/34/design.md || echo "判定なし: $p"; done < /tmp/spec-hits.txt
     ```
- **期待結果:** 手順1 の出力が空。手順2 の件数は **40**（実測。`spec/*/review/**` と `spec/idea.md` を除いた値）で、`判定なし:` の行が出ない（＝ヒット全件に「改訂する / 影響なし」の判定が付いている）
- **確認ポイント:** `spec/requirements.md` は `:87`（キーワード検索とベクトル検索のハイブリッド）と `:108`（search — ハイブリッド検索）の**2箇所**が対象。`spec/database/index.md` は `:355-357` のスコープ外宣言を含むこと、`spec/inventory/` は domain / adapter だけでなく **usecase / test の2台帳**も挙がっていることを見る。手順2 で「影響なし」判定が大量に付いている場合は、判定が機械的に流されていないかを人間判断項目 H-1 で確認する

### 14. #37 への引き継ぎ表の網羅性

- **対応する受け入れ基準:** AC-17（機械検証できる範囲）
- **目的:** 削除対象・新設対象のモジュールが一覧化され、AC-17 が名指しした必須項目が漏れていないことを確認する
- **手順:**
  1. 必須パスの機械チェック

     ```bash
     for p in 'adapters/d1/' 'application/workers/' 'application/execution/unitOfWork.ts' \
              'application/ports/outboxRepository' 'application/ports/relayTrigger' 'application/ports/idempotencyStore' \
              'di/serverCloudflare.ts' 'application/di/types.ts' 'application/di/containerStore.ts' \
              'WorkerContainer' 'apps/web/app/presentation/' 'infra/cloudflare/pulumi/resources/index.ts' \
              'scripts/render-wrangler.ts' 'wrangler.toml' 'vitest.config.integration.ts'; do
       grep -q "$p" .thread/34/design.md || echo "MISSING in design.md: $p"
     done
     ```
  2. `package.json` のスクリプト群への言及を確認する（`db:generate` 系を落とさない — D1 用 `drizzle.config.ts` に依存するので道連れになる）

     ```bash
     grep -nE 'deploy:(staging|production)|db:(migrate|generate|apply|execute)' .thread/34/design.md | head
     ```
  3. 対象ファイルが実在することを確かめる（引き継ぎ先が存在しないパスを指していないか）

     ```bash
     for p in packages/core/src/adapters/d1 packages/core/src/application/workers \
              packages/core/src/application/execution/unitOfWork.ts \
              packages/core/src/application/ports/outboxRepository.ts \
              packages/core/src/application/ports/relayTrigger.ts \
              packages/core/src/application/ports/idempotencyStore.ts \
              packages/core/src/application/di/serverCloudflare.ts \
              packages/core/src/application/di/types.ts \
              apps/web/app/presentation apps/web/scripts/render-wrangler.ts apps/web/wrangler.toml \
              infra/cloudflare/pulumi/resources/index.ts vitest.config.integration.ts; do
       [ -e "$p" ] || echo "NOT FOUND: $p"
     done
     ```
- **期待結果:** 手順1・手順3 の出力が空。手順2 で deploy 系（非 dry 12本 / dry を含め24本）と `db*` スクリプト **10本すべて**（`db:migrate` / `db:migrate:cf` / `db:generate` / `db:generate:cf` / `db:apply:{local,staging,production}` / `db:execute:{local,staging,production}`）への言及がある。件数は `node -e "const s=Object.keys(require('./apps/web/package.json').scripts); console.log(s.filter(k=>k.startsWith('db')).length, s.filter(k=>k.startsWith('deploy')).length)"` で裏を取る（実測 `10 24`）
- **確認ポイント:** `WorkerContainer` は **indexer 専用と pruner 専用の2種類**が挙がっていること（片方だけだと AC-17 の失敗）。ローカル開発用 `apps/web/wrangler.toml`（DO バインディングが1つも無い）と、`.gitignore` によりレンダリング生成物である `wrangler.{staging,production}.toml` を直接編集できない点の両方が書かれていること。UoW 契約は「新旧対比」が読める形になっていること

### 15. 成果物の自己完結性（機械走査の部分）

- **対応する受け入れ基準:** AC-19
- **目的:** 先行ブランチ・`.thread/19/`・`.thread/1/adr.md` を開かないと読めない箇所が無いことを、まず機械的に洗い出す
- **手順:**
  1. 外部参照を列挙する

     ```bash
     grep -nE 'issue/19/cloudflare-do-fts|\.thread/19/|git show|\.thread/1/adr\.md|spec/domains/search\.md' \
       .thread/34/design.md .adr/00[234]-*.md
     ```
  2. 「先行案との差分」の節が要旨を持つかを見る

     ```bash
     awk '/^### .*先行案.*との差分/,/^## 2\./' .thread/34/design.md
     ```
- **期待結果:** 手順1 のヒットがすべて「出自の注記」の文脈（`... を採用した（出自: ...）`）に留まり、参照先を開かないと結論が分からない書き方になっていない。手順2 の表の各行が『採用 / 棄却 / 保留』のラベルだけでなく**採用した内容の要旨**を持つ
- **確認ポイント:** `.thread/19/` は先行ブランチ上にしか存在せず（現ブランチでは `git show issue/19/cloudflare-do-fts:...` でしか読めない）、`spec/domains/search.md` は #35 で書き換わる。この2つを「読めば分かる」で済ませている箇所は AC-19 違反。最終判定は人間判断項目 H-3

### 16. `.thread/34/adr.md` へのメタ判断の追記

- **対応する受け入れ基準:** AC-18
- **目的:** 実装中に下した「`.adr/` へ昇格させなかった」判断が記録されていることを確認する
- **手順:**
  1. ADR の件数を数える

     ```bash
     grep -cE '^## ADR-[0-9]{3}' .thread/34/adr.md
     grep -nE '^## ADR-(0[2-9][0-9]|[1-9][0-9]{2})' .thread/34/adr.md
     ```
  2. 追記が無い場合の明記を探す

     ```bash
     grep -nE '昇格を見送った判断|該当なし|追記なし' .thread/34/adr.md
     ```
  3. `.adr/` の3件と内容重複していないかを見る

     ```bash
     for f in .adr/00[234]-*.md; do echo "--- $f"; head -1 "$f"; done
     grep -E '^## ADR-(0[2-9][0-9]|[1-9][0-9]{2})' .thread/34/adr.md
     ```
- **期待結果:** 手順1 の件数が **着手時点の19件から増えている**（ADR-020 以降が存在する。実測 87件 / ADR-020〜ADR-087）。増えていない場合は手順2 で「昇格を見送った判断が無かった」旨が明記されている。手順3 で追記分の主題が `.adr/002〜004` の主題（ランタイム・データ配置 / 検索方式 / 非同期処理）と重複していない
- **確認ポイント:** 存在チェックだけでは着手前の19件で空振りするので、**必ず件数の増加**を見る（着手時点の実測は19件）。番号の走査は `ADR-0(2|3)[0-9]` では ADR-040 以降を取りこぼすので、3桁全域（`0[2-9][0-9]` / `[1-9][0-9]{2}`）で見る

### 17. 文書間リンクと ADR 参照の整合

- **対応する受け入れ基準:** 横断（AC-19 の補助 / plan.md ステップ10 の相互整合検証）
- **目的:** design.md ↔ `.adr/` の相互参照が成立し、リンク切れと無修飾の ADR 参照が無いことを確認する
- **手順:**
  1. リポジトリ相対パスの実在チェック

     ```bash
     grep -ohE '`(\.adr|\.thread|spec|docs|packages|apps|infra)/[^`]*`' .thread/34/design.md .adr/00[234]-*.md \
       | tr -d '`' | sed 's/[:#].*//' | grep -vE '[*{} 〜]' | sort -u \
       | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
     ```
  2. 無修飾の `ADR-NNN` を洗い出す

     ```bash
     grep -nE 'ADR-[0-9]{3}' .thread/34/design.md .adr/00[234]-*.md \
       | grep -vE '\.adr/|\.thread/[0-9]+/adr\.md|spec/adr/'
     ```
  3. 双方向参照の成立を見る

     ```bash
     grep -n 'design\.md' .adr/00[234]-*.md
     grep -nE '\.adr/00[234]' .thread/34/design.md | head
     ```
- **期待結果:** 手順1 の `MISSING:` が次の3種類だけに収まる（実測6件） — (i) ADR 番号の短縮表記（`.adr/002` / `.adr/003` / `.adr/004` の拡張子なし言及）、(ii) 先行ブランチにしか存在しないパス（`.thread/19/adr.md` / `.thread/19/spike/fts5.integration.test.ts`）、(iii) **本文が「現ブランチに存在しない」と明示的に述べているパス**（`apps/web/app/server.state.ts`。未コミットの wrangler 4本が動かない理由として第2章が名指ししている）。手順2 のヒットは、見出し自身（`## ADR-004: ...` の形）か、**既存 spec 本文の逐語引用**（同じ行に引用元の `spec/**.md` パスがある）に限られる（実測1件 — `spec/usecases/knowledge.md:16` の「Outbox 経由。ADR-005」の引用）。それ以外の無修飾 `ADR-NNN` は不合格（`.thread/1/adr.md` / `spec/adr/` / `.adr/` の3文書を指しうるため、`.thread/1/adr.md` ADR-046 の規約でパス付きが必須）。手順3 で `.adr/` → design.md と design.md → `.adr/` の参照が両方向とも出る（実測: `.adr/` 3件すべてが design.md を参照 / design.md → `.adr/00[234]` が20行）
- **確認ポイント:** 手順1 は候補一覧なので、上の (i)(ii)(iii) 以外が1件でも増えたらリンク切れとして扱う。とくに (iii) は「本文が不在を主張しているから正しい」のであって、不在のパスを注記なしに引いていたら不合格

---

## 人間による判断が必要な確認項目

機械検証では成立を判定できず、読んで判断するしかない項目。上の確認項目17件をすべて通したあとに実施する。

### H-1. #35 の担当者になったつもりで design.md だけを読んで着手できるか

- **対応する受け入れ基準:** AC-16
- **やり方:** `.thread/34/design.md` の「#35 への引き継ぎ」の節**だけ**を開き、`issue/19/cloudflare-do-fts` / `.thread/19/` / `.thread/1/adr.md` / plan.md を一切開かずに、「どの spec ファイルの、どの記述を、何に書き換えるか」を自分で列挙してみる
- **判定:** 改訂対象ファイルと改訂方針の両方が特定でき、`spec/domains/search.md`（271行）のどの節が消えて何に置き換わるかまで読み取れれば合格。ファイル名だけが並んでいて「どう直すか」が書かれていない行があれば不合格

### H-2. #37 の担当者になったつもりで design.md だけを読んで着手できるか

- **対応する受け入れ基準:** AC-17
- **やり方:** 「#37 への引き継ぎ」の節と第8章（UoW 契約）・第9章（lazy migration）を読み、削除するモジュール / 新設するモジュール / UoW の新旧契約を自分で書き出してみる
- **判定:** `adapters/d1/` の何が消えて何に置き換わるか、`PendingBatch` / `_occ_guard` / 遅延バッチが不要になる理由、新 UoW が `transactionSync` の完全同期制約とどう噛み合うかが読み取れれば合格。DO クラス数・saga の phase 数・session 検証の形が未決のまま残っていたら不合格（#37 が1行も書けない）

### H-3. 成果物の自己完結性

- **対応する受け入れ基準:** AC-19
- **やり方:** 確認項目15 の手順1 で列挙された外部参照を1件ずつ開き、「参照先を開かなくても本文だけで意味が通るか」を判定する
- **判定:** すべてが「出自の注記」に留まっていれば合格。1件でも「詳細は `.thread/19/adr.md` ADR-00N を参照」の形で内容を代替していたら不合格

### H-4. `.adr/` に書かれた各段落が寿命テスト・波及テストを満たすか

- **対応する受け入れ基準:** AC-6
- **やり方:** `.adr/002` / `.adr/003` / `.adr/004` を通読し、各段落について「この決定を覆したら何に波及するか」「5年後も参照されるか」を問う。逆に design.md 側の内容で `.adr/` に昇格すべきものが漏れていないかも見る
- **判定:** 禁止トークンには引っかからないが実装手順に踏み込んでいる段落（例: saga の phase を順に説明する / migration の適用順を書く）があれば design.md へ移す。判断の結果は `.thread/34/adr.md` に記録する（AC-18 の追記対象）

### H-5. 断定形の意味判定

- **対応する受け入れ基準:** AC-5
- **やり方:** `［Issue 要求］` / `［派生］` ラベルの節を頭から読み、各節の**末尾**が結論になっているかを見る。確認項目7 の手順3 は語彙のヒットしか見ないため、「A と B を比較した。どちらも一長一短である。」のように未決語を使わずに結論を書いていない節はここでしか捕まらない
- **判定:** とくに「FTS5 の同期更新」「分割方式」「FTS5 のみで日本語全文検索が成立する根拠」「UoW 契約」「lazy migration のロールバック方針」の5節は、結論が無いと `.adr/003` / `.adr/004` が宙に浮くので重点的に見る

### H-6. PII 方針の一貫性

- **対応する受け入れ基準:** AC-14 / AC-23
- **やり方:** routing key の導出・ログ・URL・エラーメッセージ・DO 名（`ctx.id.name` が DO 内部から可読で、ダッシュボードのメトリクスからも名前で絞り込める）のすべてを追い、「ここだけ生値が出る」箇所が残っていないかを見る
- **判定:** 1箇所でも生メールアドレス・SSO subject が経路に残っていたら不合格。canonical credential（メール原本）の保持場所が特定でき、その保護方式が書かれていることも見る

---

## エッジケース・異常系

### 1. commit 前に検証して全項目が空振りで通る

`git diff --name-status main...HEAD` は commit 前だと空を返す（着手時点の実測でも空）。この状態で確認項目1・4・5・6 を実行すると「違反が無い」ではなく「差分が無い」で通ってしまう。**必ず `git status --porcelain | grep '\.thread/34/'` を先に見て出力が空であること（＝成果物が commit 済みであること）を確認してから機械検証に入る。** レビュー往復のあいだは `?? .thread/34/review/` と改訂中の `design.md` / `testing.md` がここに出続けるので、最終判定は全部 commit してから行う。

### 2. `.thread/36/` をホワイトリストから落として誤検知する

確認項目6 の手順3 のホワイトリストから `.thread/36/`（#36 の作業ログ。マージ済みだが untracked のまま残っている）を落とすと、この検査は**必ず1件多く出て誤検知で止まる**。逆に `.thread/36/` を commit して黙らせると、今度は確認項目6 の手順1（差分のホワイトリスト）を破る。**ホワイトリストへの追加以外に逃げ場が無い**ので、6エントリの構成を変えない。

### 3. `.adr/001` の上書き・改番

先行ブランチの `.adr/` は `001` から始まる8件。コピー由来の事故は確認項目1 の手順2 で `M .adr/001-*.md` または `.adr/005-*.md` 以降として現れる。検出したら、`git show main:.adr/001-integration-tests-single-workers-pool.md` と現物を diff して復元する。

### 4. `spec/adr/005` の本文に手が入る

ステータス行の書き換えは削除行を伴うため、`git diff` の見た目だけでは本文改変と区別できない。判定は必ず確認項目4 の手順4（`## コンテキスト` 以降の全文比較）で行う。ここが `本文不変 OK` を出さない場合は、`git checkout main -- spec/adr/005-search-index-via-outbox.md` で戻してからステータス節だけを編集し直す。

### 5. `.thread/1/adr.md`（1662行）の意図しない書き換え

編集ツールの操作ミスで本文が壊れると `git diff --numstat` の削除列が0でなくなる。`2	0` 以外の値が出たら、追加も削除もその場で戻す。ADR-002 / ADR-015 にポインタが付いていないことも `git diff` のハンク位置で見る。

### 6. design.md 第7.1節が否定的結論になった場合

「FTS5 を本体と同一トランザクションで同期更新できる」が否定されると、実装ステップ7（`spec/adr/005` の supersede）の前提が崩れる。その場合は AC-7 / AC-10 の supersede 対象を見直す必要があり、確認項目4 の期待結果（`.adr/003` と `.adr/004` の両方を指す）も変わる。**確認項目4 を実行する前に、design.md の「FTS5 の同期更新」の節の結論を先に読む。**

### 7. 前方依存の解消漏れ

第4.3節（境界に閉じないものの帰属）・第5.4.1節 (b)（トークン失効の到達手段）・第6.4節（部分失敗と補償）は第7章の結論に従属する。ステップ2 で「暫定」と書いたまま確定に置き換え忘れると、機械検証（確認項目7 の手順4）で `暫定` / `見込み` / `次第` が残る。ヒットしたら第7章の該当節を読んで確定表現に置き換える。

### 8. 未コミットの残骸を巻き込んで commit する

`apps/web/wrangler.{request,state}.{production,staging}.toml` の4本は先行ブランチの残骸で、参照する `apps/web/app/server.state.ts` が現ブランチに存在しない。本 Issue では commit も削除もしない。誤って `git add -A` すると確認項目6 の手順1・手順2 の両方で `.toml` として検出される。

---

## 既存機能への影響確認

- **アプリケーションの実行時挙動** — 影響なし。差分に `packages/core/` / `apps/web/app/` / `infra/` / `*.ts` / `*.toml` が1件も含まれないこと（確認項目6 の手順2）で担保する。起動しての回帰確認は不要。
- **CI（`.github/workflows/ci.yml`: Lint / Format check / Typecheck / Unit tests / Integration tests）** — Biome の `files.includes` は `apps/**` / `packages/**` / `infra/**` / ルート直下の `*.ts` / `*.json` に限られ、`.adr/` / `.thread/` / `spec/` の Markdown は対象外。したがって本 Issue の差分は lint / format のどちらにも反応しない。念のため一度だけ実行して baseline と同じであることを確認する。

  ```bash
  pnpm lint          # 実測: exit 0（150 files checked / Found 2 infos）
  pnpm format:check  # 実測: exit 0（167 files checked）
  ```

  `pnpm typecheck` / `pnpm test` は TypeScript とテストコードにしか反応しないため、本 Issue では実行しなくてよい（実行しても差分に対して無反応）。
- **`spec/adr/005` を参照している相対リンク6本** — `spec/index.md:42` / `spec/database/index.md:6` / `spec/domains/search.md:3` / `spec/domains/memo.md:6` / `spec/domains/knowledge.md:6` / `spec/usecases/search.md:3`。いずれもファイル自体を指しており、ステータス節の書き換えでは壊れない。実測で確認する。

  ```bash
  grep -rn '005-search-index-via-outbox' spec --include='*.md' | grep -v '^spec/adr/005'
  # 期待: 6行（上記の6箇所）
  ```

- **`spec/index.md:38-43` の ADR 一覧表** — `spec/adr/005` のステータスが変わっても表の行は #35 で更新する。本 Issue の差分に `spec/index.md` が現れないことが正しい状態（確認項目6 の手順1 で検出される）。
- **`spec/manual-tests/{search,trash}.md` の前提** — search 側は「検索インデックス更新用のワーカー（非同期 consumer）が起動している」、trash 側は「pruner ワーカーを手動起動できること」を前提にしている。FTS5 同期更新と Alarm 化でこの前提は成立しなくなるが、**マニュアルテストの書き換えは #35 のスコープ**。本 Issue では design.md の引き継ぎ表に拾われていること（確認項目13 の手順1）だけを確認する。
