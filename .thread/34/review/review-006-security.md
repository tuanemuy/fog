# レビュー 006 — セキュリティ

対象: PR #43 / Issue #34 / `.thread/34/design.md`（2,047行、全文読了）
照合した実装: `apps/web/app/presentation/{currentUser,authState}.ts`、`packages/core/src/adapters/webcrypto/{hmacSessionCodec,pbkdf2PasswordHasher}.ts`、`packages/core/src/application/ports/sessionCodec.ts`、`packages/core/src/application/di/secrets.ts`、`packages/core/src/application/identity/loginWithPassword.ts`、`packages/core/src/domain/identity/{valueObject,entity}.ts`、`packages/core/src/domain/identity/ports/userRepository.ts`、`packages/core/src/application/errors.ts`、`packages/core/src/adapters/d1/migrations/0000_initial.sql`、`spec/usecases/identity.md`、`spec/testcases/identity/requestPasswordReset.md`

## セキュリティ

### Blockers

- **[B-001]** ローテーション経路への `DIRECTORY_ROUTING_SECRET` 一時注入が、bucket 側で一切検証されない。クラス (3) の4群分類からも漏れている
  - 場所: `.thread/34/design.md:460`（第5.1節 RPC エントリ表の最終行）／`.thread/34/design.md:466`, `473`, `476`（(3-a)〜(3-d) の分類と「正しく塞げている」の断定）／`.thread/34/design.md:543-545`（第5.2.3節 一時注入）／`.thread/34/design.md:1046-1056`（第6.8節 手順2）
  - 理由: 3点ある。
    - **(1) 分類の穴。** 第5.1節は「(3) のガードは呼び出し元が DO であることに一切依存していない」を**全エントリについて成り立たせる**と宣言し、4群に分けて明示すると書いている。ところが表のクラス (3) は12行あり、(3-a) 5本 / (3-b) 2本 / (3-c) 2本 / (3-d) 2本 = 11本しか割り当てられていない。**割り当てられていない1本が最終行「ローテーションの起動と鍵の一時注入」である。** 第5.1節・第6.4節・第6.9節はいずれも「表に行を足したら分類にも足す」を更新規則として持っているので、これは意図した省略ではない。
    - **(2) 注入された鍵を bucket が検証できない。** ガード欄は「maintenance 経路そのものの到達制御 + 世代の CAS」だけである。bucket は `DIRECTORY_ROUTING_SECRET` を保持しない（第3.2節の非重複配布）ので、引数で渡された `{ generation, key, bucketCount }` が本物かどうかを判定する材料を持たない。世代番号も呼び出し元が名乗るだけの値である。
    - **(3) 帰結が、第5.1節 (3-b) が「正しく塞げている」と断定した攻撃者クラスに対して成立する。** そのクラスは「binding には到達できるが `SESSION_SECRET` を持たない呼び出し元」（同一アカウント内の別 script、誤配線された内部経路、将来 state Worker が別 Worker から呼ばれる構成）である。この攻撃者が任意の鍵 `k'` と任意の世代 `g'` で `rotate-remap` チャンクを駆動すると、第6.8節 手順2 の4段がそのまま走る。
      - 手順2 (1) の `record-credential-locator` は `callerToken` 束縛だが、**bucket が自分の mapping 行から読んだ値を運ぶ**ので攻撃者は知らなくてよい（`.thread/34/design.md:450`, `1087`）。したがって束縛は素通りする。
      - (2) で行は `dir:g':b{HMAC_k'(canonical) mod bucketCount'}` へ移送され、(3) で移送元が削除される。**移送先の bucket index は攻撃者が自分で計算できる。**
      - `lookup-credential`（第5.1節クラス (2)）は「無条件に応答」する設計で `passwordVerifier` / `userId` / `credentialId` を返す。したがって**被害者のメールアドレスを知っている攻撃者は、移送先 bucket に対して `HMAC_k'(victim@example.com)` を投げるだけでパスワード検証材料を取得できる。** 通常経路では正規鍵が無いと HMAC を作れないことがこの値を守っていたが、鍵注入がその前提を消す。`passwordVerifier` は第5.2節 (c) が非露出対象として名指ししている値である。
      - 同時に、移送元行が消えるので当該 bucket の全利用者が login も `request-password-reset` も解決不能になる（どちらも mapping 不在のダミー経路へ落ちる）。復旧は 256 bucket の PITR しか無く、**第6.9節の締め出し経路一覧にも載っていない**。
    - 結果として、第5.1節 (3-c) が `purge-user-mappings` を「本表で最も危険なエントリ」と位置づけた根拠（到達制御と監査だけが守る／破壊的）が、より重い（破壊 + 検証材料の窃取）このエントリには適用されていない。第11.3節の監査要件も `purge-user-mappings` にしか付いていない。**危険度の順位づけが設計内で自己矛盾している。**
  - 提案: 次の2点を第5.1節・第6.8節・第11.3節へ入れる。
    - **(a) 注入鍵を bucket 側で検証可能にする。** `rotate-remap` チャンクに **previous 世代の鍵も同時に注入させ、bucket が自分の行1件について `HMAC(key_prev, decrypt(encryptedCanonical)) == 行の hmac` を確認してから active 鍵を受け入れる**、を必須ガードにする。bucket は `encryptedCanonical` と `hmac` の両方を自分で持っているので**追加の秘密も新しい配布経路も要らず**、第3.2節の非重複配布を崩さない。previous 鍵を提示できるのは routing keyring を持つ request Worker だけなので、これが実質的な呼び出し元束縛になる。一致しなければ `rotate-remap` を拒否する。（`callerToken` は bucket 単位の操作なので流用できず、共有トークンを新設すると request / state 両方に同じ秘密が要って非重複が壊れるため、この形が唯一制約を破らない。）
    - **(b) 分類と危険度の記述を直す。** 当該行を (3-c) に明示的に加え、`purge-user-mappings` と同じ扱い（実行前承認・誰が・いつ・どの世代／bucket に対して実行したかの監査記録）を第11.3節へ送る。「最も危険なエントリ」の記述も、(a) を入れたうえで両者の関係を書き直す。あわせて第6.9節の締め出し経路一覧に「鍵注入による bucket 単位の恒久解決不能」の行を足す。

