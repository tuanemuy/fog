import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import { validateDirectoryKeyring } from "@repo/core/adapters/cloudflare/identityRouting";
import {
  isExpectedPitrRestartError,
  type PitrObject,
  type PitrOperatorDependencies,
  type PitrReceipt,
  type PitrTarget,
  readPitrBookmark,
  restartPitrTarget,
  schedulePitrRestore,
  schedulePitrUndo,
  verifyPitrRestore,
} from "@repo/core/adapters/cloudflare/pitrOperator";
import type { AccountHomeDurableObject } from "../durable-objects/AccountHomeDurableObject";
import type { IdentityDirectoryDurableObject } from "../durable-objects/IdentityDirectoryDurableObject";
import type { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";

type PitrCapableStub = Readonly<{
  operatorGetCurrentBookmark(): Promise<string>;
  operatorPrepareRestoreProof(proofId: string): Promise<{ sessionId: string }>;
  operatorRestoreBookmark(bookmark: string): Promise<string>;
  operatorRestartSession(): Promise<void>;
  operatorVerifyRestoredSession(
    bookmark: string,
    proof: PitrReceipt["proof"],
  ): Promise<string>;
}>;

export type PitrOperatorEnv = Readonly<{
  PITR_OPERATOR_TOKEN?: string;
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
  IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectoryDurableObject>;
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
  DIRECTORY_ROUTING_SECRET_ACTIVE?: string;
  DIRECTORY_ROUTING_SECRET_PREVIOUS?: string;
  DIRECTORY_ROUTING_GENERATION_ACTIVE?: string;
  DIRECTORY_ROUTING_GENERATION_PREVIOUS?: string;
}>;

type OperatorInput =
  | Readonly<{
      action: "bookmark" | "schedule";
      target: PitrTarget;
      bookmark?: string;
    }>
  | Readonly<{
      action: "restart" | "verify" | "undo";
      receipt: PitrReceipt;
    }>;
const DIRECTORY_BUCKET_COUNT = 64;

export async function operatorTokenMatches(
  expected: string,
  candidate: string,
): Promise<boolean> {
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const message = new TextEncoder().encode("fog-pitr-operator-auth");
  const expectedKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(expected),
    algorithm,
    false,
    ["sign", "verify"],
  );
  const candidateKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(candidate.length === 0 ? "\0" : candidate),
    algorithm,
    false,
    ["sign"],
  );
  const candidateSignature = await crypto.subtle.sign(
    algorithm,
    candidateKey,
    message,
  );
  return crypto.subtle.verify(
    algorithm,
    expectedKey,
    candidateSignature,
    message,
  );
}

function isTarget(value: unknown): value is PitrTarget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const target = value as Record<string, unknown>;
  return (
    (target.kind === "user-data" &&
      typeof target.accountId === "string" &&
      target.accountId.length > 0 &&
      Object.keys(target).every(
        (key) => key === "kind" || key === "accountId",
      )) ||
    (target.kind === "identity-directory" &&
      typeof target.generation === "string" &&
      target.generation.length > 0 &&
      target.generation.length <= 64 &&
      Number.isInteger(target.bucket) &&
      Number(target.bucket) >= 0 &&
      Number(target.bucket) < DIRECTORY_BUCKET_COUNT &&
      Object.keys(target).every(
        (key) => key === "kind" || key === "generation" || key === "bucket",
      ))
  );
}

