import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { PasswordResetForm } from "@/components/auth/PasswordResetForm";
import {
  PasswordResetRequestForm,
  RESET_REQUESTED_MESSAGE,
} from "@/components/auth/PasswordResetRequestForm";
import { AuthSheet } from "@/components/layout/AuthSheet";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  requestPasswordResetFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
  executePasswordResetFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/auth/actions", () => ({
  requestPasswordResetFn: mocks.requestPasswordResetFn,
  executePasswordResetFn: mocks.executePasswordResetFn,
  loginFn: vi.fn(),
  registerFn: vi.fn(),
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

/** The form's failure is the box at its head, above the first field. */
function expectAtTheHeadOf(form: HTMLElement, alert: HTMLElement) {
  expect(form.firstElementChild).toBe(alert);
}

// The toast lives on the frame, so the request form is drawn in it.
const drawRequestForm = () =>
  renderWithRouter(
    <AuthSheet>
      <PasswordResetRequestForm />
    </AuthSheet>,
    { path: "/password-reset" },
  );

const requestForm = () =>
  screen.getByRole("form", { name: "パスワードリセットの依頼" });

function submitRequest(email: string) {
  fireEvent.change(screen.getByLabelText("メールアドレス"), {
    target: { value: email },
  });
  fireEvent.submit(requestForm());
}

describe("PasswordResetRequestForm", () => {
  it("says under the title that the mail goes only to an address with an account", async () => {
    await drawRequestForm();
    const title = screen.getByRole("heading", { level: 1 });
    expect(title.textContent).toBe("パスワードリセット");
    const description = screen.getByText(
      "アカウントが存在する場合、リセットリンクをお送りします",
    );
    expect(
      title.compareDocumentPosition(description) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe("");
  });

  it("posts the address and answers with the same toast on the same form, whatever the address", async () => {
    mocks.requestPasswordResetFn.mockResolvedValue({ ok: true });
    const { router } = await drawRequestForm();
    submitRequest("nobody@example.com");
    await waitFor(() =>
      expect(
        within(screen.getByRole("status")).getByText(RESET_REQUESTED_MESSAGE),
      ).toBeTruthy(),
    );
    expect(RESET_REQUESTED_MESSAGE).toBe(
      "リセットメールの送信を受け付けました",
    );
    expect(mocks.requestPasswordResetFn).toHaveBeenCalledWith({
      data: { email: "nobody@example.com" },
    });
    expect(requestForm()).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(router.state.location.search).toEqual({});
  });

  it("draws a failed request at the head of the form, and raises no toast", async () => {
    mocks.requestPasswordResetFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "SESSION_ERROR",
        message: "boom",
        retryable: false,
      }),
    );
    await drawRequestForm();
    submitRequest("user@example.com");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expectAtTheHeadOf(requestForm(), alert);
    expect(screen.getByRole("status").textContent).toBe("");
  });
});

const resetForm = () =>
  screen.getByRole("form", { name: "新しいパスワードの設定" });

function submitReset(newPassword: string) {
  fireEvent.change(screen.getByLabelText("新パスワード"), {
    target: { value: newPassword },
  });
  fireEvent.submit(resetForm());
}

describe("PasswordResetForm", () => {
  it("asks for the new password with its requirement under the label", async () => {
    await renderWithRouter(<PasswordResetForm token="1.0.secret" />, {
      path: "/password-reset",
    });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "パスワードリセット",
    );
    const field = screen.getByLabelText("新パスワード");
    expect(field.getAttribute("aria-describedby")).toBe(
      screen.getByText("8文字以上").id,
    );
    expect(field.getAttribute("aria-invalid")).toBeNull();
    expect(
      screen.getByRole("button", { name: "パスワードを更新" }),
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("posts the token with the new password and navigates to the done screen", async () => {
    mocks.executePasswordResetFn.mockResolvedValue({ userId: "u1" });
    await renderWithRouter(<PasswordResetForm token="1.0.secret" />, {
      path: "/password-reset",
    });
    submitReset("new-pass-12");
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith("/password-reset/done"),
    );
    expect(mocks.executePasswordResetFn).toHaveBeenCalledWith({
      data: { token: "1.0.secret", newPassword: "new-pass-12" },
    });
  });

  it("offers a new request at the head of the form when the link is spent or expired", async () => {
    mocks.executePasswordResetFn.mockRejectedValue(
      new AppServerError({
        kind: "validation",
        code: "RESET_TOKEN_INVALID",
        message: "no",
      }),
    );
    const { expectInternalHrefsToResolve } = await renderWithRouter(
      <PasswordResetForm token="1.0.secret" />,
      { path: "/password-reset" },
    );
    submitReset("new-pass-12");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "リセットリンクが無効か、有効期限が切れています。もう一度パスワードリセットをお試しください",
    );
    expectAtTheHeadOf(resetForm(), alert);
    expect(
      within(alert)
        .getByRole("link", { name: "パスワードリセット" })
        .getAttribute("href"),
    ).toBe("/password-reset");
    expect(
      screen.getByLabelText("新パスワード").getAttribute("aria-invalid"),
    ).toBeNull();
    expect(assign).not.toHaveBeenCalled();
    expectInternalHrefsToResolve();
  });

  it("draws any other failure at the head of the form without the new-request link", async () => {
    mocks.executePasswordResetFn.mockRejectedValue(
      new AppServerError({
        kind: "system",
        code: "SESSION_ERROR",
        message: "boom",
        retryable: false,
      }),
    );
    await renderWithRouter(<PasswordResetForm token="1.0.secret" />, {
      path: "/password-reset",
    });
    submitReset("new-pass-12");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しました");
    expectAtTheHeadOf(resetForm(), alert);
    expect(within(alert).queryByRole("link")).toBeNull();
    expect(
      screen.getByLabelText("新パスワード").getAttribute("aria-invalid"),
    ).toBeNull();
  });

  it("marks a weak password on its field and keeps the link usable", async () => {
    mocks.executePasswordResetFn.mockRejectedValue(
      new AppServerError({
        kind: "business",
        code: "PASSWORD_TOO_WEAK",
        message: "no",
      }),
    );
    await renderWithRouter(<PasswordResetForm token="1.0.secret" />, {
      path: "/password-reset",
    });
    submitReset("short");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "パスワードは8文字以上128文字以下で入力してください",
    );
    const field = screen.getByLabelText("新パスワード");
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(field.getAttribute("aria-describedby")?.split(" ")[0]).toBe(
      alert.id,
    );
    expect(resetForm().firstElementChild).not.toBe(alert);
    expect(
      screen.queryByRole("link", { name: "パスワードリセット" }),
    ).toBeNull();
  });
});
