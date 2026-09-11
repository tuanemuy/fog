# ステップ 9 認証 — 下書き

## リセットメールの送信は、コミット済みのモックどおりトーストで知らせる

### Context
ADR-010 は、リセットメール送信後の案内を「画面に持続する状態の説明」の例とし、`InlineAlert` に残すとしていた。ADR-020 の `info` トーンも、この案内を最初の利用者として足された。一方、コミット済みの `password-reset.html` は、送信済みを「リセットメールの送信を受け付けました」のトースト（画面下部中央、数秒で消える）で描き、登録の有無を明かさない説明はタイトルの下の一文（「アカウントが存在する場合、リセットリンクをお送りします」）が常に持っている。デザインレビュー D-001 の前例に従い、コミット済みのモックを正とする。

### Decision
- 依頼の成功は `useToast()` で「リセットメールの送信を受け付けました」を出し、フォームはそのまま残す。`?sent=1` への遷移と送信済みの画面は撤去し、ルートの `validateSearch` から `sent` を消す
- 失敗はフォームの先頭の `FormError` に出し、トーストは出さない
- 「登録されていれば送る」旨は、タイトル下の一文（`AuthSheetDescription`）が送信の前後を通じて持つ

### Consequences
- ADR-010 の「画面に持続する状態の説明」の例（リセットメール送信後の案内）は差し替えが要る。design/index.md の「画面にいる間ずっと成り立つ状態の説明はインライン表示で残す」は、規則としては残る
- ADR-020 の `info` トーンは、ステップ 9 では使われない（リポジトリ内に `tone="info"` の利用者は無い）。ADR-020 の「見た目の最終形はステップ 9 で確かめる」は成り立たないので、残すか消すかをまとめる担当が決める
- spec の P-03「送信済み: 『登録されていれば送信された』旨を表示」と manual-tests TC-10 手順 2 は、トーストと説明文の組で満たす（文言は変わる）

## 認証シートの説明文とテキストリンクは画面側に置き、プリミティブへの昇格を依頼する

### Context
モックの `.page-description`（password-reset.html の依頼と完了）と `.form-link`（login / signup の下の導線、フォームのエラーの中のリンク）は、どちらも複数の画面が同じ形で使う。`components/layout/AuthSheet` には `AuthSheetTitle` しか無く、`components/ui` にテキストリンクのプリミティブは無い。ステップ 9 は `components/ui` と `components/layout` を変更できない。

### Decision
- `components/auth/AuthSheetDescription` と `components/auth/FormLink`（`createLink`、`className` / `style` を受けない）を置き、認証の 3 画面とリセット完了のルートがこれを使う
- 説明文は、モックに説明文がある画面（パスワードリセットの依頼と完了）にだけ置く。ログイン・登録の説明文は撤去した

### Consequences
- **担当外への変更要望**: `AuthSheetDescription` は `components/layout/AuthSheet` の `AuthSheetTitle` の隣へ、`FormLink` は `components/ui` のテキストリンクとして移すのが ADR-004 の置き場に合う。移すときは import を差し替えるだけで済む
- 認証シートの「上にヘアラインを持つ区画」（`mt-section border-t border-neutral-100 pt-lg`）は、AI クライアント認可とリセット完了の 2 画面が同じ文字列を持つ。`AuthSheet` の区画として持たせるかをまとめる担当が決める
- ADR-027 の Consequences「ステップ 9 までは説明文が見出しの直下に詰まって出る（ステップ 9 で説明文ごと撤去する）」は、「ログイン・登録の説明文は撤去し、パスワードリセットはモックの一文を `AuthSheetDescription` で描く」に書き換える

## SSO のボタンは、アウトラインの段の見た目を素の `<a>` に当てて描く

### Context
SSO の開始は、ルーターが持たない素のハンドラ（`/auth/sso/:provider/start`）へのリダイレクトの連鎖で、`ButtonLink`（`createLink` のルーターのリンク）では書けない。`Button` は `<button>` なので、ページ遷移のリンクにならない。ADR-004 には、素の `href` を持つボタンの形のリンクが無い。

### Decision
- `SsoButtons` は、`components/ui/Button/styles` の `buttonClassName("outline")` を素の `<a href>` に当てる（プリミティブの見た目を上書きせず、そのまま使う近似）
- 既知のプロバイダ（Google / Apple）はモックのグリフ（`Icon` の `google` / `apple`、`md`）を文言の前に置く。表に無いプロバイダは名前だけで、グリフを持たない
- 文言はログインが「◯◯ で続行」、登録が「◯◯ で登録」（モック）

