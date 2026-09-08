import type {
  TopicView,
  TopicWithDocumentsView,
} from "@repo/core/application/knowledge/view";

export const NOW = new Date("2026-01-01T14:00:00Z");

export function topicView(
  id: string,
  name: string,
  overrides: Partial<TopicView> = {},
): TopicView {
  return {
    id,
    name,
    description: null,
    status: "active",
    version: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

export function topic(
  id: string,
  name: string,
  overrides: Partial<TopicWithDocumentsView> = {},
): TopicWithDocumentsView {
  return { ...topicView(id, name), documents: [], ...overrides };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
