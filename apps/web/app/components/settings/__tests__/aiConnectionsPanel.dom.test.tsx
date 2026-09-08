import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AiConnectionsPanel } from "@/components/settings/AiConnectionsPanel";

const mocks = vi.hoisted(() => ({
  revokeAllAiClientConnectionsFn: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  revokeAllAiClientConnectionsFn: mocks.revokeAllAiClientConnectionsFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("AiConnectionsPanel", () => {
  it("revokes everything and reports the count", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({
      revokedCount: 3,
      failedCount: 0,
    });
    const { router } = await renderWithRouter(<AiConnectionsPanel />);
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "失効しました（3 件）",
      ),
    );
    expect(invalidate).toHaveBeenCalled();
  });

  // △-9: a partial failure is a count, not an error — the user is told to
  // try again for the rest.
  it("reports the connections it could not revoke", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({
      revokedCount: 2,
      failedCount: 1,
    });
    await renderWithRouter(<AiConnectionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "失効しました（2 件）。1 件は競合のため失効できませんでした。もう一度お試しください",
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("treats an answer without the failure count as a system error", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({ revokedCount: 3 });
    await renderWithRouter(<AiConnectionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
  });

  it("treats an unexpected answer as a system error", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({ nope: true });
    await renderWithRouter(<AiConnectionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
  });
});
