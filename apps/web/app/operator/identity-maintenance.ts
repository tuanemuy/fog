import { CloudflareIdentityGateway } from "@repo/core/adapters/cloudflare/identityGateway";
import {
  readRequestServerConfig,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import {
  operatorResponse,
  operatorTokenMatches,
  type PitrOperatorEnv,
} from "./pitr";

type MaintenanceInput = Readonly<{
  action: "rotate-page" | "reconcile-page" | "status";
  generation: string;
  bucket: number;
  limit?: number;
}>;

type IdentityMaintenance = Readonly<{
  rotatePage(input: Omit<MaintenanceInput, "action">): Promise<unknown>;
  reconcilePage(input: Omit<MaintenanceInput, "action">): Promise<unknown>;
  status(input: { generation: string; bucket: number }): Promise<unknown>;
}>;

export type IdentityMaintenanceEnv = ServerEnv & PitrOperatorEnv;

function isInput(value: unknown): value is MaintenanceInput {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const input = value as Record<string, unknown>;
  return (
    (input.action === "rotate-page" ||
      input.action === "reconcile-page" ||
      input.action === "status") &&
    typeof input.generation === "string" &&
    input.generation.length > 0 &&
    Number.isInteger(input.bucket) &&
    Number(input.bucket) >= 0 &&
    (input.limit === undefined ||
      (Number.isInteger(input.limit) &&
        Number(input.limit) >= 1 &&
        Number(input.limit) <= 100))
  );
}

function maintenance(env: IdentityMaintenanceEnv): IdentityMaintenance {
  const config = readRequestServerConfig(env);
  const gateway = new CloudflareIdentityGateway(
    config.identityDirectory,
    config.accountHome,
    config.userData,
    config.directoryRouting,
  );
  return {
    rotatePage: (input) =>
      gateway.operatorRotatePage({ ...input, now: Date.now() }),
    reconcilePage: (input) =>
      gateway.operatorReconcilePage({ ...input, now: Date.now() }),
    status: (input) => gateway.getDirectoryShardAuthorityStatus(input),
  };
}

export async function handleIdentityMaintenanceRequest(
  request: Request,
  env: IdentityMaintenanceEnv,
  create: (env: IdentityMaintenanceEnv) => IdentityMaintenance = maintenance,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  if (url.pathname !== "/_operator/identity-maintenance") return undefined;
  if (request.method !== "POST") {
    return operatorResponse({ error: "METHOD_NOT_ALLOWED" }, { status: 405 });
  }
  const expected = env.PITR_OPERATOR_TOKEN;
  const authorization = request.headers.get("authorization");
  const candidate = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";
  if (
    expected === undefined ||
    expected.length < 32 ||
    !(await operatorTokenMatches(expected, candidate))
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
  if (!isInput(input)) {
    return operatorResponse(
      { error: "INVALID_OPERATOR_INPUT" },
      { status: 400 },
    );
  }
  try {
    const operator = create(env);
    if (input.action === "rotate-page") {
      return operatorResponse(
        await operator.rotatePage({
          generation: input.generation,
          bucket: input.bucket,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      );
    }
    if (input.action === "reconcile-page") {
      return operatorResponse(
        await operator.reconcilePage({
          generation: input.generation,
          bucket: input.bucket,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      );
    }
    return operatorResponse(
      await operator.status({
        generation: input.generation,
        bucket: input.bucket,
      }),
    );
  } catch (error) {
    return operatorResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "IDENTITY_MAINTENANCE_FAILED",
      },
      { status: 409 },
    );
  }
}
