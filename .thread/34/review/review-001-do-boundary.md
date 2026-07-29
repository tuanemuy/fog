# レビュー: DO 境界・ルーティング設計（PR #43 / Issue #34）

**対象:** `.thread/34/design.md`（1,059行）
**観点:** DO のデータ境界とルーティングの技術的妥当性（Issue 対応項目3、AC-4 / 11 / 12 / 13 / 15 / 22 / 23）
**日付:** 2026-07-29

---

## DO 境界・ルーティング

### Blockers

- **[B-001]** `design.md` に NUL バイトが2個埋め込まれており、`grep` がこのファイルを「マッチ無し」として扱う
  - 場所: `.thread/34/design.md:352`（`provider + "<NUL>" + subject`）、`.thread/34/design.md:448`（同）
  - 理由: SSO canonical の区切り文字として、`\0` というエスケープ表記ではなく**生の NUL バイト**が本文に書かれている。結果としてこのファイルはテキストファイルでなくなっている（`file .thread/34/design.md` → `data`）。実害は文字化けではなく**検証と引き継ぎの破壊**である。

    ```
    $ grep -c "Identity Directory" .thread/34/design.md   # 出力なし、exit 1
    $ grep -ac "Identity Directory" .thread/34/design.md   # 7
    ```

    `grep` は「Binary file matches」すら出さず、**無言で0件を返す**。これが直撃するもの:
    - `plan.md` の実装ステップ10 が AC-5 の検証として置いている機械走査（「今後検討」「TBD」が結論位置に無いこと）は、**何も無いから通る**のであって、内容が正しいから通るのではない。AC-5 の機械検証は現状 vacuous である
    - `.adr/` 3件・`.thread/34/adr.md` には NUL が無いので（実測 0 バイト）、design.md だけがこの状態にある
    - #35 / #37 の担当者は本書を grep して改訂対象・引き継ぎ表を引く前提になっている（第11.1節・第11.2節）が、素の `grep` では引けない
    - `git diff` はたまたま生き残る（NUL が先頭 8000 バイトより後ろにあるため git が binary 判定しない）が、これは偶然であって保証ではない
  - 提案: 2箇所の生 NUL を、区切りの意図が読めるリテラル表記に置き換える。本文の散文が既に「区切りに NUL を使う」と書いているので、コード表記側を `provider + "\0" + subject`（バックスラッシュ + `0` の2文字）に直せば意味は変わらない。修正後 `grep -c NUL .thread/34/design.md` と `tr -dc '\000' < .thread/34/design.md | wc -c` の両方で確認すること。あわせて、NUL を含むファイルを生成しない旨を `.thread/34/` の作法として plan 側にも残すとよい。

- **[B-002]** signup の `operationId`（＝候補 `userId`）が再送時にどこから来るのかが未定義で、「外部入力が locator の材料にならない」という中核の構造的保証が signup 経路について成立していない
  - 場所: `.thread/34/design.md:500`（第6.3節 phase 0）、`:531`（第6.5節）、`:362`（第5.2.2節 (a)(ii)）、`:434`（第5.5節 1〜2）
  - 理由: 第6.3節 phase 0 は「`IdGenerator` が operation ID を採番し、**その値をそのまま候補 `userId`** として使う。**再送では同じ値を保持する**」、第6.5節も「request Worker が採番し、再送中は同じ値を保持する」と書く。しかし request Worker はステートレスであり、**リクエストを跨いで値を「保持」する手段を持たない**。したがって読み方は2つに割れる。

    1. **クライアントが `operationId` を運ぶ**（隠しフィールド / `Idempotency-Key` ヘッダ等）。この場合、**外部入力がそのまま `idFromName()` の引数になる**。第5.2.2節 (a)(ii) の「`userId` は署名済みセッション（または signup 時に request Worker が採番した operation ID）に由来し、外部入力から来ることが構造的にありえない」も、第5.5節 1 の「ここに `userId` を渡せるのは `sessionCodec.verify` / トークン検証の戻り値、または signup で `IdGenerator` が採番した値のいずれかに限られる」も、**この読み方では偽になる**。攻撃者は既存ユーザーの `userId` を `operationId` として送り、他人の User Data DO に到達できる。第6.3節 phase 1 のガードは「同じ `operationId` で違う digest なら `ConflictError`」だけで、**既に `account` が active な DO への signup phase 1 書き込みを拒む条件が書かれていない**
    2. **リクエスト跨ぎの「再送」は存在せず**、落ちた saga は第6.4節の Alarm 再開だけで前進する（＝ブラウザからの再 POST は新しい `operationId` = 新しい `userId` になり、前の DO は TTL 掃除される）。この読み方なら第5.5節の保証は成立する

    設計は 2 のつもりに見える（第7.4節の `resume-signup` ジョブ、第6.4節の「前進」規則）が、**そう書いていない**。曖昧さが着地するのが認証境界そのものなので、#37 が 1 で実装すればテナント越境になる。
  - 提案: 第6.3節 phase 0 と第6.5節を断定形に直す。具体的には (i) 「`operationId` はサーバー側でのみ採番し、**クライアントから受け取らない**」を明記する、(ii) 「リクエスト跨ぎの再開は Alarm による saga 再開のみで、クライアントの再 POST は新しい `operationId` を採番する」を明記する、(iii) 併せて phase 1 に「対象 DO に既に `account` 行が存在する場合は signup を拒否する」ガードを足し、万一 locator 導出を誤っても既存アカウントに書き込まないようにする。第5.5節 4 の「誤った DO には誤ったユーザーのデータしか無い」は**読み取りには効くが書き込みには効かない**ので、書き込み側のガードは別途要る。

