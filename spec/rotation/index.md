# 鍵ローテーションの設計

Identity Directory の2種類の鍵ローテーション — **写像鍵**（routing 鍵。locator の再写像 = 移送を伴う）と**メール暗号鍵**（`rotate-encryption`。bucket 内の再暗号化で完結する）— の**手順・2世代並存の規則・不変条件の正本**。「どの状態の行をどう動かすか」「いつ旧鍵を退役させてよいか」「他のすべての saga とどう干渉しないか」はここで決まる。

- 関連: [database/index.md](../database/index.md)（`credential_mappings` / `credential_locators` / `rotation_checkpoints` / maintenance 経路の物理形） / [async/index.md](../async/index.md)（3類型の全数表。`rotate-remap` は Alarm ジョブではないので載らない） / [domains/identity.md](../domains/identity.md)（ポート契約。本ファイルは新しいポートを足さない）
- 役割分担: **本ファイルが手順と不変条件の正本である。** 物理形（列・索引・CAS の書式）は database/index.md、ジョブとイベントの全数は async/index.md が持ち、二重に持たない

## 前提（本ファイルは再検討しない）

1. locator は `HMAC-SHA-256(写像鍵[世代], canonical)` から導き、bucket の DO 名は `dir:g{世代}:b{番号}`。keyring は `{ generation, key, bucketCount }`（active 1件 + previous 0〜1件）で **request Worker だけに配布する**
2. `userId` 由来 locator は鍵に依存しない。**ローテーションの対象は credential 由来 locator に限られ、User Data DO の同一性（データ本体）には波及しない**
3. 移送の制約は2つ — **(C1) 平文 canonical を Worker 境界の外へ bulk で出さない**（再 HMAC は bucket の中で行う）/ **(C2) 写像鍵を bucket の SQLite にもインスタンスフィールドにも永続化しない**
4. `credentialId` は世代非依存・非導出の同一性であり、移送で再採番しない。移送は認証状態の変更ではないので `credentialVersion` を増やさない
5. `encryptedCanonical` の AAD は `(kind, credentialId, encryptionGeneration)` で `hmac` を含まない — **移送は暗号文3列（`encryptedCanonical` / `encryptionGeneration` / `encryptionNonce`）をそのまま運び、再暗号化しない。再暗号化は `rotate-encryption` だけの仕事である**
6. `rotate-remap` は Alarm ジョブではない（C2 の帰結。Alarm 起動時に鍵が手元に無い）。`jobs.kind` にも `event.type` にも現れない
7. リセットトークン行は移送しない。ローテーション直後に旧 bucket 宛のリンクが死ぬことは受容済みで、告知は運用設計が持つ
8. ログ・エラー・トレースに canonical / HMAC / locator / 鍵 / 復号結果を出さない。移送の RPC は引数・戻り値ロギングを有効化する構成そのものを禁止する
9. 本ファイルが「(Rn)」と引くラベルは2世代並存規則である。単一世代でも成立する規則群は spec 側の各正本に吸収済みで、本ファイルが前提として使うのは **(R1)「新規予約は active 世代に取り、previous 世代は読むだけ」**（予約経路の実装規約）と **(R2)「既存行への更新は行が実在する世代へ向ける」**（database/index.md `credential_locators` の「行が実在する世代」と同じ規則）の2つである

## 初期状態 — 単一世代

**keyring は active 1件 + previous 0〜1件であり、previous を持たない単一世代が初期状態である。** ローテーションは previous を足すデプロイで始まるので、それまでのあいだ本ファイルの手順は次のように退化する。

- **成立しているのは2つの規則である** — locator を `HMAC-SHA-256(写像鍵[世代], canonical)` から導くこと（前提1）と、bucket の DO 名が `dir:g{世代}:b{番号}` であること。**行の `generation` 列も keyring エントリの `generation` もこの状態で実在の値であり、省略しない**
- **lookup は1回のプローブに退化する**（[database/index.md](../database/index.md)「lookup の世代順序」）。「両世代とも外れたら active を再プローブする」規則は、外れる相手が1つしか無いので同じ1回に畳まれる
- **移送の4エントリと退役の判定は駆動されない。** 開始の契機は previous を足すデプロイであり、それが無ければ移送元になる世代が存在しない
- **予約の世代ガードと退役証明の無効化は恒等に退化する。** 自 bucket の世代は常に active の世代であり、`rotation_checkpoints` には消す行が無い

**限界。** 単一世代は**鍵をローテーションできる状態ではない。** 上の退化のとおり2世代並存の lookup も移送も退役も一度も走らないので、それらの規則が実際に成立することはこの状態では確かめられない。**previous を足す側が本ファイルの規則群を最初に実行する主体である。** その主体がスキーマも signature も変えずに済むために、初期状態から次の2点を守る — **keyring を「1件」に固定した型（配列でなく単一値）にしない**ことと、**導出関数が `generation` を返さない形にしない**ことである。

## 鍵の配布とコミットメント

| 材料 | 配布先 | 形 |
|---|---|---|
| 写像鍵 keyring | request Worker のみ | `{ generation, key, bucketCount }` × (active 1 + previous 0〜1) |
| **鍵コミットメント**（新設） | **state Worker のみ** | `{ role: 'active' \| 'previous', generation, keyDigest, bucketCount }` × **keyring と同じ役割つき世代集合**（active 1件 + previous 0〜1件）。`keyDigest = SHA-256(key)` |
| メール暗号鍵 keyring | state Worker のみ | `{ generation, key }` × (active 1 + previous 0〜1) |

- **previous を持つ世代集合を配布する時点で、コミットメントも keyring と対で必須になる** — 予約の世代ガードも移送のコミットメント照合もコミットメント側の active を基準に判定するので、previous を足すデプロイにコミットメントを伴わせない選択肢は無い。**単一世代のあいだは評価する相手が無い** — 自 bucket の世代が常に active であり、ガードは恒等に退化する（「初期状態 — 単一世代」）
- **コミットメントは鍵ではない。** SHA-256 は一方向なので、state Worker はこれを持っても HMAC を計算できない — C2 と非重複配布（request / state の鍵の分離）はどちらも破れない。SQLite ではなくデプロイ変数なので C2 の永続化禁止にも当たらない
- **bucket は、注入された keyring エントリを自分のコミットメントと照合してから使う。** 照合は **`role` の一致**（active / previous のラベルまでコミットメント側と一致すること — 役割を検証しないと、ラベルを入れ替えた注入が移送を逆向きに駆動できる）・`generation` の存在・`keyDigest` の一致（定数時間比較）・`bucketCount` の一致の**4点**である。**役割つきであることが「コミットメントの active 世代」を参照するガード群（予約の世代ガード / `remap-chunk` (ii) / `import-remapped-mappings` (ii)）の計算根拠である** — `max(generation)` での代用は巻き戻し（active の世代番号が previous より小さい）で逆転するので使えない。**これによって bucket は注入鍵と照合できる自分の値を持つ。previous 世代鍵の所持証明はどこでもガードとして使わない**
- keyring とコミットメントは**同じ役割つき世代集合を持つように対でデプロイする**。デプロイスキュー中の不一致は移送の拒否（fail closed）になり、収束後の再実行で回復する。**スキューの影響は移送に閉じない** — 予約の世代ガードがコミットメント側の active を基準に判定するので、スキュー窓のあいだ通常の新規登録・SSO 連携の予約も拒否される。**帰結は経路で2つに分かれる** — 利用者リクエストの中で書かれる予約（コーディネーター予約 / link の初回予約）は同期エラーとして利用者へ返るだけで `poison` は生じず、保存済み座標を再駆動するジョブ側（`resume-signup` の非コーディネーター予約 / `resume-link` の取り直し）だけが前進不能として終端する。**この2種は後始末（自動回収）を持つので、前進不能の確定は即 `poison` ではなく終端モードへの突入であり、後始末が完走すれば `done`、焼き切れるか材料を見失えば `poison` である**（[recovery/index.md](../recovery/index.md)）。回復はどちらも後始末の巻き戻しと収束後の利用者の再試行であり、スキュー窓の最小化はデプロイ手順へ引き継ぐ。**鍵と変数の帰属（どの Worker がどれを持つか）の正本は `apps/web/.dev.vars.example` である**（コミットメント変数は単一世代のあいだ評価する相手を持たないので、まだそこに載っていない）

