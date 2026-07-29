# レビュー round-3（最終） — 要件カバレッジ・スコープ整合性（Issue #1）

対象: `.thread/1/plan.md`（24ステップ）/ `.thread/1/adr.md`（ADR-001〜011）
視点: 2周目指摘の実反映、チェックリスト75行のカバレッジ、見せかけのカバーの検出、Issue「検証」節の実現可能性、スコープ整合性
日付: 2026-07-25

## 突き合わせの方法

1. Issue 本文の `- [ ]` 行から ID を機械抽出（75件）／plan.md「チェックリスト対応表」の表頭 ID を機械抽出（75件）→ `diff` で**完全一致・重複0**を確認
2. plan.md / adr.md の「ステップNN」参照を**全件列挙**（plan.md 112箇所 / adr.md 10箇所）し、2周目の組み替え（旧10→10/11 分割、旧11→12・旧12→13・旧13→11 吸収）後の内容と指す先が一致するかを1件ずつ確認
3. 2周目 coverage P-001〜002 / S-001〜003、arch-risk P-001〜003 / S-001〜006 の反映を、宣言（レビュー履歴）ではなく plan.md / adr.md 本文の該当箇所で照合
4. `spec/inventory/{domain,adapter,usecase,frontend,test}.md` の要点欄と計画の中身を ID 単位で照合（見せかけのカバーの検出）／`spec/manual-tests/account.md` の TC-34 / 35 / 36 / 37 の実在確認
5. 既存コードでの裏取り: `apps/web/app/routeTree.gen.ts`（`to` union が `IndexRoute` 由来であること）、`apps/web/app/router.tsx` の `declare module "@tanstack/react-router"`（型付きリンクの登録）、todo 参照を持つテストファイルの全列挙（`idempotencyStore` / `outboxPrune` / `node` アダプターのテストは todo 非依存であり、ステップ3の削除リストに漏れが無いことを確認）

**2周目指摘の解消状況: coverage P-001〜002 / S-001〜003、arch-risk P-001〜003 / S-001〜006 の計14件はすべて実体を伴って反映済み（未解消ゼロ・宣言だけのものゼロ）。** 詳細は「良い点」。以下は3周目に新規で見つかった1件のみ。

## 問題点（要修正）

- **[P-001]** ルート参照が前方参照になっており、ステップ14 / 17 / 18 / 20 の完了時点で `pnpm typecheck` が通らない — AC-17 の「各実装ステップの完了時点でも `pnpm typecheck` が通る（ステップ順序はそのように組んである）」という宣言と実体が食い違う
  - 理由: `apps/web/app/router.tsx` は `declare module "@tanstack/react-router" { interface Register … }` でルーターを登録しているため、`<Link to>` / `router.navigate({ to })` / `redirect({ to })` の `to` は **`routeTree.gen.ts` が生成する literal union に対して静的に検査される**。現行の `routeTree.gen.ts` を読むと `to: '/' | '/todo/about' | '/todo'` で、`'/'` は `routes/index.tsx`（`IndexRoute`）由来である。ステップ3で `routes/index.tsx` を削除し routeTree を再生成した時点から、`'/'` は union から消える。この前提で各ステップの記述を追うと、次の4箇所が「まだ存在しないルート」を参照する。
    - **ステップ14** — `currentUser.ts` の `requireUserId()` が `redirect({ to: "/login", search: { redirect } })` を投げる。`/login` の作成は**ステップ17**
    - **ステップ17** — `login.tsx` が `/signup`（**ステップ18**）・`/password-reset`（**ステップ19**）へのリンクを置き、`beforeLoad` の遷移先 `search.redirect ?? "/"` のフォールバック `"/"`（`_app/index.tsx` は**ステップ20**）を使う
    - **ステップ18** — `SignupForm` が成功時に `/` へ遷移する（同上・**ステップ20**）
    - **ステップ20** — `AppShell` が5項目のうち `/settings`（**ステップ21**）へリンクする
  - 加えて、`routeTree.gen.ts` の再生成を計画が明示的に要求しているのは**ステップ3とステップ22の2箇所だけ**なので、ルートファイルを作った直後でも `pnpm dev` / `pnpm build` を回さない限り union は更新されない。ステップ17の完了条件には `pnpm dev` が入っているが、ステップ14 / 18 / 20 には入っていない。
  - これは2周目 arch-risk P-001（`RequestContainer` を広げるステップと構築地点の分離）と**同じ類型**の見落としである。計画はその指摘を受けて「順序の原則」に一般則1（共有型を広げるステップは構築地点をすべて同一ステップに含める）を足したが、**ルート（型付きリンクの参照先）に対応する一般則が無い**ため、同型の破れが UI 側に残っている。カバレッジ表の ID が壊れるわけではないので実装は最終的に成立するが、AC-17 は Issue チェックリスト由来ではなく計画が自ら立てた検証可能な基準であり、宣言と実体の乖離は最終ラウンドで潰しておくべき。
  - 提案: 次のいずれか（どれも記述の修正で足り、設計変更を伴わない）。
    - **(a) ルートの骨組みを先に作る（推奨）** — ステップ16とステップ17の間に「ルートファイルの骨組み作成 + `routeTree.gen.ts` 再生成」を置き、`login.tsx` / `signup.tsx` / `password-reset.tsx` / `_app.tsx` / `_app/{index,topics,search,trash,settings}.tsx` を**空コンポーネントで**一括作成する。以後のステップ17〜21は「中身を書く」だけになり、前方参照が消える。ステップ19（`/password-reset` プレースホルダー）とステップ20の3プレースホルダーは実質この骨組みステップに吸収される
    - **(b) グルーピングを明示する** — AC-17 に「ステップ14 および 17〜21 は型付きリンクの相互参照があるため、`pnpm typecheck` が通るのはステップ22（routeTree 再生成）時点。この区間は例外として扱う」と但し書きを足し、ステップ14 / 17 / 18 / 20 の完了条件から `pnpm typecheck` を外す
    - いずれを採るにせよ、「順序の原則」に一般則3として「**型付きリンク（`Link` / `navigate` / `redirect`）で相互参照するルート群は、ファイルの作成と `routeTree.gen.ts` の再生成を先に一括で済ませる**」を1行足しておくと、後続スライス（memo / knowledge / trash の各画面追加）で同じ事故が起きない

