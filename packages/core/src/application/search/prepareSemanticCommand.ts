import { ValidationError } from "@repo/core/application/errors";
import { BusinessRuleError } from "@repo/core/domain/error";
import type {
  PreparedSemanticCommand,
  SemanticActor,
  SemanticRpcCommand,
} from "./contracts";

const MAX_TOPIC_NAME_CODE_POINTS = 100;
const MAX_DOCUMENT_BODY_CODE_POINTS = 1_000_000;
const MAX_CHANGE_REASON_CODE_POINTS = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
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

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function isTimestamp(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= 8_640_000_000_000_000
  );
}

function isExpectedVersion(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isActor(value: unknown): value is SemanticActor {
  if (!isRecord(value) || !isId(value.id)) return false;
  if (value.kind === "user") {
    return hasOnlyKeys(value, ["kind", "id"]);
  }
  return (
    value.kind === "aiClient" &&
    hasOnlyKeys(value, ["kind", "id", "clientName"]) &&
    typeof value.clientName === "string" &&
    value.clientName.trim().length > 0 &&
    [...value.clientName].length <= 200
  );
}

function isMemo(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["id", "body", "timestamp"]) &&
    isId(value.id) &&
    typeof value.body === "string" &&
    isTimestamp(value.timestamp)
  );
}

function assertDocument(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "id",
      "title",
      "body",
      "timestamp",
      "topicId",
      "sourceMemoIds",
    ]) ||
    !isId(value.id) ||
    typeof value.title !== "string" ||
    typeof value.body !== "string" ||
    !isTimestamp(value.timestamp) ||
    !isId(value.topicId) ||
    !Array.isArray(value.sourceMemoIds) ||
    !value.sourceMemoIds.every(isId)
  ) {
    return false;
  }
  if ([...value.body].length > MAX_DOCUMENT_BODY_CODE_POINTS) {
    throw new BusinessRuleError(
      "DOCUMENT_BODY_TOO_LONG",
      `Document body may have at most ${MAX_DOCUMENT_BODY_CODE_POINTS} characters`,
    );
  }
  return true;
}

function assertTopic(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["id", "name", "timestamp"], ["sourceMemoId"]) ||
    !isId(value.id) ||
    typeof value.name !== "string" ||
    !isTimestamp(value.timestamp) ||
    (value.sourceMemoId !== undefined && !isId(value.sourceMemoId))
  ) {
    return false;
  }
  if (value.name.trim().length === 0) {
    throw new BusinessRuleError(
      "EMPTY_TOPIC_NAME",
      "Topic name must not be empty",
    );
  }
  if (/[\r\n]/u.test(value.name)) {
    throw new BusinessRuleError(
      "TOPIC_NAME_MULTILINE",
      "Topic name must be a single line",
    );
  }
  if ([...value.name].length > MAX_TOPIC_NAME_CODE_POINTS) {
    throw new BusinessRuleError(
      "TOPIC_NAME_TOO_LONG",
      `Topic name may have at most ${MAX_TOPIC_NAME_CODE_POINTS} characters`,
    );
  }
  return true;
}

function assertChangeReason(value: unknown, required: boolean): void {
  if (value === undefined && !required) return;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BusinessRuleError(
      "EMPTY_CHANGE_REASON",
      "Change reason must not be empty",
    );
  }
  if (/[\r\n]/u.test(value)) {
    throw new BusinessRuleError(
      "CHANGE_REASON_MULTILINE",
      "Change reason must be a single line",
    );
  }
  if ([...value].length > MAX_CHANGE_REASON_CODE_POINTS) {
    throw new BusinessRuleError(
      "CHANGE_REASON_TOO_LONG",
      `Change reason may have at most ${MAX_CHANGE_REASON_CODE_POINTS} characters`,
    );
  }
}

