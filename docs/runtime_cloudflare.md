# Cloudflare 運用

Fog のクラウド本番 runtime は Cloudflare Workers と Turso の remote libSQL で構成する。`main` の各更新を staging へ配備し、Release Please が作成した GitHub Release の commit だけを production へ配備する。

## 構成

| 項目 | staging | production |
| --- | --- | --- |
| GitHub Environment | `staging` | `production` |
| Worker | `fog-staging` | `fog-production` |
| custom domain | `staging-fog.DOMAIN` | `fog.DOMAIN` |
| `APP_URL` | `https://staging-fog.DOMAIN` | `https://fog.DOMAIN` |
| Google callback | `https://staging-fog.DOMAIN/auth/google/callback` | `https://fog.DOMAIN/auth/google/callback` |
| sender | `fog-staging@DOMAIN` | `fog@DOMAIN` |
| Turso DB 名の接頭辞 | `fog-staging` | `fog-production` |

`DOMAIN` は Cloudflare で管理する ICANN の apex domain とする。Worker 名、host、callback、sender は `DOMAIN` と stage から生成する。個別の上書きは行わない。

staging と production は別の Worker、Turso DB、DB token、Google OAuth client、GitHub Environment を使う。production の credential を staging に登録しない。

Cloudflare Workers Paid plan を使う。Fog の password KDF は scrypt の強度を下げずに実行し、同時実行数と待機数を制限する。Free plan の CPU 上限を前提にしない。128 MB の Worker memory 上限内で KDF、request、scheduled handler の実測を行う。

## 外部サービスの準備

### Cloudflare

- `DOMAIN` の zone と 2 つの custom domain を同じ Cloudflare account で管理する。
- Workers Paid plan を有効にする。
- `fog-staging` と `fog-production` を作成できる API token と account ID を各 GitHub Environment に登録する。
- API token は次の permission template で作成し、対象 account、対象 zone、有効期限を限定する。
- Cloudflare Email Service で `DOMAIN` を sender domain として追加し、提示された DNS record を Cloudflare zone に登録する。domain が verified になるまで配備しない。
- verified domain で `fog-staging@DOMAIN` と `fog@DOMAIN` を sender として許可する。
- Email Service binding 名は `EMAIL` とする。

| permission | resource |
| --- | --- |
| Account / Workers Scripts / Edit | Worker を所有する 1 account |
| Zone / Workers Routes / Edit | `DOMAIN` の 1 zone |
| Zone / Zone / Read | `DOMAIN` の 1 zone |

authority check は token の active 状態、zone の account/name/status、既存 Worker の read を Cloudflare API で確認する。初回配備で Worker が存在しない 404 は許可する。read-only check は編集権限を完全には証明しないため、初回 secret sync/deploy の成功を edit scope の受け入れ gate とする。

Email Service の sender domain verification、許可 recipient、quota、bounce、重複配送を実環境で確認する。任意の利用者へ配送できない場合は Cloudflare Email binding を配備せず、HTTPS mail provider adapter を実装してから配備する。復旧メールは at-least-once 配送で、再試行時も同じ message ID を使う。

### Turso

- staging と production に独立した DB を作成する。
- DB hostname の先頭 label をそれぞれ `fog-staging`、`fog-production` にする。suffix 付きの provider 名も利用できる。
- 各 DB 専用の最小権限 token を発行する。
- `DATABASE_IDENTITY` に URL ではなく remote DB の正規化済み `host[:port]` を登録する。
- production の PITR 保持期間と復旧手順を契約上の値で確認する。

`DATABASE_IDENTITY` は secret から導出しない独立した authority である。config、接続 URL、DB 内の `fog_deployment_identity` marker が一致しない migration は schema 変更前に失敗する。DB token 自体から stage は判別できないため、DB ごとの最小権限 token で誤接続の影響を制限する。

### Google OAuth

Google Cloud で stage ごとに Web application client を作成する。Authorized redirect URI は表の callback と完全一致させる。scheme、host、path、末尾 slash が異なる URI を登録しない。client ID と client secret は必ず組で登録する。

