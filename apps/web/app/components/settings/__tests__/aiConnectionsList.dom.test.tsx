import type { AiClientConnectionView } from "@repo/core/application/identity/view";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AiConnectionsList } from "@/components/settings/AiConnectionsList";
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

afterEach(() => {
  vi.clearAllMocks();
});

describe("AiConnectionsList", () => {
  it("draws the active connections with their dates, never a revoked one", async () => {
    await renderWithRouter(
      <AiConnectionsList
        connections={connections}
        mcpUrl="http://localhost:3000/mcp"
      />,
      { path: "/settings" },
    );
    const list = screen.getByRole("list", { name: "接続済み AI クライアント" });
    expect(list.querySelectorAll("li")).toHaveLength(2);
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("Cursor")).toBeTruthy();
    expect(screen.queryByText("Old Client")).toBeNull();
    expect(screen.getByText(/最終利用: 未使用/)).toBeTruthy();
    expect(screen.getAllByText(/接続済み: 2026/)).toHaveLength(2);
    expect(screen.getByText(/最終利用: 2026/)).toBeTruthy();
    expect(screen.queryByText("http://localhost:3000/mcp")).toBeNull();
  });

  it("with no connection, says so and shows the MCP URL to add", async () => {
    await renderWithRouter(
      <AiConnectionsList connections={[]} mcpUrl="http://localhost:3000/mcp" />,
      { path: "/settings" },
    );
    expect(screen.getByText("接続はありません。")).toBeTruthy();
    expect(screen.getByText("http://localhost:3000/mcp")).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("revoke asks first; cancelling keeps the row and calls nothing", async () => {
    await renderWithRouter(
      <AiConnectionsList
        connections={connections}
        mcpUrl="http://localhost:3000/mcp"
      />,
      { path: "/settings" },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Claude の接続を解除" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("「Claude」の接続を解除すると");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Claude")).toBeTruthy();
    expect(mocks.revokeAiClientConnectionFn).not.toHaveBeenCalled();
  });

  it("confirming removes the row at once, runs the server function, and reconciles", async () => {
    mocks.revokeAiClientConnectionFn.mockResolvedValue({
      connectionId: "conn-1",
    });
    const { router } = await renderWithRouter(
      <AiConnectionsList
        connections={connections}
        mcpUrl="http://localhost:3000/mcp"
      />,
      { path: "/settings" },
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      screen.getByRole("button", { name: "Claude の接続を解除" }),
    );
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "解除する" }));
    await waitFor(() => expect(screen.queryByText("Claude")).toBeNull());
    expect(screen.getByText("Cursor")).toBeTruthy();
    expect(mocks.revokeAiClientConnectionFn).toHaveBeenCalledWith({
      data: { connectionId: "conn-1" },
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a failure puts the row back with its reason", async () => {
    mocks.revokeAiClientConnectionFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "DATABASE_ERROR",
        message: "boom",
      }),
    );
    await renderWithRouter(
      <AiConnectionsList
        connections={connections}
        mcpUrl="http://localhost:3000/mcp"
      />,
      { path: "/settings" },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Cursor の接続を解除" }),
    );
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "解除する" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expect(await screen.findByText("Cursor")).toBeTruthy();
  });
});