- **[B-003]** 未認証の signup が、Directory 側の重複チェックより**先に** User Data DO を作る順序になっており、未認証入力による無制限な DO 生成が塞がれていない
  - 場所: `.thread/34/design.md:498-505`（第6.3節 saga の phase 順）、`:459-472`（第6.2節の判断軸 (iv)）、`:129`（第3.1節 2）
  - 理由: 第6.2節は「(iv) 未認証経路からの DO 生成」を独立した判断軸として立て、Directory の分割方式を (c) 案（credential 1件 = DO 1個）ごと棄却する根拠にまでしている（「任意の未認証文字列が新しい DO 名を引く」「総当たりが毎回コールドな DO インスタンス化を誘発する」「それ自体が資源枯渇の攻撃面になる」）。**同じ軸を User Data DO に当てていない。**

    第6.3節の phase 順は 1 = User Data DO に `operations` 行を書く → 2 = Directory 予約、である。つまり**メールが既に登録済みかどうかを判定する前に、新しい User Data DO が1個作られて storage に書き込みが発生する**。未認証の POST を N 回投げれば User Data DO が N 個生成される。第6.4節の TTL 掃除が消すのは `operations` **行**であって、生成された DO オブジェクトそのものではない（`hasStoredData` は残りうるし、PITR の durable log も30日残る。第2.1節 #20）。DO は1個あたり独立した SQLite DB であり、Directory の bucket 案で「資源枯渇の攻撃面」と判定した対象より重い。

    しかもこの phase 順は第3.1節 2 で **Account Home を採らない根拠の一部として意図的に選ばれている**（「User Data に operation 記録 → Directory 予約 → …」）。意図的な選択なのに、その代償が第6.2節の軸で評価されていない。
  - 提案: 次のいずれかを結論として書く。(i) **phase 1 と phase 2 を入れ替える** — `operationId` / 候補 `userId` は request Worker が採番したうえで、まず Directory bucket に予約を取り、勝ったときにだけ User Data DO を初期化する。saga のコーディネーター状態は予約行が持てるので、跨ぐ DO 数も補償の相手も増えない。(ii) 現順序を維持するなら、「未認証 signup による User Data DO 生成をどう bound するか」（transport 境界のレート制限 / 未検証メールでの DO 生成を許容するコストの見積り）を第6.2節の (iv) と同じ粒度で書く。どちらでもよいが、**評価せずに済ませない**。Issue が「未認証経路から DO を生成できる穴が無いか」を明示的に問うている箇所である。

- **[B-004]** 第6.6節・第6.7節が「fail closed で拒否する」根拠に置いている login 時の「到達性検査」が、第5.3節の login 手順に存在しない
  - 場所: `.thread/34/design.md:555`（第6.6節）、`:399-406`（第5.3節 login 手順1〜6）、`:568`（第6.7節）、`:920-922`（第10.1節）
  - 理由: 第6.6節は unlink の順序（User Data DO を先、Directory を後）を正当化するにあたり、2と3の間で落ちて Directory に mapping が残った場合について「残った mapping で login すると `userId` は引けるが、User Data DO 側に reverse locator が無いので **epoch ガードと到達性検査が fail closed で拒否する**（第5.1節）。つまり『解除したのにログインできてしまう』は起きない」と結論している。

    ところが第5.1節にも第5.3節にも、**その「到達性検査」は定義されていない**。第5.3節の login は 1 canonical 化 → 2 bucket 引き → 3 `{ userId, passwordVerifier, status }` 取得 → 4 request Worker で verify → 5 `idFromName(userId)` で **`account.status` が active であることと `sessionEpoch` の現在値を得る** → 6 トークン発行、の6手順で、`credential_locators` と突き合わせる手順が無い。epoch ガードも効かない — epoch ガードは「トークンが持つ epoch と現在値の照合」（第5.1節）であり、**login は新規にトークンを発行する側なので照合対象が存在しない**。

    しかも第6.1節 (d) により、パスワードの検証材料は **その残存 mapping 行そのものに載っている**（`credential_mappings` の `kind: 'email'` 行）。よって手順1〜6 は全部通り、**解除済みクレデンシャルで新しいセッションが発行される**。窓は「Alarm が孤児 mapping を検出して削除するまで」（第6.6節末尾）で、Alarm が失敗し続ければ無期限に開く。

    同じ構造は第6.7節（退会）にもある。退会は phase 1 で `status = 'deleting'` を先に書くので `account.status` の照合で止まるが、それは**別のガード**であって「到達性検査」ではない。第10.1節 (PITR) の「どちらか一方の restore だけでアカウントが復活することは無い」も同じ `account.status` 側のガードに依存しており、そちらは成立している。破れているのは unlink のケースだけである。
  - 提案: 第5.3節 login の手順5に、**`credential_locators` の照合を明示的に足す** — 「bucket から得た locator（世代 + bucket index + 全長 HMAC）が User Data DO の `credential_locators` に active な行として存在することを確認し、無ければ拒否する」。第6.3節 phase 5 で reverse locator を記録済みなので照合材料は揃っており、追加の往復も発生しない（既に叩いている DO の中の1行を読むだけ）。そのうえで第6.6節の「到達性検査」がこの手順を指していることを相互参照する。**この検査は Account Home を採らない設計の要**でもある — 「権威はすべて `userId` で引ける」（第3.1節）が成立するのは、この照合を login に組み込んだときだけである。

