# レビュー 003 — セキュリティ観点

- 対象: PR #43 / Issue #34（設計フェーズ）
- 主成果物: `.thread/34/design.md`（1,711行）
- 実施日: 2026-07-30
- 方針: 前回2ラウンドの指摘を前提にせず、ゼロベースで全文を読み、引用されている実装事実はすべて実ファイルで照合した。

## セキュリティ

### Blockers

- **[B-001]** unlink の「最後のログイン手段」検査（`credential_locators` の**行数**が1か）が、この設計自身の2つの決定によって既に誤りになっている。単一クレデンシャルの利用者が自分を恒久的に締め出せる。
  - 場所: `.thread/34/design.md:872`（unlink 手順1）。前提となる決定は `:734`（SSO signup は SSO bucket とメール bucket の**2つ**に行を置く）と `:917`（ローテーション中は同じ credential について `credential_locators` に新旧2世代の行が並存する）
  - 理由: 検査は「行数 = ログイン手段の数」を仮定しているが、その仮定はどちらの決定でも崩れる。
    - **(a) SSO 専用ユーザー。** `:734` により SSO signup はメール canonical にも mapping を置き、`:745`（phase 4）がその reverse locator も `credential_locators` に記録する。したがって SSO 専用ユーザーの行数は常に **2** である。ところがメール行は一意性の予約であって**ログイン手段ではない** — `passwordVerifier` を持たないので `:537`（step 4）の照合が成立しない。SSO を unlink すると行数 2 → 検査を通過 → ログイン手段が 0 になる。これはローテーションと無関係に常時成立する。
    - **(b) ローテーション中。** `:917` により単一クレデンシャルの利用者でも移送中は行数が 2 になり、`:872` の「行数が1ならば拒否」が発火しない。
    - **(c) `credential_locators` は `kind` / `hmac` / `generation` / `bucketIndex` / `credentialVersion` / `status` しか持たない（`:239`）ので、User Data DO 側だけでは「その行がログイン可能な手段か」を判定できない。** つまり検査を正しく直すには列か RPC の追加が要り、#37 に判断を丸投げできない。
    - `:872` は「この検査を最初に置くのは、ここが唯一のアカウント到達性の権威だからである」と断定しており、この検査が破れると `:948`「どの中間状態でも認証・認可は fail closed 側に倒れる」も `:949` の「締め出す経路は列挙して塞ぐ」も同時に失効する。`:951` の締め出し経路一覧にもこの経路は載っていない。
  - 提案: 検査述語を「行数」から「**ログイン可能なクレデンシャルの distinct な `(kind, hmac)` の数**」へ変える。具体的には (1) 世代違いを畳むため `(kind, hmac)` の distinct 数で数える、(2) `credential_locators` に「ログイン手段として成立するか」を表す列（例: `usableForLogin`、SSO signup で作られるメール予約行は false）を足し、`:239` の第4.1.1節（列の全数の正本）と第6.3節 phase 4 を同時に更新する。あわせて `:951` の締め出し経路一覧に本経路の行を足す。

- **[B-002]** unlink の削除が「2世代・2 bucket」を覆っていないため、鍵ローテーション中は**解除済みクレデンシャルでログインできる**。第6.6節が塞いだと主張している穴そのものが開く。
  - 場所: `.thread/34/design.md:873-874`（unlink 手順2「`credential_locators` から対象行を削除」／手順3「Directory bucket の mapping 行を削除する」）
  - 理由: `:917` によりローテーション中は `credential_locators` に同じ credential の行が**2行**、Directory 側にも**旧世代 bucket と新世代 bucket の2箇所**に行が存在しうる。手順2 が1行だけ、手順3 が1 bucket だけを消すと、
    - `credential_locators` に残ったもう一方の行が `:540`（step 5 (ii)、**世代を照合条件に含めない**）の到達性検査を通してしまう。残存 mapping 行は `passwordVerifier` を保持したままなので（`:634`）、login step 1〜6 が全部通り、**解除したクレデンシャルで新しいセッションが発行される**。
    - `:876-878` は「これは片方向にしか壊れない／到達性検査が fail closed で拒否する」と明言しているが、その保証は「`credential_locators` から当該 credential の行がすべて消えている」ことに依存しており、2世代並存下では成立しない。
    - 同じ問題を第6.7節（退会）は正しく扱っている（`:890`「削除対象は `credential_locators` に記録された**全世代分**」「両世代の bucket に対して削除を発行し、無ければ成功の冪等操作」）。**退会だけが対応済みで unlink が未対応**という非対称は、著者が問題を認識していたことの裏返しであり、単なる書き落としである。
  - 提案: unlink 手順2 を「対象 `(kind, hmac)` の**全世代の行**を削除」、手順3 を「`credential_locators` から得た**全世代の bucket** に対して `delete-mapping` を発行し、無ければ成功の冪等操作」に直す（第6.7節 手順3 と同じ文言に揃える）。`:882` の `sweep-orphan-mapping` が `operations.targetLocator` に退避する locator も、単一 locator ではなく全世代分の配列にする必要がある（`:245` の `operations.targetLocator` の定義も同時に更新）。

