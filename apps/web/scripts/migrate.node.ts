import fs from "node:fs";
import path from "node:path";
import { migrateFog } from "@repo/core/adapters/fog/schema";
import {
  applyPragmas,
  createLibsqlClient,
} from "@repo/core/adapters/libsql/client";

async function main() {
  const url = process.env.DATABASE_URL ?? "file:./data/app.db";
  if (url.startsWith("file:"))
    fs.mkdirSync(path.dirname(path.resolve(url.slice(5))), { recursive: true });
  const client = createLibsqlClient({
    url,
    ...(process.env.DATABASE_AUTH_TOKEN
      ? { authToken: process.env.DATABASE_AUTH_TOKEN }
      : {}),
    ...(process.env.DATABASE_ENCRYPTION_KEY
      ? { encryptionKey: process.env.DATABASE_ENCRYPTION_KEY }
      : {}),
  });
  try {
    await applyPragmas(client, { wal: url !== ":memory:" });
    await migrateFog(client);
    console.log("[fog.migrate] schema ready");
  } finally {
    client.close();
  }
}
main().catch(() => {
  console.error(
    "[fog.migrate] failed; check database configuration and connectivity",
  );
  process.exitCode = 1;
});
