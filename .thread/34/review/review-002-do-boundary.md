# レビュー 002 — DO 境界・ルーティング設計の技術的妥当性

**対象:** PR #43（`issue/34/do-boundary-design`）/ Issue #34 対応項目3
**主成果物:** `.thread/34/design.md`（1,439行）
**ラウンド:** 2（1ラウンド目の指摘は前提にせず、ゼロベースで再検証した）
**検証方法:** design.md 全文精読 / `spec/inventory/adapter.md` の `ADP-*` 台帳85件の全数走査 / 引用実装の実ファイル照合 / Cloudflare 公式ドキュメント12ページの実取得

## DO 境界・ルーティング

### Blockers

- **[B-001]** 「epoch ガードを通らない RPC エントリは signup の1本だけ」という断定が成立しない。少なくとも3系統の RPC エントリが構造的に epoch を持ちえない
  - 場所: `.thread/34/design.md:383`（断定）/ `:468`（login step 5）/ `:682`（credential 変更 phase 2）/ `:754`（ローテーション手順3）/ `:651`（signup 前進 phase 2・4）
  - 理由: 第5.1節は「signup 以外のすべての RPC エントリは epoch ガードを通る、を #37 への断定として置く」と書いているが、同じ文書の中に epoch を運べない RPC エントリが3系統ある。
    (i) **login の step 5** — `{ usedLocator, credentialVersion }` を渡して `account` 状態・到達性・バージョンを確認し `sessionEpoch` を**取得する**呼び出しであり、第5.3節 step 5 自身が「epoch ガードはここでは効かない — login は新規にトークンを発行する側で、照合対象のトークンがまだ存在しない」と明記している。つまり第5.1節と第5.3節が正面から矛盾している。
    (ii) **Directory bucket → User Data DO の saga 前進 RPC**（signup の phase 2 / phase 4、credential 変更の phase 2、`sweep`・`rotate-remap` からの `credential_locators` 更新）— 呼び出し元は Alarm ハンドラであり、セッショントークンを持つ主体が存在しない。
    (iii) **退会の `finalize-withdrawal`** 経路も同様に自 DO 内 Alarm 起点で、epoch 照合の対象が無い。
    #37 が第5.1節の断定をそのまま実装すると login と全 saga が epoch 不一致で拒否され、逆に「例外があるらしい」と気づいて場当たりに穴を空けると、**どのエントリが認証を要求しどれが要求しないかの一覧が設計側に存在しない**状態になる。これは認証境界の定義そのものが欠けているのと同じで、他ユーザーの DO を指定させない構造的保証（第5.5節）の裏返しの半分（「その DO に対して誰が呼んでよいか」）が未定義になる。
  - 提案: RPC エントリを**3分類**して表にする — (1) セッション/AI トークン由来で epoch ガード必須のもの、(2) 未認証の bootstrap（signup・login の step 5・password reset 依頼）で epoch の代わりに個別ガード（`account` 行の有無 / `account.status` / 到達性検査 / `credentialVersion`）が守るもの、(3) DO 間 saga 用で **binding 到達性 + `operationId` + phase の CAS** が守るもの。第8.3節 (e) が「信頼境界は script 分離 + binding に置く」と既に書いているので、(3) の正当化はそこへ接続できる。あわせて第5.1節の断定文を「(1) に属する全エントリは epoch ガードを通る」に限定し、(2)(3) の全数を列挙する。

