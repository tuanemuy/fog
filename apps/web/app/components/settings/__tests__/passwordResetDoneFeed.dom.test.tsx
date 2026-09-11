import type {
  AiClientConnectionView,
  CredentialView,
} from "@repo/core/application/identity/view";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AuthSheet } from "@/components/layout/AuthSheet";
import { PasswordResetDoneFeed } from "@/components/settings/PasswordResetDoneFeed";
import { PasswordResetDoneSkeleton } from "@/components/settings/PasswordResetDoneFeed/skeleton";

const mocks = vi.hoisted(() => ({
  requireUserId: vi.fn<() => Promise<string>>(),
  loaders: [] as Array<ReturnType<typeof vi.fn>>,
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  unlinkSsoCredentialFn: vi.fn(),
  revokeAiClientConnectionFn: vi.fn(),
  revokeAllAiClientConnectionsFn: vi.fn(),
}));

vi.mock("@/presentation/currentUser", () => ({
  requireUserId: mocks.requireUserId,
}));

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

const credentials: readonly CredentialView[] = [
  { credentialId: "c-email", kind: "email", label: "", usableForLogin: true },
  {
    credentialId: "c-google",
    kind: "sso",
    label: "google",
    usableForLogin: true,
  },
];

const connections: readonly AiClientConnectionView[] = [
  {
    connectionId: "conn-1",
    clientName: "Claude Desktop",
    status: "active",
    connectedAt: new Date("2025-12-15T09:00:00.000Z"),
    lastUsedAt: null,
    revokedAt: null,
  },
];

async function drawFeed(
  aiConnections: readonly AiClientConnectionView[] = connections,
) {
  const [loadCurrentUser, loadAiConnections] = mocks.loaders;
  mocks.requireUserId.mockResolvedValue(USER_ID);
  loadCurrentUser?.mockResolvedValue({
    user: {
      userId: USER_ID,
      email: "user@example.com",
      credentials,
      trashRetentionDays: 30,
    },
    mcpUrl: "http://localhost:3000/mcp",
  });
  loadAiConnections?.mockResolvedValue(aiConnections);
  // Drawn in its frame, whose toasts the lists may raise their successes on.
  const feed = await PasswordResetDoneFeed();
  return renderWithRouter(<AuthSheet>{feed}</AuthSheet>, {
    path: "/password-reset/done",
  });
}

const labels = (root: HTMLElement) =>
  within(root)
    .getAllByRole("heading", { level: 2, hidden: true })
    .map((heading) => heading.textContent);

describe("PasswordResetDoneFeed", () => {
  it("puts the login methods and the AI connections under their labels, and the way on to the timeline after them", async () => {
    const { container, expectInternalHrefsToResolve } = await drawFeed();
    expect(labels(container)).toEqual(["ログイン手段", "AI"]);
    const methods = screen.getByRole("region", { name: "ログイン手段" });
    // The email method is named by the address the account holds (P-13).
    expect(within(methods).getByText("user@example.com")).toBeTruthy();
    expect(
      within(methods).getByRole("button", { name: "Google の連携を解除" }),
    ).toBeTruthy();
    const ai = screen.getByRole("region", { name: "AI" });
    expect(within(ai).getByText("Claude Desktop")).toBeTruthy();
    expect(within(ai).getByRole("button", { name: "すべて失効" })).toBeTruthy();
    const onward = screen.getByRole("link", { name: "タイムラインへ進む" });
    expect(onward.getAttribute("href")).toBe("/");
    expect(
      ai.compareDocumentPosition(onward) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expectInternalHrefsToResolve();
  });

  it("leaves out the revoke-all row when there is no connection to revoke", async () => {
    await drawFeed([]);
    const ai = screen.getByRole("region", { name: "AI" });
    expect(within(ai).queryByRole("button", { name: "すべて失効" })).toBeNull();
  });

  // The screen removes what the user does not recognise; it never adds.
  it("offers no way to link another account, and no notice of its own", async () => {
    const { container } = await drawFeed();
    const hrefs = [...container.querySelectorAll("a[href]")].map(
      (anchor) => anchor.getAttribute("href") ?? "",
    );
    expect(hrefs).toContain("/");
    expect(hrefs.filter((href) => href.includes("intent=link"))).toEqual([]);
    expect(screen.queryByText(/セッションはすべて終了/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("PasswordResetDoneSkeleton", () => {
  it("is one busy region with one loading label, the stand-ins hidden and the button out of reach", () => {
    render(<PasswordResetDoneSkeleton />);
    const region = screen.getByRole("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(within(region).getByText("読み込み中")).toBeTruthy();
    expect(within(region).queryByRole("heading")).toBeNull();
    expect(within(region).queryByRole("button")).toBeNull();
    const onward = within(region).getByRole("button", {
      name: "タイムラインへ進む",
      hidden: true,
    }) as HTMLButtonElement;
    expect(onward.disabled).toBe(true);
  });

  it("draws the feed's blocks under the same labels, so the swap moves nothing", async () => {
    const { container: skeleton } = render(<PasswordResetDoneSkeleton />);
    const skeletonLabels = labels(skeleton);
    const { container: feed } = await drawFeed();
    expect(skeletonLabels).toEqual(labels(feed));
  });
});
