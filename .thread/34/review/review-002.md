# PR Review #002 — docs: Cloudflare Workers + ユーザー単位 Durable Objects への集約を ADR 化し、DO の境界とルーティングを設計する

**PR:** #43
**Date:** 2026-07-29
**Round:** 2回目

## Summary

- Blockers: 14
- Warnings: 24
- Notes: 33
- Verdict: **BLOCKED**

前ラウンド比: Blockers 17 → 14、Warnings 40 → 24。ADR・成果物制約はこのラウンドで Blocker ゼロに到達。1ラウンド目で多発した「引用実装の事実誤り」は DO 境界・セキュリティ・引き継ぎの3層で**全件一致**に回復した（残る誤りは数値1件）。

## レイヤー別ファイル

- ADR・成果物制約: review-002-adr-constraints.md（B: 0 / W: 3）
- DO 境界・ルーティング: review-002-do-boundary.md（B: 4 / W: 7）
- 非同期処理・UoW・migration: review-002-async-uow.md（B: 2 / W: 5）
- セキュリティ: review-002-security.md（B: 5 / W: 6）
- 引き継ぎ性・ドキュメント品質: review-002-handoff.md（B: 3 / W: 3）

## 指摘一覧

### Blockers

- [B-001] 「epoch ガードを通らない RPC エントリは signup の1本だけ」が偽（login step 5・DO 間 saga 前進・退会前進） — `.thread/34/design.md:383`（do-boundary / security W-003 と同源）
- [B-002] signup saga が跨ぐ DO は2つとは限らず（メール + SSO で bucket が2つ）、コーディネーターと `resume-signup` の所有者が未定義 — `.thread/34/design.md:611`
- [B-003] SSO link の部分失敗に前進ジョブが無く、`active` な孤児 mapping が恒久的に回収されない — `.thread/34/design.md:705-711`
- [B-004] リセットトークンの `{generation}.{bucketIndex}` に範囲検査が無く、未認証入力から任意の Directory DO を生成できる — `.thread/34/design.md:537`
- [B-005] 鍵ローテーション中、クレデンシャルの一意性が世代をまたいで保証されない（重複アカウント / 到達性の奪取） — `.thread/34/design.md:534,616,750`
- [B-006] 発行済みパスワードリセットトークンを無効化する手段が設計から消えている — `.thread/34/design.md:231,535-540,678-690`
- [B-007] メール local 部への NFKC + lowercase 正規化が、登録者の所有しないメールボックスにアカウントを紐づけうる — `.thread/34/design.md:409-412,575`
- [B-008] `sessionEpoch` ガードの網羅性主張が現行の認可ゲート実装に対して成立せず、#37 引き継ぎがその修正を明示的に禁じている — `.thread/34/design.md:381-383,1378` / `apps/web/app/presentation/currentUser.ts:17-26`
- [B-009] 濫用抑止の機構が標的型アカウントロックアウトに転用でき、脱出経路（リセット）も同じ設計で塞がれている — `.thread/34/design.md:605-606`
- [B-010] `.overloaded` と DO リセットは DO 内で捕捉不能なのに翻訳場所が「DO 側」と断定されている — `.thread/34/design.md:336-351,1074`
- [B-011] `alarm()` 先頭の再武装が `setAlarm()` の write-buffer 特性を踏まえておらず、CPU 超過エビクションで失われる — `.thread/34/design.md:906-912`
- [B-012] 第6.2.2節(b) と第7.6節が「レート制限時にジョブ行を書くか」で正面から矛盾し、列挙オラクルが再び開く — `.thread/34/design.md:606,944-949`
- [B-013] 第11.1節の走査カバレッジ主張が事実と食い違い、本設計に矛盾する spec を #35 が取りこぼす（除外21→実測36、非レビュー101件中36件が未判定） — `.thread/34/design.md:1213,1222,1226`
- [B-014] 第4.1.1節（テーブル全数の正本）の `credential_mappings` 列定義が第6章と不一致。予約 TTL 列がどこにも定義されず `sweep-reservations` の述語が組めない — `.thread/34/design.md:230` vs `:616,644,656,681`

