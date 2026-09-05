# バックアップと復元

## 対象と保存形式

Node + libSQLの、暗号化されていないローカルSQLiteファイルを対象とする。CLIの対象DBと保存先は明示したパスだけで決まる。pnpm scriptsは `.env` を読み込むが、`DATABASE_URL` はバックアップ・復元の対象選択に使わない。暗号化済みDB・リモートURLの直接バックアップは対象外。クラウドは後述の準備手順を使う。

`fog-backup-<UTC日時>-<UUID>` ディレクトリに `snapshot.sqlite` と `manifest.json` を保存する。ディレクトリは0700、両ファイルは0600。マニフェストは形式・作成日時・ファイルサイズ・SHA-256・スキーマのSHA-256・全アプリテーブルの件数を記録する。マニフェストの完成をバックアップの確定点とする。

SQLite全体を保存するため、最新内容・リビジョン・出典・完了状態・ゴミ箱・ユーザー設定・パスワードハッシュ・Google連携・session・AI接続・冪等性台帳・認可途中のstate・reset token・未配送メールを含む。設定画面のJSONエクスポートとは保存範囲が異なる。バックアップを公開ディレクトリやGitへ置かない。転送先も暗号化し、復号権限を復旧担当者へ限定する。

SHA-256は破損や取り違えを検出する。マニフェストとDBの両方を書き換えられる相手に対する真正性保証は持たない。バックアップ保管先のアクセス制御と改変防止を別途設定する。

## 一貫性と検証

専用libSQL接続から `VACUUM INTO` を実行する。SQLite公式は、この出力を元DBの一貫したスナップショットと定義している。未確定transactionは含まない。元DBを置き換えず、稼働中のDBをバックアップできる。完了前の電源断は出力を破損させ得るため、CLIは完成後に整合性・外部キー・hashを検査してからマニフェストを確定する。[SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto)