### GitHub Environments

`staging` と `production` を作成する。production には required reviewer を設定し、self-review を無効にする。deployment branch policy は `main` だけを許可する。Environment の保護設定は repository 管理者が確認する。

Release Please は次のどちらか一方の token 経路を初回 `main` push 前に設定する。

1. 既定の `github.token` を使う場合は、repository の **Settings → Actions → General → Workflow permissions** で **Allow GitHub Actions to create and approve pull requests** を有効にして保存する。`GET /repos/{owner}/{repo}/actions/permissions/workflow` の `can_approve_pull_request_reviews` が `true` であることを管理者が確認する。
2. repository policy で既定 token の pull request 作成を許可しない場合は、対象 repository だけへアクセスできる fine-grained PAT を発行する。Repository permissions は Contents、Pull requests、Issues を Read and write にし、組織の最短許容期限を設定して repository secret `RELEASE_PLEASE_TOKEN` に登録する。期限前に新 token へ更新し、Release PR と release 作成を確認してから旧 token を失効する。

custom token を organization または別 repository へ共有しない。GitHub App を採用する場合は installation を対象 repository に限定し、Contents、Pull requests、Issues の write permission だけを与え、workflow run ごとに短命 installation token を発行する実装を追加してから `RELEASE_PLEASE_TOKEN` の代わりに使用する。

## GitHub の変数と secret

値を repository、workflow、config artifact、ログへ記載しない。

各 GitHub Environment に次の変数を登録する。

| 名前 | 契約 |
| --- | --- |
| `DOMAIN` | 両 stage で同じ apex domain |
| `DATABASE_IDENTITY` | stage 専用 remote DB の正規化済み identity |
| `DATABASE_IDENTITY_BOOTSTRAP` | 初回 migration の間だけ文字列 `true` |
| `DATABASE_IDENTITY_REBIND_FROM` | 任意。PITR 切り替え中だけ使う同一 stage の旧 DB identity |

各 GitHub Environment に次の secret を登録する。

| 名前 | 用途 |
| --- | --- |
| `DATABASE_URL` | TLS を使う stage 専用 remote libSQL URL |
| `DATABASE_AUTH_TOKEN` | 対象 DB 専用 token |
| `FOG_GOOGLE_CLIENT_ID` | stage 専用 Google client ID |
| `FOG_GOOGLE_CLIENT_SECRET` | stage 専用 Google client secret |
| `CLOUDFLARE_API_TOKEN` | 対象 Cloudflare account/zone に限定した token |
| `CLOUDFLARE_ACCOUNT_ID` | Worker を所有する account ID |
| `FOG_AI_CLIENTS` | 任意。認可する AI client の JSON 配列 |

`FOG_AI_CLIENTS` を使わない場合は未登録にする。secret sync は未登録を `null` として Cloudflare へ送り、Worker に残る旧 `FOG_AI_CLIENTS` を削除する。登録する場合は各 client に一意の ID、表示名、許可した HTTPS redirect URI を設定する。client credential を含む場合は全体を secret として扱う。配備後は `wrangler secret list` で secret 名だけを確認し、値を取得またはログ出力しない。必須 runtime secret には `null` を送らない。

repository secret は必要な場合だけ `RELEASE_PLEASE_TOKEN` を登録する。Environment secret を repository secret に複製しない。

## 初回配備

1. Cloudflare、Turso、Email Service、Google OAuth、GitHub Environments を準備する。
2. staging の変数と secret を登録する。
3. staging の `DATABASE_IDENTITY_BOOTSTRAP` を `true` にする。
4. `main` を更新し、`Cloudflare delivery` の Cloudflare authority check、staging deployment、migration、secret 同期、deploy、smoke が成功することを確認する。
5. staging の DB marker と動作を確認し、`DATABASE_IDENTITY_BOOTSTRAP` を削除する。
6. Release Please が作成または更新した Release PR を確認する。
7. production の変数と secret を登録し、`DATABASE_IDENTITY_BOOTSTRAP` を `true` にする。
8. Release PR を merge する。Release Please が GitHub Release を作成すると production approval が待機する。
9. tag、commit SHA、staging deployment、変更内容を照合して production を承認する。
10. production の migration、secret 同期、deploy、smoke が成功したら `DATABASE_IDENTITY_BOOTSTRAP` を削除する。

