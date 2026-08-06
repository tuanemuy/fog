# 動作確認計画 — Issue #20: パスワードハッシュのコストパラメータを見直す

**Issue:** #20
**作成日:** 2026-08-07
**確定した案:** **案 A（PBKDF2-HMAC-SHA512 @ 210,000）**。判定ゲート `G-1`（`t_A ≤ 2.0 × t_B`）に CI（x86_64）実測が落ちて確定した — `.thread/1/adr.md` の「実測結果（#20 / 2026-08-07）」節を参照。**本書は案 A で確定した後の版であり、案 B 専用の手順は取り除いてある**（案 B は不採用のため対象外）。

---

## 確認環境

このIssueの変更を確認するために必要な手順のみ記載する。プロジェクト全体のセットアップ（`pnpm install` 等）は省略。

ターゲットランタイムは **Cloudflare Workers + D1**（ローカルは `@cloudflare/vite-plugin` の workerd + ローカル D1）。

### 検証環境の起動

```bash
# 1. wrangler が読むローカル秘密情報（apps/web/.dev.vars が未作成の場合のみ）
cp apps/web/.dev.vars.example apps/web/.dev.vars
openssl rand -base64 48     # 出力を apps/web/.dev.vars の SESSION_SECRET= に貼る（32文字以上）

# 2. ローカル D1 にマイグレーションを適用
#    = pnpm db:migrate:cf = wrangler d1 migrations apply tanstack-start-template-d1 --local
pnpm db:migrate

# 3. 開発サーバー起動（= pnpm dev:cf = vite dev --config vite.config.cloudflare.ts）
pnpm dev
```

起動後 `http://localhost:3000` を開く。

- **マイグレーションは必要。** 本 Issue はスキーマに触らないが、ローカル D1 に `users` テーブルが無ければ登録もログインもできない。適用済みなら「no migrations to apply」で終わる（再実行して害はない）。実測でローカル D1 は `apps/web/.wrangler/state/v3/d1` に作られる。
- **シードデータは不要。** 検証用アカウントは確認項目1 で `/signup` から作る。
- **`pnpm start`（`wrangler dev`）と `pnpm preview` は使わない。** 本 Issue 以前から起動できない（`eventRelayWorker.ts` の module-scope `crypto.randomUUID()` を workerd が拒否する。Issue #40）。`pnpm dev` がローカルでアプリを動かす唯一の方法である。
- **`SESSION_SECRET` は既定値を持たない**（`.dev.vars.example` は空で出荷される）。空のままだと全リクエストが失敗する。

### 保存されたハッシュを覗く手段

ローカル D1 へ直接 SQL を投げられる。**このIssueの中心的な確認手段**なので必ず使う（実測で疎通確認済み）。

```bash
# 全ユーザーの保存ハッシュを読む（アドホックな SELECT はこちら）
pnpm --filter @repo/web exec wrangler d1 execute tanstack-start-template-d1 --local \
  --command "SELECT email, auth_method, password_hash FROM users;"
```

`$` を含む値を書き込む UPDATE など、シェルの変数展開を避けたい場合は `.sql` ファイル経由にする。

```bash
# ルートの db:execute:local は末尾が `--file` なので、引数にパスを渡す
# （スクリプトの cwd は apps/web なので、パスは apps/web 相対か絶対パスで書く）
pnpm db:execute:local ./legacy.sql
```

ローカル D1 は `.wrangler/` 配下にあり `.gitignore:11` で除外されているので、**ブランチを切り替えても行は消えない**。確認項目4 はこの性質を使う。

### デプロイ方法

**なし。** 本 Issue の確認はローカルで完結する。fog はまだどの環境にもデプロイされておらず（plan.md「前提」＝初回本番デプロイ未実施）、それが本計画の成立条件そのものである。`pnpm deploy:staging*` / `pnpm deploy:production*` は本 Issue の確認手順に含めない。

### 対象外（実機では確認しないこと）

次の受け入れ基準は自動テスト・型検査・CI・grep・ドキュメント査読で閉じるため、実機確認の対象にしない。

