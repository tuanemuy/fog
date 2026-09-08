# cross-DO saga の終端と自動回収の設計

cross-DO saga の前進ジョブが前進不能に達したときの**終端の段・自動回収（巻き戻し）の手順・材料の寿命・operator 経路への受け渡し・不変条件の正本**。「何が残り、誰がいつ回収し、回収が失敗したらどうなるか」はここで決まり、載せた機構の物理形（列・CAS・backoff・prune・索引）は [database/index.md](../database/index.md)、`kind` の全数と類型は [async/index.md](../async/index.md) が持つ。

- 関連: [database/index.md](../database/index.md)（`jobs` / `credential_mappings` / `operations` / `account` の物理形、operator 専用 maintenance 経路、migration ゲート） / [async/index.md](../async/index.md)（3類型の全数表。**本ファイルは新しい `kind` も `event.type` も足さない**） / [domains/identity.md](../domains/identity.md)（`CredentialMappingRepository` の操作表） / [usecases/identity.md](../usecases/identity.md)（各 saga の手順） / [rotation/index.md](../rotation/index.md)（2世代並存中の見送り。本ファイルは単一世代を前提に書き、世代の数え方だけをあちらから借りる）
- 役割分担: **本ファイルが終端の段・回収の手順・材料の寿命・不変条件の正本である。** `kind` の全数は async/index.md、物理形は database/index.md が持ち、二重に持たない。**`abandon-account` / `cancel-reservation` の呼び出し規約は本ファイルが持つ**（spec/ 側に saga の RPC エントリの全数表は無く、operator 専用経路の全数だけが database/index.md にある）
- 層の帰属: **後始末の段は前進の段と同じ層に属し、本ファイルはその帰属を新しく決めない。** 帰属を分けられないのは、**前進を実行するか後始末を実行するかを行ごとに決めるのがジョブ本体そのものだから**である（下の「段の選択規則」）。`resume-*` の前進側は台帳上アダプター（DO のジョブランナー）にしか行を持たない既存の状態にあり、**後始末もそれに揃えて `spec/inventory/adapter.md` に置く。** そう置ける根拠は、**判断の実体が段の外にあること**である — 「放棄してよいか」は `abandon-account` の評価順序が、「その行に触れてよいか」は `cancel-reservation` と S4 / L3 / C1 の CAS 述語が持ち、**段が持つのは順序と失敗の扱いだけである。** **`purge-trash` と扱いが違うのは、`purge-trash` が「ゴミ箱の期限切れを消す」という業務判断そのものを段の中に持つのに対し、`resume-*` の段は判断をすべて RPC エントリと CAS 述語の側へ出していて順序と失敗の扱いしか持たないからである** — 台帳の行は判断の置き場に立つ。この扱いの差を自覚したうえで据え置き、**saga のジョブ本体の層帰属そのものを見直すかは実装が決める**（既存の帰属の据え置きであり、新しく生じた論点ではない）

## 前提（本ファイルは再検討しない）

1. cross-DO saga は再開可能な saga + 冪等な補償で組む。DO 間に分散トランザクションは無く、**`transactionSync` に入れられるのは自 DO のローカル書き込みだけで、cross-DO RPC はその外である**
2. 前進不能の**発火条件**は「`ConflictError` で確定した」または「バックオフ上限に達した」であり、`ConflictError` に限定しない（`.overloaded` は攻撃者が誘導できるので例外事象として扱えない）
3. 分類 (C)（一回性）のジョブは `done` を復活させない。`poison` は「その saga がもう誰にも前進させられない」ことを意味する — **これは自動の前進経路が無いという意味であって、投入点からの再投入と operator の再投入は収束規則が許している。後始末を持たない `kind` と `change_state='advanced'` の行では、その再投入が前進そのものの再開になる**（下の「終端の2段構造」の段の選択規則）
4. 終端は一様である — `terminal_reason` を残して `poison` にし、operator 経路へエスカレーションする。**「黙って中間状態を残す」は選ばない** — **その「終端」の具体形は本ファイルが2段構造として定める**。後始末を持つ行は `poison` の前に終端モードを1段挟み、後始末が完走すれば `done` で終わって operator へは渡らない（下の「終端の2段構造」）
5. `jobs.payload` と `terminal_reason` に PII と再利用可能な秘密を入れない。**したがって `callerToken` をジョブ行へ退避する形は採れない**
6. **どの中間状態でも認可は fail closed に倒れる**（射程は本設計が作る中間状態。PITR はその外側）
7. 回収の材料は既に存在し、置き場が決まっている — コーディネーター予約行の `locators` / `candidate_user_id` / `caller_token`、`operations.target_locators`、`account.caller_token`、`credential_mappings.change_state` の3値
8. 回収に使えるエントリが存在する — `purge-user-mappings`（`userId` をキーに取る）と `cancel-reservation`（`status` を問わない削除。**ガードは locator による名指し + `callerToken` + `credentialId` の一致である** — 理由は下の「後始末が使う RPC エントリ」）。**`cancel-reservation` は operator 経路ではなく saga の内部エントリである** — `callerToken` を返す口が利用者のセッションを要する経路しか無い以上、operator は単独で実行できないからである（下の「後始末が使う RPC エントリ」と database/index.md「operator 専用 maintenance 経路」）
9. 単一世代（ローテーション未実行）を前提に書く。2世代並存中の相互作用の正本は [rotation/index.md](../rotation/index.md) であり、本ファイルが「全世代へ発行する」と書くのは単一世代では1本に退化する

### 段の記法

本ファイルは3系統の記法を使うので、対応を先に固定する。**新しい段番号を導入しているのは S / L / C だけである。**

| 記法 | 何を指すか | 対応 |
|---|---|---|
| S1〜S4 / L1〜L3 / C1 | **本ファイルが定義する後始末の段** | 下の「kind 別の後始末の段」 |
| phase 1a / 1b / 2 / 3 / 4 | 新規登録 saga の段（`spec/database/index.md` が `initialize-account` を「phase 2」と呼ぶ形で既に使っている） | `spec/usecases/identity.md` の `registerWithPassword` の手順との対応は **phase 1a / 1b = 手順4（予約の獲得）/ phase 2 = 手順5（ユーザー単位設定側の初期化）/ phase 3 = 手順6（予約の確定）/ phase 4 = 手順7（逆引きの記録）**。`registerOrLoginWithSso` では順に 手順3 / 手順4 / 手順5 / 手順6 である |
| 手順N | 各ユースケースの手順番号 | `spec/usecases/identity.md` が正本 |

## 終端の2段構造

**前進不能が確定したジョブを、その場で `poison` にしない。** 同じジョブ行が**終端モード**へ入って後始末（自動回収）の段を実行し、**その後始末が焼き切れるか材料を見失ったときに初めて** `poison` へ落ちる。

### 終端モードの定義と印

**終端モードとは、`jobs` 行が `status IN ('pending','running')` かつ `terminal_reason IS NOT NULL` である状態である。** これは**前進不能が確定した事実の記録**であり、`attempt` を仕切り直して後始末に前進と同じ予算を与えるための印である。

**どの段を実行するかは2段で決まる。**

1. **`terminal_reason IS NULL` なら前進を実行する。** 前進不能はまだ確定していないので、後始末の段が実在するかは判定に入らない
2. **`terminal_reason IS NOT NULL`（= 終端モード）なら、「後始末の段が実在するか」で選ぶ** — 実在するなら後始末だけを、実在しないなら前進を実行する。**判定の材料は `kind` と、`resume-credential-change` だけは行の状態（`change_state`）である**（下の kind 別の段）

- **1. を落とすと saga が開始した瞬間に自分を巻き戻す。** `resume-credential-change` は `beginCredentialChange`（`change_state='pending'` を書く段）と同じトランザクションで投入されるので、**最初の起床で行の状態だけを見ると「`'pending'` には C1 が実在する」→ 巻き戻しを実行する** — クレデンシャル変更とリセットが一度も前進しない
- **2. で「後始末の段の実在」を見る理由は2つある。** (1) `requeue-poisoned-job` と再投入の収束規則 (2) は `kind` を問わず `terminal_reason` を残したまま `pending` へ戻すので、**印の有無だけで段を決めると、後始末を持たない `kind` と `change_state='advanced'` の行が「実行すべき段が無いのに前進もしない」状態で止まる** — `'advanced'` 残渣の唯一の受け口（operator が原因を解消して再投入する）がそこで閉じなくなる。(2) 突入そのものも `kind` 単位では決まらない（`resume-credential-change` は `'pending'` のときだけ突入する）
- **終端モードで後始末の段が実在する `kind` / 状態では、前進を1段も実行しない。** `resume-signup` / `resume-link` は常に後始末を持つので、突入後に前進を実行することは無い（RC-2）

- **印は `jobs.terminal_reason` を前倒しで書くことで置く。** 列は既にあり（database/index.md）、両 DO クラスの `jobs` が同じ11列を持つので、**`operations` 表を持たない Identity Directory bucket でも同じ形で成立する** — これが「`resume-link` が使える印が `resume-signup` には無い」という非対称の解消である
- **印と駆動が同じ行にある。** 前進を駆動しているのはジョブ行そのものなので、「印だけが失われる」「印だけが残る」という非対称が構造的に生じない
- **印を `NULL` へ戻す経路を持たない**（RC-2）
- **突入の書き込みが起きるのは、後始末の段が実在するときだけである。** 後始末を持たない `kind`（下の全数表）と `change_state='advanced'` の行では突入せず、前進不能の確定はその場で `poison` になる
  - **したがって `poison` 行の `terminal_reason` は3種類ある** — 前進の確定で落ちた行（`forward-*`。突入を経ずに落ちた行と、終端モードの行の前進が再確定した行の両方がここに入る）、後始末が焼き切れて落ちた行（`cleanup-exhausted:*`）、後始末が材料を見失って落ちた行（`cleanup-material-lost:*`）である。**この値から段の選択も再開位置も導かれない** — 再駆動が何を実行するかは、そのときの行の状態に後始末の段が実在するかだけで決まり（上の 2.）、値が伝えるのは operator の行動の分かれ目だけである（理由トークンの表）。**「終端モードだから後始末を実行する」と印だけで判定する実装・観測手段は、後始末を持たない2 `kind` と `'advanced'` の行で誤検出する** — 受け口が閉じる根拠は値ではなく段の選択規則のほうである

**代替案を3つ棄却した理由**:

- **`operations.phase` に終端値を足す** — `operations` は User Data DO にしか無いので（database/index.md）、`resume-signup` / `resume-credential-change` で成立しない。所有 DO が `kind` ごとに割れるという非対称そのものである
- **予約行 / mapping 行に列を足す** — `resume-link`（User Data DO 所有）に効かず、印の置き場が `kind` ごとに割れる。割れると「印を読む段」を kind ごとに書き分けることになり、下の段の表が1つの形で書けない
- **`jobs.payload` に持つ** — `payload_digest` の照合対象が「`next_run_at` を除いた payload」なので、印を書くたびに digest がずれ、投入点からの再投入が `ConflictError` になる（database/index.md の digest 規則）

### 終端モードの各契機で書く列（全数）

**7つでこれが全数である**（突入と段の失敗が1行ずつ、後始末の終わり方が完走・焼き切れ・材料の喪失の3行、**終端モードの行の前進の終わり方**が完走・再確定の2行である）。いずれも `jobs` の既存の「backoff と終端」の形に乗り、新しい列を足さない。

| 契機 | `status` | 書く列 | `terminal_reason` |
|---|---|---|---|
| **終端モードへの突入**（前進不能の確定） | `pending` | `attempt = 0` / `next_run_at` は**通常の backoff 規則が `attempt = 0` について定める値**（**新しい運用値を置かない**。次のバレット） / `lease_until = NULL` / `owner_token = NULL`。**`completed_at` は書かない**（終端していない） | 前進の理由トークンを書く |
| **終端モードの段の失敗**（上限未到達。**後始末・前進のいずれも**） | `pending` | 通常の backoff と同じ — `attempt` を進め、指数バックオフで `next_run_at` を先送りし、`lease_until` / `owner_token` を解放する | 変えない |
| **後始末の完走** | `done` | `completed_at = now` / `lease_until` / `owner_token` / `next_run_at` を `NULL`（既存規則） | **残す**（後始末を通って完了した記録である） |
| **後始末の焼き切れ**（上限超過） | `poison` | 同上（既存規則） | `cleanup-exhausted:` を冠した値へ差し替える |
| **後始末の材料の喪失**（S1 / L1 が材料の行を引けない、または `credential_id` が一致しない） | `poison` | 同上（既存規則）。**`attempt` が上限未満でも落とす** — 再試行しても同じ判定を繰り返すだけだからである | `cleanup-material-lost:` を冠した値へ差し替える |
| **終端モードの行の前進の完走**（**後始末の段が実在しない状態の行**が前進を実行し、通った場合） | `done` | 同上（既存規則） | **残す**（前進不能を一度確定させた事実の記録である） |
| **終端モードの行の前進不能の再確定**（後始末の段が実在しない状態の行の前進が、再び `ConflictError` で確定するかバックオフ上限を超えた場合） | `poison` | 同上（既存規則） | **新しい前進の理由トークンへ差し替える**（冠は付けない） |

