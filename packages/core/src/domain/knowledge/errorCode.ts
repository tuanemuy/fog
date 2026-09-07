export const KnowledgeErrorCode = {
  InvalidTopicId: "INVALID_TOPIC_ID",
  InvalidDocumentId: "INVALID_DOCUMENT_ID",
  InvalidRevisionId: "INVALID_REVISION_ID",
  InvalidRevisionNumber: "INVALID_REVISION_NUMBER",
  EmptyTopicName: "EMPTY_TOPIC_NAME",
  TopicNameMultiline: "TOPIC_NAME_MULTILINE",
  TopicNameTooLong: "TOPIC_NAME_TOO_LONG",
  EmptyTopicDescription: "EMPTY_TOPIC_DESCRIPTION",
  TopicDescriptionTooLong: "TOPIC_DESCRIPTION_TOO_LONG",
  EmptyDocumentTitle: "EMPTY_DOCUMENT_TITLE",
  DocumentTitleMultiline: "DOCUMENT_TITLE_MULTILINE",
  DocumentTitleTooLong: "DOCUMENT_TITLE_TOO_LONG",
  DocumentBodyTooLong: "DOCUMENT_BODY_TOO_LONG",
  EmptyChangeReason: "EMPTY_CHANGE_REASON",
  ChangeReasonMultiline: "CHANGE_REASON_MULTILINE",
  ChangeReasonTooLong: "CHANGE_REASON_TOO_LONG",
  EmptyPatch: "EMPTY_PATCH",
  EmptyPatchOldText: "EMPTY_PATCH_OLD_TEXT",
  PatchTargetNotFound: "PATCH_TARGET_NOT_FOUND",
  PatchTargetAmbiguous: "PATCH_TARGET_AMBIGUOUS",
  RevisionDocumentMismatch: "REVISION_DOCUMENT_MISMATCH",
  TrashedWithMismatch: "TRASHED_WITH_MISMATCH",
} as const;

export type KnowledgeErrorCode =
  (typeof KnowledgeErrorCode)[keyof typeof KnowledgeErrorCode];