- **AC-1 / AC-2 / AC-3** — workerd 実測プローブと CI ラン、プローブ撤去の確認（`git status` / `gh run` / CI の緑）
- **AC-9 / AC-11** — 型ピンと `pnpm typecheck`（`@ts-expect-error` が assertion 本体）
- **AC-6 の識別子対応・拒否ケース表** — アダプター単体テストが実アルゴリズムの権威（`docs/test.md`）。実機で確認するのは AC-6 のうち「旧形式が読める」という**利用者から見える帰結**だけ（確認項目5）
- **AC-10 / AC-12 / AC-13 / AC-15** — テスト名・JSDoc・ADR-003・`progress.md` の記述訂正（grep とレビュー）
- **AC-14** — `pnpm test:unit` / `test:integration` / `lint` / `format:check`

---

## 確認項目

**案 A で確定したので、確認項目1〜7 をすべて実施する。**（当初は「1〜4 は両案で実施、5〜6 は案 A のときのみ」という条件付きだったが、条件は解消済み。）

### 1. 新規登録 → ログアウト → ログインの往復がブラウザで通る

- **対応する受け入れ基準:** AC-4 / AC-8（実行経路として）
- **目的:** ハッシュ生成（`hash()`）と検証（`verify()`）の両方を実際に踏む唯一の実機経路が、方式を差し替えた後も end-to-end で成立することを確認する。UI は変わらないので、ここが壊れていれば原因は必ずハッシャー側にある
- **手順:**
  1. シークレットウィンドウで `http://localhost:3000/` を開く（`/login` へ誘導される）
  2. 「アカウント登録」リンクから `/signup` へ移り、「メールアドレス」に `pbkdf2-new@example.com`、「パスワード」に `password123` を入力して「登録する」を押す
  3. 遷移後、ブラウザを再読み込みしてログイン状態が維持されることを確認する
  4. `/settings` を開き「ログアウト」を押す
  5. `/login` で同じ `pbkdf2-new@example.com` / `password123` を入力して「ログイン」を押す
- **期待結果:** 手順2で登録が成功しタイムライン（`/`）へ遷移する。手順3で `/login` へ戻されない。手順5でログインが成功し再びタイムラインへ遷移する
- **確認ポイント:**
  - 送信中にボタンが「登録中…」「ログイン中…」になり、無効化されること（React 19 の `useActionState` 経路。ハッシュ計算が重くなるぶん pending 表示が見える時間は伸びるが、それは正常）
  - `pnpm dev` のターミナルに `SystemError` / `CryptoError` / `DataIntegrityError` が出ていないこと。出ていれば `derive()` に渡す hash 名か `parse()` の分岐が壊れている
  - 手順5でログインできないのに手順2が成功する場合は、**`hash()` が書く識別子と `verify()` が読む識別子が食い違っている**（steps.md ステップ5【案 A】の `ALGORITHM_ID` / `SHIPPED_HASH` の不一致）

### 2. 保存されたハッシュが `pbkdf2-sha512` / `210000` になっている

- **対応する受け入れ基準:** AC-4 / AC-5
- **目的:** 出荷されるハッシュの先頭2フィールド（アルゴリズム識別子・反復回数）と derived の長さが、確定した案どおりの値で**実際に DB に書かれている**ことを確認する。単体テストは `createPbkdf2PasswordHasher()` の出力を見るが、DI 配線（`serverCloudflare.ts`）を通って D1 に届くところまでは実機でしか通らない
- **手順:**
  1. 確認項目1 を実施済みの状態で、次を実行する

     ```bash
     pnpm --filter @repo/web exec wrangler d1 execute tanstack-start-template-d1 --local \
       --command "SELECT email, auth_method, password_hash FROM users WHERE email = 'pbkdf2-new@example.com';"
     ```
  2. 出力の `password_hash` を `$` で4つに分けて読む
  3. 4フィールド目（derived）の base64 をデコードしてバイト長を数える

     ```bash
     printf '%s' '<4フィールド目をそのまま貼る>' | base64 -d | wc -c
     ```
- **期待結果:**

  | | 1フィールド目（識別子） | 2フィールド目（反復回数） |
  |---|---|---|
  | 案 A（確定） | `pbkdf2-sha512` | `210000` |

  3フィールド目（salt）は base64 で24文字（= 16 byte）。4フィールド目（derived）は base64 で44文字、手順3のデコード結果が **32**（AC-5。`DERIVED_BITS = 256` が据え置きであること）
- **確認ポイント:**
  - `auth_method` が `password` であること
  - **識別子と回数のちぐはぐが無いこと** — 識別子が `pbkdf2-sha256` のままだったり、回数が `600000`（不採用の案 B の値）になっていたりしないこと。確定した案 A の行と厳密に一致すること
  - derived が 32 byte でない場合は `DERIVED_BITS` を触っている（スコープ外の変更）

