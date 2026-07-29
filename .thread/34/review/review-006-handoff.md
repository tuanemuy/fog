# レビュー 006 — 引き継ぎ性・成果物制約・ドキュメント品質

**対象:** PR #43（`issue/34/do-boundary-design`）/ Issue #34
**観点:** 後続 Issue（#35 / #37 / #38）への引き継ぎ性、成果物制約、ドキュメント品質
**方法:** ゼロベース。Issue #34 / #35 / #37 / #38 本文の全受け入れ条件照合、`.thread/34/design.md`（2,047行）通読、`.adr/002〜004` / `spec/adr/005` / `.thread/1/adr.md` の差分検証、`.thread/34/testing.md` の機械検証手順17件の**実行**、本文が主張する件数・パス・行番号の**実測突き合わせ**、第4.1.1節 ↔ 第5〜9章の全数突き合わせ。

## 検証の結果（要約）

| 区分 | 結果 |
|---|---|
| 成果物制約（`.adr/` 3件 / `spec/adr/` 新規なし / `.thread/1/adr.md` / コード・コンフィグ不変） | **すべて適合** |
| `.thread/34/testing.md` の機械検証17項目 | **15件が期待どおり。2件（項目14 / 項目17）は期待結果が現物と食い違う** |
| 第11.1節の走査カバレッジ主張（39 / 101 / 62 / 65 / 36 / 72 / 29） | **実測と完全一致** |
| 節番号参照・パス参照・行番号引用・`F-N` 参照 | **全件実在** |
| 第4.1.1節 ↔ 第5〜9章の整合 | **3件の食い違い**（B-001 / B-002 / W-001） |
| #35 の受け入れ条件7項目 | **すべて着手可能** |
| #37 の受け入れ条件11項目 | **B-001 / B-002 の2箇所で手が止まる** |

---

### 引き継ぎ性・成果物制約・ドキュメント品質

#### Blockers

