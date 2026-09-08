import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  ALLOWED_OPERATIONS,
  AuthorizeSheet,
  DENIED_OPERATIONS,
  INVALID_REQUEST_MESSAGE,
} from "@/components/aiClients/AuthorizeSheet";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  approveAiClientAuthorizationFn: vi.fn<(input: unknown) => Promise<unknown>>(),
  denyAiClientAuthorizationFn: vi.fn<(input: unknown) => Promise<unknown>>(),
  assign: vi.fn<(url: string) => void>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/aiClients/actions", () => ({
  approveAiClientAuthorizationFn: mocks.approveAiClientAuthorizationFn,
  denyAiClientAuthorizationFn: mocks.denyAiClientAuthorizationFn,
}));

const view = {
  ok: true,
  clientName: "Claude",
  email: "user@example.com",
} as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("AuthorizeSheet", () => {
  it("names the client and the account, and lists what is allowed and what is not", async () => {
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("user@example.com")).toBeTruthy();
    for (const item of [...ALLOWED_OPERATIONS, ...DENIED_OPERATIONS]) {
      expect(screen.getByText(item)).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "許可する" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "拒否する" })).toBeTruthy();
  });

  it("approve posts the request, disables both buttons while pending, then leaves for the redirect", async () => {
    const pending = deferred<unknown>();
    mocks.approveAiClientAuthorizationFn.mockReturnValue(pending.promise);
    vi.stubGlobal("location", { ...window.location, assign: mocks.assign });
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    fireEvent.click(screen.getByRole("button", { name: "許可する" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "処理中…" })).toBeTruthy(),
    );
    expect(
      (screen.getByRole("button", { name: "処理中…" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "拒否する" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mocks.approveAiClientAuthorizationFn).toHaveBeenCalledWith({
      data: { request: "blob" },
    });
    pending.resolve({
      redirectTo: "http://127.0.0.1:8765/callback?code=c&state=s",
    });
    await waitFor(() =>
      expect(mocks.assign).toHaveBeenCalledWith(
        "http://127.0.0.1:8765/callback?code=c&state=s",
      ),
    );
    expect(mocks.denyAiClientAuthorizationFn).not.toHaveBeenCalled();
  });

  it("deny runs the other action and follows its redirect", async () => {
    mocks.denyAiClientAuthorizationFn.mockResolvedValue({
      redirectTo: "http://127.0.0.1:8765/callback?error=access_denied",
    });
    vi.stubGlobal("location", { ...window.location, assign: mocks.assign });
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    fireEvent.click(screen.getByRole("button", { name: "拒否する" }));
    await waitFor(() =>
      expect(mocks.assign).toHaveBeenCalledWith(
        "http://127.0.0.1:8765/callback?error=access_denied",
      ),
    );
    expect(mocks.approveAiClientAuthorizationFn).not.toHaveBeenCalled();
  });

  it("a request that expired between the load and the click is the error, and the page stays", async () => {
    mocks.approveAiClientAuthorizationFn.mockRejectedValue(
      new AppServerError({
        kind: "validation",
        code: "AUTHORIZATION_REQUEST_INVALID",
        message: "The authorization request is invalid or has expired",
      }),
    );
    vi.stubGlobal("location", { ...window.location, assign: mocks.assign });
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    fireEvent.click(screen.getByRole("button", { name: "許可する" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(INVALID_REQUEST_MESSAGE);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("an invalid request draws the error and no 「許可する」", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthorizeSheet request={undefined} view={{ ok: false }} />,
      { path: "/ai-clients/authorize?error=invalid_request" },
    );
    expect(screen.getByRole("alert").textContent).toBe(INVALID_REQUEST_MESSAGE);
    expect(screen.queryByRole("button", { name: "許可する" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒否する" })).toBeNull();
    expectInternalHrefsToResolve();
  });
});
