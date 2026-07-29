# レビュー round-2 — 要件カバレッジ・スコープ整合性（Issue #1）

対象: `.thread/1/plan.md`（24ステップ・改訂版）/ `.thread/1/adr.md`（ADR-001〜009）
視点: 1周目指摘の実反映、チェックリスト75行のカバレッジ、ID と spec 実体の一致、基準の検証可能性、スコープ整合性

## 突き合わせの方法（前提）

1. Issue 本文の `- [ ]` 行から ID を機械抽出（75件）／plan.md「チェックリスト対応表」の表頭 ID を機械抽出（75件）→ `diff` で**完全一致・重複0**を再確認（欠落0 / 余剰0 / 重複0）
2. 対応表の全ステップ番号（1〜24）と実装ステップ見出しを突き合わせ、改訂後の番号ずれがないか確認
3. plan.md / adr.md 中の「ステップNN」参照 **56箇所すべて**を列挙し、指す先が改訂後の内容と一致するか確認
4. 1周目 coverage の P-001〜004 / S-001〜006 と arch-risk 由来の反映宣言を、plan.md 本文の該当箇所と1件ずつ照合（宣言だけで実体が無いものが無いか）
5. `spec/inventory/{domain,adapter,usecase,frontend,test}.md` の該当行・リンク先 spec 節（`spec/domains/identity.md` / `spec/usecases/identity.md` / `spec/pages/index.md` / `spec/testcases/identity/*.md` / `spec/manual-tests/account.md`）と計画の中身を照合
6. 既存コード（`adapters/d1/repositories/helpers.ts` の `mapDbError` / `constraintViolationCode`）で ADR-008 とテスト表の前提を検証

**1周目指摘の解消状況: coverage P-001〜004・S-001〜006 はすべて解消（未解消ゼロ）。** 詳細は「良い点」に記載。以下は改訂後の計画に対する新規の指摘のみ。

## 問題点（要修正）

- **[P-001]** DOM-identity-006（PlainPassword）の「漏出防止を実装で担保する」部分が実装されないのに、カバレッジ注記に載っていない（DOM-identity-018 と扱いが不揃い）
  - 理由: `spec/inventory/domain.md` の DOM-identity-006 の要点は「8〜128文字を検証（違反は PasswordTooWeak）。**ログ・イベント・永続化への漏出を防止する実装を持つ**」であり、`spec/domains/identity.md#PlainPassword` も「`toString` を無効化するなど漏出防止を**実装で担保する**」と書いている。plan.md 190行目はこれを正面から検討したうえで「ブランド付き `string` のままとし、レビュー観点＋テストで担保する」と結論しており、判断としては妥当（ブランド型に `toString` / `toJSON` は載せられず、spec 自身も「フィールド: `string`（ブランド型）」と書いているので spec 内部に緊張がある）。問題は**その結論が対応表・カバレッジ注記に反映されていない**こと。対応表は `DOM-identity-006 | PlainPassword | 4` と全部入りで書かれ、カバレッジ注記の「明示しておく3点」にも入っていない。一方で同種の部分実装である DOM-identity-018 / ADP-identity-001 は対応表セルとカバレッジ注記の両方に「email 制約側のみ」と明記されている。同じ性質の乖離が片方だけ可視化されている状態で、「75/75 未カバーなし」の宣言と実体に差が生まれている
  - 提案: (a) 対応表の DOM-identity-006 のセルに「**要点のうち「漏出防止の実装」は型で表現できないためテスト＋レビューで代替**（→ 設計節）」を追記し、カバレッジ注記の箇条書きに4点目として同内容を足す。(b) 代替手段を検証可能な形に固定する — テスト方針の `entity.test.ts` には既に「`identity.userRegistered` のペイロードに平文が含まれないこと」があるので、これに加えて「`CurrentUserView` のキー集合に平文・ハッシュが無いこと」（TC-getCurrentUser-003 と同じ表明で足りる）を漏出防止の担保として明示的に紐づける。(c) この spec 字面との差は ADR-008 / ADR-009 と同格の判断なので、spec-sync 対象として1行残す（ADR に起こすか、カバレッジ注記に書くかは任意）

