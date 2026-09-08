import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import { SEARCH_PAGE_LIMIT, searchMoreSchema } from "./schema";

/**
 * S-SE-01 step 4: the next page of a snapshot. POST, because the cursor is
 * a few kilobytes and belongs in a body, not a query string.
 */
export const searchMoreFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(searchMoreSchema))
  .handler(async ({ data }) => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/search/search"),
    );
    return module.search({
      container,
      input: {
        userId,
        keyword: data.q,
        topicId: data.topic ?? null,
        cursor: data.cursor,
        limit: SEARCH_PAGE_LIMIT,
      },
    });
  });
