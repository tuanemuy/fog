import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AI_GUIDANCE, TOOL_DESCRIPTIONS } from "../guidance";
import { AI_TOOL_NAMES, AI_TOOLS, toolInputJsonSchema } from "../tools";

const aiDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The eleven tools of `spec/usecases/*.md`, in the spec's order. */
const SPEC_TOOLS = [
  "search",
  "get",
  "list_topics",
  "recent_memos",
  "post_memo",
  "update_memo",
  "create_topic",
  "update_topic",
  "create_document",
  "edit_document",
  "delete",
];

/** The only usecase modules the AI presentation may import (PH-07 §2.1). */
const ALLOWED_USECASE_MODULES = new Set([
  "@repo/core/application/search/search",
  "@repo/core/application/memo/getMemo",
  "@repo/core/application/memo/recentMemos",
  "@repo/core/application/memo/postMemoByAi",
  "@repo/core/application/memo/updateMemoByAi",
  "@repo/core/application/memo/deleteMemoByAi",
  "@repo/core/application/knowledge/getDocument",
  "@repo/core/application/knowledge/listTopics",
  "@repo/core/application/knowledge/createTopic",
  "@repo/core/application/knowledge/updateTopic",
  "@repo/core/application/knowledge/createDocument",
  "@repo/core/application/knowledge/editDocumentByAi",
  "@repo/core/application/knowledge/trashDocument",
  "@repo/core/application/knowledge/trashTopic",
  "@repo/core/application/identity/authorizeAiClient",
  "@repo/core/application/identity/consumeAuthorizationCode",
  "@repo/core/application/identity/actorDto",
]);

/** Names that must never appear in an AI-side import, whatever the module. */
const FORBIDDEN_FRAGMENTS = [
  "application/trash/",
  "Revision",
  "rollback",
  "IncludingTrashed",
  "getTimeline",
  "jumpToDate",
  "showMemoInTimeline",
  "getTopic",
  "listDocumentSourceMemos",
  "listDocumentsReferencingMemo",
  "editMemo",
  'knowledge/editDocument"',
  "softDeleteMemo",
  "hardDelete",
  "emptyTrash",
  "application/export/",
  "exportAllData",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "__tests__" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1] ?? "");
}

describe("the AI tool registry", () => {
  it("is exactly the eleven tools of the spec, in order", () => {
    expect([...AI_TOOL_NAMES]).toEqual(SPEC_TOOLS);
    expect(Object.keys(AI_TOOLS)).toEqual(SPEC_TOOLS);
    for (const name of AI_TOOL_NAMES) {
      expect(AI_TOOLS[name].name).toBe(name);
      expect(AI_TOOLS[name].description).toBe(TOOL_DESCRIPTIONS[name]);
      expect(AI_TOOLS[name].description.length).toBeGreaterThan(20);
    }
  });

  it("publishes a JSON Schema per tool, and marks only delete as destructive", () => {
    for (const name of AI_TOOL_NAMES) {
      const schema = toolInputJsonSchema(name);
      expect(schema.type).toBe("object");
      expect(AI_TOOLS[name].annotations.destructiveHint).toBe(
        name === "delete",
      );
    }
    expect(toolInputJsonSchema("get")).toMatchObject({
      required: ["type", "id"],
    });
    expect(toolInputJsonSchema("edit_document")).toMatchObject({
      required: ["id", "changeReason"],
    });
  });

  // R-AI-02: the guidance names every operation and the recommended
  // behaviour requirements 4.5 asks for.
  it("the guidance covers the operations and the recommended behaviour", () => {
    for (const name of AI_TOOL_NAMES) expect(AI_GUIDANCE).toContain(name);
    for (const phrase of [
      "ドキュメントにまとめることを提案",
      "list_topics で確認して選ぶ",
      "update_memo は全文置換",
      "replaceAll",
      "明示的に全面書き直し",
      "changeReason",
      "完全な削除",
      "履歴の閲覧・ロールバック",
    ]) {
      expect(AI_GUIDANCE).toContain(phrase);
    }
    expect(TOOL_DESCRIPTIONS.edit_document).toContain("replaceAll");
    expect(TOOL_DESCRIPTIONS.update_memo).toContain("全文");
    expect(TOOL_DESCRIPTIONS.delete).toContain("完全な削除は存在しない");
  });
});

// The wiring layer of the allow-list (`spec/domains/identity.md` TokenScope):
// nothing under `presentation/ai/` imports a usecase outside the eleven
// tools' own, and nothing that names trash, history, rollback, timeline
// browsing or a human-only edit. `search` is shared with the human face
// by the spec; it is the one both-faces read here.
describe("what the AI presentation can reach", () => {
  // O-3: a tool holds `AiToolContainer` (three gateways) and only hands it
  // to a usecase; no source under `presentation/ai/` names a gateway
  // member or a gateway type, so nothing calls one around the usecases.
  it("never touches a gateway directly", () => {
    for (const file of sourceFiles(aiDir)) {
      const source = readFileSync(file, "utf8");
      expect(
        /\.\w*Gateway\b/.test(source),
        `${file} reaches a gateway member`,
      ).toBe(false);
      expect(
        /\b\w+Gateway\b(?!:)/.test(source.replace(/^\s*\/\/.*$/gm, "")),
        `${file} names a gateway type`,
      ).toBe(false);
    }
  });

  it("imports only the allowed usecase modules", () => {
    for (const file of sourceFiles(aiDir)) {
      for (const spec of importsOf(readFileSync(file, "utf8"))) {
        if (spec.startsWith("@repo/core/application/")) {
          const isUsecase =
            /^@repo\/core\/application\/(memo|knowledge|search|trash|identity)\//.test(
              spec,
            );
          if (isUsecase) {
            expect(
              ALLOWED_USECASE_MODULES.has(spec),
              `${file} imports ${spec}`,
            ).toBe(true);
          }
        }
        for (const fragment of FORBIDDEN_FRAGMENTS) {
          expect(spec.includes(fragment), `${file} imports ${spec}`).toBe(
            false,
          );
        }
      }
    }
  });
});