- **[B-003]** RPC クラス (3) の「ガードは呼び出し元が DO であることに一切依存していない」という断定が、クラス (3) の9エントリ中3つで成立していない。とくに `read-own-canonical` は**呼び出し側が渡した `userId` だけを条件にメール平文を復号して返す**。
  - 場所: `.thread/34/design.md:440`（クラス (3) の一括正当化）／該当エントリは `:434`（`check-previous-generation`）・`:435`（`read-own-canonical`）・`:436`（`delete-mapping`）。矛盾する要求は `:704`（第6.2.1節 (c) 4 のガード (i)）
  - 理由:
    - `:440` は「(3) のガードは …守っているのは `operationId` / `payloadDigest` の CAS と phase 条件であり、存在しない saga を前進させることも、記録されていない `operationId` で phase を飛ばすこともできない」と断定する。ところが上記3エントリのガード欄には **CAS も phase 条件も1つも書かれていない**。`read-own-canonical` は「`credential_mappings.userId` が**呼び出し元 DO の `userId`** と一致する行に限る」、`delete-mapping` は「mapping 行の `userId` 一致」、`check-previous-generation` は「読み取り専用」だけである。
    - **DO 間 RPC には呼び出し元の認証済み識別子が存在しない。** 「呼び出し元 DO の `userId`」は引数として渡されるほかなく、bucket 側にそれを検証する材料が無い。したがって `:704` (i) の「呼び出し元は epoch ガードを通った User Data DO に限る（request Worker からは直接呼ばせない）」は**実装不能な要求**であり、同時に `:440` の「request Worker からも binding 上は呼べる。それでよい」と正面から矛盾する。同じ文書が同じエントリについて逆の結論を書いている。
    - 帰結: `read-own-canonical` は「`userId` を1つ渡せば、その利用者のメールアドレス平文が1件返る」**復号オラクル**になる。設計自身が `:761` で「攻撃者が被害者の `userId`（リビジョンの `Actor` や export ヘッダから知りうる）」と書いているとおり `userId` は秘密ではない。`delete-mapping` は同様に「`userId` を渡すだけでその利用者の mapping 行を消す」**ロックアウト原始関数**になる（消えれば B-001/B-002 と同じく永久ロック）。
    - 到達には request Worker 内でのコード実行が要るので即時のリモート悪用ではないが、`:464` が `encryptedCanonical` の復号結果を最重要の非露出対象に挙げ、`:686` が「全ユーザーのメールアドレス原本という本システムで最も価値の高い PII」と位置づけている以上、多層防御の要である。しかも AC-23 (c)「canonical credential の保持と保護」の中身がこのガードである。
  - 提案: (1) `:440` の一括正当化を「CAS と phase 条件を持つエントリ」に限定し、**持たないエントリを表で明示する**。(2) `read-own-canonical` / `delete-mapping` に呼び出し元を束縛する材料を与える — 例えば User Data DO が初期化時に自分専用の `callerToken`（bucket 側 mapping 行に保存する不透明値）を持ち、RPC でそれを提示させる（`credential_locators` / `credential_mappings` に既に相互参照があるので追加の集中点を作らない）。(3) それを採らないなら `:704` (i) を削り、「これらのエントリは binding 到達性のみで守られる」と正直に書き直したうえで、`:464` の非露出方針との整合（＝多層防御が1層しかないこと）をリスクとして明記する。

