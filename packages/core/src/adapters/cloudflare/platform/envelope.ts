import { isSerializableError } from "@repo/core/lib/error";
import {
  RPC_ENVELOPE_VERSION,
  type RpcEnvelope,
} from "@repo/core/lib/rpcEnvelope";

/**
 * Construction helpers for the RPC value envelope. The *types* live in
 * `@repo/core/lib/rpcEnvelope` and are deliberately not re-exported here —
 * re-exporting would let `application/rpc/restoreError.ts` reach the adapter
 * layer under a different name, which reverses the inward-only dependency
 * direction.
 */

export function ok<T>(value: T): RpcEnvelope<T> {
  return { v: RPC_ENVELOPE_VERSION, ok: true, value };
}

export function err(error: unknown): RpcEnvelope<never> {
  if (isSerializableError(error)) {
    return { v: RPC_ENVELOPE_VERSION, ok: false, error: error.toSerialized() };
  }
  // A throw that carries no serialized form still leaves as `system`, never as
  // presentation's `unknown` variant — that keeps "no envelope ever carries
  // `unknown`" true, which is why `restoreError` does not list it. The raw
  // message stays in: this hop is server-to-server, and `redactForClient` at
  // the transport boundary is what strips it before a client sees it.
  return {
    v: RPC_ENVELOPE_VERSION,
    ok: false,
    error: {
      kind: "system",
      code: "DATABASE_ERROR",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    },
  };
}
