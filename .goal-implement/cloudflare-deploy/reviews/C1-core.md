# C1 core/application 独立レビュー

## 判定

**FAIL**。CF01 のローカル KDF/admission 契約と CF02 の login 競合制御は PASS した。retention owner paging とトップレベル content の削除順序も正しい。

一方、CF02 の bounded transaction は成立していない。`deleteTrashBatch()` が制限するのは親 content 行だけで、revision/source の `ON DELETE CASCADE` 行数は無制限である。独立再現では `limitPerKind=1` でも、1件の memo と501件の revision が同一 transaction で削除された。さらに `emptyTrash()` は複数 transaction を commit した後に503を返し得るが、既存 UI は失敗時に再取得せず、API/specにも部分成功を表す契約がない。

製品コード、`design.md`、`plan.md`、phase report は変更していない。本書だけを追加した。

## 検証対象

- 検証日時: 2026-09-06 01:00-01:07 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- phase report: `.goal-implement/cloudflare-deploy/phases/C1.md`
- manifest: phase report記載の30ファイル
- manifest block SHA-256: `dbf38533f255a38d5a682e20dda48a2fa0df2bf75c24c2e1eb0dab689d804665`
- manifest照合: **30/30一致**。`shasum -a 256 -c -` は全項目 `OK`
- worktree: C1 manifest対象以外の既存変更を含むため、合否判断は上記HEADと一致確認済みmanifestを対象にした

## 項目別判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| CF01 KDF強度 | PASS（workerd/local） | `N=32768, r=8, p=3, key length=64, maxmem=64 MiB`を維持。workerdで実hash/verify/invalidを再実行し3/3 PASS。 |
| CF01 concurrency 1 / bounded queue / overload | PASS（local） | active 1、queue 2、4件目をretryable `CAPACITY_EXCEEDED`で拒否。独立制御テストでFIFO、operation reject後のslot解放、超過拒否を確認。 |
| CF01 cancellation | 未検証・契約なし | `SecretCrypto`とqueueに`AbortSignal`がなく、待機requestのcancelはqueueから除去されない。queueは2件にboundedで恒久リークにはならないが、切断済みrequestも後でKDFを消費する。実Workersのrequest cancellationとの結合は未検証。 |
| CF01 retryable error transport | PASS（静的/unit） | `SystemError(CAPACITY_EXCEEDED)`は`retryable: true`。middlewareはredaction前に503を決め、client payloadにはcodeを消しても`retryable`を保持する。実server-function HTTP応答は本coreレビューでは未検証。 |
| CF01 fixed dummy hash | PASS | boot時hash生成を除去。固定hashはworkerdで既知passwordとのverifyが成功し、未知emailも同じ`verifyPassword`経路を通る。 |
| CF02 read/write UoW | PASS（local）/ remote未検証 | adapterは`transaction("read")`と`transaction("write")`を分離し、commit/rollback/closeを共通管理する。Node integrationはPASS。remote Tursoのbusy code、5秒timeout、retry適合性は資格情報なしのため未検証。 |
| CF02 login: transaction外KDF / state再検査 | PASS（local） | credential/attempt snapshotをread transactionで取得し、KDF完了後のwrite transactionでuser/hash/attemptを再読取する。差異時は最大3回再試行する。 |
| CF02 login: 同時失敗 / 成功+失敗 / lockout / session | PASS（local） | Node integrationで同時失敗がcount=2、成功+失敗が各1結果になる。既存lockout testもPASS。session生成はstate再検査後の同じwrite transaction内。 |
| CF02 login vs password reset | PASS（独立local再現） | verify中にcredential hashを差し替えるテストで、旧password loginはstate不一致後に再KDFされ失敗し、新sessionを作らない。新passwordは成功した。 |
| CF02 retention owner paging | PASS（local/static） | `id > afterId ORDER BY id LIMIT 25`のkeyset。52 ownerの独立テストで25/25/2の3 page、重複・欠落なし、全ownerを1回ずつ処理。空page/最終short pageで終了する。 |
| CF02 content削除順序 | PASS（top-level） | transaction内はdocuments → memos → unreferenced topics。101 documents + 1 topicの再現で第1batchは100 documentsのみ、第2batchは残りdocumentとtopicを削除した。 |
| CF02 retention/emptyTrash transaction data bound | **FAIL** | parentの`LIMIT 100`より下のrevision/source cascade数は無制限。最大300行というphase reportの主張は不正確。再現はB-001。 |
| CF02 emptyTrash部分成功 UI/API | **FAIL** | 40 transaction commit後に残件があると503をthrowするが、UIの`router.invalidate()`はsuccess pathだけ。部分削除後に表示をreconcileせず、既存specの「1回で全件削除」とも不整合。再現はB-002。 |

## Blockers

### B-001: cascade削除が無制限で、bounded transactionになっていない

- 場所:
  - `packages/core/src/adapters/fog/dataRepository.ts:174-210`
  - `packages/core/src/adapters/fog/schema.ts:27-32`
  - `packages/core/src/adapters/fog/schema.ts:51-62`
