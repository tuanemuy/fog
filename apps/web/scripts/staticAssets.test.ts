import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createStaticAssets } from "./staticAssets.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it("serves browser modules with correct MIME/cache/HEAD and leaves application URLs to SSR", async () => {
  const root = await mkdtemp(join(tmpdir(), "fog-assets-"));
  roots.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "assets/app-abc.js"), "export const ready=true;");
  const serve = createStaticAssets(root);
  const response = await serve(
    new Request("http://localhost/assets/app-abc.js"),
  );
  if (!response) throw new Error("Expected a static response");
  expect(response.headers.get("content-type")).toContain("text/javascript");
  expect(response.headers.get("cache-control")).toContain("immutable");
  expect(await response.text()).toBe("export const ready=true;");
  const head = await serve(
    new Request("http://localhost/assets/app-abc.js", { method: "HEAD" }),
  );
  if (!head) throw new Error("Expected HEAD response");
  expect(await head.text()).toBe("");
  expect(head.headers.get("content-length")).toBe("24");
  expect(await serve(new Request("http://localhost/timeline"))).toBeNull();
});
it("blocks dotfiles, encoded traversal, and symlinks outside public assets", async () => {
  const root = await mkdtemp(join(tmpdir(), "fog-assets-"));
  roots.push(root);
  await mkdir(join(root, "public"));
  await writeFile(join(root, "secret"), "must-not-expose");
  await symlink(join(root, "secret"), join(root, "public/escape"));
  const serve = createStaticAssets(join(root, "public"));
  for (const url of ["/.env", "/%2e%2e%2fsecret", "/escape", "/%5csecret"]) {
    const response = await serve(new Request("http://localhost" + url));
    if (!response) throw new Error("Expected blocked response");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("must-not-expose");
  }
});
