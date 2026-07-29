# PR Review #004 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 4回目

## Summary

- Blockers: 6
- Warnings: 11
- Notes: 25
- Verdict: **BLOCKED**

前ラウンド比: Blockers 13 → 6、Warnings 26 → 11。**引用事実の誤りはこのラウンドで実質ゼロ**（4層すべてが実ファイル・Cloudflare 公式で全件照合し、誤りは事実表 F-4b の裏付け種別1件のみ。結論には影響しない）。

**Blocker 5件が単一の根に収束した。** `hmac`（= HMAC(routing key[generation], canonical)）は**世代依存**の値なのに、credential の**世代非依存な同一性**として使われている。ここから次が同時に出ている:

- unlink の「最後のログイン手段」検査がローテーション中に発火しない（自己ロックアウト）
- unlink の削除対象を選択する手段が無い
- `encryptedCanonical` の AAD が `hmac` を束縛しているため、移送で `hmac` が変わると復号不能になる
- `record-credential-locator` の冪等キーが第6.6節と第6.8節で矛盾する
- `credential_locators.credentialVersion` の更新に世代規則が無い

`.thread/34/review/triage.md` の運用規則（同じ箇所が3ラウンド以上別角度から再指摘されたら個別修正で追いかけず設計の問題として扱う）に該当する。**世代非依存の `credentialId` を導入する構造的修正**で対処する。

## レイヤー別ファイル

- DO 境界・ルーティング: review-004-do-boundary.md（B: 2 / W: 3）
- 非同期処理・UoW・migration: review-004-async-uow.md（B: 1 / W: 1）
- セキュリティ: review-004-security.md（B: 2 / W: 2）
- 引き継ぎ性・成果物制約・ドキュメント品質: review-004-handoff.md（B: 1 / W: 5）

## 指摘一覧

### Blockers

- [B-001] `hmac` は世代依存なのに `(kind, hmac)` を世代非依存の credential 同一性として使用。unlink の検査がローテーション中に発火せず自己ロックアウト、削除対象の選択手段も無い — `.thread/34/design.md:244,703-704,956-958,1063`
- [B-002] `encryptedCanonical` の AAD が `hmac` を束縛しているのに移送で `hmac` が変わり、第6.8節 手順2 が再暗号化を規定していないため移送済み全行が復号不能 — `.thread/34/design.md:758,1002-1022,1034`
- [B-003] 鍵ローテーション (2) の「移送先に行があれば書かない」が移送先の陳腐化を区別せず、リセット完了が旧世代 bucket に着地すると新パスワードが捨てられ旧 `passwordVerifier` が正本に戻る — `.thread/34/design.md:1019-1024,693,913`
- [B-004] `credential_locators.credentialVersion` の更新に世代規則が無く、`record-credential-locator` の冪等述語も `(kind,hmac)` と `(kind,hmac,generation)` で自己矛盾。ローテーション中の credential 変更後に login step 5 (iii) が恒久不一致 — `.thread/34/design.md:905,703,949,1016`
- [B-005] `record-credential-locator` の冪等キーが第6.6節と第6.8節で矛盾し、前者で実装すると移送済み全利用者が到達性検査で締め出される — `.thread/34/design.md:450,949,1016,244`
- [B-006] 反復・周期ジョブ（`purge-trash` / `sweep-*`）の再武装規則が無く、収束規則がそれを構造的に禁じている（ゴミ箱の保持期限が黙って無期限に伸びる） — `.thread/34/design.md:1196,228,1220,1238,1270-1271`

（B-001 / B-002 / B-004 / B-005 は `hmac` の世代依存性という同一の根から出ている。B-003 も移送先の陳腐化判定に世代非依存の同一性が要る点で同源）

### Warnings

- [W-001] (3-a) の「CAS と phase 条件が守る」が saga を新規開始するエントリに成立せず、読みだけ `callerToken` で束縛され、より強い書きが無束縛 — `.thread/34/design.md:466-473,446,449,1031`
- [W-002] 「クラス (2)(3) の全数」を宣言する表で、SSO link 手順2 の `reserve-credential` 呼び出し元（User Data DO / `resume-link`）が欠落 — `.thread/34/design.md:442,944`
- [W-003] 第6.1.1節 (R5) が SSO link を「永続化済み locator から取る」側に誤分類（link の対象は新 credential なので該当行が存在しない） — `.thread/34/design.md:705,944`
- [W-004] `callerToken` を「request Worker のコード実行を得た攻撃者に効く2層目」とする脅威モデルが、同トークンを request Worker へ返す設計と食い違う — `.thread/34/design.md:472,910,161`
- [W-005] F-4b の「記載の不在」は不正確。limits ページ FAQ が Alarm を 30秒 CPU の invocation として明示している（結論は不変） — `.thread/34/design.md:71`
- [W-006] チャンク反復上限 (iii-b) 中断時のジョブ状態遷移が claim の CAS と食い違う — `.thread/34/design.md:1216,1200`
- [W-007] ローテーション巻き戻し時に (1) が書いた `credential_locators` 行と `credentialVersion` の扱いが未定義で、恒久的な不一致（ログイン不能）になりうる。第6.9節の締め出し経路一覧にも無い — `.thread/34/design.md:1024,577,905`
- [W-008] 第11.2節「第11.4節の spike 4件」が実際は6件列挙（第11.4節は9行） — `.thread/34/design.md:1828`
- [W-009] `testing.md` 確認項目7（手順1・手順3）・確認項目11（手順4）の期待結果が現物に対して成立しない — `.thread/34/testing.md:228,333`
- [W-010] 第11.1節 `spec/usecases/memo.md` 行の `collectEvents` 行番号列挙に `:359` が欠落（実測7箇所に対し6件） — `.thread/34/design.md:1682`
- [W-011] Issue 本文の訂正指示を2件出しているのに、#37 対応項目3「UoW 契約は維持したまま」だけ訂正指示が無い — `.thread/34/design.md:1490,1637`

### Notes 由来で修正対象に含めるもの

- `report-login-result` のガード文言が bucket 側に照合材料が無く実装不能（security N-003）