## 改善提案（検討推奨）

- **[S-001]** TC-logout-003 の「層」の字面差（spec: アダプター層 / 計画: presentation 層）を spec-sync 対象として1行記録する
  - 理由: `spec/inventory/test.md` の TC-logout-003 は「**アダプター層で** `SystemError` として扱われれば PASS」、`spec/testcases/identity/logout.md#L11` も同じ表現。一方、計画は翻訳を `apps/web/app/presentation/{session,sessionCookie}.ts`（`toSessionSystemError`）に置く。これは同じ spec が TC-logout-002 で「セッション破棄は presentation 責務」と書いていることと整合させた結果で、**判断としては正しい**（セッションを扱うアダプターが存在しない以上、他に置き場がない）。問題は、同種の字面差を計画が ADR-009（「UoW 不要」の読み替え）・ADR-011（`PlainPassword` の漏出防止）で丁寧に spec-sync 対象として記録しているのに、この1件だけ記録が無いこと。ADR-010 は「どの `SystemErrorCode` を使うか」の記録であって層の差には触れていない。ADR-010 の Consequences かカバレッジ注記に「TC-logout-003 の『アダプター層』は本実装では presentation 層。spec の内部不整合（TC-logout-002 は presentation と書く）を presentation 側に寄せて解決した。spec-sync 対象」と1行足すと、記録の粒度が3件で揃う

- **[S-002]** 対応表の ADP-outbox-001 / ADP-processed-events-001 のセルにステップ13を足す
  - 理由: ADP-occ-guard-001 のセルだけが「→ 13, 23」と実効的な検証ステップを参照しており、ADP-outbox-001 / ADP-processed-events-001 は「7（既存を引き継ぎ・再生成して検証）」で止まっている。しかしステップ13の理由欄は「**ADP-occ-guard-001 / ADP-outbox-001** の実効的な検証」と書いており、`outboxRepository.integration.test.ts` の `users` への移植はまさにこの2 ID の検証実体である。ID → ステップの逆引きが片方向でしか閉じていない状態なので、セルを「7, 13」に揃えると、レビュー時に「スキーマが出ただけで検証が無い ID」と誤読されない

## 良い点

