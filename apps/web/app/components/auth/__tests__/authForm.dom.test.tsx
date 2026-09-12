import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { AuthForm, classifyAuthError } from "@/components/auth/AuthForm";
import {
  AppServerError,
  type SerializedError,
} from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  loginFn:
    vi.fn<
      (input: { data: { email: string; password: string } }) => Promise<unknown>
    >(),
  registerFn:
    vi.fn<
      (input: { data: { email: string; password: string } }) => Promise<unknown>
    >(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/auth/actions", () => ({
  loginFn: mocks.loginFn,
  registerFn: mocks.registerFn,
  logoutFn: vi.fn(),
}));

const assign = vi.fn<(url: string) => void>();
const originalLocation = window.location;

beforeEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, assign },
  });
});

afterEach(() => {
  Object.defineProperty(window, "location", {
    configurable: true,
    value: originalLocation,
  });
  vi.clearAllMocks();
});

const INVALID_EMAIL: SerializedError = {
  kind: "business",
  code: "INVALID_EMAIL",
  message: "Invalid email",
};
const PASSWORD_TOO_WEAK: SerializedError = {
  kind: "business",
  code: "PASSWORD_TOO_WEAK",
  message: "Weak password",
};
const EMAIL_ALREADY_REGISTERED: SerializedError = {
  kind: "conflict",
  code: "EMAIL_ALREADY_REGISTERED",
  message: "Registered",
};
const INVALID_CREDENTIALS: SerializedError = {
  kind: "validation",
  code: "INVALID_CREDENTIALS",
  message: "Invalid credentials",
};

const EMAIL_MESSAGE = "有効なメールアドレスを入力してください";
const PASSWORD_MESSAGE = "8文字以上で入力してください";
const CREDENTIALS_MESSAGE = "メールアドレスまたはパスワードが正しくありません";
const DUPLICATE_MESSAGE = "このメールアドレスは既に登録されています。";
const PASSWORD_HELPER = "8文字以上";
const PROVIDERS = ["google", "apple"] as const;

describe("classifyAuthError", () => {
  it("attributes signup failures to their field", () => {
    expect(classifyAuthError(INVALID_EMAIL, "signup")).toEqual({
      fieldErrors: { email: EMAIL_MESSAGE },
      formError: null,
      duplicate: false,
    });
    expect(classifyAuthError(PASSWORD_TOO_WEAK, "signup")).toEqual({
      fieldErrors: { password: PASSWORD_MESSAGE },
      formError: null,
      duplicate: false,
    });
  });

  it("turns a duplicate address into a form error that offers login", () => {
    expect(classifyAuthError(EMAIL_ALREADY_REGISTERED, "signup")).toEqual({
      fieldErrors: {},
      formError: DUPLICATE_MESSAGE,
      duplicate: true,
    });
  });

  it("collapses every login failure into one form message", () => {
    for (const serialized of [
      INVALID_CREDENTIALS,
      INVALID_EMAIL,
      PASSWORD_TOO_WEAK,
      EMAIL_ALREADY_REGISTERED,
    ]) {
      const state = classifyAuthError(serialized, "login");
      expect(state.fieldErrors).toEqual({});
      expect(state.duplicate).toBe(false);
      expect(state.formError).not.toBeNull();
    }
    expect(classifyAuthError(INVALID_CREDENTIALS, "login").formError).toBe(
      CREDENTIALS_MESSAGE,
    );
  });
});

function fill(email: string, password: string) {
  fireEvent.change(screen.getByLabelText("メールアドレス"), {
    target: { value: email },
  });
  fireEvent.change(screen.getByLabelText("パスワード"), {
    target: { value: password },
  });
}

/** The form's failure is the box at its head, above the first field. */
function expectAtTheHeadOfTheForm(alert: HTMLElement) {
  const email = screen.getByLabelText("メールアドレス");
  const form = email.closest("form");
  expect(form?.firstElementChild).toBe(alert);
}

