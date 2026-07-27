# マニュアルテスト一覧

## 概要

| 項目 | 値 |
|---|---|
| 対象プロジェクト | fog（メモアプリ） |
| 作成日 | 2026-07-21 |
| spec バージョン | 2026-07-28 Issue #19 同期後 |

## テストドキュメント一覧

| カテゴリー | ファイル | Issue #19での扱い |
|---|---|---|
| アカウントと認証 | [account.md](./account.md) | signup/login/current user/logout。将来primitiveは自動contract test |
| タイムライン（メモ） | [timeline.md](./timeline.md) | 既存業務シナリオ |
| ドキュメントとトピック | [document.md](./document.md) | 既存業務シナリオ + 同期検索反映 |
| 検索 | [search.md](./search.md) | FTS5、短語、topic、trash、直後反映 |
| ゴミ箱 | [trash.md](./trash.md) | 既存業務シナリオ + 同期検索反映 |
| AI連携 | [ai.md](./ai.md) | 人間UIと同じ検索semantics |
| 設定とデータ管理 | [settings.md](./settings.md) | export完成UIは#15 |

## 実行順序の推奨

1. account.md（アカウント作成・ログインが他カテゴリーの前提になる）
2. timeline.md / document.md（メモ・ドキュメントのデータを作る）
3. search.md（作成済みデータを検索対象にする）
4. ai.md（AIクライアント完成機能が利用可能な後続Issue環境で実行）
5. trash.md（削除・復元。既存データを消すため後半に）
6. settings.md（保持期限・エクスポート。全データが揃った状態で実行すると検証しやすい）

## 実行記録

テスト実行時に以下の表をコピーして記録に使う。

| 実行日 | 実行者 | 環境 | 結果 | 備考 |
|---|---|---|---|---|
| | | | PASS / FAIL | |