- 問題:
  - `DELETE ... LIMIT ?`が制限するのは `fog_memos` / `fog_documents` / `fog_topics` の親行だけである。
  - memo/document revision と document sources は `ON DELETE CASCADE` で、1親あたりの件数に上限がない。1 statement、親1行でも任意個の従属行を同一 transaction で削除する。
  - `rowsAffected`と`deletedCount`は親DELETEの件数しか表さず、C1 reportの「削除行は最大300件」「最大12,000行」は実際のDB変更行数・処理量の上限ではない。
  - したがって、remote interactive transactionを5秒内へ構造上収めるCF02完了条件を満たさない。revision履歴が長い通常データだけで発生できる。
- 独立再現:
  1. local libSQLでschemaを作り、削除済みmemoを1件作る。
  2. 同memoへ501件の `fog_memo_revisions` を作る。
  3. `deleteTrashBatch({ limitPerKind: 1 })` を1回実行する。
  4. 戻り値は`1`だが、同transactionでrevision 501件も0件までcascade削除される。

```text
REPRO: limitPerKind=1 reported 1 parent deletion but cascaded 501 revision deletions in the same transaction
```

- 必須修正:
  - transactionの上限を親件数ではなく、cascade対象を含む実処理量で成立させる。
  - 単純に親`LIMIT`を小さくするだけでは、1親に無制限の履歴があるため解消しない。
  - revision/sourceをboundedに段階削除するなら、途中でrestoreされても履歴が欠落したactive contentを作らない状態モデルまたはpurge tombstone/leaseが必要である。親候補の従属行数を事前集計してbudget内だけ選ぶ方式も、budget超過の単一親を永続的に処理不能にしない設計が必要である。
  - 修正後、1親に上限超過のrevision/sourceがあるケースと、topic配下document/revision/sourceの合算ケースを実効テストに追加する。

### B-002: `emptyTrash`の部分commitをUI/APIが表現・再同期しない

- 場所:
  - `packages/core/src/application/fog/trashServices.ts:151-169`
  - `packages/core/src/application/fog/dataTypes.ts:75-77`
  - `apps/web/app/components/fog/TrashBoard.tsx:55-101`
  - `apps/web/app/presentation/errorResponse.ts:92-95`
  - `apps/web/app/presentation/errorDisplay.ts:50-52`
  - `spec/scenario/trash.md:35-38`
  - `spec/pages/index.md:209-215`
- 問題:
  - 最大40回のwrite transactionはそれぞれcommit済みになる。残件時はその後のreadを経てretryable 503をthrowするため、エラー結果が「変更なし」を意味しない。
  - UIは`router.invalidate()`をsuccess pathでだけ呼ぶ。catchは汎用エラー表示だけなので、部分削除後のserver stateを再取得しない。
  - clientへはsystem error codeがredactされ、表示は「システムエラーが発生しました」だけである。利用者は一部が削除済みで、残りに再実行が必要だと判断できない。
  - `DataServices.emptyTrash(): Promise<void>`にもprogress/partial outcomeがなく、既存specと確認dialogは「全件を1回で削除」と断定している。
- 独立再現:
  1. mock UoWで40回の`deleteTrashBatch()`を各300件成功させ、続く`hasTrash()`を`true`にする。
  2. `emptyTrash()`は40 commit相当の呼出し後、`CAPACITY_EXCEEDED` / `retryable: true`をthrowすることを確認した。
  3. 実UIでは同じerror pathが`TrashBoard.tsx:99-101`へ入り、invalidateせずdialogを残す。

```text
PASS: 25-owner keyset pages, 52 owners once, emptyTrash bounded at 40 commits with retryable partial result
```

- 必須修正:
  - designどおり部分成功を採るなら、UIはエラー時も必ずinvalidateして残件へreconcileし、「一部削除済み・残りは再実行可能」を表示する。retryable部分結果を型付きにするか、このoperationに限り安全な識別子をclientへ伝える。
  - `spec/scenario/trash.md`と`spec/pages/index.md`を、bounded複数回実行の現在契約へ同期する。1操作で全件を保証するなら、503部分成功ではなく、その保証とtransaction boundを両立する別方式が必要である。
  - 40batch到達・残件あり/なしの両方と、UI再取得をテストする。

## Warnings

### W-001: queued KDF cancellationの契約がない

- 場所: `packages/core/src/adapters/fog/boundedCrypto.ts:11-37`、`packages/core/src/application/fog/ports.ts:114-121`
- 内容: FIFO queueはresolve callbackしか保持せず、request abortを受け取れない。待機中にclientが切断しても、そのjobは後で実行される。
- 影響: queue長は2にboundedでmemory leakにはならないが、切断を多用するtrafficが後続の正規requestを一時的に503へ追いやる。active `node:crypto.scrypt`自体の中断可否とは分け、少なくとも未開始queue itemの取消可否を設計判断として記録すべきである。
- 判定: 現在のCF01完了条件はcancelを要求していないため単独ではFAILにしない。実Workersでのabort挙動は未検証。

### W-002: read transactionが型でread-onlyになっていない

- 場所: `packages/core/src/application/fog/ports.ts:94-112`
- 内容: `FogUnitOfWorkProvider.read()`もwrite methodを含む完全な`FogUnitOfWork`をcallbackへ渡す。現在の呼出しはreadだけだが、repository原則の「不正状態を型で排除」に反し、将来applicationからread transaction内writeを記述できる。
- 提案: `FogReadUnitOfWork`を読み取りportのsubsetとして分けるか、少なくともread contextを型上read-only capabilityへ制限する。JSDocの「reads ... and writes share one transaction」も`read()`追加後の契約を正確に表していない。