describe("AuthForm — SSO and the entries under the form", () => {
  it("offers the providers with the origin and the redirect carried, each with its glyph, and the two entries on login", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm mode="login" redirectTo="/topics" ssoProviders={PROVIDERS} />,
      { path: "/login" },
    );
    const google = screen.getByRole("link", { name: "Google で続行" });
    expect(google.getAttribute("href")).toBe(
      "/auth/sso/google/start?redirect=%2Ftopics",
    );
    expect(google.querySelector("svg[data-icon='google']")).not.toBeNull();
    const apple = screen.getByRole("link", { name: "Apple で続行" });
    expect(apple.getAttribute("href")).toBe(
      "/auth/sso/apple/start?redirect=%2Ftopics",
    );
    expect(apple.querySelector("svg[data-icon='apple']")).not.toBeNull();
    expect(screen.getByText("または")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "パスワードを忘れた" })
        .getAttribute("href"),
    ).toBe("/password-reset");
    expectInternalHrefsToResolve();
  });

  // The buttons are the configured list and nothing else: a provider with
  // no adapter (Apple in a deployment) is never offered, and no list means
  // no SSO section at all.
  it("offers only the configured providers, and nothing without any", async () => {
    const { unmount } = await renderWithRouter(
      <AuthForm
        mode="login"
        redirectTo={undefined}
        ssoProviders={["google"]}
      />,
      { path: "/login" },
    );
    expect(screen.getByRole("link", { name: "Google で続行" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Apple で続行" })).toBeNull();
    unmount();
    await renderWithRouter(
      <AuthForm mode="login" redirectTo={undefined} ssoProviders={[]} />,
      { path: "/login" },
    );
    expect(
      screen.queryByRole("navigation", { name: "外部アカウントで続行" }),
    ).toBeNull();
    expect(screen.queryByText("または")).toBeNull();
  });

  it("names a provider it has no drawing for by its name alone", async () => {
    await renderWithRouter(
      <AuthForm
        mode="login"
        redirectTo={undefined}
        ssoProviders={["github"]}
      />,
      { path: "/login" },
    );
    const link = screen.getByRole("link", { name: "github で続行" });
    expect(link.querySelector("svg")).toBeNull();
  });

  it("signup says 登録 on the providers, carries its origin so an error returns here, and has no reset entry", async () => {
    await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo={undefined}
        ssoProviders={PROVIDERS}
      />,
      {
        path: "/signup",
      },
    );
    expect(
      screen.getByRole("link", { name: "Google で登録" }).getAttribute("href"),
    ).toBe("/auth/sso/google/start?from=signup");
    expect(screen.getByRole("link", { name: "Apple で登録" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Google で続行" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "パスワードを忘れた" }),
    ).toBeNull();
  });

  it("draws a held address from the SSO callback at the head of the form, with the login entry", async () => {
    await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo={undefined}
        ssoError="email_registered"
        ssoProviders={PROVIDERS}
      />,
      { path: "/signup" },
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("既に登録されています");
    expect(within(alert).getByRole("link", { name: "ログイン" })).toBeTruthy();
    expectAtTheHeadOfTheForm(alert);
  });

  it("draws an unverified provider address as an error on login", async () => {
    await renderWithRouter(
      <AuthForm
        mode="login"
        redirectTo={undefined}
        ssoError="unverified"
        ssoProviders={PROVIDERS}
      />,
      { path: "/login" },
    );
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe(
      "外部アカウントのメールアドレスが確認されていません",
    );
    expect(within(alert).queryByRole("link")).toBeNull();
    expectAtTheHeadOfTheForm(alert);
  });

  it("replaces the SSO failure with the failure of the attempt made on the page", async () => {
    mocks.registerFn.mockRejectedValue(
      new AppServerError(EMAIL_ALREADY_REGISTERED),
    );
    await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo={undefined}
        ssoError="failed"
        ssoProviders={PROVIDERS}
      />,
      { path: "/signup" },
    );
    expect(screen.getByRole("alert").textContent).toContain(
      "外部アカウントでの認証に失敗しました",
    );
    fill("dup@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        DUPLICATE_MESSAGE,
      ),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(
      screen.queryByText(/外部アカウントでの認証に失敗しました/),
    ).toBeNull();
  });
});

describe("AuthForm", () => {
  it("signup shows the password requirement under its label and links to /login with the redirect", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo="/settings"
        ssoProviders={PROVIDERS}
      />,
      { path: "/signup" },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "アカウント登録",
    );
    const helper = screen.getByText(PASSWORD_HELPER);
    expect(
      screen.getByLabelText("パスワード").getAttribute("aria-describedby"),
    ).toBe(helper.id);
    expect(screen.getByRole("button", { name: "登録する" })).toBeTruthy();
    const link = screen.getByRole("link", { name: "ログイン" });
    const href = link.getAttribute("href") ?? "";
    const url = new URL(href, "http://harness.local");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/settings");
    expect(screen.queryByRole("link", { name: "アカウント登録" })).toBeNull();
    expectInternalHrefsToResolve();
  });

  it("login links to /signup and omits the requirement", async () => {
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm mode="login" redirectTo={undefined} ssoProviders={PROVIDERS} />,
      { path: "/login" },
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "ログイン",
    );
    expect(screen.queryByText(PASSWORD_HELPER)).toBeNull();
    expect(
      screen.getByLabelText("パスワード").getAttribute("aria-describedby"),
    ).toBeNull();
    const link = screen.getByRole("link", { name: "アカウント登録" });
    const url = new URL(
      link.getAttribute("href") ?? "",
      "http://harness.local",
    );
    expect(url.pathname).toBe("/signup");
    expect(url.searchParams.get("redirect")).toBeNull();
    expect(screen.queryByRole("link", { name: "ログイン" })).toBeNull();
    expectInternalHrefsToResolve();
  });

  it("disables the fields and the button while the attempt is in flight, and says so on the button", async () => {
    let settle!: (value: unknown) => void;
    mocks.loginFn.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    await renderWithRouter(
      <AuthForm mode="login" redirectTo="/settings" ssoProviders={[]} />,
      { path: "/login" },
    );
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    const busy = await screen.findByRole("button", { name: "ログイン中…" });
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getByLabelText("メールアドレス") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByLabelText("パスワード") as HTMLInputElement).disabled,
    ).toBe(true);
    settle({ userId: "u1" });
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/settings"));
  });

  it("login navigates to the carried target once the session is confirmed", async () => {
    mocks.loginFn.mockResolvedValue({ userId: "u1" });
    await renderWithRouter(
      <AuthForm mode="login" redirectTo="/settings" ssoProviders={PROVIDERS} />,
      {
        path: "/login",
      },
    );
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/settings"));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  // The platform answering a 500 as JSON resolves on the client; that is
  // not a session, and navigating on it would loop through the guard.
  it("treats a resolved value of the wrong shape as a system error and stays", async () => {
    mocks.registerFn.mockResolvedValue({ status: 500, unhandled: true });
    await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo={undefined}
        ssoProviders={PROVIDERS}
      />,
      {
        path: "/signup",
      },
    );
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expectAtTheHeadOfTheForm(alert);
    expect(assign).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("login draws a rejected attempt as one message at the head of the form, no field error", async () => {
    mocks.loginFn.mockRejectedValue(new AppServerError(INVALID_CREDENTIALS));
    await renderWithRouter(
      <AuthForm mode="login" redirectTo={undefined} ssoProviders={PROVIDERS} />,
      {
        path: "/login",
      },
    );
    fill("user@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "ログイン" }));

    const alerts = await screen.findAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.textContent).toBe(CREDENTIALS_MESSAGE);
    expectAtTheHeadOfTheForm(alerts[0] as HTMLElement);
    expect(mocks.loginFn).toHaveBeenCalledWith({
      data: { email: "user@example.com", password: "password1" },
    });
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(
      screen.getByLabelText("パスワード").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(within(alerts[0] as HTMLElement).queryByRole("link")).toBeNull();
  });

  it("signup draws an invalid address under the email field", async () => {
    mocks.registerFn.mockRejectedValue(new AppServerError(INVALID_EMAIL));
    await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo={undefined}
        ssoProviders={PROVIDERS}
      />,
      {
        path: "/signup",
      },
    );
    fill("bad@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(EMAIL_MESSAGE);
    const email = screen.getByLabelText("メールアドレス");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(alert.id);
    expect(
      email.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      screen.getByLabelText("パスワード").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(screen.getByText(PASSWORD_HELPER)).toBeTruthy();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("signup draws a too-weak password under the password field, keeping its requirement", async () => {
    mocks.registerFn.mockRejectedValue(new AppServerError(PASSWORD_TOO_WEAK));
    await renderWithRouter(
      <AuthForm mode="signup" redirectTo={undefined} ssoProviders={[]} />,
      { path: "/signup" },
    );
    fill("user@example.com", "short");
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(PASSWORD_MESSAGE);
    const password = screen.getByLabelText("パスワード");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(password.getAttribute("aria-describedby")).toBe(
      `${alert.id} ${screen.getByText(PASSWORD_HELPER).id}`,
    );
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("signup draws a duplicate address at the head of the form with a login link", async () => {
    mocks.registerFn.mockRejectedValue(
      new AppServerError(EMAIL_ALREADY_REGISTERED),
    );
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <AuthForm
        mode="signup"
        redirectTo="/settings"
        ssoProviders={PROVIDERS}
      />,
      { path: "/signup" },
    );
    fill("dup@example.com", "password1");
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(DUPLICATE_MESSAGE);
    expectAtTheHeadOfTheForm(alert);
    const link = within(alert).getByRole("link", { name: "ログイン" });
    const url = new URL(
      link.getAttribute("href") ?? "",
      "http://harness.local",
    );
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("redirect")).toBe("/settings");
    expect(
      screen.getByLabelText("メールアドレス").getAttribute("aria-invalid"),
    ).toBeNull();
    expectInternalHrefsToResolve();
  });
});
