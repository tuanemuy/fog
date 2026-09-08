import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import { RetentionForm } from "@/components/settings/RetentionForm";
import { AppServerError } from "@/presentation/errorResponse";

const mocks = vi.hoisted(() => ({
  changeTrashRetentionDaysFn:
    vi.fn<(input: { data: unknown }) => Promise<unknown>>(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-start")>()),
  useServerFn: (fn: unknown) => fn,
}));

vi.mock("@/components/settings/actions", () => ({
  changeTrashRetentionDaysFn: mocks.changeTrashRetentionDaysFn,
}));

afterEach(() => {
  vi.clearAllMocks();
});

function form() {
  const element = screen.getByRole("form", {
    name: "ゴミ箱の保持期限",
  }) as HTMLFormElement;
  return {
    form: element,
    input: screen.getByLabelText(
      "削除した項目を保持する日数",
    ) as HTMLInputElement,
    save: () =>
      screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement,
  };
}

describe("RetentionForm", () => {
  it("shows the current value and saves a new one, marking the change while it runs", async () => {
    let settle!: (value: unknown) => void;
    mocks.changeTrashRetentionDaysFn.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { router } = await renderWithRouter(
      <RetentionForm retentionDays={30} />,
    );
    const invalidate = vi.spyOn(router, "invalidate");
    const { form: f, input, save } = form();
    expect(input.value).toBe("30");
    expect(screen.getByText(/現在: 30 日/)).toBeTruthy();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.submit(f);
    await waitFor(() => expect(save().textContent).toBe("保存中…"));
    expect(save().disabled).toBe(true);
    expect(screen.getByText(/現在: 7 日/)).toBeTruthy();
    settle({ retentionDays: 7 });
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("保存しました"),
    );
    expect(mocks.changeTrashRetentionDaysFn).toHaveBeenCalledWith({
      data: { retentionDays: 7 },
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("refuses 0, a negative and a fraction before calling the server", async () => {
    await renderWithRouter(<RetentionForm retentionDays={30} />);
    const { form: f, input } = form();
    for (const bad of ["0", "-3", "2.5", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.submit(f);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe("1 以上の整数を入力してください");
    }
    expect(mocks.changeTrashRetentionDaysFn).not.toHaveBeenCalled();
  });

  it("names the rule on the domain's rejection and shows other failures as they come", async () => {
    mocks.changeTrashRetentionDaysFn
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "business",
          code: "INVALID_TRASH_RETENTION_DAYS",
          message: "x",
        }),
      )
      .mockRejectedValueOnce(
        new AppServerError({
          kind: "system",
          code: "DATABASE_ERROR",
          message: "x",
          retryable: true,
        }),
      );
    await renderWithRouter(<RetentionForm retentionDays={30} />);
    const { form: f, input } = form();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.submit(f);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(
        "1 以上の整数を入力してください",
      ),
    );
    fireEvent.submit(f);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("システムエラー"),
    );
    expect(input.value).toBe("5");
  });
});