---

### Warnings

- **[W-001]** `Email.create` の現行実装の記述が不正確で、そのまま「置き換える」と入力長制限と構造チェックが落ちる
  - 場所: `.thread/34/design.md:351`（第5.2.1節 (b)）
  - 理由: 「現行の `Email.create` は `trim().toLowerCase()` **だけ**で、NFKC も IDN 正規化もしない。ここを (a) に置き換える」とあるが、実物（`packages/core/src/domain/identity/valueObject.ts:45-62`）は正規化に加えて **`EMAIL_MAX_LENGTH = 320` の長さ制限**と **`EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/` の構造チェック**を持ち、いずれも違反時に `BusinessRuleError(InvalidEmail)` を投げる。「だけ」は誤り。

    影響は文言の問題に留まらない。(a) の手順は「最後の `@` で分割」を前提にしているが、`@` を含まない入力に対する挙動は (a) に書かれていない。現行の regex はまさにそれを弾いている。`CLAUDE.md` の「値オブジェクト構築が2つの検証点のうち1つ」という原則からも、長さ上限は DoS 面で落としてはいけない。
  - 提案: 第5.2.1節 (b) を「置き換える」ではなく「**正規化部分を (a) に差し替え、長さ上限 320 と構造チェックは維持する**」に直す。あわせて (a) の手順に「`@` を含まない / local か domain が空になる入力は `BusinessRuleError` にする」を足し、正規化と検証の順序（検証 → 正規化 か 正規化 → 検証 か）を断定する。punycode 変換後に 320 を超えうる点も明示しておくと #37 が迷わない。

- **[W-002]** 短語フォールバックの結論（LIKE / GLOB）が、根拠として挙げている実測（`instr()`）と一致していない。導出した 50 バイト制約も当該実装には効かない
  - 場所: `.thread/34/design.md:629`（第7.2節 短語フォールバック）、`:626`（同 トークナイザ）、`:82`（第2.1節 #16）
  - 理由: 第7.2節は「1〜2文字のクエリは FTS ではなく `LIKE` / `GLOB` へフォールバックする。**制約は LIKE / GLOB パターンの 50 バイト上限**（第2.1節 #16）で、UTF-8 の日本語は1文字3バイトなので実質16文字程度が上限になる」と結論している。しかし裏付けとされている先行実装（`origin/issue/19/cloudflare-do-fts` の `packages/core/src/adapters/cloudflare/user-data/searchIndex.ts:376-382`）は

    ```ts
    const longQuery = [...keyword].length >= 3;
    const predicate = longQuery
      ? "search_fts MATCH ?"
      : "(instr(e.title, ?) > 0 OR instr(e.body, ?) > 0)";
    ```

    と `instr()` を使っており、**LIKE も GLOB も使っていない**。`instr()` に 50 バイトのパターン上限は無い（#16 は LIKE / GLOB のパターン限定の制約）。つまり第7.2節は、実測されていない機構（LIKE / GLOB）を結論として採り、その機構にしか効かない制約から「実質16文字」という数字を導いている。`.adr/003-sqlite-fts5-only-search.md` を支える根拠の一部がここに載っているので、放置すると ADR の足元が実測と食い違う。

    同じ節の小さな誤配置: 「**3文字未満に切り詰めた `東京` でも2件がヒット**」を **trigram の実測**として挙げているが、上のコードのとおり2文字クエリは trigram ではなく短語フォールバック側を通る。実測ファイル（`.thread/19/spike/fts5.integration.test.ts`）の内容自体は design.md の要約どおりで正確だが、証拠が別の主張に貼られている。
  - 提案: 結論を実測に合わせて `instr()` へ寄せるか、LIKE / GLOB を採るなら「これは未実測であり #37 が spike で確認する」を明記して第11.4節の未決事項に足すか、どちらかに倒す。前者なら 50 バイト上限の段落は不要になり、代わりに「全走査になるので対象列とページサイズを制限する」だけが残る（この部分は機構に依らず正しい）。あわせて `東京` の2件ヒットを短語フォールバックの実測として付け替える。

