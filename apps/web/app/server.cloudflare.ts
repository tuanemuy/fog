import { AsyncLocalStorage } from "node:async_hooks";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createRequestContainer,
  readRequestServerConfig,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import defaultEntry from "@tanstack/react-start/server-entry";
import { handleDiagnostics } from "./worker/cloudflare/diagnostics";

/**
 * The request Worker. Builds one container per request, keeps it in an
 * `AsyncLocalStorage` scope that `getContainer()` reads, and hands the
 * request to TanStack Start. The queue consumers join this module with the
 * password-reset slice.
 */

const ALS_SYMBOL: unique symbol = Symbol.for(
  "@tanstack-start-template/request-als",
) as never;
type AlsGlobalSlot = { [ALS_SYMBOL]?: AsyncLocalStorage<RequestContainer> };

// SSR and RSC are separate module graphs in one realm; sharing the storage
// through `globalThis` is what keeps both graphs reading the same scope.
const slot = globalThis as unknown as AlsGlobalSlot;
const storage = slot[ALS_SYMBOL] ?? new AsyncLocalStorage<RequestContainer>();
slot[ALS_SYMBOL] = storage;
installContainerStore({ getStore: () => storage.getStore() });

export default {
  async fetch(request: Request, env: ServerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__diagnostics/")) {
      return handleDiagnostics(request, env);
    }
    const config = readRequestServerConfig(env);
    const container = createRequestContainer(config);
    return storage.run(container, () => defaultEntry.fetch(request));
  },
};