- **[B-004]** 「epoch ガードを通らない RPC エントリの全数」を宣言している第5.1節の表に、本文が自ら導入している RPC エントリが**2つ**載っていない。
  - 場所: `.thread/34/design.md:413-438`（全数表。`:413` に「クラス (2)(3) を全数で列挙する。これが #37 への断定である」）。欠落は `:903`（第6.7節「最後の砦」）と `:600-602`（第5.4.1節 OAuth token エンドポイント）
  - 理由:
    - `:903`「Directory bucket に『`userId` を指定して自 bucket 内の**全 mapping 行を削除する**』冪等 RPC を持たせ」— 表に行が無く、したがってガードも定義されていない。任意の `userId` を受けて破壊的に一括削除する operator RPC で、`:438` の rotation 起動と違い「世代の CAS」に相当する保護も書かれていない。B-003 と合わせると、クラス (3) で最も危険なエントリが表から漏れている。
    - `:600-602` の token エンドポイントは「クライアント資格情報だけを持つ**未認証リクエスト**」と自ら定義したうえで、「コード本体の一回性と PKCE の照合は DO の内側で行う」「`jti` を User Data DO 内の短命テーブルへ記録して二度目の交換を拒否する」としている。これは User Data DO に対するクラス (2) の RPC エントリだが、表に行が無い。ガード欄が空なので `account.status` 照合の要否も未定義のまま #12 / #37 へ流れる。
    - 表の目的は `:413` が明言するとおり「どのエントリが認証を要求しどれが要求しないかの一覧が設計側に存在しない状態」を避けることなので、漏れがある時点で表の効用が失われる。
  - 提案: 2行を表に追加する。`:903` は「(3) operator 専用 / ガード: maintenance 経路の到達制御 + `userId` の存在確認 + 実行ログの監査必須（#38）」、token エンドポイントは「(2) 未認証 bootstrap / ガード: 署名 + `typ: authzCode` 厳密一致 + `jti` の一回性 CAS + PKCE 定数時間比較 + `account.status = 'active'`」を明記する。あわせて「本文が RPC エントリを導入したら本表にも行を足す」という更新規則を、`:776`（cross-DO 操作表）や `:949`（締め出し経路表）と同じ形で表に添える。

- **[B-005]** credential 変更 saga（パスワード変更 / リセット完了）の locator 解決規則が定義されていない。パスワード変更では**旧検証材料を取得する経路そのものが設計に存在しない**。
  - 場所: `.thread/34/design.md:827`（第6.5.1節 phase 0「対象 credential の locator を導出する」）／`:428`（`begin-credential-change` のガード欄「認可の判定は呼ぶ前に request Worker が済ませる — パスワード変更はセッション + 旧パスワード照合」）
  - 理由:
    - **(a) 旧パスワード照合の材料が取れない。** 照合は request Worker で行う（`:385`, `:634`）ので `passwordVerifier` が要るが、それを返す唯一のエントリは `lookup-credential`（`:422`）で、入力は canonical である。パスワード変更は認証済み操作なのでリクエストにメールアドレスは含まれず、canonical の原本は bucket 内で暗号化されている（`:682`）。`read-own-canonical`（`:435`）は復号結果を返すが「User Data DO（epoch ガードを通った後）」からしか呼べない建前で、しかも復号平文を request Worker へ運ぶことになり `:707` (ii)(iii) の「平文を持ち回らない」制約と衝突する。**どの経路を採っても既存の制約のどれかを破る**状態で #37 に渡っている。
    - **(b) ローテーション中の世代解決が未定義。** `:627-632`（第6.1節 (c)）は「読み経路は active → previous の2世代を引くが、素朴に組んだ書き経路は active 世代の locator しか導出しない」という問題を自ら特定し、**signup / SSO link についてだけ** `check-previous-generation` で塞いだ。credential 変更は同じ書き経路でありながら対象外になっている。結果、まだ移送されていない利用者のパスワードリセット完了は、行が存在しない active 世代 bucket を叩く。`:919` は「(2) の後にその credential へパスワード変更が完走していた場合…**旧パスワードが復活する**」という失敗モードを既に特定しているのに、その原因である「変更がどちらの世代へ書くか」を決めていない。
    - **(c) `consume-reset-token` のガードが (b) を裏づけていない。** `:645` は「世代が previous へ落ちた時点で、旧世代 bucket に残ったトークン行は対応する mapping を失うので**発行済みリセットトークンは無効になる**」と断定するが、`:429` のガードは「トークンハッシュの一致 + 未使用 + 未期限」だけで **mapping 行の存在を確認しない**。したがって旧世代 bucket のトークンは普通に消費でき、その後の phase 1 が空振りする。断定と guard が食い違っている。
  - 提案: (1) phase 0 に「locator は `credential_locators`（認証済み変更）またはトークン埋め込み世代（リセット完了）から解決し、canonical からは導出しない」を明記する。(2) パスワード変更については「旧パスワード照合用の verifier をどう得るか」を1つに決める — 最も既存制約と整合するのは、User Data DO 経由で bucket に**照合を委譲せず**、`credential_locators` が持つ locator で `lookup-credential` 相当を引く専用エントリ（引数は canonical ではなく `(kind, hmac, generation, bucketIndex)`）を第5.1節の表に足す形である。(3) `consume-reset-token` のガードに「同 bucket に対象 credential の mapping 行が存在すること」を足す。