## 写像鍵ローテーションの手順

### 全体の流れ

1. **開始**: 新しい鍵で世代 g+1 を作り、keyring（request Worker。active = g+1, previous = g）とコミットメント（state Worker）を対でデプロイする。この瞬間から (R1) により新規予約は g+1 の bucket に取られ、lookup は active → previous の順で両世代を引く（**機構の帰属は stub 選択アダプターの契約である** — 正本は database/index.md `credential_mappings`「lookup の世代順序」。リセット依頼の bucket 決定も同じ契約が定める）
2. **移送**: operator 専用 maintenance 経路（request Worker）が、g の各 bucket に対して `remap-chunk` を反復発行する。鍵（active / previous の keyring エントリ）は**その呼び出しの引数として一時注入され、どこにも永続化されない**
3. **退役**: 退役条件 — `rotationKind = 'remap'` かつ世代 g の checkpoint 行が**退役対象世代 g のエントリの `bucketCount` が定める全 bucket（`0 .. bucketCount-1`）**に存在し、すべて `previousCount = 0` — が成立したら、keyring / コミットメントから g を外して対でデプロイする。**N を active 側の `bucketCount` で数えてはならない**（bucket 数の変更は世代の変更として表現されるので、世代間で `bucketCount` は異なりうる）。g の bucket は以後どの経路からも参照されない

**駆動は operator 経路の反復呼び出しであり、Alarm は関与しない**（前提6）。チャンクの進捗は `rotation_checkpoints` と残行数そのものが持ち、**駆動側が持つのは「直前の応答のカーソルを次の呼び出しへ渡す」ことだけである**（走査の意味論は「1クレデンシャルの移送」の節。カーソルを失っても先頭からやり直せる）。**移送の実行には実行前承認と実行監査を必須とする** — これは規範であり、承認・監査の様式とチャンクサイズなどの運用実体だけを運用設計が定める。

**予約の世代ガード。** 予約の書き込み（新規登録 saga / SSO 連携の予約 RPC）は、**自 bucket の世代がコミットメントの active 世代と一致することをガードに持ち、一致しない bucket への新規予約を拒否する。** (R1)「予約は active 世代に取る」は locator を**導出する時点**の性質でしかない — cross-DO saga（`resume-signup` の非コーディネーター予約 / `resume-link` の予約の取り直し）は `locators` / `targetLocators` に**保存済みの世代つき座標**を再駆動し、Alarm ジョブは鍵を持たないので再導出できない。したがって「座標の記録 → 予約の書き込み」の窓にローテーションの開始（keyring / コミットメントのデプロイ）が挟まると、このガードが無ければ previous 世代の bucket に新しい予約行が生まれ、RI-4（`previousCount = 0` の恒久性）と退役の証明が同時に破れる。**拒否の帰結は経路で2つに分かれる** — 利用者リクエストの中で書かれる予約は同期エラーとして返り（**種別は `SystemError` である** — 一時的なインフラ状態による前進不能であり、ユースケースのエラーケース表では既存の「DB 例外 → `SystemError`」の行に含まれる。新しい `kind` も表の行も増やさない）、保存済み座標を再駆動するジョブは前進不能として終端する（**この2種は後始末を持つので、確定は即 `poison` ではなく `terminalReason` を前倒しで書いての終端モードへの突入であり、後始末が焼き切れるか材料を見失って初めて `poison` + operator エスカレーションになる**。[recovery/index.md](../recovery/index.md)）。利用者の再試行は新しい `operationId` が active 世代の座標を導出し直すので回復する（SSO 連携は「連携に失敗した」としてやり直せる。終端後の自動回収も同ファイルが定め、そこでも `targetLocators` / `locators` の保存済み座標をそのまま使う）。ガードを通った予約の書き込みには「退役証明の無効化」の一般規則（後述）が掛かる。

### RPC エントリの全数

移送が使うエントリは次の**4つでこれが全数**である。すべて operator 専用 maintenance 経路に属し（database/index.md「operator 専用 maintenance 経路」）、公開ルートを持たない。migration ゲートは全エントリの先頭に掛かる。

| エントリ | 宛先 | 役割 | ガード |
|---|---|---|---|
| `remap-chunk` | 移送元 bucket（世代 g） | チャンク1回分の移送を駆動する。引数は keyring エントリ2件（active / previous）・件数上限・**任意の開始位置**（下の走査意味論） | (i) コミットメント照合（2件とも）。(ii) 自 bucket の世代（`_meta.self_locator`）= 注入された previous の世代。(iii) **直列化ガード** — 暗号鍵 keyring に previous 世代がある / 自 bucket に `encryptionGeneration` ≠ active の行がある / 自 bucket に `done` でない `rotate-encryption` ジョブがある、のいずれかなら拒否 |
| `import-remapped-mappings` | 移送先 bucket（世代 g+1） | 移送行の受け入れ。引数は active keyring エントリと行の一括（bind 上限の内側にチャンクする） | (i) コミットメント照合。(ii) 自 bucket の世代 = active の世代。(iii) **自己検証** — 各行の `encryptedCanonical` を復号（AAD 検証込み）し、注入された active 鍵で HMAC を再計算して、行の `hmac`・自分の bucket index と一致すること。(iv) 行の `encryptionGeneration` = 暗号鍵の active 世代。1つでも欠ける行は受け入れず拒否する（per-row 応答は下の「引数と応答」）。**(v) 行を受け入れた同じトランザクションで、退役証明の無効化（後述の一般規則）を行う** — 削除するのは **`(remap, 自 index, 自世代)` と `(encryption, 自 index, 行の encryptionGeneration)` の2行**であり、stale な `previousCount = 0` が次のローテーションの退役条件を誤成立させる経路を塞ぐ |
| `record-remapped-locator` | User Data DO | 新世代の逆引きの**先行記録**と、**移送してよい対象かの最終判定**（s3 — import より先に呼ぶ） | (i) `callerToken` の定数時間比較（引数は移送元の行が持つ値）。(ii) `account.status = 'active'`。(iii) 対象 `credentialId` の `credential_locators` 行が**1件以上ある**こと。(i)〜(iii) のいずれかが欠ければ**「見送り」を返す**（記録しない）。通れば `credentialLocatorStore.record` の upsert（冪等キー `(credentialId, generation)`・`credentialVersion` は単調非減少）— database/index.md の書き込み箇所 (1)〜(3) と同じ口であり、これが「鍵ローテーションに伴う追加」の呼び出し規約である。**(i)〜(iii) の検査と upsert は User Data DO の1つの `transactionSync` で行う**（DO は single-threaded なので検査と記録の間に割り込みは無い）。**`callerToken` の照合は、引数・行側のどちらかが `NULL`・空・規定長未満なら照合の前に不一致（= 見送り）として扱う**（`change_auth_token` / `owner_token` と同じ規則。active な写像行は常に `callerToken` を持つので — database/index.md `credential_mappings` — 正当な行が恒久見送りになることは無い） |
| `read-rotation-checkpoint` | 各 bucket | checkpoint の読み取り（退役判定の材料収集）。読みのみ | maintenance 経路の到達制御のみ。行を増やさないので Alarm を張らない |

