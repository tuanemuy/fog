import { describe, expect, it } from "vitest";
import {
  type AuthenticationState,
  authenticationStateUnchanged,
  judgeCanonicalRow,
} from "../transfer";

const state: AuthenticationState = {
  status: "active",
  changeState: null,
  credentialVersion: 3,
  passwordVerifier: "v",
};

describe("authenticationStateUnchanged (s4's re-read)", () => {
  it("is true for the same four columns, false for a row that is gone or any that moved", () => {
    expect(authenticationStateUnchanged(state, { ...state })).toBe(true);
    expect(authenticationStateUnchanged(state, null)).toBe(false);
    expect(
      authenticationStateUnchanged(state, { ...state, changeState: "pending" }),
    ).toBe(false);
    expect(
      authenticationStateUnchanged(state, { ...state, credentialVersion: 4 }),
    ).toBe(false);
    expect(
      authenticationStateUnchanged(state, { ...state, passwordVerifier: "w" }),
    ).toBe(false);
    expect(
      authenticationStateUnchanged(state, { ...state, status: "reserved" }),
    ).toBe(false);
  });
});

describe("judgeCanonicalRow (the five branches)", () => {
  const incoming = { userId: "u", credentialVersion: 2 };
  it.each([
    ["a", null],
    ["b", { userId: "u", credentialVersion: 3 }],
    ["c", { userId: "u", credentialVersion: 1 }],
    ["d", { userId: "u", credentialVersion: 2 }],
    ["e", { userId: "other", credentialVersion: 2 }],
  ] as const)("%s", (verdict, existing) => {
    expect(judgeCanonicalRow(existing, incoming)).toBe(verdict);
  });

  it("treats a reservation (no user yet) at the destination as another owner", () => {
    expect(
      judgeCanonicalRow({ userId: null, credentialVersion: 1 }, incoming),
    ).toBe("e");
  });
});
