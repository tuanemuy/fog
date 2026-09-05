# 再開時の独立照合

照合日時: 2026-09-05 19:03〜19:08 JST。対象: P2 停止時スナップショットと R01〜R09。製品コード、brief/design/plan は変更していない。

## 対象と環境

- HEAD は `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。
- P2 報告の 92 対象は SHA-256 と削除状態がすべて一致。管理資料を除く未コミット変更の未記載ファイルはない。
- P1 の 56 対象のうち 41 は同一、15 は P2 で変更。認証 UI、auth/security 境界と既存認証テストは同一。services/UoW/schema、共通シェル、timeline などは P2 の対象として再検証する。
- 旧 Vite PID 63055、port 3000 の listener、agent-browser プロセスは開始時に存在しない。旧実装が動作している証拠はない。既存ユーザープロセスは停止していない。
- Node v22.22.3、pnpm 11.1.2、agent-browser が利用可能。依存はインストール済み。
- 検証用 dev を `DATABASE_URL=file:./data/app.db APP_URL=http://localhost:3000 pnpm dev` で起動。exec session 74530、Vite PID 67160、http://localhost:3000。DB は既存ローカルテスト DB を継続。

## B-P2-01 の再現

保存済み history/timeline 生 HTML と DOM、再現スクリプトを確認した。HTML は未解決 Promise の resolver を含む一方、settlement と `$_TSR.e()` がなく `</html>` で終わる。

現コードで再現スクリプトを実行し、同じ結果を得た。出力 `/tmp/fog-history-http.html` 8554 bytes、`/tmp/fog-timeline-http.html` 9431 bytes。独立再現用メモ ID は `01a07107-44e5-74eb-8706-14d5ffa8b1d5`。このスクリプトにより専用テストアカウントとメモを追加した。

ブラウザ session `fog-resume` で A にログインし、`/memos/01a070f4-c5c7-7222-ab66-2d7bfda3ad54/history` を直接開いた。履歴は表示されるが「差分を表示」を押しても版 2 の表示が残る。履歴内の版 2・版 1・差分の 3 ボタンには `__reactProps` がなく、`.fog-diff` も生成されない。ブラウザエラーは出ない。シェルのリンク遷移は動く。

再現中の dev stdout に `Serialization error:` は出ていない。installed router-core 1.169.2 の `ssr-server.ts` は onError で serialization 完了通知だけを実行し、onDone は `$_TSR.e()` を enqueue/flush してから完了する。`transformStreamWithRouter.ts` は serialization 状態と render 終了を管理する。原因はこの照合では確定していない。

## 受け入れ根拠と残作業

| 項目 | 判定と次の検証 |
| --- | --- |
| R01 | P1 の受け入れ根拠を保持可能。認証の同一ファイルを確認し、今回も既存 A のログイン成功。P2 最終テストで共通 services/UoW の回帰を確認する |
| R02 | P1 の受け入れ根拠を保持可能。新しい topic/document/source 所有者境界は P2 の独立検証対象。現スナップショット全体の合格を意味しない |
| R03 | 未合格。B-P2-01 修正後に直接 reload 後の投稿、pending/失敗入力保持と再表示を再検証 |
| R04 | 未受入。30 件超追加読込の重複/欠落、古い ID、日付近傍、keyword 操作、追加読込後の keyword 不一致編集（B-P2-02） |
| R05 | 未受入。直接 SSR の操作、メモ二点差分、rollback、二画面競合→確認保存、無変更/空入力/失敗入力保持 |
| R06 | 未受入。topic 詳細/更新/完了・解除/再読込保持 |
| R07 | 未受入。所属必須の document 作成→Markdown 表示→編集、異常参照の原子的拒否 |
| R08 | 未受入。source 検索選択→保存、双方向リンク、関連メモ、編集後の最新参照 |
| R09 | 未受入。document の理由/主体/時刻の履歴、二点差分、rollback、競合後保存 |

P2 最終コードでは typecheck/lint:fix/format、関連 unit/Node integration、build と PC/スマホ操作の証拠が必要。今回の限定照合では全テストを再実行していない。P2 の既存成功コマンドは最終 owner filter 変更を含まないため、そのまま最新コードの合格根拠にはできない。

## 引継ぎ

ブラウザ `fog-resume` は close。dev server は上記 PID/session で保持し、Implementer へ操作担当を移す。再起動は所有が明確な PID 67160 に SIGINT を送り、port 3000 の解放後に同じ起動コマンドを使う。ログは exec session 74530 の write_stdin で取得可能。セッションが別エージェントから参照不可なら Manager または本 Verifier に取得依頼する。P2 完了候補まで Verifier のブラウザ・サーバー操作と製品ファイル操作は停止する。
