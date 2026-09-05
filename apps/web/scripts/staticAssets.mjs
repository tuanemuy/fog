import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const types = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};
/** Serves public build artifacts only; all application URLs fall through. */
export function createStaticAssets(directory) {
  const configuredRoot = path.resolve(directory);
  return async (request) => {
    const root = await realpath(configuredRoot);
    if (request.method !== "GET" && request.method !== "HEAD") return null;
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (
      pathname.includes("\\") ||
      pathname.includes("\0") ||
      pathname.split("/").some((part) => part.startsWith("."))
    )
      return new Response("Not found", { status: 404 });
    const candidate = path.resolve(root, `.${pathname}`);
    if (!candidate.startsWith(`${root}${path.sep}`)) return null;
    try {
      const actual = await realpath(candidate);
      if (!actual.startsWith(`${root}${path.sep}`))
        return new Response("Not found", { status: 404 });
      const info = await stat(actual);
      if (!info.isFile()) return null;
      const headers = {
        "Content-Type":
          types[path.extname(actual)] ?? "application/octet-stream",
        "Content-Length": String(info.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "public, max-age=0, must-revalidate",
      };
      return new Response(
        request.method === "HEAD" ? null : await readFile(actual),
        { headers },
      );
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
      throw error;
    }
  };
}