### Warnings

- **[W-001]** `cancel-reservation` が `status` を問わず `operationId` 一致だけで mapping 行を削除する一方、第5.2節 (c) は未認証経路のログに `operationId` を出してよいと宣言している。両者が同時に成立すると、完了済みアカウントの恒久ロックアウト原始関数になる
  - 場所: `.thread/34/design.md:456`（第5.1節 `cancel-reservation` のガード欄）／`.thread/34/design.md:501`（第5.2節 (c) の「ログに出してよいのは operation ID だけである」）／`.thread/34/design.md:914`（第6.4節 3-i が `status` 非依存にした理由）
  - 理由: `cancel-reservation` のガードは「行の `operationId` 一致。**`status` は `reserved` / `active` を問わない**」である。第6.4節 3-i が phase 3 の部分成功を回収するためにそう決めたのは正しいが、**signup 完走後の `active` な mapping 行も `operationId` を保持したままである**（第4.1.1節 `credential_mappings` の「saga コーディネーター状態」に `operationId` があり、昇格時に消す規定は無い。次に上書きされるのは credential 変更 saga の phase 1 のときだけである）。したがって束縛は `operationId` の知識1つに縮退する。
    ところが第5.2節 (c) は、未認証経路で `userId` / `credentialId` を出さない代わりに **`operationId` は出してよい**と明記している。signup は未認証経路なので、その `operationId` はログに残る前提になっている。**「binding には到達できるが `SESSION_SECRET` を持たない呼び出し元」＋ログ閲覧権限**という組み合わせで、任意の完了済みアカウントの mapping 行（メール / SSO の両方）を削除できる。削除後は login step 2〜3 も `request-password-reset` も mapping 不在のダミー経路へ落ち、`sweep-orphan-mapping`（逆向き専用）・`finalize-withdrawal`（`deleting` 前提）・`sweep-reservations`（`reserved` のみ）のいずれの回収対象でもない。**利用者側に自己回復手段が無く、第6.9節の一覧にも載っていない。** さらにその canonical は再登録可能になるので、攻撃者が被害者のメールアドレスでアカウントを取り直せる。
    第5.1節 (3-a) の正当化文（「存在しない saga を前進させることも、記録されていない `operationId` で phase を飛ばすこともできない」）は**前進**についての主張であり、この破壊的な補償には当てはまらない。
  - 提案: どちらか一方で足りる。**(a)** `cancel-reservation` の削除対象を「その `operationId` の saga が終端していない行」に限る — 具体的には `sagaCommitted` 印と `operations.phase` を条件に含め、phase 4 まで完了した signup の行には触れない（第6.4節 3-i が回収したいのは phase 3 の途中で昇格した行だけなので、この制限で目的は満たせる）。**(b)** phase 4（`operations.phase = 'done'`）で mapping 行の `operationId` を `NULL` にし、以後 `operationId` 一致で引けなくする。いずれの場合も、第5.2節 (c) の「`operationId` はログに出してよい」を維持するなら「`operationId` は capability ではない」ことが本文で成立している必要があるので、その1文も足す。

