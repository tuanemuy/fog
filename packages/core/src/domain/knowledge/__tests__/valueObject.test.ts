import { isBusinessRuleError } from "@repo/core/domain/error";
import { describe, expect, it } from "vitest";
import { KnowledgeErrorCode } from "../errorCode";
import {
  CHANGE_REASON_MAX_CODE_POINTS,
  ChangeReason,
  DOCUMENT_BODY_MAX_CODE_POINTS,
  DOCUMENT_TITLE_MAX_CODE_POINTS,
  DocumentBody,
  DocumentPatch,
  DocumentTitle,
  RevisionNumber,
  TOPIC_DESCRIPTION_MAX_CODE_POINTS,
  TOPIC_NAME_MAX_CODE_POINTS,
  TopicDescription,
  TopicName,
} from "../valueObject";

function businessCodeOf(fn: () => unknown): string | null {
  try {
    fn();
  } catch (error) {
    if (isBusinessRuleError(error)) return error.code;
    throw error;
  }
  return null;
}

describe.each([
  {
    label: "TopicName",
    create: TopicName.create,
    max: TOPIC_NAME_MAX_CODE_POINTS,
    empty: KnowledgeErrorCode.EmptyTopicName,
    multiline: KnowledgeErrorCode.TopicNameMultiline,
    tooLong: KnowledgeErrorCode.TopicNameTooLong,
  },
  {
    label: "DocumentTitle",
    create: DocumentTitle.create,
    max: DOCUMENT_TITLE_MAX_CODE_POINTS,
    empty: KnowledgeErrorCode.EmptyDocumentTitle,
    multiline: KnowledgeErrorCode.DocumentTitleMultiline,
    tooLong: KnowledgeErrorCode.DocumentTitleTooLong,
  },
  {
    label: "ChangeReason",
    create: ChangeReason.create,
    max: CHANGE_REASON_MAX_CODE_POINTS,
    empty: KnowledgeErrorCode.EmptyChangeReason,
    multiline: KnowledgeErrorCode.ChangeReasonMultiline,
    tooLong: KnowledgeErrorCode.ChangeReasonTooLong,
  },
])("$label", ({ create, max, empty, multiline, tooLong }) => {
  it("trims", () => {
    expect(create("  title  ")).toBe("title");
  });

  it("rejects an empty value", () => {
    expect(businessCodeOf(() => create("   "))).toBe(empty);
  });

  it.each(["a\nb", "a\rb"])("rejects a multiline value %j", (raw) => {
    expect(businessCodeOf(() => create(raw))).toBe(multiline);
  });

  it("accepts the maximum and rejects one code point more", () => {
    const atMax = "あ".repeat(max);
    expect(create(atMax)).toBe(atMax);
    expect(businessCodeOf(() => create("あ".repeat(max + 1)))).toBe(tooLong);
  });
});

describe("TopicDescription", () => {
  it("rejects an empty value", () => {
    expect(businessCodeOf(() => TopicDescription.create(" "))).toBe(
      KnowledgeErrorCode.EmptyTopicDescription,
    );
  });

  it("allows multiple lines", () => {
    expect(TopicDescription.create("line 1\nline 2")).toBe("line 1\nline 2");
  });

  it("accepts the maximum and rejects one code point more", () => {
    const atMax = "あ".repeat(TOPIC_DESCRIPTION_MAX_CODE_POINTS);
    expect(TopicDescription.create(atMax)).toBe(atMax);
    expect(
      businessCodeOf(() =>
        TopicDescription.create(
          "あ".repeat(TOPIC_DESCRIPTION_MAX_CODE_POINTS + 1),
        ),
      ),
    ).toBe(KnowledgeErrorCode.TopicDescriptionTooLong);
  });
});

describe("DocumentBody", () => {
  it("allows an empty draft", () => {
    expect(DocumentBody.create("")).toBe("");
  });

  it("keeps whitespace as typed", () => {
    expect(DocumentBody.create("  # heading\n")).toBe("  # heading\n");
  });

  it("accepts the maximum and rejects one code point more", () => {
    const atMax = "a".repeat(DOCUMENT_BODY_MAX_CODE_POINTS);
    expect(DocumentBody.create(atMax)).toBe(atMax);
    expect(
      businessCodeOf(() =>
        DocumentBody.create("a".repeat(DOCUMENT_BODY_MAX_CODE_POINTS + 1)),
      ),
    ).toBe(KnowledgeErrorCode.DocumentBodyTooLong);
  });
});

