import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

describe("AuthorizeSheet", () => {
  it("names the client and the account, and lists what is allowed and what is not under their labels", async () => {
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("user@example.com として接続")).toBeTruthy();
    const allowed = screen.getByRole("region", { name: "許可される操作" });
    expect(
      within(allowed)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([...ALLOWED_OPERATIONS]);
    const denied = screen.getByRole("region", { name: "できないこと" });
    expect(
      within(denied)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([...DENIED_OPERATIONS]);
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["許可される操作", "できないこと"]);
    expect(button("許可する").disabled).toBe(false);
    expect(button("拒否する").disabled).toBe(false);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("approve posts the request, disables both buttons while pending, then leaves for the redirect", async () => {
    const pending = deferred<unknown>();
    mocks.approveAiClientAuthorizationFn.mockReturnValue(pending.promise);
    vi.stubGlobal("location", { ...window.location, assign: mocks.assign });
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    fireEvent.click(button("許可する"));
    await waitFor(() => expect(button("許可中…")).toBeTruthy());
    expect(button("許可中…").disabled).toBe(true);
    expect(button("拒否する").disabled).toBe(true);
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

  it("deny disables both buttons without claiming to approve, and follows its redirect", async () => {
    const pending = deferred<unknown>();
    mocks.denyAiClientAuthorizationFn.mockReturnValue(pending.promise);
    vi.stubGlobal("location", { ...window.location, assign: mocks.assign });
    await renderWithRouter(<AuthorizeSheet request="blob" view={view} />, {
      path: "/ai-clients/authorize",
    });
    fireEvent.click(button("拒否する"));
    await waitFor(() => expect(button("拒否する").disabled).toBe(true));
    expect(button("許可する").disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "許可中…" })).toBeNull();
    pending.resolve({
      redirectTo: "http://127.0.0.1:8765/callback?error=access_denied",
    });
    await waitFor(() =>
      expect(mocks.assign).toHaveBeenCalledWith(
        "http://127.0.0.1:8765/callback?error=access_denied",
      ),
    );
    expect(mocks.approveAiClientAuthorizationFn).not.toHaveBeenCalled();
  });

  it("a request that expired between the load and the click is the error at the head of the decision, and the page stays", async () => {
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
    fireEvent.click(button("許可する"));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(INVALID_REQUEST_MESSAGE);
    expect(
      screen.getByRole("form", { name: "アクセス許可の決定" })
        .firstElementChild,
    ).toBe(alert);
    expect(button("許可する").disabled).toBe(false);
    expect(mocks.assign).not.toHaveBeenCalled();
  });

  it("an invalid request draws the error in place of the lists and the buttons", async () => {
    await renderWithRouter(
      <AuthorizeSheet request={undefined} view={{ ok: false }} />,
      { path: "/ai-clients/authorize?error=invalid_request" },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "アクセス許可",
    );
    expect(screen.getByRole("alert").textContent).toBe(INVALID_REQUEST_MESSAGE);
    expect(screen.queryByRole("button", { name: "許可する" })).toBeNull();
    expect(screen.queryByRole("button", { name: "拒否する" })).toBeNull();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
  });
});
