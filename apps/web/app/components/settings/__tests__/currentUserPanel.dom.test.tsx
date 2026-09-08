import type { CurrentUserView } from "@repo/core/application/identity/view";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { CurrentUserPanel } from "@/components/settings/CurrentUserPanel";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  changeTrashRetentionDaysFn: vi.fn(),
  changePasswordFn: vi.fn(),
  unlinkSsoCredentialFn: vi.fn(),
  revokeAiClientConnectionFn: vi.fn(),
  revokeAllAiClientConnectionsFn: vi.fn(),
}));

vi.mock("@/components/auth/actions", () => ({
  loginFn: vi.fn(),
  registerFn: vi.fn(),
  logoutFn: vi.fn(),
}));

// A verifier-looking string handed in where a careless projection could
// leak it; the panel must never draw it.
const VERIFIER_LOOKING = "pbkdf2$100000$saltsalt$hashhash";

const user: CurrentUserView = {
  userId: "01950000-0000-7000-8000-000000000001",
  email: "user@example.com",
  credentials: [
    {
      credentialId: "cred-email",
      kind: "email",
      label: `user@example.com ${VERIFIER_LOOKING}`,
      usableForLogin: true,
    },
    {
      credentialId: "cred-sso",
      kind: "sso",
      label: "google",
      usableForLogin: false,
    },
  ],
  trashRetentionDays: 30,
};

describe("CurrentUserPanel", () => {
  it("draws the address, one row per credential, retention, AI panel and logout", async () => {
    await renderWithRouter(
      <CurrentUserPanel
        user={user}
        ssoProviders={["google"]}
        aiConnections={[]}
        mcpUrl="http://localhost:3000/mcp"
      />,
    );
    expect(screen.getByText("user@example.com")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "メールアドレスログインに使用",
      "外部アカウント（google）一意性の予約のみ解除",
    ]);
    expect(
      (screen.getByLabelText("削除した項目を保持する日数") as HTMLInputElement)
        .value,
    ).toBe("30");
    // P-13 lists and revokes one connection at a time; 「すべて失効」 is P-03's.
    expect(screen.queryByRole("button", { name: "すべて失効" })).toBeNull();
    expect(screen.getByText(/接続はありません/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "アカウント",
      "ログイン手段",
      "パスワードの変更",
      "ゴミ箱の保持期限",
      "AI クライアント接続",
      "セッション",
    ]);
    // P-13 is the only entry that creates something P-03 can unlink.
    expect(
      screen.getByRole("link", { name: /SSO 連携を追加/ }).getAttribute("href"),
    ).toBe("/auth/sso/google/start?intent=link");
  });

  // S-AC-07: the password section is decided by `usableForLogin`, not by
  // the presence of an email row — an SSO-only account has one too.
  it("hides the password change for an account whose email is a uniqueness hold only", async () => {
    await renderWithRouter(
      <CurrentUserPanel
        ssoProviders={[]}
        aiConnections={[]}
        mcpUrl="http://localhost:3000/mcp"
        user={{
          ...user,
          credentials: [
            { ...user.credentials[0]!, usableForLogin: false },
            { ...user.credentials[1]!, usableForLogin: true },
          ],
        }}
      />,
    );
    expect(
      screen.queryByRole("heading", { level: 2, name: "パスワードの変更" }),
    ).toBeNull();
    expect(screen.queryByRole("form", { name: "パスワードの変更" })).toBeNull();
  });

  it("offers a link entry only for a configured provider", async () => {
    await renderWithRouter(
      <CurrentUserPanel
        user={user}
        ssoProviders={["google", "apple"]}
        aiConnections={[]}
        mcpUrl="http://localhost:3000/mcp"
      />,
    );
    expect(
      screen
        .getAllByRole("link", { name: /SSO 連携を追加/ })
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/auth/sso/google/start?intent=link",
      "/auth/sso/apple/start?intent=link",
    ]);
  });

  it("never draws a verifier-looking value or the user id", async () => {
    const { container } = await renderWithRouter(
      <CurrentUserPanel
        user={user}
        ssoProviders={["google"]}
        aiConnections={[]}
        mcpUrl="http://localhost:3000/mcp"
      />,
    );
    // Present-side check first: the email credential's label is the only
    // carrier, and the row for it is drawn — so absence below is meaningful.
    expect(
      screen.getAllByRole("listitem").map((row) => row.textContent),
    ).toContain("メールアドレスログインに使用");
    expect(container.textContent).not.toContain("pbkdf2");
    expect(container.textContent).not.toContain(VERIFIER_LOOKING);
    expect(container.innerHTML).not.toContain(VERIFIER_LOOKING);
    expect(container.textContent).not.toContain(user.userId);
  });
});
