# C4 独立 quality review

実行日時: 2026-09-06T05:58:00+09:00〜2026-09-06T06:10:00+09:00
HEAD: `7d449cf62c548f2084b30568b3f99e5535b37a28`
対象 manifest: 64 files / `1349656447860181b48759580718c399846357e924e2c6ec5675f3447fd74b9b`
判定: **FAIL**

## Manifest

`phases/C4.md` の manifest block をそのまま SHA-256 化し、digest が指定値と一致することを確認した。全行を `shasum -a 256 -c` で独立照合し、64/64 paths が一致した。検証開始時と終了時の HEAD は同じである。

## Blocker

### B-C4-QUALITY-001: PITR で作成した新 DB を文書どおりに production へ切り替えられない

`docs/runtime_cloudflare.md` の「Rollback と PITR」は、Turso PITR から新 DB を作り、GitHub Environment の `DATABASE_IDENTITY`、`DATABASE_URL`、`DATABASE_AUTH_TOKEN` を新 DB へ変更して recovery deploy を実行するよう指示している。Turso PITR は既存 DB を上書きせず、復旧時点の内容を持つ新 DB を作る。このため新 DB には元 DB の `fog_deployment_identity` 行も複製され、`database_identity` は元 DB の authority のままになる。

新 DB の URL/identity を設定すると config/preflight は新 authority を要求する。一方、`migrate.cloudflare.node.ts` の `verifyOrBootstrapIdentity` は既存 marker の authority が新 config と違えば schema migration 前に必ず `Database identity marker does not match the selected stage` を送出する。`DATABASE_IDENTITY_BOOTSTRAP=true` は table がない場合だけ marker を作るため、複製済み table/rowを移管できない。文書自身も bootstrap で mismatch を回避できず、marker を書き換えてはならないとしている。したがって手順 5 の接続先切り替え後、手順 6 の migration は決定的に失敗する。

再現手順:

1. `fog-production.old-host` identity marker を持つ production DB を用意する。
2. PITR から `fog-production-recovery.new-host` を新規作成する。marker は旧 authority を保持する。
3. 文書どおり `DATABASE_IDENTITY` と `DATABASE_URL` を新 DB authority に変更する。
4. recovery deploy の migration を実行する。
5. marker mismatch で schema/deploy 前に停止する。bootstrap を `true` にしても結果は変わらない。

