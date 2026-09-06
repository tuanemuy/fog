# Cloudflare デプロイ設計

## 採用方式

Cloudflare Workers を fog の Cloudflare runtime とし、環境ごとに独立した remote libSQL database を接続する。現在の libSQL repository と callback 形式の Unit of Work を維持し、Cloudflare D1 への再実装は行わない。

staging と production は次を分離する。

| 契約 | staging | production |
| --- | --- | --- |
| Worker | `fog-staging` | `fog-production` |
| URL | `https://staging-fog.${domain}` | `https://fog.${domain}` |
| GitHub Environment | `staging` | `production`（required reviewer を設定） |
| DB | staging 専用 remote libSQL | production 専用 remote libSQL |
| OAuth / AI client | staging callback / redirect URI | production callback / redirect URI |
| deploy trigger | `main` の検証済み push | Release Please PR merge で release が作成された同じ SHA |

Workers Paid plan を前提とする。現在の scrypt 強度を下げず、同一 isolate の KDF 同時実行数を1に制限する短い bounded queue を設ける。queue 上限を超えた request は再試行可能な過負荷エラーにする。workerd と実 Workers 上のCPU・メモリ・同時実行検証を実装の先行 gate にする。

## Runtime boundary

`apps/web/app/server.cloudflare.ts` が module Worker の `fetch` と `scheduled` を公開する。Workers entry は remote libSQL URL だけを受理し、`file:`、`:memory:`、local encryption key を拒否する。

`fetch` は現行 Node entry と同じ順序で health、Google OAuth、AI API、TanStack Start/RSC を処理する。request scope は AsyncLocalStorage を使う。Node listener、signal、filesystem backup、SMTP、process timer を Workers bundle に含めない。

Node と Workers の経路差を小さくするため、HTTP routing と service wiring のうち runtime 非依存部分を共有する。Node runtime はローカル運用・既存回帰のため残し、Cloudflare 固有の adapter と entry を明示的に分ける。domain contracts と repository SQL は原則維持するが、remote transaction を長時間保持しないため login と retention の application/UoW 境界は変更する。

password login は credential と attempt state の読取後に write transaction を閉じ、scrypt を transaction 外で実行する。成功時の session 発行または失敗時の attempt 更新では、読み取った credential version / attempt state を新しい短い transaction 内で再検査し、競合時は安全に再試行する。dummy hash は有効な固定値として持ち、isolate boot ごとの scrypt を除く。

`scheduled` は UTC の cron 式で処理を分ける。

- `* * * * *`: reset mail outbox を dispatch する。
- `0 3 * * *`: retention policy に従って期限切れ trash を purge する。

処理は既存の lease / idempotency を使い、重複 invocation と再実行を許容する。retention は全 owner を一つの transaction で処理せず、owner/page ごとの bounded transaction に分割する。集合操作も1 transactionの最大行数・statement数を制限し、remote libSQL の interactive transaction timeout 内に構造上収める。Node の5秒間隔から Workers の最短1分へ配送遅延が変わる点を運用文書に明記する。

## Persistence and migration

Workers は `@libsql/client/web` を使い、environment ごとの `DATABASE_URL` と `DATABASE_AUTH_TOKEN` で remote database に接続する。isolate 内で再利用する client/services は、別 environment の binding と混ざらないよう Worker 自体を分ける。

schema migration は Worker cold start や request から実行しない。GitHub Actions の environment ごとの job が、deploy と同じ DB credentials を使って Node migration CLI を一度実行する。migration → deploy → smoke を environment 単位の concurrency group で直列化する。schema change は古い Worker と新しい Worker の双方が一時的に動ける expand/contract を原則とする。

remote database の保護は database provider の PITR / export を使う。既存の local SQLite backup CLI を Cloudflare runtime へ持ち込まない。

## Mail

Workers 専用 `ResetMailer` adapter を追加し、Cloudflare Email Service の binding から password reset mail を送信する。sender domain、binding、資格情報は environment ごとに設定する。outbox の stable ID、lease、retry、secret payload removal は既存 application contract を維持する。

