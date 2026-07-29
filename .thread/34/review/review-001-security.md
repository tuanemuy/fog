# レビュー 001 — セキュリティ観点

**対象:** PR #43 / Issue #34（設計フェーズ）
**主レビュー対象:** `.thread/34/design.md`（1059行、全文読了）
**照合した実装:** `packages/core/src/domain/identity/`、`packages/core/src/adapters/webcrypto/`、`packages/core/src/adapters/d1/`、`packages/core/src/application/identity/`、`apps/web/app/presentation/`、`spec/domains/index.md`、`spec/inventory/adapter.md`
**日付:** 2026-07-29

---

## セキュリティ

### Blockers

- **[B-001]** signup の `operationId`（= 候補 `userId`）が再送で保持される機構が未定義で、唯一実現可能なのはクライアント供給。その瞬間「外部入力が `idFromName` に到達しない」という本設計の中核主張が崩れる
  - 場所: `.thread/34/design.md:500-501`（phase 0/1）、`.thread/34/design.md:531`（operation key の設計）、`.thread/34/design.md:359-362`（第5.2.2節 (a)(ii)）、`.thread/34/design.md:434-437`（第5.5節）
  - 理由:
    - 第6.5節は「`operationId` は request Worker が採番し、**再送中は同じ値を保持する**」と書くが、**どこに保持するかを書いていない**。signup では `operationId` がそのまま `userId` であり、その `userId` でしか到達できない User Data DO が唯一の永続先なので、**サーバー側に置き場所が原理的に存在しない**（循環する）。残る選択肢はクライアント（hidden field / `Idempotency-Key` ヘッダ）だけである。
    - するとクライアントが供給した文字列がそのまま `idFromName()` の引数になる。これは第5.5節 (1)「ここに `userId` を渡せるのは `sessionCodec.verify` / トークン検証の戻り値、または signup で `IdGenerator` が採番した値のいずれかに限られる」および第5.2.2節 (a)(ii)「外部入力から来ることが構造的にありえない」と**正面から矛盾する**。
    - 具体的な帰結が2つある。(i) 未認証の攻撃者が任意文字列で新しい User Data DO を無制限に起こせる — これは第6.2節の判断軸 (iv) で案 (c) を棄却した理由「**任意の未認証文字列が新しい DO 名を引く**」（`design.md:464`）そのものであり、User Data namespace 側で同じ穴を開けている。(ii) 攻撃者が被害者の `userId` を知っていれば（`Actor` はリビジョンに記録され、export ヘッダにも載る。`packages/core/src/domain/identity/valueObject.ts:186-206`、`design.md:267`）、その値を `operationId` として signup を投げ、**未認証のまま他人の User Data DO に到達して `operations` 行を書き込める**。
    - さらに phase 1 には**アカウント既存チェックが無い**（`design.md:501` は `payloadDigest` の一致しか見ない）。既存ユーザーの DO に signup phase 1 が入っても弾かれる保証が設計文面に無い。
    - 加えて、signup phase 1 は未認証で User Data DO の RPC を叩くので、第5.1節の epoch ガード（`design.md:332`「全 RPC エントリの先頭で」）を必ず素通りする。**その例外の存在と、代わりに何がガードするかが書かれていない。**
  - 提案:
    1. `operationId` と候補 `userId` を**分離する**。`userId` は request Worker が毎回 `IdGenerator` で採番し、**クライアントからは絶対に受け取らない**と明記する。
    2. signup の再送冪等性は「同じ `userId` を再利用する」ではなく **Directory bucket の予約行が持つ**形に倒す（同じ canonical に対する予約は第6.5節の勝者決定規則で1本に収束する）。捨てられた候補 `userId` の User Data DO は phase 1 の TTL 掃除（第6.4節）で回収される。
    3. どうしても `operationId` を跨リクエストで保持したいなら、**`HMAC(SIGNUP_SECRET, canonical)` から決定的に導出する**（クライアント供給ではなくサーバー導出にする）。ただしこの場合 `userId` を canonical から導出することになり第5.2.2節 (a) の「鍵に依存しない locator」を壊すので、`operationId` にだけ使い `userId` には使わない。
    4. User Data DO の signup 用 RPC エントリを**明示的に列挙**し、「`account` 行が既に存在する場合は無条件で拒否する」「それ以外の全エントリは epoch ガードを通る」を設計に書く。

