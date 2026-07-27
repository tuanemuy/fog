import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const zoneId = config.require("zoneId");
const appHostname = config.require("appHostname");
const requestWorkerName = config.require("requestWorkerName");

// Custom Domain binding for the primary Worker. Cloudflare resolves the
// service name eagerly — `wrangler deploy` must have run first.
new cloudflare.WorkersDomain("app", {
  accountId,
  zoneId,
  hostname: appHostname,
  service: requestWorkerName,
  environment: "production",
});

export const boundHostname = appHostname;