- **[B-001]** `jobs` の「完了時刻」列が、列の全数の正本を名乗る第4.1.1節にも第7.4節の列表にも存在しない
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:249`（第4.1.1節の `jobs` 行）と同 `:1226-1238`（第7.4節「ジョブ行が持つ列」表）。要求している側は同 `:1294`（および `:1292` / `:1296` / `:2028`）
  - 理由: 第4.1.1節は「**本表はテーブルの全数と、認証・saga・ジョブ系テーブルの列の全数の両方の正本である。#37 が実テーブルと実列を判断する根拠はこの表である**」と自称し、`jobs` を **11列**（`operationKey` / `kind` / `payload` / `payloadDigest` / `attempt` / `nextRunAt` / `status` / `leaseUntil` / `ownerToken` / `providerIdempotencyKey` / `terminalReason`）と確定している。第7.4節の列表も同じ11列で、完了時刻に相当する列は無い。ところが同節 `:1294` は prune 規則を断定形で置き、「**削除は `status` と完了時刻の複合索引から引き、走査は bounded に保つ**」と書いている。`nextRunAt` は「次に実行してよい時刻」であって完了時刻ではなく、backoff で未来へ先送りされる列なので代用できない。結果として次の3つが実装不能になる — (i) `:1292` の「`done` と `poison` は**別々の保持期間**で prune し」、(ii) `:1296` の「`send-mail` の空振り行は**最も短い保持期間**を割り当てる」、(iii) `:2028` が #38 へ送っている「`jobs` の `done` / `poison` の保持期間と、`send-mail` の空振り行に割り当てる最短の保持期間」の運用値決定。第4.1.1節が同 `:238` で「第6〜9章で新しいテーブルや列を足したら、ここも同時に更新する」という保守規則を自ら置いているのに、その規則が適用されていない箇所である。なお同 `:242` の `account` は同種の値を `deletedAt` として独立列に持っているので、本書の記法上これは列を指している
  - 提案: 第4.1.1節の `jobs` 行と第7.4節の列表の両方に完了時刻列（例: `completedAt`）を足して**12列**にし、`:249` / `:255` の「11列」という件数表記と `:1294` の複合索引の記述を揃える。第4.1.1節は `:238` で「本表と第6〜9章の本文が食い違ったら本表を直す（本文が列を導入した理由を持つので、本文の側が正しい）」というタイブレークを既に持っているので、直す向きはその規則どおり本表の側である

- **[B-002]** 第7.4節 (1) の「駆動源クエリ」表に `sweep-orphan-mapping` と `rotate-encryption` の行が無く、両ジョブの再武装が未定義になっている
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:1275-1279`（駆動源クエリの表。`purge-trash` / `sweep-reservations` / `sweep-reset-tokens` の3行）。要求している側は同 `:1312`。`kind` の全数は同 `:1248`（`sweep-orphan-mapping`）と `:1255`（`rotate-encryption`）
  - 理由: `:1271` は再武装規則の射程を「**周期・反復ジョブの再武装規則（`purge-trash` / `sweep-*`）**」と glob で定め、`:1273` は「**`kind` ごとの対応は次のとおりで、作業述語と駆動源が同じ行集合を指すことが規則の要である**」として表を正本に据えている。ところが `sweep-*` は第4.1.1節・第7.4節ともに **3種**（`sweep-orphan-mapping` / `sweep-reservations` / `sweep-reset-tokens`）あり、表は2種しか覆っていない。さらに `:1312` は「**`sweep-*` / `rotate-encryption` は1回の起動で処理する行数に (iii-a) と同じ上限を掛け、残りを次の起動へ回す。「次の起動」を張るのは上の「周期・反復ジョブの再武装規則」であり、`sweep-*` は自分の駆動源（同節 (1) の表）を完了時に読み直して `nextRunAt` を設定する**」と、`rotate-encryption` まで同じ規則に乗せている。同節 (3) / (4)（`:1285` / `:1286`）は「駆動源が作業述語より広いと恒久ループ」「狭いと1回で `done` に落ちて止まる」という両方向の失敗モードを明示しているので、行の欠落はそのまま未定義の失敗モードになる。とくに `sweep-orphan-mapping` が1回で `done` に落ちると、`:1011` が「残った mapping は User Data DO の Alarm（`kind: 'sweep-orphan-mapping'`）が `credential_locators` との突き合わせで検出し、削除を再試行する」と位置づけた**孤児 mapping 回収の唯一の再試行経路**が止まる（第6.9節が締め出し経路として登録している事象）。#37 は駆動源述語を自分で決めるほかなく、Issue #34 の受け入れ条件「Alarm の適用範囲が決まっている」がこの2種について満たされていない
  - 提案: 表に2行足す。`sweep-orphan-mapping` は作業述語（`credential_locators` に対応する active 行が無い `operations.targetLocators` の未回収エントリ）から時刻条件を外した集合を駆動源にする形で、`rotate-encryption` は「`encryptionGeneration` が active 世代でない `credential_mappings` 行が存在するか」を駆動源にする形で書ける。あるいは `:1271` の射程を「`purge-trash` / `sweep-reservations` / `sweep-reset-tokens` の3種に限る」と明示し、`sweep-orphan-mapping` / `rotate-encryption` は `:1259` の cross-DO saga 前進ジョブ（backoff 再試行で駆動）として扱うと**表側ではなく射程側で**決め切ってもよい。どちらでも構わないが、`:1312` の `sweep-*` / `rotate-encryption` への言及と射程が一致していることが要る

#### Warnings