- **[B-002]** パスワード変更 / パスワードリセット完了の cross-DO 手順が設計に存在しない。credential が Directory 側で更新されても `sessionEpoch` の前進が保証されず、**古いセッションが生き残る穴**が塞がっていない
  - 場所: `.thread/34/design.md:332`、`.thread/34/design.md:534`、`.thread/34/design.md:450-452`（第6.1節 (d)）、`.thread/34/design.md:674`（Alarm ジョブの `kind` 一覧）
  - 理由:
    - saga として順序・部分失敗・補償が書かれているのは **signup（第6.3〜6.5節）/ SSO link・unlink（第6.6節）/ 退会（第6.7節）の3つだけ**である。パスワード変更とリセット完了は「新しい検証材料を Directory bucket に書く」＋「User Data DO の `sessionEpoch` を進める」という**2 DO をまたぐ操作**なのに、順序も補償も指定されていない。第6.5節の記述は「同じ `operationId` の再送では epoch を一度だけ進める」という冪等性の話だけで、**前進の保証にはなっていない**。
    - どちらの順序でも穴が開く。(i) Directory 先 → epoch 後: 途中で落ちると新パスワードが有効なのに**旧セッションが 7 日間生き続ける**。パスワードリセットは「アカウントが乗っ取られたので取り返す」典型経路なので、攻撃者のセッションが残るのは致命的である。(ii) epoch 先 → Directory 後: 正規利用者はログアウトされるが**旧パスワードが通り続ける**。
    - 第7.4節の Alarm ジョブ `kind` 一覧（`purge-trash` / `send-mail` / `resume-signup` / `sweep-reservations` / `rotate-remap` / `reindex` / `migrate-bulk`）に**credential 変更を前進させる種別が無い**。つまり落ちたら誰も拾わない。
    - 関連する TOCTOU も塞がっていない。第5.3節の login は、step 3 で Directory から `passwordVerifier` を取得 → step 4 で request Worker が照合 → step 5 で User Data DO から現在の `sessionEpoch` を読む → step 6 で発行、という順序である（`design.md:403-406`）。step 3 と step 5 の間にリセットが完走すると、**旧パスワードでの照合が成功したまま、新しい epoch を載せた有効なセッションが発行される**。epoch ガードでは検出できない（epoch は最新なので）。
  - 提案:
    1. 第6章に「**credential 変更 saga**」の節を追加し、signup / unlink と同じ表形式で phase・失敗時の残留物・片付ける主体・タイミングを書く。
    2. 順序は **`sessionEpoch` を先に進め、Directory の検証材料更新を後**にした上で、**旧検証材料を即座に無効化する**（`credential_mappings` 行に `pendingChange` を立てて旧 verifier での照合を拒否する、など）。「旧パスワードが通る」窓を作らないためである。
    3. `kind` に `resume-credential-change` を追加し、User Data DO 側の Alarm が Directory 側の完了を再試行する（第6.4節の「phase 3 以降は前進」と同じ規則に乗せる）。
    4. TOCTOU は、`credential_mappings` 行に **`credentialVersion`** を持たせ、step 3 で読んだ値を step 5/6 のトークン発行時に User Data DO 側へ渡して照合するか、あるいは**トークン発行そのものを User Data DO の RPC 内で行い**、その中で credential バージョンを検証する形にする。

- **[B-003]** 退会が `credential_locators` を Directory mapping より**先に**削除するため、途中で落ちると `encryptedCanonical`（メール原本 = PII）が Directory bucket に孤児として残り、**到達手段も回収ジョブも存在しない**
  - 場所: `.thread/34/design.md:565-566`（第6.7節 step 3 / step 4）、`.thread/34/design.md:674`（Alarm ジョブの `kind` 一覧）、`.thread/34/design.md:492`（第6.2.1節 (d)）
  - 理由:
    - 第6.7節の順序は「step 3: `account.status = 'deleted'` にする。**`credential_locators` はこの時点で消す**」→「step 4: Directory bucket の mapping 行（`encryptedCanonical` を含む）を物理削除する」である。
    - `credential_locators` は「世代 + bucket index + 全長 HMAC」を持つ**唯一の逆引き情報**（`design.md:505`）である。step 3 と step 4 の間で落ちると、削除すべき mapping 行の所在を知る手段が消える。HMAC は一方向なので User Data DO 側からは再計算できず、canonical 原本は削除対象の行の中にしかない。
    - 回収手段が設計に無い。第7.4節の `kind` 一覧に退会完了を前進させる種別が無く、第6.6節の孤児検出（reverse locator との突き合わせ）も **`credential_locators` が消えているので機能しない**。第6.4節の TTL 掃除は `status: 'reserved'` の行しか対象にしない（`design.md:520`）ので `active` な孤児は残る。
    - 帰結: (i) **退会後もメール原本が暗号化状態で無期限に残存する** — 第6.2.1節 (d)「退会が完了した時点で `encryptedCanonical` を含む行を物理削除する。**bucket 側には何も残さない**」という宣言が守られず、GDPR 的な削除の完全性が崩れる。(ii) mapping が `active` のまま残るので**そのメールアドレスで再登録できない**（第6.3節 phase 2 が `EMAIL_ALREADY_REGISTERED` で敗北する）。永続的なアカウント作成拒否になる。
    - 世代をまたぐ削除の網羅も未定義である。第6.8節のローテーション中は active 世代と previous 世代の両方に行が存在しうる（`design.md:577`「移送先の bucket に active 行を書いてから、元の previous 行を消す」）が、第6.7節 step 4 も第6.6節 step 3 も「どの世代の bucket を消すか」を書いていない。ローテーション中に退会すると片方の世代に PII が残る。
  - 提案:
    1. **順序を入れ替える** — step 4（Directory mapping 削除）を先に完了させ、`credential_locators` の削除は最後にする。第6.6節 unlink で「User Data 先 → Directory 後」を採った理由（残留 mapping は fail closed 側に倒れる）は退会でも成立する。`account.status = 'deleted'` が既にゲートになっているので、mapping を先に消しても認可上の穴は開かない。
    2. `kind` に `finalize-withdrawal` を追加し、`credential_locators` が空でなく `account.status = 'deleted'` の状態を User Data DO の Alarm が前進させる。
    3. 削除は **`credential_locators` に記録された全世代分**を対象にすると明記する。ローテーション中の退会に備え、「active / previous の両世代の bucket に対して削除を発行し、無ければ成功とする」冪等規則を書く。
    4. 最後の砦として、Directory bucket 側にも「`userId` を指定して自 bucket 内の全 mapping 行を削除する」冪等 RPC を用意し、256 bucket 走査による復旧手段（operator 経路）を第11.3節の運用手順に送る。

