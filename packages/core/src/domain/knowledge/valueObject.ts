import { codePointLength } from "@repo/core/domain/common/text";
import { BusinessRuleError } from "@repo/core/domain/error";
import { KnowledgeErrorCode } from "./errorCode";

declare const topicIdBrand: unique symbol;
declare const documentIdBrand: unique symbol;
declare const documentRevisionIdBrand: unique symbol;
declare const topicNameBrand: unique symbol;
declare const topicDescriptionBrand: unique symbol;
declare const revisionNumberBrand: unique symbol;
declare const documentTitleBrand: unique symbol;
declare const documentBodyBrand: unique symbol;
declare const changeReasonBrand: unique symbol;
declare const documentPatchBrand: unique symbol;

function fail(code: KnowledgeErrorCode, message: string): never {
  throw new BusinessRuleError<KnowledgeErrorCode>(code, message);
}

function nonEmptyId<T>(raw: string, code: KnowledgeErrorCode): T {
  const trimmed = raw.trim();
  if (trimmed.length === 0) fail(code, "Invalid id");
  return trimmed as T;
}

function singleLine<T>(
  raw: string,
  label: string,
  max: number,
  codes: {
    empty: KnowledgeErrorCode;
    multiline: KnowledgeErrorCode;
    tooLong: KnowledgeErrorCode;
  },
): T {
  const trimmed = raw.trim();
  if (trimmed.length === 0) fail(codes.empty, `${label} must not be empty`);
  if (/[\r\n]/.test(trimmed)) {
    fail(codes.multiline, `${label} must be a single line`);
  }
  if (codePointLength(trimmed) > max) {
    fail(codes.tooLong, `${label} must be at most ${max} characters`);
  }
  return trimmed as T;
}

export type TopicId = string & { readonly [topicIdBrand]: true };
export const TopicId = {
  create: (raw: string): TopicId =>
    nonEmptyId<TopicId>(raw, KnowledgeErrorCode.InvalidTopicId),
};

export type DocumentId = string & { readonly [documentIdBrand]: true };
export const DocumentId = {
  create: (raw: string): DocumentId =>
    nonEmptyId<DocumentId>(raw, KnowledgeErrorCode.InvalidDocumentId),
};

export type DocumentRevisionId = string & {
  readonly [documentRevisionIdBrand]: true;
};
export const DocumentRevisionId = {
  create: (raw: string): DocumentRevisionId =>
    nonEmptyId<DocumentRevisionId>(raw, KnowledgeErrorCode.InvalidRevisionId),
};

export const TOPIC_NAME_MAX_CODE_POINTS = 100;
export type TopicName = string & { readonly [topicNameBrand]: true };
export const TopicName = {
  create: (raw: string): TopicName =>
    singleLine<TopicName>(raw, "Topic name", TOPIC_NAME_MAX_CODE_POINTS, {
      empty: KnowledgeErrorCode.EmptyTopicName,
      multiline: KnowledgeErrorCode.TopicNameMultiline,
      tooLong: KnowledgeErrorCode.TopicNameTooLong,
    }),
};

export const TOPIC_DESCRIPTION_MAX_CODE_POINTS = 500;
/** Absence is the entity's `null`, never an empty value here. */
export type TopicDescription = string & {
  readonly [topicDescriptionBrand]: true;
};
export const TopicDescription = {
  create: (raw: string): TopicDescription => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      fail(
        KnowledgeErrorCode.EmptyTopicDescription,
        "Topic description must not be empty",
      );
    }
    if (codePointLength(trimmed) > TOPIC_DESCRIPTION_MAX_CODE_POINTS) {
      fail(
        KnowledgeErrorCode.TopicDescriptionTooLong,
        `Topic description must be at most ${TOPIC_DESCRIPTION_MAX_CODE_POINTS} characters`,
      );
    }
    return trimmed as TopicDescription;
  },
};

