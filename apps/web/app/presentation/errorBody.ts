import {
  httpStatusFor,
  redactForClient,
  type SerializedError,
  serializeError,
} from "./errorResponse";

/** What a bare handler's client sees of a failure: the same three fields everywhere. */
export type ClientErrorBody = Readonly<{
  kind: SerializedError["kind"];
  code: string | null;
  message: string;
}>;

/**
 * The system codes a client may read by name. `redactForClient` blanks a
 * system error's code because most name the layer that broke; these
 * name a state of the user's own data that the user can act on, and the
 * screen has wording for them. The message stays the fixed one.
 */
const PUBLIC_SYSTEM_CODES: ReadonlySet<string> = new Set(["EXPORT_TOO_LARGE"]);

/**
 * A failure as a client reads it. `business` / `notFound` / `conflict` /
 * `validation` carry their code and message; `system` / `unknown` are
 * redacted to the fixed wording, keeping the code only when it is one of
 * the public ones.
 */
export function toClientErrorBody(error: unknown): ClientErrorBody {
  const raw = serializeError(error);
  const serialized = redactForClient(raw);
  const code =
    serialized.kind === "system" &&
    raw.code !== null &&
    PUBLIC_SYSTEM_CODES.has(raw.code)
      ? raw.code
      : serialized.code;
  return { kind: serialized.kind, code, message: serialized.message };
}

export function clientErrorStatus(error: unknown): number {
  return httpStatusFor(serializeError(error));
}