- **[B-006]** `rotate-remap` を Directory bucket の Alarm ジョブと定義しているが、その実行に必要な routing key は「RPC 引数として一時注入し、SQLite にもインスタンスフィールドにも書かずに破棄する」と定めている。Alarm 起動時に鍵が存在しないので、両立しない。
  - 場所: `.thread/34/design.md:1076`（`kind: rotate-remap` の所有者 = Directory bucket）／`:504-505`（第5.2.3節 一時注入と非保持）／`:914`（第6.8節 手順2 は「maintenance 経路が bucket を `0..N-1` の順に走査する」）／`:1087,1089`（大きいジョブは Alarm を跨ぐカーソル分割が必須）
  - 理由: 3つの規則が同時に成立しない。(i) 再 HMAC は bucket の中で行う（平文を外へ出さないため）、(ii) routing key は呼び出しのスコープを出たら破棄する、(iii) 大きな仕事は Alarm を跨いでチェックポイント分割する。(iii) を採ると鍵が次の Alarm に無く、(ii) を守ろうとすると1回の RPC 内で bucket 全件を処理することになり `:1085`（CPU 予算超過は「途中まで進んで黙って落ちる」）に真正面から当たる。#37 が実装で辻褄を合わせるとき、最も安易な解決は**鍵を bucket の SQLite かインスタンスフィールドに置く**ことであり、それは `:163` が固定した「配布は非重複である」という秘密の配布境界を壊す（`DIRECTORY_ROUTING_SECRET` が state Worker 側に永続化される）。しかも `:1091`（チェックポイントごとの `sync()`）を守れば鍵は write buffer からディスクへ流れる。
  - 提案: `rotate-remap` を「Alarm ジョブ」ではなく「**maintenance 経路が1チャンクずつ駆動する同期 RPC**」として定義し直す（鍵は毎チャンクの引数として注入され、チャンク境界で必ず破棄される）。進捗は既に `rotation_checkpoints`（`:251`）と mapping 行の世代が持っているので、Alarm による自走は不要である。`:1063` の `kind` 表と `:914` の手順2 の記述をこの結論に揃え、`:1076` を削るか「operator 駆動チャンク」と注記する。`rotate-encryption` は `IDENTITY_MAIL_ENCRYPTION_KEY` が state Worker の常設バインディングなので影響を受けない（この非対称を明記すると誤読が減る）。

- **[B-007]** 複数クレデンシャル signup の phase 3 が部分成功した状態で終端規則が発火すると、既に `active` へ昇格した mapping が誰にも回収されず、そのメールアドレス / SSO 主体が**恒久的に再登録不能**になる。
  - 場所: `.thread/34/design.md:804`（第6.4節 3 の終端規則）／`:744`（phase 3 は「コーディネーターが自分の行を昇格し、残りへは `activate-reservation` を発行する」＝逐次で部分成功しうる）／`:890`（`finalize-withdrawal` は `credential_locators` を読んで locator を得る）
  - 理由: `:804` は「印を書く前に落ち、かつ TTL 経過後に別の利用者へ canonical を取られた場合」に `resume-signup` が `account.status` を `deleting` へ倒し「退会と同じ経路（第6.7節）で回収する」と決めている。ところが phase 4（`credential_locators` への reverse locator 記録、`:745`）は phase 3 が全数成功した後にしか走らないので、**この時点で `credential_locators` は空**である。第6.7節 手順3 は `credential_locators` を唯一の逆引き情報として mapping を消す設計なので（`:893` が自らその依存を明言している）、回収対象を1件も見つけられない。結果、コーディネーター bucket に `active` な孤児 mapping が残る。
    - この孤児は `sweep-reservations` の対象外（`:895` が「`status: 'reserved'` の行しか対象にしない」と明記）、`sweep-orphan-mapping` の対象外（`operations.targetLocator` は link/unlink 用で signup には書かれない）、`finalize-withdrawal` の対象外（上記）である。
    - 帰結は `:855` が SSO link について「その SSO 主体の永久ロック」と呼んで Blocker 級に扱ったのとまったく同じ状態で、しかも `:804` は「黙って到達不能アカウントを残すだけは選ばない」と宣言している。`:951` の締め出し経路一覧にもこの経路は無い。
    - `:734` により **SSO signup は常に2 bucket を跨ぐ**ので、これは例外的な構成ではなく SSO 登録の標準経路である。
  - 提案: 終端規則（`:804`）に「`deleting` へ倒す前に、コーディネーター予約行の `locators[]`（`:741`）を使って**自分の `operationId` で `active` 化済みの mapping をすべて削除する**」を足す。`locators[]` は既にコーディネーター行が持っているので新しい情報は要らない。あるいは phase 3 の各昇格の直後に `record-credential-locator` を発行して（phase 4 を分割して）`credential_locators` を常に mapping の上位集合に保ち、`finalize-withdrawal` の前提を成立させる。どちらを採るにせよ `:778` の cross-DO 操作表と `:951` の締め出し経路表に行を足す。