### 3. ダミーハッシュが出荷ハッシャーで読めている（等時間化が無音で死んでいない）

- **対応する受け入れ基準:** AC-8
- **目的:** `loginWithPassword` のダミーハッシュが確定した方式で `PasswordHasher.verify` に読めることを確認する。**`burnVerificationTime` は例外を握り潰す設計**なので、ダミーが取り残されてもログインは成功し続け、UI には何も出ない。唯一の実機の signal は**サーバーログの警告1行**であり、これを見に行くのがこの項目の全部である（R-3 が名指しする「タイミングオラクルが無音で復活する」経路）
- **手順:**
  1. `pnpm dev` のターミナルを表示したままにする（このプロセスを再起動すると警告ラッチがリセットされるので、以降の手順の途中で再起動しない）
  2. シークレットウィンドウの `/login` で、**存在しないメールアドレス** `no-such-user@example.com` / `password123` を入力して「ログイン」を押す
  3. `pnpm dev` のターミナルの出力を確認する
  4. 続けて、確認項目1 で作った `pbkdf2-new@example.com` / **誤ったパスワード** `wrongpassword` でもログインを試し、同じくターミナルを確認する
- **期待結果:** どちらの手順でも画面には同一の資格情報エラーが出る。そして **`pnpm dev` のターミナルに `Login timing equalisation is inactive: the password hasher could not verify the dummy hash` が1度も出ない**
- **確認ポイント:**
  - この警告は `console.warn`（`ConsoleLogger`）で出るので、workerd のログが転送される `pnpm dev` のターミナルに出る。ブラウザの Console ではない
  - **isolate ごとに1回しか出ない**（`dummyHashUnreadableReported` ラッチ）。見逃したと思ったら `pnpm dev` を再起動してから手順2をやり直す
  - 警告が出た場合は `DUMMY_PASSWORD_HASH_ALGORITHM_ID` の取り残しを疑う（ただし型ピンがあるので本来コンパイルが通らないはずで、警告が出たなら型ピンのほうが壊れている）

### 4. 変更前に作成したアカウントで引き続きログインできる

- **対応する受け入れ基準:** AC-7
- **目的:** `verify()` が「現在の設定」ではなく「保存値が宣言した方式とコスト」で導出するという契約が実機で保たれていることを確認する。**開発用ローカル D1 に既に存在する行がこの変更で読めなくなっていないこと**の確認でもある（plan.md「前提」より本番データは存在しないので、守る対象はこのローカル行だけ）
- **手順:**
  1. `pnpm dev` を停止する
  2. 実装ブランチの作業をコミットしたうえで `git checkout main`
  3. `pnpm dev` を起動し、`/signup` で `pbkdf2-legacy@example.com` / `password123` を登録する
  4. 保存された値が変更前の形式（`pbkdf2-sha256$210000$` で始まる）であることを確認する

     ```bash
     pnpm --filter @repo/web exec wrangler d1 execute tanstack-start-template-d1 --local \
       --command "SELECT email, password_hash FROM users WHERE email = 'pbkdf2-legacy@example.com';"
     ```
  5. `pnpm dev` を停止し、`git checkout issue/20/pbkdf2-cost-parameters` して `pnpm dev` を起動し直す
  6. `/login` で `pbkdf2-legacy@example.com` / `password123` を入力して「ログイン」を押す
- **期待結果:** 手順6でログインが成功しタイムラインへ遷移する。`pnpm dev` のターミナルにエラーも警告も出ない
- **確認ポイント:**
  - ローカル D1 は `.wrangler/`（gitignore 済み）にあるので、手順5 のブランチ切り替えで行は消えない。消えていたら `.wrangler/state/v3/d1` を消してしまっている
  - **これが旧形式（`pbkdf2-sha256$`）読み取り枝の唯一の実機確認**であり、`hashFor()` の旧枝が生きていることを意味する（AC-7）
  - 手順6 が失敗する場合は `hashFor()` から `pbkdf2-sha256` 枝を落としていることを疑う
  - **この手順で作る行は #20 以前の形式なので、タイミング等時化に約 97ms の残差を持つ**（異常系1 の「正直な限界」を参照）。本番にこの形式の行は存在しないという前提のもとで受容している残差であり、ローカルの検証用行はその前提の外にある

