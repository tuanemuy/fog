# レビュー 007 — セキュリティ

対象: PR #43 / Issue #34 / `.thread/34/design.md`（2,270行）
方針: ゼロベース。実際に悪用できる穴と設計の自己矛盾だけを報告する。引用実装はすべて実ファイルで照合した。

## セキュリティ

### Blockers

なし。

テナント分離（`idFromName` の材料が3経路に閉じる / DO 内に他ユーザーの行が存在しない / 書き込み側の `initialize-account` 条件付きガード）、DO 間 RPC のクラス分け (1)(2)(3-a〜d) と `callerToken` 束縛、`credentialId` による世代非依存の同一性、`sessionEpoch` / `credentialVersion` の二重失効、saga の部分失敗の回収経路、PITR の3つの穴（`sessionEpoch` / AI 接続 / リセットトークン）は、いずれも本ラウンドで新たな悪用経路を見つけられなかった。

### Warnings

- **[W-001]** `rotate-remap` の「previous 世代の鍵の所持証明」は、鍵漏えいを動機とするローテーションでは成立しない。設計はこれを呼び出し元束縛として扱っているが、その前提が最も重要な場面で偽になる
  - 場所: `.thread/34/design.md:596`（第5.1節 クラス (3) の `rotate-remap` 行）/ `:627`（第5.1節 (3-c)）/ `:699`（第5.2.3節）/ `:1297`（第6.9節の締め出し経路表）
  - 理由: ガードは (i) 自 DO 名の `gen` == 引数の previous 世代、(ii) `activeGeneration > gen`、(iii) 自 bucket の1行について `HMAC(previousKey, decrypt(encryptedCanonical)) == 行の hmac` の3つで、**証明を要求しているのは previous 世代の鍵の所持だけ**である。設計はこれを「previous 鍵を提示できるのは routing keyring を持つ request Worker だけなので、これが実質的な呼び出し元束縛になる」（`:627`）と正当化している。
    ところが **routing 鍵をローテーションする第一の動機は「その鍵が漏えいしたこと」**である（同じ文書が `IDENTITY_MAIL_ENCRYPTION_KEY` について「『鍵が漏洩したら再暗号化できない』という状態にはしない」と第6.2.1節 (b-1) で明言している）。漏えい鍵 `k1` を active から previous へ降格させてローテーションしている最中、`k1` を持つ攻撃者は (i)(ii)(iii) をすべて満たせる — (iii) の照合相手は `k1` で作られた previous 世代 bucket の行そのものだからである。したがって攻撃者は任意の `activeKey` / `activeGeneration` / `activeBucketCount` を注入して第6.8節 手順2 の4段を走らせられる。
    帰結は設計が `:626` / `:1297` で自ら特定している内容と同一である。加えて、**正規のローテーションが持つ「移送が完了した行は攻撃者の手が届かなくなる」という remediation 効果が失われる**点が、この経路に固有の追加被害である。攻撃者が `activeKey = k1` を注入して先に bucket を駆動すると、行は `dir:g2:b{HMAC_k1(canonical) mod bucketCount'}` へ、`hmac = HMAC_k1(canonical)` として着地する。以後その行は (a) 攻撃者からは恒久的に `lookup-credential`（クラス (2)、無条件応答、`passwordVerifier` を返す）で読め、(b) 正規経路（active 鍵 `k2` で locator を導出する）からは永久に見つからない。**つまり漏えい鍵の失効手段そのものが、漏えい鍵の保持者によって無効化される。**
    前提条件は「state Worker への binding 到達性」で、これは (3-c) 群が依拠している境界そのものである。そのため純粋な incremental exploit としては `purge-user-mappings`（同じ到達性だけで守られている）と同格だが、**問題は残余リスクの大きさではなく、`:627` と `:699` が置いている正当化の文が誤っていること**である。この文があると #37 / #38 は「`rotate-remap` は所持証明で束縛済み」と読み、`purge-user-mappings` と同格の運用ガード（`:629` / `:2241`）を弱めても構わないと判断しうる。
  - 提案: 所持証明を撤去する必要はない（定期・衛生目的のローテーションに対しては有効である）。次の2点を明記する。
    - (1) 第5.2.3節・第5.1節 (3-c) の正当化を「**previous 世代の鍵が未漏えいであるあいだに限り**呼び出し元束縛として機能する」と限定し、**漏えいを動機とするローテーションでは所持証明はガードとして数えない**と書く。bucket 側で `activeKey` の真正性を検証できる材料は存在しない（`encryptedCanonical` と `hmac` はどちらも previous 世代の鍵に対する材料である）ので、この場合の唯一の守りは maintenance 経路の到達制御と監査である、と (3-c) の `purge-user-mappings` と同じ書き方に揃える。
    - (2) 第11.3節（#38）へ「**routing 鍵の漏えいを契機とするローテーションでは、鍵の世代を進めるより先に maintenance 経路の到達性（binding 構成 / デプロイ資格情報）を再発行する**」を運用要件として送る。第6.9節の該当行（`:1297`）の「塞ぎ方」欄も、所持証明だけを解として書かない形に直す。

