import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WRANGLER_PLACEHOLDER_SOURCES } from "../lib/wranglerTemplate";

// These read the Pulumi programs as text, because running them needs a
// Pulumi backend and a Cloudflare account. They see only these spellings:
// `new cloudflare.<Type>(<first argument>` in `resources/index.ts`, whose
// imports they pin to the two Pulumi packages; `export const <name>`; and
// the argument of `requireOutput(...)` / `getOutput(...)` in
// `routes/index.ts`. Anything spelled otherwise — an output exported in
// another form, a resource reached through `require` or a dynamic
// `import()` — escapes them.

const pulumiRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../infra/cloudflare/pulumi",
);
const program = (stack: string) =>
  readFileSync(resolve(pulumiRoot, stack, "index.ts"), "utf8");

const resources = program("resources");
const quoted = (name: string) => `"${name}"`;

describe("the resources stack", () => {
  it("imports the Cloudflare provider under one name and nothing but Pulumi", () => {
    expect(resources.match(/^import .*$/gm)).toEqual([
      'import * as cloudflare from "@pulumi/cloudflare";',
      'import * as pulumi from "@pulumi/pulumi";',
    ]);
  });

  it("provisions the zone, the events queue and the DLQ, and nothing else", () => {
    const declared = [
      ...resources.matchAll(/new cloudflare\.(\w+)\(\s*([^,)]+)/g),
    ].map(
      ([, type, firstArgument]) => `${type}(${String(firstArgument).trim()})`,
    );
    expect(declared.sort()).toEqual([
      'Queue("dlq")',
      'Queue("events")',
      'Zone("zone")',
    ]);
  });

  // An output nobody reads is a resource kept alive for nothing; an output
  // read but not exported stops the render or the routes stack.
  it("exports exactly the outputs the render and the routes stack read", () => {
    const exported = [...resources.matchAll(/^export const (\w+)/gm)].map(
      ([, name]) => quoted(String(name)),
    );
    const readByRender = Object.values(WRANGLER_PLACEHOLDER_SOURCES)
      .filter((source) => source.from === "stackOutput")
      .map((source) => quoted(source.name));
    const readByRoutes = [
      ...program("routes").matchAll(/\.(?:require|get)Output\(([^)]*)\)/g),
    ].map(([, argument]) => String(argument).trim());
    expect(new Set(exported)).toEqual(
      new Set([...readByRender, ...readByRoutes]),
    );
  });
});
