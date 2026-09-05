import { parseArgs } from "node:util";
import { createBackup } from "@repo/core/adapters/fog/backup";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { backupFailure, requiredOption } from "./backupSupport.node";

async function main() {
  const { values } = parseArgs({
    options: {
      source: { type: "string" },
      directory: { type: "string" },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "backup.node.ts --source /absolute/app.db --directory /absolute/backups",
    );
    return;
  }
  const result = await createBackup({
    sourcePath: requiredOption(values.source, "source"),
    backupDirectory: requiredOption(values.directory, "directory"),
    clock: SystemClock,
    ids: UuidV7Generator,
  });
  console.log(
    JSON.stringify({
      directory: result.directory,
      createdAt: result.manifest.createdAt,
      sha256: result.manifest.database.sha256,
    }),
  );
}
main().catch(backupFailure);