- **[B-002]** signup saga が跨ぐ DO は2つとは限らない。メール + SSO 主体を同時に登録する signup では Directory bucket が2つになり、コーディネーターの所有者・`sagaCommitted` の書き先・`resume-signup` の所有者がいずれも未定義になる
  - 場所: `.thread/34/design.md:611`（「跨ぐ DO は User Data DO と Directory bucket の2つだけである」）/ `:616`（phase 1「全 credential（メール、SSO 主体）の locator を安定ソートして決定順に予約する」）/ `:623`（「複数 credential を同時に登録する signup が互いにデッドロックしないための規則」）/ `:651`（「`resume-signup` ジョブは予約を書いた bucket の job table に投入し」）/ `:656`（`sagaCommitted` 印）
  - 理由: 同一節の中で「跨ぐ DO は2つだけ」と「複数 credential を決定順に予約する」が両立していない。しかもこれは仮定の話ではなく**現行 spec の要求**である — `spec/usecases/identity.md:91-92` の `registerOrLoginWithSso` は `findBySsoIdentity` で SSO 主体を引いたうえで `findByEmail(email)` によるメール重複検証を必須にしており、`0000_initial.sql:46,47` の `users_email_uq` / `users_sso_identity_uq` が示すとおりメールの一意性は SSO ユーザーにも掛かる。第6.1節 (c) が「一意性の権威はその canonical を写像する bucket の中の行」と決めた以上、SSO signup は **SSO canonical の bucket と メール canonical の bucket の2つ**に行を置く必要があり、両者は別 HMAC なので原則別 bucket に落ちる。帰結は3つ。
    (i) 第6.4節「落ちたときに操作の存在を知っているのは予約行だけ」が bucket 2つに分裂し、**どちらが phase 2→3→4 を前進させるのか**が決まらない。両方が前進させると phase 2 の RPC が二重に走る（冪等なので収束はするが、phase 3 は各 bucket が自分の予約しか昇格できないため、片方の bucket が落ちたままでも他方が phase 4 まで完走して `operations.phase = 'done'` を書ける）。
    (ii) request Worker が bucket A に予約を書いた直後に落ちると、**bucket B にはこの signup の痕跡が一切残らない**。A の `resume-signup` は B の予約を知らないので、メールが予約されないまま `active` なアカウントが完成しうる。以後そのメールで別人が signup できてしまい、グローバル一意性が破れる。第6.2節が (b) を採る最大の利点として掲げた「bucket 間の調整は要らない」が、ここで初めて成立しなくなる。
    (iii) `sagaCommitted` 印（第6.4節 2）は phase 2 の戻り値を受けて「phase 2 を起動した bucket」が書くとされているが、起動しなかった側の bucket には印が付かず、TTL 掃除がそちらだけ先に走る。
  - 提案: どちらかに倒して断定する。**(A) signup を1 credential に限る**と決めるなら、phase 1 の「全 credential を決定順に予約」と「デッドロック回避のための安定ソート」を削り、SSO signup におけるメール一意性をどう保証するか（例: SSO 主体の mapping 行に `encryptedCanonical` としてメールも持ち、メール bucket にも `kind: 'email'` の行を必ず置く → 結局 (B)）を別途書く。**(B) 複数 bucket を認める**なら、「跨ぐ DO は2つだけ」を撤回し、(1) コーディネーター bucket を決定的に1つ選ぶ規則（例: ソート後の先頭 locator の bucket）、(2) コーディネーター予約行が全 credential の locator 一覧を保持すること、(3) `sagaCommitted` を全 bucket に伝播する手順、(4) 非コーディネーター bucket の予約が孤立した場合の TTL 回収、を書く。第6.2節の「bucket 間の調整は要らない」も (B) では条件付きに書き直す必要がある。