### 5. 旧形式の低コストフィクスチャを注入した行でログインできる

- **対応する受け入れ基準:** AC-6 / AC-7
- **目的:** 確認項目4 が「本番強度の旧行」を扱うのに対し、こちらは**単体テストが固定しているのと同一のフィクスチャ**（steps.md ステップ3-2 で採取し、ステップ6-9 のリグレッションテストに埋め込んだ `pbkdf2-sha256$1000$…`）が実機の経路でも通ることを確認する。単体テストとアプリケーション経路で同じ値が同じ結果になることの突き合わせ
- **手順:**
  1. 確認項目4 の手順3 で作った `pbkdf2-legacy@example.com` の行（無ければ実装ブランチのまま `/signup` で任意のアドレスを作ってよい）に、採取済みフィクスチャを注入する。**`$` のシェル展開を避けるため `.sql` ファイル経由にする**

     ```sql
     -- apps/web/legacy.sql（確認後に削除する。`.gitignore` の対象外なのでコミットしないこと）
     UPDATE users
     SET password_hash = 'pbkdf2-sha256$1000$<ステップ3-2で採取した salt>$<採取した derived>'
     WHERE email = 'pbkdf2-legacy@example.com';
     ```

     ```bash
     pnpm db:execute:local ./legacy.sql
     ```
  2. `/login` で `pbkdf2-legacy@example.com` と**フィクスチャの平文**（steps.md ステップ3-2 より `password123`）を入力して「ログイン」を押す
  3. 確認後、`apps/web/legacy.sql` を削除する
- **期待結果:** 手順2でログインが成功する。低コスト（1,000回）なので体感は確認項目1 より明確に速い
- **確認ポイント:**
  - `MIN_PBKDF2_ITERATIONS`（1,000）はファクトリ引数の下限であって `parse()` の下限ではない（`parse()` は 1 以上・`MAX` 以下を通す）。したがって 1,000 回の行がログインできるのが正しい挙動で、ここで `DataIntegrityError` になるなら `parse()` に不要な下限チェックを足している
  - フィクスチャの平文が分からなくなった場合はこの項目を実施できない。その場合は確認項目4 で代替し、その旨を完了報告に書く

### 6. 旧形式の行はログイン成功後も書き換わらない

- **対応する受け入れ基準:** スコープ確認（plan.md「含まれないもの」— #18 rehash-on-login は本 Issue の対象外）
- **目的:** 本 Issue が**ハッシュ移行を一切発生させない**という前提で閉じられることを実機で確認する。ログイン時に黙って新形式へ書き換える実装が混入していないこと
- **手順:**
  1. 確認項目4（または5）でログインに成功した直後に、同じ行を読み直す

     ```bash
     pnpm --filter @repo/web exec wrangler d1 execute tanstack-start-template-d1 --local \
       --command "SELECT email, password_hash FROM users WHERE email = 'pbkdf2-legacy@example.com';"
     ```
- **期待結果:** `password_hash` がログイン前とバイト単位で同一で、依然として `pbkdf2-sha256$` で始まる
- **確認ポイント:** ここが `pbkdf2-sha512$` に変わっていたら rehash-on-login が実装されている。本 Issue のスコープ外なので、混入していれば削るか #18 として切り出す

### 7. ログインの体感速度が実用の範囲に収まっている

- **対応する受け入れ基準:** steps.md ステップ2「観測項目（判定には使わない）」
- **目的:** 1反復あたりのコストが上がった（SHA-256 → SHA-512）結果として、ログイン・登録が**利用者から見て破綻していない**ことを確認する。判定ゲートの入力ではなく、確定した案 A が実用に耐えるかの観測
- **手順:**
  1. DevTools の Network タブを開き、フィルタを `_serverFn` にする
  2. `/login` で確認項目1 のアカウントに正しいパスワードでログインし、ログイン送信の POST（`/_serverFn/...`）の Time を控える
  3. 同じ手順を3回繰り返し、中央値を取る
  4. `/signup` での登録についても同様に1回計測する