実 credential を使う PITR は禁止範囲のため未実行だが、この分岐は `pnpm exec vitest run apps/web/scripts/cloudflareStage.test.ts -t 'rejects a wrong marker and an unauthorized token before migration'` の wrong-marker case 1/1 PASS と、既存 table では bootstrap 分岐へ入らないコードで確認した。[Turso の公式 PITR](https://docs.turso.tech/features/point-in-time-recovery)も新 DB と新しい接続情報への切り替えを契約としている。

修正要求: accidental wrong-DB を fail closed に保ったまま、承認・監査可能な marker identity 移管コマンドまたは別の安全な DB 切り替え契約を実装し、その具体的な手順、rollback、再実行性を文書化する。

## Warnings

### W-C4-QUALITY-001: Email Service の初期準備が操作可能な手順になっていない

「Cloudflare Email Service を利用可能にし、2 つの sender を許可する」だけでは、sender domain の onboarding/verification と DNS、任意 recipient への送信条件を実行者が判断できない。Workers Paid と sender/recipient/quota/bounce の外部受け入れ gate は記載されているため fail closed だが、初回配備手順として不足する。[Send bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/)、[pricing](https://developers.cloudflare.com/email-service/platform/pricing/)、[limits](https://developers.cloudflare.com/email-service/platform/limits/)に沿って domain onboarding と verification を明示する。

### W-C4-QUALITY-002: Cron の時刻基準が明示されていない

`0 3 * * *` を「ゴミ箱の保持期限処理」と記載しているが、Cloudflare Cron Triggers は UTC で評価される。運用者が日本時間 03:00 と解釈できるため、`03:00 UTC` と trigger 変更の反映遅延を明記する。[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)

### W-C4-QUALITY-003: recovery dispatch の起動 ref が明示されていない

production Environment は `main` のみ許可する一方、`workflow_dispatch` の手順は release tag と SHA しか指定していない。GitHub UI/CLI では workflow ref を選択できる。非 `main` ref は validation checkout が `main` でも Environment branch policy で停止するため安全側だが、復旧操作として不完全である。workflow 自体を `main` ref から起動するよう明記する。

### W-C4-QUALITY-004: health/smoke の障害時契約が文書から欠ける

実装は `GET`/`HEAD`、DB readiness 失敗時 503、常時 `Cache-Control: no-store` を持ち、smoke は 18 attempts、request timeout 10秒、retry 5秒、失敗時も response body をログへ出さない。文書は成功時の GET 200 と exact identity だけを記載する。監視・障害対応に必要な 503/no-store、retry/timeout、body 非出力を現在の運用契約として追記する。

## 文書照合

| 対象 | 判定 | 根拠 |
| --- | --- | --- |
| `README.md` | PASS | Node/Cloudflare runtime、主要 command、運用文書への導線、workspace 構成が package scripts と実装に一致する。 |
| stage/secret/bootstrap/migration | PASS（PITR切り替えを除く） | stage別 Worker/host/sender/callback、Environment keys、独立 DB authority、初回 bootstrap、transaction migration の契約が template、preflight、workflow、CLI と一致する。 |
| main→staging→Release Please→production | PASS | trigger、staging deployment、Release/tag/main/run/job検証、approval後再検証、exact SHA build/deploy が workflow と一致する。 |
| recovery | WARNING | release tag/SHA と既存 staging success の制約は一致するが、workflow dispatch ref の指定がない。 |
| Cron/health/smoke | WARNING | schedules と exact host/SHA/env/DB identity は一致するが、UTC と障害時 health/smoke 契約が不足する。 |
| rollback/PITR | FAIL | 新 DB の marker identity を安全に移管できず、記載手順が migration で停止する。 |
| Workers Paid/Turso/OAuth/GitHub | PASS（外部 gate あり） | 必須 resource と未検証 gate を区別している。実 account/resource は変更していない。 |
| Email Service | WARNING | Paid/sender/recipient/quota/bounce gate はあるが、domain onboarding/verification の操作がない。 |
| doc-style / markdown-style | PASS | 現在形の断定、見出し階層、表、空行、番号付き手順、言語付き fence は一貫する。経緯・弁明・見出し代用の強調・水平線はない。 |

## 独立検証

| command / 検査 | 結果 |
| --- | --- |
| `pnpm typecheck && pnpm lint && pnpm format:check` | PASS。root/core/web type error 0、lint error 0、format 229 files。既存の unsafe suggestion info 1件のみ。 |
| `pnpm test:unit` | PASS、16 files / 182 tests。 |
| `pnpm test:integration:node` | PASS、6 files / 94 tests。 |
| `pnpm test:integration:cloudflare` | PASS、2 files / 8 tests。終了時の既知 workerd disconnect 診断のみ、exit 0。 |
| `pnpm build:node` | PASS。既存 CSS filename conflict warning のみ。 |
| staging render、production render、pair validation | PASS。互いに異なる example DB identity と 40桁 SHA を使用。 |
| staging fresh build / dry-run | PASS、136 modules、3357.20 KiB / gzip 705.98 KiB。 |
| production fresh build / dry-run | PASS、136 modules、3357.20 KiB / gzip 705.98 KiB。 |
| artifact secret scan | PASS。raw example DB URL、secret assignment/value、`.env`/`.dev.vars` は 0。literal `libsql://` は URL boundary validator のみ。 |
| artifact Node-only scan | PASS。Node listener、`node:fs`/`node:net`/`node:tls`、SMTP、migration、Node dist、symlink は 0。`server.node.ts` の文字列2 assetsは共有 container の JSDoc/診断文だけで module 混入ではない。 |
| `/Library/Developer/CommandLineTools/usr/bin/git diff --check` | PASS。whitespace error 0。 |

Cloudflare build は実 runtime secrets を渡さないため、Wrangler の required secrets warning を表示した。dry-run は共通 preflight と provenance を通過し、外部 side effect なしで成功した。

## 未検証 gate

- Cloudflare account/zone/Workers Paid/custom domain/TLS/API token/Email Service
- Turso remote migration の5秒 transaction条件、競合、PITR、token権限
- Google OAuth client/consent screen/exact callback
- GitHub Environments/reviewer/branch policy/Release Please token/GitHub-hosted delivery
- 実 Workers CPU/memory、Cron、Email配送、公開 health smoke

外部 credential と resource がないため、実サービスは read/write とも実行していない。ローカル検証の PASS はこれら外部受け入れ gate を代替しない。
