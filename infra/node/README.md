# Node host 設定

`fog.service` は `/opt/fog` にインストールした build を専用 user `fog` で動かす構成例。DB はクラウド libSQL または `/var/lib/fog/app.db` を使用する。例を環境に合わせて配置し、Node のパス・権限・secret 設定を確認してから手動で有効化する。自動公開・cloud 作成は行わない。

1. Node22.12以上と pnpm11.1.2 を準備し、プロジェクトで frozen install、test、build を行う。
2. `/etc/fog/fog.env` を所有者限定の mode0600 とし、`APP_URL`、`DATABASE_URL` と必要な credential を設定する。local DB は `/var/lib/fog` に配置する。user `fog` に必要な権限を付ける。
3. HTTP は `127.0.0.1:3000` に bind し、HTTPS reverse proxy から転送する。`APP_URL` は実際の公開 origin と一致させる。環境の証明書・DNS・proxy 設定を確認する。
4. migration と新 DB backup/restore 訓練を行い、サービス起動、`/healthz`、主要 UI、SIGTERM drain を確認する。
5. systemd の unit を明示的に有効化する。ログ件数・readiness・DB容量・backup 成功時刻を監視する。

稼働サービスへの設定反映、user作成、unit設置、公開はこのリポジトリのチェックでは実行しない。手順の詳細は [Node runtime](../../docs/runtime_node.md) と [backup/restore](../../docs/backup_restore.md)。
