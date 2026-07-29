# PR Review #001 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-29
**Round:** 1回目

## Summary

- Blockers: 17
- Warnings: 40
- Notes: 38
- Verdict: **BLOCKED**

## レイヤー別ファイル

- ADR・成果物制約: review-001-adr-constraints.md（B: 1 / W: 2）
- DO 境界・ルーティング: review-001-do-boundary.md（B: 4 / W: 10）
- 非同期処理・UoW・migration: review-001-async-uow.md（B: 3 / W: 10）
- セキュリティ: review-001-security.md（B: 4 / W: 9）
- 引き継ぎ性・ドキュメント品質: review-001-handoff.md（B: 5 / W: 9）

## 指摘一覧

### Blockers

- [B-001] design.md に生 NUL バイト2個が混入し grep がバイナリ扱い、機械検証が偽の合格 — `.thread/34/design.md:352,448`（adr / do-boundary / handoff の3層で重複検出）
- [B-002] signup の `operationId`（＝候補 `userId`）の再送時の出所が未定義、外部入力が locator 材料になりうる — `.thread/34/design.md:500,531`（security / do-boundary）
- [B-003] 未認証 signup が Directory の重複チェックより先に User Data DO を生成する — `.thread/34/design.md:498-505`（do-boundary）
- [B-004] 第6.6/6.7節が依拠する login 時の到達性検査が第5.3節の login 手順に存在しない（unlink 後の孤児 mapping でログインできる） — `.thread/34/design.md:555,399-406`（do-boundary）
- [B-005] パスワード変更/リセット完了の cross-DO saga が無く、credential 更新後も古いセッションが生存 — `.thread/34/design.md:332,534,674`（security）
- [B-006] 退会が `credential_locators` を Directory mapping より先に削除し `encryptedCanonical`(PII) が孤児化、再登録も永久ロック — `.thread/34/design.md:565-566,674`（security）
- [B-007] `IDENTITY_MAIL_ENCRYPTION_KEY` に世代管理が無く、暗号方式（AEAD/nonce/AAD）も未定義 — `.thread/34/design.md:484`（security）
- [B-008] `ctx.storage.transaction()`（非同期コールバック可の公式 API）が UoW の代替案から欠落 — `.thread/34/design.md:769-777`（async-uow）
- [B-009] lazy migration ゲートが `alarm()` エントリに掛かっていない — `.thread/34/design.md:863`（async-uow）
- [B-010] Alarm 再武装が `finally` にあり、支配的失敗モード（CPU 超過＝エビクション）で走らない — `.thread/34/design.md:693`（async-uow）
- [B-011] User Data DO → Identity Directory DO の呼び出し経路が未設計で第5.5節の保証と第6.4/6.6/6.7節が矛盾 — `.thread/34/design.md:434,521,553,566`（handoff）
- [B-012] 第11.1節「影響なし」19件のうち18件が実際には改訂対象 — `.thread/34/design.md:986`（handoff）
- [B-013] `spec/idea.md` を走査から除外したが #35 対応項目1が改訂を明示要求 — `.thread/34/design.md:940`（handoff）
- [B-014] 改訂内容が #35 の受け入れ条件を未カバー（非機能要件の DO 物理分離 / schema version・lazy migration / tokenizer 方針 / 新設テーブル群） — `.thread/34/design.md:946,978`（handoff）

（B-001 は3層、B-002 は2層で重複検出のため、17件の生指摘を14 Key に正規化）

### Warnings

