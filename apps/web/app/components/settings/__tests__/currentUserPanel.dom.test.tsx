import type {
  CredentialView,
  CurrentUserView,
} from "@repo/core/application/identity/view";
import { screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { CurrentUserPanel } from "@/components/settings/CurrentUserPanel";
import { withToasts } from "./toastFrame";

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

const emailCredential: CredentialView = {
  credentialId: "cred-email",
  kind: "email",
  label: `user@example.com ${VERIFIER_LOOKING}`,
  usableForLogin: true,
};

const ssoCredential: CredentialView = {
  credentialId: "cred-sso",
  kind: "sso",
  label: "google",
  usableForLogin: true,
};

const user: CurrentUserView = {
  userId: "01950000-0000-7000-8000-000000000001",
  email: "user@example.com",
  credentials: [emailCredential, ssoCredential],
  trashRetentionDays: 30,
};

function drawPanel(
  overrides: Partial<{
    user: CurrentUserView;
    ssoProviders: readonly string[];
  }> = {},
) {
  return renderWithRouter(
    withToasts(
      <CurrentUserPanel
        user={overrides.user ?? user}
        ssoProviders={overrides.ssoProviders ?? ["google"]}
        aiConnections={[]}
        mcpUrl="http://localhost:3000/mcp"
      />,
    ),
    { path: "/settings" },
  );
}

const rowTexts = (list: HTMLElement) =>
  within(list)
    .getAllByRole("listitem")
    .map((row) => row.textContent);

describe("CurrentUserPanel", () => {
  it("draws settings.html's five sections in its order, each a region named by its label", async () => {
    await drawPanel();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual(["AI", "ログイン手段", "ゴミ箱", "データ", "アカウント"]);
    for (const name of [
      "AI",
      "ログイン手段",
      "ゴミ箱",
      "データ",
      "アカウント",
    ]) {
      expect(screen.getByRole("region", { name })).toBeTruthy();
    }
  });

  it("draws the address on the email row, the retention, the AI empty state, the export and logout", async () => {
    await drawPanel();
    expect(
      rowTexts(screen.getByRole("list", { name: "ログイン手段" })),
    ).toEqual(["user@example.com" + "メール・パスワード", "Google連携を解除"]);
    expect((screen.getByLabelText("保持期限") as HTMLInputElement).value).toBe(
      "30",
    );
    // P-13 lists and revokes one connection at a time; 「すべて失効」 is P-03's.
    expect(screen.queryByRole("button", { name: "すべて失効" })).toBeNull();
    expect(screen.getByText(/接続しているAIはありません/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "エクスポート" })).toBeTruthy();
    const account = screen.getByRole("region", { name: "アカウント" });
    expect(
      within(account).getByRole("form", { name: "パスワード変更" }),
    ).toBeTruthy();
    expect(
      within(account).getByRole("button", { name: "ログアウト" }),
    ).toBeTruthy();
  });

  it("offers the reset beside the password change", async () => {
    const { expectInternalHrefsToResolve } = await drawPanel();
    const form = screen.getByRole("form", { name: "パスワード変更" });
    expect(
      within(form)
        .getByRole("link", { name: "パスワードを忘れた" })
        .getAttribute("href"),
    ).toBe("/password-reset");
    expectInternalHrefsToResolve();
  });

  // S-AC-07: the password section is decided by `usableForLogin`, not by
  // the presence of an email row — an SSO-only account has one too. The
  // reset link goes with it (spec/pages/index.md P-13).
  it("hides the password change and the reset for an account whose email is a uniqueness hold only", async () => {
    await drawPanel({
      ssoProviders: [],
      user: {
        ...user,
        credentials: [
          { ...emailCredential, usableForLogin: false },
          ssoCredential,
        ],
      },
    });
    const account = screen.getByRole("region", { name: "アカウント" });
    expect(
      within(account).getByRole("button", { name: "ログアウト" }),
    ).toBeTruthy();
    expect(screen.queryByRole("form", { name: "パスワード変更" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "パスワードを忘れた" }),
    ).toBeNull();
    expect(screen.queryByLabelText("現在のパスワード")).toBeNull();
  });

  it("offers a link entry only for a configured provider", async () => {
    await drawPanel({ ssoProviders: ["google", "apple"] });
    expect(
      screen
        .getAllByRole("button", { name: /で続行$/ })
        .map((button) => button.textContent),
    ).toEqual(["Google で続行", "Apple で続行"]);
  });

  it("never draws a verifier-looking value or the user id", async () => {
    const { container } = await drawPanel();
    // Present-side check first: the email credential's label is the only
    // carrier, and the row for it is drawn — so absence below is meaningful.
    expect(
      rowTexts(screen.getByRole("list", { name: "ログイン手段" })),
    ).toContain("user@example.com" + "メール・パスワード");
    expect(container.textContent).not.toContain("pbkdf2");
    expect(container.textContent).not.toContain(VERIFIER_LOOKING);
    expect(container.innerHTML).not.toContain(VERIFIER_LOOKING);
    expect(container.textContent).not.toContain(user.userId);
  });
});
