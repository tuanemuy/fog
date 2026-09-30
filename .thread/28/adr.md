# 設計判断 — Issue #28

## ADR-001: wrangler は `cloudflare/wrangler-action` ではなくリポジトリの pnpm script で呼ぶ

### Context

Issue は deploy に `cloudflare/wrangler-action` を使い、`wranglerVersion` を `apps/web` の devDependency と同じ値に固定するよう書いていた。一方 request Worker は `scripts/deploy-built.ts` が「成果物がこの stage のビルドか」を検査してから `wrangler deploy --config dist/server/wrangler.json` を呼ぶ形になっている（#3）。

### Decision

workflow は `pnpm "deploy:$STAGE:all"`・`pnpm secrets:push`・`pnpm --filter @repo/web exec wrangler queues update` を呼び、wrangler-action を使わない。

### Consequences

- stage 検査と build → state → request の順序を、手作業と同じ script（`deployScripts.test.ts` が固定済み）で通す
- wrangler のバージョンは lockfile が決める。action の入力に同じ値を書き写す二重管理が無い

## ADR-002: 平文の secret はファイルに書かず、メモリから wrangler の stdin に渡す

### Context

Issue は復号した平文を `umask 077`・`mktemp`・`trap` で step 内のファイルに閉じ、検証 step と注入 step で共有しない形を書いていた。`wrangler secret bulk` は引数のファイルを省くと stdin を読む（wrangler 4.90.1 の `parseBulkInputToObject`）。

### Decision

`scripts/stage-secrets.ts` が `sops --decrypt` の出力をメモリに持ち、判定を通った分だけ `JSON.stringify` して `wrangler secret bulk --config <config>` の stdin に渡す。`check` と `push` はそれぞれ自分で復号する。

### Consequences

- 平文ファイルの寿命管理（trap の漏れ、`$GITHUB_ENV` 経由の受け渡し）がそもそも無い
- ローカルでも workflow と同じコマンドを打てる
- 「ディスクに書かない」ことは CLI の形で成り立ち、それを見張る test は無い（docs 第 3 章に限界として記載）

## ADR-003: secret の検証を workflow の先頭（Pulumi より前）に置く

### Context

Issue の順序は render → build → 検証 → deploy だった。検証が要るのは復号と `.dev.vars.example` の roster だけで、Pulumi の出力も build も要らない。

### Decision

install と sops の導入の直後に `pnpm secrets:check` を置く。それより前の step には Cloudflare / Pulumi の credential を渡さない（`deployWorkflow.test.ts` が固定）。

### Consequences

bad な secret ファイルは Pulumi・両 Worker のどれにも触れずに落ちる。bootstrap 前の実行もここで落ち、何も変えない。

## ADR-004: 注入の後に、Worker に実在する secret 名とファイルを照合する

### Context

契約の読みで「`wrangler secret bulk` は消さないので、手作業で相手 Worker に入れた key・退役後の rotation 用 key・ファイル間で移した key が残っても検出できない」と指摘された。Issue の現状欄は「入れ忘れ・入れ先の取り違えを検出する手段が無い」ことを問題にしている。

### Decision

`push` はアップロードの後に `wrangler secret list --format json` を Worker ごとに読み、ファイルの key 集合と一致しなければ失敗し、`wrangler secret delete <NAME> --config <config>` を示す。自動では消さない。

### Consequences

- 取り残しは次の deploy で赤になり、消すかファイルに戻すまで赤のまま
- 障害時に手で入れた secret も、ファイルに戻すまで deploy を赤にする。消すのは人の判断に残す（自動削除は、事故対応で入れた値を次の deploy が黙って消す）

## ADR-005: 必須 key は roster の rotation 用以外すべて（`OPERATOR_TOKEN`・`GOOGLE_*` を含む）

### Context

`OPERATOR_TOKEN` は未設定なら operator 面が消える、という運用が `.dev.vars.example` に書かれている。Issue は期待集合を「roster の所有分（rotation 用は optional）」としている。

### Decision

deployed stage では `OPERATOR_TOKEN` と `GOOGLE_*` も必須にする。未設定で面を消す状態は local だけのものとして `.dev.vars.example` と docs に書く。

### Consequences

production の回復手段（第 8 章の operator 面）が secret の入れ忘れで消えることは無い。Google SSO を使わない stage を作るなら、roster に optional の印を足す変更になる。

## ADR-006: 注入は deploy の後の `wrangler secret bulk`（`deploy --secrets-file` にしない）

### Context

wrangler 4.90.1 には `wrangler deploy --secrets-file` があり、コードと secret を 1 つの version で上げられる。deploy の後に `secret bulk` する形では、新しいコードが新しい secret を要るとき、2 つの step の間だけ新コードが旧 secret で動く。

### Decision

ユーザーの判断で、Issue どおり deploy の後に `secret bulk` する。`--secrets-file` は平文を一時ファイルに置く必要があり、request 側は `deploy-built.ts` と pnpm script に引数を通す改修が要る。

### Consequences

その窓は docs 4.2 に書き、新しい secret を要する release では、その 1 つを deploy の前に手で入れる手順を示した。

## ADR-007: `secret bulk` の成否は wrangler の出力の件数で確かめる

### Context

差分の読みで、`wrangler secret bulk` は stdin が空か読めないとき何も上げずに exit 0 で終わる（`parseBulkInputToObject` が undefined を返し、`No content found` を出すだけ）と指摘された。名前の照合は、名前が既にあれば値が届かなくても通る。

### Decision

`secret bulk` の stdout を受け取り、`✨ <N> secrets successfully uploaded` の N が送った件数と一致しなければ失敗にする。

### Consequences

stdin の配線が壊れても、値だけ届かない状態は赤になる。wrangler がこの文言を変えると push が赤になる。黙って通るより赤のほうを選んだ。
