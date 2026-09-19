import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogoutButton } from "@/components/settings/LogoutButton";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  logoutFn: vi.fn<(input: object) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/auth/actions", () => ({
  loginFn: vi.fn(),
  registerFn: vi.fn(),
  logoutFn: mocks.logoutFn,
}));

const assign = vi.fn<(url: string) => void>();
const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

describe("LogoutButton", () => {
  it("navigates to /login once the server confirms the session ended", async () => {
    mocks.logoutFn.mockResolvedValue({ ok: true });
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows the rejection and stays", async () => {
    mocks.logoutFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "SESSION_ERROR",
        message: "x",
        retryable: false,
      }),
    );
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(assign).not.toHaveBeenCalled();
    // First in the form, above the button it belongs to.
    const button = screen.getByRole("button", { name: "ログアウト" });
    expect(
      alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  // A resolved value that is not the server function's — the platform
  // answering for it — is not a confirmation that the cookie was cleared.
  it("treats a resolved value of the wrong shape as a system error and stays", async () => {
    mocks.logoutFn.mockResolvedValue({ status: 500, unhandled: true });
    render(<LogoutButton />);
    fireEvent.click(screen.getByRole("button", { name: "ログアウト" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(assign).not.toHaveBeenCalled();
  });
});