function isReceipt(value: unknown): value is PitrReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  const target = receipt.target as Record<string, unknown> | undefined;
  const canonicalTarget =
    target !== undefined &&
    ((target.kind === "user-data" &&
      typeof target.accountId === "string" &&
      target.accountId.length > 0 &&
      typeof target.objectName === "string" &&
      target.objectName.length > 0) ||
      (target.kind === "identity-directory" &&
        typeof target.generation === "string" &&
        target.generation.length > 0 &&
        Number.isInteger(target.bucket) &&
        Number(target.bucket) >= 0 &&
        Number(target.bucket) < DIRECTORY_BUCKET_COUNT));
  const authority = receipt.authority as Record<string, unknown> | undefined;
  const proof = receipt.proof as Record<string, unknown> | undefined;
  const proofValid =
    proof !== undefined &&
    typeof proof.id === "string" &&
    proof.id.length > 0 &&
    typeof proof.previousSessionId === "string" &&
    proof.previousSessionId.length > 0 &&
    typeof proof.undoBookmark === "string" &&
    proof.undoBookmark === receipt.undoBookmark;
  const authorityValid =
    target?.kind !== "user-data" ||
    (authority !== undefined &&
      typeof authority.status === "string" &&
      Number.isInteger(authority.epoch));
  const totals = receipt.reconciliationTotals as
    | Record<string, unknown>
    | undefined;
  const totalsValid =
    target?.kind !== "identity-directory" ||
    (totals !== undefined &&
      Number.isInteger(totals.scanned) &&
      Number(totals.scanned) >= 0 &&
      Number.isInteger(totals.tombstoned) &&
      Number(totals.tombstoned) >= 0 &&
      Number.isInteger(totals.conflictsObserved) &&
      Number(totals.conflictsObserved) >= 0);
  return (
    receipt.version === 2 &&
    typeof receipt.restoreBookmark === "string" &&
    receipt.restoreBookmark.length > 0 &&
    typeof receipt.undoBookmark === "string" &&
    receipt.undoBookmark.length > 0 &&
    canonicalTarget &&
    authorityValid &&
    proofValid &&
    totalsValid &&
    (receipt.reconcileCursor === undefined ||
      receipt.reconcileCursor === null ||
      typeof receipt.reconcileCursor === "string")
  );
}

function isOperatorInput(value: unknown): value is OperatorInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  if (input.action === "bookmark" || input.action === "schedule") {
    return (
      isTarget(input.target) &&
      (input.bookmark === undefined || typeof input.bookmark === "string")
    );
  }
  return (
    (input.action === "restart" ||
      input.action === "verify" ||
      input.action === "undo") &&
    isReceipt(input.receipt)
  );
}

function objectAdapter(stub: PitrCapableStub): PitrObject {
  return {
    getCurrentBookmark: () => stub.operatorGetCurrentBookmark(),
    prepareRestoreProof: (proofId) => stub.operatorPrepareRestoreProof(proofId),
    scheduleRestore: (bookmark) => stub.operatorRestoreBookmark(bookmark),
    restartSession: () => stub.operatorRestartSession(),
    verifyRestoredSession: (bookmark, proof) =>
      stub.operatorVerifyRestoredSession(bookmark, proof),
  };
}

function dependencies(env: PitrOperatorEnv): PitrOperatorDependencies {
  const directoryGateway = () => {
    if (env.DIRECTORY_ROUTING_SECRET_ACTIVE === undefined) {
      throw new Error("DIRECTORY_ROUTING_SECRET_ACTIVE_REQUIRED");
    }
    const previous =
      env.DIRECTORY_ROUTING_SECRET_PREVIOUS !== undefined &&
      env.DIRECTORY_ROUTING_GENERATION_PREVIOUS !== undefined
        ? {
            secret: env.DIRECTORY_ROUTING_SECRET_PREVIOUS,
            generation: env.DIRECTORY_ROUTING_GENERATION_PREVIOUS,
          }
        : undefined;
    return new CloudflareIdentityGateway(
      env.IDENTITY_DIRECTORY,
      env.ACCOUNT_HOME,
      env.USER_DATA,
      validateDirectoryKeyring({
        active: {
          secret: env.DIRECTORY_ROUTING_SECRET_ACTIVE,
          generation: env.DIRECTORY_ROUTING_GENERATION_ACTIVE ?? "generation-1",
        },
        ...(previous === undefined ? {} : { previous }),
      }),
    );
  };
  return {
    async resolveUserData(accountId) {
      const result = await env.ACCOUNT_HOME.getByName(accountId).getAuthSummary(
        {
          version: 1,
          payload: {},
        },
      );
      if (!result.ok) throw new Error(result.error.code);
      if (result.value === null) throw new Error("ACCOUNT_NOT_FOUND");
      const objectName = result.value.userId;
      return {
        objectName,
        authority: {
          status: result.value.status,
          epoch: result.value.operationEpoch,
        },
        object: objectAdapter(
          env.USER_DATA.getByName(objectName) as unknown as PitrCapableStub,
        ),
      };
    },
    resolveDirectory(target) {
      const configuredGenerations = new Set([
        env.DIRECTORY_ROUTING_GENERATION_ACTIVE ?? "generation-1",
        ...(env.DIRECTORY_ROUTING_SECRET_PREVIOUS !== undefined &&
        env.DIRECTORY_ROUTING_GENERATION_PREVIOUS !== undefined
          ? [env.DIRECTORY_ROUTING_GENERATION_PREVIOUS]
          : []),
      ]);
      if (
        !configuredGenerations.has(target.generation) ||
        !Number.isInteger(target.bucket) ||
        target.bucket < 0 ||
        target.bucket >= DIRECTORY_BUCKET_COUNT
      ) {
        throw new Error("DIRECTORY_SHARD_NOT_CONFIGURED");
      }
      const { generation, bucket } = target;
      const shard = `${generation}:${bucket}`;
      const object = objectAdapter(
        env.IDENTITY_DIRECTORY.getByName(shard) as unknown as PitrCapableStub,
      );
      const gateway = directoryGateway();
      return {
        ...object,
        async reconcileDirectoryAuthority(cursor) {
          const result = await gateway.operatorReconcileRestoredPage({
            generation,
            bucket,
            ...(cursor === undefined ? {} : { cursor }),
            limit: 100,
            now: Date.now(),
          });
          return {
            complete: result.complete,
            scanned: result.scanned,
            tombstoned: result.tombstoned,
            conflicts: result.conflicts,
            cursor: result.nextCursor,
          };
        },
      };
    },
  };
}