- **[B-003]** SSO link の部分失敗に前進ジョブが無く、mapping が恒久的に孤立する
  - 場所: `.thread/34/design.md:705-711`（link の順序4手順）/ `:724`（`sweep-orphan-mapping` は unlink 前提）/ `:881-894`（`kind` の全数表に `resume-link` が無い）/ `:642-647`（第6.4節の部分失敗表は signup の phase しか扱わない）
  - 理由: link 手順3（Directory の予約を `active` へ昇格）と手順4（User Data DO に reverse locator を追加）の間で落ちると、**`status: 'active'` の mapping 行が `credential_locators` に対応行を持たない**状態で残る。この状態は誰にも回収されない。
    (i) `sweep-reservations`（第6.4節）は `status: 'reserved'` の行しか対象にしない — 第6.7節が「予約 TTL 掃除は `active` な孤児 mapping を回収できない」と自ら明記している。
    (ii) `sweep-orphan-mapping`（第6.6節）は User Data DO 所有で、検出材料の locator を「unlink 時に `operations` 行へ退避しておく」ことに依存している。link の失敗では退避が行われず、しかも **link に対する正しい修復は削除ではなく前進（locator の記録）**なので、同じジョブでは直せない。
    (iii) 第7.4節の `kind` 全数表に link 用のジョブが無い。
    結果として、その SSO 主体は「どのアカウントも到達に使えないが、他の誰も登録できない」永久ロックになる。login は第5.3節 step 5 (ii) の到達性検査で fail closed に拒否されるので認可は開かないが、**利用者は自分でリンクし直すこともできない**（第6.3節 phase 1 相当の予約が `ConflictError` で敗北する）。第6.4節が signup について「黙って到達不能アカウントを残すだけは選ばない」と明言した基準に照らして、link だけ同じ穴が開いている。
  - 提案: link を saga として明示し、`resume-link`（または `finalize-link`）を第7.4節の `kind` 表に足す。起点は User Data DO の手順1（`operations` に link を記録する時点）なので**所有者は User Data DO**にでき、第7.4節の「起点側が所有する」規則と整合する。`operations` 行に対象 locator を持たせ、手順2〜4 を冪等に再試行させる。あわせて第6.4節の部分失敗表を signup 専用から「cross-DO 操作の全数（signup / link / unlink / credential 変更 / 退会 / ローテーション）」に広げ、各行に「残るもの / 片付ける主体 / 前進か巻き戻しか」を書く。現状 signup 以外は各節に散っており、抜けが検出できない構造になっている。

- **[B-004]** パスワードリセットトークンに埋め込まれた `{generation}.{bucketIndex}` の妥当性検査が無く、未認証入力から任意の Directory DO を生成できる
  - 場所: `.thread/34/design.md:537`（トークン形式 `{generation}.{bucketIndex}.{random}`）/ `:522`（第5.5節 3 の「唯一の例外」）/ `:551`（第6.2節 判断軸 (iv)「bucket 数が天井になる。未認証の総当たりでも新しいオブジェクトは増えない」）
  - 理由: リセット URL は未認証で叩ける経路であり、トークンから読んだ `generation` と `bucketIndex` は**そのまま `idFromName("dir:g{generation}:b{index}")` の材料になる**。トークンのハッシュ照合は bucket の中で行われるので、**照合に失敗する前に DO インスタンスが起きる**。設計は範囲検査を一言も要求していないため、攻撃者が `dir:g0:b999999999` / `dir:g<任意>:b<任意>` を張った URL を大量に叩けば、bucket 数と無関係に新しい DO オブジェクトが無制限に生成される。これは第6.2節が案 (c)（credential 1件 = DO 1個）を棄却した理由 (iv) そのもの — 「任意の未認証文字列が新しい DO 名を引く」「総当たりが毎回コールドな DO インスタンス化を誘発する」— の再現であり、(b) を採る根拠の半分が無効になる。第6.2節の (iv) 欄「未認証の総当たりでも新しいオブジェクトは増えない」は、この検査があって初めて真になる。加えて生成された DO は `hasStoredData` の有無にかかわらず PITR の durable log を残しうる（第2.1節 #20、第6.2節が signup について自ら挙げた論点）。
  - 提案: 第6.1節 (d) または第5.5節 3 に、**「トークンから読んだ `generation` は keyring に存在する世代（active / previous）のいずれかであること、`bucketIndex` はその世代の `bucketCount` に対して `0 ≤ index < bucketCount` であることを、locator を導出する前に request Worker の transport 境界で検証する。いずれかを外れたトークンは DO を一切叩かずに拒否する」**を断定として足す。`bucketCount` は既に keyring のエントリが持っている（第5.2.3節）ので追加の材料は不要である。あわせて第6.2節 (iv) の記述に「この検査が前提」と注記する。

### Warnings