**`import-remapped-mappings` の自己検証 (iii) が、到達制御に依存しない完全性の権威である。** 暗号鍵（state Worker）と active 写像鍵（コミットメント照合を通る鍵）の両方を欠く主体は、検証を通る行を作れない — binding 到達性だけでは任意の写像行を注入できない。「一意性の最終確認は canonical 原本の復号照合」という2段構造の、移送側への適用である。

### 引数と応答（全数）

4エントリの引数と応答は次で全数である。**応答に canonical・HMAC・鍵・復号結果・`passwordVerifier` を載せない**（前提8の適用点。載せてよいのは分岐名・件数・checkpoint の射影までである）。**エントリレベルの拒否（コミットメント照合・世代ガード・直列化ガードのいずれかに落ちた場合）は、理由の粒度を落とした `SystemError` として値エンベロープに載せる** — operator 専用経路であり、詳細は DO 側の観測（`terminalReason` 相当）に閉じる。per-row の「拒否」「見送り」はエラーではなく応答の分岐である。

| エントリ | 引数 | 応答 |
|---|---|---|
| `remap-chunk` | keyring エントリ2件（active / previous）+ 件数上限 + **任意の開始位置 `afterCredentialId`**（exclusive。前回応答の値をそのまま渡す） | 処理した行数・見送りの行数・残行数（= 直後の `previousCount`）・**最後に走査した `credentialId`**（末尾まで走査し切った場合は無し = 1周完了）。行の中身は返さない — `credentialId` は非秘密（設定画面へ出す値）なのでカーソルとして応答に載せてよく、応答の禁止リスト（canonical / HMAC / 鍵 / 復号結果 / `passwordVerifier`）に触れない |
| `import-remapped-mappings` | active keyring エントリ + 移送行の一括（`credential_mappings` の全列。bind 上限の内側にチャンクする） | **行ごとの結果の配列** — 正本判定の分岐名（(a)〜(e)）または「拒否」（自己検証 / 暗号世代ガード落ち）。**per-row で返す** — 行単位の失敗規則（当該行だけを残して続行）と、(e) の衝突を移送元が s6 の snapshot 置換に載せることの両方が、行ごとの結果を前提にする。バッチ一括の成否だけを返す形は行単位規則と矛盾するので採らない |
| `record-remapped-locator` | `callerToken` + locator の全量（`credentialId` / `generation` / `kind` / 全長 HMAC / bucket index / `credentialVersion` / **`usableForLogin` / `label`** — 後2者は移送元行のスナップショットから Identity Directory 側が判定した値。`credential_locators` は自分では判定しない。database/index.md） | 記録した / 見送り（`account` 非 active・locator 0件・`callerToken` 不一致のどれでも同じ「見送り」1値 — 理由を分けると呼び出し元のログに退会状態が漏れる） |
| `read-rotation-checkpoint` | `rotationKind` + 対象世代 | 自 bucket の該当 checkpoint 行の射影（`previousCount` / `scannedAt` / 衝突3列）。行が無ければ「未走査」 |

### 1クレデンシャルの移送 — 順序と CAS

移送元 bucket は `remap-chunk` の中で、対象行1件ごとに次を実行する。**この順序は固定であり、とくに s3（逆引きの先行記録）→ s4（移送先へ書く）→ s5（移送元の削除）の順を入れ替えない。**

**走査の意味論。** 1回の `remap-chunk` は、`credentialId` 昇順（bucket 内 UNIQUE 索引 `cm_credential_id_uq` で解ける）で、引数の開始位置 `afterCredentialId`（省略時は先頭）の**次の行から**走査する。**件数上限は走査した行数に掛かり**、上限に達するか末尾に達したら応答（最後に走査した `credentialId`、末尾なら「1周完了」）を返して終わる。**駆動側（request Worker の maintenance 経路）は直前の応答の値をそのまま次の呼び出しの開始位置へ渡す以上の状態を持たない** — カーソルは応答の写しであり、失っても先頭からやり直せば冪等に収束する（移送済みの行は消えているので先頭側の走査は空振りで縮む）。**この窓の前進が飢餓を塞ぐ** — 見送り行（s1 の行ローカル見送り・s3 の見送り・分岐 (e) の衝突行。最後のものは operator が対処するまで恒久に残る）が先頭側に何件溜まっても、次の呼び出しはカーソルの先から走査するので未処理の行に必ず届く。1周完了後の再開は先頭からで、見送り行だけが残っているあいだは `previousCount` が非0のまま停滞する（fail safe。進捗の観測は checkpoint が担う）。

- **s1 読み出しと見送り（行ローカル）**: `status != 'active'` または `changeState IS NOT NULL` の行は**読み出し時点で見送る**（この起動では触らない）。予約行（signup / SSO 連携の進行中）と credential 変更の中間状態が対象で、**進行中の saga を跨いで行を移送しない**（(R6)）の第1段である
- **s2 再写像（bucket 内・非同期文脈）**: `encryptedCanonical` を復号し、注入された active 鍵で新 `hmac` と新 bucket index を計算する。平文はこの呼び出しのスコープを出ない（C1）。**復号・HMAC などの暗号処理は非同期 API であり、`transactionSync` の中に持ち込まない**（database/index.md「窓キーの導出」と同じ制約。各書き込みのトランザクションに入るのは書き込みそのもの・退役証明の無効化・結果の確定だけで、検証と書き込みの間で input gate が開いて他リクエストが割り込むことは、各書き込みの CAS が吸収する）
- **s3 逆引きの先行記録と最終判定**: `record-remapped-locator`。**「見送り」（`account` 非 active / 対象 `credentialId` の locator 行が0件 / `callerToken` 不一致）が返ったら、その行を残して次の行へ進む — 複製はまだ作られていないので、破棄すべきものが無い。** signup（逆引き記録前）・SSO 連携（記録前）・SSO 解除（削除後）・退会は、いずれも「locator 行が無い / アカウントが active でない」としてこの1検査に畳まれる — **削除進行中の印を `credential_mappings` に持たないのはこのためである**。通れば `credential_locators` に `(credentialId, 新世代)` の行が upsert される。**記録が import より先であることが本設計の要である — 複製が存在しうる座標は、複製が作られる前に必ず逆引きに載る。** したがって s3 以後に始まる SSO 解除・退会の座標退避（`targetLocators` / `credential_locators` のスナップショット）は新世代の座標を必ず含み、`deleteMapping` の全世代発行（「無ければ成功」の冪等削除・残件駆動の再試行つき）が複製へ到達する。s3 より前に始まった削除は locator 行を先に消しているので s3 が見送り、複製は作られない。**残る1つの窓 — s3 の記録後・s4 の import 着地前に削除 saga が完走し、g+1 への削除が「無ければ成功」の no-op で終わった後に遅延した import が複製を書く — は、下の「削除の no-op 確定」が閉じる。** **削除対象のスナップショットと移送の競合は、先行記録と no-op 確定の対で閉じる**（干渉表の該当行に経路を書く）
  - **逆引きが写像より先に存在する窓は無害である** — 到達性検査は `credentialId` だけを見るので結果が変わらず、その座標への lookup は行の不在で空振りし（もう一方の世代の行が引き続き可視。RI-1）、認可はどの向きにも動かない
