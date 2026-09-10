/** `jobs.operation_key` of the bucket's one `sweep-reset-tokens` row. */
export const SWEEP_RESET_TOKENS_OPERATION_KEY = "sweep-reset-tokens";
/** `jobs.operation_key` of the User Data DO's one `sweep-orphan-mapping` row. */
export const SWEEP_ORPHAN_MAPPING_OPERATION_KEY = "sweep-orphan-mapping";
/** `jobs.operation_key` of the User Data DO's one `finalize-withdrawal` row; both entry points converge on it. */
export const FINALIZE_WITHDRAWAL_OPERATION_KEY = "finalize-withdrawal";
/** `jobs.operation_key` of a bucket's one `rotate-encryption` row; the operator start is its only entry point. */
export const ROTATE_ENCRYPTION_OPERATION_KEY = "rotate-encryption";
/** `operations.operation_id` of the User Data DO's one withdrawal record, written by `finalize-withdrawal` on its first run. */
export const WITHDRAWAL_OPERATION_ID = "withdrawal";

export const resumeCredentialChangeOperationKey = (operationId: string) =>
  `resume-credential-change:${operationId}`;
export const resumeLinkOperationKey = (operationId: string) =>
  `resume-link:${operationId}`;
