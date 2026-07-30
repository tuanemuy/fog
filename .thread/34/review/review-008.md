# PR Review #008 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 8回目

## Summary

- Blockers: 4
- Warnings: 4
- Notes: 30
- Verdict: **BLOCKED**

Blocker 推移: 17 → 14 → 13 → 6 → 2 → 5 → 2 → 4。

## 収束していない領域の特定 — 鍵ローテーション（第6.8節）

**Blocker のほぼ全部が「鍵ローテーション」に集中し、4ラウンド連続で新しい相互作用バグが出続けている。**

| ラウンド | 鍵ローテーション由来の Blocker / Warning |
|---|---|
| R5 | do-boundary B-001（巻き戻しが移送先行を無条件破棄）/ do-boundary W-001（移送中の login fail closed） |
| R6 | security B-001（`DIRECTORY_ROUTING_SECRET` 一時注入が bucket 側で検証不能）/ do-boundary W-001（競合分岐の記録先が無い） |
| R7 | do-boundary B-001（`rotation_checkpoints` の共有）/ do-boundary B-002（移送 × `rotate-encryption`）/ security W-001（所持証明が漏えい時に成立しない） |
| R8 | do-boundary B-001（削除対象スナップショット × 移送）/ do-boundary B-002（移送先書き込みが RPC 全数表に無い）/ do-boundary B-003（(X3) が `rotate-encryption` の記録規則と矛盾） |

毎ラウンド直しては、**ローテーションが他のすべての saga（unlink / 退会 / credential 変更 / signup 予約 / login）と新しい形で干渉する**のが見つかる、という状態が続いている。

### スコープ上の位置づけ

Issue #34 の対応項目3 が要求しているのは次だけである。

> DO の ID や routing key に生メールアドレス・SSO subject を使用しない。正規化値を HMAC / hash した内部キーを使用し、ログへ個人情報を露出させない**方針**を設計に明記する

**鍵の世代管理・ローテーション手順は Issue が要求していない。** 実際、計画レビュー1周目（coverage S-003）で「AC-14 の『鍵の所有者・世代管理』は Issue 未要求」と判定し、必須基準から外して design.md の**任意論点へ降格**している。つまり完全なローテーション手順は本 Issue が自ら広げた ［派生］ 領域であり、そこに4ラウンド分の Blocker が費やされている。

`.thread/34/review/triage.md` の運用規則は、この状態に対して「個別修正で追いかけず設計の問題として扱う — 別 Issue を起票するかユーザーに判断を委ねる」と定めている。**判断をユーザーに委ねる。**

## レイヤー別ファイル

- DO 境界・ルーティング: review-008-do-boundary.md（B: 3 / W: 1）
- 非同期処理・UoW・migration: **ファイル未作成**（B: 0 / W: 2。サブエージェントは書き込んだと報告したが実ファイルが存在しない。指摘内容は下記に転記済み）
- セキュリティ: review-008-security.md（B: 1 / W: 0）
- 引き継ぎ性・成果物制約・ドキュメント品質: review-008-handoff.md（B: 0 / W: 1）

## 指摘一覧

### Blockers

- [B-001] unlink / 退会の削除対象がスナップショットのため、`rotate-remap` の移送が `targetLocators` の外に mapping 行を作り、解除済みクレデンシャルでのログイン or canonical の永久ロックが成立 — `.thread/34/design.md:1302,1303,1312,1009,1012,1322,1363,1383`（**ローテーション由来**）
- [B-002] ローテーション手順2 (2)「移送先 bucket への active 行書き込み」が RPC エントリ「全数」表に無くガード未定義（(X3) も実装不能） — `.thread/34/design.md:1363,1377,702-727,729,1379`（**ローテーション由来**）
- [B-003] (X3) の「`previousCount` が0でなくなる」が `rotate-encryption` の記録規則（完了時に0のみ）と矛盾し、旧暗号鍵の誤退役を止められない — `.thread/34/design.md:1412,1418,528,1084,2406`（**ローテーション由来**）
- [B-004] `begin-credential-change` 起点 B の束縛が `operationId`（未認証ログ出力可）＋ `credentialId`（非秘密・UI 露出）だけで構成されており、binding 到達性を持つ呼び出し元に乗っ取り原始関数が残る — `.thread/34/design.md:712,754,1251-1252,746-747`

### Warnings

- [W-001] 第1.4節 検査7b のインライン期待値 `-> 10` が現物（12）と食い違い、testing.md 確認項目18 の期待値（12）とも矛盾。同じ検査が `awk` で自分自身を走査対象外にしているため機械検出できない — `.thread/34/design.md:207`（do-boundary / async-uow / handoff の3層で重複検出）
- [W-002] `sweep-orphan-mapping` の残件条件（`operations` の未完了 unlink 行）と `finalize-withdrawal` の生存期間が噛み合っておらず、退会経路で (B) の残件が単調減少しない可能性が残る — `.thread/34/design.md:1454,1103,1057`

### 検証で確認できたこと（Notes 由来）

3層が独立に実施し、いずれも問題なし:

- **第1.4節の検査1〜9（10項目）を実際に実行して全項目パス**（12種の `kind` / 60列 / 7ストア / クラス (3) 13本と4群の合計一致 / 除外リスト4件 など）。ずれたのは W-001 の注記1箇所のみ
- **引用実装の事実は照合した全件が実物と一致**（`adapters/d1/` 20ファイル2,514行・非テスト8ファイル914行、`0000_initial.sql:46,47`、`currentUser.ts:28-33`、`errors.ts:206-210` など）
- **`spec/inventory/adapter.md` の台帳85件 / 引用53件 / 差32件が実走査で一致**
- **Cloudflare / SQLite 公式を実取得して事実行を全件裏取り**。「公式内の不整合」とする3点（F-1 / F-30 / F-4・F-4b）はいずれも実在
- **成果物制約は全項目クリア**（`.adr/` 4件で 001 に変更なし / `spec/adr/` 新規ゼロ / `.thread/1/adr.md` は `2 0` / コード・コンフィグ差分ゼロ）
- **testing.md の確認項目1〜18 を全件実行して全パス**
- **第11.1節の走査カバレッジ主張は全数一致**（101 = 改訂72 + 影響なし29、重複ゼロ・未判定ゼロ）
- **#35 / #37 のロールプレイで手が止まる箇所は見つからなかった**（#37 の未決9件は全件 spike に割り当て済み）
- 前ラウンドの修正3点（所持証明の射程限定 / `resetVersion` 基準への切り替え / 2つのローテーションの排他）はいずれも追跡して成立を確認
