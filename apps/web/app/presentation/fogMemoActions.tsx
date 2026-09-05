import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { timelineQuerySchema } from "./fogTimelineSchema";
import { validateInput } from "./validator";

const idSchema = z.object({ id: z.string().min(1).max(100) });
export const loadFogTimeline = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(timelineQuerySchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().listTimeline(await requireFogActor(), data);
  });

export const loadFogMemo = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(idSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().getMemo(await requireFogActor(), data.id);
  });

export const editFogMemo = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      idSchema.extend({
        body: z.string().max(100000),
        expectedVersion: z.number().int().positive(),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().editMemo(await requireFogActor(), data);
  });

export const renderFogMemoHistory = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(idSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { MemoHistoryContent } = await import(
      "@/components/fog/MemoHistoryContent"
    );
    return {
      content: renderServerComponent(
        <MemoHistoryContent actor={actor} id={data.id} />,
      ),
    };
  });

export const rollbackFogMemo = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      idSchema.extend({
        version: z.number().int().positive(),
        expectedVersion: z.number().int().positive(),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().rollbackMemo(await requireFogActor(), data);
  });
