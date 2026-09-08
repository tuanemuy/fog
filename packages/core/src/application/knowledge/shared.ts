import {
  Actor,
  AiClientConnectionId,
  ClientName,
  UserId,
} from "@repo/core/domain/identity/valueObject";
import { NotFoundError } from "../errors";
import type { ActorDto } from "./gateway";

export function topicNotFound(): NotFoundError {
  return new NotFoundError("TOPIC_NOT_FOUND", "The topic was not found");
}

export function documentNotFound(): NotFoundError {
  return new NotFoundError("DOCUMENT_NOT_FOUND", "The document was not found");
}

export function revisionNotFound(): NotFoundError {
  return new NotFoundError("REVISION_NOT_FOUND", "The revision was not found");
}

/** The second validation point: the value objects rebuilt inside the DO. */
export function rebuildActor(dto: ActorDto): Actor {
  const userId = UserId.create(dto.userId);
  return dto.kind === "user"
    ? Actor.user(userId)
    : Actor.aiClient(
        userId,
        AiClientConnectionId.create(dto.connectionId),
        ClientName.create(dto.clientName),
      );
}

export function toActorDto(actor: Actor): ActorDto {
  return actor.kind === "user"
    ? { kind: "user", userId: actor.userId }
    : {
        kind: "aiClient",
        userId: actor.userId,
        connectionId: actor.connectionId,
        clientName: actor.clientName,
      };
}

/** A blank reason is "let the application choose"; it travels as `null`. */
export function blankToNull(reason: string | null | undefined): string | null {
  const trimmed = reason?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
}

/** A blank reason is "let the application choose". */
export function reasonOrDefault(
  reason: string | null | undefined,
  fallback: string,
): string {
  const trimmed = reason?.trim() ?? "";
  return trimmed.length === 0 ? fallback : trimmed;
}