- **[B-004]** `IDENTITY_MAIL_ENCRYPTION_KEY` に**世代管理が無いと明言**されており、PII を保存時暗号化する鍵にローテーション経路が存在しない。暗号方式（AEAD / nonce / AAD 束縛）も未定義
  - 場所: `.thread/34/design.md:484`（第6.2.1節 (b)）、`.thread/34/design.md:482`（同 (a)）
  - 理由:
    - 第6.2.1節 (b) は「別鍵にする理由は2つ — routing secret はローテーションのたびに世代が増えるが**暗号化鍵はそうではないこと**」と書く。これは鍵分離の論拠として述べられているが、**同時に「この鍵はローテーションしない」を宣言してしまっている**。
    - `encryptedCanonical` は全ユーザーのメールアドレス原本という、このシステムで最も価値の高い PII である。その鍵が漏洩した場合の対応手段（再暗号化バッチ）が設計に無い。第6.8節の `rotate-remap` ジョブは routing secret の世代移送専用で、再暗号化には使えない。
    - 暗号方式そのものも決まっていない。AEAD かどうか、nonce の生成規則（行ごとにユニークか）、AAD に何を束縛するか（`(kind, hmac)` に束縛しないと、bucket 内で暗号文を別の mapping 行へ**付け替えられる** — DB 書き込み権限を得た攻撃者が「B のメールアドレスを A のアカウントの原本にすり替える」ことでリセットメールを別アドレスへ送らせる経路が開く）が全て未定義である。
    - AC-23 (c)「canonical credential（メール原本）の保持場所**と保護方式**が決着している」は、保持場所は決着しているが**保護方式は決着していない**。
    - なお **HMAC routing secret 側の鍵管理は十分に設計されている**（第5.2.3節の keyring、active → previous の二重解決、第6.8節の retirement 証明）。本指摘は暗号化鍵に限る。
  - 提案:
    1. 暗号化鍵にも `{ generation, key }` の keyring を持たせ、`credential_mappings` 行に `encryptionGeneration` を記録する。復号は行が宣言した世代の鍵で行う（HMAC 側と同じ形）。
    2. 再暗号化を `kind: 'rotate-encryption'` の bucket Alarm ジョブとして追加し、第6.8節と同じチェックポイント走査 + snapshot 置換による retirement 証明に乗せる。
    3. 暗号方式を AEAD（AES-256-GCM）と明記し、**行ごとにランダム nonce**、**AAD に `(kind, hmac, generation)` を束縛**すると書く。これで暗号文の付け替えが検出可能になる。
    4. 復号結果の非露出（第6.2.1節 (c)）に「**復号した canonical をログ・エラー・メトリクス・トレースに出さない**」を明記済みだが、これに加えて「復号結果を永続化しない（DO の SQLite にも request Worker のメモリ外にも残さない）」を足す。

---

### Warnings

