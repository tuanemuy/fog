import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { timelineSearchSchema } from "./fogTimelineSchema";
import { validateInput } from "./validator";

const credentials = z.object({
  email: z.string().max(254),
  password: z.string().max(128),
});
const empty = z.object({});

export const registerFog = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(credentials))
  .handler(async ({ data }) => {
    const { assertFogMutation, setFogSession } = await import("./fogAuth");
    await assertFogMutation();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    const result = await (await getFogServices()).register(data);
    await setFogSession(result.token);
    return result.user;
  });

export const loginFog = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(credentials))
  .handler(async ({ data }) => {
    const { assertFogMutation, setFogSession } = await import("./fogAuth");
    await assertFogMutation();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    const result = await (await getFogServices()).login(data);
    await setFogSession(result.token);
    return result.user;
  });

export const logoutFog = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(empty))
  .handler(async () => {
    const { assertFogMutation, clearFogSession } = await import("./fogAuth");
    await assertFogMutation();
    await clearFogSession();
  });

export const loadFogSession = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(empty))
  .handler(async () => {
    const { getFogSession } = await import("./fogAuth");
    return getFogSession();
  });

export const createFogMemo = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({ body: z.string().max(100000) })))
  .handler(async ({ data }) => {
    const { assertFogMutation, requireFogActor } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return (await getFogServices()).createMemo(actor, data);
  });

export const renderFogTimeline = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(timelineSearchSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { TimelineContent } = await import(
      "@/components/fog/TimelineContent"
    );
    return {
      content: renderServerComponent(
        <TimelineContent actor={actor} search={data} />,
      ),
    };
  });
