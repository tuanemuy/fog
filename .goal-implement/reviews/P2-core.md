# P2 core 独立検証

検証日時: 2026-09-05T19:35:32+09:00。担当: `/root/p2_core_review`。対象: R04〜R09 の domain / application / libSQL adapters。判定: 担当範囲 PASS、修正を要する不具合なし。UI・ブラウザ・SSR・presentation の合否は別 Verifier の報告で判定する。

## 検証対象

基準 commit は `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。未コミット差分を含む [P2 完了候補](../phases/P2-resume.md) の 96 対象を実ファイルの SHA-256 / 削除状態と照合し、96 件一致、相違 0 件。実装への書き込み、ブラウザ、サーバー、開発 DB の操作は行っていない。

参照した正本は [brief](../brief.md)、[design](../design.md)、[plan](../plan.md)、[requirements](../../spec/requirements.md)、[timeline](../../spec/scenario/timeline.md)、[document](../../spec/scenario/document.md)。レビュー対象は `packages/core/src/domain/fog/content.ts`、`application/fog/{contentSupport,memoServices,documentServices,topicServices,ports,types}.ts`、`adapters/fog/{contentRepositories,unitOfWork,schema}.ts` と対応 integration test。

## 項目別の結果

| ID | 判定 | コードと実 DB テストの根拠 |
| --- | --- | --- |
| R04 | PASS | `listTimeline` は作成日時 / ID の降順 keyset と limit + 1 で追加取得。ID 指定は所有者範囲内で対象を確認し keyword を解除。`nearest` は日本時間の日内を優先し、空日は前後の日界から最も近いメモを選ぶ。同時刻・途中の新規投稿・日本語 / 大文字小文字 / ワイルドカード文字・他所有者 ID 拒否・日界・存在しない日付をテストで確認 |
| R05 | PASS | `editMemo` は version 確認後に同内容を判定。空白本文を拒否し、作成日時を維持。更新とリビジョン追加は同一 transaction。rollback は指定版の本文を新しい版へ複製し、同内容の復元も履歴に残す。競合する 2 書き込みは 1 件だけ成功し、履歴は [2,1]。AI の履歴 / rollback は型と runtime の両方で拒否 |
| R06 | PASS | topic は所有者と非削除条件で取得 / 更新。名前・説明の validation、version 条件、完了 / 解除、更新順一覧を確認。別利用者の一覧は空、単体取得 / 更新を拒否。作成・編集・完了 / 解除の保存結果をテストで確認。折り畳み表示は UI Verifier の範囲 |
| R07 | PASS | 文書作成時に同一 transaction 内で所属 topic とすべての出典 memo の存在 / 所有者を確認。所属は NOT NULL、所属 / 出典は owner を含む複合 FK。別利用者・不存在の所属 / 出典で文書・履歴・リンクの全テーブルが空のまま。リンク INSERT に故障を注入した後も文書と履歴を含め全体 rollback。タイトル空を拒否し、本文空は受理 |
| R08 | PASS | 出典はリビジョンを参照せず memo ID を参照。両方向の取得は owner を含む JOIN で接続し、メモ編集後の最新本文を返す。重複出典は作成前に排除。topic の関連メモは配下文書の出典から重複なしで取得。DB 再接続後も参照と保存内容を保持。遷移操作は UI Verifier の範囲 |
| R09 | PASS | 文書履歴は title / body / reason / actor kind・ID・name / time を INSERT のみで追加。理由省略は人間の作成で「新規作成」、編集で「手動編集」。AI は理由必須、CR / LF のある複数行理由を保存前に拒否。理由だけの変更は版を増やさず、OCC 判定は無変更判定より先。競合する 2 編集の敗者は部分更新なし。rollback は旧版の title / body を新しい版へ複製し、出典を維持 |

所有者境界は各 usecase の `actor.userId` から repository を構築して適用する。更新 SQL に owner / ID / expectedVersion / 非削除条件があり、rowsAffected が 1 でなければ競合。履歴 INSERT と本文更新は `LibsqlFogUnitOfWork.run` の write transaction で同時に確定する。driver error は adapter で shared error に変換される。domain / application の時刻・ID は port 経由。

## 独立再実行

2026-09-05T19:35:25+09:00〜19:35:32+09:00 に次を実行した。生成処理を呼ばず、各テスト自身が作成・破棄する temp libSQL DB のみを使用した。

```sh
pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__/content.integration.test.ts
```

結果: 1 file / 11 tests PASS、exit 0、6.56 秒。対象テストは同時刻 keyset、日付ジャンプ、メモ編集 / rollback、topic lifecycle / 出典 / tenant scope、不正参照原子性、文書履歴 / rollback、AI の人間専用操作拒否、メモ競合、故障注入、文書競合 / DB 再接続、複数行理由拒否。

## 未検証範囲

この分担では UI 表示・操作、任意二点の差分描画、SSR hydration、PC / スマホ表示、全体 build / typecheck / lint を実行していない。P3 の削除・検索と P4 の AI HTTP 境界は P2 の受け入れ対象外。削除済み参照の人間向け DTO を将来の AI API へ流用しない設計上の条件は継続する。
