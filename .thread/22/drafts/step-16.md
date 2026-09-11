# ステップ 16（設定）の下書き — Issue #22

`components/settings/*`（`PasswordResetDoneFeed` を除く）と `routes/_app/settings.tsx` を settings.html の基準形へ載せ替えた際の設計判断・申し送り。番号は付けない（adr.md へ統合する担当が付ける）。

## ADR: ログイン手段の一覧は「ログインに使える手段」だけを並べ、最後の 1 つは解除操作を持たない

### Context
`CredentialList` は、メールの資格情報を「メールアドレス / 一意性の予約のみ」と表示し、SSO 行には常に解除ボタンを出して、最後のログイン手段かどうかはサーバーの `LAST_CREDENTIAL_REMOVAL` に任せていた。settings.html は、メール行を**アドレス**で名付けて `メール・パスワード` を添え、SSO のみのアカウントの状態例では**メールの行を出さず**、最後のログイン手段には `最後のログイン手段` と `解除できません` を出す。spec/pages/index.md P-13 も「メールアドレスによるログイン手段と最後のログイン手段は解除できない」と書いている。

### Decision
- メール行はアドレスで名付ける。アドレスは `CurrentUserView.email` にしか無く、`CredentialView` には（意図的に）無いので、`CredentialList` に任意の `email` を足した。渡されないときは `メールアドレス` に倒す
- `usableForLogin` が false のメール資格情報（一意性の予約）は「ログイン手段」ではないので一覧に出さない
- `usableForLogin` の数が 1 のときの SSO 行は、解除ボタンの代わりに `解除できません` を出し、メタに `最後のログイン手段` を出す。判定は楽観リスト（`shown`）で行うので、解除の途中でも表示が実態と合う
- サーバー側の拒否は消さない。競合で最後の 1 つになった場合は、従来どおり行の下にインラインで出る

### Consequences
- 良い点: モックの 2 つの状態例がそのまま出る。押しても必ず失敗する操作を出さない
- トレードオフ: 「一意性の予約」は画面のどこにも出なくなる。SSO 行のメタに出せる情報が無い（プロバイダの主体はビューに乗らない）ので、モックの `tanaka.yui@gmail.com` にあたる行は空のまま

## ADR: 外部ハンドラへ向かう操作は GET フォーム＋`Button` で近似する

### Context
`連携を追加` の行は、`/auth/sso/:provider/start?intent=link` というルーターの外（リクエスト Worker の素のハンドラ）へ向かう。`ButtonLink` は `createLink` で作られていて `to` がルートツリーの union に縛られるため、このパスには張れない。モック自体は `<button class="outline-btn">Apple で続行</button>` である。

### Decision
`method="get"` のフォーム（`action` が start のパス、`intent` は hidden input）に `Button variant="outline" type="submit"` を置いた。ブラウザが組み立てる URL は従来の `href` と同じ。アイコンは `Icon` の `google` / `apple`。

### Consequences
- 良い点: プリミティブだけで書ける。モックと同じ `<button>` になる
- トレードオフ: 新しいタブで開く・リンクをコピーする、ができない（従来は `<a>`）。**担当外への要望**: `components/ui` に「任意の `href` を受けるボタン形リンク」（`ButtonLink` の非ルーター版）があればこの近似は要らない。ステップ 9 の SSO ボタン（login / signup）も同じ問題を持つはずなので、どちらの形に揃えるかは統合時に決めてほしい

## ADR: SSO 連携の結果は、成功をトースト、失敗を「連携を追加」の行に届ける

### Context
`?sso=linked` / `?sso_error=` は `/settings` の検索パラメータで、画面の上端に `fog-notice` / `fog-error` として出ていた。ADR-010 では成功はトースト、失敗は項目に帰属する。モックは失敗を `.link-add` の直下（`.error-message`）に置く。一覧はストリームされる RSC の中にあり、URL を見られない。

