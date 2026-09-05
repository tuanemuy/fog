# Node runtime

fog は Node.js 22.12以上と libSQL で動作する。Node プロセスを常駐させ、ローカル DB またはクラウド libSQL に接続する。migration は `migrateFog` が管理し、起動前 CLI と起動時に同じ idempotent 処理を実行する。

## 環境変数

| 変数 | 設定 |
| --- | --- |
| `DATABASE_URL` | 必須。ローカル `file:./data/app.db`、クラウド `libsql://<database-host>` |
| `DATABASE_AUTH_TOKEN` | クラウド DB の認証 token。URL に埋め込まず secret として注入 |
| `DATABASE_ENCRYPTION_KEY` | 対応するローカル libSQL 暗号化 DB の key。backup/restore の制約は別文書 |
| `APP_URL` | 必須。利用者がアクセスする origin。パス・query・fragment・credentials なし |
| `HOSTNAME` | 既定 `127.0.0.1`。container 内は `0.0.0.0`、reverse proxy 配下は loopback |
| `PORT` | 既定3000、1〜65535 |
| `FOG_AI_CLIENTS` | 登録済み AI client の JSON 配列。[契約](ai_client.md) |
| `FOG_GOOGLE_*` / `FOG_SMTP_*` | [認証と復旧](account_access.md) |

ローカル `.env` は `apps/web/.env`。process 環境の値が優先される。公開運用は host の secret store / mode0600 EnvironmentFile を使い、Git と配信ディレクトリへ配置しない。`APP_URL` は reverse proxy の公開 HTTPS origin と一致させる。

## 初期化と更新

```sh
pnpm install --frozen-lockfile
pnpm db:migrate
pnpm build
pnpm start
```

既存 `.env` と DB を保持する。ローカル file URL の親ディレクトリは自動作成する。`pnpm db:migrate` は fog schema だけを作成・更新する。既存の template table を drop しない。既存 fog 文書・履歴・出典を保持する移行は実 DB テストに含む。

更新前に [snapshot](backup_restore.md) を取得する。互換性のない schema 変更はメンテナンス時間に実施し、旧 code を新 schema へ戻せると仮定しない。restore は別 DB で検証してから設定を切り替える。

production は `apps/web/dist/server`、`dist/client`、`scripts/listen.node.mjs` と `staticAssets.mjs`、依存パッケージを使う。`pnpm start` に TypeScript の実行は不要。build と同じ lockfile をインストールする。開発・運用 CLI は tsx を使うため、通常のインストールを維持する。

## 配信と停止

ランチャーが `dist/client` の公開ファイルを配信し、残りを TanStack Start に渡す。`/assets/*` は immutable cache、公開画像等は再検証する。dotfile・path traversal・公開 root 外への symlink は配信しない。production では devtools を出さない。

`GET /healthz` は DB へ `SELECT 1` が成功すると200 `ok`、失敗は503を返す。認証情報と DB URL は返さない。起動時 migration が終わるまで HTTP を listen しない。

ゴミ箱 worker は開始時と60秒周期、復旧メール worker は開始時と5秒周期。HTTP アクセスを必要としない。各 runner は前の実行中に新しい tick を重ねない。SMTP 配送は DB lease を使い、成功・期限切れ・reset 消費で秘密 payload を消去する。

SIGINT / SIGTERM は新しい HTTP 受付を止め、実行中 HTTP と worker を待ってから DB を閉じる。`infra/node/fog.service` は90秒の停止猶予を設ける。通常運用は一つの Node process とし、プロセス数を増やす場合は migration の直列化と各 worker の負荷を確認する。

```sh
curl --fail http://127.0.0.1:3000/healthz
```

## クラウド DB の準備

採用する接続契約は libSQL remote protocol。Turso の libSQL database URL と token を上記環境変数へ設定する。現在の SDK は `@libsql/client`。別世代の Turso SDK へ名前だけで置換しない。地域・プラン・PITR の保持期間は実環境の値を確認して運用台帳へ記録する。

1. 許可された database の URL と最小権限 token を secret store に設定する。
2. 非公開の検証用 DB で migration、書込み、read-after-write、所有者分離、transaction rollback を確認する。
3. [cloud snapshot / PITR 手順](backup_restore.md)で別 DB に復元し、データと認証状態を照合する。
4. DB の監視、容量、リージョン、復元可能期間、backup の別保管先を確認してから公開する。

ローカルの WAL・busy timeout は file client にだけ設定する。foreign key 検査を有効にし、クラウドの journal 設定を上書きしない。実 cloud の資格情報がない環境では接続・耐障害性・cloud restore は未検証である。

## 障害時

- 起動しない: build の有無、APP_URL/PORT、listener の競合、DB の権限・容量・接続を確認する。秘密 token やメール URL をログへ出さない。
- DB 障害: readiness を確認して受付を止め、復元対象を新 DB に作る。元 DB を上書きしない。
- 復旧メール遅延: SMTP 設定と `fog.reset-mail` の件数を確認する。依頼応答の本文では登録有無や配送状態を判別しない。
- schema 更新失敗: backup を保持し、同じ migration を再実行する。書込み途中の DB ファイルをコピーして戻さない。
