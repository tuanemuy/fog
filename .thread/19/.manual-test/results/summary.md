# テスト実行サマリー

**実行日時**: 2026-07-28 05:59〜06:32 JST  
**テストソース**: `.thread/19/testing.md`  
**サーバー**: `http://localhost:8787`

| TC | テスト名 | 種別 | 最終結果 | 失敗ステップ |
| --- | --- | --- | --- | --- |
| TC-001 | 登録・設定・ログアウト・再ログイン・セッション維持 | 正常系 | PASS | 初回 Step 8 を修正後 Round 3 で解消 |
| TC-002 | 未登録／誤パスワードの公開エラー同一性 | 異常系 | PASS | - |

**合計**: 2件（PASS: 2 / FAIL: 0）

SSO-only と不正形式メールは通常 UI から安全に作成・送信できないため、
既存の request/state integration と login usecase unit contract を補完証跡とした。
検索、migration、job、PITR、legacy audit など UI を持たない確認項目は、
`testing.md` に記載した自動・運用契約テストを正本とする。