### Decision
`SsoNotice` を「ラップして配るコンポーネント」に変えた。`sso === "linked"` なら `useToast()` で 1 度だけトーストし、失敗はコンテキストで下へ配って `CredentialList` が `連携を追加` の行の下に `FormError` として描く（`useSsoLinkError()`。P-03 では provider が無いので常に `null`）。`already_used` の文言はモックに合わせて「この外部アカウントは既に使われています」にした（別アカウントとは限らない、という spec の書き方とも一致する）。

### Consequences
- 良い点: 失敗が、それを起こした操作の隣に出る。ローダーの引数を増やさずに済む（`staleTime` と RSC の再描画に触れない）
- トレードオフ: 画面をリロードすると `?sso=linked` のトーストがもう一度出る（URL からパラメータを落とす処理は入れていない）

## ADR: 行の失敗はその行の下に置き、再試行はそこに操作があるときだけ足す

### Context
`fog-error` 1 つで、リストの失敗・フォームの失敗・行の失敗をすべて出していた。ADR-020 で持ち場ごとにプリミティブが分かれ、再試行の文言は呼び出し側が決める。

### Decision
- AI 接続の解除・SSO 連携の解除の失敗は、失敗した行の `Row` の `error` に `RowError` として出す（一覧全体の下ではない）。その行の操作ボタンがまだ見えているので、`RowError` の再試行は付けない
- エクスポートの失敗・一括失効の部分失敗には再試行を付ける。文言は `リトライ`（settings.html と trash.html の `.row-error` が両方ともそう書いている。`再試行` はフォーム先頭・コンポーザー・ルートエラーの側）
- エクスポートのセッション切れだけは `RowError` ではなく `FormError`（「一文＋それを解く唯一のリンク」の形。`リトライ` しても解けないため）
- パスワード変更は、項目の失敗を `TextField` の `error`、それ以外（試行制限を含む）をフォーム先頭の `FormError` に置く

### Consequences
- 良い点: どこに出るかがコンポーネントの選択で決まる
- トレードオフ: `RowError` は文字列しか取れないので、リンクを含む失敗は `FormError` に寄せることになる（行の形とは違う箱で出る）

## ADR: 一括失効は確認を挟み、成功と部分失敗を分ける

### Context
ADR-010 は「成功と部分失敗の混在 → 分割し、失敗はインラインに残す」。`AiConnectionsPanel` は P-03 だけが使い、モック（password-reset.html）では一覧末尾の `.revoke-all` 行＋確認ダイアログである。

### Decision
- 行の形（`すべての接続` ＋ 危険テキストの `すべて失効`）にし、`ConfirmDialog` を挟む
- 失効できた件数（`revokedCount > 0` か、失敗が 0 のとき）はトースト。失効できなかった件数は `RowError` として行の下に残し、`リトライ` を持たせる
- 説明文（「心当たりの無い接続を疑う場合は…」）はモックに無いので撤去した

### Consequences
- 良い点: 消える表示に失敗が乗らない
- トレードオフ: 確認ダイアログの文には接続名を出せない（この部品は接続の一覧を受け取らない）ので「接続しているすべてのAI から操作できなくなります。」という総称にした。**ステップ 9 への申し送り**: モックは「AI が 0 件のときは『すべて失効』を出さない」としている。件数を知っているのは `PasswordResetDoneFeed` 側なので、0 件のときはこの部品を描かないでほしい（接続名をダイアログに出すなら、名前を受け取る props を足す改修になる）

## ADR: 設定のスケルトンは P-13 の形に合わせる

### Context
`SettingsSkeleton` は汎用の `Skeleton` バーを 6 本並べていた。ADR-005 は実 DOM に被せる `Sk` を求める。この部品は P-13 と P-03（`/password-reset/done`、ステップ 9 の担当）の両方から使われている。

### Decision
`CurrentUserPanel` と同じ `SettingsSection` / `Row` / `Button` で組み、データの文字だけを `Sk` で包んだ。セクションのラベルはデータに依存しないので実文言のまま。領域全体に `role="status"` と読み込み中のラベルを 1 つ置き、中身は `aria-hidden` にして操作要素は `disabled` にした。