### Warnings

- **[W-001]** PITR の復旧後手順が `sessionEpoch` しか対象にしておらず、**失効済み AI クライアント接続の復活**を塞いでいない。第10.1節の「どちらか一方の restore だけでアカウントが復活することは無い」は AI トークン経路には当てはまらない。
  - 場所: `.thread/34/design.md:1405-1410`（第10.1節）／`:558`（AI クライアントトークンは自己完結で、検証は request Worker が DB を触らずに行う）／`:570-571`（失効の権威は `ai_client_connections.status` と `account.status`、いずれも User Data DO 内）
  - 理由: 第10.1節の3点（Directory mapping が到達性のゲート／User Data の `account.status` が状態の権威／片方だけでは復活しない）は、**login が必ず Directory を経由する**ことに依存している。AI クライアントトークンは Directory を1度も参照しないので、この論証が丸ごと効かない。User Data DO を単独で PITR で戻せば `ai_client_connections.status` が `revoked` → `active` に戻り、`exp` までのあいだ失効させたはずのトークンが再び通る。`:1409-1410` は同じ問題を `sessionEpoch` については独立した穴として正しく特定し必須手順まで置いているのに、AI トークンには適用していない。
  - 提案: `:1410` の必須ステップを「`sessionEpoch` を強制前進させる」から「**`sessionEpoch` の強制前進 + restore 前に `revoked` だった `ai_client_connections` の再失効**」へ拡張する。restore 前の失効一覧は復旧時点では読めないので、実務上は「restore 直後に全接続を `revoked` にし、利用者に再接続させる」を既定手順にするのが安全側（`:582` が既にリセット完了画面に「すべて失効」導線を要求しているので UI は流用できる）。`:1407` の断定文にも「セッション / AI トークンについては別に手当てが要る」旨の但し書きを足す。

- **[W-002]** メール local 部の lowercase 化が、同節が NFKC を退けた論拠とそのまま衝突している。canonical が**唯一の保存形かつ配送先**である以上、可逆でない正規化はどれも同じ乗っ取り経路を作る。
  - 場所: `.thread/34/design.md:477`（「local 部の lowercase 化は残す」）／論拠の出所は `:475`（NFKC を local 部に掛けない理由）／`:480`（所有確認が無く、所有の唯一の証明はリセット経路であること）
  - 理由: `:475` は「SMTP の local 部はオクテット単位で不透明」「打鍵した実アドレスが復元不能になり、リセットリンクが別アドレスへ送られる」「signup に所有確認が無いのでそのまま乗っ取り経路になる」と論じて NFKC を退けている。この3つの論拠は **RFC 5321 上大文字小文字を区別しうる local 部の lowercase 化にもそのまま当てはまる**。`:477` の反論は「実運用のプロバイダは区別しない側に揃っている」という経験則だけで、`:475` が「配送側の同一性判定」を厳密に扱った基準とは非対称である。原本を canonical だけで持つ設計（`:682`）なので、打鍵形が失われる点も同じである。
  - 提案: (a) 現状を維持するなら、`:477` に「NFKC を退けた論拠は lowercase にも形式的には当てはまるが、プロバイダ実装の実態を根拠に受容する」という受容判断を明示し、残余リスク（local 部を区別するプロバイダでのリセットメール誤配送）を第11.3節経由で #38 へ送る。(b) より安全側に倒すなら `credential_mappings` に**打鍵形（暗号化）を canonical と別に保持**し、配送先には打鍵形を使う（一意性判定は canonical のまま）。(b) は暗号化列が1つ増えるだけで、退会時の削除範囲（`:709`）と復号許可経路（`:699`）はそのまま流用できる。

