import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TOAST_DURATION_MS,
  ToastProvider,
  ToastRegion,
  useToast,
} from "@/components/ui/Toast";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// A screen that raises a toast and can be taken off the frame, as a leaf is
// when its own action removes it (a restored trash row, a deleted memo).
function Screen() {
  const toast = useToast();
  const [shown, setShown] = useState(true);
  return shown ? (
    <div>
      <button type="button" onClick={() => toast("メモを削除しました")}>
        削除
      </button>
      <button type="button" onClick={() => toast("復元しました")}>
        復元
      </button>
      <button
        type="button"
        onClick={() => {
          toast("メモを削除しました");
          setShown(false);
        }}
      >
        削除して閉じる
      </button>
    </div>
  ) : null;
}

// The frame's half: the provider around the screen and one region.
const drawFrame = () =>
  render(
    <ToastProvider>
      <Screen />
      <ToastRegion />
    </ToastProvider>,
  );

const region = () => screen.getByRole("status");
const toastsShown = () =>
  [...region().children].map((toast) => toast.textContent);

describe("Toast", () => {
  it("keeps an empty live region mounted before the first toast", () => {
    drawFrame();
    expect(region().getAttribute("aria-live")).toBe("polite");
    expect(toastsShown()).toEqual([]);
  });

  it("shows the sentence in the region with nothing to press, and removes it after the duration", () => {
    drawFrame();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(toastsShown()).toEqual(["メモを削除しました"]);
    const toast = within(region()).getByText("メモを削除しました");
    expect(within(toast).queryAllByRole("button")).toEqual([]);
    expect(within(toast).queryAllByRole("link")).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS - 1);
    });
    expect(toastsShown()).toEqual(["メモを削除しました"]);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(toastsShown()).toEqual([]);
  });

  it("outlives the screen that raised it", () => {
    drawFrame();
    fireEvent.click(screen.getByRole("button", { name: "削除して閉じる" }));
    expect(screen.queryByRole("button", { name: "削除" })).toBeNull();
    expect(toastsShown()).toEqual(["メモを削除しました"]);
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS);
    });
    expect(toastsShown()).toEqual([]);
  });

  it("stacks different sentences and replaces a repeated one, restarting its time", () => {
    drawFrame();
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS / 2);
    });
    fireEvent.click(screen.getByRole("button", { name: "復元" }));
    fireEvent.click(screen.getByRole("button", { name: "削除" }));
    expect(toastsShown()).toEqual(["復元しました", "メモを削除しました"]);

    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS / 2);
    });
    expect(toastsShown()).toEqual(["復元しました", "メモを削除しました"]);
    act(() => {
      vi.advanceTimersByTime(TOAST_DURATION_MS / 2);
    });
    expect(toastsShown()).toEqual([]);
  });

  it("cannot be raised from a screen drawn without its frame", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Screen />)).toThrow(/ToastProvider/);
    expect(() => render(<ToastRegion />)).toThrow(/ToastProvider/);
    quiet.mockRestore();
  });
});