- **[P-002]** ステップ2の分岐(c)の記述が TC-logout-003 の代替検証手段として不正確で、テスト方針（821行）と食い違っている
  - 理由: ステップ2の分岐(c) は「`server-only` を含むモジュールが node プールから import できない場合 → **TC-logout-002 / 003 の自動テスト対象を `presentation/sessionCookie.ts`（フレームワーク import 無しの純関数モジュール）に限定する設計（ステップ14）で回避できることを確認して先へ進む**」と書いている。しかし `sessionCookie.ts` が持つのは `SESSION_COOKIE_NAME` と `buildSessionCookie` だけで、TC-logout-003 が要求する `SystemError` への翻訳は `session.ts`（`server-only` を import する側）の `endSession` にある。つまり `sessionCookie.ts` に限定すると **TC-logout-003 は自動検証できなくなる**。テスト方針 821行には正しい代替（「`endSession` の翻訳部分だけを純関数として切り出してそちらをテストする」）が書かれているので、2箇所で回避策が食い違っている。1周目 P-003 の修正（`setCookieHeader` 注入）と arch-risk P-006 の修正（`sessionCookie.ts` 分離）を別々に取り込んだ結果、接合部だけが古い記述のまま残った形。実装者がステップ2で分岐(c)を踏むと「回避できる」と判断して先へ進み、ステップ23で TC-logout-003 が書けないことに気づく
  - 提案: ステップ2の分岐(c) を「→ TC-logout-002 は `sessionCookie.ts` で担保できる。**TC-logout-003 は `endSession` の `SystemError` 翻訳部分を純関数（例: `sessionCookie.ts` 側の `toSessionSystemError(cause)`）として切り出し、そちらを対象にする**（テスト方針の記述と同じ）」と書き換える。ステップ14の `sessionCookie.ts` の内容欄にも、この切り出しが分岐(c)成立時の受け皿であることを1行足すと、3箇所の記述が揃う

## 改善提案（検討推奨）

- **[S-001]** ステップ24の手動確認リストに `spec/manual-tests/account.md` の **TC-34 / TC-35 / TC-36**（登録の境界値）を加える
  - 理由: この3件はいずれもパスワード登録画面（P-02）だけで完結し、SSO もパスワードリセットも要らない**完全にスコープ内**の手動ケースだが、ステップ24のリスト（TC-01/02/05/06/12/13/14/15/16/19/20/22/23）から漏れている。とくに:
    - **TC-34（7文字 / 8文字）** は Issue の「検証」節が名指しする「**弱パスワード**のエラー表示」の、spec 上の手動検証手段そのもの。現在リストに入っている TC-12 は「必須項目未入力」、TC-13 は「メール形式不正」で、弱パスワードを UI で確認するケースは1件も入っていない（ステップ18の完了条件が文章として拾ってはいるが、手動テストの ID に紐づいていない）
    - **TC-35（128文字 / 129文字）** は、1周目 S-005 を受けて `auth/schema.ts` の上限を 128 → **1024** に変えた判断の**唯一の UI 検証手段**。この変更の目的は「129文字が transport の `validation` ではなくドメインの `PasswordTooWeak`（business）として出ること」であり、自動テスト（`valueObject.property.test.ts` / ユースケース直呼び）は VO 層しか通らないので、変更の効果を検証できない
    - **TC-36（320文字 / 321文字）** も同様に email 上限 1024 の妥当性を UI 側で閉じる
  - この3件を足すと、AC-12 の「メール形式不正・パスワード要件未満は項目ごとに表示」が spec の手動 ID で完全に閉じる

