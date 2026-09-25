import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WRANGLER_PLACEHOLDER_SOURCES } from "../lib/wranglerTemplate";

// These read the Pulumi programs as text, because running them needs a
// Pulumi backend and a Cloudflare account. What they see is the literal
// spelling — `new cloudflare.<Type>("<name>"`, `export const <name>`,
// `requireOutput("<name>")` / `getOutput("<name>")` — so a name passed
// through a variable, or a declaration in another file, escapes them.

const pulumiRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/cloudflare/pulumi",
);
const program = (stack: string) =>
  readFileSync(resolve(pulumiRoot, stack, "index.ts"), "utf8");

const resources = program("resources");

describe("the resources stack", () => {
  it("provisions the zone, the events queue and the DLQ, and nothing else", () => {
    const declared = [
      ...resources.matchAll(/new cloudflare\.(\w+)\(\s*"([^"]+)"/g),
    ].map(([, type, name]) => `${type}:${name}`);
    expect(declared.sort()).toEqual(["Queue:dlq", "Queue:events", "Zone:zone"]);
  });

  // An output nobody reads is a resource kept alive for nothing; an output
  // read but not exported stops the render or the routes stack.
  it("exports exactly the outputs the render and the routes stack read", () => {
    const exported = new Set(
      [...resources.matchAll(/^export const (\w+)/gm)].map(([, name]) => name),
    );
    const readByRender = Object.values(WRANGLER_PLACEHOLDER_SOURCES).flatMap(
      (source) => ("stackOutput" in source ? [source.stackOutput] : []),
    );
    const readByRoutes = [
      ...program("routes").matchAll(/\.(?:require|get)Output\("(\w+)"\)/g),
    ].map(([, name]) => name);
    expect(exported).toEqual(new Set([...readByRender, ...readByRoutes]));
  });
});
