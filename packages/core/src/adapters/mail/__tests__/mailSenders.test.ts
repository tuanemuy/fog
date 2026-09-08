import { isSystemError } from "@repo/core/application/errors";
import { describe, expect, it } from "vitest";
import { createConsoleMailSender } from "../consoleMailSender";
import { createResendMailSender, RESEND_ENDPOINT } from "../resendMailSender";
import { passwordResetUrl } from "../resetMailContent";

describe("passwordResetUrl", () => {
  it("builds the link from the configured origin only", () => {
    expect(passwordResetUrl("https://fog.example/", "1.0.abc")).toBe(
      "https://fog.example/password-reset?token=1.0.abc",
    );
  });
});

describe("console mail sender", () => {
  it("prints one line with the recipient and the reset link", async () => {
    const lines: string[] = [];
    const sender = createConsoleMailSender({
      appUrl: "http://localhost:3000",
      sink: "console",
      log: (line) => lines.push(line),
    });
    await sender.sendPasswordResetMail("to@example.com", "1.0.abc", "k");
    expect(lines).toEqual([
      "[dev-mail] to=to@example.com url=http://localhost:3000/password-reset?token=1.0.abc",
    ]);
  });

  it.each(["", "file", "mailpit", undefined])(
    "refuses any other sink value (%s) as a configuration error",
    (sink) => {
      let caught: unknown = null;
      try {
        createConsoleMailSender({ appUrl: "http://localhost", sink });
      } catch (error) {
        caught = error;
      }
      expect(isSystemError(caught)).toBe(true);
      expect((caught as { code: string }).code).toBe("CONFIGURATION_ERROR");
    },
  );
});

describe("Resend mail sender", () => {
  it("posts one mail with the provider idempotency key as Idempotency-Key", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const sender = createResendMailSender({
      apiKey: "re_test",
      fromAddress: "fog <noreply@fog.example>",
      appUrl: "https://fog.example",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init: init ?? {} });
        return new Response('{"id":"x"}', { status: 200 });
      },
    });
    await sender.sendPasswordResetMail("to@example.com", "1.0.abc", "idem-1");
    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.url).toBe(RESEND_ENDPOINT);
    const headers = new Headers(request?.init.headers);
    expect(headers.get("authorization")).toBe("Bearer re_test");
    expect(headers.get("idempotency-key")).toBe("idem-1");
    const body = JSON.parse(String(request?.init.body)) as {
      from: string;
      to: string[];
      text: string;
    };
    expect(body.from).toBe("fog <noreply@fog.example>");
    expect(body.to).toEqual(["to@example.com"]);
    expect(body.text).toContain(
      "https://fog.example/password-reset?token=1.0.abc",
    );
  });

  it("turns a non-2xx answer into SystemError(ExternalApiError)", async () => {
    const sender = createResendMailSender({
      apiKey: "re_test",
      fromAddress: "fog <noreply@fog.example>",
      appUrl: "https://fog.example",
      fetch: async () => new Response("nope", { status: 422 }),
    });
    let caught: unknown = null;
    try {
      await sender.sendPasswordResetMail("to@example.com", "1.0.abc", "k");
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("EXTERNAL_API_ERROR");
  });

  it("turns a transport failure into SystemError(NetworkError)", async () => {
    const sender = createResendMailSender({
      apiKey: "re_test",
      fromAddress: "fog <noreply@fog.example>",
      appUrl: "https://fog.example",
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    let caught: unknown = null;
    try {
      await sender.sendPasswordResetMail("to@example.com", "1.0.abc", "k");
    } catch (error) {
      caught = error;
    }
    expect(isSystemError(caught)).toBe(true);
    expect((caught as { code: string }).code).toBe("NETWORK_ERROR");
  });
});