- **前進の完走・再確定の2行が要る理由。** `terminal_reason` を `NULL` へ戻す経路が無い（RC-2）ので、**後始末の段が実在しない状態の行は、終端モードの定義を満たしたまま前進を実行する** — これは `'advanced'` 残渣と後始末を持たない2種の受け口そのものであり、設計が正面から意図している経路である（下の段の選択規則）。**この状態への到達は再投入（`requeue-poisoned-job`・投入点からの収束規則 (2)）に限らない** — `'pending'` で突入した行が、次の起床までのあいだに後勝ちの差し替えで `'advanced'` になった場合も、再投入なしにここへ入る（そのときの前進は CAS の `operation_id` 不一致により何も書かずに完走 = `done` で終わる）。前進が通れば `done`（完走の行。書く列は「後始末の完走」と同じだが、**契機と `terminal_reason` の意味が違うので行を分ける**。**冠の付かない `forward-*` のまま `done` になるのはこの行だけである**）、再び前進不能が確定すれば `poison`（再確定の行）になる。**再確定の到達順序は正規の運用経路そのものである** — 原因が実は解消していないまま再投入された行がこれに当たる（`forward-conflict` は再投入で回復しない場合がある。理由トークンの表）
- **再確定では `terminal_reason` を新しい前進の理由トークンで置き換える。** operator の行動を分けるのは**現在の**原因だからである（`forward-exhausted` で終端した行が再投入後に `forward-conflict` で再確定したなら、案内は「再投入で回復しない場合がある」の側へ移る）。据え置くと、記録が最初の原因を指したまま現在の原因が読めなくなる。置き換える値は冠の付かない `forward-*` の2値なので、**何度再確定しても値域6値（RC-9）は破れない**
- **冠を付ける対象は前進の理由トークンであって、現在の `terminal_reason` の値ではない。** 現在値に冠すると、`cleanup-material-lost:*` の行を再投入して同じ判定に落ちたとき（正規の運用経路）に `cleanup-material-lost:cleanup-material-lost:forward-conflict` が生まれ、値域6値（RC-9）が破れる。**何度終端し直しても値は6値のいずれかに収まる**
- **突入で `attempt` を 0 に戻す理由。** 戻さないと後始末は指数バックオフの天井付近の間隔から始まり、回収が完了するまでの総経過時間が予約 TTL の不等式（後述）を無用に押し上げる。**戻すことで後始末は前進と同じ回数・同じ backoff 曲線の予算を持つ**ので、**後始末の再試行上限は前進と同じ値である**（別の運用値を新設しない）。総経過時間の上界は「前進の総経過時間 + 後始末の総経過時間」の2項の和になる
- **突入に待ちを1つも挟まない。** `attempt = 0` から始まる通常の backoff 曲線が最初の待ちを決めるので、**突入のためだけの運用値（「終端モードの再開猶予」のようなもの）を新設しない。** 挟めば予約 TTL の右辺が第3項ぶん伸びて canonical の拘束時間が延びるうえ、**`resume-credential-change` の `'pending'` 残渣では利用者のログイン不能がその猶予のぶん延びる** — C1 の失敗の契機は前進の契機と同一でない（下の全数表）ので、待たせて成功率が上がるわけでもない。**待ちを増やす必要が実測で出た場合の置き場は既存の backoff 曲線の実値であって、新しい名前ではない**
- **突入は自 DO のローカル書き込み1回で完結する。** cross-DO RPC を含まないので、突入そのものが前進不能の原因で失敗することは無い（原因が自 DO の書き込み失敗である場合を除く。そのときは後始末も書けないので、次の起床が同じ判定をやり直す）
- **`done` でも `terminal_reason` を残す。** `done` かつ `terminal_reason IS NOT NULL` の行は「**前進不能を一度確定させた行が、後始末の完走または再投入後の前進の完走で終わった**」を表す（上の表の「後始末の完走」と「前進の完走」の行。**どちらであるかは `terminal_reason` の値では区別できず、冠の有無は後始末を通ったかを表すだけである**）。この行は保持期間を過ぎたら prune で消えてよい（残渣が無いので記録を恒久保持する理由が無い）
- **`poison` 行は prune されない**（後述）

### `terminal_reason` の理由トークン（全数）

**6値でこれが全数である**（前進の理由2値 × 後始末の終わり方3通りのうち、後始末を通らない場合と通って焼き切れた場合と材料を見失った場合）。`terminal_reason` に載るのはこのトークン1つと `operationId` だけである（区切りの形式は実装裁量）。

| トークン | 意味 | 書く契機 |
|---|---|---|
| `forward-conflict` | 前進が `ConflictError` で確定した | 終端モードへの突入（後始末あり）／`poison`（後始末なし。**終端モードの行の再確定を含む**） |
| `forward-exhausted` | 前進のバックオフ上限を超えた | 同上 |
| `cleanup-exhausted:forward-conflict` | 上の前進理由のうえで後始末も焼き切れた | `poison`（後始末ありの3種だけ） |
| `cleanup-exhausted:forward-exhausted` | 同上 | 同上 |
| `cleanup-material-lost:forward-conflict` | 上の前進理由のうえで後始末が材料を見失った | 同上 |
| `cleanup-material-lost:forward-exhausted` | 同上 | 同上 |

- **前進の理由を上書きせず残す形にしてある。** operator の行動が分かれるからである — `forward-exhausted` は基盤側の状態なので原因を解消してから再投入すれば回復し、`forward-conflict` は**再投入で回復しない場合がある**（canonical を他の利用者に取られた形がそれで、そのときは利用者の再操作でしか閉じない）
- **材料の喪失を焼き切れと同じトークンに畳まない。** 畳むと operator は**再投入しても S1 / L1 が同じ判定を繰り返すだけの行**に対して「原因を解消してから再投入する」という受け口の案内を適用し、同じ結果を無限に繰り返す。`cleanup-material-lost:` の行に対する operator の行動は**残渣の実物を確かめたうえでの明示削除**であり、再投入ではない（下の「operator 経路への受け渡し」）。トークンを増やすぶん運用系への露出は増えるが、**露出するのは「材料が消えていた」という事実だけで、残渣の所在も canonical も含まない**
  - **`forward-conflict` は `ConflictError` の種別を区別しない。** 一意性違反（`EMAIL_ALREADY_REGISTERED` など）と OCC 不一致（`OPTIMISTIC_LOCK_FAILURE`）が同じトークンに畳まれる。**OCC は再投入で回復しうる**ので、上の案内が「回復しない場合がある」という緩い形になっているのはこのためである。識別が落ちることは「受容した残余」に列挙する（トークンを増やすと、`terminal_reason` から読み取れる失敗の内訳が細かくなるぶん運用系への露出も増える）
- **載せないもの**（非露出対象）: canonical / `hmac` / locator / `callerToken` / `changeAuthToken` / `passwordVerifier` / リセットトークン。加えて PII と再利用可能な秘密（`jobs.payload` と同じ制約）
- **残渣の所在を載せない。** locator は PII でも秘密でもないが非露出対象であり、`terminal_reason` は運用系へ素通しされるので、載せた瞬間に bucket 分割の写像が運用面へ出る。**代わりに残渣は残渣そのもの（保全された行）から辿る** — 下の「材料の寿命」が、その行が消えないことを保証している
- **`change_origin` を載せない。** 起点は mapping 行が `change_origin` 列として持っており、載せると同じ値の写しが2箇所になる

## 回収の全数表

**cross-DO saga を前進させる `kind` は5種であり、これが全数である**（類型欄の正本は [async/index.md](../async/index.md)）。**そのうち後始末（自動回収）を持つのは3種である。**

| kind | 所有 DO クラス | 終端時に残りうる中間状態 | 後始末 | 段 | 向き | 後始末の cross-DO RPC | 前進と後始末の契機の同一性 |
|---|---|---|---|---|---|---|---|
| `resume-signup` | Identity Directory（コーディネーター bucket） | `credential_locators` に対応行を持たない **`active` な孤児 mapping**（phase 3 の部分成功）/ 未昇格の **`reserved` 行**（phase 1b の途中）/ phase 2 が成功していれば**ログイン手段を持たない `active` アカウント**（phase 4 未了）/ コーディネーター予約行。**孤児 mapping と `reserved` 行は同じ bucket に同居しうる** | あり | S1〜S4 | 巻き戻し（放棄） | 含む | 同一 |
| `resume-link` | User Data | **`active` な孤児 mapping**（手順3→4 の落下）/ **`reserved` 行**（手順2〜3）/ `phase != 'done'` の `operations` 行（`kind='link'`） | あり | L1〜L3 | 巻き戻し | 含む | 同一 |
| `resume-credential-change` | Identity Directory | `change_state` が `NULL` でない mapping 行（`'pending'` = phase 2 未適用 / `'advanced'` = 適用済み）と、それに伴う `pending_verifier` / `change_origin` / `operation_id` | あり | C1 | 巻き戻し（`'pending'` のときだけ。`'advanced'` では前進のみ） | 含まない | 同一でない |
| `finalize-withdrawal` | User Data | `account.status='deleting'` のまま mapping / `credential_locators` が残る | なし | — | 前進（**消すのはアカウントの到達性だけ** — 全世代の写像行、`credential_locators`、AI 接続の失効、交換済み認可コード、`caller_token` の抹消と `status='deleted'` / `deleted_at` の tombstone。メモ・トピック・ドキュメント・検索索引・`operations` は消さない） | — | — |
| `sweep-orphan-mapping` | User Data | unlink の **`active` な孤児 mapping** / `phase != 'done'` の `operations` 行（`kind='unlink'`） | なし | — | 前進 | — | — |

- **後始末を持たない2種は、前進そのものが回収である。** `finalize-withdrawal` は退会の削除の再試行、`sweep-orphan-mapping` は unlink の削除の再試行であり、**巻き戻す先が無い**（退会は不可逆な意思、unlink は User Data 側の削除が既に確定している）。前進不能が確定したら終端モードへ入らず、そのまま `poison` + operator へ落ちる
- **`sweep-orphan-mapping` は分類 (C) ではない**（残件駆動で再武装する5種の1つ。database/index.md）。それでも本表に入れるのは、**cross-DO saga の前進で終端時に残渣を持つのが5種で全数である**ことを1箇所で言うためである。`poison` に落ちても投入点（`unlinkSsoCredential`）からの再投入と `finalize-withdrawal` の引き取りという2つの復帰経路を持つ点だけが他と違う
- **「後始末の cross-DO RPC」欄は後始末の段が cross-DO RPC を含むかを、「前進と後始末の契機の同一性」欄は前進不能の契機と後始末の失敗の契機が同一かを表す**。`resume-credential-change` だけが「同一でない」のは、その後始末が cross-DO RPC を1本も含まないからである — この2欄が連動することは検査7 が突き合わせる

## kind 別の後始末の段

### `resume-signup` — 放棄（S1〜S4）

