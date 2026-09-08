import { isConflictError } from "@repo/core/application/errors";

/**
 * The two ways forward progress is confirmed impossible
 * (`spec/recovery/index.md` 前提 2): a `ConflictError` on the wake-up it
 * happens, or the backoff ceiling.
 */
export const FORWARD_TOKENS = [
  "forward-conflict",
  "forward-exhausted",
] as const;
export type ForwardToken = (typeof FORWARD_TOKENS)[number];

/**
 * The whole vocabulary of `jobs.terminal_reason` (design D-16 △-1): six
 * values, a forward reason optionally crowned by how the cleanup ended.
 * Nothing else is ever written into the column — the failing error's
 * code goes to the log, not here.
 */
export const TERMINAL_REASON_TOKENS = [
  ...FORWARD_TOKENS,
  "cleanup-exhausted:forward-conflict",
  "cleanup-exhausted:forward-exhausted",
  "cleanup-material-lost:forward-conflict",
  "cleanup-material-lost:forward-exhausted",
] as const;
export type TerminalReasonToken = (typeof TERMINAL_REASON_TOKENS)[number];

export type CleanupEnding = "cleanup-exhausted" | "cleanup-material-lost";

const TOKEN_SET: ReadonlySet<string> = new Set(TERMINAL_REASON_TOKENS);

/** `"<token>"` or `"<token> <operationId>"`; the separator is one space. */
export function terminalReason(
  token: TerminalReasonToken,
  operationId: string | null,
): string {
  return operationId === null ? token : `${token} ${operationId}`;
}

export function parseTerminalReason(
  value: string | null,
): { token: TerminalReasonToken; operationId: string | null } | null {
  if (value === null) return null;
  const [token, ...rest] = value.split(" ");
  if (token === undefined || !TOKEN_SET.has(token)) return null;
  const operationId = rest.join(" ");
  return {
    token: token as TerminalReasonToken,
    operationId: operationId.length === 0 ? null : operationId,
  };
}

/**
 * The forward reason a value carries, crown stripped. A crown is only
 * ever put on a *forward* token, so re-crowning a value that already
 * ended once keeps the vocabulary at six (RC-9). A value this module
 * did not write reads as `forward-exhausted`.
 */
export function forwardTokenOf(value: string | null): ForwardToken {
  const parsed = parseTerminalReason(value);
  if (parsed === null) return "forward-exhausted";
  const token = parsed.token;
  if (token === "forward-conflict" || token === "forward-exhausted")
    return token;
  return token.endsWith("forward-conflict")
    ? "forward-conflict"
    : "forward-exhausted";
}

export function crownedToken(
  ending: CleanupEnding,
  forward: ForwardToken,
): TerminalReasonToken {
  return `${ending}:${forward}`;
}

/** The forward reason a thrown value stands for. */
export function forwardTokenFor(error: unknown): ForwardToken {
  return isConflictError(error) ? "forward-conflict" : "forward-exhausted";
}

/** The saga's `operationId` when the payload names one; the sweeps and bulk jobs do not. */
export function operationIdOf(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const id = (payload as { operationId?: unknown }).operationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}
