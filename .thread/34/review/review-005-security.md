# レビュー 005 — セキュリティ

対象: PR #43 / Issue #34 / `.thread/34/design.md`（1,975行、全文読了）
照合した実装: `apps/web/app/presentation/{currentUser,authState,errorResponse}.ts`、`packages/core/src/application/di/{secrets,types}.ts`、`packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`、`packages/core/src/application/ports/sessionCodec.ts`、`packages/core/src/domain/identity/{valueObject.ts,ports/userRepository.ts}`、`packages/core/src/application/errors.ts`、`packages/core/src/adapters/d1/migrations/0000_initial.sql`、`apps/web/app/routes/_app.tsx`

ゼロベースで読んだ。前回の指摘の有無は前提にしていない。

## セキュリティ

### Blockers

なし。

`credentialId` 導入（第6.1.2節）の検証結果は N-001 / N-002 に書いた。**穴は塞がっており、導入によって新しい認可の穴は開いていない。**

### Warnings

- **[W-001]** リセットトークンの `tokenId` にエントロピー要件が無く、`IDENTITY_RESET_TOKEN_KEY` 単独の漏えいで任意アカウントのリセットトークンを偽造できる
  - 場所: `.thread/34/design.md:689`（第6.1節 (d)「生のリセットトークンを DB にもジョブ行にも置かない」）、同 `:254`（第4.1.1節 `password_reset_tokens` の列定義）、同 `:165`（第3.2節の鍵表）
  - 理由: トークンの秘匿部は `{random} = HMAC(IDENTITY_RESET_TOKEN_KEY[tokenKeyGeneration], tokenId)` の1点に集約されており、トークン全体の推測困難性が **`tokenId` の推測困難性と鍵の秘匿の積**になっている。ところが `tokenId` の定義は本書全体で「bucket 内で採番する不透明値」（`:254` / `:689`）だけで、**長さもエントロピーも要求されていない**。本書は `callerToken`（`:471`「128ビットの不透明値」）と `credentialId`（`:725`「128ビットの不透明値」）については採番規則をビット数まで固定しているので、この1つだけが抜けている。`tokenId` を bucket 内の連番・rowid・単調カウンタで実装するのは「bucket 内で採番する不透明値」の文言に反しないが、その実装だと **鍵だけが漏れた場合に、`{generation}`（keyring の小さな集合）× `{bucketIndex}`（0..255）× `{tokenId}`（連番）を全列挙してその時点で未使用・未期限の全リセットトークンを再現できる**。第5.5節 3 / 第6.1節 (d) の範囲検査はこの列挙を止めない（正しい範囲の値を投げるため）。
  - 設計自身の主張との非対称: `:692` は「導出鍵は DB に一切載らないので、**DB 漏えいだけでは `tokenId` からトークンを再現できない**」と片方向だけを保証している。逆方向（鍵漏えい単独）は本書のどこにも評価が無い。生トークンのハッシュを保存する素朴な設計では鍵が存在しないので、この方向のリスクは**導出方式の採用によって新設されたもの**である。第5.2.1節 (a) が「所有の唯一の証明はパスワードリセット経路であり、リセットトークンの安全性がアカウント所有の安全性の上限になる」と宣言している以上、上限側の前提は明示的に固定すべきである。
  - 提案: 第6.1節 (d) と第4.1.1節の `password_reset_tokens` 行に **「`tokenId` は暗号論的乱数由来の128ビット以上の値であり、bucket 内の連番・rowid・時刻由来の値を使わない」** を制約として書く（`callerToken` / `credentialId` と同じ書き方でよい）。あわせて `:692` の一文を「DB 漏えい単独でも鍵漏えい単独でもトークンを再現できない（前者は鍵が無く、後者は `tokenId` が推測できないため）」へ直し、2方向とも成立していることを明示する。

