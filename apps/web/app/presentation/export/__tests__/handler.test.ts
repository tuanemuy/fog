import { trippingExportGateway } from "@repo/core/application/__tests__/fakes";
import type { RequestContainer } from "@repo/core/application/di/types";
import { SystemError, SystemErrorCode } from "@repo/core/application/errors";
import type { ExportSourceDto } from "@repo/core/application/export/gateway";
import {
  makeContainer,
  recordingGateway,
} from "@repo/core/application/identity/__tests__/unitContainer";
import type { SessionCodec } from "@repo/core/application/ports/sessionCodec";
import { describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@/presentation/sessionCookie";
import { handleExport } from "../handler";

const APP_URL = "http://localhost:3000";
const USER = "01950000-0000-7000-8000-000000000001";
const NOW = new Date("2026-07-20T00:30:00Z");

const snapshot: ExportSourceDto = {
  memos: [
    {
      memoId: "01M",
      content: "メモ",
      postedAt: Date.UTC(2026, 6, 1, 0, 12),
      updatedAt: Date.UTC(2026, 6, 1, 0, 12),
    },
  ],
  topics: [],
  documents: [],
};

const sessionCodec: SessionCodec = {
  async issue() {
    throw new Error("not issued here");
  },
  async verify(token) {
    return token === "good" ? { userId: USER, sessionEpoch: 1 } : null;
  },
};

function container(
  readExportSource: (userId: string) => Promise<ExportSourceDto> = async () =>
    snapshot,
): RequestContainer {
  const base = makeContainer(
    recordingGateway([], {
      readAccountState: async () => ({
        status: "active",
        sessionEpoch: 1,
        resetVersion: 0,
      }),
    }),
    {
      clock: { now: () => NOW },
      exportGateway: trippingExportGateway(
        (name) => {
          throw new Error(`unexpected export gateway call: ${name}`);
        },
        { readExportSource },
      ),
    },
  );
  return { ...base, sessionCodec } as RequestContainer;
}

function post(
  body: Record<string, string> | null,
  headers: Record<string, string> = {},
  method = "POST",
): Request {
  const form = new FormData();
  for (const [k, v] of Object.entries(body ?? {})) form.set(k, v);
  return new Request(`${APP_URL}/export`, {
    method,
    headers: { cookie: `${SESSION_COOKIE_NAME}=good`, ...headers },
    ...(method === "POST" ? { body: form } : {}),
  });
}

const deps = (c = container()) => ({ container: c, appUrl: APP_URL });

describe("POST /export", () => {
  it("answers the zip as an attachment named after the day, uncached", async () => {
    const response = await handleExport(
      post({ timezone: "Asia/Tokyo" }, { origin: APP_URL }),
      deps(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="fog-export-20260720.zip"',
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.headers.get("content-length")).toBe(String(bytes.length));
    // A zip's local file header; the archive's contents are the usecase's tests.
    expect([...bytes.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(new TextDecoder().decode(bytes)).toContain(
      "fog-export-20260720/memos/2026-07-01.md",
    );
  });

  it("refuses other methods, other origins, and a request without a session", async () => {
    expect((await handleExport(post(null, {}, "GET"), deps())).status).toBe(
      405,
    );
    expect(
      (
        await handleExport(
          post({ timezone: "UTC" }, { origin: "https://evil.example" }),
          deps(),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleExport(
          post({ timezone: "UTC" }, { "sec-fetch-site": "cross-site" }),
          deps(),
        )
      ).status,
    ).toBe(403);
    const anonymous = await handleExport(
      new Request(`${APP_URL}/export`, {
        method: "POST",
        headers: { origin: APP_URL },
        body: new FormData(),
      }),
      deps(),
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      error: { code: "UNAUTHENTICATED" },
    });
  });

  it("a missing zone is 400 before the object is asked; an unknown one is the usecase's 422", async () => {
    let calls = 0;
    const c = container(async () => {
      calls++;
      return snapshot;
    });
    const missing = await handleExport(post({}, { origin: APP_URL }), deps(c));
    expect(missing.status).toBe(400);
    expect(calls).toBe(0);
    const unknown = await handleExport(
      post({ timezone: "Nowhere/City" }, { origin: APP_URL }),
      deps(c),
    );
    expect(unknown.status).toBe(422);
    expect(await unknown.json()).toMatchObject({
      error: { kind: "business", code: "INVALID_TIMEZONE" },
    });
    expect(calls).toBe(0);
  });

  it("an export over the cap keeps its code through the redaction; other system failures do not", async () => {
    const tooLarge = await handleExport(
      post({ timezone: "UTC" }, { origin: APP_URL }),
      deps(
        container(async () => {
          throw new SystemError(
            SystemErrorCode.ExportTooLarge,
            "The export exceeds the size limit",
          );
        }),
      ),
    );
    expect(tooLarge.status).toBe(500);
    expect(await tooLarge.json()).toEqual({
      error: {
        kind: "system",
        code: "EXPORT_TOO_LARGE",
        message: "System error",
      },
    });
    const broken = await handleExport(
      post({ timezone: "UTC" }, { origin: APP_URL }),
      deps(
        container(async () => {
          throw new SystemError(
            SystemErrorCode.DatabaseError,
            "SQLITE_BUSY on memos",
          );
        }),
      ),
    );
    expect(await broken.json()).toEqual({
      error: { kind: "system", code: null, message: "System error" },
    });
  });
});
