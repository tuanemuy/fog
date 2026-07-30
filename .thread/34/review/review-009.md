# PR Review #009 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 9回目

## Summary

- Blockers: 4
- Warnings: 7
- Notes: 32
- Verdict: **BLOCKED**

Blocker 推移: 17 → 14 → 13 → 6 → 2 → 5 → 2 → 4 → 4。

**鍵ローテーション由来の指摘はゼロになった**（4層すべてが「#44 への委譲は正しく書かれている」「#37 は #44 の結論を待たずに着手できる」と独立に確認）。Issue #44 への切り出しは意図どおり機能している。

今ラウンドの Blocker は**すべて単一世代・ローテーション未実行で発火する saga の穴**で、性質が変わった:

- signup saga のどの phase も `passwordVerifier` を書かない（login / リセット / パスワード変更がすべて不成立）
- 退会 saga が未完了の SSO link を引き取らない（R8 で unlink は引き取るようにしたが link が漏れた）
- SSO link の予約行に `reservedUntil` が無く `sweep-reservations` の投入点も link 経路に無い
- `changeAuthToken` に失効経路が無い（R8 で導入した際の副作用）

### 仕分けの誤りを1件記録する

**B-003（signup が `passwordVerifier` を書かない）は Round 7 のセキュリティレビューが N-003 として挙げていた。** そのラウンドでメインが Notes の一部だけを修正対象に拾い、この1件を落とした。Note として報告された指摘のうち「設計が構造的に成立しない」ものは Warning 相当として扱うべきだった。以降のラウンドでは Notes も本文を確認して仕分ける。

## レイヤー別ファイル

- DO 境界・ルーティング: review-009-do-boundary.md（B: 3 / W: 1）
- 非同期処理・UoW・migration: review-009-async-uow.md（B: 0 / W: 2）
- セキュリティ: review-009-security.md（B: 1 / W: 2）
- 引き継ぎ性・成果物制約・ドキュメント品質: review-009-handoff.md（B: 0 / W: 2）

## 指摘一覧

### Blockers

- [B-001] signup saga のどの phase も `passwordVerifier` を書かないため phase 4 の `usableForLogin` 述語が構造的に真になりえない（login / リセット / パスワード変更がすべて不成立） — `.thread/34/design.md:1154-1163,717,514`（**Round 7 security N-003 の再浮上**）
- [B-002] 退会 saga が未完了の SSO link を引き取らず、回収不能な `active` 孤児 mapping が残る（SSO 主体が恒久的に再登録不能） — `.thread/34/design.md:1338,1340,1205,1467`
- [B-003] SSO link 手順2 の予約行に `reservedUntil` が無く `sweep-reservations` の投入点も link 経路に無い（駆動源の `min()` が NULL になる二次障害も） — `.thread/34/design.md:1298,540,1596,1629`
- [B-004] `changeAuthToken` に失効経路が無く、未使用のまま温存された値が被害者の復旧をまたいで奪還権として残る（phase 1 が消すのは「未使用トークン**行**」だけで、消費済み行の列は消えない） — `.thread/34/design.md:1003,1256,1276`

### Warnings

- [W-001] 「epoch 前進の冪等性は `operations` 行の存在で判定」が退会には当てはまらない（実際の担保は `account.status`） — `.thread/34/design.md:1242,1335,533`
- [W-002] credential 変更 saga の起点（リセット / 通常変更）が永続化されておらず、`resetVersion` 前進と AI 接続の自動失効が Alarm 再開経路で決まらない（第1.4節 I-4 の破れ） — `.thread/34/design.md:1257,514`
- [W-003] `changeAuthToken` の `NULL` / 引数欠落の扱いが未断定（`ep` / `typ` 欠落は明示的に拒否と書いてあるのに、束縛の実体であるこの列だけ書いていない） — `.thread/34/design.md:721,515`
- [W-004] migration ゲートが投入したジョブに対する `setAlarm` の発行主体が、`run()` を呼ばない RPC 経路について決まっていない — `.thread/34/design.md:1708-1712,2049-2050`
- [W-005] 検査8 の列一覧の件数を数え直すコマンドが自己参照で終端せず動作しない（実測 2,242行、期待 61）。列一覧の検査本体は正しく動く — `.thread/34/design.md:291`（`.thread/34/testing.md:562` が同じ数値を参照。async-uow / handoff の2層で重複検出）
- [W-006] `.thread/34/testing.md` 確認項目6 手順3 の許容リストが現状の作業ツリー（`.thread/34/review/` 配下の未 commit ファイル）を覆っておらず、記載どおりに実行すると「差分ゼロ」を満たせない — `.thread/34/testing.md:150-160`

### 検証で確認できたこと（Notes 由来）

4層が独立に実施し、いずれも問題なし:

- **第1.4節の検査1〜9（全項目）を実際に実行して全項目パス**（`NG` 行ゼロ / `MISSING` 出力ゼロ / 検査7b の grep ヒット8 = `ok` 8回）。W-005 は「件数を数え直す補助コマンド」の不具合で、検査本体は正しく動く
- **`ADP-*` 台帳 85 / 引用 53 / 非該当 32 が実走査で一致**。32件全部が `userId` 第一引数であることを spec のシグネチャで裏取り
- **Cloudflare / SQLite 公式を実取得して F-2〜F-32b を照合し、誤りゼロ**。「公式内の不整合」とする2件（Free の per-object 値、`setAlarm` 系の戻り値）も実在
- **引用実装の事実は照合した全件が実物と一致**（行数・行番号・ポート契約・スクリプト本数・`spec/` の走査カウント）
- **第8.2節の UoW 型を `tsc --strict` に通し、`async` コールバックが実際に型エラーになることを確認**
- **成果物制約は全項目クリア**（`.adr/` 新規3件のみで 001 無改変 / `spec/adr/` 新規ゼロ / `.thread/1/adr.md` は `2 0` / コード・コンフィグ差分ゼロ）。`.adr/002` の「鍵は世代を持つ」と第6.8節の #44 委譲は矛盾しない
- **#44 への委譲は4層すべてが正しいと確認**。#37 が落としてはいけない4点が明示され、#44 の Issue 本文の論点6件と第6.8節の表が一致、第6.9節は経路の列挙を残して塞ぎ方だけを委譲
- **ロールプレイ**: #35 は受け入れ条件7項目すべてに対応する記述があり着手可能。#37 は #44 の結論を待たずに着手可能。#44 は6論点が特定でき入力として十分
- 12種の `kind` の収束を1件ずつ追跡し矛盾なし（`done` は分類 (A)(B) のみ復帰・(C) は終端）
