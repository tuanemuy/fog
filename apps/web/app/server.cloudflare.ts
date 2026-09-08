import { AsyncLocalStorage } from "node:async_hooks";
import type { OutboxQueueMessage } from "@repo/core/adapters/cloudflare/queueMessage";
import { installContainerStore } from "@repo/core/application/di/containerStore";
import {
  createAiRuntime,
  createRequestContainer,
  readRequestServerConfig,
  type ServerEnv,
} from "@repo/core/application/di/serverCloudflare";
import type { RequestContainer } from "@repo/core/application/di/types";
import defaultEntry from "@tanstack/react-start/server-entry";
import { handleAiRoute, isAiRoute } from "./presentation/ai/router";
import { attachAiRuntime } from "./presentation/ai/runtime";
import { handleExport, isExportRoute } from "./presentation/export/handler";
import { handleDiagnostics } from "./worker/cloudflare/diagnostics";
import { runQueueBatch } from "./worker/cloudflare/queueHandlers";
import { handleSso, isSsoRoute } from "./worker/cloudflare/ssoHandlers";

/**
 * The request Worker. Builds one container per request, keeps it in an
 * `AsyncLocalStorage` scope that `getContainer()` reads, and hands the
 * request to TanStack Start. Two route families are answered before
 * TanStack sees them: the SSO handlers (`/auth/sso/`, `/__dev/sso/`),
 * which run outside the router because their outcome is a redirect with
 * cookies, the AI API, the export download (a binary answer), and the
 * diagnostics route. `queue()` hosts the mail consumer and the DLQ
 * handler.
 */

/** What `initialize` reports as `serverInfo.version`. */
const APP_VERSION = "0.0.0";

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
    if (isSsoRoute(url.pathname)) {
      return handleSso(request, env);
    }
    const config = readRequestServerConfig(env);
    const container = createRequestContainer(config);
    const aiRuntime = createAiRuntime(config);
    attachAiRuntime(container, aiRuntime);
    if (isAiRoute(url.pathname)) {
      return storage.run(container, () =>
        handleAiRoute(request, url.pathname, {
          container,
          runtime: aiRuntime,
          appUrl: config.appUrl,
          serverVersion: APP_VERSION,
        }),
      );
    }
    if (isExportRoute(url.pathname)) {
      return storage.run(container, () =>
        handleExport(request, { container, appUrl: config.appUrl }),
      );
    }
    return storage.run(container, () => defaultEntry.fetch(request));
  },
  async queue(batch: MessageBatch<unknown>, env: ServerEnv): Promise<void> {
    await runQueueBatch(batch as MessageBatch<OutboxQueueMessage>, env);
  },
};