- **[W-003]** signup が `ConflictError("EMAIL_ALREADY_REGISTERED")` を返すことで登録済みメールアドレスの列挙オラクルになる点が、受容判断として一度も記録されていない。login / リセットには均一化のために相当な設計コストを払っているので、非対称が説明されていない。
  - 場所: `.thread/34/design.md:741`（phase 1a「既に active な mapping があれば敗北して `ConflictError("EMAIL_ALREADY_REGISTERED")` 等」）／対照は `:422,536-537`（login の応答均一化）・`:1141-1147`（リセット依頼の処理経路完全一致）・`:465`（未認証経路では `userId` すらログに出さない）
  - 理由: `:465` は「ログ閲覧権限を持つ内部者に対する列挙オラクル」まで潰しに行っているのに、**公開レスポンスで誰でも叩ける signup が同じ情報を直接返す**。実装済みの `registerWithPassword.ts` も同じ挙動なので新規の後退ではないが、DO 化で「未登録 canonical には行を作らない」（`:550`, `:725`）という判断まで列挙オラクル回避を根拠に下している以上、signup だけ無言なのは設計の一貫性を欠く。#35（画面仕様）が「登録済みです」という文言を出すかどうかの判断材料も無い。
  - 提案: 第5.3節または第6.3節に「signup の重複エラーは公開の列挙オラクルであることを承知のうえで受容する（UX 上の代替が乏しいため）」を1〜2行で明記し、緩和策（`:728` の WAF レート制限を signup にも当てる、が既に決まっている）と、#35 へ送る文言方針を書く。あるいは受容しないなら「重複時もメールを送って結果を UI で区別しない」方式へ倒す判断を書く。

- **[W-004]** リセットトークンに埋め込む `generation` と、`{random}` の導出鍵 `IDENTITY_RESET_TOKEN_KEY` の世代が、同一の記号で書かれている。2つは独立した番号体系なので、#37 が取り違えると鍵ローテーション後にトークン導出が壊れる。
  - 場所: `.thread/34/design.md:639`（`{random}` 部は `HMAC(IDENTITY_RESET_TOKEN_KEY[generation], tokenId)`）／`:635`（トークン形式 `{generation}.{bucketIndex}.{random}` の `generation` は **routing secret の世代**）／`:249`（`password_reset_tokens` 行が別に「導出鍵の世代」を持つ）／独立性の前例は `:689`（暗号化鍵の世代は routing 世代と「独立した番号体系」）
  - 理由: `:636` の範囲検査 (i) は `generation` を **routing keyring** に対して検証しているので、トークンに載る `generation` は routing 世代である。一方 `:249` は行が別に「導出鍵の世代」を持つと定めている。`:639` の `IDENTITY_RESET_TOKEN_KEY[generation]` はどちらの `generation` か読めず、routing 世代で reset-token keyring を引く実装になると、routing のローテーションだけでトークン導出鍵が切り替わる（あるいは存在しない世代を引く）。
  - 提案: `:639` の表記を `IDENTITY_RESET_TOKEN_KEY[tokenKeyGeneration]` のように別名にし、「トークン本体が運ぶのは routing 世代だけで、導出鍵の世代は `password_reset_tokens` 行だけが持つ（検証時はハッシュ照合なので導出鍵を必要としない）」を1行で明記する。

- **[W-005]** 「未登録 canonical でもジョブ行が増えない」という断定が、同一 canonical についてしか成立していない。異なる canonical を大量に投げる未認証書き込み経路は残る。
  - 場所: `.thread/34/design.md:1148`（「**未登録 canonical でも行が増えない**ので、未認証入力によるストレージ膨張の経路にならない」）／同旨 `:725`
  - 理由: `operationKey` を「対象 canonical の全長 HMAC + 依頼の窓」から導く（`:725`, `:1148`）ので収束するのは**同一 canonical への連打**だけである。攻撃者が毎回異なるアドレスを投げれば bucket の `jobs` に行が増え続ける。設計自身が `:670` で「異なる canonical を大量に投げる攻撃にはレート制限で対処する」と正しく書いているのに、`:1148` の断定はその限定を落としている。加えて `:640` (ii) が指摘するとおり DO の書き込みは PITR の durable log に30日残るので、prune しても記録は残る。
  - 提案: `:1148` を「**同一 canonical への連打は**行1本に収束する。異なる canonical を大量に投げる経路は第6.2.2節 (c) の WAF が第一防壁である」に直す。`:1083` の prune 対象に `send-mail` の空振り行を明示的に含め、保持期間を短く取ることを #38 の運用値へ送る。

