import {
  httpStatusFor,
  redactForClient,
  type SerializedError,
  serializeError,
} from "@/presentation/errorResponse";

/** What the client sees of a failure: the same three fields on MCP and REST. */
export type AiErrorBody = Readonly<{
  kind: SerializedError["kind"];
  code: string | null;
  message: string;
}>;

/**
 * A usecase failure as the AI client reads it. `business` / `notFound` /
 * `conflict` / `validation` carry their code and message (the client is
 * expected to act on them — retry after `get`, widen a patch, …);
 * `system` / `unknown` are redacted to the fixed wording, as everywhere.
 */
export function toAiErrorBody(error: unknown): AiErrorBody {
  const serialized = redactForClient(serializeError(error));
  return {
    kind: serialized.kind,
    code: serialized.code,
    message: serialized.message,
  };
}

export function aiErrorStatus(error: unknown): number {
  return httpStatusFor(serializeError(error));
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
