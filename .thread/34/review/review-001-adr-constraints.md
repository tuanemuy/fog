# レビュー 001 — ADR・成果物制約

- **対象:** PR #43（`issue/34/do-boundary-design`、commit `ed1bc7a`）
- **Issue:** #34（設計フェーズ・コード変更なし）
- **観点:** ADR の置き場所・採番・supersede・粒度、成果物制約（コード / コンフィグ非変更、スコープ外の非混入）
- **実施日:** 2026-07-29

## 総評

Issue #34 が最大の失敗要因として名指しした「成果物の置き場所の取り違え」については、**構造的な違反はゼロ**。`.adr/` は 001 の続きで 002/003/004 の3件ちょうど、`spec/adr/` への新規追加なし、`.thread/1/adr.md` は削除行ゼロ・追加2行（空行1 + ポインタ1）、`spec/adr/005` は `## ステータス` 節のみの変更で `## コンテキスト` 以降がバイト単位で不変、差分は Markdown 9ファイルのみ。testing.md の機械検証項目1〜6・16・17 をすべて実行し、期待結果と一致した。

ただし `.thread/34/design.md` に**生の NUL バイトが2個混入している**ため、`grep` がこのファイルを binary 扱いし、testing.md のうち design.md を走査する検証項目（7〜15・17）が**すべて無出力＝偽の合格**になっていた。`grep -a` で再実行した結果は内容としてはパスするので中身の問題ではないが、PR 本文の「自己検証は全項目パス済み」という主張の根拠が実質的に空振りしていたため Blocker とする。

内容面では、`.adr/` の薄さは保たれている（41 / 37 / 42 行。既存 001 が44行）一方で、**ドメインイベントの全廃という波及の大きい帰結が `.adr/004` から読み取れない**という逆方向の漏れが1件ある。

---

### ADR・成果物制約

#### Blockers