## login algorithm 詳細

- KDF境界: `unitOfWork.read()`完了後に`verifyPassword()`を呼び、write transaction開始前に完了する。独立instrumentationとNode integrationの両方でwrite transaction中のverifyが0件であることを確認した。
- TOCTOU: write transaction内でemail user、credential hash、attempt key/count/expiryを再読取し、snapshotと全項目比較する。resetによるhash変更、同時failed loginによるattempt変更、unknown userの同時registerはいずれも不一致になる。
- retry: 初回+最大3 retry。各retryは新snapshotに対して新しいKDFを行う。状態が継続的に変わる場合はretryable 503で終わり、古い検証結果をcommitしない。
- lockout: active countが5以上なら正しいpasswordでも拒否する。expired attemptはinactiveとしてcount 1・新expiryへ置換される。既存境界testは5回失敗、lockout、16分後成功を確認する。
- concurrent failures: 同一snapshotから始まっても、先行writeがattemptを更新した後、後行writeはstate mismatchになり再KDF/再試行するためlost updateにならない。実DB testで最終count=2。
- success + failure: 失敗が先なら成功側が新attemptを読んで再試行し、成功時にattemptを削除する。成功が先なら失敗側はnull stateと一致してattemptを1にする。両順序とも成功sessionと認証失敗を線形化できる。
- password reset race: credential hash変更がloginのKDF後ならwrite再検査で検出する。login writeが先にcommitした場合、後続resetが全sessionを削除するためresetの線形化後は旧sessionが無効になる。
- 残る外部gate: remote Tursoのtransaction競合codeとadapter retry、実Workers isolateをまたぐ同時HTTP login、実memory/CPUは資格情報なしで未検証。

## retention / deletion 詳細

- owner pagingは昇順keysetで、`afterId`を最終owner IDへ更新する。固定snapshotでは重複・欠落・無限loopはない。owner追加が無期限に続けばinvocation全体のpage数には上限がないが、各read pageとowner write transactionは分離される。今回のdesignはinvocation全owner走査を許容しているため、これだけではFAILにしない。
- 各ownerは1 invocationにつき`deleteTrashBatch()`を1回だけ実行する。期限切れbacklogは日次に最大100件/kindずつ進む。
- documentをtopicより先に消し、topic DELETEは参照documentが1件もないものだけを選ぶ。新しいdeleted documentやactive documentが残るtopicは消さない。
- memoの順序はtopic参照と独立。document sourceはFK cascadeで削除される。
- top-levelのstatement数は3、parent rowsは最大300だが、B-001のcascadeにより実処理量はboundedではない。

## 独立テスト結果

| 実行 | 結果 |
| --- | --- |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。195 files、既存`staticAssets.test.ts`のinfo 1件、修正なし。 |
| `pnpm test:unit` | PASS。13 files / 76 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 86 tests。 |
| `pnpm exec vitest ...crypto.cloudflare.test.ts --config vitest.config.integration.cloudflare.ts` | PASS。1 file / 3 tests、実scrypt。 |
| bounded queue独立制御テスト | PASS。FIFO、capacity rejection、operation failure後のslot release。 |
| login-reset独立競合テスト | PASS。KDF中のcredential更新を検出し、旧passwordで新session 0、新password成功。 |
| retention paging mock | PASS。52 ownerを25/25/2で各1回処理。 |
| topic/document実DB batch | PASS。101 documents時、100削除後topic保持、次batchでdocument 1 + topic 1削除。 |
| cascade bound実DB再現 | **FAILを再現**。parent limit 1に対しrevision 501件を同一transactionでcascade。 |

## 再レビュー条件

1. B-001を、単一親の巨大履歴を含めて実処理量が構造上boundedになる方式へ修正する。
2. B-002の部分成功をAPI型・error transport・UI再取得/表示・specで一貫させる。
3. 少なくとも次の回帰testを追加する。
   - 1 contentに上限超過revision/sourceがあるbounded purge。
   - topic + documents + revisions + sourcesの合算boundと削除順序。
   - `emptyTrash` 40batch到達後の残件あり/なし。
   - 503部分成功後のTrash UI invalidateとretry表示。
   - password resetがlogin KDFと競合する実DB test（今回の独立再現を恒久化）。
4. manifestを更新して実装を再凍結し、Node integrationとworkerd focused testを再実行する。

実accountを要するremote transaction error code/timeout、実Workers memory/abortはC2以降のstaging gateとして引き続き未検証である。

## 再検証 2026-09-06 01:34-01:41 JST

### 判定

**FAIL**。B-CORE-001の元再現である「1 memo + 501 revisions」は、修正後の`deleteTrashBatch()`単体ではPASSした。B-CORE-002のtyped partial result、server action return、partial/error双方のinvalidate、残件messageもPASSした。

ただし、導入した`purging`中間状態と既存のtopic group restore / hard deleteが整合していない。restorable topicの配下documentだけが先に`purging=1`となる正常なbatch境界でtopicを復元すると、documentはactiveかつpurgingとなり、後続batchが復元済みdocumentのrevisionとdocument本体を削除する。同じ中間状態でtopicを個別hard deleteすると、新しいbounded batchを迂回してhidden childと全revisionを一括cascadeする。B-CORE-001/002を受け入れてC1 coreをPASSにはできない。

### 検証対象の固定

- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- 再検証manifest: `.goal-implement/cloudflare-deploy/phases/C1.md`の「再検証 SHA-256 manifest」41件
- manifest block SHA-256: `2131b5d8d08a250a076073a67d95f602517baa22cab47a77b20eca2c9f19e6a0`
- 照合結果: **41/41一致**。全ファイルが`shasum -a 256 -c`で`OK`
- 製品コード、phase report、`design.md`、`plan.md`は変更していない

### B-CORE-001 元再現の再判定

**PASS（`deleteTrashBatch`単体）**。

独立fixtureで削除済みmemo 1件と501 revisionsを作り、`limitPerKind: 1`で親が消えるまで実行した。結果は503 transaction（purging mark 1、revision 501、parent 1）であり、各transactionのapplication table実変更は正確に1行、`processedRowCount`も常に1だった。最初のtransactionでrevisionは501件のままなので、元の無制限cascadeは発生しない。

```text
PASS: original 1 memo + 501 revisions repro now converges in 503 transactions, exactly 1 application row changed per transaction, no cascade
```

statementはコード上最大9本である。順序はsource links、memo revisions、document revisions、documents、memos、参照のないtopics、documents/memos/topicsのpurging markとなる。親DELETEには対応するrevision/sourceの`NOT EXISTS`があり、production schema上その親から他にcascadeするtableはない。

追加した独立再現もPASSした。

- purging開始後にmemo revisionを1件直接追加すると、後続3 transactionで既存revision、late revision、親の順に削除し、各transaction 1行以内を維持した。
- purging開始後のdocumentへactive memoのsource linkを直接追加すると、次のtransactionがsourceを先に削除し、その後revision、documentの順に収束した。active memoとtopicは残った。
- 既存integrationの501 revision test、small policyのpartial→complete testもPASSした。

### B-CORE-002 元再現の再判定

**PASS（主要契約）**。

- `EmptyTrashResult`は`status: "complete" | "partial"`、`deletedCount`、`remainingCount`を返す。
- `emptyFogTrash`はapplication resultをserver actionから返す。
- `runEmptyTrashMutation`はoperationを`try/finally`で包み、typed partialとthrowの双方で`router.invalidate()`を呼ぶ。
- partial messageは削除済み件数または履歴処理中であることと残件数を表示し、dialogを保持して再実行できる。
- `trash()`はrestorable itemsと`purgingCount`を分け、処理中件数も再取得後に表示する。
- `spec/scenario/trash.md`と`spec/pages/index.md`はpartial/retry/error reconciliationへ同期された。
- focused unit test 2件はpartial/exception双方のinvalidateを検証してPASSした。

### B-CORE-003: group restore / hard deleteがpurging childを復活・一括cascadeする

- 場所:
  - `packages/core/src/adapters/fog/dataRepository.ts:60-62`
  - `packages/core/src/adapters/fog/dataRepository.ts:132-172`
  - `packages/core/src/adapters/fog/dataRepository.ts:232-268`
  - `packages/core/src/application/fog/trashServices.ts:92-115`
- 重大度: **Blocker**
- 原因:
  - 新規batchは最後にdocuments → memos → topicsの順で`purging=1`へ移行する。row budget境界では「documentはpurging、topicはrestorable」が正常に残る。
  - `trash()`はpurging documentを非表示にするが、restorable topicは表示する。
  - topic restoreのgroup UPDATEは`purging=0`を条件にせず、配下のpurging documentまで`deleted_at=NULL`へ戻す。`purging`は1のままなので、active/purgingという不正状態になる。
  - 後続`deleteTrashBatch()`のchild/parent排出条件は`purging=1`であり、`deleted_at IS NOT NULL`を要求しない。したがって復元済みdocumentのrevisionを削除し、最後にactive document本体も削除する。
  - topic `hardDelete()`もpurgingを区別せず、同groupのhidden documentを直接DELETEするため、remaining revision/sourceを新しいrow budget外でcascadeする。

#### 復元済みdocument消失の再現

1. topic 1件とdocument 1件を作り、topicをsoft deleteする。
2. `deleteTrashBatch({ limitPerKind: 1 })`を1回実行する。
3. DB stateはtopic=`deleted,purging=0`、document=`deleted,purging=1`となる。
4. 公開serviceの`restore({ kind: "topic" })`を実行する。
5. topicとdocumentの`deleted_at`はNULLになるが、documentの`purging`は1のままになる。
6. 後続batchを実行するとdocument revisionの後にdocument本体が削除され、復元済みtopicのdocumentsは0件になる。

```text
after first batch { td: '2026-09-06T00:00:00.000Z', tp: 0, dd: '2026-09-06T00:00:00.000Z', dp: 1 }
after topic restore { td: null, tp: 0, dd: null, dp: 1 }
REPRO: restored topic remains active but its restored purging document was subsequently hard-deleted; document count 0
```

#### bounded purge迂回の再現

1. documentに501 revisionsを持つtopicをsoft deleteする。
2. row limit 1のbatchでdocumentだけをpurgingへ移行する。
3. まだrestorableなtopicを公開serviceの`hardDelete()`で個別削除する。
4. 1 transactionでhidden documentと501 revisionsがcascade削除される。

```text
REPRO: after a 1-row bounded batch marked the child purging, hardDelete(restorable topic) cascaded 501 document revisions and the hidden child in one transaction
```

