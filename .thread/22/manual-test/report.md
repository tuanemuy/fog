# Browser Verify Report — Issue #22

**対象 Issue**: [#22](https://github.com/tuanemuy/fog/issues/22)
**対象 PR**: [#23](https://github.com/tuanemuy/fog/pull/23)
**検証した HEAD**: `50e2f35`
**実施日**: 2026-09-12
**テストソース**: `.thread/22/testing.md`
**サーバー**: <http://localhost:3000>（`pnpm dev`）
**修正ラウンド**: 手順書の改訂 2 回 ／ 実装の修正 1 件（削除の 2 経路）

---

## サマリー

| 項目 | 値 |
|---|---|
| テストケース総数 | 24 |
| PASS | 24 |
| FAIL | 0 |
| PASS率 | 100% |
| 起票 Issue 数 | 0 |

初回実行では 7 件（TC-02・TC-03・TC-04・TC-07・TC-08・TC-11・E-5）が FAIL し、いずれも手順書起因だった。実装は spec とモックどおりで、testing.md の期待結果を改訂して再観測し全件 PASS。

削除の 2 経路（ドキュメント・トピック）では変更起因の FAIL を 1 件出した。遷移直後の 1 フレームだけ「見つかりません」が描かれる事象で、`invalidate({ filter })` をやめて `router.clearCache()` を遷移の前後 2 回呼ぶ形に変えた。再検証ではドキュメント 6 回・トピック 6 回の全フレームで `見つかりません` を含むフレームが 0。

---

## シードデータ

`.thread/22/manual-test/logs/00-run-info.md` の S-1〜S-8。`/signup` で新規アカウントを登録し、その中でブラウザから作った。

| 手順 | 内容 |
|---|---|
| S-1 | アカウント登録（`/signup` → `/`） |
| S-2 | メモ 5 件（複数行のもの 1 件を含む） |
| S-3 | メモの履歴（1 件を編集して 2 版） |
| S-4 | トピック 3 件（`ブランド刷新` / `引っ越し` / `読書メモ`） |
| S-5 | ドキュメント 3 件（`サイト構成の方針` は 2 版） |
| S-6 | 完了済みトピック（`読書メモ`） |
| S-7 | ゴミ箱 3 種（メモ・ドキュメント・トピック） |
| S-8 | パスワードリセットのトークン（dev サーバーの標準出力の `[dev-mail]`） |

既存のローカルデータは削除していない。検証で作成・削除したデータは `logs/00-run-info.md` と `results/R-4.md` に記録してある。

---

## テスト結果一覧

| TC | 内容 | 種別 | 最終結果 | 初回結果 | 備考 |
|----|------|------|---------|---------|------|
| TC-01 | 戻る付きヘッダーの英語タイトルと橙の点 | 正常系 | PASS | PASS | |
| TC-02 | 共通シェル（ヘッダーとシートの横フレーム・スクロールコンテナ） | 正常系 | PASS | FAIL | 手順書起因。期待結果を 2 度改訂して再観測 |
| TC-03 | モバイルのハンドル付きボトムシートナビ | 正常系 | PASS | FAIL | 手順書起因。現在地マークが `--color-primary` で正 |
| TC-04 | 基準形のプリミティブ（ボタンの段・行・アイコン） | 正常系 | PASS | FAIL | 手順書起因。トピック一覧の行と矢印の色を改訂 |
| TC-05 | コンポーザーのピルと複数行への伸長 | 正常系 | PASS | PASS | |
| TC-06 | 成功・一度きりの通知のトースト | 正常系 | PASS | PASS | |
| TC-07 | エラーの持ち場（フォームの先頭・項目・行の下） | 異常系 | PASS | FAIL | 手順書起因。保持期限 `0` を手順から外した |
| TC-08 | 実 DOM に被せるスケルトン | 正常系 | PASS | FAIL | 手順書起因。行数一致と `/search` の `role` 位置を改訂 |
| TC-09 | ルートエラーと 404（アプリシェル内／認証シート枠内） | 異常系 | PASS | PASS | |
| TC-10 | ナビの無い認証シートの 5 画面 | 正常系 | PASS | PASS | |
| TC-11 | 行・空状態・フォームの基準形 | 正常系 | PASS | FAIL | 手順書起因。出典 0 件の領域とヘッダー 3 アイコンの色を改訂 |
| TC-12 | ゴミ箱のアイコン行操作と設定 | 正常系 | PASS | PASS | |
| E-1 | トーストの重なり | 異常系 | PASS | PASS | |
| E-2 | メモ不在の位置指定遷移 | 異常系 | PASS | PASS | |
| E-3 | 検索の絞り込みトピック不在 | 異常系 | PASS | PASS | |
| E-4 | 二重送信と空送信 | 異常系 | PASS | PASS | |
| E-5 | `lg` でモバイル部品が出ない | 正常系 | PASS | FAIL | 手順書起因。選択マークが primary で正 |
| E-6 | キーボード操作（矢印・Escape・Tab） | 正常系 | PASS | PASS | |
| E-7 | 長いタイトル・長い本文の折り返し | 異常系 | PASS | PASS | |
| R-1 | 移した 5 画面の URL とリダイレクト | 回帰 | PASS | PASS | |
| R-2 | 認証済み 7 URL の `Cache-Control: no-store` | 回帰 | PASS | PASS | `curl` によるヘッダー確認 |
| R-3 | シートのスクロール復元と位置指定 | 回帰 | PASS | PASS | |
| R-4 | 基本フローと削除の 2 経路 | 回帰 | PASS | PASS（削除の手順は未追加） | 手順追加後に変更起因の FAIL。`router.clearCache()` への変更後、各経路 6 回で再現 0 |
| R-5 | 撤去された 3 導線 | 回帰 | PASS | PASS | |

**FAIL の内訳（最終）**: 手順書起因 0 ／ 変更起因 0 ／ 変更と無関係 0

---

## 証跡

メディアはローカルに残さない。下表の URL は PR #23 の本文に添付した実体を指す。録画は PR 本文末尾に TC 順で並ぶ。

| TC | スクリーンショット | 録画 | 添付先 |
|----|-------------------|------|--------|
| TC-01 | [PNG](https://github.com/user-attachments/assets/b5eaf3a3-f9d1-4684-98fa-5ca1017eab86) | [WebM](https://github.com/user-attachments/assets/c1edf97c-71ff-4dd3-b080-ce15db3bcb56) | PR #23 |
| TC-02 | [PNG](https://github.com/user-attachments/assets/dbb8920a-188f-4712-ab38-8c8e6bb3c94c) | [WebM](https://github.com/user-attachments/assets/0372045d-95b2-41bf-9ffc-20b66084f004) | PR #23 |
| TC-03 | [PNG](https://github.com/user-attachments/assets/2cd824c8-1f98-4bfe-a7cb-806f027f4b73) | [WebM](https://github.com/user-attachments/assets/01ed9f45-ef80-4a5e-ada8-5a5da98b6fd6) | PR #23 |
| TC-04 | [PNG](https://github.com/user-attachments/assets/85e5faf9-f630-409a-b665-f001324b8a82) | [WebM](https://github.com/user-attachments/assets/128005ab-07ac-410f-9ad8-08f71598ebcd) | PR #23 |
| TC-05 | [PNG](https://github.com/user-attachments/assets/8a5378fb-6ccf-45dc-a227-500cd663bc1d) | [WebM](https://github.com/user-attachments/assets/12870aa6-0cd9-410b-a913-2dbc57847b71) | PR #23 |
| TC-06 | [PNG](https://github.com/user-attachments/assets/b9101e09-3857-41ad-a54d-d9d9a59d9a17) | [WebM](https://github.com/user-attachments/assets/bae4038a-8bdd-46de-8bab-bb89214874a6) | PR #23 |
| TC-07 | [PNG](https://github.com/user-attachments/assets/37147c74-c463-4c8d-b600-8d858655cb02) | [WebM](https://github.com/user-attachments/assets/0fa21917-82bb-451b-8113-c1352c079603) | PR #23 |
| TC-08 | [PNG](https://github.com/user-attachments/assets/7ba87197-e89f-4f65-ab08-fdf246d68c31) | [WebM](https://github.com/user-attachments/assets/09509b76-9cc3-4a58-af3b-574573968003) | PR #23 |
| TC-09 | [PNG](https://github.com/user-attachments/assets/bc663c6d-3cd2-4457-84fc-9253ecc70a50) | [WebM](https://github.com/user-attachments/assets/44aa46f0-86c7-4a93-a893-cffe65bfd5c2) | PR #23 |
| TC-10 | [PNG](https://github.com/user-attachments/assets/950bc534-e40c-4bc7-b3fa-faeedea2bcc2) | [WebM](https://github.com/user-attachments/assets/e37e3f36-c4bf-40a1-a983-cbb72cf7226f) | PR #23 |
| TC-11 | [PNG](https://github.com/user-attachments/assets/0367fdd6-010c-466a-8065-0595f9be7072) | [WebM](https://github.com/user-attachments/assets/70feea13-5808-424c-ad4f-64accd02ebd9) | PR #23 |
| TC-12 | [PNG](https://github.com/user-attachments/assets/15224f76-cb2a-4e1d-9dee-3aa4891e43c5) | [WebM](https://github.com/user-attachments/assets/0c0c889d-3471-4c90-b59d-7d017f3b3969) | PR #23 |
| E-1 | [PNG](https://github.com/user-attachments/assets/7c02de90-5eb6-4db4-8a10-a43a8ef0b229) | [WebM](https://github.com/user-attachments/assets/db58de1a-4b2f-446b-8abd-09cd8c01e92d) | PR #23 |
| E-2 | [PNG](https://github.com/user-attachments/assets/1e63169f-3726-469e-a897-b70c57dd728e) | [WebM](https://github.com/user-attachments/assets/7d9cf0f4-2ba5-45ec-8262-06b0c765fc06) | PR #23 |
| E-3 | [PNG](https://github.com/user-attachments/assets/fdfb06c6-f352-4578-a23b-a9ab134cfa52) | [WebM](https://github.com/user-attachments/assets/f2381141-e896-4895-a1d7-11cd47b90480) | PR #23 |
| E-4 | [PNG](https://github.com/user-attachments/assets/19c92992-835a-45a6-ac51-ea3203e1057f) | [WebM](https://github.com/user-attachments/assets/b1ac4182-2e47-426b-a9d8-d9313e315adf) | PR #23 |
| E-5 | [PNG](https://github.com/user-attachments/assets/f26aa5f6-f4d4-4dc9-a60e-61897a407b93) | [WebM](https://github.com/user-attachments/assets/ad47bc1d-8124-427f-8c8e-7b8d0da859e3) | PR #23 |
| E-6 | [PNG](https://github.com/user-attachments/assets/4f36dbfc-1348-43ee-b0d9-2b710f6f135d) | [WebM](https://github.com/user-attachments/assets/5dc544b4-13ce-4931-a487-dd780279e998) | PR #23 |
| E-7 | [PNG](https://github.com/user-attachments/assets/e00e56a4-ffb2-4445-a1ac-33f2df3b9e2a) | [WebM](https://github.com/user-attachments/assets/81488c1f-f189-4ce5-8210-4c71c2892434) | PR #23 |
| R-1 | [PNG](https://github.com/user-attachments/assets/3edce482-3a97-4e82-8a99-00b934d14c7e) | [WebM](https://github.com/user-attachments/assets/f568d849-678a-4424-8cda-969b3fa762c0) | PR #23 |
| R-2 | 証跡なし（`curl` によるヘッダー確認） | 証跡なし | — |
| R-3 | [PNG](https://github.com/user-attachments/assets/b6fcf42c-27a7-41e8-ae55-6cac332deec6) | [WebM](https://github.com/user-attachments/assets/4b4e8fe5-15b9-453a-9123-d8931d2ab897) | PR #23 |
| R-4 | [PNG](https://github.com/user-attachments/assets/bd0cf0c5-f9b3-48eb-acd4-1bf65c67b8b0) | [WebM](https://github.com/user-attachments/assets/490ff35a-df8a-4be7-869f-7db30952bbca) | PR #23 |
| R-5 | [PNG](https://github.com/user-attachments/assets/d8c8b4cc-c797-492a-91e1-6a373870b62d) | [WebM](https://github.com/user-attachments/assets/bdfbaad8-8dc6-4d31-82bb-2ed4b64ae494) | PR #23 |

---

## 起票した Issue

なし。

---

## 未観測の項目と担保先

| 項目 | 理由 | 担保先 |
|---|---|---|
| TC-11 タイムライン／トピック一覧の空状態 | 既存データを全消ししないと再現できない | `timeline/__tests__/timelineBoard.dom.test.tsx`・`topics/__tests__/topicList.dom.test.tsx` |
| TC-08 遷移直後 100〜300ms のスクリーンショット | この窓をスクリーンショットで捉えられない | 30ms 間隔の DOM 記録（290ms 差の 2 回が同一）＋ 帯の `animation-name: none` |
| TC-07 再試行の語の分かれ（リトライ／再試行） | 手順が再試行を伴う失敗を起こさない | `trash/__tests__/trashBoard.dom.test.tsx`（行の「リトライ」）、E-1 の面の観測 |
| TC-07 保持期限 `0` の `FieldError` | 改訂後の手順で「ブラウザから確認しない」と明記 | `settings/__tests__/retentionForm.dom.test.tsx` |
| TC-12 行の `RowError` と語「リトライ」 | 行の操作失敗を再現できない | `trash/__tests__/trashBoard.dom.test.tsx` |
| TC-06 成功と部分失敗の混在 | testing.md の指示により対象外 | `trashBoard.dom.test.tsx`・`aiConnectionsPanel.dom.test.tsx` |
| TC-09 レイアウトルート自身の失敗・シェル内 404 | ブラウザから起こせない | `layout/__tests__/routeBoundaries.dom.test.tsx` |
| TC-08 SSR ストリーミング経路 | `pnpm dev` では `ssr: !import.meta.env.DEV` で無効、`pnpm preview` は `.wrangler/state` を共有するため併用しない | クライアント側ローダー経路のスケルトンのみ観測 |
| R-3 下端での過去メモ自動読み込み | メモが 1 ページに収まり番兵が発火しない | ボタンが無いこと（ADR-037）を確認済み |

---

## 判定時に併せて記録した観測事実

- 初回実行時の dev サーバーログに React の警告が 1 件（13:45:02、TC-06 の時間帯）: `Can't perform a React state update on a component that hasn't mounted yet.` 期待結果は満たしており FAIL 要因ではない。
- TC-02 のシートのスクロールは、agent-browser のホイール操作がドキュメント側に向くためキーボード（`End`）で観測した。`main` がスクロールコンテナであることは計算値と `scrollTop` の変化で確認している。
- R-4 の「この内容に戻す」には確認ダイアログが 1 段挟まる。`spec/pages/index.md`（確認あり）とモック `document-history.html` どおりで、testing.md の手順に記載が無い。
- E-1 の「ゴミ箱に見つかりません」は行の下（`RowError`）ではなく一覧の面（`InlineAlert`、`retryLabel: "一覧を読み直す"`）に出る。

---

## 環境情報

- **OS**: Darwin 25.6.0（macOS）
- **サーバーコマンド**: `pnpm dev`
- **URL / ポート**: <http://localhost:3000>
- **ブラウザ**: agent-browser 0.36.0（headless Chrome for Testing）
- **ビューポート**: モバイル 390×844 ／ `lg` 1280×900
- **検証アカウント**: `fog-verify-2026-09-12@example.com` ／ `fog-test-password-2026`

---

## 関連ファイル

- テストソース: `.thread/22/testing.md`
- 判定結果: `.thread/22/manual-test/results/`（`summary.md` ＋ TC ごとのファイル 24 本）
- 観測ログ: `.thread/22/manual-test/logs/`（`00-run-info.md` ＋ 24 ファイル）