| 段 | 実行場所 | 内容 | 原子性境界 |
|---|---|---|---|
| S1 | コーディネーター bucket（ローカル読み） | **自 bucket のコーディネーター予約行を locator の PK（`kind` + 全長 HMAC）で引き、その行の `credential_id` が payload の locator の `credentialId` と一致することを確かめる**（locator は `resume-signup` のジョブ payload が持つ。`sweep-orphan-mapping` が対象 locator を payload に持つのと同じ形である）。通れば `locators` / `candidate_user_id` / `caller_token` を材料として確定する。**`operation_id` で引かない**（次のバレット）。**行が無い、または `credential_id` が一致しない場合は材料が失われているので、`jobs` 行を `poison` へ落として operator へ渡す**（`done` にしない。下の「材料が失われていた場合」） | 読み（材料の喪失に落ちたときだけ `jobs` 行の終端を1回書く） |
| S2 | → User Data DO（RPC） | `candidate_user_id` の User Data DO へ **`abandon-account`**（引数 `operationId` + `callerToken`）を発行する。**応答は3分岐で、次段への進み方が分かれる** — `abandoned` / `nothing-to-abandon` は成功として S3 へ進み、**`already-completed`（その saga は完走している）なら S3 / S4 を実行せずに `jobs` 行を `done` にして終わる** | RPC はトランザクションの外。`abandon-account` の内側は User Data DO の1つの `transactionSync` |
| S3 | → 各 Directory bucket（RPC） | `locators` の**コーディネーター行以外の全要素**へ **`cancel-reservation`**（引数は**その要素の locator の全量 + `callerToken`**）を発行する | 要素ごとに独立。宛先が自 bucket になる要素はローカル操作になるが扱いは同じ |
| S4 | コーディネーター bucket（ローカル書き） | S3 が全要素について成功したことを確認したうえで、**自 bucket のコーディネーター予約行を `cancel-reservation` と同じ形で消すのと、`jobs` 行を `done` にするのを、1つの `transactionSync` で行う** | 1つの `transactionSync` |

- **S2 → S3 の順序を入れ替えてはならない。理由は2つある。** **(1) 逆順にすると**、canonical を解放した後に「ログイン手段を持たない `active` アカウント」だけが残る窓ができ、そのアカウントは `credential_locators` が空なので **`list-bucket-user-ids` からも到達できない**（同エントリが返すのは mapping を持つ `userId` である）。**発見不能な残渣を作る向きは採らない。** S2 を先に置けば、S3 が恒久的に止まっても残るのは mapping であり、「その canonical が再登録不能である」ことが利用者と operator の両方から観測できる。**(2) S2 は「完走の検出」を兼ねる** — 次のバレットのとおり、後始末を実行してよいかを決める権威はコーディネーター bucket のローカル状態には無く、S2 の応答だけがそれを持つ
- **後始末の可否をコーディネーター予約行の存在で判定してはならない。** その行は saga が**完走しても消えない** — phase 3（予約の確定）は行を `status='active'` の写像へ昇格させるだけで、行を消す経路は S4 しか無い（下の「材料の寿命」）。したがって「完走した登録」と「phase 3 の部分成功」はコーディネーター bucket のローカル状態だけでは区別できず、**区別せずに後始末を走らせると、完走して利用者が使っているアカウントの写像を全削除して恒久的にログイン不能にする**（しかも後始末は `done` で終わるので `poison` の恒久保持にも載らず、記録すら残らない）。**発火する順序は実在する** — 手順7 のコミット後に応答が失われ（本ファイルが phase 2 について既に認めている事象クラス）、その後 User Data DO が上限まで到達不能になると、完走済みの saga が終端モードへ入る。**したがって S2 の `already-completed` が唯一の防壁であり、その材料（User Data DO 側の `operations` 行の `phase`）は下の「後始末が使う RPC エントリ」が要求する**
- **`already-completed` を受けたら S4 も実行しない。** 完走した saga のコーディネーター行は利用者の生きた写像そのものなので、消してはならない
- **S3 の除外単位は行であって bucket ではない。** `locators` はコーディネーター行の locator も含むので S3 は1要素を除外するが、**除外の述語は `credentialId` の一致であって bucket の一致ではない** — SSO 登録は2つの canonical を持ち、その2つが同じ bucket に落ちることが起きる（分割数ぶんの確率で必然的に起きる）ので、bucket 単位で除外すると同居した2行目が恒久的に残る
- **材料を引く鍵は不変列でなければならない。`operation_id` は可変列なので鍵にしない。** 同じ写像行の `operation_id` は**クレデンシャル変更 saga の開始（`beginCredentialChange`）が上書きする**（database/index.md の列定義）。孤児写像が `passwordVerifier` を持つ場合、後始末の待ち時間のあいだにその canonical 宛のリセットが始まりうる（「受容した残余」の1件目）ので、**`operation_id` で引く実装は材料を見失い、S1 が「行が無い」と読んで残渣を恒久化する。** locator は移送以外で書き換わらず、その移送も進行中の saga の行を動かさない（rotation/index.md の s1 / s3 の見送り）ので、**PK が唯一の安定した鍵である**
- **同定は `credentialId` で行う。PK だけでは足りない。** locator の PK（`kind` + 全長 HMAC）は **canonical の同一性**であって saga の同一性ではないので、**掃除や退会・解除で canonical が空いた後に別の saga が同じ PK の行を作れる**（`sweep-reservations` が `saga_committed` の無い `reserved` 行を消す / `deleteMapping` が写像行を消す）。そのまま材料に採ると、**`poison` からの再駆動が別人の完走した登録の写像を全削除しうる**（S2 は `nothing-to-abandon` に落ちて S3 へ進み、S3 / S4 は `callerToken` が行から読んだ値なので一致してしまう）。**`credential_id` は行の作成時に決まって書き換わらず、登録のやり直しでは新しい値が採番される**ので、不変性と同定性の両方を満たす唯一の材料である
- **材料が失われていた場合（S1 が行を引けない、または `credential_id` が一致しない場合）は `poison` へ落とす。** そこで `done` にすると**残渣が残ったまま唯一の記録（`poison` 行）が消える** — RC-1 / RC-3 が同時に破れる。`terminal_reason` は `cleanup-material-lost:` を冠した値へ差し替え、operator は残渣の実物（canonical が再登録不能であること）から辿る
  - **到達する順序は「材料の行が消えた」か「同じ PK に別の行が入れ替わった」かの2類で、そこへ至る経緯を数え上げない。** 経緯には少なくとも次がある — **(a) 掃除に先を越された**（予約 TTL の不等式は後始末が完走するまでを覆うが、`poison` からの再駆動の時刻には設計上どこにも束縛が無いので、operator の反応が TTL より遅ければ起きる。**phase 2 に一度も到達しなかった saga の予約行は `saga_committed` を持たないので、掃除の作業述語にそのまま当たる**）、**(b) 完走した saga のコーディネーター行が、突入から後始末までのあいだの退会・SSO 解除で消えた**（完走した saga が終端モードへ入る順序は実在する。下の S2 の項）、**(c) canonical が空いた後に別の saga が同じ PK の行を作った**（`credential_id` の不一致で弾かれる）。**残渣が実在するかどうかは経緯によって分かれ、行からは区別できない** — (a) では実在し、(b) では別の経路が既に片付けている。**したがって operator の手順は経緯によらず「残渣の実物を確かめてから明示削除する」の1本である**（「受容した残余」に列挙する）
- **段のカーソルを永続化しない。** S1〜S4 はすべて冪等（`abandon-account` は `account.status` の CAS、`cancel-reservation` は「無ければ成功」）で、**作業述語そのものが進捗を表す** — **作業述語は「コーディネーター予約行が locator の PK で引けて `credential_id` も一致し、かつ S2 が完走を否定すること」であり**、S4 がその行を消す（`already-completed` の場合は後始末そのものが無い）。中断は次の起床が S1 からやり直す（`finalize-withdrawal` / `purge-trash` が永続カーソルを持たない根拠と同じ形である。database/index.md）
- **S2 の後の User Data 側は `finalize-withdrawal` が引き取る。** **退会 saga の段そのものは本 spec の範囲外である**（`spec/domains/identity.md` — 退会 saga そのものは本 spec の範囲外。`spec/database/index.md` — `finalize-withdrawal` の投入点は実装が DO の RPC 側で決める）ので、S2 について退会側との関係は**前提の言明**として書く — **放棄されたアカウントは `credential_locators` が空なので、退会側が逆引きから引く削除対象は0件であり、写像の削除は S3 / S4 が行う。** 退会側が写像を消せないことを前提にしてよい、という意味である（逆引きが空なので退会経路からは到達できない。これは要求ではなく帰結であり、**退会側への要求の全数は「材料の寿命」の3点である**）
- **1回の起床で発行する RPC は `locators` の要素数で有界である**（登録 saga は最大2 credential × 世代数）。チャンク分割を要しない
- **S4 の CAS 述語と0行時の扱い。** 述語は **`cancel-reservation` の CAS 述語（下の「引数と応答」の表）と同じものを、自 bucket の locator に対して発行する**（式を二重に持たない）。**0行は成功として扱い、同じ `transactionSync` で `jobs` 行を `done` にする**（S1 が引けた行を S4 が消すので0行は正常系では起きないが、二重実行では起きる）

### `resume-link` — 巻き戻し（L1〜L3）

| 段 | 実行場所 | 内容 | 原子性境界 |
|---|---|---|---|
| L1 | User Data DO（ローカル読み） | `operations`（`operation_id` 一致・`kind='link'`）を読む。**行が無ければ材料が失われているので、`jobs` 行を `poison` へ落として operator へ渡す**（S1 と同じ扱い。上の「材料の喪失」の行）。`phase='done'` なら後始末は空（退会側の引き取りが既に残渣を解放した形。下の「退会側への要求」の2点目がそれを保証する）であり、`jobs` 行を `done` にして終わる。そうでなければ `target_locators` と `account.caller_token` を材料として確定する | 読み（材料の喪失に落ちたときだけ `jobs` 行の終端を1回書く） |
| L2 | → 各 Directory bucket（RPC） | `target_locators` の全要素へ **`cancel-reservation`**（引数は**その要素の locator の全量 + `callerToken`**）を発行する | 要素ごとに独立 |
| L3 | User Data DO（ローカル書き） | 全要素の成功を確認したうえで、**`operations.phase='done'` を書くのと `jobs` 行を `done` にするのを、1つの `transactionSync` で行う。`target_locators` は空にしない** | 1つの `transactionSync` |

- **削除に `deleteMapping` ではなく `cancel-reservation` を使う。** `reserved` 行は `user_id` が未確定なので `deleteMapping` の「mapping 行の `userId` 一致」ガードを通れず、手順2〜3 の落下点の残渣を消せない。**削除エントリの選び方は残渣の由来で決まる、というのが規則である** — その saga 自身が書いた行（登録 / 連携の予約由来）は**呼び出し元が保存済みの座標として locator を持っている**ので、locator の名指し + `callerToken` + `credentialId` の一致で束縛できる `cancel-reservation`、既存の写像を消し損ねた残渣（解除 / 退会）は `userId` で束縛する `deleteMapping` である
- **終端モードへの突入判定は、退会競合の判定より後に置く。** `resume-link` は `account.status != 'active'` を観測したら `operations` に触れずジョブだけを `done` にする（既存規則）。**後始末を退会と並走させないためである** — 並走させると L2 が要求する `account.caller_token` を退会の完走が消しにかかり、材料の生存が下の「退会側への要求」だけに寄りかかる。**突入判定を後ろに置けば、退会が始まっている saga は前進側で1段も後始末を実行せずに `done` へ落ちる**（残渣の回収はそのまま退会側の引き取りが担う）。**逆に、突入が先に起きた後で退会が始まる順序は塞げない** — RC-2 により終端モードでは前進が1段も実行されず、L1 に `account.status` を読む述語は無いので、その窓は下の「退会側への要求」で閉じる
- **`target_locators` を空にしない。** 空にして得るものが無く（`caller_token` は別の行にある）、残せば二重発行の冪等性の材料として使える。前方互換点（`operations.target_locators` を消さない）はそのまま据え置かれる
- **L3 の CAS 述語と0行時の扱い。** 述語は `operation_id = この saga の値 AND kind='link' AND phase != 'done'` で、**0行は成功として扱いジョブを `done` にする**（退会側の引き取りが先に `phase='done'` を書いた形。二重に書かない）

### `resume-credential-change` — `change_state` で分岐（C1）