- [W-001] ドメインイベントを `collectEvents` ごと全廃する決定が `.adr/` から読み取れない — `.adr/004-do-local-commit-and-alarm-jobs.md:26,40`
- [W-002] `.adr/002` の決定節が2クラス構成を述べた直後に「何クラス構成にするかは design.md で確定する」と差し戻して自己矛盾 — `.adr/002-...md:25`
- [W-003] DO への RPC が新しい信頼境界になることが未扱い、ブランド型が境界で失われる — `.thread/34/design.md:812,820-824`
- [W-004] `sessionEpoch` 導入が `SessionCodec` ポート変更を要求するのに #37 引き継ぎに無い — `.thread/34/design.md:563,990-1008`
- [W-005] セッション / AI クライアントトークンに鍵分離も audience タグも無い — `.thread/34/design.md:414,144`
- [W-006] AI トークンが `scope` を自己完結で持ち、権限縮小が `exp` まで反映されない — `.thread/34/design.md:414-418`
- [W-007] リセットトークンへの bucket index 埋め込みが「locator を URL に出さない」と矛盾 — `.thread/34/design.md:452,342`
- [W-008] 鍵ローテーション時に全ユーザーのメール平文が Worker 間 RPC を bulk で流れるのに保護規定なし — `.thread/34/design.md:488,577`
- [W-009] 未認証経路のレート制限が未設計、標的型で任意 1 bucket を `overloaded` にできる — `.thread/34/design.md:464,472`
- [W-010] リセット依頼の「同じ処理経路」と「ジョブを投入しない」が同一段落で矛盾（列挙オラクル） — `.thread/34/design.md:722`
- [W-011] PII 非露出規定に `passwordVerifier` が無く、`userId` のログ出力許可が列挙オラクルになる — `.thread/34/design.md:342,403`
- [W-012] external-content FTS5 の rows-written 緩和効果が過大評価 — `.thread/34/design.md:617`
- [W-013] external-content FTS5 の必須実装制約（旧値 `'delete'` / 安定 INTEGER rowid）が未記載 — `.thread/34/design.md:617`
- [W-014] `SystemError(ServiceOverloaded)` / `(StorageCapacityExceeded)` が新規コードである旨と `errors.ts` の変更対象化が不在 — `.thread/34/design.md:293-300`
- [W-015] 「Alarm には CPU リセットの契機が無い」は記載の不在からの推論なのに「公式記載」扱い — `.thread/34/design.md:70`
- [W-016] migration ゲートの排他条件（await を挟まない同期実行）が未明示 — `.thread/34/design.md:863-865`
- [W-017] 予約 TTL 掃除と phase 3 以降の saga 再開が競合し到達不能アカウントを作りうる — `.thread/34/design.md:517-525`
- [W-018] indexer / pruner 専用 `WorkerContainer` は実装に存在しない（出典が誤り） — `.thread/34/design.md:256-257`
- [W-019] `application/workers/` に consumer / DLQ は無い（relay / pruner の2本のみ） — `.thread/34/design.md:247`
- [W-020] Outbox 廃止後の非同期実行契約（至少一回・順序保証）の正文が1箇所に無い — `.thread/34/design.md:982`
- [W-021] 「SSO はリポジトリまで実装済み」「`AiClientConnection` 値オブジェクト実装済み」等が実物と不一致 — `.thread/34/design.md:108-110`
- [W-022] `Email.create` の現行実装の記述が誤り（320字上限＋regex が落ちる） — `.thread/34/design.md:351`
- [W-023] 短語フォールバックの結論（LIKE/GLOB）が実測（`instr()`）と不一致、50バイト制約の導出も無効 — `.thread/34/design.md:629,626`
- [W-024] `ADP-identity-014`（`PasswordResetTokenPort.issue`）が第4.3節の全数表に無い — `.thread/34/design.md:216-258`
- [W-025] リセットトークンが世代を持たず鍵ローテーションで到達不能 — `.thread/34/design.md:452,577`
- [W-026] PITR が `sessionEpoch` を巻き戻し失効済みセッションを再有効化 — `.thread/34/design.md:914-924`
- [W-027] bucket 数 N が名前にも keyring にも無く、世代変更で解決できない — `.thread/34/design.md:472,371`
- [W-028] 秘密配布表に AI トークン署名鍵が欠落 — `.thread/34/design.md:142-145`
- [W-029] 実装引用の取り違え5件（JSDoc の所在、ALS、行数、引数順ほか） — `.thread/34/design.md:736,738,816,19,255`
- [W-030] 第4.1節の保持データ表と第6〜9章のテーブルが不一致 — `.thread/34/design.md:190`
- [W-031] export 読み出し上限の決定主体が #38 と #37 で食い違う — `.thread/34/design.md:309,1057`
- [W-032] 判定基準を CPU 予算としたが計測手段も具体値も残っていない — `.thread/34/design.md:689,867`
- [W-033] 第1.1節の読者導線が実態と不一致 — `.thread/34/design.md:15`
- [W-034] 網羅性が6語 grep 依存で、pruner 前提の testcase 4件と DB 直接更新前提の manual-test 2件が漏れる — `.thread/34/design.md:940`
- [W-035] Markdown スタイル違反（区切り線11本、太字の見出し代用39箇所、文全体の太字） — `.thread/34/design.md` 全体
- [W-036] 第11.2節「削除対象」表に削除しない行が混在 — `.thread/34/design.md:992`
- [W-037] trigram / bm25 実測の出典が現ブランチに存在せず再現手順も無い — `.thread/34/design.md:77`
- [W-038] `sessionEpoch` をトークンへ署名する変更の移行（epoch 無しトークンの扱い）が未記述 — `.thread/34/design.md:332`