- **[W-001]** DO への RPC が**新しい信頼境界**になることが設計で扱われていない。CLAUDE.md「トランスポート境界と値オブジェクト構築の2点で検証」が DO 化後にどう保たれるかの結論が無い
  - 場所: `.thread/34/design.md:812`（第8.3節 (b)）、`.thread/34/design.md:820-824`（同 (d)）、`.thread/34/design.md:435`（第5.5節 (2)）
  - 理由:
    - 第8.3節 (d) が扱っているのは **RPC の戻り値**（`{ ok, value } | { ok, error }` エンベロープ）だけで、**引数側**の検証について一言も無い。state Worker は独立した script で、その DO クラスは binding を持つ任意の Worker から呼べる。第5.5節 (2) の「usecase は DO の内側で走るので外部入力が locator に到達しない」は locator の話であって、**RPC 引数の内容が検証済みである根拠にはならない**。
    - 具体的な破れ方がある。ドメインの値オブジェクトはすべて**ブランド付き string / number**（`packages/core/src/domain/identity/valueObject.ts:19,37,76,97,125,142,168`）で、ブランドは型レベルにしか存在しない。RPC は構造化クローンで値を運ぶので**ブランドは境界を越えた時点で失われ、生の string が `Email` 型として通る**。DO facade の署名が `Email` を受け取る形で書かれると、型システムが「検証済み」と嘘をつく。CLAUDE.md の「値オブジェクト構築で検証する」が構造的に無効化される。
    - 第5.2.1節 (b) は `Email.create` を canonical 化の唯一の出所にすると決めた（現行は `trim().toLowerCase()` のみ — `valueObject.ts:47` で確認済み）。この決定は「`Email.create` が必ず通る」ことに依存しているが、上記の理由でそれが保証されない。
  - 提案:
    - 第8.3節に (e) として「**DO facade のメソッド署名はブランド型を取らない。プリミティブ（`string` / `number`）だけを受け取り、DO の内側で値オブジェクトを再構築する**」を追加する。これで CLAUDE.md の「2点で検証」は「transport 境界（request Worker）」と「値オブジェクト構築（DO 内）」の 2 点として維持され、RPC 境界は 3 点目にならない。
    - あわせて「state Worker の DO クラスに公開ルートを持たせない（binding 経由でしか到達できない）」を第3.2節に明記する。信頼境界を「script 分離 + binding」に置くという判断を文章にしておくこと。

- **[W-002]** `sessionEpoch` をトークンに載せる決定が、既存の `SessionCodec` ポート契約の変更を要求するのに、#37 への引き継ぎ（第11.2節）にその行が無い。かつ AI クライアントトークンは epoch を持たないので第6.7節の記述が事実と合わない
  - 場所: `.thread/34/design.md:324`・`.thread/34/design.md:332`・`.thread/34/design.md:563`、`packages/core/src/application/ports/sessionCodec.ts:22-24`、`.thread/34/design.md:990-1008`（第11.2節）
  - 理由:
    - 現行ポートは `issue(userId, now): Promise<string>` / `verify(token, now): Promise<{ userId } | null>` で、**epoch を運ぶ口が無い**。実装 `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:28` のペイロードも `{ uid, exp }` だけである。第11.2節の削除対象・新設対象のどちらにも `application/ports/sessionCodec.ts` / `adapters/webcrypto/hmacSessionCodec.ts` が現れない。第3.1節が「セッション方式そのものは**変えない**」と書いていることが、この見落としを誘発している — 方式は変わらないがポート契約は変わる。
    - 第6.7節 step 1 は「`sessionEpoch` を進める。この瞬間から既存セッション・**AI トークンが全部無効になり**」と書くが、第5.4節の AI クライアントトークンのペイロードは `{ userId, connectionId, scope, exp }` で **`sessionEpoch` を含まない**（`design.md:414`）。したがって epoch の前進では AI トークンは無効化されない。実際に無効化しているのは第5.1節の「アカウントが `deleting` / `deleted` なら fail closed」の方である。機構としては塞がっているが、**設計文の因果説明が誤っている**ので #37 が epoch だけを実装して AI トークン側のガードを落とす危険がある。
  - 提案:
    - 第11.2節の「削除対象 / 新設対象」に `packages/core/src/application/ports/sessionCodec.ts`（`issue(userId, epoch, now)` / `verify` の戻り値に `epoch` を足す）と `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`（ペイロードを `{ uid, ep, exp }` へ）を明記する。
    - 第6.7節 step 1 の記述を「セッションは epoch 不一致で、AI クライアントトークンは `account.status` ガードで拒否される」と機構別に書き分ける。第5.1節の epoch ガードにも「AI クライアントトークン経路は epoch ではなく `status` + `ai_client_connections.status` で判定する」を明記する。

- **[W-003]** セッショントークンと AI クライアントトークンが同一の HMAC 鍵・同一方式で署名される設計になっているのに、**鍵分離も audience タグも無い**
  - 場所: `.thread/34/design.md:414`（第5.4節）、`.thread/34/design.md:144`（第3.2節の秘密配布表）
  - 理由:
    - 第3.2節の request Worker が持つ秘密は `SESSION_SECRET` と `DIRECTORY_ROUTING_SECRET` の2つだけで、AI クライアントトークン用の鍵が挙がっていない。第5.4節は「セッショントークンと同じ方式」とだけ書く。したがって同じ鍵で2種類のトークンが署名されると読める。
    - 型混同（token confusion）の余地が生まれる。現行の `parsePayload`（`hmacSessionCodec.ts:30-42`）は `uid` と `exp` の存在しか見ないので、`{ userId, connectionId, scope, exp }` を `uid` キーで書いた場合にセッションとして通る／通らないが実装依存になる。逆方向（セッショントークンを AI トークン検証器に食わせる）についても設計に規定が無い。とくに AI トークンは `scope` を自己完結で持つため、混同が起きると **scope の格上げ**につながる。
  - 提案:
    - `AI_CLIENT_TOKEN_SECRET` を別鍵として第3.2節の表に足す（**鍵分離が最も安全**）。分けない場合は、両方のペイロードに `typ: "session" | "aiClient"` を必須フィールドとして入れ、**検証側で厳密に一致を要求する**（欠落は拒否）と明記する。