- **2周目指摘14件はすべて実体を伴って反映されている**（宣言だけのものはゼロ）。本文を1件ずつ照合した結果:
  - **coverage P-001** → 設計節190行が「何を実装し何をテストで縛るか」の表に書き直され、対応表の DOM-identity-006 セルとカバレッジ注記の4点目に同内容が落ち、**ADR-011** が新設（spec 内部の緊張＝「ブランド型 `string`」と「`toString` 無効化」の両立不能を Context に明記し、spec-sync 対象と結論）。指摘した (a)(b)(c) が別々の箇所に届いている
  - **coverage P-002** → `toSessionSystemError(cause)` を `sessionCookie.ts` に置く方針が**設計節391〜398行・ステップ2の分岐(c)（490〜493行）・ステップ14（637行）・テスト方針（897〜898行）・ADR-010（411行）の5箇所で同一表現**になった。ステップ2の分岐(c) は「`sessionCookie.ts` に限定するだけでは TC-logout-003 は自動検証できない」と、指摘した誤りを明示的に否定する形で書き直されている。しかも「(c) の成否に関わらず切り出す」と条件を外したので、分岐の結果に依存しない
  - **coverage S-001** → ステップ24の手動リストに TC-34 / 35 / 36 が入り、**3件それぞれの理由**（TC-34 = Issue「検証」節の弱パスワード表示の spec 上の手動 ID、TC-35 = 上限 128→1024 変更の唯一の UI 検証手段、TC-36 = email 側の同種）が本文に書かれた。テスト方針の手動節・AC-12 の由来欄にも同じ3件が反映。`spec/manual-tests/account.md` に TC-34 / 35 / 36 が実在すること、TC-37 と事後処理節（TC-11 でのパスワード戻し）が本スライスでは実行不能であることも確認した
  - **coverage S-002** → TC-016 の欄が「**非制約系の DB 障害を注入**（制約違反では `ConflictError` になり ADR-008 の読み替えを通って `EMAIL_ALREADY_REGISTERED` に化ける）」に書き換わり、テスト方針905行にも同じ内容。ADR-008 の前提列挙にも `users.id` の PK 衝突が `UNIQUE_VIOLATION` に潰れる旨が足され、前提が閉じた
  - **coverage S-003** → AC-12 = 「18, 24」、AC-15 = 「14, 21, 24」。AC-12 の由来欄に manual TC-13 / 14 / 15 / 34 / 35 / 36 が並んだ
  - **arch-risk P-001** → ステップ10（ポート定義のみ・コンテナ型に触らない）とステップ11（`RequestContainer` 拡張 + DI 4本 + テストコンテナ2本 + `di/__tests__/serverCloudflare.test.ts` の `envWith`）に分割。ステップ11の冒頭に「**このステップは分割できない**」と理由付きで明記され、`libsql/__tests__/helpers.ts` が対象外である理由（`RequestContainer` を含まない独自形）まで書き分けられている
  - **arch-risk P-002** → ステップ3が3ファイルを**削除**に変わり、ステップ13で `IdentityEvents.userRegistered` を seed に復活。理由（`EventDecoderRegistry` が `AllDomainEvents` に閉じている／`runRelayTick` と node `runner.ts` にレジストリ差し込み口が無い）がステップ3・リスク節・順序の原則2・ADR-001 Consequences の4箇所に書かれ、「型エラーではなくテスト実行時にしか出ない」という性質も明示されている
  - **arch-risk P-003** → 設計節に `users_auth_method_valid` / `users_trash_retention_positive` が制約名付きで追加され、ステップ7が「名前付き制約6本 + インデックス2本」と数え上げ、目視リストが (a)〜(h) の8項目に拡張。`trash_retention_days >= 1` が独立の不変条件であることはリスク節にも重複して書かれている
  - **arch-risk S-001〜S-006** → CF だけ分解形が違う点（`{ binding, relay, waitUntil }`）を設計節・ステップ11・リスク節の3箇所に、`SessionError` 新設を ADR-010 として、`search.redirect ?? "/"` をステップ17と設計節に、`meta/` 生成後の D1 プール起動確認をステップ7の完了条件2に、`apps/web` 内での `--name initial` 直接実行をステップ7と設計節に、`Skeleton` 視認確認の (a)/(b) 2択と半段階 neutral の grep をステップ15の完了条件に — すべて着地している