- **s4 移送先へ書く**: `import-remapped-mappings`。**発行の直前に移送元の行を読み直し、s1 のスナップショットと認証状態の列（`passwordVerifier` / `changeState` / `credentialVersion` / `status`）が一致しなければその行を見送る**（複製を作らない — s2〜s3 は非同期文脈なので、この間に着地した credential 変更の変更前スナップショットを複製として固定化しないための狭めである。読み直し後の in-flight 窓に残る残余は「受容した残余」に列挙する）。分岐は後述の**正本判定**に従う。**分岐 (e)（`userId` 不一致の見送り）が返った行については s5 を発行せず、次の行へ進む**（移送元・移送先とも変更しない。s6 の checkpoint はチャンク単位で通常どおり書かれ、衝突3列に記録される）
- **s5 移送元の削除**: 述語2の CAS で自行を消す。**同じ `transactionSync` で、その `credentialId` の `password_reset_tokens` 行を全削除する**（写像を失った行は解決不能なので残さない。未使用リンクが死ぬことは前提7で受容済みの影響と同じ大きさである）
- **s6 checkpoint**: チャンクの末尾で `(rotationKind='remap', 自 bucket index, 世代 g)` を snapshot 置換する（`previousCount` = チャンク後に自 bucket に残る写像行の総数。見送り行を含む）。**衝突3列（`conflictCount` / `lastConflictAt` / `lastConflictCredentialId`）も同じ置換で書き、値はそのチャンクでの再検出数の snapshot である（累積しない）** — チャンクの件数上限により衝突行が走査対象に入らなかった snapshot では 0 になりうるが、**衝突行そのものは移送されずに残るので `previousCount` は非0のままであり、退役が塞がれるという fail safe は snapshot の値に依存しない**（operator が読む際の意味は「そのチャンクで再検出した数」である）

**CAS 述語は2つでこれが全数である**（(R7) の具体。第3の述語になりうる「移送先の破棄」は、逆引きの先行記録（s3）によって**操作ごと存在しない** — 複製を作る前に移送可否が確定するので、作った複製を後から破棄する経路が無い）:

| # | 対象 | 述語 | 0行だったときの扱い |
|---|---|---|---|
| 1 | 移送先の前進（s4 の上書き分岐） | `status = 'active' AND changeState IS NULL AND credentialVersion = 移送先の読み出し値` | 上書きせず、移送先を正本として s5 へ進む（移送先に実在の中間状態 — `changeState` が立った行 — が着地している場合もここに畳まれ、**壊されずにそのまま正本になる**） |
| 2 | 移送元の削除（s5） | `status = 'active' AND changeState IS NULL AND credentialVersion = s1 の読み出し値` | 消さずに残す（窓の中で credential 変更が移送元に着地した形。saga の完走後、次のチャンクが「移送元が新しい」分岐で正本へ収束させる） |

- **2述語のいずれにも濫用抑止カウンタ（`failedAttempts` / `nextAttemptAllowedAt`）を含めない。** 含めると、遅延して届いた照合結果の書き戻し（ログイン失敗 / 現在パスワード照合の失敗によるカウンタ更新。domains/identity.md `CredentialMappingRepository` の濫用抑止）が述語を恒久的に外し、移送が収束しなくなる。移送窓のカウント欠落は「受容した残余」に列挙する
- **述語に `pendingVerifier IS NULL` が無いのは非対称ではなく含意である** — `pendingVerifier` が非 NULL の行は必ず `changeState` も非 NULL である（`beginCredentialChange` が同じトランザクションで両方を書く。domains/identity.md の操作表）ので、`changeState IS NULL` が両方を覆う。**この含意は不変条件であり、`changeState` を立てずに `pendingVerifier` だけを書く経路を足してはならない**
- **削除の no-op 確定（追い越し窓の封止）。** `deleteMapping` は「無ければ成功」の冪等操作のままだが、**削除 saga（`sweep-orphan-mapping` / `finalize-withdrawal`）が unlink / 退会の `operations` 行を `phase = 'done'` にしてよいのは、退避座標の各世代について削除が「確定」したときだけである。** 実在する行を消した削除は即確定する。**no-op だった削除は、退避座標が単一世代なら即確定し、2世代以上を含む場合（= ローテーション中に s3 の先行記録を受けた印）には、最小再開間隔の後にもう一度発行してから確定する。再発行の間隔の起点は「1巡目の全退避世代への発行が完了した時点」である**（no-op 単体の発行時刻を起点に取ると、実在世代への発行が遅れた分だけ import の発行が後ろへずれ、封止の不等式が世代間の発行順序に依存してしまう） — s3 と s4 の間の in-flight 窓に削除が完走すると、no-op の後から遅延した import が複製を書きうるからである。**再発行の間隔には「cross-DO RPC の実行寿命の上限より長いこと」の制約を置く**（上限が platform 仕様として実在することの確認と実値は運用設計が定める。**確認できない場合の出口も決めておく** — そのときは再発行1回では封止を主張せず、削除 saga の既存 backoff で有界回数の再発行を行ってから確定する。回数は運用設計が定める）— これにより、遅延着地した複製は再発行の時点で必ず可視であり、「無ければ成功」で実在削除される。再発行は既存の残件駆動（`operations` の未完了行）と一様な終端の規約にそのまま乗り、新しいジョブも RPC も増えない
- **行単位の失敗とチャンクの中断の扱い。** import の拒否（自己検証落ち等）と s3〜s5 の RPC 失敗は、**その行を残して次の行へ進む**（見送りと同じ扱い）。チャンクそのものが中断した場合、s6 の checkpoint は書かれず前回の snapshot が残る — `previousCount` が 0 でない限り退役は成立しないので fail safe であり、再実行は正本判定 (d) の冪等性で収束する。**s4 完了後・s5 前の中断で両在のまま残った複製も無音にならない** — 座標は s3 で逆引きに記録済みなので、削除経路からも次チャンクの再評価からも到達できる
- **`credential_locators` 側の移送追加行は破棄しない**。世代退役後に残る余剰世代行も**回収しない** — 到達性検査・ログイン手段の数え上げ・認可はすべて `credentialId` をキーにするので余剰行は結果を変えず、credential の削除時には `deleteByCredentialId` が全世代を消す。回収機構を持たないことで規則が1つ減る

**正本判定（s4 の分岐）は5分岐でこれが全数である**（(R9) の具体。「移送先に行があれば書かない」に倒してはならない — 移送の中断と再実行のあいだに旧世代 bucket 宛のトークンでリセットが完走すると、旧 `passwordVerifier` が復活する）:

| 分岐 | 条件 | 動作 | 記録先 |
|---|---|---|---|
| (a) | 移送先に行が無い | **条件付き INSERT**（「同 `(kind, hmac)` の行が無いこと」を条件に含める。s2 の検証は非同期文脈にあり、判定と INSERT の間に他リクエストが行を作りうるので、無条件 INSERT の一意制約違反ではなく条件不成立として扱い、**分岐を読み直して再評価する** — 割り込みの吸収は各書き込みの CAS / 条件付き文が担う） | なし（正常） |
| (b) | 同 `userId` で移送先の `credentialVersion` が大きい | 何も書かず、**移送先を正本**として s5 へ | なし（正常。移送先で credential 変更が完走した形） |
| (c) | 同 `userId` で移送元の `credentialVersion` が大きい | 述語1の CAS で**移送元の値へ上書き**（0行なら (b) と同じ扱いに縮退する） | なし（正常。移送元で credential 変更が完走した形） |
| (d) | 同 `userId` で等しい | 冪等な再実行として述語1の CAS で移送元の値で上書き（**同一なのは認証状態の列 — 検証材料・`changeState` 系・`credentialVersion`・`userId`・`status` — であり、濫用抑止カウンタは同版でも異なりうる**。「受容した残余」のとおりスナップショット優先で上書きしてよい。0行なら (b) と同じ扱いに縮退する） | なし（正常。中断からの再実行） |
| (e) | **`userId` が異なる** | **見送り**。移送元も移送先も変更しない | `rotation_checkpoints` の衝突3列に記録し（集計単位は s6 のとおりチャンク毎の snapshot）、operator へエスカレーションする |

- (e) は正常運用では到達しない — 予約は active 世代でしか取られず（(R1)・予約の世代ガード）、lookup は active → previous を両方引き、移送は「移送先へ書いてから移送元を消す」順序（s4 → s5）なので、**同じ canonical の行が全世代から同時に不可視になる瞬間が無い**（不変条件 RI-1）。到達するのは PITR restore の残骸などの異常であり、`previousCount` が 0 にならないことで退役が構造的に塞がれる（fail safe）
- **移送する行の内容は全列をそのまま運ぶ**（`hmac` / `generation` だけが新しい値になる）。`callerToken`・saga コーディネーター列・濫用抑止カウンタは s1 時点のスナップショットである