- **[W-003]** `ADP-identity-014`（`PasswordResetTokenPort.issue`）が第4.3節の「全数」表に無い
  - 場所: `.thread/34/design.md:216-258`（第4.3節）、`spec/inventory/adapter.md`（identity ポート 016件）
  - 理由: 台帳85件を全走査して突き合わせた結果、述語 (a)(b) に照らして表から漏れているのは実質1件で、それが `ADP-identity-014` である。`issue(userId: UserId, now: Date)`（`spec/domains/identity.md:447`）は `userId` を第一引数に取るので述語 (a) は文字どおりには発火しない。しかし
    - 表の行3 と行19 は `password_reset_tokens` そのものと期限切れ掃除を **Directory の関心事**へ送っている
    - 消費側の `verifyAndConsume`（`ADP-identity-015`）は行7 で Directory へ送られている
    - 発行側だけが表に無いため、述語どおりに `userId` 第一引数で読むと **User Data DO へ行き先が割り当てられ、テーブルの置き場所と矛盾する**

    第6.1節 (d) はトークンを bucket 内に持つと決めているので設計の意図は明らかだが、AC-22 が求めているのは「該当する全件が表に行として存在し、各行に行き先が入っている」ことである。なお `ADP-identity-003`（`UserRepository.findById`）も、行11 で `insert` / `save` を「**分裂する**」と判定した以上、同じ集約を再水和する読み側だけ表に無いのは対称性を欠く（こちらは軽微）。
  - 提案: 第4.3節のカテゴリ C（または G）に `ADP-identity-014` を1行足し、行き先を「**Directory の関心事**（第6.1節 (d)。`userId` から `credential_locators` 経由で bucket を引いて発行する）」とする。`ADP-identity-003` も1行足して「分裂する（行11 と対）」にしておくと、#35 が `spec/inventory/adapter.md` を直すときに漏れない。

- **[W-004]** パスワードリセットトークンが世代を持たず、鍵ローテーションで到達不能になる
  - 場所: `.thread/34/design.md:452`（第6.1節 (d)）、`:577`（第6.8節 手順2）
  - 理由: トークンは `{bucketIndex}.{random}` 形式で **bucket index だけ**を埋め込む。一方 bucket の DO 名は `dir:g{generation}:b{index}`（第6.2節）で、世代が要る。第6.8節のローテーションは「previous 世代の **mapping 行**を読み…新しい世代の bucket へ移す」としか書いておらず、`password_reset_tokens` 相当の行は移送対象に入っていない。結果、ローテーション中に発行済みのトークンは (i) どの世代の bucket を引けばよいか決められず、(ii) 引けたとしても行が旧 bucket に取り残される。
  - 提案: トークン形式を `{generation}.{bucketIndex}.{random}` にして世代を埋め込むか、第6.8節 手順2 の移送対象に `password_reset_tokens` を明記するか、あるいは「ローテーション中は発行済みリセットトークンを無効化してよい（TTL が短いため）」を断定として書く。3つ目が最も安く、その場合は #38 の運用手順に「ローテーション開始前に既存リセットトークンの TTL 経過を待つ」を送る。

- **[W-005]** User Data DO の PITR が `sessionEpoch` を巻き戻し、失効済みセッションを再有効化する経路が第10.1節で扱われていない
  - 場所: `.thread/34/design.md:914-924`（第10.1節）、`:332`（第5.1節 epoch ガード）、`:426`（第5.4.1節 (c)）
  - 理由: 第10.1節は PITR の帰結として「Directory mapping が到達性のゲート」「`account.status` と `sessionEpoch` が状態の権威」「どちらか一方の restore だけでアカウントが復活することは無い」「saga の中間状態は TTL 掃除と digest 照合が回収する」の4点を挙げるが、**epoch そのものが巻き戻る**ケースが無い。

    セッションはステートレス HMAC + TTL 7日（第3.1節・第5.4.1節 (c)）で、失効の唯一の手段が epoch 照合である。User Data DO を N 日前（N ≤ 7）へ restore すると `account.sessionEpoch` も N 日前の値に戻り、その間にパスワード変更・リセット・SSO 解除で失効させたセッショントークンが**再び有効になる**。アカウント侵害後のパスワードリセット → その後の障害で PITR、という順序で現実に起こりうる。
  - 提案: 第10.1節に1項足す。最小の対処は「**PITR で User Data DO を戻した直後に `sessionEpoch` を restore 前の最大値より大きい値へ強制的に進める**」を復旧手順の必須ステップにすること（結論は本節、手順の実体は #38）。`sessionEpoch` を単調増加させる別の永続場所（例: Directory 側 mapping 行に最終既知 epoch を持つ）を置く案もあるが、第3.1節の「権威は `userId` で引ける」を崩すので、運用手順側で閉じるほうが設計に整合する。

