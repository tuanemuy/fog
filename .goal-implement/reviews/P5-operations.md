# P5 運用・復元の独立検証

判定時刻: 2026-09-05T23:50:05.988951+09:00。対象は [P5最終368対象](../phases/P5-target-hashes.json)、HEAD `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。R21/R22の運用ローカル範囲は local PASS。修正を要するデータ破壊・復元不能の不具合は検出なし。クラウド保存・PITR・実稼働は未検証であり、R21/R22全体の完了根拠にはしない。

## 範囲と同一性

[brief](../brief.md)、[design](../design.md)、[plan](../plan.md)、[P5](../phases/P5.md)、[backup候補](../phases/P5-backup.md)、`spec/requirements.md` §5.3を照合した。開始と終了で368対象すべてのSHA-256/削除状態が一致した。[照合結果](P5-operations-hashes.json)。製品コード・既存テスト・Manager台帳の変更なし。

実行対象は専用の一時SQLite DB/artifactとisolated CLI。稼働DB、production/fixtureプロセス、ブラウザには接続していない。外部API接続、メール送信、クラウドDB作成、upload、公開は実行していない。HTTP/UI/worker起動・停止の独立評価は別Verifierの担当。

## 要件別の結果

| ID / 観点 | 判定 | 根拠 |
| --- | --- | --- |
| R21 / 一貫snapshot | local PASS | `VACUUM INTO` を専用connectionで実行。WALの未commit複数table更新は除外し、commit後は本文とrevisionをそろえて保存する実DB試験が成功 |
| R21 / 完成artifact | local PASS | snapshot fsync、integrity/FK/必須table/schema/count/size/SHA-256検査後、0600のpending manifestをexclusive linkで確定しdirectoryをfsync。directory0700/file0600を実測 |
| R21 / 完全復元 | local PASS | 全永続tableに非空fixtureを用意した既存試験で、preserve-accessは全rowとsnapshot hash一致。既存session再認証、AI ledger replay、trash文書復元後の履歴と出典を確認 |
| R21 / 既定失効 | local PASS | session全削除、AI接続revoked、AI要求/code・Google state・reset token/mail全削除。内容・履歴・出典・設定・password/Google credential・AI ledgerは維持。旧session/AI拒否、password再loginを実DB確認 |
| R21 / 上書き防止 | local PASS | destination/元DB/既存同名artifactを拒否。新pathへexclusive linkで公開。追加試験でdestinationとtemporaryの本体/WAL/SHM/journal計8種を既存のまま保持 |
| R21 / 保持整理 | local PASS | dry-run既定、apply明示、既知名・再検証合格だけをunlink。期限超過時も最新validを保持。破損・未知・不完全・symlinkは保持、再実行は削除0 |
| R21 / 旧データ保持 | local PASS | migrationと両restoreモードで未知の旧tableとrowを保持する追加試験が成功。backupはfog以外のアプリtableもmanifestに含む |
| R21 / cloud構成 | 準備local PASS、実接続未検証 | Node起動とmigrationからURL/auth tokenをlibSQL clientへ渡す。remoteへWAL/busy timeoutを適用しない。PITR→固定DB→dump→新DB復元の手順と再公開条件あり |
| R22 / Node統一 | local PASS | workspaceはapps/coreのみ。AWS/GCP/CF/DOの実行entry・infra・依存・deploy設定を除去。CIはNode22/frozen install/lint/format/typecheck/test/buildを実行 |
| R22 / 回帰根拠 | local PASS | P4bのfog製品integration5ファイルは全hash一致。削除された25テストファイルはTodo、廃止runtime、旧outbox/UoW/queue専用。fogの製品テスト削除なし |
| R22 / 本番ブラウザ・worker統合 | 担当外 | 別Verifierによる独立報告が必要。既存候補の画面・production実操作をこの報告では追認しない |

## 独立実行

| 実行 | 結果 | 時刻・根拠 |
| --- | --- | --- |
| `pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__/backup.integration.test.ts` | 1 file / 10 PASS | 2026-09-05T23:43:51+09:00、7.97秒。[log](P5-operations-backup-tests.log) |
| `pnpm exec vitest run --config .goal-implement/reviews/P5-operations.config.ts` | 1 file / 4 PASS | 2026-09-05T23:46:45+09:00、2.85秒。[log](P5-operations-extra-tests.log)、[harness](P5-operations-extra.test.ts) |
| rootの `pnpm db:backup --help` / `db:restore --help` / `db:prune-backups --help` | 全exit0 | root→web scriptの引数転送を確認。[log](P5-operations-cli.log) |

追加4件は、破損/未知/symlinkを含む実prune、snapshot/manifest symlink拒否、全種の既存restore作業file/sidecar保護、migrationと両restoreでの旧table保持。専用configはrootにhoistされない `@libsql/client` をcoreのpackageから解決する。最初のharness起動はそのmodule解決だけで失敗し、製品テスト実行前に専用configへ修正済み。

既存10件には、全table保存・全owner失効・WAL一貫性・元DB/既存先保護・破損/別app拒否・manifest不整合・FK拒否・permission/symlink・prune・CLI実操作が含まれる。CLI実操作はspaceを含む一時source pathを使用し、実DBの上書きを拒否する。

## 必要checksと適用範囲

[P5証跡](../phases/P5-evidence/)のfrozen install、typecheck、lint:fix、format、unit75件、integration85件、buildの成功logを確認した。最終対象hash一致と製品テスト保持により、この変更への既存成功根拠として適用できる。全コマンドを独立に再実行したという判定ではない。lintはerror/warning0、既存のtemplate literal推奨info1。formatは変更0。追加harnessは通常unitの探索範囲外であり、製品checksを回避する変更は加えていない。

Node以外の実行設定・SDKの参照は製品source/lockfileに残らない。`allowBuilds.workerd: false` はインストール禁止の設定だけで、workerd dependencyはない。共有型のJSDocに残るTodo例は実行機能を持たない。`/todo` は廃止URLへの404拒否。root testの除外は証跡ディレクトリであり、fog製品testは通常探索対象。

## 手順と限界

READMEのinstall→env→migration→dev、build→start、Node運用のURL/token注入、readiness、worker周期、停止、systemd例は現在の構成と整合する。既存envを上書きしない指示、ローカル相対pathの基準、productionに必要なbuild/依存/launcherも明記される。systemd設置とLinux上の稼働は未検証。

backup手順は日次/30日/最新保護、監視、別保管先の暗号化、復元先新path、ネットワーク/SMTP隔離、過去password/解除済みGoogle/完全削除データの再適用、切替後確認を含む。preserve-accessの隔離訓練限定も明確。ローカル暗号化DB直接backupは対象外として明示される。

SQLiteの一貫snapshotと中断時破損、TursoのPITR新DB作成・timestamp、dump、from-fileを公式資料で独立照合した。手順は確認した契約に沿う。[SQLite VACUUM](https://www.sqlite.org/lang_vacuum.html)、[Turso PITR](https://docs.turso.tech/features/point-in-time-recovery)、[db shell](https://docs.turso.tech/cli/db/shell)、[db create](https://docs.turso.tech/cli/db/create)。from-fileのサイズ制限を含む実engine/契約の確認は外部検証で必要。

文書の最終確認: 2026-09-05T23:52:41.694008+09:00。`docs/backup_restore.md:5` は、pnpm scriptsが `.env` を読み込み、対象DBと保存先は必須の明示パスで決まり `DATABASE_URL` を使わないという実装どおりの記述。変更文を元の1文へ戻したSHA-256は初回対象の `952d8ac21f0e9bd44e42a973449462ff1dcae78f656ab11fa588abc52eded653` と一致し、当該文以外の変更なし。更新manifestの368対象も全一致。動作変更がないため既存10+追加4件の結果をそのまま適用する。

## 外部検証の再開条件

R21の原要件はクラウド保存。許可された非公開libSQL/Turso DBのURL/token、地域/保持契約、新規復元先、暗号化した別保管先を確定し、migration/read-write/owner境界/rollback、PITRと復元後の全table/主要操作、backup保持と所要時間を実測する必要がある。外部DB作成・upload・公開の実行にはその範囲の許可が必要。ローカルPASSをこれらの合格に置き換えない。R22全体は実Google/実SMTPを含む必須項目の未検証も残る。
