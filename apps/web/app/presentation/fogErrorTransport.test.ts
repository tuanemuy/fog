import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { appServerErrorAdapter } from "./appServerErrorAdapter";
import {
  AppServerError,
  extractSerializedError,
  isAppServerError,
  redactForClient,
} from "./errorResponse";

const credentialError = {
  kind: "unauthorized",
  code: "INVALID_CREDENTIALS",
  message: "メールアドレスまたはパスワードが正しくありません。",
  retryable: false,
} as const;

describe("application error transport", () => {
  it("recognizes an error created by a separate SSR/RSC module graph", () => {
    const foreign: unknown = runInNewContext(
      "Object.assign(new Error(serialized.message), { name: 'AppServerError', serialized })",
      { serialized: credentialError },
    );
    expect(foreign).not.toBeInstanceOf(AppServerError);
    expect(appServerErrorAdapter.test(foreign)).toBe(true);
    if (!isAppServerError(foreign)) throw new Error("Expected envelope");
    const transported = appServerErrorAdapter.fromSerializable(
      appServerErrorAdapter.toSerializable(foreign),
    );
    expect(extractSerializedError(transported)).toEqual(credentialError);
  });

  it.each([
    { name: "Error", serialized: credentialError },
    {
      name: "AppServerError",
      serialized: { kind: "unauthorized", message: "missing code" },
    },
    {
      name: "AppServerError",
      serialized: { ...credentialError, kind: "unexpected" },
    },
    {
      name: "AppServerError",
      serialized: { ...credentialError, retryable: "true" },
    },
    {
      name: "AppServerError",
      serialized: { ...credentialError, fieldErrors: { email: "invalid" } },
    },
  ])("rejects malformed or unrelated envelopes", (error) => {
    expect(appServerErrorAdapter.test(error)).toBe(false);
  });

  it("retains redaction and does not interpret an ordinary error message as a domain failure", () => {
    const serialized = redactForClient(
      extractSerializedError(new Error("database secret")),
    );
    expect(serialized).toEqual({
      kind: "unknown",
      code: null,
      message: "System error",
    });
    expect(
      appServerErrorAdapter.toSerializable(new AppServerError(serialized)),
    ).toEqual(serialized);
  });
});
