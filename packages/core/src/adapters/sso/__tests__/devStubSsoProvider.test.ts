import { describe, expect, it } from "vitest";
import {
  createDevStubSsoProvider,
  decodeDevCode,
  encodeDevCode,
} from "../devStubSsoProvider";

describe("dev stub SSO provider", () => {
  it("points the authorization at the app's own consent page with the state", () => {
    const provider = createDevStubSsoProvider("http://localhost:3000");
    expect(provider.buildAuthorizationUrl("google", "st.ate")).toBe(
      "http://localhost:3000/__dev/sso/google/authorize?state=st.ate",
    );
  });

  it("exchanges the code it minted for the assertion inside it", async () => {
    const provider = createDevStubSsoProvider("http://localhost:3000");
    const code = encodeDevCode({
      providerSubject: "sub-1",
      email: "a@example.com",
    });
    expect(await provider.exchangeCode("google", code)).toEqual({
      providerSubject: "sub-1",
      email: "a@example.com",
    });
  });

  it("treats a malformed code as a cancel", async () => {
    const provider = createDevStubSsoProvider("http://localhost:3000");
    expect(await provider.exchangeCode("google", "not-base64-json")).toBe(
      "cancelled",
    );
    expect(
      decodeDevCode(encodeDevCode({ providerSubject: "  ", email: "x" })),
    ).toBeNull();
  });
});