- 必須修正:
  - group restoreはpurging childをactiveへ戻さない。少なくともgroup child UPDATEを`purging=0`へ限定し、topic/childの全組合せで状態遷移を定義する。
  - documentのtrash projectionがpurging parentを通常の`deleted` parentとして扱わないようにし、child単独restoreがpurging parentを復元しようとする経路も閉じる。
  - group hard deleteを直接cascadeさせず、topicと対象childを同じbounded purging protocolへ参加させる。個別memo/document hard deleteも長いrevision履歴を直接cascadeするため、Cloudflare remote transactionの構造上の上限をどこまで要求するか明示する。
  - schemaに`purging=1 => deleted_at IS NOT NULL`の不変条件を置くか、同等の不正状態防止を全write pathで保証する。
  - topic/documentsの一部だけがpurgingとなった各batch境界で、restore、hard delete、再実行、late child/source追加を交差させるintegration testを追加する。

### UI残件表示の非blocking指摘

`apps/web/app/components/fog/TrashBoard.tsx:150-154`は`shown.length === 0`だけで「ゴミ箱は空です」を表示する。`purgingCount > 0`でも同時に空表示となり、更新した`spec/pages/index.md:213`の「削除処理中の項目もなければ空」と一致しない。処理中件数と再実行buttonは表示されるためB-CORE-002のデータ再同期自体は成立するが、empty state条件を`shown.length + purgingCount === 0`へ合わせるべきである。

### 回帰結果

| 実行 | 結果 |
| --- | --- |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。198 files、既存`staticAssets.test.ts`のinfo 1件のみ。 |
| `pnpm test:unit` | PASS。14 files / 78 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 88 tests。 |
| workerd KDF focused | PASS。1 file / 3 tests。実scrypt、invalid、fixed dummy、concurrency/admission。 |
| `trashMutation.test.ts` focused | PASS。1 file / 2 tests。partial/error invalidate。 |
| 1 memo + 501 revisions独立再現 | PASS。503 tx、各1行、cascadeなし。 |
| purging後のlate revision/source独立再現 | PASS。子を親より先に排出し参照先active contentを保持。 |
| topic途中restore独立再現 | **FAILを再現**。active/purging documentを作り後続purgeで消失。 |
| topic途中hard-delete独立再現 | **FAILを再現**。501 revisionsを1 transactionでcascade。 |

CF01のKDF強度、concurrency 1、queue 2、retryable overload、fixed dummy hashと、CF02 loginのtransaction外KDF、state再検査、lockout、同時成功/失敗、password reset競合は対象hashが初回レビュー時から不変であり、上記typecheck/unit/Node integration/workerd再実行もPASSした。remote Tursoと実Workersの外部gateは引き続き未検証である。

### 次回再レビュー条件

1. B-CORE-003のtopic/document group中間状態を修正する。
2. 上記2再現を恒久integration testにし、全batch境界で復元済みactive contentが後続purge対象にならないことと、個別操作がrow budgetを迂回しないことを確認する。
3. UI empty stateのspec不整合を修正する。
4. 新manifestを固定し、元B-CORE-001/002、B-CORE-003、login/KDF回帰を再実行する。

## 最終再検証 2026-09-06 02:06-02:12 JST

### 判定

**FAIL**。新manifest 41件は全件一致し、B-CORE-003の元再現2件は修正されている。DB CHECK、最初のchild marker直後のtopic/document restore拒否、個別hard deleteのbounded化、501 revisionsとlate revision/source、failure再開、typed partialとUI再同期もPASSした。旧B-CORE-001/002とlogin/KDFにも回帰はない。

ただし、topic自身を`purging=1`へ遷移させず、配下のpurging childがある間だけtopicを処理中として投影している。行予算を使い切って最後のpurging childを削除し、次のchildまたはtopicをmarkする前のtransaction境界では、完全削除が進行済みのtopicが再び復元可能になる。独立fixtureでは元2 documentsのうち1件を完全削除した後にtopic restoreが成功し、1 documentだけのactive topicになった。`purging`の不可逆境界と「active contentへ履歴欠損状態を復元しない」というC1契約を満たさない。

### 検証対象

- 検証日時: 2026-09-06 02:06-02:12 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- manifest: `.goal-implement/cloudflare-deploy/phases/C1.md`の「B-CORE-003 再検証 SHA-256 manifest」41件
- manifest block SHA-256: `00f3d5661e0f3de0945ce6fa286287b315b2adc2604f977152e13d4f65ff3815`
- manifest照合: **41/41一致**。`shasum -a 256 -c`は全項目`OK`
- 一時的な独立再現testは実行後に削除した。製品コード、設計、plan、phase reportは変更していない