/** Knowledge's own; deliberately not the memo domain's `RevisionNumber`. */
export type RevisionNumber = number & { readonly [revisionNumberBrand]: true };
export const RevisionNumber = {
  create: (raw: number): RevisionNumber => {
    if (!Number.isInteger(raw) || raw < 1) {
      fail(
        KnowledgeErrorCode.InvalidRevisionNumber,
        `Invalid revision number: ${raw}`,
      );
    }
    return raw as RevisionNumber;
  },
  first: (): RevisionNumber => 1 as RevisionNumber,
  next: (n: RevisionNumber): RevisionNumber =>
    ((n as number) + 1) as RevisionNumber,
};

export const DOCUMENT_TITLE_MAX_CODE_POINTS = 200;
export type DocumentTitle = string & { readonly [documentTitleBrand]: true };
export const DocumentTitle = {
  create: (raw: string): DocumentTitle =>
    singleLine<DocumentTitle>(
      raw,
      "Document title",
      DOCUMENT_TITLE_MAX_CODE_POINTS,
      {
        empty: KnowledgeErrorCode.EmptyDocumentTitle,
        multiline: KnowledgeErrorCode.DocumentTitleMultiline,
        tooLong: KnowledgeErrorCode.DocumentTitleTooLong,
      },
    ),
};

/**
 * Derived from the Durable Object's 2 MB row budget against the
 * `document_revisions` row; `spec/database/index.md` holds the arithmetic.
 */
export const DOCUMENT_BODY_MAX_CODE_POINTS = 400_000;

/** Structured text the domain never parses; empty is a legitimate draft. */
export type DocumentBody = string & { readonly [documentBodyBrand]: true };
export const DocumentBody = {
  create: (raw: string): DocumentBody => {
    if (codePointLength(raw) > DOCUMENT_BODY_MAX_CODE_POINTS) {
      fail(
        KnowledgeErrorCode.DocumentBodyTooLong,
        `Document body must be at most ${DOCUMENT_BODY_MAX_CODE_POINTS} characters`,
      );
    }
    return raw as DocumentBody;
  },
  equals: (a: DocumentBody, b: DocumentBody): boolean => a === b,
};

export const CHANGE_REASON_MAX_CODE_POINTS = 200;
export type ChangeReason = string & { readonly [changeReasonBrand]: true };
export const ChangeReason = {
  create: (raw: string): ChangeReason =>
    singleLine<ChangeReason>(
      raw,
      "Change reason",
      CHANGE_REASON_MAX_CODE_POINTS,
      {
        empty: KnowledgeErrorCode.EmptyChangeReason,
        multiline: KnowledgeErrorCode.ChangeReasonMultiline,
        tooLong: KnowledgeErrorCode.ChangeReasonTooLong,
      },
    ),
};

export type PatchHunk = Readonly<{ oldText: string; newText: string }>;
export type DocumentPatch = Readonly<{ hunks: readonly PatchHunk[] }> & {
  readonly [documentPatchBrand]: true;
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * The AI edit's replacement list. Hunks apply in order, each against the body
 * the previous ones produced, and each `oldText` must match exactly once;
 * any failure leaves the document untouched.
 */
export const DocumentPatch = {
  create: (
    hunks: readonly { oldText: string; newText: string }[],
  ): DocumentPatch => {
    if (hunks.length === 0) {
      fail(KnowledgeErrorCode.EmptyPatch, "A patch needs at least one hunk");
    }
    for (const hunk of hunks) {
      if (hunk.oldText.length === 0) {
        fail(
          KnowledgeErrorCode.EmptyPatchOldText,
          "A hunk's oldText must not be empty",
        );
      }
    }
    return {
      hunks: hunks.map((hunk) => ({
        oldText: hunk.oldText,
        newText: hunk.newText,
      })),
    } as unknown as DocumentPatch;
  },

  apply: (body: DocumentBody, patch: DocumentPatch): DocumentBody => {
    let current: string = body;
    for (const hunk of patch.hunks) {
      const occurrences = countOccurrences(current, hunk.oldText);
      if (occurrences === 0) {
        fail(
          KnowledgeErrorCode.PatchTargetNotFound,
          "The patch target was not found in the document",
        );
      }
      if (occurrences > 1) {
        fail(
          KnowledgeErrorCode.PatchTargetAmbiguous,
          "The patch target matches more than one place",
        );
      }
      current = current.replace(hunk.oldText, () => hunk.newText);
    }
    return DocumentBody.create(current);
  },
};
