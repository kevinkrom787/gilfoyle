import { execa } from "execa";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnvironmentTier } from "./lib/constructs/node-api-postgres-environment.js";
import type { StackType } from "../registry/types.js";

/**
 * Thin wrapper around the `cdk` CLI. This is the ONLY module that knows how
 * provisioning actually happens — the Mastra tools call `deployStack` /
 * `destroyStack` and never shell out themselves. Swapping this for a
 * programmatic CDK toolkit (e.g. @aws-cdk/toolkit-lib) later is a
 * same-file change with no impact on the tool layer above it.
 */

const CDK_APP_DIR = process.env.GILFOYLE_CDK_APP_DIR ?? "./src/cdk";

export interface StackIdentity {
  projectName: string;
  environmentId: string;
  stackType: StackType;
  tier?: EnvironmentTier;
}

export interface DeployResult {
  stackName: string;
  outputs: Record<string, string>;
  resourceArns: string[];
}

function stackNameFor({ projectName, environmentId }: StackIdentity): string {
  return `gilfoyle-${projectName}-${environmentId}`;
}

function contextArgs(identity: StackIdentity): string[] {
  const args = [
    "-c",
    `projectName=${identity.projectName}`,
    "-c",
    `environmentId=${identity.environmentId}`,
    "-c",
    `stackType=${identity.stackType}`,
  ];
  if (identity.tier) {
    args.push("-c", `tier=${identity.tier}`);
  }
  return args;
}

export async function deployStack(identity: StackIdentity): Promise<DeployResult> {
  const stackName = stackNameFor(identity);
  const outputsFile = join(tmpdir(), `gilfoyle-outputs-${randomUUID()}.json`);

  try {
    await execa(
      "npx",
      [
        "cdk",
        "deploy",
        stackName,
        ...contextArgs(identity),
        "--require-approval",
        "never",
        "--outputs-file",
        outputsFile,
      ],
      { cwd: CDK_APP_DIR, stdio: "inherit" },
    );

    const raw = await readFile(outputsFile, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
    const stackOutputs = parsed[stackName] ?? {};

    const { ResourceArns, ...outputs } = stackOutputs;
    const resourceArns: string[] = ResourceArns ? JSON.parse(ResourceArns) : [];

    return { stackName, outputs, resourceArns };
  } finally {
    await rm(outputsFile, { force: true });
  }
}

export async function destroyStack(identity: StackIdentity): Promise<void> {
  const stackName = stackNameFor(identity);

  await execa(
    "npx",
    ["cdk", "destroy", stackName, ...contextArgs(identity), "--force"],
    { cwd: CDK_APP_DIR, stdio: "inherit" },
  );
}