| 段 | `change_state` | 実行場所 | 内容 |
|---|---|---|---|
| C1 | `'pending'`（**phase 2 の適用が bucket 側に記録されていない**） | Identity Directory bucket（ローカル書き） | 1つの `transactionSync` で `pending_verifier` / `change_state` / `change_origin` / `operation_id` を `NULL` へ戻し、**同じトランザクションで `jobs` 行を `done` にする**。CAS 条件は **`change_state='pending' AND operation_id = <この saga の値>`** で、**0 行なら何も書かずに `done` にする** |
| （段を持たない） | `'advanced'`（phase 2 適用済み） | — | **後始末が無い。** 巻き戻さず、終端モードへ入らずそのまま `poison` + operator へ落ちる |
| （段を持たない） | `NULL` | — | saga は完走済み（phase 3 が解除した形）。既存規則どおり完了と読んでジョブを `done` にする。終端モードへ入らない |
| （段を持たない） | **行が無い** | — | 対象の写像行そのものが消えている（解除・退会・移送の完了などで先に消えた形）。回収すべき残渣が無いので、何も書かずにジョブを `done` にする |

**`'advanced'` からの前進は phase 2 を再発行しない。** `'advanced'` は phase 2 の**成功を受けてから**書く印（下のバレット）なので、この状態そのものが「phase 2 は済んでいる」の記録である。**再発行は冪等でない** — `advanceCredentialVersion` は「1つ進めて、進めた後の値を返す」単調増加カウンタなので（`spec/domains/identity.md`）、再発行のたびにユーザー単位設定側の版が1つ余分に進み、phase 3 が昇格した瞬間に両側の版がずれてログインが閉じる。**残っている前進は「現在の版を読み取って phase 3 を書く」だけである** — 版は `CredentialLocatorStore.findByCredentialId` の読み（cross-DO RPC。トランザクションの外）で取り直し、phase 3（`promoteVerifier`）がその値へ揃える。読みと書きのあいだの窓は次の CAS が閉じる。**読みが `null` を返した場合（逆引きの行そのものが退会・解除の並走で消えた形）は前進の失敗として扱う** — 通常の backoff で再試行し、上限で前進不能の再確定（`poison`）に落として記録を残す。`done` に読んではならない — 行の不在から「Directory 側の `'advanced'` 残渣も片付いている」は導けず、実在する側を黙って捨てることになる（その残渣の受け口は退会の引き取りと operator の明示削除である）。

**前進側にも `operation_id` の一致を課す。条件は phase 3 の更新（`promoteVerifier`）の CAS に入れる。** C1 の CAS が `operation_id` を含むのと対称であり、**一致しなければ「自分の残渣はもう無い」として何も書かずに `done` にする**。**読み取り時点の確認では塞げない** — 前進は「行を読む → cross-DO RPC → phase 3 を書く」の順で、RPC はトランザクションの外にあるので（RC-7）、読みと書きのあいだに後勝ちの差し替えが入る窓がそのまま残る。**したがって `promoteVerifier` の条件は「`changeState` が `'advanced'` であること」に `operation_id` の一致を足した2つになる**（正本は本ファイル、契約は `spec/domains/identity.md`）。課さないと次の順序で他 saga の行を進めてしまう — (i) 旧 saga の `resume-credential-change` が `'pending'` で終端モードへ突入し、(ii) 突入から次の起床までのあいだに利用者がリセットを再依頼して新 saga が同じ行を後勝ちで差し替え、(iii) 新 saga が phase 2 を成功させて `'advanced'` を書き、(iv) 旧 saga のジョブが起床すると段の選択は行の状態だけを見るので「`'advanced'` には後始末が無い」→ **前進を実行し、他 saga の行の保留材料を読み直した版で昇格させてしまう**。**この CAS は読み直した版の正しさも支えている** — 版が読みの後に進むのは別 saga の phase 2 だけで、それは行の差し替え（`operation_id` の変更）を必ず先に伴うので、版がずれた行への phase 3 は 0 行で終わる。

- **`'advanced'` で巻き戻さない理由。** User Data 側は既に `sessionEpoch` と `credentialVersion` を進めているので、Directory 側だけを旧検証材料へ戻すとログインの到達性検査の版照合が外れ、**後続のリセット / パスワード変更が1回完走するまで恒久的にログインできない**。**巻き戻しは新しい締め出しを作る向きなので採らない。** 残っている前進は「現在の版を読み取って phase 3 を書く」であり（上の「`'advanced'` からの前進」）、これが焼き切れた状態は operator が原因を解消して再投入すれば完走する
  - **この禁止は利用者経由で迂回できるが、迂回が到達する状態は巻き戻しと同じではない。** 利用者がリセットを再依頼すると `beginCredentialChange` が行を `'pending'` へ後勝ちで差し替え、その新しい saga が終端すれば C1 が `change_state` を `NULL` へ戻す — 到達するのは「版の不一致が残った `NULL`」であり、**禁止が防いでいる形（既に進んだ版に古い検証材料を載せること）には到達しない** — C1 は検証材料の正本にも版にも触れないからである。認可はどの向きにも開かず、ログインは版照合で閉じたまま、回復はリセットの完走1回である（「受容した残余」の版不一致の窓と同じ形）
- **CAS の 0 行を「何も書かずに `done`」にする理由。** `'pending'` の行は別の `operationId` による新しい依頼に後勝ちで差し替えられる（既存規則）。`operation_id` を CAS に含めないと、**この saga の後始末が他人の進行中の依頼を巻き戻す**。0 行は「自分の残渣がもう無い」ことを意味するので、回収すべきものが無い
- **cross-DO RPC を1本も含まない。** したがって後始末が失敗する契機は自 bucket の書き込み失敗だけで、**前進不能の契機（User Data DO への RPC の失敗）と同一でない**
- **`'pending'` は「phase 2 が適用されていない」ではなく「適用が bucket 側に記録されていない」である。** `'advanced'` は phase 2 の**成功を受けてから**書く別トランザクションなので、**phase 2 がコミットしたのに `'pending'` のまま、という状態が構造的に存在する**（commit 後に応答が失われる事象クラス。`'advanced'` を phase 2 の成功「後」に書くという fail-safe の向きが受容している窓である — 逆向きの破れは phase 3 まで進んで固定されるのに対し、この窓は後続の完走1回で解消する不一致にとどまる）
- **その窓でも巻き戻しは厳密に安全側である。** 認可はどの向きにも開かない（`passwordVerifier` には誰も触っていない）。**巻き戻しが開くのはログイン側の経路である。** `change_state` が非 `NULL` のあいだログイン照合はダミー材料へ倒れる（`spec/database/index.md` の `change_state` 列）ので、旧パスワードでも新パスワードでも通らない。巻き戻すとその2つが開く。**リセットの再依頼は巻き戻しの前から通る** — `requestPasswordReset` の判定材料は「検証材料の有無」であって `change_state` ではなく、`beginCredentialChange` は `password_verifier` を残したまま `pending_verifier` を書くからである。したがって巻き戻さなくても利用者はリセット1回で回復できるが、**その1回が完走するまでのあいだログインが閉じたままになる**（巻き戻しはその待ちを無くす操作である）
- **巻き戻しが版の不一致を新しく作ることはない。** 不一致を作るのは phase 2（`credentialVersion` の前進）であって巻き戻しではない。巻き戻しは `sessionEpoch` にも `credentialVersion` にも触れない
- **巻き戻した後に利用者ができること。窓に当たったかどうかで分かれる。** `change_state` が `NULL` に戻るのでログイン照合がダミー材料へ倒れなくなり、**(i) 窓に当たっていなければ、起点 A は旧パスワードでログインして変更をやり直せる。(ii) 窓に当たっていた場合（phase 2 がコミット済み）、Directory 側の版が User Data 側より1つ古いので旧パスワードでのログインは到達性検査の版照合で拒否される** — そのときの回復経路は**リセットの再依頼**であり、その1回の完走が phase 2 で版をもう1つ進め phase 3 が両側を揃えるので不一致ごと解消する。**(iii) 起点 B はどちらの場合もリセットの再依頼で回復する**（窓が明けていれば）。**この (ii) は「受容した残余」に列挙する**
- **侵害を前提とする起点（`change_origin='reset'`）でも侵害者の位置は変わらない。** phase 1 が削除・失効させたリセットトークンは復活せず（削除は不可逆であり、`change_auth_token` の `NULL` 化も戻さない）、`sessionEpoch` は巻き戻しでは動かない

## 後始末が使う RPC エントリ（全数）

**2本でこれが全数である。** どちらも saga の内部エントリであり、operator 専用 maintenance 経路には属さない（operator 経路の全数は database/index.md が持つ）。migration ゲートは従来どおり両方の先頭に掛かる。

| エントリ | 宛先 | 使う段 | ガード | 応答 |
|---|---|---|---|---|
| `abandon-account` | User Data DO | S2 | **下の評価順序（6段）が全数である。** `callerToken` の定数時間比較は3段目に置く（破壊的な作用と完走の検出はその後ろにある） | **`abandoned` / `already-completed` / `nothing-to-abandon` の3分岐で、これが全数である**（束縛の失敗はここに畳まず `SystemError`） |
| `cancel-reservation` | Identity Directory bucket | S3 / S4 / L2 | **`callerToken` の一致と、行の `credential_id` が引数 locator の `credentialId` と一致すること**の2条件で、**どちらも削除の CAS 述語そのものである**。対象行は引数の locator の PK で特定し、**`status` も `operation_id` も条件に含めない** | **「成功」1値でこれが全数である**（消した／無かった／束縛が一致せず触れなかった、を区別しない） |

- **「使う段」欄は後始末の側の全数であって、`cancel-reservation` の呼び出し元の全数ではない。** **退会側の引き取り段も同じエントリを発行する** — `operations` の `kind IN ('link','unlink')` の行に `phase='done'` を書く段がそれであり、下の「退会側への要求」の2点目が課す。**呼び出し元はこの2群で全数であり、どちらも Alarm 駆動である**（後始末の段は `resume-signup` / `resume-link`、引き取り段は `finalize-withdrawal` / `sweep-orphan-mapping`）。operator が直接叩く経路はどちらにも無い

### 引数と応答（全数）

**応答に canonical・全長 HMAC・鍵・`callerToken`・`passwordVerifier`・リセットトークンを載せない**（非露出対象。載せてよいのは分岐名までである）。

| エントリ | 引数 | 応答 | CAS 述語 | 0行だったときの扱い |
|---|---|---|---|---|
| `abandon-account` | `operationId` + `callerToken` | `abandoned` / `already-completed` / `nothing-to-abandon`（束縛の失敗は `SystemError`） | 下の評価順序の (6)。`account.status='active' AND` 同じ `operationId` の `operations` 行が `phase != 'done'` | 0行になる原因はすべて (1)〜(5) のどれかで先に分岐しているので、(6) まで来て0行になることは無い |
| `cancel-reservation` | **locator の全量**（`credentialId` + `kind` + 全長 HMAC + 世代 + bucket index）+ `callerToken` | 「成功」1値 | `(kind, hmac) = 引数の locator AND credential_id = 引数の credentialId AND caller_token = 引数の値` | **成功**（「無ければ成功」の冪等操作。行が既に無い場合と、束縛が一致しない行が居座っている場合を**区別しない** — 後者は正常系で起きず、区別すると呼び出し元へ他アカウントの行の存在が漏れ、失敗と読んだ後始末が恒久再試行で `poison` へ落ちて回収できる残渣を巻き添えにする） |

- **`abandon-account` の効果**: `account.status='deleting'` を書き、`sessionEpoch` を進め、`finalize-withdrawal` を投入する（退会の起点とまったく同じ書き込みである）。**`sessionEpoch` を進める操作の全数（4つ）は動かない** — 放棄は「退会」の投入点の1つである（async/index.md の `finalize-withdrawal` の投入点欄）。**放棄経路は `operations` に新しい行を作らない** — `finalize-withdrawal` の冪等性キーは `jobs.operation_key`（DO ごとの定数）だけであり、2つの投入点は同じ行へ収束する（退会は DO ごとに一度しか起きない）

**`abandon-account` の評価順序（全数）。上から順に評価し、最初に当たった段の値を返す。**

