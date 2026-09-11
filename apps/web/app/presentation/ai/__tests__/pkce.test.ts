import { describe, expect, it } from "vitest";
import { isPkceChallenge, isPkceVerifier, pkceChallengeOf } from "../pkce";

describe("PKCE", () => {
  it("S256 matches RFC 7636's appendix B vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(isPkceVerifier(verifier)).toBe(true);
    const challenge = await pkceChallengeOf(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    expect(isPkceChallenge(challenge)).toBe(true);
    expect(isPkceVerifier("too-short")).toBe(false);
    expect(isPkceChallenge("not-43-chars")).toBe(false);
  });
});