- **[W-002]** パスワードリセット完了時の AI クライアント接続の自動失効（`createdAtCredentialVersion` による1世代分の失効）は、最も典型的な乗っ取りの手順で発火しない
  - 場所: `.thread/34/design.md:780`（第5.4節 (i)）/ `:369`（第4.1.1節 `ai_client_connections` の `createdAtCredentialVersion`）/ `:1104`（第6.5.1節 phase 2）
  - 理由: 規則は「パスワードリセット完了に限り、`createdAtCredentialVersion` が**前進前の現在値**と等しい接続を `revoked` にする」であり、設計はこれを「攻撃者が持ち込んだ分だけを切れる」（`:782`）と評価している。
    ところが乗っ取りの典型手順は「パスワードを握る → AI 接続を作る → **パスワードを自分のものへ変更して正規利用者を締め出す**」である。この順序では、接続の `createdAtCredentialVersion = n`、攻撃者による変更で `credentialVersion` が `n+1` へ進み、被害者のリセット時点の「前進前の現在値」は `n+1` になる。**`n+1` で作られた接続は存在しないので、失効対象は0件になり、攻撃者の接続（`n`）はそのまま生き残る。**
    攻撃者が能動的に変更しなくても同じことが起きる — 侵害からリセットまでのあいだに正規利用者自身が1回パスワード変更を行えば（「なんとなく変えておいた」で足りる）、同じく失効対象は0件になる。
    設計は (i) の射程を「1世代分」と自ら書いている（`:782`）ので**規則の記述としては矛盾していない**が、**「侵害復旧として不完全では困るので構造的な補償を1つ設計側で決める」（`:778`）という導入の目的に対して、その補償が最頻の攻撃系列でちょうど空振りする**。結果として実効的な守りは (ii) のリセット完了画面の導線（`:783`、#35 へ委譲）だけになり、「構造的な補償」は名前だけになる。
  - 提案: 失効の基準を credential 変更カウンタから切り離す。最小の変更は `account`（または `credential_locators`）に**リセット完了だけで進む単調カウンタ**（例 `resetVersion`）を1つ持ち、`ai_client_connections` には `createdAtResetVersion` を記録して、リセット完了時に「`createdAtResetVersion` が前進前の値**以上**」ではなく「**前回のリセット以降に作られた接続**」を失効させる形にすること。これなら「長く使っている接続は生き残る」（`:782`）という受容判断を保ったまま、途中のパスワード変更で射程が消えなくなる。第5.4節の表と第6.5.1節 phase 2 の記述、第4.1.1節の列の全数を同時に直す（第1.4節 I-4）。
    (i) を1世代分のまま残すのであれば、`:782` の「攻撃者が持ち込んだ分だけを切れる」という評価文を撤回し、**「侵害と復旧のあいだに credential 変更が1回でも挟まると (i) は空振りする。実効的な補償は (ii) の画面導線だけである」**と明記して、#35 側の (ii) を「必須導線」より強い扱い（既定でチェック済みの一括失効など）へ格上げする。