### 項目別判定

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| CF01 KDF強度 / fixed dummy | PASS | `N=32768, r=8, p=3, 64 bytes, maxmem=64 MiB`と固定有効hashを維持。workerd focused 3/3 PASS。 |
| CF01 concurrency 1 / queue 2 / overload | PASS | 同一isolateでactive 1、FIFO queue 2、4件目はretryable `CAPACITY_EXCEEDED`。例外時も`finally`でslotを解放する。request abortによる待機job取消は従来どおり契約外。 |
| CF02 UoW / 依存方向 / 型 | PASS（既知warningあり） | application portをadapterが実装し、presentationはapplication serviceを呼ぶ依存方向を維持。read/write transaction mode、commit/rollback/closeはNode integrationでPASS。`read()`が型上write capabilityも公開するW-002は未解消。 |
| CF02 login / reset競合 | PASS | scryptはread transaction終了後、write transaction開始前。write内でuser/hash/attemptを再検査し、同時失敗、成功+失敗、lockout、session、password reset競合の既存回帰がPASS。 |
| B-CORE-001 元再現 | PASS | 1 memo + 501 revisionsはmark 1、revision 501、parent 1の503 transactionへ分割され、各transactionのapplication変更行は1以下。親DELETEはrevision/sourceの`NOT EXISTS`を要求する。 |
| 実変更行 / statement上限 | PASS | `remaining`を全DMLへ渡し、1 transactionの変更行合計を注入limit以下にする。source、memo revision、document revision、document、memo、target topic detach/delete、purging topic、markerの最大9 statement。production schemaのparent cascadeは事前に空を確認する。 |
| topic/document/memo順序 | PASS（marker gapを除く） | child source/revisionを先に排出し、document/memo parent、参照documentがないtopicの順に削除する。個別document/memoも同じprotocol。先行個別削除documentはtopicからbounded detachされる。 |
| 501 revisions / late revision / late source | PASS | focused integrationで各transactionのaudit行数はlimit 5以下。late revision/sourceも再実行でchildより先に排出され、共有元memo、active item、別ownerを保持した。 |
| failure再開 / FK / marker cleanup | PASS | topic DELETE trigger failure後もcommit済みbounded進捗を保持し、trigger除去後に再開して収束。`PRAGMA foreign_key_check`は空で、完了後の`purging=1` markerは0件。 |
| topic restore/hardDelete全境界 | **FAIL** | 最初のchild marker直後のrestore拒否はPASSするが、そのchildを行予算ちょうどで削除した後にtopic markerが消える。partial応答後のtopic restoreが成功して、既に完全削除したchildを欠くactive topicを作る。B-CORE-003残存。 |
| DB CHECK / conditional / recheck | 部分PASS | `purging=1 AND deleted_at IS NULL`はDB CHECKで拒否され、restore UPDATEも`purging=0`条件と行数再検査を持つ。今回の境界ではtopic/残childのどちらにもmarkerがないため、CHECKと再検査を正当に通過してしまう。 |
| B-CORE-002 typed partial / server action | PASS | `hardDelete`/`emptyTrash`は`{status, deletedCount, remainingCount}`を返し、server actionも結果をreturnする。small policyのpartial→completeがPASS。 |
| UI invalidate / 残件 / error整合 | PASS（blocker影響あり） | partial、complete、throwの全経路で`finally`からinvalidateする。partial notice、残件数、「残りを削除」「削除を続ける」、`aria-busy`と「処理中…」、purging-only非empty判定をunit/静的確認した。ただしmarker gapでは再取得後のtopicに復元buttonが再び有効になる。 |
| retention paging | PASS | ownerは`id > afterId ORDER BY id LIMIT 25`のkeysetで、空またはshort pageで終了する。各owner最大4 transaction。固定集合で欠落・重複・無限loopはない。 |

### B-CORE-003残存: topic markerがchild排出境界で消える

- 場所:
  - `packages/core/src/adapters/fog/dataRepository.ts:62-65`
  - `packages/core/src/adapters/fog/dataRepository.ts:195-208`
  - `packages/core/src/adapters/fog/dataRepository.ts:238-247`
  - `packages/core/src/adapters/fog/dataRepository.ts:258-312`
  - `packages/core/src/application/fog/trashServices.ts:154-191`
- 重大度: **Blocker**
- 原因:
  - target topic経路は同groupのdocumentだけを`purging=1`にし、topic行自身はmarkしない。
  - trash projectionはtopic自身またはpurging childが存在するときだけtopicを`purging`と表示する。
  - batch冒頭でpurging documentを削除して`remaining=0`になると、末尾の次child markerは実行されない。このcommit後はtopicがdeleted/purging=0、残childもdeleted/purging=0となる。
  - `hardDelete()`の最終`isPurgeTargetActive()`はtopicがまだdeletedであることしか検査しないため、typed partialを正常返却する。次のrestoreはtopic/descendantの`purging=1`を見つけず成功する。
  - 同じgapはtarget hard deleteだけでなく、generic emptyTrash/retentionがtopic自身をmarkする前にchild削除で予算を使い切るinterleavingでも成立する。

#### 独立再現

1. topic 1件とdocuments 2件を作成し、topicをsoft deleteする。
2. `trashBatchPolicy={ rowLimit: 1, maxTransactions: 1 }`のserviceでtopic `hardDelete()`を3回呼ぶ。
3. 1回目はchildをmark、2回目はそのrevisionを削除、3回目はchild本体を削除する。3回とも`status: "partial"`で、3回目の残件はtopicと未処理childの2件になる。
4. 3回目のinvalidate相当の再取得ではtopicの`purging`が`false`で、restoreが有効になる。
5. topic `restore()`は成功し、取得したactive topicのdocumentsは元2件ではなく1件になる。

```text
PASS (repro observed): three 1-row topic purge calls returned partial; topic purging=false; restore fulfilled; active documents=1 of original 2
```

期待不変条件を直接assertした独立testは`expected false to be true`で失敗した。現在挙動をassertする再現testは1/1 PASSしたため、タイミング依存ではなくtransaction順序から決定的に発生する。