初回 marker 作成後に `DATABASE_IDENTITY_BOOTSTRAP` を再設定しない。既存 marker の stage または DB identity が違う場合は bootstrap を指定しても失敗する。

## 配備フロー

`.github/workflows/cloudflare-delivery.yml` が全配備を管理する。

`main` の push は次の順に実行する。

1. frozen lockfile install、lint、format、typecheck、全 test、Node build
2. staging config の生成
3. Worker server と client assets の build と provenance 検証
4. Wrangler dry-run
5. Cloudflare token、account、zone、Worker read authority の検証
6. GitHub staging deployment record の作成
7. staging DB migration
8. Worker runtime secret の同期
9. `fog-staging` の deploy
10. HTTPS health smoke
11. staging deployment success の記録
12. Release Please による Release PR の作成または更新

Release PR の merge によって GitHub Release が作成された場合だけ production を実行する。公開 validation は release、tag の peeled SHA、`main` 到達性、最新 staging deployment/status、workflow run attempt、`Deploy staging` job を検証する。production approval 後に同じ状態を再検証し、同じ commit SHA を build、migration、deploy、smoke に使う。

staging と production の concurrency group はそれぞれ `fog-staging`、`fog-production` で、実行中の配備を cancel しない。通常の pull request、任意の tag push、Release PR の作成だけでは production を実行しない。

## Recovery deploy

`Cloudflare delivery` の `workflow_dispatch` は、既存 GitHub Release の再配備だけを許可する。workflow ref は `main`、入力は release tag と full commit SHA とする。GitHub CLI では次の形で起動する。

```sh
gh workflow run cloudflare-delivery.yml --ref main \
  -f release_tag=vX.Y.Z \
  -f release_sha=FULL_LOWERCASE_COMMIT_SHA
```

実行前に次を確認する。

- Release が draft または prerelease ではない。
- tag の peeled SHA と入力 SHA が一致する。
- SHA が `main` に到達可能である。
- 同じ SHA の最新 staging deployment/status が成功している。
- staging の最新 workflow attempt と一意な `Deploy staging` job が成功している。

公開 validation を通過した後、production Environment の approval で停止する。承認後に同じ release fingerprint を再検証する。任意 SHA、古い成功 status、変更された release/tag は配備しない。

## Migration

Worker の起動時や request 処理中に migration を実行しない。workflow は stage 固有 config と DB identity を検証した後、deploy 前に Node CLI から migration を実行する。

```sh
pnpm db:migrate:cloudflare --stage staging --config .cloudflare/generated/staging/wrangler.json
pnpm db:migrate:cloudflare --stage production --config .cloudflare/generated/production/wrangler.json
```

CLI は接続確認後に write transaction を取得し、identity marker の検査と schema migration を同じ transaction で直列化する。失敗時は rollback し、再実行で収束する。

schema 変更は expand-contract で行う。

1. 旧版と新版が読める additive schema を配備する。
2. backfill を bounded batch で実行し、再実行可能にする。
3. 新版への切り替えと監視を完了する。
4. 旧版が不要になった後の release で contract する。

単一配備で destructive migration と依存コードの切り替えを同時に行わない。

## Cron と health

Worker は 2 つの Cron Trigger を持つ。

| schedule | 処理 |
| --- | --- |
| `* * * * *` | recovery mail outbox の配送 |
| `0 3 * * *` | 03:00 UTC にゴミ箱の保持期限処理 |