- **[W-004]** AI クライアントトークンが `scope` を自己完結で持つため、**scope の縮小や connection の権限変更が `exp` まで反映されない**
  - 場所: `.thread/34/design.md:414-418`（第5.4節）
  - 理由:
    - 第5.4節は失効について「`ai_client_connections.status` を DO の中で読むので次のリクエストで即座に効く」と結論づけているが、これは **revoke（全否定）にしか効かない**。`scope` はトークン内の値であり、DO 側が保存された connection の scope と照合するとは書かれていない。利用者が「このクライアントの権限を read-only に落とす」操作をしても、発行済みトークンは元の scope で通り続ける。
    - `TokenScope` は未実装（`design.md:111`）なので、いま決めておかないと #37 がトークン内 scope をそのまま信頼する実装になる。
  - 提案:
    - 第5.4節に「**DO 側のガードはトークンの `scope` を信頼せず、`ai_client_connections` に保存された現在の scope と突き合わせ、両者の積を有効 scope とする**」を追加する。トークン内の `scope` は最適化（早期拒否）としてのみ使う。

- **[W-005]** パスワードリセットトークンに bucket index を埋め込む決定（`{bucketIndex}.{random}`）が、第5.2節 (c)「locator を URL に出さない」と矛盾する
  - 場所: `.thread/34/design.md:452`（第6.1節 (d)）、`.thread/34/design.md:342`（第5.2節 (c)）
  - 理由:
    - bucket index は `HMAC-SHA-256(DIRECTORY_ROUTING_SECRET, canonical)` の先頭2バイトを bucket 数で剰余した値（第5.2.5節 (a)）であり、**canonical credential から導出された locator の切り詰め**である。第5.2節 (c) は「canonical 値・HMAC 値・locator を、**公開入力・URL**・ログ・エラーメッセージ・トレースのいずれにも出さない」と断定している。リセットリンクは URL であり、ブラウザ履歴・Referer・アクセスログ・メールプロバイダのログに残る。
    - 影響は限定的である（256 分割なら約 8 bit の情報、かつ routing secret を持たない攻撃者は候補メールとの照合ができない）。ただし**同じ bucket index を持つリセット URL 同士の相関**は取れるので、複数のリセット URL を観測できる立場（メールゲートウェイ、共有端末）では弱い名寄せ材料になる。
    - 問題の本質は矛盾が**設計文に自覚されていない**ことである。トレードオフとして受容するなら明記すべきで、そうしないと #37 が第5.2節 (c) を機械的に適用してこの設計を壊すか、逆に (c) が形骸化する。
  - 提案:
    - 第6.1節 (d) に「bucket index の埋め込みは第5.2節 (c) の例外であり、漏れる情報は約 8 bit で canonical との照合には routing secret が必要である」というトレードオフ注記を足す。
    - あるいは埋め込む値を **bucket index そのものではなく `HMAC(RESET_TOKEN_SECRET, random)` から導出した独立のルーティングタグ**にし、bucket 側にタグ → bucket の対応を持たせる（bucket index を露出させずに単一 bucket へ到達できる）。

- **[W-006]** 鍵ローテーション時に**全ユーザーのメールアドレス平文が Worker 間 RPC を bulk で流れる**のに、その経路の保護規定が無い
  - 場所: `.thread/34/design.md:488`（第6.2.1節 (c) の経路2）、`.thread/34/design.md:577`（第6.8節 step 2）、`.thread/34/design.md:369-373`（第5.2.3節）
  - 理由:
    - 復号鍵は state Worker だけ、HMAC 鍵は request Worker だけ、という配布境界（第3.2節）の帰結として、再 HMAC には「state Worker が復号 → 平文 canonical を request Worker へ渡す → request Worker が HMAC」という往復が必要になる。第6.2.1節 (c) は「このときだけ canonical が request Worker 側へ渡る」と認めているが、**バッチサイズ・非ログ要件・平文の生存期間について何も定めていない**。
    - ローテーションは operator が手動で走らせる保守作業であり、まさにトレース・詳細ログを有効化しがちな場面である。全ユーザーの PII が一度に境界を越えるので、事故時の被害は最大化する。
  - 提案:
    - 第6.8節に「再写像バッチでは (i) 平文 canonical を含む RPC に対してログ・トレースを無効化する、(ii) バッチサイズを bucket 単位のチェックポイント内に限定する、(iii) 平文を DO の SQLite にも request Worker のいかなる永続領域にも書かない」を明記する。
    - 代替案として、**HMAC 計算を state Worker 側で行い、routing secret を「ローテーション時だけ maintenance 経路から注入する」**形も検討に値する（平文が境界を越えなくなる）。採らないなら理由を書く。

