import { isRedirect } from "@tanstack/react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticated: false,
  reads: 0,
  declared: [] as unknown[][],
}));

vi.mock("@tanstack/react-start/server", () => ({
  setResponseHeader: () => {},
  setResponseStatus: () => {},
}));

// Stands in for the compiler: records the middleware each server function
// is declared with, and answers its call with the session state set here.
vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  createServerFn: () => {
    const builder = {
      middleware: (list: unknown[]) => {
        mocks.declared.push(list);
        return builder;
      },
      handler: () => async () => {
        mocks.reads += 1;
        return { authenticated: mocks.authenticated };
      },
    };
    return builder;
  },
}));

const { noStoreMiddleware } = await import("../noStoreMiddleware");
const { requireSessionBeforeLoad } = await import("../authGuard");

async function run(href: string): Promise<unknown> {
  try {
    await requireSessionBeforeLoad({ location: { href } });
  } catch (error) {
    return error;
  }
  return undefined;
}

beforeEach(() => {
  mocks.authenticated = false;
  mocks.reads = 0;
});

describe("requireSessionBeforeLoad", () => {
  // The document's `Cache-Control: no-store` comes from the server function
  // the guard reads the session through, not from the guard: a guard that
  // stopped going through it would leave the protected screens cacheable.
  it("reads the session through the one server function that marks the document no-store", async () => {
    expect(mocks.declared).toHaveLength(1);
    expect(mocks.declared[0]).toContain(noStoreMiddleware);
    mocks.authenticated = true;

    expect(await run("/ai-clients/authorize?request=r")).toBeUndefined();
    expect(mocks.reads).toBe(1);
  });

  it("sends a visitor without a session to the login screen, carrying where they were", async () => {
    const caught = await run("/ai-clients/authorize?request=r");

    expect(mocks.reads).toBe(1);
    expect(isRedirect(caught)).toBe(true);
    expect(isRedirect(caught) && caught.options.to).toBe("/login");
    expect(isRedirect(caught) && caught.options.search).toEqual({
      redirect: "/ai-clients/authorize?request=r",
    });
  });

  it("carries nothing back for the timeline or a URL that is not a safe path", async () => {
    for (const href of ["/", "//evil.example"]) {
      const caught = await run(href);
      expect(isRedirect(caught), href).toBe(true);
      expect(isRedirect(caught) && caught.options.search, href).toEqual({});
    }
  });
});