### Consequences
- **担当外への変更要望**: `components/ui` に、素の `href` を受けるボタンの形のリンク（例: `ButtonAnchor`）を足す。設定の「SSO 連携を追加」と `/export` も同じ形が要る（ステップ 16）。足したら `SsoButtons` は `buttonClassName` の直接の利用をやめる
- 走査テストは `buttonClassName` の直接の利用を拒まない（関数呼び出しで、上書きの経路ではない）

## フォームの失敗は先頭に 1 つだけ出し、画面で行った試行の失敗が SSO の失敗に代わる

### Context
ログイン・登録には、SSO のコールバックが `?sso_error=` で持ち込む失敗と、画面で送信した試行の失敗の 2 つの出どころがある。旧実装は前者をフォームの外、後者をフォームの下端に別々に出していた。モックは、フォームの失敗をフォームの先頭の `.error-message` 1 つで描く。

### Decision
- `FormError` はフォームの最初の子に 1 つだけ置く。試行の失敗があればそれを、無ければ SSO の失敗を出す
- 登録済みのメールアドレス（試行・SSO の `email_registered` の両方）は、文の後に「ログイン」のリンクを添える（旧「ログインする」をモックの語に揃えた）
- 項目の失敗（登録のメール形式・パスワード要件）は `TextField` の `error` が項目の下に出し、補足（「8文字以上」）は残る

### Consequences
- 送信で項目の失敗だけが出たときは、SSO の失敗が先頭に残る（旧実装と同じ）

## 認証 4 画面の文言と構造の選択（モックの文字どおりにしなかった点を含む）

### Context
「文言をモックに合わせる」が原則だが、モックの状態例が全体を描いていない画面、spec の要件と食い違う例示、プレゼンテーション層の共有の文言がある。

### Decision
- ログイン: 下の導線はモックどおり「アカウント登録」「パスワードを忘れた」の 2 つ（旧「はじめての方は アカウント登録」「パスワードをお忘れの方」）。送信ボタンは「ログイン」／「ログイン中…」
- 登録: 送信ボタンは「登録する」／「登録中…」、パスワードの補足は「8文字以上」（上限の 128 は `maxLength` が守る）、下の導線は「ログイン」
- パスワードリセットの依頼: タイトル「パスワードリセット」（`<title>` も「パスワードリセット — fog」）、ボタン「リセットメールを送る」。モックに無い「ログインへ戻る」は撤去した
- 新パスワードの設定: モックの状態例はフォームだけなので、タイトルは同じ画面の「パスワードリセット」とし、説明文は置かない。ラベル「新パスワード」、補足「8文字以上」、ボタン「パスワードを更新」／「更新中…」
- リンクの期限切れ: モックの「リセットリンクの有効期限が切れました」は、使用済みのリンクも同じエラーになる（S-AC-07・manual-tests で「使用済みであることは区別されない」）ので、「リセットリンクが無効か、有効期限が切れています。もう一度[パスワードリセット]をお試しください」に広げた
- リセット完了: タイトル「パスワードを更新しました」（`<title>` も）、説明文「覚えの無いログイン手段や接続は、ここで解除できます」、区画ラベル「ログイン手段」「AI」、末尾に塗りの「タイムラインへ進む」。旧実装の通知「パスワードを再設定しました。他の端末のセッションはすべて終了しています。」と区画ごとの説明文は、モックに無いので撤去した
- AI クライアント認可: クライアント名の下に「◯◯ として接続」。許可される操作・できないことの一覧は、モックの例示（4 項目・2 項目）ではなく現行の中身（4 項目・3 項目）を保つ。P-14 は「履歴操作は含まれないことを明示」を求め、同意の画面で実際の権限と違う一覧は出せないため。処理中は「許可する」を押したときだけ「許可中…」にし、「拒否する」を押したときは両方を無効にするだけにする（モックに拒否の処理中の文言は無い）。不正なリクエストは、モックどおりエラーだけを出し、旧実装の「タイムラインへ」は撤去した
- 許可される操作は `RowList` の中に画面が行を描く（先頭にグリフを持つ静的な項目で、`RowLink` / `Row` のどちらでもない。ADR-017 の Consequences が挙げた、2 種に入らない行）。できないことは線の無い縦並び