- **[W-007]** 未認証経路（login / signup / password reset）にレート制限・試行回数制限の設計が一切無く、bucket 分割が**標的型 DoS の緩和にならない**
  - 場所: `.thread/34/design.md:464`・`.thread/34/design.md:472`（第6.2節 判断軸 (iv) と bucket 数の根拠）、`.thread/34/design.md:399-406`（第5.3節）、`.thread/34/design.md:295`（第4.7節）
  - 理由:
    - 第6.2節は「256 分割なら1 bucket あたりの認証トラフィックが 1,000 req/s の soft limit から十分離れる」と書くが、これは**トラフィックが canonical に対して一様分布する前提**である。攻撃者は単一のメールアドレスを狙って撃てるので、任意の1 bucket を選んで `overloaded` に追い込める。`overloaded` は公式にリトライ禁止（第2.1節 #19、`design.md:85`）なので、**その bucket に写像される全ユーザー（約 1/256）の login / signup / password reset が停止する**。全ユーザーの 0.4% を狙い撃ちで締め出せる。
    - パスワード総当たりに対する試行回数制限も無い。DO 化により「同じ bucket に候補メールの試行が集まる」という**カウントに最適な構造**が手に入っているのに、それを使う設計が無い。
    - 単一グローバル DO 案 (a) を棄却した理由が (iv) の soft limit だったので、この論点は設計自身の判断軸に直結する。
  - 提案:
    - 第6章に「未認証経路の濫用抑止」の節を追加し、少なくとも (i) `credential_mappings` 行に失敗試行カウンタ + 次回許可時刻を持たせる、(ii) リセット依頼の per-canonical レート制限、を方針として書く。詳細値は #38 へ送ってよい。
    - `overloaded` の標的型集中については、bucket 数を増やしても解決しない（攻撃者は同じ canonical を狙う）ことを明記し、Cloudflare 側の WAF / Rate Limiting Rules をどのレイヤーで当てるかを #38 の運用要件として立てる。

- **[W-008]** パスワードリセット依頼の「同じ処理経路を通す」と「ジョブを投入せずに成功を返す」が同じ段落内で矛盾している
  - 場所: `.thread/34/design.md:722`（第7.6節）
  - 理由: 「mapping が無い場合でも**ジョブを投入せずに**成功を返す」と「応答時間の差から登録の有無が漏れないよう、**mapping の有無にかかわらず同じ処理経路を通す**」が両立しない。ジョブ行の書き込み（SQLite write + `setAlarm`）は測定可能な処理時間差であり、登録済みメールの列挙オラクルになる。第5.3節の login はダミー検証材料で計算量を揃える具体策まで書いてあるのに、リセット側は宣言だけで手段が無い。
  - 提案: 「mapping が無い場合もダミーのジョブ行を書いて即 `done` にする」あるいは「レスポンスを固定遅延で返す」のいずれかを**具体策として選ぶ**。前者は書き込みコストを払うが確実、後者は安価だが遅延の見積りが要る。どちらを採るか設計で決める。

- **[W-009]** PII 非露出の規定が canonical / HMAC / locator に限定されており、**パスワード検証材料が対象に入っていない**。加えて `userId` のログ出力を明示的に許可しているため、未認証 login 経路のログが弱い列挙オラクルになる
  - 場所: `.thread/34/design.md:342`（第5.2節 (c)）、`.thread/34/design.md:403`（第5.3節 step 3）
  - 理由:
    - 第5.3節 step 3 で Directory bucket は `{ userId, passwordVerifier, status }` を**未認証リクエストに対して**値として返す。これが RPC の引数・戻り値ロギングやトレースに載れば、パスワードハッシュがログ基盤へ流出する。第5.2節 (c) の列挙（canonical 値・HMAC 値・locator）に `passwordVerifier` が入っていないので、規約上は許可されていると読める。
    - 同じ (c) は「ログには `userId`（採番された不透明値）と operation ID **だけを出す**」と書く。login 失敗時に `userId` が出るということは、**「そのメールアドレスは登録済みだった」がログに残る**ということである（未登録ならダミー材料なので `userId` が無い）。ログ閲覧権限を持つ内部者に対する列挙オラクルになる。第5.3節が公開レスポンス側で列挙対策をしている努力と釣り合わない。
    - なお第4.8節の「露出範囲は現行の `findByEmail` が `User` ごとハッシュを返しているのと同じ」という主張は**実装と照合して正しい**（`packages/core/src/application/identity/loginWithPassword.ts:122,143` で `findByEmail` の戻り値のハッシュを usecase が `verify` に渡している）。ただし現行はプロセス内の関数戻り値、DO 化後は script 境界を越える RPC 値なので、**観測面は増えている**。
  - 提案:
    - 第5.2節 (c) の非露出対象に `passwordVerifier` / `encryptedCanonical` / リセットトークン（生値とハッシュの両方）を明示的に加える。
    - 未認証経路のログでは `userId` を出さない（operation ID のみ）と規定する。認証済み経路でのみ `userId` を出す。

---

### Notes