- **[W-002]** SSO 専用アカウントに対して `request-password-reset` が実際にメールを送るのかどうかが決まっていない。読み方によって「メール到達性だけで SSO 専用アカウントにパスワードを設定できる」経路が開く／開かないが分かれる
  - 場所: `.thread/34/design.md:1383-1392`（第7.6節 ダミージョブ行の規則）／`.thread/34/design.md:942`（第6.5.1節 phase 2 の `usableForLogin` 更新）／`.thread/34/design.md:1883`（第11.1節 `requestPasswordReset.md` への指示）／現行 spec は `spec/usecases/identity.md:178`, `:196`, `:206` と `spec/testcases/identity/requestPasswordReset.md` が **SSO ユーザーにはトークンを発行せずメールも送らない**と明記している
  - 理由: 第7.6節の規則は「mapping が**無い**場合の行は宛先を持たないため何も送らずに `done` へ落ちる」である。ところが SSO signup は**メール canonical にも mapping 行を置き、`encryptedCanonical` を持つ**（第6.3節・第6.2.1節 (a)）。したがって規則を字義どおり読むと SSO 専用アカウントには**宛先がある**＝メールが送られ、`consume-reset-token` → `begin-credential-change`（起点 B）→ phase 2 が走る。第6.5.1節 phase 2 は「`usableForLogin` を Directory 側が判定した値へ更新する（`pendingVerifier` を持つ以上は真になる）」と書いているので、**一意性の予約として置かれただけの行がログイン手段へ昇格する**。
    帰結は、SSO 専用アカウントの奪取に必要な条件が「IdP の認証」から「メールボックスの到達性」へ下がることである。第5.2.1節 (a) は signup にメール所有確認が無いことを明記し「所有の唯一の証明はパスワードリセット経路である」と断定しているが、それはパスワードアカウントについての受容判断であって、**IdP 認証で守られていた SSO 専用アカウントまで同じ水準に落とす判断は本書のどこにも記録されていない**（第6.9節にも第11.3節の残余リスクにも無い）。
    逆に「SSO 専用は宛先を持たない行を書く」（現行 spec 維持）と読むと、第6.5.1節 phase 2 の `usableForLogin` false→true の遷移を起こせる経路が本設計に1つも無くなり（起点 A は `usableForLogin = true` を要求し、メールクレデンシャルを追加するフローも存在しない — 第6.6節）、SSO 専用利用者は恒久的にパスワードを持てない。**どちらの読み方も内部的には整合するので、#37 は明示的な指示なしにどちらかへ倒す。** 第11.1節の指示（「登録済み / 未登録 / SSO のみ / スロットル中の4ケースで処理経路が完全に一致する。違うのは行の中身だけ」）は、この分岐点をそのまま曖昧にして #35 へ送っている。
  - 提案: 第7.6節（または第6.2.1節 (c)）に「SSO 専用アカウント（`passwordVerifier` を持たない `kind = 'email'` 行）へリセットメールを送るか」を**明示的な決定として1行で書く**。送る側に倒すなら、(i) それが SSO 専用アカウントの奪取条件を IdP 認証からメール到達性へ下げる判断であることを第11.3節の残余リスクへ送り、(ii) 第5.3節 SSO 経路 1 の検証項目に `email_verified` を足すかを併せて決める（IdP の主張したメールがそのまま復旧経路の宛先になるため）。送らない側に倒すなら、`usableForLogin` の false→true 遷移が本設計に存在しないことを第6.5.1節 phase 2 の当該記述と揃える。いずれにせよ第11.1節の `requestPasswordReset.md` への指示に「SSO のみの行の中身がどちらか」を明記する。