- **[W-001]** 鍵ローテーション中、移送済みユーザーの login が到達性検査で fail closed に落ちる窓が塞がれていない
  - 場所: `.thread/34/design.md:750`（手順2: 新世代 bucket へ移送し旧行を削除）/ `:754`（手順3: `credential_locators` を更新）/ `:470`（login step 5 (ii) 到達性検査）
  - 理由: 手順2が完了した時点で active 世代の lookup は新 locator にヒットするので、login の step 3 が返す `usedLocator` は新世代になる。しかし手順3（`credential_locators` の更新）は別 DO への RPC で、その間 User Data DO 側には旧世代の locator しか無い。step 5 (ii) は「`usedLocator` が `credential_locators` に active な行として存在すること」を要求するので、**この窓に入った login はすべて拒否される**。ローテーションは全 bucket を走査する保守作業なので、窓は理論上全ユーザーに順次開く。第6.1節 (d) は同じローテーション中の「発行済みリセットトークンが無効になる」影響を明示的に受容しているのに、**login が落ちる影響には言及が無い**。第6.4節が「fail closed が利用者のアカウントを閉じる方向へ働く経路は1つだけ（予約 TTL 掃除と saga 再開の競合）」と断定している点とも食い違う。
  - 提案: 手順2〜3 を「新 locator を `credential_locators` に**追加**（旧行は残す）→ 新 bucket に active 行を書く → 旧 bucket の行を消す → 旧 locator を `credential_locators` から消す」の順に組み替え、`credential_locators` が移送中は**両世代の行を同時に持つ**ことを許す。到達性検査は「いずれかの世代の行に一致すればよい」に緩める（一意性の権威は Directory 側なので、User Data 側が2行持っても認可は緩まない）。第6.9節「どの中間状態でも fail closed に倒れる」に加えて「**利用者を締め出す方向の fail closed は列挙して塞ぐ**」という第2の規則を第6.9節に明記し、第6.4節の「1つだけ」を実数に直す。

- **[W-002]** epoch を進める操作の一覧が節ごとに食い違っている（SSO link が抜けている）
  - 場所: `.thread/34/design.md:381` と `:667`（「パスワード変更・リセット・SSO の**解除**・退会」）vs `:710`（link 手順4「`sessionEpoch` を1つ進める」）
  - 理由: 第5.1節と第6.5節は epoch を進める操作を4つに列挙し、そこに SSO **link** は入っていない。一方で第6.6節の link 手順4 は epoch を1つ進める。#37 はどちらを実装すべきか決められない。さらに link で epoch を進めると、**設定画面から SSO を連携した利用者がその場でログアウトされる**という UX 上の帰結が生じる。unlink と違って link は認証手段を減らさないので、失効の必然性が無い。
  - 提案: どちらかに倒して両節を揃える。link で進めない場合は第6.6節 手順4 から epoch 前進を削り、進める場合は第5.1節・第6.5節の列挙に link を足したうえで「連携直後に再ログインを求める」ことを第11.1節経由で #35（画面仕様）へ引き継ぐ。

- **[W-003]** `failedAttempts` / `nextAttemptAllowedAt` の更新経路が login の手順に存在しない
  - 場所: `.thread/34/design.md:605`（第6.2.2節 (a)）/ `:462-475`（第5.3節 login の6手順）/ `:475`（「追加の往復は発生しない」）
  - 理由: 第6.2.2節 (a) は「login の照合失敗ごとに `failedAttempts` を進めて指数的に `nextAttemptAllowedAt` を先送りする」「成功時に `failedAttempts` をリセットする」と決めているが、**照合そのものは request Worker で行われる**（第4.8節）ので Directory bucket は結果を知らない。第5.3節の6手順には結果を bucket へ書き戻す step が無く、`credential_mappings` は step 3 の読み取りでしか触られない。実装するには login ごとに Directory への往復がもう1本増える（成功時も失敗時も）。第5.3節末尾の「追加の往復は発生しない」は step 5 (i)(ii)(iii) についての記述だが、節全体を読むと login のコストが2 RPC で閉じるように読める。
    加えて、**mapping 行が存在しない canonical には行が無いので試行回数を数えられない** — 第5.3節 step 3 と第7.6節がわざわざ処理経路を揃えて列挙オラクルを潰しているのに、スロットリングの有無だけは登録済み/未登録で差が出る（未登録は無制限に試せる）。
  - 提案: 第5.3節の手順に「step 4 の結果を Directory bucket へ報告する step 7（成功: `failedAttempts` リセット、失敗: 前進）」を明記し、往復数の記述を訂正する。未登録 canonical のスロットリングは行を持てないので、第6.2.2節 (c) の WAF / Rate Limiting Rules 側の責務であることを (a) の但し書きとして書く（そこは既に #38 へ送られているので、境界の宣言だけで足りる）。

