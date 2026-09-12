# plan — fog 実装

- 作業ディレクトリ: `.spec-implement/`（元の指示は `brief.md` 冒頭）
- ブランチ: `feat/spec-implement`
- 全体目標: `spec/` の 39 シナリオ・14 画面・55 ユースケースをローカル実行環境（`pnpm dev` + ブラウザ、`pnpm test`）で端から端まで動かし、統合検証まで受け入れる。外部依存（SSO / メール / AI クライアント）は契約検証（`brief.md`）
- 停滞の目安: 調査・検証フェーズは 15 分、実装フェーズは 45 分（1 フェーズが複数ユースケースを含むため）。既知の長時間処理: `pnpm install` 初回、`pnpm test:integration`（Miniflare 起動）

## 進捗

- 現在のフェーズ: 完了。PH-00〜PH-10 の全 37 項目を受け入れ済み
- done: 37 / 37、review: 0、blocked: 0
- 障害: なし
- 次の一手: なし（終端 done）。残課題は GitHub issue #3〜#21
- 更新: 2026-09-11T16:25:20+09:00

## フェーズ

| ID | 目的 | 依存 | 変更範囲 |
|---|---|---|---|
| PH-00 | 既存コードと実行・検証環境の調査。spec との差分と実装レベルの判断事項を報告 | — | 変更なし（報告のみ） |
| PH-01 | Walking skeleton: 両 DO クラスとスキーマ、登録 / ログイン / ログアウト / getCurrentUser、メモ投稿とタイムライン表示、共通レイアウトと認証ガード | PH-00 | `packages/core/src/{domain,application,adapters/cloudflare}`, `apps/web/app/{routes,components,presentation,worker}` |
| PH-02 | タイムライン完成: 絞り込み / 日付ジャンプ / 位置指定表示、編集、履歴・差分・ロールバック、ソフトデリート | PH-01 | memo ドメイン・ユースケース、P-04 / P-05 |
| PH-03 | ナレッジ: トピック・ドキュメント・出典リンク・リビジョン、P-06〜P-10、メモ側の出典導線 | PH-02 | knowledge ドメイン・ユースケース、documents の FTS5 projection |
| PH-04 | 検索: `search` ユースケースと P-11 | PH-03 | search ドメイン、P-11 |
| PH-05 | ゴミ箱: 一覧 / 復元 / ハードデリート / 空にする / `purge-trash` / 保持期限変更、P-12 と P-13 の保持期限 | PH-03 | trash ドメイン・ユースケース、`purge-trash` ジョブ、P-12 / P-13 |
| PH-06 | 認証の残り: パスワードリセット（Outbox → Queue → mail consumer → DLQ、`sweep-reset-tokens`、P-03）、パスワード変更、SSO 登録 / ログイン / 連携追加・解除（契約検証）、関連 saga ジョブ | PH-01 | identity ドメイン・ユースケース、Identity Directory DO、`queue()` ハンドラ、P-01 / P-02 / P-03 / P-13 |
| PH-07 | AI 接続: OAuth 2.1 認可（P-14）、接続一覧・失効・全失効、MCP / REST の AI API と ai スコープのユースケース配線、ガイダンス提示 | PH-04, PH-05, PH-06 | identity（AiClientConnection）、AI 側 presentation、P-13 / P-14 |
| PH-08 | エクスポート（P-13）と設定画面の完成 | PH-05, PH-06 | export ドメイン・ユースケース、P-13 |
| PH-09 | 鍵ローテーション、saga の終端と回収、operator 専用 maintenance 経路、`reindex` / `migrate-bulk` / `rotate-encryption` | PH-06, PH-07 | Identity Directory / User Data DO のアダプター、maintenance RPC |
| PH-10 | 統合検証: 全マニュアルテスト（`spec/manual-tests/`）のブラウザ実行、`pnpm typecheck && lint && test`、アーキテクチャ監査、docs の現状化 | PH-01〜PH-09 | docs のみ（不具合は各フェーズへ差し戻し） |

## 完了台帳

状態: `pending → in_progress → review → done`（差し戻し `in_progress`、前提崩れ `pending`、`blocked`）。Manager だけが更新する。完了条件は利用者から観測できる結果で書く。検証方法の記号: B = ブラウザ操作、T = 自動テスト（unit / dom / integration）、S = スクリプト（curl / テストクライアント）。