export function prepareSemanticCommand(
  command: unknown,
  completedAt: number,
): PreparedSemanticCommand {
  const invalid = (): never => {
    throw new ValidationError(
      "SEMANTIC_COMMAND_INVALID",
      "Semantic command is invalid",
    );
  };
  if (
    !isRecord(command) ||
    command.version !== 1 ||
    !isId(command.operationId) ||
    typeof command.type !== "string" ||
    (command.actor !== undefined && !isActor(command.actor)) ||
    !isTimestamp(completedAt)
  ) {
    return invalid();
  }
  const base = ["version", "operationId", "type"] as const;
  const actor = command.actor ?? ({ kind: "user", id: "local-user" } as const);
  const expected = (): boolean => isExpectedVersion(command.expectedVersion);
  let valid = false;
  switch (command.type) {
    case "create-memo":
      valid =
        hasOnlyKeys(command, [...base, "memo"], ["actor"]) &&
        isMemo(command.memo);
      break;
    case "update-memo":
      assertChangeReason(command.changeReason, false);
      valid =
        hasOnlyKeys(
          command,
          [...base, "memo", "expectedVersion"],
          ["actor", "changeReason"],
        ) &&
        expected() &&
        isMemo(command.memo);
      break;
    case "create-document":
      valid =
        hasOnlyKeys(command, [...base, "document"], ["actor"]) &&
        assertDocument(command.document);
      break;
    case "update-document":
      assertChangeReason(command.changeReason, true);
      valid =
        hasOnlyKeys(
          command,
          [...base, "document", "changeReason", "expectedVersion"],
          ["actor"],
        ) &&
        expected() &&
        assertDocument(command.document);
      break;
    case "create-topic":
      valid =
        hasOnlyKeys(command, [...base, "topic"], ["actor"]) &&
        assertTopic(command.topic);
      break;
    case "trash-memo":
    case "trash-document":
    case "trash-topic": {
      const idKey =
        command.type === "trash-memo"
          ? "memoId"
          : command.type === "trash-document"
            ? "documentId"
            : "topicId";
      valid =
        hasOnlyKeys(
          command,
          [...base, idKey, "trashedAt", "expectedVersion"],
          ["actor"],
        ) &&
        isId(command[idKey]) &&
        isTimestamp(command.trashedAt) &&
        expected();
      break;
    }
    case "restore-memo":
    case "restore-topic": {
      const idKey = command.type === "restore-memo" ? "memoId" : "topicId";
      valid =
        hasOnlyKeys(
          command,
          [...base, idKey, "restoredAt", "expectedVersion"],
          ["actor"],
        ) &&
        isId(command[idKey]) &&
        isTimestamp(command.restoredAt) &&
        expected();
      break;
    }
    case "restore-document":
      valid =
        hasOnlyKeys(
          command,
          [...base, "documentId", "restoredAt", "expectedVersion"],
          ["actor", "destinationTopicId"],
        ) &&
        isId(command.documentId) &&
        isTimestamp(command.restoredAt) &&
        expected() &&
        (command.destinationTopicId === undefined ||
          isId(command.destinationTopicId));
      break;
    case "remove-memo":
    case "remove-document":
    case "remove-topic": {
      const idKey =
        command.type === "remove-memo"
          ? "memoId"
          : command.type === "remove-document"
            ? "documentId"
            : "topicId";
      valid =
        hasOnlyKeys(
          command,
          [...base, idKey, "removedAt", "expectedVersion"],
          ["actor"],
        ) &&
        isId(command[idKey]) &&
        isTimestamp(command.removedAt) &&
        expected();
      break;
    }
    case "set-topic-archived":
      valid =
        hasOnlyKeys(
          command,
          [...base, "topicId", "archivedAt", "updatedAt", "expectedVersion"],
          ["actor"],
        ) &&
        isId(command.topicId) &&
        (command.archivedAt === null || isTimestamp(command.archivedAt)) &&
        isTimestamp(command.updatedAt) &&
        expected();
      break;
    default:
      invalid();
  }
  if (!valid) invalid();
  const {
    version: _version,
    actor: _actor,
    ...payload
  } = command as SemanticRpcCommand;
  return {
    ...payload,
    actor,
    completedAt,
  } as PreparedSemanticCommand;
}

export { MAX_DOCUMENT_BODY_CODE_POINTS };