Cloudflare Cron Trigger は UTC で評価される。trigger 変更は全 Worker へ反映されるまで最大 15 分を見込む。重複・遅延を前提とし、mail は lease と安定した message ID、retention は owner/page 単位の bounded transaction と purging marker で再実行可能にする。scheduled handler の例外、実行時間、未配送件数、保持対象残件を監視する。

`GET /healthz` は DB readiness が成功したとき HTTP 200 と次の JSON を返す。`HEAD /healthz` も同じ readiness を検査して body なしで返す。全 health response は `Cache-Control: no-store` を持ち、DB readiness の失敗は HTTP 503 を返す。

```json
{
  "status": "ok",
  "deploymentSha": "FULL_LOWERCASE_COMMIT_SHA",
  "deploymentEnv": "staging",
  "databaseIdentity": "fog-staging.REMOTE_DB_HOST"
}
```

smoke は custom domain の exact HTTPS origin だけへ接続し、`deploymentSha`、`deploymentEnv`、`databaseIdentity` を期待値と照合する。redirect、別 host、古い release、DB identity 不一致は成功にしない。最大 18 回、各 request timeout 10 秒、retry 間隔 5 秒で確認する。失敗 response の body は secret または利用者データの露出を避けるためログへ出さない。

## Rollback と PITR

code rollback は、復旧対象として有効な過去の GitHub Release と、その SHA の最新 staging success が存在する場合に `workflow_dispatch` で再配備する。DB schema が過去版と互換であることを承認前に確認する。

destructive migration を逆実行しない。互換性を失った DB は次の手順で復旧する。

1. 書き込みを止め、復旧時刻を確定する。
2. Turso PITR から新しい DB を作る。
3. 新 DB の件数、主要データ、旧 `fog_deployment_identity` marker、対象 release との schema 互換性を隔離環境で確認する。
4. stage に合う新しい DB token を発行する。
5. GitHub Environment の `DATABASE_IDENTITY_REBIND_FROM` に marker の旧 identity を登録する。旧 identity は新 identity と異なり、同じ stage の正規化済み authority でなければならない。
6. `DATABASE_IDENTITY`、`DATABASE_URL`、`DATABASE_AUTH_TOKEN` を新 DB に切り替える。
7. `main` ref から recovery deploy を実行する。migration は marker の stage と identity が `DATABASE_IDENTITY_REBIND_FROM` に完全一致した場合だけ、marker を新 `DATABASE_IDENTITY` へ更新して schema migration を同じ write transaction で実行する。
8. migration と smoke の成功後に `DATABASE_IDENTITY_REBIND_FROM` を削除する。marker が既に新 identity なら、削除前の同一 workflow retry も収束する。
9. 復旧受け入れ後まで旧 DB を保持する。

marker 更新後に schema migration が失敗した場合は同じ transaction で marker も rollback する。stage 不一致、指定した旧 identity と marker の不一致、旧 identity と新 identity の同値、未正規化 authority、通常配備時の wrong DB は schema 変更前に失敗する。`DATABASE_IDENTITY_BOOTSTRAP` と `DATABASE_IDENTITY_REBIND_FROM` を同時に設定しない。

PITR の詳細と独立バックアップは[バックアップと復元](backup_restore.md)に従う。

## Secret rotation

rotation は staging で完了させてから production へ適用する。

1. provider で新 credential を発行し、旧 credential と短時間だけ併用する。
2. 対象 GitHub Environment の secret を更新する。
3. staging は次の `main` push、production は有効な release の recovery deploy で migration、secret 同期、deploy、smoke を実行する。
4. OAuth login、DB read/write、recovery mail、AI client を確認する。
5. provider で旧 credential を失効する。

Cloudflare API token、Turso token、Google client secret、AI client credential を個別に rotation する。DB URL または identity を変える場合は rotation ではなく DB 切り替えとして扱い、marker と PITR 手順を確認する。secret 値を CLI 引数、config、artifact、issue、ログに記載しない。

## 障害対応

