# Domain / Use Case

PR #49（`origin/main...HEAD`、248ファイル）の**2周目**レビュー。1周目（`review-001-domain-usecase.md`、B-001〜002 / W-001〜008）の修正が正しく入ったかを検証し、修正が生んだ新しい問題を探した。

判定基準は `CLAUDE.md` / `spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/inventory/{domain,usecase}.md` / `spec/testcases/identity/` と `.thread/37/plan.md`（受け入れ基準・スコープ）、`.thread/37/adr.md`（ADR-001〜048 / 060〜064 / 070〜075 / 080〜086）、`.thread/37/review/triage.md`。

**1周目の10件は全件が実際に解消していた。** `User` を射影に倒す判断（ADR-070）、契約を `di/facades.ts` へ内側化する判断（ADR-071）、述語のドメイン一本化（ADR-072）、非空タプル（ADR-073）、`Email` のラベル構文検査（ADR-074）、`CredentialLocatorRef`（ADR-075）はいずれも指摘の趣旨どおりで、コードの JSDoc と ADR の理由付けも一致している。**Blocker は無い。** 以下は、その修正が spec / `.adr/` 側に**取り残した5点**である。いずれもコードの振る舞いではなく、#12 / #18 / #44 への引き継ぎ面の欠けである。

## Blockers

なし。

## Warnings

- **[W-001]** 「最後のログイン手段」のエラーコードが、実装（`LastLoginCredential`）と spec（`LastCredentialRemoval`）で食い違ったまま #12 へ渡る
  - 場所: `packages/core/src/domain/identity/errorCode.ts:8` / `spec/usecases/identity.md:581,595` / `spec/testcases/identity/unlinkSsoCredential.md:14` / `spec/inventory/test.md:241`
  - 理由: 本 PR は `IdentityErrorCode` に

    ```ts
    // No thrower yet, deliberately. The credential set is a projection, so the
    // "last way in" refusal belongs to `unlinkSsoCredential` (#12); what #37
    // supplies is the predicate (`User.loginCredentialCount`) and this code.
    LastLoginCredential: "IDENTITY_LAST_LOGIN_CREDENTIAL",
    ```

    を追加した。コメントが明言するとおり、これは **#37 が #12 のために置いた引き継ぎ資材**である。ところが spec 側は4箇所すべてが `BusinessRuleError(LastCredentialRemoval)` のままで、`LastCredentialRemoval` という識別子はリポジトリのどこにも存在しない（`grep` で spec 4件・コード0件）。

    問題なのは、**この4箇所のうち2箇所（`spec/usecases/identity.md`:581 と `unlinkSsoCredential.md`:14）を本 PR が同じコミットで編集している**ことである。ADR-070 の決定4は「`spec/usecases/identity.md`（unlinkSso 手順2-2/2-3・エラー表）/ `spec/testcases/identity/unlinkSsoCredential.md` を実装に合わせる」と書いており、検査の所在は書き換えたのにコード名だけが揃っていない。`throw` の実装者が #12 である以上、**名前が割れていることに気づく機会は #12 の実装時しかなく、そのときには spec とコードのどちらが正かを再判断する羽目になる。**
  - 提案: どちらかへ寄せる。`errorCode.ts` を `LastCredentialRemoval: "IDENTITY_LAST_CREDENTIAL_REMOVAL"` にするのが spec 4箇所を触らずに済む。コード名を残すなら spec 4箇所（`spec/usecases/identity.md` ×2 / `spec/testcases/identity/unlinkSsoCredential.md` / `spec/inventory/test.md`。`spec/manual-tests/account.md`:539,680 も同名を使っているので実質6箇所）を直す。**`packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts:37` が `"LAST_LOGIN_CREDENTIAL"` を直書きしている**ので、どちらへ倒すにせよそこも見ること。

- **[W-002]** ADR-070 が `.adr/008` の決定の一部を覆したのに、`.adr/008` への書き戻しが無い。本 PR は同じ状況で `.adr/003` には書き戻している
  - 場所: `.adr/008-identity-split-and-non-aggregate-stores.md:20-21` / 対比: `.adr/003-sqlite-fts5-only-search.md`（本 PR が「影響」欄に1行追記）
  - 理由: `.adr/008`（ステータス: 承認済み）の「決定」欄はいま**2箇所で、実装が持たない API を規定している**。

    > 代わりにクレデンシャル集合を操作する `addCredential` / `removeCredential` を置き、後者は最後のログイン手段の解除を拒否する。（:20）
    > 判定に必要な材料を型に載せることで、`removeCredential` が純関数のまま判定できる。（:21）

    ADR-070 はこの2文の後半を明示的に取り消している（「`User` から `addCredential` / `removeCredential` を落とす」「検査の所在は解除ユースケース」）。`.adr/` はリポジトリ横断の恒久 ADR 置き場で、`.thread/37/adr.md` は Issue 単位の作業 ADR である — **`.adr/008` だけを読んだ次の実装者は、取り消された決定を正本として読む。**

    本 PR 自身がこの書き戻しの作法を持っている: plan.md AC-9 が `.adr/003` の「影響」欄への書き戻しを受け入れ基準に挙げ、実際に `.adr/003` へ「#37 の着手時に再確認済み（2026-08-03）」の1行が入っている。**同じ扱いが `.adr/008` に無いのは、規約の適用漏れである。** とくに :21 は `usableForLogin` をクレデンシャル参照に持たせる理由を `removeCredential` の純粋性で正当化しているので、根拠のほうが先に消えている形になる。
  - 提案: `.adr/008` の「影響」欄に1行足す — 「`addCredential` / `removeCredential` は #37（`.thread/37/adr.md` ADR-070）で置かないことに改めた。`credentials` は `CredentialLocatorStore` の射影であり集約に書く遷移が無いため。`usableForLogin` を型に載せる判断は維持され、判定は `User.loginCredentialCount`（述語）＋ 解除ユースケース（#12）が持つ」。