- **[W-001]** 第8.2節の「非集約ストアへの書き込み口の全数」が、第4.1.1節が非集約と分類した7ストアのうち3つしか覆っていない
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:1466`（第8.2節）。分類側は同 `:263`（第4.1.1節）
  - 理由: `:263` は「**`credential_locators` / `password_reset_tokens` / `jobs` / `operations` / `migration_progress` / `rotation_checkpoints` / `_meta` も持たない。いずれも集約ではなくアダプター内部のストアであり**」として非集約ストアを**7つ**列挙している（`credential_mappings` は `:262` が Directory 側ポート経由と位置づけているので除く）。一方 `:1466` は「**上のメソッド列挙は「その DO が持つ非集約ストア（`jobs` / `operations` / `migration_progress`）への書き込み口の全数である」**…**新しい非集約ストアを足したら必ずメソッドを1本足す。`ctx.storage.sql` の直接使用を禁じている以上、書き込み口をここに列挙しないと、そのテーブルは書く手段を持たないまま第4.1.1節に載ることになる**」と書いている。`credential_locators`（`:1060` の `record-credential-locator` による追加、`:1001` / `:1020` の unlink・退会での削除）、`password_reset_tokens`（`:692-698` の発行、`:941` / `:1002` / `:1019` の一括削除）、`rotation_checkpoints`（`:1088` / `:1098` の snapshot 置換）はいずれも本文が書き込みを明確に要求しているのに、`UnitOfWorkContext`（`:1430-1453`）に対応するメソッドが無い。**`:1466` が自ら警告している状態が、`:263` の分類に対して現に成立している**
  - 提案: `:1465` の禁止条項が「**usecase から**直接触る形は採らない」と主体を限定していることを利用して、`:1466` の「全数」の射程を明示する — すなわち「usecase が UoW 経由で書く非集約ストアの全数」と書き、`credential_locators` / `password_reset_tokens` / `rotation_checkpoints` / `_meta` はアダプター（DO facade / migration ゲート）が自分の `transactionSync` の中で書くストアとして射程外であることを1行で断定する。射程外にしない判断を採るなら、`UnitOfWorkContext` に対応するメソッドを足す

- **[W-002]** `testing.md` 確認項目14 の手順1 は、期待結果「出力が空」を満たさない（実行して確認）
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/testing.md:400-410`（手順1）と同 `:431`（期待結果「手順1・手順3 の出力が空」）
  - 理由: 実行すると `MISSING in design.md: application/ports/relayTrigger` と `MISSING in design.md: application/ports/idempotencyStore` の**2行が出る**。原因は design.md `:1212` / `:1925` が「`packages/core/src/application/ports/outboxRepository.ts` / `relayTrigger.ts` / `idempotencyStore.ts`」と**共通の親パスを1回だけ書く記法**を採っているため、`application/ports/relayTrigger` という連結文字列が存在しないことにある。内容（3本とも削除対象であること）は design.md に書かれているので #37 の引き継ぎ自体は成立するが、**testing.md の手順を実行した人は「引き継ぎ表に漏れがある」と誤判定する**。testing.md は「機械検証17件をすべて通したあとに人間判断へ進む」構成なので、通らない手順が残っていると検証全体の合否が宙に浮く
  - 提案: 手順1 の必須パス列挙のうち当該2件を `ports/relayTrigger.ts` / `ports/idempotencyStore.ts`（あるいは `relayTrigger.ts` / `idempotencyStore.ts`）へ縮めるか、期待結果に「この2件は design.md 側の親パス共通記法により MISSING と出るが正常」という但し書きを置く