| 症状 | 対応 |
| --- | --- |
| config または provenance failure | generated config と `.cloudflare/dist` を削除し、同じ SHA と stage で render から再実行する |
| DB identity failure | Environment の `DATABASE_IDENTITY`、`DATABASE_URL`、DB marker を照合する。marker を書き換えて回避しない |
| migration failure | schema 変更前の preflight failure か transaction rollback かを確認し、原因修正後に workflow を再実行する |
| Cloudflare authority failure | token の期限、account ID、active zone、Zone Read、Workers Scripts read/edit、Workers Routes edit の対象 resource を照合する |
| deploy failure | staging deployment status、secret 同期、Worker version、token の edit scope を照合する。authority check 後に DB migration だけが完了している場合は DB を戻さず同じ SHA で再実行する |
| smoke failure | custom domain/TLS、health の SHA/stage/DB identity、最新 Worker version を照合する |
| Google login failure | client の stage、exact callback、consent screen、client secret の組を確認する |
| recovery mail failure | Email binding、許可 sender、quota、outbox lease、retry を確認する。reset URL をログへ出さない |
| cron failure | Cloudflare trigger と scheduled log を確認し、同じ処理の再実行性と残件を確認する |
| production validation failure | release/tag、最新 staging deployment/status、workflow attempt を確認する。validation を迂回しない |

production で影響が継続する場合は custom domain を不正な Worker へ向け直さない。直近の有効 release の recovery deploy、または検証済み PITR DB への切り替えを使う。

## ローカル検証

Node.js 22.12 以上と pnpm 11.1.2 を使う。次の例は external credential を使わない。

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

example domain と相互に異なる DB identity で両 stage の config、build、dry-run を検証する。`DEPLOYMENT_SHA` は 40 桁の lowercase SHA にする。

```sh
DOMAIN=example.com \
DATABASE_IDENTITY=fog-staging.example.turso.io \
DATABASE_URL=libsql://fog-staging.example.turso.io \
DEPLOYMENT_SHA=0000000000000000000000000000000000000000 \
pnpm cloudflare:config render --stage staging

DOMAIN=example.com \
DATABASE_IDENTITY=fog-production.example.turso.io \
DATABASE_URL=libsql://fog-production.example.turso.io \
DEPLOYMENT_SHA=0000000000000000000000000000000000000000 \
pnpm cloudflare:config render --stage production

pnpm cloudflare:config validate-pair

DOMAIN=example.com \
DATABASE_IDENTITY=fog-staging.example.turso.io \
DATABASE_URL=libsql://fog-staging.example.turso.io \
DEPLOYMENT_SHA=0000000000000000000000000000000000000000 \
pnpm build:cloudflare:stage --stage staging

pnpm cloudflare:deploy --stage staging --dry-run
```

production build と dry-run は identity と URL を production 用へ変えて同じ順序で実行する。生成物は `apps/web/.cloudflare` 配下に作成され、Git へ追加しない。

local Workers runtime を起動する場合は `apps/web/.dev.vars.example` を `apps/web/.dev.vars` へコピーし、staging 専用の実 credential を設定する。

```sh
pnpm --filter @repo/web dev:cloudflare
```

`.dev.vars` を commit しない。local workerd の成功は custom domain、GitHub approval、実 Turso の transaction 上限、Workers CPU/memory、Email Service 配送を代替しない。

## 外部受け入れ

初回 production 承認前に次を実環境で確認する。

- Cloudflare account、zone、Workers Paid、custom domain、TLS
- Turso 2 DB、最小権限 token、identity marker、PITR 保持期間
- Cloudflare Email Service の sender、recipient、quota、bounce、重複配送
- Google OAuth の stage 別 client、exact callback、consent screen
- GitHub Environment の reviewer、branch policy、secret/variable 名
- main push の staging deployment record、Release PR、production approval、recovery dispatch
- remote migration の idempotency、並行実行、長時間 transaction、provider error
- Workers の scrypt CPU/memory、overload、request/cron cancellation
- health smoke の SHA、stage、DB readiness
- read-only authority check では証明できない Cloudflare token の secret sync、Worker upload、route 編集 scope
