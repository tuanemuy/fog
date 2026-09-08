import {
  type ClientErrorBody,
  clientErrorStatus,
  toClientErrorBody,
} from "@/presentation/errorBody";
import type { SerializedError } from "@/presentation/errorResponse";

/** What the client sees of a failure: the same three fields on MCP and REST. */
export type AiErrorBody = ClientErrorBody;

/**
 * A usecase failure as the AI client reads it — the bare handlers' common
 * shape: business / notFound / conflict / validation with their code and
 * message, system / unknown redacted to the fixed wording.
 */
export function toAiErrorBody(error: unknown): AiErrorBody {
  return toClientErrorBody(error);
}

export function aiErrorStatus(error: unknown): number {
  return clientErrorStatus(error);
}

/** The failures a tool reports as its own result rather than as a protocol error. */
export function isToolLevelFailure(kind: SerializedError["kind"]): boolean {
  return (
    kind === "business" ||
    kind === "notFound" ||
    kind === "conflict" ||
    kind === "validation"
  );
}
