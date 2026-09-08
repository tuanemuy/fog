/** `jobs.operation_key` of the bucket's one `sweep-reset-tokens` row. */
export const SWEEP_RESET_TOKENS_OPERATION_KEY = "sweep-reset-tokens";
/** `jobs.operation_key` of the User Data DO's one `sweep-orphan-mapping` row. */
export const SWEEP_ORPHAN_MAPPING_OPERATION_KEY = "sweep-orphan-mapping";

export const resumeCredentialChangeOperationKey = (operationId: string) =>
  `resume-credential-change:${operationId}`;
export const resumeLinkOperationKey = (operationId: string) =>
  `resume-link:${operationId}`;