Cloudflare Email Service は Beta かつ account/plan の利用可否に依存する。任意の利用者宛 transactional mail が対象 account で利用できない場合は、同じ port を実装する HTTPS mail provider adapter に差し替える。SMTP package は Node entry 専用のままにする。

## Configuration contract

committed template と型付き render/validation script から、ignored の environment 別 Wrangler config を生成する。入力は stage と `DOMAIN`。生成処理は次を拒否する。

- 未展開 placeholder、不正な hostname / URL。
- staging と production の同じ Worker 名、hostname、DB identity。
- secret 値の config への直書き。
- Workers runtime で利用できない local database URL。

Wrangler environment の binding / vars 非継承を前提に、各 environment の全 binding、cron、custom domain、`APP_URL` を明示する。local development は `.dev.vars`、CI は GitHub Environment secrets から Wrangler secrets を安全に同期する。生成物と secret 値は Git に含めない。

## Delivery flow

`main` push の一つの delivery workflow を次の順序で進める。

1. 対象 SHA を checkout する。
2. frozen install、format check、lint、typecheck、unit/integration、Cloudflare build/dry-run を実行する。
3. `staging` Environment で config と runtime secrets を準備する。
4. staging DB migration、Worker deploy、`/healthz` smoke を行う。
5. staging 成功後に Release Please を実行し、release PR を作成・更新する。
6. 通常の main push はここで終了する。
7. Release Please の `release_created` が `true` の run だけ、action output の `sha` と `tag_name` を production job へ渡す。
8. `production` Environment の reviewer 承認後、Release Please の `sha` を明示 checkout し、tag がその SHA を指すことと、その SHA の staging smoke 成功を照合してから production migration、deploy、`/healthz` smoke を行う。

Release Please PR のマージ commit は production より先に staging を通る。staging と production は別の concurrency group を使い、migration / deploy の途中で新 run を重ねない。production は tag と SHA を記録する。

Release/tag 作成後に workflow が部分失敗した場合の `workflow_dispatch` 復旧経路を持つ。入力された tag/SHA が既存 GitHub Release と一致し、main から到達可能で、その SHA の staging 成功記録がある場合だけ同じ production job を再開する。任意 SHA を production へ投入できる手動 deploy は作らない。

Release Please token は対象 repository だけに絞った GitHub App installation token または fine-grained PAT を優先する。default `GITHUB_TOKEN` を使う場合に生成 PR の workflow 実行が抑止される制約を文書化する。Action は immutable commit SHA で pin し、依存更新で追跡する。

## Verification gates

実 account に依存しない順に検証する。

1. `@libsql/client/web` と interactive transaction を workerd で実行する。remote staging では競合 error code、retry、rollback、5秒制約を実測する。
2. 現行 scrypt の hash/verify、invalid password、同時 login、bounded admission を workerd で実行する。実 Workers でも3件以上の同時 request が isolate memory を超えず、過負荷時に明示エラーになることを確認する。
3. TanStack Start の custom Workers entry を Cloudflare Vite plugin で build / local preview する。
4. `fetch` の health/主要 route と `scheduled` の2種類の cron を local Workers runtime で実行する。
5. config render、stage isolation、workflow trigger/condition、dry-run artifact を検証する。
6. project 全体の format、lint、typecheck、unit/integration、Node build を回帰確認する。
7. 実 staging で同一emailの同時成功/失敗login、loginと通常writeの競合、bounded retention、migration、Email、OAuth、custom domain、main SHA deploy を確認する。
8. release PR merge と production approval、同一 SHA deploy、rollback / retry、DB restore drill を確認する。

資格情報なしの gate が不合格なら外部 provisioning に進まない。実 account の gate は必要な資格情報と公開許可を得た後に実行する。

## 不採用方式

- D1: `batch()` は atomic だが、現行の read → 分岐 → write を含む callback transaction と一致せず、fog repository/UoW の全面再設計が必要になる。
- Durable Objects: single object は全利用者を直列化し、per-user object は email uniqueness、login lookup、横断 worker、export の別設計が必要になる。
- Containers: disk は永続化できず、sleep 中の process timer も保証されない。remote DB、Cron、mail adapter が結局必要で Workers より利点がない。

詳細な調査根拠は [C0 report](phases/C0.md) を参照する。