- **[S-002]** TC-registerWithPassword-016（insert DB 例外 → `SystemError`）の失敗注入方法を明記する
  - 理由: テスト表の他の失敗系は注入手段が明記されている（TC-015 = throw するスタブ hasher、TC-loginWithPassword-010 = 「DB を閉じる／不正状態にして」、TC-011 = throw するスタブ hasher）のに対し、TC-016 だけ「統合（ロールバック確認・outbox 空）」で**どう例外を起こすかが未定**。ここは ADR-008 の読み替えと干渉するので、書き方次第で期待が反転する。`adapters/d1/repositories/helpers.ts` を確認したところ `mapDbError` は `SQLITE_CONSTRAINT*` を**すべて** `ConflictError` にし（`constraintViolationCode` は UNIQUE と **PRIMARYKEY を同じ `UNIQUE_VIOLATION`** に潰す）、`SystemError` になるのは制約系以外の失敗だけである。したがって
    - 制約違反（UNIQUE / PK / CHECK / NOT NULL）で例外を起こすと `ConflictError` になり、しかも UNIQUE / PK は ADR-008 の読み替えを通って `EMAIL_ALREADY_REGISTERED` に化けるので、TC-016 の期待（`SystemError`）に**到達しない**
    - 注入は「テーブルを drop / rename する」「DB ハンドルを閉じる」など**非制約系の失敗**でなければならない
  - テスト表の TC-016 の欄に「統合（**非制約系の DB 障害**を注入。制約違反では `ConflictError` になり ADR-008 の読み替えを通ってしまう）＋ロールバック確認・outbox 空」と書いておくと、実装時に取り違えない。あわせて ADR-008 の「読み替えが安全である前提」に `users.id` の PK 衝突も `UNIQUE_VIOLATION` に潰れる（UUIDv7 なので実質起こらない）ことを1行足すと、前提の列挙が閉じる

- **[S-003]** 受け入れ基準表の「対応ステップ」列に、手動検証を担うステップ24を必要な行へ足す
  - 理由: AC-12 は末尾で manual TC-15 を、AC-15 は manual TC-23 を検証条件に含めているが、手動確認が実行されるのはステップ24なのに対応ステップ列は AC-12 = 「18」、AC-15 = 「14, 21」で 24 が入っていない（対応表の PAGE-signup-002 の行は「manual TC-15 → 24」と正しく書けているので、AC 表側だけ追随していない）。S-001 を取り込む場合は AC-12 に TC-34 / 35 も乗るため、AC-12 / AC-15 を「18, 24」「14, 21, 24」にしておくと、基準 → ステップの紐づけが機械的にたどれる

## 良い点

- **1周目 coverage の指摘は P-001〜004・S-001〜006 の10件すべてが実体を伴って反映されている**（宣言だけで中身が無いものはゼロ）。個別に確認した:
  - **P-001** → AC-6 が「翻訳点はアダプターではなく `registerWithPassword` ユースケース境界」に書き換わり、**ADR-008** が新設（Context に遅延バッチ UoW の事実、Decision に前提の JSDoc 固定、Consequences に spec-sync 対象と明記）。スコープ節「含まれないもの」に `SSO_IDENTITY_ALREADY_REGISTERED` 到達不能の項が追加され、対応表の DOM-identity-018 / ADP-identity-001 のセルとカバレッジ注記にも同じ限定が書かれている。**指摘した3点(a)(b)(c)がすべて別々の箇所に落ちている**
  - **P-002** → AC-12 に「送信中はボタン無効＋進行表示となり、連打しても登録は1回だけ実行される（manual TC-15）」、ステップ18に `isPending` によるボタン無効化、ステップ24の手動リストに TC-15、対応表の PAGE-signup-002 に「送信中表示・二重送信防止を含む」。4箇所すべて
  - **P-003** → 設計節に「セッション破棄失敗（TC-logout-003）の扱い」を新設し、`serializeError` が `kind: "unknown"` にフォールバックする事実を根拠として明記。ステップ14に `setCookieHeader` 差し替え引数と `SystemError` 翻訳、ステップ23のファイル一覧に `session.test.ts`、テスト方針に失敗注入の手順。**カバレッジを 74/75 に落とさず自動検証で閉じる**という選択も筋が通っている（ただし → P-002）
  - **P-004** → 「文言を追加するだけでは効かない」という指摘の核心（`business` / `validation` 分岐が code を見ずに `error.message` を返す）が設計節の表として具体化され、`renderValidationMessage` / `renderBusinessMessage` の新設と4コードの日本語文言が確定。ステップ17 / 18の変更内容にも同じ内容が入っている
  - **S-001〜S-006** → 「対象シナリオ ID の読み替え」節の新設（S-AC-02 誤記の明示）、`sessionCookie.ts` の分離、PBKDF2 反復回数のファクトリ引数化＋workerd 実測タスク（ステップ9-1）、「付随実装」表（DOM-identity-004 / 008 / 009 / 014 / 015）、`auth/schema.ts` の上限 1024 化、**ADR-009**（純読み取り UoW）
