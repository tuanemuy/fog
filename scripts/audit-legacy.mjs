import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";

const trackedFiles = execFileSync("git", ["ls-files"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);

const failures = [];
const fail = (message) => failures.push(message);

const rootPackage = JSON.parse(readFileSync("package.json", "utf8"));
const webPackage = JSON.parse(readFileSync("apps/web/package.json", "utf8"));
for (const [owner, scripts] of [
  ["package.json", rootPackage.scripts],
  ["apps/web/package.json", webPackage.scripts],
]) {
  for (const script of [
    "build:node",
    "build:aws",
    "build:gcp",
    "test:integration:node",
  ]) {
    if (script in scripts) fail(`${owner} exposes removed script ${script}`);
  }
}

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
for (const pattern of [
  /test:integration:node/u,
  /build:(?:node|aws|gcp)/u,
  /runtime:\s*\[[^\]]*\b(?:node|aws|gcp)\b/iu,
]) {
  if (pattern.test(ci)) fail(`CI contains removed runtime: ${pattern.source}`);
}

for (const prefix of [
  "apps/web/app/server.node",
  "apps/web/app/server.aws",
  "apps/web/app/server.gcp",
  "packages/core/src/adapters/d1/",
  "packages/core/src/adapters/libsql/",
  "infra/aws/",
  "infra/gcp/",
]) {
  if (trackedFiles.some((file) => file.startsWith(prefix))) {
    fail(`removed runtime path is tracked: ${prefix}`);
  }
}

const dependencyNames = [
  ...Object.keys(rootPackage.dependencies ?? {}),
  ...Object.keys(rootPackage.devDependencies ?? {}),
  ...Object.keys(webPackage.dependencies ?? {}),
  ...Object.keys(webPackage.devDependencies ?? {}),
];
for (const name of dependencyNames) {
  if (
    /(?:^|\/)(?:libsql|aws-sdk)(?:$|\/)/iu.test(name) ||
    name.startsWith("@google-cloud/")
  ) {
    fail(`removed runtime dependency is installed: ${name}`);
  }
}

const contentAuditAllowlist = new Set([
  "spec/adr/005-search-index-via-outbox.md",
  "spec/index.md",
]);
const activeFiles = trackedFiles.filter(
  (file) =>
    (/^(?:apps|packages|infra|spec)\//u.test(file) ||
      file === ".github/workflows/ci.yml") &&
    !file.includes("/review/") &&
    !file.includes("/__tests__/") &&
    !file.endsWith(".test.ts") &&
    !file.endsWith("worker-configuration.d.ts") &&
    !contentAuditAllowlist.has(file),
);
const forbiddenArchitecture =
  /\b(?:libsql|vectorize|embedding|rrf|hybrid|pendingbatch|_occ_guard)\b|transport\s+outbox|outbox\s+consumer|cloudflare\s+d1/iu;
for (const file of activeFiles) {
  if (forbiddenArchitecture.test(readFileSync(file, "utf8"))) {
    fail(`active path contains a removed architecture term: ${file}`);
  }
}

const productionFiles = trackedFiles.filter(
  (file) =>
    file === "apps/web/app/server.cloudflare.ts" ||
    file === "apps/web/app/server.state.ts" ||
    /^apps\/web\/wrangler\.(?:request|state)(?:\.(?:staging|production))?\.toml(?:\.tpl)?$/u.test(
      file,
    ),
);
if (trackedFiles.some((file) => file.startsWith("apps/web/dist/"))) {
  fail("generated apps/web/dist artifact must not be tracked");
}
const productionInputs = productionFiles
  .map((file) => `${file}\n${readFileSync(file, "utf8")}`)
  .join("\n");
function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}
const builtArtifactInputs = existsSync("apps/web/dist/server")
  ? filesBelow("apps/web/dist/server")
      .filter((file) => statSync(file).isFile())
      .map((file) => readFileSync(file, "utf8"))
      .join("\n")
  : "";
for (const localOnly of [
  "lifecycle.integration.worker",
  "wrangler.lifecycle.toml",
  "/__local/lifecycle",
]) {
  if (
    productionInputs.includes(localOnly) ||
    builtArtifactInputs.includes(localOnly)
  ) {
    fail(`local-only lifecycle tooling leaked into production inputs: ${localOnly}`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    `legacy audit passed (${activeFiles.length} active files, production artifact inputs clean)`,
  );
}
