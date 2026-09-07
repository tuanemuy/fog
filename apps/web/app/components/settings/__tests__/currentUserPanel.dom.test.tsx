import type { CurrentUserView } from "@repo/core/application/identity/view";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CurrentUserPanel } from "@/components/settings/CurrentUserPanel";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
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
  it("draws the address, one row per credential, retention, AI placeholder and logout", () => {
    render(<CurrentUserPanel user={user} />);
    expect(screen.getByText("user@example.com")).toBeTruthy();
    const rows = screen.getAllByRole("listitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      "メールアドレスログインに使用",
      "外部アカウント（google）一意性の予約のみ",
    ]);
    expect(screen.getByText("30 日")).toBeTruthy();
    expect(screen.getByText(/接続はまだありません。/).textContent).toContain(
      "AI クライアントからの接続は今後の更新で有効になります。",
    );
    expect(screen.getByRole("button", { name: "ログアウト" })).toBeTruthy();
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    ).toEqual([
      "アカウント",
      "ログイン手段",
      "ゴミ箱の保持期限",
      "AI クライアント接続",
      "セッション",
    ]);
  });

  it("never draws a verifier-looking value or the user id", () => {
    const { container } = render(<CurrentUserPanel user={user} />);
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