`@libsql/client` のローカルファイル接続とSQL実行を使用する。採用中のdriverで、WALの未確定更新を除外する実DBテストを実行している。[Turso TypeScript reference](https://docs.turso.tech/sdk/ts/reference)

稼働中の `.db` を `cp` でコピーしない。WAL/SHMを個別に集めてバックアップと見なさない。CLIはsourceを通常ファイルとして確認し、SQLiteのスナップショットを生成する。完成済みsnapshotの転送・復元時だけファイルコピーを使う。

検証は `PRAGMA integrity_check`、`PRAGMA foreign_key_check`、現在のfog必須テーブル、スキーマhash、全テーブル件数、DBのサイズとhashで行う。別アプリ・破損・余計なファイル・シンボリックリンク・所有者以外が読めるファイルを拒否する。復元にはバックアップを作成した版に対応するfogを使い、復元検証後に通常のmigrationを適用する。

## ローカルバックアップ

リポジトリrootから実行する。`--source` は実際のSQLiteファイルの絶対パスに置き換える。

```bash
mkdir -m 700 /srv/backups/fog
pnpm db:backup --source /srv/fog/apps/web/data/app.db --directory /srv/backups/fog
```

成功時は完成ディレクトリ・作成日時・hashをJSONで出力する。既存の同名バックアップは上書きしない。失敗時は非ゼロで終了する。強制終了で残った不完全ディレクトリは復元・自動削除の対象にならない。内容を調べてから運用担当者が処理する。

日次実行を基準とし、ジョブ失敗と最終成功時刻を監視する。日次snapshotの目標RPOは24時間。実際の復旧所要時間を訓練で計測してRTOを決める。空き容量は少なくともDB全量分と作業余裕を確保する。全テーブル検査の負荷も監視する。

```cron
0 3 * * * cd /srv/fog && /usr/local/bin/pnpm db:backup --source /srv/fog/apps/web/data/app.db --directory /srv/backups/fog
15 3 * * * cd /srv/fog && /usr/local/bin/pnpm db:prune-backups --directory /srv/backups/fog --keep-days 30 --apply
```

## 保持期限による整理

```bash
pnpm db:prune-backups --directory /srv/backups/fog --keep-days 30
pnpm db:prune-backups --directory /srv/backups/fog --keep-days 30 --apply
```

既定はdry-run。JSONの `deleted` は削除予定一覧で、`--apply` 指定時だけ削除する。保持日数は1〜3650。指定ディレクトリ直下の既知形式で、全検証に合格したバックアップだけを扱う。未知の名前、不完全なもの、破損、シンボリックリンクは `skipped` に残す。

期限切れでも最新の有効なバックアップは必ず1件残す。定期作成が止まるとその1件は保持期限を超えて残る。再実行しても既存データや未知のファイルを巻き込まない。アプリのゴミ箱保持期限は、この運用バックアップの保持期限を変更しない。

## 新しいDBへの復元

復元先は新しいファイル名を指定する。既存DB、元DB、同名のWAL/SHM/journalがあるパスは拒否する。バックアップの検証と復元後の検査が成功してから、新しいDBファイルを公開する。元DB・バックアップは変更しない。

```bash
pnpm db:restore --backup /srv/backups/fog/fog-backup-20260905T140000000Z-00000000-0000-7000-8000-000000000001 --destination /srv/fog-recovery/app-restored.db
```

既定の復元は全所有者のsessionを消去し、AI接続を失効する。認可途中のAI要求/code、Google認証state、reset token、未配送resetメールも消去する。コンテンツ・履歴・出典・設定・AI冪等性台帳・パスワードハッシュ・Google連携は保持する。未配送の古いresetメールを自動送信しない。

過去のパスワード、解除済みGoogle連携、完全削除済みの内容はバックアップから復活し得る。復元先を公開する前に、復旧時刻以降の削除・認証解除・password変更を確認して再適用する。通常のsession失効だけでは、過去のpasswordやGoogle連携による再ログインを防げない。

1. 元アプリへの新規書き込みを止め、復旧対象時刻を決める。
2. 新規DBへ復元し、ネットワーク隔離した環境で検査する。SMTP配送も無効にする。
3. 所有者、主要メモ・文書、出典、履歴、ゴミ箱、保持期限、認証手段を確認する。必要な削除・解除・password変更を再適用する。
4. 元DBを保持したまま、アプリの `DATABASE_URL` を新規DBへ切り替える。起動・ログイン・検索・編集・履歴を確認する。
5. 復旧時刻・artifact ID・hash・検査結果・切り替え時刻を記録する。旧DBの廃棄は復旧受け入れ後に別途判断する。

全テーブルをそのまま復元する隔離訓練には `--preserve-access` を指定する。保存当時のsession、AI bearer、resetメールも有効になり得るため、このDBを本番や外部接続可能な環境へ公開しない。

```bash
pnpm db:restore --backup /srv/backups/fog/fog-backup-20260905T140000000Z-00000000-0000-7000-8000-000000000001 --destination /srv/fog-drill/exact-copy.db --preserve-access
```

## クラウドlibSQLの準備

Tursoの既存libSQL構成を想定する。実際の組織・DB・資格情報・保持契約への接続、PITR、cloud側の復元は未検証。以下は実行準備であり、適用済み構成ではない。

| 項目 | 設定する内容 |
| --- | --- |
| PITR | 30日以上を満たす保持契約と対象DBを確認する |
| 独立バックアップ | 日次で固定した復旧用DBから取得し、暗号化した別保管先へ保存する |
| 保持 | 日次30日、最新の検証済み1件を保護する。削除権限を通常の保存ジョブから分離する |
| 保管先 | 非公開、暗号化、限定した復号権限、改変/削除の監査記録 |
| 監視 | 取得失敗、検証失敗、24時間を超える未取得、容量不足 |
| 復元訓練 | 毎月、新規DBへ復元し内容・認証失効・アプリ操作と所要時間を記録する |

TursoのPITRはCOMMITに対応する復旧点から新しいDBを作る。保持期間は契約に依存する。既存DBへ上書きする操作ではなく、新DBの接続情報へ切り替える。[Turso Point-in-Time Recovery](https://docs.turso.tech/features/point-in-time-recovery)

```bash
turso db create fog-recovery-20260905 --from-db fog-production --timestamp 2026-09-05T14:00:00Z
```

復旧用DBをアプリやworkerへ接続しない。この固定DBに追加書き込みを許さず、必要なら `.dump` を0600のローカルSQLへ保存する。書き込みがない固定DBから読むことで、複数テーブルの取得中に内容が変わらない。`.dump` は再構築に使用できるアプリのSQLを出力する。[Turso db shell](https://docs.turso.tech/cli/db/shell)

```bash
umask 077
turso db shell fog-recovery-20260905 .dump > /srv/fog-recovery/frozen.sql
sqlite3 /srv/fog-recovery/frozen-new.db < /srv/fog-recovery/frozen.sql
pnpm db:backup --source /srv/fog-recovery/frozen-new.db --directory /srv/backups/fog-cloud
```

`frozen-new.db` は未作成の専用パスを用意する。SQL dump、作業用SQLite、artifactもすべて秘密として扱う。クラウドとローカルの全アプリテーブル件数・主要データを照合する。最新世代の `turso db export` には最新更新が含まれない場合があるため、取得時刻の最新版を保証する手順として単独採用しない。[Turso db export](https://docs.turso.tech/cli/db/export)

ローカルで既定の認証失効復元と検査を行った後、新しいcloud DBへ投入する。`--from-file` の制限や対象engineへの対応を実環境で確認する。[Turso db create](https://docs.turso.tech/cli/db/create)

```bash
turso db create fog-restored-20260905 --from-file /srv/fog-recovery/app-restored.db
```

新DB用の資格情報を用意し、非公開状態で確認する。アプリへの接続先切り替えと本番公開は復旧結果の受け入れ後に行う。元DBの削除はこの手順に含めない。
