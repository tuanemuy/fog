import type { SerializedErrorBase } from "./error";

/**
 * The value envelope errors travel in across the request Worker ↔ Durable
 * Object boundary. RPC does not preserve the structural `toSerialized()`
 * contract of a thrown custom class, so the DO's RPC entry catches and
 * returns the serialized form as a *value*.
 *
 * The types live in `lib/` rather than in `adapters/cloudflare/platform/`
 * because the restoration side (`application/rpc/restoreError.ts`) needs them
 * too, and an application → adapters import would be a reversed dependency
 * (ADR-014). `lib/` is what `CLAUDE.md` defines as the structural primitives
 * every layer may depend on.
 *
 * Note the payload type is deliberately *not* presentation's `SerializedError`
 * union: that union is assembled in `apps/web/app/presentation/errorResponse.ts`
 * and depending on it from `packages/core` would reverse the dependency the
 * other way.
 */

export const RPC_ENVELOPE_VERSION = 1;

export type SerializedErrorPayload = SerializedErrorBase & {
  readonly kind: string;
};

export type RpcEnvelope<T> =
  | { readonly v: number; readonly ok: true; readonly value: T }
  | {
      readonly v: number;
      readonly ok: false;
      readonly error: SerializedErrorPayload;
    };