### 退役証明の無効化 — 行を増やす書き込みの一般規則

**自 bucket の写像行を増やす書き込みは、同じトランザクションで、増えた行が属する世代の checkpoint 行を削除する。** 「行が増えている世代の退役証明は偽である」を、経路の列挙ではなく**書き込みの事実そのもの**に掛ける（Alarm の張り直し規約が「行を増やした主体が張る」と射程を宣言するのと同じ形である）。削除の対象は**増えた行が属する世代の checkpoint** — 写像行が増える書き込み（予約 / import）では `(rotationKind='remap', 自 index, 自 bucket の写像世代)` と `(rotationKind='encryption', 自 index, その行の `encryptionGeneration`)` の2行、暗号世代の付け替え（`rotate-encryption` の書き換え）では `(rotationKind='encryption', 自 index, active 暗号世代)` の1行 — で、いずれも PK の点削除であり「無ければ成功」の冪等操作である。

適用点は行を増やす書き込みの全数と一致する:

- **予約の書き込み**（新規登録 saga の予約2つ / SSO 連携の予約） — 巻き戻しで再活性化した世代への正当な新規予約が、順方向 run の stale な `previousCount = 0` を残したまま行を増やす経路を塞ぐ
- **`import-remapped-mappings` の受け入れ**（ガード (v)）
- **`rotate-encryption` の書き換え** — 暗号世代の付け替えは「active 暗号世代の行を増やす」書き込みなので、各チャンクの書き換えトランザクションが `(encryption, 自 index, active 暗号世代)` を削除する

**この規則があるから、退役条件（RI-7）は鮮度もラウンド識別も要求しなくてよい** — checkpoint 行が存在して 0 であることは、その世代に行が増えていないことをそのまま意味する。

## メール暗号鍵ローテーション（`rotate-encryption`）

骨格は「bucket 内で復号 → active 暗号世代で再暗号化」（Alarm ジョブ。起動は operator 経路）であり、本ファイルは**書き換えの形・記録規則・退役条件**を確定する。

- **各行の書き換えは、`(kind, hmac)` の PK に `encryptionGeneration = 退役対象世代` を条件として加えた UPDATE で行う。0 行はその行の完了（削除済み、または削除→同 canonical の再予約で active 暗号世代の新しい行に置き換わった形）として次へ進む** — 復号・再暗号化は非同期文脈で行われ、読み出しと書き込みの間で input gate が開くので、この条件が無いと「削除 → 同じ canonical の新規予約」の窓で**別の `credentialId` を AAD に持つ暗号文が新しい行を上書きし、その行が恒久的に復号不能になる**（自己参照・移送の自己検証・次の再暗号化がすべて落ちる）。書き込みトランザクションに入るのは UPDATE・退役証明の無効化・checkpoint だけである
- **「メール暗号鍵」という名称に反して、対象は `kind` を問わない canonical 原本の暗号鍵である**（database/index.md `encrypted_canonical` — SSO canonical も同じ鍵で暗号化される。変数名 `IDENTITY_MAIL_ENCRYPTION_KEY` も同じ射程で読む）

- **記録の契機**: 各チャンクの完了トランザクションで `(rotationKind='encryption', 自 bucket index, 退役させる暗号世代)` を snapshot 置換する。`previousCount` = `encryptionGeneration` ≠ active の残行数
- **残件条件**（ジョブの再武装）: `encryptionGeneration` ≠ active の行が存在すること。残件が尽きた完了トランザクションで `previousCount = 0` の checkpoint を書き、`done` へ落ちる
- **各チャンクの書き換えトランザクションは、退役証明の無効化（上の一般規則）として `(rotationKind='encryption', 自 index, active 暗号世代)` の checkpoint 行を削除する** — 暗号世代の付け替えは active 暗号世代の行を増やす書き込みだからである。巻き戻し（役割入れ替えの再実行）で過去の `previousCount = 0` が残っていても、行が増える瞬間に消える
- **投入点は operator 経路の起動だけであり、移送側からの再投入は存在しない**（[async/index.md](../async/index.md) の全数表の投入点欄と一致）。移送が `encryptionGeneration` ≠ active の行を運ばない（直列化ガード）ので、「移送が古い暗号世代の行を再暗号化完了済み bucket へ運び込む」経路は構造的に無い
- **退役条件**: `rotationKind = 'encryption'` かつ退役対象世代の checkpoint 行が**active な写像世代の全 bucket**（`0 .. bucketCount-1`）に存在し、すべて `previousCount = 0` であること。「全 bucket」の N が一意に定まるのは直列化（次節）の帰結である — 暗号鍵ローテーション中に写像世代は1つしか無い。**この前提はデプロイ順序の規範（写像ローテーションの開始は暗号ローテーションの完了後）に依存するが、規範が破られても退役は誤成立しない** — active 写像世代が移った時点で、その世代の bucket に checkpoint が無いことが退役を塞ぐ（fail safe。次節のデプロイ順序の項）
- 巻き戻しは役割を入れ替えた再実行（旧世代を active に戻して再暗号化し直す）であり、専用の手順を持たない

## 2つのローテーションの直列化

**同時に走らせない。運用規約ではなく、開始条件の相互拒否として構造で止める。**

| 向き | ガード | 置き場 |
|---|---|---|
| 写像鍵の移送は、暗号鍵ローテーションが完了するまで始まらない | `remap-chunk` の直列化ガード（暗号 keyring に previous がある / 自 bucket に `encryptionGeneration` ≠ active の行がある / `done` でない `rotate-encryption` ジョブがある → 拒否） | 移送元 bucket |
| 暗号鍵ローテーションは、写像鍵ローテーションの進行中に始まらない | `rotate-encryption` の起動 RPC（operator 経路の `start-rotate-encryption`。引数なし）が、**コミットメントに previous 写像世代が存在するあいだ拒否**する | 各 bucket |
| 古い暗号世代の行は移送されない | `import-remapped-mappings` のガード (iv) | 移送先 bucket |

- デッドロックしない — どちらのガードも**開始**条件であり、どちらも進行中でなければ片方を開始でき、開始した側が完了するまでもう片方が待つだけである
- **デプロイ順序の規範は両方向にある。** (i) 暗号鍵 keyring のデプロイ（previous エントリの追加 = 暗号ローテーションの開始準備）は、写像鍵ローテーションの完了後に行う。(ii) **写像鍵ローテーションの開始（keyring / コミットメントへの previous 追加）は、暗号鍵ローテーションの完了後に行う** — 開始そのものはデプロイなので構造ガードでは止まらないが、違反しても壊れない: `remap-chunk` は直列化ガードで拒否され続け（移送は1行も動かない）、暗号側の退役条件は「active 写像世代の全 bucket の checkpoint」を要求するので active が g+1 へ移った時点で checkpoint 不足により**退役が塞がれる**（fail safe。**起動済みの `rotate-encryption` ジョブ自体は完走しうる** — 停止するのは移送と暗号側の退役判定であって、書き換えの前進ではない）。(i) の向きの違反では両ローテーションが停止する wedge になるが、どちらも非破壊で、**回復は後からデプロイした側の keyring / コミットメントを巻き戻すことである**。デプロイ順序の手順化は運用設計が持つ
- `rotation_checkpoints` は `rotationKind` を含む置換キーで分かれているうえ、退役条件は必ず `rotationKind` で絞って読む — **絞らずに数えると片方の完了記録がもう片方の旧鍵破棄条件を成立させる**（database/index.md の列定義と対で守る）
- 両鍵の同時漏えいでは片方ずつ順に完走させる。順序の選択と手順は運用設計が持つ