- **[W-006]** AI クライアントトークンは epoch を持たないのに、第6.7節が「`sessionEpoch` を進める ⇒ AI トークンも全部無効」と書いている
  - 場所: `.thread/34/design.md:563`（第6.7節 手順1）、`:414`（第5.4節）、`:425`（第5.4.1節 (b)）
  - 理由: 第5.4節が定めるトークンの中身は `{ userId, connectionId, scope, exp }` で **epoch を含まない**。したがって `sessionEpoch` を進めても AI トークンには何の効果も無い。第6.7節の退会は結果として止まる（`account.status = 'deleting'` を DO 側ガードが読むため）が、**述べている機構が違う**。

    より実質的な問題は、この不整合が退会以外の場面を素通りさせることである。パスワード変更・リセット・SSO 解除は第6.5節・第6.6節で epoch を進めるが、**AI クライアントトークンは無効化されない**。第5.4.1節 (b) が「失効の権威は `ai_client_connections.status`」と決めているので、AI トークンを失効させるには接続を個別に revoke するしかない。「パスワードを変えても AI クライアントは繋がったまま」が意図した挙動なのかどうかが本書から読み取れない。
  - 提案: 第6.7節 手順1 の記述を「`account.status = 'deleting'` により、既存セッション（epoch 照合）と AI トークン（アカウント状態ガード）の**両方**が次のリクエストで拒否される」に直す。そのうえで第5.4節に1文足し、「credential 変更時に AI クライアント接続を一括失効させるか否か」を断定する（させないなら、その理由 — AI 接続は独立した認可であり利用者が個別に管理する — を書く）。

- **[W-007]** bucket 数が locator 名にも keyring にも載っておらず、「bucket 数の変更を世代の変更として表現する」が解決できない
  - 場所: `.thread/34/design.md:472`（第6.2節 bucket 数と (ii) の扱い）、`:371`（第5.2.3節 keyring）、`:385`（第5.2.5節 (a)）
  - 理由: 第6.2節は「bucket 数は locator 名に世代とともに埋め込む — 名前は `dir:g{generation}:b{index}` の形にする。bucket 数の変更は世代の変更として表現し…」と書くが、実際に名前へ入っているのは **index であって bucket 数 N ではない**。一方 lookup 側は「active → previous の順に引く」（第5.2.3節）ので、previous 世代を引くには **その世代の N** が必要になる（第5.2.5節 (a) の剰余計算に N が要る）。keyring は `{ generation, key }` の配列としか書かれていないので、N の取得元が無い。
  - 提案: keyring のエントリを `{ generation, key, bucketCount }` にする、と第5.2.3節で断定する。第6.2節の「名前に埋め込む」という文も「世代を名前に埋め、bucket 数は世代のメタデータとして keyring に持つ」に直す。第6.8節の「全 bucket を `0..N-1` の順に走査する」も、走査対象が previous 世代の N であることを明示する。

- **[W-008]** 第3.2節の秘密配布表が「非重複」を売りにしているのに、AI クライアントトークンの署名鍵が載っていない
  - 場所: `.thread/34/design.md:142-145`（第3.2節）、`:414`（第5.4節）
  - 理由: 第3.2節は Worker 分割の理由を「**秘密の配布境界を非重複にできる**ことに尽きる」とし、request Worker = `SESSION_SECRET` + `DIRECTORY_ROUTING_SECRET`、state Worker = `IDENTITY_MAIL_ENCRYPTION_KEY` + メール送信バインディング、と網羅的な表の体裁で書いている。一方、第5.4節は AI クライアントトークンを「HMAC 署名したもので、検証は request Worker が DB を触らずに行う（セッショントークンと同じ方式）」と定めており、**その署名鍵が表に無い**。`SESSION_SECRET` を流用するのか別鍵（例: `AI_TOKEN_SECRET`）を立てるのかで、鍵ローテーション時の影響範囲が変わる。
  - 提案: 第3.2節の表に1行足し、`SESSION_SECRET` と共用にするか別鍵にするかを断定する。用途分離の原則からは別鍵（TTL も失効機構も違う）が素直で、その場合は第8.3節 (b) の request 側 DI 一覧にも対応する codec を足す。

