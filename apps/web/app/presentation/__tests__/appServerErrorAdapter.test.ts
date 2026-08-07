import { describe, expect, it } from "vitest";
import { startInstance } from "@/start";
import { appServerErrorAdapter } from "../appServerErrorAdapter";
import {
  AppServerError,
  extractSerializedError,
  isAppServerError,
  type SerializedError,
} from "../errorResponse";

const invalidCredentials: SerializedError = {
  kind: "validation",
  code: "INVALID_CREDENTIALS",
  message: "Invalid email or password",
  retryable: false,
};

// Server functions are compiled into their own module graph while the
// serialization adapter is loaded from the SSR graph, so one process holds
// two distinct `AppServerError` classes built from this same file. The `?dup`
// query gives Vite a second module instance, which reproduces that split
// without needing the full dev server.
async function loadForeignGraph(): Promise<typeof import("../errorResponse")> {
  const specifier = "../errorResponse.ts?dup";
  return import(/* @vite-ignore */ specifier);
}

describe("appServerErrorAdapter", () => {
  it("is registered on the start instance", async () => {
    const options = await startInstance.getOptions();
    expect(options.serializationAdapters).toContain(appServerErrorAdapter);
  });

  it("carries kind and code across the roundtrip", () => {
    const error = new AppServerError(invalidCredentials);

    expect(appServerErrorAdapter.test(error)).toBe(true);
    const revived = appServerErrorAdapter.fromSerializable(
      appServerErrorAdapter.toSerializable(error),
    );

    expect(revived.serialized).toEqual(invalidCredentials);
  });

  it("matches an AppServerError thrown from another module graph", async () => {
    const foreign = await loadForeignGraph();
    expect(foreign.AppServerError).not.toBe(AppServerError);

    const error = new foreign.AppServerError(invalidCredentials);
    // biome-ignore lint/plugin: negative control — this false is the failure mode `isAppServerError` exists to replace, and the adapter silently dropping `kind` is what it caused
    expect(error instanceof AppServerError).toBe(false);
    expect(isAppServerError(error)).toBe(true);

    expect(appServerErrorAdapter.test(error)).toBe(true);
    expect(appServerErrorAdapter.toSerializable(error)).toEqual(
      invalidCredentials,
    );
  });

  it("ignores errors that carry no serialized payload", () => {
    expect(appServerErrorAdapter.test(new Error("boom"))).toBe(false);
    expect(appServerErrorAdapter.test({ name: "AppServerError" })).toBe(false);
    expect(
      appServerErrorAdapter.test({
        name: "AppServerError",
        serialized: { kind: "not-a-kind", message: "x" },
      }),
    ).toBe(false);
  });
});

describe("extractSerializedError", () => {
  it("recovers kind and code from a foreign-graph AppServerError", async () => {
    const foreign = await loadForeignGraph();
    const error = new foreign.AppServerError(invalidCredentials);

    expect(isAppServerError(error)).toBe(true);
    expect(extractSerializedError(error)).toEqual(invalidCredentials);
  });

  it("recovers kind and code when the adapter was bypassed entirely", () => {
    expect(
      extractSerializedError({ name: "Error", serialized: invalidCredentials }),
    ).toEqual(invalidCredentials);
  });

  it("falls back to unknown for a plain error", () => {
    expect(extractSerializedError(new Error("boom"))).toEqual({
      kind: "unknown",
      code: null,
      message: "boom",
    });
  });
});
