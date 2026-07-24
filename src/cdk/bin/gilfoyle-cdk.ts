#!/usr/bin/env node
import { App } from "aws-cdk-lib";
import { EnvironmentStack } from "../lib/environment-stack.js";
import { GilfoylePlatformStack } from "../lib/platform-stack.js";
import type { EnvironmentTier } from "../lib/constructs/node-api-postgres-environment.js";

const app = new App();

// The platform stack (environment registry) is always synthesized so
// `cdk deploy GilfoylePlatformStack` works with this same entry point.
new GilfoylePlatformStack(app, "GilfoylePlatformStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION,
  },
});

// Per-environment stacks are only synthesized when the provisioner passes
// context for them (`-c projectName=... -c environmentId=... -c stackType=...`).
const projectName = app.node.tryGetContext("projectName");
const environmentId = app.node.tryGetContext("environmentId");
const stackType = app.node.tryGetContext("stackType");
const tier = app.node.tryGetContext("tier") as EnvironmentTier | undefined;

// Genuinely respected, not decorative: a region context override really
// does change where this stack deploys. The tool layer only offers regions
// that are actually bootstrapped (see provision-environment.ts) — asking
// for anything else would fail with a clear "not bootstrapped" error rather
// than silently deploying somewhere the user didn't ask for.
const region =
  app.node.tryGetContext("region") ?? process.env.CDK_DEFAULT_REGION ?? process.env.AWS_REGION;

const minCapacity = app.node.tryGetContext("minCapacity");
const maxCapacity = app.node.tryGetContext("maxCapacity");
const autoscaling =
  minCapacity && maxCapacity
    ? { minCapacity: Number(minCapacity), maxCapacity: Number(maxCapacity) }
    : undefined;

if (projectName && environmentId && stackType) {
  const stackName = `gilfoyle-${projectName}-${environmentId}`;
  new EnvironmentStack(app, stackName, {
    stackName,
    projectName,
    environmentId,
    stackType,
    tier,
    autoscaling,
    env: {
      account: process.env.CDK_DEFAULT_ACCOUNT,
      region,
    },
  });
}

app.synth();