- **[W-003]** `testing.md` 確認項目17 の手順1 は、期待結果「実測6件」「(i)(ii)(iii) 以外が1件でも増えたらリンク切れとして扱う」を満たさない（実行して確認）
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/testing.md:502`（期待結果）/ 同 `:503`（確認ポイント）
  - 理由: 実行すると `MISSING:` は **7件**出る。内訳は期待結果が挙げる6件（`.adr/002` / `.adr/003` / `.adr/004` / `.thread/19/adr.md` / `.thread/19/spike/fts5.integration.test.ts` / `apps/web/app/server.state.ts`）に加えて **`spec/adr/005`** である。これは design.md `:1774` / `:1791` / `:1793` が `spec/adr/005-search-index-via-outbox.md` を拡張子なしの短縮形で引いているもので、実体（`spec/adr/005-search-index-via-outbox.md`）は存在するため**リンク切れではない**。しかし testing.md の分類 (i) は「`.adr/002` / `.adr/003` / `.adr/004` の拡張子なし言及」と `.adr/` 側だけを列挙しているので、`spec/adr/005` はどの分類にも当たらず、`:503` の規則をそのまま適用すると**不合格と誤判定する**
  - 提案: 分類 (i) を「ADR 番号の短縮表記（`.adr/002` / `.adr/003` / `.adr/004` / `spec/adr/005` の拡張子なし言及）」へ広げ、件数を7へ更新する

- **[W-004]** 第3.2節の「新設する5つの秘密」「state 側の新設3秘密」が、同節の表が列挙する秘密の実数（4つ / state 側2つ）と合わない
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:170`（「新設する5つの秘密」）/ 同 `:172`（「state 側の新設3秘密は新設する `StateSecrets` の中に置く」）/ 同 `:1945`（第11.2節の `secrets.ts` 行）
  - 理由: design.md 全文に現れる新設の秘密は `AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET`（request 側2つ）と `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY`（state 側2つ）の**4つ**だけである（全大文字識別子の全走査で確認。5つ目の秘密名はどこにも現れない）。`:159-166` の表の state 側3行目は「メール送信プロバイダのバインディング」で、これは秘密ではなく Worker binding なので `StateSecrets` の中には置けない（`:173` が要求するブランド型・最小長32・keyring 検査のいずれも適用できない）。`:1945` は「**新設5秘密（`AI_CLIENT_TOKEN_SECRET` / `DIRECTORY_ROUTING_SECRET` / `IDENTITY_MAIL_ENCRYPTION_KEY` / `IDENTITY_RESET_TOKEN_KEY` と `StateSecrets` の枠）**」と書いて容器そのものを5つ目に数えることで辻褄を合わせているが、その数え方だと `:172` の「state 側の新設3秘密は**新設する `StateSecrets` の中に**置く」は「`StateSecrets` を `StateSecrets` の中に置く」になり成立しない。`secrets.ts` は #37 の改修対象として名指しされている（`:174` / `:1945`）ので、#37 は存在しない3つ目の state 側秘密を探すことになる
  - 提案: `:170` を「新設する4つの秘密」、`:172` を「state 側の新設2秘密」へ直し、`:1945` の「新設5秘密（… と `StateSecrets` の枠）」も「新設4秘密 + `StateSecrets` の新設」の形へ分けて書く。`:168` の「request Worker 側の3つ / state Worker 側の3つ」は表の行数（binding を含む）を指しているので、そちらは「秘密」ではなく「配布物」と読める表現にすると整合する

