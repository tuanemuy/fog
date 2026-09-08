import type {
  SearchOutputView,
  SearchResultItemView,
} from "@repo/core/application/search/view";
import { z } from "zod";
import { isRecord } from "@/presentation/serverFnResult";

/** One 「もっと読む」 page; the first page is streamed by the route. */
export const SEARCH_PAGE_LIMIT = 20;

// Transport bounds only; the value object holds the keyword rule. The
// cursor carries up to 500 packed ids (~11.4 KB base64url).
export const searchMoreSchema = z.object({
  q: z.string().trim().min(1).max(500),
  topic: z.string().trim().min(1).max(200).optional(),
  cursor: z.string().min(1).max(20_000),
});

function isResultItem(value: unknown): value is SearchResultItemView {
  if (!isRecord(value)) return false;
  if (typeof value.id !== "string" || typeof value.snippet !== "string") {
    return false;
  }
  if (!(value.timestamp instanceof Date)) return false;
  if (value.type === "memo") return Array.isArray(value.sourceOfDocumentIds);
  if (value.type === "document") {
    return (
      typeof value.topicId === "string" &&
      typeof value.topicName === "string" &&
      Array.isArray(value.sourceMemoIds)
    );
  }
  return false;
}

export function isSearchOutput(value: unknown): value is SearchOutputView {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isResultItem) &&
    typeof value.count === "number" &&
    (value.nextCursor === null || typeof value.nextCursor === "string")
  );
}