- **[W-009]** 第2.3節「現行実装の到達点」に、実装済みでないものが実装済みとして書かれている
  - 場所: `.thread/34/design.md:108`（SSO）、`:110`（`AiClientConnection`）
  - 理由: 実ファイルと突き合わせた結果、次が事実と違う。
    - 「（SSO は）値オブジェクト…エンティティ…スキーマ…**リポジトリ**、`packages/core/src/application/identity/` … まで実装済み」→ `packages/core/src/domain/identity/ports/userRepository.ts:38-43` が持つのは `insert` / `save` / `findById` / `findByEmail` の4本だけで、**`findBySsoIdentity` は `packages/core/` にも `apps/web/` にも1件も存在しない**。第4.3節の行6 と第6.1節 (b) は `findBySsoIdentity`（`ADP-identity-005`）を「現行実装を移す」と書いているが、移す実装が無い（spec 上の定義はある）
    - 「**`AiClientConnection`** — 値オブジェクトだけが実装済み」→ そういう名前の型は存在しない。あるのは `AiClientConnectionId`（`valueObject.ts:125`）と `ClientName`（同 `:142`）
  - 理由（なぜ重要か）: 第2.3節は「第6.1節・第6.6節は『これから設計する』ではなく『既存実装をどう移すか』として書いてある」という本書の読み方そのものを規定している節である。#37 が「あるはずのものが無い」で躓く。
  - 提案: 第2.3節の SSO の箇条書きから「リポジトリ」を外し、「読み解決（`findBySsoIdentity`）は spec 定義のみで未実装。Directory 側で新規に書く」を明記する。`AiClientConnection` は `AiClientConnectionId` / `ClientName` に直す。第6.1節 (b) の「現行の `findBySsoIdentity` … を移す」も「`users_sso_identity_uq` は移し、`findBySsoIdentity` は新規実装」に分ける。

- **[W-010]** 実装引用の細かい取り違えが5件
  - 場所: `.thread/34/design.md:736`（第8.1節）、`:738`（同）、`:816`（第8.3節 (c)）、`:19`（第1.1節）、`:255`（第4.3節 行28）
  - 理由: いずれも結論を変えないが、#37 が原典に当たったときに空振りする。
    | 記述 | 実際 |
    |---|---|
    | `adapters/d1/pendingBatch.ts` の JSDoc が「Read-your-write within the same UoW is unsupported by design」と明記 | その文は `packages/core/src/adapters/d1/unitOfWork.ts:39`。`pendingBatch.ts`（98行）には無い。第11.2節の新旧対比表の「JSDoc に unsupported by design」も同じ |
    | `repositories/helpers.ts` が `CHECK constraint failed: occ_guard_positive` の部分一致で判定 | `helpers.ts:62` が照合するのは `OCC_GUARD_CHECK_NAME`（= `"occ_guard_positive"`、`schema.ts:118`）のみ。前置きの `CHECK constraint failed: ` は含まない |
    | `containerStore.ts` の実装は `globalThis` の `Symbol.for` スロットと `AsyncLocalStorage` の二段構え | `containerStore.ts` は `globalThis` の Symbol スロットのみ。`AsyncLocalStorage` は import すらしておらず（エラーメッセージ中に語が出るだけ）、ALS の実体は `apps/web/app/server.cloudflare.ts:4,33,44`。**結論（DO 内では必ず throw する）は成立する** |
    | `.thread/1/adr.md`（1662行の作業ログ） | 1664行（`plan.md:41,72,1136` も同じ数字） |
    | `PasswordHasher` … `verify(hash, plain)` | `spec/domains/identity.md:432` は `verify(plain: PlainPassword, hash: PasswordHash)`。引数順が逆 |
  - 提案: 5箇所を実物に合わせる。とくに1件目は第8.1節の表の「廃止できる理由」の根拠として引かれているので、参照先を `adapters/d1/unitOfWork.ts:39` に直す。

---

### Notes