### Consequences
- **担当外（spec）**: spec/scenario/account.md S-AC-07 の手順 1 と spec/manual-tests/account.md（TC-01・TC-10）は、ログイン画面の導線を「パスワードをお忘れですか？」と書いている。画面は「パスワードを忘れた」になった（manual-tests の更新は plan.md のスコープ外）
- **担当外（presentation）**: モックの項目エラーの文言（「有効なメールアドレスを入力してください」「8文字以上で入力してください」）は、`presentation/errorDisplay.ts` の共有の文言（「メールアドレスの形式が正しくありません」「パスワードは8文字以上128文字以下で入力してください」）と違う。設定のパスワード変更も同じ文言を使うので、ステップ 9 では変えていない
- 他の端末のセッションが終了したことは、完了画面に出なくなる（spec の P-03 はこの表示を求めていない）

## リセット完了のスケルトンは、完了画面の形で組む

### Context
リセット完了のルートは、設定画面の形の `SettingsSkeleton`（汎用 `Skeleton` と `fog-settings`）をフォールバックにしていた。ADR-005 は、各画面のスケルトンを実画面と同じプリミティブ・同じ DOM で組むとする。

### Decision
- `components/settings/PasswordResetDoneFeed/skeleton.tsx` に `PasswordResetDoneSkeleton` を置く。区画・ラベル・末尾のボタンは完了画面と同じ定義（`styles.ts` の区画のクラス、`SectionLabel`、無効の `Button`）で描き、各区画に `RowList` と `Row` の 1 行を置いて文字だけを `Sk` で包む。領域に `aria-busy` と読み込み中のラベルを 1 つ付け、残りは支援技術から隠す
- DOM テストが、スケルトンと完了画面のラベルが同じ並びであることを確かめる

### Consequences
- 行の形は、ステップ 16 が `CredentialList` / `AiConnectionsList` を載せ替えた後の行（名前とメタの 2 行の `Row`）を前提にしている。ステップ 16 の行が別の形になったら、このスケルトンの行を合わせる
- 完了画面の中身の一覧（`CredentialList`・`AiConnectionsList`・`AiConnectionsPanel`）は `fog-*` のままで、載せ替えはステップ 16 が持つ。`AiConnectionsPanel` の利用者は完了画面だけで、モックの完了画面は一括失効を「すべての接続／すべて失効」の行（`.revoke-all`、危険テキスト）で描き、説明文を持たない
- 完了画面の DOM テストは、ステップ 16 の一覧が成功をトーストで出しても落ちないよう、`AuthSheet` の中に描く

## docs/test.md の DOM「What is covered」の更新

### Context
ステップ 9 で、3 つの DOM テストの中身が変わり、1 つ増えた。docs/ はステップ 9 の対象外。

### Decision
次の内容で差し替える（件数は、並列の他ステップの増減と合わせて数え直す。ステップ 9 は 1 つ増やした）。
- `aiClients/authorizeSheet` — the P-14 sheet: the client named and 「◯◯ として接続」, the allowed / disallowed operations each under its label, approve and deny each post and follow their redirect with both buttons disabled meanwhile and only approve saying 許可中…, a request that expired after the load drawn at the head of the decision, an invalid request drawing the error in place of the lists and buttons.
- `auth/authForm` — signup failures attributed to their field with the requirement kept, a duplicate address turned into a form error offering login, every login failure collapsed into one message, every form failure at the head of the form and the attempt's failure replacing the SSO callback's, the fields and button disabled while in flight, the SSO provider links carrying origin and redirect with their glyph (none for an unknown provider) and saying 登録 on signup, the reset entry on login only.
- `auth/passwordReset` — the request form's description under the title; the request answering with the same toast on the same form whatever the address, and a failure at the head of the form with no toast; completion posts token + password and reaches the done screen; a spent / expired link offers a new request at the head of the form; any other failure at the head without it; a weak password marked on its field.
- `settings/passwordResetDoneFeed` — the done page's login methods and AI connections under their labels and the way on to the timeline after them, no way to link another account; its skeleton one busy region with the stand-ins hidden and the button out of reach, under the same labels as the feed.

### Consequences
- なし（docs の記述をテストに合わせるだけ）
