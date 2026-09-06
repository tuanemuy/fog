const SECURE_PROTOCOLS = new Set(["libsql:", "https:", "wss:"]);
const CREDENTIAL_QUERY_KEYS = new Set([
  "accesstoken",
  "authtoken",
  "credential",
  "password",
  "token",
]);

export function normalizeRemoteLibsqlUrl(value: string): string {
  const raw = value.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Cloudflare runtime requires a secure remote libSQL URL");
  }
  if (
    !SECURE_PROTOCOLS.has(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("Cloudflare runtime requires a secure remote libSQL URL");

  const tlsValues: string[] = [];
  for (const [key, queryValue] of url.searchParams) {
    const normalizedKey = key.toLowerCase().replaceAll(/[-_.]/g, "");
    if (CREDENTIAL_QUERY_KEYS.has(normalizedKey))
      throw new Error("Database credentials must not be embedded in the URL");
    if (key !== "tls")
      throw new Error("Cloudflare runtime requires a secure remote libSQL URL");
    tlsValues.push(queryValue);
  }
  if (
    tlsValues.length > 1 ||
    (tlsValues.length === 1 &&
      (url.protocol !== "libsql:" || tlsValues[0] !== "1"))
  )
    throw new Error("Cloudflare runtime requires TLS for remote libSQL");
  return raw;
}

export function isSecureRemoteLibsqlUrl(value: string): boolean {
  try {
    normalizeRemoteLibsqlUrl(value);
    return true;
  } catch {
    return false;
  }
}

export function remoteLibsqlIdentity(value: string): string {
  const url = new URL(normalizeRemoteLibsqlUrl(value));
  const pathname = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ""}${pathname}`;
}
