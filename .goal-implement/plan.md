# fog 完了台帳

## 全体目標と現在地

作業場所は `.goal-implement/`、元の依頼は会話の `$goal-implement` と [brief.md](brief.md)。品質目標は extremely well。対象は spec/requirements.md の全機能と関連シナリオの統合検証。

更新: 2026-09-05T23:53:43+09:00。P5 は独立検証に基づきローカル実装・統合を受け入れ。done 18 / 22、外部検証待ち4。R19/R20/R21 は実Google・外部SMTP・クラウド保存/復元が未検証のため blocked。R22 はそれらの検証待ち。未コミット変更を保持する。

P2/P3/P4a は reviews/ の独立報告に基づき done。P4b は [UI/adapter](reviews/P4b.md) と [core](reviews/P4b-core.md) のlocal PASS。P5 は [統合検証](reviews/P5.md) と [運用・復元](reviews/P5-operations.md) のlocal PASSを受け入れた。外部設定に依存しない実装と検証は完了。全体 goal は本スレッド `01a07103-8e9a-7490-9528-0b3a0557d645` で blocked（API照会で確認）、予算指定なし。再開条件は末尾に記録する。

進捗停滞の目安は15分。日時は実時刻で判断する。閾値を超えたら試行・証拠・障害・次の一手を報告し、再計画する。Manager が全体 goal と本台帳を管理し、Implementer はフェーズ報告だけを更新する。

## フェーズ

| フェーズ | 目的 | 依存 | 変更範囲 |
| --- | --- | --- | --- |
| P1 | 登録からメモ保存・再表示まで開通 | なし | 認証基盤、メモ投稿/一覧、Node DB/DI、共通シェル |
| P2 | トピックと文書、出典、編集履歴 | P1 | コンテンツ domain/application/adapters と対応画面 |
| P3 | 検索と人間の復元・削除・データ管理 | P2 | 共通検索、ゴミ箱、設定、期限 worker、export |
| P4 | AI 認可 API と SSO・アカウント復旧 | P3 | API 境界、認可、冪等性、OAuth、メール、設定 |
| P5 | 統合・運用・ブラウザ検証 | P4 | 起動手順、クラウド構成、バックアップ、全体修正 |

## 完了項目