- **[W-005]** 第11.2節が #37 の入力として名指ししている `.thread/36/plan.md` / `.thread/36/adr.md` は、リポジトリに1度も commit されていない
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:1974`（「**`.thread/36/plan.md` の引き継ぎ表 H-1〜H-8 を #37 の入力として消化する**」）/ 同 `:1984`（`.thread/36/plan.md`）/ 同 `:1985`（`.thread/36/adr.md` の逐語引用）
  - 理由: `git ls-files .thread/36/` が0件、`git log --all -- .thread/36/` も空で、`.thread/36/` は**どのブランチにも存在しない untracked ディレクトリ**である（`git status` の `?? .thread/36/`）。現在の作業ツリーにだけ実在するので `testing.md` 確認項目17 のパス実在チェックは通るが、clone した #37 の担当者からは読めない。なお `testing.md` 確認項目15（自己完結性）の外部参照走査パターンは `issue/19/cloudflare-do-fts|\.thread/19/|git show|\.thread/1/adr\.md|spec/domains/search\.md` で、`.thread/36/` を射程に含んでいないため、この参照は H-3 の目視判定にも掛からない
  - 提案: 実害は小さい（H-1〜H-8 は `:1976-1985` の表に ID・失った検証・後継まで**全文が再掲**されており、`:1985` の `.thread/36/adr.md` からの引用も本文中に埋め込まれている）ので、design.md 側の1行を「`.thread/36/plan.md`（未 commit の作業ログ。要旨は下表に再掲済み）」と注記するだけで足りる。あわせて `testing.md` 確認項目15 の走査パターンに `\.thread/36/` を足すと、次回以降の自己完結性チェックが射程を取り戻す。**`.thread/36/` 自体を本 PR で commit してはいけない** — testing.md 確認項目6 の手順1 のホワイトリストを破り、エッジケース2 が名指しで禁じている

#### Notes

- **[N-001]** 成果物制約は全項目が適合している。`.adr/` は `001`〜`004` のちょうど4件で、差分は `A .adr/002` / `A .adr/003` / `A .adr/004` の3行のみ（`.adr/001` は `M` も改番も無し）。3件とも既存 `.adr/001` と同一の和文5節構成で、42 / 38 / 42行と薄さを保っており、禁止トークン（`CREATE TABLE` / `PRIMARY KEY` / `bucket` / 関数シグネチャ等）とコードフェンスはいずれも0件。`spec/adr/` は `M spec/adr/005-...` の1行のみで新規追加ゼロ、`## コンテキスト` 以降の全文比較が「本文不変」を返す。`.thread/1/adr.md` は `2 0`（追加2 / 削除0）で、挿入位置も ADR-004 の `Status` 直後の1行ポインタ + 空行のみ、ADR-002 / ADR-015 への波及なし。コード・コンフィグの差分はゼロ（`pnpm lint` 150ファイル / 2 infos、`pnpm format:check` 167ファイルで baseline と一致）。
- **[N-002]** 第11.1節の走査カバレッジ主張は**実測と完全一致**した。`spec/**/review/**` = 39ファイル（8ディレクトリの内訳も一致）、非レビュー md = 101ファイル、語彙走査ヒット = 62ファイル、手段2・3 が拾った3件（`spec/domains/export.md` / `spec/manual-tests/document.md` / `spec/manual-tests/settings.md`）は 62 に含まれないため手段1〜3 の合計65、残り36、`spec/usecases/review/002.md` の走査語ヒット7件、いずれも一致。改訂対象72 / 影響なし29 の内訳も、両表の行を機械抽出して展開すると**101ファイル全件にちょうど1つずつ判定が付き、重複も欠落も無い**ことを確認した。
- **[N-003]** 本文が主張する実測値・行番号引用は、抜き取りではなく機械的に当たれる範囲を全件突き合わせて**すべて一致**した。`adapters/d1` 20ファイル / 2,514行（プロダクション8ファイル / 914行）、`eventRelayWorker.ts` 301行、`outboxPrune.ts` 25行、`handlers.ts` 138行（`handleQueue` :82 / `handleDlq` :120）、`domain/common/event.ts` 81行、`identity/events.ts` 62行、`buildDecoder.ts` 37行、`identity/entity.ts` 227行（`:36` の判別共用体と `:52` / `:77` / `:103` / `:120` の4ファクトリ）、`unitOfWork.ts` 19行、`pendingBatch.ts` 98行、`wrangler.toml` 162行、`.thread/1/adr.md` 1,664行、`spec/domains/search.md` 271行、`spec/database/index.md` 403行、`spec/manual-tests/account.md` 562行、`db*` 10本 / `deploy*` 24本、`spec/adr/005` 参照6箇所、`TC-maintainSearchIndex-*` 28件 / `TC-pruneExpiredTrashItems-*` 17件。`types.ts:37,53,70` / `errorResponse.ts:70` / `currentUser.ts:28-33` / `valueObject.ts:47` / `registerWithPassword.ts:46,52,56` / `d1/unitOfWork.ts:39` / `helpers.ts:55-69` / `schema.ts:118` / `.tpl:21` / `server.cloudflare.ts:4,33,44` の各引用も現物と一致。spec 側の行番号引用（`requirements.md:87,108` / `database/index.md:350,355-357` / `domains/search.md:3,264` / `usecases/search.md:3,93` / `domains/trash.md:239` / `usecases/trash.md:315` / `domains/export.md:249,264,275` / `index.md:42` / `idea.md:40,48` / `scenario/*` / `pages/index.md:180` / `manual-tests/*` / `inventory/frontend.md:50,55-58`）も全件一致し、`spec/usecases/memo.md` の `collectEvents` 7箇所（`:51,232,359,396,434,474,572`）は行番号まで一致した。
- **[N-004]** 文書内の相互参照が全件解決する。`第N.M節` / `第N章` の参照はすべて実在する見出しへ解決し（未解決ゼロ）、`.adr/002〜004` が引く14の節・章参照もすべて実在。事実表の `F-1`〜`F-32`（`F-4b` / `F-27b` / `F-32b` を含む35件）は定義と参照が完全一致し、参照だけあって定義の無い ID はゼロ。`.adr/` → design.md（3件すべて）と design.md → `.adr/00[234]`（25行）の双方向参照も成立している。無修飾の `ADR-NNN` は1件だけで、`spec/usecases/knowledge.md:16` の逐語引用という許容ケースである。
- **[N-005]** #35 の受け入れ条件7項目はすべて着手可能である。第11.1節が受け入れ条件を左端に置いた対応表を持ち、7項目すべてに触る対象と本設計側の根拠節が付いている。とくに Issue 本文と設計の結論が食い違う2箇所を**訂正指示として明示**している点が良い — 受け入れ条件3 の「query / upsert / remove に単純化」は本設計の結論が `query` 1本なので `:1760` で訂正を指示し、`spec/usecases/review/002.md` を改訂対象から外す判断は `:1722` で理由付きで断定している。判断を #35 へ丸投げせず、覆すべきでない理由（`:1770` の signup 重複エラーの秘匿方針）まで書いてあるので、#35 が設計を再開させる余地が閉じている。
- **[N-006]** #37 の受け入れ条件11項目のうち9項目は根拠節つきで追える。Issue 本文の指示が設計と衝突する2箇所を**訂正指示として先回りしている**のが効いている — `new_sqlite_classes`（`:1602` の第9.1節。`[[migrations]]` 配列と `exports` は排他なので Issue どおりに書くと wrangler の設定検証で弾かれる）と、UoW 契約（`:1990`。Issue は「契約は維持したまま実装を差し替える」と書いているが第8.2節は契約ごと差し替える）。第8.2.1節が `transaction()` を使う案 (c) を**棄却理由つきで先に潰してある**（`:1497`「#37 が着手時にこの API を見つけて『これで済むのでは』と設計を再開させないよう、ここに理由を残す」）のも、実装 Issue への引き継ぎとして質が高い。残り2項目が B-001 / B-002 である。
- **[N-007]** 第11.4節の未決事項9件は、いずれも決める主体・時期・本設計への影響が埋まっており、`検討する` / `TBD` / `暫定` / `保留とする` 等の未決語は design.md 全文で**0件**である。9件のうち7件は「本設計への影響: 無い」（設計が事実に依存しないよう組んである）、2件は「値だけが2段階で決まる」（#37 が根拠値 → #38 が運用値）で、`.adr/003` の成否を左右する trigram / `bm25` の再確認だけが「覆れば決定そのものが成立しない」として `.adr/003` の影響節にも明記されている。第11.2節の「第11.4節は9行あり、9行とも #37 の着手時 spike を含む」「残り8件」という主張も実測と一致した。
- **[N-008]** 第4.3節の全数走査は再現可能な形で記録されており、実測と一致する。述語 (a)(b)(c) を表より先に置き、母集団（`spec/inventory/adapter.md` のユニーク `ADP-*` 85件）と再現コマンドを明記したうえで、表は枝番を含む35行・distinct `ADP-*` 53件で、台帳に残る32件がすべて `userId` 第一引数のポート（述語に当たらないもの）であることを確認した。行き先が空のデータ行はゼロ。「台帳は spec 由来であり、行の存在は実装の存在を意味しない」（`:299`）という但し書きが、#37 の作業がコード削除とは限らない（#35 の spec 撤回である場合がある）ことを取り違えから守っている。