## 巻き戻し

**巻き戻しは「世代ロールを入れ替えた通常の移送」であり、専用の状態・専用の手順を持たない。**

- 世代 g → g+1 の移送を中止するには、keyring / コミットメントを「active = g、previous = g+1」に配布し直し、同じ機構で g+1 の bucket から g の bucket への移送を実行する。s1〜s6・CAS 2述語・正本判定・checkpoint（`generation = g+1` の行として記録される）がそのまま効く。**順方向 run が書いた `(remap, *, g)` の checkpoint（`previousCount = 0`）は巻き戻しで偽になるが、専用の無効化手順は要らない** — g の bucket で行が増える書き込み（import・再活性化後の新規予約）のたびに「退役証明の無効化」の一般規則が自世代の checkpoint を削除するので、stale な退役証明は構造的に残らない。予約の世代ガードも役割入れ替え後の active（= g）を基準にそのまま効く
- 中間状態はどの時点でも安全である — lookup は active → previous の順で両世代を引くので、行がどちらの世代にあってもログインは通り（可視性は RI-1）、進行中の saga は見送り（s1 / s3）で保護される。認可が開く方向の破れは正本判定 (b)〜(d) が塞ぐ
- g+1 で発行済みのリセットトークンは、その行の移送時に消える（s5）。前提7で受容済みの影響と同じ大きさである
- `credential_locators` に残る g+1 世代の行は回収しない（上述）

## saga との干渉（全数）

**干渉表の行は「cross-DO saga の前進」5種（[async/index.md](../async/index.md) の全数表の類型欄が正本）+ 移送と交差する非 saga 経路4つ（login の到達性検査 / リセット依頼 / 予約 TTL 掃除 / ロックアウト脱出）の計9行でこれが全数である。** 「干渉」に数えるのは**利用者の操作から到達して写像行（`credential_mappings`）の状態を読む・書く経路と、その前進ジョブ**である。数えない経路は2群 — (i) `sweep-reset-tokens` はトークン行・窓行への期限削除だけを持ち写像行に触れない（s6 のトークン削除とは「無ければ成功」の冪等削除どうしで交錯しない）、(ii) operator 専用 maintenance 経路（`purge-user-mappings` / 隔離イベントと `poison` ジョブの再駆動）は運用の判断で駆動され、移送との併走は運用手順が直列化する（移送自体が同じ経路に属する保守作業である）。**`cancel-reservation` はこの群に数えない** — 帰属は saga の内部エントリであり（[recovery/index.md](../recovery/index.md)）、その呼び出し元（後始末の段 S3 / S4 / L2 と、退会側の引き取り段）はいずれも Alarm 駆動なので運用手順で直列化できない。**それでも干渉表に行を足さないのは、後始末が消す行がいずれも移送の見送りに落ちるからである** — コーディネーター予約行と `reserved` 行は s1（`status != 'active'`）が、`active` な孤児写像は s3（対象 `credentialId` の locator 行が0件）が見送るので、移送と回収が同じ行を取り合わない。 列は移送の4状態 — 未移送（両ローテーション開始後・行はまだ移送元） / **両在**（s3 完了・s6 未了。両世代に行がある） / 移送済（s6 完了） / 見送り中（s1 または s4 で見送られた行）。

| 経路 | 未移送 | 両在 | 移送済 | 見送り中 |
|---|---|---|---|---|
| 新規登録 saga（`resume-signup`） | 予約〜逆引き記録は移送元世代…ではなく (R1) により**常に active 世代**で完結する。previous 世代に新しい行は生まれない — 保存済み座標（`locators`）を再駆動する非コーディネーター予約が previous を指す場合は**予約の世代ガード**が拒否し、saga は前進不能として終端モードへ入る（後始末の S1〜S4 が材料を使って予約行と孤児写像を解放するので、利用者は同じメール / SSO 主体で登録をやり直せる。[recovery/index.md](../recovery/index.md)） | 同左（signup の行は最初から active 世代にある） | 同左 | 進行中の signup 行（`reserved`、または active だが逆引き未記録）は s1 / s3 が見送る。saga は自 bucket の `resume-signup` で完走し、**完走後の次チャンクで行だけが動く**。予約行の材料（`locators` / `candidateUserId` / `callerToken`）が移送で失われることは無い |
| クレデンシャル変更 saga（`resume-credential-change`） | phase 1〜3 は「行が実在する世代」（(R2)）= 移送元で完結する。`changeState` が立った瞬間から s1 が見送る | **phase 1 が移送先に着地した場合**（lookup が active を先に引くため）: 移送先の複製がそのまま正本になり、saga はそこで完走する — 破棄という操作は本設計に存在しないので中間状態が壊れる経路が無い。中断後の再チャンクでは述語1が `changeState` 非 NULL で上書きを拒否し、正本判定 (b) 相当へ縮退して収束する。**phase 1 が移送元に着地した場合**: s1 見送り → saga 完走 → 分岐 (c) で移送元の新しい値が正本になる。**どちらの順序でも phase 1 の bucket と phase 3 の bucket は同じであり、恒久 `pending` は生じない** | 変更は移送先（唯一の行）に着地する。単一世代と同じ | `changeState IS NOT NULL` のあいだ行は動かない。saga は必ず自分が始まった bucket で `resume-credential-change` により完走する。**両在中は「旧 bucket に残ったトークン経由のリセット」と「新 bucket の複製へのパスワード変更」が同じ credential に並走しうる** — どちらの saga も版を User Data DO の `advanceCredentialVersion`（単一カウンタ・進めた後の値を返す）から取って昇格するので、2つの行が**同版・異内容になることは構造的に無く**、収束は正本判定 (b)/(c) の版比較に畳まれる（domains/identity.md `CredentialLocatorStore`） |
| SSO 連携 saga（`resume-link`） | 予約は (R1) により active 世代に取られる。previous 世代に新しい行は生まれない — 保存済み座標（`targetLocators`）を再駆動する予約の取り直しが previous を指す場合は**予約の世代ガード**が拒否し、saga は前進不能として終端モードへ入る（後始末の L1〜L3 が `targetLocators` の全要素を解放するので、利用者は再 link で回復する。[recovery/index.md](../recovery/index.md)） | 同左 | 同左 | 予約中は s1、活性化済み・逆引き未記録は s3 が見送る。`resume-link` の再実行（予約の取り直し・活性化・記録）はすべて移送されていない行に当たるので冪等性が保たれる |
| SSO 解除（`sweep-orphan-mapping`） | `targetLocators` へ全世代分を退避してから削除する既存規則のまま | 解除が s3 より先なら s3 が「locator 0件」で見送り、**複製は作られない**。s3 の後なら退避座標（`targetLocators`）に新世代が必ず含まれ（記録が import より先だから）、`deleteMapping` の全世代発行が複製に到達する — **遅延した import が no-op 削除を追い越して着地する窓は「削除の no-op 確定」（2世代退避時の遅延再発行）が閉じる。どの順序でも、削除経路から到達不能な複製は残らない** | 退避済みの `targetLocators` に新世代の locator が含まれる（逆引き記録 s3 が import より先に走っているため）。全世代削除で閉じる | 見送られた行は移送元に居続けるので、`targetLocators` の座標のまま消せる |
| 退会（`finalize-withdrawal`） | 同上（`credential_locators` の全世代分に `deleteMapping` を発行する既存規則） | 退会が s3 より先なら s3（`account` 非 active）が見送り、複製は作られない。s3 の後なら `credential_locators` / `targetLocators` の座標退避に新世代が含まれ、`finalize-withdrawal` の全世代削除（「削除の no-op 確定」の遅延再発行を含む）が複製へ到達する。**退会の削除対象スナップショットと移送の競合は「逆引きの記録が import より先」+「no-op 確定」の対で閉じる** | 退会前に移送が完了していれば `credential_locators` は両世代の行を持ち、全世代削除で閉じる | 同左 |
| login（パスワード / SSO とも。到達性検査と失敗カウンタの書き戻し） | lookup は active → previous の順で両世代を引き、行は常に1世代以上に可視（RI-1）。到達性検査は `credentialId` のみを見る（世代を条件に含めない）ので、**移送中に fail closed へ落ちる窓は「移送先の複製が陳腐で `credentialVersion` 照合に落ちる」場合だけ**であり、次チャンクの収束（分岐 (c)）で解消する。認可が開く方向には倒れない。**照合結果の書き戻し（`failedAttempts` / `nextAttemptAllowedAt` の更新）は lookup がヒットした行（未移送 = 移送元）へ着地する** | 同左。書き戻しは active 側（複製）へ着地し、移送元へ遅延着地した分は CAS 2述語がカウンタを含まないので収束を妨げず、増分は失われうる（受容した残余） | 単一世代と同じ（書き戻しは移送先のみ） | 同左（書き戻しは移送元のまま） |
| リセット依頼（`requestPasswordReset`） | 窓キーは世代を畳み込んだ値なので、新世代側で一度だけ窓がリセットされる（database/index.md `reset_request_windows` が受容済み）。**依頼一式（窓・行の解決・発行・イベント行）は「lookup の世代順序」の契約でヒットした世代の bucket に完結し**（未移送 = previous 側・未登録 = active 側。database/index.md `credential_mappings`）、トークンは「行が実在する世代」の bucket に発行される | 発行先は lookup がヒットした世代。移送 s5 がその世代の行を消すときトークン行も消えるので、**写像の無いトークンは残らない** | 新世代にのみ発行される | 見送り行の bucket に発行され、行が動かない限り有効なまま |
| 予約 TTL 掃除（`sweep-reservations`） | 予約行は s1 が見送るので、掃除と移送が同じ行を取り合わない。掃除は各 bucket ローカルの既存規則のまま | 同左 | 同左 | 同左 |
| ロックアウト脱出 | 脱出経路 (i)（リセット完走で `failedAttempts` を 0 に戻す）は phase 1 と phase 3 が同じ bucket の同じ行に着地することで成立する — 上の「クレデンシャル変更」行のとおり、移送中もこの同一性は保たれる。脱出経路 (ii)（SSO は別 credential）は移送と独立 | 同左 | 同左 | 同左 |

