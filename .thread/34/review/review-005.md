# PR Review #005 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 5回目

## Summary

- Blockers: 2
- Warnings: 12
- Notes: 31
- Verdict: **BLOCKED**

前ラウンド比: Blockers 6 → 2、Warnings 11 → 12。推移は 17 → 14 → 13 → 6 → 2。

**セキュリティと引き継ぎ性は Blocker ゼロに到達。** 前ラウンドの構造的修正（世代非依存の `credentialId` 導入）について、4層すべてが「目的を達成している」と独立に確認した:

- 到達性検査・(R3)(R4)(R8)(R9)・AAD・冪等キーの5用途すべてで一貫し、`(kind, hmac)` に戻っている箇所はゼロ（do-boundary）
- 世代依存の `hmac` に起因する4つの破れが解消され、新たな入力面も開いていない（security）
- (3-d) の `callerToken` 束縛で「読みは束縛するが書きは無束縛」という自己矛盾も解消（security）

引用事実の照合は今ラウンドも全層で実施し、**実装事実・Cloudflare 公式ともに誤りゼロ**。#35 / #37 とも「着手可能」判定。

## レイヤー別ファイル

- DO 境界・ルーティング: review-005-do-boundary.md（B: 1 / W: 3）
- 非同期処理・UoW・migration: review-005-async-uow.md（B: 1 / W: 4）
- セキュリティ: review-005-security.md（B: 0 / W: 2）
- 引き継ぎ性・成果物制約・ドキュメント品質: review-005-handoff.md（B: 0 / W: 3）

## 指摘一覧

### Blockers

- [B-001] signup phase 2 の「`account` 行が存在するなら無条件で拒否」が第6.4節の「phase 2 は冪等」と矛盾し、応答喪失で正常なアカウントが `abandon-account` される — `.thread/34/design.md:443,665,837,867` vs `:893`
- [B-002] 周期・反復ジョブの再武装規則の駆動源クエリが作業述語と一致せず、どちらの読み方でも収束しない（`reserved` 読みでは恒久ループ、処理対象読みでは1回で停止） — `.thread/34/design.md:1247-1252`

### Warnings

- [W-001] 鍵ローテーション移送の巻き戻しで移送先行を無条件破棄する規則が (R7) の「両側を CAS で守る」に反し、移送先に着地した credential 変更の中間状態を壊す — `.thread/34/design.md:1062-1064,710`
- [W-002] `credential_mappings.credentialId` を非一意にする根拠が DO 命名規則 `dir:g{gen}:b{index}`（世代ごとに別 DO）と矛盾 — `.thread/34/design.md:253,731,455`
- [W-003] unlink のガードが `kind` を見ないため `kind='email'` を解除でき、リセット経路（唯一の所有証明）を恒久的に失える — `.thread/34/design.md:987,735,438`
- [W-004] 非同期実行契約の正文（第7.7節 項2）「永続ジョブは外部 I/O だけ／1件だけ」が `kind` 全数表12種と矛盾 — `.thread/34/design.md:1365`
- [W-005] 「SQLite の DDL はデータ量にほぼ依存しない」が `CREATE INDEX` について事実誤りで、単発適用の断定が大きな DO をブリックしうる — `.thread/34/design.md:1569`
- [W-006] `recordOperation` の署名で `operations.targetLocators` を書けず、代替経路も禁止されている — `.thread/34/design.md:1400`
- [W-007] Outbox 廃止で消えるドメイン層イベント抽象が変更対象一覧に1つも無い — `.thread/34/design.md:1192,1855-1876`
- [W-008] リセットトークンの `tokenId` にエントロピー要件が無く、`IDENTITY_RESET_TOKEN_KEY` 単独漏えいでトークンを偽造できる — `.thread/34/design.md:689,254,165`
- [W-009] Directory bucket の PITR restore が消費済みリセットトークンを復活させ、乗っ取り復旧を巻き戻す — `.thread/34/design.md:1635,1015-1019`
- [W-010] 第1.1節の「実参照は31節/14節」が実測（41節/19節）と不一致 — `.thread/34/design.md:15,17`
- [W-011] `testing.md` の実測注記2件が現物と乖離（864行→906行 / 87件→95件。合否判定自体は通る） — `.thread/34/testing.md:236,475`
- [W-012] #35 の対応項目4（`spec/adr/005` の参照側更新）が6箇所中2箇所しか指示されていない — `.thread/34/design.md:1723,1725,1726,1735`

### Notes 由来で修正対象に含めるもの

- `read-own-canonical` の選択キーが未定義（security N-003。認可は閉じているが実装が決まらない）
- `exchange-authz-code` のガード列挙に `redirect_uri` 検証が無い（security N-004。#13 の領分だが宣言が完結集合になっている）
- `credential_locators.status` の値域が未定義（handoff N-010）
