import { type Client, createClient } from "@libsql/client";

export type CreateLibsqlClientOptions = Readonly<{
  url: string;
  authToken?: string;
  encryptionKey?: string;
}>;

/**
 * Creates a libSQL client. URLs may be `file:`, `:memory:`, or any
 * remote form the driver supports. PRAGMAs are not applied here — call
 * {@link applyPragmas} after construction in production paths.
 */
export function createLibsqlClient(options: CreateLibsqlClientOptions): Client {
  return createClient({
    url: options.url,
    ...(options.authToken !== undefined
      ? { authToken: options.authToken }
      : {}),
    ...(options.encryptionKey !== undefined
      ? { encryptionKey: options.encryptionKey }
      : {}),
  });
}

/**
 * Apply production PRAGMAs: `WAL` (readers unblocked by single writer),
 * `foreign_keys=ON`, `busy_timeout=5000` (the only
 * buffer against transient contention). Remote connections retain provider journal settings.
 * Pass `wal: false` for `:memory:` test databases.
 */
export async function applyPragmas(
  client: Client,
  options: { wal?: boolean } = {},
): Promise<void> {
  const local = client.protocol === "file";
  const wal = local && (options.wal ?? true);
  if (wal) {
    await client.execute("PRAGMA journal_mode = WAL");
  }
  await client.execute("PRAGMA foreign_keys = ON");
  if (local) await client.execute("PRAGMA busy_timeout = 5000");
}