- **期待結果:** ログイン送信の POST が体感で待たされる感じにならず、pending 表示（「ログイン中…」）が数秒間残るようなことがない。`SHA-512 @ 210k` の1導出はローカル workerd（Apple Silicon）の先行実測で中央値 45〜47ms、CI（x86_64）で中央値 **127.2ms** なので、**サーバー関数の往復が数百 ms のオーダーに収まっていれば正常**
- **確認ポイント:**
  - **これは絶対値の合否判定ではない。** steps.md ステップ2 は「中央値が 100ms を超えても案の選択は変えない」と決めており、実際 CI の `t_A` は 127.2ms でこれを超えたが**案は変えていない**（`.thread/1/adr.md` の実測節に観測項目として記録済み）。重さそのものが問題なら別 Issue に切り出す。ここで見るのは「桁が変わっていないか」だけ
  - ローカル workerd には本番の CPU 予算（Free 10ms / Paid 既定 30 秒）が効いていない。**ローカルで速いことは本番の CPU 予算内に収まる証明にはならない**（本番デプロイが未実施なので、この点は実機で確認できない。ADR-003 の実測節に数値を残すところまでが本 Issue の範囲）
  - 桁違いに遅い（1秒級）場合は、`derive()` に渡す hash 名が固定されずに毎回 SHA-512 の巨大な反復を回している、あるいは反復回数を取り違えている可能性がある。確認項目2 で保存値を読み直す

---

## エッジケース・異常系

### 1. ログイン失敗の表示が失敗理由によらず同一である

- **目的:** 方式を差し替えても、`loginWithPassword` が「誤ったパスワード」と「存在しないメールアドレス」を同一の `INVALID_CREDENTIALS` に潰す挙動が壊れていないことを確認する
- **手順:**
  1. `/login` で `pbkdf2-new@example.com` / `wrongpassword` を送信し、表示された文言と表示位置を控える
  2. `/login` で `no-such-user@example.com` / `password123` を送信し、文言と表示位置を比較する
  3. `/login` で `pbkdf2-new@example.com` / `password123` を送信する
- **期待結果:** 手順1・2 でまったく同じ文言（「メールアドレスまたはパスワードが正しくありません」相当）が同じ位置に出る。手順3 ではログインできる。英語の生の例外文言・スタックトレース・500 画面は出ない
- **正直な限界（重要）:** **応答時間の差はこの手順では検証できない。しかも #20 以降、「差は体感で区別できない」という言い方はもう正しくない。** 内訳は行の形式で分かれる。
  - **手順1・2 の比較（新形式 `pbkdf2-sha512$210000$` の行への誤パスワード vs 未登録アドレス）** — どちらもダミーと同じ `SHA-512 @ 210,000` を1回導出するので、残差は等時間化の設計どおりほぼゼロ。ここは変更前と同じ
  - **旧形式 `pbkdf2-sha256$210000$` の行への誤パスワード vs 未登録アドレス** — **約 97ms の残差がある**（CI x86_64 実測で `SHA-256 @ 210k = 30.2ms` / `SHA-512 @ 210k = 127.2ms`。`.thread/1/adr.md`「実測結果（#20 / 2026-08-07）」節）。**97ms は原理的には計測の届く粒度であり、「ノイズに埋もれるから安全」とは書けない。** それでも受容している根拠は残差の小ささではなく、**本番に `pbkdf2-sha256$` の行が1行も存在しないという前提**（plan.md「前提」/ `.thread/20/adr.md` ADR-002「前提確認の記録」）である。確認項目4・5 で作るローカルの旧形式行はこの前提の外にあるので、そこで残差が出ても不具合ではない
  - **どちらにせよ、この手順で残差を測ることはできない。** `pnpm dev` の HMR・ネットワーク・ブラウザ描画のノイズは1回の観測では同等以上に大きく、DevTools の Time を数回並べた程度では有意差の有無を判定できない。**「測って差が無かった」ではなく「この手順では測れない」が正しい結論**である
  - **タイミングオラクルそのものの検証は自動テスト（`identity.integration.test.ts` の「ダミーハッシュを本番ハッシャーが読めること」）と確認項目3 の警告ログに委ねる。** ここで確認するのは表示の同一性だけである

### 2. 未知のアルゴリズム識別子を持つ行は資格情報エラーに潰れない

