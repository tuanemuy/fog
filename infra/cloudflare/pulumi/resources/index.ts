import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const accountId = config.require("accountId");
const zoneId = config.require("zoneId");
const appHostname = config.require("appHostname");
const appUrl = config.require("appUrl");
const prefix = config.require("resourcePrefix");

export const exportedAccountId = accountId;
export const exportedZoneId = zoneId;
export const exportedAppUrl = appUrl;
export const exportedAppHostname = appHostname;
export const exportedPrefix = prefix;