export function operatorResponse(
  value: unknown,
  init?: ResponseInit,
): Response {
  const result = Response.json(value, init);
  result.headers.set("cache-control", "no-store");
  result.headers.set("pragma", "no-cache");
  return result;
}

export async function handlePitrOperatorRequest(
  request: Request,
  env: PitrOperatorEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/_operator/pitr") return undefined;
  if (request.method !== "POST") {
    return operatorResponse({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }
  const expectedToken = env.PITR_OPERATOR_TOKEN;
  const authorization = request.headers.get("authorization");
  const candidateToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (
    expectedToken === undefined ||
    expectedToken.length < 32 ||
    !(await operatorTokenMatches(expectedToken, candidateToken))
  ) {
    return operatorResponse({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return operatorResponse(
      { error: "INVALID_OPERATOR_INPUT" },
      { status: 400 },
    );
  }
  if (!isOperatorInput(input)) {
    return operatorResponse(
      { error: "INVALID_OPERATOR_INPUT" },
      { status: 400 },
    );
  }

  const operatorDependencies = dependencies(env);
  try {
    if (input.action === "bookmark") {
      return operatorResponse({
        bookmark: await readPitrBookmark(input.target, operatorDependencies),
      });
    }
    if (input.action === "schedule") {
      if (input.bookmark === undefined || input.bookmark.length === 0) {
        return operatorResponse(
          { error: "BOOKMARK_REQUIRED" },
          { status: 400 },
        );
      }
      return operatorResponse(
        await schedulePitrRestore(
          input.target,
          input.bookmark,
          operatorDependencies,
        ),
      );
    }
    if (input.action === "restart") {
      try {
        await restartPitrTarget(input.receipt, operatorDependencies);
      } catch (error) {
        if (isExpectedPitrRestartError(error)) {
          return operatorResponse(
            { phase: "restart-requested" },
            { status: 202 },
          );
        }
        throw error;
      }
    }
    if (input.action === "verify") {
      const verification = await verifyPitrRestore(
        input.receipt,
        operatorDependencies,
      );
      if (
        verification.reconciliation !== undefined &&
        verification.reconciliation.conflicts > 0
      ) {
        return operatorResponse(
          { error: "DIRECTORY_RECONCILIATION_CONFLICT", verification },
          { status: 409 },
        );
      }
      return operatorResponse(verification);
    }
    if (input.action === "undo") {
      return operatorResponse(
        await schedulePitrUndo(input.receipt, operatorDependencies),
      );
    }
    return operatorResponse(
      { error: "INVALID_OPERATOR_INPUT" },
      { status: 400 },
    );
  } catch (error) {
    return operatorResponse(
      {
        error: error instanceof Error ? error.message : "PITR_OPERATOR_FAILED",
      },
      { status: 409 },
    );
  }
}
