import type { Needs, UsecaseContainer } from "../types";

/**
 * What the AI tools may reach: the three gateways their usecases declare
 * through `Needs<…>`, and nothing else on the container — the identity,
 * trash, session and secret-bearing members are not here, so a tool
 * cannot drift into them without widening this type. The projection
 * lives outside `presentation/ai/` so that no source there names a
 * gateway at all (its allow-list test holds that).
 */
export type AiToolContainer = Needs<
  "memoGateway" | "knowledgeGateway" | "searchGateway"
>;

export function toAiToolContainer(
  container: UsecaseContainer,
): AiToolContainer {
  return {
    memoGateway: container.memoGateway,
    knowledgeGateway: container.knowledgeGateway,
    searchGateway: container.searchGateway,
  };
}
