import type { CredentialView } from "@repo/core/application/identity/view";
import { fireEvent, screen, waitFor } from "@testing-library/react";
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

describe("CredentialList", () => {
  it("offers unlink on SSO rows only, and the link entry when asked", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <CredentialList credentials={credentials} showAddLink />,
    );
    expect(screen.getAllByRole("button", { name: /を解除$/ })).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: /SSO 連携を追加/ }).getAttribute("href"),
    ).toBe("/auth/sso/google/start?intent=link");
    expectInternalHrefsToResolve();
  });

  it("omits the link entry on P-03", async () => {
    await renderWithRouter(
      <CredentialList credentials={credentials} showAddLink={false} />,
    );
    expect(screen.queryByRole("link", { name: /SSO 連携を追加/ })).toBeNull();
  });

  it("removes the row at once, then reconciles through the router", async () => {
    let settle!: (value: unknown) => void;
    mocks.unlinkSsoCredentialFn.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { router } = await renderWithRouter(
      <CredentialList credentials={credentials} showAddLink />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    fireEvent.click(
      screen.getByRole("button", { name: "外部アカウント（google）を解除" }),
    );
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")).toHaveLength(1),
    );
    settle({ credentialId: "c-google" });
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    expect(mocks.unlinkSsoCredentialFn).toHaveBeenCalledWith({
      data: { credentialId: "c-google" },
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("puts the row back with the rule when the last login method is refused", async () => {
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
          {
            credentialId: "c-email",
            kind: "email",
            label: "",
            usableForLogin: false,
          },
          {
            credentialId: "c-google",
            kind: "sso",
            label: "google",
            usableForLogin: true,
          },
        ]}
        showAddLink
      />,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "外部アカウント（google）を解除" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("最後のログイン手段は解除できません");
    await waitFor(() =>
      expect(screen.getAllByRole("listitem")).toHaveLength(2),
    );
  });
});