## 鍵漏えい起因のローテーション — 失効の成立

漏えいを想定するのは previous 世代の写像鍵である（漏えいが発覚した鍵を previous に降格して新世代へ移送する）。**漏えい鍵の保持者にできないことを列挙し、それぞれの根拠を対応させる**:

| 攻撃 | 塞ぐもの |
|---|---|
| 偽の鍵・偽の世代で移送を駆動する（移送元を解決不能にする / 攻撃者が計算できる bucket へ検証材料を送り込ませる） | コミットメント照合 — 漏えい鍵から新世代のコミットメントを満たす鍵は作れず、`remap-chunk` / `import-remapped-mappings` は照合を通らない引数を拒否する |
| 偽の写像行を移送先へ注入する（任意アカウントへのクレデンシャル注入） | `import-remapped-mappings` の自己検証 — 暗号鍵（state Worker）を持たない主体は検証を通る `encryptedCanonical` を作れない |
| 退役の証明を偽装して旧鍵を早期破棄させる／退役を妨害する | `rotation_checkpoints` の書き込み口は UoW の `rotationCheckpointStore` だけであり、bucket の外から書けない。読み手（`read-rotation-checkpoint`）は maintenance 経路に閉じる |
| 所持証明としての previous 鍵の提示 | **どの経路も previous 鍵の所持を認可材料にしない**（bucket 側のコミットメント照合が唯一の権威である） |
| 退役後に旧鍵で locator を計算して旧 bucket を叩く | 根拠は互いに独立な2つである — (i) 退役後の keyring / コミットメントに世代 g が無いので、request Worker の stub 選択（リセットリンクが指す bucket の解決を含む）は g の locator を導出できず、g の bucket へ到達する経路が残らない。(ii) 旧 bucket に**写像行とリセットトークン行は無い** — `previousCount = 0` が退役の前提であり、写像行の削除（s5）は同じトランザクションでトークン行も消している。残りうるのは窓行（`reset_request_windows`）・ジョブ行・checkpoint 行だけで、いずれも canonical も検証材料も解決しない |

**したがって、漏えい鍵の保持者は失効手段（新世代への移送と旧鍵の退役）を無効化も悪用もできず、退役の完了をもって漏えい鍵は無価値になる。** maintenance 経路そのものの到達制御・実行前承認・監査は運用設計の領分だが、上の表は到達制御が破られた場合にも独立に成立するガードだけを数えている。

## 不変条件（RI-1〜RI-8）

- **(RI-1) 可視性**: 登録済み canonical の写像行は、どの時点でも keyring に載る世代の bucket に1行以上可視である。根拠は s4（書く）→ s5（消す）の順序であり、逆順の実装を禁止する
- **(RI-2) 正本の一意性**: 同じ `credentialId` の行が2世代にあるとき、正本は `credentialVersion` が大きい側（等しければ**認証状態の列について**内容同一 — 濫用抑止カウンタは射程外）であり、移送は正本の側へ収束させる。正本判定は5分岐（(a)〜(e)）で全数である。**「等しければ内容同一」の根拠は、版の採番が User Data DO の `advanceCredentialVersion`（単一カウンタ・進めた後の値を返す）に線形化され、認証情報側の昇格がそのカウンタの値へ揃えることである**（正常系は戻り値、`'advanced'` からの saga 再開だけは `findByCredentialId` の読み直し — どちらも同じ単一カウンタの現在値である。domains/identity.md / recovery/index.md）— 認証情報側のローカル +1 で代用する実装はこの前提を破り、両在中の並走 saga で同版・異内容を作る
- **(RI-3) saga の保護**: `status != 'active'` / `changeState IS NOT NULL` の行は読み出し時点で移送から外れ、locator 実在検査（s3）に落ちた行は複製を作らずに外れる。進行中の saga の行と、その saga を前進させるジョブの所在が引き剥がされることは無い
- **(RI-4) 単調性**: 移送開始後、previous 世代 bucket の写像行数は単調非増加である。行を作る経路は予約と import の2つで全数であり、**どちらも「自 bucket の世代 = active」ガードを持つ**（予約は「予約の世代ガード」— 保存済み座標を再駆動する saga が previous へ書く経路まで含めて塞ぐ。import はガード (ii)）ので、previous に行を作る経路が構造的に存在しない。したがって `previousCount = 0` の checkpoint は恒久に真である。**限界: PITR による bucket 復元はこの全数の外である** — 復元は消えた行を戻すので、復元した bucket の checkpoint は無効として扱い、移送を再駆動してから退役を判定する（運用手順は運用設計が持つ。退役デプロイの直前に checkpoint を再読することも同じ手順に含める）
- **(RI-5) 直列化**: 2種類のローテーションは同時に進行しない（開始条件の相互拒否）。移送される行の `encryptionGeneration` は常に active である
- **(RI-6) 鍵の閉じ込め**: 注入された鍵はコミットメント照合を通ったときだけ使われ、bucket に永続化されない（C2）。平文 canonical は bucket の外へ出ない（C1）
- **(RI-7) 退役の証明**: 旧鍵の退役は「`rotationKind` で絞った checkpoint が対象世代の全 bucket に存在し、すべて `previousCount = 0`」でのみ成立する。**「全 bucket」の N は、`remap` では退役対象世代のエントリの `bucketCount`、`encryption` では active 写像世代の `bucketCount` である**
- **(RI-8) 巻き戻しの対称性**: 巻き戻しは世代ロールを入れ替えた通常の移送であり、専用の状態・専用の規則を持たない。**巻き戻しで偽になる順方向の checkpoint は、専用の無効化手順ではなく「退役証明の無効化」の一般規則（行を増やす書き込み — 予約・import・再暗号化の書き換え — が、増えた行の属する世代の checkpoint を同じトランザクションで消す）が消す**ので、この対称性は checkpoint についても専用規則なしで保たれる

