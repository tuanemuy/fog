import { CredentialId } from "@repo/core/domain/identity/valueObject";
import type { UserDataUnitOfWorkContext } from "../../execution/unitOfWork";
import { CALLER_TOKEN_MIN_LENGTH } from "../callerToken";
import type { CredentialLocatorDto } from "../gateway";
import { toCredentialLocator } from "../rebuild";

export type RecordRemappedLocatorDto = Readonly<{
  /** The value the source mapping row holds; compared against `account.caller_token`. */
  callerToken: string;
  locator: CredentialLocatorDto;
}>;

/** "Recorded" or the one-valued "passed over" — the reason is deliberately not reported. */
export type RecordRemappedLocatorResult = "recorded" | "skipped";

/**
 * s3 of the mapping-key transfer, inside the User Data DO
 * (`spec/rotation/index.md`, `record-remapped-locator`): the reverse-index
 * row of the new generation is written **before** the copy exists, and
 * writing it is also the final judgement of whether the credential may be
 * transferred at all. Three checks, in one transaction with the upsert —
 * (i) the caller binding, constant time, with a `NULL` / empty / short
 * value on either side counting as a mismatch before any comparison;
 * (ii) the account is `active`; (iii) the credential has at least one
 * reverse-index row. Any of the three failing is the same `skipped`:
 * a signup before its record, an SSO link before its record, an unlink
 * after its deletion and a withdrawal all fold into it, and telling them
 * apart would leak the account's state to the caller's log.
 *
 * The upsert is `credentialLocatorStore.record`, the same door the saga
 * uses, so `credentialVersion` is the maximum over every row of the
 * credential and generations never diverge (TC-keyRotation-039).
 */
export function recordRemappedLocatorProcedure(
  ctx: UserDataUnitOfWorkContext,
  sql: SqlStorage,
  dto: RecordRemappedLocatorDto,
): RecordRemappedLocatorResult {
  const bound = sql
    .exec<{ caller_token: string | null; status: string }>(
      "SELECT caller_token, status FROM account LIMIT 1",
    )
    .toArray()[0];
  if (bound === undefined) return "skipped";
  if (
    typeof bound.caller_token !== "string" ||
    bound.caller_token.length < CALLER_TOKEN_MIN_LENGTH ||
    dto.callerToken.length < CALLER_TOKEN_MIN_LENGTH ||
    !constantTimeEqual(bound.caller_token, dto.callerToken)
  ) {
    return "skipped";
  }
  if (bound.status !== "active") return "skipped";
  const credentialId = CredentialId.create(dto.locator.credentialId);
  if (
    ctx.credentialLocatorStore.listByCredentialId(credentialId).length === 0
  ) {
    return "skipped";
  }
  ctx.credentialLocatorStore.record(toCredentialLocator(dto.locator));
  return "recorded";
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