### Notes

- **[N-001]** 本文が引用している実装の事実は、確認した範囲ですべて実物と一致していた。
  - `apps/web/app/presentation/currentUser.ts:17-26`（`getCurrentUserId` が `sessionCodec.verify` だけで確定）/ `:28-33`（JSDoc が `requireUserId()` を "The authoritative guard" と宣言）
  - `apps/web/app/presentation/authState.ts:18-23`（`readAuthStateFn` が `getCurrentUserId()` の結果だけを返す）と `apps/web/app/routes/_app.tsx:16-18` の `beforeLoad`
  - `packages/core/src/application/di/secrets.ts`（`MIN_SESSION_SECRET_LENGTH = 32` の下限 / ブランド型 `SessionSecret` + `requireSessionSecret` / `RequestSecrets` の入れ子とその JSDoc の根拠）
  - `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts:28,38-41`（ペイロードは `{ uid, exp }` のみ、`parsePayload` は `uid` / `exp` の存在しか見ない → 第5.4節の `typ` 必須化の論拠は成立する）、`packages/core/src/application/ports/sessionCodec.ts:22-23`（epoch を運ぶ口が無い）
  - `packages/core/src/domain/identity/valueObject.ts:47`（`trim().toLowerCase()`）/ `:5`（`EMAIL_MAX_LENGTH = 320`）/ `:43`（`EMAIL_PATTERN`）/ `:111`（`SsoProvider = "google" | "apple"`）/ `:125`（`AiClientConnectionId`）/ `:142`（`ClientName`）。`AiClientConnection` という型名は存在しない
  - `packages/core/src/domain/identity/ports/userRepository.ts:38-43`（`insert` / `save` / `findById` / `findByEmail` の4本のみ）。`findBySsoIdentity` はリポジトリ全体で0件
  - `packages/core/src/adapters/d1/migrations/0000_initial.sql`（実テーブルは `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つ、`users_email_uq:46` / `users_sso_identity_uq:47`）
  - `packages/core/src/application/errors.ts:187-210`（`SystemErrorCode` は6値、`RETRYABLE_SYSTEM_CODES` は `NetworkError` / `ExternalApiError` の2つ）、`apps/web/app/presentation/errorResponse.ts:70`（`serializeError`）/ `:101`（`HTTP_STATUS_BY_KIND`）
  - `packages/core/src/application/di/types.ts:53,70`、`workers/eventRelayWorker.ts` 301行 / `outboxPrune.ts` 25行 / `apps/web/app/worker/cloudflare/handlers.ts` 138行、`apps/web/wrangler.toml` 162行（DO バインディングは実在しない）、`.thread/1/adr.md:112` の PBKDF2 210,000

- **[N-002]** `begin-credential-change`（起点 B）の束縛は `consumedByOperationId` + `credentialId` の一致だけなので、**binding 到達性を持つ主体**が消費済みトークン行の TTL 内に同じ `operationId` で再発行すると、`changeState = 'pending'` を再度立てられる。悪用は「認可が開く」方向には進まない（`advance-credential-change` は `operations` 行の `payloadDigest` 不一致で `ConflictError` になり、乗っ取りは成立しない）し、被害者はリセットをやり直せば第6.5.1節の後勝ち規則で脱出できるので、**恒久ロックアウトにもならない**。同じ到達性で `purge-user-mappings` がより強い破壊を持つ（第5.1節 (3-c) が受容済み）ため、独立した指摘としては挙げない。ただし第5.1節 (3-a) の「`operationId` は capability ではない ... その前提を破っていた唯一のエントリが `cancel-reservation` だった」（`:617`）は、厳密には「`operationId` **単独**では」の限定つきで読む必要がある — このエントリは `operationId` + `credentialId`（第6.1.2節 (C5) により設定画面へ露出し、認証済み経路のログにも出しうる値）の組で束縛が閉じる。#37 が (3-a) の一括正当化を実装の根拠にしないよう、限定を明記しておくとよい。

- **[N-003]** signup saga（第6.3節）に **`passwordVerifier` を書き込む phase が明示されていない**。phase 1a / 1b の予約行の内容は `{ operationId, credentialId, candidateUserId, callerToken, locators[], reservedUntil }`、phase 3 は `status` の昇格、phase 4 は User Data DO 側の reverse locator 記録であり、`credential_mappings.passwordVerifier`（第4.1.1節 `:377` に列としては存在し、phase 4 の `usableForLogin` 判定（`:1010`）と第7.6節の送信判定（`:1575`）がその有無に依存している）の初回書き込み点がどこにも無い。
  セキュリティ上の帰結は現時点では見当たらない（どの phase に置いても検証材料は未認証 signup 入力に由来せざるを得ず、`reserved` 行の verifier で他人のアカウントへログインする経路は login step 5 (ii) の到達性検査 — reverse locator は phase 4 まで書かれない — が塞ぐ）。ただし第4.1.1節が「列の全数の正本」、第5.1節が「クラス (2)(3) の全数」を宣言している文書で、**認証材料の唯一の書き込み点が全数表のどこからも辿れない**のは #37 が最初に手を止める箇所になる。phase 1a / 1b の予約行の内容に `passwordVerifier` を加えるか、「phase 3 の昇格時に載せる」と1行決め切ることを勧める。

- **[N-004]** `exchange-authz-code`（第5.4.1節）のガード列挙に `sessionEpoch` 照合が無い。`/authorize` から token 交換までの分オーダーの窓で `sessionEpoch` が進んでも（＝認可した側のセッションが失効しても）コードは交換できる。実害は無い — 接続行は `/authorize` の承認時点で作られるので、その間にリセットが完走すれば `createdAtCredentialVersion` により `revoked` になり、失効した接続のトークンは第5.4節のガード（`ai_client_connections.status`）が利用時に必ず拒否するからである。`account.status = 'active'` を落とさないという判断（`:806`）と同じ理由で、`connectionId` の `status` 照合も交換時のガードに1行足しておくと、#13 が接続行の生成タイミングを変えた場合にも壊れない。

- **[N-005]** 本ラウンドで確認した中で、とくに堅い箇所を記録しておく。
  - **`callerToken` の脅威モデルの正直さ**（`:623`）— 「request Worker のコード実行を得た攻撃者に対しては防壁にならない」を、初版の誤った脅威モデルを撤回する形で明記し、残余リスクを #38 の監査要件へ送っている。`SESSION_SECRET` を握れば `account.callerToken` が phase 0 の A-1 からそのまま返る、という具体的な経路まで書いてあるので、#37 が過大評価する余地が無い。
  - **`purge-user-mappings` を「本表で最も危険なエントリ」と自己申告している**（`:595` / `:1199`）。原理的に `callerToken` で束縛できない理由（トークンが失われた行と一緒に消える）まで書いてあり、代替案の不在が読者に伝わる。
  - **PITR の3つの穴を「fail closed 宣言の射程外」として明示的に切り分けている**（`:1278` / `:1907` / `:1911` / `:1914`）。とくに消費済みリセットトークンの復活が「照合を回避せずに前進させて解消する」ため `credentialVersion` 照合では止まらない、という分析は正確で、対処（restore 直後に `password_reset_tokens` 全削除）も「復旧できないなら全部切る」で AI 接続側と規則が揃っている。
  - **`usableForLogin` + distinct `credentialId` による「最後のログイン手段」検査**（`:1160`〜`:1162`）— 行数 → distinct `(kind, hmac)` → distinct `credentialId` と2度直した経緯まで残っており、SSO 専用ユーザー（メール予約行が常に1本ある）とローテーション中の2世代並存の両方が同時に閉じている。
  - **第6.1.1節 (R1)〜(R9) の集約**が、ローテーション中の credential 変更・signup 予約・unlink・退会・ロックアウト脱出の相互作用を1箇所の正本にまとめている。とくに (R8) と (R9) を「対で入れないと失敗モードが入れ替わるだけ」と書いている点（`:884`）は、部分適用による退行を防ぐ。
