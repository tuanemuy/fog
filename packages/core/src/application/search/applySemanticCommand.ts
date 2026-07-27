import type {
  PreparedSemanticCommand,
  SearchProjectionMutation,
  SearchProjectionPort,
  SemanticTransactionRepositories,
} from "./contracts";

function applyProjectionMutations(
  projection: SearchProjectionPort,
  mutations: readonly SearchProjectionMutation[],
): void {
  for (const mutation of mutations) {
    if (mutation.type === "upsert") {
      projection.upsert(mutation.entry);
    } else {
      projection.remove(mutation.entityType, mutation.id);
    }
  }
}

export function applySemanticCommand(
  command: PreparedSemanticCommand,
  repositories: SemanticTransactionRepositories,
  projection: SearchProjectionPort,
): undefined {
  let mutations: readonly SearchProjectionMutation[];
  switch (command.type) {
    case "create-memo":
      mutations = repositories.content.createMemo(command);
      break;
    case "update-memo":
      mutations = repositories.content.updateMemo(command);
      break;
    case "trash-memo":
      mutations = repositories.content.trashMemo(command);
      break;
    case "restore-memo":
      mutations = repositories.content.restoreMemo(command);
      break;
    case "remove-memo":
      mutations = repositories.content.removeMemo(command);
      break;
    case "create-document":
      mutations = repositories.content.createDocument(command);
      break;
    case "update-document":
      mutations = repositories.content.updateDocument(command);
      break;
    case "trash-document":
      mutations = repositories.content.trashDocument(command);
      break;
    case "restore-document":
      mutations = repositories.content.restoreDocument(command);
      break;
    case "remove-document":
      mutations = repositories.content.removeDocument(command);
      break;
    case "create-topic":
      mutations = repositories.topics.createTopic(command);
      break;
    case "set-topic-archived":
      mutations = repositories.topics.setArchived(command);
      break;
    case "trash-topic":
      mutations = repositories.topics.trashTopic(command);
      break;
    case "restore-topic":
      mutations = repositories.topics.restoreTopic(command);
      break;
    case "remove-topic":
      mutations = repositories.topics.removeTopic(command);
      break;
  }
  applyProjectionMutations(projection, mutations);
  return undefined;
}