### Warnings

- [W-001] `.adr/003` の影響節に「公式ドキュメントに無い FTS5 挙動（trigram / bm25）への依存」というトレードオフが無い — `.adr/003-...md:31-37`
- [W-002] `.adr/002` の影響節の `.thread/1/adr.md` ADR-002 の去就が、design.md で決着済みなのに条件形のまま — `.adr/002-...md:40`
- [W-003] `.adr/002` の影響節が「1利用者のリクエストが1オブジェクトに直列化する」トレードオフを挙げていない — `.adr/002-...md:37-41`
- [W-004] 鍵ローテーション中、移送済みユーザーの login が到達性検査で fail closed に落ちる窓 — `.thread/34/design.md:750,754`
- [W-005] epoch を進める操作の一覧が節ごとに食い違う（SSO link の扱い） — `.thread/34/design.md:381,667,710`
- [W-006] `failedAttempts` の更新経路が login 手順に存在しない（照合は request Worker 側） — `.thread/34/design.md:605,462-475`
- [W-007] OAuth 認可コード / PKCE を User Data DO に置く根拠が token エンドポイントに当てはまらない — `.thread/34/design.md:513`
- [W-008] 「表に現れない36件」は実測34件（引用51件 + 34 = 85）。行数も30 vs 実33 — `.thread/34/design.md:306`
- [W-009] 公式は Free の per-object 上限を 1 GB と明記しており「Free 列に per-object の値は無い」は事実に反する — `.thread/34/design.md:65,94`
- [W-010] 行27 が `readAll` の結論を書きながら `ADP-export-001` を行に持たない（`ADP-knowledge-027` も同様） — `.thread/34/design.md:297`
- [W-011] `rotate-remap` 再実行が新しい `passwordVerifier` を巻き戻しうる — `.thread/34/design.md:750`
- [W-012] 生リセットトークンの置き場所が未定義で `jobs.payload` へ恒久化する方向 — `.thread/34/design.md:869,537`
- [W-013] 新設3秘密が `secrets.ts` の構築境界保証（ブランド型・入れ子）を引き継いでいない — `.thread/34/design.md:150-153,428-438`
- [W-014] 退会の「bucket 側に何も残さない」が PITR 30日窓と両立しない旨が未記載 — `.thread/34/design.md:599,728-741`
- [W-015] credential 変更が AI トークンを失効させない決定の補償が「ドキュメント」のみ — `.thread/34/design.md:491-499`
- [W-016] `collectEvents` 廃止後、トランザクション内でジョブ行を書く経路が UoW 契約に無い — `.thread/34/design.md:984-1003,1401`
- [W-017] チェックポイント予算がジョブランナー粒度のみで、`migrate-bulk` / `reindex` のジョブ内部の刻み幅が未定義 — `.thread/34/design.md:904,915,1136`
- [W-018] external-content の surrogate rowid 列に UNIQUE / 索引の要求が無く、引用元の第4.4節に該当記述が無い — `.thread/34/design.md:807`
- [W-019] 非同期実行契約の「正文」が一方向宣言で、規則が第7.4/7.6節に二重記述 — `.thread/34/design.md:952-963`
- [W-020] ロールバック代替の PITR に対象 DO の特定手段が接続されておらず、事実表 #5（列挙 API 不在）と衝突 — `.thread/34/design.md:1169-1177`
- [W-021] 第1.1節の読む順序リストが第11.1節の実参照と食い違い、第4.1.1節が #35 の読む節リストから漏れている — `.thread/34/design.md:15,17`
- [W-022] `spec/inventory/frontend.md`（`PAGE-search-*` の定義元）が台帳表に無い — `.thread/34/design.md:1325-1330`
- [W-023] コードフェンス2箇所に言語指定なし、太字による疑似見出しが129箇所 — `.thread/34/design.md:165,370`
- [W-024] OCC の変更行数取得は `changes()` を明示すべき（`rowsWritten` は課金単位） — `.thread/34/design.md:1095`
