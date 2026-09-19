import type { CredentialView } from "@repo/core/application/identity/view";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { CredentialList } from "@/components/settings/CredentialList";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  unlinkSsoCredentialFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  unlinkSsoCredentialFn: mocks.unlinkSsoCredentialFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

const credentials: readonly CredentialView[] = [
  { credentialId: "c-email", kind: "email", label: "", usableForLogin: true },
  {
    credentialId: "c-google",
    kind: "sso",
    label: "google",
    usableForLogin: true,
  },
];

// An SSO-only account: the email credential only holds the address's
// uniqueness, so Google is the one login method.
const ssoOnly: readonly CredentialView[] = [
  { credentialId: "c-email", kind: "email", label: "", usableForLogin: false },
  {
    credentialId: "c-google",
    kind: "sso",
    label: "google",
    usableForLogin: true,
  },
];

const rows = () =>
  within(screen.getByRole("list", { name: "ログイン手段" })).getAllByRole(
    "listitem",
  );

function row(index: number): HTMLElement {
  const found = rows()[index];
  if (found === undefined) throw new Error(`no row ${index}`);
  return found;
}

describe("CredentialList", () => {
  it("names the email row by the address, and offers unlink on SSO rows only", async () => {
    await renderWithRouter(
      <CredentialList
        credentials={credentials}
        linkProviders={[]}
        email="user@example.com"
      />,
    );
    expect(rows().map((row) => row.textContent)).toEqual([
      "user@example.comメール・パスワード",
      "Google連携を解除",
    ]);
    expect(within(row(0)).queryByRole("button")).toBeNull();
    expect(
      within(row(1)).getByRole("button", { name: "Google の連携を解除" })
        .textContent,
    ).toBe("連携を解除");
  });

  it("names the email row by its kind when no address is given", async () => {
    await renderWithRouter(
      <CredentialList credentials={credentials} linkProviders={[]} />,
    );
    expect(row(0).textContent).toBe("メールアドレスメール・パスワード");
  });

  // spec/pages/index.md P-13: the last login method cannot be unlinked, and
  // a uniqueness hold is not a login method.
  it("marks the last login method and offers no unlink on it, and lists no uniqueness hold", async () => {
    await renderWithRouter(
      <CredentialList credentials={ssoOnly} linkProviders={[]} />,
    );
    expect(rows().map((row) => row.textContent)).toEqual([
      "Google最後のログイン手段解除できません",
    ]);
    expect(screen.queryByRole("button", { name: /連携を解除/ })).toBeNull();
    expect(screen.queryByText("メール・パスワード")).toBeNull();
  });

  it("links the link entry to the provider's start with the link intent", async () => {
    await renderWithRouter(
      <CredentialList credentials={credentials} linkProviders={["google"]} />,
    );
    expect(screen.getByText("連携を追加")).toBeTruthy();
    // A bare handler of the request Worker, not a route: a plain anchor, so
    // it opens in a new tab and its address can be copied.
    const entry = screen.getByRole("link", { name: "Google で続行" });
    expect(entry.getAttribute("href")).toBe(
      "/auth/sso/google/start?intent=link",
    );
  });

  it("offers no link for a provider outside the configured list", async () => {
    await renderWithRouter(
      <CredentialList credentials={credentials} linkProviders={["google"]} />,
    );
    expect(screen.getByRole("link", { name: "Google で続行" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Apple で続行" })).toBeNull();
  });

  it("omits the link entry on P-03", async () => {
    await renderWithRouter(
      <CredentialList credentials={credentials} linkProviders={[]} />,
    );
    expect(screen.queryByText("連携を追加")).toBeNull();
    expect(screen.queryByRole("link", { name: /で続行$/ })).toBeNull();
  });

  it("removes the row at once, then reconciles through the router", async () => {
    let settle!: (value: unknown) => void;
    mocks.unlinkSsoCredentialFn.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { router } = await renderWithRouter(
      <CredentialList credentials={credentials} linkProviders={["google"]} />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      screen.getByRole("button", { name: "Google の連携を解除" }),
    );
    await waitFor(() => expect(rows()).toHaveLength(1));
    settle({ credentialId: "c-google" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(mocks.unlinkSsoCredentialFn).toHaveBeenCalledWith({
      data: { credentialId: "c-google" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts the row back with the server's refusal under it", async () => {
    mocks.unlinkSsoCredentialFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "LAST_CREDENTIAL_REMOVAL",
        message: "Cannot remove the last credential",
      }),
    );
    await renderWithRouter(
      <CredentialList
        credentials={[
          ...credentials,
          {
            credentialId: "c-apple",
            kind: "sso",
            label: "apple",
            usableForLogin: true,
          },
        ]}
        linkProviders={[]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Apple の連携を解除" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("最後のログイン手段は解除できません");
    await waitFor(() => expect(rows()).toHaveLength(3));
    expect(row(2).contains(alert)).toBe(true);
    expect(row(1).contains(alert)).toBe(false);
  });
});
