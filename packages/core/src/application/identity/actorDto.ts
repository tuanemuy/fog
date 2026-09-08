import {
  Actor,
  AiClientConnectionId,
  ClientName,
  UserId,
} from "@repo/core/domain/identity/valueObject";

export type UserActorDto = Readonly<{ kind: "user"; userId: string }>;

export type AiClientActorDto = Readonly<{
  kind: "aiClient";
  userId: string;
  connectionId: string;
  clientName: string;
}>;

/** `Actor` as primitives, the shape that crosses the DO boundary. */
export type ActorDto = UserActorDto | AiClientActorDto;

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
