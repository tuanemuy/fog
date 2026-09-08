import { NotFoundError } from "../errors";

export { rebuildActor, toActorDto } from "../identity/actorDto";

export function topicNotFound(): NotFoundError {
  return new NotFoundError("TOPIC_NOT_FOUND", "The topic was not found");
}

export function documentNotFound(): NotFoundError {
  return new NotFoundError("DOCUMENT_NOT_FOUND", "The document was not found");
}

export function revisionNotFound(): NotFoundError {
  return new NotFoundError("REVISION_NOT_FOUND", "The revision was not found");
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
