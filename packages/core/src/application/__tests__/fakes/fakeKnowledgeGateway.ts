import type { KnowledgeGateway } from "../../knowledge/gateway";

const KNOWLEDGE_GATEWAY_METHODS = [
  "createTopic",
  "updateTopic",
  "listTopics",
  "getTopic",
  "getTopicName",
  "trashTopic",
  "createDocument",
  "editDocument",
  "rollbackDocument",
  "trashDocument",
  "getDocument",
  "listDocumentRevisions",
  "diffDocumentRevisions",
  "listDocumentSourceMemos",
  "listDocumentsReferencingMemo",
] as const satisfies readonly (keyof KnowledgeGateway)[];

type Exhaustive<T extends readonly (keyof KnowledgeGateway)[]> =
  Exclude<keyof KnowledgeGateway, T[number]> extends never ? T : never;
const _knowledgeGatewayRoster: Exhaustive<typeof KNOWLEDGE_GATEWAY_METHODS> =
  KNOWLEDGE_GATEWAY_METHODS;
void _knowledgeGatewayRoster;

/** Total `KnowledgeGateway` whose every entry throws through `trip` unless overridden. */
export function trippingKnowledgeGateway(
  trip: (name: keyof KnowledgeGateway) => never,
  overrides: Partial<KnowledgeGateway> = {},
): KnowledgeGateway {
  const gateway = {} as Record<keyof KnowledgeGateway, unknown>;
  for (const name of KNOWLEDGE_GATEWAY_METHODS) {
    gateway[name] = overrides[name] ?? (() => trip(name));
  }
  return gateway as unknown as KnowledgeGateway;
}
