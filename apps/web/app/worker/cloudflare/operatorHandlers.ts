import { INITIAL_DIRECTORY_BUCKET_COUNT } from "@repo/core/adapters/cloudflare/crypto/keyring";
import {
  callDurableObject,
  directoryStub,
  userDataStub,
} from "@repo/core/adapters/cloudflare/doStubs";
import type { IdentityDirectoryDurableObject } from "@repo/core/adapters/cloudflare/identityDirectoryDurableObject";
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
  /** What the audit line records as the acted-on id, if any. */
  auditId?: string;
}>;

const BOTH: readonly Target["kind"][] = ["directory", "user"];

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
};

export type OperatorDeps = Readonly<{
  env: ServerEnv;
  logger?: Logger;
  /** The generations and bucket counts a `dir:` locator may name; one generation until PH-09B. */
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
  const buckets = deps.buckets ?? [
    { generation: 1, bucketCount: INITIAL_DIRECTORY_BUCKET_COUNT },
  ];
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
  const audit = {
    entry: entryName,
    locator: locator as string,
    ...(entry.auditId === undefined
      ? {}
      : { id: String(parsed.data[entry.auditId]) }),
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