- **[N-001]** **第2.1節のプラットフォーム制約26件を Cloudflare 公式ドキュメントで全件裏取りした結果、公式記載としているものはすべて正しい。** 検証したページと確認事項:
  - `/durable-objects/platform/limits/` — 10 GB / account 5 GB(Free)・Unlimited(Paid)、`SQLITE_FULL` で書きだけ失敗し読みと `DELETE` は成功、Alarm handler の wall time 15分（表 "Wall time limits by invocation type"）、CPU 既定30秒・最大5分、**「If you consume more than 30 seconds of compute between incoming network requests, there is a heightened chance that the individual Durable Object is evicted and reset.」**（#4 の言い回しは原文どおり）、1,000 req/s soft limit と overloaded、100列 / 行 2 MB / SQL 100 KB / bind 100、LIKE-GLOB 50 バイト、**結果セット合計サイズの項目は実在しない**（#26 の「未確認」は正しい）
  - `/durable-objects/api/sql-storage/` および `/durable-objects/api/sqlite-storage-api/`（両 URL とも実在） — `transactionSync` は「must complete synchronously, that is, it should not be declared `async` nor otherwise return a Promise」、**ネストへの言及は無い**（#14 の「未確認」は正しい）、`sql.exec()` は `BEGIN TRANSACTION` / `SAVEPOINT` 不可、カーソルを `await` 跨ぎで保持するとスナップショット非保証、**拡張は FTS5（`fts5vocab` 含む）/ JSON / 数学関数の3つだけで `bm25` / `snippet` / `highlight` / trigram は一語も無い**（#10 / #13 は正しい）、仮想テーブル書き込みも rows written、PITR 30日・ローカル非対応
  - `/durable-objects/api/alarms/` — 「a single alarm at a time」、既存を override、at-least-once、**「exponential backoff starting at a 2 second delay from the first failure with up to 6 retries」**、**duration / wall time への言及は無い**（#3 の出典指摘は正しい）
  - `/durable-objects/api/id/` — `idFromName()` / `getByName()` でのみ `name` が定義、`newUniqueId()` / `idFromString()` は `undefined`、**1,024 バイト超は `ctx.id` に渡らない**、**「Alarms created before 2026-03-15 do not have `name` stored」**（#6 の4条件すべて正しい）
  - `/durable-objects/api/state/` — `waitUntil` は「has no effect in Durable Objects」、`blockConcurrencyWhile` は30秒でタイムアウトし DO をリセット・他イベントを全ブロック、`abort()` は `wrangler dev` で利用不可
  - `/durable-objects/reference/durable-objects-migrations/` — `exports` と `migrations` の同居は「rejected at validation」、`exports` 経由の namespace は常に SQLite、storage type は immutable、**「There is no Trash for Durable Object namespaces deleted through `exports`」**、`exports` へ移行後に `migrations` へ戻せない
  - `/durable-objects/best-practices/error-handling/` — 「Errors with the property `.overloaded` set to True should not be retried」（#19 と第4.7節の「retryable false」は正しい）
  - `/durable-objects/best-practices/rules-of-durable-objects/` — single-threaded / globally-unique、input gate / output gate、`fetch()` の await で input gate が開き他リクエストが割り込む
  - `/durable-objects/platform/pricing/` — 両プランで利用可（Free は SQLite のみ）、「Each `setAlarm()` is billed as a single row written」
  - `/api/.../objects/methods/list/` — 返るのは `id`（16進）と `hasStoredData` のみ、**name は返らない**（#5 の判断と、その根拠の種別注記が正しい）
  - `/durable-objects/reference/data-location/` — 「Only the first call to `get()` for a particular Object will respect the hint」「Durable Objects do not currently change locations after they are created」（第5.2.4節の結論を支持）

  **公式記載 / 実測 / 未確認の3分類が、1件も水増しされていない。** 第2.1節はこのまま #35 / #37 の依拠先として使える。

- **[N-002]** **第8.2節の型ガードは実際に機能する。** `run<T>(fn: (ctx) => T extends Promise<unknown> ? never : T): T` は条件型がパラメータ位置にあるため推論が壊れるのではないかと疑ったが、リポジトリの `tsc` で検証したところ設計どおりに動く。

  ```
  uow.ts(13,32): error TS2322: Type 'Promise<number>' is not assignable to type 'never'.   // async コールバック
  uow.ts(16,26): error TS2322: Type 'Promise<number>' is not assignable to type 'never'.   // Promise を返す非 async コールバック
  ```

  同期コールバックはエラーにならない。第8.2.1節で `SemanticCommitPort` 案を棄却した根拠（「同じ保証が `async` の排除だけでゼロコストに得られる」）は成立している。

- **[N-003]** **第7.2節の実測要約は先行ブランチの実物と一致する。** `origin/issue/19/cloudflare-do-fts:.thread/19/spike/fts5.integration.test.ts` を読んだところ、「東京駅の構内を歩く」「東京駅の周辺を歩く」「京都駅の周辺を歩く」の3件投入、`東京駅` で2件、`東京` で2件、`周辺` を `limit 1` で2ページに割って別項目、という要約が逐語的に正しい。`bm25(search_fts, 3.0, 1.0)` も `searchIndex.ts:465` に実在し、`schema.ts:92-94` が `content='search_entries'` + `tokenize='trigram'` の external-content 構成であることも確認した。スニペットに `<mark>` が入ることもテストが assert している。**要約が正確なので AC-19（先行ブランチを開かずに読める）は満たされている。** ただし `.adr/003` の唯一の根拠が未マージブランチ上のファイルである点は変わらないので、#37 が着手時に同等の spike を本流へ持ち込むまでは、そのブランチを消さないほうがよい（W-002 の修正と同時に処理できる）。

- **[N-004]** **`spec/inventory/adapter.md` の `ADP-*` は実測でユニーク85件、重複ゼロ。** design.md の「実測でユニーク85件」は正確である。内訳はスキーマ14 / identity 16 / memo 13 / knowledge 27 / search 9 / trash 4 / export 2。第4.3節が引用している49件はすべて台帳に実在し、意味も一致する。スキーマ系14件は全件が表に載っている。**述語 (a) の適用漏れは W-003 の1件（+ 軽微1件）だけ**で、`findTimelinePage(userId, query)` / `TrashQueryPort.listTrashItems(userId, ...)` / `ExportSourceReader.readAll(userId)` / knowledge の読み18件などは正しく除外されている。手作りの列挙ではなく実際に台帳を走査したという第4.3節の主張は裏が取れた。

  台帳側の小さな穴（design の穴ではない）: `ExportRenderer.render`（`spec/domains/export.md:242-249`）に ADP ID が振られていない。行27 / 行28 が「純粋計算の実行位置」を論点にした以上、同じ問いの対象になるはずだが台帳が拾えない。#35 が `spec/inventory/adapter.md` を直すときのついでに。