| # | 条件 | 返す値 | 書き込み |
|---|---|---|---|
| (1) | `account` 行が無い（DO が未初期化） | `nothing-to-abandon` | **1行も書かない**（下の「User Data DO を実体化しない」。migration ゲートの既定の応答に対する例外でもある） |
| (2) | `account.status IN ('deleting','deleted')` | `abandoned` | 無し（**放棄も退会も、この DO に対して既に同じ遷移が起きている**。利用者起点の退会で先に `deleting` になっていた場合も、後始末が求める「アカウント候補を残さない」は満たされている） |
| (3) | `callerToken` が `account.caller_token` と一致しない（`NULL`・空・規定長未満を含む） | **`SystemError`**（分岐に畳まない） | 無し |
| (4) | 同じ `operationId` の `operations` 行が無い（または `kind != 'signup'`） | `nothing-to-abandon` | 無し |
| (5) | その行の `phase = 'done'` | `already-completed` | 無し |
| (6) | それ以外 | `abandoned` | **`AccountStore.beginDeletion`**（`status='active'` を条件に含む条件付き更新で `deleting` へ倒し `sessionEpoch` を進める）**と `finalize-withdrawal` の投入を1つの `transactionSync` で行う**。(2) が既に `deleting` / `deleted` を先取りしているので、ここで 0 行になることは無い |

- **`callerToken` の照合を (3) に置く理由。** 束縛が守るのは**破壊的な作用 (6) と完走の検出 (5)** であり、その2つは照合の後ろに残るので束縛は弱まらない。**(1)(2) を照合より前に出さないと、後始末が2つの実行順序で全滅する** — (1) は phase 2 を一度も成功させずに終端した saga（`account` 行が無いので照合相手が存在せず、素直に実装すると常に不一致に倒れる）、(2) は S2 が起こした退会が完走した後（`account.caller_token` は退会の完走時に消えるので、S3 が1要素でも失敗して次の起床が S1 からやり直すと、2度目の S2 が照合相手を失う）である。**どちらも「守るべきアカウントが存在しない」か「既に放棄済みで新しい作用が無い」状態であり、束縛を要求する対象が無い**
- **(1)(2) が漏らすのは「未初期化である」「既に退会処理中である」の2ビットだけである。** どちらもデータを持たない状態を指し、完走の有無と破壊的な作用は照合の後ろにある
- **応答の3分岐の切り方。** `already-completed` は「その saga が完走している」ことを表す1値である（**後始末の可否がこの1ビットでしか決まらない**。上の S2 の項）。`nothing-to-abandon` は (1) と (4) を畳む
- **`callerToken` の不一致（評価順序の (3)）は分岐に畳まず、`SystemError` として返す。** 畳むと `nothing-to-abandon`（= S3 へ進む成功）になり、**束縛の材料が欠けている実装で完走したアカウントに対して S3 / S4 が走る** — 防壁が材料の欠落ごと無効化される。エラーにすれば後始末は失敗として backoff し、最終的に `poison` + operator へ落ちる（**fail safe の向き**）
- **後始末は「対象が無い」を失敗と読んではならない。** 読むと恒久的に再試行して `poison` へ落ち、回収できる残渣まで巻き添えにする。`nothing-to-abandon` は S3 へ進む成功、`already-completed` は後始末そのものの終了、`SystemError` だけが失敗である
- **`cancel-reservation` のガードから `operationId` を外す理由。** `operation_id` は可変列であり（`beginCredentialChange` が上書きする）、ガードに置くと**リセットが着地した孤児写像を回収できなくなる**。`operationId` をガードに置く目的は「`operationId` の知識だけで破壊的削除ができないようにする」ことだが、それは `callerToken` の必須ガードが単独で満たしている。**対象行を locator の PK で名指しし、さらに `credential_id` の一致を条件に持つので、`operationId` を外しても射程は広がらない**（引数の locator は呼び出し元が保存済みの座標から取る値であって、その場で導出した値ではない。`credential_id` は不変かつ saga ごとに新規採番されるので、canonical が空いた後に別の saga が作った同じ PK の行には当たらない）
- **ガードが依存する `operations` 行のライフサイクルは spec 側にある。** 新規登録 saga の User Data DO 側の `operations` 行は、**`initialize-account`（phase 2）が業務書き込みと同じ `transactionSync` で作り、phase 4 が逆引きの記録と同じ `transactionSync` で `phase='done'` にする**（正本は `spec/usecases/identity.md` の `registerWithPassword` / `registerOrLoginWithSso`、書き手の全数は `spec/async/index.md`「saga phase の前進」の行）。**この2点のどちらが欠けてもガードが壊れる** — 行が無ければ常に `nothing-to-abandon` に落ちて完走の検出ができず、`'done'` を書く主体が無ければ完走済みのアカウントを放棄できてしまう
- **`cancel-reservation` は削除する行の `credentialId` 宛の `password_reset_tokens` 行も同じ `transactionSync` で全削除する。** 写像を失ったトークン行を残さない規則は `deleteMapping` と移送の s5 が既に持っており、揃える。**孤児 mapping にリセットトークンが実在しうる** — `active` な孤児 mapping が `passwordVerifier` を持つ場合、リセット依頼は canonical から解決してトークンを発行するからである
- **どちらも `callerToken` を必須ガードに持つ。** 破壊的な作用を `operationId` の知識だけに束ねない（`operationId` は未認証経路のログへ出してよい値である）という規則をそのまま引く
- **束縛の不一致の扱いは2本で逆であり、それぞれに理由がある。** `abandon-account` の束縛は**照合の後ろに残る破壊的な作用 (6) と完走の検出 (5) を守る門**なので、不一致をエラーへ倒すことが「束縛材料の欠けた実装が防壁を素通りして完走済みのアカウントを放棄する」ことを防ぐ（fail safe）。`cancel-reservation` の束縛は**削除の CAS 述語そのもの**であり、不一致は「行に触れない」ことを既に意味する — エラーにして防げる作用が無く、区別が生むのは応答面への行の存在の露出と、失敗と読んだ後始末の恒久再試行だけである

## 材料の寿命

**材料は「行が消えるか」だけでなく「行を引く鍵が書き換わるか」も見る。引く鍵は不変列でなければならない**（RC-4）。

| 材料 | 置き場 | 引く鍵（不変であること） | 必要とする段 | 消える段 | 消えないことの根拠 |
|---|---|---|---|---|---|
| `locators` | コーディネーター予約行（`credential_mappings`） | PK (`kind`, `hmac`) = 自 bucket の locator | S1 | S4 | S4 以外に消す経路が無い。期限切れ掃除については下の不等式が覆う |
| `candidate_user_id` | 同じ行 | 同上 | S1 / S2 | S4 | 同上 |
| `caller_token`（Identity Directory 側） | 同じ行 | 同上 | S1 / S2 / S3 / S4 | S4 | 同上 |
| `operations`（`kind='signup'`）行と `phase` | User Data DO の `operations` | PK `operation_id`（採番後は不変） | S2 | — | `operations` 行に prune は無く、`phase='done'` は削除ではない。**S2 の `already-completed`（完走の検出）の唯一の材料である** |
| `target_locators` | `operations`（User Data DO） | PK `operation_id`（採番後は不変） | L1 / L2 | — | L3 が空にしない。`operations` 行に prune は無い |
| `account.caller_token` | `account`（User Data DO） | 単一行（鍵を持たない） | S2 / L1 / L2 | — | **消すのは退会の完走時だけである**（`spec/database/index.md` の `account.caller_token` 列が正本）。**S2 については「消える段」が空欄でも安全である** — S2 が起こした退会が完走すると照合相手が消えるが、そのとき `account.status` は `deleting` / `deleted` なので `abandon-account` の評価順序 (2) が照合より前に `abandoned` を返す（照合相手を要求しない）。**L1 / L2 については、突入前なら前進側の退会競合判定が後始末に入る前に `done` へ落とし、突入後に退会が始まる窓は下の「退会側への要求」の1点目が閉じる**（L1 自身は `account.status` を読まない） |
| `change_state` / `change_origin` / `pending_verifier` / `operation_id` | mapping 行（`credential_mappings`） | PK (`kind`, `hmac`) | C1 | C1 | 巻き戻しそのものが消す。移送の見送り（`change_state IS NOT NULL` の行を動かさない）が並走中も守る |
| locator（行を引く鍵）と `operationId` | `jobs.payload` | PK `operation_key`（不変） | S1 / S2 / S3 / L1 / C1 | — | ジョブ行が消えるのは prune だけで、`poison` は prune されない。**`resume-signup` の payload が locator を持つことが、S1 が可変列を鍵にせずに済む条件である** |
| `terminal_reason`（終端モードの印） | `jobs` 行 | PK `operation_key`（不変） | S1 / L1 / C1 | — | `poison` は prune されない（後述）。`done` へ落ちた行の記録は残渣が無いので消えてよい |

**段の順序から導ける。**

- **`resume-signup`**: 材料を持つ行は**コーディネーター予約行だけ**であり、**それを消すのは S4 だけである。S4 は S3 の全要素成功を条件にするので、材料を読む S1 と材料を引数に使う S2 / S3 は必ず S4 より前にある。** S4 が材料の削除と `jobs` 行の終端を**同じ `transactionSync`** で行うので、「材料は消えたが後始末が残っている」状態は原理的に作れない
- **`resume-link`**: 材料は2箇所に分かれ、`target_locators` は誰も消さず、`account.caller_token` は**退会の完走時だけ**消える。**突入前であれば前進側の退会競合判定が後始末に入る前にジョブを `done` へ落とすが、突入後は前進が1段も実行されない**（RC-2）ので、**「突入 → 退会の開始 → L1 / L2」という順序で後始末が退会と並走する窓が残る。** この窓は段の順序からは閉じられない — 材料を消すのが自分の段ではなく退会側だからである。**したがって `account.caller_token` の生存は段の順序ではなく、下の「退会側への要求」の1点目だけが支える**
- **`resume-credential-change`**: 材料は mapping 行そのもので、消すのは C1 自身である。段が1つなので順序の問題が生じない

**退会側への要求（3点）。** **本ファイルはこれを導出せず、要求として明示する** — **退会 saga の段そのものは本 spec の範囲外だからである**（`spec/domains/identity.md` — 退会 saga そのものは本 spec の範囲外 / `spec/database/index.md` — `finalize-withdrawal` の投入点は実装が DO の RPC 側で決める）。**満たす責任は退会 saga の実装側にある。** 「引き継ぎ」にも同じ3点を載せる。

1. **`account.caller_token` を消す段は、未完了の連携 / 解除の手続きの記録（`operations` の `kind IN ('link','unlink')` かつ `phase != 'done'`）が0件であることを前提条件に持つ。****満たされなければ L2 の途中で束縛材料が失われ、連携の残渣が回収不能になる**（上の `resume-link` の窓）
2. **`operations` の `kind IN ('link','unlink')` の行に `phase='done'` を書く段は、その行の `target_locators` の全要素へ `cancel-reservation` を発行し終えていること。** L1 は `phase='done'` を「退会側が既に引き取った」と読んで1行も回収せずジョブを `done` にするので、**この要求が無いと、退会側が `deleteMapping` だけで引き取った場合に `user_id` が未確定の `reserved` 行（手順2〜3 の落下点）が誰にも消されないまま残り、記録も残らない** — `deleteMapping` の「mapping 行の `userId` 一致」ガードを `reserved` 行が通れないからである（上の L2 が `cancel-reservation` を選んだ理由と同じ）。**「黙って中間状態を残さない」（前提4 / RC-1 / RC-3）が破れる唯一の残り口がここである**
3. **退会の完走は `operations` の行を削除しない**（`phase='done'` を書くことは削除ではない）。**要求1 の前提条件は「未完了の記録が0件」なので、行を消してしまえば0件になり、要求1 も要求2 も満たしたまま `reserved` 行が誰にも消されずに残る。** 現状これを塞いでいるのは「`operations` への書き込み口は `recordOperation` / `updateOperation` の2つで全数」（`spec/database/index.md`）だけだが、**それは usecase 側の口の全数であって、ジョブランナーがアダプターとして同じ表を直接触る前例は同じファイルに実在する**（`jobs` の claim / prune）。範囲外の実装が守る保証は、要求の側に置かなければ成立しない

## 予約 TTL の不等式

**`予約 TTL > 前進のバックオフ上限に達するまでの総経過時間 + 後始末のバックオフ上限に達するまでの総経過時間 + マージン`。**

**右辺の射程には後始末の総経過時間を含める**（突入は待ちを1つも挟まないので、前進の総経過時間 + マージンに対して増える項はこの1つだけである）。

