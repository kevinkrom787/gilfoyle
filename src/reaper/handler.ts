import { CloudFormationClient, DeleteStackCommand } from "@aws-sdk/client-cloudformation";
import { stackNameFor } from "../cdk/stack-name.js";
import * as registry from "../registry/client.js";

/**
 * Scheduled Lambda (EventBridge rate rule, see cdk/lib/platform-stack.ts).
 * Runs independently of the Slack bot process — this is what makes TTL
 * enforcement actually reliable ("gilfoyle should never stay running") even
 * if the laptop running `npm run dev` is closed or the bot has crashed.
 *
 * Deliberately calls CloudFormation's DeleteStack directly instead of
 * shelling out to `cdk destroy` (what the local provisioner does) — a
 * Lambda has no CDK CLI, no project checkout, and DeleteStack is all
 * `cdk destroy` does under the hood anyway. Passing RoleARN lets
 * CloudFormation assume the CDK bootstrap's execution role to perform the
 * actual resource deletion, so this function's own IAM role only needs
 * `cloudformation:DeleteStack` + `iam:PassRole` on that one role — not
 * broad delete permissions on EC2/RDS/ECS/etc itself.
 */

const cfn = new CloudFormationClient({});
const EXECUTION_ROLE_ARN = process.env.CDK_EXECUTION_ROLE_ARN;

export const handler = async (): Promise<{ reaped: string[]; failed: string[] }> => {
  if (!EXECUTION_ROLE_ARN) {
    throw new Error("CDK_EXECUTION_ROLE_ARN env var is not set");
  }

  const expired = await registry.listExpiredHealthyEnvironments();
  const reaped: string[] = [];
  const failed: string[] = [];

  for (const env of expired) {
    const stackName = stackNameFor(env);
    try {
      await cfn.send(
        new DeleteStackCommand({ StackName: stackName, RoleARN: EXECUTION_ROLE_ARN }),
      );
      await registry.updateEnvironmentStatus(env.environmentId, "destroyed", {
        destroyedBy: "ttl",
      });
      reaped.push(env.environmentId);
      console.log(`Reaped expired environment ${env.environmentId} (stack ${stackName})`);
    } catch (error) {
      failed.push(env.environmentId);
      console.error(`Failed to reap ${env.environmentId} (stack ${stackName}):`, error);
    }
  }

  return { reaped, failed };
};