- **[N-001]** 引用されている実装の事実は、確認した範囲で**すべて実物と一致していた**。
  - `Email.create` が `trim().toLowerCase()` のみで NFKC も IDN 正規化もしない（`design.md:351` ↔ `packages/core/src/domain/identity/valueObject.ts:47`）
  - `UserId.create` が trim + 空文字チェックのみで、コメントが id フォーマットを `IdGenerator` の責務と明言（`design.md:360` ↔ `valueObject.ts:21-35`）
  - `users_email_uq` / `users_sso_identity_uq`（部分ユニーク）が実在（`design.md:447-448` ↔ `packages/core/src/adapters/d1/migrations/0000_initial.sql:46-47`）
  - `User = PasswordUser | SsoUser` の判別共用体（`design.md:538` ↔ `packages/core/src/domain/identity/entity.ts:36`）
  - `hmacSessionCodec` がステートレス HMAC + TTL 7日で、JSDoc が「サーバー側失効ができない」を自認（`design.md:134` ↔ `hmacSessionCodec.ts:5,44-56`）
  - PBKDF2 210,000 回（`design.md:308` ↔ `pbkdf2PasswordHasher.ts:30`）
  - `registerWithPassword` の `catch` が UNIQUE 違反を `EMAIL_ALREADY_REGISTERED` へ翻訳している漏れ（`design.md:840` ↔ `packages/core/src/application/identity/registerWithPassword.ts:61-77`）
  - `spec/domains/index.md:32` のテナント分離規約と Outbox 例外条項の文言（`design.md:277`）
  - `ADP-password-reset-tokens-001` / `ADP-identity-012` / `ADP-identity-016` の台帳エントリ（`spec/inventory/adapter.md:10,39,43`）
  - SSO が値オブジェクト・エンティティ・スキーマ・リポジトリ・`CurrentUserPanel` まで実装済みで、ユースケースとルートだけ無い（`design.md:108`）

- **[N-002]** **AC-14 は充足している。** 第5.2節に (a) 生メール・SSO subject を DO ID / routing key に使わない、(b) 正規化値の HMAC-SHA-256 を使う、(c) 公開入力・URL・ログ・エラー・トレースへ出さない、の3点が断定形で揃っている。第5.2.3節の鍵所有者・世代管理も第3.2節の Worker 分割の結論と整合している（request Worker のみが keyring を持ち、state Worker には置かない）。第5.2節が「ダッシュボードの Metrics タブが DO 名で絞り込める」（第2.1節 #25）を根拠に加えて**運用画面まで露出面に含めた**のは良い着眼である。ただし W-005 の bucket index 埋め込みが (c) と矛盾しているので、その注記だけは要る。

- **[N-003]** **AC-23 は (a)(b)(d) が充足、(c) は部分的。** (a) canonical 正規化規則は第5.2.1節で NFKC → domain lowercase + punycode → local lowercase まで確定し、SSO subject は正規化しないという判断も理由付きで書かれている。(b) locator 鍵の2系統分離は第5.2.2節で確定し、「ローテーションが User Data DO の同一性に波及しない」ことが読み取れる。(d) 衝突の扱いは第5.2.5節で「bucket index の衝突は正常 / 全長 HMAC で識別 / 最終確認は canonical 原本の定数時間比較」という 2 段構造が明快である。**(c) は保持場所（Directory bucket の `encryptedCanonical`）・鍵の所有者・復号経路2つ・退会時の消去範囲までは決着しているが、暗号方式と鍵ローテーションが未決なので B-004 とした。**

- **[N-004]** **パスワードハッシュの実行位置の判断は妥当である。** 第4.8節が PBKDF2 を DO の外（request Worker）で回すと結論づけた理由 —「User Data DO で回すとそのユーザーの全リクエストが止まり、Directory bucket で回すと同じ bucket の**全ユーザーの認証が止まる**」— は DO の single-thread 特性（第2.1節 #18）と CPU 予算の意味論（同 #4）から正しく導かれている。とくに「判定基準は wall time ではなく CPU 予算で、しかも超過はエラーではなくエビクション」（第7.4節・第9.2節）を設計の随所で一貫して適用しているのは質が高い。第4.7節の翻訳表で「CPU 予算超過には写す先が無い」と明記しているのも正確である。

- **[N-005]** **第5.5節の構造的保証の議論は筋が良い。** とくに (4)「DO の中には他ユーザーの行が存在しないので、誤った locator は全件のズレとして即座に顕在化し、『他人のデータを1行だけ読む』部分的漏洩は起き得ない」は、論理的分離から物理的分離へ移ることの実質的な安全性向上を正しく捉えている。第4.5節の「構造的保証の在り処が型（第一引数）から到達可能性へ移る。後者のほうが強い」も同意できる。**ただしその前提（外部入力が locator に到達しない）が signup で崩れているのが B-001 である。**

- **[N-006]** **第6.7節の PITR 相互ゲート論**（Directory mapping が到達性のゲート / User Data DO の `account.status` が状態の権威 / どちらか一方の restore だけではアカウントが復活しない）は、復旧単位が DO 1個であるという制約（第2.1節 #20）に対する良い設計である。第10.1節で「saga の中間状態が restore で復活しても TTL 掃除と `payloadDigest` 照合で回収される」まで押さえているのも周到である。**ただし B-003 の孤児 mapping が発生した状態では「Directory mapping が到達性のゲート」が逆に働き、退会済みメールの永久ロックになる。**

