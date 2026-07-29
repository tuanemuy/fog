# PR Review #003 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-30
**Round:** 3回目

## Summary

- Blockers: 13
- Warnings: 26
- Notes: 33
- Verdict: **BLOCKED**

前ラウンド比: Blockers 14 → 13、Warnings 24 → 26。件数は横ばいだが**内容の性質が変わった**。1〜2ラウンド目に多発した「引用実装の事実誤り」は3層のレビュアーが実測で全件照合し、実質的な誤りは3件まで落ちた（Cloudflare 公式31項目も逐語照合で誤り1件）。今ラウンドの Blocker は、2ラウンド目で新しく書いた節（鍵ローテーション・cross-DO saga・Alarm チェックポイント）の内部整合に集中している。

3軸に集約される:

1. **鍵ローテーション中の2世代並存** — credential 変更 saga / signup 予約 / unlink / ロックアウト脱出が、移送中の「旧世代にも行がある」状態を想定していない
2. **DO 間 RPC の信頼境界** — クラス (3) の内部エントリが CAS も phase 条件も持たず、呼び出し元供給の `userId` だけが守りになっている
3. **Alarm 駆動の CPU 予算** — `Date.now()` が Workers で凍結する事実と、due job が無いときに alarm を消す手順の不在

## レイヤー別ファイル

- ADR・成果物制約: review-003-adr-constraints.md（B: 0 / W: 1）
- DO 境界・ルーティング: review-003-do-boundary.md（B: 3 / W: 5）
- 非同期処理・UoW・migration: review-003-async-uow.md（B: 2 / W: 6）
- セキュリティ: review-003-security.md（B: 7 / W: 6）
- 引き継ぎ性・ドキュメント品質: review-003-handoff.md（B: 1 / W: 8）

## 指摘一覧

### Blockers

- [B-001] 鍵ローテーションと credential 変更 saga・signup 予約の相互作用が未設計（旧パスワード復活＋恒久ロックアウト） — `.thread/34/design.md:914-926,627-632,825-838`（do-boundary B-001 / security B-005 と同源）
- [B-002] unlink の「最後のログイン手段」検査が行数ベースで誤り（SSO ユーザーのメール予約行 / ローテーション中の2世代行）→ 自己ロックアウト — `.thread/34/design.md:872`
- [B-003] unlink の削除が2世代・2 bucket を覆わず、ローテーション中に解除済みクレデンシャルでログインできる — `.thread/34/design.md:873-874`
- [B-004] クラス (3) の3エントリが CAS も phase 条件も持たず、`read-own-canonical` は PII 復号オラクル、`delete-mapping` はロックアウト原始関数。第5.1節と第6.2.1節が正面衝突 — `.thread/34/design.md:440,434-436,704`
- [B-005] 「全数」を謳う RPC エントリ表に operator 経路の mapping 一括削除 RPC と OAuth token エンドポイント経路が欠落 — `.thread/34/design.md:413-438,903,600-602`
- [B-006] 第5.1節の RPC エントリ表が signup saga の再開・補償経路のエントリを3つ欠く — `.thread/34/design.md:413-440`（対 `:798,742,804`）
- [B-007] credential 変更 saga の locator 解決が未定義（パスワード変更では旧検証材料の取得経路自体が無い／ローテーション中の世代解決も無い） — `.thread/34/design.md:827,428`
- [B-008] `rotate-remap` を bucket の Alarm ジョブにすると一時注入した routing key が存在せず、秘密の配布境界を壊す実装に倒れる — `.thread/34/design.md:1076,504-505`
- [B-009] 複数クレデンシャル signup の phase 3 部分成功 + 終端規則で `active` 孤児 mapping が残り、その credential が恒久的に再登録不能 — `.thread/34/design.md:804,744,890`
- [B-010] 第4.1.1節（テーブル/列の正本）に OCC の version 列が1つも無く、第8.4節「OCC は残す」が実装不能 — `.thread/34/design.md:229-256`（対 `:1299-1309`）
- [B-011] 外側チェックポイント予算の「累積経過時間10秒」は Workers の `Date.now()` が凍結するため CPU バウンドなジョブ列に発火しない — `.thread/34/design.md:1085-1112,1348`
- [B-012] `alarm()` 先頭で必ず武装する規則に対し、due job が無いときに alarm を消す手順が無い（`deleteAlarm` が文書中に皆無）。全 User Data DO が10秒間隔で永久に起き続ける — `.thread/34/design.md:1093-1100`
- [B-013] OAuth 2.1 認可コード / PKCE / `jti` テーブルの引き取り先 Issue 番号が事実と食い違う（#12 は OAuth 認可を持たない。実際の owner は #13） — `.thread/34/design.md:256,598`