- **[W-006]** SSO login の IdP アサーション検証点が設計に現れない。`lookup-credential` の応答均一化（ダミー検証材料）は `kind: 'sso'` の行に対して意味を持たないので、SSO 経路の未認証ガードが実質未定義のまま #37 へ渡る。
  - 場所: `.thread/34/design.md:554`（「SSO login は canonical が `provider + U+0000 + subject` になるだけで、2〜3 と 5〜6 は同じである」）／`:422`（`lookup-credential` のガード「無条件に応答し、中身を均一化する」）／`:536-537`（ダミー検証材料と `PasswordHasher.verify`）
  - 理由: `:554` は login 手順の 4（`PasswordHasher.verify`）を暗黙にスキップしているが、その代わりに何を検証するか（provider の ID トークン署名 / `aud` / `nonce` / `iss`、および subject をどの時点で信用するか）が書かれていない。`:536` の返り値 `{ userId, passwordVerifier, status, credentialVersion, usedLocator }` は SSO 行では `passwordVerifier` が null なので、均一化の対象にもならない。第2.3節（`:122`）が「SSO の読み解決は未実装」と正しく指摘しているだけに、Directory 側で新規に書く際の検証点が設計にないと #37 が独自に決めることになる。
  - 提案: 第5.3節に SSO login の手順を独立して3〜5行で書く。最低限「(1) IdP アサーションの検証は request Worker で完了させてから `lookup-credential` を呼ぶ、(2) canonical に使う subject は**検証済みアサーション由来の値だけ**、(3) step 5 の (i)(ii)(iii) はパスワード経路と同一」の3点を断定形にする。詳細な OIDC フローは #12 / #37 へ委譲してよい。

### Notes

- **[N-001]** 受け入れ基準 **AC-14 は充足**している。第5.2節（`:460-468`）に (a) 生値を DO ID / routing key に使わない、(b) 正規化値の HMAC-SHA-256 を使う、(c) canonical / HMAC / locator / `passwordVerifier` / `encryptedCanonical` / リセットトークンを URL・ログ・エラー・トレースへ出さない、の3点が断定形で揃っている。未認証経路で `userId` すらログに出さないとした `:465` は Issue の要求を超える良い判断で、`:468` の「DO 名は Metrics タブで絞り込めるので運用画面にも露出する」という補強も具体的である。鍵の所有者・世代管理（第5.2.3節）は AC-14 上は任意だが、第3.2節の Worker 分割の結論と整合している（B-006 の指摘は整合そのものではなく Alarm 実行モデルとの衝突である）。

- **[N-002]** 受け入れ基準 **AC-23 は (a)(b)(d) が充足、(c) は記述としては充足だが B-003 により保護の実体が欠ける**。(a) は第5.2.1節（`:470-483`）で正規化手順・`Email.create` を唯一の出所にすること・SSO subject の provider 別扱い・規則変更を鍵ローテーションと同格に扱うことまで断定済み。(b) は第5.2.2節（`:485-495`）で「ローテーション対象は credential 由来 locator に限られ User Data DO の同一性に波及しない」が明示されている。(d) は第5.2.5節（`:516-526`）の2段構造（bucket index は衝突する / 識別は全長 HMAC）が明快である。(c) は第6.2.1節に保持場所・AES-256-GCM・行ごとランダム96ビット nonce・AAD への `(kind, hmac, encryptionGeneration)` 束縛・鍵の世代管理と再暗号化・復号許可4経路まで書かれているが、その4経路のうち経路4のガードが実装不能である（B-003）。

- **[N-003]** 引用されている実装事実は**すべて実ファイルと一致**した。照合したのは次のとおり。
  - `packages/core/src/application/di/secrets.ts` — `MIN_SESSION_SECRET_LENGTH` の import、ブランド型 `SessionSecret` + `requireSessionSecret`、`RequestSecrets` の入れ子が rest-spread から秘密を守るという JSDoc（設計 `:165` の3点はすべて実在）。
  - `apps/web/app/presentation/currentUser.ts:17-26` / `:29-33`（"The authoritative guard" の JSDoc）、`apps/web/app/presentation/authState.ts:18-23`（`getCurrentUserId()` の結果だけで `{ authenticated }` を返す）— 設計 `:442` の指摘は正確。
  - `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts` — ペイロードは `{ uid, exp }` のみ、`parsePayload` は `uid` / `exp` の存在しか見ない（設計 `:450`, `:562` の根拠は正しい）。TTL 7日、`MIN_SESSION_SECRET_LENGTH = 32`。
  - `packages/core/src/application/ports/sessionCodec.ts` — `issue(userId, now)` / `verify(token, now)` に epoch を運ぶ口が無い（設計 `:450`）。
  - `packages/core/src/domain/identity/valueObject.ts` — `EMAIL_PATTERN` は `:43`、`Email.create` は `:45-` で正規化は `:47` の `raw.trim().toLowerCase()`、`EMAIL_MAX_LENGTH = 320`、`AiClientConnectionId` は `:125`、`ClientName` は `:142`。設計 `:477`, `:481`, `:124` の行番号引用はすべて一致。
  - `packages/core/src/domain/identity/ports/userRepository.ts` — メソッドは `insert` / `save` / `findById` / `findByEmail` の4本のみ。`findBySsoIdentity` は `packages/` / `apps/` に **0件**（設計 `:122` の断定は正しい）。
  - `packages/core/src/adapters/d1/migrations/0000_initial.sql:46-47` — `users_email_uq` / `users_sso_identity_uq`（部分ユニーク）が実在。
  - `packages/core/src/application/errors.ts` — `SystemErrorCode` は6値で `ServiceOverloaded` / `StorageCapacityExceeded` は不在、`RETRYABLE_SYSTEM_CODES` は `NetworkError` / `ExternalApiError` の2件（設計 `:373`）。
  - `apps/web/app/presentation/errorResponse.ts:70`（`serializeError`）/ `:101-113`（`HTTP_STATUS_BY_KIND` は `kind` だけを見て `code` を見ない）— 設計 `:371`, `:375`。
  - `spec/database/index.md:79`（生トークンを保存しない理由）/ `:77-101`（`password_reset_tokens` 定義と `prt_user_idx` の「既存トークン無効化」用途）— 設計 `:640`, `:642`。

