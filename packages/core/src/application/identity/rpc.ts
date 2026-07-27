import {
  IDENTITY_RPC_VERSION,
  IDENTITY_OPERATION_ID_MAX_BYTES,
  type IdentityRpcMutation,
  type IdentityRpcQuery,
  type RpcError,
  type RpcResult,
} from "./contracts";

export function rpcOk<T>(value: T): RpcResult<T> {
  return { ok: true, value };
}

export function rpcFailure(
  kind: RpcError["kind"],
  code: string,
  message: string,
  retryable = false,
): RpcResult<never> {
  return { ok: false, error: { kind, code, message, retryable } };
}

export function rpcQuery<T>(payload: T): IdentityRpcQuery<T> {
  return { version: IDENTITY_RPC_VERSION, payload };
}

export function rpcMutation<T>(
  operationId: string,
  payload: T,
): IdentityRpcMutation<T> {
  return { version: IDENTITY_RPC_VERSION, operationId, payload };
}

function record(input: unknown): Record<string, unknown> | null {
  return typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)
    : null;
}

export function validateRpcQuery(
  input: unknown,
): RpcResult<IdentityRpcQuery<Record<string, unknown>>> {
  const value = record(input);
  if (value?.version !== IDENTITY_RPC_VERSION || !record(value.payload)) {
    return rpcFailure(
      "validation",
      "IDENTITY_RPC_VERSION_OR_SHAPE_INVALID",
      "Unsupported identity RPC request",
    );
  }
  return rpcOk({
    version: IDENTITY_RPC_VERSION,
    payload: value.payload as Record<string, unknown>,
  });
}

export function validateRpcMutation(
  input: unknown,
): RpcResult<IdentityRpcMutation<Record<string, unknown>>> {
  const query = validateRpcQuery(input);
  if (!query.ok) return query;
  const value = input as Record<string, unknown>;
  if (
    typeof value.operationId !== "string" ||
    value.operationId.trim().length === 0 ||
    new TextEncoder().encode(value.operationId.trim()).byteLength >
      IDENTITY_OPERATION_ID_MAX_BYTES
  ) {
    return rpcFailure(
      "validation",
      "IDENTITY_RPC_OPERATION_ID_REQUIRED",
      "Identity mutations require an operation ID",
    );
  }
  return rpcOk({
    ...query.value,
    operationId: value.operationId,
  });
}

export function validatePayloadKeys(
  payload: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): RpcResult<Record<string, unknown>> {
  const value = record(payload);
  const allowed = new Set([...required, ...optional]);
  if (
    !value ||
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    return rpcFailure(
      "validation",
      "IDENTITY_RPC_PAYLOAD_INVALID",
      "Invalid identity payload",
    );
  }
  return rpcOk(value);
}

export function isSafeNonNegativeInteger(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

export function rpcBoundary<T>(operation: () => T): RpcResult<T> {
  try {
    return rpcOk(operation());
  } catch (error) {
    return rpcFailure(
      "infrastructure",
      error instanceof Error && error.message.includes("SQLITE_FULL")
        ? "SQLITE_FULL"
        : "IDENTITY_STORAGE_ERROR",
      "Identity storage operation failed",
      true,
    );
  }
}
