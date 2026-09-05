import { parseArgs } from "node:util";
import { pruneBackups } from "@repo/core/adapters/fog/backup";
import { SystemClock } from "@repo/core/application/ports/clock";
import { backupFailure, requiredOption } from "./backupSupport.node";

async function main() {
  const { values } = parseArgs({
    options: {
      directory: { type: "string" },
      "keep-days": { type: "string" },
      apply: { type: "boolean", default: false },
      help: { type: "boolean" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.help) {
    console.log(
      "prune-backups.node.ts --directory /absolute/backups --keep-days 30 [--apply]",
    );
    return;
  }
  const result = await pruneBackups({
    backupDirectory: requiredOption(values.directory, "directory"),
    retentionDays: Number(requiredOption(values["keep-days"], "keep-days")),
    clock: SystemClock,
    apply: values.apply,
  });
  console.log(JSON.stringify(result));
}
main().catch(backupFailure);