- **[W-003]** 新設のドメイン述語モジュール `credentialMappingRules.ts` に spec のアンカーが無い。ADR-072 が「#12 / #18 が条件を足す先」と位置づけた場所が、`spec/inventory/domain.md` の129行のどこにも現れない
  - 場所: `packages/core/src/domain/identity/credentialMappingRules.ts`（新規4関数）/ `spec/inventory/domain.md`（DOM-identity-001 の1行だけが更新されている）/ `spec/domains/identity.md`
  - 理由: `isSettled` / `holdsPasswordVerifier` / `isUsableForLogin` / `isResetRequestAllowed` の4本は**ドメイン層に新しく置かれた公開要素**で、`identityDirectory/facade.ts` の2箇所と `jobs/handlers/sendMail.ts` が呼んでいる。ところが `grep -rn "credentialMappingRules\|isUsableForLogin\|holdsPasswordVerifier\|isResetRequestAllowed\|isSettled" spec/` は **0件**である。

    規則そのもの（「判定は『クレデンシャルの有無』ではなく『パスワードの検証材料の有無』」）は `spec/domains/identity.md`:645 に散文としてあるが、それは `requestPasswordReset` ユースケースの説明の中の一文で、**「どのモジュールがその判定を持つか」は書かれていない。** ADR-072 の Decision は「3箇所がこれを呼ぶ」「実値は #18 / #38 に委ねた境界を崩さないよう窓は引数」と決めており、**この決定に到達する経路が spec 側に1本も無い。** `spec/inventory/domain.md` は実装チェックリストの生成元（`spec-to-issues` / `implement-*` が読む）なので、#18 がレート制限を実装するとき「条件を足す先」を spec から発見できない。

    これは B-002 / W-007 の修正が作った新しい要素についての、spec 同期の抜けである（triage の「spec 同期1〜3」は引き継ぎ3件だけを対象にしていて、ADR-072 の新設モジュールは対象に入っていない）。
  - 提案: `spec/domains/identity.md` の `CredentialMappingRepository` / `PasswordResetTokenPort` の近くに「認証情報の可否判定（ドメインサービス）」の小節を1つ足し、4述語の契約（とくに**リセット可否をログインの backoff と別建てにする理由**。これは security 上の判断であり、実装の JSDoc にしか無いのは弱い）を書く。あわせて `spec/inventory/domain.md` に DOM-identity-XXX を1行足す。

