import type { Database as LibsqlDatabase } from "@repo/core/adapters/libsql/client";
import { content } from "@repo/core/config";
import { describe, expect, it } from "vitest";
import { requireSessionSecret } from "../secrets";
import { createAwsRequestContainer } from "../serverAws";
import { createRequestContainer } from "../serverCloudflare";
import { createGcpRequestContainer } from "../serverGcp";
import { createNodeRequestContainer } from "../serverNode";
import type { RequestContainer } from "../types";

// `container.config` is what `loadAppContext` ships to the browser inside
// the SSR payload. Every factory builds it by rest-spreading its runtime
// config, and `satisfies AppConfig` on a variable does not run excess
// property checking — so a secret placed flat on `RequestServerConfig`
// would ride the spread out to the client with no type error anywhere.
// This suite is the permanent guard: the key set is enumerated, not
// merely checked for known offenders.
const APP_CONFIG_KEYS = [
  "appUrl",
  "defaultDescription",
  "defaultTitle",
  "siteName",
  "themeColor",
].sort();

const SESSION_SECRET = requireSessionSecret("0123456789abcdef0123456789abcdef");
const APP_URL = "http://localhost:3000";

// The factories only stash the handle on their unit-of-work provider;
// nothing in this suite touches the database.
const db = {} as LibsqlDatabase;

const containers: ReadonlyArray<readonly [string, () => RequestContainer]> = [
  [
    "cloudflare",
    () =>
      createRequestContainer({
        ...content,
        appUrl: APP_URL,
        binding: {} as never,
        secrets: { sessionSecret: SESSION_SECRET },
      }),
  ],
  [
    "node",
    () =>
      createNodeRequestContainer({
        ...content,
        appUrl: APP_URL,
        db,
        relayTrigger: { kick: () => undefined },
        secrets: { sessionSecret: SESSION_SECRET },
      }),
  ],
  [
    "aws",
    () =>
      createAwsRequestContainer({
        ...content,
        appUrl: APP_URL,
        db,
        relayTrigger: { kick: () => undefined },
        secrets: { sessionSecret: SESSION_SECRET },
      }),
  ],
  [
    "gcp",
    () =>
      createGcpRequestContainer({
        ...content,
        appUrl: APP_URL,
        db,
        relayTrigger: { kick: () => undefined },
        secrets: { sessionSecret: SESSION_SECRET },
      }),
  ],
];

describe.each(containers)("%s request container config", (_name, build) => {
  it("exposes exactly the AppConfig keys", () => {
    expect(Object.keys(build().config).sort()).toEqual(APP_CONFIG_KEYS);
  });

  it("carries no secret material anywhere in the serialized config", () => {
    expect(JSON.stringify(build().config)).not.toContain(SESSION_SECRET);
  });
});
