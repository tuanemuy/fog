import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { SettingsFeed } from "@/components/settings/SettingsFeed";
import { SettingsUnavailable } from "@/components/settings/SettingsUnavailable";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn<() => Promise<string>>(),
  loaders: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/auth/actions", () => ({
  loginFn: vi.fn(),
  registerFn: vi.fn(),
  logoutFn: vi.fn(),
}));

vi.mock("@/components/settings/actions", () => ({
  changeTrashRetentionDaysFn: vi.fn(),
  changePasswordFn: vi.fn(),
  unlinkSsoCredentialFn: vi.fn(),
  revokeAiClientConnectionFn: vi.fn(),
  revokeAllAiClientConnectionsFn: vi.fn(),
}));

vi.mock("@/presentation/currentUser", () => ({
  requireUserId: mocks.requireUserId,
}));

// The guard's redaction and logging are the middleware's tests; here it
// only has to let the failure through as the leaf sees it.
vi.mock("@/presentation/errorResponseMiddleware", () => ({
  guardStreamedRender: (load: () => Promise<unknown>) => load(),
}));

// `serverData` is called twice at module load, in source order: the
// account first, the AI connections second.
vi.mock("@/presentation/serverAction", () => ({
  serverData: () => {
    const loader = vi.fn();
    mocks.loaders.push(loader);
    return loader;
  },
}));

const USER_ID = "01950000-0000-7000-8000-000000000001";

describe("SettingsUnavailable", () => {
  it("draws the failure and keeps the logout control", async () => {
    await renderWithRouter(
      <SettingsUnavailable message="システムエラーが発生しました" />,
      { path: "/settings" },
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "システムエラーが発生しました",
    );
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
  });
});

describe("SettingsFeed", () => {
  it("degrades to the error block with logout when the account cannot be read", async () => {
    const [loadCurrentUser, loadAiConnections] = mocks.loaders;
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadCurrentUser?.mockRejectedValue(
      new SystemError(
        SystemErrorCode.DataIntegrityError,
        "The account's email address could not be read",
      ),
    );
    loadAiConnections?.mockResolvedValue([]);

    await renderWithRouter(await SettingsFeed(), { path: "/settings" });

    expect(screen.getByRole("alert").textContent).toContain(
      "読み込めませんでした",
    );
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
    expect(screen.queryByText("メールアドレス")).toBeNull();
    expect(document.body.textContent).not.toContain("email address");
  });

  it("draws the panel when the account loads", async () => {
    const [loadCurrentUser, loadAiConnections] = mocks.loaders;
    mocks.requireUserId.mockResolvedValue(USER_ID);
    loadCurrentUser?.mockResolvedValue({
      user: {
        userId: USER_ID,
        email: "user@example.com",
        credentials: [
          {
            credentialId: "cred-email",
            kind: "email",
            label: "",
            usableForLogin: true,
          },
        ],
        trashRetentionDays: 30,
      },
      ssoProviders: [],
      mcpUrl: "http://localhost:3000/mcp",
    });
    loadAiConnections?.mockResolvedValue([]);

    await renderWithRouter(await SettingsFeed(), { path: "/settings" });

    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("user@example.com")).toBeTruthy();
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
  });

  it("lets the guard's redirect through", async () => {
    const redirectLike = { isRedirect: true } as unknown as Error;
    mocks.requireUserId.mockRejectedValue(redirectLike);
    await expect(SettingsFeed()).rejects.toBe(redirectLike);
  });
});
