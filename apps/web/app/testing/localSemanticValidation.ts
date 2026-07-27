import { ValidationError } from "@repo/core/application/errors";
import type { SemanticRpcCommand } from "@repo/core/application/search/contracts";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function only(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => key in value) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

function id(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function timestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 8_640_000_000_000_000
  );
}

function memo(value: unknown): boolean {
  return (
    record(value) &&
    only(value, ["id", "body", "timestamp"]) &&
    id(value.id) &&
    typeof value.body === "string" &&
    timestamp(value.timestamp)
  );
}

function document(value: unknown): boolean {
  return (
    record(value) &&
    only(value, [
      "id",
      "title",
      "body",
      "timestamp",
      "topicId",
      "sourceMemoIds",
    ]) &&
    id(value.id) &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    timestamp(value.timestamp) &&
    id(value.topicId) &&
    Array.isArray(value.sourceMemoIds) &&
    value.sourceMemoIds.every(id)
  );
}

function topic(value: unknown): boolean {
  return (
    record(value) &&
    only(value, ["id", "name", "timestamp"], ["sourceMemoId"]) &&
    id(value.id) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    new TextEncoder().encode(value.name).byteLength <= 1_024 &&
    timestamp(value.timestamp) &&
    (value.sourceMemoId === undefined || id(value.sourceMemoId))
  );
}

export function assertLocalSemanticCommand(
  command: unknown,
): asserts command is SemanticRpcCommand {
  const invalid = (): never => {
    throw new ValidationError(
      "SEMANTIC_COMMAND_INVALID",
      "Semantic command is invalid",
    );
  };
  if (
    !record(command) ||
    command.version !== 1 ||
    !id(command.operationId) ||
    typeof command.type !== "string" ||
    (command.actorId !== undefined && !id(command.actorId)) ||
    (command.expectedVersion !== undefined &&
      (typeof command.expectedVersion !== "number" ||
        !Number.isSafeInteger(command.expectedVersion) ||
        command.expectedVersion < 1)) ||
    (command.changeReason !== undefined &&
      (typeof command.changeReason !== "string" ||
        new TextEncoder().encode(command.changeReason).byteLength > 1_024))
  ) {
    return invalid();
  }
  const base = ["version", "operationId", "type"] as const;
  const mutation = ["actorId", "expectedVersion"] as const;
  let valid = false;
  switch (command.type) {
    case "create-memo":
      valid =
        only(command, [...base, "memo"], ["actorId"]) && memo(command.memo);
      break;
    case "update-memo":
      valid =
        only(command, [...base, "memo"], [...mutation, "changeReason"]) &&
        memo(command.memo);
      break;
    case "create-document":
      valid =
        only(command, [...base, "document"], ["actorId"]) &&
        document(command.document);
      break;
    case "update-document":
      valid =
        only(command, [...base, "document", "changeReason"], mutation) &&
        document(command.document) &&
        typeof command.changeReason === "string" &&
        command.changeReason.trim().length > 0;
      break;
    case "create-topic":
      valid =
        only(command, [...base, "topic"], ["actorId"]) && topic(command.topic);
      break;
    case "trash-memo":
      valid =
        only(command, [...base, "memoId", "trashedAt"], mutation) &&
        id(command.memoId) &&
        timestamp(command.trashedAt);
      break;
    case "restore-memo":
      valid =
        only(command, [...base, "memoId", "restoredAt"], mutation) &&
        id(command.memoId) &&
        timestamp(command.restoredAt);
      break;
    case "remove-memo":
      valid =
        only(command, [...base, "memoId", "removedAt"], mutation) &&
        id(command.memoId) &&
        timestamp(command.removedAt);
      break;
    case "trash-document":
      valid =
        only(command, [...base, "documentId", "trashedAt"], mutation) &&
        id(command.documentId) &&
        timestamp(command.trashedAt);
      break;
    case "restore-document":
      valid =
        only(command, [...base, "documentId", "restoredAt"], mutation) &&
        id(command.documentId) &&
        timestamp(command.restoredAt);
      break;
    case "remove-document":
      valid =
        only(command, [...base, "documentId", "removedAt"], mutation) &&
        id(command.documentId) &&
        timestamp(command.removedAt);
      break;
    case "set-topic-archived":
      valid =
        only(
          command,
          [...base, "topicId", "archivedAt", "updatedAt"],
          mutation,
        ) &&
        id(command.topicId) &&
        (command.archivedAt === null || timestamp(command.archivedAt)) &&
        timestamp(command.updatedAt);
      break;
    case "trash-topic":
      valid =
        only(command, [...base, "topicId", "trashedAt"], mutation) &&
        id(command.topicId) &&
        timestamp(command.trashedAt);
      break;
    case "restore-topic":
      valid =
        only(command, [...base, "topicId", "restoredAt"], mutation) &&
        id(command.topicId) &&
        timestamp(command.restoredAt);
      break;
    case "remove-topic":
      valid =
        only(command, [...base, "topicId", "removedAt"], mutation) &&
        id(command.topicId) &&
        timestamp(command.removedAt);
      break;
    default:
      invalid();
  }
  if (!valid) invalid();
}