#### 必須修正

- topic group purgeの開始時にtopic行自身へ永続的な`purging=1` markerを置き、全child排出からtopic削除まで消えないようにする。行予算が1なら最初のtransactionをtopic markerだけに使ってもよい。
- target topic DELETEは、restorableなdeleted topicではなく、その永続markerを持つtopicだけに限定する。
- generic emptyTrash/retentionでも、topic groupのchild処理より先にroot markerを確立するか、同等の不可逆状態を永続化する。
- row limit 1で全transaction境界ごとにtopic restoreとdocument set restoreを試し、開始後は常に`PURGE_IN_PROGRESS`であることを恒久testにする。partial応答後、同時restore、途中failure、late child/revision/sourceでも同じ不変条件を確認する。

### 独立テスト結果

| 実行 | 結果 |
| --- | --- |
| manifest再計算と`shasum -a 256 -c` | PASS。block hash一致、41/41 files一致。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。198 files、既存`staticAssets.test.ts`のinfo 1件、変更なし。 |
| `pnpm test:unit` | PASS。14 files / 79 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 92 tests。 |
| workerd KDF focused | PASS。1 file / 3 tests。 |
| B-CORE-003 focused integration | PASS。1 file / 7 selected tests、15 skipped。元再現、個別delete、501 revisions/late link、競合、partial、failure再開を含む。 |
| UI/error transport focused | PASS。2 files / 11 tests。 |
| topic marker gapの独立不変条件test | **FAILを再現**。3回目の1-row transaction後、topic `purging`は`false`。 |
| topic marker gapの現在挙動test | **再現PASS**。topic restoreが成功し、active documentsは元2件中1件。 |

### 未検証範囲

- 実Tursoの5秒timeout、writer競合error code、retry間隔は資格情報がないため未検証。
- 実Workers isolateをまたぐ同時request、memory/CPU、request abort時のqueued KDF取消は未検証。
- Cloudflare runtime entryの検証は別Verifierの担当範囲である。

## 最終再検証3 2026-09-06 02:21-02:27 JST

### 判定

**PASS**。前回のB-CORE-003 root marker gapは解消した。individual topic hard delete、generic emptyTrash、retention-shaped batchのすべてで、topic rootをchild処理より先に`purging=1`へ遷移させ、最後のchild削除後もtopic本体の最終削除までmarkerを連続保持する。前回の`rowLimit: 1, maxTransactions: 1`再現を全partial境界で繰り返し、topic restoreとdocument set restoreが常に`PURGE_IN_PROGRESS`となることを確認した。

旧B-CORE-001/002、B-CORE-003元再現、login/KDF、retention paging、typed partial/UI契約にも回帰はない。製品コードの追加修正を要するBlockerはない。W-001のqueued KDF cancellation、W-002のread UoW型capability、実Turso/Workersの外部gateは従来どおりC1 coreの未検証範囲である。

### 検証対象

- 検証日時: 2026-09-06 02:21-02:27 JST
- HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
- manifest: `.goal-implement/cloudflare-deploy/phases/C1.md`の「Root marker gap再検証 SHA-256 manifest」41件
- manifest block SHA-256: `c2c937f5e97f9a44731b7e157b434513982e52abb3e146c8f98147026148b484`
- manifest照合: **41/41一致**。`shasum -a 256 -c`は全項目`OK`
- 前回manifestとの差分: `TrashBoard.tsx`、`trashMutation.ts`、同test、`data.integration.test.ts`、`dataRepository.ts`の5件。残る36件はbyte-identical
- 独立fixtureは一時testとして実行後に削除した。製品コード、design、plan、phase reportは変更していない

### Root marker protocol

| 項目 | 判定 | 根拠 |
| --- | --- | --- |
| individual topic hard delete | PASS | target topicの最初のDMLはtopic自身のconditional mark。行予算1では初回transactionがroot markだけを変更し、以後の全partial境界でroot markerが残る。 |
| generic emptyTrash | PASS | targetなしの最初のDMLも期限対象topicのroot mark。複数topicは行予算内で順に開始され、未開始topicはrestorable、開始済みtopicは最終削除まで不可逆となる。 |
| retention | PASS | generic経路へ`deletedBefore`を適用し、期限内topicだけをroot-firstでmarkする。独立fixtureで1行batchの全境界を追跡して完了した。 |
| topic DELETE条件 | PASS | restorable topicを直接削除するtarget専用経路を除去。共通DELETEは`purging=1`かつ参照documentなしだけを対象にする。 |
| topic/set restore | PASS | topic行の`purging`をtrash projectionとrepository再検査が直接検出する。残childが未markでもdocumentのparentは`purging`となり、set restoreを拒否する。 |
| UI restore button | PASS | `isTrashRestoreDisabled(item.purging, parentPurging)`をcomponentとunit testで共有し、topic rootおよびroot配下documentの復元buttonをdisabledにする。server側拒否も併存する。 |
| childからparentの順序 | PASS | root mark後、source、memo revision、document revision、document、memo、異group document detach、参照なしtopic、残child markerの順。root DELETEは全document消失後だけである。 |
| 実変更行上限 | PASS | 全DMLが共有`remaining`をLIMITに使う。root marker追加後も1 transactionの変更行合計は`limitPerKind`以下。row limit 1と5のaudit testが各上限を確認した。 |
| statement上限 | PASS | target topicはroot markを含め最大9 statement、genericもtopic markとdocument/memo markを含め最大9 statement。予算0後は`execute()`がdriver callを省略する。 |
| late child/revision/source | PASS | root mark後に同group deleted childとrevision/sourceを直接追加する独立fixtureがboundedに収束した。root markerは全境界で継続し、共有source memoを保持した。既存501 revisions/late link testもPASS。 |
| failure再開 | PASS | topic DELETE failureはそのtransactionだけrollbackし、先行commit済みroot/child進捗を保持する。trigger除去後の再実行でchild historyとrootを削除して完了した。 |
| 複数topic / 別owner | PASS | row limit 1のemptyTrashで同ownerのrootを1件ずつ開始し、開始済みmarkerの逆戻りなしに両topicを完了した。別ownerのtopic/childは不変だった。 |
| cleanup / FK | PASS | 完了後は対象root、全child、revision/source、`purging=1` markerが0件。`PRAGMA foreign_key_check`は空。先行個別削除documentと共有sourceは既存testどおり保持する。 |

