import type {
  ExpectedVersion,
  Versioned,
} from "@repo/core/domain/common/transactionalRepository";
import type { ActiveAiClientConnection, AiClientConnection } from "../entity";
import type { AiClientConnectionId } from "../valueObject";

/**
 * `AiClientConnection` persistence inside the user's own Durable Object
 * (`spec/domains/identity.md`). No method takes a `userId`: the object
 * was selected before the call, so another user's connection id is simply
 * absent. The `status` column this repository reads is the authority on
 * revocation — nothing propagates it anywhere else.
 */
export interface AiClientConnectionRepository {
  insert(connection: ActiveAiClientConnection): void;
  /** OCC on `version`; a zero-row update is `ConflictError("OPTIMISTIC_LOCK_FAILURE")`. */
  save(
    connection: AiClientConnection,
    expectedVersion: ExpectedVersion<AiClientConnection>,
  ): void;
  findById(id: AiClientConnectionId): Versioned<AiClientConnection> | null;
  /** Every connection, revoked ones included; `connectedAt` descending. */
  listByUserId(): readonly AiClientConnection[];
  /** The authorization guard's read: `null` for revoked and unknown alike. */
  findActiveById(
    id: AiClientConnectionId,
  ): Versioned<ActiveAiClientConnection> | null;
  /**
   * Best-effort single UPDATE of `lastUsedAt` — no OCC, `version`
   * untouched, later wins, and never throws: the API call it accompanies
   * must not fail because of it.
   */
  recordUsage(id: AiClientConnectionId, lastUsedAt: Date): void;
}