### Consequences
- 良い点: 差し替えでずれない
- トレードオフ: **ステップ 9 への申し送り**: P-03 のスケルトンとしては、出ないセクション（ゴミ箱・データ・アカウント）まで一瞬見えることになる。P-03 用のスケルトンを別に持つか、この部品にセクションの指定を足すかを決めてほしい

## 担当外への変更要望

- `apps/web/app/presentation/errorDisplay.ts`（＋その unit テスト）: モックの文言と食い違う 2 つ。試行制限は実装が「試行回数の上限に達しました。しばらくしてからお試しください」、モックは「試行が制限されています。しばらくしてからお試しください」。弱いパスワードは実装が「パスワードは8文字以上128文字以下で入力してください」、モックは「8文字以上で入力してください」。どちらも認証画面（ステップ 9）と共有するので、画面側では直していない
- `apps/web/app/presentation/time.ts`: `formatDay` は曜日付き、`formatDateTime` は `2026/09/10 14:30` で、モックの `2025年12月15日` / `2026年9月10日 14:30` と違う。全画面に効くので触らず、`AiConnectionsList` の中に設定画面用の `Intl.DateTimeFormat` を 2 つ置いた（`DISPLAY_TIME_ZONE` は共有）。表示の形を揃えるなら presentation 側の改修になる
- `docs/test.md` の DOM「What is covered」: settings の 6 行を今回の内容に直し、`settings/settingsSkeleton`（読み込み中の 1 領域・実ラベル・無効な操作）と `settings/ssoNotice`（連携成功のトースト、失敗が連携を追加の行の下、P-03 では配られない）の 2 ファイルを足す必要がある（ファイル数 45 → 47）。「`settings/exportPanel` … `<a download>` で保存して提供し続ける」は「`ダウンロード` のボタンで同じ Blob を保存し直す」に変わっている
- `components/ui`: 上の「外部ハンドラへ向かう操作」の `href` を取るボタン形リンク。無ければ今の近似（GET フォーム＋`Button`）のままで動く
- `components/ui/Icon` がリポジトリに無かった（ユーザーのグローバル `.gitignore` の `Icon` パターンに隠れていた）。作業中に共有された修正 21f4d5b をこのブランチに cherry-pick 済み

## モックとの差（意図的に残したもの）

- **AI が 0 件の一文に MCP の URL を残した**。モックの文は「接続しているAIはありません。AIアプリの設定で fog を追加すると接続できます。」だが、URL は他のどの画面にも出ないため、`fog（<URL>）` と括弧で埋め込んだ。空状態は一文のまま
- **エクスポート完了の「もう一度生成」を撤去した**（モックの完了状態は `ダウンロード` だけ）。生成し直すには画面を開き直す
- **保持期限の「現在: N 日」を撤去した**（モックに無い）。これに伴い `useOptimistic` も外した。保存中の表示は `保存中…` と読み取り専用の入力（モックの状態例と同じ）が受け持つ
- 保持期限の範囲外の値は、モックでは保存ボタンが無効だが、実装は従来どおり送信時に判定して行の下にエラーを出す（入力のたびの検証は入れていない）
- ボタンの箱は ADR-016 の段に寄せたので、ログアウトはモックより左に寸法分ずれる（`.text-btn` は横 padding 0）

## 既知の不具合の確認

パスワード変更フォームがデスクトップ幅で潰れていた原因は、旧 CSS の `.fog-password-change{ display:flex; align-items:center; justify-content:space-between; max-width:28rem }`（`app.css`）である。今回この画面から `fog-*` クラスをすべて外したので、フォームはユーティリティの `flex flex-col gap-lg` だけになり、`max-width` も掛からない。`app.css` の規則自体はステップ 17 まで残るが、セレクタが当たる要素がこの画面から消えたので解消しているはず（ブラウザ確認は後のフェーズ）。同じ規則が当たっていた `.fog-export-row` / `.fog-ai-connections` の `max-width: 28rem` も同様に外れる。
