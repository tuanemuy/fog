import { createServerFn } from "@tanstack/react-start";
import { errorResponseMiddleware } from "@/presentation/errorResponseMiddleware";
import { noStoreMiddleware } from "@/presentation/noStoreMiddleware";
import { loadServerDeps } from "@/presentation/serverAction";
import { validateInput } from "@/presentation/validator";
import {
  changeTrashRetentionDaysSchema,
  type RetentionSavedResult,
} from "./schema";

/** S-ST-01. */
export const changeTrashRetentionDaysFn = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware, noStoreMiddleware])
  .inputValidator(validateInput(changeTrashRetentionDaysSchema))
  .handler(async ({ data }): Promise<RetentionSavedResult> => {
    const { requireUserId } = await import("@/presentation/currentUser");
    const userId = await requireUserId();
    const { container, module } = await loadServerDeps(
      () => import("@repo/core/application/identity/changeTrashRetentionDays"),
    );
    await module.changeTrashRetentionDays({
      container,
      input: { userId, retentionDays: data.retentionDays },
    });
    return { retentionDays: data.retentionDays };
  });