| ID | 要件・原文 | Phase / 依存 | 観測できる完了条件と検証 | 状態 | 根拠・障害 |
| --- | --- | --- | --- | --- | --- |
| R01 | §5.1/5.2、S-AC-01/03/04 | P1 / なし | 登録・ログイン・ログアウト・保護 URL 復帰をブラウザ確認。不正入力を拒否 | done | [P1](phases/P1.md) |
| R02 | §5.1/5.2 | P1 / R01 | 別ユーザーの ID を用いた読み書きを拒否。未認証 API も拒否する統合テスト | done | [P1](phases/P1.md) |
| R03 | §4.1、S-TL-01/02 | P1 / R01 | メモ投稿が日付別一覧に即反映し再読み込み後も残る。空・pending・失敗時の入力保持を確認 | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R04 | §4.1、S-TL-02/03 | P2 / R03 | 過去メモを追加読込でき、キーワード・日付ジャンプ・ID 位置指定が動く | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R05 | §4.3、S-TL-04/05 | P2 / R03 | 編集・競合警告・任意二点差分・新リビジョンによる復元。無変更・空本文規則をテスト | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R06 | §4.2、S-DT-01/02/03 | P2 / R02 | トピック作成・編集・完了/解除・完了セクション・詳細が再読み込み後も保持 | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R07 | §4.2、S-DT-04/05 | P2 / R06 | 所属必須の文書作成と Markdown 閲覧・編集が動く。不正参照は原子的に拒否 | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R08 | §4.1/4.2、S-TL-07、S-DT-07 | P2 / R07 | 出典を UI で選択し双方向遷移、最新メモ表示、関連メモ一覧が動く | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R09 | §4.3、S-DT-05/06 | P2 / R07 | 誰・いつ・なぜの履歴、二点差分、競合警告、非破壊 rollback を確認 | done | [P2](reviews/P2.md)・[core](reviews/P2-core.md) |
| R10 | §4.3、S-TL-06、S-DT-08/09、S-TR-01 | P3 / R08 | 三種のソフト削除とセット関係、削除済み出典表示、ゴミ箱の残日数が正しい | done | [P3](reviews/P3.md)・[core](reviews/P3-core.md) |
| R11 | §4.3、S-TR-02 | P3 / R10 | 個別・セット・孤立文書の復元、出典再接続、先行削除文書を復元しないことを確認 | done | [P3](reviews/P3.md)・[core](reviews/P3-core.md) |
| R12 | §4.3、S-TR-03/04 | P3 / R10 | 確認つき個別完全削除・空にするで履歴とリンクも消える | done | [P3](reviews/P3.md)・[core](reviews/P3-core.md) |
| R13 | §4.3、S-TR-05、S-ST-01 | P3 / R12 | 保持期限が既存項目にも適用。worker がアクセスなしで期限切れだけ削除。時計テスト | done | [P3](reviews/P3.md)・[core](reviews/P3-core.md) |
| R14 | §4.4、S-SE-01/02/03 | P3 / R08 | 日本語を含む横断全文検索、即時反映、完了含む、ゴミ箱除外、topic 絞込、安定追加読込 | done | [P3](reviews/P3.md)・[core](reviews/P3-core.md) |
| R15 | §5.3、S-ST-02 | P3 / R07 | ダウンロードした可搬データに最新・完了済みが含まれ、ゴミ箱・履歴が含まれない | done | [P3](reviews/P3.md)・[core](reviews/P3-core.md) |
| R16 | §4.5/5.2、S-AC-05/06 | P4 / R01 | クライアント起点の許可/拒否、不正期限切れ拒否、接続一覧・失効後拒否を E2E 確認 | done | [P4a](reviews/P4a.md)・[core](reviews/P4a-core.md) |
| R17 | §4.5、S-AI-01〜06 | P4 / R14,R16 | AI 読み書き全操作、部分編集・明示 rewrite、理由必須、原子性・冪等性、同じ検索仕様をテスト | done | [P4a](reviews/P4a.md)・[core](reviews/P4a-core.md) |
| R18 | §4.3/4.5/5.2 | P4 / R17 | AI がゴミ箱・履歴・復元・完全削除へアクセスできない。cookie 経路への迂回も拒否 | done | [P4a](reviews/P4a.md)・[core](reviews/P4a-core.md) |
| R19 | §5.2、S-AC-02 | P4 / R01 | SSO 初回/再ログイン・明示連携・解除・最後の手段保護・一意性を検証 | blocked | [P4b local PASS](reviews/P4b.md)・[core](reviews/P4b-core.md)。実サービス設定/検証待ち |
| R20 | §5.2、S-AC-07 | P4 / R16,R19 | 変更・メール復旧・単回期限・同一応答・旧 session/指定 AI 失効・復旧後解除導線を検証 | blocked | [P4b local PASS](reviews/P4b.md)・[core](reviews/P4b-core.md)。実サービス設定/検証待ち |
| R21 | §5.3 | P5 / P4 | クラウド保存構成、起動・env・migration・backup/restore 手順と復元訓練 | blocked | [運用・復元 local PASS](reviews/P5-operations.md)。実クラウド保存/PITR/別保管先の検証待ち |
| R22 | 全要件、design/ | P5 / R01〜R21 | build/typecheck/lint/format/unit/integration 成功、主要 UI を PC/スマホのブラウザで操作、未接続操作なし | blocked | [統合 local PASS](reviews/P5.md)。必要checks・production PC/mobile合格。R19/R20/R21の外部検証待ち |

原文はすべて `spec/requirements.md` と `spec/scenario/`。Phase レポートには実行日時、コマンドと結果、コミット ID、未コミットを含む対象ハッシュ一覧を付ける。完了候補は review を経て Manager が done にする。

## 受け入れ履歴

- 2026-09-05T23:53:43+09:00: docs訂正後の368対象一致と、他367対象不変を両Verifierが確認。最終manifest SHA-256は `291908bf77de6e5a72c8afdf719adf69b55527785420b81775dd15d73564df24`。主Implementerと両Verifierの書込み・操作停止を確認し、P5 local PASSを確定。外部設定と必要な実行許可を再開条件として残す。

- 2026-09-05T23:52:13+09:00: P5のローカル範囲を受け入れ。[統合](reviews/P5.md)と[運用・復元](reviews/P5-operations.md)の独立PASS、368対象一致、unit75/integration85と必要checks、production PC/mobile、backup既存10/独立追加4、launcher/worker独立6を確認。R19〜R22を外部検証待ちblockedとし、全体完了にはしない。CLIの.env説明だけを訂正し、最終docs-only差分を独立照合する。公開・本番deployは対象外であり追加の完了条件にしない。

