import type { CredentialLocator } from "@repo/core/application/identity/contracts";
import { opaqueCredentialKey } from "@repo/core/application/identity/contracts";

export type DirectoryKeyring = Readonly<{
  active: Readonly<{ generation: string; secret: string }>;
  previous?: Readonly<{ generation: string; secret: string }>;
  buckets?: number;
}>;

const encoder = new TextEncoder();
export const MIN_DIRECTORY_ROUTING_SECRET_BYTES = 32;

export function validateDirectoryKeyring(
  keyring: DirectoryKeyring,
): DirectoryKeyring {
  const activeBytes = encoder.encode(keyring.active.secret);
  if (
    keyring.active.generation.trim().length === 0 ||
    activeBytes.byteLength < MIN_DIRECTORY_ROUTING_SECRET_BYTES
  ) {
    throw new Error(
      `Active directory routing secret must be at least ${MIN_DIRECTORY_ROUTING_SECRET_BYTES} bytes`,
    );
  }
  if (keyring.previous) {
    if (
      keyring.previous.generation.trim().length === 0 ||
      encoder.encode(keyring.previous.secret).byteLength <
        MIN_DIRECTORY_ROUTING_SECRET_BYTES
    ) {
      throw new Error(
        `Previous directory routing secret must be at least ${MIN_DIRECTORY_ROUTING_SECRET_BYTES} bytes`,
      );
    }
    if (keyring.previous.generation === keyring.active.generation) {
      throw new Error("Directory routing generations must be distinct");
    }
    if (keyring.previous.secret === keyring.active.secret) {
      throw new Error("Directory routing secrets must be distinct");
    }
  }
  return keyring;
}

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
    opaqueKey: opaqueCredentialKey(base64Url(digest)),
  };
}

export async function credentialLocators(
  canonicalCredential: string,
  keyring: DirectoryKeyring,
): Promise<readonly CredentialLocator[]> {
  validateDirectoryKeyring(keyring);
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