### Warnings

- [W-001] `.adr/003` の根拠が「実測1件」、参照先 design.md は「実測2件」で食い違い — `.adr/003-...md:37`
- [W-002] 第5.5節 1 の「userId を `idFromName` に渡せるのは2経路」が login step 5 を取りこぼし — `.thread/34/design.md:611-612`
- [W-003] 第6.1節 (c)「previous 世代への書き込みは削除だけ」が事実として誤り（B-001 の根本原因） — `.thread/34/design.md:631`
- [W-004] 第6.2.2節 (a) のロックアウト脱出経路が rotation 中に成立しない — `.thread/34/design.md:830,722`
- [W-005] 第4.3節 行25b が引用する `deleteSourceLinksByMemo` の署名が spec と食い違う — `.thread/34/design.md:316`
- [W-006] design.md 内部の自己参照「第6.5.1節 :690」が古い行を指す（実体は `:837`） — `.thread/34/design.md:644`
- [W-007] PITR 復旧後の必須手順が `sessionEpoch` のみで、失効済み AI クライアント接続の復活を塞げていない — `.thread/34/design.md:1405-1410`
- [W-008] local 部の lowercase 化が、同節が NFKC を退けた論拠とそのまま衝突 — `.thread/34/design.md:477,475`
- [W-009] signup の重複エラーが公開の列挙オラクルである点の受容判断が未記録 — `.thread/34/design.md:741`
- [W-010] リセットトークンの `generation`（routing 世代）と導出鍵の世代が同一記号で書かれ取り違えを誘発 — `.thread/34/design.md:639,635,249`
- [W-011] 「未登録 canonical でも行が増えない」は同一 canonical に限った話で、断定が広すぎる — `.thread/34/design.md:1148`
- [W-012] SSO login の IdP アサーション検証点が設計に現れず、応答均一化も SSO 行には効かない — `.thread/34/design.md:554,422`
- [W-013] OCC の `SELECT changes()` が未検証かつ #37 の spike 一覧に無い — `.thread/34/design.md:1307,1700-1709`
- [W-014] RPC 経路の `enqueueJob` → `setAlarm` の実行主体と原子性が未指定で、示された回復策が dormant DO に効かない — `.thread/34/design.md:1100,1192`
- [W-015] `jobs` の `done` / `poison` prune に `kind` も所有者も割り当てられていない — `.thread/34/design.md:1083,1061-1078`
- [W-016] `operationKey` の「収束」が `send-mail` と `purge-trash` で相反する意味を持つ — `.thread/34/design.md:1049,1123-1124`
- [W-017] 第2.1節 #27 の裏付け種別が誤り（公式記載ではなく禁止規定の不在による推論） — `.thread/34/design.md:92`
- [W-018] 第7.7節の自己記述「5節はそれぞれ冒頭に正文参照を持つ」が第8.4節で成立していない — `.thread/34/design.md:1155,1309`
- [W-019] 第9.1節の `exports` 方式と #37 Issue 本文の `new_sqlite_classes` が矛盾するのに訂正指示が無い — `.thread/34/design.md:1327,86`
- [W-020] 第11.2節が `.thread/36/` の引き継ぎ項目 H-1〜H-8 と `handlers.integration.test.ts`、`.tpl` の `main` 修正を取りこぼし — `.thread/34/design.md:1620-1657`
- [W-021] RPC クラス (3) の定義と `check-previous-generation` 行が食い違う（未認証の request Worker から呼ばれる） — `.thread/34/design.md:417,434`
- [W-022] 第4.1.1節（列の全数の正本）に AES-GCM nonce の置き場所が無い — `.thread/34/design.md:248,695`
- [W-023] `alarm()` 先頭に「再武装」と「migration ゲート」の両方が置かれ前後関係が未定 — `.thread/34/design.md:1095,1336`
- [W-024] 走査除外が `spec/usecases/review/002.md`（#35 Issue 本文が名指し）の判断を持たない — `.thread/34/design.md:1432`
- [W-025] 第1.1節の読み順ガイドが自己矛盾（「一覧に載っていない4つ」→「取り込んである」） — `.thread/34/design.md:16`
- [W-026] `#N` が第2.1節の事実番号と GitHub Issue 番号で衝突（#8 / #10 / #12） — `.thread/34/design.md:79,102,106`

### 細かい事実のずれ（Notes 由来。修正対象に含める）

- 第2.1節 #27 の裏付け種別（do-boundary N-002 / async W-017 と同一）
- `spec/database/index.md:92` → `:90`、db スクリプト列挙の漏れ2本（do-boundary N-003）
