import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { validateInput } from "./validator";

const idSchema = z.object({ id: z.string().min(1).max(128) });
const title = z.string().max(200);
const body = z.string().max(1000000);
const reason = z.string().max(1000).default("");
const version = z.number().int().positive();

export const createFogTopic = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(z.object({ title, description: z.string().max(2000) })),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().createTopic(actor, data);
  });

export const updateFogTopic = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      idSchema.extend({
        title,
        description: z.string().max(2000),
        completed: z.boolean(),
        expectedVersion: version,
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
    return getFogServices().updateTopic(actor, data);
  });

export const loadFogTopic = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(idSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().getTopic(actor, data.id);
  });

export const createFogDocument = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      z.object({
        topicId: z.string().min(1).max(128),
        title,
        body,
        reason,
        sourceMemoIds: z.array(z.string().min(1).max(128)).max(1000),
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
    return getFogServices().createDocument(actor, data);
  });

export const editFogDocument = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      idSchema.extend({ title, body, reason, expectedVersion: version }),
    ),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().editDocument(actor, data);
  });

export const loadFogDocument = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(idSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().getDocument(actor, data.id);
  });

export const searchFogSourceMemos = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      z.object({
        keyword: z.string().max(500),
        cursor: z.string().max(2048).optional(),
      }),
    ),
  )
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().listTimeline(actor, {
      keyword: data.keyword,
      ...(data.cursor === undefined ? {} : { cursor: data.cursor }),
      limit: 20,
    });
  });

export const rollbackFogDocument = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(idSchema.extend({ version, expectedVersion: version })),
  )
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().rollbackDocument(actor, data);
  });

export const renderFogTopics = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({})))
  .handler(async () => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { TopicsContent } = await import("@/components/fog/TopicsContent");
    return { content: renderServerComponent(<TopicsContent actor={actor} />) };
  });

export const renderFogTopic = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(idSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { TopicContent } = await import("@/components/fog/TopicContent");
    return {
      content: renderServerComponent(
        <TopicContent actor={actor} id={data.id} />,
      ),
    };
  });

export const renderFogDocument = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      idSchema.extend({ mode: z.enum(["view", "edit", "new", "history"]) }),
    ),
  )
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { DocumentContent } = await import(
      "@/components/fog/DocumentContent"
    );
    return {
      content: renderServerComponent(
        <DocumentContent actor={actor} id={data.id} mode={data.mode} />,
      ),
    };
  });