- **[N-007]** **第6.2節の分割方式の比較が実質的である。** 単一グローバル DO を棄却した理由（未認証トラフィックの集中と `overloaded` のリトライ禁止）、credential 1件 = DO 1個を棄却した理由（列挙不能性による retirement 証明の破綻 + 未認証入力による無制限 DO 生成）はどちらも Cloudflare のプラットフォーム事実に立脚しており、Issue が要求した「単一グローバル DO を無条件に採用してボトルネックを作らない」を正面から満たしている。第6.8節の retirement 証明を「加算カウンタではなく bucket ごとの snapshot 置換」に倒したのも #19 のレビュー指摘への正しい応答である。

- **[N-008]** **第9.4節の fail-closed（コードより新しい `schema_version` にはリクエストを受け付けない）は正しい判断である。** 「読めないより壊れるほうが悪い」という理由付けと、第3.2節のデプロイ順序（state 先 / request 後）との噛み合わせまで説明されている。

- **[N-009]** ダミー検証材料によるログイン応答時間の均一化（第5.3節 step 3-4）は現行実装（`packages/core/src/application/identity/loginWithPassword.ts:34-85` の `DUMMY_PASSWORD_HASH` とその iteration 数連動）の設計意図を正しく引き継いでいる。DO 化で Directory bucket が「見つからない場合もダミーを返す」形に変わっても均一化が維持される点は評価できる。

---

## 分析の過程・裏取りの結果

### 実施したこと

1. `CLAUDE.md` の「Input validation」「Error handling」「Cross-layer catch policy」を読了。
2. `gh issue view 34` で Issue 本文を読了（とくに「DO ID と PII」「Identity Directory DO」節）。
3. `.thread/34/design.md` 1059 行を全文読了。
4. `.thread/34/plan.md` から AC-13 / AC-14 / AC-22 / AC-23 を抽出して検証（結果は N-002 / N-003）。
5. 引用されている実装ファイルを**実物と照合**（結果は N-001）。照合対象は識別子・行番号・JSDoc の趣旨レベルまで。
6. 認証・認可の既存経路を追跡: Cookie → `readSessionToken` → `sessionCodec.verify` → `requireUserId`（`apps/web/app/presentation/currentUser.ts:17-54`）、`findByEmail` → `passwordHasher.verify`（`packages/core/src/application/identity/loginWithPassword.ts:122,143`）、`inputValidator` によるトランスポート境界検証（`apps/web/app/components/auth/{LoginForm,SignupForm}/action.ts:9`）。

### 観点別の判定サマリ

| 観点 | 判定 | 主な指摘 |
|---|---|---|
| テナント分離（他ユーザー DO を指定できる入力面） | **穴あり** | B-001（signup の `operationId` = `userId` がクライアント供給になりうる） |
| PII（DO ID / routing key / ログ） | **概ね良好、規定漏れあり** | N-002 / W-005 / W-009 |
| HMAC 鍵管理・ローテーション・二重解決 | **良好** | 第5.2.3節 + 第6.8節で完結。指摘なし |
| ハッシュ衝突の扱い | **良好** | 第5.2.5節の 2 段構造（N-003） |
| canonical credential の保持場所と保護方式 | **保持場所は決着、保護方式は未決** | B-004 |
| 認証情報の所有境界・`sessionEpoch` による失効 | **穴あり** | B-002 / W-002 / W-003 / W-004 |
| 部分失敗・冪等性（signup / SSO / 退会） | **signup と SSO は良好、退会に穴** | B-003（credential 変更 saga の欠落は B-002） |
| パスワードハッシュの実行位置と DoS 耐性 | **判断は妥当、濫用抑止が未設計** | N-004 / W-007 |
| 入力バリデーション（DO RPC が新しい信頼境界） | **未扱い** | W-001 |
| PITR（復旧単位が DO 1個であることの帰結） | **良好** | N-006（ただし B-003 が前提を崩す） |
| 引用実装の事実整合 | **一致** | N-001 |

### 意図的に指摘しなかったこと

- **退会 step 2 のチェックポイント削除が poison 化した場合、そのメールアドレスが永久に再登録できない** — 可用性の問題であって認可の穴ではない。#38 の運用監視で拾えばよい範囲と判断した。ただし B-003 の修正時に「`deleting` が長期滞留した場合の運用エスカレーション」を第11.3節へ足しておくと良い。
- **login の成功時と失敗時で RPC 往復数が違う（成功は Directory + User Data の 2 本、失敗は Directory のみ）** — 成功と失敗はそもそもレスポンスで区別できるので、追加の情報漏洩にならない。W-008（リセット依頼側）とは性質が違う。
- **`spec/domains/index.md:32` の「他ユーザーの ID を指定した操作は NotFound」が DO 化後も成立するか** — 成立する。エンティティ ID は自分の DO 内でしか引かれないので、他人の ID は必ず not found になる（第5.5節 (4) の主張どおり）。実装照合済み。
