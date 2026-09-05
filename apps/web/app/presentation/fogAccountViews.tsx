import { createServerFn } from "@tanstack/react-start";
import { renderServerComponent } from "@tanstack/react-start/rsc";
import { z } from "zod";
import { errorResponseMiddleware } from "./errorResponseMiddleware";
import { validateInput } from "./validator";
export const renderFogResetComplete = createServerFn({ method: "GET" })
  .middleware([errorResponseMiddleware])
  .inputValidator(validateInput(z.object({}).strict()))
  .handler(async () => {
    const { requireFogActor } = await import("./fogAuth");
    const actor = await requireFogActor();
    const { ResetCompleteContent } = await import(
      "@/components/fog/ResetCompleteContent"
    );
    return {
      content: renderServerComponent(<ResetCompleteContent actor={actor} />),
    };
  });