- **目的:** `parse()` が「読めない識別子」を `SystemError(DataIntegrityError)` に落とす契約（R-9 / AC-6）が、アプリケーション経路を通ったときに何として現れるかを実機で見る。`verify()` の throw は `burnVerificationTime` の外なので握り潰されない
- **手順:**
  1. 次の SQL を `apps/web/broken.sql` に書いて実行する（識別子は `hashFor()` が知らないもの＝ `argon2id` を使う。案 A では `pbkdf2-sha512` も `pbkdf2-sha256` も**読める**ので、どちらもこの確認には使えない）

     ```sql
     UPDATE users
     SET password_hash = 'argon2id$1000$c2FsdA==$aGFzaA=='
     WHERE email = 'pbkdf2-new@example.com';
     ```

     ```bash
     pnpm db:execute:local ./broken.sql
     ```
  2. `/login` で `pbkdf2-new@example.com` / `password123` を送信する
  3. `pnpm dev` のターミナルを確認する
  4. 確認後、確認項目1 の手順で作り直すか、`apps/web/broken.sql` を書き換えて元の値へ戻す。`apps/web/broken.sql` は削除する
- **期待結果:** ログインは成功しない。サーバーログに `DataIntegrityError` 相当（`Stored password hash is not in a recognised encoding`）が出て、**資格情報エラーに黙って潰れない**。画面にはハッシュの値そのものや内部のスタックトレースが表示されない
- **確認ポイント:** ここで「メールアドレスまたはパスワードが正しくありません」に潰れる実装になっていたら、`parse()` の失敗を握り潰す catch がどこかに増えている（CLAUDE.md「Input validation」の第2境界とエラー契約の違反）

### 3. パスワード長の境界（128文字）でも登録・ログインできる

- **目的:** 1反復あたりのブロック長が変わったので（SHA-512 のブロックは 128 byte で SHA-256 の倍）、長い入力に対する `importKey` / `deriveBits` が壊れていないことを確認する
- **手順:**
  1. `/signup` で `pbkdf2-long@example.com` と `a` を128個並べたパスワードを入力して「登録する」を押す
  2. `/settings` からログアウトし、`/login` で同じ資格情報を入力してログインする
  3. 保存値を読み、確認項目2 と同じ識別子・反復回数・derived 長になっていることを確認する
- **期待結果:** 手順1で登録成功、手順2でログイン成功。手順3の保存値は確認項目2 の表と同一の識別子・反復回数で、derived は 32 byte
- **確認ポイント:** 128文字は既存のドメイン上限そのものなので、129文字ならパスワード欄直下にエラーが出るのが正（この境界挙動は本 Issue で変えていない）

---

## 既存機能への影響確認

- **セッション Cookie（`webcrypto/hmacSessionCodec`）** — 本 Issue では触らないので挙動は変わらないのが正。確認項目1 のログイン後にリロード・別タブで `http://localhost:3000/settings` を開き、ログイン状態が維持されることを確認する。ここが壊れていたら `adapters/webcrypto/` の別ファイルに手が入っている。
- **`/settings` の表示** — ログイン状態で `/settings` を開き、「メールアドレス」が登録したアドレス、「認証方式」が「メールアドレスとパスワード」であることを確認する。あわせて **パスワードハッシュが画面にも HTML ソース（DevTools の Elements）にも現れないこと**を確認する（保存形式が変わっても露出経路が増えていないこと）。
- **登録時の outbox / relay** — アカウント登録は outbox 行を書く。ローカル dev では relay Worker が起動していないため Service Binding の kick が失敗しうるが、**失敗はログに出して握り潰す設計**なので UI 上のエラーにならなければ正常。本 Issue は outbox に一切触らないので、ここに新しいエラーが出たら別原因。
- **登録・ログインの pending / エラー表示（`useActionState`）** — ハッシュ計算が重くなるぶん pending 表示が見える時間は伸びる。**連打しても二重登録・二重ログインにならないこと**を確認する（送信中のボタン無効化）。重くなったことでこの防御が初めて露見する形の不具合が出ていないかを見る。
- **`pnpm db:migrate` の冪等性** — もう一度実行し、「no migrations to apply」で正常終了することを確認する（本 Issue はスキーマに触らないので、新しいマイグレーションが生成されていないこと自体の確認にもなる）。
- **本番 CPU 予算に対する影響は実機で確認できない** — 初回本番デプロイが未実施（plan.md「前提」）で、`pnpm start` / `pnpm preview` も起動しない（#40）ため、Cloudflare の CPU 予算（Free 10ms / Paid 既定 30 秒）に対する余裕はローカルでは測れない。CI（`ubuntu-latest` / x86_64）実測を ADR-003 の実測節に残すところまでが本 Issue の範囲であり、確認項目7 はその代替にはならない。
