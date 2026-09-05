import { parseArgs } from "node:util";
import { restoreBackup } from "@repo/core/adapters/fog/backup";
import { SystemClock } from "@repo/core/application/ports/clock";
import { UuidV7Generator } from "@repo/core/application/ports/idGenerator";
import { backupFailure, requiredOption } from "./backupSupport.node";

async function main() {
  const { values } = parseArgs({
    options: {
      backup: { type: "string" },
      destination: { type: "string" },
      "preserve-access": { type: "boolean", default: false },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "restore.node.ts --backup /absolute/backups/fog-backup-... --destination /absolute/new.db [--preserve-access]",
    );
    return;
  }
  const result = await restoreBackup({
    backupDirectory: requiredOption(values.backup, "backup"),
    destinationPath: requiredOption(values.destination, "destination"),
    clock: SystemClock,
    ids: UuidV7Generator,
    preserveAccess: values["preserve-access"],
  });
  console.log(JSON.stringify(result));
}
main().catch(backupFailure);