- **含める理由。後始末は phase 2 の成否によらず材料を要求する。** S1 は常にコーディネーター予約行を読み、S3 は `locators` を、S4 は `caller_token` を要求する。**phase 2 に一度も到達しなかった saga の予約行は `saga_committed` 印を持たないので、掃除の作業述語（`status='reserved' AND reserved_until < ? AND saga_committed IS NULL`）にそのまま当たる** — この場合を守るものは不等式しか無く、第2項は常に要る。**phase 2 が成功していれば印が掃除から守るが、その印が失われる窓もある** — phase 2 が成功し、コーディネーターがその戻り値を受けて印を書く前に落ちた場合である（commit 後に応答が失われる事象クラス。phase 2 の冪等性の根拠でもある）。その状態では `active` なアカウントが実在するのに印が無く、TTL 経過で材料ごと掃除されうる。**掃除の後に残るのはログイン手段を持たない `active` アカウントで、`credential_locators` が空なので発見の口が1つも無い**（`list-bucket-user-ids` は mapping を持つ `userId` しか返さない）。右辺に後始末の総経過時間を含めれば、**後始末が完走する（S4）まで材料が保たれる** — S3 は `locators` を、S4 は `caller_token` を要求するので、S2 で切ると S2 と S3 のあいだで材料が消えて `active` な孤児写像が記録なしで残る
- **項を落として過小評価しない。** 右辺は2項 + マージンであり、**後始末の総経過時間をマージンへ畳まない**（畳むと下の禁止則と同じ種類の過小評価になる）。**突入そのものは待ちを持たない**ので第3の項は現れず、後始末の初回の待ちは後始末の総経過時間の内側にある（`attempt = 0` から始まる同じ曲線だからである）
- **「再開間隔 × 再試行上限」と書いてはならない**。再試行は指数バックオフであり、等間隔の見積りは総経過時間を大きく下回るので、掃除が後始末より先に走る
- **代償を明記する。** 前進も後始末も焼き切れた saga の `reserved` 行が、その分だけ長く canonical を握る。**受容する** — 利用者の再登録は右辺のぶん待たされるが、認可はどの向きにも開かない
- **同じ不等式が SSO 連携の予約にも掛かる**（測る対象が `resume-link` のバックオフ列になるだけである）
- **具体値は運用設計が定める**（`jobs` の件数上限と同じ扱い）

## 起点別の扱い

**巻き戻しは起点で分岐しない。** `change_state='pending'` の巻き戻し（C1）は `change_origin` の値を読まない — 戻す先は「依頼が無かった状態」であり、起点によらず同じである。

**起点で分かれるのは「巻き戻した後に利用者が自力で完走できるか」だけである。**

| 起点 | 巻き戻し後の自力回復 | 成立しない条件 |
|---|---|---|
| `change_origin='password-change'` | **原則として成立する。** 旧パスワードを知っているので、ログインして変更をやり直せる | **版の不一致の窓に当たっていた場合は成立しない** — phase 2 がコミットした後に巻き戻った行では、旧パスワードのログインが到達性検査の版照合で拒否される（「巻き戻した後に利用者ができること」の (ii)。「受容した残余」）。そのときの回復経路はリセットの再依頼であり、その1回の完走が不一致ごと解消する |
| `change_origin='reset'` | **原則として成立する。** 旧パスワードは知らないが、リセットの再依頼が通る（**この経路は巻き戻しの有無によらず開いている** — `requestPasswordReset` は「検証材料の有無」で判定し `change_state` を見ない。巻き戻しが変えるのは、その1回が完走するまでログインが閉じたままかどうかである） | **前進を止めた原因が恒久的な場合だけ成立しない** — 対象 User Data DO の `SQLITE_FULL`（書き込みだけが恒久的に失敗する半死状態）では、再依頼しても phase 2 が同じ地点で止まる。逼迫時の導線（ゴミ箱を空にする / エクスポートして削除する）はログインを要求するので利用者からは到達できない |

- **したがって起点別の扱いは「後始末の内容」ではなく「operator 受け口が何を要求するか」に置く。** `'advanced'` の終端は、`requeue-poisoned-job` だけでは閉じない — **原因（容量）の解消まで operator に要求する。** これは起点によらない — **`'advanced'` のあいだログイン照合はダミー材料へ倒れるので、起点 A も旧パスワードではログインできず、原因の解消後はどちらの起点もリセットの再依頼1回で自力で閉じる**（または operator の再投入が元の手続きを完走させる。「残渣の種類ごとの受け口」の `'advanced'` の行）
- **起点別の扱いが満たす制約は2点である** — **(1) 起点 B は巻き戻しだけでは閉じない**（上のとおり、閉じないのは原因が恒久的な場合に限られる）、**(2) phase 2 の成功後に Directory 側だけを戻してはならない**（`'advanced'` では巻き戻さない）

## operator 経路への受け渡し

**入口は1本である。`requeue-poisoned-job`（新設）。**

- **根拠。** 残渣を消すエントリ（`cancel-reservation` / `abandon-account` / `deleteMapping`）はすべて `callerToken` を必須ガードに持ち、**`callerToken` を返す口は当該利用者の有効なセッションを要する経路だけである。`terminal_reason` / 運用画面 / メトリクスへ出すことは禁じられている**（禁止則）。**したがって operator が残渣を直接消すことはできない。** 消せるのはジョブ行であり、**ジョブ行は材料を持つ行を指している。** operator の仕事は「原因を解消してジョブを再投入する」ことであって、残渣を手で消すことではない。**operator が持てるのは `operationId` までである**という限界は、この形で閉じている
- **`requeue-poisoned-job` が書く列**（`requeue-quarantined-event` と同じ形。物理形の正本は database/index.md）: `status='pending'` / `next_run_at = 現在時刻` / `attempt = 0` / `completed_at = NULL` の4つ。**`terminal_reason` は残す** — 残すことで後始末を持つ3種は終端モードのまま再開する（前進をやり直させたい場合は、利用者が新しい `operationId` で操作をやり直す。ジョブの `operation_key` が `operationId` から導かれるので、それは別の行になる）。**そのトランザクションのあと、4本の min の合成で `setAlarm` を張り直す** — `poison` は実行可能集合に入らないので、終端行しか残っていない DO は定義上 `deleteAlarm()` 済みである
- **発見の口は `list-poisoned-jobs`（新設。読みのみ）。** 返す列は `operation_key` / `kind` / `attempt` / `completed_at` / `terminal_reason` の5つで、**`payload` を返さない**（隔離の原因を読むための列ではない。`list-quarantined-events` が `payload` を外したのと同じ理由）。順序は `completed_at` の昇順（`jobs_completed_idx` で解ける）。件数上限と続きの引き方は運用設計が定める

**残渣の種類ごとの受け口（全数）:**

| 残渣 | 受け口 | operator に要求すること |
|---|---|---|
| 登録 saga の孤児 mapping / `reserved` 行 / ログイン手段を持たないアカウント | `requeue-poisoned-job` | 対象 bucket と User Data DO の逼迫・`.overloaded` の解消 |
| 連携 saga の孤児 mapping / `reserved` 行 | `requeue-poisoned-job` | 同上 |
| credential 変更の `'pending'` 残渣 | `requeue-poisoned-job` | 自 bucket の逼迫の解消 |
| credential 変更の `'advanced'` 残渣 | `requeue-poisoned-job`（**利用者がリセットを再依頼した後は、その新しい saga のジョブ行が受け口になる**） | **User Data DO の容量の解消が先。** 原因が恒久的なら利用者に自力の脱出経路が無い（`change_origin='reset'` / `'password-change'` のどちらでも、新しいリセットの phase 2 が同じ地点で止まる）。**原因が解消していれば、リセットの再依頼が `'advanced'` の行を `'pending'` へ後勝ちで差し替えて自力で閉じる** — そのとき旧ジョブの再投入は `operation_id` の不一致で `done` になり、残渣は新しい saga が持つ |
| 退会の残渣（`deleting` の恒久化） | `purge-user-mappings` → `requeue-poisoned-job` | 逆引きを失った場合は bucket 走査で写像を消し、そのうえでジョブを再投入して tombstone まで完走させる |
| 解除（unlink）の孤児 mapping | `requeue-poisoned-job` | 対象 bucket の解消 |
| **材料を見失った後始末**（`terminal_reason` が `cleanup-material-lost:*`） | **明示削除**（口の名前は運用設計が定める。`requeue-poisoned-job` ではない） | 残渣の実物を確かめること — 実在すれば残っている経路（利用者の再操作 / `purge-user-mappings`）で閉じ、実在しなければ行を消す。**再投入しても S1 / L1 が同じ判定を繰り返すだけである** |

- **表の最後の行だけが `requeue-poisoned-job` を受け口に持たない。** 他の行は「原因を解消して再投入すればジョブが残渣を回収する」形だが、材料を見失った行にはジョブが回収できる残渣がもう無い（消えているか、別の経路が片付けた後である）。**入口が1本であるという断定は「残渣を回収する入口」についてのものであり、記録を片付ける明示削除はそれに数えない**（`quarantined` が同じ2本立てを既に持つ。database/index.md）
- **`purge-user-mappings` が届かない残渣への回答。** `candidateUserId` しか持たない予約行の残渣に `purge-user-mappings` は届かない（`userId` をキーに取るため）。**届く必要が無い** — その残渣を消すのは後始末の S3 / S4 であり、材料はジョブ行が指すコーディネーター予約行が持っている。**受け口は `requeue-poisoned-job` である**
- **能動通知は本ファイルの領分ではない。** 本ファイルが定めるのは受け口と入口までで、`poison` の検知をどう通知するかは扱わない

## `poison` を prune しない

**`jobs` の prune が消すのは `done` だけである。`poison` は operator が再投入するか明示的に削除するまで恒久保持する。**

- **根拠。** 一様な終端が保証するのは「残った状態が記録され、受け口へ届くこと」である。`poison` 行が保持期間で消えると、**`terminal_reason` という唯一の記録と `requeue-poisoned-job` の対象が同時に消え、残渣だけが残る** — 「黙って中間状態を残す」を選ばないという原則が prune によって破れる。**束縛の相手は設定値ではなく operator の反応時間なので、保持期間の不等式としては書けない**（`outbox_events` の `quarantined` を恒久保持にした論拠と同じものである）
- **帰結。** prune の対象集合が2表で対応する（`jobs` は `done`、`outbox_events` は `published`）。**したがって「分離する規約」は3つから2つになる** — 値域の差は残るが、そこから prune の対象集合の差は導かれなくなる（正本は database/index.md）
- **`poison` 行は自動では減らない。** 減らす手段は `requeue-poisoned-job`（`done` へ進めば prune の対象に戻る）と operator の明示削除の2つだけで、10 GB に算入する
- **増加の上限は `quarantined` と違うが、無条件ではない。** `quarantined` は1件のリセット依頼から1行が作られるので一斉隔離でそのまま伸びるのに対し、**`poison` が増えるには saga が終端まで焼き切れる必要があり、そこには前進と後始末の2本ぶんのバックオフ上限（`spec/database/index.md` の実値）が挟まる。** **限界を併記する** — cross-DO saga の起点のうち**新規登録（`registerWithPassword` / `registerOrLoginWithSso`）は未認証であり、その「予約の獲得」は未認証入力が行う操作そのものである。** したがって**共有 bucket を継続的に `.overloaded` へ保てる主体は、その bucket をコーディネーターとする登録を次々に終端させて `poison` を積める**（後始末の失敗の契機が前進の契機と同一である2 `kind` がそれに当たる。上の全数表の「契機の同一性」欄）。**これを塞ぐのは発信元単位のレート制限であり、それは transport 境界の責務で本 spec の範囲外である**（`spec/database/index.md` が bucket 共有の逼迫について同じ帰属を書いている）。**`poison` は掃除の対象を持たない**ので、この限界は `quarantined` より重い側に効く

## User Data DO を実体化しない

**migration ゲートの初期化分岐を、移行分岐と分ける。User Data DO の初期化分岐を実行してよいのは `initialize-account`（登録 saga の phase 2）だけであり、これが全数である。****ゲートそのものの正本は `spec/database/index.md`「`_meta.schema_version` とゲート関数」であり、本節が持つのは「なぜその制限が要るか」と回収との関係だけである**（規則の写しを二重に持たない）。

