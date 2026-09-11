import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  CEILING_MESSAGE,
  RETENTION_SAVED_MESSAGE,
  RetentionForm,
  RULE_MESSAGE,
} from "@/components/settings/RetentionForm";
import { AppServerError } from "@/presentation/errorResponse";
import { toastsShown, withToasts } from "./toastFrame";

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

const drawForm = () =>
  renderWithRouter(withToasts(<RetentionForm retentionDays={30} />), {
    path: "/settings",
  });

function form() {
  const element = screen.getByRole("form", {
    name: "ゴミ箱の保持期限",
  }) as HTMLFormElement;
  return {
    form: element,
    input: screen.getByLabelText("保持期限") as HTMLInputElement,
    save: () =>
      screen.getByRole("button", { name: /保存/ }) as HTMLButtonElement,
  };
}

describe("RetentionForm", () => {
  it("shows the current value described by the note, and the wording of settings.html", async () => {
    await drawForm();
    const { input } = form();
    expect(input.value).toBe("30");
    expect(input.getAttribute("aria-describedby")).toBe(
      screen.getByText("既存のゴミ箱の項目にも適用されます").id,
    );
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(RULE_MESSAGE).toBe("1以上の日数を入力してください");
    expect(CEILING_MESSAGE).toBe("36,500日以下で入力してください");
    expect(RETENTION_SAVED_MESSAGE).toBe("保持期限を保存しました");
  });

  it("saves a new value, read-only and 「保存中…」 while it runs, then says so in a toast", async () => {
    let settle!: (value: unknown) => void;
    mocks.changeTrashRetentionDaysFn.mockReturnValue(
      new Promise((resolve) => {
        settle = resolve;
      }),
    );
    const { router } = await drawForm();
    const invalidate = vi.spyOn(router, "invalidate");
    const { form: f, input, save } = form();
    fireEvent.change(input, { target: { value: "7" } });
    fireEvent.submit(f);
    await waitFor(() => expect(save().textContent).toBe("保存中…"));
    expect(save().disabled).toBe(true);
    expect(input.readOnly).toBe(true);
    expect(toastsShown()).toEqual([]);
    settle({ retentionDays: 7 });
    // The toast is raised inside the action, so the row leaves its saving
    // state last: waiting on that waits on both.
    await waitFor(() => expect(save().textContent).toBe("保存"));
    expect(toastsShown()).toEqual([RETENTION_SAVED_MESSAGE]);
    expect(input.readOnly).toBe(false);
    expect(input.value).toBe("7");
    expect(mocks.changeTrashRetentionDaysFn).toHaveBeenCalledWith({
      data: { retentionDays: 7 },
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refuses 0, a negative and a fraction under the row before calling the server", async () => {
    await drawForm();
    const { form: f, input } = form();
    for (const bad of ["0", "-3", "2.5", ""]) {
      fireEvent.change(input, { target: { value: bad } });
      fireEvent.submit(f);
      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toBe(RULE_MESSAGE);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.getAttribute("aria-describedby")?.split(" ")[0]).toBe(
        alert.id,
      );
    }
    expect(mocks.changeTrashRetentionDaysFn).not.toHaveBeenCalled();
    expect(toastsShown()).toEqual([]);
  });

  it("keeps a rejected draft in the focused input instead of resetting it", async () => {
    await drawForm();
    const { form: f, input } = form();
    input.focus();
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.submit(f);
    await screen.findByRole("alert");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input.value).toBe("0");
  });

  it("refuses a value past the transport ceiling with its wording, and words the transport's own rejection", async () => {
    mocks.changeTrashRetentionDaysFn.mockRejectedValueOnce(
      new AppServerError({
        kind: "validation",
        code: "INVALID_INPUT",
        message: "Invalid input",
        fieldErrors: {
          retentionDays: ["Too small: expected number to be >=1"],
        },
      }),
    );
    await drawForm();
    const { form: f, input } = form();
    fireEvent.change(input, { target: { value: "36501" } });
    fireEvent.submit(f);
    expect((await screen.findByRole("alert")).textContent).toBe(
      CEILING_MESSAGE,
    );
    expect(mocks.changeTrashRetentionDaysFn).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "36500" } });
    fireEvent.submit(f);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(RULE_MESSAGE),
    );
    expect(mocks.changeTrashRetentionDaysFn).toHaveBeenCalledWith({
      data: { retentionDays: 36500 },
    });
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
    await drawForm();
    const { form: f, input } = form();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.submit(f);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toBe(RULE_MESSAGE),
    );
    fireEvent.submit(f);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("システムエラー"),
    );
    expect(input.value).toBe("5");
    expect(toastsShown()).toEqual([]);
  });
});
