import { content } from "@repo/core/config";
import { describe, expect, it } from "vitest";
import type { ServiceArgs } from "../../types";
import {
  requireAiClientTokenSecret,
  requireDirectoryRoutingKeyring,
  requireSessionSecret,
} from "../secrets";
import { createRequestContainer } from "../serverCloudflare";
import type { RequestContainer } from "../types";

// `container.config` is what `loadAppContext` ships to the browser inside
// the SSR payload. The factory builds it by rest-spreading its runtime
// config, and `satisfies AppConfig` on a variable does not run excess
// property checking — so a secret placed flat on `RequestServerConfig`
// would ride the spread out to the client with no type error anywhere.
// This suite is the permanent guard: the key set is enumerated, not
// merely checked for known offenders. The table keeps its shape even
// though there is a single composition root today, so a second one is a
// one-row addition rather than a rewrite.
const APP_CONFIG_KEYS = [
  "appUrl",
  "defaultDescription",
  "defaultTitle",
  "siteName",
  "themeColor",
].sort();

const SESSION_SECRET = requireSessionSecret("0123456789abcdef0123456789abcdef");
const AI_CLIENT_TOKEN_SECRET = requireAiClientTokenSecret(
  "ai-client-0123456789abcdef0123456789abcdef",
);
const ROUTING_KEY = "routing-0123456789abcdef0123456789abcdef";
const DIRECTORY_ROUTING_KEYRING = requireDirectoryRoutingKeyring(
  JSON.stringify([{ generation: 1, key: ROUTING_KEY, bucketCount: 256 }]),
);
const APP_URL = "http://localhost:3000";

// Every one of the three has to be walked, not just the session secret: the
// guard is about the *shape* of the config, so a new secret added flat would
// otherwise slip through while the old assertion still passed.
const SECRET_VALUES = [SESSION_SECRET, AI_CLIENT_TOKEN_SECRET, ROUTING_KEY];

const containers: ReadonlyArray<readonly [string, () => RequestContainer]> = [
  [
    "cloudflare",
    () =>
      createRequestContainer({
        ...content,
        appUrl: APP_URL,
        bindings: {
          userData: {} as never,
          identityDirectory: {} as never,
        },
        secrets: {
          sessionSecret: SESSION_SECRET,
          aiClientTokenSecret: AI_CLIENT_TOKEN_SECRET,
          directoryRoutingKeyring: DIRECTORY_ROUTING_KEYRING,
        },
      }),
  ],
];

describe.each(containers)("%s request container config", (_name, build) => {
  it("exposes exactly the AppConfig keys", () => {
    expect(Object.keys(build().config).sort()).toEqual(APP_CONFIG_KEYS);
  });

  it.each(SECRET_VALUES)(
    "carries no secret material anywhere in the serialized config",
    (secret) => {
      expect(JSON.stringify(build().config)).not.toContain(secret);
    },
  );
});

describe("what a usecase receives", () => {
  // Nothing else would fail if `UsecaseContainer` stopped omitting
  // `sessionCodec`, or if `ServiceArgs.container` were widened back to
  // `RequestContainer`. The directive below is the whole assertion, and it
  // is written against the argument a usecase actually takes so that both
  // of those regressions make the codec reachable, leave the directive
  // with nothing to suppress, and fail the type check. The runtime object
  // still carries the codec, so this is the type boundary only — a
  // deliberate `as RequestContainer` still gets through.
  it("cannot reach the session codec", () => {
    // @ts-expect-error usecases must not be able to reach the session codec
    const reach = (args: ServiceArgs<unknown>) => args.container.sessionCodec;
    void reach;
  });
});