- **[B-001]** `.thread/34/design.md` に生の NUL バイト（`\x00`）が2個混入しており、`grep` が binary 扱いして testing.md の design.md 系検証がすべて偽の合格になっている
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.thread/34/design.md:352`（col 249）/ `:448`（col 167）
  - 理由: 両行とも `provider + "<NUL>" + subject` を canonical とする旨の説明で、**エスケープ表記（`\0` / `U+0000`）として書くべきところに実バイトの `0x00` が入っている**。結果として `file(1)` はこのファイルを `data` と判定し（他の `.thread/34/*.md` はすべて `Unicode text, UTF-8 text`）、`grep` は `-a` なしで一切のマッチを返さなくなる。testing.md は design.md を45箇所で `grep` しており、確認項目7〜15・17 がその影響下にある。とくに**無出力を合格条件にしている手順が偽陽性になる** — 実測で確認したもの:
    - 項目7 手順3（未決語 `検討する|TBD|暫定|…` の全文走査）→ `-a` なしで無出力。「未決語なし」と読める
    - 項目7 手順4（第4〜6章の暫定表現）→ 同上
    - 項目15 手順1（先行ブランチ・`.thread/19/` への外部参照の洗い出し = AC-19）→ `-a` なしで design.md 側のヒットが0件になり、`.adr/002` の1行しか出ない
    - 項目17 手順1・2（リンク実在チェック / 無修飾 `ADR-NNN`）→ 同上
    - 項目8 手順1（`^## .*User Data DO` の存在確認）のように**ヒットを合格条件にしている手順は逆に偽の失敗**になる（実測 `rc=1`）
  - 提案: 2箇所の実 NUL バイトを可視のエスケープ表記（例: `` `\0`（U+0000）`` ）へ置換する。あわせて testing.md の design.md を対象とする `grep` に `-a` を付けるか、`LC_ALL=C grep` へ揃えて再発を塞ぐ。**なお `grep -a` で全項目を再実行したところ、当該観点の検証はすべて期待結果どおりパスする**（下記「実行ログ」参照）ので、設計本文の書き直しは不要

#### Warnings

- **[W-001]** ドメインイベントを `collectEvents` ごと全廃する決定が `.adr/` から読み取れない（薄さの取りすぎ / 逆方向の漏れ）
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.adr/004-do-local-commit-and-alarm-jobs.md:26` および `:40`
  - 理由: `.adr/004` はこの件について「ドメインイベントを配送の transport として扱うのをやめる」（決定 `:26`）と「ドメインイベントを配送の transport として扱わない。イベント定義に依存していた仕様の記述は改訂対象になる」（影響 `:40`）の2行しか持たず、しかも両者はほぼ同義の反復である。一方で実際の決定は `.thread/34/design.md:653`（第7.3節）と `.thread/34/adr.md` ADR-024 のとおり「**業務・監査の表現としても残さない。`UnitOfWorkContext.collectEvents` を廃止する**」であり、「transport として使わない」より一段強い。`.adr/` だけを読む読み手（architecture-audit / spec-sync）は「ドメインイベントの概念は残るが配送には使わない」と誤読する。この判断は寿命テスト（`CLAUDE.md` の Key concepts が「Outbox / domain events」を中核概念として挙げている以上、消えた理由は将来の読み手に意味を持つ）・波及テスト（`application/ports/{outboxRepository,relayTrigger,idempotencyStore}.ts` の3本削除、UoW 契約の変更、`spec/domains/*.md` のイベント定義表の全削除、`CLAUDE.md` の改訂）をどちらも通る。`.thread/34/adr.md` ADR-022 は同じ性質の帰結（ドメインポートの `Promise` 契約）について「`.adr/` しか読まない読み手にこの波及が見えないのは穴なので、影響節に残す」と判断しており、その基準をこの件にも当てるのが一貫する
  - 提案: `.adr/004` の影響節 `:40` を「ドメインイベントは配送の transport としても業務表現としても残さない。UoW からのイベント収集そのものを廃止する。イベント定義に依存していた仕様の記述は改訂対象になる（具体は `.thread/34/design.md` 第7.3節）」程度に強める。決定節 `:26` との重複が解消され、行数も増えない

- **[W-002]** `.adr/002` の決定節が、同じ節ですでに述べたトポロジーを末尾で「未確定」と扱っており、内部で食い違う
  - 場所: `/Users/hikaru/github.com/tuanemuy/fog/.adr/002-cloudflare-workers-and-user-data-durable-objects.md:25`（`:21`〜`:23` との対比）
  - 理由: `:21` が「各利用者のドメインデータを1つの Durable Object に置き」、`:23` が「利用者が確定していない経路（ログイン、サインアップ、パスワードリセット）の解決は、別の Durable Object が担う」と述べており、この2文で**2クラス構成はすでに決定されている**。にもかかわらず直後の `:25` が「Durable Object のトポロジー（**何クラス構成にするか**）、認証権威の所在、Worker を request / state に分けるかは `.thread/34/design.md` の第3章で確定する」と書いており、決定節の中で自らの決定を未確定へ差し戻す形になっている。加えて永続台帳のエントリが未来形（「確定する」）で終わっているため、後年に単独で読むと「この ADR は結論を出していない」と読める。なお `.thread/34/adr.md` ADR-021 が Account Home DO 不採用を `.adr/` へ昇格させないと決めた判断自体は妥当（Issue が「トポロジーの具体は `.thread/34/`」と指示している）ので、問題は昇格の要否ではなく**この1文の書き方**にある
  - 提案: `:25` から「何クラス構成にするか」を落とし、残る2点（認証権威の所在、Worker の request / state 分割）を過去形の導線へ書き換える。例: 「認証権威の所在と Worker を request / state に分けるかの具体は `.thread/34/design.md` の第3章にある。」

#### Notes

- **[N-001]** 置き場所の制約は全項目クリア。testing.md 項目1〜6・16・17 を実行し、期待結果と完全一致した（下記「実行ログ」に全出力）。とくに Issue が名指しした4点 — `.adr/` が既存001 + 新規3件の計4件ちょうど / `spec/adr/` に `A` がゼロ / `.thread/1/adr.md` が `2 0`（追加2・削除0） / 差分が Markdown のみ — はいずれも機械的に確認済み

- **[N-002]** supersede の正本が新 `.adr/` 側に置かれており、旧側は最小限のポインタに留まっている。`.adr/002:7` が `.thread/1/adr.md` ADR-004 を、`.adr/003:7` と `.adr/004:7` が `spec/adr/005` を**両方から**名指しし、しかも「003 が根拠側 / 004 が方式側」と分担まで明示している。逆向きの `spec/adr/005` ステータス行も両方の新 ADR を指しており、双方向で整合が取れている。旧 ADR の本文改変ゼロという adr-guide の原則（`adr-guide.md:45`）も守られている

- **[N-003]** `.adr/` の薄さは保たれている。実測で 002 = 41行 / 003 = 37行 / 004 = 42行（既存 001 は44行）、禁止トークン（`CREATE TABLE` / `PRIMARY KEY` / `bucket` / `=>` / `): Promise<` ほか）のヒットゼロ、コードフェンスゼロ。bucket 数（256）・saga 手順・migration 手順・スキーマ断片はいずれも design.md 側にのみ存在する。逆方向の漏れについては、最大の波及であるドメインポートの同期化が `.adr/004:41` に1行で残っており（`.thread/34/adr.md` ADR-022 に昇格判断の根拠あり）、`CLAUDE.md`「Reference runtime」の前提が破れる点まで書かれている。漏れているのは W-001 の1件のみ

- **[N-004]** `.thread/1/adr.md` ADR-004 は Status が `Proposed` のまま据え置かれ、その直後に1行ポインタだけが追記されている（`:164`→`:166`）。adr-guide `:45` の「旧 ADR のステータスを『superseded by NNN』に更新する」とは形が異なるが、Issue #34 の「`.thread/1/` は当時の作業ログであり本文は改変しない。追記するとしても1行ポインタまで」が優先する場面なので妥当。挿入位置も AC-8 が固定した書式（`Proposed` の直後・空行1 + ポインタ1）どおり

- **[N-005]** スコープ外の混入なし。`spec/` 本体・`CLAUDE.md`（#35）、ランタイム撤去（#36）、実装（#37）のいずれにも手が入っていない。`spec/index.md:38-43` の ADR 一覧表は未変更のままで、`.thread/34/design.md:979` の #35 引き継ぎ表に改訂対象として登録されている（この表には状態列が無いため、現時点で誤りになっている記述もない）。作業ツリーに残る既知の untracked 6エントリ（`.artifacts/` / `.thread/36/` / `apps/web/wrangler.{request,state}.{production,staging}.toml`）も巻き込まれていない

- **[N-006]** `.thread/34/adr.md` は着手時点の19件から27件へ増えており（ADR-020〜027）、`.adr/` へ昇格させなかった判断の根拠がすべて残っている（AC-18 充足）。とくに ADR-021（Account Home 不採用を昇格させない）・ADR-022（ドメインポート同期化を影響節1行に留める）・ADR-026（bucket 数の具体値は design.md にだけ書く）は、いずれも「`.adr/` を薄く保つ」原則と「読み手に波及が見えないのは穴」という反対圧力を両方明示して結論を出しており、粒度の判断過程が追跡可能になっている

---

## 検証した受け入れ基準

| AC | 内容 | 判定 | 根拠 |
|---|---|---|---|
| AC-1 | `.adr/002〜004` が存在し、5節構成・H1 書式が 001 に揃う | ✅ | `ls -1 .adr/ \| wc -l` = 4。H1 4件すべて `H1 OK`。5節見出し3件すべて `5節 OK`（既存 001 の見出し列と `diff` 完全一致） |
| AC-2 | 3件以外の新規 ADR が増えていない | ✅ | `git diff --name-status main...HEAD -- .adr/` が `A` 3行のみ。`005` 以降なし。`git status --porcelain` に `.adr/` の `??` なし |
| AC-3 | 採番が 001 の続き。既存 001 を上書き・改番していない | ✅ | 差分に `.adr/001-*.md` の行が1本も現れない |
| AC-6 | `.adr/` に実装レベルの詳細が流れ込んでいない | ✅ | 禁止トークン走査 exit 1、コードフェンス exit 1、行数 41/37/42（50行以内） |
| AC-7 | `spec/adr/005` は本文保持のままステータス行に supersede ポインタ | ✅ | `## コンテキスト` 以降の `diff` が「本文不変 OK」。ポインタが `.adr/003` と `.adr/004` の両方を指す |
| AC-8 | `.thread/1/adr.md` は1行ポインタの追記のみ | ✅ | `git diff --numstat` = `2 0`。削除行ゼロ。挿入位置が `Proposed` 直後 |
| AC-9 | `spec/adr/` にファイルが追加されていない | ✅ | `git diff --name-status main...HEAD -- spec/adr/` が `M spec/adr/005-*.md` の1行のみ。`git status --porcelain \| grep spec/adr/` が空 |
| AC-10 | supersede の正本が新 ADR 側にある | ✅ | `.adr/002:7` → `.thread/1/adr.md` ADR-004、`.adr/003:7` / `.adr/004:7` → `spec/adr/005`。いずれもステータス節（`:3` の直下） |
| AC-19 | 成果物の自己完結性（機械走査部分） | ✅※ | `grep -a` 再実行で、外部参照はすべて「出自の注記」文脈。`MISSING:` は先行ブランチ上の `.thread/19/*` 2件と #37 で新設する `apps/web/app/server.state.ts` のみ。※ `-a` なしでは検証自体が空振りする（B-001） |
| AC-20 | コードもコンフィグも変更していない | ✅ | ホワイトリスト濾し・拡張子走査・未コミット確認の3手順すべて exit 1（出力ゼロ） |
| AC-18 | 昇格見送りの判断が `.thread/34/adr.md` に記録 | ✅ | ADR 件数 27（着手時19）。ADR-020〜027 が追記され、`.adr/002〜004` の主題と重複しない |

補足: AC-4 / AC-5 / AC-11〜AC-17 / AC-21〜AC-23（design.md 内容の妥当性）は本観点の担当外だが、B-001 の影響でこれらに対応する testing.md 項目7〜15 の機械手順が偽の結果を返す点は、担当観点のレビュアーへ申し送りが必要。

## 実行ログ

すべて `/Users/hikaru/github.com/tuanemuy/fog` で実行。

### 差分の全体像

```
$ git diff --name-status main...HEAD
A	.adr/002-cloudflare-workers-and-user-data-durable-objects.md
A	.adr/003-sqlite-fts5-only-search.md
A	.adr/004-do-local-commit-and-alarm-jobs.md
M	.thread/1/adr.md
A	.thread/34/adr.md
A	.thread/34/design.md
A	.thread/34/plan.md
A	.thread/34/testing.md
M	spec/adr/005-search-index-via-outbox.md

$ git diff --numstat main...HEAD
41	0	.adr/002-...   37	0	.adr/003-...   42	0	.adr/004-...
2	0	.thread/1/adr.md
892	0	.thread/34/adr.md   1059	0	.thread/34/design.md
1292	0	.thread/34/plan.md   592	0	.thread/34/testing.md
1	1	spec/adr/005-search-index-via-outbox.md
```

### testing.md 項目1（`.adr/` の件数・採番・書式）

```
$ ls -1 .adr/ | wc -l
4
$ git diff --name-status main...HEAD -- .adr/
A .adr/002-... / A .adr/003-... / A .adr/004-...   ← 001 の行なし
$ (H1 チェック) → 4件すべて H1 OK
$ (5節厳密比較) → 3件すべて 5節 OK
```

### testing.md 項目2（薄さ）

```
$ grep -nEi 'CREATE TABLE|INSERT INTO|SELECT .* FROM|PRIMARY KEY|UNIQUE INDEX|bucket|=>|\): Promise<' .adr/00[234]-*.md
exit=1
$ wc -l .adr/00[234]-*.md
41 / 37 / 42
$ grep -n '^```' .adr/00[234]-*.md
exit=1
```

### testing.md 項目3（supersede の正本）

```
$ grep -n '\.thread/1/adr\.md' .adr/002-*.md
7:  ADR-004「ランタイム選定 …」を supersede する。   ← ## ステータス（:3）の直下
40: ADR-002 のトレードオフへの波及（## 影響 内）
$ grep -n 'spec/adr/005' .adr/003-*.md .adr/004-*.md
003:7 / 003:13 / 003:36 / 004:7   ← 両ファイルでヒット
```

### testing.md 項目4・5（旧 ADR の扱い）

```
$ git diff --name-status main...HEAD -- spec/adr/
M	spec/adr/005-search-index-via-outbox.md          ← A なし
$ git status --porcelain | grep 'spec/adr/'
(空)
$ diff <(git show main:spec/adr/005-*.md | sed -n '/^## コンテキスト/,$p') \
       <(git show HEAD:spec/adr/005-*.md | sed -n '/^## コンテキスト/,$p')
本文不変 OK
$ git diff --numstat main...HEAD -- .thread/1/adr.md
2	0	.thread/1/adr.md
$ grep -n -A 8 '^## ADR-004' .thread/1/adr.md
162: ### Status / 164: Proposed / 165: (空行) / 166: → `.adr/002-...md` に supersede された。 / 168: ### Context
```

### testing.md 項目6（コード・コンフィグ非変更）

```
$ git diff --name-status main...HEAD | grep -vE '^[AM][[:space:]]+(\.adr/00[234]-.*\.md|\.thread/34/.*|spec/adr/005-.*\.md|\.thread/1/adr\.md)$'
exit=1
$ git diff --name-only main...HEAD | grep -E '^(packages/core/|apps/web/app/|infra/)|\.(ts|tsx|toml|json|sql)$'
exit=1
$ git status --porcelain | grep -vE '^\?\? (\.artifacts/|\.thread/36/|apps/web/wrangler\.(request|state)\.(production|staging)\.toml)$'
exit=1
```

### testing.md 項目16・17

```
$ grep -cE '^## ADR-[0-9]{3}' .thread/34/adr.md
27          ← 着手時19 → ADR-020〜027 が追記
$ (17-1 リンク実在チェック、grep -a) → MISSING: .thread/19/adr.md / .thread/19/spike/fts5.integration.test.ts / apps/web/app/server.state.ts
              ※ 前2件は先行ブランチ上のみ、3件目は #37 で新設。testing.md の期待どおり
$ (17-2 無修飾 ADR-NNN、grep -a) → exit=1（ヒットなし）
$ (17-3 双方向参照) → .adr/ → design.md は 7箇所ヒット。design.md → .adr/ は
              grep -a 付きで 18箇所ヒット（-a なしでは 0 件＝B-001）
```

### B-001 の再現

```
$ file -b .thread/34/design.md
data                                    ← 他の .thread/34/*.md は「Unicode text, UTF-8 text」
$ iconv -f UTF-8 -t UTF-8 .thread/34/design.md >/dev/null && echo valid
valid utf8                              ← UTF-8 としては妥当。混入しているのは制御バイト
$ LC_ALL=C perl -ne 'while (/\x00/g) { print "line $. col ", pos($_), "\n" }' .thread/34/design.md
line 352 col 249
line 448 col 167
$ grep -cE '^#{3,4} ' .thread/34/design.md     → (空・rc=1)
$ grep -a -cE '^#{3,4} ' .thread/34/design.md  → 62
```

該当行（NUL を `[NUL]` に置換して表示）:

```
352: … **provider 名だけを lowercase 化**して `provider + "[NUL]" + subject` を canonical とする（区切りに NUL を使うのは、…）。
448: … canonical は第5.2.1節 (c) の `provider + "[NUL]" + subject`。…
```

`git` 側は先頭8000バイトに NUL が無いためテキストとして扱っており（`--numstat` が `1059 0` を返す）、差分表示・行数計上には影響していない。影響するのは `grep` / `file` を使う検証系のみ。