- 2026-09-05T23:29:07+09:00: P5候補/368対象hashを受領、R21/R22をreview。全実装担当停止を確認。Node統一・unit75/integration85/必要checks・production PC/mobile・24table両restore・無HTTPmail/drain・原文22対応を最終独立検証へ渡す。外部Google/SMTP/cloudは未検証のまま。報告内docs相対リンクだけ担当へ訂正依頼し、製品コード凍結は維持。

- 2026-09-05T22:41:28+09:00: P4bのlocal実装を独立UI/core根拠で受け入れ。R19/R20は実サービス未検証のためblockedへ移しdoneに含めない。177対象一致、unit131/Node105/CF70/必要checks、focused22/HTTP21/独立core75+5を確認。外部依存と独立してR21/R22のP5準備・統合検証を委譲。goal APIはactiveを維持。

- 2026-09-05T22:25:41+09:00: ユーザーの続行指示を受領し継続。P4bローカル候補と177対象hash、unit131/Node105/CF70/必要checks・OIDC/SMTP/ブラウザ根拠を受領。主/補助担当の停止を確認しR19/R20をreview。実Googleと外部SMTPは未検証のため、全体doneにはしない。独立UI/adapterとcore検証へ委譲。

- 2026-09-05T21:14:22+09:00: R16〜R18をdone。UI/HTTPとcoreの独立PASS、142対象一致、必要checksを確認。同portのlocal callback単発失敗は同条件再試験で正常・原因未確定の観測として保持し、製品受入阻害とはしない。R19/R20をin_progressとしてP4bを委譲。

- 2026-09-05T21:03:19+09:00: P4a候補と142対象hashを受領しR16〜R18をreview。主/補助担当のcompletedと書き込み停止を確認。認可・API・履歴/人間復元・並行/再起動/失効・権限迂回、unit109/Node84/CF70/必要checksの根拠を独立検証へ委譲。

- 2026-09-05T20:29:47+09:00: R10〜R15をdone。UI/workerとcoreの独立PASS、122対象一致、必要checksと実download・削除/復元・HTTPなしworker証跡の適用を確認。P4をAIのP4a(R16〜R18)とアカウントのP4b(R19/R20)へ分け、P4aを委譲。元要件と全22項目の範囲は維持。

- 2026-09-05T20:17:11+09:00: P3完了候補と122対象hashを受領し R10〜R15 を review。主担当と補助core担当のcompleted・書き込み停止を確認。unit100/Node62/CF70/型/lint/format/build、ブラウザとHTTPなし起動・周期workerの根拠を独立Verifierへ引き継ぐ。

- 2026-09-05T20:02:18+09:00: P3中間報告。検索69件の追加取得・topic scope・完了含有、先行個別削除を除くセット復元、親完全削除後の既存/新規topicへの孤立文書復元がブラウザ成功。core32 integration/worker2件成功。出典墓標・設定/export・無HTTP workerと全体checksは継続。受け入れ状態は変更しない。

- 2026-09-05T19:43:48+09:00: R03〜R09 を done。UI/presentation と core の独立合格、96対象一致、unit98/Node integration46/型/lint/format/buildの適用を確認。日付inputから遷移・近傍表示は合格し、ブラウザ内蔵pickerの内部操作は製品未検証に含めない。P3 R10〜R15を in_progress。

- 2026-09-05T19:30:15+09:00: P2完了候補を受領し R03〜R09 を review。unit98/Node integration46、型・lint・format・build成功とブラウザ根拠を確認。96対象の照合と独立操作をVerifierへ委譲。実装担当の書き込み・環境操作停止を確認。

- 2026-09-05T19:23:00+09:00: 15分の区切りで Implementer の中間報告を受領。SSR修正の回帰2件と主要履歴・競合・出典・65件読込・offline再試行が成功。残る操作確認と型修正・最終checksの見込み10分。R03〜R09は引き続き未受け入れ。

- 2026-09-05T19:07:44+09:00: Verifier の再開照合を受領。92 対象一致と B-P2-01 再現を確認し、R01/R02 を維持、R03 を in_progress。R03〜R09 の残作業を Implementer に委譲。検証担当の操作停止とブラウザ・サーバー移管を確認。

- 2026-09-05T19:03:51+09:00: 再開依頼を受領。旧担当は本スレッドから操作できず、停止記録を保持したまま新 Verifier に照合を委譲。全体 goal を本スレッドへ設定。受け入れ状態は変更しない。