- **チェックリスト75行のカバレッジは機械的に完全**。Issue 側 ID 集合と対応表 ID 集合の `diff` が**完全一致（欠落0 / 余剰0 / 重複0）**、内訳も 14 + 10 + 4 + 8 + 39 = 75。2周目のステップ分割・組み替えを経ても壊れていない
- **ステップ参照の追随が完全**。plan.md 112箇所・adr.md 10箇所の「ステップNN」をすべて確認したが、旧番号のまま残っている参照は**1件も無い**。1周目レビュー履歴に残る旧番号はすべて「（2周目の組み替え前はステップNN）」と併記されており、履歴としての正確さと現在の番号の両方が保たれている。AC 表の対応ステップ列（AC-1〜AC-18）・対応表・付随実装表・ADR の参照もすべて改訂後の内容と一致
- **「見せかけのカバー」は見つからなかった。** `spec/inventory/{domain,adapter,usecase,frontend,test}.md` の要点欄と計画の中身を ID 単位で照合したが、表に載っているだけで実体が無いものはゼロ。とくに検証した箇所:
  - PAGE-login-001 の「送信中はボタン無効＋進行表示」→ AC-10・ステップ17・ステップ16（`Button` が `disabled` と進行表示を props で持つ）の3層に落ちている
  - PAGE-login-002 の「（またはリダイレクト元URL）へ遷移」→ ステップ17の `router.navigate({ to: redirect })` と AC-9 が同じ経路を指している
  - PAGE-signup-001 の「項目ごとに表示」→ `errorField.ts` のマッピング表＋`renderBusinessMessage` の2つが揃って初めて成立する構造まで書かれている
  - UC-identity-013 の「passwordHash・SSO 主体 ID を含めない」→ `CurrentUserView` のキー集合表明（TC-getCurrentUser-003 / 004）と ADR-011 の漏出防止テストが同じ表明を共有している
  - ADP-occ-guard-001 → スキーマ（7）＋ `setup.ts` の `afterEach` 空表明の維持（7）＋移植した OCC 統合テスト（13, 23）の3点で実効的に閉じている
  - **部分実装の2件（DOM-identity-006 / DOM-identity-018・ADP-identity-001）は、対応表セル・カバレッジ注記・スコープ節・ADR の4箇所で同じ限定が書かれており、「75/75」の宣言が中身を隠していない**
- **ステップ3の削除リストに漏れが無いことを実コードで確認した。** todo を参照するテストファイルを全列挙したところ、`idempotencyStore.integration.test.ts`（d1 / libsql）・`outboxPrune.test.ts`・`adapters/node/__tests__/*` は todo 非依存（デコーダレジストリも通らない）で、削除リストに入っていないのが正しい。逆に削除対象8ファイル＋workers 3ファイルはすべて実在する
- **Issue の「検証」節は計画で実現できる**（最終状態として）。/signup 登録 → `startSession` → `/`（`_app/index.tsx` の空状態タイムライン、ステップ18 / 20）、/login のログイン（17）、`/settings` からのログアウト（21）、重複メール（`renderConflictMessage`＋`errorField.ts` のログイン導線）・弱パスワード（`renderBusinessMessage`）のエラー表示（18）、手動 ID での裏取り（24: TC-02 / 05 / 06 / 13 / 14 / 34）。**「弱パスワードのエラー表示」が2周目まで手動 ID に紐づいていなかった穴も TC-34 の追加で閉じた**
- **スコープの膨張は無い。** 2周目の修正で増えたのは「ステップ10 / 11 の分割」「ステップ13へのテスト復活」「ステップ24への手動 TC 3件」「`SystemErrorCode.SessionError` 1エントリ」だけで、いずれもチェックリスト ID か AC に紐づく。SSO ボタン非描画・パスワードリセット本体・ランタイム削除・テンプレート名リネームの除外判断も維持されており、`PendingBatch` の制約違反ハンドラを見送った判断（検証テストが書けない）も変わっていない

## 実装フェーズへの移行可否

**条件付き可。**

- 条件: **P-001 の記述修正1点のみ**（ルート骨組みを先に作るステップの挿入、または AC-17 の但し書きと該当ステップの完了条件の調整）。設計・スコープ・ID 対応には手を入れる必要がない
- S-001 / S-002 は着手を止める性質のものではない。実装中または PR 作成時に1行ずつ足せば足りる
- カバレッジ（75/75）・ステップ番号の整合・部分実装の可視化・Issue「検証」節の実現可能性・スコープ規律のいずれにも問題は無い。**要件カバレッジとスコープ整合性の観点では、この計画は2周のレビューで十分に潰れている**
