import { type Client, createClient } from "@libsql/client/web";
import { normalizeRemoteLibsqlUrl } from "@repo/core/lib/remoteLibsql";

export type CreateRemoteLibsqlClientOptions = Readonly<{
  url: string;
  authToken: string;
}>;

export function createRemoteLibsqlClient(
  options: CreateRemoteLibsqlClientOptions,
): Client {
  const url = normalizeRemoteLibsqlUrl(options.url);
  const authToken = options.authToken.trim();
  if (!authToken)
    throw new Error("Cloudflare runtime requires DATABASE_AUTH_TOKEN");
  return createClient({ url, authToken });
}
