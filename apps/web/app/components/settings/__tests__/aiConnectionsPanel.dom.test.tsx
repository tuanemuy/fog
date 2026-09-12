import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { toastsShown, withToasts } from "@/components/__tests__/toastFrame";
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

const drawPanel = () =>
  renderWithRouter(withToasts(<AiConnectionsPanel />), {
    path: "/password-reset/done",
  });

/** Presses 「すべて失効」 on the row, then the dialog's own confirmation. */
async function revokeAll() {
  fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "すべて失効" }));
}

describe("AiConnectionsPanel", () => {
  it("asks first; cancelling calls nothing", async () => {
    await drawPanel();
    expect(screen.getByText("すべての接続")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "すべて失効" }));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", {
        name: "すべての接続を失効しますか？",
      }),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.revokeAllAiClientConnectionsFn).not.toHaveBeenCalled();
  });

  it("revokes everything, reconciles, and says how many in a toast with nothing left on the row", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({
      revokedCount: 3,
      failedCount: 0,
    });
    const { router } = await drawPanel();
    const invalidate = vi.spyOn(router, "invalidate");
    await revokeAll();
    await waitFor(() =>
      expect(toastsShown()).toEqual(["失効しました（3 件）"]),
    );
    expect(invalidate).toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // Design △-9: a partial failure is split — the part
  // that went through is a toast, the part that did not stays on the row
  // with a retry.
  it("splits a partial failure: the revoked count as a toast, the rest under the row with a retry", async () => {
    mocks.revokeAllAiClientConnectionsFn
      .mockResolvedValueOnce({ revokedCount: 2, failedCount: 1 })
      .mockResolvedValueOnce({ revokedCount: 1, failedCount: 0 });
    await drawPanel();
    await revokeAll();
    const alert = await screen.findByRole("alert");
    expect(toastsShown()).toEqual(["失効しました（2 件）"]);
    expect(alert.textContent).toBe(
      "1 件は競合のため失効できませんでしたリトライ",
    );
    expect(toastsShown().join("")).not.toContain("失効できませんでした");

    fireEvent.click(within(alert).getByRole("button", { name: "リトライ" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(mocks.revokeAllAiClientConnectionsFn).toHaveBeenCalledTimes(2);
    expect(toastsShown()).toEqual([
      "失効しました（2 件）",
      "失効しました（1 件）",
    ]);
  });

  it("raises no toast when nothing was revoked and something could not be", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({
      revokedCount: 0,
      failedCount: 2,
    });
    await drawPanel();
    await revokeAll();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("2 件は競合のため失効できませんでした");
    expect(toastsShown()).toEqual([]);
  });

  it("treats an answer without the failure count as a system error, on the row", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({ revokedCount: 3 });
    await drawPanel();
    await revokeAll();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しましたリトライ");
    expect(toastsShown()).toEqual([]);
  });

  it("treats an unexpected answer as a system error", async () => {
    mocks.revokeAllAiClientConnectionsFn.mockResolvedValue({ nope: true });
    await drawPanel();
    await revokeAll();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("システムエラーが発生しました");
  });
});
