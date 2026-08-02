import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const zoneName = config.require("zoneName");
const appHostname = config.require("appHostname");
const appUrl = config.require("appUrl");
const prefix = config.require("resourcePrefix");

const zone = new cloudflare.Zone("zone", {
  accountId,
  zone: zoneName,
});

// Durable Object namespaces are deliberately absent. The state Worker's
// wrangler config declares its two classes through `exports`, and the deploy
// creates the namespaces — provisioning them here as well would give one
// resource two owners that disagree about its lifecycle.
export const zoneId = zone.id;
export const exportedAppUrl = appUrl;
export const exportedAppHostname = appHostname;
export const exportedPrefix = prefix;
