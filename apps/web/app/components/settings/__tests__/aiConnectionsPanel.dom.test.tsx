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
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({ revokedCount: 3 });
    await renderWithRouter(<AiConnectionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        "失効しました（3 件）",
      ),
    );
  });

  it("treats an unexpected answer as a system error", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({ nope: true });
    await renderWithRouter(<AiConnectionsPanel />);
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
  });
});
