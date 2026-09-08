import { describe, expect, it } from "vitest";
import { configuredSsoProviders, type ServerEnv } from "../serverCloudflare";

const base = {
  USER_DATA: {} as DurableObjectNamespace,
  IDENTITY_DIRECTORY: {} as DurableObjectNamespace,
} satisfies Partial<ServerEnv>;

// The list a screen draws its SSO buttons and link entries from: exactly
// the providers with an adapter behind them, so no deployment offers a
// button that leads nowhere (Apple has no adapter yet).
describe("configuredSsoProviders", () => {
  it("serves every name under the dev stub", () => {
    expect(configuredSsoProviders({ ...base, SSO_DEV_STUB: "true" })).toEqual([
      "google",
      "apple",
    ]);
  });

  it("offers Google only with a complete client, and never Apple", () => {
    expect(
      configuredSsoProviders({
        ...base,
        GOOGLE_CLIENT_ID: "id",
        GOOGLE_CLIENT_SECRET: "secret",
      }),
    ).toEqual(["google"]);
    expect(configuredSsoProviders({ ...base, GOOGLE_CLIENT_ID: "id" })).toEqual(
      [],
    );
    expect(configuredSsoProviders(base)).toEqual([]);
  });
});