- **[N-004]** 前ラウンドからの改善として質が高い点を記録する。いずれも「後から足せない種類の判断」である。
  - **login の TOCTOU を `credentialVersion` で塞ぐ設計**（`:840-845`）— step 3 と step 5 の窓で credential 変更が完走すると「旧パスワードで有効な新セッションが出る」という、epoch ガードでは原理的に検出できない穴を、credential 単位の単調カウンタで塞いでいる。アカウント単位にしない理由（SSO link で既存 credential が取り残される）まで書かれている。
  - **`typ` audience タグと鍵分離の二重化**（`:560-562`）— 現行 `parsePayload` が `uid` / `exp` しか見ないという実装事実から token confusion の可能性を導き、鍵分離だけに頼らず構造でも弾いている。
  - **AI クライアント scope をトークンではなく保存値との積で決める**（`:564`）— 失効（`status`）が権限**縮小**に効かないという見落としやすい非対称を先回りしている。
  - **リセットトークンを DB にもジョブ行にも置かず `tokenId` から導出する**（`:639-641`）— `jobs.payload` の制約が「PII を入れない」だけだと生トークンが載って PITR に30日残る、という経路の特定が的確。第7.4節の payload 制約を「PII **および再利用可能な秘密**」へ広げた対応も一貫している。
  - **`encryptedCanonical` の AAD に `(kind, hmac, encryptionGeneration)` を束縛**（`:696`）— DB 書き込み権限を得た攻撃者による暗号文の付け替え（＝リセットメールの宛先すり替え）という、AEAD を使うだけでは塞がらない経路を潰している。
  - **`report-login-result` を応答前に必ず完了させる**（`:544`）— 失敗側を非同期にすると接続を切るだけでカウンタを回避できる、という抑止機構の典型的な破れ方を明示的に塞いでいる。
  - **標的型ロックアウトを「天井・時間減衰・ロックアウト中は非加算」の3点で塞ぎ、脱出経路を2本残した**（`:716-722`）— 具体値を #38 に送りつつ「3点の存在自体は本節で固定する」と分けた粒度が適切。
  - **`alarm()` 先頭での再武装 + `ctx.storage.sync()`**（`:1095-1097`）— `finally` が走らない失敗モード（CPU 予算超過 → エビクション）を正しく特定し、`setAlarm` の戻り値が公式ドキュメント内で食い違うことまで根拠に積んでいる。dormant な DO の retention が無言で停止する、という帰結の描写も具体的。
  - **PITR が `sessionEpoch` を巻き戻す**という独立した穴の特定（`:1409-1410`）— 「復旧手順の必須ステップ」として、restore 前の値を知らずに済む形（現在時刻由来の単調値へ飛ばす）まで決めている。W-001 はこの良い分析を AI トークンへ広げる話である。

- **[N-005]** 本レビューは Blocker 7件のうち **B-001 / B-002 / B-007 が「fail closed が利用者を締め出す」系**、**B-003 / B-004 が「クラス (3) RPC の信頼境界」系**、**B-005 / B-006 が「鍵ローテーション中の書き経路」系**にまとまっている。3つの系はいずれも、この設計が新しく導入した2つの構造 —— (1) 同じ credential が2世代・2 bucket に並存しうること、(2) DO 間 RPC が新しい信頼境界になること —— の帰結である。修正時はこの2軸で全節を再走査すると漏れが減る。とくに `:917`（2世代並存を許す決定）と `:440`（クラス (3) の一括正当化）の2文を参照している節をすべて洗い直すことを勧める。