| ID | 要件 / 参照先 | フェーズ | 依存 | 完了条件（観測） | 検証 | 状態 | 根拠 |
|---|---|---|---|---|---|---|---|
| R-INF-01 | `spec/database/index.md`（物理境界・両 DO の全表・lazy migration・OCC）、`spec/async/index.md`（Alarm 多重化） | PH-01 | — | 両 DO クラスが起動時に `_meta.schema_version` を前進させ全表を持つ。`alarm()` が relay pass と job pass を 1 回ずつ実行する。OCC 失敗が `ConflictError("OPTIMISTIC_LOCK_FAILURE")` で境界へ届く | T | done | reviews/PH-01.md（HEAD 5d36a89、2026-09-08T02:55:32+0900 受け入れ） |
| R-INF-02 | `spec/pages/index.md` 共通レイアウト、S-AC-03（元 URL へ戻る） | PH-01 | R-AC-03 | 未ログインで保護画面へ行くと `/login` へ、ログイン後に元 URL へ戻る。ログイン後はナビ（タイムライン / トピック / 検索 / ゴミ箱 / 設定）が出る | B, T(dom) | done | reviews/PH-01.md（HEAD 5d36a89、2026-09-08T02:55:32+0900 受け入れ） |
| R-AC-01 | S-AC-01、`spec/usecases/identity.md` registerWithPassword、P-02、`spec/testcases/identity/registerWithPassword.md` | PH-01 | R-INF-01 | メール + パスワードで登録するとタイムラインへ遷移する。重複メールは案内付きエラー、形式 / 要件未満は項目別エラー。新規登録 saga（`resume-signup`）が完了する | B, T | done | reviews/PH-01.md 再検証（HEAD bb3a1d0、2026-09-08T03:31:08+0900 受け入れ） |
| R-AC-03 | S-AC-03、loginWithPassword、P-01、`spec/testcases/identity/loginWithPassword.md` | PH-01 | R-AC-01 | 正しい資格情報でタイムラインへ、誤りは理由を特定しないエラー。ロックアウト中も応答で区別できない | B, T | done | reviews/PH-01.md（HEAD 5d36a89、2026-09-08T02:55:32+0900 受け入れ） |
| R-AC-04 | S-AC-04、logout、`spec/testcases/identity/logout.md` | PH-01 | R-AC-03 | ログアウト後に保護画面へ行くと `/login` へ | B, T | done | reviews/PH-01.md（HEAD 5d36a89、2026-09-08T02:55:32+0900 受け入れ） |
| R-AC-08 | getCurrentUser、`spec/testcases/identity/getCurrentUser.md`、P-13 表示 | PH-01 | R-AC-03 | 設定画面に email・クレデンシャル一覧・保持期限が出る。検証材料や provider subject は返らない | B, T | done | reviews/PH-01.md 再検証（HEAD bb3a1d0、2026-09-08T03:31:08+0900 受け入れ） |
| R-TL-01 | S-TL-01、postMemo、P-04、`spec/testcases/memo/postMemo.md` | PH-01 | R-AC-03 | 投稿したメモが即座にタイムラインの先頭に出る（楽観 UI）。空文字は投稿不可。失敗時は入力保持 + リトライ | B, T | done | reviews/PH-01.md 再検証（HEAD bb3a1d0、2026-09-08T03:31:08+0900 受け入れ） |
| R-TL-02 | S-TL-02、getTimeline、P-04、`spec/testcases/memo/getTimeline.md` | PH-01 | R-TL-01 | 新しい順に日付見出しでグルーピングされ、無限スクロールで過去分が読める。空は案内表示 | B, T | done | reviews/PH-01.md（HEAD 5d36a89、2026-09-08T02:55:32+0900 受け入れ） |
| R-TL-03 | S-TL-03、jumpToDate / getTimeline(keyword)、P-04、`spec/testcases/memo/jumpToDate.md` | PH-02 | R-TL-02 | キーワードで絞り込みと解除ができ、0 件は表示 + 解除導線。日付指定で該当位置（無ければ最寄り）へ移動する | B, T | done | reviews/PH-02.md 再検証（HEAD 9c90d1b、2026-09-08T11:51:37+0900 受け入れ） |
| R-TL-04 | S-TL-04、editMemo、P-04、`spec/testcases/memo/editMemo.md` | PH-02 | R-TL-02 | インライン編集で保存すると新リビジョンが積まれる。空文字不可、変更なしは積まない、他者編集後は警告 | B, T | done | reviews/PH-02.md（HEAD f43ca7f、2026-09-08T11:39:54+0900 受け入れ） |
| R-TL-05 | S-TL-05、listMemoRevisions / diffMemoRevisions / rollbackMemo、P-05、`spec/testcases/memo/{listMemoRevisions,diffMemoRevisions,rollbackMemo}.md` | PH-02 | R-TL-04 | 履歴が昇順で出て、二点差分と比較元へのロールバック（同内容の新リビジョン）ができる。1 件のみなら差分 / ロールバック非表示 | B, T | done | reviews/PH-02.md（HEAD f43ca7f、2026-09-08T11:39:54+0900 受け入れ） |
| R-TL-06 | S-TL-06、softDeleteMemo、`spec/testcases/memo/softDeleteMemo.md` | PH-02 | R-TL-02 | 確認後にタイムラインから消え、`purge-trash` が保持期限で張られる | B, T | done | reviews/PH-02.md（HEAD f43ca7f、2026-09-08T11:39:54+0900 受け入れ） |
| R-TL-08 | showMemoInTimeline、P-04 位置指定表示、`spec/testcases/memo/showMemoInTimeline.md` | PH-02 | R-TL-02 | 他画面から該当メモへ遷移するとスクロール + ハイライト。不在は通知して通常表示 | B, T | done | reviews/PH-02.md（HEAD f43ca7f、2026-09-08T11:39:54+0900 受け入れ） |
| R-DT-01 | S-DT-01 / S-DT-02 / S-DT-03、createTopic / listTopics / getTopic / updateTopic、P-06 / P-07、`spec/testcases/knowledge/{createTopic,listTopics,getTopic,getTopicName,updateTopic}.md` | PH-03 | R-TL-02 | トピックの作成・一覧・詳細・編集・完了 / 完了解除が動く。完了済みは下部セクションに畳まれ、0 件なら非表示 | B, T | done | reviews/PH-03.md（HEAD 8f5833b、2026-09-08T12:57:13+0900 受け入れ） |
| R-DT-02 | S-DT-04 / S-DT-05、createDocument / getDocument / editDocument、P-08 / P-09、`spec/testcases/knowledge/{createDocument,getDocument,editDocument}.md` | PH-03 | R-DT-01 | 出典メモを選んでドキュメントを作成すると出典リンクが生成される。編集で変更理由付きの新リビジョン、変更なしは積まない、競合警告 | B, T | done | reviews/PH-03.md（HEAD 8f5833b、2026-09-08T12:57:13+0900 受け入れ） |
| R-DT-03 | S-DT-06、listDocumentRevisions / diffDocumentRevisions / rollbackDocument、P-10、`spec/testcases/knowledge/{listDocumentRevisions,diffDocumentRevisions,rollbackDocument}.md` | PH-03 | R-DT-02 | 履歴（誰が・いつ・なぜ）、二点差分、ロールバックが動く | B, T | done | reviews/PH-03.md（HEAD 8f5833b、2026-09-08T12:57:13+0900 受け入れ） |
| R-DT-04 | S-DT-07 / S-TL-07、listDocumentSourceMemos / listDocumentsReferencingMemo、P-04 / P-07 / P-08、ADR-003、`spec/testcases/knowledge/{listDocumentSourceMemos,listDocumentsReferencingMemo}.md` | PH-03 | R-DT-02 | 出典が双方向に辿れる。ソフトデリート済みは「削除済み」表示で遷移不可、ハードデリート済みは非表示 | B, T | done | reviews/PH-03.md（HEAD 8f5833b、2026-09-08T12:57:13+0900 受け入れ） |
| R-DT-05 | S-DT-08 / S-DT-09、trashDocument / trashTopic、`spec/testcases/knowledge/{trashDocument,trashTopic}.md` | PH-03 | R-DT-02 | 確認後にソフトデリート。トピックは配下ごと。削除は完了と並ばない別階層 | B, T | done | reviews/PH-03.md（HEAD 8f5833b、2026-09-08T12:57:13+0900 受け入れ） |
| R-SE-01 | S-SE-01 / S-SE-02、search、P-11、`spec/domains/search.md`、`spec/testcases/search/search.md` | PH-04 | R-DT-02 | キーワードでメモ・ドキュメントを横断検索し、トピック絞り込み、「もっと読む」、結果からの遷移が動く。ゴミ箱内は出ず、完了済みトピックは出る。投稿直後に検索でヒットする | B, T | done | reviews/PH-04.md（HEAD 2f78238、2026-09-08T16:28:33+0900 受け入れ） |
| R-TR-01 | S-TR-01、listTrash、P-12、`spec/testcases/trash/listTrash.md` | PH-05 | R-TL-06, R-DT-05 | 削除済み項目が削除日時・残り日数付きで出る。トピックとセット削除された配下が分かる。空は「空にする」非活性 | B, T | done | reviews/PH-05.md（HEAD 232bebe、2026-09-08T17:20:56+0900 受け入れ） |
| R-TR-02 | S-TR-02、restoreMemo / restoreDocument / restoreTopic、ADR-001、`spec/testcases/trash/{restoreMemo,restoreDocument,restoreTopic}.md` | PH-05 | R-TR-01 | 復元で元の位置 / 元のトピック / 配下ごと戻る。所属トピックがゴミ箱内ならセット復元の確認、ハードデリート済みなら復元先の選択 | B, T | done | reviews/PH-05.md（HEAD 232bebe、2026-09-08T17:20:56+0900 受け入れ） |
| R-TR-03 | S-TR-03 / S-TR-04、hardDeleteTrashItem / emptyTrash、`spec/testcases/trash/{hardDeleteTrashItem,emptyTrash}.md` | PH-05 | R-TR-01 | 確認後に履歴ごと消え、検索にも出典にも出ない。空にするは全件 | B, T | done | reviews/PH-05.md（HEAD 232bebe、2026-09-08T17:20:56+0900 受け入れ） |
| R-TR-04 | S-TR-05、pruneExpiredTrashItems（`purge-trash`）、`spec/testcases/trash/pruneExpiredTrashItems.md` | PH-05 | R-TR-03 | 保持期限を過ぎた項目が Alarm で自動ハードデリートされ、再武装が最寄りの `purge_after` に張られる | T | done | reviews/PH-05.md（HEAD 232bebe、2026-09-08T17:20:56+0900 受け入れ） |
| R-ST-01 | S-ST-01、changeTrashRetentionDays、P-13、`spec/testcases/identity/changeTrashRetentionDays.md` | PH-05 | R-TR-01 | 保持期限を変えると既存項目の残り日数に反映される。範囲外は保存不可 | B, T | done | reviews/PH-05.md（HEAD 232bebe、2026-09-08T17:20:56+0900 受け入れ） |
| R-AC-07 | S-AC-07、requestPasswordReset / executePasswordReset / changePassword、P-03 / P-13、`spec/async/index.md`（`identity.passwordResetRequested`、mail consumer、DLQ）、`spec/testcases/identity/{requestPasswordReset,executePasswordReset,changePassword}.md`、`spec/testcases/async/outboxDelivery.md` | PH-06 | R-AC-03 | 依頼フォームは誰にでも出て応答が同一。開発用 MailSender にリンクが届き、新パスワード設定で新セッションが確立し、完了画面にクレデンシャル一覧と AI 接続の全失効が出る。期限切れは案内。パスワード変更は現在のパスワード必須で、制限中はその旨を明示 | B, T, S | done | reviews/PH-06.md 再検証（HEAD 9ac3024、2026-09-08T21:14:56+0900 受け入れ） |
| R-AC-02 | S-AC-02、registerOrLoginWithSso、P-01 / P-02、`spec/testcases/identity/registerOrLoginWithSso.md` | PH-06 | R-AC-01 | 開発用 SSO アダプターで初回はアカウント作成、2 回目はログイン。既存メールと一致する場合は自動リンクせず案内。キャンセルは初期状態へ | B, T | done | reviews/PH-06.md（HEAD 0f3868e、2026-09-08T20:35:39+0900 受け入れ） |
| R-AC-09 | linkSsoCredential / unlinkSsoCredential、P-13 / P-03、`spec/testcases/identity/{linkSsoCredential,unlinkSsoCredential}.md` | PH-06 | R-AC-02, R-AC-08 | 設定画面から SSO 連携を追加・解除できる。既に使われている主体は案内。最後のログイン手段とメール手段は解除できない | B, T | done | reviews/PH-06.md 再検証（HEAD 9ac3024、2026-09-08T21:14:56+0900 受け入れ） |
| R-INF-03 | `spec/async/index.md` の saga ジョブ（`resume-link` / `resume-credential-change` / `sweep-reservations` / `sweep-orphan-mapping`）、`spec/testcases/recovery/sagaRecovery.md` の前進部分 | PH-06 | R-AC-09 | 各 saga が Alarm 起床で前進し、予約・孤児写像が掃除される。OCC 競合は `terminalReason` に残る | T | done | reviews/PH-06.md（HEAD 0f3868e、2026-09-08T20:35:39+0900 受け入れ） |
| R-AC-05 | S-AC-05、approveAiClientAuthorization / denyAiClientAuthorization、P-14、`spec/testcases/identity/{approveAiClientAuthorization,denyAiClientAuthorization}.md` | PH-07 | R-AC-03 | テストクライアントからの OAuth 2.1 認可要求で認可画面が出て、許可でトークンが発行される。拒否はクライアントへ伝わる。不正要求は許可ボタンなし | B, S, T | done | reviews/PH-07.md（HEAD 3e041c2、2026-09-08T22:23:25+0900 受け入れ） |
| R-AC-06 | S-AC-06、listAiClientConnections / revokeAiClientConnection / revokeAllAiClientConnections、P-13 / P-03、`spec/testcases/identity/{listAiClientConnections,revokeAiClientConnection,revokeAllAiClientConnections}.md` | PH-07 | R-AC-05 | 設定画面に接続（名前・接続日時・最終利用）が出て解除できる。解除後のトークンは認可エラー。全失効は部分失敗でも続行 | B, S, T | done | reviews/PH-07.md（HEAD 3e041c2、2026-09-08T22:23:25+0900 受け入れ） |
| R-AI-01 | S-AI-01〜06 / S-SE-03、AI API 用ユースケース（memo: post_memo / update_memo / recent_memos / get / delete、knowledge: createTopic / updateTopic / listTopics / createDocument / editDocumentByAi / getDocument / trashDocument / trashTopic、search）、`spec/testcases/memo/{post_memo,update_memo,recent_memos,get,delete}.md`、`spec/testcases/knowledge/editDocumentByAi.md` | PH-07 | R-AC-05, R-SE-01, R-TR-01 | テストクライアントで各操作が動き、リビジョンに AI クライアント名が残る。ハードデリート・ゴミ箱・履歴の操作は API に存在しない（型 + 配線分離 + 許可リスト）。ゴミ箱内は見えない。冪等・原子性 | S, T | done | reviews/PH-07.md（HEAD 3e041c2、2026-09-08T22:23:25+0900 受け入れ） |
| R-AI-02 | requirements 4.5「利用できる操作と推奨する振る舞いの提示」、S-AC-05 | PH-07 | R-AI-01 | 接続時にクライアントへ操作一覧とガイダンスが提示される（MCP のツール説明 / instructions） | S | done | reviews/PH-07.md（HEAD 3e041c2、2026-09-08T22:23:25+0900 受け入れ） |
| R-ST-02 | S-ST-02、exportAllData、P-13、ADR-002、`spec/domains/export.md`、`spec/testcases/export/exportAllData.md` | PH-08 | R-DT-02, R-TR-01 | 設定画面から Markdown の可搬形式をダウンロードできる。完了済みトピックを含み、ゴミ箱と履歴は含まない | B, T | done | reviews/PH-08.md（HEAD 28653c9、2026-09-08T23:03:56+0900 受け入れ） |
| R-ROT-01 | `spec/rotation/index.md`、`rotate-encryption`、`spec/testcases/rotation/keyRotation.md` | PH-09 | R-AC-07 | 写像鍵の移送とメール暗号鍵の再暗号化が operator 経路から起動し、2 世代並存の規則を満たす | T | done | reviews/PH-09B.md（HEAD 5667348、2026-09-11T02:28:14+0900 受け入れ） |
| R-REC-01 | `spec/recovery/index.md`（終端モード・後始末の段・材料の寿命）、`finalize-withdrawal` 放棄経路、`spec/testcases/recovery/sagaRecovery.md` | PH-09 | R-INF-03 | 前進不能の saga が `terminalReason` を書いて rollback 段へ入り、材料が無ければ区別して `poison` になる。`poison` は prune されない | T | done | reviews/PH-09A.md（HEAD 6c08553、2026-09-09T20:14:16+0900 受け入れ） |
| R-OPS-01 | `spec/database/index.md`「operator 専用 maintenance 経路」、`spec/async/index.md`（quarantine の一覧・再駆動、DLQ ハンドラ）、`reindex` / `migrate-bulk` | PH-09 | R-AC-07 | quarantined 行の一覧・再駆動・削除、DLQ の再駆動、`reindex` が動く。fail-closed の DO は Alarm を残して次回起床で回復する | T, S | done | reviews/PH-09A.md（HEAD 6c08553、2026-09-09T20:14:16+0900 受け入れ） |
| R-INT-01 | `spec/manual-tests/*.md`（7 カテゴリ 208 ケース）、`CLAUDE.md` の検証手順 | PH-10 | 全項目 | 全マニュアルテストをブラウザで実行して合格。`pnpm typecheck && pnpm lint && pnpm format:check && pnpm test` が成功。アーキテクチャ監査に重大な違反なし。docs が現状を述べる | B, T | done | reviews/PH-10.md 再検証（HEAD fef0e3b、2026-09-11T16:25:20+0900 受け入れ） |

