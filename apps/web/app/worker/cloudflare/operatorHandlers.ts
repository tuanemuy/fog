import {
  type MappingKeyring,
  mappingKeyringFromEnv,
} from "@repo/core/adapters/cloudflare/crypto/keyring";
import {
  callDurableObject,
  directoryStub,
  userDataStub,
} from "@repo/core/adapters/cloudflare/doStubs";
import type { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
import { IMPORT_ROWS_PER_CALL } from "@repo/core/adapters/cloudflare/rotation/mappingRows";
import type { UserDataDurableObject } from "@repo/core/adapters/cloudflare/userDataDurableObject";
import type { RpcEnvelope } from "@repo/core/application/delivery/types";
import type { ServerEnv } from "@repo/core/application/di/serverCloudflare";
import {
  ConsoleLogger,
  type Logger,
} from "@repo/core/application/ports/logger";
import { z } from "zod";
import { httpStatusFor, serializeError } from "@/presentation/errorResponse";

export const OPERATOR_PATH_PREFIX = "/__operator/";
export const MIN_OPERATOR_TOKEN_LENGTH = 32;

const DIRECTORY_LOCATOR = /^dir:g(\d+):b(\d+)$/;
const USER_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The maintenance entries of `spec/database/index.md` this surface
 * exposes, keyed by the `<entry>` segment. Each names the class it
 * addresses, what its body carries beyond `locator`, and what it calls.
 */
const cursorSchema = z
  .object({
    completedAt: z.number().int().nonnegative(),
    operationKey: z.string().min(1),
  })
  .nullable()
  .optional();
const eventCursorSchema = z
  .object({
    completedAt: z.number().int().nonnegative(),
    eventId: z.string().min(1),
  })
  .nullable()
  .optional();

type Target =
  | { kind: "directory"; generation: number; bucketIndex: number }
  | { kind: "user"; userId: string };

type EntrySpec = Readonly<{
  targets: readonly Target["kind"][];
  schema: z.ZodType<Record<string, unknown>>;
  call: (
    stub: IdentityDirectoryDurableObject | UserDataDurableObject,
    args: Record<string, unknown>,
  ) => Promise<RpcEnvelope<unknown>>;
  /** What the audit line records as the acted-on id, if any: an argument's name, or a projection of the arguments. */
  auditId?: string | ((args: Record<string, unknown>) => string | undefined);
}>;

const BOTH: readonly Target["kind"][] = ["directory", "user"];

/** A keyring entry as the rotation entries take it: the key travels in the body and is used once (`spec/rotation/index.md`, C2). */
const keyEntrySchema = z.object({
  role: z.enum(["active", "previous"]),
  generation: z.number().int().min(1),
  key: z.string().min(1),
  bucketCount: z.number().int().min(1),
});

/** One transferred row, every column, as `import-remapped-mappings` receives it. */
const mappingRowSchema = z.object({
  credentialId: z.string().min(1),
  kind: z.enum(["email", "sso"]),
  hmac: z.string().regex(/^[0-9a-f]{64}$/),
  generation: z.number().int().min(1),
  userId: z.string().nullable(),
  status: z.enum(["reserved", "active"]),
  passwordVerifier: z.string().nullable(),
  pendingVerifier: z.string().nullable(),
  changeState: z.enum(["pending", "advanced"]).nullable(),
  changeOrigin: z.enum(["password-change", "reset"]).nullable(),
  credentialVersion: z.number().int(),
  encryptedCanonical: z.string(),
  encryptionGeneration: z.number().int().min(1),
  encryptionNonce: z.string(),
  failedAttempts: z.number().int(),
  nextAttemptAllowedAt: z.number().nullable(),
  operationId: z.string().nullable(),
  candidateUserId: z.string().nullable(),
  reservedUntil: z.number(),
  sagaCommitted: z.number().nullable(),
  locators: z.string().nullable(),
  coordinatorLocator: z.string().nullable(),
  callerToken: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const locatorDtoSchema = z.object({
  credentialId: z.string().min(1),
  kind: z.enum(["email", "sso"]),
  mapping: z.string().min(1),
  credentialVersion: z.number().int(),
  usableForLogin: z.boolean(),
  label: z.string(),
});

export const OPERATOR_ENTRIES: Readonly<Record<string, EntrySpec>> = {
  "read-schema-version": {
    targets: BOTH,
    schema: z.object({}),
    call: (stub) => stub.readSchemaVersion(),
  },
  "list-bucket-user-ids": {
    targets: ["directory"],
    schema: z.object({}),
    call: (stub) =>
      (stub as IdentityDirectoryDurableObject).listBucketUserIds(),
  },
  "read-delivery-backlog": {
    targets: BOTH,
    schema: z.object({}),
    call: (stub) => stub.readDeliveryBacklog(),
  },
  "list-quarantined-events": {
    targets: BOTH,
    schema: z.object({ cursor: eventCursorSchema }),
    call: (stub, args) =>
      stub.listQuarantinedEvents(
        args.cursor as
          | { completedAt: number; eventId: string }
          | null
          | undefined,
      ),
  },
  "requeue-quarantined-event": {
    targets: BOTH,
    schema: z.object({ eventId: z.string().min(1).max(128) }),
    call: (stub, args) => stub.requeueQuarantinedEvent(args.eventId as string),
    auditId: "eventId",
  },
  "delete-quarantined-event": {
    targets: BOTH,
    schema: z.object({ eventId: z.string().min(1).max(128) }),
    call: (stub, args) => stub.deleteQuarantinedEvent(args.eventId as string),
    auditId: "eventId",
  },
  "list-poisoned-jobs": {
    targets: BOTH,
    schema: z.object({ cursor: cursorSchema }),
    call: (stub, args) =>
      stub.listPoisonedJobs(
        args.cursor as
          | { completedAt: number; operationKey: string }
          | null
          | undefined,
      ),
  },
  "requeue-poisoned-job": {
    targets: BOTH,
    schema: z.object({ operationKey: z.string().min(1).max(256) }),
    call: (stub, args) => stub.requeuePoisonedJob(args.operationKey as string),
    auditId: "operationKey",
  },
  "delete-poisoned-job": {
    targets: BOTH,
    schema: z.object({ operationKey: z.string().min(1).max(256) }),
    call: (stub, args) => stub.deletePoisonedJob(args.operationKey as string),
    auditId: "operationKey",
  },
  "purge-user-mappings": {
    targets: ["directory"],
    schema: z.object({ userId: z.string().regex(USER_ID) }),
    call: (stub, args) =>
      (stub as IdentityDirectoryDurableObject).purgeUserMappings(
        args.userId as string,
      ),
    auditId: "userId",
  },
  // The rotation entries (`spec/rotation/index.md`). The keys ride in the
  // body and are never logged: the audit id is a credential id at most.
  "start-rotate-encryption": {
    targets: ["directory"],
    schema: z.object({}),
    call: (stub) =>
      (stub as IdentityDirectoryDurableObject).startRotateEncryption(),
  },
  "remap-chunk": {
    targets: ["directory"],
    schema: z.object({
      active: keyEntrySchema,
      previous: keyEntrySchema,
      limit: z.number().int().min(1).max(500),
      afterCredentialId: z.string().min(1).nullable().optional(),
    }),
    call: (stub, args) =>
      (stub as IdentityDirectoryDurableObject).remapChunk({
        active: args.active as z.infer<typeof keyEntrySchema>,
        previous: args.previous as z.infer<typeof keyEntrySchema>,
        limit: args.limit as number,
        afterCredentialId: (args.afterCredentialId as string | null) ?? null,
      }),
    auditId: (args) => (args.afterCredentialId as string | null) ?? undefined,
  },
  "import-remapped-mappings": {
    targets: ["directory"],
    schema: z.object({
      active: keyEntrySchema,
      rows: z.array(mappingRowSchema).min(1).max(IMPORT_ROWS_PER_CALL),
    }),
    call: (stub, args) =>
      (stub as IdentityDirectoryDurableObject).importRemappedMappings({
        active: args.active as z.infer<typeof keyEntrySchema>,
        rows: args.rows as z.infer<typeof mappingRowSchema>[],
      }),
  },
  // The body's `locator` is the target User Data DO; the reverse-index
  // row to record is `credentialLocator`.
  "record-remapped-locator": {
    targets: ["user"],
    schema: z.object({
      callerToken: z.string().min(1),
      credentialLocator: locatorDtoSchema,
    }),
    call: (stub, args) =>
      (stub as UserDataDurableObject).recordRemappedLocator({
        callerToken: args.callerToken as string,
        locator: args.credentialLocator as z.infer<typeof locatorDtoSchema>,
      }),
    auditId: (args) =>
      (args.credentialLocator as z.infer<typeof locatorDtoSchema>).credentialId,
  },
  "read-rotation-checkpoint": {
    targets: ["directory"],
    schema: z.object({
      rotationKind: z.enum(["remap", "encryption"]),
      generation: z.number().int().min(1),
    }),
    call: (stub, args) =>
      (stub as IdentityDirectoryDurableObject).readRotationCheckpoint({
        rotationKind: args.rotationKind as "remap" | "encryption",
        generation: args.generation as number,
      }),
  },
};

/**
 * The generations a `dir:` locator may name, with their bucket counts:
 * both entries of the request Worker's keyring while a rotation is open,
 * so the retiring generation's buckets stay addressable for `remap-chunk`
 * and `read-rotation-checkpoint`. A keyring the request path cannot
 * build is an error, not a fallback: the surface answers 500 rather than
 * silently addressing generation 1 alone.
 */
export function operatorBuckets(
  env: ServerEnv,
): readonly { generation: number; bucketCount: number }[] {
  const keyring: MappingKeyring = mappingKeyringFromEnv(
    env.DIRECTORY_ROUTING_KEYRING,
    env.DIRECTORY_ROUTING_SECRET,
  );
  return keyring.entries.map((entry) => ({
    generation: entry.generation,
    bucketCount: entry.bucketCount,
  }));
}

export type OperatorDeps = Readonly<{
  env: ServerEnv;
  logger?: Logger;
  /** The generations and bucket counts a `dir:` locator may name; {@link operatorBuckets} when omitted. */
  buckets?: readonly { generation: number; bucketCount: number }[];
}>;

export function isOperatorRoute(pathname: string): boolean {
  return pathname.startsWith(OPERATOR_PATH_PREFIX);
}

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

/** Constant time over the digests: neither length nor content leaks by timing. */
async function tokenMatches(
  presented: string,
  expected: string,
): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function parseLocator(
  raw: unknown,
  buckets: readonly { generation: number; bucketCount: number }[],
): Target | null {
  if (typeof raw !== "string") return null;
  const bucket = DIRECTORY_LOCATOR.exec(raw);
  if (bucket !== null) {
    const generation = Number(bucket[1]);
    const bucketIndex = Number(bucket[2]);
    const known = buckets.find((b) => b.generation === generation);
    // `allowInitialize: true` on the bucket class means a locator nobody
    // derives would create an empty object; the keyring bounds it.
    if (known === undefined || bucketIndex >= known.bucketCount) return null;
    return { kind: "directory", generation, bucketIndex };
  }
  if (USER_ID.test(raw)) return { kind: "user", userId: raw };
  return null;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * `POST /__operator/<entry>` (docs/runtime_cloudflare.md §8.2, design
 * D-16 △-9): the maintenance entries of both Durable Object classes,
 * reachable only with the request Worker's `OPERATOR_TOKEN`. With the
 * secret unset the whole surface is absent (404) rather than open. Body
 * `{ locator, ...args }`; the answer is the envelope's value or its
 * serialized error verbatim — the operator is who reads internals. The
 * audit line carries the entry, the locator, the outcome and the acted-on
 * id, and never the response body.
 */
export async function handleOperator(
  request: Request,
  deps: OperatorDeps,
): Promise<Response> {
  const logger = deps.logger ?? ConsoleLogger;
  const token = deps.env.OPERATOR_TOKEN;
  if (token === undefined || token.length < MIN_OPERATOR_TOKEN_LENGTH) {
    return new Response("Not found", { status: 404 });
  }
  const url = new URL(request.url);
  const entryName = url.pathname.slice(OPERATOR_PATH_PREFIX.length);
  const entry = OPERATOR_ENTRIES[entryName];
  if (entry === undefined) return new Response("Not found", { status: 404 });
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const presented = /^Bearer\s+(\S+)$/i.exec(
    request.headers.get("authorization") ?? "",
  );
  if (presented === null || !(await tokenMatches(presented[1] ?? "", token))) {
    return new Response(null, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "The body must be JSON" }, 400);
  }
  if (typeof body !== "object" || body === null) {
    return json({ error: "The body must be an object" }, 400);
  }
  const { locator, ...rest } = body as Record<string, unknown>;
  let buckets: readonly { generation: number; bucketCount: number }[];
  try {
    buckets = deps.buckets ?? operatorBuckets(deps.env);
  } catch {
    // The variable's value never reaches the answer or the log.
    return json({ error: "DIRECTORY_ROUTING_KEYRING is not usable" }, 500);
  }
  const target = parseLocator(locator, buckets);
  if (target === null || !entry.targets.includes(target.kind)) {
    return json({ error: "locator is not one this entry accepts" }, 400);
  }
  const parsed = entry.schema.safeParse(rest);
  if (!parsed.success) {
    return json(
      {
        error: "Invalid arguments",
        issues: parsed.error.issues.map((i) => i.message),
      },
      400,
    );
  }
  const stub =
    target.kind === "directory"
      ? (directoryStub(
          deps.env.IDENTITY_DIRECTORY,
          target,
        ) as unknown as IdentityDirectoryDurableObject)
      : (userDataStub(
          deps.env.USER_DATA,
          target.userId,
        ) as unknown as UserDataDurableObject);
  const auditId =
    entry.auditId === undefined
      ? undefined
      : typeof entry.auditId === "function"
        ? entry.auditId(parsed.data)
        : String(parsed.data[entry.auditId]);
  const audit = {
    entry: entryName,
    locator: locator as string,
    ...(auditId === undefined ? {} : { id: auditId }),
  };
  try {
    const result = await callDurableObject(() => entry.call(stub, parsed.data));
    logger.info("operator", { ...audit, outcome: "ok" });
    return json({ ok: true, result }, 200);
  } catch (error) {
    const serialized = serializeError(error);
    logger.info("operator", {
      ...audit,
      outcome: serialized.code ?? serialized.kind,
    });
    return json({ ok: false, error: serialized }, httpStatusFor(serialized));
  }
}
