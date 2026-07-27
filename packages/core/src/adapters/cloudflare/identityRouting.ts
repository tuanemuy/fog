import {
  directoryReference,
  type DirectoryReference,
} from "@repo/core/application/identity/contracts";
import {
  opaqueCredentialKey,
  type PhysicalCredentialLocator,
} from "./identityPhysical";

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
): Promise<PhysicalCredentialLocator> {
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
): Promise<readonly PhysicalCredentialLocator[]> {
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

export function directoryObjectName(
  locator: PhysicalCredentialLocator,
): string {
  return `${locator.generation}:${locator.bucket}`;
}

export function encodeDirectoryReference(
  locator: PhysicalCredentialLocator,
): DirectoryReference {
  return directoryReference(
    base64Url(
      encoder.encode(
        JSON.stringify([
          1,
          locator.generation,
          locator.bucket,
          locator.opaqueKey,
        ]),
      ),
    ),
  );
}

export function decodeDirectoryReference(
  reference: DirectoryReference,
): PhysicalCredentialLocator {
  try {
    const padded = reference
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(reference.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 4 ||
      parsed[0] !== 1 ||
      typeof parsed[1] !== "string" ||
      parsed[1].length === 0 ||
      parsed[1].length > 64 ||
      !Number.isInteger(parsed[2]) ||
      (parsed[2] as number) < 0 ||
      (parsed[2] as number) > 1023 ||
      typeof parsed[3] !== "string"
    ) {
      throw new Error("invalid directory reference");
    }
    return {
      generation: parsed[1],
      bucket: parsed[2] as number,
      opaqueKey: opaqueCredentialKey(parsed[3]),
    };
  } catch (error) {
    throw new Error("IDENTITY_DIRECTORY_REFERENCE_INVALID", { cause: error });
  }
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