## 実接続の検証手順（契約検証で受け入れた項目の再検証用）

- SSO（Google）: `apps/web/.dev.vars` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` を設定し `SSO_DEV_STUB` を外す → `pnpm test:unit packages/core/src/adapters/sso/__tests__/googleSsoProvider.contract.test.ts`（資格情報が無いと skip を名乗る）→ `pnpm dev` で P-01 / P-02 / P-13 の「Google で続行」を実 IdP で往復し、spec/manual-tests/account.md の SSO ケースを再実行する。IdP 側の redirect URI は `${APP_URL}/auth/sso/google/callback`
- SSO（Apple）: 実アダプターは未実装（issue #9）。開発用スタブでのみ経路を検証済み
- メール（Resend）: `MAIL_PROVIDER_API_KEY` と `MAIL_CONTRACT_TEST_TO`（受信できる宛先）を環境に置き、`MAIL_FROM_ADDRESS` を `wrangler.toml` の `[vars]` に設定 → `pnpm test:unit packages/core/src/adapters/mail/__tests__/resendMailSender.contract.test.ts` → `.dev.vars` から `MAIL_DEV_SINK` を外して `pnpm dev` で S-AC-07 のリセット依頼 → 実メールのリンクで再設定まで確認する
- AI クライアント: `AI_CLIENT_TOKEN_SECRET` を設定した環境で、実 LLM アプリにコネクタとして `${APP_URL}/mcp` を登録（DCR と OAuth 2.1 の認可は `/.well-known/oauth-authorization-server` から辿れる）→ P-14 で許可 → spec/manual-tests/ai.md の S-AI-01〜06 を依頼文から実行する。ローカルでは `apps/web/scripts/ai-client.ts` が同じ経路を検証済み
- デプロイ（対象外）: request Worker のデプロイは issue #3 が解決するまで不能。state Worker 単体は `pnpm deploy:<stage>:state` で可能

## 履歴

- 2026-09-08T01:25+09:00 初版。全 37 項目を `pending` で登録
- 2026-09-08T01:43:02+0900 PH-00 完了。PH-01 の 8 項目を in_progress にして Implementer へ委譲
- 2026-09-08T02:38:11+0900 PH-01 の 8 項目を review へ（Implementer 報告 phases/PH-01.md、HEAD 5d36a89）。Verifier を起動
- 2026-09-08T02:55:32+0900 PH-01 検証（reviews/PH-01.md）。受け入れ: R-INF-01 / R-INF-02（ナビは routeTree に存在する画面だけを出す解釈を採用。5 項目の揃いは R-INT-01 で確認）/ R-AC-03 / R-AC-04 / R-TL-02。差し戻し: R-TL-01（M-1: 封筒でない JSON 500 で楽観エントリが静かに消える）、R-AC-01（M-3: saga_committed を phase 3 で書いており spec/recovery L257 と違う。C-2 予約 TTL 下限の過小評価）、R-AC-08（F-1: NOT_INITIALIZED を gateway で null に畳んでおり spec/usecases/identity.md L687 と違う）。同時に B-1（plain Error → SystemError）、M-4（存在しないテストを名指す JSDoc）、O-5（web の limit 30 → spec 既定 50）を修正。M-5 は CLAUDE.md に宣言済み例外として記載。T-1（OCC の RPC 越え）は PH-02 で固定、T-3（巻き戻しの原子性）と C-3（予約の単一 CAS 文）は PH-06 で扱う
- 2026-09-08T03:18:19+0900 差し戻し 3 項目の修正（ffecad9 / bb3a1d0）を review へ。Verifier に再検証を依頼
- 2026-09-08T03:31:08+0900 PH-01 再検証で R-TL-01 / R-AC-01 / R-AC-08 を受け入れ（reviews/PH-01.md 再検証節）。PH-01 完了 8/8。追加観察の扱い: N-1（失敗後の二重送信）と N-2（rosterGrep の正規表現）は PH-02 で小修正、N-3（spec/usecases/identity.md に印を書く手順が無い）は Manager が spec に反映、docs の乖離は PH-10
- 2026-09-08T03:32:39+0900 PH-02 の 5 項目を in_progress にして Implementer へ委譲（設計 phases/PH-02.md、spec 反映 8737aed / 618d14a）
- 2026-09-08T10:12:27+0900 Fable のレート上限（HTTP 429）で Implementer / Verifier / PH-03 設計ドラフトの 3 エージェントが停止。PH-02 は core 側の未コミット変更（memo ユースケース 7 本 + trashQueryPort + UoW ctx）を残した状態。ユーザー指示「PH-03 まで進める。正規ルートで」。Implementer を Opus で新規起動し、未コミットの作業を引き継いで PH-02 を継続する
- 2026-09-08T10:20:56+0900 ユーザー指示で Opus の Implementer を停止（未コミットの PH-02 作業を追加で残す: memo ユースケース 7 本 + unit テスト 4 本 + DO facade + rosterGrep の N-2）。同じ地点から Fable の Implementer を新規起動
- 2026-09-08T11:12:40+0900 PH-02 の 5 項目を review へ（phases/PH-02.md 実装報告、コミット ef447d3 / 1f3b3dd / f43ca7f）。Verifier を起動
- 2026-09-08T11:23:54+0900 PH-03 △-10: DocumentRepository に listRevisionSummaries（読み取り射影）を採用し listRevisions を置換。spec 反映コミット 121ffe7
- 2026-09-08T11:39:54+0900 PH-02 検証（reviews/PH-02.md）。受け入れ: R-TL-04 / R-TL-05 / R-TL-06 / R-TL-08。差し戻し: R-TL-03（B-1: ジャンプ後に指定日の位置へスクロールしない）。判断: findTimelineAround の戻り値と jumpToDate の出力に pivotId を足す（spec 反映 57e6e54）。A-2 は条件に足さない（観察のみ）、A-1 は PH-10、A-6（末尾改行だけの差分が空）は B-1 と同時に小修正
- 2026-09-08T11:46:21+0900 R-TL-03 の修正（1b34078 / 9c90d1b）を review へ。Verifier に再検証を依頼
- 2026-09-08T11:46:46+0900 PH-03 の 5 項目（R-DT-01〜05）を in_progress にして Implementer へ委譲。R-TL-03 の再検証中は timeline / memo 側の変更を禁止
- 2026-09-08T11:51:37+0900 R-TL-03 再検証合格（reviews/PH-02.md 再検証節）。PH-02 完了 5/5。timeline / memo 側の凍結を解除
- 2026-09-08T12:37:39+0900 PH-03 の 5 項目を review へ（phases/PH-03.md 実装報告、コミット 2c4c8a0 / 4b455cb / 8dc4d10 / c1ae41a / 8f5833b）。A-2（削除済みドキュメントの履歴が読める）は spec/usecases/knowledge.md listDocumentRevisions 手順 2（findByIdIncludingTrashed）どおりで現状維持
- 2026-09-08T12:57:13+0900 PH-03 検証（reviews/PH-03.md）で R-DT-01〜05 を受け入れ。PH-03 完了 5/5。仕上げ: F-1（memoEntry / timelineBoard の dom テストが並列負荷で落ちる）と G-1（insertSourceLinks の chunk を固定するテストが無い）を Implementer に依頼（受け入れ条件外・品質目標のため）
- 2026-09-08T13:01:05+0900 PH-03 仕上げ（849579d: dom テストの waitFor 化、出典 100 件の integration）。Manager が HEAD 849579d で typecheck / lint / format:check / test:unit 73 files 1,229 / test:integration 15 files 70 を再実行して緑を確認。ユーザー指示の到達点（PH-03）で停止し、継続可否を確認
- 2026-09-08T15:34:44+0900 ユーザー回答: PH-04 と PH-05 だけ進める。R-SE-01 を in_progress にして Implementer へ委譲
- 2026-09-08T16:18:01+0900 R-SE-01 を review へ（phases/PH-04.md、コミット a617d4a / 95d6ca6 / 225735b / 120c481 / 2f78238）。Implementer が PH-02 の projection 契機の欠落（メモのソフトデリートで出典先ドキュメントの再射影）を修正 → 受け入れ済み R-TL-06 への影響を Verifier に確認させる
- 2026-09-08T16:28:33+0900 PH-04 検証（reviews/PH-04.md）で R-SE-01 を受け入れ。観察 O-1（半角検索で全角原文の mark 無し）/ O-3（docs/test.md の setupFiles 記述）は PH-10、O-2（カーソル無署名）は AI 経路の PH-07 で HMAC 署名を検討。spec の「署名付き」記述を訂正（077ecf8）。PH-05 の 5 項目を in_progress にして委譲
- 2026-09-08T17:01:48+0900 PH-05 の 5 項目を review へ（phases/PH-05.md、コミット 3d34394 / b30e583 / 75810f3 / 232bebe）。Verifier を起動
- 2026-09-08T17:20:56+0900 PH-05 検証（reviews/PH-05.md）で R-TR-01〜04 / R-ST-01 を受け入れ。PH-05 完了 5/5。R-INF-02 のナビ 5 項目もこれで揃った。ユーザー指示の到達点で停止し、継続可否を確認
- 2026-09-08T18:51:20+0900 ユーザー回答: PH-06 以降を全部進める。PH-06 の 4 項目を in_progress にして Implementer へ委譲
- 2026-09-08T20:03:29+0900 PH-06 実装報告（phases/PH-06.md、HEAD 352fc1d）。判断: MAIL_FROM_ADDRESS は render-wrangler が環境変数から埋める（承認）、URL 由来の SSO 通知の残留は観察、「Apple で続行」は adapter 未実装なので設定済み provider だけを描く修正を検証前に依頼。Apple の実 IdP adapter は未実装（契約検証の対象外。SSO_DEV_STUB で apple の経路は通る）として plan に残す
- 2026-09-08T20:08:20+0900 PH-06 の 4 項目を review へ（コミット 7744a92 / eb2c636 / 671bb4a / 46436e5 / 352fc1d / 0f3868e、spec 反映 f333936）。Verifier を起動
- 2026-09-08T20:35:39+0900 PH-06 検証（reviews/PH-06.md）。受け入れ: R-AC-02 / R-INF-03。差し戻し: R-AC-09（B-1）、R-AC-07（B-2）。判断: B-1 は予約 DTO に saga 種別を持たせ link では resume-signup を投入しない（spec/async の投入点どおり）、B-2 は beginCredentialChange が operation_id を上書きしない形（spec/database の列契約に従う）+ resume-signup が完走済み行を finished にする防御、O-1 はキャンセル時に文言を出さない、G-1 は 4 kind の失敗 → terminal_reason と advanced 分岐をテストに足す
- 2026-09-08T20:44:55+0900 PH-06 差し戻し修正（9ac3024）を review へ。Verifier に再検証を依頼
- 2026-09-08T21:14:56+0900 PH-06 再検証で R-AC-07 / R-AC-09 を受け入れ。PH-06 完了 4/4。O-2（ローカル workerd で Alarm 起床の DO に id.name が無く schema gate が CONFIGURATION_ERROR でループ、通常 RPC も失敗）は spec/database の _meta.self_locator の用途（DO 名が使えない経路のフォールバック）どおり requireSelfLocator を直す。PH-07 の 4 項目を in_progress
- 2026-09-08T22:00:42+0900 PH-07 の 4 項目を review へ（コミット aa64fcb / a0df215 / 50fd460 / e9cf421 / 57f14df / a282bb7 / 3e041c2）。判断: preview の OAuth metadata が APP_URL を指すのは deployed で解消（受け入れ）、refresh 非一回性 + client_id 無期限は D-14 どおりで解除が唯一の停止手段（JSDoc に明記済み）、AI_CLIENT_TOKEN_SECRET の投入は infra 側（対象外）。spec: oauth_consumed_codes を表一覧に追加（3f108df）
- 2026-09-08T22:23:25+0900 PH-07 検証（reviews/PH-07.md）で R-AC-05 / R-AC-06 / R-AI-01 / R-AI-02 を受け入れ。PH-07 完了 4/4。判断: O-1（account.status の検査）は退会が範囲外なので持ち越し（PH-09 の recovery 設計で扱う）、O-2 / O-3 / O-4 は PH-08 で小修正、O-5 の poison 行はローカル状態なので削除。R-ST-02 を in_progress
- 2026-09-08T22:51:45+0900 R-ST-02 を review へ（コミット f77883a / 7135721 / e52f2bc / 48bc003 / 28653c9）。判断: EXPORT_TOO_LARGE を公開 system code とする許可リスト（1 件）は承認、macOS unzip の非 ASCII 問題は PH-10 で manual-tests に補足
- 2026-09-08T23:03:56+0900 PH-08 検証（reviews/PH-08.md）で R-ST-02 を受け入れ。PH-08 完了。観察 O-1（zip の DOS タイムスタンプがプロセス TZ 依存 — JSDoc に限界を足す）/ O-2（/export と MCP の origin 基準の違い）/ O-3（スラッグ末尾の記号）は PH-10 の監査で扱う
- 2026-09-08T23:08:35+0900 PH-09 設計（phases/PH-09.md）の △-0〜△-15 を推奨案どおり決定（design.md D-16）。A/B 分割を採用し、R-REC-01 / R-OPS-01 を in_progress にして PH-09A を委譲
- 2026-09-08T23:35:56+0900 PH-09A の 2 項目を review へ（コミット afca4e7 / ee62636 / b93173c）。判断: purge-user-mappings の運用注意は docs（PH-10）、abandon-account の束縛不一致は ConfigurationError で可、terminal_reason の形と DLQ / OPERATOR_TOKEN は受け入れ時に spec / docs へ反映
- 2026-09-09T19:44:57+0900 セッション再起動。Implementer / Verifier とも停止していたため、PH-09A の Verifier を新規起動。PH-09B の △-16〜19 は推奨案どおり決定（spec/rotation の世代ガードの文を訂正 6c08553）
- 2026-09-09T20:14:16+0900 PH-09A 検証（reviews/PH-09A.md）で R-REC-01 / R-OPS-01 を受け入れ。判断: M-1（list-bucket-user-ids は spec どおりゲートの射程外にする）/ M-2（P-13 は getCurrentUser が失敗してもログアウト導線を描く）/ M-3（束縛不一致は DataIntegrityError）を PH-09B の前に修正、M-5（docs §8 / §10 / §11 の現状化）は PH-10、O-1〜O-7 は PH-10 の監査で扱う。旧 Implementer が停止しているため新規起動
- 2026-09-11T01:45:11+0900 PH-09B の Implementer が Fable のレート上限で停止（M-1〜M-3 は 3c79194 でコミット済み。B の core 側は未コミットで残る）。ユーザー指示「続けて」。未コミット作業を引き継ぐ Implementer を新規起動
- 2026-09-11T02:07:28+0900 R-ROT-01 を review へ（コミット a4c7129 / 3206c06 / 6c75d84）。判断: △-16 は spec 反映済み（6c08553）、△-17 の withdrawal 行を spec/database に反映（1b708f4）、deleteNoopReissueDelayMs 60 s は承認、IMPORT_ROWS_PER_CALL=3 に HTTP 面を揃える
- 2026-09-11T02:28:14+0900 PH-09B 検証（reviews/PH-09B.md）で R-ROT-01 を受け入れ。PH-09 完了。判断: dev の .dev.vars は g3 の状態で残す（DO 状態と整合）、no-op 確定の判定単位（1 巡）は spec に注記、docs は PH-10 で現状化中。R-INT-01 を in_progress
- 2026-09-11T07:03:20+0900 PH-10 の Implementer と補助エージェント 5 本（manual-tests 各カテゴリ）が使用上限で停止（docs 現状化 90281ae / 02676d3 と監査の小修正 9f5671e はコミット済み。マニュアルテストの結果は未報告）。上限解除後に Implementer を新規起動して続行
- 2026-09-11T09:18:19+0900 PH-10 の Implementer（a72e…）と補助エージェント（account 実走）が Fable の月間上限で停止。途中報告の内容: HEAD 9f5671e で全テスト 1 回目緑（unit+dom 126 files / 1,590 + 2 skipped、integration 32 files / 189）、監査 11 観点は重大な違反なし（軽微 4 件は issue 候補）、timeline.md は合格 32 / 不合格 1（TC-21 → 9bec53e で修正）/ 保留 3 / 未実施 1、account / document は実走途中で結果未記録、search / trash / ai / settings は未着手。PH-10 実装報告は未記入。ユーザーに状況を報告
- 2026-09-11T12:00:31+0900 モデルを Opus 5 に切り替えて PH-10 の Implementer を新規起動（前任の途中報告 = timeline 32/1/3/1、監査は重大違反なし・軽微 4、テスト 1 回目緑を引き継ぎ情報として渡した）。残っていた workerd プロセスを停止
- 2026-09-11T12:29:24+0900 PH-10 判断: 空入力の送信時エラー表示と検索チップの current 表示の修正を承認、P-07 は「完了」をヘッダーのボタンに出しメニューは編集 / 削除（requirements 4.2 / spec/pages 優先、design HTML に注記）、TC-11 の期待を Markdown の規則（3 行目は h1）に訂正（d31f2eb）
- 2026-09-11T13:19:30+0900 PH-10: account TC-46 手順 6 を spec/async（DLQ 自動 1 回、手動の再駆動口なし）に合わせて訂正（acc356f）。途中経過: ai 23/23、search 23/23、document 41/41、timeline 37/37、settings 12/12、trash 25/25、account は TC-46 / 47 以外合格。監査の修正 425f36b（presentation が adapter を名指さない）
- 2026-09-11T14:05:37+0900 PH-10 実装報告受領（HEAD 7446b5e）: マニュアル 208 中 207 合格・1 部分実施（account TC-47、integration で代替固定）、最終テスト 2 回連続緑（unit+dom 129 files / 1,598 + 2 skipped、integration 32 / 191）、監査は重大違反なし。判断: issue 起票はユーザー確認後に Manager、削除済みメモの文言は requirements どおり「削除済みのメモ」に揃える（デザイン HTML は c2d36f0、実装は Implementer）、CLAUDE.md の AiTokenCodec 追加は承認
- 2026-09-11T14:08:32+0900 文言修正（実装 c1f3366、spec/mock.html も訂正）。R-INT-01 を review へ。Verifier を新規起動（Opus）
- 2026-09-11T14:54:43+0900 PH-10 検証（reviews/PH-10.md）: 条件 1〜3 合格（94 ケース抜き取り再実行、テスト 2 回連続緑、監査に重大違反なし）、条件 4（docs）不合格で差し戻し。判断: M-1 は D-1 にテストを実際に足す、M-2 の TC-47 部分実施は brief の契約検証の方針どおり代替検証（integration）で受け入れ、M-3 の issue 起票はユーザー確認後、M-4 は spec 反映（f3b09af）、M-5 は受け入れ
- 2026-09-11T16:13:37+0900 ユーザー承認（全部起票）により GitHub issue #3〜#21 の 19 件を起票（検索カーソルの署名は D-14 で閉じた決定、出典の後付けは spec の意図、40 万字の編集画面は再現せず、の 3 件は起票しない）。D-1〜D-6 の修正（eb1a084: タイムラインの実行計画テスト追加 + カーソル条件を行値比較に修正、f47777c: docs 訂正 + knowledgeFeeds.dom）を受領。docs に issue 番号を戻す作業を Implementer に依頼
- 2026-09-11T16:15:05+0900 R-INT-01 の差し戻し修正（eb1a084 / f47777c / fef0e3b）を review へ。Verifier に再検証を依頼
- 2026-09-11T16:25:20+0900 R-INT-01 を再検証で受け入れ（reviews/PH-10.md 再検証節: 条件 1〜4 合格、テスト 2 回連続緑 unit+dom 130 files / 1,601 + 2 skipped・integration 33 / 195、タイムラインのカーソル変更は dev で全件照合）。全 37 項目 done。実接続の検証手順を記入。status.json の terminal を done に設定
- 2026-09-11T19:04:12+0900 ユーザー指示で feat/spec-implement を origin/main へ fast-forward（3f7c501..fef0e3b）。main の CI（run 34587246414）は 3 ジョブとも success
