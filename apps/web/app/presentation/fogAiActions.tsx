import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { aiConsentSearchSchema } from "./fogAiSchema";
import { validateInput } from "./validator";

export const renderFogAiConsent = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(aiConsentSearchSchema))
  .handler(async ({ data }) => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { AiConsentContent } = await import(
      "@/components/fog/AiConsentContent"
    );
    return {
      content: renderServerComponent(
        <AiConsentContent actor={actor} requestToken={data.request} />,
      ),
    };
  });

export const decideFogAiConsent = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(
      z
        .object({
          requestToken: z.string().min(1).max(256),
          allow: z.boolean(),
        })
        .strict(),
    ),
  )
  .handler(async ({ data }) => {
    const { requireFogActor, assertFogMutation } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    return getFogServices().decideAiAuthorization(actor, data);
  });

export const revokeFogAiConnection = createServerFn({ method: "POST" })
  .middleware([errorResponseMiddleware])
  .inputValidator(
    validateInput(z.object({ id: z.string().min(1).max(128) }).strict()),
  )
  .handler(async ({ data }) => {
    const { requireFogActor, assertFogMutation } = await import("./fogAuth");
    await assertFogMutation();
    const actor = await requireFogActor();
    const { getFogServices } = await import(
      "@repo/core/application/fog/runtime"
    );
    await getFogServices().revokeAiConnection(actor, data);
  });
