import type { AiClientConnectionView } from "@repo/core/application/identity/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  AiConnectionsList,
  emptyMessage,
} from "@/components/settings/AiConnectionsList";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  revokeAiClientConnectionFn: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  revokeAiClientConnectionFn: mocks.revokeAiClientConnectionFn,
}));

const connections: AiClientConnectionView[] = [
  {
    connectionId: "conn-1",
    clientName: "Claude",
    status: "active",
    connectedAt: new Date("2026-09-01T09:00:00.000Z"),
    lastUsedAt: new Date("2026-09-07T12:34:00.000Z"),
    revokedAt: null,
  },
  {
    connectionId: "conn-2",
    clientName: "Cursor",
    status: "active",
    connectedAt: new Date("2026-09-02T09:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
  },
  {
    connectionId: "conn-old",
    clientName: "Old Client",
    status: "revoked",
    connectedAt: new Date("2026-08-01T09:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: new Date("2026-08-15T09:00:00.000Z"),
  },
];

const MCP_URL = "http://localhost:3000/mcp";

afterEach(() => {
  vi.clearAllMocks();
});

const drawList = (list: readonly AiClientConnectionView[] = connections) =>
  renderWithRouter(<AiConnectionsList connections={list} mcpUrl={MCP_URL} />, {
    path: "/settings",
  });

const rows = () =>
  within(screen.getByRole("list", { name: "接続しているAI" })).getAllByRole(
    "listitem",
  );

function row(index: number): HTMLElement {
  const found = rows()[index];
  if (found === undefined) throw new Error(`no row ${index}`);
  return found;
}

describe("AiConnectionsList", () => {
  it("draws the active connections with their dates in Asia/Tokyo, never a revoked one", async () => {
    await drawList();
    expect(rows().map((row) => row.textContent)).toEqual([
      "Claude接続: 2026年9月1日最終利用: 2026年9月7日 21:34接続を解除",
      "Cursor接続: 2026年9月2日最終利用: 未使用接続を解除",
    ]);
    expect(screen.queryByText("Old Client")).toBeNull();
    expect(screen.queryByText(emptyMessage(MCP_URL))).toBeNull();
  });

  it("with no connection, says so in one line that carries the MCP URL to add", async () => {
    await drawList([]);
    expect(screen.getByText(emptyMessage(MCP_URL))).toBeTruthy();
    expect(emptyMessage(MCP_URL)).toContain(MCP_URL);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("revoke asks first; cancelling keeps the row and calls nothing", async () => {
    await drawList();
    fireEvent.click(
      screen.getByRole("button", { name: "Claude の接続を解除" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "接続を解除しますか？" }),
    ).toBeTruthy();
    expect(dialog.textContent).toContain(
      "解除後は、Claude から操作できなくなります。",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(mocks.revokeAiClientConnectionFn).not.toHaveBeenCalled();
  });

  it("confirming removes the row at once, runs the server function, and reconciles", async () => {
    mocks.revokeAiClientConnectionFn.mockResolvedValue({
      connectionId: "conn-1",
    });
    const { router } = await drawList();
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      screen.getByRole("button", { name: "Claude の接続を解除" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "接続を解除" }));
    await waitFor(() => expect(screen.queryByText("Claude")).toBeNull());
    expect(screen.getByText("Cursor")).toBeTruthy();
    expect(mocks.revokeAiClientConnectionFn).toHaveBeenCalledWith({
      data: { connectionId: "conn-1" },
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failure puts the row back with its reason under that row", async () => {
    mocks.revokeAiClientConnectionFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "DATABASE_ERROR",
        message: "boom",
      }),
    );
    await drawList();
    fireEvent.click(
      screen.getByRole("button", { name: "Cursor の接続を解除" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "接続を解除" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(row(1).contains(alert)).toBe(true);
    expect(row(0).contains(alert)).toBe(false);
  });
});
