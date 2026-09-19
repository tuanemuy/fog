import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/components/__tests__/renderWithRouter";
import {
  EXPORT_DESCRIPTION,
  ExportPanel,
  UNAUTHENTICATED_MESSAGE,
} from "@/components/settings/ExportPanel";

const fetchMock =
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
const clicks: string[] = [];

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function zipResponse(filename = "fog-export-20260720.zip"): Response {
  return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06]), {
    status: 200,
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

const createObjectURL = vi.fn(() => "blob:fog/export");
const revokeObjectURL = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // jsdom has no object URLs; the real `URL` constructor must survive.
  Object.defineProperty(URL, "createObjectURL", {
    value: createObjectURL,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: revokeObjectURL,
    configurable: true,
  });
  clicks.length = 0;
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    clicks.push(`${this.download}|${this.getAttribute("href")}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
});

async function renderPanel() {
  return renderWithRouter(<ExportPanel />, { path: "/settings" });
}

describe("ExportPanel", () => {
  it("is a form that posts the browser's zone to /export and offers 「エクスポート」", async () => {
    await renderPanel();
    const form = screen.getByRole("form", { name: "データのエクスポート" });
    expect(form.getAttribute("action")).toBe("/export");
    expect(form.getAttribute("method")).toBe("post");
    const zone = form.querySelector(
      'input[name="timezone"]',
    ) as HTMLInputElement;
    expect(zone.type).toBe("hidden");
    await waitFor(() =>
      expect(zone.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone),
    );
    expect(screen.getByText(EXPORT_DESCRIPTION)).toBeTruthy();
    expect(screen.getByRole("button", { name: "エクスポート" })).toBeTruthy();
  });

  it("shows 「生成中…」 without the button while the request runs, then saves the zip once and keeps offering it as 「ダウンロード」", async () => {
    const pending = deferred<Response>();
    fetchMock.mockReturnValue(pending.promise);
    await renderPanel();
    fireEvent.submit(
      screen.getByRole("form", { name: "データのエクスポート" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("生成中…"),
    );
    expect(screen.queryByRole("button", { name: "エクスポート" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (call === undefined) throw new Error("fetch was not called");
    const [url, init] = call;
    expect(String(url)).toMatch(/\/export$/);
    if (init === undefined) throw new Error("fetch was called without init");
    expect(init.method).toBe("POST");
    expect((init.body as FormData).get("timezone")).toBeTruthy();

    pending.resolve(zipResponse());
    const download = await screen.findByRole("button", {
      name: "ダウンロード",
    });
    expect(clicks).toEqual(["fog-export-20260720.zip|blob:fog/export"]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("button", { name: "エクスポート" })).toBeNull();

    // A second save is the same Blob, not a second request.
    fireEvent.click(download);
    expect(clicks).toEqual([
      "fog-export-20260720.zip|blob:fog/export",
      "fog-export-20260720.zip|blob:fog/export",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
  });

  it("lets the Blob go when the screen does", async () => {
    fetchMock.mockResolvedValue(zipResponse());
    const { unmount } = await renderPanel();
    fireEvent.submit(
      screen.getByRole("form", { name: "データのエクスポート" }),
    );
    await screen.findByRole("button", { name: "ダウンロード" });
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:fog/export");
  });

  it("a failure stays under the row with 「リトライ」, which runs it again; the button comes back", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json(
          {
            error: {
              kind: "system",
              code: "EXPORT_TOO_LARGE",
              message: "System error",
            },
          },
          { status: 500 },
        ),
      )
      .mockResolvedValueOnce(zipResponse());
    await renderPanel();
    fireEvent.submit(
      screen.getByRole("form", { name: "データのエクスポート" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(
      "データ量が上限を超えているためエクスポートできません",
    );
    expect(within(alert).queryByRole("link")).toBeNull();
    expect(screen.getByRole("button", { name: "エクスポート" })).toBeTruthy();
    expect(clicks).toEqual([]);

    fireEvent.click(within(alert).getByRole("button", { name: "リトライ" }));
    await screen.findByRole("button", { name: "ダウンロード" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clicks).toEqual(["fog-export-20260720.zip|blob:fog/export"]);
  });

  it("a lost session says so and links to the login that returns here", async () => {
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: { kind: "validation", code: "UNAUTHENTICATED", message: "x" },
        },
        { status: 401 },
      ),
    );
    const { expectInternalHrefsToResolve } = await renderPanel();
    fireEvent.submit(
      screen.getByRole("form", { name: "データのエクスポート" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(UNAUTHENTICATED_MESSAGE);
    expect(
      within(alert)
        .getByRole("link", { name: "ログインする" })
        .getAttribute("href"),
    ).toBe("/login?redirect=%2Fsettings");
    // Running it again cannot help without a session.
    expect(
      within(alert).queryByRole("button", { name: "リトライ" }),
    ).toBeNull();
    expectInternalHrefsToResolve();
  });

  it("a network failure is the generic system wording", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await renderPanel();
    fireEvent.submit(
      screen.getByRole("form", { name: "データのエクスポート" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("システムエラーが発生しましたリトライ");
  });
});