- **[W-004]** OAuth 2.1 認可コード / PKCE 検証子を User Data DO に置く根拠が token エンドポイントに当てはまらない
  - 場所: `.thread/34/design.md:513`（第5.4.1節「認可フローは既にログイン済みのユーザーが同意する経路なので `userId` が確定している」）
  - 理由: `userId` が確定しているのは `/authorize`（同意画面）までである。**token エンドポイント（`code` + `code_verifier` を POST する交換）はクライアント資格情報だけを持つ未認証リクエスト**で、セッションを持たない。認可コードから `userId` を引く手段が無ければどの User Data DO を叩けばよいか決まらないため、置き場所の結論が現状の根拠では成立しない。これは第6章が Directory を必要とした理由（`userId` 未確定の経路からの解決）とまったく同じ構造の問題であり、「User Data DO に置く」で終わらせると #12 が Directory 側に別の解決表を足す方向へ流れる余地を残す。
  - 提案: 結論は維持できるが根拠を差し替える。第5.4節が AI クライアントトークンについて採った手法（`userId` を署名済みで自己完結させる）をそのまま認可コードに適用し、**「認可コードは `{ typ: "authzCode", userId, ... }` を署名した自己完結値とし、token エンドポイントは署名検証で得た `userId` から User Data DO を選ぶ。コード本体の一回性・PKCE 検証子の照合は DO 内で行う」**と書けば、routing の根拠が第5.4節と対称になり Directory を増やさずに済む。署名鍵は `AI_CLIENT_TOKEN_SECRET` とは別に立てるかどうかも1行で決めておくとよい（第3.2節の配布境界表に載る）。

- **[W-005]** 第4.3節の締めの件数が合わない（36件 → 実測34件）。行数も表記と実体がずれている
  - 場所: `.thread/34/design.md:306`（「台帳85件のうち表に現れない36件は、いずれも `userId` を第一引数に取る」）
  - 理由: `spec/inventory/adapter.md` の `ADP-*` は**ユニーク85件で正しい**（`grep -o 'ADP-[A-Za-z0-9-]*' | sort -u | wc -l` = 85。重複出現もゼロ）。しかし第4.3節の表が引用している distinct な `ADP-*` は**51件**なので、表に現れないのは 85 − 51 = **34件**である（51 + 36 = 87 で台帳総数を超える）。なお34件はすべて実際に `userId` 第一引数であることを個別確認したので、**主張の中身は正しく、数だけが誤っている**。あわせて表は「1〜30」と番号が振られているが 7b / 7c / 20b を含む**実行数33行**である（plan.md の AC-22 は件数を主判定にしていないので受け入れ条件の可否には影響しない）。
  - 提案: `36` を `34` に直す。行数に言及するなら「30行（枝番を含めて33行）」と書く。#35 は `spec/inventory/adapter.md` の改訂チェックリストとしてこの節を使うので、数の食い違いは追跡漏れの原因になる。