- **[W-004]** `spec/usecases/identity.md#getCurrentUser` の出力 DTO が `email` を持ち続けている。実装は意図的に落として #12 へ委ねているが、その注記が spec 側に無い
  - 場所: `spec/usecases/identity.md:655-663`（出力DTO表の `email` 行・処理フロー手順3）/ `spec/inventory/usecase.md` UC-identity-013 / 実装: `packages/core/src/application/identity/view.ts:1-22`、`apps/web/app/components/settings/CurrentUserPanel/index.tsx:30-32`
  - 理由: 実装側は2箇所で明示的に落としている。

    > no `email` — the address original lives on the Identity Directory side and is decrypted one at a time through its own entry (#12), never as part of this projection.（`view.ts`）

    一方 spec は出力 DTO 表に `| email | string |` を持ち、処理フロー手順3 が「**認証情報側**からメールアドレスの原本を1件だけ復号して取得する」と**手順として要求している**。`spec/inventory/usecase.md` の UC-identity-013 も同文である。

    plan.md の「含まれないもの」に `getCurrentUser` の email 復号は名指しされておらず（`read-own-canonical` は steps.md の RPC 全数表に「未実装・担当 Issue」として現れるだけ）、**spec だけを読むと「#37 が UC-identity-013 を実装したのに DTO が1フィールド足りない」という未検出の実装漏れに見える。** `implement-audit` / `spec-sync` はまさにこの形を拾う。
  - 提案: `spec/usecases/identity.md` の当該 DTO 行と手順3、および `spec/inventory/usecase.md` UC-identity-013 に「**`email` の復号取得は #12**（`read-own-canonical` の実装とセット）。#37 が返すのは `userId` / `credentials` / `trashRetentionDays` の3つ」を1行入れる。W-003 と同じ性質なので、同じ pass で処理できる。

- **[W-005]** `dedupeByCredentialId` の JSDoc が主張する規則と、コードが実装している規則が違う
  - 場所: `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts:126-135`
  - 理由:

    ```ts
    // Later generations win on the mirrored fields, matching
    // `CredentialLocatorStore.record`'s overwrite semantics.
    if (existing === undefined || row.usable_for_login > existing.usable_for_login) {
      seen.set(row.credential_id, row);
    }
    ```

    クエリは `ORDER BY credential_id, generation`（昇順）なので「後の世代が勝つ」なら条件は無条件の上書きでなければならない。実際の条件は **`usable_for_login` が真に大きいときだけ置換**なので、両世代とも `usable_for_login = 1` のときは**最初に現れた（＝いちばん古い）世代の行が残り、その行の `label` が `User.credentials` に載る。** 実装している規則は「いずれかの世代が可用なら可用（OR）」であって、コメントの「後勝ち」ではない。

    `ports/credentialLocatorStore.ts:56-57` は `record` について「`usableForLogin` と `label` は**上書きされる**、Directory が決めるからである」と書いている。射影側が古い世代の `label` を残すのは、その「権威は Directory 側」という宣言と噛み合わない。

    いまは実害が無い（`label` は sso なら provider 名、email なら空文字で、世代間で変わらない）。ただし**2世代並存を作るのは #44 の鍵ローテーションで、その実装者が読むのはこのコメントである。** 「後勝ち」と書いてあるものが後勝ちでない状態で移送を設計されると、齟齬が実害に変わる。
  - 提案: どちらかに揃える。(a) 実装が正しい（可用性は OR で取る、最後のログイン手段の数え方として安全側）なら、コメントを「`usableForLogin` はいずれかの世代が真なら真。`label` はその勝った行のもの」に書き直す。(b) 「後勝ち」を意図しているなら条件を `>=` にする。**(a) を推す** — 可用性を OR で取ることには「ローテーション途中で片方の世代の行がまだ `usableForLogin: false` でも締め出さない」という独立した価値があり、それをコメントに書けば #44 への引き継ぎになる。

## Notes

- **[N-001]** B-001 の直し方が指摘より良い。`lib/rpcPayloads.ts`（1周目の提案）を採らず、「この2つのインターフェースは DO という外部リソースへの driven port だから、内側で定義して外側が実装するのがそもそもの形」という理由で `application/di/facades.ts` に置いたのは、ヘキサゴナルの向きとして正しい。`CurrentUserPayload` を `CurrentUserView` へ一本化して `getCurrentUser` の宣言型と実体を一致させた点も含めて、指摘の3提案すべてに応答がある。

  機械検証の作り直しも良い。`grep -v '/di/'` を狭められない理由（両合成ルートが `*FacadeDeps` / `DirectoryLocator` を `import type` で正当に名指す）を確かめたうえで、`application/di/__tests__/noAdapterBackflow.test.ts` を**ファイル名単位**（`di/serverCloudflare.ts` / `di/stateCloudflare.ts` の2本だけ許可）にしたので、次に契約モジュールが増えても同じ穴を通れない。空振り防止の `files.length > 20` と `arrayContaining(COMPOSITION_ROOTS)` も付いている。実測でも `packages/core/src/{domain,lib}` から外向きの import は0件、`Promise` を返すドメインポートは `PasswordHasher` / `MailSender` の2つだけで、`CLAUDE.md` の列挙が守られている。

- **[N-002]** 非空タプル（ADR-073）はキャストを増やしていない。`requireKeyring` の `as unknown as Keyring` は**修正前から同じ行**（ブランド型の唯一の構築点）で、`Keyring.entries` をタプルにしても増えていない。`directoryLocator.forCanonical` は `const [active, ...previous] = keyring.entries` から組むのでキャスト無しでタプルが通り、`signupSaga` の `ordered` は `sort` を in-place で呼んでタプル型を保っている（`[...resolved].sort()` にすると `T[]` へ潰れる点まで JSDoc に書いてある）。`activeLocator` が全関数になり、`throw new Error(...)` は application / domain から消えた（残る `throw new Error` は `di/secrets.ts` / `di/containerStore.ts` の起動時設定エラーと、`entity.ts:131` の `reconstruct` 内 — 後者は `RehydrationError` に包まれる）。不正状態は実際に表現不能になっている。

- **[N-003]** `Email` のラベル構文検査（ADR-074）は正当なアドレスを弾いていない。punycode の**後**に掛ける順序が正しく（`xn--` は LDH なので変換前だと国際化ドメインを全滅させる）、「通り続けるべき4ケース」（`my-host.example.com` / `host1.example2.com` / 63文字ラベル / `localhost`）が常設テストとして固定されている。ラベル数の下限を置かなかった判断（`user@localhost` を残す）も spec の射程内。

  1点だけ記録: ASCII の IP リテラル（`user@[::1]`）は今回から拒否対象になった（`[::1]` は LDH でない）。実務上まず使われないので指摘には数えないが、`toAsciiDomain:115-116` の「Bracketed IPv6 literals come back wrapped; ... the structural check has already passed」というコメントは、**その関数が非 ASCII ドメインにしか掛からない以上そもそも到達しない記述**であり、いまは `assertDomainSyntax` が後段で弾くので二重に成立しない。次に触る人が「IPv6 リテラルは通る」と読む余地があるので、消すか射程を書き足すと良い。

- **[N-004]** `LookupCredentialResult` の3アーム化（ADR-072）で、`loginWithPassword` の「すべての失敗が `ValidationError("INVALID_CREDENTIALS")`」という中心契約を破る経路が実際に無くなった。`identity` アーム（SSO 行・SSO 専用アカウントのアドレス予約行）は `continue`、`PasswordHash.create` に失敗した壊れた保存値も `continue` で、どちらも未登録アドレスと同じ `burnVerificationTime` → `invalidCredentials()` に落ちる。`toPasswordHash` の JSDoc が「区別できる失敗を返すとそのアドレスの存在を未認証の呼び出し元に教える」と理由まで書いているのが良い。`?? ""` と `as PasswordHash` は両方消えている。

- **[N-005]** ダイジェストが2種類になった。`jobs.payload_digest` は adapter-infra W-005 の対応で**キー順ソート + 4レーン128bit**（`jobs/table.ts:47-91`）になったが、`operations.payload_digest` を作る `signupSaga.ts:341-349` の `digestOf` は **`JSON.stringify` + FNV-1a/32 のまま**である。1周目が「衝突は実害を持たない」と判定した根拠（`operationId` が毎回新規採番なので、同じ `operationId` に異なる locator 集合が来る経路が無い）は今も成立しているので指摘には数えない。

  ただし `payloadDigest` の JSDoc が書いた理由 —「衝突はエラーとして表面化せず、2番目の要求が黙って落ちる。静かな失敗は『ありそうにない』ではなく『起こりえない』にしなければならない」— は `operations` 側にもそのまま当てはまる。**#45 が自動回収（同じ `operationId` での再駆動）を足した時点で初めてこの比較が意味を持つ**ので、そのとき32ビットで足りるかを判断し直すこと。移すなら `lib/` へ（application からは `adapters/` を import できない）。ADR-024（Directory 側は `operationId` だけで判定）との非対称もあわせて #45 へ。

- **[N-006]** `requestPasswordReset` の全世代への無条件ファンアウト（adapter-infra W-009 / ADR-046 別件）は、一様性の観点では正しい直し方で、unit テスト4本（順序・世代ごとの hmac・登録有無で呼び出し数が変わらない・形式不正は0件）も的確である。ただし **#44 の鍵ローテーション移送が2世代に同じ写像行を並存させた瞬間、1回の依頼が2つのバケットで別々のトークンを発行し、有効なリンクが同時に2本立つ。** #37 には移送が無いので現時点で到達しないが、#44 の設計材料として記録しておく価値がある（`spec/domains/identity.md` の「同じクレデンシャルに新しいトークンを発行すると未使用トークンはすべて置き換わる」は、**1バケット内**でしか成立しない）。

- **[N-007]** spec 同期の細かい残り2点（いずれも実害なし）。(i) `spec/inventory/domain.md` DOM-identity-001 は `credentials` を「1件以上」と無条件で書いたままで、`spec/domains/identity.md`:117 が今回「**登録が完了したアカウントの**」へ限定した書き分けと揃っていない。(ii) `spec/usecases/identity.md` の linkSso 手順5 と unlinkSso 手順2 で、項目削除の結果 `1. / 3.` `1. / 2. / 3. / 5. / 6.` と採番が飛んでいる（Markdown の順序リストなので表示は連番になり、本文の「手順2-2」参照も表示順と一致するため実害は無い）。

## 1回目指摘の修正検証

- **B-001**（`di/facades.ts` の `application → adapters` 逆流）: **解消。** 7型のうち6型を `application/di/facades.ts` へ移し、`CurrentUserPayload` は `CurrentUserView` へ一本化。`adapters/cloudflare/{userData,identityDirectory}/facade.ts` と `apps/web/app/durable-objects/*.ts` が `@repo/core/application/di/facades` から import する向き（adapters → application）になっていることを実測で確認。AC-25 (ii) の grep は形を変えず、代わりに `noAdapterBackflow.test.ts` がファイル名単位で固定（ADR-071）。→ N-001。
- **B-002**（`User` が書けない集合の遷移を公開）: **解消。** (a) 射影に倒す案を採用し `addCredential` / `removeCredential` を削除、`initialize` からクレデンシャル引数も除去。`ports/userSettingsRepository.ts:16-25` に「`insert` / `save` は `User.credentials` を書かない」を明記。spec は #12 へ送らず本 PR で同期（domains / usecases / inventory / testcases の4面）。**残りは引き継ぎ面の2点**（W-001 のエラーコード名、W-003 の spec アンカー）。
- **W-001**（`credentials ≥1 / usableForLogin ≥1` が未強制）: **解消。** 「アカウントの不変条件であって `User` 値の毎瞬のそれではない」と spec に書き分け（`spec/domains/identity.md`:117 の2サブ項目）、`initialize` から引数を外して「0件を渡す」経路自体を消した。`entity.test.ts` に0件・重複 `credentialId`・address-only の3ケースを追加。
- **W-002**（`removeCredential` の `kind: "sso"` 限定欠落・逆挙動を固定したテスト）: **解消。** メソッドごと削除されたので当該テスト（`"removes an address-only entry without complaint"`）も消えた。`kind` 検査の所在は spec 3箇所（domains の不変条件 / usecases 手順2-2 / エラー表）と testcases に書かれている。
- **W-003**（`LookupCredentialResult` が非ユニオン）: **解消。** `password` / `identity` / `none` の3アーム判別可能ユニオン。`?? ""` と `as PasswordHash` の両方が消え、壊れた保存値も一様な `continue` に落ちる（ADR-072）。→ N-004。
- **W-004**（素の `Error` 2件）: **解消。** `Keyring.entries` / `forCanonical` / `runSignupSaga` の引数を非空タプルにして `throw` 2件を削除。`sort` を in-place にしてタプル型を保つ判断まで JSDoc にある（ADR-073）。→ N-002。
- **W-005**（ドメインポートの `readonly unknown[]`）: **解消。** `domain/identity/ports/credentialLocatorStore.ts` に `CredentialLocatorRef`（プリミティブのみ5フィールド）を置き、`CredentialLocator` がそれを拡張、`application/execution/jobs.ts` の `LocatorRef` はその別名。`ReserveCredentialArgs.locators` は `readonly CredentialLocatorRef[]`。`credentialId` をブランドにしない理由（値として RPC / JSON を旅する）も記録済み（ADR-075）。
- **W-006**（`Email` の canonical 化が ASCII / 非 ASCII で非対称）: **解消。** punycode 後に `assertDomainSyntax` を掛けて両経路を1ゲートに。ASCII 10ケース + 通り続ける4ケースのテストを追加（ADR-074）。→ N-003。
- **W-007**（ログイン可否の述語がアダプターに3重）: **解消。** `domain/identity/credentialMappingRules.ts` に4述語を新設し、`lookupCredential` / `requestPasswordReset` / `sendMail` の3箇所が呼ぶことを実測で確認。スロットル窓は引数のままで #18 / #38 への委譲が崩れていない。リセット可否をログイン backoff と別建てにした理由も JSDoc とテストにある（ADR-072）。**spec アンカーだけが未整備** → W-003。
- **W-008**（`dedupeByCredentialId` の `as CredentialRef[]`）: **解消。** 戻り値型を緩い行の形にして `as` を削除、検証点は `User.reconstruct` の1箇所に残った。**ただし同関数のコメントと条件式の食い違いは残っている** → W-005。

**新たな問題を生んだ指摘: なし。** 5件の Warning はいずれも「修正が正しく、その波及を spec / `.adr/` へ書き戻していない」形で、コードの振る舞いを壊した箇所は見つからなかった。

## カバレッジ

一覧248件に対し、確認54件 / スキップ194件（合計248件）。

### 確認（54件）

Domain / Use Case の判定に実際に使ったファイル。`packages/core/src/domain/**` と `packages/core/src/application/identity|execution|di/**` は修正コミット `b1caa65` の差分の有無にかかわらず最終状態を読み直した。ポート4本（`mailSender` / `rotationCheckpointStore` / `credentialMappingRepository` / `accountStore`）と `domain/common/transactionalRepository.ts` は1周目に全文確認済みかつ `b1caa65` が触れていないことを確認したうえで、契約面（同期性・ロスター）を再検証した。

- `.thread/37/adr.md`
- `.thread/37/plan.md`
- `.thread/37/review/review-001-domain-usecase.md`
- `.thread/37/review/triage.md`
- `.thread/37/steps.md`
- `CLAUDE.md`
- `apps/web/app/components/settings/CurrentUserPanel/index.tsx`
- `apps/web/app/durable-objects/identityDirectory.ts`
- `apps/web/app/durable-objects/userData.ts`
- `packages/core/src/adapters/cloudflare/directoryLocator.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/facade.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sendMail.ts`
- `packages/core/src/adapters/cloudflare/jobs/table.ts`
- `packages/core/src/adapters/cloudflare/userData/facade.ts`
- `packages/core/src/adapters/cloudflare/userData/userSettingsRepository.ts`
- `packages/core/src/application/di/__tests__/noAdapterBackflow.test.ts`
- `packages/core/src/application/di/facades.ts`
- `packages/core/src/application/di/secrets.ts`
- `packages/core/src/application/di/serverCloudflare.ts`
- `packages/core/src/application/di/stateCloudflare.ts`
- `packages/core/src/application/di/types.ts`
- `packages/core/src/application/errors.ts`
- `packages/core/src/application/execution/jobs.ts`
- `packages/core/src/application/execution/unitOfWork.ts`
- `packages/core/src/application/identity/__tests__/identity.integration.test.ts`
- `packages/core/src/application/identity/__tests__/requestPasswordReset.test.ts`
- `packages/core/src/application/identity/getCurrentUser.ts`
- `packages/core/src/application/identity/loginWithPassword.ts`
- `packages/core/src/application/identity/registerWithPassword.ts`
- `packages/core/src/application/identity/requestPasswordReset.ts`
- `packages/core/src/application/identity/signupSaga.ts`
- `packages/core/src/application/identity/view.ts`
- `packages/core/src/domain/common/transactionalRepository.ts`
- `packages/core/src/domain/identity/__tests__/credentialMappingRules.test.ts`
- `packages/core/src/domain/identity/__tests__/entity.test.ts`
- `packages/core/src/domain/identity/__tests__/valueObject.test.ts`
- `packages/core/src/domain/identity/credentialMappingRules.ts`
- `packages/core/src/domain/identity/entity.ts`
- `packages/core/src/domain/identity/errorCode.ts`
- `packages/core/src/domain/identity/ports/accountStore.ts`
- `packages/core/src/domain/identity/ports/credentialLocatorStore.ts`
- `packages/core/src/domain/identity/ports/credentialMappingRepository.ts`
- `packages/core/src/domain/identity/ports/credentialMappingStore.ts`
- `packages/core/src/domain/identity/ports/mailSender.ts`
- `packages/core/src/domain/identity/ports/passwordResetTokenPort.ts`
- `packages/core/src/domain/identity/ports/rotationCheckpointStore.ts`
- `packages/core/src/domain/identity/ports/userSettingsRepository.ts`
- `packages/core/src/domain/identity/valueObject.ts`
- `packages/core/src/lib/errorIdentity.ts`
- `spec/domains/identity.md`
- `spec/inventory/domain.md`
- `spec/inventory/usecase.md`
- `spec/testcases/identity/unlinkSsoCredential.md`
- `spec/usecases/identity.md`

### スキップ（194件）

**他観点のレビューファイル・作業ログ（6件）** — 自分の観点の1周目レビューと triage / steps 以外は他レビュアーの担当。

- `.thread/37/review/review-001-adapter-infra.md`
- `.thread/37/review/review-001-presentation-config.md`
- `.thread/37/review/review-001-security.md`
- `.thread/37/review/review-001-test.md`
- `.thread/37/review/review-001.md`
- `.thread/37/testing.md`

**恒久 ADR（2件）** — 内容は W-002 の判定に使ったが、変更差分そのものは検索・テスト構成の観点。

- `.adr/001-integration-tests-single-workers-pool.md`
- `.adr/003-sqlite-fts5-only-search.md`

**削除された D1 アダプター群・Outbox 機構・旧 Worker 群（28件）** — 対象消滅の削除。ドメイン契約側の変更（同期化・イベント撤去）は「確認」側で見ており、削除物そのものはアダプター観点。

- `apps/web/app/worker/cloudflare/__tests__/env.d.ts`
- `apps/web/app/worker/cloudflare/__tests__/handlers.integration.test.ts`
- `apps/web/app/worker/cloudflare/consumer.ts`
- `apps/web/app/worker/cloudflare/dlq.ts`
- `apps/web/app/worker/cloudflare/handlers.ts`
- `apps/web/app/worker/cloudflare/pruner.ts`
- `apps/web/app/worker/cloudflare/relay.ts`
- `packages/core/src/adapters/cloudflare/serviceBindingRelayTrigger.ts`
- `packages/core/src/adapters/d1/__tests__/env.d.ts`
- `packages/core/src/adapters/d1/__tests__/helpers.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/helpers.ts`
- `packages/core/src/adapters/d1/__tests__/idempotencyStore.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/occGuard.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/outboxRepository.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/setup.ts`
- `packages/core/src/adapters/d1/__tests__/unitOfWork.integration.test.ts`
- `packages/core/src/adapters/d1/__tests__/userRepository.integration.test.ts`
- `packages/core/src/adapters/d1/client.ts`
- `packages/core/src/adapters/d1/migrations/0000_initial.sql`
- `packages/core/src/adapters/d1/migrations/meta/0000_snapshot.json`
- `packages/core/src/adapters/d1/migrations/meta/_journal.json`
- `packages/core/src/adapters/d1/pendingBatch.ts`
- `packages/core/src/adapters/d1/repositories/helpers.ts`
- `packages/core/src/adapters/d1/repositories/idempotencyStore.ts`
- `packages/core/src/adapters/d1/repositories/outboxRepository.ts`
- `packages/core/src/adapters/d1/repositories/userRepository.ts`
- `packages/core/src/adapters/d1/schema.ts`
- `packages/core/src/adapters/d1/unitOfWork.ts`

**削除されたイベント機構・旧ポート（13件）** — AC-14 / AC-8 の消滅確認のみ。ドメインからイベント型が消えたことは `domain/identity/entity.ts` 側で確認済み。

- `packages/core/src/application/events/buildDecoder.ts`
- `packages/core/src/application/identity/__tests__/eventDecoders.test.ts`
- `packages/core/src/application/identity/eventDecoders.ts`
- `packages/core/src/application/ports/idempotencyStore.ts`
- `packages/core/src/application/ports/outboxRepository.ts`
- `packages/core/src/application/ports/relayTrigger.ts`
- `packages/core/src/application/workers/__tests__/eventRelayWorker.integration.test.ts`
- `packages/core/src/application/workers/__tests__/outboxPrune.test.ts`
- `packages/core/src/application/workers/eventRelayWorker.ts`
- `packages/core/src/application/workers/outboxPrune.ts`
- `packages/core/src/domain/common/event.ts`
- `packages/core/src/domain/identity/events.ts`
- `packages/core/src/domain/identity/ports/userRepository.ts`

**Cloudflare アダプター実装（39件）** — SQL 実行・スキーマ DDL・ジョブ実行部・検索 projection・暗号・alarm・リセットトークン導出鎖。ドメイン契約に触れる facade / rules 呼び出し点は「確認」側に入れ、残る駆動部と DDL はアダプター観点（ADR-042 の導出鎖は security / adapter 担当）。

- `packages/core/src/adapters/cloudflare/identityDirectory/canonicalCipher.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/credentialMappingRepository.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/mappingOperations.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/opaqueBinding.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenCrypto.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/resetTokenStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/rotationCheckpointStore.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/unitOfWork.ts`
- `packages/core/src/adapters/cloudflare/jobs/alarm.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/migrateBulk.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/purgeTrash.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/reindex.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/resumeSignup.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepReservations.ts`
- `packages/core/src/adapters/cloudflare/jobs/handlers/sweepResetTokens.ts`
- `packages/core/src/adapters/cloudflare/jobs/registry.ts`
- `packages/core/src/adapters/cloudflare/jobs/runner.ts`
- `packages/core/src/adapters/cloudflare/mailSender.ts`
- `packages/core/src/adapters/cloudflare/platform/envelope.ts`
- `packages/core/src/adapters/cloudflare/platform/rpcEntry.ts`
- `packages/core/src/adapters/cloudflare/platform/stubErrors.ts`
- `packages/core/src/adapters/cloudflare/schema/bulkSteps.ts`
- `packages/core/src/adapters/cloudflare/schema/gate.ts`
- `packages/core/src/adapters/cloudflare/schema/identityDirectory.ts`
- `packages/core/src/adapters/cloudflare/schema/jobsDdl.ts`
- `packages/core/src/adapters/cloudflare/schema/types.ts`
- `packages/core/src/adapters/cloudflare/schema/userData.ts`
- `packages/core/src/adapters/cloudflare/search/normalize.ts`
- `packages/core/src/adapters/cloudflare/search/probe.ts`
- `packages/core/src/adapters/cloudflare/search/projection.ts`
- `packages/core/src/adapters/cloudflare/sql/errors.ts`
- `packages/core/src/adapters/cloudflare/sql/exec.ts`
- `packages/core/src/adapters/cloudflare/sql/occ.ts`
- `packages/core/src/adapters/cloudflare/userData/accountStore.ts`
- `packages/core/src/adapters/cloudflare/userData/credentialLocatorStore.ts`
- `packages/core/src/adapters/cloudflare/userData/trashQuery.ts`
- `packages/core/src/adapters/cloudflare/userData/unitOfWork.ts`
- `packages/core/src/adapters/webcrypto/hmacSessionCodec.ts`
- `packages/core/src/adapters/webcrypto/pbkdf2PasswordHasher.ts`

**アダプター / 統合・単体テスト（32件）** — DO バインディング・alarm・job table・FTS5・migration ゲート・クリーンアップ・禁止語配列の検証。テスト観点かつアダプター観点。

- `apps/web/app/durable-objects/__tests__/env.d.ts`
- `apps/web/app/durable-objects/__tests__/rpcEntries.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/alarmEntry.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/binding.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/cleanup.integration.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/directoryLocator.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/doHarness.ts`
- `packages/core/src/adapters/cloudflare/__tests__/env.d.ts`
- `packages/core/src/adapters/cloudflare/__tests__/envelope.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/forbiddenValues.ts`
- `packages/core/src/adapters/cloudflare/__tests__/mailSender.test.ts`
- `packages/core/src/adapters/cloudflare/__tests__/setup.ts`
- `packages/core/src/adapters/cloudflare/__tests__/stubErrors.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/mappingOperations.integration.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/resetToken.integration.test.ts`
- `packages/core/src/adapters/cloudflare/identityDirectory/__tests__/ssoResolution.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/alarm.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/directoryJobs.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/payloadDigest.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/purgeTrash.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/registry.typetest.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/runner.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/sendMail.integration.test.ts`
- `packages/core/src/adapters/cloudflare/jobs/__tests__/table.integration.test.ts`
- `packages/core/src/adapters/cloudflare/schema/__tests__/gate.integration.test.ts`
- `packages/core/src/adapters/cloudflare/schema/__tests__/migration.integration.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/normalize.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/projection.integration.test.ts`
- `packages/core/src/adapters/cloudflare/search/__tests__/tokenizer.integration.test.ts`
- `packages/core/src/adapters/cloudflare/userData/__tests__/occ.integration.test.ts`
- `packages/core/src/adapters/webcrypto/__tests__/hmacSessionCodec.test.ts`

**application 層の残りテスト・合成ルート補助（16件）** — 1周目に確認済みで、`b1caa65` が触れていないか、触れていても他観点（テスト / 設定）の担当。

- `packages/core/src/application/__tests__/helpers.ts`
- `packages/core/src/application/di/__tests__/requestContainerConfig.test.ts`
- `packages/core/src/application/di/__tests__/routingNonExposure.test.ts`
- `packages/core/src/application/di/__tests__/secrets.test.ts`
- `packages/core/src/application/di/__tests__/serverCloudflare.test.ts`
- `packages/core/src/application/di/__tests__/stateContainerConfig.test.ts`
- `packages/core/src/application/di/containerStore.ts`
- `packages/core/src/application/di/env.ts`
- `packages/core/src/application/execution/__tests__/unitOfWork.typetest.ts`
- `packages/core/src/application/identity/__tests__/loginWithPassword.test.ts`
- `packages/core/src/application/identity/__tests__/logout.test.ts`
- `packages/core/src/application/ports/idGenerator.ts`
- `packages/core/src/application/ports/sessionCodec.ts`
- `packages/core/src/application/rpc/__tests__/restoreError.test.ts`
- `packages/core/src/application/rpc/restoreError.ts`
- `packages/core/src/domain/identity/__tests__/noRawNul.test.ts`

**`lib/` の leaf モジュール（7件）** — 層の外の構造的プリミティブ。1周目に全数確認済みで、`b1caa65` が触れたのは `errorIdentity.ts`（確認側）と `jobBudgets.ts`（ジョブ予算＝アダプター観点）のみ。

- `packages/core/src/lib/__tests__/jobKind.test.ts`
- `packages/core/src/lib/directoryLocator.ts`
- `packages/core/src/lib/jobBudgets.ts`
- `packages/core/src/lib/jobKind.ts`
- `packages/core/src/lib/passwordHashing.ts`
- `packages/core/src/lib/rpcEnvelope.ts`
- `packages/core/src/lib/secretLengths.ts`

**presentation 層・フロントエンド（13件）** — presentation-config 担当。

- `apps/web/app/components/auth/LoginForm/action.ts`
- `apps/web/app/components/auth/SignupForm/action.ts`
- `apps/web/app/components/settings/LogoutButton/action.ts`
- `apps/web/app/components/settings/SettingsSkeleton/index.tsx`
- `apps/web/app/presentation/__tests__/currentUser.test.ts`
- `apps/web/app/presentation/__tests__/errorResponse.test.ts`
- `apps/web/app/presentation/__tests__/errorResponseMiddleware.test.ts`
- `apps/web/app/presentation/__tests__/session.test.ts`
- `apps/web/app/presentation/authState.ts`
- `apps/web/app/presentation/currentUser.ts`
- `apps/web/app/presentation/errorResponse.ts`
- `apps/web/app/presentation/session.ts`
- `apps/web/app/routes/_app/settings.tsx`

**ビルド / デプロイ / インフラ / エントリポイント（29件）** — wrangler・vite・Pulumi・package.json・CI・lockfile・Worker エントリ・起動スモーク。インフラ / 設定観点。

- `.github/workflows/ci.yml`
- `README.md`
- `apps/web/.dev.vars.example`
- `apps/web/__tests__/boot.smoke.test.ts`
- `apps/web/app/server.cloudflare.ts`
- `apps/web/app/worker/cloudflare/state.ts`
- `apps/web/drizzle.config.ts`
- `apps/web/package.json`
- `apps/web/scripts/render-wrangler.ts`
- `apps/web/vite.config.cloudflare.ts`
- `apps/web/vite.config.state.ts`
- `apps/web/wrangler.production.toml.tpl`
- `apps/web/wrangler.request.production.toml.tpl`
- `apps/web/wrangler.request.staging.toml.tpl`
- `apps/web/wrangler.staging.toml.tpl`
- `apps/web/wrangler.state.production.toml.tpl`
- `apps/web/wrangler.state.staging.toml.tpl`
- `apps/web/wrangler.state.toml`
- `apps/web/wrangler.toml`
- `infra/cloudflare/pulumi/resources/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/resources/Pulumi.yaml`
- `infra/cloudflare/pulumi/resources/index.ts`
- `infra/cloudflare/pulumi/routes/Pulumi.production.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.staging.yaml`
- `infra/cloudflare/pulumi/routes/Pulumi.yaml`
- `package.json`
- `packages/core/package.json`
- `pnpm-lock.yaml`

**テスト構成（3件）** — vitest の3スイート分割設定。テスト基盤観点。

- `vitest.config.integration.ts`
- `vitest.config.smoke.ts`
- `vitest.config.ts`

**ドキュメント・DB / アダプター spec（6件）** — `docs/` は #38 / presentation-config 担当。`spec/database/index.md` と `spec/inventory/adapter.md` は物理スキーマとアダプター台帳で、リセットトークンの導出鎖同期は security / adapter 担当（triage「spec 同期1〜3」）。`spec/manual-tests/search.md` は検索の手順書。

- `docs/backend_implementation_example.md`
- `docs/runtime_cloudflare.md`
- `docs/test.md`
- `spec/database/index.md`
- `spec/inventory/adapter.md`
- `spec/manual-tests/search.md`
