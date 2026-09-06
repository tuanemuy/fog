import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { contentTargetSchema, searchSchema } from "./fogDataSchema";
import { validateInput } from "./validator";

export const deleteFogContent = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      contentTargetSchema.extend({
        expectedVersion: z.number().int().positive(),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().softDelete(actor, data);
  });

export const restoreFogContent = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      contentTargetSchema.extend({
        restoreTopicSet: z.boolean().optional(),
        targetTopic: z
          .discriminatedUnion("kind", [
            z.object({
              kind: z.literal("existing"),
              id: z.string().min(1).max(128),
            }),
            z.object({
              kind: z.literal("new"),
              title: z.string().max(200),
              description: z.string().max(2000),
            }),
          ])
          .optional(),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().restore(actor, {
      kind: data.kind,
      id: data.id,
      ...(data.restoreTopicSet === undefined
        ? {}
        : { restoreTopicSet: data.restoreTopicSet }),
      ...(data.targetTopic === undefined
        ? {}
        : { targetTopic: data.targetTopic }),
    });
  });

export const hardDeleteFogContent = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(contentTargetSchema))
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().hardDelete(actor, data);
  });

export const emptyFogTrash = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({})))
  .handler(async () => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().emptyTrash(actor);
  });

export const saveFogRetention = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      z.object({ retentionDays: z.number().int().min(1).max(3650) }),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().setRetentionDays(actor, data);
  });

export const exportFogData = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({})))
  .handler(async () => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().exportData(actor);
  });

export const loadFogSearch = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      searchSchema.extend({ cursor: z.string().max(4096).optional() }),
    ),
  )
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().search(actor, {
      query: data.query,
      ...(data.topicId ? { topicId: data.topicId } : {}),
      ...(data.cursor ? { cursor: data.cursor } : {}),
      limit: 30,
    });
  });

export const renderFogSearch = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(searchSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { SearchContent } = await import("@/components/fog/SearchContent");
    return {
      content: renderServerComponent(
        <SearchContent actor={actor} search={data} />,
      ),
    };
  });

export const renderFogTrash = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({})))
  .handler(async () => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { TrashContent } = await import("@/components/fog/TrashContent");
    return { content: renderServerComponent(<TrashContent actor={actor} />) };
  });

export const renderFogSettings = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({})))
  .handler(async () => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { SettingsContent } = await import(
      "@/components/fog/SettingsContent"
    );
    return {
      content: renderServerComponent(<SettingsContent actor={actor} />),
    };
  });