- **[W-006]** 第2.1節 #1 の「Free 列には per-object の値を明示していない」は事実に反する。公式は Free の per-object 上限を 1 GB と明記している
  - 場所: `.thread/34/design.md:65`（#1 の行）/ `:94`（「矛盾は解消した」の段落）
  - 理由: 公式ドキュメントを実取得して確認した結果、`/durable-objects/platform/limits/` は次のように書いている — 「When a SQLite-backed Durable Object reaches its maximum storage limit (**10 GB on Workers Paid, or 1 GB on the Free plan**), write operations ... will fail with ... `SQLITE_FULL`」。したがって「Free 列には per-object の値を明示していない／Free の 5 GB は account 側の値なので per-object は事実上意味を持たない」という第2.1節の解消理由は、**存在しない記載の不在**に立脚している。結論（本番 Paid で 10 GB を前提にする）は変わらないが、第2.1節は「本節が設計の依拠する事実の正本である」と自称しており、#37 / #38 がここを一次情報として読む。ローカル/Free 検証時の挙動を誤らせる。
  - 提案: #1 の事実欄を「10 GB（Workers Paid）/ 1 GB（Free）。アカウント合計は Paid 無制限 / Free 5 GB」に直し、`:94` の段落を「Free では per-object 1 GB と account 5 GB の**両方**が効く。本設計は Paid 前提なので 10 GB で見る」に書き換える。

- **[W-007]** 第4.3節の行27 が `readAll` について結論を書きながら `ADP-export-001` を行として持っていない
  - 場所: `.thread/34/design.md:297`（行27: `ArchiveWriter.write(archive)` / `ADP-export-002` / 「**User Data DO に閉じる**（読み出しのスナップショットまで）」）
  - 理由: 括弧内の「読み出しのスナップショットまで」は `ExportSourceReader.readAll(userId)`（`ADP-export-001`）についての結論だが、行として立っておらず ID も引かれていない。`readAll` は `userId` 第一引数なので述語 (a) には literal には掛からないが、**行7b / 行7c / 行28 を「同じ集約・同じ問いの対象だから対称性のために足した」という同じ理由が等しく当てはまる** — 第4.8節と第8.3節 (a) が「読み出しは DO 内、render と zip は request Worker」と実行位置を分割した以上、分割された両側が台帳に現れるべきである。同様に `ADP-knowledge-027`（`deleteSourceLinksByMemo`）は台帳の契約が documents 側 JOIN によるスコープを規則として持っており、第4.4節が「JOIN によるスコープ自体が不要になる」と書いた対象なのに行が無い（テーブル側の `ADP-source-links-001` は行25 にある）。
  - 提案: 行27 を `ADP-export-001` / `ADP-export-002` の2行に割り、`ADP-knowledge-027` を第4.4節の帰結として行25 の近傍に足す。どちらも行き先は「User Data DO に閉じる」なので結論は動かない。

### Notes

- **[N-001]** **引用している実装の事実は今回すべて一致した。** 1ラウンド目で多数の誤記が出た箇所なので重点的に照合したが、実ファイル突き合わせで誤りは出なかった。確認したもの: `spec/inventory/adapter.md` の `ADP-*` がユニーク85件（重複出現ゼロ）であること、第4.3節が引用する51件の `ADP-*` が**全件実在し、引用しているシグネチャが台帳・`spec/domains/*.md` の記述と逐語一致**すること、`application/di/types.ts` の `RequestContainer`（:53）/ `WorkerContainer`（:70）が2つだけであること、`application/workers/` が `eventRelayWorker.ts`（301行）/ `outboxPrune.ts`（25行）の2本であること、`apps/web/app/worker/cloudflare/handlers.ts` が138行で `handleQueue`（:82）/ `handleDlq`（:120）を持つこと、`0000_initial.sql` のテーブルが `_occ_guard` / `outbox_events` / `processed_events` / `users` の4つで `users_sso_identity_uq` が部分ユニークであること、`userRepository.ts` が4メソッドで `findBySsoIdentity` が実装に1件も無いこと、`valueObject.ts` の `AiClientConnectionId`（:125）/ `ClientName`（:142）と `AiClientConnection` 型の不在、`hmacSessionCodec.ts` の 7日 TTL と `{ uid, exp }` ペイロード、`adapters/d1/unitOfWork.ts:39` の "Read-your-write ... unsupported by design" JSDoc、`repositories/helpers.ts:55-69` の `isOccGuardViolation` と `schema.ts:118` の `OCC_GUARD_CHECK_NAME = "occ_guard_positive"`、`apps/web/wrangler.toml` が162行で DO バインディングゼロ、`.gitignore:16,17`、`password-reset.tsx` がプレースホルダー、`spec/pages/index.md` が P-01〜P-14 で管理者画面なし。**唯一の数値誤りが W-005 の「36件」だけ**である。

