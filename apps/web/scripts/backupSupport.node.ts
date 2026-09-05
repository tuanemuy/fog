import { BackupError } from "@repo/core/adapters/fog/backup";

export function requiredOption(
  value: string | undefined,
  name: string,
): string {
  if (!value)
    throw new BackupError("MISSING_ARGUMENT", `--${name} を指定してください。`);
  return value;
}
export function backupFailure(error: unknown): void {
  if (error instanceof BackupError)
    console.error(`${error.code}: ${error.message}`);
  else
    console.error(
      "BACKUP_COMMAND_FAILED: パス・権限・SQLiteファイルと指定した引数を確認してください。",
    );
  process.exitCode = 1;
}