- **[N-005]** **Account Home を採らない結論は、B-004 を直せば技術的に成立する。** Issue が挙げた4つの区別を個別に追った結果:
  - **signup 部分失敗** — Directory mapping の `status: 'reserved'` と User Data DO の `operations.phase` の2系統で区別できる。第5.3節 login 手順3 が `status` を返す設計になっているので、`reserved` 段階のアカウントでログインできることはない ✓
  - **退会中** — `account.status = 'deleting'`（User Data DO）。第6.7節が tombstone を先に書く順序なので、退会処理が途中で落ちても `deleting` が残り fail closed ✓
  - **古い PITR mapping** — Directory を戻して mapping が復活しても `account.status = 'deleted'` が現在のままで拒否。User Data DO を戻しても mapping が無ければ到達不能。第10.1節の「どちらか一方の restore だけでは復活しない」は成立する ✓（ただし epoch 巻き戻しは別問題。W-005）
  - **credential 変更後の古いセッション** — `sessionEpoch`。認証済みリクエストはどのみち自分の User Data DO を叩くので照合コストがゼロ、という第3.1節の中核論証は正しい ✓（AI トークンは対象外。W-006）

  4件のうち3件は `account` テーブル1つで賄えており、「権威を独立クラスに切り出す必要が無い」という結論は妥当。**唯一 unlink 後の孤児 mapping だけが `account` では捕まえられず、`credential_locators` の照合を要求する** — それが B-004 である。逆に言えば、B-004 を login 手順に組み込むことが、Account Home を畳んだ設計の成立条件そのものになっている。

- **[N-006]** 軽微: 第2.1節の直後（`design.md:94`）に「10 GB は『Storage per Durable Object』として**両プラン共通に1度だけ書かれており**、Free の 5 GB は『Storage per account』の値である」とあるが、limits ページの表は 10 GB を Workers Paid 列に置いており、Free 列に per-object の値を明示していない。**「矛盾は無い」という結論は正しい**（Free は account 側 5 GB が先に効くので per-object の値は事実上意味を持たない）が、「両プラン共通に1度だけ書かれている」という記述は表の形と少し違う。第2.1節 #1 の表本体は正確なので、この補足文だけ言い回しを緩めれば足りる。

- **[N-007]** AC-5（断定形）の観点では、`［Issue 要求］` / `［派生］` ラベルの節に「検討する」「TBD」で終わっている結論位置は見当たらなかった（NUL のせいで grep が効かないため `grep -a` と目視で確認）。第11.4節の未決事項は3件で、いずれも「決める主体 / いつ / 本設計への影響」が埋まっており、うち2件は「影響: **無い**」と明記されている。第7.2.1節も「本 Issue では決めない」ではなく「#35 への委譲」として要旨を渡す形になっていて、plan の AC-5 対象外条件に合致する。**#37 が「まだ決まっていないので進めない」と言える節は無い。**

- **[N-008]** 第6.2.1節 (c) の復号経路2「鍵ローテーションの再写像 — このときだけ canonical が request Worker 側へ渡る」は、第3.2節の「秘密の配布境界を非重複に」を**鍵については**守りつつ、**平文の PII は Worker 境界を越える**ことを意味する。設計はこれを隠さず書いているので指摘ではないが、#38 の鍵ローテーション運用手順では「maintenance 経路のログ・トレース設定を平文が残らない構成にする」ことを明示的な作業項目にしておくとよい（第5.2節 (c) の非露出方針の運用面）。

---

## 検証の方法（再現手順）

このレビューで「実物に当たった」箇所の再現方法を残す。

| 検証 | 手段 |
|---|---|
| プラットフォーム制約26件 | 上記 N-001 の10ページを WebFetch で個別取得し、design.md の各行と逐語照合 |
| 実装引用（27項目） | `packages/core/` / `apps/web/` / `spec/` の該当ファイルを直接 Read。行数は `wc -l`、有無は `git grep` |
| `ADP-*` 台帳 | `spec/inventory/adapter.md` を全件抽出（85件）→ design.md 第4.3節の引用49件と集合差分 → 差分36件を `spec/domains/*.md` の実シグネチャで個別判定 |
| 先行ブランチの実測 | `git show origin/issue/19/cloudflare-do-fts:<path>` で spike テストと searchIndex / schema を直読み |
| UoW 型ガード | 最小再現 `.ts` を書き、リポジトリの `node_modules/.bin/tsc --strict` で実行 |
| NUL バイト | `tr -dc '\000' < <file> \| wc -c`、`grep -c` と `grep -ac` の差分、`file <path>` |