- **射程は User Data DO だけである。Identity Directory bucket の初期化分岐に制限は掛けない。** 制限が要るのは**名前の空間が利用者入力から導かれ、上限を持たない側だけ**だからである — User Data DO の locator は `userId` から導かれるので、署名済みセッションを作れる主体は任意個の DO を実体化できる。一方 bucket の名前は `dir:g{世代}:b{番号}` で、番号は keyring の `bucketCount` で有界かつ利用者入力から独立なので、**空の bucket が無制限に作られる経路が構造的に無い**（初回デプロイ後の最初の予約・最初の `claimWindow` がその bucket を初期化するのは正常系そのものである）。**この射程を書かずに「全エントリ」と読むと、どの bucket も一度も初期化できなくなり、登録もリセット依頼も成立しない**
- **User Data DO の**他の全エントリは、未初期化の DO（`_meta` の行が無い）に対して**1行も書かずに fail closed で戻る**（**既定の応答の種別は `SystemError` である**。「epoch 不一致と同じ扱い」は倒す向きの説明であって応答の種別ではない）
- **既定の応答には例外が2群あり、これが全数である。** **(a) ゲートを通らない診断エントリ**（`read-schema-version` / `list-bucket-user-ids`）は従来どおり未初期化を未初期化として返す（書かない）。**(b) `abandon-account` はゲートを通ったうえで、未初期化を `nothing-to-abandon` という分岐名で返す**（上の「`abandon-account` の評価順序」の (1)）。**(b) が無いと、phase 2 を一度も成功させずに終端した新規登録 saga の後始末が構造的に全滅する** — 後始末は「進めない」を失敗と読んではならないので、`SystemError` を受けると恒久的に再試行し、回収できる残渣まで巻き添えにして `poison` へ落ちる
- **初期化分岐だけは、`initialize-account` の業務書き込み（`account` / `user_settings`）と同じ `transactionSync` で確定する。** 移行分岐は従来どおりゲート自身のトランザクションで確定し、本体の成否に依存させない（既存の断定を維持する）。**分ける理由は、本体が落ちたときに DO が0バイトへ戻らなければ回収経路の無い空 DO が残るからである**
- **回収経路を持てないことが、防ぎ方で閉じる理由である。** 空 DO は `credential_mappings` に行を持たないので `list-bucket-user-ids` から到達できず、**DO の内部 ID から `userId` へは戻せない**（既存の断定）。したがって発見の口が構造的に存在せず、**掃除ジョブを設計しても対象を列挙できない**
- **「正しく署名された・存在しない `userId` のセッションで空の User Data DO が作られる」という実測挙動への回答:**
  - **正しく署名された・存在しない `userId` のセッションでは空 DO が作られない。** 初期化分岐が走らないので0バイトのままである
  - **退会完了後の cookie も DO を作らない。** 退会は tombstone（`account.status='deleted'`）を残す設計なので DO は初期化済みであり、従来どおり epoch ガードが拒否する。**「`finalize-withdrawal` が消したはずの DO が空で復活する」は、退会が tombstone を残す限り起きない** — 起きるとしたら退会の完走が `account` 行ごと消している場合であり、それは `spec/database/index.md` の `account` 表の規定（退会後も非 PII の tombstone としてこの行が残る）に反する
  - **作られてしまった空 DO を回収する経路は持たない**（上のとおり発見の口が無い）。**「許容して次の退会完走で消す」も採らない** — 退会は tombstone を残すので「消す」経路がそもそも無い
- **後始末との関係。** S2 の `abandon-account` は未初期化の DO へ発行されうる（phase 2 が一度も成功していない saga の終端）。初期化分岐が走らないので**空 DO は作られず**、応答は `nothing-to-abandon` になる（上の例外2群の (b)）。**後始末が空 DO を作らないことは、この規則からの帰結であって後始末側の分岐ではない**（後始末は `saga_committed` を読まず、phase 2 の成否を自分で判定しない）

## 不変条件（RC-1〜RC-9）

- **(RC-1) 終端の一様性**: 前進不能が確定したジョブは、最終的に3つの落ち先のいずれかへ至る — **`terminal_reason` を残して `poison` へ落ちるか、後始末が完走して `done` へ落ちるか、（後始末の段を持たない行が再投入された場合に）前進が完走して `done` へ落ちるか**である。**黙って `pending` に留まる状態を持たない**（`poison` は実行可能集合の外、`done` は完了であり、そのどちらでもない `pending` の行は必ず次の起床で段を1つ実行する）
- **(RC-2) 終端モードの一方向性**: `terminal_reason` を `NULL` へ戻す経路は存在しない。**終端モードにあり、かつ後始末の段が実在する `kind` / 状態では、前進を1段も実行しない**（段が実在しない行を operator が再駆動すると前進から再開するが、それは終端モードからの復帰ではなく、そもそも後始末を持たない行である）
- **(RC-3) 記録の永続性**: 終端の記録は `poison` 行として恒久保持される（prune の対象は `done` だけである）
- **(RC-4) 材料の生存**: 回収の各段が必要とする材料は、その材料を消す段より前で使われる。**材料を消す段は各 kind の最終段であり、`jobs` 行を終端へ落とすのと同じ `transactionSync` で消す**（**本 spec の外に消し手がある材料は `account.caller_token` だけであり、その生存は段の順序ではなく「退会側への要求」が支える**）。**材料を引く鍵は不変列でなければならない** — 行が消えなくても鍵が書き換われば材料は失われる（`credential_mappings.operation_id` は可変なので鍵にしない）
- **(RC-5) 除外単位**: 登録 saga の後始末が `locators` から除外するのはコーディネーター行1件（述語は `credentialId` の一致）であって bucket ではない
- **(RC-6) 認可の向き**: 後始末が作るどの状態でも認可は開かない。実体は2つ — `'advanced'` の行を巻き戻さないこと（**既に進んだ版に古い検証材料を載せない**）と、`'pending'` の巻き戻しが `sessionEpoch` / `credentialVersion` にも `password_verifier` にも触れないことである。**巻き戻しが版の不一致を新しく作ることは無い**（作るのは phase 2 である）
- **(RC-7) 原子性境界**: cross-DO RPC を `transactionSync` の中に置かない。**業務データに対して**各段が持つのは「自 DO のローカル読み」（S1 / L1）・「自 DO のローカル書き込み1回」（S4 / L3 / C1）・「トランザクションの外の RPC 発行」（S2 / S3 / L2）の**いずれか1つ**であり、書き込みと RPC を両方含む段は無い。**S1 / L1 は材料の喪失に落ちたときだけ `jobs` 行の終端を1回書くが、それは業務データではなくジョブ行の状態であり、cross-DO RPC を含まない**
- **(RC-8) 実体化の単独性**: **User Data DO** を実体化してよいのは `initialize-account` だけである。後始末を含むどの経路も未初期化の User Data DO に1行も書かない。**射程は User Data DO に限る**（Identity Directory bucket は上の「User Data DO を実体化しない」のとおり制限を持たない）
- **(RC-9) 非露出**: `terminal_reason` に載るのは理由トークン（6値）と `operationId` だけである。残渣の所在（locator）・`callerToken`・canonical・`hmac`・`passwordVerifier`・リセットトークン・`changeAuthToken` を載せない

## 正本と適用先

**本ファイルの断定が届かなければならない適用先を、ファイル単位で全数で持つ。** 「正本を直して適用先の散文に届けない」形は、**適用先を列挙して各ファイルが本ファイルを参照していることを検査する**ことで検出する（下の検査5）。**表の各行は「届いていなければならないもの」を肯定形だけで持つ** — この表は検査5 の入力そのものなので、行の意味が揃っていないと「行を足すこと自体が検査の更新である」という読み方が崩れる。

| 適用先 | 本ファイルの何が届いていなければならないか |
|---|---|
| `CLAUDE.md` | 前進の上限到達が即 `poison` ではないこと（終端モードが1段挟まること）と、`poison` を prune しないこと。**識別子（`kind`）は1つも列挙しない**（開発規約の正本であって台帳ではない、という既存の役割分担をそのまま守る） |
| `spec/database/index.md` | 終端モードで書く列 / `poison` を prune しないこと / operator エントリ2本 / 前方互換点3本の寿命（消える段）/ migration ゲートの初期化分岐と例外2群 / **`account` 表の `caller_token` と `status` の書き手** / `credential_mappings` の `operation_id` が可変であることと `locators` の要素の形 / **`operations.kind` の値域トークン**（後始末の L1 と退会側への要求がその値で行を選ぶため） |
| `spec/async/index.md` | `finalize-withdrawal` の第2の投入点（放棄）の手順が本ファイルにあること |
| `spec/domains/identity.md` | 終端の手順の所在 / `cancelReservation` の対象の名指しと**束縛の2条件** / 起点別の扱い / **`AccountStore` の `initializeCallerBinding` と `beginDeletion`** / **`promoteVerifier` の条件2つ**（`changeState` と手続き ID の一致）/ **`deleteMapping` の束縛**（`userId` の一致と不透明値。後始末が `cancel-reservation` を選ぶ理由がこれに依存する） |
| `spec/usecases/identity.md` | 5つの saga について、終端後に利用者が何をできるか / **`recordOperation` が書く `operations.kind` の値**（後始末と退会側への要求がその値で行を数えるため） |
| `spec/testcases/identity/changePassword.md` | 終端時の期待結果（`'pending'` は巻き戻る / `'advanced'` は巻き戻らない）と、**終端の落ち先が後始末の結果で分かれること**（後始末が完走すれば `done` に落ち、operator の受け口には渡らない） |
| `spec/testcases/identity/executePasswordReset.md` | 同上 + 起点 B の自力回復の射程 |
| `spec/testcases/identity/linkSsoCredential.md` | 終端時の期待結果（巻き戻して再連携で回復する）と、終端の落ち先が後始末の結果で分かれること |
| `spec/testcases/identity/unlinkSsoCredential.md` | 終端時の期待結果（後始末を持たず前進のみ。**この kind だけは前進不能の確定がそのまま operator の受け口へ渡る**） |
| `spec/testcases/identity/registerOrLoginWithSso.md` | 終端時の期待結果（放棄して再登録で回復する）と、終端の落ち先が後始末の結果で分かれること |
| `spec/testcases/identity/registerWithPassword.md` | 終端時の期待結果（放棄して同じメールで登録をやり直せる）と、終端の落ち先が後始末の結果で分かれること |
| `spec/testcases/recovery/sagaRecovery.md` | 本ファイルの全数表・段・材料の寿命・不変条件の検証 |
| `spec/testcases/rotation/keyRotation.md` | 世代ガードに拒否された saga の期待結果が**即 `poison` ではなく終端モードへの突入**であること（後始末の段と材料の扱いは本ファイルが正本であると明示していること） |
| `spec/inventory/adapter.md` | 終端モードで書く列 / 段（S・L・C）/ RPC 2本のガードと応答 / operator 導線2本 / migration ゲートの初期化分岐（**台帳は逐語で写す設計なので、写しが最も多い適用先である**） |
| `spec/inventory/domain.md` | `cancelReservation` の効果（`status` を問わない削除とリセットトークン行の同時削除）と束縛の2条件 / `promoteVerifier` の条件2つ / `deleteMapping` の束縛 |
| `spec/inventory/usecase.md` | 終端後に利用者がやり直せること |
| `spec/inventory/test.md` | 新設テストケースの台帳行 |
| `spec/manual-tests/account.md` | 終端モードの観測点と、利用者の再操作による回復 |
| `spec/index.md` | 成果物の一覧に本ファイルが載っていること |
| `spec/manual-tests/index.md` | マニュアルテストの件数（本ファイルの追加で1件増えた）と spec バージョン |
| `spec/rotation/index.md` | 移送の見送りが後始末の材料に触れないこと（引き継ぎの決着）と、**干渉表が `cancel-reservation` を operator 専用経路として数えないこと**（帰属の一本化）と、**前進不能の確定が即 `poison` ではないこと**（後始末を持つ `kind` は終端モードを1段挟む） |

### 機械検証

リポジトリルートで実行する。出力が期待と食い違ったら、直すのは表・本文の側である。

