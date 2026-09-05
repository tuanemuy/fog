# P5 バックアップ・復元 完了候補

対象は Node + libSQL のローカル一貫バックアップ、新規DBへの復元、保持期限整理とクラウド運用準備。独立受け入れ前の完了候補。root scripts・runtime整理・productionブラウザは親 Implementer が担当する。

## 実装

- 専用libSQL connectionの `VACUUM INTO` で元DBを変更せず一貫snapshotを生成する。sourceをファイルcopyしない。完成snapshotをintegrity/FK/必須schema検査し、サイズ/SHA-256/schema hash/全table件数のmanifestを最後に確定する。
- artifactは既知のUTC+UUID名、directory0700、SQLiteとmanifest0600。既存同名artifactを拒否する。秘密を含むため私有path以外の検証、symlink、余計なファイルを拒否する。
- 最新内容・履歴・出典・完了・trash・設定・password/Google credentials・session・AI connection/ledger・pending認可・reset token・未配送secret emailを含む全永続tablesを保存する。
- restoreは新規pathのみ。既存DB・元DB・sidecarを上書きしない。検証済みsnapshotを専用作業fileへコピーし、再hash・整合性検査後にexclusive linkで公開する。既存作業file/sidecarも拒否する。
- 既定restoreは全ownerのhuman sessionとAI accessを失効し、pending OAuth/reset/emailを削除する。content/history/link/settings/password/Google/AI ledgerは保持する。`--preserve-access` は隔離訓練用に全tableをそのまま復元する。
- pruneは明示root、既知name、完全検証済みartifactだけを扱う。既定dry-run、`--apply` で実削除。1〜3650日の保持期限を検査し、最新のvalid artifactを必ず残す。未知・破損・不完全・symlinkを削除しない。
- docsに日次snapshot/30日保持/最新保護、失敗監視、新DBへの切り替え、過去password・解除済みGoogle credential・完全削除内容の復活と再適用、PITRと固定cloud clone/dump/新DBrestore準備を記載する。

## 一次資料と適用範囲

[SQLite VACUUM INTO](https://www.sqlite.org/lang_vacuum.html#vacuuminto) のconsistent snapshot保証を採用する。完了前の中断・電源断のリスクには最終検証とmanifest確定で対応する。[@libsql/client公式reference](https://docs.turso.tech/sdk/ts/reference) のfile接続とSQL実行を使用し、採用driverで実SQLite検証を実施した。

[Turso PITR](https://docs.turso.tech/features/point-in-time-recovery)、[db create](https://docs.turso.tech/cli/db/create)、[db shell](https://docs.turso.tech/cli/db/shell)、[db export](https://docs.turso.tech/cli/db/export) を確認した。cloud sourceを直接copyせず、PITRで固定した未接続DBのdumpを取得する準備を記載した。db export単独は最新版を含まない場合があるため最新版保証に使用しない。

実cloud組織・DB・保持契約・資格情報に接続していない。cloud retention/backup/PITR/restoreは準備済み、実適用・検証は未完了。ローカル暗号化SQLiteの直接backupは対象外。未検証範囲をR21全体の合格にしない。

## 検証

- `pnpm --filter @repo/core typecheck`: 成功。
- `pnpm --filter @repo/web typecheck`: 成功。
- scoped `biome check --write` と最終 `biome check`: 新規TS6ファイル成功。
- `pnpm exec vitest run --config vitest.config.integration.node.ts packages/core/src/adapters/fog/__tests__/backup.integration.test.ts`: 最終 1 file / 10 tests 成功（2026-09-05 23:04:56 JST開始、8.63秒）。
- 全tableへ実データを入れ、preserve-access復元で全row一致・既存session再認証・AI冪等性replay継続・trash文書復元後の履歴/出典を確認した。
- 既定restoreのglobal session/AI/pending失効とdurable content/AI ledger保持、元DB/artifact無変更を確認した。
- 稼働中WALの未commitの複数table更新をsnapshotが含まないこと、commit後snapshotには本文/版が揃って入ることを確認した。
- 既存destination/元DB/sidecar拒否、繰り返しbackup/restore安全性、破損/別app/manifest/schema/count/FK/permissions/symlink拒否を確認した。
- pruneのdry-run/apply、最新保持、未知/不完全file保持、入力制約、再実行を確認した。
- 実CLI子processでbackup/restore/prune、spaceを含むsource pathと上書き拒否を確認した。対象はテスト専用temporary DBのみ。

## CLI

```bash
pnpm db:backup --source /absolute/app.db --directory /absolute/backups
pnpm db:restore --backup /absolute/backups/fog-backup-... --destination /absolute/new.db
pnpm db:restore --backup /absolute/backups/fog-backup-... --destination /absolute/isolated.db --preserve-access
pnpm db:prune-backups --directory /absolute/backups --keep-days 30
pnpm db:prune-backups --directory /absolute/backups --keep-days 30 --apply
```

root scriptsは親が配線する。Web scriptsの直接起動は `pnpm --filter @repo/web exec tsx scripts/<backup|restore|prune-backups>.node.ts ...`。追加dependencyなし。既存core/package/lock/config/.env/実DB/Manager台帳/goalを変更していない。server/browser操作なし。コード書き込みと全検証processを停止し、独立Verifierまたは具体的な修正依頼を待つ。

## 対象記録

日時: 2026-09-05T14:07:55.617134+00:00

HEAD: `6ab8e05510a7bdbd1480a8e5c3ec91ff2fbdad48`。新規7ファイル、未コミット成果。

| ファイル | SHA-256 |
| --- | --- |
| `packages/core/src/adapters/fog/backup.ts` | `e772ad20f764982c756a6912f6685eb7673d3b6f50bbc3cae0fdf221d5a3039d` |
| `packages/core/src/adapters/fog/__tests__/backup.integration.test.ts` | `925a515d71235534338f1d217b9b13c0bf09b465d05533b38003a660c8c84f52` |
| `apps/web/scripts/backup.node.ts` | `65861b7a773be4842d2c04859b4f8951666cafc8032ea3222184ea2521570808` |
| `apps/web/scripts/restore.node.ts` | `bb62e0c2ab6acae7051e8fb16fcb1868318976de77629d29aee1a9c9c587980f` |
| `apps/web/scripts/prune-backups.node.ts` | `34d6b80a4ecd3791796fe3d9307735dd387ab3a2ba49b46fef32c99c2fc8ccab` |
| `apps/web/scripts/backupSupport.node.ts` | `1841070f7b660b62ffe94ced8f953964a963370a64e3520a6fe9909059ed18d2` |
| `docs/backup_restore.md` | `952d8ac21f0e9bd44e42a973449462ff1dcae78f656ab11fa588abc52eded653` |
