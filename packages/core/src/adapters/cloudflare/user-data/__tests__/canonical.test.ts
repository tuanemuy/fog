import {
  canonicalJson,
  payloadDigest,
} from "@repo/core/adapters/cloudflare/user-data/canonical";
import { describe, expect, it } from "vitest";

describe("canonical payload digest", () => {
  it("canonicalizes object keys and uses SHA-256", () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(payloadDigest("abc")).toBe(
      "sha256:6cc43f858fbb763301637b5af970e2a46b46f461f27e5a0f41e009c59b827b25",
    );
    expect(payloadDigest({ b: 2, a: 1 })).toBe(payloadDigest({ a: 1, b: 2 }));
  });
});
