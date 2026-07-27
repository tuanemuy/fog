import type { DurableObjectNamespace } from "@cloudflare/workers-types";
import {
  readPitrBookmark,
  schedulePitrRestore,
  type PitrOperatorDependencies,
} from "@repo/core/adapters/cloudflare/pitrOperator";
import type { AccountHomeDurableObject } from "../durable-objects/AccountHomeDurableObject";
import type { IdentityDirectoryDurableObject } from "../durable-objects/IdentityDirectoryDurableObject";
import type { UserDataDurableObject } from "../durable-objects/UserDataDurableObject";

type PitrCapableStub = Readonly<{
  operatorGetCurrentBookmark(): Promise<string>;
  operatorRestoreBookmark(bookmark: string): Promise<string>;
}>;

export type PitrOperatorEnv = Readonly<{
  PITR_OPERATOR_TOKEN?: string;
  USER_DATA: DurableObjectNamespace<UserDataDurableObject>;
  IDENTITY_DIRECTORY: DurableObjectNamespace<IdentityDirectoryDurableObject>;
  ACCOUNT_HOME: DurableObjectNamespace<AccountHomeDurableObject>;
}>;

type OperatorInput = Readonly<{
  action: "bookmark" | "restore";
  className: string;
  objectName: string;
  accountId: string;
  bookmark?: string;
}>;

async function tokenMatches(
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

function isOperatorInput(value: unknown): value is OperatorInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    (input.action === "bookmark" || input.action === "restore") &&
    typeof input.className === "string" &&
    typeof input.objectName === "string" &&
    input.objectName.length > 0 &&
    typeof input.accountId === "string" &&
    input.accountId.length > 0 &&
    (input.bookmark === undefined || typeof input.bookmark === "string")
  );
}

function dependencies(env: PitrOperatorEnv): PitrOperatorDependencies {
  return {
    async readAccountAuthority(accountId) {
      const result = await env.ACCOUNT_HOME.getByName(accountId).getAuthSummary(
        {
          version: 1,
          payload: {},
        },
      );
      if (!result.ok) throw new Error(result.error.code);
      if (result.value === null) throw new Error("ACCOUNT_NOT_FOUND");
      return {
        status: result.value.status,
        epoch: result.value.operationEpoch,
      };
    },
    resolveTarget(className, objectName) {
      const stub = (className === "UserDataDurableObject"
        ? env.USER_DATA.getByName(objectName)
        : env.IDENTITY_DIRECTORY.getByName(
            objectName,
          )) as unknown as PitrCapableStub;
      return {
        getCurrentBookmark: () => stub.operatorGetCurrentBookmark(),
        scheduleRestore: (bookmark) => stub.operatorRestoreBookmark(bookmark),
      };
    },
  };
}

export async function handlePitrOperatorRequest(
  request: Request,
  env: PitrOperatorEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/_operator/pitr") return undefined;
  if (request.method !== "POST") {
    return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }
  const expectedToken = env.PITR_OPERATOR_TOKEN;
  const authorization = request.headers.get("authorization");
  const candidateToken = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (
    expectedToken === undefined ||
    expectedToken.length < 32 ||
    !(await tokenMatches(expectedToken, candidateToken))
  ) {
    return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
  }

  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return Response.json({ error: "INVALID_OPERATOR_INPUT" }, { status: 400 });
  }
  if (!isOperatorInput(input)) {
    return Response.json({ error: "INVALID_OPERATOR_INPUT" }, { status: 400 });
  }

  try {
    const target = {
      className: input.className,
      objectName: input.objectName,
      accountId: input.accountId,
    };
    if (input.action === "bookmark") {
      return Response.json({
        bookmark: await readPitrBookmark(target, dependencies(env)),
      });
    }
    if (input.bookmark === undefined || input.bookmark.length === 0) {
      return Response.json({ error: "BOOKMARK_REQUIRED" }, { status: 400 });
    }
    return Response.json(
      await schedulePitrRestore(
        { ...target, bookmark: input.bookmark },
        dependencies(env),
      ),
    );
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "PITR_OPERATOR_FAILED",
      },
      { status: 409 },
    );
  }
}