### Notes

- **[N-001]** 引用している実装事実は**全件が実物と一致している**。照合したのは次のとおり — `currentUser.ts:17-26` の `getCurrentUserId` が `sessionCodec.verify` の戻り値だけで `userId` を確定すること、同 `:28-33` の JSDoc が `requireUserId()` を "The authoritative guard" と宣言していること、`authState.ts:18-23` の `readAuthStateFn` が `getCurrentUserId()` の結果だけを返すこと、`hmacSessionCodec.ts` のペイロードが `{ uid, exp }` で `parsePayload` が `uid` / `exp` の存在しか見ないこと、`sessionCodec.ts` が `issue(userId, now)` / `verify(token, now)` で epoch を運ぶ口を持たないこと、`secrets.ts` の3保証（`MIN_SESSION_SECRET_LENGTH = 32` / ブランド型 `SessionSecret` + `requireSessionSecret` / `RequestSecrets` の入れ子配置と rest-spread への言及）、`valueObject.ts:45-62` の `Email.create` と `:47` の `trim().toLowerCase()` / `EMAIL_MAX_LENGTH = 320` / `EMAIL_PATTERN`、`AiClientConnectionId`（`:125`）と `ClientName`（`:142`）だけが実装済みで `AiClientConnection` 型が存在しないこと、`0000_initial.sql:46,47` の `users_email_uq` / `users_sso_identity_uq`、`findBySsoIdentity` がリポジトリ全体に1件も存在しないこと、`DEFAULT_PBKDF2_ITERATIONS = 210_000`、`SystemErrorCode` が6値で `ServiceOverloaded` / `StorageCapacityExceeded` を持たないこと、`errorResponse.ts:70` の `serializeError` と `:101` の `HTTP_STATUS_BY_KIND` が `kind` 単位であること、`unitOfWork.ts:14` の `collectEvents`。**事実の誤りは1件も見つからなかった。**

- **[N-002]** 第6.1.2節の `credentialId`（世代非依存の credential 同一性）の導入は、ローテーション中に散在していた5つの破れ（(R3) 削除対象の取りこぼし / (R4) 自己ロックアウト / (R8) 恒久ログイン不能 / 冪等キーの no-op 化による到達性検査の全滅 / AAD の `hmac` 束縛による復号不能）を**単一の根本原因に還元して一括で閉じている**。とくに (R8) と (R9) を「片方だけ直すと失敗モードが恒久ロックアウトと旧パスワード復活で入れ替わるだけ」として対で導入している点は、片側だけの修正で満足しない書き方になっている。

- **[N-003]** 第10.1節の PITR は、**認可を閉じる向きだけでなく開く向きまで**列挙できている。`sessionEpoch` の巻き戻し（失効済みセッションの復活）、`ai_client_connections.status` の巻き戻し（Directory を1度も参照しない経路なので mapping ゲートでは塞げない）、`password_reset_tokens` の復活（`credentialVersion` 照合を**回避せず前進させて**解消するため fail closed にならない）の3つを別々の穴として扱い、それぞれに「復旧できないなら全部切る」型の必須ステップを付けている。第6.9節の fail-closed 宣言に射程（本設計が作る中間状態に限る）を明記して反例を消した処理も整合している。

- **[N-004]** 第5.1節の `report-login-result` について「step 3 で自分が返した行であることは要求しない」を**実装不能な述語だから**として明示的に切り、そのうえで悪用可能な差が無いこと（成功報告は request Worker の照合結果に従属し、失敗報告は正規の login 失敗と等価で、第6.2.2節 (a) の天井・減衰・非加算が効く）を示している。ガードを弱める判断に理由と代替の守りが付いている良い例である。

- **[N-005]** 第6.2.2節 (a) のロックアウト機構が「標的型 DoS への転用」を自ら脅威として立て、天井・時間減衰・ロックアウト中の非加算の3点を**設計の制約として固定**（具体値だけを #38 へ送る）したうえで、脱出経路 (i)（リセット完走時の `failedAttempts` リセット）が第6.1.1節 (R6) に依存していることまで明記している。可用性側の破れを認可側と同じ厳しさで扱えている。