### 前回gap元再現

前回と同じtopic 1件、documents 2件、`rowLimit: 1, maxTransactions: 1`でtopic `hardDelete()`をpartialの間だけ反復した。

- 初回はtopic rootだけをmarkした。
- 各partial応答後にDBのroot `purging=1`を確認した。
- 各境界でtopic restoreを試し、すべて`PURGE_IN_PROGRESS`となった。
- 残存documentのset restoreも、parent=`purging`としてすべて`PURGE_IN_PROGRESS`となった。
- 旧再現の3回目に相当する「最初のchild本体を行予算ちょうどで削除した直後」もroot markerが残った。
- 完了後はtopicと2 documentsが0件となり、部分復元は発生しなかった。

```text
PASS: every one-row partial boundary kept topic purging=1; topic/set restore always rejected; final root and children count=0
```

恒久test `topic root marker stays continuous across every one-row hard-delete boundary`も同じ境界をauditし、各transactionの実変更を1行以下としてPASSした。

### Generic経路とinterleaving

独立fixtureでは、同ownerの2 topicsと各child、別ownerのtopicとchildを作成し、1 transactionあたり1行のemptyTrashを完了まで反復した。開始済みrootは存在する限り常に`purging=1`で、purging childが非purging topicを参照する状態は0件だった。同ownerの2組は完全削除され、別ownerの2項目はtrashに残った。

retention-shaped `deleteTrashBatch({ deletedBefore, limitPerKind: 1 })`も完了まで反復した。各transactionの`processedRowCount <= 1`、root存在中の`purging=1`、全境界のrestore拒否、最終child/root削除、FK整合を確認した。

late child fixtureはroot mark後に同じdeletion groupのdeleted document、revision、source linkを追加した。後続batchはchildをmarkし、source/revision、child、rootの順に削除した。共有元memoは残り、markerとFK orphanは残らなかった。通常の公開application経路はdeleted/purging topicへの新規document作成を許可しないが、adapter境界のlate rowにもprotocolが収束することを確認した。

### 旧Blockerと回帰の適用範囲

- B-CORE-001: purge SQL本体はroot marker順序以外を維持する。1 memo + 501 revisionsの503 transaction分割と、document/topicのsource/revision先行削除testがPASSした。
- B-CORE-002: result type、server action、invalidate、partial noticeは前回からbyte-identical。unit 80件とUI/error focused 12件がPASSした。
- B-CORE-003元再現: DB CHECK、topic/child再検査、個別memo/document/topic hard delete、同時restore対hard delete、failure再開がfocused 9件でPASSした。
- login/KDF: application login、UoW、crypto、bounded queueは前回からbyte-identical。Node integration 94件とworkerd KDF 3件でtransaction外KDF、state再検査、同時失敗、成功+失敗、lockout、session、reset競合、fixed dummy、concurrency 1、queue 2、retryable overloadを回帰確認した。
- retention paging: application serviceとUoW adapterは前回からbyte-identical。25件keyset、全owner処理、空/short page終了の既存testがPASSした。

### 独立テスト結果

| 実行 | 結果 |
| --- | --- |
| manifest再計算と`shasum -a 256 -c` | PASS。block hash一致、41/41 files一致。 |
| `pnpm typecheck` | PASS。root/core/web。 |
| `pnpm lint` | PASS。198 files、既存`staticAssets.test.ts`のinfo 1件、変更なし。 |
| `pnpm test:unit` | PASS。14 files / 80 tests。 |
| `pnpm test:integration:node` | PASS。6 files / 94 tests。 |
| workerd KDF focused | PASS。1 file / 3 tests。 |
| root marker/旧Blocker focused integration | PASS。1 file / 9 selected tests、15 skipped。 |
| UI/error transport focused | PASS。2 files / 12 tests。 |
| 独立root marker/interleaving fixture | PASS。1 file / 4 tests。individual全境界、late child、複数topic/owner emptyTrash、retention-shaped全境界。 |

### 残る未検証範囲

- 実Tursoの5秒timeout、writer競合error code、retry間隔は資格情報がないため未検証。
- 実Workers isolateをまたぐ同時request、memory/CPU、request abort時のqueued KDF取消は未検証。
- Cloudflare runtime entryは別Verifierの担当範囲である。