- **[W-002]** Identity Directory bucket の PITR restore が消費済み／削除済みのリセットトークン行を復活させ、乗っ取り復旧を認可が開く方向へ巻き戻す。restore 後の必須ステップが定義されていない
  - 場所: `.thread/34/design.md:1635`（第10.1節「saga の中間状態は restore で復活しうる」）、同 `:1627-1634`（User Data DO 側の必須ステップ2点）、同 `:1015-1019`（第6.7節の PITR に関する3結論）
  - 理由: 第10.1節は PITR の穴を2つ挙げ、どちらにも User Data DO restore 直後の**必須ステップ**を割り当てている（`sessionEpoch` を十分大きな単調値へ / `ai_client_connections` を全件 `revoked` へ）。しかし Directory bucket 側の restore については第6.7節 `:1018-1019` が「承認手続きの対象にする」「アカウント1件の復旧手段としては使えない」と述べるだけで、**restore 後に何をしなければならないかが1つも定義されていない**。`:1635` が列挙する復活物も `reserved` 行と `operations` 行だけで、`password_reset_tokens` 行が入っていない。
  - 具体的な経路（fail closed に倒れない唯一の向き）: 乗っ取り被害者がリセットで攻撃者を締め出した後に bucket を T0 へ restore すると、(a) `credential_mappings` の `passwordVerifier` / `credentialVersion` が n へ巻き戻り、(b) 攻撃者が保持していたリセットトークン行が `usedAt = null` で復活する（第6.5.1節 phase 1 の未使用トークン一括削除も、`consume-reset-token` の使い捨て記録も、どちらも巻き戻る）。(a) 単独なら第5.3節 step 5 (iii) の `credentialVersion` 照合が User Data 側の n+1 と不一致になって **fail closed** で止まる（`:1631` が述べているのはこの向き）。ところが (b) の経路は照合を回避せずに**前進させて解消する** — `consume-reset-token` → `begin-credential-change`（起点 B の束縛 `consumedByOperationId` も復活済みの行で満たされる）→ phase 2 が `sessionEpoch` と `credentialVersion` を n+2 へ進める → phase 3 で攻撃者の `pendingVerifier` が昇格する。**終状態は攻撃者のパスワードで正規にログインできるアカウント**であり、第6.9節の「どの中間状態でも認証・認可は fail closed 側に倒れる」に対する反例になる。トークン TTL が時間オーダー（第6.1節 (d)）なので成立するのは「直近数時間へ戻す restore」に限られるが、それは PITR の典型的な使い方そのものである。
  - 提案: 第10.1節に3つ目の PITR 穴として1項を立て、**Directory bucket restore 直後の必須ステップ**を書く — (1) restore した bucket の `password_reset_tokens` を全行削除する（消費済み・未消費を問わない。誰のトークンが有効だったかは restore 後には読めないので「復旧できないなら全部切る」を既定手順にする。`:1633` の AI 接続と同じ判断）、(2) `credential_mappings.failedAttempts` / `nextAttemptAllowedAt` も巻き戻るので、`:1629` と同じく「restore 前の値を知らなくても安全側になる形」で扱いを決める。あわせて `:1635` の復活物の列挙に `password_reset_tokens` を加え、第6.7節 `:1015` の「PITR 保持期間の外側では成立しない」の帰結が**消去の不可逆性だけでなく認可の再開**にも及ぶことを明記する。#38 への引き継ぎ（第11.3節の PITR の項）にも行を足す。

### Notes

- **[N-001]** `credentialId` の導入は目的を達成している。`hmac` が世代依存であることに起因していた4つの破れ — (R3) 削除対象の選択、(R4) ログイン手段の数え上げ、(R8) `credentialVersion` の全世代更新、`record-credential-locator` の冪等キー — がすべて世代非依存のキーで書き直され、第5.3節 step 5 (ii) の到達性検査からは「世代を照合条件に含めるか」という問い自体が消えている（`:579` / `:1050`）。`credential_locators` の一意性 `(credentialId, generation)` と `(kind, hmac, generation)` の二重 UNIQUE（`:244`）が「同じ canonical が2つの `credentialId` を持たない」を保証しているので、`credentialId` → canonical の写像が世代内で一意に定まり、`credentialId` だけを見る照合が緩まない。`credential_mappings` 側で `credentialId` 単独を一意にせず `(credentialId, generation)` に UNIQUE を張った判断（`:253` / `:731`）も、bucket index 衝突で同一 credential の2世代が同居しうるという自分の設計と整合している。

