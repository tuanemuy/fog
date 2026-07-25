import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: [] as Array<readonly [string, string]>,
}));

vi.mock("@tanstack/react-start/server", () => ({
  setResponseHeader: (name: string, value: string) => {
    mocks.headers.push([name, value] as const);
  },
}));

const { noStoreMiddleware } = await import("../noStoreMiddleware");

// AC-15 / manual TC-23. `requireUserId()` also sets the header, but on a
// streaming route it runs inside the RSC render, after the response
// headers were settled — so this middleware is what actually keeps a
// protected screen out of the browser's history cache. What has to be
// pinned is that the headers are written *before* the handler runs;
// writing them after `next()` is the failure mode that looks correct in
// review and does nothing at runtime.
describe("noStoreMiddleware", () => {
  async function run(): Promise<{
    result: unknown;
    duringHandler: ReadonlyArray<readonly [string, string]>;
  }> {
    mocks.headers = [];
    let duringHandler: ReadonlyArray<readonly [string, string]> = [];
    const result = await noStoreMiddleware.options.server?.({
      next: async () => {
        duringHandler = [...mocks.headers];
        return "handler result";
      },
    } as never);
    return { result, duringHandler };
  }

  it("writes the cache directives before the handler runs", async () => {
    const { duringHandler } = await run();

    expect(duringHandler).toEqual([
      ["cache-control", "no-store, private"],
      ["vary", "cookie"],
    ]);
  });

  it("returns whatever the handler returned", async () => {
    const { result } = await run();

    expect(result).toBe("handler result");
  });
});