describe("RevisionNumber", () => {
  it("rejects 0 and non-integers", () => {
    expect(businessCodeOf(() => RevisionNumber.create(0))).toBe(
      KnowledgeErrorCode.InvalidRevisionNumber,
    );
    expect(businessCodeOf(() => RevisionNumber.create(1.5))).toBe(
      KnowledgeErrorCode.InvalidRevisionNumber,
    );
  });

  it("starts at 1", () => {
    expect(RevisionNumber.next(RevisionNumber.first())).toBe(2);
  });
});

describe("DocumentPatch.create", () => {
  it("rejects an empty hunk list", () => {
    expect(businessCodeOf(() => DocumentPatch.create([]))).toBe(
      KnowledgeErrorCode.EmptyPatch,
    );
  });

  it("rejects a hunk whose oldText is empty", () => {
    expect(
      businessCodeOf(() =>
        DocumentPatch.create([
          { oldText: "a", newText: "b" },
          { oldText: "", newText: "c" },
        ]),
      ),
    ).toBe(KnowledgeErrorCode.EmptyPatchOldText);
  });

  it("allows an empty newText (a deletion)", () => {
    const patch = DocumentPatch.create([{ oldText: "a", newText: "" }]);
    expect(patch.hunks).toEqual([{ oldText: "a", newText: "" }]);
  });
});

describe("DocumentPatch.apply", () => {
  it("applies hunks in order, each against the previous result", () => {
    const body = DocumentBody.create("alpha beta gamma");
    const patch = DocumentPatch.create([
      { oldText: "alpha", newText: "one" },
      { oldText: "one beta", newText: "two" },
    ]);

    expect(DocumentPatch.apply(body, patch)).toBe("two gamma");
  });

  it("treats replacement patterns in newText literally", () => {
    const body = DocumentBody.create("price: X");
    const patch = DocumentPatch.create([{ oldText: "X", newText: "$&$1" }]);

    expect(DocumentPatch.apply(body, patch)).toBe("price: $&$1");
  });

  it("rejects a hunk whose target is absent", () => {
    const body = DocumentBody.create("alpha");
    const patch = DocumentPatch.create([{ oldText: "beta", newText: "x" }]);

    expect(businessCodeOf(() => DocumentPatch.apply(body, patch))).toBe(
      KnowledgeErrorCode.PatchTargetNotFound,
    );
  });

  it("rejects a hunk whose target matches more than once", () => {
    const body = DocumentBody.create("alpha alpha");
    const patch = DocumentPatch.create([{ oldText: "alpha", newText: "x" }]);

    expect(businessCodeOf(() => DocumentPatch.apply(body, patch))).toBe(
      KnowledgeErrorCode.PatchTargetAmbiguous,
    );
  });

  // A later hunk failing must not surface the earlier hunks' work: the call
  // throws instead of returning, and the input body is untouched.
  it("never leaks a partially applied body", () => {
    const body = DocumentBody.create("alpha beta");
    const patch = DocumentPatch.create([
      { oldText: "alpha", newText: "one" },
      { oldText: "missing", newText: "x" },
    ]);

    expect(businessCodeOf(() => DocumentPatch.apply(body, patch))).toBe(
      KnowledgeErrorCode.PatchTargetNotFound,
    );
    expect(body).toBe("alpha beta");
  });

  it("re-validates the resulting body against the size bound", () => {
    const body = DocumentBody.create("a");
    const patch = DocumentPatch.create([
      { oldText: "a", newText: "b".repeat(DOCUMENT_BODY_MAX_CODE_POINTS + 1) },
    ]);

    expect(businessCodeOf(() => DocumentPatch.apply(body, patch))).toBe(
      KnowledgeErrorCode.DocumentBodyTooLong,
    );
  });
});