- 2026-09-05T18:58:26+09:00: 全3サブエージェントのcompletedと書き込み停止を確認。P2報告の全92対象のSHA-256/削除状態が現在コードと一致。P2を未受け入れで保持。B-P2-01がP1の再読込後操作へ影響するためR03をpendingへ戻す。P1の元の検証根拠は保持。

- 2026-09-05T18:53:52+09:00: ユーザーが新スレッドへの引き継ぎと停止を指示。P2 を未受け入れのまま停止し、P3 へ進まない。全 agent に実装・追加検証の停止を通知。goal は未完了の active を保持し、complete/blocked へ変更しない。

- 2026-09-05T18:30:00+09:00: R01/R02/R03 を done。型・lint・format・build、unit91/Node integration35、実ブラウザの正常/異常系を受け入れ。R04〜R09 を P2 in_progress。

- 2026-09-05T18:29:30+09:00: R01/R02/R03 を review。報告対象56ファイルのSHA-256/削除状態が現在コードと一致。差分、所有者scope、transaction、エラー境界、テストとPC/スマホ画像を照合。

- 2026-09-05T18:07:20+09:00: 要件と実装の照合を開始。既存管理ファイルなし。

## P2 の受け入れ範囲

対象は R03〜R09。P2 は独立検証に基づき受け入れ済み。メモ・トピック・ドキュメント・出典・リビジョンの永続契約と、対応する画面を実装する。後続 P3 の削除・検索と P4 の AI 操作が同じ application 契約を利用する。

- R04: 追加読込の順序と重複/欠落、日付が空のときの近傍ジャンプ、古いメモ ID の直接表示を確認する。短いメモとコード/箇条書きの安全な表示を含む。
- R05/R09: 無変更保存、空入力、同時編集警告、確認後保存、履歴の線形保持、任意二点の差分、旧版を複製する復元を UI と実 DB で確認する。
- R06/R07: トピック作成から文書保存・再表示までブラウザで通す。完了と解除、所属必須、別所有者/不在の所属・出典参照の拒否を確認する。
- R08: メモを検索・選択して出典にし、両方向の遷移とトピック関連メモに反映する。出典は編集後の最新内容を指す。
- 共通シェルに本接続のトピック導線を追加し、既存モックのシート・ボタン・モバイルナビ・トークンへ整合する。

P2 の変更後に typecheck/lint:fix/format、関連 test、build と PC/スマホ主要ブラウザフローを検証する。P1 の認証を変更しない場合、全 P1 検証の反復は不要。検証対象と依存する変更を識別して報告する。

## 前回の再開手順

以下の再開照合と P2 修正・検証は完了済み。最初の操作は B-P2-01 のSSR生HTML・DOM・再現scriptを読み、サーバーのSerialization errorログとPromise settlementの終了経路を確認すること。旧 agent の ID や exec session は新スレッドで再利用できると仮定しない。brief/design/本台帳/P1/P2 報告を読み、コードのハッシュ・稼働プロセスを照合する。P2 の既知不具合と未検証項目を解消し、Manager が受け入れてから P3 へ進む。

P1 の結果は当時のスナップショットに対する受け入れであり、P2 で変わった共通ファイルにそのまま適用しない。P2 最終コードの typecheck/lint:fix/format、関連 unit/Node integration/build、未検証ブラウザフローを実施する。外部サービスの実検証が残る場合は全体完了にしない。

## 停止時の引き継ぎ

- 全体 goal: 元スレッド `01a070d1-348c-7d41-ba6f-40c66b977237` で active。ユーザー停止であり、達成・外部障害による blocked ではない。予算指定なし。
- 基準 commit: `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。実装・削除・新規ファイルはすべて未コミットで保持。commit/reset/stash/clean は行わない。
- 外部設定: `apps/web/.env` は既存 DATABASE_URL/APP_URL を保持。Google OAuth・メール配送・クラウド DB の設定先をユーザーへ非同期質問済み、停止時点で未回答。秘密値は取得・出力していない。
- 現在の重要不具合 B-P2-01: 直接URLアクセスでRSCのcontent Promiseの解決通知とFlightデータが届かず、SSR表示はあっても履歴・タイムラインの操作がhydrateされない。クライアント遷移は動く。dev再起動後も再現。原因は未確定。再現資料と次の調査箇所は [P2](phases/P2.md)。
- 現在の不具合・注意 B-P2-02: P2 の追加読込済みメモを編集して keyword 不一致になった際の一覧残留を指摘し、filter 修正が入った。最終再現検証の状態は P2 報告で確認する。Markdown の HTML 風文字列消失は skipHtml を除去する修正、変更理由の複数行受理は改行拒否の修正が入った。P2 全体の最終検証は未完了。
- 後続の安全境界: AI に人間用の削除済み出典 DTO を返さない。AI の全文置換は明示 rewrite に限定。P3 のセット削除は先行個別削除を巻き込んで復元しない。
- 停止時プロセス: 2026-09-05T18:53:52+09:00 に Node PID `63055` が `http://localhost:3000` を listen。最終サーバー・ブラウザ状態と全 agent 停止確認は P2 報告および下の確認記録を正本とする。

