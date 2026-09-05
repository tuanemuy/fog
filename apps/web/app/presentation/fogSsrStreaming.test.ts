import { ReadableStream } from "node:stream/web";
import {
  createControlledPromise,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import {
  attachRouterServerSsrUtils,
  transformStreamWithRouter,
} from "@tanstack/react-router/ssr/server";
import { describe, expect, it } from "vitest";

describe("SSR deferred hydration", () => {
  it.each([
    "before",
    "after",
  ] as const)("keeps settlement scripts when serialization finishes %s the HTML transform starts", async (timing) => {
    const deferred = createControlledPromise<string>();
    const router = createRouter({
      history: createMemoryHistory({ initialEntries: ["/"] }),
      routeTree: createRootRoute({
        loader: () => ({ content: deferred }),
      }),
      isServer: true,
    });
    await router.load();
    attachRouterServerSsrUtils({ router, manifest: undefined });
    const ssr = router.serverSsr;
    if (!ssr) throw new Error("SSR utilities missing");
    await ssr.dehydrate();
    const initial = ssr.takeBufferedScripts();
    expect(initial?.children).not.toContain("resolved content");
    const serialized = new Promise<void>((resolve) =>
      ssr.onSerializationFinished(resolve),
    );
    if (timing === "before") {
      deferred.resolve("resolved content");
      await serialized;
    }
    const html = `<html><body><script id="${initial?.attrs?.id}">${initial?.children}</script></body></html>`;
    const app = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(html));
        controller.close();
      },
    });
    const transformed = transformStreamWithRouter(router, app);
    const reader = transformed.getReader();
    const first = await reader.read();
    let result = new TextDecoder().decode(first.value);
    expect(result).toContain("<html>");
    if (timing === "after") {
      expect(ssr.isSerializationFinished()).toBe(false);
      expect(result).not.toContain("resolved content");
      deferred.resolve("resolved content");
    }
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      result += new TextDecoder().decode(chunk.value);
    }
    reader.releaseLock();
    expect(result).toContain("resolved content");
    expect(result).toContain("$_TSR.e()");
    expect(result.indexOf("resolved content")).toBeLessThan(
      result.indexOf("</body>"),
    );
  });
});
