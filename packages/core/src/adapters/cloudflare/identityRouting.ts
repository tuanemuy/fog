import type { CredentialLocator } from "@repo/core/application/identity/contracts";

export type DirectoryKeyring = Readonly<{
  active: Readonly<{ generation: string; secret: string }>;
  previous?: Readonly<{ generation: string; secret: string }>;
  buckets?: number;
}>;

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function bucketOf(bytes: Uint8Array, count: number): number {
  return (((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0)) % count;
}

async function locatorFor(
  canonicalCredential: string,
  generation: string,
  secret: string,
  buckets: number,
): Promise<CredentialLocator> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(canonicalCredential)),
  );
  return {
    generation,
    bucket: bucketOf(digest, buckets),
    opaqueKey: base64Url(digest),
  };
}

export async function credentialLocators(
  canonicalCredential: string,
  keyring: DirectoryKeyring,
): Promise<readonly CredentialLocator[]> {
  const buckets = keyring.buckets ?? 64;
  if (!Number.isInteger(buckets) || buckets < 1 || buckets > 1024) {
    throw new RangeError("Directory bucket count must be between 1 and 1024");
  }
  const active = await locatorFor(
    canonicalCredential,
    keyring.active.generation,
    keyring.active.secret,
    buckets,
  );
  if (!keyring.previous) return [active];
  const previous = await locatorFor(
    canonicalCredential,
    keyring.previous.generation,
    keyring.previous.secret,
    buckets,
  );
  return [active, previous].sort((left, right) =>
    `${left.generation}:${left.bucket}:${left.opaqueKey}`.localeCompare(
      `${right.generation}:${right.bucket}:${right.opaqueKey}`,
    ),
  );
}

export function directoryObjectName(locator: CredentialLocator): string {
  return `${locator.generation}:${locator.bucket}`;
}

export function canonicalPasswordCredential(email: string): string {
  return `email:${email.normalize("NFKC").trim().toLowerCase()}`;
}

export function canonicalSsoCredential(
  provider: string,
  subject: string,
): string {
  return `sso:${provider.normalize("NFKC")}\u0000${subject.normalize("NFKC")}`;
}