### 機械検証

リポジトリルートで実行する。出力が期待と食い違ったら、直すのは表・本文の側である。

```bash
# 検査1: 干渉表の行数（ヘッダ・区切りを除く）= cross-DO saga の前進（async の全数表の類型欄）+ 非 saga 経路 4
saga=$(grep -c -F '| local job（cross-DO saga の前進）' spec/async/index.md)
rows=$(awk '/^## saga との干渉/,/^## 鍵漏えい/' spec/rotation/index.md \
  | grep -c '^| ')
# rows にはヘッダ1行が含まれるので、期待は rows - 1 == saga + 4
echo "saga=$saga rows=$rows"; [ $((rows - 1)) -eq $((saga + 4)) ] && echo OK || echo NG

# 検査2: CAS 述語は2つ・正本判定は5分岐・RPC エントリは4つ（定義表・引数応答表とも）・不変条件は8本
[ "$(grep -c '^| [12] | 移送' spec/rotation/index.md)" -eq 2 ] && echo OK || echo NG
[ "$(grep -c '^| ([a-e]) |' spec/rotation/index.md)" -eq 5 ] && echo OK || echo NG
[ "$(awk '/^### RPC エントリの全数/,/^### 引数と応答/' spec/rotation/index.md | grep -c '^| `')" -eq 4 ] && echo OK || echo NG
[ "$(awk '/^### 引数と応答/,/^### 1クレデンシャル/' spec/rotation/index.md | grep -c '^| `')" -eq 4 ] && echo OK || echo NG

# 検査2b: 干渉表の列軸（経路 + 移送4状態 = 5列）
[ "$(awk '/^## saga との干渉/,/^## 鍵漏えい/' spec/rotation/index.md | grep -m1 '^| 経路' | awk -F'|' '{print NF-2}')" -eq 5 ] && echo OK || echo NG
[ "$(grep -c '^- \*\*(RI-' spec/rotation/index.md)" -eq 8 ] && echo OK || echo NG

# 検査3: rotate-remap が jobs.kind / event.type の全数表（async/index.md）に現れないこと
[ "$(grep -c 'rotate-remap' spec/async/index.md)" -eq 0 ] && echo OK || echo NG
```

- 干渉表へ行を足す・消すときは、対応する側（async/index.md の cross-DO saga の行、または本節の非 saga 経路の列挙）を同時に直す。検査1がその取り残しを検出する

## 受容した残余

- **移送窓の濫用抑止カウンタの欠落**: 移送元に遅延して届いた失敗カウントは、移送先スナップショットが正本化する過程で失われうる。天井・時間減衰・非加算の3規則の枠内であり、ローテーションは operator 起動の稀事象なので受容する
- **旧 bucket 宛リセットリンクの失効**（前提7）と**窓の一度きりの二重リセット**（database/index.md `reset_request_windows`）: 既存の受容判断のとおり
- **世代プローブの回数差**: ローテーション中（previous が keyring に載っている間）に限り、未認証経路の lookup が「active でヒット = 1回 / それ以外 = 2回」のプローブ回数差を持ち、窓の外で観測できる時間側の残差になる（database/index.md「lookup の世代順序」）。ローテーションは operator 起動の稀事象であり、露出は移送の完了までに限られるので受容する
- **`credentialVersion` 照合の一時不一致**: 両在状態で片側だけに credential 変更が完走した直後、もう片側の複製でログインを試みると fail closed に落ちる。次のチャンクの収束で解消し、認可が開く方向には倒れない
- **`credential_locators` の余剰世代行**: 回収しない（理由は「1クレデンシャルの移送」の項）
- **移送先の複製が旧検証材料を返す短窓**: s4 の読み直し後の in-flight 窓に credential 変更の phase 1 が移送元へ着地すると、変更前スナップショットの複製が active 側に立ち、**phase 2 が `credentialVersion` を進めるまでのあいだ旧パスワードの照合が成立しうる**（fail closed の中間状態「旧新どちらも通らない」がこの交錯に限り弱まる）。発火には in-flight 窓への正確な着地が要り、解消は phase 2 の前進（login step の `credentialVersion` 不一致）または次チャンクの分岐 (c) である。saga が phase 2 の前に終端した場合は `resume-credential-change` の終端規則の範囲で閉じる（`changeState='pending'` なので後始末の C1 が巻き戻し、`poison` にも operator エスカレーションにもならない。[recovery/index.md](../recovery/index.md)）

## 引き継ぎ

- **運用**: maintenance 経路の到達制御・実行前承認・監査様式、チャンクサイズと駆動の反復手順（**決定材料に、チャンク中の cross-DO RPC — s3 の `record-remapped-locator` と s4 の import — が共有 bucket と User Data DO を占有する時間を含める**）、退役判定の運用手順（`read-rotation-checkpoint` の集計と、退役デプロイ直前の checkpoint 再読）、**Identity Directory bucket を PITR で復元した場合の checkpoint 無効化と移送の再駆動**（RI-4 の限界）、**「cross-DO RPC の実行寿命に platform 仕様として上限が実在すること」の確認と実値**（削除の no-op 確定の再発行間隔の下限材料）、ローテーション直後のリセットリンク失効の告知、衝突分岐 (e) の対応手順、両鍵同時漏えい時の順序
- **自動回収（引き継ぎではなく決着済みの相手である。正本は [recovery/index.md](../recovery/index.md)）**: 本設計は回収の入力（`callerToken` / `targetLocators` / コーディネーター予約行の保全）を変更しない。移送は見送り（s1 / s3）によって未完了 saga の材料に触れず、**回収の各段が消す行（コーディネーター予約行 / `active` な孤児写像）はいずれも s1 の行ローカル見送りか s3 の locator 実在検査に落ちるので、移送と回収が同じ行を取り合わない**
- **実装**: 本ファイルの RPC 4エントリ・予約の世代ガードと退役証明の無効化・**削除の no-op 確定（`sweep-orphan-mapping` / `finalize-withdrawal` の完了判定の変更）**・直列化ガード・`rotate-encryption` の条件付き UPDATE・コミットメント変数・`encrypted_canonical` / `caller_token` の NOT NULL 化と lookup の世代順序（database/index.md）・`record` の全行最大規則と `advanceCredentialVersion` の戻り値契約（domains/identity.md）の実装

## 鍵材料の配布形

- 2 世代を運ぶ変数は JSON の配列 3 つである: `DIRECTORY_ROUTING_KEYRING`（request Worker。`[{ role, generation, key, bucketCount }]`）、`DIRECTORY_KEY_COMMITMENT`（state Worker。`[{ role, generation, keyDigest, bucketCount }]`）、`IDENTITY_MAIL_ENCRYPTION_KEYRING`（state Worker。`[{ role, generation, key }]`）。`role` は `active` / `previous`。
- 未設定なら従来の単一変数（`DIRECTORY_ROUTING_SECRET` / `IDENTITY_MAIL_ENCRYPTION_KEY`）から `active` の generation 1 だけを組む。配列が設定されていれば単一変数は読まない。
- 世代ガードで拒否された予約は `SystemError(ConfigurationError)` になる（利用者には一様なエラー）。予約を書くのは request 経路（新規登録 saga の各 credential と SSO 連携）だけで、`resume-signup` / `resume-link` の再駆動は予約を書き直さず activate / commit / record を再実行するので、ジョブ経路が世代ガードに当たる経路は無い。