- **[N-002]** `credentialId` 導入で新たに開く入力面は無い。確認した結果は次のとおり。
  - **外部入力から供給できるのは unlink の1箇所だけ**（`:735` (C5) / `:987` 手順1）。ただし対象 DO は session の `userId` で選ばれ、`credential_locators` にはそのユーザーの行しか存在しないので、他ユーザーの `credentialId` を指定しても0行にマッチするだけで済む。第6.6節 手順1 の「残り0件なら拒否」も、存在しない `credentialId` を渡した場合は残数が減らないので通過するが、帰結は手順2 の `sessionEpoch` 前進（＝自分をログアウトさせるだけ）に留まる。
  - **推測しても何も得られない。** `delete-mapping` / `read-own-canonical` / `lookup-credential-by-locator` はいずれも対象行の `callerToken` との定数時間比較を通る（`:454` / `:455` / `:444`）ので、被害者の `credentialId` を知っていても被害者の `callerToken` が無ければ復号もロックアウトもできない。
  - **書き側の非対称が解消されている。** (3-d)（`:475`）が `begin-credential-change` / `advance-credential-change` / ローテーション経路の `record-credential-locator` を `callerToken` で束縛したことで、「同じ locator に対する読みは束縛するのに、より強い書きは無束縛」という自己矛盾が消えている。とくにローテーション経路の `record-credential-locator` に `operations` 行を要求せず `callerToken` を束縛の実体に決め切った判断は、「要求すると動かない／新規作成すると無束縛になる」の二択を正しく避けている。
  - **`callerToken` の限界が正直に書かれている。** `:474` が「request Worker のコード実行を得た攻撃者に対しては防壁にならない」「1層目が破られた時点で `callerToken` も同時に破られる」と初版の脅威モデルの誤りを明示的に撤回している。`purge-user-mappings`（`:459` / `:1023`）を「本表で最も危険なエントリ」と名指しし、`callerToken` を要求できない構造的理由まで書いているのも同様。

- **[N-003]** `read-own-canonical` の引数に `credentialId`（または `kind`）が含まれるかが、第5.1節の表（`:454`）にも第6.2.1節 (c) 4（`:794-797`）にも書かれていない。ガードは「`callerToken` の定数時間比較 + `credential_mappings.userId` が引数の `userId` と一致する行に限る」だけで、選択キーが `userId` のみだと**同じ bucket に同じ `userId` の行が複数ある場合**（SSO signup がメール credential と SSO credential の両方を置き、bucket index が衝突した場合、およびローテーション中の2世代並存）にどの行を復号するかが決まらない。認可は `callerToken` + `userId` で閉じているので**穴ではない**が、返る値が「自分のメールアドレス」ではなく「自分の SSO canonical（`provider + U+0000 + subject`）」になりうるため、#37 が実装を決められない。第5.1節の表のガード欄に選択キー（`(credentialId, generation)` か `kind = 'email'` か）を1語足しておくと閉じる。

- **[N-004]** `exchange-authz-code`（`:448` / `:643-649`）のガード列挙に `redirect_uri` の一致検証が無い。OAuth 2.1 では PKCE が必須なので code interception 自体は塞がれており、認可エンドポイント側の完全一致検証は #13 の領分と読めるが、第5.4.1節が当該エントリのガードを「代わりに『署名検証 + `typ` 厳密一致 + `exp` + `jti` の一回性 CAS + PKCE の定数時間比較 + `account.status = 'active'`』が守る」と**完結した集合として**宣言しているので、#13 側で扱う旨の1行があると引き継ぎが切れない。