- **[N-002]** **Cloudflare プラットフォーム事実（第2.1節）の裏取り結果 — W-006 の1件を除き全件が公式記載と一致した。** 12ページを実取得して逐語照合した。とくに設計の骨格を支える次の項目はすべて正しい。#2（Alarm は同時1本 / `setAlarm` は上書き / at-least-once / throw 時は初回2秒の指数バックオフで最大6回）、#3（**wall time 15分は limits ページの "Wall time limits by invocation type" にあり、alarms ページには wall time の記述が一語も無い** — 出典の指定まで正確）、#4（30秒 active CPU、設定で最大5分、着信 HTTP リクエスト / WebSocket メッセージでリセット、30秒超過でエビクション確率上昇）、#4b（**公式が列挙しているのは HTTP リクエストと WebSocket メッセージの2つだけで、Alarm / RPC は肯定も否定もされていない** — 「未確認」ラベルと保守的な読みは正しい）、#6（`ctx.id.name` の4条件、2026-03-15 の境界日を含む）、#7（`transactionSync` は `async` 宣言も Promise 返却も不可）、#8（`BEGIN TRANSACTION` / `SAVEPOINT` 不可）、#9（カーソルは `await` を跨げるがスナップショット非保証）、#10（**FTS5 / JSON / 数学関数の3つだけが明記され、`bm25` / `snippet` / `highlight` / `trigram` はページに一語も無い。「仮想テーブルは原則禁止で FTS5 のみ例外」という記述も存在しない**）、#15〜#17、#18（input / output gate、`fetch()` の `await` で input gate が開く）、#19（1,000 req/s soft limit と `.overloaded` のリトライ禁止）、#20（PITR 30日 / object 単位 / SQL + KV 全体 / ローカル不可 / `ctx.abort()` もローカル不可）、#21（`exports` と `[[migrations]]` の排他、常に SQLite backend、storage 種別は不変、Trash 無し）、#22（`waitUntil` は DO で無効）、#23（`blockConcurrencyWhile` の30秒タイムアウトと DO リセット）、#24、#25（2026-06-12 changelog）、#26（**結果セット合計サイズの上限は limits ページに実在しない** — 「未確認」は正しい）、#27（`transaction()` の callback は async 可だが、SQLite-backed では `txn` は obsolete で「明示的トランザクションはもはや不要。`await` を挟まない書き込み列は自動的に原子的」）。**「公式記載 / 実測 / 未確認」の3値ラベリングは誠実で、記載の不在からの推論であることを明示している #4b / #5 の書き方は特に良い。**

- **[N-003]** **Account Home DO を採らない（2クラス構成）という結論は技術的に成立している。** 独立クラスが持つはずだった権威（アカウント状態・単調増加 epoch・saga の phase）が例外なく `userId` で引けることは、第4.1.1節のテーブル一覧で実際に確認できる。先行案が Account Home を必要とした2つの失敗モード（signup の部分失敗と、解除済みクレデンシャルでの login）は、それぞれ第6.4節の3段ガードと第5.3節 step 5 (ii) の到達性検査で塞がれており、代替が具体的である。とくに **#19 のレビュー指摘 B-IDDS6-001 の3つの穴のうち1つが「Account Home の廃止で構造的に消える」**（reverse locator が1系統になり Directory bucket 走査が唯一の権威になる）という論法は、単なるコスト比較ではなく設計上の利点として成立している。

- **[N-004]** **退会の順序（tombstone → mapping 削除 → `credential_locators` 削除）とその理由付けが正しい。** 「`credential_locators` は世代 + bucket index + 全長 HMAC を持つ唯一の逆引き情報であり、HMAC は一方向なので User Data DO 側から再計算できず、canonical 原本は削除対象の行の中にしかない」という分析から、逆順にした場合の2つの恒久障害（退会後もメール原本が暗号文で無期限残存 / そのメールで再登録不能の永久ロック）を導いており、順序の必然性が示せている。「削除は `credential_locators` に記録された全世代分を対象にし、無ければ成功の冪等操作にする」（ローテーション中の両世代残存への対応）まで踏み込んでいる点も良い。