### 最終停止確認

2026-09-05T18:58:26+09:00 に Manager が確認。

| 対象 | 状態 |
| --- | --- |
| implementer | completed。コード書き込み停止、P2引継ぎ記録完了 |
| implementer/p1_web | completed。SSR調査・書き込み停止を明言 |
| implementer/p2_core | completed。実行中操作なし、追加書き込みなし |
| ブラウザ | fog-p2 をclose/cleanup済み。停止前は /topics、Aでトピック作成後。P2-stopped.pngを保存 |
| サーバー | localhost:3000を維持、PID63055、元スレッドexec14800。新スレッドではport/processから再確認 |
| 作業ツリー | 未コミット変更を保持。P2.mdの92対象hash/削除と一致 |
| goal | activeの未完了を保持。APIにpause操作はないため状態変更なし |

最後の成功チェックはunit96件・Node integration46件・typecheck/lint/format。ただし後続のkeyword filter修正を含む最終コードでは未再実行。build成功も途中スナップショットに対する結果で、最終コードのbuildは未検証。P2の画面E2E・PC/スマホ最終確認は未完了。この節は前回停止時の記録。現在の進行状態は冒頭を正本とする。


## P3 の受け入れ範囲

P3 の R10〜R15 は独立検証に基づき受け入れ済み。対象は共通検索、三種のゴミ箱、保持期限設定と自動削除、最新データのエクスポート。

- R10/R11: メモ・文書・トピックを削除し、双方向の出典表示とセット関係を確認する。文書からのセット復元には確認を出す。先行個別削除を維持し、所属トピックを完全削除された文書は既存または新規トピックを選んで復元できる。
- R12/R13: 完全削除は確認後に履歴・リンクも消去する。トピックの確認には対象となるセット文書を示す。期限変更は既存ゴミ箱にも適用し、worker がアクセスなしに期限切れだけを処理する。完了済みトピックは期限削除しない。
- R14: メモ・文書を単一の全文検索で探す。空キーワードでは検索しない。日本語、即時反映、完了済みを含む結果、ゴミ箱除外、トピック配下文書と出典メモの絞り込み、追加取得の安定性を確認する。検索結果は原文のスニペットと事実情報のみ返す。
- R15: 設定画面から生成中表示を経て可搬ファイルを取得する。全所有データの最新状態と完了済みを含み、ゴミ箱・履歴・他利用者データを含まない。

全操作を人間用 UI と実 DB で確認し、後続 AI 用 API に人間専用の履歴・ゴミ箱 DTO を転用しない。P3 の詳細契約は P2 受け入れ後に Implementer が具体化する。

## P4 の受け入れ範囲

P3 は受け入れ済み。P4a は R16〜R18、P4b は R19/R20。P4a の完成・独立受け入れ後に P4b を開始する。AI 認可の PKCE S256・登録済み redirect URI・単回 code 方針は design.md を使う。Google OAuth・メール配送・クラウドの開発設定先は未回答。資格情報に依存しない実装とローカル試験を先に完了し、実サービスの未検証を区別する。