```bash
R=spec/recovery/index.md

# 検査1: 回収の全数表の行数 = async の全数表の「cross-DO saga の前進」の行数
saga=$(grep -c -F '| local job（cross-DO saga の前進）' spec/async/index.md)
rows=$(( $(awk '/^## 回収の全数表/,/^## kind 別の後始末の段/' $R | grep -c '^| ') - 1 ))
echo "saga=$saga rows=$rows"; [ "$rows" -eq "$saga" ] && echo OK || echo NG

# 検査2: 後始末を持つ kind は3種・持たない kind は2種（全数表の「後始末」欄）
[ "$(awk '/^## 回収の全数表/,/^## kind 別/' $R | grep -c '| あり |')" -eq 3 ] && echo OK || echo NG
[ "$(awk '/^## 回収の全数表/,/^## kind 別/' $R | grep -c '| なし |')" -eq 2 ] && echo OK || echo NG

# 検査3: terminal_reason の理由トークンは6値、終端モードの各契機で書く列の表は7行
[ "$(( $(awk '/^### `terminal_reason` の理由トークン/,/^## 回収の全数表/' $R | grep -c '^| ') - 1 ))" -eq 6 ] && echo OK || echo NG
[ "$(( $(awk '/^### 終端モードの各契機で書く列/,/^### `terminal_reason`/' $R | grep -c '^| ') - 1 ))" -eq 7 ] && echo OK || echo NG

# 検査4: 段の集合と材料の寿命の整合（段名の実在と、消える段が必要とする段より後であること）
awk '
  /^\| [SLC][0-9] \| / { gsub(/^\| /,""); split($0,a,"|"); gsub(/ /,"",a[1]); stage[a[1]]=1 }
  /^## 材料の寿命/,/^## 予約 TTL/ {
    if ($0 ~ /^\| /) {
      n=split($0,c,"|")
      need=c[5]; die=c[6]
      gsub(/^[ \t]+|[ \t]+$/,"",need); gsub(/^[ \t]+|[ \t]+$/,"",die)
      if (need ~ /^[SLC][0-9]/) {
        m=split(need,s,"/")
        for (i=1;i<=m;i++) { gsub(/[ \t]/,"",s[i]); if (!(s[i] in stage)) { print "NG unknown-stage " s[i]; bad=1 }
          if (die ~ /^[SLC][0-9]/ && substr(die,1,1)==substr(s[i],1,1) && die < s[i]) { print "NG lifetime " s[i] " > " die; bad=1 } }
      }
    }
  }
  END { print bad ? "NG" : "OK" }
' $R

# 検査5: 正本 → 適用先の伝播（適用先表の全ファイルが本ファイルを参照している）
awk '/^## 正本と適用先/,/^### 機械検証/' $R | grep -o '^| `[^`]*`' | tr -d '|` ' | while read -r f; do
  [ -f "$f" ] && grep -q 'recovery/index.md' "$f" || echo "NG $f"
done; echo "propagation checked"

# 検査6: operator エントリ2本が database/index.md の operator 専用経路に実在する
for e in list-poisoned-jobs requeue-poisoned-job; do
  grep -q -- "$e" spec/database/index.md && echo "OK $e" || echo "NG $e"
done

# 検査7: 「cross-DO RPC を含む」kind の集合と「契機の同一性が同一」の kind の集合が一致する
T=$(awk '/^## 回収の全数表/,/^## kind 別/' $R)
inc=$(printf '%s\n' "$T" | grep -c '| 含む |')
same=$(printf '%s\n' "$T" | grep -c '| 同一 |')
both=$(printf '%s\n' "$T" | grep -c '| 含む | 同一 |')
echo "inc=$inc same=$same both=$both"
[ "$inc" -eq "$both" ] && [ "$same" -eq "$both" ] && echo OK || echo NG

# 検査8: 不変条件は9本
[ "$(grep -c '^- \*\*(RC-' $R)" -eq 9 ] && echo OK || echo NG
```

- **検査5 が「正本と適用先の散文の整合」を見る形である。** 適用先を表として持ち、各ファイルが本ファイルを参照していることを機械で確認する。**適用先の表に行を足したら検査5 の対象が自動で増える**（awk が表から読むので、行を足すこと自体が検査の更新である）。**適用先を外してはならない**（外した瞬間に検査が空回りする）
  - **限界を併記する。検査5 が見るのは参照の実在までであり、断定の中身が正本と一致しているかは見ない。** 適用先が本ファイルを参照したまま内容だけずれる形はこの検査を通る。**中身の一致を守るのはレビューであり、機械検査ではない** — この限界を書かずに「正本と適用先の整合を検査する」とだけ書くと、検査が保証していない範囲まで保証していると読まれる
- **行数を数える検査（検査1 / 検査3）は、行の先頭の書式に依存させない。** 表の全行（`^| `）からヘッダ1行を引く形にしてある — **セルの先頭がバッククォートや太字で始まる行だけを数える形にすると、その書式に従わない行を1本足すだけで「N つで全数」を破っても検査が OK のまま通る。** 残る限界は、**同じ節の中に表以外の `| ` で始まる行を置くと数に混ざること**であり、そのときは検査が NG 側へ倒れる（見落としではなく誤検出になる向きである）
- **検査4 が「同時に入れた修正どうしの整合」を見る形である。** 材料の寿命を「必要とする段」と「消える段」の2列で表に持ち、**段名の実在**と**寿命の順序**を突き合わせる。ある修正が材料の削除を別の段へ移し、別の修正がその移動を知らずに書かれた形は、削除を別の段へ移した瞬間に「消える段」の値が変わり、それが必要とする段より前になれば `NG lifetime` として出る。**この2表の対応が検査の実体であり、片方だけを直すと落ちる**

## 受容した残余

- **終端した登録 saga の孤児 mapping にリセットメールが届きうる窓。** `active` な孤児 mapping が `passwordVerifier` を持つ場合、後始末が完了するまでのあいだリセット依頼はその行を解決してトークンを発行し、メールが届く。利用者がリンクを踏んでも `credential_locators` が空なのでログインの到達性検査が拒否し、**認可はどの向きにも開かない。** 後始末の S3 / S4 が写像行とトークン行を同じトランザクションで消すので窓は閉じる
- **印が失われたまま材料が掃除される窓。** phase 2 が成功し `saga_committed` を書く前に落ち、かつ以後 User Data DO が恒久的に到達不能な場合、後始末の S2 も成功しないので `poison` へ落ちる。予約 TTL の不等式が後始末の完走までは材料を守るが、**原因が恒久的なら最終的に「ログイン手段を持たないアカウントが残り、canonical は握られたまま、記録は `poison` 行に残る」形で終わる。** 受け口は `requeue-poisoned-job`（原因の解消が先）である。**operator の反応が予約 TTL より遅く、再駆動の時点で材料が掃除されていた場合も、S1 は `done` にせず `cleanup-material-lost:` を冠して `poison` へ落とし直すので記録は残る**（上の S1 の項）
- **`'advanced'` 残渣の恒久ロックアウト。** 原因が恒久的（対象 User Data DO の `SQLITE_FULL`）な場合、**起点によらず**利用者に自力の脱出経路が無い — `change_state='advanced'` のあいだログイン照合はダミーへ倒れ、リセットを再依頼しても新しい saga の phase 2 が同じ地点で止まるからである。**巻き戻しでは閉じない**（既に進んだ版に古い検証材料を載せることになる）ので、operator が容量を解放するまで閉じない。**解消さえすれば利用者のリセット1回で自力で閉じる**ので、operator に要求するのは容量の解放であってジョブの再投入ではない（再投入は残渣を早く片付けるだけである）
- **`'pending'` を巻き戻したあとに版の不一致が残る窓。** phase 2 がコミットした後・`'advanced'` を書く前に落ちた場合、巻き戻しは `change_state` を `NULL` へ戻すが Directory 側の版は1つ古いままなので、**起点 A の利用者は旧パスワードでログインできない**（到達性検査の版照合で拒否される。認可は開かない）。**回復経路はリセットの再依頼であり、その1回の完走が両側の版を揃えて解消する。** `'advanced'` を phase 2 の成功「後」に書く fail-safe の向きが受容している窓と同じものである
- **`terminal_reason` が `ConflictError` の種別を区別しないこと。** 一意性違反と OCC 不一致がどちらも `forward-conflict` に畳まれるので、operator は `terminal_reason` だけからは「再投入で回復するか」を判別できない（`poison` 行の `kind` と残渣の実物を見る必要がある）。トークンを増やすと運用系への露出が細かくなるので、識別の欠落の側を受容する
- **残渣を指さない `poison` 行が生まれうること。** 完走した saga が終端モードへ入り、突入から後始末までのあいだに利用者の退会・SSO 解除がコーディネーター行を消すと、S1 は材料を引けず `cleanup-material-lost:` で `poison` へ落ちる。**そのとき残渣は既に別の経路が片付けているので、`poison` 行は記録だけが残った形になる**（S1 の項の順序 (ii)）。行からは順序 (i)（残渣が実在する側）と区別できないので、**operator は残渣の実物を確かめてから明示削除する。** 記録を残す側に倒したのは、逆（`done` にする）が「残渣が実在する側」を黙って捨てるからである
- **`poison` 行が自動で減らないこと。** 10 GB に算入し、減らす手段は再投入と明示削除の2つだけである（`quarantined` と同じ運用制約を引き受ける）。**増加が発信元単位のレート制限（transport 境界。本 spec の範囲外）に依存する点も併せて受容する** — 共有 bucket を継続的に `.overloaded` へ保てる主体は、未認証の登録を終端させて `poison` を積める（上の「増加の上限は `quarantined` と違うが、無条件ではない」）
- **前進も後始末も焼き切れた saga が canonical を長く握ること。** 予約 TTL の右辺に後始末の総経過時間を足した代償である
- **既に作られてしまった空 User Data DO。** 発見の口が構造的に無いので回収できない。防ぎ方（初期化分岐の単独性）だけが対策である

## 引き継ぎ

**本ファイルが定めず、他の設計・実装へ渡す事項の全数。**

- **運用**: `list-poisoned-jobs` / `requeue-poisoned-job` の到達制御・監査・件数上限と続きの引き方、**予約 TTL の実値**（右辺は本ファイルが確定させた2項 + マージン。**本ファイルは新しい運用値を1つも足していない** — 後始末は前進と同じ backoff 曲線と同じ再試行上限を使い、突入も待ちを挟まない）、`poison` 行の検知と再投入の手順（**残渣の種類ごとの受け口の表をそのまま運用手順の骨格に使う**。**`cleanup-material-lost:` の行だけは再投入ではなく明示削除である**）、`change_origin='reset'` の終端で容量の解消を先に要求すること、`purge-user-mappings` → `requeue-poisoned-job` の順序、**`poison` の増加を有界にする発信元単位のレート制限**（transport 境界の責務。本ファイルは限界として受容している）
- **能動通知**: `poison` 行の滞留の通知。本ファイルは受け口と入口までを定め、通知の設計は持たない
- **実装**: 終端モードの各契機で書く列（「終端モードの各契機で書く列」の表の全行）、kind 別の段（S1〜S4 / L1〜L3 / C1）、**`'advanced'` からの前進が phase 2 を再発行せず版を読み直すこと**、`abandon-account` の3分岐応答、`cancel-reservation` の「成功」1値の応答とリセットトークン同時削除、`poison` を prune しないこと、operator エントリ2本、**migration ゲートの初期化分岐の分離（User Data DO に限る）と `initialize-account` の業務書き込みとの同一トランザクション化**、**新規登録 saga の `operations` 行のライフサイクル**（phase 2 で作成 / phase 4 で `phase='done'`）
  - **退会側への要求3点**（「材料の寿命」）: **(1) `account.caller_token` を消す段は、未完了の連携 / 解除の手続きの記録が0件であることを前提条件に持つ。(2) `operations` の `kind IN ('link','unlink')` の行に `phase='done'` を書く段は、その行の `target_locators` の全要素へ `cancel-reservation` を発行し終えていること。(3) 退会の完走は `operations` の行を削除しない。** 退会 saga の段は本 spec の範囲外なので、この3点だけを要求として渡す
  - **saga のジョブ本体（前進と後始末）の層帰属**（「役割分担」）: 本ファイルは既存の帰属（アダプター側の台帳）に揃えて据え置いている。`purge-trash` がユースケース台帳に立っているのと扱いが違うので、見直すかは実装が決める
- **鍵ローテーションの実装**: 本ファイルは移送の規則を変更しない。移送の見送り（`status != 'active'` / `change_state IS NOT NULL` / locator 実在検査）が後始末の材料に触れないことは rotation/index.md の干渉表がそのまま持つ