- **75行のカバレッジは改訂後も機械的に完全**。Issue 側 ID 集合と対応表 ID 集合の `diff` が完全一致（欠落0 / 余剰0 / 重複0）、内訳も 14 + 10 + 4 + 8 + 39 = 75 で宣言どおり。23 → 24ステップの組み替えで対応表が壊れていないことを確認した
- **ステップ番号の追随が完全**。plan.md / adr.md に散らばる「ステップNN」参照56箇所をすべて列挙して指す先を確認したところ、改訂前の番号のまま残っている参照は**1件も無い**（例: 148行「→ ステップ2 / ステップ14」は疎通確認と presentation セッション、adr.md 41行「ステップ3 / ステップ12」は削除と移植で、いずれも改訂後の内容と一致）。大幅な番号組み替えで最も壊れやすい箇所が壊れていない
- **1周目の修正でスコープが膨らんでいない**。新設されたステップ2（捨てテスト1件・確認後削除）・ステップ12（削除した共通基盤テストの `users` への移植）・ステップ15（トークン差し替え）はいずれもチェックリスト ID（ADP-occ-guard-001 / ADP-outbox-001 / PAGE-*）か AC-17 / AC-18 に紐づいており、チェックリスト外の新規機能は増えていない。arch-risk P-005 の推奨案（`PendingBatch` の制約違反ハンドラ新設）を「検証するテストが書けない」を理由に**見送った**判断も、スコープ規律として正しい（見送り理由と移行経路が ADR-008 に残っている）
- **ADP-identity-012（「Argon2id 等でハッシュ化」）と PBKDF2 の差は「見せかけのカバー」ではない**。`spec/domains/identity.md` は「アルゴリズム（Argon2id 等）とパラメータは**アダプター実装の責務**」と明記しており Argon2id を強制していない。ADR-003 が4ランタイム制約・依存ゼロという選定理由と、識別子付きエンコード（`pbkdf2-sha256$<iterations>$...`）による rehash-on-login の移行経路まで書いているので、要点（`SystemError` / タイミングセーフ / 不一致は `false`）は満たされている
- **失敗応答の同一性（TC-loginWithPassword-008）の検証形が spec の意図に忠実**。inventory の「各失敗ケースが同一エラー種別・メッセージで区別不能なら PASS」に対し、計画は「003〜007 の `kind` / `code` / `message` が完全一致することを表明する」と、比較対象の ID まで指定した検証可能な形に落としている
- **ADR-009 の根拠が実装事実で裏付けられている**。「純読み取り UoW はトランザクションを張らない」（libsql の `Pure-read UoW: skip the transaction.` / d1 の `pending.isEmpty()` 分岐）を示したうえで spec の「UoW 不要」との差を spec-sync 対象として残しており、後続レビューでの「spec 違反」誤検出を防いでいる
- **Issue の「検証」節は計画で実現できる**。/signup 登録 → `startSession` → `/`（`_app/index.tsx` の空状態タイムライン）（ステップ18 / 20）、/login のログイン（ステップ17）、`/settings` からのログアウト（ステップ21・spec/pages が P-13 に置いているのと一致し、手動テストの大半が設定画面からのログアウトを手順に含むという根拠も明示）、重複メール（`renderConflictMessage` + `errorField.ts` のログイン導線）・弱パスワード（`renderBusinessMessage`）のエラー表示（ステップ18）。手動テスト TC-01 の SSO ボタン項目との意図的な乖離も、スコープ節・リスク節・ステップ24・PR 説明の4箇所に記録する形で閉じている

## 補足（指摘ではない観測）

- P-001 / P-002 はいずれも「判断そのものは妥当で、記述が1箇所だけ古い / 注記が1行足りない」タイプの指摘であり、設計の作り直しを要求するものではない。計画の骨格（スコープ・ステップ順序・ID 対応）に問題は見当たらない
- `spec/manual-tests/account.md` の TC-37（リセット時の新パスワード境界）と事後処理節（TC-11 でパスワードを戻す）は、パスワードリセット / パスワード変更が本スライス外である以上、実行不能で正しくスコープ外。ステップ24が「SSO / OAuth / パスワードリセット本体に関する TC も対象外として PR に明記する」と包括的に書いているので追加の手当ては不要