- R16: クライアントから認可を開始し、ログイン・権限表示・許可または拒否を経てクライアントへ戻る。改ざん・期限切れ・不正redirect・code再利用・PKCE不一致を拒否する。設定で名前・接続日時・最終利用と失効を確認する。
- R17/R18: 許可した読み書き操作だけを明示的に公開し、検索仕様を共用する。文書部分編集の不一致・曖昧一致・版競合と理由省略は原子的に拒否する。全面書き直しは明示操作とする。同一keyの同一要求は重複更新せず、違うpayloadを拒否する。失効は毎回確認し、再応答からも削除済み内容・タイトル・履歴を漏らさない。AI credential を人間用cookieの代わりに使う迂回を拒否する。
- R19: Google SSO の初回/再ログイン、明示連携、解除、最後の手段保護を確認する。SSO主体とメールの両方の一意性を保ち、自動リンクを行わない。
- R20: 期限付き単回のメール復旧、現在password確認による変更、旧session全失効と新session確立を確認する。リセット完了後は認証手段とAI接続一覧・すべて失効を同画面へ出す。前回リセット以降のAI接続を自動失効する。未登録/SSOのみ/制限中の復旧応答を同一にし、SSOのみの利用者へpassword変更を出さない。

メールは開発用のローカル受信環境で確認する。実際の外部メール送信と本番公開は実行範囲外。Google とクラウドは既存の開発環境が指定されるまで資格情報を推測せず、本接続の未検証を残す。

## P5 の受け入れ範囲

P4b の実装と可能な独立検証が揃った後、実Google・実メール等の外部依存とは分けて R21/R22 の準備とローカル統合検証を進める。外部依存が残る R19/R20/R21 と、それらに依存する全体 R22 を全完了にはしない。

- Node.js + libSQL の製品配線、起動・env・migration・本番build/start・worker・停止手順をREADMEと運用文書にまとめる。既存規約に従い、採用しないランタイムとテンプレート専用の公開導線・設定を整理する。元のspec・モック・ユーザーの設定とテストデータは保持する。
- クラウドlibSQL構成、資格情報の設定先、バックアップ取得・保持・復元手順を準備する。ローカルの一貫したバックアップを別DBへ復元し、現在データ・履歴・出典・認証状態・AI冪等性に必要な永続情報を確認する。実クラウド保存/復元の未検証を区別する。
- 統合後の必須build/typecheck/lint/format/testを実行し、production buildの実サーバーで主要シナリオをPC/スマホから操作する。既存の合格根拠と最終コードの適用範囲を独立Verifierが照合し、変更された領域の回帰を検証する。
- 原文全要件と台帳R01〜R22を照合し、必須操作の仮実装・未接続・未検証・外部依存を明記する。ローカルfixtureを本Google/クラウド/外部メールの合格根拠へ置き換えない。

## 外部検証からの再開

ローカルの実装・統合・復元検証は完了。再開時は本台帳、[P5統合](reviews/P5.md)、[P5運用](reviews/P5-operations.md)、[最終対象hash](phases/P5-target-hashes.json)を読み、対象と稼働プロセスを照合する。過去のP2停止記録から作業をやり直さない。

| 残項目 | 必要な設定と実行範囲 | 検証 |
| --- | --- | --- |
| R19 | 使用可能なGoogle client設定の場所、登録済みcallback、検証用アカウント。条件が合えばlocalhostで実施可能 | 実Googleの初回/再ログイン、明示連携、解除、取消・失敗 |
| R20 | 使用可能なSMTP設定の場所、送信元・検証用受信先、外部テストメール送信の明示許可 | TLS/認証、実受信メールからの単回復旧、session/AI失効 |
| R21 | 非公開のcloud libSQL URL/token設定の場所、復元先と別保管先、必要なDB作成/保存の許可範囲 | migration/読み書き/transaction、PITRから別DBへ復元、内容・履歴・出典・認証と保持契約 |
| R22 | R19〜R21の検証根拠 | 全要件への適用を独立照合し、全体受け入れ |

秘密値は会話や証跡へ転記せず、指定された環境から利用する。本番公開・deployは依頼範囲外。外部サービス設定がない状態で、同じローカル試験を繰り返して全体完了にしない。

運用手順は [README](../README.md)、[Node](../docs/runtime_node.md)、[アカウント](../docs/account_access.md)、[AI接続](../docs/ai_client.md)、[バックアップ・復元](../docs/backup_restore.md)。初回はREADMEのinstall/env/migrationを実施して `pnpm dev`。既存buildは `pnpm start` で起動する。

最終ブラウザ確認時の `http://localhost:3000` はproduction PID24961 / exec2383、local account fixtureはPID2466 / exec43141（OIDC3457・SMTP1025・mailbox8025）。browserとAI callback3456、復元3001、worker試験3002は終了。新スレッドではPIDと所有者を再確認し、exec IDを再利用できると仮定しない。P5独立検証のメモと文書履歴を保持し、検証用AI接続は全失効済み。ユーザーの.env・DB・spec・モックと未コミット変更は保持する。
