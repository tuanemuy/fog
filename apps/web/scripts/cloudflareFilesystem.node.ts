import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const webRoot = path.resolve(import.meta.dirname, "..");
export const generatedRoot = path.join(webRoot, ".cloudflare", "generated");
export const buildRoot = path.join(webRoot, "dist-cloudflare");

export async function assertSafeWorkspacePath(
  targetInput: string,
  options: { requireFile?: boolean } = {},
): Promise<string> {
  const target = path.resolve(targetInput);
  const relative = path.relative(webRoot, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Cloudflare path must remain inside apps/web");
  const trustedRoot = await realpath(webRoot);
  const segments = relative.split(path.sep);
  let current = webRoot;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let metadata: Stats;
    try {
      metadata = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
      throw error;
    }
    if (metadata.isSymbolicLink())
      throw new Error("Cloudflare paths must not contain symbolic links");
    if (index < segments.length - 1 && !metadata.isDirectory())
      throw new Error("Cloudflare path parent must be a directory");
    if (
      index === segments.length - 1 &&
      metadata.isFile() &&
      metadata.nlink > 1
    )
      throw new Error("Cloudflare files must not be hard linked");
    const resolved = await realpath(current);
    const resolvedRelative = path.relative(trustedRoot, resolved);
    if (resolvedRelative.startsWith("..") || path.isAbsolute(resolvedRelative))
      throw new Error("Cloudflare path resolves outside apps/web");
  }
  if (options.requireFile) {
    const metadata = await lstat(target);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink > 1)
      throw new Error("Cloudflare input must be a regular unlinked file");
  }
  return target;
}

export async function readSafeFile(target: string): Promise<string> {
  return readFile(
    await assertSafeWorkspacePath(target, { requireFile: true }),
    "utf8",
  );
}

export async function atomicWriteSafeFile(
  targetInput: string,
  contents: string,
): Promise<void> {
  const target = await assertSafeWorkspacePath(targetInput);
  const parent = path.dirname(target);
  await mkdir(parent, { recursive: true });
  await assertSafeWorkspacePath(parent);
  const temporaryDirectory = await mkdtemp(path.join(parent, ".fog-write-"));
  const temporary = path.join(temporaryDirectory, path.basename(target));
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await assertSafeWorkspacePath(target);
    await rename(temporary, target);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