- **[N-005]** **失敗モードの読みが2箇所で特に鋭い。** (i) 第6.4節の「予約 TTL 掃除が saga 再開より先に走ると、ログイン手段を持たない `active` アカウントが生まれる」— fail closed が利用者を締め出す方向に働く経路を自分で見つけて3段（TTL の下限不等式・`sagaCommitted` 印・終端規則）で塞いでいる。(ii) 第7.4節の「`finally` に Alarm の再武装を置くと、支配的な失敗モード（CPU 予算超過 → **エラーではなくエビクションとリセット**）では `finally` が走らないので、dormant な User Data DO の `purge-trash` が恒久停止しゴミ箱の保持期限が無期限に伸びる」— 第2.1節 #2（throw に対するリトライ）と #4（超過はエラーとして観測されない）の差を正しく使い分けないと書けない指摘で、ハンドラ先頭での再武装という対処も適切である。同じ理解が第9.2節（`blockConcurrencyWhile` を使わず同期ゲート関数 + input gate で排他）と第9.3節（部分適用の記録を「任意の最適化」ではなく必須と位置づける）まで一貫している。

## 受け入れ基準の判定（担当観点分）

| AC | 判定 | 根拠 |
|---|---|---|
| AC-4 | **条件付き充足** | 第4章 / 第5章 / 第6章がそろい、構成案の全節に本文がある。ただし B-001〜B-004 が第5章・第6章の結論の一部を無効化している |
| AC-11 | **充足** | 第4.1節に Issue 列挙7項目が7行として現れ、既存ドメイン集約との対応が付いている。第4.1.1節が認証系テーブルの落ちを自分で補って全数の正本を立てているのは AC の要求以上 |
| AC-12 | **条件付き充足** | 第5.1節に session/token → `userId` → locator の一本道があり、第5.5節が5点の構造的保証を置いている。ただし B-004 により保証3が破れ、B-001 により「誰がその DO を呼んでよいか」の裏面が未定義 |
| AC-13 | **条件付き充足** | 解決責務 (a)〜(d)・分割方式・部分失敗・冪等性・SSO link/unlink のすべてに節がある。単一グローバル DO は判断軸 (iv) を根拠に明示的に棄却済み。ただし部分失敗の網羅性に B-002 / B-003 の穴 |
| AC-15 | **充足** | 第6.9節が分散トランザクション不採用を宣言し、再開可能 saga + 冪等補償・input gate 再入への3制約まで書いている |
| AC-22 | **条件付き充足** | 台帳85件を実際に走査した形跡が本物であることを確認した（引用51件が全件実在・記述一致、非引用34件が全件 `userId` 第一引数）。述語の定義も表より先に置かれている。残るのは W-005 の件数誤りと W-007 の2件の対称性漏れ |
| AC-23 | **充足** | (a) canonical 化（構造チェックの前置、punycode 前後の長さ再検査、`U+0000` 区切りの確定まで）、(b) 鍵に依存しない `userId` 由来 locator と世代付き credential 由来 locator の2系統分離、(c) `encryptedCanonical` の保持場所・AES-256-GCM・AAD 束縛・復号許可経路3つ、(d) 2段構造の衝突処理 — いずれも断定形。とくに (b) の「ローテーション対象は credential 由来 locator に限られ、User Data DO の同一性に波及しない」が明示されている |

**断定形 / #37 の着手可能性について。** 「今後検討」「TBD」が結論位置に残っている節は無く、未決事項は第11.4節の4件だけで、いずれも決める主体（#37 / #38）と時期（着手時の spike）と「設計への影響: 無い」が割り当てられている。Account Home は第11.4節に現れず第3.1節で断定されている（AC-21 充足）。**したがって「決めていない」ことによる着手不能は無く、本レビューの Blocker はいずれも「決めてあるが内容が誤っている / 網羅していない」種類である。**