- **[N-005]** 引用している実装事実は**全件が実物と一致した**。照合したのは次の12件。
  - `currentUser.ts:17-26` の `getCurrentUserId`（`sessionCodec.verify` の戻り値だけで `userId` を確定し DB を触らない）と `:28-33` の JSDoc「The authoritative guard」— 一致。第5.1節 `:478` の指摘（epoch ガードの外側にある）は実装のとおりである。
  - `authState.ts:18-23` の `readAuthStateFn` が `getCurrentUserId()` の結果だけで `{ authenticated }` を返し、`routes/_app.tsx:16-17` の `beforeLoad` から全保護ルートで走る — 一致。
  - `secrets.ts` の3点保証（`MIN_SESSION_SECRET_LENGTH = 32` の下限、ブランド型 `SessionSecret` + `requireSessionSecret`、`RequestSecrets` の入れ子と rest-spread の JSDoc）— 一致。定数の定義元は `hmacSessionCodec.ts:21` で、`secrets.ts:5` が import している（本文の「`secrets.ts` は ... の下限チェック」は定義元ではなく検査点を指す記述として正しい）。
  - `hmacSessionCodec.ts:28,30-42` の `Payload = { uid, exp }` と `parsePayload` が `uid` / `exp` の存在しか見ない — 一致。第5.4節 `:607` の token confusion の論拠は成立する。
  - `ports/sessionCodec.ts:22-23` の `issue(userId, now)` / `verify(token, now)` に epoch を運ぶ口が無い — 一致。
  - `valueObject.ts:5,43,45-61` の `EMAIL_MAX_LENGTH = 320` / `EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/` / `trim().toLowerCase()` — 一致。`:111` の `SsoProvider = "google" | "apple"`、`:125` の `AiClientConnectionId`、`:142` の `ClientName` も一致（`AiClientConnection` 型は存在しない）。
  - `ports/userRepository.ts:39-42` が `insert` / `save` / `findById` / `findByEmail` の4本のみ。`findBySsoIdentity` は `packages/core/` にも `apps/web/` にも0件 — 一致（第2.3節の断定どおり）。
  - `0000_initial.sql:46-47` の `users_email_uq` / `users_sso_identity_uq`（部分ユニーク）— 一致。実テーブルは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つで、`password_reset_tokens` / `search_fts` / `search_embeddings` は不在 — 一致。
  - `application/errors.ts:187-202` の `SystemErrorCode` は6値（`DatabaseError` / `DataIntegrityError` / `CryptoError` / `SessionError` / `NetworkError` / `ExternalApiError`）で、`ServiceOverloaded` / `StorageCapacityExceeded` は不在。`RETRYABLE_SYSTEM_CODES` は `NetworkError` / `ExternalApiError` の2値 — 一致。
  - `errorResponse.ts:70` の `serializeError`、`:101` の `HTTP_STATUS_BY_KIND`（`kind` だけを見て `code` を見ない）— 一致。
  - `di/types.ts:53` の `RequestContainer` / `:70` の `WorkerContainer`（indexer / pruner 専用の拡張は不在）— 一致。
  - 行数の引用: `worker/cloudflare/handlers.ts` 138行 / `eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 / `wrangler.toml` 162行 / `routes/password-reset.tsx` 25行（プレースホルダー）— すべて一致。

- **[N-006]** テナント分離・DO 間 RPC の信頼境界・移送中の穴について、追加で確認して問題が無かった点を記録しておく。
  - 第5.5節 1 の3経路（署名済みトークンの検証結果 / signup の候補 `userId` / Directory の RPC 戻り値）に加え、DO 側の locator が「自分の SQLite に永続化済みの値」に限られる但し書き（`:661`）が入っており、`credentialId` はどの経路でも `idFromName` の材料にならない。
  - 移送窓（第6.8節 手順2 の (2)〜(3)）で active bucket に旧 `passwordVerifier` の複製が一時的に生じる経路を追ったが、`credential_locators` 側が (R8) で全世代同時に `credentialVersion` を進めるため、旧パスワードでの login は第5.3節 step 5 (iii) で必ず不一致になり fail closed に倒れる。phase 2 到達前の極小窓で発行されうるセッションも、直後の phase 2 が `sessionEpoch` を進めるため次のリクエストで epoch ガードに落ちる。
  - 一意性登録の2段規則（`check-previous-generation` → active 予約）は、移送順序が「新世代へ書いてから旧世代を消す」なので**両世代とも不在になる窓が構造的に存在しない**。退役条件（`status` を問わない `previousCount = 0`）がスキップ行（`pending` / `reserved`）の消化を自動的に要求するので、`check-previous-generation` を省ける条件も正しく閉じている。
  - `consume-reset-token` の「同 bucket に `credentialId` 一致の mapping 行が存在すること」は、bucket index 衝突で2世代が同居した場合に世代までは絞れないが、その場合に起きるのは phase 1 の空振り（＝リセットのやり直し）だけで、認可が開く向きには倒れない。
