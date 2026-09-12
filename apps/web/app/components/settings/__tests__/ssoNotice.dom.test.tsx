import type { CredentialView } from "@repo/core/application/identity/view";
import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { toastsShown, withToasts } from "@/components/__tests__/toastFrame";
import type { SsoErrorCode } from "@/components/auth/schema";
import { CredentialList } from "@/components/settings/CredentialList";
import {
  SSO_LINKED_MESSAGE,
  SsoNotice,
  ssoLinkErrorMessage,
} from "@/components/settings/SsoNotice";

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  unlinkSsoCredentialFn: vi.fn(),
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

// The route's shape: the notice around the streamed fragment that holds the
// login methods and their link entry.
const drawSettings = (
  sso: "linked" | undefined,
  ssoError: SsoErrorCode | undefined,
) =>
  renderWithRouter(
    withToasts(
      <SsoNotice sso={sso} ssoError={ssoError}>
        <CredentialList
          credentials={credentials}
          linkProviders={["google", "apple"]}
        />
      </SsoNotice>,
    ),
    { path: "/settings" },
  );

describe("SsoNotice", () => {
  it("says nothing when the callback sent neither outcome", async () => {
    await drawSettings(undefined, undefined);
    expect(screen.getByText("連携を追加")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(toastsShown()).toEqual([]);
  });

  it("raises a link that went through as a toast, with nothing on the screen", async () => {
    await drawSettings("linked", undefined);
    await waitFor(() => expect(toastsShown()).toEqual([SSO_LINKED_MESSAGE]));
    expect(SSO_LINKED_MESSAGE).toBe("外部アカウントを連携しました");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // spec/pages/index.md P-13: a subject already in use is named as such,
  // and the list does not change.
  it("draws a link that did not go through under the link entry, and leaves the list as it was", async () => {
    await drawSettings(undefined, "already_used");
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("この外部アカウントは既に使われています");
    const entry = screen.getByText("連携を追加");
    expect(
      entry.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(toastsShown()).toEqual([]);
  });

  it.each(["email_registered", "unverified", "failed"] as const)(
    "words %s as a failed link to try again",
    (code) => {
      expect(ssoLinkErrorMessage(code)).toBe(
        "外部アカウントの連携に失敗しました。もう一度お試しください",
      );
    },
  );

  it("hands no failure to a list drawn outside it (P-03)", async () => {
    await renderWithRouter(
      <CredentialList credentials={credentials} linkProviders={["google"]} />,
      { path: "/settings" },
    );
    expect(screen.getByText("連携を追加")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
